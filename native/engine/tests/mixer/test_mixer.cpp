// Tests of the mixer module (owner: mixer), with FAKE FX processors, a fake
// Color processor and a fake two-phase insert (the FX seam: no real FX unit
// is linked): engine.js defaults and the crossfader "mix" curve exposed to
// the sync engine, the FX rack view from the mirrors (live assign matrix),
// units attached later receiving their parameters, output routing, limiter
// latency; every path of the engine.js graph with DC levels and with
// impulses (returns scaled by the master volume, master FX bypassing
// fxReturn, sampler post-volume, every path on the same frame), the
// two-phase insert, the sends latch / pad send / dry cut / dryComp
// hysteresis, the Color modes, cue routing, meters that never miss a peak,
// the reset, the master bus against Chromium's renders of engine.js's
// AudioEngine (golden suite master/*), allocation-free processing with
// everything on, and the CPU cost per 128-frame block. Strip curves:
// test_strip.cpp; limiter: test_limiter.cpp; sampler: test_sampler.cpp.
// SPEC.md §10, §18.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <memory>
#include <vector>

#include "../om_test.h"
#include "mixer_test_util.h"
#include "om/dsp.h"
#include "om/limiter.h"
#include "om/media.h"
#include "om/mixer.h"
#include "om/rt.h"

using namespace om;

namespace {
// Records what the mixer forwards; outputs silence.
struct FakeFx final : IFxProcessor {
  FxType type = FxType::Echo;
  bool enabled = false;
  float level = 0.0f, beats = 0.5f;
  int calls = 0;
  void setType(FxType t) noexcept override { type = t, calls++; }
  void setEnabled(bool on) noexcept override { enabled = on, calls++; }
  void setLevel(float v) noexcept override { level = v, calls++; }
  void setBeatsMult(float m) noexcept override { beats = m, calls++; }
  void setBeatClock(const BeatClock&) noexcept override {}
  float wetGain() const noexcept override { return enabled ? level : 0.0f; }
  void process(const float*, const float*, float* outL, float* outR, int n) noexcept override {
    for (int i = 0; i < n; i++) outL[i] = outR[i] = 0.0f;
  }
};
}  // namespace

OM_TEST(mixer_defaults_like_engine_js) {
  Mixer m;
  m.prepare(48000, kMaxBlockFrames);
  const MixView v = m.mixView();
  for (int d = 0; d < kNumDecks; d++) {
    OM_CHECK_NEAR(v.volume[d], 0.85, 1e-7);  // engine.js Deck.volume
    OM_CHECK_NEAR(v.xfGain[d], 1.0, 0);      // crossfader centered: both sides at full
  }
  FxRackView f;
  m.fxRackView(f);
  OM_CHECK(f.assign == 0x8421);  // unit u processes deck u
  OM_CHECK(!f.masterExists && !f.padExists[0]);
  OM_CHECK(f.panel[0].type == FxType::Echo && !f.panel[0].enabled && f.panel[0].level == 0.0f);
}

OM_TEST(mixer_crossfader_mix_curve_and_sides) {
  Mixer m;
  m.prepare(48000, kMaxBlockFrames);
  m.setCrossfader(0.75f);  // side A: (1 - x) * 2 = 0.5, side B: 1
  MixView v = m.mixView();
  OM_CHECK_NEAR(v.xfGain[0], 0.5, 1e-6);
  OM_CHECK_NEAR(v.xfGain[1], 1.0, 0);
  m.setXfSide(0, XfSide::B);
  v = m.mixView();
  OM_CHECK_NEAR(v.xfGain[0], 1.0, 0);
}

OM_TEST(mixer_fx_seam_mirrors_and_late_attach) {
  Mixer m;
  m.prepare(48000, kMaxBlockFrames);
  FakeFx panel0, pad1, master;
  OM_CHECK(m.attachFx(panelUnit(0), &panel0) == nullptr);
  m.setFx(panelUnit(0), kFxType | kFxLevel, FxType::Flanger, false, 0.6f, 0.0f);
  OM_CHECK(panel0.type == FxType::Flanger && panel0.level == 0.6f);
  // pad unit used before its memory exists (created later by the control thread)
  m.setPadFx(1, true, FxType::Delay, 2.0f, 0.8f);
  FxRackView f;
  m.fxRackView(f);
  OM_CHECK(f.padExists[1] && f.pad[1].type == FxType::Delay && f.pad[1].enabled);
  OM_CHECK(m.attachFx(padUnit(1), &pad1) == nullptr);
  OM_CHECK(pad1.type == FxType::Delay && pad1.enabled && pad1.level == 0.8f && pad1.beats == 2.0f);  // mirrored at once
  // master: fx.set with no field = engine.js ensureMasterFx()
  OM_CHECK(!m.fxRequested(masterUnit()));
  m.setFx(masterUnit(), 0, FxType::Echo, false, 0, 0);
  OM_CHECK(m.fxRequested(masterUnit()));
  OM_CHECK(m.attachFx(masterUnit(), &master) == nullptr);
  OM_CHECK(m.attachFx(masterUnit(), nullptr) == &master);  // the previous pointer comes back
  // live assign matrix (fx.assign) feeds the rack view; the sends latch separately
  m.setFxAssign(0x0003);
  m.fxRackView(f);
  OM_CHECK(f.assign == 0x0003 && f.assigned(0, 1) && !f.assigned(1, 1));
  m.resetToDefaults();
  m.fxRackView(f);
  OM_CHECK(f.assign == 0x8421 && !f.padExists[1] && panel0.type == FxType::Echo);
}

OM_TEST(mixer_output_routing_and_limiter_latency) {
  Mixer m;
  m.prepare(48000, kMaxBlockFrames);
  OutputRouting r;
  r.cueL = 2;
  r.cueR = 3;
  m.setRouting(r);
  DeckInput in[kNumDecks];
  std::vector<float> zero(256, 0.0f);
  for (auto& i : in) i.l = i.r = zero.data();
  BlockClock clk;
  clk.frames = 256;
  std::vector<float> out(256 * 4, 9.0f);
  {
    rt::Scope rts;
    m.process(in, 256, clk);
    m.writeOutput(out.data(), 256, 4);
  }
  for (float x : out) OM_CHECK(x == 0.0f);
  OM_CHECK(m.masterLatencyFrames() == 288);  // Chromium DynamicsCompressor 6 ms pre-delay at 48 kHz
}

// ---------------------------------------------------------------------------
// Harness: a Mixer fed by DC levels or signals, irregular device-like blocks,
// every process() inside an rt::Scope (the runner fails on any allocation /
// free there), master and cue captured.
// ---------------------------------------------------------------------------
namespace {

struct Harness {
  Mixer m;
  double rate = 48000;
  int64_t pos = 0;
  int k = 0;
  float dcL[kNumDecks] = {0, 0, 0, 0}, dcR[kNumDecks] = {0, 0, 0, 0};
  const std::vector<float>* sigL[kNumDecks] = {nullptr, nullptr, nullptr, nullptr};  // indexed by absolute frame
  const std::vector<float>* sigR[kNumDecks] = {nullptr, nullptr, nullptr, nullptr};
  float sigScale[kNumDecks] = {1, 1, 1, 1};
  std::vector<float> dl[kNumDecks], dr[kNumDecks];
  std::vector<float> outL, outR, cueL, cueR;
  int fixedBlock = 0;  // > 0: every block has this size
  double gain = 1.0;   // the limiter's steady gain below its threshold (makeup, Chromium float)

