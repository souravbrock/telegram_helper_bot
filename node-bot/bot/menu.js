'use strict';
/* Inline-button control panel: /menu opens it (admin-only for config).
 * Text inputs (add word, set welcome) work by replying to the prompt message.
 * All slash commands keep working — the menu is a friendlier front for them. */
const { InlineKeyboard } = require('grammy');
const { grid, withNav } = require('../lib/kb');
const store = require('../lib/store');
const { parseCsv, normalizeDomain, setToCsv } = require('../lib/lists');
const { notesView, filtersView: keywordFiltersView } = require('./notes');
const { MODULES, MOD_PANELS, PANEL_LABEL } = require('./helpmenu');

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

/* Admin check against an explicit chat — used for DM connections. */
async function isAdminChat(bot, chatId, userId) {
  if (adminIds().has(Number(userId))) return true;
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

/* Resolve which group a panel action targets: the current group, or the
 * user's DM connection when operating from a private chat. */
function targetChat(ctx) {
  if (ctx.chat?.type === 'private') return store.getConnection(ctx.from.id);
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
}

async function openPanel(ctx, chatId) {
  let title = '';
  try { title = (await ctx.api.getChat(chatId)).title || String(chatId); } catch { title = String(chatId); }
  await ctx.reply(`🛡 <b>${title}</b> — control panel\nPick a module:`, { parse_mode: 'HTML', reply_markup: kbMain() });
}

function kbMain() {
  // Rose-style module grid; each module opens help + shortcut buttons.
  const items = Object.keys(MODULES).map((k) => ({ t: k, d: `menu:mod:${k}` }));
  items.push({ row: true }, { t: '📊 Stats', d: 'menu:stats' }, { t: '🗑 Close', d: 'menu:close' });
  return grid(items, 3);
}

/* Which existing panel views each module shortcuts to (shared map). */

function modView(name) {
  const items = (MOD_PANELS[name] || []).map((p) => ({ t: `➡️ ${PANEL_LABEL[p] || p}`, d: `menu:${p}` }));
  return { text: `${MODULES[name] || name}`, kb: withNav(items, 'menu:main') };
}

function kbBack(to) {
  return grid([{ t: '⬅️ Back', d: `menu:${to}` }, { t: '🗑 Close', d: 'menu:close' }], 2);
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
  const items = [{ t: '➕ Add word', d: 'menu:ban_add' }, { row: true }];
  for (const w of parseCsv(cfg.blacklist_words)) items.push({ t: `❌ ${w}`.slice(0, 60), d: `menu:ban_del:${w}` });
  const list = setToCsv(parseCsv(cfg.blacklist_words)) || '(none)';
  return { text: `🚫 <b>Ban words</b>\n${list}\n\nTap ❌ to remove, or add new ones.`, kb: withNav(items, 'menu:main') };
}

function linksView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const items = [
    { t: '➕ Add domain', d: 'menu:link_add' },
    { t: `Links: ${cfg.allow_links ? 'ON' : 'OFF'}`, d: `menu:allow:${cfg.allow_links ? 'off' : 'on'}` },
    { row: true },
  ];
  for (const d of parseCsv(cfg.whitelist_domains)) items.push({ t: `❌ ${d}`.slice(0, 60), d: `menu:link_del:${d}` });
  const list = setToCsv(parseCsv(cfg.whitelist_domains)) || '(none)';
  const env = (process.env.WHITELIST_DOMAINS || '').trim();
  return {
    text: `🔗 <b>Link whitelist</b>\nGroup: ${list}\n` +
      (env ? `Global: ${env}\n` : '') +
      `Master switch: <b>${cfg.allow_links ? 'ON — all links allowed' : 'OFF — only whitelisted'}</b>`,
    kb: withNav(items, 'menu:main'),
  };
}

