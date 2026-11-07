// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §16, §17):
// NativeEngine, the engine.js `AudioEngine` surface app.js uses, driving
// libopenmix in the Electron utility process ("engine host") through
// window.omEngine (preload, §6.5) and two MessagePorts (ctl, pcm).
//
// Connect: omEngine.info() -> connect() -> ports -> hello {reset} (10 s
// timeout; the UI stays usable meanwhile on the mirrors) -> 5 clock.pings ->
// the SAVED output device opened once (device.open) -> mirrors resynced ->
// native. Any failure on the way, the engine host exiting, an audio stall it
// could not recover, or the liveness rule -> fallback to engine.js (one per
// session), re-applying the current state.

import { AudioEngine, getGlobalGridOffset, gridIndexFracAt, gridTimeAtIndex } from '../engine.js';
import { makeEnv, clamp, withTimeout, failure } from './env.js';
import { ClockSync } from './clock.js';
import { EngineLink } from './link.js';
import { PcmScheduler, headroomFromPeaks, DEFAULT_CHUNK_FRAMES } from './pcm.js';
import { LivenessMonitor } from './liveness.js';
import { NativeDeck, Gate, STEMS } from './deck.js';
import { NativeFxUnit, engineFxType, COLOR_TYPES } from './fx.js';
import { ContextShim, BusShim } from './context.js';
import { SamplerBank } from './sampler.js';
import { ShadowDecoder } from './shadow.js';
import { NativeVstHost } from './vst-host.js';
import { runFallback } from './fallback.js';
import { describeOutputDevice, deviceFields, MASTER_DEVICE_KEY, PHONES_DEVICE_KEY } from './devices.js';

export const ENGINE_KEY = 'audioEngine';
export const PROTOCOL = 2;
export const HELLO_TIMEOUT_MS = 10000;
export const DEVICE_OPEN_TIMEOUT_MS = 10000;
export const CONNECT_PINGS = 5;
export const PING_EVERY_MS = 2000;
export const PING_TIMEOUT_MS = 500;

const P = AudioEngine.prototype;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const idx = (v) => (isNum(v) && v >= 0 ? v : null);

/**
 * app.js's engine: localStorage.audioEngine 'web' (default) -> new AudioEngine()
 * exactly as before; 'native' / 'native-exclusive' -> a NativeEngine facade.
 * opts: { onFallback(reason), onEvent(ev), env (tests), engine (override the setting) }
 */
/**
 * Stores the descriptors (label + nameIndex) of the chosen master and headphone
 * outputs while labels are known (the Settings panel has the media
 * permission), for a native start where labels are still empty (SPEC.md §8.1).
 */
export async function rememberOutputDevices(envOver) {
  const env = makeEnv(envOver);
  let devices = [];
  try { devices = env.mediaDevices ? await env.mediaDevices.enumerateDevices() : []; } catch { return 0; }
  let n = 0;
  for (const [idKey, descKey] of [['audioOutput', MASTER_DEVICE_KEY], ['phonesOutput', PHONES_DEVICE_KEY]]) {
    const id = env.storage.get(idKey) || '';
    if (!id || id === 'auto' || id === 'default' || id === 'communications') continue;
    const d = describeOutputDevice(id, devices, null);
    if (d && d.name) {
      env.storage.setJson(descKey, { id: d.id, name: d.name, nameIndex: d.nameIndex });
      n++;
    }
  }
  return n;
}

export function createAudioEngine(opts = {}) {
  const env = makeEnv(opts.env);
  const pref = opts.engine || env.storage.get(ENGINE_KEY) || 'web';
  if (pref !== 'native' && pref !== 'native-exclusive') {
    const Ctor = env.AudioEngine || AudioEngine;
    return new Ctor();
  }
  return new NativeEngine({ ...opts, mode: pref === 'native-exclusive' ? 'exclusive' : 'lowlatency' });
}

export class NativeEngine {
  constructor(opts = {}) {
    this.env = makeEnv(opts.env);
    this.mode = opts.mode === 'exclusive' ? 'exclusive' : 'lowlatency';
    this.onFallback = opts.onFallback || null;
    this.onEvent = opts.onEvent || null;
    this.status = 'connecting';          // connecting | native | falling-back | web
    this.everNative = false;             // the engine was active at some point (else: never available)
    this.fallbackReason = null;
    this.fallbackCode = null;      // 'memory': app.js shows a translated reason
    this._memoryToldAt = {};       // kind -> env.now() of the last 'pcm-memory' event
    this._web = null;                    // engine.js AudioEngine after a fallback
    this._webPending = null;
    this._frozenNow = null;
    this.clock = new ClockSync();
    this._link = null;
    this._epoch = null;
    this._ack = 0;
    this._sent = new Map();
    this._deviceRate = 48000;
    this._rateKnown = false;
    this._device = null;                 // last device fields of the state
    this._deviceStatus = null;           // last device.open status
    this._leadEst = 0.03;
    this._lastState = null;
    this._pcmBytes = 0;
    this._helloInfo = null;
    this._pingWaiters = new Map();
    this._timers = [];
    this._liveness = null;
    this._decodeCtx = null;
    this._decodeRate = 0;
    this._diagAt = {};
    // outputs
    this._sinkId = this.env.storage.get('audioOutput') || '';
    this._openedSinkId = null;
    this._phonesId = '';
    this._phonesSet = false;
    this._phonesOk = false;
    // mixer mirrors (engine.js defaults)
    this._masterVolume = 0.9;
    this._masterFilterVal = 0;
    this._crossfader = 0.5;
    this._colorType = 'filter';
    this._colorEnabled = true;
    this.xfSides = ['A', 'B', 'A', 'B'];
    this._masterIdx = null;
    this._autoMasterIdx = null;
    this._jogHold = false;
    this._masterPeak = 0;
    this._masterGate = new Gate();
    this._gridOffsetSent = null;
    this._fxAssign = [0, 1, 2, 3].map((u) => [0, 1, 2, 3].map((i) => i === u));
    this._fxAssignSent = null;
    // objects app.js keeps for the whole session
    this.decks = [0, 1, 2, 3].map((i) => new NativeDeck(this, i));
    this.fx = [0, 1, 2, 3].map((u) => new NativeFxUnit(this, `fx${u}`));
    this.padFx = [null, null, null, null];
    this._masterFx = null;
    this.ctx = new ContextShim(this);
    this.postBus = new BusShim(this.ctx, 'postBus');
    this.pcm = new PcmScheduler({
      env: this.env,
      whenDone: (s) => this._onPcmDone(s),
      whenFailed: (s, err) => this._onPcmFail(s, err)
    });
    this.sampler = new SamplerBank(this);
    this.shadow = new ShadowDecoder(this);
    this._vstHosts = [];
    this._rec = null;
    this._fallbackP = null;
    this.whenSettled = new Promise((resolve) => { this._settle = resolve; });
    this._portsP = this._listenPorts();
    this._connectP = this._connect();
  }

