// Shadow decoder pipeline (owner: decoder), portable: run in the
// short-lived "engine-host.js --shadow" process through om_shadow_run(),
// never in the engine process. Streams the native decode to its end
// (counting frames), keeps only the reference window +- (200 ms + margins +
// the resampler's half-length), resamples only that span, then compares
// with Chromium's reference window: coarse cross-correlation on x8
// decimated mono (FFT), full-rate refinement, parabolic sub-sample offset,
// fractional alignment (windowed sinc), RMS / length differences and
// correlation. Also the portable streaming WAV reader (RIFF / RF64 / BW64,
// PCM 8-32 bit, float 32/64, extensible) used by the tests, and the JSON
// text of the report. SPEC.md §7.4.
#include "om/shadow.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <numeric>

#include "om/pcm.h"
#include "om/resampler.h"

namespace om {

const char* decodeErrorName(DecodeError e) noexcept {
  switch (e) {
    case DecodeError::None: return "none";
    case DecodeError::Unsupported: return "unsupported";
    case DecodeError::NotFound: return "notFound";
    case DecodeError::Io: return "io";
    case DecodeError::Cancelled: return "cancelled";
    case DecodeError::OutOfMemory: return "memory";
    case DecodeError::Internal: return "internal";
    case DecodeError::Mismatch: return "mismatch";
  }
  return "internal";
}

namespace {

constexpr double kPi = 3.14159265358979323846;

std::filesystem::path pathFromUtf8(const std::string& s) {
  return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

uint16_t le16(const unsigned char* p) noexcept { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t le32(const unsigned char* p) noexcept {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}
uint64_t le64(const unsigned char* p) noexcept {
  return static_cast<uint64_t>(le32(p)) | (static_cast<uint64_t>(le32(p + 4)) << 32);
}

// ---------------------------------------------------------------------------
// WAV reader
// ---------------------------------------------------------------------------
class WavReader final : public IAudioFileReader {
 public:
  bool open(const std::string& pathUtf8, DecodeError& e, std::string& msg) {
    std::error_code ec;
    const std::filesystem::path p = pathFromUtf8(pathUtf8);
    if (!std::filesystem::exists(p, ec)) return fail(e, msg, DecodeError::NotFound, "file not found");
    if (!std::filesystem::is_regular_file(p, ec)) return fail(e, msg, DecodeError::Io, "not a regular file");
    f_.open(p, std::ios::binary);
    if (!f_) return fail(e, msg, DecodeError::Io, "cannot open the file");
    unsigned char h[12];
    if (!readExact(h, 12)) return fail(e, msg, DecodeError::Unsupported, "not a WAV file");
    const bool riff = std::memcmp(h, "RIFF", 4) == 0;
    const bool rf64 = std::memcmp(h, "RF64", 4) == 0 || std::memcmp(h, "BW64", 4) == 0;
    if ((!riff && !rf64) || std::memcmp(h + 8, "WAVE", 4) != 0)
      return fail(e, msg, DecodeError::Unsupported, "not a WAV file");
    bool fmt = false, haveDs64 = false;
    uint64_t ds64Data = 0;
    for (;;) {
      unsigned char c[8];
      if (!readExact(c, 8))
        return fail(e, msg, fmt ? DecodeError::Io : DecodeError::Unsupported, fmt ? "no data chunk" : "no fmt chunk");
      const uint32_t size = le32(c + 4);
      if (std::memcmp(c, "ds64", 4) == 0) {
        unsigned char d[28] = {};
        const uint32_t n = std::min<uint32_t>(size, 28);
        if (n < 16 || !readExact(d, n)) return fail(e, msg, DecodeError::Io, "bad ds64 chunk");
        ds64Data = le64(d + 8);
        haveDs64 = true;
        if (!skip(static_cast<uint64_t>(size - n) + (size & 1))) return fail(e, msg, DecodeError::Io, "truncated file");
      } else if (std::memcmp(c, "fmt ", 4) == 0) {
        unsigned char d[40] = {};
        const uint32_t n = std::min<uint32_t>(size, 40);
        if (size < 16 || !readExact(d, n)) return fail(e, msg, DecodeError::Io, "bad fmt chunk");
        int tag = le16(d);
        channels_ = le16(d + 2);
        rate_ = static_cast<int>(le32(d + 4));
        block_ = le16(d + 12);
        bits_ = le16(d + 14);
        if (tag == 0xFFFE) {  // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID's first word is the tag
          static const unsigned char kTail[14] = {0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80,
                                                  0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71};
          if (n < 40 || std::memcmp(d + 26, kTail, 14) != 0)
            return fail(e, msg, DecodeError::Unsupported, "unsupported extensible sub-format");
          tag = le16(d + 24);
        }
        tag_ = tag;
        const bool ok = (tag == 1 && (bits_ == 8 || bits_ == 16 || bits_ == 24 || bits_ == 32)) ||
                        (tag == 3 && (bits_ == 32 || bits_ == 64));
        if (!ok) return fail(e, msg, DecodeError::Unsupported, "unsupported sample format");
        if (channels_ < 1 || channels_ > 64 || rate_ < 1000 || rate_ > 1000000 || block_ != channels_ * (bits_ / 8))
          return fail(e, msg, DecodeError::Io, "bad fmt values");
        fmt = true;
        if (!skip(static_cast<uint64_t>(size - n) + (size & 1))) return fail(e, msg, DecodeError::Io, "truncated file");
      } else if (std::memcmp(c, "data", 4) == 0) {
        if (!fmt) return fail(e, msg, DecodeError::Io, "data chunk before the fmt chunk");
        if (rf64 && size == 0xFFFFFFFFu) {
          if (haveDs64) left_ = ds64Data;
          else toEof_ = true;
        } else if (size == 0 || size == 0xFFFFFFFFu) {
          toEof_ = true;  // (written by a streaming recorder: read to the end of the file)
        } else {
          left_ = size;
        }
        return true;  // positioned on the first sample
      } else {
        if (!skip(static_cast<uint64_t>(size) + (size & 1))) return fail(e, msg, DecodeError::Io, "truncated file");
      }
    }
  }

  int sampleRate() const noexcept override { return rate_; }
  int sourceChannels() const noexcept override { return channels_; }
  DecodeError error() const noexcept override { return err_; }
  std::string message() const override { return msg_; }

  int64_t read(float* out, int64_t maxFrames) override {
    if (err_ != DecodeError::None || maxFrames <= 0 || !out) return 0;
    int64_t frames = std::min<int64_t>(maxFrames, 1 << 16);
    if (!toEof_) frames = std::min<int64_t>(frames, static_cast<int64_t>(left_ / static_cast<uint64_t>(block_)));
    if (frames <= 0) return 0;
    const size_t want = static_cast<size_t>(frames) * block_;
    raw_.resize(want);
    f_.read(reinterpret_cast<char*>(raw_.data()), static_cast<std::streamsize>(want));
    const size_t got = static_cast<size_t>(f_.gcount());
    frames = static_cast<int64_t>(got / static_cast<size_t>(block_));
    if (got < want) {
      left_ = 0;  // end of the file (a truncated data chunk keeps what is there)
      toEof_ = false;
    } else if (!toEof_) {
      left_ -= got;
    }
    if (frames <= 0) return 0;
    const size_t n = static_cast<size_t>(frames);
    planar_.resize(n * channels_);
    const int bps = bits_ / 8;
    for (int ch = 0; ch < channels_; ch++) {
      float* dst = planar_.data() + static_cast<size_t>(ch) * n;
      const unsigned char* src = raw_.data() + static_cast<size_t>(ch) * bps;
      const size_t stride = static_cast<size_t>(block_);
      if (tag_ == 3 && bits_ == 32) {
        for (size_t i = 0; i < n; i++) std::memcpy(&dst[i], src + i * stride, 4);
      } else if (tag_ == 3) {
        for (size_t i = 0; i < n; i++) {
          double v;
          std::memcpy(&v, src + i * stride, 8);
          dst[i] = static_cast<float>(v);
        }
      } else if (bits_ == 16) {
        for (size_t i = 0; i < n; i++) dst[i] = static_cast<int16_t>(le16(src + i * stride)) * (1.0f / 32768.0f);
      } else if (bits_ == 24) {
        for (size_t i = 0; i < n; i++) {
          const unsigned char* p = src + i * stride;
          const int32_t v = static_cast<int32_t>((static_cast<uint32_t>(p[0]) << 8) | (static_cast<uint32_t>(p[1]) << 16) |
                                                 (static_cast<uint32_t>(p[2]) << 24)) >> 8;
          dst[i] = static_cast<float>(v) * (1.0f / 8388608.0f);
        }
      } else if (bits_ == 32) {
        for (size_t i = 0; i < n; i++)
          dst[i] = static_cast<float>(static_cast<int32_t>(le32(src + i * stride))) * (1.0f / 2147483648.0f);
      } else {  // 8-bit unsigned
        for (size_t i = 0; i < n; i++) dst[i] = (static_cast<int>(src[i * stride]) - 128) * (1.0f / 128.0f);
      }
    }
    l_.resize(n);
    r_.resize(n);
    downmixToStereo(planar_.data(), channels_, frames, l_.data(), r_.data());
    for (size_t i = 0; i < n; i++) {
      out[2 * i] = l_[i];
      out[2 * i + 1] = r_[i];
    }
    return frames;
  }

 private:
  static bool fail(DecodeError& e, std::string& m, DecodeError what, const char* why) {
    e = what;
    m = why;
    return false;
  }
  bool readExact(unsigned char* p, size_t n) {
    f_.read(reinterpret_cast<char*>(p), static_cast<std::streamsize>(n));
    return static_cast<size_t>(f_.gcount()) == n;
  }
  bool skip(uint64_t n) {
    if (!n) return true;
    f_.seekg(static_cast<std::streamoff>(n), std::ios::cur);
    return static_cast<bool>(f_);
  }

  std::ifstream f_;
  int rate_ = 0, channels_ = 0, bits_ = 0, tag_ = 0, block_ = 0;
  bool toEof_ = false;
  uint64_t left_ = 0;
  std::vector<unsigned char> raw_;
  std::vector<float> planar_, l_, r_;
  DecodeError err_ = DecodeError::None;
  std::string msg_;
};

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------
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

// In-place iterative radix-2 FFT (size: a power of two).
void fft(std::vector<std::complex<double>>& a, bool inverse) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    const double ang = 2 * kPi / static_cast<double>(len) * (inverse ? 1 : -1);
    const std::complex<double> wl(std::cos(ang), std::sin(ang));
    const size_t half = len / 2;
    // twiddles of this stage computed once (recurrence restarted every 64 steps for accuracy)
    std::vector<std::complex<double>> w(half);
    for (size_t k = 0; k < half; k++) {
      if (k % 64 == 0) {
        const double t = ang * static_cast<double>(k);
        w[k] = std::complex<double>(std::cos(t), std::sin(t));
      } else {
        w[k] = w[k - 1] * wl;
      }
    }
    for (size_t i = 0; i < n; i += len) {
      for (size_t k = 0; k < half; k++) {
        const std::complex<double> u = a[i + k];
        const std::complex<double> v = a[i + k + half] * w[k];
        a[i + k] = u + v;
        a[i + k + half] = u - v;
      }
    }
  }
  if (inverse) {
    const double s = 1.0 / static_cast<double>(n);
    for (auto& x : a) x *= s;
  }
}

constexpr int kDecim = 8;
constexpr int kDecimHalf = 32;  // anti-alias FIR half-length (full-rate samples)

std::vector<double> decimationFilter() {
  std::vector<double> h(2 * kDecimHalf + 1);
  const double fc = 0.45 / kDecim;  // cycles per full-rate sample (decimated Nyquist = 0.5 / 8)
  const double beta = 8.0, i0b = besselI0(beta);
  double sum = 0;
  for (int t = -kDecimHalf; t <= kDecimHalf; t++) {
    const double x = static_cast<double>(t) / (kDecimHalf + 1);
    const double w = besselI0(beta * std::sqrt(1.0 - x * x)) / i0b;
    const double a = 2 * fc * t;
    const double s = t == 0 ? 1.0 : std::sin(kPi * a) / (kPi * a);
    h[static_cast<size_t>(t + kDecimHalf)] = 2 * fc * s * w;
    sum += h[static_cast<size_t>(t + kDecimHalf)];
  }
  for (double& v : h) v /= sum;
  return h;
}

// Normalized correlation of ref[ws, ws + W) with sig shifted by `lag`
// (sig outside [0, sigFrames) = 0); er = energy of the ref window.
double corrAt(const float* ref, const float* sig, int64_t sigFrames, int64_t ws, int64_t W, int64_t lag, double er) {
  const int64_t k0 = std::max<int64_t>(ws, -lag);
  const int64_t k1 = std::min<int64_t>(ws + W, sigFrames - lag);
  double dot = 0, es = 0;
  for (int64_t k = k0; k < k1; k++) {
    const double s = sig[k + lag];
    dot += static_cast<double>(ref[k]) * s;
    es += s * s;
  }
  if (es <= 0 || er <= 0) return 0;
  return dot / std::sqrt(er * es);
}

// Coarse lag (full-rate frames, a multiple of 8) by FFT cross-correlation of
// x8 decimated signals.
int64_t coarseLag(const float* ref, const float* sig, int64_t sigFrames, int64_t ws, int64_t W, int64_t maxLag) {
  const std::vector<double> h = decimationFilter();
  const int64_t Wd = W / kDecim;
  const int64_t Ldw = (maxLag + kDecim - 1) / kDecim;  // searched decimated lags
  const int64_t Ld = Ldw + 2;
  const int64_t Sd = Wd + 2 * Ld;
  auto refAt = [&](int64_t i) -> double { return (i >= ws && i < ws + W) ? ref[i] : 0.0; };
  auto sigAt = [&](int64_t i) -> double { return (i >= 0 && i < sigFrames) ? sig[i] : 0.0; };
  std::vector<double> r(static_cast<size_t>(Wd)), s(static_cast<size_t>(Sd));
  for (int64_t m = 0; m < Wd; m++) {
    const int64_t c = ws + kDecim * m;
    double acc = 0;
    for (int t = -kDecimHalf; t <= kDecimHalf; t++) acc += h[static_cast<size_t>(t + kDecimHalf)] * refAt(c + t);
    r[static_cast<size_t>(m)] = acc;
  }
  for (int64_t m = 0; m < Sd; m++) {
    const int64_t c = ws + kDecim * (m - Ld);
    double acc = 0;
    if (c - kDecimHalf >= 0 && c + kDecimHalf < sigFrames) {
      const float* p = sig + c;
      for (int t = -kDecimHalf; t <= kDecimHalf; t++) acc += h[static_cast<size_t>(t + kDecimHalf)] * p[t];
    } else {
      for (int t = -kDecimHalf; t <= kDecimHalf; t++) acc += h[static_cast<size_t>(t + kDecimHalf)] * sigAt(c + t);
    }
    s[static_cast<size_t>(m)] = acc;
  }
  size_t N = 1;
  while (N < static_cast<size_t>(Wd + Sd)) N <<= 1;
  std::vector<std::complex<double>> A(N), B(N);
  for (int64_t m = 0; m < Wd; m++) A[static_cast<size_t>(m)] = r[static_cast<size_t>(m)];
  for (int64_t m = 0; m < Sd; m++) B[static_cast<size_t>(m)] = s[static_cast<size_t>(m)];
  fft(A, false);
  fft(B, false);
  for (size_t i = 0; i < N; i++) A[i] = std::conj(A[i]) * B[i];
  fft(A, true);  // A[j] = sum_m r[m] s[m + j]
  std::vector<double> prefix(static_cast<size_t>(Sd) + 1, 0.0);
  for (int64_t m = 0; m < Sd; m++) prefix[static_cast<size_t>(m + 1)] = prefix[static_cast<size_t>(m)] + s[static_cast<size_t>(m)] * s[static_cast<size_t>(m)];
  double er = 0;
  for (double v : r) er += v * v;
  int64_t best = 0;
  double bestC = -2;
  for (int64_t lag = -Ldw; lag <= Ldw; lag++) {
    const int64_t j = lag + Ld;
    const double es = prefix[static_cast<size_t>(j + Wd)] - prefix[static_cast<size_t>(j)];
    if (es <= 0 || er <= 0) continue;
    const double c = A[static_cast<size_t>(j)].real() / std::sqrt(er * es);
    if (c > bestC) {
      bestC = c;
      best = lag;
    }
  }
  return best * kDecim;
}

// sig sampled at positions start + k (k = 0..n-1), start fractional: Kaiser
// windowed sinc (64 taps), exact copy for an integer start.
void shiftFractional(const float* sig, int64_t sigFrames, double start, int64_t n, std::vector<float>& out) {
  out.assign(static_cast<size_t>(n), 0.0f);
  const double fl = std::floor(start);
  const int64_t i0 = static_cast<int64_t>(fl);
  const double frac = start - fl;
  auto at = [&](int64_t i) -> double { return (i >= 0 && i < sigFrames) ? sig[i] : 0.0; };
  if (frac < 1e-12) {
    for (int64_t k = 0; k < n; k++) out[static_cast<size_t>(k)] = static_cast<float>(at(i0 + k));
    return;
  }
  constexpr int kHalf = 32;
  double w[2 * kHalf];
  const double beta = 9.0, i0b = besselI0(beta);
  double sum = 0;
  for (int j = -kHalf + 1; j <= kHalf; j++) {  // taps i0 + j, distance j - frac in (-32, 32)
    const double t = static_cast<double>(j) - frac;
    const double x = t / (kHalf + 0.5);
    const double win = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - x * x))) / i0b;
    const double s = std::sin(kPi * t) / (kPi * t);
    w[j + kHalf - 1] = s * win;
    sum += w[j + kHalf - 1];
  }
  for (double& v : w) v /= sum;
  for (int64_t k = 0; k < n; k++) {
    const int64_t c = i0 + k;
    double acc = 0;
    if (c - kHalf + 1 >= 0 && c + kHalf < sigFrames) {
      const float* p = sig + c;
      for (int j = -kHalf + 1; j <= kHalf; j++) acc += w[j + kHalf - 1] * p[j];
    } else {
      for (int j = -kHalf + 1; j <= kHalf; j++) acc += w[j + kHalf - 1] * at(c + j);
    }
    out[static_cast<size_t>(k)] = static_cast<float>(acc);
  }
}

