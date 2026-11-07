// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §8.1, §17.5):
// maps Chromium's audio output ids (what app.js stores and passes to
// setSinkId / setPhonesDevice) to the engine's device descriptors.
//
// Chromium lists two pseudo-devices first: "default" ("Default - X") and
// "communications" ("Communications - X"); they become a ROLE that follows
// the Windows default. Every other id is hashed per origin, so the engine
// cannot use it: it becomes {name: label, nameIndex}, nameIndex = rank among
// the endpoints with the same label in Chromium's list (identical cards stay
// distinct). Labels are empty until the page has the media permission (the
// Settings panel asks for it), so the descriptor is stored next to
// localStorage.audioOutput when it is known, and the stored one is used at
// startup when labels are still empty.

export const MASTER_DEVICE_KEY = 'audioOutputDevice';
export const PHONES_DEVICE_KEY = 'phonesOutputDevice';

const PREFIXES = [/^Default\s*-\s*/i, /^Communications\s*-\s*/i];

/** "Default - Speakers (Realtek)" -> "Speakers (Realtek)". */
export function stripDevicePrefix(label) {
  let s = String(label || '');
  for (const re of PREFIXES) s = s.replace(re, '');
  return s.trim();
}

const isPseudo = (id) => id === 'default' || id === 'communications';

/**
 * Descriptor of Chromium output `id` for the engine:
 *   '' / 'default'  -> { id, role: 'console', followDefault: true }
 *   'communications'-> { id, role: 'communications', followDefault: true }
 *   other           -> { id, name, nameIndex } from `devices` (enumerateDevices()),
 *                      or from `stored` when the labels are empty,
 *                      or null when the id cannot be named.
 */
export function describeOutputDevice(id, devices, stored) {
  id = id || '';
  if (!id || id === 'default') return { id, role: 'console', followDefault: true };
  if (id === 'communications') return { id, role: 'communications', followDefault: true };
  const outs = (devices || []).filter((d) => d && d.kind === 'audiooutput' && !isPseudo(d.deviceId));
  const dev = outs.find((d) => d.deviceId === id);
  if (dev && dev.label) {
    const name = stripDevicePrefix(dev.label);
    let nameIndex = 0;
    for (const d of outs) {
      if (d.deviceId === id) break;
      if (stripDevicePrefix(d.label) === name) nameIndex++;
    }
    return { id, name, nameIndex };
  }
  if (stored && stored.id === id && stored.name) {
    return { id, name: stored.name, nameIndex: stored.nameIndex | 0 };
  }
  return null;
}

/** The fields of a device.open / device.phones command for a descriptor. */
export function deviceFields(desc) {
  if (!desc) return { role: 'console', followDefault: true };
  if (desc.role) return { role: desc.role, followDefault: true };
  return { name: desc.name, nameIndex: desc.nameIndex | 0 };
}

/** Same device? (pseudo ids by role, others by id). */
export function sameDevice(a, b) {
  return (a || '') === (b || '') || (!a && b === 'default') || (a === 'default' && !b);
}
