// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// The browser test suite (DESIGN §10.2). Silent by construction: every test
// renders into an OfflineAudioContext at 48 kHz, from seeded synthetic
// signals, through the public API only.
//
// Per-deck capture: a unity GainNode is put on each deck with
// deck.setInsert(tap, 0) (between the FILTER and the fader / cue / meter taps)
// and wired into a ChannelMerger, one input per deck, connected to the
// destination. The engine master goes to a gain-0 sink (`output` option). The
// rendered channels are then the decks AS HEARD, after the keylock latency
// compensation.

import {
  createEngine,
  renderOffline,
  analyzeBpm,
  analyzeKey,
  computePeaks,
  keyName,
  camelotLabel,
  WSOLA_LATENCY_SAMPLES,
  VERSION
} from '../../src/index.js';
import {
  mulberry32,
  sine,
  clickTrack,
  impulseTrain,
  kickHatTrack,
  aMinorProgression,
  peaksTestSignal,
  chord,
  multiTone,
  encodeWav
} from './signals.js';
import {
  detectEvents,
  pairEvents,
  detectImpulses,
  estimateFrequency,
  cents,
  median,
  percentile,
  mean,
  linearRegression,
  rms,
  toDb,
  toneAmplitude,
  round
} from './measure.js';

export const SAMPLE_RATE = 48000;
const SR = SAMPLE_RATE;

/** Thrown by a test that cannot run in this browser (recorded as skipped). */
export class SkipTest extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipTest';
  }
}

export { VERSION };

// ------------------------------------------------------------- helpers ----

function makeBuffer(channels) {
  const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: SR });
  channels.forEach((data, c) => buffer.copyToChannel(data, c));
  return buffer;
}
const monoBuffer = (data) => makeBuffer([data]);
const stereoBuffer = (left, right = left) => makeBuffer([left, right]);

function requireSuspend() {
  const proto = globalThis.OfflineAudioContext && globalThis.OfflineAudioContext.prototype;
  if (!proto || typeof proto.suspend !== 'function') {
    throw new SkipTest('OfflineAudioContext.prototype.suspend is missing: renderOffline cannot tick');
  }
}

function requireWsola(engine) {
  if (engine.pitchEngine === 'wsola') return;
  if (!engine.context.audioWorklet) {
    throw new SkipTest('AudioWorklet is unavailable here (insecure context or old browser)');
  }
  const cause = engine.pitchEngineError ? engine.pitchEngineError.message : `pitchEngine = ${engine.pitchEngine}`;
  throw new Error(`The WSOLA keylock worklet did not load: ${cause}`);
}

/**
 * Offline context + engine + one capture channel per deck.
 * Call attachTaps() once the tracks are loaded.
 */
async function createCaptureRig({ decks, seconds, options = {} }) {
  const context = new OfflineAudioContext({ numberOfChannels: decks, length: Math.ceil(seconds * SR), sampleRate: SR });
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  const engine = await createEngine({ context, output: sink, decks, ...options });
  const merger = context.createChannelMerger(decks);
  merger.connect(context.destination);
  return {
    context,
    engine,
    merger,
    attachTaps() {
      engine.decks.forEach((deck, i) => {
        const tap = context.createGain();
        deck.setInsert(tap, 0);
        tap.connect(merger, 0, i);
      });
    },
    async dispose() {
      try {
        await engine.destroy();
      } catch {
        // a failing destroy() must not hide the test result
      }
    }
  };
}

const ms = (seconds) => seconds * 1000;
const r3 = (v) => round(v, 3);

// --------------------------------------------------------------- tests ----

async function syncTest({ keylock }) {
  requireSuspend();
  const RENDER = 64;
  const trackA = clickTrack({ bpm: 124, seconds: 70, sampleRate: SR, first: 0.1 });
  const trackB = clickTrack({ bpm: 128, seconds: 70, sampleRate: SR, first: 0.1 });
  const rig = await createCaptureRig({ decks: 2, seconds: RENDER });
  try {
    const [d0, d1] = rig.engine.decks;
    d0.load(monoBuffer(trackA.data), { bpm: 124, beats: trackA.beats });
    d1.load(monoBuffer(trackB.data), { bpm: 128, beats: trackB.beats });
    rig.attachTaps();
    if (keylock) {
      requireWsola(rig.engine);
      d1.setKeylock(true);
    }
    d0.play();
    let syncResult;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        if (syncResult === undefined && t >= 2) {
          syncResult = d1.sync();
          d1.play();
        }
      }
    });
    const ev0 = detectEvents(out.getChannelData(0), SR);
    const ev1 = detectEvents(out.getChannelData(1), SR);
    const span = { from: 10, to: 62, maxDistance: 0.1 };
    const { pairs, unmatched, total } = pairEvents(ev0, ev1, span);
    const abs = pairs.map((p) => ms(Math.abs(p.offset)));
    const signed = pairs.map((p) => ms(p.offset));
    const fit = linearRegression(pairs.map((p) => p.t), signed);
    const onsetAbs = pairEvents(ev0, ev1, { ...span, key: 'onset' }).pairs.map((p) => ms(Math.abs(p.offset)));
    const metrics = {
      syncResult: syncResult === undefined ? 'not called' : syncResult,
      synced: d1.synced,
      beats: total,
      pairs: pairs.length,
      unmatched,
      medianMs: r3(median(abs)),
      p95Ms: r3(percentile(abs, 95)),
      maxMs: r3(abs.length ? Math.max(...abs) : NaN),
      meanMs: r3(mean(signed)),
      slopeMsPerS: round(fit.slope, 5),
      onsetMedianMs: r3(median(onsetAbs)),
      onsetMaxMs: r3(onsetAbs.length ? Math.max(...onsetAbs) : NaN),
      deck1BaseTempo: round(d1.baseTempo, 6),
      deck1LatencyMs: r3(ms(d1.latency)),
      pitchEngine: rig.engine.pitchEngine
    };
    const lim = keylock ? { median: 1.5, p95: 3, max: 6 } : { median: 1.0, p95: 2.0, max: 5 };
    const pass = total >= 100 && unmatched === 0
      && metrics.medianMs <= lim.median && metrics.p95Ms <= lim.p95 && metrics.maxMs <= lim.max
      && (keylock || Math.abs(fit.slope) <= 0.02);
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

async function keylockPitch() {
  requireSuspend();
  const tone = monoBuffer(sine({ frequency: 440, seconds: 12, sampleRate: SR, amplitude: 0.5 }));
  const cases = [
    { id: 'lock106', keylock: true, tempo: 1.06, key: 0, expected: 440 },
    { id: 'key+3', keylock: false, tempo: 1, key: 3, expected: 440 * Math.pow(2, 3 / 12) },
    { id: 'lock094key-5', keylock: true, tempo: 0.94, key: -5, expected: 440 * Math.pow(2, -5 / 12) }
  ];
  const metrics = {};
  let pass = true;
  const rig = await createCaptureRig({ decks: cases.length, seconds: 9 });
  try {
    requireWsola(rig.engine);
    const decks = rig.engine.decks;
    decks.forEach((d) => d.load(tone));
    rig.attachTaps();
    cases.forEach((c, i) => {
      decks[i].setKeylock(c.keylock);
      decks[i].setTempo(c.tempo);
      decks[i].setKey(c.key);
    });
    decks.forEach((d) => d.play());
    const out = await renderOffline(rig.engine, { tickRate: 60 });
    cases.forEach((c, i) => {
      const est = estimateFrequency(out.getChannelData(i), SR, { startSec: 2, endSec: 8, expected: c.expected });
      const err = cents(est.frequency, c.expected);
      metrics[`${c.id}.hz`] = r3(est.frequency);
      metrics[`${c.id}.cents`] = r3(err);
      metrics[`${c.id}.zcCents`] = r3(cents(est.zeroCrossing, c.expected));
      if (!(Math.abs(err) <= 5)) pass = false;
    });
    metrics.pitchEngine = rig.engine.pitchEngine;
  } finally {
    await rig.dispose();
  }

  // Information only: the two-tap fallback shifter (keylock: false option), key +3
  const fb = await createCaptureRig({ decks: 1, seconds: 9, options: { keylock: false } });
  try {
    const d = fb.engine.decks[0];
    d.load(tone);
    fb.attachTaps();
    d.setKey(3);
    d.play();
    const out = await renderOffline(fb.engine, { tickRate: 60 });
    const expected = 440 * Math.pow(2, 3 / 12);
    const est = estimateFrequency(out.getChannelData(0), SR, { startSec: 2, endSec: 8, expected });
    metrics['fallback.pitchEngine'] = fb.engine.pitchEngine;
    metrics['fallback.key+3.hz'] = r3(est.frequency);
    metrics['fallback.key+3.cents'] = r3(cents(est.frequency, expected));
  } catch (e) {
    metrics['fallback.error'] = String((e && e.message) || e);
  } finally {
    await fb.dispose();
  }
  return { pass, metrics };
}

async function loopPrecision() {
  requireSuspend();
  // Impulse every 0.25 s (0.3), plus a louder one (1.0) at 1.125 s, inside the
  // loop [1.0, 1.5) and away from its seam. (At a tempo ≠ 1, Chromium's
  // linear interpolation at the seam reads the sample AT loopEnd instead of
  // wrapping to loopStart, so an impulse sitting exactly on loopStart is
  // partly replaced by the one at loopEnd: its amplitude varies from pass to
  // pass, while its timing stays exact. Equal 0.3 impulses on both sides of
  // the seam keep the loop-start impulse detectable.)
  const train = impulseTrain({ interval: 0.25, seconds: 10, sampleRate: SR, amplitude: 0.3 });
  train.data[Math.round(1.125 * SR)] = 1;
  const tempos = [1, 1.1];
  const rig = await createCaptureRig({ decks: tempos.length, seconds: 8 });
  try {
    const decks = rig.engine.decks;
    const buffer = monoBuffer(train.data);
    decks.forEach((d) => d.load(buffer));
    rig.attachTaps();
    decks.forEach((d, i) => d.setTempo(tempos[i]));
    decks.forEach((d) => d.play());
    let loopResults = null;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        if (!loopResults && t >= 0.5) loopResults = decks.map((d) => d.setLoop(1.0, 1.5));
      }
    });
    const metrics = { setLoop: loopResults ? loopResults.join(',') : 'not called' };
    let pass = !!loopResults;
    tempos.forEach((tempo, i) => {
      const events = detectImpulses(out.getChannelData(i), { threshold: 0.1, refractory: Math.round(0.05 * SR) });
      const accents = events.filter((e) => e.sum > 0.6).map((e) => e.position);
      const period = (0.5 * SR) / tempo;
      const lead = (0.125 * SR) / tempo; // loop start → accent
      let maxInterval = 0;
      let maxRecur = 0;
      for (let n = 1; n < accents.length; n++) {
        maxInterval = Math.max(maxInterval, Math.abs(accents[n] - accents[n - 1] - period));
      }
      for (let n = 0; n < accents.length; n++) {
        maxRecur = Math.max(maxRecur, Math.abs(accents[n] - (accents[0] + n * period)));
      }
      // The impulse AT the loop start precedes every accent by 0.125 s / tempo
      let maxStartErr = 0;
      let missingStarts = 0;
      for (const p of accents) {
        let best = Infinity;
        for (const e of events) best = Math.min(best, Math.abs(e.position - (p - lead)));
        if (best > 50) missingStarts++;
        else maxStartErr = Math.max(maxStartErr, best);
      }
      const tag = `tempo${tempo}`;
      metrics[`${tag}.repeats`] = accents.length;
      metrics[`${tag}.periodSamples`] = r3(period);
      metrics[`${tag}.maxIntervalErrSamples`] = r3(maxInterval);
      metrics[`${tag}.maxRecurrenceErrSamples`] = r3(maxRecur);
      metrics[`${tag}.loopStartMaxErrSamples`] = r3(maxStartErr);
      metrics[`${tag}.loopStartMissing`] = missingStarts;
      if (!(accents.length >= 10 && maxInterval <= 2 && maxRecur <= 2 && missingStarts === 0 && maxStartErr <= 2)) pass = false;
    });
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

