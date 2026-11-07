// Tests of the VST3 inline host (owner: decoder, library om_vst). With fake
// processors on the per-deck workers (portable): four decks in parallel,
// the block deadline (late = latency-aligned dry, counters, vst.late at
// most once a second; a plugin that always returns, however late, is never
// hung), a process() that never returns
// (hung after 2 s while the callback never waits past its deadline and the
// other decks keep playing), the FP environment (MXCSR restored, FTZ | DAZ)
// and plugin allocations counted apart, the 1 s latency cap, latency
// changes and refusals, bypass / dry-wet aligned with the plugin latency,
// the transport at the insert input, SEH crashes (Windows). With real
// plugins (Windows + VST3 SDK): the SDK's "again" bit-exact with no added
// latency, TDR Kotelnikov at 44.1 / 48 kHz (latency compensated, null test,
// bypass, 4 instances with CPU per block), G9's fault plugins never
// silencing the other decks (OM_TEST_VST_FAULTS=<folder>), any plugin from
// OM_TEST_VST_PLUGIN=<path> (load / process / state / editor captured from
// its own window only, never synthetic input), non-ASCII plugin paths, and
// the scan in a child process. Silent: no audio device; editors open
// off-screen without activation. SPEC.md §13.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#include "../om_test.h"
#include "om/dsp.h"
#include "om/om_state.h"
#include "om/rt.h"
#include "om/vst_insert.h"
#include "vst_test_util.h"

using namespace om;
using namespace vsttest;

namespace {

// Never returns from call number `blockAt` until released (waits, no CPU).
class BlockerFx : public IVstProcessor {
 public:
  explicit BlockerFx(int at) : blockAt(at) {}
  VstProcessResult process(const VstProcessBlock& b) override {
    const bool blocking = calls++ == blockAt;
    if (blocking) {
      while (!released.load()) released.wait(false);
    }
    std::memcpy(b.outL, b.inL, static_cast<size_t>(b.frames) * sizeof(float));
    std::memcpy(b.outR, b.inR, static_cast<size_t>(b.frames) * sizeof(float));
    if (blocking) left.store(true);  // (last access to this object on that call)
    return VstProcessResult::Ok;
  }
  // Lets the blocked call return and waits until it has left this object.
  void release() {
    released.store(true);
    released.notify_all();
    for (int i = 0; i < 5000 && !left.load(); i++) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  int blockAt;
  std::atomic<int> calls{0};
  std::atomic<bool> released{false}, left{false};
};

// Records the FP control word it is called with, then changes it the way
// some plugins do (FTZ / DAZ off, rounding toward -inf).
class FpProbeFx : public IVstProcessor {
 public:
  VstProcessResult process(const VstProcessBlock& b) override {
    const int c = calls++;
    if (c < 64) seen[c] = dsp::fpControl();
#if defined(OM_FPENV_X86)
    dsp::setFpControl((dsp::fpControl() & ~uint64_t(0x8040)) | 0x2000);
#endif
    std::memcpy(b.outL, b.inL, static_cast<size_t>(b.frames) * sizeof(float));
    std::memcpy(b.outR, b.inR, static_cast<size_t>(b.frames) * sizeof(float));
    return VstProcessResult::Ok;
  }
  std::atomic<int> calls{0};
  uint64_t seen[64] = {};
};

// Allocates and frees in process() (its business: counted apart).
class AllocFx : public IVstProcessor {
 public:
  VstProcessResult process(const VstProcessBlock& b) override {
    auto* p = new float[static_cast<size_t>(b.frames)];
    for (int i = 0; i < b.frames; i++) p[i] = b.inL[i];
    std::memcpy(b.outL, p, static_cast<size_t>(b.frames) * sizeof(float));
    std::memcpy(b.outR, b.inR, static_cast<size_t>(b.frames) * sizeof(float));
    delete[] p;
    calls++;
    return VstProcessResult::Ok;
  }
  std::atomic<int> calls{0};
};

// Records the transport of every block.
class TransportFx : public IVstProcessor {
 public:
  VstProcessResult process(const VstProcessBlock& b) override {
    const int c = calls++;
    if (c < 256) {
      seen[c] = b.transport;
      cont[c] = b.continuousFrames;
      sys[c] = b.systemTimeNs;
      rate[c] = b.sampleRate;
    }
    std::memcpy(b.outL, b.inL, static_cast<size_t>(b.frames) * sizeof(float));
    std::memcpy(b.outR, b.inR, static_cast<size_t>(b.frames) * sizeof(float));
    return VstProcessResult::Ok;
  }
  std::atomic<int> calls{0};
  VstTransport seen[256];
  int64_t cont[256] = {}, sys[256] = {};
  double rate[256] = {};
};

// An access violation at call `at`.
class CrashFx : public IVstProcessor {
 public:
  explicit CrashFx(int at) : crashAt(at) {}
  VstProcessResult process(const VstProcessBlock& b) override {
    if (calls++ == crashAt) {
      volatile int* p = nullptr;
      *p = 42;
    }
    std::memcpy(b.outL, b.inL, static_cast<size_t>(b.frames) * sizeof(float));
    std::memcpy(b.outR, b.inR, static_cast<size_t>(b.frames) * sizeof(float));
    return VstProcessResult::Ok;
  }
  int crashAt;
  std::atomic<int> calls{0};
};

}  // namespace

// ===========================================================================
OM_TEST(vst_sdk_links) {
  std::string version;
  if (!vstSdkAvailable(&version)) OM_SKIP("built without the VST3 SDK (portable, sanitizer or --no-vst build)");
  OM_CHECK(version.rfind("VST 3", 0) == 0);
}

OM_TEST(vst_host_fails_gracefully_without_plugin) {
  VstHost host;
  const VstLoadResult r = host.load(0, "C:\\does\\not\\exist.vst3", "");
  OM_CHECK(!r.ok && !r.error.empty());
  float l[64] = {}, rr[64] = {};
  {
    rt::Scope rts;  // the audio-thread side never allocates
    host.startCallback(256 / 48000.0);
    OM_CHECK(!host.begin(0, l, rr, 64));  // empty slot: end() not called, signal untouched
    OM_CHECK(host.takeEvents(0) == 0);
  }
  OM_CHECK(host.latencyFrames(0) == 0);
  const VstSlotStatus st = host.status(0);  // non-blocking
  OM_CHECK(!st.loaded && !st.hung && st.lateBlocks == 0);
  OM_CHECK(scanVstPlugins({}).empty());
}

OM_TEST(vst_base64_state_codec) {
  std::string all;
  for (int i = 0; i < 256; i++) all += static_cast<char>(i);
  for (size_t n : {size_t(0), size_t(1), size_t(2), size_t(3), size_t(4), size_t(255), size_t(256)}) {
    const std::string s = all.substr(0, n);
    std::string back;
    OM_CHECK(base64Decode(base64Encode(s), back) && back == s);
  }
  OM_CHECK(base64Encode("OMFK") == "T01GSw==");
  std::string out;
  OM_CHECK(!base64Decode("T01G*w==", out));
}

// ---------------------------------------------------------------------------
// Workers: four decks in parallel, on time, no added latency
// ---------------------------------------------------------------------------
OM_TEST(vst_workers_parallel_and_on_time) {
  const double rate = 48000;
  const int frames = 256;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  host.setDeadline(0.6f);
  const int64_t work = 1'000'000;  // 1 ms of plugin work per block and deck (4 ms if serial)
  std::shared_ptr<GainFx> fx[kNumDecks];
  for (int d = 0; d < kNumDecks; d++) {
    fx[d] = std::make_shared<GainFx>(0.5f / (d + 1), work);
    OM_CHECK(host.attachProcessor(d, fx[d], 0, "gain").ok);
  }
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  std::vector<double> ms;
  int wrong = 0, dry = 0;
  const int blocks = 300;
  for (int b = 0; b < blocks; b++) {
    rig.fill();
    ms.push_back(rig.run() / 1e6);
    for (int d = 0; d < kNumDecks; d++) {
      OM_CHECK(rig.active[d]);
      const float g = 0.5f / (d + 1);
      const int64_t n0 = static_cast<int64_t>(b) * frames;
      bool asWet = true, asDry = true;
      for (int i = 0; i < frames; i++) {
        asWet = asWet && rig.l[d][static_cast<size_t>(i)] == rig.in(d, n0 + i) * g;
        asDry = asDry && rig.l[d][static_cast<size_t>(i)] == rig.in(d, n0 + i);
      }
      if (!asWet && !asDry) wrong++;
      if (!asWet && asDry) dry++;
    }
    pace.wait();
  }
  uint64_t late = 0, processed = 0;
  for (int d = 0; d < kNumDecks; d++) {
    const VstSlotStatus st = host.status(d);
    late += st.lateBlocks;
    processed += st.processed;
    OM_CHECK(st.loaded && st.active && !st.hung && !st.crashed && st.latency == 0);
  }
  const double med = percentile(ms, 0.5), p99 = percentile(ms, 0.99);
  std::printf("  [info] 4 decks x 1 ms of plugin work, 256-frame blocks at 48 kHz: callback median %.3f ms, p99 %.3f ms "
              "(serial would be >= 4 ms); late %llu / %d blocks\n",
              med, p99, static_cast<unsigned long long>(late), blocks * kNumDecks);
  OM_CHECK(wrong == 0);                         // every block = the plugin output or (late) the dry
  OM_CHECK(static_cast<uint64_t>(dry) == late);  // a dry block is exactly a late one
  OM_CHECK(med < 2.0);                          // the four plugins ran in parallel
  OM_CHECK(late * 50 <= static_cast<uint64_t>(blocks * kNumDecks));  // <= 2 % on a shared, busy PC
  OM_CHECK(processed + late == static_cast<uint64_t>(blocks * kNumDecks));
}

// ---------------------------------------------------------------------------
// Deadline: late = latency-aligned dry, counters, events; a plugin that is
// always late but always returns is never hung (review round of 7 Nov 2026)
// ---------------------------------------------------------------------------
OM_TEST(vst_deadline_late_dry_and_events) {
  const double rate = 48000;
  const int frames = 256;
  const int L = 64;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);  // deadline 0.35 x 5.33 ms = 1.87 ms
  auto always = std::make_shared<DelayFx>(L);
  always->slowEvery = 1;
  always->slowNs = 3'000'000;  // 3 ms: always late
  auto sometimes = std::make_shared<DelayFx>(L);
  sometimes->slowEvery = 10;
  sometimes->slowNs = 3'000'000;
  OM_CHECK(host.attachProcessor(0, always, L, "slow").ok);
  OM_CHECK(host.attachProcessor(1, sometimes, L, "sometimes slow").ok);
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  int lateEvents[2] = {0, 0}, hungEvents[2] = {0, 0};
  int64_t hungAtBlock = -1;
  int mismatch[2] = {0, 0};
  const int blocks = 240;  // 1.28 s
  for (int b = 0; b < blocks; b++) {
    rig.fill();
    rig.run();
    for (int d = 0; d < 2; d++) {
      const uint8_t ev = host.takeEvents(d);
      if (ev & kVstLate) lateEvents[d]++;
      if (ev & kVstHung) {
        hungEvents[d]++;
        if (d == 0) hungAtBlock = b;
      }
      // the output is always the input delayed by L: plugin output on time, latency-aligned dry when late
      const int64_t n0 = static_cast<int64_t>(b) * frames;
      for (int i = 0; i < frames; i++)
        if (rig.l[d][static_cast<size_t>(i)] != rig.in(d, n0 + i - L)) {
          mismatch[d]++;
          break;
        }
    }
    pace.wait();
  }
  const VstSlotStatus s0 = host.status(0), s1 = host.status(1);
  std::printf("  [info] always late: late %llu, busy skips %llu, hung at block %lld, late events %d; sometimes late: "
              "late %llu / processed %llu, late events %d (1.28 s)\n",
              static_cast<unsigned long long>(s0.lateBlocks), static_cast<unsigned long long>(s0.busySkips),
              static_cast<long long>(hungAtBlock), lateEvents[0], static_cast<unsigned long long>(s1.lateBlocks),
              static_cast<unsigned long long>(s1.processed), lateEvents[1]);
  OM_CHECK(mismatch[0] == 0 && mismatch[1] == 0);
  // Every call returns (3 ms < one period): late, never hung (the old rule
  // marked it hung at the 50th late block and disabled it for the session).
  OM_CHECK(!s0.hung && hungEvents[0] == 0 && hungAtBlock < 0);
  // (a block counts as on time when the callback thread was preempted past
  // the 3 ms call before it reached end(): rare, allowed on a busy PC)
  OM_CHECK(s0.processed + s0.lateBlocks + s0.busySkips == static_cast<uint64_t>(blocks));
  OM_CHECK(s0.processed * 20 <= static_cast<uint64_t>(blocks));
  OM_CHECK(s0.lateBlocks >= 120);                    // handed again and again (well past 50)
  OM_CHECK(lateEvents[0] >= 1 && lateEvents[0] <= 2);  // <= 1 per second
  const uint8_t st0 = host.insertState(0, nullptr);
  OM_CHECK(st0 == OM_INSERT_LATE || st0 == OM_INSERT_ACTIVE);  // never HUNG
  OM_CHECK(!s1.hung && hungEvents[1] == 0);
  OM_CHECK(s1.lateBlocks >= 20 && s1.lateBlocks <= 40);
  OM_CHECK(lateEvents[1] >= 1 && lateEvents[1] <= 2);
}

