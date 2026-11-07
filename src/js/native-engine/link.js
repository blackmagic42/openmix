// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §15.1, §17.4):
// the two MessagePorts to the engine host. "ctl" carries JSON text both ways
// (commands and their replies / events); "pcm" carries the PCM chunks
// (structured clone, renderer -> host) and their acknowledgements.
//
// Every command gets `seq` (monotonic per connection, acknowledged in
// state.ack once the audio thread applied it) and `at` = engineNow(). The
// commands produced during one JS task leave as ONE batch (a JSON array,
// flushed by a microtask); the engine applies a batch atomically or rejects
// it whole with "full", in which case it is resent unchanged at the next
// animation frame. Commands that ask for a reply get an `id`.
//
// Order: once a batch was refused "full", every newer batch is HELD behind it
// (a smaller later batch could otherwise fit where the refused one did not,
// and reach the audio thread first). The resend leaves as ONE message (the
// refused batch, plus the held ones up to RESEND_CHUNK_COMMANDS commands):
// the engine applies a message atomically, so their order is kept. When no
// refusal came back for RESEND_CONFIRM_MS, the engine took it: what is still
// held leaves at once and new batches flow directly again.

/** Refusals ("full") after which a batch is dropped instead of resent (~5 s of animation frames). */
export const MAX_FULL_RESENDS = 300;
/** A resent message not refused within this time (ms) was accepted (the host answers a refusal at once). */
export const RESEND_CONFIRM_MS = 8;
/** At most this many commands per resend message (the engine's command queue holds 4096). */
export const RESEND_CHUNK_COMMANDS = 1024;

/** The commands of a batch text, without its brackets (to join batches into one message). */
const innerOf = (text) => (text[0] === '[' ? text.slice(1, -1) : text);

export class EngineLink {
  constructor({ env, ctl, pcm, engineNow, onEvent, onPcm }) {
    this.env = env;
    this.ctl = ctl;
    this.pcmPort = pcm;
    this.engineNow = engineNow;
    this.seq = 0;
    this.nextId = 1;
    this.outbox = [];
    this.flushQueued = false;
    this.pending = new Map();   // id -> { resolve, cmd }
    this.recent = [];           // last messages posted: { text, first, last, n }
    this.resendQueue = [];      // batches refused "full", then the newer ones held behind them: { text, first, last, n }, in seq order
    this._inFlight = null;      // the resend message last posted, not confirmed yet: { first, count, postedAt }
    this._fullCount = new Map(); // first seq of a batch -> times refused "full" (Infinity = dropped)
    this._resendTimer = null;
    this.closed = false;
    this.stats = { batches: 0, commands: 0, bytes: 0, full: 0, resent: 0, dropped: 0, held: 0 };
    const listen = (port, fn) => {
      if (!port) return;
      if ('onmessage' in port || typeof port.addEventListener !== 'function') port.onmessage = (e) => fn(e.data);
      else port.addEventListener('message', (e) => fn(e.data));
      if (typeof port.start === 'function') port.start();
    };
    listen(ctl, onEvent);
    listen(pcm, onPcm);
  }

  _stamp(cmd, opts) {
    cmd.seq = ++this.seq;
    cmd.at = this.engineNow();
    if (opts && opts.when != null) cmd.when = opts.when;
    return cmd.seq;
  }

  /** Queues one command (sent at the end of the current task). Returns its seq. */
  send(cmd, opts) {
    if (this.closed) return 0;
    const seq = this._stamp(cmd, opts);
    this.outbox.push(cmd);
    this._queueFlush();
    return seq;
  }

  /** Queues a command whose fields are computed when the batch leaves (coalesced setters). */
  lazy(build) {
    if (this.closed) return 0;
    const entry = { lazy: build, seq: ++this.seq, at: this.engineNow() };
    this.outbox.push(entry);
    this._queueFlush();
    return entry.seq;
  }

  /** Queues a command with an `id`; resolves with its reply event ({ok, error?, ...}). */
  request(cmd, opts) {
    if (this.closed) return Promise.resolve({ ok: false, error: 'engine gone' });
    const id = this.nextId++;
    cmd.id = id;
    const p = new Promise((resolve) => this.pending.set(id, { resolve, cmd: cmd.cmd }));
    this.send(cmd, opts);
    return p;
  }

