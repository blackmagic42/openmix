// Audio output devices of the native engine (owner: device), behind the
// AudioDevice interface so that miniaudio / CoreAudio / ASIO backends can
// replace or join the WASAPI one later:
//  - WASAPI event-driven output (own code, Windows SDK only, src/device/win/):
//    shared mode, low-latency shared mode through IAudioClient3 (smallest
//    period >= 5 ms, stepped up after glitches), exclusive mode as an opt-in
//    with format / channel negotiation and automatic fallback to shared;
//  - a NULL device rendering into memory (tests and offline renders: it
//    never touches a sound card), with a real-time pacer for soak tests and
//    as the silent stand-in while a device is lost;
//  - DeviceSupervisor: keeps the CONFIGURED output alive (loss -> NULL pacer
//    -> the same endpoint again when it comes back, the default followed
//    only when the user chose "Default"), the piece the core drives;
//  - SecondaryOutput: headphones on a second sound card, fed by the main
//    callback through a lock-free ring with a drift-correcting resampler;
//  - endpoint enumeration (roles, Chromium labels and their order), device
//    events (lost, added, state changed, default changed, format changed);
//  - real-time thread policy (MMCSS, power throttling off).
// SPEC.md §8. Portable parts live in src/device/, Windows code in
// src/device/win/ (om_device_wasapi), stand-ins in src/device/none/.
//
// TEST RULES: tests use the NULL device. A real-device smoke test is
// opt-in (OM_TEST_REAL_DEVICE=1), SHARED mode only, silent (gain 0), 5 s at
// most. NEVER open exclusive mode from a test (the owner games on this PC).
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "om/common.h"

