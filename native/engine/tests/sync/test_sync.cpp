// Tests of the sync module (owner: sync) against FAKE decks (IDeckControl),
// so the sync logic is developed without the real deck: flags, master
// fields, sync.base writes, loadTrack resets, defaults; then every engine.js
// rule ported verbatim — auto-master and bass handover, sync() ratio /
// octave folding / bar alignment, snapToRef and reanchor magnets, the
// continuous lock (repair, stopped SYNC deck, follow-master, flash
// calibration windows / limits / cap / passes / tries / validity, error
// low-pass converted per block, dead zone, servo limits and gains, jogHold),
// handover without jumps, ROLL priorities, FX and deck beat clocks,
// nextBoundaryAt — every tick inside om::rt::Scope and every duration
// checked on the SAMPLE clock while presentTime jitters; then each native
// precision refinement against its engine.js behaviour. The 10-minute
// replays are in test_sync_replay.cpp, the tick-by-tick comparison with the
// real engine.js in test_sync_js_xcheck.cpp. SPEC.md §12, §18.
#include <cmath>

#include "../om_test.h"
#include "om/rt.h"
#include "om/sync.h"
#include "sync_sim.h"

using namespace om;
using namespace synctest;

namespace {
// A deck that plays a grid at a tempo, advanced by hand.
struct FakeDeck final : IDeckControl {
  bool isLoaded = true, isPlaying = false, wsola = false;
  double dur = 300, pos = 0, tmp = 1.0;
  SampleTime ended = kNaN;
  const BeatGrid* g = nullptr;
  double rollBeats = 0;
  bool loaded() const noexcept override { return isLoaded; }
  bool playing() const noexcept override { return isPlaying; }
  double duration() const noexcept override { return dur; }
  double heardPosition() const noexcept override { return pos; }
  bool transportSettled() const noexcept override { return true; }
  double tempo() const noexcept override { return tmp; }
  void setTempo(double r) noexcept override { tmp = clampv(r, kTempoMin, kTempoMax); }
  void seekHeard(double t) noexcept override { pos = t; }
  bool routedThroughWsola() const noexcept override { return wsola; }
  const BeatGrid* grid() const noexcept override { return g; }
  SampleTime endedAtSample() const noexcept override { return ended; }
  bool startRoll(double beats, double) noexcept override {
    rollBeats = beats;
    return true;
  }
  void setRollMix(double) noexcept override {}
  void stopRoll(bool) noexcept override { rollBeats = 0; }
  bool rolling(double* beats) const noexcept override {
    if (beats) *beats = rollBeats;
    return rollBeats > 0;
  }
  void advance(double seconds) {
    if (isPlaying) pos += seconds * tmp;
  }
};

// Steps until `pred` holds (at most maxBlocks); returns the number of blocks.
template <class Pred>
int stepUntil(Rig& r, Pred pred, int maxBlocks) {
  int n = 0;
  while (!pred() && n < maxBlocks) {
    r.step();
    n++;
  }
  return n;
}
}  // namespace

OM_TEST(sync_flags_and_master_fields) {
  FakeDeck fakes[kNumDecks];
  IDeckControl* ptrs[kNumDecks] = {&fakes[0], &fakes[1], &fakes[2], &fakes[3]};
  SyncEngine s;
  s.attachDecks(ptrs);
  OM_CHECK(s.masterIdx() == -1 && s.autoMasterIdx() == -1 && s.effectiveMaster() == -1);
  s.setManualMaster(2);
  OM_CHECK(s.masterIdx() == 2 && s.effectiveMaster() == 2);
  s.setManualMaster(7);  // out of range = automatic
  OM_CHECK(s.masterIdx() == -1);
  s.setSynced(1, true);
  OM_CHECK(s.synced(1));
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kPllCorr;
  w.base = 1.02;
  w.pllCorr = 0.001;
  s.writeSyncBase(1, w);
  om_sync_state st;
  s.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], 1.02, 0);
  OM_CHECK_NEAR(st.pll_corr[1], 0.001, 0);
  OM_CHECK(std::isnan(st.sync_ref[1]));
  s.onTrackLoaded(1);  // engine.js loadTrack: blank ratio, SYNC stays on
  s.snapshot(st);
  OM_CHECK(std::isnan(st.sync_base[1]) && st.pll_corr[1] == 0 && st.synced[1] == 1);
  s.setManualMaster(0);
  s.resetToDefaults();  // hello {reset}
  s.snapshot(st);
  OM_CHECK(st.master_idx == -1 && st.synced[1] == 0);
}

// The owner's decision of 2026-11-09 (SPEC.md §12, Appendix E.9): the native
// precision mode is the default; sync.precision {on:false} still selects the
// engine.js parity mode, and hello {reset} (resetToDefaults) keeps whichever
// mode is set.
OM_TEST(sync_precision_is_the_default_and_survives_reset) {
  FakeDeck fakes[kNumDecks];
  IDeckControl* ptrs[kNumDecks] = {&fakes[0], &fakes[1], &fakes[2], &fakes[3]};
  SyncEngine s;
  s.attachDecks(ptrs);
  OM_CHECK(s.nativePrecision());  // default ON
  s.resetToDefaults();
  OM_CHECK(s.nativePrecision());  // the default survives hello {reset}
  s.setNativePrecision(false);    // engine.js parity on request
  OM_CHECK(!s.nativePrecision());
  s.resetToDefaults();
  OM_CHECK(!s.nativePrecision());  // ... and so does the parity choice
  s.setNativePrecision(true);
  OM_CHECK(s.nativePrecision());
  // the test rig of this file runs parity explicitly (sync_sim.h)
  Rig r;
  OM_CHECK(!r.sync.nativePrecision());
}

OM_TEST(sync_tick_is_allocation_free) {
  FakeDeck fakes[kNumDecks];
  IDeckControl* ptrs[kNumDecks] = {&fakes[0], &fakes[1], &fakes[2], &fakes[3]};
  SyncEngine s;
  s.attachDecks(ptrs);
  BlockClock clk;
  clk.frames = 256;
  MixView mv;
  FxRackView fv;
  rt::Scope rts;
  for (int i = 0; i < 100; i++) {
    clk.sampleTime += 256 / 48000.0;
    s.tick(clk, mv, fv);
    (void)s.deckBeatClock(i % kNumDecks);
  }
}

// ---------------------------------------------------------------------------
// _updateAutoMaster / _pickBassDeck / getMasterDeck
// ---------------------------------------------------------------------------
OM_TEST(sync_auto_master_first_started_grace_and_ended) {
  Rig r;
  r.presentJitter = 0.04;  // +-40 ms of presentTime / callbackTime jitter: every duration is on sampleTime
  const Track a = makeFixedTrack(128, 0.0, 300), b = makeFixedTrack(125, 0.0, 300), c = makeFixedTrack(124, 0.0, 300);
  r.load(0, a);
  r.load(1, b);
  r.load(2, c);
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == -1 && r.sync.effectiveMaster() == -1);
  // the FIRST sound started becomes the master
  r.play(1);
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 1);
  r.run(0.5);
  r.play(0);  // same bass score, lower index: it does NOT take over while 1 plays
  r.run(0.5);
  OM_CHECK(r.sync.autoMasterIdx() == 1);

  // a CUT keeps the crown exactly 1.2 s of SAMPLE time
  r.deck[1].pause();
  r.step();  // the stop is seen by this tick
  const SampleTime seen = r.now() - r.h();
  stepUntil(r, [&] { return r.sync.autoMasterIdx() != 1; }, 2000);
  const SampleTime switched = r.now() - r.h();
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  OM_CHECK(switched - seen >= kGraceForTests - 1e-9 && switched - seen < kGraceForTests + r.h() + 1e-9);

  // shorter cuts change nothing, and the grace restarts from scratch at each cut
  r.deck[0].pause();
  r.run(0.9);
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  r.play(0);
  r.run(0.2);
  r.deck[0].pause();
  r.run(0.9);
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  r.play(0);
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 0);

  // a NATURAL end (< 2 s ago on the sample clock) hands over at once
  r.play(1);
  r.deck[0].pos = r.deck[0].dur - 0.0005;
  r.step();  // deck 0 ends while rendering this block
  OM_CHECK(!r.deck[0].isPlaying && isSet(r.deck[0].ended));
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 1);

  // an "end" more than 2 s ago is a cut: the grace applies
  r.deck[0].load(&a.grid, a.dur, 10.0);
  r.play(0);
  r.run(0.3);
  OM_CHECK(r.sync.autoMasterIdx() == 1);
  r.deck[1].ended = r.now() - 2.01;
  r.deck[1].pause();
  r.run(1.0);
  OM_CHECK(r.sync.autoMasterIdx() == 1);
  r.run(0.3);
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  // ...and 1.99 s ago is a natural end
  r.play(1);
  r.run(0.2);
  r.deck[0].ended = r.now() - 1.99;
  r.deck[0].pause();
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 1);
  // nothing playing: no master at all (after the grace)
  r.deck[1].pause();
  r.run(1.3);
  OM_CHECK(r.sync.autoMasterIdx() == -1);
}

