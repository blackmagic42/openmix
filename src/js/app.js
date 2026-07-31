import { AudioEngine } from './engine.js';
import { Library } from './library.js';
import { GamepadManager } from './gamepad.js';
import { computeBandPeaks, drawZoom, drawOverview, setWavePalette } from './waveform.js';
import { MidiManager, MIDI_ACTIONS_DECK, MIDI_ACTIONS_GLOBAL } from './midi.js';
import { gridIndexFracAt, gridTimeAtIndex, gridPeriodAt, setGlobalGridOffset, getGlobalGridOffset } from './engine.js';

const DECK_COLORS = ['#39c2ff', '#ff9f43', '#5fe08a', '#ff6b9d'];

const engine = new AudioEngine();
let activeDeck = 0;
let deckCount = Number(localStorage.getItem('deckCount')) === 2 ? 2 : 4;
let dragTrack = null;      // morceau en cours de drag & drop depuis la bibliothèque
let waveWindowSec = 8;     // zoom de la vue empilée (secondes visibles)
let scratchSound = localStorage.getItem('scratchSound') !== '0'; // scratch audible ?

// ---------------------------------------------------------------------------
// Petits composants : knob rotatif et faders
// ---------------------------------------------------------------------------

function makeKnob(label, getVal, setVal) {
  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';
  const knob = document.createElement('div');
  knob.className = 'knob';
  const ind = document.createElement('div');
  ind.className = 'knob-ind';
  knob.appendChild(ind);
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(knob, span);

  const update = () => {
    ind.style.transform = `rotate(${getVal() * 135}deg)`;
  };

  let dragging = false;
  let lastY = 0;
  knob.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastY = e.clientY;
    knob.setPointerCapture(e.pointerId);
  });
  knob.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = lastY - e.clientY;
    lastY = e.clientY;
    let v = Math.max(-1, Math.min(1, getVal() + dy * 0.012));
    // Zéro aimanté : le point neutre est facile à retrouver
    if (Math.abs(v) < 0.07) v = 0;
    setVal(v);
    update();
  });
  knob.addEventListener('pointerup', () => { dragging = false; });
  knob.addEventListener('dblclick', () => { setVal(0); update(); });

  update();
  return { el: wrap, update };
}

function makeVFader(el, getVal, setVal) {
  const thumb = document.createElement('div');
  thumb.className = 'vfader-thumb';
  el.appendChild(thumb);

  const update = () => {
    const h = el.clientHeight - 14;
    thumb.style.bottom = `${(getVal() * h).toFixed(1)}px`;
  };

  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    const v = 1 - (e.clientY - r.top - 7) / (r.height - 14);
    setVal(Math.max(0, Math.min(1, v)));
    update();
  };

  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  el.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  el.addEventListener('pointerup', () => { dragging = false; });

  update();
  return { update };
}

function makeHFader(el, getVal, setVal) {
  const thumb = document.createElement('div');
  thumb.id = 'xf-thumb';
  el.appendChild(thumb);

  const update = () => {
    const w = el.clientWidth - 18;
    thumb.style.left = `${(getVal() * w).toFixed(1)}px`;
  };

  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    let v = (e.clientX - r.left - 9) / (r.width - 18);
    v = Math.max(0, Math.min(1, v));
    // Centre aimanté : le 0 (milieu) est facile à retrouver
    if (Math.abs(v - 0.5) < 0.035) v = 0.5;
    setVal(v);
    update();
  };

  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  el.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('dblclick', () => { setVal(0.5); update(); });

  update();
  return { update };
}

// ---------------------------------------------------------------------------
// Panneaux de deck
// ---------------------------------------------------------------------------

const deckUI = [];

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Rangée de forme d'onde empilée (panneau du haut) : une par deck, alignées
// pour pouvoir caler les morceaux entre eux visuellement.
function buildWaveRow(i) {
  const row = document.createElement('div');
  row.className = 'wave-row';
  row.dataset.deck = i;
  row.style.setProperty('--deck-color', DECK_COLORS[i]);
  row.innerHTML = `
    <span class="deck-badge">${i + 1}</span>
    <canvas></canvas>
    <span class="wave-bpm">--.-</span>
  `;
  row.addEventListener('pointerdown', () => setActiveDeck(i));
  document.getElementById('waves').appendChild(row);

  // Scratch à la souris : clic maintenu = pause, glisser = déplacer la piste
  // (glisser à droite -> la position recule, comme si on tirait le vinyle).
  // En mode 🔊, on entend le son sous la tête pendant le déplacement.
  const canvas = row.querySelector('canvas');
  let scrub = null;
  canvas.addEventListener('pointerdown', (e) => {
    const deck = engine.decks[i];
    if (!deck.buffer) return;
    engine.resume();
    canvas.setPointerCapture(e.pointerId);
    scrub = {
      startX: e.clientX,
      wasPlaying: deck.playing,
      startTime: deck.currentTime(),
      audible: scratchSound
    };
    if (deck.playing) deck.pause();
    if (scrub.audible) deck.scrubStart();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!scrub) return;
    const deck = engine.decks[i];
    const secPerPx = (waveWindowSec * (deck.tempo || 1)) / Math.max(1, canvas.clientWidth);
    const dx = e.clientX - scrub.startX;
    // On peut tirer la piste AU-DELÀ de son début (position négative) pour
    // la faire commencer plus tard — plus aucun blocage à 0
    const t = Math.max(-3600, Math.min(deck.duration, scrub.startTime - dx * secPerPx));
    if (scrub.audible) {
      deck.scrubMove(t);
    } else {
      deck.seek(t);
    }
  });
  const endScrub = () => {
    if (!scrub) return;
    const deck = engine.decks[i];
    deck.scrubEnd();
    if (scrub.wasPlaying) deck.play();
    // Recale automatiquement : segment sur segment (désactivable en ⚙)
    if (localStorage.getItem('snapRelease') !== '0') engine.snapToRef(i);
    // Le placement posé à la souris est ADOPTÉ : sans ré-ancrage, le servo
    // RAMENAIT le son à l'ancien alignement (« il se remet sur le rouge »)
    for (let k = 0; k < 4; k++) engine.reanchorSync(k);
    scrub = null;
  };
  canvas.addEventListener('pointerup', endScrub);
  canvas.addEventListener('pointercancel', endScrub);

  return {
    el: row,
    canvas,
    bpm: row.querySelector('.wave-bpm')
  };
}

// --- File d'attente par deck : les morceaux s'enchaînent automatiquement ---
const deckQueues = [[], [], [], []];

function updateQueueUI(i) {
  const ui = deckUI[i];
  const q = deckQueues[i];
  if (!q.length) {
    ui.queueInfo.textContent = '— glisse un son ici pour l\'enchaîner —';
    ui.queueInfo.classList.remove('filled');
    ui.queueClear.classList.add('hidden');
  } else {
    ui.queueInfo.textContent = `${q.length} en file — prochain : ${q[0].name}`;
    ui.queueInfo.classList.add('filled');
    ui.queueClear.classList.remove('hidden');
  }
}

function queuePush(i, track) {
  // Les lignes de navigation (playlists SC, comptes 👤) ne se mettent pas en file
  if (!track || track.scPlaylist || track.scAccountRow) return;
  const deck = engine.decks[i];
  // Deck vide et file vide : on charge directement
  if (!deck.buffer && !deckQueues[i].length) {
    loadTrackToDeck(i, track);
    return;
  }
  deckQueues[i].push(track);
  updateQueueUI(i);
  flashStatus(`« ${track.name} » ajouté à la file du deck ${i + 1}`);
}

function makeQueueDropTarget(el, deckIdx) {
  el.addEventListener('dragover', (e) => {
    if (!dragTrack) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    if (!dragTrack) return;
    queuePush(deckIdx, dragTrack);
    dragTrack = null;
  });
}

// Rend un élément capable de recevoir un morceau par drag & drop
function makeDropTarget(el, deckIdx) {
  el.addEventListener('dragover', (e) => {
    if (!dragTrack) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-hover');
    if (!dragTrack) return;
    setActiveDeck(deckIdx);
    loadTrackToDeck(deckIdx, dragTrack);
    dragTrack = null;
  });
}

function buildDeckPanel(i) {
  const deck = engine.decks[i];
  const color = DECK_COLORS[i];
  const slot = document.getElementById(`deck-slot-${i}`);

  const el = document.createElement('div');
  el.className = 'deck';
  el.style.setProperty('--deck-color', color);
  el.innerHTML = `
    <div class="deck-head">
      <span class="deck-badge">${i + 1}</span>
      <span class="pad-chip hidden"></span>
      <img class="deck-cover hidden" alt="" title="Pochette du morceau">
      <span class="deck-title">— vide —</span>
      <span class="deck-master hidden">MASTER</span>
      <span class="beat-dots" title="Position dans la mesure (1·2·3·4)"><i></i><i></i><i></i><i></i></span>
      <span class="deck-key" title="KEY : tonalité en demi-tons — compense le changement de tonalité dû au sync (double-clic sur la valeur = reset)">
        <b>KEY</b>
        <button class="key-dn">−</button>
        <span class="key-val">0</span>
        <button class="key-up">+</button>
      </span>
      <span class="deck-bpm">--.-<small> BPM</small></span>
    </div>
    <canvas class="wave-over"></canvas>
    <div class="queue-line" title="Glisse un morceau ici : il se lancera automatiquement à la fin du son en cours (file d'attente du deck)">
      <span class="queue-chip">FILE</span>
      <span class="queue-info">— glisse un son ici pour l'enchaîner —</span>
      <button class="queue-clear hidden" title="Vider la file">✕</button>
    </div>
    <div class="pads-bar">
      <div class="pad-modes">
        <button data-m="jump" class="on">JUMP</button>
        <button data-m="loop">LOOP</button>
        <button data-m="hotcue">CUE</button>
        <button data-m="key">KEY</button>
        <button data-m="fx" title="PAD FX : chaque pad porte un effet (ROLL, ECHO…) — maintenir = il joue, relâcher = coupé">FX</button>
        <button data-m="smp" title="SAMPLER : un son par pad — pad vide : choisir un fichier, clic droit : retirer">SMPL</button>
        <div class="jump-scale">
          <button class="js-half" title="Force des sauts ÷2">½</button>
          <button class="js-dbl" title="Force des sauts ×2">×2</button>
        </div>
      </div>
      <div class="pads"></div>
      <div class="stems-col">
        <canvas class="deck-wheel" width="96" height="96" title="Platine — tourne pendant la lecture"></canvas>
        <span class="stems-title">STEMS</span>
        <button class="stem-btn" data-s="vocals" title="Voix">VOX</button>
        <button class="stem-btn" data-s="drums" title="Batterie">DRM</button>
        <button class="stem-btn" data-s="inst" title="Instrumental (basse + mélodies)">INST</button>
      </div>
    </div>
    <div class="deck-controls">
      <button class="btn-cue">CUE</button>
      <button class="btn-play">▶</button>
      <button class="btn-sync">SYNC</button>
      <button class="btn-master" title="Définir ce deck comme référence de tempo">MASTER</button>
      <button class="btn-grid" title="Recale la grille : place un début de mesure (trait rouge) exactement sur la tête de lecture">GRID</button>
      <button class="btn-grid-left" title="Décale finement la grille vers la gauche (maintenir = continu)">◀</button>
      <button class="btn-grid-right" title="Décale finement la grille vers la droite (maintenir = continu)">▶</button>
      <button class="btn-grid-half" title="Grille ÷2 : mesures deux fois plus larges (corrige une détection au double du vrai BPM)">÷2</button>
      <button class="btn-grid-dbl" title="Grille ×2 : mesures deux fois plus serrées (corrige une détection à la moitié du vrai BPM)">×2</button>
      <div class="deck-time">0:00 · -0:00</div>
      <label class="tempo-wrap">
        <span class="tempo-min">--</span>
        <span class="tempo-slider">
          <input type="range" class="tempo" min="-50" max="50" value="0" step="0.1">
          <i class="tempo-zero"></i>
        </span>
        <span class="tempo-max">--</span>
        <span class="tempo-val" title="BPM effectif — les traits colorés sur l'échelle montrent où sont les autres decks">--.-</span>
      </label>
    </div>
  `;
  slot.appendChild(el);

  const wave = buildWaveRow(i);

  // Marqueurs BPM des autres decks sur l'échelle de tempo
  const tempoSliderEl = el.querySelector('.tempo-slider');
  const tempoMarksEls = [];
  for (let j = 0; j < 4; j++) {
    if (j === i) { tempoMarksEls.push(null); continue; }
    const mark = document.createElement('i');
    mark.className = 'tempo-mark';
    mark.style.background = DECK_COLORS[j];
    mark.style.display = 'none';
    tempoSliderEl.appendChild(mark);
    tempoMarksEls.push(mark);
  }

  const ui = {
    el,
    wave,
    title: el.querySelector('.deck-title'),
    cover: el.querySelector('.deck-cover'),
    beatDots: [...el.querySelectorAll('.beat-dots i')],
    padChip: el.querySelector('.pad-chip'),
    bpm: el.querySelector('.deck-bpm'),
    master: el.querySelector('.deck-master'),
    over: el.querySelector('.wave-over'),
    play: el.querySelector('.btn-play'),
    sync: el.querySelector('.btn-sync'),
    cue: el.querySelector('.btn-cue'),
    grid: el.querySelector('.btn-grid'),
    gridRightBtn: el.querySelector('.btn-grid-right'),
    gridDblBtn: el.querySelector('.btn-grid-dbl'),
    padModesEl: el.querySelector('.pad-modes'),
    jumpScaleEl: el.querySelector('.jump-scale'),
    keyWrap: el.querySelector('.deck-key'),
    masterBtn: el.querySelector('.btn-master'),
    keyVal: el.querySelector('.key-val'),
    keyUp: el.querySelector('.key-up'),
    keyDn: el.querySelector('.key-dn'),
    padModeBtns: [...el.querySelectorAll('.pad-modes button[data-m]')],
    cueOwner: Array(10).fill(null), // joueur qui a posé chaque cue
    loopOwner: null,                // joueur qui tient la boucle
    padsEl: el.querySelector('.pads'),
    pads: [],
    padMode: 'jump',
    stemsCol: el.querySelector('.stems-col'),
    wheelCv: el.querySelector('.deck-wheel'),
    queueLine: el.querySelector('.queue-line'),
    queueInfo: el.querySelector('.queue-info'),
    queueClear: el.querySelector('.queue-clear'),
    jumpScale: 1,
    time: el.querySelector('.deck-time'),
    tempo: el.querySelector('.tempo'),
    tempoVal: el.querySelector('.tempo-val'),
    tempoMin: el.querySelector('.tempo-min'),
    tempoMax: el.querySelector('.tempo-max'),
    tempoSlider: tempoSliderEl,
    tempoMarks: tempoMarksEls,
    color,
    loading: false
  };

  el.addEventListener('pointerdown', () => setActiveDeck(i));
  ui.play.addEventListener('click', () => playDeck(i));

  // CUE façon CDJ : maintenir = le son joue depuis le point de cue,
  // relâcher = retour au point et arrêt
  let cueHold = false;
  ui.cue.addEventListener('pointerdown', (e) => {
    engine.resume();
    if (deck.playing) {
      deck.cue(); // retour au cue + pause
      return;
    }
    const atCue = deck.buffer && Math.abs(deck.currentTime() - deck.cuePoint) < 0.02;
    if (!atCue) {
      deck.cue(); // pose le point de cue ici
      return;
    }
    ui.cue.setPointerCapture(e.pointerId);
    cueHold = true;
    deck.play();
  });
  const endCueHold = () => {
    if (!cueHold) return;
    cueHold = false;
    deck.pause();
    deck.seek(deck.cuePoint);
  };
  ui.cue.addEventListener('pointerup', endCueHold);
  ui.cue.addEventListener('pointercancel', endCueHold);

  ui.sync.addEventListener('click', () => { syncDeck(i); });

  // File d'attente du deck : drop pour ajouter, enchaînement auto en fin de morceau
  makeQueueDropTarget(ui.queueLine, i);
  ui.queueClear.addEventListener('click', () => {
    deckQueues[i].length = 0;
    updateQueueUI(i);
  });
  deck.onEnded = () => {
    const q = deckQueues[i];
    if (!q.length) return;
    const next = q.shift();
    updateQueueUI(i);
    flashStatus(`Deck ${i + 1} : « ${next.name} » chargé depuis la file — prêt (en pause)`);
    loadTrackToDeck(i, next); // chargé PRÊT, en pause — à toi de lancer
  };
  // Recalage de grille : partagé entre le bouton écran ET le bouton GRID
  // des platines MIDI (le calage est SAUVEGARDÉ sur le morceau, il revient
  // tout seul au prochain chargement)
  const recalGrid = () => {
    if (!deck.buffer || !deck.bpm) {
      flashStatus('GRID : charge un morceau avec un BPM détecté d’abord');
      return;
    }
    const t = deck.currentTime();
    if (deck.beats) {
      // Grille dynamique : le temps le plus proche devient un DÉBUT DE MESURE,
      // posé exactement sous la tête de lecture
      const k = Math.round(gridIndexFracAt(deck, t));
      deck.gridShift += t - gridTimeAtIndex(deck, k);
      deck.barAnchor = k;
      if (deck.track) library.setGridMeta(deck.track, { gridShift: deck.gridShift, barAnchor: deck.barAnchor });
    } else {
      deck.beatOffset = t;
      if (deck.track) library.setBeatOffset(deck.track, deck.beatOffset);
    }
    flashStatus(`Grille du deck ${i + 1} recalée : début de mesure posé ici`);
  };
  ui.grid.addEventListener('click', recalGrid);
  ui.recalGrid = recalGrid;

  // CORRECTION MANUELLE DU BPM : double-clic sur l'affichage BPM du deck —
  // porte de sortie quand l'analyse se trompe (ex. 162 détecté pour 145).
  // La valeur saisie est SAUVEGARDÉE sur le morceau (manualBpm : la
  // ré-analyse ne l'écrasera plus), la grille est reconstruite dessus.
  ui.bpm.style.cursor = 'pointer';
  ui.bpm.title = 'Double-clic : corriger le BPM à la main (sauvegardé sur le morceau)';
  ui.bpm.addEventListener('dblclick', async () => {
    if (!deck.buffer || !deck.bpm) return;
    const val = await askText(`BPM réel du deck ${i + 1} (détecté : ${deck.bpm.toFixed(1)})`, deck.bpm.toFixed(1));
    const nb = Number(String(val).replace(',', '.'));
    if (!nb || nb < 40 || nb > 260) return;
    deck.bpm = nb;
    deck.beats = null; // grille FIXE reconstruite sur le BPM saisi
    if (deck.beatOffset == null) deck.beatOffset = 0;
    deck.synced = false;
    deck._syncBase = null;
    deck._pllCorr = 0;
    if (deck.track) library.setBpmValue(deck.track, nb);
    updateTempoLabel(i);
    flashStatus(`Deck ${i + 1} — BPM corrigé à ${nb} (mémorisé)`);
  });
  ui.masterBtn.addEventListener('click', () => {
    engine.setMaster(i);
    flashStatus(engine.masterIdx === null ? 'Master automatique' : `Deck ${i + 1} = MASTER`);
  });
  const gridScale = (mult) => {
    if (!deck.bpm) return;
    const nb = Math.round(deck.bpm * mult * 1000) / 1000;
    if (nb < 40 || nb > 320) return;
    if (deck.beats) {
      // Grille dynamique : on double la densité (points intermédiaires) ou on
      // garde un temps sur deux (en préservant l'ancrage de mesure)
      let nbBeats;
      if (mult > 1) {
        nbBeats = [];
        for (let k = 0; k < deck.beats.length - 1; k++) {
          nbBeats.push(deck.beats[k]);
          nbBeats.push(Math.round(((deck.beats[k] + deck.beats[k + 1]) / 2) * 1000) / 1000);
        }
        nbBeats.push(deck.beats[deck.beats.length - 1]);
        deck.barAnchor = (deck.barAnchor || 0) * 2;
      } else {
        const par = ((deck.barAnchor || 0) % 2 + 2) % 2;
        nbBeats = deck.beats.filter((_, k) => k % 2 === par);
        deck.barAnchor = Math.floor((deck.barAnchor || 0) / 2);
      }
      deck.beats = nbBeats;
      deck.bpm = nb;
      deck.synced = false;
      // Le BPM vient de changer ×2/÷2 : l'ancien ratio de sync est caduc
      deck._syncBase = null;
      deck._pllCorr = 0;
      if (deck.track) library.setGridData(deck.track, { beats: nbBeats, barAnchor: deck.barAnchor, bpm: nb });
    } else {
      deck.bpm = nb;
      deck.synced = false;
      deck._syncBase = null;
      deck._pllCorr = 0;
      if (deck.track) library.setBpmValue(deck.track, nb);
    }
    updateTempoLabel(i);
    flashStatus(`Grille du deck ${i + 1} : ${nb.toFixed(1)} BPM — les mesures sont maintenant ${mult > 1 ? '2× plus serrées' : '2× plus larges'}`);
  };
  el.querySelector('.btn-grid-half').addEventListener('click', () => gridScale(0.5));
  el.querySelector('.btn-grid-dbl').addEventListener('click', () => gridScale(2));

  // Flèches de calibrage fin : appui = petit décalage de la grille,
  // maintien = continu, SANS couper le son.
  // Avec SHIFT : réglage fin du BPM (±0,01) — pour tuer une dérive résiduelle.
  const gridNudge = (dir) => {
    if (deck.beats) {
      deck.gridShift += dir * 0.002;
    } else if (deck.beatOffset != null) {
      deck.beatOffset = Math.max(0, deck.beatOffset + dir * 0.002);
    }
  };
  const bpmNudge = (dir) => {
    if (!deck.bpm || deck.beats) return; // inutile sur grille dynamique
    deck.bpm = Math.round((deck.bpm + dir * 0.005) * 1000) / 1000;
    updateTempoLabel(i);
  };
  const bindNudge = (btn, dir) => {
    let timer = null;
    let shiftMode = false;
    btn.addEventListener('pointerdown', (e) => {
      btn.setPointerCapture(e.pointerId);
      shiftMode = e.shiftKey;
      if (shiftMode) {
        bpmNudge(dir * 2);
        timer = setInterval(() => bpmNudge(dir), 60);
      } else {
        gridNudge(dir * 1.5);
        timer = setInterval(() => gridNudge(dir), 40);
      }
    });
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        if (deck.track) {
          if (shiftMode && !deck.beats) library.setBpmValue(deck.track, deck.bpm);
          else if (deck.beats) library.setGridMeta(deck.track, { gridShift: deck.gridShift });
          else library.setBeatOffset(deck.track, deck.beatOffset);
        }
        if (shiftMode && !deck.beats) flashStatus(`Deck ${i + 1} : BPM ajusté à ${deck.bpm.toFixed(3)}`);
      }
    };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
  };
  const gl = el.querySelector('.btn-grid-left');
  const gr = el.querySelector('.btn-grid-right');
  gl.title = 'Décale finement la grille vers la gauche (maintenir = continu) — Shift : BPM −0,01';
  gr.title = 'Décale finement la grille vers la droite (maintenir = continu) — Shift : BPM +0,01';
  bindNudge(gl, -1);
  bindNudge(gr, 1);

  const applyKey = (delta) => {
    engine.resume();
    deck.setKey(deck.keyShift + delta);
    ui.keyVal.textContent = `${deck.keyShift > 0 ? '+' : ''}${deck.keyShift}`;
    ui.keyVal.classList.toggle('shifted', deck.keyShift !== 0);
  };
  ui.keyUp.addEventListener('click', () => applyKey(1));
  ui.keyDn.addEventListener('click', () => applyKey(-1));
  ui.keyVal.addEventListener('dblclick', () => applyKey(-deck.keyShift));
  ui.applyKey = applyKey; // utilisé par les pads du mode KEY

  // Pads de performance : HOT CUE / BEAT JUMP / BEAT LOOP (10 = 5×L/R)
  for (let p = 0; p < PAD_COUNT; p++) {
    const pad = document.createElement('button');
    pad.className = 'pad';
    // PAD FX = MAINTENIR (pointerdown/up), SAMPLER = frappe immédiate au
    // pointerdown (le click arrive au relâcher : trop mou pour jouer) —
    // les autres modes gardent le click classique
    pad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (ui.padMode === 'fx') {
        pad.setPointerCapture(e.pointerId);
        padFxPress(i, p, true);
      } else if (ui.padMode === 'smp') {
        samplerPress(i, p);
      }
    });
    const padRelease = () => {
      if (ui.padMode === 'fx') padFxPress(i, p, false);
    };
    pad.addEventListener('pointerup', padRelease);
    pad.addEventListener('pointercancel', padRelease);
    pad.addEventListener('click', () => {
      if (ui.padMode === 'fx' || ui.padMode === 'smp') return; // déjà gérés
      padPress(i, p);
    });
    pad.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      padClear(i, p);
    });
    ui.padsEl.appendChild(pad);
    ui.pads.push(pad);
  }
  ui.padModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.padMode = btn.dataset.m;
      renderPads(i);
    });
  });
  el.querySelector('.js-half').addEventListener('click', () => {
    ui.jumpScale = Math.max(0.25, ui.jumpScale / 2);
    renderPads(i);
  });
  el.querySelector('.js-dbl').addEventListener('click', () => {
    ui.jumpScale = Math.min(4, ui.jumpScale * 2);
    renderPads(i);
  });
  ui.stemBtns = [...ui.stemsCol.querySelectorAll('.stem-btn')];
  ui.stemBtns.forEach((b) => {
    b.addEventListener('click', () => stemPress(i, b.dataset.s));
  });

  // Drag & drop d'un morceau sur le panneau du deck ou sur sa forme d'onde
  makeDropTarget(el, i);
  makeDropTarget(wave.el, i);
  ui.tempo.addEventListener('input', () => {
    // Zéro aimanté : près du centre, on colle à 0.0 % pile
    let v = Number(ui.tempo.value);
    if (Math.abs(v) < 0.8) {
      v = 0;
      ui.tempo.value = 0;
    }
    deck.setTempo(1 + v / 100);
    deck.synced = false;
    updateTempoLabel(i);
  });
  ui.tempo.addEventListener('dblclick', () => {
    deck.setTempo(1);
    deck.synced = false;
    updateTempoLabel(i);
  });
  // Miniature : navigation CONTINUE — tant que le clic est maintenu,
  // la position suit la souris (avec le son de scrub si activé)
  let overScrub = null;
  const overPosFromEvent = (e) => {
    const r = ui.over.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return frac * deck.duration;
  };
  ui.over.addEventListener('pointerdown', (e) => {
    if (!deck.buffer) return;
    engine.resume();
    ui.over.setPointerCapture(e.pointerId);
    overScrub = { wasPlaying: deck.playing, audible: scratchSound };
    if (deck.playing) deck.pause();
    if (overScrub.audible) deck.scrubStart();
    const t = overPosFromEvent(e);
    if (overScrub.audible) deck.scrubMove(t);
    else deck.seek(t);
  });
  ui.over.addEventListener('pointermove', (e) => {
    if (!overScrub) return;
    const t = overPosFromEvent(e);
    if (overScrub.audible) deck.scrubMove(t);
    else deck.seek(t);
  });
  const endOverScrub = () => {
    if (!overScrub) return;
    deck.scrubEnd();
    if (overScrub.wasPlaying) deck.play();
    // Miniature = navigation : JAMAIS de recadrage — et la sync ADOPTE la
    // position choisie au lieu de la « recalibrer » aussitôt
    for (let k = 0; k < 4; k++) engine.reanchorSync(k);
    overScrub = null;
  };
  ui.over.addEventListener('pointerup', endOverScrub);
  ui.over.addEventListener('pointercancel', endOverScrub);

  // Vignette PAD FX : l'effet en cours s'affiche en grand sur le deck
  const padFxChip = document.createElement('div');
  padFxChip.className = 'padfx-chip';
  el.appendChild(padFxChip);
  ui.padFxChip = padFxChip;

  deckUI.push(ui);
}

// --- Pads : hot cues, beat jump, beat loop ---
// 10 pads : moitié GAUCHE = ce que fait L2 (une par rangée de knob),
// moitié DROITE = ce que fait R2, en miroir (grosses forces à l'extérieur).
// Rangée r (TRIM=1 … FILTER=5) → pad L = r-1, pad R = 10-r.
// JUMP : −16 −8 −4 −2 −1 | +1 +2 +4 +8 +16 (mesures)
// LOOP : IN OUT ✕ ✕ ✕ | 1 2 4 8 16 temps (IN/OUT = boucle manuelle, ✕ = sortir)
// CUE  : A B C D E | F G H I J
const LOOP_BEATS = [null, null, null, null, null, 1, 2, 4, 8, 16];
// Sauts en MESURES : 1/8 · 1/4 · 1/2 · 1 · 2 (miroir, grands sauts à l'extérieur)
const JUMP_VALS = [-2, -1, -0.5, -0.25, -0.125, 0.125, 0.25, 0.5, 1, 2];
// Force par rangée (TRIM → FILTER) selon le mode
const JUMP_ROW_MEASURES = [2, 1, 0.5, 0.25, 0.125];
const LOOP_ROW_BEATS = [16, 8, 4, 2, 1];
const KEY_VALS = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]; // demi-tons (mode KEY)
// PAD FX façon Rekordbox : MAINTENIR = l'effet joue, RELÂCHER = il se coupe
// et l'unité FX du deck retrouve exactement son réglage d'avant.
// beats = fraction de temps (suit le BPM master), level = dosage fixe du pad
// Sélection de David (d'après les deux banques Rekordbox) : V.BRAKE et
// BACKSPIN gardés (effets « platine » : spin = manipulation du disque),
// plus 8 effets wet (echo, sweep…)
const PADFX = [
  { label: 'ROLL ½', type: 'roll', beats: 0.5, level: 0.9 },
  { label: 'SWEEP', type: 'filter', beats: 4, level: 0.9 },
  { label: 'FLANGER', type: 'flanger', beats: 2, level: 0.85 },
  { label: 'TRANS', type: 'trans', beats: 0.5, level: 1 },
  { label: 'V.BRAKE', spin: 'vbrake' },
  { label: 'ECHO ¼', type: 'echo', beats: 0.25, level: 0.7 },
  { label: 'ECHO ½', type: 'echo', beats: 0.5, level: 0.7 },
  { label: 'MT DELAY', type: 'mtdelay', beats: 0.5, level: 0.75 },
  { label: 'REVERB', type: 'reverb', beats: 1, level: 0.75 },
  { label: 'BACKSPIN', spin: 'backspin' }
];
const PAD_COUNT = 10;
const padForSide = (row, side) => (side > 0 ? 10 - row : row - 1);
// Couleur NÉON propre à chaque JOUEUR — volontairement DIFFÉRENTES des
// couleurs de pistes (bleu/orange/vert/rose) pour toujours savoir qui est où
const PLAYER_COLORS = ['#c724ff', '#ffe600', '#ff1744', '#00ffd0'];
const GP_MODES = ['jump', 'loop', 'hotcue', 'key', 'fx', 'smp']; // ordre des onglets
const GP_MODE_NAMES = {
  hotcue: 'HOT CUE', jump: 'BEAT JUMP', loop: 'BEAT LOOP', key: 'KEY',
  fx: 'PAD FX', smp: 'SAMPLER'
};

function formatMeasures(v) {
  const a = Math.abs(v);
  const sign = v > 0 ? '+' : '−';
  if (a >= 1) return `${sign}${a}`;
  return `${sign}1/${Math.round(1 / a)}`;
}

function renderPads(i) {
  const ui = deckUI[i];
  ui._padViewSig = null; // force les vues par joueur à se reposer si besoin
  ui.pads.forEach((p) => {
    p.classList.remove('pad-tinted', 'set-any');
    p.style.background = '';
    p.style.borderColor = '';
  });
  ui.padModeBtns.forEach((b) => b.classList.toggle('on', b.dataset.m === ui.padMode));
  // FX et SAMPLER portent du TEXTE (noms) : police réduite pour tout caser
  ui.padsEl.classList.toggle('pads-text', ui.padMode === 'fx' || ui.padMode === 'smp');
  ui.pads.forEach((p, idx) => {
    p.classList.remove('set', 'on');
    if (ui.padMode === 'hotcue') {
      p.textContent = String.fromCharCode(65 + idx); // A B C D E F G H
      p.title = 'Clic : poser / sauter au hot cue — Clic droit : effacer';
    } else if (ui.padMode === 'jump') {
      const v = JUMP_VALS[idx] * (ui.jumpScale || 1);
      p.textContent = formatMeasures(v);
      p.title = `Sauter de ${formatMeasures(v).slice(1)} mesure(s) ${v > 0 ? 'en avant' : 'en arrière'}`;
    } else if (ui.padMode === 'key') {
      const kv = KEY_VALS[idx];
      p.textContent = `${kv > 0 ? '+' : ''}${kv}♪`;
      p.title = `Tonalité ${kv > 0 ? '+' : ''}${kv} demi-ton(s) — re-cliquer pour revenir à 0`;
    } else if (ui.padMode === 'fx') {
      p.textContent = PADFX[idx].label;
      p.title = `MAINTENIR : ${PADFX[idx].label} sur ce deck — l'effet se coupe au relâcher`;
      if (ui._padFxHeld === idx) p.classList.add('on');
    } else if (ui.padMode === 'smp') {
      const s = samplerBank[idx];
      p.textContent = s ? s.name.slice(0, 10) : '+ AJOUTER';
      if (s) p.classList.add('set');
      p.title = s
        ? `${s.name} — clic : jouer (re-clic : redémarre) · clic droit : retirer`
        : 'Pad vide — clic : choisir un fichier audio (les suivants remplissent les pads d\'après)';
    } else if (LOOP_BEATS[idx] == null) {
      // moitié gauche du mode LOOP : IN · OUT · ✕ (boucle manuelle rangée là)
      p.textContent = idx === 0 ? 'IN' : idx === 1 ? 'OUT' : '✕';
      p.title = idx === 0
        ? 'Poser le DÉBUT de boucle (calé sur le temps le plus proche)'
        : idx === 1
          ? 'Fermer la boucle au point actuel et la lancer'
          : 'Sortir de la boucle';
    } else {
      const b = LOOP_BEATS[idx] * (ui.jumpScale || 1);
      const label = b >= 1 ? String(b) : `1/${Math.round(1 / b)}`;
      p.textContent = label;
      p.title = `Boucle de ${label} temps — re-cliquer pour sortir, autre valeur pour redimensionner`;
    }
  });
}

