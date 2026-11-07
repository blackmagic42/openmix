// Helpers of the deck module tests (owner: deck): synthetic TrackBuffers
// (float32 or int16 with per-chunk scales, chunks published or not), a
// virtual device clock that renders a Deck in blocks of any size pattern,
// golden-file loading (SPEC.md §18.4) and small signal measurements.
// Test code: allocates freely outside rt::Scope.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/deck.h"
#include "om/json.h"
#include "om/media.h"
#include "om/rt.h"

namespace decktest {

using namespace om;

// Deterministic music-like stereo test signal (kicks, tones, noise).
inline void makeSignal(std::vector<float>& L, std::vector<float>& R, int64_t frames, double rate, uint32_t seed) {
  L.resize(static_cast<size_t>(frames));
  R.resize(static_cast<size_t>(frames));
  uint32_t x = seed ? seed : 0x9E3779B9u;
  auto rnd = [&x]() {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x / 4294967296.0;
  };
  for (int64_t i = 0; i < frames; i++) {
    const double t = i / rate;
    const double b = std::fmod(t, 0.5);
    const double kick = std::exp(-b * 18) * std::sin(2 * kPi * (50 + 80 * std::exp(-b * 30)) * b) * 0.45;
    L[static_cast<size_t>(i)] = static_cast<float>(kick + 0.12 * std::sin(2 * kPi * 220 * t) +
                                                   0.05 * std::sin(2 * kPi * 1234.5 * t) + (rnd() * 2 - 1) * 0.03);
    R[static_cast<size_t>(i)] = static_cast<float>(kick * 0.9 + 0.1 * std::sin(2 * kPi * 277.2 * t + 1) +
                                                   0.06 * std::sin(2 * kPi * 2345.6 * t) + (rnd() * 2 - 1) * 0.03);
  }
}

// A TrackBuffer from planar float data. S16: int16 with per-chunk scales
// (headrooms cycle through `headrooms`); the float data must already be
// int16 x scale exact when exactS16 is set (golden inputs), else it is quantized.
inline std::unique_ptr<TrackBuffer> makeTrack(const std::vector<float>& L, const std::vector<float>& R, int rate,
                                              PcmFormat fmt, const std::vector<float>& scales = {},
                                              bool publishAll = true, uint32_t loadId = 1) {
  const int64_t frames = static_cast<int64_t>(L.size());
  auto tb = TrackBuffer::allocate(loadId, PcmKind::Track, fmt, rate, frames, 0.0f);
  for (int64_t c = 0; c < tb->numChunks; c++) {
    const int64_t a = c << TrackBuffer::kChunkShift;
    const int64_t n = tb->chunkFramesOf(c);
    float scale = 1.0f;
    if (fmt == PcmFormat::S16) {
      scale = scales.empty() ? 1.0f / 32767.0f : scales[static_cast<size_t>(c) % scales.size()];
      int16_t* d = tb->s16Chunk(c);
      for (int64_t i = 0; i < n; i++) {
        for (int ch = 0; ch < 2; ch++) {
          const float v = (ch == 0 ? L : R)[static_cast<size_t>(a + i)];
          double s = std::nearbyint(v / scale);
          s = std::max(-32768.0, std::min(32767.0, s));
          d[2 * i + ch] = static_cast<int16_t>(s);
        }
      }
    } else {
      float* d = tb->f32Chunk(c);
      for (int64_t i = 0; i < n; i++) {
        d[2 * i] = L[static_cast<size_t>(a + i)];
        d[2 * i + 1] = R[static_cast<size_t>(a + i)];
      }
    }
    if (publishAll) tb->publishChunk(c, scale);
  }
  return tb;
}

// Publishes chunk c of a buffer made with publishAll = false.
inline void publish(TrackBuffer& tb, int64_t c, float scale = 1.0f / 32767.0f) {
  tb.publishChunk(c, tb.format == PcmFormat::S16 ? scale : 1.0f);
}

inline std::unique_ptr<TrackBuffer> sineTrack(double seconds, int rate = 48000, double hz = 440.0, double amp = 0.5,
                                              PcmFormat fmt = PcmFormat::F32) {
  const int64_t frames = static_cast<int64_t>(seconds * rate);
  std::vector<float> L(static_cast<size_t>(frames)), R(static_cast<size_t>(frames));
  for (int64_t i = 0; i < frames; i++) {
    L[static_cast<size_t>(i)] = R[static_cast<size_t>(i)] = static_cast<float>(amp * std::sin(2 * kPi * hz * i / rate));
  }
  return makeTrack(L, R, rate, fmt);
}

inline std::unique_ptr<TrackBuffer> musicTrack(double seconds, int rate = 48000, PcmFormat fmt = PcmFormat::F32,
                                               uint32_t seed = 99) {
  std::vector<float> L, R;
  makeSignal(L, R, static_cast<int64_t>(seconds * rate), rate, seed);
  return makeTrack(L, R, rate, fmt, {1.0f / 32767.0f, 1.3f / 32767.0f});
}

// Frame i of a TrackBuffer as float (0 outside).
inline float trackL(const TrackBuffer& tb, int64_t i) {
  float l, r;
  tb.frameChecked(i, l, r);
  return l;
}
inline float trackR(const TrackBuffer& tb, int64_t i) {
  float l, r;
  tb.frameChecked(i, l, r);
  return r;
}

// Virtual device: renders a deck in blocks, keeps the sample clock and the
// engine clock (presentTime = callbackTime + latency).
struct Rig {
  double rate = 48000;
  double latency = 0.02;    // presentTime - callbackTime
  double epoch = 100.0;     // engine time of frame 0 (callback)
  int64_t frame = 0;
  std::vector<float> outL, outR;  // everything rendered so far
  bool rtCheck = true;