OM_TEST(sync_auto_master_bass_rule_and_manual_master) {
  Rig r;
  r.presentJitter = 0.02;
  const Track t[4] = {makeFixedTrack(128, 0, 300), makeFixedTrack(126, 0, 300), makeFixedTrack(127, 0, 300),
                      makeFixedTrack(125, 0, 300)};
  for (int d = 0; d < kNumDecks; d++) r.load(d, t[d]);
  // the bass deck: open bass first (x10 + 1 + eq.low), then the most heard (volume x side gain)
  r.mix.eqLow[0] = -1.0f;  // killed
  r.mix.eqLow[2] = 0.0f;
  r.mix.volume[2] = 0.3f;  // 10 + 1 + 0.3 = 11.3
  r.mix.eqLow[3] = -0.5f;
  r.mix.volume[3] = 1.0f;  // 10 + 0.5 + 1.0 = 11.5
  r.play(0);
  r.play(2);
  r.play(3);
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 3);
  // the master stops: among 0 (0.85) and 2 (11.3), the open bass wins
  r.deck[3].pause();
  r.run(1.25);
  OM_CHECK(r.sync.autoMasterIdx() == 2);
  // crossfader on side A: deck 3 (side B) is not heard (10.5 + 0); and eq.low
  // exactly -0.9 is NOT open: deck 3 then scores 0 < deck 0's 0.85
  r.mix.xfGain[1] = 0.0f;
  r.mix.xfGain[3] = 0.0f;
  r.mix.eqLow[3] = -0.9f;
  r.play(3);
  r.deck[2].pause();
  r.run(1.25);
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  r.play(2);
  r.mix.eqLow[3] = -0.5f;
  r.mix.xfGain[3] = 1.0f;
  r.run(0.1);
  OM_CHECK(r.sync.autoMasterIdx() == 0);  // stays while it plays

  // MANUAL master stopped while others play: handed to the bass deck after 1.2 s
  r.sync.setManualMaster(2);
  r.run(0.1);
  r.deck[2].pause();
  r.step();
  const SampleTime seen = r.now() - r.h();
  stepUntil(r, [&] { return r.sync.masterIdx() != 2; }, 2000);
  OM_CHECK(r.now() - r.h() - seen >= kGraceForTests - 1e-9 && r.now() - r.h() - seen < kGraceForTests + r.h() + 1e-9);
  OM_CHECK(r.sync.masterIdx() == 3 && r.sync.autoMasterIdx() == 3);  // 11.5 beats deck 0 (0.85)
  // manual master stopped with NOBODY else playing: it stays
  r.sync.setManualMaster(1);
  r.deck[0].pause();
  r.deck[3].pause();
  r.run(3.0);
  OM_CHECK(r.sync.masterIdx() == 1);
  // manual master at its natural end: immediate handover
  r.play(1);
  r.play(0);
  r.run(0.1);
  r.deck[1].pos = r.deck[1].dur - 0.001;
  r.step();
  r.step();
  OM_CHECK(r.sync.masterIdx() == 0 && r.sync.autoMasterIdx() == 0);
}

OM_TEST(sync_get_master_deck_fallbacks) {
  Rig r;
  const Track t = makeFixedTrack(128, 0, 300), u = makeFixedTrack(125, 0, 300);
  r.load(1, t);
  r.load(2, u);
  r.load(3, t);
  r.deck[1].isPlaying = true;
  r.deck[2].isPlaying = true;
  r.sync.setSynced(1, true);
  // no master elected: a NON-SYNCED playing deck first, then any playing deck
  OM_CHECK(r.sync.masterDeckFor(-1) == 2);
  OM_CHECK(r.sync.masterDeckFor(2) == 1);
  OM_CHECK(r.sync.masterDeckFor(1) == 2);
  // a manual master with a BPM wins even when stopped (engine.js checks only m.bpm)
  r.sync.setManualMaster(3);
  OM_CHECK(r.sync.masterDeckFor(-1) == 3);
  OM_CHECK(r.sync.masterDeckFor(3) == 2);
  // ...but not without a BPM
  r.deck[3].g = nullptr;
  OM_CHECK(r.sync.masterDeckFor(-1) == 2);
  r.sync.setManualMaster(-1);
  // the auto master counts only while it plays
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 1 || r.sync.autoMasterIdx() == 2);
  const int am = r.sync.autoMasterIdx();
  OM_CHECK(r.sync.masterDeckFor(-1) == am);
}

// ---------------------------------------------------------------------------
// sync(), snapToRef(), reanchorSync()
// ---------------------------------------------------------------------------
OM_TEST(sync_do_ratio_and_bar_alignment_dynamic) {
  Rig r;
  const Track m = makeDynamicTrack(128, 0.05, 300, 128, 0.0, 1);
  const Track f = makeDynamicTrack(125, 0.02, 300, 125, 0.0, 2, /*barAnchor*/ 1);
  r.load(0, m);
  r.load(1, f, 30.123);
  r.play(0);
  r.play(1);
  r.run(1.0);
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  const int seeks = r.deck[1].seeks;
  bool ok;
  {
    ok = r.doSync(1);
  }
  OM_CHECK(ok);
  // ratio from the LOCAL periods (+-8 beats), master tempo 1
  OM_CHECK_NEAR(r.deck[1].tmp, (60.0 / 125) / (60.0 / 128), 1e-12);
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK(st.synced[1] == 1 && st.calibrated[1] == 0);
  OM_CHECK(st.sync_base[1] == r.deck[1].tmp && st.sync_ref[1] == r.deck[1].tmp);
  // bars aligned through beat indexes (bar anchors 0 and 1)
  OM_CHECK(r.deck[1].seeks == seeks + 1);
  OM_CHECK_NEAR(wrapHalf(r.barPhaseOf(0) - r.barPhaseOf(1)), 0.0, 1e-9);
  const SyncDeckDiag dg = r.sync.diag(1);
  OM_CHECK(dg.ratioPasses == 1);  // both grids dynamic: straight to the fine stage
  OM_CHECK(dg.ratioTries == 0 && dg.errFilt == 0 && std::isnan(dg.lastWant) && dg.phaseOffset == 0 && !dg.measuring);
  OM_CHECK(!dg.phaseFree);
  // then the lock holds it
  r.run(3.0);
  OM_CHECK(std::fabs(r.sync.diag(1).lastErr) < 1e-6);
}

OM_TEST(sync_do_octave_folding_and_master_base) {
  struct Case {
    double mBpm, dBpm, expect;
  } cases[] = {
      {174, 87, 1.0},          // 2.0 -> folded to 1.0 (never the double)
      {70, 140, 0.5},          // 0.5 stays
      {65, 140, 65.0 / 70.0},  // 0.464 -> x2
      {100, 60, 100.0 / 120},  // 1.667 -> /2
      {128, 125, 1.024},
  };
  for (const Case& k : cases) {
    Rig r;
    const Track m = makeFixedTrack(k.mBpm, 0.0, 300), d = makeFixedTrack(k.dBpm, 0.0, 300);
    r.load(0, m);
    r.load(1, d, 12.0);
    r.deck[0].isPlaying = true;
    r.deck[0].pos = 20.0;
    OM_CHECK(r.doSync(1));
    OM_CHECK_NEAR(r.deck[1].tmp, k.expect, 1e-12);
  }
  // the master's servo correction is removed from the target (mBase = tempo / (1 + pllCorr))
  Rig r;
  const Track m = makeFixedTrack(128, 0.0, 300), d = makeFixedTrack(125, 0.0, 300);
  r.load(0, m);
  r.load(1, d);
  r.deck[0].isPlaying = true;
  r.deck[0].tmp = 1.02 * 1.0015;
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kPllCorr;
  w.pllCorr = 0.0015;
  r.sync.writeSyncBase(0, w);
  OM_CHECK(r.doSync(1));
  OM_CHECK_NEAR(r.deck[1].tmp, 1.02 * 128 / 125, 1e-12);
  // no BPM, or no reference: refused, nothing touched
  Rig r2;
  r2.load(0, m);
  r2.load(1, d);
  r2.deck[1].g = nullptr;
  r2.deck[0].isPlaying = true;
  OM_CHECK(!r2.doSync(1));
  OM_CHECK(!r2.sync.synced(1));
  r2.deck[1].g = &d.grid;
  r2.deck[0].isPlaying = false;
  OM_CHECK(!r2.doSync(1));  // nothing plays: no reference
  OM_CHECK(r2.deck[1].tmp == 1.0);
}

OM_TEST(sync_do_bar_alignment_fixed_grid_and_local_period) {
  // fixed grids, 120 BPM: beat 0.5 s, bar 2 s
  Rig r;
  const Track m = makeFixedTrack(120, 0.1, 300), d = makeFixedTrack(120, 0.3, 300);
  r.load(0, m);
  r.load(1, d);
  r.deck[0].isPlaying = true;
  r.deck[0].pos = 0.1 + 2 * 5.1;   // bar phase 0.1
  r.deck[1].pos = 0.3 + 2 * 5.75;  // bar phase 0.75: err = -0.65 -> +0.35 bar (the shortest way)
  OM_CHECK(r.doSync(1));
  OM_CHECK_NEAR(r.deck[1].pos, 0.3 + 2 * 5.75 + 0.35 * 4 * 0.5, 1e-9);
  OM_CHECK_NEAR(wrapHalf(r.barPhaseOf(0) - r.barPhaseOf(1)), 0.0, 1e-9);
  OM_CHECK(r.sync.diag(1).ratioPasses == 0);  // fixed grids: coarse stage first

  // dynamic grid whose tempo changes: the ratio uses the AVERAGE over +-8 beats around the heard position
  Track v;
  v.trueP = 0.5;
  v.dur = 300;
  v.grid.bpm = 120;
  v.grid.beatOffset = 0;
  double t = 0;
  for (int k = 0; k < 200; k++) {
    v.grid.beats.push_back(t);
    t += k < 50 ? 0.5 : 0.45;
  }
  Rig r2;
  const Track mm = makeDynamicTrack(128, 0.0, 300, 128, 0.0, 9);
  r2.load(0, mm);
  r2.load(1, v);
  r2.deck[0].isPlaying = true;
  r2.deck[0].pos = 50.0;
  for (double at : {10.0, 24.0, 40.0}) {
    r2.deck[1].pos = at;
    r2.deck[1].tmp = 1.0;
    const double lp = grid::localPeriod(v.grid, at, 0.0);
    OM_CHECK(r2.doSync(1));
    OM_CHECK_NEAR(r2.deck[1].tmp, foldForTests(lp / (60.0 / 128)), 1e-12);
  }
  OM_CHECK(r2.sync.diag(1).ratioPasses == 1);
}