int64_t floorDiv(int64_t a, int64_t b) noexcept {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}

void appendNum(std::string& s, const char* key, double v) {
  s += '"';
  s += key;
  s += "\":";
  if (!std::isfinite(v)) {
    s += "null";
    return;
  }
  char b[40];
  std::snprintf(b, sizeof b, "%.17g", v);
  s += b;
}

void appendStr(std::string& s, const char* key, const std::string& v) {
  s += '"';
  s += key;
  s += "\":\"";
  for (unsigned char c : v) {
    switch (c) {
      case '"': s += "\\\""; break;
      case '\\': s += "\\\\"; break;
      case '\n': s += "\\n"; break;
      case '\r': s += "\\r"; break;
      case '\t': s += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          std::snprintf(b, sizeof b, "\\u%04x", c);
          s += b;
        } else {
          s += static_cast<char>(c);
        }
    }
  }
  s += '"';
}

}  // namespace

std::unique_ptr<IAudioFileReader> openWavReader(const std::string& pathUtf8, DecodeError* err, std::string* message) {
  auto r = std::make_unique<WavReader>();
  DecodeError e = DecodeError::None;
  std::string m;
  bool ok = false;
  try {
    ok = r->open(pathUtf8, e, m);
  } catch (...) {
    e = DecodeError::Io;
    m = "cannot read the file";
  }
  if (err) *err = ok ? DecodeError::None : e;
  if (message) *message = ok ? std::string() : m;
  if (!ok) return nullptr;
  return r;
}

