// WASAPI output device, Windows (owner: device, library om_device_wasapi):
//  - ComClientOps: the IAudioClientOps seam of negotiate.h over the real
//    IAudioClient / IAudioClient2 / IAudioClient3 of one endpoint, so the
//    open sequence (modes, fallbacks, period policy, exclusive negotiation,
//    documented HRESULT retries, raw stream) is the portable, tested one;
//  - WasapiDevice: opened on the core's ops thread (COM MTA; nothing here
//    ever runs on the host JS thread); event-driven render thread (MMCSS
//    "Pro Audio" HIGH, power throttling off, FTZ/DAZ, rt::Scope around the
//    per-event work: no allocation, no lock, no I/O); presentTime from
//    IAudioClock::GetPosition and its QPC stamp, filtered by a DLL (never
//    the wake-up time), with jitter statistics; glitches (shared-mode
//    underruns, late exclusive events, clock jumps) counted, and after 3 in
//    10 s the period steps up (low-latency / exclusive) on the device's
//    watch thread, reported as a PeriodStep event; AUDCLNT_E_DEVICE_INVALIDATED
//    reported as Lost (posted from the watch thread, never the audio thread);
//    float32 from the core converted to the stream format (TPDF dither for
//    16 / 24 bits) or written in place when the stream is float32.
// status() never blocks (a short copy under a status mutex + atomics).
// SPEC.md §8.2-§8.4, §8.8.
#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#include "../endpoints.h"
#include "../formats.h"
#include "../negotiate.h"
#include "../timing.h"
#include "com_util.h"
#include "om/device.h"
#include "om/dsp.h"
#include "om/rt.h"

