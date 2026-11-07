// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Engine: N decks -> 3-band EQ -> filter -> fader -> crossfader -> master,
// plus the FX matrix, color / pad / master FX, outputs and headphone cue,
// tick(), auto-tick, events and lifecycle (DESIGN §5.3, §5.4, §6).
// Ported from the OpenMix app engine (AudioEngine) and from the frame loop of
// the OpenMix UI (DESIGN §8).

import { Emitter } from './emitter.js';
import { Deck, DECK_CREATE } from './deck.js';
import { withSync } from './sync.js';
import { gridIndexFracAt, gridTimeAtIndex } from './grid.js';
import { FxUnit, buildEchoLoop, makeImpulse, crushCurve, fxDryCut, isColorFxType, measureFeedbackLatency } from './fx.js';
import { PITCH_PROCESSOR_NAME } from './constants.js';
import {
  clamp, isNum, isAudioBufferLike, toError, errorMessage, startSource, stopSource, flushStarts
} from './util.js';

const ENGINE_EVENTS = Object.freeze(['tick', 'master', 'statechange']);

// web-engine: how long `ready` waits for the FX feedback-latency measurement
// (a browser whose OfflineAudioContext never finishes rendering must not hold
// createEngine() forever; a later result is applied when it arrives)
export const FEEDBACK_WAIT_MS = 2000;

// web-engine: auto-tick timer cadence when requestAnimationFrame cannot be
// used (hidden page, stalled frames): one tick every 20 ms on average, and the
// wait for a frame before the timer takes over
const TICK_PERIOD_MS = 20;
const FRAME_WAIT_MS = 100;

// The pitch worklet module is added AT MOST ONCE per context (two engines
// on one context share it; the worklet also guards its registration)
const workletLoads = new WeakMap();

function loadPitchModule(ctx, url) {
  let p = workletLoads.get(ctx);
  if (!p) {
    p = Promise.resolve().then(() => ctx.audioWorklet.addModule(String(url)));
    workletLoads.set(ctx, p);
  }
  return p;
}

const defaultOnError = (e) => {
  const c = globalThis.console;
  if (c && typeof c.error === 'function') c.error(e);
};

function countOption(v, def, min, max, name) {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`options.${name} must be an integer from ${min} to ${max} (got ${String(v)})`);
  }
  return v;
}

const isContextLike = (c) => !!c && typeof c === 'object' && typeof c.createGain === 'function'
  && 'destination' in c && 'currentTime' in c;
const isNodeLike = (n) => !!n && typeof n === 'object' && typeof n.connect === 'function';
const isArrayBuffer = (v) => Object.prototype.toString.call(v) === '[object ArrayBuffer]';
const isFiniteNum = (v) => isNum(v) && Number.isFinite(v);

/**
 * The DJ engine: decks, mixer, FX, sync and outputs on one AudioContext or
 * OfflineAudioContext. `new Engine(options)` builds the whole graph
 * synchronously; `await engine.ready` waits for the keylock worklet and the
 * one-off FX feedback-latency measurement.
 */
export class Engine extends withSync(Emitter) {
  /**
   * @param {object} [options] EngineOptions (DESIGN §5.3)
   */
  constructor(options = {}) {
    super(ENGINE_EVENTS);
    const o = options && typeof options === 'object' ? options : {};
    this._onErrorFn = typeof o.onError === 'function' ? o.onError : defaultOnError;
    this._logFn = typeof o.log === 'function' ? o.log : null;
    // web-engine: sized from the options (OpenMix: 4 decks, 4 units, 8 hot cues)
    const nDecks = countOption(o.decks, 4, 1, 8, 'decks');
    const nFx = countOption(o.fxUnits, nDecks, 0, 8, 'fxUnits');
    this._hotCueCount = countOption(o.hotCues, 8, 1, 16, 'hotCues');
    if (o.output != null && !isNodeLike(o.output)) throw new TypeError('options.output must be an AudioNode');
    if (o.cueOutput != null && !isNodeLike(o.cueOutput)) throw new TypeError('options.cueOutput must be an AudioNode');

    // web-engine: injected context (never closed by the engine), or our own
    let ctx = o.context;
    this._ownsContext = false;
    if (ctx == null) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      let made = null;
      if (typeof AC === 'function') {
        try {
          made = new AC(o.contextOptions || { latencyHint: 'interactive' });
        } catch {
          made = null;
        }
      }
      if (!made) throw new Error('No AudioContext available; pass options.context');
      ctx = made;
      this._ownsContext = true;
    } else if (!isContextLike(ctx)) {
      throw new TypeError('options.context must be an AudioContext or an OfflineAudioContext');
    }
    this.ctx = ctx;
    /** The context is an OfflineAudioContext. */
    this.isOffline = typeof ctx.startRendering === 'function';
    this._destroyed = false;
    this._output = o.output || null;
    this._cueOutput = o.cueOutput || null;
    this._workletUrl = o.workletUrl != null
      ? o.workletUrl
      : new URL('../worklets/pitch-processor.js', import.meta.url);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // Safety limiter on the master
    if (o.limiter === false) {
      // web-engine: `limiter: false` puts a unity gain node in its place
      this.limiter = ctx.createGain();
    } else {
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.15;
    }

    // Post-mix bus: master -> (FX/color returns) -> MASTER FILTER -> limiter
    this.postBus = ctx.createGain();
    this.mFilter = ctx.createBiquadFilter();
    this.mFilter.type = 'peaking';
    this.mFilter.gain.value = 0;
    this.mFilter.frequency.value = 1000;
    this.mFilter.Q.value = 0.9;
    this.masterFilterVal = 0;
    // Compensated DRY path: when an FX is active, this gain goes down by as much
    // (rekordbox-style calibration — the wet blends INTO the mix instead of
    // stacking on top and exceeding the master level)
    this.dryComp = ctx.createGain();
    this.masterGain.connect(this.dryComp);
    this.dryComp.connect(this.postBus);
    // FX RETURNS (panel units, FX pads, Color FX): they follow the
    // MASTER VOLUME like the dry sound — an insert effect at full cuts the
    // dry, and without this gain the master knob had no control over that deck anymore
    this.fxReturn = ctx.createGain();
    this.fxReturn.gain.value = 0.9;
    this.fxReturn.connect(this.postBus);
    this.postBus.connect(this.mFilter);
    this.mFilter.connect(this.limiter);
    // --- HEADPHONE CUE: a DJ controller is often a 4-CHANNEL SOUND CARD
    // (master on 1/2, headphones on 3/4). If the output offers it, the CUE bus
    // goes to channels 3/4 — the controller's physical headphone output.
    this.cueBus = ctx.createGain();
    /** Gain of the headphone (cue) bus, 0..1 (default 1). */
    this.headphoneVolume = 1;
    this.phonesOk = false;
    this._phonesCtx = null;
    this._phonesStream = null;
    this._phonesDevice = '';
    this._recDest = null;
    this._wired = [];
    this._wireOutput();

