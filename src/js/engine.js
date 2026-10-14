// Audio engine: 4 decks -> 3-band EQ -> filter -> fader -> crossfader -> master.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// A track can be positioned BEFORE its start (negative position):
// it stays silent until 0 then starts — handy for cueing it in late.
const PRE_ROLL = 3600;

// Latency of the transposition engine (samples) — MUST equal LAT in
// pitch-worklet.js (the worklet also announces it on startup)
const WS_LAT_SAMPLES = 2647;

// GLOBAL grid offset (adjustable in ms in the settings): shifts
// every line of every track at once, to suit your ear/screen
let GLOBAL_GRID_OFFSET = 0;
export function setGlobalGridOffset(sec) {
  GLOBAL_GRID_OFFSET = sec || 0;
}
export function getGlobalGridOffset() {
  return GLOBAL_GRID_OFFSET;
}

// --- Dynamic grid: helpers (position <-> beat index) ---
// deck.beats = actual position of each beat; deck.gridShift = global
// manual offset; deck.barAnchor = index of the beat that starts a bar.

export function gridIndexFracAt(deck, t) {
  const b = deck.beats;
  if (!b || b.length < 2) return null;
  const tt = t - (deck.gridShift || 0) - GLOBAL_GRID_OFFSET;
  const n = b.length;
  if (tt <= b[0]) return (tt - b[0]) / (b[1] - b[0]);
  if (tt >= b[n - 1]) return (n - 1) + (tt - b[n - 1]) / (b[n - 1] - b[n - 2]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b[mid] <= tt) lo = mid;
    else hi = mid;
  }
  return lo + (tt - b[lo]) / (b[hi] - b[lo]);
}

export function gridTimeAtIndex(deck, f) {
  const b = deck.beats;
  if (!b || b.length < 2) return null;
  const s = (deck.gridShift || 0) + GLOBAL_GRID_OFFSET;
  const n = b.length;
  if (f <= 0) return b[0] + f * (b[1] - b[0]) + s;
  if (f >= n - 1) return b[n - 1] + (f - (n - 1)) * (b[n - 1] - b[n - 2]) + s;
  const k = Math.floor(f);
  return b[k] + (f - k) * (b[k + 1] - b[k]) + s;
}

export function gridPeriodAt(deck, t) {
  const b = deck.beats;
  if (!b || b.length < 2) return deck.bpm ? 60 / deck.bpm : null;
  const f = gridIndexFracAt(deck, t);
  const k = Math.max(0, Math.min(b.length - 2, Math.floor(f)));
  return b[k + 1] - b[k];
}

// "Bar-intact" jump: instead of jumping exactly where you clicked, you land
// in the SAME bar (the one targeted by the click) but at the same RELATIVE
// position you were at before jumping (e.g. you were 1/4 into bar
// 4 -> you land 1/4 into bar 74, not exactly on the clicked pixel).
// Without a known beat grid (no BPM detected), nothing can be
// aligned: the target is returned as is.
export function barAlignedSeekTime(deck, fromTime, toTime) {
  if (!deck || !deck.bpm) return toTime;
  if (deck.beats && deck.beats.length >= 2) {
    const fFrom = gridIndexFracAt(deck, fromTime);
    const fTo = gridIndexFracAt(deck, toTime);
    if (fFrom == null || fTo == null) return toTime;
    const anchor = deck.barAnchor || 0;
    const relFrom = (fFrom - anchor) / 4;
    const relTo = (fTo - anchor) / 4;
    const phase = relFrom - Math.floor(relFrom);
    const targetBar = Math.floor(relTo);
    return gridTimeAtIndex(deck, anchor + (targetBar + phase) * 4);
  }
  if (deck.beatOffset == null) return toTime;
  const barLen = (4 * 60) / deck.bpm;
  const barFrom = (fromTime - deck.beatOffset) / barLen;
  const barTo = (toTime - deck.beatOffset) / barLen;
  const phase = barFrom - Math.floor(barFrom);
  const targetBar = Math.floor(barTo);
  return deck.beatOffset + (targetBar + phase) * barLen;
}

// Real-time pitch shifter (two delay lines swept as sawtooth waves and
// crossfaded): changes the key without changing the speed.
class PitchShifter {
  constructor(ctx) {
    this.ctx = ctx;
    this.T = 0.1;      // grain duration (s)
    this.base = 0.006; // minimum delay
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dA = ctx.createDelay(1);
    this.dB = ctx.createDelay(1);
    this.fA = ctx.createGain();
    this.fA.gain.value = 0;
    this.fB = ctx.createGain();
    this.fB.gain.value = 0;
    this.mA = ctx.createGain();
    this.mA.gain.value = 0;
    this.mB = ctx.createGain();
    this.mB.gain.value = 0;
    this.input.connect(this.dA);
    this.input.connect(this.dB);
    this.dA.connect(this.fA);
    this.dB.connect(this.fB);
    this.fA.connect(this.output);
    this.fB.connect(this.output);

    const mkSrc = (tri, phase, target) => {
      const sr = ctx.sampleRate;
      const len = Math.max(8, Math.round(this.T * sr));
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const ph = (i / len + phase) % 1;
        d[i] = tri ? 1 - Math.abs(2 * ph - 1) : ph;
      }
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.connect(target);
      s.start();
    };
    mkSrc(false, 0, this.mA);
    this.mA.connect(this.dA.delayTime);
    mkSrc(false, 0.5, this.mB);
    this.mB.connect(this.dB.delayTime);
    mkSrc(true, 0, this.fA.gain);
    mkSrc(true, 0.5, this.fB.gain);
    this.dA.delayTime.value = this.base;
    this.dB.delayTime.value = this.base;
  }

  // r = frequency ratio (2^(semitones/12))
  setRatio(r) {
    const now = this.ctx.currentTime;
    const D = (1 - r) * this.T;
    const base = this.base + Math.max(0, -D);
    this.dA.delayTime.setTargetAtTime(base, now, 0.02);
    this.dB.delayTime.setTargetAtTime(base, now, 0.02);
    this.mA.gain.setTargetAtTime(D, now, 0.02);
    this.mB.gain.setTargetAtTime(D, now, 0.02);
  }
}

// Generic echo loop: delay + feedback, with an optional filter and/or crush
// inside the loop (shared factory for the echo variants).
function buildEchoLoop(ctx, { fb = 0.45, filter = null, crush = null, maxT = 4, time = 0.25 } = {}) {
  const d = ctx.createDelay(maxT);
  d.delayTime.value = time;
  const g = ctx.createGain();
  g.gain.value = fb;
  let node = d;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.value = filter.freq;
    if (filter.q) f.Q.value = filter.q;
    node.connect(f);
    node = f;
  }
  if (crush) {
    const s = ctx.createWaveShaper();
    s.curve = crushCurve(crush);
    node.connect(s);
    node = s;
  }
  node.connect(g);
  g.connect(d);
  return { in: d, out: node, delay: d, fb: g, fbBase: fb };
}

// Share of the DRY sound removed when the effect is at full (the "nature" of
// the effect): an INSERT effect (gate, filter, crush, roll…) REPLACES the
// sound — at 100 % you only hear the effect; an echo/reverb ADDS to the
// sound (dry just compensated so it doesn't clip); flanger/phaser need
// the dry (the comb comes from mixing the two).
export const FX_DRY_CUT = {
  trans: 1, filter: 1, crush: 1, robot: 1, pan: 1,
  roll: 0, // (the ROLL is dosed inside the deck itself: loop ↔ track)
  flanger: 0.5, phaser: 0.5, reverb: 0.3
};
export const fxDryCut = (type) => FX_DRY_CUT[type] ?? 0.45;

export class Deck {
  constructor(ctx, destination, id) {
    this.ctx = ctx;
    this.id = id;

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
    this.filter.connect(this.fader);
    // PRE-FADER send to the headphone bus (the channel's headphone CUE button):
    // the deck is heard in the headphones even with the fader down — true PFL
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.cueOn = false;
    this.filter.connect(this.cueSend);
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
    this.filter.connect(this.analyser);
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
    this.keyShift = 0;
    this.musicKey = null;   // DETECTED key of the track (0-23, see key.js)
    this.keylock = false;   // keep the key when the tempo changes
    this.wsola = null;      // AudioWorkletNode, set by AudioEngine
    this.wsLat = 0;         // FIXED latency of the WSOLA engine (s)
    this.procLat = 0;       // latency of the ACTIVE path: the track is read that much AHEAD
    this._routeW = false;   // does the sound go through the WSOLA transposer?
    this._pitchOn = false;  // (fallback engine) is transposition active?

    // Stems (vocals / drums / bass / instrumental): 4 synchronized sources
    this.stems = null;
    this.stemsOn = false;
    this.stemGains = {};
    for (const s of ['vocals', 'drums', 'bass', 'other']) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(this.srcGain);
      this.stemGains[s] = g;
    }
    this._extraSources = [];

    this.buffer = null;
    this.track = null;      // { name, path }
    this.peaks = null;      // precomputed waveform
    this.bpm = null;
    this.beatOffset = null; // position of the first beat (fixed grid, fallback)
    this.beats = null;      // DYNAMIC grid: actual position of each beat
    this.gridShift = 0;     // manual grid offset (◀ ▶ arrows)
    this.barAnchor = 0;     // index of the beat that starts a bar (GRID)
    this.tempo = 1;
    this.playing = false;
    this.offset = 0;
    this.startCtx = 0;
    this.cuePoint = 0;
    this.source = null;
    this._stopping = false;
    this.synced = false;

    this.volume = 0.85;
    this.fader.gain.value = this.volume * this.volume;
    this.eq = { low: 0, mid: 0, high: 0 };
    this._lowBeforeKill = null;
    this.filterVal = 0;

