// Core tests of the command paths (owner: host), manual mode on fakes:
// a table-driven test of EVERY protocol command (its route, its reply, the
// RtCommand that reaches the audio thread and the state it leaves), the
// recorder and VST commands and their events (policy, base64 states, owner
// window, crashed / hung / late / latency events, insert latency and
// transport, hello reset unloading plugins, shutdown finalizing a
// recording), lazy FX memory end to end, the event-queue overflow with the
// end-of-track latch, and the retired backlog. Every render runs inside the
// core's rt::Scope: any allocation or free there fails the test.
// SPEC.md §3.2, §3.3, §11.5, §13, §14, §15.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "core_util.h"
#include "om/commands.h"
#include "om/fx.h"
#include "om/protocol.h"
#include "om/sync.h"

using namespace om;
using namespace omtest;

namespace {

// What the audio thread applied (filled inside the render: no allocation).
struct ApplyTrace {
  static constexpr int kMax = 8192;
  RtCommand cmds[kMax];
  int n = 0;
  static void hook(void* user, const RtCommand& c) {
    auto* t = static_cast<ApplyTrace*>(user);
    if (t->n < kMax) t->cmds[t->n++] = c;
  }
  const RtCommand* last(Cmd type) const {
    for (int i = n - 1; i >= 0; i--)
      if (cmds[i].type == type) return &cmds[i];
    return nullptr;
  }
};

void standardDevices(FakeWorld& w) {
  w.devices = {FakeWorld::info("{A}", "Speakers", 0, 2, 48000, true, true),
               FakeWorld::info("{B}", "DDJ-FLX6", 0, 4, 44100)};
}

struct Row {
  const char* name;
  Route route;
  const char* json;  // without the closing brace: the test adds "id" / "seq"
};

}  // namespace

