// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §16.2, §17.3):
// NativeDeck, the engine.js `Deck` surface that app.js, waveform.js and
// key.js use, backed by the engine host.
//
// - UI-owned values (track data, grid, hot cues, cue point, strip knobs, key,
//   keylock) live here and are sent as commands; getters answer from here.
// - Engine-owned values (heard position and segments, rate, `playing` at the
//   end of a track, tempo under the sync servo, synced / _syncBase / _syncRef
//   / _pllCorr under the lock, loop state after a seek, meters) come from the
//   engine's snapshots, each group adopted only once state.ack covers the
//   last command of that group the facade sent (until then the facade keeps
//   its own prediction, made with engine.js's rules).
// - After a fallback every member forwards to the engine.js Deck (`_web`):
//   app.js keeps the same object for the whole session.

import { gridIndexFracAt, gridTimeAtIndex } from '../engine.js';
import { TransportModel, PRE_ROLL } from './transport.js';
import { AudioParamShim } from './context.js';
import { clamp } from './env.js';

export const STEMS = ['vocals', 'drums', 'bass', 'other'];

export const GATE_STALE_SEC = 1;

/**
 * Adoption gate of one group of engine-owned fields: closed while a command
 * of the group is not applied yet (seq above state.ack, or a `when` command
 * whose `applied` event has not come). A command normally comes back within
 * a few tens of ms; one still missing after GATE_STALE_SEC was dropped (a
 * batch the engine refused as invalid): the gate reopens then, so a lost
 * command can never freeze the mirrors.
 */
export class Gate {
  constructor() {
    this.seq = 0;
    this.when = new Set();
    this.staleAt = 0;    // engine time after which a missing confirmation means a lost command
  }

  /** `now`: engine time of the send; `whenAt`: the `when` of a scheduled command. */
  mark(seq, isWhen = false, now = 0, whenAt = 0) {
    if (!seq) return;
    if (isWhen) this.when.add(seq);
    else if (seq > this.seq) this.seq = seq;
    const due = Math.max(now, isWhen && whenAt ? whenAt : 0);
    if (due) this.staleAt = Math.max(this.staleAt, due + GATE_STALE_SEC);
  }

  applied(seq) {
    this.when.delete(seq);
  }

  open(ack, now) {
    if (this.when.size === 0 && ack >= this.seq) return true;
    if (now != null && this.staleAt && now > this.staleAt) {
      this.seq = 0;
      this.when.clear();
      this.staleAt = 0;
      return true;
    }
    return false;
  }

