process.env.DB_FILE = '/home/botdeploy/telegram_helper_bot/node-bot/lib/data.json';
const store = require('/home/botdeploy/telegram_helper_bot/node-bot/lib/store.js');
const out = store.chatsWithSchedules().map((x) => ({
  chat: x.chatId,
  n: x.schedules.length,
  items: x.schedules.map((y) => ({ id: y.id, every: y.every, nextInSec: Math.round((y.next - Date.now()) / 1000), hasText: Boolean(y.text), srcMsg: y.srcMsg || null })),
}));
console.log(JSON.stringify(out, null, 1));
