// Measurements of the deck module (owner: deck), printed by the test run:
// time from a play / hot cue / seek (with 'at' = now) to the first output
// sample of the target audio, with and without keylock; the cost of 4
// simultaneous WSOLA primes (target < 25 % of a 128-frame period, SPEC.md
// §9.4, Appendix B); CPU per 128-frame block per deck in the main modes.
// The time budgets are asserted in optimized builds only (NDEBUG, no
// sanitizer): Debug and ASan builds print the numbers and check sanity bounds.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <vector>

#include "deck_test_util.h"
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

struct Stats {
  double min = 1e300, max = 0, sum = 0;
  int n = 0;
  std::vector<double> v;
  void add(double x) {
    min = std::min(min, x);
    max = std::max(max, x);
    sum += x;
    n++;
    v.push_back(x);
  }
  double median() {
    std::sort(v.begin(), v.end());
    return v.empty() ? 0 : v[v.size() / 2];
  }
  double mean() const { return n ? sum / n : 0; }
};

// First output frame (from `from`) equal to the track at frame f0 + i, within tol.
int64_t firstTargetFrame(const std::vector<float>& out, size_t from, const TrackBuffer& tb, int64_t f0, double tol) {
  for (size_t i = from; i + 64 < out.size(); i++) {
    bool ok = true;
    for (size_t k = 0; k < 64 && ok; k++) {
      ok = std::fabs(static_cast<double>(out[i + k]) - decktest::trackL(tb, f0 + static_cast<int64_t>(i - from + k))) <= tol;
    }
    if (ok) return static_cast<int64_t>(i - from);
  }
  return -1;
}

}  // namespace

// Play / hot cue / seek with at = now: the target audio is the FIRST frame of
// the block the command is applied in (no scheduling lead, no WSOLA delay).
OM_TEST(perf_deck_command_to_first_target_sample) {
  const double fs = 48000;
  auto tb = decktest::musicTrack(20.0);
  for (int keylock = 0; keylock < 2; keylock++) {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(keylock != 0);  // tempo 1: ratio 1, the transposed output is the track itself
    Rig rig;
    rig.render(d, 4800, 256);
    // PLAY from stop at 4.0 s
    d.seek(4.0, 0, rig.now());
    size_t from = rig.outL.size();
    d.play(rig.presentAt(rig.frame), rig.clock(256));
    rig.render(d, 4800, 256);
    const int64_t playLat = firstTargetFrame(rig.outL, from, *tb, 192000, keylock ? 2e-6 : 0.0);
    om_deck_state s;
    d.snapshot(s, rig.presentAt(rig.frame));
    const double playAnchor = s.anchor_t - rig.presentAt(static_cast<int64_t>(from));
    // HOT CUE while playing to 9.0 s (at = now): the 5 ms crossfade starts on
    // the first frame of the block; the target alone from frame 240 on
    from = rig.outL.size();
    d.seek(9.0, rig.presentAt(rig.frame), rig.clock(256));
    d.snapshot(s, rig.presentAt(rig.frame));
    const double cueAnchor = s.anchor_t - rig.presentAt(static_cast<int64_t>(from));
    rig.render(d, 4800, 256);
    const int64_t alone = firstTargetFrame(rig.outL, from + 240, *tb, 432000 + 240, keylock ? 2e-6 : 0.0);
    const int64_t cueLat = alone < 0 ? -1 : 240 + alone;
    OM_CHECK(std::fabs(cueAnchor) < 1e-9);
    std::printf("    keylock %d: PLAY -> target audio at frame %lld of the block (anchor %+.3f ms); "
                "HOT CUE -> crossfade from frame 0, target alone from frame %lld (5 ms fade)\n",
                keylock, static_cast<long long>(playLat), playAnchor * 1000, static_cast<long long>(cueLat));
    OM_CHECK(playLat == 0);
    OM_CHECK(std::fabs(playAnchor) < 1e-9);
    OM_CHECK(cueLat == 240);
  }
}