  // ---- identity ------------------------------------------------------------------

  get isNative() { return this.status === 'connecting' || this.status === 'native'; }

  /** Engine clock (s): performance.now() + the clock-sync offset; frozen during a fallback. */
  engineNow() {
    if (this._frozenNow != null) return this._frozenNow;
    return this.clock.engineTime(this.env.now() / 1000);
  }

  /** Predicted delay until a command sent now is heard (presentTime of the next block). */
  _leadEstimate() {
    const d = this._device;
    const half = d && d.period > 0 && d.rate > 0 ? d.period / d.rate / 2 : 0.0025;
    return Math.max(0, this._leadEst) + half;
  }

  _emit(ev) {
    if (typeof this.onEvent !== 'function') return;
    try { this.onEvent(ev); } catch (e) { this.env.log.error?.(e); }
  }

  // ---- connection --------------------------------------------------------------------

  _listenPorts() {
    const win = this.env.win;
    return new Promise((resolve) => {
      if (!win || typeof win.addEventListener !== 'function') return;
      const onMsg = (e) => {
        if (!e || e.data !== 'openmix-engine-ports' || !e.ports || e.ports.length < 2) return;
        win.removeEventListener('message', onMsg);
        resolve([e.ports[0], e.ports[1]]);
      };
      win.addEventListener('message', onMsg);
    });
  }

  async _connect() {
    const env = this.env;
    const om = env.omEngine;
    let connected = false;
    try {
      if (!om || typeof om.connect !== 'function') throw failure('unavailable', 'no engine bridge');
      const info = await withTimeout(env, Promise.resolve(typeof om.info === 'function' ? om.info() : { available: true }),
        HELLO_TIMEOUT_MS, 'unavailable (no answer)');
      if (!info || !info.available) throw failure('unavailable', info && info.reason);
      if (typeof om.onExit === 'function') om.onExit((d) => this._onExit(d));
      const deadline = env.now() + HELLO_TIMEOUT_MS;
      const left = () => Math.max(1, deadline - env.now());
      connected = true;
      const conn = await withTimeout(env, Promise.resolve(om.connect()), left(), 'hello timeout');
      if (conn && conn.ok === false) throw failure('engine host failed to start', conn.error);
      const [ctl, pcm] = await withTimeout(env, this._portsP, left(), 'hello timeout');
      this._link = new EngineLink({
        env, ctl, pcm,
        engineNow: () => this.engineNow(),
        onEvent: (d) => this._onCtl(d),
        onPcm: (m) => this.pcm.onAck(m)
      });
      this.pcm.link = this._link;
      const hello = await withTimeout(env,
        this._link.request({ cmd: 'hello', protocol: PROTOCOL, client: 'openmix-renderer', reset: true }), left(), 'hello timeout');
      if (!hello.ok) throw failure('hello refused', hello.error);
      if (isNum(hello.protocol) && hello.protocol !== PROTOCOL) throw failure('protocol mismatch', `engine ${hello.protocol}, proxy ${PROTOCOL}`);
      this._helloInfo = hello;
      this._epoch = hello.epoch;
      this._ack = 0;
      const cf = isNum(hello.chunkFrames) && hello.chunkFrames > 0 ? hello.chunkFrames : DEFAULT_CHUNK_FRAMES;
      this.pcm.chunkFrames = cf;
      if (isNum(hello.sampleRate) && hello.sampleRate > 0) this._deviceRate = hello.sampleRate;
      await this._pings(CONNECT_PINGS);
      await this._finishOrphanRecording(left);
      const open = await withTimeout(env, this._openSavedDevice(), DEVICE_OPEN_TIMEOUT_MS, 'device.open timeout');
      if (!open || !open.ok) throw failure('device.open failed', open && open.error);
      this._applyDeviceStatus(open.status);
      this._rateKnown = true;
      if (this.status !== 'connecting') return this.status;   // fell back meanwhile (engine exit...)
      this.status = 'native';
      this.everNative = true;
      this._startTimers();
      this._resync();
      this._settle('native');
      this.sampler.onReady();
      this._listRecordings();
      this._emit({ type: 'native-active', info: this.nativeInfo() });
      env.log.log?.(`[engine] native engine active: ${this._describeDevice()}`);
      return 'native';
    } catch (e) {
      const reason = e && e.reason ? e.reason : String((e && e.message) || e);
      await this._fallback(reason, { kill: connected });
      return 'web';
    }
  }

  /**
   * A recording the previous page started is still running after a renderer
   * reload (app.js reloads on a language change; hello {reset} unloads the
   * decks but leaves the recorder alone): this page cannot show or stop it,
   * so it is finalized now, and rec.list offers it at ready like any unsaved
   * recording ("Show in folder").
   */
  async _finishOrphanRecording(left) {
    let st = null;
    try { st = await withTimeout(this.env, this._link.request({ cmd: 'rec.status' }), left(), 'hello timeout'); } catch { return; }
    if (!st || !st.ok || !st.active) return;
    let r = null;
    try { r = await withTimeout(this.env, this._link.request({ cmd: 'rec.stop' }), left(), 'rec.stop timeout'); } catch { /* listed anyway */ }
    this.env.log.warn?.(`[engine] a recording left running by the previous page was finalized: ${(r && r.path) || st.path || '?'}`);
  }

  /** Sequential clock.pings (min-rtt estimate). */
  async _pings(n) {
    for (let k = 0; k < n; k++) {
      if (!this._link || this._link.closed) return;
      const t0 = this.env.now() / 1000;
      const p = new Promise((resolve) => this._pingWaiters.set(t0, resolve));
      this._link.send({ cmd: 'clock.ping', t0 });
      try { await withTimeout(this.env, p, PING_TIMEOUT_MS, 'ping timeout'); } catch { this._pingWaiters.delete(t0); }
    }
  }

  _ping() {
    if (!this._link || this._link.closed) return;
    this._link.send({ cmd: 'clock.ping', t0: this.env.now() / 1000 });
  }