OM_TEST(core_every_command_reaches_its_route_and_module) {
  auto trace = std::make_unique<ApplyTrace>();
  TestEngine t(true, [&](EngineOptions& o) {
    o.applyHook = &ApplyTrace::hook;
    o.applyHookUser = trace.get();
    o.dataDir = "C:/om-test-data";  // fake recorder: nothing is written
  });
  standardDevices(t.fb.world);
  const std::string policy = R"({"vstRoots":["C:\\VST3"]})";
  EnginePolicy pol;
  std::string perr;
  OM_CHECK(parsePolicy(policy, pol, &perr));
  t.e->setPolicy(pol);
  // Media the commands refer to.
  OM_CHECK(t.handoff(901, 48000 * 3));
  OM_CHECK(t.handoff(902, 48000 * 3));
  OM_CHECK(t.handoff(903, 48000 * 3));
  OM_CHECK(t.handoff(904, 48000 * 3));
  OM_CHECK(t.handoff(905, 4800));
  const Row rows[] = {
      // ---- control side (SPEC.md §15.3) ----
      {"hello", Route::Inline, R"({"cmd":"hello","protocol":2,"client":"test")"},
      {"engine.config", Route::Inline, R"({"cmd":"engine.config","stateHz":60,"vstDeadline":0.35)"},
      {"clock.ping", Route::Inline, R"({"cmd":"clock.ping","t0":1.5)"},
      {"device.list", Route::Ops, R"({"cmd":"device.list")"},
      {"device.open", Route::Ops, R"({"cmd":"device.open","name":"DDJ-FLX6","mode":"shared")"},
      {"device.phones", Route::Ops, R"({"cmd":"device.phones","name":"Speakers")"},
      {"device.close", Route::Ops, R"({"cmd":"device.close")"},
      {"device.status", Route::Inline, R"({"cmd":"device.status")"},
      {"pcm.begin", Route::Inline,
       R"({"cmd":"pcm.begin","loadId":900,"kind":"track","format":"s16","sourceChannels":2,"sampleRate":48000,"frames":1000,"headroom":1,"peak":0.5)"},
      {"pcm.abort", Route::Inline, R"({"cmd":"pcm.abort","loadId":900)"},
      {"deck.load", Route::Inline, R"({"cmd":"deck.load","deck":0,"loadId":901,"grid":{"bpm":120,"beatOffset":0.0,"beats":[0,0.5,1,1.5]})"},
      {"deck.unload", Route::Inline, R"({"cmd":"deck.unload","deck":3)"},
      {"deck.stems", Route::Inline, R"({"cmd":"deck.stems","deck":0,"vocals":902,"drums":903,"bass":904)"},
      {"deck.grid", Route::Inline, R"({"cmd":"deck.grid","deck":0,"bpm":124,"beatOffset":0.1,"gridShift":0,"barAnchor":0)"},
      {"sampler.load", Route::Inline, R"({"cmd":"sampler.load","slot":3,"loadId":905)"},
      {"sampler.clear", Route::Inline, R"({"cmd":"sampler.clear","slot":4)"},
      {"rec.start", Route::Ops, R"({"cmd":"rec.start","name":"set 1","format":"wav24")"},
      {"rec.stop", Route::Ops, R"({"cmd":"rec.stop")"},
      {"rec.status", Route::Inline, R"({"cmd":"rec.status")"},
      {"rec.list", Route::Ops, R"({"cmd":"rec.list")"},
      {"vst.load", Route::Vst, R"({"cmd":"vst.load","deck":1,"path":"C:\\VST3\\Fake.vst3","uid":"")"},
      {"vst.unload", Route::Vst, R"({"cmd":"vst.unload","deck":2)"},
      {"vst.editor", Route::Vst, R"({"cmd":"vst.editor","deck":1)"},
      {"vst.editorClose", Route::Vst, R"({"cmd":"vst.editorClose","deck":1)"},
      {"vst.getState", Route::Vst, R"({"cmd":"vst.getState","deck":1)"},
      {"vst.setState", Route::Vst, R"({"cmd":"vst.setState","deck":1,"state":"AAEC")"},
      {"vst.status", Route::Inline, R"({"cmd":"vst.status","deck":1)"},
      // ---- audio thread: mixer ----
      {"master.volume", Route::Audio, R"({"cmd":"master.volume","v":0.7)"},
      {"master.filter", Route::Audio, R"({"cmd":"master.filter","v":-0.3)"},
      {"xf.set", Route::Audio, R"({"cmd":"xf.set","x":0.25)"},
      {"xf.sides", Route::Audio, R"({"cmd":"xf.sides","sides":["B","A","A","B"])"},
      {"color.type", Route::Audio, R"({"cmd":"color.type","type":"dubecho")"},
      {"color.enabled", Route::Audio, R"({"cmd":"color.enabled","on":false)"},
      {"deck.color", Route::Audio, R"({"cmd":"deck.color","deck":1,"v":0.4)"},
      {"deck.pfl", Route::Audio, R"({"cmd":"deck.pfl","deck":2,"on":true)"},
      {"deck.volume", Route::Audio, R"({"cmd":"deck.volume","deck":1,"v":0.6)"},
      {"deck.trim", Route::Audio, R"({"cmd":"deck.trim","deck":1,"v":-0.5)"},
      {"deck.eq", Route::Audio, R"({"cmd":"deck.eq","deck":1,"band":"mid","v":-0.75)"},
      {"deck.padDryHold", Route::Audio, R"({"cmd":"deck.padDryHold","deck":1,"dry":0.3)"},
      {"fx.set", Route::Audio, R"({"cmd":"fx.set","unit":"fx2","type":"pingpong","enabled":true,"level":0.5,"beats":0.75)"},
      {"fx.assign", Route::Audio, R"({"cmd":"fx.assign","assign":[[true,false,false,false],[false,true,false,false],[false,false,true,true],[false,false,false,false]])"},
      {"fx.sends", Route::Audio, R"({"cmd":"fx.sends")"},
      {"fx.pad", Route::Audio, R"({"cmd":"fx.pad","deck":2,"preset":{"type":"reverb","beats":1,"level":0.8})"},
      {"sampler.play", Route::Audio, R"({"cmd":"sampler.play","slot":3,"voice":7,"gain":1)"},
      {"sampler.stop", Route::Audio, R"({"cmd":"sampler.stop","voice":7)"},
      {"vst.mix", Route::Audio, R"({"cmd":"vst.mix","deck":1,"mix":0.25)"},
      // ---- audio thread: deck ----
      {"deck.play", Route::Audio, R"({"cmd":"deck.play","deck":0)"},
      {"deck.pause", Route::Audio, R"({"cmd":"deck.pause","deck":0)"},
      {"deck.seek", Route::Audio, R"({"cmd":"deck.seek","deck":0,"t":1.25)"},
      {"deck.cuePoint", Route::Audio, R"({"cmd":"deck.cuePoint","deck":0,"t":0.75)"},
      {"deck.tempo", Route::Audio, R"({"cmd":"deck.tempo","deck":0,"r":1.06)"},
      {"deck.key", Route::Audio, R"({"cmd":"deck.key","deck":0,"semi":-2)"},
      {"deck.keylock", Route::Audio, R"({"cmd":"deck.keylock","deck":0,"on":true)"},
      {"deck.loop", Route::Audio, R"({"cmd":"deck.loop","deck":0,"start":1.0,"end":1.5)"},
      {"deck.loopExit", Route::Audio, R"({"cmd":"deck.loopExit","deck":0)"},
      {"deck.loopBeats", Route::Audio, R"({"cmd":"deck.loopBeats","deck":0,"beats":2)"},
      {"deck.roll", Route::Audio, R"({"cmd":"deck.roll","deck":0,"beats":0.5,"mix":1)"},
      {"deck.rollMix", Route::Audio, R"({"cmd":"deck.rollMix","deck":0,"mix":0.5)"},
      {"deck.rollStop", Route::Audio, R"({"cmd":"deck.rollStop","deck":0,"immediate":true)"},
      {"deck.scratch", Route::Audio, R"({"cmd":"deck.scratch","deck":0,"phase":"move","t":1.1)"},
      {"deck.spin", Route::Audio, R"({"cmd":"deck.spin","deck":0,"kind":"backspin")"},
      {"deck.stemsOn", Route::Audio, R"({"cmd":"deck.stemsOn","deck":0,"on":true)"},
      {"deck.stemGain", Route::Audio, R"({"cmd":"deck.stemGain","deck":0,"stem":"drums","v":0.5,"tau":0.02)"},
      {"deck.interp", Route::Audio, R"({"cmd":"deck.interp","deck":0,"quality":"hermite")"},
      {"deck.keylockRatio", Route::Audio, R"({"cmd":"deck.keylockRatio","deck":0,"mode":"input")"},
      {"grid.offset", Route::Audio, R"({"cmd":"grid.offset","sec":0.004)"},
      // ---- audio thread: sync ----
      {"sync.master", Route::Audio, R"({"cmd":"sync.master","deck":2)"},
      {"sync.jogHold", Route::Audio, R"({"cmd":"sync.jogHold","on":true)"},
      {"sync.do", Route::Audio, R"({"cmd":"sync.do","deck":1)"},
      {"sync.reanchor", Route::Audio, R"({"cmd":"sync.reanchor","deck":1)"},
      {"sync.snap", Route::Audio, R"({"cmd":"sync.snap","deck":1,"maxErr":0.06)"},
      {"sync.arm", Route::Audio, R"({"cmd":"sync.arm","deck":3,"on":true)"},
      {"sync.base", Route::Audio, R"({"cmd":"sync.base","deck":3,"base":1.02,"ref":null,"pllCorr":0.0005)"},
      {"sync.precision", Route::Audio, R"({"cmd":"sync.precision","on":true)"},
      {"deck.padRoll", Route::Audio, R"({"cmd":"deck.padRoll","deck":1,"beats":0.25,"mix":1)"},
      {"shutdown", Route::Ops, R"({"cmd":"shutdown")"},
  };
  // Every command of the protocol table has a row (a new command needs one).
  int count = 0;
  const CommandSpec* specs = commandSpecs(&count);
  for (int i = 0; i < count; i++) {
    bool found = false;
    for (const Row& r : rows)
      if (std::strcmp(r.name, specs[i].name) == 0) found = true;
    if (!found) omtest::fail("every command has a test row", __FILE__, __LINE__, specs[i].name);
  }
  OM_CHECK(static_cast<int>(sizeof(rows) / sizeof(rows[0])) == count);

  int id = 100;
  uint32_t seq = 1;
  for (const Row& r : rows) {
    const CommandSpec* spec = findCommandSpec(r.name);
    OM_CHECK(spec != nullptr);
    if (spec->route != r.route) omtest::fail("route of SPEC.md §15.3", __FILE__, __LINE__, r.name);
    id++;
    const std::string msg = std::string(r.json) + ",\"id\":" + std::to_string(id) + ",\"seq\":" + std::to_string(seq) + "}";
    std::string err;
    const CommandResult res = t.cmd(msg, &err);
    if (res != CommandResult::Ok) omtest::fail("command accepted", __FILE__, __LINE__, std::string(r.name) + ": " + err);
    const bool replied = !t.reply(id).isNull();
    switch (r.route) {
      case Route::Inline:
        // inline commands that reply do it synchronously, in order with the audio commands
        if (spec->replies && !replied) omtest::fail("inline reply", __FILE__, __LINE__, r.name);
        break;
      case Route::Ops:
      case Route::Vst:
        if (replied) omtest::fail("queued, not answered inline", __FILE__, __LINE__, r.name);
        t.e->pump();
        if (spec->replies && t.reply(id).isNull()) omtest::fail("reply after the job", __FILE__, __LINE__, r.name);
        break;
      case Route::Audio: {
        const int before = trace->n;
        OM_CHECK(t.e->render(nullptr, 256) == 256 || t.fb.world.current() != nullptr);
        if (t.fb.world.current()) t.fb.world.current()->pump(1);
        bool reached = false;
        for (int i = before; i < trace->n; i++)
          if (trace->cmds[i].type == spec->cmd && trace->cmds[i].seq == seq) reached = true;
        if (!reached) omtest::fail("reached the audio thread", __FILE__, __LINE__, r.name);
        const om_state st = t.state();
        if (st.ack < seq) omtest::fail("acknowledged", __FILE__, __LINE__, r.name);
        break;
      }
    }
    seq++;
  }
  OM_CHECK(t.e->stats().unhandledCommands == 0);  // every audio command has a dispatcher case

  // Values that reached the audio thread, parsed and clamped like engine.js.
  const RtCommand* c = trace->last(Cmd::DeckTempo);
  OM_CHECK(c && c->deck == 0 && std::fabs(c->u.tempo.r - 1.06) < 1e-12);
  c = trace->last(Cmd::DeckEq);
  OM_CHECK(c && c->deck == 1 && c->u.eq.band == static_cast<uint8_t>(EqBand::Mid) && c->u.eq.v == -0.75f);
  c = trace->last(Cmd::FxSet);
  OM_CHECK(c && c->u.fx.unit.index == 2 && c->u.fx.mask == (kFxType | kFxEnabled | kFxLevel | kFxBeats));
  OM_CHECK(c->u.fx.type == static_cast<uint8_t>(FxType::PingPong) && c->u.fx.beats == 0.75f);
  c = trace->last(Cmd::XfSides);
  OM_CHECK(c && c->u.xfSides.sides[0] == static_cast<uint8_t>(XfSide::B) && c->u.xfSides.sides[3] == static_cast<uint8_t>(XfSide::B));
  c = trace->last(Cmd::SyncBase);
  OM_CHECK(c && c->u.syncBase.mask == (SyncBaseWrite::kBase | SyncBaseWrite::kRef | SyncBaseWrite::kPllCorr));
  OM_CHECK(std::isnan(c->u.syncBase.ref) && c->u.syncBase.base == 1.02);
  c = trace->last(Cmd::DeckKey);
  OM_CHECK(c && c->u.key.semi == -2);
  c = trace->last(Cmd::AttachStems);
  OM_CHECK(c && c->u.attach.ptr != nullptr);  // deck.stems -> an attach command
  c = trace->last(Cmd::AttachSample);
  OM_CHECK(c != nullptr);
  c = trace->last(Cmd::SetVstDeadline);
  OM_CHECK(c && std::fabs(c->u.deadline.fraction - 0.35f) < 1e-6);
  // The state the deck and sync modules keep for the proxy (engine.js fields).
  const om_state st = t.state();
  OM_CHECK(std::fabs(st.decks[0].tempo - 1.06) < 1e-9 && st.decks[0].key_shift == -2 && st.decks[0].keylock == 1);
  OM_CHECK(std::fabs(st.decks[0].cue_point - 0.75) < 1e-12);
  OM_CHECK(st.sync.master_idx == 2 && st.sync.jog_hold == 1 && st.sync.synced[3] == 1);
  // Replies of the slow commands.
  OM_CHECK(t.find("reply", [](const json::Value& v) { return v["id"].asNumber(0) == 105; })["ok"].asBool());  // device.open
  OM_CHECK(t.log.has("clock.pong") && t.log.has("\"ev\":\"shutdown\""));
}

