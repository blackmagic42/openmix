// Gamepad control (Gamepad API, "standard" mapping) — PS and Xbox.
// MULTIPLAYER: each gamepad has ITS OWN cursor on the KNOB MATRIX
// (columns = decks, top row = MASTER). The player's deck = their column.
//
// Per gamepad:
//  Dpad           : knob matrix · below FILTER = NAVIGATION mode
//                   (▲▼ selection, ◀▶ tabs, ▲ at the top of the list = back)
// 16 Logo (middle): kill / restore the hovered knob (LOW = EXCLUSIVE bass)
//  0 Cross/A      : Play/Pause · in navigation: open / LOAD AND PLAY
//  1 Circle/B     : resets the hovered knob TO NEUTRAL (nav: back) ·
//                   LONG press = CUT selection
//  3 Triangle/Y   : grouped CUT of the selected decks (all cut / all back)
//  2 Square/X     : short = FX length (1/2·3/4·1·2) · HELD = effect list
//                   shown + the effect scrolls step by step
// 10 L3           : global FILTER ON/OFF (COLOR)
// 11 R3           : track FX ON/OFF (master row = all)
//  9 Options/Menu : BEAT SYNC ON/OFF for the column's deck
//  4/5 L1/R1      : track VOLUME − / + (master row: master knob)
//  6/7 L2/R2      : press the PADS framed L2/R2 (left / right half,
//                   the row picks the pair, CUE/JUMP/LOOP mode)
//  8 Share/View   : short press = L2/R2 mode (CUE→JUMP→LOOP), long = help
//  Left stick     : ▲▼ = hovered knob · ◀▶ (held ½ s) = jog PITCH BEND
//                   (moves the track slightly forward/back to beatmatch by ear)
//  Right stick    : ▲▼ = FX LEVEL · ◀▶ (held ½ s) = waveform ZOOM

import { t } from './i18n.js';

const DEADZONE = 0.18;

export class GamepadManager {
  constructor(actions) {
    this.actions = actions;
    this.pads = new Map(); // gamepad.index -> player state
  }

  detectType(id) {
    const s = (id || '').toLowerCase();
    if (s.includes('dualshock') || s.includes('dualsense') || s.includes('054c') ||
        s.includes('sony') || s.includes('wireless controller')) {
      return 'ps';
    }
    return 'xbox';
  }

  get connected() {
    return this.pads.size > 0;
  }

  get type() {
    const first = this.pads.values().next().value;
    return first ? first.type : 'xbox';
  }

  padsInfo() {
    return [...this.pads.entries()].map(([gi, st]) => ({
      player: gi + 1,
      deck: st.deck,
      type: st.type,
      name: st.name
    }));
  }

  buttonLabel(idx) {
    const ps = { 0: t('gamepad_btn_cross'), 1: t('gamepad_btn_circle'), 2: t('gamepad_btn_square'), 3: 'Triangle', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Share', 9: 'Options', 10: 'L3', 11: 'R3', 16: t('gamepad_btn_ps') };
    const xb = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'L3', 11: 'R3', 16: t('gamepad_btn_xbox') };
    return (this.type === 'ps' ? ps : xb)[idx] || `B${idx}`;
  }

  _wrapDeck(d) {
    const n = this.actions.deckCount ? this.actions.deckCount() : 4;
    return ((d % n) + n) % n;
  }

  _nextFreeDeck() {
    const used = new Set([...this.pads.values()].map(s => s.deck));
    const n = this.actions.deckCount ? this.actions.deckCount() : 4;
    for (let d = 0; d < n; d++) {
      if (!used.has(d)) return d;
    }
    return 0;
  }

  poll(dt, now) {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const seen = new Set();
    let changed = false;

    for (const gp of list) {
      if (!gp || !gp.connected) continue;
      seen.add(gp.index);
      let st = this.pads.get(gp.index);
      if (!st) {
        const deck = this._nextFreeDeck();
        st = {
          prev: [],
          repeat: {},
          hold: {},     // stick angle locks (0.5 s)
          navSel: null, // library selection SPECIFIC to this player
          mode: 'jump', // L2/R2 mode SPECIFIC to this player (JUMP/LOOP/CUE/KEY)
          player: gp.index + 1,
          deck,
          type: this.detectType(gp.id),
          name: gp.id,
          cur: { r: 1, c: deck } // starts on its deck's TRIM (knob matrix)
        };
        this.pads.set(gp.index, st);
        changed = true;
      }
      this._pollPad(gp, st, dt, now);
    }

    for (const idx of [...this.pads.keys()]) {
      if (!seen.has(idx)) {
        this.pads.delete(idx);
        changed = true;
      }
    }
    if (changed) this.actions.onConnection(this);
  }

