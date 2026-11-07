// Acceptance tests of the vst-inline verification campaign (7 Nov 2026,
// owner: decoder), with the TDR Kotelnikov gap list V01-V25 as the checklist
// (HANDOFF/refs/vst-kotelnikov/gaps-corrected.md). Real plugins where they
// prove what a fake cannot: TDR Kotelnikov (184 samples of latency,
// transparent at its default settings, a compressing state), the om-spy test
// plugin (tests/vst/spy, report version 2), G9's fault plugins
// (OM_TEST_VST_FAULTS) and copies of plugins under non-ASCII folders
// (OM_TEST_VST_SCRATCH, else the temporary folder). Covered:
//  V01 bypass, dry/wet, late, busy and crashed paths aligned with the plugin
//      latency, through the mix ramps; a gap in the plugin's input stream
//      never lets misplaced audio out;
//  V05 a state that changes the latency at load, latency changes from the
//      host thread and from the audio thread (deactivate / reactivate);
//  V06 Kotelnikov under non-ASCII folders, a renamed bundle through both
//      scan routes, G9's non-ASCII bundle and dependency DLL;
//  V12 the whole MXCSR at every process() of every slot (next to Kotelnikov)
//      and on the host thread;
//  V13 kIoChanged both ways, restartComponent from the audio thread,
//      kParamTitlesChanged (queues grown off the audio thread), flags that
//      need no action;
//  V14 setup order, host name, non-null lists, IComponentHandler2;
//  V21 G9's crash and hang plugins (process, load, state, editor, unload)
//      never silence the other decks, with Kotelnikov on them;
//  V22 per-file scan errors (32-bit DLL, not a plugin, garbage, missing) in
//      UTF-8, and the class filter (instrument, offline-only);
//  plus Kotelnikov's state round trip, 20 load / unload cycles (memory,
//  handles, threads) and four instances over 10 s (CPU). Silent: no device;
//  no plugin window is shown on screen. SPEC.md §13.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#endif

#include "../om_test.h"
#include "om/dsp.h"
#include "om/rt.h"
#include "om/vst_insert.h"
#include "vst_test_util.h"

using namespace om;
using namespace vsttest;

namespace {

double toDb(double v) { return 20.0 * std::log10(std::max(v, 1e-30)); }

// Paces callbacks without burning a core (a high-resolution waitable timer
// where available), so the process CPU time measures the host's own work.
class SleepPacer {
 public:
  explicit SleepPacer(double periodSec) : period_(static_cast<int64_t>(periodSec * 1e9)), next_(nowNs()) {
#ifdef _WIN32
    timer_ = CreateWaitableTimerExW(nullptr, nullptr, 0x00000002 /* CREATE_WAITABLE_TIMER_HIGH_RESOLUTION */, TIMER_ALL_ACCESS);
#endif
  }
  ~SleepPacer() {
#ifdef _WIN32
    if (timer_) CloseHandle(timer_);
#endif
  }
  void wait() {
    next_ += period_;
    const int64_t left = next_ - nowNs();
#ifdef _WIN32
    if (timer_ && left > 200'000) {
      LARGE_INTEGER due;
      due.QuadPart = -(left - 100'000) / 100;  // relative, 100 ns units (wake 0.1 ms early)
      if (SetWaitableTimer(timer_, &due, 0, nullptr, nullptr, FALSE)) WaitForSingleObject(timer_, 50);
    }
#endif
    while (nowNs() < next_) std::this_thread::yield();
  }

 private:
  int64_t period_, next_;
#ifdef _WIN32
  HANDLE timer_ = nullptr;
#endif
};

// Paced callbacks with full input / output histories of every deck (the
// callback of the core as far as the inserts go: begin() for every deck,
// then end(); buffers processed in place).
struct Bench {
  Bench(VstHost& h, int f, double rate, float amplitude = 0.25f, bool sleepPacing = false)
      : host(h), frames(f), sampleRate(rate), period(f / rate), amp(amplitude), pace(f / rate), sleepPace(f / rate),
        sleeping(sleepPacing) {
    for (int d = 0; d < kNumDecks; d++) {
      l[d].assign(static_cast<size_t>(f), 0.0f);
      r[d].assign(static_cast<size_t>(f), 0.0f);
      src[d] = Source(static_cast<uint32_t>(4242 + 31 * d));
    }
  }
  // One paced callback; returns its duration (ns).
  int64_t step() {
    const int64_t n0 = blocks * frames;
    for (int d = 0; d < kNumDecks; d++) {
      for (int i = 0; i < frames; i++) {
        const float v = gen ? gen(d, n0 + i) : 2.0f * amp * src[d].next();
        l[d][static_cast<size_t>(i)] = v;
        r[d][static_cast<size_t>(i)] = -0.5f * v;
      }
      inL[d].insert(inL[d].end(), l[d].begin(), l[d].end());
      inR[d].insert(inR[d].end(), r[d].begin(), r[d].end());
    }
    const int64_t t0 = nowNs();
    {
      rt::Scope audio;  // the audio side never allocates nor frees
      for (int d = 0; d < kNumDecks; d++)
        if (pendingMix[d] >= 0.0f) {
          host.setMix(d, pendingMix[d]);
          pendingMix[d] = -1.0f;
        }
      host.startCallback(period);
      for (int d = 0; d < kNumDecks; d++) active[d] = host.begin(d, l[d].data(), r[d].data(), frames);
      for (int d = 0; d < kNumDecks; d++)
        if (active[d]) host.end(d, l[d].data(), r[d].data(), frames);
    }
    const int64_t dur = nowNs() - t0;
    for (int d = 0; d < kNumDecks; d++) {
      outL[d].insert(outL[d].end(), l[d].begin(), l[d].end());
      outR[d].insert(outR[d].end(), r[d].begin(), r[d].end());
    }
    callbackMs.push_back(dur / 1e6);
    blocks++;
    if (sleeping) sleepPace.wait();
    else pace.wait();
    return dur;
  }
  void run(int n) {
    for (int i = 0; i < n; i++) step();
  }
  void setMix(int d, float m) { pendingMix[d] = m; }
  int64_t pos() const { return blocks * frames; }
  float in(int d, int64_t n) const { return n >= 0 && n < static_cast<int64_t>(inL[d].size()) ? inL[d][static_cast<size_t>(n)] : 0.0f; }
  float inRight(int d, int64_t n) const {
    return n >= 0 && n < static_cast<int64_t>(inR[d].size()) ? inR[d][static_cast<size_t>(n)] : 0.0f;
  }
  // max |out - in delayed by lag| over frames [a, b) of deck d, both channels
  double alignedErr(int d, int64_t a, int64_t b, int lag) const {
    double e = 0;
    b = std::min<int64_t>(b, static_cast<int64_t>(outL[d].size()));
    for (int64_t n = std::max<int64_t>(a, 0); n < b; n++) {
      e = std::max(e, static_cast<double>(std::fabs(outL[d][static_cast<size_t>(n)] - in(d, n - lag))));
      e = std::max(e, static_cast<double>(std::fabs(outR[d][static_cast<size_t>(n)] - inRight(d, n - lag))));
    }
    return e;
  }
  // blocks of [a, b) (whole blocks) whose output is not exactly the input delayed by lag
  int wrongBlocks(int d, int64_t a, int64_t b, int lag) const {
    int wrong = 0;
    for (int64_t s = a; s + frames <= b; s += frames)
      if (alignedErr(d, s, s + frames, lag) != 0.0) wrong++;
    return wrong;
  }