// ---------------------------------------------------------------------------
// A slow plugin whose every call returns just after the deadline (review
// round of 7 Nov 2026, RT-safety #3): 128-frame periods (deadline 0.35 x
// 2.67 ms = 0.93 ms), process() takes 1.2 ms, for 2.6 s (~970 blocks, far
// past the old "50 late blocks in a row = hung" rule and past the 2 s hang
// limit). It stays loaded and LATE (dry, exactly aligned), never HUNG, so
// the proxy never adds it to the suspects.
// ---------------------------------------------------------------------------
OM_TEST(vst_slow_plugin_that_always_returns_is_never_hung) {
  const double rate = 48000;
  const int frames = 128;
  const int L = 32;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  auto slow = std::make_shared<DelayFx>(L);
  slow->slowEvery = 1;
  slow->slowNs = 1'200'000;  // returns ~0.27 ms after the deadline, well before the next callback
  OM_CHECK(host.attachProcessor(0, slow, L, "just late").ok);
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  int hungEvents = 0, lateEvents = 0, mismatch = 0, notLate = 0, badState = 0;
  const int64_t t0 = nowNs();
  int b = 0;
  for (; nowNs() - t0 < 2'600'000'000; b++) {
    rig.fill();
    rig.run();
    const uint8_t ev = host.takeEvents(0);
    if (ev & kVstHung) hungEvents++;
    if (ev & kVstLate) lateEvents++;
    const uint8_t is = host.insertState(0, nullptr);
    if (is != OM_INSERT_LATE) notLate++;
    if (is != OM_INSERT_LATE && is != OM_INSERT_ACTIVE) badState++;  // HUNG / CRASHED / BYPASSED
    const int64_t n0 = static_cast<int64_t>(b) * frames;
    for (int i = 0; i < frames; i++)
      if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i - L)) {
        mismatch++;
        break;
      }
    pace.wait();
  }
  const VstSlotStatus st = host.status(0);
  uint64_t lateCount = 0;
  const uint8_t state = host.insertState(0, &lateCount);
  std::printf("  [info] 1.2 ms plugin at 128 frames: %d blocks, late %llu, busy skips %llu, processed %llu, "
              "late events %d, hung events %d, blocks not LATE %d, blocks HUNG / CRASHED / BYPASSED %d\n",
              b, static_cast<unsigned long long>(st.lateBlocks), static_cast<unsigned long long>(st.busySkips),
              static_cast<unsigned long long>(st.processed), lateEvents, hungEvents, notLate, badState);
  OM_CHECK(b > 500);
  OM_CHECK(hungEvents == 0 && !st.hung && st.loaded && !st.crashed);
  OM_CHECK((state == OM_INSERT_LATE || state == OM_INSERT_ACTIVE) && lateCount == st.lateBlocks);
  OM_CHECK(badState == 0);
  // (a block counts as on time when the callback thread was preempted past
  // the 1.2 ms call before it reached end(): rare, allowed on a busy PC)
  OM_CHECK(notLate * 20 <= b);
  OM_CHECK(st.lateBlocks >= 400);  // handed again and again
  OM_CHECK(mismatch == 0);         // every block = the latency-aligned dry
  OM_CHECK(lateEvents >= 2 && lateEvents <= 4);  // at most once per second
}

