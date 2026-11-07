// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §17.6):
// the fallback to the Web engine (engine.js). Order matters:
//   1. await window.omEngine.kill(): main kills the engine host and resolves
//      on its exit (a hung-but-alive host would otherwise keep playing under
//      the Web engine: double audio);
//   2. freeze the transport model at that instant (positions and playing
//      flags stop moving; user actions meanwhile still update the mirrors);
//   3. new AudioEngine(); output device and headphones FIRST, before any sound;
//   4-5. (async part) the WSOLA worklet nodes (<= 1 s, so keylocked decks do
//      not start on the two-tap fallback and re-route with a glitch) and the
//      stems, rebuilt from the cached separation;
//   then in ONE synchronous step (no user action can interleave): mixer, FX
//      and assignment, master choice; every deck with a buffer: loadTrack
//      with the mirrors, tempo, sync fields, key, keylock, cue point, loop,
//      stems and their gains, seek to the frozen position;
//   6. play() the decks that were playing;
//   8. every facade (same identities, the context shim held by Library
//      included) now forwards to the Web objects;
//   7. VST: a vst.js VstHost restores the saved slots, skipping suspects;
//   onFallback(reason) lets app.js tell the user.

import { AudioEngine } from '../engine.js';
import { decodeStemSet } from '../stems.js';
import { withTimeout } from './env.js';
import { STEMS } from './deck.js';

export const KILL_TIMEOUT_MS = 1500;
export const WSOLA_WAIT_MS = 1000;
export const STEMS_WAIT_MS = 8000;

const sleep = (env, ms) => new Promise((r) => env.setTimeout(r, ms));

/** Waits until every Web deck has its WSOLA worklet node (or `ms` passed). */
export async function waitWsola(env, web, ms = WSOLA_WAIT_MS) {
  const t0 = env.now();
  while (env.now() - t0 < ms) {
    if (web.decks.every((d) => d.wsola)) return true;
    await sleep(env, 20);
  }
  return web.decks.every((d) => d.wsola);
}

const isAudioBuffer = (b) => b && typeof b.getChannelData === 'function';

/** Rebuilds a deck's stems for the Web engine: the AudioBuffers if still there, else the cached separation. */
async function rebuildStems(env, web, deck) {
  const st = deck._stems;
  const track = deck._track;
  if (!st) return null;
  if (isAudioBuffer(st.vocals) && isAudioBuffer(st.drums) && isAudioBuffer(st.bass)) return st;
  if (!track || !track.path || !env.api || !env.api.stemsSeparate) return null;
  const res = await env.api.stemsSeparate(track.path);
  if (!res || !res.ok || !res.stems) return null;
  const out = await decodeStemSet(res.stems, web.ctx, {
    orig: deck._buffer,
    readFile: env.api.readFile ? (p) => env.api.readFile(p) : undefined,
    isCancelled: () => deck._track !== track
  });
  if (!out) return null;
  // the stems object app.js holds keeps its identity: real buffers again
  st.vocals = out.stems.vocals;
  st.drums = out.stems.drums;
  st.bass = out.stems.bass;
  return st;
}