async function beatloopQuantize() {
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
  const engine = await createEngine({ context, decks: 1 });
  try {
    const deck = engine.decks[0];
    const beats = Array.from({ length: 40 }, (_, k) => k * 0.5); // 120 BPM: 0, 0.5, 1.0, …
    deck.load(monoBuffer(new Float32Array(SR * 20)), { bpm: 120, beats });
    deck.seek(1.13);
    const position = deck.position;
    const ok = deck.beatLoop(4);
    const loop = deck.loop;
    const metrics = {
      quantize: deck.quantize,
      position: round(position, 6),
      returned: ok,
      active: loop.active,
      start: round(loop.start, 6),
      end: round(loop.end, 6),
      beats: loop.beats
    };
    const pass = ok === true && loop.active === true
      && Math.abs(loop.start - 1.125) <= 1e-4 && Math.abs(loop.end - 3.125) <= 1e-4 && loop.beats === 4;
    return { pass, metrics };
  } finally {
    try { await engine.destroy(); } catch { /* ignore */ }
  }
}

async function analysisBpm() {
  const metrics = {};
  let pass = true;
  for (const bpm of [128, 100]) {
    const first = 0.25;
    const period = 60 / bpm;
    const track = kickHatTrack({ bpm, seconds: 60, sampleRate: SR, first, seed: bpm });
    const result = await analyzeBpm(stereoBuffer(track.data));
    const tag = `bpm${bpm}`;
    if (!result) {
      metrics[`${tag}.result`] = null;
      pass = false;
      continue;
    }
    let beats = result.beats;
    if (!beats && result.bpm && result.beatOffset != null) {
      beats = [];
      for (let t = result.beatOffset; t < 60; t += 60 / result.bpm) beats.push(t);
    }
    const errs = (beats || []).filter((b) => b >= 0 && b <= 60).map((b) => {
      const k = Math.round((b - first) / period);
      return ms(Math.abs(b - (first + k * period)));
    });
    const med = median(errs);
    metrics[`${tag}.bpm`] = result.bpm;
    metrics[`${tag}.rigid`] = result.rigid;
    metrics[`${tag}.deviationMs`] = result.deviationMs;
    metrics[`${tag}.beats`] = beats ? beats.length : 0;
    metrics[`${tag}.medianBeatErrMs`] = r3(med);
    if (!(Math.abs(result.bpm - bpm) <= 0.02 && result.rigid === true && med <= 3)) pass = false;
  }
  return { pass, metrics };
}

async function analysisKey() {
  const data = aMinorProgression({ seconds: 30, sampleRate: SR, seed: 21 });
  const result = await analyzeKey(monoBuffer(data));
  const metrics = result
    ? {
        code: result.code,
        name: result.name,
        camelot: result.camelot,
        confidence: r3(result.confidence),
        score: r3(result.score),
        tuning: r3(result.tuning),
        expected: `21 (${keyName(21)}, ${camelotLabel(21)})`
      }
    : { result: null };
  return { pass: !!result && result.code === 21, metrics };
}

async function peaksTest() {
  // 7.0257 s: duration × perSecond is never an integer (no rounding ambiguity)
  const AMP = 0.8;
  const buffer = stereoBuffer(...peaksTestSignal({ seconds: 7.0257, sampleRate: SR, amplitude: AMP }));
  const dur = buffer.duration;
  const metrics = { duration: round(dur, 6) };
  let pass = true;
  const fail = (why) => {
    pass = false;
    metrics.failures = metrics.failures ? `${metrics.failures}; ${why}` : why;
  };

  const p = await computePeaks(buffer);
  const n = Math.ceil(dur * 400);
  const nFine = Math.ceil(dur * 4000);
  metrics.perSecond = p.perSecond;
  metrics.slices = p.top.length;
  metrics.expectedSlices = n;
  metrics.finePps = p.finePps;
  metrics.fineSlices = p.fineTop.length;
  metrics.expectedFineSlices = nFine;
  if (p.perSecond !== 400) fail('default perSecond is not 400');
  if (Math.abs(p.duration - dur) > 1e-6) fail('duration differs from the buffer');
  for (const k of ['top', 'bottom', 'low', 'mid', 'high']) if (p[k].length !== n) fail(`${k}.length ${p[k].length} ≠ ${n}`);
  if (p.finePps !== 4000) fail(`finePps ${p.finePps} ≠ 4000`);
  if (p.fineTop.length !== nFine || p.fineBottom.length !== nFine) fail('fine envelope length');
  let maxTop = -Infinity;
  let minBottom = Infinity;
  let maxBand = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const t = p.top[i];
    const b = p.bottom[i];
    if (!Number.isFinite(t) || !Number.isFinite(b) || b > t || t > AMP + 1e-6 || b < -AMP - 1e-6) bad++;
    maxTop = Math.max(maxTop, t);
    minBottom = Math.min(minBottom, b);
    for (const k of ['low', 'mid', 'high']) {
      const v = p[k][i];
      if (!Number.isFinite(v) || v < 0 || v > 2) bad++;
      maxBand = Math.max(maxBand, v);
    }
  }
  let maxFine = -128;
  let minFine = 127;
  for (let i = 0; i < p.fineTop.length; i++) {
    if (p.fineBottom[i] > p.fineTop[i] || p.fineTop[i] > 127 || p.fineBottom[i] < -127) bad++;
    maxFine = Math.max(maxFine, p.fineTop[i]);
    minFine = Math.min(minFine, p.fineBottom[i]);
  }
  metrics.maxTop = r3(maxTop);
  metrics.minBottom = r3(minBottom);
  metrics.maxBand = r3(maxBand);
  metrics.fineRange = `${minFine}..${maxFine}`;
  metrics.outOfRange = bad;
  if (bad) fail(`${bad} values out of range`);
  if (Math.abs(maxTop - AMP) > 1e-3 || Math.abs(minBottom + AMP) > 1e-3) fail('envelope extremes ≠ signal peaks');
  const fineExpect = Math.round(AMP * 127);
  if (Math.abs(maxFine - fineExpect) > 1 || Math.abs(minFine + fineExpect) > 1) fail('fine extremes ≠ signal peaks');

  const q = await computePeaks(buffer, { perSecond: 150, fine: false });
  const n2 = Math.ceil(dur * 150);
  metrics['coarse.perSecond'] = q.perSecond;
  metrics['coarse.slices'] = q.top.length;
  metrics['coarse.expectedSlices'] = n2;
  metrics['coarse.finePps'] = q.finePps;
  metrics['coarse.fineSlices'] = q.fineTop ? q.fineTop.length : null;
  for (const k of ['top', 'bottom', 'low', 'mid', 'high']) if (q[k].length !== n2) fail(`fine:false ${k}.length ${q[k].length} ≠ ${n2}`);
  if (q.finePps !== 0) fail(`fine:false finePps ${q.finePps} ≠ 0`);
  return { pass, metrics };
}

async function cueRouting() {
  requireSuspend();
  const tone = stereoBuffer(sine({ frequency: 1000, seconds: 2, sampleRate: SR, amplitude: 0.5 }));
  const run = async (pfl) => {
    // 4-channel destination and NO output option: rule 4 of §6.6
    const context = new OfflineAudioContext({ numberOfChannels: 4, length: Math.round(1.5 * SR), sampleRate: SR });
    const engine = await createEngine({ context });
    try {
      const headphones = engine.headphonesAvailable;
      const deck = engine.decks[0];
      deck.load(tone);
      deck.setVolume(0);
      deck.setHeadphoneCue(pfl);
      deck.play();
      const out = await renderOffline(engine, { tickRate: 60 });
      const db = [];
      for (let c = 0; c < out.numberOfChannels; c++) db.push(round(toDb(rms(out.getChannelData(c), SR, 0.3, 1.4)), 1));
      return { headphones, db, channels: out.numberOfChannels };
    } finally {
      try { await engine.destroy(); } catch { /* ignore */ }
    }
  };
  const on = await run(true);
  const off = await run(false);
  const metrics = {
    headphonesAvailable: on.headphones,
    channels: on.channels,
    'pflOn.dB': on.db.join(' / '),
    'pflOff.dB': off.db.join(' / ')
  };
  const pass = on.headphones === true && off.headphones === true && on.channels === 4
    && on.db[2] > -30 && on.db[3] > -30 && on.db[0] < -90 && on.db[1] < -90
    && off.db[2] < -90 && off.db[3] < -90;
  return { pass, metrics };
}