namespace om {

// Windows default-device roles (eConsole / eCommunications). Chromium's
// pseudo-devices "default" and "communications" map to them (SPEC.md §8.1).
enum class DeviceRole : uint8_t { Console = 0, Communications = 1 };

struct DeviceInfo {
  std::string id;              // WASAPI endpoint id (UTF-8)
  // Chromium's MediaDeviceInfo.label: PKEY_Device_FriendlyName, plus " (vid:pid)"
  // for USB endpoints, as Chromium appends (e.g. "Casque (USB Audio) (0020:0b21)").
  std::string name;
  std::string friendlyName;    // PKEY_Device_FriendlyName alone
  std::string modelId;         // "vid:pid" of a USB controller ("" otherwise)
  int nameIndex = 0;           // rank among endpoints with the same name, in Chromium's order
  int channels = 0;            // shared-mode mix format
  uint32_t channelMask = 0;    // mix format channel mask (SPEAKER_* bits)
  int sampleRate = 0;
  bool active = true;          // DEVICE_STATE_ACTIVE (inactive endpoints are listed after the active ones)
  bool isDefault = false;      // default eConsole render endpoint
  bool isDefaultComms = false; // default eCommunications render endpoint
  double defaultPeriodMs = 0;  // IAudioClient::GetDevicePeriod
  double minPeriodMs = 0;      // exclusive-mode minimum
  // IAudioClient3::GetSharedModeEnginePeriod (all 0 when unsupported)
  int sharedMinPeriodFrames = 0;
  int sharedDefaultPeriodFrames = 0;
  int sharedFundamentalFrames = 0;
  int sharedMaxPeriodFrames = 0;
};

enum class OutputMode : uint8_t { Shared = 0, SharedLowLatency = 1, Exclusive = 2 };
const char* outputModeName(OutputMode m) noexcept;  // "shared", "lowlatency", "exclusive"
bool outputModeFromName(const char* n, OutputMode& out) noexcept;

// What is actually open (om_device_state.mode uses the same numbers).
enum class DeviceMode : uint8_t { Closed = 0, Null = 1, Shared = 2, SharedLowLatency = 3, Exclusive = 4 };
const char* deviceModeName(DeviceMode m) noexcept;  // "closed", "null", "shared", "lowlatency", "exclusive"

struct DeviceConfig {
  std::string id;              // exact endpoint id (wins over name)
  std::string name;            // friendly name: exact match (+ nameIndex), then case-insensitive, then prefix
  int nameIndex = 0;           // which of several endpoints with the same name
  DeviceRole role = DeviceRole::Console;  // whose default endpoint is used when no name / id matches
  // The user chose "Default" (Chromium "default" / "communications"): reopen
  // on DefaultChanged. Otherwise the configured endpoint is kept, and waited
  // for when it is lost (SPEC.md §8.4).
  bool followDefault = false;
  OutputMode mode = OutputMode::Shared;
  int periodFrames = 0;        // 0 = policy: shared default / low-latency >= minPeriodMs / exclusive smallest stable
  double minPeriodMs = 5.0;    // low-latency shared: smallest multiple of the fundamental period >= this
  int sampleRate = 0;          // exclusive only (0 = mix-format rate)
  bool raw = false;            // AUDCLNT_STREAMOPTIONS_RAW when supported (bypass Windows enhancements)
};

struct DeviceStatus {
  DeviceMode mode = DeviceMode::Closed;
  std::string id, name;
  int sampleRate = 0;
  int channels = 0;
  uint32_t channelMask = 0;
  int periodFrames = 0;        // engine period (shared) or device period (exclusive)
  int bufferFrames = 0;
  int periodSteps = 0;         // automatic step-ups after repeated glitches
  double outputLatencyMs = 0;  // what presentTime adds to callbackTime (buffer + stream latency)
  double presentJitterMs = 0;  // p99 jitter of presentTime over the last second
  std::string sampleFormat;    // "f32", "s32", "s24" (24 in 32), "s24p" (packed), "s16"
  bool running = false;
  bool lost = false;           // device invalidated / removed: waiting for it to come back
  bool fellBack = false;       // exclusive / low-latency refused: a shared mode is used instead
  std::string fallbackReason;  // "in-use", "not-allowed", "format", "periodicity-locked", "unsupported"
  bool raw = false;
  uint64_t glitches = 0;       // missed periods detected (IAudioClock gaps / late events / underruns)
  // ---- diagnostics (additions of the device module) ----
  double streamLatencyMs = 0;  // IAudioClient::GetStreamLatency (informative)
  double rawJitterMs = 0;      // p99 |raw IAudioClock mapping - filtered mapping| over the last second
  uint64_t callbacks = 0;      // device callbacks since the stream started
  double cpuUs = 0;            // device-layer CPU per callback (us), the render callback excluded
  int fundamentalFrames = 0;   // IAudioClient3 fundamental period (step size of the low-latency policy)
  int defaultPeriodFrames = 0; // the endpoint's default engine period (upper bound of the step-ups)
};

// Render callback, invoked on the device's real-time thread (MMCSS "Pro Audio").
class IRenderCallback {
 public:
  virtual ~IRenderCallback() = default;
  // Fill `frames` interleaved float frames of `channels` channels. RT-safe,
  // never throws. `clock` gives the frame index and the presentation time
  // from the device's frame -> QPC mapping (device latency only; the core
  // adds the master chain latency and the sample clock). Backends never ask
  // for more than kMaxBlockFrames frames in one call.
  virtual void render(float* out, int frames, int channels, const BlockClock& clock) noexcept = 0;
};

// Device notifications (IMMNotificationClient), SPEC.md §8.4.
enum class DeviceEvent : uint8_t {
  Lost = 0,        // the open endpoint was removed, disabled or invalidated
  DefaultChanged,  // the default endpoint of `role` changed (`id` = the new default, "" = none)
  FormatChanged,   // the endpoint's mix format changed
  Added,           // an endpoint appeared
  StateChanged,    // an endpoint changed state (`state`: DEVICE_STATE_* bits; 1 = active, 4 = not present)
  PeriodStep       // the device stepped its period up after repeated glitches (`periodFrames` = new period)
};
struct DeviceEventInfo {
  DeviceEvent event = DeviceEvent::Lost;
  std::string id;              // endpoint concerned
  uint32_t state = 0;          // StateChanged: new DEVICE_STATE_* value
  DeviceRole role = DeviceRole::Console;  // DefaultChanged
  int periodFrames = 0;        // PeriodStep
};
constexpr uint32_t kDeviceStateActive = 1;      // DEVICE_STATE_ACTIVE
constexpr uint32_t kDeviceStateDisabled = 2;    // DEVICE_STATE_DISABLED
constexpr uint32_t kDeviceStateNotPresent = 4;  // DEVICE_STATE_NOTPRESENT (also: endpoint removed)
constexpr uint32_t kDeviceStateUnplugged = 8;   // DEVICE_STATE_UNPLUGGED
// Called on a non-real-time thread (the device notification thread): post
// only, the core handles the event on its ops thread.
using DeviceEventFn = std::function<void(const DeviceEventInfo& ev)>;

class AudioDevice {
 public:
  virtual ~AudioDevice() = default;
  virtual bool open(const DeviceConfig& cfg, IRenderCallback* cb, std::string* err) = 0;
  virtual bool start(std::string* err) = 0;
  virtual void stop() = 0;
  virtual void close() = 0;
  virtual DeviceStatus status() const = 0;
  virtual void setEventHandler(DeviceEventFn fn) = 0;
};

// The system's output backend: WASAPI on Windows (om_device_wasapi); nullptr
// where no backend is built yet (the core then stays on the NULL device).
// NEVER open it in exclusive mode from tests.
std::unique_ptr<AudioDevice> createSystemDevice();

// Endpoint notifications for the whole process (IMMNotificationClient on
// Windows): Added, StateChanged (removal = kDeviceStateNotPresent),
// DefaultChanged (render, console / communications roles) and FormatChanged
// (PKEY_AudioEngine_DeviceFormat), delivered on the notification thread
// (post only). Unregistered when destroyed. nullptr where no backend exists.
class DeviceWatcher {
 public:
  virtual ~DeviceWatcher() = default;
};
std::unique_ptr<DeviceWatcher> createDeviceWatcher(DeviceEventFn fn, std::string* err);

// ---------------------------------------------------------------------------
// NULL device: renders into memory with a virtual clock.
//   realtime == false: no thread; call pump() (deterministic tests, offline).
//   realtime == true : a thread paces blocks at the real rate with a
//                      high-resolution waitable timer (soak tests, and the
//                      silent stand-in while a device is lost). callbackTime
//                      is then the block's scheduled engine time.
// ---------------------------------------------------------------------------
struct NullDeviceConfig {
  int sampleRate = 48000;
  int channels = 4;          // 4 so that cue routing on 3/4 is testable
  int blockFrames = 256;
  int latencyFrames = 256;   // presentTime = callbackTime + latencyFrames / sampleRate
  bool realtime = false;
};

class NullDevice final : public AudioDevice {
 public:
  explicit NullDevice(const NullDeviceConfig& cfg = NullDeviceConfig());
  ~NullDevice() override;
  bool open(const DeviceConfig& cfg, IRenderCallback* cb, std::string* err) override;
  bool start(std::string* err) override;
  void stop() override;
  void close() override;
  DeviceStatus status() const override;
  void setEventHandler(DeviceEventFn fn) override;

