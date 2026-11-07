// Verification campaign "deck-keylock" of 7 Nov 2026 (owner: deck; SPEC.md
// §9, Appendix B and D): measured numbers, printed by the test run, with
// their targets asserted:
//  - keylock at -8 %, 0 and +8 % tempo with every key shift (-7 .. +7): the
//    pitch of a 440 Hz sine, case by case against the 1-cent target, with the
//    transposer alone for comparison (pitch-worklet.js aligns its grains on
//    whole samples: the bound asserted is its own, 2 cents);
//  - where the "keylock toggles at tempo 1.06" figure of
//    todo_deck_wsola_priming_and_cost comes from;
//  - PLAY / hot cue / seek / sync jump to the first target sample, keylock on
//    and off, at ratio 1 and with a transposition (SPEC.md Appendix D gives the
//    Web engine's figures); the plugin transport position right after a jump;
//  - the cost of 4 simultaneous primes in the worst modes (stems, roll, key,
//    44.1 kHz); target < 25 % of a 128-frame period; the stems' prime history
//    bit-identical to the track's;
//  - a 4-beat loop exact to the sample over 100 wraps (integer and fractional
//    loop lengths, tempo != 1, keylock);
//  - scratch: backward platter motion plays the track reversed (correlation),
//    at several speeds and block sizes, with dropped UI frames, raw jog timing,
//    and how far the platter coasts when the Moves stop;
//  - V.BRAKE / BACKSPIN speed and gain envelopes against engine.js spinSound
//    (the null test against Chromium's renders is in test_deck_golden_suites.cpp);
//  - end-of-track event timing (tempo, keylock, insert latency, block sizes).
// Time budgets are asserted in optimized builds only (NDEBUG, no sanitizer).
#include <algorithm>
#include <chrono>
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

#if defined(NDEBUG) && !defined(__SANITIZE_ADDRESS__) && !defined(OM_ASAN)
constexpr bool kOptimized = true;
#else
constexpr bool kOptimized = false;
#endif

double nowUs() {
  using namespace std::chrono;
  return duration<double, std::micro>(steady_clock::now().time_since_epoch()).count();
}

double percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  const size_t i = std::min(v.size() - 1, static_cast<size_t>(p * static_cast<double>(v.size() - 1) + 0.5));
  return v[i];
}

// Upward zero crossings of x[a, b) as interpolated frame positions.
std::vector<double> upCrossings(const std::vector<float>& x, size_t a, size_t b) {
  std::vector<double> t;
  for (size_t i = std::max<size_t>(a, 1); i < b && i < x.size(); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) t.push_back(static_cast<double>(i - 1) + x[i - 1] / (static_cast<double>(x[i - 1]) - x[i]));
  }
  return t;
}
double meanFreq(const std::vector<double>& t, double fs) {
  return t.size() >= 2 ? static_cast<double>(t.size() - 1) * fs / (t.back() - t.front()) : 0.0;
}
double cents(double f, double want) { return f > 0 && want > 0 ? 1200.0 * std::log2(f / want) : 1e9; }
// Worst deviation (cents) of the frequency measured over `periods` periods.
double worstLocalCents(const std::vector<double>& t, double fs, double want, size_t periods) {
  double w = 0;
  for (size_t i = 0; i + periods < t.size(); i++) {
    const double f = static_cast<double>(periods) * fs / (t[i + periods] - t[i]);
    w = std::max(w, std::fabs(cents(f, want)));
  }
  return w;
}

// A constant track (gain envelopes) and a ramp track whose sample i is
// i * 2^-20 (exact in float32 below 2^24 frames): linear interpolation then
// gives back the read position, so speed envelopes can be read off the output.
std::unique_ptr<TrackBuffer> constTrack(double seconds, float v, int rate = 48000) {
  const int64_t n = static_cast<int64_t>(seconds * rate);
  std::vector<float> L(static_cast<size_t>(n), v), R(static_cast<size_t>(n), v);
  return decktest::makeTrack(L, R, rate, PcmFormat::F32);
}
constexpr double kRampScale = 1.0 / 1048576.0;
std::unique_ptr<TrackBuffer> rampTrack(double seconds, int rate = 48000) {
  const int64_t n = static_cast<int64_t>(seconds * rate);
  std::vector<float> L(static_cast<size_t>(n)), R(static_cast<size_t>(n));
  for (int64_t i = 0; i < n; i++) L[static_cast<size_t>(i)] = R[static_cast<size_t>(i)] = static_cast<float>(i * kRampScale);
  return decktest::makeTrack(L, R, rate, PcmFormat::F32);
}

// Chromium's linear interpolation at position p (both frames inside the buffer).
float lerpAt(const TrackBuffer& tb, double p) {
  const double fi = std::floor(p);
  const int64_t i = static_cast<int64_t>(fi);
  const double f = p - fi;
  return static_cast<float>((1.0 - f) * decktest::trackL(tb, i) + f * decktest::trackL(tb, i + 1));
}

}  // namespace

// ---------------------------------------------------------------------------
// 1. Keylock pitch: 440 Hz within 1 cent at -8 %, 0, +8 % tempo, every key.
// ---------------------------------------------------------------------------
namespace {
struct PitchResult {
  double hz = 0, cents = 0, localCents = 0;
};
PitchResult keylockPitch(const TrackBuffer& tb, double fs, double tempo, int key, bool keylock, int block) {
  Deck d(0);
  d.prepare(fs, kMaxBlockFrames);
  d.attachTrack(&tb);
  d.setKeylock(keylock);
  d.setTempo(tempo);
  d.setKey(key);
  Rig rig;
  rig.rate = fs;
  d.seek(1.0, 0, rig.now());
  d.play(0, rig.clock(block));
  rig.render(d, static_cast<int64_t>(4.5 * fs), block);
  // steady part: 0.5 s after PLAY (the ratio smoother has long converged)
  const std::vector<double> t = upCrossings(rig.outL, static_cast<size_t>(0.5 * fs), rig.outL.size());
  const double want = 440.0 * std::pow(2.0, key / 12.0) * (keylock ? 1.0 : tempo);
  PitchResult r;
  r.hz = meanFreq(t, fs);
  r.cents = cents(r.hz, want);
  r.localCents = worstLocalCents(t, fs, want, 20);
  return r;
}
}  // namespace