// Play/Pause avec recalage SYNC : au LANCEMENT d'un deck synchronisé, on
// recale immédiatement ses traits rouges sur ceux du master (mesure sur
// mesure) — « quand je lance deux sons sync on doit bien caler les traits
// rouges sur traits rouges comparé au master directement »
function playDeck(d) {
  engine.resume();
  const deck = engine.decks[d];
  const wasPlaying = deck.playing;
  deck.togglePlay();
  if (!wasPlaying && deck.playing && deck.synced) engine.sync(d);
}

// Cale un temps sur le beat le plus proche de la grille (dynamique ou fixe)
function snapToBeat(deck, t) {
  if (deck.beats) {
    const s = gridTimeAtIndex(deck, Math.round(gridIndexFracAt(deck, t)));
    if (s != null) return Math.max(0, s);
  } else if (deck.bpm && deck.beatOffset != null) {
    const p = 60 / deck.bpm;
    return Math.max(0, deck.beatOffset + Math.round((t - deck.beatOffset) / p) * p);
  }
  return t;
}

// Boucle MANUELLE façon Rekordbox : IN pose le départ (calé sur le temps le
// plus proche), OUT ferme la boucle et l'active — ✕ / EXIT pour sortir
function loopIn(i) {
  const deck = engine.decks[i];
  if (!deck.buffer) return;
  deck._loopInPoint = snapToBeat(deck, deck.currentTime());
  flashStatus(`Deck ${i + 1} — LOOP IN posé à ${formatTime(deck._loopInPoint)} (OUT pour fermer)`);
}
function loopOut(i) {
  const deck = engine.decks[i];
  if (!deck.buffer) return;
  if (deck._loopInPoint == null) {
    flashStatus(`Deck ${i + 1} — pose d'abord le IN`);
    return;
  }
  const t = snapToBeat(deck, deck.currentTime());
  if (t <= deck._loopInPoint + 0.05) {
    flashStatus(`Deck ${i + 1} — le OUT doit être APRÈS le IN`);
    return;
  }
  deck.setLoop(deck._loopInPoint, t);
  deck._loopBeats = deck.bpm ? Math.round((t - deck._loopInPoint) / (60 / deck.bpm)) : 0;
  flashStatus(`Deck ${i + 1} — 🔁 boucle ${formatTime(deck._loopInPoint)} → ${formatTime(t)}`);
}

// Réglage du OUT au STICK GAUCHE (mode activé par re-appui sur OUT) :
// ▶ = le OUT saute au SEGMENT suivant de la grille (pas à pas) ·
// ◀ = réduction FINE et continue, petit à petit — pendant ce mode le stick
// ne décale plus le son (pas de jog), il ne touche qu'à la boucle
function gpLoopEditAdjust(d, v, dt) {
  const deck = engine.decks[d];
  const ui = deckUI[d];
  if (!deck.looping || !deck.bpm) return;
  const period = 60 / deck.bpm;
  const now = performance.now();
  if (v > 0) {
    // pas à pas : +1 segment toutes les ~280 ms tant qu'on pousse à droite
    if (now - (ui._loopEditLast || 0) < 280) return;
    ui._loopEditLast = now;
    let end = null;
    if (deck.beats) {
      const fe = gridIndexFracAt(deck, deck.loopEnd);
      end = gridTimeAtIndex(deck, Math.floor(fe + 1.0001));
    }
    if (end == null) end = deck.loopEnd + period;
    if (end > deck.duration) return;
    deck.setLoop(deck.loopStart, end);
    deck._loopBeats = Math.round((end - deck.loopStart) / period);
    flashStatus(`OUT ▶ +1 segment — boucle ${deck._loopBeats} temps`);
  } else if (v < 0) {
    // par CRANS de 100 ms — modifier la source audio à chaque frame la
    // faisait wrapper en rafale (le son « courait » à toute vitesse)
    if (now - (ui._loopEditLast || 0) < 100) return;
    ui._loopEditLast = now;
    const minLen = period / 8;
    const end = Math.max(deck.loopStart + minLen,
      deck.loopEnd - Math.abs(v) * 0.1 * period * 1.5);
    if (end >= deck.loopEnd) return;
    deck.setLoop(deck.loopStart, end);
    deck._loopBeats = Math.round(((end - deck.loopStart) / period) * 8) / 8;
    // le playhead est passé DERRIÈRE le nouveau OUT : UN retour propre dans
    // la boucle, pas une mitraillette de wraps
    const cur = deck.currentTime();
    if (cur > end) {
      const len = end - deck.loopStart;
      deck.seek(deck.loopStart + ((cur - deck.loopStart) % len));
    }
    if (now - (ui._loopEditFlash || 0) > 150) {
      ui._loopEditFlash = now;
      flashStatus(`OUT ◀ — boucle ${((end - deck.loopStart) / period).toFixed(2)} temps`);
    }
  }
}

// Petite PLATINE par deck (façon jog Rekordbox) : anneau bleu, sillons,
// marqueur qui tourne à 33 tr/min pendant la lecture — belle pour pas cher
function drawDeckWheel(ui, deck, t) {
  const cv = ui.wheelCv;
  if (!cv) return;
  const playing = deck.playing;
  // à l'arrêt : un seul dessin (signature), en lecture : chaque frame
  const sig = playing ? null : `stop:${deck.buffer ? 1 : 0}`;
  if (sig && ui._wheelSig === sig) return;
  ui._wheelSig = sig;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 96, 96);
  const c = 48;
  g.beginPath();
  g.arc(c, c, 44, 0, Math.PI * 2);
  g.lineWidth = 3;
  g.strokeStyle = '#2d7df1';
  g.globalAlpha = playing ? 0.95 : 0.3;
  g.stroke();
  g.globalAlpha = 1;
  g.beginPath();
  g.arc(c, c, 40, 0, Math.PI * 2);
  g.fillStyle = '#0a0b0e';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  for (let r = 14; r < 38; r += 6) {
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.stroke();
  }
  const ang = (t || 0) * 3.49; // ~33 tours/minute
  g.beginPath();
  g.moveTo(c + Math.cos(ang) * 12, c + Math.sin(ang) * 12);
  g.lineTo(c + Math.cos(ang) * 38, c + Math.sin(ang) * 38);
  g.lineWidth = 2.5;
  g.strokeStyle = playing ? '#2d7df1' : '#3a4258';
  g.stroke();
  g.beginPath();
  g.arc(c, c, 4, 0, Math.PI * 2);
  g.fillStyle = '#15171c';
  g.fill();
}

// Saut de N mesures (négatif = arrière). Boucle active = c'est elle qui bouge.
function doBeatJump(d, measures) {
  const deck = engine.decks[d];
  if (!deck.bpm || !deck.buffer) return;
  const cur = deck.currentTime();
  let jump;
  if (deck.beats) {
    const f = gridIndexFracAt(deck, cur);
    const target = gridTimeAtIndex(deck, f + measures * 4);
    jump = target != null ? target - cur : 0;
  } else {
    jump = measures * 4 * 60 / deck.bpm;
  }
  if (deck.looping) {
    const len = deck.loopEnd - deck.loopStart;
    let ns = deck.loopStart + jump;
    ns = Math.max(0, Math.min(deck.duration - len, ns));
    const delta = ns - deck.loopStart;
    if (delta === 0) return;
    deck.setLoop(ns, ns + len);
    deck.seek(Math.max(0, Math.min(deck.duration, cur + delta)));
  } else {
    deck.seek(cur + jump);
  }
}

// Pose (ou redimensionne) une boucle de N temps, calée sur la grille
function applyLoop(d, beats) {
  const deck = engine.decks[d];
  if (!deck.bpm || !deck.buffer) return;
  const period = 60 / deck.bpm;
  if (deck.looping) {
    let end;
    if (deck.beats) {
      const fs = gridIndexFracAt(deck, deck.loopStart);
      end = gridTimeAtIndex(deck, fs + beats);
    }
    deck.setLoop(deck.loopStart, end != null ? end : deck.loopStart + beats * period);
    deck._loopBeats = beats;
    return;
  }
  let start = deck.currentTime();
  let end = null;
  if (deck.beats) {
    const q = Math.round(gridIndexFracAt(deck, start) * 4) / 4;
    const s = gridTimeAtIndex(deck, q);
    if (s != null) start = Math.max(0, s);
    end = gridTimeAtIndex(deck, q + beats);
  } else if (deck.beatOffset != null) {
    const micro = period / 4;
    const k = Math.round((start - deck.beatOffset) / micro);
    start = Math.max(0, deck.beatOffset + k * micro);
  }
  deck.setLoop(start, end != null ? end : start + beats * period);
  deck._loopBeats = beats;
}

// modeArg : les MANETTES passent le mode DU JOUEUR (chacun garde sa config),
// la souris utilise l'onglet du deck. ownerGi : index du joueur — flash bref
// de SA couleur à l'appui, et MÉMORISÉ si l'action pose quelque chose
// (cue, loop) pour n'allumer QUE sa partie du bouton.
function padPress(i, idx, modeArg, ownerGi) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const modeEarly = modeArg || ui.padMode;
  if (modeEarly === 'smp') {
    // Le sampler ne dépend PAS du morceau chargé — il joue toujours
    samplerPress(i, idx);
    return;
  }
  if (modeEarly === 'fx') {
    // Source sans évènement de relâcher (téléphone…) : rafale courte d'un temps
    padFxPress(i, idx, true);
    setTimeout(() => padFxPress(i, idx, false), 400);
    return;
  }
  if (!deck.buffer) return;
  engine.resume();
  setActiveDeck(i);
  const mode = modeArg || ui.padMode;
  const ownerColor = ownerGi != null ? PLAYER_COLORS[ownerGi] : null;
  padFlash(i, idx, ownerColor || DECK_COLORS[i]);

  if (mode === 'key') {
    const kv = KEY_VALS[idx];
    const target = deck.keyShift === kv ? 0 : kv; // re-appuyer = retour à 0
    if (ui.applyKey) ui.applyKey(target - deck.keyShift);
    return;
  }
  if (mode === 'hotcue') {
    const c = deck.hotCues[idx];
    if (c == null) {
      // Le hot cue se cale toujours sur le début du segment (temps) le plus proche
      let t = deck.currentTime();
      if (deck.beats) {
        const snapped = gridTimeAtIndex(deck, Math.round(gridIndexFracAt(deck, t)));
        if (snapped != null) t = Math.max(0, snapped);
      } else if (deck.bpm && deck.beatOffset != null) {
        const period = 60 / deck.bpm;
        t = Math.max(0, deck.beatOffset + Math.round((t - deck.beatOffset) / period) * period);
      }
      deck.hotCues[idx] = t;
      if (ui.cueOwner) ui.cueOwner[idx] = ownerGi != null ? [ownerGi] : null; // QUI l'a posé
      if (deck.track) library.setHotCues(deck.track, deck.hotCues);
    } else {
      deck.seek(c);
      // Un joueur qui UTILISE le cue d'un autre le co-adopte : l'affichage
      // se partage entre les deux couleurs (moitié/moitié)
      if (ownerGi != null && ui.cueOwner) {
        const arr = gpOwnersOf(ui.cueOwner[idx]);
        if (!arr.includes(ownerGi)) arr.push(ownerGi);
        ui.cueOwner[idx] = arr;
      }
    }
  } else if (mode === 'jump') {
    if (!deck.bpm) return;
    // Saut en MESURES (4 temps), modulé par la force ½ / ×2.
    // Grille dynamique : le saut suit les VRAIS temps du morceau.
    const cur = deck.currentTime();
    let jump;
    if (deck.beats) {
      const f = gridIndexFracAt(deck, cur);
      const target = gridTimeAtIndex(deck, f + JUMP_VALS[idx] * (ui.jumpScale || 1) * 4);
      jump = target != null ? target - cur : 0;
    } else {
      jump = JUMP_VALS[idx] * (ui.jumpScale || 1) * 4 * 60 / deck.bpm;
    }
    if (deck.looping) {
      const len = deck.loopEnd - deck.loopStart;
      let ns = deck.loopStart + jump;
      ns = Math.max(0, Math.min(deck.duration - len, ns));
      const delta = ns - deck.loopStart;
      if (delta === 0) return;
      deck.setLoop(ns, ns + len);
      deck.seek(Math.max(0, Math.min(deck.duration, cur + delta)));
    } else {
      // même lecture d'horloge que le calcul du saut : atterrissage EXACT
      deck.seek(cur + jump);
    }
  } else {
    if (!deck.bpm) return;
    if (LOOP_BEATS[idx] == null) {
      // Moitié gauche du mode LOOP : IN (pad 1), OUT (pad 2), ✕ (le reste)
      if (idx === 0) {
        loopIn(i);
        return;
      }
      if (idx === 1) {
        if (deck.looping) {
          // OUT pendant la boucle : rappel — le stick gauche la règle déjà
          flashStatus(`Deck ${i + 1} — 🎛 stick gauche : ▶ +1 segment · ◀ réduire la boucle`);
        } else {
          loopOut(i);
          if (deck.looping) ui.loopOwner = ownerGi != null ? ownerGi : null;
        }
        return;
      }
      deck.exitLoop();
      ui.loopOwner = null;
      return;
    }
    const beats = LOOP_BEATS[idx] * (ui.jumpScale || 1);
    const period = 60 / deck.bpm;
    ui.loopOwner = ownerGi != null ? ownerGi : null; // QUI tient la boucle
    if (deck.looping && deck._loopBeats === beats) {
      deck.exitLoop();
      ui.loopOwner = null;
    } else if (deck.looping) {
      // Boucle déjà active : on la REDIMENSIONNE sans bouger son départ
      let end;
      if (deck.beats) {
        const fs = gridIndexFracAt(deck, deck.loopStart);
        end = gridTimeAtIndex(deck, fs + beats);
      }
      deck.setLoop(deck.loopStart, end != null ? end : deck.loopStart + beats * period);
      deck._loopBeats = beats;
    } else {
      let start = deck.currentTime();
      let end = null;
      // Départ TOUJOURS calé sur un segment/micro-segment ; sur grille
      // dynamique, la boucle suit les VRAIS temps (longueur exacte)
      if (deck.beats) {
        const q = Math.round(gridIndexFracAt(deck, start) * 4) / 4;
        const s = gridTimeAtIndex(deck, q);
        if (s != null) start = Math.max(0, s);
        end = gridTimeAtIndex(deck, q + beats);
      } else if (deck.beatOffset != null) {
        const micro = period / 4;
        const k = Math.round((start - deck.beatOffset) / micro);
        start = Math.max(0, deck.beatOffset + k * micro);
      }
      deck.setLoop(start, end != null ? end : start + beats * period);
      deck._loopBeats = beats;
    }
  }
}

// --- Stems : 3 boutons toujours visibles (VOX / DRM / INST, style Rekordbox).
// Premier clic = séparation IA puis coupe la partie choisie ; ensuite chaque
// bouton allume/éteint sa partie. INST regroupe basse + mélodies.
const STEM_GROUPS = { vocals: ['vocals'], drums: ['drums'], inst: ['bass', 'other'] };

function resetStemsCol(i) {
  const ui = deckUI[i];
  ui.stemBtns.forEach((b) => {
    b.classList.remove('on', 'ready', 'loading');
    b.disabled = false;
  });
  ui._stemState = null;
}

// Sépare (ou récupère du cache) et décode les stems du morceau du deck i,
// SANS les activer : ils sont juste prêts (deck.stems). Une seule séparation à la fois.
let stemBusy = false;

async function ensureStems(i, silent) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const track = deck.track;
  if (deck.stems) return true;
  if (!track || !track.path) {
    if (!silent) flashStatus('STEMS : charge d’abord un morceau sur ce deck');
    return false;
  }
  if (stemBusy) {
    if (!silent) flashStatus('STEMS : une séparation est déjà en cours, patiente…');
    return false;
  }
  stemBusy = true;
  ui.stemBtns.forEach((b) => b.classList.add('loading'));
  if (!silent) flashStatus('STEMS : séparation en cours — quelques minutes la première fois…');
  try {
    const res = await window.api.stemsSeparate(track.path);
    if (!res.ok) {
      if (!silent) flashStatus(`STEMS : ${res.error}`);
      return false;
    }
    const stems = {};
    for (const key of ['vocals', 'drums', 'bass', 'other']) {
      const raw = await window.api.readFile(res.stems[key]);
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      stems[key] = await engine.ctx.decodeAudioData(ab);
    }
    // Le morceau a pu changer pendant la séparation
    if (engine.decks[i].track !== track) return false;
    deck.stems = stems;
    ui.stemBtns.forEach((b) => b.classList.add('ready'));
    flashStatus(`Stems prêts sur le deck ${i + 1} — VOX / DRM / INST disponibles`);
    return true;
  } catch (err) {
    if (!silent) flashStatus(`STEMS : erreur — ${err.message || err}`);
    return false;
  } finally {
    stemBusy = false;
    ui.stemBtns.forEach((b) => b.classList.remove('loading'));
  }
}

// Préparation automatique en arrière-plan dès qu'un morceau est chargé
// (désactivable dans les paramètres)
// Auto-stems DIFFÉRÉ : Demucs est très gourmand — on ne le lance JAMAIS
// pendant qu'un son joue (sinon audio qui grésille + manette qui lag).
// Les demandes s'empilent et partent dès que le mix est au repos.
const stemAutoQueue = new Set();
let stemPumpTimer = null;
function pumpStemQueue() {
  if (stemPumpTimer) return;
  stemPumpTimer = setTimeout(() => {
    stemPumpTimer = null;
    if (!stemAutoQueue.size) return;
    const anyPlaying = engine.decks.some((dk) => dk.playing);
    if (anyPlaying || stemBusy) {
      pumpStemQueue(); // on repousse tant que ça joue
      return;
    }
    const i = [...stemAutoQueue][0];
    stemAutoQueue.delete(i);
    ensureStems(i, true);
    pumpStemQueue();
  }, 3000);
}
function autoPrepareStems(i) {
  if (localStorage.getItem('autoStems') === '0') return;
  stemAutoQueue.add(i);
  pumpStemQueue();
}

async function stemPress(i, group) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  engine.resume();
  const firstTime = !deck.stemsOn;
  if (!deck.stems && !(await ensureStems(i, false))) return;
  if (!deck.stemsOn) {
    deck.loadStems(deck.stems);
    ui._stemState = { vocals: true, drums: true, inst: true };
    ui.stemBtns.forEach((b) => b.classList.add('on'));
  }
  const state = ui._stemState;
  // Au premier clic, l'intention est de COUPER la partie cliquée
  state[group] = firstTime ? false : !state[group];
  const now = engine.ctx.currentTime;
  for (const key of STEM_GROUPS[group]) {
    deck.stemGains[key].gain.setTargetAtTime(state[group] ? 1 : 0, now, 0.01);
  }
  const btn = ui.stemBtns.find((b) => b.dataset.s === group);
  if (btn) btn.classList.toggle('on', state[group]);
}

function padClear(i, idx, modeArg) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const mode = modeArg || ui.padMode;
  if (mode === 'hotcue' && deck.hotCues[idx] != null) {
    deck.hotCues[idx] = null;
    if (ui.cueOwner) ui.cueOwner[idx] = null;
    if (deck.track) library.setHotCues(deck.track, deck.hotCues);
  }
  if (mode === 'smp' && samplerBank[idx]) {
    samplerBank[idx] = null;
    samplerSave();
    deckUI.forEach((_, d) => { if (deckUI[d].padMode === 'smp') renderPads(d); });
  }
}

// --- Effets « platine » : V.BRAKE (le disque freine jusqu'à l'arrêt) et
// BACKSPIN (il repart en arrière comme un rembobinage) — simulés avec le
// moteur de scrub (les mêmes grains sonores que le scratch au jog)
// EFFET SONORE SEULEMENT : le morceau « continue » virtuellement en dessous
// pendant le geste, et REPREND EXACTEMENT là où il serait rendu — le pad ne
// déplace jamais la position dans le mix (demande explicite de David)
function padSpinFx(i, idx, on, kind) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const label = kind === 'backspin' ? 'BACKSPIN' : 'V.BRAKE';
  if (on) {
    if (!deck.buffer || ui._spinFx) return;
    engine.resume();
    const wasPlaying = deck.playing;
    if (wasPlaying) deck.pause();
    deck.scrubStart();
    const s = {
      pos: deck.currentTime(),
      pos0: deck.currentTime(),
      start: performance.now(),
      vel: kind === 'backspin' ? -3 : (deck.tempo || 1),
      decel: kind === 'backspin' ? 2.4 : 1.6,
      t: performance.now(),
      wasPlaying,
      raf: 0
    };
    ui._spinFx = s;
    const step = () => {
      if (ui._spinFx !== s) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - s.t) / 1000);
      s.t = now;
      s.vel = s.vel > 0
        ? Math.max(0, s.vel - s.decel * dt)
        : Math.min(0, s.vel + s.decel * dt);
      s.pos = Math.max(0, s.pos + s.vel * dt);
      deck.scrubMove(s.pos);
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
    if (ui.pads[idx]) ui.pads[idx].classList.add('on');
    padFxChipShow(i, label);
  } else {
    const s = ui._spinFx;
    if (!s) return;
    ui._spinFx = null;
    cancelAnimationFrame(s.raf);
    deck.scrubEnd();
    if (s.wasPlaying) {
      // Reprise CALÉE : position d'origine + temps écoulé (comme si le
      // son n'avait jamais été touché) — c'était juste un effet sonore
      const elapsed = (performance.now() - s.start) / 1000;
      deck.seek(Math.min(deck.duration || s.pos0, s.pos0 + elapsed * (deck.tempo || 1)));
      deck.play();
    } else {
      deck.seek(Math.max(0, s.pos0));
    }
    if (ui.pads[idx]) ui.pads[idx].classList.remove('on');
    padFxChipShow(i, null);
  }
}

// Vignette bleue sur le deck : QUEL pad FX est en train de jouer
function padFxChipShow(i, label) {
  const chip = deckUI[i] && deckUI[i].padFxChip;
  if (!chip) return;
  if (label) {
    chip.textContent = `PAD FX · ${label}`;
    chip.classList.add('live');
  } else {
    chip.classList.remove('live');
  }
}

// --- PAD FX (maintenir = jouer, relâcher = couper) ---
// Chaque deck a sa PROPRE unité pad FX (engine.padFx), séparée des 4 unités
// du panneau : appuyer sur un pad ne touche à AUCUN réglage affiché — c'est
// un simple bouton momentané, pas un changement de config.
function padFxPress(i, idx, on) {
  const preset = PADFX[idx];
  if (!preset) return;
  if (preset.spin) {
    padSpinFx(i, idx, on, preset.spin);
    return;
  }
  const ui = deckUI[i];
  if (on) {
    if (ui._padFxHeld != null) return; // un seul pad FX à la fois par deck
    engine.resume();
    ui._padFxHeld = idx;
    engine.setPadFx(i, preset);
    if (ui.pads[idx]) ui.pads[idx].classList.add('on');
    padFxChipShow(i, preset.label);
  } else {
    if (ui._padFxHeld !== idx) return;
    ui._padFxHeld = null;
    engine.setPadFx(i, null);
    if (ui.pads[idx]) ui.pads[idx].classList.remove('on');
    padFxChipShow(i, null);
  }
}

// --- SAMPLER : un son par pad, banque PARTAGÉE par les 4 decks ---
// Pad vide : choisir un/des fichiers (ils remplissent les pads suivants).
// Pad plein : le joue immédiatement (re-appui = redémarre). Clic droit : retire.
// Les chemins sont mémorisés (localStorage) et rechargés au démarrage.
const samplerBank = Array(PAD_COUNT).fill(null); // { path, name, buffer }
let samplerGain = null;

function samplerSave() {
  try {
    localStorage.setItem('samplerBank', JSON.stringify(samplerBank.map((s) => (s ? s.path : null))));
  } catch { /* non bloquant */ }
}

async function samplerLoadSlot(idx, path) {
  try {
    const raw = await window.api.readFile(path);
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const buffer = await engine.ctx.decodeAudioData(ab);
    const name = String(path).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    samplerBank[idx] = { path, name, buffer };
    return true;
  } catch {
    samplerBank[idx] = null;
    return false;
  }
}

async function samplerInit() {
  let paths = null;
  try { paths = JSON.parse(localStorage.getItem('samplerBank')); } catch { /* rien */ }
  if (!Array.isArray(paths)) return;
  await Promise.all(paths.slice(0, PAD_COUNT).map((p, idx) => (p ? samplerLoadSlot(idx, p) : null)));
  samplerSave(); // purge les fichiers disparus
  deckUI.forEach((_, d) => { if (deckUI[d].padMode === 'smp') renderPads(d); });
}

async function samplerAssign(idx) {
  const paths = await window.api.pickSamples();
  if (!paths || !paths.length) return;
  let p = idx;
  for (const path of paths) {
    if (p >= PAD_COUNT) break;
    await samplerLoadSlot(p, path);
    p += 1;
  }
  samplerSave();
  deckUI.forEach((_, d) => { if (deckUI[d].padMode === 'smp') renderPads(d); });
}

function samplerPress(i, idx) {
  const slot = samplerBank[idx];
  if (!slot) {
    samplerAssign(idx);
    return;
  }
  engine.resume();
  if (!samplerGain) {
    samplerGain = engine.ctx.createGain();
    samplerGain.gain.value = 1;
    samplerGain.connect(engine.postBus);
  }
  if (slot._src) {
    try { slot._src.stop(); } catch { /* déjà fini */ }
  }
  const src = engine.ctx.createBufferSource();
  src.buffer = slot.buffer;
  src.connect(samplerGain);
  src.start();
  slot._src = src;
  padFlash(i, idx, DECK_COLORS[i]);
}

// Propriétaires d'un cue : normalise null / index seul / tableau d'index
function gpOwnersOf(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Couleur(s) d'un groupe de propriétaires : une couleur, ou un dégradé
// moitié/moitié quand deux joueurs partagent le même cue
function gpOwnersBg(owners, fallback) {
  if (!owners.length) return fallback;
  if (owners.length === 1) return PLAYER_COLORS[owners[0]];
  const n = owners.length;
  const stops = owners.map((gi, k) =>
    `${PLAYER_COLORS[gi]} ${(k / n) * 100}% ${((k + 1) / n) * 100}%`).join(', ');
  return `linear-gradient(90deg, ${stops})`;
}

// Tracks visées par un geste de knob : si la colonne fait partie de la
// SÉLECTION, tout le groupe bouge ensemble ; sinon la colonne seule
function gpGroupTargets(d) {
  return gpSelection.size && gpSelection.has(d) ? [...gpSelection] : [d];
}

// Applique un DELTA au knob de la rangée pour toutes les tracks du groupe
function gpGroupKnobAdjust(cur, dv) {
  const d = Math.min(cur.c, deckCount - 1);
  const k = GP_KNOBS[cur.r - 1];
  gpGroupTargets(d).forEach((t) => k.set(t, k.get(t) + dv));
}

// 🔊 BASCULE DES BASSES vers le deck d — même règle que le bouton logo sur
// LOW : ce deck récupère ses basses, TOUTES les autres sont coupées
// (une seule basse active à la fois). Silencieux : l'appelant flashe.
function gpBassTo(d) {
  const kkey = `low:${d}`;
  if (gpKillStore.has(kkey)) {
    engine.decks[d].setEq('low', gpKillStore.get(kkey));
    stripUI[d].kLow.update();
    gpKillStore.delete(kkey);
  }
  for (let o = 0; o < deckCount; o++) {
    if (o === d) continue;
    const ok = `low:${o}`;
    if (!gpKillStore.has(ok)) {
      gpKillStore.set(ok, engine.decks[o].eq.low);
      engine.decks[o].setEq('low', -1);
      stripUI[o].kLow.update();
    }
  }
}

// ↺ R1 en mode SÉLECTION : LE relâcheur de mix — filtres des sélectionnées
// à 0, leurs FX à 0 et éteints, volumes coupés restaurés, sélection vidée.
// BONUS : R1 posé sur un knob LOW = la bascule des basses vers CE deck est
// incluse dans le drop (comme le bouton logo) — tout en un seul geste.
function gpSelReset(fallbackDeck, cur) {
  if (!gpSelection.size) return;
  [...gpSelection].forEach((t) => {
    engine.setDeckColor(t, 0);
    stripUI[t].kFilt.update();
  });
  // dé-assigner les sélectionnées de TOUTES les unités (les unités sont
  // par JOUEUR) — sinon un FX fantôme survit au reset
  const units = new Set();
  [...gpSelection].forEach((t) => {
    for (let u = 0; u < 4; u++) {
      if (engine.fxAssign[u][t]) units.add(u);
      gpFxAssignSet(u, t, false);
    }
  });
  units.forEach((u) => {
    // une unité encore routée vers des decks HORS sélection reste intacte
    if (engine.fxAssign[u].some(Boolean)) return;
    engine.fx[u].setLevel(0);
    uiRefs.fxUnits[u].levelKnob.update();
    if (engine.fx[u].enabled) uiRefs.fxUnits[u].onBtn.click();
  });
  engine.updateFxSends();
  let bassTxt = '';
  if (cur && cur.r >= 1 && cur.r <= GP_KNOBS.length && cur.c !== GP_FX_COL &&
      GP_KNOBS[cur.r - 1].key === 'low') {
    const bd = Math.min(cur.c, deckCount - 1);
    gpBassTo(bd);
    bassTxt = ` · 🔊 basses → deck ${bd + 1}`;
  }
  if (gpCutStore.size) gpCutToggle(fallbackDeck);
  flashStatus(`↺ R1 — filtres à 0, FX coupés${bassTxt}, sélection vidée`);
  gpClearSelection();
}

// Vide la sélection (Rond) — les SEL s'éteignent partout
function gpClearSelection() {
  if (!gpSelection.size) return;
  gpSelOwners.forEach((s) => s.clear());
  gpSelNeutral.clear();
  gpSelection.clear();
  gpPaintSelection();
  flashStatus('Sélection vidée');
}

// Pose directement une assignation FX (et synchronise les boutons cachés)
function gpFxAssignSet(u, d, on) {
  engine.fxAssign[u][d] = on;
  const btn = uiRefs.fxUnits[u].assignEl.querySelectorAll('.fxu-assign-btn')[d];
  if (btn) btn.classList.toggle('on', on);
}

// ⚡ ENGAGER (R3 sur la ligne SELECT) : les tracks sélectionnées rejoignent
// le FX du joueur (SON unité personnelle), qui s'allume
function gpFxEngage(st) {
  const u = Math.min(st.player - 1, 3);
  const targets = gpSelection.size
    ? [...gpSelection]
    : [Math.min(st.cur.c, deckCount - 1)];
  targets.forEach((d) => gpFxAssignSet(u, d, true));
  engine.updateFxSends();
  if (!engine.fx[u].enabled) uiRefs.fxUnits[u].onBtn.click();
  flashStatus(`⚡ FX ${u + 1} activé sur deck ${targets.map((x) => x + 1).sort().join(' + ')}`);
}

// Colonne FX : L2/R2 = effet précédent / suivant
function gpFxTypeStep(u, dir) {
  const sel = uiRefs.fxUnits[u].typeSel;
  sel.selectedIndex = (sel.selectedIndex + dir + sel.options.length) % sel.options.length;
  sel.dispatchEvent(new Event('change'));
  flashStatus(`FX ${u + 1} — ${sel.options[sel.selectedIndex].textContent}`);
}

// Colonne FX : L2/R2 = durée ÷2 / ×2 (un cran dans la liste des durées)
function gpFxBeatsStep(u, dir) {
  const sel = uiRefs.fxUnits[u].beatsSel;
  const idx = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + dir));
  if (idx === sel.selectedIndex) return false; // déjà en butée
  sel.selectedIndex = idx;
  sel.dispatchEvent(new Event('change'));
  flashStatus(`FX ${u + 1} — durée ${sel.options[idx].textContent.trim()} temps`);
  return true;
}

// Retour lumineux des boutons BEAT ◄/► de la platine : flash net du bouton
// pressé à chaque cran — TRIPLE clignotement quand on est en butée
function midiBeatFlash(note, ok) {
  const set = (on) => {
    midi.setLed(4, note, on);
    midi.setLed(5, note, on);
  };
  if (ok) {
    set(true);
    setTimeout(() => set(false), 220);
  } else {
    let n = 0;
    const iv = setInterval(() => {
      set(n % 2 === 0);
      n += 1;
      if (n >= 6) {
        clearInterval(iv);
        set(false);
      }
    }, 90);
  }
}

// Durée du FX un cran plus long / plus court — dans la liste COMPLÈTE
// (1/4 … 1/2 … 3/4 … 32) : le 3/4 reste accessible, David y tient
function gpFxBeatsX2(u, dir) {
  const sel = uiRefs.fxUnits[u].beatsSel;
  const cur = Number(sel.value);
  const opts = [...sel.options].map((o) => Number(o.value));
  const next = dir > 0
    ? opts.find((v) => v > cur)
    : [...opts].reverse().find((v) => v < cur);
  if (next == null) return false; // déjà en butée (1/16 ou 16)
  sel.value = String(next);
  sel.dispatchEvent(new Event('change'));
  return true;
}

// Flash bref de la couleur du joueur sur le pad appuyé
function padFlash(i, idx, color) {
  const p = deckUI[i].pads[idx];
  if (!p) return;
  p.style.setProperty('--flash-color', color);
  p.classList.remove('pad-flash');
  void p.offsetWidth;
  p.classList.add('pad-flash');
}

function updateTempoLabel(i) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const pct = (deck.tempo - 1) * 100;
  ui.tempo.value = pct;
  if (deck.bpm) {
    // Échelle en BPM réels : bornes atteignables + valeur actuelle
    ui.tempoVal.textContent = (deck.bpm * deck.tempo).toFixed(1);
    ui.tempoMin.textContent = Math.round(deck.bpm * 0.5);
    ui.tempoMax.textContent = Math.round(deck.bpm * 1.5);
  } else {
    ui.tempoVal.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    ui.tempoMin.textContent = '--';
    ui.tempoMax.textContent = '--';
  }
}

function syncDeck(i) {
  engine.resume();
  if (engine.sync(i)) {
    updateTempoLabel(i);
    flashStatus(`Deck ${i + 1} calé sur le master`);
  } else {
    flashStatus(`SYNC impossible : il faut un autre deck en lecture avec un BPM connu`);
  }
}

