// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Port props and round shot, cut and drawn through the one continuum (AGENTS.md rule 3; js/prop-continuum.js for the
// atlas, js/wgsl/prop-continuum.js for its programs). A scene is a set of instances of the atlas's types: the props of
// a port, or the balls in the air. The CPU writes an instance when it is placed, struck or moved, and the view's few
// numbers when they change; every frame the GPU empties the lists, cuts every instance at the scene's one pixel
// error, and each list is drawn with one indirect call.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError } from './continuum-core.js';
import { CITY_CONTINUUM_HEADER, CITY_CONTINUUM_TYPE_WORDS, CITY_CONTINUUM_STEP_WORDS, CITY_CONTINUUM_CHUNK_TRIANGLES } from './city-continuum.js';
import { CITY_CONTINUUM_ENTRY_LAYOUT } from './wgsl/city-continuum.js';
import { PROP_CONTINUUM_TYPE, PROP_CONTINUUM_TYPES, loadPropContinuum } from './prop-continuum.js';
import {
  PROP_CONTINUUM_LISTS, PROP_CONTINUUM_VIEW_LISTS, PROP_CONTINUUM_DRAW_WORDS, PROP_CONTINUUM_VIEW_BYTES, PROP_CONTINUUM_ROW,
  PROP_CONTINUUM_INSTANCE_FLOATS, propContinuumSelectWGSL, propContinuumRenderWGSL, propContinuumShadowWGSL,
} from './wgsl/prop-continuum.js';
import { withNeuralPbrProps } from './wgsl/neural-pbr.js';