  // Offline pump: renders `blocks` blocks synchronously on the calling thread.
  // `sink` (optional) receives blocks * blockFrames * channels samples.
  // Returns the number of blocks rendered (0 when not open/started).
  int pump(int blocks, float* sink = nullptr);
  const NullDeviceConfig& config() const noexcept { return cfg_; }
  int64_t framesRendered() const noexcept { return frame_.load(); }
  // Virtual engine time of the next block (frames / rate).
  EngineTime virtualTime() const noexcept;

  // Real-time pacer statistics (realtime mode).
  struct PacerStats {
    uint64_t blocks = 0;       // blocks rendered by the pacer since start
    double p99LateMs = 0;      // p99 of (render start - scheduled time)
    double maxLateMs = 0;
    uint64_t lateBlocks = 0;   // started more than one block late
    uint64_t resyncs = 0;      // fell more than 0.5 s behind: schedule restarted
    const char* timer = "";    // "waitable-timer-hr", "waitable-timer", "sleep"
  };
  PacerStats pacerStats() const;

 private:
  NullDeviceConfig cfg_;
  IRenderCallback* cb_ = nullptr;
  std::atomic<int64_t> frame_{0};
  std::atomic<bool> started_{false};
  bool open_ = false;
  struct Pacer;
  std::unique_ptr<Pacer> pacer_;  // realtime mode thread
  std::vector<float> scratch_;
};

// Endpoint enumeration (passive: never opens a stream), in Chromium's order.
std::vector<DeviceInfo> enumerateOutputDevices(std::string* err);
// Resolves a config to an endpoint id: id > exact name (+ nameIndex) >
// case-insensitive name > name prefix > default endpoint of cfg.role.
// Inactive endpoints are never chosen. Empty string when nothing matches.
std::string resolveOutputDevice(const DeviceConfig& cfg, const std::vector<DeviceInfo>& devices);
// COM + MMDevice enumerator usable on this machine (passive check).
bool deviceApiAvailable(std::string* err);

// ---------------------------------------------------------------------------
// DeviceSupervisor: the output the core renders into (SPEC.md §8.2, §8.4).
// Opens the configured endpoint with the mode fallbacks, and keeps it:
//  - Lost (stream invalidated, endpoint removed / disabled): the NULL
//    device's real-time pacer takes over at the same rate (silent; the
//    transport, the sample clock and a recording keep going), then the SAME
//    endpoint (same id, or same name + nameIndex) is reopened when it comes
//    back (Added / StateChanged active / periodic retry);
//  - DefaultChanged: followed only when the configuration follows the default;
//  - FormatChanged of the open endpoint: reopened (rate changes re-prepare);
//  - PeriodStep: relayed (the device stepped its own period up).
// Only one device renders at a time (the previous one is stopped first), so
// the render callback is never entered concurrently. Events are handled on
// the supervisor's own worker thread (COM MTA) or, in manual mode, by
// handlePending() on the owner's thread (the core's ops thread, tests).
// ---------------------------------------------------------------------------
enum class DeviceChange : uint8_t {
  Opened = 0,      // open() / openNull() succeeded
  Lost,            // the device is gone: the NULL pacer stands in
  Restored,        // the configured endpoint is back and reopened
  DefaultChanged,  // followed the new default endpoint
  Reopened,        // reopened after a format change or a restart()
  PeriodStep,      // the device stepped its period up after glitches
  Failed           // a reopen failed (the stand-in keeps running, retries continue)
};
const char* deviceChangeName(DeviceChange c) noexcept;  // "opened", "lost", "restored", "defaultChanged", "reopened", "periodStep", "failed"

struct SupervisorOptions {
  std::function<std::unique_ptr<AudioDevice>()> makeDevice;                          // default: createSystemDevice
  std::function<std::vector<DeviceInfo>(std::string* err)> enumerate;               // default: enumerateOutputDevices
  std::function<std::unique_ptr<DeviceWatcher>(DeviceEventFn fn)> makeWatcher;      // default: createDeviceWatcher (nullptr: none)
  bool standIn = true;   // NULL real-time pacer while the device is lost (main output); false: nothing renders (phones)
  bool manual = false;   // no worker thread: the owner calls handlePending() (core ops thread, tests)
  std::function<void()> wake;  // manual mode: called on any thread when handlePending() has work
  double retrySec = 2.0;       // while lost: reopen attempts every retrySec (0 = at every handlePending)
};

class DeviceSupervisor {
 public:
  // Owner callbacks. Change: after the operation, on the worker / owner thread,
  // never under the supervisor's lock (the handler may call status()).
  // Prepare: before a device starts at a new rate or channel count (no device
  // renders at that moment): re-prepare the modules, route the outputs.
  using ChangeFn = std::function<void(DeviceChange change, const DeviceStatus& st)>;
  using PrepareFn = std::function<void(int sampleRate, int channels)>;

