// Null tests of the deck module against golden renders made by Chromium
// itself (owner: deck; SPEC.md §18.3, §18.4): the Deck's read pointer vs
// AudioBufferSourceNode (rates != 1, a 44.1 kHz buffer in a 48 kHz context,
// loop seams across chunk boundaries, end of buffer, rate steps, int16 with
// per-chunk scales and float32), Wsola vs the real pitch-worklet.js in an
// AudioWorklet fed on a quantum grid with irregular block sizes, and the
// k-rate setTargetAtTime emulation vs the values Chromium gave the worklet's
// "ratio" parameter. Goldens: tests/deck/goldens/make_deck_goldens.js ->
// OM_GOLDEN_DIR/deck/*. Skipped when OM_GOLDEN_DIR is unset.
#include <cstdio>
#include <string>
#include <vector>

#include "../../src/deck/deck_internal.h"
#include "deck_test_util.h"
#include "om/wsola.h"

using namespace om;
using namespace decktest;

namespace {

struct GoldenInput {
  int rate = 0;
  std::unique_ptr<TrackBuffer> tb;
  std::vector<float> L, R;
};

GoldenInput loadInput(const std::string& name) {
  GoldenInput gi;
  json::Value meta;
  OM_CHECK(loadJson(golden("deck/" + name + ".input.json"), meta));
  const omtest::Wav w = loadWav("deck/" + name + ".input.wav");
  OM_CHECK(w.channels == 2);
  gi.rate = w.sampleRate;
  const size_t n = static_cast<size_t>(w.frames());
  gi.L.resize(n);
  gi.R.resize(n);
  for (size_t i = 0; i < n; i++) {
    gi.L[i] = w.samples[2 * i];
    gi.R[i] = w.samples[2 * i + 1];
  }
  const bool s16 = meta["format"].asString() == "s16";
  std::vector<float> scales;
  if (s16) {
    for (const auto& v : meta["scales"].items()) scales.push_back(static_cast<float>(v.asNumber(0)));
  }
  gi.tb = makeTrack(gi.L, gi.R, gi.rate, s16 ? PcmFormat::S16 : PcmFormat::F32, scales);
  if (s16) {
    // the int16 x chunk-scale storage reproduces Chromium's input exactly
    for (size_t i = 0; i < n; i += 997) {
      float l, r;
      gi.tb->frame(static_cast<int64_t>(i), l, r);
      OM_CHECK(l == gi.L[i] && r == gi.R[i]);
    }
  }
  return gi;
}

// Renders one abs_* case with the Deck and returns the max abs difference.
double runAbsCase(const std::string& name, const std::vector<int>& blocks, bool* exact) {
  json::Value c;
  OM_CHECK(loadJson(golden("deck/" + name + ".json"), c));
  GoldenInput in = loadInput(c["input"].asString());
  const omtest::Wav gold = loadWav("deck/" + name + ".wav");
  const int64_t frames = static_cast<int64_t>(c["frames"].asNumber(0));
  OM_CHECK(gold.frames() == frames && gold.channels == 2);

  Deck d(0);
  d.prepare(c["contextRate"].asNumber(48000), kMaxBlockFrames);
  d.attachTrack(in.tb.get());
  Rig rig;
  rig.rate = c["contextRate"].asNumber(48000);
  d.setTempo(c["rate"].asNumber(1));
  d.seek(c["offsetSec"].asNumber(0), 0, rig.now());
  if (c["loop"].asBool()) d.setLoop(c["loopStartSec"].asNumber(0), c["loopEndSec"].asNumber(0));
  d.play(0, rig.clock(blocks[0]));
  OM_CHECK(d.playing() && !d.armed());
  // rate steps at exact frames: split the rendering there
  std::vector<std::pair<int64_t, double>> steps;
  for (const auto& s : c["rateSteps"].items()) steps.push_back({static_cast<int64_t>(s["frame"].asNumber(0)), s["rate"].asNumber(1)});
  size_t si = 0;
  size_t bi = 0;
  while (rig.frame < frames) {
    int64_t n = blocks[bi++ % blocks.size()];
    if (si < steps.size() && rig.frame + n > steps[si].first) n = steps[si].first - rig.frame;
    if (n > frames - rig.frame) n = frames - rig.frame;
    if (n > 0) rig.renderPattern(d, n, {static_cast<int>(n)});
    if (si < steps.size() && rig.frame == steps[si].first) d.setTempo(steps[si++].second);
  }
  double m = 0;
  bool ex = true;
  for (int64_t i = 0; i < frames; i++) {
    const double dl = std::fabs(static_cast<double>(rig.outL[static_cast<size_t>(i)]) - gold.samples[2 * static_cast<size_t>(i)]);
    const double dr = std::fabs(static_cast<double>(rig.outR[static_cast<size_t>(i)]) - gold.samples[2 * static_cast<size_t>(i) + 1]);
    m = std::max(m, std::max(dl, dr));
    if (dl != 0 || dr != 0) ex = false;
  }
  if (exact) *exact = ex;
  return m;
}

std::vector<float> channel(const omtest::Wav& w, int ch) {
  std::vector<float> o(static_cast<size_t>(w.frames()));
  for (size_t i = 0; i < o.size(); i++) o[i] = w.samples[i * static_cast<size_t>(w.channels) + static_cast<size_t>(ch)];
  return o;
}

}  // namespace

