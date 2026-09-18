'use strict';
/* 1-to-1 DM verification: the group shows only a Verify button;
 * the math captcha happens in a private chat with the bot.
 * Flow: join -> restrict + button msg -> user taps (DM opens, /start payload)
 * -> math quiz in DM -> pass: unrestrict + welcome (auto-deleted);
 * timeout: kick + cleanup. Join/leave traces are deleted for privacy. */
const { InlineKeyboard } = require('grammy');
const store = require('../lib/store');
const { record } = require('../lib/modlog');

const MUTED = { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false };
const OPEN = { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true };

const pending = new Map(); // "chat:user" -> { timer, buttonId }

let cachedUsername = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
async function botUsername(bot) {
  if (!cachedUsername) {
    try {
      cachedUsername = ((await bot.api.getMe()).username || '').replace(/^@/, '');
    } catch { /* ignore */ }
  }
  return cachedUsername;
}

// Privacy: bot notices auto-expire (names stay out of history).
function welcomeTtl() { return parseInt(process.env.WELCOME_DELETE_SEC || '60', 10); }
function verifiedTtl() { return parseInt(process.env.VERIFIED_DELETE_SEC || '30', 10); }

function autodelete(api, chatId, msgId, afterSec) {
  if (!afterSec || afterSec <= 0 || !msgId) return;
  setTimeout(async () => {
    try { await api.deleteMessage(chatId, msgId); } catch {}
  }, afterSec * 1000);
}

