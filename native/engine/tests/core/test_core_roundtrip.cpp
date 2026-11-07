// Round trip through the real process wiring (owner: host): runs
// tests/core/roundtrip/run-roundtrip.js with Node, which starts the Electron
// of node_modules (ELECTRON_RUN_AS_NODE removed, temp userData, hidden
// window, every non-file request blocked) on a test main script that
// installs engine-main.js, loads the real preload.js and drives
// window.omEngine from a test page: engine host utilityProcess, two
// MessageChannelMain per connection, hello, float32 PCM chunks posted
// without a transfer list, pcm acks, state events, the VST scan and shadow
// helpers, recordings saved by a verified copy, kill + engine-exit. It never
// starts OpenMix itself and never touches its ports; the Electron process
// exits on its own (killed by PID only on a time-out). Needs a built
// openmix_engine.node: OM_ENGINE_NODE=<path>, else
// native/engine/build/Release/openmix_engine.node; skipped when absent or
// with OM_TEST_NO_ELECTRON=1. SPEC.md §2, §6.4, §6.5.
#include <filesystem>
#include <string>
#include <vector>

#include "../om_test.h"

#ifdef _WIN32
#include <process.h>
#endif

namespace fs = std::filesystem;

namespace {
fs::path thisDir() { return fs::path(__FILE__).parent_path(); }  // .../native/engine/tests/core
fs::path repoRoot() { return thisDir().parent_path().parent_path().parent_path().parent_path(); }

#ifdef _WIN32
std::wstring quoteArg(const std::wstring& a) {
  // CommandLineToArgvW rules: quotes around, backslashes before a quote doubled.
  std::wstring out = L"\"";
  size_t bs = 0;
  for (wchar_t c : a) {
    if (c == L'\\') {
      bs++;
      continue;
    }
    if (c == L'"') {
      out.append(bs * 2 + 1, L'\\');
      out += L'"';
    } else {
      out.append(bs, L'\\');
      out += c;
    }
    bs = 0;
  }
  out.append(bs * 2, L'\\');
  return out + L"\"";
}
#endif
}  // namespace

OM_TEST(core_engine_host_round_trip_in_electron) {
  if (omtest::envFlag("OM_TEST_NO_ELECTRON")) OM_SKIP("OM_TEST_NO_ELECTRON=1");
#ifndef _WIN32
  OM_SKIP("openmix_engine.node is Windows-only for now");
#else
  std::string module = omtest::envString("OM_ENGINE_NODE");
  if (module.empty()) module = (repoRoot() / "native" / "engine" / "build" / "Release" / "openmix_engine.node").string();
  if (!fs::exists(module)) OM_SKIP("no openmix_engine.node (build it, or set OM_ENGINE_NODE)");
  const fs::path script = thisDir() / "roundtrip" / "run-roundtrip.js";
  OM_CHECK(fs::exists(script));
  const fs::path result = fs::temp_directory_path() / "om-roundtrip-result.json";
  std::error_code ec;
  fs::remove(result, ec);
  // No shell: argv quoted for CreateProcess (the paths contain spaces).
  std::vector<std::wstring> args = {L"node", quoteArg(script.wstring()), L"--module", quoteArg(fs::path(module).wstring()),
                                    L"--result", quoteArg(result.wstring())};
  std::vector<const wchar_t*> argv;
  for (auto& a : args) argv.push_back(a.c_str());
  argv.push_back(nullptr);
  const intptr_t code = _wspawnvp(_P_WAIT, L"node", argv.data());
  std::printf("[roundtrip] node exited with %d (details: %s)\n", static_cast<int>(code), result.string().c_str());
  OM_CHECK(code == 0);
  OM_CHECK(fs::exists(result));
#endif
}
