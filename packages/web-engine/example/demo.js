// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// The example app: four decks, a mixer, beat FX, pad FX and output routing,
// built on the PUBLIC API of @openmix/web-engine only (DESIGN §5, §11.2).
//
// Rendering rules:
// - Everything visual is refreshed from engine.on('tick') (auto-tick: once
//   per animation frame).
// - The DOM is written only when a value changes (see setText & co.).
// - No layout reads in the frame loop. drawZoom()/drawOverview() size their
//   canvas from its CSS box, so every canvas is drawn FIRST in a frame, before
//   any DOM write: their size read never forces a synchronous layout.
//
// ?silent=1 starts with the master and headphone volumes at 0 (smoke tests).
// The engine is also exposed as `window.engine` for console experiments.

import {
  createEngine,
  drawZoom,
  drawOverview,
  keyName,
  camelotLabel,
  FX_TYPES,
  COLOR_FX_TYPES,
  FX_BEATS,
  DEFAULT_PAD_FX,
  HOT_CUE_COLORS,
  VERSION
} from '../src/index.js';
import { DEMO_TRACKS, renderDemoTrack } from './synth.js';

// ------------------------------------------------------------- settings ----

const DECK_COLORS = ['#39c2ff', '#ff9f43', '#5fe08a', '#ff6b9d']; // the OpenMix deck palette
const SILENT = new URLSearchParams(location.search).get('silent') === '1';
const TEMPO_RANGE = 0.08;     // tempo slider: ±8 %
const HOT_CUE_PADS = 4;
const LOOP_SIZES = [0.5, 1, 2, 4, 8];
const JUMP_BEATS = 4;
const BEND = 0.04;            // pitch bend while ◀ / ▶ is held (±0.06 is a full jog deflection)
const ZOOM_SECONDS = 8;       // zoom window = 8 s × baseTempo: equal beat widths at equal BPM
const METER_FLOOR_DB = -48;
const METER_CEIL_DB = 6;
const METER_FALL = 1.5;       // meter fall-back, in full scales per second
const LOG_LINES = 200;

// ------------------------------------------------------------ DOM helpers ----

const $ = (id) => document.getElementById(id);

/**
 * Creates an element. Props: class, text, style (object of properties, custom
 * properties allowed), on<event> listeners, anything else as an attribute.
 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style') for (const p of Object.keys(value)) el.style.setProperty(p, value[p]);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
  return el;
}

// Memoized DOM writes: the last written value is kept per element, so the
// frame loop touches the DOM only when something actually changed.
const written = new WeakMap();
function memo(el) {
  let m = written.get(el);
  if (!m) {
    m = Object.create(null);
    written.set(el, m);
  }
  return m;
}
function setText(el, text) {
  const m = memo(el);
  if (m.text !== text) {
    m.text = text;
    el.textContent = text;
  }
}
function setClass(el, name, on) {
  const m = memo(el);
  const key = `class:${name}`;
  if (m[key] !== on) {
    m[key] = on;
    el.classList.toggle(name, on);
  }
}
/** Lit state of a toggle button (class 'on' + aria-pressed). */
function setOn(el, on) {
  const m = memo(el);
  if (m.on !== on) {
    m.on = on;
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
function setHidden(el, hidden) {
  const m = memo(el);
  if (m.hidden !== hidden) {
    m.hidden = hidden;
    el.hidden = hidden;
  }
}
function setDisabled(el, disabled) {
  const m = memo(el);
  if (m.disabled !== disabled) {
    m.disabled = disabled;
    el.disabled = disabled;
  }
}
function setStyle(el, property, value) {
  const m = memo(el);
  const key = `style:${property}`;
  if (m[key] !== value) {
    m[key] = value;
    el.style.setProperty(property, value);
  }
}

// ---------------------------------------------------------------- widgets ----

function button(label, { cls = '', ...props } = {}) {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), ...props }, label);
}

/** A toggle button: its lit state is written by the frame loop (setOn). */
function toggle(label, props, onClick) {
  const b = button(label, { ...props, 'aria-pressed': 'false' });
  memo(b).on = false;
  b.addEventListener('click', onClick);
  return b;
}

/** Momentary control: onDown while held (pointer, Space or Enter), onUp on release. */
function holdable(el, onDown, onUp) {
  let held = false;
  const down = (e) => {
    if (held) return;
    held = true;
    el.classList.add('held');
    onDown(e);
  };
  const up = (e) => {
    if (!held) return;
    held = false;
    el.classList.remove('held');
    onUp(e);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no focus steal or text selection while holding
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // not capturable (synthetic event): the release still arrives on el
    }
    down(e);
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('blur', up);
  el.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      down(e);
    }
  });
  el.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      up(e);
    }
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return el;
}

/**
 * Rotary knob (role="slider"): drag up/down (Shift = fine), arrow keys,
 * PageUp/PageDown, Home/End, double-click or Delete to reset.
 */
