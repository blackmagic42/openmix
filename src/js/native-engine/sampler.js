// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §7.2.12, §10.9):
// the sampler bank. app.js decodes each pad sound and calls
// engine.preloadSample(buffer); the facade maps AudioBuffer -> engine slot
// (WeakMap, 32 slots, the least recently used one evicted), hands the PCM
// off and sends `sampler.load {slot, loadId}` in the same batch as its
// pcm.begin (ordered on the ctl port). A pad hit before the handoff completes
// is armed by the engine (it starts when the first chunk arrives, <= 250 ms).

export const SAMPLER_SLOTS = 32;
export const SAMPLER_VOICES = 16;     // voices mixed by the engine at once (oldest stolen)
// Voice ids: one unique id per started source (AudioBufferSourceNode), never
// recycled within a session (2^31 - 1 hits). app.js keeps each pad's last
// source and stops it on the next hit of that pad, even long after it
// ended: a recycled id would then cut another pad's sound.
export const VOICE_ID_LIMIT = 0x7fffffff;

export class SamplerBank {
  constructor(engine) {
    this._e = engine;
    this.slots = new Array(SAMPLER_SLOTS).fill(null);   // { buffer, stream, loadId, lastUse }
    this.map = new WeakMap();                            // AudioBuffer -> slot
    this.pending = [];                                   // buffers preloaded before the engine was ready
    this.nextVoice = 0;
    this.stats = { loads: 0, evictions: 0, plays: 0 };
  }

  _slotOf(buffer) {
    const i = this.map.get(buffer);
    return i != null && this.slots[i] && this.slots[i].buffer === buffer ? i : -1;
  }

  /** engine.preloadSample(buffer): hand the sound off now (or as soon as the engine is ready). */
  preload(buffer) {
    if (!buffer || typeof buffer.copyFromChannel !== 'function') return -1;
    const e = this._e;
    const known = this._slotOf(buffer);
    if (known >= 0) {
      this.slots[known].lastUse = e.env.now();
      return known;
    }
    if (e.status !== 'native') {
      if (e.status === 'connecting' && !this.pending.includes(buffer)) this.pending.push(buffer);
      return -1;
    }
    let slot = this.slots.findIndex((s) => !s);
    if (slot < 0) {
      // least recently used slot
      slot = 0;
      for (let i = 1; i < this.slots.length; i++) if (this.slots[i].lastUse < this.slots[slot].lastUse) slot = i;
      const old = this.slots[slot];
      if (old.stream) e.pcm.abort(old.stream);
      this.map.delete(old.buffer);
      this.stats.evictions++;
    }
    const stream = e.pcm.start({
      kind: 'sample', buffer, format: 's16', headroom: 0, peak: 0, owner: this, priority: () => 3, focusSec: 0
    });
    this.slots[slot] = { buffer, stream, loadId: stream.loadId, lastUse: e.env.now() };
    this.map.set(buffer, slot);
    this.stats.loads++;
    e._link.request({ cmd: 'sampler.load', slot, loadId: stream.loadId }).then((r) => {
      if (!r.ok && this.slots[slot] && this.slots[slot].loadId === stream.loadId) {
        e.env.log.warn?.(`[engine] sampler slot ${slot}: ${r.error || 'load failed'}`);
      }
    });
    return slot;
  }

  /** A pad hit (SourceShim.start): returns the voice used, or -1. */
  play(buffer, gain) {
    let slot = this._slotOf(buffer);
    if (slot < 0) slot = this.preload(buffer);
    if (slot < 0) return -1;
    this.slots[slot].lastUse = this._e.env.now();
    const voice = this.nextVoice;
    this.nextVoice = (this.nextVoice + 1) % VOICE_ID_LIMIT;
    this.stats.plays++;
    this._e._send({ cmd: 'sampler.play', slot, voice, gain });
    return voice;
  }

  stop(voice) {
    this._e._send({ cmd: 'sampler.stop', voice });
  }

  /** Engine ready: the sounds decoded meanwhile are handed off. */
  onReady() {
    const list = this.pending.splice(0);
    for (const b of list) this.preload(b);
  }

  /** A sample stream failed: forget the slot (the next hit hands the sound off again). */
  onStreamFailed(stream) {
    const i = this.slots.findIndex((s) => s && s.stream === stream);
    if (i < 0) return;
    this.map.delete(this.slots[i].buffer);
    this.slots[i] = null;
  }

  reset() {
    this.slots.fill(null);
    this.map = new WeakMap();
    this.pending.length = 0;
  }
}