// The deck's read pointer == Chromium's AudioBufferSourceNode, bit for bit,
// whatever the block sizes (residual < -80 dBFS is the SPEC bound; it is exact).
OM_TEST(golden_deck_read_pointer_vs_audio_buffer_source) {
  const char* cases[] = {"abs_rate1",     "abs_rate0p7337", "abs_44k_rate1p37", "abs_loop_seam",   "abs_loop_44k",
                         "abs_loop_rate1", "abs_end",        "abs_rate_steps",   "abs_f32_rate1p21"};
  const std::vector<std::vector<int>> patterns = {{128}, {441, 480, 37, 2048, 1000, 7, 300}};
  for (const char* name : cases) {
    for (const auto& pat : patterns) {
      bool exact = false;
      const double m = runAbsCase(name, pat, &exact);
      std::printf("    %-18s blocks %-4d max |diff| %.3g (%s)\n", name, pat[0], m, exact ? "bit-exact" : "inexact");
      OM_CHECK(toDb(m) < -80.0);
      OM_CHECK(exact);
    }
  }
}

// Wsola fed on a 128-frame quantum grid with irregular blocks (441, 480,
// variable, 'when'-like splits) == the real pitch-worklet.js (max |diff| < 1e-5).
OM_TEST(golden_wsola_vs_pitch_worklet_on_the_quantum_grid) {
  const omtest::Wav in = loadWav("deck/wsola.input.wav");
  const std::vector<float> inL = channel(in, 0), inR = channel(in, 1);
  const char* cases[] = {"wsola_unity", "wsola_staircase", "wsola_ramp", "wsola_target"};
  const std::vector<std::vector<int>> patterns = {{128}, {441}, {480}, {441, 480, 37, 2048, 1000, 7, 300, 1, 127, 129}};
  auto ws = std::make_unique<Wsola>();
  std::vector<float> oL(4096), oR(4096);
  for (const char* name : cases) {
    const omtest::Wav gold = loadWav(std::string("deck/") + name + ".wav");
    const omtest::Wav rec = loadWav(std::string("deck/") + name + ".ratio.wav");
    const int64_t frames = gold.frames();
    for (const auto& pat : patterns) {
      ws->reset();
      double m = 0;
      int64_t pos = 0;
      size_t bi = 0;
      {
        rt::Scope rts;
        while (pos < frames) {
          int64_t n = pat[bi++ % pat.size()];
          if (n > frames - pos) n = frames - pos;
          // the deck's split at its quantum edges, with the quantum's k-rate ratio
          int64_t done = 0;
          while (done < n) {
            const int64_t f = pos + done;
            const int64_t q0 = f & ~int64_t(127);
            const int part = static_cast<int>(std::min<int64_t>(n - done, q0 + 128 - f));
            const double ratio = rec.samples[static_cast<size_t>(q0)];
            ws->process(&inL[static_cast<size_t>(f)], &inR[static_cast<size_t>(f)], oL.data(), oR.data(), part, ratio);
            for (int i = 0; i < part; i++) {
              const size_t k = static_cast<size_t>(f + i);
              m = std::max(m, std::fabs(static_cast<double>(oL[static_cast<size_t>(i)]) - gold.samples[2 * k]));
              m = std::max(m, std::fabs(static_cast<double>(oR[static_cast<size_t>(i)]) - gold.samples[2 * k + 1]));
            }
            done += part;
          }
          pos += n;
        }
      }
      std::printf("    %-16s blocks %-4d max |diff| %.3g\n", name, pat[0], m);
      OM_CHECK(m < 1e-5);
    }
  }
}

// The k-rate setTargetAtTime emulation (the WSOLA ratio smoother) gives the
// exact float values Chromium gave pitch-worklet.js's "ratio" parameter.
OM_TEST(golden_ratio_smoother_vs_chromium_k_rate_param) {
  json::Value c;
  OM_CHECK(loadJson(golden("deck/wsola_target.json"), c));
  const omtest::Wav rec = loadWav("deck/wsola_target.ratio.wav");
  const double rate = c["contextRate"].asNumber(48000);
  std::vector<std::pair<int64_t, double>> ev;
  for (const auto& t : c["targets"].items()) ev.push_back({static_cast<int64_t>(t["frame"].asNumber(0)), t["value"].asNumber(1)});
  deckimpl::KRateTarget k;
  k.reset(1.0f, rate, 0.02);
  const int64_t quanta = rec.frames() / 128;
  int mism = 0;
  for (int64_t q = 0; q < quanta; q++) {
    const int64_t f = q * 128;
    for (const auto& e : ev) {
      if (e.first == f) k.setTarget(static_cast<float>(e.second), f / rate);
    }
    const float v = k.step(f / rate);
    if (v != rec.samples[static_cast<size_t>(f)]) mism++;
  }
  std::printf("    %lld quanta, %d mismatch(es)\n", static_cast<long long>(quanta), mism);
  OM_CHECK(mism == 0);
}
