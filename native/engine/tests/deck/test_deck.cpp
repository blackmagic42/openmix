// Tests of the deck module (owner: deck), SPEC.md §4.3, §4.4, §9, §18:
// engine.js transport rules, segments on discontinuities, the insert-latency
// cap, WSOLA constants, the interpolator's linear default, and the
// acceptance tests: the read pointer (exact copy at rate 1, Chromium
// interpolation otherwise, int16 through each chunk's scale), heard
// positions / segments / rate / positionAt through tempo changes, seeks with
// 'at', pre-roll and loop wraps, armed starts, the end latch, the WSOLA
// quantum grid, keylock priming and its cost, scratch, spin, roll, stems and
// chunk-not-ready silence. Every render runs inside an rt::Scope (no
// allocation, no free). The Chromium golden null tests are in
// test_deck_golden.cpp, the measurements in test_deck_perf.cpp.
#include <cmath>
#include <cstdio>
#include <vector>

#include "../../src/deck/deck_internal.h"
#include "../om_test.h"
#include "deck_test_util.h"
#include "om/deck.h"
#include "om/rt.h"
#include "om/wsola.h"

using namespace om;
using decktest::Rig;

namespace {
std::unique_ptr<TrackBuffer> sineTrack(double seconds, int rate = 48000) {
  const int64_t frames = static_cast<int64_t>(seconds * rate);
  auto tb = TrackBuffer::allocate(1, PcmKind::Track, PcmFormat::F32, rate, frames, 0.0f);
  for (int64_t i = 0; i < frames; i++) {
    const float v = static_cast<float>(0.5 * std::sin(2 * kPi * 440.0 * i / rate));
    tb->f32[2 * i] = v;
    tb->f32[2 * i + 1] = v;
  }
  for (int64_t c = 0; c < tb->numChunks; c++) tb->publishChunk(c, 1.0f);
  return tb;
}
BlockClock clockAt(int64_t frame) {
  BlockClock c;
  c.frame = frame;
  c.frames = 256;
  c.callbackTime = frame / 48000.0;
  c.presentTime = c.callbackTime + 0.01;
  c.sampleTime = frame / 48000.0;
  return c;
}
om_deck_state snap(const Deck& d, const Rig& rig) {
  om_deck_state s;
  d.snapshot(s, rig.presentAt(rig.frame));
  return s;
}
// Chromium's AudioBufferSourceNode reference (accumulated position, double lerp).
float chromiumAt(const TrackBuffer& tb, double p, int ch) {
  const double fi = std::floor(p);
  const int64_t i = static_cast<int64_t>(fi);
  const double f = p - fi;
  const float a = ch ? decktest::trackR(tb, i) : decktest::trackL(tb, i);
  const float b = ch ? decktest::trackR(tb, i + 1) : decktest::trackL(tb, i + 1);
  return static_cast<float>((1.0 - f) * a + f * b);
}
// Average frequency of a sine over [a, b) from interpolated upward zero crossings.
double freqOver(const std::vector<float>& x, size_t a, size_t b, double rate) {
  double first = -1, last = -1;
  int n = 0;
  for (size_t i = a + 1; i < b && i < x.size(); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const double t = (i - 1) + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = t;
      last = t;
      n++;
    }
  }
  return n >= 2 ? (n - 1) * rate / (last - first) : 0.0;
}
}  // namespace

OM_TEST(wsola_constants_match_pitch_worklet) {
  // pitch-worklet.js: LAT = ceil(N * (R_MAX + 1) / 2 + SEARCH + 16)
  const int lat = static_cast<int>(std::ceil(Wsola::kGrain * (Wsola::kRatioMax + 1) / 2 + Wsola::kSearch + 16));
  OM_CHECK(lat == Wsola::kLatency);
  static_assert(Wsola::kHop == 768 && Wsola::kOverlap == 768 && Wsola::kRing == 16384 && Wsola::kAcc == 4096,
                "pitch-worklet.js HS / OVL / RING / ACC");
  static_assert(Wsola::kQuantum == 128, "the k-rate ratio changes on 128-frame quanta");
}

OM_TEST(deck_engine_js_transport_rules) {
  auto tb = sineTrack(2.0);
  Deck d(0);
  d.prepare(48000, kMaxBlockFrames);
  OM_CHECK(d.attachTrack(tb.get()) == nullptr);
  const BlockClock clk = clockAt(0);
  d.setLoop(0.5, 0.505);  // shorter than 10 ms: ignored (engine.js setLoop)
  OM_CHECK(!d.looping());
  d.setLoop(0.5, 1.0);
  OM_CHECK(d.looping());
  d.seek(1.5, 0, clk);  // jumping out of the loop disables it (engine.js seek)
  OM_CHECK(!d.looping());
  d.seek(1.995, 0, clk);
  d.play(0, clk);  // at the end: restarts at 0 (engine.js play)
  OM_CHECK(d.playing());
  OM_CHECK_NEAR(d.heardPosition(), 0.0, 1e-12);
  d.setKey(12);
  OM_CHECK(d.keyShift() == kKeyMax);
  d.setKeylock(true);
  d.resetForLoad();  // engine.js loadTrack keeps KEYLOCK
  OM_CHECK(d.keylock() && d.keyShift() == 0 && !d.playing());
  om_deck_state s;
  d.snapshot(s, clk.presentTime);
  OM_CHECK(s.loaded == 1 && s.load_id == 1 && std::isnan(s.loop_beats) && std::isnan(s.ended_at));
  OM_CHECK(std::isnan(d.endedAtSample()) && d.endedCount() == 0);
  OM_CHECK(d.attachTrack(nullptr) == tb.get());
}

OM_TEST(deck_segments_change_on_discontinuities) {
  auto tb = sineTrack(4.0);
  Deck d(2);
  d.prepare(48000, kMaxBlockFrames);
  d.attachTrack(tb.get());
  om_deck_state s;
  d.snapshot(s, 0);
  const uint32_t seg0 = s.seg;
  d.play(0, clockAt(4800));
  d.snapshot(s, 0);
  OM_CHECK(s.seg == seg0 + 1);
  OM_CHECK_NEAR(s.anchor_t, clockAt(4800).presentTime, 1e-12);  // the play is heard from its block's presentTime
  d.setTempo(1.05);  // continuous: no new segment
  d.snapshot(s, 0);
  OM_CHECK(s.seg == seg0 + 1);
  d.seek(2.0, 0, clockAt(9600));
  d.snapshot(s, 0);
  OM_CHECK(s.seg == seg0 + 2 && s.anchor_pos == 2.0);
  d.pause(0, clockAt(14400));
  d.snapshot(s, 0);
  OM_CHECK(s.seg == seg0 + 3);
}

OM_TEST(deck_insert_latency_is_capped) {
  Deck d(3);
  d.prepare(48000, kMaxBlockFrames);
  d.setInsertLatency(10 * 48000);  // a plugin claiming 10 s
  OM_CHECK(d.procLatencySec() <= kMaxInsertLatencySec + 1e-9);
}

OM_TEST(deck_render_is_allocation_free) {
  auto tb = sineTrack(1.0);
  Deck d(1);
  d.prepare(48000, kMaxBlockFrames);
  d.attachTrack(tb.get());
  std::vector<float> l(256), r(256);
  const BlockClock clk = clockAt(0);
  {
    rt::Scope rts;
    d.play(0, clk);
    d.render(l.data(), r.data(), 256, clk);
    om_deck_state s;
    d.snapshot(s, clk.presentTime);
  }
}

