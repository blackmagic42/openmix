// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §7.2, §17.7):
// the PCM handoff scheduler. The engine plays exactly the samples Chromium
// decoded (cues and grids are seconds on Chromium's decoder timeline), so
// every track, stem and sampler sound decoded in the renderer is handed to
// the engine host:
//   - `pcm.begin` (ctl port) first; chunks only after its reply;
//   - float32 PLANAR chunks of `chunkFrames` frames, filled with
//     AudioBuffer.copyFromChannel (a native memcpy, no JavaScript loop) into
//     a pool of 2 reused Float32Arrays per stream, posted on the pcm port
//     WITHOUT a transfer list: the structured clone copies them during
//     postMessage, so the pool buffer is reusable at once and no garbage is
//     made;
//   - chunk order: the chunk under the deck's position and the one before it
//     (the WSOLA prime history) first, then forward to the end, then from 0;
//     reordered at every jump;
//   - at most 8 unacknowledged chunks per stream, at most ~2 ms of UI thread
//     per animation frame for all streams together (tracks of playing decks
//     first, then other tracks, stems, samples);
//   - a chunk answered NotFound is retried once after 50 ms, then the stream
//     is abandoned (the owner reloads it if it still needs it);
//   - `{loadId, end: true}` once every chunk is acknowledged; the engine then
//     emits pcm.done / pcm.error on the ctl port.

export const PCM_OK = 0;
export const PCM_ERR_STATE = -2;
export const PCM_NOT_FOUND = -7;
export const PCM_RANGE = -8;
export const MAX_IN_FLIGHT = 8;
export const POOL_SIZE = 2;
export const FRAME_BUDGET_MS = 2;
export const FRAME_WINDOW_MS = 1000 / 60;
export const RETRY_MS = 50;
export const DEFAULT_CHUNK_FRAMES = 65536;

/**
 * Track headroom from the peaks app.js already computed (computeBandPeaks
 * stores the signed per-slice extremes of both channels): peak = max over
 * slices of max(top, -bottom), headroom = max(1, peak). No peaks: 0 (per-chunk
 * headroom, computed by the engine).
 */
export function headroomFromPeaks(peaks) {
  const top = peaks && peaks.top;
  const bot = peaks && peaks.bottom;
  if (!top || !bot || !top.length) return { headroom: 0, peak: 0 };
  let p = 0;
  const n = Math.min(top.length, bot.length);
  for (let b = 0; b < n; b++) {
    const a = top[b];
    const c = -bot[b];
    if (a > p) p = a;
    if (c > p) p = c;
  }
  return { headroom: Math.max(1, p), peak: p };
}

/**
 * Send order of the chunks: for each focus chunk, that chunk and the one
 * before it; then forward from the first focus to the end; then from 0.
 * `skip(c)` leaves out chunks already sent.
 */
export function chunkOrder(n, focus, skip = () => false) {
  const out = [];
  const seen = new Uint8Array(n);
  const add = (c) => {
    if (c < 0 || c >= n || seen[c]) return;
    seen[c] = 1;
    if (!skip(c)) out.push(c);
  };
  const list = (Array.isArray(focus) ? focus : [focus]).filter((c) => Number.isFinite(c));
  const first = list.length ? Math.max(0, Math.min(n - 1, list[0])) : 0;
  for (const c of list) {
    add(c);
    add(c - 1);
  }
  for (let c = first; c < n; c++) add(c);
  for (let c = 0; c < first; c++) add(c);
  return out;
}