function setActiveDeck(i) {
  activeDeck = ((i % deckCount) + deckCount) % deckCount;
  deckUI.forEach((ui, j) => {
    ui.el.classList.toggle('active', j === activeDeck);
    ui.wave.el.classList.toggle('active', j === activeDeck);
  });
  stripUI.forEach((s, j) => s.el.classList.toggle('active', j === activeDeck));
}

// ---------------------------------------------------------------------------
// Mixer (4 tranches + crossfader)
// ---------------------------------------------------------------------------

const stripUI = [];
let xfFader = null;
// Références UI pour la grille de contrôles manette (curseur 5×5)
const uiRefs = { master: {}, fxUnits: [] };
let masterMeterFill = null;
let masterMeterClip = null;
let masterMeterVal = 0;
let masterClipUntil = 0;

function buildMixer() {
  const mixer = document.getElementById('mixer');

  // Color FX : ce que contrôle le knob FILTER de chaque tranche
  const colorRow = document.createElement('div');
  colorRow.id = 'color-row';
  colorRow.innerHTML = `
    <span>COLOR</span>
    <select id="color-type" title="Effet contrôlé par le knob FILTER de chaque tranche">
      <option value="filter">Filter</option>
      <option value="dubecho">Dub Echo</option>
      <option value="hpfecho">HPF Echo</option>
      <option value="lpfecho">LPF Echo</option>
      <option value="bpfecho">BPF Echo</option>
      <option value="crushecho">Crush Echo</option>
      <option value="reverb">Space</option>
      <option value="noise">Noise</option>
      <option value="crush">Crush</option>
    </select>
    <button id="color-on" class="on" title="Active / désactive les filtres : quand c'est OFF, tourner un knob FILTER ne fait rien">ON</button>
  `;
  mixer.appendChild(colorRow);
  uiRefs.master.colorSel = colorRow.querySelector('#color-type');
  colorRow.querySelector('#color-type').addEventListener('change', (e) => {
    engine.setColorType(e.target.value);
    stripUI.forEach((_, i) => refreshStrip(i));
  });
  const colorOn = colorRow.querySelector('#color-on');
  colorOn.addEventListener('click', () => {
    engine.setColorEnabled(!engine.colorEnabled);
    colorOn.textContent = engine.colorEnabled ? 'ON' : 'OFF';
    colorOn.classList.toggle('on', engine.colorEnabled);
  });

  // Rangée MASTER : filtre global + volume du mix assemblé + VU-mètre master
  const masterRow = document.createElement('div');
  masterRow.id = 'master-row';
  const mfKnob = makeKnob('FILTER', () => engine.masterFilterVal, (v) => engine.setMasterFilter(v));
  mfKnob.el.classList.add('master-filter-knob');
  mfKnob.el.title = 'FILTER MASTER : filtre tout le mix (les 4 pistes en même temps)';
  uiRefs.master.filterKnob = mfKnob;
  const mvKnob = makeKnob('VOL', () => engine.masterVolume * 2 - 1, (v) => engine.setMasterVolume((v + 1) / 2));
  uiRefs.master.volKnob = mvKnob;
  mvKnob.el.classList.add('master-filter-knob');
  mvKnob.el.title = 'Volume MASTER : le niveau de tout le mix assemblé';
  const mLabel = document.createElement('span');
  mLabel.id = 'master-label';
  mLabel.textContent = 'MASTER';
  const mMeter = document.createElement('div');
  mMeter.id = 'master-meter';
  mMeter.title = 'Niveau du mix — rouge = saturation';
  mMeter.innerHTML = '<div id="master-meter-fill"></div><div id="master-meter-clip"></div>';
  // BPM MASTER : − / + décalent le tempo du master de 0,5 BPM — tous les
  // sons en SYNC suivent instantanément (il dirige tout le monde)
  const bpmWrap = document.createElement('span');
  bpmWrap.id = 'master-bpm';
  bpmWrap.title = 'BPM du MASTER : − / + le décalent de 0,5 — tous les sons en SYNC suivent';
  const bMinus = document.createElement('button');
  bMinus.textContent = '−';
  const bVal = document.createElement('b');
  bVal.id = 'master-bpm-val';
  bVal.textContent = '—';
  const bPlus = document.createElement('button');
  bPlus.textContent = '+';
  bMinus.addEventListener('click', () => masterBpmNudge(-1));
  bPlus.addEventListener('click', () => masterBpmNudge(1));
  bpmWrap.append(bMinus, bVal, bPlus);
  uiRefs.master.bpmVal = bVal;
  masterRow.append(mLabel, mfKnob.el, mvKnob.el, bpmWrap, mMeter);
  mixer.appendChild(masterRow);
  masterMeterFill = mMeter.querySelector('#master-meter-fill');
  masterMeterClip = mMeter.querySelector('#master-meter-clip');

  // Corps du mixer : les 4 tranches + le RACK FX à droite des knobs
  // (déplacé depuis le haut de l'écran, intégré à la matrice manette)
  const mixBody = document.createElement('div');
  mixBody.id = 'mix-body';
  mixer.appendChild(mixBody);
  const strips = document.createElement('div');
  strips.id = 'strips';
  mixBody.appendChild(strips);
  mixBody.appendChild(document.getElementById('fxbar'));

  for (let i = 0; i < 4; i++) {
    const deck = engine.decks[i];
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.dataset.deck = i;
    // Ordre CLUB des tranches du mixer : 3 1 2 4 de gauche à droite
    strip.style.order = [1, 2, 0, 3][i];
    strip.style.setProperty('--deck-color', DECK_COLORS[i]);

    const label = document.createElement('div');
    label.className = 'strip-label';
    label.textContent = i + 1;
    strip.appendChild(label);

    // Ligne SELECT : sélectionne la track (cut Triangle, ⚡ FX R3, ↺ Rond)
    const selBtn = document.createElement('button');
    selBtn.className = 'strip-sel';
    selBtn.textContent = 'SEL';
    selBtn.title = 'Sélectionner cette track (CUT Triangle · ⚡ FX R3 · ↺ reset Rond)';
    selBtn.addEventListener('click', () => gpSelectToggle(i));
    strip.appendChild(selBtn);

    const kTrim = makeKnob('TRIM', () => deck.trimVal, v => deck.setTrim(v));
    const kHigh = makeKnob('HI', () => deck.eq.high, v => deck.setEq('high', v));
    const kMid  = makeKnob('MID', () => deck.eq.mid, v => deck.setEq('mid', v));
    const kLow  = makeKnob('LOW', () => deck.eq.low, v => deck.setEq('low', v));
    const kFilt = makeKnob('FILTER', () => deck.filterVal, v => engine.setDeckColor(i, v));

    // VU-mètre vertical LE LONG des knobs (comme Serato) :
    // il monte dans le vert/jaune et vire au rouge si ça sature
    const body = document.createElement('div');
    body.className = 'strip-body';
    const knobCol = document.createElement('div');
    knobCol.className = 'knob-col';
    knobCol.append(kTrim.el, kHigh.el, kMid.el, kLow.el, kFilt.el);
    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.innerHTML = '<div class="meter-clip"></div><div class="meter-fill"></div>';
    body.append(knobCol, meter);
    strip.appendChild(body);

    const faderRow = document.createElement('div');
    faderRow.className = 'fader-row';
    const faderEl = document.createElement('div');
    faderEl.className = 'vfader';
    faderRow.append(faderEl);
    strip.appendChild(faderRow);
    const fader = makeVFader(faderEl, () => deck.volume, v => deck.setVolume(v));

    strip.addEventListener('pointerdown', () => setActiveDeck(i));
    strips.appendChild(strip);
    stripUI.push({
      el: strip, selBtn, kTrim, kHigh, kMid, kLow, kFilt, fader,
      meterFill: meter.querySelector('.meter-fill'),
      meterClip: meter.querySelector('.meter-clip'),
      meterVal: 0,
      clipUntil: 0
    });
  }

  const xfWrap = document.createElement('div');
  xfWrap.id = 'xf-wrap';
  xfWrap.innerHTML = `<span>A</span><div id="crossfader"></div><span>B</span>`;
  // Le crossfader RÉPARTIT LE SON entre les 4 tranches : il vit SOUS les
  // tranches, pas sous le rack FX (demande David)
  const stripsEl = document.getElementById('strips');
  (stripsEl || mixer).appendChild(xfWrap);
  xfFader = makeHFader(
    xfWrap.querySelector('#crossfader'),
    () => engine.crossfader,
    v => engine.setCrossfader(v)
  );
}

// Barre FX : 4 unités, une par deck (joueur), chacune avec son effet.
const FX_TYPE_OPTIONS = `
  <option value="delay">Delay</option>
  <option value="echo" selected>Echo</option>
  <option value="spiral">Spiral</option>
  <option value="mtdelay">MT Delay</option>
  <option value="upecho">Up Echo</option>
  <option value="downecho">Down Echo</option>
  <option value="lowcut">Low Cut Echo</option>
  <option value="pingpong">Ping Pong</option>
  <option value="reverb">Reverb</option>
  <option value="flanger">Flanger</option>
  <option value="phaser">Phaser</option>
  <option value="pan">Pan</option>
  <option value="trans">Trans</option>
  <option value="filter">Filter</option>
  <option value="roll">Roll</option>
  <option value="robot">Robot</option>
  <option value="helix">Helix</option>
  <option value="crush">Crush</option>
`;
// Plage CONVENTIONNELLE (demande David) : de 1/4 à 32 temps
const FX_BEATS_OPTIONS = `
  <option value="0.25">1/4</option>
  <option value="0.5" selected>1/2</option>
  <option value="0.75">3/4</option>
  <option value="1">1</option>
  <option value="2">2</option>
  <option value="4">4</option>
  <option value="8">8</option>
  <option value="16">16</option>
  <option value="32">32</option>
`;

function buildFxBar() {
  const bar = document.getElementById('fxbar');
  // UN SEUL panneau FX partagé par les 4 joueurs : des onglets 1 2 3 4
  // choisissent quelle unité est affichée dans le panneau (le reste est caché)
  const tabs = document.createElement('div');
  tabs.className = 'fx-tabs';
  uiRefs.fxTabs = [];
  for (let i = 0; i < 4; i++) {
    const t = document.createElement('button');
    t.className = 'fx-tab';
    t.textContent = i + 1;
    // (le % et la durée ne sont plus doublés ici : le knob NIVEAU montre
    // les 4 jauges et la cellule DURÉE les 4 valeurs — l'onglet reste
    // un simple bouton joueur avec sa barre de niveau)
    t.style.setProperty('--deck-color', PLAYER_COLORS[i]);
    t.addEventListener('click', () => gpShowFxUnit(i));
    tabs.appendChild(t);
    uiRefs.fxTabs.push(t);
  }
  bar.appendChild(tabs);
  // Les 4 unités FX restent en DOM (selects, knob, ON, assign) comme
  // "cerveau" mais sont CACHÉES : la vue est la matrice de cellules
  const stack = document.createElement('div');
  stack.className = 'fx-logic';
  bar.appendChild(stack);
  for (let i = 0; i < 4; i++) {
    const fx = engine.fx[i];
    const unit = document.createElement('div');
    unit.className = 'fx-unit';
    unit.dataset.deck = i;
    unit.style.setProperty('--deck-color', DECK_COLORS[i]);
    unit.innerHTML = `
      <span class="fx-num">${i + 1}</span>
      <select class="fxu-type" title="Effet du contrôleur ${i + 1}">${FX_TYPE_OPTIONS}</select>
      <select class="fxu-beats" title="Durée (en temps)">${FX_BEATS_OPTIONS}</select>
      <span class="fxu-assign" title="Sur quels decks cet effet s'applique"></span>
      <button class="fxu-on">OFF</button>
    `;
    const knob = makeKnob('', () => fx.level * 2 - 1, (v) => fx.setLevel((v + 1) / 2));
    unit.insertBefore(knob.el, unit.querySelector('.fxu-on'));

    // Assignation : ce contrôleur peut traiter le(s) deck(s) 1-4 au choix
    const assignEl = unit.querySelector('.fxu-assign');
    for (let d = 0; d < 4; d++) {
      const b = document.createElement('button');
      b.className = 'fxu-assign-btn' + (engine.fxAssign[i][d] ? ' on' : '');
      b.textContent = d + 1;
      b.style.setProperty('--adc', DECK_COLORS[d]);
      b.title = `Appliquer l'effet du contrôleur ${i + 1} au deck ${d + 1}`;
      b.addEventListener('click', () => {
        engine.fxAssign[i][d] = !engine.fxAssign[i][d];
        b.classList.toggle('on', engine.fxAssign[i][d]);
        engine.updateFxSends();
      });
      assignEl.appendChild(b);
    }

    unit.querySelector('.fxu-type').addEventListener('change', (e) => fx.setType(e.target.value));
    unit.querySelector('.fxu-beats').addEventListener('change', (e) => fx.setBeatsMult(Number(e.target.value)));
    const btnOn = unit.querySelector('.fxu-on');
    btnOn.addEventListener('click', () => {
      engine.resume();
      fx.setEnabled(!fx.enabled);
      btnOn.textContent = fx.enabled ? 'ON' : 'OFF';
      btnOn.classList.toggle('on', fx.enabled);
      engine.updateFxSends();
    });
    uiRefs.fxUnits[i] = {
      rootEl: unit,
      typeSel: unit.querySelector('.fxu-type'),
      beatsSel: unit.querySelector('.fxu-beats'),
      levelKnob: knob,
      onBtn: btnOn,
      assignEl: assignEl
    };
    stack.appendChild(unit);
  }
  // Vue MATRICE : une cellule-bouton par rangée (alignée sur les knobs)
  const cellsWrap = document.createElement('div');
  cellsWrap.className = 'fx-cells';
  const cells = {};
  GP_FX_ROWS.forEach((row) => {
    const c = document.createElement('div');
    c.className = `fx-cell fx-cell-${row.key}`;
    c.dataset.fx = row.key;
    c.innerHTML = `<b class="fx-cell-lbl">${row.label}</b><span class="fx-cell-val"></span>`;
    if (row.key === 'level') {
      // NIVEAU = un vrai knob (canvas ×2 pour la netteté) avec les jauges
      // des 4 joueurs — plus une simple case de texte
      const cv = document.createElement('canvas');
      cv.width = 96;
      cv.height = 96;
      cv.className = 'fx-lvl-cv';
      c.querySelector('.fx-cell-val').appendChild(cv);
      uiRefs.fxLvlCv = cv;
    }
    // Souris : type = effet suivant, on/off = bascule, durée = ×2,
    // niveau = +25 % (et reboucle à 0)
    c.addEventListener('click', () => {
      const u = gpFxShown;
      if (row.key === 'type') gpFxTypeStep(u, 1);
      else if (row.key === 'beats') gpFxBeatsStep(u, 1);
      else if (row.key === 'onoff') uiRefs.fxUnits[u].onBtn.click();
      else if (row.key === 'level') {
        const nv = engine.fx[u].level >= 0.99 ? 0 : Math.min(1, engine.fx[u].level + 0.25);
        engine.fx[u].setLevel(nv);
        uiRefs.fxUnits[u].levelKnob.update();
      }
    });
    cellsWrap.appendChild(c);
    cells[row.key] = c;
  });
  bar.appendChild(cellsWrap);
  uiRefs.fxPanel = { cells };

  // --- FX MASTER : bandeau dédié sous la matrice — le FX du MIX ENTIER
  // (position MASTER du channel select des platines). Indépendant des 4
  // unités joueurs : il vit sur le bus master.
  const MFX_TYPES = [...FX_TYPE_OPTIONS.matchAll(/value="([^"]+)"[^>]*>([^<]+)/g)]
    .map((mm) => [mm[1], mm[2].trim()]);
  const mWrap = document.createElement('div');
  mWrap.className = 'fx-master';
  mWrap.innerHTML = `
    <b class="fx-master-title">MASTER</b>
    <div class="fx-cell fxm-type" title="Effet du mix — clic : suivant"><b class="fx-cell-lbl">EFFET</b><span class="fx-cell-val">Echo</span></div>
    <div class="fx-cell fxm-beats" title="Durée — clic : ×2 (reboucle)"><b class="fx-cell-lbl">DURÉE</b><span class="fx-cell-val">1/2</span></div>
    <div class="fx-cell fxm-level" title="Niveau — clic : +25 %"><b class="fx-cell-lbl">NIVEAU</b><span class="fx-cell-val">0%</span></div>
    <div class="fx-cell fx-cell-onoff fxm-on" title="FX du MIX ENTIER on/off"><b class="fx-cell-lbl">MIX</b><span class="fx-cell-val fx-badge">OFF</span></div>
  `;
  const mfxEls = {
    type: mWrap.querySelector('.fxm-type .fx-cell-val'),
    beats: mWrap.querySelector('.fxm-beats .fx-cell-val'),
    level: mWrap.querySelector('.fxm-level .fx-cell-val'),
    on: mWrap.querySelector('.fxm-on .fx-cell-val')
  };
  uiRefs.masterFxEls = mfxEls;
  mWrap.querySelector('.fxm-type').addEventListener('click', () => {
    const u = engine.ensureMasterFx();
    const idx = Math.max(0, MFX_TYPES.findIndex(([v]) => v === u.type));
    u.setType(MFX_TYPES[(idx + 1) % MFX_TYPES.length][0]);
    updateMasterFxRow();
  });
  mWrap.querySelector('.fxm-beats').addEventListener('click', () => {
    if (!masterFxBeatsStep(1)) {
      engine.ensureMasterFx().setBeatsMult(MASTER_FX_BEATS[0]); // reboucle à 1/4
    }
    updateMasterFxRow();
  });
  mWrap.querySelector('.fxm-level').addEventListener('click', () => {
    const u = engine.ensureMasterFx();
    u.setLevel(u.level >= 0.99 ? 0 : Math.min(1, u.level + 0.25));
    updateMasterFxRow();
  });
  mWrap.querySelector('.fxm-on').addEventListener('click', () => {
    engine.resume();
    const u = engine.ensureMasterFx();
    u.setEnabled(!u.enabled);
    // Pas de niveau par défaut : c'est TOI qui joues la jauge (David)
    updateMasterFxRow();
    flashStatus(`FX MASTER ${u.enabled ? (u.level === 0 ? 'ACTIVÉ — monte la jauge' : 'ACTIVÉ') : 'coupé'} (tout le mix)`);
  });
  bar.appendChild(mWrap);
  uiRefs.masterFxTypes = MFX_TYPES;

  gpShowFxUnit(0); // au départ, le panneau montre l'unité 1
  updateFxPanel();
  updateMasterFxRow();
}

// Rafraîchit le bandeau FX MASTER (appelé à chaque frame, garde par signature)
let _mfxSig = '';
function updateMasterFxRow() {
  const els = uiRefs.masterFxEls;
  if (!els) return;
  const u = engine.masterFx;
  const sig = u
    ? `${u.type}|${u.beatsMult}|${Math.round(u.level * 100)}|${u.enabled ? 1 : 0}`
    : 'off';
  if (sig === _mfxSig) return;
  _mfxSig = sig;
  if (!u) {
    els.on.textContent = 'OFF';
    els.on.classList.remove('live');
    return;
  }
  const tt = (uiRefs.masterFxTypes || []).find(([v]) => v === u.type);
  els.type.textContent = tt ? tt[1] : u.type;
  els.beats.textContent = u.beatsMult >= 1 ? String(u.beatsMult) : `1/${Math.round(1 / u.beatsMult)}`;
  els.level.textContent = `${Math.round(u.level * 100)}%`;
  els.on.textContent = u.enabled ? 'ON' : 'OFF';
  els.on.classList.toggle('live', u.enabled);
}

// KNOB de niveau du rack FX : 4 jauges concentriques (une par joueur, sa
// couleur, pleine = 100 %) + le % de l'unité affichée au centre — on voit
// les niveaux des 4 joueurs d'un seul coup d'œil, comme sur un vrai knob
function drawFxLevelKnob() {
  const cv = uiRefs.fxLvlCv;
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
  g.clearRect(0, 0, W, H);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // ouverture de knob classique
  for (let i = 0; i < 4; i++) {
    const r = W / 2 - 6 - i * 9;
    if (r <= 5) break;
    g.lineWidth = 6;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, r, a0, a1);
    g.strokeStyle = i === gpFxShown ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
    g.stroke();
    const lv = engine.fx[i].level;
    if (lv > 0.004) {
      g.beginPath();
      g.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.min(1, lv));
      g.strokeStyle = gpUnitColor(i); // une jauge PAR JOUEUR, sa couleur
      g.globalAlpha = engine.fx[i].enabled ? 1 : 0.35;
      g.stroke();
      g.globalAlpha = 1;
    }
  }
  g.fillStyle = gpUnitColor(gpFxShown);
  g.font = '900 20px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(`${Math.round(engine.fx[gpFxShown].level * 100)}%`, cx, cy);
}

// Remplit les cellules FX depuis l'unité actuellement affichée (gpFxShown)
function updateFxPanel() {
  const p = uiRefs.fxPanel;
  if (!p) return;
  const u = gpFxShown;
  // FLUIDITÉ MANETTE : appelé chaque frame, mais si RIEN n'a changé on ne
  // touche pas au DOM — signature d'état, zéro écriture inutile
  let sig = `${u}`;
  for (let i = 0; i < 4; i++) {
    const r = uiRefs.fxUnits[i];
    sig += `|${Math.round(engine.fx[i].level * 100)}:${engine.fx[i].enabled ? 1 : 0}:${r.typeSel.selectedIndex}:${r.beatsSel.selectedIndex}:${gpSonsOf(i).join('')}`;
  }
  if (p._sig === sig) return;
  p._sig = sig;
  const col = gpUnitColor(u);
  // Bandeau « couleur des SONS » par joueur : dégradé des pistes que CE
  // joueur a sélectionnées (segments égaux, comme les boutons multi)
  const sonsGrad = [0, 1, 2, 3].map((i) => {
    const sons = gpSonsOf(i);
    return sons.length
      ? `linear-gradient(90deg, ${sons.map((t, k) =>
          `${DECK_COLORS[t]} ${(k / sons.length) * 100}% ${((k + 1) / sons.length) * 100}%`).join(', ')})`
      : 'transparent';
  });
  // Onglets = LES 4 JOUEURS (chacun sa couleur) : glow FX allumé, barre de
  // niveau, et le bandeau des sons qu'il a pris
  (uiRefs.fxTabs || []).forEach((b, i) => {
    b.classList.toggle('on', i === u);
    b.classList.toggle('fx-live', engine.fx[i].enabled);
    b.classList.toggle('mine', sonsGrad[i] !== 'transparent');
    b.style.setProperty('--lvl', `${Math.round(engine.fx[i].level * 100)}%`);
    b.style.setProperty('--deck-color', gpUnitColor(i));
    b.style.setProperty('--pc', gpUnitColor(i));
    b.style.setProperty('--sons', sonsGrad[i]);
  });
  // TABLEAU PAR JOUEUR : chaque rangée (EFFET / DURÉE / ON-OFF) montre les
  // 4 colonnes côte à côte — une PAR JOUEUR (sa couleur), avec en bandeau
  // la couleur des SONS qu'il a sélectionnés. Rien n'est partagé : chacun
  // voit SON réglage et ceux des autres, séparés.
  const badges = (key, textOf, clickStep) => {
    const wrap = p.cells[key].querySelector('.fx-cell-val');
    if (wrap.children.length !== 4) {
      wrap.textContent = '';
      for (let i = 0; i < 4; i++) {
        const s = document.createElement('i');
        s.className = 'fx-badge';
        s.addEventListener('click', (e) => { e.stopPropagation(); clickStep(i); });
        wrap.appendChild(s);
      }
    }
    [...wrap.children].forEach((s, i) => {
      const txt = textOf(i);
      if (s.textContent !== txt) s.textContent = txt;
      s.style.setProperty('--dc', gpUnitColor(i)); // gris au repos, couleur en jeu
      s.style.setProperty('--pc', gpUnitColor(i));
      s.style.setProperty('--sons', sonsGrad[i]);    // couleur de SES sons
      s.classList.toggle('sel', i === u);
      s.classList.toggle('live', engine.fx[i].enabled);
      s.classList.toggle('mine', sonsGrad[i] !== 'transparent');
    });
  };
  badges('type', (i) => {
    const ts = uiRefs.fxUnits[i].typeSel;
    return ts.options[ts.selectedIndex].textContent.trim().slice(0, 4);
  }, (i) => gpFxTypeStep(i, 1));
  badges('beats', (i) => {
    const bs = uiRefs.fxUnits[i].beatsSel;
    return bs.options[bs.selectedIndex].textContent.trim();
  }, (i) => gpFxBeatsStep(i, 1));
  badges('onoff', (i) => (engine.fx[i].enabled ? 'ON' : 'OFF'),
    (i) => uiRefs.fxUnits[i].onBtn.click());
  drawFxLevelKnob();
  // toutes les cellules prennent la couleur du deck de l'unité affichée
  for (const key of Object.keys(p.cells)) {
    p.cells[key].style.setProperty('--deck-color', col);
  }
}

function refreshStrip(i) {
  const s = stripUI[i];
  s.kTrim.update();
  s.kHigh.update();
  s.kMid.update();
  s.kLow.update();
  s.kFilt.update();
  s.fader.update();
}

// ---------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------

const libBody = document.getElementById('lib-body');
const libStatus = document.getElementById('lib-status');
let statusTimer = null;
let libLastMsg = ''; // dernier message DURABLE de la bibliothèque (analyse…)
const rowByTrack = new Map();

function flashStatus(msg) {
  libStatus.textContent = msg;
  clearTimeout(statusTimer);
  // au bout de 4 s on RESTAURE le dernier état bibliothèque (une analyse
  // en cours ne doit pas être effacée par un flash passager)
  statusTimer = setTimeout(() => {
    libStatus.textContent = libLastMsg || (library ? `${library.tracks.length} morceaux` : '');
  }, 4000);
}

const library = new Library(engine.ctx, {
  onListChanged: renderLibrary,
  onSelectionChanged: () => updateSelectionUI(),
  // L'analyse BPM n'a le droit de tourner QUE si aucun deck ne joue
  canAnalyze: () => !engine.decks.some((d) => d.playing),
  onTrackUpdated: (t) => {
    const row = rowByTrack.get(t);
    if (row) {
      if (t.preview && !row.children[1].firstChild) {
        row.children[1].innerHTML = `<img src="${t.preview}" alt="">`;
      }
      row.children[4].textContent = t.bpm ? t.bpm.toFixed(1) : '?';
      row.children[5].textContent = t.duration ? formatTime(t.duration) : '';
    }
  },
  onStatus: (msg) => { libLastMsg = msg; libStatus.textContent = msg; }
});

let libRenderStamp = 0; // bump à chaque rendu : les marques joueurs suivent
function renderLibrary() {
  libRenderStamp++;
  libBody.textContent = '';
  rowByTrack.clear();
  lastSelIdx = library.selection;
  // Bouton retour : visible quand on est dans une playlist SoundCloud — et,
  // en b2b (≥ 2 comptes), partout sauf sur la liste des comptes (il y a
  // toujours un niveau au-dessus : playlists du compte → liste des comptes)
  const backBtn = document.getElementById('btn-sc-back');
  if (backBtn) {
    const canScBack = library.mode === 'sc' && !library.scAccountsView &&
      ((library.scPlaylists && library.scPlaylists.length && library.scTracks !== library.scPlaylists) ||
       (library.scAccountCount || 0) >= 2);
    backBtn.classList.toggle('hidden', !canScBack);
  }
  // Boutons playlists : retour + jouer visibles quand une playlist est ouverte
  const plBackBtn = document.getElementById('btn-pl-back');
  const plPlayBtn = document.getElementById('btn-pl-play');
  if (plBackBtn) {
    const inside = library.mode === 'pl' && !!library.plOpen;
    plBackBtn.classList.toggle('hidden', !inside);
    plPlayBtn.classList.toggle('hidden', !inside);
  }
  const list = library.filtered.slice(0, 3000);
  const inPlaylist = library.mode === 'pl' && library.plOpen;
  list.forEach((t, idx) => {
    const tr = document.createElement('tr');
    if (idx === library.selection) tr.className = 'selected';
    // « Artiste - Titre » découpé sur le premier tiret
    const sep = t.name.indexOf(' - ');
    const artist = sep > 0 ? t.name.slice(0, sep) : '';
    const title = sep > 0 ? t.name.slice(sep + 3) : t.name;
    const bpmCell = (t.scRootRow || t.plRootRow || t.scLikes || t.fsUpRow || t.scAccountRow)
      ? ''
      : t.fsRow
      ? 'dossier'
      : t.plRow
        ? `${t.count} titres`
        : t.scPlaylist
          ? `${t.trackCount} titres`
          : (t.bpm ? t.bpm.toFixed(1) : (t.analyzed ? '?' : '…'));
    tr.innerHTML = `
      <td class="col-num">${idx + 1}</td>
      <td class="col-prev">${t.preview ? `<img src="${t.preview}" alt="">` : (t.artwork ? `<img class="prev-art" src="${t.artwork.replace('-t500x500', '-large')}" alt="">` : '')}</td>
      <td></td>
      <td class="col-artist"></td>
      <td class="col-bpm">${bpmCell}</td>
      <td class="col-dur">${t.duration ? formatTime(t.duration) : ''}</td>
    `;
    const isNavRow = t.plRow || t.fsRow || t.scRootRow || t.plRootRow || t.scLikes || t.fsUpRow || t.scAccountRow;
    tr.children[2].textContent = isNavRow ? t.name : title;
    tr.children[3].textContent = isNavRow ? '' : artist;
    tr.addEventListener('click', () => {
      library.selection = idx;
      updateSelectionUI();
    });
    if (t.fsUpRow) {
      tr.addEventListener('dblclick', () => folderUp());
    } else if (t.scRootRow) {
      tr.addEventListener('dblclick', () => openSoundCloud());
    } else if (t.scLikes) {
      tr.addEventListener('dblclick', () => openScLikes(t.acctIdx));
    } else if (t.scAccountRow) {
      // Ligne compte SoundCloud (b2b) : entrer = SES playlists, clic droit =
      // retirer le compte de la liste
      tr.addEventListener('dblclick', () => openScAccount(t.acctIdx));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showScAccountMenu(e, t);
      });
    } else if (t.plRootRow) {
      tr.addEventListener('dblclick', () => openPlaylistsRoot());
    } else if (t.fsRow) {
      // Ligne de dossier : double-clic pour y ENTRER (l'encodeur aussi)
      tr.addEventListener('dblclick', () => enterFolder(t.path));
    } else if (t.plRow) {
      // Ligne de playlist : double-clic pour l'ouvrir, clic droit pour gérer
      tr.addEventListener('dblclick', () => openLocalPlaylist(t.pl));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPlaylistMenu(e, t.pl);
      });
    } else if (t.scPlaylist) {
      // Playlist SoundCloud : double-clic pour l'ouvrir (avec SON compte)
      tr.addEventListener('dblclick', () => openScPlaylist(t.permalink, t.acctIdx));
    } else {
      tr.draggable = true;
      tr.addEventListener('dragstart', (e) => {
        dragTrack = t;
        library.selection = idx;
        updateSelectionUI();
        e.dataTransfer.setData('text/plain', t.name);
        e.dataTransfer.effectAllowed = 'copy';
      });
      tr.addEventListener('dragend', () => { dragTrack = null; });
      tr.addEventListener('dblclick', () => loadSelectedToDeck(activeDeck));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTrackMenu(e, t, idx);
      });
      // Dans une playlist ouverte : on peut RÉORDONNER en déposant sur une ligne
      if (inPlaylist) {
        tr.addEventListener('dragover', (e) => {
          if (!dragTrack || !library.plOpen.tracks.includes(dragTrack)) return;
          e.preventDefault();
          e.stopPropagation();
          tr.classList.add('reorder-target');
        });
        tr.addEventListener('dragleave', () => tr.classList.remove('reorder-target'));
        tr.addEventListener('drop', (e) => {
          tr.classList.remove('reorder-target');
          const p = library.plOpen;
          if (!dragTrack || !p.tracks.includes(dragTrack)) return;
          e.preventDefault();
          e.stopPropagation();
          const from = p.tracks.indexOf(dragTrack);
          library.moveInPlaylist(p, from, idx);
          dragTrack = null;
        });
      }
    }
    libBody.appendChild(tr);
    rowByTrack.set(t, tr);
  });
  // La console téléphone reçoit la liste courante (noms + BPM) — elle peut
  // charger n'importe quel morceau sur n'importe quel deck à distance
  if (window.api.remoteLib) {
    window.api.remoteLib({
      stamp: libRenderStamp,
      title: library.mode === 'sc' ? (library.scTitle || 'SoundCloud') : 'Bibliothèque',
      items: library.filtered.slice(0, 400).map((t) => ({
        name: t.name,
        bpm: t.bpm ? Number(t.bpm.toFixed(1)) : null,
        // TOUTES les lignes de navigation sont marquées : le téléphone ne
        // doit jamais pouvoir « charger » un compte ou un dossier sur un deck
        pl: !!(t.scPlaylist || t.plRow || t.scAccountRow || t.scLikes ||
               t.scRootRow || t.plRootRow || t.fsRow || t.fsUpRow)
      }))
    });
  }
}

