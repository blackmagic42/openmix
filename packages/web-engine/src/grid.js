// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// --- Dynamic grid: helpers (position <-> beat index) ---
// grid.beats = actual position of each beat; grid.gridShift = per-deck
// manual offset; grid.barAnchor = index of the beat that starts a bar.
// grid.globalGridOffset = engine-wide offset (adjustable in ms): shifts
// every line of every track at once, to suit your ear/screen.
// web-engine: the global offset is read from the grid object (a Deck exposes
// engine.gridOffset as deck.globalGridOffset) instead of a module global.
//
// Fixed-grid code paths (bpm + beatOffset, no beat list) ignore both shifts,
// exactly as in OpenMix.

const shiftOf = (grid) => (grid.gridShift || 0) + (grid.globalGridOffset || 0);
const hasBeatList = (grid) => !!grid && Array.isArray(grid.beats) && grid.beats.length >= 2;

/**
 * Fractional beat index at a file time, on a beat-list grid.
 * Interpolates between real beats and extrapolates with the edge periods.
 * @param {object} grid GridLike (needs a beat list of at least 2 beats)
 * @param {number} time file seconds
 * @returns {number | null}
 */
export function gridIndexFracAt(grid, time) {
  if (!hasBeatList(grid) || typeof time !== 'number') return null;
  const b = grid.beats;
  const tt = time - shiftOf(grid);
  const n = b.length;
  if (tt <= b[0]) return (tt - b[0]) / (b[1] - b[0]);
  if (tt >= b[n - 1]) return (n - 1) + (tt - b[n - 1]) / (b[n - 1] - b[n - 2]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b[mid] <= tt) lo = mid;
    else hi = mid;
  }
  return lo + (tt - b[lo]) / (b[hi] - b[lo]);
}

/**
 * File time of a fractional beat index (inverse of gridIndexFracAt);
 * extrapolates at both ends.
 * @param {object} grid GridLike (needs a beat list of at least 2 beats)
 * @param {number} index fractional beat index
 * @returns {number | null}
 */
export function gridTimeAtIndex(grid, index) {
  if (!hasBeatList(grid) || typeof index !== 'number') return null;
  const b = grid.beats;
  const f = index;
  const s = shiftOf(grid);
  const n = b.length;
  if (f <= 0) return b[0] + f * (b[1] - b[0]) + s;
  if (f >= n - 1) return b[n - 1] + (f - (n - 1)) * (b[n - 1] - b[n - 2]) + s;
  const k = Math.floor(f);
  return b[k] + (f - k) * (b[k + 1] - b[k]) + s;
}

/**
 * Local beat period (seconds) at a file time, on a beat-list grid.
 * @param {object} grid GridLike (needs a beat list of at least 2 beats)
 * @param {number} time file seconds
 * @returns {number | null}
 */
export function gridPeriodAt(grid, time) {
  // web-engine: null without a beat list (DESIGN §5.10); OpenMix returned
  // 60 / bpm here, and the engine still falls back to it itself (_period).
  if (!hasBeatList(grid)) return null;
  const b = grid.beats;
  const f = gridIndexFracAt(grid, time);
  if (f == null) return null;
  const k = Math.max(0, Math.min(b.length - 2, Math.floor(f)));
  return b[k + 1] - b[k];
}

// "Bar-intact" jump: instead of jumping exactly where you clicked, you land
// in the SAME bar (the one targeted by the click) but at the same RELATIVE
// position you were at before jumping (e.g. you were 1/4 into bar
// 4 -> you land 1/4 into bar 74, not exactly on the clicked pixel).
// Without a known beat grid (no BPM detected), nothing can be
// aligned: the target is returned as is.
/**
 * Target time in the bar of `toTime`, at the bar phase of `fromTime`.
 * @param {object} grid GridLike
 * @param {number} fromTime file seconds before the jump
 * @param {number} toTime requested file seconds
 * @returns {number}
 */
export function barAlignedSeekTime(grid, fromTime, toTime) {
  if (!grid || !grid.bpm) return toTime;
  if (hasBeatList(grid)) {
    const fFrom = gridIndexFracAt(grid, fromTime);
    const fTo = gridIndexFracAt(grid, toTime);
    if (fFrom == null || fTo == null) return toTime;
    const anchor = grid.barAnchor || 0;
    const relFrom = (fFrom - anchor) / 4;
    const relTo = (fTo - anchor) / 4;
    const phase = relFrom - Math.floor(relFrom);
    const targetBar = Math.floor(relTo);
    return gridTimeAtIndex(grid, anchor + (targetBar + phase) * 4);
  }
  if (grid.beatOffset == null) return toTime;
  const barLen = (4 * 60) / grid.bpm;
  const barFrom = (fromTime - grid.beatOffset) / barLen;
  const barTo = (toTime - grid.beatOffset) / barLen;
  const phase = barFrom - Math.floor(barFrom);
  const targetBar = Math.floor(barTo);
  return grid.beatOffset + (targetBar + phase) * barLen;
}

// Snaps a time to the nearest beat of the grid (dynamic or fixed)
// (moved from the OpenMix app; `division` generalizes the quarter-beat
// snapping of the loop pads: 4 = nearest ¼ beat)
/**
 * Nearest 1/division beat on the grid (never below 0); `time` unchanged without a grid.
 * @param {object} grid GridLike
 * @param {number} time file seconds
 * @param {number} [division=1] 1 = whole beats, 4 = quarter beats
 * @returns {number}
 */
export function snapToBeat(grid, time, division = 1) {
  if (!grid || typeof time !== 'number' || Number.isNaN(time)) return time;
  const div = typeof division === 'number' && division > 0 ? division : 1;
  if (hasBeatList(grid)) {
    const f = gridIndexFracAt(grid, time);
    const s = f == null ? null : gridTimeAtIndex(grid, Math.round(f * div) / div);
    if (s != null) return Math.max(0, s);
  } else if (grid.bpm && grid.beatOffset != null) {
    const p = 60 / grid.bpm / div;
    return Math.max(0, grid.beatOffset + Math.round((time - grid.beatOffset) / p) * p);
  }
  return time;
}
