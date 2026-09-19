'use strict';
/* AntiRaid (Rose-style): join bursts trip a temporary lockdown.
 * Normal: joins flow to captcha. Burst (> limit joins in window):
 * raid mode ON for duration — new members auto kick/banned on arrival,
 * announced in group + log channel, then silent auto-off.
 * /antiraid on|off|status • /setraidlimit 2-20 • /setraidmode kick|ban
 * • /setraidduration 30m. Must register BEFORE captcha so raids skip it. */
const store = require('../lib/store');
const { record } = require('../lib/modlog');

const joins = new Map(); // chatId -> [ts]

function defs() {
  return { warnLimit: 3, allowLinks: false };
}

function adminIds() {
  return new Set((process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
}

async function isAdmin(ctx) {
  if (ctx.from && adminIds().has(ctx.from.id)) return true;
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

function parseDur(s, min = 60, max = 86400) {
  const m = /^(\d+)([smhd])$/.exec(String(s || '').trim().toLowerCase());
  if (!m) return null;
  const sec = { s: +m[1], m: +m[1] * 60, h: +m[1] * 3600, d: +m[1] * 86400 }[m[2]];
  if (!sec || sec < min || sec > max) return null;
  return sec;
}

function fmtDur(sec) {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

async function enforce(bot, chatId, userId, mode, chatTitle) {
  if (mode === 'ban') await bot.api.banChatMember(chatId, userId);
  else { await bot.api.banChatMember(chatId, userId); await bot.api.unbanChatMember(chatId, userId); }
  await record(bot, { chatId, userId, action: `RAID_${mode.toUpperCase()}`, reason: 'raid mode', chatTitle });
}

function register(bot) {
  bot.on('message:new_chat_members', async (ctx, next) => {
    try {
      if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return next();
      const cfg = store.getChat(ctx.chat.id, defs());
      if (!Number(cfg.antiraid_enabled ?? 0)) return next();

      const now = Date.now();
      const limit = Math.max(2, Math.min(20, Number(cfg.antiraid_limit) || 5));
      const windowMs = Math.max(10, Number(cfg.antiraid_window) || 60) * 1000;
      const mode = cfg.antiraid_mode === 'ban' ? 'ban' : 'kick';
      const durationMs = (Number(cfg.antiraid_duration) || 3600) * 1000;

      // Raid mode active: bounce everyone at the door.
      if (Number(cfg.antiraid_until) > now) {
        for (const u of ctx.msg.new_chat_members || []) {
          if (u.is_bot) continue;
          try { await enforce(bot, ctx.chat.id, u.id, mode, ctx.chat.title); } catch (e) { console.warn('raid enforce:', e.message); }
        }
        try { await ctx.deleteMessage(); } catch {}
        return; // skip captcha entirely
      }

      // Expired lockdown: clear silently (logged), resume normal flow.
      if (Number(cfg.antiraid_until) > 0) {
        store.saveChat(ctx.chat.id, { antiraid_until: 0 }, defs());
        await record(bot, { chatId: ctx.chat.id, userId: 0, action: 'RAID_OFF', reason: 'lockdown expired', chatTitle: ctx.chat.title });
      }

      const humaines = (ctx.msg.new_chat_members || []).filter((u) => !u.is_bot);
      if (!humaines.length) return next();
      const bucket = (joins.get(ctx.chat.id) || []).filter((t) => now - t < windowMs);
      humaines.forEach(() => bucket.push(now));
      joins.set(ctx.chat.id, bucket);

      if (bucket.length > limit) {
        store.saveChat(ctx.chat.id, { antiraid_until: now + durationMs }, defs());
        for (const u of humaines) {
          try { await enforce(bot, ctx.chat.id, u.id, mode, ctx.chat.title); } catch (e) { console.warn('raid trip enforce:', e.message); }
        }
        try { await ctx.deleteMessage(); } catch {}
        await record(bot, { chatId: ctx.chat.id, userId: 0, action: 'RAID_ON', reason: `${bucket.length} joins/${Math.round(windowMs / 1000)}s → ${mode} for ${fmtDur(durationMs / 1000)}`, chatTitle: ctx.chat.title });
        await ctx.api.sendMessage(
          ctx.chat.id,
          `🛡 <b>Raid lockdown ON</b> — ${bucket.length} joins in ${Math.round(windowMs / 1000)}s.\nNew members auto-${mode === 'ban' ? 'banned' : 'kicked'} for ${fmtDur(durationMs / 1000)}.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      return next();
    } catch (err) {
      console.error('antiraid error:', err);
    }
  });

  const guard = (fn) => async (ctx) => {
    if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return ctx.reply('Use this in the group.');
    if (!(await isAdmin(ctx))) return ctx.reply('Only admins can use this.');
    return fn(ctx);
  };

  bot.command('antiraid', guard(async (ctx) => {
    const raw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    const cfg = store.getChat(ctx.chat.id, defs());
    if (!raw || raw === 'status') {
      const on = Number(cfg.antiraid_until) > Date.now();
      return ctx.reply(
        `🛡 AntiRaid: <b>${Number(cfg.antiraid_enabled ?? 0) ? 'ARMED' : 'OFF'}</b>\n` +
        `Limit: ${cfg.antiraid_limit ?? 5} joins / ${cfg.antiraid_window ?? 60}s → ${(cfg.antiraid_mode || 'kick').toUpperCase()} for ${fmtDur(Number(cfg.antiraid_duration) || 3600)}\n` +
        `Lockdown: <b>${on ? 'ACTIVE' : 'none'}</b>\nUsage: /antiraid on|off`,
        { parse_mode: 'HTML' }
      );
    }
    if (!['on', 'off'].includes(raw)) return ctx.reply('Usage: /antiraid on|off|status');
    store.saveChat(ctx.chat.id, { antiraid_enabled: raw === 'on' ? 1 : 0, antiraid_until: 0 }, defs());
    await record(bot, { chatId: ctx.chat.id, userId: 0, action: `RAID_${raw === 'on' ? 'ARMED' : 'DISARMED'}`, byUser: ctx.from.id, chatTitle: ctx.chat.title });
    return ctx.reply(`🛡 AntiRaid ${raw === 'on' ? 'ARMED' : 'OFF'}.`);
  }));

  bot.command('setraidlimit', guard(async (ctx) => {
    const n = Number((((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim()));
    if (!Number.isInteger(n) || n < 2 || n > 20) return ctx.reply('Usage: /setraidlimit 2-20 (joins per window). Window: 60s fixed.');
    store.saveChat(ctx.chat.id, { antiraid_limit: n }, defs());
    return ctx.reply(`🛡 Raid limit: ${n} joins / 60s.`);
  }));

  bot.command('setraidmode', guard(async (ctx) => {
    const raw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (!['kick', 'ban'].includes(raw)) return ctx.reply('Usage: /setraidmode kick|ban');
    store.saveChat(ctx.chat.id, { antiraid_mode: raw }, defs());
    return ctx.reply(`🛡 Raid action: ${raw.toUpperCase()}.`);
  }));

  bot.command('setraidduration', guard(async (ctx) => {
    const raw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    const sec = parseDur(raw);
    if (!sec) return ctx.reply('Usage: /setraidduration 30m (1m–24h).');
    store.saveChat(ctx.chat.id, { antiraid_duration: sec }, defs());
    return ctx.reply(`🛡 Lockdown duration: ${fmtDur(sec)}.`);
  }));
}

module.exports = { register };