OM_TEST(interpolator_linear_between_frames) {
  auto tb = TrackBuffer::allocate(2, PcmKind::Track, PcmFormat::F32, 48000, 2, 0.0f);
  tb->f32[0] = 0.0f;
  tb->f32[1] = 1.0f;
  tb->f32[2] = 1.0f;
  tb->f32[3] = 0.0f;
  tb->publishChunk(0, 1.0f);
  Interpolator in;
  OM_CHECK(in.quality() == InterpQuality::Linear);  // Chromium parity by default
  float l, r;
  in.read(*tb, 0.25, 1.0, l, r);
  OM_CHECK_NEAR(l, 0.25, 1e-7);
  OM_CHECK_NEAR(r, 0.75, 1e-7);
}

// ---------------------------------------------------------------------------
// Acceptance tests (SPEC.md §9)
// ---------------------------------------------------------------------------

// tempo 1.0 integer start = exact copy (through each int16 chunk's scale);
// tempo != 1 and file rate != device rate = Chromium's interpolation. The
// null tests against Chromium's own renders (loop seams, end of buffer, rate
// steps) are golden_deck_read_pointer_vs_audio_buffer_source.
OM_TEST(todo_deck_read_pointer_parity) {
  std::vector<float> L, R;
  decktest::makeSignal(L, R, 200000, 48000, 7);
  // three chunk scales: the per-chunk headroom of stems and samples
  auto tb = decktest::makeTrack(L, R, 48000, PcmFormat::S16, {1.0f / 32767, 1.45f / 32767, 1.2f / 32767});
  {
    Deck d(0);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(60000 / 48000.0, 0, rig.now());  // crosses into chunk 1 at 65536, chunk 2 at 131072
    d.play(0, rig.clock(441));
    rig.renderPattern(d, 80000, {441, 480, 128, 37, 2048});
    for (size_t i = 0; i < rig.outL.size(); i++) {
      OM_CHECK(rig.outL[i] == decktest::trackL(*tb, 60000 + static_cast<int64_t>(i)));
      OM_CHECK(rig.outR[i] == decktest::trackR(*tb, 60000 + static_cast<int64_t>(i)));
    }
  }
  // tempo != 1, and a 44.1 kHz file on a 48 kHz device: Chromium's formula
  std::vector<float> L4, R4;
  decktest::makeSignal(L4, R4, 150000, 44100, 9);
  auto tb44 = decktest::makeTrack(L4, R4, 44100, PcmFormat::S16, {1.1f / 32767, 1.0f / 32767});
  struct Case {
    const TrackBuffer* tb;
    double tempo;
    int64_t start;
  } cases[] = {{tb.get(), 1.37, 1000}, {tb.get(), 0.61, 70000}, {tb44.get(), 1.0, 500}, {tb44.get(), 1.21, 3}};
  for (const Case& c : cases) {
    Deck d(1);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(c.tb);
    Rig rig;
    d.setTempo(c.tempo);
    d.seek(static_cast<double>(c.start) / c.tb->sampleRate, 0, rig.now());
    d.play(0, rig.clock(480));
    rig.renderPattern(d, 60000, {480, 441, 2048, 1});
    const double inc = (c.tb->sampleRate / 48000.0) * static_cast<double>(static_cast<float>(c.tempo));
    double p = static_cast<double>(c.start);
    double worst = 0;
    for (size_t i = 0; i < rig.outL.size(); i++) {
      worst = std::max(worst, std::fabs(static_cast<double>(rig.outL[i]) - chromiumAt(*c.tb, p, 0)));
      worst = std::max(worst, std::fabs(static_cast<double>(rig.outR[i]) - chromiumAt(*c.tb, p, 1)));
      p += inc;
    }
    OM_CHECK(worst == 0.0);
  }
}

// Heard position at presentTime exact through tempo changes, seeks with 'at',
// pre-roll, sample-exact loop wrap (no new segment), procLatency = WSOLA
// lockstep + insert latency, positionAt(E) exact, rate = nominal HEARD rate
// after the WSOLA lag, segments at every discontinuity.
OM_TEST(todo_deck_positions_segments_and_latency) {
  auto tb = decktest::musicTrack(20.0);
  const double fs = 48000;
  // ---- tempo changes: exact positions, no segment, rate = tempo heard at once (direct path)
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(2.0, 0, rig.now());
    d.play(0, rig.clock(256));
    om_deck_state s = snap(d, rig);
    const uint32_t seg0 = s.seg;
    OM_CHECK_NEAR(s.anchor_t, rig.presentAt(0), 1e-12);
    OM_CHECK(s.anchor_pos == 2.0);
    double p = 2.0 * fs;  // the read pointer, accumulated like Chromium
    double inc = 1.0;
    rig.renderPattern(d, 10000, {256, 441});
    p += 10000 * inc;
    s = snap(d, rig);
    OM_CHECK_NEAR(s.pos, p / fs, 1e-12);
    OM_CHECK(s.rate == 1.0 && s.seg == seg0);
    const double tempos[] = {1.08, 0.93, 1.6, 0.5};
    for (double t : tempos) {
      d.setTempo(t);
      inc = static_cast<double>(static_cast<float>(t));
      rig.renderPattern(d, 7001, {300, 1, 2048});
      for (int i = 0; i < 7001; i++) p += inc;
      s = snap(d, rig);
      OM_CHECK_NEAR(s.pos, p / fs, 1e-9);
      OM_CHECK(s.rate == static_cast<double>(static_cast<float>(t)));
      OM_CHECK(s.seg == seg0);  // tempo changes never start a segment
      // positionAt(E): exact inside the next block
      const double E = rig.presentAt(rig.frame) + 100 / fs;
      double q = p;
      for (int i = 0; i < 100; i++) q += inc;
      OM_CHECK_NEAR(d.positionAt(E), q / fs, 1e-9);
    }
    // ---- seek with 'at': the UI computed t at `at`, 30 ms before the block is heard
    d.setTempo(1.1);
    const EngineTime at = rig.presentAt(rig.frame) - 0.03;
    d.seek(9.0, at, rig.clock(256));
    s = snap(d, rig);
    OM_CHECK(s.seg == seg0 + 1);
    OM_CHECK_NEAR(s.anchor_t, rig.presentAt(rig.frame), 1e-12);
    OM_CHECK_NEAR(s.anchor_pos, 9.0 + 0.03 * 1.1, 0.5 / fs + 1e-12);  // advanced by (presentTime - at) x tempo, frame-rounded
    const double a0 = s.anchor_pos;
    rig.renderPattern(d, 4800, {441});
    s = snap(d, rig);
    double q = a0 * fs;
    for (int i = 0; i < 4800; i++) q += static_cast<double>(static_cast<float>(1.1));
    OM_CHECK_NEAR(s.pos, q / fs, 1e-9);
  }
  // ---- pre-roll: silence until the position crosses 0 at the current tempo
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.setTempo(1.25);
    d.seek(-0.25, 0, rig.now());
    d.play(0, rig.clock(256));
    rig.render(d, 14000, 256);
    size_t firstSound = 0;
    while (firstSound < rig.outL.size() && rig.outL[firstSound] == 0 && rig.outR[firstSound] == 0) firstSound++;
    // position -0.25 s * 48000 = -12000 frames, advancing 1.25 per frame: 0 is crossed after 9600 frames
    OM_CHECK(firstSound >= 9599 && firstSound <= 9600);
    const om_deck_state s = snap(d, rig);
    OM_CHECK_NEAR(s.pos, (-12000.0 + 14000 * 1.25) / fs, 1e-9);
  }
  // ---- loop: sample-exact wrap, no new segment (frame-exact loop points: 240000 .. 246000;
  //      loop points that are not whole frames keep Chromium's fractional wrap, see the goldens)
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(5.0, 0, rig.now());
    d.setLoop(5.0, 5.125);
    d.play(0, rig.clock(256));
    const uint32_t seg0 = snap(d, rig).seg;
    rig.renderPattern(d, 31000, {256, 441, 37});
    for (size_t i = 0; i < rig.outL.size(); i++) {
      const float want = decktest::trackL(*tb, 240000 + static_cast<int64_t>(i % 6000));
      if (rig.outL[i] != want) {
        std::printf("    loop mismatch at %zu: %.9g vs %.9g (prev %.9g / %.9g)\n", i, rig.outL[i], want,
                    i ? rig.outL[i - 1] : 0.0f, decktest::trackL(*tb, 240000 + static_cast<int64_t>((i - 1) % 6000)));
      }
      OM_CHECK(rig.outL[i] == want);
    }
    const om_deck_state s = snap(d, rig);
    OM_CHECK(s.seg == seg0 && s.looping);
    OM_CHECK_NEAR(s.pos, (240000 + 31000 % 6000) / fs, 1e-12);
  }
  // ---- procLatency, and the heard rate after the WSOLA lag (keylock)
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    OM_CHECK(d.procLatencySec() == 0.0);
    d.setKeylock(true);
    OM_CHECK_NEAR(d.procLatencySec(), Wsola::kLatency / fs, 1e-15);
    d.setInsertLatency(480);
    OM_CHECK_NEAR(d.procLatencySec(), (Wsola::kLatency + 480) / fs, 1e-15);
    d.setInsertLatency(0);
    d.seek(3.0, 0, rig.now());
    d.play(0, rig.clock(256));
    rig.render(d, 9600, 256);
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.rate == 1.0 && s.routed_wsola == 1);
    OM_CHECK_NEAR(s.proc_latency, Wsola::kLatency / fs, 1e-15);
    const int64_t x = rig.frame;
    d.setTempo(1.1);
    rig.render(d, Wsola::kLatency - 128, 128);
    s = snap(d, rig);
    OM_CHECK(s.rate == 1.0);  // the input produced before the change is still being heard
    rig.render(d, 256, 128);
    s = snap(d, rig);
    OM_CHECK(s.rate == static_cast<double>(1.1f));
    // the heard position follows: 9600 frames at 1, then 2647 at 1 (in the pipe), then 1.1
    double p = 3.0 * fs + 9600 + Wsola::kLatency;
    for (int64_t i = x + Wsola::kLatency; i < rig.frame; i++) p += static_cast<double>(1.1f);
    OM_CHECK_NEAR(s.pos, p / fs, 1e-9);
  }
  // ---- segments at every discontinuity
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    uint32_t seg = snap(d, rig).seg;
    auto bumped = [&](const char* what) {
      const uint32_t s = snap(d, rig).seg;
      if (s == seg) std::printf("    no segment after %s\n", what);
      OM_CHECK(s > seg);
      seg = s;
    };
    d.play(0, rig.now());
    bumped("play");
    rig.render(d, 2000);
    d.pause(0, rig.now());
    bumped("pause");
    d.seek(4.0, 0, rig.now());
    bumped("seek (stopped)");
    d.play(0, rig.now());
    bumped("play");
    rig.render(d, 2000);
    d.seek(6.0, 0, rig.now());
    bumped("hot cue (playing)");
    rig.render(d, 2000);
    d.seekHeard(7.0);
    bumped("sync jump");
    rig.render(d, 2000);
    d.scratch(ScratchPhase::Start, 0, 0, rig.now());
    bumped("scratch start");
    rig.render(d, 2000);
    d.scratch(ScratchPhase::End, 0, 0, rig.now());
    bumped("scratch end");
    d.resetForLoad();
    bumped("load");
    d.attachTrack(nullptr);
    bumped("unload");
  }
}