  explicit Harness(double sr = 48000) : rate(sr) {
    m.prepare(sr, kMaxBlockFrames);
    for (int d = 0; d < kNumDecks; d++) {
      dl[d].assign(kMaxBlockFrames, 0.0f);
      dr[d].assign(kMaxBlockFrames, 0.0f);
    }
    gain = mixtest::steadyLimiterGain(sr);
  }
  BlockClock clock(int n) const {
    BlockClock c;
    c.frame = pos;
    c.frames = n;
    c.sampleRate = rate;
    c.sampleTime = static_cast<double>(pos) / rate;
    c.presentTime = c.sampleTime;
    c.callbackTime = c.sampleTime;
    return c;
  }
  // Renders `frames` (or up to the absolute frame `until` when >= 0).
  void run(int64_t frames) {
    outL.assign(static_cast<size_t>(frames), 0.0f);
    outR.assign(static_cast<size_t>(frames), 0.0f);
    cueL.assign(static_cast<size_t>(frames), 0.0f);
    cueR.assign(static_cast<size_t>(frames), 0.0f);
    int64_t done = 0;
    while (done < frames) {
      int n = fixedBlock > 0 ? std::min(fixedBlock, kMaxBlockFrames) : mixtest::blockSize(k++);
      if (done + n > frames) n = static_cast<int>(frames - done);
      DeckInput in[kNumDecks];
      for (int d = 0; d < kNumDecks; d++) {
        for (int i = 0; i < n; i++) {
          const size_t f = static_cast<size_t>(pos + i);
          dl[d][static_cast<size_t>(i)] =
              sigL[d] ? (f < sigL[d]->size() ? (*sigL[d])[f] * sigScale[d] : 0.0f) : dcL[d];
          dr[d][static_cast<size_t>(i)] =
              sigR[d] ? (f < sigR[d]->size() ? (*sigR[d])[f] * sigScale[d] : 0.0f) : dcR[d];
        }
        in[d].l = dl[d].data();
        in[d].r = dr[d].data();
      }
      const BlockClock c = clock(n);
      {
        rt::Scope rts;
        m.process(in, n, c);
      }
      for (int i = 0; i < n; i++) {
        outL[static_cast<size_t>(done + i)] = m.masterL()[i];
        outR[static_cast<size_t>(done + i)] = m.masterR()[i];
        cueL[static_cast<size_t>(done + i)] = m.cueL()[i];
        cueR[static_cast<size_t>(done + i)] = m.cueR()[i];
      }
      pos += n;
      done += n;
    }
  }
  float lastL() const { return outL.back(); }
  float lastR() const { return outR.back(); }
};

std::unique_ptr<TrackBuffer> dcSound(float v, int64_t frames, float first = NAN) {
  auto tb = TrackBuffer::allocate(1, PcmKind::Sample, PcmFormat::F32, 48000, frames, 0.0f);
  for (int64_t c = 0; c < tb->numChunks; c++) {
    std::vector<float> inter(static_cast<size_t>(tb->chunkFramesOf(c)) * 2, v);
    if (c == 0 && !std::isnan(first)) inter[0] = inter[1] = first;
    tb->writeChunkRaw(c * TrackBuffer::kChunkFrames, inter.data(), inter.size() * sizeof(float), 1.0f);
  }
  return tb;
}

using mixtest::near;

}  // namespace

// ---------------------------------------------------------------------------
// The engine.js graph, path by path
// ---------------------------------------------------------------------------
OM_TEST(mixer_topology_every_path_with_fakes) {
  Harness h;
  mixtest::FakeFx u0, u1, u2, u3, pad1, master;
  mixtest::FakeColor color;
  h.m.attachFx(panelUnit(0), &u0);
  h.m.attachFx(panelUnit(1), &u1);
  h.m.attachFx(panelUnit(2), &u2);
  h.m.attachFx(panelUnit(3), &u3);
  h.m.attachColor(&color);
  h.dcL[0] = 0.05f;
  h.dcR[0] = 0.03f;
  h.dcL[1] = 0.02f;
  h.dcR[1] = 0.01f;
  h.m.setMasterVolume(0.5f);
  // panel unit 0 on deck 0 (default assignment), latched by updateFxSends
  h.m.setFx(panelUnit(0), kFxType | kFxEnabled | kFxLevel, FxType::Echo, true, 0.5f, 0.0f);
  h.m.updateFxSends();
  // Color FX bus fed by deck 1's knob (send = |v|)
  h.m.setColorType(ColorType::DubEcho);
  h.m.setDeckColor(1, -0.6f);
  // pad FX on deck 1, master FX on the whole mix
  h.m.setPadFx(1, true, FxType::Trans, 1.0f, 0.8f);
  h.m.attachFx(padUnit(1), &pad1);
  h.m.setFx(masterUnit(), kFxType | kFxEnabled | kFxLevel, FxType::Flanger, true, 0.3f, 0.0f);
  h.m.attachFx(masterUnit(), &master);
  // a sampler voice: DC 0.04 into the post bus
  auto smp = dcSound(0.04f, 6 * 48000);
  h.m.sampler().attach(0, smp.get());
  h.m.sampler().play(0, 1, 1.0f, h.clock(0));
  h.run(96000);  // every smoother converged, the limiter in its steady state (all levels under its threshold)

  for (int ch = 0; ch < 2; ch++) {
    const double in0 = ch ? 0.03 : 0.05, in1 = ch ? 0.01 : 0.02;
    const double x0 = in0 * 0.7225, x1 = in1 * 0.7225;   // post x fader (v^2) x crossfader (1)
    const double wet0 = x0 * 0.5;                         // panel unit 0: send 1, wet 0.5
    const double dry0 = 1 - fxDryCut(FxType::Echo) * 0.5;  // 0.775: the dry cut follows the unit's wet
    const double padWet = x1 * 0.8;                       // pad unit: pad send 1, wet 0.8
    const double colorOut = in1 * 0.6 * 0.85;             // color send |v| = 0.6 on post, colorWet 0.85
    const double mg = (x0 * dry0 + x1) * 0.5;             // masterGain = master volume
    const double masterWet = mg * 0.3;                    // master FX fed by masterGain, straight to the post bus
    const double dryComp = 1 - fxDryCut(FxType::Flanger) * 0.3;  // 0.85
    const double ret = (wet0 + padWet + colorOut) * 0.5;  // fxReturn = master volume
    const double post = masterWet + mg * dryComp + ret + 0.04;  // + sampler (post-volume)
    const double got = ch ? h.lastR() : h.lastL();
    OM_CHECK(near(got, post * h.gain, 2e-6, ch ? "post R" : "post L"));
  }
  // what each unit received
  OM_CHECK(u0.lastInL[0] == 0.05f * static_cast<float>(0.85 * 0.85));
  OM_CHECK(pad1.lastInL[0] == 0.02f * static_cast<float>(0.85 * 0.85));
  OM_CHECK(near(master.lastInL[0], (0.05 * 0.7225 * 0.775 + 0.02 * 0.7225) * 0.5, 1e-6, "master FX input"));
  OM_CHECK(u1.inputEnergy == 0.0 && u2.inputEnergy == 0.0 && u3.inputEnergy == 0.0);
  OM_CHECK(color.inputEnergy > 0.0 && color.type == ColorType::DubEcho);
  // views
  om_mixer_state s;
  h.m.snapshot(s);
  OM_CHECK(s.fx_wet[0] == 0.5f && s.pad_wet[1] == 0.8f && s.master_wet == 0.3f);
  OM_CHECK(s.dry_comp == 0.85f);
  float pk, rms, dry;
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(dry == 0.775f && pk == 0.5f * (0.05f + 0.03f));  // the analyser's mono fold of L 0.05 / R 0.03
  h.m.deckMeters(1, pk, rms, dry);
  OM_CHECK(dry == 1.0f);
  // master volume 0: the dry mix and every FX return go silent, the sampler stays (post-volume)
  h.m.setMasterVolume(0.0f);
  h.run(48000);
  OM_CHECK(near(h.lastL(), 0.04 * h.gain, 2e-6, "sampler alone L") && near(h.lastR(), 0.04 * h.gain, 2e-6, "sampler alone R"));
  h.m.sampler().stopAll();
  h.m.sampler().attach(0, nullptr);
}