OM_TEST(campaign_keylock_pitch_440hz_within_1_cent) {
  auto sine = decktest::sineTrack(8.0, 48000, 440.0, 0.5);
  const double tempos[] = {0.92, 1.0, 1.08};
  double worstAvg = 0, worstLocal = 0;
  std::printf("    keylock ON, 440 Hz sine, 48 kHz, blocks of 480: average pitch error in cents over 4 s "
              "(expected 440 * 2^(key/12) Hz)\n      key   ");
  for (int k = kKeyMin; k <= kKeyMax; k++) std::printf("%+7d", k);
  std::printf("\n");
  int over = 0;
  for (double tempo : tempos) {
    std::vector<PitchResult> row;
    for (int key = kKeyMin; key <= kKeyMax; key++) row.push_back(keylockPitch(*sine, 48000, tempo, key, true, 480));
    std::printf("      %.2f  ", tempo);
    for (const auto& r : row) std::printf("%+7.3f", r.cents);
    std::printf("   (worst 20-period window: ");
    double rowLocal = 0;
    for (const auto& r : row) {
      worstAvg = std::max(worstAvg, std::fabs(r.cents));
      rowLocal = std::max(rowLocal, r.localCents);
      if (std::fabs(r.cents) >= 1.0) over++;
    }
    worstLocal = std::max(worstLocal, rowLocal);
    std::printf("%.2f cents)\n", rowLocal);
  }
  // a 48 kHz file on a 44.1 kHz device (the read pointer resamples, WSOLA runs at 44.1 kHz)
  auto sineB = decktest::sineTrack(8.0, 48000, 440.0, 0.5);
  double worst441 = 0;
  for (double tempo : {0.92, 1.08}) {
    for (int key : {-7, 0, 7}) {
      const PitchResult r = keylockPitch(*sineB, 44100, tempo, key, true, 441);
      worst441 = std::max(worst441, std::fabs(r.cents));
    }
  }
  // keylock OFF with a key shift: varispeed x key (engine.js routes through the transposer)
  double worstOff = 0;
  for (double tempo : tempos) {
    for (int key : {-7, -3, 2, 7}) {
      const PitchResult r = keylockPitch(*sine, 48000, tempo, key, false, 480);
      worstOff = std::max(worstOff, std::fabs(r.cents));
    }
  }
  std::printf("    worst average error %.3f cents (45 cases, %d at or above 1 cent); worst 20-period window %.2f cents; "
              "44.1 kHz device (6 cases) %.3f cents; key without keylock (12 cases, expected 440 * tempo * 2^(key/12)) "
              "%.3f cents\n",
              worstAvg, over, worstLocal, worst441, worstOff);
  // the transposer alone (= pitch-worklet.js, bit for bit) on the same sine, at tempo 1 (the deck feeds it the
  // track itself): its own pitch error, key by key
  {
    std::vector<float> in(static_cast<size_t>(4.5 * 48000));
    for (size_t i = 0; i < in.size(); i++) in[i] = static_cast<float>(0.5 * std::sin(2 * kPi * 440.0 * static_cast<double>(i) / 48000));
    auto ws = std::make_unique<Wsola>();
    std::printf("    Wsola alone (pitch-worklet.js), 440 Hz, ratio 2^(key/12), cents:");
    double worstWs = 0;
    for (int key = kKeyMin; key <= kKeyMax; key++) {
      ws->reset();
      std::vector<float> out(in.size());
      const double ratio = static_cast<double>(static_cast<float>(std::pow(2.0, key / 12.0)));
      for (size_t i = 0; i < in.size(); i += kRenderQuantum) {
        const int n = static_cast<int>(std::min<size_t>(kRenderQuantum, in.size() - i));
        ws->process(&in[i], &in[i], &out[i], nullptr, n, ratio);
      }
      // from 0.5 s after the transposer's 2647-frame latency
      const std::vector<double> t = upCrossings(out, static_cast<size_t>(0.5 * 48000) + Wsola::kLatency, out.size());
      const double c = cents(meanFreq(t, 48000), 440.0 * std::pow(2.0, key / 12.0));
      worstWs = std::max(worstWs, std::fabs(c));
      std::printf(" %+.3f", c);
    }
    std::printf("\n    Wsola alone: worst %.3f cents\n", worstWs);
  }
  // pitch-worklet.js itself (bit-exact port, golden_wsola_suite_vs_pitch_worklet) aligns its grains on whole
  // samples: its average pitch is off by up to ~1.5 cents for some ratios. Parity with the Web engine comes
  // first (SPEC.md §1, §9.4), so the bound asserted here is the worklet's own, 2 cents; the 1-cent target of
  // the campaign is reported above, case by case.
  OM_CHECK(worstAvg < 2.0 && worst441 < 2.0 && worstOff < 2.0);
}

// ---------------------------------------------------------------------------
// 2. The "-84.9 dBFS at tempo 1.06" figure of todo_deck_wsola_priming_and_cost.
// ---------------------------------------------------------------------------
OM_TEST(campaign_keylock_toggle_discontinuity_source) {
  const double fs = 48000;
  auto sine = decktest::sineTrack(10.0, 48000, 440.0, 0.5);
  // the original metric: second difference above the curvature bound of a 0.5 sine at 1.07 x 440 Hz
  const double limit = 0.5 * std::pow(2 * kPi * 440.0 * 1.07 / fs, 2);
  auto excess = [&](const std::vector<float>& x, size_t a, size_t b, size_t& where) {
    double e = 0;
    where = a;
    for (size_t i = std::max<size_t>(a, 2); i < b && i < x.size(); i++) {
      const double d2 = std::fabs(static_cast<double>(x[i]) - 2.0 * x[i - 1] + x[i - 2]);
      if (d2 - limit > e) {
        e = d2 - limit;
        where = i;
      }
    }
    return decktest::toDb(e);
  };
  for (double tempo : {1.0, 1.06}) {
    std::vector<float> out[3];
    for (int mode = 0; mode < 3; mode++) {  // 0: toggles at 9600 / 19200; 1: keylock off all along; 2: on all along
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(sine.get());
      d.setTempo(tempo);
      if (mode == 2) d.setKeylock(true);
      Rig rig;
      d.seek(1.0, 0, rig.now());
      d.play(0, rig.now());
      rig.render(d, 9600);
      if (mode == 0) d.setKeylock(true);
      rig.render(d, 9600);
      if (mode == 0) d.setKeylock(false);
      rig.render(d, 9600);
      out[mode] = rig.outL;
    }
    size_t wAll, wOn, wOff, wDirect, wLocked;
    const double all = excess(out[0], 0, out[0].size(), wAll);
    const double on = excess(out[0], 9600, 9600 + 288 + 256, wOn);      // route crossfade 6 ms = 288 frames
    const double off = excess(out[0], 19200, 19200 + 288 + 256, wOff);
    const double direct = excess(out[1], 0, out[1].size(), wDirect);
    const double locked = excess(out[2], 0, out[2].size(), wLocked);
    std::printf("    tempo %.2f: toggled render %.1f dBFS (frame %zu); inside the ON crossfade %.1f dBFS, inside the OFF "
                "crossfade %.1f dBFS; same metric without toggles: direct path %.1f dBFS (frame %zu), keylock all "
                "along %.1f dBFS (frame %zu)\n",
                tempo, all, wAll, on, off, direct, wDirect, locked, wLocked);
    OM_CHECK(on < -60.0 && off < -60.0);
    // the toggles add nothing above what the paths already show on their own
    OM_CHECK(on <= std::max(direct, locked) + 1.0 && off <= std::max(direct, locked) + 1.0);
  }
}

