// OpenMix native engine: main-process wiring (owner: host; native/engine/SPEC.md
// §2, §6.5). main.js only adds a 3-line hook:
//   const engineMain = require('./engine-main');
//   engineMain.install({ getWindow: () => win, app, ipcMain });
// Everything else lives here:
//  - IPC for the renderer's window.omEngine (preload.js additive block):
//    engine-info, engine-connect, engine-kill, engine-vst-scan,
//    engine-save-recording, engine-reveal-file, engine-shadow-decode;
//  - the engine host: utilityProcess.fork(engine-host.js) ONCE per app run,
//    {type:'init', modulePath, dataDir, ownerHwnd, policy}, then per
//    connection two MessageChannelMain ("ctl": JSON text, "pcm": PCM chunks
//    and acks) whose port1s go to the host and port2s to the renderer
//    (webContents.postMessage('engine-ports', null, [ctl, pcm]));
//    'exit' -> webContents.send('engine-exit', {code}); no automatic respawn;
//  - the TRUSTED path policy of the host: the VST3 folders (read like
//    main.js vst-list-files: the standard folder, the per-user folder, the
//    folders added in Settings, OPENMIX_VST_PATH) and the plugins found by
//    the scans (SPEC.md §15.6). The renderer can never widen it;
//  - short-lived helper processes at below-normal priority: the VST scan
//    (engine-host.js --scan) and the shadow decode (engine-host.js --shadow,
//    one file per process, main validates the path);
//  - recordings: Save dialog, then a rename (instant, same drive) or, across
//    drives only, a copy into "<dest>.part" verified (size, first and last
//    MiB) and renamed, before the original in <dataDir>/recordings is
//    deleted; on cancel or error the original stays and its path is returned;
//    a copy still running at quit is aborted and its partial file deleted
//    (SPEC.md §14);
//  - a host no page uses any more (the page navigated away, e.g. to the Web
//    engine, or the renderer crashed) is shut down after 15 s unless a page
//    connects again (a native reload reconnects within that time);
//  - the PCM memory limit of the host (about 40 % of the RAM, SPEC.md §17.8);
//  - app quit, and the exported awaitable shutdown() (the restart paths that
//    call app.exit() skip will-quit and must await it): {type:'shutdown'} to
//    the host (a running recording is finalized first), killed after 2 s.
// Never touches the LAN server ports (8722 / 9333).
'use strict';

const { utilityProcess, MessageChannelMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const SHADOW_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.webm', '.aif', '.aiff', '.wma', '.mp4']);
const MIB = 1024 * 1024;
const COPY_CHUNK = 4 * MIB;          // cross-drive copy of a recording: aborted between chunks at quit
const IDLE_SHUTDOWN_MS = 15000;      // a host no page uses is shut down after this
const QUIT_GRACE_MS = 2000;          // {type:'shutdown'} -> exit, else killed (the recording is finalized first)

// Inside the installer the .node lives next to app.asar (asarUnpack).
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function isUnder(p, root) {
  const a = path.resolve(p).toLowerCase();
  const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '');
  return a.length > r.length + 1 && a.startsWith(r) && (a[r.length] === '\\' || a[r.length] === '/');
}

// Absolute local path, no UNC / device / ".." tricks (the renderer could
// read such files with read-file anyway: this is defense in depth).
function plainLocalPath(p) {
  if (typeof p !== 'string' || p.length < 4 || p.length > 4096 || p.includes('\0')) return false;
  if (p.startsWith('\\\\') || p.startsWith('//')) return false;  // UNC, \\?\ and \\.\ device paths
  if (!path.isAbsolute(p)) return false;
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(p)) return false;
  return !p.split(/[\\/]/).includes('..');
}

function sanitizeName(name) {
  const n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
  return n || 'OpenMix recording.wav';
}

