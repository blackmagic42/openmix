// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Deck: one player — transport and timing model, loops, cues, roll,
// scratch/spin, keylock routing, stems, insert, channel strip
// (DESIGN §5.5, §6.2, §6.4). Ported from the OpenMix app engine (Deck), plus
// the deck logic that lived in the OpenMix UI (DESIGN §8): play alignment,
// SYNC arming, hold-to-preview CUE, hot-cue and loop pads, beat jump, jog
// bend, waveform scratch, pad FX, turntable effects and grid editing.

import { Emitter } from './emitter.js';
import { PitchShifter } from './pitch-fallback.js';
import { gridIndexFracAt, gridTimeAtIndex, snapToBeat } from './grid.js';
import { PRE_ROLL, TEMPO_MIN, TEMPO_MAX, KEY_SHIFT_MIN, KEY_SHIFT_MAX, WSOLA_LATENCY_SAMPLES } from './constants.js';
import { PAD_FX_DRY, isFxType } from './fx.js';
import { heardKey as heardKeyOf } from './analysis/key.js';
import { analyzeTrack } from './analysis/track.js';
import { clamp, isNum, hasOwn, isAudioBufferLike, bpmFromBeats, abortError } from './util.js';

// Internal construction token: only the engine creates decks
export const DECK_CREATE = Symbol('openmix.deck');

const STEM_NAMES = Object.freeze(['vocals', 'drums', 'bass', 'other']);
const EQ_BANDS = Object.freeze(['low', 'mid', 'high']);
const XF_SIDES = Object.freeze(['A', 'B', 'thru']);
const DECK_EVENTS = Object.freeze(['load', 'eject', 'play', 'pause', 'ended', 'loop', 'hotcue', 'cuepoint', 'sync', 'grid']);

const isFiniteNum = (v) => isNum(v) && Number.isFinite(v);
const validBpm = (v) => (isFiniteNum(v) && v > 0 ? v : null);