// play from stop waits for the chunk under the position and the WSOLA prime
// history (armed, rate 0, anchor_t = real start), at most 250 ms on the
// sample clock, start_wait_ms reported; jumps while playing keep "silence
// where missing" and the transport moves.
OM_TEST(todo_deck_armed_start) {
  const double fs = 48000;
  std::vector<float> L, R;
  decktest::makeSignal(L, R, 300000, fs, 3);
  // direct path: waits for the chunk under the position
  {
    auto tb = decktest::makeTrack(L, R, 48000, PcmFormat::S16, {}, false);
    decktest::publish(*tb, 0);
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(96000 / fs, 0, rig.now());  // chunk 1
    const uint32_t seg0 = snap(d, rig).seg;
    d.play(0, rig.now());
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.playing && s.armed && s.rate == 0 && !s.settled);
    OM_CHECK(s.seg == seg0);  // the segment starts when the audio does
    rig.render(d, 4800, 256);  // 100 ms
    for (float v : rig.outL) OM_CHECK(v == 0.0f);
    s = snap(d, rig);
    OM_CHECK(s.armed && s.pos == 2.0);
    decktest::publish(*tb, 1);
    const int64_t startFrame = rig.frame;
    rig.render(d, 2048, 256);
    s = snap(d, rig);
    OM_CHECK(!s.armed && s.playing && s.seg == seg0 + 1);
    OM_CHECK_NEAR(s.anchor_t, rig.presentAt(startFrame), 1e-12);
    OM_CHECK(s.anchor_pos == 2.0);
    OM_CHECK_NEAR(s.start_wait_ms, 100.0, 0.01);
    for (int i = 0; i < 2048; i++) OM_CHECK(rig.outL[static_cast<size_t>(startFrame + i)] == decktest::trackL(*tb, 96000 + i));
  }
  // keylock: also waits for the prime history (the chunk before)
  {
    auto tb = decktest::makeTrack(L, R, 48000, PcmFormat::S16, {}, false);
    decktest::publish(*tb, 1);
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(true);
    Rig rig;
    d.seek((65536 + 500) / fs, 0, rig.now());  // just inside chunk 1: the history reaches chunk 0
    d.play(0, rig.now());
    rig.render(d, 2400, 256);
    OM_CHECK(snap(d, rig).armed);
    decktest::publish(*tb, 0);
    rig.render(d, 256, 256);
    const om_deck_state s = snap(d, rig);
    OM_CHECK(!s.armed && s.playing);
    OM_CHECK_NEAR(s.start_wait_ms, 50.0, 0.01);
  }
  // the 250 ms cap on the sample clock
  {
    auto tb = decktest::makeTrack(L, R, 48000, PcmFormat::S16, {}, false);
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(3.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 11904, 128);  // 248 ms
    OM_CHECK(snap(d, rig).armed);
    rig.render(d, 256, 128);
    om_deck_state s = snap(d, rig);
    OM_CHECK(!s.armed && s.playing);
    OM_CHECK(s.start_wait_ms >= 250.0f && s.start_wait_ms < 253.0f);
    // missing data plays as silence while the transport moves
    rig.render(d, 4800, 128);
    s = snap(d, rig);
    OM_CHECK(s.pos > 3.09 && s.rate == 1.0);
  }
  // a jump while playing does not wait: silence where missing, transport moves
  {
    auto tb = decktest::makeTrack(L, R, 48000, PcmFormat::S16, {}, false);
    decktest::publish(*tb, 0);
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(0.2, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 4800);
    d.seek(4.5, 0, rig.now());  // chunk 3, not received
    om_deck_state s = snap(d, rig);
    OM_CHECK(!s.armed && s.playing);
    const size_t j0 = rig.outL.size();
    rig.render(d, 4800);
    for (size_t i = j0 + 300; i < rig.outL.size(); i++) OM_CHECK(rig.outL[i] == 0.0f);  // after the 5 ms crossfade
    s = snap(d, rig);
    OM_CHECK_NEAR(s.pos, 4.5 + 0.1, 1e-9);
    decktest::publish(*tb, 3);  // the data arrives: audio resumes where the transport is
    const int64_t f0 = static_cast<int64_t>(std::llround(s.pos * fs));
    const size_t j1 = rig.outL.size();
    rig.render(d, 1000);
    for (int i = 0; i < 1000; i++) OM_CHECK(rig.outL[j1 + static_cast<size_t>(i)] == decktest::trackL(*tb, f0 + i));
  }
}

