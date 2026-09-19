'use strict';
/* Recurring scheduled posts, with media.
 * Usage (admin, in group):
 *   /schedule 6h Remember to read the rules!      -> text every 6h
 *   (reply to a photo/video/file) /schedule 12h   -> reposts that media every 12h
 *   (reply to media) /schedule 1d New caption     -> same media, caption replaced
 *   /schedules                                     -> list
 *   /unschedule <id>                               -> cancel
 * Reposts use copyMessage, so media + buttons survive; schedules persist in
 * the JSON store and resume after restarts. Intervals: 1m min (e.g. 30s? no),
 * units s/m/h/d, e.g. /schedule 30m text. */
const store = require('../lib/store');

const MIN_SEC = 60;
const MAX_SEC = 30 * 86400;

function parseEvery(s) {
  const m = /^(\d+)([smhd])$/.exec(String(s || '').trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const sec = { s: n, m: n * 60, h: n * 3600, d: n * 86400 }[m[2]];
  if (!sec || sec < MIN_SEC || sec > MAX_SEC) return null;
  return sec;
}

function fmtDur(sec) {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function defs() {
  return { warnLimit: 3, allowLinks: false };
}

async function isAdmin(ctx, adminIds) {
  if (ctx.from && adminIds.has(ctx.from.id)) return true;
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

async function fire(api, chatId, s) {
  if (s.srcMsg) {
    const extra = s.caption ? { caption: s.caption } : {};
    await api.copyMessage(chatId, chatId, s.srcMsg, extra);
  } else {
    await api.sendMessage(chatId, s.text);
  }
}

function register(bot) {
  const adminIds = new Set(
    (process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number)
  );
  const guard = (fn) => async (ctx) => {
    if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return ctx.reply('Use this in the group.');
    if (!(await isAdmin(ctx, adminIds))) return ctx.reply('Only admins can use this.');
    return fn(ctx);
  };

  bot.command('schedule', guard(async (ctx) => {
    const parts = (ctx.msg.text || '').split(/ (.+)/);
    const args = (parts[1] || '').trim().split(/\s+/);
    const every = parseEvery(args[0]);
    if (!every) {
      return ctx.reply('Usage: /schedule 6h text — or reply to a photo/video/file with /schedule 12h [new caption]. Units s/m/h/d, min 1m.');
    }
    const text = args.slice(1).join(' ').slice(0, 1000);
    const replied = ctx.msg.reply_to_message;
    let s;
    if (replied) {
      s = {
        id: Date.now().toString(36),
        every,
        next: Date.now() + every * 1000,
        srcMsg: replied.message_id,
        caption: text || undefined,
        text: undefined,
      };
    } else {
      if (!text) return ctx.reply('Give me the text to repeat, or reply to a media message: /schedule 6h Hello everyone!');
      s = { id: Date.now().toString(36), every, next: Date.now() + every * 1000, text };
    }
    const cfg = store.getChat(ctx.chat.id, defs());
    if (cfg.schedules.length >= 20) return ctx.reply('Max 20 schedules per group — /unschedule one first.');
    store.setSchedules(ctx.chat.id, [...cfg.schedules, s], defs());
    const what = s.srcMsg ? `media msg #${s.srcMsg}${s.caption ? ' (new caption)' : ''}` : 'text post';
    return ctx.reply(`⏰ Scheduled <code>${s.id}</code>: ${what} every ${fmtDur(every)}.`, { parse_mode: 'HTML' });
  }));

  bot.command('schedules', guard(async (ctx) => {
    const cfg = store.getChat(ctx.chat.id, defs());
    if (!cfg.schedules.length) return ctx.reply('No schedules. See /help.');
    const lines = cfg.schedules.map((s) => {
      const what = s.srcMsg ? `media #${s.srcMsg}` : (s.text || '').slice(0, 40);
      return `<code>${s.id}</code> every ${fmtDur(s.every)} — ${what}`;
    });
    return ctx.reply('⏰ <b>Schedules</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  }));

  bot.command('unschedule', guard(async (ctx) => {
    const id = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    if (!id) return ctx.reply('Usage: /unschedule <id> (see /schedules)');
    const cfg = store.getChat(ctx.chat.id, defs());
    const left = cfg.schedules.filter((s) => s.id !== id);
    if (left.length === cfg.schedules.length) return ctx.reply('No schedule with that id.');
    store.setSchedules(ctx.chat.id, left, defs());
    return ctx.reply(`🗑 Schedule <code>${id}</code> removed.`, { parse_mode: 'HTML' });
  }));

  // Ticks every 30s; due schedules fire and roll forward (no catch-up storms).
  setInterval(async () => {
    try {
      const now = Date.now();
      for (const { chatId, schedules } of store.chatsWithSchedules()) {
        let changed = false;
        const next = schedules.map((s) => {
          if (s.next > now) return s;
          fire(bot.api, chatId, s).catch((e) => console.warn('schedule fire failed:', e.message));
          changed = true;
          return { ...s, next: now + s.every * 1000 };
        });
        if (changed) store.setSchedules(chatId, next, defs());
      }
    } catch (e) { console.warn('scheduler tick:', e.message); }
  }, 30 * 1000).unref?.();
}

module.exports = { register, parseEvery, fmtDur };