async function renderCpu() {
  requireSuspend();
  const SECONDS = 60;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: SECONDS * SR, sampleRate: SR });
  const engine = await createEngine({ context });
  try {
    const bpms = [124, 126, 128, 122];
    engine.decks.forEach((d, i) => {
      const track = kickHatTrack({ bpm: bpms[i], seconds: SECONDS + 8, sampleRate: SR, first: 0.2, seed: 100 + i, bass: true });
      d.load(monoBuffer(track.data), { bpm: bpms[i], beats: track.beats });
    });
    engine.decks[2].setKeylock(true);
    engine.decks[3].setKeylock(true);
    const echo = engine.fx[0];
    echo.setType('echo');
    echo.setBeats(0.5);
    echo.setLevel(0.5);
    echo.setEnabled(true);
    const verb = engine.fx[1];
    verb.setType('reverb');
    verb.setBeats(1);
    verb.setLevel(0.5);
    verb.setEnabled(true);
    engine.decks[0].play();
    let started = false;
    const t0 = performance.now();
    const out = await renderOffline(engine, {
      tickRate: 60,
      onTick: (t) => {
        if (!started && t >= 0.5) {
          started = true;
          for (const d of engine.decks.slice(1)) {
            d.sync();
            d.play();
          }
        }
      }
    });
    const wallMs = performance.now() - t0;
    const left = out.getChannelData(0);
    return {
      pass: true,
      metrics: {
        realtimeFactor: round(SECONDS / (wallMs / 1000), 1),
        wallMs: Math.round(wallMs),
        pitchEngine: engine.pitchEngine,
        keylockedDecks: engine.decks.filter((d) => d.keylock).length,
        fxOn: engine.fx.filter((u) => u.enabled).length,
        synced: engine.decks.map((d) => (d.synced ? 1 : 0)).join(''),
        outputRmsDb: round(toDb(rms(left, SR, 5, SECONDS)), 1)
      }
    };
  } finally {
    try { await engine.destroy(); } catch { /* ignore */ }
  }
}

// ------------------------------------------------- additional checks ----
// Beyond the DESIGN §10.2 list: the integration checks (BPM on click tracks,
// major keys, sync from mid-track with bar alignment, EQ kill, crossfader
// extremes, keylock at ±8 %, an exact 4-beat loop, peaks shape). Same rules:
// OfflineAudioContext only, seeded signals, public API only, metrics always
// reported.

const relDb = (a, ref) => toDb(a) - toDb(ref);

/** analyzeBpm on click tracks at known tempos: within 0.05 BPM. */
async function analysisBpmClicks() {
  const cases = [86, 95, 100, 110, 120, 122.5, 124, 126.37, 128, 133.33, 140, 150, 160, 174];
  const rng = mulberry32(2026);
  const metrics = {};
  let pass = true;
  let worst = 0;
  let worstBeat = 0;
  for (const bpm of cases) {
    const first = 0.05 + rng() * 0.6;
    const track = clickTrack({ bpm, seconds: 60, sampleRate: SR, first });
    const result = await analyzeBpm(monoBuffer(track.data));
    if (!result) {
      metrics[`${bpm}`] = null;
      pass = false;
      continue;
    }
    const period = 60 / bpm;
    const errs = (result.beats || [])
      .filter((b) => b >= first - 0.01 && b <= 59)
      .map((b) => ms(Math.abs(b - (first + Math.round((b - first) / period) * period))));
    const err = result.bpm - bpm;
    const med = median(errs);
    worst = Math.max(worst, Math.abs(err));
    worstBeat = Math.max(worstBeat, med);
    metrics[`${bpm}`] = `${result.bpm}${result.rigid ? ' rigid' : ''} beatErr=${r3(med)}ms`;
    if (!(Math.abs(err) <= 0.05 && med <= 3)) pass = false;
  }
  metrics.worstBpmError = r3(worst);
  metrics.worstMedianBeatErrMs = r3(worstBeat);
  return { pass, metrics };
}

/** analyzeKey on sustained major triads (over their root in the bass): key and Camelot. */
async function analysisKeyMajor() {
  const cases = [
    { root: 60, code: 0, camelot: '8B' },   // C
    { root: 67, code: 7, camelot: '9B' },   // G
    { root: 62, code: 2, camelot: '10B' },  // D
    { root: 65, code: 5, camelot: '7B' },   // F
    { root: 70, code: 10, camelot: '6B' },  // Bb
    { root: 64, code: 4, camelot: '12B' }   // E
  ];
  const metrics = {};
  let pass = true;
  for (const c of cases) {
    const data = chord({ notes: [c.root, c.root + 4, c.root + 7], bass: c.root - 24, seconds: 15, sampleRate: SR });
    const r = await analyzeKey(monoBuffer(data));
    const tag = keyName(c.code);
    metrics[tag] = r ? `${r.name} ${r.camelot} (conf ${r3(r.confidence)})` : null;
    if (!r || r.code !== c.code || r.camelot !== c.camelot || r.name !== tag || camelotLabel(c.code) !== c.camelot) pass = false;
  }
  // a bare triad, no bass note: C major
  const bare = await analyzeKey(monoBuffer(chord({ notes: [60, 64, 67], seconds: 15, sampleRate: SR })));
  metrics.bareC = bare ? `${bare.name} ${bare.camelot}` : null;
  if (!bare || bare.code !== 0 || bare.camelot !== '8B') pass = false;
  return { pass, metrics };
}

/**
 * SYNC of a follower parked mid-track (off the beat and off the bar) onto a
 * master playing from its start, both with offset beat lists: per-beat phase
 * error on the rendered output, and BAR alignment (accented downbeats meet).
 */
async function syncMidTrack() {
  requireSuspend();
  const RENDER = 40;
  const trackA = clickTrack({ bpm: 126, seconds: 60, sampleRate: SR, first: 0.21 });
  const trackB = clickTrack({ bpm: 120.5, seconds: 90, sampleRate: SR, first: 0.437 });
  const rig = await createCaptureRig({ decks: 2, seconds: RENDER });
  try {
    const [d0, d1] = rig.engine.decks;
    d0.load(monoBuffer(trackA.data), { beats: trackA.beats }); // BPM from the beat list
    d1.load(monoBuffer(trackB.data), { beats: trackB.beats });
    rig.attachTaps();
    d1.seek(17.3);
    d0.play();
    let syncResult;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        if (syncResult === undefined && t >= 3.1) {
          syncResult = d1.sync();
          d1.play();
        }
      }
    });
    const ev0 = detectEvents(out.getChannelData(0), SR);
    const ev1 = detectEvents(out.getChannelData(1), SR);
    const { pairs, unmatched, total } = pairEvents(ev0, ev1, { from: 10, to: RENDER - 2, maxDistance: 0.1 });
    const abs = pairs.map((p) => ms(Math.abs(p.offset)));
    const fit = linearRegression(pairs.map((p) => p.t), pairs.map((p) => ms(p.offset)));
    // Bars: every accented click (downbeat) of deck 0 meets an accented click of deck 1
    const ACCENT = 0.75;
    let barsMet = 0;
    let barsMissed = 0;
    for (const e of ev0) {
      if (e.time < 10 || e.time > RENDER - 2 || e.peak < ACCENT) continue;
      let near = null;
      for (const f of ev1) if (!near || Math.abs(f.time - e.time) < Math.abs(near.time - e.time)) near = f;
      if (near && Math.abs(near.time - e.time) < 0.02 && near.peak >= ACCENT) barsMet++;
      else barsMissed++;
    }
    const metrics = {
      syncResult: syncResult === undefined ? 'not called' : syncResult,
      synced: d1.synced,
      beats: total,
      pairs: pairs.length,
      unmatched,
      medianMs: r3(median(abs)),
      p95Ms: r3(percentile(abs, 95)),
      maxMs: r3(abs.length ? Math.max(...abs) : NaN),
      slopeMsPerS: round(fit.slope, 5),
      downbeatsMet: barsMet,
      downbeatsMissed: barsMissed,
      deck1BaseTempo: round(d1.baseTempo, 6),
      expectedTempo: round(126 / 120.5, 6)
    };
    const pass = total >= 50 && unmatched === 0 && metrics.medianMs <= 1 && metrics.p95Ms <= 2 && metrics.maxMs <= 5
      && Math.abs(fit.slope) <= 0.02 && barsMet >= 10 && barsMissed === 0;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * EQ LOW kill (setKill('low')): the attenuation at 60 Hz (and at 1 kHz)
 * equals the response of the contract's low shelf (200 Hz, −40 dB, §6.1 / §6.7),
 * computed by the browser for an identical BiquadFilterNode; the release
 * restores the level exactly.
 */
async function eqKill60Hz() {
  requireSuspend();
  const tone = monoBuffer(multiTone({
    tones: [{ frequency: 60, amplitude: 0.3 }, { frequency: 1000, amplitude: 0.3 }], seconds: 5, sampleRate: SR
  }));
  const rig = await createCaptureRig({ decks: 1, seconds: 3.5 });
  try {
    const d = rig.engine.decks[0];
    d.load(tone);
    rig.attachTaps();
    d.play();
    const states = {};
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        if (t >= 1 && !states.killed) {
          d.setKill('low', true);
          states.killed = { kills: d.kills.low, eq: d.eq.low };
        }
        if (t >= 2 && !states.released) {
          d.setKill('low', false);
          states.released = { kills: d.kills.low, eq: d.eq.low };
        }
      }
    });
    // The contract's low shelf, evaluated by the browser
    const ref = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SR });
    const shelf = ref.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 200;
    shelf.gain.value = -40;
    const freqs = new Float32Array([60, 1000]);
    const mag = new Float32Array(2);
    const phase = new Float32Array(2);
    shelf.getFrequencyResponse(freqs, mag, phase);
    const x = out.getChannelData(0);
    const level = (f, a, b) => toneAmplitude(x, SR, f, a, b);
    const open60 = level(60, 0.4, 0.9);
    const open1k = level(1000, 0.4, 0.9);
    const kill60 = relDb(level(60, 1.4, 1.9), open60);
    const kill1k = relDb(level(1000, 1.4, 1.9), open1k);
    const back60 = relDb(level(60, 2.5, 3.0), open60);
    const back1k = relDb(level(1000, 2.5, 3.0), open1k);
    const metrics = {
      openLevel60: r3(open60),
      kill60Db: round(kill60, 2),
      expected60Db: round(toDb(mag[0]), 2),
      kill1kDb: round(kill1k, 2),
      expected1kDb: round(toDb(mag[1]), 2),
      release60Db: round(back60, 3),
      release1kDb: round(back1k, 3),
      killedState: JSON.stringify(states.killed),
      releasedState: JSON.stringify(states.released)
    };
    const pass = Math.abs(open60 - 0.3) < 0.003
      && Math.abs(kill60 - toDb(mag[0])) <= 0.5 && kill60 <= -30
      && Math.abs(kill1k - toDb(mag[1])) <= 0.5
      && Math.abs(back60) <= 0.05 && Math.abs(back1k) <= 0.05
      && states.killed && states.killed.kills === true && states.killed.eq === -1
      && states.released && states.released.kills === false && states.released.eq === 0;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * Crossfader ("mix" curve, §6.7) measured on the master output: decks on
 * sides A (300 Hz), B (500 Hz) and thru (700 Hz) at x = 0, 1, 0.5, 0.25, 0.75.
 */