  _startTimers() {
    const env = this.env;
    this._timers.push(env.setInterval(() => this._ping(), PING_EVERY_MS));
    this._liveness = new LivenessMonitor({
      env,
      sendPing: () => this._ping(),
      onDead: (why) => this._fallback(`engine not responding (${why})`, { suspects: true })
    });
    this._liveness.start();
  }

  _closeLink(reason) {
    for (const h of this._timers) this.env.clearInterval(h);
    this._timers.length = 0;
    if (this._liveness) this._liveness.stop();
    this.pcm.stopAll();
    if (this._link) this._link.close(reason);
    for (const [, r] of this._pingWaiters) r();
    this._pingWaiters.clear();
  }

  // ---- fallback --------------------------------------------------------------------

  _fallback(reason, opts = {}) {
    if (this._fallbackP) return this._fallbackP;
    this.status = 'falling-back';
    this.fallbackReason = reason;
    this.fallbackCode = opts.code || null;
    this._fallbackP = (async () => {
      try {
        await runFallback(this, reason, { kill: opts.kill !== false, suspects: !!opts.suspects });
      } catch (e) {
        this.env.log.error?.('[engine] fallback failed:', e);
        try {
          if (!this._web && this._webPending) this._attachWeb(this._webPending);
        } catch (e2) {
          this.env.log.error?.('[engine] fallback attach failed:', e2);
        }
      }
      this.status = 'web';
      this._settle('web');
      if (typeof this.onFallback === 'function') {
        try { this.onFallback(reason, this.fallbackCode); } catch (e) { this.env.log.error?.(e); }
      }
      return 'web';
    })();
    return this._fallbackP;
  }

  /** From now on every facade forwards to the Web engine. */
  _attachWeb(web) {
    this._web = web;
    this._webPending = null;
    this.decks.forEach((d, i) => { d._web = web.decks[i]; });
    this.fx.forEach((u, k) => { u._web = web.fx[k]; });
    this.padFx.forEach((p, i) => { if (p && web.padFx[i]) p._web = web.padFx[i]; });
    if (this._masterFx && web.masterFx) this._masterFx._web = web.masterFx;
    this.status = 'web';
  }

  _onExit(d) {
    if (this.status === 'web' || this.status === 'falling-back') return;
    const code = d && d.code != null ? d.code : '?';
    // kill anyway (SPEC.md §17.6 step 1): main resolves at once when the process is already gone
    this._fallback(`engine host exited (code ${code})`, { suspects: this.status === 'native' });
  }

  // ---- events from the engine -----------------------------------------------------------

  _onCtl(data) {
    let ev = data;
    if (typeof data === 'string') {
      try { ev = JSON.parse(data); } catch { return; }
    }
    if (!ev || typeof ev.ev !== 'string') return;
    switch (ev.ev) {
      case 'state': this._onState(ev); break;
      case 'reply': if (this._link) this._link.onReply(ev); break;
      case 'hb': if (this._liveness) this._liveness.heard(); break;
      case 'clock.pong': this._onPong(ev); break;
      case 'applied': this._onApplied(ev); break;
      case 'pcm.done': this.pcm.onDone(ev.loadId); break;
      case 'pcm.error': this.pcm.onError(ev.loadId, ev.error); break;
      case 'deck.ended': {
        const d = this.decks[ev.deck];
        if (d && d._buffer && !d._web) d._ended(isNum(ev.t) ? ev.t : null, this.engineNow());
        break;
      }
      case 'device': this._onDevice(ev); break;
      case 'rec.status':
        if (!ev.active) this._rec = null;
        this._emit({ type: 'rec.status', ...ev });
        break;
      case 'vst.crashed': case 'vst.hung': case 'vst.late': case 'vst.latency':
        for (const h of this._vstHosts) h._onEngineEvent(ev);
        break;
      case 'sync.result': break;
      case 'diag': this._onDiag(ev); break;
      case 'error':
        if (ev.error === 'full') {
          if (this._link) this._link.onFull(ev);
        } else {
          this.env.log.warn?.(`[engine] command rejected: ${ev.error}`);
          // nothing of that message was applied: its requests will never get a reply
          if (this._link) this._link.onRefused(ev.ids, ev.error);
        }
        break;
      default: break;
    }
  }

  _onPong(ev) {
    const t1 = this.env.now() / 1000;
    if (isNum(ev.t0) && isNum(ev.te)) this.clock.addSample(ev.t0, ev.te, t1);
    if (this._liveness) this._liveness.pong();
    const w = this._pingWaiters.get(ev.t0);
    if (w) {
      this._pingWaiters.delete(ev.t0);
      w();
    }
  }

  _onApplied(ev) {
    for (const d of this.decks) for (const g of Object.values(d._gates)) g.applied(ev.seq);
    this._masterGate.applied(ev.seq);
  }

  _onState(s) {
    if (this._web || this.status === 'falling-back' || !s || s.epoch !== this._epoch) return;
    if (this._liveness) this._liveness.heard();
    const now = this.engineNow();
    if (isNum(s.ack) && s.ack > this._ack) this._ack = s.ack;
    if (isNum(s.t)) {
      const lead = s.t - now;
      if (lead > -0.25 && lead < 1) this._leadEst = this._leadEst * 0.8 + Math.max(0, lead) * 0.2;
    }
    this._lastState = s;
    const ack = this._ack;
    if (Array.isArray(s.decks)) s.decks.forEach((ds, i) => { if (this.decks[i]) this.decks[i]._adopt(ds, s, ack, now); });
    if (s.sync) {
      for (const d of this.decks) d._adoptSync(s.sync, ack, now);
      if (this._masterGate.open(ack, now)) this._masterIdx = idx(s.sync.masterIdx);
      this._autoMasterIdx = idx(s.sync.autoMasterIdx);
    }
    if (s.mixer && isNum(s.mixer.masterPeak)) this._masterPeak = s.mixer.masterPeak;
    if (s.device) this._applyDeviceState(s.device);
    if (isNum(s.pcmBytes)) this._pcmBytes = s.pcmBytes;
  }

  _onDevice(ev) {
    if (ev.status) this._applyDeviceStatus(ev.status);
    if (ev.reason === 'stalled') {
      this._fallback('audio device stalled', { suspects: true });
      return;
    }
    if (ev.reason === 'lost' || ev.reason === 'restored' || ev.reason === 'fallback' || ev.reason === 'periodStep') {
      this._emit({ type: 'device', reason: ev.reason, status: ev.status || null });
    }
  }