class PcmStream {
  constructor(sched, loadId, opts) {
    const b = opts.buffer;
    this.sched = sched;
    this.loadId = loadId;
    this.kind = opts.kind;                 // 'track' | 'stem' | 'sample'
    this.buffer = b;
    this.owner = opts.owner || null;       // the facade object it belongs to (deck, sampler slot)
    this.priority = opts.priority || (() => 9);
    this.format = opts.format || 's16';
    this.headroom = opts.headroom || 0;
    this.peak = opts.peak || 0;
    this.frames = b.length;
    // 1..8 channels go as decoded (the engine folds them to stereo); beyond 8 the engine's rule
    // for "other layouts" keeps the first two channels, so only those are handed off
    this.channels = b.numberOfChannels > 8 ? 2 : b.numberOfChannels;
    this.sampleRate = b.sampleRate;
    this.chunkFrames = sched.chunkFrames;
    this.nChunks = Math.max(1, Math.ceil(this.frames / this.chunkFrames));
    this.state = 'begin';                  // begin -> send -> end -> done | error | aborted
    this.sent = new Uint8Array(this.nChunks);    // 0 queued, 1 in flight, 2 acknowledged
    this.retried = new Uint8Array(this.nChunks);
    this.queue = chunkOrder(this.nChunks, [0]);
    this.qi = 0;
    this.inFlight = 0;
    this.acked = 0;
    this.pool = null;                      // POOL_SIZE Float32Arrays of channels x min(chunk, frames)
    this.views = null;                     // per pool buffer: one subarray per channel (full chunks)
    this.poolIdx = 0;
    this.t0 = sched.env.now();
    this.tDone = 0;
    this.error = null;
    this.whenDone = new Promise((resolve) => { this._resolveDone = resolve; });
  }

  get complete() { return this.state === 'done'; }
  get active() { return this.state === 'begin' || this.state === 'send' || this.state === 'end'; }

  /** Next chunk to send, or -1. */
  _next() {
    while (this.qi < this.queue.length) {
      const c = this.queue[this.qi++];
      if (this.sent[c] === 0) return c;
    }
    return -1;
  }

  _hasNext() {
    for (let i = this.qi; i < this.queue.length; i++) if (this.sent[this.queue[i]] === 0) return true;
    return false;
  }

  _ensurePool() {
    if (this.pool) return;
    const per = Math.min(this.chunkFrames, this.frames);
    this.pool = [];
    this.views = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const buf = new Float32Array(this.channels * per);
      this.pool.push(buf);
      const v = [];
      for (let c = 0; c < this.channels; c++) v.push(buf.subarray(c * per, (c + 1) * per));
      this.views.push(v);
    }
  }

  _finish(state, error) {
    if (!this.active && this.state !== 'begin') return;
    this.state = state;
    this.error = error || null;
    this.pool = null;
    this.views = null;
    this.tDone = this.sched.env.now();
    this._resolveDone(state);
  }
}

export class PcmScheduler {
  /**
   * link: { request(cmd) -> Promise<reply>, send(cmd), postPcm(msg) }
   * hooks: whenDone(stream), whenFailed(stream, error) (abandoned: the owner reloads it if needed)
   */
  constructor({ env, link = null, chunkFrames = DEFAULT_CHUNK_FRAMES, maxInFlight = MAX_IN_FLIGHT,
    budgetMs = FRAME_BUDGET_MS, whenDone = null, whenFailed = null } = {}) {
    this.env = env;
    this.link = link;
    this.chunkFrames = chunkFrames;
    this.maxInFlight = maxInFlight;
    this.budgetMs = budgetMs;
    this.whenDone = whenDone;
    this.whenFailed = whenFailed;
    this.streams = new Map();
    this.nextLoadId = 1;
    this._windowStart = -Infinity;
    this._spent = 0;
    this._windowChunks = 0;
    this._timer = null;
    this._pumping = false;
    this._msPerSample = 0;
    this.stats = { chunks: 0, bytes: 0, pumps: 0, maxPumpMs: 0, maxWindowMs: 0, chunkMs: 0, retries: 0, abandoned: 0 };
  }

  /** Starts a stream: pcm.begin now (the caller may batch an attach command right after). */
  start(opts) {
    const loadId = this.nextLoadId++;
    const s = new PcmStream(this, loadId, opts);
    this.streams.set(loadId, s);
    if (opts.focusSec != null) this.focus(s, opts.focusSec);
    const cmd = {
      cmd: 'pcm.begin', loadId, kind: s.kind, format: s.format, sourceChannels: s.channels,
      sampleRate: s.sampleRate, frames: s.frames, headroom: s.headroom, peak: s.peak
    };
    Promise.resolve(this.link.request(cmd)).then((r) => this._onBegin(s, r),
      (e) => this._onBegin(s, { ok: false, error: String((e && e.message) || e) }));
    return s;
  }

