// Zero-latency non-uniform partitioned FFT convolution (shared immutable
// kernel + per-instance state), engine.js makeImpulse() from a seeded
// generator, and the Chromium ConvolverNode normalization (owner: fx).
// SPEC.md §11.3.
//
// The normalization formula follows Chromium's Reverb::
// CalculateNormalizationScale (third_party/blink/renderer/platform/audio/
// reverb.cc, Copyright (C) 2010 Google Inc., BSD-3-Clause), re-implemented
// here from its documented behaviour.
//
// Layout (frames, any sample rate): direct-form head h[0, 64); overlap-save
// levels of 64 / 256 / 1024 frames (3 partitions each, offset == block,
// computed synchronously when their block completes, so their output starts
// at once: zero latency); the tail in 2048-frame partitions from 4096 on,
// whose block result is needed only one block after its input completes, so
// its multiply-accumulates and inverse FFT are spread evenly over the next
// 2048 frames (constant CPU per callback). Every block size works.
#include "om/convolver.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "fft.h"

#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
#define OM_FX_SSE2 1
#include <emmintrin.h>
#endif

namespace om {

namespace {
constexpr int kDirect = 64;                      // direct-form head (taps) == the 64-frame segment
constexpr int kSyncBlocks[] = {64, 256, 1024};   // synchronous levels (offset == block)
constexpr int kSyncPartitions = 3;
constexpr int kTailBlock = 2048;                 // spread level (offset 4096 == 2 x block)
constexpr int kMaxLevels = 4;
constexpr int kIfftWeight = 6;                   // an inverse 4096-point FFT ~ 6 partition MACs
constexpr float kSilentLevel = 1e-15f;           // input at or below: silence (-300 dBFS)
constexpr double kIdleLevel = 1e-6;              // remaining tail bound below -120 dBFS: idle

inline void zeroFloats(float* p, int n) noexcept { std::memset(p, 0, sizeof(float) * static_cast<size_t>(n)); }

// y[t] = sum_j hrev[j] * h[t + j], j < 64 (h[t + 63] is the current input sample)
void directHead(const float* hrev, const float* h, float* y, int m) noexcept {
  for (int t = 0; t < m; t++) {
    const float* x = h + t;
#if defined(OM_FX_SSE2)
    __m128 a0 = _mm_setzero_ps(), a1 = _mm_setzero_ps();
    for (int j = 0; j < kDirect; j += 8) {
      a0 = _mm_add_ps(a0, _mm_mul_ps(_mm_loadu_ps(hrev + j), _mm_loadu_ps(x + j)));
      a1 = _mm_add_ps(a1, _mm_mul_ps(_mm_loadu_ps(hrev + j + 4), _mm_loadu_ps(x + j + 4)));
    }
    a0 = _mm_add_ps(a0, a1);
    a0 = _mm_add_ps(a0, _mm_movehl_ps(a0, a0));
    a0 = _mm_add_ss(a0, _mm_shuffle_ps(a0, a0, 1));
    y[t] = _mm_cvtss_f32(a0);
#else
    float s = 0;
    for (int j = 0; j < kDirect; j++) s += hrev[j] * x[j];
    y[t] = s;
#endif
  }
}
}  // namespace

// ---------------------------------------------------------------------------
// Impulses
// ---------------------------------------------------------------------------
float convolverNormalizationScale(const std::vector<float>& left, const std::vector<float>& right, int sampleRate) {
  // Chromium Reverb::CalculateNormalizationScale (stereo response).
  const size_t length = left.size();
  if (length == 0 || right.size() != length) return 1.0f;
  double power = 0;
  for (size_t i = 0; i < length; i++) power += double(left[i]) * left[i] + double(right[i]) * right[i];
  power = std::sqrt(power / (2.0 * static_cast<double>(length)));
  constexpr double kMinPower = 0.000125;
  if (!std::isfinite(power) || power < kMinPower) power = kMinPower;
  double scale = 1.0 / power;
  scale *= std::pow(10.0, -58.0 / 20.0);  // kGainCalibration = -58 dB
  if (sampleRate > 0) scale *= 44100.0 / sampleRate;  // kGainCalibrationSampleRate
  return static_cast<float>(scale);
}

Impulse makeImpulse(double seconds, double decay, int sampleRate, uint32_t seed) {
  Impulse ir;
  ir.sampleRate = sampleRate;
  if (!(seconds > 0) || sampleRate <= 0) return ir;
  const size_t len = static_cast<size_t>(std::floor(sampleRate * seconds));  // engine.js Math.floor(sr * seconds)
  if (len == 0) return ir;
  ir.left.resize(len);
  ir.right.resize(len);
  uint32_t s = seed ? seed : 0x9E3779B9u;
  auto uniform = [&s]() noexcept {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return static_cast<double>(s) / 4294967296.0;
  };
  for (int c = 0; c < 2; c++) {
    float* d = c == 0 ? ir.left.data() : ir.right.data();
    for (size_t i = 0; i < len; i++) {
      d[i] = static_cast<float>((uniform() * 2.0 - 1.0) * std::pow(1.0 - static_cast<double>(i) / static_cast<double>(len), decay));
    }
  }
  const float scale = convolverNormalizationScale(ir.left, ir.right, sampleRate);
  for (float& v : ir.left) v *= scale;
  for (float& v : ir.right) v *= scale;
  ir.normalizationScale = scale;
  return ir;
}

// ---------------------------------------------------------------------------
// Kernel (immutable, shared)
// ---------------------------------------------------------------------------
struct ConvolverKernel::Impl {
  struct Level {
    int N = 0, K = 0, offset = 0;
    bool spread = false;
    const fx::RealFft* fft = nullptr;
    std::vector<float> spec[2];  // K partitions x (re[N], im[N]) of the zero-padded part, scaled by 1/N
  };
  int length = 0;
  int sampleRate = 0;
  int direct = 0;
  float directRev[2][kDirect] = {};
  std::vector<Level> levels;
  std::vector<std::unique_ptr<fx::RealFft>> ffts;
  std::vector<float> tailBound;  // [s / 64]: sum over k >= s of max(|hL[k]|, |hR[k]|)
  std::vector<ConvolverKernel::Partitions> layout;
  size_t bytes = 0;
};

ConvolverKernel::ConvolverKernel() : impl_(std::make_unique<Impl>()) {}
ConvolverKernel::~ConvolverKernel() = default;

std::shared_ptr<const ConvolverKernel> ConvolverKernel::build(const Impulse& ir, int /*maxBlockFrames*/) {
  std::shared_ptr<ConvolverKernel> k(new ConvolverKernel());
  Impl& m = *k->impl_;
  const bool stereo = ir.right.size() == ir.left.size();
  const int len = static_cast<int>(ir.left.size());
  m.length = len;
  m.sampleRate = ir.sampleRate;
  if (len <= 0) return k;
  const float* h[2] = {ir.left.data(), stereo ? ir.right.data() : ir.left.data()};
  m.direct = std::min(kDirect, len);
  for (int c = 0; c < 2; c++)
    for (int j = 0; j < kDirect; j++) {
      const int idx = kDirect - 1 - j;
      m.directRev[c][j] = idx < len ? h[c][idx] : 0.0f;
    }
  auto fftFor = [&m](int points) -> const fx::RealFft* {
    for (const auto& f : m.ffts)
      if (f->points() == points) return f.get();
    m.ffts.push_back(std::make_unique<fx::RealFft>(points));
    return m.ffts.back().get();
  };
  int pos = kDirect;
  auto addLevel = [&](int N, int K, bool spread) {
    Impl::Level lv;
    lv.N = N;
    lv.K = K;
    lv.offset = pos;
    lv.spread = spread;
    lv.fft = fftFor(2 * N);
    std::vector<float> frame(static_cast<size_t>(2 * N));
    const float inv = 1.0f / static_cast<float>(N);
    for (int c = 0; c < 2; c++) {
      lv.spec[c].assign(static_cast<size_t>(K) * 2 * N, 0.0f);
      for (int j = 0; j < K; j++) {
        std::fill(frame.begin(), frame.end(), 0.0f);
        const int a = pos + j * N, b = std::min(len, a + N);
        for (int i = a; i < b; i++) frame[static_cast<size_t>(i - a)] = h[c][i];
        float* re = lv.spec[c].data() + static_cast<size_t>(j) * 2 * N;
        float* im = re + N;
        lv.fft->forward(frame.data(), re, im);
        for (int i = 0; i < 2 * N; i++) re[i] *= inv;  // re then im, contiguous
      }
      m.bytes += lv.spec[c].size() * sizeof(float);
    }
    m.layout.push_back({N, K, pos, spread});
    pos += K * N;
    m.levels.push_back(std::move(lv));
  };
  for (int N : kSyncBlocks) {
    if (pos >= len) break;
    addLevel(N, std::min(kSyncPartitions, (len - pos + N - 1) / N), false);
  }
  if (pos < len) addLevel(kTailBlock, (len - pos + kTailBlock - 1) / kTailBlock, true);
  // Bound of the remaining tail, for the idle rule.
  m.tailBound.assign(static_cast<size_t>(len / 64 + 2), 0.0f);
  double acc = 0;
  for (int s = len - 1; s >= 0; s--) {
    acc += std::max(std::fabs(h[0][s]), std::fabs(h[1][s]));
    if ((s & 63) == 0) m.tailBound[static_cast<size_t>(s / 64)] = static_cast<float>(acc);
  }
  m.bytes += m.tailBound.size() * sizeof(float);
  return k;
}

int ConvolverKernel::lengthFrames() const noexcept { return impl_->length; }
int ConvolverKernel::sampleRate() const noexcept { return impl_->sampleRate; }
int ConvolverKernel::directTaps() const noexcept { return impl_->direct; }
const std::vector<ConvolverKernel::Partitions>& ConvolverKernel::layout() const noexcept { return impl_->layout; }
size_t ConvolverKernel::memoryBytes() const noexcept { return impl_->bytes; }

// ---------------------------------------------------------------------------
// Per-instance state
// ---------------------------------------------------------------------------
namespace {
struct LevelState {
  const ConvolverKernel::Impl::Level* k = nullptr;
  int N = 0, K = 0;
  bool spread = false;
  float* tin[2] = {};   // 2N: [previous block | block being filled]
  float* fdl[2] = {};   // K x 2N spectra of the last K frames (ring)
  float* play[2] = {};  // N: output block being played
  float* next[2] = {};  // N: spread level, block being computed
  float* acc[2] = {};   // 2N: spread level accumulator (re | im)
  int head = 0;         // newest FDL slot
  int valid = 0;        // slots written since the last clear (older ones are never read)
  bool pending = false; // spread level: work of the current period not finished
  int units = 0, unitsTotal = 0;
};
}  // namespace

struct Convolver::Impl {
  std::shared_ptr<const ConvolverKernel> kernel;
  const ConvolverKernel::Impl* km = nullptr;
  std::vector<float> big;    // frequency-domain delay lines (never needs clearing: see `valid`)
  std::vector<float> small;  // time-domain buffers (cleared on reset)
  std::vector<float> work;   // scratch: synchronous accumulators + inverse FFT output
  LevelState lv[kMaxLevels];
  int nlv = 0;
  float* hist[2] = {};       // 63 previous + 64 current input samples
  float* accRe = nullptr;    // synchronous levels' accumulator (N <= 1024)
  float* accIm = nullptr;
  float* tmp = nullptr;      // inverse FFT output (2N <= 4096)
  int64_t pos = 0;           // frames since the last clear
  bool idle = true, dirty = false;
  int64_t silentRun = 0, flushFrames = 0;
  float peak = 0;

