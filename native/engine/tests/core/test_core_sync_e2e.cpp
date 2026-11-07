// End-to-end phase test of the sync on the REAL engine (owner: host; from the
// sync-phase campaign's harness, 7 Nov 2026,
// HANDOFF/refs/native/verify-backups/sync-phase/harness/proj/sync_e2e.cpp,
// scenario "steady" shortened from 600 s to 60 s). om_test_sync links only
// om_sync and drives fake decks; this test proves the lock on the real decks
// (heard positions, seeks, render) through the flat C API: two click tracks
// (128 vs 123.4 BPM) handed off as PCM, manual mode on the NULL device
// (silent), rendered block by block, SYNC on deck B 5.5 s after deck A
// started. Every click is a 2 ms Hann pulse centred on a TRUE beat (deck A's
// on master L, deck B's on master R); its time in the output is the energy
// centroid of the pulse (sub-sample). Phase error = deck B's click time -
// nearest deck A click time, measured on the RENDERED AUDIO from SYNC + 30 s
// to the end. Grids: exact (fixed grid, exact BPM) and realistic (true tempi
// not round, BPM field rounded to 0.1, dynamic beats with +-0.3 ms noise);
// both modes of sync.precision (off = engine.js parity, the default).
// Targets (SPEC.md §12): exact grids p99 < 0.05 ms in both modes; realistic
// grids p99 < 1.0 ms (parity) and < 0.4 ms (precision).
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/om_engine.h"
#include "om/om_state.h"

namespace {

constexpr int kFs = 48000;
constexpr int kBlockFrames = 256;
constexpr double kPi = 3.14159265358979323846;
constexpr int kPulse = 96;         // Hann pulse width in samples (2 ms)
constexpr float kPulseAmp = 0.5f;  // peak of the click in the track

struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed ? seed : 0x9E3779B97F4A7C15ull) {}
  uint64_t next() {
    s ^= s >> 12;
    s ^= s << 25;
    s ^= s >> 27;
    return s * 0x2545F4914F6CDD1Dull;
  }
  double uniform() { return static_cast<double>(next() >> 11) * (1.0 / 9007199254740992.0); }
  double sym(double a) { return (uniform() * 2 - 1) * a; }
};

// A click track: clicks on the TRUE beats t0 + k * 60 / trueBpm, and the grid
// the "analysis" gives the engine (dynamic beats with noise, or a fixed grid).
struct TrackSpec {
  double trueBpm = 128;
  double t0 = 0.1;
  double dur = 120;
  double bpmField = 128;
  double noise = 0.0003;
  bool fixedGrid = false;
  int chanMask = 3;  // 1 = L, 2 = R
  uint64_t seed = 1;
  double period() const { return 60.0 / trueBpm; }
};

std::string num(double v) {
  char b[64];
  std::snprintf(b, sizeof(b), "%.17g", v);
  return b;
}

std::string gridJson(const TrackSpec& t) {
  std::string s = "{\"bpm\":" + num(t.bpmField) + ",\"beatOffset\":" + num(t.t0) + ",\"gridShift\":0,\"barAnchor\":0,\"beats\":";
  if (t.fixedGrid) return s + "null}";
  Rng rng(t.seed * 7919 + 17);
  s += "[";
  const double P = t.period();
  for (int k = 0; t.t0 + k * P <= t.dur; k++) {
    if (k) s += ",";
    char b[40];
    std::snprintf(b, sizeof(b), "%.9f", t.t0 + k * P + (t.noise > 0 ? rng.sym(t.noise) : 0.0));
    s += b;
  }
  return s + "]}";
}

struct Events {
  int errors = 0, syncFail = 0;
  std::string firstError;
  static void sink(void* user, const char* json, size_t len) {
    auto* e = static_cast<Events*>(user);
    const std::string s(json, len);
    if (s.find("\"ev\":\"error\"") != std::string::npos || s.find("\"ok\":false") != std::string::npos) {
      if (s.find("sync.result") != std::string::npos) e->syncFail++;
      else e->errors++;
      if (e->firstError.empty()) e->firstError = s.substr(0, 300);
    }
  }
};

bool command(om_engine* e, const std::string& j) {
  char err[256] = {0};
  return om_engine_command(e, j.data(), j.size(), err, sizeof(err)) == OM_OK;
}

