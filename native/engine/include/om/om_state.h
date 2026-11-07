/* State snapshot of libopenmix as plain C structs: what the audio thread
 * publishes after every block (through a triple buffer), what
 * om_engine_read_state() copies out, and what the "state" JSON event
 * (SPEC.md §15.5) is built from. The modules fill their part directly
 * (Deck -> om_deck_state, SyncEngine -> om_sync_state, Mixer ->
 * om_mixer_state and the meters of om_deck_state, core -> the rest).
 *
 * FROZEN FOUNDATION (maintainer: host). C-compatible, fixed layout without
 * implicit padding (sizes asserted in src/core/capi.cpp), no pointers: a
 * later out-of-process engine can share it in shared memory.
 * "null" values of engine.js are NaN (doubles) or -1 (indexes).
 * Times: every *_t / ended_at / t is ENGINE time (seconds, QPC); positions
 * are track seconds (SPEC.md §4).
 */
#ifndef OM_STATE_H
#define OM_STATE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OM_NUM_DECKS 4
#define OM_NUM_STEMS 4
#define OM_NUM_FX_UNITS 4

/* om_deck_state.insert_state */
#define OM_INSERT_NONE 0
#define OM_INSERT_ACTIVE 1
#define OM_INSERT_BYPASSED 2
#define OM_INSERT_LATE 3    /* the last block missed the deadline: dry was used */
#define OM_INSERT_HUNG 4
#define OM_INSERT_CRASHED 5

/* One deck (engine.js Deck). Positions are HEARD positions in track seconds
 * at om_state.t (the presentTime of the frame after the last rendered block).
 * A SEGMENT is a stretch where the heard position is continuous (SPEC.md
 * §4.4): seg changes at play, pause/stop, seek, hot cue, jumps, scratch
 * start/end, natural end, load/unload (not at loop wraps, not at tempo
 * changes). */
typedef struct om_deck_state {
  uint32_t load_id;        /* PCM object attached (0 = none) */
  uint32_t seg;            /* segment counter (+1 at every discontinuity) */
  uint32_t ended_count;    /* natural ends since the engine started: sticky latch, deck.ended derives from it */
  uint32_t insert_late;    /* VST insert: blocks that missed the deadline (dry used) */
  uint8_t loaded;          /* a track is attached */
  uint8_t playing;         /* engine.js Deck.playing (true while armed) */
  uint8_t looping;         /* engine.js Deck.looping */
  uint8_t keylock;         /* engine.js Deck.keylock */
  uint8_t routed_wsola;    /* engine.js Deck._routeW: sound goes through the WSOLA transposer */
  uint8_t stems_ready;     /* engine.js Deck.stems != null */
  uint8_t stems_on;        /* engine.js Deck.stemsOn */
  uint8_t scratching;      /* scrubStart .. scrubEnd */
  uint8_t spinning;        /* V.BRAKE / BACKSPIN sound running */
  uint8_t rolling;         /* engine.js Deck._roll != null */
  uint8_t settled;         /* heard position advances linearly with the tempo (sync may measure) */
  uint8_t armed;           /* play requested, waiting for PCM / WSOLA history (<= 250 ms, SPEC.md §9.1) */
  int8_t key_shift;        /* engine.js Deck.keyShift (-7..+7) */
  uint8_t insert_state;    /* OM_INSERT_* */
  uint8_t pad0[2];
  float pcm_ready;         /* share of the PCM received (0..1) */
  float start_wait_ms;     /* wait of the last armed start (diagnostics) */
  double duration;         /* track seconds (0 when empty) */
  double pos;              /* HEARD position (track s) at om_state.t; negative during pre-roll */
  double rate;             /* nominal HEARD rate at t: tempo heard (after the WSOLA lag), scratch speed, 0 when still or armed */
  double tempo;            /* engine.js Deck.tempo (includes the sync servo correction) */
  double anchor_t;         /* engine time at which the current segment is heard to start */
  double anchor_pos;       /* heard position at anchor_t */
  double loop_start;       /* engine.js Deck.loopStart */
  double loop_end;         /* engine.js Deck.loopEnd */
  double loop_beats;       /* engine.js Deck._loopBeats (NaN = null) */
  double cue_point;        /* engine.js Deck.cuePoint (the JS proxy is authoritative) */
  double proc_latency;     /* engine.js Deck.procLat: seconds the track is read ahead (WSOLA + insert) */
  double roll_beats;       /* beats of the active roll (0 = none) */
  double ended_at;         /* engine time of the last NATURAL end (engine.js _endedAt), NaN = none */
  float stem_gains[OM_NUM_STEMS]; /* current (smoothed) stem gains */
  float peak;              /* max |x| post-insert, pre-fader over the meter window (engine.js meterPeak) */
  float rms;               /* RMS over the same window */
  float dry;               /* current FX dry-cut gain of the deck (engine.js dryOut) */
  float pad1;
} om_deck_state;

