// End-to-end test of keylock.precision on the REAL engine (owner: host;
// owner decision of 2026-11-09, SPEC.md §9.4, §15.3): a 440 Hz sine handed
// off as PCM, deck 0 keylocked with KEY -5 at tempo 1 (the worst of the 45
// cases of the deck campaign: pitch-worklet.js's whole-sample grain
// alignment leaves -1.54 cents), rendered through the whole chain (mixer,
// limiter) in manual mode on the NULL device (silent), the pitch measured on
// the master output from its upward zero crossings. Proves through the C API
// that the option is OFF by default (the worklet's error is there), that the
// command reaches the decks (within 0.5 cent once on), that hello {reset}
// keeps it (an engine setting, like sync.precision), and that off restores
// the worklet's alignment.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/om_engine.h"

namespace {

constexpr int kFs = 48000;
constexpr int kBlock = 256;
constexpr double kPi = 3.14159265358979323846;

bool command(om_engine* e, const std::string& j) {
  char err[256] = {0};
  return om_engine_command(e, j.data(), j.size(), err, sizeof(err)) == OM_OK;
}

// A 440 Hz sine (amplitude 0.5, float PCM) handed off under loadId.
bool handoffSine(om_engine* e, uint32_t loadId, double seconds) {
  const int64_t frames = static_cast<int64_t>(seconds * kFs);
  om_pcm_desc d;
  std::memset(&d, 0, sizeof(d));
  d.struct_size = sizeof(d);
  d.load_id = loadId;
  d.kind = OM_PCM_TRACK;
  d.format = OM_PCM_F32;
  d.source_channels = 2;
  d.sample_rate = kFs;
  d.frames = frames;
  d.headroom = 1.0f;
  d.peak = 0.5f;
  if (om_pcm_begin(e, &d) != OM_OK) return false;
  std::vector<float> planar(static_cast<size_t>(OM_PCM_CHUNK_FRAMES) * 2);
  for (int64_t off = 0; off < frames; off += OM_PCM_CHUNK_FRAMES) {
    const int n = static_cast<int>(std::min<int64_t>(OM_PCM_CHUNK_FRAMES, frames - off));
    for (int i = 0; i < n; i++) {
      const float v = static_cast<float>(0.5 * std::sin(2 * kPi * 440.0 * static_cast<double>(off + i) / kFs));
      planar[static_cast<size_t>(i)] = v;
      planar[static_cast<size_t>(n + i)] = v;
    }
    if (om_pcm_write(e, loadId, off, n, 2, planar.data()) != OM_OK) return false;
  }
  return om_pcm_end(e, loadId) == OM_OK;
}

// Loads loadId on deck 0 (0 = keep the loaded track), keylock on, key -5,
// plays it from 1 s for `seconds`, pauses, and returns the average pitch
// error (cents) of master L from 0.5 s on, against 440 x 2^(-5/12) Hz.
double playAndMeasure(om_engine* e, uint32_t loadId, double seconds, bool& ok) {
  if (loadId) {
    ok = ok && command(e, "{\"cmd\":\"deck.load\",\"deck\":0,\"loadId\":" + std::to_string(loadId) +
                              ",\"grid\":{\"bpm\":120,\"beatOffset\":0,\"gridShift\":0,\"barAnchor\":0,\"beats\":null}}");
    om_engine_pump(e);
  }
  ok = ok && command(e, R"({"cmd":"deck.keylock","deck":0,"on":true})");
  ok = ok && command(e, R"({"cmd":"deck.key","deck":0,"semi":-5})");
  ok = ok && command(e, R"({"cmd":"deck.seek","deck":0,"t":1.0})");
  ok = ok && command(e, R"({"cmd":"deck.play","deck":0})");
  const int64_t nBlocks = static_cast<int64_t>(seconds * kFs / kBlock);
  std::vector<float> buf(static_cast<size_t>(kBlock) * 4);
  std::vector<float> L;
  L.reserve(static_cast<size_t>(nBlocks * kBlock));
  for (int64_t b = 0; ok && b < nBlocks; b++) {
    if (om_engine_render(e, buf.data(), kBlock) != kBlock) ok = false;
    for (int i = 0; i < kBlock; i++) L.push_back(buf[static_cast<size_t>(i) * 4]);
    if (b % 10 == 0) om_engine_pump(e);
  }
  ok = ok && command(e, R"({"cmd":"deck.pause","deck":0})");
  om_engine_pump(e);
  std::vector<double> t;
  for (size_t i = static_cast<size_t>(0.5 * kFs); i < L.size(); i++)
    if (L[i - 1] < 0 && L[i] >= 0) t.push_back(static_cast<double>(i - 1) + L[i - 1] / (static_cast<double>(L[i - 1]) - L[i]));
  if (t.size() < 100) {
    ok = false;
    return 1e9;
  }
  const double hz = static_cast<double>(t.size() - 1) * kFs / (t.back() - t.front());
  return 1200.0 * std::log2(hz / (440.0 * std::pow(2.0, -5.0 / 12.0)));
}

}  // namespace

OM_TEST(core_keylock_precision_end_to_end_default_command_and_reset) {
  om_config cfg;
  om_config_init(&cfg);
  cfg.null_device = 1;
  cfg.manual = 1;
  cfg.null_sample_rate = kFs;
  cfg.null_block_frames = kBlock;
  cfg.null_channels = 4;
  cfg.null_latency_frames = 256;
  char err[256] = {0};
  om_engine* e = om_engine_create(&cfg, err, sizeof(err));
  if (!e) omtest::fail("om_engine_create", __FILE__, __LINE__, err);
  if (om_engine_start(e, err, sizeof(err)) != OM_OK) {
    om_engine_destroy(e);
    omtest::fail("om_engine_start", __FILE__, __LINE__, err);
  }
  bool ok = handoffSine(e, 200, 8.0);
  om_engine_pump(e);
  // 1) default: the worklet's own alignment (-1.54 cents at key -5)
  const double byDefault = playAndMeasure(e, 200, 3.0, ok);
  // 2) keylock.precision on: within half a cent
  ok = ok && command(e, R"({"cmd":"keylock.precision","on":true})");
  const double on = playAndMeasure(e, 0, 3.0, ok);
  // 3) hello {reset} (a renderer reload): the decks are unloaded, the option stays
  ok = ok && command(e, R"({"cmd":"hello","id":1,"protocol":2,"client":"test","reset":true})");
  om_engine_pump(e);
  ok = ok && handoffSine(e, 201, 8.0);
  om_engine_pump(e);
  const double afterReset = playAndMeasure(e, 201, 3.0, ok);
  // 4) off again: back to the worklet's alignment
  ok = ok && command(e, R"({"cmd":"keylock.precision","on":false})");
  const double off = playAndMeasure(e, 0, 3.0, ok);
  om_engine_stop(e);
  om_engine_destroy(e);
  std::printf("  [info] keylock key -5 at tempo 1 through the engine: default %+.3f cents, keylock.precision on %+.3f, "
              "after hello {reset} %+.3f, off again %+.3f\n",
              byDefault, on, afterReset, off);
  if (!ok) omtest::fail("handoff / command / render", __FILE__, __LINE__);
  OM_CHECK(std::fabs(byDefault) > 1.2);   // pitch-worklet.js's whole-sample alignment: off by default
  OM_CHECK(std::fabs(on) < 0.5);          // the command reached the decks
  OM_CHECK(std::fabs(afterReset) < 0.5);  // kept by hello {reset}
  OM_CHECK(std::fabs(off) > 1.2);         // and switched off on request
}
