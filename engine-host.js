// OpenMix native engine host (owner: host; native/engine/SPEC.md §6.4): the
// script of the Electron utilityProcess that loads openmix_engine.node and
// relays between it and the renderer. Main (engine-main.js) forks it once,
// sends it the trusted configuration and a pair of MessagePorts per
// renderer connection:
//   parent {type:'init', modulePath, dataDir, ownerHwnd, policy, maxPcmBytes?}
//            -> require the module, create the engine (PCM memory limit:
//               maxPcmBytes, else ~40 % of the RAM), set the policy, start;
//               answers {type:'ready', ok, error?, version, protocol}
//   parent {type:'policy', policy}      -> engine.setPolicy (after each VST scan)
//   parent {type:'connect'} + [ctl, pcm] -> wires the ports (a previous connection is closed)
//   parent {type:'shutdown'}            -> engine.destroy(), exit
//   ctl port (JSON text both ways): text -> engine.command(); a refusal is
//     answered {"ev":"error","error":...,"cmd":<first cmd>,"seq":<its seq>,"ids":[...]}
//     ("full": the proxy resends that batch on its next frame; anything else:
//     its requests resolve {ok:false}); every engine event (text)
//     is posted as is ("state" is coalesced by the binding)
//   pcm port (structured clones): {loadId, offset, frames, channels, data:
//     Float32Array planar} -> engine.pcmWrite, acked {loadId, offset, code};
//     {loadId, end:true} -> engine.pcmEnd (pcm.done / pcm.error on ctl);
//     {loadId, abort:true} -> engine.pcmAbort
// Helper modes (short-lived processes started by main, one job each):
//   --scan   first message {modulePath, paths}: VST3 scan -> {ok, plugins} (loading
//            plugin DLLs may crash: never in the engine process, SPEC.md §13.6)
//   --shadow first message {modulePath, job, left, right}: Media Foundation shadow
//            decode -> the report (third-party codecs: never in the engine process, §7.4)
// Logs go to stdout with an [engine] prefix; an uncaught exception exits with
// code 1 (the renderer then falls back to the Web engine).
'use strict';

const LOG = (...a) => console.log('[engine]', ...a);
const parentPort = process.parentPort;
// PCM the engine may hold (tracks, stems, samples), as a share of the RAM:
// beyond it pcm.begin is refused "memory" (the proxy reloads once, then falls
// back and tells the user why) instead of the PC paging with audible
// dropouts (the renderer keeps its own copy of every track in Phase 2).
const PCM_RAM_SHARE = 0.4;