  _onDiag(ev) {
    const now = this.env.now();
    const k = ev.kind || 'diag';
    if (this._diagAt[k] && now - this._diagAt[k] < 5000) return;
    this._diagAt[k] = now;
    this.env.log.log?.(`[engine] diag ${k}: ${JSON.stringify(ev)}`);
  }

  _applyDeviceState(d) {
    this._device = {
      mode: d.mode, rate: d.rate, channels: d.channels, period: d.period, latency: d.latency,
      jitterMs: d.jitterMs, cueRouted: !!d.cueRouted, phones: !!d.phones, lost: !!d.lost,
      fellBack: !!d.fellBack, periodSteps: d.periodSteps | 0, load: d.load, maxLoad: d.maxLoad, xruns: d.xruns
    };
    this._phonesOk = !!d.cueRouted;
    if (isNum(d.rate) && d.rate > 0 && d.rate !== this._deviceRate) this._deviceRate = d.rate;
  }

  /** device.open / device.status / device event status: {mode, name, sampleRate, channels, periodFrames, latencyMs, ...}. */
  _applyDeviceStatus(st) {
    if (!st || typeof st !== 'object') return;
    this._deviceStatus = st;
    if (isNum(st.sampleRate) && st.sampleRate > 0) this._deviceRate = st.sampleRate;
  }

  _describeDevice() {
    const st = this._deviceStatus || {};
    const d = this._device || {};
    const rate = st.sampleRate || d.rate || this._deviceRate;
    const period = st.periodFrames || d.period || 0;
    const lat = isNum(st.latencyMs) ? st.latencyMs : (isNum(d.latency) ? d.latency * 1000 : null);
    return `${st.name || 'output'} · ${st.mode || this.mode} · ${rate} Hz · ${period} frames`
      + (lat != null ? ` · ${lat.toFixed(1)} ms` : '');
  }

  /** For the Settings status line. */
  nativeInfo() {
    const st = this._deviceStatus || {};
    const d = this._device || {};
    const rate = st.sampleRate || d.rate || this._deviceRate;
    const period = st.periodFrames || d.period || 0;
    let latencyMs = null;
    if (isNum(st.latencyMs)) latencyMs = st.latencyMs;
    else if (isNum(d.latency)) latencyMs = d.latency * 1000;
    return {
      status: this.status, reason: this.fallbackReason, engine: this._helloInfo && this._helloInfo.engine,
      mode: st.mode || null, device: st.name || null, rate, period,
      periodMs: period && rate ? (period / rate) * 1000 : null, latencyMs,
      fellBack: !!(st.fellBack || d.fellBack), lost: !!(st.lost || d.lost), pcmBytes: this._pcmBytes,
      clockRttMs: this.clock.rtt != null ? this.clock.rtt * 1000 : null
    };
  }

  // ---- sending ---------------------------------------------------------------------

  _send(cmd) {
    if (this.status !== 'native' || !this._link) return 0;
    // a NaN / Infinity would reach the engine as null and make it refuse the WHOLE batch
    for (const k in cmd) {
      const v = cmd[k];
      if (typeof v === 'number' && !Number.isFinite(v)) {
        if (!this._warnedNaN) {
          this._warnedNaN = true;
          this.env.log.warn?.(`[engine] ${cmd.cmd} dropped: ${k} is ${v}`);
        }
        return 0;
      }
    }
    return this._link.send(cmd);
  }

  _lazy(build) {
    if (this.status !== 'native' || !this._link) return 0;
    return this._link.lazy(build);
  }

  /** Knob-like command: nothing sent when the value did not change. */
  _sendState(key, cmd, value) {
    if (this._sent.has(key) && Object.is(this._sent.get(key), value)) return 0;
    this._sent.set(key, value);
    return this._send(cmd);
  }

  /** The engine applied a value by itself (load reset): remember it as sent. */
  _forget(key, value) {
    this._sent.set(key, value);
  }

  /** Engine ready: the mirrors (set while connecting, or engine.js defaults) are sent in one batch. */
  _resync() {
    this._sent.clear();
    this._fxAssignSent = null;
    this._gridOffsetSent = null;
    this.setMasterVolume(this._masterVolume);
    this.setMasterFilter(this._masterFilterVal);
    this.setCrossfader(this._crossfader);
    this._send({ cmd: 'xf.sides', sides: this.xfSides.slice() });
    this.setColorType(this._colorType);
    this.setColorEnabled(this._colorEnabled);
    for (const d of this.decks) {
      d.setVolume(d._volume);
      d.setTrim(d._trimVal);
      for (const b of ['low', 'mid', 'high']) d.setEq(b, d._eq[b]);
      this.setDeckColor(d.id, d._filterVal);
      this.setCuePfl(d.id, d._cueOn);
      d.setKey(d._keyShift);
      d.setKeylock(d._keylock);
      if (d._synced) d.synced = true;
      if (d._padDryHoldV != null) d._padDryHold = d._padDryHoldV;
    }
    for (const u of this.fx) this._send({ cmd: 'fx.set', unit: u.unit, ...u._snapshot() });
    if (this._masterFx) this._send({ cmd: 'fx.set', unit: 'master', ...this._masterFx._snapshot() });
    this.padFx.forEach((p, i) => {
      if (p) this._send({ cmd: 'fx.pad', deck: i, preset: p._enabled ? { type: engineFxType(p._type), beats: p._beatsMult, level: p._level } : null });
    });
    this.updateFxSends();
    if (this._masterIdx != null) this.masterIdx = this._masterIdx;
    if (this._jogHold) this.jogHold = true;
    this._frameWork();
    for (const d of this.decks) {
      if (!d._buffer) continue;
      const pos = d.currentTime();
      const playing = d._playing;
      this._loadDeck(d);
      this._restoreDeckState(d, pos, playing);
      if (d._stems) this._handoffStems(d);
    }
  }

  // ---- PCM: tracks, stems ---------------------------------------------------------------

