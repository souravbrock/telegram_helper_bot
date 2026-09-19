'use strict';
/* Rose-style Connections: manage groups from DM, keeping groups clean.
 * - Every group update registers the group (title) in the store.
 * - /connect (group admin): link this group to your DM.
 * - DM: /start → My Groups → pick a group → full control panel in DM.
 * - Panel callbacks resolve the connected chat (see menu.js targetChat).
 * Register FIRST so group tracking runs before every other handler. */
const { InlineKeyboard } = require('grammy');
const store = require('../lib/store');
const { openPanel, isAdminChat } = require('./menu');

function inGroupChat(ctx) {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

async function memberStatus(bot, chatId, userId) {
  try {
    return (await bot.api.getChatMember(chatId, userId)).status;
  } catch {
    return null; // bot removed / group gone / user unknown
  }
}

function register(bot) {
  // Track every group the bot sees (titles stay fresh for the DM list).
  bot.use(async (ctx, next) => {
    try {
      if (inGroupChat(ctx)) store.trackGroup(ctx.chat.id, ctx.chat.title);
    } catch { /* never break updates */ }
    return next();
  });

  bot.command('connect', async (ctx) => {
    if (!inGroupChat(ctx)) return ctx.reply('Use /connect inside the group you want to manage from DM.');
    if (!(await isAdminChat(bot, ctx.chat.id, ctx.from.id))) return ctx.reply('Only group admins can connect it.');
    store.setConnection(ctx.from.id, ctx.chat.id);
    const me = await bot.api.getMe().catch(() => null);
    const kb = me
      ? new InlineKeyboard().url('📩 Open control panel in DM', `https://t.me/${me.username}`)
      : undefined;
    await ctx.reply(
      `🔗 <b>${ctx.chat.title}</b> connected to your DM.\nMessage me privately — /start → My Groups — and manage it without spamming the group.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.command('disconnect', async (ctx) => {
    store.dropConnection(ctx.from.id);
    await ctx.reply('🔌 Disconnected. /start → My Groups to link another group.');
  });

  bot.callbackQuery(/^conn:/, async (ctx) => {
    try {
      if (ctx.chat?.type !== 'private') {
        await ctx.answerCallbackQuery({ text: 'Use this in private chat with me.' });
        return;
      }
      const parts = (ctx.callbackQuery.data || '').split(':');
      const sub = parts[1];
      const arg = parts.slice(2).join(':');
      const answer = (t) => ctx.answerCallbackQuery({ text: t }).catch(() => {});
      const show = async (text, kb) => {
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
        }
      };

      if (sub === 'list') {
        const groups = store.getGroups();
        const kb = new InlineKeyboard();
        let n = 0;
        for (const g of groups) {
          const [mine, bots] = await Promise.all([
            memberStatus(bot, g.chatId, ctx.from.id),
            memberStatus(bot, g.chatId, ctx.me.id),
          ]);
          if (!bots) { store.untrackGroup(g.chatId); continue; } // bot left: forget it
          if (mine !== 'administrator' && mine !== 'creator') continue; // not your group to manage
          const cur = store.getConnection(ctx.from.id) === g.chatId ? ' ✅' : '';
          kb.text(`${g.title}${cur}`.slice(0, 60), `conn:sel:${g.chatId}`).row();
          if (++n >= 15) break;
        }
        if (!n) {
          await show(
            '🔗 <b>No manageable groups found.</b>\n\nAdd me to a group as admin (delete + restrict rights), make sure you are admin there, send any message in it, then come back.',
            new InlineKeyboard().text('⬅️ Modules', 'help:HOME')
          );
          return;
        }
        kb.text('⬅️ Modules', 'help:HOME');
        await show('🔗 <b>Your groups</b> — pick one to manage from here:', kb);
        return;
      }

      if (sub === 'sel') {
        const chatId = Number(arg);
        if (!(await isAdminChat(bot, chatId, ctx.from.id))) {
          await ctx.answerCallbackQuery({ text: 'You are not admin there (anymore).', show_alert: true });
          return;
        }
        store.setConnection(ctx.from.id, chatId);
        await answer('Connected');
        try { await ctx.deleteMessage(); } catch {}
        await openPanel(ctx, chatId);
        return;
      }

      if (sub === 'menu') {
        const chatId = store.getConnection(ctx.from.id);
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: 'Pick a group first.', show_alert: true });
          return;
        }
        if (!(await isAdminChat(bot, chatId, ctx.from.id))) {
          await ctx.answerCallbackQuery({ text: 'You are not admin there (anymore).', show_alert: true });
          return;
        }
        try { await ctx.deleteMessage(); } catch {}
        await openPanel(ctx, chatId);
        return;
      }

      if (sub === 'disc') {
        store.dropConnection(ctx.from.id);
        await show('🔌 Disconnected.', new InlineKeyboard().text('🔗 My Groups', 'conn:list'));
        return;
      }

      await answer('Unknown button');
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });
}

module.exports = { register };
