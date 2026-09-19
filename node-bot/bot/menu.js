'use strict';
/* Inline-button control panel: /menu opens it (admin-only for config).
 * Text inputs (add word, set welcome) work by replying to the prompt message.
 * All slash commands keep working — the menu is a friendlier front for them. */
const { InlineKeyboard } = require('grammy');
const store = require('../lib/store');
const { parseCsv, normalizeDomain, setToCsv } = require('../lib/lists');
const { notesView, filtersView: keywordFiltersView } = require('./notes');

const pendingInput = new Map(); // "chat:user" -> { promptId, action, at }

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

function kbMain() {
  return new InlineKeyboard()
    .text('🚫 Ban words', 'menu:filters').text('🔗 Links', 'menu:links').row()
    .text('📝 Notes', 'menu:notes').text('💬 Filters', 'menu:filtersv').row()
    .text('⏰ Schedules', 'menu:sched').text('⚙️ Settings', 'menu:settings').row()
    .text('📊 Stats', 'menu:stats').text('🗑 Close', 'menu:close');
}

function kbBack(to) {
  return new InlineKeyboard().text('⬅️ Back', `menu:${to}`).text('🗑 Close', 'menu:close');
}

async function show(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

function filtersView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const kb = new InlineKeyboard().text('➕ Add word', 'menu:ban_add').row();
  for (const w of parseCsv(cfg.blacklist_words)) kb.text(`❌ ${w}`, `menu:ban_del:${w}`).row();
  kb.text('⬅️ Back', 'menu:main').text('🗑 Close', 'menu:close');
  const list = setToCsv(parseCsv(cfg.blacklist_words)) || '(none)';
  return { text: `🚫 <b>Ban words</b>\n${list}\n\nTap ❌ to remove, or add new ones.`, kb };
}

function linksView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const kb = new InlineKeyboard()
    .text('➕ Add domain', 'menu:link_add')
    .text(`Links: ${cfg.allow_links ? 'ON' : 'OFF'}`, `menu:allow:${cfg.allow_links ? 'off' : 'on'}`).row();
  for (const d of parseCsv(cfg.whitelist_domains)) kb.text(`❌ ${d}`, `menu:link_del:${d}`).row();
  kb.text('⬅️ Back', 'menu:main').text('🗑 Close', 'menu:close');
  const list = setToCsv(parseCsv(cfg.whitelist_domains)) || '(none)';
  const env = (process.env.WHITELIST_DOMAINS || '').trim();
  return {
    text: `🔗 <b>Link whitelist</b>\nGroup: ${list}\n` +
      (env ? `Global: ${env}\n` : '') +
      `Master switch: <b>${cfg.allow_links ? 'ON — all links allowed' : 'OFF — only whitelisted'}</b>`,
    kb,
  };
}

function settingsView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const kb = new InlineKeyboard()
    .text(`Captcha: ${cfg.captcha_enabled ? 'ON' : 'OFF'}`, `menu:captcha:${cfg.captcha_enabled ? '0' : '1'}`).row()
    .text('➖ Warns', `menu:warn:${Math.max(1, (cfg.warn_limit || 3) - 1)}`)
    .text(`Limit: ${cfg.warn_limit || 3}`, 'menu:noop')
    .text('➕ Warns', `menu:warn:${Math.min(10, (cfg.warn_limit || 3) + 1)}`).row()
    .text('✏️ Set welcome', 'menu:welcome_set').row()
    .text('⬅️ Back', 'menu:main').text('🗑 Close', 'menu:close');
  return { text: `⚙️ <b>Settings</b>\nWelcome: <i>${(cfg.welcome_text || '').slice(0, 120)}</i>`, kb };
}

function schedView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const kb = new InlineKeyboard();
  for (const s of cfg.schedules) kb.text(`❌ ${s.id}`, `menu:sched_del:${s.id}`).row();
  kb.text('⬅️ Back', 'menu:main').text('🗑 Close', 'menu:close');
  const lines = cfg.schedules.length
    ? cfg.schedules.map((s) => `<code>${s.id}</code> every ${s.every}s — ${s.srcMsg ? `media #${s.srcMsg}` : (s.text || '').slice(0, 30)}`).join('\n')
    : '(none)';
  return { text: `⏰ <b>Schedules</b>\n${lines}\n\nCreate: reply to media/text with <code>/schedule 6h caption</code>.`, kb };
}

async function askInput(ctx, label, action) {
  const prompt = await ctx.reply(`✍️ Reply to <b>this message</b> with ${label} (2 min).`, { parse_mode: 'HTML' });
  pendingInput.set(`${ctx.chat.id}:${ctx.from.id}`, { promptId: prompt.message_id, action, at: Date.now() });
}

async function applyInput(ctx, entry, value) {
  const chatId = ctx.chat.id;
  const cfg = store.getChat(chatId, defs());
  if (entry.action === 'ban_add') {
    const set = parseCsv(cfg.blacklist_words);
    value.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).forEach((w) => set.add(w));
    store.saveChat(chatId, { blacklist_words: setToCsv(set).slice(0, 2000) }, defs());
    const v = filtersView(chatId);
    await show(ctx, `✅ Added.\n\n${v.text}`, v.kb);
  } else if (entry.action === 'link_add') {
    const dom = normalizeDomain(value.split(/\s+/)[0]);
    if (!dom) return ctx.reply('That is not a valid domain — try /menu again.');
    const set = parseCsv(cfg.whitelist_domains);
    set.add(dom);
    store.saveChat(chatId, { whitelist_domains: setToCsv(set).slice(0, 2000) }, defs());
    const v = linksView(chatId);
    await show(ctx, `✅ Added.\n\n${v.text}`, v.kb);
  } else if (entry.action === 'welcome_set') {
    store.saveChat(chatId, { welcome_text: value.slice(0, 1000) }, defs());
    const v = settingsView(chatId);
    await show(ctx, `✅ Welcome updated.\n\n${v.text}`, v.kb);
  }
}