// natural end -> ended_count +1 (sticky), endedAt = presentTime of the frame
// at which the end is heard, endedAtSample on the sample clock, pos =
// duration, playing false (keylock: after the WSOLA tail; insert latency).
OM_TEST(todo_deck_end_of_track_latch) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(1.0);  // 48000 frames
  for (int mode = 0; mode < 3; mode++) {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    if (mode == 1) d.setKeylock(true);
    if (mode == 2) d.setInsertLatency(480);
    Rig rig;
    d.seek(0.9, 0, rig.now());
    d.play(0, rig.now());
    const int64_t endFrame = 4800 + (mode == 2 ? 480 : 0);  // heard end
    rig.render(d, endFrame - 7, 441);
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.playing && s.ended_count == 0);
    rig.render(d, 1000, 441);
    s = snap(d, rig);
    OM_CHECK(!s.playing && s.ended_count == 1);
    OM_CHECK(s.pos == 1.0);
    OM_CHECK_NEAR(s.ended_at, rig.presentAt(endFrame), 1e-12);
    OM_CHECK_NEAR(d.endedAtSample(), endFrame / fs, 1e-12);
    OM_CHECK_NEAR(s.anchor_t, s.ended_at, 1e-12);
    OM_CHECK(s.anchor_pos == 1.0 && s.rate == 0);
    // the track sounds until its last frame (keylock: the WSOLA tail is played;
    // insert latency: the deck's own output ends at 4800, the plugin delays it)
    const int64_t lastAudible = 4800 - 10;
    OM_CHECK(decktest::peak(&rig.outL[static_cast<size_t>(lastAudible - 200)], 200) > 0.01);
    for (size_t i = static_cast<size_t>(endFrame); i < rig.outL.size(); i++) OM_CHECK(rig.outL[i] == 0.0f);
    if (mode == 1) {
      // under keylock the read pointer finished 2647 frames before the heard end
      for (int k = 0; k < 4800; k += 7) OM_CHECK_NEAR(rig.outL[static_cast<size_t>(k)], decktest::trackL(*tb, 43200 + k), 2e-6);
    }
    // sticky: nothing else happens; a new play restarts at 0 and clears endedAt
    rig.render(d, 4800);
    OM_CHECK(snap(d, rig).ended_count == 1);
    d.play(0, rig.now());
    s = snap(d, rig);
    OM_CHECK(s.playing && std::isnan(s.ended_at) && s.anchor_pos == 0.0 && s.ended_count == 1);
    OM_CHECK(std::isnan(d.endedAtSample()));
  }
}

// engine.js loadTrack keeps _endedAt (only play() clears it): a deck that
// ended and gets its next track (app.js's queue auto-loads on onEnded) still
// counts as "ended < 2 s" for the auto-master. hello {reset} clears it
// (clearEnded). Review round of 7 Nov 2026, parity #4.
OM_TEST(deck_natural_end_survives_a_load_and_hello_reset_clears_it) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(1.0);
  auto next = decktest::musicTrack(2.0);
  Deck d(0);
  d.prepare(fs, kMaxBlockFrames);
  d.attachTrack(tb.get());
  Rig rig;
  d.seek(0.9, 0, rig.now());
  d.play(0, rig.now());
  rig.render(d, 4800 + 1000, 441);
  om_deck_state s = snap(d, rig);
  OM_CHECK(!s.playing && s.ended_count == 1 && !std::isnan(s.ended_at));
  const double endedAt = s.ended_at;
  const SampleTime endedSample = d.endedAtSample();
  OM_CHECK(!std::isnan(endedSample));
  // the next track: loadTrack's reset, a new buffer
  d.resetForLoad();
  d.attachTrack(next.get());
  rig.render(d, 441, 441);
  s = snap(d, rig);
  OM_CHECK(!s.playing && s.pos == 0.0 && s.ended_count == 1);
  OM_CHECK(s.ended_at == endedAt && d.endedAtSample() == endedSample);  // kept
  // play() clears it (engine.js play: _endedAt = 0)
  d.play(0, rig.now());
  OM_CHECK(std::isnan(snap(d, rig).ended_at) && std::isnan(d.endedAtSample()));
  // a new end, then hello {reset}: clearEnded
  d.pause(0, rig.now());
  d.seek(1.9, 0, rig.now());
  d.play(0, rig.now());
  rig.render(d, 4800 + 1000, 441);
  OM_CHECK(snap(d, rig).ended_count == 2 && !std::isnan(d.endedAtSample()));
  d.resetForLoad();
  d.clearEnded();
  s = snap(d, rig);
  OM_CHECK(std::isnan(s.ended_at) && std::isnan(d.endedAtSample()) && s.ended_count == 2);
}

// Wsola fed on the deck's own 128-frame grid whatever the block sizes (441,
// 480, variable, 'when' splits): a keylocked deck renders bit-identical audio
// for any block pattern (the golden comparison with the real pitch-worklet.js
// is golden_wsola_vs_pitch_worklet_on_the_quantum_grid).
OM_TEST(todo_deck_wsola_bit_parity_on_the_quantum_grid) {
  auto tb = decktest::musicTrack(12.0);
  const std::vector<std::vector<int>> patterns = {{128}, {441}, {480}, {37, 480, 2048, 1, 127, 300, 129}};
  std::vector<float> ref;
  for (const auto& pat : patterns) {
    Deck d(0);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(true);
    d.setTempo(1.07);
    Rig rig;
    d.seek(1.0, 0, rig.now());
    d.play(0, rig.clock(pat[0]));
    // commands at fixed frames (block boundaries in every pattern)
    const struct {
      int64_t at;
      int kind;
      double v;
    } cmds[] = {{30000, 0, 0.94}, {45000, 1, 3}, {70000, 0, 1.25}, {90000, 1, -5}, {120000, 2, 0}, {150000, 0, 1.0}};
    for (const auto& c : cmds) {
      rig.renderPattern(d, c.at - rig.frame, pat);
      if (c.kind == 0) d.setTempo(c.v);
      if (c.kind == 1) d.setKey(static_cast<int>(c.v));
      if (c.kind == 2) d.seek(5.0, 0, rig.clock(128));
    }
    rig.renderPattern(d, 200000 - rig.frame, pat);
    if (ref.empty()) {
      ref = rig.outL;
      OM_CHECK(decktest::rms(ref.data(), ref.size()) > 0.05);
    } else {
      OM_CHECK(rig.outL.size() == ref.size());
      OM_CHECK(decktest::maxAbsDiff(rig.outL.data(), ref.data(), ref.size()) == 0.0);
    }
  }
}

