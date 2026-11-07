// Tests of the foundation headers and of the core (owner: host): lock-free
// queues, grid helpers, DSP primitives and the FP-environment guard, JSON,
// the protocol table (routes) and parser, the state event, the path policy,
// the flat C API in manual mode (PCM handoff in float32 -> deck.load ->
// offline render -> state), atomic batches, "when" confirmations, epochs,
// routing of slow commands, state-only-when-new + heartbeat, and the
// real-time trap (allocations and frees). SPEC.md §3, §15, §18.
// The acceptance tests of the core live next to this file:
// test_core_device.cpp (device lifecycle), test_core_threads.cpp (liveness,
// stalls, soak), test_core_commands.cpp (every command, rec / vst, lazy FX,
// overflow and end latch), test_core_roundtrip.cpp (engine host round trip),
// test_core_goldens.cpp (golden renders readable).
#include <cstring>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/dsp.h"
#include "om/engine.h"
#include "om/grid.h"
#include "om/json.h"
#include "om/om_engine.h"
#include "om/protocol.h"
#include "om/rt.h"
#include "om/spsc_queue.h"
#include "om/triple_buffer.h"

using namespace om;

// ---------------------------------------------------------------------------
// Foundation
// ---------------------------------------------------------------------------
OM_TEST(spsc_queue_order_capacity_and_free_slots) {
  SpscQueue<int> q(4);
  OM_CHECK(q.capacity() >= 4);
  OM_CHECK(q.freeApprox() == q.capacity());
  int v = 0;
  OM_CHECK(!q.pop(v));
  for (int i = 0; i < 4; i++) OM_CHECK(q.push(i));
  OM_CHECK(q.freeApprox() == q.capacity() - 4);
  for (int i = 0; i < 4; i++) {
    OM_CHECK(q.pop(v));
    OM_CHECK(v == i);
  }
  OM_CHECK(!q.pop(v));
  OM_CHECK(q.freeApprox() == q.capacity());
}

OM_TEST(triple_buffer_latest_value) {
  TripleBuffer<int> tb(0);
  int out = -1;
  OM_CHECK(!tb.read(out));
  tb.writeBuffer() = 1;
  tb.publish();
  tb.writeBuffer() = 2;
  tb.publish();
  OM_CHECK(tb.read(out));
  OM_CHECK(out == 2);
  OM_CHECK(!tb.read(out));
}

OM_TEST(grid_helpers_match_engine_js) {
  BeatGrid g;
  g.bpm = 120;
  g.beats = {0.0, 0.5, 1.0, 1.5, 2.0};
  OM_CHECK_NEAR(grid::indexFracAt(g, 0.75, 0), 1.5, 1e-12);
  OM_CHECK_NEAR(grid::timeAtIndex(g, 2.5, 0), 1.25, 1e-12);
  OM_CHECK_NEAR(grid::indexFracAt(g, -0.25, 0), -0.5, 1e-12);  // before the first beat: extrapolated
  OM_CHECK_NEAR(grid::indexFracAt(g, 0.75, 0.25), 1.0, 1e-12);  // global offset shifts every line
  BeatGrid f;
  f.bpm = 120;
  f.beatOffset = 0.1;
  // engine.js barAlignedSeekTime: same relative position (1/4) in the target bar (bar 5 of 2 s)
  OM_CHECK_NEAR(grid::barAlignedSeekTime(f, 0.6, 10.3, 0.0), 0.1 + 5.25 * 2.0, 1e-9);
}

