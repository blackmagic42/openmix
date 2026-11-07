// Null tests of the deck module against the host generator's golden suites
// (owner: deck; SPEC.md §18.3, §18.4), which no other test read before the
// verification campaign of 7 Nov 2026:
//  - goldens/wsola/*: the real pitch-worklet.js in an AudioWorklet (constant
//    ratios 0.5 .. 1.8, steps, keylock at tempo 1.06) under engine.js's
//    setTargetAtTime(ratio, t, 0.02) moves, against Wsola fed on the 128-frame
//    quantum grid with the k-rate smoother (deckimpl::KRateTarget);
//  - goldens/source/* (read pointer cases): AudioBufferSourceNode as engine.js
//    Deck._makeSource sets it (rates 0.5 .. 1.6, exact copy, fractional start
//    offset, 44.1 kHz buffer, loops, a 10 ms loop, the buffer end, tempo
//    steps), against the Deck;
//  - goldens/source/spin_*: engine.js Deck.spinSound / stopSpinSound (V.BRAKE
//    at tempo 1 and 1.25, BACKSPIN, BACKSPIN stopped after 0.3 s), against the
//    Deck's spin voice.
// Skipped when OM_GOLDEN_DIR is unset (the integration run sets it).
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "../../src/deck/deck_internal.h"
#include "deck_test_util.h"
#include "om/wsola.h"

using namespace om;
using namespace decktest;

namespace {

std::vector<float> channelOf(const omtest::Wav& w, int ch) {
  std::vector<float> o(static_cast<size_t>(w.frames()));
  for (size_t i = 0; i < o.size(); i++) o[i] = w.samples[i * static_cast<size_t>(w.channels) + static_cast<size_t>(ch)];
  return o;
}

// The input of a case as an exact float32 TrackBuffer (the AudioBuffer content).
std::unique_ptr<TrackBuffer> inputTrack(const std::string& rel, int* rate) {
  const omtest::Wav w = loadWav(rel);
  OM_CHECK(w.channels == 2);
  const std::vector<float> L = channelOf(w, 0), R = channelOf(w, 1);
  if (rate) *rate = w.sampleRate;
  return makeTrack(L, R, w.sampleRate, PcmFormat::F32);
}

struct Residual {
  double maxAbs = 0;
  int64_t worstFrame = 0;
};
Residual compareStereo(const std::vector<float>& l, const std::vector<float>& r, const omtest::Wav& gold) {
  Residual res;
  const int64_t n = std::min<int64_t>(static_cast<int64_t>(l.size()), gold.frames());
  for (int64_t i = 0; i < n; i++) {
    const size_t k = static_cast<size_t>(i);
    const double d = std::max(std::fabs(static_cast<double>(l[k]) - gold.samples[2 * k]),
                              std::fabs(static_cast<double>(r[k]) - gold.samples[2 * k + 1]));
    if (d > res.maxAbs) {
      res.maxAbs = d;
      res.worstFrame = i;
    }
  }
  return res;
}

}  // namespace