async function crossfaderExtremes() {
  requireSuspend();
  const freqs = [300, 500, 700];
  const steps = [0, 1, 0.5, 0.25, 0.75];
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: steps.length * SR, sampleRate: SR });
  const engine = await createEngine({ context, decks: 3, limiter: false });
  try {
    const decks = engine.decks;
    decks.forEach((d, i) => d.load(monoBuffer(sine({ frequency: freqs[i], seconds: steps.length + 2, sampleRate: SR, amplitude: 0.25 }))));
    decks[2].setCrossfaderSide('thru');
    engine.setCrossfader(steps[0]);
    decks.forEach((d) => d.play());
    let k = 0;
    const out = await renderOffline(engine, {
      tickRate: 60,
      onTick: (t) => {
        if (k + 1 < steps.length && t >= k + 1) engine.setCrossfader(steps[++k]);
      }
    });
    const x = out.getChannelData(0);
    // gA = x ≤ 0.5 ? 1 : 2(1 − x); gB = x ≥ 0.5 ? 1 : 2x; thru = 1
    const gain = (side, xf) => (side === 'thru' ? 1 : side === 'A' ? (xf <= 0.5 ? 1 : 2 * (1 - xf)) : (xf >= 0.5 ? 1 : 2 * xf));
    const sides = ['A', 'B', 'thru'];
    const levels = steps.map((_, s) => freqs.map((f) => toneAmplitude(x, SR, f, s + 0.4, s + 0.9)));
    const refStep = steps.indexOf(0.5);
    const metrics = { sides: decks.map((d) => d.crossfaderSide).join('/') };
    let pass = metrics.sides === 'A/B/thru';
    steps.forEach((xf, s) => {
      const row = sides.map((side, i) => {
        const db = relDb(levels[s][i], levels[refStep][i]);
        const want = gain(side, xf);
        if (want === 0) {
          if (!(db <= -100)) pass = false;
        } else if (!(Math.abs(db - toDb(want)) <= 0.05)) {
          pass = false;
        }
        return Number.isFinite(db) ? round(db, 2) : db;
      });
      metrics[`x=${xf}`] = row.join(' / ');
    });
    return { pass, metrics };
  } finally {
    try { await engine.destroy(); } catch { /* ignore */ }
  }
}

/** Keylock at ±8 % tempo keeps a 440 Hz tone within 5 cents (keylock off moves it, as a sanity check). */
async function keylockPlus8() {
  requireSuspend();
  const tone = monoBuffer(sine({ frequency: 440, seconds: 12, sampleRate: SR, amplitude: 0.5 }));
  const cases = [
    { id: 'lock+8', keylock: true, tempo: 1.08, expected: 440 },
    { id: 'lock-8', keylock: true, tempo: 0.92, expected: 440 },
    { id: 'nolock+8', keylock: false, tempo: 1.08, expected: 440 * 1.08 }
  ];
  const metrics = {};
  let pass = true;
  const rig = await createCaptureRig({ decks: cases.length, seconds: 9 });
  try {
    requireWsola(rig.engine);
    const decks = rig.engine.decks;
    decks.forEach((d) => d.load(tone));
    rig.attachTaps();
    cases.forEach((c, i) => {
      decks[i].setKeylock(c.keylock);
      decks[i].setTempo(c.tempo);
    });
    decks.forEach((d) => d.play());
    const out = await renderOffline(rig.engine, { tickRate: 60 });
    cases.forEach((c, i) => {
      const est = estimateFrequency(out.getChannelData(i), SR, { startSec: 2, endSec: 8, expected: c.expected });
      const err = cents(est.frequency, c.expected);
      metrics[`${c.id}.hz`] = r3(est.frequency);
      metrics[`${c.id}.cents`] = r3(err);
      if (!(Math.abs(err) <= 5)) pass = false;
    });
    metrics.lockLatencyMs = r3(ms(decks[0].latency));
    metrics.pitchEngine = rig.engine.pitchEngine;
  } finally {
    await rig.dispose();
  }
  return { pass, metrics };
}

/**
 * beatLoop(4) while playing, on a 124 BPM click track (beat list): the loop
 * starts on the nearest ¼ beat (8.5) and lasts exactly 4 beats on the grid;
 * rendered, every click recurs every 4 beats / tempo to within 1 sample, the
 * seam is seamless (every click interval is one beat) and each pass holds 4
 * clicks with one accented downbeat. At tempo 1 and 0.97.
 */
async function loopFourBeats() {
  requireSuspend();
  const BPM = 124;
  const FIRST = 0.1;
  const track = clickTrack({ bpm: BPM, seconds: 30, sampleRate: SR, first: FIRST });
  const tempos = [1, 0.97];
  const RENDER = 14;
  const rig = await createCaptureRig({ decks: tempos.length, seconds: RENDER });
  try {
    const decks = rig.engine.decks;
    const buffer = monoBuffer(track.data);
    decks.forEach((d) => d.load(buffer, { bpm: BPM, beats: track.beats }));
    rig.attachTaps();
    decks.forEach((d, i) => d.setTempo(tempos[i]));
    decks.forEach((d) => d.play());
    const b = track.beats;
    const callAt = b[8] + 0.55 * (b[9] - b[8]); // position 8.55 beats → snaps to 8.5
    const calls = tempos.map(() => null);
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        decks.forEach((d, i) => {
          if (calls[i] || d.position < callAt) return;
          const ok = d.beatLoop(4);
          calls[i] = { ok, t, position: d.position, loop: d.loop };
        });
      }
    });
    const metrics = {};
    let pass = true;
    tempos.forEach((tempo, i) => {
      const c = calls[i];
      const tag = `tempo${tempo}`;
      if (!c) {
        metrics[`${tag}.call`] = 'never';
        pass = false;
        return;
      }
      const loop = c.loop;
      const wantStart = b[8] + 0.5 * (b[9] - b[8]);
      const wantEnd = b[12] + 0.5 * (b[13] - b[12]);
      const lenSamples = (loop.end - loop.start) * SR;
      const expectRepeat = lenSamples / tempo; // output samples per pass
      const beatOut = ((b[10] - b[9]) * SR) / tempo;
      const ev = detectEvents(out.getChannelData(i), SR).filter((e) => e.time > c.t);
      let maxRepeatErr = 0;
      for (let j = 4; j < ev.length; j++) {
        maxRepeatErr = Math.max(maxRepeatErr, Math.abs((ev[j].time - ev[j - 4].time) * SR - expectRepeat));
      }
      let maxBeatErr = 0;
      for (let j = 1; j < ev.length; j++) {
        maxBeatErr = Math.max(maxBeatErr, Math.abs((ev[j].time - ev[j - 1].time) * SR - beatOut));
      }
      const accents = ev.map((e) => (e.peak > 0.75 ? 1 : 0));
      let patternOk = ev.length >= 16;
      for (let j = 4; j < accents.length; j++) if (accents[j] !== accents[j - 4]) patternOk = false;
      const perPass = accents.slice(0, 4).reduce((s, v) => s + v, 0);
      metrics[`${tag}.returned`] = c.ok;
      metrics[`${tag}.start`] = round(loop.start, 6);
      metrics[`${tag}.end`] = round(loop.end, 6);
      metrics[`${tag}.beats`] = loop.beats;
      metrics[`${tag}.lenErrVs4BeatsSamples`] = r3(lenSamples - (4 * 60 / BPM) * SR);
      metrics[`${tag}.clicks`] = ev.length;
      metrics[`${tag}.maxRepeatErrSamples`] = r3(maxRepeatErr);
      metrics[`${tag}.maxBeatErrSamples`] = r3(maxBeatErr);
      metrics[`${tag}.accentsPerPass`] = perPass;
      if (!(c.ok === true && loop.active && Math.abs(loop.start - wantStart) < 1e-9 && Math.abs(loop.end - wantEnd) < 1e-9
        && loop.beats === 4 && Math.abs(lenSamples - (4 * 60 / BPM) * SR) <= 1 && ev.length >= 16
        && maxRepeatErr <= 1 && maxBeatErr <= 1 && patternOk && perPass === 1)) pass = false;
    });
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * computePeaks shape: array types and lengths, the envelope follows an
 * amplitude ramp, and each band peaks on its own section (60 Hz → low,
 * 1 kHz → mid, 6 kHz → high).
 */
async function peaksShape() {
  const SECONDS = 6;
  const n = SECONDS * SR;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t < 2) data[i] = 0.8 * (t / 2) * Math.sin(2 * Math.PI * 60 * t);
    else if (t < 4) data[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t);
    else data[i] = 0.5 * Math.sin(2 * Math.PI * 6000 * t);
  }
  const p = await computePeaks(stereoBuffer(data));
  const metrics = {};
  let pass = true;
  const fail = (why) => {
    pass = false;
    metrics.failures = metrics.failures ? `${metrics.failures}; ${why}` : why;
  };
  const N = Math.ceil(SECONDS * 400);
  for (const k of ['top', 'bottom', 'low', 'mid', 'high']) {
    if (!(p[k] instanceof Float32Array)) fail(`${k} is not a Float32Array`);
    if (p[k].length !== N) fail(`${k}.length ${p[k].length} ≠ ${N}`);
  }
  for (const k of ['fineTop', 'fineBottom']) {
    if (!(p[k] instanceof Int8Array)) fail(`${k} is not an Int8Array`);
    if (p[k].length !== SECONDS * 4000) fail(`${k}.length ${p[k].length}`);
  }
  if (p.perSecond !== 400 || p.finePps !== 4000 || Math.abs(p.duration - SECONDS) > 1e-9) fail('perSecond / finePps / duration');
  const sl = (t) => Math.round(t * 400);
  const maxOf = (arr, a, b) => {
    let m = -Infinity;
    for (let i = sl(a); i < sl(b); i++) m = Math.max(m, arr[i]);
    return m;
  };
  // envelope: max of top over 50 ms windows follows the ramp 0.8 × t / 2
  let rampErr = 0;
  for (let t = 0.2; t < 1.95; t += 0.25) {
    const env = maxOf(p.top, t, t + 0.05);
    rampErr = Math.max(rampErr, Math.abs(env - 0.8 * ((t + 0.05) / 2)));
  }
  metrics.rampMaxErr = r3(rampErr);
  if (rampErr > 0.02) fail('the envelope does not follow the ramp');
  const sym = Math.abs(maxOf(p.top, 2.5, 3.5) + Math.min(...p.bottom.slice(sl(2.5), sl(3.5))));
  metrics.topBottomAsymmetry = r3(sym);
  if (sym > 0.01) fail('top / bottom not symmetric on a sine');
  const sections = [['60Hz', 1.5, 1.95, 'low'], ['1kHz', 2.5, 3.5, 'mid'], ['6kHz', 4.5, 5.5, 'high']];
  for (const [name, a, b, want] of sections) {
    const v = { low: maxOf(p.low, a, b), mid: maxOf(p.mid, a, b), high: maxOf(p.high, a, b) };
    metrics[name] = `low ${r3(v.low)} mid ${r3(v.mid)} high ${r3(v.high)}`;
    const others = Object.keys(v).filter((k) => k !== want).map((k) => v[k]);
    if (!(v[want] > 2 * Math.max(...others))) fail(`${name}: ${want} is not the dominant band`);
  }
  const q = await computePeaks(stereoBuffer(data), { perSecond: 100, fine: false });
  metrics.coarse = `${q.top.length} slices, finePps ${q.finePps}, fine ${q.fineTop.length}`;
  if (q.top.length !== SECONDS * 100 || q.low.length !== SECONDS * 100 || q.finePps !== 0 || q.fineTop.length !== 0) fail('perSecond 100 / fine: false');
  return { pass, metrics };
}

