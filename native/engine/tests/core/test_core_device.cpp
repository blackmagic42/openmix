// Core tests of the device lifecycle (owner: host), in manual mode on fake
// devices: device.list, device.open with roles / followDefault / name +
// nameIndex / modes / periodFrames, the exclusive -> shared fallback reply,
// a rate change that re-prepares the modules (and re-creates the FX chains
// still travelling), output routing (master 1/2, cue 3/4 or the headphones
// card), period steps, loss -> NULL pacer at the same rate -> restore of the
// CONFIGURED endpoint (by event and by the periodic re-check), default
// following, device.close. SPEC.md §8, §15.3.
#include <string>
#include <vector>

#include "../om_test.h"
#include "core_util.h"

using namespace om;
using namespace omtest;

namespace {
void addStandardDevices(FakeWorld& w) {
  w.devices = {FakeWorld::info("{A}", "Speakers (Realtek)", 0, 2, 48000, true, false),
               FakeWorld::info("{B}", "DDJ-FLX6", 0, 4, 44100),
               FakeWorld::info("{C}", "DDJ-FLX6", 1, 4, 44100),
               FakeWorld::info("{D}", "Headset", 0, 2, 48000, false, true)};
}
DeviceEventInfo event(DeviceEvent e, const char* id = "", DeviceRole role = DeviceRole::Console, uint32_t state = 1) {
  DeviceEventInfo ev;
  ev.event = e;
  ev.id = id;
  ev.role = role;
  ev.state = state;
  return ev;
}
}  // namespace

