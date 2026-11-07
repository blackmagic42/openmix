// Tests of the device module (owner: device): NULL device clock and pump,
// endpoint resolution rules (names, nameIndex, roles), names, the system
// device factory, the recorder's default name, the passive endpoint
// enumeration (Chromium's order, labels, nameIndex, masks, periods), the
// NULL device's real-time pacer, and the real-time thread policy (MMCSS,
// power throttling read back). The other acceptance tests live next to
// this file: test_negotiate.cpp (fake IAudioClient), test_supervisor.cpp
// (loss / restore), test_recorder.cpp, test_phones.cpp, test_wasapi_real.cpp
// (opt-in real device), test_perf.cpp (CPU per block). SILENT: no test opens
// a real stream unless OM_TEST_REAL_DEVICE=1 (shared mode, gain 0, <= 5 s,
// never exclusive). SPEC.md §8, §14, §18.
#include <algorithm>
#include <atomic>
#include <bitset>
#include <chrono>
#include <cmath>
#include <map>
#include <thread>
#include <vector>

#include "../../src/device/endpoints.h"
#include "../om_test.h"
#include "om/device.h"
#include "om/recorder.h"
#include "om/rt.h"

using namespace om;

namespace {
struct ClockProbe final : IRenderCallback {
  std::vector<BlockClock> seen;
  void render(float* out, int frames, int channels, const BlockClock& clock) noexcept override {
    for (int i = 0; i < frames * channels; i++) out[i] = 0.5f;
    if (seen.size() < seen.capacity()) seen.push_back(clock);  // capacity reserved: no allocation
  }
};
}  // namespace

OM_TEST(null_device_pump_and_virtual_clock) {
  NullDeviceConfig nc;
  nc.sampleRate = 44100;
  nc.blockFrames = 128;
  nc.latencyFrames = 441;
  NullDevice dev(nc);
  ClockProbe probe;
  probe.seen.reserve(8);
  std::string err;
  OM_CHECK(dev.open(DeviceConfig(), &probe, &err));
  OM_CHECK(dev.start(&err));
  std::vector<float> sink(3 * 128 * nc.channels, 0.0f);
  {
    rt::Scope rts;  // the NULL device's pump path must not allocate
    OM_CHECK(dev.pump(3, sink.data()) == 3);
  }
  OM_CHECK(probe.seen.size() == 3);
  OM_CHECK(probe.seen[2].frame == 256);
  OM_CHECK_NEAR(probe.seen[1].callbackTime, 128.0 / 44100, 1e-12);
  OM_CHECK_NEAR(probe.seen[1].presentTime - probe.seen[1].callbackTime, 0.01, 1e-12);
  OM_CHECK(sink[0] == 0.5f);
  OM_CHECK(dev.framesRendered() == 384);
  const DeviceStatus st = dev.status();
  OM_CHECK(st.mode == DeviceMode::Null && st.sampleRate == 44100 && st.channels == 4);
}

OM_TEST(null_device_rejects_invalid_config) {
  NullDeviceConfig nc;
  nc.blockFrames = kMaxBlockFrames + 1;
  NullDevice dev(nc);
  ClockProbe probe;
  std::string err;
  OM_CHECK(!dev.open(DeviceConfig(), &probe, &err));
  OM_CHECK(!err.empty());
}

OM_TEST(output_device_resolution_rules) {
  std::vector<DeviceInfo> devs(5);
  devs[0].id = "{a}";
  devs[0].name = "Speakers (Realtek(R) Audio)";
  devs[0].isDefault = true;
  devs[1].id = "{b}";
  devs[1].name = "Master (DDJ-FLX6)";
  devs[2].id = "{c}";
  devs[2].name = "Headphones (DDJ-FLX6)";
  devs[3].id = "{d}";
  devs[3].name = "Speakers (USB Audio)";
  devs[3].isDefaultComms = true;
  devs[4].id = "{e}";
  devs[4].name = "Speakers (USB Audio)";  // same label: Chromium cannot tell them apart by name
  DeviceConfig cfg;
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{a}");  // default endpoint (console role)
  cfg.role = DeviceRole::Communications;
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{d}");  // Chromium "communications" pseudo-device
  cfg.role = DeviceRole::Console;
  cfg.name = "Master (DDJ-FLX6)";
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{b}");  // exact label (Chromium MediaDeviceInfo.label)
  cfg.name = "headphones (ddj-flx6)";
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{c}");  // case-insensitive
  cfg.name = "Master";
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{b}");  // prefix
  cfg.name = "Speakers (USB Audio)";
  cfg.nameIndex = 1;
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{e}");  // duplicates resolved by their order
  cfg.nameIndex = 5;
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{d}");  // index out of range: the first one
  cfg.id = "{c}";
  OM_CHECK(resolveOutputDevice(cfg, devs) == "{c}");  // id wins
}

