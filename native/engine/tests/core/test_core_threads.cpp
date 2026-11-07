// Core tests in threaded mode (owner: host): state only when new at most
// stateHz, heartbeat whatever the audio does, the stall watchdog (diag stall,
// one stream restart, device {reason:"stalled"} when the restart does not
// help), the control thread never held up by blocking ops / vst-ops jobs,
// and the silent NULL real-time soak (OM_SOAK_SECONDS, 10 minutes for the
// acceptance run) with its CPU numbers. Silent: NULL device and fake
// devices only. SPEC.md §3.5, §8.6, Appendix B.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "core_util.h"

using namespace om;
using namespace omtest;

namespace {
using Clock = std::chrono::steady_clock;

void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

// Waits until `pred` holds (polling every 10 ms), at most `ms`.
template <class P>
bool waitFor(int ms, P pred) {
  const auto end = Clock::now() + std::chrono::milliseconds(ms);
  while (Clock::now() < end) {
    if (pred()) return true;
    sleepMs(10);
  }
  return pred();
}

struct Timed {
  double t;  // seconds since the test started
  std::string json;
};

// Event times are taken from the "t" of hb events (engine clock) and from
// the block of state events.
std::vector<double> hbTimes(TestEngine& t) {
  std::vector<double> out;
  for (const std::string& s : t.log.snapshot()) {
    json::Value v;
    std::string err;
    if (json::parse(s, v, &err) && v["ev"].asString() == "hb") out.push_back(v["t"].asNumber(0));
  }
  return out;
}
}  // namespace

OM_TEST(core_threaded_null_soak_state_cadence_heartbeat_and_cpu) {
  const std::string env = envString("OM_SOAK_SECONDS");
  const double seconds = env.empty() ? 6.0 : std::max(1.0, std::atof(env.c_str()));
  TestEngine t(false, [](EngineOptions& o) {
    o.nullConfig.realtime = true;  // paced NULL device: silent, never touches a sound card
    o.nullConfig.blockFrames = 128;
    o.stateHz = 60;
    o.heartbeatMs = 250;
  });
  OM_CHECK(t.started);
  // Four decks playing a handed-off track (silence-level tone, NULL device anyway).
  for (int d = 0; d < kNumDecks; d++) {
    OM_CHECK(t.handoff(static_cast<uint32_t>(100 + d), 48000 * 4, 0.1f));
    t.cmd(std::string(R"({"cmd":"deck.load","deck":)") + std::to_string(d) + R"(,"loadId":)" + std::to_string(100 + d) +
          R"(,"grid":{"bpm":124,"beatOffset":0.05}})");
    t.cmd(std::string(R"([{"cmd":"deck.loop","deck":)") + std::to_string(d) + R"(,"start":0.5,"end":2.5},{"cmd":"deck.play","deck":)" +
          std::to_string(d) + "}]");
  }
  const auto t0 = Clock::now();
  const uint64_t b0 = t.e->stats().blocks;
  sleepMs(static_cast<int>(seconds * 1000));
  const double wall = std::chrono::duration<double>(Clock::now() - t0).count();
  const EngineStats s = t.e->stats();
  const uint64_t blocks = s.blocks - b0;
  const double expected = wall * 48000.0 / 128.0;
  const om_state st = t.state();

  // State events: only new snapshots, at most stateHz per second.
  uint64_t lastBlock = 0;
  int states = 0, nonIncreasing = 0;
  double maxLoad = 0, sumLoad = 0;
  for (const std::string& e : t.log.snapshot()) {
    json::Value v;
    std::string err;
    if (!json::parse(e, v, &err) || v["ev"].asString() != "state") continue;
    const uint64_t blk = static_cast<uint64_t>(v["block"].asNumber(0));
    if (blk <= lastBlock) nonIncreasing++;
    lastBlock = blk;
    states++;
    maxLoad = std::max(maxLoad, v["device"]["maxLoad"].asNumber(0));
    sumLoad += v["device"]["load"].asNumber(0);
  }
  const std::vector<double> hbs = hbTimes(t);
  double maxHbGap = 0;
  for (size_t i = 1; i < hbs.size(); i++) maxHbGap = std::max(maxHbGap, hbs[i] - hbs[i - 1]);
  const double blockUs = 128.0 / 48000.0 * 1e6;
  std::printf("[soak] %.1f s wall: %llu blocks of 128 (expected %.0f, %.2f %%), %d state events (%.1f/s), %zu hb (max gap %.0f ms),\n"
              "       load per 128-frame block: mean %.4f (%.2f us of %.0f us), max %.4f; xruns %llu, rtAllocs %llu, rtFrees %llu,\n"
              "       control: %llu iterations, max gap %.1f ms\n",
              wall, static_cast<unsigned long long>(blocks), expected, 100.0 * blocks / expected, states, states / wall,
              hbs.size(), maxHbGap * 1000, states ? sumLoad / states : 0.0, states ? sumLoad / states * blockUs : 0.0, blockUs,
              maxLoad, static_cast<unsigned long long>(st.device.xruns), static_cast<unsigned long long>(st.health.rt_allocs),
              static_cast<unsigned long long>(st.health.rt_frees), static_cast<unsigned long long>(s.controlIterations),
              s.maxControlGapMs);
  OM_CHECK(blocks > expected * 0.95 && blocks < expected * 1.05);  // the pacer keeps real time
  OM_CHECK(nonIncreasing == 0);                                    // state only when new
  // At most stateHz; the lower bound only proves the stream is alive (the
  // NULL pacer of a portable build sleeps with the OS timer granularity).
  OM_CHECK(states <= wall * 60 * 1.05 + 5 && states >= wall * 20);
  OM_CHECK(hbs.size() >= wall * 4 * 0.75 && maxHbGap < 0.6);
  OM_CHECK(st.health.rt_allocs == 0 && st.health.rt_frees == 0 && st.health.events_lost == 0);
  OM_CHECK(st.health.stalls == 0 && !t.log.has("\"kind\":\"stall\""));
  OM_CHECK(st.decks[0].playing == 1 && st.device.mode == 1);
}