// Impulses through every path at once: each deck's impulse (and the
// sampler's) must come out on the SAME frame through all of its paths (dry,
// FX send + return, pad, Color bus, master FX), 288 frames later (the
// limiter's look-ahead), with the engine.js gains, and nothing anywhere else
// (no path is a block late, nothing smears).
OM_TEST(mixer_topology_impulses_every_path_same_frame) {
  Harness h;
  mixtest::FakeFx u0, pad1, master;
  mixtest::FakeColor color;
  h.m.attachFx(panelUnit(0), &u0);
  h.m.attachColor(&color);
  h.m.setMasterVolume(0.5f);
  h.m.setFx(panelUnit(0), kFxType | kFxEnabled | kFxLevel, FxType::Echo, true, 0.5f, 0.0f);
  h.m.updateFxSends();
  h.m.setPadFx(1, true, FxType::Trans, 1.0f, 0.8f);
  h.m.attachFx(padUnit(1), &pad1);
  h.m.setColorType(ColorType::DubEcho);
  h.m.setDeckColor(2, -0.6f);
  h.m.setFx(masterUnit(), kFxType | kFxEnabled | kFxLevel, FxType::Flanger, true, 0.3f, 0.0f);
  h.m.attachFx(masterUnit(), &master);
  const int64_t N = 96000;
  std::vector<float> sig[kNumDecks];
  const int64_t at[kNumDecks] = {60017, 62005, 64100, 66033};
  const float amp[kNumDecks] = {0.1f, 0.07f, 0.09f, 0.05f};
  for (int d = 0; d < kNumDecks; d++) {
    sig[d].assign(static_cast<size_t>(N), 0.0f);
    sig[d][static_cast<size_t>(at[d])] = amp[d];
    h.sigL[d] = h.sigR[d] = &sig[d];
  }
  auto click = dcSound(0.0f, 4800, 0.06f);  // a sound that is one impulse
  h.m.sampler().attach(3, click.get());
  std::vector<float> out;
  h.run(67000);
  out = h.outL;
  const int64_t atSampler = h.pos;  // a trigger applies at the next block's first frame
  h.m.sampler().play(3, 9, 1.0f, h.clock(0));
  h.run(N - 67000);
  out.insert(out.end(), h.outL.begin(), h.outL.end());
  const double g = h.gain;
  const double xf = 0.7225;  // fader (0.85^2) x crossfader (1)
  const double want[5] = {
      amp[0] * xf * (0.5 * 0.5 + 0.775 * 0.5 * (0.85 + 0.3)) * g,          // u0 wet + cut dry (dryComp + master FX)
      amp[1] * xf * (0.8 * 0.5 + 1.0 * 0.5 * (0.85 + 0.3)) * g,            // pad wet + dry
      (amp[2] * 0.6 * 0.85 * 0.5 + amp[2] * xf * 0.5 * (0.85 + 0.3)) * g,  // Color bus (pre-fader) + dry
      amp[3] * xf * 0.5 * (0.85 + 0.3) * g,                                // dry only
      0.06 * g};                                                           // sampler: post bus, no volume
  const int64_t where[5] = {at[0] + 288, at[1] + 288, at[2] + 288, at[3] + 288, atSampler + 288};
  for (int p = 0; p < 5; p++) OM_CHECK(near(out[static_cast<size_t>(where[p])], want[p], 2e-6, "impulse"));
  int stray = 0;
  for (int64_t i = 0; i < N; i++) {
    bool expected = false;
    for (int p = 0; p < 5; p++) expected |= i == where[p];
    if (!expected && out[static_cast<size_t>(i)] != 0.0f) stray++;
  }
  OM_CHECK(stray == 0);
  h.m.sampler().stopAll();
  h.m.sampler().attach(3, nullptr);
}

OM_TEST(mixer_two_phase_insert_order_and_late_dry) {
  Harness h;
  mixtest::FakeInsert ins;
  ins.active[0] = true;
  ins.gain[0] = 2.0f;
  ins.active[2] = true;
  ins.late[2] = true;  // missed the deadline: the latency-aligned dry comes back
  ins.latency[2] = 100;
  h.m.setInsert(&ins);
  h.dcL[0] = h.dcR[0] = 0.1f;
  h.dcL[1] = h.dcR[1] = 0.01f;
  h.dcL[3] = h.dcR[3] = 0.01f;
  std::vector<float> marker(48000, 0.0f);
  marker[30000] = 0.2f;
  h.sigL[2] = h.sigR[2] = &marker;
  h.m.setDeckTrim(0, 1.0f);   // x4: begin() receives the post-FILTER signal
  h.m.setDeckVolume(1, 0.0f);  // decks without an active insert pass untouched (meter: pre-fader)
  h.run(48000);
  // every block: begin(0..3) first, then end() for the active decks only, in deck order
  int blocks = 0;
  bool order = ins.ncalls % 6 == 0;
  for (int i = 0; order && i + 6 <= ins.ncalls; i += 6) {
    const auto* c = ins.calls + i;
    order = c[0].what == 'b' && c[0].deck == 0 && c[1].what == 'b' && c[1].deck == 1 && c[2].what == 'b' &&
            c[2].deck == 2 && c[3].what == 'b' && c[3].deck == 3 && c[4].what == 'e' && c[4].deck == 0 &&
            c[5].what == 'e' && c[5].deck == 2;
    blocks++;
  }
  OM_CHECK(order && blocks > 50);
  OM_CHECK(ins.inL[0][0] == 0.4f);  // the insert reads post-TRIM/EQ/FILTER
  float pk, rms, dry;
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(pk == 0.8f);             // the meter is post-insert, pre-fader
  h.m.deckMeters(1, pk, rms, dry);
  OM_CHECK(pk == 0.01f);            // volume 0, still metered
  // the late deck: its marker is heard 100 frames (plugin latency) + 288 (limiter) later, nothing earlier
  const double before = h.outL[30000 + 100 + 288 - 1];
  const double step = h.outL[30000 + 100 + 288] - before;
  OM_CHECK(near(step, 0.2 * 0.7225 * 0.9 * h.gain, 2e-5, "late insert marker"));
  OM_CHECK(h.outL[30000 + 288] == h.outL[30000 + 287]);
  // a plugin that outputs a NaN: zeroed before the strip, every bus stays finite
  ins.nanAt[0] = h.pos + 1000;
  h.m.setDeckPfl(0, true);
  h.run(9600);
  bool finite = true;
  for (size_t i = 0; i < h.outL.size(); i++)
    finite &= std::isfinite(h.outL[i]) && std::isfinite(h.outR[i]) && std::isfinite(h.cueL[i]) && std::isfinite(h.cueR[i]);
  OM_CHECK(finite);
  // deck 0: 0.1 x 4 (trim) x 2 (plugin) = 0.8; deck 1 at volume 0; deck 2 silent by now; deck 3: 0.01
  OM_CHECK(near(h.lastL(), (0.8 + 0.01) * 0.7225 * 0.9 * h.gain, 2e-5, "after the NaN"));
  OM_CHECK(h.cueL.back() == 0.8f);  // PFL: post-insert, pre-fader
  h.m.setInsert(nullptr);
}

