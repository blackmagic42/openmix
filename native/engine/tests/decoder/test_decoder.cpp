// Tests of the decoder module (owner: decoder): the PCM handoff store
// (float32 planar chunks, readiness, per-track and per-chunk headroom,
// users, epochs, deferred frees, limits, garbage collection, concurrent
// writers), the conversions (fold to stereo, the SPEC §7.3 TPDF int16
// algorithm on published vectors, arrival-order independence), the WAV and
// Media Foundation readers on files generated into a temp folder, the
// polyphase resampler (impulse, ripple, stopband, half-length), the offset
// finder and the whole shadow job (incl. the om_shadow_run JSON report).
// Silent: offline buffers and temp files only. SPEC.md §7, §18.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "om/json.h"
#include "om/pcm.h"
#include "om/resampler.h"
#include "om/rt.h"
#include "om/shadow.h"

using namespace om;

namespace {
constexpr double kPiD = 3.14159265358979323846;

PcmDesc desc(uint32_t id, int64_t frames, float headroom = 1.0f, PcmFormat fmt = PcmFormat::S16) {
  PcmDesc d;
  d.loadId = id;
  d.sampleRate = 48000;
  d.frames = frames;
  d.headroom = headroom;
  d.format = fmt;
  return d;
}
std::vector<float> planar(int frames, float l, float r) {
  std::vector<float> v(static_cast<size_t>(frames) * 2, l);
  for (int i = 0; i < frames; i++) v[static_cast<size_t>(frames + i)] = r;
  return v;
}

// A deterministic "music-like" signal, analytic so that any fractional
// shift is exact: partials with slow amplitude envelopes, a few percussive
// bursts (decaying noise-like partial clusters) and a bass line.
struct MusicSignal {
  struct Partial {
    double f, a, ph, envF, envPh;
  };
  std::vector<Partial> p;
  double bursts = 2.1;  // per second
  explicit MusicSignal(uint32_t seed, int partials = 48) {
    std::mt19937 g(seed);
    std::uniform_real_distribution<double> u(0.0, 1.0);
    for (int i = 0; i < partials; i++) {
      Partial q;
      q.f = 40.0 * std::pow(300.0, u(g));  // 40 Hz .. 12 kHz, log-uniform
      q.a = 0.5 / partials * (1.0 + 2.0 * u(g)) * (q.f < 300 ? 3.0 : 1.0);
      q.ph = 2 * kPiD * u(g);
      q.envF = 0.1 + 3.0 * u(g);
      q.envPh = 2 * kPiD * u(g);
      p.push_back(q);
    }
  }
  double at(double t) const {
    double s = 0;
    for (const Partial& q : p) {
      const double env = 0.6 + 0.4 * std::sin(2 * kPiD * q.envF * t + q.envPh);
      s += q.a * env * std::sin(2 * kPiD * q.f * t + q.ph);
    }
    // percussive envelope on a high partial: a smooth periodic bump (band-limited)
    const double hit = std::pow(0.5 + 0.5 * std::cos(2 * kPiD * bursts * t), 6);
    s += 0.15 * hit * std::sin(2 * kPiD * 5100.0 * t) * std::sin(2 * kPiD * 77.0 * t + 1.0);
    return s;
  }
  // samples at rate, starting at time t0, shifted later by `delayFrames` (frames of this rate)
  std::vector<float> render(int rate, int64_t frames, double delayFrames = 0.0, double t0 = 0.0) const {
    std::vector<float> v(static_cast<size_t>(frames));
    for (int64_t i = 0; i < frames; i++) v[static_cast<size_t>(i)] = static_cast<float>(at(t0 + (i - delayFrames) / rate));
    return v;
  }
};

// ---- temp folder and WAV writers ----
std::filesystem::path tempDir() {
  static const std::filesystem::path dir =
      std::filesystem::temp_directory_path() /
      ("om_decoder_tests_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count() % 1000000007));
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);  // (again after a test's cleanup)
  return dir;
}
struct TempCleanup {
  ~TempCleanup() {
    std::error_code ec;
    std::filesystem::remove_all(tempDir(), ec);
  }
};
std::string u8(const std::filesystem::path& p) {
  const std::u8string s = p.u8string();
  return std::string(s.begin(), s.end());
}

void put16(std::vector<unsigned char>& b, uint32_t v) {
  b.push_back(static_cast<unsigned char>(v));
  b.push_back(static_cast<unsigned char>(v >> 8));
}
void put32(std::vector<unsigned char>& b, uint32_t v) {
  put16(b, v & 0xFFFF);
  put16(b, v >> 16);
}
void put64(std::vector<unsigned char>& b, uint64_t v) {
  put32(b, static_cast<uint32_t>(v));
  put32(b, static_cast<uint32_t>(v >> 32));
}
void putId(std::vector<unsigned char>& b, const char* id) { b.insert(b.end(), id, id + 4); }

enum class WavKind { Pcm8, Pcm16, Pcm24, Pcm32, Float32, Float64 };
struct WavSpec {
  WavKind kind = WavKind::Pcm16;
  int rate = 48000;
  int channels = 2;
  bool rf64 = false;
  bool extensible = false;
  bool junkChunk = true;  // an unknown chunk before "data" (readers must skip it)
};
int bitsOf(WavKind k) {
  switch (k) {
    case WavKind::Pcm8: return 8;
    case WavKind::Pcm16: return 16;
    case WavKind::Pcm24: return 24;
    case WavKind::Pcm32: return 32;
    case WavKind::Float32: return 32;
    case WavKind::Float64: return 64;
  }
  return 16;
}
// Quantizes the samples to the file format and returns what a reader must
// give back (the decoded float values).
std::vector<float> writeWav(const std::filesystem::path& path, const WavSpec& s, const std::vector<float>& interleaved) {
  const int bits = bitsOf(s.kind);
  const int bps = bits / 8;
  const size_t n = interleaved.size();
  std::vector<unsigned char> data;
  data.reserve(n * bps);
  std::vector<float> decoded(n);
  for (size_t i = 0; i < n; i++) {
    const double v = std::clamp<double>(interleaved[i], -1.0, 1.0);
    switch (s.kind) {
      case WavKind::Pcm8: {
        const int q = std::clamp(static_cast<int>(std::lround(v * 127.0)) + 128, 0, 255);
        data.push_back(static_cast<unsigned char>(q));
        decoded[i] = (q - 128) / 128.0f;
        break;
      }
      case WavKind::Pcm16: {
        const int q = std::clamp(static_cast<int>(std::lround(v * 32767.0)), -32768, 32767);
        put16(data, static_cast<uint16_t>(q));
        decoded[i] = static_cast<float>(q) / 32768.0f;
        break;
      }
      case WavKind::Pcm24: {
        const int q = std::clamp(static_cast<int>(std::lround(v * 8388607.0)), -8388608, 8388607);
        const uint32_t u = static_cast<uint32_t>(q);
        data.push_back(static_cast<unsigned char>(u));
        data.push_back(static_cast<unsigned char>(u >> 8));
        data.push_back(static_cast<unsigned char>(u >> 16));
        decoded[i] = static_cast<float>(q) / 8388608.0f;
        break;
      }
      case WavKind::Pcm32: {
        const int64_t q = std::clamp<int64_t>(std::llround(v * 2147483647.0), -2147483648LL, 2147483647LL);
        put32(data, static_cast<uint32_t>(static_cast<int32_t>(q)));
        decoded[i] = static_cast<float>(static_cast<double>(q) / 2147483648.0);
        break;
      }
      case WavKind::Float32: {
        const float f = static_cast<float>(interleaved[i]);
        uint32_t u;
        std::memcpy(&u, &f, 4);
        put32(data, u);
        decoded[i] = f;
        break;
      }
      case WavKind::Float64: {
        const double d = interleaved[i];
        uint64_t u;
        std::memcpy(&u, &d, 8);
        put64(data, u);
        decoded[i] = static_cast<float>(d);
        break;
      }
    }
  }
  const bool isFloat = s.kind == WavKind::Float32 || s.kind == WavKind::Float64;
  std::vector<unsigned char> fmt;
  const int tag = s.extensible ? 0xFFFE : (isFloat ? 3 : 1);
  put16(fmt, static_cast<uint16_t>(tag));
  put16(fmt, static_cast<uint16_t>(s.channels));
  put32(fmt, static_cast<uint32_t>(s.rate));
  put32(fmt, static_cast<uint32_t>(s.rate * s.channels * bps));
  put16(fmt, static_cast<uint16_t>(s.channels * bps));
  put16(fmt, static_cast<uint16_t>(bits));
  if (s.extensible) {
    put16(fmt, 22);
    put16(fmt, static_cast<uint16_t>(bits));
    const uint32_t mask = s.channels == 1 ? 0x4 : s.channels == 2 ? 0x3 : s.channels == 4 ? 0x33 : s.channels == 6 ? 0x3F : 0;
    put32(fmt, mask);
    put16(fmt, isFloat ? 3 : 1);
    const unsigned char tail[14] = {0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71};
    fmt.insert(fmt.end(), tail, tail + 14);
  }
  std::vector<unsigned char> f;
  putId(f, s.rf64 ? "RF64" : "RIFF");
  put32(f, 0);  // patched below
  putId(f, "WAVE");
  if (s.rf64) {
    putId(f, "ds64");
    put32(f, 28);
    put64(f, 0);  // riff size, patched below
    put64(f, data.size());
    put64(f, n / static_cast<size_t>(s.channels));
    put32(f, 0);
  }
  putId(f, "fmt ");
  put32(f, static_cast<uint32_t>(fmt.size()));
  f.insert(f.end(), fmt.begin(), fmt.end());
  if (s.junkChunk) {
    putId(f, "LIST");
    put32(f, 5);  // odd size: the pad byte must be skipped
    const unsigned char junk[6] = {'I', 'N', 'F', 'O', 'x', 0};
    f.insert(f.end(), junk, junk + 6);
  }
  putId(f, "data");
  put32(f, s.rf64 ? 0xFFFFFFFFu : static_cast<uint32_t>(data.size()));
  f.insert(f.end(), data.begin(), data.end());
  if (data.size() & 1) f.push_back(0);
  if (s.rf64) {
    f[4] = f[5] = f[6] = f[7] = 0xFF;
    const uint64_t riff = f.size() - 8;
    for (int i = 0; i < 8; i++) f[20 + i] = static_cast<unsigned char>(riff >> (8 * i));
  } else {
    const uint32_t riff = static_cast<uint32_t>(f.size() - 8);
    for (int i = 0; i < 4; i++) f[4 + i] = static_cast<unsigned char>(riff >> (8 * i));
  }
  std::ofstream o(path, std::ios::binary);
  o.write(reinterpret_cast<const char*>(f.data()), static_cast<std::streamsize>(f.size()));
  return decoded;
}

// Expected stereo output of a reader for decoded source samples (fold rules).
std::vector<float> expectStereo(const std::vector<float>& decoded, int channels) {
  const size_t frames = decoded.size() / static_cast<size_t>(channels);
  std::vector<float> pl(decoded.size());
  for (size_t i = 0; i < frames; i++)
    for (int c = 0; c < channels; c++) pl[static_cast<size_t>(c) * frames + i] = decoded[i * channels + c];
  std::vector<float> l(frames), r(frames), out(frames * 2);
  downmixToStereo(pl.data(), channels, static_cast<int64_t>(frames), l.data(), r.data());
  for (size_t i = 0; i < frames; i++) {
    out[2 * i] = l[i];
    out[2 * i + 1] = r[i];
  }
  return out;
}

// Reads a whole file through a reader in odd-sized blocks.
std::vector<float> readAll(IAudioFileReader& r, int64_t block = 1111) {
  std::vector<float> all, buf(static_cast<size_t>(block) * 2);
  for (;;) {
    const int64_t n = r.read(buf.data(), block);
    if (n <= 0) break;
    all.insert(all.end(), buf.begin(), buf.begin() + n * 2);
  }
  return all;
}

// Amplitude of a sinusoid of frequency f (cycles per sample) in x[a, b):
// DFT at f under a 4-term Blackman-Harris window (sidelobes < -92 dB and
// fast decay, so a strong tone elsewhere does not leak into the estimate).
double toneAmplitude(const std::vector<float>& x, size_t a, size_t b, double f) {
  const size_t n = b - a;
  double re = 0, im = 0, wsum = 0;
  for (size_t i = 0; i < n; i++) {
    const double t = 2 * kPiD * static_cast<double>(i) / static_cast<double>(n - 1);
    const double w = 0.35875 - 0.48829 * std::cos(t) + 0.14128 * std::cos(2 * t) - 0.01168 * std::cos(3 * t);
    const double ph = 2 * kPiD * f * static_cast<double>(a + i);
    re += w * x[a + i] * std::cos(ph);
    im -= w * x[a + i] * std::sin(ph);
    wsum += w;
  }
  return 2.0 * std::sqrt(re * re + im * im) / wsum;
}

std::vector<float> resampleAll(int inRate, int outRate, const std::vector<float>& in, int channels = 1) {
  Resampler rs(inRate, outRate, channels);
  std::vector<float> out;
  rs.process(in.data(), static_cast<int64_t>(in.size()) / channels, out, true);
  return out;
}
}  // namespace

