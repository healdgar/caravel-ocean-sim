// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Rigid bodies cut and drawn through the one continuum (AGENTS.md rule 3; js/city-continuum.js for the atlas,
// js/wgsl/city-continuum.js for its programs): a city's buildings, a coast's prefabs, and (js/prop-continuum-draw.js)
// port props and round shot. A scene is a set of instances of one atlas's types. The CPU writes an instance when it
// is placed, struck, broken or moved, and the view's few numbers when they change; every frame the GPU empties the
// lists, cuts every instance at the scene's one pixel error, and each list is drawn with one indirect call.
import { requestOnce } from './gpu-program-cache.js';
import { loadCityContinuum } from './city-continuum.js';
import { CITY_TYPED_FLOATS } from './old-world-buildings.js';
import {
  CITY_CONTINUUM_LISTS, CITY_CONTINUUM_VIEW_LISTS, CITY_CONTINUUM_DRAW_WORDS, CITY_CONTINUUM_VIEW_BYTES, CITY_CONTINUUM_ROW,
  CITY_CONTINUUM_ENTRY_LAYOUT, CITY_CONTINUUM_INSTANCE_WORDS, CITY_CONTINUUM_GONE, CITY_CONTINUUM_STRUCK,
  cityContinuumSelectWGSL, cityContinuumShadowWGSL,
} from './wgsl/city-continuum.js';

export { CITY_CONTINUUM_GONE, CITY_CONTINUUM_FELLED, CITY_CONTINUUM_STRUCK, CITY_CONTINUUM_BROKEN } from './wgsl/city-continuum.js';

if (CITY_TYPED_FLOATS !== 8) throw Error('A city building\'s place is the continuum instance\'s root and shape');

// Room in each list, per building: far-body pieces of 32 triangles for the view and for the shadow map; clusters
// of every size, with a floor for small cities that are walked through.
const CITY_CONTINUUM_ROOM = Object.freeze({ clusters: 8, least: 16384, far: 24, splat: 1, shadow: 24 });