// ---- transport, keylock routing, decode, FX timing (real rendering) ----

/** Nearest element of a sorted numeric array (by value). */
function nearestValue(sorted, v) {
  let lo = 0;
  let hi = sorted.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo] - v) <= Math.abs(sorted[hi] - v) ? sorted[lo] : sorted[hi];
}

/**
 * Records deck positions at every tick (before and after the tick's actions)
 * and returns position(T), linear between ticks, or null where the deck was
 * not playing on both sides.
 */
function positionRecorder(deck) {
  const rec = [];
  return {
    before(t) { rec.push({ t, pre: deck.position, prePlaying: deck.playing }); },
    after() {
      const r = rec[rec.length - 1];
      r.post = deck.position;
      r.postPlaying = deck.playing;
    },
    at(T) {
      if (!rec.length || T < rec[0].t) return null;
      let lo = 0;
      let hi = rec.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (rec[mid].t <= T) lo = mid;
        else hi = mid;
      }
      const a = rec[lo];
      const b = rec[lo + 1];
      if (!b || !a.postPlaying || !b.prePlaying) return null;
      return a.post + ((T - a.t) / (b.t - a.t)) * (b.pre - a.post);
    }
  };
}

/**
 * The HEARD-position model (§6.2, §6.4) through play, seek while playing,
 * pause/resume, a tempo change, a pre-roll seek, a paused seek and a second
 * tempo change, on a direct deck, a keylocked deck and a deck behind a 12.3 ms
 * insert (setInsert latency compensation, §5.5), all running the same script:
 * every rendered click must sound when deck.position equals its file time
 * (±1 ms, ±1.5 ms keylocked), no beat may be skipped or played twice, and
 * nothing may sound while paused.
 */
async function positionModel() {
  requireSuspend();
  const BPM = 120;
  const FIRST = 0.05;
  const TAU = 0.0005; // click decay: its energy centroid sits τ/2 after its start
  const track = clickTrack({ bpm: BPM, seconds: 40, sampleRate: SR, first: FIRST });
  const RENDER = 16;
  const INSERT = 0.0123;
  const rig = await createCaptureRig({ decks: 3, seconds: RENDER });
  try {
    requireWsola(rig.engine);
    const decks = rig.engine.decks;
    decks.forEach((d) => d.load(monoBuffer(track.data), { bpm: BPM, beats: track.beats }));
    rig.attachTaps();
    decks[1].setKeylock(true);
    // deck 2: a DelayNode insert with its latency declared (it is also the tap)
    const insert = rig.context.createDelay(1);
    insert.delayTime.value = INSERT;
    decks[2].setInsert(insert, INSERT);
    insert.connect(rig.merger, 0, 2);
    decks.forEach((d) => d.seek(1.0));
    const script = [
      [0.5, (d) => d.play()],
      [3.0, (d) => d.seek(10.013)],
      [5.0, (d) => d.pause()],
      [5.6, (d) => d.play()],
      [7.0, (d) => d.setTempo(1.05)],
      [9.0, (d) => d.seek(-0.8)],
      [11.5, (d) => d.pause()],
      [12.0, (d) => d.seek(4.02)],
      [12.3, (d) => d.play()],
      [13.5, (d) => d.setTempo(0.95)]
    ];
    const recorders = decks.map(positionRecorder);
    const actionTimes = [];
    let next = 0;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        recorders.forEach((r) => r.before(t));
        while (next < script.length && t >= script[next][0]) {
          decks.forEach(script[next][1]);
          actionTimes.push(t);
          next++;
        }
        recorders.forEach((r) => r.after());
      }
    });
    const beats = track.beats;
    const metrics = { actions: actionTimes.length };
    let pass = actionTimes.length === script.length;
    const nearAction = (T, margin) => actionTimes.some((a) => T >= a && T < a + margin);
    decks.forEach((d, i) => {
      const tag = ['direct', 'keylock', 'insert'][i];
      const pos = recorders[i].at;
      const ev = detectEvents(out.getChannelData(i), SR);
      // segment = index of the last action before T (the script replays some
      // regions on purpose: beats are counted per segment)
      const segmentOf = (T) => actionTimes.filter((a) => a <= T).length;
      const errs = [];
      const heard = new Map(); // `${segment}|${beat}` → count
      let whilePaused = 0;
      let skippedByMargin = 0;
      for (const e of ev) {
        if (nearAction(e.time, 0.1)) {
          skippedByMargin++;
          continue;
        }
        const p = pos(e.time - TAU / 2);
        if (p == null) {
          whilePaused++;
          continue;
        }
        const b = nearestValue(beats, p);
        errs.push(ms(p - b));
        const key = `${segmentOf(e.time)}|${b}`;
        heard.set(key, (heard.get(key) || 0) + 1);
      }
      // Every beat the position swept through (away from the actions) was heard, once per segment
      let missing = 0;
      const swept = new Set();
      for (let T = 0.02; T < RENDER - 0.05; T += 0.0005) {
        const p = pos(T);
        if (p == null || nearAction(T, 0.1)) continue;
        const b = nearestValue(beats, p);
        if (Math.abs(p - b) < 0.0004) swept.add(`${segmentOf(T)}|${b}`);
      }
      for (const key of swept) if (!heard.has(key)) missing++;
      const doubled = [...heard.values()].filter((c) => c > 1).length;
      const absErr = errs.map(Math.abs);
      metrics[`${tag}.clicks`] = errs.length;
      metrics[`${tag}.medianErrMs`] = r3(median(absErr));
      metrics[`${tag}.maxErrMs`] = r3(absErr.length ? Math.max(...absErr) : NaN);
      metrics[`${tag}.meanErrMs`] = r3(mean(errs));
      metrics[`${tag}.swept`] = swept.size;
      metrics[`${tag}.missing`] = missing;
      metrics[`${tag}.doubled`] = doubled;
      metrics[`${tag}.whilePaused`] = whilePaused;
      metrics[`${tag}.nearActions`] = skippedByMargin;
      const lim = i === 1 ? 1.5 : 1;
      if (!(errs.length >= 15 && Math.max(...absErr) <= lim && missing === 0 && doubled === 0 && whilePaused === 0)) pass = false;
    });
    metrics.latencyMs = r3(ms(decks[1].latency));
    metrics.insertLatencyMs = r3(ms(decks[2].latency));
    if (Math.abs(decks[2].latency - INSERT) > 1e-9) pass = false;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * Keylock and key shift switched on and off on a SYNCED follower while it
 * plays (§6.4: two permanent paths, crossfaded; read-ahead compensated): the
 * follower must stay on the master's beats through every switch.
 */
async function keylockToggleSynced() {
  requireSuspend();
  const RENDER = 52;
  const trackA = clickTrack({ bpm: 124, seconds: 70, sampleRate: SR, first: 0.1 });
  const trackB = clickTrack({ bpm: 128, seconds: 70, sampleRate: SR, first: 0.1 });
  const rig = await createCaptureRig({ decks: 2, seconds: RENDER });
  try {
    requireWsola(rig.engine);
    const [d0, d1] = rig.engine.decks;
    d0.load(monoBuffer(trackA.data), { bpm: 124, beats: trackA.beats });
    d1.load(monoBuffer(trackB.data), { bpm: 128, beats: trackB.beats });
    rig.attachTaps();
    d0.play();
    const script = [
      [2, () => { d1.sync(); d1.play(); }],
      [12.01, () => d1.setKeylock(true)],
      [22.01, () => d1.setKeylock(false)],
      [32.01, () => d1.setKey(2)],
      [42.01, () => d1.setKey(0)]
    ];
    const switches = [];
    let next = 0;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        while (next < script.length && t >= script[next][0]) {
          script[next][1]();
          switches.push(t);
          next++;
        }
      }
    });
    const ev0 = detectEvents(out.getChannelData(0), SR);
    const ev1 = detectEvents(out.getChannelData(1), SR);
    const { pairs, unmatched, total } = pairEvents(ev0, ev1, { from: 6, to: RENDER - 1, maxDistance: 0.1 });
    const near = (t) => switches.slice(1).some((s) => t >= s - 0.05 && t < s + 0.25);
    const steady = pairs.filter((p) => !near(p.t)).map((p) => ms(Math.abs(p.offset)));
    const around = pairs.filter((p) => near(p.t)).map((p) => ms(Math.abs(p.offset)));
    // extra events on deck 1 (a click heard twice through a switch)
    const ev1In = ev1.filter((e) => e.time >= 6 && e.time <= RENDER - 1).length;
    const metrics = {
      synced: d1.synced,
      beats: total,
      unmatched,
      extraEvents: ev1In - pairs.length,
      steadyMedianMs: r3(median(steady)),
      steadyP95Ms: r3(percentile(steady, 95)),
      steadyMaxMs: r3(steady.length ? Math.max(...steady) : NaN),
      switchBeats: around.length,
      switchMaxMs: r3(around.length ? Math.max(...around) : NaN),
      keylockLatencyMs: r3(ms(WSOLA_LATENCY_SAMPLES / SR))
    };
    const pass = total >= 80 && unmatched === 0 && metrics.extraEvents === 0 && d1.synced
      && metrics.steadyMedianMs <= 1 && metrics.steadyP95Ms <= 2 && metrics.steadyMaxMs <= 5 && metrics.switchMaxMs <= 5;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * The real decode path of deck.loadFrom(): a 44.1 kHz WAV given as an
 * ArrayBuffer, a Blob and a blob: URL, decoded at the context rate and
 * analyzed; a newer load and an AbortSignal reject with AbortError without
 * touching the deck; undecodable data rejects.
 */
