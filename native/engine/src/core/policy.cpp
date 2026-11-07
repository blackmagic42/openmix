// Trusted path policy of the engine (owner: host): which plugin files
// vst.load may open, as given by main through the engine host (never by the
// renderer's ctl port): the VST3 folders and the files found by the scans.
// Paths are compared case-insensitively after normalization; "..", device
// and UNC prefixes are refused. SPEC.md §15.6.
#include <algorithm>
#include <cctype>

#include "om/engine.h"
#include "om/json.h"

namespace om {

namespace {

// Lower-case, forward slashes turned into backslashes, no trailing separator.
std::string norm(const std::string& p) {
  std::string s = p;
  for (char& c : s) {
    if (c == '/') c = '\\';
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  while (s.size() > 3 && s.back() == '\\') s.pop_back();
  return s;
}

bool unsafe(const std::string& n) {
  if (n.size() < 3) return true;
  if (n.rfind("\\\\", 0) == 0) return true;  // UNC, \\?\ and \\.\ device paths
  if (n.find("..") != std::string::npos) return true;
  // absolute drive path only: "c:\..."
  return !(std::isalpha(static_cast<unsigned char>(n[0])) && n[1] == ':' && n[2] == '\\');
}

bool hasVst3Extension(const std::string& n) {
  return n.size() > 5 && n.compare(n.size() - 5, 5, ".vst3") == 0;
}

}  // namespace

bool parsePolicy(std::string_view text, EnginePolicy& out, std::string* err) {
  json::Value v;
  if (!json::parse(text, v, err)) return false;
  if (!v.isObject()) {
    if (err) *err = "policy must be an object";
    return false;
  }
  EnginePolicy p;
  for (const char* key : {"vstRoots", "vstFiles"}) {
    const json::Value& a = v[key];
    if (a.isNull()) continue;
    if (!a.isArray()) {
      if (err) *err = std::string("policy: \"") + key + "\" must be an array of strings";
      return false;
    }
    for (size_t i = 0; i < a.size(); i++) {
      if (!a.at(i).isString()) continue;
      (std::string(key) == "vstRoots" ? p.vstRoots : p.vstFiles).push_back(a.at(i).asString());
    }
  }
  out = std::move(p);
  return true;
}

bool policyAllowsVst(const EnginePolicy& p, const std::string& path) {
  const std::string n = norm(path);
  if (unsafe(n) || !hasVst3Extension(n)) return false;
  for (const auto& f : p.vstFiles)
    if (norm(f) == n) return true;
  for (const auto& r : p.vstRoots) {
    const std::string root = norm(r);
    if (unsafe(root)) continue;
    if (n.size() > root.size() + 1 && n.compare(0, root.size(), root) == 0 && n[root.size()] == '\\') return true;
  }
  return false;
}

}  // namespace om
