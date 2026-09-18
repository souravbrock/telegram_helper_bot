"""Welcome messages + basic engagement commands."""
from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import Message

from app.config import Settings
from app.database import get_chat_settings, upsert_chat_settings

router = Router(name="engagement")


def _is_admin_ids(message: Message, settings: Settings) -> bool:
    return bool(message.from_user and message.from_user.id in settings.admin_ids)


async def _is_chat_admin(message: Message) -> bool:
    if message.chat is None or message.from_user is None:
        return False
    try:
        m = await message.chat.get_member(message.from_user.id)
        return m.status in ("administrator", "creator")
    except Exception:
        return False


@router.message(F.new_chat_members)
async def welcome(message: Message, settings: Settings) -> None:
    # Runs alongside captcha; sends the customizable welcome text.
    if not message.new_chat_members or message.chat is None:
        return
    cfg = await get_chat_settings(settings.db_path, message.chat.id)
    template = str(cfg.get("welcome_text") or "Welcome {mention}!")
    for user in message.new_chat_members:
        if user.is_bot:
            continue
        text = template.format(
            mention=f"<a href='tg://user?id={user.id}'>{user.full_name}</a>",
            title=message.chat.title or "the group",
            name=user.full_name,
        )
        await message.answer(text)


@router.message(Command("setwelcome"))
async def set_welcome(message: Message, settings: Settings) -> None:
    if message.chat is None or message.text is None:
        return
    if not (_is_admin_ids(message, settings) or await _is_chat_admin(message)):
        await message.reply("Only group admins can use this.")
        return
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2:
        await message.reply("Usage: /setwelcome Your welcome text (supports {mention}, {title}, {name})")
        return
    await upsert_chat_settings(settings.db_path, message.chat.id, welcome_text=parts[1])
    await message.reply("✅ Welcome message updated.")


@router.message(Command("poll"))
async def make_poll(message: Message) -> None:
    if message.chat is None or message.text is None or message.bot is None:
        return
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2 or ";" not in parts[1]:
        await message.reply("Usage: /poll Question?; Option 1; Option 2; [Option 3...]")
        return
    chunks = [c.strip() for c in parts[1].split(";") if c.strip()]
    if len(chunks) < 3:
        await message.reply("Need a question + at least 2 options separated by ';'.")
        return
    await message.bot.send_poll(message.chat.id, question=chunks[0][:300], options=chunks[1:10])


@router.message(Command("help", "start"))
async def help_cmd(message: Message) -> None:
    await message.answer(
        "🤖 <b>Group Assistant (MVP)</b>\n\n"
        "Moderation: auto-deletes spam links/forwards/flood, warns then mutes/kicks/bans.\n"
        "Security: math captcha for new members.\n\n"
        "<b>Admin commands</b>\n"
        "/warn (reply) — warn user\n"
        "/unwarn (reply) — clear warns\n"
        "/mute 10m (reply) / /unmute (reply)\n"
        "/kick (reply) / /ban (reply) / /unban &lt;user_id&gt;\n"
        "/setwelcome text — set welcome\n"
        "/poll Q?; A; B — quick poll\n"
        "/stats — moderation stats\n\n"
        "Add me as admin with delete + restrict rights."
    )