// Menu clic droit sur une PLAYLIST (renommer / supprimer)
function showPlaylistMenu(e, p) {
  ctxMenu.textContent = '';
  const addItem = (label, fn) => {
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); fn(); });
    ctxMenu.appendChild(d);
  };
  addItem('▶ Jouer sur le deck actif', () => {
    if (!p.tracks.length) return;
    const i = activeDeck;
    deckQueues[i] = p.tracks.slice(1).map(t => ({ ...t }));
    updateQueueUI(i);
    loadTrackToDeck(i, { ...p.tracks[0] }, true);
  });
  addItem('💾 Exporter sur clé USB (CDJ / tout matos)', async () => {
    if (!p.tracks.length) {
      flashStatus('Playlist vide — rien à exporter');
      return;
    }
    flashStatus(`Export de « ${p.name} » : préparation des fichiers…`);
    // Les pistes SoundCloud sans copie locale sont téléchargées d'abord
    for (const ref of p.tracks) {
      if (ref.sc && !ref.path) {
        flashStatus(`Téléchargement de « ${ref.name} »…`);
        await ensureLocalCopy(ref);
      }
    }
    const items = p.tracks.map(ref => library.exportData(ref));
    const res = await window.api.exportPlaylist(p.name, items);
    if (res.ok) {
      flashStatus(`💾 « ${p.name} » exportée : ${res.count} morceaux${res.skipped ? ` (${res.skipped} ignorés)` : ''} → ${res.dir}`);
    } else if (!res.canceled) {
      flashStatus(`Export : ${res.error}`);
    }
  });
  addItem('✏️ Renommer…', async () => {
    const name = await askText('Nouveau nom de la playlist', p.name);
    if (name) {
      p.name = name;
      library.savePlaylists();
      renderLibrary();
    }
  });
  addItem('🗑 Supprimer la playlist', () => library.deletePlaylist(p));
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 110)}px`;
  ctxMenu.classList.remove('hidden');
}

// Menu clic droit sur une ligne 👤 compte SoundCloud : retirer le compte
// (fin du b2b — les jetons du pote ne restent pas sur le PC)
function showScAccountMenu(e, t) {
  ctxMenu.textContent = '';
  const d = document.createElement('div');
  d.className = 'ctx-item';
  d.textContent = `🗑 Retirer ce compte (${String(t.name || '').replace(/^👤 /, '')})`;
  d.addEventListener('click', async () => {
    hideCtxMenu();
    const r = await window.api.scRemoveAccount(t.acctIdx);
    if (!r.ok) {
      flashStatus(`SoundCloud : ${r.error}`);
      return;
    }
    flashStatus('Compte SoundCloud retiré');
    // Les index de comptes ont bougé (splice) : les caches par compte de la
    // vue ne valent plus rien, et l'arbre doit repartir de zéro
    library.scPlaylistsByAcct = {};
    library.scPlaylists = null;
    await refreshScStatus();
    buildTree();
    openSoundCloud(); // re-dispatch : invite / playlists / liste des comptes
  });
  ctxMenu.appendChild(d);
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 50)}px`;
  ctxMenu.classList.remove('hidden');
}

let lastSelIdx = -1;
function updateSelectionUI() {
  const rows = libBody.children;
  if (lastSelIdx >= 0 && rows[lastSelIdx]) rows[lastSelIdx].classList.remove('selected');
  const sel = rows[library.selection];
  if (sel) {
    sel.classList.add('selected');
    const wrap = document.getElementById('lib-list-wrap');
    if (library.selection === 0) {
      // Tout en haut : scroll à zéro, sinon l'EN-TÊTE COLLANT recouvre la
      // première ligne (« je ne vois pas la première playlist »)
      wrap.scrollTop = 0;
    } else {
      sel.scrollIntoView({ block: 'nearest' });
      const headH = (wrap.querySelector('thead') || {}).offsetHeight || 0;
      const wr = wrap.getBoundingClientRect();
      const rr = sel.getBoundingClientRect();
      if (rr.top < wr.top + headH) wrap.scrollTop -= (wr.top + headH - rr.top);
    }
  }
  lastSelIdx = library.selection;
}

// Entrer dans un dossier du disque (explorateur, encodeur, double-clic) —
// l'ARBRE de gauche se déplie et se surligne pour montrer OÙ on est
function enterFolder(p) {
  setLibTab('local');
  library.cache.__folder = p;
  library.scan(p);
  treeReveal(p);
}

// Clé d'arbre d'une entrée SoundCloud : préfixée par le compte quand il y en
// a plusieurs — en mono-compte l'arbre garde ses clés historiques
function scTreeKey(idx, leaf) {
  return (library.scAccountCount || 0) >= 2 ? `sc:${idx}:${leaf}` : `sc:${leaf}`;
}

// Entrer dans SoundCloud — selon le nombre de comptes connectés : 0 = invite
// à se connecter ; 1 = direct SES playlists (comme avant) ; ≥ 2 (b2b) = la
// liste des comptes, chacun va chercher ses sons chez lui.
// Chaque destination surligne AUSSI sa ligne dans l'arbre de gauche — le
// « micro menu » dit toujours où on est, comme la barre latérale de VS Code
async function openSoundCloud() {
  setLibTab('sc');
  const s = await window.api.scStatus();
  const accounts = (s && s.accounts) || [];
  library.scAccountCount = accounts.length;
  if (!accounts.length) {
    flashStatus('Aucun compte SoundCloud — clique « Se connecter » dans la barre SoundCloud');
  } else if (accounts.length === 1) {
    library.loadScMine(0);
  } else {
    library.loadScAccounts();
  }
  treeRevealKey('sc:');
}
// Playlists d'UN compte précis (ligne 👤 double-cliquée, nœud d'arbre…)
function openScAccount(idx = 0) {
  setLibTab('sc');
  library.loadScMine(idx);
  treeRevealKey('sc:', `sc:acct:${idx}`);
}
function openScLikes(idx = 0) {
  setLibTab('sc');
  library.loadScLikes(idx);
  treeRevealKey('sc:', scTreeKey(idx, 'likes'));
}
function openScPlaylist(permalink, idx = 0) {
  setLibTab('sc');
  library.loadScUrl(permalink, idx);
  treeRevealKey('sc:', scTreeKey(idx, permalink));
}
function openPlaylistsRoot() {
  setLibTab('pl');
  library.closePlaylist();
  treeRevealKey('pl:');
}
function openLocalPlaylist(p) {
  setLibTab('pl');
  library.openPlaylist(p);
  treeRevealKey('pl:', `pl:${p.id}`);
}

// Remonter au dossier PARENT — arrivé tout en haut (racine de disque), on
// retombe sur la VUE RACINES (SoundCloud, Playlists, disques) : le point
// de départ de la balade
function folderUp() {
  if (library.rootsView) return false; // déjà tout en haut
  const cur = library.fsDir || library.cache.__folder;
  if (!cur) {
    library.showRoots();
    return true;
  }
  let parent = String(cur).replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\';
  if (!parent || parent === String(cur)) {
    library.showRoots();
    return true;
  }
  enterFolder(parent);
  return true;
}

async function loadSelectedToDeck(i) {
  const track = library.selectedTrack();
  if (!track) return;

  // Ligne « dossier » : on y entre au lieu de charger
  if (track.fsRow) {
    enterFolder(track.path);
    return;
  }
  // Ligne « playlist SoundCloud » : on ouvre la playlist au lieu de charger un deck
  if (track.scPlaylist) {
    library.loadScUrl(track.permalink, track.acctIdx);
    return;
  }
  // Ligne « compte SoundCloud » (b2b) : on entre dans SES playlists
  if (track.scAccountRow) {
    openScAccount(track.acctIdx);
    return;
  }
  // Ligne « playlist locale » : on l'ouvre
  if (track.plRow) {
    library.openPlaylist(track.pl);
    return;
  }
  loadTrackToDeck(i, track);
}

// Un son DÉJÀ EN LECTURE ailleurs est refusé : petite animation + message
function refuseLoad(i, dup) {
  flashStatus(`⛔ Ce son est déjà en lecture sur le deck ${dup + 1} !`);
  [deckUI[i].el, deckUI[dup].el].forEach((el2) => {
    if (!el2) return;
    el2.classList.remove('refused');
    void el2.offsetWidth;
    el2.classList.add('refused');
    setTimeout(() => el2.classList.remove('refused'), 550);
  });
}

// Envoie au serveur téléphone une version COMPACTE de la vague du deck
// (24 pts/s, 3 bandes quantifiées 0..255) — le téléphone la dessine comme
// le PC : couleurs par bande, traits de mesure, playhead qui défile
const remoteWaveStamp = [0, 0, 0, 0];
function remotePushWave(i) {
  const p = engine.decks[i].peaks;
  if (!p || !window.api.remoteWave) return;
  const rate = 24;
  const n = Math.max(1, Math.round(p.duration * rate));
  const pick = (arr) => {
    const out = new Array(n);
    for (let k = 0; k < n; k++) {
      const a = Math.floor((k / rate) * p.perSecond);
      const b = Math.min(arr.length, Math.max(a + 1, Math.floor(((k + 1) / rate) * p.perSecond)));
      let m = 0;
      for (let j = a; j < b; j++) if (arr[j] > m) m = arr[j];
      out[k] = Math.min(255, Math.round(m * 255));
    }
    return out;
  };
  remoteWaveStamp[i]++;
  window.api.remoteWave(i, {
    stamp: remoteWaveStamp[i],
    rate,
    duration: p.duration,
    low: pick(p.low),
    mid: pick(p.mid),
    high: pick(p.high)
  });
}

async function loadTrackToDeck(i, track, autoplay = false) {
  const ui = deckUI[i];
  if (!track || track.scPlaylist || ui.loading) return;
  // Refus si le MÊME son joue déjà sur un autre deck
  const dup = engine.decks.findIndex((dk, j) => j !== i && dk.playing && dk.track &&
    ((dk.track.path && track.path && dk.track.path === track.path) ||
     (dk.track.scId && track.scId && dk.track.scId === track.scId)));
  if (dup >= 0) {
    refuseLoad(i, dup);
    return;
  }

  engine.resume();
  ui.loading = true;
  ui.title.textContent = `Chargement : ${track.name}…`;
  try {
    const { buffer, bpm, beatOffset, beats, gridShift, barAnchor, hotCues } = await library.loadForDeck(track,
      (msg) => { ui.title.textContent = `${msg} ${track.name}`; });
    const peaks = await computeBandPeaks(buffer);
    // Les hot cues SAUVEGARDÉS reviennent à chaque chargement (comme
    // Rekordbox — demande David, revirement du « chargement vierge »)
    engine.decks[i].loadTrack({ buffer, bpm, peaks, track, beatOffset, hotCues: (hotCues || []).slice(), beats, gridShift, barAnchor });
    ui.cueOwner = Array(10).fill(null);
    ui.loopOwner = null;
    ui.title.textContent = track.name;
    ui.keyVal.textContent = '0';
    ui.keyVal.classList.remove('shifted');
    resetStemsCol(i);
    updateTempoLabel(i);
    remotePushWave(i); // la console téléphone reçoit la nouvelle vague
    // POCHETTE : tags du fichier (ou jaquette SoundCloud), en cache après
    // la première lecture — affichée dans l'en-tête du deck
    ui.cover.classList.add('hidden');
    ui._coverTrack = track;
    library.coverFor(track).then((url) => {
      if (ui._coverTrack !== track) return; // un autre son a été chargé depuis
      if (url) {
        ui.cover.src = url;
        ui.cover.classList.remove('hidden');
      }
    });
    flashStatus(`« ${track.name} » chargé sur le deck ${i + 1}`);
    library.addHistory(track);
    if (autoplay) engine.decks[i].play();
    autoPrepareStems(i); // les stems se préparent en arrière-plan
  } catch (err) {
    ui.title.textContent = '— erreur de chargement —';
    flashStatus(`Impossible de lire « ${track.name} » : ${err.message || err}`);
    console.error(err);
  }
  ui.loading = false;
}

// ---------------------------------------------------------------------------
// Manette
// ---------------------------------------------------------------------------

const padStatus = document.getElementById('pad-status');

// --- MATRICE DES KNOBS pour le curseur manette (spec David) ---
// Le curseur ne se déplace QUE sur cette matrice :
//   Rangée 0 (tout en haut) : MASTER — FILTER MASTER et VOL MASTER
//   Rangées 1-5 : TRIM / HI / MID / LOW / FILTER — une COLONNE PAR DECK
// Croix/A  = couper / réactiver le knob survolé. Les BASSES sont EXCLUSIVES :
//            réactiver la basse d'un deck coupe automatiquement celle des
//            autres (jamais deux basses en même temps, comme le mix manette).
// Triangle/Y = CUT : coupe d'un coup le volume des decks sélectionnés (L3),
//              ré-appuyer fait tout revenir d'un coup.
// L1/R1 = monter/descendre petit à petit ; stick gauche = jouer avec le knob.

const GP_MASTER = [
  { key: 'mfilter', label: 'FILTER MASTER', killVal: 0, speed: 1.2,
    el: () => uiRefs.master.filterKnob.el,
    get: () => engine.masterFilterVal,
    set: (v) => { engine.setMasterFilter(Math.max(-1, Math.min(1, v))); uiRefs.master.filterKnob.update(); } },
  { key: 'mvol', label: 'VOL MASTER', killVal: 0, speed: 0.7,
    el: () => uiRefs.master.volKnob.el,
    get: () => engine.masterVolume,
    set: (v) => { engine.setMasterVolume(v); uiRefs.master.volKnob.update(); } }
];

const GP_KNOBS = [
  { key: 'trim', label: 'TRIM', killVal: -1, speed: 1.2,
    el: (d) => stripUI[d].kTrim.el,
    get: (d) => engine.decks[d].trimVal,
    set: (d, v) => { engine.decks[d].setTrim(v); stripUI[d].kTrim.update(); } },
  { key: 'high', label: 'HI', killVal: -1, speed: 1.2,
    el: (d) => stripUI[d].kHigh.el,
    get: (d) => engine.decks[d].eq.high,
    set: (d, v) => { engine.decks[d].setEq('high', v); stripUI[d].kHigh.update(); } },
  { key: 'mid', label: 'MID', killVal: -1, speed: 1.2,
    el: (d) => stripUI[d].kMid.el,
    get: (d) => engine.decks[d].eq.mid,
    set: (d, v) => { engine.decks[d].setEq('mid', v); stripUI[d].kMid.update(); } },
  { key: 'low', label: 'LOW', killVal: -1, speed: 1.2, exclusive: true,
    el: (d) => stripUI[d].kLow.el,
    get: (d) => engine.decks[d].eq.low,
    set: (d, v) => { engine.decks[d].setEq('low', v); stripUI[d].kLow.update(); } },
  { key: 'filter', label: 'FILTER', killVal: 0, speed: 1.2,
    el: (d) => stripUI[d].kFilt.el,
    get: (d) => engine.decks[d].filterVal,
    set: (d, v) => { engine.setDeckColor(d, Math.max(-1, Math.min(1, v))); stripUI[d].kFilt.update(); } }
];
const GP_ROWS = 1 + GP_KNOBS.length; // 1 rangée master + 5 rangées de knobs
// Colonne FX (à droite des knobs) : UN SEUL panneau partagé par les 4
// joueurs max — il affiche l'unité FX du joueur qui s'en sert (gpFxShown)
const GP_FX_COL = 4;
let gpFxShown = 0; // unité FX actuellement affichée dans le panneau partagé
let gpFxFlashAt = 0; // throttle du % de niveau dans la barre de statut
function gpShowFxUnit(u) {
  gpFxShown = Math.max(0, Math.min(3, u));
  (uiRefs.fxTabs || []).forEach((b, i) => b.classList.toggle('on', i === gpFxShown));
  updateFxPanel();
}
const gpFxUnitOf = (cur) => (cur.c === GP_FX_COL
  ? gpFxShown
  : Math.min(cur.c, deckCount - 1));
// La colonne FX est une MATRICE de cellules « solo » alignées sur les
// rangées de knobs (une par rangée) — L2 ou R2 déclenchent la cellule
// (la rangée DECK a disparu : la sélection montre déjà où va l'effet)
const GP_FX_ROWS = [
  { key: 'type', label: 'EFFET' },   // rangée TRIM
  { key: 'beats', label: 'DURÉE' },  // rangée HI
  { key: 'level', label: 'NIVEAU' }, // rangée MID
  { key: 'onoff', label: 'ON/OFF' }  // rangées LOW + FILTER
];
const gpFxRowKey = (r) => GP_FX_ROWS[Math.min(Math.max(r - 1, 0), GP_FX_ROWS.length - 1)].key;

// Cellule survolée par un curseur (r, c) — normalise master/knob/FX
function gpCellAt(cur) {
  if (cur.r > 0 && cur.c === GP_FX_COL) {
    // Colonne FX : une CELLULE par rangée (EFFET / DURÉE / NIVEAU / ON-OFF).
    // Seule la rangée NIVEAU est un réglage continu (stick, L1/R1).
    const u = gpFxShown;
    const key = gpFxRowKey(cur.r);
    const el = () => (uiRefs.fxPanel ? uiRefs.fxPanel.cells[key] : null);
    if (key === 'level') {
      return {
        key: `fxlvl${u}`, deck: null, label: 'FX NIVEAU', killVal: 0, speed: 1.1,
        el, get: () => engine.fx[u].level,
        set: (v) => {
          engine.fx[u].setLevel(Math.max(0, Math.min(1, v)));
          uiRefs.fxUnits[u].levelKnob.update();
        },
        exclusive: false
      };
    }
    return {
      key: `fx_${key}`, deck: null, label: `FX ${key}`, killVal: 0, speed: 0,
      el, get: () => 0, set: () => {}, exclusive: false
    };
  }
  if (cur.r === 0) {
    // Rangée du haut PAR COLONNE : SELECT au-dessus de chaque tranche,
    // COLOR (le filtre à effets) sur la colonne FX. Partout sur cette
    // rangée : stick = FILTER MASTER, L1/R1 = VOL MASTER.
    const mfSet = (v) => {
      engine.setMasterFilter(Math.max(-1, Math.min(1, v)));
      uiRefs.master.filterKnob.update();
    };
    if (cur.c === GP_FX_COL) {
      return {
        key: 'color', deck: null, label: 'COLOR', killVal: 0, speed: 1.2,
        el: () => document.getElementById('color-row'),
        get: () => engine.masterFilterVal, set: mfSet, exclusive: false
      };
    }
    const d = Math.min(cur.c, deckCount - 1);
    return {
      key: `sel${d}`, deck: d, label: `SELECT ${d + 1}`, killVal: 0, speed: 1.2,
      el: () => stripUI[d].selBtn,
      get: () => engine.masterFilterVal, set: mfSet, exclusive: false
    };
  }
  const k = GP_KNOBS[cur.r - 1];
  const d = Math.min(cur.c, deckCount - 1);
  return {
    key: k.key, deck: d, label: `${k.label} · D${d + 1}`, killVal: k.killVal, speed: k.speed,
    el: () => k.el(d), get: () => k.get(d), set: (v) => k.set(d, v), exclusive: !!k.exclusive
  };
}

// Pitch bend jog en cours par deck (tempo/synced à restaurer au relâcher)
const gpBend = [null, null, null, null];
// Tempo de référence pour le jog : si le verrou sync avait une correction
// transitoire en cours, on repart du tempo de base PROPRE (pas du corrigé)
function gpBaseTempo(deck) {
  return deck.synced && deck._syncBase ? deck._syncBase : deck.tempo;
}

// ♩ BPM MASTER : pousse le tempo du deck master de ±0,5 BPM — et TOUS les
// decks synchronisés suivent instantanément (leur ratio _syncBase est mis
// à l'échelle, le verrou de phase garde les traits rouges collés)
function masterBpmNudge(dir) {
  engine.resume();
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const m = mi != null ? engine.decks[mi] : null;
  if (!m || !m.bpm) {
    flashStatus('♩ BPM master — lance d\'abord un son (le premier lancé dirige)');
    return;
  }
  const cur = m.bpm * m.tempo;
  const target = Math.max(40, Math.min(220, cur + dir * 0.5));
  const factor = target / cur;
  const nt = m.tempo * factor;
  m.setTempo(nt);
  if (m._syncBase) m._syncBase = nt;
  const followers = [];
  engine.decks.forEach((d, i) => {
    if (i === mi || !d.synced || !d.playing || !d._syncBase) return;
    d._syncBase *= factor;
    d.setTempo(d._syncBase);
    followers.push(i + 1);
  });
  flashStatus(`♩ BPM master → ${target.toFixed(1)}${followers.length ? ` — sync : deck ${followers.join(' + ')} suivent` : ''}`);
  updateMasterBpmVal();
}

function updateMasterBpmVal() {
  const el = uiRefs.master.bpmVal;
  if (!el) return;
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const m = mi != null ? engine.decks[mi] : null;
  const txt = m && m.bpm ? (m.bpm * m.tempo).toFixed(1) : '—';
  if (el.textContent !== txt) el.textContent = txt;
}