OM_TEST(core_device_open_roles_names_fallback_rate_change_and_routing) {
  TestEngine t;
  FakeWorld& w = t.fb.world;
  addStandardDevices(w);
  OM_CHECK(t.started);
  // device.list on the ops queue
  OM_CHECK(t.cmd(R"({"cmd":"device.list","id":1})") == CommandResult::Ok);
  OM_CHECK(t.reply(1).isNull());  // queued, not answered inline
  t.e->pump();
  json::Value r = t.reply(1);
  OM_CHECK(r["ok"].asBool() && r["devices"].size() == 4);
  OM_CHECK(r["devices"].at(2)["name"].asString() == "DDJ-FLX6" && r["devices"].at(2)["nameIndex"].asNumber(-1) == 1);
  OM_CHECK(r["devices"].at(0)["isDefault"].asBool() && r["devices"].at(3)["isDefaultComms"].asBool());
  OM_CHECK(r["devices"].at(1)["sharedFundamentalFrames"].asNumber(0) == 128);

  // No endpoint named: the console default, followed; low-latency shared mode.
  t.cmd(R"({"cmd":"device.open","id":2,"mode":"lowlatency"})");
  t.e->pump();
  r = t.reply(2);
  OM_CHECK(r["ok"].asBool());
  OM_CHECK(r["status"]["name"].asString() == "Speakers (Realtek)" && r["status"]["mode"].asString() == "lowlatency");
  OM_CHECK(!r.has("fallback"));
  DeviceConfig cfg = w.lastOpened();
  OM_CHECK(cfg.id == "{A}" && cfg.followDefault && cfg.mode == OutputMode::SharedLowLatency);
  OM_CHECK(cfg.periodFrames == 0 && cfg.minPeriodMs == 5.0);  // the >= 5 ms period policy is the backend's
  OM_CHECK(t.log.has("\"reason\":\"opened\""));
  FakeOutput* out = w.current();
  OM_CHECK(out != nullptr && out->pump(3) == 3);
  om_state st{};
  t.e->readState(st);
  OM_CHECK(st.device.mode == 3 && st.device.sample_rate == 48000 && st.device.channels == 2);
  OM_CHECK(st.device.period_frames == 240 && st.device.cue_routed == 0 && st.device.lost == 0);
  EngineStats s = t.e->stats();
  OM_CHECK(s.routing[0] == 0 && s.routing[1] == 1 && s.routing[2] == -1 && s.routing[3] == -1);
  OM_CHECK(t.e->render(nullptr, 256) == 0);  // the NULL device does not render any more

  // nameIndex picks the second FLX6; exclusive refused -> shared fallback;
  // 44.1 kHz -> every module re-prepared.
  w.refuseExclusive = true;
  const uint64_t prepares0 = s.prepares;
  t.cmd(R"({"cmd":"device.open","id":3,"name":"DDJ-FLX6","nameIndex":1,"mode":"exclusive","periodFrames":128,"raw":true})");
  t.e->pump();
  r = t.reply(3);
  OM_CHECK(r["ok"].asBool());
  OM_CHECK(r["fallback"]["reason"].asString() == "in-use" && r["fallback"]["requested"].asString() == "exclusive");
  OM_CHECK(r["status"]["fellBack"].asBool() && r["status"]["sampleRate"].asNumber(0) == 44100);
  OM_CHECK(t.log.has("\"reason\":\"fallback\""));
  cfg = w.lastOpened();
  OM_CHECK(cfg.id == "{C}" && cfg.name == "DDJ-FLX6" && cfg.nameIndex == 1 && !cfg.followDefault);
  OM_CHECK(cfg.mode == OutputMode::Exclusive && cfg.periodFrames == 128 && cfg.raw);
  OM_CHECK(t.e->stats().prepares == prepares0 + 1);
  {
    std::lock_guard<std::mutex> lk(w.m);
    OM_CHECK(w.outputs.size() == 1);  // the previous output was closed first
  }
  out = w.current();
  OM_CHECK(out->pump(4) == 4);
  t.e->readState(st);
  OM_CHECK(st.device.sample_rate == 44100 && st.device.channels == 4 && st.device.fell_back == 1);
  OM_CHECK(st.device.mode == 3 && st.device.period_frames == 128 && st.device.cue_routed == 1);
  s = t.e->stats();
  OM_CHECK(s.routing[0] == 0 && s.routing[1] == 1 && s.routing[2] == 2 && s.routing[3] == 3);  // cue on 3/4
  t.cmd(R"({"cmd":"hello","id":4})");
  OM_CHECK(t.reply(4)["sampleRate"].asNumber(0) == 44100 && t.reply(4)["channels"].asNumber(0) == 4);
  t.cmd(R"({"cmd":"device.status","id":5})");
  OM_CHECK(t.reply(5)["status"]["name"].asString() == "DDJ-FLX6");  // inline, from the ops thread's cache

  // An automatic period step of the backend is reported (event, and status polling).
  out->bumpPeriodSteps();
  out->fire(event(DeviceEvent::PeriodStep, "{C}"));
  t.e->pump();
  OM_CHECK(t.log.count("\"reason\":\"periodStep\"") == 1);
  out->pump(1);
  t.e->readState(st);
  OM_CHECK(st.device.period_steps == 1);

  // A failed open: the previous configuration is reopened.
  w.failOpens = 1;
  t.cmd(R"J({"cmd":"device.open","id":6,"name":"Speakers (Realtek)","mode":"shared"})J");
  t.e->pump();
  OM_CHECK(!t.reply(6)["ok"].asBool() && t.reply(6)["error"].asString() == "fake: busy");
  OM_CHECK(w.lastOpened().id == "{C}");
  OM_CHECK(w.current()->pump(1) == 1);
  t.e->readState(st);
  OM_CHECK(st.device.sample_rate == 44100 && st.device.channels == 4);
  // No exact, case-insensitive or prefix match: the role's default (device module's rule).
  t.cmd(R"({"cmd":"device.open","id":7,"deviceId":"{nope}","name":"Nothing like it","mode":"shared"})");
  t.e->pump();
  OM_CHECK(t.reply(7)["ok"].asBool() && w.lastOpened().id == "{A}");
  t.cmd(R"({"cmd":"device.open","id":9,"name":"ddj-flx6","nameIndex":1,"mode":"shared"})");
  t.e->pump();
  OM_CHECK(t.reply(9)["ok"].asBool() && w.lastOpened().id == "{B}");  // case-insensitive: the first one
  t.cmd(R"({"cmd":"device.open","id":10,"mode":"bogus"})");
  t.e->pump();
  OM_CHECK(!t.reply(10)["ok"].asBool());

  // device.close: back to the NULL device at the same rate.
  t.cmd(R"({"cmd":"device.close","id":8})");
  t.e->pump();
  OM_CHECK(t.reply(8)["ok"].asBool() && t.log.has("\"reason\":\"closed\""));
  OM_CHECK(t.e->render(nullptr, 256) == 256);
  t.e->readState(st);
  OM_CHECK(st.device.mode == 1 && st.device.sample_rate == 44100);  // the last device's rate
}

OM_TEST(core_device_rate_change_recreates_travelling_fx_chains) {
  TestEngine t;
  FakeWorld& w = t.fb.world;
  addStandardDevices(w);
  // A lazy chain is requested and made (control thread) but has not reached
  // the audio thread when the device changes rate.
  t.cmd(R"({"cmd":"fx.set","unit":"fx1","type":"delay"})");
  t.e->pump();
  const EngineStats s0 = t.e->stats();
  OM_CHECK(s0.fxChainsCreated == 1 && s0.chainsAttached == 0);
  t.cmd(R"({"cmd":"device.open","id":1,"name":"DDJ-FLX6","mode":"shared"})");
  t.e->pump();  // re-prepared at 44.1 kHz: the chain in flight is stale, a new one is requested
  OM_CHECK(t.reply(1)["ok"].asBool());
  t.e->pump();  // the control thread makes the new chain
  FakeOutput* out = t.fb.world.current();
  OM_CHECK(out->pump(2) == 2);
  const EngineStats s1 = t.e->stats();
  OM_CHECK(s1.fxChainsCreated == 2);
  OM_CHECK(s1.chainsDropped == 1);   // the 48 kHz chain was refused by the audio thread
  OM_CHECK(s1.chainsAttached == 1);  // the 44.1 kHz one taken
  t.e->pump();                       // the refused chain is freed by the control side
}

