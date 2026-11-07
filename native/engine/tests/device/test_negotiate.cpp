// Tests of the WASAPI open policy with a FAKE IAudioClient (owner: device):
// the low-latency period policy (smallest multiple of the fundamental
// >= 5 ms, overrides), the glitch step-up, the exclusive negotiation (rates x
// channel layouts x sample formats), every documented HRESULT path
// (BUFFER_SIZE_NOT_ALIGNED, UNSUPPORTED_FORMAT, DEVICE_IN_USE,
// EXCLUSIVE_MODE_NOT_ALLOWED, ENGINE_PERIODICITY_LOCKED, DEVICE_INVALIDATED),
// the fallback chain with its reasons, and the raw stream option. Portable:
// no sound card, no Windows header (the fake returns the real HRESULT
// values). SPEC.md §8.2.
#include <algorithm>
#include <deque>
#include <string>
#include <vector>

#include "../../src/device/negotiate.h"
#include "../om_test.h"

using namespace om;
using namespace om::dev;

namespace {

constexpr int32_t kAlreadyInitialized = audclntErr(0x002);

struct FakeClient final : IAudioClientOps {
  // ---- endpoint description ----
  StreamFormat mix{48000, 2, 0x3, SampleFormat::F32};
  bool haveDeviceFormat = false;
  StreamFormat deviceFormat{48000, 2, 0x3, SampleFormat::S24};
  int64_t defHns = 100000, minHns = 30000;  // 10 ms / 3 ms
  bool client3 = true;
  uint32_t d3 = 480, f3 = 48, mn3 = 48, mx3 = 480;
  uint32_t currentPeriod = 480;
  bool rawOk = false;
  std::vector<StreamFormat> exclusiveOk;   // IsFormatSupported(EXCLUSIVE) == S_OK for these
  std::deque<int32_t> exclusiveInit;       // results of the next initExclusive calls (then S_OK)
  std::deque<int32_t> lowLatencyInit;      // results of the next initSharedLowLatency calls (then S_OK)
  std::deque<int32_t> sharedInit;          // results of the next initShared calls (then S_OK)
  uint32_t alignedFrames = 0;              // GetBufferSize after BUFFER_SIZE_NOT_ALIGNED
  // ---- what happened ----
  int activations = 0;
  int initsOnClient = 0;
  bool rawOnClient = false;
  int rawCalls = 0;
  bool rawMissing = false;  // an Initialize without SetClientProperties(RAW) on that client while raw was wanted
  bool wantRaw = false;
  uint32_t bufferFrames = 0;
  uint32_t lastLowLatency = 0;
  int64_t lastExclusiveHns = 0;
  int64_t lastSharedHns = -1;
  StreamFormat lastFormat;
  std::vector<std::string> calls;

  static int32_t pop(std::deque<int32_t>& q) {
    if (q.empty()) return kS_OK;
    const int32_t r = q.front();
    q.pop_front();
    return r;
  }
  bool initAllowed() {
    if (initsOnClient++ > 0) return false;  // a real client cannot be initialized twice
    if (wantRaw && !rawOnClient) rawMissing = true;
    return true;
  }

