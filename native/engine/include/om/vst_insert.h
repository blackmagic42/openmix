// VST3 effect plugins as deck inserts, processed INLINE with the audio
// callback (owner: decoder, library om_vst). SPEC.md §13.
//
// Ported from the HARDENED native/vsthost/src/vsthost.cpp: the Win32 host
// thread (message-only window + task queue: every VST3 call except
// process(), plugin editors with DPI handling and keyboard forwarding) with
// its time-outs (load 60 s, editor 30 s, state 10 s, short 5 s, quiesce 2 s,
// plugin dialogs up to 600 s), loading through the Steinberg SDK's
// PlugProvider with CachedModule (a DLL stays loaded until the app quits),
// stereo bus setup, component + controller state (same 32-bit
// length-framed blob, base64 like the Web engine's saved slots, so they
// restore here), the SEH crash guard and hung-slot detection.
//
// What changes: no shared ring and no 0.5 ms polling thread. Each deck's
// plugin runs on its own MMCSS worker thread; the callback hands it the
// block (IInsert::begin), does other work, then waits for it at most until
// the block deadline (IInsert::end): on time = the plugin output (no added
// latency), late = the latency-aligned dry for that block (a plugin that
// always returns, however late, is only ever "late"), a call that never
// returns (2 s) = the plugin is hung for the session (its worker is
// abandoned and replaced at unload; so is the worker of a crashed plugin,
// never reused). A plugin can
// therefore never stall the device thread or silence the mix. The plugin
// latency (<= 1 s) is compensated by the deck reading ahead; every dry
// signal (bypass, dry/wet, late, busy, crashed, hung, refused) is delayed by
// that latency so timing never jumps. The transport carries the deck's real
// beat position at the insert INPUT. Plugins may change MXCSR: every call
// runs inside dsp::FpEnvGuard (workers run with FTZ | DAZ); their
// allocations are counted apart (rt::PluginScope). Windows / SDK code lives
// in src/vst/win/.
//
// Scanning loads arbitrary DLLs: it runs in a separate short-lived process
// (om_vst_scan() of the C API, called by engine-host.js --scan), never in
// the engine process.
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

// One scanned file (scanVstPluginsDetailed): its audio effects, or why none.
struct VstScanResult {
  std::string path;
  std::vector<VstPluginInfo> plugins;
  std::string error;   // "" = scanned
  std::string source;  // "moduleinfo" (moduleinfo.json, nothing loaded) | "module" (loaded) | "loaded" (already in use)
  bool crashed = false;
  bool timedOut = false;
};

// Time-outs of the VST host thread (ms), from the hardened vsthost.cpp.
struct VstTimeouts {
  uint32_t load = 60000;
  uint32_t editor = 30000;
  uint32_t scan = 30000;
  uint32_t state = 10000;
  uint32_t shortOp = 5000;
  uint32_t quiesce = 2000;   // waiting for a deck worker to leave process()
  uint32_t dialog = 600000;  // a plugin window waiting for the user is not hung
};

// Host options (tests): editors open off-screen without being activated
// (never in the way of what the user is doing), a screen scale to pretend.
struct VstHostOptions {
  bool editorsOffscreen = false;
  float editorScale = 0.0f;  // 0 = the real one
};

struct VstLoadResult {
  bool ok = false;
  std::string error;
  std::string code;  // "", "timeout", "busy", "hung", "crashed", "latency" (> 1 s), "notAllowed", "notFound", "load_failed", "stopped"
  std::string name;
  int latency = 0;   // samples at the device rate
  int inputs = 0, outputs = 0;
  bool stateRestored = false;  // a state was given and the plugin accepted it
};

