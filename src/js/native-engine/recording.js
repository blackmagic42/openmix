// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §14, §17.9.3):
// the end of a native recording. The engine writes the master to
// <dataDir>/recordings/<name>.wav and NEVER deletes it; this asks main for
// the Save dialog (window.omEngine.saveRecording: async verified copy, the
// original deleted only after the copy is verified). Cancelled or failed:
// the file stays where it is and the caller shows its path with a
// "Show in folder" button (window.omEngine.revealFile). app.js only does the
// UI; this logic is shared and tested.

/** 'YYYY-MM-DD HHhMM' (the default recording name of the engine, §14). */
export function recordingStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

/**
 * Stops the native recording and offers to save it.
 * Resolves with one of:
 *   { kind: 'saved', path, seconds }           copied where the user chose
 *   { kind: 'kept', path, error?, canceled }  still in <dataDir>/recordings (show it, "Show in folder")
 *   { kind: 'error', error }                  nothing recorded
 */
export async function stopAndSaveRecording(engine, om, stamp = recordingStamp()) {
  const r = await engine.stopRecording();
  const path = r && r.path;
  if (!path) return { kind: 'error', error: (r && r.error) || 'no recording' };
  if (!om || typeof om.saveRecording !== 'function') return { kind: 'kept', path, error: r.error || null, canceled: false };
  let s;
  try {
    s = await om.saveRecording(path, `OpenMix ${stamp}.wav`);
  } catch (e) {
    s = { ok: false, error: String((e && e.message) || e) };
  }
  if (s && s.ok) return { kind: 'saved', path: s.path || path, seconds: r.seconds };
  return { kind: 'kept', path, error: (s && s.error) || r.error || null, canceled: !!(s && (s.canceled || s.cancelled || !s.error)) };
}

/** "Show in folder" for a kept recording. */
export function revealRecording(om, path) {
  if (!om || typeof om.revealFile !== 'function' || !path) return Promise.resolve(false);
  return Promise.resolve(om.revealFile(path)).then(() => true, () => false);
}