OM_TEST(mode_and_format_names) {
  OutputMode m;
  OM_CHECK(outputModeFromName("lowlatency", m) && m == OutputMode::SharedLowLatency);
  OM_CHECK(!outputModeFromName("asio", m));
  RecFormat f;
  OM_CHECK(recFormatFromName("wav24", f) && f == RecFormat::S24);
  OM_CHECK(std::string(deviceModeName(DeviceMode::Exclusive)) == "exclusive");
  OM_CHECK(DeviceConfig().minPeriodMs == 5.0 && !DeviceConfig().followDefault);
}

OM_TEST(device_api_passive_check_and_factory) {
  std::string err;
  if (!deviceApiAvailable(&err)) {
    OM_CHECK(createSystemDevice() == nullptr);  // portable build: the core stays on the NULL device
    OM_SKIP("no device API in this build / machine: " + err);
  }
  OM_CHECK(createSystemDevice() != nullptr);  // created, never opened here
}

OM_TEST(recorder_default_name) {
  const std::string n = Recorder::defaultName();
  OM_CHECK(n.rfind("OpenMix ", 0) == 0 && n.size() == std::string("OpenMix 2026-10-20 21h05").size());
}

// ---------------------------------------------------------------------------
// Acceptance tests (owner: device)
// ---------------------------------------------------------------------------
OM_TEST(device_enumeration_passive_in_chromium_order) {
  // The ordering rules (portable): active endpoints first, in enumeration
  // order (= Chromium's), nameIndex = rank among the same label.
  std::vector<DeviceInfo> l(5);
  const char* ids[] = {"{a}", "{b}", "{c}", "{d}", "{e}"};
  const char* names[] = {"Speakers (USB)", "Speakers (USB)", "Master (DDJ-FLX6)", "Speakers (USB)", "Speakers (USB)"};
  const bool act[] = {false, true, true, true, false};
  for (size_t i = 0; i < 5; i++) {
    l[i].id = ids[i];
    l[i].name = names[i];
    l[i].active = act[i];
    l[i].isDefault = i == 0;  // an inactive endpoint is never the default
  }
  dev::finalizeEndpointList(l);
  OM_CHECK(l[0].id == "{b}" && l[1].id == "{c}" && l[2].id == "{d}" && l[3].id == "{a}" && l[4].id == "{e}");
  OM_CHECK(l[0].nameIndex == 0 && l[1].nameIndex == 0 && l[2].nameIndex == 1 && l[3].nameIndex == 0 && l[4].nameIndex == 1);
  OM_CHECK(!l[3].isDefault);
  DeviceConfig cfg;
  cfg.name = "Speakers (USB)";
  cfg.nameIndex = 1;
  OM_CHECK(resolveOutputDevice(cfg, l) == "{d}");
  cfg.id = "{a}";  // inactive: never chosen, the name decides
  OM_CHECK(resolveOutputDevice(cfg, l) == "{d}");
  // Chromium's labels: the friendly name, plus " (vid:pid)" for USB controllers.
  OM_CHECK(dev::usbModelIdFromInstanceId(R"(USB\VID_0020&PID_0B21&MI_00\7&2F0EC3B&0&0000)") == "0020:0b21");
  OM_CHECK(dev::usbModelIdFromInstanceId(R"(usb\vid_2B73&pid_000A\5&1)") == "2b73:000a");
  OM_CHECK(dev::usbModelIdFromInstanceId(R"(HDAUDIO\FUNC_01&VEN_10EC&DEV_0897&SUBSYS_1458A0C3)").empty());
  OM_CHECK(dev::usbModelIdFromInstanceId(R"(BTHENUM\{0000110B-0000-1000-8000-00805F9B34FB}_VID&0002000F_PID&1200)").empty());
  OM_CHECK(dev::usbModelIdFromInstanceId(R"(USB\VID_12&PID_0B21)").empty());
  OM_CHECK(dev::chromiumLabel("Casque (USB Audio)", "0020:0b21") == "Casque (USB Audio) (0020:0b21)");
  OM_CHECK(dev::chromiumLabel("Realtek Digital Output (Realtek(R) Audio)", "") == "Realtek Digital Output (Realtek(R) Audio)");
  std::vector<DeviceInfo> usb(2);
  usb[0].id = "{rt}";
  usb[0].name = "Speakers (Realtek(R) Audio)";
  usb[0].isDefault = true;
  usb[1].id = "{flx6}";
  usb[1].friendlyName = "Master (DDJ-FLX6)";
  usb[1].modelId = "2b73:000a";
  usb[1].name = dev::chromiumLabel(usb[1].friendlyName, usb[1].modelId);
  DeviceConfig byLabel;
  byLabel.name = "Master (DDJ-FLX6) (2b73:000a)";  // what the proxy stores from enumerateDevices()
  OM_CHECK(resolveOutputDevice(byLabel, usb) == "{flx6}");
  byLabel.name = "Master (DDJ-FLX6)";  // a bare friendly name still finds it (prefix rule)
  OM_CHECK(resolveOutputDevice(byLabel, usb) == "{flx6}");

  // The system's list: passive (endpoints are activated to read their
  // formats and periods, never initialized), so it is safe on the shared PC.
  std::string err;
  if (!deviceApiAvailable(&err)) OM_SKIP("no device API in this build / machine: " + err);
  const auto t0 = std::chrono::steady_clock::now();
  const std::vector<DeviceInfo> list = enumerateOutputDevices(&err);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  OM_CHECK(err.empty());
  int defaults = 0, comms = 0, actives = 0;
  bool inactiveSeen = false;
  std::map<std::string, int> seen;
  for (const DeviceInfo& d : list) {
    std::printf("[INFO] endpoint %s%s%s\"%s\" #%d: %d ch mask 0x%X, %d Hz, period %.2f ms (min %.2f), "
                "IAudioClient3 default %d fundamental %d min %d max %d\n",
                d.active ? "" : "(inactive) ", d.isDefault ? "[default] " : "", d.isDefaultComms ? "[comms] " : "",
                d.name.c_str(), d.nameIndex, d.channels, d.channelMask, d.sampleRate, d.defaultPeriodMs, d.minPeriodMs,
                d.sharedDefaultPeriodFrames, d.sharedFundamentalFrames, d.sharedMinPeriodFrames, d.sharedMaxPeriodFrames);
    OM_CHECK(!d.id.empty());
    OM_CHECK(d.name == dev::chromiumLabel(d.friendlyName, d.modelId));
    if (!d.modelId.empty()) std::printf("[INFO]   USB controller %s: Chromium label \"%s\"\n", d.modelId.c_str(), d.name.c_str());
    if (!d.active) {
      inactiveSeen = true;
      OM_CHECK(!d.isDefault && !d.isDefaultComms);
      continue;
    }
    OM_CHECK(!inactiveSeen);  // active endpoints first
    actives++;
    OM_CHECK(!d.name.empty());
    OM_CHECK(d.nameIndex == seen[d.name]++);
    OM_CHECK(d.channels >= 1 && d.channels <= 32 && d.sampleRate >= 8000);
    if (d.channelMask) OM_CHECK(static_cast<int>(std::bitset<32>(d.channelMask).count()) == d.channels);
    OM_CHECK(d.defaultPeriodMs > 0 && d.minPeriodMs > 0 && d.minPeriodMs <= d.defaultPeriodMs);
    if (d.sharedFundamentalFrames > 0) {
      OM_CHECK(d.sharedMinPeriodFrames >= d.sharedFundamentalFrames);
      OM_CHECK(d.sharedMinPeriodFrames <= d.sharedDefaultPeriodFrames && d.sharedDefaultPeriodFrames <= d.sharedMaxPeriodFrames);
    }
    defaults += d.isDefault ? 1 : 0;
    comms += d.isDefaultComms ? 1 : 0;
  }
  if (actives > 0) OM_CHECK(defaults == 1 && comms <= 1);
  std::printf("[INFO] enumeration: %d active endpoint(s), %zu in all, %.1f ms\n", actives, list.size(), ms);
}

