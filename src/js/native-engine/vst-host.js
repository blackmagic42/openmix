// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §13.5-13.7, §17.6):
// NativeVstHost, the vst.js VstHost API (init, scan, load, unload,
// openEditor, setMix, save, saveAll, restore, status, underruns, slots,
// plugins, available, error, lastCrash) on top of the engine's vst.*
// commands: in native mode the VST3 plugins run INSIDE the engine (per-deck
// real-time workers, latency compensated by reading ahead).
//
// Crash safety: before each vst.load the plugin is recorded as a SUSPECT in
// localStorage.nativeVstSuspects and cleared when the load succeeds;
// vst.crashed / vst.hung and an engine death or stall while a plugin was
// loaded keep (or put) it there. Suspects are skipped by the restore at the
// next start and by the fallback restore (the user can load them again by
// hand). The saved slots (vstSlot0..3) and the plugin list (vstPlugins) are
// the same as vst.js's, so a setup moves freely between the two engines.
// After a fallback a vst.js VstHost of the Web engine takes over.

import { VstHost } from '../vst.js';
import { clamp } from './env.js';

export const SUSPECTS_KEY = 'nativeVstSuspects';
const SAVE_KEY = (i) => `vstSlot${i}`;
const LIST_KEY = 'vstPlugins';