async function loadFromWav() {
  const WAV_SR = 44100;
  const BPM = 126;
  // > 30 s: analyzeBpm only tries its rigid (constant-tempo) grid on tracks
  // longer than 30 s (as in OpenMix); shorter clips get the dynamic tracker
  const SECONDS = 40;
  const track = kickHatTrack({ bpm: BPM, seconds: SECONDS, sampleRate: WAV_SR, first: 0.3, seed: 5, bass: true });
  const wav = encodeWav([track.data, track.data], WAV_SR);
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
  const engine = await createEngine({ context, decks: 1 });
  const metrics = {};
  let pass = true;
  const check = (name, ok, value) => {
    metrics[name] = value === undefined ? ok : value;
    if (!ok) pass = false;
  };
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  try {
    const d = engine.decks[0];
    const loads = [];
    d.on('load', (e) => loads.push(e.track && e.track.title));
    // 1. ArrayBuffer (detached by decoding), full analysis
    const ab = wav.slice(0);
    const r1 = await d.loadFrom(ab, { track: { title: 'array' } });
    check('array.bpm', Math.abs(r1.bpm - BPM) <= 0.05, r1.bpm);
    check('array.rigid', r1.rigid === true, r1.rigid);
    check('array.sampleRate', r1.buffer.sampleRate === SR, r1.buffer.sampleRate);
    check('array.durationErrMs', Math.abs(r1.buffer.duration - SECONDS) < 0.002, r3(ms(r1.buffer.duration - SECONDS)));
    check('array.peaks', !!r1.peaks && r1.peaks.top.length === Math.ceil(r1.buffer.duration * 400), r1.peaks ? r1.peaks.top.length : null);
    check('array.beatErrMs', !!r1.beats && median(r1.beats.filter((b) => b > 0.2 && b < SECONDS - 1)
      .map((b) => ms(Math.abs(b - (0.3 + Math.round((b - 0.3) * BPM / 60) * 60 / BPM))))) <= 3,
      r1.beats ? r3(median(r1.beats.filter((b) => b > 0.2 && b < SECONDS - 1)
        .map((b) => ms(Math.abs(b - (0.3 + Math.round((b - 0.3) * BPM / 60) * 60 / BPM)))))) : null);
    check('array.deckState', d.loaded && d.bpm === r1.bpm && d.peaks === r1.peaks && d.track.title === 'array', true);
    check('array.detached', ab.byteLength === 0, ab.byteLength);
    // 2. Blob, with a given BPM (fixed grid, no BPM analysis)
    const r2 = await d.loadFrom(new Blob([wav], { type: 'audio/wav' }), { bpm: 125, track: { title: 'blob' } });
    check('blob.givenBpm', r2.bpm === 125 && r2.beats === null && r2.rigid === false && d.bpm === 125, `${r2.bpm} beats=${r2.beats}`);
    // 3. blob: URL through fetch, no analysis at all
    const r3v = await d.loadFrom(url, { analyze: false, track: { title: 'url' } });
    check('url.noAnalysis', r3v.bpm === null && r3v.peaks === null && r3v.musicKey === null && d.track.title === 'url', true);
    // 4. A newer load on the same deck aborts the older one
    const older = d.loadFrom(new Blob([wav]), { track: { title: 'older' } });
    const newer = d.loadFrom(new Blob([wav]), { analyze: { key: false, peaks: false }, track: { title: 'newer' } });
    const olderErr = await older.then(() => null, (e) => e);
    const rNewer = await newer;
    check('abort.byNewerLoad', !!olderErr && olderErr.name === 'AbortError' && d.track.title === 'newer'
      && Math.abs(rNewer.bpm - BPM) <= 0.05, olderErr ? olderErr.name : 'resolved');
    // 5. AbortSignal: the deck keeps its track
    const ac = new AbortController();
    const aborted = d.loadFrom(new Blob([wav]), { signal: ac.signal, track: { title: 'aborted' } });
    ac.abort();
    const abortErr = await aborted.then(() => null, (e) => e);
    check('abort.bySignal', !!abortErr && abortErr.name === 'AbortError' && d.track.title === 'newer', abortErr ? abortErr.name : 'resolved');
    // 6. Undecodable data rejects (not an AbortError) and keeps the deck
    const badErr = await d.loadFrom(new Blob([new Uint8Array(4096).fill(7)])).then(() => null, (e) => e);
    check('decodeError.rejects', !!badErr && badErr.name !== 'AbortError' && d.track.title === 'newer', badErr ? `${badErr.name}` : 'resolved');
    check('loadEvents', loads.join(',') === 'array,blob,url,newer', loads.join(','));
  } finally {
    URL.revokeObjectURL(url);
    try { await engine.destroy(); } catch { /* ignore */ }
  }
  return { pass, metrics };
}

/**
 * Beat FX timing: the repeats of feedback echoes (echo, ping-pong, helix)
 * are spaced by beats × the deck's beat duration (tempo included) — every
 * repeat, not only the first — and a TRANS gate opens exactly on the deck's
 * half-beat grid (alignTo, §6.5).
 */
async function fxTiming() {
  requireSuspend();
  const BPM = 124;
  const beatList = (first, bpm, n) => Array.from({ length: n }, (_, k) => first + (k * 60) / bpm);
  // --- feedback echoes: one click per deck, each in its own time window.
  // Every repeat must land on beats × beat duration (tempo included): the
  // feedback-cycle latency of the browser is compensated (fx.js).
  const RENDER = 13;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: RENDER * SR, sampleRate: SR });
  const logs = [];
  const engine = await createEngine({ context, decks: 4, limiter: false, log: (m) => logs.push(m) });
  const metrics = { latencyLog: logs.filter((m) => m.startsWith('fx:')).join(' | ') || 'none (no feedback latency)' };
  let pass = true;
  try {
    const configs = [
      { tag: 'echo½', type: 'echo', beats: 0.5, tempo: 1, click: 1.0, from: 0.5, to: 3.9 },
      { tag: 'echo¾', type: 'echo', beats: 0.75, tempo: 1.05, click: 4.0, from: 3.9, to: 7.9 },
      { tag: 'pingpong½', type: 'pingpong', beats: 0.5, tempo: 0.97, click: 8.0, from: 7.9, to: 10.9 },
      { tag: 'helix¼', type: 'helix', beats: 0.25, tempo: 1, click: 11.0, from: 10.9, to: RENDER }
    ];
    const click = (at) => {
      const data = new Float32Array(30 * SR);
      const s0 = Math.round(at * SR);
      for (let i = 0; i < 0.004 * SR; i++) data[s0 + i] = 0.8 * Math.exp(-i / (0.0005 * SR));
      return monoBuffer(data);
    };
    configs.forEach((c, i) => {
      const d = engine.decks[i];
      // the click is placed so that it SOUNDS at c.click (render time)
      d.load(click((c.click - 0.03) * c.tempo), { bpm: BPM, beats: beatList(0.1, BPM, 60) });
      d.setTempo(c.tempo);
      const u = engine.fx[i];
      u.setType(c.type);
      u.setBeats(c.beats);
      u.setLevel(1);
      u.setEnabled(true);
    });
    engine.decks.forEach((d) => d.play());
    const out = await renderOffline(engine, { tickRate: 60 });
    const L = out.getChannelData(0);
    const R = out.getChannelData(1);
    const mix = new Float32Array(L.length);
    for (let i = 0; i < mix.length; i++) mix[i] = L[i] + R[i];
    configs.forEach((c, i) => {
      const delay = (c.beats * 60) / BPM / c.tempo;
      const a = Math.round(c.from * SR);
      const ev = detectEvents(mix.subarray(a, Math.round(c.to * SR)), SR, { threshold: 0.03, refractory: Math.min(0.05, delay / 3) });
      const gaps = [];
      for (let j = 1; j < Math.min(ev.length, 9); j++) gaps.push((ev[j].onset - ev[j - 1].onset) * SR - delay * SR);
      const worst = gaps.length ? Math.max(...gaps.map(Math.abs)) : NaN;
      metrics[`${c.tag}.repeats`] = ev.length - 1;
      metrics[`${c.tag}.delayMs`] = r3(ms(delay));
      metrics[`${c.tag}.unitBeatMs`] = r3(ms(engine.fx[i].beatDuration));
      metrics[`${c.tag}.gapErrSamples`] = gaps.map((g) => round(g, 1)).join(' ');
      if (!(ev.length >= 5 && worst <= 2)) pass = false;
    });
  } finally {
    try { await engine.destroy(); } catch { /* ignore */ }
  }
  // --- trans gate on a steady 1 kHz tone, 126 BPM grid starting at 0.123 s
  const GATE_BPM = 126;
  const ctx2 = new OfflineAudioContext({ numberOfChannels: 1, length: 6 * SR, sampleRate: SR });
  const e2 = await createEngine({ context: ctx2, decks: 1, limiter: false });
  try {
    const d = e2.decks[0];
    const beats = beatList(0.123, GATE_BPM, 40);
    d.load(monoBuffer(sine({ frequency: 1000, seconds: 12, sampleRate: SR, amplitude: 0.5 })), { bpm: GATE_BPM, beats });
    const u = e2.fx[0];
    u.setType('trans');
    u.setBeats(0.5);
    u.setLevel(1);
    u.setEnabled(true);
    d.play();
    const rec = positionRecorder(d);
    const out = await renderOffline(e2, { tickRate: 60, onTick: (t) => { rec.before(t); rec.after(); } });
    const x = out.getChannelData(0);
    // 1 ms RMS envelope (a whole period of the tone), centered
    const W = SR / 1000;
    const env = new Float32Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) {
      acc += x[i] * x[i];
      if (i >= W) acc -= x[i - W] * x[i - W];
      if (i >= W - 1) env[i - (W >> 1)] = Math.sqrt(Math.max(0, acc) / W);
    }
    let open = 0;
    for (let i = 3 * SR; i < 5 * SR; i++) open = Math.max(open, env[i]);
    const half = beats[1] - beats[0];
    const errs = [];
    for (let i = Math.round(2 * SR); i < Math.round(5.8 * SR); i++) {
      if (env[i - 1] < open / 2 && env[i] >= open / 2) {
        const T = (i - 1 + (open / 2 - env[i - 1]) / (env[i] - env[i - 1])) / SR;
        const p = rec.at(T);
        if (p == null) continue;
        // rising edges on the half-beat grid of the deck
        const f = (p - beats[0]) / (half / 2);
        errs.push(ms((f - Math.round(f)) * (half / 2)));
      }
    }
    const absErr = errs.map(Math.abs);
    metrics['trans.edges'] = errs.length;
    metrics['trans.maxEdgeErrMs'] = r3(absErr.length ? Math.max(...absErr) : NaN);
    metrics['trans.meanEdgeErrMs'] = r3(mean(errs));
    metrics['trans.openLevel'] = r3(open);
    if (!(errs.length >= 10 && Math.max(...absErr) <= 1)) pass = false;
  } finally {
    try { await e2.destroy(); } catch { /* ignore */ }
  }
  return { pass, metrics };
}