OM_TEST(dsp_biquad_web_audio_formulas) {
  const double sr = 48000;
  // Web Audio lowpass: Q is a resonance in dB -> |H(fc)| = Q dB
  auto lp = dsp::webAudioBiquad(dsp::BiquadType::Lowpass, sr, 1000, 0.9, 0);
  OM_CHECK_NEAR(dsp::magnitudeDb(lp, 1000, sr), 0.9, 1e-6);
  // engine.js EQ: peaking 1 kHz Q 0.9, +6 dB at the center
  auto pk = dsp::webAudioBiquad(dsp::BiquadType::Peaking, sr, 1000, 0.9, 6.0);
  OM_CHECK_NEAR(dsp::magnitudeDb(pk, 1000, sr), 6.0, 1e-6);
  // engine.js EQ: lowshelf 200 Hz -40 dB (kill): deep cut far below
  auto ls = dsp::webAudioBiquad(dsp::BiquadType::Lowshelf, sr, 200, 0, -40.0);
  OM_CHECK(dsp::magnitudeDb(ls, 20, sr) < -38.0);
  OM_CHECK(std::fabs(dsp::magnitudeDb(ls, 15000, sr)) < 0.1);
}

OM_TEST(dsp_smoother_is_set_target_at_time) {
  dsp::Smoother s(0.0);
  s.setTarget(1.0, 0.01, 48000);
  for (int i = 0; i < 480; i++) s.next();  // one time constant
  OM_CHECK_NEAR(s.value(), 1.0 - std::exp(-1.0), 2e-3);
}

OM_TEST(dsp_pan_center_is_passthrough_and_crush_curve) {
  float l = 0, r = 0;
  dsp::stereoPan(0.25f, -0.5f, 0.0f, l, r);
  OM_CHECK_NEAR(l, 0.25, 1e-7);
  OM_CHECK_NEAR(r, -0.5, 1e-6);
  OM_CHECK_NEAR(dsp::crushShape(1.0f, 8), 1.0, 1e-6);
  OM_CHECK_NEAR(dsp::crushShape(-1.0f, 8), -1.0, 1e-6);
}

OM_TEST(dsp_fp_env_guard_restores_the_control_word) {
  const uint64_t before = dsp::fpControl();
  {
    dsp::FpEnvGuard g;
    dsp::flushDenormals();                        // what a plugin (or a real-time thread) may change
#if defined(OM_FPENV_X86)
    dsp::setFpControl(dsp::fpControl() | 0x6000);  // round toward zero, like a misbehaving plugin
    OM_CHECK(dsp::fpControl() != before);
#endif
  }
  OM_CHECK(dsp::fpControl() == before);
}

// ---------------------------------------------------------------------------
// JSON, protocol and policy
// ---------------------------------------------------------------------------
OM_TEST(json_round_trip_and_errors) {
  json::Value v;
  std::string err;
  OM_CHECK(json::parse(R"({"a":[1,2.5,-3e2],"b":"xé🎵","c":null,"d":true})", v, &err));
  OM_CHECK(v["a"].size() == 3);
  OM_CHECK_NEAR(v["a"].at(2).asNumber(0), -300, 0);
  OM_CHECK(v["b"].asString() == "x\xC3\xA9\xF0\x9F\x8E\xB5");
  OM_CHECK(v["c"].isNull());
  OM_CHECK(v["d"].asBool());
  OM_CHECK(json::stringify(v) == R"({"a":[1,2.5,-300],"b":"xé🎵","c":null,"d":true})");
  OM_CHECK(!json::parse("{\"a\":}", v, &err));
  OM_CHECK(!json::parse("[1,2", v, &err));
  OM_CHECK(!json::parse("{} x", v, &err));
  std::string n;
  json::appendNumber(n, 0.1);
  OM_CHECK(n == "0.1");
}

OM_TEST(protocol_table_is_consistent) {
  int count = 0;
  const CommandSpec* specs = commandSpecs(&count);
  OM_CHECK(count > 70);
  for (int i = 0; i < count; i++) {
    OM_CHECK(findCommandSpec(specs[i].name) == &specs[i]);
    OM_CHECK(std::strcmp(commandName(specs[i].cmd), specs[i].name) == 0);
    OM_CHECK((specs[i].route == Route::Audio) == isAudioCmd(specs[i].cmd));
  }
  // routes of SPEC.md §3.3: ordered control commands inline, blocking ones on ops / vst-ops
  OM_CHECK(findCommandSpec("deck.load")->route == Route::Inline);
  OM_CHECK(findCommandSpec("pcm.begin")->route == Route::Inline);
  OM_CHECK(findCommandSpec("device.open")->route == Route::Ops);
  OM_CHECK(findCommandSpec("rec.start")->route == Route::Ops);
  OM_CHECK(findCommandSpec("vst.load")->route == Route::Vst);
  OM_CHECK(findCommandSpec("vst.status")->route == Route::Inline);
  OM_CHECK(findCommandSpec("shadow.decode") == nullptr);  // moved to main (SPEC.md §7.4)
  OM_CHECK(std::string(routeName(Route::Vst)) == "vst");
}

