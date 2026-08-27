'use strict';
/*
 * Inline the stylesheet and scripts into one portable HTML file.
 * Handy for emailing the tool to a colleague or dropping it on a shared drive:
 * the single file works straight from the filesystem, keyboard-wedge readers
 * included. (WebHID and Web Serial still want a real https/localhost origin.)
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

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'fob-reader.html');
fs.writeFileSync(out, inlined);
console.log('Wrote ' + path.relative(root, out) + ' (' + Math.round(inlined.length / 1024) + ' KB)');
