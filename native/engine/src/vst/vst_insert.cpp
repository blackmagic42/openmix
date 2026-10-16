// VST3 inserts processed in the audio callback (owner: decoder, library
// om_vst): Win32 host thread, PlugProvider loading, state, editors, scan,
// SEH-guarded process() with try_lock on the slot (port of
// native/vsthost/src/vsthost.cpp). SKELETON: every call reports "not
// implemented"; vstSdkAvailable() links the SDK's hosting library to prove
// the build recipe. SPEC.md §12.
#include "om/vst_insert.h"

#ifdef OM_WITH_VST
#include "pluginterfaces/vst/vsttypes.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#endif

namespace om {

struct VstHost::Impl {
  bool running = false;
};

VstHost::VstHost() : impl_(std::make_unique<Impl>()) {}
VstHost::~VstHost() { stop(); }

bool VstHost::start(double, int, std::string* err) {
  if (err) *err = "VST host not implemented yet";
  return false;
}
void VstHost::stop() { impl_->running = false; }
bool VstHost::running() const noexcept { return impl_->running; }
void VstHost::reconfigure(double, int) {}
std::vector<VstPluginInfo> VstHost::scan(const std::vector<std::string>&) { return {}; }

VstLoadResult VstHost::load(int, const std::string&, const std::string&) {
  VstLoadResult r;
  r.error = "VST host not implemented yet";
  return r;
}

void VstHost::unload(int) {}
bool VstHost::setState(int, const std::string&) { return false; }
std::string VstHost::getState(int) { return {}; }
std::string VstHost::openEditor(int, uintptr_t) { return "VST host not implemented yet"; }
void VstHost::closeEditor(int) {}
VstSlotStatus VstHost::status(int) { return VstSlotStatus(); }
void VstHost::setMix(int, float) noexcept {}
void VstHost::setTransport(int, double, bool) noexcept {}
bool VstHost::process(int, float*, float*, int) noexcept { return false; }
int VstHost::latencyFrames(int) const noexcept { return 0; }
bool VstHost::takeCrashed(int) noexcept { return false; }

bool vstSdkAvailable(std::string* version) {
#ifdef OM_WITH_VST
  // Instantiating the SDK's host context proves that sdk_hosting links.
  Steinberg::IPtr<Steinberg::Vst::HostApplication> app = Steinberg::owned(new Steinberg::Vst::HostApplication());
  if (version) *version = kVstVersionString;
  return app != nullptr;
#else
  if (version) version->clear();
  return false;
#endif
}

}  // namespace om