OM_TEST(protocol_parses_and_clamps_like_engine_js) {
  std::vector<ParsedCommand> out;
  std::string err;
  OM_CHECK(parseCommands(R"([{"cmd":"deck.tempo","deck":1,"r":2.5,"seq":7,"at":12.5},
                            {"cmd":"deck.key","deck":0,"semi":9.4},
                            {"cmd":"fx.set","unit":"pad2","type":"flanger","level":3},
                            {"cmd":"sync.master","deck":null}])",
                         out, &err));
  OM_CHECK(out.size() == 4);
  OM_CHECK(out[0].rt.type == Cmd::DeckTempo && out[0].rt.deck == 1 && out[0].rt.seq == 7);
  OM_CHECK_NEAR(out[0].rt.u.tempo.r, kTempoMax, 0);
  OM_CHECK_NEAR(out[0].rt.at, 12.5, 0);
  OM_CHECK(out[1].rt.u.key.semi == kKeyMax);
  OM_CHECK(out[2].rt.u.fx.unit.kind == FxUnitId::Pad && out[2].rt.u.fx.unit.index == 2);
  OM_CHECK(out[2].rt.u.fx.mask == (kFxType | kFxLevel));
  OM_CHECK_NEAR(out[2].rt.u.fx.level, 1.0, 0);
  OM_CHECK(out[3].rt.u.master.idx == -1);
  out.clear();
  OM_CHECK(!parseCommands(R"({"cmd":"deck.play","deck":4})", out, &err));
  OM_CHECK(!parseCommands(R"({"cmd":"deck.eq","deck":0,"band":"sub","v":0})", out, &err));
  OM_CHECK(!parseCommands(R"({"cmd":"nope"})", out, &err));
  // a batch is valid only as a whole
  OM_CHECK(!parseCommands(R"([{"cmd":"deck.play","deck":0},{"cmd":"deck.play","deck":9}])", out, &err));
  OM_CHECK(out.empty());
}

OM_TEST(protocol_fx_assign_sends_when_and_recordings) {
  std::vector<ParsedCommand> out;
  std::string err;
  const char* m = R"([[true,false,false,false],[false,true,false,false],[false,false,true,true],[false,false,false,false]])";
  OM_CHECK(parseCommands(std::string(R"({"cmd":"fx.assign","assign":)") + m + "}", out, &err));
  OM_CHECK(out[0].rt.type == Cmd::FxAssign && out[0].rt.u.fxSends.bits == (0x1 | 0x20 | 0x400 | 0x800));
  out.clear();
  OM_CHECK(parseCommands(R"({"cmd":"fx.sends"})", out, &err));  // the latch alone
  OM_CHECK(out[0].rt.u.fxSends.hasAssign == 0 && queueCost(out[0]) == 1);
  out.clear();
  OM_CHECK(parseCommands(R"({"cmd":"deck.play","deck":1,"seq":4,"when":12.0})", out, &err));
  OM_CHECK((out[0].rt.flags & kRtWhen) != 0);  // excluded from ack, confirmed by "applied"
  out.clear();
  OM_CHECK(!parseCommands(R"({"cmd":"rec.start","path":"C:\\Windows\\x.wav"})", out, &err));  // names only
  OM_CHECK(parseCommands(R"({"cmd":"rec.start","name":"set 1","format":"wav24"})", out, &err));
  out.clear();
  OM_CHECK(parseCommands(R"([{"cmd":"deck.load","deck":0,"loadId":3,"grid":{}},{"cmd":"hello","reset":true},{"cmd":"device.list"}])", out, &err));
  OM_CHECK(queueCost(out[0]) == 4 && queueCost(out[1]) == 1 && queueCost(out[2]) == 0);
}

