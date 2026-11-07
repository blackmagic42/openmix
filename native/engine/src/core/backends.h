// Private header of the core (owner: host): the default backends behind the
// seams of engine.h (IPhonesOutput over SecondaryOutput, IRecorder over
// Recorder, IVstHost over VstHost, the system device and its enumeration),
// and the device helpers shared by the ops-thread code: the configured-
// endpoint match used for restores (never the role's default unless the
// configuration follows it), the output routing rule of engine.js
// _wireOutput, and the JSON of a device status. SPEC.md §8.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "om/device.h"
#include "om/engine.h"
#include "om/json.h"

namespace om {
namespace core {

std::unique_ptr<IPhonesOutput> makeDefaultPhones();
std::unique_ptr<IRecorder> makeDefaultRecorder();
std::unique_ptr<IVstHost> makeDefaultVstHost();

// Output channels of the master and the cue (engine.js _wireOutput): master
// on 1/2 (1 only on a mono device), cue on 3/4 when the device has >= 4
// channels and no headphones card is set; -1 = not routed.
struct Routing {
  int masterL = 0, masterR = 1, cueL = -1, cueR = -1;
};
Routing outputRouting(int channels, bool phonesSet) noexcept;

// The endpoint the user configured, as it appears in `list` now: exact id;
// else exact name with the same nameIndex (else the first endpoint with that
// exact name); the default endpoint of the role only when the configuration
// follows the default. Empty string when it is not there (lost, unplugged).
// Unlike resolveOutputDevice() this never falls back to another endpoint:
// a lost FLX6 must never be "restored" on the laptop speakers.
std::string matchConfiguredEndpoint(const DeviceConfig& cfg, const std::vector<DeviceInfo>& list);

// {"mode","id","name","sampleRate","channels","channelMask","periodFrames",
//  "bufferFrames","periodSteps","latencyMs","jitterMs","format","running",
//  "lost","fellBack","fallbackReason","raw","glitches"}
json::Value deviceStatusJson(const DeviceStatus& st);
// One entry of the device.list reply.
json::Value deviceInfoJson(const DeviceInfo& d);
// Parses the device fields of device.open / device.phones ("name",
// "nameIndex", "deviceId", "role", "followDefault", "mode", "periodFrames",
// "sampleRate", "raw"). False with *err on a bad value.
bool parseDeviceConfig(const json::Value& body, DeviceConfig& out, std::string* err);

}  // namespace core
}  // namespace om