// prime(): PLAY / hot cue / seek output the target audio at once (no 55-60 ms
// delay, no fade-in, no stale audio); 4 simultaneous primes < 25 % of a
// 128-frame period (test_deck_perf.cpp measures it in detail); keylock
// on/off without discontinuity > -60 dBFS; keylockRatio "input" removes the
// pitch blip of tempo steps.
OM_TEST(todo_deck_wsola_priming_and_cost) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(20.0);
  // ---- PLAY with keylock at ratio 1: the track from the first frame on
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(true);
    Rig rig;
    d.seek(4.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 4800, 256);
    for (int i = 0; i < 4800; i++) OM_CHECK_NEAR(rig.outL[static_cast<size_t>(i)], decktest::trackL(*tb, 192000 + i), 2e-6);
    // hot cue while playing: after the 5 ms crossfade only the new audio (no stale tail)
    d.seek(9.0, 0, rig.now());
    const size_t j = rig.outL.size();
    rig.render(d, 4800, 256);
    for (int i = 240; i < 4800; i++) OM_CHECK_NEAR(rig.outL[j + static_cast<size_t>(i)], decktest::trackL(*tb, 432000 + i), 2e-6);
  }
  // ---- PLAY with keylock at tempo 1.06 (ratio 0.943): first frame exact, no fade-in
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(true);
    d.setTempo(1.06);
    Rig rig;
    rig.render(d, 9600, 256);  // the ratio has converged while stopped
    d.seek(6.0, 0, rig.now());
    d.play(0, rig.now());
    const size_t j = rig.outL.size();
    rig.render(d, 2400, 256);
    OM_CHECK(rig.outL[j] == decktest::trackL(*tb, 288000));
    // level of the first 5 ms = level of the track there (no fade-in)
    std::vector<float> src(240);
    for (int i = 0; i < 240; i++) src[static_cast<size_t>(i)] = decktest::trackL(*tb, 288000 + i);
    const double ratio = decktest::rms(&rig.outL[j], 240) / decktest::rms(src.data(), 240);
    OM_CHECK(ratio > 0.8 && ratio < 1.25);
  }
  // ---- keylock on / off while playing: no discontinuity above -60 dBFS
  {
    auto sine = decktest::sineTrack(10.0, 48000, 440.0, 0.5);
    for (double tempo : {1.0, 1.06}) {
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(sine.get());
      d.setTempo(tempo);
      Rig rig;
      d.seek(1.0, 0, rig.now());
      d.play(0, rig.now());
      rig.render(d, 9600);
      d.setKeylock(true);
      rig.render(d, 9600);
      d.setKeylock(false);
      rig.render(d, 9600);
      // second difference: a 440 Hz sine of 0.5 at <= 1.06x stays below 0.5 (2 pi 466 / 48000)^2
      const double limit = 0.5 * std::pow(2 * kPi * 440.0 * 1.07 / fs, 2);
      double excess = 0;
      size_t where = 0;
      for (size_t i = 2; i < rig.outL.size(); i++) {
        const double d2 = std::fabs(static_cast<double>(rig.outL[i]) - 2.0 * rig.outL[i - 1] + rig.outL[i - 2]);
        if (d2 - limit > excess) {
          excess = d2 - limit;
          where = i;
        }
      }
      std::printf("    keylock toggles at tempo %.2f: discontinuity %.1f dBFS (frame %zu; toggles at 9600, 19200)\n", tempo,
                  decktest::toDb(excess), where);
      OM_CHECK(decktest::toDb(excess) < -60.0);
      if (tempo == 1.0) {
        // identical paths at ratio 1: the crossfades are seamless
        for (size_t i = 0; i < rig.outL.size(); i++)
          OM_CHECK_NEAR(rig.outL[i], decktest::trackL(*sine, 48000 + static_cast<int64_t>(i)), 2e-6);
      }
    }
  }
  // ---- 4 simultaneous primes (one block, 4 keylocked decks jumping)
  {
    std::vector<std::unique_ptr<Deck>> decks;
    Rig rig;
    for (int k = 0; k < 4; k++) {
      decks.push_back(std::make_unique<Deck>(k));
      decks[static_cast<size_t>(k)]->prepare(fs, kMaxBlockFrames);
      decks[static_cast<size_t>(k)]->attachTrack(tb.get());
      decks[static_cast<size_t>(k)]->setKeylock(true);
      decks[static_cast<size_t>(k)]->setTempo(1.0 + 0.03 * (k + 1));
      decks[static_cast<size_t>(k)]->play(0, rig.now());
    }
    {
      rt::Scope rts;
      for (int k = 0; k < 4; k++) decks[static_cast<size_t>(k)]->seek(2.0 + k, 0, rig.now());
    }
    for (auto& d : decks) OM_CHECK(d->playing() && !d->armed());
  }
  // ---- keylockRatio "input": no pitch blip on a tempo step
  {
    auto sine = decktest::sineTrack(8.0, 48000, 1000.0, 0.5);
    double blip[2] = {0, 0};   // worst deviation (Hz) of a 10 ms window
    double area[2] = {0, 0};   // deviation integrated over time (Hz x s)
    double longest[2] = {0, 0};  // longest stretch off by more than 10 Hz (ms)
    for (int mode = 0; mode < 2; mode++) {
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(sine.get());
      d.setKeylock(true);
      d.setKeylockRatioSource(mode ? KeylockRatioSource::InputTempo : KeylockRatioSource::Worklet);
      Rig rig;
      d.seek(1.0, 0, rig.now());
      d.play(0, rig.now());
      rig.render(d, 24000, 128);
      const size_t x = rig.outL.size();
      d.setTempo(1.06);
      rig.render(d, 9600, 128);
      double run = 0;
      for (size_t a = x; a + 480 < rig.outL.size(); a += 48) {
        const double dev = std::fabs(freqOver(rig.outL, a, a + 480, fs) - 1000.0);
        blip[mode] = std::max(blip[mode], dev);
        area[mode] += dev * 48 / fs;
        run = dev > 10.0 ? run + 1.0 : 0.0;
        longest[mode] = std::max(longest[mode], run);  // windows step 1 ms
      }
    }
    std::printf("    tempo step 1.00 -> 1.06 under keylock: worst pitch deviation worklet %.1f Hz / input %.1f Hz; "
                "integrated %.2f / %.2f Hz.s; longest > 10 Hz %.0f / %.0f ms\n",
                blip[0], blip[1], area[0], area[1], longest[0], longest[1]);
    OM_CHECK(blip[0] > 30.0);  // the Web engine's blip (ratio applied ~55 ms before its input)
    OM_CHECK(longest[0] >= 40.0);
    // "input": the ~55 ms blip is gone; only the grains straddling the tempo step
    // (fixed ratio per grain, as in the worklet) are off, for at most one hop (16 ms)
    OM_CHECK(longest[1] <= 1000.0 * Wsola::kHop / fs + 1.0);
    OM_CHECK(area[1] < 0.5 * area[0]);
  }
}

