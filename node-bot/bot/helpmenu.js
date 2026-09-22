'use strict';
/* Rose-style DM home: intro + module grid, each opening its own help.
 * Wired into /start (DM). Group /start stays short (points to /menu). */
const { grid } = require('../lib/kb');

const INTRO =
  `Hey! I'm <b>Jarvis</b>, keeping order in your groups.\n` +
  `I do warns, flood control, link/word filters, notes, keyword replies,\n` +
  `DM captcha verification, reports, rules, polls and scheduled posts.\n\n` +
  `Add me to a group as admin (delete + restrict rights), then /menu.\n\n` +
  `Tap a module for its commands:`;

const MODULES = {
  Admin: `<b>Admin</b>\n/promote (reply) — grant basic admin\n/demote (reply) — strip admin\n/adminlist — owners + admins\n/pin (reply) [notify] • /unpin\n/purge (reply) — delete up to 100 after it`,
  Antiflood: `<b>Antiflood</b>\n/flood — status\n/setflood 8|off — msgs per 10s\n/setfloodmode warn|mute|kick|ban — direct action on flood (warn = normal escalation)`,
  AntiRaid: `<b>AntiRaid</b> — join-burst lockdown\n/antiraid on|off|status\n/setraidlimit 5 — joins per 60s that trip it\n/setraidmode kick|ban • /setraidduration 1h\nTripped: newcomers auto-removed for the duration, announced + logged. Toggle in /menu → Settings.`,
  Autoreply: `<b>Autoreply</b> — smart keyword answers\n/autoreply — guided: keyword → exact/any-case choice → text and/or media answer (links OK)\nExample: keyword <code>doctor</code> answers “i need doctor number”.\nManage in Filters panel (➕ New smart) or /filters • /stop`,
  Bans: `<b>Bans</b>\n/ban (reply) • /tban 2d (reply) • /unban id\n/kick (reply)\n/mute 10m (reply) • /tmute 1d (reply) • /unmute\nDurations: s/m/h/d/w`,
  Blocklists: `<b>Blocklists</b> — deleted + warned on sight\nBan words: /addbanword a,b • /rmbanword a • /banwords\nLink whitelist: /addlink domain • /rmlink • /links\nMaster switch: /allowlinks on|off\nAdmins/owner always bypass. URLs never repeat in public warns.`,
  Captcha: `<b>CAPTCHA</b> — 1-to-1 DM verification\nNew members get only a Verify button in the group; the math quiz happens in private. Timeout kicks + cleans up. Join/leave traces and bot notices auto-expire for privacy. Toggle in /menu → Settings.`,
  Filters: `<b>Filters</b> — keyword auto-replies\n/filter hi Hello {first}! (or reply to media)\n/filters • /stop word • /stopall\nTriggers on whole words. Never fires on deleted spam.`,
  Greetings: `<b>Greetings</b>\n/setwelcome text — {mention} {title} {name}\nSent only after captcha pass, auto-deleted (privacy).\nEdit anytime in /menu → Settings.`,
  Log: `<b>Log</b>\nEvery action lands in the log channel (set LOG_CHANNEL_ID) with full detail (URLs kept there, never in public warns).\nAPI: /api/logs /api/stats • Dashboard: /miniapp`,
  Notes: `<b>Notes</b>\n/save name (reply to anything: text/photo/video/file)\nRecall: #name or /get name\n/notes • /clear name • /clearall\nSupports {variables} and [Label](url) buttons.`,
  Pin: `<b>Pin</b>\n/pin (reply) — silent pin\n/pin notify (reply) — with notification\n/unpin (reply) or /unpin — unpin all`,
  Purges: `<b>Purges</b>\n/purge (reply to first message) — deletes up to 100 messages after it. Bot-API best effort (service messages may remain).`,
  Reports: `<b>Reports</b>\n/report (reply) [reason] — card to admins with Delete/Mute/Kick/Ban buttons, 1/min cooldown.\n/reports on|off`,
  Rules: `<b>Rules</b>\n/setrules text • /clearrules\n/rules — DM-first delivery (group fallback). Supports variables + buttons.`,
  Schedules: `<b>Schedules</b> — recurring posts\n/schedule 6h Text — every 6h\nReply to media + /schedule 12h [caption] — repost it\n/schedules • /unschedule id (max 20, min 1m)`,
  Warnings: `<b>Warnings</b>\n/warn (reply) • /unwarn • /warns\nLimit in /menu → Settings (mute at limit, kick at +1, ban at ×2).\nPublic messages never repeat removed links.`,
};

const ROADMAP = `<b>On the roadmap</b>\nApproval mode • Connections (manage from DM) • Federations (cross-group bans) • Locks (media/sticker locks) • Topics • Import/Export • Languages\n\nTell the owner which to build next!`;

/* Which control-panel views each module shortcuts to (shared with menu.js).
 * Buttons emit menu:<view> callbacks, which resolve DM connections. */
const MOD_PANELS = {
  Blocklists: ['filters', 'links'],
  Notes: ['notes'],
  Filters: ['filtersv'],
  Autoreply: ['filtersv'],
  Schedules: ['sched'],
  Antiflood: ['settings'],
  Captcha: ['settings'],
  Greetings: ['settings'],
  Rules: ['settings'],
  Reports: ['settings'],
  Warnings: ['settings'],
  AntiRaid: ['settings'],
  Log: ['stats'],
  Bans: [], Admin: [], Pin: [], Purges: [],
};

const PANEL_LABEL = { filters: 'Ban words', links: 'Links', notes: 'Notes', filtersv: 'Filters', sched: 'Schedules', settings: 'Settings', stats: 'Stats' };

function gridKb() {
  const keys = Object.keys(MODULES);
  const items = keys.map((k) => ({ t: k, d: `help:${k}` }));
  items.push({ row: true }, { t: '🔗 My Groups', d: 'conn:list' }, { t: '⏳ Roadmap', d: 'help:ROADMAP' });
  return grid(items, 3);
}

function home() {
  return { text: INTRO, kb: gridKb() };
}

function register(bot) {
  bot.callbackQuery(/^help:/, async (ctx) => {
    try {
      const key = (ctx.callbackQuery.data || '').slice('help:'.length);
      if (key === 'HOME') {
        const h = home();
        try {
          await ctx.editMessageText(h.text, { parse_mode: 'HTML', reply_markup: h.kb });
        } catch { /* unchanged */ }
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const body = key === 'ROADMAP' ? ROADMAP : MODULES[key];
      if (!body) {
        await ctx.answerCallbackQuery({ text: 'Unknown module' });
        return;
      }
      const shortcuts = (MOD_PANELS[key] || []).map((p) => ({ t: `➡️ ${PANEL_LABEL[p] || p}`, d: `menu:${p}` }));
      const kb = grid([...shortcuts, { row: true }, { t: '⬅️ Modules', d: 'help:HOME' }], 2);
      try {
        await ctx.editMessageText(body, { parse_mode: 'HTML', reply_markup: kb });
      } catch { /* unchanged */ }
      await ctx.answerCallbackQuery().catch(() => {});
    } catch (err) {
      try { await ctx.answerCallbackQuery({ text: String(err.message).slice(0, 180) }); } catch {}
    }
  });
}

module.exports = { register, home, MODULES, MOD_PANELS, PANEL_LABEL };