struct VstSlotStatus {
  bool loaded = false, active = false, bypassed = false, crashed = false, hung = false, editorOpen = false;
  bool latencyRefused = false;  // the plugin's latency went above the 1 s cap: bypassed (latency-aligned dry)
  bool busy = false;            // the VST host thread is stalled (a plugin call did not return in time)
  bool dialog = false;          // a plugin window waits for the user
  int latency = 0;
  bool latencyChanged = false;  // since the previous status() call
  uint64_t processed = 0;       // blocks processed on time
  uint64_t lateBlocks = 0;      // blocks that missed the deadline (dry used)
  uint64_t busySkips = 0;       // blocks skipped while the worker still ran a previous block
  uint64_t processErrors = 0;   // process() returned an error (dry used)
  double maxProcessMs = 0;      // slowest process() call
  double avgProcessMs = 0;      // mean process() call (CPU per block of this plugin)
  uint64_t pluginAllocs = 0;    // allocations made by the plugin's code (rt::PluginScope)
  float mix = 1.0f;
};

// Per-block transport of one deck for its plugin (ProcessContext), at the
// insert INPUT position: the block the plugin receives is heard L frames
// later (SPEC.md §13.3). Filled by the core from the sync engine and the
// deck (sync.deckBeatClock + Deck::positionAt).
struct VstTransport {
  bool playing = false;
  double tempoBpm = 0;          // effective BPM (60 / beatDur); 0 = unknown
  double beatPos = 0;           // projectTimeMusic: fractional beat index of the block's first input frame
  double barStartBeat = 0;      // barPositionMusic (4/4, bar anchor of the grid)
  int64_t samplePos = 0;        // projectTimeSamples: track position of that frame at the device rate
};

// Bits returned by VstHost::takeEvents().
enum VstEvent : uint8_t { kVstCrashed = 1, kVstHung = 2, kVstLate = 4, kVstLatency = 8 };

// ---------------------------------------------------------------------------
// The processor a deck worker runs: a loaded VST3 plugin (src/vst/win/), or
// any other processor attached with attachProcessor() (test fakes, future
// built-in inserts).
// ---------------------------------------------------------------------------
struct VstProcessBlock {
  const float* inL = nullptr;   // the deck's pre-insert block
  const float* inR = nullptr;
  float* outL = nullptr;        // where the processor writes its output
  float* outR = nullptr;
  int frames = 0;
  double sampleRate = 48000.0;
  VstTransport transport;       // at the insert input position
  int64_t continuousFrames = 0; // frames handed to this slot since the plugin was installed
  int64_t systemTimeNs = 0;     // steady clock at the hand-off (ns)
};
enum class VstProcessResult : uint8_t { Ok = 0, Error = 1, Crashed = 2 };

class IVstProcessor {
 public:
  virtual ~IVstProcessor() = default;
  // Runs on the deck's worker thread, inside dsp::FpEnvGuard (the worker has
  // FTZ | DAZ) and rt::PluginScope, guarded against hardware faults where the
  // platform supports it (Windows SEH). It is bounded by the callback
  // deadline: a late result is discarded. Not noexcept on purpose: nothing
  // between the guard and plugin code may terminate the process.
  virtual VstProcessResult process(const VstProcessBlock& block) = 0;
};

class VstHost final : public IInsert {
 public:
  VstHost();
  ~VstHost() override;
  VstHost(const VstHost&) = delete;
  VstHost& operator=(const VstHost&) = delete;

