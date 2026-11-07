// Test helpers of the native engine's JS proxy (owner: jsproxy, native/engine/SPEC.md §18.3):
// a fake clock with timers, fake MessagePorts with a delivery latency, a fake
// engine host speaking the JSON protocol (hello, clock.ping, pcm.*, deck.*,
// device.*, rec.*, vst.*, state snapshots), a fake window.omEngine, fake
// AudioBuffers and a fake Web AudioEngine for the fallback. No Electron, no
// audio: everything runs under `node --test`.

export const ENGINE_OFFSET = 1000;   // engine clock = perf seconds + 1000 (the proxy must sync)

export class FakeClock {
  constructor(t0 = 10000) {
    this.t = t0;
    this.timers = [];
    this.seq = 0;
  }

  now = () => this.t;

  setTimeout = (fn, ms) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms || 0), fn, every: 0 });
    return id;
  };

  setInterval = (fn, ms) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn, every: ms });
    return id;
  };

  clearTimeout = (id) => { this.timers = this.timers.filter((x) => x.id !== id); };
  clearInterval = (id) => this.clearTimeout(id);

  /** Runs the timers due within `ms`, in order, letting microtasks run between them. */
  async advance(ms = 0) {
    const end = this.t + ms;
    await settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.t = Math.max(this.t, next.at);
      // like browser timers: a late interval fires once, then `every` after that (no catch-up burst)
      if (next.every) next.at = this.t + next.every;
      else this.timers.shift();
      next.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

export async function settle(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Awaits `p` while the fake clock runs (replies travel through fake ports on that clock). */
export async function drive(clock, p, maxMs = 5000) {
  let done = false;
  let val;
  let err = null;
  Promise.resolve(p).then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
  for (let t = 0; !done && t < maxMs; t++) await clock.advance(1);
  if (!done) throw new Error('drive: still pending');
  if (err) throw err;
  return val;
}

/** A MessagePort pair; messages are structured-cloned and delivered after `latency` ms of fake time. */
export function makeChannel(clock, latency = 0) {
  const mk = () => ({
    onmessage: null,
    other: null,
    posts: [],          // every postMessage call: { args }
    closed: false,
    latency,
    postMessage(...args) {
      this.posts.push(args);
      if (this.closed) return;
      const data = structuredClone(args[0]);
      const dest = this.other;
      clock.setTimeout(() => { if (dest.onmessage && !dest.closed) dest.onmessage({ data }); }, this.latency);
    },
    start() {},
    close() { this.closed = true; }
  });
  const a = mk();
  const b = mk();
  a.other = b;
  b.other = a;
  return [a, b];
}

export class FakeAudioBuffer {
  constructor({ channels = 2, length, sampleRate = 48000, fill = null }) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = [];
    for (let c = 0; c < channels; c++) {
      const d = new Float32Array(length);
      if (fill) for (let i = 0; i < length; i++) d[i] = fill(c, i);
      this.data.push(d);
    }
    this.copyCalls = 0;
  }

  get duration() { return this.length / this.sampleRate; }

  getChannelData(c) { return this.data[c]; }

  copyFromChannel(dest, c, offset = 0) {
    this.copyCalls++;
    const src = this.data[c];
    const n = Math.max(0, Math.min(dest.length, src.length - offset));
    dest.set(src.subarray(offset, offset + n));
  }
}

export function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  const raw = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m
  };
  return raw;
}

export function makeWindow() {
  const listeners = new Set();
  return {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    post(data, ports) { for (const fn of [...listeners]) fn({ data, ports }); },
    listeners
  };
}

const NOT_ACKED = new Set(['hello', 'engine.config', 'clock.ping', 'pcm.begin', 'pcm.abort', 'device.status', 'rec.status',
  'vst.status', 'device.list', 'device.open', 'device.close', 'device.phones', 'rec.start', 'rec.stop', 'rec.list', 'shutdown',
  'vst.load', 'vst.unload', 'vst.editor', 'vst.editorClose', 'vst.getState', 'vst.setState']);