  void clearState() noexcept {
    if (!small.empty()) std::memset(small.data(), 0, small.size() * sizeof(float));
    for (int l = 0; l < nlv; l++) {
      lv[l].head = lv[l].K - 1;
      lv[l].valid = 0;
      lv[l].pending = false;
      lv[l].units = lv[l].unitsTotal = 0;
    }
    pos = 0;
  }

  void runSync(LevelState& L) noexcept {
    const int N = L.N, K = L.K;
    const ConvolverKernel::Impl::Level& kl = *L.k;
    const int slot = L.head + 1 == K ? 0 : L.head + 1;
    L.head = slot;
    if (L.valid < K) L.valid++;
    for (int c = 0; c < 2; c++) {
      float* re = L.fdl[c] + static_cast<size_t>(slot) * 2 * N;
      kl.fft->forward(L.tin[c], re, re + N);
      std::memcpy(L.tin[c], L.tin[c] + N, sizeof(float) * static_cast<size_t>(N));
      zeroFloats(accRe, N);
      zeroFloats(accIm, N);
      for (int j = 0; j < L.valid; j++) {
        const int s = slot - j < 0 ? slot - j + K : slot - j;
        const float* xr = L.fdl[c] + static_cast<size_t>(s) * 2 * N;
        const float* hr = kl.spec[c].data() + static_cast<size_t>(j) * 2 * N;
        fx::complexMacPacked(accRe, accIm, xr, xr + N, hr, hr + N, N);
      }
      kl.fft->inverse(accRe, accIm, tmp);
      std::memcpy(L.play[c], tmp + N, sizeof(float) * static_cast<size_t>(N));
    }
  }

