// COM / Win32 helpers of the WASAPI backend (owner: device, private header,
// library om_device_wasapi): the process MTA kept alive, scoped COM
// initialisation, UTF-8 <-> UTF-16, HRESULT and Win32 error texts, the QPC
// -> engine clock offset, WAVEFORMATEX(TENSIBLE) <-> StreamFormat, and the
// endpoint property reads (friendly name = Chromium's label, the engine's
// device format, raw-mode support). SPEC.md §8.
#pragma once

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <wrl/client.h>

#include <string>

#include "../formats.h"

namespace om {
namespace dev {
namespace win {

using Microsoft::WRL::ComPtr;

// CoIncrementMTAUsage once per process: COM objects created on the ops
// thread stay valid on our other MTA threads whatever thread exits first.
void ensureMta() noexcept;

// CoInitializeEx(MTA) for a scope; balanced; tolerates an STA caller.
class ComScope {
 public:
  ComScope() noexcept;
  ~ComScope();
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;

 private:
  HRESULT hr_;
};

std::string utf8(const wchar_t* w);
std::wstring utf16(const std::string& s);
std::string hrText(HRESULT hr);           // "AUDCLNT_E_DEVICE_IN_USE (0x8889000A)" / system message
std::string win32ErrorText(DWORD code);   // FormatMessage, UTF-8, trimmed

// EngineTime = qpcSeconds - engineClockOffset() (both are QPC; measured on
// the closest of several back-to-back samples).
double engineClockOffset() noexcept;

bool fromWaveFormat(const WAVEFORMATEX* wf, StreamFormat& out);
WAVEFORMATEXTENSIBLE toWaveFormat(const StreamFormat& f);

std::string deviceId(IMMDevice* d);
bool readFriendlyName(IMMDevice* d, std::string& out);
// PnP instance id of the endpoint's audio controller (Chromium's
// GetAudioControllerID: device topology -> first connector -> the KS filter
// it is connected to -> PKEY_Device_InstanceId). "" when unknown.
std::string controllerInstanceId(IMMDevice* d, IMMDeviceEnumerator* en);
// Chromium's MediaDeviceInfo.label of an endpoint (friendly name + " (vid:pid)" for USB).
void readChromiumLabel(IMMDevice* d, IMMDeviceEnumerator* en, std::string& label, std::string& friendly, std::string& modelId);
bool readDeviceFormat(IMMDevice* d, StreamFormat& out);  // PKEY_AudioEngine_DeviceFormat
bool readRawSupported(IMMDevice* d);                     // PKEY_Devices_AudioDevice_RawProcessingSupported
DWORD deviceState(IMMDevice* d);

extern const PROPERTYKEY kPkeyDeviceFormat;  // PKEY_AudioEngine_DeviceFormat

}  // namespace win
}  // namespace dev
}  // namespace om
