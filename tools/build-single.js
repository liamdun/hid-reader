'use strict';
/*
 * Inline the stylesheet and scripts into one portable HTML file, and lay out
 * dist/ as a deployable static site.
 *
 *   dist/index.html      what a host serves - one request, no assets to lose
 *   dist/fob-reader.html the same page under a download-friendly name
 *   dist/_headers        Cloudflare Pages: never serve a stale copy
 *
 * The single file also works straight from the filesystem, so it can be
 * emailed or dropped on a shared drive. (WebHID and Web Serial still want a
 * real https/localhost origin.)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const inlined = read('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + read('styles.css') + '</style>')
  .replace('<script src="wiegand.js"></script>', () => '<script>\n' + read('wiegand.js') + '</script>')
  .replace('<script src="app.js"></script>', () => '<script>\n' + read('app.js') + '</script>');

for (const leftover of ['styles.css"', 'wiegand.js"', 'app.js"']) {
  if (inlined.includes(leftover)) {
    throw new Error('build-single: ' + leftover + ' was not inlined - did index.html change?');
  }
}

// The point of hosting this is that a fix reaches the reader desk without
// anyone copying a file around, so the page must never be served from cache.
const headers = `/*
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff

/
  Cache-Control: no-cache

/*.html
  Cache-Control: no-cache
`;

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), inlined);
fs.writeFileSync(path.join(dist, 'fob-reader.html'), inlined);
fs.writeFileSync(path.join(dist, '_headers'), headers);
console.log('Wrote dist/ (index.html, fob-reader.html, _headers) - '
  + Math.round(inlined.length / 1024) + ' KB per page');
