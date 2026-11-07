// Private DSP helpers of the fx module (owner: fx): Chromium's band-limited
// "square" PeriodicWave tables and its "sine" table (built once per sample
// rate, shared), Chromium's oscillator interpolation, and engine.js
// crushCurve(). The PeriodicWave construction and lookup follow the
// documented behaviour of Chromium's periodic_wave.cc / oscillator_node.cc
// (Copyright Google Inc., BSD-3-Clause), re-implemented here: per-range
// partial culling (3 ranges per octave), normalization by the peak of the
// fullest table, table pair chosen from the fundamental, linear / 3-point /
// 5-point Lagrange interpolation by phase increment. Verified against
// Chromium's own tables and renders (tests/fx/goldens).
#include "fx_dsp.h"

#include <algorithm>
#include <mutex>

#include "fft.h"

namespace om {
namespace fx {

#include "chromium_sine4096.inc"
#include "chromium_sine_tables.inc"  // 2048 and 16384 points (22.05 / 96 kHz)

int periodicWaveSize(double sampleRate) noexcept {
  if (sampleRate <= 24000) return 2048;
  if (sampleRate <= 88200) return 4096;
  return 16384;
}

namespace {
constexpr unsigned kOctaveBands = 3;
constexpr float kCentsPerRange = 1200.0f / kOctaveBands;
constexpr float kInterpolate2Point = 0.3f;
constexpr float kInterpolate3Point = 0.16f;

unsigned numberOfRanges(int N) noexcept {
  return static_cast<unsigned>(0.5f + kOctaveBands * std::log2(static_cast<float>(N)));
}

// Chromium WaveDataForFundamentalFrequency: pitch range of a fundamental.
float pitchRangeOf(float freq, float lowest, unsigned ranges) noexcept {
  const float f = std::fabs(freq);
  const float ratio = f > 0 ? f / lowest : 0.5f;
  const float cents = std::log2(ratio) * 1200.0f;
  float pitchRange = 1.0f + cents / kCentsPerRange;
  pitchRange = std::max(pitchRange, 0.0f);
  return std::min(pitchRange, static_cast<float>(ranges - 1));
}
}  // namespace

float chromiumInterpolate(const float* higher, const float* lower, unsigned mask, double vri, float incr,
                          float tif) noexcept {
  const float aincr = std::fabs(incr);
  unsigned i0 = static_cast<unsigned>(vri);
  double sl = 0, sh = 0;
  if (aincr >= kInterpolate2Point) {
    const unsigned i1 = (i0 + 1) & mask;
    i0 &= mask;
    const double f = static_cast<double>(static_cast<float>(vri)) - i0;
    sh = (1 - f) * higher[i0] + f * higher[i1];
    sl = (1 - f) * lower[i0] + f * lower[i1];
  } else if (aincr >= kInterpolate3Point) {
    unsigned idx[3];
    for (int k = -1; k <= 1; k++) idx[k + 1] = (i0 + static_cast<unsigned>(k)) & mask;
    const double t = vri - i0;
    const double a[3] = {0.5 * t * (t - 1), 1 - t * t, 0.5 * t * (t + 1)};
    for (int k = 0; k < 3; k++) {
      sl += a[k] * lower[idx[k]];
      sh += a[k] * higher[idx[k]];
    }
  } else {
    unsigned idx[5];
    for (int k = -2; k <= 2; k++) idx[k + 2] = (i0 + static_cast<unsigned>(k)) & mask;
    const double t = vri - i0;
    const double t2 = t * t;
    const double a[5] = {t * (t2 - 1) * (t - 2) / 24, -t * (t - 1) * (t2 - 4) / 6, (t2 - 1) * (t2 - 4) / 4,
                         -t * (t + 1) * (t2 - 4) / 6, t * (t2 - 1) * (t + 2) / 24};
    for (int k = 0; k < 5; k++) {
      sl += a[k] * lower[idx[k]];
      sh += a[k] * higher[idx[k]];
    }
  }
  return static_cast<float>((1 - tif) * sh + tif * sl);
}

// ---------------------------------------------------------------------------
// Sine
// ---------------------------------------------------------------------------
std::shared_ptr<const SineTable> buildSineTable(double sampleRate) {
  std::shared_ptr<SineTable> t(new SineTable());
  const int N = periodicWaveSize(sampleRate);
  t->size_ = N;
  const float rate = static_cast<float>(sampleRate);
  t->lowest_ = static_cast<float>(0.5 * rate) / static_cast<float>(N / 2);
  t->invRateScale_ = 1.0f / (static_cast<float>(N) / rate);
  t->numberOfRanges_ = numberOfRanges(N);
  t->table_.resize(static_cast<size_t>(N));
  const float* half = N == 4096 ? kChromiumSine4096Half
                                : (N == 2048 ? kChromiumSine2048Half : (N == 16384 ? kChromiumSine16384Half : nullptr));
  if (half) {
    for (int i = 0; i < N / 2; i++) {
      t->table_[static_cast<size_t>(i)] = half[i];
      t->table_[static_cast<size_t>(i + N / 2)] = -half[i];
    }
    t->chromium_ = true;
  } else {
    for (int i = 0; i < N; i++) t->table_[static_cast<size_t>(i)] = static_cast<float>(std::sin(2.0 * kPi * i / N));
  }
  return t;
}

std::shared_ptr<const SineTable> SineTable::get(double sampleRate) {
  static std::mutex mu;
  static std::vector<std::pair<double, std::shared_ptr<const SineTable>>> cache;
  std::lock_guard<std::mutex> lk(mu);
  for (const auto& e : cache)
    if (e.first == sampleRate) return e.second;
  std::shared_ptr<const SineTable> t = buildSineTable(sampleRate);
  cache.emplace_back(sampleRate, t);
  return t;
}

float SineTable::sample(double vri, float incr) const noexcept {
  const float pr = pitchRangeOf(incr * invRateScale_, lowest_, numberOfRanges_);
  const float tif = pr - static_cast<float>(static_cast<unsigned>(pr));
  const float* t = table_.data();  // every range of a sine holds this table
  return chromiumInterpolate(t, t, static_cast<unsigned>(size_ - 1), vri, incr, tif);
}

// ---------------------------------------------------------------------------
// Square
// ---------------------------------------------------------------------------
std::shared_ptr<const SquareTables> buildSquareTables(double sampleRate, float maxHz) {
  std::shared_ptr<SquareTables> t(new SquareTables());
  const int N = periodicWaveSize(sampleRate);
  const unsigned half = static_cast<unsigned>(N / 2);
  t->size_ = N;
  const float rate = static_cast<float>(sampleRate);
  const float nyquist = static_cast<float>(0.5 * rate);
  t->lowest_ = nyquist / static_cast<float>(half);
  t->rateScale_ = static_cast<float>(N) / rate;
  t->invRateScale_ = 1.0f / t->rateScale_;
  t->numberOfRanges_ = numberOfRanges(N);
  // Ranges needed up to maxHz (+1 for the pair), at least 2.
  const float pr = pitchRangeOf(std::max(maxHz, 1e-3f), t->lowest_, t->numberOfRanges_);
  unsigned last = std::min(static_cast<unsigned>(pr) + 1, t->numberOfRanges_ - 1);
  last = std::max(last, 1u);
  std::vector<double> re(static_cast<size_t>(N)), im(static_cast<size_t>(N));
  double norm = 1.0;
  for (unsigned r = 0; r <= last; r++) {
    // Chromium NumberOfPartialsForRange
    const float centsToCull = static_cast<float>(r) * kCentsPerRange;
    const float culling = static_cast<float>(std::pow(2.0, static_cast<double>(-centsToCull / 1200.0f)));
    const unsigned partials = static_cast<unsigned>(culling * static_cast<float>(half));
    std::fill(re.begin(), re.end(), 0.0);
    std::fill(im.begin(), im.end(), 0.0);
    for (unsigned n = 1; n < half && n <= partials; n += 2) {  // square: b_n = 4 / (n pi), odd n
      const double b = 4.0 / (n * kPi);
      im[n] = -0.5 * b;           // b sin = b (e^{i} - e^{-i}) / 2i
      im[N - n] = 0.5 * b;
    }
    fftDouble(re.data(), im.data(), N, true);
    if (r == 0) {
      double peak = 0;
      for (int i = 0; i < N; i++) peak = std::max(peak, std::fabs(re[static_cast<size_t>(i)]));
      norm = peak > 0 ? 1.0 / peak : 1.0;
    }
    std::vector<float> table(static_cast<size_t>(N));
    for (int i = 0; i < N; i++) table[static_cast<size_t>(i)] = static_cast<float>(re[static_cast<size_t>(i)] * norm);
    t->tables_.push_back(std::move(table));
  }
  return t;
}

std::shared_ptr<const SquareTables> SquareTables::get(double sampleRate, float maxHz) {
  static std::mutex mu;
  static std::vector<std::pair<double, std::shared_ptr<const SquareTables>>> cache;
  std::lock_guard<std::mutex> lk(mu);
  for (const auto& e : cache) {
    if (e.first == sampleRate && e.second) {
      const SquareTables& t = *e.second;
      const float pr = pitchRangeOf(std::max(maxHz, 1e-3f), t.lowest_, t.numberOfRanges_);
      if (static_cast<unsigned>(pr) + 1 <= static_cast<unsigned>(t.tables_.size() - 1) ||
          t.tables_.size() >= t.numberOfRanges_)
        return e.second;
    }
  }
  std::shared_ptr<const SquareTables> t = buildSquareTables(sampleRate, maxHz);
  cache.emplace_back(sampleRate, t);
  return t;
}

float SquareTables::sample(double vri, float incr) const noexcept {
  const float pitchRange = pitchRangeOf(incr * invRateScale_, lowest_, numberOfRanges_);
  unsigned r1 = static_cast<unsigned>(pitchRange);
  unsigned r2 = r1 < numberOfRanges_ - 1 ? r1 + 1 : r1;
  const float tif = pitchRange - static_cast<float>(r1);
  const unsigned lastTable = static_cast<unsigned>(tables_.size() - 1);
  r1 = std::min(r1, lastTable);
  r2 = std::min(r2, lastTable);
  return chromiumInterpolate(tables_[r1].data(), tables_[r2].data(), static_cast<unsigned>(size_ - 1), vri, incr, tif);
}

void makeCrushCurve(int steps, float* curve) noexcept {
  // engine.js crushCurve: curve[i] = Math.round(x * steps) / steps, x = i / (n - 1) * 2 - 1
  for (int i = 0; i < kCurveLength; i++) {
    const double x = (static_cast<double>(i) / (kCurveLength - 1)) * 2.0 - 1.0;
    curve[i] = static_cast<float>(jsRound(x * steps) / steps);
  }
}

}  // namespace fx
}  // namespace om
