// Render-endpoint enumeration, name/id resolution and the passive "is the
// device API usable" check (owner: device). Enumeration never opens a
// stream. SKELETON: enumeration and resolution are TODO; the availability
// check is real (it proves the COM / MMDevice link line).
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>

#include "om/device.h"

namespace om {

std::vector<DeviceInfo> enumerateOutputDevices(std::string* err) {
  if (err) *err = "device enumeration not implemented yet";
  return {};
}

std::string resolveOutputDevice(const DeviceConfig&, std::string* err) {
  if (err) *err = "device resolution not implemented yet";
  return {};
}

bool deviceApiAvailable(std::string* err) {
  const HRESULT hrInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool needUninit = SUCCEEDED(hrInit);
  IMMDeviceEnumerator* en = nullptr;
  const HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                      __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&en));
  const bool ok = SUCCEEDED(hr) && en;
  if (en) en->Release();
  if (needUninit) CoUninitialize();
  if (!ok && err) *err = "IMMDeviceEnumerator unavailable";
  return ok;
}

}  // namespace om
