import { AudioEngine } from './engine.js';
import { Library } from './library.js';
import { GamepadManager } from './gamepad.js';
import { computeBandPeaks, drawZoom, drawOverview, setWavePalette } from './waveform.js';
import { MidiManager, MIDI_ACTIONS_DECK, MIDI_ACTIONS_GLOBAL } from './midi.js';
import { gridIndexFracAt, gridTimeAtIndex, gridPeriodAt, setGlobalGridOffset, getGlobalGridOffset, barAlignedSeekTime } from './engine.js';
import { camelotLabel, keyName, keyDistance, heardKey, shiftKey } from './key.js';
import { t, getLang, setLang, applyStaticTranslations } from './i18n.js';

// Translate everything carrying data-i18n / data-i18n-title / data-i18n-placeholder
// before building the rest of the interface (decks, mixer…), so that
// everything starts in the right language, with no flash of untranslated text.
applyStaticTranslations();

const DECK_COLORS = ['#39c2ff', '#ff9f43', '#5fe08a', '#ff6b9d'];
// Below this distance (px), a click-and-release doesn't count as a drag:
// no scratch, no pause — just a one-off jump, the music keeps playing.
// Beyond it, the gesture becomes a real mouse scrub/scratch.
const DRAG_THRESHOLD_PX = 3;

const engine = new AudioEngine();
let activeDeck = 0;
let deckCount = Number(localStorage.getItem('deckCount')) === 2 ? 2 : 4;
let dragTrack = null;      // track being dragged & dropped from the library
let dragDir = null;        // OpenMix music folder being dragged
// OpenMix's NATIVE music folder { root, folders } (see refreshDlInfo)
let dlInfo = { root: null, folders: [] };
let waveWindowSec = 8;     // zoom of the stacked view (visible seconds)
let scratchSound = localStorage.getItem('scratchSound') !== '0'; // audible scratch?
let keepBarOnJump = localStorage.getItem('keepBarOnJump') !== '0'; // keep the bar intact when jumping?

// ---------------------------------------------------------------------------
// Small components: rotary knob and faders
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
    // Magnetic zero: the neutral point is easy to find again
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
    // Magnetic center: 0 (the middle) is easy to find again
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
// Deck panels
// ---------------------------------------------------------------------------

