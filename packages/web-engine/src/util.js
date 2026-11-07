// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Small internal helpers shared by the modules (not part of the public API).

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// "NaN or a non-number makes the call a no-op" (DESIGN §5.2): ±Infinity is a
// number and gets clamped like any other out-of-range value.
export const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

export const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// Duck typing: works for real AudioBuffers and for the test fakes.
export function isAudioBufferLike(b) {
  return !!b && typeof b === 'object'
    && typeof b.getChannelData === 'function'
    && typeof b.sampleRate === 'number'
    && typeof b.duration === 'number'
    && typeof b.numberOfChannels === 'number';
}

export function errorMessage(e) {
  return String((e && e.message) || e);
}

export function toError(e) {
  return e instanceof Error ? e : new Error(errorMessage(e));
}

// Median of the intervals of a beat list -> BPM (3 decimals), or null.
export function bpmFromBeats(beats) {
  if (!beats || beats.length < 2) return null;
  const ds = [];
  for (let i = 1; i < beats.length; i++) ds.push(beats[i] - beats[i - 1]);
  ds.sort((a, b) => a - b);
  const med = ds[ds.length >> 1];
  return med > 0 ? Math.round((60 / med) * 1000) / 1000 : null;
}

// Error named 'AbortError' (DESIGN §5.5 loadFrom).
export function abortError(message = 'The load was aborted') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

// --- Permanent sources (web-engine) ---
// The engine's permanent sources (the color-FX noise, the LFOs and the gate
// source of every FX unit, the ramps of the fallback shifters) are started
// when they are built. On a realtime context that has not started yet
// (autoplay policy: an engine created before the first user gesture), Chrome
// logs "The AudioContext was not allowed to start" for EVERY start(): 45
// warnings for a default engine. There they start on the context's first
// 'running' state instead. An OfflineAudioContext stays 'suspended' until it
// renders: its sources start at once, as before.
const pendingStarts = new WeakMap(); // context → { nodes: Map<source, when>, onState }

const waitsForRunning = (ctx) => typeof ctx.startRendering !== 'function'
  && (ctx.state === 'suspended' || ctx.state === 'interrupted');

/**
 * source.start(when), now or on the context's first 'running' state (see above).
 * @param {BaseAudioContext} ctx
 * @param {AudioScheduledSourceNode} node
 * @param {number} [when=0] context time
 */
export function startSource(ctx, node, when = 0) {
  if (!waitsForRunning(ctx)) {
    node.start(when);
    return;
  }
  let p = pendingStarts.get(ctx);
  if (!p) {
    p = { nodes: new Map(), onState: () => flushStarts(ctx) };
    pendingStarts.set(ctx, p);
    if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', p.onState);
  }
  p.nodes.set(node, when);
}

function forgetStarts(ctx, p) {
  pendingStarts.delete(ctx);
  if (typeof ctx.removeEventListener === 'function') ctx.removeEventListener('statechange', p.onState);
}

/**
 * Starts the pending sources of a context once it runs (forgets them once it
 * is closed). Called on 'statechange', and by Engine.resume() and tick() for
 * browsers that do not dispatch it.
 * @param {BaseAudioContext} ctx
 */
export function flushStarts(ctx) {
  const p = pendingStarts.get(ctx);
  if (!p || (ctx.state !== 'running' && ctx.state !== 'closed')) return;
  forgetStarts(ctx, p);
  if (ctx.state === 'closed') return;
  for (const [node, when] of p.nodes) {
    try { node.start(when); } catch { /* already started or stopped */ }
  }
}

/**
 * Forgets a source whose start is still pending.
 * @returns {boolean} true if it was pending: it never played, there is nothing to stop
 */
export function cancelStart(ctx, node) {
  const p = pendingStarts.get(ctx);
  if (!p || !p.nodes.delete(node)) return false;
  if (!p.nodes.size) forgetStarts(ctx, p);
  return true;
}

/** Stops a source now, or cancels its pending start. Never throws. */
export function stopSource(ctx, node) {
  if (cancelStart(ctx, node)) return;
  try { node.stop(); } catch { /* never started, or already stopped */ }
}
