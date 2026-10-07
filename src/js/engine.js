// Moteur audio : 4 decks -> EQ 3 bandes -> filtre -> fader -> crossfader -> master.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// On peut positionner un morceau AVANT son début (position négative) :
// il reste silencieux jusqu'à 0 puis démarre — pratique pour le caler en retard.
const PRE_ROLL = 3600;

// Latence du moteur de transposition (échantillons) — DOIT valoir LAT de
// pitch-worklet.js (le worklet l'annonce aussi au démarrage)
const WS_LAT_SAMPLES = 2647;

// Décalage GLOBAL de grille (réglable en ms dans les paramètres) : ajuste
// tous les traits de tous les morceaux d'un coup, selon ton oreille/écran
let GLOBAL_GRID_OFFSET = 0;
export function setGlobalGridOffset(sec) {
  GLOBAL_GRID_OFFSET = sec || 0;
}
export function getGlobalGridOffset() {
  return GLOBAL_GRID_OFFSET;
}

// --- Grille dynamique : helpers (position <-> index de temps) ---
// deck.beats = positions réelles de chaque temps ; deck.gridShift = décalage
// manuel global ; deck.barAnchor = index du temps qui démarre une mesure.

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

// Saut "mesure intacte" : au lieu de sauter pile où on a cliqué, on tombe
// dans la MÊME mesure (celle visée par le clic) mais à la même position
// RELATIVE qu'on occupait avant de sauter (ex: on était au 1/4 de la mesure
// 4 -> on tombe au 1/4 de la mesure 74, pas exactement sur le pixel cliqué).
// Sans grille de battements connue (pas de BPM détecté), on ne peut rien
// aligner : on renvoie la cible telle quelle.
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

