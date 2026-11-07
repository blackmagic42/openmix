// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §17):
// the browser globals the proxy uses, gathered in one injectable object so
// that every part of the proxy runs under `node --test` with fakes (no
// Electron, no audio). Nothing here touches a browser global at import time.

/** Wraps a Storage so that a blocked or missing localStorage never throws. */
export function safeStorage(s) {
  return {
    get(key) {
      try { return s ? s.getItem(key) : null; } catch { return null; }
    },
    set(key, value) {
      try { if (s) s.setItem(key, String(value)); } catch { /* storage unavailable */ }
    },
    remove(key) {
      try { if (s) s.removeItem(key); } catch { /* storage unavailable */ }
    },
    getJson(key, def = null) {
      try {
        const v = s ? s.getItem(key) : null;
        return v == null ? def : (JSON.parse(v) ?? def);
      } catch { return def; }
    },
    setJson(key, value) {
      try {
        if (!s) return;
        if (value == null) s.removeItem(key);
        else s.setItem(key, JSON.stringify(value));
      } catch { /* storage unavailable */ }
    }
  };
}

/**
 * The environment of the proxy. Every field can be overridden (tests):
 *   now()            milliseconds, monotonic (performance.now)
 *   setTimeout / clearTimeout / setInterval / clearInterval / queueMicrotask
 *   storage          safeStorage(localStorage)
 *   omEngine         the preload's window.omEngine (SPEC.md §6.5), or null
 *   win              the window (receives the 'openmix-engine-ports' message)
 *   api              the preload's window.api (readFile, stemsSeparate, vstListFiles...)
 *   mediaDevices     navigator.mediaDevices (enumerateDevices)
 *   OfflineAudioContext
 *   AudioEngine      the Web engine class (fallback), default: engine.js
 *   VstHost          the Web VST host class (fallback), default: vst.js
 *   log              console-like ({ log, warn, error })
 */
export function makeEnv(over = {}) {
  const g = globalThis;
  const has = (k) => Object.prototype.hasOwnProperty.call(over, k);
  const win = has('win') ? over.win : (typeof g.window !== 'undefined' ? g.window : null);
  return {
    now: over.now || (() => g.performance.now()),
    setTimeout: over.setTimeout || ((f, ms) => g.setTimeout(f, ms)),
    clearTimeout: over.clearTimeout || ((h) => g.clearTimeout(h)),
    setInterval: over.setInterval || ((f, ms) => g.setInterval(f, ms)),
    clearInterval: over.clearInterval || ((h) => g.clearInterval(h)),
    queueMicrotask: over.queueMicrotask || ((f) => g.queueMicrotask(f)),
    storage: over.storage || safeStorage(typeof g.localStorage !== 'undefined' ? g.localStorage : null),
    omEngine: has('omEngine') ? over.omEngine : (win && win.omEngine) || g.omEngine || null,
    win,
    api: has('api') ? over.api : (win && win.api) || g.api || null,
    mediaDevices: has('mediaDevices') ? over.mediaDevices
      : (typeof g.navigator !== 'undefined' && g.navigator ? g.navigator.mediaDevices : null),
    OfflineAudioContext: over.OfflineAudioContext || g.OfflineAudioContext || null,
    AudioEngine: over.AudioEngine || null,
    VstHost: over.VstHost || null,
    log: over.log || console
  };
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Resolves with `p`, or rejects with an Error carrying `reason` after `ms`. */
export function withTimeout(env, p, ms, reason) {
  return new Promise((resolve, reject) => {
    const h = env.setTimeout(() => {
      const e = new Error(reason);
      e.reason = reason;
      reject(e);
    }, ms);
    Promise.resolve(p).then((v) => { env.clearTimeout(h); resolve(v); },
      (e) => { env.clearTimeout(h); reject(e); });
  });
}

/** An Error whose `reason` is the short text shown to the user on fallback. */
export function failure(reason, detail) {
  const e = new Error(detail ? `${reason}: ${detail}` : reason);
  e.reason = detail ? `${reason} (${detail})` : reason;
  return e;
}
