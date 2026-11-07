// COM / Win32 helpers of the WASAPI backend (owner: device, library
// om_device_wasapi): MTA lifetime, scoped COM init, string conversions,
// error texts, the QPC -> engine clock offset, wave format conversions and
// the endpoint property reads. The property keys and the KSDATAFORMAT
// GUIDs are defined here (no INITGUID games, no extra import library).
// SPEC.md §8.
#include "com_util.h"

#include <devicetopology.h>

#include <cstdio>
#include <mutex>

#include "../endpoints.h"
#include "../negotiate.h"
#include "om/common.h"

namespace om {
namespace dev {
namespace win {

namespace {
// {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
const PROPERTYKEY kPkeyFriendlyName = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};
// {78c34fc8-104a-4aca-9ea4-524d52996e57}, 256
const PROPERTYKEY kPkeyInstanceId = {{0x78c34fc8, 0x104a, 0x4aca, {0x9e, 0xa4, 0x52, 0x4d, 0x52, 0x99, 0x6e, 0x57}}, 256};
// {8943b373-388c-4395-b557-bc6dbaffafdb}, 2
const PROPERTYKEY kPkeyRawSupported = {{0x8943b373, 0x388c, 0x4395, {0xb5, 0x57, 0xbc, 0x6d, 0xba, 0xff, 0xaf, 0xdb}}, 2};
const GUID kSubtypePcm = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
const GUID kSubtypeFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
}  // namespace

// {f19f064d-082c-4e27-bc73-6882a1bb8e4c}, 0
const PROPERTYKEY kPkeyDeviceFormat = {{0xf19f064d, 0x082c, 0x4e27, {0xbc, 0x73, 0x68, 0x82, 0xa1, 0xbb, 0x8e, 0x4c}}, 0};

void ensureMta() noexcept {
  static std::once_flag once;
  std::call_once(once, [] {
    CO_MTA_USAGE_COOKIE cookie = nullptr;
    CoIncrementMTAUsage(&cookie);  // kept for the process lifetime on purpose
  });
}

ComScope::ComScope() noexcept : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) { ensureMta(); }

ComScope::~ComScope() {
  if (SUCCEEDED(hr_)) CoUninitialize();
}

std::string utf8(const wchar_t* w) {
  if (!w || !*w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring utf16(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (n <= 0) return {};
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string win32ErrorText(DWORD code) {
  wchar_t* buf = nullptr;
  const DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                 nullptr, code, 0, reinterpret_cast<wchar_t*>(&buf), 0, nullptr);
  std::string s = n && buf ? utf8(buf) : std::string();
  if (buf) LocalFree(buf);  // rt-lint: allow (FormatMessage buffer, never on the audio thread)
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == '.')) s.pop_back();
  if (s.empty()) s = "error " + std::to_string(code);
  return s;
}

std::string hrText(HRESULT hr) {
  char b[16];
  const char* name = hresultName(static_cast<int32_t>(hr), b, sizeof(b));
  char hex[16];
  std::snprintf(hex, sizeof(hex), "0x%08X", static_cast<unsigned>(hr));
  if (name != b) return std::string(name) + " (" + hex + ")";
  return win32ErrorText(static_cast<DWORD>(hr)) + " (" + hex + ")";
}

double engineClockOffset() noexcept {
  LARGE_INTEGER f;
  QueryPerformanceFrequency(&f);
  const double fq = static_cast<double>(f.QuadPart);
  double best = 1e9, off = 0;
  for (int i = 0; i < 16; i++) {
    LARGE_INTEGER a, b;
    QueryPerformanceCounter(&a);
    const double e = EngineClock::now();
    QueryPerformanceCounter(&b);
    const double gap = static_cast<double>(b.QuadPart - a.QuadPart) / fq;
    if (gap < best) {
      best = gap;
      off = (static_cast<double>(a.QuadPart) + static_cast<double>(b.QuadPart)) * 0.5 / fq - e;
    }
  }
  return off;
}

bool fromWaveFormat(const WAVEFORMATEX* wf, StreamFormat& out) {
  if (!wf) return false;
  out = StreamFormat();
  out.sampleRate = static_cast<int>(wf->nSamplesPerSec);
  out.channels = static_cast<int>(wf->nChannels);
  int tag = wf->wFormatTag;
  const int bits = wf->wBitsPerSample;
  int valid = bits;
  if (tag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22) {
    const auto* x = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
    out.channelMask = x->dwChannelMask;
    if (x->Samples.wValidBitsPerSample) valid = x->Samples.wValidBitsPerSample;
    if (IsEqualGUID(x->SubFormat, kSubtypeFloat)) tag = WAVE_FORMAT_IEEE_FLOAT;
    else if (IsEqualGUID(x->SubFormat, kSubtypePcm)) tag = WAVE_FORMAT_PCM;
    else return false;
  }
  if (tag == WAVE_FORMAT_IEEE_FLOAT && bits == 32) {
    out.format = SampleFormat::F32;
  } else if (tag == WAVE_FORMAT_PCM) {
    if (bits == 16) out.format = SampleFormat::S16;
    else if (bits == 24) out.format = SampleFormat::S24;
    else if (bits == 32) out.format = valid == 24 ? SampleFormat::S24in32 : SampleFormat::S32;
    else return false;
  } else {
    return false;
  }
  return out.sampleRate > 0 && out.channels > 0;
}

WAVEFORMATEXTENSIBLE toWaveFormat(const StreamFormat& f) {
  WAVEFORMATEXTENSIBLE w{};
  const int bytes = bytesPerSample(f.format);
  w.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  w.Format.nChannels = static_cast<WORD>(f.channels);
  w.Format.nSamplesPerSec = static_cast<DWORD>(f.sampleRate);
  w.Format.wBitsPerSample = static_cast<WORD>(bytes * 8);
  w.Format.nBlockAlign = static_cast<WORD>(f.channels * bytes);
  w.Format.nAvgBytesPerSec = static_cast<DWORD>(f.sampleRate) * w.Format.nBlockAlign;
  w.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  w.Samples.wValidBitsPerSample = static_cast<WORD>(validBits(f.format));
  w.dwChannelMask = f.channelMask ? f.channelMask : defaultChannelMask(f.channels);
  w.SubFormat = isFloat(f.format) ? kSubtypeFloat : kSubtypePcm;
  return w;
}

std::string deviceId(IMMDevice* d) {
  if (!d) return {};
  LPWSTR id = nullptr;
  std::string s;
  if (SUCCEEDED(d->GetId(&id)) && id) s = utf8(id);
  if (id) CoTaskMemFree(id);
  return s;
}

namespace {
bool readProp(IMMDevice* d, const PROPERTYKEY& key, PROPVARIANT& pv) {
  if (!d) return false;
  ComPtr<IPropertyStore> store;
  if (FAILED(d->OpenPropertyStore(STGM_READ, &store)) || !store) return false;
  PropVariantInit(&pv);
  return SUCCEEDED(store->GetValue(key, &pv));
}
}  // namespace

bool readFriendlyName(IMMDevice* d, std::string& out) {
  PROPVARIANT pv;
  if (!readProp(d, kPkeyFriendlyName, pv)) return false;
  const bool ok = pv.vt == VT_LPWSTR && pv.pwszVal;
  if (ok) out = utf8(pv.pwszVal);
  PropVariantClear(&pv);
  return ok;
}

std::string controllerInstanceId(IMMDevice* d, IMMDeviceEnumerator* en) {
  if (!d || !en) return {};
  ComPtr<IDeviceTopology> topo;
  ComPtr<IConnector> conn;
  LPWSTR filterId = nullptr;
  if (FAILED(d->Activate(__uuidof(IDeviceTopology), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(topo.GetAddressOf()))) ||
      FAILED(topo->GetConnector(0, &conn)) || FAILED(conn->GetDeviceIdConnectedTo(&filterId)) || !filterId) {
    if (filterId) CoTaskMemFree(filterId);
    return {};
  }
  ComPtr<IMMDevice> node;
  const HRESULT hr = en->GetDevice(filterId, &node);
  CoTaskMemFree(filterId);
  if (FAILED(hr) || !node) return {};
  PROPVARIANT pv;
  if (!readProp(node.Get(), kPkeyInstanceId, pv)) return {};
  std::string id = pv.vt == VT_LPWSTR && pv.pwszVal ? utf8(pv.pwszVal) : std::string();
  PropVariantClear(&pv);
  return id;
}

void readChromiumLabel(IMMDevice* d, IMMDeviceEnumerator* en, std::string& label, std::string& friendly, std::string& modelId) {
  friendly.clear();
  readFriendlyName(d, friendly);
  modelId = usbModelIdFromInstanceId(controllerInstanceId(d, en));
  label = chromiumLabel(friendly, modelId);
}

bool readDeviceFormat(IMMDevice* d, StreamFormat& out) {
  PROPVARIANT pv;
  if (!readProp(d, kPkeyDeviceFormat, pv)) return false;
  bool ok = false;
  if (pv.vt == VT_BLOB && pv.blob.pBlobData && pv.blob.cbSize >= sizeof(WAVEFORMATEX))
    ok = fromWaveFormat(reinterpret_cast<const WAVEFORMATEX*>(pv.blob.pBlobData), out);
  PropVariantClear(&pv);
  return ok;
}

bool readRawSupported(IMMDevice* d) {
  PROPVARIANT pv;
  if (!readProp(d, kPkeyRawSupported, pv)) return false;
  const bool ok = pv.vt == VT_BOOL && pv.boolVal == VARIANT_TRUE;
  PropVariantClear(&pv);
  return ok;
}

DWORD deviceState(IMMDevice* d) {
  DWORD st = 0;
  if (!d || FAILED(d->GetState(&st))) return 0;
  return st;
}

}  // namespace win
}  // namespace dev
}  // namespace om
