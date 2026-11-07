// Windows platform services of the VST3 inline host (owner: decoder, library
// om_vst with OM_WITH_VST): the hardware-fault guard (SEH) around plugin
// code, and the setup of each deck's worker thread (MMCSS "Pro Audio" at
// high priority, power throttling off, a thread name, FTZ | DAZ).
// SPEC.md §13.2, §13.4.
#include <windows.h>
#include <avrt.h>
#include <malloc.h>

#include <cstdio>

#include "../vst_backend.h"
#include "om/dsp.h"

namespace om {
namespace vstbk {

namespace {

int captureFault(EXCEPTION_POINTERS* ep, uint32_t* code) {
  if (code && ep && ep->ExceptionRecord) *code = static_cast<uint32_t>(ep->ExceptionRecord->ExceptionCode);
  return EXCEPTION_EXECUTE_HANDLER;
}

// The __try lives in a function without C++ objects (MSVC rule); objects of
// the guarded code are not destroyed after a fault, so no lock may be held
// across guarded code.
int sehRun(void (*fn)(void*), void* ctx, uint32_t* code) {
  __try {
    fn(ctx);
    return 1;
  } __except (captureFault(GetExceptionInformation(), code)) {
    return 0;
  }
}

using SetThreadDescriptionFn = HRESULT(WINAPI*)(HANDLE, PCWSTR);

}  // namespace

bool guardedCall(void (*fn)(void*), void* ctx, uint32_t* faultCode) {
  uint32_t code = 0;
  const int ok = sehRun(fn, ctx, &code);
  if (faultCode) *faultCode = code;
  if (!ok && code == static_cast<uint32_t>(EXCEPTION_STACK_OVERFLOW)) _resetstkoflw();
  return ok != 0;
}

bool faultGuardAvailable() noexcept { return true; }

void* prepareWorkerThread(int deck) noexcept {
  HANDLE self = GetCurrentThread();
  if (HMODULE k = GetModuleHandleW(L"kernel32.dll")) {
    if (auto set = reinterpret_cast<SetThreadDescriptionFn>(GetProcAddress(k, "SetThreadDescription"))) {
      wchar_t name[32];
      std::swprintf(name, 32, L"om-vst-d%d", deck);
      set(self, name);
    }
  }
  // never slowed down by EcoQoS / power throttling
  THREAD_POWER_THROTTLING_STATE ps{};
  ps.Version = THREAD_POWER_THROTTLING_CURRENT_VERSION;
  ps.ControlMask = THREAD_POWER_THROTTLING_EXECUTION_SPEED;
  ps.StateMask = 0;
  SetThreadInformation(self, ThreadPowerThrottling, &ps, sizeof(ps));
  DWORD task = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  if (mmcss) AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_HIGH);
  else SetThreadPriority(self, THREAD_PRIORITY_TIME_CRITICAL);
  dsp::flushDenormals();
  return mmcss;
}

void releaseWorkerThread(void* token) noexcept {
  if (token) AvRevertMmThreadCharacteristics(static_cast<HANDLE>(token));
}

}  // namespace vstbk
}  // namespace om
