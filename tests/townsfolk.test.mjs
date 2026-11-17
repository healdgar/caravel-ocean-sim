// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What JavaScript keeps and sends for a town's people, with a device that only records what it is asked. What the
// GPU makes of it is in townsfolk-shots-gpu (the pass alone) and townsfolk-gpu, townsfolk-under-fire-gpu (the game).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCrewGLB } from '../js/gltf.js';
import { createTownsfolk } from '../js/townsfolk.js';
import { TOWN_FATE_WORDS, TOWNSFOLK_COUNT_WORDS, TOWNSFOLK_DISPATCH_WORDS, TOWNSFOLK_FALLBACK_AT, TOWNSFOLK_FALLBACK_WORDS, TOWNSFOLK_MODELS, TOWNSFOLK_WALK } from '../js/wgsl/townsfolk.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import { WALKER_WORDS } from '../js/town-streets.js';

const load = (name) => { const bytes = readFileSync(new URL(`../assets/crew/${name}.glb`, import.meta.url)); return loadCrewGLB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); };
const models = ['sailor', 'sailor-female'].map(load);

// A device that makes nothing and remembers everything.
function recorder() {
  const buffers = [], writes = [], draws = [], dispatches = [];
  const device = {
    createBuffer(d) { const b = { ...d, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
    queue: { writeBuffer(b, offset, data) { writes.push({ label: b.label, words: new Uint32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) }); } },
    createRenderPipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => ({ ...d }),
  };
  const pass = () => {
    const state = {};
    return {
      setPipeline(p) { state.pipeline = p.label; }, setBindGroup(i, g) { if (i === 0) state.group = g; }, setVertexBuffer() {},
      setIndexBuffer(b) { state.index = b; }, dispatchWorkgroups(x) { dispatches.push({ pipeline: state.pipeline, workgroups: x }); },
      dispatchWorkgroupsIndirect(b, offset) { dispatches.push({ pipeline: state.pipeline, counted: b.label, offset }); },
      drawIndexedIndirect(b, offset) { draws.push({ pipeline: state.pipeline, group: state.group, index: state.index, buffer: b, offset }); },
    };
  };
  return { device, buffers, writes, draws, dispatches, pass, live: (label) => buffers.filter((b) => b.label === label && !b.destroyed) };
}
const town = (name, people, x) => ({
  name, center: { x, z: 0 },
  streets: { people, walkers: new Uint32Array(people * WALKER_WORDS), samples: new Float32Array(64), window: { x, z: 0, span: 400 } },
});
async function crowdOf(t) {
  const usage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { VERTEX: 1, INDEX: 2, UNIFORM: 4, STORAGE: 8, COPY_DST: 16, INDIRECT: 32 };
  t.after(() => { if (usage === undefined) delete globalThis.GPUBufferUsage; else globalThis.GPUBufferUsage = usage; });
  const gpu = recorder();
  // No continuum's programs on a device that makes nothing, so the old bodies stand in: the sailors' own pipelines.
  const old = (label) => ({ label, getBindGroupLayout: () => ({}) });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const folk = await createTownsfolk({
    device: gpu.device, frameUBO: {}, shader: async (code, label) => ({ code, label }),
    shared: { models, pipeline: old('crew'), shadowPipeline: old('crew shadow'), captainTexView: {}, captainSampler: {} },
    shadows: { bind: () => ({}), uniform: {} },
  });
  // The nearest town is looked for once in a while, so a visit is as many calls as that takes.
  const visit = (ports, x) => { for (let i = 0; i < 45; i++) folk.follow(ports, { x, z: 0 }); };
  return { ...gpu, folk, visit };
}
const HOUR = 3600000;
const hoursSent = (writes) => writes.filter((w) => w.label === 'townsfolk crowd').map((w) => new Float32Array(w.words.buffer)[26]);

test('the fallen are remembered for the last few towns visited, and every record is let go in the end', async (t) => {
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

test('the pass is told the date in hours from when the record began, and only when the hour has moved on', async (t) => {
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
  // Every frame resets the counts via a 1-workgroup GPU compute pass, with zero CPU writeBuffer uploads; the walk then
  // keeps whom it keeps, and each body's people are posed as many as it counted.
  writes.length = 0;
  dispatches.length = 0;
  folk.encode(pass(), start + 78 * HOUR + 1000);
  assert.deepEqual(writes.map((w) => w.label), []);
  assert.deepEqual(dispatches, [
    { pipeline: 'townsfolk reset', workgroups: 1 }, { pipeline: 'townsfolk walk', workgroups: 1 },
    ...Array.from({ length: TOWNSFOLK_MODELS }, (_, m) => ({ pipeline: 'crew continuum pose', counted: 'townsfolk counts', offset: m * TOWNSFOLK_DISPATCH_WORDS * 4 })),
  ]);
  folk.destroy();
});

test('where the continuum\'s bodies are absent, the old ones are drawn and shadowed in one draw a body, of everyone the walk kept', async (t) => {
  const { folk, visit, writes, draws, pass, live } = await crowdOf(t);
  // Walker flags bit 0 is the body: 25 men and 35 women.
  const lisbon = town('lisbon', 60, 0), words = lisbon.streets.walkers;
  for (let i = 25; i < 60; i++) words[i * WALKER_WORDS + 11] = 1;
  visit([lisbon], 0);
  assert.equal(folk.continuum, false);
  const counted = writes.find((w) => w.label === 'townsfolk counts').words;
  assert.equal(counted.length, TOWNSFOLK_COUNT_WORDS);
  for (let m = 0; m < TOWNSFOLK_MODELS; m++) {
    assert.deepEqual([...counted.subarray(m * TOWNSFOLK_DISPATCH_WORDS, m * TOWNSFOLK_DISPATCH_WORDS + 3)], [0, 1, 1], 'an empty dispatch the walk fills');
    assert.ok(counted[TOWNSFOLK_FALLBACK_AT + m * TOWNSFOLK_FALLBACK_WORDS] > 0, 'and an old body\'s draw');
  }
  // Each body's people have a run of slots of their own, the second's at a slot a bind group may begin at.
  const joints = live('townsfolk joints')[0], actors = live('townsfolk actors')[0];
  assert.equal(joints.size, (32 + 35) * CREW_JOINT_COUNT * 64);
  folk.draw(pass());
  folk.drawShadow(pass());
  const main = draws.filter((d) => d.pipeline === 'crew'), shade = draws.filter((d) => d.pipeline === 'crew shadow');
  assert.equal(main.length, TOWNSFOLK_MODELS);
  assert.equal(shade.length, TOWNSFOLK_MODELS);
  for (const [m, draw] of [...main.entries(), ...shade.entries()]) {
    assert.equal(draw.buffer.label, 'townsfolk counts');
    assert.equal(draw.offset, (TOWNSFOLK_FALLBACK_AT + m * TOWNSFOLK_FALLBACK_WORDS) * 4, 'the count the walk kept for that body');
    const slices = draw.group.entries.filter((e) => e.resource?.buffer === joints || e.resource?.buffer === actors).map((e) => e.resource);
    assert.equal(slices.length, 2);
    for (const slice of slices) {
      assert.equal(slice.offset % 256, 0, 'at an offset a bind group may take');
      assert.equal(slice.offset / (slice.buffer === joints ? CREW_JOINT_COUNT * 64 : 144), m ? 32 : 0, 'from that body\'s first slot');
      assert.equal(slice.size / (slice.buffer === joints ? CREW_JOINT_COUNT * 64 : 144), m ? 35 : 25);
    }
  }
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