OM_TEST(core_rec_commands_events_and_shutdown_finalize) {
  TestEngine none;  // no data folder: recordings refused
  none.cmd(R"({"cmd":"rec.start","id":1})");
  none.e->pump();
  OM_CHECK(!none.reply(1)["ok"].asBool() && none.reply(1)["error"].asString() == "no data folder");

  TestEngine t(true, [](EngineOptions& o) { o.dataDir = "D:\\Users\\Dj\\AppData\\Turbo Mix\\"; });
  standardDevices(t.fb.world);
  std::string err;
  OM_CHECK(t.cmd(R"({"cmd":"rec.start","path":"C:\\Windows\\x.wav"})", &err) == CommandResult::Invalid);  // names only
  t.cmd(R"({"cmd":"rec.start","id":2,"name":"Friday set","format":"wav24"})");
  OM_CHECK(t.reply(2).isNull());  // ops thread
  t.e->pump();
  json::Value r = t.reply(2);
  OM_CHECK(r["ok"].asBool() && r["path"].asString() == "D:\\Users\\Dj\\AppData\\Turbo Mix\\recordings/Friday set.wav");
  {
    std::lock_guard<std::mutex> lk(t.fb.rec->m);
    OM_CHECK(t.fb.rec->dir == "D:\\Users\\Dj\\AppData\\Turbo Mix\\recordings" && t.fb.rec->fmt == RecFormat::S24);
    OM_CHECK(t.fb.rec->rate == 48000);
  }
  OM_CHECK(t.e->render(nullptr, 2560) == 2560);
  OM_CHECK(t.fb.rec->pushed.load() == 2560);  // the post-limiter master, every frame
  OM_CHECK(t.state().device.recording == 1);
  t.cmd(R"({"cmd":"rec.status","id":3})");
  OM_CHECK(t.reply(3)["active"].asBool());  // inline
  // Default name when none is given.
  t.cmd(R"({"cmd":"rec.start","id":4})");
  t.e->pump();
  OM_CHECK(t.reply(4)["path"].asString().find("OpenMix ") != std::string::npos);
  // A device at another rate: the recording goes on in the same file.
  t.cmd(R"({"cmd":"device.open","id":5,"name":"DDJ-FLX6","mode":"shared"})");
  t.e->pump();
  OM_CHECK(t.reply(5)["ok"].asBool());
  {
    std::lock_guard<std::mutex> lk(t.fb.rec->m);
    OM_CHECK(t.fb.rec->continuedAt.size() == 1 && t.fb.rec->continuedAt[0] == 44100);
  }
  json::Value ev = t.find("rec.status");
  OM_CHECK(ev["part"].asNumber(0) == 1 && ev["active"].asBool());
  OM_CHECK(ev["path"].asString().find(" (2)") == std::string::npos);  // no second file
  // A write error (disk full): finalized and reported.
  t.fb.rec->failNow = true;
  t.e->pump();
  ev = t.find("rec.status", [](const json::Value& v) { return v.has("error"); });
  OM_CHECK(!ev["active"].asBool() && ev["error"].asString() == "fake: disk full");
  // rec.list: unsaved recordings (headers repaired).
  t.cmd(R"({"cmd":"rec.list","id":6})");
  t.e->pump();
  OM_CHECK(t.reply(6)["files"].size() == 1 && t.reply(6)["files"].at(0)["repaired"].asBool());
  // shutdown finalizes a running recording.
  t.cmd(R"({"cmd":"rec.start","id":7,"name":"last"})");
  t.e->pump();
  const int stops = t.fb.rec->stops;
  t.cmd(R"({"cmd":"shutdown"})");
  t.e->pump();
  OM_CHECK(t.fb.rec->stops == stops + 1 && !t.fb.rec->active.load());
  OM_CHECK(t.log.has("\"ev\":\"shutdown\""));
  t.cmd(R"({"cmd":"rec.stop","id":8})");
  t.e->pump();
  OM_CHECK(!t.reply(8).isNull());
}