  _onBegin(s, r) {
    if (s.state !== 'begin') return;
    if (r && r.ok) {
      s.state = 'send';
      this.kick();
    } else {
      this.streams.delete(s.loadId);
      s._finish('error', (r && r.error) || 'pcm.begin failed');
      if (this.whenFailed) this.whenFailed(s, s.error);
    }
  }

  /** Reorders the queue: the chunk at `sec` (+ the one before) first, then `extraSec` chunks. */
  focus(s, sec, extraSec = []) {
    if (!s || !s.active) return;
    const toChunk = (x) => Math.floor((Math.max(0, Number(x) || 0) * s.sampleRate) / s.chunkFrames);
    const focus = [toChunk(sec), ...extraSec.filter((x) => x != null).map(toChunk)];
    s.queue = chunkOrder(s.nChunks, focus, (c) => s.sent[c] !== 0);
    s.qi = 0;
    this.kick();
  }

  /** Aborts an incomplete stream (another track on the deck, unload). */
  abort(s) {
    if (!s || !s.active) return;
    this.streams.delete(s.loadId);
    s._finish('aborted');
    if (this.link) this.link.send({ cmd: 'pcm.abort', loadId: s.loadId });
  }

  /** Called at every animation frame: opens a new 2 ms window and pumps. */
  frame() {
    this._windowStart = this.env.now();
    this._spent = 0;
    this._windowChunks = 0;
    this.pump();
  }

  /** Pumps if the current window has budget left; otherwise at the next window. */
  kick() {
    if (this._pumping) return;
    this.env.queueMicrotask(() => this.pump());
  }

  get busy() {
    for (const s of this.streams.values()) if (s.active) return true;
    return false;
  }

  pump() {
    if (this._pumping || !this.link) return;
    const env = this.env;
    let now = env.now();
    if (now - this._windowStart >= FRAME_WINDOW_MS) {
      // no animation frame came (hidden window, tests): time-based windows
      this._windowStart = now;
      this._spent = 0;
      this._windowChunks = 0;
    }
    if (this._windowChunks > 0 && this._spent >= this.budgetMs) {
      this._schedule(FRAME_WINDOW_MS - (now - this._windowStart));
      return;
    }
    this._pumping = true;
    const t0 = now;
    let full = false;
    try {
      const list = [...this.streams.values()].filter((s) => s.state === 'send');
      if (list.length > 1) list.sort((a, b) => a.priority() - b.priority());
      for (const s of list) {
        while (s.state === 'send' && s.inFlight < this.maxInFlight) {
          // predictive budget: the next chunk must fit; the first one of a window always
          // goes, so the handoff progresses even on a machine where one chunk exceeds the budget
          const used = this._spent + (env.now() - t0);
          if (this._windowChunks > 0 && used + this._chunkCost(s) > this.budgetMs) { full = true; break; }
          const c = s._next();
          if (c < 0) break;
          const a = env.now();
          this._sendChunk(s, c);
          this._windowChunks++;
          this._learnCost(s, env.now() - a);
        }
        if (full) break;
      }
    } finally {
      this._pumping = false;
    }
    now = env.now();
    const dt = now - t0;
    this._spent += dt;
    this.stats.pumps++;
    if (dt > this.stats.maxPumpMs) this.stats.maxPumpMs = dt;
    if (this._spent > this.stats.maxWindowMs) this.stats.maxWindowMs = this._spent;
    // budget used up with work left: continue in the next window
    for (const s of this.streams.values()) {
      if (s.state === 'send' && s.inFlight < this.maxInFlight && s._hasNext()) {
        this._schedule(Math.max(1, FRAME_WINDOW_MS - (now - this._windowStart)));
        break;
      }
    }
  }

  /** Expected UI-thread cost (ms) of the next chunk of `s` (per-sample EMA; 0 until measured). */
  _chunkCost(s) {
    return this._msPerSample * s.channels * Math.min(s.chunkFrames, s.frames);
  }