// goldens/wsola: Wsola == pitch-worklet.js under engine.js's ratio moves.
OM_TEST(golden_wsola_suite_vs_pitch_worklet) {
  const char* cases[] = {"ratio_0.5",  "ratio_0.75", "ratio_0.9439", "ratio_1",     "ratio_1.0595",
                         "ratio_1.25", "ratio_1.5",  "ratio_1.8",    "ratio_steps", "keylock_tempo_1.06"};
  const std::vector<std::vector<int>> patterns = {{128}, {441, 480, 37, 2048, 1000, 7, 300, 1, 127, 129}};
  auto ws = std::make_unique<Wsola>();
  std::vector<float> oL(kMaxBlockFrames), oR(kMaxBlockFrames);
  double worst = 0;
  for (const char* name : cases) {
    json::Value c;
    OM_CHECK(loadJson(golden(std::string("wsola/") + name + ".json"), c));
    const omtest::Wav in = loadWav(std::string("wsola/") + c["input"].asString());
    const omtest::Wav gold = loadWav(std::string("wsola/") + name + ".wav");
    const double rate = c["sampleRate"].asNumber(48000);
    const std::vector<float> inL = channelOf(in, 0), inR = channelOf(in, 1);
    const int64_t frames = std::min<int64_t>(gold.frames(), in.frames());
    OM_CHECK(frames == static_cast<int64_t>(c["frames"].asNumber(0)));
    // engine.js _applyPitch: param("ratio").setTargetAtTime(r, t, 0.02) at render-quantum frames
    std::vector<std::pair<int64_t, double>> ev;
    for (const auto& e : c["events"].items()) {
      OM_CHECK(e["call"].asString() == "ratio.setTargetAtTime");
      OM_CHECK(e["args"].at(2).asNumber(0) == 0.02);
      const int64_t f = static_cast<int64_t>(e["frame"].asNumber(0));
      OM_CHECK(f % kRenderQuantum == 0);
      ev.push_back({f, e["args"].at(0).asNumber(1)});
    }
    for (const auto& pat : patterns) {
      ws->reset();
      deckimpl::KRateTarget k;
      k.reset(1.0f, rate, 0.02);  // the AudioParam's default value
      std::vector<float> outL(static_cast<size_t>(frames)), outR(static_cast<size_t>(frames));
      int64_t pos = 0;
      size_t bi = 0;
      float ratio = 1.0f;
      {
        rt::Scope rts;
        while (pos < frames) {
          int64_t n = pat[bi++ % pat.size()];
          if (n > frames - pos) n = frames - pos;
          int64_t done = 0;
          while (done < n) {
            const int64_t f = pos + done;
            if ((f & (kRenderQuantum - 1)) == 0) {
              for (const auto& e : ev) {
                if (e.first == f) k.setTarget(static_cast<float>(e.second), static_cast<double>(f) / rate);
              }
              ratio = k.step(static_cast<double>(f) / rate);
            }
            const int64_t q0 = f & ~int64_t(kRenderQuantum - 1);
            const int part = static_cast<int>(std::min<int64_t>(n - done, q0 + kRenderQuantum - f));
            ws->process(&inL[static_cast<size_t>(f)], &inR[static_cast<size_t>(f)], oL.data(), oR.data(), part, ratio);
            std::copy(oL.begin(), oL.begin() + part, outL.begin() + f);
            std::copy(oR.begin(), oR.begin() + part, outR.begin() + f);
            done += part;
          }
          pos += n;
        }
      }
      const Residual r = compareStereo(outL, outR, gold);
      worst = std::max(worst, r.maxAbs);
      std::printf("    %-20s blocks %-4d max |diff| %.3g (%.1f dBFS)%s\n", name, pat[0], r.maxAbs, toDb(r.maxAbs),
                  r.maxAbs == 0 ? " bit-exact" : "");
      OM_CHECK(toDb(r.maxAbs) < -80.0);
    }
  }
  std::printf("    wsola suite: worst max |diff| %.3g over 10 cases x 2 block patterns\n", worst);
}

// goldens/source (read pointer cases): the Deck == AudioBufferSourceNode.
OM_TEST(golden_source_suite_vs_audio_buffer_source) {
  const char* cases[] = {"rate_0.5",          "rate_0.75",         "rate_0.9999",       "rate_1.02",
                         "rate_1.25",         "rate_1.6",          "rate_1_exact_copy", "rate_1_fractional_offset",
                         "filerate_44100_rate_1", "filerate_44100_rate_1.06", "loop_rate_1", "loop_rate_1.33",
                         "loop_short_10ms",   "play_past_the_end", "tempo_change"};
  const std::vector<std::vector<int>> patterns = {{128}, {441, 480, 37, 2048, 1000, 7, 300}};
  double worst = 0;
  for (const char* name : cases) {
    json::Value c;
    OM_CHECK(loadJson(golden(std::string("source/") + name + ".json"), c));
    const json::Value& s = c["setup"].at(0);
    OM_CHECK(s["node"].asString() == "AudioBufferSourceNode");
    int bufRate = 0;
    auto tb = inputTrack(std::string("source/") + c["input"].asString(), &bufRate);
    OM_CHECK(bufRate == static_cast<int>(s["bufferRate"].asNumber(0)));
    const omtest::Wav gold = loadWav(std::string("source/") + name + ".wav");
    const double ctxRate = c["sampleRate"].asNumber(48000);
    const int64_t frames = gold.frames();
    std::vector<std::pair<int64_t, double>> steps;
    for (const auto& e : c["events"].items()) {
      OM_CHECK(e["call"].asString() == "source.playbackRate.value");
      steps.push_back({static_cast<int64_t>(e["frame"].asNumber(0)), e["args"].at(0).asNumber(1)});
    }
    for (const auto& pat : patterns) {
      Deck d(0);
      d.prepare(ctxRate, kMaxBlockFrames);
      d.attachTrack(tb.get());
      Rig rig;
      rig.rate = ctxRate;
      d.setTempo(s["playbackRate"].asNumber(1));
      d.seek(s["start"]["offset"].asNumber(0), 0, rig.now());
      if (s["loop"].asBool()) d.setLoop(s["loopStart"].asNumber(0), s["loopEnd"].asNumber(0));
      d.play(0, rig.clock(pat[0]));
      OM_CHECK(d.playing() && !d.armed());
      size_t si = 0, bi = 0;
      while (rig.frame < frames) {
        int64_t n = pat[bi++ % pat.size()];
        if (si < steps.size() && rig.frame + n > steps[si].first) n = steps[si].first - rig.frame;
        if (n > frames - rig.frame) n = frames - rig.frame;
        if (n > 0) rig.renderPattern(d, n, {static_cast<int>(n)});
        if (si < steps.size() && rig.frame == steps[si].first) d.setTempo(steps[si++].second);
      }
      const Residual r = compareStereo(rig.outL, rig.outR, gold);
      worst = std::max(worst, r.maxAbs);
      std::printf("    %-26s blocks %-4d max |diff| %.3g (%.1f dBFS)%s\n", name, pat[0], r.maxAbs, toDb(r.maxAbs),
                  r.maxAbs == 0 ? " bit-exact" : "");
      OM_CHECK(toDb(r.maxAbs) < -80.0);
    }
  }
  std::printf("    source suite: worst max |diff| %.3g over 15 cases x 2 block patterns\n", worst);
}