function sameBeats(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A beat list is used only with more than 2 beats (OpenMix rule)
function beatList(beats) {
  if (!Array.isArray(beats) || beats.length <= 2) return null;
  for (const b of beats) if (!isFiniteNum(b)) return null;
  return beats.slice();
}

/**
 * One player of the engine. Created by the engine only (engine.decks);
 * exported for instanceof checks and types.
 */
export class Deck extends Emitter {
  constructor(engine, index, token) {
    super(DECK_EVENTS);
    if (token !== DECK_CREATE) throw new TypeError('Decks are created by the engine (engine.decks)');
    const ctx = engine.ctx;
    const destination = engine.masterGain;
    this.ctx = ctx;
    /** The engine this deck belongs to. */
    this.engine = engine;
    /** 0-based index of the deck. */
    this.index = index;

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 200;

    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 8000;

    // DJ filter: neutral = peaking gain 0 (transparent), left = low-pass, right = high-pass
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'peaking';
    this.filter.gain.value = 0;
    this.filter.frequency.value = 1000;
    this.filter.Q.value = 0.9;

    this.fader = ctx.createGain();
    this.xf = ctx.createGain();

    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.filter);
    // INSERT point (any AudioNode / AudioWorkletNode effect: WASM DSP, a
    // plugin bridge…): filter → [insert] → post. Fader, headphone cue, meter
    // and Color FX all listen to `post`, so they hear the insert too.
    this.post = ctx.createGain();
    /** The insert node (setInsert), or null. */
    this.insert = null;
    this.insertLat = 0;     // latency of the insert (s), added to procLat
    this.filter.connect(this.post);
    this.post.connect(this.fader);
    // PRE-FADER send to the headphone bus (the channel's headphone CUE button):
    // the deck is heard in the headphones even with the fader down — true PFL
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.cueOn = false;
    this.post.connect(this.cueSend);
    this.fader.connect(this.xf);
    // DRY output of the deck, adjustable: while a PAD FX is held, the effect
    // MANIPULATES the sound (the dry is cut) instead of adding on top of it.
    // The FX sends tap xf BEFORE this gain: the wet is never cut.
    this.dryOut = ctx.createGain();
    this.xf.connect(this.dryOut);
    this.dryOut.connect(destination);

    // TRIM: track input gain (±12 dB), before the EQ
    this.trim = ctx.createGain();
    this.trim.gain.value = 1;
    this.trimVal = 0;
    this.trim.connect(this.eqLow);

    // Level analyser (VU meter + clipping detection), post-EQ/filter
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.post.connect(this.analyser);
    this.meterBuf = new Float32Array(this.analyser.fftSize);

    // Deck entry point: straight to the EQ (via TRIM), or through the
    // transposer (KEY ± and KEYLOCK). The WSOLA engine (AudioWorklet) is
    // plugged in as soon as it is loaded; the old two-tap shifter remains
    // as a fallback if the browser refuses worklets.
    this.preIn = ctx.createGain();
    // MAIN playback (track or stems) → srcGain → preIn: a ROLL
    // cuts srcGain and plays its loop (rollGain) while playback
    // continues silently underneath — on release, the track resumes
    // where it would have been (like a CDJ's slip mode)
    this.srcGain = ctx.createGain();
    this.srcGain.connect(this.preIn);
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollGain.connect(this.preIn);
    this._roll = null;
    this.shifter = new PitchShifter(ctx);
    this.shifter.output.connect(this.trim);
    // TWO PERMANENT PATHS: direct (dirGain) and transposed (wsOut, after
    // the WSOLA engine). Switching is done with GAINS, crossfaded — never again
    // an abrupt reconnection (audio dropout on every KEY press).
    this.dirGain = ctx.createGain();
    this.preIn.connect(this.dirGain);
    this.dirGain.connect(this.trim);
    this.wsOut = ctx.createGain();
    this.wsOut.gain.value = 0;
    this.wsOut.connect(this.trim);
    // SCRATCH grains and turntable effects: straight to the EQ, bypassing
    // the transposition (zero latency under the hand)
    this.scrubIn = ctx.createGain();
    this.scrubIn.connect(this.trim);
    /** Key shift in semitones, integer -7..+7. */
    this.keyShift = 0;
    /** DETECTED key of the track (0-23, see analysis/key.js), or null. */
    this.musicKey = null;
    /** Keep the key when the tempo changes. */
    this.keylock = false;
    this.wsola = null;      // AudioWorkletNode, set by the engine
    this.wsLat = 0;         // FIXED latency of the WSOLA engine (s)
    this.procLat = 0;       // latency of the ACTIVE path: the track is read that much AHEAD
    this._routeW = false;   // does the sound go through the WSOLA transposer?
    this._pitchOn = false;  // (fallback engine) is transposition active?

    // Stems (vocals / drums / bass / instrumental): 4 synchronized sources
    this.stems = null;
    this.stemsOn = false;
    this.stemGains = {};
    this._stemOn = {};
    for (const s of STEM_NAMES) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(this.srcGain);
      this.stemGains[s] = g;
      this._stemOn[s] = true;
    }
    this._extraSources = [];

    /** The decoded track, or null. */
    this.buffer = null;
    /** Caller metadata given to load() / loadFrom() ({ track }). */
    this.track = null;
    /** Precomputed waveform peaks, or null. */
    this.peaks = null;
    /** Track BPM (from the grid), or null. */
    this.bpm = null;
    /** Position of the first beat (fixed grid, fallback), or null. */
    this.beatOffset = null;
    /** DYNAMIC grid: actual position of each beat (file s), or null. */
    this.beats = null;
    /** Manual grid offset of a beat list (s). */
    this.gridShift = 0;
    /** Index of the beat that starts a bar (GRID). */
    this.barAnchor = 0;
    /** Instantaneous playback rate (includes the sync micro-corrections). */
    this.tempo = 1;
    /** Whether the deck is playing. */
    this.playing = false;
    this.offset = 0;
    this.startCtx = 0;
    /** The main cue point (file s). */
    this.cuePoint = 0;
    this.source = null;
    this._stopping = false;
    /** SYNC flag. */
    this.synced = false;
    this._resetSyncCal();

    /** Channel fader, 0..1 (default 0.85). */
    this.volume = 0.85;
    this.fader.gain.value = this.volume * this.volume;
    /** EQ knob values, -1..1. */
    this.eq = { low: 0, mid: 0, high: 0 };
    // web-engine: the OpenMix bass kill (_lowBeforeKill) generalized to the 3 bands
    this._killMemo = { low: null, mid: null, high: null };
    this.filterVal = 0;

    /** Hot cues (file s or null), one per slot. */
    this.hotCues = new Array(engine._hotCueCount).fill(null);
    this.looping = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this._loopInPoint = null;
    /** Quantize hot cues, loop starts and loop IN/OUT to the grid (default true). */
    this.quantize = true;

    this._endedAt = null;
    this._schedTempo = null;
    this._padRoll = null;    // pad ROLL held: { beats, mix }
    this._userRoll = null;   // web-engine: roll started with startRoll()
    this._padFxPreset = null;
    this._padDryHold = null;
    this._nudge = null;      // jog bend in progress: { base, amount }
    this._spin = null;       // V.BRAKE / BACKSPIN in progress
    this._spinSrc = null;
    this._scrub = null;      // scratch gesture in progress
    this._scrubbing = false;
    this._cueHold = false;   // CUE held (preview)
    this._loadJob = null;
    this._dryCur = 1;
  }

  // Listener exceptions go to the engine's onError (DESIGN §5.2)
  _listenerError(err) {
    this.engine._reportError(err);
  }

  // ------------------------------------------------------------- state ---

  /** Whether a track is loaded. */
  get loaded() {
    return !!this.buffer;
  }

  /** Track duration in seconds (0 when empty). */
  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /** HEARD position (file s); negative during pre-roll. Same as currentTime(). */
  get position() {
    return this.currentTime();
  }

  /** = position, except during a spin FX: the virtual position of the track. */
  get displayPosition() {
    // During a V.BRAKE / BACKSPIN, the track virtually "keeps going"
    // underneath: the DISPLAY follows that real progress, not the audible
    // rewind — you see where you are and where playback will resume, so you
    // can DOSE the effect down to the beat
    const s = this._spin;
    if (s && s.wasPlaying) {
      return Math.min(this.duration || 0, s.pos0 + (this.ctx.currentTime - s.start) * (this.tempo || 1));
    }
    return this.currentTime();
  }

  /** Tempo without the sync servo correction (display this). */
  get baseTempo() {
    return this.tempo / (1 + (this._pllCorr || 0));
  }

  /** Processing latency compensated by read-ahead (s). */
  get latency() {
    return this.procLat;
  }

  /** bpm × baseTempo, or null. */
  get effectiveBpm() {
    // web-engine: the servo micro-correction is excluded (OpenMix removed it at display time)
    return this.bpm ? this.bpm * this.baseTempo : null;
  }

  /** Real seconds per beat now (local grid period / baseTempo), or null. */
  get beatDuration() {
    // REAL duration of one beat of a deck, at the speed it is playing (tempo
    // included, sync micro-corrections removed: otherwise the echo delays
    // kept "breathing") and based on the LOCAL grid
    if (!this.bpm) return null;
    const per = this.engine._localPeriod(this) || 60 / this.bpm;
    return per / (this.baseTempo || 1);
  }

  /** = engine.gridOffset (read by the grid helpers). */
  get globalGridOffset() {
    return this.engine.gridOffset;
  }

  /** Whether this deck is the effective master. */
  get isMaster() {
    return this.engine.masterIndex === this.index;
  }

  /** Key heard from this deck ({ code, cents }), or null. */
  get heardKey() {
    if (!this.buffer) return null;
    // web-engine: based on baseTempo (stable display, no servo flicker)
    return heardKeyOf({ musicKey: this.musicKey, keyShift: this.keyShift, keylock: this.keylock, tempo: this.baseTempo });
  }

  /** Loop state (a fresh object per read). */
  get loop() {
    return {
      active: this.looping,
      start: this.loopStart,
      end: this.loopEnd,
      beats: this._loopBeatsOf(this.loopStart, this.loopEnd),
      inPoint: this._loopInPoint
    };
  }

  /** Trim knob, -1..1. */
  get trimValue() {
    return this.trimVal;
  }

  /** Kill state of each EQ band. */
  get kills() {
    return Object.freeze({
      low: this._killMemo.low != null,
      mid: this._killMemo.mid != null,
      high: this._killMemo.high != null
    });
  }

  /** The FILTER knob, -1..1. */
  get filterValue() {
    return this.filterVal;
  }

  /** PFL: the deck is sent to the headphone bus. */
  get headphoneCue() {
    return this.cueOn;
  }

  /** Crossfader side: 'A', 'B' or 'thru'. */
  get crossfaderSide() {
    return this.engine._xfSides[this.index];
  }

  /** Whether the stems play instead of the mix. */
  get stemsActive() {
    return this.stemsOn;
  }

  /** On/off state of each stem. */
  get stemStates() {
    return Object.freeze({ ...this._stemOn });
  }

  /** The pad FX held on this deck (a copy), or null. */
  get padFx() {
    return this._padFxPreset ? { ...this._padFxPreset } : null;
  }

  /** The slip roll playing now ({ beats, mix }), or null. */
  get roll() {
    const r = this._roll;
    return r ? { beats: r.beats, mix: Math.max(0, r.mix) } : null;
  }

  /** A brake / backspin effect is in progress. */
  get spinning() {
    return !!this._spin;
  }

  /** A scrub gesture is in progress. */
  get scrubbing() {
    return !!this._scrub;
  }

  /** A nudge (pitch bend) is in progress. */
  get nudging() {
    return !!this._nudge;
  }

  // ----------------------------------------------------------- events ----

  _emitTransport(type) {
    this._emit(type, { deck: this, index: this.index, position: this.currentTime() });
  }

  _emitLoop() {
    this._emit('loop', { deck: this, index: this.index, ...this.loop });
  }

  _emitGrid() {
    this._emit('grid', {
      deck: this,
      index: this.index,
      bpm: this.bpm,
      beats: this.beats,
      beatOffset: this.beatOffset,
      barAnchor: this.barAnchor,
      gridShift: this.gridShift
    });
  }

  _setSynced(on) {
    const v = !!on;
    if (this.synced === v) return;
    this.synced = v;
    this._emit('sync', { deck: this, index: this.index, synced: v });
  }

  // Sync calibration back to a blank state (new track, grid change…)
  _resetSyncCal() {
    this._syncBase = null;
    this._syncRef = null;
    this._syncWant = null;
    this._pllCorr = 0;
    this._syncPhaseOff = 0;
    this._phaseFree = false;
    this._ratioCal = false;
    this._ratioMeas = null;
    this._ratioPasses = 0;
    this._ratioTries = 0;
    this._errFilt = 0;
    this._lastWant = null;
    this._servoAt = null;
  }

  // web-engine: leaving SYNC drops the servo's micro-correction, so that the
  // deck carries on at its base tempo (OpenMix kept a stale correction)
  _dropCorrection() {
    if (!this._pllCorr) return;
    const base = this.tempo / (1 + this._pllCorr);
    this._pllCorr = 0;
    this._setRate(base);
  }

  // Grid edits (BPM correction, ×2/÷2…): the old sync ratio is obsolete
  _leaveSync() {
    this._dropCorrection();
    this._resetSyncCal();
    this._setSynced(false);
  }

  // ---------------------------------------------------------- loading ----

  /**
   * Loads a decoded track (OpenMix loadTrack). Stops playback; resets
   * position, cue point, loop, tempo, key shift, stems and sync calibration.
   * SYNC and keylock stay as they are. Emits 'load'.
   * @param {AudioBuffer} buffer
   * @param {object} [meta] LoadMeta: bpm, beats, beatOffset, barAnchor, gridShift,
   *   hotCues, cuePoint, peaks, musicKey, track
   */
  load(buffer, meta = {}) {
    if (!isAudioBufferLike(buffer)) throw new TypeError('deck.load: expected an AudioBuffer');
    this._cancelLoad();
    this._load(buffer, meta && typeof meta === 'object' ? meta : {});
  }

  _load(buffer, m) {
    this._stopEverything();
    this.buffer = buffer;
    this._applyGridMeta(m);
    this.peaks = m.peaks || null;
    this.track = m.track !== undefined ? m.track : null;
    this.offset = 0;
    this.cuePoint = isFiniteNum(m.cuePoint) ? clamp(m.cuePoint, -PRE_ROLL, buffer.duration) : 0;
    this.tempo = 1;
    // SYNC STAYS ON from one track to the next (like on a CDJ): it
    // shouldn't have to be pressed again on every load. The new track does,
    // however, restart from a BLANK ratio — the old one means nothing
    // for it — and the lock re-aligns it to the master from the first frame.
    this._resetSyncCal();
    this._resetLoop();
    this._resetStems();
    this.setKey(0);
    this.hotCues = new Array(this.engine._hotCueCount).fill(null);
    if (Array.isArray(m.hotCues)) {
      m.hotCues.slice(0, this.hotCues.length).forEach((c, i) => { this.hotCues[i] = isFiniteNum(c) ? c : null; });
    }
    this.musicKey = isKeyCode(m.musicKey) ? m.musicKey : null;
    this._emit('load', { deck: this, index: this.index, track: this.track, duration: this.duration });
  }

  _applyGridMeta(m) {
    const beats = beatList(m.beats);
    this.beats = beats;
    // When beats come without a BPM, the BPM is the median beat interval
    this.bpm = validBpm(m.bpm) || (beats ? bpmFromBeats(beats) : null);
    // web-engine: a beat list without beatOffset starts at its first beat
    this.beatOffset = isFiniteNum(m.beatOffset) ? m.beatOffset : (beats ? beats[0] : null);
    this.gridShift = isFiniteNum(m.gridShift) ? m.gridShift : 0;
    this.barAnchor = isFiniteNum(m.barAnchor) ? Math.round(m.barAnchor) : 0;
  }

  // Stops playback and every performance gesture (load / eject / destroy)
  _stopEverything(silent = false) {
    const wasPlaying = this.playing;
    if (this._nudge) this.endNudge();
    if (this._spin) {
      this._spin = null;
      this._stopSpinSound();
    }
    this._scrub = null;
    this._scrubbing = false;
    this._cueHold = false;
    this._stopRoll(true);
    this._padRoll = null;
    this._userRoll = null;
    if (this._padFxPreset && this._padFxPreset.type === 'roll') this._padFxPreset = null;
    this._stopSource();
    this.playing = false;
    this._endedAt = null;
    if (wasPlaying && !silent) this._emitTransport('pause');
  }

  // web-engine: a new track also forgets the previous loop and IN point
  // (OpenMix kept them, so a reloop could restart the old track's loop)
  _resetLoop() {
    this.looping = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this._loopInPoint = null;
  }

  // web-engine: the stem gains and states are reset too (OpenMix only
  // dropped the buffers)
  _resetStems() {
    this.stems = null;
    this.stemsOn = false;
    for (const s of STEM_NAMES) {
      this._stemOn[s] = true;
      this.stemGains[s].gain.value = 1;
    }
  }

  /**
   * Decodes, analyzes what `options` does not provide, then loads.
   * Calls engine.resume() synchronously (user gesture). A newer loadFrom()
   * on this deck, or an abort through `signal`, rejects with an AbortError.
   * @param {string | URL | Blob | ArrayBuffer | AudioBuffer} source
   * @param {object} [options] LoadFromOptions
   * @returns {Promise<object>} LoadResult: the values applied to the deck
   */
  loadFrom(source, options = {}) {
    const o = options && typeof options === 'object' ? options : {};
    // The user gesture is still valid here: resume the context right away
    this.engine._resumeQuietly();
    this._cancelLoad();
    const job = { cancelled: false, done: false, reject: null, cleanup: null };
    this._loadJob = job;
    return new Promise((resolve, reject) => {
      job.reject = reject;
      const signal = o.signal || null;
      if (signal) {
        if (signal.aborted) {
          this._abortJob(job);
          return;
        }
        const onAbort = () => this._abortJob(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this._runLoad(job, source, o, signal).then((res) => {
        if (job.cancelled) return;
        this._finishJob(job);
        resolve(res);
      }, (err) => {
        if (job.cancelled) return;
        this._finishJob(job);
        reject(err);
      });
    });
  }

  async _runLoad(job, source, o, signal) {
    const buffer = await this.engine._decode(source, signal);
    if (job.cancelled) return null;
    // Analyze what the caller does not provide: grid unless bpm/beats,
    // key unless musicKey, peaks unless peaks
    const given = { grid: o.bpm != null || o.beats != null, key: o.musicKey != null, peaks: o.peaks != null };
    const ao = o.analyze === false ? null : (o.analyze && typeof o.analyze === 'object' ? o.analyze : {});
    let res = null;
    if (ao) {
      const want = {
        bpm: !given.grid && ao.bpm !== false,
        key: !given.key && ao.key !== false,
        peaks: !given.peaks && ao.peaks !== false
      };
      if (want.bpm || want.key || want.peaks) {
        res = await analyzeTrack(buffer, { ...ao, ...want });
        if (job.cancelled) return null;
      }
    }
    const analyzedGrid = res && !given.grid && res.bpm != null;
    const meta = {
      bpm: given.grid ? o.bpm : (analyzedGrid ? res.bpm : null),
      beats: given.grid ? o.beats : (analyzedGrid ? res.beats : null),
      beatOffset: o.beatOffset != null ? o.beatOffset : (analyzedGrid ? res.beatOffset : null),
      barAnchor: o.barAnchor != null ? o.barAnchor : (analyzedGrid ? res.barAnchor : 0),
      gridShift: o.gridShift,
      hotCues: o.hotCues,
      cuePoint: o.cuePoint,
      track: o.track,
      peaks: given.peaks ? o.peaks : (res ? res.peaks : null),
      musicKey: given.key ? o.musicKey : (res ? res.musicKey : null)
    };
    this._load(buffer, meta);
    return {
      buffer,
      bpm: this.bpm,
      beats: this.beats,
      beatOffset: this.beatOffset,
      barAnchor: this.barAnchor,
      rigid: analyzedGrid ? !!res.rigid : false,
      musicKey: this.musicKey,
      keyConfidence: res && !given.key && res.musicKey != null ? res.keyConfidence : null,
      peaks: this.peaks
    };
  }

  _cancelLoad() {
    if (this._loadJob) this._abortJob(this._loadJob);
  }

  _abortJob(job) {
    if (job.done) return;
    job.cancelled = true;
    this._finishJob(job);
    if (job.reject) job.reject(abortError());
  }

  _finishJob(job) {
    job.done = true;
    if (this._loadJob === job) this._loadJob = null;
    if (job.cleanup) job.cleanup();
    job.cleanup = null;
  }

  /**
   * Stops the deck and clears everything track-related (buffer, grid, peaks,
   * track, stems, loop, hot cues). Emits 'eject'.
   */
  eject() {
    this._cancelLoad();
    if (!this.buffer) return;
    this._stopEverything();
    this.buffer = null;
    this.track = null;
    this.peaks = null;
    this.bpm = null;
    this.beats = null;
    this.beatOffset = null;
    this.gridShift = 0;
    this.barAnchor = 0;
    this.musicKey = null;
    this.offset = 0;
    this.cuePoint = 0;
    this.tempo = 1;
    this._resetSyncCal();
    this._resetLoop();
    this._resetStems();
    this.setKey(0);
    this.hotCues = new Array(this.engine._hotCueCount).fill(null);
    this._emit('eject', { deck: this, index: this.index });
  }

  /**
   * Sets the waveform peaks, without any other effect.
   * @param {object | null} peaks
   */
  setPeaks(peaks) {
    this.peaks = peaks && typeof peaks === 'object' ? peaks : null;
  }

  /**
   * Sets the detected key code (0..23) or null, without any other effect.
   * @param {number | null} code
   */
  setMusicKey(code) {
    if (code == null) {
      this.musicKey = null;
      return;
    }
    if (!isNum(code)) return;
    if (!isKeyCode(code)) throw new RangeError(`Key code out of range (0..23): ${code}`);
    this.musicKey = code;
  }

  _makeSource() {
    this._extraSources = [];
    const mk = (buffer, dest) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buffer;
      s.playbackRate.value = this.tempo;
      if (this.looping) {
        s.loop = true;
        s.loopStart = this.loopStart;
        s.loopEnd = this.loopEnd;
      }
      s.connect(dest);
      return s;
    };
    const tag = (s, name) => { s._stem = name; return s; };
    if (this.stemsOn && this.stems) {
      let primary = null;
      for (const name of ['drums', 'bass', 'other', 'vocals']) {
        if (!this.stems[name]) continue; // (bass + melodies merged)
        const s = tag(mk(this.stems[name], this.stemGains[name]), name);
        if (primary) this._extraSources.push(s);
        else primary = s;
      }
      if (primary) return primary;
    }
    return mk(this.buffer, this.srcGain);
  }

  // ------------------------------------------------------------- ROLL ----

  // --- ROLL (repeat loop locked to the grid) ---
  // beats = loop length in beats (¼, ½, 1…); mix = intensity
  // (0 = track only, 1 = loop only). The loop starts at the LAST
  // multiple of "beats" on the grid: the sound continues normally
  // until the end of the slice, then repeats — right on time.
  _startRoll(beats, mix = 1) {
    if (!this.buffer || !this.playing || !(beats > 0)) return false;
    const pos = this.currentTime();
    if (pos < 0) return false;
    let start;
    let end;
    if (this.beats) {
      const f = gridIndexFracAt(this, pos);
      const anchor = this.barAnchor || 0;
      const k0 = Math.floor((f - anchor) / beats + 1e-6) * beats + anchor;
      start = gridTimeAtIndex(this, k0);
      end = gridTimeAtIndex(this, k0 + beats);
    } else if (this.bpm) {
      const per = 60 / this.bpm;
      const off = this.beatOffset || 0;
      const k0 = Math.floor((pos - off) / (per * beats) + 1e-6);
      start = off + k0 * per * beats;
      end = start + per * beats;
    } else {
      return false;
    }
    if (start == null || end == null || end - start < 0.01) return false;
    start = Math.max(0, start);
    end = Math.min(this.duration, end);
    if (end - start < 0.01) return false;
    // already rolling on the same slice: only the amount changes
    if (this._roll && Math.abs(this._roll.start - start) < 1e-4 && Math.abs(this._roll.end - end) < 1e-4) {
      this._setRollMix(mix);
      return true;
    }
    this._stopRoll(true);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
    src.playbackRate.value = this.tempo;
    src.connect(this.rollGain);
    const at = this.ctx.currentTime + 0.01;
    let off = pos + (0.01 + this.procLat) * this.tempo;
    if (off >= end) off = start + ((off - start) % (end - start));
    if (off < start) off = start;
    src.start(at, off);
    this._roll = { src, start, end, beats, mix: -1 };
    this._setRollMix(mix, at);
    return true;
  }

  _setRollMix(mix, at) {
    if (!this._roll) return;
    const m = clamp(mix, 0, 1);
    if (Math.abs(m - this._roll.mix) < 0.005) return;
    this._roll.mix = m;
    const t = at || this.ctx.currentTime;
    this._rampGain(this.srcGain.gain, 1 - m, t);
    this._rampGain(this.rollGain.gain, m, t);
  }

  // Clean ramp: first clear everything that was scheduled (a
  // release arriving before the roll started otherwise left the deck MUTED)
  _rampGain(param, v, at) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(v, Math.max(now, at), 0.004);
  }

  _stopRoll(immediate) {
    const r = this._roll;
    if (!r) return;
    this._roll = null;
    const t = this.ctx.currentTime;
    this._rampGain(this.srcGain.gain, 1, t);
    this._rampGain(this.rollGain.gain, 0, t);
    try { r.src.stop(t + (immediate ? 0.02 : 0.04)); } catch { /* already stopped */ }
    r.src.onended = () => { try { r.src.disconnect(); } catch { /* nothing */ } };
  }

  /**
   * Slip roll: loops the current grid slice of `beats` beats (slices aligned
   * to multiples of `beats` from barAnchor) while the track keeps running
   * silently underneath. Needs a playing deck with a grid.
   * @param {number} beats > 0
   * @param {number} [mix=1] 0 = track only, 1 = loop only
   * @returns {boolean}
   */
  startRoll(beats, mix = 1) {
    if (!isNum(beats) || !isNum(mix)) return false;
    const ok = this._startRoll(beats, mix);
    // web-engine: remembered, so that tick() keeps it (it only drove pad and FX rolls)
    if (ok) this._userRoll = { beats, mix: clamp(mix, 0, 1) };
    return ok;
  }

  /**
   * Roll intensity: 0 = track only, 1 = loop only.
   * @param {number} mix
   */
  setRollMix(mix) {
    if (!isNum(mix)) return;
    const m = clamp(mix, 0, 1);
    const intent = this._padRoll || this._userRoll;
    if (intent) intent.mix = m;
    this._setRollMix(m);
  }

  /** Stops the roll: the track resumes exactly where it would be. */
  stopRoll() {
    this._userRoll = null;
    if (this._padRoll) {
      this._padRoll = null;
      if (this._padFxPreset && this._padFxPreset.type === 'roll') this._padFxPreset = null;
    }
    this._stopRoll(false);
  }

  // -------------------------------------------------- timing model -------

  // SCHEDULED start at an exact instant: start(0) starts "as soon as
  // possible" with a few ms of imprecision, which created a micro-offset
  // on every play/seek/sync. Here the bookkeeping is sample-accurate.
  // heard = desired HEARD position at the start instant. When the sound
  // goes through the transposer (latency procLat), the track is READ that
  // much ahead: what you hear lands exactly on the grid. readAhead=false
  // (PLAY from stop): read from heard without skipping anything — the sound
  // comes out procLat later, attack intact, and the clock accounts for it.
  _startAll(when, heard, readAhead = true) {
    const at = this.ctx.currentTime + 0.03;
    this._schedTempo = this.tempo; // tempo used to schedule the start
    const lead = this.procLat * this.tempo;
    const offset = readAhead ? heard + lead : heard;
    this.offset = offset - lead; // anchor for currentTime(): heard position at "at"
    if (offset < 0) {
      const at2 = at + (-offset) / this.tempo;
      this.source.start(at2, 0);
      for (const s of this._extraSources) s.start(at2, 0);
    } else {
      this.source.start(at, offset);
      for (const s of this._extraSources) s.start(at, offset);
    }
    return at;
  }

  /**
   * Generic insert between the FILTER and the fader, cue and meter taps.
   * Its fixed latency is compensated by read-ahead: the track is read that
   * much ahead, so what you hear stays on the beat grid (sync, waveforms,
   * cues). While playing, the sources restart at the heard position with
   * the new read-ahead (one brief restart, only when the latency changes).
   * @param {AudioNode | null} node
   * @param {number} [latency=0] fixed latency of the node, in seconds
   */
  setInsert(node, latency = 0) {
    if (node != null && (typeof node !== 'object' || typeof node.connect !== 'function')) {
      throw new TypeError('deck.setInsert: expected an AudioNode or null');
    }
    const next = node || null;
    if (this.insert) {
      try { this.filter.disconnect(this.insert); } catch { /* not connected */ }
      try { this.insert.disconnect(this.post); } catch { /* not connected */ }
    } else {
      try { this.filter.disconnect(this.post); } catch { /* not connected */ }
    }
    try {
      if (next) {
        this.filter.connect(next);
        next.connect(this.post);
      } else {
        this.filter.connect(this.post);
      }
    } catch (e) {
      // web-engine: a node that cannot be wired (other context…) leaves the channel intact
      if (next) {
        try { this.filter.disconnect(next); } catch { /* not connected */ }
        try { next.disconnect(this.post); } catch { /* not connected */ }
      }
      this.insert = null;
      this.filter.connect(this.post);
      this._applyInsertLatency(0);
      throw e;
    }
    this.insert = next;
    this._applyInsertLatency(next && isFiniteNum(latency) ? Math.max(0, latency) : 0);
  }

  _applyInsertLatency(latency) {
    this.insertLat = latency;
    const total = (this._routeW ? this.wsLat : 0) + this.insertLat;
    if (Math.abs(total - this.procLat) < 1e-6) return;
    if (this.playing && this.buffer) {
      const heard = this.currentTime();
      this.procLat = total;
      this.seek(heard);
    } else {
      this.procLat = total;
    }
  }

  // ------------------------------------------------------------ stems ----

  /**
   * Plays separated stems instead of the mix (buffers on the track's
   * timeline; bass + other is the instrumental). Restarts seamlessly when
   * playing. No-op without a track.
   * @param {{ vocals?: AudioBuffer, drums?: AudioBuffer, bass?: AudioBuffer, other?: AudioBuffer }} stems
   */
  loadStems(stems) {
    if (!stems || typeof stems !== 'object') throw new TypeError('deck.loadStems: expected an object of AudioBuffers');
    const set = {};
    let n = 0;
    for (const [name, buf] of Object.entries(stems)) {
      if (!STEM_NAMES.includes(name)) throw new RangeError(`Unknown stem: ${name}`);
      if (buf == null) continue;
      if (!isAudioBufferLike(buf)) throw new TypeError(`deck.loadStems: ${name} is not an AudioBuffer`);
      set[name] = buf;
      n++;
    }
    if (!n) throw new TypeError('deck.loadStems: at least one stem buffer is needed');
    if (!this.buffer) return;
    // Enables the separated stems (vocals/drums/bass/instrumental) on this deck
    this.stems = set;
    this.stemsOn = true;
    for (const s of STEM_NAMES) {
      this._stemOn[s] = true;
      this.stemGains[s].gain.value = 1;
    }
    if (this.playing) this.seek(this.currentTime());
  }

  /** Back to the full mix (seamless restart when playing). */
  clearStems() {
    if (!this.stemsOn && !this.stems) return;
    this._resetStems();
    if (this.playing) this.seek(this.currentTime());
  }

  /**
   * Mutes or unmutes one stem.
   * @param {'vocals' | 'drums' | 'bass' | 'other'} name
   * @param {boolean} on
   */
  setStem(name, on) {
    if (!STEM_NAMES.includes(name)) throw new RangeError(`Unknown stem: ${String(name)}`);
    const v = !!on;
    this._stemOn[name] = v;
    this.stemGains[name].gain.setTargetAtTime(v ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /**
   * Toggles one stem.
   * @param {'vocals' | 'drums' | 'bass' | 'other'} name
   * @returns {boolean} the new state
   */
  toggleStem(name) {
    if (!STEM_NAMES.includes(name)) throw new RangeError(`Unknown stem: ${String(name)}`);
    // web-engine: the state is tracked (reading gain.value mid-ramp misread fast toggles)
    const on = !this._stemOn[name];
    this.setStem(name, on);
    return on;
  }

  // -------------------------------------------------------------- key ----

  /**
   * Key in semitones (-7..+7), without changing the speed.
   * @param {number} semitones rounded to an integer
   */
  setKey(semitones) {
    if (!isNum(semitones)) return;
    this.keyShift = clamp(Math.round(semitones), KEY_SHIFT_MIN, KEY_SHIFT_MAX);
    this._applyPitch();
  }

  /**
   * KEYLOCK: keep the original key when the tempo changes.
   * @param {boolean} on
   */
  setKeylock(on) {
    this.keylock = !!on;
    this._applyPitch();
  }

  // TOTAL transposition ratio = chosen key × tempo
  // compensation (keylock). A tempo of 1.06 raises the sound by ~1 semitone: the
  // keylock applies the inverse to cancel exactly that rise.
  _applyPitch() {
    const key = Math.pow(2, this.keyShift / 12);
    const lock = this.keylock && this.tempo > 0 ? 1 / this.tempo : 1;
    const ratio = clamp(key * lock, 0.5, 1.8);
    const node = this.wsola;
    if (node) {
      // Transposed path as long as KEYLOCK or KEY ≠ 0 — STABLE decision:
      // the old threshold on the ratio made the sound enter/leave the
      // transposer every time the sync made the tempo oscillate
      // around 1 (dropouts, latency jumps)
      const want = this.keylock || this.keyShift !== 0;
      if (want !== this._routeW) this._switchRoute(want);
      node.parameters.get('ratio').setTargetAtTime(want ? ratio : 1, this.ctx.currentTime, 0.02);
      return;
    }
    // FALLBACK engine (browser without worklets): the old behavior
    const need = Math.abs(ratio - 1) > 0.0015;
    if (need !== this._pitchOn) {
      this._pitchOn = need;
      try { this.preIn.disconnect(this.shifter.input); } catch { /* not connected */ }
      if (need) this.preIn.connect(this.shifter.input);
      this.dirGain.gain.setValueAtTime(need ? 0 : 1, this.ctx.currentTime);
    }
    if (need) this.shifter.setRatio(ratio);
  }

  // The engine plugs the WSOLA node in once the worklet is loaded
  _installWsola(node, sampleRate) {
    // web-engine: if the fallback shifter was already engaged (key or
    // keylock set before the worklet arrived), unplug it: the two would sound
    if (this._pitchOn) {
      this._pitchOn = false;
      try { this.preIn.disconnect(this.shifter.input); } catch { /* not connected */ }
    }
    // Connected PERMANENTLY in parallel with the direct path: only the output
    // gain (wsOut) decides what is heard
    this.preIn.connect(node);
    node.connect(this.wsOut);
    // FIXED latency of the engine (announced by it; value known in advance
    // so as not to depend on the message arriving)
    this.wsLat = WSOLA_LATENCY_SAMPLES / sampleRate;
    node.port.onmessage = (e) => {
      if (e.data && e.data.lat) {
        this.wsLat = e.data.lat / sampleRate;
        if (this._routeW) this.procLat = this.wsLat + this.insertLat;
      }
    };
    this.wsola = node;
    this._applyPitch(); // re-route if a key was already set
  }

  // Entering / leaving the transposer WITHOUT A GAP OR OFFSET. The engine has a
  // fixed latency L: the track must be read L ahead to sound on
  // time. On ENTRY, the old sound continues direct for L (the
  // time for the transposer to fill up) then hands over with a crossfade;
  // on EXIT, the direct path resumes exactly where we are.
  _switchRoute(on) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const L = on ? this.wsLat : 0;
    const ramp = (param, v, t) => {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.setValueAtTime(param.value, Math.max(now, t));
      param.linearRampToValueAtTime(v, Math.max(now, t) + 0.006);
    };
    if (!this.playing || !this.buffer) {
      this._routeW = on;
      this.procLat = L + this.insertLat;
      ramp(this.dirGain.gain, on ? 0 : 1, now);
      ramp(this.wsOut.gain, on ? 1 : 0, now);
      return;
    }
    const heard = this.currentTime();
    const old = [this.source, ...this._extraSources].filter(Boolean);
    this.source = null;
    this._extraSources = [];
    this._routeW = on;
    this.procLat = L + this.insertLat;
    const at = now + 0.03;
    if (on) {
      // the old sound keeps flowing DIRECT until the transposer outputs
      // the new one, then fades out
      const tail = ctx.createGain();
      tail.connect(this.trim);
      tail.gain.setValueAtTime(1, now);
      tail.gain.setValueAtTime(1, at + L);
      tail.gain.linearRampToValueAtTime(0, at + L + 0.006);
      for (const src of old) {
        try { src.disconnect(); } catch { /* nothing */ }
        const g = ctx.createGain();
        // a muted stem (VOX…) stays muted during the tail too
        g.gain.value = src._stem ? this.stemGains[src._stem].gain.value : this.srcGain.gain.value;
        src.connect(g);
        g.connect(tail);
        src.onended = () => { try { src.disconnect(); g.disconnect(); tail.disconnect(); } catch { /* nothing */ } };
        try { src.stop(at + L + 0.012); } catch { /* already stopped */ }
      }
      ramp(this.dirGain.gain, 0, now);
      this.wsOut.gain.cancelScheduledValues(now);
      this.wsOut.gain.setValueAtTime(0, now);
      this.wsOut.gain.setValueAtTime(0, at + L);
      this.wsOut.gain.linearRampToValueAtTime(1, at + L + 0.006);
    } else {
      for (const src of old) {
        src.onended = null;
        try { src.stop(at); } catch { /* already stopped */ }
      }
      ramp(this.dirGain.gain, 1, at);
      ramp(this.wsOut.gain, 0, at);
    }
    // new playback, aligned so that the heard sound continues without a jump
    this.source = this._makeSource();
    this._attachEnded(this.source);
    this.startCtx = this._startAll(0, heard + 0.03 * this.tempo, true);
  }

  // ----------------------------------------------------- channel strip ---

  /**
   * Channel fader, 0..1 (gain = v²).
   * @param {number} v
   */
  setVolume(v) {
    if (!isNum(v)) return;
    this.volume = clamp(v, 0, 1);
    // Quadratic curve: more natural to the ear
    this.fader.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.01);
  }

  /**
   * TRIM: -1 -> -12 dB, 0 -> neutral, +1 -> +12 dB (gain = 4^v).
   * @param {number} v
   */
  setTrim(v) {
    if (!isNum(v)) return;
    this.trimVal = clamp(v, -1, 1);
    this.trim.gain.setTargetAtTime(Math.pow(4, this.trimVal), this.ctx.currentTime, 0.01);
  }

  /**
   * EQ band, -1..1: -1 = kill (-40 dB), 0 = flat, +1 = +6 dB.
   * @param {'low' | 'mid' | 'high'} band
   * @param {number} v
   */
  setEq(band, v) {
    if (!EQ_BANDS.includes(band)) throw new RangeError(`Unknown EQ band: ${String(band)}`);
    if (!isNum(v)) return;
    const val = clamp(v, -1, 1);
    // web-engine: while the band is killed, the knob value is remembered for the release
    if (this._killMemo[band] != null) {
      this._killMemo[band] = val;
      return;
    }
    this._applyEq(band, val);
  }

  // band: 'low' | 'mid' | 'high', v in [-1, 1]; -1 = kill (-40 dB), +1 = +6 dB
  _applyEq(band, v) {
    this.eq[band] = v;
    const db = v >= 0 ? v * 6 : v * 40;
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  /**
   * Kill switch: remembers the band's value, sets it to -1 (-40 dB) and
   * restores it on release (the OpenMix bass kill, on any band).
   * @param {'low' | 'mid' | 'high'} band
   * @param {boolean} on
   */
  setKill(band, on) {
    if (!EQ_BANDS.includes(band)) throw new RangeError(`Unknown EQ band: ${String(band)}`);
    const killed = this._killMemo[band] != null;
    if (!!on === killed) return;
    if (on) {
      this._killMemo[band] = this.eq[band];
      this._applyEq(band, -1);
    } else {
      const v = this._killMemo[band];
      this._killMemo[band] = null;
      this._applyEq(band, v);
    }
  }

  /**
   * The channel FILTER knob, -1..1. It follows the engine's color-FX mode
   * ('filter': low-pass left, high-pass right).
   * @param {number} v
   */
  setFilter(v) {
    if (!isNum(v)) return;
    this.engine._setDeckColor(this.index, v);
  }

  // v in [-1, 1]: negative = low-pass (cuts the highs), positive = high-pass (cuts the lows)
  _applyBiquad(v) {
    const f = this.filter;
    if (Math.abs(v) < 0.04) {
      f.type = 'peaking';
      f.gain.value = 0;
      f.frequency.value = 1000;
    } else if (v > 0) {
      f.type = 'highpass';
      f.Q.value = 0.9;
      f.frequency.value = 20 * Math.pow(400, v); // 20 Hz -> 8 kHz
    } else {
      f.type = 'lowpass';
      f.Q.value = 0.9;
      f.frequency.value = 20000 * Math.pow(80 / 20000, -v); // 20 kHz -> 80 Hz
    }
  }

  /**
   * The channel's headphone CUE button (PFL): sends/cuts the deck in the
   * headphones, pre-fader.
   * @param {boolean} on
   */
  setHeadphoneCue(on) {
    this.cueOn = !!on;
    this.cueSend.gain.setTargetAtTime(this.cueOn ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /**
   * Crossfader side of the deck: 'A', 'B' or 'thru' (ignores the crossfader).
   * @param {'A' | 'B' | 'thru'} side
   */
  setCrossfaderSide(side) {
    if (!XF_SIDES.includes(side)) throw new RangeError(`Unknown crossfader side: ${String(side)}`);
    this.engine._xfSides[this.index] = side;
    this.engine._applyCrossfader();
  }

  /**
   * Instantaneous peak level (0..~2) for the VU meter, post EQ, filter and
   * insert, pre-fader.
   * @returns {number}
   */
  meterPeak() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (let i = 0; i < this.meterBuf.length; i += 2) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // ------------------------------------------------------------ loops ----

  /**
   * Sample-accurate native loop (at least 10 ms, clamped to the track).
   * Emits 'loop'.
   * @param {number} start file s
   * @param {number} end file s
   * @returns {boolean}
   */
  setLoop(start, end) {
    if (!isNum(start) || !isNum(end) || !this.buffer) return false;
    if (!this._setLoop(start, end)) return false;
    this._emitLoop();
    return true;
  }

  // --- Loops (sample-accurate via the source's native loop) ---
  _setLoop(start, end) {
    start = Math.max(0, start);
    end = Math.min(this.duration, end);
    if (end - start < 0.01) return false;
    this.loopStart = start;
    this.loopEnd = end;
    this.looping = true;
    for (const s of [this.source, ...this._extraSources]) {
      if (!s) continue;
      s.loopStart = start;
      s.loopEnd = end;
      s.loop = true;
    }
    return true;
  }

  /** Disables the loop (the track continues). Emits 'loop'. */
  exitLoop() {
    if (!this.looping) return;
    // web-engine: not re-anchored during the 30 ms before a scheduled start
    // (the source will start from the existing anchor)
    if (this.playing && this.ctx.currentTime >= this.startCtx) {
      const pos = this.currentTime();
      this.offset = pos;
      this.startCtx = this.ctx.currentTime;
    }
    this.looping = false;
    for (const s of [this.source, ...this._extraSources]) {
      if (s) s.loop = false;
    }
    this._emitLoop();
  }

  /**
   * RELOOP: re-activates the last loop without jumping (the playhead wraps
   * if it is past the end).
   * @returns {boolean} false when there is no previous loop
   */
  reloop() {
    if (!this.buffer) return false;
    if (this.looping) return true;
    if (!(this.loopEnd > this.loopStart && this.loopEnd > 0)) return false;
    return this.setLoop(this.loopStart, this.loopEnd);
  }

  // Loop length on the grid (1/32 beat), null without a grid
  _loopBeatsOf(start, end) {
    if (!this.bpm || !(end > start)) return null;
    let b;
    if (this.beats) {
      const fs = gridIndexFracAt(this, start);
      const fe = gridIndexFracAt(this, end);
      if (fs == null || fe == null) return null;
      b = fe - fs;
    } else {
      b = (end - start) / (60 / this.bpm);
    }
    return Math.round(b * 32) / 32;
  }

  /**
   * N-beat loop snapped to the grid (needs a BPM). With an active loop, it
   * resizes the loop from its start; otherwise it starts at the position,
   * snapped to the nearest ¼ beat when quantize is on. Emits 'loop'.
   * @param {number} beats > 0
   * @returns {boolean}
   */
  beatLoop(beats) {
    if (!isNum(beats) || !(beats > 0) || beats === Infinity || !this.bpm || !this.buffer) return false;
    const period = 60 / this.bpm;
    if (this.looping) {
      // Loop already active: RESIZE it without moving its start
      let end;
      if (this.beats) {
        const fs = gridIndexFracAt(this, this.loopStart);
        end = gridTimeAtIndex(this, fs + beats);
      }
      return this.setLoop(this.loopStart, end != null ? end : this.loopStart + beats * period);
    }
    let start = this.currentTime();
    let end = null;
    // Start ALWAYS snapped to a segment/micro-segment; on a dynamic
    // grid, the loop follows the REAL beats (exact length)
    // (web-engine: the snapping follows deck.quantize)
    if (this.beats) {
      const f = gridIndexFracAt(this, start);
      const q = this.quantize ? Math.round(f * 4) / 4 : f;
      const s = gridTimeAtIndex(this, q);
      if (s != null) start = Math.max(0, s);
      end = gridTimeAtIndex(this, q + beats);
    } else if (this.beatOffset != null && this.quantize) {
      const micro = period / 4;
      const k = Math.round((start - this.beatOffset) / micro);
      start = Math.max(0, this.beatOffset + k * micro);
    }
    return this.setLoop(start, end != null ? end : start + beats * period);
  }

  /**
   * Manual loop IN: stores the IN point (snapped to the nearest beat when
   * quantize is on). Emits 'loop'.
   * @returns {boolean}
   */
  loopIn() {
    if (!this.buffer) return false;
    const t = this.currentTime();
    // web-engine: snapped to the nearest beat only when deck.quantize is on
    this._loopInPoint = this.quantize ? snapToBeat(this, t, 1) : t;
    this._emitLoop();
    return true;
  }

  /**
   * Manual loop OUT: needs an IN point and an OUT more than 50 ms after it;
   * then activates the loop. Emits 'loop'.
   * @returns {boolean}
   */
  loopOut() {
    if (!this.buffer || this._loopInPoint == null) return false;
    const t = this.currentTime();
    const outPoint = this.quantize ? snapToBeat(this, t, 1) : t;
    if (outPoint <= this._loopInPoint + 0.05) return false;
    return this.setLoop(this._loopInPoint, outPoint);
  }

  /**
   * Halves the active loop (down to ⅛ beat, or 50 ms without a BPM).
   * @returns {boolean}
   */
  loopHalve() {
    if (!this.looping) return false;
    const len = this.loopEnd - this.loopStart;
    const minLen = this.bpm ? (60 / this.bpm) / 8 : 0.05;
    if (len / 2 < minLen) return false;
    return this.setLoop(this.loopStart, this.loopStart + len / 2);
  }

  /**
   * Doubles the active loop (its end must stay inside the track).
   * @returns {boolean}
   */
  loopDouble() {
    if (!this.looping) return false;
    const end = this.loopStart + (this.loopEnd - this.loopStart) * 2;
    if (end > this.duration) return false;
    return this.setLoop(this.loopStart, end);
  }

  /**
   * Jumps ±beats on the grid (beat lists follow the real beats). With an
   * active loop, the loop moves by the same amount, clamped to the track.
   * @param {number} beats
   * @returns {boolean} false without a BPM
   */
  beatJump(beats) {
    if (!isFiniteNum(beats) || !this.bpm || !this.buffer) return false;
    const cur = this.currentTime();
    let jump;
    if (this.beats) {
      const f = gridIndexFracAt(this, cur);
      const target = gridTimeAtIndex(this, f + beats);
      jump = target != null ? target - cur : 0;
    } else {
      jump = beats * 60 / this.bpm;
    }
    // Active loop = the loop is what moves
    if (this.looping) {
      const len = this.loopEnd - this.loopStart;
      let ns = this.loopStart + jump;
      ns = Math.max(0, Math.min(this.duration - len, ns));
      const delta = ns - this.loopStart;
      if (delta === 0) return false;
      this.setLoop(ns, ns + len);
      this.seek(Math.max(0, Math.min(this.duration, cur + delta)));
      return true;
    }
    // same clock reading as the jump computation: EXACT landing
    this.seek(cur + jump);
    return true;
  }

  _attachEnded(source) {
    source.onended = () => {
      if (this._stopping) {
        this._stopping = false;
        return;
      }
      if (this.source === source) {
        this.playing = false;
        this.offset = this.duration;
        this.source = null;
        // Natural end of the track: the queue can chain the next one
        // web-engine: audio clock (was the system clock): deterministic offline
        this._endedAt = this.ctx.currentTime;
        this._emitTransport('pause');
        this._emit('ended', { deck: this, index: this.index });
      }
    };
  }

  // -------------------------------------------------------- transport ----

  // Internal start: never re-aligns (cue preview, spin end, scrub end)
  _play(emit = true) {
    if (!this.buffer || this.playing) return false;
    this._endedAt = null;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.source = this._makeSource();
    this._attachEnded(this.source);
    this.startCtx = this._startAll(0, this.offset, false);
    this.playing = true;
    if (emit) this._emitTransport('play');
    return true;
  }

  // Internal start whose HEARD position at the start instant is `heard`
  // (like a seek while playing: compensated for the 30 ms and read ahead)
  _playFrom(heard) {
    if (!this.buffer || this.playing) return false;
    const target = heard + 0.03 * this.tempo;
    if (target >= this.duration - 0.01) return false;
    this._endedAt = null;
    this.offset = target;
    this.source = this._makeSource();
    this._attachEnded(this.source);
    this.startCtx = this._startAll(0, target, true);
    this.playing = true;
    this._emitTransport('play');
    return true;
  }

  /**
   * Starts playback (scheduled 30 ms ahead, sample-accurate; from the end
   * it restarts at 0). A synced deck that is not the master is aligned to
   * the master right after it starts. Emits 'play'.
   */
  play() {
    this.engine._resumeQuietly();
    if (!this._play(false)) return;
    // Play/Pause with SYNC realignment: when a synced deck STARTS, its red
    // lines are immediately aligned to the master's (bar on bar)
    // (never on the MASTER itself: it's the reference, it would have aligned
    // to one of its followers)
    if (this.synced && this.engine.masterIndex !== this.index) this.engine._sync(this.index);
    this._emitTransport('play');
  }

  /** Pauses (keeps the heard position, stops any roll). Emits 'pause'. */
  pause() {
    // web-engine: a pause during a spin (the deck is already paused under the
    // effect) cancels the aligned resume of spinEnd()
    if (this._spin) this._spin.wasPlaying = false;
    if (!this.playing) return;
    this._stopRoll(true);
    this._userRoll = null;
    // pause before the sound has even started: the position doesn't move
    if (this.ctx.currentTime >= this.startCtx) this.offset = this.currentTime();
    // The transposer keeps ~55 ms of sound in reserve: cut it sharply on
    // pause (otherwise that bit replayed a 2nd time on resume)
    if (this._routeW) {
      const g = this.wsOut.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.005);
      g.setValueAtTime(1, now + this.procLat + 0.04);
    }
    this._stopSource();
    this.playing = false;
    // web-engine: a nudge cannot outlive playback (it would hold the lock)
    if (this._nudge) this.endNudge();
    this._emitTransport('pause');
  }

  /** play() when paused, pause() when playing. */
  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  _stopSource() {
    if (this.source) {
      this._stopping = true;
      try { this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* nothing */ }
      this.source = null;
    }
    for (const s of this._extraSources) {
      try { s.stop(); } catch { /* already stopped */ }
      try { s.disconnect(); } catch { /* nothing */ }
    }
    this._extraSources = [];
  }

  /**
   * HEARD position in file seconds (alias of `position`, kept for OpenMix).
   * @returns {number}
   */
  currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    // NO floor at 0 on the elapsed time: during the 30 ms that
    // precede a scheduled start, the position is the EXACT
    // extrapolation (offset − what remains to wait). The old Math.max(0, …)
    // froze it at the FUTURE position: any computation made in that
    // window (SYNC right after PLAY, 1st calibration measurement right after
    // the re-alignment…) started up to 30 ms early — hence the SYNC
    // that had to be pressed 3 or 4 times.
    let t = this.offset + (this.ctx.currentTime - this.startCtx) * this.tempo;
    if (this.looping && t > this.loopEnd) {
      const len = this.loopEnd - this.loopStart;
      t = this.loopStart + ((t - this.loopStart) % len);
    }
    return Math.min(t, this.duration);
  }

  /**
   * Seeks (clamped to [-PRE_ROLL, duration]; negative = silence before the
   * track). Jumping out of the active loop disables it ('loop' event).
   * @param {number} time file s
   */
  seek(time) {
    if (!isNum(time) || !this.buffer) return;
    const t = clamp(time, -PRE_ROLL, this.duration);
    let loopOff = false;
    // Jumping out of the loop disables it
    if (this.looping && (t < this.loopStart || t >= this.loopEnd)) {
      this.looping = false;
      for (const s of [this.source, ...this._extraSources]) {
        if (s) s.loop = false;
      }
      loopOff = true;
    }
    if (this.playing) {
      this._stopSource();
      // COMPENSATION for the scheduled start (30 ms): aim for the position
      // where the sound WOULD have been if the jump were instantaneous. Without it, every
      // jump/sync/hot cue landed 30 ms late and the sync lock
      // audibly "re-aligned" right after the effect.
      let target = t + 0.03 * this.tempo;
      if (target > this.duration) target = this.duration;
      this.offset = target;
      this.source = this._makeSource();
      this._attachEnded(this.source);
      this.startCtx = this._startAll(0, target);
    } else {
      this.offset = t;
    }
    if (loopOff) this._emitLoop();
  }

  // ------------------------------------------------------------- cues ----

  /**
   * CDJ behavior: playing → back to the cue point and pause; paused at the
   * cue point (20 ms) → re-seek to it; paused elsewhere → sets the cue point
   * here ('cuepoint').
   */
  cue() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else if (Math.abs(this.currentTime() - this.cuePoint) < 0.02) {
      this.seek(this.cuePoint);
    } else {
      this.cuePoint = this.currentTime();
      this._emitCuePoint();
    }
  }

  // CDJ-style CUE: hold = the sound plays from the cue point,
  // release = back to the point and stop
  /** CUE button pressed (hold-to-preview, see cueUp). */
  cueDown() {
    this.engine._resumeQuietly();
    if (!this.buffer) return;
    if (this.playing) {
      this.cue(); // back to cue + pause
      return;
    }
    const atCue = Math.abs(this.currentTime() - this.cuePoint) < 0.02;
    if (!atCue) {
      this.cue(); // sets the cue point here
      return;
    }
    this._cueHold = true;
    this._play();
  }

  /** CUE button released: after a preview, back to the cue point and pause. */
  cueUp() {
    if (!this._cueHold) return;
    this._cueHold = false;
    this.pause();
    this.seek(this.cuePoint);
  }

  /**
   * Sets the cue point (default: the position). Emits 'cuepoint'.
   * @param {number} [time]
   */
  setCuePoint(time) {
    if (!this.buffer) return;
    const t = time === undefined ? this.currentTime() : time;
    if (!isNum(t)) return;
    this.cuePoint = clamp(t, -PRE_ROLL, this.duration);
    this._emitCuePoint();
  }

  _emitCuePoint() {
    this._emit('cuepoint', { deck: this, index: this.index, time: this.cuePoint });
  }

  _checkSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.hotCues.length) {
      throw new RangeError(`Hot-cue slot out of range (0..${this.hotCues.length - 1}): ${String(slot)}`);
    }
  }

  /**
   * Sets a hot cue. Without `time`: the position, snapped to the nearest
   * beat when quantize is on. An explicit time is stored as is. Emits 'hotcue'.
   * @param {number} slot
   * @param {number} [time]
   * @returns {boolean} false without a track
   */
  setHotCue(slot, time) {
    this._checkSlot(slot);
    if (!this.buffer) return false;
    let t;
    if (time === undefined) {
      t = this.currentTime();
      // The hot cue always snaps to the start of the nearest segment (beat)
      // (web-engine: unless deck.quantize is off)
      if (this.quantize) t = snapToBeat(this, t, 1);
    } else {
      if (!isNum(time)) return false;
      t = time;
    }
    this.hotCues[slot] = t;
    this._emit('hotcue', { deck: this, index: this.index, slot, time: t });
    return true;
  }

  /**
   * Empties a hot-cue slot. Emits 'hotcue' with time null.
   * @param {number} slot
   */
  clearHotCue(slot) {
    this._checkSlot(slot);
    this.hotCues[slot] = null;
    this._emit('hotcue', { deck: this, index: this.index, slot, time: null });
  }

  /**
   * Hot-cue pad press: sets the slot if empty, otherwise jumps there (the
   * play state is unchanged).
   * @param {number} slot
   * @returns {boolean} false without a track
   */
  hotCue(slot) {
    this._checkSlot(slot);
    if (!this.buffer) return false;
    const c = this.hotCues[slot];
    if (c == null) return this.setHotCue(slot);
    this.seek(c);
    return true;
  }

  // ----------------------------------------------------------- tempo -----

  // Internal rate change (ex OpenMix setTempo): used by the sync servo,
  // never unsyncs. follow=false: the synced decks do NOT follow (nudge).
  _setRate(r, follow = true) {
    r = clamp(r, TEMPO_MIN, TEMPO_MAX);
    if (this.playing && this.ctx.currentTime >= this.startCtx) {
      // playback = heard + latency × tempo: changing the tempo shifts
      // the heard anchor by as much (a few tenths of a ms at most)
      this.offset = this.currentTime() + this.procLat * (this.tempo - r);
      this.startCtx = this.ctx.currentTime;
    }
    // (before a scheduled start, the offset/startCtx anchor stays
    // EXACT as is: the sound will start from offset at startCtx whatever the
    // tempo — rewriting it shifted the clock by what remained to wait)
    this.tempo = r;
    if (this.source) this.source.playbackRate.value = r;
    for (const s of this._extraSources) s.playbackRate.value = r;
    if (this._roll) this._roll.src.playbackRate.value = r;
    // the engine makes the synced decks follow IN THE SAME INSTANT
    // (the master changes tempo — fader, + / −, controller…: otherwise each step
    // left a small offset, "not everything happens at the same time")
    if (follow) this.engine._followMaster(this.index);
    // PRE-ROLL (negative position): the instant the sound will start was
    // scheduled with the OLD tempo. A synced deck receiving its corrections
    // during 10 s of pre-roll therefore started off the grid. We
    // reschedule the start (the sound hasn't started yet: inaudible).
    if (this.playing && Math.abs(r - (this._schedTempo ?? r)) > 1e-5 && this.currentTime() < -0.05) {
      this.seek(this.currentTime());
    }
    // KEYLOCK: the compensation follows the tempo live (including the
    // sync servo's micro-corrections, inaudible but exact)
    if (this.keylock) this._applyPitch();
  }

  /**
   * Tempo ratio, clamped to [TEMPO_MIN, TEMPO_MAX]. A synced follower leaves
   * SYNC first (like moving its tempo fader); on the master, the synced
   * followers follow in the same call.
   * @param {number} ratio 1 = original speed
   */
  setTempo(ratio) {
    if (!isNum(ratio)) return;
    const r = clamp(ratio, TEMPO_MIN, TEMPO_MAX);
    const isMaster = this.engine.masterIndex === this.index;
    // web-engine: the tempo-fader rules of the OpenMix UI live here now —
    // tempo fader of a synced follower: it leaves SYNC
    if (!isMaster && this.synced) this.unsync();
    if (isMaster) {
      // The master's own correction is removed and its sync base follows
      this._pllCorr = 0;
      if (this._syncBase) this._syncBase = r;
    }
    if (this._nudge) this._nudge.base = r;
    this._setRate(r);
  }

  /**
   * setTempo(bpm / deck.bpm).
   * @param {number} bpm target effective BPM
   * @returns {boolean} false without a BPM
   */
  setBpm(bpm) {
    if (!isFiniteNum(bpm) || bpm <= 0 || !this.bpm) return false;
    this.setTempo(bpm / this.bpm);
    return true;
  }

  // ------------------------------------------------------------ sync -----

  /**
   * SYNC: 'master' (this deck is the master: armed, tempo untouched),
   * 'synced' (aligned to the master now), 'armed' (no reference plays yet:
   * the lock takes over as soon as one does) or null (no BPM).
   * @returns {'synced' | 'armed' | 'master' | null}
   */
  sync() {
    if (!this.bpm) return null;
    const engine = this.engine;
    if (engine.masterIndex === this.index) {
      // The MASTER can be SYNC: arm it without touching ITS tempo (it is the
      // reference) — if it becomes a follower again later, the handover re-targets it
      this._syncBase = this.tempo;
      this._syncRef = this.tempo;
      this._setSynced(true);
      return 'master';
    }
    if (engine._sync(this.index)) return 'synced';
    // No reference yet? SYNC ARMS anyway: the self-healing
    // lock will align it as soon as another track plays
    // web-engine: from a blank calibration (a stale one could be kept)
    this._dropCorrection();
    this._resetSyncCal();
    this._setSynced(true);
    return 'armed';
  }

  /** Leaves SYNC. Emits 'sync'. */
  unsync() {
    if (!this.synced) return;
    this._dropCorrection();
    this._setSynced(false);
  }

  /**
   * Pitch bend (jog): rate = base × (1 + amount). The first call captures the
   * base (the sync base when synced) and suspends the phase lock (syncHold).
   * @param {number} amount clamped to ±0.5 (±0.06 is a typical full deflection)
   * @returns {boolean} false when the deck is not playing (seek instead)
   */
  nudge(amount) {
    if (!isNum(amount) || !this.playing) return false;
    const a = clamp(amount, -0.5, 0.5);
    if (!this._nudge) {
      // During the gesture: sync lock suspended EVERYWHERE (no deck
      // chases the one being nudged) and all the others stay at their
      // base tempo — the relative shift is smooth and exact.
      // Reference tempo: if the sync lock had a transient correction
      // in progress, start again from the CLEAN base tempo (not the corrected one)
      this._nudge = { base: this.synced && this._syncBase ? this._syncBase : this.tempo, amount: a };
      this.engine._holdAdd(this.index);
    }
    // d.synced is NOT touched during the gesture (turning sync off/on
    // restarted the calibration in a loop)
    this._nudge.amount = a;
    // web-engine: the followers do not follow a nudged master (relative shift)
    this._setRate(this._nudge.base * (1 + a), false);
    return true;
  }

  /**
   * Ends the nudge: restores the base tempo; when no deck holds any more,
   * engine.reanchorSync() adopts the new alignment on every deck.
   */
  endNudge() {
    const n = this._nudge;
    if (!n) return;
    this._nudge = null;
    this._setRate(n.base, false);
    this.engine._holdRemove(this.index);
  }

  /**
   * Discreet magnet: when another deck with a grid plays (the manual master
   * preferred) and this deck's beat phase is within `maxBeats` of it, seeks to
   * the exact alignment.
   * @param {number} [maxBeats=0.06]
   * @returns {boolean}
   */
  snapToReference(maxBeats = 0.06) {
    if (!isNum(maxBeats)) return false;
    return this.engine._snapToRef(this.index, Math.max(0, maxBeats));
  }

  // ------------------------------------------------------ performance ----

  /**
   * Momentary pad FX through an independent unit created on demand.
   * { type: 'roll', beats } is a slip roll; any other type uses the pad-FX
   * unit, and the deck's dry drops to preset.dry ?? PAD_FX_DRY[type] ?? 1.
   * null turns it off.
   * @param {{ type: string, beats: number, level?: number, dry?: number, label?: string } | null} preset
   */
  setPadFx(preset) {
    if (preset == null) {
      this._releasePadFx();
      return;
    }
    if (typeof preset !== 'object') throw new TypeError('deck.setPadFx: expected a preset object or null');
    if (!isFxType(preset.type)) throw new RangeError(`Unknown FX type: ${String(preset.type)}`);
    if (!isFiniteNum(preset.beats) || !(preset.beats > 0)) throw new RangeError('deck.setPadFx: beats must be > 0');
    const p = {
      type: preset.type,
      beats: preset.beats,
      // web-engine: level defaults to 1 (every OpenMix preset had one)
      level: isNum(preset.level) ? clamp(preset.level, 0, 1) : 1
    };
    if (isNum(preset.dry)) p.dry = clamp(preset.dry, 0, 1);
    if (preset.label !== undefined) p.label = String(preset.label);
    // only one pad FX at a time per deck: the previous one is released
    if (this._padFxPreset) this._releasePadFx();
    this.engine._resumeQuietly();
    if (p.type === 'roll') {
      // REAL ROLL: the deck repeats the grid slice we're in
      // (½ beat…) and the track keeps going underneath — on release, it resumes
      // exactly where it would be. (The old "roll" was only a looped echo.)
      this._padRoll = { beats: p.beats, mix: 1 };
      this._startRoll(p.beats, 1);
    } else {
      this.engine._setPadFx(this.index, p);
      // The deck's DRY sound is dosed according to the NATURE of the effect: "it's
      // the sound being manipulated", it isn't layered on top. ROLL/SWEEP/
      // TRANS replace everything, ECHO/DELAY cut with the tail, REVERB
      // keeps a bed, FLANGER NEEDS the dry signal (it's the comb of the two).
      this._padDryHold = p.dry !== undefined ? p.dry : (hasOwn(PAD_FX_DRY, p.type) ? PAD_FX_DRY[p.type] : 1);
    }
    this._padFxPreset = p;
  }

  _releasePadFx() {
    const p = this._padFxPreset;
    this._padFxPreset = null;
    if (this._padRoll) {
      this._padRoll = null;
      this._stopRoll(false);
    }
    if (p && p.type !== 'roll') this.engine._setPadFx(this.index, null);
    this._padDryHold = null;
  }

  // "rekordbox-quality" V.BRAKE / BACKSPIN: a CONTINUOUS PLAYBACK of a
  // slice of the track (reversed for the backspin) whose SPEED goes down
  // in a native WebAudio ramp — zero grains, zero choppiness, the real sound of
  // tape braking / rewinding. (the old scrub-grain engine
  // "sputtered" at high speed: grains are choppy by nature)
  _spinSound(kind) {
    this._stopSpinSound();
    if (!this.buffer) return;
    const pos = this.currentTime();
    const back = kind === 'backspin';
    // BACKSPIN: starts at 7× (the high-pitched rekordbox-style "vvviiip" — at 3×
    // it was "not backspinny enough") and falls back down in ~1.5 s
    const v0 = back ? 7 : Math.max(0.2, this.tempo || 1);
    const decel = back ? 4.5 : 1.6;
    const spinDur = v0 / decel;
    const dist = (v0 * v0) / (2 * decel) + 0.15;
    const sr = this.buffer.sampleRate;
    const a = back ? Math.max(0, pos - dist) : Math.max(0, Math.min(pos, this.buffer.duration - 0.05));
    const b = back ? pos : Math.min(this.buffer.duration, pos + dist);
    const n = Math.max(sr >> 4, Math.floor((b - a) * sr));
    const nCh = Math.min(2, this.buffer.numberOfChannels);
    const slice = this.ctx.createBuffer(nCh, n, sr);
    const i0 = Math.floor(a * sr);
    for (let c = 0; c < nCh; c++) {
      const src = this.buffer.getChannelData(c);
      const dst = slice.getChannelData(c);
      if (back) {
        // reversed: the slice's 1st sample = the current position
        for (let j = 0; j < n; j++) dst[j] = src[i0 + n - 1 - j] || 0;
      } else {
        for (let j = 0; j < n; j++) dst[j] = src[i0 + j] || 0;
      }
    }
    const s = this.ctx.createBufferSource();
    s.buffer = slice;
    const now = this.ctx.currentTime;
    s.playbackRate.setValueAtTime(v0, now);
    s.playbackRate.linearRampToValueAtTime(0.001, now + spinDur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1, now);
    g.gain.setValueAtTime(1, now + Math.max(0.01, spinDur - 0.04));
    g.gain.linearRampToValueAtTime(0, now + spinDur);
    s.connect(g);
    g.connect(this.scrubIn);
    s.start(now);
    s.stop(now + spinDur + 0.05);
    s.onended = () => { try { s.disconnect(); g.disconnect(); } catch { /* nothing */ } };
    this._spinSrc = { s, g };
  }

  _stopSpinSound() {
    if (!this._spinSrc) return;
    const { s, g } = this._spinSrc;
    this._spinSrc = null;
    try {
      const now = this.ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.02);
      s.stop(now + 0.03);
    } catch { /* already finished */ }
  }

  // --- "Turntable" effects: V.BRAKE (the platter brakes to a stop) and
  // BACKSPIN (it spins backward like a rewind).
  // SOUND EFFECT ONLY: the track virtually "keeps going" underneath
  // during the gesture, and RESUMES EXACTLY where it would have got to — the
  // effect never moves the position in the mix (by design)
  /**
   * Turntable brake or backspin sound effect. The deck pauses while the track
   * virtually keeps running (displayPosition); see spinEnd().
   * @param {'brake' | 'backspin' | 'vbrake'} kind ('vbrake' = 'brake')
   * @returns {boolean} false without a track or during another spin
   */
  spinStart(kind) {
    const k = kind === 'vbrake' ? 'brake' : kind;
    if (k !== 'brake' && k !== 'backspin') throw new RangeError(`Unknown spin kind: ${String(kind)}`);
    if (!this.buffer || this._spin) return false;
    this.engine._resumeQuietly();
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    // CONTINUOUS sound from the engine (reversed slice + speed ramp): clean
    // at every speed — no scrub grains here
    this._spinSound(k);
    // web-engine: audio clock (was the system clock)
    this._spin = { pos0: this.currentTime(), start: this.ctx.currentTime, wasPlaying, kind: k };
    return true;
  }

  /**
   * Ends the spin: resumes exactly where the track would be if it was
   * playing, otherwise returns to the starting point.
   */
  spinEnd() {
    const s = this._spin;
    if (!s) return;
    this._spin = null;
    this._stopSpinSound();
    if (s.wasPlaying) {
      // ALIGNED resume: original position + elapsed time (as if the
      // sound had never been touched) — it was just a sound effect
      const elapsed = this.ctx.currentTime - s.start;
      const target = Math.min(this.duration || s.pos0, s.pos0 + elapsed * (this.tempo || 1));
      // web-engine: the 30 ms scheduled start and the read-ahead are
      // compensated, so the track resumes EXACTLY where it would be (OpenMix
      // used seek + play: 30 ms, plus the keylock latency, behind)
      // (past the end of the track: the deck stays at the end, paused —
      // OpenMix restarted from 0)
      if (!this._playFrom(target)) this.seek(target);
    } else {
      this.seek(Math.max(0, s.pos0));
    }
  }

  // Mouse scratch: hold = pause, drag = move the track. In audible mode,
  // you hear the sound under the playhead while moving.
  /**
   * Starts a scratch on the waveform: pauses the deck and remembers whether
   * it was playing.
   * @param {{ audible?: boolean }} [options] audible default true
   */
  scrubStart(options = {}) {
    if (!this.buffer || this._scrub) return;
    const audible = !(options && options.audible === false);
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this._scrub = { audible, wasPlaying };
    if (audible) {
      this._scrubbing = true;
      this._scrubLastPos = this.offset;
      this._scrubLastTime = this.ctx.currentTime;
    }
  }

  // --- Velocity-based audible scratch: the sound plays ONLY during the movement,
  // at the speed of the gesture (still = silence, like a real vinyl held down).
  /**
   * Moves the scratch to `time` (file s): audible grains at the gesture speed
   * on the zero-latency path, or a silent seek with audible: false.
   * @param {number} time
   */
  scrubMove(time) {
    if (!isNum(time) || !this.buffer) return;
    if (!this._scrub || !this._scrub.audible) {
      this.seek(time);
      return;
    }
    const t = clamp(time, -PRE_ROLL, this.duration);
    const now = this.ctx.currentTime;
    const from = this._scrubLastPos;
    // The sound grain only covers the real part of the track (≥ 0)
    const gFrom = Math.max(0, Math.min(from, t));
    const gTo = Math.max(0, Math.max(from, t));
    const dist = gTo - gFrom;
    const dt = Math.max(0.005, now - this._scrubLastTime);

    if (dist > 0.0008) {
      // Grain played at the speed of the gesture, CAPPED at ~50 ms real time: sweeping a
      // large distance no longer creates a pile of "queued" sound
      const rate = clamp(dist / dt, 0.05, 6);
      const bufDur = Math.min(dist, rate * 0.05);
      const startPos = t >= from ? Math.max(0, gTo - bufDur) : gFrom;
      const realDur = bufDur / rate;

      // QUEUED GRAINS, END TO END: each grain starts when the
      // previous one ends — ZERO overlap, hence no summing of
      // volumes, hence no more clipping; the scrub sounds at the
      // track's level. If the queue falls too far behind (> 90 ms), the
      // grain is skipped: the next one catches up with the position.
      const at = Math.max(now, this._scrubNextAt || 0);
      if (at - now > 0.09) {
        this._scrubLastPos = t;
        this._scrubLastTime = now;
        this.offset = t;
        return;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = rate;

      const g = this.ctx.createGain();
      const fade = Math.min(0.004, realDur / 3);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + fade);
      g.gain.setValueAtTime(1, Math.max(at + fade, at + realDur - fade));
      g.gain.linearRampToValueAtTime(0, at + realDur);
      this._scrubNextAt = at + realDur;

      src.connect(g);
      g.connect(this.scrubIn);
      src.start(at, startPos, bufDur + 0.002);
      src.onended = () => {
        try { src.disconnect(); g.disconnect(); } catch { /* nothing */ }
      };
    }

    this._scrubLastPos = t;
    this._scrubLastTime = now;
    this.offset = t;
  }

  /**
   * Ends the scratch: resumes if the deck was playing, then the discreet
   * magnet (snapToReference) when `snap` is on, then engine.reanchorSync():
   * the placement set by hand is ADOPTED by the sync.
   * @param {{ resume?: boolean, snap?: boolean }} [options] both default true
   */
  scrubEnd(options = {}) {
    const s = this._scrub;
    if (!s) return;
    this._scrub = null;
    this._scrubbing = false;
    const resume = !(options && options.resume === false);
    const snap = !(options && options.snap === false);
    if (resume && s.wasPlaying) this._play();
    // Auto-realign: segment on segment
    if (snap) this.snapToReference();
    // The placement set with the mouse is ADOPTED: without re-anchoring, the servo
    // used to PULL the sound back to the old alignment ("it snaps back onto the red")
    this.engine.reanchorSync();
  }

  // ------------------------------------------------------ grid editing ---

  /**
   * Replaces the given grid fields. A bpm without beats makes a fixed grid
   * (the OpenMix "BPM correction"). If the BPM or the beat list changed, the
   * deck leaves SYNC. Emits 'grid'.
   * @param {{ bpm?: number | null, beats?: number[] | null, beatOffset?: number | null,
   *   barAnchor?: number, gridShift?: number }} grid
   */
  setGrid(grid) {
    if (!grid || typeof grid !== 'object') return;
    const has = (k) => hasOwn(grid, k) && grid[k] !== undefined;
    // NaN or a non-number makes the call a no-op
    if (has('bpm') && grid.bpm !== null && !(isFiniteNum(grid.bpm) && grid.bpm > 0)) return;
    if (has('beats') && grid.beats !== null && !Array.isArray(grid.beats)) return;
    if (has('beatOffset') && grid.beatOffset !== null && !isFiniteNum(grid.beatOffset)) return;
    if (has('barAnchor') && !isFiniteNum(grid.barAnchor)) return;
    if (has('gridShift') && !isFiniteNum(grid.gridShift)) return;
    const oldBpm = this.bpm;
    const oldBeats = this.beats;
    if (has('beats')) {
      const b = beatList(grid.beats);
      this.beats = b;
      if (has('bpm')) this.bpm = grid.bpm != null ? grid.bpm : (b ? bpmFromBeats(b) : null);
      else if (b) this.bpm = bpmFromBeats(b);
      if (b && !has('beatOffset') && this.beatOffset == null) this.beatOffset = b[0];
    } else if (has('bpm')) {
      // MANUAL BPM CORRECTION: FIXED grid rebuilt on the entered BPM
      this.bpm = grid.bpm;
      this.beats = null;
    }
    if (has('beatOffset')) this.beatOffset = grid.beatOffset;
    if (this.bpm && !this.beats && this.beatOffset == null) this.beatOffset = 0;
    if (has('barAnchor')) this.barAnchor = Math.round(grid.barAnchor);
    if (has('gridShift')) this.gridShift = grid.gridShift;
    if (this.bpm !== oldBpm || !sameBeats(this.beats, oldBeats)) this._leaveSync();
    this._emitGrid();
  }

  /**
   * ×2 / ÷2 grid. On a beat list: ×2 inserts midpoints and doubles barAnchor;
   * ÷2 keeps every other beat with the parity of barAnchor. The new BPM must
   * stay within 40–320. Leaves SYNC; emits 'grid'.
   * @param {2 | 0.5} factor
   * @returns {boolean} false without a BPM or out of range
   */
  scaleGrid(factor) {
    if (factor !== 2 && factor !== 0.5) throw new RangeError(`deck.scaleGrid: factor must be 2 or 0.5 (got ${String(factor)})`);
    if (!this.bpm) return false;
    const newBpm = Math.round(this.bpm * factor * 1000) / 1000;
    if (newBpm < 40 || newBpm > 320) return false;
    if (this.beats) {
      // Dynamic grid: double the density (midpoints) or keep every
      // other beat (preserving the bar anchor)
      let newBeats;
      if (factor > 1) {
        newBeats = [];
        for (let k = 0; k < this.beats.length - 1; k++) {
          newBeats.push(this.beats[k]);
          newBeats.push(Math.round(((this.beats[k] + this.beats[k + 1]) / 2) * 1000) / 1000);
        }
        newBeats.push(this.beats[this.beats.length - 1]);
        this.barAnchor = (this.barAnchor || 0) * 2;
      } else {
        const parity = ((this.barAnchor || 0) % 2 + 2) % 2;
        newBeats = this.beats.filter((_, k) => k % 2 === parity);
        this.barAnchor = Math.floor((this.barAnchor || 0) / 2);
      }
      if (newBeats.length > 2) {
        this.beats = newBeats;
      } else {
        // web-engine: too few beats left for a beat list: fixed grid
        this.beats = null;
        if (newBeats.length) this.beatOffset = newBeats[0];
      }
    }
    this.bpm = newBpm;
    // The BPM just changed ×2/÷2: the old sync ratio is obsolete
    this._leaveSync();
    this._emitGrid();
    return true;
  }

  /**
   * Fine grid calibration: on a beat list, gridShift += seconds; on a fixed
   * grid, beatOffset = max(0, beatOffset + seconds). Emits 'grid'.
   * @param {number} seconds
   */
  shiftGrid(seconds) {
    if (!isFiniteNum(seconds)) return;
    if (this.beats) {
      this.gridShift += seconds;
    } else if (this.beatOffset != null) {
      this.beatOffset = Math.max(0, this.beatOffset + seconds);
    } else {
      return;
    }
    this._emitGrid();
  }

  /**
   * Grid realignment: the beat nearest to `time` becomes a bar start placed
   * exactly at `time` (default: the position). Emits 'grid'.
   * @param {number} [time]
   * @returns {boolean} false without a track or a BPM
   */
  setDownbeat(time) {
    if (!this.buffer || !this.bpm) return false;
    const now = time === undefined ? this.currentTime() : time;
    if (!isFiniteNum(now)) return false;
    if (this.beats) {
      // Dynamic grid: the nearest beat becomes a BAR START,
      // placed exactly under the playhead
      const k = Math.round(gridIndexFracAt(this, now));
      this.gridShift += now - gridTimeAtIndex(this, k);
      this.barAnchor = k;
    } else {
      this.beatOffset = now;
    }
    this._emitGrid();
    return true;
  }

  // ---------------------------------------------------------- dispose ----

  // web-engine: stops every source of the deck (Engine.destroy)
  _dispose() {
    this._cancelLoad();
    this._stopEverything(true);
    this.shifter._dispose();
    if (this.wsola) {
      this.wsola.port.onmessage = null;
      try { this.wsola.disconnect(); } catch { /* nothing */ }
    }
    try { this.dryOut.disconnect(); } catch { /* nothing */ }
    try { this.cueSend.disconnect(); } catch { /* nothing */ }
  }
}

function isKeyCode(code) {
  return Number.isInteger(code) && code >= 0 && code <= 23;
}
