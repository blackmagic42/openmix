// Stand-ins of the VST3 SDK side where it is not built (owner: decoder,
// library om_vst without OM_WITH_VST: portable builds, sanitizer builds,
// --no-vst): no plugin can be scanned or loaded; processors attached with
// VstHost::attachProcessor() still run on the deck workers. SPEC.md §13,
// §18.5.
#include "../vst_backend.h"

namespace om {
namespace vstbk {

namespace {
constexpr const char* kNoSdk = "VST3 plugins are not supported in this build";

class NoBackend final : public Backend {
 public:
  bool start(SlotControl*, double, int, std::string*) override { return true; }
  void stop() override {}
  void setTimeouts(const VstTimeouts&) override {}
  void setOptions(const VstHostOptions&) override {}
  void setOwnerWindow(uintptr_t) override {}
  LoadOut load(int, const std::string&, const std::string&, double, int) override {
    LoadOut o;
    o.result.error = kNoSdk;
    o.result.code = "load_failed";
    return o;
  }
  void unload(int, void*, bool) override {}
  bool getState(int, void*, std::string&, std::string& err) override {
    err = kNoSdk;
    return false;
  }
  bool setState(int, void*, const std::string&, std::string& err, int*) override {
    err = kNoSdk;
    return false;
  }
  std::string openEditor(int, void*, uintptr_t) override { return kNoSdk; }
  void closeEditor(int, void*) override {}
  bool reconfigure(int, void*, double, int, int*, std::string& err) override {
    err = kNoSdk;
    return false;
  }
  bool editorOpen(int) const noexcept override { return false; }
  bool busy() const noexcept override { return false; }
  bool dialog() const noexcept override { return false; }
};
}  // namespace

std::unique_ptr<Backend> createBackend() { return std::make_unique<NoBackend>(); }

std::vector<VstScanResult> scan(const std::vector<std::string>& paths, const VstTimeouts&) {
  std::vector<VstScanResult> out;
  for (const std::string& p : paths) {
    VstScanResult r;
    r.path = p;
    r.error = kNoSdk;
    out.push_back(std::move(r));
  }
  return out;
}

bool sdkAvailable(std::string* version) {
  if (version) version->clear();
  return false;
}

}  // namespace vstbk
}  // namespace om
