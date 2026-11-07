// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §4.5):
// clock synchronisation between the renderer's performance.now() and the
// engine clock E. Each clock.ping {t0} is answered by clock.pong {t0, te};
// with t1 the arrival time, offset = te - (t0 + t1) / 2 and rtt = t1 - t0.
// The estimate is the minimum-rtt sample among the last 8 (5 pings at
// connect, then one every 2 s): a ping delayed by a busy renderer or host
// has a long rtt and is simply outvoted.

export const CLOCK_KEEP = 8;

export class ClockSync {
  constructor(keep = CLOCK_KEEP) {
    this.keep = keep;
    this.samples = [];   // { offset, rtt, at } (seconds)
    this.offset = null;  // engine time - performance time (s), null until the first pong
    this.rtt = null;     // rtt of the sample in use (s)
  }

  /** t0: perf seconds the ping was sent; te: engine seconds; t1: perf seconds it came back. */
  addSample(t0, te, t1) {
    if (!(t1 >= t0) || !Number.isFinite(te)) return false;
    this.samples.push({ offset: te - (t0 + t1) / 2, rtt: t1 - t0, at: t1 });
    if (this.samples.length > this.keep) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
    return true;
  }

  get synced() {
    return this.offset != null;
  }

  /** Engine time at perf time `perfSec` (s). Before the first pong: the perf time itself. */
  engineTime(perfSec) {
    return perfSec + (this.offset ?? 0);
  }

  /** Perf seconds at engine time `engineSec`. */
  perfTime(engineSec) {
    return engineSec - (this.offset ?? 0);
  }

  reset() {
    this.samples.length = 0;
    this.offset = null;
    this.rtt = null;
  }
}
