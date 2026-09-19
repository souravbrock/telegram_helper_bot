'use strict';
/* JSON file store (no native deps — safe on cPanel shared hosting). */
const fs = require('fs');
const path = require('path');

function resolveDb() {
  const f = process.env.DB_FILE || 'data.json';
  if (path.isAbsolute(f)) return f;
  return path.join(__dirname, f);
}

function load() {
  const file = resolveDb();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const d = JSON.parse(raw);
    d.warnings = d.warnings || {};
    d.actions = d.actions || [];
    d.chats = d.chats || {};
    d.pending = d.pending || {}; // "chat:user" -> { buttonId, deadline }
    d.notes = d.notes || {}; // chatId -> { name -> { kind, fileId, text } }
    d.filters = d.filters || {}; // chatId -> { keyword -> { kind, fileId, text } }
    d.groups = d.groups || {}; // chatId -> { title, at } (connection registry)
    d.conns = d.conns || {}; // userId -> chatId (active DM connection)
    return d;
  } catch {
    return { warnings: {}, actions: [], chats: {}, pending: {}, notes: {}, filters: {}, groups: {}, conns: {} };
  }
}

function save(d) {
  const file = resolveDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, file);
}

function key(chatId, userId) {
  return `${chatId}:${userId}`;
}

function getWarnings(chatId, userId) {
  const d = load();
  return d.warnings[key(chatId, userId)] || 0;
}

function addWarning(chatId, userId) {
  const d = load();
  const k = key(chatId, userId);
  d.warnings[k] = (d.warnings[k] || 0) + 1;
  d.actions.push({ ts: Date.now(), chat_id: chatId, user_id: userId, action: `WARN ${d.warnings[k]}`, reason: '', by_user: 0 });
  save(d);
  return d.warnings[k];
}

function resetWarnings(chatId, userId) {
  const d = load();
  delete d.warnings[key(chatId, userId)];
  save(d);
}

function logAction(chatId, userId, action, reason = '', byUser = 0) {
  const d = load();
  d.actions.push({ ts: Date.now(), chat_id: chatId, user_id: userId, action, reason, by_user: byUser });
  if (d.actions.length > 2000) d.actions = d.actions.slice(-2000);
  save(d);
}

function recentActions(limit = 50) {
  const d = load();
  return d.actions.slice(-limit).reverse();
}

function actionCounts() {
  const d = load();
  const c = {};
  for (const a of d.actions) c[a.action] = (c[a.action] || 0) + 1;
  return c;
}

const CHAT_DEFAULTS = {
  welcome_text: 'Welcome {mention} to {title}! Please read the rules.',
  captcha_enabled: 1,
  blacklist_words: '', // per-group CSV, merged with env BLACKLIST_WORDS
  whitelist_domains: '', // per-group CSV, merged with env WHITELIST_DOMAINS
  schedules: [], // [{ id, every, next, srcMsg, caption, text }]
  rules_text: '', // /setrules
  reports_enabled: 1, // /reports on|off
  flood_limit: null, // null = env default; 0 = off; n = custom count
  flood_mode: 'warn', // warn | mute | kick | ban (applied on flood)
  antiraid_enabled: 0, // /antiraid on|off
  antiraid_limit: 5, // joins per window that trips lockdown
  antiraid_window: 60, // seconds
  antiraid_mode: 'kick', // kick | ban during lockdown
  antiraid_duration: 3600, // lockdown seconds
  antiraid_until: 0, // timestamp ms; > now = lockdown active
};

function getChat(chatId, defaults) {
  const d = load();
  const merged = {
    ...CHAT_DEFAULTS,
    warn_limit: defaults.warnLimit,
    allow_links: defaults.allowLinks ? 1 : 0,
    ...(d.chats[String(chatId)] || {}),
  };
  merged.schedules = [...(merged.schedules || [])]; // fresh copy, never mutate shared default
  return merged;
}

function saveChat(chatId, patch, defaults) {
  const d = load();
  const cur = getChat(chatId, defaults);
  d.chats[String(chatId)] = { ...cur, ...patch };
  save(d);
  return d.chats[String(chatId)];
}

