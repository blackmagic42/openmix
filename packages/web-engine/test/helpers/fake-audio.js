// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// A minimal FAKE Web Audio API for the Node unit tests (DESIGN §10.1). It
// models what the engine touches, without any DSP (silent by construction):
// - node factories whose connect()/disconnect() record the graph edges;
// - AudioParam with immediate `value` updates for set*/*Ramp*/setTargetAtTime,
//   plus a recorded event log (`param.events`);
// - AudioBufferSourceNode with start/stop/onended/loop*/playbackRate: the read
//   position is simulated by advance(), including the natural end of a track;
// - createBuffer, an analyser that returns zeros, audioWorklet.addModule
//   (configurable to resolve or reject) and a fake AudioWorkletNode that
//   installFakeAudioGlobals() puts on globalThis;
// - a controllable clock: ctx.advance(seconds);
// - a fake OfflineAudioContext with suspend/resume/startRendering.

const PITCH_PROCESSOR = 'openmix-pitch-shift';

function finite(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${what}: the provided float value is non-finite (${String(v)})`);
  }
}

function nonNegTime(t, what) {
  finite(t, what);
  if (t < 0) throw new RangeError(`${what}: negative time (${t})`);
}

// ------------------------------------------------------------------ params --

export class FakeAudioParam {
  constructor(context, value = 0, name = 'param') {
    this.context = context;
    this.name = name;
    this.defaultValue = value;
    this.minValue = -3.4028234663852886e38;
    this.maxValue = 3.4028234663852886e38;
    this.automationRate = 'a-rate';
    this._value = value;
    /** Recorded automation calls: { type, value, time, ... } */
    this.events = [];
  }

  get value() {
    return this._value;
  }

  set value(v) {
    finite(v, `${this.name}.value`);
    this._value = v;
    this.events.push({ type: 'value', value: v, time: this.context.currentTime });
  }

  setValueAtTime(v, t) {
    finite(v, `${this.name}.setValueAtTime`);
    nonNegTime(t, `${this.name}.setValueAtTime`);
    this._value = v;
    this.events.push({ type: 'setValueAtTime', value: v, time: t });
    return this;
  }

  linearRampToValueAtTime(v, t) {
    finite(v, `${this.name}.linearRampToValueAtTime`);
    nonNegTime(t, `${this.name}.linearRampToValueAtTime`);
    this._value = v;
    this.events.push({ type: 'linearRampToValueAtTime', value: v, time: t });
    return this;
  }

  exponentialRampToValueAtTime(v, t) {
    finite(v, `${this.name}.exponentialRampToValueAtTime`);
    nonNegTime(t, `${this.name}.exponentialRampToValueAtTime`);
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime: value must not be 0');
    this._value = v;
    this.events.push({ type: 'exponentialRampToValueAtTime', value: v, time: t });
    return this;
  }

  setTargetAtTime(v, t, timeConstant) {
    finite(v, `${this.name}.setTargetAtTime`);
    nonNegTime(t, `${this.name}.setTargetAtTime`);
    finite(timeConstant, `${this.name}.setTargetAtTime timeConstant`);
    if (timeConstant < 0) throw new RangeError('setTargetAtTime: negative time constant');
    this._value = v;
    this.events.push({ type: 'setTargetAtTime', value: v, time: t, timeConstant });
    return this;
  }

  setValueCurveAtTime(curve, t, duration) {
    nonNegTime(t, `${this.name}.setValueCurveAtTime`);
    if (curve.length) this._value = curve[curve.length - 1];
    this.events.push({ type: 'setValueCurveAtTime', value: this._value, time: t, duration });
    return this;
  }

  cancelScheduledValues(t) {
    nonNegTime(t, `${this.name}.cancelScheduledValues`);
    this.events.push({ type: 'cancelScheduledValues', time: t });
    return this;
  }

  cancelAndHoldAtTime(t) {
    nonNegTime(t, `${this.name}.cancelAndHoldAtTime`);
    this.events.push({ type: 'cancelAndHoldAtTime', time: t });
    return this;
  }

  /** The last automation event of a type (or of any type). */
  last(type) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (!type || this.events[i].type === type) return this.events[i];
    }
    return null;
  }
}

// ------------------------------------------------------------------- nodes --

export class FakeAudioNode {
  constructor(context, { inputs = 1, outputs = 1, channelCount = 2, channelCountMode = 'max' } = {}) {
    this.context = context;
    this.numberOfInputs = inputs;
    this.numberOfOutputs = outputs;
    this._channelCount = channelCount;
    this._channelCountMode = channelCountMode;
    this._channelInterpretation = 'speakers';
    context._nodeCount++;
  }

  get channelCount() { return this._channelCount; }
  set channelCount(v) { this._channelCount = v; }
  get channelCountMode() { return this._channelCountMode; }
  set channelCountMode(v) { this._channelCountMode = v; }
  get channelInterpretation() { return this._channelInterpretation; }
  set channelInterpretation(v) { this._channelInterpretation = v; }

  connect(dest, output = 0, input = 0) {
    const isNode = dest instanceof FakeAudioNode;
    const isParam = dest instanceof FakeAudioParam;
    if (!isNode && !isParam) throw new TypeError('connect: the destination must be an AudioNode or an AudioParam');
    if (dest.context !== this.context) throw new Error('InvalidAccessError: connecting nodes of different contexts');
    if (!(output >= 0 && output < this.numberOfOutputs)) throw new RangeError(`IndexSizeError: output ${output}`);
    if (isNode && !(input >= 0 && input < dest.numberOfInputs)) throw new RangeError(`IndexSizeError: input ${input}`);
    const edges = this.context._edges;
    const exists = edges.some((e) => e.from === this && e.to === dest && e.output === output && e.input === (isNode ? input : 0));
    if (!exists) edges.push({ from: this, to: dest, output, input: isNode ? input : 0 });
    return isNode ? dest : undefined;
  }

  disconnect(dest, output, input) {
    const ctx = this.context;
    if (dest === undefined) {
      ctx._edges = ctx._edges.filter((e) => e.from !== this);
      return;
    }
    if (typeof dest === 'number') {
      const out = dest;
      const before = ctx._edges.length;
      ctx._edges = ctx._edges.filter((e) => !(e.from === this && e.output === out));
      if (ctx._edges.length === before) throw new Error('InvalidAccessError: output not connected');
      return;
    }
    const match = (e) => e.from === this && e.to === dest
      && (output === undefined || e.output === output)
      && (input === undefined || e.input === input);
    if (!ctx._edges.some(match)) throw new Error('InvalidAccessError: the destination is not connected');
    ctx._edges = ctx._edges.filter((e) => !match(e));
  }
}

export class FakeGainNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.gain = new FakeAudioParam(context, 1, 'gain');
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.type = 'lowpass';
    this.frequency = new FakeAudioParam(context, 350, 'frequency');
    this.Q = new FakeAudioParam(context, 1, 'Q');
    this.gain = new FakeAudioParam(context, 0, 'gain');
    this.detune = new FakeAudioParam(context, 0, 'detune');
  }

  getFrequencyResponse() {}
}

export class FakeDelayNode extends FakeAudioNode {
  constructor(context, maxDelayTime = 1) {
    super(context);
    this.maxDelayTime = maxDelayTime;
    this.delayTime = new FakeAudioParam(context, 0, 'delayTime');
  }
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.threshold = new FakeAudioParam(context, -24, 'threshold');
    this.knee = new FakeAudioParam(context, 30, 'knee');
    this.ratio = new FakeAudioParam(context, 12, 'ratio');
    this.attack = new FakeAudioParam(context, 0.003, 'attack');
    this.release = new FakeAudioParam(context, 0.25, 'release');
    this.reduction = 0;
  }
}

export class FakeAnalyserNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.fftSize = 2048;
    this.minDecibels = -100;
    this.maxDecibels = -30;
    this.smoothingTimeConstant = 0.8;
  }

  get frequencyBinCount() { return this.fftSize / 2; }

  // The fake carries no signal: always silence
  getFloatTimeDomainData(array) { array.fill(0); }
  getByteTimeDomainData(array) { array.fill(128); }
  getFloatFrequencyData(array) { array.fill(-Infinity); }
  getByteFrequencyData(array) { array.fill(0); }
}

export class FakeConvolverNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.buffer = null;
    this.normalize = true;
  }
}

export class FakeWaveShaperNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.curve = null;
    this.oversample = 'none';
  }
}

export class FakeStereoPannerNode extends FakeAudioNode {
  constructor(context) {
    super(context);
    this.pan = new FakeAudioParam(context, 0, 'pan');
  }
}

export class FakeChannelMergerNode extends FakeAudioNode {
  constructor(context, inputs = 6) {
    super(context, { inputs, outputs: 1 });
  }
}

export class FakeChannelSplitterNode extends FakeAudioNode {
  constructor(context, outputs = 6) {
    super(context, { inputs: 1, outputs });
  }
}

export class FakeMediaStreamAudioDestinationNode extends FakeAudioNode {
  constructor(context) {
    super(context, { inputs: 1, outputs: 0 });
    this.stream = { id: `stream-${++context._streamIds}`, getTracks: () => [] };
  }
}

export class FakeMediaStreamAudioSourceNode extends FakeAudioNode {
  constructor(context, stream) {
    super(context, { inputs: 0, outputs: 1 });
    this.mediaStream = stream;
  }
}

export class FakeAudioDestinationNode extends FakeAudioNode {
  constructor(context, { maxChannelCount = 2, offline = false } = {}) {
    super(context, { inputs: 1, outputs: 0, channelCount: offline ? maxChannelCount : 2, channelCountMode: 'explicit' });
    this.maxChannelCount = maxChannelCount;
    this._offline = offline;
    this.settingsLog = [];
  }

  get channelCount() { return this._channelCount; }

  set channelCount(v) {
    this.settingsLog.push(['channelCount', v]);
    // an OfflineAudioContext destination rejects channelCount changes
    if (this._offline) throw new Error('InvalidStateError: cannot change the channel count of an offline destination');
    if (!(v >= 1 && v <= this.maxChannelCount)) throw new RangeError(`IndexSizeError: channelCount ${v}`);
    this._channelCount = v;
  }

  get channelCountMode() { return this._channelCountMode; }

  set channelCountMode(v) {
    this.settingsLog.push(['channelCountMode', v]);
    this._channelCountMode = v;
  }

  get channelInterpretation() { return this._channelInterpretation; }

  set channelInterpretation(v) {
    this.settingsLog.push(['channelInterpretation', v]);
    this._channelInterpretation = v;
  }
}

// Scheduled sources: start/stop/onended. The 'ended' event is dispatched by
// ctx.advance(), after the clock moved (asynchronously, as in browsers).
export class FakeScheduledSourceNode extends FakeAudioNode {
  constructor(context) {
    super(context, { inputs: 0, outputs: 1 });
    this.onended = null;
    this.startTime = null;
    this.stopTime = null;
    this.ended = false;
    this.endedAt = null;
    this.startArgs = null;
    context._sources.add(this);
  }

  start(when = 0, ...rest) {
    if (this.startTime !== null) throw new Error('InvalidStateError: start() called twice');
    nonNegTime(when, 'start');
    this.startTime = when;
    this.startArgs = [when, ...rest];
  }

  stop(when = 0) {
    if (this.startTime === null) throw new Error('InvalidStateError: stop() before start()');
    nonNegTime(when, 'stop');
    if (this.ended) return;
    this.stopTime = when;
  }

  // Simulates [t0, t1): returns the end time when the source ends in it
  _advance(t0, t1) {
    if (this.ended || this.startTime === null) return null;
    const stopAt = this.stopTime === null ? Infinity : this.stopTime;
    if (stopAt <= t1) return Math.max(stopAt, t0);
    return null;
  }
}

export class FakeOscillatorNode extends FakeScheduledSourceNode {
  constructor(context) {
    super(context);
    this.type = 'sine';
    this.frequency = new FakeAudioParam(context, 440, 'frequency');
    this.detune = new FakeAudioParam(context, 0, 'detune');
  }
}

export class FakeConstantSourceNode extends FakeScheduledSourceNode {
  constructor(context) {
    super(context);
    this.offset = new FakeAudioParam(context, 1, 'offset');
  }
}

export class FakeAudioBufferSourceNode extends FakeScheduledSourceNode {
  constructor(context) {
    super(context);
    this.buffer = null;
    this.playbackRate = new FakeAudioParam(context, 1, 'playbackRate');
    this.detune = new FakeAudioParam(context, 0, 'detune');
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    /** Simulated read position in the buffer (s). */
    this.readPos = 0;
    this._limit = Infinity;
  }

  start(when = 0, offset = 0, ...rest) {
    const duration = rest[0];
    super.start(when, offset, ...rest);
    finite(offset, 'start offset');
    if (offset < 0) throw new RangeError('start: negative offset');
    const dur = this.buffer ? this.buffer.duration : 0;
    this.readPos = Math.min(offset, dur);
    this._limit = duration === undefined ? dur : Math.min(dur, offset + duration);
  }

  _advance(t0, t1) {
    if (this.ended || this.startTime === null) return null;
    const stopAt = this.stopTime === null ? Infinity : this.stopTime;
    const from = Math.max(t0, this.startTime);
    const segEnd = Math.min(t1, stopAt);
    if (segEnd > from && this.buffer) {
      const rate = this.playbackRate.value;
      const dt = segEnd - from;
      const dur = this.buffer.duration;
      let ls = this.loopStart;
      let le = this.loopEnd;
      if (!(le > ls) || le === 0) {
        ls = 0;
        le = dur;
      }
      if (this.loop && le > ls) {
        this.readPos += dt * rate;
        if (this.readPos >= le) this.readPos = ls + ((this.readPos - ls) % (le - ls));
      } else if (rate > 0) {
        const need = (this._limit - this.readPos) / rate;
        if (need <= dt) {
          this.readPos = this._limit;
          return from + Math.max(0, need);
        }
        this.readPos += dt * rate;
      }
    }
    if (stopAt <= t1) return Math.max(stopAt, t0);
    return null;
  }
}

// Installed on globalThis as AudioWorkletNode by installFakeAudioGlobals()
export class FakeAudioWorkletNode extends FakeAudioNode {
  constructor(context, name, options = {}) {
    super(context, {
      inputs: options.numberOfInputs ?? 1,
      outputs: options.numberOfOutputs ?? 1,
      channelCount: options.channelCount ?? 2
    });
    if (context._workletNodeThrows) throw new Error('InvalidStateError: the worklet node could not be created');
    if (!context._registered.has(name)) throw new Error(`InvalidStateError: processor '${name}' is not registered`);
    this.processorName = name;
    this.options = options;
    this.parameters = new Map([['ratio', new FakeAudioParam(context, 1, 'ratio')]]);
    const port = {
      messages: [],
      onmessage: null,
      postMessage(m) { port.messages.push(m); }
    };
    this.port = port;
  }
}

// ----------------------------------------------------------------- buffers --

export class FakeAudioBuffer {
  constructor({ numberOfChannels = 1, length, sampleRate = 48000 } = {}) {
    if (!(length >= 1)) throw new RangeError(`NotSupportedError: buffer length ${length}`);
    this.numberOfChannels = numberOfChannels;
    this.length = Math.floor(length);
    this.sampleRate = sampleRate;
    this.duration = this.length / sampleRate;
    this._data = Array.from({ length: numberOfChannels }, () => new Float32Array(this.length));
  }

  getChannelData(c) {
    if (!(c >= 0 && c < this.numberOfChannels)) throw new RangeError(`IndexSizeError: channel ${c}`);
    return this._data[c];
  }

  copyToChannel(source, c, start = 0) {
    const d = this.getChannelData(c);
    d.set(source.subarray(0, Math.max(0, d.length - start)), start);
  }

  copyFromChannel(dest, c, start = 0) {
    const d = this.getChannelData(c);
    dest.set(d.subarray(start, start + dest.length));
  }
}

// ---------------------------------------------------------------- contexts --

class FakeBaseAudioContext {
  constructor({ sampleRate = 48000, maxChannelCount = 2, offline = false, worklet = 'resolve', workletNodeThrows = false } = {}) {
    this.sampleRate = sampleRate;
    this._time = 0;
    this._edges = [];
    this._sources = new Set();
    this._listeners = new Map();
    this._nodeCount = 0;
    this._streamIds = 0;
    this._registered = new Set();
    this._workletNodeThrows = workletNodeThrows;
    this.workletCalls = [];
    this.destination = new FakeAudioDestinationNode(this, { maxChannelCount, offline });
    this.listener = {};
    if (worklet !== 'none') {
      this.audioWorklet = {
        addModule: (url) => {
          this.workletCalls.push(String(url));
          if (worklet === 'reject') return Promise.reject(new Error('AbortError: the module could not be loaded'));
          this._registered.add(PITCH_PROCESSOR);
          return Promise.resolve();
        }
      };
    }
    /** Decoding behavior: a function (arrayBuffer) => AudioBuffer, or an Error to reject with. */
    this.decodeResult = null;
    this.decodeCalls = [];
  }

  get currentTime() {
    return this._time;
  }

  /**
   * Moves the clock forward, simulates the sources and dispatches their
   * 'ended' events (in time order, after the clock moved).
   * @param {number} seconds
   */
  advance(seconds) {
    if (!(seconds >= 0)) throw new RangeError('advance: seconds must be >= 0');
    const t0 = this._time;
    const t1 = t0 + seconds;
    const ended = [];
    for (const s of this._sources) {
      const at = s._advance(t0, t1);
      if (at != null) {
        s.ended = true;
        s.endedAt = at;
        ended.push(s);
      }
    }
    this._time = t1;
    ended.sort((a, b) => a.endedAt - b.endedAt);
    for (const s of ended) {
      this._sources.delete(s);
      if (typeof s.onended === 'function') s.onended({ type: 'ended', target: s });
    }
  }

  // --- factories ---
  createGain() { return new FakeGainNode(this); }
  createBiquadFilter() { return new FakeBiquadFilterNode(this); }
  createDelay(max = 1) { return new FakeDelayNode(this, max); }
  createDynamicsCompressor() { return new FakeDynamicsCompressorNode(this); }
  createAnalyser() { return new FakeAnalyserNode(this); }
  createConvolver() { return new FakeConvolverNode(this); }
  createWaveShaper() { return new FakeWaveShaperNode(this); }
  createStereoPanner() { return new FakeStereoPannerNode(this); }
  createChannelMerger(n = 6) { return new FakeChannelMergerNode(this, n); }
  createChannelSplitter(n = 6) { return new FakeChannelSplitterNode(this, n); }
  createOscillator() { return new FakeOscillatorNode(this); }
  createConstantSource() { return new FakeConstantSourceNode(this); }
  createBufferSource() { return new FakeAudioBufferSourceNode(this); }

  createBuffer(numberOfChannels, length, sampleRate) {
    return new FakeAudioBuffer({ numberOfChannels, length, sampleRate });
  }

  decodeAudioData(data, onSuccess, onError) {
    this.decodeCalls.push(data);
    let result;
    let error = null;
    if (this.decodeResult instanceof Error) {
      error = this.decodeResult;
    } else if (typeof this.decodeResult === 'function') {
      result = this.decodeResult(data);
    } else {
      result = new FakeAudioBuffer({ numberOfChannels: 2, length: this.sampleRate * 10, sampleRate: this.sampleRate });
    }
    const p = error ? Promise.reject(error) : Promise.resolve(result);
    p.then((b) => { if (onSuccess) onSuccess(b); }, (e) => { if (onError) onError(e); });
    return p;
  }

  // --- events ---
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }

  _dispatch(type) {
    const set = this._listeners.get(type);
    if (set) for (const fn of [...set]) fn({ type, target: this });
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._dispatch('statechange');
  }

  // --- graph inspection for the tests ---
  /** Every recorded edge { from, to, output, input }. */
  get edges() {
    return this._edges.slice();
  }

  /** Whether `from` is connected to `to` (optionally on given output/input). */
  isConnected(from, to, output, input) {
    return this._edges.some((e) => e.from === from && e.to === to
      && (output === undefined || e.output === output)
      && (input === undefined || e.input === input));
  }

  /** Destinations of a node. */
  targetsOf(node) {
    return this._edges.filter((e) => e.from === node).map((e) => e.to);
  }
}

/** Fake realtime AudioContext. Static `defaults` configure the next instances. */
export class FakeAudioContext extends FakeBaseAudioContext {
  constructor(options = {}) {
    const d = FakeAudioContext.defaults;
    super({
      sampleRate: options.sampleRate || d.sampleRate,
      maxChannelCount: d.maxChannelCount,
      worklet: d.worklet,
      workletNodeThrows: d.workletNodeThrows
    });
    this.options = options;
    this.state = d.state;
    this.baseLatency = 0.005;
    this.outputLatency = 0.02;
    this.sinkId = '';
    this.closeCalls = 0;
    this.resumeCalls = 0;
    FakeAudioContext.instances.push(this);
  }

  resume() {
    this.resumeCalls++;
    if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: closed'));
    this._setState('running');
    return Promise.resolve();
  }

  suspend() {
    this._setState('suspended');
    return Promise.resolve();
  }

  close() {
    this.closeCalls++;
    this._setState('closed');
    return Promise.resolve();
  }

  setSinkId(id) {
    const devices = FakeAudioContext.devices;
    if (id && !(id in devices)) return Promise.reject(new Error(`NotFoundError: no device ${id}`));
    this.sinkId = id;
    this.destination.maxChannelCount = id ? devices[id] : FakeAudioContext.defaults.maxChannelCount;
    return Promise.resolve();
  }

  createMediaStreamDestination() { return new FakeMediaStreamAudioDestinationNode(this); }
  createMediaStreamSource(stream) { return new FakeMediaStreamAudioSourceNode(this, stream); }
}

FakeAudioContext.defaults = {
  sampleRate: 48000,
  maxChannelCount: 2,
  worklet: 'resolve',
  workletNodeThrows: false,
  state: 'suspended'
};
/** Every FakeAudioContext created (most recent last). */
FakeAudioContext.instances = [];
/** Output devices for setSinkId: id -> maxChannelCount. */
FakeAudioContext.devices = { speakers: 2, controller: 4 };

/** Fake OfflineAudioContext: suspend/resume/startRendering on the fake clock. */
export class FakeOfflineAudioContext extends FakeBaseAudioContext {
  constructor(a, b, c) {
    const o = a && typeof a === 'object' ? a : { numberOfChannels: a, length: b, sampleRate: c };
    const opts = o._fake || {};
    super({
      sampleRate: o.sampleRate || 48000,
      maxChannelCount: o.numberOfChannels || 1,
      offline: true,
      worklet: opts.worklet || 'resolve',
      workletNodeThrows: !!opts.workletNodeThrows
    });
    this.numberOfChannels = o.numberOfChannels || 1;
    this.length = o.length;
    this.state = 'suspended';
    this._suspends = [];
    this._resumeWaiter = null;
    this._rendering = false;
    /** Every suspend() call: { time, frame }. */
    this.suspendCalls = [];
    this.resumeCalls = 0;
    if (opts.noSuspend) this.suspend = undefined;
  }

  suspend(time) {
    nonNegTime(time, 'suspend');
    // quantized like Chromium: truncated to a frame, rounded up to 128
    const raw = Math.floor(time * this.sampleRate);
    const frame = Math.ceil(raw / 128) * 128;
    this.suspendCalls.push({ time, frame });
    if (time * this.sampleRate >= this.length) {
      return Promise.reject(new Error('InvalidStateError: suspend time beyond the render'));
    }
    if (frame < Math.round(this._time * this.sampleRate)) {
      return Promise.reject(new Error('InvalidStateError: suspend time in the past'));
    }
    if (this._suspends.some((s) => s.frame === frame)) {
      return Promise.reject(new Error('InvalidStateError: duplicate suspend frame'));
    }
    return new Promise((resolve) => this._suspends.push({ frame, resolve }));
  }

  resume() {
    this.resumeCalls++;
    const r = this._resumeWaiter;
    this._resumeWaiter = null;
    if (r) r();
    return Promise.resolve();
  }

  async startRendering() {
    if (this._rendering) throw new Error('InvalidStateError: already rendering');
    this._rendering = true;
    this._setState('running');
    for (;;) {
      this._suspends.sort((x, y) => x.frame - y.frame);
      const next = this._suspends.shift();
      if (!next) break;
      this.advance(Math.max(0, next.frame / this.sampleRate - this._time));
      this._setState('suspended');
      const resumed = new Promise((r) => { this._resumeWaiter = r; });
      next.resolve();
      await resumed;
      this._setState('running');
    }
    this.advance(Math.max(0, this.length / this.sampleRate - this._time));
    this._setState('closed');
    return new FakeAudioBuffer({ numberOfChannels: this.numberOfChannels, length: this.length, sampleRate: this.sampleRate });
  }
}

// ----------------------------------------------------------------- globals --

/**
 * Installs AudioWorkletNode (and, on request, AudioContext /
 * OfflineAudioContext) on globalThis. Returns a function that restores the
 * previous values.
 * @param {{ audioContext?: boolean, offlineAudioContext?: boolean }} [options]
 * @returns {() => void}
 */
export function installFakeAudioGlobals({ audioContext = false, offlineAudioContext = false } = {}) {
  const saved = {};
  const set = (name, value) => {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  set('AudioWorkletNode', FakeAudioWorkletNode);
  if (audioContext) set('AudioContext', FakeAudioContext);
  if (offlineAudioContext) set('OfflineAudioContext', FakeOfflineAudioContext);
  return () => {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  };
}

/** A fake realtime context, ready to inject (state 'running'). */
export function makeContext(options = {}) {
  const saved = { ...FakeAudioContext.defaults };
  Object.assign(FakeAudioContext.defaults, options);
  try {
    const ctx = new FakeAudioContext({ sampleRate: options.sampleRate });
    ctx.state = options.state || 'running';
    return ctx;
  } finally {
    Object.assign(FakeAudioContext.defaults, saved);
  }
}

/** A fake offline context. */
export function makeOfflineContext({ channels = 2, seconds = 1, sampleRate = 48000, ...fake } = {}) {
  return new FakeOfflineAudioContext({
    numberOfChannels: channels,
    length: Math.round(seconds * sampleRate),
    sampleRate,
    _fake: fake
  });
}