// scratch: target path followed within one block, backward motion plays
// time-reversed audio (correlation > 0.9 with the reversed source), still =
// silence, bypasses WSOLA, new segments at start and end.
OM_TEST(todo_deck_scratch_reverse_audio) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(10.0);
  for (int keylock = 0; keylock < 2; keylock++) {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(keylock != 0);
    Rig rig;
    d.seek(5.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 4800, 800);
    const uint32_t seg0 = snap(d, rig).seg;
    d.scratch(ScratchPhase::Start, 0, rig.presentAt(rig.frame) - 0.02, rig.clock(800));
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.scratching && !s.playing && !s.settled);
    OM_CHECK(s.seg >= seg0 + 2);  // pause (playing deck) + scratch start
    const double x0 = s.pos;
    // the hand moves the platter backward at 1x: a Move every UI frame (800 frames)
    double maxErr = 0;
    std::vector<double> targetAt;  // per output frame
    for (int k = 1; k <= 30; k++) {
      const double t = x0 - k / 60.0;
      d.scratch(ScratchPhase::Move, t, rig.presentAt(rig.frame) - 0.02, rig.clock(800));
      rig.render(d, 800, 800);
      s = snap(d, rig);
      if (k > 6) maxErr = std::max(maxErr, std::fabs(s.pos - (t - 1 / 60.0)));
    }
    std::printf("    scratch (keylock %d): follower error %.2f ms\n", keylock, maxErr * 1000);
    OM_CHECK(maxErr < 256 / fs);  // within one block of the target path
    OM_CHECK(s.rate < -0.9 && s.rate > -1.1);
    // reverse audio: correlate 200 ms of output with the source read backward
    const size_t a = rig.outL.size() - 9600;
    const double xa = s.pos + 9600 / fs;  // position of the first of these frames (speed -1)
    double best = 0;
    for (int lag = -96; lag <= 96; lag++) {
      std::vector<float> rev(9600);
      for (int i = 0; i < 9600; i++) rev[static_cast<size_t>(i)] = decktest::trackL(*tb, static_cast<int64_t>(std::llround(xa * fs)) - i + lag);
      best = std::max(best, decktest::correlation(&rig.outL[a], rev.data(), 9600));
    }
    std::printf("    reverse-audio correlation %.4f\n", best);
    OM_CHECK(best > 0.9);
    // the hand stops: the platter stops, silence
    const double hold = x0 - 31 / 60.0;
    for (int k = 0; k < 18; k++) {
      d.scratch(ScratchPhase::Move, hold, rig.presentAt(rig.frame) - 0.02, rig.clock(800));
      rig.render(d, 800, 800);
    }
    for (size_t i = rig.outL.size() - 2400; i < rig.outL.size(); i++) OM_CHECK(rig.outL[i] == 0.0f);
    s = snap(d, rig);
    OM_CHECK(std::fabs(s.rate) < 0.01);
    const uint32_t segBefore = s.seg;
    d.scratch(ScratchPhase::End, 0, 0, rig.now());
    s = snap(d, rig);
    OM_CHECK(!s.scratching && s.seg == segBefore + 1);
    OM_CHECK_NEAR(s.pos, hold, 1e-9);
  }
}

