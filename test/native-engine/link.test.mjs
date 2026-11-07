// Tests of the command batching (owner: jsproxy, native/engine/SPEC.md §15.1, §17.4): the
// commands of one JS task leave as ONE message, each with seq + at; nothing
// is resent when a knob value did not change; a batch refused with "full" is
// resent whole at the next animation frame; replies resolve by id; a closed
// link resolves every pending request with ok:false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../../src/js/native-engine.js';
import { EngineLink } from '../../src/js/native-engine/link.js';
import { makeEngine, FakeClock } from './helpers.mjs';

test('one JS task = one batch (a JSON array), every command with seq and at', async () => {
  const t = await makeEngine(NativeEngine);
  const before = t.host.batches.length;
  const d = t.engine.decks[0];
  d.setVolume(0.5);
  d.setEq('mid', 0.3);
  t.engine.setCrossfader(0.1);
  await t.clock.advance(1);
  assert.equal(t.host.batches.length - before, 1);
  const batch = JSON.parse(t.host.batches.at(-1));
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch.map((c) => c.cmd), ['deck.volume', 'deck.eq', 'xf.set']);
  assert.ok(batch.every((c) => Number.isInteger(c.seq) && typeof c.at === 'number'));
  assert.ok(batch[1].seq === batch[0].seq + 1 && batch[2].seq === batch[1].seq + 1, 'monotonic');
  assert.ok(Math.abs(batch[0].at - t.engine.engineNow()) < 0.01, 'at = engineNow()');
});

test('app.js re-applies knobs often: unchanged values are not sent again', async () => {
  const t = await makeEngine(NativeEngine);
  const n0 = t.host.commands.length;
  for (let k = 0; k < 10; k++) {
    t.engine.decks[1].setTrim(0.2);
    t.engine.setMasterVolume(0.8);
    t.engine.decks[1].setKey(1);
  }
  await t.clock.advance(1);
  assert.deepEqual(t.host.commands.slice(n0).map((c) => c.cmd), ['deck.trim', 'master.volume', 'deck.key']);
});

test('a batch refused with "full" is resent whole, unchanged, at the next frame', async () => {
  const t = await makeEngine(NativeEngine);
  t.engine.decks[0].setVolume(0.33);
  t.engine.decks[0].setTrim(-0.5);
  await t.clock.advance(1);
  const text = t.host.batches.at(-1);
  t.host.emit({ ev: 'error', error: 'full', cmd: text });
  await t.clock.advance(1);
  const count = t.host.batches.filter((b) => b === text).length;
  t.engine.syncLock();
  await t.clock.advance(1);
  assert.equal(t.host.batches.filter((b) => b === text).length, count + (count === 2 ? 0 : 1));
  assert.equal(t.host.batches.filter((b) => b === text).length, 2, 'sent twice in all');
});

test('"full" in the engine host\'s real format (first cmd name, ids, seq) resends the refused batch, not the latest one', async () => {
  // Found end to end (e2e-proxy): engine-host.js sends `cmd` = the first command's NAME
  // (SPEC.md §6.4, §15.4), so matching the batch text never hit; the seq does.
  const t = await makeEngine(NativeEngine);
  t.engine.decks[0].setVolume(0.31);
  t.engine.decks[0].setTrim(-0.4);
  await t.clock.advance(1);
  const refused = t.host.batches.at(-1);
  const first = JSON.parse(refused)[0];
  t.engine.setCrossfader(0.2);
  await t.clock.advance(1);
  const later = t.host.batches.at(-1);
  t.host.emit({ ev: 'error', error: 'full', cmd: first.cmd, ids: [], batch: true, seq: first.seq });
  await t.clock.advance(30);
  assert.equal(t.host.batches.filter((b) => b === refused).length, 2, 'the refused batch is resent');
  assert.equal(t.host.batches.filter((b) => b === later).length, 1, 'the later batch is not');
});

