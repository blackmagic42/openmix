// Media Foundation source reader: whole file -> float stereo at the file's
// rate (owner: decoder). SKELETON: decodeFileF32 reports "not implemented";
// mediaFoundationAvailable() is real (proves the mfplat link line).
#define NOMINMAX
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>

#include "om/decoder.h"

namespace om {

DecodeError decodeFileF32(const std::string&, PcmF32& out, const std::atomic<bool>*, std::atomic<float>*,
                          std::string* message) {
  out = PcmF32();
  if (message) *message = "Media Foundation decoding not implemented yet";
  return DecodeError::Internal;
}

bool mediaFoundationAvailable(std::string* err) {
  const HRESULT hrInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool needUninit = SUCCEEDED(hrInit);
  const HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
  const bool ok = SUCCEEDED(hr);
  if (ok) MFShutdown();
  if (needUninit) CoUninitialize();
  if (!ok && err) *err = "MFStartup failed";
  return ok;
}

}  // namespace om
