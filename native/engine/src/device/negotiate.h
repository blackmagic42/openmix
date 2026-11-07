// WASAPI open policy of the device layer (owner: device, private header),
// written against IAudioClientOps — the few IAudioClient / IAudioClient2 /
// IAudioClient3 calls the open sequence makes — so that it is portable and
// tested with a fake client that returns the real HRESULT values:
//  - modes and the fallback chain Exclusive -> SharedLowLatency -> Shared,
//    reported with a reason ("in-use", "not-allowed", "format",
//    "periodicity-locked", "unsupported");
//  - low-latency period policy: the smallest valid IAudioClient3 period
//    (minimum + k x fundamental) >= 5 ms, never the absolute minimum (it
//    lowers the whole endpoint's engine period, the game's audio included);
//    `periodFrames` overrides; stepped up after 3 glitches in 10 s;
//  - exclusive negotiation: rates (requested, mix) x channel layouts (mix
//    count + mask, then PKEY_AudioEngine_DeviceFormat) x sample formats
//    (f32, s32, s24-in-32, s24 packed, s16);
//  - documented HRESULT sequences: BUFFER_SIZE_NOT_ALIGNED -> GetBufferSize,
//    aligned period, new client, Initialize again; UNSUPPORTED_FORMAT -> next
//    candidate; DEVICE_IN_USE / EXCLUSIVE_MODE_NOT_ALLOWED -> shared;
//    ENGINE_PERIODICITY_LOCKED -> the locked period if >= 5 ms, else plain
//    shared; DEVICE_INVALIDATED -> loss;
//  - optional raw stream (IAudioClient2::SetClientProperties RAW) before
//    every Initialize when the endpoint supports it.
// The Windows implementation of IAudioClientOps is in win/wasapi_device.cpp.
// SPEC.md §8.2.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "formats.h"
#include "om/device.h"