OM_TEST(mixer_fx_sends_latch_pad_send_dry_cut_and_dry_comp) {
  Harness h;
  mixtest::FakeFx u[4], pad2, master;
  for (int i = 0; i < 4; i++) h.m.attachFx(panelUnit(i), &u[i]);
  h.dcL[0] = h.dcR[0] = 0.1f;
  h.dcL[2] = h.dcR[2] = 0.05f;
  const float x0 = 0.1f * static_cast<float>(0.85 * 0.85);
  const float x2 = 0.05f * static_cast<float>(0.85 * 0.85);
  // unit 1 enabled and LIVE-assigned to deck 0, sends not latched yet
  h.m.setFx(panelUnit(1), kFxType | kFxEnabled | kFxLevel, FxType::Trans, true, 1.0f, 0.0f);
  h.m.setFxAssign(0x8421 | (1u << 4));
  FxRackView v;
  h.m.fxRackView(v);
  OM_CHECK(v.assign == (0x8421 | (1u << 4)) && v.assigned(1, 0));
  h.run(24000);
  OM_CHECK(u[1].inputEnergy == 0.0);  // no send until updateFxSends
  float pk, rms, dry;
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(dry == 0.0f);              // the dry cut already follows the live matrix (trans: cut 1 x wet 1)
  // the latch: send(0 -> 1) ramps to 1 with tau 15 ms
  h.m.updateFxSends();
  h.fixedBlock = 720;
  h.run(720);
  OM_CHECK_NEAR(u[1].lastInL[719] / x0, 1.0 - std::exp(-719.0 / 720.0), 1e-3);  // (+-1 frame: Chromium event start)
  h.fixedBlock = 0;
  h.run(24000);
  OM_CHECK(u[1].lastInL[0] == x0);
  // un-assigning live does not close the latched send; the dry cut lets go
  h.m.setFxAssign(0x8421);
  h.run(24000);
  OM_CHECK(u[1].lastInL[0] == x0);
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(dry == 1.0f);
  // enabling a unit later does not open its send by itself
  h.m.setFxAssign(0x8421 | (1u << 8));  // unit 2: deck 0 (live) and deck 2 (default)
  h.m.setFx(panelUnit(2), kFxType | kFxEnabled | kFxLevel, FxType::Echo, true, 0.4f, 0.0f);
  h.run(4800);
  OM_CHECK(u[2].inputEnergy == 0.0);
  h.m.updateFxSends();  // unit 2 opens for decks 0 and 2, unit 1 closes (no longer assigned)
  h.run(24000);
  OM_CHECK(u[2].lastInL[0] == x0 + x2 && u[1].lastInL[0] == 0.0f);
  // pad send: on = to 1 with tau 10 ms, off = to 0 with tau 20 ms (and the pad unit is disabled)
  h.m.attachFx(padUnit(2), &pad2);
  h.m.setPadFx(2, true, FxType::Delay, 1.0f, 0.7f);
  OM_CHECK(pad2.enabled && pad2.type == FxType::Delay && pad2.level == 0.7f);
  h.fixedBlock = 480;
  h.run(480);
  OM_CHECK_NEAR(pad2.lastInL[479] / x2, 1.0 - std::exp(-479.0 / 480.0), 1e-3);
  h.fixedBlock = 0;
  h.run(24000);
  OM_CHECK(pad2.lastInL[0] == x2);
  h.m.setPadFx(2, false, FxType::Delay, 1.0f, 0.7f);
  OM_CHECK(!pad2.enabled);
  h.fixedBlock = 960;
  h.run(960);
  // engine.js disconnects the disabled pad unit's input, so nothing pulls the
  // pad send (its ramp to 0, tau 20 ms, is never processed): Chromium freezes
  // it at 1 and the unit receives nothing (goldens/mixer x*_fx_paths)
  OM_CHECK(pad2.lastInL[959] == 0.0f);
  // pressed again: the frozen send resumes at 1, the input is back at once
  h.m.setPadFx(2, true, FxType::Delay, 1.0f, 0.7f);
  h.fixedBlock = 128;
  h.run(128);
  OM_CHECK(pad2.lastInL[0] == x2);
  h.fixedBlock = 0;
  // pad dry hold applies while the pad unit is enabled
  h.m.setPadDryHold(2, 0.2f);
  h.run(24000);
  h.m.deckMeters(2, pk, rms, dry);
  OM_CHECK(dry == 0.2f);
  h.m.setPadFx(2, false, FxType::Delay, 1.0f, 0.7f);
  h.run(24000);
  h.m.deckMeters(2, pk, rms, dry);
  // back to the panel dry cut: unit 2 (echo, level 0.4) is live-assigned to deck 2 by default
  OM_CHECK(dry == static_cast<float>(1.0 - 0.45 * static_cast<double>(0.4f)));
  // dry cut hysteresis 0.01 (engine.js _dryCur): unit 0 "filter" (cut 1) on deck 0
  h.m.setFxAssign(0x8421);
  h.m.updateFxSends();
  h.m.setFx(panelUnit(2), kFxEnabled, FxType::Echo, false, 0.0f, 0.0f);
  h.m.setFx(panelUnit(0), kFxType | kFxEnabled | kFxLevel, FxType::Filter, true, 0.5f, 0.0f);
  h.run(24000);
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(dry == 0.5f);
  h.m.setFx(panelUnit(0), kFxLevel, FxType::Filter, true, 0.505f, 0.0f);  // 0.495: within 0.01, no new target
  h.run(24000);
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(dry == 0.5f);
  h.m.setFx(panelUnit(0), kFxLevel, FxType::Filter, true, 0.52f, 0.0f);   // 0.48: moves
  h.run(24000);
  h.m.deckMeters(0, pk, rms, dry);
  OM_CHECK(dry == static_cast<float>(1.0 - static_cast<double>(0.52f)));
  // master dry compensation: 1 without a master unit, then 1 - fxDryCut(type) x wet, tau 50 ms, 0.01 hysteresis
  om_mixer_state s;
  h.m.snapshot(s);
  OM_CHECK(s.dry_comp == 1.0f);
  h.m.setFx(masterUnit(), 0, FxType::Echo, false, 0.0f, 0.0f);  // ensureMasterFx: exists, disabled
  h.m.attachFx(masterUnit(), &master);
  h.run(4800);
  h.m.snapshot(s);
  OM_CHECK(s.dry_comp == 1.0f);
  h.m.setFx(masterUnit(), kFxEnabled | kFxLevel, FxType::Echo, true, 0.6f, 0.0f);
  h.fixedBlock = 480;
  h.run(2400);
  h.m.snapshot(s);
  OM_CHECK_NEAR(s.dry_comp, 1.0 - 0.27 * (1.0 - std::exp(-2399.0 / 2400.0)), 2e-4);
  h.fixedBlock = 0;
  h.run(48000);
  h.m.snapshot(s);
  OM_CHECK(s.dry_comp == static_cast<float>(1.0 - 0.45 * static_cast<double>(0.6f)));
  const float settled = s.dry_comp;
  h.m.setFx(masterUnit(), kFxLevel, FxType::Echo, true, 0.61f, 0.0f);  // 0.0045 away: unchanged
  h.run(48000);
  h.m.snapshot(s);
  OM_CHECK(s.dry_comp == settled);
  h.m.setFx(masterUnit(), kFxLevel, FxType::Echo, true, 0.7f, 0.0f);
  h.run(48000);
  h.m.snapshot(s);
  OM_CHECK(s.dry_comp == static_cast<float>(1.0 - 0.45 * static_cast<double>(0.7f)));
}