namespace om {

namespace {

using dev::win::ComPtr;

// The portable policy uses the SDK's HRESULT values.
static_assert(dev::kAudclntDeviceInvalidated == AUDCLNT_E_DEVICE_INVALIDATED, "HRESULT mismatch");
static_assert(dev::kAudclntUnsupportedFormat == AUDCLNT_E_UNSUPPORTED_FORMAT, "HRESULT mismatch");
static_assert(dev::kAudclntDeviceInUse == AUDCLNT_E_DEVICE_IN_USE, "HRESULT mismatch");
static_assert(dev::kAudclntExclusiveModeNotAllowed == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, "HRESULT mismatch");
static_assert(dev::kAudclntBufferSizeNotAligned == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, "HRESULT mismatch");
static_assert(dev::kAudclntInvalidDevicePeriod == AUDCLNT_E_INVALID_DEVICE_PERIOD, "HRESULT mismatch");
static_assert(dev::kAudclntResourcesInvalidated == AUDCLNT_E_RESOURCES_INVALIDATED, "HRESULT mismatch");
static_assert(dev::kAudclntRawModeUnsupported == AUDCLNT_E_RAW_MODE_UNSUPPORTED, "HRESULT mismatch");
static_assert(dev::kAudclntEnginePeriodicityLocked == AUDCLNT_E_ENGINE_PERIODICITY_LOCKED, "HRESULT mismatch");
static_assert(dev::kAudclntServiceNotRunning == AUDCLNT_E_SERVICE_NOT_RUNNING, "HRESULT mismatch");
static_assert(dev::kE_NOTFOUND == static_cast<int32_t>(HRESULT_FROM_WIN32(ERROR_NOT_FOUND)), "HRESULT mismatch");
static_assert(dev::kE_INVALIDARG == E_INVALIDARG && dev::kE_NOTIMPL == E_NOTIMPL && dev::kE_FAIL == E_FAIL, "HRESULT mismatch");

constexpr int32_t kNotInitialized = static_cast<int32_t>(AUDCLNT_E_NOT_INITIALIZED);

// ---------------------------------------------------------------------------
// The real client behind the portable negotiation
// ---------------------------------------------------------------------------
class ComClientOps final : public dev::IAudioClientOps {
 public:
  explicit ComClientOps(ComPtr<IMMDevice> d) : dev_(std::move(d)) {}
  ~ComClientOps() override {
    release();
    if (mix_) CoTaskMemFree(mix_);
  }
  int32_t activate() override {
    release();
    HRESULT hr = dev_->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(c3_.GetAddressOf()));
    if (SUCCEEDED(hr) && c3_) {
      client_ = c3_;
    } else {
      c3_.Reset();
      hr = dev_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client_.GetAddressOf()));
      if (FAILED(hr)) return hr;
    }
    client_.As(&c2_);
    return S_OK;
  }
  void release() override {
    c3_.Reset();
    c2_.Reset();
    client_.Reset();
  }
  int32_t getMixFormat(dev::StreamFormat& out) override {
    if (!client_) return kNotInitialized;
    WAVEFORMATEX* wf = nullptr;
    const HRESULT hr = client_->GetMixFormat(&wf);
    if (FAILED(hr) || !wf) return FAILED(hr) ? hr : E_FAIL;
    if (mix_) CoTaskMemFree(mix_);
    mix_ = wf;  // the exact mix format is what shared mode gets
    if (!dev::win::fromWaveFormat(wf, out)) return AUDCLNT_E_UNSUPPORTED_FORMAT;
    mixFmt_ = out;
    return S_OK;
  }
  int32_t getDeviceFormat(dev::StreamFormat& out) override {
    return dev::win::readDeviceFormat(dev_.Get(), out) ? S_OK : HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  }
  int32_t getDevicePeriod(int64_t& defaultHns, int64_t& minHns) override {
    if (!client_) return kNotInitialized;
    REFERENCE_TIME d = 0, m = 0;
    const HRESULT hr = client_->GetDevicePeriod(&d, &m);
    defaultHns = d;
    minHns = m;
    return hr;
  }
  bool hasClient3() override { return c3_ != nullptr; }
  int32_t getSharedModeEnginePeriod(const dev::StreamFormat& f, uint32_t& def, uint32_t& fund, uint32_t& mn,
                                    uint32_t& mx) override {
    if (!c3_) return E_NOINTERFACE;
    UINT32 a = 0, b = 0, c = 0, e = 0;
    const HRESULT hr = c3_->GetSharedModeEnginePeriod(formatFor(f), &a, &b, &c, &e);
    def = a;
    fund = b;
    mn = c;
    mx = e;
    return hr;
  }
  int32_t getCurrentSharedModeEnginePeriod(uint32_t& periodFrames) override {
    if (!c3_) return E_NOINTERFACE;
    WAVEFORMATEX* wf = nullptr;
    UINT32 cur = 0;
    const HRESULT hr = c3_->GetCurrentSharedModeEnginePeriod(&wf, &cur);
    if (wf) CoTaskMemFree(wf);
    periodFrames = cur;
    return hr;
  }
  bool rawSupported() override { return c2_ != nullptr && dev::win::readRawSupported(dev_.Get()); }
  int32_t setRawOption(bool on) override {
    if (!c2_) return E_NOINTERFACE;
    AudioClientProperties p{};
    p.cbSize = sizeof(p);
    p.bIsOffload = FALSE;
    p.eCategory = AudioCategory_Other;
    p.Options = on ? AUDCLNT_STREAMOPTIONS_RAW : AUDCLNT_STREAMOPTIONS_NONE;
    return c2_->SetClientProperties(&p);
  }
  int32_t isExclusiveFormatSupported(const dev::StreamFormat& f) override {
    if (!client_) return kNotInitialized;
    WAVEFORMATEXTENSIBLE w = dev::win::toWaveFormat(f);
    return client_->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &w.Format, nullptr);
  }
  int32_t initShared(const dev::StreamFormat& f, int64_t bufferHns) override {
    if (!client_) return kNotInitialized;
    return client_->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST,
                               bufferHns, 0, formatFor(f), nullptr);
  }
  int32_t initSharedLowLatency(const dev::StreamFormat& f, uint32_t periodFrames) override {
    if (!c3_) return E_NOINTERFACE;
    return c3_->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, periodFrames, formatFor(f), nullptr);
  }
  int32_t initExclusive(const dev::StreamFormat& f, int64_t periodHns) override {
    if (!client_) return kNotInitialized;
    WAVEFORMATEXTENSIBLE w = dev::win::toWaveFormat(f);
    return client_->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, periodHns, periodHns, &w.Format,
                               nullptr);
  }
  int32_t getBufferSize(uint32_t& frames) override {
    if (!client_) return kNotInitialized;
    UINT32 n = 0;
    const HRESULT hr = client_->GetBufferSize(&n);
    frames = n;
    return hr;
  }
  int32_t getStreamLatency(int64_t& hns) override {
    if (!client_) return kNotInitialized;
    REFERENCE_TIME l = 0;
    const HRESULT hr = client_->GetStreamLatency(&l);
    hns = l;
    return hr;
  }
  IAudioClient* client() const noexcept { return client_.Get(); }

 private:
  const WAVEFORMATEX* formatFor(const dev::StreamFormat& f) {
    if (mix_ && f == mixFmt_) return mix_;
    tmp_ = dev::win::toWaveFormat(f);
    return &tmp_.Format;
  }
  ComPtr<IMMDevice> dev_;
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioClient2> c2_;
  ComPtr<IAudioClient3> c3_;
  WAVEFORMATEX* mix_ = nullptr;
  dev::StreamFormat mixFmt_;
  WAVEFORMATEXTENSIBLE tmp_{};
};