OM_TEST(core_hello_reset_finalizes_the_recording_and_clears_the_loop_bounds) {
  // A renderer reload (hello {reset}) while a recording runs and a deck kept
  // loop bounds: the recording is finalized on the ops thread (rec.status),
  // and the bounds go back to 0 / 0 like a new engine.js page (app.js's
  // RELOOP reads them when not looping). SPEC.md §2 item 6, §15.3.
  TestEngine t(true, [](EngineOptions& o) { o.dataDir = "D:\\Users\\Dj\\AppData\\Turbo Mix"; });
  OM_CHECK(t.handoff(1, 48000 * 4));
  t.cmd(R"([{"cmd":"deck.load","deck":0,"loadId":1,"grid":{"bpm":120,"beatOffset":0}},{"cmd":"deck.loop","deck":0,"start":1,"end":2}])");
  t.e->pump();
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  om_state st = t.state();
  OM_CHECK(st.decks[0].looping == 1 && st.decks[0].loop_start == 1.0 && st.decks[0].loop_end == 2.0);
  t.cmd(R"({"cmd":"deck.loopExit","deck":0})");
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  st = t.state();
  OM_CHECK(st.decks[0].looping == 0 && st.decks[0].loop_start == 1.0 && st.decks[0].loop_end == 2.0);  // engine.js keeps them
  t.cmd(R"({"cmd":"rec.start","id":2,"name":"before reload"})");
  t.e->pump();
  OM_CHECK(t.reply(2)["ok"].asBool() && t.fb.rec->active.load());
  const int stops = t.fb.rec->stops;
  t.cmd(R"({"cmd":"hello","id":3,"reset":true})");
  OM_CHECK(t.reply(3)["ok"].asBool());
  t.e->pump();  // the ops job
  OM_CHECK(t.fb.rec->stops == stops + 1 && !t.fb.rec->active.load());
  OM_CHECK(!t.find("rec.status").isNull() && !t.find("rec.status")["active"].asBool());
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  st = t.state();
  OM_CHECK(st.decks[0].loaded == 0 && st.decks[0].looping == 0);
  OM_CHECK(st.decks[0].loop_start == 0.0 && st.decks[0].loop_end == 0.0);
  // nothing running: a second reset finalizes nothing
  t.cmd(R"({"cmd":"hello","id":4,"reset":true})");
  t.e->pump();
  OM_CHECK(t.fb.rec->stops == stops + 1);
}

