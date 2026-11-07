// Render-endpoint enumeration, endpoint notifications and the passive "is
// the device API usable" check, Windows (owner: device, library
// om_device_wasapi). Enumeration never opens a stream: it lists the active
// render endpoints in IMMDeviceEnumerator::EnumAudioEndpoints order
// (Chromium's order) with Chromium's label (the friendly name, plus
// " (vid:pid)" for USB controllers, as Chromium appends), nameIndex for
// identical labels, the mix format (channels, mask, rate), the default
// flags per role, the device periods and the IAudioClient3 shared periods;
// disabled / unplugged endpoints follow, marked inactive. The watcher is an
// IMMNotificationClient that only posts (Added, StateChanged, removal as
// StateChanged NOTPRESENT, DefaultChanged for the render console /
// communications roles, FormatChanged on PKEY_AudioEngine_DeviceFormat).
// SPEC.md §8.1, §8.4.
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <memory>
#include <mutex>

#include "../endpoints.h"
#include "com_util.h"
#include "om/device.h"

namespace om {

namespace {

using dev::win::ComPtr;

void fillAudioInfo(IMMDevice* d, DeviceInfo& info) {
  ComPtr<IAudioClient> c;
  ComPtr<IAudioClient3> c3;
  if (SUCCEEDED(d->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(c3.GetAddressOf())))) {
    c = c3;
  } else if (FAILED(d->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(c.GetAddressOf())))) {
    return;
  }
  WAVEFORMATEX* wf = nullptr;
  if (SUCCEEDED(c->GetMixFormat(&wf)) && wf) {
    dev::StreamFormat f;
    if (dev::win::fromWaveFormat(wf, f)) {
      info.channels = f.channels;
      info.channelMask = f.channelMask;
      info.sampleRate = f.sampleRate;
    } else {
      info.channels = wf->nChannels;
      info.sampleRate = static_cast<int>(wf->nSamplesPerSec);
    }
    REFERENCE_TIME def = 0, mn = 0;
    if (SUCCEEDED(c->GetDevicePeriod(&def, &mn))) {
      info.defaultPeriodMs = def / 10000.0;
      info.minPeriodMs = mn / 10000.0;
    }
    if (c3) {
      UINT32 pd = 0, pf = 0, pmin = 0, pmax = 0;
      if (SUCCEEDED(c3->GetSharedModeEnginePeriod(wf, &pd, &pf, &pmin, &pmax))) {
        info.sharedDefaultPeriodFrames = static_cast<int>(pd);
        info.sharedFundamentalFrames = static_cast<int>(pf);
        info.sharedMinPeriodFrames = static_cast<int>(pmin);
        info.sharedMaxPeriodFrames = static_cast<int>(pmax);
      }
    }
    CoTaskMemFree(wf);
  }
}

std::string defaultId(IMMDeviceEnumerator* en, ERole role) {
  ComPtr<IMMDevice> d;
  if (FAILED(en->GetDefaultAudioEndpoint(eRender, role, &d)) || !d) return {};
  return dev::win::deviceId(d.Get());
}

// ---------------------------------------------------------------------------
// IMMNotificationClient -> DeviceEventFn (post only)
// ---------------------------------------------------------------------------
struct Sink {
  std::mutex m;
  bool alive = true;
  DeviceEventFn fn;
  void emit(const DeviceEventInfo& ev) {
    std::lock_guard<std::mutex> lk(m);
    if (alive && fn) fn(ev);
  }
};

class NotificationClient final : public IMMNotificationClient {
 public:
  explicit NotificationClient(std::shared_ptr<Sink> sink) : sink_(std::move(sink)) {}
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *out = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD state) override {
    DeviceEventInfo ev;
    ev.event = DeviceEvent::StateChanged;
    ev.id = dev::win::utf8(id);
    ev.state = state;
    sink_->emit(ev);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR id) override {
    DeviceEventInfo ev;
    ev.event = DeviceEvent::Added;
    ev.id = dev::win::utf8(id);
    sink_->emit(ev);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override {
    DeviceEventInfo ev;
    ev.event = DeviceEvent::StateChanged;
    ev.id = dev::win::utf8(id);
    ev.state = kDeviceStateNotPresent;
    sink_->emit(ev);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR id) override {
    if (flow != eRender || (role != eConsole && role != eCommunications)) return S_OK;
    DeviceEventInfo ev;
    ev.event = DeviceEvent::DefaultChanged;
    ev.id = dev::win::utf8(id);
    ev.role = role == eConsole ? DeviceRole::Console : DeviceRole::Communications;
    sink_->emit(ev);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR id, const PROPERTYKEY key) override {
    if (IsEqualGUID(key.fmtid, dev::win::kPkeyDeviceFormat.fmtid) && key.pid == dev::win::kPkeyDeviceFormat.pid) {
      DeviceEventInfo ev;
      ev.event = DeviceEvent::FormatChanged;
      ev.id = dev::win::utf8(id);
      sink_->emit(ev);
    }
    return S_OK;
  }

 private:
  std::atomic<ULONG> ref_{1};
  std::shared_ptr<Sink> sink_;
};