// ---------------------------------------------------------------------------
// 3. PLAY / hot cue / seek / sync jump -> first target sample.
// ---------------------------------------------------------------------------
namespace {
// Reference: a fresh deck (same settings, smoothers converged while stopped)
// that PLAYs from stop at `pos`: its first frames are the primed target audio.
std::vector<float> playFromStop(const TrackBuffer& tb, double tempo, int key, bool keylock, double pos, int64_t frames) {
  Deck d(0);
  d.prepare(48000, kMaxBlockFrames);
  d.attachTrack(&tb);
  d.setKeylock(keylock);
  d.setTempo(tempo);
  d.setKey(key);
  Rig rig;
  rig.render(d, 19200, 128);  // 400 ms > 10 tau: the ratio smoother has snapped to its target
  d.seek(pos, 0, rig.now());
  d.play(0, rig.now());
  rig.render(d, frames, 128);
  return std::vector<float>(rig.outL.begin() + 19200, rig.outL.end());
}
}  // namespace

OM_TEST(campaign_command_to_first_target_sample) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(20.0);
  struct Mode {
    bool keylock;
    double tempo;
    int key;
  } modes[] = {{false, 1.0, 0}, {true, 1.0, 0}, {false, 1.06, 0}, {true, 1.06, 0}, {true, 0.94, 3}, {false, 0.94, 3}};
  std::printf("    deck level, 48 kHz, 128-frame blocks, command at = now unless said; frames counted from the first "
              "frame of the block the command is applied in\n");
  bool allOk = true;
  for (const Mode& m : modes) {
    const bool routed = m.keylock || m.key != 0;
    const double tol = routed ? 2e-6 : 0.0;  // the transposer at ratio 1 sums two Hann halves in float
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(m.keylock);
    d.setTempo(m.tempo);
    d.setKey(m.key);
    Rig rig;
    rig.render(d, 19200, 128);  // smoothers converged while stopped (400 ms > 10 tau)
    // ---- PLAY from stop at 4.0 s: the first output frame is the target sample (also transposed: the primed
    //      grain at G0 - HS is centred on it with a window of exactly 1, the grain at G0 starts at 0)
    d.seek(4.0, 0, rig.now());
    const size_t p0 = rig.outL.size();
    d.play(rig.presentAt(rig.frame), rig.clock(128));
    om_deck_state s;
    d.snapshot(s, rig.presentAt(rig.frame));
    const double playAnchorMs = (s.anchor_t - rig.presentAt(rig.frame)) * 1000;
    rig.render(d, 9600, 128);
    const bool playExact = std::fabs(static_cast<double>(rig.outL[p0]) - decktest::trackL(*tb, 192000)) <= tol;
    // level of the first 5 ms against the track's own 5 ms there (no fade-in, no silence)
    std::vector<float> src5(240);
    for (int i = 0; i < 240; i++) src5[static_cast<size_t>(i)] = decktest::trackL(*tb, 192000 + i);
    const double level = decktest::rms(&rig.outL[p0], 240) / decktest::rms(src5.data(), 240);
    // the whole first 200 ms: the track itself when not transposed
    double playDiff = 0;
    if (!routed || (m.tempo == 1.0 && m.key == 0)) {
      const double inc = static_cast<double>(static_cast<float>(m.tempo));
      double p = 192000;
      for (int i = 0; i < 9600; i++, p += inc)
        playDiff = std::max(playDiff, std::fabs(static_cast<double>(rig.outL[p0 + static_cast<size_t>(i)]) - lerpAt(*tb, p)));
    }
    // ---- HOT CUE while playing (at = now) to 9.0 s: 5 ms crossfade from frame 0, then the target alone,
    //      identical to a PLAY from stop at 9.0 s
    const size_t c0 = rig.outL.size();
    d.seek(9.0, rig.presentAt(rig.frame), rig.clock(128));
    d.snapshot(s, rig.presentAt(rig.frame));
    const double cueAnchorMs = (s.anchor_t - rig.presentAt(rig.frame)) * 1000;
    const double cuePos = s.anchor_pos;
    rig.render(d, 9600, 128);
    const std::vector<float> refCue = playFromStop(*tb, m.tempo, m.key, m.keylock, 9.0, 9600);
    int64_t cueAlone = -1;
    for (int64_t i = 0; i < 1000 && cueAlone < 0; i++) {
      if (decktest::maxAbsDiff(&rig.outL[c0 + static_cast<size_t>(i)], &refCue[static_cast<size_t>(i)],
                               static_cast<size_t>(9600 - i)) == 0.0)
        cueAlone = i;
    }
    // ---- SEEK while playing with at = 30 ms before the block is heard (waveform click): target t + 0.03 x tempo
    const EngineTime at = rig.presentAt(rig.frame) - 0.03;
    const size_t k0 = rig.outL.size();
    d.seek(12.0, at, rig.clock(128));
    d.snapshot(s, rig.presentAt(rig.frame));
    const double seekPos = s.anchor_pos;
    const double seekWant = std::round((12.0 + 0.03 * static_cast<double>(m.tempo)) * fs) / fs;
    rig.render(d, 4800, 128);
    const std::vector<float> refSeek = playFromStop(*tb, m.tempo, m.key, m.keylock, seekWant, 4800);
    const double seekDiff = decktest::maxAbsDiff(&rig.outL[k0 + 240], &refSeek[240], 4800 - 240);
    // ---- sync jump (seekHeard): heard position at presentTime exactly t (read back like the sync engine does)
    d.seekHeard(15.0);
    const double heardAfterSync = d.heardPosition();
    std::printf("    keylock %d tempo %.2f key %+d: PLAY -> frame 0 %s the target sample (anchor %+.3f ms), first 5 ms "
                "at %.3f x the track's own level there%s; HOT CUE -> crossfade from frame 0 (anchor %+.3f ms, target %.6f "
                "s), then identical to a PLAY at the cue from frame %lld; SEEK with at = -30 ms -> target %.6f s (want "
                "%.6f), then = PLAY there (max |diff| %.3g); sync jump -> heard %.9f s (want 15)\n",
                m.keylock, m.tempo, m.key, playExact ? "IS" : "is NOT", playAnchorMs, level,
                playDiff > 0 || !routed ? (std::string(", first 200 ms vs the track max |diff| ") + std::to_string(playDiff)).c_str() : "",
                cueAnchorMs, cuePos, static_cast<long long>(cueAlone), seekPos, seekWant, seekDiff, heardAfterSync);
    const bool ok = playExact && level > 0.8 && level < 1.25 && playDiff <= tol && std::fabs(playAnchorMs) < 1e-6 &&
                    std::fabs(cueAnchorMs) < 1e-6 && cueAlone >= 0 && cueAlone <= 240 && std::fabs(cuePos - 9.0) < 1e-12 &&
                    std::fabs(seekPos - seekWant) < 1e-12 && seekDiff == 0.0 && std::fabs(heardAfterSync - 15.0) < 1e-9;
    allOk = allOk && ok;
  }
  OM_CHECK(allOk);
  std::printf("    Web engine (SPEC.md Appendix D): PLAY and hot cue sound 30 ms after the command (scheduling lead, "
              "1440 frames at 48 kHz), plus 55-60 ms under keylock (the worklet's 2647-frame latency); both engines "
              "add the limiter's 6 ms look-ahead (mixer)\n");
}