function knob({ label, title = label, min = -1, max = 1, value = 0, reset = 0, color = null, format = null, onInput }) {
  const bipolar = min < 0 && max > 0;
  const el = h('div', {
    class: bipolar ? 'knob bipolar' : 'knob',
    role: 'slider',
    tabindex: '0',
    'aria-label': title,
    'aria-valuemin': min,
    'aria-valuemax': max,
    title: `${title} (drag up or down; double-click to reset)`,
    style: color ? { '--kc': color } : null
  }, h('span', { class: 'dial', 'aria-hidden': 'true' }), h('span', { class: 'knob-label', text: label }));
  let v = Math.min(max, Math.max(min, value));
  const render = () => {
    const angle = -135 + (270 * (v - min)) / (max - min);
    el.style.setProperty('--angle', angle.toFixed(1));
    el.style.setProperty('--from', (bipolar ? Math.min(0, angle) : -135).toFixed(1));
    el.style.setProperty('--len', (bipolar ? Math.abs(angle) : angle + 135).toFixed(1));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100) / 100));
    el.setAttribute('aria-valuetext', format ? format(v) : v.toFixed(2));
  };
  const set = (next, emit) => {
    const n = Math.min(max, Math.max(min, Math.round(next * 1000) / 1000));
    if (!Number.isFinite(n) || n === v) return;
    v = n;
    render();
    if (emit) onInput(v);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic event
    }
    const y0 = e.clientY;
    const v0 = v;
    const move = (ev) => set(v0 + ((y0 - ev.clientY) / (ev.shiftKey ? 800 : 180)) * (max - min), true);
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  el.addEventListener('dblclick', () => set(reset, true));
  el.addEventListener('keydown', (e) => {
    const fine = (max - min) / 100;
    const coarse = (max - min) / 10;
    const steps = { ArrowUp: fine, ArrowRight: fine, ArrowDown: -fine, ArrowLeft: -fine, PageUp: coarse, PageDown: -coarse };
    let next = null;
    if (Object.prototype.hasOwnProperty.call(steps, e.key)) next = v + steps[e.key];
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Delete' || e.key === 'Backspace') next = reset;
    if (next == null) return;
    e.preventDefault();
    set(next, true);
  });
  render();
  return { el, set: (n) => set(n, false) };
}