std::string shadowReportJson(const ShadowReport& r) {
  std::string s = "{";
  appendNum(s, "loadId", r.loadId);
  s += ",\"ok\":";
  s += r.ok ? "true" : "false";
  if (!r.ok) {
    s += ',';
    appendStr(s, "error", r.message.empty() ? std::string(decodeErrorName(r.error)) : r.message);
    s += ',';
    appendStr(s, "code", decodeErrorName(r.error));
  }
  const struct {
    const char* k;
    double v;
  } nums[] = {{"offsetMs", r.offsetMs},       {"lengthDiffMs", r.lengthDiffMs},
              {"rmsDiffDb", r.rmsDiffDb},     {"correlation", r.correlation},
              {"fileRate", static_cast<double>(r.fileRate)},
              {"fileChannels", static_cast<double>(r.fileChannels)},
              {"decodeMs", r.decodeMs},       {"lagFrames", r.lagFrames},
              {"nativeFrames", static_cast<double>(r.nativeFrames)},
              {"keptFrames", static_cast<double>(r.keptFrames)}};
  for (const auto& n : nums) {
    s += ',';
    appendNum(s, n.k, n.v);
  }
  s += '}';
  return s;
}

double findOffsetFrames(const float* refMono, int64_t refFrames, const float* sigMono, int64_t sigFrames,
                        int64_t windowStart, int64_t windowFrames, int64_t maxLag, double* correlation) {
  if (correlation) *correlation = 0;
  if (!refMono || !sigMono || windowFrames <= 0 || windowStart < 0 || windowStart + windowFrames > refFrames ||
      maxLag < 0 || sigFrames <= 0)
    return 0;
  const int64_t ws = windowStart, W = windowFrames;
  double er = 0;
  for (int64_t k = ws; k < ws + W; k++) er += static_cast<double>(refMono[k]) * refMono[k];
  if (er <= 0) return 0;
  int64_t lo = -maxLag, hi = maxLag;
  if (maxLag > 32 && W >= 64 * kDecim) {
    const int64_t c = coarseLag(refMono, sigMono, sigFrames, ws, W, maxLag);
    lo = std::max<int64_t>(-maxLag, c - 16);
    hi = std::min<int64_t>(maxLag, c + 16);
  }
  std::vector<double> cs(static_cast<size_t>(hi - lo + 1));
  int64_t best = lo;
  for (int64_t lag = lo; lag <= hi; lag++) {
    cs[static_cast<size_t>(lag - lo)] = corrAt(refMono, sigMono, sigFrames, ws, W, lag, er);
    if (cs[static_cast<size_t>(lag - lo)] > cs[static_cast<size_t>(best - lo)]) best = lag;
  }
  auto corrOf = [&](int64_t lag) {
    return (lag >= lo && lag <= hi) ? cs[static_cast<size_t>(lag - lo)]
                                    : corrAt(refMono, sigMono, sigFrames, ws, W, lag, er);
  };
  const double y1 = cs[static_cast<size_t>(best - lo)];
  if (correlation) *correlation = y1;
  if (best - 1 < -maxLag || best + 1 > maxLag) return static_cast<double>(best);
  const double y0 = corrOf(best - 1), y2 = corrOf(best + 1);
  const double den = y0 - 2 * y1 + y2;
  double delta = den < 0 ? 0.5 * (y0 - y2) / den : 0.0;
  delta = std::clamp(delta, -0.5, 0.5);
  return static_cast<double>(best) + delta;
}