namespace om {
namespace dev {

// ---- HRESULT values (audioclient.h / winerror.h; static_assert'ed against
// the Windows SDK in win/wasapi_device.cpp) ----------------------------------
constexpr int32_t hr32(uint32_t v) noexcept { return static_cast<int32_t>(v); }
constexpr int32_t audclntErr(uint32_t n) noexcept { return hr32(0x88890000u | n); }
constexpr int32_t kS_OK = 0;
constexpr int32_t kS_FALSE = 1;
constexpr int32_t kE_FAIL = hr32(0x80004005u);
constexpr int32_t kE_NOTIMPL = hr32(0x80004001u);
constexpr int32_t kE_NOINTERFACE = hr32(0x80004002u);
constexpr int32_t kE_INVALIDARG = hr32(0x80070057u);
constexpr int32_t kE_NOTFOUND = hr32(0x80070490u);  // HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
constexpr int32_t kAudclntDeviceInvalidated = audclntErr(0x004);
constexpr int32_t kAudclntUnsupportedFormat = audclntErr(0x008);
constexpr int32_t kAudclntDeviceInUse = audclntErr(0x00a);
constexpr int32_t kAudclntExclusiveModeNotAllowed = audclntErr(0x00e);
constexpr int32_t kAudclntBufferSizeNotAligned = audclntErr(0x019);
constexpr int32_t kAudclntInvalidDevicePeriod = audclntErr(0x020);
constexpr int32_t kAudclntResourcesInvalidated = audclntErr(0x026);
constexpr int32_t kAudclntRawModeUnsupported = audclntErr(0x027);
constexpr int32_t kAudclntEnginePeriodicityLocked = audclntErr(0x028);
constexpr int32_t kAudclntServiceNotRunning = audclntErr(0x010);
inline bool hrOk(int32_t hr) noexcept { return hr >= 0; }
// "AUDCLNT_E_DEVICE_IN_USE" etc. ("0x..." for unknown values: buffer of 16+).
const char* hresultName(int32_t hr, char* buf = nullptr, size_t len = 0) noexcept;
// The device is gone (stream unusable until it is reopened).
inline bool hrMeansLost(int32_t hr) noexcept {
  return hr == kAudclntDeviceInvalidated || hr == kAudclntResourcesInvalidated || hr == kAudclntServiceNotRunning ||
         hr == kE_NOTFOUND;
}

// 100-ns units <-> frames
inline int64_t framesToHns(double frames, int rate) noexcept {
  return rate > 0 ? static_cast<int64_t>(10000000.0 * frames / rate + 0.5) : 0;
}
inline int hnsToFrames(int64_t hns, int rate) noexcept {
  return static_cast<int>(static_cast<double>(hns) * rate / 10000000.0 + 0.5);
}

// ---------------------------------------------------------------------------
// The client seam ("fake IAudioClient" in the tests). One endpoint. A client
// can be Initialized once: activate() makes a fresh one (Release + Activate).
// ---------------------------------------------------------------------------
class IAudioClientOps {
 public:
  virtual ~IAudioClientOps() = default;
  virtual int32_t activate() = 0;   // (re)creates the IAudioClient (IAudioClient3 when available)
  virtual void release() = 0;       // drops the current client
  virtual int32_t getMixFormat(StreamFormat& out) = 0;
  virtual int32_t getDeviceFormat(StreamFormat& out) = 0;  // PKEY_AudioEngine_DeviceFormat (error when absent)
  virtual int32_t getDevicePeriod(int64_t& defaultHns, int64_t& minHns) = 0;
  virtual bool hasClient3() = 0;
  virtual int32_t getSharedModeEnginePeriod(const StreamFormat& f, uint32_t& defaultFrames, uint32_t& fundamentalFrames,
                                            uint32_t& minFrames, uint32_t& maxFrames) = 0;
  virtual int32_t getCurrentSharedModeEnginePeriod(uint32_t& periodFrames) = 0;
  virtual bool rawSupported() = 0;  // PKEY_Devices_AudioDevice_RawProcessingSupported && IAudioClient2
  virtual int32_t setRawOption(bool on) = 0;  // IAudioClient2::SetClientProperties(AUDCLNT_STREAMOPTIONS_RAW)
  virtual int32_t isExclusiveFormatSupported(const StreamFormat& f) = 0;
  // IAudioClient::Initialize(SHARED, EVENTCALLBACK | NOPERSIST, bufferHns, 0, f)
  virtual int32_t initShared(const StreamFormat& f, int64_t bufferHns) = 0;
  // IAudioClient3::InitializeSharedAudioStream(EVENTCALLBACK, periodFrames, f)
  virtual int32_t initSharedLowLatency(const StreamFormat& f, uint32_t periodFrames) = 0;
  // IAudioClient::Initialize(EXCLUSIVE, EVENTCALLBACK, periodHns, periodHns, f)
  virtual int32_t initExclusive(const StreamFormat& f, int64_t periodHns) = 0;
  virtual int32_t getBufferSize(uint32_t& frames) = 0;
  virtual int32_t getStreamLatency(int64_t& hns) = 0;
};

struct NegotiateRequest {
  OutputMode mode = OutputMode::Shared;
  int periodFrames = 0;      // override (0 = policy)
  double minPeriodMs = 5.0;  // low-latency floor
  int sampleRate = 0;        // exclusive: requested rate (0 = mix rate)
  bool raw = false;
  static NegotiateRequest from(const DeviceConfig& c) noexcept {
    NegotiateRequest r;
    r.mode = c.mode;
    r.periodFrames = c.periodFrames;
    r.minPeriodMs = c.minPeriodMs > 0 ? c.minPeriodMs : 5.0;
    r.sampleRate = c.sampleRate;
    r.raw = c.raw;
    return r;
  }
};

struct NegotiateResult {
  bool ok = false;
  bool lost = false;                // AUDCLNT_E_DEVICE_INVALIDATED (or equivalent) during the open
  DeviceMode mode = DeviceMode::Closed;
  StreamFormat format;              // the stream's format (shared: the mix format)
  StreamFormat mixFormat;
  int periodFrames = 0;             // event period
  int bufferFrames = 0;
  int64_t periodHns = 0;            // exclusive: the (aligned) period used
  // step-up bounds of the chosen mode: the next period is current + stepFrames, up to maxStepFrames
  int stepFrames = 0;
  int maxStepFrames = 0;
  int defaultPeriodFrames = 0;      // the endpoint's default (shared engine) period
  int fundamentalFrames = 0;        // IAudioClient3 (0 when unsupported)
  double streamLatencyMs = 0;
  bool fellBack = false;
  std::string fallbackReason;
  bool raw = false;
  int32_t hr = 0;                   // last failure
  std::string error;
  std::vector<std::string> trace;   // what was tried, in order (diagnostics, tests)
};

// Runs the whole open sequence on `ops`. On success the client is
// initialized and ready for GetService / SetEventHandle. On failure the
// client is released; `lost` says whether the device itself is gone.
bool negotiateStream(IAudioClientOps& ops, const NegotiateRequest& req, NegotiateResult& out);

// ---- period policy (portable, tested directly) -------------------------------
// Smallest valid IAudioClient3 period >= target: min + k * fundamental within
// [min, max]; 0 when none.
int validSharedPeriodAtLeast(int target, int fundamental, int minP, int maxP) noexcept;
// The low-latency shared period: smallest valid period >= minPeriodMs (or the
// override, rounded up to a valid period), at most the default period. 0
// when the endpoint offers nothing below its default period.
int lowLatencyPeriodFrames(int sampleRate, double minPeriodMs, int overrideFrames, int defaultP, int fundamental,
                           int minP, int maxP) noexcept;

// Step-up after repeated glitches: >= kGlitchesPerStep within kGlitchWindowSec
// -> next period (current + step, at most the max). RT-safe (fixed state).
class PeriodStepper {
 public:
  static constexpr int kGlitchesPerStep = 3;
  static constexpr double kGlitchWindowSec = 10.0;
  void reset(int currentFrames, int stepFrames, int maxFrames) noexcept;
  // A glitch at time t (seconds, any monotonic clock). True when a step-up is
  // due (and possible): the caller reopens with nextFrames().
  bool onGlitch(double t) noexcept;
  int currentFrames() const noexcept { return current_; }
  int nextFrames() const noexcept;
  bool canStep() const noexcept { return step_ > 0 && current_ < max_; }

 private:
  int current_ = 0, step_ = 0, max_ = 0;
  double times_[kGlitchesPerStep] = {};
  int count_ = 0;   // glitches stored (ring)
  int head_ = 0;
};

}  // namespace dev
}  // namespace om