  _loadDeck(deck) {
    if (this.status !== 'native' || !this._link) return;
    const b = deck._buffer;
    if (!b || typeof b.copyFromChannel !== 'function') return;
    const { headroom, peak } = b.numberOfChannels > 2 ? { headroom: 0, peak: 0 } : headroomFromPeaks(deck._peaks);
    const format = deck._track && Number(deck._track.bitsPerSample) > 16 ? 'f32' : 's16';
    const s = this.pcm.start({
      kind: 'track', buffer: b, format, headroom, peak, owner: deck,
      priority: () => deck._pcmPriority(), focusSec: Math.max(0, deck.currentTime())
    });
    deck._stream = s;
    deck._loadId = s.loadId;
    deck._endedSeen = null;
    deck._sentBeats = deck._beats;
    const cmd = { cmd: 'deck.load', deck: deck.id, loadId: s.loadId, grid: deck._gridPayload() };
    this._link.request(cmd).then((r) => {
      if (!r.ok && deck._stream === s && s.active) this._onPcmFail(s, `deck.load: ${r.error || 'failed'}`);
    });
    const now = this.engineNow();
    for (const g of Object.values(deck._gates)) g.mark(cmd.seq, false, now);
  }

  /** After a (re)load of a deck whose state is not the load defaults: tempo, key, loop, position, play. */
  _restoreDeckState(d, pos, playing) {
    const send = (cmd, ...gates) => d._send(cmd, ...gates);
    // deck.load reset key and cue point in the engine: sent again whatever was sent before
    this._forget(`d${d.id}.key`, d._keyShift);
    this._forget(`d${d.id}.cue`, d._cuePoint);
    if (d._tempo !== 1) send({ cmd: 'deck.tempo', deck: d.id, r: d._tempo }, d._gates.tempo);
    if (d._keyShift) send({ cmd: 'deck.key', deck: d.id, semi: d._keyShift });
    if (d._cuePoint) send({ cmd: 'deck.cuePoint', deck: d.id, t: d._cuePoint });
    if (d._looping) send({ cmd: 'deck.loop', deck: d.id, start: d._loopStart, end: d._loopEnd }, d._gates.loop, d._gates.transport);
    if (d._loopBeatsV != null) send({ cmd: 'deck.loopBeats', deck: d.id, beats: d._loopBeatsV }, d._gates.loop);
    if (d._syncBaseV != null || d._syncRefV != null || d._pllCorrV) {
      send({ cmd: 'sync.base', deck: d.id, base: d._syncBaseV, ref: d._syncRefV, pllCorr: d._pllCorrV }, d._gates.sync);
    }
    if (pos) send({ cmd: 'deck.seek', deck: d.id, t: pos }, d._gates.transport);
    if (playing) send({ cmd: 'deck.play', deck: d.id }, d._gates.transport);
    if (d._stemsOn) send({ cmd: 'deck.stemsOn', deck: d.id, on: true });
  }

  _dropDeckPcm(deck) {
    if (deck._stream && deck._stream.active) this.pcm.abort(deck._stream);
    deck._stream = null;
    deck._loadId = 0;
    this._dropStems(deck);
  }

  _dropStems(deck) {
    const ss = deck._stemStreams;
    if (ss) for (const k of ['vocals', 'drums', 'bass']) if (ss[k] && ss[k].active) this.pcm.abort(ss[k]);
    deck._stemStreams = null;
  }

  _handoffStems(deck) {
    if (this.status !== 'native' || !this._link || !deck._loadId) return;
    const st = deck._stems;
    const real = (b) => b && typeof b.copyFromChannel === 'function';
    if (!st || !real(st.vocals) || !real(st.drums) || !real(st.bass)) return;
    const pos = Math.max(0, deck.currentTime());
    const mk = (b) => this.pcm.start({
      kind: 'stem', buffer: b, format: 's16', headroom: 0, peak: 0, owner: deck,
      priority: () => (deck._stemsOn ? 0.5 : 2), focusSec: pos
    });
    const streams = { vocals: mk(st.vocals), drums: mk(st.drums), bass: mk(st.bass) };
    deck._stemStreams = streams;
    this._link.request({
      cmd: 'deck.stems', deck: deck.id, vocals: streams.vocals.loadId, drums: streams.drums.loadId, bass: streams.bass.loadId
    }).then((r) => {
      if (!r.ok) this.env.log.warn?.(`[engine] stems deck ${deck.id + 1}: ${r.error || 'refused'}`);
    });
    Promise.all([streams.vocals.whenDone, streams.drums.whenDone, streams.bass.whenDone]).then((states) => {
      if (deck._stemStreams !== streams || deck._stems !== st || deck._web) return;
      if (!states.every((x) => x === 'done')) return;
      // RAM (§17.8): the engine holds them now; the renderer keeps stubs (rebuilt on fallback)
      for (const k of ['vocals', 'drums', 'bass']) {
        const b = st[k];
        if (b && typeof b.getChannelData === 'function') {
          st[k] = { length: b.length, duration: b.duration, sampleRate: b.sampleRate, numberOfChannels: b.numberOfChannels };
        }
      }
      this._logRam(`stems deck ${deck.id + 1}`);
    });
  }

  _stemsWanted(deck) {
    const ss = deck._stemStreams;
    if (!ss) return;
    const pos = Math.max(0, deck.currentTime());
    for (const k of ['vocals', 'drums', 'bass']) if (ss[k] && ss[k].active) this.pcm.focus(ss[k], pos);
  }

  /** A jump: the chunk at the target (and the one before) are sent first. */
  _focusPcm(deck, sec, extra = []) {
    if (deck._stream && deck._stream.active) this.pcm.focus(deck._stream, sec, extra);
    const ss = deck._stemStreams;
    if (ss) for (const k of ['vocals', 'drums', 'bass']) if (ss[k] && ss[k].active) this.pcm.focus(ss[k], sec, extra);
  }

  _onPcmDone(s) {
    if (s.kind !== 'track') return;
    const deck = s.owner;
    if (!deck || deck._stream !== s) return;
    this.shadow.onTrackDone(deck, s);
    this._logRam(`track deck ${deck.id + 1} (${((s.tDone - s.t0) / 1000).toFixed(2)} s handoff)`);
  }