  explicit DeviceSupervisor(IRenderCallback* cb, SupervisorOptions opt = SupervisorOptions());
  ~DeviceSupervisor();
  DeviceSupervisor(const DeviceSupervisor&) = delete;
  DeviceSupervisor& operator=(const DeviceSupervisor&) = delete;
  void setChangeHandler(ChangeFn fn);
  void setPrepareHandler(PrepareFn fn);

  // The NULL device as the output (threaded engine before device.open, or a
  // headless run). The previous output is stopped first.
  bool openNull(const NullDeviceConfig& nc, std::string* err);
  // device.open (ops thread): resolve, open with the fallbacks, start. On
  // failure the previous output keeps running.
  bool open(const DeviceConfig& cfg, std::string* err);
  // Stall watchdog: close the device and open the same configuration again.
  bool restart(std::string* err);
  void close();
  // Device / watcher notifications (any non-real-time thread): queued.
  void post(const DeviceEventInfo& ev);
  // Manual mode: handles the queued events and the due retries. Returns the
  // number of events handled.
  int handlePending();
  DeviceStatus status() const;  // non-blocking (cached + the active device's own status)
  bool lost() const noexcept;
  DeviceConfig config() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// ---------------------------------------------------------------------------
// Real-time thread policy (SPEC.md §8.8). Windows: MMCSS task (e.g. "Pro
// Audio") at AVRT_PRIORITY_HIGH, thread power throttling off; when MMCSS is
// unavailable the thread gets THREAD_PRIORITY_TIME_CRITICAL instead (and
// *err says why, the handle is null); elsewhere no-ops. Returns an opaque
// handle to give back to demoteAudioThread() when the thread ends.
// ---------------------------------------------------------------------------
void* promoteAudioThread(const char* mmcssTask, std::string* err);
void demoteAudioThread(void* handle);
// The calling (non-real-time) service thread runs above normal priority:
// the core's control thread and the recorder's writer (SPEC.md §3.1).
// Windows: THREAD_PRIORITY_ABOVE_NORMAL; no-op in the portable build.
void raiseServiceThreadPriority() noexcept;
// Disables execution-speed power throttling (EcoQoS) for the whole process
// (and keeps timer-resolution requests honoured while throttled); the
// control thread calls it at start and every 10 s.
bool disableProcessPowerThrottling(std::string* err);

// Verification of the policy (tests, diagnostics).
struct ThreadPolicyInfo {
  bool supported = false;          // the platform has these policies (false: portable stand-in)
  bool mmcss = false;              // the thread is registered with MMCSS (handle valid)
  bool powerThrottlingKnown = false;
  bool powerThrottlingOff = false; // execution-speed throttling explicitly disabled for the thread
  int priority = 0;                // GetThreadPriority
  unsigned long systemResponsiveness = 0;  // MMCSS system responsiveness (%)
};
// Policy of the CALLING thread; `mmcssHandle` = what promoteAudioThread returned.
bool queryAudioThreadPolicy(void* mmcssHandle, ThreadPolicyInfo& out);
// Reads the process setting back (GetProcessInformation). False when unknown.
bool queryProcessPowerThrottling(bool* throttlingOff, std::string* err);

// ---------------------------------------------------------------------------
// Headphones on another sound card (engine.js setPhonesDevice): the main
// audio thread pushes the cue bus, this object's own WASAPI stream plays it
// through a resampler whose ratio follows the ring fill level (the two
// cards' clocks drift). A card with >= 4 channels gets the cue on 3/4 (DJ
// controller), a stereo card on 1/2. Shared mode only. The ring, the PI
// controller and the resampler are portable; the stream is Windows code.
// Loss / restore: the same DeviceSupervisor rules as the main output
// (without a stand-in: the ring simply overflows while the card is gone).
// ---------------------------------------------------------------------------
class SecondaryOutput {
 public:
  SecondaryOutput();
  explicit SecondaryOutput(const SupervisorOptions& opt);  // tests: fake devices, manual mode
  ~SecondaryOutput();
  SecondaryOutput(const SecondaryOutput&) = delete;
  SecondaryOutput& operator=(const SecondaryOutput&) = delete;
  bool open(const DeviceConfig& cfg, int mainSampleRate, int mainPeriodFrames, std::string* err);
  void close();
  // Main audio thread: the cue bus of one block (RT-safe, drops when full).
  void push(const float* l, const float* r, int frames) noexcept;
  // Same, stamped with the block's engine time (BlockClock::callbackTime of
  // the main callback): the fill is then measured without the main
  // callback's render-time jitter. The plain push() stamps EngineClock::now().
  void push(const float* l, const float* r, int frames, EngineTime t) noexcept;
  bool active() const noexcept;
  DeviceStatus status() const;
  double driftRatio() const noexcept;  // current resampling correction (1.0 = no drift)
  void setEventHandler(DeviceEventFn fn);
  uint64_t droppedFrames() const noexcept;  // main-side ring overflows (card gone / too slow)
  uint64_t underruns() const noexcept;      // phones-side ring underruns (re-primed)
  // Manual mode (tests): handles the supervisor's queued events.
  int handlePending();

  // Building block exposed for the offline tests: the drift-correcting
  // resampler driven by a simulated consumer clock. The ratio is the input
  // frames consumed per output frame relative to the nominal ratio (true
  // value producerRate / consumerRate when both claim the same rate).
  struct DriftSim {
    double producerRate = 48000, consumerRate = 48000.5;
    int seconds = 60;
    double finalRatio = 0, maxFillError = 0;  // results (maxFillError in frames, after priming)
    // additions of the device module
    int producerBlock = 256, consumerBlock = 256;  // frames per callback on each side
    double nominalProducerRate = 0, nominalConsumerRate = 0;  // 0 = the true rates rounded to integers
    double jitterMs = 0;            // random scheduling jitter of both callbacks (+- ms)
    double trueRatio = 0;           // results: the ratio that keeps the fill constant
    double ratioErrorPpm = 0;       // |mean ratio over the second half - true| / true (finalRatio = that mean)
    double settledFillError = 0;    // max |fill - target| over the second half (frames)
    double targetFill = 0;          // frames
    uint64_t underruns = 0, overflows = 0;
    double maxGlitch = 0;           // largest sample step at the output on a 997 Hz sine (continuity check)
  };
  static bool simulateDrift(DriftSim& sim);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