// ---------------------------------------------------------------------------
// A crash reported by a block that came back after the deadline still
// disables the slot (its audio was discarded, its crash is not): never
// called again. A plugin installed afterwards on the same deck starts clean.
// Review round of 7 Nov 2026 (RT-safety #1 / #3 follow-up).
// ---------------------------------------------------------------------------
namespace {
class CrashLateFx : public IVstProcessor {
 public:
  VstProcessResult process(const VstProcessBlock& b) override {
    const int c = calls++;
    if (c == 5) {
      spinNs(3'000'000);  // late (deadline 1.87 ms), then "faults"
      return VstProcessResult::Crashed;
    }
    std::memcpy(b.outL, b.inL, static_cast<size_t>(b.frames) * sizeof(float));
    std::memcpy(b.outR, b.inR, static_cast<size_t>(b.frames) * sizeof(float));
    return VstProcessResult::Ok;
  }
  std::atomic<int> calls{0};
};
}  // namespace

OM_TEST(vst_crash_reported_by_a_late_block_disables_the_slot) {
  const double rate = 48000;
  const int frames = 256;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  auto crashy = std::make_shared<CrashLateFx>();
  OM_CHECK(host.attachProcessor(0, crashy, 0, "crashes late").ok);
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  uint8_t ev = 0;
  int wrong = 0;
  for (int b = 0; b < 40; b++) {
    rig.fill();
    rig.run();
    ev |= host.takeEvents(0);
    const int64_t n0 = static_cast<int64_t>(b) * frames;
    for (int i = 0; i < frames; i++)  // a copy on time, else the dry: the input either way
      if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i)) {
        wrong++;
        break;
      }
    pace.wait();
  }
  const VstSlotStatus st = host.status(0);
  std::printf("  [info] crash on a late block: crashed %d, calls %d, late %llu, wrong blocks %d\n", st.crashed ? 1 : 0,
              crashy->calls.load(), static_cast<unsigned long long>(st.lateBlocks), wrong);
  OM_CHECK(st.crashed && (ev & kVstCrashed));
  OM_CHECK(crashy->calls.load() == 6);  // never called again after the faulting call
  OM_CHECK(host.insertState(0, nullptr) == OM_INSERT_CRASHED);
  OM_CHECK(wrong == 0);
  // a new plugin on the same deck: clean (not crashed, processed)
  host.unload(0);
  auto fresh = std::make_shared<GainFx>(0.5f);
  OM_CHECK(host.attachProcessor(0, fresh, 0, "gain").ok);
  for (int b = 0; b < 20; b++) {
    rig.fill();
    rig.run();
    pace.wait();
  }
  const VstSlotStatus st2 = host.status(0);
  OM_CHECK(!st2.crashed && st2.loaded && fresh->calls.load() >= 18);
  OM_CHECK(host.insertState(0, nullptr) == OM_INSERT_ACTIVE);
}

// ---------------------------------------------------------------------------
// A process() call that never returns: hung after 2 s, the callback never
// waits beyond its deadline, the other decks never stop
// ---------------------------------------------------------------------------
OM_TEST(vst_never_returning_process_hung_after_2s) {
  const double rate = 48000;
  const int frames = 256;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  auto blocker = std::make_shared<BlockerFx>(5);
  OM_CHECK(host.attachProcessor(0, blocker, 0, "never returns").ok);
  std::shared_ptr<GainFx> others[3];
  for (int d = 1; d < kNumDecks; d++) {
    others[d - 1] = std::make_shared<GainFx>(0.5f);
    OM_CHECK(host.attachProcessor(d, others[d - 1], 0, "gain").ok);
  }
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  const double deadlineMs = 0.35 * rig.period * 1000.0;
  double maxCallbackMs = 0;
  int64_t stuckSince = -1, hungAt = -1;
  int othersWrong = 0, deck0Wrong = 0;
  const int64_t t0 = nowNs();
  for (int b = 0; nowNs() - t0 < 2'600'000'000; b++) {
    rig.fill();
    const double ms = rig.run() / 1e6;
    if (b >= 5) maxCallbackMs = std::max(maxCallbackMs, ms);
    if (b == 5) stuckSince = nowNs();
    if ((host.takeEvents(0) & kVstHung) && hungAt < 0) hungAt = nowNs();
    const int64_t n0 = static_cast<int64_t>(b) * frames;
    for (int d = 1; d < kNumDecks; d++)
      for (int i = 0; i < frames; i++)
        if (rig.l[d][static_cast<size_t>(i)] != rig.in(d, n0 + i) * 0.5f) {
          othersWrong++;
          break;
        }
    for (int i = 0; i < frames; i++)  // deck 0: the plugin (a copy) on time, else the dry: the input either way
      if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i)) {
        deck0Wrong++;
        break;
      }
    pace.wait();
  }
  const VstSlotStatus st = host.status(0);
  const double hungAfter = hungAt > 0 ? (hungAt - stuckSince) / 1e9 : -1;
  std::printf("  [info] never-returning process(): hung after %.3f s, %llu busy skips, slowest callback %.3f ms "
              "(deadline %.3f ms)\n",
              hungAfter, static_cast<unsigned long long>(st.busySkips), maxCallbackMs, deadlineMs);
  OM_CHECK(st.hung && hungAt > 0);
  OM_CHECK(hungAfter >= 1.99 && hungAfter < 2.2);
  OM_CHECK(othersWrong == 0 && deck0Wrong == 0);
  OM_CHECK(maxCallbackMs < deadlineMs + 2.0);  // (+2 ms: scheduling on a shared PC; the spin itself stops at the deadline)
  // the deck is usable again: its stuck worker is abandoned and replaced
  host.unload(0);
  auto fresh = std::make_shared<GainFx>(0.25f);
  OM_CHECK(host.attachProcessor(0, fresh, 0, "gain").ok);
  for (int b = 0; b < 20; b++) {
    rig.fill();
    rig.run();
    pace.wait();
  }
  OM_CHECK(fresh->calls.load() >= 18);
  OM_CHECK(rig.l[0][7] == rig.histL[0][rig.histL[0].size() - static_cast<size_t>(frames) + 7] * 0.25f);
  blocker->release();  // (the abandoned worker leaves the plugin and ends)
}

// ---------------------------------------------------------------------------
// FP environment and plugin allocations
// ---------------------------------------------------------------------------
OM_TEST(vst_fp_environment_and_plugin_allocations) {
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  auto probe = std::make_shared<FpProbeFx>();
  auto alloc = std::make_shared<AllocFx>();
  OM_CHECK(host.attachProcessor(0, probe, 0, "fp").ok);
  OM_CHECK(host.attachProcessor(1, alloc, 0, "alloc").ok);
  Rig rig(host, 256, 48000);
  Pacer pace(rig.period);
  const uint64_t audioFp = dsp::fpControl();
  const uint64_t pluginBefore = rt::pluginAllocations();
  for (int b = 0; b < 40; b++) {
    rig.fill();
    rig.run();
    pace.wait();
  }
  OM_CHECK(dsp::fpControl() == audioFp);  // the calling (audio) thread is untouched
  OM_CHECK(probe->calls.load() >= 30);
  bool restored = true;
  for (int c = 0; c < std::min(probe->calls.load(), 64); c++) {
#if defined(OM_FPENV_X86)
    restored = restored && (probe->seen[c] & 0x8040u) == 0x8040u && (probe->seen[c] & 0x6000u) == 0;  // FTZ|DAZ, nearest
#endif
  }
  OM_CHECK(restored);  // every call starts with the worker's FTZ | DAZ, whatever the previous call left
  const VstSlotStatus st = host.status(1);
  if (rt::trapInstalled()) {
    OM_CHECK(st.pluginAllocs >= 30);  // the plugin's own business, counted apart
    OM_CHECK(rt::pluginAllocations() - pluginBefore >= 30);
  }
  OM_CHECK(rt::violations() == 0);  // never an engine real-time violation
  std::printf("  [info] plugin allocations counted apart: %llu (engine violations: %llu)\n",
              static_cast<unsigned long long>(st.pluginAllocs), static_cast<unsigned long long>(rt::violations()));
}

