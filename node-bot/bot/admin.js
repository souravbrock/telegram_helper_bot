'use strict';
/* Admin commands + engagement + per-group configuration. */
const store = require('../lib/store');
const { parseCsv, normalizeDomain, setToCsv } = require('../lib/lists');
const { record } = require('../lib/modlog');

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

function targetOf(ctx) {
  if (ctx.msg?.reply_to_message?.from) return ctx.msg.reply_to_message.from.id;
  const m = (ctx.msg?.text || '').match(/\/\w+\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseDur(s) {
  const m = /^(\d+)([mhd])$/.exec((s || '').toLowerCase());
  if (!m) return { sec: 3600, label: '1h' };
  const n = Number(m[1]);
  const sec = m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
  return { sec, label: m[0] };
}

function register(bot) {
  // NOTE: /start lives in captcha.js (DM verification deep links). Keep 'help' here only.
  bot.command(['help'], (ctx) => ctx.reply(
    '🤖 <b>Group Assistant (Node MVP)</b>\n\n' +
    'Auto-moderation: spam links/forwards/flood deleted, warn→mute→kick→ban.\n' +
    'Captcha verification for new members.\n\n' +
    '<b>Admin</b>\n/warn (reply) • /unwarn • /warns\n/mute 10m (reply) • /unmute\n/kick • /ban • /unban user_id\n' +
    '/setwelcome text • /poll Q?; A; B • /stats\n\n' +
    '<b>Filters</b>\n/addbanword w1,w2 • /rmbanword w • /banwords\n' +
    '/addlink domain • /rmlink domain • /links • /allowlinks on|off\n\n' +
    '<b>Recurring posts</b>\n/schedule 6h text (or reply to media)\n/schedules • /unschedule id',
    { parse_mode: 'HTML' }
  ));

  const guard = (fn) => async (ctx) => {
    if (!(await isAdmin(ctx))) return ctx.reply('Only admins can use this.');
    return fn(ctx);
  };

  bot.command('warn', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Reply to a user: /warn');
    const c = store.addWarning(ctx.chat.id, t);
    await record(bot, { chatId: ctx.chat.id, userId: t, action: `WARN ${c}`, byUser: ctx.from.id, chatTitle: ctx.chat.title });
    return ctx.reply(`⚠️ User <code>${t}</code> warned (${c}).`, { parse_mode: 'HTML' });
  }));

  bot.command('unwarn', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Reply to a user: /unwarn');
    store.resetWarnings(ctx.chat.id, t);
    return ctx.reply(`✅ Warns cleared for <code>${t}</code>.`, { parse_mode: 'HTML' });
  }));

  bot.command('warns', async (ctx) => {
    const t = targetOf(ctx) || ctx.from.id;
    return ctx.reply(`User <code>${t}</code> has ${store.getWarnings(ctx.chat.id, t)} warn(s).`, { parse_mode: 'HTML' });
  });

  bot.command('mute', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Usage: /mute 10m (reply to user)');
    const m = (ctx.msg.text || '').match(/\/mute\s+(\d+[mhd])/);
    const { sec, label } = parseDur(m?.[1]);
    try {
      await ctx.restrictChatMember(t, { can_send_messages: false }, { until_date: Math.floor(Date.now() / 1000) + sec });
      await record(bot, { chatId: ctx.chat.id, userId: t, action: `MUTE ${label}`, byUser: ctx.from.id, chatTitle: ctx.chat.title });
      return ctx.reply(`🔇 Muted <code>${t}</code> for ${label}.`, { parse_mode: 'HTML' });
    } catch (e) { return ctx.reply(`Failed (am I admin?): ${e.message}`); }
  }));

  bot.command('unmute', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Reply to a user: /unmute');
    try {
      await ctx.restrictChatMember(t, { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true });
      return ctx.reply(`🔊 Unmuted <code>${t}</code>.`, { parse_mode: 'HTML' });
    } catch (e) { return ctx.reply(`Failed: ${e.message}`); }
  }));

  bot.command('kick', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Reply to a user: /kick');
    try {
      await ctx.banChatMember(t);
      await ctx.unbanChatMember(t);
      await record(bot, { chatId: ctx.chat.id, userId: t, action: 'KICK', byUser: ctx.from.id, chatTitle: ctx.chat.title });
      return ctx.reply(`👢 Kicked <code>${t}</code>.`, { parse_mode: 'HTML' });
    } catch (e) { return ctx.reply(`Failed: ${e.message}`); }
  }));

  bot.command('ban', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Reply to a user: /ban');
    try {
      await ctx.banChatMember(t);
      await record(bot, { chatId: ctx.chat.id, userId: t, action: 'BAN', byUser: ctx.from.id, chatTitle: ctx.chat.title });
      return ctx.reply(`⛔️ Banned <code>${t}</code>.`, { parse_mode: 'HTML' });
    } catch (e) { return ctx.reply(`Failed: ${e.message}`); }
  }));

  bot.command('unban', guard(async (ctx) => {
    const t = targetOf(ctx);
    if (!t) return ctx.reply('Usage: /unban <user_id>');
    try {
      await ctx.unbanChatMember(t);
      return ctx.reply(`✅ Unbanned <code>${t}</code>.`, { parse_mode: 'HTML' });
    } catch (e) { return ctx.reply(`Failed: ${e.message}`); }
  }));

  bot.command('setwelcome', guard(async (ctx) => {
    const parts = (ctx.msg.text || '').split(/ (.+)/);
    if (parts.length < 2 || !parts[1]) return ctx.reply('Usage: /setwelcome Your text ({mention}, {title}, {name})');
    store.saveChat(ctx.chat.id, { welcome_text: parts[1].slice(0, 1000) }, { warnLimit: 3, allowLinks: false });
    return ctx.reply('✅ Welcome message updated.');
  }));

  bot.command('poll', async (ctx) => {
    const body = (ctx.msg.text || '').split(/ (.+)/)[1];
    if (!body || !body.includes(';')) return ctx.reply('Usage: /poll Question?; Option 1; Option 2');
    const chunks = body.split(';').map((s) => s.trim()).filter(Boolean);
    if (chunks.length < 3) return ctx.reply('Need a question + at least 2 options.');
    try {
      await ctx.api.sendPoll(ctx.chat.id, chunks[0].slice(0, 300), chunks.slice(1, 11));
    } catch (e) { return ctx.reply(`Poll failed: ${e.message}`); }
  });

  bot.command('stats', async (ctx) => {
    const counts = store.actionCounts();
    const keys = Object.keys(counts);
    if (!keys.length) return ctx.reply('No moderation actions yet.');
    return ctx.reply('📊 <b>Moderation stats</b>\n' + keys.sort().map((k) => `${k}: ${counts[k]}`).join('\n'), { parse_mode: 'HTML' });
  });

  // ---- Per-group filter config (extensible: same CSV pattern for future items) ----
  const chatDefs = () => ({ warnLimit: 3, allowLinks: false });

  bot.command('addbanword', guard(async (ctx) => {
    const raw = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    if (!raw) return ctx.reply('Usage: /addbanword word1,word2 — messages containing these get deleted.');
    const cfg = store.getChat(ctx.chat.id, chatDefs());
    const set = parseCsv(cfg.blacklist_words);
    raw.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).forEach((w) => set.add(w));
    store.saveChat(ctx.chat.id, { blacklist_words: setToCsv(set).slice(0, 2000) }, chatDefs());
    return ctx.reply(`🚫 Ban words (${set.size}): ${setToCsv(set) || '—'}`);
  }));

  bot.command('rmbanword', guard(async (ctx) => {
    const raw = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase();
    if (!raw) return ctx.reply('Usage: /rmbanword word');
    const cfg = store.getChat(ctx.chat.id, chatDefs());
    const set = parseCsv(cfg.blacklist_words);
    set.delete(raw);
    store.saveChat(ctx.chat.id, { blacklist_words: setToCsv(set) }, chatDefs());
    return ctx.reply(`🚫 Ban words (${set.size}): ${setToCsv(set) || '—'}`);
  }));

  bot.command('banwords', async (ctx) => {
    const cfg = store.getChat(ctx.chat.id, chatDefs());
    const list = setToCsv(parseCsv(cfg.blacklist_words));
    return ctx.reply(`🚫 Ban words: ${list || '(none — use /addbanword)'}`);
  });

  bot.command('addlink', guard(async (ctx) => {
    const raw = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    const dom = normalizeDomain(raw);
    if (!dom) return ctx.reply('Usage: /addlink example.com — whitelists this domain for links.');
    const cfg = store.getChat(ctx.chat.id, chatDefs());
    const set = parseCsv(cfg.whitelist_domains);
    set.add(dom);
    store.saveChat(ctx.chat.id, { whitelist_domains: setToCsv(set).slice(0, 2000) }, chatDefs());
    return ctx.reply(`🔗 Whitelisted domains (${set.size}): ${setToCsv(set) || '—'}`);
  }));

  bot.command('rmlink', guard(async (ctx) => {
    const raw = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    const dom = normalizeDomain(raw);
    if (!dom) return ctx.reply('Usage: /rmlink example.com');
    const cfg = store.getChat(ctx.chat.id, chatDefs());
    const set = parseCsv(cfg.whitelist_domains);
    set.delete(dom);
    store.saveChat(ctx.chat.id, { whitelist_domains: setToCsv(set) }, chatDefs());
    return ctx.reply(`🔗 Whitelisted domains (${set.size}): ${setToCsv(set) || '—'}`);
  }));

  bot.command('links', async (ctx) => {
    const cfg = store.getChat(ctx.chat.id, chatDefs());
    const list = setToCsv(parseCsv(cfg.whitelist_domains));
    const env = (process.env.WHITELIST_DOMAINS || '').trim();
    return ctx.reply(`🔗 Group whitelist: ${list || '(none)'}` + (env ? `\nGlobal whitelist: ${env}` : ''));
  });

  bot.command('allowlinks', guard(async (ctx) => {
    const raw = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase();
    if (!['on', 'off'].includes(raw)) return ctx.reply('Usage: /allowlinks on|off — master switch for all links (whitelist still needs the domain when off).');
    store.saveChat(ctx.chat.id, { allow_links: raw === 'on' ? 1 : 0 }, chatDefs());
    return ctx.reply(`🔗 Links are now ${raw.toUpperCase()} for non-admins.`);
  }));
}

module.exports = { register };