  int32_t activate() override {
    activations++;
    initsOnClient = 0;
    rawOnClient = false;
    calls.push_back("activate");
    return kS_OK;
  }
  void release() override { calls.push_back("release"); }
  int32_t getMixFormat(StreamFormat& out) override {
    out = mix;
    return kS_OK;
  }
  int32_t getDeviceFormat(StreamFormat& out) override {
    if (!haveDeviceFormat) return kE_NOTFOUND;
    out = deviceFormat;
    return kS_OK;
  }
  int32_t getDevicePeriod(int64_t& d, int64_t& m) override {
    d = defHns;
    m = minHns;
    return kS_OK;
  }
  bool hasClient3() override { return client3; }
  int32_t getSharedModeEnginePeriod(const StreamFormat&, uint32_t& d, uint32_t& f, uint32_t& mn, uint32_t& mx) override {
    if (!client3) return kE_NOINTERFACE;
    d = d3;
    f = f3;
    mn = mn3;
    mx = mx3;
    return kS_OK;
  }
  int32_t getCurrentSharedModeEnginePeriod(uint32_t& p) override {
    p = currentPeriod;
    return kS_OK;
  }
  bool rawSupported() override { return rawOk; }
  int32_t setRawOption(bool on) override {
    rawCalls++;
    rawOnClient = on;
    calls.push_back("setRaw");
    return kS_OK;
  }
  int32_t isExclusiveFormatSupported(const StreamFormat& f) override {
    return std::find(exclusiveOk.begin(), exclusiveOk.end(), f) != exclusiveOk.end() ? kS_OK : kAudclntUnsupportedFormat;
  }
  int32_t initShared(const StreamFormat& f, int64_t bufferHns) override {
    calls.push_back("initShared");
    if (!initAllowed()) return kAlreadyInitialized;
    lastSharedHns = bufferHns;
    lastFormat = f;
    const int32_t r = pop(sharedInit);
    if (r >= 0) bufferFrames = 1056;
    return r;
  }
  int32_t initSharedLowLatency(const StreamFormat& f, uint32_t p) override {
    calls.push_back("initLowLatency " + std::to_string(p));
    if (!initAllowed()) return kAlreadyInitialized;
    lastLowLatency = p;
    lastFormat = f;
    const int32_t r = pop(lowLatencyInit);
    if (r >= 0) bufferFrames = 2 * p;
    return r;
  }
  int32_t initExclusive(const StreamFormat& f, int64_t p) override {
    calls.push_back("initExclusive " + std::string(sampleFormatName(f.format)) + " " + std::to_string(f.sampleRate) + " " +
                    std::to_string(f.channels) + " " + std::to_string(p));
    if (!initAllowed()) return kAlreadyInitialized;
    lastExclusiveHns = p;
    lastFormat = f;
    const int32_t r = pop(exclusiveInit);
    if (r == kAudclntBufferSizeNotAligned) bufferFrames = alignedFrames;
    if (r >= 0) bufferFrames = static_cast<uint32_t>(hnsToFrames(p, f.sampleRate));
    return r;
  }
  int32_t getBufferSize(uint32_t& frames) override {
    frames = bufferFrames;
    return kS_OK;
  }
  int32_t getStreamLatency(int64_t& hns) override {
    hns = 15000;  // 1.5 ms
    return kS_OK;
  }
  int count(const std::string& prefix) const {
    return static_cast<int>(std::count_if(calls.begin(), calls.end(), [&](const std::string& c) { return c.rfind(prefix, 0) == 0; }));
  }
};

NegotiateRequest req(OutputMode m) {
  NegotiateRequest r;
  r.mode = m;
  return r;
}

}  // namespace

OM_TEST(negotiate_lowlatency_period_policy) {
  // SPEC.md §8.2: smallest multiple of the fundamental >= 5 ms, never the minimum.
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 0, 480, 48, 48, 480) == 240);   // 1 ms fundamental -> 5 ms
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 0, 480, 128, 128, 480) == 256); // 128 fundamental -> 256
  OM_CHECK(lowLatencyPeriodFrames(44100, 5.0, 0, 441, 44, 44, 441) == 264);   // 221 needed -> 6 x 44
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 0, 480, 48, 144, 480) == 240);  // minimum 3 ms: 144 + 2 x 48
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 0, 480, 480, 480, 480) == 0);   // nothing below the default
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 0, 240, 48, 48, 240) == 0);     // the 5 ms period IS the default
  OM_CHECK(lowLatencyPeriodFrames(48000, 3.0, 0, 480, 48, 48, 480) == 144);   // another floor
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 100, 480, 48, 48, 480) == 144); // override rounded up to a valid period
  OM_CHECK(lowLatencyPeriodFrames(48000, 5.0, 4000, 480, 48, 48, 480) == 480);// override above the max: the max
  OM_CHECK(validSharedPeriodAtLeast(10, 48, 48, 480) == 48);
  OM_CHECK(validSharedPeriodAtLeast(481, 48, 48, 480) == 0);
}

OM_TEST(negotiate_lowlatency_ok_and_step_bounds) {
  FakeClient c;
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::SharedLowLatency), r));
  OM_CHECK(r.mode == DeviceMode::SharedLowLatency && !r.fellBack);
  OM_CHECK(r.periodFrames == 240 && c.lastLowLatency == 240);
  OM_CHECK(r.stepFrames == 48 && r.maxStepFrames == 480 && r.fundamentalFrames == 48 && r.defaultPeriodFrames == 480);
  OM_CHECK(r.format == c.mix && r.bufferFrames == 480);
  OM_CHECK_NEAR(r.streamLatencyMs, 1.5, 1e-9);
}

