'use strict';
/* Render-every-view smoke test: catches undefined helpers/callback bugs
 * that node --check cannot see. Run: node test/smoke.js (exit 0 = ok). */
process.env.DB_FILE = 'test-smoke.json';

const assert = require('assert');
const store = require('../lib/store');
const menu = require('../bot/menu');
const notes = require('../bot/notes');

function kbHas(kb) {
  assert(kb && Array.isArray(kb.inline_keyboard) && kb.inline_keyboard.length > 0, 'empty keyboard');
  for (const row of kb.inline_keyboard) {
    for (const b of row) {
      assert(b.text && (b.callback_data || b.url), 'bad button');
      if (b.callback_data) assert(b.callback_data.length <= 64, `callback too long: ${b.callback_data}`);
    }
  }
}

const CHAT = -100999;
store.saveChat(CHAT, {
  blacklist_words: 'spam,scam',
  whitelist_domains: 'example.com',
  schedules: [{ id: 'abc', every: 3600, next: Date.now() + 3600, text: 'hi' }],
}, { warnLimit: 3, allowLinks: false });
store.saveNote(CHAT, 'rules', { kind: 'text', text: 'Be nice [X](https://example.com)' });
store.saveFilter(CHAT, 'doctor', { kind: 'text', text: 'Call 123', cs: 1 });

let n = 0;
for (const [name, v] of [
  ['kbMain', { text: 'x', kb: menu.kbMain() }],
  ['modView', menu.modView('Bans')],
  ['filters', menu.filtersView(CHAT)],
  ['links', menu.linksView(CHAT)],
  ['settings', menu.settingsView(CHAT)],
  ['sched', menu.schedView(CHAT)],
  ['notes', notes.notesView(CHAT)],
  ['kwfilters', notes.filtersView(CHAT)],
]) {
  assert(v.text && v.text.length, `${name} empty text`);
  kbHas(v.kb);
  n++;
}
console.log(`SMOKE_OK ${n} views`);

// cleanup
require('fs').rmSync(require('path').join(__dirname, '..', 'lib', 'test-smoke.json'), { force: true });