OM_TEST(core_device_loss_null_pacer_restore_and_default_following) {
  TestEngine t;
  FakeWorld& w = t.fb.world;
  addStandardDevices(w);
  t.cmd(R"({"cmd":"device.open","id":1,"name":"DDJ-FLX6","mode":"shared"})");
  t.e->pump();
  OM_CHECK(t.reply(1)["ok"].asBool() && w.lastOpened().id == "{B}");
  FakeOutput* out = w.current();
  OM_CHECK(out->pump(2) == 2);
  const double t0 = t.e->now();

  // The FLX6 is unplugged: silent NULL device at the same rate, the clock runs on.
  w.remove("{B}");
  out->fire(event(DeviceEvent::Lost, "{B}"));
  t.e->pump();
  OM_CHECK(t.log.has("\"reason\":\"lost\""));
  OM_CHECK(t.e->render(nullptr, 480 * 10) == 480 * 10);  // the NULL device keeps the lost device's period
  om_state st{};
  t.e->readState(st);
  OM_CHECK(st.device.lost == 1 && st.device.mode == 1 && st.device.sample_rate == 44100 && st.device.channels == 4);
  OM_CHECK(t.e->now() > t0 + 0.1);
  {
    std::lock_guard<std::mutex> lk(w.m);
    OM_CHECK(w.outputs.empty() && w.watchers == 1);  // the lost stream is released; the watcher reports the return
  }

  // Another endpoint appears: the master is NEVER moved to it.
  const size_t opens0 = w.openedCount();
  w.add(FakeWorld::info("{E}", "USB Audio", 0, 2, 48000));
  w.notify(event(DeviceEvent::Added, "{E}"));
  t.e->pump();
  OM_CHECK(w.openedCount() == opens0 && !t.log.has("\"reason\":\"restored\""));

  // The FLX6 comes back: the same configuration again.
  w.add(FakeWorld::info("{B}", "DDJ-FLX6", 0, 4, 44100));
  w.notify(event(DeviceEvent::Added, "{B}"));
  t.e->pump();
  OM_CHECK(t.log.count("\"reason\":\"restored\"") == 1 && w.lastOpened().id == "{B}");
  out = w.current();
  OM_CHECK(out->pump(1) == 1);
  t.e->readState(st);
  OM_CHECK(st.device.lost == 0 && st.device.mode == 2);

  // Lost again, back WITHOUT any notification: the periodic re-check (2 s) restores it.
  w.remove("{B}");
  out->fire(event(DeviceEvent::Lost, "{B}"));
  t.e->pump();
  OM_CHECK(t.log.count("\"reason\":\"lost\"") == 2);
  w.add(FakeWorld::info("{B}", "DDJ-FLX6", 0, 4, 44100));
  t.e->pump();
  OM_CHECK(t.log.count("\"reason\":\"restored\"") == 1);  // not yet: the re-check waits 2 s (sample clock)
  OM_CHECK(t.e->render(nullptr, 480 * 200) == 480 * 200);  // 2.18 s
  t.e->pump();
  OM_CHECK(t.log.count("\"reason\":\"restored\"") == 2);

  // DefaultChanged is ignored when the configuration names an endpoint.
  const size_t opens1 = w.openedCount();
  w.notify(event(DeviceEvent::DefaultChanged, "{D}", DeviceRole::Console));
  t.e->pump();
  OM_CHECK(w.openedCount() == opens1 && !t.log.has("\"reason\":\"defaultChanged\""));

  // Following the default (Chromium "default"): the new default endpoint is used.
  t.cmd(R"({"cmd":"device.open","id":2,"role":"console","followDefault":true,"mode":"shared"})");
  t.e->pump();
  OM_CHECK(w.lastOpened().id == "{A}");
  w.setDefault("{E}");
  w.notify(event(DeviceEvent::DefaultChanged, "{E}", DeviceRole::Communications));
  t.e->pump();
  OM_CHECK(!t.log.has("\"reason\":\"defaultChanged\""));  // another role
  w.current()->fire(event(DeviceEvent::DefaultChanged, "{E}", DeviceRole::Console));  // the stream's copy: ignored
  t.e->pump();
  OM_CHECK(!t.log.has("\"reason\":\"defaultChanged\""));
  w.notify(event(DeviceEvent::DefaultChanged, "{E}", DeviceRole::Console));
  t.e->pump();
  OM_CHECK(t.log.has("\"reason\":\"defaultChanged\"") && w.lastOpened().id == "{E}");

  // The communications role (Chromium "communications").
  t.cmd(R"({"cmd":"device.open","id":3,"role":"communications","mode":"shared"})");
  t.e->pump();
  OM_CHECK(t.reply(3)["ok"].asBool() && w.lastOpened().id == "{D}" && w.lastOpened().followDefault);

  // A format change reopens the same endpoint.
  const size_t opens2 = w.openedCount();
  w.notify(event(DeviceEvent::FormatChanged, "{A}"));  // another endpoint: nothing
  t.e->pump();
  OM_CHECK(w.openedCount() == opens2);
  w.notify(event(DeviceEvent::FormatChanged, "{D}"));
  t.e->pump();
  OM_CHECK(w.openedCount() == opens2 + 1 && t.log.has("\"reason\":\"formatChanged\""));
  OM_CHECK(w.current()->pump(1) == 1 && t.state().device.lost == 0);
  // An endpoint removed before its stream says so: lost at once.
  w.remove("{D}");
  w.notify(event(DeviceEvent::StateChanged, "{D}", DeviceRole::Console, kDeviceStateNotPresent));
  t.e->pump();
  OM_CHECK(t.e->render(nullptr, 480) == 480 && t.state().device.lost == 1);  // the NULL device renders now
}