namespace {
struct PacerProbe final : IRenderCallback {
  std::atomic<uint64_t> calls{0};
  std::atomic<bool> bad{false};
  double lastPresent = -1, lastCallback = -1;
  int64_t lastFrame = -1;
  void render(float* out, int frames, int channels, const BlockClock& clk) noexcept override {
    for (int i = 0; i < frames * channels; i++) out[i] = 0.0f;
    if (lastPresent >= 0) {
      // Scheduled clocks: exactly one block apart, presentTime = callbackTime + latency.
      if (std::fabs(clk.callbackTime - lastCallback - frames / clk.sampleRate) > 1e-9) bad = true;
      if (clk.presentTime <= lastPresent || clk.frame != lastFrame + frames) bad = true;
    }
    if (std::fabs(clk.presentTime - clk.callbackTime - 512.0 / 48000.0) > 1e-9) bad = true;
    lastPresent = clk.presentTime;
    lastCallback = clk.callbackTime;
    lastFrame = clk.frame;
    calls++;
  }
};
}  // namespace

OM_TEST(device_null_realtime_pacer_2s) {
  NullDeviceConfig nc;
  nc.sampleRate = 48000;
  nc.blockFrames = 256;
  nc.latencyFrames = 512;
  nc.realtime = true;
  NullDevice dev(nc);
  PacerProbe probe;
  std::string err;
  OM_CHECK(dev.open(DeviceConfig(), &probe, &err));
  OM_CHECK(dev.pump(1) == 0);  // real-time mode: no offline pump
  const EngineTime t0 = EngineClock::now();
  OM_CHECK(dev.start(&err));
  std::this_thread::sleep_for(std::chrono::milliseconds(2000));
  const DeviceStatus running = dev.status();
  dev.stop();
  const EngineTime t1 = EngineClock::now();
  const NullDevice::PacerStats ps = dev.pacerStats();
  const double expected = (t1 - t0) * 48000.0 / 256.0;
  const double rel = (static_cast<double>(ps.blocks) - expected) / expected;
  std::printf("[INFO] NULL pacer (%s): %llu blocks in %.3f s (expected %.1f, %+.3f %%), lateness p99 %.3f ms, max %.3f ms, "
              "late blocks %llu, resyncs %llu\n",
              ps.timer, static_cast<unsigned long long>(ps.blocks), t1 - t0, expected, rel * 100, ps.p99LateMs, ps.maxLateMs,
              static_cast<unsigned long long>(ps.lateBlocks), static_cast<unsigned long long>(ps.resyncs));
  OM_CHECK(std::fabs(rel) < 0.01);  // within +-1 % of real time
  OM_CHECK(ps.blocks == probe.calls.load() && !probe.bad.load());
  OM_CHECK(running.mode == DeviceMode::Null && running.running);  // silent: no sound card involved
  OM_CHECK(!dev.status().running);
  OM_CHECK(dev.framesRendered() == static_cast<int64_t>(ps.blocks) * 256);
}

