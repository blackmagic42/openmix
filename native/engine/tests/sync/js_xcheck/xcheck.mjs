// Cross-check of the sync module (owner: sync): runs the REAL engine.js sync
// code of the Web engine (AudioEngine.prototype sync, syncLock, reanchorSync,
// snapToRef, _followMaster, _updateAutoMaster, _pickBassDeck...) on fake
// decks through a scenario at 60 calls per second, and writes the trace that
// tests/sync/test_sync_js_xcheck.cpp compares with the C++ port, tick by tick.
//   node native/engine/tests/sync/js_xcheck/xcheck.mjs <trace.txt> [scenario.txt]
//   OM_SYNC_JS_TRACE=<trace.txt> om_test_sync sync_js_cross_check
// Every scenario at once (scenario*.txt next to this file, one trace each):
//   node native/engine/tests/sync/js_xcheck/xcheck.mjs --all <dir>
//   OM_SYNC_JS_TRACE=<dir> om_test_sync sync_js_cross_check
// Node >= 22 (engine.js is loaded as an ES module). Nothing else is run: no
// audio, no Electron. SPEC.md §12.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioEngine, setGlobalGridOffset } from '../../../../../src/js/engine.js';

let T = 0;  // seconds; performance.now() and ctx.currentTime both follow it
Object.defineProperty(globalThis, 'performance', { value: { now: () => T * 1000 }, configurable: true, writable: true });

const here = path.dirname(fileURLToPath(import.meta.url));

function parseScenario(text) {
  const tracks = [];
  const events = [];
  for (const l of text.split(/\r?\n/)) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'track') {
      const [, idx, trueBpm, t0, dur, bpmField, noise, seed, barAnchor, fixed] = p;
      const P = 60 / Number(trueBpm);
      let x = Number(seed) || 1;
      const beats = [];
      if (fixed !== '1') {
        for (let k = 0; Number(t0) + k * P <= Number(dur); k++) {
          x = (x * 48271) % 2147483647;  // MINSTD: exact in doubles, same numbers in C++
          const n = Number(noise) > 0 ? (x / 2147483647 * 2 - 1) * Number(noise) : 0;
          beats.push(Number(t0) + k * P + n);
        }
      }
      tracks[Number(idx)] = {
        bpm: Number(bpmField), beatOffset: Number(t0), beats: beats.length > 2 ? beats : null,
        barAnchor: Number(barAnchor), dur: Number(dur),
      };
    } else if (p[0] === 'ev') {
      const tick = Number(p[1]);
      if (p[2] === 'ramp') {
        const f = Math.pow(Number(p[4]), 1 / Number(p[5]));
        for (let i = 0; i < Number(p[5]); i++) events.push({ tick: tick + i, kind: 'tempomul', deck: Number(p[3]), a: f });
      } else {
        events.push({ tick, kind: p[2], deck: Number(p[3]), a: Number(p[4]), b: Number(p[5]) });
      }
    }
  }
  events.sort((x, y) => x.tick - y.tick);  // stable
  return { tracks, events };
}

// engine.js Deck fields used by the sync code; positions advance exactly with the tempo.
function makeDeck(i) {
  return {
    id: i, buffer: null, bpm: null, beatOffset: null, beats: null, gridShift: 0, barAnchor: 0, tempo: 1,
    playing: false, startCtx: 0, synced: false, volume: 0.85, eq: { low: 0, mid: 0, high: 0 },
    _syncBase: null, _syncRef: null, _syncWant: null, _pllCorr: 0, _syncPhaseOff: 0, _phaseFree: false,
    _ratioCal: false, _ratioMeas: null, _ratioPasses: 0, _ratioTries: 0, _errFilt: 0,
    _routeW: false, _endedAt: 0, _roll: null, _padRoll: null, pos: 0, dur: 0,
    get duration() { return this.buffer ? this.dur : 0; },
    currentTime() { return this.buffer ? this.pos : 0; },
    setTempo(r) {
      r = Math.min(1.6, Math.max(0.5, r));
      this.tempo = r;
      if (this._onTempo) this._onTempo(this);
    },
    seek(t) {
      if (!this.buffer) return;
      this.pos = Math.min(this.dur, Math.max(-3600, t));
    },
    startRoll() { return false; },
    setRollMix() {},
    stopRoll() { this._roll = null; },
  };
}

