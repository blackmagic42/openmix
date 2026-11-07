// End-to-end tests of the VST3 inserts through the whole core (owner: host),
// manual mode (NULL device, offline render, silent). What om_test_vst cannot
// reach (it links om_vst alone): the parts only the core computes.
//  - The insert state of the snapshot (om_deck_state.insert_state /
//    insert_late, SPEC.md §15.5) from VstHost::insertState(): the core's
//    wiring on fakes (every value, the JSON), then the real VstHost with an
//    attached processor (none, active, late, bypassed, crashed, none again).
//  - V08: the ProcessContext the plugin receives comes from the deck and the
//    sync engine (tempo, musical position of the audio entering the insert,
//    bar start, kPlaying, project samples, system time) through play, tempo
//    changes, pause, seek and a loop; the track is a ramp, so the om-spy
//    test plugin's first input sample of each block tells which track frame
//    entered the insert.
//  - V05: plugin latency changes after load (host thread, restored state,
//    audio thread) reach the deck's read-ahead: the master output stays on
//    the heard timeline of a render without the plugin.
//  - V25: a deck with TDR Kotelnikov is the no-plugin output delayed by
//    exactly its latency after play and after a hot cue (attack kept).
// From the vst-inline campaign's harness (7 Nov 2026,
// HANDOFF/refs/native/verify-backups/vst-inline/harness/e2e/e2e_core_vst.cpp).
// The plugin tests skip without the VST3 SDK (portable, ASan) and when
// om-spy.vst3 (tests/vst/spy, OM_TEST_VST_SPY) or Kotelnikov
// (OM_TEST_VST_KOTELNIKOV) is not there. No plugin editor is ever opened.
// SPEC.md §13.2, §13.3, §15.5.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "core_util.h"
#include "om/engine.h"
#include "om/json.h"
#include "om/om_state.h"
#include "om/pcm.h"
#include "om/vst_insert.h"

using namespace om;
using namespace omtest;

namespace {

constexpr double kRate = 48000.0;
constexpr int kBlock = 256;                  // NULL device block
constexpr double kScale = 1.0 / 33554432.0;  // ramp: track frame n -> n * 2^-25 (60 s: < 0.09, about -21 dBFS)
constexpr double kBpm = 128.0, kBeatOffset = 0.25;

std::filesystem::path fromU8(const std::string& s) {
  return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}
std::string u8(const std::filesystem::path& p) {
  const std::u8string s = p.u8string();
  return std::string(s.begin(), s.end());
}
bool exists(const std::string& p) {
  std::error_code ec;
  return !p.empty() && std::filesystem::exists(fromU8(p), ec);
}
// om-spy (tests/vst/spy): OM_TEST_VST_SPY, else the folder the vst tests use.
std::string spyPath() {
  const std::string e = envString("OM_TEST_VST_SPY");
  if (!e.empty()) return e;
  return u8((std::filesystem::path(__FILE__).parent_path() / ".." / ".." / "build-tests-vst-spy" / "Release" / "om-spy.vst3")
                .lexically_normal());
}
std::string kotelnikovPath() {
  const std::string e = envString("OM_TEST_VST_KOTELNIKOV");
  if (!e.empty()) return e;
  const std::string local = envString("LOCALAPPDATA");
  return local.empty() ? std::string() : u8(fromU8(local) / "Programs" / "Common" / "VST3" / "TDR Kotelnikov.vst3");
}
std::string jsonString(const std::string& s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '\\' || c == '"') out += '\\';
    out += c;
  }
  return out + "\"";
}
// An om-spy command as a state blob (32-bit length-framed component state, no controller state).
std::string spyCommand(const std::string& cmd) {
  std::string blob;
  const uint32_t n1 = static_cast<uint32_t>(cmd.size()), n2 = 0;
  blob.append(reinterpret_cast<const char*>(&n1), 4);
  blob += cmd;
  blob.append(reinterpret_cast<const char*>(&n2), 4);
  return base64Encode(blob);
}
double pct(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  return v[std::min(v.size() - 1, static_cast<size_t>(p * (v.size() - 1) + 0.5))];
}