// --- Liste des effets FX affichée quand Carré est maintenu : on voit où on
// en est et l'effet défile petit à petit ---
let gpFxListEl = null;
function gpFxTypeList(d, op) {
  const sel = uiRefs.fxUnits[d].typeSel;
  if (op === 'hide') {
    if (gpFxListEl) gpFxListEl.remove();
    gpFxListEl = null;
    return;
  }
  if (op === 'next') {
    sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
    sel.dispatchEvent(new Event('change'));
  }
  if (!gpFxListEl) {
    gpFxListEl = document.createElement('div');
    gpFxListEl.className = 'fx-type-list';
    document.body.appendChild(gpFxListEl);
  }
  const r = sel.getBoundingClientRect();
  gpFxListEl.innerHTML = [...sel.options]
    .map((o, i) => `<div class="${i === sel.selectedIndex ? 'on' : ''}"></div>`)
    .join('');
  [...gpFxListEl.children].forEach((div, i) => { div.textContent = sel.options[i].textContent; });
  gpFxListEl.style.left = `${Math.max(4, r.left)}px`;
  gpFxListEl.style.top = `${r.bottom + 4}px`;
  const on = gpFxListEl.querySelector('.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

// --- Bouton logo : couper / réactiver le knob (avec basses exclusives) ---
const gpKillStore = new Map(); // "key:deck" -> valeur avant coupure

function gpKillKnob(cur, gi) {
  engine.resume();
  // Sur la ligne SELECT : le logo = même geste que X (sélection / COLOR on-off)
  if (cur.r === 0) {
    if (cur.c === GP_FX_COL) document.getElementById('color-on').click();
    else gpSelectToggle(Math.min(cur.c, deckCount - 1), gi);
    return;
  }
  const cell = gpCellAt(cur);
  const kkey = `${cell.key}:${cell.deck}`;
  if (cell.exclusive) {
    // LA règle des basses : une seule basse active à la fois
    if (gpKillStore.has(kkey)) {
      // réactiver ICI... et couper toutes les autres
      cell.set(gpKillStore.get(kkey));
      gpKillStore.delete(kkey);
      for (let o = 0; o < deckCount; o++) {
        if (o === cell.deck) continue;
        const ok = `low:${o}`;
        if (!gpKillStore.has(ok)) {
          gpKillStore.set(ok, engine.decks[o].eq.low);
          engine.decks[o].setEq('low', -1);
          stripUI[o].kLow.update();
        }
      }
      flashStatus(`🔊 Basses → deck ${cell.deck + 1} (les autres sont coupées)`);
    } else {
      gpKillStore.set(kkey, cell.get());
      cell.set(-1);
      flashStatus(`Basses coupées — deck ${cell.deck + 1}`);
    }
    return;
  }
  if (gpKillStore.has(kkey)) {
    cell.set(gpKillStore.get(kkey));
    gpKillStore.delete(kkey);
    flashStatus(`${cell.label} réactivé`);
  } else {
    gpKillStore.set(kkey, cell.get());
    cell.set(cell.killVal);
    flashStatus(`${cell.label} coupé`);
  }
}

// --- L3 : sélectionner des decks · Triangle/Y : CUT groupé ---
// CO-SÉLECTION : chaque joueur a SON ensemble de decks — plusieurs joueurs
// peuvent prendre LA MÊME track, leurs effets s'y COMBINENT (une unité FX
// par joueur, les sends du moteur s'additionnent).
const gpSelection = new Set(); // UNION de toutes les sélections (dérivée)
const gpSelOwners = [new Set(), new Set(), new Set(), new Set()]; // par joueur
const gpSelNeutral = new Set(); // sélection à la souris (sans joueur)
const gpCutStore = new Map();  // deck -> volume avant le cut

function gpSelSync() {
  gpSelection.clear();
  gpSelNeutral.forEach((t) => gpSelection.add(t));
  gpSelOwners.forEach((s) => s.forEach((t) => gpSelection.add(t)));
}

// Les joueurs qui ont sélectionné CE deck (pour les dégradés multi)
function gpSelOwnersOf(d) {
  const out = [];
  gpSelOwners.forEach((s, gi) => { if (s.has(d)) out.push(gi); });
  return out;
}

// Repeint les boutons SEL et le liseré des tranches : une couleur par
// joueur propriétaire — plusieurs joueurs = dégradé en segments (comme les
// pads partagés) ; souris = couleur du deck
function gpPaintSelection() {
  stripUI.forEach((s, i) => {
    const on = gpSelection.has(i);
    const owners = gpSelOwnersOf(i);
    const solid = owners.length ? PLAYER_COLORS[owners[0]] : DECK_COLORS[i];
    s.el.classList.toggle('gp-sel', on);
    s.el.style.setProperty('--psel', solid);
    // TOUTE la tranche se teinte de la couleur du joueur (deux joueurs =
    // deux bandes) : on voit de loin QUI a pris QUOI, pas un petit cadre
    s.el.style.background = on
      ? (owners.length > 1
          ? `linear-gradient(180deg, ${owners.map((g, k) =>
              `color-mix(in srgb, ${PLAYER_COLORS[g]} 16%, transparent) ${(k / owners.length) * 100}% ${((k + 1) / owners.length) * 100}%`).join(', ')})`
          : `color-mix(in srgb, ${solid} 14%, transparent)`)
      : '';
    if (s.selBtn) {
      s.selBtn.classList.toggle('on', on);
      s.selBtn.style.setProperty('--psel', solid);
      s.selBtn.style.background = on ? gpOwnersBg(owners, DECK_COLORS[i]) : '';
      const txt = on && owners.length
        ? `SEL·J${owners.map((g) => g + 1).join('+')}`
        : 'SEL';
      if (s.selBtn.textContent !== txt) s.selBtn.textContent = txt;
    }
  });
}

// Les tracks sélectionnées QUE CE JOUEUR contrôle : celles qu'il a
// sélectionnées lui-même + celles sans propriétaire (souris). VIDE si le
// joueur n'a aucune piste dans la sélection : ses boutons et sticks
// restent alors en mode NORMAL (pads JUMP/LOOP/CUE/KEY, knob survolé…)
// → sélectionner = mode FX, désélectionner = retour immédiat aux pads.
function gpSelFor(gi) {
  if (gi == null) return [...gpSelection];
  return [...new Set([...gpSelOwners[Math.min(gi, 3)], ...gpSelNeutral])];
}

// Les unités FX appartiennent aux JOUEURS : unité 1 = J1 … unité 4 = J4.
// SOBRE AU REPOS : gris neutre tant que le joueur n'a rien sélectionné —
// sa couleur n'apparaît que quand il est EN JEU (esthétique Rekordbox :
// la couleur n'existe que quand elle informe)
function gpUnitColor(u) {
  return gpSonsOf(u).length ? (PLAYER_COLORS[u] || '#5a6272') : '#5a6272';
}

// Les SONS que le joueur gi a sélectionnés lui-même (pour les bandeaux
// « couleur des sons » du rack — on voit qui a pris quelles pistes)
function gpSonsOf(gi) {
  return [...gpSelOwners[Math.min(gi, 3)]].sort();
}

function gpSelectToggle(d, gi) {
  // Chaque joueur ne touche qu'à SA sélection : prendre une track déjà
  // prise par un autre = CO-SÉLECTION (les deux effets se combinent),
  // jamais un vol de sélection.
  const set = gi != null ? gpSelOwners[Math.min(gi, 3)] : gpSelNeutral;
  const selecting = !set.has(d);
  // Les unités FX sont PAR JOUEUR (unité 1 = J1 … unité 4 = J4) : chacun a
  // SON effet, SA durée, SON niveau — appliqués aux sons QU'IL sélectionne.
  const u = gi != null ? Math.min(gi, 3) : Math.min(d, 3);
  if (selecting) {
    set.add(d);
    gpFxAssignSet(u, d, true);
    engine.updateFxSends();
    if (!engine.fx[u].enabled) uiRefs.fxUnits[u].onBtn.click();
    const colorOn = document.getElementById('color-on');
    if (colorOn && !colorOn.classList.contains('on')) colorOn.click();
    // armer le filtre = COLOR ON **sur Filter** (le stick gauche doit
    // filtrer, pas envoyer un écho — le FX c'est le stick droit)
    const csel = uiRefs.master.colorSel;
    if (csel && csel.value !== 'filter') {
      csel.value = 'filter';
      csel.dispatchEvent(new Event('change'));
    }
  } else {
    set.delete(d);
    // la piste ne quitte que l'unité DE CE JOUEUR — si un autre joueur
    // l'a aussi sélectionnée, SON effet continue tranquillement.
    // (désélection SOURIS : l'unité min(d,3) appartient au joueur min(d,3)+1
    // — s'il a lui-même pris cette track, on ne touche pas à son routage)
    if (!(gi == null && gpSelOwners[u].has(d))) {
      gpFxAssignSet(u, d, false);
      if (engine.fx[u].enabled && !engine.fxAssign[u].some(Boolean)) {
        uiRefs.fxUnits[u].onBtn.click();
      }
    }
    engine.updateFxSends();
  }
  gpSelSync();
  gpPaintSelection();
  const mine = gi != null ? gpSonsOf(gi) : [...gpSelNeutral].sort();
  flashStatus(gpSelection.size
    ? `${gi != null ? `🎮 J${gi + 1} — ` : ''}sélection : deck ${mine.map((x) => x + 1).join(' + ') || '—'} (union : ${[...gpSelection].sort().map((x) => x + 1).join('+')}) — sticks · R1 = ↺`
    : 'Sélection vidée');
}

function gpCutToggle(fallbackDeck) {
  engine.resume();
  if (gpCutStore.size) {
    // tout revient d'un coup — l'effet « cut » du mix manette
    for (const [d, v] of gpCutStore) {
      engine.decks[d].setVolume(v);
      stripUI[d].fader.update();
    }
    gpCutStore.clear();
    flashStatus('CUT relâché — les sons reviennent');
    return;
  }
  const targets = gpSelection.size ? [...gpSelection] : [fallbackDeck];
  for (const d of targets) {
    gpCutStore.set(d, engine.decks[d].volume);
    engine.decks[d].setVolume(0);
    stripUI[d].fader.update();
  }
  flashStatus(`CUT ! deck ${targets.sort().map(x => x + 1).join(' + ')} coupé${targets.length > 1 ? 's' : ''}`);
}

// Curseurs visibles (un par joueur, couleur du deck contrôlé) avec les
// étiquettes L/R qui montrent ce que L2/R2 vont faire sur cette rangée
const gpCursorEls = [];
const gpSideCursorEls = []; // cadres L2/R2 posés sur les VRAIS pads visés
const gpPrevEls = [];       // prévisualisation jump/loop sur la vague
function ensureGpCursors() {
  for (let i = 0; i < 4; i++) {
    const c = document.createElement('div');
    c.className = 'gp-cursor hidden';
    c.innerHTML = '<span class="gp-cursor-tag"></span><span class="gp-side gp-side-l"></span><span class="gp-side gp-side-r"></span>';
    document.body.appendChild(c);
    gpCursorEls.push(c);
    const mk = (label) => {
      const s = document.createElement('div');
      s.className = 'gp-cursor gp-target hidden';
      s.innerHTML = `<span class="gp-cursor-tag">${label}</span>`;
      document.body.appendChild(s);
      return s;
    };
    gpSideCursorEls.push({ l: mk('L2'), r: mk('R2') });
    // Prévisualisation sur la forme d'onde : 2 traits (destinations du
    // jump arrière/avant) + 1 bande (étendue de la boucle qui serait posée)
    const mkPrev = (cls) => {
      const s = document.createElement('div');
      s.className = `gp-preview ${cls} hidden`;
      document.body.appendChild(s);
      return s;
    };
    gpPrevEls.push({ l: mkPrev('gp-prev-line'), r: mkPrev('gp-prev-line'), band: mkPrev('gp-prev-band') });
  }
}
ensureGpCursors();

// Repères sur les KNOBS de la matrice : chaque rangée correspond à sa paire
// de cues (L2 = gauche, R2 = droite). La LETTRE du cue s'affiche du bon
// côté du knob, colorée à la couleur du joueur qui l'a posé (sinon deck).
// Et quand une BOUCLE de la taille de la rangée tourne : anneau animé
// autour du knob, couleur du joueur qui tient la boucle.
const gpKnobMarks = new Map(); // "deck:rangée" -> { l, r, ring }
function gpUpdateKnobMarks() {
  for (let d = 0; d < 4; d++) {
    const deck = engine.decks[d];
    const ui = deckUI[d];
    for (let r2 = 1; r2 <= GP_KNOBS.length; r2++) {
      const key = `${d}:${r2}`;
      let mk = gpKnobMarks.get(key);
      if (!mk) {
        const host = GP_KNOBS[r2 - 1].el(d);
        if (!host) continue;
        // ancrage garanti : le wrapper du knob devient le référentiel
        host.style.position = 'relative';
        const el2 = (cls, tag) => {
          const s2 = document.createElement(tag || 'span');
          s2.className = cls;
          host.appendChild(s2);
          return s2;
        };
        mk = {
          l: el2('cue-tag cue-tag-l'),
          r: el2('cue-tag cue-tag-r'),
          ring: el2('loop-ring', 'div')
        };
        gpKnobMarks.set(key, mk);
      }
      const letter = (el2, idx) => {
        const set = deck.hotCues && deck.hotCues[idx] != null;
        el2.style.display = set ? '' : 'none';
        if (set) {
          const owners = gpOwnersOf(ui.cueOwner ? ui.cueOwner[idx] : null);
          el2.textContent = String.fromCharCode(65 + idx);
          // deux joueurs sur le même cue = étiquette moitié/moitié ;
          // cue sans propriétaire (cache/souris) = NEUTRE gris
          el2.style.background = gpOwnersBg(owners, '#8a94ae');
          const glow = owners.length === 1 ? PLAYER_COLORS[owners[0]]
            : owners.length ? '#ffffff' : '#8a94ae';
          el2.style.boxShadow = `0 0 7px ${glow}`;
        }
      };
      letter(mk.l, r2 - 1);   // cue de L2 sur cette rangée
      letter(mk.r, 10 - r2);  // cue de R2
      // Animation de LOOP sur le knob de la rangée dont la boucle tourne
      const loopOn = deck.looping &&
        deck._loopBeats === LOOP_ROW_BEATS[r2 - 1] * (ui.jumpScale || 1);
      mk.ring.style.display = loopOn ? '' : 'none';
      if (loopOn) {
        const c = ui.loopOwner != null ? PLAYER_COLORS[gpOwnersOf(ui.loopOwner)[0]] : '#5fe08a';
        mk.ring.style.color = c;
        mk.ring.style.borderColor = c;
        // deck en lecture = l'anneau TOURNE · en pause = statique (préparée)
        mk.ring.classList.toggle('prepared', !deck.playing);
      }
    }
  }
}

// Sélections bibliothèque de TOUS les joueurs affichées EN MÊME TEMPS :
// - barre pleine = la ligne où le joueur navigue en ce moment
// - barre + badge J1/J2 = le son que ce joueur a CHARGÉ (marqueur PERMANENT,
//   il reste même quand on quitte la navigation — « qui a affiché quoi »)
const gpLoadedTrack = [null, null, null, null]; // dernier son chargé par joueur
let gpNavMarkedRows = [];
let gpModeBtnSig = ''; // garde : onglets de mode repeints au changement seul
let gpNavMarkSig = '';
function gpUpdateNavMarks() {
  // FLUIDITÉ : ne refait le marquage (retrait/ajout de badges DOM) que si
  // quelque chose a bougé — pas 60 fois par seconde pour rien
  const sig = gpLoadedTrack.map((t) => (t ? library.filtered.indexOf(t) : -1)).join(',')
    + '#' + [...gamepad.pads.entries()].map(([gi, st]) => `${gi}:${st.navSel}`).join('|')
    + '#' + libRenderStamp;
  if (sig === gpNavMarkSig) return;
  gpNavMarkSig = sig;
  gpNavMarkedRows.forEach((row) => {
    row.classList.remove('psel');
    row.style.boxShadow = '';
    const b = row.querySelector('.psel-badge');
    if (b) b.remove();
  });
  gpNavMarkedRows = [];
  const mark = (row, c, badge) => {
    if (!row) return;
    row.style.boxShadow = row.style.boxShadow
      ? `${row.style.boxShadow}, inset -4px 0 0 ${c}` // 2e joueur : barre droite
      : `inset 4px 0 0 ${c}, inset 0 0 16px ${c}2e`;
    row.classList.add('psel');
    if (badge && !row.querySelector(`.psel-badge[data-gi="${badge.gi}"]`)) {
      const s2 = document.createElement('span');
      s2.className = 'psel-badge';
      s2.dataset.gi = badge.gi;
      s2.textContent = `J${badge.gi + 1}`;
      s2.style.background = c;
      const cell = row.children[2] || row;
      cell.appendChild(s2);
    }
    gpNavMarkedRows.push(row);
  };
  // Sons CHARGÉS (permanent, suit le morceau même si la liste bouge)
  gpLoadedTrack.forEach((t, gi) => {
    if (!t) return;
    const idx = library.filtered.indexOf(t);
    if (idx < 0) return;
    mark(libBody.children[idx], PLAYER_COLORS[gi], { gi });
  });
  // Curseurs de navigation (pendant qu'on se balade)
  for (const [gi, st] of gamepad.pads.entries()) {
    if (st.navSel == null) continue;
    mark(libBody.children[st.navSel], PLAYER_COLORS[gi] || '#fff', null);
  }
}

// Étiquette de l'action que fera L2/R2 pour CE joueur (selon SON mode)
function gpSideLabel(st, side) {
  const idx = padForSide(st.cur.r, side);
  const p = side > 0 ? 'R2' : 'L2';
  if (st.cur.r === 0 && st.cur.c !== GP_FX_COL) {
    return side > 0 ? `${p} ♩+` : `${p} ♩−`; // BPM master sur la rangée haute
  }
  if (st.cur.c === GP_FX_COL) {
    const k = gpFxRowKey(st.cur.r);
    const pp = side > 0 ? 'R2' : 'L2';
    if (k === 'type') return side > 0 ? `${pp} ▶` : `${pp} ◀`;
    if (k === 'beats') return side > 0 ? `${pp} ×2` : `${pp} ÷2`;
    if (k === 'level') return side > 0 ? `${pp} +` : `${pp} −`;
    if (k === 'onoff') return `${pp} ⏻`;
    return `${pp} deck`;
  }
  if (st.mode === 'hotcue') return `${p}·${String.fromCharCode(65 + idx)}`;
  if (st.mode === 'jump') return `${p} ${formatMeasures(side * JUMP_ROW_MEASURES[st.cur.r - 1])}`;
  if (st.mode === 'key') {
    const kv = KEY_VALS[idx];
    return `${p} ${kv > 0 ? '+' : ''}${kv}♪`;
  }
  if (st.mode === 'fx') return `${p} ${PADFX[idx] ? PADFX[idx].label : 'FX'}`;
  if (st.mode === 'smp') {
    const s = samplerBank[idx];
    return `${p} ${s ? s.name.slice(0, 7) : '+'}`;
  }
  const li = st.cur.r - 1; // pad gauche de la rangée : IN / OUT / ✕
  return side > 0
    ? `${p} 🔁${LOOP_ROW_BEATS[st.cur.r - 1]}`
    : `${p} ${li === 0 ? 'IN' : li === 1 ? 'OUT' : '✕'}`;
}

// Prévisualisation sur la vague zoomée : où atterrit le jump / quelle zone
// couvrira la boucle, dessiné dans la couleur du joueur
function gpUpdatePreview(gi, st) {
  const prev = gpPrevEls[gi];
  const hideAll = () => {
    prev.l.classList.add('hidden');
    prev.r.classList.add('hidden');
    prev.band.classList.add('hidden');
  };
  if (!prev) return;
  if (st == null || st.cur.r < 1 || st.cur.r > GP_KNOBS.length ||
      st.cur.c === GP_FX_COL ||
      (st.mode !== 'jump' && st.mode !== 'loop')) {
    hideAll();
    return;
  }
  const d = Math.min(st.cur.c, deckCount - 1);
  const deck = engine.decks[d];
  if (!deck.buffer || !deck.bpm) {
    hideAll();
    return;
  }
  const canvas = deckUI[d].wave.canvas;
  const r = canvas.getBoundingClientRect();
  if (!r.width) {
    hideAll();
    return;
  }
  const col = PLAYER_COLORS[gi];
  const tNow = deck.currentTime();
  const win = waveWindowSec * (deck.tempo || 1);
  const xOf = (t) => r.left + r.width / 2 + ((t - tNow) / win) * r.width;
  const size = st.mode === 'jump'
    ? JUMP_ROW_MEASURES[st.cur.r - 1] * 4 // mesures → temps
    : LOOP_ROW_BEATS[st.cur.r - 1];
  const f = deck.beats ? gridIndexFracAt(deck, tNow) : null;
  const gridT = (beatsAway) => {
    if (deck.beats) {
      const t = gridTimeAtIndex(deck, f + beatsAway);
      return t != null ? t : tNow + beatsAway * 60 / deck.bpm;
    }
    return tNow + beatsAway * 60 / deck.bpm;
  };
  const placeLine = (el, t) => {
    const x = xOf(t);
    if (x < r.left || x > r.right) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.style.left = `${x - 1}px`;
    el.style.top = `${r.top}px`;
    el.style.height = `${r.height}px`;
    el.style.background = col;
    el.style.boxShadow = `0 0 6px ${col}`;
  };
  if (st.mode === 'jump') {
    // destinations du saut (size déjà converti en temps)
    placeLine(prev.l, gridT(-size));
    placeLine(prev.r, gridT(size));
    prev.band.classList.add('hidden');
    return;
  }
  // LOOP : zone que couvrirait la boucle posée maintenant (départ calé)
  prev.l.classList.add('hidden');
  prev.r.classList.add('hidden');
  let s;
  let e;
  if (deck.beats) {
    const fs = deck.looping ? gridIndexFracAt(deck, deck.loopStart) : Math.round(f);
    s = gridTimeAtIndex(deck, fs);
    e = gridTimeAtIndex(deck, fs + size);
  }
  if (s == null || e == null) {
    const period = 60 / deck.bpm;
    s = deck.looping ? deck.loopStart : tNow;
    e = s + size * period;
  }
  const x0 = Math.max(r.left, xOf(s));
  const x1 = Math.min(r.right, xOf(e));
  if (x1 <= r.left || x0 >= r.right || x1 - x0 < 2) {
    prev.band.classList.add('hidden');
    return;
  }
  prev.band.classList.remove('hidden');
  prev.band.style.left = `${x0}px`;
  prev.band.style.top = `${r.top}px`;
  prev.band.style.width = `${x1 - x0}px`;
  prev.band.style.height = `${r.height}px`;
  prev.band.style.background = `${col}2b`;
  prev.band.style.borderColor = col;
}

// Quels PADS du deck L2 et R2 vont-ils « cliquer » depuis cette rangée ?
// Simple maintenant : la rangée donne la paire, L = gauche, R = droite.
function gpSideTargets(st) {
  if (st.cur.r < 1 || st.cur.r > GP_KNOBS.length || st.cur.c === GP_FX_COL) {
    return { l: null, r: null };
  }
  const ui = deckUI[Math.min(st.cur.c, deckCount - 1)];
  return {
    l: ui.pads[padForSide(st.cur.r, -1)] || null,
    r: ui.pads[padForSide(st.cur.r, 1)] || null
  };
}

// nth : quand DEUX joueurs visent le même élément, le 2e cadre s'emboîte
// autour du 1er (sinon seul le dernier serait visible) et son étiquette
// passe de l'autre côté
function placeGpFrame(el, target, color, label, nth) {
  if (!target) {
    el.classList.add('hidden');
    return;
  }
  const r = target.getBoundingClientRect();
  if (!r.width) {
    el.classList.add('hidden');
    return;
  }
  const off = 2 + (nth || 0) * 5;
  el.classList.remove('hidden');
  el.style.left = `${r.left - off}px`;
  el.style.top = `${r.top - off}px`;
  el.style.width = `${r.width + off * 2}px`;
  el.style.height = `${r.height + off * 2}px`;
  el.style.borderColor = color;
  // Le pad visé est REMPLI de la couleur du joueur (sélection visible)
  el.style.background = `${color}30`;
  el.style.boxShadow = `0 0 9px ${color}, 0 0 18px ${color}66`;
  const tag = el.querySelector('.gp-cursor-tag');
  tag.style.background = color;
  if (nth) {
    tag.style.bottom = 'auto';
    tag.style.top = '-13px';
  } else {
    tag.style.bottom = '-13px';
    tag.style.top = 'auto';
  }
  if (label) tag.textContent = label;
}

// --- PADS INTELLIGENTS : chaque pad montre ce que fera CHAQUE joueur
// présent sur le deck, dans SA couleur. Deux joueurs avec deux modes
// différents → le bouton est DIVISÉ (segment J1 loop / segment J2 jump).
// Les autres voient ta config, mais chacun garde la sienne. ---
function gpPadLabel(mode, idx, scale) {
  if (mode === 'hotcue') return String.fromCharCode(65 + idx);
  if (mode === 'jump') return formatMeasures(JUMP_VALS[idx] * (scale || 1));
  if (mode === 'key') {
    const kv = KEY_VALS[idx];
    return `${kv > 0 ? '+' : ''}${kv}♪`;
  }
  if (mode === 'fx') return PADFX[idx] ? PADFX[idx].label : 'FX';
  if (mode === 'smp') {
    const s = samplerBank[idx];
    return s ? s.name.slice(0, 8) : '+';
  }
  if (LOOP_BEATS[idx] == null) return idx === 0 ? 'IN' : idx === 1 ? 'OUT' : '✕';
  const b = LOOP_BEATS[idx] * (scale || 1);
  return b >= 1 ? String(b) : `1/${Math.round(1 / b)}`;
}

function gpUpdatePadViews() {
  const byDeck = [[], [], [], []];
  for (const [gi, st] of gamepad.pads.entries()) {
    if (st.cur.r >= 1 && st.cur.r <= GP_KNOBS.length && st.cur.c !== GP_FX_COL) {
      byDeck[Math.min(st.cur.c, deckCount - 1)].push({ gi, mode: st.mode });
    }
  }
  deckUI.forEach((ui, d) => {
    const players = byDeck[d];
    const sig = players.length
      ? players.map((p) => `${p.gi}:${p.mode}`).join('|') + `#${ui.jumpScale}`
      : 'plain';
    if (ui._padViewSig === sig) return;
    if (sig === 'plain') {
      renderPads(d); // plus de joueur ici : retour à l'affichage de l'onglet
      ui._padViewSig = 'plain';
      return;
    }
    ui._padViewSig = sig;
    // Même mode pour tous les joueurs présents ? Pas de schéma répétitif :
    // UN seul label et le bouton entier rempli des couleurs des joueurs.
    const uniq = [...new Set(players.map((p) => p.mode))];
    ui._mergedMode = uniq.length === 1 ? uniq[0] : null;
    ui.pads.forEach((p, idx) => {
      if (uniq.length === 1) {
        // Même mode : UN label, et le bouton ENTIER rempli.
        // Un joueur → tout le pad à sa couleur. Plusieurs → de VRAIES
        // bandes par joueur (le cadre L2/R2 et l'activation ne ciblent
        // ainsi QUE la partie du joueur concerné).
        if (players.length === 1) {
          p.innerHTML = '<div class="pad-single"></div>';
          p.querySelector('.pad-single').textContent = gpPadLabel(uniq[0], idx, ui.jumpScale);
          const c = PLAYER_COLORS[players[0].gi];
          p.style.background = `${c}45`;
          p.style.borderColor = c;
        } else {
          p.style.background = '';
          p.style.borderColor = '';
          p.innerHTML = players.map(({ gi }) =>
            `<div class="pad-band" data-gi="${gi}" style="--pc:${PLAYER_COLORS[gi]}"></div>`).join('') +
            '<div class="pad-single pad-single-overlay"></div>';
          p.querySelector('.pad-single').textContent = gpPadLabel(uniq[0], idx, ui.jumpScale);
        }
      } else {
        p.style.background = '';
        p.style.borderColor = '';
        p.innerHTML = players.map(({ gi }) =>
          `<div class="pad-seg" data-gi="${gi}" style="--pc:${PLAYER_COLORS[gi]}"></div>`).join('');
        [...p.children].forEach((seg, k) => {
          seg.textContent = gpPadLabel(players[k].mode, idx, ui.jumpScale);
        });
      }
      p.title = players.map(({ gi, mode }) => `J${gi + 1} : ${GP_MODE_NAMES[mode]}`).join(' · ');
    });
  });
}

// ANIMATION à l'endroit où L2/R2 frappe : flash néon de la couleur du joueur
// (destination du saut, zone de la boucle, pad appuyé)
function gpBurst(x, y, w, h, color) {
  const el = document.createElement('div');
  el.className = 'gp-burst';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.setProperty('--burst-color', color);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 520);
}

// Flash au point d'impact de l'action L2/R2 sur la vague du deck
function gpBurstAction(st, side) {
  const gi = st.player - 1;
  const col = PLAYER_COLORS[gi] || '#fff';
  const d = Math.min(st.cur.c, deckCount - 1);
  const deck = engine.decks[d];
  if (!deck.buffer) return;
  const canvas = deckUI[d].wave.canvas;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const tNow = deck.currentTime();
  const win = waveWindowSec * (deck.tempo || 1);
  const xOf = (t) => r.left + r.width / 2 + ((t - tNow) / win) * r.width;
  const size = st.mode === 'jump'
    ? JUMP_ROW_MEASURES[st.cur.r - 1] * 4 // mesures → temps
    : LOOP_ROW_BEATS[st.cur.r - 1];
  const f = deck.beats && deck.bpm ? gridIndexFracAt(deck, tNow) : null;
  const gridT = (b) => (f != null
    ? (gridTimeAtIndex(deck, f + b) ?? tNow + b * 60 / deck.bpm)
    : (deck.bpm ? tNow + b * 60 / deck.bpm : tNow));
  if (st.mode === 'jump' && deck.bpm) {
    const x = Math.max(r.left, Math.min(r.right, xOf(gridT(side * size))));
    gpBurst(x - 12, r.top, 24, r.height, col);
  } else if (st.mode === 'loop' && deck.bpm) {
    const fs = Math.round(f != null ? f : 0);
    const s = f != null ? gridTimeAtIndex(deck, fs) : tNow;
    const e = f != null ? gridTimeAtIndex(deck, fs + size) : tNow + size * 60 / deck.bpm;
    const x0 = Math.max(r.left, xOf(s != null ? s : tNow));
    const x1 = Math.min(r.right, xOf(e != null ? e : tNow));
    if (x1 > x0) gpBurst(x0, r.top, x1 - x0, r.height, col);
  } else {
    // cue / key : flash au trait de lecture
    gpBurst(r.left + r.width / 2 - 12, r.top, 24, r.height, col);
  }
}

function updateGpCursors() {
  const entries = [...gamepad.pads.entries()];
  // Panneau FX partagé : s'il y a un joueur sur la colonne FX, le panneau
  // montre SON unité (celle de son deck) — « l'espace est partagé »
  for (const [, st] of entries) {
    if (st.cur.r >= 1 && st.cur.c === GP_FX_COL) { gpFxShown = Math.min(st.player - 1, 3); break; }
  }
  updateFxPanel(); // cellules FX à jour (niveau, on/off, effet en direct)
  updateMasterBpmVal(); // BPM du master en direct dans la rangée MASTER
  // Onglets CUE/JUMP/LOOP/KEY : REMPLIS de la couleur de chaque joueur
  // présent sur le deck. FLUIDITÉ : repeints UNIQUEMENT quand un joueur
  // bouge ou change de mode — pas 80 écritures de style par frame
  const modeSig = entries.map(([gi, st]) =>
    (st.cur.r >= 1 && st.cur.r <= GP_KNOBS.length && st.cur.c !== GP_FX_COL)
      ? `${gi}:${Math.min(st.cur.c, deckCount - 1)}:${st.mode}`
      : `${gi}:-`).join('|');
  if (modeSig !== gpModeBtnSig) {
    gpModeBtnSig = modeSig;
    deckUI.forEach((ui) => ui.padModeBtns.forEach((b) => {
      b.style.boxShadow = '';
      b.style.textShadow = '';
      b.style.background = '';
      b.style.color = '';
      b.style.borderColor = '';
    }));
    entries.forEach(([gi, st]) => {
      if (st.cur.r < 1 || st.cur.r > GP_KNOBS.length || st.cur.c === GP_FX_COL) return;
      const d = Math.min(st.cur.c, deckCount - 1);
      const btn = deckUI[d].padModeBtns.find((b) => b.dataset.m === st.mode);
      if (!btn) return;
      const c = PLAYER_COLORS[gi] || '#fff';
      const glow = `0 0 8px ${c}, inset 0 0 5px ${c}66`;
      btn.style.boxShadow = btn.style.boxShadow ? `${btn.style.boxShadow}, ${glow}` : glow;
      btn.style.textShadow = 'none';
      btn.style.background = `color-mix(in srgb, ${c} 45%, #14171e)`;
      btn.style.color = '#0b0d12';
      btn.style.borderColor = c;
    });
  }
  gpUpdateNavMarks(); // sélections bibliothèque de TOUS les joueurs
  gpUpdateKnobMarks(); // lettres de cue + anneau de loop sur les knobs
  // Prévisualisations jump/loop : indexées par manette (gamepad.index)
  for (let g = 0; g < 4; g++) {
    gpUpdatePreview(g, gamepad.pads.get(g) || null);
  }
  gpUpdatePadViews(); // pads divisés par joueur
  // Occupation des cibles : 2 joueurs sur le même élément → cadres emboîtés
  const gpOcc = new Map();
  const nthOf = (t) => {
    const n = gpOcc.get(t) || 0;
    gpOcc.set(t, n + 1);
    return n;
  };
  gpCursorEls.forEach((el, i) => {
    const entry = entries[i];
    if (!entry) {
      el.classList.add('hidden');
      return;
    }
    const [gi, st] = entry;
    const isNav = st.cur.r >= GP_ROWS; // zone navigation sous FILTER
    let target = null;
    let cell = null;
    if (isNav) {
      // Chaque joueur voit SA ligne sélectionnée dans l'explorateur
      target = (st.navSel != null && libBody.children[st.navSel]) ||
        document.getElementById('library');
    } else {
      cell = gpCellAt(st.cur);
      target = cell.el();
    }
    if (!target) {
      el.classList.add('hidden');
      return;
    }
    const r = target.getBoundingClientRect();
    if (!r.width) {
      el.classList.add('hidden');
      return;
    }
    // Deux joueurs sur le MÊME élément : cadres emboîtés (sinon seul le
    // dernier serait visible), étiquette de l'autre côté
    const nth = nthOf(target);
    const off = 3 + nth * 5;
    el.classList.remove('hidden');
    el.style.left = `${r.left - off}px`;
    el.style.top = `${r.top - off}px`;
    el.style.width = `${r.width + off * 2}px`;
    el.style.height = `${r.height + off * 2}px`;
    // Chaque JOUEUR a SA couleur néon (jamais celle d'une piste)
    const col = PLAYER_COLORS[gi] || '#e8e8ec';
    el.style.borderColor = col;
    el.style.boxShadow = `0 0 10px ${col}, 0 0 22px ${col}55`;
    const tag = el.querySelector('.gp-cursor-tag');
    // Étiquette COMPACTE (le nom complet cachait le titre de la tranche) :
    // juste J1/J2, en coin, de l'autre côté si superposition
    tag.textContent = isNav ? `J${gi + 1} 📂` : `J${gi + 1}`;
    tag.style.background = col;
    tag.style.left = 'auto';
    tag.style.right = '-2px';
    if (nth) {
      tag.style.top = 'auto';
      tag.style.bottom = '-15px';
    } else {
      tag.style.top = '-15px';
      tag.style.bottom = 'auto';
    }
    // Effet GLITCH quand le curseur se déplace
    const moveKey = isNav ? `n${st.navSel}` : `${st.cur.r}:${st.cur.c}`;
    if (st._glitchKey !== moveKey) {
      st._glitchKey = moveKey;
      el.classList.remove('gp-glitch');
      void el.offsetWidth; // relance l'animation
      el.classList.add('gp-glitch');
    }
    // L2 / R2 : on ENCADRE les vrais pads qui vont être « cliqués »,
    // avec l'ACTION du joueur (« L2 −4 », « R2 🔁8 », « R2·F », « L2 −2♪ »)
    const lEl = el.querySelector('.gp-side-l');
    const rEl = el.querySelector('.gp-side-r');
    const frames = gpSideCursorEls[i];
    const inKnobs = !isNav && st.cur.r >= 1 && st.cur.r <= GP_KNOBS.length;
    const targets = inKnobs ? gpSideTargets(st) : { l: null, r: null };
    // Sur un pad divisé (segments OU bandes), on n'encadre QUE la partie
    // de CE joueur
    const segFor = (padEl) => (padEl
      ? (padEl.querySelector(`.pad-seg[data-gi="${gi}"], .pad-band[data-gi="${gi}"]`) || padEl)
      : null);
    const tL = segFor(targets.l);
    const tR = segFor(targets.r);
    placeGpFrame(frames.l, tL, col, inKnobs ? gpSideLabel(st, -1) : 'L2', tL ? nthOf(tL) : 0);
    placeGpFrame(frames.r, tR, col, inKnobs ? gpSideLabel(st, 1) : 'R2', tR ? nthOf(tR) : 0);
    lEl.style.display = 'none';
    rEl.style.display = 'none';
  });
  // Cache les cadres des joueurs sans manette
  for (let i = gamepad.pads.size; i < 4; i++) {
    gpSideCursorEls[i].l.classList.add('hidden');
    gpSideCursorEls[i].r.classList.add('hidden');
  }
}

// Badges 🎮 J1/J2… : montre quel joueur contrôle quel deck
function updatePadChips() {
  const infos = gamepad.padsInfo();
  deckUI.forEach((ui, d) => {
    const players = infos.filter(p => p.deck === d).map(p => `J${p.player}`);
    ui.padChip.textContent = players.length ? players.join('+') : '';
    ui.padChip.classList.toggle('hidden', !players.length);
  });
  padStatus.textContent = infos.length
    ? `${infos.length} manette${infos.length > 1 ? 's' : ''}`
    : 'Aucune manette';
  padStatus.className = infos.length ? 'pad-on' : 'pad-off';
}

const gamepad = new GamepadManager({
  deckCount: () => deckCount,
  gridRows: () => GP_ROWS,
  // Ordre VISUEL des colonnes du mixer (club : 3 1 2 4 puis le rack FX à
  // droite) — la croix se déplace de case en case À L'ÉCRAN
  visualOrder: () => (deckCount === 2 ? [0, 1, GP_FX_COL] : [2, 0, 1, 3, GP_FX_COL]),
  onConnection: () => {
    updatePadChips();
    renderHelp();
  },
  playToggle: (d) => playDeck(d),
  // Croix/A : Play/Pause — SUR LA CELLULE DECK du FX = active/coupe à la
  // MAIN le deck surligné (sélectionner où va l'effet)
  padPrimary: (st, d) => {
    if (st.cur.r === 0) {
      // Ligne SELECT : X sélectionne la track · sur COLOR : change l'effet
      if (st.cur.c === GP_FX_COL) {
        const sel = uiRefs.master.colorSel;
        sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
        sel.dispatchEvent(new Event('change'));
        flashStatus(`COLOR — ${sel.options[sel.selectedIndex].textContent}`);
      } else {
        gpSelectToggle(Math.min(st.cur.c, deckCount - 1), st.player - 1);
      }
      return;
    }
    if (st.cur.r >= 1 && st.cur.c === GP_FX_COL) {
      // X = LE bouton d'action sur chaque cellule FX
      const u = gpFxShown;
      const key = gpFxRowKey(st.cur.r);
      engine.resume();
      if (key === 'type') {
        gpFxTypeStep(u, 1);
      } else if (key === 'beats') {
        gpFxBeatsStep(u, 1); // X = doubler la durée
      } else if (key === 'onoff') {
        uiRefs.fxUnits[u].onBtn.click();
      } else if (key === 'level') {
        // X sur NIVEAU : +25 % et reboucle à 0
        const nv = engine.fx[u].level >= 0.99 ? 0 : Math.min(1, engine.fx[u].level + 0.25);
        engine.fx[u].setLevel(nv);
        uiRefs.fxUnits[u].levelKnob.update();
      }
      return;
    }
    playDeck(d);
  },
  loadSelected: (d) => loadSelectedToDeck(d),
  toggleHelp: () => toggleHelp(),
  // Bouton à droite du logo (Menu/Options) : BEAT SYNC ON/OFF du deck
  syncToggle: (d) => {
    const deck = engine.decks[d];
    if (deck.synced) {
      deck.synced = false;
      flashStatus(`Deck ${d + 1} — SYNC OFF`);
    } else {
      syncDeck(d);
    }
  },
  // L1/R1 maintenus : VOLUME du deck de la colonne — sur la rangée master,
  // ils manient le knob master survolé (FILTER MASTER ou VOL MASTER)
  volumeHold: (cur, dir, dt) => {
    engine.resume();
    if (cur.r === 0) {
      // ligne SELECT/COLOR : L1/R1 = VOLUME MASTER
      engine.setMasterVolume(engine.masterVolume + dir * 0.7 * dt);
      uiRefs.master.volKnob.update();
      return;
    }
    if (cur.c === GP_FX_COL) {
      // colonne FX : L1/R1 manient la cellule survolée (niveau)
      const cell = gpCellAt(cur);
      cell.set(cell.get() + dir * cell.speed * dt);
      return;
    }
    const d = Math.min(cur.c, deckCount - 1);
    // volume GROUPÉ : toutes les tracks sélectionnées montent/descendent ensemble
    gpGroupTargets(d).forEach((t) => {
      engine.decks[t].setVolume(engine.decks[t].volume + dir * 0.7 * dt);
      stripUI[t].fader.update();
    });
  },
  // L2/R2 : appuient sur les pads selon le MODE DU JOUEUR (chaque manette
  // garde sa config : J1 peut être en JUMP pendant que J2 est en LOOP sur
  // le même deck). La rangée choisit la paire, L2 = gauche, R2 = droite.
  sideAction: (st, side) => {
    const cur = st.cur;
    if (cur.r === 0 && cur.c !== GP_FX_COL) {
      // Rangée MASTER : L2 / R2 = BPM du master − / + (±0,5 — tous les
      // sons en SYNC suivent). Le poste de pilotage est complet ici :
      // stick = FILTER MASTER, L1/R1 = VOL MASTER, L2/R2 = BPM.
      masterBpmNudge(side);
      return;
    }
    // L2/R2 ne passent en « temps du FX » QUE si CE joueur a des pistes
    // dans la sélection — dès qu'il désélectionne (ou si la sélection est
    // à un autre joueur), ils redeviennent AUSSITÔT ses pads
    // JUMP/LOOP/CUE/KEY : interactions simples
    const mine = gpSelFor(st.player - 1);
    // En mode LOOP sur les rangées de pads, L2/R2 restent les PADS de
    // boucle (IN/OUT/tailles/✕) MÊME en sélection : la boucle prime sur le
    // raccourci « temps du FX » — sinon le OUT devenait inaccessible et on
    // tapait dans la durée FX (plafonnée 16) sans le savoir
    const loopPads = st.mode === 'loop' &&
      cur.r >= 1 && cur.r <= GP_KNOBS.length && cur.c !== GP_FX_COL;
    const selNow = mine.length > 0 && !loopPads;
    if (side > 0) st.r2WasSel = selNow; else st.l2WasSel = selNow;
    if (selNow) {
      // l'unité DU JOUEUR : SA durée, appliquée à TOUS les sons qu'il a
      // sélectionnés (une seule unité, routée vers chacun de ses decks)
      const u = Math.min(st.player - 1, 3);
      if (!gpFxBeatsX2(u, side)) {
        flashStatus(`⏱ J${st.player} — FX déjà au ${side > 0 ? 'maximum (32 temps)' : 'minimum (1/4 temps)'}`);
        return;
      }
      const s = uiRefs.fxUnits[u].beatsSel;
      const val = s.options[s.selectedIndex].textContent.trim();
      flashStatus(`⏱ J${st.player} — durée ${val} temps sur deck ${mine.sort().map((t) => t + 1).join(' + ')}`);
      return;
    }
    if (cur.r === 0 && cur.c === GP_FX_COL) {
      // COLOR : L2/R2 = effet de filtre précédent / suivant
      const sel = uiRefs.master.colorSel;
      const n = sel.options.length;
      sel.selectedIndex = (sel.selectedIndex + side + n) % n;
      sel.dispatchEvent(new Event('change'));
      flashStatus(`COLOR — ${sel.options[sel.selectedIndex].textContent}`);
      return;
    }
    if (cur.r < 1 || cur.r > GP_KNOBS.length) return;
    if (cur.c === GP_FX_COL) {
      // Chaque cellule FX est « solo » : L2 comme R2 la déclenchent
      const u = gpFxShown;
      const key = gpFxRowKey(cur.r);
      if (key === 'type') gpFxTypeStep(u, side);
      else if (key === 'beats') gpFxBeatsStep(u, side);
      else if (key === 'level') {
        engine.fx[u].setLevel(Math.max(0, Math.min(1, engine.fx[u].level + side * 0.12)));
        uiRefs.fxUnits[u].levelKnob.update();
      } else if (key === 'onoff') {
        uiRefs.fxUnits[u].onBtn.click();
      }
      return;
    }
    const d = Math.min(cur.c, deckCount - 1);
    gpBurstAction(st, side); // flash néon à l'endroit de l'impact (AVANT le saut)
    const padIdx = padForSide(cur.r, side);
    if (st.mode === 'fx') {
      // PAD FX à la manette : l'effet TIENT tant que la gâchette est
      // enfoncée — coupé par sideRelease au relâcher (pas de rafale)
      padFxPress(d, padIdx, true);
      if (side > 0) st._fxPadR = { d, idx: padIdx };
      else st._fxPadL = { d, idx: padIdx };
      return;
    }
    padPress(d, padIdx, st.mode, st.player - 1);
  },
  // Relâcher de L2/R2 : coupe le PAD FX que cette gâchette tenait
  sideRelease: (st, side) => {
    const held = side > 0 ? st._fxPadR : st._fxPadL;
    if (!held) return;
    if (side > 0) st._fxPadR = null; else st._fxPadL = null;
    padFxPress(held.d, held.idx, false);
  },
  // L2/R2 MAINTENU 1 seconde sur un cue posé : l'efface
  sideHold: (st, side) => {
    // décision FIGÉE à l'appui : si la pression a été consommée par la
    // branche sélection (temps du FX), le maintien n'efface JAMAIS un cue
    if (side > 0 ? st.r2WasSel : st.l2WasSel) return;
    if (st.mode !== 'hotcue' || st.cur.r < 1 || st.cur.r > GP_KNOBS.length) return;
    const d = Math.min(st.cur.c, deckCount - 1);
    const idx = padForSide(st.cur.r, side);
    if (engine.decks[d].hotCues[idx] == null) return;
    padClear(d, idx, 'hotcue');
    padFlash(d, idx, PLAYER_COLORS[st.player - 1]);
    flashStatus(`🎮 J${st.player} — hot cue ${String.fromCharCode(65 + idx)} effacé (deck ${d + 1})`);
  },
  // Share/View (appui court) : changer le mode DU JOUEUR (CUE→JUMP→LOOP→KEY)
  cycleMode: (st) => {
    st.mode = GP_MODES[(GP_MODES.indexOf(st.mode) + 1) % GP_MODES.length];
    flashStatus(`🎮 J${st.player} — L2/R2 en mode ${GP_MODE_NAMES[st.mode]}`);
  },
  // --- Mode NAVIGATION (sous la rangée FILTER) — sélection PAR JOUEUR :
  // chaque manette a son propre surlignage dans l'explorateur, on voit qui
  // est où et qui sélectionne quoi ---
  navSelIndex: () => library.selection,
  navMove: (st, d) => {
    const n = library.filtered.length;
    if (!n) return;
    if (st.navSel == null) st.navSel = library.selection;
    st.navSel = Math.max(0, Math.min(n - 1, st.navSel + d));
    const row = libBody.children[st.navSel];
    if (row) row.scrollIntoView({ block: 'nearest' });
  },
  navEnter: (st, d) => {
    const prevSel = library.selection;
    if (st.navSel != null && library.filtered.length) {
      library.selection = Math.max(0, Math.min(library.filtered.length - 1, st.navSel));
      updateSelectionUI();
    }
    const t = library.selectedTrack();
    if (!t) return;
    if (t.plRow) {
      library.openPlaylist(t.pl);
      st.navSel = 0;
    } else if (t.scPlaylist) {
      library.loadScUrl(t.permalink, t.acctIdx);
      st.navSel = 0;
    } else if (t.scAccountRow) {
      // Ligne 👤 compte SoundCloud (b2b) : Rond/B entre dans SES playlists
      openScAccount(t.acctIdx);
      st.navSel = 0;
    } else if (t.scRootRow) {
      // Bug historique corrigé : ces lignes de navigation tombaient dans le
      // chargement de deck et échouaient en silence (ni path ni scId)
      openSoundCloud();
      st.navSel = 0;
    } else if (t.scLikes) {
      openScLikes(t.acctIdx);
      st.navSel = 0;
    } else {
      gpLoadedTrack[st.player - 1] = t; // marqueur PERMANENT « J.. a chargé ça »
      const deck = engine.decks[d];
      const same = deck.track && (deck.track === t ||
        (deck.track.path && t.path && deck.track.path === t.path));
      if (same) {
        playDeck(d); // déjà chargé sur son deck : Croix lance / met en pause
      } else {
        loadTrackToDeck(d, t, true); // charge ET LANCE le son
      }
      // On REND la sélection globale : chaque joueur garde SA barre de
      // couleur sur SA ligne — celui qui charge n'efface plus l'affichage
      // de l'autre (« il faut laisser qui a affiché quoi »)
      library.selection = prevSel;
      updateSelectionUI();
    }
  },
  navBack: (st) => {
    const scBack = document.getElementById('btn-sc-back');
    const plBack = document.getElementById('btn-pl-back');
    if (plBack && !plBack.classList.contains('hidden')) plBack.click();
    else if (scBack && !scBack.classList.contains('hidden')) scBack.click();
    if (st) st.navSel = 0;
  },
  navTab: (st, dir) => {
    const modes = ['local', 'sc', 'hist', 'pl'];
    const ids = ['tab-local', 'tab-sc', 'tab-hist', 'tab-pl'];
    const cur = Math.max(0, modes.indexOf(library.mode));
    const btn = document.getElementById(ids[((cur + dir) % 4 + 4) % 4]);
    if (btn) btn.click();
    if (st) st.navSel = 0;
  },
  // Stick gauche ◀▶ (maintenu 0,5 s) : DÉCALER le son en avant/arrière,
  // comme le haut du disque d'un CDJ — les traits rouges de ce deck glissent
  // par rapport à l'autre pour régler le calage à l'oreille. Au relâcher,
  // le tempo revient exactement et le CALAGE AUTOMATIQUE se ré-ancre sur
  // l'alignement choisi (il ne défait plus la correction manuelle).
  jogNudge: (cur, v, dt) => {
    if (cur.r < 1 || cur.c === GP_FX_COL) return;
    const d = Math.min(cur.c, deckCount - 1);
    const deck = engine.decks[d];
    if (!deck.buffer) return;
    engine.resume();
    if (deck.looping && deck.bpm) {
      // BOUCLE ACTIVE = le stick gauche règle la boucle, TOUJOURS et
      // IMMÉDIATEMENT (▶ +1 segment · ◀ réduction fine) — plus de mode à
      // activer qui se perdait. Sortir de la boucle rend le jog au stick.
      gpLoopEditAdjust(d, v, dt);
      return;
    }
    if (!deck.playing) {
      // à l'arrêt : on se déplace finement dans le son
      deck.seek(Math.max(-3600, deck.currentTime() + v * 0.25 * dt));
      return;
    }
    if (!gpBend[d]) {
      // Pendant le geste : verrou sync suspendu PARTOUT (aucun deck ne
      // poursuit celui qu'on décale) et tous les autres restent à leur
      // tempo de base — le décalage relatif est doux et exact
      gpBend[d] = { tempo: gpBaseTempo(deck), synced: deck.synced };
      engine.jogHold = true;
    }
    deck.synced = false;
    // Courbe progressive jusqu'à ±6 % : doux et précis près du centre,
    // à fond le son glisse de ~60 ms par seconde de maintien — on avance
    // le son deux fois plus vite qu'avant sans perdre la finesse
    deck.setTempo(gpBend[d].tempo * (1 + v * Math.abs(v) * 0.06));
  },
  jogRelease: () => {
    gpBend.forEach((b, d) => {
      if (!b) return;
      const deck = engine.decks[d];
      deck.setTempo(b.tempo);
      deck.synced = b.synced;
      gpBend[d] = null;
    });
    engine.jogHold = false;
    // TOUS les decks synchronisés adoptent le nouvel alignement : le
    // calage automatique garde exactement ce que le DJ vient de régler
    for (let d = 0; d < 4; d++) engine.reanchorSync(d);
  },
  // Stick droit ▲▼ : zoomer / dézoomer les formes d'onde
  zoomWaves: (v, dt) => {
    waveZoom(Math.pow(0.45, v * dt));
  },
  // L3 (clic stick gauche) : le FILTRE en général ON/OFF (COLOR ON/OFF)
  colorToggle: () => document.getElementById('color-on').click(),
  // R3 (clic stick droit) : le FX de la track ON/OFF (rangée master = tous)
  fxToggle: (st) => {
    const cur = st.cur;
    if (cur.r === 0) {
      if (cur.c === GP_FX_COL) {
        document.getElementById('color-on').click(); // COLOR ON/OFF
      } else {
        // ⚡ ENGAGER : les tracks sélectionnées rejoignent MON FX qui s'allume
        gpFxEngage(st);
      }
      return;
    }
    if (cur.c === GP_FX_COL) {
      uiRefs.fxUnits[gpFxShown].onBtn.click();
      return;
    }
    // Appuyer sur le stick FX sur un disque = le SÉLECTIONNER aussi :
    // la sélection arme le FX + le filtre d'un coup (re-appui = retire)
    gpSelectToggle(Math.min(cur.c, deckCount - 1), st.player - 1);
  },
  // Stick droit ▲▼ : NIVEAU du FX — monte/descend le FX de TOUS les sons
  // SÉLECTIONNÉS en même temps (rangée master = les 4 sans condition)
  fxLevel: (st, v, dt) => {
    engine.resume();
    const cur = st.cur;
    const one = (u) => {
      engine.fx[u].setLevel(engine.fx[u].level + v * 1.1 * dt);
      uiRefs.fxUnits[u].levelKnob.update();
    };
    // le % s'affiche EN DIRECT pendant qu'on monte/descend le stick —
    // throttlé pour ne pas monopoliser la barre de statut à 60 Hz
    const pct = (u) => `${Math.round(engine.fx[u].level * 100)}%`;
    const flash = (msg) => {
      const t = performance.now();
      if (t - gpFxFlashAt < 150) return;
      gpFxFlashAt = t;
      flashStatus(msg);
    };
    const mine = gpSelFor(st.player - 1);
    if (mine.length) {
      // SÉLECTION : le niveau de L'UNITÉ DU JOUEUR bouge (ses sons),
      // peu importe où on est sur la matrice — sans sélection à lui,
      // le stick garde son comportement normal
      const u = Math.min(st.player - 1, 3);
      one(u);
      flash(`⚡ J${st.player} — FX niveau ${pct(u)} (deck ${mine.map((t) => t + 1).join('+')})`);
      return;
    }
    if (cur.r === 0) {
      for (let u = 0; u < 4; u++) one(u);
      flash(`⚡ FX MASTER — ${[0, 1, 2, 3].map(pct).join(' · ')}`);
      return;
    }
    if (cur.c === GP_FX_COL) {
      one(gpFxShown);
      flash(`⚡ FX ${gpFxShown + 1} — niveau ${pct(gpFxShown)}`);
      return;
    }
    const u = Math.min(st.player - 1, 3);
    one(u);
    flash(`⚡ J${st.player} — FX niveau ${pct(u)}`);
  },
  // Carré court : durée du FX parmi 1/2 · 3/4 · 1 · 2 (sur la colonne FX :
  // l'unité affichée, sinon l'unité PERSONNELLE du joueur)
  fxBeatsCycle: (st) => {
    const d = st.cur.c === GP_FX_COL ? gpFxUnitOf(st.cur) : Math.min(st.player - 1, 3);
    const wanted = ['1/2', '3/4', '1', '2'];
    const sel = uiRefs.fxUnits[d].beatsSel;
    const labels = [...sel.options].map((o) => o.textContent.trim());
    const pos = wanted.indexOf(labels[sel.selectedIndex]);
    const idx = labels.indexOf(wanted[(pos + 1) % wanted.length]);
    if (idx >= 0) {
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event('change'));
      flashStatus(`FX ${d + 1} — durée ${wanted[(pos + 1) % wanted.length]} temps`);
    }
  },
  // Carré ENFONCÉ : la liste des effets s'affiche à l'écran et l'effet
  // défile petit à petit tant que le bouton est tenu
  fxTypeList: (st, op) => {
    const d = st.cur.c === GP_FX_COL ? gpFxUnitOf(st.cur) : Math.min(st.player - 1, 3);
    gpFxTypeList(d, op);
  },
  // Stick gauche ▲▼ : dès qu'une SÉLECTION existe, il manie les FILTRES de
  // TOUTES les tracks sélectionnées, PEU IMPORTE où on est. Sans sélection :
  // le knob survolé (groupé si la colonne est sélectionnée).
  stickAdjust: (st, v, dt) => {
    engine.resume();
    const cur = st.cur;
    const mine = gpSelFor(st.player - 1);
    if (mine.length) {
      // RÈGLE : stick GAUCHE = FILTRE, le FX c'est le stick DROIT. Si le
      // COLOR était parti sur un écho (cellule COLOR + L2/R2), on le
      // ramène sur Filter — sinon ce stick « met du FX » au lieu de filtrer
      const csel = uiRefs.master.colorSel;
      if (csel && csel.value !== 'filter') {
        csel.value = 'filter';
        csel.dispatchEvent(new Event('change'));
        flashStatus('COLOR → Filter (stick gauche = FILTRE · le FX = stick droit)');
      }
      // chaque joueur manie les FILTRES de SES pistes sélectionnées —
      // sans sélection à lui, le stick garde le knob survolé
      mine.forEach((t) => {
        engine.setDeckColor(t, Math.max(-1, Math.min(1,
          engine.decks[t].filterVal + v * 1.2 * 1.8 * dt)));
        stripUI[t].kFilt.update();
      });
      return;
    }
    if (cur.r >= 1 && cur.r <= GP_KNOBS.length && cur.c !== GP_FX_COL) {
      gpGroupKnobAdjust(cur, v * 1.8 * 1.2 * dt);
      return;
    }
    const cell = gpCellAt(cur);
    cell.set(cell.get() + v * cell.speed * 1.8 * dt);
  },
  killKnob: (cur, gi) => gpKillKnob(cur, gi),
  cutToggle: (d) => gpCutToggle(d),
  selectToggle: (d, gi) => gpSelectToggle(d, gi),
  // Rond/B : remet le knob survolé à sa valeur PAR DÉFAUT (neutre) —
  // parfait pour un effet de filtre puis retour à zéro instantané
  resetKnob: (cur, d, gi) => {
    engine.resume();
    if (cur.r >= 1 && cur.r <= GP_KNOBS.length && cur.c !== GP_FX_COL) {
      // knob remis au neutre pour TOUT le groupe sélectionné
      const dd = Math.min(cur.c, deckCount - 1);
      const k = GP_KNOBS[cur.r - 1];
      gpGroupTargets(dd).forEach((t) => {
        gpKillStore.delete(`${k.key}:${t}`);
        k.set(t, 0);
      });
    } else if (cur.r !== 0) {
      const cell = gpCellAt(cur);
      gpKillStore.delete(`${cell.key}:${cell.deck}`); // annule un kill en cours
      cell.set(0);
    }
    // ◯ = FX **et** FILTRE à 0 des tracks sélectionnées (ou de la track
    // courante) — la SÉLECTION et l'armement RESTENT : on peut relancer
    // un effet aussitôt. R1 fait le même reset + désélectionne tout.
    const targets = gpSelection.size
      ? [...gpSelection]
      : [Math.min(
          cur.c === GP_FX_COL ? (cur.r >= 1 ? gpFxShown : (d != null ? d : 0)) : cur.c,
          deckCount - 1)];
    targets.forEach((t) => {
      engine.setDeckColor(t, 0);
      stripUI[t].kFilt.update();
    });
    // zéro sur l'unité PERSONNELLE du joueur + toute unité qui TRAITE une
    // des cibles (les unités sont par joueur)
    const units = new Set(gi != null ? [Math.min(gi, 3)] : []);
    targets.forEach((t) => {
      for (let u = 0; u < 4; u++) if (engine.fxAssign[u][t]) units.add(u);
    });
    units.forEach((u) => {
      engine.fx[u].setLevel(0);
      uiRefs.fxUnits[u].levelKnob.update();
    });
    flashStatus(gpSelection.size
      ? `◯ — filtre + FX à 0 (sélection ${[...targets].sort().map((x) => x + 1).join('+')} conservée)`
      : `◯ — filtre + FX du deck ${targets[0] + 1} à 0`);
  },
  // R1 ne déclenche le reset que si CE joueur a des pistes sélectionnées
  hasSelection: (gi) => gpSelFor(gi).length > 0,
  selReset: (d, cur) => gpSelReset(d, cur)
});