/** A fake engine host on the host side of the two ports. */
export class FakeHost {
  constructor(clock, { ctl, pcm, epoch = 7, sampleRate = 48000, chunkFrames = 65536, latency = 0.03, deviceOpenDelay = 0 } = {}) {
    this.clock = clock;
    this.ctl = ctl;
    this.pcm = pcm;
    this.epoch = epoch;
    this.sampleRate = sampleRate;
    this.chunkFrames = chunkFrames;
    this.latency = latency;            // presentTime - now (s)
    this.deviceOpenDelay = deviceOpenDelay;
    this.commands = [];                // every command received, batches flattened
    this.batches = [];                 // raw texts
    this.chunks = [];                  // pcm messages received
    this.streams = new Map();          // loadId -> { desc, got: Set, ended }
    this.ack = 0;
    this.block = 0;
    this.pongDelay = 0;                // ms before a pong leaves
    this.silent = false;               // stop answering anything (hung host)
    this.ackChunks = true;
    this.notFound = new Set();         // loadIds whose chunks answer NotFound
    this.deviceOpen = { ok: true, status: { mode: 'lowlatency', name: 'Speakers', sampleRate, channels: 2, periodFrames: 240, latencyMs: 12.5 } };
    this.beginReply = { ok: true };
    this.recFiles = [];
    this.vstLoad = { ok: true, latency: 0 };
    this.decks = [0, 1, 2, 3].map(() => this._emptyDeck());
    ctl.onmessage = (e) => this._onCtl(e.data);
    pcm.onmessage = (e) => this._onPcm(e.data);
  }

  _emptyDeck() {
    return { loadId: 0, loaded: false, playing: false, armed: false, pos: 0, rate: 0, tempo: 1, seg: 0, anchorT: 0, anchorPos: 0,
      endedCount: 0, endedAt: null, duration: 0, looping: false, loopStart: 0, loopEnd: 0, loopBeats: null, peak: 0 };
  }

  engineNow() { return this.clock.now() / 1000 + ENGINE_OFFSET; }

  emit(ev) {
    if (this.silent) return;
    this.ctl.postMessage(JSON.stringify(ev));
  }

  reply(c, ok, fields = {}) {
    if (c.id == null) return;
    this.emit({ ev: 'reply', id: c.id, ok, ...fields });
  }

  _onCtl(text) {
    if (this.silent) return;
    this.batches.push(text);
    const msg = JSON.parse(text);
    const list = Array.isArray(msg) ? msg : [msg];
    for (const c of list) {
      this.commands.push(c);
      this._run(c);
    }
  }

  cmds(name) { return this.commands.filter((c) => c.cmd === name); }

  _run(c) {
    // state.ack covers what the AUDIO thread applied: audio-route commands, and the inline
    // commands that push attach commands (SPEC.md §3.3); never pings, PCM, ops or vst commands
    if (c.seq > this.ack && !c.when && !NOT_ACKED.has(c.cmd)) this.ackPending = Math.max(this.ackPending || 0, c.seq);
    switch (c.cmd) {
      case 'hello': this.reply(c, true, { engine: 'test', protocol: 2, sampleRate: this.sampleRate, channels: 2, chunkFrames: this.chunkFrames, epoch: this.epoch }); break;
      case 'clock.ping': {
        const t0 = c.t0;
        this.clock.setTimeout(() => this.emit({ ev: 'clock.pong', t0, te: this.engineNow() }), this.pongDelay);
        break;
      }
      case 'device.open':
        this.clock.setTimeout(() => this.reply(c, this.deviceOpen.ok,
          this.deviceOpen.ok ? { status: this.deviceOpen.status } : { error: this.deviceOpen.error || 'no device' }), this.deviceOpenDelay);
        break;
      case 'device.phones': this.reply(c, true, { status: this.deviceOpen.status }); break;
      case 'pcm.begin': {
        if (this.beginReply.ok) this.streams.set(c.loadId, { desc: c, got: new Set(), ended: false });
        this.reply(c, this.beginReply.ok, this.beginReply.ok ? {} : { error: this.beginReply.error || 'memory' });
        break;
      }
      case 'pcm.abort': this.streams.delete(c.loadId); break;
      case 'deck.load': {
        const ok = this.streams.has(c.loadId);
        if (ok) {
          const d = this.decks[c.deck];
          Object.assign(d, this._emptyDeck(), { loadId: c.loadId, loaded: true, duration: this.streams.get(c.loadId).desc.frames / this.streams.get(c.loadId).desc.sampleRate, seg: d.seg + 1, endedCount: d.endedCount });
        }
        this.reply(c, ok, ok ? {} : { error: 'unknown loadId' });
        break;
      }
      case 'deck.stems': this.reply(c, true); break;
      case 'deck.tempo': this.decks[c.deck].tempo = c.r; if (this.decks[c.deck].rate) this.decks[c.deck].rate = c.r; break;
      case 'sampler.load': this.reply(c, this.streams.has(c.loadId)); break;
      case 'rec.start': this.reply(c, true, { path: 'C:/data/recordings/OpenMix 2026-10-20 21h00.wav' }); break;
      case 'rec.stop': this.reply(c, true, { path: 'C:/data/recordings/OpenMix 2026-10-20 21h00.wav', seconds: 61.5, bytes: 17712044, dropped: 0 }); break;
      case 'rec.list': this.reply(c, true, { files: this.recFiles }); break;
      case 'vst.load': this.reply(c, this.vstLoad.ok, { name: String(c.path).replace(/^.*[\/]/, '').replace(/\.vst3$/i, ''), ...this.vstLoad }); break;
      case 'vst.unload': case 'vst.editor': case 'vst.setState': this.reply(c, true); break;
      case 'vst.getState': this.reply(c, true, { state: 'QUJD' }); break;
      case 'vst.status': this.reply(c, true, { loaded: true }); break;
      default:
        if (c.id != null) this.reply(c, true);
        break;
    }
  }