// V.BRAKE / BACKSPIN (engine.js spinSound: v0, decel, gain envelope on the
// sample clock), ROLL (engine.js startRoll slices, tau 4 ms mixes, slip),
// stems (on/off at the same position, per-stem gains with their tau),
// chunk-not-ready silence.
OM_TEST(todo_deck_spin_roll_stems) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(12.0);
  // ---- V.BRAKE: speed v0 = max(0.2, tempo) falling linearly over v0 / 1.6 s; AudioBufferSourceNode's
  //      playbackRate is k-rate: one value per 128-frame quantum (the null test against Chromium's own
  //      render is golden_spin_vs_engine_js_spin_sound)
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(3.0, 0, rig.now());
    d.spin(SpinKind::VBrake, rig.now());
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.spinning && !s.settled && s.pos == 3.0);  // the transport does not move
    rig.render(d, 36000, 256);  // 0.75 s
    const double dur = 1.0 / 1.6;
    const float k = static_cast<float>(1.0 / dur);
    double p = 3.0 * fs;  // engine.js slice: from floor(3.0 * sr)
    double worst = 0;
    for (int i = 0; i < static_cast<int>(dur * fs) - 2000; i++) {
      const double t = i / fs;
      const double tq = (i & ~127) / fs;
      const float x = static_cast<float>(tq * static_cast<double>(k));
      const double v = static_cast<double>(1.0f + x * (0.001f - 1.0f));
      const double g = t < dur - 0.04 ? 1.0 : 1.0 - (t - (dur - 0.04)) / 0.04;
      worst = std::max(worst, std::fabs(rig.outL[static_cast<size_t>(i)] - g * chromiumAt(*tb, p, 0)));
      p += v;
    }
    OM_CHECK(worst < 1e-6);
    // fade in the last 40 ms, silence after the spin
    for (size_t i = static_cast<size_t>((dur + 0.001) * fs); i < rig.outL.size(); i++) OM_CHECK(rig.outL[i] == 0.0f);
    s = snap(d, rig);
    OM_CHECK(!s.spinning && s.pos == 3.0);
  }
  // ---- BACKSPIN: 7x backward, decel 4.5, on engine.js's reversed slice (its first frame is track frame
  //      floor(a sr) + floor((b - a) sr) - 1 with a = pos - dist, b = pos: 287998 here, 2 frames before
  //      the position); spin(None) = 20 ms fade
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(6.0, 0, rig.now());
    d.spin(SpinKind::Backspin, rig.now());
    rig.render(d, 4800, 256);
    const double dist = 7.0 * 7.0 / (2 * 4.5) + 0.15;
    const int64_t n = static_cast<int64_t>(std::floor((6.0 - (6.0 - dist)) * fs));
    const int64_t base = static_cast<int64_t>(std::floor((6.0 - dist) * fs)) + n - 1;
    OM_CHECK(base == 287998);
    const float k = static_cast<float>(1.0 / (7.0 / 4.5));
    double x = 0;  // read position in the reversed slice
    double worst = 0;
    for (int i = 0; i < 4800; i++) {
      const double tq = (i & ~127) / fs;
      const float xr = static_cast<float>(tq * static_cast<double>(k));
      const double v = static_cast<double>(7.0f + xr * (0.001f - 7.0f));
      const int64_t j = static_cast<int64_t>(std::floor(x));
      const double f = x - static_cast<double>(j);
      const float want = static_cast<float>((1.0 - f) * decktest::trackL(*tb, base - j) + f * decktest::trackL(*tb, base - j - 1));
      worst = std::max(worst, std::fabs(static_cast<double>(rig.outL[static_cast<size_t>(i)]) - want));
      x += v;
    }
    OM_CHECK(worst < 1e-6);
    d.spin(SpinKind::None, rig.now());
    rig.render(d, 2400, 256);
    for (size_t i = 4800 + 960 + 1; i < rig.outL.size(); i++) OM_CHECK(rig.outL[i] == 0.0f);
    OM_CHECK(!snap(d, rig).spinning);
  }
  // ---- ROLL: slice on the grid, second pointer, slip, tau 4 ms
  {
    BeatGrid g;
    g.bpm = 120;  // beat 0.5 s
    g.beatOffset = 0.0;
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.attachGrid(&g);
    Rig rig;
    OM_CHECK(!d.startRoll(0.5, 1.0));  // only when playing
    d.seek(1.3, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 2400, 256);  // heard 1.35 s
    OM_CHECK(d.startRoll(0.5, 1.0));  // slice: the last multiple of 1/2 beat: [1.25, 1.5)
    double beats = 0;
    OM_CHECK(d.rolling(&beats) && beats == 0.5);
    OM_CHECK(d.startRoll(0.5, 1.0));  // same slice: only the mix
    const size_t a = rig.outL.size();
    rig.render(d, 48000, 256);  // 1 s
    // once the 4 ms ramps have converged (main gain snaps to 0 after ~16 tau),
    // the output repeats every 0.25 s (12000 frames) exactly
    for (size_t i = a + 4000; i + 12000 < rig.outL.size(); i += 13) OM_CHECK_NEAR(rig.outL[i], rig.outL[i + 12000], 1e-6);
    // and is the slice itself: the roll pointer started where the main pointer was (1.35 s, in the slice)
    for (int i = 4000; i < 4400; i++) {
      const int64_t f = 60000 + ((64800 - 60000 + i) % 12000);
      OM_CHECK_NEAR(rig.outL[a + static_cast<size_t>(i)], decktest::trackL(*tb, f), 1e-6);
    }
    // tau 4 ms: one time constant after the start the roll is at 1 - 1/e
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.rolling && s.roll_beats == 0.5);
    OM_CHECK_NEAR(s.pos, 1.35 + 1.0, 1e-9);  // slip: the transport kept running
    d.stopRoll(true);
    OM_CHECK(!d.rolling(nullptr));
    const size_t b = rig.outL.size();
    rig.render(d, 4800, 256);
    // back on the main pointer (2.35 s on), at full level once the ramp converged
    for (int i = 2000; i < 4800; i += 3) OM_CHECK_NEAR(rig.outL[b + static_cast<size_t>(i)], decktest::trackL(*tb, 112800 + i), 1e-6);
    // the gain ramps: a-rate setTargetAtTime with tau 4 ms (1 - 1/e after one tau)
    deckimpl::ARateTarget at;
    at.reset(0);
    at.setTarget(1, 0.004, fs);
    std::vector<float> gv(192);
    at.render(gv.data(), 192);
    OM_CHECK_NEAR(gv[191], 1.0 - std::exp(-191.0 / 192.0), 1e-4);
    // pause stops the roll (engine.js)
    OM_CHECK(d.startRoll(1.0, 0.5));
    d.pause(0, rig.now());
    OM_CHECK(!d.rolling(nullptr));
  }
  // ---- stems: same position, per-stem gains
  {
    auto voc = decktest::sineTrack(12.0, 48000, 300.0, 0.2);
    auto drm = decktest::sineTrack(12.0, 48000, 500.0, 0.2);
    auto bas = decktest::sineTrack(12.0, 48000, 70.0, 0.2);
    StemSet set;
    set.stems[0] = voc.get();
    set.stems[1] = drm.get();
    set.stems[2] = bas.get();
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    OM_CHECK(d.attachStems(&set) == nullptr);
    om_deck_state s = snap(d, rig);
    OM_CHECK(s.stems_ready && !s.stems_on);
    d.seek(2.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 2400, 256);
    const uint32_t segBefore = snap(d, rig).seg;
    d.setStemsOn(true);
    s = snap(d, rig);
    OM_CHECK(s.stems_on && s.stem_gains[0] == 1.0f && s.seg == segBefore);  // same position: no new segment
    const size_t a = rig.outL.size();
    rig.render(d, 4800, 256);
    // after the 5 ms crossfade: the sum of the stems at the same position
    for (int i = 300; i < 4800; i += 5) {
      const int64_t f = 96000 + 2400 + i;
      const float want = decktest::trackL(*voc, f) + decktest::trackL(*drm, f) + decktest::trackL(*bas, f);
      OM_CHECK_NEAR(rig.outL[a + static_cast<size_t>(i)], want, 2e-6);
    }
    d.setStemGain(Stem::Drums, 0.0f, 0.01f);  // engine.js toggleStem: setTargetAtTime(0, now, 0.01)
    rig.render(d, 9600, 256);
    s = snap(d, rig);
    OM_CHECK(s.stem_gains[1] < 1e-6f && s.stem_gains[0] == 1.0f);
    const size_t b = rig.outL.size() - 1000;
    for (int i = 0; i < 1000; i += 3) {
      const int64_t f = 96000 + 2400 + 4800 + 9600 - 1000 + i;
      const float want = decktest::trackL(*voc, f) + decktest::trackL(*bas, f);
      OM_CHECK_NEAR(rig.outL[b + static_cast<size_t>(i)], want, 2e-6);
    }
    d.setStemsOn(false);
    const size_t c = rig.outL.size();
    rig.render(d, 2400, 256);
    for (int i = 300; i < 2400; i += 7) {
      const int64_t f = 96000 + 2400 + 4800 + 9600 + i;
      OM_CHECK_NEAR(rig.outL[c + static_cast<size_t>(i)], decktest::trackL(*tb, f), 2e-6);
    }
    // stems detached while on: back to the track without reading the old set afterwards
    d.setStemsOn(true);
    rig.render(d, 1024, 256);
    OM_CHECK(d.attachStems(nullptr) == &set);
    s = snap(d, rig);
    OM_CHECK(!s.stems_on && !s.stems_ready);
    rig.render(d, 2400, 256);
  }
  // ---- chunk not ready: silence while the transport moves (jump while playing)
  {
    std::vector<float> L, R;
    decktest::makeSignal(L, R, 300000, fs, 5);
    auto part = decktest::makeTrack(L, R, 48000, PcmFormat::F32, {}, false);
    decktest::publish(*part, 0);
    decktest::publish(*part, 2);
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(part.get());
    Rig rig;
    d.seek(130000 / fs, 0, rig.now());  // chunk 1 is missing, chunk 2 starts at 131072
    d.play(0, rig.now());               // armed: waits for chunk 1
    rig.render(d, 12288, 256);          // 256 ms: the cap starts it anyway
    OM_CHECK(!snap(d, rig).armed);
    const size_t started = rig.outL.size();
    rig.render(d, 4800, 256);
    // the frames before 131072 are silent, the ones after play chunk 2
    const om_deck_state s = snap(d, rig);
    OM_CHECK(s.playing);
    // 130000 + 256 (started in the block after the cap) .. 131072: missing chunk 1 = silence
    const size_t silentUntil = started - 256 + (131072 - 130000);
    for (size_t i = 0; i < silentUntil; i++) OM_CHECK(rig.outL[i] == 0.0f);
    size_t sounding = 0;
    for (size_t i = silentUntil; i < rig.outL.size(); i++)
      if (rig.outL[i] != 0.0f) sounding++;
    OM_CHECK(sounding > 3900);
  }
}

