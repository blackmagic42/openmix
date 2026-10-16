// Sync engine: automatic master, SYNC, continuous lock, handover, ROLL
// driving and FX beat clocks at block rate (owner: sync). SKELETON: keeps
// the flags the commands set; no tempo/phase logic yet. SPEC.md §11.
#include "om/sync.h"

namespace om {

struct SyncEngine::Impl {
  IDeckControl* decks[kNumDecks] = {};
  SyncSnapshot snap;
  double globalGridOffset = 0;
};

SyncEngine::SyncEngine() : impl_(std::make_unique<Impl>()) {}
SyncEngine::~SyncEngine() = default;

void SyncEngine::attachDecks(IDeckControl* const decks[kNumDecks]) noexcept {
  for (int i = 0; i < kNumDecks; i++) impl_->decks[i] = decks[i];
}

void SyncEngine::setManualMaster(int idx) noexcept { impl_->snap.masterIdx = (idx >= 0 && idx < kNumDecks) ? idx : -1; }
void SyncEngine::setJogHold(bool on) noexcept { impl_->snap.jogHold = on; }
void SyncEngine::setSynced(int d, bool on) noexcept { impl_->snap.synced[d] = on; }
void SyncEngine::setSyncBase(int d, double base, bool resetCorr) noexcept {
  impl_->snap.syncBase[d] = base;
  if (resetCorr) impl_->snap.pllCorr[d] = 0;
}
bool SyncEngine::sync(int) noexcept { return false; }
void SyncEngine::reanchor(int) noexcept {}
bool SyncEngine::snapToRef(int, double) noexcept { return false; }
void SyncEngine::setPadRoll(int, double, double) noexcept {}
void SyncEngine::setGlobalGridOffset(double sec) noexcept { impl_->globalGridOffset = sec; }
void SyncEngine::onTrackLoaded(int d) noexcept {
  impl_->snap.syncBase[d] = kNaN;
  impl_->snap.pllCorr[d] = 0;
  impl_->snap.calibrated[d] = false;
}
void SyncEngine::onTempoCommand(int) noexcept {}
void SyncEngine::tick(const BlockClock&, const MixView&, const FxRackView&) noexcept {}

int SyncEngine::masterIdx() const noexcept { return impl_->snap.masterIdx; }
int SyncEngine::autoMasterIdx() const noexcept { return impl_->snap.autoMasterIdx; }
int SyncEngine::effectiveMaster() const noexcept {
  return impl_->snap.masterIdx >= 0 ? impl_->snap.masterIdx : impl_->snap.autoMasterIdx;
}
int SyncEngine::masterDeckFor(int) const noexcept { return -1; }
BeatClock SyncEngine::panelBeatClock(int) const noexcept { return BeatClock(); }
BeatClock SyncEngine::padBeatClock(int) const noexcept { return BeatClock(); }
BeatClock SyncEngine::masterBeatClock() const noexcept { return BeatClock(); }
void SyncEngine::snapshot(SyncSnapshot& s) const noexcept { s = impl_->snap; }

}  // namespace om