function settingsView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const envN = parseInt(process.env.FLOOD_LIMIT || '5', 10);
  const cur = typeof cfg.flood_limit === 'number' ? cfg.flood_limit : envN;
  const floodLabel = cfg.flood_limit === 0 ? 'OFF' : (cfg.flood_limit ?? `${envN} (env)`);
  const modes = ['warn', 'mute', 'kick', 'ban'];
  const nextMode = modes[(modes.indexOf(cfg.flood_mode || 'warn') + 1) % modes.length];
  const kb = grid([
    { t: `Captcha: ${cfg.captcha_enabled ? 'ON' : 'OFF'}`, d: `menu:captcha:${cfg.captcha_enabled ? '0' : '1'}` },
    { t: `Reports: ${Number(cfg.reports_enabled ?? 1) ? 'ON' : 'OFF'}`, d: `menu:reports:${Number(cfg.reports_enabled ?? 1) ? '0' : '1'}` },
    { t: '➖ Warns', d: `menu:warn:${Math.max(1, (cfg.warn_limit || 3) - 1)}` },
    { t: `Limit: ${cfg.warn_limit || 3}`, d: 'menu:noop' },
    { t: '➕ Warns', d: `menu:warn:${Math.min(10, (cfg.warn_limit || 3) + 1)}` },
    { t: '🌊 Flood: ' + floodLabel, d: 'menu:noop' },
    { t: '➖', d: `menu:floodlim:${Math.max(0, cur - 1)}` },
    { t: '➕', d: `menu:floodlim:${cur === 0 ? envN : Math.min(30, cur + 1)}` },
    { t: `Flood→${(cfg.flood_mode || 'warn').toUpperCase()} (tap: ${nextMode})`, d: `menu:floodmode:${nextMode}` },
    { row: true },
    { t: '✏️ Set welcome', d: 'menu:welcome_set' },
    { t: '✏️ Set rules', d: 'menu:rules_set' },
    { t: `🛡 AntiRaid: ${Number(cfg.antiraid_enabled ?? 0) ? 'ON' : 'OFF'}`, d: `menu:antiraid:${Number(cfg.antiraid_enabled ?? 0) ? '0' : '1'}` },
    { t: `Raid→${(cfg.antiraid_mode || 'kick').toUpperCase()}`, d: `menu:raidmode:${(cfg.antiraid_mode || 'kick') === 'kick' ? 'ban' : 'kick'}` },
    { row: true },
    { t: '⬅️ Back', d: 'menu:main' },
    { t: '🗑 Close', d: 'menu:close' },
  ], 3);
  return {
    text: `⚙️ <b>Settings</b>\nWelcome: <i>${(cfg.welcome_text || '').slice(0, 80)}</i>\n` +
      `Rules: <i>${((cfg.rules_text || '').slice(0, 80)) || '(none)'}</i>`,
    kb,
  };
}

function schedView(chatId) {
  const cfg = store.getChat(chatId, defs());
  const tz = typeof cfg.tz_offset === 'number' ? cfg.tz_offset : parseInt(process.env.DEFAULT_TZ_MIN || '330', 10);
  const sign = tz < 0 ? '-' : '+';
  const tzLabel = `${sign}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, '0')}:${String(Math.abs(tz) % 60).padStart(2, '0')}`;
  const items = [{ t: '➕ New guided', d: 'sch:new' }, { row: true }];
  for (const s of cfg.schedules) items.push({ t: `❌ ${s.id}`.slice(0, 60), d: `menu:sched_del:${s.id}` });
  const kb = withNav(items, 'menu:main');
  const lines = cfg.schedules.length
    ? cfg.schedules.map((s) => `<code>${s.id}</code> every ${s.every}s — ${s.srcMsg ? `media #${s.srcMsg}` : (s.text || '').slice(0, 30)}`).join('\n')
    : '(none)';
  return { text: `⏰ <b>Schedules</b> (group time UTC${tzLabel} — /settz to change)\n${lines}\n\nGuided: tap ➕ New. Quick: reply to media/text with <code>/schedule 6h caption</code>.`, kb };
}

async function askInput(ctx, label, action, chatId) {
  const prompt = await ctx.reply(`✍️ Reply to <b>this message</b> with ${label} (2 min).`, { parse_mode: 'HTML' });
  pendingInput.set(`${ctx.chat.id}:${ctx.from.id}`, { promptId: prompt.message_id, action, chat: chatId, at: Date.now() });
}

async function applyInput(ctx, entry, value) {
  const chatId = entry.chat;
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
  } else if (entry.action === 'rules_set') {
    store.saveChat(chatId, { rules_text: value.slice(0, 2000) }, defs());
    const v = settingsView(chatId);
    await show(ctx, `✅ Rules updated.\n\n${v.text}`, v.kb);
  }
}

