// Private seam of the VST3 inline host (owner: decoder): what the portable
// shell (src/vst/vst_insert.cpp: slots, deck workers, deadline, dry lines,
// status) needs from the platform (src/vst/win/ or src/vst/none/): worker
// thread setup (MMCSS, power throttling, name), the hardware-fault guard,
// and the plugin backend (the VST3 SDK on the Win32 host thread). The
// backend calls back into the shell through SlotControl to keep a deck's
// worker out of the plugin while it reconfigures it (latency, I/O, reload).
// SPEC.md §13.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "om/vst_insert.h"

namespace om {
namespace vstbk {

// ---- platform services ----------------------------------------------------
// On the deck worker thread before it serves blocks: MMCSS "Pro Audio",
// power throttling off, thread name, FTZ | DAZ. Returns a token for release.
void* prepareWorkerThread(int deck) noexcept;
void releaseWorkerThread(void* token) noexcept;
// Runs fn(ctx); a hardware fault (access violation, stack overflow, an
// exception plugin code let escape...) is caught where supported: false.
bool guardedCall(void (*fn)(void*), void* ctx, uint32_t* faultCode);
bool faultGuardAvailable() noexcept;

// ---- the shell, seen from the backend (host thread) -----------------------
class SlotControl {
 public:
  virtual ~SlotControl() = default;
  // Keeps the deck's worker out of the plugin (operations nest); false = the
  // worker did not leave process() within the quiesce time-out (hung). Every
  // beginOp() is paired with an endOp().
  virtual bool beginOp(int deck) = 0;
  virtual void endOp(int deck) = 0;
  // The plugin `inst` of this deck has a new latency (after a deactivate /
  // reactivate cycle); ignored when the deck no longer holds `inst`.
  virtual void setLatency(int deck, void* inst, int latency) = 0;
  // A plugin call on the host thread faulted / the plugin can no longer run
  // (an I/O change it cannot honour): the deck plays its latency-aligned dry.
  virtual void markCrashed(int deck, void* inst) = 0;
  virtual void markDisabled(int deck, void* inst) = 0;
  // kReloadComponent: the plugin was re-created; the deck now runs `proc`
  // (the new instance `inst`). Called between beginOp / endOp.
  virtual void replaceInstance(int deck, void* oldInst, void* newInst, IVstProcessor* proc, int latency) = 0;
};

struct LoadOut {
  VstLoadResult result;
  IVstProcessor* proc = nullptr;  // runs on the deck worker
  void* inst = nullptr;           // the backend's instance (unload, state, editor)
};

// The plugin backend of one VstHost (4 decks). Every call blocks the caller
// (the vst-ops thread) while the VST host thread does the work, with the
// hardened time-outs; none of them is ever called on the audio thread.
class Backend {
 public:
  virtual ~Backend() = default;
  virtual bool start(SlotControl* ctl, double sampleRate, int maxBlockFrames, std::string* err) = 0;
  virtual void stop() = 0;  // unloads what is left (abandons crashed / hung plugins)
  virtual void setTimeouts(const VstTimeouts& t) = 0;
  virtual void setOptions(const VstHostOptions& o) = 0;
  virtual void setOwnerWindow(uintptr_t hwnd) = 0;
  virtual LoadOut load(int deck, const std::string& path, const std::string& uid, double sampleRate,
                       int maxBlockFrames) = 0;
  // abandon: never call the plugin again (crashed, hung): left loaded.
  virtual void unload(int deck, void* inst, bool abandon) = 0;
  virtual bool getState(int deck, void* inst, std::string& blob, std::string& err) = 0;
  // The caller kept the worker out (beginOp). *latency = the latency after
  // the restore (the plugin is deactivated / reactivated when it changed).
  virtual bool setState(int deck, void* inst, const std::string& blob, std::string& err, int* latency) = 0;
  virtual std::string openEditor(int deck, void* inst, uintptr_t owner) = 0;
  virtual void closeEditor(int deck, void* inst) = 0;
  // The caller kept the worker out. Re-setup at a new rate / block size.
  virtual bool reconfigure(int deck, void* inst, double sampleRate, int maxBlockFrames, int* latency,
                           std::string& err) = 0;
  // Non-blocking.
  virtual bool editorOpen(int deck) const noexcept = 0;
  virtual bool busy() const noexcept = 0;
  virtual bool dialog() const noexcept = 0;
};

std::unique_ptr<Backend> createBackend();
std::vector<VstScanResult> scan(const std::vector<std::string>& paths, const VstTimeouts& t);
bool sdkAvailable(std::string* version);

}  // namespace vstbk
}  // namespace om