  // ---- vst-ops thread (blocking: waits on the VST host thread with the time-outs) ----
  // Starts the host thread and the 4 deck workers (MMCSS, FTZ/DAZ) for the
  // device rate. Called by the core when the device opens; load() starts the
  // host by itself (48 kHz) when it was not started.
  bool start(double sampleRate, int maxBlockFrames, std::string* err);
  void stop();
  bool running() const noexcept;
  double sampleRate() const noexcept;
  void setTimeouts(const VstTimeouts& t);
  void setOptions(const VstHostOptions& o);
  // OpenMix's main window: editors are owned by it, and it is enabled again
  // if a plugin's dialog crashed while modal to it.
  void setOwnerWindow(uintptr_t hwnd);
  // Device change: every loaded plugin is re-setup (setActive false,
  // setupProcessing, setActive true), its latency re-read and compensated.
  void reconfigure(double sampleRate, int maxBlockFrames);
  // The path must already satisfy the engine policy (SPEC.md §15.6); a
  // plugin reporting more than kMaxInsertLatencySec of latency is refused
  // (code "latency"). stateBase64: a saved state (getState) restored before
  // the plugin processes its first block.
  VstLoadResult load(int deck, const std::string& path, const std::string& uid, const std::string& stateBase64 = "");
  void unload(int deck);
  // Component + controller state (32-bit length-framed, the vsthost format),
  // as base64 text (the Web engine's saved slots). setState returns false on
  // a bad blob or a refusal; a crash or hang marks the slot.
  bool setState(int deck, const std::string& stateBase64);
  std::string getState(int deck);  // "" = no plugin / failure
  std::string openEditor(int deck, uintptr_t ownerHwnd);  // "" = ok, else error message
  void closeEditor(int deck);
  // Installs a processor in place of a VST3 plugin (tests, built-in inserts)
  // with the same rules: latency cap, worker, deadline, dry alignment.
  VstLoadResult attachProcessor(int deck, std::shared_ptr<IVstProcessor> proc, int latency, const std::string& name);
  // The attached processor's latency changed (what kLatencyChanged does for
  // a plugin): compensated, or refused above the cap (bypassed, kVstLatency).
  void setProcessorLatency(int deck, int latency);

  // ---- any thread, non-blocking (atomics) ----
  // Reading the status clears latencyChanged and asks the backend (editor,
  // busy, dialog): never on the audio thread (insertState() is for that).
  VstSlotStatus status(int deck) const;
  // The insert state of the state snapshot (om_deck_state.insert_state, an
  // OM_INSERT_* value of om_state.h) and, in *lateBlocks (may be null), the
  // blocks that missed the deadline since the plugin was installed. Const,
  // lock-free and real-time safe: it reads only the slot's atomics, clears
  // nothing and never calls the backend, so the core calls it on the audio
  // thread every block. Precedence: none (no plugin), crashed, hung (also a
  // process() call running for more than 2 s), bypassed (mix 0, latency
  // refused, disabled), late (the last block played the latency-aligned dry
  // because the plugin missed the deadline or was still busy on an earlier
  // block), active.
  uint8_t insertState(int deck, uint64_t* lateBlocks) const noexcept;

  // ---- audio thread ----
  // Once per device callback, before the first begin(): the deadline of this
  // callback = now + deadline fraction * periodSeconds. Also where the
  // audio thread adopts a new plugin / latency (latencyFrames() changes only
  // here, so the core can apply it to the deck in the same callback).
  void startCallback(double periodSeconds) noexcept;
  void setDeadline(float fractionOfPeriod) noexcept;  // 0.1 .. 0.6 (0.35)
  void setMix(int deck, float mix) noexcept;          // 0 = bypass (latency kept, so the sync never moves)
  void setTransport(int deck, const VstTransport& t) noexcept;
  bool begin(int deck, const float* l, const float* r, int frames) noexcept override;
  void end(int deck, float* l, float* r, int frames) noexcept override;
  int latencyFrames(int deck) const noexcept override;
  // VstEvent bits that happened on this deck since the previous call.
  uint8_t takeEvents(int deck) noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Scans VST3 files (meant for the separate scan process). Never throws.
// Lists the audio effects (instruments and offline-only classes are left out).
std::vector<VstPluginInfo> scanVstPlugins(const std::vector<std::string>& paths);
// The same with the outcome per file (errors, crashes and time-outs visible).
std::vector<VstScanResult> scanVstPluginsDetailed(const std::vector<std::string>& paths,
                                                  const VstTimeouts& timeouts = VstTimeouts());
// VST3 SDK compiled in (OM_WITH_VST on Windows); `version` receives the SDK version string.
bool vstSdkAvailable(std::string* version);
// Hardware faults in plugin code are caught on this platform/build (SEH).
bool vstFaultGuardAvailable() noexcept;

// Base64 (standard alphabet, padded) of the state blobs.
std::string base64Encode(const std::string& bytes);
bool base64Decode(const std::string& text, std::string& bytes);

}  // namespace om
