'use strict';
/* Recurring scheduled posts, with media + guided wizard.
 * Quick:  /schedule 6h text | (reply to media) /schedule 12h [caption]
 *          /schedules | /unschedule <id>
 * Wizard (button ➕ New guided, works in group or DM connection):
 *   1. reply with the content (text or photo/video/file)
 *   2. reply with frequency (6h)  3. pick start date (calendar)
 *   4. reply with time (18:00, group time)  5. Save → first run rolls
 *      forward by interval if the slot already passed.
 * Times are interpreted in the group's timezone: /settz +5:30 (default IST).
 * Reposts use copyMessage; schedules persist and resume after restarts. */
const { InlineKeyboard } = require('grammy');
const store = require('../lib/store');
const { captureContent } = require('./notes');
const { sendContent } = require('../lib/render');

const MIN_SEC = 60;
const MAX_SEC = 30 * 86400;

const wiz = new Map(); // "chat:user" -> { chat, step, content, srcChat, every, date, promptId, at }
const WIZ_TTL = 5 * 60 * 1000;

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

function tzOffset(chatId) {
  const cfg = store.getChat(chatId, defs());
  if (typeof cfg.tz_offset === 'number') return cfg.tz_offset;
  return parseInt(process.env.DEFAULT_TZ_MIN || '330', 10);
}