// Pitch-shifter temps réel (technique des deux lignes de délai balayées en
// dents de scie et crossfadées) : change la tonalité sans changer la vitesse.
class PitchShifter {
  constructor(ctx) {
    this.ctx = ctx;
    this.T = 0.1;      // durée d'un grain (s)
    this.base = 0.006; // délai plancher
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

  // r = rapport de fréquence (2^(demi-tons/12))
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

// Boucle d'écho générique : délai + réinjection, avec filtre et/ou crush
// optionnels dans la boucle (fabrique commune des variantes d'écho).
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

// Part du son SEC retirée quand l'effet est à fond (la « nature » de
// l'effet) : un effet d'INSERTION (gate, filtre, crush, roll…) REMPLACE le
// son — à 100 % on n'entend plus que lui ; un écho/une réverb s'AJOUTE au
// son (sec juste compensé pour ne pas saturer) ; flanger/phaser ont besoin
// du sec (le peigne naît du mélange des deux).
export const FX_DRY_CUT = {
  trans: 1, filter: 1, crush: 1, robot: 1, pan: 1,
  roll: 0, // (le ROLL se dose dans le deck lui-même : boucle ↔ morceau)
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

    // Filtre DJ : neutre = peaking gain 0 (transparent), gauche = passe-bas, droite = passe-haut
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
    // Envoi PRÉ-FADER vers le bus casque (bouton CUE casque de la tranche) :
    // on entend le deck dans le casque même fader baissé — le vrai PFL
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.cueOn = false;
    this.filter.connect(this.cueSend);
    this.fader.connect(this.xf);
    // Sortie SÈCHE du deck, dosable : pendant un PAD FX tenu, l'effet
    // MANIPULE le son (le sec se coupe) au lieu de s'additionner par-dessus.
    // Les envois FX piquent sur xf AVANT ce gain : le wet n'est jamais coupé.
    this.dryOut = ctx.createGain();
    this.xf.connect(this.dryOut);
    this.dryOut.connect(destination);

    // TRIM : gain d'entrée de la piste (±12 dB), avant l'EQ
    this.trim = ctx.createGain();
    this.trim.gain.value = 1;
    this.trimVal = 0;
    this.trim.connect(this.eqLow);

    // Analyseur de niveau (VU-mètre + détection de saturation), post-EQ/filtre
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.filter.connect(this.analyser);
    this.meterBuf = new Float32Array(this.analyser.fftSize);

    // Point d'entrée du deck : direct vers l'EQ (via TRIM), ou via le
    // transpositeur (KEY ± et KEYLOCK). Le moteur WSOLA (AudioWorklet) est
    // branché dès qu'il est chargé ; l'ancien décalage à deux prises reste
    // en secours si le navigateur refuse les worklets.
    this.preIn = ctx.createGain();
    // Lecture PRINCIPALE (morceau ou stems) → srcGain → preIn : un ROLL
    // coupe srcGain et fait entendre sa boucle (rollGain) pendant que la
    // lecture continue en silence dessous — au relâcher, le morceau reprend
    // là où il en serait (comme le mode slip d'un CDJ)
    this.srcGain = ctx.createGain();
    this.srcGain.connect(this.preIn);
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollGain.connect(this.preIn);
    this._roll = null;
    this.shifter = new PitchShifter(ctx);
    this.shifter.output.connect(this.trim);
    // DEUX CHEMINS PERMANENTS : direct (dirGain) et transposé (wsOut, après
    // le moteur WSOLA). On bascule par des GAINS, en fondu — plus jamais de
    // rebranchement brutal (trou de son à chaque appui sur KEY).
    this.dirGain = ctx.createGain();
    this.preIn.connect(this.dirGain);
    this.dirGain.connect(this.trim);
    this.wsOut = ctx.createGain();
    this.wsOut.gain.value = 0;
    this.wsOut.connect(this.trim);
    // Grains de SCRATCH et effets platine : directement à l'EQ, sans passer
    // par la transposition (aucune latence sous la main)
    this.scrubIn = ctx.createGain();
    this.scrubIn.connect(this.trim);
    this.keyShift = 0;
    this.musicKey = null;   // tonalité DÉTECTÉE du morceau (0-23, voir key.js)
    this.keylock = false;   // conserver la tonalité quand le tempo change
    this.wsola = null;      // AudioWorkletNode, posé par AudioEngine
    this.wsLat = 0;         // latence FIXE du moteur WSOLA (s)
    this.procLat = 0;       // latence du chemin ACTIF : le morceau est lu d'autant en AVANCE
    this._routeW = false;   // le son passe-t-il par le transpositeur WSOLA ?
    this._pitchOn = false;  // (moteur de secours) transposition active ?

    // Stems (voix / batterie / basse / instru) : 4 sources synchronisées
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
    this.peaks = null;      // forme d'onde précalculée
    this.bpm = null;
    this.beatOffset = null; // position du premier temps (grille fixe, repli)
    this.beats = null;      // grille DYNAMIQUE : position réelle de chaque temps
    this.gridShift = 0;     // décalage manuel de la grille (flèches ◀ ▶)
    this.barAnchor = 0;     // index du temps qui démarre une mesure (GRID)
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
    // LE SYNC RESTE ALLUMÉ d'un morceau à l'autre (comme sur un CDJ) : on
    // ne doit pas le réappuyer à chaque chargement. Le nouveau morceau
    // repart en revanche d'un ratio VIERGE — l'ancien n'a aucun sens pour
    // lui — et le verrou le recale sur le master dès la première image.
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
        if (!this.stems[name]) continue; // (basse + mélodies fusionnées)
        const s = tag(mk(this.stems[name], this.stemGains[name]), name);
        if (primary) this._extraSources.push(s);
        else primary = s;
      }
      return primary;
    }
    return mk(this.buffer, this.srcGain);
  }

  // --- ROLL (boucle de répétition calée sur la grille) ---
  // beats = longueur de la boucle en temps (¼, ½, 1…) ; mix = intensité
  // (0 = morceau seul, 1 = boucle seule). La boucle part du DERNIER
  // multiple de « beats » sur la grille : le son continue normalement
  // jusqu'à la fin de la tranche, puis se répète — pile dans le temps.
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
    // déjà en roll sur la même tranche : seul le dosage change
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

  // Rampe propre : on efface d'abord tout ce qui était programmé (un
  // relâcher qui arrive avant le départ du roll laissait sinon le deck MUET)
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
    try { r.src.stop(t + (immediate ? 0.02 : 0.04)); } catch { /* déjà arrêtée */ }
    r.src.onended = () => { try { r.src.disconnect(); } catch { /* rien */ } };
  }

  // Démarrage PROGRAMMÉ à un instant exact : start(0) démarre « dès que
  // possible » avec quelques ms d'imprécision, ce qui créait un micro-décalage
  // à chaque play/seek/sync. Ici la comptabilité correspond à l'échantillon près.
  // heard = position ENTENDUE voulue à l'instant de départ. Quand le son
  // traverse le transpositeur (latence procLat), le morceau est LU d'autant
  // en avance : ce qu'on entend tombe pile sur la grille. readAhead=false
  // (PLAY depuis l'arrêt) : on lit depuis heard sans rien sauter — le son
  // sort procLat plus tard, attaque intacte, et l'horloge en tient compte.
  _startAll(when, heard, readAhead = true) {
    const at = this.ctx.currentTime + 0.03;
    this._schedTempo = this.tempo; // tempo qui a servi à programmer le départ
    const lead = this.procLat * this.tempo;
    const offset = readAhead ? heard + lead : heard;
    this.offset = offset - lead; // ancrage de currentTime() : position entendue à « at »
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

  // Active les stems séparés (voix/batterie/basse/instru) sur ce deck
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

  // Tonalité en demi-tons (-7..+7), sans changer la vitesse
  setKey(semi) {
    this.keyShift = clamp(Math.round(semi), -7, 7);
    this._applyPitch();
  }

  // KEYLOCK : garder la tonalité d'origine quand le tempo change
  setKeylock(on) {
    this.keylock = !!on;
    this._applyPitch();
  }

  // Rapport de transposition TOTAL = tonalité choisie × compensation du
  // tempo (keylock). Un tempo à 1,06 monte le son de ~1 demi-ton : le
  // keylock applique l'inverse pour annuler exactement cette montée.
  _applyPitch() {
    const key = Math.pow(2, this.keyShift / 12);
    const lock = this.keylock && this.tempo > 0 ? 1 / this.tempo : 1;
    const ratio = clamp(key * lock, 0.5, 1.8);
    const node = this.wsola;
    if (node) {
      // Chemin transposé tant que KEYLOCK ou KEY ≠ 0 — décision STABLE :
      // l'ancien seuil sur le rapport faisait entrer/sortir le son du
      // transpositeur chaque fois que le sync faisait osciller le tempo
      // autour de 1 (trous, sauts de latence)
      const want = this.keylock || this.keyShift !== 0;
      if (want !== this._routeW) this._switchRoute(want);
      node.parameters.get('ratio').setTargetAtTime(want ? ratio : 1, this.ctx.currentTime, 0.02);
      return;
    }
    // Moteur de SECOURS (navigateur sans worklet) : l'ancien comportement
    const need = Math.abs(ratio - 1) > 0.0015;
    if (need !== this._pitchOn) {
      this._pitchOn = need;
      try { this.preIn.disconnect(this.shifter.input); } catch { /* pas branché */ }
      if (need) this.preIn.connect(this.shifter.input);
      this.dirGain.gain.setValueAtTime(need ? 0 : 1, this.ctx.currentTime);
    }
    if (need) this.shifter.setRatio(ratio);
  }

  // Entrée / sortie du transpositeur SANS TROU NI DÉCALAGE. Le moteur a une
  // latence fixe L : le morceau doit être lu L en avance pour sonner à
  // l'heure. À l'ENTRÉE, l'ancien son continue en direct pendant L (le
  // temps que le transpositeur se remplisse) puis on passe la main en fondu ;
  // à la SORTIE, le direct reprend pile où on en est.
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
      // l'ancien son file en DIRECT jusqu'à ce que le transpositeur sorte
      // le nouveau, puis s'efface
      const tail = ctx.createGain();
      tail.connect(this.trim);
      tail.gain.setValueAtTime(1, now);
      tail.gain.setValueAtTime(1, at + L);
      tail.gain.linearRampToValueAtTime(0, at + L + 0.006);
      for (const src of old) {
        try { src.disconnect(); } catch { /* rien */ }
        const g = ctx.createGain();
        // le stem coupé (VOX…) le reste aussi pendant la traîne
        g.gain.value = src._stem ? this.stemGains[src._stem].gain.value : this.srcGain.gain.value;
        src.connect(g);
        g.connect(tail);
        src.onended = () => { try { src.disconnect(); g.disconnect(); tail.disconnect(); } catch { /* rien */ } };
        try { src.stop(at + L + 0.012); } catch { /* déjà arrêtée */ }
      }
      ramp(this.dirGain.gain, 0, now);
      this.wsOut.gain.cancelScheduledValues(now);
      this.wsOut.gain.setValueAtTime(0, now);
      this.wsOut.gain.setValueAtTime(0, at + L);
      this.wsOut.gain.linearRampToValueAtTime(1, at + L + 0.006);
    } else {
      for (const src of old) {
        src.onended = null;
        try { src.stop(at); } catch { /* déjà arrêtée */ }
      }
      ramp(this.dirGain.gain, 1, at);
      ramp(this.wsOut.gain, 0, at);
    }
    // nouvelle lecture, calée pour que le son entendu continue sans saut
    this.source = this._makeSource();
    this._attachEnded(this.source);
    this.startCtx = this._startAll(0, heard + 0.03 * this.tempo, true);
  }

  // TRIM : -1 -> -12 dB, 0 -> neutre, +1 -> +12 dB
  setTrim(v) {
    this.trimVal = clamp(v, -1, 1);
    this.trim.gain.setTargetAtTime(Math.pow(4, this.trimVal), this.ctx.currentTime, 0.01);
  }

  // Niveau crête instantané (0..~2) pour le VU-mètre
  meterPeak() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (let i = 0; i < this.meterBuf.length; i += 2) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // --- Boucles (sample-accurate via le loop natif de la source) ---
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
        // Fin naturelle du morceau : la file d'attente peut enchaîner
        if (this.onEnded) this.onEnded();
      }
    };
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.source = this._makeSource();
    this._attachEnded(this.source);
    this.startCtx = this._startAll(0, this.offset, false);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.stopRoll(true);
    // pause avant même que le son ait démarré : la position ne bouge pas
    if (this.ctx.currentTime >= this.startCtx) this.offset = this.currentTime();
    // Le transpositeur garde ~55 ms de son en réserve : on le coupe net à la
    // pause (sinon ce bout rejouait une 2e fois à la reprise)
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
      try { this.source.stop(); } catch { /* déjà arrêté */ }
      try { this.source.disconnect(); } catch { /* rien */ }
      this.source = null;
    }
    for (const s of this._extraSources) {
      try { s.stop(); } catch { /* déjà arrêté */ }
      try { s.disconnect(); } catch { /* rien */ }
    }
    this._extraSources = [];
  }

  currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    // PAS de plancher à 0 sur le temps écoulé : pendant les 30 ms qui
    // précèdent un démarrage programmé, la position est l'extrapolation
    // EXACTE (offset − ce qui reste à attendre). L'ancien Math.max(0, …)
    // la figeait sur la position FUTURE : tout calcul fait dans cette
    // fenêtre (SYNC juste après PLAY, 1re mesure de calibration juste après
    // le recalage…) partait avec jusqu'à 30 ms d'avance — d'où le SYNC
    // qu'il fallait appuyer 3 ou 4 fois.
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
    // Sauter hors de la boucle la désactive
    if (this.looping && (t < this.loopStart || t >= this.loopEnd)) {
      this.looping = false;
      this._loopBeats = null;
      for (const s of [this.source, ...this._extraSources]) {
        if (s) s.loop = false;
      }
    }
    if (this.playing) {
      this._stopSource();
      // COMPENSATION du démarrage programmé (30 ms) : on vise la position
      // où le son AURAIT été si le saut était instantané. Sans ça, chaque
      // jump/sync/hot cue atterrissait 30 ms en retard et le verrou sync
      // « recalait » audiblement juste après l'effet.
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

  // --- Scratch sonore à vélocité : le son ne joue QUE pendant le mouvement,
  // à la vitesse du geste (immobile = silence, comme un vrai vinyle tenu).
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
    // Le grain sonore ne couvre que la partie réelle du morceau (≥ 0)
    const gFrom = Math.max(0, Math.min(from, t));
    const gTo = Math.max(0, Math.max(from, t));
    const dist = gTo - gFrom;
    const dt = Math.max(0.005, now - this._scrubLastTime);

    if (dist > 0.0008) {
      // Grain joué à la vitesse du geste, BORNÉ à ~50 ms réels : balayer une
      // grande distance ne crée plus une pile de son « en file d'attente »
      const rate = clamp(dist / dt, 0.05, 6);
      const bufDur = Math.min(dist, rate * 0.05);
      const startPos = t >= from ? Math.max(0, gTo - bufDur) : gFrom;
      const realDur = bufDur / rate;

      // GRAINS EN FILE, BOUT À BOUT : chaque grain démarre quand le
      // précédent finit — ZÉRO chevauchement, donc zéro addition de
      // volumes, donc plus de saturation ; le scrub sonne au niveau du
      // morceau. Si la file prend trop de retard (> 90 ms), on saute le
      // grain : le suivant rattrape la position.
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
        try { src.disconnect(); g.disconnect(); } catch { /* rien */ }
      };
    }

    this._scrubLastPos = t;
    this._scrubLastTime = now;
    this.offset = t;
  }

  scrubEnd() {
    this._scrubbing = false;
  }

  // Comportement CDJ : en pause -> pose le point cue ; en lecture -> retour au cue + pause.
  // V.BRAKE / BACKSPIN « qualité rekordbox » : une LECTURE CONTINUE d'une
  // tranche du morceau (inversée pour le backspin) dont la VITESSE descend
  // en rampe native WebAudio — zéro grain, zéro hachage, le vrai son de
  // bande qui freine / rembobine. (l'ancien moteur à grains de scrub
  // « crachotait » à haute vitesse : des grains, ça hache par nature)
  spinSound(kind) {
    this.stopSpinSound();
    if (!this.buffer) return;
    const pos = this.currentTime();
    const back = kind === 'backspin';
    // BACKSPIN : départ à 7× (le « vvviiip » aigu façon rekordbox — à 3×
    // ce n'était « pas assez backspineux ») qui retombe en ~1,5 s
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
        // inversé : le 1er échantillon de la tranche = la position actuelle
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
    } catch { /* déjà terminé */ }
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
      // lecture = entendu + latence × tempo : changer le tempo déplace
      // d'autant l'ancrage entendu (quelques dixièmes de ms au plus)
      this.offset = this.currentTime() + this.procLat * (this.tempo - r);
      this.startCtx = this.ctx.currentTime;
    }
    // (avant un démarrage programmé, l'ancrage offset/startCtx reste
    // EXACT tel quel : le son partira de offset à startCtx quel que soit le
    // tempo — le réécrire décalait l'horloge de ce qui restait à attendre)
    this.tempo = r;
    if (this.source) this.source.playbackRate.value = r;
    for (const s of this._extraSources) s.playbackRate.value = r;
    if (this._roll) this._roll.src.playbackRate.value = r;
    // PRÉ-ROLL (position négative) : l'instant où le son démarrera a été
    // programmé avec l'ANCIEN tempo. Un deck syncé recevant ses corrections
    // pendant 10 s de pré-roll démarrait donc à côté de la grille. On
    // reprogramme le départ (le son n'a pas encore commencé : inaudible).
    if (this.playing && Math.abs(r - (this._schedTempo ?? r)) > 1e-5 && this.currentTime() < -0.05) {
      this.seek(this.currentTime());
    }
    // KEYLOCK : la compensation suit le tempo en direct (y compris les
    // micro-corrections du servo de synchro, inaudibles mais exactes)
    if (this.keylock) this._applyPitch();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    // Courbe quadratique : plus naturel à l'oreille
    this.fader.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.01);
  }

  // band: 'low' | 'mid' | 'high', v dans [-1, 1] ; -1 = kill (-40 dB), +1 = +6 dB
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

  // v dans [-1, 1] : négatif = passe-bas (coupe les aigus), positif = passe-haut (coupe les basses)
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