OM_TEST(device_thread_policy) {
  std::string err;
  OM_CHECK(disableProcessPowerThrottling(&err));
  bool off = false;
  std::string qerr;
  const bool readable = queryProcessPowerThrottling(&off, &qerr);
  ThreadPolicyInfo info, after;
  void* handle = nullptr;
  std::string terr;
  std::thread t([&] {
    handle = promoteAudioThread("Pro Audio", &terr);
    queryAudioThreadPolicy(handle, info);
    demoteAudioThread(handle);
    queryAudioThreadPolicy(nullptr, after);
  });
  t.join();
  if (!info.supported) {
    OM_CHECK(handle == nullptr && !readable);  // portable stand-ins: no-ops
    OM_SKIP("no thread policy in this build (portable stand-ins)");
  }
  OM_CHECK(readable && off);  // read back with GetProcessInformation
  OM_CHECK(handle != nullptr && info.mmcss);  // MMCSS "Pro Audio" registered
  OM_CHECK(info.powerThrottlingKnown && info.powerThrottlingOff);
  std::printf("[INFO] audio thread: MMCSS Pro Audio, priority %d (after revert %d), system responsiveness %lu %%, "
              "power throttling off (thread %s, process %s)\n",
              info.priority, after.priority, info.systemResponsiveness, info.powerThrottlingOff ? "yes" : "no",
              off ? "yes" : "no");
}

// Without MMCSS (service disabled, unknown task) the audio thread still runs
// at TIME_CRITICAL (15), never at normal priority next to a game; the
// control thread and the recorder's writer run above normal (1). Review
// round of 7 Nov 2026, RT-safety #2 and #6. SPEC.md §3.1, §8.8.
OM_TEST(device_thread_policy_fallbacks_and_service_priority) {
  ThreadPolicyInfo noMmcss, service, plain;
  void* handle = reinterpret_cast<void*>(1);
  std::string terr;
  std::thread a([&] {
    handle = promoteAudioThread("OpenMix no such MMCSS task", &terr);  // AvSetMmThreadCharacteristics fails
    queryAudioThreadPolicy(handle, noMmcss);
    demoteAudioThread(handle);
  });
  a.join();
  std::thread b([&] {
    queryAudioThreadPolicy(nullptr, plain);
    raiseServiceThreadPriority();
    queryAudioThreadPolicy(nullptr, service);
  });
  b.join();
  if (!noMmcss.supported) {
    OM_CHECK(handle == nullptr);
    OM_SKIP("no thread policy in this build (portable stand-ins: no-ops)");
  }
  std::printf("[INFO] no MMCSS: priority %d (%s); service thread: %d -> %d\n", noMmcss.priority, terr.c_str(), plain.priority,
              service.priority);
  OM_CHECK(handle == nullptr && !noMmcss.mmcss && !terr.empty());
  OM_CHECK(noMmcss.priority == 15);  // THREAD_PRIORITY_TIME_CRITICAL
  OM_CHECK(noMmcss.powerThrottlingKnown && noMmcss.powerThrottlingOff);
  OM_CHECK(plain.priority == 0 && service.priority == 1);  // NORMAL -> ABOVE_NORMAL
}
