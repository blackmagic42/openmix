// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Waveform drawing: scrolling zoom and whole-track overview, same rendering
// as OpenMix (3-band colors, beat grid, loop band with IN/OUT flags, CUE
// marker, lettered hot-cue flags, played part at full intensity).
//
// web-engine: no module globals and no expando properties — the palette is
// a per-call option, the canvas caches live in WeakMaps keyed by canvas,
// browser globals are read lazily (the module imports in Node), and the
// off-screen buffers use OffscreenCanvas when available.

import { gridIndexFracAt, gridTimeAtIndex } from '../grid.js';
import { HOT_CUE_COLORS } from '../constants.js';

/** The available waveform palettes. */
export const WAVE_PALETTES = Object.freeze(['rgb', 'mono', 'blueorange', 'neon', 'club']);

const PAL_SETS = {
  blueorange: [[40, 115, 255], [255, 150, 40], [235, 240, 255]],
  neon: [[255, 45, 150], [80, 255, 160], [90, 200, 255]],
  // "Club" palette: deep blue lows, amber mids, white highs
  club: [[25, 70, 255], [255, 170, 70], [246, 248, 255]]
};

function paletteOf(options) {
  const p = options && options.palette !== undefined ? options.palette : 'rgb';
  if (!WAVE_PALETTES.includes(p)) throw new RangeError(`Unknown waveform palette: ${String(p)}`);
  return p;
}

function waveColor(l, m, h, palette) {
  const mx = Math.max(l, m, h, 1e-6);
  if (palette === 'mono') return 'rgb(168,190,215)';
  if (palette === 'rgb') {
    return `rgb(${Math.round((l / mx) * 255)},${Math.round((m / mx) * 255)},${Math.round((h / mx) * 255)})`;
  }
  if (palette === 'club') {
    // SQUARED weights: the dominant band imposes its color (the kick is
    // CLEARLY blue, the hats CLEARLY white) instead of a washed-out
    // average blend
    const C = PAL_SETS.club;
    const wl = (l / mx) ** 2, wm = (m / mx) ** 2, wh = (h / mx) ** 2;
    const sum = wl + wm + wh || 1;
    const r = Math.round((C[0][0] * wl + C[1][0] * wm + C[2][0] * wh) / sum);
    const g = Math.round((C[0][1] * wl + C[1][1] * wm + C[2][1] * wh) / sum);
    const b = Math.round((C[0][2] * wl + C[1][2] * wm + C[2][2] * wh) / sum);
    return `rgb(${r},${g},${b})`;
  }
  const C = PAL_SETS[palette] || PAL_SETS.blueorange;
  const wl = l / mx, wm = m / mx, wh = h / mx;
  const sum = wl + wm + wh || 1;
  const r = Math.round((C[0][0] * wl + C[1][0] * wm + C[2][0] * wh) / sum);
  const g = Math.round((C[0][1] * wl + C[1][1] * wm + C[2][1] * wh) / sum);
  const b = Math.round((C[0][2] * wl + C[1][2] * wm + C[2][2] * wh) / sum);
  return `rgb(${r},${g},${b})`;
}

function drawCueMarkers(ctx, deck, xOf, H, withLabels) {
  if (!deck.hotCues) return;
  deck.hotCues.forEach((c, idx) => {
    if (c == null) return;
    const x = xOf(c);
    if (x < -10 || x > ctx.canvas.width + 10) return;
    ctx.fillStyle = HOT_CUE_COLORS[idx % HOT_CUE_COLORS.length];
    ctx.fillRect(x - 1, 0, 2, H);
    // Small flag at the top
    ctx.beginPath();
    ctx.moveTo(x - 1, 0);
    ctx.lineTo(x + 9, 0);
    ctx.lineTo(x - 1, 9);
    ctx.closePath();
    ctx.fill();
    if (withLabels) {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 8px sans-serif';
      ctx.fillText(String.fromCharCode(65 + idx), x + 1, 7);
    }
  });
}