// ===========================================================================
// PCM store
// ===========================================================================
OM_TEST(pcm_store_chunk_protocol) {
  PcmStore store;
  const int full = static_cast<int>(TrackBuffer::kChunkFrames);
  const int64_t frames = TrackBuffer::kChunkFrames + 10;
  OM_CHECK(store.begin(desc(5, frames)) == PcmError::None);
  OM_CHECK(store.begin(desc(5, frames)) == PcmError::Exists);
  OM_CHECK(store.begin(desc(0, frames)) == PcmError::Invalid);
  OM_CHECK(store.begin(desc(6, frames, 0.5f)) == PcmError::Invalid);  // headroom 0 or >= 1
  std::vector<float> a = planar(full, 0.5f, 0.25f);
  std::vector<float> b = planar(10, -1.0f, -1.0f);
  OM_CHECK(store.write(5, 1, full, 2, a.data()) == PcmError::Range);           // misaligned
  OM_CHECK(store.write(5, 0, full - 1, 2, a.data()) == PcmError::Range);       // short chunk
  OM_CHECK(store.write(5, 0, full, 9, a.data()) == PcmError::Range);           // 9 channels
  OM_CHECK(store.write(5, TrackBuffer::kChunkFrames, 10, 2, b.data()) == PcmError::None);  // any order
  OM_CHECK(store.end(5) == PcmError::Incomplete);
  std::shared_ptr<const TrackBuffer> tb = store.peek(5);
  OM_CHECK(tb != nullptr);
  float l = 1, r = 1;
  tb->frameChecked(0, l, r);  // chunk 0 not received yet: silence
  OM_CHECK(l == 0.0f && r == 0.0f);
  OM_CHECK(store.write(5, 0, full, 2, a.data()) == PcmError::None);
  OM_CHECK(store.write(5, 0, full, 2, a.data()) == PcmError::Duplicate);
  OM_CHECK(store.end(5) == PcmError::None);
  tb->frameChecked(0, l, r);
  OM_CHECK_NEAR(l, 0.5, 2.0 / 32767);  // int16 + TPDF dither: within 1 LSB (plus rounding)
  OM_CHECK_NEAR(r, 0.25, 2.0 / 32767);
  tb->frameChecked(frames - 1, l, r);
  OM_CHECK_NEAR(r, -1.0, 2.0 / 32767);
  OM_CHECK(store.bytes() == static_cast<uint64_t>(frames) * 4);
}

OM_TEST(pcm_store_users_release_and_deferred_frees) {
  PcmStore store;
  OM_CHECK(store.begin(desc(9, 100)) == PcmError::None);
  std::shared_ptr<TrackBuffer> tb = store.acquire(9);
  OM_CHECK(tb != nullptr);
  store.abort(9);  // attached: dropped only when released
  OM_CHECK(store.count() == 1);
  store.release(tb.get());
  OM_CHECK(store.count() == 0);
  OM_CHECK(store.bytes() == 0);
  OM_CHECK(store.freePending() == 1);  // the control thread returns the memory
  OM_CHECK(tb->frames == 100);         // our shared_ptr keeps the object alive
}

OM_TEST(pcm_store_epochs) {
  PcmStore store;
  OM_CHECK(store.epoch() == 1);
  OM_CHECK(store.begin(desc(1, 100)) == PcmError::None);
  OM_CHECK(store.begin(desc(2, 100)) == PcmError::None);
  std::shared_ptr<TrackBuffer> attached = store.acquire(1);
  OM_CHECK(store.newEpoch() == 2);  // renderer reload
  OM_CHECK(store.count() == 1);     // the unattached stream 2 is gone at once
  OM_CHECK(store.begin(desc(1, 50)) == PcmError::None);  // same loadId, new epoch: no collision
  OM_CHECK(store.peek(1)->frames == 50);
  store.release(attached.get());  // the old stream leaves when the deck lets it go
  OM_CHECK(store.count() == 1);
  OM_CHECK(store.bytes() == 50 * 4);
  OM_CHECK(store.freePending() == 2);
}