OM_TEST(mixer_color_fx_modes) {
  Harness h;
  mixtest::FakeColor color;
  OM_CHECK(h.m.attachColor(&color) == nullptr);
  OM_CHECK(color.typeCalls == 1 && color.type == ColorType::Filter);
  const auto bass = mixtest::sine(6 * 48000, 50.0, 0.1);
  h.sigL[0] = h.sigR[0] = &bass;
  h.run(24000);
  const double ref = mixtest::rmsOf(h.outL.data() + 12000, 12000);
  // "filter": the FILTER biquad follows the knob (HPF 400 Hz at +0.5 kills 50 Hz), no send, no noise
  h.m.setDeckColor(0, 0.5f);
  h.run(24000);
  OM_CHECK(mixtest::rmsOf(h.outL.data() + 12000, 12000) < 0.03 * ref);
  OM_CHECK(color.inputEnergy == 0.0);
  // "noise": filter neutral, white noise x amt^2 x 0.4 into the fader input (engine.js's looped 2 s buffer)
  h.m.setColorType(ColorType::Noise);
  OM_CHECK(color.type == ColorType::Noise);
  h.sigL[0] = h.sigR[0] = nullptr;  // silent deck: only the noise remains
  h.run(48000);
  const double noiseRms = mixtest::rmsOf(h.outL.data() + 24000, 24000);
  const double wantNoise = 0.5 * 0.5 * 0.4 / std::sqrt(3.0) * 0.7225 * 0.9 * h.gain;
  OM_CHECK(near(noiseRms, wantNoise, 0.03, "noise RMS"));
  bool mono = true;  // the mono noise source is upmixed L = R
  for (size_t i = 0; i < h.outL.size(); i++) mono &= h.outL[i] == h.outR[i];
  OM_CHECK(mono);
  // the source is looped every 2 s (engine.js noiseSrc.loop): the same samples 96000 frames later
  h.run(96000 + 4800);
  bool looped = true;
  for (size_t i = 0; i < 4800; i++) looped &= h.outL[i] == h.outL[96000 + i];
  OM_CHECK(looped);
  OM_CHECK(color.inputEnergy == 0.0);
  // other types: filter neutral, color send = |v| into the Color FX bus, back x 0.85 through fxReturn
  h.dcL[0] = h.dcR[0] = 0.1f;
  h.m.setColorType(ColorType::DubEcho);
  OM_CHECK(color.type == ColorType::DubEcho);
  h.run(48000);
  OM_CHECK(color.inputEnergy > 0.0);
  OM_CHECK(near(h.lastL(), (0.1 * 0.7225 + 0.1 * 0.5 * 0.85) * 0.9 * h.gain, 2e-6, "color send"));
  // Color off: every knob neutral (no filter, no send, no noise)
  h.m.setColorEnabled(false);
  h.run(48000);
  OM_CHECK(near(h.lastL(), 0.1 * 0.7225 * 0.9 * h.gain, 2e-6, "color off"));
  color.inputEnergy = 0;
  h.run(4800);
  OM_CHECK(color.inputEnergy == 0.0);
  // back on in "filter" mode: the knob value is re-applied
  h.m.setColorEnabled(true);
  h.m.setColorType(ColorType::Filter);
  h.dcL[0] = h.dcR[0] = 0.0f;
  h.sigL[0] = h.sigR[0] = &bass;
  h.run(24000);
  OM_CHECK(mixtest::rmsOf(h.outL.data() + 12000, 12000) < 0.03 * ref);
  OM_CHECK(color.typeCalls >= 4);
}

OM_TEST(mixer_cue_routing_and_output_channels) {
  Harness h;
  h.dcL[1] = 0.3f;
  h.dcR[1] = 0.2f;
  h.m.setDeckVolume(1, 0.0f);  // PFL is pre-fader
  h.m.setDeckPfl(1, true);
  h.run(24000);
  OM_CHECK(h.cueL.back() == 0.3f && h.cueR.back() == 0.2f);
  OM_CHECK(h.outL.back() == 0.0f);
  om_mixer_state s;
  h.m.snapshot(s);
  OM_CHECK(s.cue_peak == 0.5f * (0.3f + 0.2f));  // every meter: the analyser mono fold (SPEC.md §10.8)
  // 4-channel controller: master 1/2, cue 3/4
  h.dcL[0] = h.dcR[0] = 0.2f;
  OutputRouting r;
  r.cueL = 2;
  r.cueR = 3;
  h.m.setRouting(r);
  h.fixedBlock = 256;
  h.run(48000);
  std::vector<float> out(256 * 6, 7.0f);
  h.m.writeOutput(out.data(), 256, 4);
  const float mL = h.m.masterL()[255], mR = h.m.masterR()[255];
  OM_CHECK(out[255 * 4 + 0] == mL && out[255 * 4 + 1] == mR && out[255 * 4 + 2] == 0.3f && out[255 * 4 + 3] == 0.2f);
  // more channels than routed: the others are silent
  h.m.writeOutput(out.data(), 256, 6);
  OM_CHECK(out[255 * 6 + 4] == 0.0f && out[255 * 6 + 5] == 0.0f && out[255 * 6 + 2] == 0.3f);
  // phones on another card (or a stereo output): no cue on the main device
  h.m.setRouting(OutputRouting());
  h.m.writeOutput(out.data(), 256, 4);
  OM_CHECK(out[255 * 4 + 2] == 0.0f && out[255 * 4 + 3] == 0.0f && out[255 * 4 + 0] == mL);
  // a mono endpoint gets the "speakers" down-mix
  h.m.writeOutput(out.data(), 256, 1);
  OM_CHECK(out[255] == 0.5f * (mL + mR));
  h.m.setDeckPfl(1, false);
  h.run(24000);
  OM_CHECK(h.cueL.back() == 0.0f);
}