  _pollPad(gp, st, dt, now) {
    const pressed = gp.buttons.map(b => b.pressed);
    const was = (i) => !!st.prev[i];
    const edge = (i) => pressed[i] && !was(i);

    // --- Dpad: knob matrix + NAVIGATION zone below FILTER ---
    // Row 0 = master (2 cells), rows 1..5 = knobs (1 column per
    // deck), NAV row (below FILTER) = library: ▲▼ = selection
    // (▲ at the very top of the list = back to the matrix), ◀▶ = tabs.
    const rows = this.actions.gridRows ? this.actions.gridRows() : 6;
    const NAV = rows; // virtual navigation row
    const clampCur = () => {
      if (st.cur.r >= NAV) return;
      // FX column (right of the knobs): no clamp, the deck does not change
      if (st.cur.c === 4) return;
      const n = this.actions.deckCount ? this.actions.deckCount() : 4;
      if (st.cur.c >= n) st.cur.c = n - 1;
      // the player's deck = their column (also on the SELECT row)
      st.deck = st.cur.c;
    };
    const inNav = () => st.cur.r >= NAV;
    this._withRepeat(st, 12, pressed[12], now, () => {
      if (inNav()) {
        if ((st.navSel || 0) <= 0) {
          st.cur.r = rows - 1; // top of the list → back to the matrix
          st.navSel = null;
          clampCur();
        } else {
          this.actions.navMove(st, -1);
        }
      } else if (st.cur.r > 0) {
        st.cur.r -= 1;
        clampCur();
      }
    });
    this._withRepeat(st, 13, pressed[13], now, () => {
      if (inNav()) {
        this.actions.navMove(st, 1);
      } else {
        st.cur.r += 1; // below FILTER → navigation mode
        if (inNav() && st.navSel == null && this.actions.navSelIndex) {
          st.navSel = this.actions.navSelIndex();
        }
        clampCur();
      }
    });
    // ◀▶: VISUAL movement — the next column on screen (club order
    // 3 1 2 4 then FX), identical on ALL rows (SELECT included)
    const stepCol = (dir) => {
      const ord = this.actions.visualOrder ? this.actions.visualOrder() : [0, 1, 2, 3];
      let pos = ord.indexOf(st.cur.c);
      if (pos < 0) pos = 0;
      st.cur.c = ord[(pos + ord.length + dir) % ord.length];
      clampCur();
    };
    this._withRepeat(st, 14, pressed[14], now, () => {
      if (inNav()) { this.actions.navTab(st, -1); return; }
      stepCol(-1);
    });
    this._withRepeat(st, 15, pressed[15], now, () => {
      if (inNav()) { this.actions.navTab(st, 1); return; }
      stepCol(1);
    });
    const D = st.deck;
    const nav = inNav();

    // --- Xbox/PS button (logo, 16): kill / restore the hovered knob.
    // On LOW: the bass moves to this deck (exclusive). Elsewhere:
    // simple remove / put back. (The Windows Game Bar is disabled.)
    if (edge(16) && !nav) this.actions.killKnob(st.cur, st.player - 1);
    // --- Cross/A: Play/Pause — in navigation: opens the playlist or
    // LOADS AND PLAYS the track (press again = pause) ---
    if (edge(0)) (nav ? this.actions.navEnter(st, D) : this.actions.padPrimary(st, D));
    // --- Circle/B: RESETS THE HOVERED KNOB TO NEUTRAL (instant — filter
    // effect then an abrupt return to zero) · in navigation: BACK · long
    // press = select the column for the CUT ---
    // the reset fires on a short RELEASE: a long press (CUT selection) must
    // no longer trigger the filter+FX reset along the way
    if (edge(1)) st.bT = now;
    if (pressed[1] && st.bT != null && now - st.bT >= 500) {
      this.actions.selectToggle(D, st.player - 1);
      st.bT = null;
    }
    if (!pressed[1] && was(1) && st.bT != null) {
      if (nav) this.actions.navBack(st);
      else this.actions.resetKnob(st.cur, D, st.player - 1);
      st.bT = null;
    }
    // --- Triangle/Y: grouped CUT (instant) ---
    if (edge(3)) this.actions.cutToggle(D);
    // --- L3: global FILTER ON/OFF · R3: track FX ON/OFF ---
    if (edge(10)) this.actions.colorToggle();
    if (edge(11)) this.actions.fxToggle(st);
    // --- Menu/Options (right of the logo): deck BEAT SYNC ON/OFF ---
    if (edge(9)) this.actions.syncToggle(D);

    // --- Square/X: short = FX length (1/2·3/4·1·2) · HELD = the effect
    // list shows up and the effect scrolls step by step while held ---
    if (edge(2)) {
      st.sqT = now;
      st.sqHeld = false;
    }
    if (pressed[2] && st.sqT != null && now - st.sqT >= 550) {
      this.actions.fxTypeList(st, st.sqHeld ? 'next' : 'show');
      st.sqT = now; // next step every 550 ms while held
      st.sqHeld = true;
    }
    if (!pressed[2] && was(2)) {
      if (st.sqHeld) this.actions.fxTypeList(st, 'hide');
      else if (st.sqT != null) this.actions.fxBeatsCycle(st);
      st.sqT = null;
      st.sqHeld = false;
    }

    // --- Share/View: short press = L2/R2 mode (CUE→JUMP→LOOP), long = help ---
    if (edge(8)) st.shareT = now;
    if (pressed[8] && st.shareT != null && now - st.shareT >= 600) {
      this.actions.toggleHelp();
      st.shareT = null;
    }
    if (!pressed[8] && was(8) && st.shareT != null) {
      this.actions.cycleMode(st);
      st.shareT = null;
    }

    // --- R1: in SELECTION mode = ↺ mix RESET (filters 0, FX off,
    // deselection) — otherwise VOLUME + · L1: VOLUME − ---
    if (edge(5) && this.actions.hasSelection && this.actions.hasSelection(st.player - 1)) {
      this.actions.selReset(D, st.cur);
      st.r1Used = true; // holding it must not raise the volume afterwards
    }
    if (!pressed[5]) st.r1Used = false;
    if (pressed[5] && !st.r1Used) this.actions.volumeHold(st.cur, 1, dt);
    if (pressed[4]) this.actions.volumeHold(st.cur, -1, dt);

    // --- L2 / R2: CUE / JUMP / LOOP depending on the mode — L goes back, R forward,
    // the row sets the strength (TRIM = 16 → FILTER = 1) ---
    // Press = action · HELD 1 s on a set cue = clear it
    if (edge(7)) { this.actions.sideAction(st, 1); st.r2T = now; st.r2Down = true; }
    if (pressed[7] && st.r2T != null && now - st.r2T >= 1000) {
      this.actions.sideHold(st, 1);
      st.r2T = null;
    }
    if (!pressed[7]) {
      st.r2T = null;
      if (st.r2Down) {
        st.r2Down = false;
        // trigger RELEASE: held PAD FX stop here
        if (this.actions.sideRelease) this.actions.sideRelease(st, 1);
      }
    }
    if (edge(6)) { this.actions.sideAction(st, -1); st.l2T = now; st.l2Down = true; }
    if (pressed[6] && st.l2T != null && now - st.l2T >= 1000) {
      this.actions.sideHold(st, -1);
      st.l2T = null;
    }
    if (!pressed[6]) {
      st.l2T = null;
      if (st.l2Down) {
        st.l2Down = false;
        if (this.actions.sideRelease) this.actions.sideRelease(st, -1);
      }
    }

    // --- LEFT stick: ◀▶ = CDJ-style jog PITCH BEND, IMMEDIATE
    // (beatmatch by ear — release = back to tempo), ▲▼ = hovered knob ---
    const lx = gp.axes[0] || 0;
    const ly = gp.axes[1] || 0;
    const lxHold = this._angleHold(st, 'lx', lx, ly, now);
    if (!nav && lxHold !== 0) {
      this.actions.jogNudge(st.cur, lxHold, dt);
      st.lxBend = true;
    } else if (st.lxBend) {
      this.actions.jogRelease();
      st.lxBend = false;
    }
    if (!nav && Math.abs(ly) > DEADZONE && Math.abs(ly) > Math.abs(lx)) {
      const v = (Math.abs(ly) - DEADZONE) / (1 - DEADZONE) * Math.sign(ly);
      this.actions.stickAdjust(st, -v, dt);
    }

    // --- RIGHT stick: ▲▼ = track FX LEVEL (up = raise,
    // master = all) · ◀▶ = waveform ZOOM IN / OUT, immediate ---
    const rx = gp.axes[2] || 0;
    const ry = gp.axes[3] || 0;
    if (Math.abs(ry) > DEADZONE && Math.abs(ry) > Math.abs(rx)) {
      const v = (Math.abs(ry) - DEADZONE) / (1 - DEADZONE) * Math.sign(ry);
      this.actions.fxLevel(st, -v, dt);
    }
    const rxHold = this._angleHold(st, 'rx', rx, ry, now);
    if (rxHold !== 0) this.actions.zoomWaves(rxHold, dt);

    st.prev = pressed;
  }

  // Angle lock: returns a horizontal value ONLY if the stick is pushed
  // clearly left/right (the X axis clearly dominates). IMMEDIATE
  // RESPONSE — no more ½ s wait: the jog must respond under the finger.
  _angleHold(st, key, x, y) {
    const mag = Math.abs(x);
    if (mag <= DEADZONE || mag <= Math.abs(y) * 1.6) return 0;
    return ((mag - DEADZONE) / (1 - DEADZONE)) * (x > 0 ? 1 : -1);
  }

  _withRepeat(st, idx, isPressed, now, fn) {
    if (isPressed && !st.prev[idx]) {
      fn();
      st.repeat[idx] = now + 350;
    } else if (isPressed && now >= (st.repeat[idx] || 0)) {
      fn();
      st.repeat[idx] = now + 90;
    }
  }
}