  _onPcm(m) {
    if (this.silent) return;
    this.chunks.push(m);
    if (m.end) {
      const s = this.streams.get(m.loadId);
      if (!s) return;
      const n = Math.ceil(s.desc.frames / this.chunkFrames);
      this.emit(s.got.size === n ? { ev: 'pcm.done', loadId: m.loadId } : { ev: 'pcm.error', loadId: m.loadId, error: 'incomplete' });
      return;
    }
    if (m.abort) return;
    if (!this.ackChunks) return;
    let code = 0;
    const s = this.streams.get(m.loadId);
    if (!s || this.notFound.has(m.loadId)) code = -7;
    else if (s.got.has(m.offset)) code = -8;
    else s.got.add(m.offset);
    this.pcm.postMessage({ loadId: m.loadId, offset: m.offset, code });
  }

  /** Heard position of deck i at engine time t (segment model). */
  posAt(i, t) {
    const d = this.decks[i];
    if (!d.playing || !d.rate || t <= d.anchorT) return d.anchorPos;
    let p = d.anchorPos + (t - d.anchorT) * d.rate;
    if (d.looping && p > d.loopEnd) p = d.loopStart + ((p - d.loopStart) % (d.loopEnd - d.loopStart));
    return Math.min(p, d.duration);
  }

  /** The next block (heard at now + latency) starts playback: a new segment. */
  play(i) {
    const d = this.decks[i];
    const at = this.engineNow() + this.latency;
    d.seg++;
    d.anchorT = at;
    d.playing = true;
    d.rate = d.tempo;
  }

  /** The next block pauses at the heard position: a new segment, rate 0. */
  pause(i) {
    const d = this.decks[i];
    const at = this.engineNow() + this.latency;
    d.anchorPos = this.posAt(i, at);
    d.anchorT = at;
    d.seg++;
    d.playing = false;
    d.rate = 0;
  }

  /** deck.seek {t, at}: while playing the target is advanced by (presentTime - at) x tempo. */
  seek(i, target, at) {
    const d = this.decks[i];
    const pt = this.engineNow() + this.latency;
    d.anchorPos = d.playing ? target + (pt - (at ?? pt)) * d.tempo : target;
    d.anchorT = pt;
    d.seg++;
  }

  /** Applies everything received so far (ack) and publishes a state built from this.decks. */
  state(extra = {}) {
    if (this.ackPending) this.ack = Math.max(this.ack, this.ackPending);
    this.block++;
    const t = this.engineNow() + this.latency;
    const s = {
      ev: 'state', t, ack: this.ack, epoch: this.epoch, block: this.block,
      decks: this.decks.map((d, i) => ({ ...d, pos: this.posAt(i, t) })),
      sync: { masterIdx: null, autoMasterIdx: null, jogHold: false, synced: [false, false, false, false],
        calibrated: [false, false, false, false], syncBase: [null, null, null, null], syncRef: [null, null, null, null],
        pllCorr: [0, 0, 0, 0], beatDur: [null, null, null, null] },
      mixer: { masterPeak: 0.5 },
      device: { mode: 3, rate: this.sampleRate, channels: 2, period: 240, latency: this.latency, cueRouted: false },
      pcmBytes: 1234,
      ...extra
    };
    this.emit(s);
    return s;
  }