// hello {reset} drops the "when" commands of the previous page still
// scheduled: never applied on the new page, no "applied" with an old seq,
// and the objects they carry (a "when" deck.load's track and grid) are
// released (review round of 7 Nov 2026, RT-safety #4).
OM_TEST(core_hello_reset_drops_scheduled_when_commands) {
  TestEngine t(true);
  OM_CHECK(t.handoff(1, 48000 * 4));
  OM_CHECK(t.handoff(2, 48000 * 4));
  t.cmd(R"({"cmd":"deck.load","deck":0,"loadId":1,"grid":{"bpm":120,"beatOffset":0}})");
  t.e->pump();
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  // scheduled 0.5 s ahead (block presentTime starts at ~17 ms)
  t.cmd(R"({"cmd":"deck.loop","deck":0,"seq":50,"start":1,"end":2,"when":0.5})");
  t.cmd(R"({"cmd":"deck.load","deck":1,"seq":51,"loadId":2,"grid":{"bpm":124,"beatOffset":0},"when":0.5})");
  OM_CHECK(t.e->render(nullptr, 256) == 256);  // both into the pending list
  OM_CHECK(t.state().decks[1].loaded == 0);
  t.cmd(R"({"cmd":"hello","id":3,"reset":true})");
  OM_CHECK(t.reply(3)["ok"].asBool());
  OM_CHECK(t.e->render(nullptr, 256) == 256);  // EngineReset: the pending list is dropped
  t.e->pump();
  for (int b = 0; b < 120; b++) OM_CHECK(t.e->render(nullptr, 256) == 256);  // well past "when"
  t.e->pump();
  const om_state st = t.state();
  OM_CHECK(t.countEvents("applied") == 0);
  OM_CHECK(st.decks[0].loaded == 0 && st.decks[0].looping == 0 && st.decks[0].loop_start == 0.0 && st.decks[0].loop_end == 0.0);
  OM_CHECK(st.decks[1].loaded == 0);
  OM_CHECK(st.pcm_bytes == 0);  // the dropped deck.load's track was released, not leaked
}