OM_TEST(sync_snap_to_ref_magnet) {
  Rig r;
  const Track m = makeFixedTrack(120, 0.0, 300), d = makeFixedTrack(120, 0.0, 300);
  r.load(0, m);
  r.load(1, d);
  r.load(2, m);
  r.deck[0].isPlaying = true;
  r.deck[0].pos = 10.0;  // beat phase 0
  // released 0.05 beat late: finished onto the line
  r.deck[1].pos = 20.0 + 0.05 * 0.5;
  OM_CHECK(r.snap(1));
  OM_CHECK_NEAR(r.deck[1].pos, 20.0, 1e-12);
  // 0.07 beat away: a deliberate placement, untouched (unless the magnet is wider)
  r.deck[1].pos = 20.0 - 0.07 * 0.5;
  OM_CHECK(!r.snap(1));
  OM_CHECK_NEAR(r.deck[1].pos, 20.0 - 0.035, 1e-12);
  OM_CHECK(r.snap(1, 0.1));
  OM_CHECK_NEAR(r.deck[1].pos, 20.0, 1e-12);
  // NaN magnet = engine.js default 0.06
  r.deck[1].pos = 20.0 + 0.055 * 0.5;
  OM_CHECK(r.snap(1, kNaN));
  OM_CHECK_NEAR(r.deck[1].pos, 20.0, 1e-12);
  // the MANUAL master is preferred when it plays
  r.deck[2].isPlaying = true;
  r.deck[2].pos = 30.0 + 0.02 * 0.5;  // phase 0.02
  r.sync.setManualMaster(2);
  r.deck[1].pos = 20.0;
  OM_CHECK(r.snap(1));
  OM_CHECK_NEAR(r.deck[1].pos, 20.0 + 0.01, 1e-12);
  // nobody else playing: nothing to snap to
  r.sync.setManualMaster(-1);
  r.deck[0].isPlaying = false;
  r.deck[2].isPlaying = false;
  r.deck[1].pos = 20.01;
  OM_CHECK(!r.snap(1));
  // no grid on the deck itself
  r.deck[0].isPlaying = true;
  r.deck[1].g = nullptr;
  OM_CHECK(!r.snap(1));
}

OM_TEST(sync_reanchor_magnet_and_offset_hold) {
  Rig r;
  const Track m = makeDynamicTrack(128, 0.0, 400, 128, 0.0, 3), d = makeDynamicTrack(125, 0.0, 400, 125, 0.0, 4);
  r.load(0, m);
  r.load(1, d, 40.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  r.run(12.0);  // calibrated
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[1] == 1);
  // nudged 0.02 beat: the magnet makes it EXACT
  r.deck[1].pos += 0.02 * 0.48;
  r.reanchor(1);
  SyncDeckDiag dg = r.sync.diag(1);
  OM_CHECK(dg.phaseOffset == 0 && dg.phaseFree && dg.errFilt == 0 && !dg.measuring);
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[1] == 1);  // the calibration acquired is kept
  // a deliberate 0.1 beat offset is RESPECTED and then held
  r.deck[1].pos += 0.08 * 0.48;  // 0.1 beat ahead in total
  r.reanchor(1);
  dg = r.sync.diag(1);
  OM_CHECK_NEAR(dg.phaseOffset, -0.1, 1e-6);
  r.run(20.0);
  OM_CHECK_NEAR(wrapHalf(r.beatPhaseOf(0) - r.beatPhaseOf(1)), -0.1, 0.0015);
  // the master is never anchored against a slave; an unsynced deck is ignored
  r.reanchor(0);
  OM_CHECK(!r.sync.diag(0).phaseFree);
  r.sync.setSynced(1, false);
  r.deck[1].pos += 0.01;
  r.reanchor(1);
  OM_CHECK_NEAR(r.sync.diag(1).phaseOffset, -0.1, 1e-6);
}

// ---------------------------------------------------------------------------
// syncLock: flash calibration
// ---------------------------------------------------------------------------
OM_TEST(sync_lock_calibration_two_stages_on_sample_clock) {
  Rig r;
  r.presentJitter = 0.02;  // the windows are measured on sampleTime only
  const Track m = makeFixedTrack(128, 0.0, 600), d = makeFixedTrack(125, 0.0, 600);
  r.load(0, m);
  r.load(1, d, 33.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  OM_CHECK_NEAR(r.deck[1].tmp, 1.024, 1e-12);
  OM_CHECK(r.sync.diag(1).ratioPasses == 0);
  // a ratio 0.5 % off (what a rounded BPM does): the flash calibration fixes it
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kRef;
  w.base = w.ref = 1.024 * 1.005;
  r.sync.writeSyncBase(1, w);
  r.step();
  SyncDeckDiag dg = r.sync.diag(1);
  OM_CHECK(dg.measuring && dg.ratioTries == 1);
  const SampleTime w1 = dg.measStart;
  OM_CHECK_NEAR(w1, r.now() - r.h(), 1e-12);
  // stage 1: a 1 s window
  stepUntil(r, [&] { return r.sync.diag(1).ratioPasses == 1; }, 1000);
  const SampleTime closed1 = r.now() - r.h();
  OM_CHECK(closed1 - w1 >= 1.0 - 1e-9 && closed1 - w1 < 1.0 + r.h() + 1e-9);
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[1] == 0);
  OM_CHECK(std::fabs(st.sync_base[1] / 1.024 - 1) < 2e-5);  // one correction, within +-1 %
  OM_CHECK(st.sync_ref[1] == st.sync_base[1]);
  // stage 2: an 8 s window, opened at the next block
  r.step();
  dg = r.sync.diag(1);
  OM_CHECK(dg.measuring && dg.ratioTries == 2);
  const SampleTime w2 = dg.measStart;
  stepUntil(r, [&] { return r.sync.diag(1).ratioPasses == 2; }, 10000);
  const SampleTime closed2 = r.now() - r.h();
  OM_CHECK(closed2 - w2 >= 8.0 - 1e-9 && closed2 - w2 < 8.0 + r.h() + 1e-9);
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[1] == 1);  // the correction became negligible (< 0.02 %)
  OM_CHECK(std::fabs(st.sync_base[1] / 1.024 - 1) < 2e-6);
  // calibrated: no window any more, phase held in the dead zone
  r.run(10.0);
  OM_CHECK(!r.sync.diag(1).measuring);
  OM_CHECK(std::fabs(r.sync.diag(1).lastErr) < 0.0015);
}

OM_TEST(sync_lock_calibration_limits_and_adoption_back_to_stage1) {
  Rig r;
  const Track m = makeFixedTrack(128, 0.0, 900), d = makeFixedTrack(125, 0.0, 900);
  r.load(0, m);
  r.load(1, d, 20.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  const double b0 = 1.024 * 1.03;  // 3 % off (below the 6 % repair)
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kRef;
  w.base = w.ref = b0;
  r.sync.writeSyncBase(1, w);
  // stage 1 can only correct 1 % per pass
  stepUntil(r, [&] { return r.sync.diag(1).ratioPasses == 1; }, 1000);
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], b0 * 0.99, 1e-12);
  // stage 2 then drifts beyond 0.08 beat: the alignment is ADOPTED and the
  // calibration goes back through the coarse stage (passes = 0)
  int blocks = stepUntil(r, [&] { return r.sync.diag(1).ratioPasses == 0; }, 20000);
  OM_CHECK(blocks < 20000);
  OM_CHECK(std::fabs(wrapHalf(r.sync.diag(1).phaseOffset)) > 0.07);
  // and it converges anyway
  stepUntil(r, [&] {
    om_sync_state s2;
    r.sync.snapshot(s2);
    return s2.calibrated[1] != 0;
  }, 200000);
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[1] == 1);
  OM_CHECK(std::fabs(st.sync_base[1] / 1.024 - 1) < 1e-4);
  OM_CHECK(r.sync.diag(1).ratioTries <= 12);
}

OM_TEST(sync_lock_calibration_fine_stage_limit_and_four_passes) {
  // dynamic grids: straight to the 8 s stage, +-0.1 % per pass, done after 4 passes
  Rig r;
  const Track m = makeDynamicTrack(128, 0.0, 900, 128, 0.0, 5), d = makeDynamicTrack(125, 0.0, 900, 125, 0.0, 6);
  r.load(0, m);
  r.load(1, d, 20.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  const double ratio = r.deck[1].tmp;
  const double b0 = ratio * 1.0035;
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kRef;
  w.base = w.ref = b0;
  r.sync.writeSyncBase(1, w);
  om_sync_state st;
  double expect = b0;
  for (int pass = 2; pass <= 4; pass++) {
    stepUntil(r, [&] { return r.sync.diag(1).ratioPasses == pass; }, 20000);
    OM_CHECK(r.sync.diag(1).ratioPasses == pass);
    expect *= 0.999;  // clamped at -0.1 %
    r.sync.snapshot(st);
    OM_CHECK_NEAR(st.sync_base[1], expect, 1e-12);
    OM_CHECK(st.calibrated[1] == (pass == 4 ? 1 : 0));
  }
  // done by the pass count with a 0.05 % residue the servo holds (gain 0.08)
  OM_CHECK(std::fabs(st.sync_base[1] / ratio - 1) > 0.0004);
}

OM_TEST(sync_lock_calibration_cap_two_percent) {
  // the follower's grid says 127.66 BPM but its BPM field says 125: the
  // calibrated ratio may not leave +-2 % of the BPM-field target
  Rig r;
  const Track m = makeDynamicTrack(128, 0.0, 600, 128, 0.0, 7), d = makeDynamicTrack(60.0 / 0.47, 0.0, 600, 125, 0.0, 8);
  r.load(0, m);
  r.load(1, d, 20.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  OM_CHECK_NEAR(r.deck[1].tmp, 0.47 / (60.0 / 128), 1e-9);
  stepUntil(r, [&] { return r.sync.diag(1).ratioPasses == 2; }, 10000);
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], (128.0 / 125.0) * 0.98, 1e-12);
  OM_CHECK(st.calibrated[1] == 1);
  OM_CHECK_NEAR(r.sync.diag(1).syncWant, 128.0 / 125.0, 1e-12);
}