OM_TEST(state_event_is_valid_json) {
  om_state s{};
  s.struct_size = sizeof(s);
  s.epoch = 3;
  s.decks[0].loop_beats = kNaN;
  s.decks[0].ended_at = kNaN;
  s.decks[0].seg = 12;
  s.decks[0].anchor_t = 118.5;
  s.sync.master_idx = -1;
  s.sync.auto_master_idx = 2;
  s.health.batches_rejected = 1;
  json::Value v;
  std::string err;
  OM_CHECK(json::parse(stateJson(s), v, &err));
  OM_CHECK(v["ev"].asString() == "state");
  OM_CHECK_NEAR(v["epoch"].asNumber(0), 3, 0);
  OM_CHECK(v["decks"].size() == OM_NUM_DECKS);
  OM_CHECK(v["decks"].at(0)["loopBeats"].isNull());
  OM_CHECK_NEAR(v["decks"].at(0)["seg"].asNumber(0), 12, 0);
  OM_CHECK_NEAR(v["decks"].at(0)["anchorT"].asNumber(0), 118.5, 0);
  OM_CHECK(v["decks"].at(0)["insert"].isObject());
  OM_CHECK(v["sync"]["masterIdx"].isNull());
  OM_CHECK_NEAR(v["sync"]["autoMasterIdx"].asNumber(-1), 2, 0);
  OM_CHECK_NEAR(v["health"]["batchesRejected"].asNumber(0), 1, 0);
}

OM_TEST(policy_allows_only_scanned_plugins_or_vst_folders) {
  EnginePolicy p;
  std::string err;
  OM_CHECK(parsePolicy(R"({"vstRoots":["C:\\Program Files\\Common Files\\VST3"],"vstFiles":["D:/Plugins/Reverb.vst3"]})", p, &err));
  OM_CHECK(policyAllowsVst(p, "C:\\Program Files\\Common Files\\VST3\\Valhalla\\Room.vst3"));
  OM_CHECK(policyAllowsVst(p, "c:/program files/common files/vst3/x.vst3"));
  OM_CHECK(policyAllowsVst(p, "D:\\Plugins\\Reverb.vst3"));
  OM_CHECK(!policyAllowsVst(p, "D:\\Plugins\\Other.vst3"));
  OM_CHECK(!policyAllowsVst(p, "C:\\Program Files\\Common Files\\VST3\\..\\..\\evil.vst3"));
  OM_CHECK(!policyAllowsVst(p, "\\\\server\\share\\x.vst3"));
  OM_CHECK(!policyAllowsVst(p, "C:\\Program Files\\Common Files\\VST3\\x.dll"));
  OM_CHECK(!parsePolicy(R"({"vstRoots":3})", p, &err));
}

// ---------------------------------------------------------------------------
// C API in manual mode (NULL device, no thread: deterministic)
// ---------------------------------------------------------------------------
namespace {
struct Events {
  std::vector<std::string> all;
  static void sink(void* user, const char* json, size_t len) {
    static_cast<Events*>(user)->all.emplace_back(json, len);
  }
  int count(const char* needle) const {
    int n = 0;
    for (const auto& e : all)
      if (e.find(needle) != std::string::npos) n++;
    return n;
  }
  bool has(const char* needle) const { return count(needle) > 0; }
};

om_engine* manualEngine(Events& ev, const char* dataDir = nullptr) {
  om_config cfg;
  om_config_init(&cfg);
  cfg.null_device = 1;
  cfg.manual = 1;
  cfg.data_dir = dataDir;
  char err[256] = {0};
  om_engine* e = om_engine_create(&cfg, err, sizeof(err));
  if (!e) return nullptr;
  om_engine_set_event_callback(e, &Events::sink, &ev);
  if (om_engine_start(e, err, sizeof(err)) != OM_OK) {
    om_engine_destroy(e);
    return nullptr;
  }
  return e;
}

om_result cmd(om_engine* e, const std::string& json) { return om_engine_command(e, json.data(), json.size(), nullptr, 0); }

// One whole chunk of planar float32 (L block then R block), constant values.
std::vector<float> planarChunk(int frames, float l, float r) {
  std::vector<float> v(static_cast<size_t>(frames) * 2, l);
  for (int i = 0; i < frames; i++) v[static_cast<size_t>(frames + i)] = r;
  return v;
}
}  // namespace