  VstHost& host;
  int frames;
  double sampleRate, period;
  float amp;
  Pacer pace;
  SleepPacer sleepPace;
  bool sleeping;
  std::function<float(int, int64_t)> gen;  // input of deck d at frame n (left; right = -0.5 left)
  std::vector<float> l[kNumDecks], r[kNumDecks];
  std::vector<float> inL[kNumDecks], inR[kNumDecks], outL[kNumDecks], outR[kNumDecks];
  Source src[kNumDecks] = {Source(1), Source(2), Source(3), Source(4)};
  float pendingMix[kNumDecks] = {-1.0f, -1.0f, -1.0f, -1.0f};
  bool active[kNumDecks] = {};
  std::vector<double> callbackMs;
  int64_t blocks = 0;
};

// om-spy of report version 2 (an older binary would silently skip checks)
std::string spyReportV2(VstHost& host, int deck) {
  const std::string rep = spyReport(host, deck);
  if (reportValue(rep, "spyVersion") < 2)
    omtest::fail("om-spy.vst3 report version 2", __FILE__, __LINE__,
                 "om-spy.vst3 is older than tests/vst/spy/om_spy_plugin.cxx: rebuild it (" + spyPath() + ")");
  return rep;
}

// Index of `token` in the spy's comma-separated call order, from `from` (-1 = absent).
int seqIndex(const std::vector<std::string>& seq, const std::string& token, int from = 0) {
  for (int i = std::max(0, from); i < static_cast<int>(seq.size()); i++)
    if (seq[static_cast<size_t>(i)] == token) return i;
  return -1;
}
std::vector<std::string> seqOf(const std::string& report) {
  std::vector<std::string> out;
  std::stringstream ss(reportText(report, "seq"));
  for (std::string t; std::getline(ss, t, ',');) out.push_back(t);
  return out;
}

// G9's fault plugin number n (OM_TEST_VST_FAULTS)
std::string faultPlugin(int n) {
  const std::string dir = omtest::envString("OM_TEST_VST_FAULTS");
  return dir.empty() ? std::string() : u8(fromU8(dir) / ("om-fault-" + std::to_string(n) + ".vst3"));
}

// A fresh copy of a plugin file or bundle under `dst`; a bundle's DLL takes
// the bundle's new name. false = could not prepare it.
bool copyPlugin(const std::filesystem::path& src, const std::filesystem::path& dst, bool dropModuleInfo = false) {
  std::error_code ec;
  std::filesystem::remove_all(dst, ec);  // (a DLL still mapped by an earlier run: copy over it)
  std::filesystem::create_directories(dst.parent_path(), ec);
  if (std::filesystem::is_directory(src, ec)) {
    std::filesystem::copy(src, dst, std::filesystem::copy_options::recursive | std::filesystem::copy_options::overwrite_existing, ec);
    if (ec) return false;
    const std::filesystem::path win = dst / "Contents" / "x86_64-win";
    if (!std::filesystem::exists(win / dst.filename(), ec)) {
      std::filesystem::rename(win / src.filename(), win / dst.filename(), ec);
      if (ec) return false;
    }
    if (dropModuleInfo) std::filesystem::remove(dst / "Contents" / "Resources" / "moduleinfo.json", ec);
    return true;
  }
  std::filesystem::copy_file(src, dst, std::filesystem::copy_options::overwrite_existing, ec);
  return !ec || std::filesystem::exists(dst);
}

bool validUtf8(const std::string& s) {
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    const int n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
    if (!n || i + n > s.size()) return false;
    for (int k = 1; k < n; k++)
      if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80) return false;
    i += static_cast<size_t>(n);
  }
  return true;
}

// ---- TDR Kotelnikov's state (JUCE VST3 wrapper, VST2-compatible) ----
//   blob = [u32 n1][component][u32 n2][controller]
//   component = "VstW" u32BE 8, u32BE 1, u32BE bypass, "CcnK" u32BE byteSize, "FBCh", ..., u32BE chunkSize, chunk
//   chunk = "VC2!" u32LE xmlLen, xml, tail (JUCE private data)
void putBe32(std::string& s, size_t at, uint32_t v) {
  for (int k = 0; k < 4; k++) s[at + static_cast<size_t>(k)] = static_cast<char>((v >> (24 - 8 * k)) & 0xFF);
}
// The component's XML ("" when not a Kotelnikov state).
std::string kotelnikovXml(const std::string& b64) {
  std::string blob;
  if (!base64Decode(b64, blob) || blob.size() < 8) return {};
  uint32_t n1 = 0;
  std::memcpy(&n1, blob.data(), 4);
  if (4ull + n1 > blob.size()) return {};
  const std::string comp = blob.substr(4, n1);
  const size_t v = comp.find("VC2!");
  if (comp.compare(0, 4, "VstW") != 0 || comp.size() < 24 || comp.compare(16, 4, "CcnK") != 0 || v == std::string::npos ||
      v + 8 > comp.size())
    return {};
  uint32_t xmlLen = 0;
  std::memcpy(&xmlLen, comp.data() + v + 4, 4);
  if (v + 8 + xmlLen > comp.size()) return {};
  return comp.substr(v + 8, xmlLen);
}
// Sets parameters (display attribute of the root element and its <logical>
// value) and fixes every size field. "" = not a Kotelnikov state.
std::string kotelnikovEdit(const std::string& b64, const std::vector<std::pair<std::string, std::string>>& params) {
  std::string blob;
  if (!base64Decode(b64, blob) || blob.size() < 8) return {};
  uint32_t n1 = 0;
  std::memcpy(&n1, blob.data(), 4);
  if (4ull + n1 + 4 > blob.size()) return {};
  const std::string comp = blob.substr(4, n1);
  uint32_t n2 = 0;
  std::memcpy(&n2, blob.data() + 4 + n1, 4);
  const std::string ctrl = blob.substr(8 + n1, n2);
  const size_t v = comp.find("VC2!");
  if (comp.compare(0, 4, "VstW") != 0 || comp.size() < 24 || comp.compare(16, 4, "CcnK") != 0 || v == std::string::npos) return {};
  uint32_t xmlLen = 0;
  std::memcpy(&xmlLen, comp.data() + v + 4, 4);
  std::string xml = comp.substr(v + 8, xmlLen);
  const std::string tail = comp.substr(v + 8 + xmlLen);
  for (const auto& [name, value] : params) {
    for (const char* element : {"<TDRKotelnikov ", "<logical "}) {
      const size_t e = xml.find(element);
      if (e == std::string::npos) return {};
      const size_t a = xml.find(" " + name + "=\"", e);
      const size_t end = xml.find('>', e);
      if (a == std::string::npos || a > end) return {};
      const size_t q0 = a + name.size() + 3, q1 = xml.find('"', q0);
      xml.replace(q0, q1 - q0, value);
    }
  }
  std::string chunk = "VC2!";
  const uint32_t xl = static_cast<uint32_t>(xml.size());
  chunk.append(reinterpret_cast<const char*>(&xl), 4);
  chunk += xml;
  chunk += tail;
  std::string pre = comp.substr(0, v);
  putBe32(pre, v - 4, static_cast<uint32_t>(chunk.size()));                   // FXB chunk size
  putBe32(pre, 20, static_cast<uint32_t>(pre.size() - 24 + chunk.size()));   // CcnK byte size
  const std::string newComp = pre + chunk;
  std::string out;
  const uint32_t m1 = static_cast<uint32_t>(newComp.size()), m2 = static_cast<uint32_t>(ctrl.size());
  out.append(reinterpret_cast<const char*>(&m1), 4);
  out += newComp;
  out.append(reinterpret_cast<const char*>(&m2), 4);
  out += ctrl;
  return base64Encode(out);
}
std::string xmlAttr(const std::string& xml, const char* element, const std::string& name) {
  const size_t e = xml.find(element);
  if (e == std::string::npos) return {};
  const size_t a = xml.find(" " + name + "=\"", e);
  if (a == std::string::npos) return {};
  const size_t q0 = a + name.size() + 3;
  return xml.substr(q0, xml.find('"', q0) - q0);
}

}  // namespace

// ===========================================================================
// V01: every dry path aligned with the plugin latency, also during the mix ramps
// ===========================================================================
OM_TEST(vst_v01_kotelnikov_mix_ramps_stay_aligned) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = kotelnikovPath();
  if (!exists(path)) OM_SKIP("TDR Kotelnikov.vst3 not installed (OM_TEST_VST_KOTELNIKOV)");
  for (double rate : {48000.0, 44100.0}) {
    VstHost host;
    std::string err;
    host.start(rate, kMaxBlockFrames, &err);
    const VstLoadResult r = host.load(0, path, "");
    if (!r.ok) omtest::fail("load Kotelnikov", __FILE__, __LINE__, r.error);
    OM_CHECK(r.latency == 184);
    const int L = r.latency;
    Bench b(host, 128, rate, 0.2f);  // white noise, -14 dBFS peak: under Kotelnikov's default threshold (0 dB)
    struct Phase {
      float mix;
      double sec;
    };
    // the ramps (setTargetAtTime, tau 10 ms) are inside the checked spans
    const Phase phases[] = {{1.0f, 0.6}, {0.5f, 0.6}, {0.0f, 0.6}, {1.0f, 0.6}, {0.25f, 0.6}, {1.0f, 0.4}};
    std::string line;
    double worst = 0;
    for (const Phase& p : phases) {
      const int64_t a = b.pos();
      b.setMix(0, p.mix);
      b.run(static_cast<int>(p.sec * rate / 128));
      const double e = b.alignedErr(0, a, b.pos(), L);
      worst = std::max(worst, e);
      char t[64];
      std::snprintf(t, sizeof t, " mix %.2f: %.1f dB;", p.mix, toDb(e));
      line += t;
    }
    std::printf("  [info] Kotelnikov @ %.0f Hz, output - input delayed by %d samples, ramps included:%s worst %.1f dBFS\n", rate, L,
                line.c_str(), toDb(worst));
    OM_CHECK(toDb(worst) < -120.0);  // one single copy of the signal at every mix: no comb filter, no jump
  }
}