OM_TEST(sync_lock_calibration_tries_timeout_validity) {
  // every window corrupted by a 4-beat jump of the master (phase unchanged):
  // discarded each time; after 12 tries the calibration gives up
  {
    Rig r;
    const Track m = makeFixedTrack(128, 0.0, 900), d = makeFixedTrack(125, 0.0, 900);
    r.load(0, m);
    r.load(1, d, 20.0);
    r.play(0);
    r.play(1);
    r.run(0.5);
    OM_CHECK(r.doSync(1));
    const double base = r.deck[1].tmp;
    SampleTime nextJump = r.now() + 0.7;
    om_sync_state st;
    for (int i = 0; i < 60000; i++) {
      if (r.now() >= nextJump) {
        r.deck[0].pos += 4 * 60.0 / 128;
        nextJump += 0.7;
      }
      r.step();
      r.sync.snapshot(st);
      if (st.calibrated[1]) break;
    }
    OM_CHECK(st.calibrated[1] == 1);
    OM_CHECK(r.sync.diag(1).ratioTries == 13);
    OM_CHECK(r.sync.diag(1).ratioPasses == 0);
    OM_CHECK(st.sync_base[1] == base);
  }
  // a window left open by an unsettled transport for longer than duration + 2 s restarts
  {
    Rig r;
    const Track m = makeFixedTrack(128, 0.0, 600), d = makeFixedTrack(125, 0.0, 600);
    r.load(0, m);
    r.load(1, d, 20.0);
    r.play(0);
    r.play(1);
    r.run(0.5);
    OM_CHECK(r.doSync(1));
    r.run(0.3);
    const SyncDeckDiag before = r.sync.diag(1);
    OM_CHECK(before.measuring && before.ratioTries == 1);
    r.deck[0].forceUnsettled = true;  // e.g. the master scratches
    r.run(3.5);
    OM_CHECK(r.sync.diag(1).measStart == before.measStart && r.sync.diag(1).ratioTries == 1);
    r.deck[0].forceUnsettled = false;
    r.step();
    const SyncDeckDiag after = r.sync.diag(1);
    OM_CHECK(after.measuring && after.ratioTries == 2 && after.measStart > before.measStart + 3.0);
    OM_CHECK(after.ratioPasses == 0);
  }
  // VALIDITY: the follower jumps 4 beats during the window: discarded, base untouched
  {
    Rig r;
    const Track m = makeFixedTrack(128, 0.0, 600), d = makeFixedTrack(125, 0.0, 600);
    r.load(0, m);
    r.load(1, d, 20.0);
    r.play(0);
    r.play(1);
    r.run(0.5);
    OM_CHECK(r.doSync(1));
    const double base = r.deck[1].tmp;
    r.run(0.5);
    r.deck[1].pos += 4 * 0.48;
    r.run(0.6);
    const SyncDeckDiag dg = r.sync.diag(1);
    OM_CHECK(dg.ratioPasses == 0 && dg.ratioTries == 2);
    om_sync_state st;
    r.sync.snapshot(st);
    OM_CHECK(st.sync_base[1] == base);
  }
}

// ---------------------------------------------------------------------------
// syncLock: holding servo, low-pass, repair, stopped SYNC deck, follow-master, jogHold
// ---------------------------------------------------------------------------
namespace {
// Two playing decks with FROZEN positions: the phase error stays exactly `e`
// (beats) and the servo output can be checked against engine.js's formula.
struct ServoRig {
  Rig r;
  Track m = makeFixedTrack(120, 0.0, 600);
  Track d = makeFixedTrack(120, 0.0, 600);
  explicit ServoRig(bool wsola, int blockFrames = 128, double rate = kRate) {
    r.blockFrames = blockFrames;
    r.clk.sampleRate = rate;
    r.load(0, m);
    r.load(1, d);
    r.play(0);
    r.play(1);
    r.deck[1].wsola = wsola;
    r.step();
    r.deck[0].frozen = r.deck[1].frozen = true;
    r.deck[0].pos = 10.0 + 0.3 * 0.5;  // beat phase 0.3
    r.deck[1].pos = 20.0 + 0.3 * 0.5;
    OM_CHECK(r.doSync(1));
  }
  void setError(double e) { r.deck[1].pos = 20.0 + (0.3 - e) * 0.5; }  // err = pm - pd = e
};
}  // namespace

OM_TEST(sync_lock_error_low_pass_per_block) {
  // 0.85 / 0.15 per 1/60 s becomes keep = 0.85^(blockSec * 60) per block
  struct Case {
    int frames;
    double rate;
  } cases[] = {{128, 48000}, {160, 48000}, {441, 44100}, {480, 48000}, {2048, 48000}, {800, 48000}};
  for (const Case& c : cases) {
    ServoRig s(false, c.frames, c.rate);
    s.setError(0.01);
    s.r.step();
    const double keep = std::pow(0.85, c.frames / c.rate * 60.0);
    OM_CHECK_NEAR(s.r.sync.diag(1).errFilt, 0.01 * (1 - keep), 1e-13);
    s.r.step();
    OM_CHECK_NEAR(s.r.sync.diag(1).errFilt, 0.01 * (1 - keep * keep), 1e-13);
  }
  // 5 blocks of 160 frames at 48 kHz = 1/60 s: exactly engine.js's single 0.15 step
  ServoRig s(false, 160, 48000);
  s.setError(0.02);
  s.r.step(5);
  OM_CHECK_NEAR(s.r.sync.diag(1).errFilt, 0.02 * 0.15, 1e-12);
  // 800-frame blocks (60 per second): engine.js's recursion step by step
  ServoRig s2(false, 800, 48000);
  s2.setError(0.02);
  double e = 0;
  for (int i = 0; i < 10; i++) {
    s2.r.step();
    e = e * 0.85 + 0.02 * 0.15;
    OM_CHECK_NEAR(s2.r.sync.diag(1).errFilt, e, 1e-12);
  }
}

OM_TEST(sync_lock_servo_dead_zone_limits_gains) {
  struct Case {
    bool wsola;
    double err;
    double corr;  // expected engine.js _pllCorr once the low-pass has converged
  } cases[] = {
      {false, 0.001, 0.0},      // inside the 0.0015 dead zone: total rest
      {false, -0.0014, 0.0},
      {false, 0.01, 0.0008},    // gain 0.08
      {false, -0.02, -0.0016},
      {false, 0.05, 0.002},     // limit 0.2 %
      {false, -0.07, -0.002},
      {true, 0.001, 0.0},
      {true, 0.005, 0.005},     // through the transposer: gain 1.0
      {true, -0.012, -0.012},
      {true, 0.05, 0.015},      // limit 1.5 %
      {true, -0.07, -0.015},
  };
  for (const Case& c : cases) {
    ServoRig s(c.wsola);
    s.setError(c.err);
    s.r.run(3.0);  // the low-pass converges (time constant ~0.1 s)
    om_sync_state st;
    s.r.sync.snapshot(st);
    OM_CHECK_NEAR(s.r.sync.diag(1).errFilt, c.err, 1e-9);
    OM_CHECK_NEAR(st.pll_corr[1], c.corr, 1e-9);
    OM_CHECK_NEAR(s.r.deck[1].tmp, st.sync_base[1] * (1 + st.pll_corr[1]), 1e-15);
    OM_CHECK(st.sync_base[1] == 1.0);  // the base itself is never absorbed
  }
}

OM_TEST(sync_lock_repair_and_stopped_sync_deck) {
  Rig r;
  const Track m = makeFixedTrack(128, 0.0, 600), d = makeFixedTrack(125, 0.0, 600), x = makeFixedTrack(100, 0.0, 600);
  r.load(0, m);
  r.load(1, d, 20.0);
  r.load(2, x);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  r.run(12.0);
  const double want = 1.024;
  // a base 7 % off (BPM changed by hand, grid /2 x2...): REPAIRED at once
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kBase;
  w.base = want * 1.07;
  r.sync.writeSyncBase(1, w);
  r.step();
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK(st.sync_base[1] == want && st.sync_ref[1] == want && st.pll_corr[1] == 0 && st.calibrated[1] == 0);
  SyncDeckDiag dg = r.sync.diag(1);
  OM_CHECK(dg.ratioPasses == 0 && dg.ratioTries == 0 && std::isnan(dg.phaseOffset) && dg.errFilt == 0);
  OM_CHECK(r.deck[1].tmp == want);
  r.step();
  OM_CHECK(isSet(r.sync.diag(1).phaseOffset));  // re-anchored on the present alignment
  // 5.9 % off: no repair (the calibration handles it)
  r.run(12.0);
  w.base = want * 1.059;
  r.sync.writeSyncBase(1, w);
  r.step();
  r.sync.snapshot(st);
  OM_CHECK(st.sync_base[1] != want);
  // a missing base is repaired too
  w.base = kNaN;
  r.sync.writeSyncBase(1, w);
  r.step();
  r.sync.snapshot(st);
  OM_CHECK(st.sync_base[1] == want);

  // a SYNC deck that is STOPPED already takes the master's BPM
  r.tempoCommand(0, 1.02);
  r.sync.setSynced(2, true);
  r.step();
  OM_CHECK_NEAR(r.deck[2].tmp, 128 * 1.02 / 100, 1e-12);
  r.deck[2].g = nullptr;
  Track y = makeFixedTrack(64, 0.0, 600);
  r.deck[2].g = &y.grid;
  r.step();
  OM_CHECK_NEAR(r.deck[2].tmp, 128 * 1.02 / 64 / 2, 1e-12);  // folded, never the double
  OM_CHECK(!r.deck[2].isPlaying && r.deck[2].seeks == 0);
}