// ---- the insert state ------------------------------------------------------------------
// The engine's IVstHost seam over a VstHost the test keeps, so it can attach
// processors (VstHost::attachProcessor is not reachable through commands).
class HostRef final : public IVstHost {
 public:
  explicit HostRef(std::shared_ptr<VstHost> h) : h_(std::move(h)) {}
  bool start(double sampleRate, int maxBlockFrames, std::string* err) override { return h_->start(sampleRate, maxBlockFrames, err); }
  void stop() override { h_->stop(); }
  bool running() const noexcept override { return h_->running(); }
  void reconfigure(double sampleRate, int maxBlockFrames) override { h_->reconfigure(sampleRate, maxBlockFrames); }
  void setOwnerWindow(uintptr_t hwnd) override { h_->setOwnerWindow(hwnd); }
  VstLoadResult load(int deck, const std::string& path, const std::string& uid, const std::string& state) override {
    return h_->load(deck, path, uid, state);
  }
  void unload(int deck) override { h_->unload(deck); }
  bool setState(int deck, const std::string& state) override { return h_->setState(deck, state); }
  std::string getState(int deck) override { return h_->getState(deck); }
  std::string openEditor(int, uintptr_t) override { return "no editor in this test"; }
  void closeEditor(int) override {}
  VstSlotStatus status(int deck) const override { return h_->status(deck); }
  uint8_t insertState(int deck, uint64_t* lateBlocks) const noexcept override { return h_->insertState(deck, lateBlocks); }
  void startCallback(double periodSeconds) noexcept override { h_->startCallback(periodSeconds); }
  void setDeadline(float f) noexcept override { h_->setDeadline(f); }
  void setMix(int deck, float mix) noexcept override { h_->setMix(deck, mix); }
  void setTransport(int deck, const VstTransport& t) noexcept override { h_->setTransport(deck, t); }
  uint8_t takeEvents(int deck) noexcept override { return h_->takeEvents(deck); }
  bool begin(int deck, const float* l, const float* r, int frames) noexcept override { return h_->begin(deck, l, r, frames); }
  void end(int deck, float* l, float* r, int frames) noexcept override { h_->end(deck, l, r, frames); }
  int latencyFrames(int deck) const noexcept override { return h_->latencyFrames(deck); }

 private:
  std::shared_ptr<VstHost> h_;
};

// Passthrough on the deck worker; slow (sleeps) or crashing on demand.
struct StateProc final : IVstProcessor {
  std::atomic<int> sleepMs{0};
  std::atomic<bool> crash{false};
  std::atomic<int> calls{0};
  VstProcessResult process(const VstProcessBlock& b) override {
    calls.fetch_add(1);
    if (crash.load()) return VstProcessResult::Crashed;
    const int ms = sleepMs.load();
    if (ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    std::memcpy(b.outL, b.inL, sizeof(float) * static_cast<size_t>(b.frames));
    std::memcpy(b.outR, b.inR, sizeof(float) * static_cast<size_t>(b.frames));
    return VstProcessResult::Ok;
  }
};

}  // namespace

OM_TEST(core_vst_insert_state_reaches_the_snapshot_and_the_state_event) {
  // The core copies IVstHost::insertState() into every snapshot (fakes: every value).
  TestEngine t;
  OM_CHECK(t.started);
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  om_state st = t.state();
  for (int d = 0; d < kNumDecks; d++) OM_CHECK(st.decks[d].insert_state == OM_INSERT_NONE && st.decks[d].insert_late == 0);
  const uint8_t values[] = {OM_INSERT_ACTIVE, OM_INSERT_BYPASSED, OM_INSERT_LATE, OM_INSERT_HUNG, OM_INSERT_CRASHED, OM_INSERT_NONE};
  uint64_t late = 0;
  for (uint8_t v : values) {
    late += 3;
    t.fb.vst->insert[1] = v;
    t.fb.vst->insertLate[1] = late;
    OM_CHECK(t.e->render(nullptr, 256) == 256);
    st = t.state();
    OM_CHECK(st.decks[1].insert_state == v && st.decks[1].insert_late == late);
    OM_CHECK(st.decks[0].insert_state == OM_INSERT_NONE && st.decks[2].insert_state == OM_INSERT_NONE);
  }
  // ... and the "state" event carries it (SPEC.md §15.5: decks[i].insert {state, late})
  t.fb.vst->insert[3] = OM_INSERT_HUNG;
  t.fb.vst->insertLate[3] = 7;
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  t.e->pump();
  const json::Value ev = t.find("state");
  OM_CHECK(ev["decks"].at(3)["insert"]["state"].asNumber(-1) == OM_INSERT_HUNG);
  OM_CHECK(ev["decks"].at(3)["insert"]["late"].asNumber(-1) == 7);
}