// The atlas, fetched and uploaded once a device, with what each type can enter in the lists at most: all its clusters,
// and its far body at the heaviest step it is drawn at, in pieces of 32 triangles.
export function requestPropContinuumAtlas(device, fetchAsset = fetch) {
  return requestOnce(device, 'prop continuum atlas', async () => {
    const { manifest, words } = await loadPropContinuum({ fetchAsset });
    const buffer = device.createBuffer({ label: 'prop continuum atlas', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, words);
    const types = PROP_CONTINUUM_TYPES.map((_, t) => {
      const at = words[CITY_CONTINUUM_HEADER.typesAt] + t * CITY_CONTINUUM_TYPE_WORDS, T = PROP_CONTINUUM_TYPE;
      const heaviest = words[words[at + T.steps] + words[at + T.farFirst] * CITY_CONTINUUM_STEP_WORDS];
      return { clusters: words[at + T.clusterCount], farChunks: Math.ceil(heaviest / CITY_CONTINUUM_CHUNK_TRIANGLES) };
    });
    return { manifest, words, buffer, types };
  });
}

// The cut's programs, the view's and the shadow map's: one set a device and target.
export function requestPropContinuumPipelines({ device, shader, format, samples, shadowFormat }) {
  return requestOnce(device, `prop continuum ${format} ${samples} ${shadowFormat}`, async () => {
    const [selectModule, viewModule, shadowModule] = await Promise.all([
      shader(propContinuumSelectWGSL(), 'prop continuum cut'),
      shader(withNeuralPbrProps(propContinuumRenderWGSL()), 'prop continuum'),
      shader(propContinuumShadowWGSL(), 'prop continuum shadow'),
    ]);
    const C = GPUShaderStage.COMPUTE, entry = (binding, buffer) => ({ binding, visibility: C, buffer: { type: buffer } });
    // One layout for the reset and the cut, so one bind group serves both.
    const computeLayout = device.createBindGroupLayout({
      label: 'prop continuum cut', entries: [entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'read-only-storage'), entry(4, 'read-only-storage'), entry(5, 'storage'), entry(6, 'uniform'), entry(7, 'storage')],
    });
    const layout = device.createPipelineLayout({ label: 'prop continuum cut', bindGroupLayouts: [computeLayout] });
    const [reset, select, view, shadow] = await Promise.all([
      device.createComputePipelineAsync({ label: 'prop continuum reset', layout, compute: { module: selectModule, entryPoint: 'propContinuumReset' } }),
      device.createComputePipelineAsync({ label: 'prop continuum cut', layout, compute: { module: selectModule, entryPoint: 'propContinuumSelect' } }),
      device.createRenderPipelineAsync({
        label: 'prop continuum', layout: 'auto',
        vertex: { module: viewModule, entryPoint: 'propContinuumVS', buffers: CITY_CONTINUUM_ENTRY_LAYOUT },
        fragment: { module: viewModule, entryPoint: 'propContinuumFS', targets: [{ format }] },
        // Planks and cleats are open shells, lit from whichever side is seen.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples },
      }),
      device.createRenderPipelineAsync({
        label: 'prop continuum shadow', layout: 'auto',
        vertex: { module: shadowModule, entryPoint: 'propContinuumShadowVS', buffers: CITY_CONTINUUM_ENTRY_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
    ]);
    return { reset, select, view, shadow, computeLayout };
  });
}

// Where a scene keeps its lists in its one list buffer: two entries an instance ahead of them hold its state for the
// frame, then each list's [first entry, room], in PROP_CONTINUUM_LISTS order. `counts` is how many instances of each
// type the scene can hold; each list has room for all of them at once.
export function propContinuumListLayout(atlas, counts) {
  let clusters = 0, far = 0, capacity = 0;
  counts.forEach((n, t) => { capacity += n; clusters += n * atlas.types[t].clusters; far += n * atlas.types[t].farChunks; });
  const room = [clusters, clusters, far, capacity, far, clusters].map((n) => Math.max(1, n));
  const lists = [];
  let entries = capacity * 2;
  for (const n of room) { lists.push([entries, n]); entries += n; }
  return { capacity, lists, entries };
}

// One scene. `counts` as for propContinuumListLayout; `shards` the buffer of its instances' shard flights (none for
// shot); `frame` and `shadowUniform` the scene's frame and land-shadow uniforms.
export function createPropContinuumScene({ device, atlas, pipelines: P, counts, shards = null, frame, shadowUniform, samples = 4, label = 'props' }) {
  const B = GPUBufferUsage;
  const { capacity, lists, entries } = propContinuumListLayout(atlas, counts);
  const words = new Uint32Array(Math.max(1, capacity) * PROP_CONTINUUM_INSTANCE_FLOATS), floats = new Float32Array(words.buffer);
  const instances = device.createBuffer({ label: `${label} continuum instances`, size: words.byteLength, usage: B.STORAGE | B.COPY_DST });
  const ownShards = shards ? null : device.createBuffer({ label: `${label} continuum shards`, size: 16, usage: B.STORAGE });
  const list = device.createBuffer({ label: `${label} continuum lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} continuum draws`, size: PROP_CONTINUUM_DRAW_WORDS * 4, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const view = device.createBuffer({ label: `${label} continuum view`, size: PROP_CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const viewWords = new Uint32Array(PROP_CONTINUUM_VIEW_BYTES / 4), viewFloats = new Float32Array(viewWords.buffer);
  viewWords.set([0, samples, 1, 0], 0);
  lists.forEach(([at, n], i) => viewWords.set([at, n, 0, 0], 8 + i * 4));
  let viewChanged = true;
  const setView = (at, value) => { if (viewWords[at] !== value) { viewWords[at] = value; viewChanged = true; } };
  const setViewFloat = (at, value) => { if (viewFloats[at] !== Math.fround(value)) { viewFloats[at] = value; viewChanged = true; } };

  const group = (layout, resources) => device.createBindGroup({ layout, entries: resources.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const data = [[0, atlas.buffer], [1, instances], [2, shards ?? ownShards], [3, list], [4, view]];
  const cut = group(P.computeLayout, [[0, frame], [1, shadowUniform], ...data.map(([binding, buffer]) => [binding + 2, buffer]), [7, draws]]);
  const drawn = group(P.view.getBindGroupLayout(2), data);
  const shadowGroups = [group(P.shadow.getBindGroupLayout(0), [[0, shadowUniform], [1, frame]]), group(P.shadow.getBindGroupLayout(1), data)];
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * 16);
  };
  let count = 0, destroyed = false;
  return {
    capacity, lists, list, draws, instances,
    get count() { return count; },
    // An instance's record, written here and sent with send(): root (x, y, z, yaw), shape (scale x, y, z, glow),
    // tag (type | flags << 16, its block of shard records in vec4f, extra reach in metres, its seed).
    words, floats,
    place(index, { x, y, z, yaw = 0, scale = [1, 1, 1], glow = 0, type, flags = 0, records = 0, reach = 0, seed = index }) {
      const at = index * PROP_CONTINUUM_INSTANCE_FLOATS;
      floats.set([x, y, z, yaw, scale[0], scale[1], scale[2], glow], at);
      words[at + 8] = (type & 0xffff) | (flags << 16);
      words[at + 9] = records;
      floats[at + 10] = reach;
      words[at + 11] = seed >>> 0;
    },
    // Instances `first`..`first + n` sent as they now stand.
    send(first = 0, n = count) {
      if (destroyed || n <= 0) return;
      device.queue.writeBuffer(instances, first * PROP_CONTINUUM_INSTANCE_FLOATS * 4, words, first * PROP_CONTINUUM_INSTANCE_FLOATS, n * PROP_CONTINUUM_INSTANCE_FLOATS);
    },
    setCount(n) { count = Math.max(0, Math.min(capacity, n)); setView(0, count); },
    setShadows(on) { setView(2, on ? 1 : 0); },
    // In the frame's compute pass, before any pass draws: the lists emptied, then every instance cut at the scene's
    // one pixel error (js/continuum-core.js).
    encode(pass) {
      if (destroyed) return;
      setViewFloat(4, continuumPixelError());
      if (viewChanged) { device.queue.writeBuffer(view, 0, viewWords); viewChanged = false; }
      pass.setBindGroup(0, cut);
      pass.setPipeline(P.reset);
      pass.dispatchWorkgroups(1);
      if (!count) return;
      pass.setPipeline(P.select);
      pass.dispatchWorkgroups(Math.min(count, PROP_CONTINUUM_ROW), Math.ceil(count / PROP_CONTINUUM_ROW));
    },
    // The view's four lists, one pipeline. `scene` and `lighting` are its groups 0 and 1 (js/props.js).
    draw(pass, scene, lighting) {
      if (destroyed || !count) return;
      pass.setPipeline(P.view);
      pass.setBindGroup(0, scene); pass.setBindGroup(1, lighting); pass.setBindGroup(2, drawn);
      for (let index = 0; index < PROP_CONTINUUM_VIEW_LISTS; index++) drawList(pass, index);
    },
    drawShadow(pass) {
      if (destroyed || !count) return;
      pass.setPipeline(P.shadow);
      pass.setBindGroup(0, shadowGroups[0]); pass.setBindGroup(1, shadowGroups[1]);
      for (let index = PROP_CONTINUUM_VIEW_LISTS; index < PROP_CONTINUUM_LISTS.length; index++) drawList(pass, index);
    },
    // For the continuum census (js/continuum-census.js): the view's draws.
    continuumDraws() { return !destroyed && count ? [{ buffer: draws, offset: 0, records: PROP_CONTINUUM_VIEW_LISTS, stride: 4 }] : []; },
    destroy() { destroyed = true; for (const resource of [instances, ownShards, list, draws, view]) resource?.destroy(); },
  };
}