  hb() { this.emit({ ev: 'hb', t: this.engineNow(), block: this.block, running: true }); }
}

/** A fake window.omEngine whose connect() spawns a FakeHost and posts its ports through `win`. */
export function makeOmEngine(clock, win, opts = {}) {
  const calls = [];
  const om = {
    calls,
    host: null,
    exitCb: null,
    available: opts.available !== false,
    connectDelay: opts.connectDelay || 0,
    neverPorts: !!opts.neverPorts,
    hostOpts: opts.hostOpts || {},
    info: async () => { calls.push('info'); return { available: om.available, reason: om.available ? '' : 'not built' }; },
    connect: async () => {
      calls.push('connect');
      const [ctlR, ctlH] = makeChannel(clock, opts.latency || 0);
      const [pcmR, pcmH] = makeChannel(clock, opts.latency || 0);
      om.host = new FakeHost(clock, { ctl: ctlH, pcm: pcmH, ...om.hostOpts });
      if (opts.onHost) opts.onHost(om.host);
      if (!om.neverPorts) clock.setTimeout(() => win.post('openmix-engine-ports', [ctlR, pcmR]), om.connectDelay);
      return { ok: true };
    },
    kill: async () => { calls.push('kill'); if (om.host) om.host.silent = true; return true; },
    onExit: (cb) => { om.exitCb = cb; },
    vstScan: async (files) => { calls.push('vstScan'); return files.map((p) => ({ path: p, uid: 'U', name: p.replace(/^.*\//, '') })); },
    saveRecording: async (path, name) => { calls.push(['saveRecording', path, name]); return opts.saveResult || { ok: true, path: `D:/Mixes/${name}` }; },
    revealFile: async (path) => { calls.push(['revealFile', path]); return true; },
    shadowDecode: async (job) => { calls.push(['shadowDecode', job]); return opts.shadowResult || { ok: true, offsetMs: 0.2, lengthDiffMs: 0, rmsDiffDb: -90, correlation: 0.999 }; },
    memoryInfo: async () => ({ private: 512000 })
  };
  return om;
}

/** A fake engine.js AudioEngine recording what the fallback does to it, in order. */
export function makeFakeWebEngineClass(log, { wsolaAfterMs = 0, clock } = {}) {
  return class FakeWebEngine {
    constructor() {
      log.push('new AudioEngine');
      const L = (s) => log.push(s);
      this.ctx = {
        sampleRate: 48000, currentTime: 0, state: 'running',
        setSinkId: async (id) => L(`setSinkId ${id}`),
        decodeAudioData: async () => Object.assign(new FakeAudioBuffer({ length: 48000 * 20, sampleRate: 48000 }), { web: true }),
        resume: async () => {},
        createGain: () => ({ gain: { value: 1 }, connect() {} }),
        createBufferSource: () => ({ connect() {}, start() {}, stop() {}, playbackRate: { value: 1 } })
      };
      this.recDest = { stream: 'web-stream' };
      this.postBus = { name: 'webPostBus' };
      this.padFx = [null, null, null, null];
      this.fx = [0, 1, 2, 3].map((u) => ({
        type: 'echo', enabled: false, level: 0, beatsMult: 0.5,
        setType(t) { this.type = t; L(`fx${u}.setType ${t}`); }, setEnabled(b) { this.enabled = b; L(`fx${u}.setEnabled ${b}`); },
        setLevel(v) { this.level = v; }, setBeatsMult(m) { this.beatsMult = m; }, setBeatDur() {}
      }));
      this.fxAssign = null;
      this.decks = [0, 1, 2, 3].map((i) => {
        const d = {
          id: i, wsola: null, playing: false, buffer: null, offset: 0, tempo: 1, keyShift: 0, keylock: false,
          stemGains: { vocals: { gain: { value: 1 } }, drums: { gain: { value: 1 } }, bass: { gain: { value: 1 } }, other: { gain: { value: 1 } } },
          hotCues: new Array(8).fill(null),
          loadTrack(o) { Object.assign(this, { buffer: o.buffer, bpm: o.bpm, track: o.track, peaks: o.peaks, hotCues: [...(o.hotCues || [])] }); L(`deck${i}.loadTrack`); },
          setVolume(v) { this.volume = v; }, setEq() {}, setTrim() {},
          setTempo(r) { this.tempo = r; L(`deck${i}.setTempo ${r}`); },
          setKey(s) { this.keyShift = s; L(`deck${i}.setKey ${s} wsola=${!!this.wsola}`); },
          setKeylock(b) { this.keylock = b; L(`deck${i}.setKeylock ${b} wsola=${!!this.wsola}`); },
          setLoop(s, e) { L(`deck${i}.setLoop ${s} ${e}`); },
          seek(t) { this.offset = t; L(`deck${i}.seek ${t.toFixed(3)}`); },
          play() { this.playing = true; L(`deck${i}.play`); },
          pause() { this.playing = false; },
          currentTime() { return this.offset; },
          loadStems(st) { this.stems = st; this.stemsOn = true; L(`deck${i}.loadStems`); },
          setInsert() {}
        };
        return d;
      });
      if (clock) clock.setTimeout(() => { this.decks.forEach((d) => { d.wsola = {}; }); L('wsola ready'); }, wsolaAfterMs);
      else this.decks.forEach((d) => { d.wsola = {}; });
    }
    resume() {}
    _wireOutput() { log.push('_wireOutput'); }
    async setPhonesDevice(id) { log.push(`setPhonesDevice ${id}`); this.phonesDevice = id; return true; }
    setCuePfl() {}
    setColorType() {}
    setColorEnabled() {}
    setDeckColor() {}
    setCrossfader(x) { this.crossfader = x; log.push(`setCrossfader ${x}`); }
    setMasterVolume(v) { this.masterVolume = v; log.push(`setMasterVolume ${v}`); }
    setMasterFilter() {}
    updateFxSends() { log.push('updateFxSends'); }
    ensureMasterFx() { if (!this.masterFx) this.masterFx = { type: 'echo', setType() {}, setBeatsMult() {}, setLevel() {}, setEnabled() {} }; return this.masterFx; }
    setPadFx(i, p) { log.push(`setPadFx ${i}`); if (p && !this.padFx[i]) this.padFx[i] = { enabled: true }; }
    syncLock() { log.push('web.syncLock'); }
    sync() { return true; }
    getMasterDeck() { return null; }
  };
}

/** A NativeEngine wired to fakes, connected (unless opts.noConnect). */
export async function makeEngine(NativeEngine, opts = {}) {
  const clock = opts.clock || new FakeClock();
  const win = opts.win || makeWindow();
  const storage = makeStorage(opts.storage || {});
  const om = opts.om === null ? null : (opts.om || makeOmEngine(clock, win, opts.omOpts || {}));
  const log = { lines: [], log: (...a) => log.lines.push(a.join(' ')), warn: (...a) => log.lines.push(a.join(' ')), error: (...a) => log.lines.push(a.join(' ')) };
  const webLog = [];
  const WebEngine = opts.WebEngine || makeFakeWebEngineClass(webLog, { clock, wsolaAfterMs: opts.wsolaAfterMs || 0 });
  const offline = [];
  class FakeOffline {
    constructor(ch, len, rate) { this.rate = rate; offline.push(rate); }
    async decodeAudioData() { return new FakeAudioBuffer({ length: 4800, sampleRate: this.rate }); }
  }
  const { safeStorage } = await import('../../src/js/native-engine/env.js');
  const env = {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    queueMicrotask: (f) => queueMicrotask(f),
    storage: safeStorage(storage), omEngine: om, win, log,
    api: opts.api || null,
    mediaDevices: opts.mediaDevices || { enumerateDevices: async () => opts.devices || [] },
    OfflineAudioContext: FakeOffline,
    AudioEngine: WebEngine,
    VstHost: opts.VstHost || null
  };
  const fallbacks = [];
  const fallbackCodes = [];
  const events = [];
  const engine = new NativeEngine({
    env, mode: opts.mode, onFallback: (r, code) => { fallbacks.push(r); fallbackCodes.push(code); }, onEvent: (e) => events.push(e)
  });
  const ctx = { clock, win, storage, om, log, webLog, engine, fallbacks, fallbackCodes, events, offline, env };
  if (!opts.noConnect) {
    await clock.advance(50);
    ctx.host = om && om.host;
  }
  return ctx;
}