const deckUI = [];

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Stacked waveform row (top panel): one per deck, aligned so the tracks
// can be lined up against each other visually.
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

  // Mouse scratch: click and hold = pause, drag = move the track
  // (drag right -> the position goes back, as if pulling the vinyl).
  // In 🔊 mode, you hear the sound under the playhead while moving.
  const canvas = row.querySelector('canvas');
  let scrub = null;
  canvas.addEventListener('pointerdown', (e) => {
    const deck = engine.decks[i];
    if (!deck.buffer) return;
    engine.resume();
    canvas.setPointerCapture(e.pointerId);
    scrub = {
      startX: e.clientX,
      startY: e.clientY,
      wasPlaying: deck.playing,
      startTime: deck.currentTime(),
      audible: scratchSound,
      dragging: false
    };
    // Nothing is cut/paused until we know whether it's a real drag
    // (see pointermove): a simple click must never cut the music.
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!scrub) return;
    const deck = engine.decks[i];
    if (!scrub.dragging) {
      const moved = Math.hypot(e.clientX - scrub.startX, e.clientY - scrub.startY);
      if (moved < DRAG_THRESHOLD_PX) return; // just a hand tremor: ignore it
      // The gesture becomes a real drag: switch to scratch/scrub
      scrub.dragging = true;
      if (scrub.wasPlaying) deck.pause();
      if (scrub.audible) deck.scrubStart();
    }
    const secPerPx = (waveWindowSec * (deck.tempo || 1)) / Math.max(1, canvas.clientWidth);
    const dx = e.clientX - scrub.startX;
    // The track can be pulled PAST its start (negative position) to make
    // it start later — no more blocking at 0
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
    if (scrub.dragging) {
      deck.scrubEnd();
      if (scrub.wasPlaying) deck.play();
      // Auto-realign: segment on segment (can be disabled in ⚙)
      if (localStorage.getItem('snapRelease') !== '0') engine.snapToRef(i);
      // The placement set with the mouse is ADOPTED: without re-anchoring, the servo
      // used to PULL the sound back to the old alignment ("it snaps back onto the red")
      for (let k = 0; k < 4; k++) engine.reanchorSync(k);
    }
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

// --- Per-deck queue: tracks chain one after another automatically ---
const deckQueues = [[], [], [], []];

function updateQueueUI(i) {
  const ui = deckUI[i];
  const q = deckQueues[i];
  if (!q.length) {
    ui.queueInfo.textContent = t('queue_empty');
    ui.queueInfo.classList.remove('filled');
    ui.queueClear.classList.add('hidden');
  } else {
    ui.queueInfo.textContent = t('deck_queue_next_info', { count: q.length, name: q[0].name });
    ui.queueInfo.classList.add('filled');
    ui.queueClear.classList.remove('hidden');
  }
}

function queuePush(i, track) {
  // Navigation rows (SC playlists, 👤 accounts) are never queued
  if (!track || track.scPlaylist || track.scAccountRow) return;
  const deck = engine.decks[i];
  // Empty deck and empty queue: load directly
  if (!deck.buffer && !deckQueues[i].length) {
    loadTrackToDeck(i, track);
    return;
  }
  deckQueues[i].push(track);
  updateQueueUI(i);
  flashStatus(t('queue_added', { name: track.name, n: i + 1 }));
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

// Makes an element able to receive a track via drag & drop
// A LINK dragged from the browser (YouTube, SoundCloud…)
const dragHasLink = (dt) => !!dt && [...(dt.types || [])].some((ty) => ty === 'text/uri-list' || ty === 'text/plain');
const linkFromDrop = (dt) => {
  const raw = (dt && (dt.getData('text/uri-list') || dt.getData('text/plain'))) || '';
  const m = /https?:\/\/\S+/i.exec(raw);
  return m ? m[0] : null;
};

function makeDropTarget(el, deckIdx) {
  el.addEventListener('dragover', (e) => {
    if (!dragTrack && !dragHasLink(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-hover');
    if (!dragTrack) {
      // link dropped on the deck: downloaded (yt-dlp) then loaded HERE
      const url = linkFromDrop(e.dataTransfer);
      if (url) {
        setActiveDeck(deckIdx);
        ytDownload(url, deckIdx);
      }
      return;
    }
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
      <img class="deck-cover hidden" alt="" title="${t('deck_cover_title')}">
      <span class="deck-title">${t('deck_empty')}</span>
      <span class="deck-master hidden">MASTER</span>
      <span class="beat-dots" title="${t('beat_dots_title')}"><i></i><i></i><i></i><i></i></span>
      <span class="deck-key" title="${t('deck_key_title')}">
        <button class="keylock" title="${t('keylock_title')}">🔒</button>
        <b>KEY</b>
        <button class="key-lbl" title="${t('key_lbl_title')}">—</button>
        <button class="key-dn">−</button>
        <span class="key-val">0</span>
        <button class="key-up">+</button>
      </span>
    </div>
    <canvas class="wave-over"></canvas>
    <div class="queue-line" title="${t('queue_drop_title')}">
      <span class="queue-chip">${t('deck_queue_chip_label')}</span>
      <span class="queue-info">${t('queue_empty')}</span>
      <button class="queue-clear hidden" title="${t('queue_clear_title')}">✕</button>
    </div>
    <div class="pads-bar">
      <div class="pad-modes">
        <button data-m="jump" class="on">JUMP</button>
        <button data-m="loop">LOOP</button>
        <button data-m="hotcue">CUE</button>
        <button data-m="key">KEY</button>
        <button data-m="fx" title="${t('padfx_title')}">FX</button>
        <button data-m="smp" title="${t('sampler_title')}">SMPL</button>
        <div class="jump-scale">
          <button class="js-half" title="${t('jump_half_title')}">½</button>
          <button class="js-dbl" title="${t('jump_double_title')}">×2</button>
        </div>
      </div>
      <div class="pads"></div>
      <div class="stems-col">
        <canvas class="deck-wheel" width="96" height="96" title="${t('deck_wheel_title')}"></canvas>
        <div class="stems-right">
          <span class="stems-title">STEMS</span>
          <div class="stems-btns">
            <button class="stem-btn" data-s="vocals" title="${t('stem_vocals_title')}">VOX</button>
            <button class="stem-btn" data-s="drums" title="${t('stem_drums_title')}">DRM</button>
            <button class="stem-btn" data-s="inst" title="${t('stem_inst_title')}">INST</button>
          </div>
        </div>
      </div>
    </div>
    <div class="deck-controls">
      <button class="btn-cue">CUE</button>
      <button class="btn-play">▶</button>
      <button class="btn-sync">SYNC</button>
      <button class="btn-master" title="${t('deck_master_title')}">MASTER</button>
      <button class="btn-grid" title="${t('grid_recal_title')}">GRID</button>
      <button class="btn-grid-left" title="${t('grid_left_title')}">◀</button>
      <button class="btn-grid-right" title="${t('grid_right_title')}">▶</button>
      <button class="btn-grid-half" title="${t('grid_half_title')}">÷2</button>
      <button class="btn-grid-dbl" title="${t('grid_double_title')}">×2</button>
      <div class="deck-time">0:00 · -0:00</div>
      <div class="tempo-wrap" title="${t('tempo_gauge_title')}">
        <button class="tempo-btn tempo-dn" title="${t('tempo_dn_title')}">−</button>
        <span class="tempo-slider">
          <input type="range" class="tempo" min="-16" max="16" value="0" step="0.01">
          <i class="tempo-zero"></i>
        </span>
        <button class="tempo-btn tempo-up" title="${t('tempo_up_title')}">+</button>
      </div>
    </div>
  `;
  slot.appendChild(el);

  const wave = buildWaveRow(i);

  // BPM markers of the other decks on the tempo scale
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
    keyLbl: el.querySelector('.key-lbl'),
    keyDn: el.querySelector('.key-dn'),
    keylock: el.querySelector('.keylock'),
    padModeBtns: [...el.querySelectorAll('.pad-modes button[data-m]')],
    cueOwner: Array(10).fill(null), // player who set each cue
    loopOwner: null,                // player holding the loop
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
    tempoDn: el.querySelector('.tempo-dn'),
    tempoUp: el.querySelector('.tempo-up'),
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

  // CDJ-style CUE: hold = the sound plays from the cue point,
  // release = back to the point and stop
  let cueHold = false;
  ui.cue.addEventListener('pointerdown', (e) => {
    engine.resume();
    if (deck.playing) {
      deck.cue(); // back to cue + pause
      return;
    }
    const atCue = deck.buffer && Math.abs(deck.currentTime() - deck.cuePoint) < 0.02;
    if (!atCue) {
      deck.cue(); // sets the cue point here
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

  // Deck queue: drop to add, auto-chains at the end of the track
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
    flashStatus(t('queue_loaded', { n: i + 1, name: next.name }));
    loadTrackToDeck(i, next); // loaded READY, paused — up to you to start it
  };
  // Grid realignment: shared between the on-screen button AND the GRID button
  // of MIDI decks (the alignment is SAVED on the track, it comes back
  // by itself on the next load)
  const recalGrid = () => {
    if (!deck.buffer || !deck.bpm) {
      flashStatus(t('grid_need_bpm'));
      return;
    }
    const now = deck.currentTime();
    if (deck.beats) {
      // Dynamic grid: the nearest beat becomes a BAR START,
      // placed exactly under the playhead
      const k = Math.round(gridIndexFracAt(deck, now));
      deck.gridShift += now - gridTimeAtIndex(deck, k);
      deck.barAnchor = k;
      if (deck.track) library.setGridMeta(deck.track, { gridShift: deck.gridShift, barAnchor: deck.barAnchor });
    } else {
      deck.beatOffset = now;
      if (deck.track) library.setBeatOffset(deck.track, deck.beatOffset);
    }
    flashStatus(t('grid_realigned', { n: i + 1 }));
  };
  ui.grid.addEventListener('click', recalGrid);
  ui.recalGrid = recalGrid;

  // MANUAL BPM CORRECTION: double-click the deck's BPM display —
  // an escape hatch when the analysis gets it wrong (e.g. 162 detected for 145).
  // The entered value is SAVED on the track (manualBpm: re-analysis
  // won't overwrite it anymore), and the grid is rebuilt on it.
  // (the old BPM display in the header was removed: the BPM now lives
  // in the jog wheel dial — that's what you double-click)
  ui.wheelCv.style.cursor = 'pointer';
  // The BOTTOM of the dial shows the slider range: clicking it cycles
  // ±6 % → ±16 % → WIDE (±50 %), like a CDJ's TEMPO RANGE button
  const onRangeZone = (e) => {
    const r = ui.wheelCv.getBoundingClientRect();
    return (e.clientY - r.top) / r.height > 0.62;
  };
  ui.wheelCv.addEventListener('click', (e) => {
    if (!onRangeZone(e)) return;
    const k = TEMPO_RANGES.indexOf(deck.tempoRange);
    deck.tempoRange = TEMPO_RANGES[(k + 1) % TEMPO_RANGES.length];
    try { localStorage.setItem(`tempoRange${i}`, String(deck.tempoRange)); } catch { /* storage unavailable */ }
    applyTempoRange(i);
    flashStatus(t('tempo_range_status', { n: i + 1, range: tempoRangeLabel(deck.tempoRange) }));
  });
  ui.wheelCv.addEventListener('dblclick', async (e) => {
    if (onRangeZone(e)) return;
    if (!deck.buffer || !deck.bpm) return;
    const val = await askText(t('ask_real_bpm', { n: i + 1, bpm: deck.bpm.toFixed(1) }), deck.bpm.toFixed(1));
    const newBpm = Number(String(val).replace(',', '.'));
    if (!newBpm || newBpm < 40 || newBpm > 260) return;
    deck.bpm = newBpm;
    deck.beats = null; // FIXED grid rebuilt on the entered BPM
    if (deck.beatOffset == null) deck.beatOffset = 0;
    deck.synced = false;
    deck._syncBase = null;
    deck._pllCorr = 0;
    if (deck.track) library.setBpmValue(deck.track, newBpm);
    updateTempoLabel(i);
    flashStatus(t('bpm_corrected', { n: i + 1, bpm: newBpm }));
  });
  ui.masterBtn.addEventListener('click', () => {
    engine.setMaster(i);
    flashStatus(engine.masterIdx === null ? t('master_auto') : `Deck ${i + 1} = MASTER`);
  });
  const gridScale = (mult) => {
    if (!deck.bpm) return;
    const newBpm = Math.round(deck.bpm * mult * 1000) / 1000;
    if (newBpm < 40 || newBpm > 320) return;
    if (deck.beats) {
      // Dynamic grid: double the density (midpoints) or keep every
      // other beat (preserving the bar anchor)
      let newBeats;
      if (mult > 1) {
        newBeats = [];
        for (let k = 0; k < deck.beats.length - 1; k++) {
          newBeats.push(deck.beats[k]);
          newBeats.push(Math.round(((deck.beats[k] + deck.beats[k + 1]) / 2) * 1000) / 1000);
        }
        newBeats.push(deck.beats[deck.beats.length - 1]);
        deck.barAnchor = (deck.barAnchor || 0) * 2;
      } else {
        const parity = ((deck.barAnchor || 0) % 2 + 2) % 2;
        newBeats = deck.beats.filter((_, k) => k % 2 === parity);
        deck.barAnchor = Math.floor((deck.barAnchor || 0) / 2);
      }
      deck.beats = newBeats;
      deck.bpm = newBpm;
      deck.synced = false;
      // The BPM just changed ×2/÷2: the old sync ratio is obsolete
      deck._syncBase = null;
      deck._pllCorr = 0;
      if (deck.track) library.setGridData(deck.track, { beats: newBeats, barAnchor: deck.barAnchor, bpm: newBpm });
    } else {
      deck.bpm = newBpm;
      deck.synced = false;
      deck._syncBase = null;
      deck._pllCorr = 0;
      if (deck.track) library.setBpmValue(deck.track, newBpm);
    }
    updateTempoLabel(i);
    flashStatus(t('grid_changed', { n: i + 1, bpm: newBpm.toFixed(1), cmp: mult > 1 ? t('grid_tighter') : t('grid_wider') }));
  };
  el.querySelector('.btn-grid-half').addEventListener('click', () => gridScale(0.5));
  el.querySelector('.btn-grid-dbl').addEventListener('click', () => gridScale(2));

  // Fine calibration arrows: press = small grid shift,
  // hold = continuous, WITHOUT cutting the sound.
  // With SHIFT: fine BPM adjustment (±0.01) — to kill a residual drift.
  const gridNudge = (dir) => {
    if (deck.beats) {
      deck.gridShift += dir * 0.002;
    } else if (deck.beatOffset != null) {
      deck.beatOffset = Math.max(0, deck.beatOffset + dir * 0.002);
    }
  };
  const bpmNudge = (dir) => {
    if (!deck.bpm || deck.beats) return; // pointless on a dynamic grid
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
        if (shiftMode && !deck.beats) flashStatus(t('bpm_adjusted', { n: i + 1, bpm: deck.bpm.toFixed(3) }));
      }
    };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
  };
  const gl = el.querySelector('.btn-grid-left');
  const gr = el.querySelector('.btn-grid-right');
  gl.title = t('grid_left_shift_title');
  gr.title = t('grid_right_shift_title');
  bindNudge(gl, -1);
  bindNudge(gr, 1);

  const applyKey = (delta) => {
    engine.resume();
    deck.setKey(deck.keyShift + delta);
    ui.keyVal.textContent = `${deck.keyShift > 0 ? '+' : ''}${deck.keyShift}`;
    ui.keyVal.classList.toggle('shifted', deck.keyShift !== 0);
    updateKeyUI(i);
  };
  ui.keyLbl.addEventListener('click', () => keySync(i));
  ui.keyUp.addEventListener('click', () => applyKey(1));
  ui.keyDn.addEventListener('click', () => applyKey(-1));
  // KEYLOCK: remembered, and restored on the next launch
  const setLock = (on) => {
    deck.setKeylock(on);
    ui.keylock.classList.toggle('on', on);
    localStorage.setItem(`keylock${i}`, on ? '1' : '0');
    if (ui.keyLbl) updateKeyUI(i);
  };
  ui.setLock = setLock; // used by KEY SYNC
  ui.keylock.addEventListener('click', () => {
    const on = !deck.keylock;
    setLock(on);
    flashStatus(t('keylock_status', { n: i + 1, state: on ? t('keylock_on') : 'OFF' }));
  });
  setLock(localStorage.getItem(`keylock${i}`) === '1');
  ui.keyVal.addEventListener('dblclick', () => applyKey(-deck.keyShift));
  ui.applyKey = applyKey; // used by the KEY mode pads

  // Performance pads: HOT CUE / BEAT JUMP / BEAT LOOP (10 = 5×L/R)
  for (let p = 0; p < PAD_COUNT; p++) {
    const pad = document.createElement('button');
    pad.className = 'pad';
    // PAD FX = HOLD (pointerdown/up), SAMPLER = immediate hit on
    // pointerdown (click fires on release: too sluggish to play) —
    // the other modes keep the classic click
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
      if (ui.padMode === 'fx' || ui.padMode === 'smp') return; // already handled
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

  // Drag & drop of a track onto the deck panel or onto its waveform
  makeDropTarget(el, i);
  makeDropTarget(wave.el, i);
  applyTempoRange(i);
  ui.tempo.addEventListener('input', () => {
    // Magnetic zero: near the center, snap to exactly 0.0 % (zone
    // proportional to the range: ±0.1 % at ±6, ±0.8 % at WIDE)
    let v = Number(ui.tempo.value);
    if (Math.abs(v) < deck.tempoRange * 1.6) {
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
  // − / + : ±0.1 BPM per click (Shift = ±1 BPM), hold = it keeps going
  const holdNudge = (btn, dir) => {
    let timer = null;
    let n = 0;
    const stop = () => { clearTimeout(timer); timer = null; };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      const big = e.shiftKey;
      n = 0;
      deckBpmNudge(i, dir * (big ? 1 : 0.1));
      const rep = () => {
        n++;
        // after ~1.5 s held: steps of 0.5 BPM (to move through quickly)
        deckBpmNudge(i, dir * (big ? 1 : n > 20 ? 0.5 : 0.1));
        timer = setTimeout(rep, 75);
      };
      timer = setTimeout(rep, 380);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, stop));
  };
  holdNudge(ui.tempoDn, -1);
  holdNudge(ui.tempoUp, 1);
  // Thumbnail: a simple CLICK (without moving) = one-off jump, the music never
  // stops. A real DRAG (beyond a few pixels) switches to continuous
  // navigation (with the scrub sound if enabled) — see DRAG_THRESHOLD_PX.
  let overScrub = null;
  const overPosFromEvent = (e) => {
    const r = ui.over.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return frac * deck.duration;
  };
  // Computes and applies the target position (bar-aligned if enabled),
  // ALWAYS keeping the same "beforeTime" reference (captured only once,
  // before any jump) even if the track keeps playing during the
  // gesture — otherwise the bar phase would drift on every call.
  const applyOverSeek = (e) => {
    let t = overPosFromEvent(e);
    if (keepBarOnJump) t = barAlignedSeekTime(deck, overScrub.beforeTime, t);
    deck.seek(t);
  };
  ui.over.addEventListener('pointerdown', (e) => {
    if (!deck.buffer) return;
    engine.resume();
    ui.over.setPointerCapture(e.pointerId);
    overScrub = {
      startX: e.clientX,
      startY: e.clientY,
      wasPlaying: deck.playing,
      audible: scratchSound,
      beforeTime: deck.currentTime(),
      dragging: false
    };
    // Simple click: just place the playhead, the music keeps playing
    // (or stays stopped) without a gap — no pause, no scrub sound.
    applyOverSeek(e);
  });
  ui.over.addEventListener('pointermove', (e) => {
    if (!overScrub) return;
    if (!overScrub.dragging) {
      const moved = Math.hypot(e.clientX - overScrub.startX, e.clientY - overScrub.startY);
      if (moved < DRAG_THRESHOLD_PX) return; // just a hand tremor: ignore it
      // The gesture becomes a real drag: switch to scrub/continuous navigation
      overScrub.dragging = true;
      if (overScrub.wasPlaying) deck.pause();
      if (overScrub.audible) deck.scrubStart();
    }
    if (overScrub.audible) {
      deck.scrubMove(overPosFromEvent(e));
    } else {
      applyOverSeek(e);
    }
  });
  const endOverScrub = () => {
    if (!overScrub) return;
    if (overScrub.dragging) {
      if (overScrub.audible) deck.scrubEnd();
      if (overScrub.wasPlaying) deck.play();
    }
    // Thumbnail = navigation: NEVER any realignment — and sync ADOPTS the
    // chosen position instead of "recalibrating" it right away
    for (let k = 0; k < 4; k++) engine.reanchorSync(k);
    overScrub = null;
  };
  ui.over.addEventListener('pointerup', endOverScrub);
  ui.over.addEventListener('pointercancel', endOverScrub);

  // PAD FX badge: the running effect is shown large on the deck
  const padFxChip = document.createElement('div');
  padFxChip.className = 'padfx-chip';
  el.appendChild(padFxChip);
  ui.padFxChip = padFxChip;

  deckUI.push(ui);
}

// --- Pads: hot cues, beat jump, beat loop ---
// 10 pads: LEFT half = what L2 does (one per knob row),
// RIGHT half = what R2 does, mirrored (big strengths on the outside).
// Row r (TRIM=1 … FILTER=5) → pad L = r-1, pad R = 10-r.
// JUMP: −16 −8 −4 −2 −1 | +1 +2 +4 +8 +16 (bars)
// LOOP: IN OUT ✕ ✕ ✕ | 1 2 4 8 16 beats (IN/OUT = manual loop, ✕ = exit)
// CUE : A B C D E | F G H I J
const LOOP_BEATS = [null, null, null, null, null, 1, 2, 4, 8, 16];
// Jumps in BARS: 1/8 · 1/4 · 1/2 · 1 · 2 (mirrored, big jumps on the outside)
const JUMP_VALS = [-2, -1, -0.5, -0.25, -0.125, 0.125, 0.25, 0.5, 1, 2];
// Strength per row (TRIM → FILTER) depending on the mode
const JUMP_ROW_MEASURES = [2, 1, 0.5, 0.25, 0.125];
const LOOP_ROW_BEATS = [16, 8, 4, 2, 1];
const KEY_VALS = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]; // semitones (KEY mode)
// Rekordbox-style PAD FX: HOLD = the effect plays, RELEASE = it stops
// and the deck's FX unit gets back exactly its previous setting.
// beats = fraction of a beat (follows the master BPM), level = the pad's fixed amount
// Chosen selection: V.BRAKE and
// BACKSPIN kept ("turntable" effects: spin = handling the platter),
// plus 8 wet effects (echo, sweep…)
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
// Level of the DRY sound while an FX pad is HELD (per effect type)
const PADFX_DRY = { roll: 0, filter: 0, trans: 0, echo: 0.2, mtdelay: 0.25, reverb: 0.45, flanger: 1 };
const padForSide = (row, side) => (side > 0 ? 10 - row : row - 1);
// NEON color specific to each PLAYER — deliberately DIFFERENT from the
// track colors (blue/orange/green/pink) so you always know who is where
const PLAYER_COLORS = ['#c724ff', '#ffe600', '#ff1744', '#00ffd0'];
const GP_MODES = ['jump', 'loop', 'hotcue', 'key', 'fx', 'smp']; // tab order
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

// --- KEY (harmonic mixing) ---
// Key that KEY pad idx would give (ABSOLUTE transposition kv)
function keyPadLabel(i, p, idx) {
  const deck = engine.decks[i];
  const kv = KEY_VALS[idx];
  const sign = `${kv > 0 ? '+' : ''}${kv}`;
  p.classList.remove('key-compat');
  if (deck.musicKey == null) {
    p.textContent = `${sign}♪`;
    p.title = t('key_semitones_title', { sign: kv > 0 ? '+' : '', n: kv });
    return;
  }
  const h = heardKey({ ...deck, musicKey: deck.musicKey, keyShift: kv, keylock: deck.keylock, tempo: deck.tempo });
  const lab = camelotLabel(h.code);
  p.textContent = sign;
  const sub = document.createElement('span');
  sub.className = 'pad-sub';
  sub.textContent = lab;
  p.appendChild(sub);
  const ref = masterHeardKey();
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  if (ref && mi !== i && keyDistance(h.code, ref.code) <= 1) p.classList.add('key-compat');
  p.title = t('key_pad_result_title', {
    sign,
    name: keyName(h.code),
    lab,
    master: ref && mi !== i ? t('key_pad_master_suffix', { key: camelotLabel(ref.code) }) : ''
  });
}

// Deck key label (HEARD key: track + KEY + effect of the tempo
// if keylock is off), colored relative to the master
function updateKeyUI(i) {
  const ui = deckUI[i];
  const deck = engine.decks[i];
  if (!ui || !ui.keyLbl) return;
  const h = deck.buffer ? heardKey(deck) : null;
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const ref = mi !== i ? masterHeardKey() : null;
  const dist = h && ref ? keyDistance(h.code, ref.code) : null;
  const sig = `${h ? h.code : '-'}|${h ? h.cents : ''}|${dist}|${mi === i}`;
  if (ui._keySig === sig) return;
  ui._keySig = sig;
  ui.keyLbl.classList.remove('ok', 'clash', 'master');
  ui.keyLbl.classList.toggle('hidden', !deck.buffer);
  if (!h) {
    ui.keyLbl.textContent = deck.buffer ? '…' : '—';
    ui.keyLbl.title = deck.buffer ? t('key_analyzing') : t('key_camelot');
  } else {
    ui.keyLbl.textContent = camelotLabel(h.code);
    const cents = Math.abs(h.cents) >= 15 ? t('key_cents_hint', { cents: `${h.cents > 0 ? '+' : ''}${h.cents}` }) : '';
    if (mi === i) ui.keyLbl.classList.add('master');
    else if (dist != null) ui.keyLbl.classList.add(dist <= 1 ? 'ok' : 'clash');
    ui.keyLbl.title = `${keyName(h.code)} — ${camelotLabel(h.code)}${cents}`
      + (ref ? t('key_vs_master', {
        key: camelotLabel(ref.code),
        rel: t(dist === 0 ? 'key_rel_same' : dist === 1 ? 'key_rel_compatible' : dist === 2 ? 'key_rel_energy' : 'key_rel_clash')
      }) : '')
      + t('key_click_sync');
  }
  if (ui.padMode === 'key') ui.pads.forEach((p, idx) => keyPadLabel(i, p, idx));
}

// KEY SYNC: transposes the deck so it sounds in the master's key
// (or its relative, same Camelot number) with the smallest shift.
// KEYLOCK is enabled: otherwise the sync tempo would detune the result.
function keySync(i) {
  const deck = engine.decks[i];
  if (deck.musicKey == null) {
    flashStatus(t('keysync_not_analysed', { n: i + 1 }));
    return;
  }
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const ref = mi !== i ? masterHeardKey() : null;
  if (!ref) {
    flashStatus(t('keysync_need_master', { n: i + 1, why: t(mi === i ? 'keysync_is_master' : 'keysync_no_ref') }));
    return;
  }
  const ui = deckUI[i];
  if (!deck.keylock && ui.setLock) ui.setLock(true);
  const own = deck.musicKey;
  const ownMinor = own >= 12;
  const refMinor = ref.code >= 12;
  // target in the SAME mode as the track (relative if needed)
  let tgt = ref.code % 12;
  if (ownMinor && !refMinor) tgt = (tgt + 9) % 12;      // relative minor
  else if (!ownMinor && refMinor) tgt = (tgt + 3) % 12; // relative major
  let semis = (tgt - (own % 12) + 12) % 12;
  if (semis > 6) semis -= 12;
  if (ui.applyKey) ui.applyKey(semis - deck.keyShift);
  const h = heardKey(deck);
  flashStatus(t('keysync_done', { n: i + 1, semis: `${semis > 0 ? '+' : ''}${semis}`, key: camelotLabel(h.code), mkey: camelotLabel(ref.code) }));
}

function renderPads(i) {
  const ui = deckUI[i];
  ui._padViewSig = null; // forces the per-player views to be laid out again if needed
  ui._padSig = null;     // the pad content is rebuilt: repaint the state
  ui.pads.forEach((p) => {
    p.classList.remove('pad-tinted', 'set-any');
    p.style.background = '';
    p.style.borderColor = '';
  });
  ui.padModeBtns.forEach((b) => b.classList.toggle('on', b.dataset.m === ui.padMode));
  // FX and SAMPLER carry TEXT (names): smaller font to fit everything
  ui.padsEl.classList.toggle('pads-text', ui.padMode === 'fx' || ui.padMode === 'smp');
  ui.pads.forEach((p, idx) => {
    p.classList.remove('set', 'on');
    if (ui.padMode === 'hotcue') {
      p.textContent = String.fromCharCode(65 + idx); // A B C D E F G H
      p.title = t('hotcue_pad_title');
    } else if (ui.padMode === 'jump') {
      const v = JUMP_VALS[idx] * (ui.jumpScale || 1);
      p.textContent = formatMeasures(v);
      p.title = t('jump_measures_title', { n: formatMeasures(v).slice(1), dir: v > 0 ? t('jump_forward') : t('jump_backward') });
    } else if (ui.padMode === 'key') {
      keyPadLabel(i, p, idx);
    } else if (ui.padMode === 'fx') {
      p.textContent = PADFX[idx].label;
      p.title = t('padfx_hold_title', { label: PADFX[idx].label });
      if (ui._padFxHeld === idx) p.classList.add('on');
    } else if (ui.padMode === 'smp') {
      const s = samplerBank[idx];
      p.textContent = s ? s.name.slice(0, 10) : t('sampler_add_label');
      if (s) p.classList.add('set');
      p.title = s
        ? t('sampler_pad_filled_title', { name: s.name })
        : t('sampler_pad_empty_title');
    } else if (LOOP_BEATS[idx] == null) {
      // left half of LOOP mode: IN · OUT · ✕ (the manual loop lives there)
      p.textContent = idx === 0 ? 'IN' : idx === 1 ? 'OUT' : '✕';
      p.title = idx === 0
        ? t('loop_set_in_title')
        : idx === 1
          ? t('loop_set_out_title')
          : t('loop_exit_title');
    } else {
      const b = LOOP_BEATS[idx] * (ui.jumpScale || 1);
      const label = b >= 1 ? String(b) : `1/${Math.round(1 / b)}`;
      p.textContent = label;
      p.title = t('loop_resize_title', { label });
    }
  });
}

// Play/Pause with SYNC realignment: when a synced deck STARTS, its red
// lines are immediately aligned to the master's (bar on bar)
// — "when I start two synced tracks, the red lines must line up red
// on red against the master directly"
function playDeck(d) {
  engine.resume();
  const deck = engine.decks[d];
  const wasPlaying = deck.playing;
  deck.togglePlay();
  // (never on the MASTER itself: it's the reference, it would have aligned
  // to one of its followers)
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  if (!wasPlaying && deck.playing && deck.synced && mi !== d) engine.sync(d);
}

// Snaps a time to the nearest beat of the grid (dynamic or fixed)
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

// Rekordbox-style MANUAL loop: IN sets the start (snapped to the nearest
// beat), OUT closes the loop and activates it — ✕ / EXIT to leave
// Loop length as readable "beats" (8 beats, 1/2 beat…)
function loopLenLabel(deck) {
  if (!deck.bpm) return '';
  const b = (deck.loopEnd - deck.loopStart) / (60 / deck.bpm);
  if (b < 0.94) return t('loop_length_fraction', { d: Math.round(1 / b) });
  const n = Math.round(b);
  return n === 1 ? t('loop_length_one_beat') : t('loop_length_beats', { n });
}
// DEDICATED FLX6 buttons (captured: ÷2 = note 81, ×2 = note 83)
function loopHalve(i) {
  const deck = engine.decks[i];
  if (!deck.looping) {
    flashStatus(t('loop_none_active', { n: i + 1 }));
    return;
  }
  const len = deck.loopEnd - deck.loopStart;
  const minLen = deck.bpm ? (60 / deck.bpm) / 8 : 0.05;
  if (len / 2 < minLen) {
    flashStatus(t('loop_at_minimum', { n: i + 1 }));
    return;
  }
  deck.setLoop(deck.loopStart, deck.loopStart + len / 2);
  flashStatus(t('loop_half', { n: i + 1, label: loopLenLabel(deck) }));
}
function loopDouble(i) {
  const deck = engine.decks[i];
  if (!deck.looping) {
    flashStatus(t('loop_none_active', { n: i + 1 }));
    return;
  }
  const end = deck.loopStart + (deck.loopEnd - deck.loopStart) * 2;
  if (end > deck.duration) {
    flashStatus(t('loop_exceeds_end', { n: i + 1 }));
    return;
  }
  deck.setLoop(deck.loopStart, end);
  flashStatus(t('loop_double', { n: i + 1, label: loopLenLabel(deck) }));
}
function loopIn(i) {
  const deck = engine.decks[i];
  if (!deck.buffer) return;
  // During a loop, IN also halves (printed "1/2X" on the hardware)
  if (deck.looping) {
    loopHalve(i);
    return;
  }
  deck._loopInPoint = snapToBeat(deck, deck.currentTime());
  flashStatus(t('loop_in_set', { n: i + 1, time: formatTime(deck._loopInPoint) }));
}
function loopOut(i) {
  const deck = engine.decks[i];
  if (!deck.buffer) return;
  // During a loop, OUT also doubles (printed "2X" on the hardware)
  if (deck.looping) {
    loopDouble(i);
    return;
  }
  if (deck._loopInPoint == null) {
    flashStatus(t('loop_set_in_first', { n: i + 1 }));
    return;
  }
  const outPoint = snapToBeat(deck, deck.currentTime());
  if (outPoint <= deck._loopInPoint + 0.05) {
    flashStatus(t('loop_out_after_in', { n: i + 1 }));
    return;
  }
  deck.setLoop(deck._loopInPoint, outPoint);
  deck._loopBeats = deck.bpm ? Math.round((outPoint - deck._loopInPoint) / (60 / deck.bpm)) : 0;
  flashStatus(t('loop_extended', { n: i + 1, from: formatTime(deck._loopInPoint), to: formatTime(outPoint) }));
}

// Adjusting OUT with the LEFT STICK (mode enabled by pressing OUT again):
// ▶ = OUT jumps to the next grid SEGMENT (step by step) ·
// ◀ = FINE, continuous shrinking, little by little — in this mode the stick
// no longer shifts the sound (no jog), it only touches the loop
function gpLoopEditAdjust(d, v, dt) {
  const deck = engine.decks[d];
  const ui = deckUI[d];
  if (!deck.looping || !deck.bpm) return;
  const period = 60 / deck.bpm;
  const now = performance.now();
  if (v > 0) {
    // step by step: +1 segment every ~280 ms while pushing right
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
    flashStatus(t('loop_out_forward', { beats: deck._loopBeats }));
  } else if (v < 0) {
    // in STEPS of 100 ms — changing the audio source on every frame made
    // it wrap in bursts (the sound "ran" at full speed)
    if (now - (ui._loopEditLast || 0) < 100) return;
    ui._loopEditLast = now;
    const minLen = period / 8;
    const end = Math.max(deck.loopStart + minLen,
      deck.loopEnd - Math.abs(v) * 0.1 * period * 1.5);
    if (end >= deck.loopEnd) return;
    deck.setLoop(deck.loopStart, end);
    deck._loopBeats = Math.round(((end - deck.loopStart) / period) * 8) / 8;
    // the playhead went PAST the new OUT: ONE clean jump back into
    // the loop, not a machine-gun burst of wraps
    const cur = deck.currentTime();
    if (cur > end) {
      const len = end - deck.loopStart;
      deck.seek(deck.loopStart + ((cur - deck.loopStart) % len));
    }
    if (now - (ui._loopEditFlash || 0) > 150) {
      ui._loopEditFlash = now;
      flashStatus(t('loop_out_backward', { beats: ((end - deck.loopStart) / period).toFixed(2) }));
    }
  }
}

// Small per-deck PLATTER (Rekordbox jog style): blue ring, grooves,
// marker spinning at 33 rpm during playback — looks nice for cheap
function drawDeckWheel(ui, deck, t) {
  const cv = ui.wheelCv;
  if (!cv) return;
  const playing = deck.playing;
  // Tempo offset shown IN THE CENTER of the platter, like on a CDJ
  // Tempo offset WITHOUT the servo micro-correction: otherwise the decimal
  // kept flickering on a synced deck
  const pct = (((deck.tempo || 1) / (1 + (deck._pllCorr || 0))) - 1) * 100;
  const pctTxt = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  // when stopped: a single draw (signature), when playing: every frame
  const sig = playing ? null : `stop:${deck.buffer ? 1 : 0}:${pctTxt}:${deck.tempoRange}:${deck.bpm}`;
  if (sig && ui._wheelSig === sig) return;
  ui._wheelSig = sig;

  // REAL RESOLUTION: the canvas was fixed at 96 px for a 48 px display
  // — the text dropped to 6 px, unreadable. We draw at the displayed
  // size × the screen density, in a 100-unit coordinate space.
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 86;
  const px = Math.round(cssW * dpr);
  if (cv.width !== px) { cv.width = px; cv.height = px; }
  const g = cv.getContext('2d');
  const k = px / 100;                 // scale: we work in /100 units
  g.setTransform(k, 0, 0, k, 0, 0);
  g.clearRect(0, 0, 100, 100);
  const c = 50;

  // Outer ring
  g.beginPath();
  g.arc(c, c, 46, 0, Math.PI * 2);
  g.lineWidth = 3;
  g.strokeStyle = '#2d7df1';
  g.globalAlpha = playing ? 0.95 : 0.3;
  g.stroke();
  g.globalAlpha = 1;
  g.beginPath();
  g.arc(c, c, 42, 0, Math.PI * 2);
  g.fillStyle = '#0a0b0e';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  for (let r = 30; r < 42; r += 5) {
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.stroke();
  }
  // Rotation marker (~33 rpm): in the OUTER BAND, it no longer passes
  // in front of the digits
  const ang = (t || 0) * 3.49;
  g.beginPath();
  g.moveTo(c + Math.cos(ang) * 29, c + Math.sin(ang) * 29);
  g.lineTo(c + Math.cos(ang) * 41, c + Math.sin(ang) * 41);
  g.lineWidth = 3;
  g.strokeStyle = playing ? '#2d7df1' : '#3a4258';
  g.stroke();

  // --- CDJ-style CENTER DIAL ---
  g.beginPath();
  g.arc(c, c, 30, 0, Math.PI * 2);
  g.fillStyle = 'rgba(6,8,11,0.95)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  g.stroke();

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const MONO = 'ui-monospace, Menlo, Consolas, monospace';
  // SYNCED DECK = SHOW THE MASTER'S BPM. The lock guarantees the same
  // real speed; showing the deck's instantaneous value exposed the
  // servo's micro-corrections (139.07 vs 139.00) and gave the
  // impression that "the BPM keeps changing".
  let bpmNow = deck.bpm ? (deck.bpm * (deck.tempo || 1)) : null;
  if (deck.synced && deck.playing && deck._syncBase) {
    const mstr = engine.getMasterDeck(deck.id);
    if (mstr && mstr.bpm && mstr.playing) {
      bpmNow = mstr.bpm * (mstr.tempo / (1 + (mstr._pllCorr || 0)));
    }
  }
  g.font = `800 19px ${MONO}`;
  g.fillStyle = deck.buffer ? '#eef2f8' : '#39414f';
  g.fillText(bpmNow ? bpmNow.toFixed(2) : '--.--', c, c - 8);

  // Tempo offset: GREEN at zero, ORANGE as soon as you move away — you see
  // at a glance where you are relative to the slider, without looking at it
  g.font = `800 14px ${MONO}`;
  g.fillStyle = Math.abs(pct) < 0.05 ? '#5fe08a' : '#ffb054';
  g.fillText(pctTxt, c, c + 8);

  // Slider range (click = ±6 → ±16 → WIDE). The keylock has its
  // own padlock button in the deck header.
  g.font = `800 10px ${MONO}`;
  g.fillStyle = deck.tempoRange >= 0.5 ? '#ff7a59' : '#8b94a8';
  g.fillText(tempoRangeLabel(deck.tempoRange), c, c + 21);
}

// Per-deck TEMPO RANGE: ±6 %, ±16 % or WIDE (±50 %). The on-screen slider
// and the physical fader cover the whole chosen range.
const TEMPO_RANGES = [0.06, 0.16, 0.5];
function tempoRangeLabel(r) {
  return r >= 0.5 ? 'WIDE' : `±${Math.round(r * 100)}%`;
}
function applyTempoRange(i) {
  const deck = engine.decks[i];
  const ui = deckUI[i] || null;
  if (!TEMPO_RANGES.includes(deck.tempoRange)) {
    let r = 0.16;
    try { r = Number(localStorage.getItem(`tempoRange${i}`)) || 0.16; } catch { /* default */ }
    deck.tempoRange = TEMPO_RANGES.includes(r) ? r : 0.16;
  }
  const el = ui ? ui.tempo : document.querySelector(`#deck-slot-${i} .tempo`);
  if (!el) return;
  const p = deck.tempoRange * 100;
  el.min = String(-p);
  el.max = String(p);
  el.value = String(((deck.tempo || 1) - 1) * 100);
  if (ui) ui._wheelSig = null;
}

// Deck that LEADS i's synced group: the master if it's playing, otherwise i itself
function syncGroupLead(i) {
  const deck = engine.decks[i];
  if (deck.synced) {
    const m = engine.getMasterDeck(i);
    if (m && m.playing && m.bpm) return engine.decks.indexOf(m);
  }
  return i;
}
// Scales the tempo of i's synced GROUP by a factor (physical fader of a
// synced deck): the leader moves, the followers follow in the same frame
function syncGroupTempoScale(i, factor) {
  const ti = syncGroupLead(i);
  const td = engine.decks[ti];
  if (!td.bpm || !isFinite(factor) || factor <= 0) return;
  const base = (td.tempo || 1) / (1 + (td._pllCorr || 0));
  const nt = Math.max(0.5, Math.min(1.6, base * factor));
  if (td.synced && td._syncBase) td._syncBase = nt;
  td.setTempo(nt * (1 + (td._pllCorr || 0)));
  updateTempoLabel(ti);
  if (ti !== i) updateTempoLabel(i);
  if (typeof updateMasterBpmVal === 'function') updateMasterBpmVal();
}

// Deck − / +: raises or lowers the BPM. SYNCED deck = we act on the
// MASTER, the whole group follows as one (the engine scales the followers
// in the same frame — see _followMaster).
function deckBpmNudge(i, delta) {
  engine.resume();
  const deck = engine.decks[i];
  if (!deck.bpm) return;
  const ti = syncGroupLead(i);
  const td = engine.decks[ti];
  const base = (td.tempo || 1) / (1 + (td._pllCorr || 0));
  const cur = td.bpm * base;
  // aligned to the step: 124.03 + 0.1 → 124.1
  const step = Math.abs(delta);
  const newBpm = Math.round((cur + delta) / step) * step;
  const nt = Math.max(0.5, Math.min(1.6, newBpm / td.bpm));
  if (td.synced && td._syncBase) td._syncBase = nt;
  td.setTempo(nt);
  updateTempoLabel(ti);
  if (ti !== i) updateTempoLabel(i);
  if (typeof updateMasterBpmVal === 'function') updateMasterBpmVal();
  flashStatus(t('tempo_nudge_status', { n: ti + 1, bpm: (td.bpm * nt).toFixed(2) }));
}

// Jump by N bars (negative = backward). Active loop = the loop is what moves.
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

// Sets (or resizes) an N-beat loop, snapped to the grid
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

// modeArg: GAMEPADS pass the PLAYER's mode (each one keeps their own setup),
// the mouse uses the deck's tab. ownerGi: player index — brief flash
// of THEIR color on press, and REMEMBERED if the action sets something
// (cue, loop) so that ONLY their part of the button lights up.
function padPress(i, idx, modeArg, ownerGi) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const modeEarly = modeArg || ui.padMode;
  if (modeEarly === 'smp') {
    // The sampler does NOT depend on the loaded track — it always plays
    samplerPress(i, idx);
    return;
  }
  if (modeEarly === 'fx') {
    // Source with no release event (phone…): short burst of one beat
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
    const target = deck.keyShift === kv ? 0 : kv; // press again = back to 0
    if (ui.applyKey) ui.applyKey(target - deck.keyShift);
    return;
  }
  if (mode === 'hotcue') {
    const c = deck.hotCues[idx];
    if (c == null) {
      // The hot cue always snaps to the start of the nearest segment (beat)
      let t = deck.currentTime();
      if (deck.beats) {
        const snapped = gridTimeAtIndex(deck, Math.round(gridIndexFracAt(deck, t)));
        if (snapped != null) t = Math.max(0, snapped);
      } else if (deck.bpm && deck.beatOffset != null) {
        const period = 60 / deck.bpm;
        t = Math.max(0, deck.beatOffset + Math.round((t - deck.beatOffset) / period) * period);
      }
      deck.hotCues[idx] = t;
      if (ui.cueOwner) ui.cueOwner[idx] = ownerGi != null ? [ownerGi] : null; // WHO set it
      if (deck.track) library.setHotCues(deck.track, deck.hotCues);
    } else {
      deck.seek(c);
      // A player who USES another player's cue co-adopts it: the display
      // is split between the two colors (half/half)
      if (ownerGi != null && ui.cueOwner) {
        const arr = gpOwnersOf(ui.cueOwner[idx]);
        if (!arr.includes(ownerGi)) arr.push(ownerGi);
        ui.cueOwner[idx] = arr;
      }
    }
  } else if (mode === 'jump') {
    if (!deck.bpm) return;
    // Jump in BARS (4 beats), scaled by the ½ / ×2 strength.
    // Dynamic grid: the jump follows the track's REAL beats.
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
      // same clock reading as the jump computation: EXACT landing
      deck.seek(cur + jump);
    }
  } else {
    if (!deck.bpm) return;
    if (LOOP_BEATS[idx] == null) {
      // Left half of LOOP mode: IN (pad 1), OUT (pad 2), ✕ (the rest)
      if (idx === 0) {
        loopIn(i);
        return;
      }
      if (idx === 1) {
        if (deck.looping) {
          // OUT during the loop: reminder — the left stick already adjusts it
          flashStatus(t('gamepad_loop_stick', { n: i + 1 }));
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
    ui.loopOwner = ownerGi != null ? ownerGi : null; // WHO holds the loop
    if (deck.looping && deck._loopBeats === beats) {
      deck.exitLoop();
      ui.loopOwner = null;
    } else if (deck.looping) {
      // Loop already active: RESIZE it without moving its start
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
      // Start ALWAYS snapped to a segment/micro-segment; on a dynamic
      // grid, the loop follows the REAL beats (exact length)
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

// --- Stems: 3 always-visible buttons (VOX / DRM / INST, Rekordbox style).
// First click = AI separation then mutes the chosen part; after that each
// button turns its part on/off. INST groups bass + melodies.
const STEM_GROUPS = { vocals: ['vocals'], drums: ['drums'], inst: ['bass', 'other'] };

function resetStemsCol(i) {
  const ui = deckUI[i];
  ui.stemBtns.forEach((b) => {
    b.classList.remove('on', 'ready', 'loading');
    b.disabled = false;
  });
  ui._stemState = null;
}

// Separates (or fetches from cache) and decodes the stems of deck i's track,
// WITHOUT enabling them: they are just ready (deck.stems). ONE separation at
// a time (GPU/CPU): requests are chained in a queue — a click on VOX
// while the neighboring deck is being prepared WAITS its turn instead
// of failing ("a separation is already running").
let stemBusy = false;
let stemJob = Promise.resolve();
const stemPending = [null, null, null, null]; // { track, p } per deck
// Stems engine: { ok, cuda } — with a graphics card, the separation
// is light enough to run DURING the mix
let stemsEngine = null;
window.api.stemsInfo?.().then((r) => { stemsEngine = r; }).catch(() => {});

async function decodeStemFile(file) {
  const raw = await window.api.readFile(file);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return engine.ctx.decodeAudioData(ab);
}

// ALIGNING THE STEMS TO THE TRACK. Demucs decodes the mp3 with ffmpeg, the
// app with Chromium's decoder: depending on the encoder, the two
// timelines differ by a few tens of ms (LAME encoder delay).
// Without correction, enabling VOX/DRM/INST shifted the sound off the grid and
// the sync. We measure the offset by cross-correlation (sum of stems ≈ track)
// and shift the stem buffers to the exact sample.
function alignStems(orig, bufs) {
  const sr = orig.sampleRate;
  const n = Math.min(orig.length, ...bufs.map((b) => b.length));
  if (n < sr * 12) return 0;
  // We ONLY work on a window in the middle of the track (4 s + margins):
  // a few milliseconds of computation, no UI freeze
  const D = 8;
  const maxLag = Math.floor(0.12 * sr);
  const win = Math.floor(4 * sr);
  const r0 = Math.floor(n / 2) - (win >> 1) - maxLag - 2 * D;
  const len = win + 2 * maxLag + 4 * D;
  if (r0 < 0 || r0 + len > n) return 0;
  const o = orig.getChannelData(0).subarray(r0, r0 + len);
  const sum = new Float32Array(len);
  for (const b of bufs) {
    const c = b.getChannelData(0).subarray(r0, r0 + len);
    for (let k = 0; k < len; k++) sum[k] += c[k];
  }
  const from = maxLag + 2 * D; // start of the useful window within the region
  const corrAt = (a, b, f, l, lag) => {
    let acc = 0;
    for (let k = f; k < f + l; k++) acc += a[k] * b[k + lag];
    return acc;
  };
  // 1) coarse: decimated ×8, ±120 ms
  const dec = (src) => {
    const out = new Float32Array(Math.floor(len / D));
    for (let k = 0; k < out.length; k++) {
      let s2 = 0;
      for (let j = 0; j < D; j++) s2 += src[k * D + j];
      out[k] = s2;
    }
    return out;
  };
  const oD = dec(o);
  const sD = dec(sum);
  let best = 0;
  let bestV = -Infinity;
  const mD = Math.floor(maxLag / D);
  for (let L = -mD; L <= mD; L++) {
    const v = corrAt(oD, sD, Math.floor(from / D), Math.floor(win / D), L);
    if (v > bestV) { bestV = v; best = L * D; }
  }
  // 2) fine: to the exact sample, ±D around, over 1 s
  let fine = best;
  let fineV = -Infinity;
  for (let L = best - D; L <= best + D; L++) {
    const v = corrAt(o, sum, from, Math.floor(sr), L);
    if (v > fineV) { fineV = v; fine = L; }
  }
  if (!fine) return 0;
  // stem[k + fine] ≈ track[k]: shift the stems by "fine" samples
  for (const b of bufs) {
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      if (fine > 0) {
        d.copyWithin(0, fine);
        d.fill(0, d.length - fine);
      } else {
        d.copyWithin(-fine, 0, d.length + fine);
        d.fill(0, 0, -fine);
      }
    }
  }
  return fine / sr;
}

function ensureStems(i, silent) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const track = deck.track;
  if (deck.stems) return Promise.resolve(true);
  if (!track || !track.path) {
    if (!silent) flashStatus(t('stems_need_track'));
    return Promise.resolve(false);
  }
  const pend = stemPending[i];
  if (pend && pend.track === track) {
    if (!silent) flashStatus(t('stems_deck_running', { n: i + 1 }));
    return pend.p;
  }
  ui.stemBtns.forEach((b) => b.classList.add('loading'));
  if (!silent) flashStatus(t('stems_running'));
  const run = async () => {
    // the track changed while waiting in the queue: nothing to do
    if (engine.decks[i].track !== track) return false;
    stemBusy = true;
    try {
      const res = await window.api.stemsSeparate(track.path);
      if (!res.ok) {
        if (!silent) flashStatus(t('stems_separation_error', { error: res.error }));
        else console.log(`[midi] stems deck ${i + 1}: ${res.error}`);
        return false;
      }
      if (engine.decks[i].track !== track) return false;
      // INST = bass + melodies: both are always muted/restored
      // TOGETHER, so they're merged into a single buffer (−25 % memory:
      // 4 decoded stems weigh ~500 MB per 6-min track)
      const [vocals, drums, bass, other] = await Promise.all(
        ['vocals', 'drums', 'bass', 'other'].map((k) => decodeStemFile(res.stems[k])));
      for (let c = 0; c < bass.numberOfChannels; c++) {
        const a = bass.getChannelData(c);
        const b = other.getChannelData(Math.min(c, other.numberOfChannels - 1));
        const n = Math.min(a.length, b.length);
        for (let k = 0; k < n; k++) a[k] += b[k];
      }
      // The track may have changed during the separation
      if (engine.decks[i].track !== track) return false;
      const lag = alignStems(deck.buffer, [vocals, drums, bass]);
      if (lag) console.log(`[midi] stems deck ${i + 1}: realigned by ${(lag * 1000).toFixed(1)} ms to the track`);
      deck.stems = { vocals, drums, bass, other: null };
      ui.stemBtns.forEach((b) => b.classList.add('ready'));
      flashStatus(t('stems_ready', { n: i + 1 }));
      return true;
    } catch (err) {
      if (!silent) flashStatus(t('stems_separation_exception', { error: err.message || err }));
      return false;
    } finally {
      stemBusy = false;
    }
  };
  const p = stemJob.then(run, run);
  stemJob = p.catch(() => false);
  stemPending[i] = { track, p };
  p.finally(() => {
    if (stemPending[i] && stemPending[i].p === p) stemPending[i] = null;
    if (!stemPending[i]) ui.stemBtns.forEach((b) => b.classList.remove('loading'));
  });
  return p;
}

// Automatic background preparation as soon as a track is loaded
// (can be disabled in the settings)
// Auto-stems DEFERRED on CPU only: Demucs is very heavy there — so it is
// NEVER started while a track is playing (otherwise crackling audio
// + laggy gamepad). With an NVIDIA graphics card, it starts right away.
const stemAutoQueue = new Set();
let stemPumpTimer = null;
function pumpStemQueue() {
  if (stemPumpTimer) return;
  stemPumpTimer = setTimeout(() => {
    stemPumpTimer = null;
    if (!stemAutoQueue.size) return;
    const anyPlaying = engine.decks.some((dk) => dk.playing);
    const gpu = stemsEngine && stemsEngine.cuda;
    if ((anyPlaying && !gpu) || stemBusy) {
      pumpStemQueue(); // postpone while something is playing
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
  // On the first click, the intent is to MUTE the clicked part
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

// --- "Turntable" effects: V.BRAKE (the platter brakes to a stop) and
// BACKSPIN (it spins backward like a rewind) — simulated with the
// scrub engine (the same sound grains as jog scratching)
// SOUND EFFECT ONLY: the track virtually "keeps going" underneath
// during the gesture, and RESUMES EXACTLY where it would have got to — the pad
// never moves the position in the mix (explicit request from David)
function padSpinFx(i, idx, on, kind) {
  const deck = engine.decks[i];
  const ui = deckUI[i];
  const label = kind === 'backspin' ? 'BACKSPIN' : 'V.BRAKE';
  if (on) {
    if (!deck.buffer || ui._spinFx) return;
    engine.resume();
    const wasPlaying = deck.playing;
    if (wasPlaying) deck.pause();
    // CONTINUOUS sound from the engine (reversed slice + speed ramp): clean
    // at every speed — no scrub grains here anymore
    deck.spinSound(kind);
    ui._spinFx = {
      pos0: deck.currentTime(),
      start: performance.now(),
      padIdx: idx,
      wasPlaying
    };
    if (ui.pads[idx]) ui.pads[idx].classList.add('on');
    padFxChipShow(i, label);
    ledTick();
  } else {
    const s = ui._spinFx;
    if (!s) return;
    ui._spinFx = null;
    deck.stopSpinSound();
    if (s.wasPlaying) {
      // ALIGNED resume: original position + elapsed time (as if the
      // sound had never been touched) — it was just a sound effect
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

// Blue badge on the deck: WHICH FX pad is playing
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

// --- PAD FX (hold = play, release = stop) ---
// Each deck has its OWN pad FX unit (engine.padFx), separate from the panel's
// 4 units: pressing a pad touches NONE of the displayed settings — it's
// a simple momentary button, not a config change.
function padFxPress(i, idx, on) {
  const preset = PADFX[idx];
  if (!preset) return;
  if (preset.spin) {
    padSpinFx(i, idx, on, preset.spin);
    return;
  }
  const ui = deckUI[i];
  if (on) {
    if (ui._padFxHeld != null) return; // only one FX pad at a time per deck
    engine.resume();
    ui._padFxHeld = idx;
    if (preset.type === 'roll') {
      // REAL ROLL: the deck repeats the grid slice we're in
      // (½ beat…) and the track keeps going underneath — on release, it resumes
      // exactly where it would be. (The old "roll" was only a looped echo.)
      const d = engine.decks[i];
      d._padRoll = { beats: preset.beats, mix: 1 };
      d.startRoll(preset.beats, 1);
      if (ui.pads[idx]) ui.pads[idx].classList.add('on');
      padFxChipShow(i, preset.label);
      ledTick();
      return;
    }
    engine.setPadFx(i, preset);
    // The deck's DRY sound is dosed according to the NATURE of the effect: "it's
    // the sound being manipulated", it isn't layered on top. ROLL/SWEEP/
    // TRANS replace everything, ECHO/DELAY cut with the tail, REVERB
    // keeps a bed, FLANGER NEEDS the dry signal (it's the comb of the two).
    engine.decks[i]._padDryHold = PADFX_DRY[preset.type] ?? 1;
    if (ui.pads[idx]) ui.pads[idx].classList.add('on');
    padFxChipShow(i, preset.label);
    ledTick(); // LED of the HELD pad: immediate feedback, without waiting for the tick
  } else {
    if (ui._padFxHeld !== idx) return;
    ui._padFxHeld = null;
    if (preset.type === 'roll') {
      const d = engine.decks[i];
      d._padRoll = null;
      d.stopRoll();
      if (ui.pads[idx]) ui.pads[idx].classList.remove('on');
      padFxChipShow(i, null);
      ledTick();
      return;
    }
    engine.setPadFx(i, null);
    engine.decks[i]._padDryHold = null;
    if (ui.pads[idx]) ui.pads[idx].classList.remove('on');
    padFxChipShow(i, null);
    ledTick();
  }
}

// --- SAMPLER: one sound per pad, bank SHARED by the 4 decks ---
// Empty pad: choose one or more files (they fill the following pads).
// Filled pad: plays it immediately (press again = restart). Right-click: removes.
// Paths are remembered (localStorage) and reloaded at startup.
const samplerBank = Array(PAD_COUNT).fill(null); // { path, name, buffer }
let samplerGain = null;

function samplerSave() {
  try {
    localStorage.setItem('samplerBank', JSON.stringify(samplerBank.map((s) => (s ? s.path : null))));
  } catch { /* non-blocking */ }
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
  try { paths = JSON.parse(localStorage.getItem('samplerBank')); } catch { /* nothing */ }
  if (!Array.isArray(paths)) return;
  await Promise.all(paths.slice(0, PAD_COUNT).map((p, idx) => (p ? samplerLoadSlot(idx, p) : null)));
  samplerSave(); // purges files that no longer exist
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
    try { slot._src.stop(); } catch { /* already finished */ }
  }
  const src = engine.ctx.createBufferSource();
  src.buffer = slot.buffer;
  src.connect(samplerGain);
  src.start();
  slot._src = src;
  padFlash(i, idx, DECK_COLORS[i]);
}

// Owners of a cue: normalizes null / single index / array of indexes
function gpOwnersOf(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Color(s) of a group of owners: one color, or a half/half
// gradient when two players share the same cue
function gpOwnersBg(owners, fallback) {
  if (!owners.length) return fallback;
  if (owners.length === 1) return PLAYER_COLORS[owners[0]];
  const n = owners.length;
  const stops = owners.map((gi, k) =>
    `${PLAYER_COLORS[gi]} ${(k / n) * 100}% ${((k + 1) / n) * 100}%`).join(', ');
  return `linear-gradient(90deg, ${stops})`;
}

// Tracks targeted by a knob gesture: if the column is part of the
// SELECTION, the whole group moves together; otherwise just the column
function gpGroupTargets(d) {
  return gpSelection.size && gpSelection.has(d) ? [...gpSelection] : [d];
}

// Applies a DELTA to the row's knob for every track in the group
function gpGroupKnobAdjust(cur, dv) {
  const d = Math.min(cur.c, deckCount - 1);
  const k = GP_KNOBS[cur.r - 1];
  gpGroupTargets(d).forEach((t) => k.set(t, k.get(t) + dv));
}

// 🔊 BASS SWAP to deck d — same rule as the logo button on
// LOW: this deck gets its bass back, ALL the others are cut
// (only one bass active at a time). Silent: the caller flashes the status.
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

// ↺ R1 in SELECTION mode: THE mix release — filters of the selected tracks
// at 0, their FX at 0 and off, cut volumes restored, selection cleared.
// BONUS: R1 on a LOW knob = the bass swap to THIS deck is
// included in the drop (like the logo button) — all in a single gesture.
function gpSelReset(fallbackDeck, cur) {
  if (!gpSelection.size) return;
  [...gpSelection].forEach((t) => {
    engine.setDeckColor(t, 0);
    stripUI[t].kFilt.update();
  });
  // unassign the selected tracks from ALL units (units are
  // per PLAYER) — otherwise a ghost FX survives the reset
  const units = new Set();
  [...gpSelection].forEach((t) => {
    for (let u = 0; u < 4; u++) {
      if (engine.fxAssign[u][t]) units.add(u);
      gpFxAssignSet(u, t, false);
    }
  });
  units.forEach((u) => {
    // a unit still routed to decks OUTSIDE the selection stays intact
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
    bassTxt = t('bass_routed_suffix', { n: bd + 1 });
  }
  if (gpCutStore.size) gpCutToggle(fallbackDeck);
  flashStatus(t('reset_r1', { bass: bassTxt }));
  gpClearSelection();
}

// Clears the selection (Circle) — the SEL lights go off everywhere
function gpClearSelection() {
  if (!gpSelection.size) return;
  gpSelOwners.forEach((s) => s.clear());
  gpSelNeutral.clear();
  gpSelection.clear();
  gpPaintSelection();
  flashStatus(t('selection_cleared'));
}

// Sets an FX assignment directly (and syncs the hidden buttons)
function gpFxAssignSet(u, d, on) {
  engine.fxAssign[u][d] = on;
  const btn = uiRefs.fxUnits[u].assignEl.querySelectorAll('.fxu-assign-btn')[d];
  if (btn) btn.classList.toggle('on', on);
}

// ⚡ ENGAGE (R3 on the SELECT row): the selected tracks join
// the player's FX (THEIR personal unit), which turns on
function gpFxEngage(st) {
  const u = Math.min(st.player - 1, 3);
  const targets = gpSelection.size
    ? [...gpSelection]
    : [Math.min(st.cur.c, deckCount - 1)];
  targets.forEach((d) => gpFxAssignSet(u, d, true));
  engine.updateFxSends();
  if (!engine.fx[u].enabled) uiRefs.fxUnits[u].onBtn.click();
  flashStatus(t('fx_enabled_on_decks', { u: u + 1, decks: targets.map((x) => x + 1).sort().join(' + ') }));
}

// FX column: L2/R2 = previous / next effect
function gpFxTypeStep(u, dir) {
  const sel = uiRefs.fxUnits[u].typeSel;
  sel.selectedIndex = (sel.selectedIndex + dir + sel.options.length) % sel.options.length;
  sel.dispatchEvent(new Event('change'));
  flashStatus(`FX ${u + 1} — ${sel.options[sel.selectedIndex].textContent}`);
}

// FX column: L2/R2 = duration ÷2 / ×2 (one step in the duration list)
function gpFxBeatsStep(u, dir) {
  const sel = uiRefs.fxUnits[u].beatsSel;
  const idx = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + dir));
  if (idx === sel.selectedIndex) return false; // already at the limit
  sel.selectedIndex = idx;
  sel.dispatchEvent(new Event('change'));
  flashStatus(t('fx_duration', { u: u + 1, val: sel.options[idx].textContent.trim() }));
  return true;
}

// Light feedback for the controller's BEAT ◄/► buttons: a crisp flash of the
// pressed button on each step — TRIPLE blink when at the limit
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

// FX duration one step longer / shorter — within the FULL list
// (1/4 … 1/2 … 3/4 … 32): 3/4 stays reachable, David insists on it
function gpFxBeatsX2(u, dir) {
  const sel = uiRefs.fxUnits[u].beatsSel;
  const cur = Number(sel.value);
  const opts = [...sel.options].map((o) => Number(o.value));
  const next = dir > 0
    ? opts.find((v) => v > cur)
    : [...opts].reverse().find((v) => v < cur);
  if (next == null) return false; // already at the limit (1/16 or 16)
  sel.value = String(next);
  sel.dispatchEvent(new Event('change'));
  return true;
}

// Brief flash of the player's color on the pressed pad
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
  // The value shown next to the slider is ALWAYS the PERCENTAGE (the
  // language of the physical fader): on a synced deck, it's THE value to
  // bring the slider to ("I first have to put the knob on +5.5 %")
  // before taking back control — the BPM is shown at the top of the deck.
  // (NO more numbers at all around the slider: the BPM and the % live on the
  // platter, David's request — "leave it on the deck with the %")
}

function syncDeck(i) {
  engine.resume();
  const d = engine.decks[i];
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  // The MASTER can be SYNC: arm it without touching ITS tempo (it is the
  // reference) — if it becomes a follower again later, the handover re-targets it
  if (mi === i && d.bpm) {
    d.synced = true;
    d._syncBase = d.tempo;
    d._syncRef = d.tempo;
    flashStatus(`Deck ${i + 1} — MASTER + SYNC`);
    return;
  }
  if (engine.sync(i)) {
    updateTempoLabel(i);
    flashStatus(t('deck_synced_master', { n: i + 1 }));
  } else if (d.bpm) {
    // No reference yet? SYNC ARMS anyway: the self-healing
    // lock will align it as soon as another track plays
    d.synced = true;
    flashStatus(t('sync_armed', { n: i + 1 }));
  } else {
    flashStatus(t('sync_impossible_unknown_bpm'));
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
// Mixer (4 channels + crossfader)
// ---------------------------------------------------------------------------

const stripUI = [];
let xfFader = null;
// UI references for the gamepad control grid (5×5 cursor)
const uiRefs = { master: {}, fxUnits: [] };
let masterMeterFill = null;
let masterMeterClip = null;
let masterMeterVal = 0;
let masterClipUntil = 0;

function buildMixer() {
  const mixer = document.getElementById('mixer');

  // Color FX: what each channel's FILTER knob controls
  const colorRow = document.createElement('div');
  colorRow.id = 'color-row';
  colorRow.innerHTML = `
    <span>COLOR</span>
    <select id="color-type" title="${t('color_fx_title')}">
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
    <button id="color-on" class="on" title="${t('color_toggle_title')}">ON</button>
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

  // MASTER row: global filter + volume of the combined mix + master VU meter
  const masterRow = document.createElement('div');
  masterRow.id = 'master-row';
  const mfKnob = makeKnob('FILTER', () => engine.masterFilterVal, (v) => engine.setMasterFilter(v));
  mfKnob.el.classList.add('master-filter-knob');
  mfKnob.el.title = t('filter_master_title');
  uiRefs.master.filterKnob = mfKnob;
  const mvKnob = makeKnob('VOL', () => engine.masterVolume * 2 - 1, (v) => engine.setMasterVolume((v + 1) / 2));
  uiRefs.master.volKnob = mvKnob;
  mvKnob.el.classList.add('master-filter-knob');
  mvKnob.el.title = t('volume_master_title');
  const mLabel = document.createElement('span');
  mLabel.id = 'master-label';
  mLabel.textContent = 'MASTER';
  const mMeter = document.createElement('div');
  mMeter.id = 'master-meter';
  mMeter.title = t('master_meter_level_title');
  mMeter.innerHTML = '<div id="master-meter-fill"></div><div id="master-meter-clip"></div>';
  // MASTER BPM: − / + shift the master tempo by 0.5 BPM — every
  // SYNCed track follows instantly (it leads everyone)
  const bpmWrap = document.createElement('span');
  bpmWrap.id = 'master-bpm';
  bpmWrap.title = t('master_bpm_title');
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

  // Mixer body: the 4 channels + the FX RACK to the right of the knobs
  // (moved from the top of the screen, integrated into the gamepad matrix)
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
    // CLUB order of the mixer channels: 3 1 2 4 from left to right
    strip.style.order = [1, 2, 0, 3][i];
    strip.style.setProperty('--deck-color', DECK_COLORS[i]);

    const label = document.createElement('div');
    label.className = 'strip-label';
    label.textContent = i + 1;
    strip.appendChild(label);

    // SELECT row: selects the track (cut Triangle, ⚡ FX R3, ↺ Circle)
    const selBtn = document.createElement('button');
    selBtn.className = 'strip-sel';
    selBtn.textContent = 'SEL';
    selBtn.title = t('select_track_title');
    selBtn.addEventListener('click', () => gpSelectToggle(i));
    strip.appendChild(selBtn);

    const kTrim = makeKnob('TRIM', () => deck.trimVal, v => deck.setTrim(v));
    const kHigh = makeKnob('HI', () => deck.eq.high, v => deck.setEq('high', v));
    const kMid  = makeKnob('MID', () => deck.eq.mid, v => deck.setEq('mid', v));
    const kLow  = makeKnob('LOW', () => deck.eq.low, v => deck.setEq('low', v));
    const kFilt = makeKnob('FILTER', () => deck.filterVal, v => engine.setDeckColor(i, v));

    // Vertical VU meter ALONG the knobs (like Serato):
    // it rises through green/yellow and turns red when clipping
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
  // The crossfader DISTRIBUTES THE SOUND across the 4 channels: it lives UNDER
  // the channels, not under the FX rack (David's request)
  const stripsEl = document.getElementById('strips');
  (stripsEl || mixer).appendChild(xfWrap);
  xfFader = makeHFader(
    xfWrap.querySelector('#crossfader'),
    () => engine.crossfader,
    v => engine.setCrossfader(v)
  );
}

// FX bar: 4 units, one per deck (player), each with its own effect.
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
// CONVENTIONAL range (David's request): from 1/4 to 32 beats
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
  // A SINGLE FX panel shared by the 4 players: tabs 1 2 3 4
  // choose which unit is shown in the panel (the rest is hidden)
  const tabs = document.createElement('div');
  tabs.className = 'fx-tabs';
  uiRefs.fxTabs = [];
  for (let i = 0; i < 4; i++) {
    const t = document.createElement('button');
    t.className = 'fx-tab';
    t.textContent = i + 1;
    // (the % and the duration are no longer duplicated here: the LEVEL knob shows
    // the 4 gauges and the DURATION cell the 4 values — the tab stays
    // a simple player button with its level bar)
    t.style.setProperty('--deck-color', PLAYER_COLORS[i]);
    t.addEventListener('click', () => gpShowFxUnit(i));
    tabs.appendChild(t);
    uiRefs.fxTabs.push(t);
  }
  bar.appendChild(tabs);
  // The 4 FX units stay in the DOM (selects, knob, ON, assign) as the
  // "brain" but are HIDDEN: the view is the cell matrix
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
      <select class="fxu-type" title="${t('fx_controller_effect_title', { n: i + 1 })}">${FX_TYPE_OPTIONS}</select>
      <select class="fxu-beats" title="${t('fx_duration_beats_title')}">${FX_BEATS_OPTIONS}</select>
      <span class="fxu-assign" title="${t('fx_unit_assign_title')}"></span>
      <button class="fxu-on">OFF</button>
    `;
    const knob = makeKnob('', () => fx.level * 2 - 1, (v) => fx.setLevel((v + 1) / 2));
    unit.insertBefore(knob.el, unit.querySelector('.fxu-on'));

    // Assignment: this controller can process any of decks 1-4
    const assignEl = unit.querySelector('.fxu-assign');
    for (let d = 0; d < 4; d++) {
      const b = document.createElement('button');
      b.className = 'fxu-assign-btn' + (engine.fxAssign[i][d] ? ' on' : '');
      b.textContent = d + 1;
      b.style.setProperty('--adc', DECK_COLORS[d]);
      b.title = t('fx_apply_controller_title', { n: i + 1, d: d + 1 });
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
  // MATRIX view: one button cell per row (aligned with the knobs)
  const cellsWrap = document.createElement('div');
  cellsWrap.className = 'fx-cells';
  const cells = {};
  GP_FX_ROWS.forEach((row) => {
    const c = document.createElement('div');
    c.className = `fx-cell fx-cell-${row.key}`;
    c.dataset.fx = row.key;
    c.innerHTML = `<b class="fx-cell-lbl">${row.label}</b><span class="fx-cell-val"></span>`;
    if (row.key === 'level') {
      // LEVEL = a real knob (canvas ×2 for sharpness) with the gauges
      // of the 4 players — no longer a plain text box
      const cv = document.createElement('canvas');
      cv.width = 96;
      cv.height = 96;
      cv.className = 'fx-lvl-cv';
      c.querySelector('.fx-cell-val').appendChild(cv);
      uiRefs.fxLvlCv = cv;
    }
    // Mouse: type = next effect, on/off = toggle, duration = ×2,
    // level = +25 % (and wraps back to 0)
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

  // --- FX MASTER: dedicated strip under the matrix — the FX of the WHOLE MIX
  // (MASTER position of the controllers' channel select). Independent of the 4
  // player units: it lives on the master bus.
  const MFX_TYPES = [...FX_TYPE_OPTIONS.matchAll(/value="([^"]+)"[^>]*>([^<]+)/g)]
    .map((mm) => [mm[1], mm[2].trim()]);
  const mWrap = document.createElement('div');
  mWrap.className = 'fx-master';
  mWrap.innerHTML = `
    <b class="fx-master-title">MASTER</b>
    <div class="fx-cell fxm-type" title="${t('fx_master_type_title')}"><b class="fx-cell-lbl">${t('fx_row_effect')}</b><select class="fx-cell-val fxm-type-sel">${FX_TYPE_OPTIONS}</select></div>
    <div class="fx-cell fxm-beats" title="${t('fx_duration_dbl_title')}"><b class="fx-cell-lbl">${t('duree_label')}</b><span class="fx-cell-val">1/2</span></div>
    <div class="fx-cell fxm-level" title="${t('fx_master_level_title')}"><b class="fx-cell-lbl">${t('fx_row_level')}</b><span class="fx-cell-val">0%</span></div>
    <div class="fx-cell fx-cell-onoff fxm-on" title="${t('fx_master_onoff_title')}"><b class="fx-cell-lbl">MIX</b><span class="fx-cell-val fx-badge">OFF</span></div>
  `;
  const mfxEls = {
    type: mWrap.querySelector('.fxm-type .fx-cell-val'),
    beats: mWrap.querySelector('.fxm-beats .fx-cell-val'),
    level: mWrap.querySelector('.fxm-level .fx-cell-val'),
    on: mWrap.querySelector('.fxm-on .fx-cell-val')
  };
  uiRefs.masterFxEls = mfxEls;
  // DROPDOWN MENU (David's request: "see where we're going") — replaces the old
  // blind "click = next effect"
  mWrap.querySelector('.fxm-type-sel').addEventListener('change', (e) => {
    engine.ensureMasterFx().setType(e.target.value);
    updateMasterFxRow();
  });
  mWrap.querySelector('.fxm-beats').addEventListener('click', () => {
    if (!masterFxBeatsStep(1)) {
      engine.ensureMasterFx().setBeatsMult(MASTER_FX_BEATS[0]); // wraps back to 1/4
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
    // No default level: YOU play the level control (David)
    updateMasterFxRow();
    flashStatus(t('fx_master_status', { state: u.enabled ? (u.level === 0 ? t('fx_master_on_raise') : t('fx_master_on')) : t('fx_master_off') }));
  });
  bar.appendChild(mWrap);
  uiRefs.masterFxTypes = MFX_TYPES;

  gpShowFxUnit(0); // at startup, the panel shows unit 1
  updateFxPanel();
  updateMasterFxRow();
}

// Refreshes the FX MASTER strip (called every frame, guarded by a signature)
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
  // The EFFECT cell is a <select>: sync its VALUE
  if (els.type.tagName === 'SELECT') els.type.value = u.type;
  else {
    const tt = (uiRefs.masterFxTypes || []).find(([v]) => v === u.type);
    els.type.textContent = tt ? tt[1] : u.type;
  }
  els.beats.textContent = u.beatsMult >= 1 ? String(u.beatsMult) : `1/${Math.round(1 / u.beatsMult)}`;
  els.level.textContent = `${Math.round(u.level * 100)}%`;
  els.on.textContent = u.enabled ? 'ON' : 'OFF';
  els.on.classList.toggle('live', u.enabled);
}

// Level KNOB of the FX rack: 4 concentric gauges (one per player, in their
// color, full = 100 %) + the % of the displayed unit in the center — you see
// the levels of all 4 players at a glance, like on a real knob
function drawFxLevelKnob() {
  const cv = uiRefs.fxLvlCv;
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
  g.clearRect(0, 0, W, H);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // classic knob sweep
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
      g.strokeStyle = gpUnitColor(i); // one gauge PER PLAYER, in their color
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

// Fills the FX cells from the currently displayed unit (gpFxShown)
// SHORT effect codes for the FX matrix badges — never a
// space ("MT Delay" wrapped onto two lines and broke the display)
const FX_SHORT = {
  delay: 'DLY', echo: 'ECHO', spiral: 'SPIR', mtdelay: 'MTDL',
  upecho: 'ECH↑', downecho: 'ECH↓', lowcut: 'LCUT', pingpong: 'PONG',
  reverb: 'REV', flanger: 'FLNG', phaser: 'PHSR', pan: 'PAN',
  trans: 'TRNS', filter: 'FILT', roll: 'ROLL', robot: 'RBOT',
  helix: 'HLX', crush: 'CRSH'
};

function updateFxPanel() {
  const p = uiRefs.fxPanel;
  if (!p) return;
  const u = gpFxShown;
  // GAMEPAD SMOOTHNESS: called every frame, but if NOTHING changed we don't
  // touch the DOM — state signature, zero useless writes
  let sig = `${u}`;
  for (let i = 0; i < 4; i++) {
    const r = uiRefs.fxUnits[i];
    sig += `|${Math.round(engine.fx[i].level * 100)}:${engine.fx[i].enabled ? 1 : 0}:${r.typeSel.selectedIndex}:${r.beatsSel.selectedIndex}:${gpSonsOf(i).join('')}`;
  }
  if (p._sig === sig) return;
  p._sig = sig;
  const col = gpUnitColor(u);
  // Per-player "TRACKS color" strip: gradient of the tracks THIS
  // player has selected (equal segments, like the multi buttons)
  const soundsGrad = [0, 1, 2, 3].map((i) => {
    const sounds = gpSonsOf(i);
    return sounds.length
      ? `linear-gradient(90deg, ${sounds.map((t, k) =>
          `${DECK_COLORS[t]} ${(k / sounds.length) * 100}% ${((k + 1) / sounds.length) * 100}%`).join(', ')})`
      : 'transparent';
  });
  // Tabs = THE 4 PLAYERS (each in their color): FX glow when on, level
  // bar, and the strip of the tracks they took
  (uiRefs.fxTabs || []).forEach((b, i) => {
    b.classList.toggle('on', i === u);
    b.classList.toggle('fx-live', engine.fx[i].enabled);
    b.classList.toggle('mine', soundsGrad[i] !== 'transparent');
    b.style.setProperty('--lvl', `${Math.round(engine.fx[i].level * 100)}%`);
    b.style.setProperty('--deck-color', gpUnitColor(i));
    b.style.setProperty('--pc', gpUnitColor(i));
    b.style.setProperty('--sons', soundsGrad[i]);
  });
  // PER-PLAYER TABLE: each row (EFFECT / DURATION / ON-OFF) shows the
  // 4 columns side by side — one PER PLAYER (their color), with a strip in
  // the color of the TRACKS they selected. Nothing is shared: everyone
  // sees THEIR setting and the others', separately.
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
      s.style.setProperty('--dc', gpUnitColor(i)); // gray at rest, color when active
      s.style.setProperty('--pc', gpUnitColor(i));
      s.style.setProperty('--sons', soundsGrad[i]);    // color of THEIR tracks
      s.classList.toggle('sel', i === u);
      s.classList.toggle('live', engine.fx[i].enabled);
      s.classList.toggle('mine', soundsGrad[i] !== 'transparent');
    });
  };
  badges('type', (i) => FX_SHORT[engine.fx[i].type] || engine.fx[i].type.slice(0, 4).toUpperCase(),
    (i) => gpFxTypeStep(i, 1));
  badges('beats', (i) => {
    const bs = uiRefs.fxUnits[i].beatsSel;
    return bs.options[bs.selectedIndex].textContent.trim();
  }, (i) => gpFxBeatsStep(i, 1));
  badges('onoff', (i) => (engine.fx[i].enabled ? 'ON' : 'OFF'),
    (i) => uiRefs.fxUnits[i].onBtn.click());
  drawFxLevelKnob();
  // all cells take the deck color of the displayed unit
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
// Library
// ---------------------------------------------------------------------------

const libBody = document.getElementById('lib-body');
const libStatus = document.getElementById('lib-status');
let statusTimer = null;
let libLastMsg = ''; // last DURABLE library message (analysis…)
const rowByTrack = new Map();

function flashStatus(msg) {
  libStatus.textContent = msg;
  clearTimeout(statusTimer);
  // after 4 s we RESTORE the last library status (an analysis in
  // progress must not be wiped out by a passing flash)
  statusTimer = setTimeout(() => {
    libStatus.textContent = libLastMsg || (library ? t('lib_tracks_count', { n: library.tracks.length }) : '');
  }, 4000);
}

const library = new Library(engine.ctx, {
  onListChanged: renderLibrary,
  onSelectionChanged: () => updateSelectionUI(),
  // BPM analysis is only allowed to run when NO deck is playing
  canAnalyze: () => !engine.decks.some((d) => d.playing),
  onTrackUpdated: (t) => {
    const row = rowByTrack.get(t);
    if (row) {
      if (row._prev !== t.preview) fillPreviewCell(row.children[1], t);
      row.children[4].textContent = t.bpm ? t.bpm.toFixed(1) : '?';
      fillKeyCell(row.children[5], t);
      row.children[6].textContent = t.duration ? formatTime(t.duration) : '';
    }
    // A deck playing this track learns its key as soon as it is known
    engine.decks.forEach((d, i) => {
      if (d.track === t && t.musicKey != null && d.musicKey !== t.musicKey) {
        d.musicKey = t.musicKey;
        updateKeyUI(i);
      }
    });
  },
  onStatus: (msg) => { libLastMsg = msg; libStatus.textContent = msg; }
});

// PREVIEW cell: artwork (small square) + waveform. The waveform appears
// WITHOUT loading the track: quick preview for local files, waveform
// published by SoundCloud for its tracks — then the real colored preview
// as soon as the track has been on a deck.
function fillPreviewCell(td, t) {
  const row = td.parentElement;
  if (row) row._prev = t.preview;
  td.textContent = '';
  const box = document.createElement('div');
  box.className = 'prev-box';
  if (t.artwork) {
    const art = document.createElement('img');
    art.className = 'prev-art';
    art.alt = '';
    art.loading = 'lazy';
    art.src = t.artwork.replace('-t500x500', '-large');
    box.appendChild(art);
  }
  if (t.preview) {
    const w = document.createElement('img');
    w.className = 'prev-wave';
    w.alt = '';
    w.src = t.preview;
    box.appendChild(w);
  } else if (!t.artwork) {
    return; // neither waveform nor artwork (folder, playlist…): empty cell
  }
  td.appendChild(box);
}

// KEY cell: Camelot notation (harmonic mixing wheel) + classic name
// as tooltip; colored GREEN if compatible with the playing master
function fillKeyCell(td, t) {
  if (!td) return;
  if (t.musicKey == null) {
    td.textContent = '';
    td.className = 'col-key';
    td.title = '';
    return;
  }
  td.textContent = camelotLabel(t.musicKey);
  td.title = `${keyName(t.musicKey)} — ${camelotLabel(t.musicKey)}`;
  const ref = masterHeardKey();
  const dist = ref ? keyDistance(t.musicKey, ref.code) : null;
  td.className = `col-key${dist != null && dist <= 1 ? ' key-ok' : ''}`;
}

// HEARD key of the master (the leading deck), or null
function masterHeardKey() {
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const m = mi != null ? engine.decks[mi] : null;
  return m && m.buffer ? heardKey(m) : null;
}

// Refreshes the "already taken" green on the displayed rows (the same
// track can appear under several objects: folder, history…)
function markTakenRows() {
  rowByTrack.forEach((row, t) => row.classList.toggle('taken', !!t.name && library.isTaken(t)));
}

// Sortable headers: click = ascending → descending → original order
function updateSortHeaders() {
  document.querySelectorAll('#lib-table th[data-sort]').forEach((th) => {
    const on = library.sort.col === th.dataset.sort;
    th.classList.toggle('sorted', on);
    th.dataset.dir = on ? (library.sort.dir === 1 ? 'asc' : 'desc') : '';
  });
}
document.querySelectorAll('#lib-table th[data-sort]').forEach((th) => {
  th.title = t('sort_title');
  th.addEventListener('click', () => {
    library.toggleSort(th.dataset.sort);
    const lab = th.textContent.trim();
    flashStatus(library.sort.col
      ? t('sort_status', { col: lab, dir: t(library.sort.dir === 1 ? 'sort_asc' : 'sort_desc') })
      : t('sort_original'));
  });
});

let libRenderStamp = 0; // bumped on every render: the player marks follow
function renderLibrary() {
  libRenderStamp++;
  updateSortHeaders();
  libBody.textContent = '';
  rowByTrack.clear();
  lastSelIdx = library.selection;
  // Back button: visible inside a SoundCloud playlist — and, in b2b
  // (≥ 2 accounts), everywhere except on the account list (there is
  // always a level above: the account's playlists → account list)
  const backBtn = document.getElementById('btn-sc-back');
  if (backBtn) {
    const canScBack = library.mode === 'sc' && !library.scAccountsView &&
      ((library.scPlaylists && library.scPlaylists.length && library.scTracks !== library.scPlaylists) ||
       (library.scAccountCount || 0) >= 2);
    backBtn.classList.toggle('hidden', !canScBack);
  }
  // Playlist buttons: back + play visible when a playlist is open
  const plBackBtn = document.getElementById('btn-pl-back');
  const plPlayBtn = document.getElementById('btn-pl-play');
  if (plBackBtn) {
    const inside = library.mode === 'pl' && !!library.plOpen;
    plBackBtn.classList.toggle('hidden', !inside);
    plPlayBtn.classList.toggle('hidden', !inside);
  }
  updateNewDirBtn();
  const list = library.filtered.slice(0, 3000);
  const inPlaylist = library.mode === 'pl' && library.plOpen;
  list.forEach((track, idx) => {
    const tr = document.createElement('tr');
    if (idx === library.selection) tr.className = 'selected';
    // "Artist - Title" split on the first dash
    const sep = track.name.indexOf(' - ');
    const artist = sep > 0 ? track.name.slice(0, sep) : '';
    const title = sep > 0 ? track.name.slice(sep + 3) : track.name;
    const bpmCell = (track.scRootRow || track.plRootRow || track.scLikes || track.fsUpRow || track.scAccountRow)
      ? ''
      : track.fsRow
      ? t('lib_bpm_cell_folder')
      : track.plRow
        ? t('lib_bpm_cell_tracks', { n: track.count })
        : track.scPlaylist
          ? t('lib_bpm_cell_tracks', { n: track.trackCount })
          : (track.bpm ? track.bpm.toFixed(1) : (track.analyzed ? '?' : '…'));
    tr.innerHTML = `
      <td class="col-num">${idx + 1}</td>
      <td class="col-prev"></td>
      <td class="col-title"></td>
      <td class="col-artist"></td>
      <td class="col-bpm">${bpmCell}</td>
      <td class="col-key"></td>
      <td class="col-dur">${track.duration ? formatTime(track.duration) : ''}</td>
    `;
    fillPreviewCell(tr.children[1], track);
    fillKeyCell(tr.children[5], track);
    const isNavRow = track.plRow || track.fsRow || track.scRootRow || track.plRootRow || track.scLikes || track.fsUpRow || track.scAccountRow;
    // ALREADY TAKEN tonight (loaded on a deck): title written in GREEN
    if (!isNavRow && !track.scPlaylist && library.isTaken(track)) tr.classList.add('taken');
    tr.children[2].textContent = isNavRow ? track.name : title;
    // PROTECTED TRACK (DRM): flagged RIGHT IN THE LIST — never a nasty
    // surprise in the middle of a party. SoundCloud only unlocks it for its
    // licensed partner software.
    if (track.drm) {
      tr.classList.add('drm');
      tr.title = t('drm_protected_title');
      const lock = document.createElement('span');
      lock.className = 'drm-lock';
      lock.textContent = '🔒';
      tr.children[2].prepend(lock);
    }
    tr.children[3].textContent = isNavRow ? '' : artist;
    tr.addEventListener('click', () => {
      library.selection = idx;
      updateSelectionUI();
    });
    if (track.fsUpRow) {
      tr.addEventListener('dblclick', () => folderUp());
      // dropping on ".." = move into the parent folder
      makeFolderDropTarget(tr, () => (library.fsDir ? parentDir(library.fsDir) : null));
    } else if (track.scRootRow) {
      tr.addEventListener('dblclick', () => openSoundCloud());
    } else if (track.scLikes) {
      tr.addEventListener('dblclick', () => openScLikes(track.acctIdx));
    } else if (track.scAccountRow) {
      // SoundCloud account row (b2b): enter = ITS playlists, right-click =
      // remove the account from the list
      tr.addEventListener('dblclick', () => openScAccount(track.acctIdx));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showScAccountMenu(e, track);
      });
    } else if (track.plRootRow) {
      tr.addEventListener('dblclick', () => openPlaylistsRoot());
    } else if (track.fsRow) {
      // Folder row: double-click to ENTER it (the encoder too)
      tr.addEventListener('dblclick', () => enterFolder(track.path));
      // OpenMix music: files are FILED into it by drag and drop, and it can be moved
      makeFolderDropTarget(tr, () => track.path);
      if (inNative(track.path)) {
        if (!isNativeRoot(track.path)) {
          tr.draggable = true;
          tr.addEventListener('dragstart', (e) => startDirDrag(e, track.path));
          tr.addEventListener('dragend', () => { dragDir = null; });
        }
        tr.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showNativeFolderMenu(e, track.path);
        });
      }
    } else if (track.plRow) {
      // Playlist row: double-click to open it, right-click to manage it
      tr.addEventListener('dblclick', () => openLocalPlaylist(track.pl));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPlaylistMenu(e, track.pl);
      });
    } else if (track.scPlaylist) {
      // SoundCloud playlist: double-click to open it (with ITS account)
      tr.addEventListener('dblclick', () => openScPlaylist(track.permalink, track.acctIdx));
    } else {
      tr.draggable = true;
      tr.addEventListener('dragstart', (e) => {
        dragTrack = track;
        library.selection = idx;
        updateSelectionUI();
        e.dataTransfer.setData('text/plain', track.name);
        // copy (deck, playlist) or move (filing into the OpenMix music folder)
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      tr.addEventListener('dragend', () => { dragTrack = null; });
      tr.addEventListener('dblclick', () => loadSelectedToDeck(activeDeck));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTrackMenu(e, track, idx);
      });
      // Inside an open playlist: rows can be REORDERED by dropping onto a row
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
          // REAL indexes in the playlist (the displayed list may be
          // sorted or filtered: its position is not the playlist's)
          const from = p.tracks.indexOf(dragTrack);
          library.moveInPlaylist(p, from, p.tracks.indexOf(track));
          dragTrack = null;
        });
      }
    }
    libBody.appendChild(tr);
    rowByTrack.set(track, tr);
  });
  // The phone console receives the current list (names + BPM) — it can
  // load any track onto any deck remotely
  if (window.api.remoteLib) {
    window.api.remoteLib({
      stamp: libRenderStamp,
      title: library.mode === 'sc' ? (library.scTitle || 'SoundCloud') : t('library_label'),
      items: library.filtered.slice(0, 400).map((t) => ({
        name: t.name,
        bpm: t.bpm ? Number(t.bpm.toFixed(1)) : null,
        // ALL navigation rows are flagged: the phone must never be able
        // to "load" an account or a folder onto a deck
        pl: !!(t.scPlaylist || t.plRow || t.scAccountRow || t.scLikes ||
               t.scRootRow || t.plRootRow || t.fsRow || t.fsUpRow)
      }))
    });
  }
}

// Right-click menu on a PLAYLIST (rename / delete)
function showPlaylistMenu(e, p) {
  ctxMenu.textContent = '';
  const addItem = (label, fn) => {
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); fn(); });
    ctxMenu.appendChild(d);
  };
  addItem(t('play_active_deck_menu'), () => {
    if (!p.tracks.length) return;
    const i = activeDeck;
    deckQueues[i] = p.tracks.slice(1).map(t => ({ ...t }));
    updateQueueUI(i);
    loadTrackToDeck(i, { ...p.tracks[0] }, true);
  });
  addItem(t('export_usb_label'), async () => {
    if (!p.tracks.length) {
      flashStatus(t('playlist_empty'));
      return;
    }
    flashStatus(t('export_preparing', { name: p.name }));
    // SoundCloud tracks without a local copy are downloaded first
    for (const ref of p.tracks) {
      if (ref.sc && !ref.path) {
        flashStatus(t('downloading_track', { name: ref.name }));
        await ensureLocalCopy(ref);
      }
    }
    const items = p.tracks.map(ref => library.exportData(ref));
    const res = await window.api.exportPlaylist(p.name, items);
    if (res.ok) {
      flashStatus(t('export_done', { name: p.name, count: res.count, skipped: res.skipped ? t('export_done_skipped', { n: res.skipped }) : '', dir: res.dir }));
    } else if (!res.canceled) {
      flashStatus(t('playlist_export_error', { error: res.error }));
    }
  });
  addItem(t('dl_menu_rename'), async () => {
    const name = await askText(t('playlist_rename_prompt'), p.name);
    if (name) {
      p.name = name;
      library.savePlaylists();
      renderLibrary();
    }
  });
  addItem(t('playlist_delete_label'), () => library.deletePlaylist(p));
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 110)}px`;
  ctxMenu.classList.remove('hidden');
}

// Right-click menu on a 👤 SoundCloud account row: remove the account
// (end of the b2b — the friend's tokens don't stay on the PC)
function showScAccountMenu(e, acctRow) {
  ctxMenu.textContent = '';
  const d = document.createElement('div');
  d.className = 'ctx-item';
  d.textContent = t('remove_account_label', { name: String(acctRow.name || '').replace(/^👤 /, '') });
  d.addEventListener('click', async () => {
    hideCtxMenu();
    const r = await window.api.scRemoveAccount(acctRow.acctIdx);
    if (!r.ok) {
      flashStatus(t('sc_error', { error: r.error }));
      return;
    }
    flashStatus(t('sc_account_removed'));
    // The account indexes have shifted (splice): the view's per-account
    // caches are worthless now, and the tree must start from scratch
    library.scPlaylistsByAcct = {};
    library.scPlaylists = null;
    await refreshScStatus();
    buildTree();
    openSoundCloud(); // re-dispatch: prompt / playlists / account list
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
      // At the very top: scroll to zero, otherwise the STICKY HEADER covers
      // the first row ("I can't see the first playlist")
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

// Enter a disk folder (explorer, encoder, double-click) — the TREE on
// the left expands and highlights itself to show WHERE we are
function enterFolder(p) {
  setLibTab('local');
  library.cache.__folder = p;
  library.scan(p);
  treeReveal(p);
}

// Tree key of a SoundCloud entry: prefixed with the account when there are
// several — with a single account the tree keeps its historical keys
function scTreeKey(idx, leaf) {
  return (library.scAccountCount || 0) >= 2 ? `sc:${idx}:${leaf}` : `sc:${leaf}`;
}

// Enter SoundCloud — depending on the number of connected accounts: 0 = prompt
// to log in; 1 = straight to ITS playlists (as before); ≥ 2 (b2b) = the
// account list, each one fetches its tracks from its own account.
// Each destination ALSO highlights its row in the left tree — the
// "micro menu" always tells where you are, like the VS Code sidebar
async function openSoundCloud() {
  setLibTab('sc');
  const s = await window.api.scStatus();
  const accounts = (s && s.accounts) || [];
  library.scAccountCount = accounts.length;
  if (!accounts.length) {
    flashStatus(t('sc_no_account_status'));
  } else if (accounts.length === 1) {
    library.loadScMine(0);
  } else {
    library.loadScAccounts();
  }
  treeRevealKey('sc:');
}
// Playlists of ONE specific account (double-clicked 👤 row, tree node…)
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

// Go up to the PARENT folder — once at the very top (drive root), we
// land on the ROOTS VIEW (SoundCloud, Playlists, drives): the starting
// point of the walk
function folderUp() {
  if (library.rootsView) return false; // already at the very top
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

  // "Folder" row: enter it instead of loading
  if (track.fsRow) {
    enterFolder(track.path);
    return;
  }
  // "SoundCloud playlist" row: open the playlist instead of loading a deck
  if (track.scPlaylist) {
    library.loadScUrl(track.permalink, track.acctIdx);
    return;
  }
  // "SoundCloud account" row (b2b): enter ITS playlists
  if (track.scAccountRow) {
    openScAccount(track.acctIdx);
    return;
  }
  // "Local playlist" row: open it
  if (track.plRow) {
    library.openPlaylist(track.pl);
    return;
  }
  loadTrackToDeck(i, track);
}

// A track ALREADY PLAYING elsewhere is refused: small animation + message
function refuseLoad(i, dup) {
  flashStatus(t('track_already_playing', { n: dup + 1 }));
  [deckUI[i].el, deckUI[dup].el].forEach((el2) => {
    if (!el2) return;
    el2.classList.remove('refused');
    void el2.offsetWidth;
    el2.classList.add('refused');
    setTimeout(() => el2.classList.remove('refused'), 550);
  });
}

// Sends the phone server a COMPACT version of the deck's waveform
// (24 pts/s, 3 bands quantized to 0..255) — the phone draws it like
// the PC: colors per band, bar lines, scrolling playhead
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
  if (!track || track.scPlaylist) return;
  // a NAVIGATION row (folder, playlist, account…) cannot be loaded
  if (track.fsRow || track.fsUpRow || track.plRow || track.scRootRow || track.plRootRow
    || track.scAccountRow || track.scLikes) return;
  // Protected (DRM): IMMEDIATE refusal, without waiting for a network round trip
  if (track.drm) {
    flashStatus(t('track_drm_protected_status', { name: track.name }));
    return;
  }
  // Refuse if the SAME track is already playing on another deck
  const dup = engine.decks.findIndex((dk, j) => j !== i && dk.playing && dk.track &&
    ((dk.track.path && track.path && dk.track.path === track.path) ||
     (dk.track.scId && track.scId && dk.track.scId === track.scId)));
  if (dup >= 0) {
    refuseLoad(i, dup);
    return;
  }

  engine.resume();
  // ANOTHER TRACK ARRIVES DURING A LOAD (the 3-hour set dropped by
  // mistake…): the first one is CANCELLED — SoundCloud download stopped, its
  // decoding and analysis abandoned — and the new one starts right away
  if (ui.loading) {
    const prev = ui.loading;
    prev.cancelled = true;
    if (prev.track && prev.track.sc && !prev.track.path && window.api.scCancel) window.api.scCancel(prev.track.scId);
    flashStatus(t('load_cancelled', { n: i + 1, old: prev.track.name, name: track.name }));
  }
  const job = { track, cancelled: false };
  ui.loading = job;
  ui.title.textContent = t('loading_title', { name: track.name });
  try {
    const { buffer, bpm, beatOffset, beats, gridShift, barAnchor, hotCues, musicKey } = await library.loadForDeck(track,
      (msg) => { if (ui.loading === job) ui.title.textContent = `${msg} ${track.name}`; },
      () => job.cancelled);
    if (job.cancelled) return;
    const peaks = await computeBandPeaks(buffer);
    if (job.cancelled) return;
    // real colored preview in the list (free: peaks already computed)
    library.setPreviewFromPeaks(track, peaks);
    // SAVED hot cues come back on every load (like
    // Rekordbox — David's request, reversing the "blank load" choice)
    engine.decks[i].loadTrack({ buffer, bpm, peaks, track, beatOffset, hotCues: (hotCues || []).slice(), beats, gridShift, barAnchor });
    ui.cueOwner = Array(10).fill(null);
    ui.loopOwner = null;
    ui.title.textContent = track.name;
    ui.keyVal.textContent = '0';
    ui.keyVal.classList.remove('shifted');
    engine.decks[i].musicKey = musicKey != null ? musicKey : (track.musicKey ?? null);
    ui._keySig = null;
    updateKeyUI(i);
    resetStemsCol(i);
    updateTempoLabel(i);
    remotePushWave(i); // the phone console receives the new waveform
    // ARTWORK: file tags (or SoundCloud cover), cached after the
    // first read — shown in the deck header
    ui.cover.classList.add('hidden');
    ui._coverTrack = track;
    library.coverFor(track).then((url) => {
      if (ui._coverTrack !== track) return; // another track has been loaded since
      if (url) {
        ui.cover.src = url;
        ui.cover.classList.remove('hidden');
      }
    });
    flashStatus(t('track_loaded', { name: track.name, n: i + 1 }));
    library.addHistory(track);
    markTakenRows(); // the track turns GREEN in the explorer, right away
    if (autoplay) engine.decks[i].play();
    autoPrepareStems(i); // stems are prepared in the background
  } catch (err) {
    // cancelled in favor of another track: not an error
    if (job.cancelled || err.cancelled) return;
    ui.title.textContent = t('load_error_title');
    flashStatus(t('track_load_failed', { name: track.name, error: err.message || err }));
    console.error(err);
  } finally {
    if (ui.loading === job) ui.loading = null;
  }
}

// ---------------------------------------------------------------------------
// Gamepad
// ---------------------------------------------------------------------------

const padStatus = document.getElementById('pad-status');

// --- KNOB MATRIX for the gamepad cursor (David's spec) ---
// The cursor moves ONLY on this matrix:
//   Row 0 (very top): MASTER — FILTER MASTER and VOL MASTER
//   Rows 1-5: TRIM / HI / MID / LOW / FILTER — one COLUMN PER DECK
// Cross/A  = cut / restore the hovered knob. The BASSES are EXCLUSIVE:
//            restoring one deck's bass automatically cuts the others'
//            (never two basses at the same time, like the gamepad mix).
// Triangle/Y = CUT: cuts the volume of the selected decks (L3) at once,
//              pressing again brings everything back at once.
// L1/R1 = raise/lower little by little; left stick = play with the knob.

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
const GP_ROWS = 1 + GP_KNOBS.length; // 1 master row + 5 knob rows
// FX column (right of the knobs): ONE SINGLE panel shared by up to 4
// players — it shows the FX unit of the player using it (gpFxShown)
const GP_FX_COL = 4;
let gpFxShown = 0; // FX unit currently shown in the shared panel
let gpFxFlashAt = 0; // throttle for the level % in the status bar
function gpShowFxUnit(u) {
  gpFxShown = Math.max(0, Math.min(3, u));
  (uiRefs.fxTabs || []).forEach((b, i) => b.classList.toggle('on', i === gpFxShown));
  updateFxPanel();
}
const gpFxUnitOf = (cur) => (cur.c === GP_FX_COL
  ? gpFxShown
  : Math.min(cur.c, deckCount - 1));
// The FX column is a MATRIX of "solo" cells aligned with the knob
// rows (one per row) — L2 or R2 trigger the cell
// (the DECK row is gone: the selection already shows where the effect goes)
const GP_FX_ROWS = [
  { key: 'type', label: t('fx_row_effect') },   // TRIM row
  { key: 'beats', label: t('fx_row_duration') },  // HI row
  { key: 'level', label: t('fx_row_level') }, // MID row
  { key: 'onoff', label: 'ON/OFF' }  // LOW + FILTER rows
];
const gpFxRowKey = (r) => GP_FX_ROWS[Math.min(Math.max(r - 1, 0), GP_FX_ROWS.length - 1)].key;

// Cell hovered by a cursor (r, c) — normalizes master/knob/FX
function gpCellAt(cur) {
  if (cur.r > 0 && cur.c === GP_FX_COL) {
    // FX column: one CELL per row (EFFECT / LENGTH / LEVEL / ON-OFF).
    // Only the LEVEL row is a continuous setting (stick, L1/R1).
    const u = gpFxShown;
    const key = gpFxRowKey(cur.r);
    const el = () => (uiRefs.fxPanel ? uiRefs.fxPanel.cells[key] : null);
    if (key === 'level') {
      return {
        key: `fxlvl${u}`, deck: null, label: t('gp_cell_fx_level_label'), killVal: 0, speed: 1.1,
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
    // Top row PER COLUMN: SELECT above each channel strip,
    // COLOR (the effects filter) on the FX column. Everywhere on this
    // row: stick = FILTER MASTER, L1/R1 = VOL MASTER.
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

// Jog pitch bend in progress per deck (tempo/synced to restore on release)
const gpBend = [null, null, null, null];
// Reference tempo for the jog: if the sync lock had a transient correction
// in progress, start again from the CLEAN base tempo (not the corrected one)
function gpBaseTempo(deck) {
  return deck.synced && deck._syncBase ? deck._syncBase : deck.tempo;
}

// ♩ MASTER BPM: pushes the master deck's tempo by ±0.5 BPM — and ALL the
// synced decks follow instantly (their _syncBase ratio is scaled,
// the phase lock keeps the red lines stuck together)
function masterBpmNudge(dir) {
  engine.resume();
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  const m = mi != null ? engine.decks[mi] : null;
  if (!m || !m.bpm) {
    flashStatus(t('bpm_master_needs_track'));
    return;
  }
  const cur = m.bpm * m.tempo;
  const target = Math.max(40, Math.min(220, cur + dir * 0.5));
  const factor = target / cur;
  const nt = m.tempo * factor;
  m.setTempo(nt);
  if (m._syncBase) m._syncBase = nt;
  const followers = [];
  // (synced decks follow on their own: the engine lock detects that
  // the master's tempo moved and scales them on the next frame —
  // scaling them HERE as well doubled the change)
  engine.decks.forEach((d, i) => {
    if (i === mi || !d.synced || !d.playing || !d._syncBase) return;
    followers.push(i + 1);
  });
  flashStatus(t('bpm_master_set', { bpm: target.toFixed(1), sync: followers.length ? t('bpm_master_sync_suffix', { decks: followers.join(' + ') }) : '' }));
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

// --- FX list shown while Square is held: you see where you are
// and the effect scrolls little by little ---
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

// --- Logo button: cut / restore the knob (with exclusive basses) ---
const gpKillStore = new Map(); // "key:deck" -> value before the cut

function gpKillKnob(cur, gi) {
  engine.resume();
  // On the SELECT row: the logo = same gesture as X (selection / COLOR on-off)
  if (cur.r === 0) {
    if (cur.c === GP_FX_COL) document.getElementById('color-on').click();
    else gpSelectToggle(Math.min(cur.c, deckCount - 1), gi);
    return;
  }
  const cell = gpCellAt(cur);
  const kkey = `${cell.key}:${cell.deck}`;
  if (cell.exclusive) {
    // THE bass rule: only one active bass at a time
    if (gpKillStore.has(kkey)) {
      // restore HERE... and cut all the others
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
      flashStatus(t('bass_routed', { n: cell.deck + 1 }));
    } else {
      gpKillStore.set(kkey, cell.get());
      cell.set(-1);
      flashStatus(t('bass_cut', { n: cell.deck + 1 }));
    }
    return;
  }
  if (gpKillStore.has(kkey)) {
    cell.set(gpKillStore.get(kkey));
    gpKillStore.delete(kkey);
    flashStatus(t('fx_reenabled', { label: cell.label }));
  } else {
    gpKillStore.set(kkey, cell.get());
    cell.set(cell.killVal);
    flashStatus(t('fx_cut', { label: cell.label }));
  }
}

// --- L3: select decks · Triangle/Y: grouped CUT ---
// CO-SELECTION: each player has THEIR OWN set of decks — several players
// can take THE SAME track, their effects COMBINE on it (one FX unit
// per player, the engine's sends add up).
const gpSelection = new Set(); // UNION of all the selections (derived)
const gpSelOwners = [new Set(), new Set(), new Set(), new Set()]; // per player
const gpSelNeutral = new Set(); // mouse selection (no player)
const gpCutStore = new Map();  // deck -> volume before the cut

function gpSelSync() {
  gpSelection.clear();
  gpSelNeutral.forEach((t) => gpSelection.add(t));
  gpSelOwners.forEach((s) => s.forEach((t) => gpSelection.add(t)));
}

// The players who selected THIS deck (for the multi-player gradients)
function gpSelOwnersOf(d) {
  const out = [];
  gpSelOwners.forEach((s, gi) => { if (s.has(d)) out.push(gi); });
  return out;
}

// Repaints the SEL buttons and the channel strip borders: one color per
// owning player — several players = segmented gradient (like the
// shared pads); mouse = deck color
function gpPaintSelection() {
  stripUI.forEach((s, i) => {
    const on = gpSelection.has(i);
    const owners = gpSelOwnersOf(i);
    const solid = owners.length ? PLAYER_COLORS[owners[0]] : DECK_COLORS[i];
    s.el.classList.toggle('gp-sel', on);
    s.el.style.setProperty('--psel', solid);
    // The WHOLE strip is tinted with the player's color (two players =
    // two bands): you see from afar WHO took WHAT, not a small frame
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
        ? t('gp_sel_btn_players', { players: owners.map((g) => g + 1).join('+') })
        : 'SEL';
      if (s.selBtn.textContent !== txt) s.selBtn.textContent = txt;
    }
  });
}

// The selected tracks that ONLY THIS PLAYER controls: the ones they
// selected themselves + those with no owner (mouse). EMPTY if the
// player has no track in the selection: their buttons and sticks
// then stay in NORMAL mode (JUMP/LOOP/CUE/KEY pads, hovered knob…)
// → select = FX mode, deselect = immediate return to the pads.
function gpSelFor(gi) {
  if (gi == null) return [...gpSelection];
  return [...new Set([...gpSelOwners[Math.min(gi, 3)], ...gpSelNeutral])];
}

// FX units belong to the PLAYERS: unit 1 = P1 … unit 4 = P4.
// SOBER AT REST: neutral gray as long as the player has selected nothing —
// their color only appears when they are IN PLAY (Rekordbox aesthetics:
// color only exists when it carries information)
function gpUnitColor(u) {
  return gpSonsOf(u).length ? (PLAYER_COLORS[u] || '#5a6272') : '#5a6272';
}

// The TRACKS player gi selected themselves (for the rack's "track
// color" bands — you see who took which tracks)
function gpSonsOf(gi) {
  return [...gpSelOwners[Math.min(gi, 3)]].sort();
}

function gpSelectToggle(d, gi) {
  // Each player only touches THEIR selection: taking a track already
  // taken by another = CO-SELECTION (both effects combine),
  // never stealing a selection.
  const set = gi != null ? gpSelOwners[Math.min(gi, 3)] : gpSelNeutral;
  const selecting = !set.has(d);
  // FX units are PER PLAYER (unit 1 = P1 … unit 4 = P4): each one has
  // THEIR effect, THEIR length, THEIR level — applied to the tracks THEY select.
  const u = gi != null ? Math.min(gi, 3) : Math.min(d, 3);
  if (selecting) {
    set.add(d);
    gpFxAssignSet(u, d, true);
    engine.updateFxSends();
    if (!engine.fx[u].enabled) uiRefs.fxUnits[u].onBtn.click();
    const colorOn = document.getElementById('color-on');
    if (colorOn && !colorOn.classList.contains('on')) colorOn.click();
    // arming the filter = COLOR ON **on Filter** (the left stick must
    // filter, not send an echo — the FX is the right stick)
    const csel = uiRefs.master.colorSel;
    if (csel && csel.value !== 'filter') {
      csel.value = 'filter';
      csel.dispatchEvent(new Event('change'));
    }
  } else {
    set.delete(d);
    // the track only leaves THIS PLAYER's unit — if another player
    // also selected it, THEIR effect carries on undisturbed.
    // (MOUSE deselection: unit min(d,3) belongs to player min(d,3)+1
    // — if they took this track themselves, their routing is left alone)
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
    ? t('selection_status', { player: gi != null ? t('player_prefix', { n: gi + 1 }) : '', decks: mine.map((x) => x + 1).join(' + ') || '—', union: [...gpSelection].sort().map((x) => x + 1).join('+') })
    : t('selection_cleared'));
}

function gpCutToggle(fallbackDeck) {
  engine.resume();
  if (gpCutStore.size) {
    // everything comes back at once — the "cut" effect of the gamepad mix
    for (const [d, v] of gpCutStore) {
      engine.decks[d].setVolume(v);
      stripUI[d].fader.update();
    }
    gpCutStore.clear();
    flashStatus(t('cut_released'));
    return;
  }
  const targets = gpSelection.size ? [...gpSelection] : [fallbackDeck];
  for (const d of targets) {
    gpCutStore.set(d, engine.decks[d].volume);
    engine.decks[d].setVolume(0);
    stripUI[d].fader.update();
  }
  flashStatus(t('cut_status', { decks: targets.sort().map(x => x + 1).join(' + '), s: targets.length > 1 ? 's' : '' }));
}

// Visible cursors (one per player, color of the controlled deck) with the
// L/R tags showing what L2/R2 will do on this row
const gpCursorEls = [];
const gpSideCursorEls = []; // L2/R2 frames placed on the REAL targeted pads
const gpPrevEls = [];       // jump/loop preview on the waveform
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
    // Preview on the waveform: 2 lines (backward/forward jump
    // destinations) + 1 band (span of the loop that would be set)
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

// Markers on the matrix KNOBS: each row matches its pair of
// cues (L2 = left, R2 = right). The cue LETTER is shown on the correct
// side of the knob, in the color of the player who set it (otherwise deck).
// And when a LOOP of the row's size is running: animated ring
// around the knob, in the color of the player holding the loop.
const gpKnobMarks = new Map(); // "deck:row" -> { l, r, ring }
let gpKnobMarkSig = ''; // guard: 3600 style writes/s for nothing
function gpUpdateKnobMarks() {
  // SMOOTHNESS: called 60×/s even with no gamepad and empty decks, it
  // rewrote 60 styles per frame (3600/s) for a display that only changes
  // when a cue or a loop is set. Signature first, work afterwards.
  let sig = '';
  for (let d = 0; d < 4; d++) {
    const dk = engine.decks[d];
    const u = deckUI[d];
    let bits = 0;
    if (dk.hotCues) {
      for (let k = 0; k < dk.hotCues.length; k++) if (dk.hotCues[k] != null) bits |= 1 << k;
    }
    sig += `${bits}:${u.cueOwner ? u.cueOwner.map((o) => (o ? o.join('.') : '-')).join(',') : ''}`
      + `:${dk.looping ? dk._loopBeats : 0}:${u.jumpScale}:${u.loopOwner}:${dk.playing ? 1 : 0}|`;
  }
  // the size guard lets the 1st pass CREATE the tags
  if (sig === gpKnobMarkSig && gpKnobMarks.size >= 4 * GP_KNOBS.length) return;
  gpKnobMarkSig = sig;
  for (let d = 0; d < 4; d++) {
    const deck = engine.decks[d];
    const ui = deckUI[d];
    for (let r2 = 1; r2 <= GP_KNOBS.length; r2++) {
      const key = `${d}:${r2}`;
      let mk = gpKnobMarks.get(key);
      if (!mk) {
        const host = GP_KNOBS[r2 - 1].el(d);
        if (!host) continue;
        // guaranteed anchoring: the knob wrapper becomes the reference frame
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
          // two players on the same cue = half/half tag;
          // cue with no owner (cache/mouse) = NEUTRAL gray
          el2.style.background = gpOwnersBg(owners, '#8a94ae');
          const glow = owners.length === 1 ? PLAYER_COLORS[owners[0]]
            : owners.length ? '#ffffff' : '#8a94ae';
          el2.style.boxShadow = `0 0 7px ${glow}`;
        }
      };
      letter(mk.l, r2 - 1);   // L2 cue on this row
      letter(mk.r, 10 - r2);  // R2 cue
      // LOOP animation on the knob of the row whose loop is running
      const loopOn = deck.looping &&
        deck._loopBeats === LOOP_ROW_BEATS[r2 - 1] * (ui.jumpScale || 1);
      mk.ring.style.display = loopOn ? '' : 'none';
      if (loopOn) {
        const c = ui.loopOwner != null ? PLAYER_COLORS[gpOwnersOf(ui.loopOwner)[0]] : '#5fe08a';
        mk.ring.style.color = c;
        mk.ring.style.borderColor = c;
        // deck playing = the ring SPINS · paused = static (prepared)
        mk.ring.classList.toggle('prepared', !deck.playing);
      }
    }
  }
}

// Library selections of ALL players shown AT THE SAME TIME:
// - solid bar = the row the player is currently navigating
// - bar + P1/P2 badge = the track that player LOADED (PERMANENT marker,
//   it stays even after leaving navigation — "who displayed what")
const gpLoadedTrack = [null, null, null, null]; // last track loaded per player
let gpNavMarkedRows = [];
let gpModeBtnSig = ''; // guard: mode tabs repainted only on change
let gpNavMarkSig = '';
function gpUpdateNavMarks() {
  // SMOOTHNESS: only redo the marking (removing/adding DOM badges) if
  // something moved — not 60 times per second for nothing
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
      ? `${row.style.boxShadow}, inset -4px 0 0 ${c}` // 2nd player: right bar
      : `inset 4px 0 0 ${c}, inset 0 0 16px ${c}2e`;
    row.classList.add('psel');
    if (badge && !row.querySelector(`.psel-badge[data-gi="${badge.gi}"]`)) {
      const s2 = document.createElement('span');
      s2.className = 'psel-badge';
      s2.dataset.gi = badge.gi;
      s2.textContent = t('gp_player_tag', { n: badge.gi + 1 });
      s2.style.background = c;
      const cell = row.children[2] || row;
      cell.appendChild(s2);
    }
    gpNavMarkedRows.push(row);
  };
  // LOADED tracks (permanent, follows the track even if the list moves)
  gpLoadedTrack.forEach((t, gi) => {
    if (!t) return;
    const idx = library.filtered.indexOf(t);
    if (idx < 0) return;
    mark(libBody.children[idx], PLAYER_COLORS[gi], { gi });
  });
  // Navigation cursors (while browsing)
  for (const [gi, st] of gamepad.pads.entries()) {
    if (st.navSel == null) continue;
    mark(libBody.children[st.navSel], PLAYER_COLORS[gi] || '#fff', null);
  }
}

// Tag of the action L2/R2 will perform for THIS player (according to THEIR mode)
function gpSideLabel(st, side) {
  const idx = padForSide(st.cur.r, side);
  const p = side > 0 ? 'R2' : 'L2';
  if (st.cur.r === 0 && st.cur.c !== GP_FX_COL) {
    return side > 0 ? `${p} ♩+` : `${p} ♩−`; // master BPM on the top row
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
  const li = st.cur.r - 1; // left pad of the row: IN / OUT / ✕
  return side > 0
    ? `${p} ↻${LOOP_ROW_BEATS[st.cur.r - 1]}`
    : `${p} ${li === 0 ? 'IN' : li === 1 ? 'OUT' : '✕'}`;
}

// Preview on the zoomed waveform: where the jump lands / which area
// the loop will cover, drawn in the player's color
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
    ? JUMP_ROW_MEASURES[st.cur.r - 1] * 4 // bars → beats
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
    // jump destinations (size already converted to beats)
    placeLine(prev.l, gridT(-size));
    placeLine(prev.r, gridT(size));
    prev.band.classList.add('hidden');
    return;
  }
  // LOOP: area the loop would cover if set now (snapped start)
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

// Which deck PADS will L2 and R2 "click" from this row?
// Simple now: the row gives the pair, L = left, R = right.
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

// nth: when TWO players target the same element, the 2nd frame nests
// around the 1st (otherwise only the last one would be visible) and its tag
// moves to the other side
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
  // The targeted pad is FILLED with the player's color (visible selection)
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

// --- SMART PADS: each pad shows what EACH player present on the deck
// will do, in THEIR color. Two players with two different modes
// → the button is SPLIT (P1 loop segment / P2 jump segment).
// The others see your config, but each one keeps their own. ---
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
      renderPads(d); // no player here anymore: back to the tab display
      ui._padViewSig = 'plain';
      return;
    }
    ui._padViewSig = sig;
    // Same mode for all the players present? No repetitive pattern:
    // ONE single label and the whole button filled with the players' colors.
    const uniq = [...new Set(players.map((p) => p.mode))];
    ui._mergedMode = uniq.length === 1 ? uniq[0] : null;
    ui.pads.forEach((p, idx) => {
      if (uniq.length === 1) {
        // Same mode: ONE label, and the WHOLE button filled.
        // One player → the whole pad in their color. Several → REAL
        // bands per player (the L2/R2 frame and the activation then only
        // target the part of the player concerned).
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
      p.title = players.map(({ gi, mode }) => t('gp_pad_player_mode_title', { n: gi + 1, mode: GP_MODE_NAMES[mode] })).join(' · ');
    });
  });
}

// ANIMATION where L2/R2 strikes: neon flash in the player's color
// (jump destination, loop area, pressed pad)
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

// Flash at the impact point of the L2/R2 action on the deck's waveform
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
    ? JUMP_ROW_MEASURES[st.cur.r - 1] * 4 // bars → beats
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
    // cue / key: flash at the playhead line
    gpBurst(r.left + r.width / 2 - 12, r.top, 24, r.height, col);
  }
}

function updateGpCursors() {
  const entries = [...gamepad.pads.entries()];
  // Shared FX panel: if a player is on the FX column, the panel
  // shows THEIR unit (their deck's) — "the space is shared"
  for (const [, st] of entries) {
    if (st.cur.r >= 1 && st.cur.c === GP_FX_COL) { gpFxShown = Math.min(st.player - 1, 3); break; }
  }
  updateFxPanel(); // FX cells up to date (level, on/off, live effect)
  updateMasterBpmVal(); // live master BPM in the MASTER row
  // CUE/JUMP/LOOP/KEY tabs: FILLED with the color of each player
  // present on the deck. SMOOTHNESS: repainted ONLY when a player
  // moves or changes mode — not 80 style writes per frame
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
  gpUpdateNavMarks(); // library selections of ALL players
  gpUpdateKnobMarks(); // cue letters + loop ring on the knobs
  // Jump/loop previews: indexed by gamepad (gamepad.index)
  for (let g = 0; g < 4; g++) {
    gpUpdatePreview(g, gamepad.pads.get(g) || null);
  }
  gpUpdatePadViews(); // pads split per player
  // Target occupancy: 2 players on the same element → nested frames
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
    const isNav = st.cur.r >= GP_ROWS; // navigation zone below FILTER
    let target = null;
    let cell = null;
    if (isNav) {
      // Each player sees THEIR selected row in the explorer
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
    // Two players on the SAME element: nested frames (otherwise only the
    // last one would be visible), tag on the other side
    const nth = nthOf(target);
    const off = 3 + nth * 5;
    el.classList.remove('hidden');
    el.style.left = `${r.left - off}px`;
    el.style.top = `${r.top - off}px`;
    el.style.width = `${r.width + off * 2}px`;
    el.style.height = `${r.height + off * 2}px`;
    // Each PLAYER has THEIR OWN neon color (never a track's)
    const col = PLAYER_COLORS[gi] || '#e8e8ec';
    el.style.borderColor = col;
    el.style.boxShadow = `0 0 10px ${col}, 0 0 22px ${col}55`;
    const tag = el.querySelector('.gp-cursor-tag');
    // COMPACT tag (the full name hid the channel strip's title):
    // just P1/P2, in the corner, on the other side if overlapping
    tag.textContent = isNav ? `${t('gp_player_tag', { n: gi + 1 })} 📁` : t('gp_player_tag', { n: gi + 1 });
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
    // GLITCH effect when the cursor moves
    const moveKey = isNav ? `n${st.navSel}` : `${st.cur.r}:${st.cur.c}`;
    if (st._glitchKey !== moveKey) {
      st._glitchKey = moveKey;
      el.classList.remove('gp-glitch');
      void el.offsetWidth; // restart the animation
      el.classList.add('gp-glitch');
    }
    // L2 / R2: we FRAME the real pads that are about to be "clicked",
    // with the player's ACTION ("L2 −4", "R2 🔁8", "R2·F", "L2 −2♪")
    const lEl = el.querySelector('.gp-side-l');
    const rEl = el.querySelector('.gp-side-r');
    const frames = gpSideCursorEls[i];
    const inKnobs = !isNav && st.cur.r >= 1 && st.cur.r <= GP_KNOBS.length;
    const targets = inKnobs ? gpSideTargets(st) : { l: null, r: null };
    // On a split pad (segments OR bands), only frame THIS player's
    // part
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
  // Hide the frames of the players without a gamepad
  for (let i = gamepad.pads.size; i < 4; i++) {
    gpSideCursorEls[i].l.classList.add('hidden');
    gpSideCursorEls[i].r.classList.add('hidden');
  }
}

// 🎮 P1/P2… badges: show which player controls which deck
function updatePadChips() {
  const infos = gamepad.padsInfo();
  deckUI.forEach((ui, d) => {
    const players = infos.filter(p => p.deck === d).map(p => t('gp_player_tag', { n: p.player }));
    ui.padChip.textContent = players.length ? players.join('+') : '';
    ui.padChip.classList.toggle('hidden', !players.length);
  });
  padStatus.textContent = infos.length
    ? t(infos.length > 1 ? 'gamepad_count_many' : 'gamepad_count_one', { n: infos.length })
    : t('no_gamepad');
  padStatus.className = infos.length ? 'pad-on' : 'pad-off';
}

const gamepad = new GamepadManager({
  deckCount: () => deckCount,
  gridRows: () => GP_ROWS,
  // VISUAL order of the mixer columns (club: 3 1 2 4 then the FX rack on
  // the right) — the D-pad moves from cell to cell ON SCREEN
  visualOrder: () => (deckCount === 2 ? [0, 1, GP_FX_COL] : [2, 0, 1, 3, GP_FX_COL]),
  onConnection: () => {
    updatePadChips();
    renderHelp();
  },
  playToggle: (d) => playDeck(d),
  // Cross/A: Play/Pause — ON THE DECK CELL of the FX = turns the highlighted
  // deck on/off BY HAND (select where the effect goes)
  padPrimary: (st, d) => {
    if (st.cur.r === 0) {
      // SELECT row: X selects the track · on COLOR: changes the effect
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
      // X = THE action button on each FX cell
      const u = gpFxShown;
      const key = gpFxRowKey(st.cur.r);
      engine.resume();
      if (key === 'type') {
        gpFxTypeStep(u, 1);
      } else if (key === 'beats') {
        gpFxBeatsStep(u, 1); // X = double the length
      } else if (key === 'onoff') {
        uiRefs.fxUnits[u].onBtn.click();
      } else if (key === 'level') {
        // X on LEVEL: +25 % and wraps around to 0
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
  // Button right of the logo (Menu/Options): the deck's BEAT SYNC ON/OFF
  syncToggle: (d) => {
    const deck = engine.decks[d];
    if (deck.synced) {
      deck.synced = false;
      flashStatus(`Deck ${d + 1} — SYNC OFF`);
    } else {
      syncDeck(d);
    }
  },
  // L1/R1 held: VOLUME of the column's deck — on the master row,
  // they drive the hovered master knob (FILTER MASTER or VOL MASTER)
  volumeHold: (cur, dir, dt) => {
    engine.resume();
    if (cur.r === 0) {
      // SELECT/COLOR row: L1/R1 = MASTER VOLUME
      engine.setMasterVolume(engine.masterVolume + dir * 0.7 * dt);
      uiRefs.master.volKnob.update();
      return;
    }
    if (cur.c === GP_FX_COL) {
      // FX column: L1/R1 drive the hovered cell (level)
      const cell = gpCellAt(cur);
      cell.set(cell.get() + dir * cell.speed * dt);
      return;
    }
    const d = Math.min(cur.c, deckCount - 1);
    // GROUPED volume: all the selected tracks go up/down together
    gpGroupTargets(d).forEach((t) => {
      engine.decks[t].setVolume(engine.decks[t].volume + dir * 0.7 * dt);
      stripUI[t].fader.update();
    });
  },
  // L2/R2: press the pads according to the PLAYER'S MODE (each gamepad
  // keeps its config: P1 can be in JUMP while P2 is in LOOP on
  // the same deck). The row picks the pair, L2 = left, R2 = right.
  sideAction: (st, side) => {
    const cur = st.cur;
    if (cur.r === 0 && cur.c !== GP_FX_COL) {
      // MASTER row: L2 / R2 = master BPM − / + (±0.5 — all the
      // tracks in SYNC follow). The cockpit is complete here:
      // stick = FILTER MASTER, L1/R1 = VOL MASTER, L2/R2 = BPM.
      masterBpmNudge(side);
      return;
    }
    // L2/R2 only switch to "FX length" if THIS player has tracks
    // in the selection — as soon as they deselect (or if the selection
    // belongs to another player), they IMMEDIATELY become their pads again
    // JUMP/LOOP/CUE/KEY: simple interactions
    const mine = gpSelFor(st.player - 1);
    // In LOOP mode on the pad rows, L2/R2 remain the loop PADS
    // (IN/OUT/sizes/✕) EVEN with a selection: the loop takes priority over the
    // "FX length" shortcut — otherwise OUT became unreachable and you
    // ended up hitting the FX length (capped at 16) without knowing it
    const loopPads = st.mode === 'loop' &&
      cur.r >= 1 && cur.r <= GP_KNOBS.length && cur.c !== GP_FX_COL;
    const selNow = mine.length > 0 && !loopPads;
    if (side > 0) st.r2WasSel = selNow; else st.l2WasSel = selNow;
    if (selNow) {
      // THE PLAYER's unit: THEIR length, applied to ALL the tracks they
      // selected (a single unit, routed to each of their decks)
      const u = Math.min(st.player - 1, 3);
      if (!gpFxBeatsX2(u, side)) {
        flashStatus(t('fx_at_limit', { n: st.player, limit: side > 0 ? t('fx_limit_max') : t('fx_limit_min') }));
        return;
      }
      const s = uiRefs.fxUnits[u].beatsSel;
      const val = s.options[s.selectedIndex].textContent.trim();
      flashStatus(t('fx_duration_deck', { n: st.player, val, decks: mine.sort((a, b) => a - b).map((d) => d + 1).join(' + ') }));
      return;
    }
    if (cur.r === 0 && cur.c === GP_FX_COL) {
      // COLOR: L2/R2 = previous / next filter effect
      const sel = uiRefs.master.colorSel;
      const n = sel.options.length;
      sel.selectedIndex = (sel.selectedIndex + side + n) % n;
      sel.dispatchEvent(new Event('change'));
      flashStatus(`COLOR — ${sel.options[sel.selectedIndex].textContent}`);
      return;
    }
    if (cur.r < 1 || cur.r > GP_KNOBS.length) return;
    if (cur.c === GP_FX_COL) {
      // Each FX cell is "solo": L2 and R2 both trigger it
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
    gpBurstAction(st, side); // neon flash at the point of impact (BEFORE the jump)
    const padIdx = padForSide(cur.r, side);
    if (st.mode === 'fx') {
      // PAD FX on the gamepad: the effect HOLDS as long as the trigger is
      // pressed — cut by sideRelease on release (no burst)
      padFxPress(d, padIdx, true);
      if (side > 0) st._fxPadR = { d, idx: padIdx };
      else st._fxPadL = { d, idx: padIdx };
      return;
    }
    padPress(d, padIdx, st.mode, st.player - 1);
  },
  // L2/R2 release: cuts the PAD FX this trigger was holding
  sideRelease: (st, side) => {
    const held = side > 0 ? st._fxPadR : st._fxPadL;
    if (!held) return;
    if (side > 0) st._fxPadR = null; else st._fxPadL = null;
    padFxPress(held.d, held.idx, false);
  },
  // L2/R2 HELD for 1 second on a set cue: clears it
  sideHold: (st, side) => {
    // decision FROZEN at press time: if the press was consumed by the
    // selection branch (FX length), holding NEVER clears a cue
    if (side > 0 ? st.r2WasSel : st.l2WasSel) return;
    if (st.mode !== 'hotcue' || st.cur.r < 1 || st.cur.r > GP_KNOBS.length) return;
    const d = Math.min(st.cur.c, deckCount - 1);
    const idx = padForSide(st.cur.r, side);
    if (engine.decks[d].hotCues[idx] == null) return;
    padClear(d, idx, 'hotcue');
    padFlash(d, idx, PLAYER_COLORS[st.player - 1]);
    flashStatus(t('hotcue_cleared', { n: st.player, letter: String.fromCharCode(65 + idx), d: d + 1 }));
  },
  // Share/View (short press): change THE PLAYER's mode (CUE→JUMP→LOOP→KEY)
  cycleMode: (st) => {
    st.mode = GP_MODES[(GP_MODES.indexOf(st.mode) + 1) % GP_MODES.length];
    flashStatus(t('gp_mode_changed', { n: st.player, mode: GP_MODE_NAMES[st.mode] }));
  },
  // --- NAVIGATION mode (below the FILTER row) — selection PER PLAYER:
  // each gamepad has its own highlight in the explorer, you see who
  // is where and who selects what ---
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
      // 👤 SoundCloud account row (b2b): Circle/B enters ITS playlists
      openScAccount(t.acctIdx);
      st.navSel = 0;
    } else if (t.scRootRow) {
      // Historical bug fixed: these navigation rows fell through to
      // deck loading and failed silently (neither path nor scId)
      openSoundCloud();
      st.navSel = 0;
    } else if (t.scLikes) {
      openScLikes(t.acctIdx);
      st.navSel = 0;
    } else {
      gpLoadedTrack[st.player - 1] = t; // PERMANENT marker "P.. loaded this"
      const deck = engine.decks[d];
      const same = deck.track && (deck.track === t ||
        (deck.track.path && t.path && deck.track.path === t.path));
      if (same) {
        playDeck(d); // already loaded on its deck: Cross plays / pauses
      } else {
        loadTrackToDeck(d, t, true); // loads AND STARTS the track
      }
      // We GIVE BACK the global selection: each player keeps THEIR color
      // bar on THEIR row — whoever loads no longer erases the other's
      // display ("you have to leave who displayed what")
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
  // Left stick ◀▶ (held 0.5 s): NUDGE the track forward/backward,
  // like the top of a CDJ platter — this deck's red lines slide
  // relative to the other one to adjust the alignment by ear. On release,
  // the tempo goes back exactly and the AUTOMATIC ALIGNMENT re-anchors on
  // the chosen alignment (it no longer undoes the manual correction).
  jogNudge: (cur, v, dt) => {
    if (cur.r < 1 || cur.c === GP_FX_COL) return;
    const d = Math.min(cur.c, deckCount - 1);
    const deck = engine.decks[d];
    if (!deck.buffer) return;
    engine.resume();
    if (deck.looping && deck.bpm) {
      // ACTIVE LOOP = the left stick adjusts the loop, ALWAYS and
      // IMMEDIATELY (▶ +1 segment · ◀ fine reduction) — no more mode to
      // enable that got lost. Leaving the loop gives the jog back to the stick.
      gpLoopEditAdjust(d, v, dt);
      return;
    }
    if (!deck.playing) {
      // when stopped: move finely through the track
      deck.seek(Math.max(-3600, deck.currentTime() + v * 0.25 * dt));
      return;
    }
    if (!gpBend[d]) {
      // During the gesture: sync lock suspended EVERYWHERE (no deck
      // chases the one being nudged) and all the others stay at their
      // base tempo — the relative shift is smooth and exact
      gpBend[d] = { tempo: gpBaseTempo(deck), synced: deck.synced };
      engine.jogHold = true;
    }
    deck.synced = false;
    // Progressive curve up to ±6 %: smooth and precise near the center,
    // at full tilt the track slides by ~60 ms per second of holding — the
    // track moves twice as fast as before without losing finesse
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
    // ALL the synced decks adopt the new alignment: the automatic
    // alignment keeps exactly what the DJ just set
    for (let d = 0; d < 4; d++) engine.reanchorSync(d);
  },
  // Right stick ▲▼: zoom the waveforms in / out
  zoomWaves: (v, dt) => {
    waveZoom(Math.pow(0.45, v * dt));
  },
  // L3 (left stick click): the general FILTER ON/OFF (COLOR ON/OFF)
  colorToggle: () => document.getElementById('color-on').click(),
  // R3 (right stick click): the track's FX ON/OFF (master row = all)
  fxToggle: (st) => {
    const cur = st.cur;
    if (cur.r === 0) {
      if (cur.c === GP_FX_COL) {
        document.getElementById('color-on').click(); // COLOR ON/OFF
      } else {
        // ⚡ ENGAGE: the selected tracks join MY FX, which turns on
        gpFxEngage(st);
      }
      return;
    }
    if (cur.c === GP_FX_COL) {
      uiRefs.fxUnits[gpFxShown].onBtn.click();
      return;
    }
    // Pressing the FX stick on a deck = SELECT it as well:
    // the selection arms the FX + the filter at once (press again = remove)
    gpSelectToggle(Math.min(cur.c, deckCount - 1), st.player - 1);
  },
  // Right stick ▲▼: FX LEVEL — raises/lowers the FX of ALL the
  // SELECTED tracks at once (master row = all 4 unconditionally)
  fxLevel: (st, v, dt) => {
    engine.resume();
    const cur = st.cur;
    const one = (u) => {
      engine.fx[u].setLevel(engine.fx[u].level + v * 1.1 * dt);
      uiRefs.fxUnits[u].levelKnob.update();
    };
    // the % is shown LIVE while the stick goes up/down —
    // throttled so it doesn't hog the status bar at 60 Hz
    const pct = (u) => `${Math.round(engine.fx[u].level * 100)}%`;
    const flash = (msg) => {
      const t = performance.now();
      if (t - gpFxFlashAt < 150) return;
      gpFxFlashAt = t;
      flashStatus(msg);
    };
    const mine = gpSelFor(st.player - 1);
    if (mine.length) {
      // SELECTION: the level of THE PLAYER's UNIT moves (their tracks),
      // wherever you are on the matrix — without a selection of their own,
      // the stick keeps its normal behavior
      const u = Math.min(st.player - 1, 3);
      one(u);
      flash(t('gp_fx_level_player_decks', { n: st.player, pct: pct(u), decks: mine.map((t) => t + 1).join('+') }));
      return;
    }
    if (cur.r === 0) {
      for (let u = 0; u < 4; u++) one(u);
      flash(`FX MASTER — ${[0, 1, 2, 3].map(pct).join(' · ')}`);
      return;
    }
    if (cur.c === GP_FX_COL) {
      one(gpFxShown);
      flash(t('gp_fx_unit_level', { n: gpFxShown + 1, pct: pct(gpFxShown) }));
      return;
    }
    const u = Math.min(st.player - 1, 3);
    one(u);
    flash(t('gp_fx_level_player', { n: st.player, pct: pct(u) }));
  },
  // Short Square press: FX length among 1/2 · 3/4 · 1 · 2 (on the FX column:
  // the displayed unit, otherwise the player's PERSONAL unit)
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
      flashStatus(t('fx_duration_pos', { n: d + 1, val: wanted[(pos + 1) % wanted.length] }));
    }
  },
  // Square HELD: the effect list is shown on screen and the effect
  // scrolls little by little while the button is held
  fxTypeList: (st, op) => {
    const d = st.cur.c === GP_FX_COL ? gpFxUnitOf(st.cur) : Math.min(st.player - 1, 3);
    gpFxTypeList(d, op);
  },
  // Left stick ▲▼: as soon as a SELECTION exists, it drives the FILTERS of
  // ALL the selected tracks, WHEREVER you are. Without a selection:
  // the hovered knob (grouped if the column is selected).
  stickAdjust: (st, v, dt) => {
    engine.resume();
    const cur = st.cur;
    const mine = gpSelFor(st.player - 1);
    if (mine.length) {
      // RULE: LEFT stick = FILTER, the FX is the RIGHT stick. If
      // COLOR had switched to an echo (COLOR cell + L2/R2), bring it
      // back to Filter — otherwise this stick "adds FX" instead of filtering
      const csel = uiRefs.master.colorSel;
      if (csel && csel.value !== 'filter') {
        csel.value = 'filter';
        csel.dispatchEvent(new Event('change'));
        flashStatus(t('gp_color_back_to_filter'));
      }
      // each player drives the FILTERS of THEIR selected tracks —
      // without a selection of their own, the stick keeps the hovered knob
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
  // Circle/B: resets the hovered knob to its DEFAULT (neutral) value —
  // perfect for a filter effect followed by an instant return to zero
  resetKnob: (cur, d, gi) => {
    engine.resume();
    if (cur.r >= 1 && cur.r <= GP_KNOBS.length && cur.c !== GP_FX_COL) {
      // knob reset to neutral for the WHOLE selected group
      const dd = Math.min(cur.c, deckCount - 1);
      const k = GP_KNOBS[cur.r - 1];
      gpGroupTargets(dd).forEach((t) => {
        gpKillStore.delete(`${k.key}:${t}`);
        k.set(t, 0);
      });
    } else if (cur.r !== 0) {
      const cell = gpCellAt(cur);
      gpKillStore.delete(`${cell.key}:${cell.deck}`); // cancels a kill in progress
      cell.set(0);
    }
    // ◯ = FX **and** FILTER to 0 on the selected tracks (or the current
    // track) — the SELECTION and the arming REMAIN: an effect can be
    // restarted right away. R1 does the same reset + deselects everything.
    const targets = gpSelection.size
      ? [...gpSelection]
      : [Math.min(
          cur.c === GP_FX_COL ? (cur.r >= 1 ? gpFxShown : (d != null ? d : 0)) : cur.c,
          deckCount - 1)];
    targets.forEach((t) => {
      engine.setDeckColor(t, 0);
      stripUI[t].kFilt.update();
    });
    // zero on the player's PERSONAL unit + any unit PROCESSING one
    // of the targets (the units are per player)
    const units = new Set(gi != null ? [Math.min(gi, 3)] : []);
    targets.forEach((t) => {
      for (let u = 0; u < 4; u++) if (engine.fxAssign[u][t]) units.add(u);
    });
    units.forEach((u) => {
      engine.fx[u].setLevel(0);
      uiRefs.fxUnits[u].levelKnob.update();
    });
    flashStatus(gpSelection.size
      ? t('fx_reset_selection', { sel: [...targets].sort().map((x) => x + 1).join('+') })
      : t('fx_reset_deck', { n: targets[0] + 1 }));
  },
  // R1 only triggers the reset if THIS player has selected tracks
  hasSelection: (gi) => gpSelFor(gi).length > 0,
  selReset: (d, cur) => gpSelReset(d, cur)
});

// ---------------------------------------------------------------------------
// Gamepad help
// ---------------------------------------------------------------------------

function renderHelp() {
  const b = (i) => gamepad.connected ? gamepad.buttonLabel(i) : ({
    0: t('help_btn_cross'), 1: t('help_btn_circle'), 2: t('help_btn_square'), 3: t('help_btn_triangle'),
    4: t('help_btn_l1'), 5: t('help_btn_r1'), 6: t('help_btn_l2'), 7: t('help_btn_r2'),
    8: t('help_btn_share'), 9: t('help_btn_options'), 10: t('help_btn_l3'), 11: t('help_btn_r3'),
    16: t('help_btn_ps_xbox')
  })[i];
  const rows = [
    [t('help_cross_dpad_label'), t('help_row1_desc')],
    [b(16), t('help_row2_desc')],
    [`${b(6)} / ${b(7)}`, t('help_row3_desc')],
    [`${b(8)}${t('help_btn_short_suffix')}`, t('help_row4_desc')],
    [b(2), t('help_row5_desc')],
    [t('help_stick_right_label'), t('help_row6_desc')],
    [b(11), t('help_row7_desc')],
    [b(10), t('help_row8_desc')],
    [`${b(4)} / ${b(5)}`, t('help_row9_desc')],
    [t('help_stick_left_label'), t('help_row10_desc')],
    [b(9), t('help_row11_desc')],
    [b(0), t('help_row12_desc')],
    [`${b(1)}${t('help_btn_short_suffix')}`, t('help_row13_desc')],
    [b(3), t('help_row14_desc')],
    [t('help_navigation_label'), t('help_row15_desc')]
  ];
  document.getElementById('help-table').innerHTML =
    rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
}

function toggleHelp() {
  document.getElementById('help-overlay').classList.toggle('hidden');
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
const wavesEl = document.getElementById('waves');
const wavePlayhead = document.getElementById('wave-playhead');

// --- LIGHT FEEDBACK to the controller: per-channel VU meters, play/cue/
// sync LEDs, loop, BLINKING FX, channel select — "the magic of the controller"
// is the software driving it. Only emits CHANGES (midi cache).
const MIDI_SEL_NOTES = [29, 31, 28, 20]; // channel select: decks 1-4 (channel 5)
function midiFeedback(now) {
  if (!midi.output) return;
  // ONLY VU meters + channel select: the BUTTON LEDs are driven
  // by ledTick (note tables VALIDATED live). Before the merge, the
  // two systems fought over the same LEDs — values alternating on
  // every frame = flicker + a storm of re-declarations from the controller
  for (let i = 0; i < 4; i++) {
    midi.setVu(i, Math.min(1, stripUI[i].meterVal || 0));
  }
  // Channel select: the ACTIVE deck's position stays lit
  MIDI_SEL_NOTES.forEach((n, i) => midi.setLed(5, n, i === activeDeck));
}

function frame(now) {
  // An exception here killed requestAnimationFrame → app completely
  // frozen (that was the "crash" when switching 4 → 2 decks during playback).
  // The render loop must NEVER die.
  try {
    frameBody(now);
  } catch (e) {
    console.error('frame:', e);
  }
  requestAnimationFrame(frame);
}

// Keys: each deck's label follows the tempo (keylock off) and
// the master; the list's KEY column is recolored when the master changes
// key. 4 times per second is enough — and nothing is written if nothing
// changes (signatures).
let keyTickAt = 0;
let keyListSig = '';
function keyTick(now) {
  if (now - keyTickAt < 250) return;
  keyTickAt = now;
  for (let i = 0; i < 4; i++) updateKeyUI(i);
  const ref = masterHeardKey();
  const sig = ref ? String(ref.code) : '-';
  if (sig !== keyListSig) {
    keyListSig = sig;
    rowByTrack.forEach((row, t) => fillKeyCell(row.children[5], t));
  }
}

function frameBody(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  gamepad.poll(dt, now);
  updateGpCursors(); // player cursors on the control grid
  engine.syncLock(); // keeps the synced decks locked to the master
  keyTick(now);      // heard keys (tempo, master) — 4×/s

  for (let i = 0; i < 4; i++) {
    const deck = engine.decks[i];
    const ui = deckUI[i];
    // During a V.BRAKE / BACKSPIN, the track virtually "keeps going"
    // underneath: the DISPLAY follows that real progress, not the audible
    // rewind — you see where you are and where playback will resume, so you
    // can DOSE the effect down to the beat (David)
    const sfx = ui._spinFx;
    const t = (sfx && sfx.wasPlaying)
      ? Math.min(deck.duration || 0, sfx.pos0 + ((now - sfx.start) / 1000) * (deck.tempo || 1))
      : deck.currentTime();

    // Optimization: only redraw if something moved
    const cueSig = (deck.hotCues ? deck.hotCues.map(c => (c == null ? '' : Math.round(c * 20))).join(',') : '')
      + '|' + Math.round((deck.cuePoint || 0) * 50);
    // The visible window is in REAL TIME: convert it to file time
    // according to the deck's tempo. That way, two decks at the same effective BPM show
    // bars of the same width, whatever their playback speed.
    // DURING A JOG: freeze the display on the BASE tempo — otherwise the
    // bend made the track's waveform "breathe" (grow/shrink).
    const dispTempo = gpBend[i] ? gpBend[i].tempo : (deck.tempo || 1);
    const deckWindow = waveWindowSec * dispTempo;
    const zoomSig = `${t.toFixed(3)}|${deckWindow.toFixed(3)}|${deck.looping ? deck.loopStart + '-' + deck.loopEnd : ''}|${deck._loopInPoint ?? ''}|${deck.peaks ? deck.peaks.duration : 0}|${deck.beatOffset}|${deck.bpm}|${deck.gridShift}|${deck.barAnchor}|${deck.beats ? deck.beats.length : 0}|${getGlobalGridOffset()}|${cueSig}`;
    // FULL 60 FRAMES/SECOND: the cap at 30 no longer makes sense since
    // the waveform became a pre-rendered strip (a simple GPU copy per
    // frame). It showed while scrolling — "not pro smoothness".
    if (ui._zoomSig !== zoomSig) {
      ui._zoomSig = zoomSig;
      // FIXED WINDOW, deliberately: the scale × tempo (tried, then
      // REMOVED) made the whole trace MOVE on every internal speed
      // update — "you made it move, even worse". The visual alignment
      // of the beats is guaranteed by the alignment's zero magnet +
      // the servo, NOT by the scale. Do not try it again.
      // t = displayed position (virtual during a V.BRAKE/BACKSPIN)
      drawZoom(ui.wave.canvas, deck, deckWindow, t);
    }
    const overSig = deck.peaks
      // ui.over.width (canvas attribute) and NOT clientWidth: reading a
      // CSS dimension forces the browser to recompute the layout in the
      // middle of the render loop — the attribute costs nothing
      ? `${Math.round((t / deck.peaks.duration) * ui.over.width)}|${deck.looping ? deck.loopStart : ''}|${deck.peaks.duration}|${cueSig}`
      : 'empty';
    if (ui._overSig !== overSig) {
      ui._overSig = overSig;
      drawOverview(ui.over, deck);
    }

    const playTxt = deck.playing ? '❚❚' : '▶';
    if (ui.play.textContent !== playTxt) ui.play.textContent = playTxt;
    ui.play.classList.toggle('on', deck.playing);
    ui.sync.classList.toggle('on', deck.synced);
    // MASTER badge: the manual choice wins, otherwise the AUTOMATIC master
    // (first track started, kept as long as it plays, then active basses)
    const isMaster = engine.masterIdx === i ||
      (engine.masterIdx === null && engine.autoMasterIdx === i);
    ui.master.classList.toggle('hidden', !isMaster);
    ui.masterBtn.classList.toggle('on', isMaster);

    // Pad state — SPLIT PER PLAYER: on a split pad, ONLY the
    // part of the player who set the cue / holds the loop lights up, and
    // each segment is evaluated according to ITS player's mode.
    // (set with the mouse = discreet border in the deck's color)
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
    let gpModesSig = '';
    for (const [g, s2] of gamepad.pads) {
      gpModes.set(String(g), s2.mode);
      gpModesSig += `${g}:${s2.mode},`;
    }
    // PADS BLOCK SIGNATURE: it was the only part of the loop without a
    // guard — 40 DOM queries + ~120 class writes per
    // frame, for a state that only changes on user action.
    const padSig = `${ui.padMode}|${ui._mergedMode || ''}|${ui._padViewSig}|${ui.jumpScale}`
      + `|${deck.keyShift}|${deck.looping ? deck._loopBeats : ''}|${ui.loopOwner}`
      + `|${ui.cueOwner ? ui.cueOwner.map((o) => (o ? o.join('.') : '-')).join(',') : ''}`
      + `|${cueSig}|${gpModesSig}|${ui._padFxHeld}|${ui._spinFx ? 1 : 0}`;
    if (ui._padSig !== padSig) {
      ui._padSig = padSig;
      ui.pads.forEach((p, idx) => {
      const segs = p.querySelectorAll('.pad-seg, .pad-band');
      if (segs.length) {
        // Split pad (segments or bands): only the owner's PART
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
      // Full view (deck tab or merged view): the whole pad
      // fills up — color(s) of the owner(s), otherwise the deck's.
      p.classList.remove('set-any');
      const mode = p.querySelector('.pad-single') && ui._mergedMode ? ui._mergedMode : ui.padMode;
      const stt = stateFor(mode, idx);
      const own = stt.active && stt.owners.length ? gpOwnersBg(stt.owners, null) : null;
      if (own) p.style.setProperty('--own-color', own);
      else p.style.removeProperty('--own-color');
      p.classList.remove('set', 'on');
      if (stt.active) p.classList.add(mode === 'hotcue' ? 'set' : 'on');
      // A PLAYER's cue = filled with their color · mouse/old cue = discreet marker
      p.classList.toggle('set-owned', !!own);
      });
    }

    drawDeckWheel(ui, deck, t); // the platter spins during playback
    if (deck.buffer) {
      const tTxt = t < 0 ? `−${formatTime(-t)}` : formatTime(t);
      const timeTxt = `${tTxt} · -${formatTime(deck.duration - t)}`;
      // Only rewrite the text WHEN the second changes (one DOM write
      // per frame = needless layout invalidation)
      if (ui._timeTxt !== timeTxt) {
        ui._timeTxt = timeTxt;
        ui.time.textContent = timeTxt;
      }
      // 1·2·3·4 beat counter: the current beat's dot lights up —
      // the pro detail that shows where you are in the bar at a glance
      const bp = deck.playing ? engine._barPhase(deck) : null;
      const bi = bp != null ? Math.floor(bp * 4) % 4 : -1;
      if (ui._beatIdx !== bi) {
        ui._beatIdx = bi;
        ui.beatDots.forEach((dot, k) => dot.classList.toggle('on', k === bi));
      }
      let ebpm = deck.effectiveBpm;
      // Locked SYNCED deck: we DISPLAY the master's BPM — the lock
      // guarantees the same real speed; the old display showed the
      // track's small detection error (143.6 against 144.0) even though
      // the beats are locked — "it has to be the SAME BPM": there it is
      if (deck.synced && deck.playing && deck._syncBase) {
        const mstr = engine.getMasterDeck(i);
        if (mstr && mstr.bpm && mstr.playing) ebpm = mstr.bpm * mstr.tempo;
      }
      const bpmText = ebpm ? ebpm.toFixed(1) : '--.-';
      // tempo % = the matching GAUGE POSITION (always visible:
      // on a synced deck that's where the physical fader must be brought
      // to take back control without a jump)
      const pctT = ((deck.tempo || 1) - 1) * 100;
      const pctText = deck.bpm ? `${pctT >= 0 ? '+' : ''}${pctT.toFixed(1)}%` : '';
      if (ui._bpmText !== bpmText + pctText) {
        ui._bpmText = bpmText + pctText;
        if (ui.bpm) ui.bpm.innerHTML = `${bpmText}<small> BPM</small>`;
        ui.wave.bpm.textContent = bpmText;
        if (pctText && ui.tempoVal) ui.tempoVal.textContent = pctText;
      }
    }

    // Markers: where the other decks' BPMs sit on MY tempo scale
    for (let j = 0; j < 4; j++) {
      const mark = ui.tempoMarks[j];
      if (!mark) continue;
      const other = engine.decks[j].effectiveBpm;
      if (!deck.bpm || !other) {
        if (mark.style.display !== 'none') mark.style.display = 'none';
        continue;
      }
      const rg = deck.tempoRange || 0.16;
      const pos = ((other / deck.bpm - 1) / rg + 1) / 2; // gauge range
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

  // Each FX unit follows the BPM of the first deck assigned to it
  // (otherwise the master's)
  // REAL duration of one beat of a deck, at the speed it is playing (tempo
  // included, sync micro-corrections removed: otherwise the echo delays
  // kept "breathing") and based on the LOCAL grid
  const beatOf = (dk) => {
    if (!dk || !dk.bpm) return null;
    const per = engine._localPeriod(dk) || 60 / dk.bpm;
    return per / ((dk.tempo || 1) / (1 + (dk._pllCorr || 0)));
  };
  const masterD = engine.getMasterDeck(-1);
  const masterBeat = beatOf(masterD) || 0.5;
  engine.fx.forEach((u, uIdx) => {
    if (!u.enabled) return;
    const ref = engine.fxRefDeck(uIdx);
    u.setBeatDur(beatOf(ref) || masterBeat);
  });
  // PAD FX units follow THEIR deck's tempo (otherwise the master's)
  engine.padFx.forEach((u, d) => {
    if (!u || !u.enabled) return;
    u.setBeatDur(beatOf(engine.decks[d]) || masterBeat);
  });
  // The FX MASTER locks to the master deck's BPM + its banner is kept up to date
  if (engine.masterFx && engine.masterFx.enabled) engine.masterFx.setBeatDur(masterBeat);
  updateMasterFxRow();

  // VU meters: peak level per channel + red LED on clipping.
  // Animated via TRANSFORM: changing height/width every frame invalidated the
  // layout → reflow 60×/s → choppy waveforms ("not uniform")
  for (let i = 0; i < 4; i++) {
    const s = stripUI[i];
    const deck = engine.decks[i];
    const peak = deck.buffer ? deck.meterPeak() : 0;
    s.meterVal = Math.max(peak, s.meterVal * 0.9);
    s.meterFill.style.transform = `scaleY(${Math.min(1, s.meterVal).toFixed(3)})`;
    if (peak >= 0.99) s.clipUntil = now + 700;
    s.meterClip.classList.toggle('on', now < s.clipUntil);
  }

  // MASTER VU meter (the assembled mix)
  if (masterMeterFill) {
    const mPeak = engine.masterPeak();
    masterMeterVal = Math.max(mPeak, masterMeterVal * 0.9);
    masterMeterFill.style.transform = `scaleX(${Math.min(1, masterMeterVal).toFixed(3)})`;
    if (mPeak >= 1) masterClipUntil = now + 700;
    masterMeterClip.classList.toggle('on', now < masterClipUntil);
  }

  midiFeedback(now); // controller LEDs and VU meters (only emits changes)

  // Global playhead line: getBoundingClientRect FORCES a synchronous
  // layout — we now only measure it at ~2 Hz (and on resize);
  // its position only moves with the window anyway
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

// --- Zoom of the stacked view: mouse wheel, buttons, + / - keys ---
// From 0.5 s (very zoomed in, exact shape of the sound) to 60 s visible.
function waveZoom(factor) {
  waveWindowSec = Math.min(60, Math.max(0.5, waveWindowSec * factor));
}
wavesEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  waveZoom(e.deltaY > 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

// Blocks page zoom (Ctrl+wheel / pinch), which distorted the interface
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
document.getElementById('wz-in').addEventListener('click', () => waveZoom(1 / 1.35));
document.getElementById('wz-out').addEventListener('click', () => waveZoom(1.35));

// --- MIDI controller (DDJ and any USB-MIDI controller) ---
const midiCueHold = [false, false, false, false];

function midiCue(i, on) {
  const deck = engine.decks[i];
  if (!deck.buffer) {
    // empty deck: SAY so (the old silence looked like a dead button)
    if (on) flashStatus(t('cue_no_track', { n: i + 1 }));
    return;
  }
  if (on) {
    if (deck.playing) {
      deck.cue();
      flashStatus(t('cue_return', { n: i + 1 }));
      return;
    }
    const atCue = Math.abs(deck.currentTime() - deck.cuePoint) < 0.02;
    if (!atCue) {
      deck.cue();
      flashStatus(t('cue_point_set', { n: i + 1 }));
      return;
    }
    midiCueHold[i] = true;
    deck.play();
    flashStatus(t('cue_preview', { n: i + 1 }));
  } else if (midiCueHold[i]) {
    midiCueHold[i] = false;
    deck.pause();
    deck.seek(deck.cuePoint);
  }
}

const midiJogTimer = [null, null, null, null]; // MIDI nudge release (side of the platter)
const midiScratchTimer = [null, null, null, null]; // scratch release (top of the platter)
const midiJogTouchTime = [0, 0, 0, 0]; // hand placed: burst to ignore
let midiShiftHeld = false; // SHIFT button (left or right) held down
const midiJogState = [null, null, null, null];  // scratch gesture in progress
const midiJogTouchHeld = [false, false, false, false]; // hand resting on the platter
const midiJogArmTimer = [null, null, null, null]; // deferred touch arming
let midiJogTouchAt = 0; // time of the last touch (anti-noise filter)
let midiXfLastAt = 0;   // crossfader continuity (anti-burst filter)
// TARGET of the controller FX: the position of the FLX6's CHANNEL SELECT decides which
// deck the FX button / level knob / BEAT ◄► control ("I'm on 2,
// so it's 2's FX that should turn on"). 'master' = the master deck.
let midiFxTarget = null; // null = follow the active deck · 'master' = FX on the MIX
function midiFxUnit() {
  return Math.min(midiFxTarget != null ? midiFxTarget : activeDeck, 3);
}
// --- "Controller" FX: ONE SINGLE effect at a time, which FOLLOWS the selector ---
// (David's request: going from 1 to 2 moves the effect, no need to turn off
// 1 by hand; and the level ALWAYS comes from the gauge, never from a default)
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
// Turns the effect on at the selector's target, TRANSFERRING the settings and
// level of the previous effect (src) if there was one
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
  // Route AT LEAST to its own deck (an old empty assignment
  // made the FX silent — "the fx only works on the master")
  engine.fxAssign[u][u] = true;
  f.setEnabled(true);
  const b = uiRefs.fxUnits[u].onBtn;
  b.textContent = 'ON';
  b.classList.add('on');
  engine.updateFxSends();
  return `deck ${u + 1}`;
}

// FX MASTER length scale (same scale as the panel: 1/4 → 32)
const MASTER_FX_BEATS = [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32];
function masterFxBeatsStep(dir) {
  const u = engine.ensureMasterFx();
  const idx = MASTER_FX_BEATS.findIndex((v) => Math.abs(v - u.beatsMult) < 0.01);
  const next = Math.max(0, Math.min(MASTER_FX_BEATS.length - 1, (idx < 0 ? 1 : idx) + dir));
  if (idx === next) return false;
  u.setBeatsMult(MASTER_FX_BEATS[next]);
  const b = MASTER_FX_BEATS[next];
  flashStatus(t('fx_master_duration', { val: b >= 1 ? b : `1/${Math.round(1 / b)}` }));
  return true;
}
// Canonical list of effects (the one in the dropdown menus): used for
// SHIFT+BEAT ◄/► navigation — browsing the effects from the controller
const FX_TYPES_LIST = [...FX_TYPE_OPTIONS.matchAll(/value="([^"]+)"[^>]*>([^<]+)/g)]
  .map((m2) => [m2[1], m2[2].trim()]);
function fxCycleType(dir) {
  const step = (u) => {
    const idx = Math.max(0, FX_TYPES_LIST.findIndex(([v]) => v === u.type));
    const nt = FX_TYPES_LIST[(idx + dir + FX_TYPES_LIST.length) % FX_TYPES_LIST.length];
    u.setType(nt[0]);
    return nt;
  };
  if (midiFxTarget === 'master') {
    const nt = step(engine.ensureMasterFx());
    updateMasterFxRow();
    flashStatus(t('fx_master_effect_status', { name: nt[1] }));
  } else {
    const uI = midiFxUnit();
    const nt = step(engine.fx[uI]);
    if (uiRefs.fxUnits[uI] && uiRefs.fxUnits[uI].typeSel) uiRefs.fxUnits[uI].typeSel.value = nt[0];
    flashStatus(t('fx_unit_effect_status', { n: uI + 1, name: nt[1] }));
  }
}

const tempoHintAt = [0, 0, 0, 0]; // rate limiter for the tempo pickup indicator
// Note of the CURRENT position of each section's FX selector (left,
// right) — learned on the last FX button press: it is the address of its lamp
const midiFxSlotNote = [71, 71];
// FX section used last (0 = left / channel 0x94, 1 = right / 0x95):
// ONLY its lamp is driven — the controller only "arms" the LAST address
// received; sending both sections every time never lit the right one
let midiFxSide = 0;
// Controller FX button: ONE SINGLE effect at a time, on the channel select
// target. Press again = off. The LEVEL comes from the gauge, never from a default.
function midiFxToggle() {
  const targetOn = midiFxTarget === 'master'
    ? !!(engine.masterFx && engine.masterFx.enabled)
    : engine.fx[midiFxUnit()].enabled;
  if (targetOn) {
    platineFxOff();
    flashStatus(t('fx_off_platter'));
  } else {
    const cur = platineFxCurrent();
    const src = cur ? { type: cur.fx.type, beatsMult: cur.fx.beatsMult, level: cur.fx.level } : null;
    platineFxOff();
    const where = platineFxOnTarget(src);
    const lvl = midiFxTarget === 'master' ? engine.masterFx.level : engine.fx[midiFxUnit()].level;
    flashStatus(t('fx_on_status', { where, hint: lvl === 0 ? t('fx_on_raise_hint') : '' }));
  }
}
// Jog scale: seconds of audio per tick (DDJ-FLX6: 7200 ticks/turn,
// 1 turn at 33⅓ rpm = 1.8 s — the feel of a real vinyl)
const JOG_SEC_PER_TICK = 1.8 / 7200;

// Hand lifted off the platter: the track resumes exactly where the platter left it, and
// this placement is ADOPTED by the sync (phase frozen on the chosen alignment)
function jogRelease(i) {
  const d = engine.decks[i];
  const s2 = midiJogState[i];
  midiJogState[i] = null;
  if (!s2) return;
  if (s2.raf) cancelAnimationFrame(s2.raf);
  d.scrubEnd();
  d.seek(Math.max(-3600, s2.target ?? s2.pos));
  if (s2.wasPlaying) d.play();
  engine.jogHold = false;
  for (let k = 0; k < 4; k++) engine.reanchorSync(k);
  // INERTIA: the FLX6 wheel spins FREELY — released while moving, it
  // keeps turning and the controller sends EDGE (side) ticks. They used
  // to be taken for a nudge (the sound "moved forward" on its own after
  // release, or jumped far while paused). As long as that stream continues
  // without a pause, it is ignored: the platter stops DEAD where the hand let go.
  const now = performance.now();
  midiCoast[i] = { last: s2.lastBendAt && now - s2.lastBendAt < 200 ? s2.lastBendAt : now, until: now + 2500, n: 0, sum: 0 };
  const g = s2.diag;
  if (g) {
    console.log(`[midi] jog deck ${i + 1}: hold ${g.implicit ? 'WITHOUT touch note' : 'with touch'} — ${Object.entries(g.cc).map(([k, v]) => `CC${k} ×${v.n} Σ${v.sum > 0 ? '+' : ''}${v.sum}`).join(', ')}`);
  }
}
// Per-deck inertia guard (see jogRelease)
const midiCoast = [null, null, null, null];
// Log of a platter gesture (one line on release, to diagnose a
// controller without cluttering the console)
function jogDiag(st, cc, delta) {
  if (!st.diag) st.diag = { cc: {}, implicit: !!st.implicit };
  const e = st.diag.cc[cc] || (st.diag.cc[cc] = { n: 0, sum: 0 });
  e.n++;
  e.sum += delta;
}

const midi = new MidiManager({
  press(action, deck, on) {
    const i = deck == null ? activeDeck : deck;
    const d = engine.decks[i];
    if (!d) return;
    engine.resume();
    switch (action) {
      // Same path as the on-screen ▶ button: a SYNC deck that starts
      // re-aligns right away (tempo + red lines on the master's).
      // The controller used a plain togglePlay: the sound restarted with
      // the old ratio and an arbitrary offset — hence the repeated SYNCs
      case 'play': if (on) { d.scrubEnd(); playDeck(i); } break;
      case 'jogTouch':
        // REAL platter touch (sensor note 54): TOUCH = the sound cuts
        // and the platter becomes the playhead — RELEASE = resumes exactly
        // where the hand left the sound, placement adopted (phase frozen)
        if (!d.buffer) {
          // Touch on an EMPTY deck: SAY so instead of a mysterious silence
          // (hardware DECK button switched to a deck with no track loaded)
          if (on) flashStatus(t('jog_no_track', { n: i + 1 }));
          break;
        }
        midiJogTouchAt = performance.now();
        if (on) {
          midiJogTouchHeld[i] = true;
          midiJogTouchTime[i] = performance.now();
          clearTimeout(midiScratchTimer[i]);
          clearTimeout(midiJogArmTimer[i]); // cancels a pending resume (debounce)
          // INSTANT CUT on touch (David's original requirement) —
          // the debounce is on the RELEASE side: a sensor that "bounces"
          // while touching no longer restarts playback in jerks
          if (midiJogState[i]) {
            // hold already armed by rotation: the sensor now decides
            // the release (no more automatic resume when idle)
            midiJogState[i].implicit = false;
          } else {
            midiJogState[i] = { wasPlaying: d.playing, pos: d.currentTime() };
            midiJogState[i].target = midiJogState[i].pos;
            if (d.playing) d.pause();
            if (scratchSound) d.scrubStart();
            engine.jogHold = true;
            flashStatus(t('jog_routed', { n: i + 1 }));
          }
        } else {
          midiJogTouchHeld[i] = false;
          clearTimeout(midiScratchTimer[i]);
          // RESUME DELAYED by 60 ms: if the sensor presses again right away
          // (bounce), the resume is cancelled — the scratch continues smoothly
          clearTimeout(midiJogArmTimer[i]);
          midiJogArmTimer[i] = setTimeout(() => {
            if (midiJogTouchHeld[i]) return; // pressed again in the meantime
            jogRelease(i);
          }, 60);
        }
        break;
      case 'select':
        // CHANNEL SELECT: the FLX6 sends one note per position — so the deck
        // comes straight from the controller, nothing to count in software
        if (on) {
          midiFxTarget = i; // the controller FX now targets THIS deck
          setActiveDeck(i);
          // An already active effect FOLLOWS the selector: it moves by itself
          // to the new target (settings and level kept)
          const cur = platineFxCurrent();
          if (cur && !(cur.kind === 'deck' && cur.u === i)) {
            const src = { type: cur.fx.type, beatsMult: cur.fx.beatsMult, level: cur.fx.level };
            platineFxOff();
            platineFxOnTarget(src);
            flashStatus(t('channel_select_active_fx', { n: i + 1 }));
          } else {
            flashStatus(t('channel_select_active', { n: i + 1 }));
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
            flashStatus(t('channel_select_master_fx_follows'));
          } else {
            flashStatus('CHANNEL SELECT — MASTER');
          }
        }
        break;
      case 'shift':
        // Global SHIFT state (either side): modifies browse/CUE/SYNC
        midiShiftHeld = on;
        break;
      case 'cueBack':
        // Hardware SHIFT+CUE (note 72): back to the very start, stopped
        if (on && d.buffer) {
          d.pause();
          d.seek(0);
          flashStatus(t('back_to_start', { n: i + 1 }));
        }
        break;
      case 'cue':
        if (midiShiftHeld) {
          // SHIFT+CUE = back to the START of the track, stopped (rekordbox)
          if (on && d.buffer) {
            d.pause();
            d.seek(0);
            flashStatus(t('back_to_start', { n: i + 1 }));
          }
          break;
        }
        midiCue(i, on);
        break;
      case 'sync':
        // TOGGLE (David's setting): press = sync, press again = unsync — the
        // tempo stays where it is, no SHIFT needed
        if (on) {
          if (d.synced) {
            d.synced = false;
            flashStatus(t('deck_sync_off_flash', { n: i + 1 }));
          } else {
            syncDeck(i);
          }
        }
        break;
      case 'master': if (on) engine.setMaster(i); break;
      case 'grid':
        // Same engine as the on-screen GRID button: ALSO handles dynamic
        // grids (the old code only wrote beatOffset = no-op on almost
        // every track) and SAVES the alignment
        if (on && deckUI[i]) deckUI[i].recalGrid();
        break;
      case 'load': if (on) loadSelectedToDeck(i); break;
      // Library encoder: PUSH = ENTER (folder, local or SoundCloud
      // playlist) — it NEVER loads a track, the LOAD buttons do that
      case 'browsePush':
        if (on) {
          const track = library.selectedTrack();
          if (!track) break;
          if (track.fsUpRow) folderUp();
          else if (track.scRootRow) openSoundCloud();
          else if (track.scAccountRow) openScAccount(track.acctIdx);
          else if (track.scLikes) openScLikes(track.acctIdx);
          else if (track.plRootRow) openPlaylistsRoot();
          else if (track.fsRow) enterFolder(track.path);
          else if (track.plRow) openLocalPlaylist(track.pl);
          else if (track.scPlaylist) openScPlaylist(track.permalink, track.acctIdx);
          else flashStatus(t('track_selected_use_load'));
        }
        break;
      // BACK: leave the open playlist, go up one folder —
      // and from SoundCloud/Playlists/History, go back to the ROOTS
      case 'browseBack':
        if (on) {
          const plBack = document.getElementById('btn-pl-back');
          const scBack = document.getElementById('btn-sc-back');
          if (plBack && !plBack.classList.contains('hidden')) plBack.click();
          else if (scBack && !scBack.classList.contains('hidden')) scBack.click();
          else if (library.mode !== 'local') {
            setLibTab('local');
            library.showRoots();
          } else if (!folderUp()) flashStatus(t('library_roots'));
        }
        break;
      // VIEW: hides / shows the browser — the decks then take ALL
      // the space (the library row disappears from the grid)
      case 'viewToggle':
        if (on) {
          const lib = document.getElementById('library');
          const appEl = document.getElementById('app');
          if (lib && appEl) {
            lib.classList.toggle('hidden');
            appEl.classList.toggle('lib-hidden', lib.classList.contains('hidden'));
            flashStatus(lib.classList.contains('hidden')
              ? t('view_fullscreen_decks') : t('view_library_shown'));
          }
        }
        break;
      // Pad MODE buttons (HOT CUE / BEAT JUMP / LOOP / KEY): the change
      // shows on screen — the deck's tabs light up
      case 'padHotcue': if (on) { deckUI[i].padMode = 'hotcue'; renderPads(i); setActiveDeck(i); } break;
      case 'padJump': if (on) { deckUI[i].padMode = 'jump'; renderPads(i); setActiveDeck(i); } break;
      case 'padLoop': if (on) { deckUI[i].padMode = 'loop'; renderPads(i); setActiveDeck(i); } break;
      case 'padKey': if (on) { deckUI[i].padMode = 'key'; renderPads(i); setActiveDeck(i); } break;
      case 'padFx': if (on) { deckUI[i].padMode = 'fx'; renderPads(i); setActiveDeck(i); } break;
      case 'padSmp': if (on) { deckUI[i].padMode = 'smp'; renderPads(i); setActiveDeck(i); } break;
      case 'loopIn': if (on) loopIn(i); break;
      case 'loopOut': if (on) loopOut(i); break;
      case 'reloop':
        // RELOOP/EXIT: exits the loop, or RESTARTS the last one set
        if (on) {
          if (d.looping) {
            d.exitLoop();
          } else if (d.loopEnd > d.loopStart && d.loopEnd > 0) {
            d.setLoop(d.loopStart, d.loopEnd);
          }
        }
        break;
      case 'loopHalf': if (on) loopHalve(i); break;
      case 'loopDouble': if (on) loopDouble(i); break;
      case 'cuePfl':
        // Channel headphone CUE: sends/removes this deck to/from the headphones
        if (on) {
          const now2 = !engine.decks[i].cueOn;
          engine.setCuePfl(i, now2);
          flashStatus(engine.phonesOk
            ? t('headphone_cue_status', { n: i + 1, state: now2 ? 'ON' : 'OFF' })
            : t('headphone_status', { n: i + 1, state: now2 ? 'ON' : 'OFF' }));
        }
        break;
      case 'fxSlot':
        // FX button (every selector position): remembers the address of
        // this position's LAMP, then toggles the effect
        if (on) {
          midiFxSide = deck >= 3 ? 1 : 0;
          midiFxSlotNote[midiFxSide] = 71 + (deck % 3);
          midiFxToggle();
        }
        break;
      case 'fxOn':
        // (generic action, kept for MIDI learn ⚙)
        if (on) midiFxToggle();
        break;
      case 'keyUp': if (on && deckUI[i].applyKey) deckUI[i].applyKey(1); break;
      case 'keyDn': if (on && deckUI[i].applyKey) deckUI[i].applyKey(-1); break;
      case 'bpmUp': if (on) masterBpmNudge(1); break;
      case 'bpmDn': if (on) masterBpmNudge(-1); break;
      // BEAT ◄ / ► of the FX section: effect duration of the deck chosen with
      // CHANNEL SELECT ÷2 / ×2 (MASTER position = mix FX)
      case 'fxPrev': if (on) fxCycleType(-1); break;
      case 'fxNext': if (on) fxCycleType(1); break;
      case 'fxBeatsDn':
        if (on) {
          // SHIFT + BEAT ◄ = PREVIOUS effect in the list (quick browsing)
          if (midiShiftHeld) { fxCycleType(-1); break; }
          const ok = midiFxTarget === 'master' ? masterFxBeatsStep(-1) : gpFxBeatsStep(midiFxUnit(), -1) !== false;
          midiBeatFlash(6, ok);
        }
        break;
      case 'fxBeatsUp':
        if (on) {
          // SHIFT + BEAT ► = NEXT effect in the list
          if (midiShiftHeld) { fxCycleType(1); break; }
          const ok = midiFxTarget === 'master' ? masterFxBeatsStep(1) : gpFxBeatsStep(midiFxUnit(), 1) !== false;
          midiBeatFlash(7, ok);
        }
        break;
      default:
        if (action.startsWith('padDel')) {
          // SHIFT+physical pad: clears the slot's hot cue / sample
          const idx = Number(action.slice(6)) - 1;
          if (on && !Number.isNaN(idx)) padClear(i, idx);
          break;
        }
        if (action.startsWith('pad')) {
          let idx = Number(action.slice(3)) - 1;
          if (Number.isNaN(idx)) break;
          const hw = MIDI_HW_PAD_MAP[deckUI[i].padMode];
          if (hw && idx < 8) idx = hw[idx];
          // PAD FX mode: the physical pad HOLDS the effect (press/release),
          // like in Rekordbox — the other modes trigger on press
          if (deckUI[i].padMode === 'fx') padFxPress(i, idx, on);
          else if (on) padPress(i, idx);
        }
    }
  },
  abs(action, deck, v) {
    const i = deck == null ? activeDeck : deck;
    const d = engine.decks[i];
    if (!d) return;
    // (see case 'tempo': slider pickup hint — which way to bring it back,
    // expressed in BPM, "go up or down compared to the master". Shown
    // at most 2×/s per deck.)
    function tempoPickupHint(idx, target, cur) {
      const nowH = performance.now();
      if (nowH - (tempoHintAt[idx] || 0) < 500) return;
      tempoHintAt[idx] = nowH;
      const dk = engine.decks[idx];
      if (!dk.bpm) return;
      const bAt = (dk.bpm * target).toFixed(1);
      const bTo = (dk.bpm * cur).toFixed(1);
      flashStatus(t('tempo_gauge_status', { n: idx + 1, at: bAt, to: bTo }));
    }
    switch (action) {
      case 'volume': d.setVolume(v); stripUI[i].fader.update(); break;
      case 'trim': d.setTrim(v * 2 - 1); stripUI[i].kTrim.update(); break;
      case 'eqHigh': d.setEq('high', v * 2 - 1); stripUI[i].kHigh.update(); break;
      case 'eqMid': d.setEq('mid', v * 2 - 1); stripUI[i].kMid.update(); break;
      case 'eqLow': d.setEq('low', v * 2 - 1); stripUI[i].kLow.update(); break;
      case 'filter': engine.setDeckColor(i, v * 2 - 1); stripUI[i].kFilt.update(); break;
      case 'tempo': {
        // SOFT TAKEOVER (like rekordbox): when the software changed the
        // tempo behind the fader's back (SYNC, calibration, master
        // handover), the PHYSICAL position no longer matches. Without a
        // guard, the controller's FIRST re-declaration (state refresh on
        // jog touch…) overwrote the BPM with the fader position AND broke
        // the sync — "an unwanted new BPM depending on the knob's state".
        // So the fader is IGNORED until the slider has COME BACK to the
        // current value (or crossed it in one gesture): first put the
        // slider back in the right place, and only then does it take over.
        // the fader covers the deck's RANGE (±6 %, ±16 % or WIDE)
        const rg = d.tempoRange || 0.16;
        const target = 1 + (v - 0.5) * 2 * rg;
        const cur = d.tempo;
        const nowT = performance.now();
        const pr = deckUI[i]._tempoPrev;
        deckUI[i]._tempoPrev = { v: target, t: nowT };
        // "crossed" = between TWO messages of the SAME gesture (< 200 ms) —
        // an old position from minutes ago doesn't count
        // SYNCED DECK: the fader NEVER turns sync off. Before, as soon as a
        // message landed on the current tempo (track just loaded at
        // 0 % + fader centered, or tempo passing near the fader after a
        // master change), the controller's next re-declaration (jog
        // touch…) took over and turned SYNC off — "I have to turn beat
        // sync back on for every track". Here only a REAL gesture (continuous
        // stream < 200 ms) counts, in RELATIVE terms: it raises / lowers the
        // BPM of the whole synced group, which stays synced.
        if (d.synced) {
          if (!pr || nowT - pr.t > 200 || !pr.v || target === pr.v) break;
          syncGroupTempoScale(i, target / pr.v);
          break;
        }
        const cross = pr && nowT - pr.t < 200
          && ((pr.v <= cur && cur <= target) || (target <= cur && cur <= pr.v));
        if (Math.abs(target - cur) > Math.max(0.0015, 0.01 * rg) && !cross) {
          tempoPickupHint(i, target, cur);
          break;
        }
        d.setTempo(target);
        d.synced = false;
        updateTempoLabel(i);
        break;
      }
      case 'crossfader':
        // NO filter: the physical fader is the TRUTH. Values received on
        // jog touches are the controller re-declaring its real position —
        // applying them is CORRECT (the screen catches up with the hardware).
        engine.setCrossfader(v);
        xfFader.update();
        break;
      case 'masterVol': engine.setMasterVolume(v); uiRefs.master.volKnob.update(); break;
      case 'masterFilter':
        engine.setMasterFilter(v * 2 - 1);
        uiRefs.master.filterKnob.update();
        break;
      case 'fxLevel': {
        // The FX level knob targets the deck chosen with CHANNEL SELECT —
        // MASTER position = FX level of the whole mix
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
  rel(action, deck, delta, cc) {
    if (action === 'browseZoom') {
      // SHIFT + browse knob (the controller's dedicated CC 100) = waveform
      // zoom, smoothly: 15 % per tick
      waveZoom(delta > 0 ? 1 / 1.15 : 1.15);
      return;
    }
    if (action === 'browse') {
      library.moveSelection(Math.sign(delta));
      updateSelectionUI();
      return;
    }
    if (action === 'jogBend') {
      // Platter EDGE: GENTLE CDJ-style nudge — same rules as the gamepad
      // stick (sync lock suspended, the placement is ADOPTED on release)
      const i = deck == null ? activeDeck : deck;
      const d = engine.decks[i];
      if (!d.buffer || delta === 0) return;
      const nowB = performance.now();
      // Hand still on the platter (or release pending): the edge controls
      // nothing, the hold decides
      const hold = midiJogState[i];
      if (hold) {
        hold.lastBendAt = nowB;
        jogDiag(hold, cc, delta);
        return;
      }
      // Wheel still coasting after release: ignored as long as the stream
      // doesn't stop (> 150 ms without a tick = wheel stopped)
      const coast = midiCoast[i];
      if (coast) {
        if (nowB < coast.until && nowB - coast.last < 150) {
          coast.last = nowB;
          coast.n++;
          coast.sum += delta;
          return;
        }
        if (coast.n) console.log(`[midi] jog deck ${i + 1}: post-release inertia ignored — CC${cc} ×${coast.n} Σ${coast.sum > 0 ? '+' : ''}${coast.sum}`);
        midiCoast[i] = null;
      }
      engine.resume();
      if (!d.playing) {
        // when stopped: fine seeking at vinyl scale (the old 0.005 s
        // per tick made 36 s per revolution on an FLX6)
        d.seek(Math.max(-3600, d.currentTime() + delta * JOG_SEC_PER_TICK));
        return;
      }
      if (!gpBend[i]) {
        gpBend[i] = { tempo: gpBaseTempo(d), synced: d.synced };
        engine.jogHold = true;
      }
      // d.synced is NO LONGER touched during the gesture (David: "don't
      // touch the sync while moving") — jogHold already suspends the
      // lock; turning sync off/on restarted the calibration in a loop
      // Coefficient 0.0044 = the EDGE setting approved by David
      // ("+25 % more") — the edge now routes to jogBend
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
      // PLATTER TOP TURNED = HAND ON IT. The top doesn't turn by
      // itself: CC34/35 only arrive under the hand. So the hold is armed
      // even if the touch sensor (note 54) said nothing — that was the
      // case of the RIGHT platter (different vinyl mode): without the note,
      // it fell into a "small jumps" mode and you couldn't HOLD it to
      // move forward/back in the track.
      let st = midiJogState[i];
      if (!st) {
        clearTimeout(midiJogArmTimer[i]);
        st = midiJogState[i] = {
          wasPlaying: d.playing,
          pos: d.currentTime(),
          implicit: !midiJogTouchHeld[i] // no touch note: release when idle
        };
        st.target = st.pos;
        if (d.playing) d.pause();
        if (scratchSound) d.scrubStart();
        engine.jogHold = true;
      }
      // LINEAR VINYL: the position FOLLOWS the platter, tick for tick.
      // DDJ-FLX6 = 7200 ticks per revolution at 33⅓ rpm (1 rev = 1.8 s of audio),
      // the same scale for both platters and every surface. (The old
      // "cubed speed impulse" model made small ticks almost nothing and
      // large ones huge — depending on the encoder resolution, a platter
      // barely moved anymore.)
      jogDiag(st, cc, delta);
      st.target = Math.max(-3600, Math.min(d.duration, (st.target ?? st.pos) + delta * JOG_SEC_PER_TICK));
      if (st.implicit && !midiJogTouchHeld[i]) {
        // No sensor: the hand is considered lifted 250 ms after the last
        // tick — the sound restarts where the platter left it
        clearTimeout(midiJogArmTimer[i]);
        midiJogArmTimer[i] = setTimeout(() => {
          if (!midiJogTouchHeld[i] && midiJogState[i] === st) jogRelease(i);
        }, 250);
      }
      if (!st.raf) {
        st.t = performance.now();
        const step = () => {
          if (midiJogState[i] !== st) return; // gesture finished
          const now2 = performance.now();
          const dt2 = Math.min(0.05, (now2 - st.t) / 1000);
          st.t = now2;
          // very short smoothing (15 ms): MIDI messages arrive in bursts,
          // the playhead glides instead of hopping
          const gap = st.target - st.pos;
          if (Math.abs(gap) > 0.00005) {
            st.pos += gap * (1 - Math.exp(-dt2 / 0.015));
            if (scratchSound) d.scrubMove(st.pos);
            else d.seek(st.pos);
          }
          st.raf = requestAnimationFrame(step);
        };
        st.raf = requestAnimationFrame(step);
      }
    }
  }
});

midi.onStatus = (name) => {
  const chip = document.getElementById('midi-status');
  if (!chip) return;
  // (the green/grey dot is in CSS — no more emoji in the bar)
  chip.textContent = name || t('no_controller');
  chip.className = name ? 'pad-on' : 'pad-off';
  renderMidiTable();
};
midi.init();

// --- CONTROLLER LEDS (rekordbox-style — "the buttons that light up") ---
// Pioneer protocol: each button lights up when it receives ITS note. Refreshed
// 10×/s; setLed only sends CHANGES (cache) and the anti-echo swallows
// the feedback — zero ghost presses possible.
// FLX6 PRINTED LABELS: the 8 physical pads follow what is PRINTED on
// the controller, not the order of the 10 on-screen pads. BEAT JUMP in PAIRS
// ◄1► ◄2► ◄4► ◄8► (in beats); PAD FX = ROLL½, SWEEP, FLANGER, V.BRAKE /
// ECHO¼, ECHO½, REVERB, BACKSPIN; BEAT LOOP = sizes 1-16 then IN/OUT/✕;
// KEY = ±4. (shared between press dispatch and LEDs)
const MIDI_HW_PAD_MAP = {
  jump: [3, 6, 2, 7, 1, 8, 0, 9],
  fx: [0, 1, 2, 4, 5, 6, 8, 9],
  loop: [5, 6, 7, 8, 9, 0, 1, 2],
  key: [1, 2, 3, 4, 5, 6, 7, 8]
};
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
    // PLAY (notes 11 + 14): steady while playing, blinks when stopped if a
    // track is loaded — exactly like rekordbox
    const play = d.playing || (loaded && blink);
    midi.setLed(i, 11, play);              // PLAY (note 11 — final table)
    midi.setLed(i, 14, loaded);            // CUE (note 14 — final table)
    midi.setLed(i, 12, loaded);            // CUE (old guess)
    midi.setLed(i, 88, !!d.synced);        // BEAT SYNC
    // MASTER BUTTON (note 92, captured): lit on the deck that IS master
    const iMaster = engine.masterIdx === i ||
      (engine.masterIdx === null && engine.autoMasterIdx === i);
    midi.setLed(i, 92, iMaster);
    midi.setLed(i, 84, !!d.cueOn); // channel HEADPHONE CUE
    // LOOP IN: also lit while an IN point is waiting for its OUT
    midi.setLed(i, 16, d.looping || d._loopInPoint != null);
    midi.setLed(i, 17, !!d.looping);       // LOOP OUT
    midi.setLed(i, 77, !!d.looping);       // RELOOP
    midi.setLed(15, i, loaded);            // "track loaded" (channel 15)
    // Pad MODE buttons: the one for the active tab is lit
    for (const mode of Object.keys(LED_MODE_NOTES)) {
      midi.setLed(i, LED_MODE_NOTES[mode], ui.padMode === mode);
    }
    // PADS: lit according to the mode's CONTENT (hot cue set, sample loaded,
    // otherwise pad available). In FX mode, the HELD pad shows alone: all
    // lit when idle, and while pressed ONLY the active pad stays lit
    const base = LED_PAD_BASE[ui.padMode];
    if (base != null) {
      const fxHeld = ui.padMode === 'fx'
        ? (ui._padFxHeld != null ? ui._padFxHeld : (ui._spinFx ? ui._spinFx.padIdx : null))
        : null;
      for (let p = 0; p < 8; p++) {
        let on = true;
        if (ui.padMode === 'hotcue') on = !!(d.hotCues && d.hotCues[p] != null);
        else if (ui.padMode === 'smp') on = !!samplerBank[p];
        else if (fxHeld != null) on = MIDI_HW_PAD_MAP.fx[p] === fxHeld;
        midi.setLed(LED_PAD_CH[i], base + p, on);
      }
    }
  }
}

// FX ON/OFF button: BLINKS on the master's beat as soon as an effect is active
// (panel, pad FX or master) — dedicated 60 ms rate: the 4 Hz tick of the
// other LEDs sampled the beat too slowly, the "on the beat" blinking
// was invisible. setLed only sends changes: zero cost.
function fxLedTick() {
  if (!midi.outputs || !midi.outputs.length) return;
  const fxActive = engine.fx.some((u) => u && u.enabled)
    || !!(engine.masterFx && engine.masterFx.enabled)
    || (engine.padFx || []).some((u) => u && u.enabled);
  let onLed = false;
  if (fxActive) {
    const mi2 = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
    const md = mi2 != null ? engine.decks[mi2] : null;
    const ph = md && md.playing ? engine._beatPhase(md) : null;
    // on the beat if the master is playing, otherwise a simple 2 Hz blink
    onLed = ph != null ? ph < 0.5 : (Math.floor(performance.now() / 250) % 2 === 0);
  }
  // SOLVED WITH DAVID: the FX button lamp listens to the note of the
  // FX SELECT selector POSITION (71/72/73 = positions 1/2/3, channel 4
  // = FX1, channel 5 = FX2) — and the LAST address received "arms" the
  // zone (sending all six only lit the last one). So we target ONLY
  // the position learned on the button's last press, per section,
  // turning off the old addresses when it changes. Re-asserted
  // every 200 ms; NEVER CC16 (switches the zone to merge mode).
  // ONE single address driven: the learned position of the section used
  // last (see midiFxSide). Both sections received the same value
  // every frame: the second one "disarmed" the first.
  const vv = onLed ? 0x7f : 0;
  const st = midiFxSide ? 0x95 : 0x94;
  const note = midiFxSlotNote[midiFxSide];
  const addr = `${st}:${note}`;
  const sig = `${vv}:${addr}`;
  const nowF = performance.now();
  if (sig !== _fxLedSig || nowF - _fxLedSentAt > 200) {
    const addrChanged = _fxLedAddr !== addr;
    _fxLedSig = sig;
    _fxLedAddr = addr;
    _fxLedSentAt = nowF;
    if (addrChanged) {
      // section/position changed: turn off ALL the other addresses
      // first — the last one sent must remain the current position
      for (const s2 of [0x94, 0x95]) {
        for (const n of [71, 72, 73]) {
          if (s2 === st && n === note) continue;
          midi._pushEcho([s2, n, 0]);
          midi._sendRaw([s2, n, 0]);
        }
      }
    }
    midi._pushEcho([st, note, vv]);
    midi._sendRaw([st, note, vv]);
  }
}
let _fxLedAddr = null;
let _fxLedSig = null;
let _fxLedSentAt = 0;
setInterval(fxLedTick, 60);
// 4 Hz is enough (and the controller answers EVERY send with a burst
// of re-declarations: the less we talk, the better it hears the buttons)
setInterval(ledTick, 250);

// --- 2 decks / 4 decks toggle ---
const btnDeckCount = document.getElementById('btn-deckcount');

// --- 📨 AUDIENCE REQUESTS: guests vote
// from http://IP:8722/guest — the DJ sees everything here and loads in one click ---
let guestData = { votes: [], msgs: [] };
let guestSeen = 0;
const btnGuests = document.createElement('button');
btnGuests.id = 'btn-guests';
btnGuests.innerHTML = `${t('guest_button_label')} <b id="guest-count">0</b>`;
btnGuests.title = t('guest_requests_title');
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
  head.innerHTML = `<b>${t('guest_panel_title')}</b><a id="gp-url" href="#" title="${t('guest_link_title')}"></a>`;
  const bClear = document.createElement('button');
  bClear.textContent = t('guest_clear_label');
  bClear.addEventListener('click', async () => {
    guestData = await window.api.guestClear();
    renderGuestPanel();
  });
  const bClose = document.createElement('button');
  bClose.textContent = '✕';
  bClose.addEventListener('click', () => guestPanel.classList.add('hidden'));
  head.append(bClear, bClose);
  guestPanel.appendChild(head);
  // QR CODE: guests scan the screen and land straight on /guest
  const qrWrap = document.createElement('div');
  qrWrap.className = 'gp-qr';
  guestPanel.appendChild(qrWrap);
  window.api.remoteStart().then(async (r) => {
    const guestUrl = `${r.url}/guest`;
    const u = document.getElementById('gp-url');
    if (u) {
      // CLICKABLE LINK: opens the guest page in the browser (to test
      // or send it), right-click = copy to the clipboard
      u.textContent = `🔗 ${guestUrl}`;
      u.addEventListener('click', (e) => {
        e.preventDefault();
        window.api.openExternal(guestUrl);
        flashStatus(t('guest_page_opened', { url: guestUrl }));
      });
      u.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(guestUrl)
          .then(() => flashStatus(t('guest_link_copied')))
          .catch(() => flashStatus(guestUrl));
      });
    }
    const qr = await window.api.guestQr(guestUrl);
    if (qr) {
      qrWrap.innerHTML = `<img src="${qr}" alt="${t('guest_qr_alt')}">
        <span>${t('guest_scan_prompt')}</span>`;
    }
  });
  if (!guestData.votes.length && !guestData.msgs.length) {
    const e = document.createElement('div');
    e.className = 'gp-empty';
    e.textContent = t('guest_no_requests_yet');
    guestPanel.appendChild(e);
  }
  // Section titles: requests are clearly separated from messages
  const gpSection = (txt) => {
    const s = document.createElement('div');
    s.className = 'gp-sect';
    s.textContent = txt;
    guestPanel.appendChild(s);
  };
  if (guestData.votes.length) {
    gpSection(t('guest_requests_section', { n: guestData.votes.length }));
  }
  guestData.votes.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'gp-row';
    row.innerHTML = `<span class="gp-votes">${v.votes} ▲</span>`
      + (v.art ? `<img class="gp-art" src="${v.art}" alt="">` : '')
      + '<span class="gp-name"></span>'
      + (v.url ? '<span class="gp-sc">SC</span>' : '')
      + `<span class="gp-bpm">${v.bpm ?? ''}</span>`;
    row.querySelector('.gp-name').textContent = v.name;
    row.title = v.url
      ? t('guest_sc_request_title')
      : t('guest_click_load_title');
    row.addEventListener('click', async () => {
      // Request coming from the guests' SOUNDCLOUD SEARCH: open the
      // link in the library, then load the track on the active deck
      // A vote that fails must not vanish silently: the row stays,
      // flagged, with the reason — the DJ knows what to do
      const markFailed = (reason) => {
        row.classList.add('gp-fail');
        const b = row.querySelector('.gp-warn') || document.createElement('span');
        b.className = 'gp-warn';
        b.textContent = '⚠';
        b.title = reason;
        if (!row.querySelector('.gp-warn')) row.insertBefore(b, row.querySelector('.gp-bpm'));
        row.title = reason;
        flashStatus(reason);
      };
      if (v.url) {
        flashStatus(t('guest_loading_sc', { name: v.name }));
        const ok = await library.loadScUrl(v.url);
        if (ok !== false && library.scTracks && library.scTracks.length) {
          const t0 = library.scTracks.find((track) => !track.scPlaylist && !track.scAccountRow);
          if (t0) {
            loadTrackToDeck(activeDeck, t0);
            guestPanel.classList.add('hidden');
            return;
          }
        }
        markFailed(t('guest_sc_load_failed', { name: v.name }));
        return;
      }
      const tr = [...library.tracks, ...library.scTracks].find(
        (track) => !track.scPlaylist && !track.scAccountRow && track.name === v.name);
      if (tr) {
        loadTrackToDeck(activeDeck, tr);
        guestPanel.classList.add('hidden');
      } else {
        markFailed(t('guest_track_not_found', { name: v.name }));
      }
    });
    guestPanel.appendChild(row);
  });
  if (guestData.msgs.length) gpSection(t('guest_messages_section', { n: guestData.msgs.length }));
  guestData.msgs.slice().reverse().forEach((m) => {
    const row = document.createElement('div');
    row.className = 'gp-msg';
    row.textContent = m.msg;
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
      ? t('guest_new_request', { name: top.name, votes: top.votes })
      : t('guest_new_message'));
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
    // Cleanly stop the hidden decks
    [2, 3].forEach((j) => {
      if (engine.decks[j].playing) engine.decks[j].pause();
      // A hidden deck must stay neither selected nor cut (CUT)
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
    // Bring the gamepad cursors back onto visible columns
    for (const st of gamepad.pads.values()) {
      if (st.deck > 1) st.deck = 0;
      if (st.cur.r > 0 && st.cur.c > 1) st.cur.c = st.deck;
    }
  }
  // The layout changes: the canvases must start from scratch (signatures and
  // caches invalidated, otherwise 0-width bitmaps linger)
  invalidateWaves();
  if (!silent) flashStatus(n === 2 ? t('deck_mode_2_status') : t('deck_mode_4_status'));
}

btnDeckCount.addEventListener('click', () => applyDeckCount(deckCount === 2 ? 4 : 2));
// NB: the initial call is further down, once the mixer and decks are
// built — applyDeckCount() reads stripUI[2]/[3], which only exist after
// buildMixer(). Calling it here crashed at startup if the last session
// had ended in 2-deck mode (stripUI still empty), which prevented ALL
// of the rest of startup from running (mixer and decks never built).

// --- Mix recording (master output -> file) ---
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
      flashStatus(res.ok ? t('recording_saved', { path: res.path }) : t('recording_canceled'));
    };
    recorder.start(1000);
    recStart = performance.now();
    btnRec.classList.add('on');
    recTime.classList.remove('hidden');
    flashStatus(t('rec_mix_recording_status'));
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
    ? t('scratch_enabled_status')
    : t('scratch_disabled_status'));
});
refreshScratchBtn();

// ---------------------------------------------------------------------------
// Keyboard (handy without a gamepad)
// ---------------------------------------------------------------------------

// Pad shortcut: switches the active deck's tab (mirrors the controller's
// mode buttons — H/J/L/K/F/M)
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
  // F2-F11 = pads 1 to 10 of the active deck (in the current tab mode)
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
// Startup
// ---------------------------------------------------------------------------

for (let i = 0; i < 4; i++) buildDeckPanel(i);
buildMixer();
buildFxBar();
setActiveDeck(0);
applyDeckCount(deckCount, true);
deckUI.forEach((_, i) => renderPads(i));
samplerInit(); // reloads the samples assigned to the pads (stored paths)
// Closing: synchronously writes any grid alignment still pending
window.addEventListener('beforeunload', () => library.flushSave());
renderHelp();
// Initial fader positioning once the layout has been computed
requestAnimationFrame(() => {
  stripUI.forEach((_, i) => refreshStrip(i));
  xfFader.update();
});

document.getElementById('btn-folder').addEventListener('click', () => library.chooseFolder());
document.getElementById('btn-help').addEventListener('click', toggleHelp);
document.getElementById('btn-close-help').addEventListener('click', toggleHelp);

// --- Settings: palette, audio output, mics, remote ---
const settingsOverlay = document.getElementById('settings-overlay');

// --- Language ---
const setLangSelect = document.getElementById('set-lang');
setLangSelect.value = getLang();
setLangSelect.addEventListener('change', (e) => {
  setLang(e.target.value);
  const lang = e.target.value === 'fr' ? 'Français' : 'English';
  // Decks, menus and labels built by JS keep the language they were built
  // with: when nothing is playing, reload the window in the new language
  // with the decks restored (one-time session restore); during a mix, only
  // the static texts switch and the rest follows at the next launch.
  if (!engine.decks.some((d) => d.playing)) {
    saveSession();
    try { localStorage.setItem('restoreOnce', '1'); } catch { /* storage unavailable */ }
    location.reload();
    return;
  }
  flashStatus(t('language_changed_next_launch', { lang }));
});

function invalidateWaves() {
  deckUI.forEach((ui) => {
    ui._zoomSig = null;
    ui._overSig = null;
    ui.over._cache = null;
    ui.wave.canvas._strip = null; // pre-rendered strip: needs repainting
  });
}

// --- Analysis: BPM range + global re-analysis ---
const setBpmRange = document.getElementById('set-bpmrange');
const storedRange = localStorage.getItem('bpmRange');
setBpmRange.value = storedRange && storedRange !== 'auto' ? storedRange : '85-170';
setBpmRange.addEventListener('change', (e) => {
  localStorage.setItem('bpmRange', e.target.value);
  flashStatus(t('bpmrange_changed'));
});
document.getElementById('set-reanalyze').addEventListener('click', () => {
  const n = library.invalidateAnalysis();
  flashStatus(t('reanalyze_started', { n }));
});
document.getElementById('set-rbimport').addEventListener('click', async () => {
  flashStatus(t('rekordbox_grids_reading'));
  try {
    const n = await library.importRekordboxGrids();
    flashStatus(n
      ? t('rekordbox_grids_imported', { n })
      : t('rekordbox_grids_none'));
  } catch (e) {
    flashStatus(t('rekordbox_grids_import_failed', { error: e.message }));
  }
});
const setGridOffset = document.getElementById('set-gridoffset');
setGridOffset.value = Number(localStorage.getItem('gridOffsetMs')) || 0;
setGlobalGridOffset((Number(setGridOffset.value) || 0) / 1000);
setGridOffset.addEventListener('change', () => {
  const ms = Math.max(-60, Math.min(60, Number(setGridOffset.value) || 0));
  localStorage.setItem('gridOffsetMs', String(ms));
  setGlobalGridOffset(ms / 1000);
  flashStatus(t('grid_offset_changed', { ms }));
});

// --- Behavior ---
const setRestore = document.getElementById('set-restore');
if (setRestore) {
  setRestore.checked = localStorage.getItem('restoreSession') === '1';
  setRestore.addEventListener('change', () => {
    localStorage.setItem('restoreSession', setRestore.checked ? '1' : '0');
  });
}
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
const setKeepBarOnJump = document.getElementById('set-keepbaronjump');
setKeepBarOnJump.checked = keepBarOnJump;
setKeepBarOnJump.addEventListener('change', () => {
  keepBarOnJump = setKeepBarOnJump.checked;
  localStorage.setItem('keepBarOnJump', keepBarOnJump ? '1' : '0');
});
const setWaveSize = document.getElementById('set-wavesize');
setWaveSize.value = localStorage.getItem('waveSize') || 'normal';
document.body.classList.toggle('waves-lg', setWaveSize.value === 'grand');
setWaveSize.addEventListener('change', () => {
  localStorage.setItem('waveSize', setWaveSize.value);
  document.body.classList.toggle('waves-lg', setWaveSize.value === 'grand');
});

// Default palette: RGB. (A "club" palette is also available in ⚙ for
// those who prefer blue lows / amber mids / white highs.)
if (!localStorage.getItem('wavePaletteChosen') && localStorage.getItem('wavePalette') === 'rekordbox') {  // old value
  localStorage.setItem('wavePalette', 'rgb');
}
setWavePalette(localStorage.getItem('wavePalette') || 'rgb');
document.getElementById('set-palette').value = localStorage.getItem('wavePalette') || 'rgb';
document.getElementById('set-palette').addEventListener('change', (e) => {
  localStorage.setItem('wavePalette', e.target.value);
  localStorage.setItem('wavePaletteChosen', '1'); // explicit choice: respected forever
  setWavePalette(e.target.value);
  invalidateWaves();
});

async function refreshDevices() {
  try {
    // Ask for mic permission once to reveal the device names
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outSel = document.getElementById('set-output');
    const current = localStorage.getItem('audioOutput') || '';
    outSel.innerHTML = `<option value="">${t('default_output')}</option>`;
    devices.filter(d => d.kind === 'audiooutput').forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || t('output_label', { id: d.deviceId.slice(0, 6) });
      if (d.deviceId === current) o.selected = true;
      outSel.appendChild(o);
    });
    // HEADPHONE output: auto (DJ controller detected), master channels 3/4,
    // or a specific sound card
    const phSel = document.getElementById('set-phones');
    if (phSel) {
      const curP = phonesPref();
      phSel.innerHTML = '';
      const add = (v, label) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if (v === curP) o.selected = true;
        phSel.appendChild(o);
      };
      const det = pickPhonesDevice(devices);
      add('auto', det ? t('phones_auto_found', { name: det.label }) : t('phones_auto'));
      add('', t('phones_master_34'));
      devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .forEach(d => add(d.deviceId, d.label || t('output_label', { id: d.deviceId.slice(0, 6) })));
    }
    const mics = devices.filter(d => d.kind === 'audioinput');
    document.getElementById('set-mics').textContent = mics.length
      ? mics.map(m => m.label || t('no_mic_named')).join(' · ')
      : t('no_mic_detected');
  } catch (err) {
    document.getElementById('set-mics').textContent = t('mics_unavailable');
  }
}

document.getElementById('set-output').addEventListener('change', async (e) => {
  try {
    await engine.ctx.setSinkId(e.target.value || '');
    engine._wireOutput(); // the channel count (headphones!) depends on the device
    localStorage.setItem('audioOutput', e.target.value);
    flashStatus(t('audio_output_changed'));
    applyPhonesOutput();
  } catch (err) {
    flashStatus(t('audio_output_error', { error: err.message || err }));
  }
});

// --- HEADPHONE OUTPUT ---
// Preference: 'auto' (default) = the connected DJ controller (FLX6…) receives
// the cue preview on its channels 3/4, even if the master goes out on another card.
function phonesPref() {
  try { return localStorage.getItem('phonesOutput') ?? 'auto'; } catch { return 'auto'; }
}
const DJ_CARD_RE = /DDJ|Pioneer|FLX|XDJ|Numark|Hercules|Traktor|Kontrol|Denon|Rane|Reloop|Mixtrack|Roland DJ/i;
function pickPhonesDevice(devices) {
  const outs = devices.filter((d) => d.kind === 'audiooutput'
    && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return outs.find((d) => DJ_CARD_RE.test(d.label || '')) || null;
}
let _phonesBusy = false;
async function applyPhonesOutput(announce) {
  if (_phonesBusy) return;
  _phonesBusy = true;
  try {
    const pref = phonesPref();
    let id = '';
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* none */ }
    if (pref === 'auto') {
      const dj = pickPhonesDevice(devices);
      id = dj ? dj.deviceId : '';
    } else if (pref && devices.some((d) => d.kind === 'audiooutput' && d.deviceId === pref)) {
      id = pref;
    }
    // the headphone card IS the master output? the 4-channel wiring is enough
    let masterId = '';
    try { masterId = localStorage.getItem('audioOutput') || ''; } catch { /* default */ }
    if (id && masterId === id) id = '';
    if (id && !masterId) {
      // master on "default output": is that already the controller?
      const def = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
      const card = devices.find((d) => d.deviceId === id);
      if (def && card && card.label && (def.label || '').includes(card.label)) id = '';
    }
    const before = engine.phonesDevice || '';
    const ok = await engine.setPhonesDevice(id);
    if (announce || before !== (engine.phonesDevice || '')) {
      const card = devices.find((d) => d.deviceId === id);
      if (id && ok) flashStatus(t('phones_on_card', { name: card ? card.label : id }));
      else if (id && !ok) flashStatus(t('phones_card_error'));
    }
  } finally {
    _phonesBusy = false;
  }
}
document.getElementById('set-phones')?.addEventListener('change', (e) => {
  try { localStorage.setItem('phonesOutput', e.target.value); } catch { /* storage unavailable */ }
  applyPhonesOutput(true);
});
// controller plugged in / unplugged mid-session: the headphone output follows
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(applyPhonesOutput._t);
  applyPhonesOutput._t = setTimeout(() => applyPhonesOutput(), 800);
});

// --- MIDI learn table ---
function renderMidiTable() {
  const table = document.getElementById('midi-learn-table');
  const info = document.getElementById('midi-device');
  if (!table) return;
  if (info) {
    info.textContent = midi.deviceName
      ? t('midi_connected', { name: midi.deviceName, ddj: /ddj|pioneer/i.test(midi.deviceName) ? t('midi_ddj_preset') : '' })
      : t('no_midi_device');
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
      <button class="midi-learn" title="${t('midi_learn_button_title')}">Learn</button>
      <button class="midi-clear" title="${t('midi_clear_binding_title')}">✕</button>
    `;
    row.querySelector('.midi-label').textContent = label;
    row.querySelector('.midi-learn').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.textContent = '…';
      const key = await midi.learn(action, deck);
      btn.textContent = 'Learn';
      if (key) {
        row.querySelector('.midi-bind').textContent = key;
        flashStatus(t('midi_learned', { label, key }));
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
  document.getElementById('set-remote-url').textContent = t('remote_url_label', { url: r.url });
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

// Restore the previously chosen audio output
if (localStorage.getItem('audioOutput')) {
  engine.ctx.setSinkId(localStorage.getItem('audioOutput'))
    .then(() => engine._wireOutput())
    .catch(() => {})
    .then(() => applyPhonesOutput());
} else {
  applyPhonesOutput();
}

// --- Phone console: runs the commands received from the phone ---
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
        flashStatus(t('deck_sync_off_flash', { n: (c.deck ?? 0) + 1 }));
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
      // same rule as the logo / R1: the bass goes to THIS deck
      gpBassTo(c.deck);
      flashStatus(t('bass_routed_remote', { n: c.deck + 1 }));
      break;
    case 'jump': doBeatJump(c.deck, c.value); break;
    case 'hotcue': padPress(c.deck, c.value, 'hotcue', null); break;
    case 'pad':
      // generic pad: same engine as the PC pads (hotcue/loop/jump)
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
      // Only REAL tracks (path or scId) load from the phone —
      // never a navigation row (playlist, 👤 account…)
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
      // Diagnostics: drive a controller LED by hand (ch, note, on)
      midi.send([0x90 | (c.ch & 0x0f), c.note & 0x7f, c.on ? 0x7f : 0]);
      break;
    case 'rawmidi':
      // Diagnostics: raw MIDI frame (byte array)
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
libSearchEl.placeholder = t('search_placeholder_hint');
libSearchEl.addEventListener('input', (e) => library.setSearch(e.target.value));
// Enter = SoundCloud CATALOG search engine (beyond the playlists)
libSearchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = libSearchEl.value.trim();
  if (!q) return;
  e.preventDefault();
  library.searchSc(q);
});

// --- Tree browser (Rekordbox style) ---
const libTree = document.getElementById('lib-tree');
let selectedTreeNode = null;

// Path → tree node registry: lets us EXPAND the tree down to the current
// folder ("show that I'm in this folder which is inside that
// folder…") when navigating with the encoder or the mouse
const normTreePath = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase();
const treeRowsByPath = new Map(); // norm(path) -> { row, ensureOpen }

// Generic node: { name, onClick, getChildren } — getChildren is RE-READ on
// every expansion (playlists / folders change during the session)
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

  // DISK folders of the tree: you can file things into them (OpenMix music)
  // and move the ones inside OpenMix music
  if (item.path && /^([a-z]:[\\/]|\\\\)/i.test(item.path)) {
    makeFolderDropTarget(row, () => item.path);
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (!inNative(item.path) || isNativeRoot(item.path)) {
        e.preventDefault();
        return;
      }
      startDirDrag(e, item.path);
    });
    row.addEventListener('dragend', () => { dragDir = null; });
    row.addEventListener('contextmenu', (e) => {
      if (!inNative(item.path)) return;
      e.preventDefault();
      showNativeFolderMenu(e, item.path);
    });
  }

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

// Expands the tree level by level down to the requested folder and highlights it
async function treeReveal(target) {
  const t = normTreePath(target);
  let best = null;
  for (const [p, e] of treeRowsByPath) {
    if ((t === p || t.startsWith(p + '\\')) && (!best || p.length > best[0].length)) best = [p, e];
  }
  if (!best) return;
  let [p, e] = best;
  while (p !== t) {
    await e.ensureOpen(); // loads the children → they register themselves
    const seg = t.slice(p.length + 1).split(/[\\/]/)[0];
    const next = treeRowsByPath.get(`${p}\\${seg}`);
    if (!next) break; // filtered/hidden folder: stop at the closest one
    p = `${p}\\${seg}`;
    e = next;
  }
  treeHighlight(e.row);
}

// Highlights a "virtual" node (SoundCloud, Playlists…) and, if requested, one
// of its children — expanding it on the way
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

// Disk folder: click = scan, arrow = subfolders (WHOLE PC:
// roots C:..G: + Music/Desktop/Documents/Downloads)
function fsTreeItem(r) {
  return {
    name: r.native ? t('dl_native_root') : r.name,
    path: r.path,
    onClick: () => enterFolder(r.path),
    getChildren: async () => (await window.api.fsList(r.path)).map(fsTreeItem)
  };
}

async function buildTree() {
  const roots = await window.api.fsRoots();
  libTree.textContent = '';
  treeRowsByPath.clear();
  // OpenMix's NATIVE music folder (downloads): at the very top
  roots.filter((r) => r.native).forEach((r) => libTree.appendChild(makeTreeNode(fsTreeItem(r), 0)));
  // SoundCloud IN the browser: 1 account = ITS playlists (❤️ Likes
  // included) as direct children, as always; ≥ 2 accounts (b2b) = one
  // 👤 node per account, each expanding ITS playlists with ITS token.
  // The playlists are requested DIRECTLY from main (without going through
  // the view): expanding the tree no longer changes the list shown on the right.
  libTree.appendChild(makeTreeNode({
    name: 'SoundCloud',
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
        name: a.name || t('sc_tree_account_fallback', { n: i + 1 }),
        path: `sc:acct:${i}`,
        onClick: () => openScAccount(i),
        getChildren: () => plChildren(i)
      }));
    }
  }, 0));
  // Local playlists (including those imported from Rekordbox)
  libTree.appendChild(makeTreeNode({
    name: 'Playlists',
    path: 'pl:',
    onClick: () => openPlaylistsRoot(),
    getChildren: async () => library.playlists.map((p) => ({
      name: p.name,
      path: `pl:${p.id}`,
      onClick: () => openLocalPlaylist(p)
    }))
  }, 0));
  roots.filter((r) => !r.native).forEach((r) => libTree.appendChild(makeTreeNode(fsTreeItem(r), 0)));
}
buildTree();