OM_TEST(pcm_per_chunk_headroom_and_fold_to_stereo) {
  PcmStore store;
  const int n = 1000;
  OM_CHECK(store.begin(desc(3, n, 0.0f)) == PcmError::None);  // per-chunk headroom (stems, samples)
  std::vector<float> v = planar(n, 1.8f, -0.9f);
  OM_CHECK(store.write(3, 0, n, 2, v.data()) == PcmError::None);
  std::shared_ptr<const TrackBuffer> tb = store.peek(3);
  float l = 0, r = 0;
  tb->frameChecked(5, l, r);
  OM_CHECK_NEAR(l, 1.8, 2 * 1.8 / 32767);  // no clipping: the chunk's scale follows its peak
  OM_CHECK_NEAR(r, -0.9, 2 * 1.8 / 32767);
  // 5.1 folded with the Web Audio "speakers" rules: L + sqrt(1/2) (C + SL)
  std::vector<float> six(static_cast<size_t>(6) * 4, 0.0f);
  for (int i = 0; i < 4; i++) {
    six[static_cast<size_t>(0 * 4 + i)] = 0.1f;  // L
    six[static_cast<size_t>(1 * 4 + i)] = 0.2f;  // R
    six[static_cast<size_t>(2 * 4 + i)] = 0.3f;  // C
    six[static_cast<size_t>(3 * 4 + i)] = 0.9f;  // LFE (dropped)
    six[static_cast<size_t>(4 * 4 + i)] = 0.4f;  // SL
    six[static_cast<size_t>(5 * 4 + i)] = 0.5f;  // SR
  }
  float fl[4], fr[4];
  downmixToStereo(six.data(), 6, 4, fl, fr);
  OM_CHECK_NEAR(fl[2], 0.1 + 0.70710678 * (0.3 + 0.4), 1e-6);
  OM_CHECK_NEAR(fr[2], 0.2 + 0.70710678 * (0.3 + 0.5), 1e-6);
  const float mono[3] = {0.5f, -0.5f, 0.25f};
  downmixToStereo(mono, 1, 3, fl, fr);
  OM_CHECK(fl[1] == -0.5f && fr[1] == -0.5f);
  // quad: 0.5 (L + SL), 0.5 (R + SR)
  const float quad[8] = {0.2f, 0.2f, 0.4f, 0.4f, 0.6f, 0.6f, -0.8f, -0.8f};
  downmixToStereo(quad, 4, 2, fl, fr);
  OM_CHECK_NEAR(fl[0], 0.5 * (0.2 + 0.6), 1e-7);
  OM_CHECK_NEAR(fr[1], 0.5 * (0.4 - 0.8), 1e-7);
}

OM_TEST(pcm_headroom_and_quantization) {
  OM_CHECK(headroomFor(0.5f) == 1.0f);
  OM_CHECK(headroomFor(1.7f) == 1.7f);
  const float l[3] = {1.7f, -1.7f, 0.0f};
  const float r[3] = {0.85f, 0.0f, -0.001f};
  OM_CHECK_NEAR(peakOf(l, r, 3), 1.7, 1e-7);
  int16_t out[6];
  quantizeS16(l, r, 3, 1.7f, 1, out);
  OM_CHECK(out[0] >= 32766 && out[2] <= -32766);  // the hot peak maps to full scale (+- the dither LSB)
  OM_CHECK(std::abs(out[1] - 16384) <= 1);
  int16_t again[6];
  quantizeS16(l, r, 3, 1.7f, 1, again);
  for (int i = 0; i < 6; i++) OM_CHECK(again[i] == out[i]);  // deterministic for a seed
  OM_CHECK(ditherSeed(7, 0) != ditherSeed(7, 1) && ditherSeed(7, 0) != 0);
}

OM_TEST(media_foundation_passive_check) {
  std::string err;
  if (!mediaFoundationAvailable(&err)) OM_SKIP("Media Foundation unavailable: " + err);
  OM_CHECK(std::string(decodeErrorName(DecodeError::NotFound)) == "notFound");
}

OM_TEST(resampler_passthrough_and_lengths) {
  Resampler same(48000, 48000);
  std::vector<float> out;
  const float in[4] = {0.1f, 0.2f, 0.3f, 0.4f};
  same.process(in, 2, out, true);
  OM_CHECK(out.size() == 4);
  OM_CHECK(same.halfLengthFrames() == 0);
  Resampler up(44100, 48000);
  OM_CHECK(up.outputFramesFor(44100) == 48000);
}

// ---------------------------------------------------------------------------
// SPEC §7.3 TPDF quantization: published vectors, reference, statistics,
// arrival-order independence, float32 storage, clipped counter
// ---------------------------------------------------------------------------
namespace {
// Straight transcription of the SPEC pseudo-code (independent of pcm.cpp).
std::vector<int16_t> specQuantize(const std::vector<float>& l, const std::vector<float>& r, float headroom, uint32_t seed) {
  uint32_t x = seed ? seed : 0x9E3779B9u;
  auto rnd = [&x]() {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x / 4294967296.0;
  };
  const double scale = 32767.0 / (headroom >= 1.0f ? static_cast<double>(headroom) : 1.0);
  std::vector<int16_t> out;
  for (size_t i = 0; i < l.size(); i++) {
    for (const float v : {l[i], r[i]}) {
      const double first = rnd();
      const double second = rnd();
      double s = std::floor(static_cast<double>(v) * scale + (first - second) + 0.5);
      if (std::isnan(s)) s = 0;
      out.push_back(static_cast<int16_t>(std::clamp(s, -32768.0, 32767.0)));
    }
  }
  return out;
}
const std::vector<float> kVecL = {0.0f, 0.25f, -0.5f, 0.999f, -1.0f, 1e-5f, 0.123456f, -0.987654f, 1.25f, -1.6f};
const std::vector<float> kVecR = {0.5f, -0.25f, 0.75f, -0.999f, 1.0f, -1e-5f, -0.654321f, 0.333333f, -1.3f, 1.6f};
}  // namespace

OM_TEST(decoder_tpdf_published_vectors) {
  // Published with an independent JavaScript transcription of SPEC §7.3
  // (Math.fround inputs, uint32 xorshift, first draw minus second draw).
  struct Vec {
    float headroom;
    uint32_t seed;
    int16_t want[20];
  };
  const Vec vecs[] = {
      {1.0f, 1u, {0, 16384, 8192, -8192, -16384, 24576, 32735, -32735, -32768, 32766, 0, -1, 4045, -21440, -32363, 10922, 32767, -32768, -32768, 32767}},
      {1.0f, 0u, {-1, 16384, 8192, -8192, -16384, 24574, 32734, -32734, -32767, 32766, 0, 0, 4046, -21440, -32362, 10922, 32767, -32768, -32768, 32767}},
      {1.6f, 0xDEADBEEFu, {0, 10239, 5120, -5120, -10240, 15359, 20459, -20459, -20479, 20479, 0, 0, 2529, -13400, -20227, 6827, 25599, -26624, -32767, 32767}},
      {1.0f, 3539018225u, {0, 16384, 8192, -8192, -16383, 24576, 32735, -32735, -32767, 32767, 0, 0, 4045, -21440, -32363, 10922, 32767, -32768, -32768, 32767}},
  };
  for (const Vec& v : vecs) {
    int16_t out[20];
    quantizeS16(kVecL.data(), kVecR.data(), 10, v.headroom, v.seed, out);
    for (int i = 0; i < 20; i++) {
      if (out[i] != v.want[i])
        omtest::fail("published TPDF vector", __FILE__, __LINE__,
                     "seed " + std::to_string(v.seed) + " sample " + std::to_string(i) + ": " + std::to_string(out[i]) +
                         " != " + std::to_string(v.want[i]));
    }
  }
  OM_CHECK(ditherSeed(7, 3) == 3539018225u);  // the seed function is part of the published behaviour
  OM_CHECK(ditherSeed(1, 0) == 3423952679u);
  OM_CHECK(ditherSeed(4294967295u, 65535) == 802468309u);
  // NaN -> 0, +-Inf -> full scale
  const float nl[2] = {std::nanf(""), INFINITY};
  const float nr[2] = {-INFINITY, 0.0f};
  int16_t o[4];
  quantizeS16(nl, nr, 2, 1.0f, 5, o);
  OM_CHECK(o[0] == 0 && o[1] == -32768 && o[2] == 32767);
}

OM_TEST(decoder_tpdf_reference_and_statistics) {
  std::mt19937 g(1234);
  std::uniform_real_distribution<float> u(-1.9f, 1.9f);
  // identical to the SPEC transcription on random data, headrooms and seeds
  for (int trial = 0; trial < 40; trial++) {
    const int n = 1 + static_cast<int>(g() % 3000);
    std::vector<float> l(static_cast<size_t>(n)), r(static_cast<size_t>(n));
    for (int i = 0; i < n; i++) {
      l[static_cast<size_t>(i)] = u(g);
      r[static_cast<size_t>(i)] = u(g) * 0.01f;
    }
    const float h = trial % 3 == 0 ? 1.0f : 1.0f + (g() % 1000) / 999.0f;
    const uint32_t seed = trial % 5 == 0 ? 0u : static_cast<uint32_t>(g());
    std::vector<int16_t> mine(static_cast<size_t>(n) * 2);
    quantizeS16(l.data(), r.data(), n, h, seed, mine.data());
    const std::vector<int16_t> ref = specQuantize(l, r, h, seed);
    OM_CHECK(std::equal(mine.begin(), mine.end(), ref.begin()));
  }
  // error <= 1 LSB + dither (|e| < 1.5 LSB), zero mean, TPDF variance 1/4 LSB^2
  const int n = 200000;
  std::vector<float> l(n), r(n);
  for (int i = 0; i < n; i++) {
    l[static_cast<size_t>(i)] = 0.3f * static_cast<float>(std::sin(i * 0.001));
    r[static_cast<size_t>(i)] = 0.37f / 32767.0f;  // a constant 0.37 LSB: dither must decorrelate it
  }
  std::vector<int16_t> q(static_cast<size_t>(n) * 2);
  quantizeS16(l.data(), r.data(), n, 1.0f, 99, q.data());
  double sum = 0, sum2 = 0, maxe = 0, meanR = 0;
  for (int i = 0; i < n; i++) {
    const double e = q[static_cast<size_t>(2 * i)] - static_cast<double>(l[static_cast<size_t>(i)]) * 32767.0;
    sum += e;
    sum2 += e * e;
    maxe = std::max(maxe, std::fabs(e));
    meanR += q[static_cast<size_t>(2 * i + 1)];
  }
  const double mean = sum / n, var = sum2 / n - mean * mean;
  OM_CHECK(maxe < 1.5);
  OM_CHECK(std::fabs(mean) < 0.01);
  OM_CHECK_NEAR(var, 0.25, 0.01);
  OM_CHECK_NEAR(meanR / n, 0.37, 0.01);  // the sub-LSB level survives on average (no dead band)
}