OM_TEST(mixer_meters_never_miss_a_peak) {
  // the meter window: every reading taken less than windowSec after a peak reports it
  MeterWindow w;
  const double rate = 48000, window = 0.05;
  w.prepare(rate, window, 128);
  std::vector<float> z(kMaxBlockFrames, 0.0f), sp(kMaxBlockFrames, 0.0f);
  int64_t pos = 0;
  int k = 0;
  uint32_t x = 12345;
  int64_t lastSpike = -1;
  float lastAmp = 0;
  bool ok = true;
  int readings = 0;
  for (int iter = 0; iter < 3000; iter++) {
    const int n = mixtest::blockSize(k++);
    std::fill(sp.begin(), sp.begin() + n, 0.0f);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    if ((x & 7) == 0) {  // a single-sample spike somewhere in this block
      const int at = static_cast<int>(x % static_cast<uint32_t>(n));
      lastAmp = 0.1f + static_cast<float>(x % 1000) / 1000.0f;
      sp[static_cast<size_t>(at)] = lastAmp;
      lastSpike = pos + at;
    }
    {
      rt::Scope rts;
      w.process(sp.data(), z.data(), n);
    }
    pos += n;
    // a reader polling now must see the latest spike while it is younger than
    // the window (left channel only: the mono fold reads half of it)
    if (lastSpike >= 0 && static_cast<double>(pos - lastSpike) <= window * rate) {
      ok &= w.peak() >= 0.5f * lastAmp;
      readings++;
    }
  }
  OM_CHECK(ok && readings > 100);
  // RMS over the window
  MeterWindow r;
  r.prepare(rate, window, 128);
  const auto s = mixtest::sine(48000, 1000, 0.5);
  r.process(s.data(), s.data(), 48000);
  OM_CHECK_NEAR(r.rms(), 0.5 / std::sqrt(2.0), 2e-3);
  OM_CHECK_NEAR(r.peak(), 0.5, 1e-3);
  // The peak is Chromium's AnalyserNode one: the "speakers" mono fold
  // 0.5 x (L + R) (engine.js meterPeak / masterPeak have no splitter in
  // front). Review round of 7 Nov 2026, parity #2. The RMS stays per channel.
  {
    std::vector<float> zeros(s.size(), 0.0f), inv(s.size());
    for (size_t i = 0; i < s.size(); i++) inv[i] = -s[i];
    MeterWindow oneSided, antiPhase, oddEnd;
    oneSided.prepare(rate, window, 128);
    antiPhase.prepare(rate, window, 128);
    oneSided.process(s.data(), zeros.data(), 48000);     // hard left: half the level (-6 dB)
    OM_CHECK_NEAR(oneSided.peak(), 0.25, 1e-3);
    OM_CHECK_NEAR(oneSided.rms(), 0.5 / std::sqrt(2.0) / std::sqrt(2.0), 2e-3);
    antiPhase.process(s.data(), inv.data(), 48000);      // anti-phase: the mono fold is silent
    OM_CHECK(antiPhase.peak() == 0.0f);
    oddEnd.prepare(rate, window, 128);
    const float l3[3] = {0.0f, 0.0f, 0.8f}, r3[3] = {0.0f, 0.0f, 0.2f};  // the odd tail sample folds too
    oddEnd.process(l3, r3, 3);
    OM_CHECK(oddEnd.peak() == 0.5f);
  }
  // in the mixer: the master meter is before the limiter, the output is limited
  Harness h;
  h.dcL[0] = h.dcR[0] = 2.0f;  // +6 dBFS into the strip
  h.m.setDeckVolume(0, 1.0f);
  h.m.setMasterVolume(1.0f);
  h.run(48000);
  om_mixer_state st;
  h.m.snapshot(st);
  OM_CHECK(st.master_peak == 2.0f);
  OM_CHECK(st.gain_reduction_db < -5.0f);
  OM_CHECK(std::fabs(h.lastL()) < 1.2f);
}

// app.js's frame loop calls setBeatDur() on enabled units only: a disabled
// unit keeps its beat duration and glides from it when enabled again. The
// core's per-block beat clock reaches enabled panel, pad and master units
// only. Review round of 7 Nov 2026, parity #3.
OM_TEST(mixer_beat_clock_reaches_enabled_fx_units_only) {
  Harness h;
  mixtest::FakeFx panel, pad, master;
  h.m.attachFx(panelUnit(1), &panel);
  h.m.setPadFx(2, true, FxType::Echo, 0.5f, 0.6f);  // requested and enabled before the unit exists
  h.m.attachFx(padUnit(2), &pad);
  h.m.setFx(masterUnit(), kFxType | kFxLevel, FxType::Echo, false, 0.5f, 0.0f);
  h.m.attachFx(masterUnit(), &master);
  BeatClock bc;
  bc.valid = true;
  bc.beatDur = 0.47;
  auto feed = [&] {
    for (int u = 0; u < kNumFxUnits; u++) h.m.setFxBeatClock(panelUnit(u), bc);
    for (int d = 0; d < kNumDecks; d++) h.m.setFxBeatClock(padUnit(d), bc);
    h.m.setFxBeatClock(masterUnit(), bc);
  };
  feed();
  OM_CHECK(panel.beatClocks == 0 && master.beatClocks == 0);  // disabled: the clock does not reach them
  OM_CHECK(pad.beatClocks == 1 && pad.lastClock.beatDur == 0.47);
  // enabled: the next clock arrives (the unit glides from its stale duration)
  h.m.setFx(panelUnit(1), kFxEnabled, FxType::Echo, true, 0.0f, 0.0f);
  h.m.setFx(masterUnit(), kFxEnabled, FxType::Echo, true, 0.0f, 0.0f);
  bc.beatDur = 0.5;
  feed();
  OM_CHECK(panel.beatClocks == 1 && master.beatClocks == 1 && pad.beatClocks == 2);
  OM_CHECK(panel.lastClock.beatDur == 0.5 && master.lastClock.beatDur == 0.5);
  // disabled again (the pad released): frozen at the last value
  h.m.setFx(panelUnit(1), kFxEnabled, FxType::Echo, false, 0.0f, 0.0f);
  h.m.setPadFx(2, false, FxType::Echo, 0.5f, 0.6f);
  bc.beatDur = 0.42;
  feed();
  OM_CHECK(panel.beatClocks == 1 && pad.beatClocks == 2 && master.beatClocks == 2);
  OM_CHECK(panel.lastClock.beatDur == 0.5 && pad.lastClock.beatDur == 0.5 && master.lastClock.beatDur == 0.42);
}

OM_TEST(mixer_reset_to_defaults_restores_engine_js_state) {
  Harness a, b;
  mixtest::FakeFx unit;
  a.m.attachFx(panelUnit(0), &unit);
  for (Harness* h : {&a, &b}) h->dcL[0] = h->dcR[0] = h->dcL[3] = h->dcR[3] = 0.1f;
  a.m.setDeckVolume(0, 0.3f);
  a.m.setDeckEq(0, EqBand::Low, -1.0f);
  a.m.setDeckTrim(3, 0.5f);
  a.m.setDeckColor(3, -0.7f);
  a.m.setCrossfader(0.9f);
  a.m.setMasterVolume(0.2f);
  a.m.setMasterFilter(0.6f);
  a.m.setColorType(ColorType::Noise);
  a.m.setDeckPfl(0, true);
  a.m.setFx(panelUnit(0), kFxEnabled | kFxLevel, FxType::Echo, true, 0.9f, 0.0f);
  a.m.updateFxSends();
  a.m.setPadFx(2, true, FxType::Roll, 1.0f, 1.0f);
  a.run(24000);
  a.m.resetToDefaults();
  OM_CHECK(!unit.enabled && unit.level == 0.0f);  // mirrors pushed to the attached unit
  FxRackView v;
  a.m.fxRackView(v);
  OM_CHECK(!v.padExists[2] && v.assign == 0x8421 && !v.panel[0].enabled);
  const MixView mv = a.m.mixView();
  OM_CHECK(mv.volume[0] == 0.85f && mv.eqLow[0] == 0.0f && mv.xfGain[0] == 1.0f);
  a.run(48000);
  b.run(72000);
  OM_CHECK(near(a.lastL(), b.lastL(), 1e-6, "reset L") && near(a.lastR(), b.lastR(), 1e-6, "reset R"));
  OM_CHECK(a.cueL.back() == 0.0f);
}