  _queueFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.env.queueMicrotask(() => this.flush());
  }

  flush() {
    this.flushQueued = false;
    if (this.closed || !this.outbox.length) {
      this.outbox.length = 0;
      return;
    }
    const list = [];
    for (const c of this.outbox) {
      if (c.lazy) {
        const v = c.lazy();
        if (!v) continue;
        v.seq = c.seq;
        v.at = c.at;
        list.push(v);
      } else {
        list.push(c);
      }
    }
    this.outbox.length = 0;
    if (!list.length) return;
    const text = JSON.stringify(list.length === 1 ? list[0] : list);
    const entry = { text, first: list[0].seq, last: list[list.length - 1].seq, n: list.length };
    this._remember(entry);
    this.stats.batches++;
    this.stats.commands += list.length;
    this.stats.bytes += text.length;
    if (this.resendQueue.length || this._inFlight) {
      // a refused batch is waiting: this one goes behind it, never before
      this.resendQueue.push(entry);
      this.stats.held++;
      this._scheduleResend();
      return;
    }
    this._post(text);
  }

  _remember(entry) {
    this.recent.push(entry);
    if (this.recent.length > 32) this.recent.shift();
  }

  _scheduleResend() {
    if (this._resendTimer != null || this.closed) return;
    this._resendTimer = this.env.setTimeout(() => {
      this._resendTimer = null;
      this.frame();
    }, 20);
  }

  _post(text) {
    try {
      this.ctl.postMessage(text);
    } catch (e) {
      this.env.log.warn?.(`[engine] ctl post failed: ${e && e.message}`);
    }
  }

  /** {"ev":"reply", id, ok, ...} */
  onReply(ev) {
    const p = this.pending.get(ev.id);
    if (!p) return false;
    this.pending.delete(ev.id);
    p.resolve(ev);
    return true;
  }

  /**
   * {"ev":"error","error":"full","cmd":<first cmd name>,"ids":[...],"seq":<first seq>}
   * (engine-host.js): the whole batch was refused, nothing applied. Matched by
   * the seq of its first command; the text and the latest batch stay as fallbacks.
   */
  onFull(ev) {
    this.stats.full++;
    // (the latest message posted with that first seq: a resend joins batches under the first one's seq)
    const findLast = (pred) => {
      for (let i = this.recent.length - 1; i >= 0; i--) if (pred(this.recent[i])) return this.recent[i];
      return null;
    };
    let hit = null;
    const raw = ev && ev.cmd;
    if (ev && typeof ev.seq === 'number') hit = findLast((b) => b.first === ev.seq);
    if (!hit && typeof raw === 'string') hit = findLast((b) => b.text === raw);
    if (!hit) {
      let parsed = raw;
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
      }
      const first = Array.isArray(parsed) ? parsed[0] && parsed[0].seq : parsed && parsed.seq;
      if (first != null) hit = findLast((b) => b.first === first);
    }
    if (!hit && this.recent.length) hit = this.recent[this.recent.length - 1];
    if (!hit) return;
    const key = hit.first;
    // the resend message in flight was refused: its batches are still at the head of the queue
    const inFlightHit = !!this._inFlight && this._inFlight.first === key;
    if (!inFlightHit && this.resendQueue.some((e) => e.first === key)) return;  // queued already
    // A batch larger than the engine's command queue can never fit: after
    // MAX_FULL_RESENDS refusals (~5 s of frames) it is dropped instead of being
    // resent forever (a stall that long has made the liveness rule fall back).
    const prev = this._fullCount.get(key) || 0;
    if (prev === Infinity) return;                     // dropped already
    if (inFlightHit) this._inFlight = null;
    const n = prev + 1;
    this._fullCount.set(key, n);
    if (n > MAX_FULL_RESENDS) {
      this._fullCount.set(key, Infinity);
      this.stats.dropped++;
      const i = this.resendQueue.findIndex((e) => e.first === key);
      const dropped = i >= 0 ? this.resendQueue.splice(i, 1)[0] : hit;
      for (const req of this._requestsOf(dropped.text)) this.onReply({ ev: 'reply', id: req, ok: false, error: 'full', refused: true });
      this.env.log.warn?.(`[engine] a batch of ${dropped.last - dropped.first + 1} commands refused "full" ${MAX_FULL_RESENDS} times: dropped`);
      if (this.resendQueue.length) this._scheduleResend();
      return;
    }
    if (this._fullCount.size > 64) this._fullCount.delete(this._fullCount.keys().next().value);
    if (!inFlightHit) {
      // a batch posted directly: into the queue in seq order (held batches may already wait there)
      const at = this.resendQueue.findIndex((e) => e.first > key);
      if (at < 0) this.resendQueue.push(hit);
      else this.resendQueue.splice(at, 0, hit);
    }
    this._scheduleResend();
  }

  /** Ids of the requests inside a batch text. */
  _requestsOf(text) {
    try {
      const v = JSON.parse(text);
      return (Array.isArray(v) ? v : [v]).filter((c) => c && typeof c.id === 'number').map((c) => c.id);
    } catch { return []; }
  }

  /**
   * A message refused for another reason than "full" (invalid field, unknown
   * command): the engine applied none of it and will never reply, so its
   * requests (`ids` of the error event) resolve now with {ok:false, error}.
   */
  onRefused(ids, error) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) this.onReply({ ev: 'reply', id, ok: false, error: String(error || 'refused'), refused: true });
  }

  /**
   * Animation frame (and a 20 ms timer while batches wait): batches refused
   * with "full" are resent in their order, as one message, the held ones with
   * them; once the engine took a resend, everything still held leaves.
   */
  frame() {
    if (this.closed || (!this.resendQueue.length && !this._inFlight)) return;
    const now = typeof this.env.now === 'function' ? this.env.now() : Date.now();
    if (this._inFlight) {
      if (now - this._inFlight.postedAt < RESEND_CONFIRM_MS) {
        this._scheduleResend();
        return;
      }
      // no refusal came back: the engine applied it
      this.resendQueue.splice(0, this._inFlight.count);
      this._inFlight = null;
      const rest = this.resendQueue.reduce((a, e) => a + e.n, 0);
      if (this.resendQueue.length && rest <= RESEND_CHUNK_COMMANDS) {
        // the engine takes commands again: what is held leaves now, and new
        // batches flow directly (a refusal of it is queued again like any)
        this._postJoined(this.resendQueue.splice(0));
        return;
      }
    }
    if (!this.resendQueue.length) return;
    let k = 0;
    let n = 0;
    while (k < this.resendQueue.length && (k === 0 || n + this.resendQueue[k].n <= RESEND_CHUNK_COMMANDS)) n += this.resendQueue[k++].n;
    const first = this._postJoined(this.resendQueue.slice(0, k));
    this._inFlight = { first, count: k, postedAt: now };
    this._scheduleResend();
  }

  /** Posts batches (in seq order) as ONE message: applied all together or refused all together. */
  _postJoined(batches) {
    this.stats.resent++;
    if (batches.length === 1) {
      this._post(batches[0].text);  // unchanged
      return batches[0].first;
    }
    const entry = {
      text: `[${batches.map((b) => innerOf(b.text)).join(',')}]`,
      first: batches[0].first,
      last: batches[batches.length - 1].last,
      n: batches.reduce((a, b) => a + b.n, 0)
    };
    this._remember(entry);
    this._post(entry.text);
    return entry.first;
  }

  /** pcm port: one message, never a transfer list. */
  postPcm(msg) {
    if (this.closed || !this.pcmPort) return;
    this.pcmPort.postMessage(msg);
  }

  /** The engine is gone: every request waiting for a reply resolves with ok:false. */
  close(reason = 'engine gone') {
    if (this.closed) return;
    this.closed = true;
    this.outbox.length = 0;
    this.resendQueue.length = 0;
    this._inFlight = null;
    this._fullCount.clear();
    if (this._resendTimer != null) this.env.clearTimeout(this._resendTimer);
    for (const [, p] of this.pending) p.resolve({ ok: false, error: reason });
    this.pending.clear();
    for (const port of [this.ctl, this.pcmPort]) {
      try { port.onmessage = null; } catch { /* not settable */ }
      try { port.close(); } catch { /* already closed */ }
    }
  }
}
