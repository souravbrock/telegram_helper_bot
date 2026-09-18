'use strict';
const store = require('./store');

function cfg() {
  return {
    logChannel: (process.env.LOG_CHANNEL_ID || '').trim(),
  };
}

async function record(bot, { chatId, userId, action, reason = '', byUser = 0, chatTitle = '' }) {
  store.logAction(chatId, userId, action, reason, byUser);
  const { logChannel } = cfg();
  if (!logChannel) return;
  try {
    await bot.api.sendMessage(
      logChannel,
      `🛡 <b>${action}</b>\nGroup: ${chatTitle || chatId} (<code>${chatId}</code>)\nUser: <code>${userId}</code>\nBy: <code>${byUser}</code>\nReason: ${reason || '-'}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.warn('modlog send failed:', e.message);
  }
}

module.exports = { record };