// ---------------------------------------------------------------------------
// Aide manette
// ---------------------------------------------------------------------------

function renderHelp() {
  const b = (i) => gamepad.connected ? gamepad.buttonLabel(i) : ({ 0: 'Croix/A', 1: 'Rond/B', 2: 'Carré/X', 3: 'Triangle/Y', 4: 'L1/LB', 5: 'R1/RB', 6: 'L2/LT', 7: 'R2/RT', 8: 'Share/View', 9: 'Options/Menu', 10: 'L3', 11: 'R3', 16: 'Bouton PS/Xbox' })[i];
  const rows = [
    ['Croix ◀▶▲▼', 'MATRICE : colonnes = decks (en haut MASTER, à droite le RACK FX) · sous FILTER = NAVIGATION bibliothèque'],
    [b(16), 'COUPER / remettre le knob survolé · sur LOW : les basses passent à CE deck (jamais 2 basses en même temps)'],
    [`${b(6)} / ${b(7)}`, 'Sur les pads : moitié gauche / droite · COLONNE FX : durée ÷2 / ×2 · rangée MASTER : BPM − / + (les syncés suivent)'],
    [`${b(8)} court`, 'Changer TON mode L2/R2 : JUMP → LOOP → CUE → KEY (chaque joueur garde le sien) · appui long = cette aide'],
    [b(2), 'Court : durée du FX 1/2 → 3/4 → 1 → 2 temps · ENFONCÉ : liste des effets qui défile · (colonne FX : change l\'effet du panneau)'],
    ['Stick droit', '▲▼ : NIVEAU du FX de la track (rangée master = tous) · ◀▶ maintenu ½ s : ZOOM / DÉZOOM des vagues'],
    [b(11), 'SÉLECTIONNER la track (arme son FX + filtre d\'un coup) · re-appui : la retire · colonne FX : unité ON / OFF'],
    [b(10), 'FILTRE en général ON / OFF (COLOR)'],
    [`${b(4)} / ${b(5)}`, 'VOLUME de la piste − / + (maintenir) · rangée master : le knob master survolé · R1 avec sélection : TOUT à 0 + désélection'],
    ['Stick gauche', '▲▼ : knob survolé · ◀▶ maintenu ½ s : DÉCALER le son (jog CDJ) — au relâcher le calage auto GARDE ton alignement'],
    [b(9), 'BEAT SYNC du deck ON / OFF (au lancement d\'un son sync, les traits rouges se calent sur le master)'],
    [b(0), 'Play / Pause · en NAVIGATION : ouvrir une playlist ou CHARGER ET LANCER le morceau (re-appuyer = pause)'],
    [`${b(1)} court`, 'FX + FILTRE à 0 (sélection CONSERVÉE) + knob survolé au neutre · en NAVIGATION : retour · APPUI LONG : sélection CUT'],
    [b(3), 'CUT : coupe d\'un coup les decks sélectionnés — ré-appuyer, tout revient d\'un coup'],
    ['NAVIGATION', 'Descendre sous FILTER : ▲▼ = choisir, ◀▶ = onglets, Croix = ouvrir, Rond = retour, ▲ tout en haut = retour aux knobs']
  ];
  document.getElementById('help-table').innerHTML =
    rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
}

function toggleHelp() {
  document.getElementById('help-overlay').classList.toggle('hidden');
}

// ---------------------------------------------------------------------------
// Boucle de rendu
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
const wavesEl = document.getElementById('waves');
const wavePlayhead = document.getElementById('wave-playhead');

// --- RETOUR LUMINEUX vers la platine : vumètres par tranche, LED play/cue/
// sync, boucle, FX qui CLIGNOTE, channel select — « la magie de la platine »,
// c'est le logiciel qui la pilote. N'émet que les CHANGEMENTS (cache midi).
const MIDI_SEL_NOTES = [29, 31, 28, 20]; // channel select : decks 1-4 (canal 5)
function midiFeedback(now) {
  if (!midi.output) return;
  const blink = (now % 500) < 250; // clignotant 2 Hz
  for (let i = 0; i < 4; i++) {
    const d = engine.decks[i];
    // Vumètre de la tranche (rouge compris : même valeur que les mètres écran)
    midi.setVu(i, Math.min(1, stripUI[i].meterVal || 0));
    midi.setLed(i, 11, d.playing);                       // PLAY
    midi.setLed(i, 12, !!d.buffer && !d.playing);        // CUE (prêt, à l'arrêt)
    midi.setLed(i, 88, d.synced);                        // SYNC
    // Boucle : IN fixe quand un point est posé, IN+OUT clignotent en boucle
    midi.setLed(i, 16, d.looping ? blink : d._loopInPoint != null);
    midi.setLed(i, 17, d.looping ? blink : false);
    midi.setLed(i, 77, d.looping);                       // RELOOP/EXIT
  }
  // FX : le bouton clignote dès qu'un FX est actif quelque part — la LED de
  // la FLX6 (MERGE FX) n'écoute peut-être pas le canal du bouton : on émet
  // la note 71 sur TOUS les canaux plausibles
  const fxOn = engine.fx.some((u) => u.enabled) ||
    engine.padFx.some((u) => u && u.enabled);
  for (let ch = 0; ch < 8; ch++) midi.setLed(ch, 71, fxOn && blink);
  // Channel select : la position du deck ACTIF reste allumée
  MIDI_SEL_NOTES.forEach((n, i) => midi.setLed(5, n, i === activeDeck));
}

function frame(now) {
  // Une exception ici tuait le requestAnimationFrame → app entièrement
  // figée (c'était le « crash » du passage 4 → 2 decks pendant la lecture).
  // La boucle de rendu ne doit JAMAIS mourir.
  try {
    frameBody(now);
  } catch (e) {
    console.error('frame:', e);
  }
  requestAnimationFrame(frame);
}

function frameBody(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  gamepad.poll(dt, now);
  updateGpCursors(); // curseurs des joueurs sur la grille de contrôles
  engine.syncLock(); // maintient les decks synchronisés collés au master

  for (let i = 0; i < 4; i++) {
    const deck = engine.decks[i];
    const ui = deckUI[i];
    const t = deck.currentTime();

    // Optimisation : ne redessine que si quelque chose a bougé
    const cueSig = deck.hotCues ? deck.hotCues.map(c => (c == null ? '' : Math.round(c * 20))).join(',') : '';
    // La fenêtre visible est en TEMPS RÉEL : on la convertit en temps du fichier
    // selon le tempo du deck. Ainsi, deux decks au même BPM effectif affichent
    // des mesures de la même largeur, quelle que soit leur vitesse de lecture.
    // PENDANT UN JOG : on fige l'affichage sur le tempo de BASE — sinon le
    // bend faisait « respirer » (grossir/rétrécir) la vague de la track.
    const dispTempo = gpBend[i] ? gpBend[i].tempo : (deck.tempo || 1);
    const deckWindow = waveWindowSec * dispTempo;
    const zoomSig = `${t.toFixed(3)}|${deckWindow.toFixed(3)}|${deck.looping ? deck.loopStart + '-' + deck.loopEnd : ''}|${deck._loopInPoint ?? ''}|${deck.peaks ? deck.peaks.duration : 0}|${deck.beatOffset}|${deck.bpm}|${deck.gridShift}|${deck.barAnchor}|${deck.beats ? deck.beats.length : 0}|${getGlobalGridOffset()}|${cueSig}`;
    if (ui._zoomSig !== zoomSig) {
      ui._zoomSig = zoomSig;
      // FENÊTRE FIXE, délibérément : l'échelle × tempo (tentée puis
      // RETIRÉE) faisait BOUGER tout le tracé à chaque mise à jour interne
      // de vitesse — « tu l'as rendu mobile, encore pire ». L'alignement
      // visuel des beats est garanti par l'aimant à zéro du calage +
      // le servo, PAS par l'échelle. Ne pas re-tenter.
      drawZoom(ui.wave.canvas, deck, deckWindow);
    }
    const overSig = deck.peaks
      ? `${Math.round((t / deck.peaks.duration) * ui.over.clientWidth)}|${deck.looping ? deck.loopStart : ''}|${deck.peaks.duration}|${cueSig}`
      : 'vide';
    if (ui._overSig !== overSig) {
      ui._overSig = overSig;
      drawOverview(ui.over, deck);
    }

    const playTxt = deck.playing ? '❚❚' : '▶';
    if (ui.play.textContent !== playTxt) ui.play.textContent = playTxt;
    ui.play.classList.toggle('on', deck.playing);
    ui.sync.classList.toggle('on', deck.synced);
    // Badge MASTER : le choix manuel prime, sinon le master AUTOMATIQUE
    // (premier son lancé, conservé tant qu'il joue, puis basses actives)
    const isMaster = engine.masterIdx === i ||
      (engine.masterIdx === null && engine.autoMasterIdx === i);
    ui.master.classList.toggle('hidden', !isMaster);
    ui.masterBtn.classList.toggle('on', isMaster);

    // État des pads — DÉCOUPÉ PAR JOUEUR : sur un pad divisé, SEULE la
    // partie du joueur qui a posé le cue / tient la boucle s'allume, et
    // chaque segment s'évalue selon le mode de SON joueur.
    // (posé à la souris = liseré discret couleur du deck)
    const stateFor = (mode, idx) => {
      if (mode === 'hotcue') {
        return { active: deck.hotCues[idx] != null, owners: gpOwnersOf(ui.cueOwner ? ui.cueOwner[idx] : null) };
      }
      if (mode === 'loop') {
        return {
          active: deck.looping && deck._loopBeats === LOOP_BEATS[idx] * (ui.jumpScale || 1),
          owners: gpOwnersOf(ui.loopOwner)
        };
      }
      if (mode === 'key') return { active: deck.keyShift === KEY_VALS[idx], owners: [] };
      return { active: false, owners: [] };
    };
    const gpModes = new Map();
    for (const [g, s2] of gamepad.pads) gpModes.set(String(g), s2.mode);
    ui.pads.forEach((p, idx) => {
      const segs = p.querySelectorAll('.pad-seg, .pad-band');
      if (segs.length) {
        // Pad divisé (segments ou bandes) : seule la PARTIE du propriétaire
        p.classList.remove('set', 'on');
        segs.forEach((s2) => {
          const m = gpModes.get(s2.dataset.gi);
          const stt = m ? stateFor(m, idx) : { active: false, owners: [] };
          s2.classList.toggle('seg-active', stt.active && stt.owners.includes(Number(s2.dataset.gi)));
        });
        const tabState = stateFor(ui.padMode, idx);
        p.classList.toggle('set-any', tabState.active && !tabState.owners.length);
        return;
      }
      // Vue pleine (onglet du deck ou vue fusionnée) : le pad entier se
      // remplit — couleur(s) du/des propriétaires, sinon celle du deck.
      p.classList.remove('set-any');
      const mode = p.querySelector('.pad-single') && ui._mergedMode ? ui._mergedMode : ui.padMode;
      const stt = stateFor(mode, idx);
      const own = stt.active && stt.owners.length ? gpOwnersBg(stt.owners, null) : null;
      if (own) p.style.setProperty('--own-color', own);
      else p.style.removeProperty('--own-color');
      p.classList.remove('set', 'on');
      if (stt.active) p.classList.add(mode === 'hotcue' ? 'set' : 'on');
      // Cue d'un JOUEUR = rempli de sa couleur · cue souris/ancien = repère discret
      p.classList.toggle('set-owned', !!own);
    });

    drawDeckWheel(ui, deck, t); // la platine tourne pendant la lecture
    if (deck.buffer) {
      const tTxt = t < 0 ? `−${formatTime(-t)}` : formatTime(t);
      const timeTxt = `${tTxt} · -${formatTime(deck.duration - t)}`;
      // Ne réécrit le texte QUE quand la seconde change (une écriture DOM
      // par frame = invalidation de mise en page inutile)
      if (ui._timeTxt !== timeTxt) {
        ui._timeTxt = timeTxt;
        ui.time.textContent = timeTxt;
      }
      // Compteur de temps 1·2·3·4 : le point du temps courant s'allume —
      // le détail pro qui montre où on est dans la mesure d'un coup d'œil
      const bp = deck.playing ? engine._barPhase(deck) : null;
      const bi = bp != null ? Math.floor(bp * 4) % 4 : -1;
      if (ui._beatIdx !== bi) {
        ui._beatIdx = bi;
        ui.beatDots.forEach((dot, k) => dot.classList.toggle('on', k === bi));
      }
      let ebpm = deck.effectiveBpm;
      // Deck SYNCÉ verrouillé : on AFFICHE le BPM du master — le verrou
      // garantit la même vitesse réelle ; l'ancien affichage montrait la
      // petite erreur de détection du morceau (143.6 face à 144.0) alors
      // que les temps sont collés — « il faut le MÊME BPM » : le voilà
      if (deck.synced && deck.playing && deck._syncBase) {
        const mstr = engine.getMasterDeck(i);
        if (mstr && mstr.bpm && mstr.playing) ebpm = mstr.bpm * mstr.tempo;
      }
      const bpmText = ebpm ? ebpm.toFixed(1) : '--.-';
      if (ui._bpmText !== bpmText) {
        ui._bpmText = bpmText;
        ui.bpm.innerHTML = `${bpmText}<small> BPM</small>`;
        ui.wave.bpm.textContent = bpmText;
        if (deck.bpm) ui.tempoVal.textContent = bpmText;
      }
    }

    // Marqueurs : où sont les BPM des autres decks sur MON échelle de tempo
    for (let j = 0; j < 4; j++) {
      const mark = ui.tempoMarks[j];
      if (!mark) continue;
      const other = engine.decks[j].effectiveBpm;
      if (!deck.bpm || !other) {
        if (mark.style.display !== 'none') mark.style.display = 'none';
        continue;
      }
      const pos = (other / deck.bpm - 0.5) / 1.0; // plage du slider : ×0,5 à ×1,5
      if (pos < 0 || pos > 1) {
        if (mark.style.display !== 'none') mark.style.display = 'none';
        continue;
      }
      const left = `${(pos * 100).toFixed(1)}%`;
      if (mark.style.display !== 'block') mark.style.display = 'block';
      if (mark.style.left !== left) mark.style.left = left;
    }
  }

  if (recorder) {
    recTime.textContent = formatTime((performance.now() - recStart) / 1000);
  }

  // Chaque unité FX suit le BPM du premier deck qui lui est assigné
  // (sinon celui du master)
  const masterD = engine.getMasterDeck(-1);
  const masterBeat = masterD && masterD.bpm ? 60 / (masterD.bpm * masterD.tempo) : 0.5;
  engine.fx.forEach((u, uIdx) => {
    if (!u.enabled) return;
    let beat = masterBeat;
    for (let d = 0; d < 4; d++) {
      if (engine.fxAssign[uIdx][d] && engine.decks[d].effectiveBpm) {
        beat = 60 / engine.decks[d].effectiveBpm;
        break;
      }
    }
    u.setBeatDur(beat);
  });
  // Les unités PAD FX suivent le tempo de LEUR deck (sinon celui du master)
  engine.padFx.forEach((u, d) => {
    if (!u || !u.enabled) return;
    u.setBeatDur(engine.decks[d].effectiveBpm ? 60 / engine.decks[d].effectiveBpm : masterBeat);
  });
  // Le FX MASTER se cale sur le BPM du deck master + bandeau à jour
  if (engine.masterFx && engine.masterFx.enabled) engine.masterFx.setBeatDur(masterBeat);
  updateMasterFxRow();

  // VU-mètres : niveau crête par tranche + LED rouge si saturation.
  // Animés par TRANSFORM : changer height/width à chaque frame invalidait la
  // mise en page → reflow 60×/s → vagues saccadées (« pas uniformes »)
  for (let i = 0; i < 4; i++) {
    const s = stripUI[i];
    const deck = engine.decks[i];
    const peak = deck.buffer ? deck.meterPeak() : 0;
    s.meterVal = Math.max(peak, s.meterVal * 0.9);
    s.meterFill.style.transform = `scaleY(${Math.min(1, s.meterVal).toFixed(3)})`;
    if (peak >= 0.99) s.clipUntil = now + 700;
    s.meterClip.classList.toggle('on', now < s.clipUntil);
  }

  // VU-mètre MASTER (le mix assemblé)
  if (masterMeterFill) {
    const mPeak = engine.masterPeak();
    masterMeterVal = Math.max(mPeak, masterMeterVal * 0.9);
    masterMeterFill.style.transform = `scaleX(${Math.min(1, masterMeterVal).toFixed(3)})`;
    if (mPeak >= 1) masterClipUntil = now + 700;
    masterMeterClip.classList.toggle('on', now < masterClipUntil);
  }

  midiFeedback(now); // LED et vumètres de la platine (n'émet que les changements)

  // Trait de lecture global : getBoundingClientRect FORCE une mise en page
  // synchrone — on ne le mesure plus qu'à ~2 Hz (et au redimensionnement),
  // sa position ne bouge de toute façon qu'avec la fenêtre
  if (now - _playheadMeasured > 500) {
    _playheadMeasured = now;
    const c0 = deckUI[0].wave.canvas;
    const cr = c0.getBoundingClientRect();
    const wr = wavesEl.getBoundingClientRect();
    const left = `${(cr.left - wr.left + cr.width / 2 - 1).toFixed(1)}px`;
    if (wavePlayhead.style.left !== left) wavePlayhead.style.left = left;
  }
}
let _playheadMeasured = 0;