// ---------------------------------------------------------------------------
// The device
// ---------------------------------------------------------------------------
class WasapiDevice final : public AudioDevice {
 public:
  WasapiDevice() {
    renderEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    wakeEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    exitEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  }
  ~WasapiDevice() override {
    close();
    for (HANDLE h : {renderEvent_, stopEvent_, wakeEvent_, exitEvent_})
      if (h) CloseHandle(h);
  }

  bool open(const DeviceConfig& cfg, IRenderCallback* cb, std::string* err) override {
    close();
    std::lock_guard<std::mutex> lk(ctlM_);
    dev::win::ComScope com;
    if (!cb) {
      if (err) *err = "no render callback";
      return false;
    }
    if (!renderEvent_ || !stopEvent_ || !wakeEvent_ || !exitEvent_) {
      if (err) *err = "cannot create events";
      return false;
    }
    ComPtr<IMMDeviceEnumerator> en;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  reinterpret_cast<void**>(en.GetAddressOf()));
    if (FAILED(hr) || !en) {
      if (err) *err = "IMMDeviceEnumerator unavailable: " + dev::win::hrText(hr);
      return false;
    }
    ComPtr<IMMDevice> d;
    if (!cfg.id.empty()) {
      // An exact id (the supervisor resolved it): that endpoint or nothing —
      // never another one by fallback.
      hr = en->GetDevice(dev::win::utf16(cfg.id).c_str(), &d);
      if (FAILED(hr) || !d || dev::win::deviceState(d.Get()) != DEVICE_STATE_ACTIVE) {
        if (err) *err = "the output device is not available";
        lost_ = true;
        return false;
      }
    } else {
      std::string e;
      const std::vector<DeviceInfo> list = enumerateOutputDevices(&e);
      const std::string id = resolveOutputDevice(cfg, list);
      if (id.empty()) {
        if (err) *err = e.empty() ? "no output device" : e;
        return false;
      }
      hr = en->GetDevice(dev::win::utf16(id).c_str(), &d);
      if (FAILED(hr) || !d) {
        if (err) *err = "IMMDeviceEnumerator::GetDevice failed: " + dev::win::hrText(hr);
        return false;
      }
    }
    dev_ = d;
    id_ = dev::win::deviceId(d.Get());
    std::string friendly, model;
    dev::win::readChromiumLabel(d.Get(), en.Get(), name_, friendly, model);
    ops_ = std::make_unique<ComClientOps>(d);
    qpcOffset_ = dev::win::engineClockOffset();
    cfg_ = cfg;
    cb_ = cb;
    lost_ = false;
    lostPending_ = false;
    stepRequest_ = 0;
    periodSteps_ = 0;
    glitches_ = 0;
    callbacks_ = 0;
    if (!openStreamLocked(cfg_.mode, 0, err)) {
      lost_ = neg_.lost;
      ops_.reset();
      dev_.Reset();
      return false;
    }
    origStep_ = neg_.stepFrames;
    origMax_ = neg_.maxStepFrames;
    stepper_.reset(neg_.periodFrames, origStep_, origMax_);
    opened_ = true;
    ResetEvent(exitEvent_);
    closing_ = false;
    watchThread_ = std::thread([this] { watchLoop(); });
    return true;
  }

  bool start(std::string* err) override {
    std::lock_guard<std::mutex> lk(ctlM_);
    if (!opened_) {
      if (err) *err = "device not open";
      return false;
    }
    if (started_) return true;
    return startLocked(err);
  }

  void stop() override {
    std::lock_guard<std::mutex> lk(ctlM_);
    stopLocked();
  }

  void close() override {
    // The watch thread first, without the lock (it may be waiting for it to step the period up).
    closing_ = true;
    if (exitEvent_) SetEvent(exitEvent_);
    if (watchThread_.joinable()) watchThread_.join();
    std::lock_guard<std::mutex> lk(ctlM_);
    dev::win::ComScope com;
    stopLocked();
    releaseStreamLocked();
    ops_.reset();
    dev_.Reset();
    opened_ = false;
    {
      std::lock_guard<std::mutex> sl(statusM_);
      static_.mode = DeviceMode::Closed;
    }
  }

  DeviceStatus status() const override {
    DeviceStatus s;
    {
      std::lock_guard<std::mutex> lk(statusM_);
      s = static_;
    }
    s.running = running_.load(std::memory_order_relaxed);
    s.lost = lost_.load(std::memory_order_relaxed);
    s.glitches = glitches_.load(std::memory_order_relaxed);
    s.callbacks = callbacks_.load(std::memory_order_relaxed);
    s.periodSteps = periodSteps_.load(std::memory_order_relaxed);
    if (s.callbacks > 0) s.outputLatencyMs = latencyMs_.load(std::memory_order_relaxed);
    s.presentJitterMs = jitter_.windowP99Ms();
    s.rawJitterMs = rawJitter_.windowP99Ms();
    s.cpuUs = cpuUs_.load(std::memory_order_relaxed);
    return s;
  }

  void setEventHandler(DeviceEventFn fn) override {
    std::lock_guard<std::mutex> lk(evM_);
    onEvent_ = std::move(fn);
  }

 private:
  // Negotiates the stream on the open endpoint and gets its services (ctlM_ held).
  bool openStreamLocked(OutputMode mode, int periodOverride, std::string* err) {
    dev::NegotiateRequest req = dev::NegotiateRequest::from(cfg_);
    req.mode = mode;
    if (periodOverride > 0) req.periodFrames = periodOverride;
    if (!dev::negotiateStream(*ops_, req, neg_)) {
      if (err) *err = neg_.error.empty() ? "cannot open the stream" : neg_.error;
      return false;
    }
    IAudioClient* c = ops_->client();
    HRESULT hr = c->SetEventHandle(renderEvent_);
    if (SUCCEEDED(hr)) hr = c->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(render_.ReleaseAndGetAddressOf()));
    if (SUCCEEDED(hr)) hr = c->GetService(__uuidof(IAudioClock), reinterpret_cast<void**>(clock_.ReleaseAndGetAddressOf()));
    UINT64 freq = 0;
    if (SUCCEEDED(hr)) hr = clock_->GetFrequency(&freq);
    if (FAILED(hr)) {
      if (err) *err = "WASAPI services: " + dev::win::hrText(hr);
      neg_.lost = dev::hrMeansLost(hr);
      releaseStreamLocked();
      return false;
    }
    clockFreq_ = static_cast<double>(freq);
    client_ = c;
    rate_ = neg_.format.sampleRate;
    channels_ = neg_.format.channels;
    bufferFrames_ = static_cast<UINT32>(neg_.bufferFrames);
    exclusive_ = neg_.mode == DeviceMode::Exclusive;
    directF32_ = neg_.format.format == dev::SampleFormat::F32;
    scratch_.assign(static_cast<size_t>(bufferFrames_) * static_cast<size_t>(channels_), 0.0f);
    dither_.seed(0x2545F491u);
    {
      std::lock_guard<std::mutex> sl(statusM_);
      DeviceStatus& s = static_;
      s = DeviceStatus();
      s.mode = neg_.mode;
      s.id = id_;
      s.name = name_;
      s.sampleRate = rate_;
      s.channels = channels_;
      s.channelMask = neg_.format.channelMask;
      s.periodFrames = neg_.periodFrames;
      s.bufferFrames = neg_.bufferFrames;
      s.sampleFormat = dev::sampleFormatName(neg_.format.format);
      s.fellBack = neg_.fellBack;
      s.fallbackReason = neg_.fallbackReason;
      s.raw = neg_.raw;
      s.streamLatencyMs = neg_.streamLatencyMs;
      s.fundamentalFrames = neg_.fundamentalFrames;
      s.defaultPeriodFrames = neg_.defaultPeriodFrames;
      s.outputLatencyMs = rate_ > 0 ? 1000.0 * neg_.bufferFrames / rate_ + neg_.streamLatencyMs : 0;  // until measured
    }
    return true;
  }

  void releaseStreamLocked() {
    render_.Reset();
    clock_.Reset();
    client_ = nullptr;
    if (ops_) ops_->release();
  }

  bool startLocked(std::string* err) {
    dev::win::ComScope com;
    if (!client_) {
      if (err) *err = "no stream";
      return false;
    }
    // Pre-fill the whole buffer with silence, then start.
    BYTE* data = nullptr;
    written_ = 0;
    if (SUCCEEDED(render_->GetBuffer(bufferFrames_, &data))) {
      render_->ReleaseBuffer(bufferFrames_, AUDCLNT_BUFFERFLAGS_SILENT);
      written_ = bufferFrames_;
    }
    const double periodSec = neg_.periodFrames > 0 ? static_cast<double>(neg_.periodFrames) / rate_ : 0.01;
    pclock_.reset(rate_, 1.0, std::max(0.002, 0.75 * periodSec));
    jitter_.reset(1.0);
    rawJitter_.reset(1.0);
    svcCallbacks_ = 0;
    lastPresent_ = 0;
    lastFrames_ = 0;
    lastCb_ = 0;
    ResetEvent(stopEvent_);
    const HRESULT hr = client_->Start();
    if (FAILED(hr)) {
      if (err) *err = "IAudioClient::Start failed: " + dev::win::hrText(hr);
      if (dev::hrMeansLost(hr)) lost_ = true;
      return false;
    }
    running_ = true;
    started_ = true;
    renderThread_ = std::thread([this] { renderLoop(); });
    return true;
  }

  void stopLocked() {
    if (!started_) return;
    SetEvent(stopEvent_);
    if (renderThread_.joinable()) renderThread_.join();
    if (client_) {
      client_->Stop();
      client_->Reset();
    }
    running_ = false;
    started_ = false;
  }

  void signalLost() {
    lost_.store(true, std::memory_order_relaxed);
    lostPending_.store(true, std::memory_order_release);
    SetEvent(wakeEvent_);
  }

  // A failed WASAPI call on the audio thread: false = stop the loop (lost).
  bool callFailed(HRESULT hr) {
    if (hr == AUDCLNT_E_BUFFER_TOO_LARGE || hr == AUDCLNT_E_BUFFER_ERROR || hr == AUDCLNT_E_BUFFER_OPERATION_PENDING ||
        hr == AUDCLNT_E_OUT_OF_ORDER) {
      glitches_.fetch_add(1, std::memory_order_relaxed);
      return true;
    }
    signalLost();
    return false;
  }

  // One render event (audio thread). Real-time rules: no allocation, no
  // lock, no I/O; only WASAPI buffer calls.
  bool service() {
    rt::Scope rts;
    const EngineTime t0 = EngineClock::now();
    UINT32 pad = 0;
    if (!exclusive_) {
      const HRESULT hr = client_->GetCurrentPadding(&pad);
      if (FAILED(hr)) return callFailed(hr);
    }
    const UINT32 avail = exclusive_ ? bufferFrames_ : (bufferFrames_ > pad ? bufferFrames_ - pad : 0);
    if (avail == 0) return true;
    const double rate = static_cast<double>(rate_);
    bool glitch = false;
    if (!exclusive_ && pad == 0 && svcCallbacks_ > 2) glitch = true;  // the buffer ran dry: the engine played silence
    if (exclusive_ && lastCb_ > 0 && t0 - lastCb_ > 1.8 * bufferFrames_ / rate) glitch = true;  // a late event
    BYTE* data = nullptr;
    HRESULT hr = render_->GetBuffer(avail, &data);
    if (FAILED(hr)) return callFailed(hr);
    // Device clock: frame `written_` (the first one of this block) plays at
    // qpcTime(pos) + (written_ - pos) / rate.
    UINT64 pos = 0, qpc = 0;
    double raw;
    if (SUCCEEDED(clock_->GetPosition(&pos, &qpc)) && clockFreq_ > 0 && qpc != 0) {
      const double posFrames = static_cast<double>(pos) * rate / clockFreq_;
      raw = static_cast<double>(qpc) * 1e-7 - qpcOffset_ + (static_cast<double>(written_) - posFrames) / rate;
    } else {
      raw = t0 + static_cast<double>(pad) / rate + neg_.streamLatencyMs / 1000.0;
    }
    bool jumped = false;
    const double present = pclock_.update(written_, raw, &jumped);
    if (jumped) glitch = true;
    if (lastFrames_ > 0) jitter_.add(present - (lastPresent_ + lastFrames_ / rate), t0);
    if (pclock_.locked()) rawJitter_.add(raw - present, t0);
    // Render (at most kMaxBlockFrames per call), in place when the stream is float32.
    float* dst = directF32_ ? reinterpret_cast<float*>(data) : scratch_.data();
    const EngineTime r0 = EngineClock::now();
    for (UINT32 done = 0; done < avail;) {
      const int n = static_cast<int>(std::min<UINT32>(avail - done, static_cast<UINT32>(kMaxBlockFrames)));
      BlockClock clk;
      clk.frame = frameIndex_ + done;
      clk.frames = n;
      clk.sampleRate = rate;
      clk.callbackTime = t0 + done / rate;
      clk.presentTime = present + done / rate;
      cb_->render(dst + static_cast<size_t>(done) * channels_, n, channels_, clk);
      done += static_cast<UINT32>(n);
    }
    const EngineTime r1 = EngineClock::now();
    if (!directF32_)
      dev::convertFromFloat(scratch_.data(), data, static_cast<size_t>(avail) * channels_, neg_.format.format, dither_);
    hr = render_->ReleaseBuffer(avail, 0);
    if (FAILED(hr)) return callFailed(hr);
    written_ += avail;
    frameIndex_ += avail;
    svcCallbacks_++;
    callbacks_.store(svcCallbacks_, std::memory_order_relaxed);
    const double lat = (present - t0) * 1000.0;
    const double prevLat = latencyMs_.load(std::memory_order_relaxed);
    latencyMs_.store(svcCallbacks_ == 1 ? lat : prevLat + 0.05 * (lat - prevLat), std::memory_order_relaxed);
    const double cpu = ((EngineClock::now() - t0) - (r1 - r0)) * 1e6;
    const double prevCpu = cpuUs_.load(std::memory_order_relaxed);
    cpuUs_.store(svcCallbacks_ == 1 ? cpu : prevCpu + 0.05 * (cpu - prevCpu), std::memory_order_relaxed);
    lastPresent_ = present;
    lastFrames_ = static_cast<int>(avail);
    lastCb_ = t0;
    if (glitch) {
      glitches_.fetch_add(1, std::memory_order_relaxed);
      if (stepper_.onGlitch(t0)) {
        stepRequest_.store(stepper_.nextFrames(), std::memory_order_release);
        SetEvent(wakeEvent_);
      }
    }
    return true;
  }

  void renderLoop() {
    dev::win::ComScope com;
    void* mm = promoteAudioThread("Pro Audio", nullptr);
    dsp::flushDenormals();
    HANDLE waits[2] = {stopEvent_, renderEvent_};
    const double bufSec = rate_ > 0 ? static_cast<double>(bufferFrames_) / rate_ : 0.02;
    const DWORD timeoutMs = static_cast<DWORD>(std::max(200.0, 4000.0 * bufSec));
    for (;;) {
      const DWORD w = WaitForMultipleObjects(2, waits, FALSE, timeoutMs);
      if (w == WAIT_OBJECT_0) break;
      if (w == WAIT_TIMEOUT) {
        // No event for a long time: is the device still there?
        UINT32 pad = 0;
        const HRESULT hr = client_->GetCurrentPadding(&pad);
        if (FAILED(hr) && dev::hrMeansLost(hr)) {
          signalLost();
          break;
        }
        glitches_.fetch_add(1, std::memory_order_relaxed);
        continue;
      }
      if (w != WAIT_OBJECT_0 + 1) break;
      if (!service()) break;
    }
    running_ = false;
    demoteAudioThread(mm);
  }

  void emit(const DeviceEventInfo& ev) {
    std::lock_guard<std::mutex> lk(evM_);
    if (onEvent_) onEvent_(ev);
  }

  // The device's own non-real-time thread: reports a loss the render thread
  // saw, and steps the period up when asked to.
  void watchLoop() {
    dev::win::ComScope com;
    HANDLE h[2] = {exitEvent_, wakeEvent_};
    for (;;) {
      const DWORD w = WaitForMultipleObjects(2, h, FALSE, INFINITE);
      if (w != WAIT_OBJECT_0 + 1) break;
      if (lostPending_.exchange(false, std::memory_order_acq_rel)) {
        DeviceEventInfo ev;
        ev.event = DeviceEvent::Lost;
        ev.id = id_;
        emit(ev);
      }
      const int step = stepRequest_.exchange(0, std::memory_order_acq_rel);
      if (step > 0 && !closing_.load()) stepUp(step);
    }
  }

  void stepUp(int periodFrames) {
    std::unique_lock<std::mutex> lk(ctlM_);
    if (closing_.load() || !opened_ || !started_ || lost_.load()) return;
    const OutputMode mode = neg_.mode == DeviceMode::Exclusive ? OutputMode::Exclusive : OutputMode::SharedLowLatency;
    stopLocked();
    releaseStreamLocked();
    std::string err;
    if (!openStreamLocked(mode, periodFrames, &err) || !startLocked(&err)) {
      lost_ = true;
      lk.unlock();
      DeviceEventInfo ev;
      ev.event = DeviceEvent::Lost;
      ev.id = id_;
      emit(ev);
      return;
    }
    stepper_.reset(neg_.periodFrames, origStep_, origMax_);
    periodSteps_.fetch_add(1, std::memory_order_relaxed);
    const int p = neg_.periodFrames;
    lk.unlock();
    DeviceEventInfo ev;
    ev.event = DeviceEvent::PeriodStep;
    ev.id = id_;
    ev.periodFrames = p;
    emit(ev);
  }

  // ---- control (ops thread / watch thread), guarded by ctlM_ ----
  std::mutex ctlM_;
  DeviceConfig cfg_;
  IRenderCallback* cb_ = nullptr;
  ComPtr<IMMDevice> dev_;
  std::string id_, name_;
  std::unique_ptr<ComClientOps> ops_;
  ComPtr<IAudioRenderClient> render_;
  ComPtr<IAudioClock> clock_;
  IAudioClient* client_ = nullptr;
  dev::NegotiateResult neg_;
  int origStep_ = 0, origMax_ = 0;
  bool opened_ = false, started_ = false;
  std::atomic<bool> closing_{false};
  HANDLE renderEvent_ = nullptr, stopEvent_ = nullptr, wakeEvent_ = nullptr, exitEvent_ = nullptr;
  std::thread renderThread_, watchThread_;
  std::mutex evM_;
  DeviceEventFn onEvent_;
  // ---- stream constants (set before the render thread starts) ----
  double clockFreq_ = 0;
  double qpcOffset_ = 0;
  int rate_ = 0, channels_ = 0;
  UINT32 bufferFrames_ = 0;
  bool exclusive_ = false, directF32_ = false;
  // ---- render thread ----
  std::vector<float> scratch_;
  dev::Tpdf dither_;
  dev::PresentClock pclock_;
  dev::JitterWindow jitter_, rawJitter_;
  dev::PeriodStepper stepper_;
  int64_t written_ = 0;     // frames given to the stream since Start (pre-fill included)
  int64_t frameIndex_ = 0;  // continuous across period steps
  double lastPresent_ = 0, lastCb_ = 0;
  int lastFrames_ = 0;
  uint64_t svcCallbacks_ = 0;
  // ---- shared with status() ----
  std::atomic<bool> running_{false}, lost_{false}, lostPending_{false};
  std::atomic<int> stepRequest_{0};
  std::atomic<uint64_t> glitches_{0}, callbacks_{0};
  std::atomic<int> periodSteps_{0};
  std::atomic<double> latencyMs_{0}, cpuUs_{0};
  mutable std::mutex statusM_;
  DeviceStatus static_;
};

}  // namespace

std::unique_ptr<AudioDevice> createSystemDevice() { return std::make_unique<WasapiDevice>(); }

}  // namespace om
