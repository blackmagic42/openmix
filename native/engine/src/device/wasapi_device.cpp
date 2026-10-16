// WASAPI output device: event-driven render thread (MMCSS "Pro Audio"),
// shared mode, low-latency shared mode through IAudioClient3, exclusive
// mode with format negotiation, device-loss handling (owner: device).
// SKELETON: open() reports "not implemented". SPEC.md §6.
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>

#include "om/device.h"

namespace om {

namespace {

class WasapiDevice final : public AudioDevice {
 public:
  bool open(const DeviceConfig&, IRenderCallback*, std::string* err) override {
    if (err) *err = "WASAPI device not implemented yet";
    return false;
  }
  bool start(std::string* err) override {
    if (err) *err = "WASAPI device not implemented yet";
    return false;
  }
  void stop() override {}
  void close() override {}
  DeviceStatus status() const override { return DeviceStatus(); }
  void setEventHandler(DeviceEventFn fn) override { onEvent_ = std::move(fn); }

 private:
  DeviceEventFn onEvent_;
};

}  // namespace

std::unique_ptr<AudioDevice> createWasapiDevice() { return std::make_unique<WasapiDevice>(); }

const char* deviceModeName(DeviceMode m) noexcept {
  switch (m) {
    case DeviceMode::Closed: return "closed";
    case DeviceMode::Null: return "null";
    case DeviceMode::Shared: return "shared";
    case DeviceMode::SharedLowLatency: return "shared-lowlat";
    case DeviceMode::Exclusive: return "exclusive";
  }
  return "closed";
}

}  // namespace om