// ---------------------------------------------------------------------------
// The master bus against Chromium (engine.js's AudioEngine, golden suite master/*)
// ---------------------------------------------------------------------------
// volume_steps / filter_sweep: input -> masterGain -> dryComp -> postBus ->
// mFilter -> limiter. The input enters through deck 0 at its default
// settings (bit-transparent strip) pre-scaled by 1 / 0.7225 (the default
// fader), so masterGain receives it within one float rounding (< -150 dBFS).
// crossfader_curve: deck 0 = [L, L], deck 1 = [R, R], whole strips. The
// master filter's `.value` steps land where Chromium puts them
// (mixtest::chromiumStepFrame).
OM_TEST(mixer_master_null_vs_chromium_audio_engine) {
  double worst = -400.0;
  int unknown = 0, bad = 0;
  for (const char* name : {"volume_steps", "filter_sweep", "crossfader_curve"}) {
    const mixtest::Golden g = mixtest::loadGolden("master", name);
    MIXTEST_REQUIRE_GOLDEN(g);
    dsp::flushDenormals();
    Harness h(g.meta["sampleRate"].asNumber(48000));
    const bool xfCase = std::string(name) == "crossfader_curve";
    std::vector<float> l = mixtest::channel(g.input, 0), r = mixtest::channel(g.input, 1);
    if (xfCase) {
      h.sigL[0] = h.sigR[0] = &l;
      h.sigL[1] = h.sigR[1] = &r;
    } else {
      h.sigL[0] = &l;
      h.sigR[0] = &r;
      h.sigScale[0] = 1.0f / static_cast<float>(0.85 * 0.85);
    }
    const int64_t frames = g.out.frames();
    std::vector<float> gotL, gotR;
    auto ev = mixtest::events(g.meta);
    mixtest::applyChromiumStepTiming(ev, h.rate, "engine.setMasterFilter", &bad);
    size_t e = 0;
    while (h.pos < frames) {
      while (e < ev.size() && ev[e].frame == h.pos) {
        const mixtest::Event& x = ev[e];
        if (x.call == "engine.setMasterVolume") h.m.setMasterVolume(static_cast<float>(x.num(0)));
        else if (x.call == "engine.setMasterFilter") h.m.setMasterFilter(static_cast<float>(x.num(0)));
        else if (x.call == "engine.setCrossfader") h.m.setCrossfader(static_cast<float>(x.num(0)));
        else unknown++;
        e++;
      }
      int64_t n = frames - h.pos;
      if (e < ev.size()) n = ev[e].frame - h.pos;
      h.run(n);
      gotL.insert(gotL.end(), h.outL.begin(), h.outL.end());
      gotR.insert(gotR.end(), h.outR.begin(), h.outR.end());
    }
    const double res = mixtest::residualStereo(gotL, gotR, g.out);
    std::printf("    master/%s: residual %.1f dBFS (%zu events)\n", name, res, ev.size());
    worst = std::fmax(worst, res);
  }
  OM_CHECK(unknown == 0 && bad == 0);
  OM_CHECK(worst < -80.0);
}

// ---------------------------------------------------------------------------
// Everything on at once: no allocation, no free in the audio path
// ---------------------------------------------------------------------------
OM_TEST(mixer_everything_on_is_realtime_safe) {
  Harness h;
  mixtest::FakeFx u[4], pads[4], master;
  mixtest::FakeColor color;
  mixtest::FakeInsert ins;
  for (int i = 0; i < 4; i++) {
    h.m.attachFx(panelUnit(i), &u[i]);
    h.m.attachFx(padUnit(i), &pads[i]);
    ins.active[i] = (i & 1) == 0;
  }
  h.m.attachFx(masterUnit(), &master);
  h.m.attachColor(&color);
  h.m.setInsert(&ins);
  std::vector<float> sig[kNumDecks];
  for (int d = 0; d < kNumDecks; d++) {
    sig[d] = mixtest::noise(4 * 48000, 0.3f, 100 + d);
    h.sigL[d] = h.sigR[d] = &sig[d];
  }
  auto smp = dcSound(0.01f, 48000);
  h.m.sampler().attach(1, smp.get());
  for (int step = 0; step < 40; step++) {
    // knob moves between blocks, as the command queue applies them
    const float t = static_cast<float>(step) / 40.0f;
    {
      rt::Scope rts;  // the setters run on the audio thread too
      for (int d = 0; d < kNumDecks; d++) {
        h.m.setDeckEq(d, static_cast<EqBand>(step % 3), std::sin(t * 7 + d));
        h.m.setDeckVolume(d, 0.5f + 0.5f * std::sin(t * 3 + d));
        h.m.setDeckTrim(d, 0.3f * std::sin(t * 5));
        h.m.setDeckColor(d, std::sin(t * 11 + d));
        h.m.setDeckPfl(d, (step + d) % 3 == 0);
        h.m.setFx(panelUnit(d), kFxType | kFxEnabled | kFxLevel, static_cast<FxType>((step + d) % kNumFxTypes),
                  (step + d) % 2 == 0, t, 0.0f);
        h.m.setPadFx(d, (step + d) % 4 == 0, FxType::Echo, 1.0f, t);
        h.m.setPadDryHold(d, (step + d) % 5 == 0 ? 0.3f : NAN);
      }
      h.m.setColorType(static_cast<ColorType>(step % kNumColorTypes));
      h.m.setColorEnabled(step % 7 != 3);
      h.m.setCrossfader(t);
      h.m.setXfSide(step % 4, (step & 1) ? XfSide::A : XfSide::B);
      h.m.setMasterVolume(1.0f - t * 0.5f);
      h.m.setMasterFilter(std::sin(t * 13));
      h.m.setFxAssign(static_cast<uint16_t>(0x8421 ^ (step * 0x1357)));
      h.m.updateFxSends();
      h.m.setFx(masterUnit(), kFxEnabled | kFxLevel, FxType::Echo, step % 2 == 0, t, 0.0f);
      BeatClock bc;
      bc.valid = true;
      for (int i = 0; i < 4; i++) h.m.setFxBeatClock(panelUnit(i), bc);
      h.m.setFxBeatClock(masterUnit(), bc);
      h.m.sampler().play(1, static_cast<uint32_t>(step), 0.5f, h.clock(0));
      if (step % 5 == 0) h.m.sampler().stop(static_cast<uint32_t>(step - 1));
    }
    h.run(4800);
  }
  om_mixer_state s;
  {
    rt::Scope rts;
    h.m.snapshot(s);
    float pk, rms, dry;
    for (int d = 0; d < kNumDecks; d++) h.m.deckMeters(d, pk, rms, dry);
    std::vector<float>& o = h.outL;  // (already sized)
    h.m.writeOutput(o.data(), 256, 4);
    FxRackView v;
    h.m.fxRackView(v);
    (void)h.m.mixView();
    h.m.resetToDefaults();  // hello {reset} runs on the audio thread
  }
  bool finite = true;
  for (float x : h.outL) finite &= std::isfinite(x) != 0;
  OM_CHECK(finite);
  OM_CHECK(u[0].beatClocks > 0 && master.beatClocks > 0);
  h.m.sampler().stopAll();
  h.m.sampler().attach(1, nullptr);
  h.m.setInsert(nullptr);
}

