'use strict';
/* Probe v2: dumps the env Passenger provides (PORT? PASSENGER_*?) so we can see
 * why a healthy listening process still 500s behind the proxy.
 * Startup file -> probe.js, Restart, open /health and /env, paste both.
 */
const http = require('http');

const PORT = parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10);

const interesting = {};
for (const k of Object.keys(process.env).sort()) {
  if (/^(PORT|APP_|PASSENGER|NODE|LITESPEED|PHUSION)/i.test(k)) interesting[k] = process.env[k];
}
console.log('probe env:', JSON.stringify(interesting));
console.log(`probe listening on ${PORT}`);

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, probe: true, port: PORT, node: process.version, env: interesting }));
  })
  .listen(PORT);