OM_TEST(negotiate_glitch_step_up) {
  PeriodStepper s;
  s.reset(240, 48, 480);
  OM_CHECK(!s.onGlitch(0.0) && !s.onGlitch(4.0));
  OM_CHECK(s.onGlitch(9.5));  // 3 glitches within 10 s
  OM_CHECK(s.nextFrames() == 288);
  s.reset(288, 48, 480);
  OM_CHECK(!s.onGlitch(20.0) && !s.onGlitch(26.0) && !s.onGlitch(31.0));  // spread over 11 s: no step
  OM_CHECK(s.onGlitch(33.0));  // 26, 31, 33: within 10 s
  s.reset(480, 48, 480);       // at the default period: no more steps
  OM_CHECK(!s.onGlitch(1) && !s.onGlitch(2) && !s.onGlitch(3) && !s.canStep());
  s.reset(240, 0, 480);        // the period belongs to another client / an override: never
  OM_CHECK(!s.onGlitch(1) && !s.onGlitch(1.1) && !s.onGlitch(1.2));
  // The reopen after a step: the override rounds to a valid period of the same mode.
  FakeClient c;
  NegotiateRequest q = req(OutputMode::SharedLowLatency);
  q.periodFrames = 288;
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, q, r) && r.mode == DeviceMode::SharedLowLatency && c.lastLowLatency == 288);
}

OM_TEST(negotiate_lowlatency_unavailable_falls_back_to_shared) {
  {
    FakeClient c;
    c.client3 = false;  // no IAudioClient3
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, req(OutputMode::SharedLowLatency), r));
    OM_CHECK(r.mode == DeviceMode::Shared && r.fellBack && r.fallbackReason == "unsupported");
    OM_CHECK(c.lastSharedHns == 0);  // the minimum buffer, like Chromium
  }
  {
    FakeClient c;
    c.mn3 = c.f3 = 480;  // the driver offers nothing below 10 ms
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, req(OutputMode::SharedLowLatency), r));
    OM_CHECK(r.mode == DeviceMode::Shared && r.fallbackReason == "unsupported" && c.count("initLowLatency") == 0);
  }
}

OM_TEST(negotiate_periodicity_locked) {
  {
    // Another client locked the engine at 6 ms (>= 5 ms): that period is used.
    FakeClient c;
    c.lowLatencyInit = {kAudclntEnginePeriodicityLocked};
    c.currentPeriod = 288;
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, req(OutputMode::SharedLowLatency), r));
    OM_CHECK(r.mode == DeviceMode::SharedLowLatency && r.periodFrames == 288 && !r.fellBack);
    OM_CHECK(r.stepFrames == 0);  // not ours to step
    OM_CHECK(c.count("initLowLatency") == 2 && c.activations == 2);  // a fresh client for the second Initialize
  }
  {
    // Locked below 5 ms (128 frames = 2.7 ms): plain shared.
    FakeClient c;
    c.lowLatencyInit = {kAudclntEnginePeriodicityLocked};
    c.currentPeriod = 128;
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, req(OutputMode::SharedLowLatency), r));
    OM_CHECK(r.mode == DeviceMode::Shared && r.fellBack && r.fallbackReason == "periodicity-locked");
    OM_CHECK(r.periodFrames == 128);  // shared streams then run at the engine's current period
  }
}

OM_TEST(negotiate_device_invalidated_is_a_loss) {
  for (int mode = 0; mode < 3; mode++) {
    FakeClient c;
    c.exclusiveOk = {c.mix};
    c.exclusiveInit = {kAudclntDeviceInvalidated};
    c.lowLatencyInit = {kAudclntDeviceInvalidated};
    c.sharedInit = {kAudclntDeviceInvalidated};
    NegotiateResult r;
    OM_CHECK(!negotiateStream(c, req(static_cast<OutputMode>(mode)), r));
    OM_CHECK(r.lost);
    OM_CHECK(r.error.find("AUDCLNT_E_DEVICE_INVALIDATED") != std::string::npos);
  }
}

OM_TEST(negotiate_exclusive_first_candidate) {
  FakeClient c;
  c.exclusiveOk = {StreamFormat{48000, 2, 0x3, SampleFormat::F32}};
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r));
  OM_CHECK(r.mode == DeviceMode::Exclusive && !r.fellBack);
  OM_CHECK(r.format.format == SampleFormat::F32 && r.format.sampleRate == 48000 && r.format.channels == 2);
  OM_CHECK(c.lastExclusiveHns == 30000 && r.periodFrames == 144);  // the device minimum ("smallest stable")
  OM_CHECK(r.stepFrames == 144 && r.maxStepFrames == 480);
}

