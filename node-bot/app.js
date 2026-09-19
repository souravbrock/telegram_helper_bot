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
const scheduler = require('./bot/scheduler');

const PORT = parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10);
const TOKEN = (process.env.BOT_TOKEN || '').trim();

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, env: process.env.ENV || 'production' }));
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  res.json({ items: store.recentActions(limit) });
});
app.get('/api/stats', (_req, res) => {
  const counts = store.actionCounts();
  res.json({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
});
app.get('/api/settings/:chatId', (req, res) => {
  res.json(store.getChat(req.params.chatId, { warnLimit: 3, allowLinks: false }));
});
app.post('/api/settings/:chatId', (req, res) => {
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
app.use('/miniapp', express.static(path.join(__dirname, '..', 'app', 'web', 'miniapp')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'app', 'web', 'miniapp', 'index.html')));

let bot = null;
if (TOKEN) {
  bot = new Bot(TOKEN);
  bot.catch((err) => console.error('bot error:', err));
  admin.register(bot);
  captcha.register(bot);
  moderation.register(bot);
  scheduler.register(bot);
  bot.start({ onStart: () => console.log('bot polling started') }).catch((e) => console.error('poll start failed:', e.message));
} else {
  console.warn('BOT_TOKEN missing — API only. Copy .env.example to .env.');
}

app.listen(PORT, () => console.log(`web listening on ${PORT}`));
