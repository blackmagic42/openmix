// Engine core (owner: host): owns the decks, mixer, FX units, sync engine,
// PCM store, VST host, recorder and devices. It parses the JSON commands and
// routes them (inline on the caller's thread, ops thread, vst-ops thread,
// audio thread), runs the control thread (retired objects, memory frees, FX
// unit and chain allocation, state events only when new, heartbeat, stall
// watchdog), the ops thread (device lifecycle: open / phones / close, loss
// -> NULL pacer -> restore, default and format changes, stall restarts,
// recordings) and the vst-ops thread (plugins), and implements the device
// render callback (command dispatch with sample-exact "when" splitting, sync
// tick, beat clocks, decks, mixer, output routing, recorder and phones taps,
// state publication). The flat C API (om_engine.h) is a thin wrapper of this
// class; the tests use either. SPEC.md §3, §6, §8.
//
// Backend seams: the device enumeration, the master output, the headphones
// output, the recorder and the VST host are reached through the small
// interfaces below. The defaults are the real modules (WASAPI, SecondaryOutput,
// Recorder, VstHost); the core tests inject fakes so the core is proven
// without a sound card, a disk or a plugin (EngineOptions::backends).
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "om/common.h"
#include "om/device.h"
#include "om/om_state.h"
#include "om/pcm.h"
#include "om/recorder.h"
#include "om/vst_insert.h"

