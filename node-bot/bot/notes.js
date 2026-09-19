'use strict';
/* Rose-style Notes + Filters.
 * Notes:  /save <name> (reply to msg, or with text) | #name or /get <name>
 *         /notes | /clear <name> | /clearall (button confirm)
 * Filters: /filter <keyword> <text|reply> | auto-reply on keyword
 *         /filters | /stop <keyword> | /stopall (button confirm)
 * Content keeps media + caption; [Label](url) becomes inline buttons;
 * {first}/{username}/{mention}/... are filled in per user.
 * Management = admins; recall/list = everyone. Registered AFTER moderation
 * so deleted spam never triggers a filter reply. */
const { InlineKeyboard } = require('grammy');
const store = require('../lib/store');
const antispam = require('../lib/antispam');
const { parseCsv } = require('../lib/lists');
const { targetOf, sendContent } = require('../lib/render');

const NAME_RE = /^[a-z0-9_]{1,32}$/;

function adminIds() {
  return new Set((process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
}

async function isAdmin(ctx) {
  if (ctx.from && adminIds().has(ctx.from.id)) return true;
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

function inGroup(ctx) {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

/* Capture replied message as storable content (media-aware). */
function capture(replied) {
  if (!replied) return null;
  if (replied.photo?.length) return { kind: 'photo', fileId: replied.photo.at(-1).file_id, text: replied.caption || '' };
  for (const k of ['video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker']) {
    if (replied[k]) {
      const fileId = replied[k].file_id || replied[k];
      return { kind: k, fileId, text: replied.caption || '' };
    }
  }
  const text = replied.text || replied.caption || '';
  return text ? { kind: 'text', text } : null;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(text, kw, cs) {
  if (!text || !kw) return false;
  if (cs) return text.includes(kw); // case-sensitive, exact
  if (/\s/.test(kw)) return text.toLowerCase().includes(kw.toLowerCase());
  return new RegExp(`\\b${escRe(kw)}\\b`, 'i').test(text);
}

/* Skip filter replies on messages our own spam rules would delete. */
function looksLikeSpam(ctx) {
  const e = {
    floodLimit: parseInt(process.env.FLOOD_LIMIT || '5', 10),
    floodWindow: parseInt(process.env.FLOOD_WINDOW_SEC || '10', 10),
    allowLinks: (process.env.ALLOW_LINKS || 'false') === 'true',
    whitelist: new Set((process.env.WHITELIST_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    blacklist: new Set((process.env.BLACKLIST_WORDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  };
  const chatCfg = store.getChat(ctx.chat.id, { warnLimit: 3, allowLinks: e.allowLinks });
  const text = ctx.msg.text || ctx.msg.caption || '';
  const entities = [...(ctx.msg.entities || []), ...(ctx.msg.caption_entities || [])];
  const v = antispam.check({
    chatId: ctx.chat.id, userId: ctx.from.id, text,
    hasUrlEntity: entities.some((x) => x.type === 'url' || x.type === 'text_link'),
    isForward: Boolean(ctx.msg.forward_date || ctx.msg.forward_from_chat),
    allowLinks: Boolean(chatCfg.allow_links) || e.allowLinks,
    whitelist: new Set([...e.whitelist, ...parseCsv(chatCfg.whitelist_domains)]),
    blacklist: new Set([...e.blacklist, ...parseCsv(chatCfg.blacklist_words)]),
    floodLimit: e.floodLimit, floodWindow: e.floodWindow,
  });
  return v.isSpam;
}

function describe(c) {
  if (!c) return '';
  if (c.kind === 'text') return (c.text || '').slice(0, 40) || '(empty)';
  return `${c.kind}${c.text ? `: ${(c.text || '').slice(0, 30)}` : ''}`;
}

function notesView(chatId) {
  const names = Object.keys(store.getNotes(chatId)).sort();
  const kb = new InlineKeyboard();
  for (const n of names) kb.text(`❌ #${n}`, `menu:note_del:${n}`).row();
  if (names.length) kb.text('🗑 Clear ALL', 'menu:notes_wipe').row();
  kb.text('⬅️ Back', 'menu:main').text('🗑 Close', 'menu:close');
  return { text: `📝 <b>Notes</b> (${names.length})\n${names.map((n) => `#${n}`).join(' ') || '(none — /save name while replying)'}`, kb };
}

function filtersView(chatId) {
  const all = store.getFilters(chatId);
  const kws = Object.keys(all).sort();
  const kb = new InlineKeyboard();
  kb.text('➕ New smart reply', 'ar:new').row();
  for (const k of kws) kb.text(`❌ ${k}${all[k]?.cs ? ' [Aa]' : ''}`.slice(0, 60), `menu:filter_del:${k.slice(0, 47)}`).row();
  if (kws.length) kb.text('🗑 Stop ALL', 'menu:filters_wipe').row();
  kb.text('⬅️ Back', 'menu:main').text('🗑 Close', 'menu:close');
  return { text: `💬 <b>Filters</b> (${kws.length})\n${kws.map((k) => `<code>${k}</code>${all[k]?.cs ? ' [case-sensitive]' : ''}`).join(' ') || '(none — /filter keyword + reply, or ➕ New smart)'}`, kb };
}

async function show(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

function register(bot) {
  const guard = (fn) => async (ctx) => {
    if (!inGroup(ctx)) return ctx.reply('Use this in the group.');
    if (!(await isAdmin(ctx))) return ctx.reply('Only admins can use this.');
    return fn(ctx);
  };

  // ---------- Notes ----------
  bot.command('save', guard(async (ctx) => {
    const args = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().split(/\s+/);
    const name = (args[0] || '').toLowerCase();
    if (!NAME_RE.test(name)) return ctx.reply('Usage: /save <name> (reply to a message, or /save name some text). Lowercase letters/numbers/_ only.');
    const replied = ctx.msg.reply_to_message;
    let content = capture(replied);
    const trailing = args.slice(1).join(' ').slice(0, 2000);
    if (trailing && (!content || content.kind === 'text')) {
      content = { kind: content?.kind || 'text', fileId: content?.fileId, text: trailing };
    } else if (trailing && content) {
      content = { ...content, text: trailing }; // new caption for saved media
    }
    if (!content) return ctx.reply('Reply to a message to save it, or add text: /save rules Be nice.');
    store.saveNote(ctx.chat.id, name, content);
    const keys = Object.keys(store.getNotes(ctx.chat.id)).length;
    return ctx.reply(`📝 Saved <b>#${name}</b> (${describe(content)}). ${keys} note(s) total. Recall with <code>#${name}</code>.`, { parse_mode: 'HTML' });
  }));

  async function recall(ctx, name) {
    const note = store.getNotes(ctx.chat.id)[name.toLowerCase()];
    if (!note) return;
    await sendContent(ctx.api, ctx.chat.id, note, targetOf(ctx), ctx.chat.title, ctx.msg.message_id);
  }

  bot.command('get', async (ctx) => {
    if (!inGroup(ctx)) return;
    const name = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (name) await recall(ctx, name);
  });

  bot.command('notes', async (ctx) => {
    if (!inGroup(ctx)) return;
    const names = Object.keys(store.getNotes(ctx.chat.id)).sort();
    await ctx.reply(names.length ? `📝 <b>Notes</b>\n${names.map((n) => `#${n}`).join('\n')}` : 'No notes yet. /save name while replying to a message.', { parse_mode: 'HTML' });
  });

  bot.command('clear', guard(async (ctx) => {
    const name = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (!name) return ctx.reply('Usage: /clear <name>');
    return ctx.reply(store.delNote(ctx.chat.id, name) ? `🗑 Note #${name} deleted.` : 'No such note.');
  }));

  bot.command('clearall', guard(async (ctx) => {
    const kb = new InlineKeyboard().text('✅ Yes, delete all', 'menu:notes_wipe_yes').text('❌ Cancel', 'menu:notes_wipe_no');
    await ctx.reply('Delete <b>ALL</b> notes in this group?', { parse_mode: 'HTML', reply_markup: kb });
  }));

  // ---------- Filters ----------
  bot.command('filter', guard(async (ctx) => {
    const parts = ((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim();
    const kw = parts.split(/\s+/)[0]?.toLowerCase();
    if (!kw || kw.length > 60) return ctx.reply('Usage: /filter <keyword> <reply text> — or /filter <keyword> while replying to media.');
    const trailing = parts.slice(kw.length).trim().slice(0, 2000);
    const replied = ctx.msg.reply_to_message;
    let content = capture(replied);
    if (trailing && (!content || content.kind === 'text')) {
      content = { kind: content?.kind || 'text', fileId: content?.fileId, text: trailing };
    } else if (trailing && content) {
      content = { ...content, text: trailing };
    }
    if (!content) return ctx.reply('Give reply content: /filter hello Hi there! (or reply to media).');
    store.saveFilter(ctx.chat.id, kw, { ...content, cs: 0 });
    return ctx.reply(`💬 Filter <code>${kw}</code> → ${describe(content)}.`, { parse_mode: 'HTML' });
  }));

  bot.command('filters', async (ctx) => {
    if (!inGroup(ctx)) return;
    const all = store.getFilters(ctx.chat.id);
    const kws = Object.keys(all).sort();
    await ctx.reply(kws.length ? `💬 <b>Filters</b>\n${kws.map((k) => `<code>${k}</code>${all[k]?.cs ? ' [Aa]' : ''}`).join('\n')}` : 'No filters yet. /filter or /autoreply.', { parse_mode: 'HTML' });
  });

  bot.command('stop', guard(async (ctx) => {
    const kw = (((ctx.msg.text || '').split(/ (.+)/)[1] || '').trim().toLowerCase());
    if (!kw) return ctx.reply('Usage: /stop <keyword>');
    return ctx.reply(store.delFilter(ctx.chat.id, kw) ? `🛑 Filter <code>${kw}</code> removed.` : 'No such filter.', { parse_mode: 'HTML' });
  }));

  bot.command('stopall', guard(async (ctx) => {
    const kb = new InlineKeyboard().text('✅ Yes, stop all', 'menu:filters_wipe_yes').text('❌ Cancel', 'menu:filters_wipe_no');
    await ctx.reply('Remove <b>ALL</b> filters in this group?', { parse_mode: 'HTML', reply_markup: kb });
  }));

  // ---------- Recall + auto-reply (runs after moderation) ----------
  bot.on('message:text', async (ctx, next) => {
    try {
      if (!inGroup(ctx) || !ctx.from || ctx.from.is_bot) return next();
      const text = ctx.msg.text || '';
      if (text.startsWith('/')) return next();

      const tag = /(^|\s)#([a-z0-9_]{1,32})/i.exec(text);
      if (tag) {
        await recall(ctx, tag[2]);
        return next();
      }

      const filters = store.getFilters(ctx.chat.id);
      const kws = Object.keys(filters);
      if (kws.length && !looksLikeSpam(ctx)) {
        const hit = kws.find((k) => matchesKeyword(text, k, filters[k]?.cs ? true : false));
        if (hit) {
          await sendContent(ctx.api, ctx.chat.id, filters[hit], targetOf(ctx), ctx.chat.title, ctx.msg.message_id);
        }
      }
      return next();
    } catch (err) {
      console.error('notes/filters error:', err);
    }
  });

  // ---------- Smart autoreply wizard: keyword → case choice → content → save.
  // Works in groups and DM connections. Replies carry text and/or media;
  // links work inline and as [Label](url) buttons. ----------
  const arwiz = new Map(); // "chat:user" -> { chat, step, kw, cs, content, promptId, at }
  const AR_TTL = 5 * 60 * 1000;

  function wizTarget(ctx) {
    if (ctx.chat?.type === 'private') return store.getConnection(ctx.from.id);
    return ctx.chat?.id;
  }

  async function wizAsk(ctx, entry, text, kb) {
    const p = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    entry.promptId = p.message_id;
    entry.at = Date.now();
  }

  async function arStart(ctx, chatId) {
    const entry = { chat: chatId, step: 'keyword', at: Date.now(), promptId: 0 };
    arwiz.set(`${ctx.chat.id}:${ctx.from.id}`, entry);
    await wizAsk(ctx, entry, '💬 <b>Smart reply 1/3 — keyword.</b> Reply to <b>this message</b> with the trigger phrase (e.g. <code>doctor</code>).');
  }

  bot.command('autoreply', async (ctx) => {
    const chatId = wizTarget(ctx);
    if (!chatId) return ctx.reply('Connect a group first: /start → My Groups.');
    const admin = ctx.chat?.type === 'private'
      ? await isAdminIn(bot, chatId, ctx.from.id)
      : await isAdmin(ctx);
    if (!admin) return ctx.reply('Only admins can use this.');
    await arStart(ctx, chatId);
  });

  bot.callbackQuery(/^ar:/, async (ctx) => {
    try {
      const data = (ctx.callbackQuery.data || '').slice('ar:'.length);
      const answer = (t) => ctx.answerCallbackQuery({ text: t }).catch(() => {});
      const k = `${ctx.chat.id}:${ctx.from.id}`;

      if (data === 'new') {
        let chatId = ctx.chat?.id;
        if (ctx.chat?.type === 'private') chatId = store.getConnection(ctx.from.id);
        if (!chatId) { await ctx.answerCallbackQuery({ text: 'Connect a group first.', show_alert: true }); return; }
        const admin = ctx.chat?.type === 'private'
          ? await isAdminIn(bot, chatId, ctx.from.id)
          : await isAdmin(ctx);
        if (!admin) { await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }); return; }
        await arStart(ctx, chatId);
        await answer('Reply to the prompt');
        return;
      }

      const entry = arwiz.get(k);
      if (!entry || Date.now() - entry.at > AR_TTL) {
        arwiz.delete(k);
        await answer('Wizard expired — start again.');
        return;
      }
      entry.at = Date.now();

      if (data === 'cs:1' || data === 'cs:0') {
        if (entry.step !== 'case') { await answer(' '); return; }
        entry.cs = data === 'cs:1' ? 1 : 0;
        if (!entry.cs) entry.kw = entry.kw.toLowerCase();
        entry.step = 'content';
        await wizAsk(ctx, entry, `💬 <b>Smart reply 3/3 — answer.</b> Reply to <b>this message</b> with the reply: text, photo/video/file, or both (caption = text). Links work inline or as <code>[Label](url)</code> buttons.`);
        try { await ctx.deleteMessage(); } catch {}
        await answer(data === 'cs:1' ? 'Case-SENSITIVE' : 'Case-insensitive');
        return;
      }

      if (data === 'save') {
        if (entry.step !== 'review') { await answer(' '); return; }
        store.saveFilter(entry.chat, entry.kw, { ...entry.content, cs: entry.cs ? 1 : 0 });
        arwiz.delete(k);
        try {
          await ctx.editMessageText(
            `✅ Smart reply saved: <code>${entry.kw}</code>${entry.cs ? ' [case-sensitive]' : ''} → ${describe(entry.content)}.\nTriggers like: <i>${entry.cs ? 'exact "' + entry.kw + '"' : 'any case "' + entry.kw.toLowerCase() + '" words'}</i>`,
            { parse_mode: 'HTML' }
          );
        } catch {}
        await answer('Saved');
        return;
      }

      if (data === 'cancel') {
        arwiz.delete(k);
        try { await ctx.editMessageText('🚫 Smart reply cancelled.'); } catch {}
        await answer('Cancelled');
        return;
      }
      await answer(' ');
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });

  // Wizard input consumer: keyword + content steps (text and media).
  bot.on('message', async (ctx, next) => {
    try {
      if (!ctx.from || ctx.from.is_bot) return next();
      const k = `${ctx.chat.id}:${ctx.from.id}`;
      const entry = arwiz.get(k);
      if (!entry) return next();
      if (Date.now() - entry.at > AR_TTL) { arwiz.delete(k); return next(); }
      if ((ctx.msg.text || '').startsWith('/')) return next();
      if (!ctx.msg.reply_to_message || ctx.msg.reply_to_message.message_id !== entry.promptId) return next();
      entry.at = Date.now();

      if (entry.step === 'keyword') {
        const kw = (ctx.msg.text || '').trim().slice(0, 60);
        if (!kw) { await ctx.reply('Send the trigger phrase as text.'); return; }
        entry.kw = kw; // case decided next step; lowercased then if insensitive
        entry.step = 'case';
        const kb = new InlineKeyboard()
          .text('🔠 Aa — exact case', 'ar:cs:1')
          .text('🔡 aa — any case', 'ar:cs:0');
        await wizAsk(ctx, entry, `💬 <b>Smart reply 2/3 — matching</b> for <code>${entry.kw}</code>.\nShould <code>${entry.kw}</code> match only this exact case?`, kb);
        try { await ctx.deleteMessage(); } catch {}
        return;
      }

      if (entry.step === 'content') {
        const c = capture(ctx.msg);
        if (!c || (!c.text && !c.fileId)) { await ctx.reply('Reply with text and/or media (photo, video, file).'); return; }
        entry.content = { kind: c.kind, fileId: c.fileId, text: (c.text || '').slice(0, 2000) };
        entry.step = 'review';
        const kb = new InlineKeyboard().text('✅ Save', 'ar:save').text('❌ Cancel', 'ar:cancel');
        await wizAsk(ctx, entry,
          `📝 <b>Review</b>\nTrigger: <code>${entry.kw}</code>${entry.cs ? ' [case-sensitive]' : ' [any case]'}\nReply: ${describe(entry.content)}\nSave?`, kb);
        try { await ctx.deleteMessage(); } catch {}
        return;
      }
      return next();
    } catch (err) {
      console.error('autoreply wizard error:', err);
    }
  });

  // ---------- Menu integration (delete + wipe prompts; _yes/_no handled below) ----------
  // Works in groups and in DM connections (chat resolved via connection).
  bot.callbackQuery(/^menu:(note_del:|filter_del:|notes_wipe$|filters_wipe$|notes_back$|filters_back$)/, async (ctx) => {
    try {
      let chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
      if (ctx.chat?.type === 'private') chatId = store.getConnection(ctx.from.id);
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: 'Connect a group first: /start → My Groups.', show_alert: true });
        return;
      }
      if (!(await isAdminIn(bot, chatId, ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
        return;
      }
      const data = ctx.callbackQuery.data || '';
      const answer = (t) => ctx.answerCallbackQuery({ text: t }).catch(() => {});

      if (data.startsWith('menu:note_del:')) {
        store.delNote(chatId, data.slice('menu:note_del:'.length));
        const v = notesView(chatId);
        await show(ctx, v.text, v.kb);
        await answer('Note deleted');
      } else       if (data.startsWith('menu:filter_del:')) {
        const key = data.slice('menu:filter_del:'.length);
        const all = store.getFilters(chatId);
        const exact = Object.keys(all).find((k) => k === key || k.startsWith(key));
        if (exact) store.delFilter(chatId, exact);
        const v = filtersView(chatId);
        await show(ctx, v.text, v.kb);
        await answer('Filter removed');
      } else if (data === 'menu:notes_wipe') {
        const kb = new InlineKeyboard().text('✅ Yes', 'menu:notes_wipe_yes').text('❌ No', 'menu:notes_back');
        await show(ctx, 'Delete <b>ALL</b> notes?', kb);
      } else if (data === 'menu:filters_wipe') {
        const kb = new InlineKeyboard().text('✅ Yes', 'menu:filters_wipe_yes').text('❌ No', 'menu:filters_back');
        await show(ctx, 'Remove <b>ALL</b> filters?', kb);
      } else if (data === 'menu:notes_back') {
        const v = notesView(chatId);
        await show(ctx, v.text, v.kb);
      } else if (data === 'menu:filters_back') {
        const v = filtersView(chatId);
        await show(ctx, v.text, v.kb);
      }
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });

  // Plain-message confirms for /clearall and /stopall
  bot.callbackQuery(['menu:notes_wipe_yes', 'menu:notes_wipe_no', 'menu:filters_wipe_yes', 'menu:filters_wipe_no'], async (ctx) => {
    try {
      let chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
      if (ctx.chat?.type === 'private') chatId = store.getConnection(ctx.from.id);
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: 'Connect a group first.', show_alert: true });
        return;
      }
      if (!(await isAdminIn(bot, chatId, ctx.from.id))) {
        await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
        return;
      }
      const data = ctx.callbackQuery.data;
      if (data === 'menu:notes_wipe_yes') {
        const n = store.clearNotes(chatId);
        await ctx.editMessageText(`🗑 Deleted ${n} note(s).`);
      } else if (data === 'menu:filters_wipe_yes') {
        const n = store.clearFilters(chatId);
        await ctx.editMessageText(`🛑 Removed ${n} filter(s).`);
      } else {
        try { await ctx.deleteMessage(); } catch {}
      }
      await ctx.answerCallbackQuery({ text: 'Done' }).catch(() => {});
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });
}

module.exports = { register, notesView, filtersView, captureContent: capture };