// ---------------------------------------------------------------------------
// CPU cost per 128-frame block (the owner's priority: less work per block
// than the Web engine's graph). Reported; bounded loosely in optimized
// builds only (a shared PC: timings are noisy).
// ---------------------------------------------------------------------------
namespace {
// Minimal units for the benchmark (the mixer's own cost, not the fakes'):
// wet = input x level, silence when disabled — like a real unit's contract.
struct BenchFx final : IFxProcessor {
  bool enabled = false;
  float level = 0.0f;
  void setType(FxType) noexcept override {}
  void setEnabled(bool on) noexcept override { enabled = on; }
  void setLevel(float v) noexcept override { level = v; }
  void setBeatsMult(float) noexcept override {}
  void setBeatClock(const BeatClock&) noexcept override {}
  float wetGain() const noexcept override { return enabled ? level : 0.0f; }
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override {
    const float g = enabled ? level : 0.0f;
    for (int i = 0; i < n; i++) {
      outL[i] = inL[i] * g;
      outR[i] = inR[i] * g;
    }
  }
};
struct BenchColor final : IColorProcessor {
  void setType(ColorType) noexcept override {}
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override {
    for (int i = 0; i < n; i++) {
      outL[i] = inL[i];
      outR[i] = inR[i];
    }
  }
};
}  // namespace

OM_TEST(mixer_cpu_per_block_benchmark) {
  struct Load {
    const char* name;
    float level;  // deck signal amplitude (0 = silent decks)
    bool busy;
    bool eq = true;
  } loads[] = {{"idle: 4 silent decks, default knobs", 0.0f, false},
               {"4 decks playing, flat EQ, 2 FX sends, limiter below threshold", 0.1f, false, false},
               {"typical, quiet: 4 decks, 2 EQ bands set, 2 FX sends, limiter below threshold", 0.1f, false},
               {"typical, loud: same, limiter compressing", 0.4f, false},
               {"worst: every EQ moving, filters, noise, cue, sends, inserts, 16 voices, heavy limiting", 1.5f, true}};
  for (const Load& L : loads) {
    Harness h;
    BenchFx u[4], master;
    BenchColor color;
    mixtest::FakeInsert ins;
    for (int i = 0; i < 4; i++) h.m.attachFx(panelUnit(i), &u[i]);
    h.m.attachFx(masterUnit(), &master);
    h.m.attachColor(&color);
    std::vector<float> sig[kNumDecks];
    for (int d = 0; d < kNumDecks; d++) {
      sig[d] = mixtest::noise(48000, L.level, 7 + d);
      h.sigL[d] = h.sigR[d] = &sig[d];
    }
    auto smp = dcSound(0.01f, 10 * 48000);
    h.m.sampler().attach(0, smp.get());
    if (L.level > 0) {
      for (int d = 0; d < kNumDecks; d++) {
        if (L.eq) {
          h.m.setDeckEq(d, EqBand::Low, 0.3f);
          h.m.setDeckEq(d, EqBand::High, -0.2f);
        }
        h.m.setDeckVolume(d, 1.0f);
      }
      h.m.setFx(panelUnit(0), kFxEnabled | kFxLevel, FxType::Echo, true, 0.6f, 0.0f);
      h.m.setFx(panelUnit(1), kFxEnabled | kFxLevel, FxType::Echo, true, 0.6f, 0.0f);
      h.m.updateFxSends();
    }
    if (L.busy) {
      h.m.setInsert(&ins);
      for (int d = 0; d < kNumDecks; d++) {
        ins.active[d] = true;
        h.m.setDeckPfl(d, true);
      }
      h.m.setColorType(ColorType::Noise);
      for (int d = 0; d < kNumDecks; d++) h.m.setDeckColor(d, 0.5f);
      h.m.setMasterFilter(-0.3f);
      h.m.setMasterVolume(1.0f);
      for (uint32_t v = 0; v < 16; v++) h.m.sampler().play(0, v, 0.5f, h.clock(0));
    }
    h.fixedBlock = 128;
    h.run(4800);  // warm-up
    const int blocks = 3000;
    std::vector<double> us(static_cast<size_t>(blocks));
    DeckInput din[kNumDecks];
    for (int d = 0; d < kNumDecks; d++) {
      din[d].l = sig[d].data();
      din[d].r = sig[d].data();
    }
    for (int b = 0; b < blocks; b++) {
      if (L.busy) {
        // every EQ knob of every deck moves every block (per-sample coefficients all the time)
        const float t = static_cast<float>(b) * 0.01f;
        for (int d = 0; d < kNumDecks; d++) {
          h.m.setDeckEq(d, EqBand::Low, std::sin(t + d));
          h.m.setDeckEq(d, EqBand::Mid, std::sin(1.3f * t + d));
          h.m.setDeckEq(d, EqBand::High, std::sin(1.7f * t + d));
          h.m.setDeckColor(d, 0.3f + 0.2f * std::sin(t));
        }
      }
      for (int d = 0; d < kNumDecks; d++) {
        const size_t off = static_cast<size_t>((b * 128) % (48000 - 128));
        din[d].l = sig[d].data() + off;
        din[d].r = sig[d].data() + off;
      }
      const BlockClock c = h.clock(128);
      const auto t0 = std::chrono::steady_clock::now();
      {
        rt::Scope rts;
        h.m.process(din, 128, c);
      }
      const auto t1 = std::chrono::steady_clock::now();
      h.pos += 128;
      us[static_cast<size_t>(b)] = std::chrono::duration<double, std::micro>(t1 - t0).count();
    }
    std::vector<double> sorted = us;
    std::sort(sorted.begin(), sorted.end());
    double sum = 0;
    for (double x : us) sum += x;
    const double mean = sum / blocks, p50 = sorted[blocks / 2], p99 = sorted[blocks * 99 / 100];
    const double period = 128.0 / 48000.0 * 1e6;  // 2666.7 us
    om_mixer_state s;
    h.m.snapshot(s);
#ifdef NDEBUG
    const char* build = "optimized";
#else
    const char* build = "debug";
#endif
    std::printf("    [%s] %s: mean %.2f us, p50 %.2f us, p99 %.2f us per 128-frame block = %.3f %% of the period (GR %.1f dB)\n",
                build, L.name, mean, p50, p99, 100.0 * mean / period, s.gain_reduction_db);
#ifdef NDEBUG
    OM_CHECK(p50 < 0.25 * period);  // loose: a regression guard, not a benchmark
#endif
    h.m.sampler().stopAll();
    h.m.sampler().attach(0, nullptr);
    h.m.setInsert(nullptr);
  }
}