function select(options, value, onChange, props = {}) {
  const el = h('select', props, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** Peak meter: a static gradient uncovered from the bottom by a scaled mask. */
function meter() {
  const mask = h('i');
  const el = h('div', { class: 'vu', 'aria-hidden': 'true' }, mask);
  return { el, mask, level: 0, clipUntil: 0 };
}

function updateMeter(m, peak, dt, now) {
  let target = 0;
  if (peak > 0) target = (20 * Math.log10(peak) - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  target = Math.min(1, Math.max(0, target));
  m.level = target >= m.level ? target : Math.max(target, m.level - METER_FALL * dt);
  const q = Math.round(m.level * 64) / 64;
  setStyle(m.mask, 'transform', `scaleY(${(1 - q).toFixed(3)})`);
  if (peak >= 1) m.clipUntil = now + 0.6;
  setClass(m.el, 'clip', now < m.clipUntil);
}

/** Brief red flash on a control whose action was refused (returned false). */
function flash(el) {
  if (typeof el.animate === 'function') {
    el.animate([{ boxShadow: '0 0 0 2px #ff4d5e' }, { boxShadow: '0 0 0 0 rgba(255, 77, 94, 0)' }], { duration: 350 });
  }
}

// ------------------------------------------------------------- formatting ----

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const tenths = Math.floor(Math.abs(seconds) * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${seconds < 0 ? '−' : ''}${m}:${s < 10 ? '0' : ''}${s}.${tenths % 10}`;
}
const fmtBpm = (bpm) => (typeof bpm === 'number' && Number.isFinite(bpm) ? bpm.toFixed(2) : '—');
function fmtPercent(ratio) {
  const p = (ratio - 1) * 100;
  if (Math.abs(p) < 0.005) return '±0.00%';
  return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`;
}
const fmtShift = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const fmtKey = (code) => (code == null ? '—' : `${keyName(code)} · ${camelotLabel(code)}`);
function fmtHeard(heard) {
  if (!heard) return '—';
  const c = heard.cents;
  return `${keyName(heard.code)} · ${camelotLabel(heard.code)}${c ? ` ${c > 0 ? '+' : '−'}${Math.abs(c)}¢` : ''}`;
}
const BEAT_LABELS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
const beatLabel = (b) => BEAT_LABELS[b] || String(b);
const pct = (v) => `${Math.round(v * 100)} %`;
const eqFormat = (v) => (v <= -0.995 ? 'kill (−40 dB)' : `${v < 0 ? '−' : '+'}${Math.abs(v < 0 ? v * 40 : v * 6).toFixed(1)} dB`);
const trimFormat = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v * 12.04).toFixed(1)} dB`;
function filterFormat(v) {
  if (Math.abs(v) < 0.04) return 'off';
  return v > 0 ? `high-pass ${Math.round(20 * Math.pow(400, v))} Hz` : `low-pass ${Math.round(20000 * Math.pow(80 / 20000, -v))} Hz`;
}
const errorText = (e) => (e && e.message ? e.message : String(e));

// ------------------------------------------------------------- page state ----

let engine = null;
const views = [];        // one per deck
const strips = [];       // mixer channel strips
const fxViews = [];      // beat-FX unit panels
const header = {};
const mixerUi = {};
const demoBuffers = new Map(); // preset id → Promise<AudioBuffer> (synthesized once)
const analyses = new Map();    // preset id → analysis of its first load (reused by later loads)

function notice(text, kind = 'error') {
  const el = $('notice');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
}

function log(message) {
  const pre = $('log');
  if (!pre) return;
  const time = new Date().toTimeString().slice(0, 8);
  pre.append(`${time}  ${message}\n`);
  while (pre.childNodes.length > LOG_LINES) pre.firstChild.remove();
}

function reportError(error) {
  console.error(error);
  log(`Error: ${errorText(error)}`);
}

// -------------------------------------------------------------------- boot ----

async function boot() {
  // index.html explains how to serve the page; nothing can work from file://
  if (location.protocol === 'file:') return;
  log(`@openmix/web-engine ${VERSION} demo${SILENT ? ' (silent mode)' : ''}`);
  engine = await createEngine({ log, onError: reportError });
  globalThis.engine = engine;
  if (SILENT) {
    engine.setMasterVolume(0);
    engine.setHeadphoneVolume(0);
  }
  buildHeader();
  buildDecks();
  buildMixer();
  buildFx();
  buildOutputs();
  watchCanvasSizes();
  engine.on('statechange', updateContextInfo);
  engine.on('master', ({ index, manual }) => {
    log(index == null ? 'No master deck' : `Master: deck ${index + 1}${manual ? ' (manual)' : ''}`);
  });
  engine.on('tick', frame);
  document.body.classList.add('ready');
  globalThis.__demoReady = true;
  log(`Engine ready: ${engine.decks.length} decks, ${engine.fx.length} FX units, keylock engine: ${engine.pitchEngine}`
    + (engine.pitchEngineError ? ` (${errorText(engine.pitchEngineError)})` : ''));
  log('Tip: the engine is available as `engine` in the browser console.');
}

// ------------------------------------------------------------------ header ----

function buildHeader() {
  header.state = $('st-state');
  header.rate = $('st-rate');
  header.latency = $('st-latency');
  header.pitch = $('st-pitch');
  header.phones = $('st-phones');
  header.master = $('st-master');
  header.start = $('btn-start');
  setText($('version'), `v${VERSION}`);
  setHidden($('silent-badge'), !SILENT);

  header.start.disabled = false;
  header.start.addEventListener('click', async () => {
    try {
      await engine.resume(); // autoplay policy: needs this user gesture
    } catch (e) {
      reportError(e);
    }
    updateContextInfo();
  });

  const demoSet = $('btn-demo-set');
  demoSet.disabled = false;
  demoSet.addEventListener('click', async () => {
    engine.resume().catch(reportError);
    demoSet.disabled = true;
    try {
      await loadDemo(views[0], DEMO_TRACKS[0]);
      if (views[1]) await loadDemo(views[1], DEMO_TRACKS[1]);
    } finally {
      demoSet.disabled = false;
    }
  });

  setText(header.rate, `${(engine.context.sampleRate / 1000).toFixed(1)} kHz`);
  const pe = engine.pitchEngine;
  setText(header.pitch, pe === 'wsola' ? 'WSOLA worklet' : pe === 'fallback' ? 'fallback shifter' : pe);
  setClass(header.pitch, 'ok', pe === 'wsola');
  setClass(header.pitch, 'warn', pe !== 'wsola');
  if (engine.pitchEngineError) header.pitch.title = errorText(engine.pitchEngineError);
  else if (pe === 'fallback') header.pitch.title = 'The WSOLA worklet is off (keylock: false)';
  updateContextInfo();
}

function updateContextInfo() {
  if (!engine) return;
  const ctx = engine.context;
  const running = ctx.state === 'running';
  setText(header.state, ctx.state);
  setClass(header.state, 'ok', running);
  setClass(header.state, 'warn', !running);
  setText(header.start, running ? 'Audio on' : 'Start audio');
  setDisabled(header.start, running);
  const ms = (s) => (typeof s === 'number' && Number.isFinite(s) ? `${(s * 1000).toFixed(1)} ms` : 'n/a');
  setText(header.latency, `base ${ms(ctx.baseLatency)} · out ${ms(ctx.outputLatency)}`);
}

// ------------------------------------------------------------------- decks ----

function buildDecks() {
  const waves = $('waves');
  engine.decks.forEach((deck, i) => {
    const v = buildDeck(deck, i);
    views.push(v);
    waves.append(v.waveRow);
    ($(`deck-slot-${i}`) || $('decks-area')).append(v.panel);
  });
}

function buildDeck(deck, i) {
  const n = i + 1;
  const color = DECK_COLORS[i % DECK_COLORS.length];
  const v = { deck, i, color, dirty: true, lastPos: NaN, lastWindow: NaN, loadToken: 0, tempoDrag: false };
  v.panel = h('section', { class: 'deck', style: { '--deck': color }, 'aria-label': `Deck ${n}` });

  // ---- zoomed waveform row (stacked at the top of the page, like OpenMix) ----
  v.zoom = h('canvas', { class: 'zoom', role: 'img', 'aria-label': `Deck ${n} waveform. Drag to scratch.` });
  v.waveBpm = h('span', { class: 'wave-bpm', text: '—' });
  v.waveRow = h('div', { class: 'wave-row', style: { '--deck': color } },
    h('div', { class: 'wave-tag' }, h('b', { text: String(n) }), v.waveBpm),
    h('div', { class: 'zoom-wrap' }, v.zoom));
  bindScratch(v);

  // ---- readouts ----
  v.title = h('div', { class: 'deck-title', text: 'Empty deck' });
  v.badge = h('span', { class: 'badge-master', text: 'MASTER', hidden: true });
  v.bpm = h('span', { class: 'bpm', text: '—' });
  v.tempoText = h('span', { class: 'tempo-text', text: '±0.00%' });
  v.lat = h('span', { class: 'lat', title: 'Keylock latency, compensated by read-ahead' });
  v.key = h('span', { class: 'key', text: '—' });
  v.heard = h('span', { class: 'heard', text: '—' });
  v.time = h('span', { class: 'time', text: '0:00.0' });
  v.remain = h('span', { class: 'remain', text: '−0:00.0' });
  v.overview = h('canvas', { class: 'overview', role: 'img', 'aria-label': `Deck ${n} track overview. Click to seek.` });
  v.status = h('div', { class: 'deck-status', role: 'status', 'aria-live': 'polite', text: 'Drop an audio file here or pick a demo track.' });
  bindSeek(v);

  // ---- loading ----
  const fileInput = h('input', { type: 'file', class: 'visually-hidden', accept: 'audio/*,.mp3,.wav,.ogg,.oga,.flac,.m4a,.aac,.opus,.webm' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) loadFile(v, file);
    fileInput.value = '';
  });
  const fileButton = h('label', { class: 'btn file-btn', title: 'Load an audio file from your computer' }, 'Load file…', fileInput);
  const demoSelect = select(
    [['', 'Demo track…'], ...DEMO_TRACKS.map((p) => [p.id, p.title])],
    '',
    (id) => {
      demoSelect.value = '';
      const preset = DEMO_TRACKS.find((p) => p.id === id);
      if (preset) loadDemo(v, preset);
    },
    { class: 'demo-select', 'aria-label': `Load a synthesized demo track on deck ${n}` }
  );
  dropTarget(v.panel, v);
  dropTarget(v.waveRow, v);

  // ---- transport, sync, master ----
  v.cueBtn = holdable(button('CUE', { cls: 'big cue', title: 'CUE: at the cue point, hold to preview; elsewhere, set the cue point' }),
    () => deck.cueDown(), () => deck.cueUp());
  v.playBtn = toggle('PLAY', { cls: 'big play', title: 'Play / pause' }, () => deck.togglePlay());
  v.syncBtn = toggle('SYNC', { cls: 'sync', title: 'Match the master tempo and align the bars, then hold the phase' }, () => onSync(v));
  v.masterBtn = toggle('MASTER', { cls: 'master', title: 'Make this deck the tempo master (click again: automatic master)' },
    () => engine.setMaster(engine.manualMasterIndex === i ? null : i));

  // ---- key ----
  v.keylockBtn = toggle('KEYLOCK', { cls: 'keylock', title: 'Keylock: keep the key when the tempo changes' }, () => deck.setKeylock(!deck.keylock));
  v.keyShift = button('0', { cls: 'key-shift', title: 'Key shift in semitones (click to reset)', 'aria-label': 'Key shift, click to reset' });
  v.keyShift.addEventListener('click', () => deck.setKey(0));
  const keyDown = button('KEY −', { title: 'Transpose one semitone down', 'aria-label': 'Key down one semitone' });
  keyDown.addEventListener('click', () => deck.setKey(deck.keyShift - 1));
  const keyUp = button('KEY +', { title: 'Transpose one semitone up', 'aria-label': 'Key up one semitone' });
  keyUp.addEventListener('click', () => deck.setKey(deck.keyShift + 1));
  v.qBtn = toggle('Q', { cls: 'quantize', title: 'Quantize: snap hot cues and loops to the beat grid' }, () => { deck.quantize = !deck.quantize; });

  // ---- tempo (±8 %) and pitch bend ----
  v.tempo = h('input', {
    type: 'range', class: 'tempo', min: 1 - TEMPO_RANGE, max: 1 + TEMPO_RANGE, step: 0.0005, value: 1,
    'aria-label': `Deck ${n} tempo, plus or minus 8 percent`, title: 'Tempo ±8 % (double-click to reset)'
  });
  v.tempo.addEventListener('input', () => deck.setTempo(Number(v.tempo.value)));
  v.tempo.addEventListener('pointerdown', () => { v.tempoDrag = true; });
  for (const type of ['pointerup', 'pointercancel', 'change', 'blur']) v.tempo.addEventListener(type, () => { v.tempoDrag = false; });
  v.tempo.addEventListener('dblclick', () => deck.setTempo(1));
  const bend = (label, amount, aria) => {
    const b = button(label, { cls: 'bend', title: `${aria} while held`, 'aria-label': aria });
    let bent = false;
    return holdable(b, () => {
      bent = deck.nudge(amount);
      if (!bent) flash(b);
    }, () => {
      if (bent) deck.endNudge();
      bent = false;
    });
  };

  // ---- hot cues, loops, beat jumps ----
  v.cuePads = [];
  for (let s = 0; s < Math.min(HOT_CUE_PADS, deck.hotCues.length); s++) {
    const pad = button(String(s + 1), {
      cls: 'hotcue',
      style: { '--hc': HOT_CUE_COLORS[s % HOT_CUE_COLORS.length] },
      title: `Hot cue ${s + 1}: click to set or jump; Shift- or Alt-click to clear`,
      'aria-label': `Hot cue ${s + 1}`
    });
    pad.addEventListener('click', (e) => {
      if (e.shiftKey || e.altKey) deck.clearHotCue(s);
      else if (!deck.hotCue(s)) flash(pad);
    });
    v.cuePads.push(pad);
  }
  v.loopPads = LOOP_SIZES.map((beats) => {
    const pad = toggle(beatLabel(beats), { cls: 'loop', title: `${beatLabel(beats)}-beat loop`, 'aria-label': `${beatLabel(beats)} beat loop` },
      () => { if (!deck.beatLoop(beats)) flash(pad); });
    return [beats, pad];
  });
  v.exitBtn = button('EXIT', { title: 'Exit the loop' });
  v.exitBtn.addEventListener('click', () => deck.exitLoop());
  const reloop = button('RELOOP', { title: 'Re-activate the last loop' });
  reloop.addEventListener('click', () => { if (!deck.reloop()) flash(reloop); });
  v.inBtn = toggle('IN', { cls: 'loop-in', title: 'Loop in: store the IN point' }, () => { if (!deck.loopIn()) flash(v.inBtn); });
  const outBtn = button('OUT', { title: 'Loop out: close the loop at the current position' });
  outBtn.addEventListener('click', () => { if (!deck.loopOut()) flash(outBtn); });
  const jump = (label, beats) => {
    const b = button(label, { cls: 'jump', title: `Beat jump ${beats > 0 ? '+' : '−'}${Math.abs(beats)} beats` });
    b.addEventListener('click', () => { if (!deck.beatJump(beats)) flash(b); });
    return b;
  };

  // ---- panel ----
  v.panel.append(
    h('div', { class: 'deck-head' }, h('span', { class: 'deck-num', text: String(n) }), v.title, v.badge, v.masterBtn),
    h('div', { class: 'readouts' },
      h('div', { class: 'ro-bpm' }, v.bpm, h('small', { text: 'BPM' })),
      h('div', { class: 'ro-tempo' }, v.tempoText, v.lat),
      h('div', { class: 'ro-key' },
        h('span', { class: 'ro-label', text: 'KEY' }), v.key,
        h('span', { class: 'ro-label', text: 'HEARD' }), v.heard),
      h('div', { class: 'ro-time' }, v.time, v.remain)),
    h('div', { class: 'overview-wrap' }, v.overview),
    h('div', { class: 'row' }, fileButton, demoSelect),
    h('div', { class: 'row' }, v.cueBtn, v.playBtn, v.syncBtn, h('span', { class: 'sep' }), v.keylockBtn, keyDown, v.keyShift, keyUp, v.qBtn),
    h('div', { class: 'row' }, h('span', { class: 'row-label', text: 'TEMPO' }), bend('◀', -BEND, 'Pitch bend down'), v.tempo,
      bend('▶', BEND, 'Pitch bend up')),
    h('div', { class: 'row' }, h('span', { class: 'row-label', text: 'HOT CUE' }), v.cuePads, h('span', { class: 'sep' }),
      jump(`◀ ${JUMP_BEATS}`, -JUMP_BEATS), jump(`${JUMP_BEATS} ▶`, JUMP_BEATS)),
    h('div', { class: 'row' }, h('span', { class: 'row-label', text: 'LOOP' }), v.loopPads.map(([, pad]) => pad), v.exitBtn,
      h('span', { class: 'sep' }), v.inBtn, outBtn, reloop),
    v.status
  );

  // ---- events: redraw the canvases when the track, grid, cues or loop change ----
  deck.on('load', ({ track }) => {
    const title = track && typeof track.title === 'string' ? track.title : 'Untitled';
    setText(v.title, title);
    v.title.title = title;
    v.dirty = true;
  });
  deck.on('eject', () => {
    setText(v.title, 'Empty deck');
    v.title.title = '';
    v.dirty = true;
  });
  for (const type of ['hotcue', 'loop', 'cuepoint', 'grid']) deck.on(type, () => { v.dirty = true; });
  deck.on('ended', () => setStatus(v, 'End of the track.'));
  return v;
}

function setStatus(v, text, isError = false) {
  setText(v.status, text);
  setClass(v.status, 'error', isError);
}

function onSync(v) {
  const deck = v.deck;
  if (deck.synced) {
    deck.unsync();
    return;
  }
  const result = deck.sync();
  if (result === null) {
    flash(v.syncBtn);
    setStatus(v, 'SYNC needs a BPM: load a track with a detectable beat.', true);
  } else if (result === 'armed') {
    setStatus(v, 'SYNC armed: the deck locks on as soon as another deck plays.');
  } else if (result === 'master') {
    setStatus(v, 'SYNC on: this deck is the master, synced decks follow it.');
  } else {
    setStatus(v, 'Synced: tempo matched and bars aligned.');
  }
}

/** Overview: click to seek; drag and release to seek where the pointer ends. */
function bindSeek(v) {
  let downX = null;
  const seekAt = (e) => {
    const deck = v.deck;
    if (!deck.loaded) return;
    const r = v.overview.getBoundingClientRect(); // event handler, not the frame loop
    if (!r.width) return;
    deck.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * deck.duration);
  };
  v.overview.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try {
      v.overview.setPointerCapture(e.pointerId);
    } catch {
      // synthetic event
    }
    downX = e.clientX;
    seekAt(e);
  });
  v.overview.addEventListener('pointerup', (e) => {
    if (e.button === 0 && downX != null && Math.abs(e.clientX - downX) > 2) seekAt(e);
    downX = null;
  });
  v.overview.addEventListener('pointercancel', () => { downX = null; });
}

/**
 * Zoomed waveform: drag to scratch (scrubStart / scrubMove / scrubEnd). The
 * scratch starts once the pointer really moves, so a plain click does not
 * pause a playing deck.
 */
function bindScratch(v) {
  let press = null;
  v.zoom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !v.deck.loaded) return;
    const r = v.zoom.getBoundingClientRect(); // event handler, not the frame loop
    if (!r.width) return;
    e.preventDefault();
    try {
      v.zoom.setPointerCapture(e.pointerId);
    } catch {
      // synthetic event
    }
    press = { x: e.clientX, width: r.width, scratch: null };
  });
  v.zoom.addEventListener('pointermove', (e) => {
    if (!press) return;
    const deck = v.deck;
    if (!press.scratch) {
      if (Math.abs(e.clientX - press.x) < 3) return;
      press.scratch = { x0: e.clientX, t0: deck.position, secondsPerPixel: (ZOOM_SECONDS * deck.baseTempo) / press.width };
      deck.scrubStart();
    }
    // Dragging the waveform to the right moves back in time, like a record
    deck.scrubMove(press.scratch.t0 - (e.clientX - press.scratch.x0) * press.scratch.secondsPerPixel);
  });
  const end = () => {
    if (!press) return;
    const scratching = !!press.scratch;
    press = null;
    if (scratching) v.deck.scrubEnd();
  };
  v.zoom.addEventListener('pointerup', end);
  v.zoom.addEventListener('pointercancel', end);
  v.zoom.addEventListener('lostpointercapture', end);
}

// ---------------------------------------------------------------- loading ----

function acceptsFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
}

function dropTarget(el, v) {
  el.addEventListener('dragenter', (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    setClass(el, 'drop', true);
  });
  el.addEventListener('dragover', (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !el.contains(e.relatedTarget)) setClass(el, 'drop', false);
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    setClass(el, 'drop', false);
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(v, file);
  });
}

function loadFile(v, file) {
  const title = file.name.replace(/\.[^.]+$/, '') || file.name;
  return loadSource(v, file, { title });
}

/** Synthesizes a preset once (OfflineAudioContext), then loads it like any source. */
async function loadDemo(v, preset) {
  const token = ++v.loadToken;
  setStatus(v, `Synthesizing “${preset.title}”…`);
  let buffer;
  try {
    let pending = demoBuffers.get(preset.id);
    if (!pending) {
      pending = renderDemoTrack(preset, { sampleRate: engine.context.sampleRate });
      demoBuffers.set(preset.id, pending);
      pending.catch(() => demoBuffers.delete(preset.id));
    }
    buffer = await pending;
  } catch (e) {
    if (token === v.loadToken) setStatus(v, `Could not synthesize the track: ${errorText(e)}`, true);
    return;
  }
  if (token !== v.loadToken) return; // another load started on this deck meanwhile
  await loadSource(v, buffer, { title: preset.title, cacheKey: preset.id });
}

/**
 * deck.loadFrom(): decode + analysis (BPM/grid, key, peaks) + load. A demo
 * track loaded again reuses its first analysis through the load options.
 */
async function loadSource(v, source, { title, cacheKey = null }) {
  const token = ++v.loadToken;
  const cached = cacheKey ? analyses.get(cacheKey) : null;
  const options = { track: { title } };
  if (cached) {
    if (cached.bpm != null) options.bpm = cached.bpm;
    if (cached.beats) options.beats = cached.beats.slice();
    if (cached.beatOffset != null) options.beatOffset = cached.beatOffset;
    options.barAnchor = cached.barAnchor;
    if (cached.musicKey != null) options.musicKey = cached.musicKey;
    if (cached.peaks) options.peaks = cached.peaks;
  }
  setStatus(v, cached ? `Loading “${title}”…` : `Analyzing “${title}” (BPM, grid, key, waveform)…`);
  try {
    const result = await v.deck.loadFrom(source, options);
    if (cacheKey && !cached) analyses.set(cacheKey, result);
    // A grid passed in by the caller is not re-analyzed: keep the first verdict
    if (token === v.loadToken) setStatus(v, describeLoad(cached ? { ...result, rigid: cached.rigid } : result));
  } catch (e) {
    if (e && e.name === 'AbortError') return; // replaced by a newer load on this deck
    if (token === v.loadToken) setStatus(v, `Could not load “${title}”: ${errorText(e)}`, true);
  }
}

function describeLoad(result) {
  const parts = [];
  parts.push(result.bpm != null ? `${result.bpm.toFixed(2)} BPM${result.rigid ? ' (rigid grid)' : ''}` : 'no beat found');
  parts.push(result.musicKey != null ? `key ${keyName(result.musicKey)} (${camelotLabel(result.musicKey)})` : 'key unknown');
  if (result.buffer) parts.push(fmtTime(result.buffer.duration));
  return `Loaded: ${parts.join(' · ')}`;
}

// ------------------------------------------------------------------- mixer ----

function buildMixer() {
  const mixer = $('mixer');
  const row = h('div', { class: 'strips' });
  engine.decks.forEach((deck, i) => row.append(buildStrip(deck, i)));

  const xfader = h('input', {
    type: 'range', class: 'xfader', min: 0, max: 1, step: 0.001, value: engine.crossfader,
    'aria-label': 'Crossfader: left plays side A, right plays side B', title: 'Crossfader (double-click to center)'
  });
  xfader.addEventListener('input', () => engine.setCrossfader(Number(xfader.value)));
  xfader.addEventListener('dblclick', () => {
    xfader.value = '0.5';
    engine.setCrossfader(0.5);
  });

  const masterVolume = knob({
    label: 'MASTER', title: 'Master volume', min: 0, max: 1, value: engine.masterVolume, reset: 0.9,
    color: '#dde2ee', format: pct, onInput: (x) => engine.setMasterVolume(x)
  });
  const masterFilter = knob({
    label: 'FILTER', title: 'Master filter', value: engine.masterFilter, reset: 0,
    color: '#dde2ee', format: filterFormat, onInput: (x) => engine.setMasterFilter(x)
  });
  const phones = knob({
    label: 'PHONES', title: 'Headphone (cue) volume', min: 0, max: 1, value: engine.headphoneVolume, reset: 1,
    color: '#dde2ee', format: pct, onInput: (x) => engine.setHeadphoneVolume(x)
  });
  mixerUi.masterMeter = meter();
  const colorFx = select(COLOR_FX_TYPES.map((t) => [t.id, t.label]), engine.colorFx, (id) => engine.setColorFx(id),
    { 'aria-label': 'Color FX: what the channel FILTER knobs do' });
  mixerUi.colorOn = toggle('ON', { cls: 'color-on', title: 'Color FX on or off (off: the FILTER knobs do nothing)' },
    () => engine.setColorFxEnabled(!engine.colorFxEnabled));

  mixer.append(
    h('h2', { class: 'panel-title', text: 'MIXER' }),
    row,
    h('div', { class: 'master' },
      h('div', { class: 'xfader-row' }, h('span', { class: 'side-label', text: 'A' }), xfader, h('span', { class: 'side-label', text: 'B' })),
      h('div', { class: 'master-row' }, masterVolume.el, masterFilter.el, phones.el,
        h('div', { class: 'master-meter', title: 'Master peak (pre-limiter)' }, mixerUi.masterMeter.el, h('span', { class: 'knob-label', text: 'OUT' }))),
      h('div', { class: 'color-fx' }, h('span', { class: 'row-label', text: 'COLOR FX' }), colorFx, mixerUi.colorOn))
  );
}

function buildStrip(deck, i) {
  const n = i + 1;
  const color = DECK_COLORS[i % DECK_COLORS.length];
  const k = (label, title, value, onInput, format) => knob({ label, title: `Deck ${n} ${title}`, value, reset: 0, color, format, onInput });
  const trim = k('TRIM', 'trim', deck.trimValue, (x) => deck.setTrim(x), trimFormat);
  const high = k('HI', 'high EQ', deck.eq.high, (x) => deck.setEq('high', x), eqFormat);
  const mid = k('MID', 'mid EQ', deck.eq.mid, (x) => deck.setEq('mid', x), eqFormat);
  const low = k('LOW', 'low EQ', deck.eq.low, (x) => deck.setEq('low', x), eqFormat);
  const filter = k('FILTER', 'filter (color FX)', deck.filterValue, (x) => deck.setFilter(x), filterFormat);
  const pfl = toggle('PFL', { cls: 'pfl', title: `Deck ${n} headphone cue (pre-fader listen)` }, () => deck.setHeadphoneCue(!deck.headphoneCue));
  const fader = h('input', {
    type: 'range', class: 'fader', min: 0, max: 1, step: 0.001, value: deck.volume, orient: 'vertical',
    'aria-label': `Deck ${n} channel fader`
  });
  fader.addEventListener('input', () => deck.setVolume(Number(fader.value)));
  const vu = meter();
  const side = select([['A', 'A'], ['B', 'B'], ['thru', 'THRU']], deck.crossfaderSide, (s) => deck.setCrossfaderSide(s),
    { class: 'side', 'aria-label': `Deck ${n} crossfader side`, title: 'Crossfader side' });
  strips.push({ deck, pfl, vu });
  return h('div', { class: 'strip', style: { '--deck': color } },
    h('div', { class: 'strip-num', text: String(n) }),
    trim.el, high.el, mid.el, low.el, filter.el, pfl,
    h('div', { class: 'fader-row' }, fader, vu.el),
    side);
}

// ---------------------------------------------------------------------- FX ----

function buildFx() {
  const box = $('fx');
  engine.fx.forEach((unit, u) => {
    const n = u + 1;
    const type = select(FX_TYPES.map((t) => [t.id, t.label]), unit.type, (id) => unit.setType(id), { 'aria-label': `FX ${n} type` });
    const beats = select(FX_BEATS.map((b) => [String(b), `${beatLabel(b)} beat${b > 1 ? 's' : ''}`]), String(unit.beats),
      (b) => unit.setBeats(Number(b)), { 'aria-label': `FX ${n} beats` });
    const level = knob({ label: 'LEVEL', title: `FX ${n} level`, min: 0, max: 1, value: unit.level, reset: 0, format: pct, onInput: (x) => unit.setLevel(x) });
    const on = toggle('ON', { cls: 'fx-on', title: `FX ${n} on or off` }, () => {
      const next = !unit.enabled;
      // Units start at level 0 (silent by design): give them an audible level
      if (next && unit.level === 0) {
        unit.setLevel(0.5);
        level.set(0.5);
      }
      unit.setEnabled(next);
    });
    const assign = engine.decks.map((_, d) => toggle(String(d + 1), {
      cls: 'assign', style: { '--deck': DECK_COLORS[d % DECK_COLORS.length] }, title: `Send deck ${d + 1} to FX ${n}`,
      'aria-label': `Deck ${d + 1} to FX ${n}`
    }, () => engine.assignFx(u, d, !engine.isFxAssigned(u, d))));
    const time = h('span', { class: 'fx-time', title: 'Beats × the beat duration followed by the unit' });
    box.append(h('section', { class: 'panel fx-unit', 'aria-label': `Beat FX ${n}` },
      h('div', { class: 'fx-head' }, h('h2', { class: 'panel-title', text: `BEAT FX ${n}` }), time, on),
      h('div', { class: 'fx-body' }, type, beats, level.el),
      h('div', { class: 'row' }, h('span', { class: 'row-label', text: 'DECKS' }), assign)));
    fxViews.push({ unit, u, on, assign, time });
  });
  box.append(buildPadBank());
}

/** The OpenMix pad-FX bank (DEFAULT_PAD_FX): hold a pad to play it on the target deck. */
function buildPadBank() {
  let target = 0;
  const targets = engine.decks.map((_, d) => toggle(String(d + 1), {
    cls: 'assign', style: { '--deck': DECK_COLORS[d % DECK_COLORS.length] }, title: `Pads play on deck ${d + 1}`,
    'aria-label': `Pad FX on deck ${d + 1}`
  }, () => {
    target = d;
    targets.forEach((b, k) => setOn(b, k === d));
  }));
  if (targets.length) setOn(targets[0], true);
  const pads = DEFAULT_PAD_FX.map((preset) => {
    const what = preset.spin ? `turntable ${preset.spin}` : `${preset.type}, ${beatLabel(preset.beats)} beat`;
    const pad = button(preset.label, { cls: 'pad', title: `${preset.label}: ${what}, while held` });
    let deck = null;
    return holdable(pad, () => {
      deck = engine.decks[target];
      if (preset.spin) {
        if (!deck.spinStart(preset.spin)) {
          deck = null;
          flash(pad);
        }
      } else {
        deck.setPadFx(preset);
      }
    }, () => {
      if (!deck) return;
      if (preset.spin) deck.spinEnd();
      else deck.setPadFx(null);
      deck = null;
    });
  });
  return h('section', { class: 'panel pad-bank', 'aria-label': 'Pad FX' },
    h('div', { class: 'fx-head' }, h('h2', { class: 'panel-title', text: 'PAD FX (HOLD)' }),
      h('div', { class: 'row pad-target' }, h('span', { class: 'row-label', text: 'DECK' }), targets)),
    h('div', { class: 'pads-grid' }, pads));
}

// ----------------------------------------------------------------- outputs ----

function buildOutputs() {
  const box = $('outputs');
  const AC = globalThis.AudioContext;
  if (typeof AC !== 'function' || !('setSinkId' in AC.prototype)) {
    box.append(h('p', {
      class: 'dim',
      text: 'This browser cannot choose an output device (no AudioContext.setSinkId): the system default output is used. '
        + 'A 4-channel sound card still gets the headphone cue on channels 3/4.'
    }));
    return;
  }
  const media = navigator.mediaDevices;
  const masterSelect = h('select', { 'aria-label': 'Master output device' });
  const phonesSelect = h('select', { 'aria-label': 'Headphone (cue) output device' });
  const status = h('span', { class: 'dim', role: 'status', 'aria-live': 'polite' });
  const reveal = button('Show device names', {
    title: 'Browsers hide device names until the page may use the microphone. This asks once and stops the stream at once: nothing is recorded.'
  });
  const fill = (sel, options) => {
    const keep = sel.value;
    sel.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
    sel.value = options.some(([value]) => value === keep) ? keep : '';
  };
  const refresh = async () => {
    let outputs = [];
    try {
      outputs = media ? (await media.enumerateDevices()).filter((d) => d.kind === 'audiooutput') : [];
    } catch (e) {
      status.textContent = `Cannot list the devices: ${errorText(e)}`;
    }
    // Without permission, ids and labels are empty: only the default is usable
    const usable = outputs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const named = usable.map((d, k) => [d.deviceId, d.label || `Output device ${k + 1}`]);
    fill(masterSelect, [['', 'System default'], ...named]);
    fill(phonesSelect, [['', 'None (automatic routing)'], ...named]);
    reveal.hidden = !media || (outputs.length > 0 && outputs.every((d) => d.label));
  };
  masterSelect.addEventListener('change', async () => {
    const ok = await engine.setOutputDevice(masterSelect.value);
    status.textContent = ok ? 'Master output changed.' : 'The master output could not be changed.';
  });
  phonesSelect.addEventListener('change', async () => {
    const ok = await engine.setHeadphoneDevice(phonesSelect.value || null);
    status.textContent = ok
      ? (phonesSelect.value ? 'Headphones (cue bus) on the chosen device.' : 'Headphones: automatic routing.')
      : 'The headphone output could not be changed.';
  });
  reveal.addEventListener('click', async () => {
    try {
      const stream = await media.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      status.textContent = 'Permission refused: device names stay hidden.';
    }
    refresh();
  });
  if (media && typeof media.addEventListener === 'function') media.addEventListener('devicechange', refresh);
  box.append(h('div', { class: 'out-grid' },
    h('label', null, h('span', { class: 'row-label', text: 'MASTER' }), masterSelect),
    h('label', null, h('span', { class: 'row-label', text: 'HEADPHONES' }), phonesSelect),
    reveal,
    status));
  refresh();
}

// ------------------------------------------------------------- frame loop ----

function watchCanvasSizes() {
  if (typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver(() => {
    for (const v of views) v.dirty = true;
  });
  for (const v of views) {
    ro.observe(v.zoom);
    ro.observe(v.overview);
  }
}

/** Canvases: redrawn while moving, or when something visible changed. */
function drawDeck(v) {
  const deck = v.deck;
  const pos = deck.displayPosition;
  const windowSeconds = ZOOM_SECONDS * deck.baseTempo;
  if (!(deck.playing || deck.spinning || deck.scrubbing || v.dirty || pos !== v.lastPos || windowSeconds !== v.lastWindow)) return;
  v.dirty = false;
  v.lastPos = pos;
  v.lastWindow = windowSeconds;
  drawZoom(v.zoom, deck, { windowSeconds });
  drawOverview(v.overview, deck);
}

function updateDeck(v) {
  const deck = v.deck;
  const pos = deck.displayPosition;
  const bpm = fmtBpm(deck.effectiveBpm);
  setText(v.bpm, bpm);
  setText(v.waveBpm, bpm);
  setText(v.tempoText, fmtPercent(deck.baseTempo));
  setText(v.lat, deck.latency > 0.0005 ? `+${(deck.latency * 1000).toFixed(1)} ms` : '');
  setText(v.key, fmtKey(deck.musicKey));
  setText(v.heard, fmtHeard(deck.heardKey));
  setText(v.time, deck.loaded ? fmtTime(pos) : '0:00.0');
  setText(v.remain, deck.loaded ? `−${fmtTime(Math.max(0, deck.duration - pos))}` : '−0:00.0');
  setText(v.keyShift, fmtShift(deck.keyShift));
  setOn(v.playBtn, deck.playing);
  setOn(v.syncBtn, deck.synced);
  setOn(v.keylockBtn, deck.keylock);
  setOn(v.qBtn, deck.quantize);
  setOn(v.masterBtn, engine.manualMasterIndex === v.i);
  setHidden(v.badge, !deck.isMaster);
  setClass(v.panel, 'is-master', deck.isMaster);
  setClass(v.waveRow, 'is-master', deck.isMaster);
  const loop = deck.loop;
  for (const [beats, pad] of v.loopPads) setOn(pad, loop.active && loop.beats === beats);
  setOn(v.inBtn, !loop.active && loop.inPoint != null);
  setDisabled(v.exitBtn, !loop.active);
  const cues = deck.hotCues;
  for (let s = 0; s < v.cuePads.length; s++) setClass(v.cuePads[s], 'set', cues[s] != null);
  // The slider follows SYNC and master tempo changes, except while dragged
  if (!v.tempoDrag) {
    const m = memo(v.tempo);
    if (m.value !== deck.baseTempo) {
      m.value = deck.baseTempo;
      v.tempo.value = String(deck.baseTempo);
    }
  }
}

let lastFrame = 0;
let lastSlow = 0;

function frame() {
  if (document.visibilityState === 'hidden') return; // nothing to show
  const now = performance.now() / 1000;
  const dt = lastFrame ? Math.min(0.1, now - lastFrame) : 0;
  lastFrame = now;
  // 1. Canvases first (they read their CSS size; nothing is dirty yet)
  for (const v of views) drawDeck(v);
  // 2. Then the DOM, only where values changed
  for (const v of views) updateDeck(v);
  for (const s of strips) {
    setOn(s.pfl, s.deck.headphoneCue);
    updateMeter(s.vu, s.deck.meterPeak(), dt, now);
  }
  updateMeter(mixerUi.masterMeter, engine.masterPeak(), dt, now);
  setOn(mixerUi.colorOn, engine.colorFxEnabled);
  for (const f of fxViews) {
    setOn(f.on, f.unit.enabled);
    f.assign.forEach((b, d) => setOn(b, engine.isFxAssigned(f.u, d)));
    setText(f.time, `${Math.round(f.unit.beats * f.unit.beatDuration * 1000)} ms`);
  }
  const mi = engine.masterIndex;
  setText(header.master, mi == null ? 'none' : `deck ${mi + 1} · ${fmtBpm(engine.masterBpm)}${engine.manualMasterIndex != null ? ' (manual)' : ''}`);
  setText(header.phones, engine.headphonesAvailable ? 'routed' : 'not routed');
  setClass(header.phones, 'ok', engine.headphonesAvailable);
  if (now - lastSlow > 0.5) {
    lastSlow = now; // outputLatency moves a little; twice a second is plenty
    updateContextInfo();
  }
}

// Files dropped outside a deck must not navigate away from the page
globalThis.addEventListener('dragover', (e) => e.preventDefault());
globalThis.addEventListener('drop', (e) => e.preventDefault());

boot().catch((e) => {
  console.error(e);
  notice(`The demo could not start: ${errorText(e)}`);
});