  _learnCost(s, ms) {
    const samples = s.channels * Math.min(s.chunkFrames, s.frames);
    if (!(samples > 0) || !(ms >= 0)) return;
    const per = ms / samples;
    this._msPerSample = this._msPerSample ? this._msPerSample * 0.8 + per * 0.2 : per;
    this.stats.chunkMs = this._msPerSample * 2 * this.chunkFrames;   // KPI: a stereo chunk
  }

  _schedule(ms) {
    if (this._timer != null) return;
    this._timer = this.env.setTimeout(() => {
      this._timer = null;
      this.pump();
    }, Math.max(1, ms));
  }

  _sendChunk(s, c) {
    s._ensurePool();
    const offset = c * s.chunkFrames;
    const frames = Math.min(s.chunkFrames, s.frames - offset);
    const ch = s.channels;
    const i = s.poolIdx;
    s.poolIdx = (s.poolIdx + 1) % POOL_SIZE;
    const buf = s.pool[i];
    let data;
    let views;
    if (frames * ch === buf.length) {
      data = buf;
      views = s.views[i];
    } else {
      // last (shorter) chunk: planar with a stride of `frames`, in the same pool buffer
      data = new Float32Array(buf.buffer, 0, ch * frames);
      views = [];
      for (let k = 0; k < ch; k++) views.push(data.subarray(k * frames, (k + 1) * frames));
    }
    for (let k = 0; k < ch; k++) s.buffer.copyFromChannel(views[k], k, offset);
    // NO transfer list: the structured clone copies `data` now (SPEC.md §7.2.4)
    this.link.postPcm({ loadId: s.loadId, offset, frames, channels: ch, data });
    s.sent[c] = 1;
    s.inFlight++;
    this.stats.chunks++;
    this.stats.bytes += ch * frames * 4;
  }

  /** pcm port: {loadId, offset, code}. */
  onAck(msg) {
    if (!msg) return;
    const s = this.streams.get(msg.loadId);
    if (!s || s.state !== 'send') return;
    const c = Math.round(msg.offset / s.chunkFrames);
    if (!(c >= 0 && c < s.nChunks) || s.sent[c] !== 1) return;
    s.inFlight--;
    const code = msg.code | 0;
    if (code === PCM_OK) {
      s.sent[c] = 2;
      s.acked++;
      if (s.acked === s.nChunks) {
        s.state = 'end';
        this.link.postPcm({ loadId: s.loadId, end: true });
        return;
      }
      this.kick();
      return;
    }
    if (code === PCM_NOT_FOUND && !s.retried[c]) {
      // the engine reset its epoch or the stream raced an abort: once more after 50 ms
      s.retried[c] = 1;
      s.sent[c] = 0;
      this.stats.retries++;
      this.env.setTimeout(() => {
        if (s.state !== 'send') return;
        s.queue.splice(s.qi, 0, c);
        this.kick();
      }, RETRY_MS);
      return;
    }
    this._abandon(s, code === PCM_NOT_FOUND ? 'not found' : `chunk error ${code}`);
  }

  /** ctl events pcm.done / pcm.error. */
  onDone(loadId) {
    const s = this.streams.get(loadId);
    if (!s) return;
    this.streams.delete(loadId);
    s._finish('done');
    if (this.whenDone) this.whenDone(s);
  }

  onError(loadId, error) {
    const s = this.streams.get(loadId);
    if (s) this._abandon(s, error || 'error');
  }

  _abandon(s, error) {
    if (!s.active) return;
    this.streams.delete(s.loadId);
    s._finish('error', error);
    this.stats.abandoned++;
    if (this.link) this.link.send({ cmd: 'pcm.abort', loadId: s.loadId });
    if (this.whenFailed) this.whenFailed(s, error);
  }

  /** Engine gone (fallback): every stream stops, nothing is sent any more. */
  stopAll() {
    for (const s of this.streams.values()) s._finish('aborted', 'engine gone');
    this.streams.clear();
    if (this._timer != null) this.env.clearTimeout(this._timer);
    this._timer = null;
    this.link = null;
  }
}
