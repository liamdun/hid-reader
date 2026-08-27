'use strict';
/*
 * app.js - wiring between the reader and the screen.
 *
 * Three input paths, all funnelling into commitText()/commitValue():
 *   1. keyboard wedge - a window-level key listener, no focus required
 *   2. WebHID         - vendor HID readers, Chrome/Edge
 *   3. WebSerial      - USB-serial readers, Chrome/Edge
 *
 * Reads live in memory only; nothing is written to storage but the settings.
 */
(function () {
  var W = window.Wiegand;

  var SETTINGS_KEY = 'hid-reader.settings';
  var GAP_MS = 500;     // silence long enough to mean "this is a new scan"
  var IDLE_MS = 220;    // silence that ends a scan the reader didn't terminate
  var MIN_CHARS = 3;
  var REPEAT_MS = 3000; // same card again within this window = held on reader
  var MAX_ROWS = 200;

  var settings = {
    input: 'auto',
    format: 'auto',
    sound: true,
    dedupe: true
  };

  var reads = [];
  var seq = 0;
  var buffer = '';
  var lastKeyAt = 0;
  var idleTimer = null;
  var hidDevice = null;
  var hidReports = 0;
  var hidSilenceTimer = null;
  var wedgeKeys = 0;
  var wedgeTail = '';
  var serialPort = null;
  var serialAbort = null;

  var el = {};

  // ---- helpers ---------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function clockTime(date) {
    return date.toTimeString().slice(0, 8);
  }

  function groupDigits(value) {
    // Card numbers are read aloud and typed by hand; thin grouping helps.
    var s = String(value);
    // U+2009 thin space: readable at a glance without looking like two numbers.
    // Click-to-copy always uses the ungrouped value, so this is display-only.
    return s.length > 4 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009') : s;
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, 1400);
  }

  function copy(text, label) {
    var done = function () { toast((label || 'Copied') + ': ' + text); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast('Copy blocked by the browser'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy blocked by the browser'); }
      document.body.removeChild(ta);
    }
  }

  var audio = null;
  function beep(bad) {
    if (!settings.sound) { return; }
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') { audio.resume(); }
      var osc = audio.createOscillator();
      var gain = audio.createGain();
      osc.frequency.value = bad ? 220 : 1180;
      osc.type = bad ? 'sawtooth' : 'sine';
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.14, audio.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (bad ? 0.22 : 0.09));
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + (bad ? 0.24 : 0.11));
    } catch (e) { /* audio is a nicety, never a failure */ }
  }

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      Object.keys(settings).forEach(function (k) {
        if (saved[k] !== undefined) { settings[k] = saved[k]; }
      });
    } catch (e) { /* first run, or storage blocked */ }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ---- turning input into a read ---------------------------------------

  function commitText(text, source) {
    var trimmed = String(text || '').trim();
    if (trimmed.length < MIN_CHARS) { return; }

    var parsed = W.parseScan(trimmed, settings.input);
    if (!parsed) {
      showError(trimmed, source);
      return;
    }

    if (parsed.kind === 'split') {
      addRead({
        fc: parsed.fc, cn: parsed.cn, formatShort: 'reader-supplied',
        formatName: 'Facility code and card number sent by the reader',
        parity: null, bits: 0, hex: null, dec: null, raw: null,
        source: source, sample: trimmed
      });
      return;
    }
    if (parsed.kind === 'cn') {
      addRead({
        fc: null, cn: parsed.cn, formatShort: 'card number only',
        formatName: 'Card number only - reader sends no facility code',
        parity: null, bits: 0, hex: null, dec: parsed.cn.toString(), raw: null,
        source: source, sample: trimmed
      });
      return;
    }
    commitValue(parsed.raw, parsed.containerBits, source, trimmed);
  }

  function commitValue(raw, containerBits, source, sample) {
    var formatId = settings.format === 'auto' ? W.detect(raw, containerBits) : settings.format;
    var decoded = W.decode(raw, formatId);
    decoded.raw = raw;
    decoded.source = source;
    decoded.sample = sample;
    decoded.guessed = settings.format === 'auto';
    decoded.alternates = W.alternates(raw, formatId, 3);
    addRead(decoded);
  }

  function readKey(read) {
    return (read.raw !== null && read.raw !== undefined)
      ? 'r' + read.raw.toString(16)
      : 'v' + read.fc + '/' + read.cn;
  }

  function addRead(read) {
    var now = new Date();
    read.at = now;
    read.count = 1;
    read.id = ++seq;
    read.key = readKey(read);

    var prev = reads[0];
    if (settings.dedupe && prev && prev.key === read.key && now - prev.at < REPEAT_MS) {
      // Reader is repeating while the card is held against it - not a new scan.
      prev.count += 1;
      prev.at = now;
      render();
      return;
    }

    reads.unshift(read);
    if (reads.length > MAX_ROWS) { reads.length = MAX_ROWS; }
    beep(read.parity === false);
    render(true);
  }

  function showError(text, source) {
    var id = ++seq;
    reads.unshift({
      error: true, at: new Date(), count: 1, id: id, key: 'e' + id,
      sample: text, source: source
    });
    beep(true);
    render(true);
  }

  // ---- rendering -------------------------------------------------------

  function tag(text, cls, copyText, label) {
    var span = document.createElement(copyText ? 'button' : 'span');
    span.className = 'tag' + (cls ? ' ' + cls : '') + (copyText ? ' copyable' : '');
    span.textContent = text;
    if (copyText) {
      span.title = 'Click to copy';
      span.addEventListener('click', function () { copy(copyText, label); });
    }
    return span;
  }

  function render(isNew) {
    renderCurrent(isNew);
    renderHistory();
    el.count.textContent = reads.length ? reads.length + (reads.length === 1 ? ' read' : ' reads') : '';
  }

  function renderCurrent(isNew) {
    var read = reads[0];
    var box = el.current;
    box.classList.toggle('error', !!(read && read.error));

    if (!read) {
      box.innerHTML = '<div class="waiting"><strong>Waiting for a scan</strong>'
        + '<span class="sub">Tap a fob or card on the reader. Nothing to click — '
        + 'just keep this window focused.</span></div>';
      return;
    }

    box.innerHTML = '';

    if (read.error) {
      var err = document.createElement('div');
      err.className = 'waiting';
      err.innerHTML = '<strong>Could not read that scan</strong>'
        + '<span class="sub">Got <code></code> — not a number this app knows how to parse. '
        + 'Try a different "Reader sends" setting below.</span>';
      err.querySelector('code').textContent = read.sample;
      box.appendChild(err);
      return;
    }

    var readout = document.createElement('div');
    readout.className = 'readout';
    readout.appendChild(field('Facility code', read.fc, 'Facility code'));
    readout.appendChild(field('Card number', read.cn, 'Card number'));
    box.appendChild(readout);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.appendChild(tag(read.formatShort + (read.guessed ? ' (guess)' : '')));
    if (read.bits) { meta.appendChild(tag(read.bits + ' bits')); }
    if (read.parity === true) { meta.appendChild(tag('parity ok', 'ok')); }
    if (read.parity === false) { meta.appendChild(tag('parity failed', 'bad')); }
    if (read.oversize) { meta.appendChild(tag('too wide for this format', 'warn')); }
    if (read.hex) { meta.appendChild(tag('hex ' + read.hex, '', read.hex, 'Hex')); }
    if (read.dec) { meta.appendChild(tag('dec ' + read.dec, '', read.dec, 'Decimal')); }
    meta.appendChild(tag(read.source));
    meta.appendChild(tag(clockTime(read.at)));
    if (read.count > 1) { meta.appendChild(tag('×' + read.count + ' (held)')); }
    box.appendChild(meta);

    if (read.alternates && read.alternates.length) {
      var alts = document.createElement('div');
      alts.className = 'alts';
      alts.appendChild(document.createTextNode('Or, read as: '));
      read.alternates.forEach(function (alt) {
        var b = document.createElement('button');
        b.className = 'alt';
        b.textContent = alt.formatShort + ' → '
          + (alt.fc === null ? 'no FC' : 'FC ' + alt.fc) + ', card ' + alt.cn;
        b.title = 'Lock the reader to ' + alt.formatName;
        b.addEventListener('click', function () {
          settings.format = alt.formatId;
          el.format.value = alt.formatId;
          saveSettings();
          // Re-decode the current read under the format just picked. The
          // repeat-merge would otherwise swallow it if this card was the last
          // one scanned twice.
          var merging = settings.dedupe;
          settings.dedupe = false;
          reads.shift();
          commitValue(read.raw, 0, read.source, read.sample);
          settings.dedupe = merging;
          toast('Format locked to ' + alt.formatName);
        });
        alts.appendChild(b);
      });
      box.appendChild(alts);
    }

    if (isNew) {
      box.classList.remove('flash');
      void box.offsetWidth;
      box.classList.add('flash');
    }
  }

  function field(label, value, copyLabel) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    var b = document.createElement('button');
    b.className = 'value' + (value === null || value === undefined ? ' none' : '');
    b.textContent = (value === null || value === undefined) ? 'not in this format' : groupDigits(value);
    if (value !== null && value !== undefined) {
      b.title = 'Click to copy';
      b.addEventListener('click', function () { copy(String(value), copyLabel); });
    }
    wrap.appendChild(l);
    wrap.appendChild(b);
    return wrap;
  }

  function renderHistory() {
    var older = reads.slice(1);
    el.history.innerHTML = '';

    if (!older.length) {
      var li = document.createElement('li');
      li.className = 'placeholder';
      li.textContent = reads.length
        ? 'Scan another card and this one drops down here.'
        : 'Previous reads will stack up here.';
      el.history.appendChild(li);
      return;
    }

    older.forEach(function (read) {
      var li = document.createElement('li');

      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = clockTime(read.at);
      li.appendChild(time);

      if (read.error) {
        var note = document.createElement('span');
        note.className = 'empty-note';
        note.style.gridColumn = '2 / -1';
        note.textContent = 'unreadable: ' + read.sample;
        li.appendChild(note);
        el.history.appendChild(li);
        return;
      }

      li.appendChild(numCell('Facility', read.fc === null ? '–' : groupDigits(read.fc), read.fc));
      li.appendChild(numCell('Card number', groupDigits(read.cn), read.cn));

      var fmt = document.createElement('span');
      fmt.className = 'fmt';
      fmt.textContent = read.formatShort + (read.hex ? ' · ' + read.hex : '');
      if (read.parity === false) { fmt.textContent += ' · parity!'; }
      li.appendChild(fmt);

      var rpt = document.createElement('span');
      rpt.className = 'rpt';
      rpt.textContent = read.count > 1 ? '×' + read.count : '';
      li.appendChild(rpt);

      el.history.appendChild(li);
    });
  }

  function numCell(label, text, copyValue) {
    var span = document.createElement('span');
    span.className = 'num';
    var small = document.createElement('small');
    small.textContent = label;
    span.appendChild(small);
    span.appendChild(document.createTextNode(text));
    if (copyValue !== null && copyValue !== undefined) {
      span.style.cursor = 'copy';
      span.title = 'Click to copy';
      span.addEventListener('click', function () { copy(String(copyValue), label); });
    }
    return span;
  }

  function setStatus(text, cls) {
    el.status.className = 'pill' + (cls ? ' ' + cls : '');
    el.status.innerHTML = '<span class="dot"></span>';
    el.status.appendChild(document.createTextNode(text));
  }

  function refreshStatus() {
    var extra = [];
    if (hidDevice) { extra.push('HID: ' + (hidDevice.productName || 'reader')); }
    if (serialPort) { extra.push('serial'); }
    setStatus('Listening' + (extra.length ? ' · ' + extra.join(' · ') : ' for keystrokes'), 'live');
  }

  // ---- keyboard wedge --------------------------------------------------

  var WEDGE_CHARS = /^[0-9a-fA-F,;:\/|\- ]$/;

  // Every key the page sees, including ones the scan filter drops. This is the
  // one honest answer to "is my reader reaching the browser at all?" - a reader
  // sending unexpected characters shows up here even though it never parses.
  function noteKey(key) {
    wedgeKeys += 1;
    wedgeTail = (wedgeTail + (key.length === 1 ? key : '\u27e8' + key + '\u27e9')).slice(-44);
    renderWedgeMonitor();
  }

  function renderWedgeMonitor() {
    el.wedgeMonitor.textContent = wedgeKeys
      ? wedgeKeys + (wedgeKeys === 1 ? ' key' : ' keys') + ' seen · last: ' + wedgeTail
      : 'Nothing yet. If your reader types, tap a card with this window focused — '
        + 'characters appear here even when they do not parse as a card.';
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) { return; }
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) { return; }

    if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Tab') { noteKey(e.key); }

    if (e.key === 'Enter' || e.key === 'Tab') {
      if (buffer) {
        e.preventDefault();
        flushBuffer();
      }
      return;
    }
    if (e.key.length !== 1 || !WEDGE_CHARS.test(e.key)) { return; }

    var now = Date.now();
    if (now - lastKeyAt > GAP_MS) { buffer = ''; }
    buffer += e.key;
    lastKeyAt = now;

    // Readers that send no Enter still stop typing; the silence ends the scan.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(flushBuffer, IDLE_MS);
  }

  function flushBuffer() {
    clearTimeout(idleTimer);
    var text = buffer;
    buffer = '';
    if (text) { commitText(text, 'keyboard'); }
  }

  // ---- WebHID ----------------------------------------------------------

  function hidSupported() { return !!navigator.hid; }

  function hex16(n) { return '0x' + Number(n).toString(16).toUpperCase().padStart(4, '0'); }

  // Names the top-level collections a device exposes, which is what tells you
  // whether you picked the reader or the wireless dongle next to it.
  function usageName(page, usage) {
    if (page >= 0xff00) { return 'vendor-defined'; }
    if (page === 0x01) {
      return ({ 0x02: 'mouse', 0x04: 'joystick', 0x05: 'gamepad', 0x06: 'keyboard',
        0x07: 'keypad', 0x80: 'system control' })[usage] || 'generic desktop';
    }
    return ({ 0x07: 'keyboard/keypad', 0x08: 'LEDs', 0x0c: 'consumer control',
      0x0d: 'digitizer', 0xf1d0: 'security key' })[page] || 'usage page ' + hex16(page);
  }

  function hidLine(text, cls) {
    var div = document.createElement('div');
    div.className = 'devnote' + (cls ? ' ' + cls : '');
    div.textContent = text;
    return div;
  }

  function renderHidDetails(gaveUpWaiting) {
    el.hidNote.innerHTML = '';
    if (!hidDevice) { return; }

    el.hidNote.appendChild(hidLine((hidDevice.productName || 'Unnamed device')
      + '  ·  vendor ' + hex16(hidDevice.vendorId) + '  ·  product ' + hex16(hidDevice.productId)));

    var collections = hidDevice.collections || [];
    if (collections.length) {
      el.hidNote.appendChild(hidLine('Readable collections: ' + collections.map(function (c) {
        return usageName(c.usagePage, c.usage) + ' (' + hex16(c.usagePage) + '/' + hex16(c.usage) + ')';
      }).join(', ')));
    } else {
      // Chrome strips keyboard and mouse collections from WebHID so pages can't
      // keylog. Nothing readable left means this is one of those devices.
      el.hidNote.appendChild(hidLine('No readable collections. Chrome hides keyboard and mouse '
        + 'devices from WebHID, so nothing will ever arrive from this one.', 'warn-note'));
    }

    el.hidNote.appendChild(hidLine(hidReports
      ? 'Reports received: ' + hidReports
      : 'Waiting for the first report — tap a card on the reader.'));

    if (gaveUpWaiting && !hidReports) {
      el.hidNote.appendChild(hidLine('Nothing arrived in 10 seconds. This is probably not the reader, '
        + 'or the reader is a keyboard-wedge type. Disconnect and tap a card with this window '
        + 'focused — check the keystroke line above to see if anything is reaching the page.', 'warn-note'));
    }
  }

  function attachHid(device) {
    hidDevice = device;
    hidReports = 0;
    device.addEventListener('inputreport', onHidReport);
    el.hidBtn.textContent = 'Disconnect HID reader';
    renderHidDetails(false);
    clearTimeout(hidSilenceTimer);
    hidSilenceTimer = setTimeout(function () { renderHidDetails(true); }, 10000);
    refreshStatus();
  }

  function onHidReport(event) {
    var bytes = Array.from(new Uint8Array(event.data.buffer));
    var full = bytes.map(function (b) { return b.toString(16).toUpperCase().padStart(2, '0'); }).join(' ');
    hidReports += 1;
    clearTimeout(hidSilenceTimer);
    renderHidDetails(false);
    el.hidNote.appendChild(hidLine('Last report (id ' + event.reportId + '): ' + full));

    // Readers pad reports with zero bytes; strip them so the value width
    // reflects the card, not the report size.
    var start = 0;
    while (start < bytes.length && bytes[start] === 0) { start++; }
    var end = bytes.length;
    while (end > start && bytes[end - 1] === 0) { end--; }
    var payload = bytes.slice(start, end);
    if (!payload.length) { return; }

    commitValue(W.bytesToValue(payload), payload.length * 8, 'usb-hid', full);
  }

  async function toggleHid() {
    if (hidDevice) {
      clearTimeout(hidSilenceTimer);
      try { await hidDevice.close(); } catch (e) { /* already gone */ }
      hidDevice.removeEventListener('inputreport', onHidReport);
      hidDevice = null;
      el.hidBtn.textContent = 'Connect HID reader';
      el.hidNote.innerHTML = '';
      refreshStatus();
      return;
    }
    if (!hidSupported()) {
      toast('This browser has no WebHID. Use Chrome or Edge.');
      return;
    }
    try {
      var devices = await navigator.hid.requestDevice({ filters: [] });
      if (!devices.length) { return; }
      await devices[0].open();
      attachHid(devices[0]);
    } catch (err) {
      el.hidNote.innerHTML = '';
      el.hidNote.appendChild(hidLine('Could not open device: ' + err.message
        + ' — a reader the OS has claimed as a keyboard or as a smartcard reader '
        + 'cannot be opened this way.', 'warn-note'));
    }
  }

  async function reconnectHid() {
    if (!hidSupported()) { return; }
    try {
      var granted = await navigator.hid.getDevices();
      for (var i = 0; i < granted.length; i++) {
        try {
          await granted[i].open();
          attachHid(granted[i]);
          return;
        } catch (e) { /* try the next one */ }
      }
    } catch (e) { /* no permission yet */ }
  }

  // ---- WebSerial -------------------------------------------------------

  async function toggleSerial() {
    if (serialPort) {
      if (serialAbort) { serialAbort.abort(); }
      try { await serialPort.close(); } catch (e) { /* already closed */ }
      serialPort = null;
      el.serialBtn.textContent = 'Connect serial reader';
      el.serialNote.textContent = '';
      refreshStatus();
      return;
    }
    if (!navigator.serial) {
      toast('This browser has no Web Serial. Use Chrome or Edge.');
      return;
    }
    try {
      var port = await navigator.serial.requestPort();
      await port.open({ baudRate: Number(el.baud.value) || 9600 });
      serialPort = port;
      el.serialBtn.textContent = 'Disconnect serial reader';
      el.serialNote.textContent = 'Open at ' + el.baud.value + ' baud.';
      refreshStatus();
      readSerialLoop(port);
    } catch (err) {
      el.serialNote.textContent = 'Could not open port: ' + err.message;
    }
  }

  async function readSerialLoop(port) {
    serialAbort = new AbortController();
    var decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable, { signal: serialAbort.signal }).catch(function () { /* closed */ });
    var reader = decoder.readable.getReader();
    var pending = '';
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) { break; }
        pending += chunk.value;
        var lines = pending.split(/[\r\n]+/);
        pending = lines.pop();
        lines.forEach(function (line) {
          if (line.trim()) { commitText(line, 'serial'); }
        });
      }
    } catch (err) {
      el.serialNote.textContent = 'Serial read stopped: ' + err.message;
    } finally {
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
  }

  // ---- export ----------------------------------------------------------

  function toCsv() {
    var rows = [['time', 'facility_code', 'card_number', 'format', 'raw_hex', 'raw_decimal', 'parity', 'repeats']];
    reads.forEach(function (r) {
      if (r.error) { return; }
      rows.push([
        r.at.toISOString(),
        r.fc === null ? '' : r.fc.toString(),
        r.cn.toString(),
        r.formatShort,
        r.hex || '',
        r.dec || '',
        r.parity === null ? '' : (r.parity ? 'ok' : 'failed'),
        r.count
      ]);
    });
    return rows.map(function (row) { return row.join(','); }).join('\n');
  }

  // ---- boot ------------------------------------------------------------

  function bindControls() {
    W.FORMATS.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      opt.title = f.note || '';
      el.format.appendChild(opt);
    });

    el.input.value = settings.input;
    el.format.value = settings.format;
    el.sound.checked = settings.sound;
    el.dedupe.checked = settings.dedupe;

    el.input.addEventListener('change', function () {
      settings.input = el.input.value;
      saveSettings();
      el.input.blur();
    });
    el.format.addEventListener('change', function () {
      settings.format = el.format.value;
      saveSettings();
      el.format.blur();
    });
    el.sound.addEventListener('change', function () {
      settings.sound = el.sound.checked;
      saveSettings();
      if (settings.sound) { beep(false); }
    });
    el.dedupe.addEventListener('change', function () {
      settings.dedupe = el.dedupe.checked;
      saveSettings();
    });

    el.manual.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        commitText(el.manual.value, 'typed');
        el.manual.value = '';
      }
    });

    el.clear.addEventListener('click', function () {
      reads = [];
      render();
      toast('List cleared');
    });
    el.copyAll.addEventListener('click', function () {
      if (!reads.length) { toast('Nothing to copy yet'); return; }
      copy(toCsv(), 'Copied ' + reads.length + ' reads as CSV');
    });
    el.sample.addEventListener('click', function () {
      // A real 26-bit value: facility code 123, card number 45678.
      var fc = 123, cn = 45678 + Math.floor(Math.random() * 3);
      var data = (BigInt(fc) << 16n) | BigInt(cn);
      var ones = function (v) { return (v.toString(2).match(/1/g) || []).length; };
      var raw = (BigInt(ones(data >> 12n) % 2) << 25n) | (data << 1n) | BigInt((ones(data & 0xfffn) % 2) ^ 1);
      commitValue(raw, 32, 'sample', raw.toString());
    });

    el.hidBtn.addEventListener('click', toggleHid);
    el.serialBtn.addEventListener('click', toggleSerial);
    if (!hidSupported()) { el.hidBtn.disabled = true; el.hidNote.textContent = 'WebHID needs Chrome or Edge.'; }
    if (!navigator.serial) { el.serialBtn.disabled = true; el.serialNote.textContent = 'Web Serial needs Chrome or Edge.'; }
  }

  function init() {
    ['current', 'history', 'status', 'count', 'toast', 'input', 'format', 'sound',
      'dedupe', 'manual', 'clear', 'copyAll', 'sample', 'hidBtn', 'hidNote',
      'serialBtn', 'serialNote', 'baud', 'wedgeMonitor'].forEach(function (id) { el[id] = $(id); });

    loadSettings();
    bindControls();
    render();
    renderWedgeMonitor();
    refreshStatus();

    window.addEventListener('keydown', onKeyDown, true);

    // A control left focused by a mouse click eats the reader's keystrokes: the
    // Enter that terminates a scan re-activates the button, and digits vanish
    // into a select's typeahead. Drop focus after a pointer click only —
    // keyboard activation (detail === 0) keeps it, so tabbing still works.
    document.addEventListener('click', function (e) {
      if (e.detail === 0 || !e.target.closest) { return; }
      var control = e.target.closest('button, select');
      if (control) { control.blur(); }
    });
    window.addEventListener('blur', function () {
      setStatus('Window not focused — scans go elsewhere', 'bad');
    });
    window.addEventListener('focus', refreshStatus);
    if (navigator.hid) {
      navigator.hid.addEventListener('disconnect', function (e) {
        if (hidDevice && e.device === hidDevice) {
          clearTimeout(hidSilenceTimer);
          hidDevice = null;
          el.hidBtn.textContent = 'Connect HID reader';
          el.hidNote.innerHTML = '';
          el.hidNote.appendChild(hidLine('Reader unplugged.'));
          refreshStatus();
        }
      });
    }
    reconnectHid();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