OM_TEST(capi_lifecycle_hello_and_offline_render) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  OM_CHECK(cmd(e, R"({"cmd":"hello","id":1,"protocol":2})") == OM_OK);
  OM_CHECK(ev.has("\"ev\":\"reply\"") && ev.has("\"engine\"") && ev.has("\"epoch\":1"));
  OM_CHECK(cmd(e, R"({"cmd":"clock.ping","t0":5})") == OM_OK);
  OM_CHECK(ev.has("clock.pong"));
  std::vector<float> out(256 * 4, 1.0f);
  OM_CHECK(om_engine_render(e, out.data(), 256) == 256);
  OM_CHECK(om_engine_render(e, out.data(), 100) == 0);  // whole blocks only
  om_state st{};
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.block == 1 && st.epoch == 1);
  OM_CHECK(st.device.sample_rate == 48000 && st.device.channels == 4);
  OM_CHECK(om_engine_pump(e) == OM_OK);
  OM_CHECK(ev.has("\"ev\":\"state\"") && ev.has("\"ev\":\"hb\""));
  OM_CHECK(cmd(e, "{\"cmd\":") == OM_ERR_INVALID);
  om_engine_destroy(e);
}

OM_TEST(capi_state_only_when_new_and_heartbeat) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  OM_CHECK(om_engine_pump(e) == OM_OK);
  OM_CHECK(om_engine_pump(e) == OM_OK);  // no new block: no new state, but a heartbeat
  OM_CHECK(ev.count("\"ev\":\"state\"") == 1);
  OM_CHECK(ev.count("\"ev\":\"hb\"") == 2);
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  OM_CHECK(om_engine_pump(e) == OM_OK);
  OM_CHECK(ev.count("\"ev\":\"state\"") == 2);
  om_engine_destroy(e);
}

OM_TEST(capi_pcm_handoff_float32_then_deck_load) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  const int64_t frames = 70000;  // two chunks: 65536 + 4464
  OM_CHECK(cmd(e, R"({"cmd":"pcm.begin","id":2,"loadId":7,"kind":"track","format":"s16","sourceChannels":2,"sampleRate":48000,"frames":70000,"headroom":1,"peak":0.5})") == OM_OK);
  OM_CHECK(ev.has("\"ok\":true"));
  OM_CHECK(cmd(e, R"({"cmd":"deck.load","deck":0,"seq":3,"loadId":7,"grid":{"bpm":120,"beatOffset":0.0,"beats":null,"gridShift":0,"barAnchor":0}})") == OM_OK);
  const int first = OM_PCM_CHUNK_FRAMES;
  const int last = static_cast<int>(frames - OM_PCM_CHUNK_FRAMES);
  std::vector<float> a = planarChunk(first, 0.25f, -0.5f);
  OM_CHECK(om_pcm_write(e, 7, 0, first, 2, a.data()) == OM_OK);
  OM_CHECK(om_pcm_write(e, 7, 0, first, 2, a.data()) == OM_ERR_RANGE);           // duplicate chunk
  OM_CHECK(om_pcm_write(e, 7, OM_PCM_CHUNK_FRAMES, first, 2, a.data()) == OM_ERR_RANGE);  // wrong length
  OM_CHECK(om_pcm_end(e, 7) == OM_ERR_STATE);                                     // incomplete
  std::vector<float> mono(static_cast<size_t>(last), 0.125f);
  OM_CHECK(om_pcm_write(e, 7, OM_PCM_CHUNK_FRAMES, last, 1, mono.data()) == OM_OK);  // mono: duplicated by the engine
  OM_CHECK(om_pcm_end(e, 7) == OM_OK);
  OM_CHECK(ev.has("pcm.done"));
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  om_state st{};
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.ack == 3);
  OM_CHECK(st.decks[0].loaded == 1 && st.decks[0].load_id == 7);
  OM_CHECK_NEAR(st.decks[0].duration, frames / 48000.0, 1e-12);
  OM_CHECK_NEAR(st.decks[0].pcm_ready, 1.0, 0);
  OM_CHECK(st.pcm_bytes == static_cast<uint64_t>(frames) * 4);  // stored as int16 stereo
  // unloading releases the PCM once the audio thread has retired it
  OM_CHECK(cmd(e, R"({"cmd":"deck.unload","deck":0})") == OM_OK);
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);  // audio thread detaches and retires
  OM_CHECK(om_engine_pump(e) == OM_OK);                // control side releases and frees the PCM
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);  // next snapshot
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.decks[0].loaded == 0);
  OM_CHECK(st.pcm_bytes == 0);
  om_engine_destroy(e);
}