  void tailUnit(LevelState& L) noexcept {
    const int N = L.N, K = L.K;
    const ConvolverKernel::Impl::Level& kl = *L.k;
    if (L.units < L.unitsTotal) {
      const int j = L.units;
      const int s = L.head - j < 0 ? L.head - j + K : L.head - j;
      for (int c = 0; c < 2; c++) {
        const float* xr = L.fdl[c] + static_cast<size_t>(s) * 2 * N;
        const float* hr = kl.spec[c].data() + static_cast<size_t>(j) * 2 * N;
        fx::complexMacPacked(L.acc[c], L.acc[c] + N, xr, xr + N, hr, hr + N, N);
      }
      L.units++;
      return;
    }
    for (int c = 0; c < 2; c++) {
      kl.fft->inverse(L.acc[c], L.acc[c] + N, tmp);
      std::memcpy(L.next[c], tmp + N, sizeof(float) * static_cast<size_t>(N));
    }
    L.pending = false;
  }

  void tailBoundary(LevelState& L) noexcept {
    while (L.pending) tailUnit(L);  // the block that starts playing now
    std::swap(L.play[0], L.next[0]);
    std::swap(L.play[1], L.next[1]);
    const int N = L.N, K = L.K;
    const int slot = L.head + 1 == K ? 0 : L.head + 1;
    L.head = slot;
    if (L.valid < K) L.valid++;
    for (int c = 0; c < 2; c++) {
      float* re = L.fdl[c] + static_cast<size_t>(slot) * 2 * N;
      L.k->fft->forward(L.tin[c], re, re + N);
      std::memcpy(L.tin[c], L.tin[c] + N, sizeof(float) * static_cast<size_t>(N));
      zeroFloats(L.acc[c], 2 * N);
    }
    L.units = 0;
    L.unitsTotal = L.valid;
    L.pending = true;
  }