bool handoff(om_engine* e, uint32_t loadId, const TrackSpec& t) {
  const int64_t frames = static_cast<int64_t>(t.dur * kFs);
  om_pcm_desc d;
  std::memset(&d, 0, sizeof(d));
  d.struct_size = sizeof(d);
  d.load_id = loadId;
  d.kind = OM_PCM_TRACK;
  d.format = OM_PCM_S16;
  d.source_channels = 2;
  d.sample_rate = kFs;
  d.frames = frames;
  d.headroom = 1.0f;
  d.peak = kPulseAmp;
  if (om_pcm_begin(e, &d) != OM_OK) return false;
  std::vector<float> planar(static_cast<size_t>(OM_PCM_CHUNK_FRAMES) * 2);
  const double P = t.period();
  const double half = 0.5 * kPulse / kFs;
  for (int64_t off = 0; off < frames; off += OM_PCM_CHUNK_FRAMES) {
    const int n = static_cast<int>(std::min<int64_t>(OM_PCM_CHUNK_FRAMES, frames - off));
    float* L = planar.data();
    float* R = planar.data() + n;
    for (int i = 0; i < n; i++) {
      const double tt = static_cast<double>(off + i) / kFs;
      const double k = std::round((tt - t.t0) / P);
      const double dt = tt - (t.t0 + k * P);
      float v = 0.0f;
      if (k >= 0 && std::fabs(dt) < half) v = kPulseAmp * static_cast<float>(0.5 * (1.0 + std::cos(kPi * dt / half)));
      L[i] = (t.chanMask & 1) ? v : 0.0f;
      R[i] = (t.chanMask & 2) ? v : 0.0f;
    }
    if (om_pcm_write(e, loadId, off, n, 2, planar.data()) != OM_OK) return false;
  }
  return om_pcm_end(e, loadId) == OM_OK;
}

// Clicks in one output channel: a pulse is found by its core (|x| > thr; the
// int16 track carries +-1 LSB of dither between clicks), its time is the
// energy centroid over +-kHalfWin samples around the core's peak.
struct ClickDetector {
  static constexpr int kRing = 1024;
  static constexpr int kHalfWin = 112;
  float ring[kRing] = {};
  double thr = 0.02;
  bool above = false;
  int64_t lastAbove = -1, peakAt = -1, pendingAt = -1;
  double peak = 0;
  std::vector<double> clicks;  // seconds on the output timeline
  void finalize(int64_t p) {
    double sx2 = 0, snx2 = 0;
    for (int64_t n = p - kHalfWin; n <= p + kHalfWin; n++) {
      const double x = ring[n & (kRing - 1)];
      sx2 += x * x;
      snx2 += x * x * static_cast<double>(n - p);
    }
    if (sx2 > 0) clicks.push_back((static_cast<double>(p) + snx2 / sx2) / kFs);
  }
  void feed(int64_t n, float x) {
    ring[n & (kRing - 1)] = x;
    const double a = std::fabs(x);
    if (a > thr) {
      if (!above) {
        above = true;
        peak = 0;
      }
      if (a > peak) {
        peak = a;
        peakAt = n;
      }
      lastAbove = n;
    } else if (above && n - lastAbove > 8) {
      above = false;
      if (pendingAt >= 0) finalize(pendingAt);
      pendingAt = peakAt;
    }
    if (pendingAt >= 0 && n >= pendingAt + kHalfWin) {
      finalize(pendingAt);
      pendingAt = -1;
    }
  }
};

double nearestDiff(const std::vector<double>& ref, double t) {
  if (ref.empty()) return NAN;
  auto it = std::lower_bound(ref.begin(), ref.end(), t);
  double best = NAN;
  if (it != ref.end()) best = t - *it;
  if (it != ref.begin()) {
    const double d = t - *(it - 1);
    if (!(std::fabs(best) <= std::fabs(d))) best = d;
  }
  return best;
}

struct Result {
  size_t n = 0;  // follower clicks in the locked window
  double p99Ms = 0, maxMs = 0, meanMs = 0;
  size_t clicksA = 0, clicksB = 0;
  int errors = 0, syncFail = 0;
  std::string firstError;
};

