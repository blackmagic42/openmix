// Portable part of the device layer (owner: device): mode names and the
// endpoint resolution rules (id > exact name + nameIndex > case-insensitive
// name > name prefix > default endpoint of the role), Chromium's order and
// nameIndex numbering of an enumeration, and the strict matching that finds
// the configured endpoint again after a loss — shared by every backend and
// tested without a sound card. SPEC.md §8.1, §8.4.
#include <algorithm>
#include <cctype>
#include <cstring>
#include <map>

#include "endpoints.h"
#include "om/device.h"

namespace om {

namespace {
std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}
}  // namespace

const char* outputModeName(OutputMode m) noexcept {
  switch (m) {
    case OutputMode::Shared: return "shared";
    case OutputMode::SharedLowLatency: return "lowlatency";
    case OutputMode::Exclusive: return "exclusive";
  }
  return "shared";
}

bool outputModeFromName(const char* n, OutputMode& out) noexcept {
  if (!n) return false;
  if (std::strcmp(n, "shared") == 0) out = OutputMode::Shared;
  else if (std::strcmp(n, "lowlatency") == 0) out = OutputMode::SharedLowLatency;
  else if (std::strcmp(n, "exclusive") == 0) out = OutputMode::Exclusive;
  else return false;
  return true;
}

const char* deviceModeName(DeviceMode m) noexcept {
  switch (m) {
    case DeviceMode::Closed: return "closed";
    case DeviceMode::Null: return "null";
    case DeviceMode::Shared: return "shared";
    case DeviceMode::SharedLowLatency: return "lowlatency";
    case DeviceMode::Exclusive: return "exclusive";
  }
  return "closed";
}

const char* deviceChangeName(DeviceChange c) noexcept {
  switch (c) {
    case DeviceChange::Opened: return "opened";
    case DeviceChange::Lost: return "lost";
    case DeviceChange::Restored: return "restored";
    case DeviceChange::DefaultChanged: return "defaultChanged";
    case DeviceChange::Reopened: return "reopened";
    case DeviceChange::PeriodStep: return "periodStep";
    case DeviceChange::Failed: return "failed";
  }
  return "opened";
}

namespace dev {

void finalizeEndpointList(std::vector<DeviceInfo>& list) {
  std::stable_partition(list.begin(), list.end(), [](const DeviceInfo& d) { return d.active; });
  std::map<std::string, int> activeSeen, inactiveSeen;
  for (DeviceInfo& d : list) {
    auto& seen = d.active ? activeSeen : inactiveSeen;
    d.nameIndex = seen[d.name]++;
    if (!d.active) d.isDefault = d.isDefaultComms = false;
  }
}

std::string resolveOutputDeviceRule(const DeviceConfig& cfg, const std::vector<DeviceInfo>& devices, ResolveRule* rule) {
  auto done = [&](ResolveRule r, const std::string& id) {
    if (rule) *rule = r;
    return id;
  };
  if (!cfg.id.empty()) {
    for (const auto& d : devices)
      if (d.active && d.id == cfg.id) return done(ResolveRule::Id, d.id);
  }
  if (!cfg.name.empty()) {
    // Exact label; several endpoints may share it: nameIndex picks the n-th
    // one in Chromium's order (the order of `devices`).
    int seen = 0;
    std::string firstExact;
    for (const auto& d : devices) {
      if (!d.active || d.name != cfg.name) continue;
      if (firstExact.empty()) firstExact = d.id;
      if (seen++ == cfg.nameIndex) return done(ResolveRule::ExactName, d.id);
    }
    if (!firstExact.empty()) return done(ResolveRule::ExactName, firstExact);
    const std::string want = lower(cfg.name);
    for (const auto& d : devices)
      if (d.active && lower(d.name) == want) return done(ResolveRule::CaseInsensitive, d.id);
    for (const auto& d : devices)
      if (d.active && lower(d.name).rfind(want, 0) == 0) return done(ResolveRule::Prefix, d.id);
  }
  for (const auto& d : devices) {
    if (d.active && (cfg.role == DeviceRole::Communications ? d.isDefaultComms : d.isDefault))
      return done(ResolveRule::RoleDefault, d.id);
  }
  return done(ResolveRule::None, std::string());
}

std::string usbModelIdFromInstanceId(const std::string& instanceId) {
  auto find = [&](const char* key) -> size_t {
    for (size_t i = 0; i + 4 <= instanceId.size(); i++) {
      bool m = true;
      for (size_t k = 0; k < 4 && m; k++) m = std::toupper(static_cast<unsigned char>(instanceId[i + k])) == key[k];
      if (m) return i + 4;
    }
    return std::string::npos;
  };
  auto hex4 = [&](size_t pos, std::string& out) {
    if (pos == std::string::npos || pos + 4 > instanceId.size()) return false;
    for (size_t k = 0; k < 4; k++) {
      const unsigned char c = static_cast<unsigned char>(instanceId[pos + k]);
      if (!std::isxdigit(c)) return false;
      out += static_cast<char>(std::tolower(c));
    }
    return true;
  };
  std::string vid, pid;
  if (!hex4(find("VID_"), vid) || !hex4(find("PID_"), pid)) return {};
  return vid + ":" + pid;
}

std::string chromiumLabel(const std::string& friendlyName, const std::string& modelId) {
  return modelId.empty() ? friendlyName : friendlyName + " (" + modelId + ")";
}

const DeviceInfo* findEndpoint(const std::vector<DeviceInfo>& devices, const std::string& id) {
  for (const auto& d : devices)
    if (d.id == id) return &d;
  return nullptr;
}

std::string matchConfiguredEndpoint(const DeviceConfig& cfg, const OpenedEndpoint& opened,
                                    const std::vector<DeviceInfo>& devices) {
  if (cfg.followDefault) {
    for (const auto& d : devices)
      if (d.active && (cfg.role == DeviceRole::Communications ? d.isDefaultComms : d.isDefault)) return d.id;
    return {};
  }
  if (opened.substitute) {
    // The configured endpoint was missing at open time: take it as soon as it
    // is there (by id, or by its exact label), else keep the substitute.
    if (!cfg.id.empty()) {
      const DeviceInfo* d = findEndpoint(devices, cfg.id);
      if (d && d->active) return d->id;
    }
    if (!cfg.name.empty()) {
      int seen = 0;
      std::string first;
      for (const auto& d : devices) {
        if (!d.active || d.name != cfg.name) continue;
        if (first.empty()) first = d.id;
        if (seen++ == cfg.nameIndex) return d.id;
      }
      if (!first.empty()) return first;
    }
  }
  if (!opened.id.empty()) {
    const DeviceInfo* d = findEndpoint(devices, opened.id);
    if (d && d->active) return d->id;
  }
  if (!opened.name.empty()) {
    // Same label and the same rank among the endpoints with that label
    // (a USB device plugged into another port comes back with a new id).
    int seen = 0;
    for (const auto& d : devices) {
      if (!d.active || d.name != opened.name) continue;
      if (seen++ == opened.nameIndex) return d.id;
    }
  }
  if (opened.substitute) {
    const DeviceInfo* d = findEndpoint(devices, opened.id);
    if (d && d->active) return d->id;
  }
  return {};
}

}  // namespace dev

std::string resolveOutputDevice(const DeviceConfig& cfg, const std::vector<DeviceInfo>& devices) {
  return dev::resolveOutputDeviceRule(cfg, devices, nullptr);
}

}  // namespace om