OM_TEST(core_vst_insert_state_from_the_real_host_none_active_late_bypassed_crashed) {
  auto host = std::make_shared<VstHost>();
  TestEngine t(true, [host](EngineOptions& o) {
    o.nullConfig.blockFrames = 1024;  // 21.3 ms periods: the deadline leaves room on a busy PC
    o.backends.createVstHost = [host]() -> std::unique_ptr<IVstHost> { return std::make_unique<HostRef>(host); };
  });
  OM_CHECK(t.started);
  t.cmd(R"({"cmd":"engine.config","vstDeadline":0.6})");  // 12.8 ms per callback
  constexpr int kDeck = 2;
  auto render = [&t](int blocks) {
    for (int i = 0; i < blocks; i++) OM_CHECK(t.e->render(nullptr, 1024) == 1024);
    return t.state();
  };
  om_state st = render(1);
  OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_NONE && st.decks[kDeck].insert_late == 0);
  auto proc = std::make_shared<StateProc>();
  const VstLoadResult r = host->attachProcessor(kDeck, proc, 0, "state probe");
  OM_CHECK(r.ok);
  // active: on time (a loaded PC may make one block late: the state then says so)
  bool sawActive = false;
  for (int i = 0; i < 40 && !sawActive; i++) {
    st = render(1);
    OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_ACTIVE || st.decks[kDeck].insert_state == OM_INSERT_LATE);
    sawActive = st.decks[kDeck].insert_state == OM_INSERT_ACTIVE;
  }
  OM_CHECK(sawActive && proc->calls.load() > 0);
  OM_CHECK(st.decks[0].insert_state == OM_INSERT_NONE);
  // late: a 60 ms process() misses the deadline, then the worker is still busy
  proc->sleepMs = 60;
  st = render(3);
  OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_LATE);
  OM_CHECK(st.decks[kDeck].insert_late >= 1);
  const uint32_t lateCount = st.decks[kDeck].insert_late;
  OM_CHECK(lateCount == host->status(kDeck).lateBlocks);
  proc->sleepMs = 0;
  std::this_thread::sleep_for(std::chrono::milliseconds(150));  // the worker finishes the slow block
  sawActive = false;
  for (int i = 0; i < 40 && !sawActive; i++) {
    st = render(1);
    sawActive = st.decks[kDeck].insert_state == OM_INSERT_ACTIVE;
  }
  OM_CHECK(sawActive && st.decks[kDeck].insert_late >= lateCount);
  // bypassed: vst.mix 0 (the latency-aligned dry; the plugin keeps running)
  t.cmd(R"({"cmd":"vst.mix","deck":2,"mix":0})");
  st = render(1);
  OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_BYPASSED);
  t.cmd(R"({"cmd":"vst.mix","deck":2,"mix":1})");
  st = render(1);
  OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_ACTIVE || st.decks[kDeck].insert_state == OM_INSERT_LATE);
  // crashed: the slot is disabled for the session (vst.crashed)
  proc->crash = true;
  for (int i = 0; i < 40 && st.decks[kDeck].insert_state != OM_INSERT_CRASHED; i++) st = render(1);
  OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_CRASHED);
  t.e->pump();
  OM_CHECK(t.countEvents("vst.crashed") == 1);
  // unloaded: none again, the counter with it
  t.cmd(R"({"cmd":"vst.unload","deck":2,"id":1})");
  t.e->pump();
  OM_CHECK(t.reply(1)["ok"].asBool());
  st = render(1);
  OM_CHECK(st.decks[kDeck].insert_state == OM_INSERT_NONE && st.decks[kDeck].insert_late == 0);
  // the status reply still carries latencyChanged: the snapshot never consumed it
  OM_CHECK(host->status(kDeck).latencyChanged);
}