// The om-spy (a real VST3 binary, a pure delay of its latency): 3000 samples
// at mix 1 / 0 / 0.5, late blocks, busy blocks (a gap in its input) and a
// crash all keep the output exactly the input delayed by the latency.
OM_TEST(vst_v01_spy_latency_late_busy_and_crash_paths_aligned) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = spyPath();
  if (!exists(path)) OM_SKIP("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  const VstLoadResult r = host.load(0, path, "");
  if (!r.ok) omtest::fail("load spy", __FILE__, __LINE__, r.error);
  spyReportV2(host, 0);
  Bench b(host, 256, 48000, 0.25f);  // period 5.33 ms, deadline 1.87 ms
  b.run(20);
  OM_CHECK(host.setState(0, spyCommand("LAT:3000")));
  b.run(1);
  OM_CHECK(host.latencyFrames(0) == 3000);
  const int L = 3000;
  // (the mix ramp: tau 10 ms, snapped to its target within 1e-6, i.e. after ~14 tau = 6600 frames)
  int64_t a = b.pos();
  b.run(30);
  const double wet = b.alignedErr(0, a, b.pos(), L);
  a = b.pos();
  b.setMix(0, 0.0f);
  b.run(45);
  const double rampDown = b.alignedErr(0, a, a + 7680, L), bypass = b.alignedErr(0, a + 7680, b.pos(), L);
  a = b.pos();
  b.setMix(0, 0.5f);
  b.run(45);
  const double half = b.alignedErr(0, a + 7680, b.pos(), L), rampHalf = b.alignedErr(0, a, a + 7680, L);
  b.setMix(0, 1.0f);
  b.run(20);
  // late blocks: 3 ms > the 1.87 ms deadline, < the period (the plugin's stream stays continuous)
  const VstSlotStatus s0 = host.status(0);
  a = b.pos();
  OM_CHECK(host.setState(0, spyCommand("SLEEP:3:6")));
  b.run(30);
  const VstSlotStatus s1 = host.status(0);
  const double late = b.alignedErr(0, a, b.pos(), L);
  // busy blocks: 8 ms > the period, so the next block finds the worker busy and
  // the plugin never sees it (a gap in its input stream)
  a = b.pos();
  OM_CHECK(host.setState(0, spyCommand("SLEEP:8:2")));
  b.run(40);
  const VstSlotStatus s2 = host.status(0);
  const double busy = b.alignedErr(0, a, b.pos(), L);
  int busyWrong = b.wrongBlocks(0, a, b.pos(), L);
  // a crash in process(): the latency-aligned dry from then on
  a = b.pos();
  OM_CHECK(host.setState(0, spyCommand("CRASH")));
  b.run(30);
  const VstSlotStatus s3 = host.status(0);
  const double crashed = b.alignedErr(0, a, b.pos(), L);
  std::printf("  [info] spy at %d samples: wet %.1f dB, ramp to bypass %.1f dB, bypass %.1f dB, ramp to 0.5 %.1f dB, mix 0.5 %.1f dB; "
              "late blocks +%llu: %.1f dB; busy skips +%llu (late +%llu): %.1f dB, %d wrong blocks; crashed %d: %.1f dB\n",
              L, toDb(wet), toDb(rampDown), toDb(bypass), toDb(rampHalf), toDb(half),
              static_cast<unsigned long long>(s1.lateBlocks - s0.lateBlocks), toDb(late),
              static_cast<unsigned long long>(s2.busySkips - s1.busySkips), static_cast<unsigned long long>(s2.lateBlocks - s1.lateBlocks),
              toDb(busy), busyWrong, s3.crashed ? 1 : 0, toDb(crashed));
  OM_CHECK(wet == 0.0 && bypass == 0.0 && half == 0.0);
  OM_CHECK(rampDown < 1e-6 && rampHalf < 1e-6);
  OM_CHECK(s1.lateBlocks - s0.lateBlocks >= 5 && late == 0.0);
  OM_CHECK(s2.busySkips > s1.busySkips);
  OM_CHECK(busy == 0.0);  // no misplaced plugin output after the gap
  OM_CHECK(s3.crashed && crashed == 0.0);
}

// ===========================================================================
// V05: latency at load from a state, and the order of a latency change
// ===========================================================================
OM_TEST(vst_v05_spy_state_latency_at_load_and_reactivation_order) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = spyPath();
  if (!exists(path)) OM_SKIP("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  // a saved state whose latency differs from the default (64): known before the first block
  const VstLoadResult r = host.load(0, path, "", spyCommand("SILENTLAT:300"));
  if (!r.ok) omtest::fail("load spy with a state", __FILE__, __LINE__, r.error);
  spyReportV2(host, 0);
  OM_CHECK(r.stateRestored && r.latency == 300);
  Bench b(host, 256, 48000, 0.25f);
  b.run(30);
  const double first = b.alignedErr(0, 0, b.pos(), 300);
  OM_CHECK(host.latencyFrames(0) == 300);
  // a latency change from the host thread: setProcessing(0), setActive(0), setActive(1), the latency read afterwards
  OM_CHECK(host.setState(0, spyCommand("SEQ:0")));
  OM_CHECK(host.setState(0, spyCommand("LAT:500")));
  b.run(1);
  OM_CHECK(host.latencyFrames(0) == 500);
  const int64_t a = b.pos();
  b.run(30);
  const double after = b.alignedErr(0, a, b.pos(), 500);
  const std::string rep = spyReportV2(host, 0);
  const std::vector<std::string> seq = seqOf(rep);
  const int p0 = seqIndex(seq, "proc0"), a0 = seqIndex(seq, "act0", p0), a1 = seqIndex(seq, "act1", a0),
            lat = seqIndex(seq, "lat", a1), p1 = seqIndex(seq, "proc1", a1);
  std::printf("  [info] spy loaded with a 300-sample state: reported %d, delay error from the first block %.1f dB; LAT:500 -> %d, "
              "%.1f dB; call order %s\n",
              r.latency, toDb(first), host.latencyFrames(0), toDb(after), reportText(rep, "seq").c_str());
  OM_CHECK(first == 0.0 && after == 0.0);
  OM_CHECK(p0 >= 0 && a0 > p0 && a1 > a0 && lat > a1 && p1 > a1);
}

// ===========================================================================
// V12: the whole MXCSR at every process() of every slot and on the host thread
// ===========================================================================
OM_TEST(vst_v12_mxcsr_every_call_every_slot_and_host_thread) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
#if !defined(OM_FPENV_X86)
  OM_SKIP("MXCSR is x86 / x64 only");
