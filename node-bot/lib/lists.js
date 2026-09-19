'use strict';
/* Helpers for per-group CSV settings (ban words, whitelisted domains, ...).
 * Pattern for future items: comma-separated string in chat settings,
 * parsed to a Set here. */
function parseCsv(s) {
  return new Set(
    String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  );
}

function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split(':')[0];
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) return null;
  return d;
}

function setToCsv(set) {
  return [...set].sort().join(',');
}

module.exports = { parseCsv, normalizeDomain, setToCsv };