// goldens/source/spin_*: the Deck's spin voice == engine.js spinSound /
// stopSpinSound rendered by Chromium (a playbackRate ramp, k-rate, on a copied
// slice, reversed for the backspin; gain 1 then a linear fade over the last
// 40 ms; stopSpinSound = 20 ms linear fade).
OM_TEST(golden_spin_vs_engine_js_spin_sound) {
  struct Case {
    const char* name;
    SpinKind kind;
  } cases[] = {{"spin_vbrake", SpinKind::VBrake},
               {"spin_vbrake_tempo_1.25", SpinKind::VBrake},
               {"spin_backspin", SpinKind::Backspin},
               {"spin_backspin_stopped", SpinKind::Backspin}};
  const std::vector<std::vector<int>> patterns = {{128}, {441, 480, 37, 2048, 1000, 7, 300}};
  for (const Case& cs : cases) {
    json::Value c;
    OM_CHECK(loadJson(golden(std::string("source/") + cs.name + ".json"), c));
    int bufRate = 0;
    auto tb = inputTrack(std::string("source/") + c["input"].asString(), &bufRate);
    const omtest::Wav gold = loadWav(std::string("source/") + cs.name + ".wav");
    const double ctxRate = c["sampleRate"].asNumber(48000);
    const int64_t frames = gold.frames();
    // "deck.loadTrack({buffer}), deck.offset = X, deck.tempo = T, then deck.spinSound(kind) at frame 0"
    const std::string notes = c["notes"].asString();
    double offset = 0, tempo = 1;
    {
      const size_t o = notes.find("deck.offset = ");
      const size_t t = notes.find("deck.tempo = ");
      OM_CHECK(o != std::string::npos && t != std::string::npos);
      offset = std::atof(notes.c_str() + o + 14);
      tempo = std::atof(notes.c_str() + t + 13);
    }
    int64_t stopAt = -1;
    for (const auto& e : c["events"].items()) {
      if (e["call"].asString() == "deck.stopSpinSound") stopAt = static_cast<int64_t>(e["frame"].asNumber(0));
    }
    for (const auto& pat : patterns) {
      Deck d(0);
      d.prepare(ctxRate, kMaxBlockFrames);
      d.attachTrack(tb.get());
      Rig rig;
      rig.rate = ctxRate;
      d.setTempo(tempo);
      d.seek(offset, 0, rig.now());
      d.spin(cs.kind, rig.clock(pat[0]));
      size_t bi = 0;
      while (rig.frame < frames) {
        int64_t n = pat[bi++ % pat.size()];
        if (stopAt > rig.frame && rig.frame + n > stopAt) n = stopAt - rig.frame;
        if (n > frames - rig.frame) n = frames - rig.frame;
        if (n > 0) rig.renderPattern(d, n, {static_cast<int>(n)});
        if (rig.frame == stopAt) d.spin(SpinKind::None, rig.clock(128));
      }
      const Residual r = compareStereo(rig.outL, rig.outR, gold);
      std::printf("    %-24s blocks %-4d max |diff| %.3g (%.1f dBFS) at frame %lld\n", cs.name, pat[0], r.maxAbs,
                  toDb(r.maxAbs), static_cast<long long>(r.worstFrame));
      OM_CHECK(toDb(r.maxAbs) < -80.0);
    }
  }
}