// ===========================================================================
// V08 / V05 / V25 with real plugins
// ===========================================================================
namespace {

// One engine (manual mode, the real VstHost) with its master output and events.
struct Run {
  std::unique_ptr<Engine> e;
  std::mutex m;
  std::vector<std::string> events;
  std::vector<float> outL, outR;
  int64_t frames = 0;
  int nextId = 100;

  explicit Run(const std::vector<std::string>& plugins) {
    EngineOptions o;
    o.manual = true;
    o.nullDevice = true;
    e = std::make_unique<Engine>(o);
    e->setEventSink([this](std::string_view j) {
      std::lock_guard<std::mutex> lk(m);
      events.emplace_back(j);
    });
    std::string err;
    if (!e->start(&err)) fail("engine start", __FILE__, __LINE__, err);
    EnginePolicy p;
    p.vstFiles = plugins;
    e->setPolicy(p);
  }
  ~Run() {
    if (e) e->stop();
  }
  void render(int n) {
    std::vector<float> out(static_cast<size_t>(n) * 4);
    if (e->render(out.data(), n) != n) fail("render", __FILE__, __LINE__);
    for (int i = 0; i < n; i++) {
      outL.push_back(out[static_cast<size_t>(i) * 4]);
      outR.push_back(out[static_cast<size_t>(i) * 4 + 1]);
    }
    frames += n;
    e->pump();
  }
  void seconds(double s) { render(static_cast<int>(std::lround(s * kRate / kBlock)) * kBlock); }
  void cmd(const std::string& j) {
    std::string err;
    for (int i = 0; i < 100; i++) {
      const CommandResult r = e->command(j, &err);
      if (r == CommandResult::Ok) return;
      if (r == CommandResult::Invalid) fail("command", __FILE__, __LINE__, j + ": " + err);
      render(kBlock);
    }
    fail("command queue full", __FILE__, __LINE__, j);
  }
  json::Value reply(int id) {
    e->pump();
    std::lock_guard<std::mutex> lk(m);
    for (auto it = events.rbegin(); it != events.rend(); ++it) {
      json::Value v;
      std::string err;
      if (!json::parse(*it, v, &err)) continue;
      if (v["ev"].asString() == "reply" && v["id"].asNumber(-1) == id) return v;
    }
    return json::Value();
  }
  // a command answered by a reply (vst jobs run inside pump() in manual mode)
  json::Value ask(const std::string& body) {
    const int id = nextId++;
    cmd("{\"id\":" + std::to_string(id) + "," + body + "}");
    e->pump();
    return reply(id);
  }
  bool handoffRamp(uint32_t loadId, int64_t n) {
    PcmDesc d;
    d.loadId = loadId;
    d.kind = PcmKind::Track;
    d.format = PcmFormat::F32;
    d.sourceChannels = 2;
    d.sampleRate = static_cast<int>(kRate);
    d.frames = n;
    d.headroom = 1.0f;
    if (e->pcmBegin(d) != PcmError::None) return false;
    std::vector<float> planar;
    for (int64_t off = 0; off < n; off += TrackBuffer::kChunkFrames) {
      const int k = static_cast<int>(std::min<int64_t>(TrackBuffer::kChunkFrames, n - off));
      planar.assign(static_cast<size_t>(k) * 2, 0.0f);
      for (int i = 0; i < k; i++) {
        const float v = static_cast<float>(static_cast<double>(off + i) * kScale);
        planar[static_cast<size_t>(i)] = v;
        planar[static_cast<size_t>(k + i)] = v;
      }
      if (e->pcmWrite(loadId, off, k, 2, planar.data()) != PcmError::None) return false;
    }
    return e->pcmEnd(loadId) == PcmError::None;
  }
  // track (60 s ramp) on deck 0 with a 128 BPM grid
  void loadTrack() {
    if (!handoffRamp(1, static_cast<int64_t>(60 * kRate))) fail("pcm handoff", __FILE__, __LINE__);
    const json::Value r = ask(R"("cmd":"deck.load","deck":0,"loadId":1,"grid":{"bpm":128,"beatOffset":0.25})");
    if (!r["ok"].asBool()) fail("deck.load", __FILE__, __LINE__, json::stringify(r));
  }
  VstLoadResult loadPlugin(const std::string& path) {
    const json::Value r = ask("\"cmd\":\"vst.load\",\"deck\":0,\"path\":" + jsonString(path) + ",\"uid\":\"\"");
    VstLoadResult out;
    out.ok = r["ok"].asBool();
    out.latency = static_cast<int>(r["latency"].asNumber(-1));
    out.error = r["error"].asString();
    return out;
  }
  bool spySet(const std::string& command) {
    return ask("\"cmd\":\"vst.setState\",\"deck\":0,\"state\":\"" + spyCommand(command) + "\"")["ok"].asBool();
  }
  std::string spyText() {
    const json::Value r = ask(R"("cmd":"vst.getState","deck":0)");
    std::string blob;
    if (!base64Decode(r["state"].asString(), blob) || blob.size() < 8) return {};
    uint32_t n1 = 0;
    std::memcpy(&n1, blob.data(), 4);
    return blob.substr(4, n1);
  }
  int latencyNow() {
    om_state s{};
    e->readState(s);
    return static_cast<int>(std::lround(s.decks[0].proc_latency * kRate));
  }
};

// One record of the om-spy per-block log (report version 2).
struct Rec {
  int64_t idx = 0, cont = 0, proj = 0, sys = 0;
  uint32_t state = 0, csr = 0;
  double tempo = 0, ppq = 0, bar = 0;
  float firstIn = 0;
  int frames = 0;
};
std::vector<Rec> parseLog(const std::string& text) {
  std::vector<Rec> out;
  std::stringstream ss(text);
  std::string line;
  std::getline(ss, line);  // "LOG"
  while (std::getline(ss, line)) {
    Rec r;
    long long idx, cont, proj, sys;
    unsigned st, csr;
    double fi;
    if (std::sscanf(line.c_str(), "%lld %lld %u %lf %lf %lf %lld %lld %lf %d %u", &idx, &cont, &st, &r.tempo, &r.ppq, &r.bar, &proj, &sys, &fi,
                    &r.frames, &csr) == 11) {
      r.idx = idx;
      r.cont = cont;
      r.proj = proj;
      r.sys = sys;
      r.state = st;
      r.csr = csr;
      r.firstIn = static_cast<float>(fi);
      out.push_back(r);
    }
  }
  return out;
}

// Steinberg::Vst::ProcessContext state flags
constexpr uint32_t kPlaying = 1u << 1, kTempoValid = 1u << 10, kProjectTimeMusicValid = 1u << 9, kBarPositionValid = 1u << 11,
                   kSystemTimeValid = 1u << 8, kContTimeValid = 1u << 17, kTimeSigValid = 1u << 13;

// The spy, version 2, or a skip / a clear failure.
std::string needSpy() {
  if (!vstSdkAvailable(nullptr)) skip("VST3 SDK not compiled in (portable / ASan build)");
  const std::string spy = spyPath();
  if (!exists(spy)) skip("om-spy.vst3 not built (tests/vst/spy, OM_TEST_VST_SPY)");
  return spy;
}
void checkSpyVersion(Run& run) {
  if (run.spyText().find("spyVersion=2") == std::string::npos)
    fail("om-spy.vst3 report version 2", __FILE__, __LINE__,
         "om-spy.vst3 is older than tests/vst/spy/om_spy_plugin.cxx: rebuild it (" + spyPath() + ")");
}

// blocks of [a, b) where s(g) != ref(g - shift) (both channels, exact)
int mismatches(const Run& s, const Run& ref, int64_t a, int64_t b, int shift, int64_t* lastBad = nullptr) {
  int bad = 0;
  for (int64_t blk = a; blk + kBlock <= b; blk += kBlock) {
    bool same = true;
    for (int64_t g = blk; g < blk + kBlock && same; g++) {
      const int64_t h = g - shift;
      const float rl = h >= 0 ? ref.outL[static_cast<size_t>(h)] : 0.0f, rr = h >= 0 ? ref.outR[static_cast<size_t>(h)] : 0.0f;
      same = s.outL[static_cast<size_t>(g)] == rl && s.outR[static_cast<size_t>(g)] == rr;
    }
    if (!same) {
      bad++;
      if (lastBad) *lastBad = blk;
    }
  }
  return bad;
}

}  // namespace