  _onPcmFail(s, error) {
    if (this.status !== 'native') return;
    // pcm.begin refused "memory": the engine's PCM limit (~40 % of the RAM,
    // engine-host.js) is reached. Logged with what the engine holds; the user
    // is told (app.js: a translated status message, or the fallback reason).
    const memory = error === 'memory';
    if (memory) {
      this.env.log.warn?.(`[engine] PCM memory limit reached: ${s.kind} refused (${(this._pcmBytes / 1048576).toFixed(0)} MB held by the engine)`);
    }
    if (s.kind === 'sample') {
      this.sampler.onStreamFailed(s);
      if (memory) this._tellMemory('sample');
      return;
    }
    const deck = s.owner;
    if (s.kind === 'stem') {
      if (deck && deck._stemStreams && Object.values(deck._stemStreams).includes(s)) deck._stemStreams = null;
      this.env.log.warn?.(`[engine] stems handoff failed (${error})`);
      if (memory) this._tellMemory('stems');
      return;
    }
    if (!deck || deck._stream !== s) return;
    if (deck._reloads < 1) {
      // reloaded once (new loadId), with the deck's state re-applied
      deck._reloads++;
      this.env.log.warn?.(`[engine] deck ${deck.id + 1}: PCM handoff failed (${error}), reloading`);
      const pos = deck.currentTime();
      const playing = deck._playing;
      if (s.active) this.pcm.abort(s);
      this._loadDeck(deck);
      this._restoreDeckState(deck, pos, playing);
      if (deck._stems) this._handoffStems(deck);
      return;
    }
    // (a reload refused "memory" again: the Web engine plays the renderer's copy)
    if (memory) this._fallback('PCM memory limit reached', { suspects: false, code: 'memory' });
    else this._fallback(`the engine could not take the track (${error})`, { suspects: false });
  }

  /** A stems / sampler handoff refused for memory: app.js tells the user (at most once per 10 s per kind). */
  _tellMemory(kind) {
    const now = this.env.now();
    const last = this._memoryToldAt[kind];
    if (last != null && now - last < 10000) return;
    this._memoryToldAt[kind] = now;
    this._emit({ type: 'pcm-memory', kind });
  }

  async _logRam(what) {
    const om = this.env.omEngine;
    let renderer = '';
    try {
      if (om && typeof om.memoryInfo === 'function') {
        const m = await om.memoryInfo();
        const kb = m && (m.private || m.residentSet || m.workingSetSize);
        if (kb) renderer = `, renderer ${(kb / 1024).toFixed(0)} MB`;
      }
    } catch { /* KPI only */ }
    this.env.log.log?.(`[engine] RAM after ${what}: engine PCM ${(this._pcmBytes / 1048576).toFixed(0)} MB${renderer}`);
  }

  // ---- decoding and outputs (context shim) ------------------------------------------------

  async _decode(ab) {
    if (!this._web && !this._rateKnown) await this.whenSettled;
    if (!this._web && this.status === 'falling-back') await this._fallbackP;
    if (this._web) return this._web.ctx.decodeAudioData(ab);
    const rate = this._deviceRate;
    if (!this._decodeCtx || this._decodeRate !== rate) {
      const Off = this.env.OfflineAudioContext;
      if (!Off) throw new Error('OfflineAudioContext unavailable');
      this._decodeCtx = new Off(2, 1, rate);
      this._decodeRate = rate;
    }
    return this._decodeCtx.decodeAudioData(ab);
  }

  async _describe(id, key) {
    let devices = [];
    try {
      if (this.env.mediaDevices && this.env.mediaDevices.enumerateDevices) devices = await this.env.mediaDevices.enumerateDevices();
    } catch { /* no list */ }
    const stored = this.env.storage.getJson(key, null);
    const desc = describeOutputDevice(id, devices, stored);
    if (desc && desc.name && !(stored && stored.id === desc.id && stored.name === desc.name && stored.nameIndex === desc.nameIndex)) {
      // labels known here: kept next to the choice, for a startup where labels are still empty
      this.env.storage.setJson(key, { id: desc.id, name: desc.name, nameIndex: desc.nameIndex });
    }
    return desc;
  }

  async _openSavedDevice() {
    const id = this._sinkId;
    const known = await this._describe(id, MASTER_DEVICE_KEY);
    // a saved device that cannot be named yet (no labels, nothing stored): the default output for
    // now, and app.js's startup setSinkId(saved) tries again instead of being taken as done
    this._openedSinkId = known ? id : '';
    if (!known && id) this.env.log.warn?.('[engine] the saved output cannot be identified yet: default output for now');
    return this._link.request({ cmd: 'device.open', ...deviceFields(known), mode: this.mode });
  }

  async _setSink(id) {
    id = id || '';
    if (!this._web && this.status === 'connecting') await this.whenSettled;
    if (!this._web && this.status === 'falling-back') await this._fallbackP;
    if (this._web) return this._web.ctx.setSinkId(id);
    if (id === this._openedSinkId) {
      // the saved device was opened at connect: no second open
      this._sinkId = id;
      return undefined;
    }
    const desc = await this._describe(id, MASTER_DEVICE_KEY);
    if (!desc) {
      const e = new Error('Requested device not found');
      e.name = 'NotFoundError';
      throw e;
    }
    const r = await this._link.request({ cmd: 'device.open', ...deviceFields(desc), mode: this.mode });
    if (!r.ok) throw new Error(r.error || 'device.open failed');
    this._sinkId = id;
    this._openedSinkId = id;
    this._applyDeviceStatus(r.status);
    return undefined;
  }

  // ---- engine.js AudioEngine surface (§16.1) ------------------------------------------------

  get recDest() {
    const w = this._web || this._webPending;
    return w ? w.recDest : null;
  }

  resume() {
    if (this._web) return this._web.resume();
    return undefined;
  }

  _wireOutput() {
    if (this._web) return this._web._wireOutput();
    return undefined;
  }

  get phonesDevice() { return this._web ? this._web.phonesDevice : this._phonesId; }
  get phonesOk() { return this._web ? this._web.phonesOk : this._phonesOk; }

  async setPhonesDevice(deviceId) {
    const id = deviceId || '';
    if (this._web) return this._web.setPhonesDevice(id);
    if (id === this._phonesId && (!id || this._phonesSet)) return true;
    if (this.status === 'connecting') await this.whenSettled;
    if (this.status === 'falling-back') await this._fallbackP;
    if (this._web) return this._web.setPhonesDevice(id);
    this._phonesId = id;
    this._phonesSet = false;
    let fields = { name: null };
    if (id) {
      const desc = await this._describe(id, PHONES_DEVICE_KEY);
      if (!desc) {
        this._phonesId = '';
        return false;
      }
      fields = deviceFields(desc);
    }
    const r = await this._link.request({ cmd: 'device.phones', ...fields });
    if (this._web) return this._web.setPhonesDevice(id);
    if (!r.ok) {
      this._phonesId = '';
      return false;
    }
    this._phonesSet = !!id;
    if (r.status) this._applyDeviceStatus(r.status);
    return true;
  }

