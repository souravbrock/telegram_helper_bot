"""Entrypoint: aiogram Dispatcher + FastAPI webhook (polling for local dev)."""
from __future__ import annotations

import argparse
import logging
import sys

import uvicorn
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import Update
from fastapi import FastAPI, Header, HTTPException, Request

from app.config import get_settings
from app.database import init_db
from app.handlers import admin, engagement, moderation, security
from app.web.api import create_api

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

settings = get_settings()
bot = Bot(token=settings.BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML)) if settings.BOT_TOKEN else None
dp = Dispatcher()
dp["settings"] = settings

# Order matters: admin commands first, then security/captcha, engagement, moderation last.
dp.include_router(admin.router)
dp.include_router(security.router)
dp.include_router(engagement.router)
dp.include_router(moderation.router)

api: FastAPI = create_api(settings)


@api.post(settings.WEBHOOK_PATH or "/webhook")
async def telegram_webhook(request: Request, x_telegram_bot_api_secret_token: str | None = Header(default=None)):
    if not bot:
        raise HTTPException(500, "BOT_TOKEN not configured")
    if settings.WEBHOOK_SECRET and x_telegram_bot_api_secret_token != settings.WEBHOOK_SECRET:
        raise HTTPException(401, "bad secret")
    data = await request.json()
    update = Update.model_validate(data)
    await dp.feed_update(bot, update)
    return {"ok": True}


@api.on_event("startup")
async def on_startup() -> None:
    await init_db(settings.db_path)
    if bot and settings.WEBHOOK_URL:
        await bot.set_webhook(settings.WEBHOOK_URL, secret_token=settings.WEBHOOK_SECRET or None)
        log.info("Webhook set to %s", settings.WEBHOOK_URL)


@api.on_event("shutdown")
async def on_shutdown() -> None:
    if bot:
        try:
            await bot.session.close()
        except Exception:
            pass


async def polling() -> None:
    if not bot:
        log.error("BOT_TOKEN missing. Copy .env.example to .env and fill it.")
        sys.exit(1)
    await init_db(settings.db_path)
    await bot.delete_webhook(drop_pending_updates=True)
    log.info("Starting polling...")
    await dp.start_polling(bot)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--polling", action="store_true", help="run long-polling instead of web server")
    args = p.parse_args()
    if args.polling or not settings.WEBHOOK_URL:
        import asyncio

        asyncio.run(polling())
    else:
        uvicorn.run(api, host=settings.APP_HOST, port=settings.APP_PORT)


if __name__ == "__main__":
    main()
