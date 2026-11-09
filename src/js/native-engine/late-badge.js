// OpenMix: the discreet "late" badge of a VST3 insert (owner decision of 2026-11-09,
// native/engine/SPEC.md §13.2, §17.9). A plugin that misses its deadline plays its
// latency-aligned dry for that block and is NEVER disabled or bypassed for being
// slow; the channel's VST button only shows a small badge while blocks keep
// coming late. Pure logic (no DOM, no timer), shared by both engines: the input
// is the insert's late-block counter, polled by app.js —
//   native engine: NativeVstHost.underruns(i) = the snapshot's decks[i].insert.late
//   Web engine:    vst.js VstHost.underruns(i) = the worklet's underrun counter
// Debounced so it never flickers: shown once the counter rose in at least
// LATE_MIN_RISES polls within LATE_SHOW_WINDOW_MS (a single hiccup, e.g. while a
// plugin loads, shows nothing), hidden after LATE_HIDE_AFTER_MS without a new
// late block. A new plugin (no slot, or a counter that went back down) restarts
// from a fresh baseline.

export const LATE_MIN_RISES = 2;
export const LATE_SHOW_WINDOW_MS = 2000;
export const LATE_HIDE_AFTER_MS = 3000;

export class LateBadge {
  constructor({ minRises = LATE_MIN_RISES, showWindowMs = LATE_SHOW_WINDOW_MS, hideAfterMs = LATE_HIDE_AFTER_MS } = {}) {
    this.minRises = minRises;
    this.showWindowMs = showWindowMs;
    this.hideAfterMs = hideAfterMs;
    this.reset();
  }

  /** No plugin, or a new one: hidden, no baseline. */
  reset() {
    this.visible = false;
    this._last = null;      // last counter value seen (the baseline)
    this._rises = [];       // times (ms) of the polls that saw the counter rise, within the show window
    this._lastRiseAt = -Infinity;
  }

  /**
   * One poll. now: ms (performance.now()); count: the late-block counter
   * (monotonic while the same plugin stays loaded); loaded: a plugin sits on
   * the slot. Returns whether the badge is shown.
   */
  update(now, count, loaded) {
    if (!loaded || typeof count !== 'number' || !Number.isFinite(count)) {
      this.reset();
      return false;
    }
    if (this._last === null || count < this._last) {
      // first reading of this plugin, or a new instance (its counter restarted)
      this.reset();
      this._last = count;
      return false;
    }
    if (count > this._last) {
      this._last = count;
      this._rises.push(now);
      this._lastRiseAt = now;
    }
    this._rises = this._rises.filter((t) => now - t <= this.showWindowMs);
    if (!this.visible) {
      if (this._rises.length >= this.minRises) this.visible = true;
    } else if (now - this._lastRiseAt >= this.hideAfterMs) {
      this.visible = false;
      this._rises = [];
    }
    return this.visible;
  }
}