ShadowReport compareWindow(const ShadowJob& job, const float* nativeMono, int64_t nativeFrames, int64_t nativeStart,
                           int64_t nativeTotalFrames, double maxOffsetMs) {
  ShadowReport rep;
  rep.loadId = job.loadId;
  auto fail = [&](DecodeError e, const char* m) {
    rep.ok = false;
    rep.error = e;
    rep.message = m;
    return rep;
  };
  const int64_t W = static_cast<int64_t>(job.left.size());
  if (job.refRate <= 0 || W <= 0 || job.right.size() != job.left.size() || !nativeMono || nativeFrames < 0)
    return fail(DecodeError::Internal, "bad comparison input");
  const double rate = job.refRate;
  rep.lengthDiffMs = static_cast<double>(nativeTotalFrames - job.refFrames) / rate * 1000.0;
  std::vector<float> ref(static_cast<size_t>(W));
  double er = 0;
  for (int64_t k = 0; k < W; k++) {
    const float v = 0.5f * (job.left[static_cast<size_t>(k)] + job.right[static_cast<size_t>(k)]);
    ref[static_cast<size_t>(k)] = v;
    er += static_cast<double>(v) * v;
  }
  if (!(er > 0)) return fail(DecodeError::Mismatch, "silent reference window");
  const int64_t maxLag = std::max<int64_t>(1, std::llround(maxOffsetMs * rate / 1000.0));
  const int64_t pad = maxLag + 64;
  const int64_t P = W + 2 * pad;
  // one shared timeline: index 0 = reference frame windowStart - pad
  std::vector<float> refP(static_cast<size_t>(P), 0.0f), sigP(static_cast<size_t>(P), 0.0f);
  std::copy(ref.begin(), ref.end(), refP.begin() + pad);
  const int64_t first = job.windowStart - pad - nativeStart;  // native index of timeline index 0
  for (int64_t k = 0; k < P; k++) {
    const int64_t i = first + k;
    if (i >= 0 && i < nativeFrames) sigP[static_cast<size_t>(k)] = nativeMono[i];
  }
  double c0 = 0;
  const double lag = findOffsetFrames(refP.data(), P, sigP.data(), P, pad, W, maxLag, &c0);
  rep.lagFrames = lag;
  rep.offsetMs = lag / rate * 1000.0;
  std::vector<float> nat;
  shiftFractional(sigP.data(), P, static_cast<double>(pad) + lag, W, nat);
  double dd = 0, en = 0, dot = 0;
  for (int64_t k = 0; k < W; k++) {
    const double a = nat[static_cast<size_t>(k)], b = ref[static_cast<size_t>(k)];
    dd += (a - b) * (a - b);
    en += a * a;
    dot += a * b;
  }
  rep.rmsDiffDb = dd > 0 ? 10.0 * std::log10(dd / er) : -400.0;
  rep.correlation = (en > 0) ? dot / std::sqrt(en * er) : 0.0;
  if (std::fabs(lag) >= static_cast<double>(maxLag) - 1.0) return fail(DecodeError::Mismatch, "offset beyond the search range");
  if (rep.correlation < 0.5) return fail(DecodeError::Mismatch, "low correlation: not the same audio");
  rep.ok = true;
  return rep;
}