OM_TEST(core_vst_e2e_v08_process_context_follows_the_deck) {
  const std::string spy = needSpy();
  Run run({spy});
  run.loadTrack();
  const VstLoadResult lr = run.loadPlugin(spy);
  if (!lr.ok) fail("vst.load spy", __FILE__, __LINE__, lr.error);
  const int L = lr.latency;
  checkSpyVersion(run);
  const int64_t F0 = run.frames;  // the plugin's continuous time 0
  struct Cmd {
    int64_t frame;
    const char* what;
    double tempo;  // deck tempo from then on
  };
  std::vector<Cmd> cmds;
  double tempo = 1.0;
  auto at = [&](const char* what, const std::string& json, double newTempo = -1) {
    if (newTempo > 0) tempo = newTempo;
    cmds.push_back({run.frames, what, tempo});
    run.cmd(json);
  };
  run.render(10 * kBlock);
  at("play", R"({"cmd":"deck.play","deck":0})");
  run.seconds(1.0);
  at("tempo 174.5 BPM", R"({"cmd":"deck.tempo","deck":0,"r":1.36328125})", 1.36328125);
  run.seconds(1.0);
  at("tempo 126 BPM", R"({"cmd":"deck.tempo","deck":0,"r":0.984375})", 0.984375);
  run.seconds(1.0);
  at("pause", R"({"cmd":"deck.pause","deck":0})");
  run.seconds(0.5);
  at("play", R"({"cmd":"deck.play","deck":0})");
  run.seconds(0.5);
  at("seek 30 s", R"({"cmd":"deck.seek","deck":0,"t":30})");
  run.seconds(0.5);
  at("seek 40 s + loop of 4 beats", R"([{"cmd":"deck.seek","deck":0,"t":40},{"cmd":"deck.loop","deck":0,"start":40,"end":41.875}])");
  run.seconds(4.0);
  at("loop exit", R"({"cmd":"deck.loopExit","deck":0})");
  run.seconds(0.5);
  const int64_t end = run.frames;
  OM_CHECK(run.spySet("LOG:4000"));
  const std::vector<Rec> log = parseLog(run.spyText());
  OM_CHECK(run.spySet("LOG:0"));
  // expectations per record (render frame g = F0 + cont)
  auto lastCmd = [&](int64_t g) -> const Cmd* {
    const Cmd* c = nullptr;
    for (const Cmd& k : cmds)
      if (k.frame <= g) c = &k;
    return c;
  };
  auto aroundCmd = [&](int64_t g, int64_t frames) {
    for (const Cmd& k : cmds)
      if (g >= k.frame - kBlock && g < k.frame + frames) return true;
    return false;
  };
  int records = 0, playWrong = 0, decoded = 0, barWrong = 0, sysWrong = 0, flagsWrong = 0;
  std::vector<double> ppqErr, projErr, tempoErr;
  double worstPpq = 0, worstProj = 0, worstTempo = 0;
  int64_t lastSys = 0;
  for (const Rec& r : log) {
    const int64_t g = F0 + r.cont;
    if (g < F0 || g >= end) continue;
    records++;
    const Cmd* c = lastCmd(g);
    const bool playing = c && std::strcmp(c->what, "pause") != 0;
    const bool gotPlaying = (r.state & kPlaying) != 0;
    if (!aroundCmd(g, kBlock) && gotPlaying != playing) playWrong++;
    const uint32_t need = kTempoValid | kProjectTimeMusicValid | kBarPositionValid | kSystemTimeValid | kContTimeValid | kTimeSigValid;
    if ((r.state & need) != need) flagsWrong++;
    if (r.bar != std::floor(r.ppq / 4.0) * 4.0) barWrong++;
    if (r.sys <= lastSys) sysWrong++;
    lastSys = r.sys;
    // the audio entering the insert: which track frame (the ramp), away from fades and jumps
    if (!playing || !gotPlaying || aroundCmd(g, 2400) || !(r.firstIn > 1e-6f)) continue;
    decoded++;
    const double pos = r.firstIn / kScale;  // track frame
    const double ppqWant = (pos / kRate - kBeatOffset) * kBpm / 60.0;
    const double ePpq = r.ppq - ppqWant, eProj = static_cast<double>(r.proj) - pos, eTempo = r.tempo - kBpm * c->tempo;
    ppqErr.push_back(std::fabs(ePpq));
    projErr.push_back(std::fabs(eProj));
    tempoErr.push_back(std::fabs(eTempo));
    worstPpq = std::max(worstPpq, std::fabs(ePpq));
    worstProj = std::max(worstProj, std::fabs(eProj));
    worstTempo = std::max(worstTempo, std::fabs(eTempo));
  }
  std::printf("  [info] V08 spy log (latency %d, %zu records, %d in the scenario): kPlaying wrong %d, flags missing %d, "
              "bar != floor(ppq/4)*4: %d, systemTime not increasing %d; decoded %d blocks from the ramp: ppq error max %.2e beats "
              "(p99 %.2e), projectTimeSamples error max %.2f frames, tempo error max %.4f BPM\n",
              L, log.size(), records, playWrong, flagsWrong, barWrong, sysWrong, decoded, worstPpq, pct(ppqErr, 0.99), worstProj, worstTempo);
  OM_CHECK(records > 1500 && decoded > 1000);
  OM_CHECK(playWrong == 0 && flagsWrong == 0 && barWrong == 0 && sysWrong == 0);
  OM_CHECK(worstPpq < 0.002);  // < 0.9 ms of musical position at 128 BPM
  OM_CHECK(worstProj <= 2.0);
  OM_CHECK(worstTempo < 0.01);
}