function savePending(chatId, userId, buttonId, deadline) {
  const d = load();
  d.pending[key(chatId, userId)] = { buttonId, deadline };
  save(d);
}

function dropPending(chatId, userId) {
  const d = load();
  delete d.pending[key(chatId, userId)];
  save(d);
}

function listPending() {
  const d = load();
  return Object.entries(d.pending).map(([k, v]) => {
    const [chatId, userId] = k.split(':').map(Number);
    return { chatId, userId, buttonId: v.buttonId, deadline: v.deadline };
  });
}

function chatsWithSchedules() {
  const d = load();
  return Object.entries(d.chats)
    .filter(([, c]) => c && Array.isArray(c.schedules) && c.schedules.length)
    .map(([chatId, c]) => ({ chatId: Number(chatId), schedules: [...c.schedules] }));
}

function setSchedules(chatId, schedules, defaults) {
  const d = load();
  const cur = getChat(chatId, defaults);
  d.chats[String(chatId)] = { ...cur, schedules: [...schedules] };
  save(d);
}

function _bucket(bucket, chatId) {
  const d = load();
  d[bucket][String(chatId)] = d[bucket][String(chatId)] || {};
  return d;
}

function getNotes(chatId) {
  return load().notes[String(chatId)] || {};
}

function saveNote(chatId, name, note) {
  const d = _bucket('notes', chatId);
  d.notes[String(chatId)][name] = note;
  save(d);
}

function delNote(chatId, name) {
  const d = _bucket('notes', chatId);
  const existed = Boolean(d.notes[String(chatId)][name]);
  delete d.notes[String(chatId)][name];
  save(d);
  return existed;
}

function clearNotes(chatId) {
  const d = load();
  const n = Object.keys(d.notes[String(chatId)] || {}).length;
  d.notes[String(chatId)] = {};
  save(d);
  return n;
}

function getFilters(chatId) {
  return load().filters[String(chatId)] || {};
}

function saveFilter(chatId, keyword, content) {
  const d = _bucket('filters', chatId);
  d.filters[String(chatId)][keyword] = content;
  save(d);
}

function delFilter(chatId, keyword) {
  const d = _bucket('filters', chatId);
  const existed = Boolean(d.filters[String(chatId)][keyword]);
  delete d.filters[String(chatId)][keyword];
  save(d);
  return existed;
}

function clearFilters(chatId) {
  const d = load();
  const n = Object.keys(d.filters[String(chatId)] || {}).length;
  d.filters[String(chatId)] = {};
  save(d);
  return n;
}

/* Connections: which groups the bot has seen + each user's active DM link. */
function trackGroup(chatId, title) {
  if (!chatId) return;
  const d = load();
  d.groups[String(chatId)] = { title: String(title || '').slice(0, 120), at: Date.now() };
  save(d);
}

function getGroups() {
  const d = load();
  return Object.entries(d.groups || {}).map(([chatId, g]) => ({ chatId: Number(chatId), title: g.title || String(chatId) }));
}

function untrackGroup(chatId) {
  const d = load();
  delete d.groups[String(chatId)];
  for (const [u, c] of Object.entries(d.conns || {})) {
    if (Number(c) === Number(chatId)) delete d.conns[u];
  }
  save(d);
}

function setConnection(userId, chatId) {
  const d = load();
  d.conns[String(userId)] = Number(chatId);
  save(d);
}

function getConnection(userId) {
  const c = load().conns[String(userId)];
  return c ? Number(c) : null;
}

function dropConnection(userId) {
  const d = load();
  delete d.conns[String(userId)];
  save(d);
}

module.exports = {
  getWarnings, addWarning, resetWarnings, logAction,
  recentActions, actionCounts, getChat, saveChat,
  savePending, dropPending, listPending,
  chatsWithSchedules, setSchedules,
  getNotes, saveNote, delNote, clearNotes,
  getFilters, saveFilter, delFilter, clearFilters,
  trackGroup, getGroups, untrackGroup, setConnection, getConnection, dropConnection,
};
