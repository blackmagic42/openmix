// Portable stand-ins of the VST inline host's platform services (owner:
// decoder, library om_vst without OM_WITH_VST: portable, sanitizer and
// --no-vst builds): workers run at normal priority with FTZ / DAZ, and there
// is no hardware-fault guard (vstFaultGuardAvailable() is false, the crash
// tests skip). Plain C++: no platform header. SPEC.md §13, §18.5.
#include "../vst_backend.h"
#include "om/dsp.h"

namespace om {
namespace vstbk {

void* prepareWorkerThread(int) noexcept {
  dsp::flushDenormals();
  return nullptr;
}

void releaseWorkerThread(void*) noexcept {}

bool guardedCall(void (*fn)(void*), void* ctx, uint32_t* faultCode) {
  if (faultCode) *faultCode = 0;
  fn(ctx);
  return true;
}

bool faultGuardAvailable() noexcept { return false; }

}  // namespace vstbk
}  // namespace om