OM_TEST(sync_lock_follow_master_and_jog_hold) {
  Rig r;
  const Track m = makeDynamicTrack(128, 0.0, 600, 128, 0.0, 11), d = makeDynamicTrack(125, 0.0, 600, 125, 0.0, 12);
  r.load(0, m);
  r.load(1, d, 30.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  r.run(12.0);
  om_sync_state st;
  r.sync.snapshot(st);
  const double base = st.sync_base[1];
  const double lastWant = r.sync.diag(1).lastWant;
  OM_CHECK_NEAR(lastWant, 1.024, 1e-12);
  // the MASTER's tempo command: the follower scales in the SAME command (before any tick)
  r.tempoCommand(0, 1.03);
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], base * 1.03, 1e-12);
  OM_CHECK_NEAR(r.deck[1].tmp, st.sync_base[1] * (1 + st.pll_corr[1]), 1e-15);
  OM_CHECK_NEAR(r.sync.diag(1).lastWant, 1.024 * 1.03, 1e-12);
  OM_CHECK(!r.sync.diag(1).measuring);
  // ...and the next tick does not scale twice
  r.step();
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], base * 1.03, 1e-12);
  // a tempo command on a FOLLOWER does not scale anybody
  const double b0 = st.sync_base[1];
  r.tempoCommand(1, 1.1);
  r.sync.snapshot(st);
  OM_CHECK(st.sync_base[1] == b0);
  r.run(0.2);  // the lock brings it back to its base
  OM_CHECK_NEAR(r.deck[1].tmp, b0, 0.0021 * b0);
  // the master's BPM field changes (grid edit): scaled by the lock in the next tick
  Track m2 = m;
  m2.grid.bpm = 130;
  r.deck[0].g = &m2.grid;
  r.step();
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], b0 * 130 / 128, 1e-12);
  r.deck[0].g = &m.grid;
  r.step();

  // jogHold: the lock is suspended GLOBALLY (nobody chases the nudged deck)
  r.run(12.0);
  r.sync.setJogHold(true);
  const double t1 = r.deck[1].tmp;
  r.deck[0].pos += 0.05 * 0.46875;  // the DJ nudges the master 0.05 beat
  r.run(2.0);
  OM_CHECK(r.deck[1].tmp == t1);
  // tempo commands still make the followers follow (engine.js _onTempo is not gated)
  r.sync.snapshot(st);
  const double bHold = st.sync_base[1];
  r.tempoCommand(0, r.deck[0].tmp * 1.01);
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], bHold * 1.01, 1e-12);
  // release + reanchor (app.js jogRelease): the new alignment is kept
  r.sync.setJogHold(false);
  const double off = wrapHalf(r.beatPhaseOf(0) - r.beatPhaseOf(1));
  for (int k = 0; k < kNumDecks; k++) r.reanchor(k);
  OM_CHECK_NEAR(r.sync.diag(1).phaseOffset, std::fabs(off) < 0.03 ? 0.0 : off, 1e-9);
  r.run(5.0);
  OM_CHECK_NEAR(wrapHalf(r.beatPhaseOf(0) - r.beatPhaseOf(1)), r.sync.diag(1).phaseOffset, 0.002);
}

// ---------------------------------------------------------------------------
// Master change: handover without jumps
// ---------------------------------------------------------------------------
OM_TEST(sync_handover_without_jumps) {
  Rig r;
  const Track a = makeDynamicTrack(128, 0.0, 900, 128, 0.0003, 21), b = makeDynamicTrack(125, 0.0, 900, 125, 0.0003, 22),
              c = makeDynamicTrack(130, 0.0, 900, 130, 0.0003, 23);
  r.load(0, a, 10.0);
  r.load(1, b, 20.0);
  r.load(2, c, 30.0);
  r.play(0);
  r.run(0.3);
  r.play(1);
  r.play(2);
  r.run(0.3);
  OM_CHECK(r.doSync(1) && r.doSync(2));
  r.tempoCommand(0, 1.01);
  r.run(25.0);
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK(r.sync.autoMasterIdx() == 0 && st.calibrated[1] == 1 && st.calibrated[2] == 1);
  // the master is CUT: during the grace nobody chases anybody (tempi frozen)
  r.deck[0].pause();
  r.step();
  const double t1 = r.deck[1].tmp, t2 = r.deck[2].tmp;
  const double p1 = st.pll_corr[1], p2 = st.pll_corr[2];
  r.sync.snapshot(st);
  const double pc1 = st.pll_corr[1], pc2 = st.pll_corr[2];
  (void)p1;
  (void)p2;
  const int seeks1 = r.deck[1].seeks, seeks2 = r.deck[2].seeks;
  bool frozen = true;
  int n = 0;
  while (r.sync.autoMasterIdx() == 0 && n < 1000) {
    r.step();
    n++;
    if (r.sync.autoMasterIdx() == 0 && (r.deck[1].tmp != t1 || r.deck[2].tmp != t2)) frozen = false;
  }
  OM_CHECK(frozen);
  OM_CHECK(n >= 449 && n <= 451);  // 1.2 s of 128-frame blocks
  // deck 1 (first playing deck with the same bass score) became the master
  OM_CHECK(r.sync.autoMasterIdx() == 1);
  // NO JUMP: the new master only loses its servo correction; the follower
  // keeps its current speed (within 0.4 % of its new target) — up to the
  // engine.js ordering where the new master's setTempo first scales the
  // not-yet-handed-over followers by want(new master) / want(old master),
  // i.e. by the calibration residue (here < 0.01 %); no seek
  OM_CHECK_NEAR(r.deck[1].tmp, t1 / (1 + pc1), 1e-12);
  OM_CHECK(std::fabs(r.deck[2].tmp / (t2 / (1 + pc2)) - 1) < 1e-4);
  OM_CHECK(std::fabs(r.deck[1].tmp / t1 - 1) <= 0.0021 && std::fabs(r.deck[2].tmp / t2 - 1) <= 0.0022);
  OM_CHECK(r.deck[1].seeks == seeks1 && r.deck[2].seeks == seeks2);
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[2] == 0);  // recalibrates in a flash against the new master
  // the present alignment is adopted (magnet: almost aligned = exactly aligned), then held
  r.step();
  OM_CHECK(r.sync.diag(2).phaseOffset == 0);
  r.run(20.0);
  OM_CHECK(std::fabs(wrapHalf(r.beatPhaseOf(1) - r.beatPhaseOf(2))) < 0.004);
  r.sync.snapshot(st);
  OM_CHECK(st.calibrated[2] == 1);
  // a MANUAL master change is a handover too
  const double t0b = r.deck[1].tmp, t2b = r.deck[2].tmp;
  r.sync.snapshot(st);
  const double pcb1 = st.pll_corr[1], pcb2 = st.pll_corr[2];
  r.sync.setManualMaster(2);
  r.step();
  OM_CHECK(r.sync.effectiveMaster() == 2);
  OM_CHECK_NEAR(r.deck[2].tmp, t2b / (1 + pcb2), 1e-12);
  OM_CHECK(std::fabs(r.deck[1].tmp / (t0b / (1 + pcb1)) - 1) < 1e-9);
}

// ---------------------------------------------------------------------------
// FX beat clocks on the live matrix, deck beat clocks, snapshot beatDur
// ---------------------------------------------------------------------------
OM_TEST(sync_fx_beat_clocks_on_live_matrix) {
  Rig r;
  const Track t0 = makeFixedTrack(128, 0.0, 600);
  const Track t1 = makeDynamicTrack(125, 0.01, 600, 125, 0.0, 31, /*barAnchor*/ 1);
  const Track t2 = makeFixedTrack(120, 0.0, 600);
  r.load(0, t0, 10.0);
  r.load(1, t1, 20.0);
  r.load(2, t2, 5.0);
  r.load(3, t0, 3.0);
  r.deck[3].g = nullptr;  // deck 3 plays without a BPM
  r.play(0);
  r.step();
  r.play(1);
  r.play(3);
  r.deck[1].tmp = 1.02;
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kPllCorr;
  w.pllCorr = 0.001;
  r.sync.writeSyncBase(1, w);
  // live matrix: unit 0 -> decks 2 and 1, unit 1 -> deck 3, unit 2 -> none, unit 3 -> deck 0
  r.fx.assign = static_cast<uint16_t>((1u << (0 * 4 + 2)) | (1u << (0 * 4 + 1)) | (1u << (1 * 4 + 3)) | (1u << (3 * 4 + 0)));
  r.step();
  OM_CHECK(r.sync.autoMasterIdx() == 0);
  const double beat0 = 60.0 / 128;              // deck 0 at tempo 1
  const double beat1 = 0.48 / (1.02 / 1.001);   // app.js beatOf: localPeriod / base tempo
  OM_CHECK(r.sync.fxRefDeck(0) == 1);           // deck 2 does not play: first assigned PLAYING deck
  OM_CHECK_NEAR(r.sync.panelBeatClock(0).beatDur, beat1, 1e-12);
  OM_CHECK(r.sync.fxRefDeck(1) == 0);           // deck 3 has no BPM: the master
  OM_CHECK_NEAR(r.sync.panelBeatClock(1).beatDur, beat0, 1e-12);
  OM_CHECK(r.sync.fxRefDeck(2) == 0 && r.sync.fxRefDeck(3) == 0);
  // the matrix is LIVE: a change takes effect at the next block
  r.fx.assign = static_cast<uint16_t>(1u << (0 * 4 + 2));
  r.step();
  OM_CHECK(r.sync.fxRefDeck(0) == 0);
  OM_CHECK_NEAR(r.sync.panelBeatClock(0).beatDur, beat0, 1e-12);
  r.play(2);
  r.step();
  OM_CHECK(r.sync.fxRefDeck(0) == 2);
  OM_CHECK_NEAR(r.sync.panelBeatClock(0).beatDur, 0.5, 1e-12);
  // the unit clock is the reference deck's clock (phase lock)
  const BeatClock pc = r.sync.panelBeatClock(0), dc = r.sync.deckBeatClock(2);
  OM_CHECK(pc.valid && pc.playing && pc.beatPos == dc.beatPos && pc.beatsPerSec == dc.beatsPerSec);
  // pad units: their own deck; without a BPM the master's beat duration
  OM_CHECK_NEAR(r.sync.padBeatClock(1).beatDur, beat1, 1e-12);
  OM_CHECK(r.sync.padBeatClock(1).beatPos == r.sync.deckBeatClock(1).beatPos);
  const BeatClock p3 = r.sync.padBeatClock(3);
  OM_CHECK(!p3.valid && p3.playing && p3.beatDur == beat0 && p3.beatPos == 0 && p3.beatsPerSec == 0);
  // master FX: the master deck
  OM_CHECK_NEAR(r.sync.masterBeatClock().beatDur, beat0, 1e-12);
  OM_CHECK(r.sync.masterBeatClock().beatPos == r.sync.deckBeatClock(0).beatPos);
  // snapshot beatDur (app.js beatOf per deck; null without BPM)
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.beat_dur[0], beat0, 1e-12);
  OM_CHECK_NEAR(st.beat_dur[1], beat1, 1e-12);
  OM_CHECK_NEAR(st.beat_dur[2], 0.5, 1e-12);
  OM_CHECK(std::isnan(st.beat_dur[3]));
  // nothing plays any more: 0.5 s
  for (SimDeck& d : r.deck) d.pause();
  r.run(1.3);
  OM_CHECK(r.sync.autoMasterIdx() == -1);
  const BeatClock mc = r.sync.masterBeatClock();
  OM_CHECK(!mc.valid && !mc.playing && mc.beatDur == 0.5);
  OM_CHECK(r.sync.panelBeatClock(0).beatDur == 0.5 && r.sync.panelBeatClock(2).beatDur == 0.5);
}

