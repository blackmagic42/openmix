// WASAPI open policy (owner: device): the mode fallback chain, the
// low-latency period policy, exclusive format / channel negotiation and the
// documented HRESULT sequences, written against IAudioClientOps so that the
// same code runs on the real IAudioClient (win/wasapi_device.cpp) and on the
// fake client of the tests. Also the glitch step-up counter. Portable.
// SPEC.md §8.2.
#include "negotiate.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace om {
namespace dev {

const char* hresultName(int32_t hr, char* buf, size_t len) noexcept {
  switch (hr) {
    case kS_OK: return "S_OK";
    case kS_FALSE: return "S_FALSE";
    case kE_FAIL: return "E_FAIL";
    case kE_NOTIMPL: return "E_NOTIMPL";
    case kE_NOINTERFACE: return "E_NOINTERFACE";
    case kE_INVALIDARG: return "E_INVALIDARG";
    case kE_NOTFOUND: return "E_NOTFOUND";
    case kAudclntDeviceInvalidated: return "AUDCLNT_E_DEVICE_INVALIDATED";
    case kAudclntUnsupportedFormat: return "AUDCLNT_E_UNSUPPORTED_FORMAT";
    case kAudclntDeviceInUse: return "AUDCLNT_E_DEVICE_IN_USE";
    case kAudclntExclusiveModeNotAllowed: return "AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED";
    case kAudclntBufferSizeNotAligned: return "AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED";
    case kAudclntInvalidDevicePeriod: return "AUDCLNT_E_INVALID_DEVICE_PERIOD";
    case kAudclntResourcesInvalidated: return "AUDCLNT_E_RESOURCES_INVALIDATED";
    case kAudclntRawModeUnsupported: return "AUDCLNT_E_RAW_MODE_UNSUPPORTED";
    case kAudclntEnginePeriodicityLocked: return "AUDCLNT_E_ENGINE_PERIODICITY_LOCKED";
    case kAudclntServiceNotRunning: return "AUDCLNT_E_SERVICE_NOT_RUNNING";
    default: break;
  }
  if (buf && len >= 11) {
    std::snprintf(buf, len, "0x%08X", static_cast<unsigned>(hr));
    return buf;
  }
  return "HRESULT";
}

int validSharedPeriodAtLeast(int target, int fundamental, int minP, int maxP) noexcept {
  if (fundamental <= 0 || minP <= 0) return 0;
  if (target <= minP) return minP;
  const int k = (target - minP + fundamental - 1) / fundamental;
  const int p = minP + k * fundamental;
  if (maxP > 0 && p > maxP) return 0;
  return p;
}

int lowLatencyPeriodFrames(int sampleRate, double minPeriodMs, int overrideFrames, int defaultP, int fundamental, int minP,
                           int maxP) noexcept {
  if (sampleRate <= 0 || fundamental <= 0 || minP <= 0) return 0;
  if (overrideFrames > 0) {
    int p = validSharedPeriodAtLeast(overrideFrames, fundamental, minP, maxP);
    if (p == 0 && maxP >= minP) p = minP + (maxP - minP) / fundamental * fundamental;  // above the max: the largest valid one
    return p;
  }
  const double floorMs = minPeriodMs > 0 ? minPeriodMs : 5.0;
  const int target = static_cast<int>(std::ceil(floorMs * sampleRate / 1000.0 - 1e-9));
  const int p = validSharedPeriodAtLeast(target, fundamental, minP, maxP);
  if (p == 0) return 0;
  if (defaultP > 0 && p >= defaultP) return 0;  // nothing below the default period: plain shared
  return p;
}

// ---------------------------------------------------------------------------
// PeriodStepper
// ---------------------------------------------------------------------------
void PeriodStepper::reset(int currentFrames, int stepFrames, int maxFrames) noexcept {
  current_ = currentFrames;
  step_ = stepFrames;
  max_ = maxFrames;
  count_ = 0;
  head_ = 0;
}

bool PeriodStepper::onGlitch(double t) noexcept {
  times_[head_] = t;
  head_ = (head_ + 1) % kGlitchesPerStep;
  if (count_ < kGlitchesPerStep) count_++;
  if (count_ < kGlitchesPerStep || !canStep()) return false;
  const double oldest = times_[head_];  // head_ now points at the oldest of the last N
  if (t - oldest <= kGlitchWindowSec) {
    count_ = 0;  // counting restarts with the new period
    return true;
  }
  return false;
}

int PeriodStepper::nextFrames() const noexcept {
  if (!canStep()) return current_;
  return std::min(current_ + step_, max_);
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------
namespace {

struct Ctx {
  IAudioClientOps& ops;
  const NegotiateRequest& req;
  NegotiateResult& out;
  bool fresh = true;      // the current client has not been Initialize'd (successfully or not)
  bool rawWanted = false;

  void note(const std::string& s) { out.trace.push_back(s); }
  std::string hrs(int32_t hr) {
    char b[16];
    return hresultName(hr, b, sizeof(b));
  }
  // A client that was given to Initialize (even a failed one) cannot be
  // initialized again: release it and activate a new one.
  int32_t renew() {
    if (fresh) return kS_OK;
    ops.release();
    const int32_t hr = ops.activate();
    note("activate " + hrs(hr));
    fresh = true;
    return hr;
  }
  // SetClientProperties(RAW) goes on every fresh client before Initialize.
  void applyRaw() {
    if (!rawWanted) return;
    const int32_t hr = ops.setRawOption(true);
    note("setRaw " + hrs(hr));
    out.raw = hrOk(hr);
  }
  void finish(DeviceMode mode, const StreamFormat& f, int periodFrames) {
    uint32_t buf = 0;
    ops.getBufferSize(buf);
    int64_t lat = 0;
    if (hrOk(ops.getStreamLatency(lat))) out.streamLatencyMs = lat / 10000.0;
    out.ok = true;
    out.mode = mode;
    out.format = f;
    out.bufferFrames = static_cast<int>(buf);
    out.periodFrames = periodFrames > 0 ? periodFrames : static_cast<int>(buf);
    if (!rawWanted) out.raw = false;
  }
};

enum class Outcome { Ok, Lost, Refused };

Outcome tryExclusive(Ctx& c, int64_t defHns, int64_t minHns, std::string& reason) {
  const StreamFormat& mix = c.out.mixFormat;
  std::vector<int> rates;
  if (c.req.sampleRate > 0) rates.push_back(c.req.sampleRate);
  if (std::find(rates.begin(), rates.end(), mix.sampleRate) == rates.end()) rates.push_back(mix.sampleRate);
  struct Layout {
    int channels;
    uint32_t mask;
  };
  std::vector<Layout> layouts;
  layouts.push_back({mix.channels, mix.channelMask ? mix.channelMask : defaultChannelMask(mix.channels)});
  StreamFormat df;
  if (hrOk(c.ops.getDeviceFormat(df)) && df.channels > 0) {
    const uint32_t m = df.channelMask ? df.channelMask : defaultChannelMask(df.channels);
    if (df.channels != layouts[0].channels || m != layouts[0].mask) layouts.push_back({df.channels, m});
  }
  static const SampleFormat kFormats[] = {SampleFormat::F32, SampleFormat::S32, SampleFormat::S24in32, SampleFormat::S24,
                                          SampleFormat::S16};
  reason = "format";  // when every candidate is refused
  for (int rate : rates) {
    // The period: the override, else the device's minimum ("smallest
    // stable", stepped up after glitches), never below 2 ms.
    const int64_t floorHns = 20000;
    int64_t periodHns = c.req.periodFrames > 0 ? framesToHns(c.req.periodFrames, rate) : std::max(minHns, floorHns);
    if (periodHns <= 0) periodHns = defHns > 0 ? defHns : 100000;
    for (const Layout& lay : layouts) {
      for (SampleFormat sf : kFormats) {
        StreamFormat f;
        f.sampleRate = rate;
        f.channels = lay.channels;
        f.channelMask = lay.mask;
        f.format = sf;
        const std::string what = std::to_string(rate) + "/" + std::to_string(lay.channels) + "ch/" + sampleFormatName(sf);
        int32_t hr = c.ops.isExclusiveFormatSupported(f);
        if (hrMeansLost(hr)) {
          c.note("exclusive " + what + " " + c.hrs(hr));
          c.out.hr = hr;
          return Outcome::Lost;
        }
        if (hr != kS_OK) {
          c.note("exclusive " + what + " not supported (" + c.hrs(hr) + ")");
          continue;
        }
        hr = c.renew();
        if (hrMeansLost(hr)) return Outcome::Lost;
        c.applyRaw();
        int64_t p = periodHns;
        hr = c.ops.initExclusive(f, p);
        c.fresh = false;
        c.note("initExclusive " + what + " " + std::to_string(p) + " hns " + c.hrs(hr));
        if (hr == kAudclntBufferSizeNotAligned) {
          // Documented sequence: the aligned buffer size, a new client, Initialize again.
          uint32_t frames = 0;
          c.ops.getBufferSize(frames);
          p = static_cast<int64_t>(10000.0 * 1000 / rate * frames + 0.5);
          c.note("aligned period " + std::to_string(frames) + " frames = " + std::to_string(p) + " hns");
          hr = c.renew();
          if (hrMeansLost(hr)) return Outcome::Lost;
          c.applyRaw();
          hr = c.ops.initExclusive(f, p);
          c.fresh = false;
          c.note("initExclusive (aligned) " + c.hrs(hr));
        }
        if (hrOk(hr)) {
          c.out.periodHns = p;
          c.finish(DeviceMode::Exclusive, f, 0);  // exclusive event mode: buffer == period
          // Step-ups: + the starting period, up to the endpoint's default period.
          const int start = c.out.periodFrames;
          const int def = hnsToFrames(defHns, rate);
          c.out.stepFrames = (c.req.periodFrames > 0 || start >= def) ? 0 : std::max(1, hnsToFrames(std::max(minHns, floorHns), rate));
          c.out.maxStepFrames = def;
          return Outcome::Ok;
        }
        c.out.hr = hr;
        if (hr == kAudclntUnsupportedFormat) continue;
        if (hr == kAudclntDeviceInUse) {
          reason = "in-use";
          return Outcome::Refused;
        }
        if (hr == kAudclntExclusiveModeNotAllowed) {
          reason = "not-allowed";
          return Outcome::Refused;
        }
        if (hrMeansLost(hr)) return Outcome::Lost;
        // Anything else (E_INVALIDARG, INVALID_DEVICE_PERIOD, a second
        // misalignment...): this candidate is out, try the next one.
      }
    }
  }
  return Outcome::Refused;
}

Outcome tryLowLatency(Ctx& c, bool c3, uint32_t d3, uint32_t f3, uint32_t mn3, uint32_t mx3, std::string& reason) {
  const StreamFormat& mix = c.out.mixFormat;
  if (!c3) {
    reason = "unsupported";
    c.note("lowlatency: no IAudioClient3 periods");
    return Outcome::Refused;
  }
  const int p = lowLatencyPeriodFrames(mix.sampleRate, c.req.minPeriodMs, c.req.periodFrames, static_cast<int>(d3),
                                       static_cast<int>(f3), static_cast<int>(mn3), static_cast<int>(mx3));
  if (p <= 0) {
    reason = "unsupported";
    c.note("lowlatency: no period below the default (" + std::to_string(d3) + ")");
    return Outcome::Refused;
  }
  int32_t hr = c.renew();
  if (hrMeansLost(hr)) return Outcome::Lost;
  c.applyRaw();
  hr = c.ops.initSharedLowLatency(mix, static_cast<uint32_t>(p));
  c.fresh = false;
  c.note("initSharedLowLatency " + std::to_string(p) + " " + c.hrs(hr));
  if (hrOk(hr)) {
    c.finish(DeviceMode::SharedLowLatency, mix, p);
    c.out.stepFrames = c.req.periodFrames > 0 ? 0 : static_cast<int>(f3);
    c.out.maxStepFrames = static_cast<int>(d3);
    return Outcome::Ok;
  }
  c.out.hr = hr;
  if (hrMeansLost(hr)) return Outcome::Lost;
  if (hr == kAudclntEnginePeriodicityLocked) {
    // Another client locked the engine period: use it when it is >= the
    // floor (still low latency), else plain shared.
    uint32_t cur = 0;
    const int32_t hc = c.ops.getCurrentSharedModeEnginePeriod(cur);
    const double curMs = mix.sampleRate > 0 ? 1000.0 * cur / mix.sampleRate : 0;
    c.note("periodicity locked at " + std::to_string(cur) + " frames (" + c.hrs(hc) + ")");
    if (hrOk(hc) && cur > 0 && curMs >= c.req.minPeriodMs - 1e-6 && cur < d3) {
      hr = c.renew();
      if (hrMeansLost(hr)) return Outcome::Lost;
      c.applyRaw();
      hr = c.ops.initSharedLowLatency(mix, cur);
      c.fresh = false;
      c.note("initSharedLowLatency (locked) " + std::to_string(cur) + " " + c.hrs(hr));
      if (hrOk(hr)) {
        c.finish(DeviceMode::SharedLowLatency, mix, static_cast<int>(cur));
        c.out.stepFrames = 0;  // the period belongs to another client
        c.out.maxStepFrames = static_cast<int>(cur);
        return Outcome::Ok;
      }
      c.out.hr = hr;
      if (hrMeansLost(hr)) return Outcome::Lost;
    }
    reason = "periodicity-locked";
    return Outcome::Refused;
  }
  reason = hr == kAudclntDeviceInUse ? "in-use" : "unsupported";
  return Outcome::Refused;
}

}  // namespace

bool negotiateStream(IAudioClientOps& ops, const NegotiateRequest& req, NegotiateResult& out) {
  out = NegotiateResult();
  Ctx c{ops, req, out};
  auto failWith = [&](int32_t hr, const std::string& what) {
    out.ok = false;
    out.hr = hr;
    out.lost = out.lost || hrMeansLost(hr);
    out.error = what + " failed (" + c.hrs(hr) + ")";
    ops.release();
    return false;
  };

  int32_t hr = ops.activate();
  c.note("activate " + c.hrs(hr));
  if (!hrOk(hr)) return failWith(hr, "Activate(IAudioClient)");
  hr = ops.getMixFormat(out.mixFormat);
  if (!hrOk(hr) || out.mixFormat.sampleRate <= 0 || out.mixFormat.channels <= 0)
    return failWith(hrOk(hr) ? kE_FAIL : hr, "GetMixFormat");
  const int rate = out.mixFormat.sampleRate;
  int64_t defHns = 0, minHns = 0;
  if (!hrOk(ops.getDevicePeriod(defHns, minHns)) || defHns <= 0) {
    defHns = 100000;  // 10 ms, the usual engine period
    if (minHns <= 0) minHns = 30000;
  }
  out.defaultPeriodFrames = hnsToFrames(defHns, rate);
  uint32_t d3 = 0, f3 = 0, mn3 = 0, mx3 = 0;
  const bool c3 = ops.hasClient3() && hrOk(ops.getSharedModeEnginePeriod(out.mixFormat, d3, f3, mn3, mx3)) && f3 > 0 &&
                  mn3 > 0 && d3 > 0;
  if (c3) {
    out.fundamentalFrames = static_cast<int>(f3);
    out.defaultPeriodFrames = static_cast<int>(d3);
    c.note("client3 periods default " + std::to_string(d3) + " fundamental " + std::to_string(f3) + " min " +
           std::to_string(mn3) + " max " + std::to_string(mx3));
  }
  c.rawWanted = req.raw && ops.rawSupported();
  if (req.raw && !c.rawWanted) c.note("raw not supported by the endpoint");

  OutputMode mode = req.mode;
  if (mode == OutputMode::Exclusive) {
    std::string reason;
    const Outcome o = tryExclusive(c, defHns, minHns, reason);
    if (o == Outcome::Ok) return true;
    if (o == Outcome::Lost) {
      out.lost = true;
      return failWith(hrMeansLost(out.hr) ? out.hr : kAudclntDeviceInvalidated, "exclusive open");
    }
    out.fellBack = true;
    out.fallbackReason = reason;
    c.note("exclusive refused: " + reason);
    mode = OutputMode::SharedLowLatency;
  }
  if (mode == OutputMode::SharedLowLatency) {
    std::string reason;
    const Outcome o = tryLowLatency(c, c3, d3, f3, mn3, mx3, reason);
    if (o == Outcome::Ok) return true;
    if (o == Outcome::Lost) {
      out.lost = true;
      return failWith(hrMeansLost(out.hr) ? out.hr : kAudclntDeviceInvalidated, "low-latency open");
    }
    if (!out.fellBack) {
      out.fellBack = true;
      out.fallbackReason = reason;
    }
    c.note("low latency refused: " + reason);
  }

  // Plain shared mode: the engine's period, the minimum buffer (like Chromium).
  hr = c.renew();
  if (!hrOk(hr)) return failWith(hr, "Activate(IAudioClient)");
  c.applyRaw();
  hr = ops.initShared(out.mixFormat, 0);
  c.fresh = false;
  c.note("initShared " + c.hrs(hr));
  if (!hrOk(hr)) {
    if (hr == kAudclntDeviceInUse) {
      failWith(hr, "shared open");
      out.error = "the device is used in exclusive mode by another application (in-use)";
      return false;
    }
    return failWith(hr, "IAudioClient::Initialize(shared)");
  }
  int period = out.defaultPeriodFrames;
  if (c3) {
    uint32_t cur = 0;
    if (hrOk(ops.getCurrentSharedModeEnginePeriod(cur)) && cur > 0) period = static_cast<int>(cur);
  }
  c.finish(DeviceMode::Shared, out.mixFormat, period);
  out.stepFrames = 0;
  out.maxStepFrames = period;
  return true;
}

}  // namespace dev
}  // namespace om
