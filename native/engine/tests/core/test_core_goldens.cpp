// The golden renders of tools/make-goldens.js are complete and readable by
// the test helpers (owner: host): every case of <OM_GOLDEN_DIR>/index.json
// has its <case>.json, <case>.wav (readable by omtest::readWav with the
// rate, channels and frames the JSON announces, finite samples), its input
// file and the extra files it refers to (impulses, noise buffer), and the
// suites of SPEC.md §18.4 are all present. Other files in the folder (e.g.
// references a module generated itself) are not the generator's and are
// ignored. Skipped when OM_GOLDEN_DIR is unset. SPEC.md §18.4.
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <map>
#include <string>

#include "../om_test.h"
#include "om/json.h"

namespace fs = std::filesystem;

namespace {
bool readText(const fs::path& p, std::string& out) {
  std::FILE* f = nullptr;
#ifdef _WIN32
  if (_wfopen_s(&f, p.wstring().c_str(), L"rb") != 0) f = nullptr;
#else
  f = std::fopen(p.string().c_str(), "rb");
#endif
  if (!f) return false;
  char buf[65536];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
  std::fclose(f);
  return true;
}
}  // namespace

OM_TEST(core_goldens_are_complete_and_readable) {
  const std::string dirEnv = omtest::envString("OM_GOLDEN_DIR");
  if (dirEnv.empty()) OM_SKIP("OM_GOLDEN_DIR is not set (node tools/make-goldens.js)");
  const fs::path dir = dirEnv;  // (ASCII path: no u8path, deprecated in C++20)
  std::string text, err;
  if (!readText(dir / "index.json", text)) omtest::fail("index.json", __FILE__, __LINE__, (dir / "index.json").string());
  om::json::Value index;
  if (!om::json::parse(text, index, &err)) omtest::fail("index.json parses", __FILE__, __LINE__, err);
  std::map<std::string, int> perSuite;
  int cases = 0;
  const om::json::Value& list = index["cases"];
  OM_CHECK(list.isArray() && list.size() > 0);
  for (size_t i = 0; i < list.size(); i++) {
    const std::string suite = list.at(i)["suite"].asString();
    const std::string name = list.at(i)["case"].asString();
    OM_CHECK(!suite.empty() && !name.empty());
    const fs::path base = dir / suite / name;
    std::string jt;
    if (!readText(fs::path(base.string() + ".json"), jt)) omtest::fail("case json", __FILE__, __LINE__, base.string());
    om::json::Value meta;
    if (!om::json::parse(jt, meta, &err)) omtest::fail("case json parses", __FILE__, __LINE__, base.string() + ": " + err);
    OM_CHECK(meta["suite"].asString() == suite && meta["case"].asString() == name);
    omtest::Wav out, in;
    if (!omtest::readWav(base.string() + ".wav", out, &err)) omtest::fail("golden wav", __FILE__, __LINE__, err);
    OM_CHECK(out.sampleRate == static_cast<int>(meta["sampleRate"].asNumber(0)));
    OM_CHECK(out.channels == static_cast<int>(meta["channels"].asNumber(0)));
    OM_CHECK(out.frames() == static_cast<int64_t>(meta["frames"].asNumber(-1)));
    for (float v : out.samples)
      if (!std::isfinite(v)) omtest::fail("finite samples", __FILE__, __LINE__, base.string());
    // "<case>.input.wav" (encoded inputs keep their own extension, e.g. .aac)
    const fs::path inPath = dir / suite / meta["input"].asString();
    if (!fs::exists(inPath)) omtest::fail("golden input present", __FILE__, __LINE__, inPath.string());
    if (inPath.extension() == ".wav") {
      if (!omtest::readWav(inPath.string(), in, &err)) omtest::fail("golden input", __FILE__, __LINE__, err);
      OM_CHECK(in.frames() > 0 && in.sampleRate > 0);
    }
    for (const auto& k : meta["files"].keys()) {
      const fs::path extra = dir / meta["files"][k].asString();
      if (!fs::exists(extra)) omtest::fail("golden extra file", __FILE__, __LINE__, extra.string());
      if (extra.extension() == ".wav") {
        omtest::Wav w;
        if (!omtest::readWav(extra.string(), w, &err)) omtest::fail("golden extra wav", __FILE__, __LINE__, err);
      }
    }
    perSuite[suite]++;
    cases++;
  }
  for (const char* s : {"strip", "master", "limiter", "source", "fxunit", "color", "wsola", "decode"}) {
    if (perSuite[s] == 0) omtest::fail("suite present", __FILE__, __LINE__, s);
  }
  std::printf("[goldens] %d cases:", cases);
  for (const auto& kv : perSuite) std::printf(" %s %d", kv.first.c_str(), kv.second);
  std::printf("\n");
}