OM_TEST(decoder_store_arrival_order_independence_f32_and_clipping) {
  const int64_t full = TrackBuffer::kChunkFrames;
  const int64_t frames = 3 * full + 1234;
  MusicSignal sig(7);
  std::vector<float> mono = sig.render(48000, frames);
  auto chunk = [&](int64_t c, float gain) {
    const int64_t a = c * full, n = std::min(full, frames - a);
    std::vector<float> v(static_cast<size_t>(n) * 2);
    for (int64_t i = 0; i < n; i++) {
      v[static_cast<size_t>(i)] = gain * mono[static_cast<size_t>(a + i)];
      v[static_cast<size_t>(n + i)] = -0.5f * gain * mono[static_cast<size_t>(a + i)];
    }
    return v;
  };
  // the same stream written in two orders, per-track headroom and per-chunk headroom
  for (float headroom : {1.0f, 0.0f}) {
    PcmStore s1, s2;
    OM_CHECK(s1.begin(desc(77, frames, headroom)) == PcmError::None);
    OM_CHECK(s2.begin(desc(77, frames, headroom)) == PcmError::None);
    const int order1[4] = {0, 1, 2, 3}, order2[4] = {3, 1, 0, 2};
    for (int k = 0; k < 4; k++) {
      std::vector<float> a = chunk(order1[k], 0.3f), b = chunk(order2[k], 0.3f);
      OM_CHECK(s1.write(77, order1[k] * full, static_cast<int>(a.size() / 2), 2, a.data()) == PcmError::None);
      OM_CHECK(s2.write(77, order2[k] * full, static_cast<int>(b.size() / 2), 2, b.data()) == PcmError::None);
    }
    OM_CHECK(s1.end(77) == PcmError::None && s2.end(77) == PcmError::None);
    auto t1 = s1.peek(77), t2 = s2.peek(77);
    OM_CHECK(std::memcmp(t1->s16.get(), t2->s16.get(), static_cast<size_t>(frames) * 4) == 0);
    for (int64_t c = 0; c < t1->numChunks; c++) OM_CHECK(t1->chunkScale[c] == t2->chunkScale[c]);
    // per-chunk headroom: each chunk's scale = max(1, its peak) / 32767 (here every peak < 1)
    if (headroom == 0.0f) OM_CHECK(t1->chunkScale[0] == 1.0f / 32767.0f);
  }
  // float32 storage: bit-exact, non-finite samples replaced by silence
  {
    PcmStore s;
    OM_CHECK(s.begin(desc(5, 1000, 0.0f, PcmFormat::F32)) == PcmError::None);
    std::vector<float> v(2000);
    for (int i = 0; i < 1000; i++) {
      v[static_cast<size_t>(i)] = mono[static_cast<size_t>(i)] * 1.7f;  // hi-res: no headroom needed
      v[static_cast<size_t>(1000 + i)] = -mono[static_cast<size_t>(i)];
    }
    v[10] = std::nanf("");
    v[1011] = INFINITY;
    OM_CHECK(s.write(5, 0, 1000, 2, v.data()) == PcmError::None);
    auto tb = s.peek(5);
    OM_CHECK(tb->format == PcmFormat::F32 && tb->bytes() == 1000u * 8);
    bool exact = true;
    for (int i = 0; i < 1000; i++) {
      float l, r;
      tb->frame(i, l, r);
      const float wl = i == 10 ? 0.0f : v[static_cast<size_t>(i)];
      const float wr = i == 11 ? 0.0f : v[static_cast<size_t>(1000 + i)];
      exact = exact && l == wl && r == wr;
    }
    OM_CHECK(exact);
  }
  // clipped counter: the renderer said peak 1.0 but the audio goes to 1.5
  {
    PcmStore s;
    OM_CHECK(s.begin(desc(6, 1000, 1.0f)) == PcmError::None);
    std::vector<float> v(2000, 0.5f);
    for (int i = 0; i < 7; i++) v[static_cast<size_t>(100 + i)] = 1.5f;
    v[1500] = -1.25f;
    OM_CHECK(s.write(6, 0, 1000, 2, v.data()) == PcmError::None);
    PcmInfo info;
    OM_CHECK(s.info(6, info));
    OM_CHECK(info.clipped == 8);
    OM_CHECK(s.stats().clipped == 8);
    float l, r;
    s.peek(6)->frame(100, l, r);
    OM_CHECK_NEAR(l, 1.0, 1.0 / 32767);  // clamped at the given headroom
  }
}

// ---------------------------------------------------------------------------
// Store limits, garbage collection, info, concurrency, no free under the mutex
// ---------------------------------------------------------------------------
OM_TEST(decoder_store_limits_gc_info_and_concurrency) {
  // memory limit
  {
    PcmStore s(1000 * 4);
    OM_CHECK(s.begin(desc(1, 1000)) == PcmError::None);
    OM_CHECK(s.begin(desc(2, 1)) == PcmError::OutOfMemory);
    OM_CHECK(s.stats().refused == 1);
    s.abort(1);
    OM_CHECK(s.begin(desc(2, 1000)) == PcmError::None);  // live bytes only: the aborted one does not count
    OM_CHECK(s.freePending() == 1);
  }
  // descriptor limits
  {
    PcmStore s;
    PcmDesc d = desc(1, 0);
    OM_CHECK(s.begin(d) == PcmError::Invalid);  // no frames
    d = desc(1, kPcmMaxFrames + 1);
    OM_CHECK(s.begin(d) == PcmError::Invalid);
    d = desc(1, 100);
    d.sampleRate = 7999;
    OM_CHECK(s.begin(d) == PcmError::Invalid);
    d.sampleRate = 384001;
    OM_CHECK(s.begin(d) == PcmError::Invalid);
    d = desc(1, 100, INFINITY);
    OM_CHECK(s.begin(d) == PcmError::Invalid);
    d = desc(1, 100);
    d.sourceChannels = 9;
    OM_CHECK(s.begin(d) == PcmError::Invalid);
  }
  // stream count limit
  {
    PcmStore s;
    for (uint32_t i = 1; i <= kPcmMaxStreams; i++) OM_CHECK(s.begin(desc(i, 16)) == PcmError::None);
    OM_CHECK(s.begin(desc(100000, 16)) == PcmError::OutOfMemory);
    OM_CHECK(s.count() == kPcmMaxStreams);
  }
  // garbage collection of streams never attached; info()
  {
    PcmStore s;
    OM_CHECK(s.begin(desc(1, 100)) == PcmError::None);  // a renderer that went away mid-load
    OM_CHECK(s.begin(desc(2, 100)) == PcmError::None);
    std::shared_ptr<TrackBuffer> b = s.acquire(2);  // attached: never collected
    OM_CHECK(s.collectGarbage(1000.0) == 0);        // first sight
    OM_CHECK(s.collectGarbage(1100.0) == 0);
    OM_CHECK(s.collectGarbage(1000.0 + kPcmGcAgeSec + 1.0) == 1);
    OM_CHECK(s.count() == 1 && !s.peek(1) && s.peek(2));
    PcmInfo info;
    OM_CHECK(!s.info(1, info));
    OM_CHECK(s.info(2, info));
    OM_CHECK(info.loadId == 2 && info.epoch == 1 && info.users == 1 && info.attached && info.frames == 100 &&
             info.chunks == 1 && info.chunksReady == 0 && !info.ended && info.bytes == 400 && info.sampleRate == 48000 &&
             info.format == PcmFormat::S16 && info.headroom == 1.0f);
    const PcmStoreStats st = s.stats();
    OM_CHECK(st.streams == 1 && st.collected == 1 && st.pendingFree == 1 && st.pendingBytes == 400);
    OM_CHECK(s.freePending() == 1);
    OM_CHECK(s.stats().pendingFree == 0 && s.stats().freedBuffers == 1);
    s.release(b.get());
  }
  // registry operations neither allocate nor free (frees happen only in freePending, outside the mutex)
  {
    PcmStore s;
    OM_CHECK(s.begin(desc(1, 70000)) == PcmError::None);
    OM_CHECK(s.begin(desc(2, 100)) == PcmError::None);
    OM_CHECK(s.begin(desc(3, 100)) == PcmError::None);
    std::shared_ptr<TrackBuffer> tb = s.acquire(1);
    const TrackBuffer* raw = tb.get();
    std::shared_ptr<TrackBuffer> keep3 = s.acquire(3);
    {
      rt::Scope trap;  // any allocation or free in here fails the test
      s.abort(2);
      s.release(raw);
      s.collectGarbage(1.0);
      s.newEpoch();
      (void)s.bytes();
    }
    OM_CHECK(s.stats().pendingFree == 2 && s.count() == 1);
    tb.reset();
    OM_CHECK(s.freePending() == 2);  // the last owner of stream 1 was the store: freed here
    s.release(keep3.get());
    OM_CHECK(s.freePending() == 1);
  }
  // two writer threads on two streams, and two on one stream (distinct chunks), in parallel
  {
    PcmStore s;
    const int64_t full = TrackBuffer::kChunkFrames;
    const int chunks = 12;
    const int64_t frames = chunks * full;
    OM_CHECK(s.begin(desc(1, frames)) == PcmError::None);
    OM_CHECK(s.begin(desc(2, frames, 0.0f)) == PcmError::None);
    OM_CHECK(s.begin(desc(3, frames, 1.0f, PcmFormat::F32)) == PcmError::None);
    std::atomic<int> errors{0};
    auto writer = [&](uint32_t id, int first, int step) {
      std::vector<float> v(static_cast<size_t>(full) * 6);  // 6 channels: the fold runs too
      for (int c = first; c < chunks; c += step) {
        for (int64_t i = 0; i < full; i++)
          for (int ch = 0; ch < 6; ch++)
            v[static_cast<size_t>(ch * full + i)] = static_cast<float>(((c * full + i) % 1000) / 2000.0 * (ch == 0 ? 1 : 0.1));
        if (s.write(id, c * full, static_cast<int>(full), 6, v.data()) != PcmError::None) errors++;
      }
    };
    std::thread t1(writer, 1u, 0, 1), t2(writer, 2u, 0, 1), t3(writer, 3u, 0, 2), t4(writer, 3u, 1, 2);
    t1.join();
    t2.join();
    t3.join();
    t4.join();
    OM_CHECK(errors.load() == 0);
    OM_CHECK(s.end(1) == PcmError::None && s.end(2) == PcmError::None && s.end(3) == PcmError::None);
    auto tb = s.peek(3);
    bool ok = true;
    for (int64_t i = 0; i < frames; i += 997) {
      float l, r;
      tb->frame(i, l, r);
      const float x = static_cast<float>((i % 1000) / 2000.0);
      const float sl = static_cast<float>(((i % 1000) / 2000.0) * 0.1);
      ok = ok && std::fabs(l - (x + 0.70710678f * (sl + sl))) < 1e-6f;
    }
    OM_CHECK(ok);
    OM_CHECK(s.stats().chunksWritten == 3u * chunks);
    // the same chunk raced by two writers: exactly one wins
    OM_CHECK(s.begin(desc(4, full)) == PcmError::None);
    std::vector<float> v(static_cast<size_t>(full) * 2, 0.25f);
    std::atomic<int> ok1{0}, dup{0};
    auto racer = [&] {
      const PcmError e = s.write(4, 0, static_cast<int>(full), 2, v.data());
      if (e == PcmError::None) ok1++;
      else if (e == PcmError::Duplicate) dup++;
    };
    std::thread r1(racer), r2(racer);
    r1.join();
    r2.join();
    OM_CHECK(ok1.load() == 1 && dup.load() == 1);
  }
  // a stale stream after a new epoch: chunks are refused (NotFound), the old buffer goes away
  {
    PcmStore s;
    OM_CHECK(s.begin(desc(9, 100)) == PcmError::None);
    s.newEpoch();
    std::vector<float> v = planar(100, 0.1f, 0.1f);
    OM_CHECK(s.write(9, 0, 100, 2, v.data()) == PcmError::NotFound);
    OM_CHECK(s.end(9) == PcmError::NotFound);
    OM_CHECK(s.freePending() == 1);
  }
}