OM_TEST(core_device_phones_card_routing_loss_and_restore) {
  TestEngine t;
  FakeWorld& w = t.fb.world;
  addStandardDevices(w);
  t.cmd(R"({"cmd":"device.open","id":1,"name":"DDJ-FLX6","mode":"shared"})");
  t.e->pump();
  FakeOutput* out = w.current();
  out->pump(1);
  EngineStats s = t.e->stats();
  OM_CHECK(s.routing[2] == 2 && s.routing[3] == 3);  // 4 channels, no phones card: cue on 3/4

  t.cmd(R"({"cmd":"device.phones","id":2,"name":"Headset"})");
  t.e->pump();
  json::Value r = t.reply(2);
  OM_CHECK(r["ok"].asBool() && r["status"]["phones"]["active"].asBool());
  {
    std::lock_guard<std::mutex> lk(t.fb.phones->m);
    OM_CHECK(t.fb.phones->cfg.id == "{D}" && t.fb.phones->cfg.mode == OutputMode::Shared);
    OM_CHECK(t.fb.phones->mainRate == 44100 && t.fb.phones->mainPeriod == 480);
  }
  out->pump(4);
  om_state st{};
  t.e->readState(st);
  OM_CHECK(st.device.phones_active == 1 && st.device.cue_routed == 1);
  s = t.e->stats();
  OM_CHECK(s.routing[0] == 0 && s.routing[1] == 1 && s.routing[2] == -1 && s.routing[3] == -1);  // cue off 3/4
  OM_CHECK(t.fb.phones->pushed.load() >= 480 * 3);
  // Every push is stamped with its sub-block's callbackTime (a whole frame
  // of the fake's sample clock, increasing), not with the time of the call.
  OM_CHECK(t.fb.phones->stampErrors.load() == 0 && t.fb.phones->lastStamp.load() > 0);

  // The headphones card is lost and comes back.
  DeviceEventFn h;
  {
    std::lock_guard<std::mutex> lk(t.fb.phones->m);
    h = t.fb.phones->handler;
  }
  OM_CHECK(static_cast<bool>(h));
  t.fb.phones->active = false;
  h(event(DeviceEvent::Lost, "{D}"));
  t.e->pump();
  OM_CHECK(t.log.has("\"target\":\"phones\"") && t.log.has("\"reason\":\"lost\""));
  out->pump(1);
  t.e->readState(st);
  OM_CHECK(st.device.phones_active == 0 && st.device.cue_routed == 0);
  h(event(DeviceEvent::Added, "{D}"));  // the stream's copy: the watcher is the source
  t.e->pump();
  OM_CHECK(t.log.last({"\"reason\":\"restored\"", "\"target\":\"phones\""}).empty());
  w.notify(event(DeviceEvent::Added, "{D}"));
  t.e->pump();
  OM_CHECK(t.log.last({"\"reason\":\"restored\"", "\"target\":\"phones\""}).size() > 0);
  out->pump(1);
  t.e->readState(st);
  OM_CHECK(st.device.phones_active == 1);

  // No headphones card any more: the cue goes back to 3/4.
  t.cmd(R"({"cmd":"device.phones","id":3,"name":null})");
  t.e->pump();
  OM_CHECK(t.reply(3)["ok"].asBool());
  out->pump(1);
  t.e->readState(st);
  s = t.e->stats();
  OM_CHECK(st.device.phones_active == 0 && s.routing[2] == 2 && s.routing[3] == 3);
}
