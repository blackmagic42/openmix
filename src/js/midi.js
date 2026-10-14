// MIDI controllers (Pioneer DDJ and any USB-MIDI deck).
// No driver to install: DJ controllers are standard MIDI devices,
// received through Chromium's Web MIDI API.
//
// - Built-in Pioneer DDJ preset (detected from the device name)
// - MIDI learn: any physical button/fader/knob can be bound to any
//   action, saved PER controller (device name).

import { t } from './i18n.js';

export const ABS_ACTIONS = new Set([
  'volume', 'trim', 'eqHigh', 'eqMid', 'eqLow', 'filter', 'tempo',
  'crossfader', 'masterVol', 'masterFilter', 'fxLevel'
]);
export const REL_ACTIONS = new Set(['jog', 'jogBend', 'browse', 'browseZoom']);

// [action, label] entry whose label is read through i18n on every access,
// so the MIDI-learn table follows a live language change
function actionEntry(action, key, vars) {
  const entry = [action, ''];
  Object.defineProperty(entry, 1, { get: () => t(key, vars), enumerable: true });
  return entry;
}

export const MIDI_ACTIONS_DECK = [
  ['play', 'Play / Pause'],
  actionEntry('cue', 'midi_action_cue'),
  ['sync', 'SYNC'],
  ['master', 'MASTER'],
  actionEntry('grid', 'midi_action_grid'),
  actionEntry('load', 'midi_action_load'),
  actionEntry('volume', 'midi_action_volume'),
  ['trim', 'TRIM'],
  actionEntry('eqHigh', 'midi_action_eq_high'),
  actionEntry('eqMid', 'midi_action_eq_mid'),
  actionEntry('eqLow', 'midi_action_eq_low'),
  ['filter', 'FILTER (color)'],
  actionEntry('tempo', 'midi_action_tempo'),
  actionEntry('jog', 'midi_action_jog'),
  actionEntry('jogBend', 'midi_action_jog_bend'),
  actionEntry('jogTouch', 'midi_action_jog_touch'),
  actionEntry('padHotcue', 'midi_action_pad_mode', { mode: 'HOT CUE' }),
  actionEntry('padJump', 'midi_action_pad_mode', { mode: 'BEAT JUMP' }),
  actionEntry('padLoop', 'midi_action_pad_mode', { mode: 'LOOP' }),
  actionEntry('padKey', 'midi_action_pad_mode', { mode: 'KEY' }),
  actionEntry('padFx', 'midi_action_pad_mode', { mode: 'PAD FX' }),
  actionEntry('padSmp', 'midi_action_pad_mode', { mode: 'SAMPLER' }),
  ['pad1', 'Pad 1'], ['pad2', 'Pad 2'], ['pad3', 'Pad 3'], ['pad4', 'Pad 4'],
  ['pad5', 'Pad 5'], ['pad6', 'Pad 6'], ['pad7', 'Pad 7'], ['pad8', 'Pad 8'],
  actionEntry('loopIn', 'midi_action_loop_in'),
  actionEntry('loopOut', 'midi_action_loop_out'),
  ['reloop', 'RELOOP / EXIT'],
  actionEntry('fxOn', 'midi_action_fx_on'),
  actionEntry('keyUp', 'midi_action_key_up'),
  actionEntry('keyDn', 'midi_action_key_dn'),
  actionEntry('select', 'midi_action_select')
];

export const MIDI_ACTIONS_GLOBAL = [
  ['crossfader', 'Crossfader'],
  actionEntry('browse', 'midi_action_browse'),
  actionEntry('browsePush', 'midi_action_browse_push'),
  actionEntry('browseBack', 'midi_action_browse_back'),
  actionEntry('viewToggle', 'midi_action_view_toggle'),
  actionEntry('masterVol', 'midi_action_master_vol'),
  actionEntry('masterFilter', 'midi_action_master_filter'),
  actionEntry('fxLevel', 'midi_action_fx_level'),
  actionEntry('fxBeatsDn', 'midi_action_fx_beats_dn'),
  actionEntry('fxBeatsUp', 'midi_action_fx_beats_up'),
  actionEntry('selectMaster', 'midi_action_select_master'),
  actionEntry('bpmUp', 'midi_action_bpm_up'),
  actionEntry('bpmDn', 'midi_action_bpm_dn')
];

