// Renders of the deck golden suite (owner: deck), run inside the hidden page
// of make_deck_goldens.js: OfflineAudioContext only (silent). Writes, in the
// output folder:
//   <input>.input.wav   the PCM fed to Chromium (float32; s16 inputs are
//                       int16 x per-chunk scale, scales in <input>.json)
//   <case>.wav          Chromium's output (float32)
//   <case>.ratio.wav    (WSOLA cases) the k-rate "ratio" value of every quantum
//   <case>.json         the node setup and parameter events, in frames
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { ipcRenderer } = require('electron');

const q = new URLSearchParams(location.search);
const OUT = q.get('out');
const ROOT = q.get('root');
const log = (m) => ipcRenderer.send('log', m);

const CHUNK = 65536;  // TrackBuffer::kChunkFrames

function writeWav(file, channels, sampleRate) {
  const n = channels[0].length;
  const ch = channels.length;
  const dataBytes = n * ch * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);  // IEEE float
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 4, 28);
  buf.writeUInt16LE(ch * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      buf.writeFloatLE(channels[c][i], o);
      o += 4;
    }
  }
  fs.writeFileSync(file, buf);
}
const writeJson = (name, obj) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 1));

// Deterministic music-like stereo signal: kicks every 0.5 s, tones, hats, noise.
function makeSignal(frames, rate, seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  const rnd = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const b = t % 0.5;
    const kick = Math.exp(-b * 18) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-b * 30)) * b) * 0.45;
    const h = (t + 0.25) % 0.5;
    const hat = Math.exp(-h * 90) * (rnd() * 2 - 1) * 0.12;
    L[i] = kick + hat + 0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.07 * Math.sin(2 * Math.PI * 331.3 * t + 0.4) +
      0.05 * Math.sin(2 * Math.PI * 1234.5 * t) + 0.03 * Math.sin(2 * Math.PI * 7019 * t) + (rnd() * 2 - 1) * 0.03;
    R[i] = kick * 0.9 + hat * 0.8 + 0.1 * Math.sin(2 * Math.PI * 277.2 * t + 1) + 0.06 * Math.sin(2 * Math.PI * 2345.6 * t) +
      0.03 * Math.sin(2 * Math.PI * 9100 * t + 2) + (rnd() * 2 - 1) * 0.03;
  }
  return [L, R];
}

// int16 x per-chunk scale (TrackBuffer S16 with per-chunk headroom), exactly
// representable: value = fround(s16 * fround(headroom / 32767)).
function quantizeS16(sig, headrooms) {
  const frames = sig[0].length;
  const out = [new Float32Array(frames), new Float32Array(frames)];
  const scales = [];
  for (let c = 0; c * CHUNK < frames; c++) {
    const scale = Math.fround(headrooms[c % headrooms.length] / 32767);
    scales.push(scale);
    for (let ch = 0; ch < 2; ch++) {
      for (let i = c * CHUNK; i < Math.min(frames, (c + 1) * CHUNK); i++) {
        let s = Math.round(sig[ch][i] / scale);
        s = Math.max(-32768, Math.min(32767, s));
        out[ch][i] = Math.fround(s * scale);
      }
    }
  }
  return { data: out, scales };
}

const inputs = {};
function makeInputs() {
  const s48 = makeSignal(200000, 48000, 12345);
  const s44 = makeSignal(200000, 44100, 777);
  const q48 = quantizeS16(s48, [1.0, 1.4, 1.05, 1.12]);
  const q44 = quantizeS16(s44, [1.25, 1.0, 1.6, 1.01]);
  inputs.in48s16 = { rate: 48000, format: 's16', data: q48.data, scales: q48.scales };
  inputs.in44s16 = { rate: 44100, format: 's16', data: q44.data, scales: q44.scales };
  inputs.in48f32 = { rate: 48000, format: 'f32', data: s48 };
  inputs.wsola = { rate: 48000, format: 'f32', data: makeSignal(200000, 48000, 4242) };
  for (const [name, inp] of Object.entries(inputs)) {
    writeWav(path.join(OUT, `${name}.input.wav`), inp.data, inp.rate);
    writeJson(`${name}.input`, { rate: inp.rate, format: inp.format, frames: inp.data[0].length, chunkFrames: CHUNK, scales: inp.scales || null });
  }
}

