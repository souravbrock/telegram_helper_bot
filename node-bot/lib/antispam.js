'use strict';
/* Port of app/services/antispam.py */
const URL_RE = /(https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+)/gi;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F]/gu;

const buckets = new Map(); // "chat:user" -> number[]

function floodHit(chatId, userId, limit, windowSec) {
  const now = Date.now() / 1000;
  const k = `${chatId}:${userId}`;
  let q = buckets.get(k) || [];
  q = q.filter((t) => now - t <= windowSec);
  q.push(now);
  buckets.set(k, q);
  return q.length > limit;
}

function domainsOf(text) {
  const out = [];
  const re = new RegExp(URL_RE);
  let m;
  const t = text || '';
  while ((m = re.exec(t))) {
    let url = m[0];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      let host = new URL(url).hostname.toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);
      if (host) out.push(host);
    } catch { /* ignore */ }
  }
  return out;
}

function check({ chatId, userId, text = '', hasUrlEntity = false, isForward = false, allowLinks = false, whitelist = new Set(), blacklist = new Set(), floodLimit = 5, floodWindow = 10 }) {
  const reasons = [];
  const lowered = (text || '').toLowerCase();

  for (const w of blacklist) {
    if (w && lowered.includes(w)) reasons.push(`blacklisted word: ${w}`);
  }

  const domains = domainsOf(text);
  if (domains.length && !allowLinks) {
    const bad = domains.filter((d) => !whitelist.has(d));
    if (bad.length) reasons.push(`unauthorized link: ${bad.slice(0, 3).join(', ')}`);
  } else if (hasUrlEntity && !allowLinks) {
    reasons.push('unauthorized link (entity)');
  }

  if (isForward) reasons.push('forwarded message');

  const emojiCount = (text.match(EMOJI_RE) || []).length;
  if (emojiCount >= 8) reasons.push(`excessive emojis (${emojiCount})`);
  if (text && text.length > 1500) reasons.push('message too long');
  if (floodHit(chatId, userId, floodLimit, floodWindow)) reasons.push('flooding');

  return { isSpam: reasons.length > 0, reasons };
}

module.exports = { check };