export class MidiManager {
  constructor(actions) {
    this.actions = actions; // { press(action, deck, on), abs(action, deck, v01), rel(action, deck, delta) }
    this.access = null;
    this.deviceName = null;
    this.output = null;    // first output port (compat)
    this.outputs = [];     // ALL outputs: the deck's LEDs and VU meters
    this._outNames = '';
    this.feedback = false; // OUTPUT DISABLED: the FLX6 echoed our LEDs back as ghost presses
    this._kaTimer = null;  // Pioneer keep-alive (removed — see send())
    this._monCount = 0;    // monitor rate limiter (the keep-alive makes the deck reply)
    this._monStamp = 0;
    this.map = {};
    this.learning = null;
    this.monitor = false;
    this.monitorAll = false; // production: no log per gesture
    this.onStatus = () => {};
    this._ledState = new Map(); // last state sent (only changes are emitted)
    this._vuState = new Map();
  }

  // --- FEEDBACK TO THE DECK — DISABLED (this.feedback = false) ---
  // The FLX6 ECHOES BACK the notes we send it: every "LED" we emitted
  // came back as a GHOST PRESS (channel select jumping to deck 1,
  // play/loops triggering on their own — "you broke the software").
  // Until we have the proprietary rekordbox protocol, we SEND NOTHING
  // to the deck. Only re-enable with an anti-echo filter AND the
  // validated protocol.
  _sendRaw(bytes) {
    if (!this.outputs || !this.outputs.length) return;
    // ANY output (keep-alive, LED, VU meter) can trigger a state
    // RE-DECLARATION from the deck: the suppression window is opened on
    // every send (real gestures, being continuous, go through the activity
    // exemption; isolated artifacts are swallowed)
    this._kaSentAt = performance.now();
    for (const o of this.outputs) {
      try {
        o.send(bytes);
      } catch (e) {
        if (!this._sendErrLogged) {
          this._sendErrLogged = true;
          console.log(`[midi] send FAILED to ${o.name}: ${String(e)}`);
        }
      }
    }
  }

  send(bytes) {
    if (!this.feedback) return;
    this._sendRaw(bytes);
  }

  // --- ANTI-ECHO: the FLX6 may send back as input the notes we emit to
  // it (history: LED → ghost presses, "channel select jumping").
  // Every emitted triplet is remembered for 250 ms; if it comes back
  // identical within that delay, it is OUR echo → swallowed before any processing.
  _pushEcho(bytes) {
    if (!this._echoQ) this._echoQ = [];
    this._echoQ.push({ k: `${bytes[0]},${bytes[1]},${bytes[2] || 0}`, t: performance.now() });
    if (this._echoQ.length > 128) this._echoQ.shift();
  }