// Quit order (review round of 7 Nov 2026, process / IPC #2): a recording is
// finalized before the VST thread is joined, so a slow or hung plugin job
// can never keep it from being finalized before main kills the host; queued
// jobs are dropped (the second vst.load never runs).
OM_TEST(core_stop_finalizes_the_recording_before_joining_a_slow_vst_job) {
  TestEngine t(false, [](EngineOptions& o) { o.dataDir = "D:\\Users\\Dj\\AppData\\Turbo Mix"; });
  OM_CHECK(t.started);
  EnginePolicy pol;
  std::string err;
  OM_CHECK(parsePolicy(R"({"vstRoots":["D:\\Plugins"]})", pol, &err));
  t.e->setPolicy(pol);
  auto waitFor = [](const std::function<bool()>& pred, int ms) {
    const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (!pred() && std::chrono::steady_clock::now() < end) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    return pred();
  };
  t.cmd(R"({"cmd":"rec.start","id":1,"name":"set"})");
  OM_CHECK(waitFor([&] { return !t.reply(1).isNull(); }, 5000) && t.reply(1)["ok"].asBool());
  t.fb.vst->loadSleepMs = 1500;
  t.cmd(R"({"cmd":"vst.load","deck":0,"id":2,"path":"D:\\Plugins\\Slow.vst3","uid":""})");
  t.cmd(R"({"cmd":"vst.load","deck":1,"id":3,"path":"D:\\Plugins\\Slow.vst3","uid":""})");
  OM_CHECK(waitFor([&] { return t.fb.vst->loads.load() == 1; }, 5000));
  const auto t0 = std::chrono::steady_clock::now();
  t.e->stop();
  const double stopMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  const int64_t recStop = t.fb.rec->lastStopNs.load(), loadEnd = t.fb.vst->lastLoadEndNs.load();
  std::printf("  [info] stop() with a 1.5 s plugin load running: %.0f ms; recording finalized %.0f ms before the load "
              "returned; loads run %d of 2\n",
              stopMs, (loadEnd - recStop) / 1e6, t.fb.vst->loads.load());
  OM_CHECK(t.fb.rec->stops == 1 && !t.fb.rec->active.load());
  OM_CHECK(recStop > 0 && loadEnd > 0 && recStop < loadEnd);  // finalized while the plugin job still ran
  OM_CHECK(t.fb.vst->loads.load() == 1);                       // the queued second load was dropped
}

OM_TEST(core_vst_commands_policy_base64_events_latency_and_transport) {
  TestEngine t(true, [](EngineOptions& o) { o.ownerWindow = 0x1234ABCDu; });
  EnginePolicy pol;
  std::string err;
  OM_CHECK(parsePolicy(R"({"vstRoots":["C:\\Program Files\\Common Files\\VST3"],"vstFiles":["D:\\Plugins\\Fake.vst3"]})", pol, &err));
  t.e->setPolicy(pol);
  t.cmd(R"({"cmd":"vst.load","deck":0,"id":1,"path":"D:\\Other\\Evil.vst3","uid":""})");
  t.e->pump();
  OM_CHECK(!t.reply(1)["ok"].asBool() && t.reply(1)["code"].asString() == "notAllowed");
  OM_CHECK(t.fb.vst->starts == 0);  // the host never started for a refused path
  // Allowed: the VST host starts with the first plugin, latency 512.
  t.fb.vst->loadLatency = 512;
  t.cmd(R"({"cmd":"vst.load","deck":1,"id":2,"path":"D:\\Plugins\\Fake.vst3","uid":"ABCD","state":"AAECAw=="})");
  t.e->pump();
  json::Value r = t.reply(2);
  OM_CHECK(r["ok"].asBool() && r["name"].asString() == "Fake Plugin" && r["latency"].asNumber(0) == 512);
  OM_CHECK(r["stateRestored"].asBool());
  OM_CHECK(t.fb.vst->starts == 1 && t.fb.vst->rate == 48000 && t.fb.vst->ownerSet == 0x1234ABCDu);
  OM_CHECK(t.fb.vst->lastState == "AAECAw==");  // base64 text handed to the host as is
  // States travel as base64 text both ways (the Web engine's saved slots).
  t.cmd(R"({"cmd":"vst.getState","deck":1,"id":3})");
  t.e->pump();
  const std::string b64 = t.reply(3)["state"].asString();
  OM_CHECK(t.reply(3)["ok"].asBool() && b64 == t.fb.vst->blob);
  t.cmd(std::string(R"({"cmd":"vst.setState","deck":1,"id":4,"state":")") + b64 + "\"}");
  t.e->pump();
  OM_CHECK(t.reply(4)["ok"].asBool() && t.fb.vst->lastState == t.fb.vst->blob);
  t.cmd(R"({"cmd":"vst.setState","deck":1,"id":5,"state":"bad"})");
  t.e->pump();
  OM_CHECK(!t.reply(5)["ok"].asBool());
  t.cmd(R"({"cmd":"vst.setState","deck":1,"id":15,"state":42})");
  t.e->pump();
  OM_CHECK(!t.reply(15)["ok"].asBool() && t.reply(15)["code"].asString() == "invalid");
  // Editors are owned by the main window (HWND from main, never from the renderer).
  t.cmd(R"({"cmd":"vst.editor","deck":1,"id":6})");
  t.e->pump();
  OM_CHECK(t.reply(6)["ok"].asBool() && t.fb.vst->lastOwner == 0x1234ABCDu);
  // The plugin latency joins the deck's read-ahead; transport at the insert input.
  OM_CHECK(t.handoff(7, 48000 * 2));
  t.cmd(R"([{"cmd":"deck.load","deck":1,"loadId":7,"grid":{"bpm":120,"beatOffset":0}},{"cmd":"vst.mix","deck":1,"mix":0.5}])");
  OM_CHECK(t.e->render(nullptr, 1024) == 1024);
  om_state st = t.state();
  OM_CHECK(std::fabs(st.decks[1].proc_latency - 512.0 / 48000.0) < 1e-9);
  OM_CHECK(t.fb.vst->transports.load() >= 4 && t.fb.vst->mix[1].load() == 0.5f);
  // Plugin events -> JSON events (vst.late at most once per second).
  t.fb.vst->events[1] = kVstCrashed | kVstHung | kVstLate;
  t.e->render(nullptr, 256);
  t.fb.vst->events[1] = kVstLate;
  t.e->render(nullptr, 256);
  t.fb.vst->latency[1] = 1024;
  t.fb.vst->events[1] = kVstLatency;
  t.e->render(nullptr, 256);
  t.e->pump();
  OM_CHECK(t.countEvents("vst.crashed") == 1 && t.countEvents("vst.hung") == 1);
  OM_CHECK(t.countEvents("vst.late") == 1);
  OM_CHECK(t.find("vst.latency")["latency"].asNumber(0) == 1024);
  st = t.state();
  OM_CHECK(std::fabs(st.decks[1].proc_latency - 1024.0 / 48000.0) < 1e-9);
  // vst.status is inline (non-blocking).
  t.cmd(R"({"cmd":"vst.status","deck":1,"id":7})");
  OM_CHECK(t.reply(7)["latency"].asNumber(0) == 1024);
  // A renderer reload unloads every plugin.
  const int unloads = t.fb.vst->unloads;
  t.cmd(R"({"cmd":"hello","id":8,"reset":true})");
  t.e->pump();
  OM_CHECK(t.fb.vst->unloads == unloads + kNumDecks);
  // The device rate change reconfigures the plugins.
  standardDevices(t.fb.world);
  t.cmd(R"({"cmd":"device.open","id":9,"name":"DDJ-FLX6"})");
  t.e->pump();
  OM_CHECK(t.fb.vst->reconfigures == 1 && t.fb.vst->rate == 44100);
}

