// Engine core (owner: host): owns the decks, mixer, sync engine, decoder,
// VST host, recorder and devices; runs the control thread (JSON commands,
// device lifecycle, decode completions, state events at ~60 Hz, deletion of
// retired objects) and implements the device render callback (command
// dispatch, sync tick, decks, mixer, output routing, recorder and phones
// taps, state publication). Used by the Node-API binding and by the tests.
// SPEC.md §3, §14.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "om/common.h"
#include "om/device.h"

namespace om {

struct EngineOptions {
  // Tests and offline renders: the NULL device instead of WASAPI. The engine
  // then never touches a sound card.
  bool nullDevice = false;
  NullDeviceConfig nullConfig;
  // No control thread: the caller drives the control work with pumpControl()
  // (deterministic tests). Implies nullDevice with realtime = false.
  bool manualControl = false;
  int stateHz = 60;        // rate of the "state" event
  int decoderThreads = 1;
  std::string dataDir;     // writable folder (logs, temporary recordings)
};

class Engine {
 public:
  // Receives every event: `json` text and an optional binary attachment.
  // Called on the control thread (or inside pumpControl() in manual mode).
  using EventSink = std::function<void(std::string json, std::vector<uint8_t> blob)>;

  explicit Engine(const EngineOptions& opt = EngineOptions());
  ~Engine();
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  // Starts the control, decoder and VST host threads. The real audio device
  // is only opened by the "device.open" command (the NULL device is opened
  // here). Returns false with a message on failure.
  bool start(std::string* err);
  void stop();             // closes the devices and joins every thread
  bool running() const noexcept;

  // Thread-safe: queues one JSON command (and its binary attachment, if any).
  void post(std::string json, std::vector<uint8_t> blob = {});
  void setEventSink(EventSink sink);

  // ---- manual / offline mode (tests) ----------------------------------------
  void pumpControl();                         // one control iteration on the caller's thread
  int renderOffline(int blocks, float* out);  // NULL device: render `blocks` blocks (out may be nullptr)
  EngineTime now() const noexcept;            // engine clock (virtual in offline mode)

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// "major.minor.patch[-tag]" of the native engine.
const char* engineVersion() noexcept;

}  // namespace om