#else
  const std::string path = spyPath();
  if (!exists(path)) OM_SKIP("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  const std::string kot = kotelnikovPath();
  const bool withKotelnikov = exists(kot);
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  if (withKotelnikov) OM_CHECK(host.load(0, kot, "").ok);  // Kotelnikov sets FTZ itself on its first process()
  for (int d : {1, 2}) {
    const VstLoadResult r = host.load(d, path, "");
    if (!r.ok) omtest::fail("load spy", __FILE__, __LINE__, r.error);
  }
  const uint64_t audioFp = dsp::fpControl();
  Bench b(host, 128, 48000, 0.2f);
  b.run(200);
  OM_CHECK(dsp::fpControl() == audioFp);  // the callback's own thread is never touched
  std::string line;
  for (int d : {1, 2}) {
    const std::string rep = spyReportV2(host, d);
    const int calls = static_cast<int>(reportValue(rep, "calls"));
    const unsigned first = static_cast<unsigned>(reportValue(rep, "mxcsrFirst"));
    const unsigned lastv = static_cast<unsigned>(reportValue(rep, "mxcsrLast"));
    const int bad = static_cast<int>(reportValue(rep, "mxcsrBad"));
    char t[160];
    std::snprintf(t, sizeof t, " deck %d: %d calls, MXCSR first 0x%04X last 0x%04X, %d not 0x9FC0;", d + 1, calls, first, lastv, bad);
    line += t;
    OM_CHECK(calls >= 190 && bad == 0 && (first & ~0x3Fu) == 0x9FC0u);  // FTZ | DAZ | every exception masked | nearest
  }
  // the host thread: each setState leaves MXCSR changed; the next host call must find it put back
  int hostBad = 0;
  unsigned base = 0, atGet = 0, atSet = 0;
  for (int i = 0; i < 5; i++) {
    OM_CHECK(host.setState(1, spyCommand("SEQ:0")));
    const std::string rep = spyReportV2(host, 1);
    base = static_cast<unsigned>(reportValue(rep, "hostCsrBase"));
    atGet = static_cast<unsigned>(reportValue(rep, "hostCsrAtGet"));
    atSet = static_cast<unsigned>(reportValue(rep, "hostCsrAtSet"));
    hostBad = static_cast<int>(reportValue(rep, "hostCsrBad"));
  }
  double kotErr = -1;
  if (withKotelnikov) kotErr = b.alignedErr(0, 0, b.pos(), 184);
  std::printf("  [info] MXCSR:%s host thread base 0x%04X, at setState 0x%04X, at getState after 5 changing setState calls 0x%04X "
              "(%d control words wrong); Kotelnikov next to them: %s%.1f dB\n",
              line.c_str(), base, atSet, atGet, hostBad, withKotelnikov ? "null " : "not installed ", toDb(kotErr));
  OM_CHECK(hostBad == 0 && (atGet & ~0x3Fu) == (base & ~0x3Fu));
  if (withKotelnikov) OM_CHECK(kotErr == 0.0);  // still bit-exact at its defaults, 184 samples
#endif
}

// ===========================================================================
// V14: setup order (SDK states), host name, lists, IComponentHandler2
// ===========================================================================
OM_TEST(vst_v14_setup_order_host_name_and_lists) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = spyPath();
  if (!exists(path)) OM_SKIP("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  const VstLoadResult r = host.load(0, path, "");
  if (!r.ok) omtest::fail("load spy", __FILE__, __LINE__, r.error);
  Bench b(host, 256, 48000);
  b.run(10);
  const std::string rep = spyReportV2(host, 0);
  const std::vector<std::string> seq = seqOf(rep);
  const int handler = seqIndex(seq, "handler"), csync = seqIndex(seq, "csync"), canss = seqIndex(seq, "canss"),
            arr = seqIndex(seq, "arr"), setup = seqIndex(seq, "setup"), busIn = seqIndex(seq, "busIn1"),
            busOut = seqIndex(seq, "busOut1"), act = seqIndex(seq, "act1"), proc = seqIndex(seq, "proc1"),
            lat = seqIndex(seq, "lat", act);
  int csyncCount = 0;
  for (const std::string& t : seq) csyncCount += t == "csync";
  std::printf("  [info] spy at load: host '%s', call order %s, null lists %g, IComponentHandler2 %g\n", reportText(rep, "host").c_str(),
              reportText(rep, "seq").c_str(), reportValue(rep, "nullLists"), reportValue(rep, "handler2"));
  OM_CHECK(reportText(rep, "host") == "OpenMix");
  OM_CHECK(reportValue(rep, "nullLists") == 0 && reportValue(rep, "handler2") == 1);
  OM_CHECK(handler >= 0 && csync > handler && csyncCount == 1);  // the controller follows the component state, once
  OM_CHECK(canss >= 0 && canss < setup);                            // [Initialized]
  OM_CHECK(arr >= 0 && arr < setup);                                // [Initialized | Setup Done]
  OM_CHECK(setup >= 0 && busIn > setup && busOut > setup);          // activateBus: [Setup Done]
  OM_CHECK(act > busIn && act > busOut && proc > act && lat > act);  // latency read after setActive(true)
}

// ===========================================================================
// V13: restartComponent
// ===========================================================================
OM_TEST(vst_v13_restart_component_io_audio_thread_params_and_no_op_flags) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = spyPath();
  if (!exists(path)) OM_SKIP("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  const VstLoadResult r = host.load(0, path, "");
  if (!r.ok) omtest::fail("load spy", __FILE__, __LINE__, r.error);
  spyReportV2(host, 0);
  Bench b(host, 256, 48000);
  b.run(20);
  auto lastBlock = [&](auto pred) {
    bool ok = true;
    for (int i = 0; i < 256; i++) ok = ok && pred(b.l[0][static_cast<size_t>(i)], b.r[0][static_cast<size_t>(i)]);
    return ok;
  };
  // kIoChanged, stereo -> mono: deactivated, buses set again, reactivated; the mono output on both channels
  OM_CHECK(host.setState(0, spyCommand("SEQ:0")));
  OM_CHECK(host.setState(0, spyCommand("IO:1")));
  bool mono = false;
  for (int i = 0; i < 100 && !mono; i++) {
    b.run(1);
    mono = lastBlock([](float x, float y) { return x == y; });
  }
  const std::string repIo = spyReportV2(host, 0);
  const std::vector<std::string> seqIo = seqOf(repIo);
  const int p0 = seqIndex(seqIo, "proc0"), a0 = seqIndex(seqIo, "act0", p0), ar = seqIndex(seqIo, "arr", a0),
            bo = seqIndex(seqIo, "busOut1", ar), a1 = seqIndex(seqIo, "act1", bo), p1 = seqIndex(seqIo, "proc1", a1);
  // ... and back to stereo (a channel count that grows)
  OM_CHECK(host.setState(0, spyCommand("IO:2")));
  bool stereo = false;
  for (int i = 0; i < 100 && !stereo; i++) {
    b.run(1);
    stereo = lastBlock([](float x, float y) { return y == -0.5f * x; }) && !lastBlock([](float x, float y) { return x == y; });
  }
  // restartComponent(kLatencyChanged) called by the plugin from inside process() (the audio thread)
  const double deact0 = reportValue(spyReportV2(host, 0), "deactivations");
  OM_CHECK(host.setState(0, spyCommand("RTLAT:200")));
  for (int i = 0; i < 100 && host.latencyFrames(0) != 200; i++) b.run(1);
  const int rtLat = host.latencyFrames(0);
  b.run(10);
  int64_t a = b.pos();
  b.run(20);
  const double rtErr = b.alignedErr(0, a, b.pos(), 200);
  const double deact1 = reportValue(spyReportV2(host, 0), "deactivations");
  // flags that need no action (kParamValuesChanged, kMidiCCAssignmentChanged): no deactivation, no gap
  OM_CHECK(host.setState(0, spyCommand("RESTART:4")));
  OM_CHECK(host.setState(0, spyCommand("RESTART:16")));
  a = b.pos();
  b.run(10);
  const double noOpErr = b.alignedErr(0, a, b.pos(), 200);
  const double deact2 = reportValue(spyReportV2(host, 0), "deactivations");
  // kParamTitlesChanged with 80 parameters (16 at load): the parameter queues grow on the host thread, and 80
  // edits from the plugin's editor all reach process() with no allocation on the audio side
  OM_CHECK(host.setState(0, spyCommand("PARAMS:80")));
  b.run(5);
  const uint64_t allocs0 = host.status(0).pluginAllocs;
  const double edits0 = reportValue(spyReportV2(host, 0), "edits");
  OM_CHECK(host.setState(0, spyCommand("EDITS:80")));
  b.run(5);
  const uint64_t allocs1 = host.status(0).pluginAllocs;
  const double edits1 = reportValue(spyReportV2(host, 0), "edits");
  std::printf("  [info] restartComponent: kIoChanged mono %d (order %s), stereo again %d; from the audio thread -> latency %d "
              "(%.1f dB, deactivations %g -> %g); kParamValuesChanged / kMidiCCAssignmentChanged: deactivations %g, %.1f dB; "
              "kParamTitlesChanged to 80 parameters: %g of 80 edits delivered, %llu allocation(s) on the worker\n",
              mono ? 1 : 0, reportText(repIo, "seq").c_str(), stereo ? 1 : 0, rtLat, toDb(rtErr), deact0, deact1, deact2, toDb(noOpErr),
              edits1 - edits0, static_cast<unsigned long long>(allocs1 - allocs0));
  OM_CHECK(mono && host.status(0).active);
  OM_CHECK(p0 >= 0 && a0 > p0 && ar > a0 && bo > ar && a1 > bo && p1 > a1);
  OM_CHECK(stereo);
  OM_CHECK(rtLat == 200 && rtErr == 0.0 && deact1 > deact0);
  OM_CHECK(deact2 == deact1 && noOpErr == 0.0);
  OM_CHECK(edits1 - edits0 == 80);
  OM_CHECK(allocs1 == allocs0);
}

