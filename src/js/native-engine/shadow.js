// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §7.4):
// the shadow decode trigger and its statistics. The native Media Foundation
// decoder is never used for playback until >= 99 % of tracks agree with
// Chromium's decode within 1 ms; to measure that, after a local track's
// pcm.done the proxy cuts a REFERENCE WINDOW (the middle 30 s) from the
// AudioBuffer it already holds (Chromium's timeline) and asks main to decode
// the same file natively in a short-lived process
// (window.omEngine.shadowDecode). One job at a time, at most one pending;
// one log line per track and running statistics (engine.shadowStats()).
//
// UI thread: the comparison in the child is mono ((L+R)/2, SPEC.md §7.4
// compareWindow), so the window is folded to mono once and sent as both
// channels (one buffer referenced twice: the contextBridge and IPC clones
// copy it once), and the call leaves in its own task after the cut. Measured
// end to end (e2e-proxy, 6-min track): the shadowDecode() call cost 18-21 ms
// with two channels, 8-10 ms with the mono fold, with an identical report.

export const SHADOW_WINDOW_SEC = 30;
export const SHADOW_KEY = 'nativeShadow';

const extOf = (p) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return m ? m[1].toLowerCase() : '?';
};

/**
 * The reference window of `buffer`: the middle 30 s (or the whole track),
 * folded to mono (L+R)/2 as the child compares it; `left` and `right` are the
 * same Float32Array.
 */
export function cutReferenceWindow(buffer, seconds = SHADOW_WINDOW_SEC) {
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const win = Math.min(frames, Math.round(seconds * rate));
  const windowStart = Math.max(0, Math.floor((frames - win) / 2));
  const left = new Float32Array(win);
  const right = new Float32Array(win);
  const nCh = buffer.numberOfChannels;
  if (nCh === 4 || nCh === 6) {
    // Web Audio "speakers" fold to stereo, exactly as the engine folds the
    // natively decoded file (SPEC.md §7.3): quad halves the surrounds, 5.1
    // adds centre and surrounds at 1/sqrt(2) and drops the LFE.
    const tmp = [0, 1, 2, 3, 4, 5].slice(0, nCh).map((ch) => {
      const a = new Float32Array(win);
      buffer.copyFromChannel(a, ch, windowStart);
      return a;
    });
    if (nCh === 4) {
      for (let i = 0; i < win; i++) {
        left[i] = 0.5 * (tmp[0][i] + tmp[2][i]);
        right[i] = 0.5 * (tmp[1][i] + tmp[3][i]);
      }
    } else {
      const k = Math.SQRT1_2;
      for (let i = 0; i < win; i++) {
        left[i] = tmp[0][i] + k * (tmp[2][i] + tmp[4][i]);
        right[i] = tmp[1][i] + k * (tmp[2][i] + tmp[5][i]);
      }
    }
  } else {
    buffer.copyFromChannel(left, 0, windowStart);
    buffer.copyFromChannel(right, nCh > 1 ? 1 : 0, windowStart);
  }
  for (let i = 0; i < win; i++) left[i] = 0.5 * (left[i] + right[i]);
  return { rate, frames, windowStart, left, right: left };
}

export class ShadowDecoder {
  constructor(engine) {
    this._e = engine;
    this.running = null;
    this.pending = null;
    this.skip = new Set();
    this.reports = [];
    this.count = 0;
    this.within1ms = 0;
    this.failed = 0;
    this.worst = {};                 // extension -> worst |offsetMs|
  }

  enabled() {
    const om = this._e.env.omEngine;
    return !!(om && typeof om.shadowDecode === 'function') && this._e.env.storage.get(SHADOW_KEY) !== '0';
  }

  /** A track's PCM handoff finished (pcm.done): queue its shadow decode. */
  onTrackDone(deck, stream) {
    if (!this.enabled()) return;
    const track = deck._track;
    if (!track || !track.path || this.skip.has(track.path)) return;
    if (deck._buffer !== stream.buffer || typeof stream.buffer.copyFromChannel !== 'function') return;
    const job = { path: track.path, loadId: stream.loadId, ...cutReferenceWindow(stream.buffer) };
    if (this.running) {
      this.pending = job;            // at most one pending: the newest wins
      return;
    }
    this._run(job);
  }

  _run(job) {
    this.running = job;
    // the window was cut in this task; the call (its clone) leaves in the next one
    this._e.env.setTimeout(() => this._call(job), 0);
  }

  async _call(job) {
    let r;
    try {
      r = await this._e.env.omEngine.shadowDecode(job);
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    this._report(job, r || { ok: false, error: 'no report' });
    this.running = null;
    if (this.pending && this._e.status === 'native') {
      const next = this.pending;
      this.pending = null;
      this._run(next);
    }
  }

  _report(job, r) {
    const ext = extOf(job.path);
    const name = String(job.path).replace(/^.*[\\/]/, '');
    if (!r.ok) {
      this.failed++;
      if (r.error === 'crashed') this.skip.add(job.path);
      this._e.env.log.log?.(`[engine] shadow decode ${name}: failed (${r.error || 'unknown'})`);
      return;
    }
    this.count++;
    const off = Math.abs(Number(r.offsetMs) || 0);
    if (off <= 1) this.within1ms++;
    if (!(this.worst[ext] >= off)) this.worst[ext] = off;
    this.reports.push({ path: job.path, offsetMs: r.offsetMs, lengthDiffMs: r.lengthDiffMs, rmsDiffDb: r.rmsDiffDb });
    if (this.reports.length > 200) this.reports.shift();
    const f = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '?');
    this._e.env.log.log?.(`[engine] shadow decode ${name}: offset ${f(r.offsetMs)} ms, length ${f(r.lengthDiffMs)} ms, `
      + `rms diff ${f(r.rmsDiffDb, 1)} dB, corr ${f(r.correlation, 4)} (${this.within1ms}/${this.count} within 1 ms)`);
  }

  stats() {
    return {
      count: this.count,
      within1ms: this.within1ms,
      ratio: this.count ? this.within1ms / this.count : null,
      failed: this.failed,
      worst: { ...this.worst },
      skipped: [...this.skip]
    };
  }
}