  BlockClock clock(int frames) const {
    BlockClock c;
    c.frame = frame;
    c.frames = frames;
    c.sampleRate = rate;
    c.callbackTime = epoch + frame / rate;
    c.presentTime = c.callbackTime + latency;
    c.sampleTime = frame / rate;
    return c;
  }
  BlockClock now() const { return clock(128); }
  EngineTime presentAt(int64_t f) const { return epoch + f / rate + latency; }
  // Renders `frames` frames in blocks of `block` (or the pattern).
  void render(Deck& d, int64_t frames, int block = 256) {
    std::vector<int> pat{block};
    renderPattern(d, frames, pat);
  }
  void renderPattern(Deck& d, int64_t frames, const std::vector<int>& pattern) {
    std::vector<float> l(kMaxBlockFrames), r(kMaxBlockFrames);
    size_t pi = 0;
    while (frames > 0) {
      int n = pattern[pi % pattern.size()];
      pi++;
      if (n > frames) n = static_cast<int>(frames);
      if (n > kMaxBlockFrames) n = kMaxBlockFrames;
      const BlockClock c = clock(n);
      if (rtCheck) {
        rt::Scope rts;
        d.render(l.data(), r.data(), n, c);
      } else {
        d.render(l.data(), r.data(), n, c);
      }
      outL.insert(outL.end(), l.begin(), l.begin() + n);
      outR.insert(outR.end(), r.begin(), r.begin() + n);
      frame += n;
      frames -= n;
    }
  }
};

// ---- golden files -----------------------------------------------------------------------
inline bool loadJson(const std::string& path, json::Value& out) {
  omtest::Wav dummy;
  (void)dummy;
  FILE* f = nullptr;
#ifdef _MSC_VER
  if (fopen_s(&f, path.c_str(), "rb") != 0) f = nullptr;
#else
  f = std::fopen(path.c_str(), "rb");
#endif
  if (!f) return false;
  std::string s;
  char buf[4096];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) s.append(buf, n);
  std::fclose(f);
  std::string err;
  return json::parse(s, out, &err);
}

// Golden path or OM_SKIP when OM_GOLDEN_DIR is unset / the file is missing.
inline std::string golden(const std::string& rel) {
  const std::string p = omtest::goldenPath(rel);
  if (p.empty()) OM_SKIP("OM_GOLDEN_DIR not set (SPEC.md §18.4): run tests/deck/goldens/make_deck_goldens.js");
  FILE* f = nullptr;
#ifdef _MSC_VER
  if (fopen_s(&f, p.c_str(), "rb") != 0) f = nullptr;
#else
  f = std::fopen(p.c_str(), "rb");
#endif
  if (!f) OM_SKIP("golden file missing: " + p);
  std::fclose(f);
  return p;
}

inline omtest::Wav loadWav(const std::string& rel) {
  omtest::Wav w;
  std::string err;
  if (!omtest::readWav(golden(rel), w, &err)) omtest::fail("readWav", __FILE__, __LINE__, err);
  return w;
}

// ---- measurements ---------------------------------------------------------------------
inline double maxAbsDiff(const float* a, const float* b, size_t n) {
  double m = 0;
  for (size_t i = 0; i < n; i++) m = std::max(m, std::fabs(static_cast<double>(a[i]) - b[i]));
  return m;
}
inline double rms(const float* a, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += static_cast<double>(a[i]) * a[i];
  return n ? std::sqrt(s / n) : 0.0;
}
inline double peak(const float* a, size_t n) {
  double m = 0;
  for (size_t i = 0; i < n; i++) m = std::max(m, std::fabs(static_cast<double>(a[i])));
  return m;
}
inline double correlation(const float* a, const float* b, size_t n) {
  double ab = 0, aa = 1e-30, bb = 1e-30;
  for (size_t i = 0; i < n; i++) {
    ab += static_cast<double>(a[i]) * b[i];
    aa += static_cast<double>(a[i]) * a[i];
    bb += static_cast<double>(b[i]) * b[i];
  }
  return ab / std::sqrt(aa * bb);
}
inline double toDb(double v) { return v > 0 ? 20.0 * std::log10(v) : -400.0; }

}  // namespace decktest