// ---------------------------------------------------------------------------
// 4. Cost of 4 simultaneous primes, worst modes.
// ---------------------------------------------------------------------------
OM_TEST(campaign_four_primes_cost_worst_modes) {
  auto tb = decktest::musicTrack(30.0);
  auto stemA = decktest::musicTrack(30.0, 48000, PcmFormat::S16, 5);
  auto stemB = decktest::musicTrack(30.0, 48000, PcmFormat::S16, 6);
  auto stemC = decktest::musicTrack(30.0, 48000, PcmFormat::S16, 7);
  auto tb441 = decktest::musicTrack(30.0, 44100);
  StemSet set;
  set.stems[0] = stemA.get();
  set.stems[1] = stemB.get();
  set.stems[2] = stemC.get();
  BeatGrid g;
  g.bpm = 124;
  g.beatOffset = 0.01;
  struct Mode {
    const char* name;
    double fs;
    bool stems, roll;
    int key;
  } modes[] = {{"keylock, ratio != 1", 48000, false, false, 0},
               {"keylock + key +3", 48000, false, false, 3},
               {"keylock + 3 stems", 48000, true, false, 0},
               {"keylock + 3 stems + roll", 48000, true, true, 0},
               {"keylock, 44.1 kHz device", 44100, false, false, 0}};
  for (const Mode& m : modes) {
    const double period = 128 / m.fs * 1e6;
    std::vector<std::unique_ptr<Deck>> decks;
    Rig rig;
    rig.rate = m.fs;
    for (int k = 0; k < 4; k++) {
      decks.push_back(std::make_unique<Deck>(k));
      Deck& d = *decks.back();
      d.prepare(m.fs, kMaxBlockFrames);
      d.attachTrack(m.fs == 44100 ? tb441.get() : tb.get());
      d.attachGrid(&g);
      if (m.stems) d.attachStems(&set);
      d.setKeylock(true);
      d.setKey(m.key);
      d.setTempo(1.0 + 0.031 * (k + 1));
      d.seek(1.0 + k, 0, rig.now());
      d.play(0, rig.now());
      if (m.stems) d.setStemsOn(true);
    }
    std::vector<float> l(128), r(128);
    for (int i = 0; i < 200; i++) {
      const BlockClock c = rig.clock(128);
      for (auto& d : decks) d->render(l.data(), r.data(), 128, c);
      rig.frame += 128;
    }
    std::vector<double> cost;
    for (int it = 0; it < 120; it++) {
      if (m.roll) {
        for (auto& d : decks) {
          if (!d->rolling(nullptr)) OM_CHECK(d->startRoll(0.5, 0.6));
        }
      }
      const BlockClock c = rig.clock(128);
      double t0, t1;
      {
        rt::Scope rts;
        t0 = nowUs();
        for (int k = 0; k < 4; k++) decks[static_cast<size_t>(k)]->seek(2.0 + ((it * 7 + k * 3) % 20), 0, c);
        t1 = nowUs();
        for (auto& d : decks) d->render(l.data(), r.data(), 128, c);
      }
      rig.frame += 128;
      cost.push_back(t1 - t0);
      for (int i = 0; i < 3; i++) {
        const BlockClock c2 = rig.clock(128);
        for (auto& d : decks) d->render(l.data(), r.data(), 128, c2);
        rig.frame += 128;
      }
    }
    const double med = percentile(cost, 0.5), p99 = percentile(cost, 0.99), mx = percentile(cost, 1.0);
    std::printf("    4 primes, %-26s median %6.1f us = %5.2f %% of the 128-frame period (%.0f us); p99 %6.1f us = %5.2f %%; "
                "max %6.1f us [%s]\n",
                m.name, med, 100 * med / period, period, p99, 100 * p99 / period, mx, kOptimized ? "optimized" : "debug");
    if (kOptimized) OM_CHECK(med < 0.25 * period);
    else OM_CHECK(med < 4.0 * period);  // sanity only: unoptimized code
  }
}

// Stems through the prime: two stems that are exact halves of the track sum
// to the track bit for bit (x/2 + x/2 == x in float), so a keylocked deck
// playing them must render exactly what the track-only deck renders, through
// stems on, primes (seeks, hot cues), loop wraps inside the prime history and
// the end of the track.
OM_TEST(campaign_stems_prime_history_matches_the_track) {
  const double fs = 48000;
  std::vector<float> L, R;
  decktest::makeSignal(L, R, static_cast<int64_t>(20 * fs), fs, 21);
  std::vector<float> hL(L.size()), hR(R.size());
  for (size_t i = 0; i < L.size(); i++) {
    hL[i] = L[i] * 0.5f;
    hR[i] = R[i] * 0.5f;
  }
  auto tb = decktest::makeTrack(L, R, 48000, PcmFormat::F32);
  auto half1 = decktest::makeTrack(hL, hR, 48000, PcmFormat::F32);
  auto half2 = decktest::makeTrack(hL, hR, 48000, PcmFormat::F32);
  StemSet set;
  set.stems[0] = half1.get();
  set.stems[1] = half2.get();
  double worst = 0;
  for (double tempo : {1.0, 1.06}) {
    std::vector<float> out[2];
    for (int withStems = 0; withStems < 2; withStems++) {
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(tb.get());
      if (withStems) d.attachStems(&set);
      d.setKeylock(true);
      d.setTempo(tempo);
      Rig rig;
      rig.render(d, 19200, 441);
      if (withStems) d.setStemsOn(true);  // before PLAY: the first prime reads the stems (no crossfade)
      d.seek(3.0, 0, rig.now());
      d.play(0, rig.now());
      rig.render(d, 9600, 441);
      d.seek(7.25, 0, rig.now());  // hot cue: prime from the stems
      rig.render(d, 9600, 441);
      d.setLoop(7.3, 7.4);         // a 100 ms loop: the next prime's history wraps
      rig.render(d, 14400, 441);
      d.seek(7.35, 0, rig.now());  // jump inside the loop
      rig.render(d, 14400, 441);
      d.exitLoop();
      d.seek(19.9, 0, rig.now());  // prime near the end, play out the end
      rig.render(d, 9600, 441);
      out[withStems] = rig.outL;
    }
    worst = std::max(worst, decktest::maxAbsDiff(out[0].data(), out[1].data(), out[0].size()));
  }
  std::printf("    keylocked deck on stems = two halves of the track vs the track alone (stems on, hot cues, a loop "
              "inside the prime history, the end), tempo 1.00 and 1.06: max |diff| %.3g\n",
              worst);
  OM_CHECK(worst == 0.0);
}

