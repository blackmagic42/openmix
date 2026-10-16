// Beat-grid math shared by the decks (ROLL slices) and the sync engine: exact
// ports of the grid helpers of src/js/engine.js (gridIndexFracAt,
// gridTimeAtIndex, gridPeriodAt, barAlignedSeekTime) and of the private
// AudioEngine helpers _beatPhase, _barPhase, _period, _localPeriod.
//
// FROZEN FOUNDATION (maintainer: host). Header-only, allocation-free,
// real-time safe. "No value" (JavaScript null) is returned as NaN.
#pragma once

#include <cmath>

#include "om/media.h"

namespace om {
namespace grid {

// Fractional beat index at track time t on the DYNAMIC grid (NaN without one).
inline double indexFracAt(const BeatGrid& g, double t, double globalOffset) noexcept {
  const std::vector<double>& b = g.beats;
  const size_t n = b.size();
  if (n < 2) return kNaN;
  const double tt = t - g.gridShift - globalOffset;
  if (tt <= b[0]) return (tt - b[0]) / (b[1] - b[0]);
  if (tt >= b[n - 1]) return static_cast<double>(n - 1) + (tt - b[n - 1]) / (b[n - 1] - b[n - 2]);
  size_t lo = 0;
  size_t hi = n - 1;
  while (hi - lo > 1) {
    const size_t mid = (lo + hi) >> 1;
    if (b[mid] <= tt) lo = mid;
    else hi = mid;
  }
  return static_cast<double>(lo) + (tt - b[lo]) / (b[hi] - b[lo]);
}

// Track time of the fractional beat index f on the DYNAMIC grid (NaN without one).
inline double timeAtIndex(const BeatGrid& g, double f, double globalOffset) noexcept {
  const std::vector<double>& b = g.beats;
  const size_t n = b.size();
  if (n < 2) return kNaN;
  const double s = g.gridShift + globalOffset;
  if (f <= 0) return b[0] + f * (b[1] - b[0]) + s;
  if (f >= static_cast<double>(n - 1)) return b[n - 1] + (f - static_cast<double>(n - 1)) * (b[n - 1] - b[n - 2]) + s;
  const size_t k = static_cast<size_t>(std::floor(f));
  return b[k] + (f - static_cast<double>(k)) * (b[k + 1] - b[k]) + s;
}

// Duration of the beat containing t (dynamic grid), else 60 / bpm, else NaN.
inline double periodAt(const BeatGrid& g, double t, double globalOffset) noexcept {
  const std::vector<double>& b = g.beats;
  if (b.size() < 2) return g.bpm > 0 ? 60.0 / g.bpm : kNaN;
  const double f = indexFracAt(g, t, globalOffset);
  double k = std::floor(f);
  if (k < 0) k = 0;
  const double maxK = static_cast<double>(b.size() - 2);
  if (k > maxK) k = maxK;
  const size_t ki = static_cast<size_t>(k);
  return b[ki + 1] - b[ki];
}

// "Bar-intact" jump target (engine.js barAlignedSeekTime): land in the bar
// containing toTime at the same relative position fromTime had in its bar.
inline double barAlignedSeekTime(const BeatGrid& g, double fromTime, double toTime, double globalOffset) noexcept {
  if (!(g.bpm > 0)) return toTime;
  if (g.hasDynamic()) {
    const double fFrom = indexFracAt(g, fromTime, globalOffset);
    const double fTo = indexFracAt(g, toTime, globalOffset);
    if (!isSet(fFrom) || !isSet(fTo)) return toTime;
    const double anchor = g.barAnchor;
    const double relFrom = (fFrom - anchor) / 4.0;
    const double relTo = (fTo - anchor) / 4.0;
    const double phase = relFrom - std::floor(relFrom);
    const double targetBar = std::floor(relTo);
    return timeAtIndex(g, anchor + (targetBar + phase) * 4.0, globalOffset);
  }
  if (!isSet(g.beatOffset)) return toTime;
  const double barLen = (4.0 * 60.0) / g.bpm;
  const double barFrom = (fromTime - g.beatOffset) / barLen;
  const double barTo = (toTime - g.beatOffset) / barLen;
  const double phase = barFrom - std::floor(barFrom);
  const double targetBar = std::floor(barTo);
  return g.beatOffset + (targetBar + phase) * barLen;
}

// engine.js _beatPhase: phase 0..1 inside the current beat (NaN without a grid).
inline double beatPhase(const BeatGrid& g, double t, double globalOffset) noexcept {
  if (g.hasDynamic()) {
    const double f = indexFracAt(g, t, globalOffset);
    return f - std::floor(f);
  }
  if (!(g.bpm > 0) || !isSet(g.beatOffset)) return kNaN;
  const double b = (t - g.beatOffset) / (60.0 / g.bpm);
  return b - std::floor(b);
}

// engine.js _barPhase: phase 0..1 inside the current bar of 4 beats (NaN without a grid).
inline double barPhase(const BeatGrid& g, double t, double globalOffset) noexcept {
  if (g.hasDynamic()) {
    const double f = (indexFracAt(g, t, globalOffset) - g.barAnchor) / 4.0;
    return f - std::floor(f);
  }
  if (!(g.bpm > 0) || !isSet(g.beatOffset)) return kNaN;
  const double b = (t - g.beatOffset) / (4.0 * 60.0 / g.bpm);
  return b - std::floor(b);
}

// engine.js _period: local beat duration in track seconds (NaN without BPM).
inline double period(const BeatGrid& g, double t, double globalOffset) noexcept {
  const double p = periodAt(g, t, globalOffset);
  if (isSet(p) && p != 0.0) return p;
  return g.bpm > 0 ? 60.0 / g.bpm : kNaN;
}

// engine.js _localPeriod: AVERAGE beat period over +-8 beats of the dynamic
// grid around t (more accurate than the rounded BPM), else 60 / bpm.
inline double localPeriod(const BeatGrid& g, double t, double globalOffset) noexcept {
  const std::vector<double>& beats = g.beats;
  if (beats.size() > 4) {
    const double f = indexFracAt(g, t, globalOffset);
    const double n = static_cast<double>(beats.size() - 1);
    const double fl = std::floor(f);
    double a = fl - 8;
    if (a > n - 1) a = n - 1;
    if (a < 0) a = 0;
    double b = fl + 8;
    if (b > n) b = n;
    if (b < a + 1) b = a + 1;
    const size_t ai = static_cast<size_t>(a);
    const size_t bi = static_cast<size_t>(b);
    const double p = (beats[bi] - beats[ai]) / (b - a);
    if (p > 0.15 && p < 2) return p;
  }
  return g.bpm > 0 ? 60.0 / g.bpm : kNaN;
}

// Fractional beat index at t on whichever grid exists (dynamic first, then
// fixed: (t - beatOffset) * bpm / 60), relative to beat 0. NaN without a grid.
// Used by the beat clocks and nextBoundaryAt.
inline double beatIndexAt(const BeatGrid& g, double t, double globalOffset) noexcept {
  if (g.hasDynamic()) return indexFracAt(g, t, globalOffset);
  if (g.bpm > 0 && isSet(g.beatOffset)) return (t - g.beatOffset) * g.bpm / 60.0;
  return kNaN;
}

}  // namespace grid
}  // namespace om
