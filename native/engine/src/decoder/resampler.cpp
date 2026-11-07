// Polyphase Kaiser-windowed-sinc sample-rate converter used by the shadow
// decoder (in its own process) to bring the span of a native decode around
// the reference window to the reference rate (owner: decoder). Rational
// ratio L/M, centred (non-causal) kernel so the output is time-aligned with
// the input, unity-DC rows, streaming with an input history. Portable, not
// real-time code (it allocates). SPEC.md §7.4.
#include "om/resampler.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace om {

namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr int64_t kMaxExactPhases = 2048;  // beyond: interpolated table

// Modified Bessel function of the first kind, order 0 (power series).
double besselI0(double x) noexcept {
  const double q = x * x / 4.0;
  double sum = 1.0, term = 1.0;
  for (int k = 1; k < 200; k++) {
    term *= q / (static_cast<double>(k) * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}
}  // namespace

struct Resampler::Impl {
  int inRate = 0, outRate = 0, channels = 2;
  int64_t L = 1, M = 1;  // out/in = L/M (reduced)
  int H = 0;             // half length in input frames
  int taps = 0;          // 2H
  int64_t rows = 1;      // table rows (phases)
  bool exact = true;     // row index == phase
  double fc = 0.5, beta = 10.0;
  std::vector<double> table;  // (rows + 1) x taps
  // stream state
  std::vector<float> hist;  // interleaved history, frame 0 = input frame histStart
  int64_t histStart = 0;
  int64_t inCount = 0;      // input frames received
  int64_t outCount = 0;     // output frames produced
  int64_t pos = 0;          // outCount * M (input position of the next output, in units of 1/L frame)
  bool flushed = false;

  double kernel(double t) const noexcept {
    const double x = t / H;
    if (x <= -1.0 || x >= 1.0) return 0.0;  // support (-H, H): halfLengthFrames() is exact
    const double w = besselI0(beta * std::sqrt(1.0 - x * x)) / besselI0(beta);
    const double a = 2.0 * fc * t;
    const double s = a == 0.0 ? 1.0 : std::sin(kPi * a) / (kPi * a);
    return 2.0 * fc * s * w;
  }

  void build() {
    table.assign(static_cast<size_t>((rows + 1) * taps), 0.0);
    for (int64_t p = 0; p <= rows; p++) {
      const double phi = static_cast<double>(p) / static_cast<double>(rows);
      double* row = table.data() + p * taps;
      double sum = 0.0;
      for (int i = 0; i < taps; i++) {
        row[i] = kernel(static_cast<double>(H - 1 - i) + phi);
        sum += row[i];
      }
      if (sum != 0.0)
        for (int i = 0; i < taps; i++) row[i] /= sum;
    }
  }

  void resetStream() {
    hist.assign(static_cast<size_t>(H) * channels, 0.0f);  // the zeros before input frame 0
    histStart = -H;
    inCount = 0;
    outCount = 0;
    pos = 0;
    flushed = false;
  }

  // Output frames that can be produced now (all inputs of their window known).
  int64_t producibleUntil(bool flush) const noexcept {
    if (flush) return (inCount * L + M - 1) / M;  // outputFramesFor(inCount)
    // output j needs input frames up to floor(j M / L) + H - 1 ... + H:
    // floor(j M / L) + H <= inCount - 1  <=>  j M / L < inCount - H
    const int64_t lim = inCount - H;
    if (lim <= 0) return 0;
    return (lim * L + M - 1) / M;  // j < lim * L / M
  }

  void produce(int64_t until, std::vector<float>& out) {
    if (until <= outCount) return;
    const size_t first = out.size();
    out.resize(first + static_cast<size_t>(until - outCount) * channels);
    float* dst = out.data() + first;
    for (; outCount < until; outCount++, pos += M) {
      const int64_t base = pos / L;
      const int64_t phase = pos % L;
      const int64_t k0 = base - H + 1;  // first input frame of the window
      const float* src = hist.data() + (k0 - histStart) * channels;
      if (exact) {
        const double* row = table.data() + phase * taps;
        for (int c = 0; c < channels; c++) {
          double acc = 0.0;
          for (int i = 0; i < taps; i++) acc += row[i] * src[i * channels + c];
          *dst++ = static_cast<float>(acc);
        }
      } else {
        const double r = static_cast<double>(phase) * static_cast<double>(rows) / static_cast<double>(L);
        const int64_t r0 = std::min<int64_t>(static_cast<int64_t>(r), rows - 1);
        const double a = r - static_cast<double>(r0);
        const double* row0 = table.data() + r0 * taps;
        const double* row1 = row0 + taps;
        for (int c = 0; c < channels; c++) {
          double acc = 0.0;
          for (int i = 0; i < taps; i++) acc += (row0[i] + a * (row1[i] - row0[i])) * src[i * channels + c];
          *dst++ = static_cast<float>(acc);
        }
      }
    }
  }

  // Drops the history no future output needs.
  void trim() {
    const int64_t nextK0 = pos / L - H + 1;
    const int64_t drop = nextK0 - histStart;
    if (drop <= 0) return;
    const size_t n = static_cast<size_t>(std::min<int64_t>(drop, static_cast<int64_t>(hist.size() / channels)));
    hist.erase(hist.begin(), hist.begin() + static_cast<std::ptrdiff_t>(n * channels));
    histStart += static_cast<int64_t>(n);
  }
};

Resampler::Resampler(int inRate, int outRate, int channels, int tapsPerPhase, double cutoff, double kaiserBeta)
    : impl_(std::make_unique<Impl>()) {
  Impl& m = *impl_;
  m.inRate = inRate > 0 ? inRate : 1;
  m.outRate = outRate > 0 ? outRate : 1;
  m.channels = std::max(1, channels);
  const int64_t g = std::gcd(static_cast<int64_t>(m.inRate), static_cast<int64_t>(m.outRate));
  m.L = m.outRate / g;
  m.M = m.inRate / g;
  if (m.L == m.M) {  // passthrough
    m.H = 0;
    m.taps = 0;
    m.resetStream();
    return;
  }
  cutoff = std::clamp(cutoff, 0.5, 0.995);
  m.beta = std::clamp(kaiserBeta, 4.0, 20.0);
  const double r = std::min(1.0, static_cast<double>(m.outRate) / m.inRate);  // lower Nyquist / input Nyquist
  m.fc = 0.5 * r;                                                             // 6 dB point (cycles / input frame)
  if (tapsPerPhase > 0) {
    m.H = std::max(2, (tapsPerPhase + 1) / 2);
  } else {
    // Kaiser: length = (A - 7.95) / (14.36 * transition), transition in
    // cycles per input frame = 2 (1 - cutoff) x lower Nyquist.
    const double A = m.beta / 0.1102 + 8.7;
    const double transition = 2.0 * (1.0 - cutoff) * 0.5 * r;
    const double length = (A - 7.95) / (14.36 * transition);
    m.H = std::max(4, static_cast<int>(std::ceil(length / 2.0 * 1.04)));  // (+4 %: the formula is approximate)
  }
  m.taps = 2 * m.H;
  m.exact = m.L <= kMaxExactPhases;
  m.rows = m.exact ? m.L : kMaxExactPhases;
  m.build();
  m.resetStream();
}

Resampler::~Resampler() = default;

void Resampler::process(const float* in, int64_t inFrames, std::vector<float>& out, bool flush) {
  Impl& m = *impl_;
  if (m.flushed) return;
  if (inFrames < 0) inFrames = 0;
  if (passthrough()) {
    if (in && inFrames > 0) out.insert(out.end(), in, in + inFrames * m.channels);
    m.inCount += inFrames;
    if (flush) m.flushed = true;
    return;
  }
  if (in && inFrames > 0) {
    m.hist.insert(m.hist.end(), in, in + inFrames * m.channels);
    m.inCount += inFrames;
  }
  if (flush) {
    // zeros after the last frame, enough for every remaining window
    m.hist.insert(m.hist.end(), static_cast<size_t>(m.H + 2) * m.channels, 0.0f);
  }
  m.produce(m.producibleUntil(flush), out);
  m.trim();
  if (flush) m.flushed = true;
}

int64_t Resampler::outputFramesFor(int64_t inFrames) const noexcept {
  if (inFrames <= 0) return 0;
  return (inFrames * impl_->L + impl_->M - 1) / impl_->M;
}

int Resampler::halfLengthFrames() const noexcept { return impl_->H; }
int Resampler::tapsPerPhase() const noexcept { return impl_->taps; }
int Resampler::upFactor() const noexcept { return static_cast<int>(impl_->L); }
int Resampler::downFactor() const noexcept { return static_cast<int>(impl_->M); }
bool Resampler::passthrough() const noexcept { return impl_->L == impl_->M; }

void Resampler::reset() { impl_->resetStream(); }

}  // namespace om