OM_TEST(core_threaded_hb_while_audio_frozen_then_one_restart_recovers) {
  TestEngine t(false, [](EngineOptions& o) {
    o.stallMs = 300;
    o.stalledMs = 1500;
  });
  FakeWorld& w = t.fb.world;
  w.threaded = true;
  w.devices = {FakeWorld::info("{A}", "Speakers", 0, 2, 48000, true)};
  t.cmd(R"({"cmd":"device.open","id":1,"mode":"lowlatency"})");
  OM_CHECK(waitFor(3000, [&] { return !t.reply(1).isNull(); }));
  OM_CHECK(t.reply(1)["ok"].asBool());
  OM_CHECK(waitFor(2000, [&] { return t.countEvents("state") >= 5; }));
  // The driver freezes: no block any more, the device still says "running".
  FakeOutput* out = w.current();
  OM_CHECK(out != nullptr);
  const int hbBefore = t.countEvents("hb");
  out->setFreeze(true);
  sleepMs(120);
  const int statesAtFreeze = t.countEvents("state");
  OM_CHECK(waitFor(2000, [&] { return t.log.has("\"kind\":\"stall\""); }));
  const int statesAtStall = t.countEvents("state");
  OM_CHECK(statesAtStall - statesAtFreeze <= 1);  // a frozen audio thread stops the state stream
  OM_CHECK(t.countEvents("hb") >= hbBefore + 1);  // ... not the heartbeat
  // One restart: a new (working) stream, the audio comes back.
  OM_CHECK(waitFor(3000, [&] { return t.log.has("\"kind\":\"stall-recovered\""); }));
  OM_CHECK(t.e->stats().stallRestarts == 1 && w.created.load() == 2);
  sleepMs(300);
  OM_CHECK(t.countEvents("state") > statesAtStall + 3);
  OM_CHECK(!t.log.has("\"reason\":\"stalled\""));
  const om_state st = t.state();
  OM_CHECK(st.health.stalls == 1);
}

