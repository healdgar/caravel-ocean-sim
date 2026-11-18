// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What JavaScript keeps and sends for a town's people, with a device that only records what it is asked. What the
// GPU makes of it is in townsfolk-shots-gpu (the pass alone) and townsfolk-gpu, townsfolk-under-fire-gpu (the game).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTownsfolk, townsfolkBodiesFor } from '../js/townsfolk.js';
import { TOWN_FATE_WORDS, TOWNSFOLK_COUNT_WORDS, TOWNSFOLK_DISPATCH_WORDS, TOWNSFOLK_MODELS, TOWNSFOLK_WALK } from '../js/wgsl/townsfolk.js';
import { CREW_CONTINUUM_ASSETS } from '../js/crew-continuum.js';
import { CONTINUUM_LISTS, CONTINUUM_VIEW_LISTS } from '../js/continuum-format.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import { WALKER_WORDS } from '../js/town-streets.js';
import { crewContinuumBaked, crewContinuumDevice, crewContinuumGlobals, fetchCrewContinuumAsset } from './helpers/crew-continuum-fixture.mjs';

// A town's people are drawn through the continuum alone, from its baked bodies; where they are not baked here, only
// the load's failure can be tested.
const baked = crewContinuumBaked(townsfolkBodiesFor());
const unbaked = !baked && 'continuum bodies not baked here';

