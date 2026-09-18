"""Math captcha for new members: restrict until they press the right button."""
from __future__ import annotations

import asyncio
import logging
import random

from aiogram import F, Router
from aiogram.types import CallbackQuery, ChatPermissions, Message
from aiogram.utils.keyboard import InlineKeyboardBuilder

from app.config import Settings
from app.database import get_chat_settings
from app.services.modlog import record

log = logging.getLogger(__name__)
router = Router(name="security")

MUTED = ChatPermissions(
    can_send_messages=False,
    can_send_media_messages=False,
    can_send_other_messages=False,
    can_add_web_page_previews=False,
)
OPEN = ChatPermissions(
    can_send_messages=True,
    can_send_media_messages=True,
    can_send_other_messages=True,
    can_add_web_page_previews=True,
)


def _captcha_kb(chat_id: int, user_id: int, correct: int) -> InlineKeyboardBuilder:
    kb = InlineKeyboardBuilder()
    options = {correct}
    while len(options) < 4:
        options.add(correct + random.randint(-8, 8))
    opts = [o for o in options if o != correct]
    random.shuffle(opts)
    opts = ([correct] + opts)[:4]
    random.shuffle(opts)
    for o in opts:
        mark = "✅" if o == correct else "❌"
        kb.button(text=f"{mark} {o}", callback_data=f"captcha:{chat_id}:{user_id}:{o}:{correct}")
    kb.adjust(2)
    return kb


@router.message(F.new_chat_members)
async def on_join(message: Message, settings: Settings) -> None:
    if not message.new_chat_members or message.chat is None:
        return
    cfg = await get_chat_settings(settings.db_path, message.chat.id)
    if not int(cfg.get("captcha_enabled", 1)):
        return
    bot = message.bot
    assert bot is not None
    for user in message.new_chat_members:
        if user.is_bot:
            continue
        a, b = random.randint(1, 9), random.randint(1, 9)
        correct = a + b
        try:
            await bot.restrict_chat_member(message.chat.id, user.id, permissions=MUTED)
        except Exception as e:  # noqa: BLE001 - needs admin
            log.warning("restrict failed (bot admin?): %s", e)
            return
        kb = _captcha_kb(message.chat.id, user.id, correct)
        prompt = await message.answer(
            f"👋 Welcome <a href='tg://user?id={user.id}'>{user.full_name}</a>!\n"
            f"Solve to verify you're human: <b>{a} + {b} = ?</b>\n"
            f"You have {settings.CAPTCHA_TIMEOUT_SEC}s.",
            reply_markup=kb.as_markup(),
        )
        await record(bot, settings, chat_id=message.chat.id, user_id=user.id,
                     action="CAPTCHA_SENT", reason=f"{a}+{b}",
                     chat_title=message.chat.title or "")
        asyncio.create_task(_captcha_timeout(bot, settings, message.chat.id, user.id, prompt.message_id))


async def _captcha_timeout(bot, settings: Settings, chat_id: int, user_id: int, prompt_id: int) -> None:
    await asyncio.sleep(settings.CAPTCHA_TIMEOUT_SEC)
    try:
        member = await bot.get_chat_member(chat_id, user_id)
        if member.status == "restricted" and member.can_send_messages is False:
            await bot.ban_chat_member(chat_id, user_id)
            await bot.unban_chat_member(chat_id, user_id)
            await bot.send_message(chat_id, f"⏰ User <code>{user_id}</code> removed: captcha timeout.")
            await record(bot, settings, chat_id=chat_id, user_id=user_id,
                         action="KICK", reason="captcha timeout")
        try:
            await bot.delete_message(chat_id, prompt_id)
        except Exception:
            pass
    except Exception as e:  # noqa: BLE001
        log.debug("captcha timeout check: %s", e)


@router.callback_query(F.data.startswith("captcha:"))
async def on_captcha_answer(query: CallbackQuery, settings: Settings) -> None:
    assert query.data and query.message and query.from_user
    try:
        _, chat_s, user_s, picked_s, correct_s = query.data.split(":")
        chat_id, target, picked, correct = int(chat_s), int(user_s), int(picked_s), int(correct_s)
    except ValueError:
        await query.answer("Invalid button.", show_alert=True)
        return
    bot = query.bot
    assert bot is not None
    if query.from_user.id != target:
        await query.answer("This captcha is not for you.", show_alert=True)
        return
    if picked == correct:
        try:
            await bot.restrict_chat_member(chat_id, target, permissions=OPEN)
        except Exception as e:  # noqa: BLE001
            await query.answer(f"Failed to unrestrict: {e}", show_alert=True)
            return
        await record(bot, settings, chat_id=chat_id, user_id=target, action="CAPTCHA_PASSED")
        await query.answer("Verified! Welcome 🎉")
        try:
            await query.message.delete()
        except Exception:
            pass
        await bot.send_message(chat_id, f"✅ <a href='tg://user?id={target}'>Verified human</a>, welcome!")
    else:
        await query.answer("Wrong answer, try the other button.", show_alert=True)