OM_TEST(core_threaded_stalled_when_the_restart_does_not_help) {
  TestEngine t(false, [](EngineOptions& o) {
    o.stallMs = 300;
    o.stalledMs = 1200;
  });
  FakeWorld& w = t.fb.world;
  w.threaded = true;
  w.devices = {FakeWorld::info("{A}", "Speakers", 0, 2, 48000, true)};
  t.cmd(R"({"cmd":"device.open","id":1,"mode":"shared"})");
  OM_CHECK(waitFor(3000, [&] { return t.reply(1)["ok"].asBool(); }));
  OM_CHECK(waitFor(2000, [&] { return t.countEvents("state") >= 3; }));
  w.freezeNew = true;  // the restarted stream is frozen too
  const auto t0 = Clock::now();
  w.current()->setFreeze(true);
  OM_CHECK(waitFor(4000, [&] { return t.log.has("\"reason\":\"stalled\""); }));
  const double ms = std::chrono::duration<double>(Clock::now() - t0).count() * 1000;
  std::printf("[stall] stalled reported %.0f ms after the freeze (stall 300 ms + 1200 ms)\n", ms);
  OM_CHECK(ms > 1300 && ms < 3500);
  OM_CHECK(t.e->stats().stallRestarts == 1);
  OM_CHECK(t.countEvents("hb") > 0);
}

OM_TEST(core_threaded_control_never_blocked_by_ops_or_vst_jobs) {
  TestEngine t(false, [](EngineOptions& o) {
    o.nullConfig.realtime = true;
    o.jobHook = [](const char* route, const char* cmd) {
      (void)route;
      // A slow device (COM) and a plugin dialog waiting for the user.
      if (std::string(cmd) == "device.list" || std::string(cmd) == "vst.unload") sleepMs(1500);
    };
  });
  OM_CHECK(t.started);
  OM_CHECK(waitFor(2000, [&] { return t.countEvents("state") >= 5; }));
  t.log.clear();
  const double e0 = t.e->now();
  const auto c0 = Clock::now();
  OM_CHECK(t.cmd(R"([{"cmd":"device.list","id":1},{"cmd":"vst.unload","deck":0,"id":2},{"cmd":"deck.volume","deck":0,"v":0.5}])") ==
           CommandResult::Ok);
  const double cmdMs = std::chrono::duration<double>(Clock::now() - c0).count() * 1000;
  OM_CHECK(cmdMs < 50);  // queued: the caller (host JS thread) never waits
  // Inline commands are answered at once while both job threads are blocked.
  sleepMs(100);
  OM_CHECK(t.cmd(R"({"cmd":"rec.status","id":3})") == CommandResult::Ok && t.log.has("\"id\":3,"));
  // When do the blocked jobs answer? (cheap string search: no JSON parsing in the loop)
  double r1 = -1, r2 = -1;
  while ((r1 < 0 || r2 < 0) && std::chrono::duration<double>(Clock::now() - c0).count() < 5.0) {
    const double el = std::chrono::duration<double>(Clock::now() - c0).count();
    if (r1 < 0 && t.log.has("\"id\":1,")) r1 = el;
    if (r2 < 0 && t.log.has("\"id\":2,")) r2 = el;
    sleepMs(5);
  }
  OM_CHECK(r1 >= 1.45 && r2 >= 1.45);  // both jobs really blocked ~1.5 s (in parallel: ops and vst-ops)
  OM_CHECK(r1 < 3.0 && r2 < 3.0);
  // Meanwhile the control thread kept the heartbeat and the state stream going.
  std::vector<double> hbs;
  for (double x : hbTimes(t))
    if (x >= e0 && x <= e0 + 1.4) hbs.push_back(x);
  double maxGap = hbs.empty() ? 1e9 : hbs.front() - e0;
  for (size_t i = 1; i < hbs.size(); i++) maxGap = std::max(maxGap, hbs[i] - hbs[i - 1]);
  int states = 0;
  for (const std::string& ev : t.log.snapshot()) {
    json::Value v;
    std::string err;
    if (json::parse(ev, v, &err) && v["ev"].asString() == "state" && v["t"].asNumber(0) <= e0 + 1.45) states++;
  }
  std::printf("[control] while ops + vst-ops blocked %.2f / %.2f s: %d state events, %zu hb (max gap %.0f ms), "
              "max control gap %.1f ms\n",
              r1, r2, states, hbs.size(), maxGap * 1000, t.e->stats().maxControlGapMs);
  OM_CHECK(states >= 30);  // the state stream continues (~60 Hz)
  OM_CHECK(hbs.size() >= 4 && maxGap < 0.45);
  OM_CHECK(t.e->stats().maxControlGapMs < 200);
}
