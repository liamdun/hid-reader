'use strict';
/*
 * Zero-dependency static server, so `npm start` needs nothing installed.
 * Serving over localhost matters: WebHID and Web Serial require a secure
 * context, which http://localhost counts as but a file:// page may not.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel === '/' ? 'index.html' : rel);
  // Never serve outside the project directory.
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    }).end(body);
  });
}).listen(port, () => {
  console.log('Fob Reader running at http://localhost:' + port + '/');
});