// --- Zoom de la vue empilée : molette, boutons, touches + / - ---
// De 0,5 s (très zoomé, forme exacte du son) à 60 s visibles.
function waveZoom(factor) {
  waveWindowSec = Math.min(60, Math.max(0.5, waveWindowSec * factor));
}
wavesEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  waveZoom(e.deltaY > 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

// Bloque le zoom de page (Ctrl+molette / pincement) qui déformait l'interface
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
document.getElementById('wz-in').addEventListener('click', () => waveZoom(1 / 1.35));
document.getElementById('wz-out').addEventListener('click', () => waveZoom(1.35));

// --- Contrôleur MIDI (DDJ et toute platine USB-MIDI) ---
const midiCueHold = [false, false, false, false];

function midiCue(i, on) {
  const deck = engine.decks[i];
  if (!deck.buffer) {
    // deck vide : le DIRE (l'ancien silence ressemblait à un bouton mort)
    if (on) flashStatus(`Deck ${i + 1} — aucun son chargé (CUE)`);
    return;
  }
  if (on) {
    if (deck.playing) {
      deck.cue();
      flashStatus(`⏹ Deck ${i + 1} — retour au point CUE`);
      return;
    }
    const atCue = Math.abs(deck.currentTime() - deck.cuePoint) < 0.02;
    if (!atCue) {
      deck.cue();
      flashStatus(`📍 Deck ${i + 1} — point CUE posé ici`);
      return;
    }
    midiCueHold[i] = true;
    deck.play();
    flashStatus(`▶ Deck ${i + 1} — pré-écoute (maintiens CUE)`);
  } else if (midiCueHold[i]) {
    midiCueHold[i] = false;
    deck.pause();
    deck.seek(deck.cuePoint);
  }
}

const midiJogTimer = [null, null, null, null]; // relâcher du nudge MIDI (côté)
const midiScratchTimer = [null, null, null, null]; // relâcher du scratch (dessus)
const midiSeekAcc = [0, 0, 0, 0];   // déplacement accumulé (dessus sans toucher)
const midiSeekTimer = [null, null, null, null];
let midiShiftHeld = false; // bouton SHIFT (gauche ou droit) tenu enfoncé
const midiJogState = [null, null, null, null];  // geste de scratch en cours
const midiJogTouchHeld = [false, false, false, false]; // main posée sur le disque
const midiJogArmTimer = [null, null, null, null]; // armement différé du toucher
let midiJogTouchAt = 0; // instant du dernier toucher (filtre anti-parasites)
let midiXfLastAt = 0;   // continuité du crossfader (filtre anti-rafales)
// CIBLE du FX platine : la position du CHANNEL SELECT de la FLX6 décide quel
// deck le bouton FX / knob niveau / BEAT ◄► pilotent (« je suis sur le 2
// donc c'est le FX du 2 qui doit s'activer »). 'master' = le deck master.
let midiFxTarget = null; // null = suivre le deck actif · 'master' = FX du MIX
function midiFxUnit() {
  return Math.min(midiFxTarget != null ? midiFxTarget : activeDeck, 3);
}
// --- FX « platine » : UN SEUL effet à la fois, qui SUIT le sélecteur ---
// (demande David : passer de 1 à 2 déplace l'effet, pas besoin de couper le
// 1 à la main ; et le niveau vient TOUJOURS de la jauge, jamais d'un défaut)
function platineFxCurrent() {
  if (engine.masterFx && engine.masterFx.enabled) return { kind: 'master', fx: engine.masterFx };
  const u = engine.fx.findIndex((f) => f.enabled);
  return u >= 0 ? { kind: 'deck', u, fx: engine.fx[u] } : null;
}
function platineFxOff() {
  engine.fx.forEach((f, u) => {
    if (!f.enabled) return;
    f.setEnabled(false);
    const b = uiRefs.fxUnits[u].onBtn;
    b.textContent = 'OFF';
    b.classList.remove('on');
  });
  if (engine.masterFx) engine.masterFx.setEnabled(false);
  engine.updateFxSends();
  updateMasterFxRow();
}
// Allume l'effet sur la cible du sélecteur, en TRANSFÉRANT réglages et
// niveau de l'effet précédent (src) s'il y en avait un
function platineFxOnTarget(src) {
  if (midiFxTarget === 'master') {
    const mu = engine.ensureMasterFx();
    if (src) {
      mu.setType(src.type);
      mu.setBeatsMult(src.beatsMult);
      mu.setLevel(src.level);
    }
    mu.setEnabled(true);
    updateMasterFxRow();
    return 'MASTER';
  }
  const u = midiFxUnit();
  const f = engine.fx[u];
  if (src) {
    const r = uiRefs.fxUnits[u];
    r.typeSel.value = src.type;
    r.typeSel.dispatchEvent(new Event('change'));
    r.beatsSel.value = String(src.beatsMult);
    r.beatsSel.dispatchEvent(new Event('change'));
    f.setLevel(src.level);
    r.levelKnob.update();
  }
  // Route AU MOINS vers son propre deck (une vieille assignation vide
  // rendait le FX muet — « le fx ne marche que sur le master »)
  engine.fxAssign[u][u] = true;
  f.setEnabled(true);
  const b = uiRefs.fxUnits[u].onBtn;
  b.textContent = 'ON';
  b.classList.add('on');
  engine.updateFxSends();
  return `deck ${u + 1}`;
}

// Échelle de durées du FX MASTER (même échelle que le panneau : 1/4 → 32)
const MASTER_FX_BEATS = [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32];
function masterFxBeatsStep(dir) {
  const u = engine.ensureMasterFx();
  const idx = MASTER_FX_BEATS.findIndex((v) => Math.abs(v - u.beatsMult) < 0.01);
  const next = Math.max(0, Math.min(MASTER_FX_BEATS.length - 1, (idx < 0 ? 1 : idx) + dir));
  if (idx === next) return false;
  u.setBeatsMult(MASTER_FX_BEATS[next]);
  const b = MASTER_FX_BEATS[next];
  flashStatus(`FX MASTER — durée ${b >= 1 ? b : `1/${Math.round(1 / b)}`} temps`);
  return true;
}
const tempoHintAt = [0, 0, 0, 0]; // limiteur de l'indicateur de reprise tempo
const midi = new MidiManager({
  press(action, deck, on) {
    const i = deck == null ? activeDeck : deck;
    const d = engine.decks[i];
    if (!d) return;
    engine.resume();
    switch (action) {
      case 'play': if (on) { d.scrubEnd(); d.togglePlay(); } break;
      case 'jogTouch':
        // VRAI toucher du disque (capteur note 54) : POSE = le son se coupe
        // et le disque devient la tête de lecture — RELÂCHE = reprise pile
        // où la main a laissé le son, placement adopté (phase gelée)
        if (!d.buffer) {
          // Toucher sur un deck VIDE : le DIRE au lieu d'un silence mystère
          // (bouton DECK matériel basculé sur un deck sans son chargé)
          if (on) flashStatus(`🖐 Disque → deck ${i + 1} : AUCUN son chargé ici (bouton DECK de la platine ?)`);
          break;
        }
        midiJogTouchAt = performance.now();
        if (on) {
          midiJogTouchHeld[i] = true;
          clearTimeout(midiScratchTimer[i]);
          clearTimeout(midiJogArmTimer[i]); // annule une reprise en attente (anti-rebond)
          // COUPURE INSTANTANÉE à la pose (exigence d'origine de David) —
          // l'anti-rebond est côté RELÂCHER : un capteur qui « rebondit »
          // pendant la pose ne relance plus la lecture par à-coups
          if (!midiJogState[i]) {
            midiJogState[i] = { wasPlaying: d.playing, pos: d.currentTime() };
            if (d.playing) d.pause();
            if (scratchSound) d.scrubStart();
            engine.jogHold = true;
            flashStatus(`🖐 Disque → deck ${i + 1}`);
          }
        } else {
          midiJogTouchHeld[i] = false;
          clearTimeout(midiScratchTimer[i]);
          // REPRISE DIFFÉRÉE de 60 ms : si le capteur re-presse aussitôt
          // (rebond), la reprise est annulée — le scratch continue sans à-coup
          clearTimeout(midiJogArmTimer[i]);
          midiJogArmTimer[i] = setTimeout(() => {
            if (midiJogTouchHeld[i]) return; // re-pressé entre-temps
            const s2 = midiJogState[i];
            midiJogState[i] = null;
            if (!s2) return;
            if (s2.raf) cancelAnimationFrame(s2.raf);
            d.scrubEnd();
            d.seek(Math.max(0, s2.pos));
            if (s2.wasPlaying) d.play();
            engine.jogHold = false;
            for (let k = 0; k < 4; k++) engine.reanchorSync(k);
          }, 60);
        }
        break;
      case 'select':
        // CHANNEL SELECT : la FLX6 envoie une note par position — le deck
        // arrive donc directement du contrôleur, rien à compter côté logiciel
        if (on) {
          midiFxTarget = i; // le FX de la platine vise CE deck désormais
          setActiveDeck(i);
          // Un effet déjà actif SUIT le sélecteur : il se déplace tout seul
          // vers la nouvelle cible (réglages et niveau conservés)
          const cur = platineFxCurrent();
          if (cur && !(cur.kind === 'deck' && cur.u === i)) {
            const src = { type: cur.fx.type, beatsMult: cur.fx.beatsMult, level: cur.fx.level };
            platineFxOff();
            platineFxOnTarget(src);
            flashStatus(`CHANNEL SELECT — deck ${i + 1} ACTIF (le FX suit)`);
          } else {
            flashStatus(`CHANNEL SELECT — deck ${i + 1} ACTIF`);
          }
        }
        break;
      case 'selectMaster':
        if (on) {
          midiFxTarget = 'master';
          const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
          if (mi != null) setActiveDeck(mi);
          const cur = platineFxCurrent();
          if (cur && cur.kind !== 'master') {
            const src = { type: cur.fx.type, beatsMult: cur.fx.beatsMult, level: cur.fx.level };
            platineFxOff();
            platineFxOnTarget(src);
            flashStatus('CHANNEL SELECT — MASTER (le FX suit sur tout le mix)');
          } else {
            flashStatus('CHANNEL SELECT — MASTER');
          }
        }
        break;
      case 'shift':
        // État SHIFT global (un côté ou l'autre) : modifie browse/CUE/SYNC
        midiShiftHeld = on;
        break;
      case 'cueBack':
        // SHIFT+CUE matériel (note 72) : retour au tout début, à l'arrêt
        if (on && d.buffer) {
          d.pause();
          d.seek(0);
          flashStatus(`⏮ Deck ${i + 1} — retour au début`);
        }
        break;
      case 'cue':
        if (midiShiftHeld) {
          // SHIFT+CUE = retour au DÉBUT du morceau, à l'arrêt (rekordbox)
          if (on && d.buffer) {
            d.pause();
            d.seek(0);
            flashStatus(`⏮ Deck ${i + 1} — retour au début`);
          }
          break;
        }
        midiCue(i, on);
        break;
      case 'sync':
        // TOGGLE (réglage David) : appui = sync, re-appui = désync — le
        // tempo reste où il est, pas besoin de SHIFT
        if (on) {
          if (d.synced) {
            d.synced = false;
            flashStatus(`Deck ${i + 1} — SYNC OFF`);
          } else {
            syncDeck(i);
          }
        }
        break;
      case 'master': if (on) engine.setMaster(i); break;
      case 'grid':
        // Même moteur que le bouton GRID écran : gère AUSSI les grilles
        // dynamiques (l'ancien code n'écrivait que beatOffset = no-op sur
        // quasi tous les morceaux) et SAUVEGARDE le calage
        if (on && deckUI[i]) deckUI[i].recalGrid();
        break;
      case 'load': if (on) loadSelectedToDeck(i); break;
      // Encodeur bibliothèque : APPUI = ENTRER (dossier, playlist locale ou
      // SoundCloud) — il ne charge JAMAIS un morceau, les boutons LOAD font ça
      case 'browsePush':
        if (on) {
          const t = library.selectedTrack();
          if (!t) break;
          if (t.fsUpRow) folderUp();
          else if (t.scRootRow) openSoundCloud();
          else if (t.scAccountRow) openScAccount(t.acctIdx);
          else if (t.scLikes) openScLikes(t.acctIdx);
          else if (t.plRootRow) openPlaylistsRoot();
          else if (t.fsRow) enterFolder(t.path);
          else if (t.plRow) openLocalPlaylist(t.pl);
          else if (t.scPlaylist) openScPlaylist(t.permalink, t.acctIdx);
          else flashStatus('Morceau sélectionné — utilise un bouton LOAD pour le charger');
        }
        break;
      // RETOUR : sortir de la playlist ouverte, remonter d'un dossier —
      // et depuis SoundCloud/Playlists/Historique, revenir aux RACINES
      case 'browseBack':
        if (on) {
          const plBack = document.getElementById('btn-pl-back');
          const scBack = document.getElementById('btn-sc-back');
          if (plBack && !plBack.classList.contains('hidden')) plBack.click();
          else if (scBack && !scBack.classList.contains('hidden')) scBack.click();
          else if (library.mode !== 'local') {
            setLibTab('local');
            library.showRoots();
          } else if (!folderUp()) flashStatus('Bibliothèque — racines (tout en haut)');
        }
        break;
      // VIEW : masque / réaffiche l'explorateur — les decks prennent alors
      // TOUT l'espace (la rangée bibliothèque disparaît de la grille)
      case 'viewToggle':
        if (on) {
          const lib = document.getElementById('library');
          const appEl = document.getElementById('app');
          if (lib && appEl) {
            lib.classList.toggle('hidden');
            appEl.classList.toggle('lib-hidden', lib.classList.contains('hidden'));
            flashStatus(lib.classList.contains('hidden')
              ? 'VIEW — plein écran decks (bibliothèque masquée)' : 'VIEW — bibliothèque affichée');
          }
        }
        break;
      // Boutons de MODE des pads (HOT CUE / BEAT JUMP / LOOP / KEY) : le
      // changement s'affiche à l'écran — les onglets du deck s'allument
      case 'padHotcue': if (on) { deckUI[i].padMode = 'hotcue'; renderPads(i); setActiveDeck(i); } break;
      case 'padJump': if (on) { deckUI[i].padMode = 'jump'; renderPads(i); setActiveDeck(i); } break;
      case 'padLoop': if (on) { deckUI[i].padMode = 'loop'; renderPads(i); setActiveDeck(i); } break;
      case 'padKey': if (on) { deckUI[i].padMode = 'key'; renderPads(i); setActiveDeck(i); } break;
      case 'padFx': if (on) { deckUI[i].padMode = 'fx'; renderPads(i); setActiveDeck(i); } break;
      case 'padSmp': if (on) { deckUI[i].padMode = 'smp'; renderPads(i); setActiveDeck(i); } break;
      case 'loopIn': if (on) loopIn(i); break;
      case 'loopOut': if (on) loopOut(i); break;
      case 'reloop':
        // RELOOP/EXIT : sort de la boucle, ou RELANCE la dernière posée
        if (on) {
          if (d.looping) {
            d.exitLoop();
          } else if (d.loopEnd > d.loopStart && d.loopEnd > 0) {
            d.setLoop(d.loopStart, d.loopEnd);
          }
        }
        break;
      case 'fxOn':
        // Bouton FX platine : UN SEUL effet à la fois, sur la cible du
        // sélecteur. Re-appui sur la même cible = coupé. Le NIVEAU vient
        // de la jauge, jamais d'une valeur par défaut.
        if (on) {
          const targetOn = midiFxTarget === 'master'
            ? !!(engine.masterFx && engine.masterFx.enabled)
            : engine.fx[midiFxUnit()].enabled;
          if (targetOn) {
            platineFxOff();
            flashStatus('FX coupé (platine)');
          } else {
            const cur = platineFxCurrent();
            const src = cur ? { type: cur.fx.type, beatsMult: cur.fx.beatsMult, level: cur.fx.level } : null;
            platineFxOff();
            const where = platineFxOnTarget(src);
            const lvl = midiFxTarget === 'master' ? engine.masterFx.level : engine.fx[midiFxUnit()].level;
            flashStatus(`FX ACTIVÉ → ${where}${lvl === 0 ? ' — monte la jauge pour l\'entendre' : ''}`);
          }
        }
        break;
      case 'keyUp': if (on && deckUI[i].applyKey) deckUI[i].applyKey(1); break;
      case 'keyDn': if (on && deckUI[i].applyKey) deckUI[i].applyKey(-1); break;
      case 'bpmUp': if (on) masterBpmNudge(1); break;
      case 'bpmDn': if (on) masterBpmNudge(-1); break;
      // BEAT ◄ / ► de la section FX : durée de l'effet du deck choisi au
      // CHANNEL SELECT ÷2 / ×2 (position MASTER = FX du mix)
      case 'fxBeatsDn':
        if (on) {
          const ok = midiFxTarget === 'master' ? masterFxBeatsStep(-1) : gpFxBeatsStep(midiFxUnit(), -1) !== false;
          midiBeatFlash(6, ok);
        }
        break;
      case 'fxBeatsUp':
        if (on) {
          const ok = midiFxTarget === 'master' ? masterFxBeatsStep(1) : gpFxBeatsStep(midiFxUnit(), 1) !== false;
          midiBeatFlash(7, ok);
        }
        break;
      default:
        if (action.startsWith('padDel')) {
          // SHIFT+pad physique : efface le hot cue / le sample du slot
          const idx = Number(action.slice(6)) - 1;
          if (on && !Number.isNaN(idx)) padClear(i, idx);
          break;
        }
        if (action.startsWith('pad')) {
          let idx = Number(action.slice(3)) - 1;
          if (Number.isNaN(idx)) break;
          // SÉRIGRAPHIE FLX6 : les 8 pads physiques suivent ce qui est
          // IMPRIMÉ sur la platine, pas l'ordre des 10 pads de l'écran.
          // BEAT JUMP en PAIRES ◄1► ◄2► ◄4► ◄8► (en temps) ; PAD FX =
          // ROLL½, SWEEP, FLANGER, V.BRAKE / ECHO¼, ECHO½, REVERB,
          // BACKSPIN ; BEAT LOOP = tailles 1-16 puis IN/OUT/✕ ; KEY = ±4.
          const HW_PAD_MAP = {
            jump: [3, 6, 2, 7, 1, 8, 0, 9],
            fx: [0, 1, 2, 4, 5, 6, 8, 9],
            loop: [5, 6, 7, 8, 9, 0, 1, 2],
            key: [1, 2, 3, 4, 5, 6, 7, 8]
          };
          const hw = HW_PAD_MAP[deckUI[i].padMode];
          if (hw && idx < 8) idx = hw[idx];
          // Mode PAD FX : le pad physique TIENT l'effet (appui/relâcher),
          // comme sur Rekordbox — les autres modes déclenchent à l'appui
          if (deckUI[i].padMode === 'fx') padFxPress(i, idx, on);
          else if (on) padPress(i, idx);
        }
    }
  },
  abs(action, deck, v) {
    const i = deck == null ? activeDeck : deck;
    const d = engine.decks[i];
    if (!d) return;
    // (voir case 'tempo' : indicateur de reprise de la jauge — dans quel
    // sens la ramener, exprimé en BPM, « monter ou descendre comparé au
    // master ». Affiché au plus 2×/s par deck.)
    function tempoPickupHint(idx, target, cur) {
      const nowH = performance.now();
      if (nowH - (tempoHintAt[idx] || 0) < 500) return;
      tempoHintAt[idx] = nowH;
      const dk = engine.decks[idx];
      if (!dk.bpm) return;
      const bAt = (dk.bpm * target).toFixed(1);
      const bTo = (dk.bpm * cur).toFixed(1);
      flashStatus(`🎚 Deck ${idx + 1} : jauge tempo à ${bAt} BPM → amène-la sur ${bTo} pour la reprendre`);
    }
    switch (action) {
      case 'volume': d.setVolume(v); stripUI[i].fader.update(); break;
      case 'trim': d.setTrim(v * 2 - 1); stripUI[i].kTrim.update(); break;
      case 'eqHigh': d.setEq('high', v * 2 - 1); stripUI[i].kHigh.update(); break;
      case 'eqMid': d.setEq('mid', v * 2 - 1); stripUI[i].kMid.update(); break;
      case 'eqLow': d.setEq('low', v * 2 - 1); stripUI[i].kLow.update(); break;
      case 'filter': engine.setDeckColor(i, v * 2 - 1); stripUI[i].kFilt.update(); break;
      case 'tempo': {
        // SOFT TAKEOVER (reprise en douceur, comme rekordbox) : quand le
        // logiciel a changé le tempo dans le dos du fader (SYNC,
        // calibration, passation de master), la position PHYSIQUE ne
        // correspond plus. Sans garde, la PREMIÈRE re-déclaration de la
        // platine (state refresh au toucher de jog…) écrasait le BPM avec
        // la position du fader ET cassait le sync — « un nouveau BPM
        // intempestif selon l'état du bouton ». Le fader est donc IGNORÉ
        // tant que la jauge n'est pas REVENUE sur la valeur actuelle (ou
        // ne l'a pas croisée d'un geste) : on remet d'abord la jauge au
        // bon emplacement, et alors seulement elle reprend la main.
        const target = 0.5 + v;
        const cur = d.tempo;
        const nowT = performance.now();
        const pr = deckUI[i]._tempoPrev;
        deckUI[i]._tempoPrev = { v: target, t: nowT };
        // « croisée » = entre DEUX messages d'un MÊME geste (< 200 ms) —
        // une vieille position d'il y a des minutes ne compte pas
        const cross = pr && nowT - pr.t < 200
          && ((pr.v <= cur && cur <= target) || (target <= cur && cur <= pr.v));
        if (Math.abs(target - cur) > 0.005 && !cross) {
          tempoPickupHint(i, target, cur);
          break;
        }
        d.setTempo(target);
        d.synced = false;
        updateTempoLabel(i);
        break;
      }
      case 'crossfader':
        // AUCUN filtre : le fader physique est la VÉRITÉ. Les valeurs reçues
        // aux touchers de jog sont la platine qui re-déclare sa position
        // réelle — les appliquer est CORRECT (l'écran rejoint le matériel).
        engine.setCrossfader(v);
        xfFader.update();
        break;
      case 'masterVol': engine.setMasterVolume(v); uiRefs.master.volKnob.update(); break;
      case 'masterFilter':
        engine.setMasterFilter(v * 2 - 1);
        uiRefs.master.filterKnob.update();
        break;
      case 'fxLevel': {
        // Le knob de niveau FX vise le deck choisi au CHANNEL SELECT —
        // position MASTER = niveau du FX du mix entier
        if (midiFxTarget === 'master') {
          engine.ensureMasterFx().setLevel(v);
          break;
        }
        const u = midiFxUnit();
        engine.fx[u].setLevel(v);
        uiRefs.fxUnits[u].levelKnob.update();
        break;
      }
    }
  },
  rel(action, deck, delta) {
    if (action === 'browseZoom') {
      // SHIFT + molette (CC 100 dédié de la platine) = zoom des vagues,
      // en douceur : 15 % par cran
      waveZoom(delta > 0 ? 1 / 1.15 : 1.15);
      return;
    }
    if (action === 'browse') {
      library.moveSelection(Math.sign(delta));
      updateSelectionUI();
      return;
    }
    if (action === 'jogBend') {
      // CÔTÉ du disque : nudge DOUX façon CDJ — mêmes règles que le stick
      // manette (verrou sync suspendu, le placement est ADOPTÉ au relâcher)
      const i = deck == null ? activeDeck : deck;
      const d = engine.decks[i];
      if (!d.buffer || delta === 0) return;
      engine.resume();
      if (!d.playing) {
        d.seek(Math.max(-3600, d.currentTime() + delta * 0.005));
        return;
      }
      if (!gpBend[i]) {
        gpBend[i] = { tempo: gpBaseTempo(d), synced: d.synced };
        engine.jogHold = true;
      }
      // On ne touche PLUS à d.synced pendant le geste (David : « il faut
      // pas toucher au sync au déplacement ») — jogHold suspend déjà le
      // verrou ; couper/remettre le sync relançait la calibration en boucle
      // Coefficient 0.0044 = le réglage de la TRANCHE validé par David
      // (« +25 % de plus ») — la tranche route maintenant sur jogBend
      d.setTempo(gpBend[i].tempo * (1 + Math.max(-8, Math.min(8, delta)) * 0.0044));
      clearTimeout(midiJogTimer[i]);
      midiJogTimer[i] = setTimeout(() => {
        const b = gpBend[i];
        if (!b) return;
        d.setTempo(b.tempo);
        d.synced = b.synced;
        gpBend[i] = null;
        engine.jogHold = false;
        for (let k = 0; k < 4; k++) engine.reanchorSync(k);
      }, 160);
      return;
    }
    if (action === 'jog') {
      const i = deck == null ? activeDeck : deck;
      const d = engine.decks[i];
      if (!d.buffer || delta === 0) return;
      engine.resume();
      // C'est le CAPTEUR DE TOUCHER qui décide (doctrine finale) :
      let st = midiJogState[i];
      // Toucher en attente d'armement + rotation = INTENTION claire de
      // scratch : on arme tout de suite, sans attendre les 120 ms
      if (!st && midiJogTouchHeld[i]) {
        clearTimeout(midiJogArmTimer[i]);
        st = midiJogState[i] = { wasPlaying: d.playing, pos: d.currentTime() };
        if (d.playing) d.pause();
        if (scratchSound) d.scrubStart();
        engine.jogHold = true;
      }
      if (st) {
        // MAIN POSÉE : SCRATCH à INERTIE — les crans n'écrivent pas la
        // position, ils poussent une VITESSE (delta × |delta| : la force de
        // rotation compte), et une friction la ramène à zéro en ~180 ms :
        // le disque GLISSE brièvement jusqu'au stop au lieu de freiner sec.
        // COURBE MIXTE linéaire + cubique (itération David : « encore trop
        // rapide ET trop lent ») : le lent remonte ×4 (terme linéaire), le
        // rapide redescend ÷2 (cube adouci) — pente continue entre les deux
        const mag = Math.min(10, Math.abs(delta));
        st.vel = (st.vel || 0) + Math.sign(delta) * (mag * 0.003 + mag * mag * mag * 0.00032);
        if (!st.raf) {
          st.t = performance.now();
          const step = () => {
            if (midiJogState[i] !== st) return; // geste terminé
            const now2 = performance.now();
            const dt2 = Math.min(0.05, (now2 - st.t) / 1000);
            st.t = now2;
            if (Math.abs(st.vel) > 0.02) {
              st.pos = Math.max(0, Math.min(d.duration, st.pos + st.vel * dt2));
              if (scratchSound) d.scrubMove(st.pos);
              else d.seek(st.pos);
            }
            st.vel *= Math.pow(0.001, dt2 / 0.25); // friction adoucie : glisse ~250 ms (moins « sec »)
            st.raf = requestAnimationFrame(step);
          };
          st.raf = requestAnimationFrame(step);
        }
        return;
      }
      // MAIN NON POSÉE, dessus du disque : DÉPLACEMENT dans le son —
      // avancer / reculer vite, comme la recherche d'un CDJ. Le BPM n'est
      // JAMAIS touché (David : « au lieu de se déplacer sur le son tu
      // changes le BPM pour avancer ou reculer » — corrigé). Les crans
      // s'accumulent et la position saute par petits pas réguliers.
      if (!d.playing) {
        d.seek(Math.max(0, d.currentTime() + delta * 0.005));
        return;
      }
      engine.jogHold = true;
      midiSeekAcc[i] += delta * 0.012;
      if (!midiSeekTimer[i]) {
        midiSeekTimer[i] = setTimeout(() => {
          midiSeekTimer[i] = null;
          const off = midiSeekAcc[i];
          midiSeekAcc[i] = 0;
          if (off) d.seek(Math.max(0, d.currentTime() + off));
          engine.jogHold = false;
          for (let k = 0; k < 4; k++) engine.reanchorSync(k);
        }, 70);
      }
    }
  }
});

midi.onStatus = (name) => {
  const chip = document.getElementById('midi-status');
  if (!chip) return;
  chip.textContent = name ? `🎹 ${name}` : '🎹 Aucun contrôleur';
  chip.className = name ? 'pad-on' : 'pad-off';
  renderMidiTable();
};
midi.init();

// --- LED DE LA PLATINE (façon rekordbox — « les boutons qui s'allument ») ---
// Protocole Pioneer : chaque bouton s'allume en recevant SA note. Rafraîchi
// 10×/s ; setLed n'émet que les CHANGEMENTS (cache) et l'anti-écho avale
// les retours — zéro appui fantôme possible.
const LED_PAD_CH = [7, 9, 11, 13];
const LED_MODE_NOTES = { hotcue: 27, fx: 30, jump: 32, smp: 34, loop: 109, key: 111 };
const LED_PAD_BASE = { hotcue: 0, fx: 16, jump: 32, smp: 48, loop: 96 };
function ledTick() {
  if (!midi.outputs || !midi.outputs.length) return;
  const blink = Math.floor(performance.now() / 800) % 2 === 0;
  for (let i = 0; i < 4; i++) {
    const d = engine.decks[i];
    const ui = deckUI[i];
    if (!d || !ui) continue;
    const loaded = !!d.buffer;
    // PLAY (notes 11 + 14) : fixe en lecture, clignote à l'arrêt si un son
    // est chargé — exactement rekordbox
    const play = d.playing || (loaded && blink);
    midi.setLed(i, 11, play);              // PLAY (note 11 — table finale)
    midi.setLed(i, 14, loaded);            // CUE (note 14 — table finale)
    midi.setLed(i, 12, loaded);            // CUE (ancienne supposition)
    midi.setLed(i, 88, !!d.synced);        // BEAT SYNC
    midi.setLed(i, 16, !!d.looping);       // LOOP IN
    midi.setLed(i, 17, !!d.looping);       // LOOP OUT
    midi.setLed(i, 77, !!d.looping);       // RELOOP
    midi.setLed(15, i, loaded);            // « track loaded » (canal 15)
    // Boutons de MODE des pads : celui de l'onglet actif est allumé
    for (const mode of Object.keys(LED_MODE_NOTES)) {
      midi.setLed(i, LED_MODE_NOTES[mode], ui.padMode === mode);
    }
    // PADS : allumés selon le CONTENU du mode (hot cue posé, sample chargé,
    // sinon pad disponible)
    const base = LED_PAD_BASE[ui.padMode];
    if (base != null) {
      for (let p = 0; p < 8; p++) {
        let on = true;
        if (ui.padMode === 'hotcue') on = !!(d.hotCues && d.hotCues[p] != null);
        else if (ui.padMode === 'smp') on = !!samplerBank[p];
        midi.setLed(LED_PAD_CH[i], base + p, on);
      }
    }
  }
  // FX : les sections CLIGNOTENT AU TEMPS du master quand un effet est
  // actif — la « magie de la platine »
  const mi2 = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const md = mi2 != null ? engine.decks[mi2] : null;
  const ph = md && md.playing ? engine._beatPhase(md) : null;
  const fxActive = engine.fx.some((u) => u && u.enabled)
    || !!(engine.masterFx && engine.masterFx.enabled);
  const fxLed = fxActive && (ph != null ? ph < 0.5 : blink);
  midi.setLed(4, 71, fxLed);
  midi.setLed(5, 71, fxLed);
}
// 4 Hz suffisent (et la platine répond à CHAQUE émission par une rafale
// de re-déclarations : moins on parle, mieux elle écoute les boutons)
setInterval(ledTick, 250);

// --- Bascule 2 decks / 4 decks ---
const btnDeckCount = document.getElementById('btn-deckcount');

// --- 📨 DEMANDES DU PUBLIC (notre CoBeat gratuit) : les invités votent
// depuis http://IP:8722/guest — le DJ voit tout ici et charge en un clic ---
let guestData = { votes: [], msgs: [] };
let guestSeen = 0;
const btnGuests = document.createElement('button');
btnGuests.id = 'btn-guests';
btnGuests.innerHTML = 'DEMANDES <b id="guest-count">0</b>';
btnGuests.title = 'Demandes du public : tes invités votent leurs sons depuis leur téléphone (page /guest)';
btnDeckCount.insertAdjacentElement('afterend', btnGuests);
const guestPanel = document.createElement('div');
guestPanel.id = 'guest-panel';
guestPanel.className = 'hidden';
document.body.appendChild(guestPanel);

function guestCount() {
  return guestData.votes.reduce((s, v) => s + v.votes, 0) + guestData.msgs.length;
}
function renderGuestPanel() {
  const cnt = document.getElementById('guest-count');
  if (cnt) cnt.textContent = String(guestCount());
  if (guestPanel.classList.contains('hidden')) return;
  guestPanel.textContent = '';
  const head = document.createElement('div');
  head.className = 'gp-head';
  head.innerHTML = '<b>DEMANDES DU PUBLIC</b><span id="gp-url"></span>';
  const bClear = document.createElement('button');
  bClear.textContent = 'Vider';
  bClear.addEventListener('click', async () => {
    guestData = await window.api.guestClear();
    renderGuestPanel();
  });
  const bClose = document.createElement('button');
  bClose.textContent = '✕';
  bClose.addEventListener('click', () => guestPanel.classList.add('hidden'));
  head.append(bClear, bClose);
  guestPanel.appendChild(head);
  // QR CODE : les invités scannent l'écran et tombent direct sur /guest
  const qrWrap = document.createElement('div');
  qrWrap.className = 'gp-qr';
  guestPanel.appendChild(qrWrap);
  window.api.remoteStart().then(async (r) => {
    const u = document.getElementById('gp-url');
    if (u) u.textContent = `Invités : ${r.url}/guest`;
    const qr = await window.api.guestQr(`${r.url}/guest`);
    if (qr) {
      qrWrap.innerHTML = `<img src="${qr}" alt="QR invités">
        <span>Scanne-moi pour demander ton son</span>`;
    }
  });
  if (!guestData.votes.length && !guestData.msgs.length) {
    const e = document.createElement('div');
    e.className = 'gp-empty';
    e.textContent = 'Aucune demande pour l\'instant — fais scanner le QR code à tes potes !';
    guestPanel.appendChild(e);
  }
  guestData.votes.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'gp-row';
    row.innerHTML = `<span class="gp-votes">${v.votes} ▲</span><span class="gp-name"></span><span class="gp-bpm">${v.bpm ?? ''}</span>`;
    row.querySelector('.gp-name').textContent = v.name;
    row.title = 'Clic : charger sur le deck actif';
    row.addEventListener('click', () => {
      const tr = [...library.tracks, ...library.scTracks].find(
        (t) => !t.scPlaylist && !t.scAccountRow && t.name === v.name);
      if (tr) {
        loadTrackToDeck(activeDeck, tr);
        guestPanel.classList.add('hidden');
      } else {
        flashStatus(`« ${v.name} » introuvable dans la bibliothèque actuelle`);
      }
    });
    guestPanel.appendChild(row);
  });
  guestData.msgs.slice().reverse().forEach((m) => {
    const row = document.createElement('div');
    row.className = 'gp-msg';
    row.textContent = `» ${m.msg}`;
    guestPanel.appendChild(row);
  });
}
btnGuests.addEventListener('click', () => {
  guestPanel.classList.toggle('hidden');
  renderGuestPanel();
});
window.api.onGuestReq((d) => {
  const before = guestCount();
  guestData = d;
  const now = guestCount();
  if (now > before) {
    const top = d.votes[0];
    flashStatus(top
      ? `Nouvelle demande — en tête : « ${top.name} » (${top.votes} votes)`
      : 'Nouveau message du public');
  }
  renderGuestPanel();
});
window.api.guestGet().then((d) => {
  guestData = d;
  renderGuestPanel();
});

function applyDeckCount(n, silent) {
  deckCount = n;
  localStorage.setItem('deckCount', String(n));
  document.body.classList.toggle('two-decks', n === 2);
  btnDeckCount.textContent = n === 2 ? '2 DECKS' : '4 DECKS';
  if (n === 2) {
    // On coupe proprement les decks cachés
    [2, 3].forEach((j) => {
      if (engine.decks[j].playing) engine.decks[j].pause();
      // Un deck caché ne doit rester ni sélectionné ni coupé (CUT)
      gpSelOwners.forEach((s) => s.delete(j));
      gpSelNeutral.delete(j);
      gpSelSync();
      if (gpCutStore.has(j)) {
        engine.decks[j].setVolume(gpCutStore.get(j));
        gpCutStore.delete(j);
      }
      stripUI[j].el.classList.remove('gp-sel');
    });
    if (activeDeck > 1) setActiveDeck(0);
    // Ramène les curseurs manette sur des colonnes visibles
    for (const st of gamepad.pads.values()) {
      if (st.deck > 1) st.deck = 0;
      if (st.cur.r > 0 && st.cur.c > 1) st.cur.c = st.deck;
    }
  }
  // Le layout change : les canvas doivent repartir de zéro (signatures et
  // caches invalidés, sinon des bitmaps de largeur 0 traînent)
  invalidateWaves();
  if (!silent) flashStatus(n === 2 ? 'Mode 2 decks — plus grand, plus simple' : 'Mode 4 decks — la totale');
}

btnDeckCount.addEventListener('click', () => applyDeckCount(deckCount === 2 ? 4 : 2));
applyDeckCount(deckCount, true);

// --- Enregistrement du mix (sortie master -> fichier) ---
const btnRec = document.getElementById('btn-rec');
const recTime = document.getElementById('rec-time');
let recorder = null;
let recStart = 0;

btnRec.addEventListener('click', async () => {
  engine.resume();
  if (!recorder) {
    const chunks = [];
    recorder = new MediaRecorder(engine.recDest.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 192000
    });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const data = new Uint8Array(await blob.arrayBuffer());
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
      const res = await window.api.saveRecording(data, `TurboMix ${stamp}.webm`);
      flashStatus(res.ok ? `🎙️ Mix enregistré : ${res.path}` : 'Enregistrement annulé');
    };
    recorder.start(1000);
    recStart = performance.now();
    btnRec.classList.add('on');
    recTime.classList.remove('hidden');
    flashStatus('🔴 Enregistrement du mix en cours…');
  } else {
    recorder.stop();
    recorder = null;
    btnRec.classList.remove('on');
    recTime.classList.add('hidden');
  }
});

