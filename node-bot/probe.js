'use strict';
/* Zero-dependency probe: if THIS 500s, Passenger/proxy is broken (host issue).
 * If it works, node-bot/app.js or its deps are the problem.
 * Temporarily set Startup file to probe.js in Setup Node.js App, Restart, open /health.
 */
const http = require('http');

const PORT = parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10);

http
  .createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, probe: true, port: PORT }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('probe alive. try /health\n');
    }
  })
  .listen(PORT, () => console.log(`probe listening on ${PORT}`));