/**
 * Sizes the canvas backing store to its CSS size × devicePixelRatio.
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean} true if the canvas was resized
 */
export function fitCanvas(canvas) {
  if (!canvas) return false;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = Math.round((canvas.clientWidth || 0) * dpr);
  const h = Math.round((canvas.clientHeight || 0) * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

// Off-screen buffer: OffscreenCanvas when available (and able to give a 2D
// context), otherwise a detached <canvas>.
function makeBuffer(w, h) {
  const OC = globalThis.OffscreenCanvas;
  if (typeof OC === 'function') {
    try {
      const cv = new OC(w, h);
      const g = cv.getContext('2d');
      if (g) return { cv, g };
    } catch { /* fall back to a <canvas> */ }
  }
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') return null;
  const cv = doc.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  return g ? { cv, g } : null;
}

function resizeBuffer(buf, w, h) {
  buf.cv.width = w;
  buf.cv.height = h;
}

// Position to draw: options.time, else the first defined of
// displayPosition / position / currentTime() (DESIGN §5.9 DeckView)
function timeOf(deck, options) {
  if (options && typeof options.time === 'number') return options.time;
  if (typeof deck.displayPosition === 'number') return deck.displayPosition;
  if (typeof deck.position === 'number') return deck.position;
  if (typeof deck.currentTime === 'function') return deck.currentTime();
  return 0;
}

// Aggregates the buckets covering [b0, b1) and draws a 1 px column.
function drawColumn(ctx, peaks, b0, b1, x, mid, scaleY, palette) {
  let hi = 0, lo = 0, l = 0, m = 0, h = 0;
  for (let b = b0; b < b1; b++) {
    if (peaks.top[b] > hi) hi = peaks.top[b];
    if (peaks.bottom[b] < lo) lo = peaks.bottom[b];
    if (peaks.low[b] > l) l = peaks.low[b];
    if (peaks.mid[b] > m) m = peaks.mid[b];
    if (peaks.high[b] > h) h = peaks.high[b];
  }
  ctx.fillStyle = waveColor(l, m, h, palette);
  const y0 = mid - hi * scaleY;
  const y1 = mid - lo * scaleY;
  ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
}

// Pre-rendered strips of drawZoom and caches of drawOverview, per canvas
const zoomStrips = new WeakMap();
const overviewCaches = new WeakMap();

// Scrolling zoomed view: a `windowSeconds` s window, drawn per pixel column.
// options.time: position to display IF different from the playhead —
// during a V.BRAKE/BACKSPIN, deck.displayPosition already shows the VIRTUAL
// position (the track "keeps going" underneath), not the audible rewind.
/**
 * Draws the scrolling zoom view centered on the position. The playhead line
 * is NOT drawn: draw it at the horizontal center.
 * @param {HTMLCanvasElement} canvas
 * @param {object} deck a Deck or any DeckView object
 * @param {{ windowSeconds?: number, time?: number, palette?: string }} [options]
 *   windowSeconds default 8; palette default 'rgb'
 */
export function drawZoom(canvas, deck, options = {}) {
  const palette = paletteOf(options);
  if (!canvas || !deck) return;
  const windowSec = options && typeof options.windowSeconds === 'number' && options.windowSeconds > 0
    && options.windowSeconds !== Infinity ? options.windowSeconds : 8;
  fitCanvas(canvas);
  const { width: W, height: H } = canvas;
  if (!W || !H) return; // hidden deck (2-deck mode): nothing to draw
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const peaks = deck.peaks;
  if (!peaks) return;

  const time = timeOf(deck, options);
  const pps = peaks.perSecond;
  const t0 = time - windowSec / 2;
  const spx = windowSec / W; // seconds per pixel
  const mid = H / 2;
  const scaleY = H * 0.47;
  const len = peaks.top.length;
  const playedX = Math.floor((time - t0) / spx);
  // At high zoom: the precomputed FINE envelope (exact min/max per 0.25 ms
  // slice) replaces re-reading the raw samples — same rendering,
  // ~100× less work per frame. Raw samples are now only used
  // for extreme zooms (window < ~0.2 s), where they are cheap.
  const finePps = peaks.finePps || 0;
  const useFine = finePps && spx * pps < 1 && spx * finePps >= 1;
  const useSamples = !useFine && spx * (finePps || pps) < 1 && deck.buffer;

  // ====================================================================
  // PRE-RENDERED STRIP: the wave SCROLLS, its content does not change. We
  // draw it ONCE over 3 screen widths, then each frame simply COPIES the
  // visible slice — an operation accelerated by the graphics card. We go
  // from ~1200 columns computed 30 times per second to one full redraw
  // every ~8 s: this is THE gain for modest machines. The on-screen
  // rendering is strictly identical.
  // ====================================================================
  const paintColumns = (g, gt0, gW) => {
    if (useFine) {
      const fTop = peaks.fineTop;
      const fBot = peaks.fineBottom;
      const fLen = fTop.length;
      for (let x = 0; x < gW; x++) {
        const tA = gt0 + x * spx;
        let b0 = Math.floor(tA * finePps);
        let b1 = Math.max(b0 + 1, Math.ceil((tA + spx) * finePps));
        if (b1 <= 0 || b0 >= fLen) continue;
        if (b0 < 0) b0 = 0;
        if (b1 > fLen) b1 = fLen;
        let hi = -127;
        let lo = 127;
        for (let b = b0; b < b1; b++) {
          if (fTop[b] > hi) hi = fTop[b];
          if (fBot[b] < lo) lo = fBot[b];
        }
        if (hi < lo) continue;
        const cb = Math.min(len - 1, Math.max(0, Math.floor(tA * pps)));
        g.fillStyle = waveColor(peaks.low[cb], peaks.mid[cb], peaks.high[cb], palette);
        const y0 = mid - (hi / 127) * scaleY;
        const y1 = mid - (lo / 127) * scaleY;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else if (useSamples) {
      const buf = deck.buffer;
      const sr = buf.sampleRate;
      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
      const total = ch0.length;
      for (let x = 0; x < gW; x++) {
        const tA = gt0 + x * spx;
        let i0 = Math.floor(tA * sr);
        let i1 = Math.max(i0 + 1, Math.ceil((tA + spx) * sr));
        if (i1 <= 0 || i0 >= total) continue;
        if (i0 < 0) i0 = 0;
        if (i1 > total) i1 = total;
        // ALL the samples of the column: a stride that skips some creates
        // GHOST waves through aliasing — the "multiplying" waves
        // when zooming in. The exact min/max gives the true envelope,
        // identical at every zoom level.
        let hi = -1;
        let lo = 1;
        for (let s = i0; s < i1; s++) {
          const a = ch0[s];
          const b2 = ch1[s];
          const mx = a > b2 ? a : b2;
          const mn = a < b2 ? a : b2;
          if (mx > hi) hi = mx;
          if (mn < lo) lo = mn;
        }
        if (hi < lo) continue;
        const b = Math.min(len - 1, Math.max(0, Math.floor(tA * pps)));
        g.fillStyle = waveColor(peaks.low[b], peaks.mid[b], peaks.high[b], palette);
        const y0 = mid - hi * scaleY;
        const y1 = mid - lo * scaleY;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      for (let x = 0; x < gW; x++) {
        const tA = gt0 + x * spx;
        let b0 = Math.floor(tA * pps);
        let b1 = Math.max(b0 + 1, Math.ceil((tA + spx) * pps));
        if (b1 <= 0 || b0 >= len) continue;
        if (b0 < 0) b0 = 0;
        if (b1 > len) b1 = len;
        drawColumn(g, peaks, b0, b1, x, mid, scaleY, palette);
      }
    }
  };

  // The strip covers 3 screens: as long as the visible window stays inside,
  // NOTHING is recomputed. Signature: everything that changes the drawing.
  const sig = `${W}x${H}|${windowSec}|${palette}|${useFine ? 'f' : useSamples ? 's' : 'b'}|${len}|${peaks.duration}`;
  let strip = zoomStrips.get(canvas);
  // peaks: IDENTITY of the track — a new track must always repaint
  if (!strip || strip.sig !== sig || strip.peaks !== peaks) {
    let buf = strip && strip.buf;
    if (buf) resizeBuffer(buf, W * 3, H);
    else buf = makeBuffer(W * 3, H);
    if (!buf) return; // no 2D off-screen surface available
    strip = { buf, cv: buf.cv, g: buf.g, sig, peaks, t0: NaN, pending: null };
    zoomStrips.set(canvas, strip);
  }
  // Outside the strip (start, jump, fast scratch): re-center it.
  // Only the VISIBLE third is painted RIGHT AWAY; the other two thirds
  // are painted on the following frames, one per frame. Otherwise a full
  // repaint (3 screens of columns) landed all at once every ~8 s and
  // showed up as a micro-hitch in the scrolling.
  if (!(t0 >= strip.t0 && t0 + windowSec <= strip.t0 + windowSec * 3)) {
    strip.t0 = t0 - windowSec;                 // visible window in the center
    strip.g.clearRect(0, 0, W * 3, H);
    strip.g.save();
    strip.g.translate(W, 0);                   // middle third
    paintColumns(strip.g, strip.t0 + windowSec, W);
    strip.g.restore();
    strip.pending = [2, 0];                    // right first (playback direction)
  }
  // One remaining third per frame: the cost is spread out, never a spike
  if (strip.pending && strip.pending.length) {
    const third = strip.pending.shift();
    strip.g.save();
    strip.g.translate(W * third, 0);
    paintColumns(strip.g, strip.t0 + windowSec * third, W);
    strip.g.restore();
  }
  // GPU copy: the ALREADY PLAYED part at full opacity, the upcoming part
  // dimmed — exactly the old rendering, in two calls instead of 1200
  const sx = Math.round((t0 - strip.t0) / spx);
  const pw = Math.max(0, Math.min(W, playedX));
  if (pw > 0) ctx.drawImage(strip.cv, sx, 0, pw, H, 0, 0, pw, H);
  if (pw < W) {
    ctx.globalAlpha = 0.5;
    ctx.drawImage(strip.cv, sx + pw, 0, W - pw, H, pw, 0, W - pw, H);
    ctx.globalAlpha = 1;
  }

  // web-engine: the loop is read from deck.loop ({ active, start, end, inPoint })
  const loop = deck.loop || null;
  // Active loop: orange band + clearly visible IN / OUT flags
  if (loop && loop.active) {
    const x0 = (loop.start - t0) / windowSec * W;
    const x1 = (loop.end - t0) / windowSec * W;
    if (x1 > 0 && x0 < W) {
      ctx.fillStyle = 'rgba(233, 127, 22, 0.25)';
      ctx.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
      ctx.fillStyle = 'rgba(233, 127, 22, 0.95)';
      ctx.fillRect(x0 - 1, 0, 2, H);
      ctx.fillRect(x1 - 1, 0, 2, H);
      ctx.font = '900 9px system-ui';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(x0 - 1, 0, 20, 12);
      ctx.fillRect(x1 - 21, 0, 20, 12);
      ctx.fillStyle = '#ffb054';
      ctx.fillText('IN', x0 + 3, 9);
      ctx.fillText('OUT', x1 - 19, 9);
    }
  }
  // IN point set, waiting for the OUT: lone orange flag
  if (loop && !loop.active && loop.inPoint != null) {
    const xi = (loop.inPoint - t0) / windowSec * W;
    if (xi > -20 && xi < W + 20) {
      ctx.fillStyle = 'rgba(233, 127, 22, 0.95)';
      ctx.fillRect(xi - 1, 0, 2, H);
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(xi - 1, 0, 20, 12);
      ctx.font = '900 9px system-ui';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffb054';
      ctx.fillText('IN', xi + 3, 9);
    }
  }

  // Main CUE POINT (not the hot cues): clearly visible ORANGE marker,
  // flag at the BOTTOM (hot cues use the top) — user feedback: the cue point
  // has to be easy to see.
  // web-engine: a DeckView without a `buffer` field counts as loaded
  const hasTrack = deck.buffer === undefined ? true : !!deck.buffer;
  if (hasTrack && deck.cuePoint != null && deck.cuePoint > 0.005) {
    const xc = (deck.cuePoint - t0) / windowSec * W;
    if (xc > -14 && xc < W + 14) {
      ctx.fillStyle = '#ff9500';
      ctx.fillRect(xc - 1, 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(xc - 7, H);
      ctx.lineTo(xc + 7, H);
      ctx.lineTo(xc, H - 10);
      ctx.closePath();
      ctx.fill();
      ctx.font = '900 8px system-ui';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ff9500';
      ctx.fillText('CUE', xc + 5, H - 3);
    }
  }

  // Beat grid: solid red line on every BAR (4 beats), white ticks on
  // every beat, micro-ticks on the quarters. DYNAMIC GRID if available:
  // each line is placed on the REAL detected beat — no drift possible.
  if (deck.beats && deck.beats.length > 2) {
    const anchor = deck.barAnchor || 0;
    const tick = Math.max(5, H * 0.1);
    const f0 = gridIndexFracAt(deck, t0);
    const avgPx = ((60 / (deck.bpm || 120)) / windowSec) * W;
    const showMicro = avgPx > 34;
    let k = Math.ceil(f0 - 1e-6);
    for (;; k++) {
      const tb = gridTimeAtIndex(deck, k);
      if (tb == null || tb > t0 + windowSec || tb > peaks.duration + 1) break;
      const x = (tb - t0) / windowSec * W;
      if (tb >= 0) {
        const rel = ((k - anchor) % 16 + 16) % 16;
        if (rel === 0) {
          // Start of a PHRASE (every 4 bars): reinforced red line
          ctx.fillStyle = 'rgba(255, 45, 45, 1)';
          ctx.fillRect(x - 1.5, 0, 3, H);
          ctx.fillRect(x - 1.5, 0, 7, 4);
        } else if (rel % 4 === 0) {
          ctx.fillStyle = 'rgba(255, 45, 45, 0.85)';
          ctx.fillRect(x - 1, 0, 2, H);
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.fillRect(x - 0.5, 0, 1, H);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.fillRect(x - 0.5, 0, 1, tick);
          ctx.fillRect(x - 0.5, H - tick, 1, tick);
        }
      }
      if (showMicro) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let q = 1; q < 4; q++) {
          const tq = gridTimeAtIndex(deck, k + q / 4);
          if (tq == null || tq < 0 || tq < t0 || tq > t0 + windowSec) continue;
          const xq = (tq - t0) / windowSec * W;
          ctx.fillRect(xq - 0.5, 0, 1, 6);
          ctx.fillRect(xq - 0.5, H - 6, 1, 6);
        }
      }
    }
  } else if (deck.bpm && deck.beatOffset != null) {
    const period = 60 / deck.bpm;
    const tick = Math.max(5, H * 0.1);
    const beatPx = period / windowSec * W;
    const showMicro = beatPx > 34; // micro-segments visible when zoomed in
    let k = Math.ceil((t0 - deck.beatOffset) / period - 1e-6) - 1;
    for (;; k++) {
      const tb = deck.beatOffset + k * period;
      if (tb > t0 + windowSec) break;
      if (tb > peaks.duration) break;
      const x = (tb - t0) / windowSec * W;
      if (tb >= 0) {
        if (((k % 4) + 4) % 4 === 0) {
          ctx.fillStyle = 'rgba(255, 45, 45, 0.95)';
          ctx.fillRect(x - 1, 0, 2, H);
        } else {
          // Segment (beat): thin line over the full height + marked ticks
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.fillRect(x - 0.5, 0, 1, H);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.fillRect(x - 0.5, 0, 1, tick);
          ctx.fillRect(x - 0.5, H - tick, 1, tick);
        }
      }
      if (showMicro) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let q = 1; q < 4; q++) {
          const tq = tb + q * period / 4;
          if (tq < 0 || tq < t0 || tq > t0 + windowSec || tq > peaks.duration) continue;
          const xq = (tq - t0) / windowSec * W;
          ctx.fillRect(xq - 0.5, 0, 1, 6);
          ctx.fillRect(xq - 0.5, H - 6, 1, 6);
        }
      }
    }
  }

  // Hot cue markers (with their letter)
  drawCueMarkers(ctx, deck, (c) => (c - t0) / windowSec * W, H, true);
  // (the playhead is drawn by the caller: a line at the horizontal center)
}

// Overview: full rendering cached off-screen (one column per pixel),
// then shown on every frame (played part at full intensity).
/**
 * Draws the whole-track overview with the played part at full intensity and a white playhead.
 * @param {HTMLCanvasElement} canvas
 * @param {object} deck a Deck or any DeckView object
 * @param {{ time?: number, palette?: string }} [options] palette default 'rgb'
 */
export function drawOverview(canvas, deck, options = {}) {
  const palette = paletteOf(options);
  if (!canvas || !deck) return;
  const resized = fitCanvas(canvas);
  const { width: W, height: H } = canvas;
  // Hidden deck (2-deck mode): a 0-width cache would make
  // drawImage crash → dead render loop → the whole app frozen
  if (!W || !H) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const peaks = deck.peaks;
  if (!peaks) return;

  let cache = overviewCaches.get(canvas);
  if (!cache || cache.peaks !== peaks || cache.palette !== palette || resized
      || cache.buf.cv.width !== W || cache.buf.cv.height !== H) {
    const buf = cache ? cache.buf : makeBuffer(W, H);
    if (!buf) return; // no 2D off-screen surface available
    if (cache) resizeBuffer(buf, W, H);
    const octx = buf.g;
    octx.clearRect(0, 0, W, H);
    const mid = H / 2;
    const scaleY = H * 0.45;
    const len = peaks.top.length;
    for (let x = 0; x < W; x++) {
      let b0 = Math.floor((x / W) * len);
      let b1 = Math.max(b0 + 1, Math.floor(((x + 1) / W) * len));
      if (b1 > len) b1 = len;
      drawColumn(octx, peaks, b0, b1, x, mid, scaleY, palette);
    }
    cache = { buf, peaks, palette };
    overviewCaches.set(canvas, cache);
  }

  const time = timeOf(deck, options);
  const progressX = Math.round((time / peaks.duration) * W);

  ctx.globalAlpha = 0.4;
  ctx.drawImage(cache.buf.cv, 0, 0);
  ctx.globalAlpha = 1;
  if (progressX > 0) {
    ctx.drawImage(cache.buf.cv, 0, 0, progressX, H, 0, 0, progressX, H);
  }

  // Active loop: orange band
  const loop = deck.loop || null;
  if (loop && loop.active) {
    const x0 = (loop.start / peaks.duration) * W;
    const x1 = (loop.end / peaks.duration) * W;
    ctx.fillStyle = 'rgba(233, 127, 22, 0.35)';
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), H);
  }

  // Hot cue markers on the thumbnail (with their letter)
  drawCueMarkers(ctx, deck, (c) => (c / peaks.duration) * W, H, true);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(progressX - 1, 0, 2, H);
}