test('a batch that never fits (larger than the engine queue) is not resent forever: dropped after MAX_FULL_RESENDS', async () => {
  // e2e-proxy: the round-trip test shows a 9000-command batch is refused "full"; it was resent at every frame forever
  const { MAX_FULL_RESENDS } = await import('../../src/js/native-engine/link.js');
  const t = await makeEngine(NativeEngine);
  const p = t.engine._link.request({ cmd: 'rec.status' });
  t.engine.decks[0].setVolume(0.2);
  await t.clock.advance(1);
  const text = t.host.batches.at(-1);
  const first = JSON.parse(text)[0];
  for (let k = 0; k < MAX_FULL_RESENDS + 5; k++) {
    t.host.emit({ ev: 'error', error: 'full', cmd: first.cmd, ids: [first.id], batch: true, seq: first.seq });
    await t.clock.advance(25);
  }
  // (messages led by that batch: a resend also carries the batches held behind it, e.g. clock pings)
  const leadSeq = (b) => { const v = JSON.parse(b); return (Array.isArray(v) ? v[0] : v).seq; };
  const sent = t.host.batches.filter((b) => leadSeq(b) === first.seq).length;
  assert.equal(sent, MAX_FULL_RESENDS + 1, 'sent once + resent MAX_FULL_RESENDS times, then dropped');
  assert.equal(t.engine._link.stats.dropped, 1);
  const r = await p;
  assert.equal(r.ok === false || r.ok === true, true, 'its request resolved');
});

test('a message refused as invalid: its requests resolve {ok:false} at once (no reply will ever come)', async () => {
  // Found end to end (e2e-proxy): a refused vst.load / rec.start / deck.load stayed pending forever.
  const t = await makeEngine(NativeEngine);
  t.host.silent = true;              // the real engine refuses the whole message atomically: no reply at all
  const pa = t.engine._link.request({ cmd: 'rec.status' });
  const pb = t.engine._link.request({ cmd: 'deck.tempo', deck: 0, r: 'fast' });
  await t.clock.advance(1);
  t.host.silent = false;
  const batch = JSON.parse(t.engine._link.recent.at(-1).text);
  const ids = batch.filter((c) => c.id != null).map((c) => c.id);
  assert.equal(ids.length, 2);
  t.host.emit({ ev: 'error', error: 'deck.tempo: "r" must be a finite number', cmd: 'rec.status', ids, batch: true, seq: batch[0].seq });
  await t.clock.advance(1);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra.ok, false);
  assert.equal(rb.ok, false);
  assert.match(rb.error, /finite number/);
  assert.equal(t.engine.status, 'native', 'a refused message is not a reason to fall back');
});

test('replies resolve by id; closing resolves pending requests with ok:false', async () => {
  const clock = new FakeClock();
  const posted = [];
  const ctl = { onmessage: null, postMessage: (m) => posted.push(m), start() {}, close() {} };
  const pcm = { onmessage: null, postMessage() {}, start() {}, close() {} };
  const events = [];
  const link = new EngineLink({ env: { queueMicrotask: (f) => queueMicrotask(f), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: console },
    ctl, pcm, engineNow: () => 5, onEvent: (e) => events.push(e), onPcm() {} });
  const p1 = link.request({ cmd: 'rec.list' });
  const p2 = link.request({ cmd: 'vst.load', deck: 0, path: 'x' });
  await Promise.resolve();
  await Promise.resolve();
  const [c1, c2] = JSON.parse(posted[0]);
  assert.ok(c1.id !== c2.id);
  link.onReply({ ev: 'reply', id: c2.id, ok: true, name: 'P' });
  assert.equal((await p2).name, 'P');
  link.close('engine gone');
  assert.deepEqual(await p1, { ok: false, error: 'engine gone' });
  assert.equal(link.send({ cmd: 'deck.play', deck: 0 }), 0, 'nothing sent once closed');
  const r3 = await link.request({ cmd: 'rec.stop' });
  assert.equal(r3.ok, false);
});

test('a non-finite number never reaches the engine (it would make it refuse the whole batch)', async () => {
  const t = await makeEngine(NativeEngine);
  const n0 = t.host.commands.length;
  const d = t.engine.decks[0];
  d.setVolume(0.4);
  t.engine.setDeckColor(0, NaN);
  t.engine.setCrossfader(0.6);
  await t.clock.advance(1);
  assert.deepEqual(t.host.commands.slice(n0).map((c) => c.cmd), ['deck.volume', 'xf.set'], 'the others still go');
  assert.ok(t.log.lines.some((l) => /deck\.color dropped/.test(l)));
});

