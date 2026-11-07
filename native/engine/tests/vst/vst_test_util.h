// Shared helpers of the VST3 inline host tests (owner: decoder): timing and
// pacing, deterministic sources, fake processors (gain, pure delay), the
// callback rig (begin() for every deck, then end()), the paths of the real
// test plugins (the SDK's again, TDR Kotelnikov, the om-spy test plugin, a
// scratch folder) and the om-spy report / command helpers. Used by
// test_vst.cpp and test_vst_campaign.cpp. SPEC.md §13.
#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "om/rt.h"
#include "om/vst_insert.h"

namespace vsttest {

using Clock = std::chrono::steady_clock;

inline int64_t nowNs() { return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count(); }

inline void spinNs(int64_t ns) {
  const int64_t t0 = nowNs();
  while (nowNs() - t0 < ns) {
  }
}

inline std::string u8(const std::filesystem::path& p) {
  const std::u8string s = p.u8string();
  return std::string(s.begin(), s.end());
}
inline std::filesystem::path fromU8(const std::string& s) {
  return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

// Paces callbacks at the device period (yielding, never spinning hard).
struct Pacer {
  explicit Pacer(double periodSec) : period(static_cast<int64_t>(periodSec * 1e9)), next(nowNs()) {}
  void wait() {
    next += period;
    while (nowNs() < next) std::this_thread::yield();
  }
  int64_t period, next;
};

// A deterministic input per deck (white noise, -6 dBFS peak).
struct Source {
  explicit Source(uint32_t seed) : x(seed ? seed : 1) {}
  float next() {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return (static_cast<float>(x) / 4294967296.0f - 0.5f);
  }
  uint32_t x;
};

// ---- fake processors (run on the deck workers) ----
class GainFx : public om::IVstProcessor {
 public:
  explicit GainFx(float g, int64_t work = 0) : gain(g), workNs(work) {}
  om::VstProcessResult process(const om::VstProcessBlock& b) override {
    if (workNs > 0) spinNs(workNs);
    for (int i = 0; i < b.frames; i++) {
      b.outL[i] = b.inL[i] * gain;
      b.outR[i] = b.inR[i] * gain;
    }
    calls++;
    return om::VstProcessResult::Ok;
  }
  float gain;
  int64_t workNs;
  std::atomic<int> calls{0};
};

// A pure delay of `delay` frames (what a plugin with that latency does at
// unity), optionally slow on some blocks.
class DelayFx : public om::IVstProcessor {
 public:
  explicit DelayFx(int d) : delay(d), bufL(kSize), bufR(kSize) {}
  om::VstProcessResult process(const om::VstProcessBlock& b) override {
    const int c = calls++;
    const int every = slowEvery.load();
    if (every > 0 && c % every == every - 1) spinNs(slowNs.load());
    const int d = delay.load();
    for (int i = 0; i < b.frames; i++, pos++) {
      bufL[pos & kMask] = b.inL[i];
      bufR[pos & kMask] = b.inR[i];
      b.outL[i] = pos >= d ? bufL[(pos - d) & kMask] : 0.0f;
      b.outR[i] = pos >= d ? bufR[(pos - d) & kMask] : 0.0f;
    }
    return om::VstProcessResult::Ok;
  }
  static constexpr int64_t kSize = int64_t(1) << 20, kMask = kSize - 1;
  std::atomic<int> delay;
  std::atomic<int> slowEvery{0};
  std::atomic<int64_t> slowNs{0};
  std::atomic<int> calls{0};
  std::vector<float> bufL, bufR;
  int64_t pos = 0;
};

// The core's callback, as far as the inserts go: begin() for every deck,
// then end() for those with an insert. Buffers are processed in place.
struct Rig {
  explicit Rig(om::VstHost& h, int f, double rate) : host(h), frames(f), period(f / rate) {
    for (int d = 0; d < om::kNumDecks; d++) {
      l[d].assign(static_cast<size_t>(f), 0.0f);
      r[d].assign(static_cast<size_t>(f), 0.0f);
      src[d] = Source(static_cast<uint32_t>(1234 + 77 * d));
    }
  }
  // Fills every deck's block with its source (and keeps the history).
  void fill() {
    for (int d = 0; d < om::kNumDecks; d++) {
      for (int i = 0; i < frames; i++) {
        const float a = src[d].next();
        l[d][static_cast<size_t>(i)] = a;
        r[d][static_cast<size_t>(i)] = -0.5f * a;
        histL[d].push_back(a);
      }
    }
  }
  // One callback; returns its duration (ns).
  int64_t run() {
    const int64_t t0 = nowNs();
    {
      om::rt::Scope audio;  // the audio side never allocates nor frees
      host.startCallback(period);
      for (int d = 0; d < om::kNumDecks; d++) active[d] = host.begin(d, l[d].data(), r[d].data(), frames);
      for (int d = 0; d < om::kNumDecks; d++)
        if (active[d]) host.end(d, l[d].data(), r[d].data(), frames);
    }
    const int64_t dur = nowNs() - t0;
    block++;
    return dur;
  }
  // Input sample n of deck d (left channel).
  float in(int d, int64_t n) const { return n >= 0 ? histL[d][static_cast<size_t>(n)] : 0.0f; }

  om::VstHost& host;
  int frames;
  double period;
  std::vector<float> l[om::kNumDecks], r[om::kNumDecks];
  std::vector<float> histL[om::kNumDecks];
  Source src[om::kNumDecks] = {Source(1), Source(2), Source(3), Source(4)};
  bool active[om::kNumDecks] = {};
  int64_t block = 0;
};

inline double percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  return v[std::min(v.size() - 1, static_cast<size_t>(p * (v.size() - 1) + 0.5))];
}

inline std::filesystem::path testDir() { return std::filesystem::path(__FILE__).parent_path(); }

inline std::string againPath() {
  const std::string e = omtest::envString("OM_TEST_VST_AGAIN");
  if (!e.empty()) return e;
  return u8((testDir() / ".." / ".." / ".." / "tpb" / "VST3" / "Release" / "again-sample-accurate.vst3").lexically_normal());
}

inline std::string kotelnikovPath() {
  const std::string e = omtest::envString("OM_TEST_VST_KOTELNIKOV");
  if (!e.empty()) return e;
  const std::string local = omtest::envString("LOCALAPPDATA");
  if (local.empty()) return {};
  return u8(fromU8(local) / "Programs" / "Common" / "VST3" / "TDR Kotelnikov.vst3");
}

inline bool exists(const std::string& p) {
  std::error_code ec;
  return !p.empty() && std::filesystem::exists(fromU8(p), ec);
}

// A folder the tests may write to (copies of plugins under non-ASCII names):
// OM_TEST_VST_SCRATCH, else the system temporary folder.
inline std::filesystem::path scratchDir() {
  const std::string e = omtest::envString("OM_TEST_VST_SCRATCH");
  return e.empty() ? std::filesystem::temp_directory_path() : fromU8(e);
}

// The AGain Sample Accurate state: [u32 2][u32 0 (bypass)][f64 0][u32 1 (gain)][f64 g], no controller state.
inline std::string againState(double gain) {
  std::string comp;
  auto u32 = [&](uint32_t v) { comp.append(reinterpret_cast<const char*>(&v), 4); };
  auto f64 = [&](double v) { comp.append(reinterpret_cast<const char*>(&v), 8); };
  u32(2);
  u32(0);
  f64(0.0);
  u32(1);
  f64(gain);
  std::string blob;
  const uint32_t n1 = static_cast<uint32_t>(comp.size()), n2 = 0;
  blob.append(reinterpret_cast<const char*>(&n1), 4);
  blob += comp;
  blob.append(reinterpret_cast<const char*>(&n2), 4);
  return om::base64Encode(blob);
}

inline bool needSdk() { return om::vstSdkAvailable(nullptr); }

// ---- om-spy (tests/vst/spy) ----
inline std::string spyPath() {
  const std::string e = omtest::envString("OM_TEST_VST_SPY");
  if (!e.empty()) return e;
  return u8((testDir() / ".." / ".." / "build-tests-vst-spy" / "Release" / "om-spy.vst3").lexically_normal());
}
// "k=v k=v ..." -> value of k (as double; -1e300 when missing)
inline double reportValue(const std::string& report, const char* key) {
  const std::string k = std::string(" ") + key + "=";
  const std::string padded = " " + report;
  const size_t at = padded.find(k);
  return at == std::string::npos ? -1e300 : std::atof(padded.c_str() + at + k.size());
}
// "k=v k=v ..." -> the text of v (up to the next space; "" when missing)
inline std::string reportText(const std::string& report, const char* key) {
  const std::string k = std::string(" ") + key + "=";
  const std::string padded = " " + report;
  const size_t at = padded.find(k);
  if (at == std::string::npos) return {};
  const size_t from = at + k.size();
  const size_t to = padded.find(' ', from);
  return padded.substr(from, to == std::string::npos ? std::string::npos : to - from);
}
inline std::string spyReport(om::VstHost& host, int deck) {
  std::string blob;
  if (!om::base64Decode(host.getState(deck), blob) || blob.size() < 8) return {};
  uint32_t n1 = 0;
  std::memcpy(&n1, blob.data(), 4);
  return blob.substr(4, n1);
}
// A command for the spy, sent as its component state.
inline std::string spyCommand(const std::string& cmd) {
  std::string blob;
  const uint32_t n1 = static_cast<uint32_t>(cmd.size()), n2 = 0;
  blob.append(reinterpret_cast<const char*>(&n1), 4);
  blob += cmd;
  blob.append(reinterpret_cast<const char*>(&n2), 4);
  return om::base64Encode(blob);
}

}  // namespace vsttest