// 4 simultaneous primes (4 keylocked decks jump in one block) vs a 128-frame period.
OM_TEST(perf_deck_four_primes_cost) {
  const double fs = 48000;
  const double period = 128 / fs * 1e6;  // us
  auto tb = decktest::musicTrack(30.0);
  std::vector<std::unique_ptr<Deck>> decks;
  Rig rig;
  rig.rtCheck = true;
  for (int k = 0; k < 4; k++) {
    decks.push_back(std::make_unique<Deck>(k));
    Deck& d = *decks.back();
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.setKeylock(true);
    d.setTempo(1.0 + 0.031 * (k + 1));  // ratios != 1: the search runs
    d.seek(1.0 + k, 0, rig.now());
    d.play(0, rig.now());
  }
  std::vector<float> l(128), r(128);
  for (int i = 0; i < 200; i++) {  // the ratios converge, the decks run
    const BlockClock c = rig.clock(128);
    for (auto& d : decks) d->render(l.data(), r.data(), 128, c);
    rig.frame += 128;
  }
  Stats prime4, block4, wsPrime;
  for (int it = 0; it < 60; it++) {
    const BlockClock c = rig.clock(128);
    double t0, t1, t2;
    {
      rt::Scope rts;
      t0 = nowUs();
      for (int k = 0; k < 4; k++) decks[static_cast<size_t>(k)]->seek(2.0 + ((it * 7 + k * 3) % 20), 0, c);
      t1 = nowUs();
      for (auto& d : decks) d->render(l.data(), r.data(), 128, c);
      t2 = nowUs();
    }
    rig.frame += 128;
    prime4.add(t1 - t0);
    block4.add(t2 - t1);
    for (int i = 0; i < 3; i++) {  // a few normal blocks between the jumps
      const BlockClock c2 = rig.clock(128);
      for (auto& d : decks) d->render(l.data(), r.data(), 128, c2);
      rig.frame += 128;
    }
  }
  // Wsola::prime alone
  auto ws = std::make_unique<Wsola>();
  std::vector<float> hl(Wsola::kPrimeFrames), hr(Wsola::kPrimeFrames);
  for (int i = 0; i < Wsola::kPrimeFrames; i++) {
    hl[static_cast<size_t>(i)] = decktest::trackL(*tb, 100000 + i);
    hr[static_cast<size_t>(i)] = decktest::trackR(*tb, 100000 + i);
  }
  for (int it = 0; it < 60; it++) {
    double t0, t1;
    {
      rt::Scope rts;
      t0 = nowUs();
      ws->prime(hl.data(), hr.data(), 0.93);
      t1 = nowUs();
    }
    wsPrime.add(t1 - t0);
  }
  const double med = prime4.median();
  std::printf("    4 primes (deck seeks, history read + Wsola::prime): median %.1f us, min %.1f, max %.1f = %.1f %% of a "
              "128-frame period (%.0f us); the block after them (4 decks, crossfades): median %.1f us; "
              "Wsola::prime alone: median %.1f us [%s build]\n",
              med, prime4.min, prime4.max, 100 * med / period, period, block4.median(), wsPrime.median(),
              kOptimized ? "optimized" : "debug");
  if (kOptimized) {
    OM_CHECK(med < 0.25 * period);
  } else {
    OM_CHECK(med < 4.0 * period);  // sanity only: unoptimized code
  }
}

// CPU per 128-frame block per deck.
OM_TEST(perf_deck_cpu_per_block) {
  const double fs = 48000;
  const double period = 128 / fs * 1e6;
  auto tb = decktest::musicTrack(30.0);
  auto stemA = decktest::musicTrack(30.0, 48000, PcmFormat::S16, 5);
  auto stemB = decktest::musicTrack(30.0, 48000, PcmFormat::S16, 6);
  auto stemC = decktest::musicTrack(30.0, 48000, PcmFormat::S16, 7);
  StemSet set;
  set.stems[0] = stemA.get();
  set.stems[1] = stemB.get();
  set.stems[2] = stemC.get();
  BeatGrid g;
  g.bpm = 124;
  g.beatOffset = 0.01;
  struct Mode {
    const char* name;
    double tempo;
    bool keylock, roll, stems;
  } modes[] = {{"direct, tempo 1.00", 1.0, false, false, false},
               {"direct, tempo 1.07", 1.07, false, false, false},
               {"keylock, tempo 1.07", 1.07, true, false, false},
               {"keylock + roll + 3 stems", 1.07, true, true, true}};
  for (const Mode& m : modes) {
    Deck d(0);
    d.prepare(fs, kMaxBlockFrames);
    d.attachTrack(tb.get());
    d.attachGrid(&g);
    d.attachStems(&set);
    d.setTempo(m.tempo);
    d.setKeylock(m.keylock);
    Rig rig;
    d.seek(3.0, 0, rig.now());
    d.play(0, rig.now());
    if (m.stems) d.setStemsOn(true);
    std::vector<float> l(128), r(128);
    for (int i = 0; i < 100; i++) {
      const BlockClock c = rig.clock(128);
      d.render(l.data(), r.data(), 128, c);
      rig.frame += 128;
    }
    if (m.roll) OM_CHECK(d.startRoll(0.5, 0.7));
    Stats st;
    for (int i = 0; i < 2000; i++) {
      const BlockClock c = rig.clock(128);
      double t0, t1;
      {
        rt::Scope rts;
        t0 = nowUs();
        d.render(l.data(), r.data(), 128, c);
        t1 = nowUs();
      }
      st.add(t1 - t0);
      rig.frame += 128;
    }
    std::printf("    %-26s %.2f us / 128 frames (median; mean %.2f, max %.1f) = %.2f %% of the period [%s]\n", m.name,
                st.median(), st.mean(), st.max, 100 * st.median() / period, kOptimized ? "optimized" : "debug");
    OM_CHECK(st.median() < period);  // even unoptimized, one deck stays far below real time
  }
}
