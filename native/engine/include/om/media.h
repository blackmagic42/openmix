// Immutable media objects shared between threads: PCM handed off by the
// renderer (TrackBuffer: tracks, stems, sampler sounds), stem sets
// (StemSet) and beat grids (BeatGrid).
//
// FROZEN FOUNDATION (maintainer: host). Ownership rule (SPEC.md §3.2):
//  - a TrackBuffer is allocated by the PCM store (decoder module) at
//    "pcm.begin", filled chunk by chunk by om_pcm_write() on a non-real-time
//    thread, and may be attached to a deck BEFORE it is complete: each chunk
//    is published with a release store, readers check chunkReady() (acquire)
//    and play silence where data has not arrived yet;
//  - samples and chunk scales are never modified once their chunk is
//    published;
//  - the audio thread only holds raw const pointers; detached objects come
//    back through the core's "retired" queue and are released on the control
//    thread (shared_ptr owners: the PCM store); memory is freed only by the
//    control thread (PcmStore::freePending()).
// BeatGrid and StemSet are built complete on the control side, attached by
// pointer, and retired the same way.
#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <new>
#include <vector>

#include "om/common.h"

namespace om {

enum class PcmFormat : uint8_t { S16 = 1, F32 = 2 };
enum class PcmKind : uint8_t { Track = 0, Stem = 1, Sample = 2 };
inline const char* pcmFormatName(PcmFormat f) noexcept { return f == PcmFormat::F32 ? "f32" : "s16"; }
inline const char* pcmKindName(PcmKind k) noexcept {
  return k == PcmKind::Stem ? "stem" : (k == PcmKind::Sample ? "sample" : "track");
}

// Decoded audio as decoded by Chromium in the renderer (same timeline),
// stored interleaved stereo (L, R, L, R...):
//  - S16: int16 with a scale PER CHUNK: sample = s16 * chunkScale[chunk],
//    chunkScale = headroom / 32767 where headroom = the track's max(1, peak)
//    when the renderer gave it (every chunk then has the same scale), else
//    max(1, that chunk's peak) (stems, samples, multichannel sources);
//  - F32: float32 as decoded (hi-res sources); chunk scales unused.
// The sample rate is the rate the renderer decoded at (normally the device
// rate at load time); decks read any rate with the ratio rate / deviceRate.
struct TrackBuffer {
  static constexpr int kChunkShift = 16;
  static constexpr int64_t kChunkFrames = int64_t(1) << kChunkShift;  // 65536 frames per handoff chunk

  uint32_t loadId = 0;
  uint64_t storeKey = 0;    // PCM store key: (epoch << 32) | loadId (release() uses it)
  PcmKind kind = PcmKind::Track;
  PcmFormat format = PcmFormat::S16;
  int sampleRate = 0;
  int64_t frames = 0;
  float headroom = 0.0f;    // given per-track headroom (>= 1), 0 = per-chunk headroom
  float peak = 0.0f;        // source peak given by the renderer (diagnostics)
  std::unique_ptr<int16_t[]> s16;  // frames * 2 (S16)
  std::unique_ptr<float[]> f32;    // frames * 2 (F32)
  int64_t numChunks = 0;
  std::unique_ptr<float[]> chunkScale;            // per chunk (S16): sample = s16 * chunkScale[c]
  std::unique_ptr<std::atomic<uint8_t>[]> ready;  // per chunk: 1 once its samples are written
  std::atomic<int64_t> readyChunks{0};

  TrackBuffer() = default;
  TrackBuffer(const TrackBuffer&) = delete;
  TrackBuffer& operator=(const TrackBuffer&) = delete;

  // Allocates the storage (samples not zeroed: unpublished chunks are never
  // read). Not real-time safe. Returns nullptr when out of memory or invalid.
  // headroom: >= 1 = per-track headroom, 0 = per-chunk headroom (S16).
  static std::unique_ptr<TrackBuffer> allocate(uint32_t loadId, PcmKind kind, PcmFormat format, int sampleRate,
                                               int64_t frames, float headroom) {
    if (sampleRate <= 0 || frames < 0) return nullptr;
    std::unique_ptr<TrackBuffer> tb(new (std::nothrow) TrackBuffer());
    if (!tb) return nullptr;
    tb->loadId = loadId;
    tb->storeKey = loadId;
    tb->kind = kind;
    tb->format = format;
    tb->sampleRate = sampleRate;
    tb->frames = frames;
    tb->headroom = headroom >= 1.0f ? headroom : 0.0f;
    const size_t samples = static_cast<size_t>(frames) * 2;
    if (samples) {
      if (format == PcmFormat::S16) {
        tb->s16.reset(new (std::nothrow) int16_t[samples]);
        if (!tb->s16) return nullptr;
      } else {
        tb->f32.reset(new (std::nothrow) float[samples]);
        if (!tb->f32) return nullptr;
      }
    }
    tb->numChunks = (frames + kChunkFrames - 1) >> kChunkShift;
    if (tb->numChunks) {
      const size_t n = static_cast<size_t>(tb->numChunks);
      tb->ready.reset(new (std::nothrow) std::atomic<uint8_t>[n]);
      tb->chunkScale.reset(new (std::nothrow) float[n]);
      if (!tb->ready || !tb->chunkScale) return nullptr;
      const float defScale = (tb->headroom >= 1.0f ? tb->headroom : 1.0f) / 32767.0f;
      for (size_t c = 0; c < n; c++) {
        tb->ready[c].store(0, std::memory_order_relaxed);
        tb->chunkScale[c] = defScale;
      }
    }
    return tb;
  }

