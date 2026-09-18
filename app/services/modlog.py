"""Send moderation events to admin log channel + SQLite."""
from __future__ import annotations

import logging

from aiogram import Bot

from app.config import Settings
from app.database import log_action

log = logging.getLogger(__name__)


async def record(
    bot: Bot,
    settings: Settings,
    *,
    chat_id: int,
    user_id: int,
    action: str,
    reason: str = "",
    by_user: int = 0,
    chat_title: str = "",
) -> None:
    await log_action(settings.db_path, chat_id, user_id, action, reason, by_user)
    channel = settings.log_channel_id
    if not channel:
        return
    text = (
        f"🛡 <b>{action}</b>\n"
        f"Group: {chat_title or chat_id} (<code>{chat_id}</code>)\n"
        f"User: <code>{user_id}</code>\n"
        f"By: <code>{by_user}</code>\n"
        f"Reason: {reason or '-'}"
    )
    try:
        await bot.send_message(channel, text)
    except Exception as e:  # noqa: BLE001 - log channel must never crash moderation
        log.warning("Failed to write modlog to %s: %s", channel, e)