// ===========================================================================
// Readers
// ===========================================================================
OM_TEST(decoder_readers_wav_and_media_foundation) {
  TempCleanup cleanup;
  MusicSignal sig(11);
  const int frames = 48000 * 3 + 333;  // not a multiple of any block size
  struct Case {
    const char* name;
    WavSpec spec;
    bool mfRequired;  // Media Foundation must decode it bit-exactly (the formats the shadow gate relies on)
  };
  std::vector<Case> cases;
  auto add = [&](const char* name, WavKind k, int ch, bool mfReq, bool rf64 = false, bool ext = false, int rate = 48000) {
    WavSpec s;
    s.kind = k;
    s.channels = ch;
    s.rf64 = rf64;
    s.extensible = ext;
    s.rate = rate;
    cases.push_back({name, s, mfReq});
  };
  add("pcm16.wav", WavKind::Pcm16, 2, true);
  add("pcm24.wav", WavKind::Pcm24, 2, true);
  add("pcm32.wav", WavKind::Pcm32, 2, true);
  add("float32.wav", WavKind::Float32, 2, true);
  add("rf64-pcm16.wav", WavKind::Pcm16, 2, true, true);
  add("mono16.wav", WavKind::Pcm16, 1, true);
  add("surround51-float.wav", WavKind::Float32, 6, true, false, true);
  add("pcm24-ext-44k.wav", WavKind::Pcm24, 2, true, false, true, 44100);
  add("t\xC3\xABst-\xC3\xA9t\xC3\xA9.wav", WavKind::Pcm16, 2, true);  // non-ASCII name (UTF-8)
  add("pcm8.wav", WavKind::Pcm8, 2, false);                           // extras: reported only for MF
  add("float64.wav", WavKind::Float64, 2, false);
  std::string mfErr;
  const bool mf = mediaFoundationAvailable(&mfErr);
  int mfExact = 0, mfTried = 0, mfRequiredBad = 0;
  std::string mfReport;
  for (const Case& c : cases) {
    std::vector<float> src(static_cast<size_t>(frames) * c.spec.channels);
    for (int i = 0; i < frames; i++)
      for (int ch = 0; ch < c.spec.channels; ch++)
        src[static_cast<size_t>(i) * c.spec.channels + ch] =
            static_cast<float>(0.8 * sig.at((i + 17.0 * ch) / c.spec.rate) * (ch % 2 ? -1 : 1));
    const std::filesystem::path p = tempDir() / std::filesystem::path(std::u8string(
                                                    reinterpret_cast<const char8_t*>(c.name), std::strlen(c.name)));
    const std::vector<float> decoded = writeWav(p, c.spec, src);
    const std::vector<float> want = expectStereo(decoded, c.spec.channels);
    DecodeError e;
    std::string m;
    auto wav = openWavReader(u8(p), &e, &m);
    if (!wav) omtest::fail("openWavReader", __FILE__, __LINE__, std::string(c.name) + ": " + m);
    OM_CHECK(wav->sampleRate() == c.spec.rate && wav->sourceChannels() == c.spec.channels);
    const std::vector<float> got = readAll(*wav);
    OM_CHECK(wav->error() == DecodeError::None);
    if (got != want) omtest::fail("WAV reader bit-exact", __FILE__, __LINE__, c.name);
    if (mf) {
      auto sys = openSystemReader(u8(p), &e, &m);
      mfTried++;
      if (!sys) {
        mfReport += std::string(" ") + c.name + ":open(" + decodeErrorName(e) + " " + m + ")";
        mfRequiredBad += c.mfRequired;
        continue;
      }
      OM_CHECK(sys->sampleRate() == c.spec.rate);
      OM_CHECK(sys->sourceChannels() == c.spec.channels);
      const std::vector<float> g2 = readAll(*sys, 4096);
      OM_CHECK(sys->error() == DecodeError::None);
      if (g2 == want) {
        mfExact++;
      } else {
        double worst = 0;
        for (size_t i = 0; i < std::min(g2.size(), want.size()); i++) worst = std::max(worst, std::fabs(double(g2[i]) - want[i]));
        mfReport += std::string(" ") + c.name + ":frames " + std::to_string(g2.size() / 2) + "/" +
                    std::to_string(want.size() / 2) + " maxdiff " + std::to_string(worst);
        mfRequiredBad += c.mfRequired;
      }
    }
  }
  // missing files
  DecodeError e = DecodeError::None;
  std::string m;
  OM_CHECK(!openWavReader(u8(tempDir() / "missing.wav"), &e, &m) && e == DecodeError::NotFound);
  // not a WAV
  {
    std::ofstream(tempDir() / "not-a-wav.wav") << "hello, this is not audio";
    OM_CHECK(!openWavReader(u8(tempDir() / "not-a-wav.wav"), &e, &m) && e == DecodeError::Unsupported);
  }
  if (mf) {
    OM_CHECK(!openSystemReader(u8(tempDir() / "missing.wav"), &e, &m) && e == DecodeError::NotFound);
    std::printf("  [info] Media Foundation reader bit-exact on %d/%d generated WAV files%s%s\n", mfExact, mfTried,
                mfReport.empty() ? "" : "; others:", mfReport.c_str());
    if (mfRequiredBad) omtest::fail("Media Foundation reader bit-exact", __FILE__, __LINE__, mfReport);
  } else {
    std::printf("  [info] Media Foundation not available (%s): system reader not tested\n", mfErr.c_str());
  }
}