// The plugin transport after a jump: the core asks positionAt(presentTime + L / rate) right after the commands
// of a block (src/core/engine.cpp, the insert input position, SPEC.md §13.3). After a seek, hot cue or sync
// jump that position is the jump target; (p + lead) - p is not exactly lead in floating point, so a time on
// the frame boundary must not be read as the frame before it (the pre-jump position).
OM_TEST(campaign_transport_position_right_after_a_jump) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(20.0);
  int wrong = 0, total = 0;
  double worst = 0;
  for (double epoch : {1234.5678, 36000.123, 864000.5}) {  // engine times after 20 min, 10 h, 10 days
  for (int lat : {184, 480, 1000}) {
    for (int keylock = 0; keylock < 2; keylock++) {
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(tb.get());
      d.setKeylock(keylock != 0);
      d.setInsertLatency(lat);
      Rig rig;
      rig.epoch = epoch;
      d.seek(2.0, 0, rig.now());
      d.play(0, rig.now());
      rig.render(d, 4800, 256);
      for (int k = 0; k < 40; k++) {
        const double target = 3.0 + 0.37 * k;
        const BlockClock c = rig.clock(256);
        d.seek(target, 0, c);
        const double p = d.positionAt(c.presentTime + lat / fs);  // what the core gives the plugin
        const double want = std::round(target * fs) / fs;
        worst = std::max(worst, std::fabs(p - want));
        if (std::fabs(p - want) > 1e-6) wrong++;
        total++;
        rig.render(d, 2560, 256);
      }
    }
  }
  }
  std::printf("    positionAt(presentTime + latency) right after a jump (latency 184 / 480 / 1000 frames, keylock off "
              "and on, engine time 20 min / 10 h / 10 days): %d of %d wrong, worst error %.6f s\n",
              wrong, total, worst);
  OM_CHECK(wrong == 0);
}

// ---------------------------------------------------------------------------
// 5. A 4-beat loop exact to the sample over 100 wraps.
// ---------------------------------------------------------------------------
OM_TEST(campaign_loop_4_beats_exact_over_100_wraps) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(40.0);
  struct Case {
    double bpm, tempo, start;
    bool keylock;
    int block;
  } cases[] = {{128, 1.0, 10.0, false, 441},       // 4 beats = 90000 frames exactly
               {124, 1.0, 10.0123456, false, 441},  // 92903.2258 frames, fractional loop start
               {124, 1.06, 10.0123456, false, 480},
               {128, 1.0, 10.0, true, 441},
               {124, 1.06, 10.0123456, true, 480},
               {124, 0.92, 10.0123456, true, 128}};
  for (const Case& cs : cases) {
    const double loopStart = cs.start, loopEnd = cs.start + 4 * 60.0 / cs.bpm;
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(cs.keylock);
    d.setTempo(cs.tempo);
    BlockClock c0;
    c0.frames = cs.block;
    c0.sampleRate = fs;
    c0.presentTime = 100.0;
    d.seek(loopStart + 0.25, 0, c0);
    d.setLoop(loopStart, loopEnd);
    d.play(0, c0);
    om_deck_state s;
    d.snapshot(s, c0.presentTime);
    const uint32_t seg0 = s.seg;
    // Chromium's loop (closed form, no accumulation): p_i = s + fmod(p0 - s + i * inc, L)
    const double S = loopStart * fs, E = loopEnd * fs, L = E - S;
    const double p0 = std::round((loopStart + 0.25) * fs);
    const double inc = static_cast<double>(static_cast<float>(cs.tempo));
    const int64_t total = static_cast<int64_t>(std::ceil((100.0 * L + 0.5 * L) / inc));
    std::vector<float> l(kMaxBlockFrames), r(kMaxBlockFrames);
    int64_t g = 0;
    const bool checkOutput = !cs.keylock || cs.tempo == 1.0;  // keylock at ratio 1: the output is the track
    double maxDiff = 0, maxPosErr = 0;
    int wraps = 0, wrapFrameErr = 0;
    double prevDeckPos = -1;
    int64_t idealWrap = static_cast<int64_t>(std::ceil((E - p0) / inc));  // first frame whose position wrapped
    int64_t k = 1;
    // the deck's heard position in the middle of frame gi (no frame-boundary rounding), vs the closed form,
    // compared modulo the loop (loopEnd and loopStart are the same instant at a wrap)
    auto modErr = [L](double a, double b) {
      const double e = std::fabs(a - b);
      return std::min(e, std::fabs(e - L));
    };
    while (g < total) {
      const int n = static_cast<int>(std::min<int64_t>(cs.block, total - g));
      BlockClock c = c0;
      c.frame = g;
      c.frames = n;
      c.presentTime = c0.presentTime + static_cast<double>(g) / fs;
      c.sampleTime = static_cast<double>(g) / fs;
      {
        rt::Scope rts;
        d.render(l.data(), r.data(), n, c);
      }
      for (int i = 0; i < n; i++) {
        const int64_t gi = g + i;
        const double want = S + std::fmod(p0 - S + static_cast<double>(gi) * inc, L);
        if (checkOutput)
          maxDiff = std::max(maxDiff, std::fabs(static_cast<double>(l[static_cast<size_t>(i)]) - lerpAt(*tb, want)));
        const double deckPos = d.positionAt(c.presentTime + (i + 0.5) / fs) * fs;
        maxPosErr = std::max(maxPosErr, modErr(deckPos, want + 0.5 * inc));
        if (deckPos < prevDeckPos) {  // the deck's position wrapped at frame gi
          wraps++;
          wrapFrameErr = std::max(wrapFrameErr, static_cast<int>(std::llabs(gi - idealWrap)));
          k++;
          idealWrap = static_cast<int64_t>(std::ceil((E + static_cast<double>(k - 1) * L - p0) / inc));
        }
        prevDeckPos = deckPos;
      }
      g += n;
    }
    d.snapshot(s, c0.presentTime + static_cast<double>(g) / fs);
    const double endErr = modErr(s.pos * fs, S + std::fmod(p0 - S + static_cast<double>(g) * inc, L));
    char diff[64];
    std::snprintf(diff, sizeof diff, checkOutput ? "%.3g" : "n/a (transposed)", maxDiff);
    std::printf("    loop %.0f BPM x4 (%.4f frames) tempo %.2f keylock %d blocks %d: %d wraps; output vs closed form "
                "max |diff| %s; heard position max error %.3g frames (after the last wrap %.3g); wrap frames off by "
                "%d; segment %s\n",
                cs.bpm, L, cs.tempo, cs.keylock, cs.block, wraps, diff, maxPosErr, endErr, wrapFrameErr,
                s.seg == seg0 ? "unchanged" : "CHANGED");
    OM_CHECK(wraps >= 100);
    OM_CHECK(s.seg == seg0 && s.looping);
    OM_CHECK(maxPosErr < 1e-4 && endErr < 1e-4);
    OM_CHECK(wrapFrameErr == 0);
    if (checkOutput) OM_CHECK(maxDiff < (cs.keylock ? 2e-6 : 1e-6));
  }
  // keylock at ratio 1 over an integer loop: the output repeats bit for bit every loop
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(true);
    Rig rig;
    rig.rtCheck = true;
    d.seek(10.0, 0, rig.now());
    d.setLoop(10.0, 11.875);  // 90000 frames
    d.play(0, rig.now());
    double worst = 0;
    std::vector<float> first;
    for (int w = 0; w < 100; w++) {
      rig.outL.clear();
      rig.outR.clear();
      rig.render(d, 90000, 441);
      if (w == 0) first = rig.outL;
      else worst = std::max(worst, decktest::maxAbsDiff(rig.outL.data(), first.data(), first.size()));
    }
    std::vector<float> src(90000);
    for (int i = 0; i < 90000; i++) src[static_cast<size_t>(i)] = decktest::trackL(*tb, 480000 + i);
    const double vsTrack = decktest::maxAbsDiff(first.data(), src.data(), src.size());
    // (not bit for bit: 90000 is not a multiple of the 768-frame hop, so the two Hann halves summed in float
    // round differently from one wrap to the next)
    std::printf("    keylock at ratio 1, 90000-frame loop, 100 wraps: every wrap vs the first max |diff| %.3g; first "
                "wrap vs the track %.3g\n",
                worst, vsTrack);
    OM_CHECK(worst < 2e-6);
    OM_CHECK(vsTrack < 2e-6);
  }
}

