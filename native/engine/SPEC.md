# libopenmix — specification of the OpenMix native audio engine

Status: architecture v2 (2026-10-20). The v1 skeleton was revised after an
architecture review; Appendix C lists every review item with its decision
(and the reason when a proposal was not taken as written). Scope: Phase 2
"native engine core, opt-in beta" plus the Phase 3 parity items that shape
the interfaces. Branch `engine-native`, folder `native/engine`. Every source
file starts with a comment saying what it is for and who owns it. Code,
comments and docs are in English. All modules implemented; verified by five
campaigns on 2026-11-07 and integrated the same day, then corrected after
three code reviews the same evening (Appendix E: numbers, open decisions;
E.8: the review round).

The engine is **libopenmix**: C++20 where the sound is made, the existing web
UI kept, the engine behind a flat C interface, run in an Electron utility
process, offered as **"Native engine (beta)"** in Settings, with automatic
fallback to the current Web Audio engine (`src/js/engine.js`), which stays the
default.

Contents

1. Ground rules
2. Process model
3. Threads, command routing and real-time rules
4. Time model
5. Sample formats
6. Flat C API, Node-API binding, engine host, main and preload wiring
7. PCM handoff and the shadow decoder
8. Device layer
9. Deck
10. Mixer
11. FX
12. Sync and auto-master
13. VST3 inline
14. Recording
15. JSON protocol
16. engine.js API used by app.js → protocol / state (mapping table)
17. JS proxy (`src/js/native-engine.js`)
18. Build and tests
19. Module ownership and integration
20. Intentional differences from the Web engine
- Appendix A. Constants copied from engine.js
- Appendix B. Constants of the native engine
- Appendix C. Architecture review of 2026-10-20: decisions
- Appendix D. Host implementation status (2026-10-20)
- Appendix E. Verification campaigns of 2026-11-07

---

## 1. Ground rules

These come from the architecture study (`final.json`) and are not negotiable.

1. **Flat C boundary, portable core.** The core is C++20 and
   platform-neutral. Windows code lives only in `win/` subfolders of the
   device, decoder and VST modules (`src/device/win/`, `src/decoder/win/`,
   `src/vst/win/`), compiled into separate libraries (§18.2); `none/`
   subfolders hold the stand-ins (or plain C++ implementations) used where
   a Windows backend is not built. Hosts only see `include/om/om_engine.h` (create/destroy, command, state
   snapshot, events, PCM handoff, policy). The Node-API module is a thin
   binding over it. The core runs headless (NULL device, offline render) for
   every test, and the portable set (everything except `win/`) builds and
   passes its tests without Windows (`OM_PORTABLE_ONLY`, §18.5).
2. **Chromium's timeline is the truth.** Cached cues and beat grids are
   seconds on Chromium's decoder timeline and MP3 decoders differ by up to
   ~51 ms. The default load path is the PCM decoded by Chromium in the
   renderer (`decodeAudioData`, as for the analysis today) handed to the
   engine, which stores it as int16 with a headroom gain (per track when the
   renderer knows the track's peak, per 65536-frame chunk otherwise) or as
   float32 for hi-res sources. The Media Foundation decoder runs in
   **shadow mode only**, in a separate short-lived process: it decodes the
   same file and reports offset, length and RMS difference; it is never used
   for playback until at least 99 % of tracks agree within 1 ms.
3. **Sound identical first.** Linear interpolation like Chromium's
   AudioBufferSourceNode (cubic later, behind a blind A/B); biquads with the
   Web Audio formulas (Q in dB for lowpass/highpass, plain Q for
   peaking/bandpass/allpass/notch, gain in dB for peaking and shelves, slope
   1 for shelves — `om/dsp.h`); the limiter = Chromium's
   DynamicsCompressorKernel with engine.js's settings; every curve, constant
   and AudioParam time constant of the EQ, filter, fader, crossfader, FX and
   sync copied verbatim from engine.js (Appendix A). Keylock = line-by-line
   port of `pitch-worklet.js` (WSOLA) reading straight from the track, so
   PLAY and hot cues start without the 55-60 ms delay. Scratch = a
   continuous read pointer that plays real reverse audio. Parity is proven
   against **golden renders produced by Chromium itself** (§18.4), never only
   against reference ports written from memory.
4. **Sync on exact positions.** engine.js `syncLock` and the master rules
   ported verbatim with their constants, run every audio block on exact
   heard positions, with every duration measured on the audio sample clock
   (target: phase error < 1 ms p99 over 10 minutes).
5. **VST3 inline**, ported from the hardened `native/vsthost/src/vsthost.cpp`
   (host thread, loading, timeouts, editors, state, SEH guard). Each deck's
   plugin runs on a per-deck real-time worker synchronised with the device
   callback and bounded by a deadline, so a hung plugin can never silence the
   mix; plugin latency is compensated by reading ahead; the deck's real beat
   position goes to the plugin transport.
6. **Own WASAPI backend** behind a device interface (miniaudio / CoreAudio /
   ASIO can replace or join it later): shared mode by default (low-latency
   period through IAudioClient3 when the driver supports it, never below
   ~5 ms by default), exclusive as an opt-in with fallback; master on 1/2
   and cue on 3/4 of 4-channel controllers, or headphones on a second device
   through a drift-correcting resampler; NULL device for tests. No ASIO yet
   (licence paperwork pending).
7. **Process.** An Electron utilityProcess "engine host" loads
   `openmix_engine.node`; main brokers MessagePorts to the renderer; if the
   engine host dies, hangs or its audio stalls, the renderer has main kill it
   and falls back to the Web engine, telling the user. Recording: master to
   WAV 24-bit from a writer thread; a recording is never deleted by the app.
8. **Licence: everything stays MIT.** No JUCE, no Rubber Band, no Mixxx/GPL
   code, **no download at all** (very slow connection): only the Windows SDK,
   the Steinberg VST3 SDK already in `native/vst3sdk` (MIT since 3.8),
   node-addon-api and cmake-js from `node_modules`, and the Electron already
   in `node_modules` (golden renders, §18.4). Ported Chromium code (biquad,
   dynamics compressor, reverb normalization) is BSD-3: keep its licence
   header in the port.

Shared-PC rules (the owner games on this PC): tests are never audible and
never block other apps' audio — NULL device and offline render first;
real-device smoke tests only in SHARED mode, gain 0, 5 s at most, opt-in
(`OM_TEST_REAL_DEVICE=1`); **never exclusive mode in tests**. Builds run at
below-normal priority, one build at a time on the PC (lock file, §18.1), 4
parallel projects. Never start or stop the owner's OpenMix, never touch ports
8722 / 9333, never commit or push. The golden-render script (§18.4) uses the
same `electron.exe` path as OpenMix (node_modules junction): it must exit on
its own and is never killed by path or by name.

Worktree rules (8 engineers share one worktree, nothing is committed):
**no destructive git command** in `openmix-engine` — never `git stash`,
`checkout`, `switch`, `restore`, `reset`, `clean`, `rebase`, `merge`,
`commit`, `add`, `rm` or `mv` there; files are moved with the file system.
Each engineer snapshots their module with `node tools/engine-snapshot.js
--module <key>` at least at every milestone (§19.3).

---

## 2. Process model

```
 Electron main (main.js + engine-main.js)
   main.js: a 3-line hook only (require('./engine-main').install(...), shutdown on quit)
   engine-main.js (owner: host), every engine IPC:
   - engine-info / engine-connect / engine-kill / engine-vst-scan /
     engine-save-recording / engine-reveal-file / engine-shadow-decode
   - spawns the engine host once:
       utilityProcess.fork(engine-host.js, [], { serviceName: 'OpenMix Engine', stdio: 'pipe' })
   - two MessageChannelMain per connection: "ctl" (JSON text both ways) and
     "pcm" (PCM chunks renderer -> host, acks host -> renderer); port1s to the
     child, port2s to the renderer (webContents.postMessage('engine-ports', null, [ctl, pcm]))
   - trusted policy for the host: VST folders and scanned plugin files (§15.6)
   - child 'exit' -> webContents.send('engine-exit', { code }); engine-kill = kill + wait for 'exit' (<= 1 s)
   - short-lived helpers, below-normal priority: engine-host.js --scan (VST scan),
     engine-host.js --shadow (Media Foundation shadow decode, one file per process)
   - recordings: Save dialog + async verified copy (the original is kept until the copy is verified)
        |                                          |
 renderer (index.html, app.js)               engine host (utility process)
   preload: one additive block               engine-host.js (Node)
     window.omEngine = {...}                   require(openmix_engine.node)
     forwards the two ports with               ctl text -> engine.command()  (never blocks)
     window.postMessage('openmix-engine-ports',  pcm chunk -> engine.pcmWrite()
                        '*', [ctl, pcm])       events -> ctl.postMessage(text) (state coalesced)
   src/js/native-engine.js (NativeEngine)    libopenmix threads: control, ops, vst-ops,
     the engine.js API for app.js              audio (WASAPI, MMCSS), VST host + 4 deck
     mirrors + prediction + reconciliation     workers, phones, recorder writer
     PCM chunking (float32, no JS loops)
     clock sync, liveness, fallback to engine.js
```

Lifecycle

1. app.js creates its engine through `createAudioEngine()` (native-engine.js).
   Setting `audioEngine` (localStorage): `web` (default) → `new AudioEngine()`
   exactly as today; `native` / `native-exclusive` → a `NativeEngine` facade.
2. The facade asks `window.omEngine.info()` (`{available, reason}`: Windows,
   `.node` present), then `window.omEngine.connect()`. Main spawns the host
   (once per app run), sends it `{type:'init', modulePath, dataDir,
   ownerHwnd, policy}` then `{type:'connect'}` with the two port1s; the
   renderer receives the port2s through the preload. The facade sends
   `hello` (reply: engine version, protocol, sampleRate, channels,
   chunkFrames, epoch), runs 5 quick `clock.ping`s, then opens the **saved**
   output device **once** (`device.open` with the saved label, §8.1; mode
   `lowlatency`, or `exclusive` for `native-exclusive`; the engine falls back
   to shared by itself). app.js's own startup `setSinkId` of the same device
   is answered by the shim without a second open.
3. Until `hello` has been answered the facade works on its mirrors and
   queues commands (bounded, coalesced) and the UI stays usable;
   `engine.ctx.decodeAudioData` waits for the device rate (the `device.open`
   reply). The `hello` timeout is **10 s** (first load of a new `.node` is
   scanned by Defender, COM and the device take time on a busy PC).
4. Any failure before ready (no module, spawn error, `hello` timeout,
   `device.open` failure) → **fallback** (§17.6) and app.js shows
   `engine_native_fallback`.
5. During the session: `engine-exit`, the liveness rule (§17.6: no `state`
   and no `hb` for ≥ 3 s while the renderer itself was responsive, and a
   `clock.ping` timed out) or an audio stall the engine could not recover
   (`device {reason:"stalled"}`) → main kills the host, then the same
   fallback, re-applying the current state. One fallback per session, no
   automatic respawn.
6. Renderer reload: main keeps the host, sends a new pair of ports; the new
   facade's `hello` carries `reset: true` (§15.3: the engine unloads every
   deck, clears the loop bounds, restores mixer/sync defaults, resets
   `ack`, starts a new PCM epoch, unloads the plugins and finalizes a
   running recording on the ops thread, with a `rec.status` event). At
   connect the facade also finalizes a recording left running by the
   previous page (`rec.status` active → `rec.stop`) before `rec.list`, so the
   file is offered with the other unsaved recordings (app.js reloads the
   page on a language change). Keeping the music through a UI reload is
   Phase 4.
7. App quit: main sends `{type:'shutdown'}` to the host (which finalizes
   a running recording before it waits for a plugin job, §6.5), kills it
   after 2 s. A host no page uses any more (the page navigated away, e.g.
   to the Web engine, or the renderer crashed) is shut down the same way
   15 s later unless a page connects again.

The `.node` is loaded from `native/engine/build/Release/openmix_engine.node`
(`app.asar.unpacked` in the installer: packaging adds it to `build.files` and
`asarUnpack`, and `engine-host.js` / `engine-main.js` to `build.files`).

---

## 3. Threads, command routing and real-time rules

### 3.1 Threads of the engine host

| Thread | Priority | Work | Allowed |
|---|---|---|---|
| host JS (Node main thread) | normal | MessagePort I/O, `om_engine_command` (parse + inline commands + pushes), `om_pcm_write/end`, event delivery | bounded work only: **never blocks for more than ~1 ms**, never touches COM, never frees large memory, never waits for another engine thread |
| control (`om-control`) | above normal | drains audio events and retired objects, frees memory (PCM, grids, retired chains), allocates FX units and chains, `state` events (only when a new snapshot exists), heartbeat `hb` (250 ms), overflow diagnostics, stall watchdog, power-throttling re-check, PCM garbage collection. Woken by the audio thread (events, retired objects, and the first block at or after the time the next `state` is due) through a counting semaphore (`release` = WakeByAddress / futex: non-blocking, RT-safe); otherwise sleeps until the heartbeat (≤ 50 ms) | allocate, short non-RT mutexes, `try_lock` on the preparation mutex; **never blocks** on I/O, devices or plugins |
| ops (`om-ops`) | normal | FIFO of blocking jobs: `device.list/open/close/phones`, device events (posted by the outputs and the process-wide `DeviceWatcher`), loss / restore, stall restarts, `rec.start/stop/list`, `shutdown`; a 250 ms tick (device status: period steps, glitches, jitter, silent loss; headphones; recorder errors; loss re-check); replies by event. COM is initialized by the device backend's own entry points (the core has no platform header) | COM, I/O, waits |
| vst-ops (`om-vst-ops`) | normal | FIFO of `vst.*` jobs: posts each to the VST host thread and waits with the hardened time-outs (load 60 s, dialogs up to 600 s); replies by event | waits (a plugin dialog never delays device or recording jobs) |
| audio (device callback) | MMCSS "Pro Audio", AvSetMmThreadPriority HIGH (TIME_CRITICAL when MMCSS is unavailable) | the render callback (§3.4) | real-time rules only |
| VST deck workers ×4 (`om-vst-d0..3`) | MMCSS "Pro Audio" | each deck's plugin `process()`, handed a block by the callback and bounded by the deadline (§13.2) | plugin code (SEH-guarded, FP environment restored) |
| VST host | normal | Win32 message loop of the hardened vsthost.cpp: every VST3 call except `process()`, editors | anything plugins do |
| device notifications | normal (COM) | IMMNotificationClient → control/ops | post only |
| phones | MMCSS "Pro Audio" | second WASAPI stream (SecondaryOutput) | real-time rules |
| recorder writer | above normal | WAV writing | file I/O |

"Above normal" is applied by `raiseServiceThreadPriority()` (device.h:
`THREAD_PRIORITY_ABOVE_NORMAL` on Windows, a no-op in the portable build) at
the top of the control loop and of the recorder's writer loop.
The VST scan and the shadow decode run in other processes (§13.6, §7.4).
In manual mode (`om_config.manual`, tests) there is no thread at all:
`om_engine_pump()` runs one control iteration **and** drains the ops and
vst-ops queues on the caller's thread, so tests stay deterministic.

### 3.2 Real-time rules (audio, phones, VST deck workers outside plugin code)

Inside the callback and everything it calls — deck, mixer, FX, sync,
recorder push, phones push, the VST handoff — there is **no allocation, no
free, no lock (only `try_lock` and the lock-free SPSC queues), no I/O, no
logging, no exception, no blocking system call**. All functions on this
path are `noexcept`. Each real-time thread calls `dsp::flushDenormals()` once
(FTZ/DAZ on x86, FPCR.FZ on arm64).

The one sanctioned wait: after handing the deck plugins their block, the
callback **spins** (`_mm_pause`, no kernel wait) until each worker is done
or the block deadline passes (§13.2). It is bounded by construction.

Mechanisms (`include/om/`):
- `SpscQueue<T>` (`spsc_queue.h`): commands in (`RtCommand`, 4096), events
  out (`RtEvent`, 4096), retired objects out (`Retired`, 4096). The
  producers of the command queue (host JS thread; control and ops threads
  for attach / routing commands) are serialized by a mutex the audio thread
  never touches. `freeApprox()` gives
  producers a lower bound of the free slots (batch reservation, §3.3).
- Queue sizing (worst case): at most 512 commands are applied per callback;
  each can produce at most one event and one retired object, plus at most 16
  events of the callback itself. 4096 entries hold 7 callbacks of worst-case
  traffic while the control thread is late; beyond that, events are counted
  as lost and retired objects wait in a fixed 256-entry backlog that the
  callback retries every block (never freed on the audio thread, never
  leaked silently). Every overflow is counted in `om_state.health` (§15.5)
  and reported as a `diag` event.
- `TripleBuffer<om_state>` (`triple_buffer.h`): the audio thread publishes the
  state after every block; readers serialize on a mutex among themselves.
