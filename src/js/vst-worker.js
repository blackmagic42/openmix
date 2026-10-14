// VST3 HOST WORKER — the only place where Node.js runs in the page.
//
// The window enables Node in Web Workers (nodeIntegrationInWorker) so this
// worker can load the native host (native/vsthost). The page talks to it
// with messages; the audio itself goes through SharedArrayBuffers shared
// with the AudioWorklet (see vst-worklet.js), never through here.

let host = null;
const rings = new Map(); // slot → Int32Array over its shared ring (kept alive)

function run(cmd, a) {
  switch (cmd) {
    case 'init':
      // eslint-disable-next-line no-undef
      host = require(a.modulePath);
      host.init({ sampleRate: a.sampleRate, blockSize: a.blockSize });
      return true;
    case 'scan':
      return host.scan(a.paths);
    case 'attach': {
      const view = new Int32Array(a.sab);
      rings.set(a.slot, view);
      host.attach(a.slot, view);
      return true;
    }
    case 'load': {
      const r = host.load(a.slot, a.path, a.uid || '');
      // eslint-disable-next-line no-undef
      if (r.ok && a.state) host.setState(a.slot, Buffer.from(a.state, 'base64'));
      return r;
    }
    case 'unload':
      host.unload(a.slot);
      return true;
    case 'openEditor':
      return host.openEditor(a.slot, a.owner ? BigInt(a.owner) : undefined);
    case 'closeEditor':
      host.closeEditor(a.slot);
      return true;
    case 'getState':
      return host.getState(a.slot).toString('base64');
    case 'status':
      return host.status(a.slot);
    case 'shutdown':
      if (host) host.shutdown();
      return true;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

self.onmessage = (e) => {
  const { id, cmd, args } = e.data;
  try {
    if (!host && cmd !== 'init') throw new Error('VST host not started');
    self.postMessage({ id, ok: true, res: run(cmd, args || {}) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