// The atlas, fetched and uploaded once a device.
export function requestCityContinuumAtlas(device, fetchAsset = fetch) {
  return requestOnce(device, 'city continuum atlas', async () => {
    const { manifest, words } = await loadCityContinuum({ fetchAsset });
    const buffer = device.createBuffer({ label: 'city continuum atlas', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, words);
    return { manifest, words, buffer };
  });
}

// The cut's programs and the shadow map's, one set a device for every family. A family's view is its own: a city's
// is built from the land's module, whose surfaces it shades with (js/terrain.js); props' from theirs.
export function requestCityContinuumPipelines({ device, shader, shadowFormat }) {
  return requestOnce(device, `city continuum ${shadowFormat}`, async () => {
    const [selectModule, shadowModule] = await Promise.all([shader(cityContinuumSelectWGSL(), 'city continuum cut'), shader(cityContinuumShadowWGSL(), 'city continuum shadow')]);
    const C = GPUShaderStage.COMPUTE, entry = (binding, buffer) => ({ binding, visibility: C, buffer: { type: buffer } });
    // One layout for the reset and the cut, so one bind group serves both.
    const computeLayout = device.createBindGroupLayout({
      label: 'city continuum cut', entries: [entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'read-only-storage'), entry(4, 'storage'), entry(5, 'uniform'), entry(6, 'read-only-storage'), entry(7, 'storage')],
    });
    const layout = device.createPipelineLayout({ label: 'city continuum cut', bindGroupLayouts: [computeLayout] });
    const [reset, select, shadow] = await Promise.all([
      device.createComputePipelineAsync({ label: 'city continuum reset', layout, compute: { module: selectModule, entryPoint: 'cityContinuumReset' } }),
      device.createComputePipelineAsync({ label: 'city continuum cut', layout, compute: { module: selectModule, entryPoint: 'cityContinuumSelect' } }),
      device.createRenderPipelineAsync({
        label: 'city continuum shadow', layout: 'auto', vertex: { module: shadowModule, entryPoint: 'cityContinuumShadowVS', buffers: CITY_CONTINUUM_ENTRY_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
    ]);
    return { reset, select, shadow, computeLayout };
  });
}

// A city's view pipeline, from the land's module (js/wgsl/terrain.js, with cityContinuumRenderWGSL appended).
export function cityContinuumViewPipeline({ device, module, format, samples }) {
  return device.createRenderPipelineAsync({
    label: 'city continuum', layout: 'auto',
    vertex: { module, entryPoint: 'cityContinuumVS', buffers: CITY_CONTINUUM_ENTRY_LAYOUT },
    fragment: { module, entryPoint: 'cityContinuumFS', targets: [{ format }] },
    // Every type, its far body and its splat are wound outward, so the far faces are left out.
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples },
  });
}

// Where a scene of `capacity` instances keeps its lists in its one list buffer: two entries an instance ahead of them
// hold its state for the frame, then each list's [first entry, room], in CITY_CONTINUUM_LISTS order.
export function continuumListLayout(capacity, room) {
  const lists = [];
  let entries = capacity * 2;
  for (const n of room) { const k = Math.max(1, n); lists.push([entries, k]); entries += k; }
  return { lists, entries };
}
// A city's: room for every building's far body, and clusters for all of them at a few each, past a floor.
export function cityContinuumListLayout(count) {
  const clusters = Math.max(CITY_CONTINUUM_ROOM.least, count * CITY_CONTINUUM_ROOM.clusters), far = count * CITY_CONTINUUM_ROOM.far;
  return continuumListLayout(count, [clusters, clusters, far, count * CITY_CONTINUUM_ROOM.splat, count * CITY_CONTINUUM_ROOM.shadow, clusters]);
}

// One scene of the one cut. `capacity` instances, `room` each list's, `view` the family's view pipeline (or none) and
// `dataAt` the first binding of its data in that pipeline's group 2; `shards` the buffer of broken instances' shard
// flights (js/ship-fracture.js's records, a block an instance), if any; `frame` and `shadowUniform` the scene's frame
// and land-shadow uniforms. Every family's instances are the same record, written here: `words` and `floats` hold
// them on the CPU, `send` writes a range of them.
export function createContinuumScene({ device, atlas, pipelines: P, capacity, room, view: viewPipeline = null, dataAt = 0, shards = null, frame, shadowUniform, samples = 4, label }) {
  const B = GPUBufferUsage, W = CITY_CONTINUUM_INSTANCE_WORDS;
  const { lists, entries } = continuumListLayout(capacity, room);
  const words = new Uint32Array(Math.max(1, capacity) * W), floats = new Float32Array(words.buffer);
  const instances = device.createBuffer({ label: `${label} continuum instances`, size: words.byteLength, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
  const ownShards = shards ? null : device.createBuffer({ label: `${label} continuum shards`, size: 16, usage: B.STORAGE });
  const list = device.createBuffer({ label: `${label} continuum lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} continuum draws`, size: CITY_CONTINUUM_DRAW_WORDS * 4, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const view = device.createBuffer({ label: `${label} continuum view`, size: CITY_CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const viewWords = new Uint32Array(CITY_CONTINUUM_VIEW_BYTES / 4), viewFloats = new Float32Array(viewWords.buffer);
  viewWords.set([0, samples, 1, 0], 0);
  lists.forEach(([at, n], i) => viewWords.set([at, n, 0, 0], 8 + i * 4));
  const aimAt = 8 + CITY_CONTINUUM_LISTS.length * 4;
  let viewChanged = true;
  const setWord = (at, value) => { if (viewWords[at] !== value) { viewWords[at] = value; viewChanged = true; } };
  const setFloat = (at, value) => { if (viewFloats[at] !== Math.fround(value)) { viewFloats[at] = value; viewChanged = true; } };

  const group = (layout, resources) => device.createBindGroup({ layout, entries: resources.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const data = [atlas.buffer, instances, list, view, shards ?? ownShards];
  const cut = group(P.computeLayout, [[0, frame], [1, shadowUniform], ...data.map((buffer, i) => [2 + i, buffer]), [7, draws]]);
  const drawn = viewPipeline ? group(viewPipeline.getBindGroupLayout(2), data.map((buffer, i) => [dataAt + i, buffer])) : null;
  const shadowGroups = [group(P.shadow.getBindGroupLayout(0), [[0, shadowUniform], [1, frame]]), group(P.shadow.getBindGroupLayout(1), data.map((buffer, i) => [i, buffer]))];
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * 16);
  };
  let count = 0, destroyed = false;
  const scene = {
    capacity, lists, list, draws, instances, words, floats,
    get count() { return count; },
    // An instance: where it stands (its type stretched, turned by the unit quaternion `turn`, then by yaw, and stood
    // at x, y, z), its stretch, its family's own word (a building's tint, a prop's glow), its type and flags
    // (CITY_CONTINUUM_GONE, _STRUCK, _BROKEN), its block of shard records (in vec4f), how far past its type's sphere
    // its pieces may lie, and the seed that thins its splat.
    place(index, { x, y, z, yaw = 0, scale = [1, 1, 1], word = 0, type, flags = 0, records = 0, reach = 0, seed = index, turn = [0, 0, 0, 1] }) {
      const at = index * W;
      floats.set([x, y, z, yaw, scale[0], scale[1], scale[2], word], at);
      words[at + 8] = ((type & 0xffff) | flags) >>> 0;
      words[at + 9] = records;
      floats[at + 10] = reach;
      words[at + 11] = seed >>> 0;
      floats.set(turn, at + 12);
    },
    // Instances `first`..`first + n` sent as they now stand.
    send(first = 0, n = count) {
      if (destroyed || n <= 0) return;
      device.queue.writeBuffer(instances, first * W * 4, words, first * W, n * W);
    },
    // Flag `bit` of instances `index`..`index + n` set or cleared, sent only where it changed.
    flag(index, n, bit, on) {
      if (!(index >= 0) || index >= capacity) return;
      const end = Math.min(capacity, index + n);
      let first = -1, last = -1;
      for (let i = index; i < end; i++) {
        const at = i * W + 8, word = (on ? words[at] | bit : words[at] & ~bit) >>> 0;
        if (word !== words[at]) { words[at] = word; if (first < 0) first = i; last = i; }
      }
      if (first >= 0) scene.send(first, last - first + 1);
    },
    flagged(index, bit) { return (words[index * W + 8] & bit) !== 0; },
    setCount(n) { count = Math.max(0, Math.min(capacity, n)); setWord(0, count); },
    // The scene's one pixel error, which every family's cut reads (js/continuum-core.js).
    setPixelError(pixels) { setFloat(4, pixels); },
    setWorldOffset(x, z) { setFloat(5, x); setFloat(6, z); },
    setShadows(on) { setWord(2, on ? 1 : 0); },
    // Where the player's guns would fall now, in the scene's frame, and how far about it (js/gunnery-control.js
    // aimSummary.fall): every instance within it is cut finer. A radius of 0, or none, aims at nothing.
    setAim(fall) {
      const on = fall && fall.radius > 0;
      setFloat(aimAt, on ? fall.x : 0); setFloat(aimAt + 1, on ? fall.y : 0); setFloat(aimAt + 2, on ? fall.z : 0); setFloat(aimAt + 3, on ? fall.radius : 0);
    },
    // In the frame's compute pass, before any pass draws: the lists emptied, then every instance cut.
    encode(pass) {
      if (destroyed) return;
      if (viewChanged) { device.queue.writeBuffer(view, 0, viewWords); viewChanged = false; }
      pass.setBindGroup(0, cut);
      pass.setPipeline(P.reset);
      pass.dispatchWorkgroups(1);
      if (!count) return;
      pass.setPipeline(P.select);
      pass.dispatchWorkgroups(Math.min(count, CITY_CONTINUUM_ROW), Math.ceil(count / CITY_CONTINUUM_ROW));
    },
    // The view's four lists, one pipeline. `scene` and `second` are the family view's groups 0 and 1.
    draw(pass, sceneGroup, second) {
      if (destroyed || !count || !drawn) return;
      pass.setPipeline(viewPipeline);
      pass.setBindGroup(0, sceneGroup); pass.setBindGroup(1, second); pass.setBindGroup(2, drawn);
      for (let index = 0; index < CITY_CONTINUUM_VIEW_LISTS; index++) drawList(pass, index);
    },
    drawShadow(pass) {
      if (destroyed || !count) return;
      pass.setPipeline(P.shadow);
      pass.setBindGroup(0, shadowGroups[0]); pass.setBindGroup(1, shadowGroups[1]);
      for (let index = CITY_CONTINUUM_VIEW_LISTS; index < CITY_CONTINUUM_LISTS.length; index++) drawList(pass, index);
    },
    // For the continuum census (js/continuum-census.js): the view's draws.
    continuumDraws() { return !destroyed && count ? [{ buffer: draws, offset: 0, records: CITY_CONTINUUM_VIEW_LISTS, stride: 4 }] : []; },
    destroy() { destroyed = true; for (const resource of [instances, ownShards, list, draws, view]) resource?.destroy(); },
  };
  return scene;
}

// One city, or a coast's prefabs. `typed` and `types` are its plan's (CITY_TYPED_FLOATS a building: its place, then
// its stretch and tint; and its type), written once.
export function createCityContinuum({ device, atlas, pipelines, view = null, typed, types, frame, shadowUniform, samples = 4, label = 'city' }) {
  const count = types.length, { lists } = cityContinuumListLayout(count);
  const scene = createContinuumScene({ device, atlas, pipelines, capacity: count, room: lists.map(([, n]) => n), view, dataAt: 40, frame, shadowUniform, samples, label });
  for (let i = 0; i < count; i++) {
    const at = i * CITY_TYPED_FLOATS;
    scene.place(i, { x: typed[at], y: typed[at + 1], z: typed[at + 2], yaw: typed[at + 3], scale: [typed[at + 4], typed[at + 5], typed[at + 6]], word: typed[at + 7], type: types[i] });
  }
  scene.send(0, count);
  scene.setCount(count);
  return Object.assign(scene, {
    // Buildings `index`..`index + n` hidden while they stand as pieces, or shown again.
    hide(index, n = 1, hidden = true) { scene.flag(index, n, CITY_CONTINUUM_GONE, hidden); },
    hidden(index) { return scene.flagged(index, CITY_CONTINUUM_GONE); },
    // Buildings `index`..`index + n` struck, so cut finer; or stood again.
    strike(index, n = 1, struck = true) { scene.flag(index, n, CITY_CONTINUUM_STRUCK, struck); },
    struck(index) { return scene.flagged(index, CITY_CONTINUUM_STRUCK); },
  });
}