/**
 * Slip roll and turntable effects resume exactly where the track would be:
 * after stopRoll() / spinEnd(), the decks sound in phase with an untouched
 * reference deck (direct and keylocked; brake and backspin).
 */
async function rollSpinResume() {
  requireSuspend();
  const BPM = 124;
  const track = clickTrack({ bpm: BPM, seconds: 30, sampleRate: SR, first: 0.1 });
  const RENDER = 12;
  // 0 roll, 1 brake, 2 backspin (keylocked), 3 reference
  const rig = await createCaptureRig({ decks: 4, seconds: RENDER });
  try {
    requireWsola(rig.engine);
    const decks = rig.engine.decks;
    decks.forEach((d) => d.load(monoBuffer(track.data), { bpm: BPM, beats: track.beats }));
    rig.attachTaps();
    decks[2].setKeylock(true);
    decks.forEach((d) => d.play());
    const log = {};
    const script = [
      [3.0, () => { log.roll = decks[0].startRoll(1); log.rollState = decks[0].roll; }],
      [3.0, () => { log.brake = decks[1].spinStart('brake'); }],
      [3.0, () => { log.backspin = decks[2].spinStart('backspin'); log.spinning = decks[2].spinning; }],
      [5.0, () => { decks[0].stopRoll(); log.rollAfter = decks[0].roll; }],
      [4.6, () => decks[1].spinEnd()],
      [4.6, () => decks[2].spinEnd()]
    ].sort((a, b) => a[0] - b[0]);
    let next = 0;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        while (next < script.length && t >= script[next][0]) script[next++][1]();
      }
    });
    const ref = detectEvents(out.getChannelData(3), SR);
    const metrics = {
      startRoll: log.roll,
      rollState: JSON.stringify(log.rollState),
      rollAfterStop: log.rollAfter,
      spinStart: `${log.brake},${log.backspin}`,
      spinning: log.spinning
    };
    let pass = log.roll === true && log.brake === true && log.backspin === true && log.spinning === true && log.rollAfter === null;
    // "Where the track would be": the offset to the reference after the
    // effect equals the offset before it. (A keylocked deck started from stop
    // sounds the transposer latency after a direct one, by design: §6.4.)
    [['roll', 0, 5.3], ['brake', 1, 5.0], ['backspin+keylock', 2, 5.0]].forEach(([tag, i, from]) => {
      const ev = detectEvents(out.getChannelData(i), SR);
      const before = pairEvents(ref, ev, { from: 0.5, to: 2.9, maxDistance: 0.1 }).pairs.map((p) => ms(p.offset));
      const after = pairEvents(ref, ev, { from, to: RENDER - 0.5, maxDistance: 0.1 });
      const base = median(before);
      const dev = after.pairs.map((p) => Math.abs(ms(p.offset) - base));
      metrics[`${tag}.offsetBeforeMs`] = r3(base);
      metrics[`${tag}.beatsAfter`] = after.total;
      metrics[`${tag}.unmatched`] = after.unmatched;
      metrics[`${tag}.maxShiftMs`] = r3(dev.length ? Math.max(...dev) : NaN);
      if (!(before.length >= 3 && after.total >= 10 && after.unmatched === 0 && Math.max(...dev) <= (i === 2 ? 1 : 0.5))) pass = false;
    });
    // During the roll, deck 0 repeats its 1-beat slice: one click per beat, all alike
    const during = detectEvents(out.getChannelData(0), SR).filter((e) => e.time > 3.2 && e.time < 4.9);
    const gaps = [];
    for (let j = 1; j < during.length; j++) gaps.push(Math.abs((during[j].time - during[j - 1].time) - 60 / BPM) * SR);
    const peaks = during.map((e) => e.peak);
    metrics['roll.repeats'] = during.length;
    metrics['roll.maxGapErrSamples'] = r3(gaps.length ? Math.max(...gaps) : NaN);
    metrics['roll.peakSpread'] = r3(peaks.length ? Math.max(...peaks) - Math.min(...peaks) : NaN);
    if (!(during.length >= 3 && Math.max(...gaps) <= 1 && Math.max(...peaks) - Math.min(...peaks) < 0.02)) pass = false;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * engine.setMasterBpm() / setMasterTempo() while a synced follower plays:
 * the follower follows in the same call (§6.3) and stays on the beats.
 */
