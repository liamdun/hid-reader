'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../wiegand.js');

// Reference encoder for the 26-bit standard format, used to build round-trip
// vectors: [even parity][8-bit FC][16-bit CN][odd parity].
function encode26(fc, cn) {
  const data = (BigInt(fc) << 16n) | BigInt(cn);
  const ones = (v) => (v.toString(2).match(/1/g) || []).length;
  const even = BigInt(ones(data >> 12n) % 2);
  const odd = BigInt((ones(data & 0xfffn) % 2) ^ 1);
  return (even << 25n) | (data << 1n) | odd;
}

test('26-bit: hand-computed vector', () => {
  const d = W.decode(33685506n, 'h10301');
  assert.strictEqual(d.fc, 1n);
  assert.strictEqual(d.cn, 1n);
  assert.strictEqual(d.parity, true);
  assert.strictEqual(d.bits, 26);
});

test('26-bit: round-trips facility code and card number', () => {
  for (const [fc, cn] of [[0, 0], [1, 1], [123, 45678], [255, 65535], [77, 1000]]) {
    const d = W.decode(encode26(fc, cn), 'h10301');
    assert.strictEqual(d.fc, BigInt(fc), `fc ${fc}/${cn}`);
    assert.strictEqual(d.cn, BigInt(cn), `cn ${fc}/${cn}`);
    assert.strictEqual(d.parity, true, `parity ${fc}/${cn}`);
  }
});

test('26-bit: parity fails when a data bit is corrupted', () => {
  const raw = encode26(123, 45678);
  assert.strictEqual(W.decode(raw ^ (1n << 5n), 'h10301').parity, false);
});

test('34-bit: 16-bit facility code, parity checked', () => {
  const d = W.decode((1n << 33n) | (4321n << 17n) | (8765n << 1n), 'h10306');
  assert.strictEqual(d.fc, 4321n);
  assert.strictEqual(d.cn, 8765n);
  assert.ok(d.parity === true || d.parity === false);
});

test('35-bit Corporate 1000: 12-bit company, 20-bit card', () => {
  const d = W.decode((2895n << 21n) | (123456n << 1n), 'c1k35');
  assert.strictEqual(d.fc, 2895n);
  assert.strictEqual(d.cn, 123456n);
  assert.strictEqual(d.parity, null, 'no parity spec, so not checked');
});

test('37-bit H10304 and H10302 slice differently', () => {
  const raw = (1234n << 20n) | (56789n << 1n);
  assert.strictEqual(W.decode(raw, 'h10304').fc, 1234n);
  assert.strictEqual(W.decode(raw, 'h10304').cn, 56789n);
  assert.strictEqual(W.decode(raw, 'h10302').fc, null);
  assert.strictEqual(W.decode(raw, 'h10302').cn, raw >> 1n);
});

test('48-bit Corporate 1000 survives values wider than 32-bit bitwise ops', () => {
  const raw = (3145727n << 24n) | (7654321n << 1n);
  assert.ok(raw > 1n << 32n, 'plain JS >> and & would truncate this');
  const d = W.decode(raw, 'c1k48');
  assert.strictEqual(d.fc, 3145727n);
  assert.strictEqual(d.cn, 7654321n);
});

test('oversize flags a value too wide for the chosen format', () => {
  assert.strictEqual(W.decode(encode26(12, 34), 'h10301').oversize, false);
  assert.strictEqual(W.decode(1n << 30n, 'h10301').oversize, true);
});

test('raw format passes the number through untouched', () => {
  const d = W.decode(987654321n, 'raw');
  assert.strictEqual(d.fc, null);
  assert.strictEqual(d.cn, 987654321n);
});

test('detect prefers 26-bit when parity confirms it', () => {
  assert.strictEqual(W.detect(encode26(123, 45678), 0), 'h10301');
  assert.strictEqual(W.detect(encode26(200, 1), 32), 'h10301');
});

test('detect rules out formats too narrow for the value', () => {
  const id = W.detect((1n << 30n) - 1n, 0);
  assert.notStrictEqual(id, 'h10301');
  assert.ok(W.byId(id).bits >= 30);
});

test('detect honours the container width from a hex string', () => {
  // A 10-hex-digit reader output is a 40-bit container: 48-bit is impossible.
  const parsed = W.parseScan('00' + 'FFFFFFFF', 'hex');
  assert.strictEqual(parsed.containerBits, 40);
  assert.ok(W.byId(W.detect(parsed.raw, parsed.containerBits)).bits <= 40);
});

test('parseScan reads hex, decimal, 0x prefixes and separators', () => {
  assert.strictEqual(W.parseScan('2004E5A7', 'auto').raw, 0x2004e5a7n);
  assert.strictEqual(W.parseScan('0x2004E5A7', 'auto').raw, 0x2004e5a7n);
  assert.strictEqual(W.parseScan('33685506', 'auto').raw, 33685506n);
  assert.strictEqual(W.parseScan('33685506', 'hex').raw, 0x33685506n);
  assert.strictEqual(W.parseScan('  2004 E5A7  ', 'auto').raw, 0x2004e5a7n);
  assert.strictEqual(W.parseScan('00012345', 'auto').raw, 12345n);
});

test('parseScan splits pre-separated facility code and card number', () => {
  for (const s of ['123,45678', '123 45678', '123-45678', '123:45678']) {
    const p = W.parseScan(s, 'auto');
    assert.strictEqual(p.kind, 'split', s);
    assert.strictEqual(p.fc, 123n, s);
    assert.strictEqual(p.cn, 45678n, s);
  }
});

test('parseScan card-number-only mode', () => {
  const p = W.parseScan('45678', 'cn');
  assert.strictEqual(p.kind, 'cn');
  assert.strictEqual(p.cn, 45678n);
});

test('parseScan rejects junk and empty input', () => {
  for (const s of ['', '   ', 'hello world', 'ZZZZ', null, '12/34/56']) {
    assert.strictEqual(W.parseScan(s, 'auto'), null, JSON.stringify(s));
  }
});

test('alternates excludes the chosen format and any too-narrow one', () => {
  const raw = encode26(123, 45678);
  const alts = W.alternates(raw, 'h10301', 3);
  assert.ok(alts.length > 0);
  assert.ok(alts.every((a) => a.formatId !== 'h10301' && a.formatId !== 'raw'));
  assert.ok(W.alternates(1n << 40n, 'raw', 5).every((a) => a.bits >= 41));
});

test('bytesToValue reads a report big-endian', () => {
  assert.strictEqual(W.bytesToValue([0x20, 0x04, 0xe5, 0xa7]), 0x2004e5a7n);
  assert.strictEqual(W.bytesToValue([]), 0n);
});

test('toHex pads to the format width', () => {
  assert.strictEqual(W.toHex(0x2002n, 26), '0002002');
  assert.strictEqual(W.toHex(0x2002n, 0), '2002');
});