// ---------------------------------------------------------------------------
// Latency: cap, compensation, bypass / dry-wet aligned, changes and refusals
// ---------------------------------------------------------------------------
OM_TEST(vst_latency_cap_bypass_mix_alignment) {
  const double rate = 48000;
  const int frames = 256;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  // the 1 s cap
  VstLoadResult r = host.attachProcessor(2, std::make_shared<DelayFx>(48001), 48001, "too long");
  OM_CHECK(!r.ok && r.code == "latency");
  r = host.attachProcessor(2, std::make_shared<DelayFx>(48000), 48000, "1 s");
  OM_CHECK(r.ok && r.latency == 48000);
  // a delay plugin of L frames on deck 0; impulses as input
  const int L = 300;
  auto fx = std::make_shared<DelayFx>(L);
  OM_CHECK(host.attachProcessor(0, fx, L, "delay").ok);
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  std::vector<float> out;
  std::vector<float> in;
  auto runBlocks = [&](int n, float mix) {
    rt::Scope s;
    host.setMix(0, mix);
    for (int b = 0; b < n; b++) {
      host.startCallback(rig.period);
      for (int i = 0; i < frames; i++) {
        const int64_t k = static_cast<int64_t>(in.size());
        const float v = (k % 2000 == 700) ? 1.0f : 0.0f;  // an impulse every 2000 frames
        rig.l[0][static_cast<size_t>(i)] = v;
        rig.r[0][static_cast<size_t>(i)] = v;
        {
          rt::Unscoped u;
          in.push_back(v);
        }
      }
      if (host.begin(0, rig.l[0].data(), rig.r[0].data(), frames)) host.end(0, rig.l[0].data(), rig.r[0].data(), frames);
      rt::Unscoped u;
      out.insert(out.end(), rig.l[0].begin(), rig.l[0].end());
      pace.wait();
    }
  };
  runBlocks(1, 1.0f);
  OM_CHECK(host.latencyFrames(0) == L);
  OM_CHECK(host.takeEvents(0) & kVstLatency);  // the core applies it to the deck's read-ahead
  runBlocks(40, 1.0f);   // wet
  const size_t wetEnd = out.size();
  runBlocks(40, 0.0f);   // bypass (after the 10 ms ramp: the latency-aligned dry)
  const size_t dryEnd = out.size();
  runBlocks(40, 0.5f);   // dry / wet
  // every impulse comes out L frames later, once, whatever the mix
  auto checkSpan = [&](size_t a, size_t b, float amp, const char* what) {
    int peaks = 0, bad = 0;
    for (size_t k = a; k < b; k++) {
      const float want = (k >= static_cast<size_t>(L) && in[k - L] != 0.0f) ? amp : 0.0f;
      if (std::fabs(out[k] - want) > 1e-6f) bad++;
      if (out[k] > 0.1f) peaks++;
    }
    if (bad) omtest::fail("aligned output", __FILE__, __LINE__, std::string(what) + ": " + std::to_string(bad) + " wrong samples");
    return peaks;
  };
  const size_t settle = static_cast<size_t>(frames * 10);  // (the mix ramp: tau 10 ms)
  OM_CHECK(checkSpan(256, wetEnd, 1.0f, "wet") > 0);
  OM_CHECK(checkSpan(wetEnd + settle, dryEnd, 1.0f, "bypass") > 0);
  OM_CHECK(checkSpan(dryEnd + settle, out.size(), 1.0f, "dry/wet 0.5") > 0);  // one single peak (no comb)
  // a latency change (kLatencyChanged): compensated after the next callback
  fx->delay = 600;
  host.setProcessorLatency(0, 600);
  host.setMix(0, 1.0f);
  runBlocks(1, 1.0f);
  OM_CHECK(host.latencyFrames(0) == 600);
  OM_CHECK(host.takeEvents(0) & kVstLatency);
  {
    const VstSlotStatus s600 = host.status(0);
    OM_CHECK(s600.latency == 600 && s600.latencyChanged);
  }
  // above the cap later: bypassed, the deck keeps the compensated latency (no jump)
  host.setProcessorLatency(0, 48001);
  runBlocks(2, 1.0f);
  const VstSlotStatus st = host.status(0);
  OM_CHECK(st.latencyRefused && st.bypassed && st.latency == 600);
  OM_CHECK(host.latencyFrames(0) == 600);
  OM_CHECK(host.takeEvents(0) & kVstLatency);
  const size_t a = out.size();
  runBlocks(30, 1.0f);
  int bad = 0;
  for (size_t k = a; k < out.size(); k++)
    if (out[k] != in[k - 600]) bad++;
  OM_CHECK(bad == 0);  // the latency-aligned dry
}

// ---------------------------------------------------------------------------
// Transport at the insert input position
// ---------------------------------------------------------------------------
OM_TEST(vst_transport_at_input_position) {
  VstHost host;
  std::string err;
  host.start(44100, kMaxBlockFrames, &err);
  auto fx = std::make_shared<TransportFx>();
  OM_CHECK(host.attachProcessor(0, fx, 184, "transport").ok);
  Rig rig(host, 128, 44100);
  Pacer pace(rig.period);
  for (int b = 0; b < 50; b++) {
    VstTransport t;  // what the core computes (heard position + L): here a known pattern
    t.playing = b >= 10;
    t.tempoBpm = 124.0 + b * 0.01;
    t.beatPos = 3.5 + b * 0.0396;
    t.barStartBeat = std::floor(t.beatPos / 4.0) * 4.0;
    t.samplePos = 1000 + static_cast<int64_t>(b) * 128;
    host.setTransport(0, t);
    rig.fill();
    rig.run();
    pace.wait();
  }
  OM_CHECK(fx->calls.load() >= 48);
  bool ok = true;
  int64_t lastSys = 0;
  for (int c = 0; c < std::min(fx->calls.load(), 50); c++) {
    const VstTransport& t = fx->seen[c];
    ok = ok && t.playing == (c >= 10) && t.samplePos == 1000 + int64_t(c) * 128 && std::fabs(t.beatPos - (3.5 + c * 0.0396)) < 1e-12 &&
         t.barStartBeat == std::floor(t.beatPos / 4.0) * 4.0 && std::fabs(t.tempoBpm - (124.0 + c * 0.01)) < 1e-12 &&
         fx->cont[c] == int64_t(c) * 128 && fx->sys[c] > lastSys && fx->rate[c] == 44100.0;
    lastSys = fx->sys[c];
  }
  OM_CHECK(ok);  // each block gets the transport of ITS input position, continuous time without gaps
}

// ---------------------------------------------------------------------------
// SEH: an access violation in process() disables the slot (vst.crashed)
// ---------------------------------------------------------------------------
OM_TEST(vst_seh_crash_disables_slot) {
  if (!vstFaultGuardAvailable()) OM_SKIP("no hardware-fault guard in this build (portable / sanitizer)");
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  auto crash = std::make_shared<CrashFx>(10);
  OM_CHECK(host.attachProcessor(0, crash, 32, "crash").ok);
  for (int d = 1; d < kNumDecks; d++) OM_CHECK(host.attachProcessor(d, std::make_shared<GainFx>(0.5f), 0, "gain").ok);
  Rig rig(host, 256, 48000);
  Pacer pace(rig.period);
  int crashedEvents = 0, othersWrong = 0, deck0Wrong = 0;
  for (int b = 0; b < 40; b++) {
    rig.fill();
    rig.run();
    if (host.takeEvents(0) & kVstCrashed) crashedEvents++;
    const int64_t n0 = static_cast<int64_t>(b) * 256;
    for (int d = 1; d < kNumDecks; d++)
      for (int i = 0; i < 256; i++)
        if (rig.l[d][static_cast<size_t>(i)] != rig.in(d, n0 + i) * 0.5f) {
          othersWrong++;
          break;
        }
    if (b > 10)
      for (int i = 0; i < 256; i++)
        if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i - 32)) {  // latency-aligned dry after the crash
          deck0Wrong++;
          break;
        }
    pace.wait();
  }
  const VstSlotStatus st = host.status(0);
  OM_CHECK(crashedEvents == 1 && st.crashed && !st.active);
  OM_CHECK(crash->calls.load() == 11);  // never called again
  OM_CHECK(othersWrong == 0 && deck0Wrong == 0);
  host.unload(0);
  OM_CHECK(host.attachProcessor(0, std::make_shared<GainFx>(1.0f), 0, "gain").ok);
  OM_CHECK(!host.status(0).crashed);
}


