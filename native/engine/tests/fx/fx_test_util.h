// Helpers of the FX module tests (owner: fx): stereo test signals, block-wise
// processing inside an rt::Scope (any allocation or free there fails the
// test), a reference echo loop in double precision, peak and centroid
// finders, wall-clock CPU measurement. Header-only, test code only.
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>

#include "om/dsp.h"
#include "om/rt.h"

namespace fxtest {

struct Stereo {
  std::vector<float> l, r;
  Stereo() = default;
  explicit Stereo(size_t n) : l(n, 0.0f), r(n, 0.0f) {}
  size_t size() const { return l.size(); }
};

inline uint32_t xorshift(uint32_t& s) {
  s ^= s << 13;
  s ^= s >> 17;
  s ^= s << 5;
  return s;
}

inline Stereo impulse(size_t frames, size_t at, float amp = 1.0f) {
  Stereo s(frames);
  if (at < frames) s.l[at] = s.r[at] = amp;
  return s;
}

inline Stereo noise(size_t frames, uint32_t seed, float amp, size_t from = 0, size_t to = SIZE_MAX) {
  Stereo s(frames);
  uint32_t x = seed ? seed : 1u;
  for (size_t i = from; i < std::min(frames, to); i++) {
    s.l[i] = amp * (static_cast<float>(static_cast<int32_t>(xorshift(x))) / 2147483648.0f);
    s.r[i] = amp * (static_cast<float>(static_cast<int32_t>(xorshift(x))) / 2147483648.0f);
  }
  return s;
}

inline Stereo constant(size_t frames, float v) {
  Stereo s(frames);
  std::fill(s.l.begin(), s.l.end(), v);
  std::fill(s.r.begin(), s.r.end(), v);
  return s;
}

// Processes `in` through `proc` (process(inL, inR, outL, outR, n)) in blocks
// of `block` frames (or the sizes returned by `sizeAt(frame)` when given),
// calling before(frame, n) ahead of each block. Every process() call runs in
// an rt::Scope.
template <class P, class Before>
Stereo run(P& proc, const Stereo& in, int block, Before&& before) {
  Stereo out(in.size());
  size_t i = 0;
  while (i < in.size()) {
    const int n = static_cast<int>(std::min<size_t>(static_cast<size_t>(block), in.size() - i));
    before(i, n);
    {
      om::rt::Scope rt;
      proc.process(in.l.data() + i, in.r.data() + i, out.l.data() + i, out.r.data() + i, n);
    }
    i += static_cast<size_t>(n);
  }
  return out;
}
template <class P>
Stereo run(P& proc, const Stereo& in, int block) {
  return run(proc, in, block, [](size_t, int) {});
}

inline double maxAbs(const std::vector<float>& x, size_t from = 0, size_t to = SIZE_MAX) {
  double m = 0;
  for (size_t i = from; i < std::min(x.size(), to); i++) m = std::max(m, static_cast<double>(std::fabs(x[i])));
  return m;
}
inline double maxDiff(const Stereo& a, const Stereo& b, size_t from = 0, size_t to = SIZE_MAX) {
  double m = 0;
  const size_t n = std::min({a.size(), b.size(), to});
  for (size_t i = from; i < n; i++) {
    m = std::max(m, std::fabs(static_cast<double>(a.l[i]) - b.l[i]));
    m = std::max(m, std::fabs(static_cast<double>(a.r[i]) - b.r[i]));
  }
  return m;
}
inline double db(double x) { return x > 0 ? 20.0 * std::log10(x) : -400.0; }

// Index of the largest |x| in [from, to).
inline size_t argMaxAbs(const std::vector<float>& x, size_t from, size_t to) {
  size_t best = from;
  double bv = -1;
  for (size_t i = from; i < std::min(x.size(), to); i++) {
    const double v = std::fabs(x[i]);
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}
// Centroid of |x| (energy-free, first moment) in [from, to).
inline double centroid(const std::vector<float>& x, size_t from, size_t to) {
  double s = 0, w = 0;
  for (size_t i = from; i < std::min(x.size(), to); i++) {
    const double a = std::fabs(x[i]);
    s += a * static_cast<double>(i);
    w += a;
  }
  return w > 0 ? s / w : -1;
}

// Ideal (drift-free) echo loop: y = line(t - D), z = F(y) (biquad with
// Chromium's arithmetic, or none), line(t) = x(t) + g * z, output = z or y.
// Static D, g. Exact for INTEGER D (the native lines read fractional delays at
// Chromium's single-precision positions, which this reference does not model).
struct RefLoop {
  double frames = 0, g = 0;
  bool hasFilter = false, outFilter = false;
  om::dsp::BiquadCoeffs c;
  std::vector<float> run(const std::vector<float>& x) const {
    const size_t n = x.size();
    std::vector<float> line(n, 0.0f), out(n, 0.0f);
    double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (size_t t = 0; t < n; t++) {
      const double rp = static_cast<double>(t) - frames;
      float y = 0;
      if (rp >= 0) {
        const size_t i1 = static_cast<size_t>(rp);
        const float f = static_cast<float>(rp - static_cast<double>(i1));
        const float s1 = line[i1];
        const float s2 = i1 + 1 < t ? line[i1 + 1] : 0.0f;
        y = (1.0f - f) * s1 + f * s2;
      }
      float z = y;
      if (hasFilter) {
        z = static_cast<float>(c.b0 * y + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2);
        x2 = x1;
        x1 = y;
        y2 = y1;
        y1 = z;
      }
      line[t] = x[t] + static_cast<float>(g) * z;
      out[t] = outFilter ? z : y;
    }
    return out;
  }
};

// Seconds of wall clock per call of fn(), median of `reps` timings of `calls` calls.
template <class F>
double secondsPerCall(F&& fn, int calls, int reps = 5) {
  std::vector<double> t;
  for (int r = 0; r < reps; r++) {
    const auto a = std::chrono::steady_clock::now();
    for (int k = 0; k < calls; k++) fn();
    const auto b = std::chrono::steady_clock::now();
    t.push_back(std::chrono::duration<double>(b - a).count() / calls);
  }
  std::sort(t.begin(), t.end());
  return t[t.size() / 2];
}

#ifdef NDEBUG
constexpr bool kOptimized = true;
#else
constexpr bool kOptimized = false;
#endif

}  // namespace fxtest
