'use strict';
/* Math captcha for new members. */
const { InlineKeyboard } = require('grammy');
const store = require('../lib/store');
const { record } = require('../lib/modlog');

const MUTED = { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false };
const OPEN = { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true };

const pending = new Map(); // "chat:user" -> timeout

function register(bot) {
  bot.on('message:new_chat_members', async (ctx) => {
    try {
      const timeout = parseInt(process.env.CAPTCHA_TIMEOUT_SEC || '90', 10);
      for (const user of ctx.msg.new_chat_members || []) {
        if (user.is_bot) continue;
        const chatCfg = store.getChat(ctx.chat.id, { warnLimit: 3, allowLinks: false });
        if (!Number(chatCfg.captcha_enabled ?? 1)) continue;

        try {
          await ctx.restrictChatMember(user.id, MUTED);
        } catch (err) {
          console.warn('restrict failed (bot admin?):', err.message);
          continue;
        }

        const a = 1 + Math.floor(Math.random() * 9);
        const b = 1 + Math.floor(Math.random() * 9);
        const correct = a + b;
        const opts = new Set([correct]);
        while (opts.size < 4) {
          const v = correct + Math.floor(Math.random() * 17) - 8;
          if (v !== correct) opts.add(v);
        }
        const arr = [...opts].sort(() => Math.random() - 0.5);
        const kb = new InlineKeyboard();
        arr.forEach((o, i) => {
          kb.text(`${o === correct ? '✅' : '❌'} ${o}`, `captcha:${ctx.chat.id}:${user.id}:${o}:${correct}`);
          if (i % 2 === 1) kb.row();
        });

        // Welcome text (customizable)
        const tpl = chatCfg.welcome_text || 'Welcome {mention}!';
        const mention = `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
        await ctx.reply(
          tpl.replaceAll('{mention}', mention).replaceAll('{title}', ctx.chat.title || '').replaceAll('{name}', user.first_name || ''),
          { parse_mode: 'HTML' }
        );

        const prompt = await ctx.reply(
          `👋 ${mention}, solve to verify: <b>${a} + ${b} = ?</b>\nYou have ${timeout}s.`,
          { parse_mode: 'HTML', reply_markup: kb }
        );
        await record(bot, { chatId: ctx.chat.id, userId: user.id, action: 'CAPTCHA_SENT', reason: `${a}+${b}`, chatTitle: ctx.chat.title });

        const k = `${ctx.chat.id}:${user.id}`;
        if (pending.has(k)) clearTimeout(pending.get(k));
        pending.set(k, setTimeout(async () => {
          try {
            const m = await ctx.api.getChatMember(ctx.chat.id, user.id);
            if (m.status === 'restricted' && m.can_send_messages === false) {
              await ctx.banChatMember(user.id);
              await ctx.unbanChatMember(user.id);
              await ctx.api.sendMessage(ctx.chat.id, `⏰ User <code>${user.id}</code> removed: captcha timeout.`, { parse_mode: 'HTML' });
              await record(bot, { chatId: ctx.chat.id, userId: user.id, action: 'KICK', reason: 'captcha timeout', chatTitle: ctx.chat.title });
            }
            try { await ctx.api.deleteMessage(ctx.chat.id, prompt.message_id); } catch {}
          } catch (e) { console.warn('captcha timeout:', e.message); }
          pending.delete(k);
        }, timeout * 1000));
      }
    } catch (err) {
      console.error('captcha error:', err);
    }
  });

  bot.callbackQuery(/^captcha:/, async (ctx) => {
    try {
      const [, chatS, userS, pickedS, correctS] = (ctx.callbackQuery.data || '').split(':');
      const chatId = Number(chatS), target = Number(userS), picked = Number(pickedS), correct = Number(correctS);
      if (ctx.from.id !== target) return ctx.answerCallbackQuery({ text: 'This captcha is not for you.', show_alert: true });
      if (picked === correct) {
        await ctx.api.restrictChatMember(chatId, target, OPEN);
        pending.delete(`${chatId}:${target}`);
        await record(ctx, { chatId, userId: target, action: 'CAPTCHA_PASSED' });
        await ctx.answerCallbackQuery({ text: 'Verified! Welcome 🎉' });
        try { await ctx.deleteMessage(); } catch {}
        await ctx.api.sendMessage(chatId, `✅ <a href="tg://user?id=${target}">Verified human</a>, welcome!`, { parse_mode: 'HTML' });
      } else {
        await ctx.answerCallbackQuery({ text: 'Wrong answer, try the other button.', show_alert: true });
      }
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });
}

module.exports = { register };
