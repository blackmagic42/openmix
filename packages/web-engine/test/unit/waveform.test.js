// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Waveform drawing in Node with a fake canvas (DESIGN §5.9): no expando
// properties (WeakMap caches), hidden canvases, palettes, DeckView objects.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { drawZoom, drawOverview, fitCanvas, WAVE_PALETTES } from '../../src/waveform/index.js';

// A 2D context that counts the drawing calls
function fake2d(canvas) {
  const calls = { fillRect: 0, drawImage: 0, fillText: 0, clearRect: 0 };
  return {
    canvas,
    calls,
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    fillRect() { calls.fillRect++; },
    clearRect() { calls.clearRect++; },
    drawImage() { calls.drawImage++; },
    fillText() { calls.fillText++; },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    save() {},
    restore() {},
    translate() {}
  };
}

function fakeCanvas(w = 200, h = 40) {
  const c = { clientWidth: w, clientHeight: h, width: 0, height: 0, getCalls: 0 };
  const g = fake2d(c);
  c.getContext = () => { c.getCalls++; return g; };
  c.ctx2d = g;
  return c;
}

class FakeOffscreenCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.g = fake2d(this);
  }

  getContext() { return this.g; }
}

const savedOC = globalThis.OffscreenCanvas;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
after(() => {
  if (savedOC) globalThis.OffscreenCanvas = savedOC;
  else delete globalThis.OffscreenCanvas;
});

function peaks(seconds = 10, perSecond = 400) {
  const n = seconds * perSecond;
  const f = (k) => new Float32Array(n).map((_, i) => k * Math.abs(Math.sin(i / 30)));
  return {
    top: f(0.8), bottom: f(-0.8), low: f(0.5), mid: f(0.3), high: f(0.2),
    fineTop: new Int8Array(seconds * 4000).fill(60), fineBottom: new Int8Array(seconds * 4000).fill(-60),
    finePps: 4000, perSecond, duration: seconds
  };
}

const view = (extra = {}) => ({
  peaks: peaks(), position: 4, cuePoint: 2, hotCues: [1, null, 5.5],
  loop: { active: true, start: 3, end: 5, inPoint: null },
  bpm: 120, beats: Array.from({ length: 20 }, (_, k) => k * 0.5), barAnchor: 0, ...extra
});

test('drawZoom / drawOverview draw a DeckView, cache in WeakMaps (no expandos)', () => {
  const canvas = fakeCanvas();
  const keys = Object.keys(canvas).sort();
  drawZoom(canvas, view());
  drawZoom(canvas, view({ position: 4.01 }));
  assert.equal(canvas.width, 200);
  assert.ok(canvas.ctx2d.calls.drawImage >= 2, 'GPU copies of the strip');
  assert.ok(canvas.ctx2d.calls.fillText > 0, 'IN / OUT / CUE / hot-cue letters');
  drawOverview(canvas, view(), { palette: 'club' });
  drawOverview(canvas, view({ position: 6 }), { palette: 'club' });
  assert.deepEqual(Object.keys(canvas).sort(), keys, 'no expando property on the canvas');
  for (const p of WAVE_PALETTES) drawZoom(canvas, view(), { palette: p, windowSeconds: 4 });
  // fine and raw-sample zoom levels
  drawZoom(canvas, view(), { windowSeconds: 0.3 });
  drawZoom(canvas, view({ buffer: { sampleRate: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(80000) } }),
    { windowSeconds: 0.01 });
  // fixed grid and a plain currentTime() view
  drawZoom(canvas, { peaks: peaks(), currentTime: () => 3, bpm: 128, beatOffset: 0.1 }, { time: 2 });
});

test('hidden (zero-size) canvases draw nothing and never throw; bad palettes throw RangeError', () => {
  const hidden = fakeCanvas(0, 0);
  drawZoom(hidden, view());
  drawOverview(hidden, view());
  assert.equal(hidden.getCalls, 0);
  assert.equal(fitCanvas(hidden), false);
  const c = fakeCanvas(100, 10);
  drawZoom(c, { peaks: null });
  assert.throws(() => drawZoom(c, view(), { palette: 'sepia' }), RangeError);
  assert.throws(() => drawOverview(c, view(), { palette: 'sepia' }), RangeError);
});

test('fitCanvas: CSS size × devicePixelRatio', () => {
  const saved = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    const c = fakeCanvas(50, 20);
    assert.equal(fitCanvas(c), true);
    assert.deepEqual([c.width, c.height], [100, 40]);
    assert.equal(fitCanvas(c), false);
  } finally {
    if (saved === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = saved;
  }
});