// ---------------------------------------------------------------------------
// Cost of the inline insert itself (no plugin work): what a callback pays
// per block for the hand-off to four workers, the wake-ups and the spin.
// ---------------------------------------------------------------------------
OM_TEST(vst_bench_handoff_overhead) {
#ifdef NDEBUG
  const char* build = "Release";
#else
  const char* build = "Debug";
#endif
  const double rate = 48000;
  const int frames = 128;
  for (int decks : {0, 1, 4}) {
    VstHost host;
    std::string err;
    host.start(rate, kMaxBlockFrames, &err);
    for (int d = 0; d < decks; d++) OM_CHECK(host.attachProcessor(d, std::make_shared<GainFx>(1.0f), 0, "unity").ok);
    Rig rig(host, frames, rate);
    Pacer pace(rig.period);
    std::vector<double> us;
    for (int b = 0; b < 1200; b++) {  // 3.2 s at the device pace (the workers sleep between blocks, as in real use)
      rig.fill();
      us.push_back(rig.run() / 1e3);
      pace.wait();
    }
    us.erase(us.begin(), us.begin() + 100);
    std::printf("  [info] %s, %d deck(s) with an insert, 128-frame blocks at 48 kHz: insert cost per callback median %.1f us, "
                "p99 %.1f us, max %.1f us (period %.0f us)\n",
                build, decks, percentile(us, 0.5), percentile(us, 0.99), percentile(us, 1.0), rig.period * 1e6);
    OM_CHECK(percentile(us, 0.5) < 0.35 * rig.period * 1e6);
  }
}

// ===========================================================================
// Real plugins (Windows + VST3 SDK)
// ===========================================================================
OM_TEST(vst_again_inline_bit_exact_no_added_latency) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = againPath();
  if (!exists(path)) OM_SKIP("again-sample-accurate.vst3 not found (native/tpb or OM_TEST_VST_AGAIN)");
  VstHost host;
  std::string err;
  OM_CHECK(host.start(48000, kMaxBlockFrames, &err));
  const VstLoadResult r = host.load(0, path, "", againState(1.0));
  if (!r.ok) omtest::fail("load again", __FILE__, __LINE__, r.error + " (" + r.code + ")");
  OM_CHECK(r.latency == 0 && r.stateRestored && r.inputs == 2 && r.outputs == 2);
  Rig rig(host, 256, 48000);
  Pacer pace(rig.period);
  int wrong = 0;
  for (int b = 0; b < 200; b++) {
    rig.fill();
    rig.run();
    const int64_t n0 = static_cast<int64_t>(b) * 256;
    for (int i = 0; i < 256; i++)
      if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i) || rig.r[0][static_cast<size_t>(i)] != -0.5f * rig.in(0, n0 + i)) {
        wrong++;
        break;
      }
    pace.wait();
  }
  VstSlotStatus st = host.status(0);
  std::printf("  [info] again inline: %llu blocks on time, %llu late, process avg %.4f ms / max %.4f ms, wrong blocks %d\n",
              static_cast<unsigned long long>(st.processed), static_cast<unsigned long long>(st.lateBlocks), st.avgProcessMs,
              st.maxProcessMs, wrong);
  OM_CHECK(wrong == 0);  // bit-exact, zero added latency
  OM_CHECK(host.latencyFrames(0) == 0);
  // state round trip in the Web engine's format (base64 of the length-framed blob)
  const std::string saved = host.getState(0);
  std::string blob;
  OM_CHECK(base64Decode(saved, blob) && blob.size() == 4 + 28 + 4);
  double gain = 0;
  std::memcpy(&gain, blob.data() + 4 + 20, 8);
  OM_CHECK(gain == 1.0);
  OM_CHECK(host.setState(0, againState(0.5)));
  for (int b = 0; b < 20; b++) {
    rig.fill();
    rig.run();
    pace.wait();
  }
  const int64_t n0 = (rig.block - 1) * 256;
  bool half = true;
  for (int i = 0; i < 256; i++) half = half && rig.l[0][static_cast<size_t>(i)] == rig.in(0, n0 + i) * 0.5f;
  OM_CHECK(half);
  OM_CHECK(host.setState(0, saved));
  OM_CHECK(!host.setState(0, "not base64 !"));
  host.unload(0);
  OM_CHECK(!host.status(0).loaded);
}

OM_TEST(vst_non_ascii_plugin_path) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string src = againPath();
  if (!exists(src)) OM_SKIP("again-sample-accurate.vst3 not found");
  // a copy of the bundle under a folder with accents (a user profile such as C:\Users\Hélène)
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / fromU8("om vst t\xC3\xA9st \xC3\x89t\xC3\xA9");
  std::error_code ec;
  std::filesystem::remove_all(dir, ec);
  std::filesystem::create_directories(dir, ec);
  const std::filesystem::path bundle = dir / fromU8("ag\xC3\xA4in.vst3");
  std::filesystem::copy(fromU8(src), bundle, std::filesystem::copy_options::recursive, ec);
  // the bundle's DLL must carry the bundle's name
  std::filesystem::rename(bundle / "Contents" / "x86_64-win" / "again-sample-accurate.vst3",
                          bundle / "Contents" / "x86_64-win" / fromU8("ag\xC3\xA4in.vst3"), ec);
  if (ec) OM_SKIP("cannot prepare the non-ASCII copy: " + ec.message());
  {
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    const VstLoadResult r = host.load(1, u8(bundle), "", againState(1.0));
    if (!r.ok) omtest::fail("load from a non-ASCII path", __FILE__, __LINE__, r.error);
    const std::vector<VstScanResult> sr = scanVstPluginsDetailed({u8(bundle)});
    // (the again bundle holds two audio effects: AGain Sample Accurate and the Advanced Tutorial)
    if (!(sr.size() == 1 && sr[0].plugins.size() == 2 && sr[0].error.empty() && sr[0].plugins[0].name == "AGain Sample Accurate"))
      omtest::fail("scan of a non-ASCII bundle", __FILE__, __LINE__,
                   sr.empty() ? std::string("no result")
                              : std::to_string(sr[0].plugins.size()) + " plugin(s), source '" + sr[0].source + "', error '" +
                                    sr[0].error + "'");
    std::printf("  [info] non-ASCII bundle: loaded (latency %d) and scanned (%s)\n", r.latency, sr[0].source.c_str());
    host.unload(1);
  }
  std::filesystem::remove_all(dir, ec);  // (the DLL stays mapped: CachedModule; removal may fail, harmless)
}