OM_TEST(capi_when_is_sample_exact_and_confirmed_by_applied) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  OM_CHECK(cmd(e, R"({"cmd":"pcm.begin","loadId":1,"kind":"track","format":"s16","sampleRate":48000,"frames":1000,"headroom":1})") == OM_OK);
  OM_CHECK(cmd(e, R"({"cmd":"deck.load","deck":2,"seq":5,"loadId":1,"grid":{}})") == OM_OK);
  // presentTime of block k = (k * 256 + 256 latency + 288 limiter look-ahead) / 48000
  const double when = (3 * 256 + 100 + 256 + 288) / 48000.0;
  char num[64];
  std::snprintf(num, sizeof(num), "%.17g", when);
  const std::string play = std::string(R"({"cmd":"deck.play","deck":2,"seq":9,"when":)") + num + "}";
  OM_CHECK(cmd(e, play) == OM_OK);
  OM_CHECK(cmd(e, R"({"cmd":"deck.volume","deck":2,"v":0.5,"seq":10})") == OM_OK);
  om_state st{};
  for (int b = 0; b < 3; b++) {
    OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
    OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
    OM_CHECK(st.decks[2].playing == 0);  // not yet
  }
  OM_CHECK(st.ack == 10);  // arrival-order commands acknowledged; the "when" one is not part of ack
  OM_CHECK(om_engine_pump(e) == OM_OK);
  OM_CHECK(!ev.has("\"ev\":\"applied\""));
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.decks[2].playing == 1);  // applied inside block 3 (frame 100)
  OM_CHECK(om_engine_pump(e) == OM_OK);
  OM_CHECK(ev.has("\"ev\":\"applied\"") && ev.has("\"seq\":9") && ev.has("\"late\":false"));
  om_engine_destroy(e);
}

OM_TEST(capi_batches_are_atomic_when_the_queue_is_full) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  auto batch = [](int n, const char* first) {
    std::string s = "[";
    s += first;
    for (int i = 0; i < n; i++) s += R"(,{"cmd":"deck.volume","deck":0,"v":0.5})";
    return s + "]";
  };
  // Fill the command queue without rendering, until a whole batch is refused.
  om_result r = OM_OK;
  int accepted = 0;
  for (int i = 0; i < 40 && r == OM_OK; i++) {
    r = cmd(e, batch(999, R"({"cmd":"deck.cuePoint","deck":0,"t":1})"));
    if (r == OM_OK) accepted++;
  }
  OM_CHECK(r == OM_ERR_FULL && accepted >= 4);
  // The refused batch starts with a different cue point: none of it may apply.
  OM_CHECK(cmd(e, batch(999, R"({"cmd":"deck.cuePoint","deck":0,"t":7})")) == OM_ERR_FULL);
  for (int b = 0; b < 64; b++) OM_CHECK(om_engine_render(e, nullptr, 256) == 256);  // drains 512 per callback
  om_state st{};
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK_NEAR(st.decks[0].cue_point, 1.0, 0);
  OM_CHECK(st.health.batches_rejected >= 2);
  OM_CHECK(cmd(e, R"({"cmd":"deck.cuePoint","deck":0,"t":7})") == OM_OK);  // room again
  om_engine_destroy(e);
}