OM_TEST(sync_deck_beat_clock_fields) {
  Rig r;
  const Track t0 = makeFixedTrack(128, 0.25, 600);
  const Track t1 = makeDynamicTrack(125, 0.01, 600, 125, 0.0, 41, /*barAnchor*/ 3);
  Track t2 = makeFixedTrack(100, 0.0, 600);
  t2.grid.beatOffset = kNaN;  // a BPM but no grid position: counted from 0 (engine.js startRoll)
  r.load(0, t0, 10.0);
  r.load(1, t1, 20.0);
  r.load(2, t2, 6.0);
  r.load(3, t0, 4.0);
  r.play(0);
  r.play(1);
  r.play(2);
  r.deck[1].tmp = 1.03;
  SyncBaseWrite w;
  w.mask = SyncBaseWrite::kPllCorr;
  w.pllCorr = -0.002;
  r.sync.writeSyncBase(1, w);
  r.step();
  // the clocks of a tick are computed at the heard positions of that block
  const double pos0 = r.deck[0].pos, pos1 = r.deck[1].pos, pos2 = r.deck[2].pos;
  r.step();
  // fixed grid
  const BeatClock c0 = r.sync.deckBeatClock(0);
  OM_CHECK(c0.valid && c0.playing);
  OM_CHECK_NEAR(c0.beatDur, 60.0 / 128, 1e-12);
  OM_CHECK_NEAR(c0.beatsPerSec, 128.0 / 60, 1e-12);
  OM_CHECK_NEAR(c0.baseTempo, 1.0, 1e-15);
  OM_CHECK_NEAR(c0.beatPos, (pos0 - 0.25) * 128 / 60, 1e-9);
  // dynamic grid, relative to the bar anchor, servo included in beatsPerSec, removed in baseTempo
  const BeatClock c1 = r.sync.deckBeatClock(1);
  OM_CHECK(c1.valid && c1.playing);
  OM_CHECK_NEAR(c1.beatPos, grid::indexFracAt(t1.grid, pos1, 0.0) - 3, 1e-9);
  OM_CHECK_NEAR(c1.beatsPerSec, 1.03 / 0.48, 1e-9);
  OM_CHECK_NEAR(c1.baseTempo, 1.03 / 0.998, 1e-12);
  OM_CHECK_NEAR(c1.beatDur, 0.48 / (1.03 / 0.998), 1e-12);
  // beatPos advances by beatsPerSec x block duration
  r.step();
  OM_CHECK_NEAR(r.sync.deckBeatClock(1).beatPos - c1.beatPos, c1.beatsPerSec * r.h(), 1e-9);
  // BPM without a grid position
  OM_CHECK(r.sync.deckBeatClock(2).valid);
  OM_CHECK_NEAR(r.sync.deckBeatClock(2).beatPos, (pos2 + r.h()) * 100 / 60, 1e-9);
  // stopped: no motion
  const BeatClock c3 = r.sync.deckBeatClock(3);
  OM_CHECK(c3.valid && !c3.playing && c3.beatsPerSec == 0);
  OM_CHECK_NEAR(c3.beatPos, (4.0 - 0.25) * 128 / 60, 1e-9);
  // no grid at all
  r.deck[3].g = nullptr;
  r.step();
  const BeatClock c4 = r.sync.deckBeatClock(3);
  OM_CHECK(!c4.valid && c4.beatDur == 0.5 && c4.beatPos == 0 && c4.beatsPerSec == 0);
  // out of range
  OM_CHECK(!r.sync.deckBeatClock(9).valid);
}

// ---------------------------------------------------------------------------
// fxTick ROLL driving and nextBoundaryAt
// ---------------------------------------------------------------------------
OM_TEST(sync_roll_priorities) {
  Rig r;
  const Track t = makeFixedTrack(128, 0.0, 600);
  r.load(0, t, 10.0);
  r.load(1, t, 10.0);
  r.play(0);
  r.play(1);
  SimDeck& d = r.deck[0];
  // the held PAD roll first
  r.sync.setPadRoll(0, 0.5, 1.0);
  r.step();
  OM_CHECK(d.rollOn && d.rollB == 0.5 && d.rollMixV == 1.0 && d.rollStarts == 1);
  OM_CHECK(r.sync.diag(0).padRoll);
  // a panel ROLL unit assigned (live matrix) to deck 0 only does not override the pad
  r.fx.panel[1].enabled = true;
  r.fx.panel[1].type = FxType::Roll;
  r.fx.panel[1].level = 0.5f;
  r.fx.panel[1].beatsMult = 0.25f;
  r.fx.assign = static_cast<uint16_t>(1u << (1 * 4 + 0));
  r.step();
  OM_CHECK(d.rollB == 0.5 && d.rollStarts == 1);
  // pad released: the panel unit takes over (other beats = restart)
  r.sync.setPadRoll(0, 0.0, 1.0);
  r.step();
  OM_CHECK(d.rollOn && d.rollB == 0.25 && d.rollStarts == 2);
  OM_CHECK_NEAR(d.rollMixV, 0.5, 1e-7);
  // same beats: only the mix follows the level
  r.fx.panel[1].level = 0.8f;
  r.step();
  OM_CHECK(d.rollStarts == 2);
  OM_CHECK_NEAR(d.rollMixV, 0.8, 1e-7);
  // the panel unit is not assigned to deck 1: deck 1 does not roll
  OM_CHECK(!r.deck[1].rollOn);
  // level <= 0.02: not wanted; the MASTER FX roll comes next
  r.fx.panel[1].level = 0.02f;
  r.fx.masterExists = true;
  r.fx.master.enabled = true;
  r.fx.master.type = FxType::Roll;
  r.fx.master.level = 0.6f;
  r.fx.master.beatsMult = 1.0f;
  r.step();
  OM_CHECK(d.rollOn && d.rollB == 1.0 && d.rollStarts == 3);
  OM_CHECK(r.deck[1].rollOn && r.deck[1].rollB == 1.0);  // the master FX rolls every deck
  // a panel unit that is not "roll" does nothing; master FX off: the rolls stop (not immediate)
  r.fx.panel[1].type = FxType::Echo;
  r.fx.panel[1].level = 1.0f;
  r.fx.master.enabled = false;
  r.step();
  OM_CHECK(!d.rollOn && d.rollStops >= 1 && !d.lastStopImmediate);
  OM_CHECK(!r.deck[1].rollOn);
  // a roll is only driven while the deck plays
  r.sync.setPadRoll(0, 0.25, 0.7);
  d.pause();
  r.step();
  OM_CHECK(!d.rollOn);
  r.play(0);
  r.step();
  OM_CHECK(d.rollOn && d.rollB == 0.25);
  OM_CHECK_NEAR(d.rollMixV, 0.7, 1e-12);
  // a refused start is retried at the next block (engine.js _roll stays null)
  r.sync.setPadRoll(0, 0.0, 1.0);
  r.step();
  d.refuseRoll = true;
  r.sync.setPadRoll(0, 2.0, 1.0);
  r.step();
  OM_CHECK(!d.rollOn);
  d.refuseRoll = false;
  r.step();
  OM_CHECK(d.rollOn && d.rollB == 2.0);
  // a new track drops the pad roll
  r.load(0, t, 10.0);
  OM_CHECK(!r.sync.diag(0).padRoll);
}

