// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §4.4, §4.5):
// the position model of one deck, which makes the 60 fps playheads exact.
//
// The engine publishes, per deck, the current SEGMENT {seg, anchorT,
// anchorPos} (a stretch where the heard position is continuous) and the
// latest (t, pos, rate): pos is the heard position at engine time t, rate the
// nominal heard rate. t and anchorT are presentTimes, i.e. 20-45 ms in the
// future when the snapshot is read, so a new segment is never extrapolated
// backwards across its start: what was shown before keeps being shown until
// engineNow() >= anchorT. The playhead then stops exactly at the stop
// position and starts exactly at the cue while the audio still plays out the
// output latency.
//
// The facade's own predictions (play, pause, seek, scratch...) use the same
// two pieces: `prev` shown until `cur.anchorT`, then `cur`. A prediction has
// seg = null, so the next engine segment is always taken as new.
//
// Every adopted snapshot replaces the model; a difference to what the playhead
// showed below 3 ms is slewed out over 100 ms, a bigger one snaps.

export const PRE_ROLL = 3600;
export const SLEW_SEC = 0.1;
export const SNAP_SEC = 0.003;

const piece = (pos, t, rate) => ({ pos, t, rate });
const evalPiece = (p, now) => p.pos + (now - p.t) * p.rate;
const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

export class TransportModel {
  constructor() {
    this.prev = null;                                        // shown while now < cur.anchorT
    this.cur = { anchorT: -Infinity, ...piece(0, 0, 0) };    // anchorT = +Infinity: hold until the engine starts
    this.seg = null;                                         // engine segment adopted; null = local prediction
    this.slewD = 0;                                          // correction at slewT0, decaying to 0 over SLEW_SEC
    this.slewT0 = 0;
  }

  /** The linear piece shown at engine time `now`. */
  shown(now) {
    return this.prev && now < this.cur.anchorT ? this.prev : this.cur;
  }

  correction(now) {
    if (!this.slewD) return 0;
    const k = 1 - (now - this.slewT0) / SLEW_SEC;
    if (k <= 0) {
      this.slewD = 0;
      return 0;
    }
    return this.slewD * Math.min(1, k);
  }

  /** Unwrapped position (track s) at engine time `now`, slew included. */
  value(now) {
    return evalPiece(this.shown(now), now) + this.correction(now);
  }

  /** Rate of the piece shown at `now` (0 while stopped or holding). */
  rate(now) {
    return this.shown(now).rate;
  }

  /** The piece shown at `now`, re-anchored at `now` with its slew folded in. */
  _shownNow(now) {
    const p = this.shown(now);
    return piece(evalPiece(p, now) + this.correction(now), now, p.rate);
  }

  // ---- predictions (facade side) ------------------------------------------

  /** Seek while stopped, load, end of track: still at `pos` from now on. */
  jumpStopped(pos, now) {
    this.prev = null;
    this.cur = { anchorT: -Infinity, ...piece(pos, now, 0) };
    this.seg = null;
    this.slewD = 0;
  }

  /** Seek while playing, scratch target: at `pos` now, moving at `rate`. */
  jumpMoving(pos, now, rate) {
    this.prev = null;
    this.cur = { anchorT: -Infinity, ...piece(pos, now, rate) };
    this.seg = null;
    this.slewD = 0;
  }

  /** Play from stop: held at `pos` until the engine's segment says when it starts. */
  holdThenMove(pos, now, rate) {
    this.prev = piece(pos, now, 0);
    this.cur = { anchorT: Infinity, ...piece(pos, now, rate) };
    this.seg = null;
    this.slewD = 0;
  }

  /** Pause: what is heard keeps moving until `stopAt` (the predicted presentTime), then stops there. */
  moveThenStop(now, stopAt) {
    const p = this._shownNow(now);
    const at = Math.max(now, stopAt);
    this.prev = p;
    this.cur = { anchorT: at, ...piece(evalPiece(p, at), at, 0) };
    this.seg = null;
    this.slewD = 0;
  }

  /** Tempo change: the position stays continuous, the rate changes. */
  setRate(now, rate) {
    if (this.prev && now < this.cur.anchorT) {
      if (this.cur.anchorT === Infinity) {
        this.cur.rate = rate;  // a start is pending: it will start at the new rate
        return;
      }
      if (this.prev.rate !== 0) {
        // moving until a pending stop: re-anchor the moving piece
        const p = this._shownNow(now);
        this.prev = piece(p.pos, now, rate);
        if (this.cur.rate === 0) {
          this.cur.pos = evalPiece(this.prev, this.cur.anchorT);
          this.cur.t = this.cur.anchorT;
        }
      }
      return;
    }
    const p = this._shownNow(now);
    if (p.rate === 0) return;  // still: nothing moves
    this.cur = { anchorT: this.cur.anchorT, ...piece(p.pos, now, rate) };
    this.prev = null;
    this.slewD = 0;
  }

  /** Re-anchor at `pos` (e.g. the wrapped position when a loop is left), same rate. */
  reanchor(now, pos) {
    const p = this.shown(now);
    this.prev = null;
    this.cur = { anchorT: -Infinity, ...piece(pos, now, p.rate) };
    this.seg = null;
    this.slewD = 0;
  }

  // ---- reconciliation (engine side) ---------------------------------------

  /**
   * Adopts a deck snapshot {seg, anchorT, anchorPos, t, pos, rate} at engine
   * time `now`. `wrap(x)` maps an unwrapped position to the shown one (loop
   * wrap and clamp), so the slew compares what the user actually sees.
   */
  adopt(s, now, wrap = (x) => x) {
    const before = wrap(this.value(now));
    const anchorT = num(s.anchorT, -Infinity);
    const fresh = piece(num(s.pos, 0), num(s.t, now), num(s.rate, 0));
    if (this.seg !== null && this.seg === s.seg) {
      // same segment: a fresher linear model; the anchor and `prev` stay
      this.cur = { anchorT, ...fresh };
    } else {
      // a new segment: what was shown keeps being shown until its anchor
      this.prev = now < anchorT ? this._shownNow(now) : null;
      this.cur = { anchorT, ...fresh };
      this.seg = s.seg;
    }
    this.slewD = 0;
    const after = wrap(this.value(now));
    const diff = before - after;
    if (diff !== 0 && Math.abs(diff) < SNAP_SEC) {
      this.slewD = diff;
      this.slewT0 = now;
    }
    return diff;
  }
}