// ---- AudioBufferSourceNode read pointer ------------------------------------
async function renderAbs(name, c) {
  const inp = inputs[c.input];
  const ctxRate = 48000;
  const ctx = new OfflineAudioContext(2, c.frames, ctxRate);
  const buf = ctx.createBuffer(2, inp.data[0].length, inp.rate);
  buf.copyToChannel(inp.data[0], 0);
  buf.copyToChannel(inp.data[1], 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = c.rate;
  if (c.loop) {
    src.loop = true;
    src.loopStart = c.loopStartFrame / inp.rate;
    src.loopEnd = c.loopEndFrame / inp.rate;
  }
  src.connect(ctx.destination);
  for (const [frame, r] of c.rateSteps || []) {
    ctx.suspend(frame / ctxRate).then(() => {
      src.playbackRate.value = r;
      ctx.resume();
    });
  }
  src.start(0, c.offsetFrame / inp.rate);
  const out = await ctx.startRendering();
  writeWav(path.join(OUT, `${name}.wav`), [out.getChannelData(0), out.getChannelData(1)], ctxRate);
  writeJson(name, {
    kind: 'abs', input: c.input, contextRate: ctxRate, frames: c.frames, rate: c.rate,
    // the exact doubles Chromium got (seconds), so a test can redo offset*rate etc.
    offsetSec: c.offsetFrame / inp.rate, loop: !!c.loop,
    loopStartSec: c.loop ? c.loopStartFrame / inp.rate : 0, loopEndSec: c.loop ? c.loopEndFrame / inp.rate : 0,
    rateSteps: (c.rateSteps || []).map(([frame, r]) => ({ frame, rate: r }))
  });
  log(`abs ${name}`);
}

// ---- pitch-worklet.js (WSOLA) ----------------------------------------------
function automate(ctx, params, c) {
  // Up-front events (setValueAtTime / linear ramps), times in seconds.
  for (const e of c.events || []) {
    for (const p of params) {
      if (e.type === 'set') p.setValueAtTime(e.value, e.time);
      else if (e.type === 'linear') p.linearRampToValueAtTime(e.value, e.time);
    }
  }
  // engine.js style: setTargetAtTime(v, ctx.currentTime, 0.02) issued while the
  // context is suspended at a quantum boundary.
  const byFrame = new Map();
  for (const t of c.targets || []) {
    if (!byFrame.has(t.frame)) byFrame.set(t.frame, []);
    byFrame.get(t.frame).push(t);
  }
  for (const [frame, list] of byFrame) {
    ctx.suspend(frame / ctx.sampleRate).then(() => {
      for (const t of list) for (const p of params) p.setTargetAtTime(t.value, ctx.currentTime, t.tau);
      ctx.resume();
    });
  }
}

async function renderWsola(name, c) {
  const inp = inputs.wsola;
  const rate = 48000;
  const worklet = pathToFileURL(path.join(ROOT, 'src', 'js', 'pitch-worklet.js')).href;
  const recorder = pathToFileURL(path.join(path.dirname(fileURLToPath(location.href)), 'ratio-recorder.js')).href;

  // 1) the real pitch-worklet.js fed by the input at rate 1
  const ctx = new OfflineAudioContext(2, c.frames, rate);
  await ctx.audioWorklet.addModule(worklet);
  const node = new AudioWorkletNode(ctx, 'pitch-shift', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
  });
  const buf = ctx.createBuffer(2, inp.data[0].length, rate);
  buf.copyToChannel(inp.data[0], 0);
  buf.copyToChannel(inp.data[1], 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(node);
  node.connect(ctx.destination);
  automate(ctx, [node.parameters.get('ratio')], c);
  src.start(0);
  const out = await ctx.startRendering();
  writeWav(path.join(OUT, `${name}.wav`), [out.getChannelData(0), out.getChannelData(1)], rate);

  // 2) the same automation on a recorder: the exact k-rate value of each quantum
  const ctx2 = new OfflineAudioContext(1, c.frames, rate);
  await ctx2.audioWorklet.addModule(recorder);
  const rec = new AudioWorkletNode(ctx2, 'ratio-recorder', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  rec.connect(ctx2.destination);
  automate(ctx2, [rec.parameters.get('ratio')], c);
  const out2 = await ctx2.startRendering();
  writeWav(path.join(OUT, `${name}.ratio.wav`), [out2.getChannelData(0)], rate);
  writeJson(name, { kind: 'wsola', input: 'wsola', contextRate: rate, frames: c.frames, events: c.events || [], targets: c.targets || [] });
  log(`wsola ${name}`);
}

async function main() {
  makeInputs();
  let n = 0;
  const abs = {
    abs_rate1: { input: 'in48s16', rate: 1, offsetFrame: 1000, frames: 80000 },
    abs_rate0p7337: { input: 'in48s16', rate: 0.7337, offsetFrame: 777, frames: 120000 },
    abs_44k_rate1p37: { input: 'in44s16', rate: 1.37, offsetFrame: 500, frames: 120000 },
    abs_loop_seam: { input: 'in48s16', rate: 1.13, offsetFrame: 60000, frames: 200000, loop: true, loopStartFrame: 12345.678, loopEndFrame: 70000.25 },
    abs_loop_44k: { input: 'in44s16', rate: 0.91, offsetFrame: 35000, frames: 100000, loop: true, loopStartFrame: 30000.5, loopEndFrame: 40000.75 },
    abs_loop_rate1: { input: 'in48s16', rate: 1, offsetFrame: 2000, frames: 30000, loop: true, loopStartFrame: 1000, loopEndFrame: 5800 },
    abs_end: { input: 'in48s16', rate: 0.9, offsetFrame: 170000, frames: 50000 },
    abs_rate_steps: {
      input: 'in48s16', rate: 1, offsetFrame: 0, frames: 100000,
      rateSteps: [[12800, 1.05], [25600, 0.95], [38400, 1.5], [51200, 0.5], [64000, 1.6], [76800, 1.0]]
    },
    abs_f32_rate1p21: { input: 'in48f32', rate: 1.21, offsetFrame: 3, frames: 100000 }
  };
  for (const [name, c] of Object.entries(abs)) {
    await renderAbs(name, c);
    n++;
  }

  const stair = [];
  for (let k = 1; k < 1500; k++) {
    const ph = (k % 600) / 600;
    const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
    stair.push({ type: 'set', value: 0.5 + 1.3 * tri, time: (k * 128 - 64) / 48000 });
  }
  const targets = [
    [6400, 1 / 1.06], [25600, 1.12], [38400, 0.62], [39040, 1.75], [64000, 1.0], [89600, 0.5],
    [115200, 1.8], [140800, 1.0], [160000, 1.0], [166400, 1.3]
  ].map(([frame, value]) => ({ frame, value, tau: 0.02 }));
  for (let k = 0; k < 24; k++) targets.push({ frame: 76800 + k * 128, value: 1 + 0.002 * (k + 1), tau: 0.02 });
  const wsola = {
    wsola_unity: { frames: 96000 },
    wsola_staircase: { frames: 192000, events: stair },
    wsola_ramp: {
      frames: 192000,
      events: [
        { type: 'set', value: 0.5, time: 0 },
        { type: 'linear', value: 1.8, time: 2.0 },
        { type: 'linear', value: 0.7, time: 3.5 }
      ]
    },
    wsola_target: { frames: 192000, targets }
  };
  for (const [name, c] of Object.entries(wsola)) {
    await renderWsola(name, c);
    n++;
  }
  return n;
}

main().then(
  (cases) => ipcRenderer.send('done', { ok: true, cases }),
  (e) => ipcRenderer.send('done', { ok: false, error: String((e && e.stack) || e) })
);