- `rt::Scope` (`rt.h`): marks the callback. Every allocation **and every
  free** inside is counted by the allocation trap: the test runner
  (`tests/om_test_main.cpp`) replaces operator new/delete for every test
  executable and fails any test that allocates or frees inside an
  `rt::Scope`; the `.node` gets the same trap when built with `--rt-trap`
  (`OM_RT_TRAP`, `src/node/rt_trap.cpp`) and reports `{"ev":"diag",
  "kind":"rt-alloc"|"rt-free"}`. `rt::PluginScope` lifts the mark around
  plugin calls and counts their allocations separately (they are the
  plugin's business, reported in `vst.status`, never engine violations).
- RT lint (§18.6): direct `malloc/free/HeapAlloc/VirtualAlloc...` calls are
  invisible to the trap, so the build script greps the sources and fails on
  them outside an explicit per-line allow marker.
- Ownership (`media.h`): TrackBuffers, BeatGrids, StemSets, FX units and FX
  chains are built off the audio thread, attached by pointer through a
  command, never freed by the audio thread, and handed back through the
  retired queue to be freed by the control thread. The PCM store frees
  buffers only in `PcmStore::freePending()`, called by the control thread, so
  dropping the last user of a 69 MB track never runs `VirtualFree` on the
  audio thread or the host JS thread.
- End of track is a **sticky latch** (`om_deck_state.ended_count`), not a
  queued event: the control thread derives `deck.ended` from the snapshots,
  so a full event queue can never lose it.

### 3.3 Command routing, batches and acknowledgement

`om_engine_command()` parses a message (one command or a batch array) on the
caller's thread (the host JS thread) and routes every command by its
`route` (protocol table, §15.3):

| Route | Commands | Where | Answer |
|---|---|---|---|
| `audio` | knobs, transport, FX, sync... | pushed as `RtCommand`s to the audio thread | `ack` / `applied` |
| `inline` | `hello`, `engine.config`, `clock.ping`, `pcm.begin/abort`, `deck.load/unload/stems/grid`, `sampler.load/clear`, `device.status`, `rec.status`, `vst.status` | executed at once on the caller's thread, **in order with the audio commands around them** (they only allocate a few objects, read cached status and push attach commands: bounded, < 1 ms) | reply event (synchronous) |
| `ops` | `device.list/open/close/phones`, `rec.start/stop/list`, `shutdown` | queued to the ops thread | reply event (asynchronous) |
| `vst` | `vst.load/unload/editor/editorClose/getState/setState` | queued to the vst-ops thread | reply event (asynchronous) |

Why the ordered control commands stay inline: `deck.load` must reach the
audio thread before a `deck.play` sent right after it; queuing it to another
thread while later audio commands are pushed directly would reorder them.
They are kept bounded instead (no I/O, no COM, no plugin call, no large
free). Everything that can block — devices, files, plugins — runs on the ops
and vst-ops threads, so neither the host JS thread nor the control thread
(which carries `state` and `hb`) is ever held up. Effects of `ops` / `vst`
commands are asynchronous: the proxy waits for their reply when it needs
ordering (e.g. `vst.mix` after the `vst.load` reply).

**Batches are atomic.** The core counts the `RtCommand`s a message will push
(audio commands, and the attach commands of inline ones: `deck.load` 4,
`deck.unload` 4, `deck.stems` 1, `deck.grid` 1, `sampler.load/clear` 1,
`hello {reset}` 1, `engine.config {vstDeadline}` 1 — `queueCost()` in
protocol.h), takes the producer mutex, and rejects the whole message
with `OM_ERR_FULL` (nothing applied, nothing acquired) when `freeApprox()`
is smaller; otherwise it executes the whole message under the mutex. An
inline command that fails at run time (e.g. `deck.load` of an unknown
`loadId`) replies with an error and releases what it acquired; the other
commands of the batch still apply.

**Acknowledgement.** Commands carry a `seq` (monotonic per connection). The
audio thread applies the queued commands in arrival order and publishes in
`om_state.ack` the highest `seq` it applied; since the host JS thread pushes
in order, every `seq ≤ ack` has been applied — **except commands that carry
`when`**: they are excluded from `ack` and confirmed by an `applied {seq, t,
late}` event when they take effect (or when the 64-entry pending list was
full and they were applied at once, `late: true`). `ops` / `vst` commands are
confirmed by their reply, not by `ack`. On `hello {reset}` the audio thread
sets `ack` back to 0 and publishes the new `epoch` (§15.3).

### 3.4 Render callback (core, `src/core/engine.cpp`)

```
render(out, frames, channels, deviceClock)        // rt::Scope
  clk = deviceClock; clk.presentTime += mixer.masterLatencyFrames() / rate   // limiter look-ahead
  clk.sampleTime = sampleClock                                              // §4.1
  vst.startCallback(frames / rate)                                          // block deadline
  retry the retired backlog
  pop commands (<= 512): "when" in the future -> pending (64; full -> apply now, applied{late})
  for each sub-block (<= 2048 frames, split at pending "when" offsets, sample-exact):
    apply due pending commands (applied event)
    sync.tick(sub, mixer.mixView(), mixer.fxRackView())          // sample-clock durations
    mixer.setFxBeatClock(unit, sync.xxxBeatClock())               // panel, pad, master units
    vst.setTransport(deck, transport at the insert INPUT position, §13.3)
    deck[k].render(deckBuf[k], n, sub)                            // pre-TRIM, own 128-frame quantum phase
    mixer.process(deckBuf, n, sub)   // strips; IInsert::begin for every deck; decks without
                                     // insert + sampler; IInsert::end; post taps; buses; limiter
    mixer.writeOutput(out); recorder.push(master); phones.push(cue, sub.callbackTime)
  publish om_state (decks with seg/anchors/ended_count, sync, mixer, device, health, ack, epoch, t)
  sampleClock += frames / rate
```

Commands without `when` apply at the start of the next block, in arrival
order. Command application is the only place module setters are called.

### 3.5 Liveness, heartbeat and stalls

- The control thread emits `state` only when the audio thread published a
  new snapshot since the previous `state` (`om_state.block` advanced; never
  before the first block), at most `stateHz` (60) per second. A frozen audio
  thread therefore stops the `state` stream instead of repeating the last
  snapshot. The cadence is driven by the audio thread (it wakes the control
  thread on the first block at or after the due time), so it does not
  depend on the OS timer resolution: measured 54 states/s with 128-frame
  blocks paced by a high-resolution timer (33/s when the NULL pacer itself
  sleeps with the 15.6 ms timer of a portable build).
- Independently it emits `{"ev":"hb","t","block","running"}` every 250 ms:
  the host process is alive even when the audio is not.
- **Stall watchdog** (control thread): when audio is expected (a device was
  started and has not been stopped on purpose — an atomic flag the ops
  thread clears around every switch, so a slow WASAPI open is never a
  stall) and `om_state.block` has not advanced for more than `stallMs`
  (0.5 s), it emits `diag {kind:"stall", ms}`, and the ops thread restarts
  the stream once (close, reopen the same endpoint and configuration). If
  audio does not resume within `stalledMs` (2 s) of the detection, it emits
  `device {reason:"stalled", status}`: the proxy then falls back (§17.6). When
  blocks flow again the episode ends with `diag {kind:"stall-recovered",
  ms}`. A plugin cannot cause a stall (§13.2); a stall means the driver or
  the engine itself. Measured (fake driver frozen in a test): `stalled` 1.5-1.6
  s after the freeze with stallMs 300 + stalledMs 1200; a restart onto a
  working stream recovers without `stalled`.
- The binding never queues more than one pending `state` event (§6.3), so a
  renderer that was busy receives the latest state, not a burst of stale
  ones.

---

## 4. Time model

### 4.1 Clocks

- **Engine clock `E`**: seconds, `std::chrono::steady_clock` (QPC) since the
  engine was created; in manual mode, the NULL device's virtual clock.
  Protocol timestamps (`at`, `when`, `t`, `te`, `anchorT`, `endedAt`) are on
  this clock, and it is used **only** to convert them.
- **Sample clock `S`** (`SampleTime`): seconds of audio the engine has
  rendered, Σ frames / rate over every block, continuous across device
  switches and device loss (the NULL pacer keeps it running, §8.4). **Every
  internal duration** uses it: sync grace periods, the "ended < 2 s ago"
  window, calibration windows, servo timing, scratch follower, spin
  envelopes, LFO phases, smoothers, sampler and armed-start waits. engine.js
  deliberately measured its calibration slopes on the audio clock
  (`ctx.currentTime`, engine.js:2557) because mixing two drifting clocks
  broke them; the native engine keeps that rule everywhere, and tests on the
  NULL device's virtual clock exercise the same arithmetic as production.
- **Device clock mapping** (owner: device): `presentTime` (E at which a
  block's first frame reaches the DAC) comes from
  `IAudioClock::GetPosition(&pos, &qpcPos)` — the frame being played at a
  QPC instant — extended to the first frame of the new block by the frames
  written since, or from a filtered (least-squares / DLL) frame → QPC
  mapping. It never uses the callback's wake-up time, which jitters by
  scheduling (worse with a game running) and moves in period steps in
  shared mode. Target: jitter < 0.1 ms p99, monotonic, continuous.

### 4.2 Blocks

`BlockClock` (common.h): `frame` (device frame index), `frames`,
`sampleRate`, `callbackTime` (E when rendered), `presentTime` (E when the
first frame is **heard at the master output** = device mapping + master
chain latency, i.e. the limiter's 6 ms look-ahead), `sampleTime` (S at the
first frame). Sub-block `k` frames later: `+ k / rate` on both clocks.

### 4.3 Heard position and rate

The heard position is the track position the listener hears at a given E.
The deck keeps the exact mapping from output frames to track positions
(through tempo changes, the WSOLA lockstep offset, plugin read-ahead,
loops), so the heard position at `presentTime` is exact, not estimated.
`om_state.t` = presentTime of the frame right after the last rendered block;
each deck's `pos` = heard position at `t`; `rate` = the **nominal heard
rate** at `t`: the tempo the listener hears (under keylock the WSOLA output
follows the input produced 2647 frames earlier, so a tempo change shows in
`rate` when it is heard), the scratch speed, 0 when still or armed.

### 4.4 Segments (what makes 60 fps playheads exact)

A **segment** is a stretch where the heard position is continuous. The deck
starts a new one — `seg` +1, `anchor_t` = E at which the new segment is
heard, `anchor_pos` = heard position there — at: play (after the armed wait,
§9.1), pause and stop, seek, hot cue, beat jump, sync / snap jump, loop
entry jump, scratch start and end, natural end, load and unload. Loop wraps
do **not** start a segment (the proxy wraps positions into the loop itself,
like engine.js `currentTime()`); tempo changes do not either (the position
stays continuous; `rate` changes). Within a segment of a looping deck the
proxy unwraps the wrapped `pos` of each snapshot onto its own timeline (k
loop lengths), like engine.js's unwrapped `currentTime()` folded on read, so
a read before `t` never shows a position below `loopStart` (§17.3).

Because `t` and every anchor are presentTimes, they lie ~20-45 ms in the
future when the snapshot is read. The proxy therefore never extrapolates a
new segment backwards across its start: it shows the previous segment until
`engineNow() ≥ anchor_t` (§4.5). The playhead then stops exactly at the stop
position and starts exactly at the cue, while the audio still plays the
output latency.

### 4.5 Proxy clock sync and extrapolation

- `clock.ping {t0}` (t0 = performance.now()/1000) → event `clock.pong {t0,
  te}`; with t1 the arrival time, offset = te − (t0 + t1)/2, rtt = t1 − t0.
  The proxy keeps the minimum-rtt sample of the last 8 (5 pings at connect,
  then one every 2 s) and computes `engineNow() = performance.now()/1000 +
  offset`.
- Model per deck: the current segment `{seg, anchorT, anchorPos}` plus the
  latest `(t, pos, rate)`, and the previous segment model (the last one seen
  with another `seg`; rate 0 when it was stopped).
- `currentTime() = now < anchorT ? previous(now) : pos + (now − t) × rate`,
  wrapped into the loop like engine.js, clamped to [−3600, duration].
- Every snapshot is adopted (pos, t, rate); a difference to what the
  playhead shows below 3 ms is slewed over ~100 ms, a bigger one snaps.
- Adoption is gated only by **unacknowledged discontinuous commands** of
  that deck (play, pause, seek, cue, hot cue, loop entry/exit with a jump,
  scratch, load, sync/snap jumps): until `ack` covers them (or their
  `applied` event came for `when` commands), the facade keeps its own
  prediction for the transport. Tempo, pitch-fader and jog-nudge streams are
  continuous and never block adoption.

### 4.6 `at`, `when`, `seq`

- **`at`**: the proxy stamps every command with `at = engineNow()`. A
  position the UI computed from `currentTime()` at `at` is made exact by the
  deck at the block's presentTime (target advanced by (presentTime − at) ×
  tempo while playing). This replaces engine.js's fixed 30 ms scheduling
  lead and its `+0.03 × tempo` compensation.
- **`when`** (optional): absolute E at which the command must be heard; the
  core applies it at the exact frame by splitting the block, and confirms it
  with `applied`. Not used by the proxy in Phase 2; reserved for quantized
  actions and the Phase 3 MIDI hot path. `hello {reset}` drops every `when`
  command still scheduled (never applied on the new page, no `applied` with
  an old seq; an object one carries, e.g. a `when` deck.load's track, goes
  back to the control thread).
- **`seq` / `ack`**: §3.3.

---

## 5. Sample formats

| Where | Format |
|---|---|
| Renderer → engine (wire) | **float32 planar** chunks of `chunkFrames` (65536) frames: `channels` × `frames` floats, channel c at `[c × frames, (c+1) × frames)`, 1..8 channels as decoded by Chromium |
| Track, stem and sampler PCM in the engine | `TrackBuffer`: interleaved stereo, **int16** with a per-chunk scale (`scale = headroom / 32767`; headroom = the track's `max(1, peak)` when the renderer knows it, else `max(1, chunk peak)`) or **float32** for hi-res sources; any sample rate (the decode rate) |
| Internal processing | float32 planar stereo blocks of at most 2048 frames; filters and smoothers keep double state; biquad outputs rounded to float like Chromium |
| Device | float32 interleaved from the core; the WASAPI backend converts to the endpoint format (shared mode: float32; exclusive: negotiated 32f / 32i / 24-in-32 / 16i, TPDF dither for integer formats) |
| Recording | WAV PCM 24-bit by default (16-bit and float32 optional), RF64 beyond 4 GiB |

The engine runs at the device rate (the shared-mode mix format rate, or the
negotiated exclusive rate). Decks read any TrackBuffer rate with the ratio
`tempo × fileRate / deviceRate` and linear interpolation — exactly what
AudioBufferSourceNode does when a buffer's rate differs from the context's.
The proxy decodes new tracks at the current device rate, so the ratio is
normally 1.

Channel layouts are folded to stereo **by the engine** when a chunk arrives
(`downmixToStereo`, pcm.h), with the Web Audio "speakers" rules that
Chromium's destination applies: mono duplicated (L = R); quad ½·(L + SL),
½·(R + SR); 5.1 L + √½·(C + SL), R + √½·(C + SR) (LFE dropped); other
layouts: the first two channels. (Every node of the Web engine's chain is
linear and identical per channel up to the 2-channel limiter, so folding
first is equivalent.)

---

## 6. Flat C API, Node-API binding, engine host, main and preload wiring

### 6.1 `include/om/om_engine.h` (owner: host)

| Function | Purpose |
|---|---|
| `om_config_init(cfg)` | defaults: NULL device 48 kHz / 256 frames / 4 channels / 256 latency frames, 60 Hz state, heartbeat 250 ms, stall 500 ms, stalled 2000 ms, loss re-check 2000 ms. `om_config` only grows at its end (`struct_size`): `owner_window` (the main window's HWND for plugin editors, from main only), `stalled_ms`, `loss_retry_ms` were appended |
| `om_version()`, `om_protocol_version()` | `"0.2.0-beta.1"`, 2 |
| `om_engine_create(cfg, err, len)` / `om_engine_destroy(e)` | lifecycle; destroy joins every engine thread |
| `om_engine_start(e, err, len)` / `om_engine_stop(e)` | threads + NULL device (the real device comes with `device.open`) |
| `om_engine_set_event_callback(e, fn, user)` | `fn(user, json, len)`: one JSON event, on any engine thread (control, ops, vst-ops) or inside `om_engine_command` / `om_engine_pump`; serialized by the engine |
| `om_engine_set_policy(e, json, len, err, len)` | **trusted** paths from main (§15.6): VST folders and scanned files. Never reachable from the ctl port |
| `om_engine_command(e, json, len, err, len)` | one command object or a batch array (§15); invalid input rejected as a whole (`OM_ERR_INVALID`), no room for the whole batch → `OM_ERR_FULL` |
| `om_engine_read_state(e, &om_state)` | latest snapshot (C struct, `include/om/om_state.h`) |
| `om_engine_now(e)` | engine clock |
| `om_pcm_begin(e, &om_pcm_desc)` / `om_pcm_write(e, id, offset, frames, channels, planar)` / `om_pcm_end(e, id)` / `om_pcm_abort(e, id)` | PCM handoff data path (§7): float32 planar chunks, converted in the engine |
| `om_engine_pump(e)` / `om_engine_render(e, out, frames)` | manual mode: control work, ops/vst-ops jobs and NULL-device rendering on the caller's thread (deterministic tests) |
| `om_list_output_devices(fn, user)` | WASAPI endpoints as JSON, without an engine |
| `om_vst_scan(pathsJson, len, fn, user)` | VST3 scan, for the scan process only |
| `om_shadow_run(jobJson, len, left, right, frames, fn, user)` | shadow decode + comparison, for the `--shadow` process only (§7.4) |

No C++ exception crosses the boundary. `om_state` is a fixed-layout C struct
filled directly by the modules (`Deck::snapshot(om_deck_state&)`,
`SyncEngine::snapshot(om_sync_state&)`, `Mixer::snapshot(om_mixer_state&)`).

### 6.2 C++ core (`include/om/engine.h`)

`om::Engine` (options: NULL device + its config, manual mode, stateHz,
heartbeat, stall / stalled / loss re-check periods, PCM memory limit, data
dir, owner window) with `start/stop`, `setEventSink`, `setPolicy`,
`command(json) → CommandResult`, `pcmBegin/Write/End/Abort`, `readState`,
`now`, `epoch`, `stats`, `pump`, `render`. The C API is a thin wrapper of it.

**Backend seams** (`EngineOptions::backends`): the device enumeration, the
master output (`AudioDevice`), the process-wide endpoint watcher
(`DeviceWatcher`), the headphones output (`IPhonesOutput` over
`SecondaryOutput`; its pushes are stamped with the sub-block's
`callbackTime`, so the card's fill is measured without render jitter), the recorder (`IRecorder` over `Recorder`) and the VST
host (`IVstHost` over `VstHost`). Empty factories = the real modules
(adapters in `src/core/backends.cpp`); an engine in NULL-device mode never
touches a sound card (no enumeration, `device.open` refused) unless a test
injects fakes. The core tests run the whole device lifecycle, the recorder
and the VST paths on fakes (`tests/core/fakes.h`), so the core is proven
independently of the other modules' progress. Two more test seams, called
on the audio thread and null in production: `snapshotHook` (after a
snapshot is filled) and `applyHook` (every command the dispatcher applies).
`EngineStats` (FX units / chains created, attached, dropped; preparations;
outputs opened; stall restarts; unhandled audio commands; control-thread
iterations and longest gap; blocks; the routing applied by the audio
thread) is for tests and diagnostics.

In manual mode the engine clock is the sample clock (seconds rendered), so
it stays continuous across device switches; `render()` drives the current
NULL device (the stand-in of a lost device keeps its period: render
multiples of it) and returns 0 while another device is the output (a test
drives its fake device itself).

### 6.3 Node-API binding (`src/node/binding.cpp`, owner: host)

```js
const native = require('.../openmix_engine.node');
native.version(); native.protocol();
const engine = native.create({ dataDir, stateHz: 60 }, (jsonText) => { /* event */ });
engine.start();                                   // throws on failure
engine.setPolicy(jsonText)     // -> null | error (engine-host.js only, from main's messages)
engine.command(jsonText)       // -> null | "error message" | "full" (never throws for bad input, never blocks)
engine.pcmBegin({ loadId, kind, format, sourceChannels, sampleRate, frames, headroom, peak }) // -> om_result
engine.pcmWrite(loadId, offsetFrames, frames, channels, float32Planar)   // -> om_result (0 = OK)
engine.pcmEnd(loadId); engine.pcmAbort(loadId); engine.now(); engine.stop(); engine.destroy();
// create() options: nullDevice, manual, nullRealtime, nullSampleRate, nullBlockFrames, nullChannels,
// stateHz, heartbeatMs, stallMs, stalledMs, lossRetryMs, maxPcmBytes, dataDir,
// ownerHwnd (decimal string, number or BigInt: win.getNativeWindowHandle() read as 64 bits)
native.listDevices();          // -> JSON text
native.vstScan(pathsJsonText); // -> JSON text   (scan process only)
native.shadowRun(jobJsonText, float32Left, float32Right)  // -> JSON text (shadow process only)
```

Events reach JS through one thread-safe function. **`state` events are
coalesced**: the binding keeps a single latest-state slot that a new state
overwrites, and schedules at most one JS call for it; other events are
queued in order (bounded at 4096; overflow counted and reported once as
`diag {kind:"events-dropped"}`). Events always reach JS on a later tick of
the event loop (even those produced inside `command()`). NAPI_VERSION 8, C++
exceptions disabled, static CRT. Measured (Release, plain Node): with the
JS thread blocked 700 ms while ~42 states were produced, at most 3 states
arrive in the 30 ms after it (one pending + new ones), heartbeats arrive
queued in order, `destroy()` joins every thread in ~2 ms.

### 6.4 Engine host (`engine-host.js`, repo root, owner: host)

- `process.parentPort` messages from main: `{type:'init', modulePath,
  dataDir, ownerHwnd, policy}` → `require(modulePath)`, `create`,
  `setPolicy(policy)`, `start`, answered `{type:'ready', ok, error?, version,
  protocol}` (main resolves the first `engine-connect` on it, 10 s time-out); `{type:'policy', policy}` (after each VST
  scan) → `setPolicy`; `{type:'connect'}` with `ports: [ctl, pcm]` → wires
  them (`port.start()`), a previous connection is closed;
  `{type:'shutdown'}` → `engine.destroy()`, exit.
- ctl port: each message is a JSON text → `engine.command(text)`; a non-null
  result is answered with `{"ev":"error","error":...,"cmd":<first cmd>,
  "seq":<first seq of the message>, "ids":[ids of the message],
  "batch":bool}`. `"full"`: the proxy resends that batch (matched by `seq`)
  on the next frame, at most 300 times (~5 s of frames), then drops it and
  resolves its requests `{ok:false, error:"full"}` (counted in
  `stats.dropped`); any other error: the message's requests (`ids`) resolve
  at once `{ok:false, error, refused:true}` (a refused `vst.load`,
  `rec.start`, `deck.load` or `pcm.begin` never leaves its caller waiting).
  Engine events (text) are posted to the current ctl port as is (events
  produced while no renderer is connected are dropped and counted in the
  log: the next `hello {reset}` resets anyway).
- pcm port: `{loadId, offset, frames, channels, data: Float32Array}` →
  `engine.pcmWrite`, answered on the pcm port with `{loadId, offset,
  code}`; `{loadId, end: true}` → `engine.pcmEnd` (the engine emits
  `pcm.done` / `pcm.error` on ctl); `{loadId, abort: true}` →
  `engine.pcmAbort`.
- `--scan` mode: reads `{modulePath, paths}` from the first parent message,
  calls `native.vstScan`, posts `{ok, plugins}`, exits.
- `--shadow` mode: reads one job `{modulePath, job, left, right}` from the
  first parent message, calls `native.shadowRun`, posts the report, exits
  (§7.4).
- Logs go to stdout with an `[engine]` prefix (main pipes them like the
  renderer console). An uncaught exception exits with code 1 (→ fallback).

### 6.5 Main and preload wiring (owner: host)

Main and preload are heavily modified on the hardening branch; the engine
touches them as little as possible:

- `main.js`: a 3-line hook, nothing else:
  ```js
  // OpenMix native engine (native/engine/SPEC.md §6.5): all its wiring lives in engine-main.js
  const engineMain = require('./engine-main');
  engineMain.install({ getWindow: () => win, app, ipcMain });
  ```
  (`install` registers its own `will-quit` handler.)
- `engine-main.js` (new): the IPC handlers `engine-info` (`{available,
  reason?, modulePath, running}`), `engine-connect` (main window only:
  forks the host once, waits for its `ready`, then a new pair of
  MessageChannelMain; `{ok, version, protocol}` or `{ok:false, error}`),
  `engine-kill` (kill the utility process and resolve on its `exit`, ≤ 1 s:
  `{ok, code}`), `engine-vst-scan` (files filtered to `.vst3` paths inside
  the VST3 folders, ≤ 2000; the plugins found join the policy's `vstFiles`
  and the new policy is sent to the host), `engine-save-recording` (§14),
  `engine-reveal-file` (recordings folder or a path a save returned),
  `engine-shadow-decode` (§7.4); the utilityProcess lifecycle, the ports,
  `engine-exit`, the policy (§15.6: the standard VST3 folder, the per-user
  `%LOCALAPPDATA%\Programs\Common\VST3`, the folders added in Settings —
  read from `turbo-settings.json` — and `OPENMIX_VST_PATH`), the scan and
  shadow helper processes at below-normal priority
  (`os.setPriority(child.pid, PRIORITY_BELOW_NORMAL)`), the PCM memory
  limit sent in `init` (§17.8), and app quit (`will-quit` held until the
  host exited or 2 s passed, then it is killed). `install()` also takes
  test overrides (`modulePath`, `dataDir`, `hostScript`, `showSaveDialog`,
  `showItemInFolder`, `log`, `idleShutdownMs`, `quitGraceMs`,
  `maxPcmBytes`, `fsOps`); `OPENMIX_ENGINE_MODULE` overrides the module
  path. Never touches ports 8722 / 9333 or the remote server.
- **Quit order in the host** (`Engine::stop()`, reached through
  `engine.destroy()`): the control thread is joined; the queued ops and
  vst-ops jobs are dropped (their requests do not matter at quit); the ops
  thread finishes only the job it is running; **a running recording is
  finalized**; only then is the VST thread joined (a plugin load, editor or
  dialog job can wait for the plugin up to its time-out); then the devices
  stop. A hung plugin can no longer keep a recording from being finalized
  before main's 2 s kill.
- **A host no page uses**: on the main window's `did-start-navigation`
  (main frame, not same-document) and `render-process-gone`, main arms a
  15 s timer; the next `engine-connect` cancels it (a native reload
  reconnects within seconds, as before); when it fires, main shuts the host
  down (`{type:'shutdown'}`, killed after 2 s) without sending
  `engine-exit` to the page, and a later native page forks a new host
  (`engine-connect` first waits for a host still shutting down to free its
  device). Without it a page that went to the Web engine left the host
  holding its device (exclusive mode: the Web engine silent there), its PCM,
  its plugins and a REC writing silence until quit.
- **Awaitable shutdown**: `install()` returns `{shutdown, hostPid, policy}`
  and `engine-main.js` exports `shutdown()` (the installed instance's):
  it aborts a recording copy still running (§14) and shuts the host down
  (finalized recording, then killed after 2 s), resolving when done.
  `will-quit` uses it. **Merge note (hardening branch)**: `app.exit()`
  skips `will-quit`, so the hardening branch's restart paths — `app-restart`
  (main.js ~2532, "restart to apply") and `data-wipe-restart` (~4770) —
  must `await engineMain.shutdown()` before `app.relaunch()` /
  `app.exit(0)` when `engine-native` is merged; otherwise a running native
  recording is cut without being finalized.
- `preload.js`: one additive block appended at the end of the file (a second
  global, so the `api` object of the hardening branch is not touched):
  ```js
  // --- OpenMix native engine (native/engine/SPEC.md §6.5): additive block, keep it last ---
  contextBridge.exposeInMainWorld('omEngine', {
    info: () => ipcRenderer.invoke('engine-info'),
    connect: () => ipcRenderer.invoke('engine-connect'),
    kill: () => ipcRenderer.invoke('engine-kill'),
    onExit: (cb) => ipcRenderer.on('engine-exit', (_e, d) => cb(d)),
    vstScan: (files) => ipcRenderer.invoke('engine-vst-scan', files),
    saveRecording: (path, name) => ipcRenderer.invoke('engine-save-recording', path, name),
    revealFile: (path) => ipcRenderer.invoke('engine-reveal-file', path),
    shadowDecode: (job) => ipcRenderer.invoke('engine-shadow-decode', job),
    memoryInfo: () => process.getProcessMemoryInfo()   // renderer RAM KPI (§17.8)
  });
  ipcRenderer.on('engine-ports', (e) => window.postMessage('openmix-engine-ports', '*', e.ports));
  ```

---
## 7. PCM handoff and the shadow decoder

### 7.1 Why

Every cue and grid in the library is seconds on Chromium's decoder timeline.
Decoding again natively (Media Foundation, FFmpeg...) can move all of them
(LAME encoder delay: up to ~51 ms measured). So the engine plays exactly the
samples Chromium decoded, as the Web engine does today.

### 7.2 Renderer side (owner: jsproxy)

1. **Decode** — unchanged code paths: `library.loadForDeck()` and app.js's
   stem/sampler decoders call `engine.ctx.decodeAudioData(ab)`. In native
   mode `engine.ctx` is the facade's context shim, which decodes with an
   `OfflineAudioContext(2, 1, deviceRate)` — the same Chromium decoder and
   resampler as today's `AudioContext` at the device rate. The resulting
   AudioBuffer feeds the analysis, the peaks and the waveforms exactly as
   today.
2. **Storage format** — `s16` unless the source is known to be hi-res
   (`track.bitsPerSample > 16` when the library knows it) → `f32`. The wire
   format is always float32; the engine converts.
3. **Headroom** — tracks: from the peaks app.js already computed for the
   deck (`computeBandPeaks` stores the exact signed per-slice extremes of
   both channels, waveform.js:49-70): `peak = max over slices of
   max(top[b], −bottom[b])`, `headroom = max(1, peak)` — no extra scan.
   Stems, sampler sounds, sources with more than 2 channels, or no peaks:
   `headroom: 0` = per-chunk headroom, computed by the engine.
4. **Chunks** — `chunkFrames` (65536) frames, planar float32 (§5). For each
   chunk the proxy takes a Float32Array of `channels × chunkFrames` from a
   small pool of reused buffers (2 per stream), fills it with
   `buffer.copyFromChannel(view, c, offset)` per channel (a native memcpy,
   no JavaScript loop) and posts `{loadId, offset, frames, channels, data}`
   on the pcm port **without a transfer list**: the structured clone copies
   the data synchronously (it works whatever Electron's MessagePortMain
   supports — its typings only accept ports in transfer lists), the pool
   buffer is reusable as soon as `postMessage` returns, and no garbage is
   created in the renderer.
5. **Ordering** — `pcm.begin` (ctl) first; chunks are sent only after its
   reply (`ok`). `deck.load` may be sent right after the reply: it attaches
   the still-empty buffer, and the deck's armed start (§9.1) waits for the
   data. A chunk answered `NotFound` (the engine reset its epoch, or the
   stream was aborted) is retried once after 50 ms, then the stream is
   abandoned and reloaded if the deck still needs it.
6. **Chunk order** — first the chunk under the deck's position (0 for a
   fresh load, the restore position after a session restore) **and the
   chunk before it** (the WSOLA prime history), then forward to the end,
   then from 0. The send queue is **reordered at every seek, hot cue, beat
   jump, loop entry, sync jump or play from a new position**: the chunk at
   the target and the one before it go first.
7. **Pacing** — the UI thread spends at most ~2 ms per animation frame on
   the handoff (each chunk costs two memcpys and one structured clone, about
   0.1-0.2 ms: ~10 chunks per frame, a 6-minute track in ~0.5 s).
8. **Flow control** — at most 8 unacknowledged chunks per stream; the host
   acks each chunk on the pcm port with its om_result code.
9. **Sequence** (one track):
   ```
   ctl:  {"cmd":"pcm.begin","id":41,"loadId":17,"kind":"track","format":"s16","sourceChannels":2,
          "sampleRate":48000,"frames":17280000,"headroom":1.12,"peak":1.12}
   ...   {"ev":"reply","id":41,"ok":true}
   ctl:  {"cmd":"deck.load","deck":0,"seq":905,"at":...,"loadId":17,
          "grid":{"bpm":124,"beatOffset":0.012,"beats":[...],"gridShift":0,"barAnchor":0}}
   pcm:  {loadId:17, offset:0, frames:65536, channels:2, data:<Float32Array 131072>}   x N, windowed
   pcm:  {loadId:17, end:true}            -> ctl event {"ev":"pcm.done","loadId":17}
   ```
10. **Cancellation** — loading another track on the same deck aborts the
    previous stream if it is incomplete (`pcm.abort` or `{abort:true}`).
11. **Stems** — when app.js assigns `deck.stems = {vocals, drums, bass,
    other: null}` (decoded, bass+other merged and aligned by app.js), the
    proxy hands off the three buffers (`kind: "stem"`, `headroom: 0`) and
    sends `deck.stems {deck, vocals, drums, bass}`; `loadStems()` then sends
    `deck.stemsOn {on: true}`. RAM: §17.8.
12. **Sampler sounds** — the whole sampler bank is handed off as soon as the
    engine is ready, and each sound again when a pad is assigned: app.js's
    `samplerLoadSlot` calls `engine.preloadSample?.(buffer)` after decoding
    (one-line hook, §17.9); the facade maps AudioBuffer → slot (WeakMap, 32
    slots, least recently used evicted) and sends `sampler.load {slot,
    loadId}`. A play before the handoff completes is armed (§10.8).

### 7.3 Engine side (owner: decoder — `include/om/pcm.h`, `src/decoder/pcm.cpp`)

- `PcmStore::begin(desc)` validates (loadId > 0, 1-8 source channels, 8-384
  kHz, format, headroom 0 or ≥ 1, memory limit) and allocates the
  `TrackBuffer` (`media.h`) without zeroing it.
- `write(loadId, offset, frames, channels, planar)` accepts exactly one
  chunk at a chunk offset, in any order, never twice; it folds the channels
  to stereo (`downmixToStereo`, §5), converts — S16: chunk scale = (given
  headroom, or `max(1, chunk peak)`) / 32767, `quantizeS16` with TPDF dither
  seeded by `ditherSeed(loadId, chunk)` so the result does not depend on the
  arrival order; F32: interleave — into the chunk's storage, then publishes
  it with its scale (release store). Readers check `chunkReady()` (acquire)
  once per chunk they cross and play silence where data has not arrived.
  Samples above a given headroom are clamped and counted (`PcmInfo.clipped`).
- `quantizeS16` (the only implementation; there is no JavaScript twin):
  ```
  x = seed || 0x9E3779B9                           // uint32 xorshift32 state
  rand() { x ^= x << 13; x ^= x >> 17; x ^= x << 5; return x / 4294967296 }
  scale = 32767 / headroom
  for each frame i, for ch of [L, R]:
    d = rand() - rand()                            // TPDF dither, (-1, 1) LSB
    s = floor(v * scale + d + 0.5)
    out[2i + ch] = clamp(s, -32768, 32767)
  ```
  Playback multiplies by the chunk's scale.
- `end()` succeeds when every chunk arrived → `pcm.done`; otherwise
  `pcm.error {error: "incomplete"}`.
- Users: `acquire()` per attachment (deck, stem set, sampler slot);
  `release(tb)` when the audio thread retired it; a stream with no user is
  dropped; streams begun but never attached are collected after 120 s.
- **Memory is freed only by `freePending()` on the control thread**: abort,
  release and garbage collection move dropped buffers to a pending list; the
  host JS thread and the audio thread never free PCM. No method frees while
  holding the store's mutex.
- **Epochs**: streams are keyed by (epoch, loadId). `hello {reset}` starts a
  new epoch: loadIds of the new connection never collide with streams of
  the previous one that are still attached or retiring; old streams that are
  not attached are aborted at once.
- `bytes()` is published as `om_state.pcm_bytes` (the RAM KPI, §17.8).
- Errors map to the C API: `Range` / `Duplicate` → `OM_ERR_RANGE`,
  `Incomplete` / `Aborted` → `OM_ERR_STATE`, `NotFound` →
  `OM_ERR_NOT_FOUND`, `OutOfMemory` → `OM_ERR_NOMEM`, `Invalid` →
  `OM_ERR_INVALID`.

### 7.4 Shadow decoder (owner: decoder — `shadow.h`, `src/decoder/`; process wiring: host)

Media Foundation loads every registered decoder MFT, third-party codec packs
included: a codec crash must never kill the real-time process. So the shadow
decode never runs in the engine host:

1. **Trigger** (renderer, setting `nativeShadow`, default on in the native
   beta): right after decoding a local file for a deck, the proxy cuts the
   **reference window** from the AudioBuffer it already has (Chromium's
   timeline): the middle 30 s (the whole track if shorter), folded to mono
   (L+R)/2 once and sent as both channels (one buffer referenced twice, so
   it is cloned once: ~5.5 MB float32; the comparison is identical because
   `compareWindow` folds to mono anyway), and calls
   `window.omEngine.shadowDecode({path, rate, frames, windowStart, left,
   right})` once the deck's `pcm.done` arrived (no work during the load), in
   its own task after the cut (longest renderer task after `pcm.done`
   6.5-9.6 ms instead of 13-22 ms). At most one pending job; main queues
   them, one at a time.
2. **Main** (`engine-main.js`) validates the path (absolute, regular file
   with an audio extension, not a device or UNC path — the renderer can read
   such files through `read-file` anyway), forks `engine-host.js --shadow`
   as a utilityProcess at below-normal priority, posts the job, and resolves
   with the report (or `{ok:false, error:"crashed"}` when the child dies:
   the proxy then skips that path for the session).
3. **Child** (`native.shadowRun` → `om_shadow_run` → `runShadowJob`):
   `MFStartup` only in this process; a **streaming** decode
   (`openSystemReader`, Media Foundation source reader, float output at the
   file's rate) that counts every frame but keeps only the window ±
   (200 ms + the resampler's filter half-length); the `Resampler`
   (polyphase Kaiser, group-delay compensated) converts **only that span**
   to the reference rate; `compareWindow`: mono (L+R)/2, coarse
   cross-correlation on ×8 decimated signals over ±200 ms, fine search at
   full rate ±16 frames, parabolic interpolation for the sub-sample offset;
   RMS difference = 20·log10(rms(native shifted − reference) /
   rms(reference)) over the window; length difference = (native frames −
   reference frames) / rate. One file per process: the child exits after
   its report.
4. **Report** `{loadId, ok, offsetMs, lengthDiffMs, rmsDiffDb, correlation,
   fileRate, decodeMs, error?}` (offset > 0 = the native audio is later than
   Chromium's). The proxy logs one line per track and keeps running
   statistics (`engine.shadowStats()`: count, within 1 ms, worst offsets per
   extension). Storing per-track offsets in the library cache is the next
   step of the gate.

The comparison pipeline is portable (`om_pcm`) and tested with generated
WAV files through `openWavReader`; only the Media Foundation reader is
Windows code (`om_shadow_mf`, `src/decoder/win/`).

---

## 8. Device layer (owner: device — `device.h`, `recorder.h`, `src/device/`)

### 8.1 Endpoints and names

- `enumerateOutputDevices()` (passive, never opens a stream): WASAPI render
  endpoints (active ones first, in `IMMDeviceEnumerator::EnumAudioEndpoints`
  order — Chromium's order) with id, friendly name (`PKEY_Device_FriendlyName`
  == Chromium's `MediaDeviceInfo.label`), mix-format channels, channel mask
  and rate, default flags per role, device periods and IAudioClient3 shared
  periods.
- Chromium lists two pseudo-devices first: `deviceId` `"default"` (label
  "Default - X") and `"communications"` ("Communications - X"). The proxy
  maps them to `{role: "console"|"communications", followDefault: true}`
  and strips the prefixes; every other id becomes `{name: label, nameIndex}`
  (`nameIndex` = rank among endpoints with the same label in Chromium's
  list, so identical names are not ambiguous). The proxy stores this
  descriptor next to `localStorage.audioOutput` when the user picks a
  device in Settings (labels are known there: Settings asks for the media
  permission), so the startup restore works even when labels are still
  empty.
- `resolveOutputDevice(cfg, list)`: id > exact name (+ nameIndex) >
  case-insensitive name > name prefix > the default endpoint of `cfg.role`.

### 8.2 WASAPI output (`createSystemDevice()` → WASAPI on Windows)

- Event-driven render thread: COM MTA, `AvSetMmThreadCharacteristicsW(L"Pro
  Audio")` + `AvSetMmThreadPriority(AVRT_PRIORITY_HIGH)`, power throttling
  off (§8.8), `flushDenormals()`. Opening, closing and recovery run on the
  ops thread (COM MTA); no WASAPI object is ever created on the host JS
  thread.
- **Modes** (`OutputMode`): `Shared` (engine default period),
  `SharedLowLatency` (IAudioClient3 `InitializeSharedAudioStream`), the
  proxy's default — still shared, other apps keep playing; `Exclusive`
  (opt-in). Automatic fallback Exclusive → SharedLowLatency → Shared,
  reported in `DeviceStatus.fellBack` + `fallbackReason` and in the
  `device.open` reply.
- **Period policy** (shared low-latency): the smallest multiple of the
  fundamental period that is **≥ 5 ms** (e.g. 240 frames at 48 kHz, 256
  when the fundamental is 128), not the absolute minimum: an IAudioClient3
  period lowers the engine period of the whole endpoint, the game's audio
  included, and the minimum is unproven on the FLX6. After repeated glitches
  (≥ 3 in 10 s) the period steps up automatically (next multiple, up to the
  default period), reported by `device {reason:"periodStep"}` and
  `om_device_state.period_steps`; Settings shows the effective period.
  `periodFrames` in `device.open` overrides the policy.
- **Format and channels**: shared mode uses the mix format with its channel
  count **and channel mask** (a 4-channel controller keeps 4 channels, so
  the cue reaches 3/4). Exclusive negotiation: rates (requested, then mix
  rate) × channel layouts (mix-format count + mask first, then
  `PKEY_AudioEngine_DeviceFormat`) × sample formats (f32 → s32 → s24-in-32 →
  s16, TPDF dither for integers).
- **HRESULT handling** (documented sequences): `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED`
  → `GetBufferSize`, recompute the aligned period, release and re-create
  the client, `Initialize` again; `AUDCLNT_E_UNSUPPORTED_FORMAT` → next
  candidate; `AUDCLNT_E_DEVICE_IN_USE` and
  `AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED` → shared (reasons `"in-use"`,
  `"not-allowed"`); `AUDCLNT_E_ENGINE_PERIODICITY_LOCKED` (IAudioClient3) →
  use the locked period (`GetCurrentSharedModeEnginePeriod`) if it is ≥ 5 ms,
  else plain shared; `AUDCLNT_E_DEVICE_INVALIDATED` → loss (§8.4).
- Optional raw stream (`raw: true`): `IAudioClient2::SetClientProperties`
  with `AUDCLNT_STREAMOPTIONS_RAW` when supported (bypasses Windows audio
  enhancements); a later Settings checkbox, off by default.
- The callback asks the core for exactly the frames WASAPI wants (variable
  in shared mode); the core splits them into ≤ 2048-frame sub-blocks.

### 8.3 Timing

`callbackTime` = QPC at the event; `presentTime` from the device clock
mapping (§4.1: `IAudioClock::GetPosition` / filtered frame → QPC, never the
wake-up time). The measured output latency is reported in
`om_state.device.output_latency` and its jitter in `present_jitter_ms`.
Glitches (late events, padding underruns, IAudioClock discontinuities) count
as `xruns`.

### 8.4 Device events, loss and recovery

- `IMMNotificationClient` → `DeviceEventInfo {event, id, state, role}`:
  `Lost` (the open endpoint was removed, disabled or invalidated),
  `DefaultChanged` (per role), `FormatChanged`, `Added` and `StateChanged`
  (an endpoint became `DEVICE_STATE_ACTIVE` again), on the notification
  thread, forwarded to the ops thread.
- **Lost**: the core switches to the NULL device's real-time pacer at the
  same rate (silent; the transport, the sample clock and a running
  recording keep advancing, so nothing jumps), emits `device
  {reason:"lost"}`, and waits. When the **configured** endpoint comes back
  (`Added` / `StateChanged` ACTIVE with the same id, or the same name and
  nameIndex), the ops thread reopens it with the same configuration and
  emits `device {reason:"restored"}`. A USB glitch on the FLX6 therefore
  never moves the master to the laptop speakers.
- `DefaultChanged` reopens only when the configuration follows the default
  (the user chose "Default", §8.1). The engine never moves the master to
  another device by itself.
- A rate change of the reopened device re-prepares the modules (audio
  stopped), and a running recording continues in a new file (§14).

### 8.5 Output routing

Decided by the core from the channel count (engine.js `_wireOutput`):
master → channels 1/2; cue → 3/4 when the device has ≥ 4 channels and no
phones card is set (`cue_routed` = engine.js `phonesOk`); every other
channel silent.

### 8.5b Device lifecycle in the core (owner: host, `src/core/engine.cpp`)

The device module provides the outputs (`AudioDevice`), the enumeration, the
resolution rules and the process-wide `DeviceWatcher`; the core's ops thread
runs the lifecycle on top of them:

- `device.open`: enumerate, resolve (`resolveOutputDevice`: id > exact name +
  nameIndex > case-insensitive name > prefix > the role's default), stop the
  current output first (an exclusive stream needs the endpoint free), open
  and start the new one with the requested mode / period / raw flag. A new
  rate re-prepares every module with no device rendering (decks, mixer, FX
  units, the attached chains, the reverb kernels); chains made for the old
  rate that are still travelling carry a preparation generation and are
  refused by the audio thread, then made again; a running recording
  continues in a new part; the plugins are reconfigured (vst-ops job); the
  headphones card is reopened for the new main rate. On failure the
  previous configuration is reopened (else the NULL device runs) and the
  reply says why. Reply `{ok, status, fallback?: {requested, mode, reason}}`
  and events `device {reason:"opened"}` (+ `"fallback"`).
- Routing (§8.5) is pushed as a `SetRouting` command (in order with every
  other routing change), recomputed on every device or headphones change.
- **Loss**: the output's `Lost` (stream invalidated), or the watcher's
  `StateChanged` (not active) for the open endpoint, or a status that says
  `lost` → the NULL device at the same rate, channels and period (silent; the
  transport, the sample clock and a recording keep going), `device
  {reason:"lost"}`. The endpoint comes back when (a) the endpoint that was
  open (same id) is active again, or (b) an endpoint that was NOT present at
  the loss matches the configuration (exact name + nameIndex, then exact
  name, then case-insensitive name; the role's default only when the
  configuration follows the default) — a twin controller still plugged in
  is never "the device coming back". Checked on the watcher's `Added` /
  `StateChanged` active and every `lossRetryMs` (2 s), then `device
  {reason:"restored"}`.
- `DefaultChanged` (watcher) reopens only a configuration that follows the
  default of that role (`"defaultChanged"`); `FormatChanged` of the open
  endpoint reopens it (`"formatChanged"`); `PeriodStep` (or a status with
  more period steps) → `"periodStep"`; `device.close` → the NULL device at
  the current rate (`"closed"`). Endpoint notifications are taken from the
  watcher only when there is one (the outputs report the same ones).
- Headphones (`device.phones`): shared mode only, resolved like the master;
  `name: null` = no card (the cue goes back to 3/4 of a ≥ 4-channel
  output). Loss / restore as above, events `device {reason, target:"phones"}`.
- `device.status` is answered inline from a status cache the ops thread
  refreshes (never a device call on the host JS thread).
- Contract with the device module: `AudioDevice::stop()` returns only when
  no `render()` call is running and none will start before the next
  `start()`; only one device renders at a time (the core also checks it: a
  callback from a device that is not the current output renders silence and
  touches nothing). The NULL device's real-time pacer is used when the
  device module provides it; otherwise the core paces an offline NULL device
  itself (portable thread + steady clock).

### 8.6 NULL device

Renders into memory with a virtual clock (`presentTime = callbackTime +
latencyFrames / rate`). Offline `pump(blocks, sink)` for deterministic tests
(the C API's manual mode); `realtime = true` paces blocks with a
high-resolution waitable timer: silent soak tests, and the stand-in while a
device is lost.

### 8.7 Headphones on a second card (`SecondaryOutput`)

engine.js `setPhonesDevice`: when a headphone device is chosen, the master
goes out on 1/2 of the main device only and the cue bus is pushed by the
main callback into a lock-free ring; the secondary device's own shared-mode
WASAPI thread pulls it through a resampler whose ratio follows the ring fill
(PI controller, target 2 periods): the two cards' clocks drift and the ring
must never run dry or overflow. A ≥ 4-channel card (DJ controller) gets the
cue on 3/4, a stereo card on 1/2. Same loss / restore rules as §8.4.
`simulateDrift()` exposes the controller for offline tests. The ring, the
PI controller and the resampler are portable; only the stream is Windows
code.

### 8.8 Priority and power throttling

Windows 11 power throttling (EcoQoS) and Chromium's child-process priority
changes can slow the utility process when the window is minimized — a
Phase 2 exit criterion is zero dropouts with the window minimized and a game
running. So: `SetProcessInformation(ProcessPowerThrottling)` with execution
speed throttling disabled for the process; `SetThreadInformation
(ThreadPowerThrottling)` disabled plus MMCSS "Pro Audio" HIGH for the audio,
phones and VST deck worker threads (`promoteAudioThread()`); when MMCSS is
unavailable (the service disabled by a "latency tweak", an unknown task)
the thread gets `THREAD_PRIORITY_TIME_CRITICAL` instead, like Chromium's
audio thread and the VST workers, never normal priority next to a game
(`promoteAudioThread` then returns no handle and says why); the control
thread re-checks the process setting every 10 s and re-applies it
(`om_device_state.throttling_off`). The control thread and the recorder's
writer run above normal (`raiseServiceThreadPriority()`, §3.1). Portable
stand-ins are no-ops.

---

## 9. Deck (owner: deck — `deck.h`, `interpolator.h`, `wsola.h`, `src/deck/`)

Everything engine.js `Deck` does before TRIM. The deck renders its pre-TRIM
stereo signal; the mixer does the channel strip. The JS proxy mirrors the
deck's UI-facing state (§17) but the engine is the truth for time.

### 9.1 State and engine.js rules kept

- `resetForLoad()` = engine.js `loadTrack()`: stop, position 0, cue 0,
  tempo 1, loop off, `_loopBeats` null, roll off, stems dropped and off, key
  0, ended cleared; **keylock kept**; sync resets are done by
  `SyncEngine::onTrackLoaded` (SYNC itself stays on).
- `play()`: no-op without a track or when playing; at ≥ duration − 10 ms it
  restarts at 0; clears `endedAt`. **Armed start**: a play from stop begins
  at the first block where the chunk under the play position (and the next
  one when the block crosses into it) is ready and, when the deck is routed
  through WSOLA, the prime history (§9.4) is ready too. Meanwhile `playing`
  is already true (engine.js semantics), `armed` = 1, `rate` = 0, and the
  segment's `anchor_t` is the real start. The wait is capped at 250 ms
  (sample clock); then the deck plays anyway (missing chunks = silence) and
  reports the wait in `start_wait_ms`. Queue auto-play, load-and-play and
  session restore thus never lose their first beats.
- `pause()`: stops the roll (engine.js), keeps the heard position.
- `seek(t)`: clamps to [−3600, duration]; leaving the loop region disables
  the loop and clears `_loopBeats`; while playing the target is advanced by
  (presentTime − at) × tempo (§4.6).
- `setLoop(start, end)`: start ≥ 0, end ≤ duration, ignored when shorter than
  10 ms; `exitLoop()` clears `_loopBeats`.
- Natural end (not looping): the deck stops when the **heard** position
  reaches the duration (after the WSOLA tail and the insert latency), `pos =
  duration`, `ended_count` +1 and `ended_at` = the engine time (engine.js
  `_endedAt`, used by the auto-master "ended" rule on the sample clock and by
  app.js `onEnded` → queue). The latch is sticky: the control thread emits
  `deck.ended` when it sees the count change.
- Pre-roll: negative positions are silence; the sound starts exactly when
  the position crosses 0 at the current tempo (no rescheduling needed).
- PCM chunks not received yet play as silence **only for jumps while
  already playing** (seek, hot cue, loop); the transport keeps moving then,
  and the proxy's send queue (§7.2.6) makes it rare.
- Segments: the deck maintains `seg`, `anchor_t`, `anchor_pos` (§4.4).

### 9.2 Read pointer and interpolation

A double-precision read position in source frames advanced by `tempo ×
fileRate / deviceRate` per output frame. Default interpolation = Chromium's
AudioBufferSourceNode: integer position and rate 1 → exact copy; otherwise
`s[i] + frac × (s[i+1] − s[i])` with Chromium's edge handling at the buffer
end and at loop boundaries (proved against golden renders of
AudioBufferSourceNode at rates ≠ 1 and with loops, §18.4). Loops wrap the
read position at `loopEnd` to `loopStart` sample-exactly (Chromium: subtract
the loop length). Samples are read through the chunk's scale (s16) or as is
(f32). Hermite / sinc are later A/B options (`deck.interp`, dev only).

### 9.3 Tempo

`setTempo(r)` clamps to [0.5, 1.6]; takes effect at the next block (the
mapping to heard positions stays exact). The core calls
`SyncEngine::onTempoCommand(d)` after a UI tempo command (engine.js
`_onTempo` → `_followMaster`). Under keylock the WSOLA ratio follows the
tempo (below).

### 9.4 Keylock and key (WSOLA)

- Routing rule (engine.js `_applyPitch`): the sound goes through the
  transposer while `keylock || keyShift != 0` (stable decision, not a ratio
  threshold). Ratio = clamp(2^(key/12) × (keylock ? 1/tempo : 1), 0.5, 1.8),
  smoothed like `setTargetAtTime(ratio, now, 0.02)` evaluated once per
  128-frame quantum (k-rate parameter).
- **Quantum phase**: the ratio may change only on the deck's own 128-frame
  grid, independent of device block sizes (441, 480, variable shared-mode
  counts) and of the core's sub-block splits. The deck splits its rendering
  at its quantum edges and carries the remainder over to the next call, so
  grains are generated with exactly the ratios the worklet would use: bit
  parity holds in production, not only in tests.
- `Wsola::process` is the line-by-line port of pitch-worklet.js, fed in
  **lockstep** (n input frames → n output frames, n ≤ the rest of the
  current quantum): output frame G corresponds to input frame G − 2647. The
  input stream is the varispeed read of the track (or stems + roll mix), so
  the WSOLA read pointer runs 2647 input frames ahead of what is heard —
  exactly engine.js's read-ahead (`procLat`), now bookkept per frame.
- **Priming** (why PLAY and hot cues are instant): on play, seek, hot cue,
  loop jump and route change, the deck gives `Wsola::prime()` the input
  frames around the new read position (straight from the track buffer). The
  prime computes only what the first output needs: the grain at G0 − HS
  placed without search, then the grain at G0 with one search (≈ 2 grains,
  ~0.1 ms); the following grains come from `process()` as usual. Cost
  target, tested: 4 simultaneous primes < 25 % of a 128-frame period.
- Jumps while playing crossfade 5 ms between the old and the new output (two
  WSOLA instances per deck, A/B, allocated in `prepare()`); entering or
  leaving the transposer crossfades 6 ms between the direct and the
  transposed outputs, both aligned (engine.js `_switchRoute` without its
  30 ms lead).
- `transportSettled()` is false while a crossfade, a prime transient or an
  armed wait runs (the sync calibration does not measure then).
- Optional, behind a dev A/B switch (`deck.keylockRatio {mode:"input"}`),
  off by default for parity: the worklet applies the current 1/tempo to
  grains whose input was produced ~2647 frames earlier at the old tempo
  (a ~55 ms pitch blip at each tempo or servo step, inherited from the Web
  engine); in `input` mode the deck feeds each grain the ratio of the tempo
  that produced the input it reads (the deck keeps that tempo history).

### 9.5 Scratch (`deck.scratch`)

engine.js `scrubStart / scrubMove / scrubEnd`, but continuous: `Move` gives
a target position at UI time `at` (the app already smooths MIDI jogs at
60 Hz). The deck follows the target path with a critically damped follower
(time constant ≈ one UI frame, tuned with David on the FLX6), reading the
track at the resulting **signed** speed with linear interpolation: moving the
platter back plays real reverse audio; holding it still is silence; speed is
clamped to ±8×. Scratch bypasses the transposer (engine.js `scrubIn` →
TRIM). app.js always pauses before `scrubStart`; a scratch started on a
playing deck pauses it first. `End` stops the scratch voice (2 ms fade);
app.js then seeks and resumes. Each Move is due at its `at` + the largest
command lead (presentTime − `at`) of the gesture (re-anchored when a lead
is more than 30 ms off), so block and IPC delays do not shake the platter
speed; the target is extrapolated with the Move velocity for two UI
intervals (a dropped UI frame is bridged), then held.

### 9.6 V.BRAKE / BACKSPIN (`deck.spin`)

engine.js `spinSound(kind)`: v0 = backspin ? 7 : max(0.2, tempo), decel =
backspin ? 4.5 : 1.6, duration = v0 / decel, speed = AudioBufferSourceNode
playbackRate (k-rate: one value per 128-frame quantum from the spin start)
ramping linearly to 0.001, on engine.js's slice of the track (from
floor(a × sr), reversed from floor(a × sr) + n − 1 for the backspin, n =
max(sr >> 4, floor((b − a) × sr))); null-tested against
`goldens/source/spin_*` (≤ −133 dBFS); gain 1 until duration − 40 ms then a
linear fade to 0 at duration; `none` = engine.js `stopSpinSound` (20 ms
fade from the current gain). Played through the scratch voice (bypasses the
transposer). The transport is not moved (app.js shows the virtual position
and resumes it).

### 9.7 ROLL (`deck.roll`, `deck.rollMix`, `deck.rollStop`, driven by sync)

engine.js `startRoll(beats, mix)`: only when playing with a grid; slice
start = the last multiple of `beats` on the grid (dynamic grid: beat index
floor((f − anchor)/beats + 1e-6) × beats + anchor; fixed grid: offset +
k × period × beats), end = start + beats; clamped to [0, duration],
refused under 10 ms; same slice again = only the mix changes. A second read
pointer loops the slice at the deck tempo, starting where the main pointer
is (wrapped into the slice); the main pointer keeps running silently (CDJ
slip). Gains: main × (1 − mix), roll × mix, each with `setTargetAtTime`
tau 4 ms (engine.js `_rampGain`); `stopRoll` ramps back. The mix happens
before the transposer input.

### 9.8 Stems

`attachStems(set)` makes stems ready (vocals, drums, bass = bass+other,
other = null); `setStemsOn(true)` (engine.js `loadStems`) switches the read
source from the track to the sum of the stems with per-stem gains reset to
1, at the same position (5 ms crossfade); `setStemGain(stem, g, tau)` =
`stemGains[stem].gain.setTargetAtTime(g, now, tau)`. One read pointer and one
transposer for all stems (they are aligned to the track by app.js).

### 9.9 Insert latency

`setInsertLatency(frames)` (the VST plugin latency of this deck, at most
`kMaxInsertLatencySec` = 1 s; `prepare()` sizes the position history and the
read-ahead for it) adds to the read-ahead: the deck reads that much further
ahead so that what comes out of the plugin is on the grid;
`procLatencySec()` = WSOLA lockstep (2647 / rate when routed) + insert
latency, published as `proc_latency`. `positionAt(E)` gives the track
position heard at any engine time of the current block, which the core uses
for the plugin transport (§13.3).

### 9.10 Click-free edges (intentional, §20)

Pause, stop and end: 2 ms fade-out. Seeks, hot cues and loop-region jumps
while playing: 5 ms crossfade. engine.js stopped sources abruptly and left a
30 ms gap after every jump.

---
## 10. Mixer (owner: mixer — `mixer.h`, `limiter.h`, `meter.h`, `sampler.h`, `src/mixer/`)

### 10.1 Channel strip (per deck, engine.js `Deck` nodes)

```
deck render (pre-TRIM) -> TRIM 4^v (tau 10 ms)
  -> EQ low  lowshelf 200 Hz   gain(v) dB   (tau 10 ms on the gain)
  -> EQ mid  peaking 1 kHz Q 0.9 gain(v) dB
  -> EQ high highshelf 8 kHz   gain(v) dB          gain(v) = v >= 0 ? 6v : 40v  (v in -1..1)
  -> FILTER  |v| < 0.04: peaking 1 kHz 0 dB (transparent); v > 0: highpass 20*400^v Hz Q 0.9 (dB);
             v < 0: lowpass 20000*(80/20000)^-v Hz Q 0.9 (dB)          (set instantly, no ramp)
  -> [VST insert of the deck]                     (IInsert::begin / end, §10.6)
  -> post ----> cue send (PFL on/off, tau 10 ms) ----> cue bus
          ----> meter (peak / RMS window)
          ----> color send (tau 10 ms) ----> Color FX bus
  -> fader volume^2 (tau 10 ms)  <- + noise (Color "noise": white noise x amt^2 x 0.4, tau 10 ms)
  -> xf gain (crossfader "mix" curve of the deck's side, tau 10 ms)
          ----> FX sends to panel units u (tau 15 ms, see 10.3) and to the pad unit
  -> dryOut (FX dry cut, tau 20 ms) -> masterGain
```

Biquads use `dsp::webAudioBiquad` + `dsp::StereoBiquad` (Chromium
coefficients, per-sample coefficients while the EQ smoothers move). Defaults:
volume 0.85, trim 0, EQ 0, filter 0, PFL off, sides A, B, A, B.

### 10.2 Color FX knob (engine.js `setDeckColor`)

- Color disabled: filter neutral, color send 0, noise 0.
- type `filter`: the FILTER biquad follows the knob; sends 0.
- type `noise`: filter neutral, noise gain amt² × 0.4.
- other types: filter neutral, color send = |v| (the Color FX bus, §11.4,
  returns through colorWet 0.85 → fxReturn).
- `setColorType` / `setColorEnabled` re-apply every deck's knob.

### 10.3 FX units, sends, returns and dry cut

- **FX seam**: the mixer does not own the FX units. It holds
  `IFxProcessor*` (panel units 0-3, pad units 0-3, master unit) and one
  `IColorProcessor*`, attached by the core (`attachFx`, `attachColor`; the
  previous pointer is returned). The mixer keeps every unit's parameters
  (type, enabled, level, beats) in its own mirror — `fx.set` /
  `fx.pad` / `ensureMasterFx` update the mirror and forward to the attached
  unit — so a unit attached later gets its parameters at once and
  `fxRackView()` never depends on a unit's memory being there. Until a unit
  is attached its output is silence (at most a block or two, §11.5). The
  mixer tests use fake processors (passthrough, impulse, recorder) to prove
  the topology without real FX.
- **Assignment** (engine.js `fxAssign`, read live by engine.js every frame
  for the dry cut, `fxRefDeck` and ROLL): `fx.assign {assign}` sets the
  **live** matrix (the facade compares app.js's array with its last sent
  copy every frame and sends it when it changed: app.js mutates it in place
  and also reassigns it whole); the mixer's dry cut and `fxRackView().assign`
  (sync: fxRefDeck, ROLL) use the live matrix.
- **Sends** (engine.js `updateFxSends`): `fx.sends` latches, at that moment,
  send(d → u) = unit u enabled AND live-assigned to d; each send ramps (tau
  15 ms) to its latched value. Enabling a unit later does not open its sends
  by itself (as in engine.js, where app.js always calls updateFxSends after
  toggling). `fx.sends {assign}` (assign given) sets the live matrix first.
- Pad unit of deck d (`fx.pad` = engine.js `setPadFx`): on = setType,
  setBeatsMult, setLevel, setEnabled(true), pad send → 1 (tau 10 ms); off =
  pad send → 0 (tau 20 ms), setEnabled(false).
- Returns: panel units' wet, pad units' wet and colorWet (0.85 × Color FX
  bus) go into **fxReturn** (gain = master volume, tau 10 ms) → post bus;
  the master FX takes masterGain's output and its wet goes straight into
  the post bus.
- Dry cut per deck, every block: cut = max over the panel units processing
  this deck (enabled and live-assigned) of `fxDryCut(type) × min(1,
  wetGain)` (the SMOOTHED wet gain); dry = 1 − cut, then min with
  `_padDryHold` while the pad unit is enabled; the dryOut target changes
  only when it moves by more than 0.01 (tau 20 ms).
- Master dry compensation: dryComp = 1 − fxDryCut(masterType) ×
  masterWet (0.45 when no master unit), 0.01 hysteresis, tau 50 ms.
- Frozen sends: a send whose destination engine.js does not pull is frozen
  like Chromium's unprocessed nodes: the Color sends while the Color type
  has no bus (filter, noise), the FX sends of a disabled unit, the pad send
  of a disabled pad unit; they resume from their frozen value (a re-enabled
  unit gets its latched send back at once; an AudioParam event that fell due
  while frozen starts at the first processed frame, value unchanged,
  `src/mixer/aparam.h`). The cue sends are not frozen (the mixer does not
  know whether a phones card pulls the cue bus).

### 10.4 Master bus

```
sum of decks' dryOut -> masterGain (master volume, default 0.9, tau 10 ms) -> dryComp -> post bus
fxReturn (gain = master volume) ---------------------------------------------> post bus
master FX wet ------------------------------------------------------------------> post bus
sampler voices (gain 1) ---------------------------------------------------------> post bus
post bus -> master FILTER (same mapping as the deck filter) -> [master meter] -> limiter -> out 1/2, recorder
cue bus (sum of PFL sends, no volume, no limiter) -> out 3/4 or the phones card
```

### 10.5 Crossfader

engine.js `applyCrossfader` "mix" curve: gA = x ≤ 0.5 ? 1 : (1 − x) × 2,
gB = x ≥ 0.5 ? 1 : x × 2; each deck uses its side's gain (tau 10 ms).
`mixView()` gives the sync engine the knob values (volume, eq.low) and the
target side gains (engine.js `_pickBassDeck` reads those values, not the
smoothed audio).

### 10.6 Insert point (two phases)

Per (sub-)block the mixer runs every strip up to its FILTER, calls
`IInsert::begin(d, l, r, n)` for every deck (the VST host hands the block to
that deck's worker and returns at once; false = no active plugin), processes
the decks without an active insert and renders the sampler while the plugins
run, then calls `IInsert::end(d, l, r, n)` for each deck with an insert (it
writes the plugin output, or the latency-aligned dry when the plugin missed
the deadline, §13.2) and finishes those strips. The order of summation into
the buses does not change the result beyond float rounding.

### 10.7 Limiter

Port of Chromium's DynamicsCompressorKernel (BSD-3) with threshold −3 dB,
knee 0, ratio 12, attack 2 ms, release 150 ms: 6 ms uniform pre-delay
(look-ahead, reported as master chain latency), static knee curve with k
solved for the 1/ratio slope, automatic makeup gain pow(1 / Saturate(1, k),
0.6) (≈ +1.65 dB here), 32-frame division processing, adaptive release
(release zones 0.09 / 0.16 / 0.42 / 0.98 fitted by a 4th-order polynomial),
saturation release 2.5 ms, detector average and metering as in Chromium.
`gainReductionDb()` is published. Proven against golden renders of the
DynamicsCompressorNode (§18.4), not only against a port from memory.

### 10.8 Meters

Peak and RMS over a hold window ≥ 1 / stateHz (slots of 128 frames):
deck meters on `post` (post-insert, pre-fader: engine.js `meterPeak`), master
meter after the master filter before the limiter (engine.js `masterPeak`),
cue meter on the cue bus. No peak between two state events is missed. The
**peak is the one of the "speakers" mono fold 0.5 × (L + R)**, like
Chromium's AnalyserNode: engine.js's analysers have no ChannelSplitter in
front, so the RealtimeAnalyser down-mixes stereo to mono before
`getFloatTimeDomainData` (mono content reads its level, one-sided content
−6 dB, anti-phase content 0); the cue meter (native only, `cuePeak`) uses
the same rule. The RMS stays per channel (the UI does not read it).

### 10.9 Sampler

Slots (32) hold handed-off sounds; voices (16) play a slot from its start at
rate fileRate / deviceRate (linear interpolation), gain as given (app.js uses
1), into the post bus; `stop(voice)` = AudioBufferSourceNode.stop() (2 ms
fade). The `voice` of `sampler.play` / `sampler.stop` is **a unique id per
started source** chosen by the proxy (0, 1, 2... up to 2^31 − 2, never
recycled in a session), not a 0..15 index: app.js keeps each pad's last
source and stops it on the next hit of that pad even long after it ended,
so a recycled id would cut another pad's sound. The engine compares ids for
equality only (a reused id ends its previous voice) and still mixes at most
16 voices; retrigger = app.js stops the previous source then starts a new voice;
all voices busy → the oldest is stolen (5 ms fade). A `sampler.play` on a
slot whose first chunk has not arrived (or with no sound yet) is **armed**:
the voice starts at the first block where the chunk is ready, at most 250 ms
(sample clock) later; after that the trigger is dropped and counted
(`om_mixer_state.sampler_dropped`).

---

## 11. FX (owner: fx — `fx.h`, `color_fx.h`, `convolver.h`, `src/fx/`)

### 11.1 FxUnit (engine.js `FxUnit`)

One effect at a time. Defaults: type `echo`, disabled, level 0, beats 0.5.
`FxUnit` implements `IFxProcessor` (common.h).
- `level` (0..1): wet gain target = level (tau 20 ms); inside the effect:
  feedbacks `fbFor(base) = min(0.97, base × (0.55 + 0.45 × level))` (tau
  50 ms), filter sweep depth 650 × (0.35 + 0.65 × level) (tau 50 ms), flanger
  feedback 0.15 + 0.5 × level (tau 50 ms).
- Beat time: t = clamp(beatDur × beatsMult, 0.02, 3.9) s; a new beat
  duration is applied only when it differs by more than 0.05 % (engine.js
  `setBeatDur`); delay times then glide with tau 80 ms — in Chromium a
  stereo DelayNode computes that automation once per channel kernel, so it
  runs twice as fast (effective tau 40 ms) with the right channel 128
  recursion steps ahead; the native lines reproduce it
  (`fx::Param::atKernel`; a mono Web Audio source would glide at the
  nominal speed, the native engine is always stereo); LFO rates with tau
  50 ms (trans) or 100 ms (flanger, phaser, pan, filter). Chains built later
  start at the current time (no slide).
- The core's per-block beat clock reaches **enabled units only**
  (`Mixer::setFxBeatClock`), like app.js's frame loop, which calls
  `setBeatDur()` on enabled panel, pad and master units only: a disabled
  unit keeps the beat duration it had when it was switched off, and when it
  is enabled again its delay lines glide (tau 80 ms, 40 ms effective in
  stereo) from that stale value to the current beat — the first repeats
  slide in pitch, as with the Web engine. The glide starts on the block the
  unit is enabled (engine.js: at the next animation frame, ≤ 16 ms later).
  `FxUnit::setBeatClock` itself stays engine.js `setBeatDur`, which works
  on a disabled unit (the FX goldens drive it that way).
- Modulation period in beats (`modPeriodBeats`): trans m, flanger 8m, phaser
  4m, pan and filter 2m. The LFO phase is locked to the unit's beat clock
  (beat position from the reference deck's heard position): the modulation
  restarts on the grid like engine.js `alignTo` + `fxTick`, continuously.
  Law (fx): while the clock is valid and playing, phase = frac(beatPos /
  P), P = modPeriodBeats (or 1 / (rate × beatDur) when the engine.js rate
  clamp applies); the lock starts at the next engine.js boundary (a multiple
  of P beats below 1 beat, else of min(P, 4)) and then follows every jump of
  the reference deck; without a playing clock the oscillator runs free like
  the Web engine's (rate glides, phase frozen while not routed).
- `setEnabled(false)`: no output at all; the internal state of the chains is
  frozen (a disconnected Web Audio cycle is not processed).
- `setType`: the old chain's output is cut immediately; lazily built chains
  keep their (frozen) state. A lazy chain is born (delay `_timeNow()`,
  feedback `_fbFor()`) at the `setType` / `setEnabled` that routes it, like
  engine.js `_route()`, or when its memory is attached if it is routed then.
- Echo timing (deliberate difference, §20): Chromium processes a feedback
  cycle through a DelayNode one render quantum late, so each repeat of the
  Web engine's echoes lands 128 frames after the previous one. The native
  delay family (echo, delay, pingpong, lowcut, spiral, upecho, downecho,
  helix) and the Color echoes are drift-free: repeat k lands k × delay after
  the input, within a sample. The flanger keeps the quantum in its feedback
  path (y one quantum ago), where it shapes the comb.
- Web Audio details reproduced, all measured against Chromium itself
  (golden renders and probes of `tests/fx/goldens/make_fx_goldens.js`):
  DelayNode linear interpolation at a SINGLE-precision read position
  (writeIndex + (bufferLength − delay × rate) in float; buffer length 128 +
  ceil(maxDelay × rate), write index from the node's creation) on every
  path; AudioParam `setTargetAtTime` computed per 128-frame quantum in float
  with Chromium's 4-step unrolled recursion, converged (target output) when
  within exp(−10) of the target (relative) or 10 time constants after the
  event started, an event first computed late (node not processed) starting
  there; nodes that are not pulled are not processed (their state and their
  automations stand still); OscillatorNode phase (double index, float
  increment) with Chromium's linear / 3-point / 5-point interpolation, its
  band-limited square normalized to the Gibbs peak (open gate ≈ 0.92) and
  Chromium's own sine tables at 2048 / 4096 / 16384 points (22.05 kHz,
  44.1 / 48 kHz, 96 kHz: `src/fx/chromium_sine4096.inc`,
  `src/fx/chromium_sine_tables.inc`; single-precision FFT values, which
  matter where an LFO feeds a float delay position: the flanger); WaveShaper
  curve lookup in float like Chromium's vectorized kernel (virtual index
  (x + 1) × 1023.5, truncation, v1 + f × (v2 − v1): `fx::shape`, and
  `dsp::crushShape` for the tests); StereoPanner law for stereo input
  (double gains).

### 11.2 The 18 types (17 DSP effects + ROLL)

| Type | Graph (engine.js) | Constants | Memory |
|---|---|---|---|
| `echo` (default) | in → delay(t) → out; delay → HPF 120 Hz (Q 1 dB) → fb → delay | fb base 0.45; output = the delay | with the unit |
| `delay` | in → delay(t) → out; delay → fb → delay | fb base 0.22 | lazy, 1 line |
| `pingpong` | in → L(t) → pan −0.85 → out; L → R(t) → pan +0.85 → out; R → fb → L | fb base 0.42 | lazy, 2 lines |
| `lowcut` | echo loop with HPF 700 Hz in the loop; output = the delay | fb base 0.5 | lazy, 1 line |
| `spiral` | echo loop, BPF 900 Hz Q 0.9 in the loop; output = the filter | fb base 0.72 | lazy, 1 line |
| `upecho` | echo loop, HPF 500 Hz; output = the filter | fb base 0.5 | lazy, 1 line |
| `downecho` | echo loop, LPF 1200 Hz; output = the filter | fb base 0.5 | lazy, 1 line |
| `helix` | echo loop without filter; output = the delay | fb base 0.97 | lazy, 1 line |
| `mtdelay` | d1(t) → 0.8; d1 → d2(t) → 0.55; d2 → d3(t) → 0.35; no feedback | taps 0.8 / 0.55 / 0.35 | lazy, 3 lines |
| `reverb` | convolver, impulse 2.2 s decay 2.5 (normalized) | | lazy, convolver state |
| `flanger` | delay 4 ms ± 2.2 ms (sine LFO), feedback | LFO clamp(0.125/t, 0.05, 4) Hz; fb 0.15 + 0.5 × level | with the unit (50 ms) |
| `phaser` | 4 allpass 350 / 700 / 1100 / 1600 Hz Q 0.6, ± 280 Hz | LFO clamp(0.25/t, 0.05, 6) Hz | with the unit |
| `trans` | gain = 0.5 + 0.5 × square | square clamp(1/t, 0.25, 24) Hz | with the unit |
| `pan` | StereoPanner(pan = 0.9 × sine) | LFO clamp(0.5/t, 0.05, 8) Hz | with the unit |
| `filter` | BPF 800 Hz Q 1.4, frequency ± depth × sine | LFO clamp(0.5/t, 0.05, 8) Hz, depth 650 × (0.35 + 0.65 × level) | with the unit |
| `robot` | ring modulation: x × sin(2π·35 t) | | with the unit |
| `crush` | WaveShaper crushCurve(8) | | with the unit |
| `roll` | silence (the deck plays the roll, §9.7) | | — |

A beat-synced line holds 4 s (delay times are clamped to 3.9 s): 1.5 MB at
48 kHz stereo. Dry cut per type: `fxDryCut` in `common.h` (trans/filter/
crush/robot/pan 1, roll 0, flanger/phaser 0.5, reverb 0.3, others 0.45).

### 11.3 Convolver

- `ConvolverKernel` (immutable, shared): the impulse partitioned in the
  frequency domain once; every convolver using the same impulse shares it
  (all FX units' reverbs share one 2.2 s kernel, the Color reverb has its
  own 2.8 s kernel).
- `Convolver` (per instance, lazily allocated with its chain): zero added
  latency for any block of ≤ 2048 frames, **non-uniform partitions**: a
  head partition of the block size (or a short direct-form head) and tail
  partitions of ≥ 2048 frames whose FFT work is spread over several blocks;
  stereo IR applied L→L, R→R like a ConvolverNode fed in stereo. Budget:
  < 1 % of a 256-frame block per instance at 48 kHz.
- Idle tails: when the input has been silent for longer than the impulse
  (the output is then exactly 0) or the remaining tail is below −120 dBFS,
  `process()` outputs zeros without work (below the −80 dBFS null-test
  tolerance).
- Impulses: `makeImpulse(seconds, decay, rate, seed)` = noise × (1 −
  i/len)^decay from a seeded generator, scaled by Chromium's
  `CalculateNormalizationScale` (`convolverNormalizationScale`, implemented
  and tested).

### 11.4 Color FX bus (`ColorFx`, engine.js `_colorDefs`, `cReverb`, `cCrush`)

| Type | Chain | Time | Feedback | Filter / crush | Memory |
|---|---|---|---|---|---|
| `dubecho` | echo loop, output = the filter | 0.35 s | 0.55 | HPF 250 Hz | lazy, 0.5 s line |
| `hpfecho` | echo loop | 0.3 s | 0.5 | HPF 900 Hz | lazy, 0.5 s line |
| `lpfecho` | echo loop | 0.3 s | 0.5 | LPF 650 Hz | lazy, 0.5 s line |
| `bpfecho` | echo loop | 0.3 s | 0.55 | BPF 1000 Hz Q 1 | lazy, 0.5 s line |
| `crushecho` | echo loop, output = the shaper | 0.3 s | 0.5 | crushCurve(6) | lazy, 0.5 s line |
| `reverb` | convolver 2.8 s, decay 2.2 | | | | lazy, convolver state |
| `crush` | WaveShaper crushCurve(5) | | | | with the bus |
| `filter`, `noise` | no bus processing (mixer) | | | | — |

Fixed times and feedbacks (not beat-synced, not level-dependent; the lines
never need more than 0.5 s). The mixer applies colorWet 0.85 and routes it
into fxReturn. `ColorFx` implements `IColorProcessor`.

### 11.5 Memory: everything lazy, allocated off the audio thread

engine.js builds chains on first use (engine.js:1151-1154: "~50 MB of dead
buffer at startup") and creates pad units and the master unit on demand.
Allocating every line of 9 units up front would cost ~200 MB, mostly never
used. The native engine is lazy the same way:

- `FxUnit::prepare()` allocates only what engine.js builds in the FxUnit
  constructor and is cheap or default (echo line, flanger, phaser, trans,
  pan, filter, robot, crush). Lazy chains (table above) are created by
  `FxUnit::makeChain(type)` on the **control thread** (zeroed memory) and
  handed to the unit on the audio thread by `attachChain(type, chain)`
  through an `AttachFxChain` command. The unit owns its chains from then on
  (they live as long as the unit, like engine.js's `_lazy` map) and frees
  them in its destructor on the control thread.
- The four panel units and the Color FX bus are created at engine start.
  Pad units are created on the first `fx.pad` of their deck, the master
  unit on the first `fx.set {unit:"master"}` (engine.js `ensureMasterFx`),
  by the control thread, and attached with `AttachFxUnit`.
- Trigger: when the host JS thread parses `fx.set {type}`, `fx.pad
  {preset.type}` or `color.type {type}` and the unit (or the chain) was never
  requested, it marks it requested and queues its creation to the control
  thread; the audio command itself is pushed at once. Until the memory is
  attached (normally the next block), that unit or chain outputs silence.
- Reverbs share their kernel (§11.3). With this, the startup cost is the
  four panel units' echo lines (4 × 1.5 MB) plus the shared kernels.
- A device rate change re-prepares the units (audio stopped) and re-creates
  the chains that were attached.

### 11.6 Pad FX and master FX

Pad units: one FxUnit per deck, created by the first `fx.pad`, independent of
the panel units (app.js PADFX presets; the pad's dry hold comes with
`deck.padDryHold`). Master FX: one FxUnit on the whole mix, created by the
first `fx.set {unit:"master"}`, following the master deck's beat clock.

### 11.7 Budgets and definition of done

CPU: < 2 % of a 256-frame block per unit at 48 kHz (reverb included,
thanks to §11.3). Every type and every Color type has a null test against
its golden render (§18.4): residual < −80 dBFS for the deterministic types;
for reverbs (random impulses in the Web engine) the golden render uses the
same seeded impulse, handed to the ConvolverNode by the golden script.
The fx suite is generated by `tests/fx/goldens/make_fx_goldens.js` (same
layout as §18.4, `fx/manifest.json` listing the cases; `tools/make-goldens.js`
may absorb it): feedback loops compensated as in §20 with integer delays,
engine.js's own graphs up to their first repeat for fractional delays,
engine.js's FxUnit for every other type, switches / disable included. The
test input stays pulled (an AudioBufferSourceNode that nothing pulls stops
advancing in Chromium). Cases at 44.1 kHz in every family, family `rate96`
(96 kHz: the 16384-point sine table), family `timing` (engine.js's echoes
on one click: measured, not nulled — each Chromium repeat lands 128 frames
after the previous one, the native repeats within 0.2 frame of the beat,
§20); 94 cases in `goldens/fx/` (7 Nov 2026), read by
`tests/fx/test_fx_golden.cpp` and `tests/fx/test_fx_parity.cpp` (which also
nulls the host's `goldens/fxunit` suite).

---

## 12. Sync and auto-master (owner: sync — `sync.h`, `src/sync/`)

`SyncEngine` drives the decks through `IDeckControl` (`deck_control.h`), so it
is developed and tested against fake decks. It runs in `tick()` every block,
before the decks render, on **exact heard positions at the block's
presentTime**, and measures **every duration on the sample clock**
(`BlockClock.sampleTime`, §4.1).

Ported verbatim from engine.js (constants in Appendix A):
- `_updateAutoMaster` + `_pickBassDeck`: first started = master, kept while
  playing; 1.2 s grace on a cut; a natural end (< 2 s ago, compared with
  `IDeckControl::endedAtSample()`) hands over at once; a stopped manual
  master hands over after 1.2 s or at its end; the bass rule score =
  (eq.low > −0.9 ? 10 + (1 + eq.low) : 0) + volume × side gain.
- `getMasterDeck(excl)`: manual master with a BPM, else the auto master if
  playing with a BPM, else a playing non-synced deck with a BPM, else any
  playing deck with a BPM.
- `sync(i)`: ratio from local periods (`_localPeriod`: average over ±8 beats
  of the dynamic grid, 0.15-2 s, else 60/bpm) and the master's base tempo
  (servo correction removed), octave-folded into [0.5, 1.6]; bar alignment
  through grid indexes (dynamic grid) or periods; resets the calibration
  (stage 2 directly when both grids are dynamic).
- `reanchorSync(i)` (magnet 0.03 beat, phase free), `snapToRef(i, maxErr =
  0.06)`, `_followMaster` (scales the followers' bases in the same block as
  the master's tempo change).
- `syncLock`: master never re-aligned (its correction removed); a stopped
  synced deck already takes the master's BPM; repair beyond 6 %;
  follow-master scaling; phase offset adopted beyond 0.08 beat; flash
  calibration (1 s then 8 s windows, +2 s timeout, limits 1 % / 0.1 %, cap
  ±2 % of the target, done below 0.02 % or after 4 passes, 12 tries);
  validity checks (0.05 × tempo); holding servo with dead zone 0.0015 beat,
  limits 0.2 % (gain 0.08) or 1.5 % (gain 1.0) when the deck goes through the
  transposer; `jogHold` suspends the lock; master change = handover without
  jumps (keeps the current speed within 0.4 % of the new target).
- Timing: engine.js mixed `performance.now()` (grace, `_endedAt`) and
  `ctx.currentTime` (calibration, explicitly to avoid mixing clocks); here
  every duration is on the sample clock. The 0.85 / 0.15 error low-pass
  (tuned for 60 calls per second) becomes keep = 0.85^(blockSeconds × 60),
  add = 1 − keep per block; everything else is a duration or a ratio and is
  verbatim.
- `fxTick` ROLL driving: the held pad roll wins, then a panel ROLL unit
  live-assigned to the deck with level > 0.02, then a master FX ROLL; start
  or resize when the beats change, else update the mix; stop otherwise.
- FX beat clocks (moved from app.js's frame loop): `beatOf(deck)` =
  localPeriod / (tempo / (1 + pllCorr)); panel unit u follows
  `fxRefDeck(u)` (first live-assigned playing deck with a BPM, else the
  master), pad units their deck (else the master), the master FX the master;
  0.5 s when nothing plays. `beatPos` gives the LFO phase lock.
- **Deck beat clocks**: `deckBeatClock(d)` (BeatClock with `playing`,
  `beatDur`, `beatPos` at presentTime, `beatsPerSec` and the deck's
  `baseTempo` = tempo / (1 + pllCorr)) for the VST transport (§13.3).
- Snapshot: masterIdx, autoMasterIdx, jogHold, per deck synced, calibrated,
  syncBase, syncRef, pllCorr, beatDur.

Acceptance: a simulated 10-minute synced mix (fake decks with grid noise,
tempo moves, a master handover) keeps the phase error under 1 ms p99 and is
never worse than the JS servo replayed on the same inputs.

Met by the native precision mode (`sync.precision {on}`): 10-minute replay
p99 0.46-0.61 ms over 100 seeds; end to end on rendered click tracks p99
0.14-0.28 ms at 75-174 BPM with ±0.3 ms grids (worst 0.53 ms over 33 seed
runs). The engine.js parity mode reproduces engine.js (replay p99
0.94-1.74 ms; end to end 1.10 ms at 90 BPM, 1.29 ms at 75 BPM). Parity is
the default until David decides (Appendix E).

- **Precision mode** (`sync.precision`, off by default; survives `hello
  {reset}`; refinements 1-7 in `sync.h`, `setNativePrecision`): the holding
  servo is proportional + integral (integral time 30 s, errors above
  0.01 beat not integrated, integral clamped at the servo limit and kept in
  `pllCorr` only, so the base and the BPM shown do not move; restarted from
  0 when the base is re-aimed), calibration certified by a fine pass only,
  coarse corrections under 0.1 % ignored, no follow-master rescaling inside
  a handover, follow-master changes played when a keylock master's change
  is heard, a SYNC deck without a base (the first master) handed over from
  its current speed, and the learned ratio residue (the integral part) kept
  across a handover. Parity mode is the verbatim engine.js servo (0 decision
  mismatches against the real engine.js over 17 500 ticks,
  `tests/sync/test_sync_js_xcheck.cpp`).
- End-to-end proof on the real decks: `tests/core/test_core_sync_e2e.cpp`
  (two click tracks through the C API, 60 s, phase measured on the rendered
  audio: exact grids p99 < 0.05 ms in both modes, realistic grids p99
  < 1.0 ms in parity and < 0.4 ms in precision).

---

## 13. VST3 inline (owner: decoder — `vst_insert.h`, `src/vst/`)

### 13.1 Sources

The port starts from the **hardened** `native/vsthost/src/vsthost.cpp` of
the hardening branch (~880 changed lines: hung-slot detection, time-outs
that wait for plugin dialogs, `CachedModule`, DPI-aware editors, keyboard
forwarding), once it reaches master — coordinate with the security team;
never from the pre-hardening file, which would diverge. Kept: the HostThread
(message-only window + task queue, `OleInitialize`) with its time-outs
(load 60 s, editor 30 s, state 10 s, short 5 s, quiesce 2 s, dialogs up to
600 s), `ComponentHandler` (parameter edits → `ParameterChangeTransfer`,
`kLatencyChanged`), `PlugFrame` and the DPI / keyboard handling of editors,
plugin loading (`VST3::Hosting::Module` → first `kVstAudioEffectClass`
matching the uid → `PlugProvider` → stereo bus arrangements, main buses
active), `CachedModule` (a DLL stays loaded until the app quits), editor
windows owned by the main window, state get/set (32-bit length-framed
component + controller state: the blobs saved by the Web engine's slots
restore unchanged), the SEH `safeProcess` guard. Removed: the
SharedArrayBuffer ring, the 0.5 ms polling thread, the worklet, `vst.js` /
`vst-worker.js` / `vst-worklet.js` in native mode. Windows and SDK code lives
in `src/vst/win/`; the worker handoff, dry lines and status are portable
(`src/vst/`).

### 13.2 Processing: per-deck workers with a deadline

Calling `process()` inside the device callback would let one hung plugin
(infinite loop, a lock shared with its editor thread, a licence check, page
faults on a slow sample disk) freeze the device thread and silence all four
decks with nothing able to preempt it; the SEH guard only catches access
violations. So:

- `VstHost::start()` creates one **worker thread per deck** (MMCSS "Pro
  Audio", power throttling off, FTZ/DAZ), sleeping until handed a block.
- The callback calls `startCallback(periodSeconds)` once (deadline =
  now + `deadline` × period, `deadline` = 0.35 by default, 0.1-0.6 via
  `engine.config {vstDeadline}`), then per deck `IInsert::begin(d, l, r, n)`:
  copies the block into the deck's dry line (always, so the dry is always
  available) and, when the worker is idle and the slot active, into the
  worker's input and releases it (lock-free flag + wake). `end(d, l, r, n)`
  spins until the worker is done or the deadline passes:
  - **on time**: the plugin output (mixed with the latency-aligned dry by
    `mix`); a plugin that keeps up adds no latency;
  - **late**: the latency-aligned dry for this block; the worker finishes in
    the background and its result is discarded; the slot is skipped while
    the worker is still busy; counted (`lateBlocks`, `insert_late`) and
    reported (`vst.late`, at most once per second);
  - **gap**: a block the plugin never got (worker still busy, the host
    thread working on the plugin, a new instance after `kReloadComponent`)
    leaves its next L output frames built from a history with a gap; with
    the latency unchanged they are replaced by the latency-aligned dry
    (re-prime). A latency change moves the deck instead, and a newly loaded
    plugin starts as at load;
  - **hung**: a `process()` call that has not returned after 2 s marks the
    slot hung for the session: dry for ever, `vst.hung` event, never called
    again. A plugin whose every call returns, however late, is only ever
    **late** (its late result is seen by the next `begin()`, then it is
    handed the next block): never hung, never a suspect of the proxy. The
    hardened host's "50 misses in a row = hung" rule is gone (it turned a
    slow plugin into a hung one for the session, and the proxy then
    skipped it at the next start). A crash reported by a block that came
    back late still disables the slot (and the SDK side never calls a
    faulted plugin again).
- The insert state of the snapshot (`insert.state` / `insert.late`, §15.5)
  comes from `VstHost::insertState()`, a const, lock-free accessor the core
  calls on the audio thread every block (it reads only the slot's atomics);
  never `status()` there, which clears `latencyChanged` (it belongs to the
  `vst.status` reply) and asks the backend (editor, busy, dialog).
- A crash (access violation under SEH) disables the slot: `vst.crashed`
  event. Hung and crashed plugins are left loaded (CachedModule). A stack
  overflow caught in `process()` gets its guard page back
  (`_resetstkoflw()`, outside the `__except` block), and at unload the
  worker of a crashed slot is retired (joined, it is idle) like the one of
  a hung slot (detached): a thread that ran faulting plugin code never
  serves the deck's next plugin.
- The host thread's operations (unload, setState, setActive...) wait for the
  deck's worker to be idle (`quiesce` time-out of the hardened host), never
  for the audio thread.

### 13.3 Latency and transport

- The plugin latency L (frames) is sent to the deck (`SetInsertLatency`),
  which reads that much further ahead (§9.9); on `kLatencyChanged` the host
  thread updates it. **Cap: 1 s** (`kMaxInsertLatencySec`); a plugin
  reporting more is refused at load (`code: "latency"`) or, when it changes
  later, bypassed with a `vst.latency {refused:true}` event. The deck's
  position history and the per-deck dry lines are sized for the cap.
- Each block the core passes a `VstTransport` per deck, at the insert
  **input** position: the block the plugin receives is heard L frames later,
  so `projectTimeSamples` = the track position heard at presentTime + L/rate
  (device-rate frames, `Deck::positionAt`), `projectTimeMusic` = the beat
  index there (`sync.deckBeatClock(d)`: beatPos + (L/rate) × beatsPerSec),
  `barPositionMusic` = its bar start (4/4 from the bar anchor), tempo = the
  deck's effective BPM (60 / beatDur), playing.

### 13.4 Floating-point environment and allocations

Plugins may change MXCSR (FTZ/DAZ, rounding): every plugin call (worker and
host thread) runs inside `dsp::FpEnvGuard`, which saves and restores the
control word. Plugin calls run inside `rt::PluginScope`: allocations made
by the engine's own code while it runs for the plugin (SDK parameter
queues, attached processors) are counted separately (`pluginAllocs` in
`vst.status`), never as engine real-time violations; a plugin DLL's own
heap (its static CRT) is not visible (TDR Kotelnikov always shows 0).

### 13.5 Loading, state, editors, suspects

`vst.*` jobs run on the vst-ops thread, which waits on the VST host thread
with the hardened time-outs; a plugin dialog that waits for the user (up to
600 s) never delays device or recording jobs and never stops the `state` /
`hb` events. `vst.load` paths must satisfy the policy (§15.6). Before each
`vst.load` the proxy records `{deck, path}` as a **suspect** in
`localStorage.nativeVstSuspects` and clears it on success; `vst.crashed`,
`vst.hung` and an engine stall/death while a plugin was loading or
processing keep it there: suspects are skipped by the fallback restore and
at the next start (the user can load them again by hand).

**VST3 opt-in** (owner decision 5 of the hardening branch): while Settings >
VST3 is off, main's `vst-info` answers `{available:false,
reason:"disabled"}`; `NativeVstHost.init()` asks it first and then stays
unavailable (error `disabled`): no scan helper, no restore of saved slots
in the engine. Any other reason (e.g. the Web engine's host module not
built, as in this worktree) leaves the native host available. When
`engine-native` is merged, main's `vst-info` keeps the hardening branch's
`disabled` reason; native mode needs neither the window-sandbox switch nor
SharedArrayBuffer (plugins run in the engine host), but the opt-in applies.

Setup order (SDK states): `setComponentHandler`, controller
`setComponentState` from the component state, `canProcessSampleSize` and
`setBusArrangements` [Initialized], `setupProcessing`, `activateBus` [Setup
Done], `setActive(true)`, `setProcessing(true)`, `getLatencySamples`.
`restartComponent`: `kLatencyChanged` / `kIoChanged` deactivate and
reactivate, `kReloadComponent` re-creates the instance with its state,
`kParamTitlesChanged` grows the parameter queues and the edit ring on the
host thread (worker kept out, pending edits kept), other flags acknowledged.
DLL load errors carry the system text in UTF-8 and the error code (193: not
a 64-bit Windows plugin; 126: a library the plugin needs is missing).

### 13.6 Scanning

Scanning loads arbitrary DLLs, so it runs in a separate short-lived process:
the renderer's `NativeVstHost.scan()` → `window.omEngine.vstScan(files)` →
main forks `engine-host.js --scan` → `om_vst_scan` → JSON list; main then
sends the new policy to the engine host. A crashing plugin only kills the
scan process.

### 13.7 Commands

`vst.load {deck, path, uid, state?}` (reply: ok, name, latency, inputs,
outputs, error, code: `timeout` / `hung` / `crashed` / `latency` /
`notAllowed`), `vst.unload`, `vst.editor {deck}` (owner = the main window,
HWND from main), `vst.editorClose`, `vst.getState` (reply: base64 state —
the VstHost API itself takes and returns the base64 text of the vsthost blob,
so the core passes `state` through unchanged; `vst.load {state}` restores it
before the first block, reply `stateRestored`),
`vst.setState {deck, state}`, `vst.status` (inline, non-blocking reply:
loaded, active, bypassed, crashed, hung, editorOpen, latency,
latencyChanged, processed, lateBlocks, maxProcessMs, pluginAllocs, mix),
`vst.mix {deck, mix}` (audio; 0 = bypass with the latency kept, so the sync
never moves).

---

## 14. Recording (owner: device — `recorder.h`)

- `rec.start {name?, format: "wav24"}` (ops thread): the engine creates
  `<dataDir>/recordings/<name>.wav` — `name` sanitized (no path separator,
  ≤ 100 characters; default `OpenMix YYYY-MM-DD HHhMM`), made unique with
  ` (2)`, ` (3)`... The renderer never sends a path. The file is opened with
  `CreateFileW` from the UTF-16 path (profiles with non-ASCII names). Reply
  `{ok, path}`.
- The audio thread pushes the post-limiter master (what engine.js recorded
  through `recDest`) into a lock-free ring (≥ 2 s); the writer converts to
  24-bit PCM with TPDF dither, writes, and patches the RIFF/data sizes every
  second (RF64 + ds64 beyond 4 GiB), so a crash leaves a playable file.
- `rec.stop` (ops thread) drains, finalizes and replies `{ok, path, seconds,
  bytes, dropped}`.
- **Never delete.** app.js's native branch then calls
  `window.omEngine.saveRecording(path, 'OpenMix <stamp>.wav')`: main shows
  the Save dialog; on a destination **on the same drive the file is
  renamed** (instant and atomic: a 2-hour set is ~2 GB); **only across
  drives** (`EXDEV`) it is copied asynchronously (never blocking main) in
  4 MiB chunks into `<dest>.part`, flushed, verified (size, then the first
  and last MiB) and renamed to the destination, and only then is the
  original deleted (reply `moved: "renamed" | "copied"`). On cancel (or any
  error, including a rename refused for another reason than `EXDEV`) the
  file stays in `<dataDir>/recordings` and app.js shows its path with a
  "Show in folder" button (`window.omEngine.revealFile`). A copy still
  running when OpenMix closes (or `engineMain.shutdown()` runs) stops at
  the next chunk and its `.part` file is deleted: never a truncated file
  that looks finished; the original stays and is offered at the next
  native start.
- **Write error** (disk full, removed drive): the writer finalizes the
  header of what was written, stops, and the engine emits `rec.status
  {active:false, error}`; app.js shows it. The audio thread stops pushing at
  once; the inactive state and the error are published together after the
  file is finalized (whoever sees `active` false also sees the error).
- **Device rate change** while recording: the recording stays **one file at
  its original rate**. `Recorder::continueAtRate()` (ops thread, audio
  stopped) lets the writer write what the ring holds, writes the tail of
  the previous resampler if any, and from then on the writer thread (never
  the audio thread) resamples the new device rate to the file's rate with
  the engine's streaming `om::Resampler` (polyphase Kaiser windowed sinc,
  ~99 dB stopband, time-aligned); back at the original rate the audio is
  written as is. The path does not change, `part` stays 1 (the field is
  kept in `rec.status`), `seconds` counts the file's frames at its rate. The
  user never loses part of a set to a second file that only a later start
  would offer.
- **Unsaved recordings**: after connecting, the proxy sends `rec.list` (ops
  thread): reply `{files:[{path, bytes, seconds, repaired}]}` for every WAV
  in `<dataDir>/recordings` (headers of crash-left files are repaired to the
  file length first); app.js offers them (status line with "Show in
  folder").

---
## 15. JSON protocol (owner: host — `protocol.h`, `src/core/protocol.cpp`)

Protocol version **2** (v1 skeleton: int16 wire chunks, no `fx.assign`, no
`applied`/`hb`, `shadow.*` in the engine).

### 15.1 Transport

- ctl port, renderer → engine: one JSON **text** per message: a command
  object or an array of command objects (a batch, applied in order,
  **atomic**: rejected as a whole if any element is invalid or if the queue
  cannot take all of it, §3.3). The proxy batches the commands of one JS
  task into one message.
- ctl port, engine → renderer: one JSON text per event.
- pcm port: structured-clone objects (§7.2), not JSON.
- JSON: RFC 8259 (`om/json.h`), UTF-8, numbers as doubles; NaN/Infinity are
  written as `null` and "null" means engine.js `null`.

### 15.2 Envelope

| Field | Meaning |
|---|---|
| `cmd` | command name (required) |
| `seq` | uint32, monotonic per connection; acknowledged in `state.ack` once applied by the audio thread (`when` commands: `applied` event) |
| `id` | number; when present, commands marked "reply" answer `{"ev":"reply","id","ok",...}` |
| `at` | engine time when the UI issued the command (clock-synced estimate) |
| `when` | engine time at which the command must be heard (sample-exact; default: next block) |
| `deck` | 0..3, required by deck-scoped commands |

Values are validated and clamped like engine.js (out-of-range deck → error;
NaN or a wrong type → error; numbers clamped to engine.js's ranges).

### 15.3 Commands

Route: `inline` = executed at once on the caller's thread, in order with the
audio commands; `ops` / `vst` = queued to the ops / vst-ops thread, answered
by a reply event; `audio` = applied by the audio thread (§3.3).

Control side:

| cmd | Route | Fields | Reply / event |
|---|---|---|---|
| `hello` | inline | `protocol`, `client`, `reset` (bool) | reply: `engine`, `protocol`, `sampleRate`, `channels`, `chunkFrames`, `epoch`. `reset`: an `EngineReset` audio command (every deck unloaded, loop bounds back to 0 / 0, no natural end on record, scheduled `when` commands dropped, samples cleared, mixer / FX / sync back to engine.js defaults, `ack` = 0, new `epoch` in the state), new PCM epoch, unattached streams aborted, plugins unloaded (vst-ops), a running recording finalized (ops thread, `rec.status` event) |
| `engine.config` | inline | `stateHz`?, `vstDeadline`? (0.1-0.6) | reply |
| `clock.ping` | inline | `t0` | event `clock.pong {t0, te}` |
| `device.list` | ops | — | reply: `devices` [{id, name, nameIndex, channels, channelMask, sampleRate, isDefault, isDefaultComms, sharedMinPeriodFrames, sharedFundamentalFrames}] |
| `device.open` | ops | `name`?, `nameIndex`?, `deviceId`?, `role`? (`console`/`communications`), `followDefault`?, `mode` (`shared`/`lowlatency`/`exclusive`), `periodFrames`?, `sampleRate`?, `raw`? | reply: `ok`, `status`, `fallback`? (+ `device` event) |
| `device.phones` | ops | `name`/`nameIndex`/`role` (name null = no phones card) | reply: `ok`, `status` |
| `device.close` | ops | — | reply |
| `device.status` | inline | — | reply: cached `status` |
| `shutdown` | ops | — | event `shutdown` (a running recording finalized with a `rec.status`, plugins unloaded, outputs closed; the threads stay until destroy) |
| `pcm.begin` | inline | `loadId`, `kind` (`track`/`stem`/`sample`), `format` (`s16`/`f32`), `sourceChannels` (1-8), `sampleRate`, `frames`, `headroom` (0 = per chunk, else ≥ 1), `peak` | reply `ok` / error (`invalid`, `exists`, `memory`) |
| `pcm.abort` | inline | `loadId` | — |
| `deck.load` | inline | `deck`, `loadId`, `grid` {`bpm`, `beatOffset`, `beats` (> 2 entries to be used), `gridShift`, `barAnchor`} | reply |
| `deck.unload` | inline | `deck` | — |
| `deck.stems` | inline | `deck`, `vocals`, `drums`, `bass` (loadIds) | reply |
| `deck.grid` | inline | `deck`, `bpm`, `beatOffset`, `gridShift`, `barAnchor`, `beats`? (omitted = unchanged) | — |
| `sampler.load` / `sampler.clear` | inline | `slot` (0..31), `loadId` | reply |
| `rec.start` | ops | `name`? (no path), `format` (`wav24`/`wav16`/`wavf32`) | reply `{ok, path}` |
| `rec.stop` | ops | — | reply `{ok, path, seconds, bytes, dropped}` |
| `rec.status` | inline | — | reply (cached) |
| `rec.list` | ops | — | reply `{files:[{path, bytes, seconds, repaired}]}` |
| `vst.load` / `vst.unload` / `vst.editor` / `vst.editorClose` / `vst.getState` / `vst.setState` | vst | §13.7 | reply |
| `vst.status` | inline | `deck` | reply (non-blocking) |

Audio thread (applied at the next block, or at `when`):

| cmd | Fields | engine.js |
|---|---|---|
| `master.volume` | `v` 0..1 | setMasterVolume |
| `master.filter` | `v` −1..1 | setMasterFilter |
| `xf.set` | `x` 0..1 | setCrossfader |
| `xf.sides` | `sides` ["A","B","A","B"] | xfSides |
| `color.type` | `type` (filter, dubecho, hpfecho, lpfecho, bpfecho, crushecho, reverb, noise, crush) | setColorType |
| `color.enabled` | `on` | setColorEnabled |
| `deck.color` | `deck`, `v` −1..1 | setDeckColor |
| `deck.pfl` | `deck`, `on` | setCuePfl |
| `deck.volume` / `deck.trim` | `deck`, `v` | setVolume / setTrim |
| `deck.eq` | `deck`, `band` (low/mid/high), `v` −1..1 | setEq |
| `deck.padDryHold` | `deck`, `dry` (null) | `_padDryHold` |
| `fx.set` | `unit` (`fx0`..`fx3`, `pad0`..`pad3`, `master`), `type`?, `enabled`?, `level`?, `beats`? (no field = ensure the unit) | FxUnit setters, ensureMasterFx |
| `fx.assign` | `assign` [[bool×4]×4] | the live `fxAssign` matrix |
| `fx.sends` | `assign`? | updateFxSends (latch; with `assign` = fx.assign first) |
| `fx.pad` | `deck`, `preset` {type, beats, level} or null | setPadFx |
| `sampler.play` / `sampler.stop` | `slot`, `voice` (a unique id per started source, §10.9), `gain` / `voice` | sampler shim |
| `vst.mix` | `deck`, `mix` | VstHost.setMix |
| `deck.play` / `deck.pause` | `deck` | play / pause |
| `deck.seek` | `deck`, `t` | seek |
| `deck.cuePoint` | `deck`, `t` | cuePoint = t |
| `deck.tempo` | `deck`, `r` 0.5..1.6 | setTempo (+ followMaster) |
| `deck.key` | `deck`, `semi` (rounded, −7..7) | setKey |
| `deck.keylock` | `deck`, `on` | setKeylock |
| `deck.loop` / `deck.loopExit` | `deck`, `start`, `end` / — | setLoop / exitLoop |
| `deck.loopBeats` | `deck`, `beats` (null) | `_loopBeats` |
| `deck.roll` / `deck.rollMix` / `deck.rollStop` | `deck`, `beats`, `mix` / `mix` / `immediate` | startRoll / setRollMix / stopRoll |
| `deck.padRoll` | `deck`, `beats` (null), `mix` | `_padRoll` |
| `deck.scratch` | `deck`, `phase` (start/move/end), `t` (move) | scrubStart / scrubMove / scrubEnd |
| `deck.spin` | `deck`, `kind` (vbrake/backspin/none) | spinSound / stopSpinSound |
| `deck.stemsOn` | `deck`, `on` | loadStems |
| `deck.stemGain` | `deck`, `stem`, `v`, `tau` (0.01) | stemGains[x].gain.setTargetAtTime |
| `deck.interp` | `deck`, `quality` (linear/hermite/sinc) | (dev A/B) |
| `deck.keylockRatio` | `deck`, `mode` (worklet/input) | (dev A/B, §9.4) |
| `grid.offset` | `sec` | setGlobalGridOffset |
| `sync.master` | `deck` (null = automatic) | masterIdx = x |
| `sync.jogHold` | `on` | jogHold = x |
| `sync.do` / `sync.snap` | `deck` / `deck`, `maxErr` (0.06) | sync(i) / snapToRef(i) → event `sync.result` |
| `sync.reanchor` | `deck` | reanchorSync(i) |
| `sync.arm` | `deck`, `on` | deck.synced = x |
| `sync.base` | `deck`, `base`? (null), `ref`? (null), `pllCorr`? | `_syncBase` / `_syncRef` / `_pllCorr` writes |
| `sync.precision` | `on` | native precision refinements (off = engine.js parity; survives `hello {reset}`) |

### 15.4 Events (engine → renderer)

| ev | Fields |
|---|---|
| `reply` | `id`, `ok`, `error`?, `code`?, command-specific fields |
| `state` | §15.5, at most `stateHz` (60) per second, only when a new snapshot exists |
| `hb` | `t`, `block`, `running` — every 250 ms, whatever the audio does |
| `clock.pong` | `t0`, `te` |
| `applied` | `seq`, `t`, `late` — a `when` command took effect |
| `pcm.done` / `pcm.error` | `loadId`, `error`? |
| `deck.ended` | `deck`, `t` (engine.js onended; derived from the sticky `endedCount`) |
| `sync.result` | `deck`, `op` (sync/snap), `ok`, `seq` |
| `device` | `reason` (opened / closed / lost / restored / defaultChanged / formatChanged / fallback / periodStep / stalled), `target`? (`"phones"` for the headphones card), `status` (the `device.status` object: mode, id, name, sampleRate, channels, channelMask, periodFrames, bufferFrames, periodSteps, latencyMs, jitterMs, format, running, lost, fellBack, fallbackReason?, raw, glitches, cueRouted, phones {set, active, lost, name?}, configured {name, nameIndex, followDefault, role, mode}?) |
| `vst.crashed` / `vst.hung` / `vst.late` / `vst.latency` | `deck`, `latency`?, `refused`?, `count`? (`vst.late` at most once per second and deck, with the number of late blocks since the previous one) |
| `rec.status` | `active`, `path`, `part` (always 1), `seconds`, `bytes`, `dropped`, `error`? (on a write error, after a device rate change — same path, resampled from then on — and when `shutdown` finalizes a recording) |
| `diag` | `kind` (xrun, rt-alloc, rt-free, queue-full, overflow, stall, stall-recovered, events-dropped), details: `what` (events / commands / retired / pending / callback / retiredBacklog), `count`, `ms`, `maxLoad` — overflow counters at most once per second per kind, when they grow (the retired backlog when it becomes non-empty) |
| `error` | `error`, `cmd` (first command of the refused message), `seq` (its first `seq`), `ids`, `batch` (engine-host: a command was rejected; `"full"` = the proxy resends that batch, matched by `seq`, at most 300 times, then resolves its requests `{ok:false, error:"full"}`; any other error resolves the message's requests `{ok:false, error, refused:true}`, §6.4) |
| `shutdown` | — (the engine finished an orderly `shutdown`) |

### 15.5 `state` event (built from `om_state` by `stateJson`)

```json
{"ev":"state","t":123.456789,"ack":905,"epoch":1,"block":44100,
 "decks":[{"loadId":17,"loaded":true,"playing":true,"armed":false,"pos":61.25,"rate":1.02,"tempo":1.02,
           "seg":12,"anchorT":118.003,"anchorPos":55.93,"endedCount":0,"startWaitMs":0,
           "duration":360.0,"ready":1,"looping":false,"loopStart":0,"loopEnd":0,"loopBeats":null,
           "cuePoint":0,"keyShift":0,"keylock":true,"routedW":true,"procLat":0.0551,
           "stemsReady":false,"stemsOn":false,"stemGains":[1,1,1,1],"rolling":false,"rollBeats":0,
           "scratching":false,"spinning":false,"settled":true,"endedAt":null,
           "insert":{"state":0,"late":0},"peak":0.71,"rms":0.22,"dry":1}, ...4],
 "sync":{"masterIdx":null,"autoMasterIdx":0,"jogHold":false,"synced":[false,true,false,false],
         "calibrated":[...],"syncBase":[null,1.02,null,null],"syncRef":[...],"pllCorr":[0,0.0004,0,0],
         "beatDur":[0.4687,0.4687,null,null]},
 "mixer":{"masterPeak":0.83,"masterRms":0.3,"cuePeak":0.1,"gr":-1.2,"dryComp":1,"masterWet":0,
          "fxWet":[0,0,0,0],"padWet":[0,0,0,0],"samplerDropped":0},
 "device":{"mode":3,"rate":48000,"channels":4,"period":480,"latency":0.0213,"jitterMs":0.02,
           "cueRouted":true,"phones":false,"recording":false,"lost":false,"fellBack":false,
           "periodSteps":0,"throttlingOff":true,"load":0.12,"maxLoad":0.31,"xruns":0},
 "health":{"rtAllocs":0,"rtFrees":0,"pluginAllocs":0,"batchesRejected":0,"eventsLost":0,
           "retiredBacklog":0,"retiredLost":0,"pendingFull":0,"stalls":0},
 "pcmBytes":69120000}
```

`pos` is the heard position at `t`; `rate` the nominal heard rate (§4.3);
`seg` / `anchorT` / `anchorPos` the current segment (§4.4); `insert.state`:
0 none, 1 active, 2 bypassed, 3 late, 4 hung, 5 crashed (checked in this
order: none, crashed, hung, bypassed, late, else active; late = the last
block played the latency-aligned dry because the plugin missed the
deadline or was still busy), `insert.late` the blocks that missed the
deadline since the plugin was loaded; both filled every block from
`VstHost::insertState()` (§13.2).

### 15.6 Path policy

The engine host is not sandboxed; the ctl port must not make it open
arbitrary paths:
- `rec.*`: the renderer gives a name only; files live in
  `<dataDir>/recordings` (§14).
- `vst.load {path}`: accepted only when the path (normalized, no `..`, no
  device or UNC prefix, `.vst3`) is in the scanned list or under one of the
  VST3 folders; both come from main (`om_engine_set_policy`, at init and
  after every scan: `{vstRoots: [...], vstFiles: [...]}` — engine-main.js
  reads the folders the same way main.js's `vst-list-files` does). A
  refused path answers `code: "notAllowed"`.
- The shadow decode no longer goes through the engine (§7.4); main
  validates its paths.

---

## 16. engine.js API used by app.js → protocol / state

Every member of `AudioEngine`, `Deck` and `FxUnit` that app.js (and
waveform.js, vst.js, library.js) touches, found by grepping every access
(`engine.*`, `engine.decks[i].*`, and the local names `deck`, `d`, `dk`,
`td`, `m`, `mstr`, `u`, `unit`, `fx`). "Mirror" = a value the facade keeps
and answers synchronously; "snapshot" = the last `state` event (adopted per
§4.5 and §17.3); "extrapolated" = §4.5.

### 16.1 AudioEngine

| engine.js API (app.js use) | Native: command(s) | Native: synchronous answer |
|---|---|---|
| `new AudioEngine()` (app.js:22) | `createAudioEngine()` (native-engine.js) | — |
| `engine.ctx.decodeAudioData(ab)` (app.js stems, sampler; library.js decode) | — | OfflineAudioContext(2, 1, deviceRate).decodeAudioData |
| `engine.ctx.currentTime` (stem gain ramps) | — | `engineNow()` |
| `engine.ctx.createGain()`, `createBufferSource()` (sampler) | sampler shims → `sampler.play {slot, voice, gain}`, `src.stop()` → `sampler.stop {voice}` (sounds already handed off by `preloadSample`) | shim nodes |
| `engine.ctx.setSinkId(id)` + `engine._wireOutput()` (Settings output, startup restore) | pseudo-ids → role; else label + nameIndex (from `enumerateDevices()` or the stored descriptor, §8.1) → `device.open` (await reply); the startup call for the device already opened at connect is answered without a second open | `_wireOutput()` = no-op |
| `engine.ctx.sampleRate` (vst.js) | — | device rate |
| `engine.postBus` (sampler target) | — | shim node |
| `engine.recDest.stream` (MediaRecorder) | native branch of the REC button: `engine.startRecording()` → `rec.start`, `engine.stopRecording()` → `rec.stop` | — |
| `engine.resume()` | none (device always running) | — |
| `engine.decks` | — | 4 stable `NativeDeck` facades |
| `engine.fx` | — | 4 `NativeFxUnit` facades (fx0..fx3) |
| `engine.masterFx`, `engine.ensureMasterFx()` | first call: `fx.set {unit:"master"}` | null until created, then the facade |
| `engine.padFx[i]` | — | null until the first `setPadFx(i, preset)` |
| `engine.setPadFx(i, preset \| null)` | `fx.pad {deck:i, preset}` | pad facade mirrors type/beats/level/enabled |
| `engine.fxAssign[u][d]` (read, mutated in place, reassigned whole) | `fx.assign {assign}` whenever the per-frame comparison sees a change | plain 4×4 JS array owned by the facade |
| `engine.updateFxSends()` | `fx.assign` if changed, then `fx.sends` | — |
| `engine.fxRefDeck(u)` | — | engine.js rule on mirrors |
| `engine.masterIdx` (get; set in session restore) | set: `sync.master {deck}` | mirror; snapshot `sync.masterIdx` (handover) |
| `engine.autoMasterIdx` | — | snapshot `sync.autoMasterIdx` |
| `engine.setMaster(i)` (toggle) | `sync.master {deck: masterIdx === i ? null : i}` | mirror updated at once |
| `engine.getMasterDeck(excl)` | — | engine.js rule on mirrors |
| `engine.sync(i)` → bool | `sync.do {deck}` | engine.js preconditions on mirrors; predicted tempo = `_syncRatio` on mirrors, synced = true, syncBase; `sync.result` reconciles |
| `engine.snapToRef(i, maxErr)` → bool | `sync.snap {deck, maxErr}` | engine.js decision on mirrors |
| `engine.reanchorSync(i)` | `sync.reanchor {deck}` | — |
| `engine.syncLock()` (every frame) | `grid.offset {sec}` when `getGlobalGridOffset()` changed; `fx.assign` when the matrix changed | frame hook: adopts the newest snapshot, flushes batched commands, schedules clock pings and liveness ticks; **no servo in JS** |
| `engine.jogHold` (get/set) | `sync.jogHold {on}` | mirror |
| `engine._localPeriod(d)`, `_beatPhase(d)`, `_barPhase(d)` | — | engine.js functions on mirrors (grid + extrapolated position) |
| `engine.setDeckColor(i, v)` | `deck.color {deck, v}` | deck `filterVal` mirror |
| `engine.colorType`, `setColorType(t)` | `color.type {type}` | mirror |
| `engine.colorEnabled`, `setColorEnabled(b)` | `color.enabled {on}` | mirror |
| `engine.setMasterVolume(v)`, `masterVolume` | `master.volume {v}` | mirror |
| `engine.setMasterFilter(v)`, `masterFilterVal` | `master.filter {v}` | mirror |
| `engine.setCrossfader(x)`, `crossfader` | `xf.set {x}` | mirror |
| `engine.setCuePfl(i, on)` | `deck.pfl {deck, on}` | deck `cueOn` mirror |
| `engine.masterPeak()` | — | snapshot `mixer.masterPeak` |
| `engine.setPhonesDevice(id)` → Promise<bool> | descriptor (§8.1) → `device.phones` | resolves with the reply |
| `engine.phonesDevice` | — | mirror (Chromium id) |
| `engine.phonesOk` | — | snapshot `device.cueRouted` |
| `new VstHost(engine)` (app.js:8301) | `engine.createVstHost()` → `NativeVstHost` (vst.* commands, §13) | same API as vst.js |
| (new) `engine.preloadSample(buffer)` | sampler handoff + `sampler.load` (§7.2.12) | — (absent on the Web engine: app.js calls it with `?.`) |

Module exports of engine.js used by app.js and waveform.js
(`gridIndexFracAt`, `gridTimeAtIndex`, `gridPeriodAt`, `barAlignedSeekTime`,
`setGlobalGridOffset`, `getGlobalGridOffset`) stay imported from engine.js:
they are pure functions of the deck fields, which the facades mirror; the
global offset reaches the engine through the `syncLock()` hook.

### 16.2 Deck

| engine.js API (app.js use) | Native: command(s) | Native: synchronous answer |
|---|---|---|
| `deck.id` | — | index |
| `deck.buffer` | — | the AudioBuffer given to loadTrack (renderer copy, Phase 2; §17.8) |
| `deck.duration` | — | `buffer.duration` |
| `deck.track`, `peaks`, `musicKey`, `hotCues` (mutated in place), `tempoRange`, `_loopInPoint` | — | plain JS fields (UI data, not engine state) |
| `deck.onEnded = fn` | — | called on `deck.ended` |
| `deck.bpm`, `beatOffset`, `beats`, `gridShift`, `barAnchor` (get/set) | setters coalesce per task into one `deck.grid {...}` (`beats` sent only when the array identity changed) | mirrors |
| `deck.effectiveBpm` | — | bpm × tempo (mirror) |
| `deck.loadTrack({buffer, bpm, peaks, track, beatOffset, hotCues, beats, gridShift, barAnchor})` | `pcm.begin` (headroom from `peaks`) → reply → `deck.load {deck, loadId, grid}` + chunks (§7) | engine.js loadTrack rules on the mirrors |
| `deck.play()`, `pause()`, `togglePlay()` | `deck.play` / `deck.pause` | predicted `playing`, re-anchored position (armed start: the facade shows the cue until the engine's `anchorT`) |
| `deck.playing` | — | mirror → snapshot; false on `deck.ended` |
| `deck.currentTime()` (app.js, waveform.js) | — | extrapolated with segments (§4.5); the mirror offset while stopped |
| `deck.seek(t)` | `deck.seek {deck, t, at}` (+ PCM send queue reordered) | clamp + loop-exit rule on mirrors, position = t at once |
| `deck.cue()` | engine.js cue() decided on mirrors → `deck.pause` + `deck.seek`, or `deck.cuePoint`, or `deck.seek` | mirrors |
| `deck.cuePoint` (get/set) | `deck.cuePoint {deck, t}` | mirror |
| `deck.setTempo(r)`, `deck.tempo` | `deck.tempo {deck, r}` | clamped mirror; snapshot `tempo` adopted continuously (the servo moves it) |
| `deck.setLoop(s, e)`, `exitLoop()`, `looping`, `loopStart`, `loopEnd` | `deck.loop` / `deck.loopExit` | engine.js rules on mirrors → snapshot |
| `deck._loopBeats` (get/set) | `deck.loopBeats {deck, beats}` | mirror (cleared like engine.js) → snapshot |
| `deck.keyShift`, `setKey(s)` | `deck.key {deck, semi}` | mirror (rounded, clamped) |
| `deck.keylock`, `setKeylock(b)` | `deck.keylock {deck, on}` | mirror |
| `deck.synced` (get/set) | `sync.arm {deck, on}` | mirror → snapshot `sync.synced[d]` |
| `deck._syncBase` (get/set), `_syncRef` (set), `_pllCorr` (get/set) | `sync.base {deck, base?, ref?, pllCorr?}` | mirrors → snapshot |
| `deck._padRoll = {beats, mix} \| null` | `deck.padRoll {deck, beats, mix}` | mirror |
| `deck._padDryHold = x \| null` | `deck.padDryHold {deck, dry}` | mirror |
| `deck.startRoll(beats, mix)` → bool, `stopRoll(immediate)` | `deck.roll` / `deck.rollStop` | engine.js preconditions on mirrors |
| `deck.stems` (get/set) | set: stem handoff + `deck.stems {deck, vocals, drums, bass}` | the JS object (stubs once handed off, §17.8) |
| `deck.stemsOn`, `loadStems(stems)` | `deck.stemsOn {deck, on: true}` | mirror (gains back to 1) |
| `deck.stemGains[k].gain.setTargetAtTime(v, t, tau)`, `.gain.value` | `deck.stemGain {deck, stem, v, tau}` | AudioParam shim (`value` = last target) |
| `deck.scrubStart()`, `scrubMove(t)`, `scrubEnd()` | `deck.scratch {phase, t, at}`; `scrubMove` without `scrubStart` = engine.js "offset = t" → `deck.seek` | position mirror = t at once |
| `deck.spinSound(kind)`, `stopSpinSound()` | `deck.spin {kind}` / `{kind:"none"}` | — |
| `deck.setVolume(v)`, `volume` | `deck.volume {deck, v}` | mirror |
| `deck.setEq(band, v)`, `eq` (object, spread by app.js) | `deck.eq {deck, band, v}` | mirror `{low, mid, high}` |
| `deck.setTrim(v)`, `trimVal` | `deck.trim {deck, v}` | mirror |
| `deck.filterVal`, `deck.cueOn` | (set through engine.setDeckColor / setCuePfl) | mirrors |
| `deck.meterPeak()` | — | snapshot `peak` |
| `deck.setInsert(node, latency)` (vst.js only) | not used in native mode (VST lives in the engine) | no-op with a console warning |

### 16.3 FxUnit (panel units, pad units, master FX)

| engine.js API (app.js use) | Native: command(s) | Native: synchronous answer |
|---|---|---|
| `u.type`, `u.setType(t)` | `fx.set {unit, type}`; a name the engine does not know is sent as `echo` (engine.js's default chain; one unknown name would make the engine refuse the whole message) | mirror (keeps the name) |
| `u.enabled`, `u.setEnabled(b)` | `fx.set {unit, enabled}` | mirror |
| `u.level`, `u.setLevel(v)` | `fx.set {unit, level}` | clamped mirror |
| `u.beatsMult`, `u.setBeatsMult(m)` | `fx.set {unit, beats}` | mirror |
| `u.setBeatDur(sec)` (app.js frame loop, enabled units only) | none: the engine computes the beat clocks per block (§12) and gives them to enabled units only (§11.1) | stored only |

---

## 17. JS proxy (owner: jsproxy — `src/js/native-engine.js`)

### 17.1 Files and exports

`src/js/native-engine.js` (an ES module; it may be split into
`src/js/native-engine/*.js`, same owner) exports `createAudioEngine(opts)`,
`NativeEngine`, `NativeVstHost`. It imports `AudioEngine` and the grid
helpers from `./engine.js` (for the fallback and the mirror math). It must be
importable in Node (no browser global touched at import time) for the unit
tests. `src/js/stems.js` (new, same owner) holds `alignStems` (moved
verbatim from app.js) and `decodeStemSet(paths, ctx)` (decode, bass+other
merge, alignment), shared by app.js and the fallback rebuild (§17.8).

### 17.2 Objects

- `NativeEngine`: the AudioEngine surface of §16.1, plus `isNative` (true
  while native), `startRecording()`, `stopRecording()`, `createVstHost()`,
  `preloadSample(buffer)`, `shadowStats()`, `onFallback` callback, `status`
  (`connecting`, `native`, `web`), `fallbackReason`.
- `NativeDeck` ×4, `NativeFxUnit` (fx0..3, pads created lazily, master
  created lazily): stable identities for the whole session (app.js keeps
  references in closures), also after a fallback.
- Shims: the context (`decodeAudioData`, `currentTime`, `sampleRate`,
  `state`, `resume`, `setSinkId`, `createGain`, `createBufferSource`,
  `baseLatency` / `outputLatency` from the device status), `postBus`,
  `stemGains[k].gain` AudioParams.

### 17.3 Mirrors, prediction and reconciliation

- UI-owned values (track data, grid, hot cues, cue point, strip knobs,
  crossfader, master volume/filter, color, FX settings and assignment, key,
  keylock, jogHold) live in the facade and are sent as commands; getters
  answer from the facade.
- Engine-owned values (heard position and segments, rate, `playing` at the
  end of a track, `tempo` under the sync servo, `synced` / `_syncBase` /
  `_syncRef` / `_pllCorr` under the lock, `masterIdx` after a handover,
  `autoMasterIdx`, loop state after a seek, roll state, meters, `phonesOk`)
  come from the snapshot.
- Snapshots are ignored until their `epoch` equals the `hello` reply's.
- Every command gets `seq`. Each deck remembers the `seq` of its last
  **discontinuous** command (§4.5); the transport fields of deck d are
  adopted from a snapshot only when `ack` covers it (or its `applied` event
  arrived for `when` commands); before that the facade keeps its
  prediction. Continuous fields (tempo, rate, meters, sync fields) are
  adopted from every snapshot. Predictions follow engine.js exactly:
  play/pause/seek/scrubMove start a local segment; setLoop/exitLoop/seek
  apply engine.js's loop rules; `sync(i)` predicts the tempo with
  `_syncRatio` on mirrors.
- Loops: `state.t` is a presentTime 20-45 ms ahead and a loop wrap starts no
  segment, so the wrapped `pos` of a snapshot taken just after a wrap,
  extrapolated back to now, would fall below `loopStart` (a playhead flick
  at every wrap, and app.js computations on `currentTime()` off by up to the
  output lead). Within the same segment of a looping deck the facade
  therefore unwraps the engine `pos` onto its own timeline (k loop lengths)
  and folds on read, like engine.js's unwrapped `currentTime()`
  (`deck.js _adopt()`).
- `deck.ended` (or a snapshot whose `endedCount` grew): playing = false,
  position = duration, `_endedAt`, then `deck.onEnded()`.
- Writes from app.js to engine-owned fields (`deck.synced = false`,
  `deck._syncBase = nt`, `engine.masterIdx = x`) are predicted at once and
  sent (`sync.arm`, `sync.base`, `sync.master`).

### 17.4 Batching

Commands produced during one JS task are sent as one batch (flushed by a
microtask); grid setters are coalesced into one `deck.grid`; nothing is sent
twice when the value did not change (app.js re-applies knobs often). A batch
answered `full` is resent whole on the next animation frame (or a 20 ms
timer), matched by the `seq` of the error event (§6.4), at most 300 times
(`MAX_FULL_RESENDS`, ~5 s of frames); then it is dropped, its requests
resolve `{ok:false, error:"full"}` and `stats.dropped` counts it. **Order**:
while a refused batch waits, every newer batch is held behind it
(`stats.held`) instead of being posted (a smaller later batch could fit
where the refused one did not and reach the audio thread first); the resend
joins the refused batch and the held ones (up to `RESEND_CHUNK_COMMANDS` =
1024 commands, at least the refused one) into **one message**, which the
engine applies or refuses as a whole; when no refusal came back within
`RESEND_CONFIRM_MS` (8 ms; the host answers a refusal at once) it was
accepted, what is still held leaves as one message and new batches flow
directly again. Batches already posted before the first `full` reached the
proxy (one round trip) can still overtake it. A message refused for any
other reason resolves its requests at once `{ok:false, error,
refused:true}` (`link.js onRefused`).

### 17.5 Clock and device

Clock sync and extrapolation as in §4.5. Devices: §8.1 (pseudo-ids → role,
prefixes stripped, label + nameIndex stored with `audioOutput` when the user
picks a device; `''` = default device / no phones card). The saved device is
opened once at connect; decodes wait for its rate (a new
OfflineAudioContext when the rate changes).

### 17.6 Liveness and fallback to the Web engine

Triggers: no module, spawn failure, `hello` timeout (10 s), `device.open`
failure, `engine-exit`, `device {reason:"stalled"}`, or the **liveness
rule**: no `state` and no `hb` for ≥ 3 s, measured only while the renderer's
own loop was responsive (a 100 ms interval timer: only ticks that arrive less
than 50 ms late count towards the 3 s, so UI jank from the analysis loops —
`detectBPM`, `computeBandPeaks`, `alignStems` — never triggers it), **and**
a `clock.ping` sent after the silence began got no `clock.pong` within 1 s.

Procedure (order matters):
1. `await window.omEngine.kill()`: main kills the engine host and resolves
   on its `exit` (≤ 1 s) — a hung-but-alive host would otherwise keep
   playing under the Web engine (double audio).
2. Freeze the transport model at that instant (positions extrapolated,
   playing flags).
3. `new AudioEngine()`; `await ctx.setSinkId(saved)`, `_wireOutput()`,
   `await setPhonesDevice(saved phones)` — before any sound, so nothing
   bursts out of the default output.
4. Re-apply the mixer (volumes, EQ, trims, color, filter, crossfader, master
   volume/filter), the FX settings and assignment (`updateFxSends`), the
   master choice.
5. For every deck with a buffer: `loadTrack` with the mirrors (grid, hot
   cues, peaks, track), then tempo, key, keylock, cue point, loop and
   `_loopBeats`; stems rebuilt from the cached separation
   (`stemsSeparate(track.path)` → `decodeStemSet`, §17.8) and re-enabled
   with their gains; wait until each keylocked / keyed deck's WSOLA worklet
   node exists (≤ 1 s) so it does not start on the two-tap fallback and
   re-route with a glitch; `seek(frozen position)`.
6. `play()` the decks that were playing.
7. VST: `NativeVstHost` builds a vst.js `VstHost(engine)` and restores the
   saved slots, **skipping suspects** (§13.5).
8. Every facade delegates to the Web objects (same identities) for the rest
   of the session — including the context shim, which `Library` captured at
   startup (`new Library(engine.ctx)`) and which then forwards to the Web
   engine's AudioContext; `onFallback(reason)` lets app.js show
   `engine_native_fallback`. One fallback per session.

While the status is `falling-back`, REC still takes the native path:
`startRecording()` answers `{ok:false, error:"native engine not active"}`
(the `recording_error` toast) instead of a MediaRecorder on a Web engine
that does not exist yet.

At connect (after `hello` and the pings, before `device.open`), the facade
asks `rec.status`; a recording left running by the previous page (renderer
reload) is finalized with `rec.stop` (logged), so `rec.list` offers it at
ready (`core.js _finishOrphanRecording`; the engine's `hello {reset}` does
the same on its side, §2 item 6).

### 17.7 PCM handoff scheduler

§7.2 in code: one scheduler per stream (track, stems, samples), a pool of 2
Float32Arrays per stream, ≤ 8 chunks in flight, ≤ ~2 ms per frame for all
streams together (tracks of playing or armed decks first, then other
tracks, stems, samples), reordered on every jump (§7.2.6), aborted on
reload/unload, `NotFound` retried once.

### 17.8 RAM

Phase 2 keeps the renderer's track AudioBuffers (alignStems, the
sample-level zoom of waveform.js:246 and 282-285, the fallback) and the
engine's int16 copy. KPI: `pcmBytes` (state) and the renderer's memory
(`window.omEngine.memoryInfo()`), logged at each load; target ≤ 55 % of the
Web engine's decoded audio at the end of Phase 3.

- **PCM memory limit**: the host creates the engine with `maxPcmBytes` =
  40 % of the PC's RAM (`engine-host.js`; main may pass another value in
  `init`). Beyond it `pcm.begin` is refused `memory` instead of the PC
  paging with audible dropouts (the renderer keeps its own copy of every
  track in Phase 2). The proxy logs the refusal with what the engine holds;
  a track is reloaded once (memory may have been freed meanwhile), then the
  fallback to the Web engine (which plays the renderer's copy) carries the
  code `memory`, so app.js shows the reason translated
  (`engine_reason_memory`); stems or a sampler sound refused tell app.js
  through a `pcm-memory` event (at most once per 10 s per kind:
  `engine_memory_stems`, `engine_memory_sample`).

- **Phase 2 quick win (stems)**: once the three stems of a deck are
  handed off (`pcm.done` ×3), the facade replaces each stem AudioBuffer in
  `deck.stems` by a stub `{length, duration, sampleRate, numberOfChannels}`
  (app.js only tests `deck.stems` and passes it to `loadStems`; alignStems
  ran before the assignment). On fallback the stems are rebuilt from the
  cached separation. 4 decks with stems then need ≈ 1.65 GB instead of
  ≈ 3.3 GB (≈ 75 % of the Web engine).
- **Phase 3 (planned)**: drop the track copy too — alignStems on a
  decimated mono copy (or in the engine), the sample-level zoom drawn from
  the fine peaks or from an engine "samples window" request, files
  re-decoded on fallback. waveform.js and library.js changes belong to the
  jsproxy owner.

### 17.9 Changes in app.js, index.html, i18n.js (the only ones)

1. app.js:22 — `const engine = createAudioEngine({ onFallback: (reason) =>
   flashStatus(t('engine_native_fallback', { reason })) });` (+ import).
2. app.js:8301 — `const vstHost = engine.createVstHost ? engine.createVstHost()
   : new VstHost(engine);`
3. app.js REC button — when `engine.isNative`: `rec.start` / `rec.stop`
   through `engine.startRecording()` / `stopRecording()`, then
   `window.omEngine.saveRecording(path, 'OpenMix <stamp>.wav')`; when the
   save is cancelled or fails, a status line with the kept path and a "Show
   in folder" button; `rec.status {error}` shown; the MediaRecorder path
   stays for the Web engine (the native path is also taken while
   `engine.status === 'falling-back'`, §17.6).
4. app.js `samplerLoadSlot` — `engine.preloadSample?.(buffer)` after the
   decode.
5. app.js — `alignStems` moved to `src/js/stems.js` and imported.
6. app.js startup (native only) — the unsaved recordings from `rec.list`
   are offered (status line + "Show in folder").
7. Settings row (index.html, after "Mix audio output"): select `#set-engine`
   with `web` (Standard), `native` (Native, beta), `native-exclusive`
   (Native, beta, exclusive mode) + a status span (mode, period, latency);
   app.js stores the choice in `localStorage.audioEngine` and shows
   `engine_restart_hint` (the choice applies at the next launch).
8. i18n.js, fr and en: `settings_audio_engine`, `engine_web`,
   `engine_native`, `engine_native_exclusive`, `engine_restart_hint`,
   `engine_native_active`, `engine_native_unavailable`,
   `engine_native_fallback`, `recording_saved_wav`, `recording_kept`,
   `recordings_unsaved`, `show_in_folder`, `recording_error`,
   `device_lost`, `device_restored`, `engine_period`; since the review round
   of 2026-11-07 also `engine_reason_memory`, `engine_memory_stems`,
   `engine_memory_sample` (§17.8). app.js's `onFallback(reason, code)` and
   the Settings status show `engine_reason_memory` for the code `memory`.

---
## 18. Build and tests

### 18.1 Build commands

| Command | Result |
|---|---|
| `npm run build:engine` | `native/engine/build/Release/openmix_engine.node` (cmake-js, Electron 43.1.0 headers from the cmake-js cache, x64, Release, /MT, VST3 when `native/vst3sdk` exists) |
| `node tools/build-engine.js --tests [--filter core]` | every module test in `native/engine/build-tests` (Visual Studio 17 2022, Debug) + `ctest` |
| `node tools/build-engine.js --module <m>` | **one module**: configures `native/engine/build-tests-<m>`, builds only the target `om_test_<m>` (and what it links) and runs its test. The VST3 SDK is configured only for `core` and `vst`. This is what module owners use: an error in another module does not block them and parallel engineers never share intermediate files |
| `node tools/build-engine.js --portable [--module <m>]` | `OM_PORTABLE_ONLY=ON`: the portable set and its tests with the `none/` stand-ins, no Windows library (`build-tests-portable[-<m>]`) |
| `node tools/build-engine.js --sanitize address [--module <m>]` | AddressSanitizer test build (`build-tests[-<m>]-asan`, §18.5) |
| `node tools/build-engine.js --all` | the `.node` and every test |
| `node tools/build-engine.js --clang-cl [--module <m>]` | the portable set with Visual Studio's clang-cl toolset (`build-tests-clangcl[-<m>]`) |
| `node tools/build-engine.js --source <dir> ...` | the same builds of a **private copy** of `native/engine` (the integrator builds a snapshot in which another module's sources are refreshed only when they compile; same lock, priority and lint; its build folders inside the copy) |
| options | `--config Debug` (the .node), `--rt-trap` (allocation trap in the .node), `--jobs N` (2: the PC is shared), `--no-vst`, `--no-wait`, `--node-out <dir>` (build folder of the .node; an engineer's private .node does not go to `native/engine/build`) |

The script lowers its own priority to below normal (child processes inherit
it), runs the RT lint (§18.6) before test builds, and takes a **build lock**
(`native/engine/.build.lock`: pid, module, start time) so only one engine
build runs on the PC at a time: a second build waits (polling every 5 s, up
to 30 min, printing who holds the lock; `--no-wait` fails at once); a lock
whose process is gone is taken over.

### 18.2 CMake layout (`CMakeLists.txt`)

One static library per module, sources globbed per folder (owners add files
without touching CMake), `/W4 /permissive- /utf-8 /fp:precise` (MSVC) or
`-Wall -Wextra -ffp-contract=off` (clang/gcc), C++20, static CRT everywhere
on MSVC (`SMTG_USE_STATIC_CRT ON`):

| Library | Sources | Notes |
|---|---|---|
| `om_json` | `src/json/*.cpp` | linked by the core and every test |
| `om_device` | `src/device/*.cpp` | portable: names, resolution rules, NULL device, recorder, phones ring / drift |
| `om_device_wasapi` / `om_device_none` | `src/device/win/*.cpp` / `src/device/none/*.cpp` | WASAPI backend (ole32, avrt, uuid, ksuser) or stand-ins; `om_device_backend` = the one built |
| `om_pcm` | `src/decoder/*.cpp` | portable: PCM store, conversions, resampler, offset finder, WAV reader, shadow job runner |
| `om_shadow_mf` / `om_shadow_none` | `src/decoder/win/*.cpp` / `src/decoder/none/*.cpp` | Media Foundation reader (mfplat, mfreadwrite, mfuuid, propsys) or stand-ins; `om_shadow_backend` |
| `om_deck`, `om_fx`, `om_sync` | `src/<module>/*.cpp` | portable |
| `om_mixer` | `src/mixer/*.cpp` | portable; **does not link om_fx** (FX seam, §10.3) |
| `om_vst` | `src/vst/*.cpp` + `src/vst/win/*.cpp` (VST3 SDK: sdk_hosting + a glue library with module_win32, plugprovider, memorystream) or `src/vst/none/*.cpp` | the SDK part only on Windows with `OM_WITH_VST` |
| `om_core` | `src/core/*.cpp` | links everything |
| `openmix_engine` | `src/node/*.cpp` | cmake-js only |

Options: `OM_BUILD_NODE`, `OM_BUILD_TESTS`, `OM_WITH_VST`, `OM_RT_TRAP`,
`OM_PORTABLE_ONLY` (no `win/` library even on Windows), `OM_SANITIZE`
(`address` | `thread` | `undefined` | `realtime`), `OM_TEST_MODULES` (the
test executables to define; default all). Outside Windows the script
configures the portable set automatically (no fatal error).

### 18.3 Tests and definition of done

- One plain C++ executable per module: `om_test_core`, `om_test_device`,
  `om_test_decoder`, `om_test_deck`, `om_test_mixer`, `om_test_fx`,
  `om_test_sync`, `om_test_vst` (= `tests/om_test_main.cpp` +
  `tests/<module>/*.cpp`), registered in CTest; each links only its module
  (the mixer's tests use fake FX processors and a fake insert).
- `OM_TEST`, `OM_CHECK`, `OM_CHECK_NEAR`, `OM_TODO` (pending acceptance
  test: reported, fails only with `OM_TEST_STRICT=1`), `OM_SKIP`; golden
  helpers `omtest::goldenPath`, `omtest::readWav`, `omtest::residualDb`.
- Real-time checks: wrap the code under test in `om::rt::Scope`; the runner
  fails the test if anything allocated **or freed** inside.
- Silent by construction: NULL device and offline buffers. Opt-in
  environment: `OM_TEST_REAL_DEVICE=1` (shared mode, gain 0, ≤ 5 s),
  `OM_TEST_VST_PLUGIN=<path.vst3>`, `OM_GOLDEN_DIR=<folder>` (§18.4),
  `OM_TEST_VST_FAULTS=<folder>` (G9's fault plugins `om-fault-N.vst3`),
  `OM_TEST_VST_NO_EDITOR=1` (no plugin editor window at all: the shared PC),
  `OM_TEST_VST_SPY` / `OM_TEST_VST_KOTELNIKOV` / `OM_TEST_VST_AGAIN` (default:
  `build-tests-vst-spy/Release/om-spy.vst3`, the installed TDR Kotelnikov,
  the SDK's again sample), `OM_TEST_VST_SCRATCH` (a writable folder),
  `OM_SYNC_JS_TRACE` / `OM_SYNC_SWEEP` (the sync cross-check with the real
  engine.js and the 100-seed replay sweep). The integration run sets
  `OM_TEST_STRICT=1`, `OM_GOLDEN_DIR`, `OM_TEST_VST_FAULTS` and
  `OM_TEST_VST_NO_EDITOR=1`.
- The om-spy test plugin (`tests/vst/spy`, report version 2) is built apart:
  `cmake -S native/engine/tests/vst/spy -B native/engine/build-tests-vst-spy
  -G "Visual Studio 17 2022" -A x64` then `cmake --build ... --config
  Release`, after any change to `om_spy_plugin.cxx` (the tests that need
  it fail with "rebuild it" on an older binary).
- JS (jsproxy): `node --test` files under `test/native-engine/` with a fake
  engine port (no Electron, no audio).
- Integration test (host): `om_test_core` drives the whole engine through
  the C API in manual mode — PCM handoff, deck.load, offline render, state,
  `when`, batches, routing — already green for the skeleton. It also holds
  the end-to-end tests of what only the core computes:
  `test_core_vst_e2e.cpp` (the insert state of the snapshot on fakes and
  with the real VstHost; V08 ProcessContext from the deck, V05 latency
  changes reaching the read-ahead, both with om-spy; V25 TDR Kotelnikov's
  delay after play and hot cue; the plugin cases skip without the SDK or the
  plugin), `test_core_sync_e2e.cpp` (§12), `test_core_latency.cpp` (PLAY /
  hot cue to sound) and `test_core_roundtrip.cpp` (engine-host /
  engine-main in a hidden Electron window, never OpenMix).
- **Definition of done for a module**: its TODO tests implemented and green
  (also with `OM_TEST_STRICT=1`); its **null tests against the golden
  renders pass** (residual < −80 dBFS at tempo 1; skipped only when
  `OM_GOLDEN_DIR` is unset, never in the integration run); no allocation or
  free in any `rt::Scope`; no warning at `/W4`; it builds with
  `--portable` (except `win/` code) and with `--sanitize address`; its
  parts of §16 verified in the app by the integration pass (nobody but
  David starts OpenMix: he runs the A/B on the FLX6).

### 18.4 Golden references (owner: host — `tools/make-goldens.js`)

Every parity-critical DSP piece is a port of Chromium code written without
access to its source (no downloads): AudioBufferSourceNode interpolation at
edges and loop seams, biquads under `setTargetAtTime` (per-sample
coefficients), DynamicsCompressorKernel (knee solve, makeup, adaptive
release, 32-frame divisions), DelayNode's 128-frame clamp in cycles,
WaveShaper, StereoPanner, ConvolverNode normalization, the WSOLA worklet.
Tests against reference ports written from the same memory would pass with
the same mistakes, so the references are rendered by **Chromium itself**,
now (not in Phase 1):

- `tools/make-goldens.js` runs with the Electron 43.1.0 already in
  `node_modules`: `node tools/make-goldens.js [--out native/engine/goldens]
  [--suite a,b] [--quick]` (or `npm run build:goldens`) re-launches itself
  under Electron with `ELECTRON_RUN_AS_NODE` removed from the environment
  (the local shell sets it) and waits for it. It opens a hidden `BrowserWindow` (`show: false`, userData
  in a temp folder, every non-`file:` request blocked) on a local page and
  renders with **OfflineAudioContext only**: silent, no device, a few
  seconds of CPU, not OpenMix, no port. It exits on its own; it is never
  killed by path or by name (`electron.exe` has the same path as OpenMix's
  through the node_modules junction).
- The page imports `src/js/engine.js` and instantiates its own classes
  (`Deck`, `FxUnit`, and `AudioEngine` with `AudioContext` aliased to an
  OfflineAudioContext factory), so the renders use engine.js's exact node
  setups; parameter moves use `OfflineAudioContext.suspend(t)` so they
  happen at exact frames.
- Suites: EQ and filter knob sweeps with their `setTargetAtTime`; the
  limiter on bursts and steps; AudioBufferSourceNode at rates ≠ 1, at file
  rate ≠ context rate and with loops (seams); every FX type at several
  levels and beat lengths (reverbs with a seeded impulse handed to the
  ConvolverNode); every Color FX type; the real `pitch-worklet.js` inside an
  AudioWorklet (ratio ramps, 0.5..1.8); `decodeAudioData` of generated
  WAV / MP3 files (for the shadow comparison tests).
- Output: `native/engine/goldens/<suite>/<case>.wav` (float32), the input
  it was fed `<case>.input.wav` (an encoded input keeps its extension, e.g.
  `.input.aac`; `"input"` in the JSON names it), and `<case>.json` (suite,
  case, rate, channels, frames, the node graph, `setup`, `events` `{frame,
  time, call, args}` of the engine.js calls at exact render-quantum frames,
  `files` it refers to, notes), plus `<out>/index.json` (every case); git-ignored;
  tests read them through `OM_GOLDEN_DIR` and skip when it is unset.
- Suites and folders of this generator (107 cases, ~218 MiB, rendered in ~5 s):
  `strip` (Deck: EQ low / mid / high sweeps, kills, filter sweep through the
  dead zone, trim, fader), `master` (AudioEngine master chain: volume,
  master filter, crossfader curve through two strips), `limiter` (engine.js
  DynamicsCompressor: bursts 0.3..3.0, noise steps, transients, unequal
  channels), `source` (AudioBufferSourceNode as Deck._makeSource sets it:
  rates 0.5..1.6, exact copy at 1, fractional start offset, 44.1 kHz buffer,
  loops with fractional seams, 10 ms loop, buffer end, tempo steps;
  V.BRAKE / BACKSPIN voices of Deck.spinSound), `fxunit` (every FxUnit type
  at levels 0.4 / 1, more beat fractions for the delays, beat duration
  0.468 for the glides; LFOs restarted at frame 0 by `alignTo(0)`), `color`
  (every Color FX type, and the noise), `wsola` (pitch-worklet.js: constant
  ratios 0.5..1.8, steps, keylock at tempo 1.06), `decode` (decodeAudioData
  at 48 kHz of generated WAV 16 / 24 / float 44.1 / 48 / 96 kHz, mono,
  6 channels, and an ADTS AAC stream encoded by WebCodecs — the encoder
  delay the shadow decoder must measure). Every input comes from a seeded
  xorshift32 (described in the JSON); Math.random is replaced by it while
  engine.js builds its impulses and noise buffer, and those buffers are
  saved next to the cases (`fxunit/reverb_impulse.wav`,
  `color/space_impulse.wav`, `color/noise_buffer.wav`, raw: the
  ConvolverNode normalizes).
- **Folder ownership**: the generator clears and rewrites only its own
  suite folders (and merges `index.json`). A module that needs other cases
  runs its own generator into `goldens/<module>/` only and never deletes
  another folder:
  - `tests/deck/goldens` (`make_deck_goldens.js`) → `goldens/deck/`;
  - `tests/fx/goldens` (`make_fx_goldens.js`) → `goldens/fx/` (94 cases: every
    FX and Color type at 48 kHz and 44.1 kHz, plus the `rate96` and `timing`
    families, §11.7);
  - `tests/mixer/goldens` (`make_mixer_goldens.js`) → `goldens/mixer/` (25
    cases: strip / master / limiter at 44.1 and 96 kHz, the limiter
    staircase and steps, the whole graph through AudioEngine, FX sends and
    dry cut with identity units, Color sends with an identity bus). The
    mixer parity tests FAIL (not skip) when `OM_GOLDEN_DIR` is set and
    `goldens/mixer/` is missing: the integration run generates it before the
    tests.
  - Each module generator runs under the Electron of `node_modules` with
    `ELECTRON_RUN_AS_NODE` removed: `electron.exe
    native/engine/tests/<module>/goldens/make_<module>_goldens.js [--out
    native/engine/goldens/<module>]` (hidden window, OfflineAudioContext
    only, exits on its own).
- **Readers** of the host suites: `strip` and `color/noise`
  (`tests/mixer/test_strip.cpp`), `master` (`test_mixer.cpp`), `limiter`
  (`test_limiter.cpp`), `source` (`test_sampler.cpp`, and
  `tests/deck/test_deck_golden_suites.cpp` with the `spin_*` cases), `wsola`
  (`tests/deck/test_deck_golden_suites.cpp`), `fxunit`
  (`tests/fx/test_fx_parity.cpp`), `decode` (`tests/decoder`); the other
  Color FX types are nulled on `goldens/fx/`'s own color family;
  `tests/core/test_core_goldens.cpp` checks that every case of `index.json`
  is complete and readable.

### 18.5 Sanitizers and portability

- `OM_SANITIZE=address` with MSVC: `/fsanitize=address` on the test build
  (no `/RTC1`, no incremental link, VST SDK off); the allocation trap stays
  active (it calls `malloc`, which ASan intercepts). MSVC's ASan runtime is
  a DLL even with /MT: CMake copies it next to each test executable (else
  the loader stops on a "DLL not found" dialog). Every module's DoD
  includes a green ASan run.
- Unattended runs on the shared PC: the test runner turns off the Windows
  error dialogs (`SetErrorMode`) and sends CRT asserts to stderr, so a
  crash fails the test instead of waiting for a click.
- clang `thread`, `undefined` and `realtime` (RTSan) builds of the portable
  set run in CI (GitHub Actions, Linux/macOS) later; `OM_SANITIZE` already
  accepts them.
- `dsp::flushDenormals()` and `dsp::FpEnvGuard` are guarded per
  architecture (MXCSR on x86/x64, FPCR on arm64, no-op elsewhere).
- `--portable` on this PC proves the portable set does not depend on
  Windows libraries (also checked with Visual Studio's clang-cl toolset:
  `cmake -T ClangCL -DOM_PORTABLE_ONLY=ON`); the macOS / Linux CI proves it
  compiles without `_WIN32`.

### 18.6 RT lint

The allocation trap sees operator new/delete only. Before every test build
the script greps `native/engine/src` for direct heap calls (`malloc`,
`calloc`, `realloc`, `free`, `_aligned_malloc`, `_aligned_free`,
`HeapAlloc`, `HeapFree`, `HeapReAlloc`, `VirtualAlloc`, `VirtualFree`,
`LocalAlloc`, `GlobalAlloc`, `strdup`) and fails on any occurrence not
marked `// rt-lint: allow (<reason>)` on the same line (`src/node/rt_trap.cpp`
is exempt: it is the trap).

---

## 19. Module ownership and integration

### 19.1 Ownership (disjoint)

| Key | Owns |
|---|---|
| host | `include/om/{common,om_state,rt,spsc_queue,triple_buffer,dsp,grid,media,deck_control,commands,protocol,json,engine,om_engine}.h`, `src/core/*`, `src/json/*`, `src/node/*`, `tests/om_test.h`, `tests/om_test_main.cpp`, `tests/core/*`, `CMakeLists.txt`, `SPEC.md`, `tools/build-engine.js`, `tools/engine-snapshot.js`, `tools/make-goldens.js` (+ `tools/goldens/`), `package.json`, `.gitignore`, `engine-host.js`, `engine-main.js`, the 3-line hook in `main.js`, the additive block in `preload.js`, packaging |
| device | `include/om/{device,recorder}.h`, `src/device/**` (incl. `win/`, `none/`), `tests/device/*` |
| decoder (PCM, shadow decoder, VST3 inline) | `include/om/{pcm,shadow,resampler,vst_insert}.h`, `src/decoder/**`, `src/vst/**`, `tests/decoder/*`, `tests/vst/*` |
| deck | `include/om/{deck,interpolator,wsola}.h`, `src/deck/*`, `tests/deck/*` |
| mixer | `include/om/{mixer,limiter,meter,sampler}.h`, `src/mixer/*`, `tests/mixer/*` |
| fx | `include/om/{fx,color_fx,convolver}.h`, `src/fx/*`, `tests/fx/*` |
| sync | `include/om/sync.h`, `src/sync/*`, `tests/sync/*` |
| jsproxy | `src/js/native-engine.js` (+ `src/js/native-engine/`), `src/js/stems.js`, `src/js/app.js`, `src/js/waveform.js`, `src/js/library.js`, `src/index.html`, `src/js/i18n.js`, `test/native-engine/*` |

The VST3 port moved from host to the decoder owner (the PCM store already
works): host keeps the frozen headers, the core, the process wiring and
integration.

### 19.2 Frozen headers

The foundation headers (`common.h`, `om_state.h`, `rt.h`, `spsc_queue.h`,
`triple_buffer.h`, `dsp.h`, `grid.h`, `media.h`, `deck_control.h`) and the
public module headers are the contracts between engineers working in
parallel. Each class keeps its private layout behind a pimpl (`struct Impl`)
so owners change their `.cpp` freely; a change to a public header goes
through the host (who integrates) and the owners that call it. Owners may
add private headers inside their `src/<module>/` folder.

### 19.3 Worktree discipline

- No destructive git command in the worktree (§1). Nothing is committed.
- `node tools/engine-snapshot.js --module <key>` writes
  `native/engine/patches/<key>/<timestamp>.patch` (the module's changes
  against HEAD, untracked files included; git-ignored). Take one at least
  at every milestone and before any risky edit. `--all` snapshots every
  module.
- The integrator (host) builds a private snapshot of the tree
  (`native/engine/build-host/src`, git-ignored, `--source`): its own files
  always fresh, another module's files refreshed only when they compile, so
  a module being edited never blocks the core build (the core links every
  module).
- Build only through `tools/build-engine.js` (lock, priority, lint), module
  owners with `--module`.
- `node_modules`, `native/vst3sdk` and `native/tpb` are junctions into the
  `openmix` worktree: read-only (never `npm install` here).

### 19.4 Integration order

1. Parallel from day one: every module against its header and its tests
   (sync against fake decks, mixer against fake FX processors and a fake
   insert, deck against synthetic TrackBuffers, proxy against a fake port),
   golden renders generated first (host).
2. First sound: deck (read pointer) + mixer (strip + master + limiter) +
   device (WASAPI shared) + host (core, binding, engine-host, engine-main)
   + decoder (store) + jsproxy (load, play, seek, knobs).
3. Then: sync, FX, keylock priming, scratch, VST3 inline, phones, recording,
   shadow decoder.
4. Definition of done: §18.3.

---

## 20. Intentional differences from the Web engine

- No 30 ms scheduling lead on play / seek / sync, no 30 ms silence after a
  jump, and no stale audio: jumps are immediate with a 5 ms crossfade.
- Keylock / key: no 55-60 ms delay at PLAY or hot cues (primed transposer);
  same WSOLA sound otherwise (the tempo-history ratio is an A/B option).
- Click-free pause/stop (2 ms fades).
- Armed starts: a play from stop waits (≤ 250 ms) for its audio data instead
  of starting over silence; a sampler pad hit waits (≤ 250 ms) for its first
  chunk.
- Scratch: continuous signed read pointer instead of forward-only grains.
- Sync servo every block on exact positions instead of every animation frame
  on a clock moving in ~3 ms steps (the error low-pass is converted so the
  dynamics stay the same); every duration on the audio sample clock.
- Sync, native precision mode (`sync.precision`, off by default until David
  decides): proportional + integral holding servo (integral time 30 s,
  integral kept out of the base so the BPM shown does not move),
  calibration certified by a fine pass only, coarse corrections under 0.1 %
  ignored, no follow-master rescaling inside a handover, follow-master
  changes played when a keylock master's change is heard, a SYNC deck
  without a base handed over from its current speed, and the learned ratio
  residue kept across a handover (`sync.h`, `setNativePrecision`; §12).
- FX LFOs phase-locked to the beat clock continuously (the Web engine
  re-aligned them at boundaries); reverb impulses from a seeded generator,
  one impulse shared by all FX units' reverbs. FX memory is allocated lazily
  like engine.js (same frozen-tail behaviour).
- FX echoes on the beat: Chromium processes every feedback cycle through a
  DelayNode one render quantum late, so each repeat of the Web engine's
  echoes lands 128 frames (2.67 ms at 48 kHz) after the previous one (a
  1/4-beat echo at 124 BPM is 21 ms late after 8 repeats). Every repeat of
  the native echo, delay, pingpong, lowcut, spiral, upecho, downecho, helix
  and Color echoes lands on its beat within a sample (§11.1); the golden
  renders of those loops compensate Chromium's quantum (loop delay − 128
  frames, + 128 frames after the loop). The flanger keeps the quantum, which
  shapes its comb.
- Meters: peak over the whole period between two reads (no missed peaks);
  the peak itself is the analyser's mono fold, as in the Web engine (§10.8).
- FX re-enabled: its delay lines glide from the beat duration it had when
  it was switched off, as with the Web engine, but the glide starts on the
  block it is enabled instead of at the next animation frame (§11.1).
- An unknown Color FX type name (a session stored by another build) is not
  sent: the engine keeps its current Color type where engine.js routes no
  bus (§16.3); an unknown FX type plays the echo chain in both engines.
- VST3: no ring bridge (−16-17 ms), plugin latency compensated (≤ 1 s), real
  beat position in the transport; a plugin that misses the block deadline
  is replaced by its latency-aligned dry for that block instead of
  stalling the whole engine.
- Recording: WAV 24-bit streamed to disk instead of WebM/Opus in memory;
  never deleted by the app; one file whatever the device does (a device
  rate change is resampled into it, §14).
- Headphones on a second card through a drift-corrected stream instead of a
  second AudioContext and a MediaStream.
- Device loss: silence while the transport keeps running, then the same
  device again when it comes back (Chromium moves to the default device).
- PCM: int16 with a per-chunk scale for stems and samples (quantization
  noise relative to each 65536-frame chunk, far below the null-test
  tolerance); per-track headroom for tracks.
- Renderer RAM: stems dropped from the renderer once handed off (Phase 2);
  track copies dropped in Phase 3 (§17.8).

---

## Appendix A. Constants copied from engine.js

| Constant | Value |
|---|---|
| Pre-roll | 3600 s |
| Tempo clamp | 0.5 .. 1.6 |
| Key clamp | −7 .. +7 semitones |
| WSOLA | N 1536, HS 768, OVL 768, SEARCH 480, R_MIN 0.5, R_MAX 1.8, LAT 2647, RING 16384, ACC 4096, penalty 0.1 |
| WSOLA ratio smoothing | setTargetAtTime tau 0.02 s (k-rate, 128-frame quanta) |
| Deck defaults | volume 0.85, eq 0, trim 0, filter 0, sides A B A B, cue point 0 |
| Fader | volume², tau 0.01 |
| Trim | 4^v, tau 0.01 |
| EQ | lowshelf 200 Hz, peaking 1 kHz Q 0.9, highshelf 8 kHz; v ≥ 0 ? 6v : 40v dB; tau 0.01 |
| Filter (deck and master) | dead zone 0.04; HPF 20·400^v; LPF 20000·(80/20000)^−v; Q 0.9 (dB) |
| Crossfader | "mix" curve, tau 0.01 |
| Color FX | colorWet 0.85; noise amt²·0.4; sends tau 0.01 |
| FX sends | tau 0.015; pad send on 0.01 / off 0.02 |
| Dry cut | tau 0.02, hysteresis 0.01; master dryComp tau 0.05 |
| Master volume | 0.9 default, tau 0.01 (masterGain and fxReturn) |
| Limiter | −3 dB, knee 0, ratio 12, attack 0.002 s, release 0.15 s, pre-delay 0.006 s |
| FX wet / feedback / depth taus | 0.02 / 0.05 / 0.05 |
| FX delay time | clamp(beatDur × beats, 0.02, 3.9), tau 0.08, 0.05 % threshold |
| FX LFO rate taus | trans 0.05, others 0.1 |
| fbFor | min(0.97, base × (0.55 + 0.45 × level)) |
| Roll gains | tau 0.004; refuse slices < 0.01 s |
| Spin | backspin v0 7 decel 4.5; vbrake v0 max(0.2, tempo) decel 1.6; fade last 0.04 s; stop fade 0.02 s |
| Scrub (Web engine, for reference) | grains ≤ 50 ms, skipped beyond 90 ms of queue |
| Auto-master | grace 1.2 s; "ended" window 2 s; bass score 10 + (1 + eq.low) when eq.low > −0.9 |
| Sync ratio | octave folding into [0.5, 1.6]; local period over ±8 beats, valid 0.15 .. 2 s |
| Sync magnets | reanchor 0.03 beat; snapToRef 0.06 beat; offset adoption 0.08 beat |
| Repair | 6 % |
| Calibration | 1 s then 8 s windows, +2 s timeout, limits 1 % / 0.1 %, cap ±2 %, done < 0.02 % or 4 passes, 12 tries, validity 0.05 |
| Servo | error low-pass 0.85/0.15 per 1/60 s, dead zone 0.0015, limits 0.002 (gain 0.08) / 0.015 (gain 1.0) through the transposer |
| Handover | keep the current speed within 0.4 % of the new target |
| fxTick ROLL | panel/master ROLL unit level > 0.02 |
| FX beat clock | beatOf = localPeriod / (tempo / (1 + pllCorr)), fallback 0.5 s |

## Appendix B. Constants of the native engine

| Constant | Value |
|---|---|
| Heartbeat `hb` | every 250 ms |
| Stall | no new block for 0.5 s while running → `diag stall` + one restart; `device stalled` after 2 s |
| Renderer liveness | 3 s without `state`/`hb`, counted on 100 ms ticks less than 50 ms late, and a `clock.ping` unanswered for 1 s |
| `hello` timeout | 10 s |
| Engine-host kill | wait for `exit` ≤ 1 s |
| Armed start (deck, sampler) | ≤ 250 ms on the sample clock |
| VST deadline | 0.35 × callback period (0.1-0.6) |
| VST hung | one `process()` call > 2 s, or 50 consecutive misses |
| `vst.late` events | ≤ 1 per second per deck |
| Plugin latency cap | 1 s |
| Low-latency shared period | smallest multiple of the fundamental ≥ 5 ms; one step up after 3 glitches in 10 s |
| Power throttling re-check | 10 s |
| Queues | commands 4096, events 4096, retired 4096 requested (SpscQueue rounds to 8192 slots: 8191 usable) + backlog 256, pending `when` 64, ≤ 512 commands applied per callback |
| Binding event queue | 4096 (+ 1 coalesced state slot) |
| PCM | chunks of 65536 frames; ≤ 8 in flight per stream; 2 pool buffers per stream; `NotFound` retried once after 50 ms; streams never attached collected after 120 s |
| Recording | ring ≥ 2 s; header patched every second; RF64 beyond 4 GiB |
| Shadow decode | middle 30 s window; ±200 ms coarse search on ×8 decimation; fine ±16 frames; one file per process |
| Golden null tests | residual < −80 dBFS at tempo 1 |
| WSOLA prime | ≈ 2 grains; 4 primes < 25 % of a 128-frame period |
| FX CPU | < 2 % of a 256-frame block per unit; convolver < 1 % per instance |

## Appendix C. Architecture review of 2026-10-20: decisions

Each item of the review, its decision and where it landed. "Accepted" means
the proposed fix was taken; differences from the proposal are explained.

1. **VST3 inline: a hung plugin silences the mix; wrong vsthost.cpp.**
   Accepted. Per-deck MMCSS workers with a synchronous handoff and a block
   deadline (late → latency-aligned dry, repeated misses or a 2 s call →
   hung), two-phase `IInsert::begin/end` so the four plugins run in
   parallel (§10.6, §13.2, `common.h`, `vst_insert.h`); `state` only when a
   new snapshot exists, heartbeat and stall watchdog (§3.5); port from the
   hardened vsthost.cpp with its time-outs on the VST host thread (§13.1);
   transport at the insert input position (§13.3); 1 s latency cap, history
   and dry lines sized for it (§9.9); `FpEnvGuard` around every plugin call
   and `rt::PluginScope` with its own counter (§13.4, `dsp.h`, `rt.h`). The
   "restart the stream without the suspect slot" step is not needed: with
   the workers a plugin can no longer stall the callback, so the watchdog
   restarts the stream once and then reports `stalled` (§3.5).
2. **Threading of control commands; liveness.** Accepted with one
   refinement: the slow commands (devices, recordings, plugins) leave the
   host JS thread for the ops and vst-ops threads and answer by event; the
   control thread itself never blocks (it carries `state` and `hb`). The
   proposal also moved `deck.load` and the other short control commands off
   the JS thread; they stay **inline** because they must remain ordered with
   the audio commands sent after them (a `deck.play` following a
   `deck.load`), and they are bounded (< 1 ms: no I/O, no COM, no plugin, no
   large free — frees moved to the control thread). Liveness rule, separate
   audio-stall detection, 10 s `hello`, coalesced state slot in the binding,
   COM on the ops thread: all taken (§3.1, §3.3, §3.5, §6.3, §17.6).
3. **PCM handoff transport, ordering, UI cost.** Accepted. Float32 planar
   chunks copied with `copyFromChannel` into reused buffers and posted
   without a transfer list; quantization in C++ only (no JS twin, no shared
   vectors); chunks after the `pcm.begin` reply, `NotFound` retried; send
   queue reordered at every jump with the previous chunk for the WSOLA
   history (§7.2, §7.3, §17.7). Headroom: from `deck.peaks` for tracks, and
   for stems and samples the per-chunk scale option of the proposal
   (simpler than a Worker scan and with no UI cost); the engine also folds
   multichannel sources, so no per-sample JavaScript remains.
4. **Time and position model.** Accepted. Segments (`seg`, `anchor_t`,
   `anchor_pos`) in `om_state.h`; previous segment until `anchor_t`;
   adoption gated only on unacked discontinuous commands, slew/snap; `rate`
   = nominal heard rate; presentTime from IAudioClock / filtered mapping;
   `BlockClock.sampleTime` and every internal duration on it (§4, `common.h`,
   `om_state.h`, `deck_control.h`, `sync.h`). Loop wraps do not bump `seg`
   (the proxy wraps like engine.js; bumping at every wrap of a 1/32-beat
   roll would only add segments the proxy can predict).
5. **Fallback and reconnection.** Accepted. Kill the host and wait for
   `exit` before the Web engine; ordered restore (sinks first, WSOLA nodes
   ready, then load/seek/play); persisted plugin suspects; `hello {reset}`
   resets `ack` through an audio-thread `EngineReset` **and** returns an
   `epoch` that the state carries and the PCM store keys streams with (both
   halves of the proposal: the reset fixes `ack`, the epoch makes stale
   snapshots and loadId collisions impossible) (§3.3, §7.3, §15.3, §17.6).
6. **Golden references.** Accepted: `tools/make-goldens.js` now, renders
   by engine.js's own classes in OfflineAudioContext, null tests in every
   module's DoD, the electron.exe caveat (§18.3, §18.4, `om_test.h`).
7. **Module boundaries.** Accepted: `--module` builds in their own folders
   with a lock (§18.1); the VST3 port moved to the decoder owner (§19.1);
   FX seam `IFxProcessor` / `IColorProcessor` (`common.h`, §10.3);
   `deckBeatClock()` in `sync.h`; `engine-main.js` + 3-line hook +
   additive preload block (§6.5); port from the hardened vsthost.cpp;
   no destructive git commands and per-module patch snapshots
   (`tools/engine-snapshot.js`, §19.3).
8. **FX memory.** Accepted: lazy chains, pad and master units created by
   the control thread and attached by pointer, silence until attached,
   shared reverb kernels, non-uniform partitions, idle tails (§11.3,
   §11.5, `fx.h`, `color_fx.h`, `convolver.h`). The alternative "one pool
   per unit sized for its largest chain" was not taken: it would clear the
   frozen tail of a chain when switching types, unlike engine.js.
9. **RAM target.** Accepted: stem buffers dropped from the renderer after
   their handoff and rebuilt from the cached separation on fallback; the
   track copy's removal planned for Phase 3; waveform.js and library.js
   given to jsproxy; KPI `pcmBytes` + renderer memory (§17.8).
10. **Real-time safety.** Accepted: `rt::onDeallocation` counted in both
    traps; sticky `ended_count`; queues sized for the worst case with a
    retired backlog and overflow counters in `om_state.health` (§3.2).
    Direct `malloc`/`HeapAlloc` calls are caught by the RT lint (§18.6).
11. **Device layer edge cases.** Accepted: `Added` / `StateChanged`
    events, NULL pacer during loss and reopening the configured endpoint,
    default followed only when chosen, channel/mask negotiation and the
    listed HRESULTs, roles and pseudo-ids, label + nameIndex stored, one open
    at connect, ≥ 5 ms period with step-up, power throttling off, recording
    continued in a new file on a rate change, optional raw mode (§8, §14,
    `device.h`, `recorder.h`).
12. **Shadow decoder in the real-time process.** Accepted: one short-lived
    below-normal `--shadow` process per file, streaming decode keeping only
    the window, resampling only that span, a copied reference window. The
    window is cut by the renderer from the AudioBuffer it already holds
    (Chromium's own decode, float32 — a better reference than the engine's
    int16 copy), and main runs the child, so the engine process is not
    involved at all and `shadow.*` left the engine protocol (§7.4).
13. **Load-then-play and the sampler's first hit.** Accepted: sampler bank
    handed off at ready and on assignment (`preloadSample` hook), armed
    sampler voices and armed deck starts capped at 250 ms (§7.2.12, §9.1,
    §10.9).
14. **Recording robustness.** Accepted: never delete, keep and reveal;
    async verified copy; `CreateFileW`; write errors finalized and reported;
    unsaved recordings listed and repaired at startup (§14).
15. **Protocol semantics.** Accepted: `ack` covers only arrival-order
    commands and `when` commands are confirmed by `applied`; atomic batches
    with queue reservation; path policy from main, recordings by name only
    (§15.6); `fx.assign` split from `fx.sends` (§3.3, §10.3, §15.3).
16. **Keylock / WSOLA.** Accepted: per-deck quantum phase, 2-grain prime
    with a cost test; the tempo-history ratio is behind a dev A/B switch and
    off by default (parity first) (§9.4, `wsola.h`, `deck.h`).
17. **Portability, sanitizers, references.** Accepted: FTZ/DAZ guarded per
    architecture, `om_device` / `om_device_wasapi` and `om_pcm` /
    `om_shadow_mf` splits with `none/` stand-ins, `OM_PORTABLE_ONLY`,
    `OM_SANITIZE`, and the stale references fixed (rt.h, shadow.h,
    resampler.h, wsola.h, CMakeLists.txt) (§18.2, §18.5). The first
    clang build of the portable set already found a real portability bug
    (limiter.h: a nested struct with member initializers used as a default
    argument), fixed by moving it to namespace scope (`LimiterParams`).

## Appendix D. Host implementation status (2026-10-20)

What the host module delivered against this specification, and what it
measured (Windows 11, this PC, Release `openmix_engine.node` unless said
otherwise; the other modules at their state of that day).

- Core (`src/core`): routing inline / ops / vst-ops / audio, atomic batches
  with queue reservation, contiguous `ack` and `applied`, epochs, lazy FX
  units and chains with preparation generations, the device lifecycle of
  §8.5b (open / phones / close, roles, name + nameIndex, followDefault,
  modes, period override, raw, rate-change re-preparation, routing, loss →
  NULL stand-in → restore of the lost endpoint or a newly arrived match,
  default and format changes, period steps), the stall watchdog with one
  restart then `stalled`, recorder commands and events (write errors, parts
  after a rate change, finalized by `shutdown` and `stop()`), VST jobs (host
  started with the first plugin, owner window from main, base64 states
  passed through, crashed / hung / late (1 per s) / latency events, insert
  latency synced to the deck every block, transport at the insert input),
  the control thread woken by the audio thread, `shutdown`.
- Tests (`om_test_core`, 39 tests, all green with `OM_TEST_STRICT=1` on
  MSVC Debug with the VST3 SDK, `--portable`, clang-cl and AddressSanitizer;
  RT lint clean; no `/W4` warning in host code): the 21 foundation / protocol
  / C API tests, device lifecycle on fakes (4 tests), every protocol command
  with its route, reply, RtCommand values and state (table-driven), recorder
  and VST commands and events, lazy FX memory end to end without allocation
  in the callback, event-queue overflow with the end latch, the retired
  backlog, threaded liveness (heartbeat while the audio is frozen, stall →
  one restart → recovery, `stalled` when the restart does not help, the
  control thread never held by blocking jobs), the silent NULL real-time
  soak, the golden set complete and readable, the engine-host / engine-main
  round trip in Electron (hidden window, never OpenMix), and the PLAY and
  hot-cue latency through the whole engine.
- Numbers:
  - CPU per 128-frame block (2667 µs at 48 kHz), callback time measured by
    the engine, Release: idle 17.8 µs; 4 decks playing 17.7 µs; + keylock on
    all 4 (WSOLA) 27.5 µs; + 4 panel FX (echo, reverb, flanger, pingpong) +
    master phaser + Color reverb 78.0 µs (2.9 % of the block). The Web
    engine's same graphs rendered by Chromium offline (engine.js
    AudioEngine, OfflineAudioContext, pure DSP): 39.9 / 70.1 / 132.5 /
    228.5 µs — the native engine needs 2.2× to 4.8× less CPU. 0 xrun, 0
    allocation or free in the callback.
  - deck.play → first audible frame: 288 frames (6.0 ms: only the limiter's
    look-ahead) plain AND under keylock (the WSOLA prime). Web engine: 30 ms
    scheduling lead + 6 ms, + 55-60 ms under keylock.
  - deck.seek while playing (hot cue) → first output frame where the new
    region dominates: 409 frames (8.5 ms: the limiter's look-ahead + half of
    the deck's 5 ms jump crossfade), plain and under keylock. Web engine:
    the old audio stops at once and the new region starts 30 ms later (+ 6
    ms limiter, + 55-60 ms under keylock).
  - Engine host: fork + load + start + ports 83 ms; `hello` round trip
    0.2-0.3 ms; `clock.ping` 0-0.2 ms; a 65536-frame float32 chunk costs the
    renderer 0.3-0.6 ms to post (structured clone, no transfer list); kill
    2-3 ms; shadow-decode helper process 86-99 ms per job (3 s WAV: offset
    1e-7 ms, RMS difference -130 dB).
  - State cadence: 54/s with evenly paced blocks (≤ 60); heartbeat gaps ≤
    270 ms; control-thread iterations never more than ~35 ms apart, also
    while the ops and vst-ops threads were blocked 1.5 s.
- Not done by the host (other modules, or later): opening a real device
  from a test (the device owner's opt-in smoke; the host never opened a
  sound card), the low-latency output latency figure (needs the device
  module's IAudioClient3 path on the FLX6), the JS proxy and the app
  changes (jsproxy), the DSP parity null tests of the modules (their owners,
  against the goldens).

---

## Appendix E. Verification campaigns of 2026-11-07

Five campaigns verified the engine in parallel on 7 Nov 2026, each owning
its own files, then an integration pass applied their hand-offs the same
evening. Reports: `HANDOFF/refs/native/verify-reports/<key>.json`
(`deck-keylock`, `e2e-proxy`, `sync-phase`, `dsp-parity`, `vst-inline`,
plus `host-module-report.json`, `mixer-module-report.json` and
`integration.json`); backups in `HANDOFF/refs/native/verify-backups/<key>/`.
Everything ran on this PC (Windows 11, i9-14900KF), silent: NULL device or
offline renders, Chromium `OfflineAudioContext` for the references, never
the real app, one real-device smoke at gain 0. The last whole-suite run of
the campaigns (18:31-18:35, strict, goldens, fault plugins, no editor):
8/8 executables, 291 passed, 0 failed, 4 skipped (opt-in only).

### E.1 deck-keylock (§9)

- WSOLA vs the real `pitch-worklet.js`: max abs diff 0 in all 14 golden
  cases (`goldens/deck`, `goldens/wsola`); read pointer vs
  AudioBufferSourceNode: 0 in the 24 cases of `goldens/deck` and
  `goldens/source`; ratio smoother vs Chromium's k-rate AudioParam: 0
  mismatches over 1500 quanta.
- Keylock pitch (440 Hz, tempo 0.92 / 1.00 / 1.08 × key −7..+7, 45
  cases): 41 within 1 cent, 4 at 1.25-1.54 cents (worst 1.537). The error
  is pitch-worklet.js's own (grains aligned on whole input samples): the
  transposer alone gives the same numbers, so the Web engine has it too.
- PLAY → first target sample at frame 0 of the block (deck level); through
  the whole engine 288 frames (6.0 ms, the limiter look-ahead) plain and
  keylock; hot cue → new audio dominant after 409 frames (8.5 ms). Web
  engine: 30 ms lead (+55-60 ms under keylock).
- Fixed: V.BRAKE / BACKSPIN now match Chromium's render of engine.js
  `spinSound` to −133 dBFS or better (was −0.9 dBFS; positions within
  0.02 frame, were 28-433 frames off); backward scratch correlates 1.00000
  with the reversed track at −0.5..−4× with 128 / 480 / 800-frame blocks
  and dropped UI frames (was 0.28-0.92); the plugin transport right after a
  jump: 0 of 720 wrong (was 160 of 240); stems prime 11.7 % of a 128-frame
  period median (was 13.7 %).
- 4-beat loops over 100 wraps: heard-position error ≤ 7.7e-9 frames, wraps
  on the exact frame; end-of-track latch exact in 24 cases; 4 simultaneous
  keylocked primes: median 4.8 % of a period.
- The spin is no longer a difference from the Web engine (no §20 entry);
  `module-reports/module_deck.json`'s "Spin vs Web engine" item is stale.

### E.2 e2e-proxy (§2, §6, §7.4, §17)

- A throwaway Electron harness (real `preload.js`, `engine-main.js`,
  `engine-host.js` in a utilityProcess, the Release `.node`,
  `src/js/native-engine.js` driven as app.js drives it), never OpenMix.
- Host start (fork → ready) 101-121 ms; `createAudioEngine()` → native
  105-127 ms on the NULL device, 272 ms with the real device, 4-5 ms after
  a renderer reload; 6-min track handoff (264 chunks, 131.8 MB) 662-739 ms
  with the longest renderer task 4.5-4.8 ms; kill of the host → Web engine
  playing 110-240 ms with no double audio; hung host → fallback 4.3-4.5 s.
- play → heard 14.4-15.0 ms, hot cue → heard 13.6-17.0 ms (the Web engine
  skips 30 ms of a cue); sync B (124) to A (120) p99 0.01 ms; facade
  playhead vs heard position p99 0.36 ms; a 3 s recording to WAV verified
  (24-bit 48 kHz, 3.003-3.013 s, content checked).
- Real-device smoke (Scarlett 4i4, gain 0): low-latency shared, 44.1 kHz,
  309 frames, 15.4 ms, 0 xruns.
- Fixed in the proxy and the host: the loop playhead flick below
  `loopStart` at every wrap (§17.3); refused requests that never resolved
  and a `full` batch resent wrongly for ever (§6.4, §17.4); a 13-22 ms UI
  task after `pcm.done` (§7.4); a recording left running by a reloaded page
  (§2, §17.6); the VST3 opt-in ignored in native mode (§13.5); REC during a
  fallback. Proxy unit tests 106 / 106.
- Found: `state.decks[i].insert` was never filled; done by the integration
  (§13.2, §15.5). `module-reports/module_host.json`'s "e2e-proxy never ran"
  is superseded by `verify-reports/host-module-report.json`.

### E.3 sync-phase (§12)

- Precision mode (now): end to end p99 0.14-0.28 ms at 75-174 BPM with
  ±0.3 ms grids (worst 0.53 ms over 33 seed runs), 0.73-0.87 ms with ±1 ms
  grids; replay p99 0.46-0.61 ms over 100 seeds; master tempo moves ≤
  0.18 ms; handovers ≤ 0.42 ms with tempo steps ≤ 0.007 %; keylock master
  ramps p99 0.31-0.33 ms on heard positions.
- Parity mode (default): 0 decision mismatches against the real engine.js
  over 17 500 ticks; end to end p99 0.20-1.29 ms (1.10 ms at 90 BPM,
  1.29 ms at 75 BPM; 1.59-1.85 ms with ±1 ms grids); replay p99
  0.94-1.74 ms (equal to engine.js's own replay); handovers up to 4.5 ms.
- With ±2 ms grid noise neither mode stays under 1 ms at ≤ 128 BPM
  (precision 0.98-1.73 ms, parity 1.23-3.12 ms).
- The lock runs entirely in the audio callback: 10 minutes without any
  command, state read or pump give a bit-identical master output.
- CPU: sync tick + 13 clock reads, 4 decks, 0.49-0.54 µs per block
  (Release).
- Fixed in precision mode only: the PI servo, the base-less SYNC deck at a
  handover, the learned residue kept across a handover.
- Observation (no fix): a keylock deck's clicks scatter beat to beat by
  2.7-3.3 ms around its heard position at tempo ≠ 1 (WSOLA grain choice,
  as in pitch-worklet.js), with a tempo-dependent mean (+3.8 ms at 0.97,
  −1.1 ms at 1.039): worth a check of the heard-position lag model under
  ratios ≠ 1 by the deck owner.

### E.4 dsp-parity (§10, §11)

- Native vs Chromium (peak residual): EQ −107.5..−141 dBFS (band error ≤
  1.25e-3 dB); DJ filter sweeps bit-exact; master filter −112 / −113 dBFS;
  limiter −110.9..−400 dBFS, look-ahead 264 / 288 / 576 frames = Chromium's,
  static curve within 1.6e-6 dB, attack 2.917 ms and release 75.1 / 84.1 ms
  to the frame; whole graph through the Mixer API −101.8 / −102.9 dBFS; FX
  sends / returns −138.5 / −120.1 dBFS; Color sends −132.7 / −122.4 dBFS
  (was −27.6); 79 FX / Color null cases at 48 / 65.5 / 44.1 / 96 kHz worst
  −107.2 dBFS (44 bit-exact); stereo delay glides bit-exact (were −0.9 to
  −1.5 dBFS); echo repeats within 0.195 frame of the beat (Chromium: +128
  frames per repeat, §20).
- CPU per FX unit 0.066-10.15 µs per 128 frames (0.38 % max); mixer 5.2-5.4
  µs typical (0.2 %), 38.6 µs mean / 78.1 µs p99 worst case; FX memory
  9.73 MB at start, 181.67 MB with 9 units after every type.
- Fixed: WaveShaper lookup in float, frozen sends (§10.3), Chromium's sine
  tables at 2048 / 16384 points, the per-kernel delay glides (§11.1).
- New references: `goldens/mixer/` (25 cases), `goldens/fx/` +50 cases (94).
- Deliberate: TRANS after the beat lock −68.5 dBFS (continuous lock, §20).

### E.5 vst-inline (§13)

- `om_test_vst` 31 passed, 1 skipped by design; V01, V05, V06, V08, V12,
  V13, V21 satisfied, V14 mostly (no input silence flags, output parameter
  changes not forwarded, `setDirty` not reported), V22 on the engine side
  (the UI still has to show the scan errors).
- SDK again inline: bit-exact, 0 added latency; TDR Kotelnikov: latency 184
  reported = measured at 48 and 44.1 kHz, null −600 dBFS at defaults, mix
  ramps −156.5 dBFS; state round trip bit-identical; 20 load / unload
  cycles flat.
- 4 × Kotelnikov at 128 frames: callback median 0.13 ms, p99 0.27 ms, max
  0.53 ms (deadline 0.933 ms), 0 late blocks of 15 000; 20.5 % of one core
  in all (the plugins ~11.8 %, most of the rest `end()` waiting for the
  workers: a design cost, not a defect).
- G9's hang and crash plugins next to three Kotelnikov decks: 0 wrong
  blocks, slowest callback 0.934 ms (the deadline).
- Core end to end (now `tests/core/test_core_vst_e2e.cpp`): V08 ppq error
  4.5e-13 beats, project samples exact; V05 the output back on the
  no-plugin timeline 21-27 ms after each latency change; V25 a Kotelnikov
  deck is the no-plugin output delayed by exactly 184 frames (3.83 ms)
  after play and after a hot cue (attack kept).
- Fixed: the re-prime after a gap (§13.2), the SDK setup order, the
  parameter queues on `kParamTitlesChanged`, UTF-8 DLL-load errors (§13.5).

### E.6 Integration (evening of 2026-11-07)

Applied: the insert state of the snapshot (`VstHost::insertState()` through
`IVstHost`, filled every block; the proxy's `underruns()` reads it);
`hello {reset}` finalizes a running recording and clears the loop bounds;
`dsp::crushShape` in float; the core end-to-end tests of VST (insert state,
V08, V05, V25) and of the sync (§12); every documentation hand-off of the
five reports (§2, §4.4, §6.4, §7.4, §9.5, §9.6, §10.3, §11.1, §11.7, §12,
§13, §15, §17, §18, §20). Found by the integration's AddressSanitizer run
and fixed: after a write error the recorder showed itself inactive before
its error was published (for the time of the file finalization, so
`recorder_write_error_finalizes_and_reports_once` failed under ASan);
`status().active` and the error are now published together (§14); the
clang-cl build's only warning (an unused helper in
`tests/vst/test_vst_campaign.cpp`) is gone; V21's callback-time check
tolerates one isolated scheduling outlier (one 3.07 ms callback in ~5000
while a game ran; never longer than 3 periods). Not applied: aligning a
late-attached FX unit on
the 128-frame context grid (float-rounding level, about −130 dBFS, and no
reference covers it); the merge note on main.js's `vst-info` (it applies
when `engine-native` is merged, §13.5). Final runs (strict, goldens, fault
plugins, no editor, `--jobs 2`): Debug 8/8 executables, 298 passed, 0
failed, 4 skipped (opt-in only); `--portable` and `--clang-cl` 269 passed,
33 skipped (no SDK, no device API, no Media Foundation), 0 warnings;
`--sanitize address` 273 passed, 29 skipped, no ASan report; proxy unit
tests 107 / 107 with `OM_PROTO_CHECK`; the Release `.node` rebuilt and the
Electron round trip green with it. Per executable and variant:
`integration.json`.

### E.7 Open decisions for David

1. **Sync precision by default** (`sync.precision`): still OFF (engine.js
   parity). The sync-phase campaign recommends ON: 3-5× smaller phase
   errors, the 1 ms target met down to 75 BPM, clean handovers and keylock
   master moves, no measurable CPU, the BPM shown still. Costs: no longer
   the engine.js algorithm (A/B with the Web engine differs slightly), a
   tempo nudge every block (rms 0.004-0.03 %, max 0.07 %, below 0.2 cent),
   a fixed-grid calibration of 14.5 s instead of 6.5 s. If yes:
   `SyncEngine::Impl::precision = true` and §15.3's row.
2. **Keylock fine alignment**: not added. 4 of 45 cases are 1.25-1.54 cents
   off (as in the Web engine). Option: an opt-in A/B (parabolic
   interpolation of the fine correlation peak in `Wsola`, breaking bit
   parity with the worklet) after a listening test.
3. **V25**: a plugin's latency delays the deck after play and hot cues
   (Kotelnikov: 3.83 ms): accept, or decide otherwise.
4. **Scratch feel** on the FLX6: the follower constants (omega 60, coast of
   two UI intervals) need his A/B.

Still not tested anywhere: the real app page and the FLX6, exclusive mode,
a second (phones) card, device loss on hardware, plugin editors and dialog
plugins (V07, V09, V10, V23, V24), real music with the app's beat analysis,
sessions longer than 10 minutes, MP3 / AAC / FLAC sources through the
proxy, packaging, macOS / Linux.

### E.8 Review round of 2026-11-07

Three read-only code reviews of the integrated engine (evening of
2026-11-07: `review-rt-safety.json`, `review-parity.json`,
`review-process-ipc.json`), then one pass that fixed them
(`review-fixes.json`; backup in `verify-backups/review-fixes/`). Every
claim was checked against the code first; all 19 were confirmed (one detail
was wrong: a `when` command can carry an object — a `when` deck.load's
track — so the reset releases it instead of just clearing the list).

- RT safety: the guard page of a stack overflow caught in a plugin's
  `process()` is put back (`_resetstkoflw`) and the worker of a crashed
  slot is retired, never reused (§13.2); the audio, phones and NULL pacer
  threads get TIME_CRITICAL when MMCSS fails (§8.8); a plugin that always
  returns is late, never hung or a suspect — the 50-miss rule is gone, real
  hangs are caught by the 2 s rule (§13.2), and a crash reported by a late
  block still disables the slot; `hello {reset}` drops the scheduled `when`
  commands (§4.6); `stateHz` is atomic; the control thread and the
  recorder's writer run above normal (§3.1); the `--rt-trap` `.node` was
  built and run through the Electron round trip (no `diag rt-alloc`).
- Parity: one sampler voice id per source (§10.9); meter peaks on the
  analyser's mono fold 0.5 × (L + R) (§10.8); the beat clock reaches
  enabled FX units only, like app.js — a re-enabled unit glides from its
  stale beat duration as in the Web engine (chosen over documenting the
  difference: the gate sits in `Mixer::setFxBeatClock`, so no FX golden,
  which drives `FxUnit` directly, is affected) (§11.1); the natural-end
  timestamp survives `deck.load` (engine.js `loadTrack`) and is cleared by
  `hello {reset}`; unknown FX / Color type names never make the engine
  refuse a whole message (§16.3).
- Process / IPC: a device rate change keeps the recording in one file,
  resampled to its rate on the writer thread (§14; chosen over the
  multi-part route: `om::Resampler` streams, runs off the audio thread and
  keeps the set in one file); quit order — queued jobs dropped, ops joined,
  recording finalized, then the VST thread (§6.5); a host no page uses is
  shut down after 15 s (§6.5); newer batches wait behind a `full` one and
  are resent with it as one message (§17.4); a recording is saved by a
  rename on the same drive, copied only across drives through `.part`, and
  an unfinished copy is deleted at quit (§14); the PCM memory limit is 40 %
  of the RAM, its refusal is told to the user in their language (§17.8);
  `engineMain.shutdown()` is exported and the hardening branch's
  `app.exit()` restart paths must await it at merge time (§6.5 merge note;
  the openmix tree itself was not touched).

New tests: core (the dropped `when` commands, the quit order), device
(TIME_CRITICAL fallback and service priority; one recording file across
48 → 44.1 → 48 kHz: 28800 frames, worst error 1.7e-7 on the 48 kHz parts,
1.7e-6 on the resampled one), deck (the natural end kept by a load), mixer
(the beat clock gate; the meter fold), vst (a 1.2 ms plugin at 128 frames
for 2.6 s: 976 blocks late, never hung; a crash reported by a late block),
proxy (sampler ids, type names, ordered resend ×2, PCM memory, i18n keys,
the recording mover ×5) and the Electron round trip (PCM memory limit,
rename / cross-drive save, no `diag rt-alloc`, the idle shutdown: host
gone 409-422 ms after a 400 ms test grace, a reconnect keeps it, the
awaitable `shutdown()`). Found while fixing: a crash reported by a late
block was discarded and the plugin called again (fixed, §13.2). Final runs
(strict, goldens, fault plugins, no editor, `--jobs 2`): Debug 8/8
executables, 305 passed, 0 failed, 4 skipped (opt-in only); `--portable`
and `--clang-cl` 275 passed, 34 skipped; `--sanitize address` 280 passed,
29 skipped, no ASan report; 0 compiler warnings; after one ASan run caught
a too strict timing check of the new slow-plugin test (one block on time
when the test thread was preempted), the check was relaxed and the vst
executable re-run green in every variant. Proxy unit tests 118 / 118 with
`OM_PROTO_CHECK`; `node --check` of main.js, engine-host.js, engine-main.js
and app.js; i18n 603 / 603 keys in fr and en. The Release `.node` was
rebuilt and the Electron round trip passed with it (41 / 41 steps); the
`--rt-trap` module (`--node-out native/engine/build-review-rttrap`) passed
the same round trip with no `diag rt-alloc` / `rt-free` and
`health.rtAllocs` = `rtFrees` = 0 (NULL device). Per executable and
variant: `review-fixes.json`.