OM_TEST(capi_hello_reset_starts_a_new_epoch) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  OM_CHECK(cmd(e, R"({"cmd":"pcm.begin","loadId":1,"kind":"track","format":"s16","sampleRate":48000,"frames":1000,"headroom":1})") == OM_OK);
  OM_CHECK(cmd(e, R"({"cmd":"deck.load","deck":1,"seq":40,"loadId":1,"grid":{}})") == OM_OK);
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  om_state st{};
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.ack == 40 && st.epoch == 1 && st.decks[1].loaded == 1);
  // renderer reload: the same loadId is legal again at once, ack restarts at 0
  OM_CHECK(cmd(e, R"({"cmd":"hello","id":2,"reset":true})") == OM_OK);
  OM_CHECK(ev.has("\"epoch\":2"));
  OM_CHECK(cmd(e, R"({"cmd":"pcm.begin","id":3,"loadId":1,"kind":"track","format":"s16","sampleRate":48000,"frames":500,"headroom":1})") == OM_OK);
  OM_CHECK(ev.count("\"ok\":true") >= 2 && !ev.has("exists"));
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.epoch == 2 && st.ack == 0 && st.decks[1].loaded == 0);
  OM_CHECK(om_engine_pump(e) == OM_OK);  // the old stream is released and freed
  OM_CHECK(om_engine_render(e, nullptr, 256) == 256);
  OM_CHECK(om_engine_read_state(e, &st) == OM_OK);
  OM_CHECK(st.pcm_bytes == 500 * 4);  // only the new epoch's stream remains
  om_engine_destroy(e);
}

OM_TEST(capi_slow_commands_run_on_the_ops_queues) {
  Events ev;
  om_engine* e = manualEngine(ev);
  OM_CHECK(e != nullptr);
  const std::string policy = R"({"vstRoots":["C:\\VST3"]})";
  OM_CHECK(om_engine_set_policy(e, policy.data(), policy.size(), nullptr, 0) == OM_OK);
  OM_CHECK(cmd(e, R"([{"cmd":"device.list","id":11},{"cmd":"vst.load","deck":0,"id":12,"path":"D:\\x.vst3","uid":""},{"cmd":"rec.list","id":13}])") == OM_OK);
  OM_CHECK(!ev.has("\"id\":11") && !ev.has("\"id\":12") && !ev.has("\"id\":13"));  // queued, not run inline
  OM_CHECK(om_engine_pump(e) == OM_OK);  // manual mode: pump runs the ops and vst-ops jobs
  OM_CHECK(ev.has("\"id\":11") && ev.has("\"id\":13"));
  OM_CHECK(ev.has("\"id\":12") && ev.has("notAllowed"));  // outside the policy
  OM_CHECK(cmd(e, R"({"cmd":"vst.status","deck":0,"id":14})") == OM_OK);
  OM_CHECK(ev.has("\"id\":14"));  // inline: answered at once
  om_engine_destroy(e);
}

OM_TEST(rt_trap_counts_allocations_and_frees_in_scope) {
  OM_CHECK(rt::trapInstalled());
  rt::resetViolations();
  {
    rt::Scope s;
    int* p = new int(3);  // deliberate violations
    delete p;
  }
  OM_CHECK(rt::allocViolations() == 1 && rt::freeViolations() == 1);
  rt::resetViolations();
  int* q = new int(4);
  {
    rt::Scope s;
    delete q;  // a free alone is a violation too (the heap lock, VirtualFree of big buffers)
    {
      rt::PluginScope plugin;  // plugin code: counted apart, not a violation
      delete new int(5);
    }
  }
  OM_CHECK(rt::allocViolations() == 0 && rt::freeViolations() == 1);
  OM_CHECK(rt::pluginAllocations() >= 1);
  rt::resetViolations();  // the runner fails any test that leaves violations behind
}