// --- Library tabs: local files / SoundCloud ---
const tabLocal = document.getElementById('tab-local');
const tabSc = document.getElementById('tab-sc');
const tabHist = document.getElementById('tab-hist');
const tabPl = document.getElementById('tab-pl');
const scBar = document.getElementById('sc-bar');
const plBar = document.getElementById('pl-bar');
const btnFolder = document.getElementById('btn-folder');
const scUrlInput = document.getElementById('sc-url');

// ---------------------------------------------------------------------------
// DOWNLOAD FROM A LINK (yt-dlp): YouTube, SoundCloud and the other sites
// yt-dlp knows. "⬇ Link" button, or a link dropped on a deck (it loads
// there as soon as it has arrived). Files go to Music › OpenMix, in the
// original audio format (no re-encoding).
// ---------------------------------------------------------------------------
// Download DESTINATION: a folder inside OpenMix's native folder
// (stored relative path, '' = the root)
let dlDestRel = (() => { try { return localStorage.getItem('dlDest') || ''; } catch { return ''; } })();
const dlDestPath = () => {
  if (!dlInfo.root) return null;
  const f = dlInfo.folders.find((x) => x.rel === dlDestRel);
  return f ? f.path : dlInfo.root;
};
async function refreshDlInfo() {
  if (!window.api.dlInfo) return;
  dlInfo = await window.api.dlInfo().catch(() => dlInfo);
  if (dlDestRel && !dlInfo.folders.some((x) => x.rel === dlDestRel)) dlDestRel = '';
  const sel = document.getElementById('ws-dest');
  if (sel) {
    sel.textContent = '';
    const opt = (v, label) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    };
    opt('', t('dl_root_option'));
    dlInfo.folders.forEach((f) => opt(f.rel, `📁 ${f.rel.replace(/\//g, ' › ')}`));
    sel.value = dlDestRel;
  }
  const rootEl = document.getElementById('set-dlroot');
  if (rootEl) rootEl.textContent = dlInfo.root || '—';
}
function setDlDest(rel) {
  dlDestRel = rel || '';
  try { localStorage.setItem('dlDest', dlDestRel); } catch { /* nothing */ }
  const sel = document.getElementById('ws-dest');
  if (sel) sel.value = dlDestRel;
}
// Create a folder ("House" or "House/Deep") and pick it as the destination
async function dlNewFolder() {
  const name = await askText(t('dl_newdir_prompt'), '');
  if (!name) return null;
  const r = await window.api.dlMkdir(name);
  if (!r.ok) {
    flashStatus(t('dl_newdir_failed', { error: r.error }));
    return null;
  }
  await refreshDlInfo();
  setDlDest(r.rel);
  buildTree().then(() => { if (library.fsDir) treeReveal(library.fsDir); });
  flashStatus(t('dl_newdir_done', { name: r.rel }));
  return r;
}