namespace om {

// ---------------------------------------------------------------------------
// Backend seams (default: the real modules; tests: fakes)
// ---------------------------------------------------------------------------
// Headphones on a second sound card (default: om::SecondaryOutput). open /
// close / status on the ops thread; push() on the audio thread (RT-safe,
// must be safe against a concurrent open / close).
class IPhonesOutput {
 public:
  virtual ~IPhonesOutput() = default;
  virtual bool open(const DeviceConfig& cfg, int mainSampleRate, int mainPeriodFrames, std::string* err) = 0;
  virtual void close() = 0;
  // `t`: engine time of the first frame (BlockClock::callbackTime of the
  // rendered sub-block), so the card's fill is measured without the main
  // callback's render-time jitter (SecondaryOutput's stamped push).
  virtual void push(const float* l, const float* r, int frames, EngineTime t) noexcept = 0;
  virtual bool active() const noexcept = 0;
  virtual DeviceStatus status() const = 0;
  virtual void setEventHandler(DeviceEventFn fn) = 0;
};

// Mix recorder (default: om::Recorder): start / stop / continueAtRate / list
// on the ops thread, push() on the audio thread, status() / active() /
// takeError() from any thread (non-blocking).
class IRecorder {
 public:
  virtual ~IRecorder() = default;
  virtual bool start(const std::string& dirUtf8, const std::string& name, RecFormat fmt, int sampleRate,
                     std::string* pathOut, std::string* err) = 0;
  virtual void push(const float* l, const float* r, int frames) noexcept = 0;
  virtual bool continueAtRate(int sampleRate, std::string* err) = 0;
  virtual RecStatus stop() = 0;
  virtual RecStatus status() const = 0;
  virtual bool active() const noexcept = 0;
  virtual bool takeError() noexcept = 0;
  virtual std::vector<RecFileInfo> list(const std::string& dirUtf8, bool repair) = 0;
};

// VST3 inserts (default: om::VstHost). Blocking calls on the vst-ops thread,
// status() from any thread except the audio thread (it clears latencyChanged
// and asks the backend), insertState() from any thread (lock-free: the
// snapshot calls it every block), the rest (IInsert included) on the audio
// thread.
class IVstHost : public IInsert {
 public:
  virtual bool start(double sampleRate, int maxBlockFrames, std::string* err) = 0;
  virtual void stop() = 0;
  virtual bool running() const noexcept = 0;
  virtual void reconfigure(double sampleRate, int maxBlockFrames) = 0;
  virtual void setOwnerWindow(uintptr_t hwnd) = 0;
  // States are base64 text (the vsthost blob format, as the Web engine saved them).
  virtual VstLoadResult load(int deck, const std::string& path, const std::string& uid, const std::string& stateBase64) = 0;
  virtual void unload(int deck) = 0;
  virtual bool setState(int deck, const std::string& stateBase64) = 0;
  virtual std::string getState(int deck) = 0;
  virtual std::string openEditor(int deck, uintptr_t ownerHwnd) = 0;
  virtual void closeEditor(int deck) = 0;
  virtual VstSlotStatus status(int deck) const = 0;
  // om_deck_state.insert_state (OM_INSERT_*) and insert_late (VstHost::insertState).
  virtual uint8_t insertState(int deck, uint64_t* lateBlocks) const noexcept = 0;
  virtual void startCallback(double periodSeconds) noexcept = 0;
  virtual void setDeadline(float fractionOfPeriod) noexcept = 0;
  virtual void setMix(int deck, float mix) noexcept = 0;
  virtual void setTransport(int deck, const VstTransport& t) noexcept = 0;
  virtual uint8_t takeEvents(int deck) noexcept = 0;
};

// Factories of the backends. An empty function = the real module, except
// that an engine in NULL-device mode never touches a sound card: without an
// injected `enumerateOutputs` / `createOutput` it lists no device and
// refuses device.open.
struct EngineBackends {
  std::function<std::vector<DeviceInfo>(std::string* err)> enumerateOutputs;  // default: enumerateOutputDevices
  std::function<std::unique_ptr<AudioDevice>()> createOutput;                 // default: createSystemDevice
  // Process-wide endpoint notifications (Added, StateChanged, DefaultChanged,
  // FormatChanged); default: createDeviceWatcher. nullptr = none (the core
  // then relies on the output's own notifications and its periodic re-check).
  std::function<std::unique_ptr<DeviceWatcher>(DeviceEventFn fn)> createWatcher;
  std::function<std::unique_ptr<IPhonesOutput>()> createPhones;               // default: SecondaryOutput
  std::function<std::unique_ptr<IRecorder>()> createRecorder;                 // default: Recorder
  std::function<std::unique_ptr<IVstHost>()> createVstHost;                   // default: VstHost
};

// Test seams called by the audio thread (RT-safe code only; nullptr in
// production): after a snapshot is filled, before it is published; and for
// every command the dispatcher applies (what reached the audio thread).
using SnapshotHook = void (*)(void* user, om_state& s);
struct RtCommand;
using ApplyHook = void (*)(void* user, const RtCommand& c);

struct EngineOptions {
  // Tests and offline renders: the NULL device instead of WASAPI. The engine
  // then never touches a sound card (see EngineBackends).
  bool nullDevice = false;
  NullDeviceConfig nullConfig;
  // No thread at all: the caller drives everything with pump() and render()
  // (deterministic tests). Implies nullDevice with realtime = false; pump()
  // also runs the queued ops / vst-ops jobs. The engine clock is then the
  // sample clock (seconds rendered), continuous across device switches.
  bool manual = false;
  int stateHz = 60;           // maximum rate of the "state" event
  int heartbeatMs = 250;      // "hb" event period
  int stallMs = 500;          // no new block for this long while audio is expected = stall (one restart)
  int stalledMs = 2000;       // no audio this long after the stall = device {reason:"stalled"}
  int lossRetryMs = 2000;     // while the configured device is lost: re-check this often (plus device events)
  uint64_t maxPcmBytes = 0;   // PCM memory limit (0 = none)
  std::string dataDir;        // writable folder (recordings), UTF-8
  uintptr_t ownerWindow = 0;  // main window (HWND) owning the plugin editors; from main only (trusted)
  EngineBackends backends;
  // Test seams: called at the start of every ops / vst-ops job (route "ops" /
  // "vst", command name; may block to simulate a slow device or plugin), and
  // after each snapshot is filled (audio thread).
  std::function<void(const char* route, const char* cmd)> jobHook;
  SnapshotHook snapshotHook = nullptr;
  void* snapshotHookUser = nullptr;
  ApplyHook applyHook = nullptr;
  void* applyHookUser = nullptr;
};

// Trusted paths, given by main through the engine host (never by the ctl
// port): where vst.load may load plugins from (SPEC.md §15.6).
struct EnginePolicy {
  std::vector<std::string> vstRoots;  // VST3 folders (UTF-8, absolute)
  std::vector<std::string> vstFiles;  // plugin paths found by the last scans
};
// Parses {"vstRoots":[...], "vstFiles":[...]}.
bool parsePolicy(std::string_view json, EnginePolicy& out, std::string* err);
// True when `path` (UTF-8) is a .vst3 inside a root or in the scanned list,
// after normalization (no "..", no device or UNC prefix).
bool policyAllowsVst(const EnginePolicy& p, const std::string& path);

enum class CommandResult : uint8_t {
  Ok = 0,
  Invalid,  // malformed JSON or an invalid command: nothing applied
  Full,     // the command queue cannot take the whole message now: nothing applied, retry
};

// Counters of the engine's internal work (diagnostics and tests).
struct EngineStats {
  uint64_t fxUnitsCreated = 0;      // FX units allocated (panel units at start, pad / master on first use)
  uint64_t fxChainsCreated = 0;     // lazy FX unit chains allocated by the control thread
  uint64_t colorChainsCreated = 0;  // lazy Color FX chains allocated by the control thread
  uint64_t fxUnitsAttached = 0;     // AttachFxUnit applied by the audio thread
  uint64_t chainsAttached = 0;      // AttachFxChain / AttachColorChain taken by a unit
  uint64_t chainsDropped = 0;       // chains refused (made for an older preparation, or slot filled)
  uint64_t prepares = 0;            // module preparations (start + device rate changes)
  uint64_t outputOpens = 0;         // system output devices opened and started
  uint64_t stallRestarts = 0;       // streams restarted by the stall watchdog
  uint64_t unhandledCommands = 0;   // audio commands the dispatcher did not recognize (must stay 0)
  uint64_t controlIterations = 0;   // control-thread iterations (threaded) or pumps (manual)
  double maxControlGapMs = 0;       // longest interval between two control iterations (threaded)
  uint64_t blocks = 0;              // callbacks rendered
  int routing[4] = {0, 1, -1, -1};  // output channels applied by the audio thread: master L, R, cue L, R
};

class Engine {
 public:
  // Receives every event as one JSON text. Called on the control, ops or
  // vst-ops thread (or inside pump() / command() in manual mode), never on
  // the audio thread, serialized by the engine. Must not call back into the
  // engine synchronously.
  using EventSink = std::function<void(std::string_view json)>;

