// VST3 effect plugins as deck inserts, processed DIRECTLY in the audio
// callback (owner: decoder, library om_vst). Port of native/vsthost: the
// Win32 host thread (message loop: every VST3 call except process(), plugin
// editors), plugin loading through the Steinberg SDK's PlugProvider, state
// save/restore, scanning — but process() is now called by the mixer inside
// the device callback (no shared ring, no extra latency: only the plugin's
// own latency, compensated by the deck's read-ahead). SPEC.md §12.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "om/common.h"

namespace om {

struct VstPluginInfo {
  std::string path, name, vendor, uid, subCategories;
};

struct VstLoadResult {
  bool ok = false;
  std::string error;
  std::string name;
  int latency = 0;   // samples at the device rate
  int inputs = 0, outputs = 0;
};

struct VstSlotStatus {
  bool loaded = false, active = false, crashed = false, editorOpen = false;
  int latency = 0;
  bool latencyChanged = false;  // since the previous status() call
  uint64_t processed = 0;       // blocks processed
  uint64_t busySkips = 0;       // blocks bypassed because the host thread held the slot
  float mix = 1.0f;
};

class VstHost final : public IInsert {
 public:
  VstHost();
  ~VstHost() override;
  VstHost(const VstHost&) = delete;
  VstHost& operator=(const VstHost&) = delete;

  // ---- control thread (each call is marshalled to the Win32 host thread) ----
  bool start(double sampleRate, int maxBlockFrames, std::string* err);
  void stop();
  bool running() const noexcept;
  // Device change: every loaded plugin is re-setup (setActive false/true).
  void reconfigure(double sampleRate, int maxBlockFrames);
  std::vector<VstPluginInfo> scan(const std::vector<std::string>& paths);
  VstLoadResult load(int deck, const std::string& path, const std::string& uid);
  void unload(int deck);
  bool setState(int deck, const std::string& blob);   // component + controller state (vsthost format)
  std::string getState(int deck);
  std::string openEditor(int deck, uintptr_t ownerHwnd);  // "" = ok, else error message
  void closeEditor(int deck);
  VstSlotStatus status(int deck);

  // ---- audio thread ----
  void setMix(int deck, float mix) noexcept;                  // 0 = bypass (latency kept)
  void setTransport(int deck, double bpm, bool playing) noexcept;  // ProcessContext tempo
  bool process(int deck, float* l, float* r, int frames) noexcept override;
  int latencyFrames(int deck) const noexcept override;
  // True once after a plugin crashed inside process() (slot then disabled).
  bool takeCrashed(int deck) noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// VST3 SDK compiled in (OM_WITH_VST); `version` receives the SDK version string.
bool vstSdkAvailable(std::string* version);

}  // namespace om