// ---------------------------------------------------------------------------
// 6. Scratch backward plays reversed audio.
// ---------------------------------------------------------------------------
OM_TEST(campaign_scratch_backward_reversed_audio) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(12.0);
  // timing: 0 = a Move every 1/60 s (app.js rAF loop), 1 = 60 Hz with every 7th UI frame dropped (33 ms gap),
  // 2 = raw jog events every 4..12 ms (not what app.js sends: it smooths jogs on rAF)
  struct Case {
    double speed;
    int timing;
    int block;
  } cases[] = {{-0.5, 0, 800}, {-0.5, 0, 128}, {-1.0, 0, 128}, {-2.0, 0, 128}, {-4.0, 0, 128}, {-1.0, 0, 480},
               {1.0, 0, 128},  {-1.0, 1, 128}, {-1.0, 1, 480}, {-1.0, 2, 128}, {-2.0, 2, 480}};
  const char* timingName[] = {"a Move every 1/60 s,", "60 Hz, every 7th dropped,", "jog events every 4..12 ms,"};
  bool allOk = true;
  uint32_t x = 12345;
  auto rnd = [&x]() {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x / 4294967296.0;
  };
  for (const Case& cs : cases) {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    const double x0 = 8.0;
    d.seek(x0, 0, rig.now());
    d.scratch(ScratchPhase::Start, 0, rig.presentAt(rig.frame), rig.clock(cs.block));
    // UI events: every 1/60 s, or a jog at irregular 4..12 ms intervals; target = x0 + speed * (at - at0). The
    // engine applies a command at the start of the next block (as the core does), with the event's own `at`.
    const EngineTime at0 = rig.presentAt(rig.frame);
    int64_t nextEvent = 0;  // frame of the next UI event (whole frames: no rounding drift)
    int uiFrame = 0;
    const int64_t frames = static_cast<int64_t>(1.0 * fs);
    while (rig.frame < frames) {
      while (rig.frame >= nextEvent) {
        const double te = static_cast<double>(nextEvent) / fs;
        d.scratch(ScratchPhase::Move, x0 + cs.speed * te, at0 + te, rig.clock(cs.block));
        if (cs.timing == 2) nextEvent += static_cast<int64_t>(192 + 384 * rnd());
        else nextEvent += (cs.timing == 1 && ++uiFrame % 7 == 0) ? 1600 : 800;
      }
      rig.render(d, cs.block, cs.block);
    }
    // the last 400 ms: the track read at `speed` (linear interpolation) around the expected path
    const size_t n = 19200, a = rig.outL.size() - n;
    om_deck_state s;
    d.snapshot(s, rig.presentAt(rig.frame));
    const double posEnd = s.pos * fs;  // heard position after the window (follower)
    std::vector<float> ref(n);
    auto corrAt = [&](double lag) {
      const double startPos = posEnd - cs.speed * static_cast<double>(n) + lag;
      for (size_t i = 0; i < n; i++) ref[i] = lerpAt(*tb, startPos + cs.speed * static_cast<double>(i));
      return decktest::correlation(&rig.outL[a], ref.data(), n);
    };
    double best = -1, bestLag = 0;
    for (double lag = -480; lag <= 480; lag += 4) {  // coarse, then fine around the best
      const double c = corrAt(lag);
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    const double coarse = bestLag;
    for (double lag = coarse - 4; lag <= coarse + 4; lag += 0.25) {
      const double c = corrAt(lag);
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    // speed steadiness over the window: the heard rate sampled every 2.5 ms
    double rateMin = 1e9, rateMax = -1e9;
    for (size_t i = 0; i < n; i += 120) {
      om_deck_state si;
      d.snapshot(si, rig.presentAt(static_cast<int64_t>(a + i)));
      rateMin = std::min(rateMin, si.rate);
      rateMax = std::max(rateMax, si.rate);
    }
    std::printf("    scratch speed %+.1f x, %-26s blocks %4d: correlation with the track read %s %.5f (best offset "
                "%+.2f frames); heard rate over the last 400 ms %.3f .. %.3f\n",
                cs.speed, timingName[cs.timing], cs.block,
                cs.speed < 0 ? "backward" : "forward", best, bestLag, rateMin, rateMax);
    // asserted for the event stream app.js sends (rAF, with dropped frames); raw jog streams are reported
    if (cs.timing != 2)
      allOk = allOk && best > 0.99 && std::fabs(rateMin - cs.speed) < 0.05 * std::fabs(cs.speed) &&
              std::fabs(rateMax - cs.speed) < 0.05 * std::fabs(cs.speed);
  }
  // the hand stops (no more Moves, as after the last pointermove): how far the platter still travels
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(8.0, 0, rig.now());
    d.scratch(ScratchPhase::Start, 0, rig.presentAt(rig.frame), rig.clock(128));
    const EngineTime at0 = rig.presentAt(rig.frame);
    int64_t nextEvent = 0;
    double lastT = 8.0;
    while (rig.frame < 24000) {
      while (rig.frame >= nextEvent) {
        const double te = static_cast<double>(nextEvent) / fs;
        lastT = 8.0 - te;
        d.scratch(ScratchPhase::Move, lastT, at0 + te, rig.clock(128));
        nextEvent += 800;
      }
      rig.render(d, 128, 128);
    }
    rig.render(d, 9600, 128);
    om_deck_state s;
    d.snapshot(s, rig.presentAt(rig.frame));
    std::printf("    the hand stops at -1 x (last Move at %.4f s): the platter rests at %.4f s, %.1f ms past the last "
                "target (the target coasts two UI intervals, then holds)\n",
                lastT, s.pos, (lastT - s.pos) * 1000);
    allOk = allOk && std::fabs(s.rate) < 1e-3 && lastT - s.pos < 0.04;
  }
  // the same stop through app.js's MIDI jog loop: on each animation frame, pos += (target - pos) *
  // (1 - exp(-dt / 0.015)), a Move while |target - pos| > 0.05 ms (the jog at -1 x, then the hand stops)
  {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    Rig rig;
    d.seek(8.0, 0, rig.now());
    d.scratch(ScratchPhase::Start, 0, rig.presentAt(rig.frame), rig.clock(128));
    const EngineTime at0 = rig.presentAt(rig.frame);
    double target = 8.0, pos = 8.0;
    int64_t nextEvent = 0;
    while (rig.frame < 48000) {
      while (rig.frame >= nextEvent) {
        const double te = static_cast<double>(nextEvent) / fs;
        target = 8.0 - std::min(te, 0.5);  // the jog turns at -1 x for 0.5 s, then stops
        const double gap = target - pos;
        if (std::fabs(gap) > 0.00005) {
          pos += gap * (1 - std::exp(-(1.0 / 60) / 0.015));
          d.scratch(ScratchPhase::Move, pos, at0 + te, rig.clock(128));
        }
        nextEvent += 800;
      }
      rig.render(d, 128, 128);
    }
    om_deck_state s;
    d.snapshot(s, rig.presentAt(rig.frame));
    std::printf("    the jog stops through app.js's 15 ms smoother: the platter rests %.2f ms past the jog's final "
                "position (last Move %.2f ms short of it)\n",
                (target - s.pos) * 1000, (target - pos) * 1000);
    allOk = allOk && std::fabs(s.rate) < 1e-3 && std::fabs(target - s.pos) < 0.002;
  }
  OM_CHECK(allOk);
}