const wzScratch = document.getElementById('wz-scratch');
function refreshScratchBtn() {
  wzScratch.textContent = scratchSound ? '🔊' : '🔇';
  wzScratch.classList.toggle('on', scratchSound);
}
wzScratch.addEventListener('click', () => {
  scratchSound = !scratchSound;
  localStorage.setItem('scratchSound', scratchSound ? '1' : '0');
  refreshScratchBtn();
  flashStatus(scratchSound
    ? 'Scratch sonore activé : tu entends le son en déplaçant la piste'
    : 'Scratch silencieux : le son reprend seulement quand tu lâches');
});
refreshScratchBtn();

// ---------------------------------------------------------------------------
// Clavier (pratique sans manette)
// ---------------------------------------------------------------------------

// Raccourci pads : bascule l'onglet du deck actif (miroir des boutons de
// mode de la platine — H/J/L/K/F/M)
function kbdPadMode(mode) {
  deckUI[activeDeck].padMode = mode;
  renderPads(activeDeck);
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
      || t.isContentEditable) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  // F2-F11 = pads 1 à 10 du deck actif (dans le mode d'onglet courant)
  const fPad = /^F([2-9]|1[01])$/.exec(e.key);
  if (fPad && !e.repeat) {
    e.preventDefault();
    padPress(activeDeck, Number(fPad[1]) - 2);
    return;
  }
  switch (e.key) {
    case 'h': case 'H': kbdPadMode('hotcue'); break;
    case 'j': case 'J': kbdPadMode('jump'); break;
    case 'l': case 'L': kbdPadMode('loop'); break;
    case 'k': case 'K': kbdPadMode('key'); break;
    case 'f': case 'F': kbdPadMode('fx'); break;
    case 'm': case 'M': kbdPadMode('smp'); break;
  }
  switch (e.key) {
    case '1': case '2': case '3': case '4':
      setActiveDeck(Number(e.key) - 1);
      break;
    case ' ':
      e.preventDefault();
      playDeck(activeDeck);
      break;
    case 'ArrowUp':
      e.preventDefault();
      library.moveSelection(-1);
      updateSelectionUI();
      break;
    case 'ArrowDown':
      e.preventDefault();
      library.moveSelection(1);
      updateSelectionUI();
      break;
    case 'Enter':
      loadSelectedToDeck(activeDeck);
      break;
    case 'c': case 'C':
      engine.decks[activeDeck].cue();
      break;
    case 's': case 'S':
      syncDeck(activeDeck);
      break;
    case '+': case '=':
      waveZoom(1 / 1.35);
      break;
    case '-':
      waveZoom(1.35);
      break;
    case 'F1':
      e.preventDefault();
      toggleHelp();
      break;
  }
});

document.addEventListener('pointerdown', () => engine.resume(), { once: true });

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

for (let i = 0; i < 4; i++) buildDeckPanel(i);
buildMixer();
buildFxBar();
setActiveDeck(0);
deckUI.forEach((_, i) => renderPads(i));
samplerInit(); // recharge les samples posés sur les pads (chemins mémorisés)
// Fermeture : écrit en synchrone tout calage de grille encore en attente
window.addEventListener('beforeunload', () => library.flushSave());
renderHelp();
// Premier positionnement des faders une fois la mise en page calculée
requestAnimationFrame(() => {
  stripUI.forEach((_, i) => refreshStrip(i));
  xfFader.update();
});

document.getElementById('btn-folder').addEventListener('click', () => library.chooseFolder());
document.getElementById('btn-help').addEventListener('click', toggleHelp);
document.getElementById('btn-close-help').addEventListener('click', toggleHelp);

// --- Paramètres : palette, sortie audio, micros, télécommande ---
const settingsOverlay = document.getElementById('settings-overlay');

function invalidateWaves() {
  deckUI.forEach((ui) => {
    ui._zoomSig = null;
    ui._overSig = null;
    ui.over._cache = null;
  });
}

// --- Analyse : plage BPM + ré-analyse globale ---
const setBpmRange = document.getElementById('set-bpmrange');
const storedRange = localStorage.getItem('bpmRange');
setBpmRange.value = storedRange && storedRange !== 'auto' ? storedRange : '85-170';
setBpmRange.addEventListener('change', (e) => {
  localStorage.setItem('bpmRange', e.target.value);
  flashStatus('Plage BPM changée — clique « Tout ré-analyser » ou recharge les morceaux pour appliquer');
});
document.getElementById('set-reanalyze').addEventListener('click', () => {
  const n = library.invalidateAnalysis();
  flashStatus(`Ré-analyse lancée (${n} morceaux) — elle tourne en arrière-plan`);
});
document.getElementById('set-rbimport').addEventListener('click', async () => {
  flashStatus('Lecture des analyses Rekordbox…');
  try {
    const n = await library.importRekordboxGrids();
    flashStatus(n
      ? `${n} grilles Rekordbox importées ✔ (recharge les decks pour les appliquer)`
      : 'Aucune analyse Rekordbox ne correspond aux morceaux de la bibliothèque');
  } catch (e) {
    flashStatus(`Import Rekordbox impossible : ${e.message}`);
  }
});
const setGridOffset = document.getElementById('set-gridoffset');
setGridOffset.value = Number(localStorage.getItem('gridOffsetMs')) || 0;
setGlobalGridOffset((Number(setGridOffset.value) || 0) / 1000);
setGridOffset.addEventListener('change', () => {
  const ms = Math.max(-60, Math.min(60, Number(setGridOffset.value) || 0));
  localStorage.setItem('gridOffsetMs', String(ms));
  setGlobalGridOffset(ms / 1000);
  flashStatus(`Décalage global de grille : ${ms} ms`);
});

// --- Comportement ---
const setAutoStems = document.getElementById('set-autostems');
setAutoStems.checked = localStorage.getItem('autoStems') !== '0';
setAutoStems.addEventListener('change', () => {
  localStorage.setItem('autoStems', setAutoStems.checked ? '1' : '0');
});
const setSnapRelease = document.getElementById('set-snaprelease');
setSnapRelease.checked = localStorage.getItem('snapRelease') !== '0';
setSnapRelease.addEventListener('change', () => {
  localStorage.setItem('snapRelease', setSnapRelease.checked ? '1' : '0');
});
const setWaveSize = document.getElementById('set-wavesize');
setWaveSize.value = localStorage.getItem('waveSize') || 'normal';
document.body.classList.toggle('waves-lg', setWaveSize.value === 'grand');
setWaveSize.addEventListener('change', () => {
  localStorage.setItem('waveSize', setWaveSize.value);
  document.body.classList.toggle('waves-lg', setWaveSize.value === 'grand');
});

// Palette par défaut : RGB (verdict de David — « la couleur n'est plus en
// RGB comme tantôt ! ») ; ma migration automatique vers 'rekordbox' est
// ANNULÉE. La palette Rekordbox reste disponible dans ⚙ pour qui la veut.
if (!localStorage.getItem('wavePaletteChosen') && localStorage.getItem('wavePalette') === 'rekordbox') {
  localStorage.setItem('wavePalette', 'rgb');
}
setWavePalette(localStorage.getItem('wavePalette') || 'rgb');
document.getElementById('set-palette').value = localStorage.getItem('wavePalette') || 'rgb';
document.getElementById('set-palette').addEventListener('change', (e) => {
  localStorage.setItem('wavePalette', e.target.value);
  localStorage.setItem('wavePaletteChosen', '1'); // choix explicite : respecté à vie
  setWavePalette(e.target.value);
  invalidateWaves();
});

async function refreshDevices() {
  try {
    // Demande la permission micro une fois pour révéler les noms des périphériques
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outSel = document.getElementById('set-output');
    const current = localStorage.getItem('audioOutput') || '';
    outSel.innerHTML = '<option value="">Sortie par défaut</option>';
    devices.filter(d => d.kind === 'audiooutput').forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Sortie ${d.deviceId.slice(0, 6)}`;
      if (d.deviceId === current) o.selected = true;
      outSel.appendChild(o);
    });
    const mics = devices.filter(d => d.kind === 'audioinput');
    document.getElementById('set-mics').textContent = mics.length
      ? mics.map(m => m.label || 'Micro sans nom').join(' · ')
      : 'Aucun micro détecté';
  } catch (err) {
    document.getElementById('set-mics').textContent = 'Périphériques inaccessibles';
  }
}

document.getElementById('set-output').addEventListener('change', async (e) => {
  try {
    await engine.ctx.setSinkId(e.target.value || '');
    localStorage.setItem('audioOutput', e.target.value);
    flashStatus('Sortie audio changée');
  } catch (err) {
    flashStatus(`Sortie audio : ${err.message || err}`);
  }
});

// --- Tableau d'apprentissage MIDI ---
function renderMidiTable() {
  const table = document.getElementById('midi-learn-table');
  const info = document.getElementById('midi-device');
  if (!table) return;
  if (info) {
    info.textContent = midi.deviceName
      ? `Connecté : ${midi.deviceName}${/ddj|pioneer/i.test(midi.deviceName) ? ' (préréglage DDJ chargé)' : ''}`
      : 'Aucun contrôleur détecté — branche ta platine, elle apparaîtra ici';
  }
  table.textContent = '';
  if (!midi.deviceName) return;
  const sel = document.getElementById('midi-deck-sel').value;
  const deck = sel === 'g' ? null : Number(sel);
  const actions = sel === 'g' ? MIDI_ACTIONS_GLOBAL : MIDI_ACTIONS_DECK;
  actions.forEach(([action, label]) => {
    const row = document.createElement('div');
    row.className = 'midi-row';
    const bound = midi.bindingFor(action, deck);
    row.innerHTML = `
      <span class="midi-label"></span>
      <span class="midi-bind">${bound ? bound : '—'}</span>
      <button class="midi-learn" title="Apprendre : bouge le contrôle physique">🎯</button>
      <button class="midi-clear" title="Effacer">✕</button>
    `;
    row.querySelector('.midi-label').textContent = label;
    row.querySelector('.midi-learn').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.textContent = '👂…';
      const key = await midi.learn(action, deck);
      btn.textContent = '🎯';
      if (key) {
        row.querySelector('.midi-bind').textContent = key;
        flashStatus(`MIDI : « ${label} » lié à ${key}`);
      }
    });
    row.querySelector('.midi-clear').addEventListener('click', () => {
      midi.clearBinding(action, deck);
      row.querySelector('.midi-bind').textContent = '—';
    });
    table.appendChild(row);
  });
}
document.getElementById('midi-deck-sel').addEventListener('change', renderMidiTable);

document.getElementById('set-remote').addEventListener('click', async () => {
  const r = await window.api.remoteStart();
  document.getElementById('set-remote-url').textContent = `Sur ton téléphone : ${r.url}`;
});

document.getElementById('btn-settings').addEventListener('click', () => {
  settingsOverlay.classList.remove('hidden');
  refreshDevices();
  renderMidiTable();
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  midi.cancelLearn();
  settingsOverlay.classList.add('hidden');
});

// Restaure la sortie audio choisie précédemment
if (localStorage.getItem('audioOutput')) {
  engine.ctx.setSinkId(localStorage.getItem('audioOutput')).catch(() => {});
}

// --- Console téléphone : exécution des commandes reçues du téléphone ---
window.api.onRemoteCmd((c) => {
  const d = engine.decks[c.deck ?? 0];
  if (!d) return;
  engine.resume();
  switch (c.action) {
    case 'play': playDeck(c.deck ?? 0); break;
    case 'cue': d.cue(); break;
    case 'sync':
      if (d.synced) {
        d.synced = false;
        flashStatus(`📱 Deck ${(c.deck ?? 0) + 1} — SYNC OFF`);
      } else {
        syncDeck(c.deck);
      }
      break;
    case 'vol':
      d.setVolume(c.value);
      stripUI[c.deck].fader.update();
      break;
    case 'filter':
      engine.setDeckColor(c.deck, Math.max(-1, Math.min(1, c.value)));
      stripUI[c.deck].kFilt.update();
      break;
    case 'bass':
      // même règle que le logo / R1 : les basses passent à CE deck
      gpBassTo(c.deck);
      flashStatus(`📱 🔊 Basses → deck ${c.deck + 1}`);
      break;
    case 'jump': doBeatJump(c.deck, c.value); break;
    case 'hotcue': padPress(c.deck, c.value, 'hotcue', null); break;
    case 'pad':
      // pad générique : même moteur que les pads du PC (hotcue/loop/jump)
      padPress(c.deck, c.value, c.mode || 'hotcue', null);
      break;
    case 'loopin': loopIn(c.deck); break;
    case 'loopout': loopOut(c.deck); break;
    case 'tempo':
      d.setTempo(Math.max(0.5, Math.min(1.6, c.value)));
      d.synced = false;
      updateTempoLabel(c.deck);
      break;
    case 'trim':
      d.setTrim(Math.max(-1, Math.min(1, c.value)));
      stripUI[c.deck].kTrim.update();
      break;
    case 'eq': {
      d.setEq(c.band, Math.max(-1, Math.min(1, c.value)));
      const kn = c.band === 'high' ? 'kHigh' : c.band === 'mid' ? 'kMid' : 'kLow';
      stripUI[c.deck][kn].update();
      break;
    }
    case 'load': {
      const tr = library.filtered[c.value];
      // Seules les VRAIES pistes (path ou scId) se chargent depuis le
      // téléphone — jamais une ligne de navigation (playlist, compte 👤…)
      if (tr && !tr.scPlaylist && !tr.scAccountRow && tr.name && (tr.path || tr.scId)) {
        loadTrackToDeck(c.deck, tr);
      }
      break;
    }
    case 'mbpm': masterBpmNudge(c.value); break;
    case 'mvol':
      engine.setMasterVolume(c.value);
      uiRefs.master.volKnob.update();
      break;
    case 'xf':
      engine.setCrossfader(c.value);
      xfFader.update();
      break;
    case 'led':
      // Diagnostic : piloter une LED de la platine à la main (ch, note, on)
      midi.send([0x90 | (c.ch & 0x0f), c.note & 0x7f, c.on ? 0x7f : 0]);
      break;
    case 'rawmidi':
      // Diagnostic : trame MIDI brute (tableau d'octets)
      if (Array.isArray(c.bytes)) midi.send(c.bytes.map((b) => b & 0xff));
      break;
  }
});
setInterval(() => {
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const mDeck = mi != null ? engine.decks[mi] : null;
  window.api.remoteState({
    deckCount,
    mbpm: mDeck && mDeck.bpm ? (mDeck.bpm * mDeck.tempo).toFixed(1) : '—',
    mvol: engine.masterVolume,
    xf: engine.crossfader,
    libStamp: libRenderStamp,
    decks: engine.decks.map((d, i) => ({
      title: d.track ? d.track.name : '—',
      playing: d.playing,
      synced: d.synced,
      master: i === mi,
      bpm: d.effectiveBpm ? d.effectiveBpm.toFixed(1) : '--',
      bpmRaw: d.bpm || 0,
      beatOffset: d.beatOffset != null ? d.beatOffset : 0,
      t: d.currentTime(),
      dur: d.duration || 0,
      tempo: d.tempo || 1,
      vol: d.volume,
      filter: d.filterVal || 0,
      trim: d.trimVal || 0,
      eqh: d.eq.high,
      eqm: d.eq.mid,
      eql: d.eq.low,
      bassKilled: d.eq.low <= -0.9,
      wstamp: remoteWaveStamp[i],
      loopOn: !!d.looping,
      loopBeats: d._loopBeats || 0,
      cues: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => d.hotCues && d.hotCues[k] != null)
    }))
  });
}, 400);
const libSearchEl = document.getElementById('lib-search');
libSearchEl.placeholder = 'Rechercher… (Entrée = TOUT SoundCloud)';
libSearchEl.addEventListener('input', (e) => library.setSearch(e.target.value));
// Entrée = moteur de recherche CATALOGUE SoundCloud (au-delà des playlists)
libSearchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = libSearchEl.value.trim();
  if (!q) return;
  e.preventDefault();
  library.searchSc(q);
});

// --- Explorateur en arborescence (style Rekordbox) ---
const libTree = document.getElementById('lib-tree');
let selectedTreeNode = null;

// Registre chemin → nœud de l'arbre : permet de DÉPLIER l'arbre jusqu'au
// dossier courant (« montre que je suis dans ce dossier qui est dans ce
// dossier… ») quand on navigue à l'encodeur ou à la souris
const normTreePath = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase();
const treeRowsByPath = new Map(); // norm(path) -> { row, ensureOpen }

// Nœud générique : { name, onClick, getChildren } — getChildren est RELU à
// chaque ouverture (les playlists / dossiers changent en cours de session)
function makeTreeNode(item, depth) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.innerHTML = `
    <div class="tree-row" style="padding-left:${6 + depth * 14}px">
      <span class="tree-arrow">▸</span>
      <span class="tree-name"></span>
    </div>
    <div class="tree-children hidden"></div>
  `;
  const row = node.querySelector('.tree-row');
  const arrow = node.querySelector('.tree-arrow');
  const children = node.querySelector('.tree-children');
  node.querySelector('.tree-name').textContent = item.name;

  const openChildren = async () => {
    const kids = await item.getChildren();
    children.textContent = '';
    if (!kids.length) {
      arrow.textContent = '·';
      return;
    }
    kids.forEach((k) => children.appendChild(makeTreeNode(k, depth + 1)));
    children.classList.remove('hidden');
    arrow.textContent = '▾';
  };

  arrow.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!item.getChildren) {
      arrow.textContent = '·';
      return;
    }
    if (children.classList.contains('hidden')) await openChildren();
    else {
      children.classList.add('hidden');
      arrow.textContent = '▸';
    }
  });

  row.addEventListener('click', () => {
    if (selectedTreeNode) selectedTreeNode.classList.remove('selected');
    selectedTreeNode = row;
    row.classList.add('selected');
    if (item.onClick) item.onClick();
  });

  if (item.path) {
    treeRowsByPath.set(normTreePath(item.path), {
      row,
      ensureOpen: async () => {
        if (item.getChildren && children.classList.contains('hidden')) await openChildren();
      }
    });
  }

  return node;
}

function treeHighlight(row) {
  if (selectedTreeNode) selectedTreeNode.classList.remove('selected');
  selectedTreeNode = row;
  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest' });
}

// Déplie l'arbre de racine en racine jusqu'au dossier demandé et le surligne
async function treeReveal(target) {
  const t = normTreePath(target);
  let best = null;
  for (const [p, e] of treeRowsByPath) {
    if ((t === p || t.startsWith(p + '\\')) && (!best || p.length > best[0].length)) best = [p, e];
  }
  if (!best) return;
  let [p, e] = best;
  while (p !== t) {
    await e.ensureOpen(); // charge les enfants → ils s'enregistrent au registre
    const seg = t.slice(p.length + 1).split(/[\\/]/)[0];
    const next = treeRowsByPath.get(`${p}\\${seg}`);
    if (!next) break; // dossier filtré/caché : on s'arrête au plus proche
    p = `${p}\\${seg}`;
    e = next;
  }
  treeHighlight(e.row);
}

// Surligne un nœud « virtuel » (SoundCloud, Playlists…) et, si demandé, un
// de ses enfants — déplié au passage
async function treeRevealKey(parentKey, childKey) {
  const parent = treeRowsByPath.get(normTreePath(parentKey));
  if (!parent) return;
  if (childKey) {
    await parent.ensureOpen();
    const child = treeRowsByPath.get(normTreePath(childKey));
    if (child) {
      treeHighlight(child.row);
      return;
    }
  }
  treeHighlight(parent.row);
}

// Dossier disque : clic = scanner, flèche = sous-dossiers (PC ENTIER :
// racines C:..G: + Musique/Bureau/Documents/Téléchargements)
function fsTreeItem(r) {
  return {
    name: r.name,
    onClick: () => enterFolder(r.path),
    getChildren: async () => (await window.api.fsList(r.path)).map(fsTreeItem)
  };
}

async function buildTree() {
  const roots = await window.api.fsRoots();
  libTree.textContent = '';
  treeRowsByPath.clear();
  // SoundCloud DANS l'explorateur : 1 compte = SES playlists (❤️ Likes
  // comprise) en enfants directs, comme toujours ; ≥ 2 comptes (b2b) = un
  // nœud 👤 par compte, chacun dépliant SES playlists avec SON jeton.
  // Les playlists sont demandées DIRECTEMENT au main (sans passer par la
  // vue) : déplier l'arbre ne change plus la liste affichée à droite.
  libTree.appendChild(makeTreeNode({
    name: '☁️ SoundCloud',
    path: 'sc:',
    onClick: () => openSoundCloud(),
    getChildren: async () => {
      const s = await window.api.scStatus();
      const accounts = (s && s.accounts) || [];
      library.scAccountCount = accounts.length;
      const multi = accounts.length >= 2;
      const plChildren = async (i) => {
        const r = await window.api.scMyPlaylists(i);
        return (r.playlists || []).map((p) => ({
          name: p.name,
          path: p.scLikes ? scTreeKey(i, 'likes') : scTreeKey(i, p.permalink),
          onClick: () => (p.scLikes ? openScLikes(i) : openScPlaylist(p.permalink, i))
        }));
      };
      if (!multi) return plChildren(0);
      return accounts.map((a, i) => ({
        name: `👤 ${a.name || `Compte ${i + 1}`}`,
        path: `sc:acct:${i}`,
        onClick: () => openScAccount(i),
        getChildren: () => plChildren(i)
      }));
    }
  }, 0));
  // Playlists locales (dont celles importées de Rekordbox)
  libTree.appendChild(makeTreeNode({
    name: '🎛 Playlists',
    path: 'pl:',
    onClick: () => openPlaylistsRoot(),
    getChildren: async () => library.playlists.map((p) => ({
      name: p.name,
      path: `pl:${p.id}`,
      onClick: () => openLocalPlaylist(p)
    }))
  }, 0));
  roots.forEach((r) => libTree.appendChild(makeTreeNode(fsTreeItem(r), 0)));
}
buildTree();

// --- Onglets bibliothèque : fichiers locaux / SoundCloud ---
const tabLocal = document.getElementById('tab-local');
const tabSc = document.getElementById('tab-sc');
const tabHist = document.getElementById('tab-hist');
const tabPl = document.getElementById('tab-pl');
const scBar = document.getElementById('sc-bar');
const plBar = document.getElementById('pl-bar');
const btnFolder = document.getElementById('btn-folder');
const scUrlInput = document.getElementById('sc-url');

function setLibTab(mode) {
  tabLocal.classList.toggle('on', mode === 'local');
  tabSc.classList.toggle('on', mode === 'sc');
  tabHist.classList.toggle('on', mode === 'hist');
  tabPl.classList.toggle('on', mode === 'pl');
  scBar.classList.toggle('hidden', mode !== 'sc');
  plBar.classList.toggle('hidden', mode !== 'pl');
  btnFolder.classList.toggle('hidden', mode !== 'local');
  library.setMode(mode);
}

tabLocal.addEventListener('click', () => setLibTab('local'));
tabSc.addEventListener('click', () => setLibTab('sc'));
tabHist.addEventListener('click', () => setLibTab('hist'));
tabPl.addEventListener('click', () => setLibTab('pl'));

// --- Mini-modal de saisie (Electron n'a pas window.prompt) ---
function askText(title, def = '') {
  return new Promise((resolve) => {
    const ov = document.getElementById('prompt-overlay');
    const input = document.getElementById('prompt-input');
    document.getElementById('prompt-title').textContent = title;
    input.value = def;
    ov.classList.remove('hidden');
    input.focus();
    input.select();
    const done = (val) => {
      ov.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// --- Playlists : barre d'actions ---
const btnPlBack = document.getElementById('btn-pl-back');
const btnPlNew = document.getElementById('btn-pl-new');
const btnPlPlay = document.getElementById('btn-pl-play');

btnPlBack.addEventListener('click', () => library.closePlaylist());
btnPlNew.addEventListener('click', async () => {
  const name = await askText('Nom de la nouvelle playlist', `Playlist ${library.playlists.length + 1}`);
  if (name) {
    library.createPlaylist(name);
    flashStatus(`Playlist « ${name} » créée — clic droit sur un morceau pour l'y ajouter`);
  }
});

// --- Import Rekordbox : l'export XML officiel (Fichier → Exporter la
// collection au format xml) contient la COLLECTION (chemins, BPM, grille)
// et l'arbre de PLAYLISTS — on récupère les deux, gratuit et sans Pioneer.
async function importRekordboxXml() {
  const xmlPath = await window.api.pickXml();
  if (!xmlPath) return;
  flashStatus('Import Rekordbox : lecture du XML…');
  let doc;
  try {
    const raw = await window.api.readFile(xmlPath);
    const text = new TextDecoder('utf-8').decode(raw);
    doc = new DOMParser().parseFromString(text, 'text/xml');
  } catch {
    flashStatus('⛔ Impossible de lire ce fichier XML');
    return;
  }
  if (!doc || doc.querySelector('parsererror') || !doc.querySelector('DJ_PLAYLISTS')) {
    flashStatus('⛔ Ce fichier n\'est pas un export XML Rekordbox');
    return;
  }
  // 1) Collection : TrackID -> référence de morceau (chemin décodé, BPM et
  // début de grille Rekordbox conservés — pas besoin de ré-analyser)
  const byId = new Map();
  let skippedNoFile = 0;
  for (const t of doc.querySelectorAll('COLLECTION TRACK')) {
    const id = t.getAttribute('TrackID');
    const loc = t.getAttribute('Location') || '';
    if (!/^file:/i.test(loc)) { skippedNoFile++; continue; } // pistes streaming
    let p = loc.replace(/^file:\/\/localhost\//i, '').replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch { /* chemin déjà brut */ }
    p = p.replace(/\//g, '\\');
    const artist = t.getAttribute('Artist') || '';
    const title = t.getAttribute('Name') || p.replace(/^.*\\/, '');
    const bpm = parseFloat(t.getAttribute('AverageBpm')) || null;
    const duration = parseFloat(t.getAttribute('TotalTime')) || null;
    const tempo = t.querySelector('TEMPO');
    const inizio = tempo ? parseFloat(tempo.getAttribute('Inizio')) : NaN;
    // Si le morceau est déjà dans NOTRE bibliothèque, on pointe sur lui
    const known = library.tracks.find((x) => x.path && x.path.toLowerCase() === p.toLowerCase());
    byId.set(id, known ? library.trackRef(known) : {
      key: `rb:${p.toLowerCase()}`,
      name: artist ? `${artist} - ${title}` : title,
      path: p,
      sc: false,
      scId: null,
      bpm,
      beatOffset: Number.isFinite(inizio) ? inizio : null,
      duration,
      preview: null,
      analyzed: false
    });
  }
  // 2) Arbre de playlists : Type 1 = playlist, Type 0 = dossier (le chemin
  // devient « Dossier / Playlist » pour ne rien perdre de l'organisation)
  const found = [];
  const walkNode = (node, prefix) => {
    for (const child of node.children) {
      if (child.tagName !== 'NODE') continue;
      const nm = child.getAttribute('Name') || 'Sans nom';
      if (child.getAttribute('Type') === '1') {
        const tracks = [...child.querySelectorAll(':scope > TRACK')]
          .map((k) => byId.get(k.getAttribute('Key')))
          .filter(Boolean);
        if (tracks.length) found.push({ name: prefix ? `${prefix} / ${nm}` : nm, tracks });
      } else {
        walkNode(child, prefix ? `${prefix} / ${nm}` : (nm === 'ROOT' ? '' : nm));
      }
    }
  };
  const root = doc.querySelector('PLAYLISTS > NODE');
  if (root) walkNode(root, '');
  if (!found.length) {
    flashStatus('Import Rekordbox : aucune playlist avec des fichiers locaux dans ce XML');
    return;
  }
  // 3) Fusion : une playlist du même nom est MISE À JOUR, pas dupliquée
  let created = 0;
  let updated = 0;
  for (const f of found) {
    const existing = library.playlists.find((p) => p.name === f.name);
    if (existing) {
      existing.tracks = f.tracks;
      updated++;
    } else {
      library.playlists.push({ id: `rb-${Date.now()}-${created}`, name: f.name, tracks: f.tracks });
      created++;
    }
  }
  library.savePlaylists();
  setLibTab('pl');
  library.closePlaylist();
  const skipMsg = skippedNoFile ? ` (${skippedNoFile} pistes streaming ignorées)` : '';
  flashStatus(`Rekordbox importé : ${created} playlists créées, ${updated} mises à jour${skipMsg}`);
}
document.getElementById('btn-pl-import').addEventListener('click', importRekordboxXml);
btnPlPlay.addEventListener('click', () => {
  const p = library.plOpen;
  if (!p || !p.tracks.length) return;
  const i = activeDeck;
  deckQueues[i] = p.tracks.slice(1).map(t => ({ ...t }));
  updateQueueUI(i);
  loadTrackToDeck(i, { ...p.tracks[0] }, true);
  flashStatus(`Playlist « ${p.name } » : premier titre sur le deck ${i + 1}, ${p.tracks.length - 1} en file`);
});

// Télécharge en dur (Musique/TurboMix) les pistes SoundCloud d'une playlist
async function ensureLocalCopy(ref) {
  if (!ref || !ref.sc || !ref.scId) return;
  // Le compte d'origine de la piste part avec la demande (privées/Go+)
  const r = await window.api.scDownloadTo(ref.scId, ref.name, ref.acctIdx);
  if (r.ok) {
    ref.path = r.path;
    library.savePlaylists();
    flashStatus(`« ${ref.name} » téléchargé en dur dans Musique\\TurboMix`);
  } else {
    flashStatus(`Téléchargement : ${r.error}`);
  }
}

// --- Menu clic droit sur un morceau : ajouter à une playlist, retirer… ---
const ctxMenu = document.getElementById('ctx-menu');

function hideCtxMenu() {
  ctxMenu.classList.add('hidden');
}
document.addEventListener('click', hideCtxMenu);

function showTrackMenu(e, track, idx) {
  ctxMenu.textContent = '';
  const addItem = (label, fn) => {
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); fn(); });
    ctxMenu.appendChild(d);
  };
  library.playlists.forEach((p) => {
    addItem(`➕ Ajouter à « ${p.name} »`, () => {
      const ref = library.addToPlaylist(p, track);
      if (ref) {
        flashStatus(`« ${track.name} » ajouté à « ${p.name} »`);
        if (ref.sc && !ref.path) ensureLocalCopy(ref);
      } else {
        flashStatus('Déjà dans cette playlist');
      }
    });
  });
  addItem('🔄 Ré-analyser BPM + grille (efface les corrections)', async () => {
    flashStatus(`Ré-analyse de « ${track.name} »…`);
    try {
      const res = await library.reanalyze(track);
      // Met à jour en direct les decks qui jouent ce morceau
      engine.decks.forEach((d, di) => {
        const same = d.track && ((track.path && d.track.path === track.path) ||
          (track.scId && d.track.scId === track.scId));
        if (same) {
          d.bpm = res.bpm;
          d.beatOffset = res.beatOffset;
          d.beats = res.beats || null;
          d.gridShift = 0;
          d.barAnchor = 0;
          updateTempoLabel(di);
        }
      });
      flashStatus(`« ${track.name} » ré-analysé : ${res.bpm.toFixed(2)} BPM, grille recalée`);
    } catch (err) {
      flashStatus(`Ré-analyse : ${err.message || err}`);
    }
  });
  addItem('🆕 Ajouter à une nouvelle playlist…', async () => {
    const name = await askText('Nom de la nouvelle playlist', `Playlist ${library.playlists.length + 1}`);
    if (!name) return;
    const p = library.createPlaylist(name);
    const ref = library.addToPlaylist(p, track);
    if (ref && ref.sc && !ref.path) ensureLocalCopy(ref);
    flashStatus(`« ${track.name} » ajouté à « ${name} »`);
  });
  if (library.mode === 'pl' && library.plOpen) {
    addItem('✕ Retirer de la playlist', () => library.removeFromPlaylist(library.plOpen, idx));
  }
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - ctxMenu.childElementCount * 30 - 10)}px`;
  ctxMenu.classList.remove('hidden');
}

async function scLoad() {
  const url = scUrlInput.value.trim();
  if (!url) {
    flashStatus('Colle un lien de playlist ou de profil SoundCloud (ex. https://soundcloud.com/tonpseudo)');
    return;
  }
  await library.loadScUrl(url);
}

document.getElementById('btn-sc-load').addEventListener('click', scLoad);
scUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') scLoad();
});

// --- Connexion au compte SoundCloud ---
const btnScLogin = document.getElementById('btn-sc-login');
const btnScMine = document.getElementById('btn-sc-mine');

async function refreshScStatus() {
  const s = await window.api.scStatus();
  const accounts = (s && s.accounts) || [];
  // scBack() a besoin de savoir s'il existe un niveau « liste des comptes »
  library.scAccountCount = accounts.length;
  btnScMine.classList.toggle('hidden', !s.connected);
  // Le MÊME bouton sert à tout : 1er login, ajout du compte du pote (b2b),
  // reconnexion d'un compte dont le jeton a expiré
  const expired = accounts.find((a) => a.expired);
  btnScLogin.textContent = expired
    ? `⚠ Reconnecter ${expired.name || 'le compte'}`
    : accounts.length ? '+ Ajouter un compte' : 'Se connecter';
  return s.connected;
}

btnScLogin.addEventListener('click', async () => {
  const r = await window.api.scLogin();
  if (r.ok) {
    flashStatus(`Compte ${r.name || 'SoundCloud'} ajouté`);
    await refreshScStatus();
    buildTree(); // le nœud SoundCloud change de forme (nœuds 👤 par compte)
    library.loadScMine(r.index ?? 0);
  } else {
    flashStatus(`SoundCloud : ${r.error}`);
  }
});

// « Mes playlists » passe par openSoundCloud : en b2b il montre d'abord QUI
// (la liste des comptes), en solo il garde son comportement direct
btnScMine.addEventListener('click', () => openSoundCloud());
document.getElementById('btn-sc-back').addEventListener('click', () => library.scBack());

refreshScStatus().then((connected) => {
  // Si déjà connecté, l'onglet SoundCloud montrera direct tes playlists
  // (ou la liste des comptes quand on est plusieurs)
  if (connected) {
    tabSc.addEventListener('click', function once() {
      tabSc.removeEventListener('click', once);
      if (!library.scTracks.length) openSoundCloud();
    });
  }
});

window.addEventListener('resize', () => {
  stripUI.forEach((_, i) => refreshStrip(i));
  if (xfFader) xfFader.update();
});

library.init().then(() => {
  if (library.cache.__scUrl) scUrlInput.value = library.cache.__scUrl;
});


requestAnimationFrame(frame);
