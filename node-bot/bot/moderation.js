'use strict';
/* Auto-moderation: delete spam, warn -> mute -> kick -> ban. */
const antispam = require('../lib/antispam');
const store = require('../lib/store');
const { parseCsv } = require('../lib/lists');
const { record } = require('../lib/modlog');

function env() {
  const csv = (v) => new Set((v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return {
    warnLimit: parseInt(process.env.WARN_LIMIT || '3', 10),
    floodLimit: parseInt(process.env.FLOOD_LIMIT || '5', 10),
    floodWindow: parseInt(process.env.FLOOD_WINDOW_SEC || '10', 10),
    allowLinks: (process.env.ALLOW_LINKS || 'false') === 'true',
    whitelist: csv(process.env.WHITELIST_DOMAINS),
    blacklist: csv(process.env.BLACKLIST_WORDS),
  };
}

function adminIds() {
  return new Set((process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
}

const URL_RE_PUBLIC = /(https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+)/gi;
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

/* Public replies must never re-publish the removed URL/domain.
 * Full reason stays in DB + admin log channel via record(). */
function publicReason(reason) {
  return (reason || '')
    .replace(URL_RE_PUBLIC, '[link removed]')
    .replace(BARE_DOMAIN_RE, '[link removed]')
    .replace(/\s*:\s*\[link removed\]/, '')
    .trim()
    .replace(/[:\s,;]+$/, '')
    .trim() || 'rule violation';
}

async function isAdmin(ctx) {
  if (ctx.from && adminIds().has(ctx.from.id)) return true; // bot admin bypass
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === 'administrator' || m.status === 'creator'; // group owner + admins bypass
  } catch {
    return false;
  }
}

function register(bot) {
  // 'message' (not just text): also catches photo/video/file captions holding URLs.
  bot.on('message', async (ctx, next) => {
    try {
      const chatType = ctx.chat?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') return next();
      if (!ctx.from || ctx.from.is_bot) return;
      if (await isAdmin(ctx)) return next();

      const e = env();
      const text = ctx.msg.text || ctx.msg.caption || '';
      const entities = [...(ctx.msg.entities || []), ...(ctx.msg.caption_entities || [])];
      const hasUrl = entities.some((x) => x.type === 'url' || x.type === 'text_link');
      const isFwd = Boolean(ctx.msg.forward_date || ctx.msg.forward_from_chat || ctx.msg.forward_origin);

      const chatCfg = store.getChat(ctx.chat.id, { warnLimit: e.warnLimit, allowLinks: e.allowLinks });
      // Per-group lists (set in-bot) merge with env-level lists.
      // flood_limit: null = env default, 0 = off, n = custom.
      const floodLimit = chatCfg.flood_limit === 0 ? Number.MAX_SAFE_INTEGER : (chatCfg.flood_limit ?? e.floodLimit);
      const floodMode = ['mute', 'kick', 'ban'].includes(chatCfg.flood_mode) ? chatCfg.flood_mode : 'warn';
      const verdict = antispam.check({
        chatId: ctx.chat.id, userId: ctx.from.id, text,
        hasUrlEntity: hasUrl, isForward: isFwd,
        allowLinks: Boolean(chatCfg.allow_links) || e.allowLinks,
        whitelist: new Set([...e.whitelist, ...parseCsv(chatCfg.whitelist_domains)]),
        blacklist: new Set([...e.blacklist, ...parseCsv(chatCfg.blacklist_words)]),
        floodLimit, floodWindow: e.floodWindow,
      });
      if (!verdict.isSpam) return next();

      const reason = verdict.reasons.join('; ');
      const pub = publicReason(reason); // never re-publish the removed URL
      const mention = `<a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>`;
      try { await ctx.deleteMessage(); } catch (err) { console.warn('delete failed:', err.message); }

      // Flood with a direct mode skips warn escalation (Rose-style).
      if (verdict.reasons.includes('flooding') && floodMode !== 'warn') {
        try {
          if (floodMode === 'ban') {
            await ctx.banChatMember(ctx.from.id);
          } else if (floodMode === 'kick') {
            await ctx.banChatMember(ctx.from.id);
            await ctx.unbanChatMember(ctx.from.id);
          } else {
            await ctx.restrictChatMember(ctx.from.id, { can_send_messages: false }, { until_date: Math.floor(Date.now() / 1000) + 3600 });
          }
          await record(bot, { chatId: ctx.chat.id, userId: ctx.from.id, action: `FLOOD_${floodMode.toUpperCase()}`, reason, chatTitle: ctx.chat.title });
          await ctx.reply(`🌊 ${mention}: flood → ${floodMode}`, { parse_mode: 'HTML' });
        } catch (err) { console.warn('flood action failed:', err.message); }
        return;
      }

      const count = store.addWarning(ctx.chat.id, ctx.from.id);
      const limit = parseInt(chatCfg.warn_limit || e.warnLimit, 10);

      if (count >= limit * 2) {
        try {
          await ctx.banChatMember(ctx.from.id);
          await record(bot, { chatId: ctx.chat.id, userId: ctx.from.id, action: 'BAN', reason: `${reason} (${count} warns)`, chatTitle: ctx.chat.title });
          await ctx.reply(`⛔️ ${mention}: BANNED — ${pub}`, { parse_mode: 'HTML' });
        } catch (err) { console.warn('ban failed:', err.message); }
        store.resetWarnings(ctx.chat.id, ctx.from.id);
      } else if (count >= limit + 1) {
        try {
          await ctx.banChatMember(ctx.from.id);
          await ctx.unbanChatMember(ctx.from.id);
          await record(bot, { chatId: ctx.chat.id, userId: ctx.from.id, action: 'KICK', reason: `${reason} (${count} warns)`, chatTitle: ctx.chat.title });
          await ctx.reply(`👢 ${mention}: KICKED — ${pub}`, { parse_mode: 'HTML' });
        } catch (err) { console.warn('kick failed:', err.message); }
        store.resetWarnings(ctx.chat.id, ctx.from.id);
      } else if (count >= limit) {
        try {
          await ctx.restrictChatMember(ctx.from.id, { can_send_messages: false }, { until_date: Math.floor(Date.now() / 1000) + 3600 });
          await record(bot, { chatId: ctx.chat.id, userId: ctx.from.id, action: `MUTE 1h (${count} warns)`, reason, chatTitle: ctx.chat.title });
          await ctx.reply(`🔇 ${mention} muted 1h (${count}/${limit})`, { parse_mode: 'HTML' });
        } catch (err) { console.warn('mute failed:', err.message); }
        store.resetWarnings(ctx.chat.id, ctx.from.id);
      } else {
        await record(bot, { chatId: ctx.chat.id, userId: ctx.from.id, action: `WARN ${count}/${limit}`, reason, chatTitle: ctx.chat.title });
        await ctx.reply(`⚠️ ${mention} warned (${count}/${limit}): ${pub}`, { parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('moderation error:', err);
    }
  });
}

module.exports = { register };
