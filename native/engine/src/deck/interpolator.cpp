// Fractional-position reading of TrackBuffers (owner: deck), SPEC.md §9.2:
//  - deckimpl::readChromium(): the deck's main and roll read pointers, a port
//    of Chromium's AudioBufferSourceNode::RenderFromBuffer (linear
//    interpolation in double, accumulated position, loop seams, end of buffer),
//    proved bit-exact against Chromium's own renders (tests/deck goldens);
//  - Interpolator / deckimpl::kernelRead(): the generic reader (scratch and
//    spin voices: signed speeds, missing frames = silence) with the dev-only
//    A/B qualities (4-point Hermite, 16-tap windowed sinc whose cutoff follows
//    the rate).
// Real-time safe: no allocation (the sinc tables are static data built at
// load time), noexcept.
#include "om/interpolator.h"

#include <cmath>
#include <cstring>

#include "deck_internal.h"

namespace om {

namespace {

// ---- 16-tap windowed-sinc tables (dev A/B only) ------------------------------
constexpr int kSincTaps = 16;
constexpr int kSincPhases = 256;
constexpr int kSincCutoffs = 4;
constexpr double kCutoffs[kSincCutoffs] = {1.0, 0.85, 0.7, 0.55};  // fraction of Nyquist

double besselI0(double x) noexcept {
  double sum = 1, term = 1;
  for (int k = 1; k < 30; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
}

struct SincTables {
  // taps for the fractional phase p / kSincPhases, tap t at offset t - 7
  float c[kSincCutoffs][kSincPhases + 1][kSincTaps];
  SincTables() noexcept {
    const double beta = 7.0;
    const double i0b = besselI0(beta);
    for (int ci = 0; ci < kSincCutoffs; ci++) {
      const double fc = kCutoffs[ci] * 0.94;  // keep the transition band below Nyquist
      for (int ph = 0; ph <= kSincPhases; ph++) {
        const double frac = static_cast<double>(ph) / kSincPhases;
        double w[kSincTaps];
        double sum = 0;
        for (int t = 0; t < kSincTaps; t++) {
          const double x = (t - 7) - frac;  // distance from the read position
          const double sx = x == 0 ? 1.0 : std::sin(kPi * fc * x) / (kPi * fc * x);
          const double u = x / 8.5;
          const double win = std::fabs(u) >= 1 ? 0.0 : besselI0(beta * std::sqrt(1 - u * u)) / i0b;
          w[t] = fc * sx * win;
          sum += w[t];
        }
        for (int t = 0; t < kSincTaps; t++) c[ci][ph][t] = static_cast<float>(w[t] / sum);  // unity DC gain
      }
    }
  }
};
const SincTables gSinc;

inline int cutoffIndex(double rate) noexcept {
  const double a = std::fabs(rate);
  if (a <= 1.0 / kCutoffs[1]) return 0;
  if (a <= 1.0 / kCutoffs[2]) return 1;
  if (a <= 1.0 / kCutoffs[3]) return 2;
  return 3;
}

}  // namespace

namespace deckimpl {

void kernelRead(const TrackBuffer& tb, InterpQuality q, double pos, double rate, float& l, float& r) noexcept {
  const double fi = std::floor(pos);
  const int64_t i = static_cast<int64_t>(fi);
  const double f = pos - fi;
  if (q == InterpQuality::Hermite4) {
    float xl[4], xr[4];
    for (int k = 0; k < 4; k++) fetch(tb, i - 1 + k, xl[k], xr[k]);
    auto herm = [f](const float* x) {
      const double c0 = x[1];
      const double c1 = 0.5 * (static_cast<double>(x[2]) - x[0]);
      const double c2 = x[0] - 2.5 * x[1] + 2.0 * x[2] - 0.5 * x[3];
      const double c3 = 0.5 * (static_cast<double>(x[3]) - x[0]) + 1.5 * (static_cast<double>(x[1]) - x[2]);
      return static_cast<float>(((c3 * f + c2) * f + c1) * f + c0);
    };
    l = herm(xl);
    r = herm(xr);
    return;
  }
  if (q == InterpQuality::Sinc16) {
    const int ph = static_cast<int>(f * kSincPhases + 0.5);
    const float* w = gSinc.c[cutoffIndex(rate)][ph];
    double sl = 0, sr = 0;
    for (int t = 0; t < kSincTaps; t++) {
      float a, b;
      fetch(tb, i - 7 + t, a, b);
      sl += static_cast<double>(w[t]) * a;
      sr += static_cast<double>(w[t]) * b;
    }
    l = static_cast<float>(sl);
    r = static_cast<float>(sr);
    return;
  }
  float l1, r1, l2, r2;
  fetch(tb, i, l1, r1);
  fetch(tb, i + 1, l2, r2);
  l = static_cast<float>((1.0 - f) * l1 + f * l2);
  r = static_cast<float>((1.0 - f) * r1 + f * r2);
}

int readChromium(const TrackBuffer& tb, double& pos, double inc, const LoopFrames& loop, int n, float* outL,
                 float* outR, double* posOut, bool& finished, InterpQuality q) noexcept {
  int k = 0;
  if (finished) {
    for (; k < n; k++) {
      outL[k] = outR[k] = 0;
      if (posOut) posOut[k] = pos;
    }
    return 0;
  }
  const int64_t len = tb.frames;
  while (k < n) {
    const double p = pos;
    if (q == InterpQuality::Linear) {
      // Pre-roll far from 0: both frames of the interpolation are silence.
      if (p + inc < -1.0 && inc > 0) {
        outL[k] = outR[k] = 0;
        if (posOut) posOut[k] = p;
        pos = p + inc;
        k++;
        continue;
      }
      // Fast run: positions >= 0 whose two frames lie in one READY chunk, away
      // from the buffer end, with no wrap or end after any increment of the run.
      if (p >= 0 && inc > 0 && len >= 2) {
        const int64_t i = static_cast<int64_t>(p);
        const int64_t c = i >> TrackBuffer::kChunkShift;
        const int64_t chunkEnd = (c + 1) << TrackBuffer::kChunkShift;
        double lim = static_cast<double>((chunkEnd < len ? chunkEnd : len) - 1);  // floor(p) + 1 stays below it
        const double noWrap = loop.virtualEnd - inc;                             // p + inc < virtualEnd
        if (noWrap < lim) lim = noWrap;
        if (p < lim && tb.chunkReady(c)) {
          int m = static_cast<int>(std::floor((lim - p) / inc)) - 1;  // conservative (accumulated positions)
          if (m > n - k) m = n - k;
          if (m > 0) {
            double x = p;
            if (tb.format == PcmFormat::S16) {
              const int16_t* s = tb.s16.get();
              const float sc = tb.chunkScale[c];
              for (int j = 0; j < m; j++) {
                const int64_t ii = static_cast<int64_t>(x);
                const double f = x - static_cast<double>(ii);
                const int16_t* d = s + ii * 2;
                const float l1 = d[0] * sc, r1 = d[1] * sc, l2 = d[2] * sc, r2 = d[3] * sc;
                outL[k + j] = static_cast<float>((1.0 - f) * l1 + f * l2);
                outR[k + j] = static_cast<float>((1.0 - f) * r1 + f * r2);
                if (posOut) posOut[k + j] = x;
                x += inc;
              }
            } else {
              const float* s = tb.f32.get();
              for (int j = 0; j < m; j++) {
                const int64_t ii = static_cast<int64_t>(x);
                const double f = x - static_cast<double>(ii);
                const float* d = s + ii * 2;
                outL[k + j] = static_cast<float>((1.0 - f) * d[0] + f * d[2]);
                outR[k + j] = static_cast<float>((1.0 - f) * d[1] + f * d[3]);
                if (posOut) posOut[k + j] = x;
                x += inc;
              }
            }
            pos = x;
            k += m;
            continue;
          }
        }
      }
      // One frame with every rule checked.
      sampleAt(tb, p, loop, outL[k], outR[k]);
    } else {
      // Dev A/B qualities: Chromium's position, loop and end rules, another kernel.
      kernelRead(tb, q, p, inc, outL[k], outR[k]);
    }
    if (posOut) posOut[k] = p;
    k++;
    pos = p + inc;
    if (pos >= loop.virtualEnd) {
      if (loop.on) {
        pos -= loop.length;
      } else {
        finished = true;
        for (int j = k; j < n; j++) {
          outL[j] = outR[j] = 0;
          if (posOut) posOut[j] = pos;
        }
        return k;
      }
    }
  }
  return n;
}

}  // namespace deckimpl

Interpolator::Interpolator() = default;

void Interpolator::read(const TrackBuffer& tb, double pos, double rate, float& l, float& r) const noexcept {
  deckimpl::kernelRead(tb, quality_, pos, rate, l, r);
}

void Interpolator::readBlock(const TrackBuffer& tb, double pos0, double inc, int n, float* l, float* r) const noexcept {
  if (quality_ == InterpQuality::Linear && inc == 1.0 && pos0 == std::floor(pos0)) {
    // exact copy (Chromium: integer position at rate 1)
    const int64_t i0 = static_cast<int64_t>(pos0);
    for (int k = 0; k < n; k++) deckimpl::fetch(tb, i0 + k, l[k], r[k]);
    return;
  }
  for (int k = 0; k < n; k++) deckimpl::kernelRead(tb, quality_, pos0 + inc * k, inc, l[k], r[k]);
}

}  // namespace om