// ===========================================================================
// V21: G9's fault plugins next to three Kotelnikovs
// ===========================================================================
namespace {
struct AroundRun {
  int blocks = 0;
  int wrong[kNumDecks] = {};
  double maxMs = 0, opMs = 0;
};
// Runs op() on a control thread while the paced callbacks go on (at least
// minSec in all, and tailSec after op returned); counts per deck the blocks
// whose output is not exactly the input delayed by lat[d].
AroundRun runAround(Bench& b, const std::function<void()>& op, double minSec, double tailSec, const int lat[kNumDecks],
                    const std::function<void()>& perBlock = {}) {
  AroundRun ar;
  std::atomic<bool> done{false};
  std::atomic<int64_t> opNs{0};
  const int64_t t0 = nowNs();
  int64_t doneAt = 0;
  std::thread t([&] {
    const int64_t s = nowNs();
    op();
    opNs = nowNs() - s;
    done = true;
  });
  const int64_t first = b.pos();
  const size_t firstCb = b.callbackMs.size();
  for (;;) {
    b.step();
    if (perBlock) perBlock();
    const int64_t now = nowNs();
    if (done.load() && !doneAt) doneAt = now;
    if (doneAt && now - t0 >= static_cast<int64_t>(minSec * 1e9) && now - doneAt >= static_cast<int64_t>(tailSec * 1e9)) break;
    if (now - t0 > 40'000'000'000) break;  // (guard)
  }
  t.join();
  ar.opMs = opNs.load() / 1e6;
  ar.blocks = static_cast<int>((b.pos() - first) / b.frames);
  for (size_t i = firstCb; i < b.callbackMs.size(); i++) ar.maxMs = std::max(ar.maxMs, b.callbackMs[i]);
  for (int d = 0; d < kNumDecks; d++) ar.wrong[d] = b.wrongBlocks(d, first, b.pos(), lat[d]);
  return ar;
}
}  // namespace

OM_TEST(vst_v21_fault_plugins_never_silence_kotelnikov_decks) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  if (omtest::envString("OM_TEST_VST_FAULTS").empty()) OM_SKIP("OM_TEST_VST_FAULTS=<folder of om-fault-N.vst3> not set");
  for (int n : {0, 4, 5, 6, 7, 8, 9, 10, 11, 12})
    if (!exists(faultPlugin(n))) OM_SKIP("missing " + faultPlugin(n));
  const std::string kot = kotelnikovPath();
  const bool real = exists(kot);
  VstHost host;
  VstHostOptions o;
  o.editorsOffscreen = true;  // (om-fault-11 crashes in createView, before any window exists)
  host.setOptions(o);
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  const int lat[kNumDecks] = {0, 184, 184, 184};
  std::vector<std::shared_ptr<DelayFx>> fakes;
  for (int d = 1; d < kNumDecks; d++) {
    if (real) {
      const VstLoadResult r = host.load(d, kot, "");
      if (!r.ok) omtest::fail("load Kotelnikov", __FILE__, __LINE__, r.error);
    } else {
      fakes.push_back(std::make_shared<DelayFx>(184));
      OM_CHECK(host.attachProcessor(d, fakes.back(), 184, "delay").ok);
    }
  }
  Bench b(host, 128, 48000, 0.2f);  // period 2.667 ms, deadline 0.933 ms
  b.run(50);
  const double budgetMs = 0.35 * b.period * 1000.0 + 2.0;  // the spin stops at the deadline (+2 ms: scheduling on a shared PC)
  const size_t cbStart = b.callbackMs.size();
  std::string report;
  int othersWrong = 0, deck1Wrong = 0;
  double worstMs = 0;
  auto note = [&](const char* what, const std::string& result, const AroundRun& ar) {
    char t[320];
    std::snprintf(t, sizeof t, "\n           %-34s %-28s op %7.1f ms, %4d blocks, decks 2-4 wrong %d/%d/%d, deck 1 wrong %d, slowest callback %.3f ms",
                  what, result.c_str(), ar.opMs, ar.blocks, ar.wrong[1], ar.wrong[2], ar.wrong[3], ar.wrong[0], ar.maxMs);
    report += t;
    othersWrong += ar.wrong[1] + ar.wrong[2] + ar.wrong[3];
    deck1Wrong += ar.wrong[0];
    worstMs = std::max(worstMs, ar.maxMs);
  };
  auto loadFault = [&](int n) {
    const VstLoadResult r = host.load(0, faultPlugin(n), "");
    if (!r.ok) omtest::fail("load fault plugin", __FILE__, __LINE__, std::to_string(n) + ": " + r.error);
  };
  // process() sleeps 4 s at its 20th block: hung after 2 s
  {
    loadFault(6);
    uint8_t ev = 0;
    const AroundRun ar = runAround(b, [] {}, 2.6, 0.0, lat, [&] { ev |= host.takeEvents(0); });
    note("om-fault-6 process() hangs 4 s", (ev & kVstHung) ? "hung" : "NOT hung", ar);
    OM_CHECK((ev & kVstHung) && host.status(0).hung);
    host.unload(0);  // its worker is abandoned inside the plugin
  }
  // process() faults after 20 blocks
  {
    loadFault(5);
    uint8_t ev = 0;
    const AroundRun ar = runAround(b, [] {}, 0.5, 0.0, lat, [&] { ev |= host.takeEvents(0); });
    note("om-fault-5 process() crashes", (ev & kVstCrashed) ? "crashed" : "NOT crashed", ar);
    OM_CHECK((ev & kVstCrashed) && host.status(0).crashed);
    host.unload(0);
  }
  // initialize() faults during the load
  {
    VstLoadResult r;
    const AroundRun ar = runAround(b, [&] { r = host.load(0, faultPlugin(4), ""); }, 0.3, 0.1, lat);
    note("om-fault-4 initialize() crashes", "load " + (r.ok ? std::string("ok") : r.code), ar);
    OM_CHECK(!r.ok && r.code == "crashed");
  }
  // setState() faults
  {
    loadFault(12);
    bool ok = true;
    const AroundRun ar = runAround(b, [&] { ok = host.setState(0, spyCommand("x")); }, 0.3, 0.1, lat);
    note("om-fault-12 setState() crashes", std::string("setState ") + (ok ? "true" : "false") + (host.status(0).crashed ? ", crashed" : ""), ar);
    OM_CHECK(!ok && host.status(0).crashed);
    host.unload(0);
  }
  // getState() faults: already during the load (the host reads the component
  // state there to synchronise the controller, V14)
  {
    VstLoadResult r;
    const AroundRun ar = runAround(b, [&] { r = host.load(0, faultPlugin(7), ""); }, 0.3, 0.1, lat);
    note("om-fault-7 getState() crashes", "load " + (r.ok ? std::string("ok") : r.code), ar);
    OM_CHECK(!r.ok && r.code == "crashed");
  }
  // createView() faults (no window is ever made)
  {
    loadFault(11);
    std::string e;
    const AroundRun ar = runAround(b, [&] { e = host.openEditor(0, 0); }, 0.3, 0.1, lat);
    note("om-fault-11 createView() crashes", "editor: " + (e.empty() ? std::string("opened") : e), ar);
    OM_CHECK(!e.empty() && host.status(0).crashed && !host.status(0).editorOpen);
    host.unload(0);
  }
  // setActive(false) and terminate() fault during the unload
  for (int n : {10, 8}) {
    loadFault(n);
    const AroundRun ar = runAround(b, [&] { host.unload(0); }, 0.3, 0.1, lat);
    note(n == 10 ? "om-fault-10 setActive(false) crashes" : "om-fault-8 terminate() crashes", host.status(0).loaded ? "still loaded" : "unloaded", ar);
    OM_CHECK(!host.status(0).loaded);
    VstLoadResult again;
    const AroundRun ar2 = runAround(b, [&] { again = host.load(0, faultPlugin(0), ""); }, 0.2, 0.1, lat);
    note("  then om-fault-0 on that deck", again.ok ? "load ok" : again.error, ar2);
    OM_CHECK(again.ok);
    host.unload(0);
  }
  // initialize() sleeps 6 s, the load gives up after 1.5 s: the host thread is
  // stalled meanwhile (calls fail at once, the audio goes on), then recovers
  {
    VstTimeouts t;
    t.load = 1500;
    host.setTimeouts(t);
    VstLoadResult r;
    const AroundRun ar = runAround(b, [&] { r = host.load(0, faultPlugin(9), ""); }, 0.0, 0.1, lat);
    note("om-fault-9 initialize() sleeps 6 s", "load " + (r.ok ? std::string("ok") : r.code), ar);
    OM_CHECK(!r.ok && r.code == "timeout" && ar.opMs >= 1400 && ar.opMs < 4000);
    VstLoadResult busy;
    const AroundRun ar2 = runAround(b, [&] { busy = host.load(0, faultPlugin(0), ""); }, 0.0, 0.1, lat);
    note("  a load meanwhile", "load " + (busy.ok ? std::string("ok") : busy.code), ar2);
    OM_CHECK(!busy.ok && busy.code == "busy" && ar2.opMs < 500);
    const AroundRun ar3 = runAround(b, [&] {
      for (int i = 0; i < 150 && host.status(0).busy; i++) std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }, 0.0, 0.1, lat);
    note("  waiting for the host thread", host.status(0).busy ? "still stalled" : "answers again", ar3);
    OM_CHECK(!host.status(0).busy);
    host.setTimeouts(VstTimeouts());
    VstLoadResult again;
    const AroundRun ar4 = runAround(b, [&] { again = host.load(0, faultPlugin(0), ""); }, 0.2, 0.1, lat);
    note("  then om-fault-0", again.ok ? "load ok" : again.error, ar4);
    OM_CHECK(again.ok);
    host.unload(0);
  }
  // the host is still whole: a fourth Kotelnikov on the faulty deck
  if (real) {
    const int lat4[kNumDecks] = {184, 184, 184, 184};
    VstLoadResult r4;
    runAround(b, [&] { r4 = host.load(0, kot, ""); }, 0.0, 0.0, lat);
    b.run(10);  // (a plugin starts with its latency's worth of silence)
    const AroundRun ar = runAround(b, [] {}, 0.5, 0.0, lat4);
    note("Kotelnikov on deck 1 afterwards", r4.ok ? "load ok" : r4.error, ar);
    OM_CHECK(r4.ok && ar.wrong[0] == 0);
  }
  uint64_t late = 0;
  for (int d = 1; d < kNumDecks; d++) late += host.status(d).lateBlocks;
  int overBudget = 0;
  for (size_t i = cbStart; i < b.callbackMs.size(); i++)
    if (b.callbackMs[i] >= budgetMs) overBudget++;
  std::printf("  [info] fault plugins on deck 1, %s on decks 2-4 (128-frame blocks, budget %.3f ms):%s\n"
              "           decks 2-4: %d wrong blocks in all, %llu late blocks (latency-aligned dry); slowest callback %.3f ms, "
              "%d of %zu callbacks over the budget\n",
              real ? "Kotelnikov" : "184-sample delays (Kotelnikov not installed)", budgetMs, report.c_str(), othersWrong,
              static_cast<unsigned long long>(late), worstMs, overBudget, b.callbackMs.size() - cbStart);
  OM_CHECK(othersWrong == 0);
  OM_CHECK(deck1Wrong == 0);  // the faulty deck: the plugin's copy on time, else the dry, never silence or old audio
  // A plugin fault never holds the callback past its deadline: no callback
  // over the budget, except at most one isolated scheduling outlier (this
  // bench thread has no real-time priority and the PC is shared: one
  // 3.07 ms callback in ~5000 was seen once while a game ran), and never one
  // longer than 3 periods (a callback that waited for a hung plugin or the
  // host thread takes seconds; a broken deadline repeats every block).
  OM_CHECK(overBudget <= 1);
  OM_CHECK(worstMs < 3.0 * b.period * 1000.0);
}