process.on('uncaughtException', (e) => {
  console.error('[engine] uncaught exception:', e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[engine] unhandled rejection:', e && e.stack ? e.stack : e);
  process.exit(1);
});

if (!parentPort) {
  console.error('[engine] engine-host.js must run as an Electron utility process');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helper modes: one job, one answer, exit.
// ---------------------------------------------------------------------------
function runHelper(kind) {
  parentPort.once('message', (e) => {
    const msg = e.data || {};
    let out;
    try {
      const native = require(msg.modulePath);
      if (kind === 'scan') {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter((p) => typeof p === 'string') : [];
        out = { ok: true, plugins: JSON.parse(native.vstScan(JSON.stringify(paths))) };
      } else {
        const left = msg.left instanceof Float32Array ? msg.left : new Float32Array(msg.left || 0);
        const right = msg.right instanceof Float32Array ? msg.right : new Float32Array(msg.right || 0);
        out = JSON.parse(native.shadowRun(JSON.stringify(msg.job || {}), left, right));
      }
    } catch (err) {
      out = { ok: false, error: String((err && err.message) || err) };
    }
    parentPort.postMessage(out);
    setImmediate(() => process.exit(0));
  });
}

if (process.argv.includes('--scan')) {
  runHelper('scan');
} else if (process.argv.includes('--shadow')) {
  runHelper('shadow');
} else {
  runHost();
}

// ---------------------------------------------------------------------------
// The engine host.
// ---------------------------------------------------------------------------
function runHost() {
  let native = null;
  let engine = null;
  let ctl = null;   // MessagePortMain of the current connection (JSON text)
  let pcm = null;   // MessagePortMain of the current connection (PCM chunks)
  let lostEvents = 0;

  // Engine events (one JSON text each) -> the current renderer, as is.
  const onEvent = (text) => {
    if (ctl) {
      try {
        ctl.postMessage(text);
        return;
      } catch {
        /* the port closed under us */
      }
    }
    lostEvents++;  // no renderer connected (reload in progress): the next hello resets anyway
  };

  const errorEvent = (error, text) => {
    // Name and seq of the first refused command and the ids of the message, so
    // the proxy resends exactly that batch ("full") or resolves its requests.
    let cmd = null;
    let seq = null;
    const ids = [];
    try {
      const v = JSON.parse(text);
      const list = Array.isArray(v) ? v : [v];
      for (const c of list) {
        if (c && typeof c === 'object') {
          if (cmd === null && typeof c.cmd === 'string') cmd = c.cmd;
          if (seq === null && typeof c.seq === 'number') seq = c.seq;
          if (typeof c.id === 'number') ids.push(c.id);
        }
      }
    } catch {
      /* not JSON: cmd stays null */
    }
    return JSON.stringify({ ev: 'error', error, cmd, seq, ids, batch: text.length > 0 && text[0] === '[' });
  };

  const closePorts = () => {
    for (const p of [ctl, pcm]) {
      if (!p) continue;
      try { p.close(); } catch { /* already closed */ }
    }
    ctl = null;
    pcm = null;
  };

  const wire = (ctlPort, pcmPort) => {
    closePorts();
    ctl = ctlPort;
    pcm = pcmPort;
    const myCtl = ctlPort;
    const myPcm = pcmPort;
    myCtl.on('message', (e) => {
      if (ctl !== myCtl || !engine) return;
      const text = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      const r = engine.command(text);  // never blocks: slow commands are queued inside the engine
      if (r !== null && r !== undefined) myCtl.postMessage(errorEvent(r, text));
    });
    myCtl.on('close', () => {
      if (ctl === myCtl) ctl = null;
    });
    myPcm.on('message', (e) => {
      if (pcm !== myPcm || !engine) return;
      const m = e.data || {};
      const loadId = m.loadId >>> 0;
      if (m.end) {
        engine.pcmEnd(loadId);  // pcm.done / pcm.error arrive on ctl
        return;
      }
      if (m.abort) {
        engine.pcmAbort(loadId);
        return;
      }
      let code;
      try {
        const data = m.data instanceof Float32Array ? m.data : new Float32Array(m.data);
        code = engine.pcmWrite(loadId, Number(m.offset) || 0, m.frames | 0, m.channels | 0, data);
      } catch (err) {
        code = -1;  // OM_ERR_INVALID: malformed chunk
        LOG('bad pcm chunk:', String((err && err.message) || err));
      }
      myPcm.postMessage({ loadId, offset: m.offset, code });
    });
    myPcm.on('close', () => {
      if (pcm === myPcm) pcm = null;
    });
    myCtl.start();
    myPcm.start();
    if (lostEvents) LOG(`${lostEvents} event(s) dropped while no renderer was connected`);
    lostEvents = 0;
  };

  const init = (msg) => {
    try {
      native = require(msg.modulePath);
      const maxPcmBytes = Number(msg.maxPcmBytes) > 0
        ? Math.floor(Number(msg.maxPcmBytes))
        : Math.floor(require('os').totalmem() * PCM_RAM_SHARE);
      engine = native.create(
        { dataDir: msg.dataDir || '', ownerHwnd: msg.ownerHwnd ? String(msg.ownerHwnd) : '0', stateHz: 60, maxPcmBytes },
        onEvent
      );
      LOG(`PCM memory limit ${(maxPcmBytes / 1048576).toFixed(0)} MB`);
      if (msg.policy) {
        const err = engine.setPolicy(typeof msg.policy === 'string' ? msg.policy : JSON.stringify(msg.policy));
        if (err) LOG('policy refused:', err);
      }
      engine.start();
      LOG(`native engine ${native.version()} (protocol ${native.protocol()}) started`);
      parentPort.postMessage({ type: 'ready', ok: true, version: native.version(), protocol: native.protocol() });
    } catch (err) {
      const error = String((err && err.message) || err);
      LOG('init failed:', error);
      try { if (engine) engine.destroy(); } catch { /* nothing */ }
      engine = null;
      parentPort.postMessage({ type: 'ready', ok: false, error });
    }
  };

  const shutdown = () => {
    closePorts();
    try {
      if (engine) engine.destroy();  // finalizes a running recording, closes the devices, joins the threads
    } catch (err) {
      LOG('shutdown:', String((err && err.message) || err));
    }
    engine = null;
    setImmediate(() => process.exit(0));
  };

  parentPort.on('message', (e) => {
    const msg = e.data || {};
    switch (msg.type) {
      case 'init':
        if (!engine) init(msg);
        break;
      case 'policy':
        if (engine && msg.policy) {
          const err = engine.setPolicy(typeof msg.policy === 'string' ? msg.policy : JSON.stringify(msg.policy));
          if (err) LOG('policy refused:', err);
        }
        break;
      case 'connect':
        if (e.ports && e.ports.length >= 2) wire(e.ports[0], e.ports[1]);
        else LOG('connect without its two ports');
        break;
      case 'shutdown':
        shutdown();
        break;
      default:
        break;
    }
  });
}