OM_TEST(negotiate_exclusive_format_chain) {
  // f32 -> s32 -> s24-in-32 -> s24 packed -> s16, TPDF for the integer ones (formats.cpp).
  FakeClient c;
  c.exclusiveOk = {StreamFormat{48000, 2, 0x3, SampleFormat::S24in32}};
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r));
  OM_CHECK(r.mode == DeviceMode::Exclusive && r.format.format == SampleFormat::S24in32);
  // The trace shows the refused candidates in order before the accepted one.
  std::string t;
  for (const std::string& s : r.trace) t += s + "\n";
  const size_t a = t.find("48000/2ch/f32 not supported"), b = t.find("48000/2ch/s32 not supported"),
               d = t.find("initExclusive 48000/2ch/s24");
  OM_CHECK(a != std::string::npos && b != std::string::npos && d != std::string::npos && a < b && b < d);
  c = FakeClient();
  c.exclusiveOk = {StreamFormat{48000, 2, 0x3, SampleFormat::S16}};
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r) && r.format.format == SampleFormat::S16);
  c = FakeClient();
  c.exclusiveOk = {StreamFormat{48000, 2, 0x3, SampleFormat::S24}};
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r) && r.format.format == SampleFormat::S24);
}

OM_TEST(negotiate_exclusive_rates_and_channel_layouts) {
  // Requested rate first, then the mix rate; the mix layout first, then
  // PKEY_AudioEngine_DeviceFormat's (a 4-channel controller in quad).
  FakeClient c;
  c.haveDeviceFormat = true;
  c.deviceFormat = StreamFormat{48000, 4, 0x33, SampleFormat::S24};
  c.exclusiveOk = {StreamFormat{48000, 4, 0x33, SampleFormat::S16}};
  NegotiateRequest q = req(OutputMode::Exclusive);
  q.sampleRate = 44100;
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, q, r));
  OM_CHECK(r.mode == DeviceMode::Exclusive && r.format.sampleRate == 48000 && r.format.channels == 4 &&
           r.format.channelMask == 0x33 && r.format.format == SampleFormat::S16);
  std::string t;
  for (const std::string& s : r.trace) t += s + "\n";
  const size_t a = t.find("44100/2ch/f32"), b = t.find("44100/4ch/s16"), d = t.find("48000/2ch/f32"),
               e = t.find("initExclusive 48000/4ch/s16");
  OM_CHECK(a != std::string::npos && b != std::string::npos && d != std::string::npos && e != std::string::npos);
  OM_CHECK(a < b && b < d && d < e);
  // A requested rate that the device accepts wins over the mix rate.
  c = FakeClient();
  c.exclusiveOk = {StreamFormat{44100, 2, 0x3, SampleFormat::F32}, StreamFormat{48000, 2, 0x3, SampleFormat::F32}};
  OM_CHECK(negotiateStream(c, q, r) && r.format.sampleRate == 44100);
}

OM_TEST(negotiate_exclusive_unsupported_format_from_initialize) {
  // IsFormatSupported said yes but Initialize refuses: next candidate, on a fresh client.
  FakeClient c;
  c.exclusiveOk = {StreamFormat{48000, 2, 0x3, SampleFormat::F32}, StreamFormat{48000, 2, 0x3, SampleFormat::S32}};
  c.exclusiveInit = {kAudclntUnsupportedFormat};
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r));
  OM_CHECK(r.mode == DeviceMode::Exclusive && r.format.format == SampleFormat::S32);
  OM_CHECK(c.count("initExclusive") == 2 && c.activations == 2);
}

OM_TEST(negotiate_exclusive_buffer_size_not_aligned) {
  // Documented sequence: GetBufferSize, aligned period, new client, Initialize again.
  FakeClient c;
  c.exclusiveOk = {c.mix};
  c.exclusiveInit = {kAudclntBufferSizeNotAligned};
  c.alignedFrames = 160;
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r));
  OM_CHECK(r.mode == DeviceMode::Exclusive);
  const int64_t aligned = static_cast<int64_t>(10000.0 * 1000 / 48000 * 160 + 0.5);  // 33333 hns
  OM_CHECK(c.lastExclusiveHns == aligned && r.periodHns == aligned && r.periodFrames == 160);
  OM_CHECK(c.count("initExclusive") == 2 && c.activations == 2);
}

