'use strict';
/* Community protection: Reports + Rules + Flood control (Rose-style).
 * /report (reply): forwards to the admin log channel with action buttons.
 * /rules | /setrules | /clearrules — group rules, DM-first delivery.
 * /setflood <n|off> | /setfloodmode warn|mute|kick|ban | /flood — status. */
const { InlineKeyboard } = require('grammy');
const { grid } = require('../lib/kb');
const store = require('../lib/store');
const { record } = require('../lib/modlog');

const cooldown = new Map(); // "chat:user" -> ts (report spam guard)

function defs() {
  return { warnLimit: 3, allowLinks: false };
}

function adminIds() {
  return new Set((process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
}

async function isAdminIn(bot, chatId, userId) {
  if (adminIds().has(userId)) return true;
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

function inGroup(ctx) {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function msgLink(chatId, msgId) {
  const internal = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${internal}/${msgId}`;
}

function excerpt(msg) {
  if (!msg) return '(no message)';
  const text = msg.text || msg.caption || '';
  if (text) return text.slice(0, 300);
  if (msg.photo) return '[photo]';
  if (msg.video) return '[video]';
  if (msg.sticker) return `[sticker ${msg.sticker.emoji || ''}]`;
  if (msg.document) return '[file]';
  if (msg.voice) return '[voice]';
  return '[media]';
}

function register(bot) {
  // ---------- Reports ----------
  bot.command('report', async (ctx) => {
    try {
      if (!inGroup(ctx)) return;
      const cfg = store.getChat(ctx.chat.id, defs());
      if (!Number(cfg.reports_enabled ?? 1)) return ctx.reply('Reports are disabled in this group.');
      const target = ctx.msg.reply_to_message;
      if (!target || !target.from) return ctx.reply('Reply to the offending message with /report + optional reason.');
      if (target.from.id === ctx.from.id) return ctx.reply('You cannot report yourself.');
      if (target.from.is_bot && target.from.id === ctx.me.id) return ctx.reply('You cannot report me. 😇');

      const k = `${ctx.chat.id}:${ctx.from.id}`;
      const now = Date.now();
      if (now - (cooldown.get(k) || 0) < 60 * 1000) return ctx.reply('Slow down — one report per minute.');
      cooldown.set(k, now);

      const reason = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().slice(0, 300);
      const channel = (process.env.LOG_CHANNEL_ID || '').trim();
      const reporterMention = `<a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>`;
      const targetMention = `<a href="tg://user?id=${target.from.id}">${target.from.first_name}</a>`;
      const body =
        `🚨 <b>Report</b> in ${ctx.chat.title || ctx.chat.id}\n` +
        `From: ${reporterMention} (<code>${ctx.from.id}</code>)\n` +
        `Against: ${targetMention} (<code>${target.from.id}</code>)\n` +
        (reason ? `Reason: ${reason}\n` : '') +
        `Message: ${excerpt(target)}\n` +
        `<a href="${msgLink(ctx.chat.id, target.message_id)}">Jump to message</a>`;
      const kb = grid([
        { t: '🗑 Delete', d: `rep:del:${ctx.chat.id}:${target.message_id}` },
        { t: '🔇 Mute', d: `rep:mute:${ctx.chat.id}:${target.from.id}` },
        { t: '👢 Kick', d: `rep:kick:${ctx.chat.id}:${target.from.id}` },
        { t: '⛔️ Ban', d: `rep:ban:${ctx.chat.id}:${target.from.id}` },
        { t: '✅ Done', d: `rep:done:${ctx.chat.id}:0` },
      ], 2);

      let posted = false;
      if (channel) {
        try {
          await bot.api.sendMessage(channel, body, { parse_mode: 'HTML', reply_markup: kb });
          posted = true;
        } catch (e) { console.warn('report to channel failed:', e.message); }
      }
      if (!posted) {
        // No log channel: alert in-group, admins tagged via admin list is noisy —
        // post the report card in the group instead (admins act on buttons).
        await ctx.reply(body + '\n\n<i>No log channel set — admins, act here.</i>', { parse_mode: 'HTML', reply_markup: kb });
      }
      await record(bot, { chatId: ctx.chat.id, userId: target.from.id, action: 'REPORT', reason: reason || excerpt(target).slice(0, 120), byUser: ctx.from.id, chatTitle: ctx.chat.title });
      const ok = await ctx.reply('✅ Reported to the admins.');
      setTimeout(async () => { try { await ctx.api.deleteMessage(ctx.chat.id, ok.message_id); } catch {} }, 60 * 1000).unref?.();
    } catch (err) {
      console.error('report error:', err);
    }
  });

  bot.callbackQuery(/^rep:/, async (ctx) => {
    try {
      const [, act, chatS, idS] = (ctx.callbackQuery.data || '').split(':');
      const chatId = Number(chatS);
      const id = Number(idS);
      if (!(await isAdminIn(bot, chatId, ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
        return;
      }
      const tag = `\n\n<i>Handled by ${ctx.from.first_name}: ${act}</i>`;
      if (act === 'done') {
        try { await ctx.editMessageCaption?.((ctx.callbackQuery.message.caption || '') + tag, { parse_mode: 'HTML' }); } catch {}
        try { await ctx.editMessageText((ctx.callbackQuery.message.text || '') + tag, { parse_mode: 'HTML' }); } catch {}
        await ctx.answerCallbackQuery({ text: 'Marked done' });
        return;
      }
      try {
        if (act === 'del') await bot.api.deleteMessage(chatId, id);
        else if (act === 'mute') await bot.api.restrictChatMember(chatId, id, { can_send_messages: false }, { until_date: Math.floor(Date.now() / 1000) + 3600 });
        else if (act === 'kick') { await bot.api.banChatMember(chatId, id); await bot.api.unbanChatMember(chatId, id); }
        else if (act === 'ban') await bot.api.banChatMember(chatId, id);
        await record(bot, { chatId, userId: act === 'del' ? 0 : id, action: `REPORT_${act.toUpperCase()}`, byUser: ctx.from.id });
        try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
        await ctx.answerCallbackQuery({ text: `Done: ${act}` });
      } catch (e) {
        await ctx.answerCallbackQuery({ text: `Failed: ${String(e.message).slice(0, 150)}`, show_alert: true });
      }
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });

  const adminGuard = (fn) => async (ctx) => {
    if (!inGroup(ctx)) return ctx.reply('Use this in the group.');
    if (!(await isAdminIn(bot, ctx.chat.id, ctx.from.id))) return ctx.reply('Only admins can use this.');
    return fn(ctx);
  };

  bot.command('reports', adminGuard(async (ctx) => {
    const raw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (!raw) {
      const cfg = store.getChat(ctx.chat.id, defs());
      return ctx.reply(`🚨 Reports are <b>${Number(cfg.reports_enabled ?? 1) ? 'ON' : 'OFF'}</b>. Usage: /reports on|off`, { parse_mode: 'HTML' });
    }
    if (!['on', 'off'].includes(raw)) return ctx.reply('Usage: /reports on|off');
    store.saveChat(ctx.chat.id, { reports_enabled: raw === 'on' ? 1 : 0 }, defs());
    return ctx.reply(`🚨 Reports ${raw.toUpperCase()}.`);
  }));

  // ---------- Rules ----------
  bot.command('rules', async (ctx) => {
    if (!inGroup(ctx)) return;
    const cfg = store.getChat(ctx.chat.id, defs());
    const rules = (cfg.rules_text || '').trim();
    if (!rules) return ctx.reply('No rules set yet. Admins: /setrules ...');
    // DM-first (Rose-style); fall back to group if the user never started the bot.
    try {
      await ctx.api.sendMessage(ctx.from.id, `📜 <b>Rules — ${ctx.chat.title}</b>\n\n${rules}`, { parse_mode: 'HTML' });
      await ctx.reply('📜 I sent you the rules in private.');
    } catch {
      await ctx.reply(`📜 <b>Rules</b>\n\n${rules}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('setrules', adminGuard(async (ctx) => {
    const text = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().slice(0, 2000);
    if (!text) return ctx.reply('Usage: /setrules <rules text> (supports {variables} and [buttons](url))');
    store.saveChat(ctx.chat.id, { rules_text: text }, defs());
    return ctx.reply('📜 Rules updated. Members: /rules');
  }));

  bot.command('clearrules', adminGuard(async (ctx) => {
    store.saveChat(ctx.chat.id, { rules_text: '' }, defs());
    return ctx.reply('📜 Rules cleared.');
  }));

  // ---------- Flood ----------
  bot.command('setflood', adminGuard(async (ctx) => {
    const raw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (raw === 'off') {
      store.saveChat(ctx.chat.id, { flood_limit: 0 }, defs());
      return ctx.reply('🌊 Flood control OFF.');
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 2 || n > 30) return ctx.reply('Usage: /setflood <2-30|off> — messages per 10s window.');
    store.saveChat(ctx.chat.id, { flood_limit: n }, defs());
    return ctx.reply(`🌊 Flood limit: ${n} messages / 10s.`);
  }));

  bot.command('setfloodmode', adminGuard(async (ctx) => {
    const raw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (!['warn', 'mute', 'kick', 'ban'].includes(raw)) return ctx.reply('Usage: /setfloodmode warn|mute|kick|ban');
    store.saveChat(ctx.chat.id, { flood_mode: raw }, defs());
    return ctx.reply(`🌊 Flood action: ${raw.toUpperCase()}.`);
  }));

  bot.command('flood', async (ctx) => {
    if (!inGroup(ctx)) return;
    const cfg = store.getChat(ctx.chat.id, defs());
    const envN = parseInt(process.env.FLOOD_LIMIT || '5', 10);
    const lim = cfg.flood_limit === 0 ? 'OFF' : (cfg.flood_limit ?? `${envN} (default)`);
    return ctx.reply(`🌊 Flood: <b>${lim}</b> / 10s → <b>${(cfg.flood_mode || 'warn').toUpperCase()}</b>`, { parse_mode: 'HTML' });
  });
}

module.exports = { register };