// Moves a finished recording to where the user saved it (SPEC.md §14):
//  - same drive: a rename, instant and atomic (a 2-hour set is ~2 GB);
//  - another drive (EXDEV only): a copy into "<dest>.part" in 4 MiB chunks,
//    flushed, verified (size, first and last MiB), then renamed to dest; the
//    caller deletes the original only after that;
//  - a copy still running at quit is aborted between two chunks and its
//    partial file deleted (abortCopies): never a truncated file that looks
//    finished.
// `ops` = the fs.promises functions used (tests inject a failing rename or a
// slow read).
function makeRecordingMover(ops = {}) {
  const rename = ops.rename || ((a, b) => fsp.rename(a, b));
  const open = ops.open || ((f, m) => fsp.open(f, m));
  const unlink = ops.unlink || ((f) => fsp.unlink(f));
  const stat = ops.stat || ((f) => fsp.stat(f));
  const copies = new Set();  // { part, aborted, done }

  async function copyChunked(src, dest, size, job) {
    const a = await open(src, 'r');
    let b = null;
    try {
      b = await open(dest, 'w');
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(COPY_CHUNK, size)));
      let pos = 0;
      while (pos < size) {
        if (job.aborted) throw new Error('OpenMix is closing: copy aborted');
        const { bytesRead } = await a.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (bytesRead <= 0) throw new Error('the recording ended early');
        let off = 0;
        while (off < bytesRead) {
          const { bytesWritten } = await b.write(buf, off, bytesRead - off, pos + off);
          off += bytesWritten;
        }
        pos += bytesRead;
      }
      await b.datasync();  // on the disk before the original is deleted
    } finally {
      await a.close().catch(() => {});
      if (b) await b.close().catch(() => {});
    }
  }

  async function verify(src, dest, size) {
    const st = await stat(dest);
    if (st.size !== size) throw new Error(`copy size ${st.size} != ${size}`);
    const a = await open(src, 'r');
    const b = await open(dest, 'r');
    try {
      for (const pos of [0, Math.max(0, size - MIB)]) {
        const n = Math.min(MIB, size - pos);
        if (n <= 0) continue;
        const ba = Buffer.alloc(n);
        const bb = Buffer.alloc(n);
        await a.read(ba, 0, n, pos);
        await b.read(bb, 0, n, pos);
        if (!ba.equals(bb)) throw new Error('copy verification failed');
      }
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  }

  /** 'renamed' (the original is gone) or 'copied' (the caller deletes the original); throws on failure. */
  async function moveRecording(src, dest, size) {
    try {
      await rename(src, dest);
      return 'renamed';
    } catch (err) {
      if (!err || err.code !== 'EXDEV') throw err;
    }
    const job = { part: `${dest}.part`, aborted: false, done: null };
    let settle;
    job.done = new Promise((r) => { settle = r; });
    copies.add(job);
    try {
      await copyChunked(src, job.part, size, job);
      if (job.aborted) throw new Error('OpenMix is closing: copy aborted');
      await verify(src, job.part, size);
      await rename(job.part, dest);
      return 'copied';
    } catch (err) {
      await unlink(job.part).catch(() => {});
      throw err;
    } finally {
      copies.delete(job);
      settle();
    }
  }

  /** Quit: running copies stop between two chunks, their partial files are deleted. */
  async function abortCopies(graceMs = QUIT_GRACE_MS) {
    const jobs = [...copies];
    if (!jobs.length) return 0;
    for (const j of jobs) j.aborted = true;
    let timer = null;
    await Promise.race([Promise.all(jobs.map((j) => j.done)), new Promise((r) => { timer = setTimeout(r, graceMs); })]);
    clearTimeout(timer);
    for (const j of jobs) {
      try { fs.unlinkSync(j.part); } catch { /* deleted already (or still open: the ".part" name says it) */ }
    }
    return jobs.length;
  }

  return { moveRecording, abortCopies, running: () => copies.size };
}