    // MASTER VU meter (taken before the limiter: the red LED says
    // "it's clipping, the limiter is working")
    /** Master volume, 0..1 (default 0.9). */
    this.masterVolume = 0.9;
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.mFilter.connect(this.masterAnalyser);
    this.masterMeterBuf = new Float32Array(this.masterAnalyser.fftSize);

    // (the parallel output for recording the mix is created on demand:
    // see getRecordingStream)

    // Decks 1 & 3 -> side A, decks 2 & 4 -> side B (like Rekordbox in 4-deck mode)
    this._xfSides = Array.from({ length: nDecks }, (_, i) => (i % 2 === 0 ? 'A' : 'B'));
    /** Crossfader, 0..1 (0 = side A only; default 0.5). */
    this.crossfader = 0.5;

    /** The decks. */
    this.decks = Object.freeze(Array.from({ length: nDecks }, (_, i) => new Deck(this, i, DECK_CREATE)));
    // Headphone sends from each deck to the CUE bus
    this.decks.forEach((d) => d.cueSend.connect(this.cueBus));

    // FX units (one per player by default), each assignable to any
    // deck(s): send matrix of units × decks
    /** The beat-FX units. */
    this.fx = Object.freeze(Array.from({ length: nFx }, () => new FxUnit(ctx, this.fxReturn, () => this._updateFxSends())));
    // fxAssign[u][i]: unit u processes deck i (default: its own deck)
    this._fxAssign = this.fx.map((_, u) => this.decks.map((__, i) => i === u));
    this.decks.forEach((d) => {
      d.fxSends = this.fx.map((unit) => {
        const g = ctx.createGain();
        g.gain.value = 0;
        d.xf.connect(g);
        g.connect(unit.input);
        return g;
      });
    });
    /** The master FX unit (ensureMasterFx), or null. */
    this.masterFx = null;

    // PAD FX units: one per deck, INDEPENDENT of the panel units —
    // a held pad NEVER writes into the player's FX config. Created ON
    // DEMAND (first press): zero audio nodes as long as they are not
    // used — the software must stay light even on an old machine
    this._padFx = new Array(nDecks).fill(null);

    // Color FX: what each channel's FILTER knob does
    // ('filter' = classic biquad, otherwise a send to a shared effect)
    this.colorType = 'filter';
    this.colorEnabled = true;
    this.colorWet = ctx.createGain();
    this.colorWet.gain.value = 0.85; // capped so as not to exceed the track's level
    this.colorWet.connect(this.fxReturn);
    this.colorBus = ctx.createGain();
    // Color FX chains built ON FIRST ROUTING (5 × ~1 MB of delay buffer
    // reserved for nothing at startup — see _routeColor)
    this._colorDefs = {
      dubecho: { fb: 0.55, filter: { type: 'highpass', freq: 250 }, time: 0.35 },
      hpfecho: { fb: 0.5, filter: { type: 'highpass', freq: 900 }, time: 0.3 },
      lpfecho: { fb: 0.5, filter: { type: 'lowpass', freq: 650 }, time: 0.3 },
      bpfecho: { fb: 0.55, filter: { type: 'bandpass', freq: 1000, q: 1 }, time: 0.3 },
      crushecho: { fb: 0.5, crush: 6, time: 0.3 }
    };
    this.colorChains = {};
    this.cReverb = ctx.createConvolver();
    this.cReverb.buffer = makeImpulse(ctx, 2.8, 2.2);
    this.cCrush = ctx.createWaveShaper();
    this.cCrush.curve = crushCurve(5);

    // Shared white noise source (Color FX "Noise")
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = nb;
    this.noiseSrc.loop = true;
    // web-engine: on a context that has not started yet, on its first
    // 'running' state (no autoplay warning, see util.js)
    startSource(ctx, this.noiseSrc);

    this._colorOut = null;
    this.decks.forEach((d) => {
      d.colorSend = ctx.createGain();
      d.colorSend.gain.value = 0;
      d.post.connect(d.colorSend);
      d.colorSend.connect(this.colorBus);
      // White noise dosed by the knob, which follows the deck's fader
      d.noiseGain = ctx.createGain();
      d.noiseGain.gain.value = 0;
      this.noiseSrc.connect(d.noiseGain);
      d.noiseGain.connect(d.fader);
    });
    this._routeColor();

    this.masterIdx = null;     // master chosen by hand (MASTER button)
    this.autoMasterIdx = null; // automatic master (first-started rule)
    this._mmStopAt = null;
    this._amStopAt = null;
    this._lastMi = null;
    this._following = false;
    this._holdSet = new Set();
    this._holdManual = false;
    this._gridOffset = 0;
    this._dryTarget = 1;
    this._lastMasterEmitted = null;
    this._applyCrossfader();

    // 'statechange' proxies the context's event
    this._onStateChange = () => this._emit('statechange', { engine: this, state: ctx.state });
    if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', this._onStateChange);

    // WSOLA transposition engine (KEY ± and KEYLOCK), loaded in the background
    this._pitchEngine = o.keylock === false ? 'fallback' : 'loading';
    this._pitchEngineError = null;
    this._fbLatency = null;
    /**
     * Resolves once the worklet attempt and the one-off FX feedback-latency
     * measurement have finished. Never rejects.
     */
    // web-engine: the feedback-latency measurement of the beat-FX echoes
    // (fx.js) is done once per sample rate in a few ms; `ready` waits for it
    // FEEDBACK_WAIT_MS at most
    this.ready = Promise.all([
      this._loadPitchWorklet(o.keylock !== false),
      this._measureFeedbackLatency()
    ]).then(() => {});