let cachedUsername = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
async function botUsername(bot) {
  if (!cachedUsername) {
    try { cachedUsername = ((await bot.api.getMe()).username || '').replace(/^@/, ''); } catch {}
  }
  return cachedUsername;
}

function register(bot) {
  bot.command('menu', async (ctx) => {
    // Private-by-default: the panel never opens in the group. Admins get a
    // self-destructing deep link; everyone else gets silence (privacy).
    if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return ctx.reply('Use /menu inside the group.');
    try { await ctx.deleteMessage(); } catch {} // erase the command itself
    if (!(await isAdmin(ctx))) return; // non-admins: nothing to see
    const username = await botUsername(bot);
    const kb = username
      ? new InlineKeyboard().url('🔐 Open control panel', `https://t.me/${username}?start=menu_${ctx.chat.id}`)
      : undefined;
    const note = await ctx.reply(
      `🔐 <a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>, the control panel is private — tap below (DM). This message self-destructs.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
    setTimeout(async () => { try { await ctx.api.deleteMessage(ctx.chat.id, note.message_id); } catch {} }, 60 * 1000).unref?.();
  });

  bot.callbackQuery(/^menu:/, async (ctx) => {
    try {
      const chatId = targetChat(ctx);
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: 'Connect a group first: /start → My Groups.', show_alert: true });
        return;
      }
      if (!(await isAdminChat(bot, chatId, ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
        return;
      }
      const [, ...rest] = (ctx.callbackQuery.data || '').split(':');
      const view = rest[0];
      const arg = rest.slice(1).join(':');
      const answer = (t) => ctx.answerCallbackQuery({ text: t }).catch(() => {});

      if (view === 'close') { try { await ctx.deleteMessage(); } catch {} return; }
      if (view === 'noop') { await answer(' '); return; }
      if (view === 'main') { const v = { text: '🛡 <b>Group control panel</b>\nPick a module:', kb: kbMain() }; await show(ctx, v.text, v.kb); return; }
      if (view === 'mod') {
        if (!MODULES[arg]) { await answer('Unknown module'); return; }
        const v = modView(arg);
        await show(ctx, v.text, v.kb);
        return;
      }
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
      if (view === 'ban_add') { await askInput(ctx, 'the word(s), comma-separated', 'ban_add', chatId); await answer('Reply to the prompt'); return; }
      if (view === 'link_add') { await askInput(ctx, 'the domain (e.g. example.com)', 'link_add', chatId); await answer('Reply to the prompt'); return; }
      if (view === 'welcome_set') { await askInput(ctx, 'the welcome text ({mention}, {title}, {name})', 'welcome_set', chatId); await answer('Reply to the prompt'); return; }
      if (view === 'rules_set') { await askInput(ctx, 'the rules text', 'rules_set', chatId); await answer('Reply to the prompt'); return; }
      if (view === 'reports') {
        store.saveChat(chatId, { reports_enabled: arg === '1' ? 1 : 0 }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`Reports ${arg === '1' ? 'ON' : 'OFF'}`);
        return;
      }
      if (view === 'floodlim') {
        const n = Math.max(0, Math.min(30, Number(arg) || 0));
        store.saveChat(chatId, { flood_limit: n }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(n === 0 ? 'Flood OFF' : `Flood limit ${n}`);
        return;
      }
      if (view === 'floodmode') {
        const mode = ['warn', 'mute', 'kick', 'ban'].includes(arg) ? arg : 'warn';
        store.saveChat(chatId, { flood_mode: mode }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`Flood action ${mode.toUpperCase()}`);
        return;
      }
      if (view === 'antiraid') {
        store.saveChat(chatId, { antiraid_enabled: arg === '1' ? 1 : 0, antiraid_until: 0 }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`AntiRaid ${arg === '1' ? 'ARMED' : 'OFF'}`);
        return;
      }
      if (view === 'raidmode') {
        const mode = arg === 'ban' ? 'ban' : 'kick';
        store.saveChat(chatId, { antiraid_mode: mode }, defs());
        const v = settingsView(chatId);
        await show(ctx, v.text, v.kb);
        await answer(`Raid action ${mode.toUpperCase()}`);
        return;
      }
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

module.exports = { register, openPanel, isAdminChat, kbMain, modView, filtersView, linksView, settingsView, schedView };
