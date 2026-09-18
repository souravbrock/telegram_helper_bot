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
    return d;
  } catch {
    return { warnings: {}, actions: [], chats: {} , pending: {} };
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

function getChat(chatId, defaults) {
  const d = load();
  return (
    d.chats[String(chatId)] || {
      welcome_text: 'Welcome {mention} to {title}! Please read the rules.',
      warn_limit: defaults.warnLimit,
      allow_links: defaults.allowLinks ? 1 : 0,
      captcha_enabled: 1,
    }
  );
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

module.exports = {
  getWarnings, addWarning, resetWarnings, logAction,
  recentActions, actionCounts, getChat, saveChat,
  savePending, dropPending, listPending,
};
