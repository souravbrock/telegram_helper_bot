"""Manual moderation commands: /warn /mute /kick /ban etc."""
from __future__ import annotations

import re
from datetime import timedelta

from aiogram import Router
from aiogram.filters import Command
from aiogram.types import ChatPermissions, Message

from app.config import Settings
from app.database import add_warning, get_warnings, reset_warnings
from app.services.modlog import record

router = Router(name="admin")

MUTED = ChatPermissions(
    can_send_messages=False, can_send_media_messages=False,
    can_send_other_messages=False, can_add_web_page_previews=False,
)
OPEN = ChatPermissions(
    can_send_messages=True, can_send_media_messages=True,
    can_send_other_messages=True, can_add_web_page_previews=True,
)


def _target_from_reply(message: Message) -> int | None:
    if message.reply_to_message and message.reply_to_message.from_user:
        return message.reply_to_message.from_user.id
    # /cmd <user_id>
    if message.text:
        m = re.search(r"/\w+\s+(\d+)", message.text)
        if m:
            return int(m.group(1))
    return None


async def _require_admin(message: Message, settings: Settings) -> bool:
    if message.from_user and message.from_user.id in settings.admin_ids:
        return True
    if message.chat and message.from_user:
        try:
            m = await message.chat.get_member(message.from_user.id)
            if m.status in ("administrator", "creator"):
                return True
        except Exception:
            pass
    await message.reply("Only admins can use this command.")
    return False


def _parse_duration(s: str) -> timedelta:
    m = re.fullmatch(r"(\d+)([mhd])", s.strip().lower())
    if not m:
        return timedelta(hours=1)
    n, unit = int(m.group(1)), m.group(2)
    return {"m": timedelta(minutes=n), "h": timedelta(hours=n), "d": timedelta(days=n)}[unit]


@router.message(Command("warn"))
async def warn(message: Message, settings: Settings) -> None:
    if message.chat is None or message.bot is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Reply to a user: /warn (reply)")
        return
    count = await add_warning(settings.db_path, message.chat.id, target)
    await record(message.bot, settings, chat_id=message.chat.id, user_id=target,
                 action=f"WARN {count}", by_user=message.from_user.id if message.from_user else 0,
                 chat_title=message.chat.title or "")
    await message.reply(f"⚠️ User <code>{target}</code> warned ({count}).")


@router.message(Command("unwarn"))
async def unwarn(message: Message, settings: Settings) -> None:
    if message.chat is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Reply to a user: /unwarn (reply)")
        return
    await reset_warnings(settings.db_path, message.chat.id, target)
    await message.reply(f"✅ Warns cleared for <code>{target}</code>.")


@router.message(Command("mute"))
async def mute(message: Message, settings: Settings) -> None:
    if message.chat is None or message.bot is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Usage: /mute 10m (reply to user)")
        return
    dur_txt = "1h"
    if message.text:
        m = re.search(r"/mute\s+(\d+[mhd])", message.text)
        if m:
            dur_txt = m.group(1)
    try:
        await message.bot.restrict_chat_member(
            message.chat.id, target, permissions=MUTED, until_date=_parse_duration(dur_txt))
        await record(message.bot, settings, chat_id=message.chat.id, user_id=target,
                     action=f"MUTE {dur_txt}", by_user=message.from_user.id if message.from_user else 0,
                     chat_title=message.chat.title or "")
        await message.reply(f"🔇 Muted <code>{target}</code> for {dur_txt}.")
    except Exception as e:  # noqa: BLE001
        await message.reply(f"Failed (am I admin with restrict rights?): {e}")


@router.message(Command("unmute"))
async def unmute(message: Message, settings: Settings) -> None:
    if message.chat is None or message.bot is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Reply to a user: /unmute (reply)")
        return
    try:
        await message.bot.restrict_chat_member(message.chat.id, target, permissions=OPEN)
        await message.reply(f"🔊 Unmuted <code>{target}</code>.")
    except Exception as e:  # noqa: BLE001
        await message.reply(f"Failed: {e}")


@router.message(Command("kick"))
async def kick(message: Message, settings: Settings) -> None:
    if message.chat is None or message.bot is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Reply to a user: /kick (reply)")
        return
    try:
        await message.bot.ban_chat_member(message.chat.id, target)
        await message.bot.unban_chat_member(message.chat.id, target)
        await record(message.bot, settings, chat_id=message.chat.id, user_id=target,
                     action="KICK", by_user=message.from_user.id if message.from_user else 0,
                     chat_title=message.chat.title or "")
        await message.reply(f"👢 Kicked <code>{target}</code>.")
    except Exception as e:  # noqa: BLE001
        await message.reply(f"Failed: {e}")


@router.message(Command("ban"))
async def ban(message: Message, settings: Settings) -> None:
    if message.chat is None or message.bot is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Reply to a user: /ban (reply)")
        return
    try:
        await message.bot.ban_chat_member(message.chat.id, target)
        await record(message.bot, settings, chat_id=message.chat.id, user_id=target,
                     action="BAN", by_user=message.from_user.id if message.from_user else 0,
                     chat_title=message.chat.title or "")
        await message.reply(f"⛔️ Banned <code>{target}</code>.")
    except Exception as e:  # noqa: BLE001
        await message.reply(f"Failed: {e}")


@router.message(Command("unban"))
async def unban(message: Message, settings: Settings) -> None:
    if message.chat is None or message.bot is None or not await _require_admin(message, settings):
        return
    target = _target_from_reply(message)
    if not target:
        await message.reply("Usage: /unban <user_id>")
        return
    try:
        await message.bot.unban_chat_member(message.chat.id, target)
        await message.reply(f"✅ Unbanned <code>{target}</code>.")
    except Exception as e:  # noqa: BLE001
        await message.reply(f"Failed: {e}")


@router.message(Command("warns"))
async def warns(message: Message, settings: Settings) -> None:
    if message.chat is None:
        return
    target = _target_from_reply(message) or (message.from_user.id if message.from_user else None)
    if not target:
        return
    c = await get_warnings(settings.db_path, message.chat.id, target)
    await message.reply(f"User <code>{target}</code> has {c} warn(s).")


@router.message(Command("stats"))
async def stats(message: Message, settings: Settings) -> None:
    from app.database import action_counts

    counts = await action_counts(settings.db_path)
    if not counts:
        await message.reply("No moderation actions yet.")
        return
    lines = "\n".join(f"{k}: {v}" for k, v in sorted(counts.items()))
    await message.reply(f"📊 <b>Moderation stats</b>\n{lines}")
