// Immutable media objects shared between threads: decoded audio (TrackBuffer,
// StemSet) and beat grids (BeatGrid).
//
// FROZEN FOUNDATION (maintainer: host). Ownership rule (SPEC.md §3.4): these
// objects are created on a worker/control thread, never modified once handed
// to the audio thread (which only holds raw const pointers), and destroyed on
// the control thread after the audio thread has returned them through the
// "retired" queue.
#pragma once

#include <cstdint>
#include <memory>
#include <new>
#include <vector>

#include "om/common.h"

namespace om {

// Decoded audio, int16 interleaved stereo (L, R, L, R...): half the memory of
// the float32 AudioBuffers of the Web engine (11.5 MB per minute at 48 kHz).
struct TrackBuffer {
  int sampleRate = 0;                // usually the device rate at decode time
  int64_t frames = 0;
  float gain = 1.0f;                 // playback gain undoing the headroom scaling applied at quantization
  std::unique_ptr<int16_t[]> data;   // frames * 2 samples

  static constexpr float kInvScale = 1.0f / 32768.0f;

  // Allocates a zeroed buffer (not real-time safe). Returns nullptr when out of memory.
  static std::unique_ptr<TrackBuffer> allocate(int sampleRate, int64_t frames) {
    std::unique_ptr<TrackBuffer> tb(new (std::nothrow) TrackBuffer());
    if (!tb) return nullptr;
    tb->sampleRate = sampleRate;
    tb->frames = frames > 0 ? frames : 0;
    if (tb->frames) {
      tb->data.reset(new (std::nothrow) int16_t[static_cast<size_t>(tb->frames) * 2]());
      if (!tb->data) return nullptr;
    }
    return tb;
  }

  double duration() const noexcept { return sampleRate > 0 ? static_cast<double>(frames) / sampleRate : 0.0; }
  size_t bytes() const noexcept { return static_cast<size_t>(frames) * 2 * sizeof(int16_t); }

  // Bounds-checked float reads (0 outside the buffer: pre-roll and past the end are silent).
  float left(int64_t i) const noexcept {
    return (i >= 0 && i < frames) ? data[static_cast<size_t>(i) * 2] * (gain * kInvScale) : 0.0f;
  }
  float right(int64_t i) const noexcept {
    return (i >= 0 && i < frames) ? data[static_cast<size_t>(i) * 2 + 1] * (gain * kInvScale) : 0.0f;
  }
};

// Separated stems of one track (engine.js Deck.stems). The "bass" slot holds
// bass + other merged (app.js merges them: INST = bass + melodies); "other"
// is normally empty. Gains per stem are deck state, not part of this object.
struct StemSet {
  std::unique_ptr<TrackBuffer> stems[kNumStems];
  double alignLagSec = 0.0;  // shift applied to line the stems up with the track (alignStems port)
};

// Beat grid of a track (engine.js Deck.bpm / beatOffset / beats / gridShift /
// barAnchor). Built on the control thread from deck.load / deck.grid.
struct BeatGrid {
  double bpm = 0.0;              // 0 = unknown BPM
  double beatOffset = kNaN;      // first beat of the FIXED grid (fallback); NaN = none
  std::vector<double> beats;     // DYNAMIC grid: position (s) of every beat; empty = none
  double gridShift = 0.0;        // manual offset of the dynamic grid (s)
  int barAnchor = 0;             // index of the beat that starts a bar

  bool hasDynamic() const noexcept { return beats.size() >= 2; }
  bool hasFixed() const noexcept { return bpm > 0 && isSet(beatOffset); }
  // engine.js: "a known beat grid" = BPM plus a dynamic grid or a beat offset
  bool hasGrid() const noexcept { return bpm > 0 && (hasDynamic() || isSet(beatOffset)); }
};

}  // namespace om