// Paths outside the main acceptance list: a device change (prepare again)
// keeps the keylock target and restarts a playing deck where it was; a seek
// during a scratch moves the platter; a buffer swapped under a playing deck
// restarts at the position reached; a stem shorter than the track goes
// silent at its end (never extrapolated).
OM_TEST(deck_robustness_paths) {
  // ---- device change while stopped: the keylock ratio target survives
  {
    auto sine = decktest::sineTrack(6.0, 44100, 1000.0, 0.5);
    Deck d(0);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(sine.get());
    d.setKeylock(true);
    d.setTempo(1.06);
    d.prepare(44100, kMaxBlockFrames);  // new device rate
    Rig rig;
    rig.rate = 44100;
    d.seek(1.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 22050, 128);
    const double f = freqOver(rig.outL, 8820, 22050, 44100);
    std::printf("    keylock at 1.06 after a device change: %.2f Hz (1000 expected)\n", f);
    OM_CHECK(std::fabs(f - 1000.0) < 2.0);
    // device change while playing: restarts where it was, on the new rate
    om_deck_state s = snap(d, rig);
    const double before = s.pos;
    d.prepare(48000, kMaxBlockFrames);
    Rig rig2;
    rig2.frame = 0;
    rig2.epoch = rig.presentAt(rig.frame) - rig2.latency;  // continuous engine time
    rig2.render(d, 4800, 256);
    s = snap(d, rig2);
    OM_CHECK(s.playing && !s.armed);
    OM_CHECK_NEAR(s.pos, before + 0.1 * static_cast<double>(1.06f), 0.5 / 44100 + 1e-9);
    OM_CHECK(std::fabs(freqOver(rig2.outL, 2400, 4800, 48000) - 1000.0) < 2.0);
  }
  // ---- seek during a scratch: the platter moves there, End keeps it
  {
    auto tb = decktest::musicTrack(10.0);
    Deck d(0);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(3.0, 0, rig.now());
    d.scratch(ScratchPhase::Start, 0, 0, rig.now());
    rig.render(d, 2400);
    d.seek(6.5, 0, rig.now());
    OM_CHECK_NEAR(snap(d, rig).pos, 6.5, 1e-12);
    rig.render(d, 2400);
    d.scratch(ScratchPhase::End, 0, 0, rig.now());
    OM_CHECK_NEAR(snap(d, rig).pos, 6.5, 1e-12);
  }
  // ---- a buffer swapped under a playing deck restarts at the position reached
  {
    auto a = decktest::musicTrack(10.0, 48000, PcmFormat::F32, 11);
    auto b = decktest::musicTrack(10.0, 48000, PcmFormat::F32, 12);
    Deck d(0);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(a.get());
    Rig rig;
    d.seek(2.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 4800);
    OM_CHECK(d.attachTrack(b.get()) == a.get());
    const size_t j = rig.outL.size();
    rig.render(d, 4800);
    const om_deck_state s = snap(d, rig);
    OM_CHECK(s.playing && !s.armed);
    OM_CHECK_NEAR(s.pos, 2.2, 1e-9);
    for (int i = 200; i < 4800; i += 11) OM_CHECK(rig.outL[j + static_cast<size_t>(i)] == decktest::trackL(*b, 100800 + i));
  }
  // ---- a stem shorter than the track: silence after its end
  {
    auto tb = decktest::musicTrack(6.0);
    auto voc = decktest::sineTrack(4.0, 48000, 300.0, 0.2);  // ends 2 s before the track
    auto drm = decktest::sineTrack(6.0, 48000, 500.0, 0.2);
    StemSet set;
    set.stems[0] = voc.get();
    set.stems[1] = drm.get();
    Deck d(0);
    d.prepare(48000, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.attachStems(&set);
    d.setStemsOn(true);
    Rig rig;
    d.seek(3.9, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 9600, 256);
    // after 4.0 s only the drums remain, never above their own level
    for (size_t i = 4800 + 64; i < rig.outL.size(); i++) {
      OM_CHECK_NEAR(rig.outL[i], decktest::trackL(*drm, 187200 + static_cast<int64_t>(i)), 2e-6);
    }
  }
}

// More engine.js rules and native edges: exitLoop clears _loopBeats, the
// transport is not "settled" during crossfades / prime transients, pause is a
// 2 ms fade (no step), positionAt() with an insert latency, a ROLL slice on a
// dynamic grid, the dev A/B kernels (Hermite exact at integer positions).
OM_TEST(deck_more_engine_js_rules) {
  const double fs = 48000;
  auto sine = decktest::sineTrack(10.0, 48000, 440.0, 0.5);
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(sine.get());
    d.setLoop(1.0, 2.0);
    d.setLoopBeats(4);
    d.exitLoop();
    om_deck_state s;
    d.snapshot(s, 0);
    OM_CHECK(!s.looping && std::isnan(s.loop_beats));
  }
  // settled: false during a jump crossfade (+ a hop after a prime), true otherwise
  for (int keylock = 0; keylock < 2; keylock++) {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(sine.get());
    d.setKeylock(keylock != 0);
    Rig rig;
    d.play(0, rig.now());
    rig.render(d, 4800, 128);
    OM_CHECK(d.transportSettled());
    d.seek(5.0, 0, rig.now());
    OM_CHECK(!d.transportSettled());
    const int busy = 240 + (keylock ? Wsola::kHop : 0);
    rig.render(d, busy - 128, 128);
    OM_CHECK(!d.transportSettled());
    rig.render(d, 256, 128);
    OM_CHECK(d.transportSettled());
  }
  // pause: 2 ms raised-cosine fade, then silence; no step
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(sine.get());
    Rig rig;
    d.play(0, rig.now());
    rig.render(d, 4800, 256);
    d.pause(0, rig.now());
    const size_t p = rig.outL.size();
    rig.render(d, 1024, 256);
    for (size_t i = p + 96; i < rig.outL.size(); i++) OM_CHECK(rig.outL[i] == 0.0f);
    double maxStep = 0;
    for (size_t i = p; i < p + 97; i++) maxStep = std::max(maxStep, std::fabs(static_cast<double>(rig.outL[i]) - rig.outL[i - 1]));
    OM_CHECK(maxStep < 0.5 * 2 * kPi * 440 / fs + 0.02);  // the sine's own slope + the fade's
  }
  // insert latency: what is heard now was rendered 480 frames ago; the plugin
  // input (positionAt(now + latency)) is the next rendered frame
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(sine.get());
    d.setInsertLatency(480);
    Rig rig;
    d.seek(2.0, 0, rig.now());
    d.play(0, rig.now());
    om_deck_state s;
    d.snapshot(s, rig.presentAt(rig.frame));
    OM_CHECK_NEAR(s.anchor_t, rig.presentAt(0) + 0.01, 1e-12);  // heard 10 ms later
    rig.render(d, 9600, 256);
    const EngineTime now = rig.presentAt(rig.frame);
    OM_CHECK_NEAR(d.heardPosition(), 2.0 + (9600 - 480) / fs, 1e-9);
    OM_CHECK_NEAR(d.positionAt(now), d.heardPosition(), 1e-12);
    OM_CHECK_NEAR(d.positionAt(now + 480 / fs), 2.0 + 9600 / fs, 1e-9);
    d.snapshot(s, now);
    OM_CHECK_NEAR(s.proc_latency, 0.01, 1e-12);
  }
  // ROLL on a dynamic grid: the slice is the last multiple of `beats` on the grid
  {
    auto tb = decktest::musicTrack(12.0);
    BeatGrid g;
    g.bpm = 120;
    for (int i = 0; i < 24; i++) g.beats.push_back(0.1 + i * 0.5 + (i % 2) * 0.02);  // swung beats
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.attachGrid(&g);
    Rig rig;
    d.seek(2.0, 0, rig.now());
    d.play(0, rig.now());
    rig.render(d, 9600, 256);  // heard 2.2 s
    OM_CHECK(d.startRoll(1.0, 1.0));
    // f(2.2) is in beat 4 (2.1 .. 2.62): slice [b4, b5) = [2.1, 2.62)
    const int period = static_cast<int>(std::lround((2.62 - 2.1) * fs));
    const size_t a = rig.outL.size();
    rig.render(d, 4 * period, 256);
    for (size_t i = a + 4000; i + static_cast<size_t>(period) < rig.outL.size(); i += 17)
      OM_CHECK_NEAR(rig.outL[i], rig.outL[i + static_cast<size_t>(period)], 1e-6);
  }
  // dev A/B kernels: Hermite is exact at integer positions, sinc close to the source
  {
    auto tb = decktest::musicTrack(4.0);
    for (InterpQuality q : {InterpQuality::Hermite4, InterpQuality::Sinc16}) {
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(tb.get());
      d.setInterpolation(q);
      Rig rig;
      d.seek(1.0, 0, rig.now());
      d.play(0, rig.now());
      rig.render(d, 4800, 256);
      std::vector<float> src(4800);
      for (int i = 0; i < 4800; i++) src[static_cast<size_t>(i)] = decktest::trackL(*tb, 48000 + i);
      if (q == InterpQuality::Hermite4) {
        OM_CHECK(decktest::maxAbsDiff(rig.outL.data(), src.data(), 4800) == 0.0);
      } else {
        OM_CHECK(decktest::correlation(rig.outL.data(), src.data(), 4800) > 0.99);
      }
    }
  }
}