  double duration() const noexcept { return sampleRate > 0 ? static_cast<double>(frames) / sampleRate : 0.0; }
  size_t bytes() const noexcept {
    return static_cast<size_t>(frames) * 2 * (format == PcmFormat::S16 ? sizeof(int16_t) : sizeof(float));
  }
  int64_t chunkOf(int64_t frame) const noexcept { return frame >> kChunkShift; }
  // Frames of chunk c (the last one may be shorter), 0 when out of range.
  int64_t chunkFramesOf(int64_t c) const noexcept {
    if (c < 0 || c >= numChunks) return 0;
    const int64_t start = c << kChunkShift;
    return (frames - start) < kChunkFrames ? (frames - start) : kChunkFrames;
  }
  bool chunkReady(int64_t chunk) const noexcept {
    return chunk >= 0 && chunk < numChunks && ready[chunk].load(std::memory_order_acquire) != 0;
  }
  bool frameReady(int64_t i) const noexcept { return i >= 0 && i < frames && chunkReady(i >> kChunkShift); }
  bool complete() const noexcept { return readyChunks.load(std::memory_order_acquire) == numChunks; }
  float readyRatio() const noexcept {
    return numChunks ? static_cast<float>(readyChunks.load(std::memory_order_relaxed)) / numChunks : 1.0f;
  }

  // Frame i as float. No checks: the caller has verified frameReady(i)
  // (decks check readiness once per chunk crossed, not per sample).
  void frame(int64_t i, float& l, float& r) const noexcept {
    const size_t k = static_cast<size_t>(i) * 2;
    if (format == PcmFormat::S16) {
      const float s = chunkScale[i >> kChunkShift];
      l = s16[k] * s;
      r = s16[k + 1] * s;
    } else {
      l = f32[k];
      r = f32[k + 1];
    }
  }
  // Frame i as float, silence outside the buffer or in a chunk not received yet.
  void frameChecked(int64_t i, float& l, float& r) const noexcept {
    if (frameReady(i)) {
      frame(i, l, r);
    } else {
      l = 0.0f;
      r = 0.0f;
    }
  }

  // ---- writer side (one non-real-time thread per buffer, serialized by the PCM store) ----
  // Storage of chunk c (interleaved stereo) for the writer to fill before
  // publishChunk(); nullptr when out of range or of the other format.
  int16_t* s16Chunk(int64_t c) noexcept {
    return (format == PcmFormat::S16 && c >= 0 && c < numChunks) ? s16.get() + (c << kChunkShift) * 2 : nullptr;
  }
  float* f32Chunk(int64_t c) noexcept {
    return (format == PcmFormat::F32 && c >= 0 && c < numChunks) ? f32.get() + (c << kChunkShift) * 2 : nullptr;
  }
  // Publishes chunk c with its scale (S16; ignored for F32). Returns false
  // when it was already published (a chunk is never rewritten).
  bool publishChunk(int64_t c, float scale) noexcept {
    if (c < 0 || c >= numChunks || ready[c].load(std::memory_order_relaxed)) return false;
    chunkScale[c] = scale;
    ready[c].store(1, std::memory_order_release);
    readyChunks.fetch_add(1, std::memory_order_acq_rel);
    return true;
  }
  // Raw write of one whole chunk of interleaved samples ALREADY in this
  // buffer's format (tests, tools): copies, then publishes with `scale`.
  // Returns false when the offset/size do not describe exactly one chunk.
  bool writeChunkRaw(int64_t offsetFrames, const void* data, size_t bytes, float scale) noexcept {
    if (offsetFrames < 0 || offsetFrames >= frames || (offsetFrames & (kChunkFrames - 1)) != 0 || !data) return false;
    const int64_t c = offsetFrames >> kChunkShift;
    const size_t bytesPerFrame = 2 * (format == PcmFormat::S16 ? sizeof(int16_t) : sizeof(float));
    if (bytes != static_cast<size_t>(chunkFramesOf(c)) * bytesPerFrame) return false;
    if (ready[c].load(std::memory_order_relaxed)) return false;
    void* dst = format == PcmFormat::S16 ? static_cast<void*>(s16Chunk(c)) : static_cast<void*>(f32Chunk(c));
    std::memcpy(dst, data, bytes);
    return publishChunk(c, scale);
  }
};

// Separated stems of one track (engine.js Deck.stems). The "bass" slot holds
// bass + other merged (app.js merges them: INST = bass + melodies); "other"
// is normally null. The renderer aligned them to the track (app.js
// alignStems) before the handoff. Gains per stem are deck state.
struct StemSet {
  const TrackBuffer* stems[kNumStems] = {nullptr, nullptr, nullptr, nullptr};  // owned by the PCM store
  std::shared_ptr<const TrackBuffer> keep[kNumStems];  // keeps them alive while this set exists
};

// Beat grid of a track (engine.js Deck.bpm / beatOffset / beats / gridShift /
// barAnchor). Built on the control side from deck.load / deck.grid.
struct BeatGrid {
  double bpm = 0.0;              // 0 = unknown BPM (engine.js null)
  double beatOffset = kNaN;      // first beat of the FIXED grid (fallback); NaN = null
  std::vector<double> beats;     // DYNAMIC grid: position (s) of every beat; empty = null
  double gridShift = 0.0;        // manual offset of the dynamic grid (s)
  int barAnchor = 0;             // index of the beat that starts a bar

  bool hasDynamic() const noexcept { return beats.size() >= 2; }
  bool hasFixed() const noexcept { return bpm > 0 && isSet(beatOffset); }
  // engine.js: "a known beat grid" = BPM plus a dynamic grid or a beat offset
  bool hasGrid() const noexcept { return bpm > 0 && (hasDynamic() || isSet(beatOffset)); }
};

}  // namespace om