async function masterTempoFollow() {
  requireSuspend();
  const RENDER = 32;
  const trackA = clickTrack({ bpm: 124, seconds: 60, sampleRate: SR, first: 0.1 });
  const trackB = clickTrack({ bpm: 128, seconds: 60, sampleRate: SR, first: 0.1 });
  const rig = await createCaptureRig({ decks: 2, seconds: RENDER });
  try {
    const [d0, d1] = rig.engine.decks;
    d0.load(monoBuffer(trackA.data), { bpm: 124, beats: trackA.beats });
    d1.load(monoBuffer(trackB.data), { bpm: 128, beats: trackB.beats });
    rig.attachTaps();
    d0.play();
    const log = {};
    const script = [
      [2, () => { d1.sync(); d1.play(); }],
      [10.01, () => {
        log.setBpm = rig.engine.setMasterBpm(130);
        log.bpmSameCall = `${round(rig.engine.masterBpm, 3)}/${round(d1.effectiveBpm, 3)}`;
      }],
      [20.01, () => {
        log.setTempo = rig.engine.setMasterTempo(0.97);
        log.tempoSameCall = `${round(rig.engine.masterBpm, 3)}/${round(d1.effectiveBpm, 3)}`;
      }]
    ];
    let next = 0;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => {
        while (next < script.length && t >= script[next][0]) script[next++][1]();
      }
    });
    const ev0 = detectEvents(out.getChannelData(0), SR);
    const ev1 = detectEvents(out.getChannelData(1), SR);
    const { pairs, unmatched, total } = pairEvents(ev0, ev1, { from: 6, to: RENDER - 1, maxDistance: 0.1 });
    const abs = pairs.map((p) => ms(Math.abs(p.offset)));
    const metrics = {
      ...log,
      masterIndex: rig.engine.masterIndex,
      finalMasterBpm: round(rig.engine.masterBpm, 3),
      finalFollowerBpm: round(d1.effectiveBpm, 3),
      beats: total,
      unmatched,
      medianMs: r3(median(abs)),
      p95Ms: r3(percentile(abs, 95)),
      maxMs: r3(abs.length ? Math.max(...abs) : NaN)
    };
    const [m1, f1] = String(log.bpmSameCall).split('/').map(Number);
    const [m2, f2] = String(log.tempoSameCall).split('/').map(Number);
    const pass = log.setBpm === true && log.setTempo === true && rig.engine.masterIndex === 0
      && Math.abs(m1 - 130) < 1e-6 && Math.abs(f1 - 130) < 0.01 && Math.abs(m2 - 124 * 0.97) < 1e-6 && Math.abs(f2 - m2) < 0.01
      && total >= 50 && unmatched === 0 && metrics.medianMs <= 1 && metrics.p95Ms <= 2 && metrics.maxMs <= 5;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * Stems (§5.5): a click track split into two stems plays in phase with the
 * full mix on another deck; a muted stem is silent; keylock switched on with a
 * stem muted keeps it muted (the switch's tail too); clearStems() goes back to
 * the full mix seamlessly. Every check is on the rendered output.
 */
async function stemsSync() {
  requireSuspend();
  const BPM = 120;
  const FIRST = 0.1;
  const full = clickTrack({ bpm: BPM, seconds: 30, sampleRate: SR, first: FIRST, accent: 0.6 });
  const n = full.data.length;
  const odd = new Float32Array(n);  // beats 0, 2, 4…
  const even = new Float32Array(n); // beats 1, 3, 5…
  full.beats.forEach((b, k) => {
    const s0 = Math.round(b * SR);
    const dst = k % 2 === 0 ? odd : even;
    for (let i = 0; i < 0.004 * SR && s0 + i < n; i++) dst[s0 + i] = full.data[s0 + i];
  });
  const RENDER = 12;
  const rig = await createCaptureRig({ decks: 2, seconds: RENDER });
  try {
    requireWsola(rig.engine);
    const [ref, d] = rig.engine.decks;
    ref.load(monoBuffer(full.data), { bpm: BPM, beats: full.beats });
    d.load(monoBuffer(full.data), { bpm: BPM, beats: full.beats });
    d.loadStems({ drums: monoBuffer(odd), other: monoBuffer(even) });
    rig.attachTaps();
    ref.play();
    d.play();
    const log = { active: d.stemsActive };
    const script = [
      [3.01, () => { d.setStem('drums', false); log.muted = d.stemStates.drums; }],
      [5.01, () => { d.setKeylock(true); }],
      [7.01, () => { d.setStem('drums', true); }],
      [9.01, () => { d.clearStems(); log.cleared = d.stemsActive; }]
    ];
    let next = 0;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => { while (next < script.length && t >= script[next][0]) script[next++][1](); }
    });
    const evRef = detectEvents(out.getChannelData(0), SR);
    const ev = detectEvents(out.getChannelData(1), SR, { threshold: 0.1 });
    const lat = ms(WSOLA_LATENCY_SAMPLES / SR);
    const window = (a, b, shiftMs = 0) => {
      const refs = evRef.filter((e) => e.time >= a && e.time < b);
      let met = 0;
      let missing = 0;
      const offs = [];
      for (const e of refs) {
        const want = e.time + shiftMs / 1000;
        const near = ev.reduce((m, f) => (Math.abs(f.time - want) < Math.abs(m.time - want) ? f : m), { time: Infinity });
        if (Math.abs(near.time - want) < 0.003) {
          met++;
          offs.push(Math.abs(ms(near.time - want)));
        } else {
          missing++;
        }
      }
      return { refs: refs.length, met, missing, maxMs: offs.length ? r3(Math.max(...offs)) : null };
    };
    // which beat each reference click is (beats 0, 2, 4… are in the muted stem)
    const beatIndex = (T) => Math.round((T - 0.03 - FIRST) * BPM / 60);
    const metrics = { stemsActive: log.active, mutedState: log.muted, clearedActive: log.cleared };
    const both = window(0.5, 2.9);
    // drums muted, direct path: only the odd beats sound
    const mutedRefs = evRef.filter((e) => e.time >= 3.2 && e.time < 4.9);
    const mutedHeard = mutedRefs.filter((e) => ev.some((f) => Math.abs(f.time - e.time) < 0.003));
    const leaks = mutedHeard.filter((e) => beatIndex(e.time) % 2 === 0).length;
    // keylock on (heard one latency later: played from the running deck, read ahead), drums still muted
    const lockedRefs = evRef.filter((e) => e.time >= 5.3 && e.time < 6.9);
    const lockedLeaks = lockedRefs.filter((e) => beatIndex(e.time) % 2 === 0
      && ev.some((f) => Math.abs(f.time - e.time) < 0.003)).length;
    const lockedOdd = lockedRefs.filter((e) => beatIndex(e.time) % 2 === 1);
    const lockedMet = lockedOdd.filter((e) => ev.some((f) => Math.abs(f.time - e.time) < 0.003)).length;
    const unmuted = window(7.3, 8.9);
    const cleared = window(9.3, RENDER - 0.5);
    metrics.bothStems = JSON.stringify(both);
    metrics['drumsMuted.heard'] = `${mutedHeard.length}/${mutedRefs.length}`;
    metrics['drumsMuted.leaks'] = leaks;
    metrics['keylockMuted.oddMet'] = `${lockedMet}/${lockedOdd.length}`;
    metrics['keylockMuted.leaks'] = lockedLeaks;
    metrics.unmuted = JSON.stringify(unmuted);
    metrics.cleared = JSON.stringify(cleared);
    metrics.keylockLatencyMs = r3(lat);
    const pass = log.active === true && log.muted === false && log.cleared === false
      && both.missing === 0 && both.met >= 4 && both.maxMs <= 0.1
      && leaks === 0 && mutedHeard.length >= 1
      && lockedLeaks === 0 && lockedMet === lockedOdd.length && lockedOdd.length >= 1
      && unmuted.missing === 0 && unmuted.met >= 3 && unmuted.maxMs <= 1.5
      && cleared.missing === 0 && cleared.met >= 3 && cleared.maxMs <= 1.5;
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/**
 * Deliberate offsets (§6.3): a small nudge is pulled back toward exact
 * alignment (the visual magnet, through the inaudible servo: a ~6 s time
 * constant), a large one is ADOPTED and held without drift, and a scratch
 * released near the beat snaps back onto it at once (scrubEnd → snap →
 * reanchor). Measured on the rendered output of a synced follower.
 */
async function manualOffsets() {
  requireSuspend();
  const RENDER = 30;
  const trackA = clickTrack({ bpm: 124, seconds: 60, sampleRate: SR, first: 0.1 });
  const trackB = clickTrack({ bpm: 128, seconds: 60, sampleRate: SR, first: 0.1 });
  const rig = await createCaptureRig({ decks: 2, seconds: RENDER });
  try {
    const [d0, d1] = rig.engine.decks;
    d0.load(monoBuffer(trackA.data), { bpm: 124, beats: trackA.beats });
    d1.load(monoBuffer(trackB.data), { bpm: 128, beats: trackB.beats });
    rig.attachTaps();
    d0.play();
    const log = {};
    const script = [
      [2, () => { d1.sync(); d1.play(); }],
      // small nudge: +2 % for 0.3 s ≈ 5.8 ms (0.012 beat): the magnet pulls it back
      [8.01, () => { log.nudge1 = d1.nudge(0.02); log.hold1 = rig.engine.syncHold; }],
      [8.31, () => { d1.endNudge(); log.release1 = rig.engine.syncHold; }],
      // large nudge: +6 % for 0.7 s ≈ 40.7 ms (0.084 beat): adopted and held
      [14.01, () => { log.nudge2 = d1.nudge(0.06); }],
      [14.71, () => d1.endNudge()],
      // scratch 20 ms back (the restart adds the 30 ms scheduling): released
      // within the magnet's 0.06 beat, it snaps onto the beat
      [21.01, () => {
        d1.scrubStart({ audible: false });
        d1.scrubMove(d1.position - 0.02 * d1.tempo);
        d1.scrubEnd();
        log.scrubbing = d1.scrubbing;
      }]
    ];
    let next = 0;
    const out = await renderOffline(rig.engine, {
      tickRate: 60,
      onTick: (t) => { while (next < script.length && t >= script[next][0]) script[next++][1](); }
    });
    const ev0 = detectEvents(out.getChannelData(0), SR);
    const ev1 = detectEvents(out.getChannelData(1), SR);
    const phase = (a, b) => {
      const { pairs, unmatched } = pairEvents(ev0, ev1, { from: a, to: b, maxDistance: 0.1 });
      const o = pairs.map((p) => ms(p.offset));
      return {
        n: o.length,
        unmatched,
        mean: r3(mean(o)),
        spread: o.length ? r3(Math.max(...o) - Math.min(...o)) : null
      };
    };
    const before = phase(5, 8);
    const smallEarly = phase(8.6, 10.1);
    const smallLate = phase(12.5, 14);
    const adopted = phase(16.5, 21);
    const afterScratch = phase(24, RENDER - 0.5);
    // the large nudge gains 6 % of 0.7 s of real time on the master (deck 1 earlier)
    const wantAdopted = smallLate.mean - 0.06 * 0.7 * 1000;
    const metrics = {
      ...log,
      synced: d1.synced,
      before: JSON.stringify(before),
      smallNudgeEarly: JSON.stringify(smallEarly),
      smallNudgeLate: JSON.stringify(smallLate),
      adoptedOffset: JSON.stringify(adopted),
      adoptedExpectedMs: r3(wantAdopted),
      afterScratch: JSON.stringify(afterScratch)
    };
    const pass = log.nudge1 === true && log.hold1 === true && log.release1 === false && log.nudge2 === true
      && log.scrubbing === false && d1.synced
      && Math.abs(before.mean) <= 0.1
      && smallEarly.mean < -3 && smallEarly.mean > -9 && smallLate.mean < 0 && smallLate.mean > 0.7 * smallEarly.mean
      && Math.abs(adopted.mean - wantAdopted) <= 2 && adopted.spread <= 1
      && Math.abs(afterScratch.mean) <= 0.5 && afterScratch.spread <= 1
      && [before, smallEarly, smallLate, adopted, afterScratch].every((p) => p.unmatched === 0 && p.n >= 3);
    return { pass, metrics };
  } finally {
    await rig.dispose();
  }
}

/** Two engines on ONE context: the worklet module is added once and both get WSOLA (§5.3). */
async function twoEnginesOneContext() {
  requireSuspend();
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 9 * SR, sampleRate: SR });
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  const [e1, e2] = await Promise.all([
    createEngine({ context, output: sink, decks: 1 }),
    createEngine({ context, output: sink, decks: 1 })
  ]);
  const e3 = await createEngine({ context, output: sink, decks: 1 });
  try {
    const metrics = {
      pitchEngines: [e1, e2, e3].map((e) => e.pitchEngine).join(','),
      errors: [e1, e2, e3].map((e) => (e.pitchEngineError ? e.pitchEngineError.message : '')).join('|')
    };
    // the last engine's keylock really works: +3 semitones on a 440 Hz tone
    const d = e3.decks[0];
    d.load(monoBuffer(sine({ frequency: 440, seconds: 12, sampleRate: SR, amplitude: 0.5 })));
    const tap = context.createGain();
    d.setInsert(tap, 0);
    const merger = context.createChannelMerger(2);
    tap.connect(merger, 0, 0);
    merger.connect(context.destination);
    d.setKey(3);
    d.play();
    const out = await renderOffline(e3, { tickRate: 60 });
    const expected = 440 * Math.pow(2, 3 / 12);
    const est = estimateFrequency(out.getChannelData(0), SR, { startSec: 2, endSec: 8, expected });
    metrics['e3.key+3.cents'] = r3(cents(est.frequency, expected));
    const pass = metrics.pitchEngines === 'wsola,wsola,wsola' && Math.abs(metrics['e3.key+3.cents']) <= 5;
    return { pass, metrics };
  } finally {
    for (const e of [e1, e2, e3]) {
      try { await e.destroy(); } catch { /* ignore */ }
    }
  }
}

/** The suite: DESIGN §10.2 first, then the additional checks. */
export const TESTS = [
  { name: 'sync-60s', run: () => syncTest({ keylock: false }) },
  { name: 'sync-keylock-60s', run: () => syncTest({ keylock: true }) },
  { name: 'keylock-pitch', run: keylockPitch },
  { name: 'loop-precision', run: loopPrecision },
  { name: 'beatloop-quantize', run: beatloopQuantize },
  { name: 'analysis-bpm', run: analysisBpm },
  { name: 'analysis-key', run: analysisKey },
  { name: 'peaks', run: peaksTest },
  { name: 'cue-routing', run: cueRouting },
  { name: 'render-cpu', run: renderCpu, info: true },
  { name: 'analysis-bpm-clicks', run: analysisBpmClicks },
  { name: 'analysis-key-major', run: analysisKeyMajor },
  { name: 'sync-midtrack-bars', run: syncMidTrack },
  { name: 'eq-kill-60hz', run: eqKill60Hz },
  { name: 'crossfader-extremes', run: crossfaderExtremes },
  { name: 'keylock-8pct', run: keylockPlus8 },
  { name: 'loop-4-beats', run: loopFourBeats },
  { name: 'peaks-shape', run: peaksShape },
  { name: 'position-model', run: positionModel },
  { name: 'keylock-toggle-synced', run: keylockToggleSynced },
  { name: 'loadfrom-wav', run: loadFromWav },
  { name: 'fx-timing', run: fxTiming },
  { name: 'roll-spin-resume', run: rollSpinResume },
  { name: 'master-tempo-follow', run: masterTempoFollow },
  { name: 'two-engines-one-context', run: twoEnginesOneContext },
  { name: 'stems-sync', run: stemsSync },
  { name: 'manual-offsets', run: manualOffsets }
];