namespace {
struct KotelnikovRun {
  int latency = -1;
  int measuredDelay = -9999;
  double nullDb = 0, bypassDb = 0;
  int mixPeaks = -1;
  double avgMs = 0, maxMs = 0;
};

// Pink-ish noise at about -20 dBFS through Kotelnikov at its default
// settings, then bypass, then dry / wet 0.5 on impulses.
KotelnikovRun kotelnikovRun(const std::string& path, double rate) {
  KotelnikovRun k;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  const VstLoadResult r = host.load(0, path, "");
  if (!r.ok) omtest::fail("load Kotelnikov", __FILE__, __LINE__, r.error + " (" + r.code + ")");
  k.latency = r.latency;
  const int frames = 256;
  Pacer pace(frames / rate);
  std::vector<float> in, out;
  std::vector<float> bl(frames), br(frames);
  Source src(99);
  double b0 = 0, b1 = 0, b2 = 0;
  auto block = [&](bool impulses, float mix) {
    host.setMix(0, mix);
    for (int i = 0; i < frames; i++) {
      float v;
      if (impulses) {
        v = (in.size() % 4096 == 1000) ? 0.25f : 0.0f;
      } else {
        const double w = src.next();
        b0 = 0.99765 * b0 + w * 0.0990460;  // (Kellet's pink filter, economy)
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        v = static_cast<float>(0.15 * (b0 + b1 + b2 + w * 0.1848));
      }
      bl[static_cast<size_t>(i)] = v;
      br[static_cast<size_t>(i)] = v;
      in.push_back(v);
    }
    {
      rt::Scope s;
      host.startCallback(frames / rate);
      if (host.begin(0, bl.data(), br.data(), frames)) host.end(0, bl.data(), br.data(), frames);
    }
    out.insert(out.end(), bl.begin(), bl.end());
    pace.wait();
  };
  const int L = k.latency;
  for (int b = 0; b < 400; b++) block(false, 1.0f);
  // measured delay: the lag that nulls best (0 = exactly what the plugin reports)
  double best = 1e9;
  for (int lag = 0; lag < 400; lag++) {
    double e = 0;
    for (size_t n = 48000; n < out.size(); n++) e = std::max(e, static_cast<double>(std::fabs(out[n] - in[n - lag])));
    if (e < best) {
      best = e;
      k.measuredDelay = lag;
    }
  }
  k.nullDb = 20 * std::log10(std::max(best, 1e-30));
  const size_t a = out.size();
  for (int b = 0; b < 100; b++) block(false, 0.0f);
  double eb = 0;  // once the 10 ms mix ramp has settled (~140 ms): exactly the latency-aligned dry
  for (size_t n = a + static_cast<size_t>(0.25 * rate); n < out.size(); n++)
    eb = std::max(eb, static_cast<double>(std::fabs(out[n] - in[n - L])));
  k.bypassDb = 20 * std::log10(std::max(eb, 1e-30));
  const size_t c = out.size();
  for (int b = 0; b < 60; b++) block(true, 0.5f);
  k.mixPeaks = 0;
  for (size_t n = c + 2400; n < out.size(); n++) {
    const bool want = in[n - L] != 0.0f;
    if (std::fabs(out[n]) > 0.01f) {
      if (!want) {  // a second (comb) copy of the impulse
        k.mixPeaks = -1;
        break;
      }
      k.mixPeaks++;
    }
  }
  const VstSlotStatus st = host.status(0);
  k.avgMs = st.avgProcessMs;
  k.maxMs = st.maxProcessMs;
  return k;
}
}  // namespace

OM_TEST(vst_kotelnikov_inline_latency_null_bypass) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = kotelnikovPath();
  if (!exists(path)) OM_SKIP("TDR Kotelnikov.vst3 not installed (OM_TEST_VST_KOTELNIKOV)");
  for (double rate : {48000.0, 44100.0}) {
    const KotelnikovRun k = kotelnikovRun(path, rate);
    std::printf("  [info] Kotelnikov @ %.0f Hz: reported latency %d, measured delay %d (error %d samples), null %.1f dBFS, "
                "bypass %.1f dBFS, dry/wet 0.5 single peaks %d, process avg %.4f ms max %.4f ms\n",
                rate, k.latency, k.measuredDelay, k.measuredDelay - k.latency, k.nullDb, k.bypassDb, k.mixPeaks, k.avgMs, k.maxMs);
    OM_CHECK(k.latency == 184);
    OM_CHECK(k.measuredDelay == k.latency);  // compensated with a 0-sample error
    OM_CHECK(k.nullDb < -120.0);             // output = input delayed at default settings
    OM_CHECK(k.bypassDb < -300.0);           // bypass = the latency-aligned dry (exact)
    OM_CHECK(k.mixPeaks > 0);                // one single peak per impulse (no comb filter)
  }
}

OM_TEST(vst_kotelnikov_four_instances_cpu) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = kotelnikovPath();
  if (!exists(path)) OM_SKIP("TDR Kotelnikov.vst3 not installed (OM_TEST_VST_KOTELNIKOV)");
  const double rate = 48000;
  const int frames = 128;
  VstHost host;
  std::string err;
  host.start(rate, kMaxBlockFrames, &err);
  for (int d = 0; d < kNumDecks; d++) {
    const VstLoadResult r = host.load(d, path, "");
    if (!r.ok) omtest::fail("load Kotelnikov x4", __FILE__, __LINE__, r.error);
  }
  Rig rig(host, frames, rate);
  Pacer pace(rig.period);
  std::vector<double> ms;
  for (int b = 0; b < 1500; b++) {  // 4 s
    rig.fill();
    ms.push_back(rig.run() / 1e6);
    pace.wait();
  }
  uint64_t late = 0;
  std::printf("  [info] 4 x Kotelnikov, 128-frame blocks at 48 kHz (period 2.667 ms, deadline 0.933 ms): callback median %.4f "
              "ms, p99 %.4f ms, max %.4f ms\n",
              percentile(ms, 0.5), percentile(ms, 0.99), percentile(ms, 1.0));
  for (int d = 0; d < kNumDecks; d++) {
    const VstSlotStatus st = host.status(d);
    late += st.lateBlocks;
    std::printf("  [info]   deck %d: process avg %.4f ms (%.2f %% of the period), max %.4f ms, late %llu, allocations %llu\n", d,
                st.avgProcessMs, 100.0 * st.avgProcessMs / (rig.period * 1000.0), st.maxProcessMs,
                static_cast<unsigned long long>(st.lateBlocks), static_cast<unsigned long long>(st.pluginAllocs));
    OM_CHECK(st.loaded && !st.crashed && !st.hung && st.latency == 184);
  }
  OM_CHECK(late * 100 <= 1500u * kNumDecks);  // <= 1 % late on a shared PC
}

OM_TEST(vst_fault_plugins_never_silence_other_decks) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string dir = omtest::envString("OM_TEST_VST_FAULTS");
  if (dir.empty()) OM_SKIP("OM_TEST_VST_FAULTS=<folder of om-fault-N.vst3> not set");
  for (int fault : {6, 5}) {  // process() hangs 4 s at block 20; process() crashes after 20 blocks
    const std::string path = u8(fromU8(dir) / ("om-fault-" + std::to_string(fault) + ".vst3"));
    if (!exists(path)) OM_SKIP("missing " + path);
    VstHost host;
    std::string err;
    host.start(48000, kMaxBlockFrames, &err);
    const VstLoadResult r = host.load(0, path, "");
    if (!r.ok) omtest::fail("load fault plugin", __FILE__, __LINE__, r.error);
    for (int d = 1; d < kNumDecks; d++) OM_CHECK(host.attachProcessor(d, std::make_shared<GainFx>(0.5f), 0, "gain").ok);
    Rig rig(host, 256, 48000);
    Pacer pace(rig.period);
    int othersWrong = 0, deck0Wrong = 0;
    uint8_t ev = 0;
    double maxMs = 0;
    const int64_t t0 = nowNs();
    for (int b = 0; nowNs() - t0 < (fault == 6 ? 2'500'000'000 : 400'000'000); b++) {
      rig.fill();
      maxMs = std::max(maxMs, rig.run() / 1e6);
      ev |= host.takeEvents(0);
      const int64_t n0 = static_cast<int64_t>(b) * 256;
      for (int d = 1; d < kNumDecks; d++)
        for (int i = 0; i < 256; i++)
          if (rig.l[d][static_cast<size_t>(i)] != rig.in(d, n0 + i) * 0.5f) {
            othersWrong++;
            break;
          }
      for (int i = 0; i < 256; i++)  // the fault plugin copies its input: on time or dry, the input
        if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i)) {
          deck0Wrong++;
          break;
        }
      pace.wait();
    }
    const VstSlotStatus st = host.status(0);
    std::printf("  [info] om-fault-%d on deck 1: %s%s, decks 2-4 wrong blocks %d, deck 1 wrong blocks %d, slowest callback "
                "%.3f ms\n",
                fault, (ev & kVstHung) ? "hung" : "", (ev & kVstCrashed) ? "crashed" : "", othersWrong, deck0Wrong, maxMs);
    OM_CHECK(othersWrong == 0 && deck0Wrong == 0);
    if (fault == 6) OM_CHECK((ev & kVstHung) && st.hung);
    else OM_CHECK((ev & kVstCrashed) && st.crashed);
    OM_CHECK(maxMs < 0.35 * rig.period * 1000.0 + 2.0);
    host.unload(0);  // a hung plugin is abandoned with its worker; a crashed one is left loaded
    OM_CHECK(!host.status(0).loaded);
  }
}

