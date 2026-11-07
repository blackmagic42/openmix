// Endpoint list rules of the device layer (owner: device, private header):
// Chromium's order and nameIndex numbering of an enumeration, the resolution
// rule that matched a configuration, and the strict matching used to reopen
// the CONFIGURED endpoint after a loss (never another one). Portable,
// implemented in device_common.cpp. SPEC.md §8.1, §8.4.
#pragma once

#include <string>
#include <vector>

#include "om/device.h"

namespace om {
namespace dev {

// Active endpoints first, each group in enumeration order (EnumAudioEndpoints
// = Chromium's order); nameIndex = rank among the endpoints of the same
// group with the same label.
void finalizeEndpointList(std::vector<DeviceInfo>& list);

enum class ResolveRule : int { None = -1, Id = 0, ExactName = 1, CaseInsensitive = 2, Prefix = 3, RoleDefault = 4 };
// resolveOutputDevice() with the rule that matched.
std::string resolveOutputDeviceRule(const DeviceConfig& cfg, const std::vector<DeviceInfo>& devices, ResolveRule* rule);

// What was actually opened (to find it again).
struct OpenedEndpoint {
  std::string id, name;
  int nameIndex = 0;
  bool substitute = false;  // the configured name / id was missing: the role's default was opened instead
};
// The endpoint to reopen after a loss: followDefault -> the role's current
// default; else the opened id, else the opened label + nameIndex (active
// endpoints only). A substitute is replaced by the configured endpoint as
// soon as it is present (exact label, or id). Empty when absent.
std::string matchConfiguredEndpoint(const DeviceConfig& cfg, const OpenedEndpoint& opened,
                                    const std::vector<DeviceInfo>& devices);
const DeviceInfo* findEndpoint(const std::vector<DeviceInfo>& devices, const std::string& id);

// Chromium's label rule on Windows: the friendly name, plus " (vid:pid)" in
// lowercase hex when the endpoint's controller is a USB device (its PnP
// instance id "USB\VID_0020&PID_0B21&MI_00\..." gives "0020:0b21").
std::string usbModelIdFromInstanceId(const std::string& instanceId);
std::string chromiumLabel(const std::string& friendlyName, const std::string& modelId);

}  // namespace dev
}  // namespace om