export async function runFallback(e, reason, { kill = true, suspects = false } = {}) {
  const env = e.env;
  const log = env.log;
  log.warn?.(`[engine] falling back to the Web Audio engine: ${reason}`);

  // 1. the engine host must be gone before the Web engine makes a sound
  if (kill && env.omEngine && typeof env.omEngine.kill === 'function') {
    try { await withTimeout(env, env.omEngine.kill(), KILL_TIMEOUT_MS, 'kill timeout'); } catch (err) {
      log.warn?.(`[engine] kill: ${err.message || err}`);
    }
  }
  if (suspects) for (const h of e._vstHosts) h.markLoadedSuspects();
  const rec = e._rec;
  e._closeLink(reason);

  // 2. freeze the transport (engineNow() stops; predictions keep working on the mirrors)
  e._frozenNow = e.engineNow();

  // 3. the Web engine, its outputs first
  const Ctor = env.AudioEngine || AudioEngine;
  const web = new Ctor();
  e._webPending = web;
  try { web.resume(); } catch { /* resumed on the next gesture */ }
  if (e._sinkId) {
    try { await web.ctx.setSinkId(e._sinkId); } catch (err) { log.warn?.(`[engine] fallback output: ${err.message || err}`); }
  }
  try { web._wireOutput(); } catch { /* default wiring */ }
  if (e._phonesId) {
    try { await web.setPhonesDevice(e._phonesId); } catch { /* master 3/4 */ }
  }

  // 4-5. async preparations: WSOLA nodes, stems
  const needWsola = e.decks.some((d) => d._buffer && (d._keylock || d._keyShift));
  const stemJobs = e.decks.map((d) => (d._buffer && d._stems
    ? rebuildStems(env, web, d).catch((err) => { log.warn?.(`[engine] stems deck ${d.id + 1}: ${err.message || err}`); return null; })
    : Promise.resolve(null)));
  const urgent = stemJobs.filter((_, i) => e.decks[i]._stemsOn);
  await Promise.all([
    needWsola ? waitWsola(env, web) : null,
    urgent.length ? withTimeout(env, Promise.all(urgent), STEMS_WAIT_MS, 'stems timeout').catch(() => null) : null
  ]);
  const stemSets = await Promise.all(stemJobs.map((p, i) => (e.decks[i]._stemsOn ? Promise.race([p, Promise.resolve(null)]) : null)));

  // ---- one synchronous step from here: mixer, FX, decks, play, delegation ----
  e.decks.forEach((d, i) => {
    const wd = web.decks[i];
    wd.setVolume(d._volume);
    for (const b of ['low', 'mid', 'high']) wd.setEq(b, d._eq[b]);
    wd.setTrim(d._trimVal);
    web.setCuePfl(i, d._cueOn);
  });
  web.setColorType(e._colorType);
  web.setColorEnabled(e._colorEnabled);
  e.decks.forEach((d, i) => web.setDeckColor(i, d._filterVal));
  web.setCrossfader(e._crossfader);
  web.setMasterVolume(e._masterVolume);
  web.setMasterFilter(e._masterFilterVal);
  e.fx.forEach((u, k) => {
    const wu = web.fx[k];
    wu.setType(u._type);
    wu.setBeatsMult(u._beatsMult);
    wu.setLevel(u._level);
    wu.setEnabled(u._enabled);
    wu.setBeatDur(u._beatDur);
  });
  web.fxAssign = e._fxAssign.map((a) => [0, 1, 2, 3].map((k) => !!(a && a[k])));
  web.updateFxSends();
  if (e._masterFx) {
    const m = e._masterFx;
    const wm = web.ensureMasterFx();
    wm.setType(m._type);
    wm.setBeatsMult(m._beatsMult);
    wm.setLevel(m._level);
    wm.setEnabled(m._enabled);
  }
  e.padFx.forEach((p, i) => {
    if (p && p._enabled) web.setPadFx(i, { type: p._type, beats: p._beatsMult, level: p._level });
  });
  web.masterIdx = e._masterIdx;
  web.jogHold = e._jogHold;

  const toPlay = [];
  e.decks.forEach((d, i) => {
    const wd = web.decks[i];
    wd.onEnded = () => { if (typeof d._onEnded === 'function') d._onEnded(); };
    if (!d._buffer) return;
    const pos = d._wrap(d._model.value(e._frozenNow));
    wd.loadTrack({
      buffer: d._buffer, bpm: d._bpm, peaks: d._peaks, track: d._track, beatOffset: d._beatOffset,
      hotCues: d._hotCues, beats: d._beats, gridShift: d._gridShift, barAnchor: d._barAnchor
    });
    wd.beats = d._beats;   // loadTrack drops lists of <= 2 beats; keep the mirror exactly
    wd.musicKey = d._musicKey;
    wd.setTempo(d._tempo);
    wd.synced = d._synced;
    wd._syncBase = d._syncBaseV;
    wd._syncRef = d._syncRefV;
    wd._pllCorr = d._pllCorrV;
    wd.setKeylock(d._keylock);
    wd.setKey(d._keyShift);
    wd.cuePoint = d._cuePoint;
    if (d._looping) wd.setLoop(d._loopStart, d._loopEnd);
    wd._loopBeats = d._loopBeatsV;
    wd._padDryHold = d._padDryHoldV;
    wd._padRoll = d._padRollV;
    // only real AudioBuffers: stubs left by the handoff would break AudioBufferSourceNode
    if (d._stems && isAudioBuffer(d._stems.vocals)) wd.stems = d._stems;
    const set = stemSets[i];
    if (d._stemsOn && set && isAudioBuffer(set.vocals)) {
      wd.loadStems(set);
      for (const k of STEMS) wd.stemGains[k].gain.value = d.stemGains[k].gain._v;
    }
    wd.seek(pos);
    if (d._playing) toPlay.push(wd);
  });
  // 6. playback resumes for every deck at the same instant (relative alignment kept)
  for (const wd of toPlay) wd.play();

  // 8. from now on every facade forwards to the Web engine
  e._attachWeb(web);
  // stems not needed at once: attached when ready (the deck keeps its stems object)
  stemJobs.forEach((p, i) => {
    if (e.decks[i]._stemsOn) return;
    p.then((set) => { if (set && web.decks[i].track === e.decks[i]._track) web.decks[i].stems = set; });
  });
  if (rec) e._emit({ type: 'rec.status', active: false, error: 'engine stopped', path: rec.path, fallback: true });

  // 7. VST plugins on the Web engine (suspects skipped)
  for (const h of e._vstHosts) {
    try { await h._toWeb(web); } catch (err) { log.warn?.(`[engine] VST fallback: ${err.message || err}`); }
  }
  return web;
}