  setCuePfl(i, on) {
    if (this._web) return this._web.setCuePfl(i, on);
    const d = this.decks[i];
    d._cueOn = !!on;
    this._sendState(`d${i}.pfl`, { cmd: 'deck.pfl', deck: i, on: d._cueOn }, d._cueOn);
    return undefined;
  }

  get masterFx() {
    if (this._web) {
      if (!this._web.masterFx) return null;
      if (!this._masterFx) this._masterFx = new NativeFxUnit(this, 'master');
      this._masterFx._web = this._web.masterFx;
    }
    return this._masterFx;
  }

  ensureMasterFx() {
    if (!this._masterFx) {
      this._masterFx = new NativeFxUnit(this, 'master');
      this._send({ cmd: 'fx.set', unit: 'master' });
    }
    if (this._web) this._masterFx._web = this._web.ensureMasterFx();
    return this._masterFx;
  }

  setPadFx(i, preset) {
    if (this._web) {
      this._web.setPadFx(i, preset);
      if (this._web.padFx[i]) {
        if (!this.padFx[i]) this.padFx[i] = new NativeFxUnit(this, `pad${i}`);
        this.padFx[i]._web = this._web.padFx[i];
      }
      return;
    }
    if (!this.padFx[i]) {
      if (!preset) return;
      this.padFx[i] = new NativeFxUnit(this, `pad${i}`);
    }
    const u = this.padFx[i];
    if (preset) {
      u._type = preset.type;
      u._beatsMult = preset.beats;
      u._level = clamp(preset.level == null ? 1 : preset.level, 0, 1);
      u._enabled = true;
      this._send({ cmd: 'fx.pad', deck: i, preset: { type: engineFxType(preset.type), beats: preset.beats, level: u._level } });
    } else {
      u._enabled = false;
      this._send({ cmd: 'fx.pad', deck: i, preset: null });
    }
  }

  get fxAssign() { return this._web ? this._web.fxAssign : this._fxAssign; }
  set fxAssign(v) {
    if (this._web) { this._web.fxAssign = v; return; }
    this._fxAssign = v;
    this._checkFxAssign();
  }

  _fxMatrix() {
    const a = this._fxAssign || [];
    return [0, 1, 2, 3].map((u) => [0, 1, 2, 3].map((d) => !!(a[u] && a[u][d])));
  }

  /** The live matrix is compared with the last one sent (app.js mutates it in place). */
  _checkFxAssign() {
    const m = this._fxMatrix();
    const sig = m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('');
    if (sig === this._fxAssignSent) return false;
    this._fxAssignSent = sig;
    this._send({ cmd: 'fx.assign', assign: m });
    return true;
  }

  updateFxSends() {
    if (this._web) return this._web.updateFxSends();
    this._checkFxAssign();
    this._send({ cmd: 'fx.sends' });
    return undefined;
  }

  get masterVolume() { return this._web ? this._web.masterVolume : this._masterVolume; }
  setMasterVolume(v) {
    if (this._web) return this._web.setMasterVolume(v);
    this._masterVolume = clamp(v, 0, 1);
    this._sendState('mvol', { cmd: 'master.volume', v: this._masterVolume }, this._masterVolume);
    return undefined;
  }

  masterPeak() {
    if (this._web) return this._web.masterPeak();
    return this._masterPeak;
  }

  get masterFilterVal() { return this._web ? this._web.masterFilterVal : this._masterFilterVal; }
  setMasterFilter(v) {
    if (this._web) return this._web.setMasterFilter(v);
    this._masterFilterVal = clamp(v, -1, 1);
    this._sendState('mfilter', { cmd: 'master.filter', v: this._masterFilterVal }, this._masterFilterVal);
    return undefined;
  }

  get colorType() { return this._web ? this._web.colorType : this._colorType; }
  setColorType(t) {
    if (this._web) return this._web.setColorType(t);
    this._colorType = t;  // the mirror keeps the name, like engine.js colorType
    if (!COLOR_TYPES.has(t)) {
      // the engine would refuse the whole message: nothing is sent (the
      // engine keeps its current Color type), said once in the console
      if (!this._colorTypeWarned) {
        this._colorTypeWarned = true;
        this.env.log.warn?.(`[engine] unknown Color FX type "${t}": not sent to the native engine`);
      }
      return undefined;
    }
    this._sendState('color.type', { cmd: 'color.type', type: t }, t);
    return undefined;
  }

  get colorEnabled() { return this._web ? this._web.colorEnabled : this._colorEnabled; }
  setColorEnabled(b) {
    if (this._web) return this._web.setColorEnabled(b);
    this._colorEnabled = !!b;
    this._sendState('color.on', { cmd: 'color.enabled', on: this._colorEnabled }, this._colorEnabled);
    return undefined;
  }

  setDeckColor(i, v) {
    if (this._web) return this._web.setDeckColor(i, v);
    const d = this.decks[i];
    d._filterVal = Math.max(-1, Math.min(1, v));
    this._sendState(`d${i}.color`, { cmd: 'deck.color', deck: i, v: d._filterVal }, d._filterVal);
    return undefined;
  }

  get crossfader() { return this._web ? this._web.crossfader : this._crossfader; }
  setCrossfader(x) {
    if (this._web) return this._web.setCrossfader(x);
    this._crossfader = clamp(x, 0, 1);
    this._sendState('xf', { cmd: 'xf.set', x: this._crossfader }, this._crossfader);
    return undefined;
  }

  applyCrossfader() {
    if (this._web) return this._web.applyCrossfader();
    return undefined;
  }

  // ---- master and sync (engine.js rules on the mirrors; the servo runs in the engine) -----

  get masterIdx() { return this._web ? this._web.masterIdx : this._masterIdx; }
  set masterIdx(v) {
    if (this._web) { this._web.masterIdx = v; return; }
    this._masterIdx = v == null ? null : v;
    this._masterGate.mark(this._send({ cmd: 'sync.master', deck: this._masterIdx }), false, this.engineNow());
  }

  get autoMasterIdx() { return this._web ? this._web.autoMasterIdx : this._autoMasterIdx; }

  get jogHold() { return this._web ? this._web.jogHold : this._jogHold; }
  set jogHold(v) {
    if (this._web) { this._web.jogHold = v; return; }
    this._jogHold = !!v;
    this._sendState('jogHold', { cmd: 'sync.jogHold', on: this._jogHold }, this._jogHold);
  }

  setMaster(i) {
    if (this._web) return this._web.setMaster(i);
    this.masterIdx = this._masterIdx === i ? null : i;
    return undefined;
  }