function runScenario(text) {
  const { tracks, events } = parseScenario(text);
  T = 0;
  setGlobalGridOffset(0);  // module-level state of engine.js: reset between scenarios
  const eng = Object.create(AudioEngine.prototype);
  Object.assign(eng, {
    ctx: { get currentTime() { return T; } },
    decks: [0, 1, 2, 3].map(makeDeck),
    fx: [0, 1, 2, 3].map(() => ({
      enabled: false, type: 'echo', level: 0, beatsMult: 0.5, modPeriodBeats() { return 0; }, wet: { gain: { value: 0 } },
    })),
    padFx: [null, null, null, null],
    masterFx: null,
    fxAssign: [0, 1, 2, 3].map((u) => [0, 1, 2, 3].map((i) => i === u)),
    xfSides: ['A', 'B', 'A', 'B'],
    crossfader: 0.5,
    masterIdx: null,
    autoMasterIdx: null,
    jogHold: false,
    dryComp: { gain: { setTargetAtTime() {} } },
  });
  eng.decks.forEach((d, i) => { d._onTempo = () => eng._followMaster(i); });

  const fmt = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'nan' : Number(x).toPrecision(17));
  const out = [];
  let ev = 0;
  const dt = 1 / 60;
  for (let k = 0; ; k++) {
    T = k / 60;
    let end = false;
    while (ev < events.length && events[ev].tick === k) {
      const e = events[ev++];
      const d = eng.decks[e.deck];
      switch (e.kind) {
        case 'load': {  // engine.js loadTrack (the sync part)
          const tr = tracks[e.a];
          d._padRoll = null; d._roll = null; d.playing = false;
          d.buffer = {}; d.bpm = tr.bpm || null; d.beatOffset = tr.beatOffset; d.beats = tr.beats; d.gridShift = 0;
          d.barAnchor = tr.barAnchor; d.dur = tr.dur; d.pos = e.b; d.tempo = 1;
          d._syncBase = null; d._syncRef = null; d._syncWant = null; d._pllCorr = 0; d._syncPhaseOff = 0; d._phaseFree = false;
          d._ratioCal = false; d._ratioMeas = null; d._ratioPasses = 0; d._ratioTries = 0; d._errFilt = 0;
          break;
        }
        case 'play': if (d.buffer && !d.playing) { d._endedAt = 0; d.playing = true; } break;
        case 'pause': d.playing = false; break;
        case 'sync': eng.sync(e.deck); break;
        case 'tempomul': d.setTempo(d.tempo * e.a); break;
        case 'master': eng.masterIdx = e.deck >= 0 ? e.deck : null; break;
        case 'eqlow': d.eq.low = e.a; break;
        case 'volume': d.volume = e.a; break;               // channel fader knob (bass rule: heard)
        case 'xf': eng.crossfader = e.a; break;             // crossfader position (bass rule: side gain)
        case 'side': eng.xfSides[e.deck] = e.a ? 'B' : 'A'; break;
        case 'arm': d.synced = !!e.a; break;               // SYNC on/off without sync() (deck.synced = x)
        case 'jog': eng.jogHold = e.deck === 1; break;
        case 'nudge': if (d.buffer) d.pos += e.a; break;
        case 'reanchorall': for (let j = 0; j < 4; j++) eng.reanchorSync(j); break;
        case 'snap': eng.snapToRef(e.deck, e.a); break;
        case 'offset': setGlobalGridOffset(Number(e.deck)); break;
        case 'end': end = true; break;
      }
    }
    if (end) break;
    eng.syncLock();
    let line = `${k} ${eng.masterIdx === null ? -1 : eng.masterIdx} ${eng.autoMasterIdx === null ? -1 : eng.autoMasterIdx}`;
    for (const d of eng.decks) {
      line += ` | ${fmt(d.tempo)} ${fmt(d._syncBase)} ${fmt(d._pllCorr)} ${d._ratioCal ? 1 : 0} ${fmt(d._errFilt)}`;
      line += ` ${d._ratioPasses || 0} ${d._ratioTries || 0} ${fmt(d._syncPhaseOff)} ${d.synced ? 1 : 0} ${fmt(d.currentTime())}`;
    }
    out.push(line);
    for (const d of eng.decks) {
      if (!d.playing) continue;
      d.pos += d.tempo * dt;
      if (d.pos >= d.dur) { d.pos = d.dur; d.playing = false; d._endedAt = (k + 1) / 60; }
    }
  }
  return out;
}

if (process.argv[2] === '--all') {
  const dir = process.argv[3];
  if (!dir) {
    console.error('usage: node xcheck.mjs --all <dir>');
    process.exit(2);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(here).filter((n) => /^scenario.*\.txt$/.test(n)).sort()) {
    const out = runScenario(fs.readFileSync(path.join(here, f), 'utf8'));
    const target = path.join(dir, f.replace(/\.txt$/, '.trace'));
    fs.writeFileSync(target, `${out.join('\n')}\n`);
    console.log(`engine.js trace (${f}): ${out.length} ticks -> ${target}`);
  }
} else {
  const scenario = process.argv[3] || path.join(here, 'scenario.txt');
  const out = runScenario(fs.readFileSync(scenario, 'utf8'));
  const text = `${out.join('\n')}\n`;
  const target = process.argv[2];
  if (target) {
    fs.writeFileSync(target, text);
    console.log(`engine.js trace: ${out.length} ticks -> ${target}`);
  } else {
    process.stdout.write(text);
  }
}