OM_TEST(sync_next_boundary_at) {
  Rig r;
  const Track t = makeFixedTrack(120, 0.0, 600);
  r.load(0, t, 1.1);
  r.play(0);
  r.deck[0].frozen = true;
  r.step();
  const EngineTime now = r.clk.presentTime;
  // beat 2.2: half-beat grid -> beat 2.5 (0.15 s away at tempo 1)
  OM_CHECK_NEAR(r.sync.nextBoundaryAt(0, 0.5) - now, 0.15, 1e-9);
  // 8 beats: locked to the BAR (G = 4) -> beat 4
  OM_CHECK_NEAR(r.sync.nextBoundaryAt(0, 8) - now, 0.9, 1e-9);
  // 2 beats -> beat 4
  OM_CHECK_NEAR(r.sync.nextBoundaryAt(0, 2) - now, 0.9, 1e-9);
  // tempo 1.5: track seconds / tempo
  r.deck[0].tmp = 1.5;
  OM_CHECK_NEAR(r.sync.nextBoundaryAt(0, 0.5) - now, 0.1, 1e-9);
  r.deck[0].tmp = 1.0;
  // exactly on a boundary: the NEXT one (+1e-6)
  r.deck[0].pos = 1.25;
  OM_CHECK_NEAR(r.sync.nextBoundaryAt(0, 0.5) - now, 0.25, 1e-9);
  // dynamic grid with a bar anchor
  const Track dyn = makeDynamicTrack(120, 0.0, 600, 120, 0.0, 51, /*barAnchor*/ 1);
  r.deck[0].g = &dyn.grid;
  r.deck[0].pos = 1.1;  // beat 2.2, bar anchor 1: bars at beats 1, 5, 9...
  OM_CHECK_NEAR(r.sync.nextBoundaryAt(0, 4) - now, 5 * 0.5 - 1.1, 1e-9);
  // null cases
  OM_CHECK(std::isnan(r.sync.nextBoundaryAt(0, 0)));
  r.deck[0].isPlaying = false;
  OM_CHECK(std::isnan(r.sync.nextBoundaryAt(0, 1)));
  OM_CHECK(std::isnan(r.sync.nextBoundaryAt(3, 1)));
}

OM_TEST(sync_track_load_and_reset_defaults) {
  Rig r;
  const Track m = makeDynamicTrack(128, 0.0, 600, 128, 0.0, 61), d = makeDynamicTrack(125, 0.0, 600, 125, 0.0, 62);
  r.load(0, m);
  r.load(1, d, 20.0);
  r.play(0);
  r.play(1);
  r.run(0.5);
  OM_CHECK(r.doSync(1));
  r.sync.setPadRoll(1, 0.5, 1.0);
  r.run(12.0);
  // a new track: SYNC stays on, blank ratio, pad roll dropped
  r.load(1, d, 50.0);
  om_sync_state st;
  r.sync.snapshot(st);
  OM_CHECK(st.synced[1] == 1 && std::isnan(st.sync_base[1]) && std::isnan(st.sync_ref[1]) && st.pll_corr[1] == 0 &&
           st.calibrated[1] == 0);
  const SyncDeckDiag dg = r.sync.diag(1);
  OM_CHECK(!dg.padRoll && dg.ratioPasses == 0 && dg.ratioTries == 0 && dg.phaseOffset == 0 && std::isnan(dg.syncWant));
  // ...and the lock re-aligns it from the first block it plays (repair path)
  r.play(1);
  r.step();
  r.sync.snapshot(st);
  OM_CHECK_NEAR(st.sync_base[1], 1.024, 1e-12);
  // hello {reset}
  r.sync.setJogHold(true);
  r.sync.setManualMaster(1);
  r.sync.resetToDefaults();
  r.sync.snapshot(st);
  OM_CHECK(st.master_idx == -1 && st.auto_master_idx == -1 && st.jog_hold == 0);
  for (int k = 0; k < kNumDecks; k++) OM_CHECK(st.synced[k] == 0 && std::isnan(st.sync_base[k]) && st.pll_corr[k] == 0);
}

// ---------------------------------------------------------------------------
// Native precision refinements (setNativePrecision; ON by default in the
// engine since 2026-11-09, while the rig of this file runs the engine.js
// parity mode every test above checks). Each one against its verbatim
// counterpart.
// ---------------------------------------------------------------------------
namespace {
// Fixed grids 128 / 125 BPM, follower synced (stage 1 first), optional base error.
struct CalRig {
  Rig r;
  Track m = makeFixedTrack(128, 0.0, 900);
  Track d = makeFixedTrack(125, 0.0, 900);
  CalRig(bool precision, double baseError) {
    r.sync.setNativePrecision(precision);
    r.load(0, m);
    r.load(1, d, 20.0);
    r.play(0);
    r.play(1);
    r.run(0.5);
    OM_CHECK(r.doSync(1));
    if (baseError != 0) {
      SyncBaseWrite w;
      w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kRef;
      w.base = w.ref = 1.024 * (1 + baseError);
      r.sync.writeSyncBase(1, w);
    }
  }
  bool calibrated() {
    om_sync_state st;
    r.sync.snapshot(st);
    return st.calibrated[1] != 0;
  }
  double base() {
    om_sync_state st;
    r.sync.snapshot(st);
    return st.sync_base[1];
  }
};
}  // namespace

OM_TEST(sync_precision_calibration_needs_a_fine_pass) {
  // exact ratio: the 1 s pass finds nothing to correct
  CalRig v(false, 0.0), p(true, 0.0);
  stepUntil(v.r, [&] { return v.r.sync.diag(1).ratioPasses == 1; }, 2000);
  stepUntil(p.r, [&] { return p.r.sync.diag(1).ratioPasses == 1; }, 2000);
  OM_CHECK(v.calibrated());   // engine.js: done on the 1 s pass alone
  OM_CHECK(!p.calibrated());  // precision: a 1 s window cannot certify 0.02 %
  stepUntil(p.r, [&] { return p.calibrated(); }, 5000);
  OM_CHECK(p.calibrated() && p.r.sync.diag(1).ratioPasses == 2);
  OM_CHECK_NEAR(p.base(), 1.024, 1e-9);
}

OM_TEST(sync_precision_coarse_noise_floor) {
  // 0.05 % off: below the 1 s window's +-0.1 % noise floor
  CalRig v(false, 0.0005), p(true, 0.0005);
  stepUntil(v.r, [&] { return v.r.sync.diag(1).ratioPasses == 1; }, 2000);
  stepUntil(p.r, [&] { return p.r.sync.diag(1).ratioPasses == 1; }, 2000);
  OM_CHECK(std::fabs(v.base() / 1.024 - 1) < 2e-5);  // engine.js applies the coarse correction
  OM_CHECK(p.base() == 1.024 * 1.0005);              // precision keeps the ratio for the fine stage
  OM_CHECK(!p.calibrated());
  stepUntil(p.r, [&] { return p.calibrated(); }, 20000);
  OM_CHECK(p.calibrated() && std::fabs(p.base() / 1.024 - 1) < 2e-5);
  // a coarse correction above the floor is applied as in engine.js
  CalRig q(true, 0.005);
  stepUntil(q.r, [&] { return q.r.sync.diag(1).ratioPasses == 1; }, 2000);
  OM_CHECK(std::fabs(q.base() / 1.024 - 1) < 2e-5);
}

OM_TEST(sync_precision_integral_servo_static) {
  // frozen decks (the error is set, nothing moves): engine.js rests inside
  // the 0.0015-beat dead zone; precision always corrects, gain 0.08 plus an
  // integral growing by eF * 0.08 / 30 per second, never fed by errors
  // beyond 0.01 beat and clamped at the servo limit
  for (const bool precision : {false, true}) {
    ServoRig s(false);
    s.r.sync.setNativePrecision(precision);
    s.setError(0.001);  // inside the dead zone
    s.r.run(3.0);
    om_sync_state st;
    s.r.sync.snapshot(st);
    SyncDeckDiag g = s.r.sync.diag(1);
    if (!precision) {
      OM_CHECK(st.pll_corr[1] == 0.0 && g.integ == 0.0);
    } else {
      // the low-pass reaches 0.001 within ~0.5 s: between 2.5 s and 3 s of integration
      OM_CHECK(g.integ > 0.08 * 0.001 * 2.5 / 30 && g.integ < 0.08 * 0.001 * 3.0 / 30);
      OM_CHECK_NEAR(st.pll_corr[1], 0.08 * g.errFilt + g.integ, 1e-15);
    }
    OM_CHECK_NEAR(s.r.deck[1].tmp, st.sync_base[1] * (1 + st.pll_corr[1]), 1e-15);
    OM_CHECK(st.sync_base[1] == 1.0);  // the base (the BPM shown) never moves
    // a transient error (> 0.01 beat) is not integrated; the total stays clamped
    s.setError(0.03);
    s.r.run(1.0);
    const double frozen = s.r.sync.diag(1).integ;
    s.r.run(2.0);
    s.r.sync.snapshot(st);
    g = s.r.sync.diag(1);
    OM_CHECK(g.integ == frozen);
    OM_CHECK_NEAR(st.pll_corr[1], 0.002, 1e-15);  // 0.08 x 0.03 + integral, clamped at 0.2 %
    // a persistent small error: the integral saturates at the limit
    s.setError(0.005);
    s.r.run(200.0);
    s.r.sync.snapshot(st);
    g = s.r.sync.diag(1);
    if (precision) {
      OM_CHECK_NEAR(g.integ, 0.002, 1e-15);
      OM_CHECK_NEAR(st.pll_corr[1], 0.002, 1e-15);
    } else {
      OM_CHECK(g.integ == 0.0);
      OM_CHECK_NEAR(st.pll_corr[1], 0.08 * 0.005, 1e-12);
    }
  }
}