// ===========================================================================
// Resampler quality
// ===========================================================================
OM_TEST(decoder_resampler_quality) {
  struct Pair {
    int in, out;
  };
  for (const Pair pr : {Pair{44100, 48000}, Pair{48000, 44100}, Pair{22050, 48000}, Pair{96000, 48000}}) {
    Resampler rs(pr.in, pr.out, 1);
    const int H = rs.halfLengthFrames();
    OM_CHECK(H > 0 && rs.tapsPerPhase() == 2 * H && !rs.passthrough());
    const int64_t L = rs.upFactor(), M = rs.downFactor();
    // 1) impulse centred: an impulse at input frame n0 (n0 * L / M integer) peaks at output n0 * L / M, symmetric
    const int64_t n0 = M * 100;
    std::vector<float> imp(static_cast<size_t>(n0 * 2), 0.0f);
    imp[static_cast<size_t>(n0)] = 1.0f;
    const std::vector<float> y = resampleAll(pr.in, pr.out, imp);
    OM_CHECK(static_cast<int64_t>(y.size()) == rs.outputFramesFor(n0 * 2));
    const int64_t c = n0 * L / M;
    const size_t argmax = static_cast<size_t>(std::max_element(y.begin(), y.end(), [](float a, float b) { return std::fabs(a) < std::fabs(b); }) - y.begin());
    OM_CHECK(static_cast<int64_t>(argmax) == c);
    double asym = 0;
    for (int64_t j = 1; j < 60; j++) asym = std::max(asym, std::fabs(double(y[static_cast<size_t>(c + j)]) - y[static_cast<size_t>(c - j)]));
    OM_CHECK(asym < 1e-6);
    // 2) half-length exact: outputs farther than H input frames from the impulse are exactly 0
    bool outside0 = true, insideNz = false;
    for (int64_t j = 0; j < static_cast<int64_t>(y.size()); j++) {
      const double dist = std::fabs(static_cast<double>(j) * M / L - static_cast<double>(n0));
      if (dist >= H) outside0 = outside0 && y[static_cast<size_t>(j)] == 0.0f;
      else if (dist > H - 2.0 && y[static_cast<size_t>(j)] != 0.0f) insideNz = true;
    }
    OM_CHECK(outside0);
    OM_CHECK(insideNz);
    // 3) passband ripple < 0.01 dB up to 0.9 x the lower Nyquist; 4) stopband < -90 dB
    const double lowNyq = 0.5 * std::min(pr.in, pr.out);
    const int64_t n = pr.in * 2;
    double worstRipple = 0, worstStop = -400;
    for (double frac : {0.002, 0.05, 0.3, 0.6, 0.8, 0.9}) {
      const double f = frac * lowNyq;
      std::vector<float> x(static_cast<size_t>(n));
      for (int64_t i = 0; i < n; i++) x[static_cast<size_t>(i)] = static_cast<float>(0.5 * std::sin(2 * kPiD * f * i / pr.in + 0.3));
      const std::vector<float> o = resampleAll(pr.in, pr.out, x);
      const double a = toneAmplitude(o, static_cast<size_t>(pr.out / 4), static_cast<size_t>(pr.out * 7 / 4), f / pr.out);
      worstRipple = std::max(worstRipple, std::fabs(20 * std::log10(a / 0.5)));
    }
    // stopband: an input tone whose image (upsampling) or alias (downsampling) lands in the output band
    {
      const double fin = pr.out > pr.in ? 0.9 * 0.5 * pr.in : (2.0 - 0.95) * lowNyq + 0.02 * lowNyq;  // passband edge / stopband
      std::vector<float> x(static_cast<size_t>(n));
      for (int64_t i = 0; i < n; i++) x[static_cast<size_t>(i)] = static_cast<float>(0.5 * std::sin(2 * kPiD * fin * i / pr.in));
      const std::vector<float> o = resampleAll(pr.in, pr.out, x);
      // where the unwanted component lands in the output band
      double fbad = pr.out > pr.in ? pr.in - fin : pr.out - fin;  // image (up) / alias (down)
      while (fbad > pr.out / 2.0) fbad = pr.out - fbad;
      if (fbad < 0) fbad = -fbad;
      const double a = toneAmplitude(o, static_cast<size_t>(pr.out / 4), static_cast<size_t>(pr.out * 7 / 4), fbad / pr.out);
      worstStop = 20 * std::log10(std::max(a / 0.5, 1e-20));
    }
    std::printf("  [info] resampler %d -> %d: L/M %lld/%lld, half-length %d, ripple %.6f dB, stopband %.1f dB\n", pr.in,
                pr.out, static_cast<long long>(L), static_cast<long long>(M), H, worstRipple, worstStop);
    OM_CHECK(worstRipple < 0.01);
    OM_CHECK(worstStop < -90.0);
  }
  // 5) streaming in random chunk sizes == one call
  {
    MusicSignal sig(3);
    std::vector<float> st;
    for (int i = 0; i < 30000; i++) {
      st.push_back(static_cast<float>(sig.at(i / 44100.0)));
      st.push_back(static_cast<float>(-sig.at(i / 44100.0 + 0.001)));
    }
    const std::vector<float> one = resampleAll(44100, 48000, st, 2);
    Resampler rs(44100, 48000, 2);
    std::vector<float> chunked;
    std::mt19937 g(5);
    int64_t pos = 0;
    while (pos < 30000) {
      const int64_t n = std::min<int64_t>(30000 - pos, 1 + g() % 3000);
      rs.process(st.data() + pos * 2, n, chunked, false);
      pos += n;
    }
    rs.process(nullptr, 0, chunked, true);
    OM_CHECK(chunked == one);
    OM_CHECK(static_cast<int64_t>(one.size()) == 2 * rs.outputFramesFor(30000));
  }
  // 6) very large ratio terms use the interpolated table (still exact length, centred)
  {
    Resampler odd(44056, 48000, 1);
    OM_CHECK(odd.upFactor() > 2048);
    std::vector<float> imp(44056, 0.0f);
    imp[11014] = 1.0f;  // 11014 * 48000 / 44056 = 12000
    std::vector<float> y;
    odd.process(imp.data(), 44056, y, true);
    OM_CHECK(static_cast<int64_t>(y.size()) == odd.outputFramesFor(44056));
    const size_t am = static_cast<size_t>(std::max_element(y.begin(), y.end()) - y.begin());
    OM_CHECK(am == 12000);
  }
}

// ===========================================================================
// Offset finder and comparison
// ===========================================================================
OM_TEST(decoder_offset_finder) {
  const int rate = 48000;
  MusicSignal sig(21);
  const int64_t N = rate * 8;
  const std::vector<float> ref = sig.render(rate, N);
  const int64_t ws = 2 * rate, W = 4 * rate, maxLag = rate / 5;  // +-200 ms
  double worstMs = 0;
  for (int64_t k : {int64_t(-9590), int64_t(-4801), int64_t(-480), int64_t(-1), int64_t(0), int64_t(3), int64_t(517),
                    int64_t(5000), int64_t(9550)}) {
    const double d = static_cast<double>(k) + 0.37;
    const std::vector<float> s = sig.render(rate, N, d);  // s(t) = x(t - d): later by d
    double corr = 0;
    const double lag = findOffsetFrames(ref.data(), N, s.data(), N, ws, W, maxLag, &corr);
    const double errMs = std::fabs(lag - d) / rate * 1000.0;
    worstMs = std::max(worstMs, errMs);
    if (!(errMs < 0.02)) omtest::fail("offset finder accuracy", __FILE__, __LINE__, "shift " + std::to_string(d) + " found " + std::to_string(lag));
    OM_CHECK(corr > 0.99);
  }
  std::printf("  [info] offset finder: worst error %.5f ms (%.4f frames) on shifts k + 0.37 within +-200 ms\n", worstMs,
              worstMs * rate / 1000.0);
  // compareWindow: gain, noise, length, low correlation
  ShadowJob job;
  job.loadId = 3;
  job.refRate = rate;
  job.refFrames = N;
  job.windowStart = ws;
  job.left.assign(ref.begin() + ws, ref.begin() + ws + W);
  job.right = job.left;
  {
    const double d = 1234.37;
    std::vector<float> s = sig.render(rate, N + 4800, d);  // native 100 ms longer
    for (float& v : s) v *= 0.5f;                        // and 6 dB lower
    const ShadowReport r = compareWindow(job, s.data(), N + 4800, 0, N + 4800);
    OM_CHECK(r.ok);
    OM_CHECK_NEAR(r.offsetMs, d / rate * 1000.0, 0.02);
    OM_CHECK_NEAR(r.rmsDiffDb, 20 * std::log10(0.5), 0.05);
    OM_CHECK_NEAR(r.lengthDiffMs, 100.0, 1e-9);
    OM_CHECK(r.correlation > 0.999);
  }
  {
    std::vector<float> s = sig.render(rate, N, -250.37);
    std::mt19937 g(9);
    std::normal_distribution<double> nd(0.0, 1.0);
    double er = 0;
    for (int64_t i = ws; i < ws + W; i++) er += double(ref[static_cast<size_t>(i)]) * ref[static_cast<size_t>(i)];
    const double sigma = std::sqrt(er / W) * 0.01;  // noise 40 dB below the signal
    for (float& v : s) v += static_cast<float>(sigma * nd(g));
    const ShadowReport r = compareWindow(job, s.data(), N, 0, N);
    OM_CHECK(r.ok);
    OM_CHECK_NEAR(r.offsetMs, -250.37 / rate * 1000.0, 0.02);
    OM_CHECK_NEAR(r.rmsDiffDb, -40.0, 0.5);
  }
  {
    MusicSignal other(999);
    const std::vector<float> s = other.render(rate, N);
    const ShadowReport r = compareWindow(job, s.data(), N, 0, N);
    OM_CHECK(!r.ok && r.error == DecodeError::Mismatch);
    OM_CHECK(r.correlation < 0.3);
    OM_CHECK(r.message.find("correlation") != std::string::npos);
  }
  {
    ShadowJob silent = job;
    std::fill(silent.left.begin(), silent.left.end(), 0.0f);
    std::fill(silent.right.begin(), silent.right.end(), 0.0f);
    const ShadowReport r = compareWindow(silent, ref.data(), N, 0, N);
    OM_CHECK(!r.ok && r.error == DecodeError::Mismatch);
  }
}