// A device that makes nothing and remembers everything.
function recorder() {
  const buffers = [], writes = [], draws = [], dispatches = [];
  const device = crewContinuumDevice({
    createBuffer(d) { const b = { ...d, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
    queue: {
      writeBuffer(b, offset, data) {
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        writes.push({ label: b.label, words: new Uint32Array(bytes.slice(0, bytes.byteLength & ~3).buffer) });
      },
    },
    createRenderPipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => ({ ...d }),
  });
  const pass = () => {
    const state = {};
    return {
      setPipeline(p) { state.pipeline = p.label; }, setBindGroup(i, g) { if (i === 0) state.group = g; }, setVertexBuffer(slot, b) { state.list = b; },
      setIndexBuffer(b) { state.index = b; }, dispatchWorkgroups(x) { dispatches.push({ pipeline: state.pipeline, workgroups: x }); },
      dispatchWorkgroupsIndirect(b, offset) { dispatches.push({ pipeline: state.pipeline, counted: b.label, offset }); },
      drawIndirect(b, offset) { draws.push({ pipeline: state.pipeline, group: state.group, list: state.list, buffer: b, offset }); },
      drawIndexed(...args) { draws.push({ pipeline: state.pipeline, indexed: args }); },
      drawIndexedIndirect(b, offset) { draws.push({ pipeline: state.pipeline, indexed: true, buffer: b, offset }); },
    };
  };
  return { device, buffers, writes, draws, dispatches, pass, live: (label) => buffers.filter((b) => b.label === label && !b.destroyed) };
}
const town = (name, people, x, more = {}) => ({
  name, center: { x, z: 0 }, ...more,
  streets: { people, walkers: new Uint32Array(people * WALKER_WORDS), samples: new Float32Array(64), window: { x, z: 0, span: 400 } },
});
const made = (gpu, fetchAsset) => createTownsfolk({
  device: gpu.device, frameUBO: {}, shader: async (code, label) => ({ code, label }),
  shared: { captainTexView: {}, captainSampler: {} },
  shadows: { bind: () => ({}), uniform: {} },
  fetchAsset,
});
async function crowdOf(t, fetchAsset = fetchCrewContinuumAsset) {
  crewContinuumGlobals(t);
  const gpu = recorder();
  const folk = await made(gpu, fetchAsset);
  // The nearest town is looked for once in a while, so a visit is as many calls as that takes.
  const visit = (ports, x) => { for (let i = 0; i < 45; i++) folk.follow(ports, { x, z: 0 }); };
  return { ...gpu, folk, visit };
}
const HOUR = 3600000;
const hoursSent = (writes) => writes.filter((w) => w.label === 'townsfolk crowd').map((w) => new Float32Array(w.words.buffer)[26]);

test('a town whose bodies are not baked fails to load, naming every missing file and how to bake it', async (t) => {
  crewContinuumGlobals(t);
  const gpu = recorder();
  const absent = await made(gpu, async () => new Response(null, { status: 404 })).then(() => null, (error) => error);
  assert.ok(absent instanceof Error, 'no town without its bodies: nothing stands in for them');
  // A body is its manifest, its light mesh, its atlas and the picture this device reads: those are what it names.
  const wanted = townsfolkBodiesFor().flatMap((id) => ['manifest.json', 'body.glb', 'atlas.bin.gz', 'albedo.bc7.bin.gz'].map((name) => CREW_CONTINUUM_ASSETS[id][name]));
  assert.deepEqual(absent.missing, wanted);
  for (const file of wanted) assert.ok(absent.message.includes(file), `the message names ${file}`);
  assert.match(absent.message, /node scripts\/prepare-crew-continuum\.mjs --only=<body>/, 'and says how to bake them');
  assert.deepEqual(gpu.draws, []);
  assert.equal(gpu.buffers.filter((b) => /old/.test(b.label ?? '')).length, 0, 'and no old body is uploaded');
});

test('the fallen are remembered for the last few towns visited, and every record is let go in the end', { skip: unbaked }, async (t) => {
  const { folk, visit, live, buffers } = await crowdOf(t);
  const towns = Array.from({ length: 12 }, (_, i) => town('town ' + i, 40 + i, i * 10000));
  for (const [i, place] of towns.entries()) {
    visit(towns, place.center.x);
    assert.equal(folk.people, 40 + i);
    assert.ok(live('townsfolk fates').length <= 8, `${live('townsfolk fates').length} records kept after ${i + 1} towns`);
  }
  assert.equal(live('townsfolk fates').length, 8, 'the last eight');
  assert.equal(buffers.filter((b) => b.label === 'townsfolk fates').length, 12);
  // Back to one of those eight: the record it had, and nothing new.
  const lately = live('townsfolk fates').find((b) => b.size === (40 + 6) * TOWN_FATE_WORDS * 4);
  visit(towns, towns[6].center.x);
  assert.equal(buffers.filter((b) => b.label === 'townsfolk fates').length, 12, 'no new record for a town still remembered');
  assert.equal(lately.destroyed, false);
  // Back to the first, long forgotten: a new one, and the least lately visited goes.
  visit(towns, towns[0].center.x);
  assert.equal(buffers.filter((b) => b.label === 'townsfolk fates').length, 13);
  assert.equal(live('townsfolk fates').length, 8);
  assert.equal(lately.destroyed, false, 'the one just visited is not the one let go');
  // A town whose people are another number than before cannot use its old record, and does not leave it behind.
  towns[0].streets = town('', 77, 0).streets;
  visit(towns, towns[1].center.x);
  visit(towns, towns[0].center.x);
  assert.equal(live('townsfolk fates').filter((b) => b.size === 40 * TOWN_FATE_WORDS * 4).length, 0, 'the record of forty is destroyed');
  assert.equal(live('townsfolk fates').filter((b) => b.size === 77 * TOWN_FATE_WORDS * 4).length, 1);
  folk.destroy();
  assert.deepEqual(buffers.filter((b) => !b.destroyed && /^townsfolk/.test(b.label ?? '')).map((b) => b.label), [], 'nothing of the townsfolk is left on the GPU');
});

test('the pass is told the date in hours from when the record began, and only when the hour has moved on', { skip: unbaked }, async (t) => {
  const { folk, visit, writes, dispatches, pass } = await crowdOf(t);
  const towns = [town('lisbon', 60, 0), town('porto', 50, 9000)];
  const start = Date.UTC(1492, 7, 3);
  visit(towns, 0);
  writes.length = 0;
  folk.encode(pass(), start);
  assert.deepEqual(hoursSent(writes), [0], 'the hour is sent with the first frame');
  for (let frame = 1; frame <= 600; frame++) folk.encode(pass(), start + frame * 1000);
  assert.deepEqual(hoursSent(writes), [0], 'ten minutes of frames send nothing more');
  folk.encode(pass(), start + 0.3 * HOUR);
  folk.encode(pass(), start + 30 * HOUR);
  folk.encode(pass(), start + 30.1 * HOUR);
  assert.deepEqual(hoursSent(writes).map((h) => +h.toFixed(3)), [0, 0.3, 30]);
  // No date to go by: nothing is sent, and the hour stays where it was.
  folk.encode(pass(), NaN);
  assert.equal(hoursSent(writes).length, 3);
  // Away to another town, whose hours are its own, and back two days later: the hours go on from where they began.
  visit(towns, 9000);
  writes.length = 0;
  folk.encode(pass(), start + 40 * HOUR);
  assert.deepEqual(hoursSent(writes).at(-1), 0, 'another town counts from its own beginning');
  visit(towns, 0);
  writes.length = 0;
  folk.encode(pass(), start + 78 * HOUR);
  assert.equal(hoursSent(writes).at(-1), 78, 'so someone who fell at hour 30 has lain two days');
  // Every frame resets the counts via a 1-workgroup GPU compute pass, with zero CPU writeBuffer uploads of the town's
  // own; the walk then keeps whom it keeps, and each body's people are posed as many as it counted. Each body's stand
  // runs a workgroup for every slot it may hold (one past the count it reads is not drawn), then the one cut empties
  // its lists and cuts them. Only each batch's stand words and its scene's view are written, as for every batch.
  writes.length = 0;
  dispatches.length = 0;
  folk.encode(pass(), start + 78 * HOUR + 1000);
  assert.deepEqual(writes.map((w) => w.label).filter((label) => /^townsfolk/.test(label)), []);
  assert.deepEqual(dispatches.slice(0, 2 + TOWNSFOLK_MODELS), [
    { pipeline: 'townsfolk reset', workgroups: 1 }, { pipeline: 'townsfolk walk', workgroups: 1 },
    ...Array.from({ length: TOWNSFOLK_MODELS }, (_, m) => ({ pipeline: 'crew continuum pose', counted: 'townsfolk counts', offset: m * TOWNSFOLK_DISPATCH_WORDS * 4 })),
  ]);
  // Every walker here wears the man's body, so the woman's batch has no one to stand: its cut only empties its lists.
  assert.deepEqual(dispatches.slice(2 + TOWNSFOLK_MODELS), [
    { pipeline: 'crew continuum stand', workgroups: 60 }, { pipeline: 'continuum reset', workgroups: 1 }, { pipeline: 'continuum cut', workgroups: 60 },
    { pipeline: 'continuum reset', workgroups: 1 },
  ]);
  folk.destroy();
});

test('a town\'s people are cut and drawn through the continuum, one batch a body, from the slots the walk kept for it', { skip: unbaked }, async (t) => {
  const { folk, visit, writes, draws, pass, live } = await crowdOf(t);
  // Walker flags bit 0 is the body: 25 men and 35 women.
  const lisbon = town('lisbon', 60, 0), words = lisbon.streets.walkers;
  for (let i = 25; i < 60; i++) words[i * WALKER_WORDS + 11] = 1;
  visit([lisbon], 0);
  assert.equal(folk.error, null);
  const counted = writes.find((w) => w.label === 'townsfolk counts').words;
  assert.equal(counted.length, TOWNSFOLK_COUNT_WORDS, 'an indirect dispatch a body, and nothing for an old body');
  for (let m = 0; m < TOWNSFOLK_MODELS; m++) {
    assert.deepEqual([...counted.subarray(m * TOWNSFOLK_DISPATCH_WORDS, m * TOWNSFOLK_DISPATCH_WORDS + 3)], [0, 1, 1], 'an empty dispatch the walk fills');
  }
  // Each body's people have a run of slots of their own, the second's at a slot a bind group may begin at.
  const joints = live('townsfolk joints')[0];
  assert.equal(joints.size, (32 + 35) * CREW_JOINT_COUNT * 64);
  writes.length = 0;
  folk.encode(pass(), Date.UTC(1492, 7, 3));
  const [man, woman] = townsfolkBodiesFor();
  for (const [id, first, count] of [[man, 0, 25], [woman, 32, 35]]) {
    const part = writes.filter((w) => w.label === `crew continuum ${id} stand`).at(-1).words;
    assert.deepEqual([part[0], part[1]], [first, count], `${id}: the batch stands its own run of slots`);
    assert.equal(part[3] & 1, 1, `${id}: and reads how many there are from the walk's count`);
    assert.equal(part[3] & 2, 0, `${id}: ashore, not afloat`);
  }
  folk.draw(pass());
  folk.drawShadow(pass());
  assert.deepEqual(draws.filter((d) => d.indexed), [], 'no old body is drawn');
  for (const id of [man, woman]) {
    const own = draws.filter((d) => d.buffer.label === `crew ${id} continuum draws`);
    assert.deepEqual(own.map((d) => d.offset / 16), [0, 1, 2, 3, 4, 5], `${id}: the one cut's four lists in its view, then its two in the shadow`);
    assert.deepEqual(own.map((d) => d.pipeline), [...Array(CONTINUUM_VIEW_LISTS).fill('crewContinuum view'), 'continuum shadow', 'continuum shadow']);
    for (const d of own) assert.equal(d.list.label, `crew ${id} continuum lists`, 'each from its own scene\'s lists');
  }
  assert.equal(draws.length, TOWNSFOLK_MODELS * CONTINUUM_LISTS.length);
  folk.destroy();
});

test('a town of a culture whose bodies are not baked is not drawn, and says why', { skip: unbaked }, async (t) => {
  const errors = [], error = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { console.error = error; });
  // The colonial pair is here; the Taíno pair is not.
  const { folk, visit, draws, dispatches, pass } = await crowdOf(t, (path, init) => (/\/caribbean-/.test(path) ? Promise.resolve(new Response(null, { status: 404 })) : fetchCrewContinuumAsset(path, init)));
  const maguana = town('Maguana', 40, 0, { hasIndigenousSettlement: true, hasColonialPort: false, indigenousSettlement: { cultureId: 'taino-greater-antilles' } });
  visit([maguana], 0);
  for (let i = 0; i < 20 && !folk.error; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(folk.error, 'the town knows its people cannot be drawn');
  assert.match(folk.error.message, /assets\/crew\/continuum\/caribbean-male\/manifest\.json/);
  assert.match(folk.error.message, /prepare-crew-continuum\.mjs/);
  assert.ok(errors.some((args) => args.includes(folk.error)), 'and says so aloud');
  assert.equal(folk.people, 0);
  folk.encode(pass(), Date.UTC(1492, 7, 3));
  folk.draw(pass());
  folk.drawShadow(pass());
  assert.deepEqual([draws, dispatches], [[], []], 'nobody is drawn in their stead');
  folk.destroy();
});

test('rain wets people ashore, and nothing else in the frame does', () => {
  const wet = /let rain=([^;]+);/.exec(TOWNSFOLK_WALK)?.[1] ?? '';
  assert.match(wet, /F\.reserved\.x/, 'how hard it is raining');
  assert.match(wet, /F\.reserved\.y/, 'and whether it is rain at all');
  assert.doesNotMatch(wet, /windP/, 'not the ship\'s heading, which shares a row with the wind');
});

test('the fallen are counted off by the calendar, since the frame clock runs round every ten minutes', () => {
  assert.doesNotMatch(TOWNSFOLK_WALK, /age>=86400/, 'an age on the frame clock never reaches a day');
  assert.match(TOWNSFOLK_WALK, /fate\.mode==DOWN&&abs\(crowd\.hours-fate\.clock\)>=24\.0/);
  assert.match(TOWNSFOLK_WALK, /struct TownCrowd \{clips:array<vec4u,6>,second:u32,looks:u32,hours:f32,ride:u32\};/, 'the hour is word 26 of the block');
});
