// VST3 plugins on the decks — page side.
//
//   page (this file) ── messages ──▶ vst-worker.js (Node) ──▶ native host
//        │                                                    ▲
//        └── AudioWorkletNode 'vst-insert' ◀── shared ring ───┘
//
// One insert slot per deck. The chosen plugin and its settings are saved
// per deck and reloaded at the next launch. A crash guard skips the
// automatic reload of a plugin that was being loaded when OpenMix last
// stopped unexpectedly.

const FRAMES = 128;   // Web Audio render quantum
const BLOCKS = 32;    // ring size (blocks)
const HDR_INTS = 16;
const H_FRAMES = 4;
const H_BLOCKS = 5;
const H_CH = 6;
const H_BPM = 8;
const SAVE_KEY = (i) => `vstSlot${i}`;
const LOADING_KEY = 'vstLoading';
const LIST_KEY = 'vstPlugins';

const readJson = (k, def) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; }
};
const writeJson = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch { /* storage unavailable */ }
};

export class VstHost {
  // opts.slotBase: first native slot used (a second host — tests — must not
  // share the decks' slots); opts.persist: false = never touch the saved slots
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.slotBase = opts.slotBase || 0;
    this.persist = opts.persist !== false;
    this.available = false;
    this.error = null;
    this.plugins = readJson(LIST_KEY, []);
    this.slots = engine.decks.map(() => null); // { plugin, node, sab, fhdr, latency, mix }
    this._seq = 0;
    this._pending = new Map();
    this._sabs = engine.decks.map(() => null);
  }

  async init() {
    try {
      const info = await window.api.vstInfo();
      if (!info || !info.available) {
        this.error = (info && info.reason) || 'unavailable';
        return false;
      }
      if (typeof SharedArrayBuffer === 'undefined') {
        this.error = 'SharedArrayBuffer disabled';
        return false;
      }
      this.info = info;
      this.worker = new Worker(new URL('./vst-worker.js', import.meta.url));
      this.worker.onmessage = (e) => {
        const p = this._pending.get(e.data.id);
        if (!p) return;
        this._pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.res);
        else p.reject(new Error(e.data.error));
      };
      await this._call('init', { modulePath: info.modulePath, sampleRate: this.engine.ctx.sampleRate, blockSize: FRAMES });
      await this.engine.ctx.audioWorklet.addModule(new URL('./vst-worklet.js', import.meta.url));
      // Blocks to wait for: the sound card's callback (bursts of blocks) + margin
      const cb = Math.ceil(((this.engine.ctx.baseLatency || 0.01) * this.engine.ctx.sampleRate) / FRAMES);
      this.latencyBlocks = Math.max(4, Math.min(16, cb + 2));
      this.available = true;
      // tempo of each deck for tempo-synced plugins (delays, LFOs…)
      this._bpmTimer = setInterval(() => this._pushBpm(), 200);
      return true;
    } catch (err) {
      this.error = String(err.message || err);
      this.available = false;
      return false;
    }
  }

  _call(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  // Lists the installed VST3 plugins (cached; rescan on demand)
  async scan() {
    if (!this.available) return [];
    const files = await window.api.vstListFiles();
    const found = await this._call('scan', { paths: files });
    found.sort((a, b) => a.name.localeCompare(b.name));
    this.plugins = found;
    if (this.persist) writeJson(LIST_KEY, found);
    return found;
  }

  _ring(slot) {
    if (this._sabs[slot]) return this._sabs[slot];
    const bytes = (HDR_INTS + BLOCKS * 2 * FRAMES * 2) * 4;
    const sab = new SharedArrayBuffer(bytes);
    const hdr = new Int32Array(sab, 0, HDR_INTS);
    hdr[H_FRAMES] = FRAMES;
    hdr[H_BLOCKS] = BLOCKS;
    hdr[H_CH] = 2;
    const ring = { sab, fhdr: new Float32Array(sab, 0, HDR_INTS), hdr, attached: false };
    this._sabs[slot] = ring;
    return ring;
  }

  // Loads a plugin on a deck (replaces the previous one). state = saved settings (base64)
  async load(deckIdx, plugin, state) {
    if (!this.available) return { ok: false, error: this.error || 'unavailable' };
    const ring = this._ring(deckIdx);
    if (!ring.attached) {
      await this._call('attach', { slot: this.slotBase + deckIdx, sab: ring.sab });
      ring.attached = true;
    }
    if (this.persist) writeJson(LOADING_KEY, { deck: deckIdx, path: plugin.path });
    let r;
    try {
      r = await this._call('load', { slot: this.slotBase + deckIdx, path: plugin.path, uid: plugin.uid, state: state || null });
    } finally {
      if (this.persist) writeJson(LOADING_KEY, null);
    }
    if (!r.ok) {
      await this.unload(deckIdx, true);
      return r;
    }
    const deck = this.engine.decks[deckIdx];
    let slot = this.slots[deckIdx];
    if (!slot || !slot.node) {
      const node = new AudioWorkletNode(this.engine.ctx, 'vst-insert', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { sab: ring.sab, frames: FRAMES, blocks: BLOCKS, latencyBlocks: this.latencyBlocks }
      });
      slot = { node, mix: 1 };
    }
    slot.plugin = { path: plugin.path, uid: plugin.uid, name: r.name || plugin.name, vendor: plugin.vendor || '' };
    slot.pluginLatency = r.latency || 0;
    slot.latency = (this.latencyBlocks * FRAMES + slot.pluginLatency) / this.engine.ctx.sampleRate;
    this.slots[deckIdx] = slot;
    slot.node.parameters.get('mix').value = slot.mix;
    deck.setInsert(slot.node, slot.latency);
    this._pushBpm();
    this.save(deckIdx);
    return { ok: true, name: slot.plugin.name, latency: slot.latency };
  }

  async unload(deckIdx, quiet) {
    const slot = this.slots[deckIdx];
    if (slot && slot.node) {
      this.engine.decks[deckIdx].setInsert(null, 0);
      try { slot.node.disconnect(); } catch { /* not connected */ }
    }
    this.slots[deckIdx] = null;
    if (this.available) await this._call('unload', { slot: this.slotBase + deckIdx }).catch(() => {});
    if (!quiet && this.persist) writeJson(SAVE_KEY(deckIdx), null);
  }

  openEditor(deckIdx) {
    if (!this.slots[deckIdx]) return Promise.resolve({ ok: false, error: 'no plugin' });
    return this._call('openEditor', { slot: this.slotBase + deckIdx, owner: this.info.owner || null });
  }

  // Dry/wet: 0 = bypass (the latency stays, so the sync never moves)
  setMix(deckIdx, mix) {
    const slot = this.slots[deckIdx];
    if (!slot) return;
    slot.mix = Math.max(0, Math.min(1, mix));
    slot.node.parameters.get('mix').setTargetAtTime(slot.mix, this.engine.ctx.currentTime, 0.01);
    this.save(deckIdx, true);
  }

  // Saves the plugin + its settings for this deck (state read from the plugin)
  async save(deckIdx, quick) {
    const slot = this.slots[deckIdx];
    if (!slot || !this.persist) return;
    const prev = readJson(SAVE_KEY(deckIdx), {}) || {};
    let state = prev.state || null;
    if (!quick) state = await this._call('getState', { slot: this.slotBase + deckIdx }).catch(() => state);
    writeJson(SAVE_KEY(deckIdx), { plugin: slot.plugin, mix: slot.mix, state });
  }

  saveAll() {
    return Promise.all(this.slots.map((s, i) => (s ? this.save(i) : null)));
  }

  // Reloads the plugins saved per deck (skips one that crashed OpenMix)
  async restore() {
    if (!this.available || !this.persist) return;
    const crashed = readJson(LOADING_KEY, null);
    writeJson(LOADING_KEY, null);
    for (let i = 0; i < this.slots.length; i++) {
      const saved = readJson(SAVE_KEY(i), null);
      if (!saved || !saved.plugin) continue;
      if (crashed && crashed.deck === i && crashed.path === saved.plugin.path) {
        this.lastCrash = saved.plugin.name;
        writeJson(SAVE_KEY(i), null);
        continue;
      }
      const r = await this.load(i, saved.plugin, saved.state).catch((e) => ({ ok: false, error: String(e.message || e) }));
      if (r.ok && saved.mix != null) this.setMix(i, saved.mix);
    }
  }

  status(deckIdx) {
    return this._call('status', { slot: this.slotBase + deckIdx });
  }

  // blocks the plugin delivered too late (the dry sound was played instead)
  underruns(deckIdx) {
    const ring = this._sabs[deckIdx];
    return ring ? Atomics.load(ring.hdr, 3) : 0;
  }

  _pushBpm() {
    this.slots.forEach((slot, i) => {
      if (!slot) return;
      const d = this.engine.decks[i];
      const ring = this._sabs[i];
      if (!ring) return;
      ring.fhdr[H_BPM] = d.bpm ? d.bpm * (d.tempo || 1) : 0;
    });
  }
}