  reset() {
    this.seq = 0;
    this.when.clear();
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export class NativeDeck {
  constructor(engine, id) {
    this._e = engine;
    this.id = id;
    this._web = null;               // engine.js Deck after a fallback
    // UI data
    this._buffer = null;
    this._track = null;
    this._peaks = null;
    this._musicKey = null;
    this._hotCues = new Array(8).fill(null);
    this._onEnded = null;
    // grid
    this._bpm = null;
    this._beatOffset = null;
    this._beats = null;
    this._gridShift = 0;
    this._barAnchor = 0;
    this._gridDirty = false;
    this._sentBeats = null;
    // transport
    this._playing = false;
    this._model = new TransportModel();
    this._cuePoint = 0;
    this._tempo = 1;
    this._looping = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._loopBeatsV = null;
    this._keyShift = 0;
    this._keylock = false;
    this._scrubbing = false;
    this._endedAt = 0;
    this._endedSeen = null;
    this._lastEndedT = null;
    // sync
    this._synced = false;
    this._syncBaseV = null;
    this._syncRefV = null;
    this._pllCorrV = 0;
    // performance
    this._padRollV = null;
    this._padDryHoldV = null;
    this._roll = null;              // engine.js _roll (same-slice check of startRoll)
    this._rollingEngine = false;
    this._spinning = false;
    // stems
    this._stems = null;
    this._stemsOn = false;
    this._stemStreams = null;       // PCM streams of the stems
    this._stemsSent = false;        // deck.stems sent with the current set
    this.stemGains = {};
    for (const k of STEMS) {
      const shim = new AudioParamShim(1,
        (v, tau) => this._send({ cmd: 'deck.stemGain', deck: this.id, stem: k, v, tau: tau || 0.01 }),
        () => (this._web ? this._web.stemGains[k].gain : null));
      this.stemGains[k] = { gain: shim };
    }
    // channel strip
    this._volume = 0.85;
    this._eq = { low: 0, mid: 0, high: 0 };
    this._lowBeforeKill = null;
    this._trimVal = 0;
    this._filterVal = 0;
    this._cueOn = false;
    this._peak = 0;
    // engine side
    this._loadId = 0;               // loadId of the track attached in the engine
    this._stream = null;            // PCM stream of the track
    this._reloads = 0;
    this._gates = { transport: new Gate(), tempo: new Gate(), loop: new Gate(), sync: new Gate() };
    this._warnedInsert = false;
  }

  // ---- helpers -------------------------------------------------------------

  _now() {
    return this._e.engineNow();
  }

  /** Sends a command and closes the given gates until it is applied. */
  _send(cmd, ...gates) {
    const seq = this._e._send(cmd);
    if (seq) {
      const now = this._e.engineNow();
      for (const g of gates) g.mark(seq, cmd.when != null, now, cmd.when);
    }
    return seq;
  }

  /** Knob-like command: not sent again when the value did not change. */
  _sendState(key, cmd, value) {
    return this._e._sendState(`d${this.id}.${key}`, cmd, value);
  }

  _wrap(t) {
    if (this._looping && t > this._loopEnd) {
      const len = this._loopEnd - this._loopStart;
      if (len > 0) t = this._loopStart + ((t - this._loopStart) % len);
    }
    if (t < -PRE_ROLL) t = -PRE_ROLL;
    return Math.min(t, this.duration);
  }

  _pcmPriority() {
    return this._playing ? 0 : 1;
  }

  // ---- UI data ---------------------------------------------------------------

  get buffer() { return this._web ? this._web.buffer : this._buffer; }
  get duration() { const b = this.buffer; return b ? b.duration : 0; }

  get track() { return this._web ? this._web.track : this._track; }
  set track(v) { if (this._web) this._web.track = v; else this._track = v; }

  get peaks() { return this._web ? this._web.peaks : this._peaks; }
  set peaks(v) { if (this._web) this._web.peaks = v; else this._peaks = v; }

  get musicKey() { return this._web ? this._web.musicKey : this._musicKey; }
  set musicKey(v) { if (this._web) this._web.musicKey = v; else this._musicKey = v; }

  get hotCues() { return this._web ? this._web.hotCues : this._hotCues; }
  set hotCues(v) { if (this._web) this._web.hotCues = v; else this._hotCues = v; }

  get onEnded() { return this._onEnded; }
  set onEnded(fn) { this._onEnded = fn; }

  get _endedAtSec() { return this._web ? this._web._endedAt : this._endedAt; }

  // ---- grid (coalesced into one deck.grid per task) ---------------------------

  get bpm() { return this._web ? this._web.bpm : this._bpm; }
  set bpm(v) { if (this._web) { this._web.bpm = v; return; } this._bpm = v; this._gridChanged(); }

  get beatOffset() { return this._web ? this._web.beatOffset : this._beatOffset; }
  set beatOffset(v) { if (this._web) { this._web.beatOffset = v; return; } this._beatOffset = v; this._gridChanged(); }

  get beats() { return this._web ? this._web.beats : this._beats; }
  set beats(v) { if (this._web) { this._web.beats = v; return; } this._beats = v; this._gridChanged(); }

  get gridShift() { return this._web ? this._web.gridShift : this._gridShift; }
  set gridShift(v) { if (this._web) { this._web.gridShift = v; return; } this._gridShift = v; this._gridChanged(); }

  get barAnchor() { return this._web ? this._web.barAnchor : this._barAnchor; }
  set barAnchor(v) { if (this._web) { this._web.barAnchor = v; return; } this._barAnchor = v; this._gridChanged(); }

  get effectiveBpm() {
    if (this._web) return this._web.effectiveBpm;
    return this._bpm ? this._bpm * this._tempo : null;
  }

  _gridPayload() {
    return {
      bpm: this._bpm, beatOffset: this._beatOffset,
      beats: Array.isArray(this._beats) && this._beats.length > 2 ? this._beats : null,
      gridShift: this._gridShift || 0, barAnchor: this._barAnchor || 0
    };
  }

  _gridChanged() {
    if (this._gridDirty || !this._loadId) return;
    this._gridDirty = true;
    const seq = this._e._lazy(() => {
      this._gridDirty = false;
      if (!this._loadId) return null;
      const g = this._gridPayload();
      const cmd = { cmd: 'deck.grid', deck: this.id, bpm: g.bpm, beatOffset: g.beatOffset, gridShift: g.gridShift, barAnchor: g.barAnchor };
      if (this._beats !== this._sentBeats) {
        cmd.beats = g.beats;
        this._sentBeats = this._beats;
      }
      return cmd;
    });
    if (!seq) this._gridDirty = false;
  }

  // ---- transport state -----------------------------------------------------

  get playing() { return this._web ? this._web.playing : this._playing; }
  get tempo() { return this._web ? this._web.tempo : this._tempo; }

  get cuePoint() { return this._web ? this._web.cuePoint : this._cuePoint; }
  set cuePoint(v) {
    if (this._web) { this._web.cuePoint = v; return; }
    this._cuePoint = v;
    if (isNum(v)) this._sendState('cue', { cmd: 'deck.cuePoint', deck: this.id, t: v }, v);
  }

  get looping() { return this._web ? this._web.looping : this._looping; }
  get loopStart() { return this._web ? this._web.loopStart : this._loopStart; }
  get loopEnd() { return this._web ? this._web.loopEnd : this._loopEnd; }

  get _loopBeats() { return this._web ? this._web._loopBeats : this._loopBeatsV; }
  set _loopBeats(v) {
    if (this._web) { this._web._loopBeats = v; return; }
    this._loopBeatsV = v == null ? null : v;
    this._send({ cmd: 'deck.loopBeats', deck: this.id, beats: this._loopBeatsV }, this._gates.loop);
  }

  get keyShift() { return this._web ? this._web.keyShift : this._keyShift; }
  get keylock() { return this._web ? this._web.keylock : this._keylock; }

  get procLat() { return this._web ? this._web.procLat : 0; }

  // ---- sync fields (engine-owned, writable by app.js) --------------------------

  get synced() { return this._web ? this._web.synced : this._synced; }
  set synced(v) {
    if (this._web) { this._web.synced = v; return; }
    this._synced = !!v;
    this._send({ cmd: 'sync.arm', deck: this.id, on: this._synced }, this._gates.sync);
  }

  get _syncBase() { return this._web ? this._web._syncBase : this._syncBaseV; }
  set _syncBase(v) {
    if (this._web) { this._web._syncBase = v; return; }
    this._syncBaseV = v == null ? null : v;
    this._send({ cmd: 'sync.base', deck: this.id, base: this._syncBaseV }, this._gates.sync);
  }

  get _syncRef() { return this._web ? this._web._syncRef : this._syncRefV; }
  set _syncRef(v) {
    if (this._web) { this._web._syncRef = v; return; }
    this._syncRefV = v == null ? null : v;
    this._send({ cmd: 'sync.base', deck: this.id, ref: this._syncRefV }, this._gates.sync);
  }

  get _pllCorr() { return this._web ? this._web._pllCorr : this._pllCorrV; }
  set _pllCorr(v) {
    if (this._web) { this._web._pllCorr = v; return; }
    this._pllCorrV = isNum(v) ? v : 0;
    this._send({ cmd: 'sync.base', deck: this.id, pllCorr: this._pllCorrV }, this._gates.sync);
  }

  // ---- pad performance fields -----------------------------------------------

  get _padRoll() { return this._web ? this._web._padRoll : this._padRollV; }
  set _padRoll(v) {
    if (this._web) { this._web._padRoll = v; return; }
    this._padRollV = v || null;
    const cmd = { cmd: 'deck.padRoll', deck: this.id, beats: v ? v.beats : null };
    if (v) cmd.mix = v.mix == null ? 1 : v.mix;
    this._send(cmd);
  }

  get _padDryHold() { return this._web ? this._web._padDryHold : this._padDryHoldV; }
  set _padDryHold(v) {
    if (this._web) { this._web._padDryHold = v; return; }
    this._padDryHoldV = v == null ? null : v;
    this._send({ cmd: 'deck.padDryHold', deck: this.id, dry: this._padDryHoldV });
  }

  // ---- channel strip ------------------------------------------------------------

  get volume() { return this._web ? this._web.volume : this._volume; }
  get eq() { return this._web ? this._web.eq : this._eq; }
  get trimVal() { return this._web ? this._web.trimVal : this._trimVal; }
  get filterVal() { return this._web ? this._web.filterVal : this._filterVal; }
  get cueOn() { return this._web ? this._web.cueOn : this._cueOn; }
  get stemsOn() { return this._web ? this._web.stemsOn : this._stemsOn; }

  setVolume(v) {
    if (this._web) return this._web.setVolume(v);
    this._volume = clamp(v, 0, 1);
    this._sendState('vol', { cmd: 'deck.volume', deck: this.id, v: this._volume }, this._volume);
  }

  setEq(band, v) {
    if (this._web) return this._web.setEq(band, v);
    if (band !== 'low' && band !== 'mid' && band !== 'high') return;
    v = clamp(v, -1, 1);
    this._eq[band] = v;
    this._sendState(`eq.${band}`, { cmd: 'deck.eq', deck: this.id, band, v }, v);
  }

  toggleBassKill() {
    if (this._web) return this._web.toggleBassKill();
    if (this._lowBeforeKill === null) {
      this._lowBeforeKill = this._eq.low;
      this.setEq('low', -1);
    } else {
      this.setEq('low', this._lowBeforeKill);
      this._lowBeforeKill = null;
    }
    return this._lowBeforeKill !== null;
  }

  setTrim(v) {
    if (this._web) return this._web.setTrim(v);
    this._trimVal = clamp(v, -1, 1);
    this._sendState('trim', { cmd: 'deck.trim', deck: this.id, v: this._trimVal }, this._trimVal);
  }

  /** engine.js Deck.setFilter: the deck's FILTER knob (app.js goes through engine.setDeckColor). */
  setFilter(v) {
    if (this._web) return this._web.setFilter(v);
    this._e.setDeckColor(this.id, v);
  }

  meterPeak() {
    if (this._web) return this._web.meterPeak();
    return this._peak;
  }

  /** vst.js only: in native mode the VST3 insert lives in the engine (NativeVstHost). */
  setInsert(node, latency) {
    if (this._web) return this._web.setInsert(node, latency);
    if (!this._warnedInsert) {
      this._warnedInsert = true;
      this._e.env.log.warn?.('[engine] deck.setInsert() ignored: VST3 inserts run inside the native engine');
    }
  }

  // ---- loading ------------------------------------------------------------------

  /** engine.js loadTrack: same rules on the mirrors, then the PCM handoff + deck.load. */
  loadTrack(opts) {
    if (this._web) return this._web.loadTrack(opts);
    const { buffer, bpm, peaks, track, beatOffset, hotCues, beats, gridShift, barAnchor } = opts || {};
    const now = this._now();
    this._e._dropDeckPcm(this);
    this._roll = null;
    this._padRollV = null;
    this._scrubbing = false;
    this._spinning = false;
    this._playing = false;
    this._buffer = buffer;
    this._bpm = bpm || null;
    this._beatOffset = beatOffset != null ? beatOffset : null;
    this._beats = Array.isArray(beats) && beats.length > 2 ? beats : null;
    this._gridShift = gridShift || 0;
    this._barAnchor = barAnchor || 0;
    this._gridDirty = false;
    this._sentBeats = this._beats;
    this._peaks = peaks || null;
    this._track = track || null;
    this._model.jumpStopped(0, now);
    this._cuePoint = 0;
    this._tempo = 1;
    this._syncBaseV = null;
    this._syncRefV = null;
    this._pllCorrV = 0;
    this._looping = false;
    this._loopBeatsV = null;
    this._stems = null;
    this._stemsOn = false;
    this._keyShift = 0;
    // _endedAt is kept, like engine.js loadTrack (only play() clears it)
    this._reloads = 0;
    this._hotCues = new Array(8).fill(null);
    if (Array.isArray(hotCues)) {
      hotCues.slice(0, 8).forEach((c, i) => { this._hotCues[i] = c != null ? c : null; });
    }
    // what the engine's resetForLoad does by itself: no command to send for these
    this._e._forget(`d${this.id}.key`, 0);
    this._e._forget(`d${this.id}.cue`, 0);
    this._e._loadDeck(this);
  }

  // ---- transport ------------------------------------------------------------------

  currentTime() {
    if (this._web) return this._web.currentTime();
    if (!this._buffer) return 0;
    return this._wrap(this._model.value(this._now()));
  }

  play() {
    if (this._web) return this._web.play();
    if (!this._buffer || this._playing) return;
    this._endedAt = 0;
    const now = this._now();
    let off = this.currentTime();
    if (off >= this.duration - 0.01) off = 0;
    this._playing = true;
    this._model.holdThenMove(off, now, this._tempo);
    this._send({ cmd: 'deck.play', deck: this.id }, this._gates.transport);
    this._e._focusPcm(this, off);
  }

  pause() {
    if (this._web) return this._web.pause();
    if (!this._playing) return;
    this._roll = null;
    this._playing = false;
    const now = this._now();
    this._model.moveThenStop(now, now + this._e._leadEstimate());
    this._send({ cmd: 'deck.pause', deck: this.id }, this._gates.transport);
  }

  togglePlay() {
    if (this._web) return this._web.togglePlay();
    if (this._playing) this.pause();
    else this.play();
  }

  seek(t) {
    if (this._web) return this._web.seek(t);
    if (!this._buffer || !Number.isFinite(t)) return;
    t = clamp(t, -PRE_ROLL, this.duration);
    const gates = [this._gates.transport];
    // jumping out of the loop disables it (engine.js)
    if (this._looping && (t < this._loopStart || t >= this._loopEnd)) {
      this._looping = false;
      this._loopBeatsV = null;
      gates.push(this._gates.loop);
    }
    const now = this._now();
    if (this._playing) this._model.jumpMoving(t, now, this._tempo);
    else this._model.jumpStopped(t, now);
    this._send({ cmd: 'deck.seek', deck: this.id, t }, ...gates);
    this._e._focusPcm(this, t);
  }

  /** CDJ behaviour: playing -> back to the cue + pause; paused -> set (or recall) the cue point. */
  cue() {
    if (this._web) return this._web.cue();
    if (!this._buffer) return;
    if (this._playing) {
      this.pause();
      this.seek(this._cuePoint);
    } else if (Math.abs(this.currentTime() - this._cuePoint) < 0.02) {
      this.seek(this._cuePoint);
    } else {
      this.cuePoint = this.currentTime();
    }
  }

  setTempo(r) {
    if (this._web) return this._web.setTempo(r);
    r = clamp(r, 0.5, 1.6);
    if (this._playing) this._model.setRate(this._now(), r);
    this._tempo = r;
    this._send({ cmd: 'deck.tempo', deck: this.id, r }, this._gates.tempo);
  }

  // ---- loops ---------------------------------------------------------------------------

  setLoop(start, end) {
    if (this._web) return this._web.setLoop(start, end);
    start = Math.max(0, start);
    end = Math.min(this.duration, end);
    if (!(end - start >= 0.01)) return;
    const wasPos = this.currentTime();
    this._loopStart = start;
    this._loopEnd = end;
    this._looping = true;
    // a loop behind the playhead makes it jump inside: a discontinuity
    this._send({ cmd: 'deck.loop', deck: this.id, start, end }, this._gates.loop, this._gates.transport);
    this._e._focusPcm(this, wasPos, [start]);
  }

  exitLoop() {
    if (this._web) return this._web.exitLoop();
    if (!this._looping) return;
    // engine.js: the position continues from where the loop left it (not while a start is pending)
    const now = this._now();
    if (this._playing && this._model.rate(now) !== 0) this._model.reanchor(now, this.currentTime());
    this._looping = false;
    this._loopBeatsV = null;
    this._send({ cmd: 'deck.loopExit', deck: this.id }, this._gates.loop, this._gates.transport);
  }

  // ---- key ---------------------------------------------------------------------------

  setKey(semi) {
    if (this._web) return this._web.setKey(semi);
    this._keyShift = clamp(Math.round(semi), -7, 7);
    this._sendState('key', { cmd: 'deck.key', deck: this.id, semi: this._keyShift }, this._keyShift);
  }

  setKeylock(on) {
    if (this._web) return this._web.setKeylock(on);
    this._keylock = !!on;
    this._sendState('keylock', { cmd: 'deck.keylock', deck: this.id, on: this._keylock }, this._keylock);
  }

  // ---- ROLL (engine.js preconditions on the mirrors) ----------------------------------

  startRoll(beats, mix = 1) {
    if (this._web) return this._web.startRoll(beats, mix);
    if (!this._buffer || !this._playing || !(beats > 0)) return false;
    const pos = this.currentTime();
    if (pos < 0) return false;
    let start;
    let end;
    if (this._beats) {
      const f = gridIndexFracAt(this, pos);
      const anchor = this._barAnchor || 0;
      const k0 = Math.floor((f - anchor) / beats + 1e-6) * beats + anchor;
      start = gridTimeAtIndex(this, k0);
      end = gridTimeAtIndex(this, k0 + beats);
    } else if (this._bpm) {
      const per = 60 / this._bpm;
      const off = this._beatOffset || 0;
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
    if (this._roll && Math.abs(this._roll.start - start) < 1e-4 && Math.abs(this._roll.end - end) < 1e-4) {
      this.setRollMix(mix);
      return true;
    }
    this._roll = { start, end, beats, mix: clamp(mix, 0, 1) };
    this._send({ cmd: 'deck.roll', deck: this.id, beats, mix: clamp(mix, 0, 1) });
    return true;
  }

  setRollMix(mix) {
    if (this._web) return this._web.setRollMix(mix);
    if (!this._roll) return;
    const m = clamp(mix, 0, 1);
    if (Math.abs(m - this._roll.mix) < 0.005) return;
    this._roll.mix = m;
    this._send({ cmd: 'deck.rollMix', deck: this.id, mix: m });
  }

  stopRoll(immediate) {
    if (this._web) return this._web.stopRoll(immediate);
    if (!this._roll && !this._rollingEngine) return;
    this._roll = null;
    this._rollingEngine = false;
    this._send({ cmd: 'deck.rollStop', deck: this.id, immediate: !!immediate });
  }

  // ---- stems ----------------------------------------------------------------------------

  get stems() { return this._web ? this._web.stems : this._stems; }
  set stems(v) {
    if (this._web) { this._web.stems = v; return; }
    if (v === this._stems) return;
    this._e._dropStems(this);
    this._stems = v || null;
    if (this._stems) this._e._handoffStems(this);
  }

  loadStems(stems) {
    if (this._web) return this._web.loadStems(stems);
    if (stems !== this._stems) this.stems = stems;
    this._stemsOn = true;
    for (const k of STEMS) this.stemGains[k].gain._v = 1;
    this._send({ cmd: 'deck.stemsOn', deck: this.id, on: true });
    this._e._stemsWanted(this);
  }

  toggleStem(name) {
    if (this._web) return this._web.toggleStem(name);
    const g = this.stemGains[name];
    if (!g) return false;
    const on = g.gain.value < 0.5;
    g.gain.setTargetAtTime(on ? 1 : 0, this._now(), 0.01);
    return on;
  }

  // ---- scratch and turntable effects -------------------------------------------------------

  scrubStart() {
    if (this._web) return this._web.scrubStart();
    if (!this._buffer) return;
    this._scrubbing = true;
    this._model.jumpStopped(this.currentTime(), this._now());
    this._send({ cmd: 'deck.scratch', deck: this.id, phase: 'start' }, this._gates.transport);
  }

  scrubMove(t) {
    if (this._web) return this._web.scrubMove(t);
    if (!this._buffer) return;
    t = clamp(t, -PRE_ROLL, this.duration);
    if (!this._scrubbing) {
      // engine.js: without scrubStart, scrubMove only moves the position
      this._model.jumpStopped(t, this._now());
      this._send({ cmd: 'deck.seek', deck: this.id, t }, this._gates.transport);
      this._e._focusPcm(this, t);
      return;
    }
    this._model.jumpStopped(t, this._now());
    this._send({ cmd: 'deck.scratch', deck: this.id, phase: 'move', t }, this._gates.transport);
  }

  scrubEnd() {
    if (this._web) return this._web.scrubEnd();
    if (!this._scrubbing) return;
    this._scrubbing = false;
    this._send({ cmd: 'deck.scratch', deck: this.id, phase: 'end' }, this._gates.transport);
    this._e._focusPcm(this, this.currentTime());
  }

  spinSound(kind) {
    if (this._web) return this._web.spinSound(kind);
    if (!this._buffer) return;
    this._spinning = true;
    this._send({ cmd: 'deck.spin', deck: this.id, kind: kind === 'backspin' ? 'backspin' : 'vbrake' });
  }

  stopSpinSound() {
    if (this._web) return this._web.stopSpinSound();
    if (!this._spinning) return;
    this._spinning = false;
    this._send({ cmd: 'deck.spin', deck: this.id, kind: 'none' });
  }

  // ---- reconciliation with the engine's snapshots -------------------------------------------

  /** `ds` = state.decks[id]; `st` = the state; `ack` = state.ack; `now` = engine time. */
  _adopt(ds, st, ack, now) {
    if (this._web || !ds) return;
    if (isNum(ds.peak)) this._peak = ds.peak;
    this._rollingEngine = !!ds.rolling;
    if (!this._buffer || !this._loadId || ds.loadId !== this._loadId) return;
    if (this._endedSeen == null) this._endedSeen = ds.endedCount | 0;
    else if ((ds.endedCount | 0) > this._endedSeen) {
      this._endedSeen = ds.endedCount | 0;
      this._ended(isNum(ds.endedAt) ? ds.endedAt : null, now);
    }
    const g = this._gates;
    if (g.tempo.open(ack, now) && isNum(ds.tempo)) this._tempo = ds.tempo;
    if (g.loop.open(ack, now)) {
      this._looping = !!ds.looping;
      if (isNum(ds.loopStart)) this._loopStart = ds.loopStart;
      if (isNum(ds.loopEnd)) this._loopEnd = ds.loopEnd;
      this._loopBeatsV = isNum(ds.loopBeats) ? ds.loopBeats : null;
    }
    if (this._scrubbing || !g.transport.open(ack, now)) return;
    this._playing = !!ds.playing;
    // A loop wrap starts no segment and the engine reports the heard position
    // wrapped into the loop, stamped at st.t (a presentTime 20-45 ms ahead).
    // Unwrapped onto the model's own timeline, it is never extrapolated back
    // across the wrap (below loopStart) when read before st.t: like engine.js
    // currentTime(), the model runs unwrapped and _wrap() folds it on read.
    let pos = ds.pos;
    if (ds.looping && this._model.seg === ds.seg && isNum(pos) && isNum(st.t)) {
      const len = ds.loopEnd - ds.loopStart;
      if (len > 0) {
        const k = Math.round((this._model.value(st.t) - pos) / len);
        if (k > 0) pos += k * len;
      }
    }
    this._model.adopt({ seg: ds.seg, anchorT: ds.anchorT, anchorPos: ds.anchorPos, t: st.t, pos, rate: ds.rate },
      now, (x) => this._wrap(x));
  }

  _adoptSync(sync, ack, now) {
    if (this._web || !sync || !this._gates.sync.open(ack, now)) return;
    const i = this.id;
    if (Array.isArray(sync.synced)) this._synced = !!sync.synced[i];
    if (Array.isArray(sync.syncBase)) this._syncBaseV = isNum(sync.syncBase[i]) ? sync.syncBase[i] : null;
    if (Array.isArray(sync.syncRef)) this._syncRefV = isNum(sync.syncRef[i]) ? sync.syncRef[i] : null;
    if (Array.isArray(sync.pllCorr)) this._pllCorrV = isNum(sync.pllCorr[i]) ? sync.pllCorr[i] : 0;
  }

  /** Natural end (deck.ended event or a snapshot whose endedCount grew): engine.js onended. */
  _ended(engineT, now) {
    if (engineT != null && engineT === this._lastEndedT) return;
    this._lastEndedT = engineT;
    // the user acted after the end (play, seek...): engine.js would have replaced the source
    if (!this._gates.transport.open(this._e._ack, now)) return;
    this._playing = false;
    this._model.jumpStopped(this.duration, now);
    this._endedAt = this._e.env.now() / 1000;
    if (typeof this._onEnded === 'function') {
      try { this._onEnded(); } catch (e) { this._e.env.log.error?.(e); }
    }
  }
}
