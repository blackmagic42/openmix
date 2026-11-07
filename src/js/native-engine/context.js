// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §16.1, §17.2):
// stand-ins for the Web Audio objects app.js and library.js reach through
// engine.ctx while the sound is made by the engine host:
//   - the context: decodeAudioData (Chromium's decoder in an
//     OfflineAudioContext at the device rate, waiting for that rate),
//     currentTime (engine clock), sampleRate, state, resume, setSinkId
//     (device.open), base/output latency from the device status,
//     createGain / createBufferSource (sampler shims);
//   - AudioParam stand-ins (stem gains): setTargetAtTime -> a command;
//   - the sampler's gain node and the post bus.
// After a fallback every shim forwards to the Web engine (engine.js), so the
// objects app.js and Library captured at startup keep working.

export class AudioParamShim {
  /**
   * onSet(value, tau): sends the command (native). real(): the Web
   * AudioParam once the engine fell back to engine.js (or null).
   */
  constructor(initial, onSet, real = () => null) {
    this._v = initial;
    this._onSet = onSet;
    this._real = real;
  }

  get value() {
    const r = this._real();
    return r ? r.value : this._v;
  }

  set value(v) {
    const r = this._real();
    if (r) { r.value = v; return; }
    this._v = v;
    this._onSet(v, 0);
  }

  get defaultValue() { return 1; }

  setTargetAtTime(v, t, tau) {
    const r = this._real();
    if (r) return r.setTargetAtTime(v, t, tau);
    this._v = v;
    this._onSet(v, tau);
    return this;
  }

  setValueAtTime(v, t) {
    const r = this._real();
    if (r) return r.setValueAtTime(v, t);
    this._v = v;
    this._onSet(v, 0);
    return this;
  }

  linearRampToValueAtTime(v, t) {
    const r = this._real();
    if (r) return r.linearRampToValueAtTime(v, t);
    this._v = v;
    this._onSet(v, 0.005);
    return this;
  }

  exponentialRampToValueAtTime(v, t) {
    return this.linearRampToValueAtTime(v, t);
  }

  cancelScheduledValues(t) {
    const r = this._real();
    if (r) return r.cancelScheduledValues(t);
    return this;
  }

  cancelAndHoldAtTime(t) {
    const r = this._real();
    if (r && r.cancelAndHoldAtTime) return r.cancelAndHoldAtTime(t);
    return this;
  }
}

/** Common base: a node whose Web twin is created on demand after a fallback. */
class NodeShim {
  constructor(ctxShim) {
    this._ctx = ctxShim;
    this._dests = new Set();
    this._realNode = null;
  }

  get context() { return this._ctx; }

  _web() { return this._ctx._engine._web; }

  /** The Web node standing for this shim (fallback mode only). */
  _real() { return null; }

  connect(dest) {
    this._dests.add(dest);
    const web = this._web();
    if (web) {
      const me = this._real();
      const to = dest && typeof dest._real === 'function' ? dest._real() : dest;
      if (me && to) me.connect(to);
    }
    return dest;
  }

  disconnect(dest) {
    if (dest === undefined) this._dests.clear();
    else this._dests.delete(dest);
    const me = this._realNode;
    if (me) {
      try {
        if (dest === undefined) me.disconnect();
        else me.disconnect(dest && typeof dest._real === 'function' ? dest._real() : dest);
      } catch { /* not connected */ }
    }
  }

  /** Product of the gains from this node to the post bus (0 when it does not reach it). */
  _gainToBus(depth = 0) {
    if (depth > 8) return 0;
    let best = 0;
    for (const d of this._dests) {
      if (d instanceof BusShim) best = Math.max(best, 1);
      else if (d instanceof GainShim) best = Math.max(best, d.gain.value * d._gainToBus(depth + 1));
    }
    return best;
  }
}

/** engine.postBus: where the sampler connects (the engine's post bus). */
export class BusShim extends NodeShim {
  constructor(ctxShim, name) {
    super(ctxShim);
    this.name = name;
  }

  _real() {
    const web = this._web();
    return web ? web[this.name] : null;
  }

  _gainToBus() { return 1; }
}

/** ctx.createGain(): the sampler's level node. */
export class GainShim extends NodeShim {
  constructor(ctxShim) {
    super(ctxShim);
    this.gain = new AudioParamShim(1, () => {}, () => (this._realNode ? this._realNode.gain : null));
  }

  _real() {
    const web = this._web();
    if (!web) return null;
    if (!this._realNode) {
      const g = web.ctx.createGain();
      g.gain.value = this.gain._v;
      this._realNode = g;
      for (const d of this._dests) {
        const to = d && typeof d._real === 'function' ? d._real() : d;
        if (to) g.connect(to);
      }
    }
    return this._realNode;
  }
}