// ---------------------------------------------------------------------------
// ORGANIZING "My OpenMix music" WITH THE MOUSE. In the native folder:
//  - drag a TRACK onto a 📁 row (or onto a tree folder, or onto
//    "..") = it is filed there — MOVED if it is already in OpenMix
//    music, COPIED if it comes from elsewhere;
//  - drag a FOLDER onto another = moved into it;
//  - files dragged from Windows Explorer, YouTube /
//    SoundCloud links: copied / downloaded INTO the target folder;
//  - "＋ Folder" creates a folder in the open folder; right-click =
//    rename, new subfolder, recycle bin.
// Outside the native folder nothing changes: the PC's other files are
// NEVER touched.
// ---------------------------------------------------------------------------
// (DECLARED functions, not const: the list may render before
// the module gets here)
const DIR_MIME = 'application/x-openmix-dir';
function normFsPath(p) { return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); }
function parentDir(p) { return String(p || '').replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, ''); }
const AUDIO_FILE_RE = /\.(mp3|wav|flac|ogg|m4a|aac|opus|webm)$/i;
function inNative(p) {
  if (!dlInfo || !dlInfo.root || !p) return false;
  const r = normFsPath(dlInfo.root);
  const x = normFsPath(p);
  return x === r || x.startsWith(`${r}\\`);
}
function isNativeRoot(p) { return !!(dlInfo && dlInfo.root) && normFsPath(p) === normFsPath(dlInfo.root); }
// Is the folder open in the list inside OpenMix music?
function browsingNative() { return library.mode === 'local' && !library.rootsView && inNative(library.fsDir); }