OM_TEST(sync_precision_integral_servo_removes_the_residue) {
  // a calibrated follower whose base is then 0.02 % too fast: engine.js's
  // proportional servo holds it with a constant error of -0.0002 / 0.08 =
  // -0.0025 beat (1.2 ms at 128 BPM); precision returns the error to ~0 and
  // the integral part holds the residue. The base is untouched in both.
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    const Track m = makeDynamicTrack(128.0, 0.0, 900, 128.0, 0.0, 91), d = makeDynamicTrack(125.0, 0.0, 900, 125.0, 0.0, 92);
    r.load(0, m, 10.0);
    r.load(1, d, 20.0);
    r.play(0);
    r.run(0.3);
    r.play(1);
    OM_CHECK(r.doSync(1));
    om_sync_state st;
    stepUntil(r, [&] { r.sync.snapshot(st); return st.calibrated[1] != 0; }, 20000);
    OM_CHECK(st.calibrated[1] != 0);
    const double exact = st.sync_base[1];
    SyncBaseWrite w;
    w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kRef;
    w.base = w.ref = exact * 1.0002;
    r.sync.writeSyncBase(1, w);
    r.run(240.0);
    r.sync.snapshot(st);
    const SyncDeckDiag g = r.sync.diag(1);
    OM_CHECK(st.sync_base[1] == exact * 1.0002);
    OM_CHECK_NEAR(st.pll_corr[1], 1 / 1.0002 - 1, 2e-6);  // the deck plays the exact ratio again
    if (!precision) {
      OM_CHECK_NEAR(g.errFilt, -0.0025, 3e-5);
      OM_CHECK(g.integ == 0.0);
    } else {
      OM_CHECK(std::fabs(g.errFilt) < 1e-4);
      OM_CHECK_NEAR(g.integ, 1 / 1.0002 - 1, 2e-5);
    }
  }
}

OM_TEST(sync_precision_handover_baseless_synced_master_keeps_speed) {
  // deck 0 plays first (the master) with SYNC on but no base (sync() needs
  // another master); when deck 1 becomes the master, engine.js skips deck 0
  // in the handover and its repair re-aims it at the BPM-field ratio (here
  // 126.2 / 128 for true tempi 126.21 / 127.93: a 0.056 % jump); precision
  // keeps its speed, the reference the other deck was calibrated to
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    const Track a = makeDynamicTrack(127.93, 0.0, 900, 128.0, 0.0, 61), b = makeDynamicTrack(126.21, 0.0, 900, 126.2, 0.0, 62);
    r.load(0, a, 10.0);
    r.load(1, b, 20.0);
    r.play(0);
    r.run(0.3);
    r.play(1);
    OM_CHECK(r.doSync(1));
    r.sync.setSynced(0, true);
    r.run(20.0);
    const double t0 = r.deck[0].tmp;
    OM_CHECK(t0 == 1.0);
    r.sync.setManualMaster(1);
    r.step();
    om_sync_state st;
    r.sync.snapshot(st);
    if (precision) {
      OM_CHECK(st.sync_base[0] == t0);
      OM_CHECK(std::fabs(r.deck[0].tmp / t0 - 1) < 1e-5);  // only the servo's first tiny correction
    } else {
      const double want = 126.2 * r.deck[1].tmp / 128.0;  // BPM fields x the new master's base
      OM_CHECK(st.pll_corr[1] == 0.0);
      OM_CHECK_NEAR(r.deck[0].tmp, want, 1e-12);
      OM_CHECK(std::fabs(want / t0 - 1) > 4e-4);
    }
  }
}

OM_TEST(sync_precision_handover_keeps_the_learned_residue) {
  // deck 1 holds a 0.02 % residue with its integral part; at a master change
  // engine.js drops the whole correction (the deck then drifts until it is
  // recalibrated), precision keeps the learned residue in the new base and
  // only drops the momentary proportional part
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    const Track m = makeDynamicTrack(128.0, 0.0, 900, 128.0, 0.0, 51), d = makeDynamicTrack(125.0, 0.0, 900, 125.0, 0.0, 52),
                c = makeDynamicTrack(126.0, 0.0, 900, 126.0, 0.0, 53);
    r.load(0, m, 10.0);
    r.load(1, d, 20.0);
    r.load(2, c, 30.0);
    r.play(0);
    r.run(0.3);
    r.play(1);
    r.play(2);
    OM_CHECK(r.doSync(1) && r.doSync(2));
    om_sync_state st;
    stepUntil(r, [&] { r.sync.snapshot(st); return st.calibrated[1] != 0 && st.calibrated[2] != 0; }, 20000);
    SyncBaseWrite w;
    w.mask = SyncBaseWrite::kBase | SyncBaseWrite::kRef;
    w.base = w.ref = st.sync_base[1] * 1.0002;
    r.sync.writeSyncBase(1, w);
    r.run(240.0);
    r.sync.snapshot(st);
    const double base1 = st.sync_base[1], pll1 = st.pll_corr[1], t1 = r.deck[1].tmp;
    const double integ1 = r.sync.diag(1).integ;
    OM_CHECK(precision ? std::fabs(integ1) > 1.5e-4 : integ1 == 0.0);
    r.sync.setManualMaster(2);
    r.step();
    r.sync.snapshot(st);
    if (precision) {
      OM_CHECK_NEAR(st.sync_base[1] / (base1 * (1 + integ1)), 1.0, 1e-12);
      OM_CHECK(std::fabs(r.deck[1].tmp / t1 - 1) < 1e-5);  // only the proportional part (~0) moved
    } else {
      OM_CHECK_NEAR(st.sync_base[1] / (t1 / (1 + pll1)), 1.0, 1e-12);
      OM_CHECK(std::fabs(r.deck[1].tmp / t1 - 1) > 1.5e-4);  // the 0.02 % correction is dropped
    }
    OM_CHECK(std::fabs(r.sync.diag(1).integ) < 1e-9);  // restarted (one block of integration since)
  }
}

OM_TEST(sync_precision_handover_keeps_follower_speed) {
  // BPM fields rounded like an analysis does (128.0 for 127.93, 126.2 for
  // 126.21): engine.js's _onTempo ordering scales the follower handed over
  // AFTER the new master by want(new) / want(old)
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    const Track a = makeDynamicTrack(127.93, 0.0, 900, 128.0, 0.0, 71);
    const Track b = makeDynamicTrack(126.21, 0.0, 900, 126.2, 0.0, 72);
    const Track c = makeDynamicTrack(128.42, 0.0, 900, 128.4, 0.0, 73);
    r.load(1, b, 10.0);
    r.load(0, a, 20.0);
    r.load(2, c, 30.0);
    r.play(1);  // deck 1 = master
    r.run(0.3);
    r.play(0);
    r.play(2);
    r.run(0.3);
    OM_CHECK(r.doSync(0) && r.doSync(2));
    r.mix.eqLow[2] = -1.0f;  // after deck 1: deck 0 (open bass) becomes the master, BEFORE deck 2
    r.run(20.0);
    om_sync_state st;
    r.sync.snapshot(st);
    const double t0 = r.deck[0].tmp, t1 = r.deck[1].tmp, t2 = r.deck[2].tmp;
    const double pc0 = st.pll_corr[0], pc2 = st.pll_corr[2];
    r.deck[1].pause();
    stepUntil(r, [&] { return r.sync.autoMasterIdx() != 1; }, 1000);
    OM_CHECK(r.sync.autoMasterIdx() == 0);
    OM_CHECK_NEAR(r.deck[0].tmp, t0 / (1 + pc0), 1e-12);
    const double kept = t2 / (1 + pc2);
    if (precision) {
      OM_CHECK_NEAR(r.deck[2].tmp, kept, 1e-12);  // nothing moves to the ear
    } else {
      const double f = (128.0 * (t0 / (1 + pc0))) / (126.2 * t1);  // want(new) / want(old)
      OM_CHECK(std::fabs(f - 1) > 4e-4);
      OM_CHECK_NEAR(r.deck[2].tmp / kept, f, 1e-9);
    }
  }
}

OM_TEST(sync_precision_keylock_master_heard_together) {
  // the master goes through the WSOLA transposer (its tempo is heard 2647
  // frames later), the follower does not
  double errAfter[2] = {0, 0};
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    const Track m = makeDynamicTrack(128, 0.0, 900, 128, 0.0, 81), d = makeDynamicTrack(125, 0.0, 900, 125, 0.0, 82);
    r.load(0, m, 10.0);
    r.load(1, d, 20.0);
    r.deck[0].wsola = true;
    r.play(0);
    r.run(0.3);
    r.play(1);
    OM_CHECK(r.doSync(1));
    r.run(20.0);
    const double before = r.deck[1].tmp;
    om_sync_state st;
    r.sync.snapshot(st);
    const double base0 = st.sync_base[1];
    const SampleTime cmdAt = r.now();
    r.tempoCommand(0, r.deck[0].tmp * 1.03);  // +3 % on the master
    r.sync.snapshot(st);
    OM_CHECK_NEAR(st.sync_base[1], base0 * 1.03, 1e-9);  // the bookkeeping follows at once
    if (!precision) {
      OM_CHECK_NEAR(r.deck[1].tmp / before, 1.03, 1e-9);  // engine.js: played at once
    } else {
      OM_CHECK_NEAR(r.deck[1].tmp / before, 1.0, 1e-12);  // played when the master's change is heard
      const double lag = kWsolaLatencySamples / kRate;
      while (std::fabs(r.deck[1].tmp / before - 1) < 1e-6 && r.now() < cmdAt + 1.0) r.step();
      const SampleTime playedAt = r.now() - r.h();
      OM_CHECK(playedAt - cmdAt >= lag - 1e-9 && playedAt - cmdAt < lag + r.h() + 1e-9);
    }
    // 0.2 s later (before the slow servo acts much): the phase error left by the move
    while (r.now() < cmdAt + 0.2) r.step();
    errAfter[precision ? 1 : 0] = std::fabs(wrapHalf(r.beatPhaseOf(0) - r.beatPhaseOf(1)));
  }
  // engine.js: the follower ran 3 % ahead for 55 ms (~0.0036 beat, 1.6 ms); precision: ~0
  OM_CHECK(errAfter[0] > 0.003);
  OM_CHECK(errAfter[1] < 0.0004);
  std::printf("[INFO] keylock master +3 %%: phase error left 0.2 s later: engine.js %.3f ms, precision %.3f ms\n",
              errAfter[0] * 0.46875 * 1000, errAfter[1] * 0.46875 * 1000);
}