// Réponse impulsionnelle synthétique pour la réverb (bruit à décroissance
// exponentielle). MÉMOÏSÉE : un AudioBuffer est en lecture seule côté Web
// Audio, toutes les unités FX peuvent partager le MÊME — on en fabriquait
// jusqu'à 9 identiques (4 unités + master + pad FX), soit ~6,8 Mo et 25 ms
// de calcul pour rien.
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

// Unité d'effets style Beat FX : un effet à la fois, assignable à 1..4 decks,
// branchée en envoi (le son sec continue de passer, l'effet s'ajoute par-dessus).
export class FxUnit {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.wet = ctx.createGain();
    // Le FX démarre TOUJOURS au point le plus bas (demande David) : on
    // monte le niveau au stick, jamais de surprise à l'activation
    this.level = 0;
    this.wet.gain.value = this.level;
    this.wet.connect(output);
    this.enabled = false;
    this.type = 'echo';
    this.beatDur = 0.5;   // durée d'un temps (s), suit le BPM du master
    this.beatsMult = 0.5; // fraction de temps choisie (¼, ½, 1, 2)

    // Echo (délai avec réinjection, coupe-bas dans la boucle)
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

    // Flanger (délai court modulé par un LFO + réinjection)
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

    // Crush (réduction de résolution)
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = crushCurve(8);

    // (Delay simple, Ping Pong, Low Cut, variantes d'écho et MT Delay sont
    // bâtis AU PREMIER USAGE — voir _chain/_mk plus bas : chaque
    // createDelay(4) réserve ~1 Mo dès sa création, et une seule chaîne
    // tourne à la fois. C'était ~50 Mo de tampon mort au démarrage.)

    // Phaser (4 filtres passe-tout modulés)
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

    // Trans (gate rythmique carrée calée sur le tempo)
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

    // Pan automatique (gauche/droite en rythme)
    this.panNode = ctx.createStereoPanner();
    this.panLfo = ctx.createOscillator();
    this.panLfo.frequency.value = 1;
    this.panLfoGain = ctx.createGain();
    this.panLfoGain.gain.value = 0.9;
    this.panLfo.connect(this.panLfoGain);
    this.panLfoGain.connect(this.panNode.pan);
    this.panLfo.start();

    // Filter (balayage de bande synchronisé sur le tempo)
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

    // Robot (modulation en anneau)
    this.rmGain = ctx.createGain();
    this.rmGain.gain.value = 0;
    this.rmOsc = ctx.createOscillator();
    this.rmOsc.frequency.value = 35;
    this.rmOsc.connect(this.rmGain.gain);
    this.rmOsc.start();