function startDirDrag(e, p) {
  dragDir = p;
  e.dataTransfer.setData(DIR_MIME, p);
  e.dataTransfer.effectAllowed = 'move';
}
function canDropDir(src, dest) {
  if (!src || !dest || !inNative(src) || isNativeRoot(src) || !inNative(dest)) return false;
  const s = normFsPath(src);
  const d = normFsPath(dest);
  return d !== s && !d.startsWith(`${s}\\`) && normFsPath(parentDir(src)) !== d;
}
function dragHasFiles(dt) { return !!dt && [...(dt.types || [])].includes('Files'); }
// Can what is being dragged be filed into dest? → 'move' / 'copy' / null
function folderDropEffect(dt, dest) {
  if (!dest || !inNative(dest)) return null;
  if (dragDir) return canDropDir(dragDir, dest) ? 'move' : null;
  if (dragTrack) {
    if (!dragTrack.path || dragTrack.sc) return null;
    if (normFsPath(parentDir(dragTrack.path)) === normFsPath(dest)) return null; // already there
    return 'move'; // ALWAYS moved, never copied
  }
  if (dragHasFiles(dt)) return 'move';
  if (dragHasLink(dt)) return 'copy';
  return null;
}

// Makes a row / node able to RECEIVE dropped items
function makeFolderDropTarget(el, getDir) {
  el.addEventListener('dragover', (e) => {
    const eff = folderDropEffect(e.dataTransfer, getDir());
    if (!eff) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = eff;
    el.classList.add('folder-drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('folder-drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('folder-drop');
    const dest = getDir();
    if (!folderDropEffect(e.dataTransfer, dest)) return;
    e.preventDefault();
    e.stopPropagation();
    dropIntoFolder(dest, e.dataTransfer);
  });
}

async function dropIntoFolder(dest, dt) {
  const track = dragTrack;
  const dir = dragDir;
  dragTrack = null;
  dragDir = null;
  if (dir) {
    const r = await window.api.dlMoveDir(dir, dest);
    if (!r.ok) {
      flashStatus(t('dl_place_failed', { error: r.error }));
      return;
    }
    applyMoves(r.moves);
    // the open folder was inside the one just moved: follow it
    if (library.fsDir && inNative(library.fsDir)) {
      const s = normFsPath(dir);
      const cur = normFsPath(library.fsDir);
      if (cur === s || cur.startsWith(`${s}\\`)) followDir = r.path + library.fsDir.slice(dir.length);
    }
    flashStatus(t('dl_dir_moved', { name: r.name, dest: folderLabel(dest) }));
    afterOrganize(true);
    return;
  }
  if (track) {
    await placeFiles([track.path], dest, track);
    return;
  }
  const files = [...(dt.files || [])].map((f) => window.api.pathForFile?.(f)).filter(Boolean);
  if (files.length) {
    const audio = files.filter((p) => AUDIO_FILE_RE.test(p));
    if (!audio.length) {
      flashStatus(t('dl_drop_no_audio'));
      return;
    }
    await placeFiles(audio, dest, null);
    return;
  }
  const url = linkFromDrop(dt);
  if (url) ytDownload(url, null, dest);
}

function folderLabel(p) { return isNativeRoot(p) ? t('dl_native_root') : `📁 ${String(p).split(/[\\/]/).pop()}`; }

async function placeFiles(paths, dest, track) {
  let ok = 0;
  let lastErr = '';
  for (const p of paths) {
    const r = await window.api.dlPlace(p, dest);
    if (!r.ok) {
      lastErr = r.error;
      continue;
    }
    ok++;
    if (track) library.relocateTrack(track, r);
    else applyMoves([{ from: p, to: r.path, size: r.size, mtime: r.mtime }]);
    followDeckPath(p, r.path);
  }
  if (!ok) {
    flashStatus(t('dl_place_failed', { error: lastErr }));
    return;
  }
  flashStatus(paths.length === 1
    ? t('dl_place_moved', { name: String(paths[0]).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') })
    : t('dl_place_many', { n: ok, dest: folderLabel(dest) }));
  afterOrganize(false);
}

// Moved / renamed files: analyses, playlists, history and decks follow
function applyMoves(moves) {
  (moves || []).forEach((m) => {
    library.relocateMoved(m);
    followDeckPath(m.from, m.to);
  });
}
function followDeckPath(from, to) {
  engine.decks.forEach((d) => {
    if (d.track && d.track.path && normFsPath(d.track.path) === normFsPath(from)) {
      d.track.path = to;
      d.track.key = undefined;
    }
  });
}

// After organizing: list, download folders, tree
// (followDir: the open folder was moved / renamed / trashed — follow it)
let followDir = null;
async function afterOrganize(foldersChanged) {
  await refreshDlInfo();
  const fd = followDir;
  followDir = null;
  if (foldersChanged) await buildTree();
  if (fd) {
    enterFolder(fd);
  } else if (library.mode === 'local' && !library.rootsView && library.fsDir) {
    library.scan(library.fsDir);
    if (foldersChanged) treeReveal(library.fsDir);
  } else if (library.rootsView) {
    library.applyFilter();
  }
}

// ＋ Folder: created INSIDE the open folder (or at the root of OpenMix music)
async function newFolderIn(parent) {
  const name = await askText(t('dl_newdir_here_prompt', { dir: folderLabel(parent) }), '');
  if (!name) return null;
  const r = await window.api.dlMkdir(name, parent);
  if (!r.ok) {
    flashStatus(t('dl_newdir_failed', { error: r.error }));
    return null;
  }
  flashStatus(t('dl_newdir_made', { name: r.rel.replace(/\//g, ' › ') }));
  afterOrganize(true);
  return r;
}

async function renameNative(p, isDir) {
  const base = String(p).split(/[\\/]/).pop();
  const cur = isDir ? base : base.replace(/\.[^.]+$/, '');
  const name = await askText(t('dl_rename_prompt'), cur);
  if (!name || name === cur) return;
  const r = await window.api.dlRename(p, name);
  if (!r.ok) {
    flashStatus(t('dl_rename_failed', { error: r.error === 'exists' ? t('dl_name_taken') : r.error }));
    return;
  }
  applyMoves(r.moves);
  if (r.dir && library.fsDir) {
    const s = normFsPath(p);
    const c = normFsPath(library.fsDir);
    if (c === s || c.startsWith(`${s}\\`)) followDir = r.path + library.fsDir.slice(p.length);
  }
  flashStatus(t('dl_renamed', { name: r.name }));
  afterOrganize(!!r.dir);
}

async function trashNative(p, isDir) {
  const name = String(p).split(/[\\/]/).pop();
  if (!window.confirm(t(isDir ? 'dl_trash_dir_confirm' : 'dl_trash_confirm', { name }))) return;
  const r = await window.api.dlTrash(p);
  if (!r.ok) {
    flashStatus(t('dl_trash_failed', { error: r.error }));
    return;
  }
  if (isDir && library.fsDir) {
    const s = normFsPath(p);
    const c = normFsPath(library.fsDir);
    if (c === s || c.startsWith(`${s}\\`)) followDir = parentDir(p);
  }
  flashStatus(t('dl_trashed', { name }));
  afterOrganize(!!isDir);
}

// Right-click on a folder in OpenMix music
function showNativeFolderMenu(e, p) {
  ctxMenu.textContent = '';
  const addItem = (label, fn) => {
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.textContent = label;
    d.addEventListener('click', () => { hideCtxMenu(); fn(); });
    ctxMenu.appendChild(d);
  };
  addItem(t('dl_menu_open'), () => enterFolder(p));
  addItem(t('dl_menu_newdir'), () => newFolderIn(p));
  addItem(t('dl_menu_dest'), () => {
    const f = dlInfo.folders.find((x) => normFsPath(x.path) === normFsPath(p));
    setDlDest(f ? f.rel : '');
    flashStatus(t('dl_dest_set', { dir: folderLabel(p) }));
  });
  if (!isNativeRoot(p) && !isNativeRoot(parentDir(p))) {
    addItem(t('dl_menu_out', { name: String(parentDir(p)).split(/[\\/]/).pop() }), async () => {
      dragDir = p;
      await dropIntoFolder(parentDir(parentDir(p)), null);
    });
  }
  if (!isNativeRoot(p)) {
    addItem(t('dl_menu_rename'), () => renameNative(p, true));
    addItem(t('dl_menu_trash'), () => trashNative(p, true));
  }
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - ctxMenu.childElementCount * 30 - 10)}px`;
  ctxMenu.classList.remove('hidden');
}

// The bar's "＋ Folder" button: visible inside OpenMix music
document.getElementById('btn-lib-newdir')?.addEventListener('click', () => newFolderIn(browsingNative() ? library.fsDir : dlInfo.root));
function updateNewDirBtn() {
  document.getElementById('btn-lib-newdir')?.classList.toggle('hidden', !browsingNative());
}

let ytJob = null; // download in progress { id, url, deck, pct, title }
let ytSeq = 0;
const ytQueue = []; // pending downloads { url, deck }
const btnYt = document.getElementById('btn-ytdlp');

async function refreshYtStatus() {
  const el = document.getElementById('set-ytdlp-status');
  if (!el || !window.api.ytdlpStatus) return;
  const st = await window.api.ytdlpStatus().catch(() => null);
  el.textContent = st && st.ok
    ? t('ytdlp_status_ok', { v: st.version, src: t(st.source === 'openmix' ? 'ytdlp_src_openmix' : 'ytdlp_src_system'), dir: st.dir })
    : t('ytdlp_status_none');
}

async function ytInstall() {
  flashStatus(t('ytdlp_installing'));
  const r = await window.api.ytdlpInstall();
  if (!r.ok) {
    flashStatus(t('ytdlp_install_failed', { error: r.error }));
    return false;
  }
  flashStatus(t('ytdlp_installed', { v: r.version }));
  refreshYtStatus();
  return true;
}

// yt-dlp ready? Otherwise offer to install it (once, with consent)
async function ytEnsure() {
  const st = await window.api.ytdlpStatus();
  if (st.ok) return true;
  if (!window.confirm(t('ytdlp_install_confirm'))) return false;
  return ytInstall();
}

function ytUpdateButton() {
  if (!btnYt) return;
  btnYt.textContent = ytJob
    ? t('ytdlp_button_busy', { pct: Math.round(ytJob.pct || 0) }) + (ytQueue.length ? ` (+${ytQueue.length})` : '')
    : t('ytdlp_button');
  btnYt.classList.toggle('on', !!ytJob);
}

async function ytDownload(url, deckIdx = null, destDir = null) {
  url = String(url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    flashStatus(t('ytdlp_bad_url'));
    return;
  }
  if (ytJob) {
    // a download is already running: this one waits its turn
    ytQueue.push({ url, deck: deckIdx, dest: destDir || dlDestPath() });
    ytUpdateButton();
    flashStatus(t('ytdlp_queued', { n: ytQueue.length }));
    return;
  }
  if (!(await ytEnsure())) return;
  const id = ++ytSeq;
  ytJob = { id, url, deck: deckIdx, pct: 0, title: '' };
  ytUpdateButton();
  flashStatus(t('ytdlp_started'));
  let res;
  try {
    res = await window.api.ytdlpDownload(url, id, destDir || dlDestPath());
  } catch (err) {
    res = { ok: false, error: String(err.message || err) };
  } finally {
    ytJob = null;
    ytUpdateButton();
  }
  // the next one in the queue starts as soon as this one is done
  const next = () => {
    const n = ytQueue.shift();
    if (n) setTimeout(() => ytDownload(n.url, n.deck, n.dest), 50);
    ytUpdateButton();
  };
  if (!res.ok) {
    flashStatus(res.cancelled ? t('ytdlp_cancelled') : t('ytdlp_failed', { error: res.error }));
    if (res.cancelled) ytQueue.length = 0; // cancel = empty the queue too
    next();
    return;
  }
  next();
  const files = res.files;
  flashStatus(files.length > 1
    ? t('ytdlp_done_many', { n: files.length, dir: res.dir })
    : t('ytdlp_done', { name: files[0].name, dir: res.dir }));
  // the browser is already showing this folder: it refreshes
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  if (library.mode === 'local' && norm(library.fsDir) === norm(res.dir)) library.scan(library.fsDir);
  if (deckIdx != null && files[0]) loadTrackToDeck(deckIdx, { ...files[0] });
}

if (window.api.onYtdlpProgress) {
  window.api.onYtdlpProgress((p) => {
    if (!ytJob || p.id !== ytJob.id) return;
    ytJob.pct = p.pct || 0;
    if (p.title) ytJob.title = p.title;
    ytUpdateButton();
    const items = p.of > 1 ? ` (${p.item}/${p.of})` : '';
    libStatus.textContent = t('ytdlp_progress', { pct: Math.round(ytJob.pct), title: ytJob.title || '…', items });
  });
}

if (btnYt) {
  btnYt.addEventListener('click', async () => {
    if (ytJob) {
      if (window.confirm(t('ytdlp_cancel_confirm'))) window.api.ytdlpCancel(ytJob.id);
      return;
    }
    // a link already copied is offered by default
    let clip = '';
    try { clip = (await navigator.clipboard.readText()) || ''; } catch { /* clipboard denied */ }
    const pre = /^https?:\/\/\S+$/i.test(clip.trim()) ? clip.trim() : '';
    await refreshDlInfo();
    const url = await askText(t('ytdlp_prompt_dest', { dir: dlDestRel ? dlDestRel.replace(/\//g, ' › ') : t('dl_native_root') }), pre);
    if (url) ytDownload(url, null);
  });
}
// link dropped on the LIST: plain download
const libWrapEl = document.getElementById('lib-list-wrap');
if (libWrapEl) {
  libWrapEl.addEventListener('dragover', (e) => {
    // inside OpenMix music: whatever is dropped lands in the OPEN folder
    if (browsingNative()) {
      const eff = folderDropEffect(e.dataTransfer, library.fsDir);
      if (!eff) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = eff;
      return;
    }
    if (dragTrack || dragDir || !dragHasLink(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  libWrapEl.addEventListener('drop', (e) => {
    if (browsingNative()) {
      if (!folderDropEffect(e.dataTransfer, library.fsDir)) return;
      e.preventDefault();
      dropIntoFolder(library.fsDir, e.dataTransfer);
      return;
    }
    if (dragTrack || dragDir) return;
    const url = linkFromDrop(e.dataTransfer);
    if (!url) return;
    e.preventDefault();
    ytDownload(url, null);
  });
}
const setYtInstall = document.getElementById('set-ytdlp-install');
if (setYtInstall) setYtInstall.addEventListener('click', () => ytInstall());
refreshYtStatus();

// ---------------------------------------------------------------------------
// YouTube + SoundCloud SEARCH, with download (yt-dlp). Each result:
// ⬇ (into Music › OpenMix) or 1 2 3 4 (downloaded then loaded on
// that deck). A result can also be DRAGGED onto a deck.
// ---------------------------------------------------------------------------
const wsPanel = document.getElementById('web-search');
const wsQuery = document.getElementById('ws-query');
const wsResults = document.getElementById('ws-results');
const wsStatus = document.getElementById('ws-status');
let wsSeq = 0;

function wsOpen() {
  wsPanel.classList.remove('hidden');
  // the button STAYS LIT while the panel is open: you know another
  // click brings the library back
  document.getElementById('btn-web-search')?.classList.add('on');
  refreshDlInfo(); // folders created in the meantime (Windows Explorer…)
  wsQuery.focus();
  wsQuery.select();
}
function wsClose() {
  wsPanel.classList.add('hidden');
  document.getElementById('btn-web-search')?.classList.remove('on');
}

function wsRow(it) {
  const row = document.createElement('div');
  row.className = `ws-row ws-${it.src}${it.drm ? ' ws-drm' : ''}`;
  row.draggable = !it.drm;
  const dur = it.duration ? formatTime(it.duration) : '';
  row.innerHTML = `
    <span class="ws-badge">${it.src === 'yt' ? 'YT' : 'SC'}</span>
    <img class="ws-thumb" alt="" loading="lazy">
    <span class="ws-main"><span class="ws-title"></span><span class="ws-artist"></span></span>
    <span class="ws-dur">${dur}</span>
    <span class="ws-actions"></span>`;
  if (it.thumb) row.querySelector('.ws-thumb').src = it.thumb;
  else row.querySelector('.ws-thumb').classList.add('empty');
  row.querySelector('.ws-title').textContent = it.title;
  row.querySelector('.ws-artist').textContent = it.artist || '';
  const acts = row.querySelector('.ws-actions');
  if (it.drm) {
    acts.textContent = t('web_search_drm');
    return row;
  }
  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
      b.classList.add('done');
    });
    acts.appendChild(b);
  };
  btn('⬇', t('web_search_dl_title'), () => ytDownload(it.url, null));
  for (let d = 0; d < deckCount; d++) {
    btn(String(d + 1), t('web_search_deck_title', { n: d + 1 }), () => ytDownload(it.url, d));
  }
  // dragging the result onto a deck = downloaded then loaded on it
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/uri-list', it.url);
    e.dataTransfer.setData('text/plain', it.url);
    e.dataTransfer.effectAllowed = 'copy';
  });
  row.addEventListener('dblclick', () => ytDownload(it.url, activeDeck));
  return row;
}

async function wsSearch() {
  const q = wsQuery.value.trim();
  if (!q) return;
  const useYt = document.getElementById('ws-yt').checked;
  const useSc = document.getElementById('ws-sc').checked;
  const seq = ++wsSeq;
  wsResults.textContent = '';
  wsStatus.textContent = t('web_search_running');
  const jobs = [];
  if (useYt) {
    jobs.push((async () => {
      if (!(await ytEnsure())) return { src: 'yt', items: [], error: t('ytdlp_status_none') };
      const r = await window.api.ytdlpSearch(q, 20).catch((e) => ({ ok: false, error: String(e) }));
      return { src: 'yt', items: r.ok ? r.items : [], error: r.ok ? null : r.error };
    })());
  }
  if (useSc) {
    jobs.push((async () => {
      const r = await window.api.scSearch(q, library.scAcctIdx ?? 0).catch((e) => ({ ok: false, error: String(e) }));
      const items = r.ok ? (r.tracks || []).map((tr) => {
        const sep = (tr.name || '').indexOf(' - ');
        return {
          src: 'sc',
          url: tr.permalink,
          title: sep > 0 ? tr.name.slice(sep + 3) : tr.name,
          artist: sep > 0 ? tr.name.slice(0, sep) : '',
          duration: tr.duration,
          thumb: tr.artwork ? tr.artwork.replace('-t500x500', '-large') : null,
          drm: !!tr.drm || !tr.permalink
        };
      }) : [];
      return { src: 'sc', items, error: r.ok ? null : r.error };
    })());
  }
  const res = await Promise.all(jobs);
  if (seq !== wsSeq) return; // another search was started in the meantime
  // INTERLEAVED results (1st YouTube, 1st SoundCloud, 2nd…)
  const lists = res.map((r) => r.items);
  const merged = [];
  for (let k = 0; k < 40; k++) for (const l of lists) if (l[k]) merged.push(l[k]);
  merged.forEach((it) => wsResults.appendChild(wsRow(it)));
  const errs = res.filter((r) => r.error).map((r) => t('web_search_source_error', { src: r.src === 'yt' ? 'YouTube' : 'SoundCloud', error: r.error }));
  wsStatus.textContent = (merged.length ? t('web_search_count', { n: merged.length }) : t('web_search_none'))
    + (errs.length ? ` — ${errs.join(' · ')}` : '');
}

document.getElementById('ws-dest')?.addEventListener('change', (e) => setDlDest(e.target.value));
document.getElementById('ws-newdir')?.addEventListener('click', () => dlNewFolder());
document.getElementById('set-dlroot-change')?.addEventListener('click', async () => {
  const r = await window.api.dlChooseRoot();
  if (!r.ok) return;
  setDlDest('');
  await refreshDlInfo();
  buildTree();
  flashStatus(t('dl_root_changed', { dir: r.root }));
});
refreshDlInfo();

document.getElementById('btn-web-search')?.addEventListener('click', () => {
  if (wsPanel.classList.contains('hidden')) wsOpen();
  else wsClose();
});
document.getElementById('ws-close')?.addEventListener('click', wsClose);
document.getElementById('ws-go')?.addEventListener('click', wsSearch);
wsQuery?.addEventListener('keydown', (e) => {
  e.stopPropagation(); // the app's keyboard shortcuts must not fire
  if (e.key === 'Enter') wsSearch();
  if (e.key === 'Escape') wsClose();
});

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

// --- Small input modal (Electron has no window.prompt) ---
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

// --- Playlists: action bar ---
const btnPlBack = document.getElementById('btn-pl-back');
const btnPlNew = document.getElementById('btn-pl-new');
const btnPlPlay = document.getElementById('btn-pl-play');

btnPlBack.addEventListener('click', () => library.closePlaylist());
btnPlNew.addEventListener('click', async () => {
  const name = await askText(t('new_playlist_name_prompt'), `Playlist ${library.playlists.length + 1}`);
  if (name) {
    library.createPlaylist(name);
    flashStatus(t('playlist_created', { name }));
  }
});

// --- Rekordbox import: the official XML export (File → Export Collection
// in xml format) contains the COLLECTION (paths, BPM, grid) and the
// PLAYLIST tree — we take both, free and without Pioneer.
async function importRekordboxXml() {
  const xmlPath = await window.api.pickXml();
  if (!xmlPath) return;
  flashStatus(t('rekordbox_xml_reading'));
  let doc;
  try {
    const raw = await window.api.readFile(xmlPath);
    const text = new TextDecoder('utf-8').decode(raw);
    doc = new DOMParser().parseFromString(text, 'text/xml');
  } catch {
    flashStatus(t('rekordbox_xml_read_failed'));
    return;
  }
  if (!doc || doc.querySelector('parsererror') || !doc.querySelector('DJ_PLAYLISTS')) {
    flashStatus(t('rekordbox_xml_not_export'));
    return;
  }
  // 1) Collection: TrackID -> track reference (decoded path, Rekordbox BPM
  // and grid start kept — no need to re-analyze)
  const byId = new Map();
  let skippedNoFile = 0;
  for (const trackNode of doc.querySelectorAll('COLLECTION TRACK')) {
    const id = trackNode.getAttribute('TrackID');
    const loc = trackNode.getAttribute('Location') || '';
    if (!/^file:/i.test(loc)) { skippedNoFile++; continue; } // streaming tracks
    let p = loc.replace(/^file:\/\/localhost\//i, '').replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch { /* path already raw */ }
    p = p.replace(/\//g, '\\');
    const artist = trackNode.getAttribute('Artist') || '';
    const title = trackNode.getAttribute('Name') || p.replace(/^.*\\/, '');
    const bpm = parseFloat(trackNode.getAttribute('AverageBpm')) || null;
    const duration = parseFloat(trackNode.getAttribute('TotalTime')) || null;
    const tempo = trackNode.querySelector('TEMPO');
    const inizio = tempo ? parseFloat(tempo.getAttribute('Inizio')) : NaN;
    // If the track is already in OUR library, point to it
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
  // 2) Playlist tree: Type 1 = playlist, Type 0 = folder (the path
  // becomes "Folder / Playlist" so none of the organization is lost)
  const found = [];
  const walkNode = (node, prefix) => {
    for (const child of node.children) {
      if (child.tagName !== 'NODE') continue;
      const nm = child.getAttribute('Name') || t('rekordbox_untitled_node');
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
    flashStatus(t('rekordbox_import_no_local'));
    return;
  }
  // 3) Merge: a playlist with the same name is UPDATED, not duplicated
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
  const skipMsg = skippedNoFile ? t('skip_streaming_tracks', { n: skippedNoFile }) : '';
  flashStatus(t('rekordbox_imported', { created, updated, skip: skipMsg }));
}
document.getElementById('btn-pl-import').addEventListener('click', importRekordboxXml);
btnPlPlay.addEventListener('click', () => {
  const p = library.plOpen;
  if (!p || !p.tracks.length) return;
  const i = activeDeck;
  deckQueues[i] = p.tracks.slice(1).map(t => ({ ...t }));
  updateQueueUI(i);
  loadTrackToDeck(i, { ...p.tracks[0] }, true);
  flashStatus(t('playlist_first_track_queue', { name: p.name, n: i + 1, count: p.tracks.length - 1 }));
});

// Downloads a playlist's SoundCloud tracks to disk (Music/TurboMix)
async function ensureLocalCopy(ref) {
  if (!ref || !ref.sc || !ref.scId) return;
  // The track's original account goes with the request (private/Go+)
  const r = await window.api.scDownloadTo(ref.scId, ref.name, ref.acctIdx);
  if (r.ok) {
    ref.path = r.path;
    library.savePlaylists();
    flashStatus(t('track_downloaded_hard', { name: ref.name }));
  } else {
    flashStatus(t('download_error', { error: r.error }));
  }
}

// --- Right-click menu on a track: add to a playlist, remove… ---
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
    addItem(t('add_to_playlist_label', { name: p.name }), () => {
      const ref = library.addToPlaylist(p, track);
      if (ref) {
        flashStatus(t('added_to_playlist', { track: track.name, playlist: p.name }));
        if (ref.sc && !ref.path) ensureLocalCopy(ref);
      } else {
        flashStatus(t('already_in_playlist'));
      }
    });
  });
  if (library.isTaken(track)) {
    addItem(t('unmark_played_label'), () => {
      library.unmarkPlayed(track);
      markTakenRows();
    });
  }
  addItem(t('clear_played_label'), async () => {
    const ok = await askText(t('clear_played_confirm'), '');
    if (String(ok || '').trim().toUpperCase() !== t('confirm_word')) return;
    library.clearPlayed();
    markTakenRows();
    flashStatus(t('played_cleared'));
  });
  if (track.path && !track.sc) {
    const place = async (destDir) => {
      const r = await window.api.dlPlace(track.path, destDir);
      if (!r.ok) {
        flashStatus(t('dl_place_failed', { error: r.error }));
        return;
      }
      library.relocateTrack(track, r);
      followDeckPath(track.path, r.path);
      flashStatus(t('dl_place_moved', { name: r.name }));
      afterOrganize(false);
    };
    const here = normFsPath(parentDir(track.path));
    // In a subfolder of OpenMix music: MOVE it up one level
    if (inNative(track.path) && !isNativeRoot(parentDir(track.path))) {
      const up = parentDir(parentDir(track.path));
      addItem(t('dl_menu_out', { name: String(parentDir(track.path)).split(/[\\/]/).pop() }), () => place(up));
    }
    if (here !== normFsPath(dlInfo.root)) addItem(t('dl_place_root'), () => place(dlInfo.root));
    dlInfo.folders.filter((f) => normFsPath(f.path) !== here).slice(0, 15).forEach((f) => {
      addItem(t('dl_place_into', { name: f.rel.replace(/\//g, ' › ') }), () => place(f.path));
    });
    addItem(t('dl_place_new'), async () => {
      const r = await dlNewFolder();
      if (r) place(r.path);
    });
    if (inNative(track.path)) {
      addItem(t('dl_menu_rename'), () => renameNative(track.path, false));
      addItem(t('dl_menu_trash'), () => trashNative(track.path, false));
    }
  }
  addItem(t('reanalyze_track_label'), async () => {
    flashStatus(t('reanalyzing_track', { name: track.name }));
    try {
      const res = await library.reanalyze(track);
      // Live-updates the decks playing this track
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
      flashStatus(t('track_reanalyzed', { name: track.name, bpm: res.bpm.toFixed(2) }));
    } catch (err) {
      flashStatus(t('reanalyze_error', { error: err.message || err }));
    }
  });
  addItem(t('add_to_new_playlist_label'), async () => {
    const name = await askText(t('new_playlist_name_prompt'), `Playlist ${library.playlists.length + 1}`);
    if (!name) return;
    const p = library.createPlaylist(name);
    const ref = library.addToPlaylist(p, track);
    if (ref && ref.sc && !ref.path) ensureLocalCopy(ref);
    flashStatus(t('added_to_new_playlist', { track: track.name, playlist: name }));
  });
  if (library.mode === 'pl' && library.plOpen) {
    addItem(t('remove_from_playlist_label'), () => {
      const real = library.plOpen.tracks.indexOf(track);
      if (real >= 0) library.removeFromPlaylist(library.plOpen, real);
    });
  }
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - ctxMenu.childElementCount * 30 - 10)}px`;
  ctxMenu.classList.remove('hidden');
}

async function scLoad() {
  const url = scUrlInput.value.trim();
  if (!url) {
    flashStatus(t('sc_paste_link_hint'));
    return;
  }
  await library.loadScUrl(url);
}

document.getElementById('btn-sc-load').addEventListener('click', scLoad);
scUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') scLoad();
});

// --- SoundCloud account login ---
const btnScLogin = document.getElementById('btn-sc-login');
const btnScMine = document.getElementById('btn-sc-mine');

async function refreshScStatus() {
  const s = await window.api.scStatus();
  const accounts = (s && s.accounts) || [];
  // scBack() needs to know whether an "account list" level exists
  library.scAccountCount = accounts.length;
  btnScMine.classList.toggle('hidden', !s.connected);
  // The SAME button does everything: 1st login, adding a friend's account (b2b),
  // reconnecting an account whose token has expired
  const expired = accounts.find((a) => a.expired);
  btnScLogin.textContent = expired
    ? t('sc_reconnect_account', { name: expired.name || t('sc_reconnect_account_fallback') })
    : accounts.length ? t('sc_add_account') : t('login');
  return s.connected;
}

btnScLogin.addEventListener('click', async () => {
  const r = await window.api.scLogin();
  if (r.ok) {
    flashStatus(t('sc_account_added', { name: r.name || 'SoundCloud' }));
    await refreshScStatus();
    buildTree(); // the SoundCloud node changes shape (👤 nodes per account)
    library.loadScMine(r.index ?? 0);
  } else {
    flashStatus(t('sc_error', { error: r.error }));
  }
});

// "My playlists" goes through openSoundCloud: in b2b it first shows WHO
// (the account list), solo it keeps its direct behavior
btnScMine.addEventListener('click', () => openSoundCloud());
document.getElementById('btn-sc-back').addEventListener('click', () => library.scBack());

refreshScStatus().then((connected) => {
  // If already logged in, the SoundCloud tab will show your playlists right away
  // (or the account list when there are several)
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
  // REQUIRED since the overview signature uses the canvas width:
  // without it, resizing with a paused deck left the waveform at
  // the old size
  invalidateWaves();
});

// ---------------------------------------------------------------------------
// SESSION: on restart, EVERYTHING is back the way it was left (David's
// request: "every time the software is restarted everything is back to 0").
// Tracks come back on their decks PAUSED, at their position, with CUE point,
// tempo, KEY and SYNC; the mixer (volumes, EQ, trim, filters, crossfader,
// master) and the FX settings (effect, duration, assignments) too. The FX
// LEVEL, however, starts from 0 — original rule: never a surprise effect.
// ---------------------------------------------------------------------------
const SESSION_KEY = 'omSession';
let sessionRestoring = false;
// NO saving before the restore is finished: otherwise the empty startup
// state overwrote the session before it was even read back
let sessionReady = false;
let lastSessionJson = '';

function captureSession() {
  return {
    v: 1,
    decks: engine.decks.map((d) => ({
      track: d.track ? library.trackRef(d.track) : null,
      pos: d.buffer ? d.currentTime() : 0,
      cue: d.cuePoint || 0,
      // BASE tempo (without the sync micro-correction)
      tempo: d.synced && d._syncBase ? d._syncBase : (d.tempo || 1) / (1 + (d._pllCorr || 0)),
      key: d.keyShift || 0,
      synced: !!d.synced,
      vol: d.volume,
      eq: { ...d.eq },
      trim: d.trimVal || 0,
      filter: d.filterVal || 0
    })),
    xf: engine.crossfader,
    mvol: engine.masterVolume,
    mfilter: engine.masterFilterVal || 0,
    masterIdx: engine.masterIdx,
    color: { type: engine.colorType, on: engine.colorEnabled },
    fx: engine.fx.map((u) => ({ type: u.type, beats: u.beatsMult })),
    fxAssign: engine.fxAssign.map((a) => a.slice())
  };
}

function saveSession() {
  if (sessionRestoring || !sessionReady) return;
  try {
    const j = JSON.stringify(captureSession());
    if (j !== lastSessionJson) {
      lastSessionJson = j;
      localStorage.setItem(SESSION_KEY, j);
    }
  } catch { /* storage unavailable: too bad for this time */ }
}
setInterval(saveSession, 2000);
window.addEventListener('beforeunload', saveSession);

async function restoreSession() {
  // OPTION (⚙ Behavior), off by default: at launch, empty decks and fresh
  // settings — "on every restart, everything is back to 0"
  // restoreOnce: ONE-TIME restore (restart for an update) — the flag is
  // consumed, the next session does start from scratch
  let once = localStorage.getItem('restoreOnce') === '1';
  if (once) localStorage.removeItem('restoreOnce');
  if (window.api.takeRestoreOnce && (await window.api.takeRestoreOnce().catch(() => false))) once = true;
  if (!once && localStorage.getItem('restoreSession') !== '1') {
    sessionReady = true;
    return;
  }
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* nothing */ }
  if (!s || s.v !== 1 || !Array.isArray(s.decks)) {
    sessionReady = true;
    return;
  }
  sessionRestoring = true;
  try {
    // 1) mixer
    s.decks.forEach((ds, i) => {
      const d = engine.decks[i];
      if (!ds || !d) return;
      if (ds.vol != null) d.setVolume(ds.vol);
      if (ds.eq) for (const b of ['low', 'mid', 'high']) if (ds.eq[b] != null) d.setEq(b, ds.eq[b]);
      if (ds.trim != null) d.setTrim(ds.trim);
      if (ds.filter != null) engine.setDeckColor(i, ds.filter);
    });
    if (s.color) {
      if (s.color.type && s.color.type !== engine.colorType) {
        engine.setColorType(s.color.type);
        if (uiRefs.master.colorSel) uiRefs.master.colorSel.value = s.color.type;
      }
      if (s.color.on != null && s.color.on !== engine.colorEnabled) {
        engine.setColorEnabled(!!s.color.on);
        const b = document.getElementById('color-on');
        if (b) {
          b.textContent = engine.colorEnabled ? 'ON' : 'OFF';
          b.classList.toggle('on', engine.colorEnabled);
        }
      }
    }
    stripUI.forEach((_, i) => refreshStrip(i));
    if (s.xf != null) { engine.setCrossfader(s.xf); if (xfFader) xfFader.update(); }
    if (s.mvol != null) { engine.setMasterVolume(s.mvol); uiRefs.master.volKnob?.update(); }
    if (s.mfilter != null) { engine.setMasterFilter(s.mfilter); uiRefs.master.filterKnob?.update(); }
    engine.masterIdx = s.masterIdx ?? null;
    // 2) FX settings (level at 0, effect off: as at startup)
    (s.fx || []).forEach((f, u) => {
      const unit = engine.fx[u];
      const r = uiRefs.fxUnits[u];
      if (!unit || !f) return;
      if (f.type) { unit.setType(f.type); if (r && r.typeSel) r.typeSel.value = f.type; }
      if (f.beats) { unit.setBeatsMult(f.beats); if (r && r.beatsSel) r.beatsSel.value = String(f.beats); }
    });
    if (Array.isArray(s.fxAssign) && s.fxAssign.length === 4) {
      engine.fxAssign = s.fxAssign.map((a) => [0, 1, 2, 3].map((k) => !!(a && a[k])));
      engine.updateFxSends();
    }
    try { updateFxPanel(); } catch { /* panel not ready yet */ }
    // 3) the tracks, one deck after another, PAUSED at their position
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const ds = s.decks[i];
      if (!ds || !ds.track) continue;
      await loadTrackToDeck(i, ds.track);
      const d = engine.decks[i];
      if (!d.buffer || d.track !== ds.track) continue;
      if (ds.tempo) { d.setTempo(ds.tempo); updateTempoLabel(i); }
      if (ds.key && deckUI[i].applyKey) deckUI[i].applyKey(ds.key - d.keyShift);
      d.cuePoint = ds.cue || 0;
      d.seek(ds.pos || 0);
      d.synced = !!ds.synced;
      // reloaded, not played: it doesn't count as "already played" tonight
      library.unmarkPlayed(ds.track);
      n++;
    }
    markTakenRows();
    if (n) flashStatus(t('session_restored', { n }));
  } catch (err) {
    console.log(`[midi] session: restore interrupted (${err.message || err})`);
  } finally {
    sessionRestoring = false;
    sessionReady = true;
  }
}

library.init().then(() => {
  if (library.cache.__scUrl) scUrlInput.value = library.cache.__scUrl;
  restoreSession();
}).catch(() => { sessionReady = true; });


requestAnimationFrame(frame);