function fmtTz(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function parseTz(s) {
  const m = /^([+-]?)(\d{1,2})(?::?(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const min = Number(m[2]) * 60 + Number(m[3] || 0);
  const signed = m[1] === '-' ? -min : min;
  if (signed < -720 || signed > 840) return null;
  return signed;
}

/* Local Y/M/D in chat TZ from a UTC epoch. */
function tzParts(epoch, tz) {
  const d = new Date(epoch + tz * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function fmtLocal(epoch, tz) {
  const d = new Date(epoch + tz * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function monthShift(y, m, delta) {
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

/* Inline calendar. minDay = UTC epoch of earliest selectable midnight. */
function calendarKb(y, m, minDay, maxMonthKey) {
  const kb = new InlineKeyboard();
  kb.text('◀️', `sch:m:${y}${String(m).padStart(2, '0')}-1`).text(`${y}-${String(m).padStart(2, '0')}`, 'sch:x').text('▶️', `sch:m:${y}${String(m).padStart(2, '0')}+1`).row();
  for (const wd of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) kb.text(wd, 'sch:x');
  kb.row();
  const first = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday-first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let cell = 0;
  for (let i = 0; i < first; i++) { kb.text('·', 'sch:x'); cell++; }
  const key = (yy, mm) => yy * 12 + mm;
  for (let d = 1; d <= days; d++) {
    const dayEpoch = Date.UTC(y, m - 1, d);
    const tag = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
    kb.text(dayEpoch < minDay ? '·' : String(d), dayEpoch < minDay ? 'sch:x' : `sch:d:${tag}`);
    if (++cell % 7 === 0) kb.row();
  }
  void maxMonthKey;
  kb.text('❌ Cancel', 'sch:cancel');
  return kb;
}

async function isAdmin(ctx, adminIds) {
  if (ctx.from && adminIds.has(ctx.from.id)) return true;
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

/* Resolve target group: current group, or DM connection. */
function targetChat(ctx) {
  if (ctx.chat?.type === 'private') return store.getConnection(ctx.from.id);
  return ctx.chat?.id;
}

async function fire(api, chatId, s) {
  if (s.replace && s.lastMsg) {
    try { await api.deleteMessage(chatId, s.lastMsg); } catch {} // only this schedule's own previous post
  }
  if (s.fileId) {
    // Wizard schedules: media by file_id survives source deletion.
    return sendContent(api, chatId, { kind: s.kind || 'photo', fileId: s.fileId, text: s.text || s.caption || '' }, {}, '');
  }
  const from = s.srcChat || chatId;
  if (s.srcMsg) {
    const extra = s.caption ? { caption: s.caption } : {};
    return api.copyMessage(chatId, from, s.srcMsg, extra);
  }
  return api.sendMessage(chatId, s.text);
}

function describe(s) {
  const rep = s.replace ? ' 🔁' : '';
  if (s.fileId) return `${s.kind || 'media'}${s.text ? ' + caption' : ''}${rep}`;
  if (s.srcMsg) return `media${s.caption ? ' (custom caption)' : ''}${rep}`;
  return `${(s.text || '').slice(0, 40)}${rep}`;
}

function reviewText(entry) {
  const s = { every: entry.every, next: entry.next, kind: entry.kind, fileId: entry.fileId, text: entry.text, replace: entry.replace ? 1 : 0 };
  const tz = tzOffset(entry.chat);
  return `📝 <b>Review</b>\n${describe(s)}\nEvery <b>${fmtDur(entry.every)}</b>, first run <b>${fmtLocal(entry.next, tz)}</b> (group time).\n` +
    `Previous post on repost: <b>${entry.replace ? 'DELETE' : 'keep'}</b>\nSave?`;
}

function reviewKb(entry) {
  const { InlineKeyboard } = require('grammy');
  return new InlineKeyboard()
    .text('✅ Save', 'sch:save').text('❌ Cancel', 'sch:cancel').row()
    .text(entry.replace ? '🔁 Deleting previous ✓' : '🔁 Delete previous?', `sch:rep:${entry.replace ? '0' : '1'}`);
}

async function promptStep(ctx, entry, text, kb) {
  const p = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  entry.promptId = p.message_id;
  entry.at = Date.now();
}

function register(bot) {
  const adminIds = new Set(
    (process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number)
  );
  const guard = (fn) => async (ctx) => {
    const chatId = targetChat(ctx);
    if (!chatId) return ctx.reply('Connect a group first: /start → My Groups.');
    if (!(await isAdmin(ctx, adminIds)) && ctx.chat?.type !== 'private') return ctx.reply('Only admins can use this.');
    if (ctx.chat?.type === 'private' && !(await (async () => {
      try {
        const m = await bot.api.getChatMember(chatId, ctx.from.id);
        return m.status === 'administrator' || m.status === 'creator' || adminIds.has(ctx.from.id);
      } catch { return false; }
    })())) return ctx.reply('You are not admin there (anymore).');
    return fn(ctx, chatId);
  };

  bot.command('schedule', guard(async (ctx, chatId) => {
    const parts = (ctx.msg.text || '').split(/ (.+)/);
    const args = (parts[1] || '').trim().split(/\s+/);
    const every = parseEvery(args[0]);
    if (!every) {
      return ctx.reply('Usage: /schedule 6h text — or reply to a photo/video/file with /schedule 12h [new caption]. Units s/m/h/d, min 1m. Or tap ➕ New guided in /menu → Schedules.');
    }
    const text = args.slice(1).join(' ').slice(0, 1000);
    const replied = ctx.msg.reply_to_message;
    let s;
    if (replied) {
      s = {
        id: Date.now().toString(36),
        every,
        next: Date.now() + every * 1000,
        srcChat: ctx.chat.id, srcMsg: replied.message_id,
        caption: text || undefined,
        text: undefined,
      };
    } else {
      if (!text) return ctx.reply('Give me the text to repeat, or reply to a media message: /schedule 6h Hello everyone!');
      s = { id: Date.now().toString(36), every, next: Date.now() + every * 1000, text };
    }
    const cfg = store.getChat(chatId, defs());
    if (cfg.schedules.length >= 20) return ctx.reply('Max 20 schedules per group — /unschedule one first.');
    store.setSchedules(chatId, [...cfg.schedules, s], defs());
    const what = s.srcMsg ? `media msg #${s.srcMsg}${s.caption ? ' (new caption)' : ''}` : 'text post';
    return ctx.reply(`⏰ Scheduled <code>${s.id}</code>: ${what} every ${fmtDur(every)}.`, { parse_mode: 'HTML' });
  }));

  bot.command('schedules', guard(async (ctx, chatId) => {
    const cfg = store.getChat(chatId, defs());
    if (!cfg.schedules.length) return ctx.reply('No schedules. Tap ➕ New guided in /menu → Schedules.');
    const lines = cfg.schedules.map((s) => {
      const what = s.fileId ? `${s.kind || 'media'}` : s.srcMsg ? `media #${s.srcMsg}` : (s.text || '').slice(0, 40);
      return `<code>${s.id}</code> every ${fmtDur(s.every)} — ${what}`;
    });
    return ctx.reply(`⏰ <b>Schedules</b> (group time UTC${fmtTz(tzOffset(chatId))})\n` + lines.join('\n'), { parse_mode: 'HTML' });
  }));

  bot.command('unschedule', guard(async (ctx, chatId) => {
    const id = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    if (!id) return ctx.reply('Usage: /unschedule <id> (see /schedules)');
    const cfg = store.getChat(chatId, defs());
    const left = cfg.schedules.filter((s) => s.id !== id);
    if (left.length === cfg.schedules.length) return ctx.reply('No schedule with that id.');
    store.setSchedules(chatId, left, defs());
    return ctx.reply(`🗑 Schedule <code>${id}</code> removed.`, { parse_mode: 'HTML' });
  }));

  bot.command('settz', guard(async (ctx, chatId) => {
    const raw = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    const min = parseTz(raw);
    if (min === null) return ctx.reply('Usage: /settz +5:30 (group timezone, -12:00…+14:00).');
    store.saveChat(chatId, { tz_offset: min }, defs());
    return ctx.reply(`🕰 Group time: UTC${fmtTz(min)}.`);
  }));

  // ---------- Wizard ----------
  async function wizStart(ctx, chatId) {
    const entry = { chat: chatId, step: 'content', at: Date.now(), promptId: 0 };
    wiz.set(`${ctx.chat.id}:${ctx.from.id}`, entry);
    await promptStep(ctx, entry, '📩 <b>Step 1/4 — content.</b> Reply to <b>this message</b> with the text or photo/video/file to repeat.', undefined);
  }

  bot.callbackQuery(/^sch:/, async (ctx) => {
    try {
      const data = ctx.callbackQuery.data || '';
      const answer = (t) => ctx.answerCallbackQuery({ text: t }).catch(() => {});
      const k = `${ctx.chat.id}:${ctx.from.id}`;
      const entry = wiz.get(k);

      if (data === 'sch:new') {
        const chatId = targetChat(ctx);
        if (!chatId) { await ctx.answerCallbackQuery({ text: 'Connect a group first.', show_alert: true }); return; }
        const allowed = ctx.chat?.type === 'private'
          ? await (async () => {
              try {
                const m = await bot.api.getChatMember(chatId, ctx.from.id);
                return m.status === 'administrator' || m.status === 'creator' || adminIds.has(ctx.from.id);
              } catch { return false; }
            })()
          : await isAdmin(ctx, adminIds);
        if (!allowed) { await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }); return; }
        await wizStart(ctx, chatId);
        await answer('Reply to the prompt');
        return;
      }
      if (data === 'sch:cancel' || data === 'sch:x') {
        if (data === 'sch:cancel') {
          wiz.delete(k);
          try { await ctx.editMessageText('🚫 Schedule wizard cancelled.'); } catch {}
          await answer('Cancelled');
        } else await answer(' ');
        return;
      }
      if (!entry || Date.now() - entry.at > WIZ_TTL) {
        wiz.delete(k);
        await answer('Wizard expired — start again.');
        return;
      }
      entry.at = Date.now();

      if (data.startsWith('sch:m:')) {
        // month nav: sch:m:YYYYMM±1
        const m = /^sch:m:(\d{4})(\d{2})([+-]1)$/.exec(data);
        if (!m) { await answer(' '); return; }
        const tz = tzOffset(entry.chat);
        const cur = tzParts(Date.now(), tz);
        const curKey = cur.y * 12 + cur.m;
        let { y, m: mo } = monthShift(Number(m[1]), Number(m[2]), m[3] === '+1' ? 1 : -1);
        const shown = y * 12 + mo;
        if (shown < curKey || shown > curKey + 6) { await answer(shown < curKey ? 'No past months' : 'Max 6 months ahead'); return; }
        const minDay = Date.UTC(cur.y, cur.m - 1, cur.d);
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: calendarKb(y, mo, minDay) });
        } catch {}
        await answer(' ');
        return;
      }

      if (data.startsWith('sch:d:')) {
        const m = /^sch:d:(\d{4})(\d{2})(\d{2})$/.exec(data);
        if (!m) { await answer(' '); return; }
        entry.date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
        entry.step = 'time';
        await promptStep(ctx, entry, `🕰 <b>Step 4/4 — time.</b> Reply with the start time, 24h <code>HH:MM</code> (group time UTC${fmtTz(tzOffset(entry.chat))}).`, undefined);
        try { await ctx.deleteMessage(); } catch {}
        await answer(' ');
        return;
      }

      if (data.startsWith('sch:rep:')) {
        if (!entry || entry.step !== 'review') { await answer(' '); return; }
        entry.replace = data === 'sch:rep:1' ? 1 : 0;
        entry.at = Date.now();
        try { await ctx.editMessageText(reviewText(entry), { parse_mode: 'HTML', reply_markup: reviewKb(entry) }); } catch {}
        await answer(entry.replace ? 'Previous post will be deleted' : 'Previous post will stay');
        return;
      }

      if (data === 'sch:save') {
        const cfg = store.getChat(entry.chat, defs());
        if (cfg.schedules.length >= 20) { await answer('Max 20 schedules — remove one first.', true); return; }
        const s = { id: Date.now().toString(36), every: entry.every, next: entry.next, kind: entry.kind, fileId: entry.fileId, text: entry.text, replace: entry.replace ? 1 : 0 };
        store.setSchedules(entry.chat, [...cfg.schedules, s], defs());
        wiz.delete(k);
        try { await ctx.editMessageText(`✅ Scheduled <code>${s.id}</code>: ${describe(s)} every ${fmtDur(s.every)} from ${fmtLocal(s.next, tzOffset(entry.chat))}.`, { parse_mode: 'HTML' }); } catch {}
        await answer('Saved');
        return;
      }
      await answer(' ');
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });

  // Wizard text/media consumer (admins bypass spam filters, so no clash).
  bot.on('message', async (ctx, next) => {
    try {
      if (!ctx.from || ctx.from.is_bot) return next();
      const k = `${ctx.chat.id}:${ctx.from.id}`;
      const entry = wiz.get(k);
      if (!entry) return next();
      if (Date.now() - entry.at > WIZ_TTL) { wiz.delete(k); return next(); }
      if ((ctx.msg.text || '').startsWith('/')) return next();
      if (!ctx.msg.reply_to_message || ctx.msg.reply_to_message.message_id !== entry.promptId) return next();
      entry.at = Date.now();

      if (entry.step === 'content') {
        const c = captureContent(ctx.msg);
        if (!c || (!c.text && !c.fileId)) {
          await ctx.reply('That has no text or media — reply with the message to repeat.');
          return;
        }
        entry.content = c;
        if (c.fileId) { entry.kind = c.kind; entry.fileId = c.fileId; entry.text = (c.text || '').slice(0, 1000) || undefined; }
        else { entry.kind = 'text'; entry.fileId = undefined; entry.text = (c.text || '').slice(0, 1000); }
        entry.step = 'freq';
        await promptStep(ctx, entry, '⏱ <b>Step 2/4 — frequency.</b> Reply with the interval, e.g. <code>6h</code> (s/m/h/d, min 1m).', undefined);
        try { await ctx.deleteMessage(); } catch {}
        return;
      }

      if (entry.step === 'freq') {
        const every = parseEvery(ctx.msg.text || '');
        if (!every) {
          await ctx.reply('Use a valid interval like <code>30m</code>, <code>6h</code>, <code>1d</code>.', { parse_mode: 'HTML' });
          return;
        }
        entry.every = every;
        entry.step = 'date';
        const tz = tzOffset(entry.chat);
        const cur = tzParts(Date.now(), tz);
        const minDay = Date.UTC(cur.y, cur.m - 1, cur.d);
        const p = await ctx.reply(`📅 <b>Step 3/4 — start date</b> (group time UTC${fmtTz(tz)}). Every ${fmtDur(every)}.`, { reply_markup: calendarKb(cur.y, cur.m, minDay) });
        entry.promptId = p.message_id;
        return;
      }

      if (entry.step === 'time') {
        const m = /^(\d{1,2}):(\d{2})$/.exec((ctx.msg.text || '').trim());
        const H = m ? Number(m[1]) : -1;
        const Mi = m ? Number(m[2]) : -1;
        if (!m || H > 23 || Mi > 59) {
          await ctx.reply('Use 24h format: <code>18:00</code>.', { parse_mode: 'HTML' });
          return;
        }
        const tz = tzOffset(entry.chat);
        let nextTime = Date.UTC(entry.date.y, entry.date.m - 1, entry.date.d, H, Mi) - tz * 60000;
        const now = Date.now();
        while (nextTime <= now) nextTime += entry.every * 1000; // roll forward to a future slot
        entry.next = nextTime;
        entry.step = 'review';
        entry.replace = 0;
        await promptStep(ctx, entry, reviewText(entry), reviewKb(entry));
        try { await ctx.deleteMessage(); } catch {}
        return;
      }
      return next();
    } catch (err) {
      console.error('schedule wizard error:', err);
    }
  });

  // Ticks every 30s; due schedules fire and roll forward (no catch-up storms).
  // Replace-mode schedules remember their last post to delete it next time.
  async function doFire(chatId, s) {
    try {
      const m = await fire(bot.api, chatId, s);
      const cfg = store.getChat(chatId, defs());
      store.setSchedules(chatId, cfg.schedules.map((x) =>
        x.id === s.id ? { ...x, next: Date.now() + x.every * 1000, lastMsg: m?.message_id } : x
      ), defs());
    } catch (e) { console.warn('schedule fire failed:', e.message); }
  }

  setInterval(async () => {
    try {
      const now = Date.now();
      for (const { chatId, schedules } of store.chatsWithSchedules()) {
        for (const s of schedules) {
          if (s.next <= now) await doFire(chatId, s); // sequential: no lost updates
        }
      }
    } catch (e) { console.warn('scheduler tick:', e.message); }
  }, 30 * 1000).unref?.();
}

module.exports = { register, parseEvery, fmtDur };
