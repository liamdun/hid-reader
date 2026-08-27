'use strict';
/*
 * wiegand.js - pure decoding logic, no DOM.
 *
 * Readers hand us one opaque number: the raw Wiegand bit stream the card sent.
 * Everything interesting (facility code, card number) comes from slicing that
 * number according to the card format, so this file is just bit arithmetic.
 *
 * BigInt throughout - Corporate 1000 48-bit does not fit in a JS number.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.Wiegand = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // fc/cn are [shiftFromLsb, widthInBits]. parity entries are
  // [parityBitIndex, highDataBit, lowDataBit, 'even'|'odd'], all indexed from
  // the LSB. Formats without a parity entry are decoded but not checked.
  var FORMATS = [
    {
      id: 'h10301', name: '26-bit H10301', short: '26-bit', bits: 26,
      fc: [17, 8], cn: [1, 16],
      parity: [[25, 24, 13, 'even'], [0, 12, 1, 'odd']],
      note: 'The standard 26-bit format. By far the most common.'
    },
    {
      id: 'd10202', name: '33-bit D10202', short: '33-bit', bits: 33,
      fc: [25, 7], cn: [1, 24],
      note: 'Kantech / D10202.'
    },
    {
      id: 'h10306', name: '34-bit H10306', short: '34-bit', bits: 34,
      fc: [17, 16], cn: [1, 16],
      parity: [[33, 32, 17, 'even'], [0, 16, 1, 'odd']],
      note: '16-bit facility code, 16-bit card number.'
    },
    {
      id: 'c1k35', name: '35-bit Corporate 1000', short: '35-bit C1k', bits: 35,
      fc: [21, 12], cn: [1, 20],
      note: '12-bit company code, 20-bit card number.'
    },
    {
      id: 'h10304', name: '37-bit H10304', short: '37-bit', bits: 37,
      fc: [20, 16], cn: [1, 19],
      note: '16-bit facility code, 19-bit card number.'
    },
    {
      id: 'h10302', name: '37-bit H10302', short: '37-bit (no FC)', bits: 37,
      fc: null, cn: [1, 35],
      note: '35-bit card number, no facility code.'
    },
    {
      id: 'c1k48', name: '48-bit Corporate 1000', short: '48-bit C1k', bits: 48,
      fc: [24, 22], cn: [1, 23],
      note: '22-bit company code, 23-bit card number.'
    },
    {
      id: 'raw', name: 'Raw / unformatted', short: 'raw', bits: 0,
      fc: null, cn: null,
      note: 'No format applied - the number is shown exactly as the reader sent it.'
    }
  ];

  function byId(id) {
    for (var i = 0; i < FORMATS.length; i++) {
      if (FORMATS[i].id === id) { return FORMATS[i]; }
    }
    return null;
  }

  function mask(width) { return (1n << BigInt(width)) - 1n; }

  function bitLength(value) {
    if (value <= 0n) { return value === 0n ? 1 : 0; }
    return value.toString(2).length;
  }

  function bitAt(value, index) {
    return Number((value >> BigInt(index)) & 1n);
  }

  function countOnes(value, high, low) {
    var total = 0;
    for (var i = low; i <= high; i++) { total += bitAt(value, i); }
    return total;
  }

  // Even parity: the parity bit makes the total count of 1s even.
  // Odd parity: it makes the total odd.
  function expectedParity(value, high, low, kind) {
    var ones = countOnes(value, high, low) % 2;
    return kind === 'even' ? ones : ones ^ 1;
  }

  function checkParity(value, format) {
    if (!format.parity) { return null; }
    for (var i = 0; i < format.parity.length; i++) {
      var spec = format.parity[i];
      if (bitAt(value, spec[0]) !== expectedParity(value, spec[1], spec[2], spec[3])) {
        return false;
      }
    }
    return true;
  }

  function toHex(value, bits) {
    var digits = bits ? Math.ceil(bits / 4) : 0;
    var hex = value.toString(16).toUpperCase();
    while (hex.length < digits) { hex = '0' + hex; }
    return hex;
  }

  /**
   * Slice a raw Wiegand value into facility code and card number.
   * Returns null only if the format id is unknown.
   */
  function decode(raw, formatId) {
    var format = byId(formatId);
    if (!format) { return null; }

    var used = bitLength(raw);
    if (format.id === 'raw') {
      return {
        formatId: format.id, formatName: format.name, formatShort: format.short,
        bits: used, fc: null, cn: raw, parity: null, oversize: false,
        hex: toHex(raw, 0), dec: raw.toString()
      };
    }

    return {
      formatId: format.id,
      formatName: format.name,
      formatShort: format.short,
      bits: format.bits,
      fc: format.fc ? (raw >> BigInt(format.fc[0])) & mask(format.fc[1]) : null,
      cn: (raw >> BigInt(format.cn[0])) & mask(format.cn[1]),
      parity: checkParity(raw, format),
      // The value carries more bits than this format holds, so the slice above
      // silently dropped some. Always a sign the wrong format is selected.
      oversize: used > format.bits,
      hex: toHex(raw, format.bits),
      dec: raw.toString()
    };
  }

  /**
   * Guess the card format from the value alone. containerBits, when known
   * (e.g. an 8-digit hex string is a 32-bit container), rules out formats that
   * are wider than what the reader actually sent.
   *
   * This is a guess, not a measurement - a 35-bit card whose top bits happen to
   * be zero is indistinguishable from a 26-bit one. Parity is the tie-breaker
   * where a format defines it; callers should surface alternates either way.
   */
  function detect(raw, containerBits) {
    var need = bitLength(raw);
    var candidates = FORMATS.filter(function (f) {
      return f.id !== 'raw' && f.bits >= need;
    });
    if (!candidates.length) { return 'raw'; }

    if (containerBits) {
      var fits = candidates.filter(function (f) { return f.bits <= containerBits; });
      if (fits.length) { candidates = fits; }
    }

    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var f = candidates[i];
      var score = (checkParity(raw, f) === true ? 0 : 1) * 1000 + f.bits;
      if (!best || score < best.score) { best = { score: score, id: f.id }; }
    }
    return best.id;
  }

  /** Every other format the value could plausibly be, for the "or is it..." row. */
  function alternates(raw, chosenId, limit) {
    var need = bitLength(raw);
    var out = [];
    for (var i = 0; i < FORMATS.length && out.length < (limit || 3); i++) {
      var f = FORMATS[i];
      if (f.id === 'raw' || f.id === chosenId || f.bits < need) { continue; }
      out.push(decode(raw, f.id));
    }
    return out;
  }

  var SPLIT_RE = /^(\d+)\s*[,;:\/\|\- \t]\s*(\d+)$/;

  /**
   * Turn whatever the reader typed/sent into a raw value.
   *
   * mode: 'auto' | 'hex' | 'dec' | 'split' | 'cn'
   *  - split: the reader already separated facility code and card number
   *  - cn:    the reader sends only a card number, no facility code
   */
  function parseScan(text, mode) {
    if (text == null) { return null; }
    var s = String(text).trim().replace(/^0[xX]/, '');
    if (!s) { return null; }
    mode = mode || 'auto';

    var split = SPLIT_RE.exec(s);
    if (mode === 'split' || (mode === 'auto' && split)) {
      if (!split) { return null; }
      return { kind: 'split', fc: BigInt(split[1]), cn: BigInt(split[2]) };
    }

    s = s.replace(/[\s_\-]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(s)) { return null; }

    if (mode === 'cn') {
      if (!/^\d+$/.test(s)) { return null; }
      return { kind: 'cn', cn: BigInt(s) };
    }

    // In auto mode a string of pure digits is read as decimal. A hex value that
    // happens to contain no A-F is ambiguous and will land here; that is what
    // the explicit 'hex' mode is for.
    var isHex = mode === 'hex' || (mode === 'auto' && /[a-fA-F]/.test(s));
    if (isHex) {
      return { kind: 'raw', raw: BigInt('0x' + s), containerBits: s.length * 4 };
    }
    if (!/^\d+$/.test(s)) { return null; }
    return { kind: 'raw', raw: BigInt(s), containerBits: 0 };
  }

  /** Big-endian bytes (a WebHID input report) -> one raw value. */
  function bytesToValue(bytes) {
    var value = 0n;
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8n) | BigInt(bytes[i] & 0xff);
    }
    return value;
  }

  return {
    FORMATS: FORMATS,
    byId: byId,
    decode: decode,
    detect: detect,
    alternates: alternates,
    parseScan: parseScan,
    bytesToValue: bytesToValue,
    bitLength: bitLength,
    checkParity: checkParity,
    toHex: toHex
  };
});