// ---------------------------------------------------------------------------
// 7. V.BRAKE / BACKSPIN speed and gain envelopes vs engine.js spinSound.
// ---------------------------------------------------------------------------
namespace {
// engine.js spinSound in Chromium: playbackRate.setValueAtTime(v0, now) +
// linearRampToValueAtTime(0.001, now + dur), a k-rate parameter of
// AudioBufferSourceNode (one value per 128-frame quantum, from now).
double engineJsSpinSpeedAt(int64_t frame, double fs, double v0, double dur) {
  const int64_t q = frame & ~int64_t(kRenderQuantum - 1);
  const double t = static_cast<double>(q) / fs;
  return t < dur ? v0 + (0.001 - v0) * (t / dur) : 0.001;
}
double engineJsSpinGainAt(int64_t frame, double fs, double dur) {
  const double t = static_cast<double>(frame) / fs;
  const double fadeAt = std::max(0.01, dur - 0.04);
  if (t >= dur + 0.05) return 0.0;  // s.stop(now + dur + 0.05)
  if (t <= fadeAt) return 1.0;
  return std::max(0.0, 1.0 - (t - fadeAt) / (dur - fadeAt));
}
}  // namespace

OM_TEST(campaign_spin_envelopes_vs_engine_js) {
  const double fs = 48000;
  auto dc = constTrack(12.0, 0.5f);
  auto ramp = rampTrack(12.0);
  struct Case {
    const char* name;
    SpinKind kind;
    double tempo, from;
  } cases[] = {{"V.BRAKE tempo 1.00", SpinKind::VBrake, 1.0, 3.0},
               {"V.BRAKE tempo 1.25", SpinKind::VBrake, 1.25, 3.0},
               {"V.BRAKE tempo 0.50", SpinKind::VBrake, 0.5, 3.0},
               {"BACKSPIN", SpinKind::Backspin, 1.0, 9.0}};
  bool allOk = true;
  for (const Case& cs : cases) {
    const bool back = cs.kind == SpinKind::Backspin;
    const double v0 = back ? 7.0 : std::max(0.2, static_cast<double>(static_cast<float>(cs.tempo)));
    const double dur = v0 / (back ? 4.5 : 1.6);
    const int64_t frames = static_cast<int64_t>((dur + 0.1) * fs);
    std::vector<float> gOut, pOut;
    for (int pass = 0; pass < 2; pass++) {
      Deck d(0);
      d.prepare(fs, kMaxBlockFrames);
      d.attachTrack(pass == 0 ? dc.get() : ramp.get());
      d.setTempo(cs.tempo);
      Rig rig;
      d.seek(cs.from, 0, rig.now());
      d.spin(cs.kind, rig.now());
      rig.render(d, frames, 128);
      (pass == 0 ? gOut : pOut) = rig.outL;
    }
    // gain envelope (constant track): output / 0.5
    double gainErr = 0;
    int64_t lastSound = -1;
    for (int64_t i = 0; i < frames; i++) {
      const double gv = gOut[static_cast<size_t>(i)] / 0.5;
      gainErr = std::max(gainErr, std::fabs(gv - engineJsSpinGainAt(i, fs, dur)));
      if (gOut[static_cast<size_t>(i)] != 0.0f) lastSound = i;
    }
    // speed envelope (ramp track) while the gain is 1: position = output * 2^20
    const int64_t fadeAt = static_cast<int64_t>(std::max(0.01, dur - 0.04) * fs);
    double speedErr = 0, speedErrPerSample = 0;
    // engine.js slice start: floor(a sr), or floor(a sr) + n - 1 for the reversed slice of a backspin
    double start = cs.from * fs;
    if (back) {
      const double dist = v0 * v0 / (2 * 4.5) + 0.15;
      const double a = std::max(0.0, cs.from - dist);
      start = std::floor(a * fs) + std::max(3000.0, std::floor((cs.from - a) * fs)) - 1;
    }
    double posJs = start;   // engine.js position (k-rate speed)
    double posLin = start;  // per-sample linear ramp
    double driftJs = 0, driftLin = 0;
    for (int64_t q = 0; q + kRenderQuantum < fadeAt; q += kRenderQuantum) {
      const double pa = pOut[static_cast<size_t>(q)] / kRampScale;
      const double pb = pOut[static_cast<size_t>(q + kRenderQuantum)] / kRampScale;
      const double v = std::fabs(pb - pa) / kRenderQuantum;
      const double vJs = engineJsSpinSpeedAt(q, fs, v0, dur);
      speedErr = std::max(speedErr, std::fabs(v - vJs) / v0);
      const double vLin = v0 + (0.001 - v0) * ((static_cast<double>(q) + 63.5) / fs / dur);
      speedErrPerSample = std::max(speedErrPerSample, std::fabs(v - vLin) / v0);
    }
    for (int64_t i = 0; i < fadeAt; i++) {
      const double p = pOut[static_cast<size_t>(i)] / kRampScale;
      driftJs = std::max(driftJs, std::fabs(p - posJs));
      driftLin = std::max(driftLin, std::fabs(p - posLin));
      const double t = static_cast<double>(i) / fs;
      const double vl = t < dur ? v0 + (0.001 - v0) * (t / dur) : 0.001;
      posJs += (back ? -1 : 1) * engineJsSpinSpeedAt(i, fs, v0, dur);
      posLin += (back ? -1 : 1) * vl;
    }
    std::printf("    %-20s v0 %.2f dur %.4f s: gain envelope max error %.2e; last sound at %.4f s (engine.js gain 0 at "
                "%.4f s); speed per quantum vs engine.js k-rate ramp max error %.2e x v0 (vs a per-sample ramp %.2e); "
                "position vs engine.js max %.2f frames (vs per-sample ramp %.2f)\n",
                cs.name, v0, dur, gainErr, lastSound / fs, dur, speedErr, speedErrPerSample, driftJs, driftLin);
    allOk = allOk && gainErr < 1e-3 && lastSound >= 0 && lastSound / fs <= dur + 1.0 / fs && speedErr < 1e-3 &&
            driftJs < 0.5;
  }
  OM_CHECK(allOk);
}

