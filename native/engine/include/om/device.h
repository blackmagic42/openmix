// Audio output devices of the native engine (owner: device):
//  - WASAPI event-driven output: shared mode, low-latency shared mode through
//    IAudioClient3 when the driver supports it, exclusive mode as an option;
//  - a NULL device rendering into memory (tests, offline renders: never
//    touches the sound card);
//  - SecondaryOutput: headphones on a second sound card, fed by the main
//    callback through a lock-free ring with drift compensation;
//  - endpoint enumeration and default-device / removal notifications.
// See SPEC.md §6.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "om/common.h"

namespace om {

struct DeviceInfo {
  std::string id;              // WASAPI endpoint id (UTF-8)
  std::string name;            // PKEY_Device_FriendlyName == Chromium's MediaDeviceInfo.label
  int channels = 0;            // shared-mode mix format
  int sampleRate = 0;
  bool isDefault = false;      // default eConsole render endpoint
  bool isDefaultComms = false; // default eCommunications render endpoint
  double defaultPeriodMs = 0;  // IAudioClient::GetDevicePeriod
  double minPeriodMs = 0;      // exclusive-mode minimum
  // IAudioClient3::GetSharedModeEnginePeriod (all 0 when unsupported)
  int sharedMinPeriodFrames = 0;
  int sharedDefaultPeriodFrames = 0;
  int sharedFundamentalFrames = 0;
};

enum class ShareMode : uint8_t { Shared = 0, Exclusive = 1 };
enum class DeviceMode : uint8_t { Closed = 0, Null, Shared, SharedLowLatency, Exclusive };
const char* deviceModeName(DeviceMode m) noexcept;  // "closed", "null", "shared", "shared-lowlat", "exclusive"

struct DeviceConfig {
  std::string id;              // exact endpoint id (wins over name)
  std::string name;            // friendly name: exact match, then case-insensitive, then prefix
  ShareMode share = ShareMode::Shared;
  int periodFrames = 0;        // 0 = smallest supported; otherwise rounded to what the device accepts
  int sampleRate = 0;          // exclusive only (0 = mix-format rate)
  bool lowLatency = true;      // shared: use IAudioClient3 small periods when available
  bool followDefault = true;   // id and name empty: reopen when the default device changes
};

struct DeviceStatus {
  DeviceMode mode = DeviceMode::Closed;
  std::string id, name;
  int sampleRate = 0;
  int channels = 0;
  int periodFrames = 0;        // engine period (shared) or device period (exclusive)
  int bufferFrames = 0;
  double outputLatencyMs = 0;  // what presentTime adds to callbackTime (buffer + stream latency)
  std::string sampleFormat;    // "f32", "s32", "s24", "s16"
  bool running = false;
  bool lost = false;           // device invalidated (unplugged, format change...)
  uint64_t glitches = 0;       // missed periods detected (IAudioClock gaps / late events)
};

// Render callback, invoked on the device's real-time thread (MMCSS "Pro Audio").
class IRenderCallback {
 public:
  virtual ~IRenderCallback() = default;
  // Fill `frames` interleaved float frames of `channels` channels. RT-safe,
  // never throws. `clock` gives the frame index and the presentation time.
  virtual void render(float* out, int frames, int channels, const BlockClock& clock) noexcept = 0;
};

enum class DeviceEvent : uint8_t { Lost = 0, DefaultChanged, FormatChanged };
// Called on a non-real-time thread (device notification thread).
using DeviceEventFn = std::function<void(DeviceEvent ev)>;

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

// WASAPI implementation (Windows). NEVER open it in exclusive mode from tests.
std::unique_ptr<AudioDevice> createWasapiDevice();

// ---------------------------------------------------------------------------
// NULL device: renders into memory with a virtual clock.
//   realtime == false: no thread; call pump() (deterministic tests).
//   realtime == true : a thread paces blocks at the real rate (soak tests).
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

// Endpoint enumeration (passive: never opens a stream).
std::vector<DeviceInfo> enumerateOutputDevices(std::string* err);
// Resolves a config to an endpoint id: id > exact name > case-insensitive
// name > name prefix > default endpoint. Empty string when nothing matches.
std::string resolveOutputDevice(const DeviceConfig& cfg, std::string* err);
// COM + MMDevice enumerator usable on this machine (passive check).
bool deviceApiAvailable(std::string* err);

// ---------------------------------------------------------------------------
// Headphones on another sound card (engine.js setPhonesDevice): the main
// audio thread pushes the cue bus, this object's own WASAPI stream plays it
// with a drift-compensating resampler (the two cards' clocks differ).
// A card with >= 4 channels gets the cue on channels 3/4 (DJ controller).
// ---------------------------------------------------------------------------
class SecondaryOutput {
 public:
  SecondaryOutput();
  ~SecondaryOutput();
  bool open(const DeviceConfig& cfg, int mainSampleRate, std::string* err);
  void close();
  // Main audio thread: the cue bus of one block (RT-safe, drops when full).
  void push(const float* l, const float* r, int frames) noexcept;
  bool active() const noexcept;
  DeviceStatus status() const;
  double driftRatio() const noexcept;  // current resampling ratio (1.0 = no drift)

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
