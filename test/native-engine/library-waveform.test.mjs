// Small pieces of library.js and waveform.js changed for the native engine (owner: jsproxy,
// native/engine/SPEC.md §7.2.2, §17.8): the bit depth sniffed from lossless
// headers (hi-res tracks stored as float32 by the engine) and the extreme
// zoom without a sample buffer (RAM phase 3).
import test from 'node:test';
import assert from 'node:assert/strict';

if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const { sniffBitsPerSample } = await import('../../src/js/library.js');

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const le16 = (v) => [v & 255, (v >> 8) & 255];
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const be16 = (v) => [(v >> 8) & 255, v & 255];
const be32 = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
const pad = (a, n = 64) => Uint8Array.from([...a, ...new Array(n).fill(0)]);

function wav(fmt, bits, valid) {
  const ext = fmt === 0xfffe;
  const fmtBody = [...le16(fmt), ...le16(2), ...le32(48000), ...le32(48000 * 2 * bits / 8), ...le16(2 * bits / 8), ...le16(bits),
    ...(ext ? [...le16(22), ...le16(valid), ...le32(3), ...new Array(16).fill(0)] : [])];
  return pad([...ascii('RIFF'), ...le32(100), ...ascii('WAVE'), ...ascii('LIST'), ...le32(4), ...ascii('INFO'),
    ...ascii('fmt '), ...le32(fmtBody.length), ...fmtBody, ...ascii('data'), ...le32(0)]);
}

function flac(bits, id3 = false) {
  // STREAMINFO: min/max block 4096, frame sizes 0, then 48000 Hz, 2 channels, `bits`
  const rate = 48000;
  const ch = 1;   // channels - 1
  const b = bits - 1;
  const packed = [(rate >> 12) & 255, (rate >> 4) & 255, ((rate & 15) << 4) | (ch << 1) | (b >> 4), ((b & 15) << 4)];
  const body = [...be16(4096), ...be16(4096), 0, 0, 0, 0, 0, 0, ...packed, 0, 0, 0, 0, ...new Array(16).fill(0)];
  const head = id3 ? [...ascii('ID3'), 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)] : [];
  return pad([...head, ...ascii('fLaC'), 0x80, 0, 0, 34, ...body]);
}

function aiff(bits) {
  return pad([...ascii('FORM'), ...be32(100), ...ascii('AIFF'), ...ascii('COMM'), ...be32(18), ...be16(2), ...be32(1000), ...be16(bits),
    0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
}

test('bit depth from lossless headers; lossy formats -> null', () => {
  assert.equal(sniffBitsPerSample(wav(1, 16)), 16);
  assert.equal(sniffBitsPerSample(wav(1, 24)), 24);
  assert.equal(sniffBitsPerSample(wav(3, 32)), 32, 'IEEE float');
  assert.equal(sniffBitsPerSample(wav(0xfffe, 32, 24)), 24, 'extensible: valid bits');
  assert.equal(sniffBitsPerSample(flac(16)), 16);
  assert.equal(sniffBitsPerSample(flac(24)), 24);
  assert.equal(sniffBitsPerSample(flac(24, true)), 24, 'ID3 in front of a FLAC');
  assert.equal(sniffBitsPerSample(aiff(24)), 24);
  assert.equal(sniffBitsPerSample(pad([0xff, 0xfb, 0x90, 0x64])), null, 'MP3');
  assert.equal(sniffBitsPerSample(pad(ascii('OggS'))), null);
  assert.equal(sniffBitsPerSample(new Uint8Array(4)), null);
});