/**
 * ctx.createBufferSource(): a sampler voice. Native: start() ->
 * sampler.play {slot, voice, gain}, stop() -> sampler.stop {voice} (the
 * sound was handed off by preloadSample). Fallback: a real
 * AudioBufferSourceNode of the Web engine.
 */
export class SourceShim extends NodeShim {
  constructor(ctxShim) {
    super(ctxShim);
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.onended = null;
    this.playbackRate = new AudioParamShim(1, () => {}, () => (this._realNode ? this._realNode.playbackRate : null));
    this.detune = new AudioParamShim(0, () => {}, () => (this._realNode ? this._realNode.detune : null));
    this._voice = -1;
    this._started = false;
  }

  _real() {
    const web = this._web();
    if (!web) return null;
    if (!this._realNode) {
      const s = web.ctx.createBufferSource();
      s.buffer = this.buffer;
      s.loop = this.loop;
      s.playbackRate.value = this.playbackRate._v;
      s.onended = () => { if (this.onended) this.onended(); };
      this._realNode = s;
      for (const d of this._dests) {
        const to = d && typeof d._real === 'function' ? d._real() : d;
        if (to) s.connect(to);
      }
    }
    return this._realNode;
  }

  start(when, offset, duration) {
    if (this._started) throw new Error('InvalidStateError: start() called twice');
    this._started = true;
    const real = this._real();
    if (real) return real.start(when || 0, offset || 0, duration);
    const gain = this._gainToBus();
    if (!(gain > 0) || !this.buffer) return undefined;
    this._voice = this._ctx._engine.sampler.play(this.buffer, gain);
    return undefined;
  }

  stop(when) {
    const real = this._realNode;
    if (real) {
      try { real.stop(when || 0); } catch { /* already stopped */ }
      return;
    }
    if (this._voice >= 0) {
      this._ctx._engine.sampler.stop(this._voice);
      this._voice = -1;
    }
  }
}

/** engine.ctx in native mode. */
export class ContextShim {
  constructor(engine) {
    this._engine = engine;
  }

  _webCtx() {
    const web = this._engine._web;
    return web ? web.ctx : null;
  }

  get sampleRate() {
    const w = this._webCtx();
    return w ? w.sampleRate : this._engine._deviceRate;
  }

  get currentTime() {
    const w = this._webCtx();
    return w ? w.currentTime : this._engine.engineNow();
  }

  get state() {
    const w = this._webCtx();
    return w ? w.state : 'running';
  }

  get baseLatency() {
    const w = this._webCtx();
    if (w) return w.baseLatency;
    const d = this._engine._device;
    return d && d.period && d.rate ? d.period / d.rate : 0.01;
  }

  get outputLatency() {
    const w = this._webCtx();
    if (w) return w.outputLatency;
    const d = this._engine._device;
    return d && d.latency > 0 ? d.latency : 0;
  }

  get sinkId() {
    const w = this._webCtx();
    return w ? w.sinkId : this._engine._sinkId;
  }

  get destination() {
    const w = this._webCtx();
    if (w) return w.destination;
    const d = this._engine._device;
    const n = d && d.channels ? d.channels : 2;
    return { maxChannelCount: n, channelCount: Math.min(2, n), channelCountMode: 'explicit', channelInterpretation: 'speakers' };
  }

  get audioWorklet() {
    const w = this._webCtx();
    return w ? w.audioWorklet : undefined;
  }

  resume() {
    const w = this._webCtx();
    return w ? w.resume() : Promise.resolve();
  }

  suspend() {
    const w = this._webCtx();
    return w ? w.suspend() : Promise.resolve();
  }

  /** Chromium's decoder at the device rate (waits for the device.open reply). */
  decodeAudioData(ab, ok, err) {
    const p = this._engine._decode(ab);
    if (typeof ok === 'function' || typeof err === 'function') {
      p.then((b) => ok && ok(b), (e) => err && err(e));
    }
    return p;
  }

  setSinkId(id) {
    return this._engine._setSink(id);
  }

  createGain() {
    return new GainShim(this);
  }

  createBufferSource() {
    return new SourceShim(this);
  }

  createBuffer(channels, length, rate) {
    const w = this._webCtx();
    if (w) return w.createBuffer(channels, length, rate);
    const Off = this._engine.env.OfflineAudioContext;
    if (!Off) throw new Error('createBuffer unavailable');
    return new Off(1, 1, rate).createBuffer(channels, length, rate);
  }

  addEventListener(type, fn, opts) {
    const w = this._webCtx();
    if (w) w.addEventListener(type, fn, opts);
  }

  removeEventListener(type, fn, opts) {
    const w = this._webCtx();
    if (w) w.removeEventListener(type, fn, opts);
  }
}