OM_TEST(core_lazy_fx_memory_end_to_end_without_allocating_in_the_callback) {
  TestEngine t;
  EngineStats s = t.e->stats();
  OM_CHECK(s.fxUnitsCreated == 4 && s.fxChainsCreated == 0 && s.colorChainsCreated == 0);  // startup: panel units only
  // A lazy chain: created once on the control side, attached by the audio thread.
  t.cmd(R"({"cmd":"fx.set","unit":"fx0","type":"delay","enabled":true,"level":0.7})");
  t.e->render(nullptr, 256);  // the command applies at once: silence until the chain arrives
  t.e->pump();
  OM_CHECK(t.e->stats().fxChainsCreated == 1);
  t.e->render(nullptr, 256);
  OM_CHECK(t.e->stats().chainsAttached == 1);
  t.cmd(R"([{"cmd":"fx.set","unit":"fx0","type":"delay"},{"cmd":"fx.set","unit":"fx0","type":"echo"},{"cmd":"fx.set","unit":"fx0","type":"delay"}])");
  t.e->pump();
  OM_CHECK(t.e->stats().fxChainsCreated == 1);  // never twice; echo is built with the unit
  // The master unit on its first fx.set (engine.js ensureMasterFx), a pad unit on the first fx.pad.
  t.cmd(R"({"cmd":"fx.set","unit":"master"})");
  t.cmd(R"({"cmd":"fx.pad","deck":2,"preset":{"type":"reverb","beats":1,"level":0.8}})");
  t.e->pump();
  s = t.e->stats();
  OM_CHECK(s.fxUnitsCreated == 6 && s.fxChainsCreated == 2);
  t.e->render(nullptr, 256);
  s = t.e->stats();
  OM_CHECK(s.fxUnitsAttached == 2 && s.chainsAttached == 2);
  t.cmd(R"({"cmd":"fx.pad","deck":2,"preset":null})");
  t.cmd(R"({"cmd":"fx.pad","deck":2,"preset":{"type":"reverb","beats":1,"level":0.8}})");
  t.e->pump();
  OM_CHECK(t.e->stats().fxUnitsCreated == 6);
  // Color FX chains.
  t.cmd(R"([{"cmd":"color.type","type":"dubecho"},{"cmd":"color.type","type":"filter"},{"cmd":"color.type","type":"dubecho"}])");
  t.e->pump();
  t.e->render(nullptr, 256);
  s = t.e->stats();
  OM_CHECK(s.colorChainsCreated == 1 && s.chainsAttached == 3);
  // Every type on every panel unit, block after block: chains appear lazily,
  // the callback never allocates or frees (checked by the test runner).
  for (int round = 0; round < 2; round++) {
    for (int ty = 0; ty < kNumFxTypes; ty++) {
      for (int u = 0; u < kNumFxUnits; u++) {
        t.cmd(std::string(R"({"cmd":"fx.set","unit":"fx)") + std::to_string(u) + R"(","type":")" +
              fxTypeName(static_cast<FxType>(ty)) + R"(","enabled":true,"level":0.6})");
      }
      t.e->render(nullptr, 256);
      t.e->pump();
    }
  }
  t.e->render(nullptr, 512);
  s = t.e->stats();
  int lazyTypes = 0;
  for (int ty = 0; ty < kNumFxTypes; ty++)
    if (FxUnit::isLazy(static_cast<FxType>(ty))) lazyTypes++;
  // 4 panel units x 9 lazy types, + the pad reverb; fx0's delay already existed.
  OM_CHECK(s.fxChainsCreated == static_cast<uint64_t>(kNumFxUnits * lazyTypes + 1));
  OM_CHECK(s.chainsAttached == s.fxChainsCreated + s.colorChainsCreated && s.chainsDropped == 0);
  OM_CHECK(t.state().health.rt_allocs == 0 && t.state().health.rt_frees == 0);
}

