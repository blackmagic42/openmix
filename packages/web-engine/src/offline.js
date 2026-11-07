// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// renderOffline(): renders an engine built on an OfflineAudioContext, with
// engine.tick() called at a fixed rate on the AUDIO timeline (DESIGN §5.11).
// Silent by construction: the whole mix goes to the rendered buffer. This is
// how the sync lock, the FX alignment and every control step can be tested
// deterministically, faster than real time.

import { Engine } from './engine.js';
import { isNum } from './util.js';

// Contexts already rendered (an OfflineAudioContext renders only once)
const rendered = new WeakSet();

// Render quantum of the Web Audio API (frames)
const QUANTUM = 128;

/**
 * Renders the engine's OfflineAudioContext, calling engine.tick() (then
 * `await onTick(time)`, then context.resume()) at every tick time:
 * k / tickRate, rounded up to a render-quantum boundary, strictly increasing,
 * below the end of the render. The next suspend is scheduled from inside the
 * handler, so long renders never queue thousands of suspends.
 * @param {Engine} engine an engine on an OfflineAudioContext that has not rendered yet
 * @param {{ tickRate?: number, onTick?: (time: number) => void | Promise<void> }} [options]
 *   tickRate default 60 (0 = no ticks)
 * @returns {Promise<AudioBuffer>} the result of startRendering()
 */
export function renderOffline(engine, options = {}) {
  if (!(engine instanceof Engine)) throw new TypeError('renderOffline: expected an Engine');
  const ctx = engine.context;
  if (!engine.isOffline) throw new TypeError('renderOffline: the engine must run on an OfflineAudioContext');
  if (rendered.has(ctx) || (ctx.state != null && ctx.state !== 'suspended')) {
    throw new TypeError('renderOffline: this OfflineAudioContext has already rendered (or is rendering)');
  }
  const o = options && typeof options === 'object' ? options : {};
  const tickRate = o.tickRate === undefined ? 60 : o.tickRate;
  if (!isNum(tickRate) || tickRate < 0 || !Number.isFinite(tickRate)) {
    throw new RangeError(`renderOffline: tickRate must be a number >= 0 (got ${String(o.tickRate)})`);
  }
  const onTick = typeof o.onTick === 'function' ? o.onTick : null;
  if (tickRate > 0 && typeof ctx.suspend !== 'function') {
    return Promise.reject(new Error(
      'renderOffline: OfflineAudioContext.prototype.suspend is not supported by this browser, so the engine '
      + 'cannot tick during the render. Pass { tickRate: 0 } to render without ticks (no sync lock and no FX '
      + 'beat alignment during the render).'
    ));
  }
  rendered.add(ctx);
  const sr = ctx.sampleRate;
  const total = Number.isFinite(ctx.length) ? ctx.length : Infinity;

  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      reject(e);
    };

    // Tick frames: k / tickRate rounded UP to the render quantum, deduplicated
    let k = 0;
    let lastFrame = -1;
    const nextFrame = () => {
      for (;;) {
        k += 1;
        const frame = Math.ceil(((k / tickRate) * sr) / QUANTUM - 1e-9) * QUANTUM;
        if (frame >= total) return null;
        if (frame > lastFrame) {
          lastFrame = frame;
          return frame;
        }
      }
    };

    const schedule = (frame) => {
      const time = frame / sr;
      let p;
      try {
        p = ctx.suspend(time);
      } catch (e) {
        fail(e);
        return;
      }
      Promise.resolve(p).then(async () => {
        try {
          if (failed) return;
          engine.tick();
          if (onTick) await onTick(time);
          // lazy scheduling: the next suspend is set from inside the handler
          const next = nextFrame();
          if (next != null) schedule(next);
        } catch (e) {
          fail(e);
        } finally {
          // the render always goes on (even after a failure: the context
          // must not stay suspended forever)
          try {
            Promise.resolve(ctx.resume()).catch(fail);
          } catch (e) {
            fail(e);
          }
        }
      }, fail);
    };

    if (tickRate > 0) {
      const first = nextFrame();
      if (first != null) schedule(first);
    }
    let result;
    try {
      result = ctx.startRendering();
    } catch (e) {
      fail(e);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then((buffer) => { if (!failed) resolve(buffer); }, fail);
    } else {
      // (older implementations: the 'complete' event)
      ctx.oncomplete = (ev) => { if (!failed) resolve(ev.renderedBuffer); };
    }
  });
}