OM_TEST(core_vst_e2e_v05_latency_changes_reach_the_read_ahead) {
  const std::string spy = needSpy();
  // the same scenario twice: without plugin (reference), with the spy (a pure delay of its latency)
  struct Step {
    double sec;
    const char* what;
    std::string spyCmd;  // "" = none; "mix:0" / "mix:1" = vst.mix
  };
  const std::vector<Step> steps = {{1.0, "play (latency 64)", ""},
                                   {1.0, "LAT:300 (kLatencyChanged)", "LAT:300"},
                                   {1.0, "SILENTLAT:500 (restored state)", "SILENTLAT:500"},
                                   {1.0, "RTLAT:200 (from process())", "RTLAT:200"},
                                   {1.0, "bypass (vst.mix 0)", "mix:0"},
                                   {1.0, "vst.mix 1", "mix:1"}};
  Run ref({});
  Run s({spy});
  ref.loadTrack();
  s.loadTrack();
  const VstLoadResult lr = s.loadPlugin(spy);
  if (!lr.ok) fail("vst.load spy", __FILE__, __LINE__, lr.error);
  checkSpyVersion(s);
  ref.seconds(1.0);  // (the mixer's gain smoothers settle first: they run on absolute time, the comparison is shifted)
  s.seconds(1.0);
  std::vector<int64_t> starts;
  for (size_t i = 0; i < steps.size(); i++) {
    starts.push_back(s.frames);
    if (i == 0) {
      ref.cmd(R"({"cmd":"deck.play","deck":0})");
      s.cmd(R"({"cmd":"deck.play","deck":0})");
    } else if (steps[i].spyCmd == "mix:0" || steps[i].spyCmd == "mix:1") {
      s.cmd(std::string(R"({"cmd":"vst.mix","deck":0,"mix":)") + (steps[i].spyCmd == "mix:0" ? "0" : "1") + "}");
    } else {
      OM_CHECK(s.spySet(steps[i].spyCmd));
    }
    ref.seconds(steps[i].sec);
    s.seconds(steps[i].sec);
  }
  // a hot cue (seek while playing): heard the current latency later, attack kept
  starts.push_back(s.frames);
  ref.cmd(R"({"cmd":"deck.seek","deck":0,"t":20})");
  s.cmd(R"({"cmd":"deck.seek","deck":0,"t":20})");
  ref.seconds(0.5);
  s.seconds(0.5);
  starts.push_back(s.frames);
  const int finalLatency = s.latencyNow();
  std::string report;
  bool ok = true;
  for (size_t i = 0; i + 1 < starts.size(); i++) {
    const bool seekStep = i == steps.size();
    const int shift = seekStep ? finalLatency : lr.latency;  // play anchored the timeline at the latency then; a seek at the current one
    int64_t lastBad = -1;
    const int bad = mismatches(s, ref, starts[i], starts[i + 1], shift, &lastBad);
    const double settleMs = lastBad < 0 ? 0.0 : (lastBad + kBlock - starts[i]) * 1000.0 / kRate;
    char t[220];
    std::snprintf(t, sizeof t, "\n           %-32s shift %4d: %3d of %3lld blocks differ, exact from +%.1f ms on",
                  seekStep ? "hot cue (seek 20 s)" : steps[i].what, shift, bad, static_cast<long long>((starts[i + 1] - starts[i]) / kBlock),
                  settleMs);
    report += t;
    if (settleMs > 200.0) ok = false;  // every segment ends exactly on the timeline (re-aligned well within 1 s)
  }
  std::printf("  [info] V05 master output with the spy vs without plugin, deck 1 playing a ramp (latency at the end %d):%s\n", finalLatency,
              report.c_str());
  OM_CHECK(finalLatency == 200);
  OM_CHECK(ok);
}