  // Spread work: done in proportion to the time elapsed in the period, so
  // every callback carries about the same load.
  void tailWork(LevelState& L) noexcept {
    if (!L.pending) return;
    const int64_t elapsed = pos % L.N;
    const int64_t total = L.unitsTotal + kIfftWeight;
    const int64_t target = (total * elapsed + L.N - 1) / L.N;
    while (L.pending && L.units < target) tailUnit(L);
  }

  void run(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept {
    const float* in[2] = {inL, inR};
    float* out[2] = {outL, outR};
    int i = 0;
    while (i < n) {
      const int phase = static_cast<int>(pos & (kDirect - 1));
      const int m = std::min(n - i, kDirect - phase);
      for (int c = 0; c < 2; c++) {
        const float* x = in[c] + i;
        float* h = hist[c];
        std::memcpy(h + kDirect - 1, x, sizeof(float) * static_cast<size_t>(m));
        for (int l = 0; l < nlv; l++) {
          LevelState& L = lv[l];
          std::memcpy(L.tin[c] + L.N + static_cast<int>(pos % L.N), x, sizeof(float) * static_cast<size_t>(m));
        }
        float* y = out[c] + i;  // may alias x: the input was copied above
        directHead(km->directRev[c], h, y, m);
        for (int l = 0; l < nlv; l++) {
          const float* p = lv[l].play[c] + static_cast<int>(pos % lv[l].N);
          for (int t = 0; t < m; t++) y[t] += p[t];
        }
        std::memmove(h, h + m, sizeof(float) * (kDirect - 1));
      }
      pos += m;
      for (int l = 0; l < nlv; l++) {
        LevelState& L = lv[l];
        if (pos % L.N == 0) {
          if (L.spread)
            tailBoundary(L);
          else
            runSync(L);
        }
      }
      i += m;
    }
    for (int l = 0; l < nlv; l++)
      if (lv[l].spread) tailWork(lv[l]);
  }
};

Convolver::Convolver() : impl_(std::make_unique<Impl>()) {}
Convolver::~Convolver() = default;

void Convolver::prepare(std::shared_ptr<const ConvolverKernel> kernel, int /*maxBlockFrames*/) {
  Impl& m = *impl_;
  m.kernel = std::move(kernel);
  m.km = m.kernel ? &m.kernel->impl() : nullptr;
  m.nlv = 0;
  m.big.clear();
  m.small.clear();
  m.work.clear();
  if (!m.km || m.km->length <= 0) {
    m.idle = true;
    return;
  }
  const auto& levels = m.km->levels;
  size_t bigN = 0, smallN = 2 * 128;
  for (const auto& kl : levels) {
    bigN += 2 * static_cast<size_t>(kl.K) * 2 * kl.N;
    smallN += 2 * (2 * static_cast<size_t>(kl.N) + kl.N);  // tin + play
    if (kl.spread) smallN += 2 * (static_cast<size_t>(kl.N) + 2 * kl.N);  // next + acc
  }
  m.big.assign(bigN, 0.0f);
  m.small.assign(smallN, 0.0f);
  m.work.assign(2 * 1024 + 2 * kTailBlock, 0.0f);
  float* b = m.big.data();
  float* s = m.small.data();
  m.hist[0] = s;
  m.hist[1] = s + 128;
  s += 256;
  for (const auto& kl : levels) {
    LevelState& L = m.lv[m.nlv++];
    L = LevelState();
    L.k = &kl;
    L.N = kl.N;
    L.K = kl.K;
    L.spread = kl.spread;
    for (int c = 0; c < 2; c++) {
      L.fdl[c] = b;
      b += static_cast<size_t>(kl.K) * 2 * kl.N;
      L.tin[c] = s;
      s += 2 * kl.N;
      L.play[c] = s;
      s += kl.N;
      if (kl.spread) {
        L.next[c] = s;
        s += kl.N;
        L.acc[c] = s;
        s += 2 * kl.N;
      }
    }
  }
  m.accRe = m.work.data();
  m.accIm = m.accRe + 1024;
  m.tmp = m.accIm + 1024;
  m.flushFrames = static_cast<int64_t>(m.km->length) + 3 * kTailBlock + kDirect;
  m.clearState();
  m.idle = true;
  m.dirty = false;
  m.silentRun = 0;
  m.peak = 0;
}

void Convolver::reset() noexcept {
  Impl& m = *impl_;
  m.clearState();
  m.idle = true;
  m.dirty = false;
  m.silentRun = 0;
  m.peak = 0;
}

void Convolver::process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept {
  Impl& m = *impl_;
  if (n <= 0) return;
  if (!m.km || m.nlv < 0 || m.km->length <= 0) {
    zeroFloats(outL, n);
    zeroFloats(outR, n);
    return;
  }
  float pk = 0.0f;
  for (int i = 0; i < n; i++) {
    const float a = std::fabs(inL[i]), b = std::fabs(inR[i]);
    pk = a > pk ? a : pk;
    pk = b > pk ? b : pk;
  }
  if (m.idle) {
    if (pk <= kSilentLevel) {
      zeroFloats(outL, n);
      zeroFloats(outR, n);
      return;
    }
    if (m.dirty) m.clearState();
    m.idle = false;
    m.dirty = false;
    m.peak = 0;
    m.silentRun = 0;
  }
  int trailing = 0;
  while (trailing < n && std::fabs(inL[n - 1 - trailing]) <= kSilentLevel && std::fabs(inR[n - 1 - trailing]) <= kSilentLevel)
    trailing++;
  m.run(inL, inR, outL, outR, n);
  if (trailing == n) {
    m.silentRun += n;
  } else {
    m.silentRun = trailing;
    if (pk > m.peak) m.peak = pk;
  }
  if (m.silentRun >= m.flushFrames) {
    m.idle = true;  // every buffer holds zeros derived from silence: exact
    m.dirty = false;
  } else if (m.silentRun >= kDirect) {
    const auto& tb = m.km->tailBound;
    const size_t idx = std::min(static_cast<size_t>(m.silentRun / 64), tb.size() - 1);
    if (static_cast<double>(m.peak) * tb[idx] < kIdleLevel) {
      m.idle = true;  // the rest of the tail is below -120 dBFS: dropped, state cleared on wake-up
      m.dirty = true;
    }
  }
}

bool Convolver::idle() const noexcept { return impl_->idle; }
int Convolver::latencyFrames() const noexcept { return 0; }
size_t Convolver::memoryBytes() const noexcept {
  const Impl& m = *impl_;
  return (m.big.size() + m.small.size() + m.work.size()) * sizeof(float);
}

}  // namespace om
