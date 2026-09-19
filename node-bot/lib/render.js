'use strict';
/* Shared rendering for notes/filters/welcomes: {variables} + [buttons](url).
 * Variables: {first} {last} {fullname} {username} {mention} {id} {chatname} */
const { InlineKeyboard } = require('grammy');

function fillVars(raw, user = {}, chatTitle = '') {
  const first = user.first_name || 'there';
  const last = user.last_name || '';
  const mention = `<a href="tg://user?id=${user.id || 0}">${first}</a>`;
  return String(raw || '')
    .replaceAll('{first}', first)
    .replaceAll('{last}', last)
    .replaceAll('{fullname}', `${first}${last ? ' ' + last : ''}`.trim())
    .replaceAll('{username}', user.username ? `@${user.username}` : first)
    .replaceAll('{mention}', mention)
    .replaceAll('{id}', String(user.id ?? ''))
    .replaceAll('{chatname}', chatTitle || '');
}

function parseButtons(raw) {
  const buttons = [];
  const text = String(raw || '').replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    if (buttons.length < 20) buttons.push({ label: label.slice(0, 60), url });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  if (!buttons.length) return { text, keyboard: undefined };
  const kb = new InlineKeyboard();
  buttons.forEach((b, i) => {
    kb.url(b.label, b.url);
    if (i % 2 === 1) kb.row();
  });
  return { text, keyboard: kb };
}

function targetOf(ctx) {
  return {
    id: ctx.from?.id,
    first_name: ctx.from?.first_name,
    last_name: ctx.from?.last_name,
    username: ctx.from?.username,
  };
}

/* Send a stored content object { kind, fileId, text }. Falls back to plain
 * text if HTML/media send fails. Returns the sent message. */
async function sendContent(api, chatId, content, user, chatTitle, replyTo) {
  const filled = fillVars(content.text || '', user, chatTitle);
  const { text, keyboard } = parseButtons(filled);
  const base = { reply_markup: keyboard };
  if (replyTo) base.reply_to_message_id = replyTo;
  try {
    switch (content.kind) {
      case 'photo': return await api.sendPhoto(chatId, content.fileId, { ...base, caption: text || undefined, parse_mode: 'HTML' });
      case 'video': return await api.sendVideo(chatId, content.fileId, { ...base, caption: text || undefined, parse_mode: 'HTML' });
      case 'animation': return await api.sendAnimation(chatId, content.fileId, { ...base, caption: text || undefined, parse_mode: 'HTML' });
      case 'document': return await api.sendDocument(chatId, content.fileId, { ...base, caption: text || undefined, parse_mode: 'HTML' });
      case 'audio': return await api.sendAudio(chatId, content.fileId, { ...base, caption: text || undefined, parse_mode: 'HTML' });
      case 'voice': return await api.sendVoice(chatId, content.fileId, { ...base, caption: text || undefined, parse_mode: 'HTML' });
      case 'video_note': return await api.sendVideoNote(chatId, content.fileId, base);
      case 'sticker': return await api.sendSticker(chatId, content.fileId, base);
      default: return await api.sendMessage(chatId, text || '(empty note)', { ...base, parse_mode: 'HTML' });
    }
  } catch {
    return api.sendMessage(chatId, (content.text || '(empty note)').replace(/<[^>]*>/g, ''), replyTo ? { reply_to_message_id: replyTo } : {});
  }
}

module.exports = { fillVars, parseButtons, targetOf, sendContent };