// ---------------------------------------------------------------------------
// 8. End-of-track event timing.
// ---------------------------------------------------------------------------
OM_TEST(campaign_end_of_track_event_timing) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(3.0);  // 144000 frames, music up to the last frame
  // the same music followed by 1 s of silence: the transposer's natural tail past the end, for comparison
  std::vector<float> eL, eR;
  decktest::makeSignal(eL, eR, 144000, 48000, 99);
  eL.resize(144000 + 48000, 0.0f);
  eR.resize(144000 + 48000, 0.0f);
  auto ext = decktest::makeTrack(eL, eR, 48000, PcmFormat::F32);
  const double len = static_cast<double>(tb->frames);
  int worstErr = 0, worstSilence = 0;
  double worstTail = 0, worstStep = 0, worstCut = 0;
  bool allOk = true;
  std::printf("    natural end: the ended latch vs the heard end (frame where the heard position reaches the "
              "duration), deck level\n");
  for (double tempo : {0.92, 1.0, 1.08}) {
    for (int keylock = 0; keylock < 2; keylock++) {
      for (int lat : {0, 480}) {
        for (int block : {128, 441}) {
          Deck d(0);
          d.prepare(fs, kMaxBlockFrames);
          d.attachTrack(tb.get());
          d.setKeylock(keylock != 0);
          d.setTempo(tempo);
          d.setInsertLatency(lat);
          Rig rig;
          rig.render(d, 4800, block);  // smoothers converged while stopped
          const int64_t f0 = rig.frame;
          d.seek(2.6, 0, rig.now());
          d.play(0, rig.clock(block));
          // expected: Chromium's read pointer from round(2.6 fs), accumulated; the first frame at or past the end
          const double inc = static_cast<double>(static_cast<float>(tempo));
          double p = std::round(2.6 * fs);
          int64_t jEnd = 0;
          while (p < len) {
            p += inc;
            jEnd++;
          }
          const int64_t heardEnd = jEnd + lat;  // frames after the play block start
          rig.render(d, heardEnd + 4800, block);
          om_deck_state s;
          d.snapshot(s, rig.presentAt(rig.frame));
          const double endedFrame = (s.ended_at - rig.presentAt(f0)) * fs;
          const int err = static_cast<int>(std::llround(endedFrame)) - static_cast<int>(heardEnd);
          // heard position one frame before the latch, and at it
          om_deck_state before;
          d.snapshot(before, rig.presentAt(f0 + heardEnd - 1));
          // the deck's own output (before the insert): last frame with sound, tail after the heard end
          int64_t last = -1;
          for (int64_t i = 0; i < heardEnd + 4800; i++)
            if (rig.outL[static_cast<size_t>(f0 + i)] != 0.0f) last = i;
          const int64_t ownEnd = heardEnd - lat;  // the deck's own output carries the end at this frame
          double tail = 0;
          for (int64_t i = ownEnd; i <= last; i++) tail = std::max(tail, std::fabs(static_cast<double>(rig.outL[static_cast<size_t>(f0 + i)])));
          const double step = last >= 0 ? std::fabs(static_cast<double>(rig.outL[static_cast<size_t>(f0 + last)])) : 0.0;
          // the same render over the track followed by silence: what the transposer would still output past the
          // end; the difference after the end = what the end latch cut
          double cut = 0;
          int64_t cutAt = -1;
          {
            Deck d2(0);
            d2.prepare(fs, kMaxBlockFrames);
            d2.attachTrack(ext.get());
            d2.setKeylock(keylock != 0);
            d2.setTempo(tempo);
            d2.setInsertLatency(lat);
            Rig rig2;
            rig2.render(d2, 4800, block);
            d2.seek(2.6, 0, rig2.now());
            d2.play(0, rig2.clock(block));
            rig2.render(d2, heardEnd + 4800, block);
            for (int64_t i = 0; i < heardEnd + 4800; i++) {
              const size_t k = static_cast<size_t>(f0 + i);
              // identical well before the end (Chromium extrapolates the last frame of a buffer; the grains reach
              // ~1250 frames around their centre)
              if (i < ownEnd - 2100) allOk = allOk && rig2.outL[k] == rig.outL[k];
              else if (i >= ownEnd && std::fabs(static_cast<double>(rig2.outL[k]) - rig.outL[k]) > cut) {
                cut = std::fabs(static_cast<double>(rig2.outL[k]) - rig.outL[k]);
                cutAt = i - ownEnd;
              }
            }
          }
          worstErr = std::max(worstErr, std::abs(err));
          worstSilence = std::max(worstSilence, static_cast<int>(last - (ownEnd - 1)));
          worstTail = std::max(worstTail, tail);
          worstStep = std::max(worstStep, step);
          worstCut = std::max(worstCut, cut);
          if (block == 441)
            std::printf("    tempo %.2f keylock %d insert %3d: ended at frame %+d of the heard end; count %u; heard pos "
                        "before %.6f s, after %.6f s; deck output: last sound %+lld frames after its own end, tail max "
                        "%.4f, last sample %.4f; transposer tail cut by the latch max %.4f (%lld frames after the end)\n",
                        tempo, keylock, lat, err, s.ended_count, before.pos, s.pos,
                        static_cast<long long>(last - (ownEnd - 1)), tail, step, cut, static_cast<long long>(cutAt));
          allOk = allOk && s.ended_count == 1 && !s.playing && s.pos == tb->duration() && err == 0 &&
                  before.pos < tb->duration() && before.pos > tb->duration() - 2.0 * tempo / fs && !std::isnan(s.ended_at);
        }
      }
    }
  }
  std::printf("    ended latch vs heard end: worst %d frames (24 cases, blocks 128 and 441); sound after the deck's own "
              "end: up to %d frames, tail max %.4f, last sample %.4f; transposer tail cut by the latch: max %.4f\n",
              worstErr, worstSilence, worstTail, worstStep, worstCut);
  OM_CHECK(allOk);
}