/* Sync and master election (engine.js AudioEngine sync fields + per-deck sync fields). */
typedef struct om_sync_state {
  int32_t master_idx;      /* engine.js masterIdx (manual MASTER button), -1 = null */
  int32_t auto_master_idx; /* engine.js autoMasterIdx, -1 = null */
  uint8_t jog_hold;        /* engine.js jogHold */
  uint8_t synced[OM_NUM_DECKS];      /* engine.js Deck.synced */
  uint8_t calibrated[OM_NUM_DECKS];  /* engine.js Deck._ratioCal */
  uint8_t pad0[7];
  double sync_base[OM_NUM_DECKS];    /* engine.js Deck._syncBase (NaN = null) */
  double sync_ref[OM_NUM_DECKS];     /* engine.js Deck._syncRef (NaN = null) */
  double pll_corr[OM_NUM_DECKS];     /* engine.js Deck._pllCorr */
  double beat_dur[OM_NUM_DECKS];     /* app.js beatOf(deck): real seconds per beat (NaN = no BPM) */
} om_sync_state;

/* Master bus, FX returns and meters. */
typedef struct om_mixer_state {
  float master_peak;       /* after the master filter, before the limiter (engine.js masterPeak) */
  float master_rms;
  float cue_peak;          /* headphone bus */
  float gain_reduction_db; /* limiter gain reduction (<= 0) */
  float dry_comp;          /* master FX dry compensation (engine.js dryComp) */
  float master_wet;        /* master FX wet gain (smoothed) */
  float fx_wet[OM_NUM_FX_UNITS];  /* panel units' wet gains (smoothed, engine.js u.wet.gain.value) */
  float pad_wet[OM_NUM_DECKS];    /* pad units' wet gains */
  uint32_t sampler_dropped;       /* sampler triggers dropped: no data within 250 ms (SPEC.md §10.9) */
  uint32_t pad0;
} om_mixer_state;

/* Output device. */
typedef struct om_device_state {
  int32_t mode;            /* 0 closed, 1 null, 2 shared, 3 shared low-latency, 4 exclusive */
  int32_t sample_rate;
  int32_t channels;        /* device channels (4 = DJ controller: cue on 3/4) */
  int32_t period_frames;
  uint8_t cue_routed;      /* engine.js phonesOk: the cue bus reaches an output */
  uint8_t phones_active;   /* headphones on a second device */
  uint8_t recording;
  uint8_t lost;            /* the configured device is gone: NULL pacer running until it is back */
  uint8_t fell_back;       /* exclusive / low-latency refused: a shared mode is used */
  uint8_t throttling_off;  /* power throttling disabled for the process (SPEC.md §8.8) */
  uint8_t pad0[2];
  uint32_t period_steps;   /* automatic period step-ups after glitches */
  float load;              /* last callback duration / block duration */
  float max_load;          /* max over the last state period */
  float present_jitter_ms; /* jitter of presentTime (p99 over the last second) */
  double output_latency;   /* seconds added between callbackTime and presentTime */
  uint64_t xruns;          /* device glitches + callback overruns since open */
} om_device_state;

/* Engine health counters (SPEC.md §3.2): every one should stay 0. */
typedef struct om_health_state {
  uint64_t rt_allocs;        /* allocations seen inside the audio callback (trap builds) */
  uint64_t rt_frees;         /* frees seen inside the audio callback (trap builds) */
  uint64_t plugin_allocs;    /* allocations made by plugin code (informative, not violations) */
  uint32_t batches_rejected; /* messages refused because the command queue could not take them whole */
  uint32_t events_lost;      /* audio -> control events dropped (queue full) */
  uint32_t retired_backlog;  /* retired objects waiting for room in the retired queue */
  uint32_t retired_lost;     /* retired objects leaked (backlog full) */
  uint32_t pending_full;     /* "when" commands applied at once because the pending list was full */
  uint32_t stalls;           /* audio stalls detected by the watchdog */
} om_health_state;

typedef struct om_state {
  uint32_t struct_size;    /* sizeof(om_state) */
  uint32_t ack;            /* highest "seq" applied in arrival order ("when" commands excluded) */
  uint32_t epoch;          /* connection epoch: changes with hello {reset} (SPEC.md §15.3) */
  uint32_t pad0;
  uint64_t block;          /* callbacks rendered since the engine started */
  double t;                /* engine time the positions refer to (presentTime after the last block) */
  om_deck_state decks[OM_NUM_DECKS];
  om_sync_state sync;
  om_mixer_state mixer;
  om_device_state device;
  om_health_state health;
  uint64_t pcm_bytes;      /* memory used by the PCM handed off (tracks, stems, samples) */
} om_state;

#ifdef __cplusplus
}
#endif

#endif /* OM_STATE_H */