// ===========================================================================
// The whole shadow job
// ===========================================================================
OM_TEST(decoder_shadow_job_end_to_end) {
  TempCleanup cleanup;
  MusicSignal sig(33);
  // 1) 48 kHz 16-bit WAV against its own (Chromium-like) decode: offset 0, identical
  {
    const int rate = 48000;
    const int64_t frames = rate * 60;  // 1 min
    std::vector<float> st(static_cast<size_t>(frames) * 2);
    for (int64_t i = 0; i < frames; i++) {
      const float v = static_cast<float>(0.7 * sig.at(static_cast<double>(i) / rate));
      st[static_cast<size_t>(2 * i)] = v;
      st[static_cast<size_t>(2 * i + 1)] = -0.8f * v;
    }
    WavSpec spec;
    const std::filesystem::path p = tempDir() / "job48.wav";
    const std::vector<float> dec = writeWav(p, spec, st);
    ShadowJob job;
    job.loadId = 41;
    job.pathUtf8 = u8(p);
    job.refRate = rate;
    job.refFrames = frames;
    job.windowStart = frames / 2 - rate * 5;  // the middle 10 s
    for (int64_t i = 0; i < rate * 10; i++) {
      job.left.push_back(dec[static_cast<size_t>(2 * (job.windowStart + i))]);
      job.right.push_back(dec[static_cast<size_t>(2 * (job.windowStart + i) + 1)]);
    }
    DecodeError e;
    std::string m;
    auto reader = openWavReader(job.pathUtf8, &e, &m);
    OM_CHECK(reader != nullptr);
    const ShadowReport r = runShadowJob(job, *reader, nullptr);
    if (!r.ok) omtest::fail("shadow job (WAV)", __FILE__, __LINE__, r.message);
    OM_CHECK(std::fabs(r.offsetMs) < 0.01);
    OM_CHECK(r.rmsDiffDb < -90.0);
    OM_CHECK_NEAR(r.lengthDiffMs, 0.0, 1e-9);
    OM_CHECK(r.fileRate == rate && r.fileChannels == 2 && r.nativeFrames == frames);
    // only the window +- (200 ms + margins) was kept: far less than the file
    OM_CHECK(r.keptFrames < rate * 10 + 2 * (rate / 5) + 1000);
    OM_CHECK(r.keptFrames * 5 < r.nativeFrames);
    std::printf("  [info] shadow job 48 kHz WAV: offset %.6f ms, rms diff %.1f dB, kept %lld of %lld frames, %.0f ms\n",
                r.offsetMs, r.rmsDiffDb, static_cast<long long>(r.keptFrames), static_cast<long long>(r.nativeFrames), r.decodeMs);
    // the om_shadow_run report text
    const std::string text = shadowReportJson(r);
    json::Value v;
    std::string err;
    OM_CHECK(json::parse(text, v, &err));
    OM_CHECK(v["loadId"].asNumber(0) == 41 && v["ok"].asBool(false) && !v.has("error"));
    for (const char* k : {"offsetMs", "lengthDiffMs", "rmsDiffDb", "correlation", "fileRate", "fileChannels", "decodeMs",
                          "lagFrames", "nativeFrames", "keptFrames"})
      OM_CHECK(v[k].isNumber());
    // the same file through Media Foundation (when available): the same timeline
    std::string mfErr;
    if (mediaFoundationAvailable(&mfErr)) {
      auto sys = openSystemReader(job.pathUtf8, &e, &m);
      OM_CHECK(sys != nullptr);
      const ShadowReport r2 = runShadowJob(job, *sys, nullptr);
      if (!r2.ok) omtest::fail("shadow job (Media Foundation)", __FILE__, __LINE__, r2.message);
      OM_CHECK(std::fabs(r2.offsetMs) < 0.01 && r2.rmsDiffDb < -90.0);
      std::printf("  [info] shadow job through Media Foundation: offset %.6f ms, rms diff %.1f dB, %.0f ms\n", r2.offsetMs,
                  r2.rmsDiffDb, r2.decodeMs);
    }
    // cancel
    std::atomic<bool> cancel{true};
    auto again = openWavReader(job.pathUtf8, &e, &m);
    const ShadowReport rc = runShadowJob(job, *again, &cancel);
    OM_CHECK(!rc.ok && rc.error == DecodeError::Cancelled);
    const std::string ct = shadowReportJson(rc);
    OM_CHECK(json::parse(ct, v, &err) && !v["ok"].asBool(true) && v["code"].asString() == "cancelled");
  }
  // 2) a 44.1 kHz float file compared at 48 kHz: only the window span is resampled, timeline intact
  {
    const int fileRate = 44100, refRate = 48000;
    const double seconds = 40.0;
    const int64_t fileFrames = static_cast<int64_t>(fileRate * seconds);
    std::vector<float> st(static_cast<size_t>(fileFrames) * 2);
    for (int64_t i = 0; i < fileFrames; i++) {
      const float v = static_cast<float>(0.6 * sig.at(static_cast<double>(i) / fileRate));
      st[static_cast<size_t>(2 * i)] = v;
      st[static_cast<size_t>(2 * i + 1)] = v;
    }
    WavSpec spec;
    spec.kind = WavKind::Float32;
    spec.rate = fileRate;
    const std::filesystem::path p = tempDir() / "job44.wav";
    writeWav(p, spec, st);
    ShadowJob job;
    job.loadId = 42;
    job.pathUtf8 = u8(p);
    job.refRate = refRate;
    job.refFrames = static_cast<int64_t>(refRate * seconds);
    job.windowStart = job.refFrames / 2 - refRate * 5;
    for (int64_t i = 0; i < refRate * 10; i++) {  // the ideal 48 kHz decode of the same signal
      const float v = static_cast<float>(0.6 * sig.at(static_cast<double>(job.windowStart + i) / refRate));
      job.left.push_back(v);
      job.right.push_back(v);
    }
    DecodeError e;
    std::string m;
    auto reader = openWavReader(job.pathUtf8, &e, &m);
    const ShadowReport r = runShadowJob(job, *reader, nullptr);
    if (!r.ok) omtest::fail("shadow job 44.1 -> 48", __FILE__, __LINE__, r.message);
    OM_CHECK(std::fabs(r.offsetMs) < 0.01);
    OM_CHECK(r.rmsDiffDb < -90.0);
    OM_CHECK(std::fabs(r.lengthDiffMs) < 0.03);
    OM_CHECK(r.fileRate == fileRate && r.nativeFrames == fileFrames);
    OM_CHECK(r.keptFrames < static_cast<int64_t>(fileRate * 10.5) + 1000 && r.keptFrames * 3 < r.nativeFrames);
    std::printf("  [info] shadow job 44.1 -> 48 kHz: offset %.6f ms, rms diff %.1f dB, kept %lld of %lld frames, %.0f ms\n",
                r.offsetMs, r.rmsDiffDb, static_cast<long long>(r.keptFrames), static_cast<long long>(r.nativeFrames), r.decodeMs);
    // a native decode 1234.5 frames late (an encoder delay): measured
    std::vector<float> late(static_cast<size_t>(fileFrames) * 2);
    for (int64_t i = 0; i < fileFrames; i++) {
      const float v = static_cast<float>(0.6 * sig.at((static_cast<double>(i) - 1234.5) / fileRate));
      late[static_cast<size_t>(2 * i)] = v;
      late[static_cast<size_t>(2 * i + 1)] = v;
    }
    writeWav(tempDir() / "job44late.wav", spec, late);
    auto r2 = openWavReader(u8(tempDir() / "job44late.wav"), &e, &m);
    const ShadowReport rl = runShadowJob(job, *r2, nullptr);
    OM_CHECK(rl.ok);
    OM_CHECK_NEAR(rl.offsetMs, 1234.5 / fileRate * 1000.0, 0.01);
    std::printf("  [info] encoder delay of 1234.5 frames at 44.1 kHz (%.4f ms) measured as %.4f ms\n", 1234.5 / fileRate * 1000.0,
                rl.offsetMs);
  }
}