OM_TEST(core_vst_e2e_v25_kotelnikov_delay_play_and_hot_cue) {
  if (!vstSdkAvailable(nullptr)) OM_SKIP("VST3 SDK not compiled in (portable / ASan build)");
  const std::string kot = kotelnikovPath();
  if (!exists(kot)) OM_SKIP("TDR Kotelnikov.vst3 not installed (OM_TEST_VST_KOTELNIKOV)");
  Run ref({});
  Run k({kot});
  ref.loadTrack();
  k.loadTrack();
  const VstLoadResult lr = k.loadPlugin(kot);
  if (!lr.ok) fail("vst.load Kotelnikov", __FILE__, __LINE__, lr.error);
  ref.seconds(1.0);
  k.seconds(1.0);
  const int64_t playAt = k.frames;
  ref.cmd(R"({"cmd":"deck.play","deck":0})");
  k.cmd(R"({"cmd":"deck.play","deck":0})");
  ref.seconds(1.0);
  k.seconds(1.0);
  const int64_t cueAt = k.frames;
  ref.cmd(R"({"cmd":"deck.seek","deck":0,"t":12})");
  k.cmd(R"({"cmd":"deck.seek","deck":0,"t":12})");
  ref.seconds(1.0);
  k.seconds(1.0);
  // first audible frame after play
  auto firstAbove = [](const Run& r, int64_t from, float thr) {
    for (int64_t g = from; g < static_cast<int64_t>(r.outL.size()); g++)
      if (std::fabs(r.outL[static_cast<size_t>(g)]) > thr) return g;
    return int64_t(-1);
  };
  const int64_t refPlay = firstAbove(ref, playAt, 1e-7f), kPlay = firstAbove(k, playAt, 1e-7f);
  // the shift that makes the whole output equal to the reference
  int bestShift = -1;
  for (int sh = 0; sh <= 400 && bestShift < 0; sh++)
    if (mismatches(k, ref, playAt, k.frames, sh) == 0) bestShift = sh;
  const int bad1 = mismatches(k, ref, playAt, cueAt, lr.latency), bad2 = mismatches(k, ref, cueAt, k.frames, lr.latency);
  std::printf("  [info] V25 Kotelnikov (latency %d) vs no plugin: first audible frame after play +%lld vs +%lld; the whole output equals the "
              "reference delayed by exactly %d frames (%.2f ms): %d blocks differ after play, %d after the hot cue (its attack kept)\n",
              lr.latency, static_cast<long long>(kPlay - playAt), static_cast<long long>(refPlay - playAt), bestShift, bestShift * 1000.0 / kRate,
              bad1, bad2);
  OM_CHECK(lr.latency == 184 && bestShift == 184);
  OM_CHECK(bad1 == 0 && bad2 == 0);
}