// ===========================================================================
// V22: per-file scan errors and the class filter
// ===========================================================================
OM_TEST(vst_v22_scan_errors_utf8_and_class_filter) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::filesystem::path root = scratchDir() / "vst-inline scan";
  std::error_code ec;
  std::filesystem::create_directories(root, ec);
  std::vector<std::string> paths;
  std::vector<std::string> names;
  auto add = [&](const std::filesystem::path& p, const char* name) {
    paths.push_back(u8(p));
    names.push_back(name);
  };
  const std::string spy = spyPath();
  if (exists(spy)) add(fromU8(spy), "om-spy (4 classes: Fx, instrument, offline-only, instrument + Fx)");
#ifdef _WIN32
  wchar_t sysWow[MAX_PATH] = {};
  if (GetSystemWow64DirectoryW(sysWow, MAX_PATH)) {
    const std::filesystem::path dll32 = std::filesystem::path(sysWow) / "version.dll";
    if (std::filesystem::exists(dll32, ec)) {
      std::filesystem::copy_file(dll32, root / "om 32-bit.vst3", std::filesystem::copy_options::overwrite_existing, ec);
      add(root / "om 32-bit.vst3", "a 32-bit DLL");
    }
  }
#endif
  const std::string faults = omtest::envString("OM_TEST_VST_FAULTS");
  if (!faults.empty()) {
    std::filesystem::copy_file(fromU8(faults) / "dep" / "om-dep.dll", root / "om not a plugin.vst3", std::filesystem::copy_options::overwrite_existing, ec);
    add(root / "om not a plugin.vst3", "a DLL without GetPluginFactory");
    // its own om-dep.dll left behind: the system text of error 126 has accents in French (ANSI, not UTF-8, from the SDK)
    std::filesystem::copy_file(fromU8(faults) / "dep" / "om-fault-19.vst3", root / "om missing dependency.vst3", std::filesystem::copy_options::overwrite_existing, ec);
#ifdef _WIN32
    if (!GetModuleHandleW(L"om-dep.dll"))  // (once loaded by another test, Windows resolves the import by its name)
#endif
      add(root / "om missing dependency.vst3", "a plugin without its dependency DLL");
  }
  {
    std::ofstream g(root / "om garbage.vst3", std::ios::binary);
    g << "this is not a PE file";
  }
  add(root / "om garbage.vst3", "a text file");
  add(fromU8("C:\\does\\not\\exist.vst3"), "a missing file");
  const std::vector<VstScanResult> sr = scanVstPluginsDetailed(paths);
  OM_CHECK(sr.size() == paths.size());
  std::string report;
  for (size_t i = 0; i < sr.size() && i < names.size(); i++) {
    const VstScanResult& r = sr[i];
    std::string list;
    for (const VstPluginInfo& p : r.plugins) list += (list.empty() ? "" : ", ") + p.name;
    std::string shown;  // (bytes outside ASCII shown as \xNN)
    for (char c : r.error) {
      const unsigned char u = static_cast<unsigned char>(c);
      char hex[8];
      std::snprintf(hex, sizeof hex, "\\x%02X", u);
      shown += (u >= 0x20 && u < 0x7F) ? std::string(1, c) : std::string(hex);
    }
    report += "\n           " + names[i] + ": " + std::to_string(r.plugins.size()) + " plugin(s)" + (list.empty() ? "" : " (" + list + ")") +
              (r.error.empty() ? "" : ", error \"" + shown + "\"") + (validUtf8(r.error) ? "" : " [NOT UTF-8]") + (r.crashed ? ", crashed" : "") +
              (r.timedOut ? ", timed out" : "");
  }
  std::printf("  [info] scan, file by file:%s\n", report.c_str());
  for (size_t i = 0; i < sr.size() && i < names.size(); i++) {
    const VstScanResult& r = sr[i];
    OM_CHECK(validUtf8(r.error));  // goes into JSON as is
    OM_CHECK(!r.crashed && !r.timedOut);
    if (names[i].rfind("om-spy", 0) == 0) {
      OM_CHECK(r.error.empty() && r.plugins.size() == 2);
      if (r.plugins.size() == 2) OM_CHECK(r.plugins[0].name == "OM Spy" && r.plugins[1].name == "OM Spy Vocoder");
    } else {
      OM_CHECK(r.plugins.empty() && !r.error.empty());
    }
    if (names[i] == "a 32-bit DLL") OM_CHECK(r.error.find("64-bit") != std::string::npos && r.error.find("193") != std::string::npos);
    if (names[i] == "a plugin without its dependency DLL") OM_CHECK(r.error.find("missing") != std::string::npos && r.error.find("126") != std::string::npos);
  }
}

