// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §16.3):
// NativeFxUnit, the engine.js `FxUnit` surface app.js uses (panel units fx0..fx3,
// pad units pad0..pad3, the master unit). Type / enabled / level / beats are
// mirrored here and sent as `fx.set`; the beat duration is computed by the
// engine every block (§12), so setBeatDur() only stores the value. After a
// fallback every member forwards to the engine.js FxUnit.

import { clamp } from './env.js';

// The FX and Color type names the engine knows (native/engine/include/om/
// common.h kFxNames / kColorNames). One unknown name in a message makes the
// engine refuse the WHOLE message (every command of that JS task), while
// engine.js accepts anything: an unknown FX type plays its default chain
// (echo), an unknown Color type routes no bus. A session stored by another
// build may hold such a name (app.js restoreSession).
export const FX_TYPES = new Set(['delay', 'echo', 'spiral', 'mtdelay', 'upecho', 'downecho', 'lowcut', 'pingpong',
  'reverb', 'flanger', 'phaser', 'pan', 'trans', 'filter', 'roll', 'robot', 'helix', 'crush']);
export const COLOR_TYPES = new Set(['filter', 'dubecho', 'hpfecho', 'lpfecho', 'bpfecho', 'crushecho', 'reverb', 'noise', 'crush']);

/** The FX type to send: an unknown name is sent as 'echo' (engine.js FxUnit._chain() default). */
export function engineFxType(t) {
  return FX_TYPES.has(t) ? t : 'echo';
}

export class NativeFxUnit {
  constructor(engine, unit) {
    this._e = engine;
    this.unit = unit;            // 'fx0'..'fx3', 'pad0'..'pad3', 'master'
    this._web = null;            // engine.js FxUnit after a fallback
    this._type = 'echo';
    this._enabled = false;
    this._level = 0;             // FX always start at the minimum (engine.js)
    this._beatsMult = 0.5;
    this._beatDur = 0.5;
  }

  get type() { return this._web ? this._web.type : this._type; }
  get enabled() { return this._web ? this._web.enabled : this._enabled; }
  get level() { return this._web ? this._web.level : this._level; }
  get beatsMult() { return this._web ? this._web.beatsMult : this._beatsMult; }
  get beatDur() { return this._web ? this._web.beatDur : this._beatDur; }

  _set(field, value) {
    return this._e._sendState(`fx.${this.unit}.${field}`, { cmd: 'fx.set', unit: this.unit, [field]: value }, value);
  }

  setType(t) {
    if (this._web) return this._web.setType(t);
    this._type = t;                    // the mirror keeps the name, like engine.js FxUnit.type
    this._set('type', engineFxType(t));
  }

  setEnabled(b) {
    if (this._web) return this._web.setEnabled(b);
    this._enabled = !!b;
    this._set('enabled', this._enabled);
  }

  setLevel(v) {
    if (this._web) return this._web.setLevel(v);
    this._level = clamp(v, 0, 1);
    this._set('level', this._level);
  }

  setBeatsMult(m) {
    if (this._web) return this._web.setBeatsMult(m);
    this._beatsMult = m;
    if (m > 0) this._set('beats', m);
  }

  /** The engine follows the reference deck's beat itself (§12): stored only. */
  setBeatDur(sec) {
    if (this._web) return this._web.setBeatDur(sec);
    if (!(sec > 0) || Math.abs(sec - this._beatDur) < this._beatDur * 0.0005) return;
    this._beatDur = sec;
  }

  modPeriodBeats() {
    if (this._web) return this._web.modPeriodBeats();
    const m = this._beatsMult;
    switch (this._type) {
      case 'trans': return m;
      case 'flanger': return 8 * m;
      case 'phaser': return 4 * m;
      case 'pan': case 'filter': return 2 * m;
      default: return null;
    }
  }

  /** The fields of an fx.set that re-applies this unit (resync, fallback). */
  _snapshot() {
    return { type: engineFxType(this._type), enabled: this._enabled, level: this._level, beats: this._beatsMult };
  }
}
