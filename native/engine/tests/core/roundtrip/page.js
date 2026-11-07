// Renderer side of the engine host round trip (owner: host): uses
// window.omEngine (the additive preload block) the way the JS proxy will —
// info, connect, the two ports forwarded with window.postMessage, hello,
// clock pings, heartbeat, a PCM handoff in float32 planar chunks from a
// pool of 2 reused buffers posted WITHOUT a transfer list, pcm acks,
// pcm.done, state events, refused and "full" messages, slow commands
// answered asynchronously, the VST scan and shadow-decode helper processes,
// recordings saved / kept / revealed, and engine-kill + engine-exit.
// Returns the steps and the measured numbers. SPEC.md §6.4, §6.5, §7.2.
'use strict';

window.runRoundTrip = async (cfg) => {
  const steps = [];
  const metrics = {};
  const step = (name, ok, info) => {
    steps.push({ name, ok: !!ok, info });
    return !!ok;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const om = window.omEngine;
    if (!step('window.omEngine exposed by the preload', !!om)) return { steps };
    const info = await om.info();
    if (!step('engine-info: available', info && info.available, info)) return { steps };
    let exitInfo = null;
    om.onExit((d) => {
      exitInfo = d;
    });
    const portsP = new Promise((resolve) => {
      window.addEventListener('message', (e) => {
        if (e.data === 'openmix-engine-ports' && e.ports && e.ports.length === 2) resolve(e.ports);
      });
    });
    const tc = performance.now();
    const conn = await om.connect();
    metrics.connectMs = Math.round(performance.now() - tc);
    if (!step('engine-connect (host forked, init, ports)', conn && conn.ok, conn)) return { steps, metrics };
    const ports = await Promise.race([portsP, sleep(5000).then(() => null)]);
    if (!step('two ports forwarded by the preload', !!ports)) return { steps, metrics };
    const [ctl, pcm] = ports;

    const events = [];
    const waiters = [];
    ctl.onmessage = (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        ev = { ev: 'unparsable', raw: String(e.data).slice(0, 80) };
      }
      ev._t = performance.now();
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(ev)) {
          waiters[i].resolve(ev);
          waiters.splice(i, 1);
        }
      }
    };
    const acks = [];
    pcm.onmessage = (e) => acks.push(e.data);
    const waitEv = (pred, ms = 5000) => {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            resolve(null);
          }
        }, ms);
      });
    };
    const send = (o) => ctl.postMessage(JSON.stringify(o));

    // ---- hello, clock, heartbeat ----
    const th = performance.now();
    send({ cmd: 'hello', id: 1, protocol: 2, client: 'roundtrip' });
    const hello = await waitEv((e) => e.ev === 'reply' && e.id === 1, 10000);
    metrics.helloMs = Math.round((performance.now() - th) * 100) / 100;
    if (!step('hello', hello && hello.ok && hello.protocol === 2 && hello.chunkFrames === 65536 && hello.epoch >= 1, hello))
      return { steps, metrics };
    const rtts = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now() / 1000;
      send({ cmd: 'clock.ping', t0 });
      const pong = await waitEv((e) => e.ev === 'clock.pong' && e.t0 === t0, 2000);
      if (pong) rtts.push(Math.round((pong._t / 1000 - t0) * 1e5) / 100);
    }
    metrics.pingRttMs = rtts;
    step('clock.ping x5', rtts.length === 5, { minRttMs: Math.min(...rtts) });
    const hb = await waitEv((e) => e.ev === 'hb', 2000);
    step('heartbeat', !!hb, hb && { running: hb.running, block: hb.block });

    // ---- PCM handoff: float32 planar, 2 pool buffers, no transfer list ----
    const rate = hello.sampleRate;
    const frames = 65536 * 3 + 1000;
    send({ cmd: 'pcm.begin', id: 2, loadId: 7, kind: 'track', format: 's16', sourceChannels: 2, sampleRate: rate, frames, headroom: 1, peak: 0.4 });
    const pb = await waitEv((e) => e.ev === 'reply' && e.id === 2);
    if (!step('pcm.begin', pb && pb.ok, pb)) return { steps, metrics };
    send({ cmd: 'deck.load', id: 3, deck: 0, seq: 1, loadId: 7, grid: { bpm: 120, beatOffset: 0 } });
    const dl = await waitEv((e) => e.ev === 'reply' && e.id === 3);
    step('deck.load before the data (armed start waits for it)', dl && dl.ok, dl);
    const pool = [new Float32Array(65536 * 2), new Float32Array(65536 * 2)];
    const postMs = [];
    let chunks = 0;
    for (let off = 0; off < frames; off += 65536, chunks++) {
      const n = Math.min(65536, frames - off);
      const buf = pool[chunks & 1];
      const view = n === 65536 ? buf : new Float32Array(buf.buffer, 0, n * 2);
      for (let i = 0; i < n; i++) {
        const v = 0.4 * Math.sin((2 * Math.PI * 440 * (off + i)) / rate);
        view[i] = v;
        view[n + i] = -v;
      }
      const tp = performance.now();
      pcm.postMessage({ loadId: 7, offset: off, frames: n, channels: 2, data: view });  // structured clone: copied now
      postMs.push(Math.round((performance.now() - tp) * 1000) / 1000);
      view.fill(9);  // the pool buffer is reusable at once
    }
    metrics.chunkPostMs = postMs;
    for (let i = 0; i < 100 && acks.length < chunks; i++) await sleep(20);
    step('pcm acks (code 0 for every chunk)', acks.length === chunks && acks.every((a) => a.code === 0 && a.loadId === 7), acks);
    pcm.postMessage({ loadId: 7, end: true });
    const pd = await waitEv((e) => (e.ev === 'pcm.done' || e.ev === 'pcm.error') && e.loadId === 7);
    step('pcm.done', pd && pd.ev === 'pcm.done', pd);
    // the host's PCM memory limit (main passes maxPcmBytes 4 MiB here; ~40 % of the RAM in the app)
    send({ cmd: 'pcm.begin', id: 4, loadId: 8, kind: 'track', format: 's16', sourceChannels: 2, sampleRate: rate, frames: 2000000, headroom: 1, peak: 0.4 });
    const pm = await waitEv((e) => e.ev === 'reply' && e.id === 4);
    step('pcm.begin over the PCM memory limit: refused "memory"', pm && !pm.ok && pm.error === 'memory', pm);
    pcm.postMessage({ loadId: 99, offset: 0, frames: 10, channels: 2, data: new Float32Array(20) });
    for (let i = 0; i < 50 && acks.length < chunks + 1; i++) await sleep(20);
    step('chunk of an unknown stream acked NotFound', acks.length === chunks + 1 && acks[chunks].code === -7, acks[chunks]);

    // ---- transport and state ----
    send({ cmd: 'deck.play', deck: 0, seq: 2 });
    const s0 = events.filter((e) => e.ev === 'state').length;
    await sleep(1000);
    const states = events.filter((e) => e.ev === 'state').slice(s0);
    const last = states[states.length - 1];
    let increasing = true;
    for (let i = 1; i < states.length; i++) if (!(states[i].block > states[i - 1].block)) increasing = false;
    metrics.statesPerSecond = states.length;
    step('state events: only new snapshots, <= 60 per second', states.length >= 20 && states.length <= 62 && increasing,
      { perSecond: states.length, increasing });
    step('state: deck 0 loaded and playing, ack, PCM memory', last && last.decks[0].loaded && last.decks[0].loadId === 7 &&
      last.decks[0].playing && last.ack >= 2 && last.pcmBytes === frames * 4 && last.epoch === hello.epoch,
      last && { loaded: last.decks[0].loaded, playing: last.decks[0].playing, ack: last.ack, pcmBytes: last.pcmBytes, mode: last.device.mode });

    // ---- refusals ----
    ctl.postMessage(JSON.stringify([{ cmd: 'deck.play', deck: 0, id: 9 }, { cmd: 'nope', id: 10 }]));
    const bad = await waitEv((e) => e.ev === 'error' && e.ids && e.ids.includes(10));
    step('invalid batch refused as a whole: error event', bad && bad.cmd === 'deck.play' && bad.batch, bad);
    const big = [];
    for (let i = 0; i < 9000; i++) big.push({ cmd: 'deck.volume', deck: 1, v: 0.5 });
    ctl.postMessage(JSON.stringify(big));
    const full = await waitEv((e) => e.ev === 'error' && e.error === 'full');
    step('batch larger than the queue: "full" (the proxy retries)', !!full, full && { error: full.error });

    // ---- slow commands: asynchronous replies ----
    send({ cmd: 'device.list', id: 20 });
    send({ cmd: 'vst.load', deck: 1, id: 21, path: 'C:\\Windows\\System32\\evil.vst3', uid: '' });
    send({ cmd: 'rec.list', id: 22 });
    send({ cmd: 'device.status', id: 23 });
    const r20 = await waitEv((e) => e.ev === 'reply' && e.id === 20, 8000);
    const r21 = await waitEv((e) => e.ev === 'reply' && e.id === 21, 8000);
    const r22 = await waitEv((e) => e.ev === 'reply' && e.id === 22, 8000);
    const r23 = await waitEv((e) => e.ev === 'reply' && e.id === 23, 2000);
    step('device.list (ops thread)', !!r20, r20 && { ok: r20.ok, devices: (r20.devices || []).length, error: r20.error });
    metrics.devices = r20 && (r20.devices || []).map((d) => `${d.name} (${d.channels} ch, ${d.sampleRate} Hz)`);
    step('vst.load outside the trusted folders: notAllowed', r21 && !r21.ok && r21.code === 'notAllowed', r21 && r21.code);
    step('rec.list (ops thread)', r22 && r22.ok && Array.isArray(r22.files), r22 && r22.files && r22.files.length);
    step('device.status (inline, cached)', r23 && r23.ok && r23.status && r23.status.mode, r23 && r23.status && r23.status.mode);

    // ---- helper processes ----
    const scan = await om.vstScan([]);
    step('VST scan helper process', scan && scan.ok && Array.isArray(scan.plugins), scan);
    const n = Math.min(cfg.toneFrames, 48000 * 2);
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) left[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5 * 32767) / 32768;
    const ts = performance.now();
    const sh = await om.shadowDecode({ loadId: 7, path: cfg.tone, rate: 48000, frames: cfg.toneFrames, windowStart: 0, left, right: left.slice() });
    metrics.shadowMs = Math.round(performance.now() - ts);
    metrics.shadow = sh;
    step('shadow decode helper process (never crashed)', sh && sh.error !== 'crashed' && sh.loadId === 7, sh);
    const shBad = await om.shadowDecode({ loadId: 8, path: '\\\\server\\share\\x.mp3', rate: 48000, frames: 4, windowStart: 0, left: new Float32Array(4), right: new Float32Array(4) });
    step('shadow decode refuses UNC paths', shBad && !shBad.ok && shBad.error === 'invalid path', shBad);

    // ---- recordings: rename (same drive), verified copy (across drives), kept on cancel, reveal ----
    const s1 = await om.saveRecording(cfg.rec1, 'Saved set.wav');
    step('save recording across drives (EXDEV, simulated): verified copy', s1 && s1.ok && /Saved set\.wav$/.test(s1.path) && s1.moved === 'copied', s1);
    const s4 = await om.saveRecording(cfg.rec3, 'Moved set.wav');
    step('save recording on the same drive: renamed', s4 && s4.ok && /Moved set\.wav$/.test(s4.path) && s4.moved === 'renamed', s4);
    const s2 = await om.saveRecording(cfg.rec2, 'Cancel me.wav');
    step('save cancelled: recording kept', s2 && !s2.ok && s2.canceled && s2.kept === cfg.rec2, s2);
    const s3 = await om.saveRecording('C:\\Windows\\win.ini', 'x.wav');
    step('save refuses files outside the recordings folder', s3 && !s3.ok, s3);
    const rv = await om.revealFile(cfg.rec2);
    const rv2 = await om.revealFile('C:\\Windows\\win.ini');
    step('reveal: recordings only', rv === true && rv2 === false, { rv, rv2 });

    // ---- the audio callback never allocated (an --rt-trap module reports it) ----
    const rtDiag = events.filter((e) => e.ev === 'diag' && (e.kind === 'rt-alloc' || e.kind === 'rt-free'));
    const lastState = events.filter((e) => e.ev === 'state').slice(-1)[0];
    const health = lastState && lastState.health;
    metrics.rtAllocs = health ? health.rtAllocs : null;
    metrics.rtFrees = health ? health.rtFrees : null;
    metrics.rtDiagEvents = rtDiag.length;
    step('no audio-thread allocation: no diag rt-alloc / rt-free, health.rtAllocs = rtFrees = 0',
      rtDiag.length === 0 && health && health.rtAllocs === 0 && health.rtFrees === 0,
      { diag: rtDiag.slice(0, 3), rtAllocs: metrics.rtAllocs, rtFrees: metrics.rtFrees });

    // ---- kill: resolves when the host is gone ----
    const tk = performance.now();
    const k = await om.kill();
    metrics.killMs = Math.round(performance.now() - tk);
    step('engine-kill (<= 1 s)', k && k.ok && metrics.killMs <= 1500, k);
    for (let i = 0; i < 100 && !exitInfo; i++) await sleep(20);
    step('engine-exit event', !!exitInfo, exitInfo);
    return { steps, metrics };
  } catch (e) {
    return { steps, metrics, error: String((e && e.stack) || e) };
  }
};