function register(bot) {
  bot.command('menu', async (ctx) => {
    if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return ctx.reply('Use /menu inside the group.');
    if (!(await isAdmin(ctx))) return ctx.reply('Only admins can open the control panel.');
    await ctx.reply('🛡 <b>Group control panel</b>\nPick a section:', { parse_mode: 'HTML', reply_markup: kbMain() });
  });

  bot.callbackQuery(/^menu:/, async (ctx) => {
    try {
      if (!(await isAdmin(ctx))) {
        await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
        return;
      }
      const [, ...rest] = (ctx.callbackQuery.data || '').split(':');
      const view = rest[0];
      const arg = rest.slice(1).join(':');
      const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
      const answer = (t) => ctx.answerCallbackQuery({ text: t }).catch(() => {});

      if (view === 'close') { try { await ctx.deleteMessage(); } catch {} return; }
      if (view === 'noop') { await answer(' '); return; }
      if (view === 'main') { const v = { text: '🛡 <b>Group control panel</b>\nPick a section:', kb: kbMain() }; await show(ctx, v.text, v.kb); return; }
      if (view === 'filters') { const v = filtersView(chatId); await show(ctx, v.text, v.kb); return; }
      if (view === 'links') { const v = linksView(chatId); await show(ctx, v.text, v.kb); return; }
      if (view === 'settings') { const v = settingsView(chatId); await show(ctx, v.text, v.kb); return; }
      if (view === 'sched') { const v = schedView(chatId); await show(ctx, v.text, v.kb); return; }
      if (view === 'notes') { const v = notesView(chatId); await show(ctx, v.text, v.kb); return; }
      if (view === 'filtersv') { const v = keywordFiltersView(chatId); await show(ctx, v.text, v.kb); return; }
      if (view === 'stats') {
        const counts = store.actionCounts();
        const keys = Object.keys(counts);
        await show(ctx, keys.length ? '📊 <b>Stats</b>\n' + keys.sort().map((k) => `${k}: ${counts[k]}`).join('\n') : 'No moderation actions yet.', kbBack('main'));
        return;
      }
      if (view === 'ban_add') { await askInput(ctx, 'the word(s), comma-separated', 'ban_add'); await answer('Reply to the prompt'); return; }
      if (view === 'link_add') { await askInput(ctx, 'the domain (e.g. example.com)', 'link_add'); await answer('Reply to the prompt'); return; }
      if (view === 'welcome_set') { await askInput(ctx, 'the welcome text ({mention}, {title}, {name})', 'welcome_set'); await answer('Reply to the prompt'); return; }
      if (view === 'ban_del') {
        const set = parseCsv(store.getChat(chatId, defs()).blacklist_words);
        set.delete(arg.toLowerCase());
        store.saveChat(chatId, { blacklist_words: setToCsv(set) }, defs());
        const v = filtersView(chatId);
        await show(ctx, v.text, v.kb);
        await answer('Removed');
        return;
      }
      if (view === 'link_del') {
        const set = parseCsv(store.getChat(chatId, defs()).whitelist_domains);
        set.delete(arg.toLowerCase());
        store.saveChat(chatId, { whitelist_domains: setToCsv(set) }, defs());
        const v = linksView(chatId);
        await show(ctx, v.text, v.kb);
        await answer('Removed');
        return;
      }
      if (view === 'allow') {
        store.saveChat(chatId, { allow_links: arg === 'on' ? 1 : 0 }, defs());
        const v = linksView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`Links ${arg.toUpperCase()}`);
        return;
      }
      if (view === 'captcha') {
        store.saveChat(chatId, { captcha_enabled: arg === '1' ? 1 : 0 }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`Captcha ${arg === '1' ? 'ON' : 'OFF'}`);
        return;
      }
      if (view === 'warn') {
        const n = Math.max(1, Math.min(10, Number(arg) || 3));
        store.saveChat(chatId, { warn_limit: n }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`Warn limit ${n}`);
        return;
      }
      if (view === 'sched_del') {
        const cfg = store.getChat(chatId, defs());
        store.setSchedules(chatId, cfg.schedules.filter((s) => s.id !== arg), defs());
        const v = schedView(chatId);
        await show(ctx, v.text, v.kb);
        await answer('Schedule removed');
        return;
      }
      await answer('Unknown button');
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });

  // Consume reply-to-prompt text inputs (admins are exempt from spam filters, so no clash).
  bot.on('message:text', async (ctx, next) => {
    try {
      if (!ctx.from || ctx.from.is_bot) return next();
      if ((ctx.msg.text || '').startsWith('/')) return next();
      const k = `${ctx.chat.id}:${ctx.from.id}`;
      const entry = pendingInput.get(k);
      if (!entry) return next();
      if (Date.now() - entry.at > 120 * 1000) { pendingInput.delete(k); return next(); }
      if (!ctx.msg.reply_to_message || ctx.msg.reply_to_message.message_id !== entry.promptId) return next();
      pendingInput.delete(k);
      try { await ctx.deleteMessage(); } catch {} // keep config values out of history
      await applyInput(ctx, entry, (ctx.msg.text || '').trim());
    } catch (err) {
      console.error('menu input error:', err);
    }
  });
}

module.exports = { register };
