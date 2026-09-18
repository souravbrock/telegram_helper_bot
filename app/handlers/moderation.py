"""Group message moderation: delete spam, warn -> mute -> kick -> ban escalation."""
from __future__ import annotations

import logging
from datetime import timedelta

from aiogram import F, Router
from aiogram.types import Message

from app.config import Settings
from app.database import add_warning, get_chat_settings, reset_warnings
from app.services.antispam import AntiSpam
from app.services.modlog import record

log = logging.getLogger(__name__)
router = Router(name="moderation")
antispam = AntiSpam()


async def _is_admin(message: Message) -> bool:
    if not message.chat or message.from_user is None:
        return True
    try:
        member = await message.chat.get_member(message.from_user.id)
        return member.status in ("administrator", "creator")
    except Exception:
        return False


@router.message(F.chat.type.in_({"group", "supergroup"}), F.content_type == "text")
async def moderate_text(message: Message, settings: Settings) -> None:
    if message.from_user is None or message.from_user.is_bot:
        return
    if await _is_admin(message):
        return
    assert message.chat is not None

    cfg = await get_chat_settings(settings.db_path, message.chat.id)
    verdict = antispam.check(
        chat_id=message.chat.id,
        user_id=message.from_user.id,
        text=message.text or message.caption or "",
        has_entities_url=bool(message.entities or message.caption_entities),
        is_forward=bool(message.forward_date or message.forward_from_chat),
        allow_links=bool(cfg.get("allow_links", 0)) or settings.ALLOW_LINKS,
        whitelist_domains=settings.whitelist_domains,
        blacklist_words=settings.blacklist_words,
    )
    if not verdict.is_spam:
        return

    reason = "; ".join(verdict.reasons)
    bot = message.bot
    assert bot is not None

    # 1. delete offending message
    try:
        await message.delete()
    except Exception as e:  # noqa: BLE001
        log.warning("delete failed: %s", e)

    # 2. warn + escalate
    count = await add_warning(settings.db_path, message.chat.id, message.from_user.id)
    warn_limit = int(cfg.get("warn_limit", settings.WARN_LIMIT) or settings.WARN_LIMIT)

    try:
        if count >= warn_limit * 2:
            await bot.ban_chat_member(message.chat.id, message.from_user.id)
            action = "BAN"
            await record(bot, settings, chat_id=message.chat.id, user_id=message.from_user.id,
                         action=action, reason=f"{reason} ({count} warns)",
                         chat_title=message.chat.title or "")
        elif count >= warn_limit + 1:
            await bot.ban_chat_member(message.chat.id, message.from_user.id)
            await bot.unban_chat_member(message.chat.id, message.from_user.id)
            # kick = ban then immediate unban
            action = "KICK"
            await record(bot, settings, chat_id=message.chat.id, user_id=message.from_user.id,
                         action=action, reason=f"{reason} ({count} warns)",
                         chat_title=message.chat.title or "")
        elif count >= warn_limit:
            await bot.restrict_chat_member(
                message.chat.id, message.from_user.id,
                permissions={"can_send_messages": False},
                until_date=timedelta(hours=1),
            )
            action = f"MUTE 1h ({count} warns)"
            await record(bot, settings, chat_id=message.chat.id, user_id=message.from_user.id,
                         action=action, reason=reason,
                         chat_title=message.chat.title or "")
        else:
            action = f"WARN {count}/{warn_limit}"
            await record(bot, settings, chat_id=message.chat.id, user_id=message.from_user.id,
                         action=action, reason=reason,
                         chat_title=message.chat.title or "")
            await bot.send_message(
                message.chat.id,
                f"⚠️ <a href='tg://user?id={message.from_user.id}'>{message.from_user.full_name}</a> "
                f"warned ({count}/{warn_limit}): {reason}",
            )
            return
        await reset_warnings(settings.db_path, message.chat.id, message.from_user.id)
        await bot.send_message(message.chat.id, f"⛔️ User {message.from_user.full_name}: {action} — {reason}")
    except Exception as e:  # noqa: BLE001 - bot may lack rights; never crash
        log.warning("escalation failed (need admin rights?): %s", e)