test('a batch refused "full" holds every newer batch behind it: resent together, in seq order, as one message (review round, process / IPC #4)', async () => {
  // A smaller later batch could fit where the refused one did not and reach
  // the audio thread first (a play applied to the old track, then the resent
  // load resets the deck): newer batches now wait behind the refused one.
  const t = await makeEngine(NativeEngine);
  const cmds = (text) => {
    const v = JSON.parse(text);
    return (Array.isArray(v) ? v : [v]).filter((c) => c.cmd !== 'clock.ping');
  };
  t.engine.decks[0].setVolume(0.21);
  t.engine.decks[0].setTrim(-0.2);
  await t.clock.advance(1);
  const refused = cmds(t.host.batches.at(-1));
  t.host.emit({ ev: 'error', error: 'full', cmd: refused[0].cmd, ids: [], batch: true, seq: refused[0].seq });
  await t.clock.advance(1);
  const n0 = t.host.batches.length;
  t.engine.setCrossfader(0.33);          // smaller: would fit where the refused batch did not
  await t.clock.advance(1);
  t.engine.decks[1].setVolume(0.44);
  await t.clock.advance(1);
  assert.equal(t.host.batches.length, n0, 'nothing leaves before the refused batch');
  assert.ok(t.engine._link.stats.held >= 2);
  await t.clock.advance(25);             // the resend timer
  assert.equal(t.host.batches.length, n0 + 1, 'ONE message: applied or refused as a whole');
  const resend = cmds(t.host.batches.at(-1));
  assert.deepEqual(resend.map((c) => c.cmd), ['deck.volume', 'deck.trim', 'xf.set', 'deck.volume']);
  assert.deepEqual(resend.slice(0, 2).map((c) => c.seq), refused.map((c) => c.seq));
  assert.ok(resend.every((c, i) => i === 0 || c.seq > resend[i - 1].seq), 'seq order');
  // refused again: the same batches (and the one held meanwhile) go again, still in order
  t.host.emit({ ev: 'error', error: 'full', cmd: 'deck.volume', ids: [], batch: true, seq: refused[0].seq });
  t.engine.decks[2].setVolume(0.55);
  await t.clock.advance(25);
  const again = cmds(t.host.batches.at(-1));
  assert.deepEqual(again.map((c) => c.cmd), ['deck.volume', 'deck.trim', 'xf.set', 'deck.volume', 'deck.volume']);
  // no refusal within the confirmation time: accepted, new batches flow directly again
  await t.clock.advance(30);
  const n1 = t.host.batches.length;
  t.engine.setMasterVolume(0.66);
  await t.clock.advance(1);
  assert.equal(t.host.batches.length, n1 + 1);
  assert.deepEqual(cmds(t.host.batches.at(-1)).map((c) => c.cmd), ['master.volume']);
  assert.equal(t.engine._link.resendQueue.length, 0);
});

test('the resend joins at most RESEND_CHUNK_COMMANDS commands; the rest follows once the first part is accepted', async () => {
  const { RESEND_CHUNK_COMMANDS } = await import('../../src/js/native-engine/link.js');
  const t = await makeEngine(NativeEngine);
  t.engine.decks[0].setVolume(0.12);
  await t.clock.advance(1);
  const first = JSON.parse(t.host.batches.at(-1));
  const head = Array.isArray(first) ? first[0] : first;
  t.host.emit({ ev: 'error', error: 'full', cmd: head.cmd, ids: [], batch: true, seq: head.seq });
  await t.clock.advance(1);
  // one large held batch (> the chunk limit together with the head)
  for (let i = 0; i < RESEND_CHUNK_COMMANDS; i++) t.engine._link.send({ cmd: 'deck.volume', deck: 1, v: (i % 100) / 100 });
  await t.clock.advance(1);
  const n0 = t.host.batches.length;
  await t.clock.advance(25);
  assert.equal(t.host.batches.length, n0 + 1);
  const part1 = JSON.parse(t.host.batches.at(-1));
  assert.equal(Array.isArray(part1) ? part1[0].seq : part1.seq, head.seq, 'the refused batch alone first');
  await t.clock.advance(30);             // accepted: the held batch leaves
  const part2 = JSON.parse(t.host.batches.at(-1));
  assert.ok(Array.isArray(part2) && part2.length >= RESEND_CHUNK_COMMANDS, 'then the held one');
  assert.ok(part2[0].seq > (Array.isArray(part1) ? part1.at(-1).seq : part1.seq));
});