    this._auto = null;
    const auto = o.autoTick !== undefined
      ? !!o.autoTick
      : !this.isOffline && typeof globalThis.requestAnimationFrame === 'function';
    if (auto) this.startAutoTick();
  }

  // ------------------------------------------------------------ state ----

  /** The AudioContext or OfflineAudioContext. */
  get context() {
    return this.ctx;
  }

  /** fxAssign[unit][deck] (a copy). */
  get fxAssign() {
    return Object.freeze(this._fxAssign.map((row) => Object.freeze(row.slice())));
  }

  /** Master filter, -1..1 (default 0). */
  get masterFilter() {
    return this.masterFilterVal;
  }

  /** Mode of every channel FILTER knob (default 'filter'). */
  get colorFx() {
    return this.colorType;
  }

  /** Whether the FILTER knobs act (default true). */
  get colorFxEnabled() {
    return this.colorEnabled;
  }

  /** Effective master: the manual one if set, else the automatic one. */
  get masterIndex() {
    return this.masterIdx !== null ? this.masterIdx : this.autoMasterIdx;
  }

  /** The manual master (setMaster), or null. */
  get manualMasterIndex() {
    return this.masterIdx;
  }

  /** decks[masterIndex], or null. */
  get masterDeck() {
    const i = this.masterIndex;
    return i == null ? null : this.decks[i];
  }

  /** masterDeck.effectiveBpm, or null. */
  get masterBpm() {
    const d = this.masterDeck;
    return d ? d.effectiveBpm : null;
  }

  /** Phase lock suspended (nudge in progress, or setSyncHold(true)). */
  get syncHold() {
    return this._holdManual || this._holdSet.size > 0;
  }

  /** Global offset of every beat-list grid (s, default 0). */
  get gridOffset() {
    return this._gridOffset;
  }

  /** 'loading' | 'wsola' | 'fallback'. */
  get pitchEngine() {
    return this._pitchEngine;
  }

  /** Why the WSOLA worklet is not used, or null. */
  get pitchEngineError() {
    return this._pitchEngineError;
  }

  /** The cue bus currently reaches an output. */
  get headphonesAvailable() {
    return this.phonesOk;
  }

  /** Final master node (post-limiter): connect extra taps here. */
  get masterOut() {
    return this.limiter;
  }

  /** The headphone (cue) bus node. */
  get cueOut() {
    return this.cueBus;
  }

  // ---------------------------------------------------- diagnostics ------

  _reportError(err) {
    try {
      this._onErrorFn(err);
    } catch { /* the error sink must never throw into the engine */ }
  }

  _listenerError(err) {
    this._reportError(err);
  }

  // web-engine: optional `log` option instead of console logging
  _log(message) {
    if (!this._logFn) return;
    try {
      this._logFn(String(message));
    } catch (e) {
      this._reportError(e);
    }
  }

  _checkDeck(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.decks.length) {
      throw new RangeError(`Deck index out of range (0..${this.decks.length - 1}): ${String(i)}`);
    }
  }

  _checkUnit(u) {
    if (!Number.isInteger(u) || u < 0 || u >= this.fx.length) {
      throw new RangeError(`FX unit index out of range (0..${this.fx.length - 1}): ${String(u)}`);
    }
  }

  // ------------------------------------------------------- lifecycle -----

  // WSOLA transposition engine (KEY ± and KEYLOCK): one node per deck,
  // loaded in the background. If it fails, each deck keeps its old
  // two-tap shifter — the engine stays usable in every case.
  async _loadPitchWorklet(enabled) {
    if (!enabled) {
      // keylock: false = two-tap fallback shifter only
      this._pitchEngine = 'fallback';
      this._pitchEngineError = null;
      return;
    }
    try {
      const ctx = this.ctx;
      const aw = ctx.audioWorklet;
      if (!aw || typeof aw.addModule !== 'function') {
        throw new Error('AudioWorklet is unavailable (insecure context or old browser)');
      }
      const AWN = globalThis.AudioWorkletNode;
      if (typeof AWN !== 'function') throw new Error('AudioWorkletNode is unavailable');
      await loadPitchModule(ctx, this._workletUrl);
      if (this._destroyed) throw new Error('The engine was destroyed');
      const nodes = this.decks.map(() => new AWN(ctx, PITCH_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit'
      }));
      this.decks.forEach((d, i) => d._installWsola(nodes[i], ctx.sampleRate));
      this._pitchEngine = 'wsola';
      this._log('transposition: WSOLA engine active (keylock available)');
    } catch (e) {
      this._pitchEngine = 'fallback';
      this._pitchEngineError = toError(e);
      this._log(`transposition: fallback engine (${errorMessage(e)})`);
    }
  }

  // web-engine: the browser's feedback-loop latency (see fx.js), compensated
  // in every beat-FX unit so that echo repeats stay on the beat. Waits for
  // the measurement FEEDBACK_WAIT_MS at most: until a late result arrives,
  // the echoes are not corrected. Never rejects.
  async _measureFeedbackLatency() {
    const ctx = this.ctx;
    const apply = (fb) => {
      if (this._destroyed || !fb) return;
      this._fbLatency = fb;
      for (const u of [...this.fx, ...this._padFx, this.masterFx]) {
        if (u) u._setFeedbackLatency(fb);
      }
      if (fb.loop) {
        this._log(`fx: feedback loops ${Math.round(fb.loop * ctx.sampleRate)} frames late per repeat: compensated`);
      }
    };
    let measured;
    try {
      const quantum = ctx.renderQuantumSize > 0 ? ctx.renderQuantumSize : 128;
      measured = Promise.resolve(measureFeedbackLatency(ctx.sampleRate, quantum));
    } catch (e) {
      this._log(`fx: feedback latency not measured (${errorMessage(e)})`);
      return;
    }
    const late = {};
    let timer = null;
    const first = await Promise.race([
      measured,
      new Promise((resolve) => {
        const st = globalThis.setTimeout;
        if (typeof st === 'function') timer = st.call(globalThis, () => resolve(late), FEEDBACK_WAIT_MS);
      })
    ]).catch(() => null);
    if (timer !== null) globalThis.clearTimeout(timer);
    if (first !== late) {
      apply(first);
      return;
    }
    this._log(`fx: feedback latency not measured after ${FEEDBACK_WAIT_MS} ms (applied when it arrives)`);
    measured.then(apply, () => {});
  }

  /**
   * Resumes a realtime context (call it in a user gesture: autoplay policy).
   * No-op offline. Never rejects.
   * @returns {Promise<void>}
   */
  async resume() {
    if (this.isOffline || this._destroyed) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
      try {
        await ctx.resume();
      } catch (e) {
        this._log(`audio: resume failed (${errorMessage(e)})`);
      }
    }
    // web-engine: the permanent sources start as soon as the context runs
    flushStarts(ctx);
  }

  // engine.resume() from play(), cueDown(), loadFrom()… (called synchronously
  // inside the user gesture; the promise never rejects)
  _resumeQuietly() {
    this.resume();
  }

  /**
   * One control step (call it every frame, 30–144 Hz, or let auto-tick do
   * it): FX beat alignment and ROLL, dry compensation, master election,
   * phase lock (unless syncHold), FX beat durations, then 'master' (if it
   * changed) and 'tick'.
   */
  tick() {
    if (this._destroyed) return;
    // web-engine: permanent sources still waiting for the context to run
    // (for browsers that do not dispatch 'statechange'; see util.js)
    this._step(() => flushStarts(this.ctx));
    // 1. The per-frame work of OpenMix (ex syncLock): each step is guarded,
    //    a failure can never stop the lock
    this._step(() => this._fxTick());
    this._step(() => this._dryCompensation());
    this._step(() => this._updateAutoMaster());
    if (!this.syncHold) this._step(() => this._phaseLock());
    // 2. FX units follow their reference deck's beat (from the OpenMix frame loop)
    this._step(() => this._fxFollow());
    // 3. / 4. events
    this._emitMasterIfChanged();
    this._emit('tick', { engine: this, time: this.ctx.currentTime });
  }

  _step(fn) {
    try {
      fn();
    } catch (e) {
      this._reportError(e);
    }
  }

  _emitMasterIfChanged() {
    const mi = this.masterIndex;
    if (mi === this._lastMasterEmitted) return;
    this._lastMasterEmitted = mi;
    this._emit('master', {
      engine: this,
      index: mi,
      deck: mi == null ? null : this.decks[mi],
      manual: this.masterIdx !== null
    });
  }

  /**
   * Calls tick() from requestAnimationFrame while the page is visible, and
   * from a timer (one tick every 20 ms on average) while it is hidden or
   * while frames stall (see below). Each tick is wrapped in try/catch
   * (reported to onError): the loop never dies.
   */
  startAutoTick() {
    if (this._auto || this._destroyed) return;
    const auto = { raf: 0, timer: 0, due: 0, onVis: null, cancel: null, stalled: false };
    this._auto = auto;
    const tick = () => {
      try {
        this.tick();
      } catch (e) {
        this._reportError(e);
      }
    };
    const clearTimer = () => {
      if (auto.timer) {
        globalThis.clearTimeout(auto.timer);
        auto.timer = 0;
      }
    };
    const onTimer = () => {
      if (this._auto !== auto) return;
      auto.timer = 0;
      // the backup timer fired while a frame was awaited: frames are stalled
      if (auto.raf) auto.stalled = true;
      tick();
      schedule();
    };
    const schedule = () => {
      if (this._auto !== auto) return;
      const doc = globalThis.document;
      const raf = globalThis.requestAnimationFrame;
      // requestAnimationFrame is paused in hidden tabs: the timer only there
      const hidden = !!doc && doc.visibilityState === 'hidden';
      if (!hidden && typeof raf === 'function') {
        // web-engine: a page can be 'visible' while requestAnimationFrame
        // never fires — an Electron window that is not shown, minimized or
        // occluded with backgroundThrottling off reports 'visible' (measured
        // in Electron 43: 1 tick in 1.4 s), as can an off-screen iframe. A
        // backup timer keeps the lock alive there: after 100 ms without a
        // frame, the timer cadence below takes over. ONE frame request stays
        // pending meanwhile, so the first frame that comes back always takes
        // over again, whatever the timer does.
        if (!auto.raf) {
          let id = 0;
          id = raf.call(globalThis, () => {
            if (this._auto !== auto || auto.raf !== id) return;
            auto.raf = 0;
            auto.stalled = false;
            clearTimer();
            tick();
            schedule();
          });
          auto.raf = id;
        }
        if (!auto.stalled) {
          clearTimer();
          auto.due = 0;
          auto.timer = globalThis.setTimeout(onTimer, FRAME_WAIT_MS);
          return;
        }
      }
      // web-engine: timer cadence, one tick every TICK_PERIOD_MS on average.
      // Each tick is due one period after the previous DUE time, not after the
      // moment the timer fired: on Windows' default 15.6 ms system timer, a
      // plain 20 ms setTimeout fires at the 2nd timer interrupt, every ~31 ms
      // (31 ticks per second measured in Electron 43 and Chrome 155: the very
      // bottom of the 30–144 Hz the lock is made for), while here a late
      // timer is followed by a shorter wait (50 per second). At most one
      // missed tick is caught up (no burst after a throttled or frozen page),
      // and a clock jump restarts the cadence. (Date.now: wall-clock
      // milliseconds are enough to schedule a timer; the audio clock is
      // frozen while the context is suspended.)
      clearTimer();
      const now = Date.now();
      auto.due = auto.due
        ? Math.min(Math.max(auto.due + TICK_PERIOD_MS, now), now + TICK_PERIOD_MS)
        : now + TICK_PERIOD_MS;
      auto.timer = globalThis.setTimeout(onTimer, auto.due - now);
    };
    auto.cancel = () => {
      if (auto.raf) {
        const caf = globalThis.cancelAnimationFrame;
        if (typeof caf === 'function') caf.call(globalThis, auto.raf);
        auto.raf = 0;
      }
      clearTimer();
      auto.due = 0;
    };
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
      auto.onVis = () => {
        if (this._auto !== auto) return;
        auto.cancel();
        schedule();
      };
      doc.addEventListener('visibilitychange', auto.onVis);
    }
    schedule();
  }

  /** Stops the automatic tick. */
  stopAutoTick() {
    const auto = this._auto;
    if (!auto) return;
    this._auto = null;
    auto.cancel();
    const doc = globalThis.document;
    if (auto.onVis && doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', auto.onVis);
    }
  }

  /**
   * Stops auto-tick, every deck and source, disconnects the outputs, closes
   * the headphone context and the engine's OWN context (never an injected one).
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return;
    this.stopAutoTick();
    for (const d of this.decks) this._step(() => d._dispose());
    this._destroyed = true;
    for (const u of [...this.fx, ...this._padFx, this.masterFx]) {
      if (u) this._step(() => u._dispose());
    }
    stopSource(this.ctx, this.noiseSrc);
    try { this.noiseSrc.disconnect(); } catch { /* nothing */ }
    this._unwire();
    const ctx = this.ctx;
    if (typeof ctx.removeEventListener === 'function') ctx.removeEventListener('statechange', this._onStateChange);
    if (this._phonesCtx) {
      const pc = this._phonesCtx;
      this._phonesCtx = null;
      try { await pc.close(); } catch { /* already closed */ }
    }
    if (this._ownsContext && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      try { await ctx.close(); } catch { /* already closed */ }
    }
  }

  // --------------------------------------------------------- loading -----

  /**
   * Fetches (string / URL), reads (Blob / File) and decodes a track. An
   * ArrayBuffer is DETACHED by decoding: pass a copy to keep yours.
   * AudioBuffers are returned unchanged.
   * @param {string | URL | Blob | ArrayBuffer | AudioBuffer} source
   * @returns {Promise<AudioBuffer>}
   */
  decode(source) {
    return this._decode(source, null);
  }

  async _decode(source, signal) {
    if (isAudioBufferLike(source)) return source;
    let data;
    const URLc = globalThis.URL;
    const BlobC = globalThis.Blob;
    if (typeof source === 'string' || (typeof URLc === 'function' && source instanceof URLc)) {
      const f = globalThis.fetch;
      if (typeof f !== 'function') throw new TypeError('fetch is unavailable: pass a Blob, an ArrayBuffer or an AudioBuffer');
      const res = await f.call(globalThis, String(source), signal ? { signal } : undefined);
      if (!res.ok) throw new Error(`Could not fetch ${String(source)}: HTTP ${res.status}`);
      data = await res.arrayBuffer();
    } else if (typeof BlobC === 'function' && source instanceof BlobC) {
      data = await source.arrayBuffer();
    } else if (isArrayBuffer(source)) {
      data = source;
    } else {
      throw new TypeError('decode: expected a URL, a Blob, an ArrayBuffer or an AudioBuffer');
    }
    const ctx = this.ctx;
    return new Promise((resolve, reject) => {
      const fail = (e) => reject(e || new Error('Unable to decode the audio data'));
      // promise form, plus the callbacks for older browsers
      const p = ctx.decodeAudioData(data, resolve, fail);
      if (p && typeof p.then === 'function') p.then(resolve, fail);
    });
  }

  // ------------------------------------------------------------ mixer ----

  /**
   * Crossfader, 0..1 ("mix" curve: both sides full at the center).
   * @param {number} x
   */
  setCrossfader(x) {
    if (!isNum(x)) return;
    this.crossfader = clamp(x, 0, 1);
    this._applyCrossfader();
  }

  // "Mix" curve: both sides at full in the center
  _sideGain(side) {
    // web-engine: 'thru' decks ignore the crossfader
    if (side === 'thru') return 1;
    const x = this.crossfader;
    if (side === 'A') return x <= 0.5 ? 1 : (1 - x) * 2;
    return x >= 0.5 ? 1 : x * 2;
  }

  _applyCrossfader() {
    const now = this.ctx.currentTime;
    this.decks.forEach((d, i) => {
      d.xf.gain.setTargetAtTime(this._sideGain(this._xfSides[i]), now, 0.01);
    });
  }

  /**
   * MASTER volume, 0..1: the level of the whole assembled mix (it also
   * scales the FX returns).
   * @param {number} v
   */
  setMasterVolume(v) {
    if (!isNum(v)) return;
    this.masterVolume = clamp(v, 0, 1);
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
    this.fxReturn.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
  }

  /**
   * MASTER filter on the whole mix, -1..1: < 0 low-pass, > 0 high-pass,
   * dead zone |v| < 0.04.
   * @param {number} v
   */
  setMasterFilter(v) {
    if (!isNum(v)) return;
    v = clamp(v, -1, 1);
    this.masterFilterVal = v;
    const f = this.mFilter;
    if (Math.abs(v) < 0.04) {
      f.type = 'peaking';
      f.gain.value = 0;
      f.frequency.value = 1000;
    } else if (v > 0) {
      f.type = 'highpass';
      f.Q.value = 0.9;
      f.frequency.value = 20 * Math.pow(400, v);
    } else {
      f.type = 'lowpass';
      f.Q.value = 0.9;
      f.frequency.value = 20000 * Math.pow(80 / 20000, -v);
    }
  }

  /**
   * Gain of the headphone (cue) bus, 0..1.
   * @param {number} v
   */
  setHeadphoneVolume(v) {
    if (!isNum(v)) return;
    this.headphoneVolume = clamp(v, 0, 1);
    this.cueBus.gain.setTargetAtTime(this.headphoneVolume, this.ctx.currentTime, 0.01);
  }

  /**
   * Peak level of the assembled mix (before the limiter), 0..~2.
   * @returns {number}
   */
  masterPeak() {
    this.masterAnalyser.getFloatTimeDomainData(this.masterMeterBuf);
    let m = 0;
    for (let i = 0; i < this.masterMeterBuf.length; i += 2) {
      const v = Math.abs(this.masterMeterBuf[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // --- Color FX: mode of each channel's FILTER knob ---
  _routeColor() {
    try { this.colorBus.disconnect(); } catch { /* nothing */ }
    if (this._colorOut) {
      try { this._colorOut.disconnect(this.colorWet); } catch { /* nothing */ }
      this._colorOut = null;
    }
    let io = null;
    if (this._colorDefs[this.colorType]) {
      let c = this.colorChains[this.colorType];
      if (!c) {
        c = this.colorChains[this.colorType] =
          buildEchoLoop(this.ctx, this._colorDefs[this.colorType]);
      }
      io = [c.in, c.out];
    } else if (this.colorType === 'reverb') {
      io = [this.cReverb, this.cReverb];
    } else if (this.colorType === 'crush') {
      io = [this.cCrush, this.cCrush];
    }
    // 'filter' and 'noise': no bus (deck biquad / per-deck noise gain)
    if (io) {
      this.colorBus.connect(io[0]);
      io[1].connect(this.colorWet);
      this._colorOut = io[1];
    }
  }

  /**
   * Mode of every channel FILTER knob (COLOR_FX_TYPES id); re-applies the knobs.
   * @param {string} type
   */
  setColorFx(type) {
    if (!isColorFxType(type)) throw new RangeError(`Unknown color FX type: ${String(type)}`);
    this.colorType = type;
    this._routeColor();
    // Re-apply each knob's value in the new mode
    this.decks.forEach((d, i) => this._setDeckColor(i, d.filterVal));
  }

  /**
   * Global ON/OFF: when OFF, turning a FILTER knob has no effect.
   * @param {boolean} on
   */
  setColorFxEnabled(on) {
    this.colorEnabled = !!on;
    this.decks.forEach((d, i) => this._setDeckColor(i, d.filterVal));
  }

  _setDeckColor(i, v) {
    const d = this.decks[i];
    const now = this.ctx.currentTime;
    d.filterVal = Math.max(-1, Math.min(1, v));
    if (!this.colorEnabled) {
      d._applyBiquad(0);
      d.colorSend.gain.setTargetAtTime(0, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(0, now, 0.01);
      return;
    }
    const amt = Math.abs(d.filterVal);
    if (this.colorType === 'filter') {
      d._applyBiquad(d.filterVal);
      d.colorSend.gain.setTargetAtTime(0, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(0, now, 0.01);
    } else if (this.colorType === 'noise') {
      d._applyBiquad(0);
      d.colorSend.gain.setTargetAtTime(0, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(amt * amt * 0.4, now, 0.01);
    } else {
      d._applyBiquad(0);
      d.colorSend.gain.setTargetAtTime(amt, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(0, now, 0.01);
    }
  }

  // -------------------------------------------------- master and sync ----

  /**
   * SETS the manual master (null = automatic). Not a toggle. Emits 'master'
   * synchronously if the effective master changed.
   * @param {number | null} index
   */
  setMaster(index) {
    const i = index === undefined ? null : index;
    if (i !== null) this._checkDeck(i);
    // web-engine: sets (OpenMix toggled)
    this.masterIdx = i;
    this._mmStopAt = null;
    this._emitMasterIfChanged();
  }

  // ---------------------------------------------------------------- FX ----

  /**
   * Assigns (or unassigns) a beat-FX unit to a deck; the sends are updated.
   * @param {number} unit
   * @param {number} deck
   * @param {boolean} [on=true]
   */
  assignFx(unit, deck, on = true) {
    this._checkUnit(unit);
    this._checkDeck(deck);
    this._fxAssign[unit][deck] = !!on;
    this._updateFxSends();
  }

  /**
   * @param {number} unit
   * @param {number} deck
   * @returns {boolean}
   */
  isFxAssigned(unit, deck) {
    this._checkUnit(unit);
    this._checkDeck(deck);
    return this._fxAssign[unit][deck];
  }

  _updateFxSends() {
    const t = this.ctx.currentTime;
    this.decks.forEach((d, i) => {
      if (!d.fxSends) return;
      d.fxSends.forEach((g, u) => {
        const on = this.fx[u].enabled && this._fxAssign[u][i];
        g.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
      });
    });
  }

  /**
   * MASTER FX: a unit on the WHOLE MIX (MASTER position of the controllers'
   * channel select). Created on the first call, wired in parallel like the
   * deck FX: master → send → unit → post bus (wet on top).
   * @returns {FxUnit}
   */
  ensureMasterFx() {
    if (!this.masterFx) {
      this.masterFx = new FxUnit(this.ctx, this.postBus);
      if (this._fbLatency) this.masterFx._setFeedbackLatency(this._fbLatency);
      const g = this.ctx.createGain();
      g.gain.value = 1;
      this.masterGain.connect(g);
      g.connect(this.masterFx.input);
    }
    return this.masterFx;
  }

  // PAD FX: preset {type, beats, level} = effect active on the deck, null = off
  _setPadFx(i, preset) {
    const d = this.decks[i];
    if (!this._padFx[i]) {
      if (!preset) return;
      this._padFx[i] = new FxUnit(this.ctx, this.fxReturn);
      if (this._fbLatency) this._padFx[i]._setFeedbackLatency(this._fbLatency);
      d.padFxSend = this.ctx.createGain();
      d.padFxSend.gain.value = 0;
      d.xf.connect(d.padFxSend);
      d.padFxSend.connect(this._padFx[i].input);
    }
    const u = this._padFx[i];
    const t = this.ctx.currentTime;
    if (preset) {
      // web-engine: the unit is born in time with its deck's beat (no 1-tick lag)
      const beat = d.beatDuration || (this.masterDeck && this.masterDeck.beatDuration);
      if (beat) u.setBeatDuration(beat);
      u.setType(preset.type);
      u.setBeats(preset.beats);
      u.setLevel(preset.level);
      u.setEnabled(true);
      d.padFxSend.gain.setTargetAtTime(1, t, 0.01);
    } else {
      d.padFxSend.gain.setTargetAtTime(0, t, 0.02);
      u.setEnabled(false);
    }
  }

  // Deck whose tempo an FX unit follows: the first assigned deck that
  // is playing (otherwise the master)
  _fxRefDeck(uIdx) {
    const a = this._fxAssign[uIdx];
    if (a) {
      for (let d = 0; d < this.decks.length; d++) {
        if (a[d] && this.decks[d].playing && this.decks[d].bpm) return this.decks[d];
      }
    }
    return this._getMasterDeck(-1);
  }

  // AUDIO time of the next multiple of "periodBeats" on the deck's
  // grid (locked to the bar when the period is at least one beat)
  _nextBoundaryAt(d, periodBeats) {
    if (!d || !d.playing || !(periodBeats > 0)) return null;
    const pos = d.currentTime();
    let f;
    let anchor = 0;
    if (d.beats) {
      f = gridIndexFracAt(d, pos);
      anchor = d.barAnchor || 0;
    } else if (d.bpm && d.beatOffset != null) {
      f = ((pos - d.beatOffset) * d.bpm) / 60;
    } else {
      return null;
    }
    if (f == null) return null;
    // alignment grid: the period if it is shorter than a beat, otherwise the
    // bar (a 16-beat modulation still restarts on a bar)
    const G = periodBeats < 1 ? periodBeats : Math.min(periodBeats, 4);
    const k = Math.ceil((f - anchor) / G + 1e-6) * G + anchor;
    const tFile = d.beats ? gridTimeAtIndex(d, k) : d.beatOffset + (k * 60) / d.bpm;
    if (tFile == null) return null;
    const at = this.ctx.currentTime + (tFile - pos) / (d.tempo || 1);
    return at > this.ctx.currentTime ? at : null;
  }

  // Every tick: FX modulations re-aligned to the beats, and ROLL
  // (FX panel or pad) driven on the decks
  _fxTick() {
    const units = [];
    this.fx.forEach((u, uIdx) => units.push([u, () => this._fxRefDeck(uIdx)]));
    this._padFx.forEach((u, i) => { if (u) units.push([u, () => this.decks[i]]); });
    if (this.masterFx) units.push([this.masterFx, () => this._getMasterDeck(-1)]);
    for (const [u, refOf] of units) {
      if (!u.enabled) { u._alignKey = null; continue; }
      const P = u.modPeriodBeats();
      if (!P) continue;
      const key = `${u.type}|${u.beats}`;
      const ref = refOf();
      if (!ref || !ref.playing) continue;
      const drift = u._alignedDur && Math.abs(u.beatDuration / u._alignedDur - 1) > 0.004;
      if (u._alignKey === key && u._alignRef === ref && !drift) continue;
      const at = this._nextBoundaryAt(ref, P);
      if (at == null || at - this.ctx.currentTime > 4) continue;
      if (u.alignTo(at)) {
        u._alignKey = key;
        u._alignRef = ref;
      }
    }
    // ROLL: the held pad has priority, otherwise a panel ROLL unit
    // assigned to the deck (or the master FX in ROLL)
    // (web-engine: a roll started with deck.startRoll() counts like a pad)
    this.decks.forEach((d, i) => {
      let want = d._padRoll || d._userRoll || null;
      if (!want) {
        this.fx.forEach((u, uIdx) => {
          if (!want && u.enabled && u.type === 'roll' && this._fxAssign[uIdx][i] && u.level > 0.02) {
            want = { beats: u.beats, mix: u.level };
          }
        });
      }
      const mf = this.masterFx;
      if (!want && mf && mf.enabled && mf.type === 'roll' && mf.level > 0.02) {
        want = { beats: mf.beats, mix: mf.level };
      }
      if (want && d.playing) {
        if (!d._roll || Math.abs(d._roll.beats - want.beats) > 1e-6) d._startRoll(want.beats, want.mix);
        else d._setRollMix(want.mix);
      } else if (d._roll) {
        d._stopRoll();
      }
    });
  }

  // PER-DECK FX CALIBRATION (every tick, ~zero cost): the dry of
  // EACH deck goes down according to the strongest FX processing IT — panel
  // units assigned to this deck, and a held PAD FX (which can request
  // a total cut: "it's the sound being manipulated", not an addition).
  // An FX on deck 2 never touches deck 1.
  _dryCompensation() {
    this.decks.forEach((d, i) => {
      if (!d.dryOut) return;
      // Share of the dry removed according to the NATURE of each effect processing this
      // deck: a gate/filter/crush at full REPLACES the sound (otherwise
      // the intact dry masked the effect — "the intensity does nothing");
      // an echo/reverb adds to the sound
      let cut = 0;
      this.fx.forEach((u, uIdx) => {
        if (u.enabled && this._fxAssign[uIdx] && this._fxAssign[uIdx][i]) {
          const lv = Math.min(1, u.wet.gain.value || 0);
          const c = fxDryCut(u.type) * lv;
          if (c > cut) cut = c;
        }
      });
      let dry = 1 - cut;
      const p = this._padFx[i];
      if (p && p.enabled && d._padDryHold != null) dry = Math.min(dry, d._padDryHold);
      if (Math.abs((d._dryCur ?? 1) - dry) > 0.01) {
        d._dryCur = dry;
        d.dryOut.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.02);
      }
    });
    // MASTER FX: it alone doses the dry of the WHOLE MIX
    const mWet = this.masterFx && this.masterFx.enabled
      ? Math.min(1, this.masterFx.wet.gain.value || 0) : 0;
    const dryT = 1 - (this.masterFx ? fxDryCut(this.masterFx.type) : 0.45) * mWet;
    if (Math.abs((this._dryTarget ?? 1) - dryT) > 0.01) {
      this._dryTarget = dryT;
      this.dryComp.gain.setTargetAtTime(dryT, this.ctx.currentTime, 0.05);
    }
  }

  // Each FX unit follows the BPM of the first deck assigned to it
  // (otherwise the master's) — moved from the OpenMix frame loop. The beat is
  // the REAL duration of one beat of the deck (deck.beatDuration): tempo
  // included, sync micro-corrections removed (otherwise the echo delays
  // kept "breathing"), based on the LOCAL grid.
  // web-engine: with no reference beat at all, a unit keeps its current
  // beat duration (default 0.5 s, or the value set by setBeatDuration);
  // and every unit follows, enabled or not (OpenMix: enabled ones only), so
  // that a unit switched on later is born in time (no delay glide)
  _fxFollow() {
    const beatOf = (dk) => (dk ? dk.beatDuration : null);
    const masterBeat = beatOf(this._getMasterDeck(-1));
    this.fx.forEach((u, uIdx) => {
      const b = beatOf(this._fxRefDeck(uIdx)) || masterBeat;
      if (b) u.setBeatDuration(b);
    });
    // PAD FX units follow THEIR deck's tempo (otherwise the master's)
    this._padFx.forEach((u, i) => {
      if (!u) return;
      const b = beatOf(this.decks[i]) || masterBeat;
      if (b) u.setBeatDuration(b);
    });
    // The MASTER FX locks to the master deck's BPM
    if (this.masterFx && masterBeat) this.masterFx.setBeatDuration(masterBeat);
  }

  // ---------------------------------------------------------- outputs ----

  // web-engine: remembered output edges — re-wiring disconnects ONLY them
  // (taps that apps connect to masterOut / cueOut stay in place, and the
  // 4-channel merger of a previous wiring no longer stays connected)
  _wire(from, to, output, input) {
    if (output === undefined) from.connect(to);
    else from.connect(to, output, input);
    this._wired.push([from, to, output, input]);
  }

  _unwire() {
    for (const [from, to, output, input] of this._wired) {
      try {
        if (output === undefined) from.disconnect(to);
        else from.disconnect(to, output, input);
      } catch { /* already disconnected */ }
    }
    this._wired = [];
  }

  // Destination channel settings: an OfflineAudioContext destination
  // rejects channelCount changes, hence the try/catch
  // (web-engine: rule 5 also resets a destination left in 4-channel
  // discrete mode by a previous device to plain stereo)
  _setDestination(dest, count, interpretation) {
    try { dest.channelCount = count; } catch { /* fixed (offline) */ }
    try { dest.channelCountMode = 'explicit'; } catch { /* fixed */ }
    try { dest.channelInterpretation = interpretation; } catch { /* fixed */ }
  }

  // Output wiring (DESIGN §6.6): 4 channels if the device allows it
  // (master → 1/2, headphones → 3/4), otherwise plain stereo. MUST BE CALLED
  // AGAIN after every setSinkId (the channel count depends on the device).
  _wireOutput() {
    const ctx = this.ctx;
    const dest = ctx.destination;
    this._unwire();
    // (the limiter also feeds the recorder: reconnect it)
    if (this._recDest) this._wire(this.limiter, this._recDest);
    const out = this._output;
    const masterToStereo = () => {
      if (out) {
        this._wire(this.limiter, out);
      } else {
        this._setDestination(dest, Math.min(2, dest.maxChannelCount || 2), 'speakers');
        this._wire(this.limiter, dest);
      }
    };
    // 1. HEADPHONES ON ANOTHER CARD (the controller): only the master goes out here,
    // in stereo — nothing on channels 3/4 of the master output anymore
    if (this._phonesCtx && this._phonesStream) {
      this._wire(this.cueBus, this._phonesStream);
      masterToStereo();
      this.phonesOk = true;
      return;
    }
    // 2. web-engine: an explicit cue output node
    if (this._cueOutput) {
      this._wire(this.cueBus, this._cueOutput);
      masterToStereo();
      this.phonesOk = true;
      return;
    }
    // 3. web-engine: an explicit master output node, no cue output
    if (out) {
      this._wire(this.limiter, out);
      this.phonesOk = false;
      return;
    }
    // 4. a ≥ 4-channel destination: master on 1/2, headphones on 3/4
    if (dest.maxChannelCount >= 4) {
      this._setDestination(dest, 4, 'discrete');
      const merger = ctx.createChannelMerger(4);
      const ms = ctx.createChannelSplitter(2);
      const cs = ctx.createChannelSplitter(2);
      this._wire(this.limiter, ms);
      this._wire(ms, merger, 0, 0);
      this._wire(ms, merger, 1, 1);
      this._wire(this.cueBus, cs);
      this._wire(cs, merger, 0, 2);
      this._wire(cs, merger, 1, 3);
      this._wire(merger, dest);
      this.phonesOk = true;
      this._log('audio: 4-channel output — headphones active (channels 3/4)');
      return;
    }
    // 5. stereo
    masterToStereo();
    this.phonesOk = false;
    this._log(`audio: ${dest.maxChannelCount}-channel output — no separate headphones`);
  }

  /**
   * Moves the context to another output device (context.setSinkId) and
   * re-wires the outputs (§6.6).
   * @param {string} deviceId
   * @returns {Promise<boolean>} false when setSinkId is unsupported, offline, or the device fails
   */
  async setOutputDevice(deviceId) {
    if (this.isOffline || this._destroyed || typeof this.ctx.setSinkId !== 'function') return false;
    try {
      await this.ctx.setSinkId(deviceId == null ? '' : String(deviceId));
    } catch (e) {
      this._log(`audio: output device unavailable (${errorMessage(e)})`);
      return false;
    }
    // the channel count (headphones!) depends on the device
    this._wireOutput();
    return true;
  }

  // SEPARATE HEADPHONE OUTPUT. The master can go out on one card (studio
  // interface, PC speakers…) and the headphones on the CONTROLLER: a DJ
  // controller is often a 4-channel sound card whose headphone jack reads
  // channels 3/4. Before, the CUE bus went to channels 3/4 of the MASTER
  // output — so to the studio interface, never to the headphones plugged into the controller.
  // empty deviceId = no separate headphone card (default routing).
  /**
   * Sends the cue bus to another device through a second AudioContext
   * (MediaStream bridge; its latency is not compensated). null / '' = default routing.
   * @param {string | null} deviceId
   * @returns {Promise<boolean>} false when unsupported, offline, or the device fails
   */
  async setHeadphoneDevice(deviceId) {
    if (this.isOffline || this._destroyed) return false;
    const id = deviceId ? String(deviceId) : '';
    if (id === this._phonesDevice && (!id || this._phonesCtx)) return true;
    if (this._phonesCtx) {
      const old = this._phonesCtx;
      this._phonesCtx = null;
      Promise.resolve().then(() => old.close()).catch(() => {});
    }
    this._phonesDevice = id;
    if (!id) {
      this._wireOutput();
      return true;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof AC !== 'function' || typeof AC.prototype.setSinkId !== 'function'
        || typeof this.ctx.createMediaStreamDestination !== 'function') {
      this._phonesDevice = '';
      this._wireOutput();
      return false;
    }
    let pc = null;
    try {
      pc = new AC({ latencyHint: 'interactive' });
      await pc.setSinkId(id);
      if (!this._phonesStream) this._phonesStream = this.ctx.createMediaStreamDestination();
      const src = pc.createMediaStreamSource(this._phonesStream.stream);
      const dest = pc.destination;
      if (dest.maxChannelCount >= 4) {
        // 4-channel card (DJ controller): headphones = channels 3/4
        this._setDestination(dest, 4, 'discrete');
        const sp = pc.createChannelSplitter(2);
        const mg = pc.createChannelMerger(4);
        src.connect(sp);
        sp.connect(mg, 0, 2);
        sp.connect(mg, 1, 3);
        mg.connect(dest);
      } else {
        // plain stereo card dedicated to the headphones
        src.connect(dest);
      }
      Promise.resolve().then(() => pc.resume()).catch(() => {});
      if (this._destroyed || this._phonesDevice !== id) {
        // web-engine: superseded by another call (or destroyed) in the meantime
        Promise.resolve().then(() => pc.close()).catch(() => {});
        return false;
      }
      this._phonesCtx = pc;
      this._wireOutput();
      this._log(`audio: headphones on a separate card (${dest.maxChannelCount} channels)`);
      return true;
    } catch (e) {
      this._log(`audio: headphone card unavailable (${errorMessage(e)})`);
      if (pc) Promise.resolve().then(() => pc.close()).catch(() => {});
      if (this._phonesDevice === id) {
        this._phonesDevice = '';
        this._phonesCtx = null;
        this._wireOutput();
      }
      return false;
    }
  }

  /**
   * The master (post-limiter) as a MediaStream, for MediaRecorder. Created on
   * the first call and kept connected.
   * @returns {MediaStream}
   */
  getRecordingStream() {
    if (this.isOffline) throw new TypeError('getRecordingStream() is not available on an OfflineAudioContext');
    if (!this._recDest) {
      if (typeof this.ctx.createMediaStreamDestination !== 'function') {
        throw new TypeError('MediaStreamAudioDestinationNode is unavailable in this browser');
      }
      // web-engine: created lazily (OpenMix created it at startup)
      this._recDest = this.ctx.createMediaStreamDestination();
      this._wire(this.limiter, this._recDest);
    }
    return this._recDest.stream;
  }

  // -------------------------------------------------------------- grid ----

  /**
   * GLOBAL grid offset: shifts every line of every beat-list grid at once,
   * to suit the listener's ear or screen latency.
   * @param {number} seconds
   */
  setGridOffset(seconds) {
    if (!isFiniteNum(seconds)) return;
    // web-engine: per engine (OpenMix: a module global)
    this._gridOffset = seconds;
  }
}

/**
 * Creates an engine and waits for `engine.ready`: its keylock worklet attempt
 * and its FX feedback-latency measurement.
 * @param {object} [options] EngineOptions
 * @returns {Promise<Engine>}
 */
export async function createEngine(options) {
  const engine = new Engine(options);
  await engine.ready;
  return engine;
}