// ===========================================================================
// V06: non-ASCII folders, bundle routes, bundle-internal dependency DLL
// ===========================================================================
OM_TEST(vst_v06_non_ascii_kotelnikov_renamed_bundle_and_dependency_dll) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::filesystem::path root = scratchDir() / fromU8("vst-inline \xC3\x89t\xC3\xA9");  // "vst-inline Été"
  std::string report;
  int checked = 0;
  // Kotelnikov (a single-file .vst3) under "Été\Hélène VST3\": scanned, loaded, 184 samples, null
  const std::string kot = kotelnikovPath();
  if (exists(kot)) {
    const std::filesystem::path copy = root / fromU8("H\xC3\xA9l\xC3\xA8ne VST3") / "TDR Kotelnikov.vst3";
    OM_CHECK(copyPlugin(fromU8(kot), copy));
    const std::vector<VstScanResult> sr = scanVstPluginsDetailed({u8(copy)});
    OM_CHECK(sr.size() == 1 && sr[0].error.empty() && sr[0].plugins.size() == 1 && sr[0].plugins[0].name == "TDR Kotelnikov");
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    const VstLoadResult r = host.load(0, u8(copy), "");
    if (!r.ok) omtest::fail("load Kotelnikov from a non-ASCII folder", __FILE__, __LINE__, r.error);
    Bench b(host, 256, 48000, 0.2f);
    b.run(190);
    const double e = b.alignedErr(0, 0, b.pos(), 184);
    char t[200];
    std::snprintf(t, sizeof t, "\n           Kotelnikov copy: scan %zu plugin(s) [%s], load latency %d, null %.1f dB", sr.empty() ? 0 : sr[0].plugins.size(),
                  sr.empty() ? "" : sr[0].source.c_str(), r.latency, toDb(e));
    report += t;
    OM_CHECK(r.latency == 184 && e == 0.0);
    host.unload(0);
    checked++;
  }
  // the SDK's adelay renamed "adélay.vst3": the moduleinfo.json route and the DLL route list the same class
  const std::filesystem::path adelay = testDir() / ".." / ".." / ".." / "tpb" / "VST3" / "Release" / "adelay.vst3";
  if (exists(u8(adelay.lexically_normal()))) {
    const std::filesystem::path a1 = root / fromU8("\xC3\x89t\xC3\xA9 2") / fromU8("ad\xC3\xA9lay.vst3");
    const std::filesystem::path a2 = root / fromU8("\xC3\x89t\xC3\xA9 3") / fromU8("ad\xC3\xA9lay.vst3");
    OM_CHECK(copyPlugin(adelay.lexically_normal(), a1));
    OM_CHECK(copyPlugin(adelay.lexically_normal(), a2, true));
    const std::vector<VstScanResult> sr = scanVstPluginsDetailed({u8(a1), u8(a2)});
    OM_CHECK(sr.size() == 2);
    if (sr.size() == 2) {
      OM_CHECK(sr[0].source == "moduleinfo" && sr[1].source == "module");
      OM_CHECK(sr[0].plugins.size() == 1 && sr[1].plugins.size() == 1);
      if (sr[0].plugins.size() == 1 && sr[1].plugins.size() == 1)
        OM_CHECK(sr[0].plugins[0].name == "ADelay" && sr[1].plugins[0].name == "ADelay" && sr[0].plugins[0].uid == sr[1].plugins[0].uid);
      char t[200];
      std::snprintf(t, sizeof t, "\n           ad\xC3\xA9lay.vst3: [%s] %zu plugin(s), without moduleinfo.json [%s] %zu plugin(s)", sr[0].source.c_str(),
                    sr[0].plugins.size(), sr[1].source.c_str(), sr[1].plugins.size());
      report += t;
    }
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    const VstLoadResult r = host.load(0, u8(a2), "");
    OM_CHECK(r.ok);
    report += std::string(", load ") + (r.ok ? "ok" : r.error);
    host.unload(0);
    checked++;
  }
  // G9's bundle "OM Bündle.vst3" and om-fault-19 with its om-dep.dll (also copied under a non-ASCII folder)
  const std::string faults = omtest::envString("OM_TEST_VST_FAULTS");
  if (!faults.empty()) {
    const std::filesystem::path bundle = fromU8(faults) / fromU8("b\xC3\xBCndle") / fromU8("OM B\xC3\xBCndle.vst3");
    const std::filesystem::path dep = fromU8(faults) / "dep";
    const std::filesystem::path depCopy = root / fromU8("d\xC3\xA9pendance");
    std::error_code ec;
    std::filesystem::create_directories(depCopy, ec);
    std::filesystem::copy_file(dep / "om-fault-19.vst3", depCopy / "om-fault-19.vst3", std::filesystem::copy_options::overwrite_existing, ec);
    std::filesystem::copy_file(dep / "om-dep.dll", depCopy / "om-dep.dll", std::filesystem::copy_options::overwrite_existing, ec);
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    const std::vector<VstScanResult> sr = scanVstPluginsDetailed({u8(bundle)});
    const VstLoadResult rb = host.load(0, u8(bundle), "");
    const VstLoadResult rd = host.load(1, u8(dep / "om-fault-19.vst3"), "");
    const VstLoadResult rc = host.load(2, u8(depCopy / "om-fault-19.vst3"), "");
    Bench b(host, 256, 48000);
    b.run(20);
    const double copyErr = std::max({b.alignedErr(0, 0, b.pos(), 0), b.alignedErr(1, 0, b.pos(), 0), b.alignedErr(2, 0, b.pos(), 0)});
    char t[320];
    std::snprintf(t, sizeof t, "\n           OM B\xC3\xBCndle.vst3: scan %zu plugin(s) [%s], load %s; om-fault-19 + om-dep.dll: load %s, from \"d\xC3\xA9pendance\\\" %s; output %.1f dB",
                  sr.empty() ? 0 : sr[0].plugins.size(), sr.empty() ? "" : sr[0].source.c_str(), rb.ok ? "ok" : rb.error.c_str(),
                  rd.ok ? "ok" : rd.error.c_str(), rc.ok ? "ok" : rc.error.c_str(), toDb(copyErr));
    report += t;
    OM_CHECK(sr.size() == 1 && sr[0].plugins.size() == 1 && rb.ok && rd.ok && rc.ok && copyErr == 0.0);
    checked++;
  }
  if (!checked) OM_SKIP("no plugin to copy (Kotelnikov, native/tpb, OM_TEST_VST_FAULTS)");
  std::printf("  [info] non-ASCII folders under %s:%s\n", u8(root).c_str(), report.c_str());
}

// ===========================================================================
// State: Kotelnikov's default and compressing states
// ===========================================================================
OM_TEST(vst_kotelnikov_state_round_trip_default_and_compressing) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = kotelnikovPath();
  if (!exists(path)) OM_SKIP("TDR Kotelnikov.vst3 not installed (OM_TEST_VST_KOTELNIKOV)");
  std::string defaults, compressing, saved;
  {
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    OM_CHECK(host.load(0, path, "").ok);
    defaults = host.getState(0);
    OM_CHECK(!kotelnikovXml(defaults).empty());
    OM_CHECK(host.setState(0, defaults));
    OM_CHECK(host.getState(0) == defaults);  // byte-identical round trip on the same slot
    compressing = kotelnikovEdit(defaults, {{"thresholdParam", "-18.0"}, {"ratioParam", "4.0"}, {"attackParam", "3.0"}});
    OM_CHECK(!compressing.empty());
  }
  // two fresh instances, the same input: one restored from the edited state,
  // the other from what the first one saved
  auto render = [&](const std::string& state, std::vector<float>& outL, std::vector<float>& inL, std::string* savedOut) {
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    const VstLoadResult r = host.load(0, path, "", state);
    OM_CHECK(r.ok && r.stateRestored && r.latency == 184);
    Bench b(host, 256, 48000, 0.6f);  // white noise, -4.4 dBFS peak: well over the -18 dB threshold
    b.run(375);                       // 2 s
    outL = b.outL[0];
    inL = b.inL[0];
    if (savedOut) *savedOut = host.getState(0);
  };
  std::vector<float> o1, o2, in1, in2;
  render(compressing, o1, in1, &saved);
  const std::string xml = kotelnikovXml(saved);
  OM_CHECK(xmlAttr(xml, "<TDRKotelnikov ", "thresholdParam") == "-18.0" && xmlAttr(xml, "<TDRKotelnikov ", "ratioParam") == "4.0");
  render(saved, o2, in2, nullptr);
  OM_CHECK(o1.size() == o2.size() && in1 == in2);
  double diff = 0, eOut = 0, eIn = 0;
  for (size_t n = 48000; n < o1.size() && n < o2.size(); n++) {
    diff = std::max(diff, static_cast<double>(std::fabs(o1[n] - o2[n])));
    eOut += static_cast<double>(o1[n]) * o1[n];
    eIn += static_cast<double>(in1[n - 184]) * in1[n - 184];
  }
  const double grDb = 10.0 * std::log10(std::max(eOut, 1e-30) / std::max(eIn, 1e-30));
  std::printf("  [info] Kotelnikov state: default %zu base64 chars, round trip byte-identical; compressing state (threshold -18, ratio 4, "
              "attack 3): gain %.2f dB on -4.4 dBFS noise, saved and restored into a fresh instance: max difference %.3g (%.1f dBFS)\n",
              defaults.size(), grDb, diff, toDb(diff));
  OM_CHECK(grDb < -1.0);       // the restored state compresses
  OM_CHECK(toDb(diff) < -100.0);  // the saved state gives the same sound
}

