# Node.js bot (cPanel deploy target — `tbot.reddevils.co.in`)

Python `app/` can't run here (no Setup Python App on this plan), so this
`node-bot/` is the production deploy: same MVP (moderation, captcha, welcome,
admin commands, Mini-App API), JSON storage (no native modules).

## Deploy to domainadda cPanel (Setup Node.js App)

You confirmed: subdomain `tbot.reddevils.co.in` → `/public_html/tbot` exists,
empty, and Setup Node.js App opens.

1. **File Manager** → open `/public_html/tbot` → Upload → upload the contents
   of local `node-bot/` (`app.js`, `package.json`, `lib/`, `bot/`) + `.env`
   (create from `.env.example` with real `BOT_TOKEN`, `ADMIN_IDS`, `LOG_CHANNEL_ID`).
   - Alternative: **Git Version Control** → clone
     `https://github.com/souravbrock/telegram_helper_bot.git`, then set app root
     to the `node-bot` subfolder (needs app-root support; file upload is simpler).
2. **Setup Node.js App** → Create Application:
   - Node.js version: highest available (18+)
   - Application mode: Production
   - Application root: `/home/reddevil/public_html/tbot`
     (exact prefix from screenshot: `/home/reddevil`)
   - Application URL: `https://tbot.reddevils.co.in` (choose the subdomain)
   - Application startup file: `app.js`
   - **Run NPM Install** (installs `grammy`, `express`, `dotenv`)
   - Environment variables: add `BOT_TOKEN`, `ADMIN_IDS`, `LOG_CHANNEL_ID`
     (or rely on uploaded `.env`)
   - **Restart** → **Enable**
3. Verify: `https://tbot.reddevils.co.in/health` → `{"ok":true,...}`
   Dashboard: `https://tbot.reddevils.co.in/miniapp`
   In Telegram: `/start` to the bot, add it to a test group as admin
   (delete messages + restrict members), send a spam link to see warn flow.
4. Logs: Setup Node.js App → logs / stderr if the bot doesn't start
   (usually missing `BOT_TOKEN` or `npm install` not run).

## Local test

```powershell
cd node-bot
Copy-Item .env.example .env
npm install
node app.js
# API: http://127.0.0.1:3000/health
```
