'use strict';
/* Telegram WebApp initData verification (no new deps).
 * Spec: data_check_string = sorted "k=v" lines (minus hash), joined by \n;
 * secret = HMAC_SHA256(key="WebAppData", msg=bot_token);
 * hash == hex(HMAC_SHA256(secret, data_check_string)). */
const crypto = require('crypto');

function validateInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of params) {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  if (calc.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || typeof user.id !== 'number') return null;
  return user;
}

module.exports = { validateInitData };