// ===========================================================================
// V20 / G9: 20 load / unload cycles, four instances over 10 s
// ===========================================================================
#ifdef _WIN32
namespace {
struct ProcessCounters {
  double privateMiB = 0;
  DWORD handles = 0, threads = 0;
};
ProcessCounters processCounters() {
  ProcessCounters c;
  PROCESS_MEMORY_COUNTERS_EX m{};
  if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof m)) c.privateMiB = m.PrivateUsage / 1048576.0;
  GetProcessHandleCount(GetCurrentProcess(), &c.handles);
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    THREADENTRY32 te{};
    te.dwSize = sizeof te;
    for (BOOL ok = Thread32First(snap, &te); ok; ok = Thread32Next(snap, &te))
      if (te.th32OwnerProcessID == GetCurrentProcessId()) c.threads++;
    CloseHandle(snap);
  }
  return c;
}
double processCpuSeconds() {
  FILETIME c, e, k, u;
  if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
  auto s = [](const FILETIME& f) { return ((static_cast<uint64_t>(f.dwHighDateTime) << 32) | f.dwLowDateTime) / 1e7; };
  return s(k) + s(u);
}
}  // namespace
#endif

OM_TEST(vst_kotelnikov_20_load_unload_cycles_memory_handles_threads) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
#ifdef _WIN32
  struct Case {
    const char* name;
    std::string path;
  };
  const Case cases[] = {{"om-spy", spyPath()}, {"again", againPath()}, {"Kotelnikov", kotelnikovPath()}};
  std::string report;
  for (const Case& c : cases) {
    if (!exists(c.path)) continue;
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    Bench b(host, 256, 48000, 0.2f);
    auto cycle = [&] {
      const VstLoadResult r = host.load(0, c.path, "");
      OM_CHECK(r.ok);
      b.run(20);
      host.unload(0);
      b.run(2);
    };
    cycle();  // warm-up: the DLL is mapped once and stays (CachedModule)
    cycle();
    // (the bench's own histories must not show as growth)
    for (int d = 0; d < kNumDecks; d++) {
      for (auto* v : {&b.inL[d], &b.inR[d], &b.outL[d], &b.outR[d]}) v->reserve(v->size() + 30 * 22 * 256);
    }
    b.callbackMs.reserve(b.callbackMs.size() + 30 * 22);
    const ProcessCounters c0 = processCounters();
    for (int i = 0; i < 20; i++) cycle();
    const ProcessCounters c1 = processCounters();
    HMODULE mapped = nullptr;
    const std::string dll = c.path;
    const bool stillMapped =
        std::filesystem::is_directory(fromU8(c.path)) || GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, fromU8(dll).wstring().c_str(), &mapped) != 0;
    char t[300];
    std::snprintf(t, sizeof t, "\n           %-10s private bytes %.2f -> %.2f MiB (%+.2f), handles %lu -> %lu, threads %lu -> %lu, DLL still mapped %d", c.name,
                  c0.privateMiB, c1.privateMiB, c1.privateMiB - c0.privateMiB, static_cast<unsigned long>(c0.handles),
                  static_cast<unsigned long>(c1.handles), static_cast<unsigned long>(c0.threads), static_cast<unsigned long>(c1.threads),
                  stillMapped ? 1 : 0);
    report += t;
    OM_CHECK(c1.privateMiB - c0.privateMiB < 3.0);
    OM_CHECK(static_cast<long>(c1.handles) - static_cast<long>(c0.handles) <= 10);
    OM_CHECK(c1.threads <= c0.threads + 1);
    OM_CHECK(stillMapped);
  }
  std::printf("  [info] 20 load / unload cycles:%s\n", report.c_str());
#else
  OM_SKIP("Windows only");
#endif
}

OM_TEST(vst_kotelnikov_four_instances_10s_cpu) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
#ifdef _WIN32
  const std::string path = kotelnikovPath();
  if (!exists(path)) OM_SKIP("TDR Kotelnikov.vst3 not installed (OM_TEST_VST_KOTELNIKOV)");
#ifdef NDEBUG
  const char* build = "Release";
#else
  const char* build = "Debug";
#endif
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  Bench b(host, 128, 48000, 0.2f, true);  // paced by a timer: the waiting costs no CPU
  for (int d = 0; d < kNumDecks; d++)
    for (auto* v : {&b.inL[d], &b.inR[d], &b.outL[d], &b.outR[d]}) v->reserve(6000 * 128);
  b.callbackMs.reserve(6000);
  // the same callbacks without plugins: what the bench itself costs
  b.run(100);
  double cpu0 = processCpuSeconds();
  int64_t t0 = nowNs();
  b.run(1500);  // 4 s
  const double baseCpu = 100.0 * (processCpuSeconds() - cpu0) / ((nowNs() - t0) / 1e9);
  for (int d = 0; d < kNumDecks; d++) OM_CHECK(host.load(d, path, "").ok);
  b.run(100);
  cpu0 = processCpuSeconds();
  t0 = nowNs();
  const size_t cb0 = b.callbackMs.size();
  const int64_t from = b.pos();
  b.run(3750);  // 10 s
  const double wall = (nowNs() - t0) / 1e9, cpu = processCpuSeconds() - cpu0;
  const std::vector<double> ms(b.callbackMs.begin() + static_cast<ptrdiff_t>(cb0), b.callbackMs.end());
  uint64_t late = 0, busy = 0;
  std::string decks;
  for (int d = 0; d < kNumDecks; d++) {
    const VstSlotStatus st = host.status(d);
    late += st.lateBlocks;
    busy += st.busySkips;
    char t[120];
    std::snprintf(t, sizeof t, " deck %d avg %.4f ms (%.2f %%) max %.4f ms;", d + 1, st.avgProcessMs, 100.0 * st.avgProcessMs / (b.period * 1000.0),
                  st.maxProcessMs);
    decks += t;
  }
  double nullErr = 0;
  for (int d = 0; d < kNumDecks; d++) nullErr = std::max(nullErr, b.alignedErr(d, from, b.pos(), 184));
  std::printf("  [info] %s, 4 x Kotelnikov, 10 s of 128-frame blocks at 48 kHz: process CPU %.2f %% of one core (all threads; the same "
              "callbacks without plugins: %.2f %%), callback median %.4f ms, p99 %.4f ms, max %.4f ms (deadline %.3f ms), late %llu, busy %llu "
              "of %d blocks;%s null %.1f dB\n",
              build, 100.0 * cpu / wall, baseCpu, percentile(ms, 0.5), percentile(ms, 0.99), percentile(ms, 1.0), 0.35 * b.period * 1000.0,
              static_cast<unsigned long long>(late), static_cast<unsigned long long>(busy), 3750 * kNumDecks, decks.c_str(), toDb(nullErr));
  OM_CHECK(late * 100 <= 3750u * kNumDecks);
  OM_CHECK(nullErr == 0.0);
  OM_CHECK(100.0 * cpu / wall < 50.0);
#else
  OM_SKIP("Windows only");
#endif
}
