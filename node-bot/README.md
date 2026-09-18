# Node.js bot (deploy targets: Render + `tbot.reddevils.co.in`)

Python `app/` can't run on the current cPanel plan (no Setup Python App), so
this `node-bot/` is the production deploy: same MVP (moderation, captcha,
welcome, admin commands, Mini-App API), JSON storage (no native modules).

`app.js` runs bot polling + Express API in one process, so it fits a single
Render free web service (no separate worker needed).

## Deploy to Render (free, current path)

1. Push to GitHub (done: `main`), then **render.com → New → Web Service →
   Build from GitHub** → pick `souravbrock/telegram_helper_bot`.
   Render auto-detects `render.yaml` (rootDir `node-bot`, health check `/health`).
2. Environment → add secrets: `BOT_TOKEN` (use the **revoked/re-issued** token,
   never the one from the screenshots), `ADMIN_IDS`, `LOG_CHANNEL_ID`.
   Defaults for the rest are in `render.yaml`.
3. Create → wait for **Live** → open `https://<your-app>.onrender.com/health`
   → `{"ok":true,...}`.
4. Free-tier sleeps: add a free **UptimeRobot** monitor hitting `/health` every
   5 min to keep the polling bot alive. (Mini-App dashboard lives at `/miniapp`
   on the same URL until cPanel Passenger is fixed.)
5. Telegram test: `/start`, add bot to a test group as admin (delete + restrict
   rights), send a spam link → warn flow; new-member captcha on join.

## Deploy to domainadda cPanel (blocked: host Passenger 500s, ticket open)

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