class WinDeviceWatcher final : public DeviceWatcher {
 public:
  WinDeviceWatcher(ComPtr<IMMDeviceEnumerator> en, NotificationClient* client, std::shared_ptr<Sink> sink)
      : en_(std::move(en)), client_(client), sink_(std::move(sink)) {}
  ~WinDeviceWatcher() override {
    {
      std::lock_guard<std::mutex> lk(sink_->m);  // waits for a callback in progress
      sink_->alive = false;
    }
    en_->UnregisterEndpointNotificationCallback(client_);
    client_->Release();
  }

 private:
  ComPtr<IMMDeviceEnumerator> en_;
  NotificationClient* client_;
  std::shared_ptr<Sink> sink_;
};

}  // namespace

std::vector<DeviceInfo> enumerateOutputDevices(std::string* err) {
  dev::win::ComScope com;
  std::vector<DeviceInfo> list;
  ComPtr<IMMDeviceEnumerator> en;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(en.GetAddressOf()));
  if (FAILED(hr) || !en) {
    if (err) *err = "IMMDeviceEnumerator unavailable: " + dev::win::hrText(hr);
    return list;
  }
  const std::string defConsole = defaultId(en.Get(), eConsole);
  const std::string defComms = defaultId(en.Get(), eCommunications);
  // Active endpoints, in EnumAudioEndpoints order (Chromium's order), then
  // disabled / unplugged ones (listed for diagnostics, never chosen).
  const DWORD masks[2] = {DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED | DEVICE_STATE_UNPLUGGED};
  for (int pass = 0; pass < 2; pass++) {
    ComPtr<IMMDeviceCollection> coll;
    hr = en->EnumAudioEndpoints(eRender, masks[pass], &coll);
    if (FAILED(hr) || !coll) {
      if (pass == 0 && err) *err = "EnumAudioEndpoints failed: " + dev::win::hrText(hr);
      continue;
    }
    UINT n = 0;
    coll->GetCount(&n);
    for (UINT i = 0; i < n; i++) {
      ComPtr<IMMDevice> d;
      if (FAILED(coll->Item(i, &d)) || !d) continue;
      DeviceInfo info;
      info.id = dev::win::deviceId(d.Get());
      dev::win::readChromiumLabel(d.Get(), en.Get(), info.name, info.friendlyName, info.modelId);
      info.active = pass == 0;
      if (info.active) {
        info.isDefault = info.id == defConsole;
        info.isDefaultComms = info.id == defComms;
        fillAudioInfo(d.Get(), info);
      }
      list.push_back(std::move(info));
    }
  }
  dev::finalizeEndpointList(list);
  return list;
}

bool deviceApiAvailable(std::string* err) {
  dev::win::ComScope com;
  ComPtr<IMMDeviceEnumerator> en;
  const HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                      reinterpret_cast<void**>(en.GetAddressOf()));
  const bool ok = SUCCEEDED(hr) && en;
  if (!ok && err) *err = "IMMDeviceEnumerator unavailable";
  return ok;
}

std::unique_ptr<DeviceWatcher> createDeviceWatcher(DeviceEventFn fn, std::string* err) {
  dev::win::ComScope com;
  ComPtr<IMMDeviceEnumerator> en;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(en.GetAddressOf()));
  if (FAILED(hr) || !en) {
    if (err) *err = "IMMDeviceEnumerator unavailable: " + dev::win::hrText(hr);
    return nullptr;
  }
  auto sink = std::make_shared<Sink>();
  sink->fn = std::move(fn);
  auto* client = new NotificationClient(sink);
  hr = en->RegisterEndpointNotificationCallback(client);
  if (FAILED(hr)) {
    client->Release();
    if (err) *err = "RegisterEndpointNotificationCallback failed: " + dev::win::hrText(hr);
    return nullptr;
  }
  return std::make_unique<WinDeviceWatcher>(std::move(en), client, std::move(sink));
}

}  // namespace om
