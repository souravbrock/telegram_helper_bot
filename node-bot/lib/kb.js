'use strict';
/* Shared grid keyboards: every menu, submenu and option list uses this,
 * so the whole bot has one consistent Rose-style grid look.
 * Items: { t, d } callback button, { t, url } link button, { row: true } break.
 * Example: grid([{t:'A',d:'a'},{t:'B',d:'b'}], 2) -> one row of two. */
const { InlineKeyboard } = require('grammy');

function grid(items, cols = 2) {
  const kb = new InlineKeyboard();
  let cell = 0;
  for (const it of items) {
    if (it.row) {
      if (cell % cols !== 0) kb.row();
      cell = 0;
      continue;
    }
    if (it.url) kb.url(it.t, it.url);
    else kb.text(it.t, it.d);
    cell++;
    if (cell % cols === 0) kb.row();
  }
  return kb;
}

/* Standard footer: Back + Close side by side. backCb e.g. 'menu:main'. */
function withNav(items, backCb, cols = 2) {
  return grid([...items, { row: true }, { t: '⬅️ Back', d: backCb }, { t: '🗑 Close', d: 'menu:close' }], cols);
}

module.exports = { grid, withNav };