// The SDK backend with a real VST3 binary: transport, FP environment, setup
// order, latency changes (kLatencyChanged, a restored state, a new rate),
// kIoChanged, kReloadComponent.
OM_TEST(vst_spy_plugin_host_contract) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
  const std::string path = spyPath();
  if (!exists(path)) OM_SKIP("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  VstHost host;
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  const VstLoadResult r = host.load(0, path, "");
  if (!r.ok) omtest::fail("load spy", __FILE__, __LINE__, r.error);
  OM_CHECK(r.latency == 64);
  Rig rig(host, 256, 48000);
  Pacer pace(rig.period);
  VstTransport last;
  int wrong = 0;
  int lat = 64;
  auto blocks = [&](int n, bool check) {
    for (int b = 0; b < n; b++) {
      VstTransport t;
      t.playing = rig.block >= 5;
      t.tempoBpm = 128.0;
      t.beatPos = 10.0 + rig.block * (256.0 / 48000.0) * (128.0 / 60.0);
      t.barStartBeat = std::floor(t.beatPos / 4.0) * 4.0;
      t.samplePos = 1000 + rig.block * 256;
      host.setTransport(0, t);
      last = t;
      rig.fill();
      const int64_t n0 = rig.block * 256;
      rig.run();
      if (check)
        for (int i = 0; i < 256; i++)
          if (rig.l[0][static_cast<size_t>(i)] != rig.in(0, n0 + i - lat)) {
            wrong++;
            break;
          }
      pace.wait();
    }
  };
  blocks(40, true);
  std::string rep = spyReport(host, 0);
  OM_CHECK(!rep.empty());
  const double calls = reportValue(rep, "calls");
  // ProcessContext flags (ivstprocesscontext.h): kPlaying 1<<1, kSystemTimeValid 1<<8, kProjectTimeMusicValid 1<<9,
  // kTempoValid 1<<10, kBarPositionValid 1<<11, kTimeSigValid 1<<13, kContTimeValid 1<<17
  const uint32_t st = static_cast<uint32_t>(reportValue(rep, "state"));
  const uint32_t want = (1u << 1) | (1u << 8) | (1u << 9) | (1u << 10) | (1u << 11) | (1u << 13) | (1u << 17);
  std::printf("  [info] spy: %s\n", rep.c_str());
  OM_CHECK(wrong == 0);                                         // output = input delayed by the reported latency
  OM_CHECK(calls >= 38 && reportValue(rep, "ftzDazAtEntry") == calls);  // FTZ | DAZ at every call, restored after each
  OM_CHECK(reportValue(rep, "nullLists") == 0);                 // parameter changes and event lists never null
  OM_CHECK(reportValue(rep, "handler2") == 1);                  // IComponentHandler2
  OM_CHECK(reportValue(rep, "compStateSync") >= 1);             // controller synchronised on a fresh load
  OM_CHECK((st & want) == want);
  OM_CHECK(reportValue(rep, "tempo") == 128.0);
  OM_CHECK(std::fabs(reportValue(rep, "ppq") - last.beatPos) < 1e-6);
  OM_CHECK(reportValue(rep, "bar") == last.barStartBeat);
  OM_CHECK(reportValue(rep, "proj") == static_cast<double>(last.samplePos));
  OM_CHECK(reportValue(rep, "cont") == static_cast<double>((rig.block - 1) * 256));
  OM_CHECK(reportValue(rep, "sys") > 0);
  // kLatencyChanged: deactivated / reactivated, the new latency compensated
  const double deact0 = reportValue(rep, "deactivations");
  OM_CHECK(host.setState(0, spyCommand("LAT:300")));
  blocks(1, false);
  OM_CHECK(host.latencyFrames(0) == 300);
  OM_CHECK(host.takeEvents(0) & kVstLatency);
  lat = 300;
  blocks(30, true);
  rep = spyReport(host, 0);
  OM_CHECK(reportValue(rep, "deactivations") > deact0 && reportValue(rep, "latency") == 300);
  OM_CHECK(wrong == 0);
  // a restored preset that changes the latency without telling: re-read after the restore (V05)
  OM_CHECK(host.setState(0, spyCommand("SILENTLAT:500")));
  blocks(1, false);
  OM_CHECK(host.latencyFrames(0) == 500);
  lat = 500;
  blocks(30, true);
  OM_CHECK(wrong == 0);
  // kIoChanged: the output bus becomes mono (re-read, buffers re-prepared, duplicated)
  OM_CHECK(host.setState(0, spyCommand("IO:1")));
  for (int i = 0; i < 100 && reportValue(spyReport(host, 0), "out") != 1; i++) blocks(1, false);
  blocks(5, false);
  bool mono = true;
  for (int i = 0; i < 256; i++) mono = mono && rig.l[0][static_cast<size_t>(i)] == rig.r[0][static_cast<size_t>(i)];
  OM_CHECK(mono && host.status(0).active);
  OM_CHECK(host.setState(0, spyCommand("IO:2")));
  blocks(5, false);
  // kReloadComponent: re-created with its state, the deck keeps its compensation
  const double inst0 = reportValue(spyReport(host, 0), "instances");
  OM_CHECK(host.setState(0, spyCommand("RELOAD")));
  double inst1 = inst0;
  for (int i = 0; i < 200 && inst1 <= inst0; i++) {
    blocks(1, false);
    inst1 = reportValue(spyReport(host, 0), "instances");
  }
  OM_CHECK(inst1 > inst0);
  blocks(20, false);
  wrong = 0;
  blocks(20, true);
  OM_CHECK(wrong == 0 && host.latencyFrames(0) == 500 && host.status(0).active);
  // a new device rate: re-setup, the latency re-read (500 at 48 kHz -> 1000 at 96 kHz) and compensated
  host.reconfigure(96000, kMaxBlockFrames);
  host.startCallback(256 / 96000.0);
  OM_CHECK(host.latencyFrames(0) == 1000);
  OM_CHECK(host.takeEvents(0) & kVstLatency);
  rep = spyReport(host, 0);
  OM_CHECK(reportValue(rep, "rate") == 96000 && reportValue(rep, "latency") == 1000);
  host.unload(0);
}

#ifdef _WIN32
namespace {
// The editor frame of this process (class "OpenMixVstEditor"), captured
// from that window only (PrintWindow): a share of non-black pixels.
struct FrameFind {
  HWND found = nullptr;
};
BOOL CALLBACK findEditorFrame(HWND w, LPARAM p) {
  DWORD pid = 0;
  GetWindowThreadProcessId(w, &pid);
  wchar_t cls[64] = {};
  if (pid == GetCurrentProcessId() && GetClassNameW(w, cls, 64) && !wcscmp(cls, L"OpenMixVstEditor")) {
    reinterpret_cast<FrameFind*>(p)->found = w;
    return FALSE;
  }
  return TRUE;
}
double captureNonBlack(HWND w, int* width, int* height) {
  RECT rc{};
  GetClientRect(w, &rc);
  const int cw = rc.right, ch = rc.bottom;
  if (width) *width = cw;
  if (height) *height = ch;
  if (cw <= 0 || ch <= 0) return 0;
  HDC wdc = GetDC(w);
  HDC mdc = CreateCompatibleDC(wdc);
  HBITMAP bmp = CreateCompatibleBitmap(wdc, cw, ch);
  HGDIOBJ old = SelectObject(mdc, bmp);
  PrintWindow(w, mdc, PW_CLIENTONLY | 0x2 /* PW_RENDERFULLCONTENT */);
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = cw;
  bi.bmiHeader.biHeight = -ch;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  std::vector<uint32_t> px(static_cast<size_t>(cw) * ch);
  GetDIBits(mdc, bmp, 0, static_cast<UINT>(ch), px.data(), &bi, DIB_RGB_COLORS);
  SelectObject(mdc, old);
  DeleteObject(bmp);
  DeleteDC(mdc);
  ReleaseDC(w, wdc);
  size_t nb = 0;
  for (uint32_t p : px) nb += (p & 0xFFFFFF) != 0;
  return static_cast<double>(nb) / static_cast<double>(px.size());
}

// load / process / state round trip / editor (off-screen, captured) / unload
void realPluginSmoke(const std::string& path, const char* label) {
  VstHost host;
  VstHostOptions o;
  o.editorsOffscreen = true;  // never in front of what the user is doing; no synthetic input
  host.setOptions(o);
  std::string err;
  host.start(48000, kMaxBlockFrames, &err);
  const VstLoadResult r = host.load(0, path, "");
  if (!r.ok) omtest::fail("load", __FILE__, __LINE__, std::string(label) + ": " + r.error);
  Rig rig(host, 256, 48000);
  Pacer pace(rig.period);
  for (int b = 0; b < 190; b++) {  // ~1 s
    rig.fill();
    rig.run();
    pace.wait();
  }
  VstSlotStatus st = host.status(0);
  OM_CHECK(st.loaded && !st.crashed && !st.hung && st.processed + st.lateBlocks >= 180);
  const std::string state = host.getState(0);
  OM_CHECK(!state.empty());
  OM_CHECK(host.setState(0, state));
  OM_CHECK(host.getState(0) == state || !host.getState(0).empty());
  // OM_TEST_VST_NO_EDITOR=1: no plugin window at all (the PC is in use; even off-screen windows are not wanted)
  const bool noEditor = omtest::envFlag("OM_TEST_VST_NO_EDITOR");
  const std::string e = noEditor ? std::string("not opened (OM_TEST_VST_NO_EDITOR)") : host.openEditor(0, 0);
  double share = -1;
  int w = 0, h = 0;
  if (e.empty()) {
    OM_CHECK(host.status(0).editorOpen);
    for (int i = 0; i < 30; i++) {  // let it paint (the audio keeps running)
      rig.fill();
      rig.run();
      pace.wait();
    }
    FrameFind f;
    EnumWindows(findEditorFrame, reinterpret_cast<LPARAM>(&f));
    OM_CHECK(f.found != nullptr);
    if (f.found) {
      RECT wr{};
      GetWindowRect(f.found, &wr);
      OM_CHECK(wr.left < -10000);                    // off-screen
      OM_CHECK(GetForegroundWindow() != f.found);    // never activated
      share = captureNonBlack(f.found, &w, &h);
    }
    host.closeEditor(0);
    OM_CHECK(!host.status(0).editorOpen);
  }
  std::printf("  [info] %s: load ok (latency %d), %llu blocks processed, state %zu base64 chars restored, editor %s "
              "(%dx%d, %.0f %% drawn)\n",
              label, r.latency, static_cast<unsigned long long>(st.processed), state.size(), e.empty() ? "opened" : e.c_str(), w,
              h, share * 100);
  host.unload(0);
}
}  // namespace
#endif