namespace {
struct LatchHook {
  int blocks = 0;
  uint32_t ended = 0;
  static void hook(void* user, om_state& s) {
    auto* h = static_cast<LatchHook*>(user);
    if (++h->blocks == 6) h->ended = 1;  // deck 1 ends naturally during the overflow
    s.decks[1].ended_count = h->ended;
    if (h->ended) s.decks[1].ended_at = 12.5;
  }
};
}  // namespace

OM_TEST(core_event_queue_overflow_never_loses_the_end_latch) {
  LatchHook latch;
  TestEngine t(true, [&](EngineOptions& o) {
    o.snapshotHook = &LatchHook::hook;
    o.snapshotHookUser = &latch;
  });
  // 12000 sync.do commands, each answered by an event: the audio thread
  // pushes 512 per block while the control side does not drain (no pump);
  // the event queue holds 8191 (SpscQueue(4096) rounds up to 8192 slots).
  std::string batch = "[";
  for (int i = 0; i < 500; i++) batch += std::string(i ? "," : "") + R"({"cmd":"sync.do","deck":0})";
  batch += "]";
  int sent = 0, guard = 0;
  while (sent < 12000 && guard++ < 1000) {
    if (t.cmd(batch) == CommandResult::Ok) sent += 500;
    else t.e->render(nullptr, 256);
  }
  for (int b = 0; b < 40; b++) t.e->render(nullptr, 256);
  om_state st = t.state();
  OM_CHECK(st.health.events_lost > 0);  // counted, never blocking
  OM_CHECK(st.decks[1].ended_count == 1);
  t.e->pump();
  OM_CHECK(t.countEvents("deck.ended") == 1);
  const json::Value ended = t.find("deck.ended");
  OM_CHECK(ended["deck"].asNumber(-1) == 1 && ended["t"].asNumber(0) == 12.5);
  OM_CHECK(t.countEvents("sync.result") == static_cast<int>(12000 - st.health.events_lost));  // the rest counted as lost
  OM_CHECK(t.find("diag", [](const json::Value& v) { return v["what"].asString() == "events"; })["count"].asNumber(0) ==
           static_cast<double>(st.health.events_lost));
  OM_CHECK(t.find("diag", [](const json::Value& v) { return v["kind"].asString() == "queue-full"; })["count"].asNumber(0) > 0);
  // The latch is sticky: no second deck.ended.
  for (int b = 0; b < 4; b++) t.e->render(nullptr, 256);
  t.e->pump();
  OM_CHECK(t.countEvents("deck.ended") == 1);
}

OM_TEST(core_retired_backlog_is_retried_and_never_freed_on_the_audio_thread) {
  TestEngine t;
  OM_CHECK(t.handoff(1, 48000));
  t.cmd(R"({"cmd":"deck.load","deck":0,"loadId":1,"grid":{"bpm":120,"beatOffset":0}})");
  t.e->render(nullptr, 256);
  t.e->pump();
  // Each deck.grid retires the previous grid. 8191 fill the retired queue
  // (SpscQueue(4096) = 8191 usable slots), 100 more wait in the backlog (no
  // pump meanwhile).
  auto sendGrids = [&](int n) {
    int sent = 0, guard = 0;
    while (sent < n && guard++ < 10000) {
      const int k = std::min(400, n - sent);
      std::string b = "[";
      for (int i = 0; i < k; i++) b += std::string(i ? "," : "") + R"({"cmd":"deck.grid","deck":0,"bpm":121,"beatOffset":0.01})";
      b += "]";
      if (t.cmd(b) == CommandResult::Ok) sent += k;
      else t.e->render(nullptr, 256);
    }
    for (int i = 0; i < 24; i++) t.e->render(nullptr, 256);  // 512 commands per block
  };
  sendGrids(8191 + 100);
  om_state st = t.state();
  OM_CHECK(st.health.retired_backlog == 100 && st.health.retired_lost == 0);
  t.e->pump();  // frees what the queue held
  t.e->render(nullptr, 256);  // the backlog moves into the queue
  st = t.state();
  OM_CHECK(st.health.retired_backlog == 0);
  t.e->pump();
  OM_CHECK(t.find("diag", [](const json::Value& v) { return v["what"].asString() == "retiredBacklog"; })["count"].asNumber(0) == 100);
  // Beyond the backlog: leaked rather than freed on the audio thread, and reported.
  sendGrids(8191 + 256 + 50);
  st = t.state();
  OM_CHECK(st.health.retired_backlog == 256 && st.health.retired_lost == 50);
  t.e->pump();
  OM_CHECK(t.find("diag", [](const json::Value& v) { return v["what"].asString() == "retired"; })["count"].asNumber(0) == 50);
  for (int i = 0; i < 4; i++) {
    t.e->render(nullptr, 256);
    t.e->pump();
  }
  OM_CHECK(t.state().health.retired_backlog == 0);
}