// The harness's "steady" scenario, pair "128 vs 123.4" (exact: "128 vs 123"),
// seed 1: deck A is the master (first started), deck B follows (SYNC).
Result runSteady(bool exact, bool precision, double seconds) {
  const double trueA = exact ? 128.0 : 127.93, fieldA = 128.0;
  const double trueB = exact ? 123.0 : 123.37, fieldB = exact ? 123.0 : 123.4;
  TrackSpec a, b;
  a.trueBpm = trueA;
  a.bpmField = fieldA;
  a.t0 = 0.081;
  a.dur = seconds + 60;
  a.chanMask = 1;
  a.seed = 11;
  b.trueBpm = trueB;
  b.bpmField = fieldB;
  b.t0 = 0.043;
  b.dur = seconds + 90;
  b.chanMask = 2;
  b.seed = 12;
  for (TrackSpec* t : {&a, &b}) {
    t->noise = exact ? 0.0 : 0.0003;
    t->fixedGrid = exact;
  }
  Result res;
  om_config cfg;
  om_config_init(&cfg);
  cfg.null_device = 1;
  cfg.manual = 1;
  cfg.null_sample_rate = kFs;
  cfg.null_block_frames = kBlockFrames;
  cfg.null_channels = 4;
  cfg.null_latency_frames = 256;
  char err[256] = {0};
  om_engine* e = om_engine_create(&cfg, err, sizeof(err));
  if (!e) omtest::fail("om_engine_create", __FILE__, __LINE__, err);
  Events ev;
  om_engine_set_event_callback(e, &Events::sink, &ev);
  if (om_engine_start(e, err, sizeof(err)) != OM_OK) {
    om_engine_destroy(e);
    omtest::fail("om_engine_start", __FILE__, __LINE__, err);
  }
  bool ok = handoff(e, 100, a) && handoff(e, 101, b);
  ok = ok && command(e, "{\"cmd\":\"deck.load\",\"deck\":0,\"loadId\":100,\"grid\":" + gridJson(a) + "}");
  ok = ok && command(e, "{\"cmd\":\"deck.load\",\"deck\":1,\"loadId\":101,\"grid\":" + gridJson(b) + "}");
  om_engine_pump(e);
  struct Timed {
    double t;
    std::string json;
  };
  const std::vector<Timed> cmds = {
      {0.0, std::string("{\"cmd\":\"sync.precision\",\"on\":") + (precision ? "true" : "false") + "}"},
      {0.0, R"({"cmd":"deck.play","deck":0})"},
      {5.0, R"({"cmd":"deck.seek","deck":1,"t":31.0})"},
      {5.0, R"({"cmd":"deck.play","deck":1})"},
      {5.5, R"({"cmd":"sync.do","deck":1})"},
  };
  const double total = 5.5 + seconds + 0.5;
  const int64_t nBlocks = static_cast<int64_t>(std::ceil(total * kFs / kBlockFrames));
  std::vector<float> buf(static_cast<size_t>(kBlockFrames) * 4);
  ClickDetector det[2];
  size_t ci = 0;
  int64_t frame = 0;
  for (int64_t blk = 0; ok && blk < nBlocks; blk++) {
    const double T = static_cast<double>(frame) / kFs;
    while (ok && ci < cmds.size() && cmds[ci].t <= T + 1e-9) ok = command(e, cmds[ci++].json);
    if (om_engine_render(e, buf.data(), kBlockFrames) != kBlockFrames) ok = false;
    for (int i = 0; i < kBlockFrames; i++)
      for (int c = 0; c < 2; c++) det[c].feed(frame + i, buf[static_cast<size_t>(i) * 4 + c]);
    frame += kBlockFrames;
    if (blk % 10 == 0) om_engine_pump(e);  // events (as the host would read them)
  }
  for (ClickDetector& d : det) {
    d.feed(frame + 1000, 0.0f);
    d.feed(frame + 2000, 0.0f);
  }
  om_engine_pump(e);
  om_engine_stop(e);
  om_engine_destroy(e);
  if (!ok) omtest::fail("handoff / command / render", __FILE__, __LINE__);
  res.clicksA = det[0].clicks.size();
  res.clicksB = det[1].clicks.size();
  res.errors = ev.errors;
  res.syncFail = ev.syncFail;
  res.firstError = ev.firstError;
  // phase error of B against A from SYNC + 30 s to the end
  const double halfBeat = 0.5 * std::min(a.period(), b.period());
  std::vector<double> es;
  for (double t : det[1].clicks) {
    if (t < 35.5) continue;
    const double d = nearestDiff(det[0].clicks, t);
    if (!std::isfinite(d) || std::fabs(d) > halfBeat) continue;
    es.push_back(d * 1000.0);
  }
  res.n = es.size();
  if (es.empty()) return res;
  double sum = 0;
  for (double x : es) sum += x;
  res.meanMs = sum / static_cast<double>(es.size());
  for (double& x : es) x = std::fabs(x);
  std::sort(es.begin(), es.end());
  res.p99Ms = es[std::min(es.size() - 1, static_cast<size_t>(std::floor(0.99 * static_cast<double>(es.size()))))];
  res.maxMs = es.back();
  return res;
}

void report(const char* what, const Result& r) {
  std::printf("  [info] sync e2e %-26s clicks A %zu B %zu, locked %zu: p99 %.3f ms, max %.3f ms, mean %+.3f ms; events: %d errors, %d failed sync\n",
              what, r.clicksA, r.clicksB, r.n, r.p99Ms, r.maxMs, r.meanMs, r.errors, r.syncFail);
  if (!r.firstError.empty()) std::printf("           first error event: %s\n", r.firstError.c_str());
}

}  // namespace

OM_TEST(core_sync_e2e_two_click_tracks_phase_on_the_rendered_audio) {
  constexpr double kSeconds = 60.0;
  struct Case {
    bool exact, precision;
    const char* what;
    double maxP99Ms;
  };
  const Case cases[] = {{true, false, "exact grids, parity", 0.05},
                        {true, true, "exact grids, precision", 0.05},
                        {false, false, "realistic grids, parity", 1.0},
                        {false, true, "realistic grids, precision", 0.4}};
  for (const Case& c : cases) {
    const Result r = runSteady(c.exact, c.precision, kSeconds);
    report(c.what, r);
    // ~2 clicks per second per deck; ~60 follower clicks in the 30 s locked window
    OM_CHECK(r.clicksA > 100 && r.clicksB > 100 && r.n > 50);
    OM_CHECK(r.errors == 0 && r.syncFail == 0);
    if (!(r.p99Ms < c.maxP99Ms))
      omtest::fail("phase error p99 within target", __FILE__, __LINE__,
                   std::string(c.what) + ": p99 " + std::to_string(r.p99Ms) + " ms, target < " + std::to_string(c.maxP99Ms) + " ms");
  }
}