    this.hotCues = new Array(8).fill(null);
    this.looping = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this._loopBeats = null;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.tempo : null;
  }

  loadTrack({ buffer, bpm, peaks, track, beatOffset, hotCues, beats, gridShift, barAnchor }) {
    this.stopRoll(true);
    this._padRoll = null;
    this._stopSource();
    this.playing = false;
    this.buffer = buffer;
    this.bpm = bpm || null;
    this.beatOffset = beatOffset != null ? beatOffset : null;
    this.beats = Array.isArray(beats) && beats.length > 2 ? beats : null;
    this.gridShift = gridShift || 0;
    this.barAnchor = barAnchor || 0;
    this.peaks = peaks || null;
    this.track = track || null;
    this.offset = 0;
    this.cuePoint = 0;
    this.tempo = 1;
    // SYNC STAYS ON from one track to the next (like on a CDJ): it
    // shouldn't have to be pressed again on every load. The new track does,
    // however, restart from a BLANK ratio — the old one means nothing
    // for it — and the lock re-aligns it to the master from the first frame.
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
    this.looping = false;
    this._loopBeats = null;
    this.stems = null;
    this.stemsOn = false;
    this.setKey(0);
    this.hotCues = new Array(8).fill(null);
    if (Array.isArray(hotCues)) {
      hotCues.slice(0, 8).forEach((c, i) => { this.hotCues[i] = c != null ? c : null; });
    }
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
      return primary;
    }
    return mk(this.buffer, this.srcGain);
  }

  // --- ROLL (repeat loop locked to the grid) ---
  // beats = loop length in beats (¼, ½, 1…); mix = intensity
  // (0 = track only, 1 = loop only). The loop starts at the LAST
  // multiple of "beats" on the grid: the sound continues normally
  // until the end of the slice, then repeats — right on time.
  startRoll(beats, mix = 1) {
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
      this.setRollMix(mix);
      return true;
    }
    this.stopRoll(true);
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
    this.setRollMix(mix, at);
    return true;
  }

  setRollMix(mix, at) {
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

  stopRoll(immediate) {
    const r = this._roll;
    if (!r) return;
    this._roll = null;
    const t = this.ctx.currentTime;
    this._rampGain(this.srcGain.gain, 1, t);
    this._rampGain(this.rollGain.gain, 0, t);
    try { r.src.stop(t + (immediate ? 0.02 : 0.04)); } catch { /* already stopped */ }
    r.src.onended = () => { try { r.src.disconnect(); } catch { /* nothing */ } };
  }

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

  // Enables the separated stems (vocals/drums/bass/instrumental) on this deck
  loadStems(stems) {
    this.stems = stems;
    this.stemsOn = true;
    for (const s of ['vocals', 'drums', 'bass', 'other']) {
      this.stemGains[s].gain.value = 1;
    }
    if (this.playing) this.seek(this.currentTime());
  }

  toggleStem(name) {
    const g = this.stemGains[name];
    const on = g.gain.value < 0.5;
    g.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
    return on;
  }

  // Key in semitones (-7..+7), without changing the speed
  setKey(semi) {
    this.keyShift = clamp(Math.round(semi), -7, 7);
    this._applyPitch();
  }

  // KEYLOCK: keep the original key when the tempo changes
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
      this.procLat = L;
      ramp(this.dirGain.gain, on ? 0 : 1, now);
      ramp(this.wsOut.gain, on ? 1 : 0, now);
      return;
    }
    const heard = this.currentTime();
    const old = [this.source, ...this._extraSources].filter(Boolean);
    this.source = null;
    this._extraSources = [];
    this._routeW = on;
    this.procLat = L;
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

  // TRIM: -1 -> -12 dB, 0 -> neutral, +1 -> +12 dB
  setTrim(v) {
    this.trimVal = clamp(v, -1, 1);
    this.trim.gain.setTargetAtTime(Math.pow(4, this.trimVal), this.ctx.currentTime, 0.01);
  }

  // Instantaneous peak level (0..~2) for the VU meter
  meterPeak() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (let i = 0; i < this.meterBuf.length; i += 2) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // --- Loops (sample-accurate via the source's native loop) ---
  setLoop(start, end) {
    start = Math.max(0, start);
    end = Math.min(this.duration, end);
    if (end - start < 0.01) return;
    this.loopStart = start;
    this.loopEnd = end;
    this.looping = true;
    for (const s of [this.source, ...this._extraSources]) {
      if (!s) continue;
      s.loopStart = start;
      s.loopEnd = end;
      s.loop = true;
    }
  }

  exitLoop() {
    if (!this.looping) return;
    if (this.playing) {
      const pos = this.currentTime();
      this.offset = pos;
      this.startCtx = this.ctx.currentTime;
    }
    this.looping = false;
    this._loopBeats = null;
    for (const s of [this.source, ...this._extraSources]) {
      if (s) s.loop = false;
    }
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
        this._endedAt = performance.now() / 1000;
        if (this.onEnded) this.onEnded();
      }
    };
  }

  play() {
    if (!this.buffer || this.playing) return;
    this._endedAt = 0;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.source = this._makeSource();
    this._attachEnded(this.source);
    this.startCtx = this._startAll(0, this.offset, false);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.stopRoll(true);
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
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
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

  seek(t) {
    if (!this.buffer) return;
    t = clamp(t, -PRE_ROLL, this.duration);
    // Jumping out of the loop disables it
    if (this.looping && (t < this.loopStart || t >= this.loopEnd)) {
      this.looping = false;
      this._loopBeats = null;
      for (const s of [this.source, ...this._extraSources]) {
        if (s) s.loop = false;
      }
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
  }

  // --- Velocity-based audible scratch: the sound plays ONLY during the movement,
  // at the speed of the gesture (still = silence, like a real vinyl held down).
  scrubStart() {
    if (!this.buffer) return;
    this._scrubbing = true;
    this._scrubLastPos = this.offset;
    this._scrubLastTime = this.ctx.currentTime;
  }

  scrubMove(t) {
    t = clamp(t, -PRE_ROLL, this.duration);
    if (!this._scrubbing) {
      this.offset = t;
      return;
    }
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

  scrubEnd() {
    this._scrubbing = false;
  }

  // CDJ behavior: paused -> sets the cue point; playing -> back to the cue + pause.
  // "rekordbox-quality" V.BRAKE / BACKSPIN: a CONTINUOUS PLAYBACK of a
  // slice of the track (reversed for the backspin) whose SPEED goes down
  // in a native WebAudio ramp — zero grains, zero choppiness, the real sound of
  // tape braking / rewinding. (the old scrub-grain engine
  // "sputtered" at high speed: grains are choppy by nature)
  spinSound(kind) {
    this.stopSpinSound();
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
    this._spinSrc = { s, g };
  }

  stopSpinSound() {
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

  cue() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else {
      if (Math.abs(this.currentTime() - this.cuePoint) < 0.02) {
        this.seek(this.cuePoint);
      } else {
        this.cuePoint = this.currentTime();
      }
    }
  }

  setTempo(r) {
    r = clamp(r, 0.5, 1.6);
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
    if (this._onTempo) this._onTempo(this);
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

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    // Quadratic curve: more natural to the ear
    this.fader.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.01);
  }

  // band: 'low' | 'mid' | 'high', v in [-1, 1]; -1 = kill (-40 dB), +1 = +6 dB
  setEq(band, v) {
    v = clamp(v, -1, 1);
    this.eq[band] = v;
    const db = v >= 0 ? v * 6 : v * 40;
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  toggleBassKill() {
    if (this._lowBeforeKill === null) {
      this._lowBeforeKill = this.eq.low;
      this.setEq('low', -1);
    } else {
      this.setEq('low', this._lowBeforeKill);
      this._lowBeforeKill = null;
    }
    return this._lowBeforeKill !== null;
  }

  // v in [-1, 1]: negative = low-pass (cuts the highs), positive = high-pass (cuts the lows)
  setFilter(v) {
    v = clamp(v, -1, 1);
    this.filterVal = v;
    this._applyBiquad(v);
  }

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
}

// Synthetic impulse response for the reverb (exponentially decaying
// noise). MEMOIZED: an AudioBuffer is read-only on the Web
// Audio side, so all FX units can share the SAME one — we used to build
// up to 9 identical ones (4 units + master + pad FX), i.e. ~6.8 MB and 25 ms
// of computation for nothing.
const _impCache = new Map();
function makeImpulse(ctx, seconds, decay) {
  const key = `${seconds}|${decay}|${ctx.sampleRate}`;
  const hit = _impCache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  _impCache.set(key, buf);
  return buf;
}

function crushCurve(steps) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

// Beat FX-style effects unit: one effect at a time, assignable to 1..4 decks,
// wired as a send (the dry sound keeps passing, the effect adds on top).
export class FxUnit {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.wet = ctx.createGain();
    // The FX ALWAYS starts at the lowest point (David's request): the
    // level is raised with the stick, never a surprise on activation
    this.level = 0;
    this.wet.gain.value = this.level;
    this.wet.connect(output);
    this.enabled = false;
    this.type = 'echo';
    this.beatDur = 0.5;   // duration of one beat (s), follows the master's BPM
    this.beatsMult = 0.5; // chosen beat fraction (¼, ½, 1, 2)

    // Echo (delay with feedback, low-cut inside the loop)
    this.echoDelay = ctx.createDelay(4);
    this.echoDelay.delayTime.value = 0.25;
    this.echoHp = ctx.createBiquadFilter();
    this.echoHp.type = 'highpass';
    this.echoHp.frequency.value = 120;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.45;
    this.echoDelay.connect(this.echoHp);
    this.echoHp.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);

    // Reverb
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeImpulse(ctx, 2.2, 2.5);

    // Flanger (short delay modulated by an LFO + feedback)
    this.flDelay = ctx.createDelay(0.05);
    this.flDelay.delayTime.value = 0.004;
    this.flFb = ctx.createGain();
    this.flFb.gain.value = 0.4;
    this.flDelay.connect(this.flFb);
    this.flFb.connect(this.flDelay);
    this.flLfo = ctx.createOscillator();
    this.flLfo.frequency.value = 0.25;
    this.flLfoGain = ctx.createGain();
    this.flLfoGain.gain.value = 0.0022;
    this.flLfo.connect(this.flLfoGain);
    this.flLfoGain.connect(this.flDelay.delayTime);
    this.flLfo.start();

    // Crush (resolution reduction)
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = crushCurve(8);

    // (Simple Delay, Ping Pong, Low Cut, the echo variants and MT Delay are
    // built ON FIRST USE — see _chain/_mk below: each
    // createDelay(4) reserves ~1 MB as soon as it is created, and only one chain
    // runs at a time. That was ~50 MB of dead buffer at startup.)

    // Phaser (4 modulated all-pass filters)
    this.phStages = [350, 700, 1100, 1600].map((f) => {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = f;
      ap.Q.value = 0.6;
      return ap;
    });
    for (let s = 0; s < this.phStages.length - 1; s++) {
      this.phStages[s].connect(this.phStages[s + 1]);
    }
    this.phLfo = ctx.createOscillator();
    this.phLfo.frequency.value = 0.4;
    this.phLfoGain = ctx.createGain();
    this.phLfoGain.gain.value = 280;
    this.phLfo.connect(this.phLfoGain);
    this.phStages.forEach((ap) => this.phLfoGain.connect(ap.frequency));
    this.phLfo.start();

    // Trans (square rhythmic gate locked to the tempo)
    this.trGain = ctx.createGain();
    this.trGain.gain.value = 0;
    this.trConst = ctx.createConstantSource();
    this.trConst.offset.value = 0.5;
    this.trConst.connect(this.trGain.gain);
    this.trConst.start();
    this.trOsc = ctx.createOscillator();
    this.trOsc.type = 'square';
    this.trOsc.frequency.value = 4;
    this.trOscGain = ctx.createGain();
    this.trOscGain.gain.value = 0.5;
    this.trOsc.connect(this.trOscGain);
    this.trOscGain.connect(this.trGain.gain);
    this.trOsc.start();

    // Auto pan (left/right in rhythm)
    this.panNode = ctx.createStereoPanner();
    this.panLfo = ctx.createOscillator();
    this.panLfo.frequency.value = 1;
    this.panLfoGain = ctx.createGain();
    this.panLfoGain.gain.value = 0.9;
    this.panLfo.connect(this.panLfoGain);
    this.panLfoGain.connect(this.panNode.pan);
    this.panLfo.start();

    // Filter (band sweep synced to the tempo)
    this.fxbp = ctx.createBiquadFilter();
    this.fxbp.type = 'bandpass';
    this.fxbp.frequency.value = 800;
    this.fxbp.Q.value = 1.4;
    this.fxbpLfo = ctx.createOscillator();
    this.fxbpLfo.frequency.value = 0.5;
    this.fxbpLfoGain = ctx.createGain();
    this.fxbpLfoGain.gain.value = 650;
    this.fxbpLfo.connect(this.fxbpLfoGain);
    this.fxbpLfoGain.connect(this.fxbp.frequency);
    this.fxbpLfo.start();

    // Robot (ring modulation)
    this.rmGain = ctx.createGain();
    this.rmGain.gain.value = 0;
    this.rmOsc = ctx.createOscillator();
    this.rmOsc.frequency.value = 35;
    this.rmOsc.connect(this.rmGain.gain);
    this.rmOsc.start();

    // Delay lines to keep in time with the tempo: the ones that EXIST
    // (the others are born already in time, see _timeNow)
    this._delays = [this.echoDelay];
    this._lazy = {};
    // Feedbacks scaled by the LEVEL (the echo gets longer as it goes up)
    this._fbs = [{ g: this.echoFb, base: 0.45 }];
    // ROLL: played by the DECK (track loop locked to the grid), not
    // by a delay line — so the unit outputs nothing for it
    this._mute = ctx.createGain();
    this._mute.gain.value = 0;

    this._out = null;
    this._route();
  }

  // CURRENT delay time, without a ramp: a new chain must be born
  // in time, otherwise its 1st repeat starts at 0.25 s and "slides" toward the
  // tempo (audible doppler effect).
  _timeNow() { return clamp(this.beatDur * this.beatsMult, 0.02, 3.9); }

  // Lazy factory: builds the chain on first use, keeps it
  _mk(key, build) {
    let v = this._lazy[key];
    if (!v) v = this._lazy[key] = build();
    return v;
  }

  _echo(opts) {
    const c = buildEchoLoop(this.ctx, { ...opts, time: this._timeNow() });
    this._delays.push(c.delay);
    this._fbs.push({ g: c.fb, base: c.fbBase });
    c.fb.gain.value = this._fbFor(c.fbBase);
    return c;
  }

  // Feedback according to the level: at low level the echo is short and
  // discreet, at full it takes its whole tail (capped below 1: never runs away)
  _fbFor(base) {
    return Math.min(0.97, base * (0.55 + 0.45 * this.level));
  }

  _chain() {
    switch (this.type) {
      case 'delay': {
        const d = this._mk('delay', () => {
          const n = this.ctx.createDelay(4);
          n.delayTime.value = this._timeNow();
          const fb = this.ctx.createGain();
          fb.gain.value = this._fbFor(0.22);
          n.connect(fb);
          fb.connect(n);
          this._delays.push(n);
          this._fbs.push({ g: fb, base: 0.22 });
          return n;
        });
        return [d, d];
      }
      case 'pingpong': {
        const p = this._mk('pingpong', () => {
          const t = this._timeNow();
          const L = this.ctx.createDelay(4);
          const R = this.ctx.createDelay(4);
          L.delayTime.value = t;
          R.delayTime.value = t;
          const fb = this.ctx.createGain();
          fb.gain.value = this._fbFor(0.42);
          this._fbs.push({ g: fb, base: 0.42 });
          const pL = this.ctx.createStereoPanner();
          pL.pan.value = -0.85;
          const pR = this.ctx.createStereoPanner();
          pR.pan.value = 0.85;
          const out = this.ctx.createGain();
          L.connect(pL); pL.connect(out);
          L.connect(R);
          R.connect(pR); pR.connect(out);
          R.connect(fb); fb.connect(L);
          this._delays.push(L, R);
          return { in: L, out };
        });
        return [p.in, p.out];
      }
      case 'reverb': return [this.convolver, this.convolver];
      case 'flanger': return [this.flDelay, this.flDelay];
      case 'phaser': return [this.phStages[0], this.phStages[this.phStages.length - 1]];
      case 'trans': return [this.trGain, this.trGain];
      case 'crush': return [this.shaper, this.shaper];
      case 'lowcut': {
        // output = THE DELAY (the high-pass is in the feedback
        // loop, not at the output) — original routing kept
        const c = this._mk('lowcut', () => this._echo({ fb: 0.5, filter: { type: 'highpass', freq: 700 } }));
        return [c.delay, c.delay];
      }
      case 'spiral': {
        const c = this._mk('spiral', () => this._echo({ fb: 0.72, filter: { type: 'bandpass', freq: 900, q: 0.9 } }));
        return [c.in, c.out];
      }
      case 'upecho': {
        const c = this._mk('upecho', () => this._echo({ fb: 0.5, filter: { type: 'highpass', freq: 500 } }));
        return [c.in, c.out];
      }
      case 'downecho': {
        const c = this._mk('downecho', () => this._echo({ fb: 0.5, filter: { type: 'lowpass', freq: 1200 } }));
        return [c.in, c.out];
      }
      case 'roll': return [this._mute, this._mute];
      case 'helix': {
        const c = this._mk('helix', () => this._echo({ fb: 0.97 }));
        return [c.in, c.out];
      }
      case 'mtdelay': {
        const mt = this._mk('mtdelay', () => {
          const t = this._timeNow();
          const d1 = this.ctx.createDelay(4);
          const d2 = this.ctx.createDelay(4);
          const d3 = this.ctx.createDelay(4);
          d1.delayTime.value = t;
          d2.delayTime.value = t;
          d3.delayTime.value = t;
          const out = this.ctx.createGain();
          const g1 = this.ctx.createGain(); g1.gain.value = 0.8;
          const g2 = this.ctx.createGain(); g2.gain.value = 0.55;
          const g3 = this.ctx.createGain(); g3.gain.value = 0.35;
          d1.connect(g1); g1.connect(out); d1.connect(d2);
          d2.connect(g2); g2.connect(out); d2.connect(d3);
          d3.connect(g3); g3.connect(out);
          this._delays.push(d1, d2, d3);
          return { in: d1, out };
        });
        return [mt.in, mt.out];
      }
      case 'pan': return [this.panNode, this.panNode];
      case 'filter': return [this.fxbp, this.fxbp];
      case 'robot': return [this.rmGain, this.rmGain];
      default: return [this.echoDelay, this.echoDelay];
    }
  }

  _route() {
    try { this.input.disconnect(); } catch { /* nothing */ }
    if (this._out) {
      try { this._out.disconnect(this.wet); } catch { /* nothing */ }
      this._out = null;
    }
    if (!this.enabled) return;
    const [cIn, cOut] = this._chain();
    this.input.connect(cIn);
    cOut.connect(this.wet);
    this._out = cOut;
  }

  setType(t) {
    this.type = t;
    this._route();
  }

  setEnabled(b) {
    this.enabled = b;
    this._route();
  }

  setLevel(v) {
    this.level = clamp(v, 0, 1);
    const now = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(this.level, now, 0.02);
    // The INTENSITY also acts INSIDE the effect (not just on its volume):
    // echo tail, sweep depth, flanger feedback
    for (const f of this._fbs) f.g.gain.setTargetAtTime(this._fbFor(f.base), now, 0.05);
    this.fxbpLfoGain.gain.setTargetAtTime(650 * (0.35 + 0.65 * this.level), now, 0.05);
    this.flFb.gain.setTargetAtTime(0.15 + 0.5 * this.level, now, 0.05);
  }

  // BEAT ALIGNMENT: the modulations (TRANS gate, sweeps of the
  // flanger, phaser, filter, pan) restart EXACTLY on a beat
  // of the track — before, their oscillators ran with an arbitrary
  // phase: the gate chopped off the beat, "tied to nothing".
  // at = audio (ctx) time of the start of a beat / bar.
  alignTo(at) {
    const t = this._timeNow();
    if (!this._oscList) this._oscList = {};
    const swap = (key, type, freq, dest) => {
      // ALL still-running oscillators of this modulation stop
      // at "at" — the running one AND any replacement that hasn't
      // started yet (otherwise two LFOs added up: gate at 150 %)
      const list = this._oscList[key] || (this._oscList[key] = [this[key]]);
      for (const old of list) {
        try { old.stop(at); } catch { /* already stopped */ }
        old.onended = () => { try { old.disconnect(); } catch { /* nothing */ } };
      }
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.connect(dest);
      o.start(at);
      this._oscList[key] = [o];
      this[key] = o;
    };
    switch (this.type) {
      case 'trans': swap('trOsc', 'square', clamp(1 / t, 0.25, 24), this.trOscGain); break;
      case 'flanger': swap('flLfo', 'sine', clamp(0.125 / t, 0.05, 4), this.flLfoGain); break;
      case 'phaser': swap('phLfo', 'sine', clamp(0.25 / t, 0.05, 6), this.phLfoGain); break;
      case 'pan': swap('panLfo', 'sine', clamp(0.5 / t, 0.05, 8), this.panLfoGain); break;
      case 'filter': swap('fxbpLfo', 'sine', clamp(0.5 / t, 0.05, 8), this.fxbpLfoGain); break;
      default: return false;
    }
    this._alignedDur = this.beatDur;
    return true;
  }

  // Modulation period in BEATS (to choose where to restart)
  modPeriodBeats() {
    const m = this.beatsMult;
    switch (this.type) {
      case 'trans': return m;
      case 'flanger': return 8 * m;
      case 'phaser': return 4 * m;
      case 'pan': case 'filter': return 2 * m;
      default: return null;
    }
  }

  setBeatsMult(m) {
    this.beatsMult = m;
    this._applyTime();
  }

  setBeatDur(sec) {
    // 0.05 % threshold (not 2 ms ≈ 0.5 %): an echo locked to a tempo that is
    // off by half a percent drifts with every repeat
    if (Math.abs(sec - this.beatDur) < this.beatDur * 0.0005) return;
    this.beatDur = sec;
    this._applyTime();
  }

  _applyTime() {
    const now = this.ctx.currentTime;
    const t = clamp(this.beatDur * this.beatsMult, 0.02, 3.9);
    // Only the lines ACTUALLY built (the others will be born in
    // time) — and incidentally: 1 to 3 AudioParam events instead of 13
    for (const d of this._delays) d.delayTime.setTargetAtTime(t, now, 0.08);
    // The gate closes/opens at each chosen interval
    this.trOsc.frequency.setTargetAtTime(clamp(1 / t, 0.25, 24), now, 0.05);
    // The modulations follow the tempo
    this.flLfo.frequency.setTargetAtTime(clamp(0.125 / t, 0.05, 4), now, 0.1);
    this.phLfo.frequency.setTargetAtTime(clamp(0.25 / t, 0.05, 6), now, 0.1);
    this.panLfo.frequency.setTargetAtTime(clamp(0.5 / t, 0.05, 8), now, 0.1);
    this.fxbpLfo.frequency.setTargetAtTime(clamp(0.5 / t, 0.05, 8), now, 0.1);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // Safety limiter on the master
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;

    // Post-mix bus: master -> (FX/color returns) -> MASTER FILTER -> limiter
    this.postBus = this.ctx.createGain();
    this.mFilter = this.ctx.createBiquadFilter();
    this.mFilter.type = 'peaking';
    this.mFilter.gain.value = 0;
    this.mFilter.frequency.value = 1000;
    this.mFilter.Q.value = 0.9;
    this.masterFilterVal = 0;
    // Compensated DRY path: when an FX is active, this gain goes down by as much
    // (rekordbox-style calibration — the wet blends INTO the mix instead of
    // stacking on top and exceeding the master level)
    this.dryComp = this.ctx.createGain();
    this.masterGain.connect(this.dryComp);
    this.dryComp.connect(this.postBus);
    // FX RETURNS (panel units, FX pads, Color FX): they follow the
    // MASTER VOLUME like the dry sound — an insert effect at full cuts the
    // dry, and without this gain the master knob had no control over that deck anymore
    this.fxReturn = this.ctx.createGain();
    this.fxReturn.gain.value = 0.9;
    this.fxReturn.connect(this.postBus);
    this.postBus.connect(this.mFilter);
    this.mFilter.connect(this.limiter);
    // --- HEADPHONE CUE: the controller is a 4-CHANNEL SOUND CARD
    // (master on 1/2, headphones on 3/4). If the output offers it, the CUE bus
    // goes to channels 3/4 — the FLX6's physical headphone output.
    this.cueBus = this.ctx.createGain();
    this._wireOutput();

    // MASTER VU meter (taken before the limiter: the red LED says
    // "it's clipping, the limiter is working")
    this.masterVolume = 0.9;
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.mFilter.connect(this.masterAnalyser);
    this.masterMeterBuf = new Float32Array(this.masterAnalyser.fftSize);

    // Parallel output for recording the mix (MediaRecorder)
    this.recDest = this.ctx.createMediaStreamDestination();
    this.limiter.connect(this.recDest);

    this.decks = [0, 1, 2, 3].map(i => new Deck(this.ctx, this.masterGain, i));
    // The master changes tempo (fader, + / −, controller…): the synced decks
    // follow in the SAME frame, not the next one — otherwise each step
    // left a small offset ("not everything happens at the same time")
    this.decks.forEach((d, i) => { d._onTempo = () => this._followMaster(i); });
    // Headphone sends from each deck to the CUE bus
    this.decks.forEach((d) => d.cueSend.connect(this.cueBus));
    this._loadPitchWorklet();

    // 4 FX units (one per player), each assignable to any
    // deck(s): send matrix of 4 units × 4 decks
    this.fx = [0, 1, 2, 3].map(() => new FxUnit(this.ctx, this.fxReturn));
    // fxAssign[u][i]: unit u processes deck i (default: its own deck)
    this.fxAssign = [0, 1, 2, 3].map((u) => [0, 1, 2, 3].map((i) => i === u));
    this.decks.forEach((d) => {
      d.fxSends = this.fx.map((unit) => {
        const g = this.ctx.createGain();
        g.gain.value = 0;
        d.xf.connect(g);
        g.connect(unit.input);
        return g;
      });
    });

    // PAD FX units: one per deck, INDEPENDENT of the 4 panel units —
    // a held pad NEVER writes into the player's FX config. Created ON
    // DEMAND (first press): zero audio nodes as long as they are not
    // used — the software must stay light even on an old machine
    this.padFx = [null, null, null, null];

    // Color FX: what each channel's FILTER knob does
    // ('filter' = classic biquad, otherwise a send to a shared effect)
    this.colorType = 'filter';
    this.colorEnabled = true;
    this.colorWet = this.ctx.createGain();
    this.colorWet.gain.value = 0.85; // capped so as not to exceed the track's level
    this.colorWet.connect(this.fxReturn);
    this.colorBus = this.ctx.createGain();
    // Color FX chains built ON FIRST ROUTING (5 × ~1 MB of delay buffer
    // reserved for nothing at startup — see _colorChain)
    this._colorDefs = {
      dubecho: { fb: 0.55, filter: { type: 'highpass', freq: 250 }, time: 0.35 },
      hpfecho: { fb: 0.5, filter: { type: 'highpass', freq: 900 }, time: 0.3 },
      lpfecho: { fb: 0.5, filter: { type: 'lowpass', freq: 650 }, time: 0.3 },
      bpfecho: { fb: 0.55, filter: { type: 'bandpass', freq: 1000, q: 1 }, time: 0.3 },
      crushecho: { fb: 0.5, crush: 6, time: 0.3 }
    };
    this.colorChains = {};
    this.cReverb = this.ctx.createConvolver();
    this.cReverb.buffer = makeImpulse(this.ctx, 2.8, 2.2);
    this.cCrush = this.ctx.createWaveShaper();
    this.cCrush.curve = crushCurve(5);

    // Shared white noise source (Color FX "Noise")
    const nb = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseSrc = this.ctx.createBufferSource();
    this.noiseSrc.buffer = nb;
    this.noiseSrc.loop = true;
    this.noiseSrc.start();

    this._colorOut = null;
    this.decks.forEach((d) => {
      d.colorSend = this.ctx.createGain();
      d.colorSend.gain.value = 0;
      d.filter.connect(d.colorSend);
      d.colorSend.connect(this.colorBus);
      // White noise dosed by the knob, which follows the deck's fader
      d.noiseGain = this.ctx.createGain();
      d.noiseGain.gain.value = 0;
      this.noiseSrc.connect(d.noiseGain);
      d.noiseGain.connect(d.fader);
    });
    this._routeColor();

    // Decks 1 & 3 -> side A, decks 2 & 4 -> side B (like Rekordbox in 4-deck mode)
    this.xfSides = ['A', 'B', 'A', 'B'];
    this.crossfader = 0.5;
    this.masterIdx = null;     // master chosen by hand (MASTER button)
    this.autoMasterIdx = null; // automatic master (first-started rule)
    this.applyCrossfader();
  }

  // MASTER FX: a unit on the WHOLE MIX (MASTER position of the controllers'
  // channel select). Created on demand, wired in parallel like
  // the deck FX: masterGain → send → unit → postBus (wet on top)
  // WSOLA transposition engine (KEY ± and KEYLOCK): one node per deck,
  // loaded in the background. If it fails, each deck keeps its old
  // two-tap shifter — the software stays usable in every case.
  async _loadPitchWorklet() {
    try {
      await this.ctx.audioWorklet.addModule(new URL('./pitch-worklet.js', import.meta.url));
      this.decks.forEach((d) => {
        const node = new AudioWorkletNode(this.ctx, 'pitch-shift', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit'
        });
        // Connected PERMANENTLY in parallel with the direct path: only the output
        // gain (wsOut) decides what is heard
        d.preIn.connect(node);
        node.connect(d.wsOut);
        // FIXED latency of the engine (announced by it; value known in advance
        // so as not to depend on the message arriving)
        d.wsLat = WS_LAT_SAMPLES / this.ctx.sampleRate;
        node.port.onmessage = (e) => {
          if (e.data && e.data.lat) {
            d.wsLat = e.data.lat / this.ctx.sampleRate;
            if (d._routeW) d.procLat = d.wsLat;
          }
        };
        d.wsola = node;
        d._applyPitch(); // re-route if a key was already set
      });
      console.log('[midi] transposition: WSOLA engine active (keylock available)');
    } catch (e) {
      console.log(`[midi] transposition: fallback engine (${String(e.message || e)})`);
    }
  }

  // Output wiring: 4 channels if the device allows it
  // (master → 1/2, headphones → 3/4), otherwise plain stereo. MUST BE CALLED AGAIN after
  // every setSinkId (the channel count depends on the device).
  _wireOutput() {
    const dest = this.ctx.destination;
    try { this.limiter.disconnect(); } catch { /* not connected yet */ }
    try { this.cueBus.disconnect(); } catch { /* same */ }
    // (the limiter also feeds the recorder: reconnect it)
    if (this.recDest) this.limiter.connect(this.recDest);
    if (this.phonesCtx && this._phonesStream) {
      // HEADPHONES ON ANOTHER CARD (the controller): only the master goes out here,
      // in stereo — nothing on channels 3/4 of the master output anymore
      this.cueBus.connect(this._phonesStream);
      dest.channelCount = Math.min(2, dest.maxChannelCount || 2);
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'speakers';
      this.limiter.connect(dest);
      this.phonesOk = true;
      return;
    }
    if (dest.maxChannelCount >= 4) {
      dest.channelCount = 4;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = this.ctx.createChannelMerger(4);
      const ms = this.ctx.createChannelSplitter(2);
      const cs = this.ctx.createChannelSplitter(2);
      this.limiter.connect(ms);
      ms.connect(merger, 0, 0);
      ms.connect(merger, 1, 1);
      this.cueBus.connect(cs);
      cs.connect(merger, 0, 2);
      cs.connect(merger, 1, 3);
      merger.connect(dest);
      this.phonesOk = true;
      console.log('[midi] audio: 4-channel output — headphones active (channels 3/4)');
    } else {
      this.limiter.connect(dest);
      this.phonesOk = false;
      console.log(`[midi] audio: ${dest.maxChannelCount}-channel output — no separate headphones`);
    }
  }

  // SEPARATE HEADPHONE OUTPUT. The master can go out on one card (Scarlett,
  // PC speakers…) and the headphones on the CONTROLLER: the FLX6 is a
  // 4-channel sound card whose headphone jack reads channels 3/4. Before, the
  // CUE bus went to channels 3/4 of the MASTER output — so to the
  // Scarlett, never to the headphones plugged into the controller.
  // empty deviceId = no separate headphone card (channels 3/4 of the master).
  async setPhonesDevice(deviceId) {
    const id = deviceId || '';
    if (id === (this.phonesDevice || '') && (!id || this.phonesCtx)) return true;
    if (this.phonesCtx) {
      const old = this.phonesCtx;
      this.phonesCtx = null;
      old.close().catch(() => {});
    }
    this.phonesDevice = id;
    if (!id) {
      this._wireOutput();
      return true;
    }
    try {
      const pc = new AudioContext({ latencyHint: 'interactive' });
      await pc.setSinkId(id);
      if (!this._phonesStream) this._phonesStream = this.ctx.createMediaStreamDestination();
      const src = pc.createMediaStreamSource(this._phonesStream.stream);
      const dest = pc.destination;
      if (dest.maxChannelCount >= 4) {
        // 4-channel card (DJ controller): headphones = channels 3/4
        dest.channelCount = 4;
        dest.channelCountMode = 'explicit';
        dest.channelInterpretation = 'discrete';
        const sp = pc.createChannelSplitter(2);
        const mg = pc.createChannelMerger(4);
        src.connect(sp);
        sp.connect(mg, 0, 2);
        sp.connect(mg, 1, 3);
        mg.connect(dest);
      } else {
        // plain stereo card dedicated to the headphones
        src.connect(dest);
      }
      pc.resume().catch(() => {});
      this.phonesCtx = pc;
      this._wireOutput();
      console.log(`[midi] audio: headphones on a separate card (${dest.maxChannelCount} channels)`);
      return true;
    } catch (e) {
      console.log(`[midi] audio: headphone card unavailable (${String(e.message || e)})`);
      this.phonesDevice = '';
      this.phonesCtx = null;
      this._wireOutput();
      return false;
    }
  }

  // A channel's headphone CUE button: sends/cuts the deck in the headphones
  setCuePfl(i, on) {
    const d = this.decks[i];
    d.cueOn = !!on;
    d.cueSend.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  ensureMasterFx() {
    if (!this.masterFx) {
      this.masterFx = new FxUnit(this.ctx, this.postBus);
      const g = this.ctx.createGain();
      g.gain.value = 1;
      this.masterGain.connect(g);
      g.connect(this.masterFx.input);
    }
    return this.masterFx;
  }

  // PAD FX: preset {type, beats, level} = effect active on the deck, null = off
  setPadFx(i, preset) {
    const d = this.decks[i];
    if (!this.padFx[i]) {
      if (!preset) return;
      this.padFx[i] = new FxUnit(this.ctx, this.fxReturn);
      d.padFxSend = this.ctx.createGain();
      d.padFxSend.gain.value = 0;
      d.xf.connect(d.padFxSend);
      d.padFxSend.connect(this.padFx[i].input);
    }
    const u = this.padFx[i];
    const t = this.ctx.currentTime;
    if (preset) {
      u.setType(preset.type);
      u.setBeatsMult(preset.beats);
      u.setLevel(preset.level);
      u.setEnabled(true);
      d.padFxSend.gain.setTargetAtTime(1, t, 0.01);
    } else {
      d.padFxSend.gain.setTargetAtTime(0, t, 0.02);
      u.setEnabled(false);
    }
  }

  updateFxSends() {
    const t = this.ctx.currentTime;
    this.decks.forEach((d, i) => {
      d.fxSends.forEach((g, u) => {
        const on = this.fx[u].enabled && this.fxAssign[u][i];
        g.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
      });
    });
  }

  // MASTER volume: the level of the whole assembled mix
  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
    this.fxReturn.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
  }

  // Peak level of the assembled mix (before the limiter)
  masterPeak() {
    this.masterAnalyser.getFloatTimeDomainData(this.masterMeterBuf);
    let m = 0;
    for (let i = 0; i < this.masterMeterBuf.length; i += 2) {
      const v = Math.abs(this.masterMeterBuf[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // MASTER filter: acts on the whole mix (all 4 tracks at once)
  setMasterFilter(v) {
    v = clamp(v, -1, 1);
    this.masterFilterVal = v;
    const f = this.mFilter;
    if (Math.abs(v) < 0.04) {
      f.type = 'peaking';
      f.gain.value = 0;
      f.frequency.value = 1000;
    } else if (v > 0) {
      f.type = 'highpass';
      f.Q.value = 0.9;
      f.frequency.value = 20 * Math.pow(400, v);
    } else {
      f.type = 'lowpass';
      f.Q.value = 0.9;
      f.frequency.value = 20000 * Math.pow(80 / 20000, -v);
    }
  }

  // --- Color FX: mode of each channel's FILTER knob ---
  _routeColor() {
    try { this.colorBus.disconnect(); } catch { /* nothing */ }
    if (this._colorOut) {
      try { this._colorOut.disconnect(this.colorWet); } catch { /* nothing */ }
      this._colorOut = null;
    }
    let io = null;
    if (this._colorDefs[this.colorType]) {
      let c = this.colorChains[this.colorType];
      if (!c) {
        c = this.colorChains[this.colorType] =
          buildEchoLoop(this.ctx, this._colorDefs[this.colorType]);
      }
      io = [c.in, c.out];
    } else if (this.colorType === 'reverb') {
      io = [this.cReverb, this.cReverb];
    } else if (this.colorType === 'crush') {
      io = [this.cCrush, this.cCrush];
    }
    // 'filter' and 'noise': no bus (deck biquad / per-deck noise gain)
    if (io) {
      this.colorBus.connect(io[0]);
      io[1].connect(this.colorWet);
      this._colorOut = io[1];
    }
  }

  setColorType(t) {
    this.colorType = t;
    this._routeColor();
    // Re-apply each knob's value in the new mode
    this.decks.forEach((_, i) => this.setDeckColor(i, this.decks[i].filterVal));
  }

  // Global ON/OFF: when OFF, turning a FILTER knob has no effect
  setColorEnabled(b) {
    this.colorEnabled = b;
    this.decks.forEach((_, i) => this.setDeckColor(i, this.decks[i].filterVal));
  }

  setDeckColor(i, v) {
    const d = this.decks[i];
    const now = this.ctx.currentTime;
    d.filterVal = Math.max(-1, Math.min(1, v));
    if (!this.colorEnabled) {
      d._applyBiquad(0);
      d.colorSend.gain.setTargetAtTime(0, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(0, now, 0.01);
      return;
    }
    const amt = Math.abs(d.filterVal);
    if (this.colorType === 'filter') {
      d._applyBiquad(d.filterVal);
      d.colorSend.gain.setTargetAtTime(0, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(0, now, 0.01);
    } else if (this.colorType === 'noise') {
      d._applyBiquad(0);
      d.colorSend.gain.setTargetAtTime(0, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(amt * amt * 0.4, now, 0.01);
    } else {
      d._applyBiquad(0);
      d.colorSend.gain.setTargetAtTime(amt, now, 0.01);
      d.noiseGain.gain.setTargetAtTime(0, now, 0.01);
    }
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  setCrossfader(x) {
    this.crossfader = clamp(x, 0, 1);
    this.applyCrossfader();
  }

  applyCrossfader() {
    const x = this.crossfader;
    // "Mix" curve: both sides at full in the center
    const gA = x <= 0.5 ? 1 : (1 - x) * 2;
    const gB = x >= 0.5 ? 1 : x * 2;
    this.decks.forEach((d, i) => {
      const g = this.xfSides[i] === 'A' ? gA : gB;
      d.xf.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    });
  }

  setMaster(i) {
    this.masterIdx = this.masterIdx === i ? null : i;
  }

  // AUTOMATIC MASTER rule (David's spec): the FIRST sound started becomes
  // the master; it STAYS master as long as it plays; when it stops, the master
  // goes to the sound with ACTIVE BASS (not cut), otherwise to the first one
  // playing. Called every frame.
  // THE SOUND WITH THE BASS: among the playing decks, the one whose
  // bass is open AND that is heard (volume, crossfader). It is the one
  // carrying the mix: it is the one that must drive the tempo.
  _pickBassDeck(excl) {
    let best = null;
    let bestScore = -1;
    this.decks.forEach((d, j) => {
      if (j === excl || !d.playing || !d.bpm) return;
      const side = this.xfSides[j] === 'A'
        ? (this.crossfader <= 0.5 ? 1 : (1 - this.crossfader) * 2)
        : (this.crossfader >= 0.5 ? 1 : this.crossfader * 2);
      const heard = (d.volume || 0) * side;
      const bass = d.eq.low > -0.9 ? 1 + d.eq.low : 0;
      // open bass first (×10), then the most audible
      const score = (bass > 0 ? 10 + bass : 0) + heard;
      if (score > bestScore) { bestScore = score; best = j; }
    });
    return best;
  }

  _updateAutoMaster() {
    // MASTER CHOSEN BY HAND whose sound has ENDED (or stopped): it goes
    // to the sound with the bass — before, it stayed stuck on a silent deck and
    // nobody held the tempo anymore. Natural end = immediately;
    // manual stop = after 1.2 s (a quick cut does nothing).
    if (this.masterIdx !== null) {
      const mm = this.decks[this.masterIdx];
      const nowS = performance.now() / 1000;
      const anyOther = this.decks.some((d, j) => j !== this.masterIdx && d.playing && d.bpm);
      if (mm.playing || !anyOther) {
        this._mmStopAt = 0;
      } else {
        const ended = mm._endedAt && nowS - mm._endedAt < 2;
        if (!this._mmStopAt) this._mmStopAt = nowS;
        if (ended || nowS - this._mmStopAt >= 1.2) {
          const j = this._pickBassDeck(this.masterIdx);
          if (j != null) {
            this.masterIdx = j;      // the MASTER button lights up on the new one
            this.autoMasterIdx = j;
          }
          this._mmStopAt = 0;
        }
      }
    }
    const am = this.autoMasterIdx != null ? this.decks[this.autoMasterIdx] : null;
    if (am && am.playing) {
      this._amStopAt = 0;
      return; // the master stays master as long as it plays
    }
    // CUT TOLERANCE: a master stopped for a brief moment (quick cut with
    // play/pause) KEEPS its crown for 1.2 s — the master must NEVER
    // switch on a mere cut (the switch re-synced the other decks
    // and "messed up" their BPM). A real end of the sound outlasts the
    // grace period and the handover happens — now without any jump (syncLock).
    if (am) {
      const nowS = performance.now() / 1000;
      // sound ENDED (not a cut): immediate handover, without waiting for the grace period
      const ended = am._endedAt && nowS - am._endedAt < 2;
      if (!ended) {
        if (!this._amStopAt) {
          this._amStopAt = nowS;
          return;
        }
        if (nowS - this._amStopAt < 1.2) return;
      }
      this._amStopAt = 0;
    }
    const playing = [];
    this.decks.forEach((d, j) => {
      if (d.playing && d.bpm) playing.push({ d, j });
    });
    if (!playing.length) {
      this.autoMasterIdx = null;
      return;
    }
    this.autoMasterIdx = this._pickBassDeck(-1);
  }

  getMasterDeck(excludeIdx) {
    if (this.masterIdx !== null && this.masterIdx !== excludeIdx) {
      const m = this.decks[this.masterIdx];
      if (m.bpm) return m;
    }
    if (this.autoMasterIdx != null && this.autoMasterIdx !== excludeIdx) {
      const m = this.decks[this.autoMasterIdx];
      if (m.bpm && m.playing) return m;
    }
    // Fallback: a NON-SYNCED deck takes PRIORITY. Otherwise, with 3 sounds,
    // two slaves could pick each other as reference and
    // chase each other — the BPM never settled.
    return this.decks.find((d, j) => j !== excludeIdx && d.playing && d.bpm && !d.synced)
      || this.decks.find((d, j) => j !== excludeIdx && d.playing && d.bpm)
      || null;
  }

  // Phase of a deck on its grid (0..1 within the current beat).
  // Dynamic grid if available: the phase follows the track's REAL beats.
  _beatPhase(d) {
    if (d.beats) {
      const f = gridIndexFracAt(d, d.currentTime());
      return f - Math.floor(f);
    }
    if (!d.bpm || d.beatOffset == null) return null;
    const b = (d.currentTime() - d.beatOffset) / (60 / d.bpm);
    return b - Math.floor(b);
  }

  // Phase within the BAR (0..1 over 4 beats) — to align the red lines
  _barPhase(d) {
    if (d.beats) {
      const f = (gridIndexFracAt(d, d.currentTime()) - (d.barAnchor || 0)) / 4;
      return f - Math.floor(f);
    }
    if (!d.bpm || d.beatOffset == null) return null;
    const b = (d.currentTime() - d.beatOffset) / (4 * 60 / d.bpm);
    return b - Math.floor(b);
  }

  // Local period (duration of the current beat) in file seconds
  _period(d) {
    return gridPeriodAt(d, d.currentTime()) || (d.bpm ? 60 / d.bpm : null);
  }

  // True beat sync: sets the tempo EXACTLY to the master's, then aligns the
  // phase (the beats fall together — the bars have the same size AND
  // scroll at the same time). Returns true on success.
  // AVERAGE beat period around the current position (16 beats of
  // the dynamic grid): far more accurate than the rounded global BPM, and
  // insensitive to the noise of a single beat (± 2 ms of attack).
  _localPeriod(d) {
    if (d.beats && d.beats.length > 4) {
      const f = gridIndexFracAt(d, d.currentTime());
      const n = d.beats.length - 1;
      const a = Math.max(0, Math.min(n - 1, Math.floor(f) - 8));
      const b = Math.max(a + 1, Math.min(n, Math.floor(f) + 8));
      const p = (d.beats[b] - d.beats[a]) / (b - a);
      if (p > 0.15 && p < 2) return p;
    }
    return d.bpm ? 60 / d.bpm : null;
  }

  // Tempo ratio that gives deck d EXACTLY the beat speed
  // of master m (with the master's servo correction removed).
  _syncRatio(d, m) {
    const mBase = m.tempo / (1 + (m._pllCorr || 0));
    const pd = this._localPeriod(d);
    const pm = this._localPeriod(m);
    let ratio = pd && pm ? (mBase * pd) / pm : (m.bpm * mBase) / d.bpm;
    // A synced sound ALWAYS targets the master's effective BPM — never its
    // double (David: "a 3rd sound I sync goes to 2× the BPM!").
    // The octave only jumps if the tempo would go outside the engine's physical
    // limits [0.5; 1.6].
    while (ratio > 1.6) ratio /= 2;
    while (ratio < 0.5) ratio *= 2;
    return ratio;
  }

  sync(i) {
    const d = this.decks[i];
    if (!d.bpm) return false;
    const m = this.getMasterDeck(i);
    if (!m || !m.bpm) return false;
    const ratio = this._syncRatio(d, m);
    d.setTempo(ratio);
    d._syncBase = d.tempo; // reference for the continuous lock
    d._syncRef = d.tempo;  // safety anchor for ratio LEARNING
    d._phaseFree = false;  // SYNC requested = phase re-locking resumes

    // BAR alignment: shifts the deck so that its red lines
    // (bar starts) coincide with the master's. On a dynamic
    // grid, the target is computed as a BEAT INDEX then converted back
    // to a position: exact even if the bar to cross doesn't have perfectly
    // regular beats.
    const pm = this._barPhase(m);
    const pd = this._barPhase(d);
    if (pm != null && pd != null) {
      let err = pm - pd;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      const pos = d.currentTime();
      let target = null;
      if (d.beats) {
        const f = gridIndexFracAt(d, pos);
        if (f != null) target = gridTimeAtIndex(d, f + err * 4);
      }
      if (target == null) target = pos + err * 4 * (this._period(d) || 60 / d.bpm);
      d.seek(target);
    }
    d.synced = true;
    d._syncPhaseOff = 0; // SYNC = back to grid-on-grid alignment
    d._ratioCal = false; // calibration on the next frame…
    d._ratioMeas = null;
    d._ratioTries = 0;
    d._errFilt = 0;
    d._pllCorr = 0;
    d._lastWant = null;
    // …straight to the FINE stage (8 s) when the ratio comes from the dynamic
    // grid: it is already accurate to ~0.05 %, a 1 s measurement (±0.2 %)
    // would only degrade it
    d._ratioPasses = d.beats && m.beats ? 1 : 0;
    return true;
  }

  // Re-anchors the continuous lock on the CURRENT alignment: after a
  // manual jog offset, the automatic alignment keeps the alignment chosen
  // by ear instead of undoing it.
  reanchorSync(i) {
    const d = this.decks[i];
    // the MASTER is the reference: it is never anchored against a slave
    const mi = this.masterIdx !== null ? this.masterIdx : this.autoMasterIdx;
    if (i === mi) return;
    if (!d.synced || !d.playing) return;
    const m = this.getMasterDeck(i);
    if (!m || !m.playing) return;
    const pm = this._beatPhase(m);
    const pd = this._beatPhase(d);
    if (pm == null || pd == null) return;
    let err = pm - pd;
    if (err > 0.5) err -= 1;
    if (err < -0.5) err += 1;
    // VISUAL MAGNET: aligning by ear always leaves a micro-residue
    // (± a few ms) — inaudible, but VISIBLE when zoomed in ("supposed to be
    // aligned but it isn't"). Below 0.03 beat (~12 ms),
    // the intent is CLEARLY "aligned": aim for EXACT alignment.
    // A larger deliberate offset is respected as is.
    if (Math.abs(err) < 0.03) err = 0;
    d._syncPhaseOff = err;
    d._errFilt = 0;
    // A calibration measurement in progress is CORRUPTED by the manual gesture
    // (the movement would be taken for a ratio drift): discard it —
    // the calibration ALREADY acquired (_ratioCal) is kept
    d._ratioMeas = null;
    // MANUAL PLACEMENT = GOSPEL: NO phase chasing at ALL
    // afterwards ("the tracks must not move anymore once I move them").
    // The deck keeps the right TEMPO, that's all. SYNC or a new track
    // re-enable the re-locking.
    d._phaseFree = true;
  }

  // Re-aligns deck i after a manual scratch:
  // - if ANOTHER deck is PLAYING, align the phase to it
  //   (beatmatching);
  // - otherwise, lock to the track's OWN grid (nearest segment or
  //   micro-segment): placed on a red line, it stays there exactly.
  // DISCREET MAGNET (0.06 beat ≈ 25 ms): it only "finishes"
  // releases that are already almost aligned — a deliberately offset placement or
  // a ROUGH move within the track stays EXACTLY where the DJ put it
  // ("we'd like to be able to move things roughly and make quick
  // moves" — the old 0.2 beat swallowed placements back onto the lines)
  snapToRef(i, maxErr = 0.06) {
    const d = this.decks[i];
    if (!d.buffer || !d.bpm || (d.beatOffset == null && !d.beats)) return false;
    const hasGrid = (x) => x && x.buffer && x.bpm && (x.beatOffset != null || x.beats);
    let m = null;
    if (this.masterIdx !== null && this.masterIdx !== i) {
      const cand = this.decks[this.masterIdx];
      if (hasGrid(cand) && cand.playing) m = cand;
    }
    if (!m) m = this.decks.find((x, j) => j !== i && x.playing && hasGrid(x)) || null;

    // Re-alignment ONLY if another deck is playing (beatmatching), and only
    // as a MAGNET: if released almost aligned (< maxErr beats), finish
    // the line-on-line alignment; if released clearly elsewhere,
    // it is a deliberate move — touch nothing.
    if (!m) return false;
    const pm = this._beatPhase(m);
    const pd = this._beatPhase(d);
    if (pm == null || pd == null) return false;
    let err = pm - pd;
    if (err > 0.5) err -= 1;
    if (err < -0.5) err += 1;
    if (Math.abs(err) > maxErr) return false;
    d.seek(d.currentTime() + err * (this._period(d) || 60 / d.bpm));
    return true;
  }

  _followMaster(i) {
    if (this._following) return; // (the followers themselves don't trigger anything)
    const mi = this.masterIdx !== null ? this.masterIdx : this.autoMasterIdx;
    if (i !== mi) return;
    const m = this.decks[i];
    if (!m.bpm) return;
    this._following = true;
    try {
      const mBase = m.tempo / (1 + (m._pllCorr || 0));
      this.decks.forEach((d, j) => {
        if (j === i || !d.synced || !d.playing || !d.bpm || !d._syncBase || !d._lastWant) return;
        if (this.getMasterDeck(j) !== m) return;
        let want = (m.bpm * mBase) / d.bpm;
        while (want > 1.6) want /= 2;
        while (want < 0.5) want *= 2;
        if (Math.abs(want / d._lastWant - 1) <= 1e-6) return;
        const f = want / d._lastWant;
        d._syncBase *= f;
        d._syncRef = (d._syncRef || d._syncBase / f) * f;
        d._lastWant = want;
        d._syncWant = want;
        d._ratioMeas = null;
        d.setTempo(d._syncBase * (1 + (d._pllCorr || 0)));
      });
    } finally {
      this._following = false;
    }
  }

  // Deck whose tempo an FX unit follows: the first assigned deck that
  // is playing (otherwise the master)
  fxRefDeck(uIdx) {
    const a = this.fxAssign[uIdx];
    if (a) {
      for (let d = 0; d < 4; d++) {
        if (a[d] && this.decks[d].playing && this.decks[d].bpm) return this.decks[d];
      }
    }
    return this.getMasterDeck(-1);
  }

  // AUDIO time of the next multiple of "periodBeats" on the deck's
  // grid (locked to the bar when the period is at least one beat)
  nextBoundaryAt(d, periodBeats) {
    if (!d || !d.playing || !(periodBeats > 0)) return null;
    const pos = d.currentTime();
    let f;
    let anchor = 0;
    if (d.beats) {
      f = gridIndexFracAt(d, pos);
      anchor = d.barAnchor || 0;
    } else if (d.bpm && d.beatOffset != null) {
      f = ((pos - d.beatOffset) * d.bpm) / 60;
    } else {
      return null;
    }
    if (f == null) return null;
    // alignment grid: the period if it is shorter than a beat, otherwise the
    // bar (a 16-beat modulation still restarts on a bar)
    const G = periodBeats < 1 ? periodBeats : Math.min(periodBeats, 4);
    const k = Math.ceil((f - anchor) / G + 1e-6) * G + anchor;
    const tFile = d.beats ? gridTimeAtIndex(d, k) : d.beatOffset + (k * 60) / d.bpm;
    if (tFile == null) return null;
    const at = this.ctx.currentTime + (tFile - pos) / (d.tempo || 1);
    return at > this.ctx.currentTime ? at : null;
  }

  // Every frame: FX modulations re-aligned to the beats, and ROLL
  // (FX panel or pad) driven on the decks
  fxTick() {
    const units = [];
    this.fx.forEach((u, uIdx) => units.push([u, () => this.fxRefDeck(uIdx)]));
    this.padFx.forEach((u, i) => { if (u) units.push([u, () => this.decks[i]]); });
    if (this.masterFx) units.push([this.masterFx, () => this.getMasterDeck(-1)]);
    for (const [u, refOf] of units) {
      if (!u.enabled) { u._alignKey = null; continue; }
      const P = u.modPeriodBeats();
      if (!P) continue;
      const key = `${u.type}|${u.beatsMult}`;
      const ref = refOf();
      if (!ref || !ref.playing) continue;
      const drift = u._alignedDur && Math.abs(u.beatDur / u._alignedDur - 1) > 0.004;
      if (u._alignKey === key && u._alignRef === ref && !drift) continue;
      const at = this.nextBoundaryAt(ref, P);
      if (at == null || at - this.ctx.currentTime > 4) continue;
      if (u.alignTo(at)) {
        u._alignKey = key;
        u._alignRef = ref;
      }
    }
    // ROLL: the held pad has priority, otherwise a panel ROLL unit
    // assigned to the deck (or the master FX in ROLL)
    this.decks.forEach((d, i) => {
      let want = d._padRoll || null;
      if (!want) {
        this.fx.forEach((u, uIdx) => {
          if (!want && u.enabled && u.type === 'roll' && this.fxAssign[uIdx][i] && u.level > 0.02) {
            want = { beats: u.beatsMult, mix: u.level };
          }
        });
      }
      const mf = this.masterFx;
      if (!want && mf && mf.enabled && mf.type === 'roll' && mf.level > 0.02) {
        want = { beats: mf.beatsMult, mix: mf.level };
      }
      if (want && d.playing) {
        if (!d._roll || Math.abs(d._roll.beats - want.beats) > 1e-6) d.startRoll(want.beats, want.mix);
        else d.setRollMix(want.mix);
      } else if (d._roll) {
        d.stopRoll();
      }
    });
  }

  // Continuous lock (to be called every frame): as long as a deck is
  // synchronized, micro-drifts are corrected so that its beats stay
  // glued to the master's, like in real DJ software.
  // jogHold: during a manual jog offset, the lock is suspended
  // GLOBALLY — otherwise the other decks CHASE the deck being shifted
  // (the infamous "it fights with the alignment") and the gesture becomes imprecise.
  syncLock() {
    // PER-DECK FX CALIBRATION (every frame, ~zero cost): the dry of
    // EACH deck goes down according to the strongest FX processing IT — panel
    // units assigned to this deck, and a held PAD FX (which can request
    // a total cut: "it's the sound being manipulated", not an addition).
    // An FX on deck 2 never touches deck 1.
    this.fxTick();
    this.decks.forEach((d, i) => {
      if (!d.dryOut) return;
      // Share of the dry removed according to the NATURE of each effect processing this
      // deck: a gate/filter/crush at full REPLACES the sound (otherwise
      // the intact dry masked the effect — "the intensity does nothing");
      // an echo/reverb adds to the sound
      let cut = 0;
      this.fx.forEach((u, uIdx) => {
        if (u.enabled && this.fxAssign[uIdx] && this.fxAssign[uIdx][i]) {
          const lv = Math.min(1, u.wet.gain.value || 0);
          const c = fxDryCut(u.type) * lv;
          if (c > cut) cut = c;
        }
      });
      let dry = 1 - cut;
      const p = this.padFx && this.padFx[i];
      if (p && p.enabled && d._padDryHold != null) dry = Math.min(dry, d._padDryHold);
      if (Math.abs((d._dryCur ?? 1) - dry) > 0.01) {
        d._dryCur = dry;
        d.dryOut.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.02);
      }
    });
    // MASTER FX: it alone doses the dry of the WHOLE MIX
    const mWet = this.masterFx && this.masterFx.enabled
      ? Math.min(1, this.masterFx.wet.gain.value || 0) : 0;
    const dryT = 1 - (this.masterFx ? fxDryCut(this.masterFx.type) : 0.45) * mWet;
    if (Math.abs((this._dryTarget ?? 1) - dryT) > 0.01) {
      this._dryTarget = dryT;
      this.dryComp.gain.setTargetAtTime(dryT, this.ctx.currentTime, 0.05);
    }
    this._updateAutoMaster();
    if (this.jogHold) return;
    const mi = this.masterIdx !== null ? this.masterIdx : this.autoMasterIdx;
    // MASTER CHANGE = TRANSITION WITHOUT ANY JUMP. A deck's old base
    // (_syncBase) may date from an OLD master: re-applying it
    // at the moment of the switch changed the BPM abruptly ("a cut changed
    // the master and messed up the BPM of one of the sounds"). Here each
    // synced deck restarts from its CURRENT speed — nothing moves to the ear — and
    // recalibrates in a flash against the NEW master.
    if (mi !== this._lastMi) {
      this._lastMi = mi;
      const mNew = mi != null ? this.decks[mi] : null;
      // Effective BPM of the new master, servo correction removed
      const mEff = mNew && mNew.bpm
        ? mNew.bpm * (mNew.tempo / (1 + (mNew._pllCorr || 0))) : null;
      this.decks.forEach((d, j) => {
        if (!d._syncBase) return;
        if (j !== mi && d.synced && d.bpm && mEff) {
          // A SYNCED deck targets the BPM of the NEW master: that is the CONTRACT
          // of the SYNC button. BUT if it already beats at the same speed (normal case:
          // all locked to the old master), we keep EXACTLY its speed
          // — the handover must not change the BPM you hear. Ratio
          // measured on the LOCAL grids (more accurate than the global BPMs).
          const want = this._syncRatio(d, mNew);
          const cur = d.tempo / (1 + (d._pllCorr || 0));
          d._syncBase = Math.abs(cur / want - 1) < 0.004 ? cur : want;
        } else {
          // the deck that BECOMES master (or a non-synced one) NEVER jumps:
          // its CURRENT speed becomes its base, the correction is removed
          d._syncBase = d.tempo / (1 + (d._pllCorr || 0));
        }
        d._syncRef = d._syncBase;
        d._pllCorr = 0;
        d.setTempo(d._syncBase);
        d._ratioCal = false;
        d._ratioMeas = null;
        d._syncPhaseOff = null; // re-anchored on the PRESENT alignment below
        d._errFilt = 0;
        d._lastWant = null; // the target has just been re-aimed: no double scaling
      });
    }
    // AUTO master briefly stopped (cut, within _updateAutoMaster's grace period):
    // FREEZE everything — nobody chases anybody during the gesture; on
    // resume, the observed alignment is adopted as is. (never for a
    // MANUAL master: paused for a long time, it would freeze everything forever)
    if (this.masterIdx === null && mi != null && this.decks[mi]
        && !this.decks[mi].playing) return;
    this.decks.forEach((d, i) => {
      if (i === mi) {
        // The MASTER is the REFERENCE: it is NEVER re-aligned — even if it
        // is marked sync. Otherwise it gets chased by its own
        // slaves (getMasterDeck excludes it → it targeted a slave) and the
        // offset set with the jog "moved again" on its own after the gesture.
        // Only the lock's micro-correction is removed, and ONLY if the
        // deck is still in SYNC: a deck that BECOMES master must NEVER
        // jump in tempo — its _syncBase may be stale (tempo slider,
        // ÷2/×2 grid, track change) and re-applying it broke the
        // mix ("the remaining sound's BPM changes like crazy / goes ×2")
        if (d._pllCorr) {
          d._pllCorr = 0;
          if (d.synced && d._syncBase) d.setTempo(d._syncBase);
        }
        return;
      }
      // SYNC deck STOPPED (sound just loaded, waiting): it ALREADY
      // takes the master's BPM — correct display, and no more tempo at 0 %
      // that the physical fader "recognized"; the phase locks on PLAY
      if (d.synced && !d.playing && d.bpm && d.buffer) {
        const m0 = this.getMasterDeck(i);
        if (m0 && m0.playing && m0.bpm) {
          const mB = m0.tempo / (1 + (m0._pllCorr || 0));
          let w = (m0.bpm * mB) / d.bpm;
          while (w > 1.6) w /= 2;
          while (w < 0.5) w *= 2;
          if (Math.abs(d.tempo / w - 1) > 1e-6) d.setTempo(w);
        }
        return;
      }
      if (!d.synced || !d.playing) return;
      // (the old "_phaseFree" freeze created a cumulative MICRO-OFFSET:
      // detected BPMs are never perfect, so without holding, the gap
      // grows over the minutes — "not negligible over time". The
      // servo below holds THE OFFSET CHOSEN BY THE DJ, with
      // homeopathic, invisible corrections.)
      const m = this.getMasterDeck(i);
      if (!m || !m.playing) return;
      // ABSOLUTE "SAME BPM" GUARANTEE: SYNC on = the deck ALWAYS targets
      // the master's BPM. MISSING base (BPM corrected by hand, grid
      // ÷2/×2 — the purge left SYNC on… doing NOTHING anymore:
      // "the BPM locks but not to the same BPM") or ABERRANT base
      // (> 3 % from the target): the sync REPAIRS itself, immediate
      // re-aim then flash recalibration.
      if (d.bpm && m.bpm) {
        // The master's BPM WITHOUT its servo micro-correction: otherwise the
        // target itself trembled, and the computation below never
        // managed to settle (BPM constantly moving with 3 sounds).
        const mBase = m.tempo / (1 + (m._pllCorr || 0));
        let want = (m.bpm * mBase) / d.bpm;
        while (want > 1.6) want /= 2;
        while (want < 0.5) want *= 2;
        // THE MASTER CHANGED TEMPO (fader, ♩ master BPM, controller…): the
        // slaves follow INSTANTLY, in the same proportion — their
        // calibration (the small gap specific to the pair of tracks) is
        // kept. Before, the base stayed frozen as long as the gap didn't
        // exceed 6 %: you moved the master's tempo and the other
        // sounds drifted off, you had to re-SYNC.
        // (only against the REAL master: two slaves using each other
        // as reference would send each other into a runaway)
        if (d._syncBase && d._lastWant && this.decks.indexOf(m) === mi
            && Math.abs(want / d._lastWant - 1) > 1e-6) {
          const f = want / d._lastWant;
          d._syncBase *= f;
          d._syncRef = (d._syncRef || d._syncBase / f) * f;
          d.setTempo(d._syncBase * (1 + (d._pllCorr || 0)));
          // the calibration measurement in progress saw two tempos: discard it
          d._ratioMeas = null;
        }
        d._lastWant = want;
        d._syncWant = want;
        // REPAIR threshold at 6 %, well above the ±2 % that the
        // calibration allows itself: the two mechanisms stepped on each other
        // (the calibration pushed up to 3 %, the repair punished at
        // 3 % → reset → recalibration → endless loop).
        if (!d._syncBase || Math.abs(d._syncBase / want - 1) > 0.06) {
          d._syncBase = want;
          d._syncRef = want;
          d._pllCorr = 0;
          d.setTempo(want);
          d._ratioCal = false;
          d._ratioMeas = null;
          d._ratioPasses = 0;
          d._ratioTries = 0;
          d._syncPhaseOff = null;
          d._errFilt = 0;
          return;
        }
      }
      if (!d._syncBase) return; // no BPM detected: nothing to lock
      const pm = this._beatPhase(m);
      const pd = this._beatPhase(d);
      if (pm == null || pd == null) return;
      // After a master change, the PRESENT alignment becomes the
      // target: an offset born from a handover is never "caught up"
      // (same visual magnet as for re-anchoring: almost aligned = EXACTLY aligned)
      if (d._syncPhaseOff == null) {
        let off = pm - pd;
        off -= Math.round(off);
        if (Math.abs(off) < 0.03) off = 0;
        d._syncPhaseOff = off;
      }
      // The target is not necessarily phase 0: after a manual jog
      // offset, _syncPhaseOff stores the alignment wanted by the DJ
      let err = pm - pd - (d._syncPhaseOff || 0);
      err -= Math.round(err);
      // Red lines clearly ELSEWHERE (deliberate offset, non-quantized
      // jump, grid drift…): ADOPT that alignment instead of
      // chasing it for seconds — the audible "continuous recalibration"
      // is unbearable. The lock ONLY corrects
      // micro-drifts; the DJ's placement is respected as is.
      if (Math.abs(err) > 0.08) {
        d._syncPhaseOff = pm - pd;
        d._ratioMeas = null; // the target changed: calibration measurement to redo
        // such a drift DURING calibration = starting ratio too
        // far off for the fine stage: go back through the coarse measurement (±1 %)
        if (!d._ratioCal) d._ratioPasses = 0;
        d._errFilt = 0;
        if (d._pllCorr) {
          d._pllCorr = 0;
          d.setTempo(d._syncBase);
        }
        return;
      }
      // FLASH CALIBRATION (one 0.35 s measurement, ONE SINGLE correction):
      // detected BPMs are never perfect, so the ratio computed at
      // SYNC is slightly off. The old servo "learned" the error
      // continuously → the displayed BPM took seconds to calm down and
      // "breathed" (142.0↔142.1 instead of 141.6: the two were
      // fighting). Here: tempo FROZEN, we measure the SLOPE of the phase
      // drift, and correct the ratio IN ONE GO — locked cleanly, the
      // tempo is then CONSTANT, equal to the master's BPM.
      // What the servo has added since the previous frame (file
      // seconds): the calibration accounts for it — so the servo no longer
      // needs to stay quiet while it measures. (Before, it was CUT OFF
      // during the 8 to 24 s of calibration, and every BPM change
      // restarted the measurement: when raising the BPM right after a SYNC,
      // nothing held the phase anymore — "some sounds drift out".)
      const nowC = this.ctx.currentTime;
      if (d._ratioMeas && d._servoAt != null) {
        d._ratioMeas.servoFile += (d._pllCorr || 0) * d._syncBase * Math.min(0.1, Math.max(0, nowC - d._servoAt));
      }
      d._servoAt = nowC;
      if (!d._ratioCal) {
        // AUDIO clock (the one that advances the positions): measuring the
        // slope with the system clock mixed two clocks that drift apart.
        // One of the two sounds is still waiting for its scheduled start: its
        // position is only an extrapolation, nothing is measured on that.
        if (nowC >= d.startCtx && nowC >= m.startCtx) {
          const pass = d._ratioPasses || 0;
          // TWO STAGES. The precision of a slope measurement is
          // (phase noise) / (duration × beats per second):
          //   1 s  -> ±0.13 BPM   (what sounded "almost locked")
          //   8 s  -> ±0.015 BPM  (exact, on the scale of a whole track)
          const duration = pass === 0 ? 1 : 8;
          const ms = d._ratioMeas;
          if (!ms || nowC - ms.t > duration + 2) {
            // Safeguard: on a really wrong grid, the measurement would be
            // constantly invalidated — don't insist forever
            d._ratioTries = (d._ratioTries || 0) + 1;
            if (d._ratioTries > 12) {
              d._ratioCal = true;
            } else {
              d._ratioMeas = { t: nowC, e: err, dp: d.currentTime(), mp: m.currentTime(), servoFile: 0 };
            }
          } else if (nowC - ms.t >= duration) {
            const dtW = nowC - ms.t;
            // VALIDITY: a beat jump / seek / loop DURING the measurement
            // corrupts the slope — measurement DISCARDED and redone (moving around
            // NEVER touches the BPM). The expected advance includes what the
            // servo added.
            const dOk = Math.abs((d.currentTime() - ms.dp) - (dtW * d._syncBase + ms.servoFile)) < 0.05 * (d.tempo || 1);
            const mOk = Math.abs((m.currentTime() - ms.mp) / (m.tempo || 1) - dtW) < 0.05;
            if (!dOk || !mOk) {
              d._ratioMeas = null;
            } else {
              let de = err - ms.e;
              de -= Math.round(de);
              const per = this._period(d) || 60 / d.bpm;
              // drift due to the RATIO alone = observed drift + what the
              // servo caught up during the measurement
              const drift = de + ms.servoFile / per;
              const fd = (d.bpm * d.tempo) / 60; // beats per second
              const kRaw = 1 + drift / (dtW * fd);
              // Stage 1: large correction allowed; stage 2: the last thousandth
              const lim0 = pass === 0 ? 0.01 : 0.001;
              const k = Math.max(1 - lim0, Math.min(1 + lim0, kRaw));
              // ABSOLUTE CAP: ±2 % of the target ratio (beyond that, the grid is wrong)
              const target = d._syncWant || d._syncBase;
              d._syncBase = Math.max(target * 0.98, Math.min(target * 1.02, d._syncBase * k));
              d._syncRef = d._syncBase;
              // Done when the correction becomes NEGLIGIBLE (0.02 %),
              // or after 4 passes — never overdo it
              d._ratioPasses = pass + 1;
              d._ratioCal = Math.abs(k - 1) < 0.0002 || d._ratioPasses >= 4;
              d._ratioMeas = null;
            }
          }
        }
      }
      // SMOOTHED ERROR: the audio clock advances in blocks (~3 ms) — this noise
      // made the correction "breathe" both ways, VISIBLE on
      // the zoomed waveforms (inaudible). Low-pass + widened dead zone:
      // the servo only reacts to real drifts, the picture stays still.
      d._errFilt = (d._errFilt || 0) * 0.85 + err * 0.15;
      const eF = d._errFilt;
      if (Math.abs(eF) < 0.0015) {
        // Glued to the wanted offset (< 0.6 ms): total rest
        if (d._pllCorr) d._pllCorr = 0;
        if (Math.abs(d.tempo - d._syncBase) > 1e-9) d.setTempo(d._syncBase);
        return;
      }
      // HOLDING SERVO: corrections capped at ±0.2 %, inaudible.
      // (the "±0.15 %" episode: a cap SMALLER than the possible residue
      // of the calibration → servo saturated forever, CONTINUOUS sliding on
      // screen — "it drifts every moment, you made it worse". The
      // cap must always exceed the worst ratio residue.)
      // Deck in KEYLOCK / KEY (sound through the transposer): it applies
      // each tempo change 55 ms AFTER the others (engine
      // latency) — when the BPM goes up, it falls slightly behind. Its
      // tempo does NOT affect its pitch (keylock): it can be corrected
      // ~10× harder, it's inaudible.
      const strong = d.procLat > 0;
      const lim = strong ? 0.015 : 0.002;
      const corr = Math.max(-lim, Math.min(lim, eF * (strong ? 1.0 : 0.08)));
      // THE BASE IS FROZEN — NO MORE ABSORPTION AT ALL. That was THE cause of the
      // "BPM that changes continuously": the servo rewrote _syncBase on
      // every frame to absorb its own correction. After calibration,
      // _syncBase IS the exact ratio; the residue is held by a tiny
      // correction that the display already removes (see _pllCorr in
      // drawDeckWheel). DO NOT REINTRODUCE absorption here.
      d._pllCorr = corr;
      d.setTempo(d._syncBase * (1 + corr));
    });
  }
}
