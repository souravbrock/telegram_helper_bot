# Telegram Group Assistant (MVP)

All-in-one group management bot: moderation + anti-spam, captcha verification,
welcome messages, admin commands, Mini-App dashboard + public API.

> MVP scope: auto-moderation (links/forwards/emoji/flood/blacklist),
> warn→mute→kick→ban escalation, math captcha, customizable welcome,
> `/warn /mute /kick /ban /poll /stats`, admin log channel + SQLite logs,
> FastAPI (`/health`, `/api/logs`, `/api/stats`, `/api/settings`) + Mini-App at `/miniapp`.

## 1. Create the bot (BotFather) — step by step

1. In Telegram, open **@BotFather** → `/newbot` → pick name + username → copy the **token**.
2. Disable privacy so the bot sees group messages: **@BotFather → /setprivacy → your bot → Disable**.
3. Optional Mini-App button: `/mybots → your bot → Bot Settings → Menu Button → set URL to https://<your-subdomain>/miniapp`.
4. Create a **log channel** (private), add the bot as **admin**, then get its ID:
   - Forward a channel message to **@userinfobot** or use **@RawDataBot** → ID looks like `-100xxxxxxxxxx`.
5. Get your own user ID from **@userinfobot**.

## 2. Local run (Windows)

```powershell
# .env
Copy-Item .env.example .env
# edit .env: BOT_TOKEN, ADMIN_IDS, LOG_CHANNEL_ID
# leave WEBHOOK_URL empty for local polling

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m app.main --polling
# or: uvicorn app.main:api --port 8000  (webhook/API mode)
```

Add the bot to a test group as **admin** (delete messages + restrict members),
send a spam link / flood, verify warn → mute flow, test new-member captcha.

API check: `http://127.0.0.1:8000/health`, dashboard `http://127.0.0.1:8000/miniapp`.

## 3. GitHub sync

```powershell
git init
git add .
git commit -m "feat: MVP group assistant bot"
git branch -M main
git remote add origin git@github.com:souravbrock/telegram_helper_bot.git
git push -u origin main
```

## 4. Host on domainadda cPanel (subdomain of reddevils.co.in)

> Please re-upload your cPanel screenshots (Software / Domains / Databases / SSL)
> so I can tailor exact clicks. Generic path that works on most domainadda plans:

1. **Subdomains** → create e.g. `bot.reddevils.co.in` (document root `bot.reddevils.co.in`).
2. **SSL/TLS Status** → AutoSSL / Let's Encrypt for the subdomain (Telegram webhooks require HTTPS).
3. **Setup Python App** → New app:
   - Python 3.11+, app root = subdomain folder, startup file `passenger_wsgi.py`, callable `application`.
   - Upload project (Git Version Control → clone `git@github.com:souravbrock/telegram_helper_bot.git`, or File Manager zip).
   - `pip install -r requirements.txt` via the app's pip.
   - Add env vars / `.env` with `WEBHOOK_URL=https://bot.reddevils.co.in/webhook`, `BOT_TOKEN`, `ADMIN_IDS`, `LOG_CHANNEL_ID`.
   - **Restart** the Python app.
4. Verify: `https://bot.reddevils.co.in/health` → `{"ok": true}`, then send `/start` to the bot.
5. If your plan **has no Setup Python App / no persistent process**: shared cPanel can't long-poll.
   Options: (a) webhook via `passenger_wsgi.py` (this repo supports it), or (b) cheapest VPS + systemd + webhook/polling.

## 5. Project layout

```
app/main.py            entry (polling + webhook FastAPI)
app/config.py          .env settings
app/database.py        SQLite (warnings, actions, chat_settings)
app/handlers/          moderation | security(captcha) | engagement | admin
app/services/          antispam | modlog
app/web/api.py         /health /api/* JSON for Mini-App
app/web/miniapp/       admin dashboard (static)
passenger_wsgi.py      cPanel WSGI entry
```

## 6. Security notes (before public launch)

- `POST /api/settings/{chat}` currently has no auth (MVP). Add Telegram WebApp `initData` HMAC check + admin-only guard.
- Rotate `WEBHOOK_SECRET`, keep `.env` out of git (see `.gitignore`).
- Give the bot only needed admin rights per group.