  _isEcho(status, d1, d2, ts) {
    if (!this._echoQ || !this._echoQ.length) return false;
    // ARRIVAL TIME of the message, not the time we process it: during a
    // load (decoding, analysis), the software processes MIDI messages
    // late — the echo of the SYNC / MASTER LED then exceeded the
    // 25 ms and passed for a PRESS (sync switching itself off when the
    // master moves to another deck or when a track loads)
    const pnow = performance.now();
    // (timestamp outside the performance.now() time base: fall back to
    // the processing time, the old behavior)
    const now = ts > pnow - 1000 && ts <= pnow + 5 ? ts : pnow;
    // A USB echo comes back within A FEW milliseconds: 25 ms window,
    // same note (velocity ignored — the echo may be re-encoded). The old
    // 250 ms window on an identical triplet SWALLOWED REAL re-presses:
    // the play LED (note 11, vel 127) armed the trap and the next press —
    // same note, same velocity — was taken for an echo ("a delay before
    // I can press again"). 25 ms = unbeatable for a human, plenty for
    // USB.
    while (this._echoQ.length && now - this._echoQ[0].t > 25) this._echoQ.shift();
    const kShort = `${status},${d1},`;
    for (let i = 0; i < this._echoQ.length; i++) {
      // (an echo cannot arrive BEFORE it was sent)
      if (this._echoQ[i].k.startsWith(kShort) && this._echoQ[i].t <= now + 1) {
        this._echoQ.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Button LED (protocol captured on the device:
  // we send THE BUTTON'S NOTE back on the output, velocity 127 = on, 0 =
  // off). Direct output protected by the anti-echo above — this is
  // THE official LED path, the feedback flag no longer blocks it.
  setLed(ch, note, on) {
    const k = `${ch}:${note}`;
    const v = on ? 1 : 0;
    if (this._ledState.get(k) === v) return;
    this._ledState.set(k, v);
    const bytes = [0x90 | ch, note, on ? 0x7f : 0];
    this._pushEcho(bytes);
    this._sendRaw(bytes);
  }

  // CC-driven LED: some FLX6 lamps are NOT notes —
  // e.g. the FX section illumination = CC 16 on channels 4/5 (captured live,
  // "0xB4/0xB5 0x10, Off=0x00 On=0x7F"). Same cache as setLed.
  setLedCC(ch, cc, on) {
    const k = `cc${ch}:${cc}`;
    const v = on ? 1 : 0;
    if (this._ledState.get(k) === v) return;
    this._ledState.set(k, v);
    this._sendRaw([0xB0 | ch, cc, on ? 0x7f : 0]);
  }

  // Channel VU meter (Pioneer DDJ: CC 2 on the deck's channel, 0-127).
  // The ONLY feedback allowed to the deck: a CC (not a note), and incoming
  // CC2 is mapped to NO action — even if the deck echoed it,
  // zero ghost presses possible (unlike button LEDs).
  setVu(ch, v01) {
    // HEAVILY throttled (200 ms minimum per channel): EVERY output makes
    // the deck re-declare its state — when sent continuously, it saturated
    // and LOST button presses (silent CUE, lost releases)
    const nowV = performance.now();
    if (!this._vuAt) this._vuAt = new Map();
    if (nowV - (this._vuAt.get(ch) || 0) < 200) return;
    const v = Math.max(0, Math.min(127, Math.round(v01 * 127)));
    const prev = this._vuState.get(ch);
    if (prev != null && Math.abs(prev - v) < 6 && v !== 0 && v !== 127) return;
    this._vuAt.set(ch, nowV);
    this._vuState.set(ch, v);
    this._sendRaw([0xB0 | ch, 2, v]);
  }

  async init() {
    if (!navigator.requestMIDIAccess) return false;
    try {
      // SysEx requested: some decks (recent Pioneers) only drive
      // their LEDs after a vendor wake-up frame
      this.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch {
        return false;
      }
    }
    console.log(`[midi] sysex access: ${this.access.sysexEnabled ? 'YES' : 'NO (the Pioneer keep-alive cannot be sent)'}`);
    const hook = () => {
      let first = null;
      for (const input of this.access.inputs.values()) {
        if (!first) first = input;
        // (ARRIVAL time of the message: the anti-echo compares it with the
        // send time — see _isEcho)
        input.onmidimessage = (e) => this._onMsg(e.data, e.timeStamp);
      }
      // OUTPUT ports: LEDs and VU meters go to ALL outputs
      // (some decks expose several ports — no more guessing)
      const outs = [...this.access.outputs.values()];
      const names = outs.map((o) => o.name).join(' | ');
      if (names !== this._outNames) {
        this._outNames = names;
        this.outputs = outs;
        this.output = outs[0] || null;
        this._ledState.clear();
        this._vuState.clear();
        if (outs.length) console.log(`[midi] outputs: ${names}`);
        // EXPLICIT open: on Windows a port held by another app fails
        // silently — this way it shows up in the log
        outs.forEach((o) => {
          o.open().then(() => {
            console.log(`[midi] output OPENED: ${o.name} (state=${o.state}, connection=${o.connection})`);
          }).catch((e) => {
            console.log(`[midi] output REFUSED: ${o.name} — ${String(e)}`);
          });
        });
        // PERIODIC KEEP-ALIVE (500 ms) — ESSENTIAL: with no host talking to
        // it, the FLX6 disables some controls, including THE CROSSFADER
        // (proven: dead on the wire when listening passively, alive under rekordbox).
        // The old chaos ("the app re-applies everything twice a second") is solved by the
        // SUPPRESSION WINDOW in _onMsg: for the 80 ms following each
        // send, incoming absolute CCs (= the RE-DECLARATION of positions)
        // are ignored; real gestures, being continuous, get through between pulses.
        clearInterval(this._kaTimer);
        if (outs.length) {
          const KA = [0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xF7];
          this._kaSentAt = performance.now();
          this._sendRaw(KA);
          this._kaTimer = setInterval(() => {
            this._kaSentAt = performance.now();
            this._sendRaw(KA);
          }, 500);
        }
      }
      const name = first ? first.name : null;
      if (name !== this.deviceName) {
        this.deviceName = name;
        if (name) {
          console.log(`[midi] device: ${name}`);
          this._loadMap();
        }
      }
      this.onStatus(name);
    };
    this.access.onstatechange = hook;
    hook();
    return true;
  }

  _key(type, ch, d1) {
    return `${type}:${ch}:${d1}`;
  }

  _loadMap() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(`midiMap:${this.deviceName}`));
    } catch { /* no saved mapping */ }
    const isPioneer = /ddj|pioneer/i.test(this.deviceName || '');
    if (saved && saved.__v === MidiManager.PRESET_V) {
      this.map = saved.map || {};
    } else {
      // Fresh preset (or outdated version): start again from the current preset —
      // bindings re-learned via ⚙ then overwrite whatever they need
      this.map = isPioneer ? MidiManager.ddjPreset() : {};
      this._saveMap();
    }
  }

  _saveMap() {
    if (this.deviceName) {
      localStorage.setItem(`midiMap:${this.deviceName}`,
        JSON.stringify({ __v: MidiManager.PRESET_V, map: this.map }));
    }
  }

  // Learn: the next physical action (press / movement) is captured
  learn(action, deck) {
    this.cancelLearn();
    return new Promise((resolve) => {
      this.learning = { action, deck, resolve };
    });
  }

  cancelLearn() {
    if (this.learning) {
      this.learning.resolve(null);
      this.learning = null;
    }
  }

  bindingFor(action, deck) {
    for (const [k, v] of Object.entries(this.map)) {
      if (v.action === action && v.deck === deck) return k;
    }
    return null;
  }

  clearBinding(action, deck) {
    for (const k of Object.keys(this.map)) {
      if (this.map[k].action === action && this.map[k].deck === deck) delete this.map[k];
    }
    this._saveMap();
  }

  _onMsg(data, ts) {
    const [status, d1, d2 = 0] = data;
    if (!this._tsChecked && ts) {
      this._tsChecked = true;
      console.log(`[midi] timestamp: message processed ${(performance.now() - ts).toFixed(1)} ms after its arrival`);
    }
    const type = status & 0xF0;
    const ch = status & 0x0F;
    if (type !== 0x90 && type !== 0x80 && type !== 0xB0 && type !== 0xE0) return;
    // Echo of an LED we just sent: swallowed BEFORE any processing.
    // (diagnostic reminder: every renderer trace must start with [midi] —
    // main.js filters out the rest)
    if ((type === 0x90 || type === 0x80) && this._isEcho(status, d1, d2, ts)) return;
    // Temporary FULL CAPTURE (right jog diagnostic): EVERYTHING is logged,
    // mapped or not, capped at 8 lines/s
    if (this.monitorAll) {
      const nowS = Math.floor(Date.now() / 1000);
      if (nowS !== this._monStamp) {
        this._monStamp = nowS;
        this._monCount = 0;
      }
      if (this._monCount < 40) { // calibration: temporary high fidelity
        this._monCount += 1;
        console.log(`[midi] ALL: type=0x${type.toString(16)} ch=${ch} d1=${d1} d2=${d2}`);
      }
    }
    // Pitch bend (0xE0): d1/d2 = 14-bit value — the "note" is fixed (0)
    const normType = type === 0x80 ? 0x90 : type; // note-off = released note-on
    const key = type === 0xE0 ? this._key(0xE0, ch, 0) : this._key(normType, ch, d1);

    if (this.learning) {
      // Capture presses and movements, not releases
      if (type === 0x80 || (type === 0x90 && d2 === 0)) return;
      // Remove this action's old binding, then save the new one
      for (const k of Object.keys(this.map)) {
        if (this.map[k].action === this.learning.action && this.map[k].deck === this.learning.deck) {
          delete this.map[k];
        }
      }
      this.map[key] = { action: this.learning.action, deck: this.learning.deck };
      this._saveMap();
      this.learning.resolve(key);
      this.learning = null;
      return;
    }

    const b = this.map[key];
    // MONITOR: now logs ONLY UNMAPPED controls (logging every
    // gesture went through the IPC pipe and made the audio stutter)
    if (!b) {
      if (this.monitor && !(type === 0x90 && d2 === 0) && !(type === 0x80)) {
        // limited to 8 logs/s: the deck answers the keep-alive with bursts
        const nowS = Math.floor(Date.now() / 1000);
        if (nowS !== this._monStamp) {
          this._monStamp = nowS;
          this._monCount = 0;
        }
        if (this._monCount < 8) {
          this._monCount += 1;
          console.log(`[midi] unmapped: type=0x${type.toString(16)} ch=${ch} d1=${d1} d2=${d2}`);
        }
      }
      return;
    }
    if (type === 0xE0) {
      // 14-bit pitch bend → absolute 0..1 (tempo faders, some filters)
      if (ABS_ACTIONS.has(b.action)) {
        this.actions.abs(b.action, b.deck, (d2 * 128 + d1) / 16383);
      }
      return;
    }
    if (type === 0xB0) {
      if (ABS_ACTIONS.has(b.action)) {
        // SMART SUPPRESSION WINDOW: within the 80 ms following
        // a keep-alive, the deck RE-DECLARES its positions (state
        // refresh) — these CCs are dropped ONLY if the control was IDLE.
        // A real gesture is a continuous stream (< 300 ms between messages): it
        // gets through ENTIRELY. The old blind window swallowed ~16% of
        // movements → "sometimes it doesn't detect the volume/fader".
        const nowP = performance.now();
        if (!this._absLast) this._absLast = new Map();
        const lastP = this._absLast.get(key);
        this._absLast.set(key, nowP);
        if (this._kaSentAt && nowP - this._kaSentAt < 80
            && !(lastP !== undefined && nowP - lastP < 300)) return;
        this.actions.abs(b.action, b.deck, d2 / 127);
      } else if (REL_ACTIONS.has(b.action)) {
        // Same shield as for ABS: a state re-declaration may
        // contain off-center JOG TICKS — since the top surface
        // MOVES the position, every artifact caused a micro-seek
        // ("a tiny offset every time"). A real gesture is a continuous
        // stream: it gets through entirely.
        const nowR = performance.now();
        if (!this._absLast) this._absLast = new Map();
        const lastR = this._absLast.get(key);
        this._absLast.set(key, nowR);
        if (this._kaSentAt && nowR - this._kaSentAt < 80
            && !(lastR !== undefined && nowR - lastR < 300)) return;
        // TWO relative encodings exist: Pioneer JOGS are centered
        // on 64 (65 = +1 gentle, 63 = −1), browse encoders use
        // two's complement (1 = +1, 127 = −1). Mixing them up reversed
        // the direction AND destroyed the precision of the gesture.
        let delta = b.action.startsWith('jog')
          ? d2 - 64
          : (d2 < 64 ? d2 : d2 - 128);
        // NO PER-CC WEIGHTING. The top surface sends CC34 in VINYL mode and
        // CC35 without vinyl: doubling CC35 made the platter that was in
        // that mode TWICE as twitchy as the other — the infamous
        // left/right asymmetry. One tick is one tick, on both sides.
        // DO NOT REINTRODUCE a factor here.
        this.actions.rel(b.action, b.deck, delta, d1);
      } else if (d2 > 0) {
        this.actions.press(b.action, b.deck, true);
      } else {
        this.actions.press(b.action, b.deck, false);
      }
    } else {
      this.actions.press(b.action, b.deck, type === 0x90 && d2 > 0);
    }
  }

  // Preset version: bumping it regenerates the devices' mapping
  static PRESET_V = 45;

  // Pioneer DDJ 4-CHANNEL base — captured LIVE on David's DDJ-FLX6:
  // channels 0-3 = decks 1-4 (transport, EQ, volume, tempo), channel 6 = mixer
  // (FILTERS CC 23-26, crossfader, browse), channel 4 = FX section
  static ddjPreset() {
    const m = {};
    for (let d = 0; d < 4; d++) {
      // FINAL TABLE (verified by DOUBLE inversion live with David):
      // PLAY = note 11, CUE = note 14. The old "real PLAY = 14" was
      // WRONG — and since 11 AND 14 both pointed to play, play
      // worked by accident and CUE started the track. NEVER again
      // map 11 and 14 to the same action: the mistake becomes invisible.
      m[`144:${d}:11`] = { action: 'play', deck: d };
      m[`144:${d}:14`] = { action: 'cue', deck: d };
      m[`144:${d}:12`] = { action: 'cue', deck: d };
      m[`144:${d}:88`] = { action: 'sync', deck: d };
      m[`144:${d}:16`] = { action: 'loopIn', deck: d };
      m[`144:${d}:17`] = { action: 'loopOut', deck: d };
      m[`144:${d}:77`] = { action: 'reloop', deck: d };
      // Dedicated loop ÷2 / ×2 buttons (captured: notes 81 / 83)
      m[`144:${d}:81`] = { action: 'loopHalf', deck: d };
      m[`144:${d}:83`] = { action: 'loopDouble', deck: d };
      // Channel HEADPHONE CUE (spec 3-8: note 84, LED on the same note)
      m[`144:${d}:84`] = { action: 'cuePfl', deck: d };
      m[`176:${d}:0`] = { action: 'tempo', deck: d };
      m[`176:${d}:19`] = { action: 'volume', deck: d };
      m[`176:${d}:4`] = { action: 'trim', deck: d };
      m[`176:${d}:7`] = { action: 'eqHigh', deck: d };
      m[`176:${d}:11`] = { action: 'eqMid', deck: d };
      m[`176:${d}:15`] = { action: 'eqLow', deck: d };
      // Jog — FINAL DOCTRINE: CCs 33/34/35 (dialects vary from one jog
      // to the other, and a single grab can emit SEVERAL of them) ALL go
      // to 'jog'; the TOUCH SENSOR (note 54) decides:
      // hand on = pure SCRATCH (the tempo is never touched), hand not
      // on (side) = light nudge. Values centered on 64: > 64 = forward.
      // SIDE (CC33) = micro-nudge by ear (gentle bend, does not move
      // the position); TOP (CC34/35) = 'jog': touch on → scratch, without
      // touch → MOVE through the track (never a BPM change —
      // "instead of moving you change the BPM": fixed here)
      m[`176:${d}:33`] = { action: 'jogBend', deck: d };
      m[`176:${d}:34`] = { action: 'jog', deck: d };
      m[`176:${d}:35`] = { action: 'jog', deck: d };
      m[`144:${d}:54`] = { action: 'jogTouch', deck: d };
      // FILTERS (CFX): on MIXER CHANNEL 6, CC 23 to 26 (captured on the FLX6)
      m[`176:6:${23 + d}`] = { action: 'filter', deck: d };
    }
    // Captured live on the device: each jog is
    // per DECK CHANNEL — CC34 = top in vinyl mode, CC35 = top without vinyl,
    // CC33 = side, note 54 = touch. Nothing else to route.
    // FX sections (channel 4 = left, channel 5 = right): ON + level —
    // note 71 on BOTH channels is indeed the FX button (confirmed by David)
    for (const fc of [4, 5]) {
      // The FX button sends THE NOTE OF THE FX SELECT selector's POSITION:
      // 71/72/73 = positions 1/2/3 (channel 4 = FX1, channel 5 = FX2). The
      // deck code encodes the slot (0-5) so the app remembers the LAMP's
      // address and toggles the effect whatever the position.
      m[`144:${fc}:71`] = { action: 'fxSlot', deck: (fc - 4) * 3 };
      m[`144:${fc}:72`] = { action: 'fxSlot', deck: (fc - 4) * 3 + 1 };
      m[`144:${fc}:73`] = { action: 'fxSlot', deck: (fc - 4) * 3 + 2 };
      // FX level: the big MERGE FX knob sends a 14-bit PAIR —
      // CC2 = value (128 steps, plenty) and CC34 = fine fraction
      // that cycles like a SAWTOOTH (77→1→28…). Map ONLY CC2:
      // mapping CC34 (alone or in addition) makes the gauge jump by 60%.
      m[`176:${fc}:2`] = { action: 'fxLevel', deck: null };
      // BEAT ◄ / ► (captured on the FLX6: notes 6 and 7): FX length ÷2 / ×2
      m[`144:${fc}:6`] = { action: 'fxBeatsDn', deck: null };
      m[`144:${fc}:7`] = { action: 'fxBeatsUp', deck: null };
      // SHIFT+BEAT ◄ / ► (hardware layer captured: notes 102 / 107):
      // PREVIOUS / NEXT effect in the list
      m[`144:${fc}:102`] = { action: 'fxPrev', deck: null };
      m[`144:${fc}:107`] = { action: 'fxNext', deck: null };
    }
    // CHANNEL SELECT (captured on the FLX6): one button per section (left = channel 4,
    // right = channel 5), same notes — the deck sends a DIFFERENT note
    // per position. The HARDWARE CYCLE SKIPS: 1 → 2 → 4 → MASTER → 3 → 1…
    // (per David: "from master I go back to 3"). Notes in
    // press order: 28, 29, 31, 20, 30 — anchored on position 1 = 28.
    for (const sc of [4, 5]) {
      m[`144:${sc}:28`] = { action: 'select', deck: 0 };       // position 1
      m[`144:${sc}:29`] = { action: 'select', deck: 1 };       // position 2
      m[`144:${sc}:31`] = { action: 'select', deck: 3 };       // position 4
      m[`144:${sc}:20`] = { action: 'selectMaster', deck: null }; // MASTER
      m[`144:${sc}:30`] = { action: 'select', deck: 2 };       // position 3
    }
    // Performance pads — channels captured live on the device:
    // deck 1 = channel 7, deck 2 = 9, deck 3 = 11, deck 4 = 13; the following
    // EVEN channels (8/10/12/14) are the SAME pads with SHIFT. The old
    // [7,9,8,10] routed SHIFT+pad of decks 1/2 to decks 3/4!
    // The NOTE depends on the hardware MODE: HOT CUE 0-7, PAD FX 16-23,
    // BEAT JUMP 32-39, SAMPLER 48-55, BEAT LOOP 96-103 — all routed
    // to pad1-8: the mode button (below) aligns the deck's tab,
    // which decides the action. SHIFT+pad = clear (hot cue / sample).
    const padCh = [7, 9, 11, 13];
    const padBase = [0, 16, 32, 48, 96];
    for (let d = 0; d < 4; d++) {
      for (let p = 0; p < 8; p++) {
        for (const base of padBase) {
          m[`144:${padCh[d]}:${base + p}`] = { action: `pad${p + 1}`, deck: d };
          m[`144:${padCh[d] + 1}:${base + p}`] = { action: `padDel${p + 1}`, deck: d };
        }
      }
      // Pad MODE buttons (on the deck channel, captured live):
      // they switch the deck's on-screen tab — HOT CUE 27, PAD FX1 30,
      // PAD FX2 107, BEAT JUMP 32, SAMPLER 34, BEAT LOOP 109,
      // KEYBOARD 105 and KEY SHIFT 111 → KEY tab
      // SHIFT (captured live: note 63 on the deck channel) — the state
      // is tracked app-side (browse ×10, CUE = back to start, SYNC OFF…);
      // pads and mode buttons already have their own hardware SHIFT layer
      m[`144:${d}:63`] = { action: 'shift', deck: d };
      // SHIFT+CUE (hardware layer, captured: note 72) = back to start
      m[`144:${d}:72`] = { action: 'cueBack', deck: d };
      // SHIFT+PLAY (hardware layer, spec: note 71 on the deck channel)
      // = RE-ALIGN THE GRID on the current position
      m[`144:${d}:71`] = { action: 'grid', deck: d };
      // Dedicated MASTER BUTTON (captured: note 92) = become master — its LED
      // lights up on the same note. (SHIFT+BEAT SYNC sends 93: same action)
      m[`144:${d}:92`] = { action: 'master', deck: d };
      m[`144:${d}:93`] = { action: 'master', deck: d };
      m[`144:${d}:27`] = { action: 'padHotcue', deck: d };
      m[`144:${d}:30`] = { action: 'padFx', deck: d };
      m[`144:${d}:107`] = { action: 'padFx', deck: d };
      m[`144:${d}:32`] = { action: 'padJump', deck: d };
      m[`144:${d}:34`] = { action: 'padSmp', deck: d };
      m[`144:${d}:109`] = { action: 'padLoop', deck: d };
      m[`144:${d}:105`] = { action: 'padKey', deck: d };
      m[`144:${d}:111`] = { action: 'padKey', deck: d };
    }
    // LOAD (channel 6, notes 70-73)
    for (let d = 0; d < 4; d++) {
      m[`144:6:${70 + d}`] = { action: 'load', deck: d };
    }
    // CC 8 ch6 = MASTER KNOB (verified by David: mapped to the crossfader it
    // moved the crossfader from the master knob). MASTER VOLUME:
    m['176:6:8'] = { action: 'masterVol', deck: null };
    // CROSSFADER = CC 31 ch6 (LSB 63 ignored) — ORIGINAL mapping, as in the
    // git repo version where it worked. FINAL UNDERSTANDING: on jog
    // touches, the deck RE-DECLARES the fader's real PHYSICAL position
    // (state refresh) — if the on-screen one was moved with the mouse, it "jumps"
    // to the hardware truth: normal behavior for a physical fader,
    // NOT interference. NEVER filter/hold/remap this control.
    m['176:6:31'] = { action: 'crossfader', deck: null };
    m['176:6:64'] = { action: 'browse', deck: null };
    // SHIFT + wheel (captured live: the deck switches to CC 100):
    // waveform zoom in / out
    m['176:6:100'] = { action: 'browseZoom', deck: null };
    // Library encoder (captured on the FLX6): PUSH = enter/load (note 65),
    // BACK button = leave the playlist (note 101)
    m['144:6:65'] = { action: 'browsePush', deck: null };
    m['144:6:101'] = { action: 'browseBack', deck: null };
    m['144:6:122'] = { action: 'viewToggle', deck: null };
    // (no MIDI masterVol: the FLX6's MASTER knob is analog)
    return m;
  }
}
