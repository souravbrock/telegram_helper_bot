'use strict';
/* cPanel Setup Node.js App entry. Polling bot + Express Mini-App API.
 *
 * cPanel fields:
 *   Application root : e.g. /home/reddevil/tbot   (upload THIS folder's contents there)
 *   Application URL  : https://tbot.reddevils.co.in
 *   Startup file     : app.js
 *   Run `npm install`, add env vars, Restart, Enable.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { Bot } = require('grammy');

const store = require('./lib/store');
const moderation = require('./bot/moderation');
const captcha = require('./bot/captcha');
const admin = require('./bot/admin');
const menu = require('./bot/menu');
const antiraid = require('./bot/antiraid');
const scheduler = require('./bot/scheduler');
const notes = require('./bot/notes');
const reports = require('./bot/reports');
const helpmenu = require('./bot/helpmenu');
const connections = require('./bot/connections');

const PORT = parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10);
const TOKEN = (process.env.BOT_TOKEN || '').trim();
// cPanel ea-passenger (Phusion) takes over listen() — call it bare, exactly
// like the known-good spdelivery app on this host. Everywhere else bind PORT.
const UNDER_PASSENGER = Boolean(process.env.PASSENGER_APP_ENV || process.env.PASSENGER_SPAWN_WORK_DIR);

const app = express();

// Base path: '' on Render (root), '/api' on cPanel (sub-URI app).
// All routes live on `core`; it is mounted once at BASE.
let BASE = (process.env.APP_BASE_PATH || '').trim();
if (BASE && !BASE.startsWith('/')) BASE = '/' + BASE;
if (BASE === '/') BASE = '';
const core = express();
core.use(express.json());

core.get('/health', (_req, res) => res.json({ ok: true, env: process.env.ENV || 'production', base: BASE || '/' }));
core.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  res.json({ items: store.recentActions(limit) });
});
core.get('/api/stats', (req, res) => {
  const counts = store.actionCounts();
  res.json({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
});
core.get('/api/settings/:chatId', (req, res) => {
  res.json(store.getChat(req.params.chatId, { warnLimit: 3, allowLinks: false }));
});
core.post('/api/settings/:chatId', (req, res) => {
  // TODO: require Telegram WebApp initData auth + admin check before public use.
  const patch = {};
  const b = req.body || {};
  if (typeof b.welcome_text === 'string') patch.welcome_text = b.welcome_text.slice(0, 1000);
  if (Number.isInteger(b.warn_limit)) patch.warn_limit = Math.max(1, Math.min(10, b.warn_limit));
  if (typeof b.allow_links === 'boolean') patch.allow_links = b.allow_links ? 1 : 0;
  if (typeof b.captcha_enabled === 'boolean') patch.captcha_enabled = b.captcha_enabled ? 1 : 0;
  if (typeof b.blacklist_words === 'string') patch.blacklist_words = b.blacklist_words.slice(0, 2000);
  if (typeof b.whitelist_domains === 'string') patch.whitelist_domains = b.whitelist_domains.slice(0, 2000);
  res.json(store.saveChat(req.params.chatId, patch, { warnLimit: 3, allowLinks: false }));
});

// Mini-App dashboard (reuse Python static)
core.use('/miniapp', express.static(path.join(__dirname, '..', 'app', 'web', 'miniapp')));
core.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'app', 'web', 'miniapp', 'index.html')));

app.use(BASE || '/', core);

let bot = null;
if (TOKEN) {
  bot = new Bot(TOKEN);
  bot.catch((err) => console.error('bot error:', err));
  connections.register(bot); // first: group tracking for the DM list
  admin.register(bot);
  menu.register(bot);
  antiraid.register(bot); // before captcha: raids skip verification
  captcha.register(bot);
  moderation.register(bot);
  scheduler.register(bot);
  notes.register(bot); // after moderation: deleted spam never triggers filters
  reports.register(bot);
  helpmenu.register(bot); // DM module-grid callbacks
  // Visible command list (hamburger menu) in Telegram clients.
  bot.api.setMyCommands([
    { command: 'menu', description: 'Open control panel (group admins)' },
    { command: 'help', description: 'Show all commands' },
    { command: 'warn', description: 'Warn a user (reply)' },
    { command: 'unwarn', description: 'Clear warns (reply)' },
    { command: 'warns', description: 'Show warns' },
    { command: 'mute', description: 'Mute a user, e.g. /mute 10m (reply)' },
    { command: 'unmute', description: 'Unmute a user (reply)' },
    { command: 'kick', description: 'Kick a user (reply)' },
    { command: 'ban', description: 'Ban a user (reply)' },
    { command: 'unban', description: 'Unban: /unban user_id' },
    { command: 'setwelcome', description: 'Set welcome text' },
    { command: 'poll', description: 'Quick poll: /poll Q?; A; B' },
    { command: 'stats', description: 'Moderation stats' },
    { command: 'addbanword', description: 'Add ban word(s)' },
    { command: 'banwords', description: 'List ban words' },
    { command: 'addlink', description: 'Whitelist a domain' },
    { command: 'links', description: 'List whitelisted domains' },
    { command: 'allowlinks', description: 'Links on/off' },
    { command: 'schedule', description: 'Recurring post (reply to media)' },
    { command: 'schedules', description: 'List recurring posts' },
    { command: 'unschedule', description: 'Cancel a recurring post' },
    { command: 'settz', description: 'Group timezone +5:30' },
    { command: 'save', description: 'Save a note (reply)' },
    { command: 'get', description: 'Recall a note' },
    { command: 'notes', description: 'List notes' },
    { command: 'clear', description: 'Delete a note' },
    { command: 'filter', description: 'Auto-reply to a keyword' },
    { command: 'autoreply', description: 'Guided smart reply' },
    { command: 'filters', description: 'List filters' },
    { command: 'stop', description: 'Remove a filter' },
    { command: 'report', description: 'Report a message (reply)' },
    { command: 'rules', description: 'Show group rules' },
    { command: 'setrules', description: 'Set group rules' },
    { command: 'reports', description: 'Reports on/off' },
    { command: 'setflood', description: 'Flood limit' },
    { command: 'setfloodmode', description: 'Flood action' },
    { command: 'flood', description: 'Flood status' },
    { command: 'purge', description: 'Delete range (reply)' },
    { command: 'pin', description: 'Pin (reply)' },
    { command: 'unpin', description: 'Unpin' },
    { command: 'tmute', description: 'Temp mute (reply)' },
    { command: 'tban', description: 'Temp ban (reply)' },
    { command: 'promote', description: 'Promote (reply)' },
    { command: 'demote', description: 'Demote (reply)' },
    { command: 'adminlist', description: 'List admins' },
    { command: 'antiraid', description: 'Raid lockdown on/off/status' },
    { command: 'setraidlimit', description: 'Raid join limit' },
    { command: 'setraidmode', description: 'Raid action kick/ban' },
    { command: 'connect', description: 'Link group to DM' },
    { command: 'disconnect', description: 'Unlink DM' },
  ]).catch((e) => console.warn('setMyCommands failed:', e.message));
  bot.start({ onStart: () => console.log('bot polling started') }).catch((e) => console.error('poll start failed:', e.message));
} else {
  console.warn('BOT_TOKEN missing — API only. Copy .env.example to .env.');
}

app.listen(...(UNDER_PASSENGER ? [] : [PORT]), () => console.log(`web listening on ${UNDER_PASSENGER ? 'passenger socket' : PORT}`));