  explicit Engine(const EngineOptions& opt = EngineOptions());
  ~Engine();
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  // Starts the control, ops and vst-ops threads and the NULL device (paced
  // in real time unless manual, or unless nullDevice without
  // nullConfig.realtime); the real device is opened by "device.open". The
  // VST host starts with the first plugin. Returns false with a message on
  // failure.
  bool start(std::string* err);
  // Finalizes a running recording, closes the devices, stops the VST host
  // and joins every thread.
  void stop();
  bool running() const noexcept;
  void setEventSink(EventSink sink);
  void setPolicy(const EnginePolicy& p);

  // Any non-real-time thread (the host JS thread): parses one message
  // (object or batch array), reserves queue room for all of it, runs the
  // inline commands, pushes the audio commands, queues the ops / vst jobs.
  // Never blocks on a device, a file or a plugin.
  CommandResult command(std::string_view json, std::string* err);

  // PCM handoff data path (any non-real-time thread; see pcm.h).
  PcmError pcmBegin(const PcmDesc& d);
  PcmError pcmWrite(uint32_t loadId, int64_t offsetFrames, int frames, int channels, const float* planar);
  PcmError pcmEnd(uint32_t loadId);
  void pcmAbort(uint32_t loadId);

  // Latest snapshot published by the audio thread (lock-free copy).
  bool readState(om_state& out);
  EngineTime now() const noexcept;  // engine clock (the sample clock in manual mode)
  uint32_t epoch() const noexcept;  // connection epoch (hello {reset})
  EngineStats stats() const;

  // ---- manual mode (tests, offline renders) -----------------------------------
  void pump();                                // one control iteration + queued ops / vst jobs, on the caller's thread
  // NULL device: renders `frames` (whole blocks of the current NULL device);
  // returns frames rendered (0 while a system / fake device is the output:
  // the test drives that device itself).
  int render(float* out, int frames);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// "major.minor.patch[-tag]" of the native engine.
const char* engineVersion() noexcept;

}  // namespace om
