// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Loads worklets/pitch-processor.js in Node, with shims for the
// AudioWorkletGlobalScope (AudioWorkletProcessor with a `port`, and
// registerProcessor capturing the class), and drives process() block by block.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const WORKLET_URL = new URL('../../worklets/pitch-processor.js', import.meta.url);

/** Shim of the AudioWorkletProcessor base class: a port that records messages. */
export class ShimAudioWorkletProcessor {
  constructor() {
    const port = { messages: [], onmessage: null, postMessage(m) { port.messages.push(m); } };
    this.port = port;
  }
}

/**
 * Evaluates the worklet source in a fresh scope. registerProcessor throws on
 * a duplicate name, like the real one.
 * @returns {{ registered: Map<string, Function>, scope: object }}
 */
export function loadWorklet(scope = null) {
  const registered = scope ? scope.__registered : new Map();
  const sandbox = scope || {
    AudioWorkletProcessor: ShimAudioWorkletProcessor,
    __registered: registered,
    registerProcessor(name, cls) {
      if (registered.has(name)) throw new Error(`NotSupportedError: '${name}' is already registered`);
      registered.set(name, cls);
    }
  };
  const ctx = scope ? scope.__context : vm.createContext(sandbox);
  sandbox.__context = ctx;
  // A worklet file is evaluated as a MODULE (its own scope, strict mode):
  // wrapping it in a function gives the same scoping, so that it can be
  // evaluated twice in one global scope, like a second addModule() would
  const source = `(function () {\n'use strict';\n${readFileSync(WORKLET_URL, 'utf8')}\n})();`;
  vm.runInContext(source, ctx, { filename: 'pitch-processor.js' });
  return { registered, scope: sandbox };
}

/**
 * Runs a processor over a mono input, in render quanta of 128 frames.
 * @param {Function} Processor the registered class
 * @param {Float32Array} input
 * @param {number | ((block: number) => number)} ratio
 * @param {object} [options] processor options
 * @returns {{ left: Float32Array, right: Float32Array, node: object }}
 */
export function runProcessor(Processor, input, ratio, options = {}) {
  const node = new Processor({ processorOptions: options });
  const n = 128;
  const blocks = Math.floor(input.length / n);
  const left = new Float32Array(blocks * n);
  const right = new Float32Array(blocks * n);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const param = new Float32Array(1);
  for (let b = 0; b < blocks; b++) {
    const inBlock = input.subarray(b * n, b * n + n);
    param[0] = typeof ratio === 'function' ? ratio(b) : ratio;
    const alive = node.process([[inBlock, inBlock]], [[outL, outR]], { ratio: param });
    if (alive !== true) throw new Error('process() must return true');
    left.set(outL, b * n);
    right.set(outR, b * n);
  }
  return { left, right, node };
}