function install(opts) {
  const { getWindow, app, ipcMain } = opts;
  const log = opts.log || ((...a) => console.log('[engine-main]', ...a));
  const hostScript = opts.hostScript || path.join(__dirname, 'engine-host.js');
  const modulePath = unpacked(
    opts.modulePath || process.env.OPENMIX_ENGINE_MODULE ||
      path.join(__dirname, 'native', 'engine', 'build', 'Release', 'openmix_engine.node')
  );
  const dataDir = () => opts.dataDir || app.getPath('userData');
  const recordingsDir = () => path.join(dataDir(), 'recordings');
  const showSaveDialog = opts.showSaveDialog || ((win, o) => (win ? dialog.showSaveDialog(win, o) : dialog.showSaveDialog(o)));
  const showItemInFolder = opts.showItemInFolder || ((p) => shell.showItemInFolder(p));
  const idleShutdownMs = Number(opts.idleShutdownMs) > 0 ? Number(opts.idleShutdownMs) : IDLE_SHUTDOWN_MS;
  const quitGraceMs = Number(opts.quitGraceMs) > 0 ? Number(opts.quitGraceMs) : QUIT_GRACE_MS;
  // PCM memory limit of the host (0 / absent: the host takes ~40 % of the RAM)
  const maxPcmBytes = Number(opts.maxPcmBytes) > 0 ? Math.floor(Number(opts.maxPcmBytes)) : 0;
  const mover = makeRecordingMover(opts.fsOps || {});

  let host = null;       // the engine host utility process (one at a time)
  let hostReady = null;  // Promise<{ok, error?, version?, protocol?}>
  let hostExit = null;   // Promise<exit code>
  let scanned = [];      // plugin files found by the scans
  const savedPaths = new Set();  // where recordings were saved (engine-reveal-file)
  // Hosts shut down on purpose (no page uses them, or quit): their exit is
  // not an engine failure to report to a page.
  const retired = new WeakSet();
  const retiring = new Set();    // Promises of hosts being shut down
  let idleTimer = null;
  const watched = new WeakSet(); // webContents whose navigations / crashes are watched

  const mainContents = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w.webContents : null;
  };
  const fromMainWindow = (e) => {
    const wc = mainContents();
    return !!wc && e && e.sender === wc;
  };

  // Child stdout / stderr, line by line, like the renderer console.
  function pipeLogs(child, tag) {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) console.log(tag ? `${line} (${tag})` : line);
        }
      });
    }
  }

  function belowNormal(child) {
    const set = () => {
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* not allowed: normal priority */
      }
    };
    if (child.pid) set();
    else child.once('spawn', set);
  }

  // ---- trusted policy -------------------------------------------------------
  async function vstFolders() {
    const std = path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3');
    const user = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Common', 'VST3') : null;
    let extra = [];
    try {
      // the folders added in Settings (main.js keeps them in turbo-settings.json)
      const s = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'turbo-settings.json'), 'utf8'));
      if (Array.isArray(s.vstFolders)) extra = s.vstFolders.filter((f) => typeof f === 'string');
    } catch {
      /* no settings yet */
    }
    const env = (process.env.OPENMIX_VST_PATH || '').split(';').filter(Boolean);
    return [...new Set([std, user, ...extra, ...env].filter((f) => f && plainLocalPath(f)))];
  }
  async function policy() {
    return { vstRoots: await vstFolders(), vstFiles: scanned };
  }
  async function sendPolicy() {
    if (host) host.postMessage({ type: 'policy', policy: await policy() });
  }

  // ---- the engine host ---------------------------------------------------------
  async function moduleState() {
    if (process.platform !== 'win32') return { available: false, reason: 'the native engine is Windows-only for now' };
    try {
      await fsp.access(modulePath);
    } catch {
      return { available: false, reason: 'native engine not built (npm run build:engine)' };
    }
    return { available: true, modulePath };
  }

  function spawnHost() {
    if (hostReady) return hostReady;
    let child;
    try {
      child = utilityProcess.fork(hostScript, [], { serviceName: 'OpenMix Engine', stdio: 'pipe' });
    } catch (err) {
      return Promise.resolve({ ok: false, error: String((err && err.message) || err) });
    }
    host = child;
    pipeLogs(child, '');
    hostExit = new Promise((resolve) => child.once('exit', resolve));
    hostReady = new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      // a first load of a new .node is scanned by Defender; COM takes time on a busy PC
      const timer = setTimeout(() => finish({ ok: false, error: 'the engine host did not start within 10 s' }), 10000);
      child.on('message', (m) => {
        if (m && m.type === 'ready') finish(m);
      });
      child.once('exit', (code) => finish({ ok: false, error: `the engine host exited (${code})` }));
    });
    child.once('exit', (code) => {
      if (host === child) {
        host = null;
        hostReady = null;
      }
      log(`engine host exited (${code})`);
      if (retired.has(child)) return;  // shut down on purpose: no page uses it
      const wc = mainContents();
      if (wc) wc.send('engine-exit', { code });
    });
    (async () => {
      let ownerHwnd = '0';
      try {
        const w = getWindow();
        if (w && !w.isDestroyed()) ownerHwnd = w.getNativeWindowHandle().readBigUInt64LE(0).toString();
      } catch {
        /* no owner: editors without an owner window */
      }
      const pol = await policy();
      if (host === child) child.postMessage({ type: 'init', modulePath, dataDir: dataDir(), ownerHwnd, policy: pol, maxPcmBytes });
    })();
    return hostReady;
  }

  // {type:'shutdown'} (the host finalizes a running recording first, then
  // closes the devices), then killed if it is still there after the grace.
  function retireHost(why) {
    const child = host;
    if (!child) return Promise.resolve();
    host = null;
    hostReady = null;
    retired.add(child);
    log(`shutting the engine host down (${why})`);
    const exited = hostExit;
    try { child.postMessage({ type: 'shutdown' }); } catch { /* gone */ }
    const p = Promise.race([exited, new Promise((r) => setTimeout(r, quitGraceMs))]).then(() => {
      try { child.kill(); } catch { /* already gone */ }
    });
    retiring.add(p);
    p.finally(() => retiring.delete(p));
    return p;
  }

  // The page that used the host is gone (navigated away: a reload, or the
  // Web engine chosen in Settings and a reload; or its renderer crashed). A
  // native page reconnects within seconds (engine-connect cancels this);
  // otherwise the host would keep its device (exclusive mode!), all its PCM,
  // its plugins and a running REC writing silence until quit.
  function cancelIdleShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }
  function armIdleShutdown(why) {
    if (!host || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      retireHost(`${why}; no page reconnected within ${Math.round(idleShutdownMs / 1000)} s`);
    }, idleShutdownMs);
  }
  function watchPage(wc) {
    if (!wc || watched.has(wc)) return;
    watched.add(wc);
    wc.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      const main = details && typeof details.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
      const same = details && typeof details.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
      if (main && !same) armIdleShutdown('the page navigated away');
    });
    wc.on('render-process-gone', (_e, d) => armIdleShutdown(`the renderer is gone (${(d && d.reason) || 'unknown'})`));
  }

  // One job in a short-lived helper process (VST scan, shadow decode).
  function runHelper(flag, message, serviceName, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try {
        child = utilityProcess.fork(hostScript, [flag], { serviceName, stdio: 'pipe' });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
        return;
      }
      pipeLogs(child, flag);
      belowNormal(child);
      let done = false;
      const timer = setTimeout(() => {
        finish({ ok: false, error: 'timeout' });
        try { child.kill(); } catch { /* gone */ }
      }, timeoutMs);
      function finish(r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
      child.on('message', (m) => finish(m));
      child.once('exit', (code) => finish({ ok: false, error: 'crashed', code }));
      child.postMessage(message);
    });
  }

  // ---- IPC --------------------------------------------------------------------------
  ipcMain.handle('engine-info', async () => {
    const st = await moduleState();
    return { ...st, running: !!host };
  });

  ipcMain.handle('engine-connect', async (e) => {
    if (!fromMainWindow(e)) return { ok: false, error: 'not the main window' };
    cancelIdleShutdown();
    watchPage(e.sender);
    // a host being shut down frees its device before a new one opens it
    if (retiring.size) await Promise.all([...retiring]);
    const st = await moduleState();
    if (!st.available) return { ok: false, error: st.reason };
    const r = await spawnHost();
    if (!r.ok || !host) return { ok: false, error: r.error || 'engine host unavailable' };
    // A new pair of ports per connection (a renderer reload gets fresh ones;
    // the host closes the previous pair).
    const ctl = new MessageChannelMain();
    const pcm = new MessageChannelMain();
    host.postMessage({ type: 'connect' }, [ctl.port1, pcm.port1]);
    e.sender.postMessage('engine-ports', null, [ctl.port2, pcm.port2]);
    return { ok: true, version: r.version, protocol: r.protocol };
  });

  // Kills the engine host and resolves when it is gone (<= 1 s): a hung but
  // alive host would otherwise keep playing under the Web engine.
  ipcMain.handle('engine-kill', async () => {
    const child = host;
    if (!child) return { ok: true, code: null };
    const exited = hostExit;
    try { child.kill(); } catch { /* already gone */ }
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 1000))]);
    if (code !== 'timeout' && host === child) {
      host = null;
      hostReady = null;
    }
    return { ok: code !== 'timeout', code: code === 'timeout' ? null : code };
  });

  ipcMain.handle('engine-vst-scan', async (_e, files) => {
    const roots = await vstFolders();
    const list = (Array.isArray(files) ? files : [])
      .filter((f) => plainLocalPath(f) && f.toLowerCase().endsWith('.vst3'))
      .filter((f) => roots.some((r) => isUnder(f, r)))  // only plugins of the VST3 folders
      .slice(0, 2000);
    const res = await runHelper('--scan', { modulePath, paths: list }, 'OpenMix VST scan', 10 * 60 * 1000);
    if (res && res.ok && Array.isArray(res.plugins)) {
      // Only successfully scanned plugins (entries with a uid) become trusted;
      // per-file error entries (V22) are reported but never whitelisted.
      const found = res.plugins.map((p) => p && p.uid && p.path).filter((p) => typeof p === 'string');
      scanned = [...new Set([...scanned, ...found])];
      await sendPolicy();
    }
    return res;
  });

  ipcMain.handle('engine-save-recording', async (e, src, name) => {
    if (!fromMainWindow(e)) return { ok: false, error: 'not the main window', kept: src };
    if (!plainLocalPath(src) || !isUnder(src, recordingsDir()) || path.extname(src).toLowerCase() !== '.wav')
      return { ok: false, error: 'not a recording of the engine', kept: src };
    let st;
    try {
      st = await fsp.stat(src);
    } catch {
      return { ok: false, error: 'recording not found', kept: src };
    }
    let fileName = sanitizeName(name || path.basename(src));
    if (!fileName.toLowerCase().endsWith('.wav')) fileName += '.wav';
    let base;
    try {
      base = app.getPath('music');
    } catch {
      base = app.getPath('documents');
    }
    const r = await showSaveDialog(getWindow(), {
      title: 'Save the recording',
      defaultPath: path.join(base, fileName),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    });
    if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true, kept: src };
    const dest = r.filePath;
    if (path.resolve(dest).toLowerCase() === path.resolve(src).toLowerCase()) return { ok: true, path: dest };
    let how;
    try {
      how = await mover.moveRecording(src, dest, st.size);  // a rename on the same drive, a verified copy across drives
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), kept: src };
    }
    savedPaths.add(path.resolve(dest).toLowerCase());
    if (how === 'copied') {
      try {
        await fsp.unlink(src);  // only once the copy is verified
      } catch (err) {
        log('the original recording could not be removed:', String((err && err.message) || err));
      }
    }
    return { ok: true, path: dest, moved: how };
  });

  ipcMain.handle('engine-reveal-file', async (e, p) => {
    if (!fromMainWindow(e) || !plainLocalPath(p)) return false;
    const known = isUnder(p, recordingsDir()) || savedPaths.has(path.resolve(p).toLowerCase());
    if (!known) return false;
    showItemInFolder(p);
    return true;
  });

  // Shadow decodes run one at a time, each in its own below-normal process.
  let shadowQueue = Promise.resolve();
  ipcMain.handle('engine-shadow-decode', (e, job) => {
    const run = async () => {
      if (!fromMainWindow(e)) return { ok: false, error: 'not the main window' };
      const loadId = job && Number.isFinite(job.loadId) ? job.loadId >>> 0 : 0;
      const p = job && job.path;
      if (!plainLocalPath(p) || !SHADOW_EXT.has(path.extname(p).toLowerCase())) return { ok: false, loadId, error: 'invalid path' };
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) return { ok: false, loadId, error: 'not a file' };
      } catch {
        return { ok: false, loadId, error: 'not found' };
      }
      const toF32 = (v) => (v instanceof Float32Array ? v : v && v.buffer ? new Float32Array(v.buffer) : null);
      const left = toF32(job.left);
      const right = toF32(job.right);
      if (!left || !right || left.length === 0 || left.length !== right.length) return { ok: false, loadId, error: 'invalid window' };
      const message = {
        modulePath,
        job: {
          loadId,
          path: p,
          rate: job.rate | 0,
          frames: Number(job.frames) || 0,
          windowStart: Number(job.windowStart) || 0
        },
        left,
        right
      };
      const r = await runHelper('--shadow', message, 'OpenMix shadow decoder', 3 * 60 * 1000);
      if (r && r.loadId === undefined) r.loadId = loadId;
      return r;
    };
    const p = shadowQueue.then(run, run);
    shadowQueue = p.catch(() => {});
    return p;
  });

  // ---- quit: the recording is finalized by the host before it goes ------------------
  // Awaitable: will-quit runs it; the paths that restart with app.exit()
  // (which skips will-quit) must await it first (SPEC.md §6.5 merge notes).
  async function shutdown() {
    cancelIdleShutdown();
    const tasks = [mover.abortCopies(quitGraceMs)];
    if (host) tasks.push(retireHost('OpenMix is closing'));
    for (const p of retiring) tasks.push(p);
    await Promise.all(tasks);
  }

  let quitting = false;
  app.on('will-quit', (event) => {
    if (quitting) return;
    if (!host && !retiring.size && !mover.running()) return;
    quitting = true;
    event.preventDefault();
    shutdown()
      .catch((err) => log('shutdown:', String((err && err.message) || err)))
      .finally(() => app.quit());
  });

  const api = {
    shutdown,
    // for tests and diagnostics
    hostPid: () => (host ? host.pid : null),
    policy
  };
  installed = api;
  return api;
}

// The installed instance (main.js installs once).
let installed = null;

/** Awaitable shutdown of the engine host (and of a recording copy still running): see install(). */
function shutdown() {
  return installed ? installed.shutdown() : Promise.resolve();
}

module.exports = { install, shutdown, makeRecordingMover };
