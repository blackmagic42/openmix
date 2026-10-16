// The engine state published by the audio thread after every block (through
// a TripleBuffer) and turned into the JSON "state" event by the control
// thread at ~60 Hz (owner: host). Composed of the snapshot structs owned by
// the deck, mixer and sync modules. SPEC.md §15.4.
#pragma once

#include <cstdint>

#include "om/common.h"
#include "om/deck.h"
#include "om/mixer.h"
#include "om/sync.h"

namespace om {

struct EngineStateRT {
  uint64_t block = 0;          // blocks rendered since the device opened
  EngineTime t = 0;            // presentTime of the block the snapshot belongs to
  uint32_t ack = 0;            // highest UI sequence number applied by the audio thread
  DeckSnapshot decks[kNumDecks];
  MixerSnapshot mixer;
  SyncSnapshot sync;
  float load = 0;              // callback duration / block duration (last block)
  float maxLoad = 0;           // max since the previous snapshot read
  uint64_t xruns = 0;          // device glitches + overruns
  int sampleRate = 0;
  int periodFrames = 0;
};

}  // namespace om
