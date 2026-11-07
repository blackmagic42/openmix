// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Tiny event emitter (DESIGN §5.7). Each listener receives one `detail`
// object. Listener exceptions never propagate: they go to the error sink
// (options.onError of the engine), so a faulty UI callback can never break
// the engine or its tick.

export class Emitter {
  /** @param {readonly string[]} types the event types this object emits */
  constructor(types) {
    this._eventTypes = new Set(types);
    this._listeners = new Map();
  }

  /**
   * Subscribes to an event.
   * @param {string} type event type
   * @param {(detail: object) => void} listener
   * @returns {() => void} a function that unsubscribes the listener
   */
  on(type, listener) {
    return this._add(type, listener, false);
  }

  /**
   * Subscribes to the next emission of an event only.
   * @param {string} type event type
   * @param {(detail: object) => void} listener
   * @returns {() => void} a function that unsubscribes the listener
   */
  once(type, listener) {
    return this._add(type, listener, true);
  }

  /**
   * Unsubscribes a listener added with on() or once().
   * @param {string} type event type
   * @param {(detail: object) => void} listener
   */
  off(type, listener) {
    const list = this._listeners.get(type);
    if (!list) return;
    const kept = list.filter((e) => e.fn !== listener);
    if (kept.length) this._listeners.set(type, kept);
    else this._listeners.delete(type);
  }

  _add(type, listener, once) {
    if (!this._eventTypes.has(type)) throw new RangeError(`Unknown event type: ${String(type)}`);
    if (typeof listener !== 'function') throw new TypeError('The listener must be a function');
    const list = this._listeners.get(type) || [];
    if (!list.some((e) => e.fn === listener && e.once === once)) list.push({ fn: listener, once });
    this._listeners.set(type, list);
    return () => this.off(type, listener);
  }

  // Synchronous emission, AFTER the state has changed (callers' duty).
  _emit(type, detail) {
    const list = this._listeners.get(type);
    if (!list || !list.length) return;
    for (const e of list.slice()) {
      if (e.once) this._removeEntry(type, e);
      try {
        e.fn(detail);
      } catch (err) {
        this._listenerError(err);
      }
    }
  }

  _removeEntry(type, entry) {
    const list = this._listeners.get(type);
    if (!list) return;
    const kept = list.filter((e) => e !== entry);
    if (kept.length) this._listeners.set(type, kept);
    else this._listeners.delete(type);
  }

  // Overridden by Engine / Deck to route to options.onError
  _listenerError(err) {
    try { globalThis.console.error(err); } catch { /* no console */ }
  }
}