ShadowReport runShadowJob(const ShadowJob& job, IAudioFileReader& reader, const std::atomic<bool>* cancel,
                          double maxOffsetMs) {
  const auto t0 = std::chrono::steady_clock::now();
  ShadowReport rep;
  rep.loadId = job.loadId;
  auto finish = [&](ShadowReport r) {
    r.loadId = job.loadId;
    r.decodeMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return r;
  };
  auto fail = [&](DecodeError e, const std::string& m) {
    rep.ok = false;
    rep.error = e;
    rep.message = m;
    return finish(rep);
  };
  const int64_t W = static_cast<int64_t>(job.left.size());
  if (job.refRate < kPcmMinRate || job.refRate > kPcmMaxRate || W <= 0 || job.right.size() != job.left.size() ||
      job.windowStart < 0)
    return fail(DecodeError::Internal, "bad job");
  const int fileRate = reader.sampleRate();
  rep.fileRate = fileRate;
  rep.fileChannels = reader.sourceChannels();
  if (fileRate <= 0) return fail(DecodeError::Unsupported, "unknown sample rate");
  try {
    Resampler rs(fileRate, job.refRate, 1);
    const int64_t H = rs.halfLengthFrames();
    const int64_t maxLag = std::max<int64_t>(1, std::llround(maxOffsetMs * job.refRate / 1000.0));
    const int64_t pad = maxLag + 64;  // fine search, sub-sample shift and margins
    // The reference span to rebuild, mapped to file frames on the rational
    // grid (fs0 = a multiple of fileRate/g maps to an integer reference frame).
    const int64_t g = std::gcd(static_cast<int64_t>(fileRate), static_cast<int64_t>(job.refRate));
    const int64_t fStep = fileRate / g, rStep = job.refRate / g;
    const int64_t refA = job.windowStart - pad, refB = job.windowStart + W + pad;
    int64_t fs0 = floorDiv(refA * fileRate, job.refRate) - H - 2;
    fs0 = floorDiv(fs0, fStep) * fStep;
    const int64_t fs1 = floorDiv(refB * fileRate + job.refRate - 1, job.refRate) + H + 2;
    const int64_t nativeStartRef = fs0 / fStep * rStep;
    const int64_t keep = fs1 - fs0;
    std::vector<float> kept(static_cast<size_t>(keep), 0.0f);
    rep.keptFrames = keep;
    // Stream the whole file: count every frame, keep only the span.
    constexpr int64_t kBlock = 16384;
    std::vector<float> buf(static_cast<size_t>(kBlock) * 2);
    int64_t pos = 0;
    for (;;) {
      if (cancel && cancel->load(std::memory_order_relaxed)) return fail(DecodeError::Cancelled, "cancelled");
      const int64_t n = reader.read(buf.data(), kBlock);
      if (n <= 0) break;
      const int64_t a = std::max<int64_t>(pos, fs0), b = std::min<int64_t>(pos + n, fs1);
      for (int64_t i = a; i < b; i++) {
        const size_t j = static_cast<size_t>(i - pos) * 2;
        kept[static_cast<size_t>(i - fs0)] = 0.5f * (buf[j] + buf[j + 1]);
      }
      pos += n;
    }
    if (reader.error() != DecodeError::None) {
      const std::string m = reader.message();
      return fail(reader.error(), m.empty() ? "decode error" : m);
    }
    rep.nativeFrames = pos;
    if (pos == 0) return fail(DecodeError::Io, "no audio decoded");
    // Resample only the span (output frame j = reference frame nativeStartRef + j).
    std::vector<float> native;
    native.reserve(static_cast<size_t>(rs.outputFramesFor(keep)) + 16);
    rs.process(kept.data(), keep, native, true);
    kept.clear();
    kept.shrink_to_fit();
    const int64_t totalRef = std::llround(static_cast<double>(pos) * job.refRate / fileRate);
    ShadowReport cmp = compareWindow(job, native.data(), static_cast<int64_t>(native.size()), nativeStartRef, totalRef,
                                     maxOffsetMs);
    cmp.fileRate = rep.fileRate;
    cmp.fileChannels = rep.fileChannels;
    cmp.nativeFrames = rep.nativeFrames;
    cmp.keptFrames = rep.keptFrames;
    cmp.lengthDiffMs =
        (static_cast<double>(pos) / fileRate - static_cast<double>(job.refFrames) / job.refRate) * 1000.0;
    return finish(cmp);
  } catch (const std::bad_alloc&) {
    return fail(DecodeError::OutOfMemory, "out of memory");
  } catch (...) {
    return fail(DecodeError::Internal, "shadow job failed");
  }
}

}  // namespace om