// ===========================================================================
// Costs: the PCM handoff on the host JS thread (one 65536-frame chunk) and
// the shadow job's resampling.
// ===========================================================================
OM_TEST(decoder_bench_chunk_conversion_and_resampler) {
#ifdef NDEBUG
  const char* build = "Release";
#else
  const char* build = "Debug";
#endif
  const int full = static_cast<int>(TrackBuffer::kChunkFrames);
  const int chunks = 16;
  MusicSignal sig(5);
  std::vector<float> mono = sig.render(48000, full);
  std::vector<float> st(static_cast<size_t>(full) * 6);
  for (int c = 0; c < 6; c++)
    for (int i = 0; i < full; i++) st[static_cast<size_t>(c) * full + i] = 0.4f * mono[static_cast<size_t>(i)] * (c % 2 ? -1 : 1);
  struct Case {
    const char* what;
    PcmFormat fmt;
    float headroom;
    int channels;
  } cases[] = {{"s16, per-track headroom (tracks)", PcmFormat::S16, 1.0f, 2},
               {"s16, per-chunk headroom (stems, samples)", PcmFormat::S16, 0.0f, 2},
               {"f32 (hi-res)", PcmFormat::F32, 1.0f, 2},
               {"s16 from 5.1 (fold + quantize)", PcmFormat::S16, 0.0f, 6}};
  for (const Case& c : cases) {
    PcmStore s;
    OM_CHECK(s.begin(desc(1, static_cast<int64_t>(full) * chunks, c.headroom, c.fmt)) == PcmError::None);
    const int64_t t0 = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    for (int k = 0; k < chunks; k++) OM_CHECK(s.write(1, static_cast<int64_t>(k) * full, full, c.channels, st.data()) == PcmError::None);
    const int64_t t1 = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    std::printf("  [info] %s: one 65536-frame chunk (1.37 s of audio) %s in %.3f ms\n", build, c.what, (t1 - t0) / 1e6 / chunks);
  }
  // resampling a 30.4 s span 44.1 -> 48 kHz (the shadow job's work after the decode)
  std::vector<float> span = sig.render(44100, static_cast<int64_t>(44100 * 30.4));
  const auto r0 = std::chrono::steady_clock::now();
  std::vector<float> out = resampleAll(44100, 48000, span);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - r0).count();
  std::printf("  [info] %s: resampling a 30.4 s mono span 44.1 -> 48 kHz: %.0f ms (%.0f x real time)\n", build, ms, 30400.0 / ms);
  OM_CHECK(static_cast<int64_t>(out.size()) == Resampler(44100, 48000, 1).outputFramesFor(static_cast<int64_t>(span.size())));
}

// ===========================================================================
// Golden references (SPEC.md §18.4, tools/make-goldens.js "decode" suite):
// Chromium's own decodeAudioData of generated files. Same-rate WAVs must
// null against it with both readers; resampled WAVs and an AAC file go
// through the whole shadow job (offset, RMS difference, correlation).
// ===========================================================================
namespace {
// interleaved stereo fold (Web Audio speakers rules) of an interleaved n-channel WAV
std::vector<float> foldInterleaved(const omtest::Wav& w) {
  const size_t frames = static_cast<size_t>(w.frames());
  std::vector<float> pl(frames * static_cast<size_t>(w.channels));
  for (size_t i = 0; i < frames; i++)
    for (int c = 0; c < w.channels; c++) pl[static_cast<size_t>(c) * frames + i] = w.samples[i * w.channels + c];
  std::vector<float> l(frames), r(frames), out(frames * 2);
  downmixToStereo(pl.data(), w.channels, static_cast<int64_t>(frames), l.data(), r.data());
  for (size_t i = 0; i < frames; i++) {
    out[2 * i] = l[i];
    out[2 * i + 1] = r[i];
  }
  return out;
}
ShadowJob jobFromGolden(const std::vector<float>& st, int rate, double fromSec, double toSec) {
  ShadowJob job;
  job.loadId = 9;
  job.refRate = rate;
  job.refFrames = static_cast<int64_t>(st.size() / 2);
  job.windowStart = static_cast<int64_t>(fromSec * rate);
  const int64_t end = std::min<int64_t>(job.refFrames, static_cast<int64_t>(toSec * rate));
  for (int64_t i = job.windowStart; i < end; i++) {
    job.left.push_back(st[static_cast<size_t>(2 * i)]);
    job.right.push_back(st[static_cast<size_t>(2 * i + 1)]);
  }
  return job;
}
}  // namespace

OM_TEST(decoder_golden_decode_null_and_shadow) {
  if (omtest::goldenPath("decode/wav24_48000_stereo.json").empty()) OM_SKIP("OM_GOLDEN_DIR not set (tools/make-goldens.js)");
  std::string mfErr;
  const bool mf = mediaFoundationAvailable(&mfErr);
  std::string err;
  // 1) same rate: the native decode IS Chromium's (null test)
  for (const char* name : {"wav24_48000_stereo", "wav16_48000_6ch"}) {
    omtest::Wav g;
    if (!omtest::readWav(omtest::goldenPath(std::string("decode/") + name + ".wav"), g, &err))
      omtest::fail("golden", __FILE__, __LINE__, err);
    const std::vector<float> want = foldInterleaved(g);
    const std::string input = omtest::goldenPath(std::string("decode/") + name + ".input.wav");
    DecodeError e;
    std::string m;
    for (int which = 0; which < (mf ? 2 : 1); which++) {
      auto reader = which == 0 ? openWavReader(input, &e, &m) : openSystemReader(input, &e, &m);
      if (!reader) omtest::fail("open golden input", __FILE__, __LINE__, m);
      const std::vector<float> got = readAll(*reader);
      OM_CHECK(got.size() == want.size());
      const double res = omtest::residualDb(got.data(), want.data(), std::min(got.size(), want.size()));
      std::printf("  [info] golden %s, %s reader vs Chromium decodeAudioData: residual %.1f dBFS over %zu frames\n", name,
                  which == 0 ? "WAV" : "Media Foundation", res, want.size() / 2);
      OM_CHECK(res < -80.0);
    }
  }
  // 2) resampled by Chromium (44.1 / 96 / 22.05 kHz -> 48 kHz): the shadow job measures the two timelines
  for (const char* name : {"wav16_44100_stereo", "wavf32_96000_stereo", "wav16_22050_mono"}) {
    omtest::Wav g;
    if (!omtest::readWav(omtest::goldenPath(std::string("decode/") + name + ".wav"), g, &err))
      omtest::fail("golden", __FILE__, __LINE__, err);
    const std::vector<float> ref = foldInterleaved(g);
    const ShadowJob job = jobFromGolden(ref, g.sampleRate, 0.4, 1.6);
    const std::string input = omtest::goldenPath(std::string("decode/") + name + ".input.wav");
    DecodeError e;
    std::string m;
    for (int which = 0; which < (mf ? 2 : 1); which++) {
      auto reader = which == 0 ? openWavReader(input, &e, &m) : openSystemReader(input, &e, &m);
      if (!reader) omtest::fail("open golden input", __FILE__, __LINE__, m);
      const ShadowReport r = runShadowJob(job, *reader, nullptr);
      std::printf("  [info] golden %s through the shadow job (%s): ok %d, offset %.4f ms, rms diff %.1f dB, correlation %.6f, "
                  "length diff %.3f ms\n",
                  name, which == 0 ? "WAV" : "Media Foundation", r.ok ? 1 : 0, r.offsetMs, r.rmsDiffDb, r.correlation,
                  r.lengthDiffMs);
      OM_CHECK(r.ok);
      OM_CHECK(std::fabs(r.offsetMs) < 0.02);  // same timeline (Chromium's resampler is time-aligned too)
      // (the RMS difference and the correlation measure the two resamplers' passbands near the
      // source's Nyquist, not the timeline: Chromium's kernel cuts lower than ours)
      OM_CHECK(r.correlation > 0.99);
    }
  }
  // 3) AAC (encoder priming): what the shadow decoder exists for
  if (mf) {
    omtest::Wav g, src;
    if (!omtest::readWav(omtest::goldenPath("decode/aac_48000_stereo.wav"), g, &err) ||
        !omtest::readWav(omtest::goldenPath("decode/aac_48000_stereo.source.wav"), src, &err))
      omtest::fail("golden", __FILE__, __LINE__, err);
    const std::vector<float> ref = foldInterleaved(g);
    const ShadowJob job = jobFromGolden(ref, g.sampleRate, 0.5, 1.5);
    DecodeError e;
    std::string m;
    auto reader = openSystemReader(omtest::goldenPath("decode/aac_48000_stereo.input.aac"), &e, &m);
    if (!reader) {
      std::printf("  [info] Media Foundation cannot open the ADTS AAC golden (%s): %s\n", decodeErrorName(e), m.c_str());
    } else {
      const ShadowReport r = runShadowJob(job, *reader, nullptr);
      // Chromium's own offset against the source signal (its priming handling)
      const std::vector<float> s2 = foldInterleaved(src);
      std::vector<float> refMono(ref.size() / 2), srcMono(s2.size() / 2);
      for (size_t i = 0; i < refMono.size(); i++) refMono[i] = 0.5f * (ref[2 * i] + ref[2 * i + 1]);
      for (size_t i = 0; i < srcMono.size(); i++) srcMono[i] = 0.5f * (s2[2 * i] + s2[2 * i + 1]);
      double c = 0;
      const double chromiumLag = findOffsetFrames(srcMono.data(), static_cast<int64_t>(srcMono.size()), refMono.data(),
                                                  static_cast<int64_t>(refMono.size()), 24000, 48000, 9600, &c);
      std::printf("  [info] golden AAC: Chromium's decode is %.3f ms after the source (corr %.4f); the Media Foundation "
                  "decode is %.3f ms after Chromium's (ok %d, rms diff %.1f dB, corr %.4f, length diff %.2f ms)\n",
                  chromiumLag / 48.0, c, r.offsetMs, r.ok ? 1 : 0, r.rmsDiffDb, r.correlation, r.lengthDiffMs);
      OM_CHECK(r.ok && r.correlation > 0.9);
    }
  }
}