OM_TEST(vst_real_plugin_load_process_state_editor) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
#ifdef _WIN32
  std::string path = omtest::envString("OM_TEST_VST_PLUGIN");
  if (path.empty()) path = kotelnikovPath();
  if (!exists(path)) OM_SKIP("OM_TEST_VST_PLUGIN=<path.vst3> not set and Kotelnikov not installed");
  realPluginSmoke(path, "OM_TEST_VST_PLUGIN");
  const std::string faults = omtest::envString("OM_TEST_VST_FAULTS");
  const std::string editorFake = faults.empty() ? "" : u8(fromU8(faults) / "om-fault-17.vst3");
  if (exists(editorFake)) realPluginSmoke(editorFake, "om-fault-17 (editor)");
#endif
}

// ---------------------------------------------------------------------------
// The scan runs in a child process (here: this executable, filtered to the
// child entry below); a crashing or hanging module only affects the child.
// ---------------------------------------------------------------------------
OM_TEST(vst_scan_child_entry) {
  const std::string paths = omtest::envString("OM_VST_SCAN_PATHS");
  const std::string outFile = omtest::envString("OM_VST_SCAN_OUT");
  if (paths.empty() || outFile.empty()) OM_SKIP("runs only as the scan child process");
  std::vector<std::string> list;
  std::stringstream ss(paths);
  for (std::string p; std::getline(ss, p, '|');)
    if (!p.empty()) list.push_back(p);
  VstTimeouts t;
  t.scan = static_cast<uint32_t>(std::max(100.0, std::atof(omtest::envString("OM_VST_SCAN_TIMEOUT_MS").c_str())));
  const std::vector<VstScanResult> res = scanVstPluginsDetailed(list, t);
  std::ofstream o(fromU8(outFile), std::ios::binary);
  for (const VstScanResult& r : res) {
    o << r.path << '\t' << r.plugins.size() << '\t' << r.crashed << '\t' << r.timedOut << '\t' << r.source << '\t' << r.error;
    for (const VstPluginInfo& p : r.plugins) o << '\t' << p.name << '|' << p.uid;
    o << '\n';
  }
}

OM_TEST(vst_scan_in_child_process) {
  if (!needSdk()) OM_SKIP("built without the VST3 SDK");
#ifdef _WIN32
  std::vector<std::string> paths;
  if (exists(againPath())) paths.push_back(againPath());
  const std::string faults = omtest::envString("OM_TEST_VST_FAULTS");
  for (int f : {0, 1, 2, 3}) {  // fine, crash in GetPluginFactory, hang in GetPluginFactory, crash in InitDll
    const std::string p = faults.empty() ? "" : u8(fromU8(faults) / ("om-fault-" + std::to_string(f) + ".vst3"));
    if (exists(p)) paths.push_back(p);
  }
  paths.push_back("C:\\does\\not\\exist.vst3");
  std::string joined;
  for (const std::string& p : paths) joined += p + "|";
  const std::filesystem::path out = std::filesystem::temp_directory_path() / ("om_vst_scan_" + std::to_string(GetCurrentProcessId()) + ".txt");
  std::error_code rmErr0;
  std::filesystem::remove(out, rmErr0);
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  std::wstring cmd = L"\"" + std::wstring(exe) + L"\" vst_scan_child_entry";
  auto wide = [](const std::string& s) { return std::filesystem::path(fromU8(s)).wstring(); };
  SetEnvironmentVariableW(L"OM_VST_SCAN_PATHS", wide(joined).c_str());
  SetEnvironmentVariableW(L"OM_VST_SCAN_OUT", out.wstring().c_str());
  SetEnvironmentVariableW(L"OM_VST_SCAN_TIMEOUT_MS", L"1500");
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  const BOOL started = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW,
                                      nullptr, nullptr, &si, &pi);
  SetEnvironmentVariableW(L"OM_VST_SCAN_PATHS", nullptr);
  SetEnvironmentVariableW(L"OM_VST_SCAN_OUT", nullptr);
  SetEnvironmentVariableW(L"OM_VST_SCAN_TIMEOUT_MS", nullptr);
  OM_CHECK(started);
  const DWORD w = WaitForSingleObject(pi.hProcess, 90000);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  if (w != WAIT_OBJECT_0) TerminateProcess(pi.hProcess, 9);  // (our own child, by handle)
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  OM_CHECK(w == WAIT_OBJECT_0);
  std::vector<std::vector<std::string>> rows;
  {
    std::ifstream in(out, std::ios::binary);
    for (std::string line; std::getline(in, line);) {
      std::vector<std::string> cols;
      std::stringstream ls(line);
      for (std::string c; std::getline(ls, c, '\t');) cols.push_back(c);
      rows.push_back(cols);
    }
  }
  std::error_code rmErr;
  std::filesystem::remove(out, rmErr);
  OM_CHECK(rows.size() == paths.size());
  std::string report;
  for (size_t i = 0; i < rows.size() && i < paths.size(); i++) {
    const auto& c = rows[i];
    if (c.size() < 5) continue;
    report += "\n           " + std::filesystem::path(fromU8(c[0])).filename().string() + ": " + c[1] + " plugin(s)" +
              (c[2] == "1" ? ", crashed" : "") + (c[3] == "1" ? ", timed out" : "") + (c.size() > 5 && !c[5].empty() ? " (" + c[5] + ")" : "") +
              (c[4].empty() ? "" : " [" + c[4] + "]");
    const std::string name = std::filesystem::path(fromU8(c[0])).filename().string();
    if (name == "again-sample-accurate.vst3")
      OM_CHECK(c[1] == "2" && c[4] == "moduleinfo" && c.size() > 6 && c[6].rfind("AGain Sample Accurate|", 0) == 0);
    if (name == "om-fault-0.vst3") OM_CHECK(c[1] == "1" && c[4] == "module");
    if (name == "om-fault-1.vst3" || name == "om-fault-3.vst3") OM_CHECK(c[1] == "0" && c[2] == "1");
    if (name == "om-fault-2.vst3") OM_CHECK(c[1] == "0" && c[3] == "1");
    if (name == "exist.vst3") OM_CHECK(c[1] == "0" && !c[5].empty());
  }
  std::printf("  [info] scan child process exit code %lu:%s\n", static_cast<unsigned long>(code), report.c_str());
  OM_CHECK(code == 0);
#endif
}