export class NativeVstHost {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.persist = opts.persist !== false;
    this._available = false;
    this._error = null;
    this._plugins = engine.env.storage.getJson(LIST_KEY, []) || [];
    this._slots = engine.decks.map(() => null);   // { plugin, mix, latency }
    this._lastCrash = null;
    this._web = null;                               // vst.js VstHost after a fallback
    this._toWebP = null;
    this.info = null;
    engine._vstHosts.push(this);
  }

  get _store() { return this.engine.env.storage; }

  get available() { return this._web ? this._web.available : this._available; }
  get error() { return this._web ? this._web.error : this._error; }
  get slots() { return this._web ? this._web.slots : this._slots; }
  get plugins() { return this._web ? this._web.plugins : this._plugins; }
  set plugins(v) { if (this._web) this._web.plugins = v; else this._plugins = v; }
  get lastCrash() { return this._lastCrash || (this._web ? this._web.lastCrash : null); }
  set lastCrash(v) { this._lastCrash = v; }

  // ---- suspects ------------------------------------------------------------------

  suspects() {
    const v = this._store.getJson(SUSPECTS_KEY, []);
    return Array.isArray(v) ? v.filter((s) => s && s.path != null) : [];
  }

  _isSuspect(deck, path) {
    return this.suspects().some((s) => s.deck === deck && s.path === path);
  }

  _addSuspect(deck, path) {
    if (!this.persist || !path) return;
    const list = this.suspects().filter((s) => !(s.deck === deck && s.path === path));
    list.push({ deck, path });
    this._store.setJson(SUSPECTS_KEY, list.slice(-16));
  }

  _removeSuspect(deck, path) {
    if (!this.persist) return;
    const list = this.suspects().filter((s) => !(s.deck === deck && s.path === path));
    this._store.setJson(SUSPECTS_KEY, list.length ? list : null);
  }

  /** Engine death / stall while plugins were loaded: they all become suspects. */
  markLoadedSuspects() {
    this._slots.forEach((s, i) => { if (s && s.plugin) this._addSuspect(i, s.plugin.path); });
  }

  // ---- lifecycle -----------------------------------------------------------------

  async init() {
    const outcome = await this.engine.whenSettled;
    if (this._web || outcome === 'web') {
      await this._toWeb(this.engine._web || this.engine._webPending);
      return !!this.available;
    }
    // VST3 stays opt-in in native mode too (owner decision: Settings > VST3,
    // off by default): main's vst-info answers reason 'disabled' while it is
    // off, and then nothing is listed, scanned, loaded or restored. Any other
    // reason concerns the Web engine's own host module, not the engine's.
    const api = this.engine.env.api;
    if (api && typeof api.vstInfo === 'function') {
      let info = null;
      try { info = await api.vstInfo(); } catch { /* no answer: the engine decides */ }
      if (info && info.available === false && info.reason === 'disabled') {
        this._available = false;
        this._error = 'disabled';
        return false;
      }
    }
    this._available = true;
    this._error = null;
    return true;
  }

  async scan() {
    if (this._web) return this._web.scan();
    if (!this._available) return [];
    const env = this.engine.env;
    const files = env.api && env.api.vstListFiles ? await env.api.vstListFiles() : [];
    let found = env.omEngine && env.omEngine.vstScan ? await env.omEngine.vstScan(files) : [];
    if (typeof found === 'string') {
      try { found = JSON.parse(found); } catch { found = []; }
    }
    if (found && !Array.isArray(found)) found = found.plugins || [];
    found = (found || []).filter((p) => p && p.path && !p.error);  // per-file scan errors (V22) are not plugins
    found.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    this._plugins = found;
    if (this.persist) this._store.setJson(LIST_KEY, found);
    return found;
  }

  async load(deckIdx, plugin, state) {
    if (this._web) return this._web.load(deckIdx, plugin, state);
    if (!this._available) return { ok: false, error: this._error || 'unavailable' };
    const link = this.engine._link;
    if (!link || this.engine.status !== 'native') return { ok: false, error: 'native engine not active' };
    this._addSuspect(deckIdx, plugin.path);
    const cmd = { cmd: 'vst.load', deck: deckIdx, path: plugin.path, uid: plugin.uid || '' };
    if (state) cmd.state = state;
    const r = await link.request(cmd);
    if (this.engine.status !== 'native') {
      // the engine died, hung or stalled while this plugin was loading: it stays a suspect,
      // and is not loaded again by the fallback (the user can load it by hand)
      return { ok: false, error: 'the engine stopped while loading the plugin', code: 'crashed' };
    }
    if (!r.ok) {
      // a plugin that crashed or hung while loading stays a suspect
      if (r.code !== 'crashed' && r.code !== 'hung') this._removeSuspect(deckIdx, plugin.path);
      await this.unload(deckIdx, true);
      return { ok: false, error: r.error || r.code || 'load failed', code: r.code };
    }
    this._removeSuspect(deckIdx, plugin.path);
    const prev = this._slots[deckIdx];
    const rate = this.engine._deviceRate || 48000;
    const slot = {
      plugin: { path: plugin.path, uid: plugin.uid, name: r.name || plugin.name, vendor: plugin.vendor || '' },
      mix: prev ? prev.mix : 1,
      pluginLatency: r.latency || 0,
      latency: (r.latency || 0) / rate,
      late: 0
    };
    this._slots[deckIdx] = slot;
    if (slot.mix !== 1) this.engine._send({ cmd: 'vst.mix', deck: deckIdx, mix: slot.mix });
    this.save(deckIdx);
    return { ok: true, name: slot.plugin.name, latency: slot.latency };
  }

  async unload(deckIdx, quiet) {
    if (this._web) return this._web.unload(deckIdx, quiet);
    this._slots[deckIdx] = null;
    const link = this.engine._link;
    if (link && this.engine.status === 'native') await link.request({ cmd: 'vst.unload', deck: deckIdx });
    if (!quiet && this.persist) this._store.setJson(SAVE_KEY(deckIdx), null);
  }

  openEditor(deckIdx) {
    if (this._web) return this._web.openEditor(deckIdx);
    if (!this._slots[deckIdx]) return Promise.resolve({ ok: false, error: 'no plugin' });
    const link = this.engine._link;
    if (!link) return Promise.resolve({ ok: false, error: 'native engine not active' });
    return link.request({ cmd: 'vst.editor', deck: deckIdx }).then((r) => ({ ok: !!r.ok, error: r.error }));
  }

  /** Dry/wet: 0 = bypass (the latency stays, so the sync never moves). */
  setMix(deckIdx, mix) {
    if (this._web) return this._web.setMix(deckIdx, mix);
    const slot = this._slots[deckIdx];
    if (!slot) return;
    slot.mix = clamp(mix, 0, 1);
    this.engine._send({ cmd: 'vst.mix', deck: deckIdx, mix: slot.mix });
    this.save(deckIdx, true);
  }

  async save(deckIdx, quick) {
    if (this._web) return this._web.save(deckIdx, quick);
    const slot = this._slots[deckIdx];
    if (!slot || !this.persist) return;
    const prev = this._store.getJson(SAVE_KEY(deckIdx), {}) || {};
    let state = prev.state || null;
    const link = this.engine._link;
    if (!quick && link && this.engine.status === 'native') {
      const r = await link.request({ cmd: 'vst.getState', deck: deckIdx });
      if (r.ok && typeof r.state === 'string' && r.state) state = r.state;
    }
    if (this._slots[deckIdx] !== slot) return;
    this._store.setJson(SAVE_KEY(deckIdx), { plugin: slot.plugin, mix: slot.mix, state });
  }

  saveAll() {
    if (this._web) return this._web.saveAll();
    return Promise.all(this._slots.map((s, i) => (s ? this.save(i) : null)));
  }

  /** Reloads the plugins saved per deck, skipping the suspects. */
  async restore() {
    if (this._web) {
      if (this._restoredWeb) return undefined;   // the fallback already restored the slots
      this._restoredWeb = true;
      return this._restoreInto(this._web);
    }
    if (!this._available || !this.persist) return;
    for (let i = 0; i < this._slots.length; i++) {
      const saved = this._store.getJson(SAVE_KEY(i), null);
      if (!saved || !saved.plugin) continue;
      if (this._isSuspect(i, saved.plugin.path)) {
        this._lastCrash = saved.plugin.name;
        continue;
      }
      const r = await this.load(i, saved.plugin, saved.state).catch((e) => ({ ok: false, error: String(e.message || e) }));
      if (r.ok && saved.mix != null) this.setMix(i, saved.mix);
    }
  }

  async _restoreInto(web) {
    if (!web.available || !this.persist) return;
    for (let i = 0; i < web.slots.length; i++) {
      const saved = this._store.getJson(SAVE_KEY(i), null);
      if (!saved || !saved.plugin) continue;
      if (this._isSuspect(i, saved.plugin.path)) {
        this._lastCrash = saved.plugin.name;
        continue;
      }
      const r = await web.load(i, saved.plugin, saved.state).catch((e) => ({ ok: false, error: String(e.message || e) }));
      if (r.ok && saved.mix != null) web.setMix(i, saved.mix);
    }
  }

  status(deckIdx) {
    if (this._web) return this._web.status(deckIdx);
    const link = this.engine._link;
    if (!link) return Promise.resolve({ ok: false, error: 'native engine not active' });
    return link.request({ cmd: 'vst.status', deck: deckIdx });
  }

  /** Blocks the plugin delivered too late (its latency-aligned dry was played instead). */
  underruns(deckIdx) {
    if (this._web) return this._web.underruns(deckIdx);
    const st = this.engine._lastState;
    const d = st && Array.isArray(st.decks) ? st.decks[deckIdx] : null;
    const slot = this._slots[deckIdx];
    // The snapshot's insert counter (every late block since the plugin was
    // loaded, SPEC.md §15.5) while it reports a plugin on this deck; the
    // vst.late events counted here only before the first such snapshot (the
    // events come at most once per second and the engine rate-limits the
    // late bits, so they undercount).
    if (d && d.insert && (d.insert.state | 0) !== 0) return d.insert.late | 0;
    return slot ? slot.late | 0 : 0;
  }

  /** vst.crashed / vst.hung / vst.late / vst.latency events. */
  _onEngineEvent(ev) {
    const i = ev.deck;
    const slot = this._slots[i];
    if (ev.ev === 'vst.crashed' || ev.ev === 'vst.hung') {
      if (slot) {
        this._addSuspect(i, slot.plugin.path);
        slot.dead = ev.ev === 'vst.crashed' ? 'crashed' : 'hung';
      }
      this.engine.env.log.warn?.(`[engine] VST on deck ${i + 1} ${ev.ev === 'vst.crashed' ? 'crashed' : 'hung'}: bypassed for the session`);
    } else if (ev.ev === 'vst.late') {
      if (slot) slot.late = (slot.late || 0) + (ev.count || 1);
    } else if (ev.ev === 'vst.latency') {
      if (slot && ev.latency != null) {
        slot.pluginLatency = ev.latency;
        slot.latency = ev.latency / (this.engine._deviceRate || 48000);
      }
      if (slot && ev.refused) slot.dead = 'latency';
    }
  }

  /** Fallback: a vst.js VstHost on the Web engine takes over, restoring the saved slots minus the suspects. */
  _toWeb(webEngine) {
    if (this._toWebP) return this._toWebP;
    this._toWebP = (async () => {
      if (!webEngine) return;
      const Ctor = this.engine.env.VstHost || VstHost;
      const web = new Ctor(webEngine, { persist: this.persist });
      if (!web.plugins || !web.plugins.length) web.plugins = this._plugins;
      this._web = web;
      let ok = false;
      try { ok = await web.init(); } catch { ok = false; }
      this._restoredWeb = true;
      if (ok) await this._restoreInto(web);
    })();
    return this._toWebP;
  }
}