  // read-only engine.js rules, run on the facades (whose fields forward to the Web decks after a fallback)
  getMasterDeck(excludeIdx) { return P.getMasterDeck.call(this, excludeIdx); }
  _pickBassDeck(excl) { return P._pickBassDeck.call(this, excl); }
  _beatPhase(d) { return P._beatPhase.call(this, d); }
  _barPhase(d) { return P._barPhase.call(this, d); }
  _period(d) { return P._period.call(this, d); }
  _localPeriod(d) { return P._localPeriod.call(this, d); }
  _syncRatio(d, m) { return P._syncRatio.call(this, d, m); }
  fxRefDeck(uIdx) { return P.fxRefDeck.call(this, uIdx); }
  nextBoundaryAt(d, periodBeats) { return P.nextBoundaryAt.call(this, d, periodBeats); }

  /** engine.js sync(i): decided and predicted on the mirrors, executed by the engine on exact positions. */
  sync(i) {
    if (this._web) return this._web.sync(i);
    const d = this.decks[i];
    if (!d.bpm) return false;
    const m = this.getMasterDeck(i);
    if (!m || !m.bpm) return false;
    const now = d._now();
    const ratio = clamp(this._syncRatio(d, m), 0.5, 1.6);
    if (d._playing) d._model.setRate(now, ratio);
    d._tempo = ratio;
    const pm = this._barPhase(m);
    const pd = this._barPhase(d);
    if (pm != null && pd != null) {
      let err = pm - pd;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      const pos = d.currentTime();
      let target = null;
      if (d.beats) {
        const f = gridIndexFracAt(d, pos);
        if (f != null) target = gridTimeAtIndex(d, f + err * 4);
      }
      if (target == null) target = pos + err * 4 * (this._period(d) || 60 / d.bpm);
      this._predictSeek(d, target);
    }
    d._synced = true;
    d._syncBaseV = d._tempo;
    d._syncRefV = d._tempo;
    d._pllCorrV = 0;
    const seq = this._send({ cmd: 'sync.do', deck: i });
    for (const g of Object.values(d._gates)) g.mark(seq, false, now);
    this._focusPcm(d, d.currentTime());
    return true;
  }

  /** The seek a sync / snap will make, predicted without a command (the engine computes its own). */
  _predictSeek(d, t) {
    t = clamp(t, -3600, d.duration);
    if (d._looping && (t < d._loopStart || t >= d._loopEnd)) {
      d._looping = false;
      d._loopBeatsV = null;
    }
    const now = d._now();
    if (d._playing) d._model.jumpMoving(t, now, d._tempo);
    else d._model.jumpStopped(t, now);
  }

  reanchorSync(i) {
    if (this._web) return this._web.reanchorSync(i);
    this._send({ cmd: 'sync.reanchor', deck: i });
    return undefined;
  }

  /** engine.js snapToRef: decided on the mirrors (the return value), executed by the engine. */
  snapToRef(i, maxErr = 0.06) {
    if (this._web) return this._web.snapToRef(i, maxErr);
    const d = this.decks[i];
    if (!d.buffer || !d.bpm || (d.beatOffset == null && !d.beats)) return false;
    const hasGrid = (x) => x && x.buffer && x.bpm && (x.beatOffset != null || x.beats);
    let m = null;
    if (this._masterIdx !== null && this._masterIdx !== i) {
      const cand = this.decks[this._masterIdx];
      if (hasGrid(cand) && cand.playing) m = cand;
    }
    if (!m) m = this.decks.find((x, j) => j !== i && x.playing && hasGrid(x)) || null;
    if (!m) return false;
    const pm = this._beatPhase(m);
    const pd = this._beatPhase(d);
    if (pm == null || pd == null) return false;
    let err = pm - pd;
    if (err > 0.5) err -= 1;
    if (err < -0.5) err += 1;
    const seq = this._send({ cmd: 'sync.snap', deck: i, maxErr });
    const now = this.engineNow();
    d._gates.transport.mark(seq, false, now);
    d._gates.loop.mark(seq, false, now);
    if (Math.abs(err) > maxErr) return false;
    this._predictSeek(d, d.currentTime() + err * (this._period(d) || 60 / d.bpm));
    return true;
  }

  /** app.js frame loop (engine.js: the sync servo). Native: the frame hook, no servo in JS. */
  syncLock() {
    if (this._web) return this._web.syncLock();
    this._frameWork();
    return undefined;
  }

  _frameWork() {
    if (this.status !== 'native') return;
    this._checkFxAssign();
    const g = getGlobalGridOffset();
    if (g !== this._gridOffsetSent) {
      this._gridOffsetSent = g;
      this._send({ cmd: 'grid.offset', sec: g });
    }
    if (this._link) this._link.frame();
    this.pcm.frame();
  }

  // ---- additions of the native engine (§17.2) -----------------------------------------------

  createVstHost(opts) {
    return new NativeVstHost(this, opts);
  }

  /** app.js samplerLoadSlot hook: the sampler sound is handed off now. */
  preloadSample(buffer) {
    if (this._web || !buffer) return;
    this.sampler.preload(buffer);
  }

  shadowStats() {
    return this.shadow.stats();
  }

  /** REC (native): master to WAV 24-bit in <dataDir>/recordings. Resolves with the rec.start reply. */
  async startRecording(opts = {}) {
    if (this.status === 'connecting') await this.whenSettled;
    if (this.status !== 'native' || !this._link) return { ok: false, error: 'native engine not active' };
    const cmd = { cmd: 'rec.start', format: opts.format || 'wav24' };
    if (opts.name) cmd.name = String(opts.name);
    const r = await this._link.request(cmd);
    if (r.ok) this._rec = { path: r.path || '', since: this.env.now() };
    return r;
  }

  /** Resolves with the rec.stop reply ({ok, path, seconds, bytes, dropped}); the file is never deleted. */
  async stopRecording() {
    const rec = this._rec;
    this._rec = null;
    if (this.status !== 'native' || !this._link) {
      return { ok: false, error: 'engine stopped', path: rec ? rec.path : '' };
    }
    const r = await this._link.request({ cmd: 'rec.stop' });
    if (!r.path && rec) r.path = rec.path;
    return r;
  }

  get recording() {
    return !!this._rec;
  }

  async _listRecordings() {
    if (!this._link) return;
    const r = await this._link.request({ cmd: 'rec.list' });
    if (r.ok && Array.isArray(r.files) && r.files.length) this._emit({ type: 'recordings-unsaved', files: r.files });
  }
}

export { STEMS };