    // Lignes de délai à mettre à l'heure du tempo : celles qui EXISTENT
    // (les autres naissent déjà à l'heure, voir _timeNow)
    this._delays = [this.echoDelay];
    this._lazy = {};
    // Réinjections dosées par le NIVEAU (l'écho s'allonge quand on monte)
    this._fbs = [{ g: this.echoFb, base: 0.45 }];
    // ROLL : joué par le DECK (boucle du morceau calée sur la grille), pas
    // par une ligne de délai — l'unité ne sort donc rien pour lui
    this._mute = ctx.createGain();
    this._mute.gain.value = 0;

    this._out = null;
    this._route();
  }

  // Temps de délai COURANT, sans rampe : une chaîne neuve doit naître à
  // l'heure, sinon sa 1re répétition part de 0,25 s et « glisse » vers le
  // tempo (effet doppler audible).
  _timeNow() { return clamp(this.beatDur * this.beatsMult, 0.02, 3.9); }

  // Fabrique paresseuse : construit la chaîne au premier usage, la garde
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

  // Réinjection selon le niveau : à bas niveau l'écho est court et
  // discret, à fond il prend toute sa traîne (bornée sous 1 : jamais d'emballement)
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
        // sortie = LE DÉLAI (le passe-haut est dans la boucle de
        // réinjection, pas en sortie) — routage d'origine conservé
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
    try { this.input.disconnect(); } catch { /* rien */ }
    if (this._out) {
      try { this._out.disconnect(this.wet); } catch { /* rien */ }
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
    // L'INTENSITÉ agit aussi DANS l'effet (pas seulement sur son volume) :
    // traîne des échos, profondeur du balayage, réinjection du flanger
    for (const f of this._fbs) f.g.gain.setTargetAtTime(this._fbFor(f.base), now, 0.05);
    this.fxbpLfoGain.gain.setTargetAtTime(650 * (0.35 + 0.65 * this.level), now, 0.05);
    this.flFb.gain.setTargetAtTime(0.15 + 0.5 * this.level, now, 0.05);
  }

  // CALAGE SUR LES TEMPS : les modulations (gate TRANS, balayages du
  // flanger, du phaser, du filtre, du pan) redémarrent PILE sur un temps
  // du morceau — avant, leurs oscillateurs tournaient avec une phase
  // quelconque : la gate hachait à côté du beat, « reliée à rien ».
  // at = instant audio (ctx) d'un début de temps / de mesure.
  alignTo(at) {
    const t = this._timeNow();
    if (!this._oscList) this._oscList = {};
    const swap = (key, type, freq, dest) => {
      // TOUS les oscillateurs encore vivants de cette modulation s'arrêtent
      // à « at » — celui qui tourne ET un éventuel remplaçant pas encore
      // parti (sinon deux LFO s'additionnaient : gate à 150 %)
      const list = this._oscList[key] || (this._oscList[key] = [this[key]]);
      for (const old of list) {
        try { old.stop(at); } catch { /* déjà arrêté */ }
        old.onended = () => { try { old.disconnect(); } catch { /* rien */ } };
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

  // Période de modulation en TEMPS (pour choisir où redémarrer)
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
    // seuil 0,05 % (et non 2 ms ≈ 0,5 %) : un écho calé sur un tempo faux
    // d'un demi-pourcent se décale à chaque répétition
    if (Math.abs(sec - this.beatDur) < this.beatDur * 0.0005) return;
    this.beatDur = sec;
    this._applyTime();
  }

  _applyTime() {
    const now = this.ctx.currentTime;
    const t = clamp(this.beatDur * this.beatsMult, 0.02, 3.9);
    // Seules les lignes RÉELLEMENT construites (les autres naîtront à
    // l'heure) — au passage : 1 à 3 événements AudioParam au lieu de 13
    for (const d of this._delays) d.delayTime.setTargetAtTime(t, now, 0.08);
    // La gate coupe/ouvre à chaque intervalle choisi
    this.trOsc.frequency.setTargetAtTime(clamp(1 / t, 0.25, 24), now, 0.05);
    // Les modulations suivent le tempo
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

    // Limiteur de sécurité sur le master
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;

    // Bus post-mix : master -> (retours FX/color) -> FILTRE MASTER -> limiteur
    this.postBus = this.ctx.createGain();
    this.mFilter = this.ctx.createBiquadFilter();
    this.mFilter.type = 'peaking';
    this.mFilter.gain.value = 0;
    this.mFilter.frequency.value = 1000;
    this.mFilter.Q.value = 0.9;
    this.masterFilterVal = 0;
    // Chemin SEC compensé : quand un FX est actif, ce gain baisse d'autant
    // (calibration façon rekordbox — le wet se fond DANS le mix au lieu de
    // s'empiler par-dessus et de dépasser le niveau du master)
    this.dryComp = this.ctx.createGain();
    this.masterGain.connect(this.dryComp);
    this.dryComp.connect(this.postBus);
    // RETOURS FX (unités du panneau, pads FX, Color FX) : ils suivent le
    // VOLUME MASTER comme le son sec — un effet d'insertion à fond coupe le
    // sec, et sans ce gain le knob master n'avait plus prise sur ce deck
    this.fxReturn = this.ctx.createGain();
    this.fxReturn.gain.value = 0.9;
    this.fxReturn.connect(this.postBus);
    this.postBus.connect(this.mFilter);
    this.mFilter.connect(this.limiter);
    // --- PRÉ-ÉCOUTE CASQUE : la platine est une CARTE SON 4 CANAUX
    // (master sur 1/2, casque sur 3/4). Si la sortie l'offre, le bus CUE
    // part vers les canaux 3/4 — la sortie casque physique de la FLX6.
    this.cueBus = this.ctx.createGain();
    this._wireOutput();

    // VU-mètre du MASTER (pris avant le limiteur : la LED rouge dit
    // « ça sature, le limiteur travaille »)
    this.masterVolume = 0.9;
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.mFilter.connect(this.masterAnalyser);
    this.masterMeterBuf = new Float32Array(this.masterAnalyser.fftSize);

    // Sortie parallèle pour l'enregistrement du mix (MediaRecorder)
    this.recDest = this.ctx.createMediaStreamDestination();
    this.limiter.connect(this.recDest);

    this.decks = [0, 1, 2, 3].map(i => new Deck(this.ctx, this.masterGain, i));
    // Envois casque de chaque deck vers le bus CUE
    this.decks.forEach((d) => d.cueSend.connect(this.cueBus));
    this._loadPitchWorklet();

    // 4 unités FX (une par joueur), chacune assignable à n'importe quel(s)
    // deck(s) : matrice d'envois 4 unités × 4 decks
    this.fx = [0, 1, 2, 3].map(() => new FxUnit(this.ctx, this.fxReturn));
    // fxAssign[u][i] : l'unité u traite le deck i (par défaut : son propre deck)
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

    // Unités PAD FX : une par deck, INDÉPENDANTES des 4 unités du panneau —
    // un pad maintenu n'écrit JAMAIS dans la config FX du joueur. Créées À
    // LA DEMANDE (premier appui) : zéro nœud audio tant qu'on ne s'en sert
    // pas — le logiciel doit rester léger même sur une vieille machine
    this.padFx = [null, null, null, null];

    // Color FX : ce que fait le knob FILTER de chaque tranche
    // ('filter' = biquad classique, sinon envoi vers un effet partagé)
    this.colorType = 'filter';
    this.colorEnabled = true;
    this.colorWet = this.ctx.createGain();
    this.colorWet.gain.value = 0.85; // plafonné pour ne pas dépasser le niveau du morceau
    this.colorWet.connect(this.fxReturn);
    this.colorBus = this.ctx.createGain();
    // Chaînes Color FX bâties AU PREMIER ROUTAGE (5 × ~1 Mo de tampon de
    // délai réservés pour rien au démarrage — voir _colorChain)
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

    // Source de bruit blanc partagée (Color FX « Noise »)
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
      // Bruit blanc dosé par le knob, qui suit le fader du deck
      d.noiseGain = this.ctx.createGain();
      d.noiseGain.gain.value = 0;
      this.noiseSrc.connect(d.noiseGain);
      d.noiseGain.connect(d.fader);
    });
    this._routeColor();

    // Decks 1 & 3 -> côté A, decks 2 & 4 -> côté B (comme Rekordbox en 4 decks)
    this.xfSides = ['A', 'B', 'A', 'B'];
    this.crossfader = 0.5;
    this.masterIdx = null;     // master choisi à la main (bouton MASTER)
    this.autoMasterIdx = null; // master automatique (règle du premier lancé)
    this.applyCrossfader();
  }

  // FX MASTER : une unité sur le MIX ENTIER (position MASTER du channel
  // select des platines). Créée à la demande, branchée en parallèle comme
  // les FX de deck : masterGain → send → unité → postBus (wet par-dessus)
  // Moteur de transposition WSOLA (KEY ± et KEYLOCK) : un nœud par deck,
  // chargé en tâche de fond. S'il échoue, chaque deck garde son ancien
  // décalage à deux prises — le logiciel reste utilisable dans tous les cas.
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
        // Branché EN PERMANENCE en parallèle du chemin direct : seul le gain
        // de sortie (wsOut) décide de ce qu'on entend
        d.preIn.connect(node);
        node.connect(d.wsOut);
        // Latence FIXE du moteur (annoncée par lui ; valeur connue d'avance
        // pour ne pas dépendre de l'arrivée du message)
        d.wsLat = WS_LAT_SAMPLES / this.ctx.sampleRate;
        node.port.onmessage = (e) => {
          if (e.data && e.data.lat) {
            d.wsLat = e.data.lat / this.ctx.sampleRate;
            if (d._routeW) d.procLat = d.wsLat;
          }
        };
        d.wsola = node;
        d._applyPitch(); // re-route si une tonalité était déjà posée
      });
      console.log('[midi] transposition : moteur WSOLA actif (keylock disponible)');
    } catch (e) {
      console.log(`[midi] transposition : moteur de secours (${String(e.message || e)})`);
    }
  }

  // Câblage de la sortie : 4 canaux si le périphérique le permet
  // (master → 1/2, casque → 3/4), sinon stéréo simple. À RAPPELER après
  // tout setSinkId (le nombre de canaux dépend du périphérique).
  _wireOutput() {
    const dest = this.ctx.destination;
    try { this.limiter.disconnect(); } catch { /* pas encore branché */ }
    try { this.cueBus.disconnect(); } catch { /* idem */ }
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
      console.log('[midi] audio : sortie 4 canaux — casque actif (canaux 3/4)');
    } else {
      this.limiter.connect(dest);
      this.phonesOk = false;
      console.log(`[midi] audio : sortie ${dest.maxChannelCount} canaux — pas de casque séparé`);
    }
  }

  // Bouton CUE casque d'une tranche : envoie/coupe le deck dans le casque
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

  // PAD FX : preset {type, beats, level} = effet actif sur le deck, null = coupé
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

  // Volume MASTER : le niveau de tout le mix assemblé
  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
    this.fxReturn.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.01);
  }

  // Niveau crête du mix assemblé (avant limiteur)
  masterPeak() {
    this.masterAnalyser.getFloatTimeDomainData(this.masterMeterBuf);
    let m = 0;
    for (let i = 0; i < this.masterMeterBuf.length; i += 2) {
      const v = Math.abs(this.masterMeterBuf[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // Filtre MASTER : agit sur tout le mix (les 4 pistes en même temps)
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

  // --- Color FX : mode du knob FILTER de chaque tranche ---
  _routeColor() {
    try { this.colorBus.disconnect(); } catch { /* rien */ }
    if (this._colorOut) {
      try { this._colorOut.disconnect(this.colorWet); } catch { /* rien */ }
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
    // 'filter' et 'noise' : pas de bus (biquad du deck / gain de bruit par deck)
    if (io) {
      this.colorBus.connect(io[0]);
      io[1].connect(this.colorWet);
      this._colorOut = io[1];
    }
  }

  setColorType(t) {
    this.colorType = t;
    this._routeColor();
    // Réapplique la valeur de chaque knob dans le nouveau mode
    this.decks.forEach((_, i) => this.setDeckColor(i, this.decks[i].filterVal));
  }

  // ON/OFF global : quand c'est OFF, tourner un knob FILTER n'a aucun effet
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
    // Courbe "mix" : les deux côtés à fond au centre
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

  // Règle du MASTER automatique (spec David) : le PREMIER son lancé devient
  // le master ; il LE RESTE tant qu'il joue ; quand il s'arrête, le master
  // passe au son qui a les BASSES ACTIVES (non coupées), sinon au premier
  // qui joue. Appelée à chaque frame.
  _updateAutoMaster() {
    const am = this.autoMasterIdx != null ? this.decks[this.autoMasterIdx] : null;
    if (am && am.playing) {
      this._amStopAt = 0;
      return; // le master reste le master tant qu'il joue
    }
    // TOLÉRANCE DE CUT : un master arrêté un court instant (cut rapide au
    // play/pause) GARDE sa couronne 1,2 s — le master ne doit JAMAIS
    // basculer sur un simple cut (la bascule re-syncait les autres decks
    // et « foutait en l'air » leur BPM). Une vraie fin de son dépasse la
    // grâce et la passation se fait — désormais sans aucun saut (syncLock).
    if (am) {
      const nowS = performance.now() / 1000;
      if (!this._amStopAt) {
        this._amStopAt = nowS;
        return;
      }
      if (nowS - this._amStopAt < 1.2) return;
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
    const bass = playing.filter((x) => x.d.eq.low > -0.9);
    this.autoMasterIdx = (bass.length ? bass : playing)[0].j;
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
    // Repli : on prend en PRIORITÉ un deck NON SYNCÉ. Sinon, avec 3 sons,
    // deux esclaves pouvaient se choisir mutuellement comme référence et se
    // poursuivre l'un l'autre — le BPM ne se posait jamais.
    return this.decks.find((d, j) => j !== excludeIdx && d.playing && d.bpm && !d.synced)
      || this.decks.find((d, j) => j !== excludeIdx && d.playing && d.bpm)
      || null;
  }

  // Phase d'un deck sur sa grille (0..1 dans le temps courant).
  // Grille dynamique si disponible : la phase suit les VRAIS temps du morceau.
  _beatPhase(d) {
    if (d.beats) {
      const f = gridIndexFracAt(d, d.currentTime());
      return f - Math.floor(f);
    }
    if (!d.bpm || d.beatOffset == null) return null;
    const b = (d.currentTime() - d.beatOffset) / (60 / d.bpm);
    return b - Math.floor(b);
  }

  // Phase dans la MESURE (0..1 sur 4 temps) — pour aligner les traits rouges
  _barPhase(d) {
    if (d.beats) {
      const f = (gridIndexFracAt(d, d.currentTime()) - (d.barAnchor || 0)) / 4;
      return f - Math.floor(f);
    }
    if (!d.bpm || d.beatOffset == null) return null;
    const b = (d.currentTime() - d.beatOffset) / (4 * 60 / d.bpm);
    return b - Math.floor(b);
  }

  // Période locale (durée du temps courant) en secondes de fichier
  _period(d) {
    return gridPeriodAt(d, d.currentTime()) || (d.bpm ? 60 / d.bpm : null);
  }

  // Vrai beat sync : cale le tempo EXACTEMENT sur le master, puis aligne la
  // phase (les temps tombent ensemble — les mesures ont la même taille ET
  // défilent en même temps). Retourne true si réussi.
  // Période MOYENNE du temps autour de la position courante (16 temps de
  // la grille dynamique) : bien plus juste que le BPM global arrondi, et
  // insensible au bruit d'un temps isolé (± 2 ms d'attaque).
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

  // Ratio de tempo qui donne au deck d EXACTEMENT la vitesse de battement
  // du master m (correction de servo du master retirée).
  _syncRatio(d, m) {
    const mBase = m.tempo / (1 + (m._pllCorr || 0));
    const pd = this._localPeriod(d);
    const pm = this._localPeriod(m);
    let ratio = pd && pm ? (mBase * pd) / pm : (m.bpm * mBase) / d.bpm;
    // Un son syncé vise TOUJOURS le BPM effectif du master — jamais son
    // double (David : « un 3e son que je sync se met à 2× le BPM ! »).
    // L'octave ne saute que si le tempo sortirait des limites physiques
    // du moteur [0.5 ; 1.6].
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
    d._syncBase = d.tempo; // référence pour le verrouillage continu
    d._syncRef = d.tempo;  // ancre de sécurité de l'APPRENTISSAGE de ratio
    d._phaseFree = false;  // SYNC demandé = le recollage de phase reprend

    // Alignement sur la MESURE : décale le deck pour que ses traits rouges
    // (débuts de mesure) coïncident avec ceux du master. Sur grille
    // dynamique, la cible est calculée en INDEX DE TEMPS puis reconvertie
    // en position : exact même si la mesure à franchir n'a pas des temps
    // parfaitement réguliers.
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
    d._syncPhaseOff = 0; // SYNC = retour à l'alignement grille sur grille
    d._ratioCal = false; // calibration au prochain frame…
    d._ratioMeas = null;
    d._ratioTries = 0;
    d._errFilt = 0;
    d._pllCorr = 0;
    d._lastWant = null;
    // …directement à l'étage FIN (8 s) quand le ratio vient de la grille
    // dynamique : il est déjà juste à ~0,05 %, une mesure d'1 s (±0,2 %)
    // ne ferait que le dégrader
    d._ratioPasses = d.beats && m.beats ? 1 : 0;
    return true;
  }

  // Ré-ancre le verrouillage continu sur l'alignement ACTUEL : après un
  // décalage manuel au jog, le calage automatique garde l'alignement choisi
  // à l'oreille au lieu de le défaire.
  reanchorSync(i) {
    const d = this.decks[i];
    // le MASTER est la référence : on ne l'ancre jamais contre un esclave
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
    // AIMANT VISUEL : un calage à l'oreille laisse toujours un micro-résidu
    // (± quelques ms) — inaudible, mais VISIBLE au zoom (« censés être
    // alignés mais ça ne l'est pas »). En-dessous de 0,03 temps (~12 ms),
    // l'intention est CLAIREMENT « aligné » : on vise l'alignement EXACT.
    // Un décalage volontaire plus grand reste respecté tel quel.
    if (Math.abs(err) < 0.03) err = 0;
    d._syncPhaseOff = err;
    d._errFilt = 0;
    // Une mesure de calibration en cours est FAUSSÉE par le geste manuel
    // (le déplacement serait pris pour une dérive de ratio) : on la jette —
    // la calibration DÉJÀ acquise (_ratioCal), elle, est conservée
    d._ratioMeas = null;
    // PLACEMENT MANUEL = PAROLE D'ÉVANGILE : plus AUCUNE poursuite de phase
    // ensuite (« les tracks ne doivent plus bouger une fois que je déplace »).
    // Le deck garde le bon TEMPO, c'est tout. SYNC ou un nouveau morceau
    // réactivent le recollage.
    d._phaseFree = true;
  }

  // Recale le deck i après un scratch à la main :
  // - si un AUTRE deck est en train de JOUER, on aligne la phase sur lui
  //   (beatmatching) ;
  // - sinon, on cale sur la PROPRE grille du morceau (segment ou micro-segment
  //   le plus proche) : posé sur un trait rouge, il y reste exactement.
  // AIMANT DISCRET (0,06 temps ≈ 25 ms) : il ne « termine » que les
  // lâchers déjà presque alignés — un placement volontairement décalé ou
  // un déplacement GROSSIER dans le son reste EXACTEMENT où le DJ l'a mis
  // (« on aimerait pouvoir déplacer grossièrement et faire des mouvements
  // rapides » — l'ancien 0,2 temps ravalait les placements sur les traits)
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

    // Recalage UNIQUEMENT si un autre deck joue (beatmatching), et seulement
    // en AIMANT : si on lâche presque aligné (< maxErr temps), on termine
    // l'alignement traits sur traits ; si on lâche clairement ailleurs,
    // c'est un déplacement volontaire — on ne touche à rien.
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

  // Deck dont une unité FX suit le tempo : le premier deck assigné qui
  // joue (sinon le master)
  fxRefDeck(uIdx) {
    const a = this.fxAssign[uIdx];
    if (a) {
      for (let d = 0; d < 4; d++) {
        if (a[d] && this.decks[d].playing && this.decks[d].bpm) return this.decks[d];
      }
    }
    return this.getMasterDeck(-1);
  }

  // Instant AUDIO du prochain multiple de « periodBeats » sur la grille du
  // deck (calé sur la mesure quand la période fait au moins un temps)
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
    // grille d'alignement : la période si elle est sous le temps, sinon la
    // mesure (une modulation de 16 temps repart quand même sur une mesure)
    const G = periodBeats < 1 ? periodBeats : Math.min(periodBeats, 4);
    const k = Math.ceil((f - anchor) / G + 1e-6) * G + anchor;
    const tFile = d.beats ? gridTimeAtIndex(d, k) : d.beatOffset + (k * 60) / d.bpm;
    if (tFile == null) return null;
    const at = this.ctx.currentTime + (tFile - pos) / (d.tempo || 1);
    return at > this.ctx.currentTime ? at : null;
  }

  // À chaque image : modulations des FX recalées sur les temps, et ROLL
  // (panneau FX ou pad) piloté sur les decks
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
    // ROLL : le pad tenu a priorité, sinon une unité ROLL du panneau
    // assignée au deck (ou le FX master en ROLL)
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

  // Verrouillage continu (à appeler à chaque frame) : tant qu'un deck est
  // synchronisé, on corrige les micro-dérives pour que les temps restent
  // collés à ceux du master, comme sur un vrai logiciel DJ.
  // jogHold : pendant un décalage manuel au jog, le verrou est suspendu
  // GLOBALEMENT — sinon les autres decks POURSUIVENT le deck qu'on décale
  // (le fameux « ça se fight avec le calage ») et le geste devient imprécis.
  syncLock() {
    // CALIBRATION FX PAR DECK (à chaque frame, ~zéro coût) : le sec de
    // CHAQUE deck baisse selon le FX le plus fort qui LE traite — unités
    // du panneau assignées à ce deck, et PAD FX tenu (qui peut demander
    // une coupure totale : « c'est le son qu'on manipule », pas un ajout).
    // Un FX sur le deck 2 ne touche jamais au deck 1.
    this.fxTick();
    this.decks.forEach((d, i) => {
      if (!d.dryOut) return;
      // Part du sec retirée selon la NATURE de chaque effet qui traite ce
      // deck : une gate/un filtre/un crush à fond REMPLACENT le son (sinon
      // le sec intact masquait l'effet — « l'intensité ne fait rien ») ;
      // un écho/une réverb s'ajoutent au son
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
    // FX MASTER : lui seul dose le sec du MIX ENTIER
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
    // CHANGEMENT DE MASTER = TRANSITION SANS AUCUN SAUT. L'ancienne base
    // (_syncBase) d'un deck peut dater d'un ANCIEN master : la réappliquer
    // au moment de la bascule changeait le BPM d'un coup (« un cut a changé
    // le master et foutu en l'air le BPM d'un des sons »). Ici chaque deck
    // syncé repart de sa vitesse ACTUELLE — rien ne bouge à l'oreille — et
    // se recalibre en éclair contre le NOUVEAU master.
    if (mi !== this._lastMi) {
      this._lastMi = mi;
      const mNew = mi != null ? this.decks[mi] : null;
      // BPM effectif du nouveau master, correction de servo retirée
      const mEff = mNew && mNew.bpm
        ? mNew.bpm * (mNew.tempo / (1 + (mNew._pllCorr || 0))) : null;
      this.decks.forEach((d, j) => {
        if (!d._syncBase) return;
        if (j !== mi && d.synced && d.bpm && mEff) {
          // Un deck SYNCÉ vise le BPM du NOUVEAU master : c'est le CONTRAT
          // du bouton SYNC. (la version « sans aucun saut » le laissait à
          // sa vitesse du moment : un deck syncé restait affiché 147.6
          // face à un master 144.9 — « pas calibré au même endroit »)
          let ratio = mEff / d.bpm;
          while (ratio > 1.6) ratio /= 2;
          while (ratio < 0.5) ratio *= 2;
          d._syncBase = ratio;
        } else {
          // le deck qui DEVIENT master (ou non-syncé) ne saute JAMAIS :
          // sa vitesse ACTUELLE devient sa base, la correction est retirée
          d._syncBase = d.tempo / (1 + (d._pllCorr || 0));
        }
        d._syncRef = d._syncBase;
        d._pllCorr = 0;
        d.setTempo(d._syncBase);
        d._ratioCal = false;
        d._ratioMeas = null;
        d._syncPhaseOff = null; // ré-ancré sur l'alignement PRÉSENT ci-dessous
        d._errFilt = 0;
        d._lastWant = null; // la cible vient d'être re-visée : pas de double mise à l'échelle
      });
    }
    // Master AUTO en arrêt bref (cut, dans la grâce de _updateAutoMaster) :
    // on FIGE tout — personne ne poursuit personne pendant le geste ; à la
    // reprise, l'alignement constaté est adopté tel quel. (jamais pour un
    // master MANUEL : mis en pause longtemps, il gèlerait tout à l'infini)
    if (this.masterIdx === null && mi != null && this.decks[mi]
        && !this.decks[mi].playing) return;
    this.decks.forEach((d, i) => {
      if (i === mi) {
        // Le MASTER est la RÉFÉRENCE : il n'est JAMAIS recalé — même s'il
        // est marqué sync. Sinon il se fait poursuivre par ses propres
        // esclaves (getMasterDeck l'exclut → il visait un esclave) et le
        // décalage posé au jog se « redéplaçait » tout seul après le geste.
        // On ne retire que la micro-correction du verrou, et SEULEMENT si le
        // deck est encore en SYNC : un deck qui DEVIENT master ne doit JAMAIS
        // sauter de tempo — son _syncBase peut être périmé (slider tempo,
        // grille ÷2/×2, changement de morceau) et le réappliquer cassait le
        // mix (« le BPM du son restant change de fou / fait ×2 »)
        if (d._pllCorr) {
          d._pllCorr = 0;
          if (d.synced && d._syncBase) d.setTempo(d._syncBase);
        }
        return;
      }
      if (!d.synced || !d.playing) return;
      // (l'ancien gel « _phaseFree » créait un MICRO-DÉCALAGE cumulatif :
      // les BPM détectés ne sont jamais parfaits, sans maintien l'écart
      // grandit avec les minutes — « pas négligeable avec le temps ». Le
      // servo ci-dessous maintient LE DÉCALAGE CHOISI PAR LE DJ, avec des
      // corrections homéopathiques invisibles.)
      const m = this.getMasterDeck(i);
      if (!m || !m.playing) return;
      // GARANTIE ABSOLUE « MÊME BPM » : SYNC allumé = le deck vise TOUJOURS
      // le BPM du master. Base ABSENTE (BPM corrigé à la main, grille
      // ÷2/×2 — la purge laissait un SYNC allumé… qui ne faisait plus
      // RIEN : « le BPM se calle mais pas au même BPM ») ou base ABERRANTE
      // (> 3 % de la cible) : le sync se RÉPARE tout seul, re-visée
      // immédiate puis recalibration éclair.
      if (d.bpm && m.bpm) {
        // Le BPM du master SANS sa micro-correction de servo : sinon la
        // cible elle-même tremblait, et le calcul ci-dessous n'arrivait
        // jamais à se poser (BPM qui bouge en continu à 3 sons).
        const mBase = m.tempo / (1 + (m._pllCorr || 0));
        let want = (m.bpm * mBase) / d.bpm;
        while (want > 1.6) want /= 2;
        while (want < 0.5) want *= 2;
        // LE MASTER A CHANGÉ DE TEMPO (fader, ♩ BPM master, platine…) : les
        // esclaves suivent À L'INSTANT, dans la même proportion — leur
        // calibration (le petit écart propre au couple de morceaux) est
        // conservée. Avant, la base restait figée tant que l'écart ne
        // dépassait pas 6 % : on bougeait le tempo du master et les autres
        // sons décrochaient, il fallait re-SYNC.
        // (seulement face au VRAI master : deux esclaves qui se servent
        // mutuellement de référence s'emballeraient l'un l'autre)
        if (d._syncBase && d._lastWant && this.decks.indexOf(m) === mi
            && Math.abs(want / d._lastWant - 1) > 1e-6) {
          const f = want / d._lastWant;
          d._syncBase *= f;
          d._syncRef = (d._syncRef || d._syncBase / f) * f;
          d.setTempo(d._syncBase * (1 + (d._pllCorr || 0)));
          // la mesure de calibration en cours a vu deux tempos : on la jette
          d._ratioMeas = null;
        }
        d._lastWant = want;
        d._syncWant = want;
        // Seuil de RÉPARATION à 6 %, très au-dessus des ±2 % que la
        // calibration s'autorise : les deux mécanismes se marchaient dessus
        // (la calibration poussait jusqu'à 3 %, la réparation punissait à
        // 3 % → remise à zéro → recalibration → boucle sans fin).
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
      if (!d._syncBase) return; // aucun BPM détecté : rien à verrouiller
      const pm = this._beatPhase(m);
      const pd = this._beatPhase(d);
      if (pm == null || pd == null) return;
      // Après un changement de master, l'alignement PRÉSENT devient la
      // cible : on ne « rattrape » jamais un décalage né d'une passation
      // (même aimant visuel qu'au ré-ancrage : quasi-aligné = aligné EXACT)
      if (d._syncPhaseOff == null) {
        let off = pm - pd;
        off -= Math.round(off);
        if (Math.abs(off) < 0.03) off = 0;
        d._syncPhaseOff = off;
      }
      // La cible n'est pas forcément phase 0 : après un décalage manuel au
      // jog, _syncPhaseOff mémorise l'alignement voulu par le DJ
      let err = pm - pd - (d._syncPhaseOff || 0);
      err -= Math.round(err);
      // Traits rouges clairement AILLEURS (décalage volontaire, jump non
      // quantisé, dérive de grille…) : on ADOPTE cet alignement au lieu de
      // le poursuivre pendant des secondes — le « recalibrage en continu »
      // audible est insupportable. Le verrou ne corrige QUE les
      // micro-dérives ; le placement du DJ est respecté tel quel.
      if (Math.abs(err) > 0.08) {
        d._syncPhaseOff = pm - pd;
        d._ratioMeas = null; // la cible a changé : mesure de calibration à refaire
        // une dérive pareille PENDANT la calibration = ratio de départ trop
        // loin pour l'étage fin : on repasse par la mesure grossière (±1 %)
        if (!d._ratioCal) d._ratioPasses = 0;
        d._errFilt = 0;
        if (d._pllCorr) {
          d._pllCorr = 0;
          d.setTempo(d._syncBase);
        }
        return;
      }
      // CALIBRATION ÉCLAIR (une mesure de 0,35 s, UNE SEULE correction) :
      // les BPM détectés ne sont jamais parfaits, donc le ratio calculé au
      // SYNC est légèrement faux. L'ancien servo « apprenait » l'erreur en
      // continu → le BPM affiché mettait des secondes à se calmer et
      // « respirait » (142.0↔142.1 au lieu de 141.6 : les deux se
      // battaient). Ici : tempo FIGÉ, on mesure la PENTE de dérive de
      // phase, et on corrige le ratio EN UNE FOIS — verrouillé net, le
      // tempo est ensuite CONSTANT, égal au BPM du master.
      if (!d._ratioCal) {
        // Horloge AUDIO (celle qui fait avancer les positions) : mesurer la
        // pente avec l'horloge système mêlait deux horloges qui dérivent
        const nowC = this.ctx.currentTime;
        // Un des deux sons attend encore son démarrage programmé : sa
        // position n'est qu'une extrapolation, on ne mesure rien là-dessus
        if (nowC < d.startCtx || nowC < m.startCtx) return;
        const passe = d._ratioPasses || 0;
        // DEUX ÉTAGES. La précision d'une mesure de pente vaut
        // (bruit de phase) / (durée × battements par seconde) :
        //   1 s  -> ±0,13 BPM   (ce qu'on entendait « presque calé »)
        //   8 s  -> ±0,015 BPM  (exact, à l'échelle d'un morceau entier)
        // Étage 1, rapide : on se cale tout de suite, en gros.
        // Étage 2, long : on affine sans que personne ne s'en aperçoive.
        const duree = passe === 0 ? 1 : 8;
        const ms = d._ratioMeas;
        if (!ms || nowC - ms.t > duree + 2) {
          // départ (ou mesure interrompue trop longtemps) : base propre
          if (d._pllCorr) {
            d._pllCorr = 0;
            d.setTempo(d._syncBase);
          }
          // Garde-fou : sur une grille vraiment fausse, la mesure serait
          // sans cesse invalidée — on n'insiste pas indéfiniment
          d._ratioTries = (d._ratioTries || 0) + 1;
          if (d._ratioTries > 12) { d._ratioCal = true; return; }
          d._ratioMeas = { t: nowC, e: err, dp: d.currentTime(), mp: m.currentTime() };
          return;
        }
        if (nowC - ms.t < duree) return;
        const dtW = nowC - ms.t;
        // VALIDITÉ : un beat jump / seek / boucle PENDANT la mesure fausse
        // la pente — c'était le « tu réajustes le BPM quand j'avance ou
        // recule » : chaque déplacement recalculait un faux ratio. Si l'un
        // des deux sons n'a pas avancé en ligne droite, la mesure est
        // JETÉE et refaite. Se déplacer ne touche JAMAIS le BPM.
        const dOk = Math.abs((d.currentTime() - ms.dp) / (d.tempo || 1) - dtW) < 0.05;
        const mOk = Math.abs((m.currentTime() - ms.mp) / (m.tempo || 1) - dtW) < 0.05;
        if (!dOk || !mOk) {
          d._ratioMeas = null;
          return;
        }
        let de = err - ms.e;
        de -= Math.round(de);
        const fd = (d.bpm * d.tempo) / 60; // temps (beats) par seconde
        const kRaw = 1 + de / (dtW * fd);
        // Étage 1 : grande correction autorisée (on part de loin).
        // Étage 2 : correction FINE seulement — à ce stade on n'ajuste plus
        // que le dernier millième, tout écart plus grand serait du bruit.
        const lim = passe === 0 ? 0.01 : 0.001;
        const k = Math.max(1 - lim, Math.min(1 + lim, kRaw));
        // PLAFOND ABSOLU : la calibration n'a le droit de s'écarter que de
        // 2 % du ratio visé. Au-delà, ce n'est plus une imprécision de BPM
        // détecté, c'est une grille fausse — et laisser filer faisait
        // dériver le tempo sans fin.
        const cible = d._syncWant || d._syncBase;
        d._syncBase = Math.max(cible * 0.98, Math.min(cible * 1.02, d._syncBase * k));
        d._syncRef = d._syncBase;
        // Butée atteinte = on re-mesure, mais JAMAIS plus de 4 fois : au-delà
        // la grille du morceau est en cause et s'acharner faisait bouger le
        // BPM en permanence (« ça ne calibre pas d'un coup »).
        // Terminé quand la correction devient NÉGLIGEABLE (0,02 % = 0,03 BPM
        // à 139) — ou après 4 passes, pour ne jamais s'acharner.
        d._ratioPasses = passe + 1;
        d._ratioCal = Math.abs(k - 1) < 0.0002 || d._ratioPasses >= 4;
        d._ratioMeas = null;
        d._errFilt = 0;
        d.setTempo(d._syncBase);
        return;
      }
      // ERREUR LISSÉE : l'horloge audio avance par blocs (~3 ms) — ce bruit
      // faisait « respirer » la correction dans les deux sens, VISIBLE sur
      // les vagues zoomées (inaudible). Passe-bas + zone morte élargie :
      // le servo ne réagit qu'aux vraies dérives, l'image reste immobile.
      d._errFilt = (d._errFilt || 0) * 0.85 + err * 0.15;
      const eF = d._errFilt;
      if (Math.abs(eF) < 0.0015) {
        // Collé au décalage voulu (< 0,6 ms) : repos total
        if (d._pllCorr) {
          d._pllCorr = 0;
          d.setTempo(d._syncBase);
        }
        return;
      }
      // SERVO DE MAINTIEN : corrections bornées ±0,2 %, inaudibles.
      // (l'épisode « ±0,15 % » : borne PLUS PETITE que le résidu possible
      // de la calibration → servo saturé à vie, glissement CONTINU à
      // l'écran — « il se décale à chaque instant, tu as empiré ». La
      // borne doit toujours dépasser le pire résidu de ratio.)
      const corr = Math.max(-0.002, Math.min(0.002, eF * 0.08));
      // LA BASE EST FIGÉE — PLUS AUCUNE ABSORPTION. C'était LA cause du
      // « BPM qui change en continu » : le servo réécrivait _syncBase à
      // chaque image pour absorber sa propre correction, si bien que le
      // tempo de référence n'arrêtait jamais de glisser, et qu'à trois ou
      // quatre sons on voyait les BPM danser sans fin.
      //
      // Après calibration, _syncBase EST le ratio exact et ne bouge plus
      // JAMAIS. Le résidu de calibration (±0,015 BPM après l'étage à 8 s)
      // est tenu par une correction PERMANENTE et minuscule — de l'ordre
      // de 0,01 % — que l'affichage retire déjà (voir _pllCorr dans
      // drawDeckWheel). Résultat : le BPM affiché est parfaitement
      // constant, et la phase reste tenue au millième de battement.
      // NE PAS RÉINTRODUIRE d'absorption ici.
      d._pllCorr = corr;
      d.setTempo(d._syncBase * (1 + corr));
    });
  }
}