OM_TEST(negotiate_exclusive_refusals_fall_back_with_reasons) {
  struct Case {
    int32_t hr;
    const char* reason;
  };
  const Case cases[] = {{kAudclntDeviceInUse, "in-use"}, {kAudclntExclusiveModeNotAllowed, "not-allowed"}};
  for (const Case& k : cases) {
    FakeClient c;
    c.exclusiveOk = {c.mix};
    c.exclusiveInit = {k.hr};
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r));
    OM_CHECK(r.mode == DeviceMode::SharedLowLatency && r.fellBack && r.fallbackReason == k.reason);
    OM_CHECK(c.count("initExclusive") == 1);  // no other candidate is tried
    // ... and on to plain shared when low latency is refused too: the first reason is kept.
    FakeClient s;
    s.exclusiveOk = {s.mix};
    s.exclusiveInit = {k.hr};
    s.client3 = false;
    OM_CHECK(negotiateStream(s, req(OutputMode::Exclusive), r));
    OM_CHECK(r.mode == DeviceMode::Shared && r.fellBack && r.fallbackReason == k.reason);
  }
  // Every candidate refused: "format".
  FakeClient c;
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::Exclusive), r));
  OM_CHECK(r.mode == DeviceMode::SharedLowLatency && r.fellBack && r.fallbackReason == "format");
  OM_CHECK(c.count("initExclusive") == 0);
}

OM_TEST(negotiate_shared_refused_when_another_app_is_exclusive) {
  FakeClient c;
  c.sharedInit = {kAudclntDeviceInUse};
  NegotiateResult r;
  OM_CHECK(!negotiateStream(c, req(OutputMode::Shared), r));
  OM_CHECK(!r.lost && r.hr == kAudclntDeviceInUse && r.error.find("in-use") != std::string::npos);
}

OM_TEST(negotiate_shared_default) {
  FakeClient c;
  c.currentPeriod = 480;
  NegotiateResult r;
  OM_CHECK(negotiateStream(c, req(OutputMode::Shared), r));
  OM_CHECK(r.mode == DeviceMode::Shared && !r.fellBack && r.periodFrames == 480 && r.bufferFrames == 1056);
  OM_CHECK(c.lastSharedHns == 0 && r.stepFrames == 0);
}

OM_TEST(negotiate_raw_stream_option) {
  {
    // Supported: SetClientProperties(RAW) on EVERY client before its Initialize.
    FakeClient c;
    c.rawOk = true;
    c.wantRaw = true;
    c.exclusiveOk = {c.mix};
    c.exclusiveInit = {kAudclntBufferSizeNotAligned};
    c.alignedFrames = 160;
    NegotiateRequest q = req(OutputMode::Exclusive);
    q.raw = true;
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, q, r));
    OM_CHECK(r.raw && !c.rawMissing && c.rawCalls == 2);
    c = FakeClient();
    c.rawOk = true;
    c.wantRaw = true;
    c.lowLatencyInit = {kAudclntEnginePeriodicityLocked};
    c.currentPeriod = 288;
    q.mode = OutputMode::SharedLowLatency;
    OM_CHECK(negotiateStream(c, q, r) && r.raw && !c.rawMissing && c.rawCalls == 2);
  }
  {
    // Not supported by the endpoint: never set, the stream opens normally.
    FakeClient c;
    NegotiateRequest q = req(OutputMode::Shared);
    q.raw = true;
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, q, r));
    OM_CHECK(!r.raw && c.rawCalls == 0 && r.mode == DeviceMode::Shared);
  }
  {
    // Not requested: never set.
    FakeClient c;
    c.rawOk = true;
    NegotiateResult r;
    OM_CHECK(negotiateStream(c, req(OutputMode::Shared), r) && !r.raw && c.rawCalls == 0);
  }
}

OM_TEST(negotiate_hresult_names) {
  OM_CHECK(std::string(hresultName(kAudclntEnginePeriodicityLocked)) == "AUDCLNT_E_ENGINE_PERIODICITY_LOCKED");
  OM_CHECK(std::string(hresultName(kAudclntBufferSizeNotAligned)) == "AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED");
  char b[16];
  OM_CHECK(std::string(hresultName(hr32(0x80001234u), b, sizeof(b))) == "0x80001234");
  OM_CHECK(hrMeansLost(kAudclntDeviceInvalidated) && !hrMeansLost(kAudclntDeviceInUse));
  OM_CHECK(framesToHns(480, 48000) == 100000 && hnsToFrames(100000, 48000) == 480);
}