function quizKeyboard(chatId, userId, correct) {
  const opts = new Set([correct]);
  while (opts.size < 4) {
    const v = correct + Math.floor(Math.random() * 17) - 8;
    if (v !== correct) opts.add(v);
  }
  const kb = new InlineKeyboard();
  [...opts].sort(() => Math.random() - 0.5).forEach((o, i) => {
    kb.text(`${o === correct ? '✅' : '❌'} ${o}`, `captcha:${chatId}:${userId}:${o}:${correct}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

async function cleanupPending(bot, chatId, userId) {
  const k = `${chatId}:${userId}`;
  const p = pending.get(k);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(k);
  try { await bot.api.deleteMessage(chatId, p.buttonId); } catch {}
}

function register(bot) {
  // Exit traces vanish immediately.
  bot.on('message:left_chat_member', async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { console.warn('delete leave-msg failed:', e.message); }
  });

  bot.on('message:new_chat_members', async (ctx) => {
    // Join traces vanish immediately.
    try { await ctx.deleteMessage(); } catch (e) { console.warn('delete join-msg failed:', e.message); }
    try {
      const timeout = parseInt(process.env.CAPTCHA_TIMEOUT_SEC || '90', 10);
      const username = await botUsername(bot);
      if (!username) {
        console.warn('BOT_USERNAME missing and getMe failed — cannot issue verify buttons');
        return;
      }
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

        const mention = `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
        const btn = await ctx.reply(
          `👋 ${mention}, tap below to verify yourself within ${timeout}s.\nVerification happens in private — nothing is asked in the group.`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().url('✅ Verify', `https://t.me/${username}?start=verify_${ctx.chat.id}_${user.id}`),
          }
        );
        await record(bot, { chatId: ctx.chat.id, userId: user.id, action: 'CAPTCHA_SENT', chatTitle: ctx.chat.title });

        const k = `${ctx.chat.id}:${user.id}`;
        if (pending.has(k)) {
          clearTimeout(pending.get(k).timer);
          pending.delete(k);
        }
        const timer = setTimeout(async () => {
          pending.delete(k);
          try { await bot.api.deleteMessage(ctx.chat.id, btn.message_id); } catch {}
          try {
            const m = await bot.api.getChatMember(ctx.chat.id, user.id);
            if (m.status === 'restricted' && m.can_send_messages === false) {
              await bot.api.banChatMember(ctx.chat.id, user.id);
              await bot.api.unbanChatMember(ctx.chat.id, user.id);
              const gone = await bot.api.sendMessage(ctx.chat.id, `⏰ Unverified user removed (timeout).`, { parse_mode: 'HTML' });
              autodelete(bot.api, ctx.chat.id, gone.message_id, verifiedTtl());
              await record(bot, { chatId: ctx.chat.id, userId: user.id, action: 'KICK', reason: 'captcha timeout', chatTitle: ctx.chat.title });
            }
          } catch (e) { console.warn('captcha timeout:', e.message); }
        }, timeout * 1000);
        pending.set(k, { timer, buttonId: btn.message_id });
      }
    } catch (err) {
      console.error('captcha error:', err);
    }
  });

  // Deep link from the Verify button -> math quiz in DM.
  bot.command('start', async (ctx) => {
    const payload = ((ctx.msg.text || '').split(' ')[1] || '').trim();
    const m = /^verify_(-?\d+)_(\d+)$/.exec(payload);
    if (!m) {
      return ctx.reply(
        '🤖 <b>Group Assistant</b>\nAdd me to a group as admin and I handle spam, verification, welcomes and polls.\n\nType /help in the group for commands.',
        { parse_mode: 'HTML' }
      );
    }
    if (ctx.chat.type !== 'private') return; // button always opens DM
    const chatId = Number(m[1]);
    const target = Number(m[2]);
    if (ctx.from.id !== target) return ctx.reply('This verification link is for another user.');
    if (!pending.has(`${chatId}:${target}`)) return ctx.reply('No pending verification found (expired or already done).');

    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    await ctx.reply(`🔒 To join the group, solve: <b>${a} + ${b} = ?</b>`, {
      parse_mode: 'HTML',
      reply_markup: quizKeyboard(chatId, target, a + b),
    });
  });

  bot.callbackQuery(/^captcha:/, async (ctx) => {
    try {
      const [, chatS, userS, pickedS, correctS] = (ctx.callbackQuery.data || '').split(':');
      const chatId = Number(chatS);
      const target = Number(userS);
      const picked = Number(pickedS);
      const correct = Number(correctS);
      if (ctx.from.id !== target) {
        await ctx.answerCallbackQuery({ text: 'This captcha is not for you.', show_alert: true });
        return;
      }
      if (picked !== correct) {
        await ctx.answerCallbackQuery({ text: 'Wrong answer, try again.', show_alert: true });
        return;
      }
      try {
        await ctx.api.restrictChatMember(chatId, target, OPEN);
      } catch (e) {
        await ctx.answerCallbackQuery({ text: 'Verified, but unrestrict failed — ask a group admin.', show_alert: true });
        return;
      }
      await cleanupPending(bot, chatId, target);
      await record(ctx, { chatId, userId: target, action: 'CAPTCHA_PASSED' });
      await ctx.answerCallbackQuery({ text: 'Verified! Welcome 🎉' });
      try { await ctx.deleteMessage(); } catch {} // remove the DM quiz
      await ctx.reply('✅ Verified! You can now chat in the group.');

      // Welcome lands in the group only for verified humans, then expires.
      try {
        const chatCfg = store.getChat(chatId, { warnLimit: 3, allowLinks: false });
        const tpl = chatCfg.welcome_text || 'Welcome {mention}!';
        const mention = `<a href="tg://user?id=${target}">${ctx.from.first_name}</a>`;
        let title = '';
        try { title = (await ctx.api.getChat(chatId)).title || ''; } catch {}
        const w = await ctx.api.sendMessage(
          chatId,
          tpl.replaceAll('{mention}', mention).replaceAll('{title}', title).replaceAll('{name}', ctx.from.first_name || ''),
          { parse_mode: 'HTML' }
        );
        autodelete(ctx.api, chatId, w.message_id, welcomeTtl());
      } catch (e) { console.warn('welcome failed:', e.message); }
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });
}

module.exports = { register };
