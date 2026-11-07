// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Sync: master election, SYNC (tempo + bars), reanchor, discreet magnet,
// continuous phase lock with ratio calibration, follow-master
// (DESIGN §6.3). Ported from the OpenMix app engine (AudioEngine); mixed into
// Engine (see engine.js), so `this` is the engine as in OpenMix.
//
// web-engine: the servo drives the decks through deck._setRate() (the
// public deck.setTempo() unsyncs a follower), grace periods run on the
// AUDIO clock, and everything is sized from the number of decks.

import { gridIndexFracAt, gridTimeAtIndex, gridPeriodAt } from './grid.js';
import { isNum } from './util.js';

/**
 * Mixes the sync logic into an engine base class.
 * @param {Function} Base
 * @returns {Function}
 */
export const withSync = (Base) => class SyncEngine extends Base {
  // AUTOMATIC MASTER rule (by design): the FIRST sound started becomes
  // the master; it STAYS master as long as it plays; when it stops, the master
  // goes to the sound with ACTIVE BASS (not cut), otherwise to the first one
  // playing. Called on every tick.
  // THE SOUND WITH THE BASS: among the playing decks, the one whose
  // bass is open AND that is heard (volume, crossfader). It is the one
  // carrying the mix: it is the one that must drive the tempo.
  _pickBassDeck(excl) {
    let best = null;
    let bestScore = -1;
    this.decks.forEach((d, j) => {
      if (j === excl || !d.playing || !d.bpm) return;
      // web-engine: a 'thru' deck ignores the crossfader (side gain 1)
      const side = this._sideGain(this._xfSides[j]);
      const heard = (d.volume || 0) * side;
      const bass = d.eq.low > -0.9 ? 1 + d.eq.low : 0;
      // open bass first (×10), then the most audible
      const score = (bass > 0 ? 10 + bass : 0) + heard;
      if (score > bestScore) { bestScore = score; best = j; }
    });
    return best;
  }

  _updateAutoMaster() {
    // web-engine: AUDIO clock (was the system clock): deterministic offline,
    // and the grace periods freeze with a suspended context. (The stop
    // stamps use null as 'unset': 0 is a valid audio time.)
    const nowS = this.ctx.currentTime;
    // MASTER CHOSEN BY HAND whose sound has ENDED (or stopped): it goes
    // to the sound with the bass — before, it stayed stuck on a silent deck and
    // nobody held the tempo anymore. Natural end = immediately;
    // manual stop = after 1.2 s (a quick cut does nothing).
    if (this.masterIdx !== null) {
      const mm = this.decks[this.masterIdx];
      const anyOther = this.decks.some((d, j) => j !== this.masterIdx && d.playing && d.bpm);
      if (mm.playing || !anyOther) {
        this._mmStopAt = null;
      } else {
        const ended = mm._endedAt != null && nowS - mm._endedAt < 2;
        if (this._mmStopAt == null) this._mmStopAt = nowS;
        if (ended || nowS - this._mmStopAt >= 1.2) {
          const j = this._pickBassDeck(this.masterIdx);
          if (j != null) {
            this.masterIdx = j;      // the MASTER button lights up on the new one
            this.autoMasterIdx = j;
          }
          this._mmStopAt = null;
        }
      }
    }
    const am = this.autoMasterIdx != null ? this.decks[this.autoMasterIdx] : null;
    if (am && am.playing) {
      this._amStopAt = null;
      return; // the master stays master as long as it plays
    }
    // CUT TOLERANCE: a master stopped for a brief moment (quick cut with
    // play/pause) KEEPS its crown for 1.2 s — the master must NEVER
    // switch on a mere cut (the switch re-synced the other decks
    // and "messed up" their BPM). A real end of the sound outlasts the
    // grace period and the handover happens — now without any jump (phase lock).
    if (am) {
      // sound ENDED (not a cut): immediate handover, without waiting for the grace period
      const ended = am._endedAt != null && nowS - am._endedAt < 2;
      if (!ended) {
        if (this._amStopAt == null) {
          this._amStopAt = nowS;
          return;
        }
        if (nowS - this._amStopAt < 1.2) return;
      }
      this._amStopAt = null;
    }
    if (!this.decks.some((d) => d.playing && d.bpm)) {
      this.autoMasterIdx = null;
      return;
    }
    this.autoMasterIdx = this._pickBassDeck(-1);
  }

  _getMasterDeck(excludeIdx) {
    if (this.masterIdx !== null && this.masterIdx !== excludeIdx) {
      const m = this.decks[this.masterIdx];
      if (m.bpm) return m;
    }
    if (this.autoMasterIdx != null && this.autoMasterIdx !== excludeIdx) {
      const m = this.decks[this.autoMasterIdx];
      if (m.bpm && m.playing) return m;
    }
    // Fallback: a NON-SYNCED deck takes PRIORITY. Otherwise, with 3 sounds,
    // two followers could pick each other as reference and
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
    // double (user feedback: "a 3rd sound I sync goes to 2× the BPM!").
    // The octave only jumps if the tempo would go outside the engine's physical
    // limits [0.5; 1.6].
    while (ratio > 1.6) ratio /= 2;
    while (ratio < 0.5) ratio *= 2;
    return ratio;
  }

  // True beat sync: sets the tempo EXACTLY to the master's, then aligns the
  // phase (the beats fall together — the bars have the same size AND
  // scroll at the same time). Returns true on success.
  _sync(i) {
    const d = this.decks[i];
    if (!d.bpm) return false;
    const m = this._getMasterDeck(i);
    if (!m || !m.bpm) return false;
    const ratio = this._syncRatio(d, m);
    d._setRate(ratio);
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
    d._setSynced(true);
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

  /**
   * Re-anchors the continuous lock on the CURRENT alignment of the synced
   * decks (all of them when `index` is omitted): after a manual move, the
   * automatic alignment keeps the alignment chosen by ear instead of undoing it.
   * @param {number} [index]
   */
  reanchorSync(index) {
    if (index === undefined) {
      for (let k = 0; k < this.decks.length; k++) this._reanchor(k);
      return;
    }
    this._checkDeck(index);
    this._reanchor(index);
  }

  // Re-anchors the continuous lock on the CURRENT alignment: after a
  // manual jog offset, the automatic alignment keeps the alignment chosen
  // by ear instead of undoing it.
  _reanchor(i) {
    const d = this.decks[i];
    // the MASTER is the reference: it is never anchored against a follower
    const mi = this.masterIdx !== null ? this.masterIdx : this.autoMasterIdx;
    if (i === mi) return;
    if (!d.synced || !d.playing) return;
    const m = this._getMasterDeck(i);
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
  //   (web-engine note: the code below, as in OpenMix, only acts when
  //   another deck plays — "Re-alignment ONLY if another deck is playing")
  // DISCREET MAGNET (0.06 beat ≈ 25 ms): it only "finishes"
  // releases that are already almost aligned — a deliberately offset placement or
  // a ROUGH move within the track stays EXACTLY where the DJ put it
  // ("we'd like to be able to move things roughly and make quick
  // moves" — the old 0.2 beat swallowed placements back onto the lines)
  _snapToRef(i, maxErr = 0.06) {
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

  // The master changes tempo (fader, + / −, controller…): the synced decks
  // follow in the SAME call, not on the next tick — otherwise each step
  // left a small offset ("not everything happens at the same time")
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
        if (this._getMasterDeck(j) !== m) return;
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
        if (d._nudge) {
          // web-engine: a follower being nudged keeps its bend on the new base
          d._nudge.base *= f;
          d._setRate(d._nudge.base * (1 + d._nudge.amount), false);
        } else {
          d._setRate(d._syncBase * (1 + (d._pllCorr || 0)));
        }
      });
    } finally {
      this._following = false;
    }
  }

  /**
   * Master deck tempo; the synced followers follow in the same call.
   * @param {number} ratio
   * @returns {boolean} false without a master deck
   */
  setMasterTempo(ratio) {
    if (!isNum(ratio)) return false;
    const m = this.masterDeck;
    if (!m) return false;
    m.setTempo(ratio);
    return true;
  }

  /**
   * Master tempo as an effective BPM (♩ MASTER BPM): the master deck moves and
   * ALL the synced decks follow instantly.
   * @param {number} bpm
   * @returns {boolean} false without a master BPM
   */
  setMasterBpm(bpm) {
    if (!isNum(bpm) || !(bpm > 0) || !Number.isFinite(bpm)) return false;
    const m = this.masterDeck;
    if (!m || !m.bpm) return false;
    m.setTempo(bpm / m.bpm);
    return true;
  }

  /**
   * Suspends (true) or resumes (false) the phase correction globally. On
   * release, the synced decks adopt their current alignment (reanchorSync).
   * @param {boolean} on
   */
  setSyncHold(on) {
    const v = !!on;
    if (v === this._holdManual) return;
    const before = this.syncHold;
    this._holdManual = v;
    if (before && !this.syncHold) this.reanchorSync();
  }

  // Nudge holds (jog bend): during a manual jog offset, the lock is suspended
  // GLOBALLY — otherwise the other decks CHASE the deck being shifted
  // (the infamous "it fights with the alignment") and the gesture becomes imprecise.
  _holdAdd(i) {
    this._holdSet.add(i);
  }

  _holdRemove(i) {
    if (!this._holdSet.delete(i)) return;
    // ALL the synced decks adopt the new alignment: the automatic
    // alignment keeps exactly what the DJ just set
    if (this._holdSet.size === 0) this.reanchorSync();
  }

  // Continuous lock (on every tick): as long as a deck is
  // synchronized, micro-drifts are corrected so that its beats stay
  // glued to the master's, like in real DJ software.
  // (Runs after the master election, and not while syncHold.)
  _phaseLock() {
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
        d._setRate(d._syncBase);
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
      try {
        this._lockDeck(d, i, mi);
      } catch (e) {
        // web-engine: a failure on one deck never stops the lock of the others
        this._reportError(e);
      }
    });
  }

  _lockDeck(d, i, mi) {
    if (i === mi) {
      // The MASTER is the REFERENCE: it is NEVER re-aligned — even if it
      // is marked sync. Otherwise it gets chased by its own
      // followers (_getMasterDeck excludes it → it targeted a follower) and the
      // offset set with the jog "moved again" on its own after the gesture.
      // Only the lock's micro-correction is removed, and ONLY if the
      // deck is still in SYNC: a deck that BECOMES master must NEVER
      // jump in tempo — its _syncBase may be stale (tempo slider,
      // ÷2/×2 grid, track change) and re-applying it broke the
      // mix ("the remaining sound's BPM changes like crazy / goes ×2")
      if (d._pllCorr) {
        d._pllCorr = 0;
        if (d.synced && d._syncBase) d._setRate(d._syncBase);
      }
      return;
    }
    // SYNC deck STOPPED (sound just loaded, waiting): it ALREADY
    // takes the master's BPM — correct display, and no more tempo at 0 %
    // that a physical fader "recognized"; the phase locks on PLAY
    if (d.synced && !d.playing && d.bpm && d.buffer) {
      const m0 = this._getMasterDeck(i);
      if (m0 && m0.playing && m0.bpm) {
        const mB = m0.tempo / (1 + (m0._pllCorr || 0));
        let w = (m0.bpm * mB) / d.bpm;
        while (w > 1.6) w /= 2;
        while (w < 0.5) w *= 2;
        if (Math.abs(d.tempo / w - 1) > 1e-6) d._setRate(w);
      }
      return;
    }
    if (!d.synced || !d.playing) return;
    // (the old "_phaseFree" freeze created a cumulative MICRO-OFFSET:
    // detected BPMs are never perfect, so without holding, the gap
    // grows over the minutes — "not negligible over time". The
    // servo below holds THE OFFSET CHOSEN BY THE DJ, with
    // homeopathic, invisible corrections.)
    const m = this._getMasterDeck(i);
    if (!m || !m.playing) return;
    // ABSOLUTE "SAME BPM" GUARANTEE: SYNC on = the deck ALWAYS targets
    // the master's BPM. MISSING base (BPM corrected by hand, grid
    // ÷2/×2 — the purge left SYNC on… doing NOTHING anymore:
    // "the BPM locks but not to the same BPM") or ABERRANT base
    // (> 6 % from the target): the sync REPAIRS itself, immediate
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
      // followers follow INSTANTLY, in the same proportion — their
      // calibration (the small gap specific to the pair of tracks) is
      // kept. Before, the base stayed frozen as long as the gap didn't
      // exceed 6 %: you moved the master's tempo and the other
      // sounds drifted off, you had to re-SYNC.
      // (only against the REAL master: two followers using each other
      // as reference would send each other into a runaway)
      if (d._syncBase && d._lastWant && this.decks.indexOf(m) === mi
          && Math.abs(want / d._lastWant - 1) > 1e-6) {
        const f = want / d._lastWant;
        d._syncBase *= f;
        d._syncRef = (d._syncRef || d._syncBase / f) * f;
        d._setRate(d._syncBase * (1 + (d._pllCorr || 0)));
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
        d._setRate(want);
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
        d._setRate(d._syncBase);
      }
      return;
    }
    // FLASH CALIBRATION (one measurement, ONE SINGLE correction):
    // detected BPMs are never perfect, so the ratio computed at
    // SYNC is slightly off. The old servo "learned" the error
    // continuously → the displayed BPM took seconds to calm down and
    // "breathed" (142.0↔142.1 instead of 141.6: the two were
    // fighting). Here: tempo FROZEN, we measure the SLOPE of the phase
    // drift, and correct the ratio IN ONE GO — locked cleanly, the
    // tempo is then CONSTANT, equal to the master's BPM.
    // What the servo has added since the previous tick (file
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
      if (Math.abs(d.tempo - d._syncBase) > 1e-9) d._setRate(d._syncBase);
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
    const strong = d._routeW;
    const lim = strong ? 0.015 : 0.002;
    const corr = Math.max(-lim, Math.min(lim, eF * (strong ? 1.0 : 0.08)));
    // THE BASE IS FROZEN — NO MORE ABSORPTION AT ALL. That was THE cause of the
    // "BPM that changes continuously": the servo rewrote _syncBase on
    // every frame to absorb its own correction. After calibration,
    // _syncBase IS the exact ratio; the residue is held by a tiny
    // correction that the display already removes (deck.baseTempo). DO NOT
    // REINTRODUCE absorption here.
    d._pllCorr = corr;
    d._setRate(d._syncBase * (1 + corr));
  }
};
