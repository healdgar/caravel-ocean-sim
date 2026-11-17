// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings, cut and drawn through the one continuum (AGENTS.md rule 3; js/city-continuum.js for the atlas,
// js/wgsl/city-continuum.js for its programs). The CPU writes a city's places and types once, a building's flag when
// shot fells it or it is stood again, and the view's few numbers when they change; every frame the GPU empties the
// lists, cuts every building at the scene's one pixel error, and draws each list with one indirect call.
import { requestOnce } from './gpu-program-cache.js';
import { loadCityContinuum } from './city-continuum.js';
import { CITY_TYPED_FLOATS } from './old-world-buildings.js';
import {
  CITY_CONTINUUM_LISTS, CITY_CONTINUUM_VIEW_LISTS, CITY_CONTINUUM_DRAW_WORDS, CITY_CONTINUUM_VIEW_BYTES, CITY_CONTINUUM_ROW,
  CITY_CONTINUUM_ENTRY_LAYOUT, cityContinuumSelectWGSL, cityContinuumShadowWGSL,
} from './wgsl/city-continuum.js';

// A building's flag: its type, and this bit while it stands as pieces (js/building-fracture.js).
export const CITY_CONTINUUM_FELLED = 1 << 16;
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

// The cut's programs and the shadow map's. The view's own pipeline is built from the land's module, whose surfaces
// it shades with (js/terrain.js).
export function requestCityContinuumPipelines({ device, shader, shadowFormat }) {
  return requestOnce(device, `city continuum ${shadowFormat}`, async () => {
    const [selectModule, shadowModule] = await Promise.all([shader(cityContinuumSelectWGSL(), 'city continuum cut'), shader(cityContinuumShadowWGSL(), 'city continuum shadow')]);
    const C = GPUShaderStage.COMPUTE, entry = (binding, buffer) => ({ binding, visibility: C, buffer: { type: buffer } });
    // One layout for the reset and the cut, so one bind group serves both.
    const computeLayout = device.createBindGroupLayout({
      label: 'city continuum cut', entries: [entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'read-only-storage'), entry(4, 'read-only-storage'), entry(5, 'storage'), entry(6, 'uniform'), entry(7, 'storage')],
    });
    const layout = device.createPipelineLayout({ label: 'city continuum cut', bindGroupLayouts: [computeLayout] });
    const [reset, select, shadow] = await Promise.all([
      device.createComputePipelineAsync({ label: 'city continuum reset', layout, compute: { module: selectModule, entryPoint: 'cityContinuumReset' } }),
      device.createComputePipelineAsync({ label: 'city continuum cut', layout, compute: { module: selectModule, entryPoint: 'cityContinuumSelect' } }),
      device.createRenderPipelineAsync({
        label: 'city continuum shadow', layout: 'auto', vertex: { module: shadowModule, entryPoint: 'cityContinuumShadowVS', buffers: CITY_CONTINUUM_ENTRY_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBiasSlopeScale: 1.5 },
      }),
    ]);
    return { reset, select, shadow, computeLayout };
  });
}

// The view's pipeline, from the land's module (js/wgsl/terrain.js, with cityContinuumRenderWGSL appended).
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

// One city. `typed` and `types` are its plan's (CITY_TYPED_FLOATS a building, and its type); `frame` and `shadows`
// the scene's frame and land-shadow uniforms.
// Where a city of `count` buildings keeps its lists in its one list buffer: two entries a building ahead of them hold
// its state for the frame, then each list's [first entry, room], in CITY_CONTINUUM_LISTS order.
export function cityContinuumListLayout(count) {
  const room = [
    Math.max(CITY_CONTINUUM_ROOM.least, count * CITY_CONTINUUM_ROOM.clusters), Math.max(CITY_CONTINUUM_ROOM.least, count * CITY_CONTINUUM_ROOM.clusters),
    count * CITY_CONTINUUM_ROOM.far, count * CITY_CONTINUUM_ROOM.splat, count * CITY_CONTINUUM_ROOM.shadow,
  ];
  const lists = [];
  let entries = count * 2;
  for (const n of room) { lists.push([entries, n]); entries += n; }
  return { lists, entries };
}

export function createCityContinuum({ device, atlas, pipelines: P, view: viewPipeline, typed, types, frame, shadowUniform, samples = 4, label = 'city' }) {
  const B = GPUBufferUsage, count = types.length;
  const { lists, entries } = cityContinuumListLayout(count);
  const places = device.createBuffer({ label: `${label} continuum places`, size: Math.max(32, count * CITY_TYPED_FLOATS * 4), usage: B.STORAGE | B.COPY_DST });
  const flags = device.createBuffer({ label: `${label} continuum flags`, size: Math.max(16, count * 4), usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
  const list = device.createBuffer({ label: `${label} continuum lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} continuum draws`, size: CITY_CONTINUUM_DRAW_WORDS * 4, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const view = device.createBuffer({ label: `${label} continuum view`, size: CITY_CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  device.queue.writeBuffer(places, 0, typed.buffer, typed.byteOffset, count * CITY_TYPED_FLOATS * 4);
  const flagWords = Uint32Array.from(types);
  device.queue.writeBuffer(flags, 0, flagWords);
  const viewWords = new Uint32Array(CITY_CONTINUUM_VIEW_BYTES / 4), viewFloats = new Float32Array(viewWords.buffer);
  viewWords.set([count, samples, 1, 0], 0);
  lists.forEach(([at, n], i) => viewWords.set([at, n, 0, 0], 8 + i * 4));
  let viewChanged = true;
  const setView = (at, value) => { if (viewFloats[at] !== Math.fround(value)) { viewFloats[at] = value; viewChanged = true; } };

  const group = (layout, resources) => device.createBindGroup({ layout, entries: resources.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const cut = group(P.computeLayout, [[0, frame], [1, shadowUniform], [2, atlas.buffer], [3, places], [4, flags], [5, list], [6, view], [7, draws]]);
  const data = [[40, atlas.buffer], [41, places], [42, flags], [43, list], [44, view]];
  const drawn = viewPipeline ? group(viewPipeline.getBindGroupLayout(2), data) : null;
  const shadowGroups = [group(P.shadow.getBindGroupLayout(0), [[0, shadowUniform]]), group(P.shadow.getBindGroupLayout(1), data.map(([binding, buffer]) => [binding - 40, buffer]))];
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * 16);
  };
  let destroyed = false;
  return {
    count, lists, list, draws, flags,
    // The scene's one pixel error, which every family's cut reads (js/continuum-core.js).
    setPixelError(pixels) { setView(4, pixels); },
    setWorldOffset(x, z) { setView(5, x); setView(6, z); },
    setShadows(on) { if (viewWords[2] !== (on ? 1 : 0)) { viewWords[2] = on ? 1 : 0; viewChanged = true; } },
    // Buildings `index`..`index + n` hidden while they stand as pieces, or shown again.
    hide(index, n = 1, hidden = true) {
      if (!(index >= 0) || index >= count) return;
      const end = Math.min(count, index + n);
      for (let i = index; i < end; i++) flagWords[i] = (types[i] & 0xffff) | (hidden ? CITY_CONTINUUM_FELLED : 0);
      device.queue.writeBuffer(flags, index * 4, flagWords, index, end - index);
    },
    hidden(index) { return (flagWords[index] & CITY_CONTINUUM_FELLED) !== 0; },
    // In the frame's compute pass, before any pass draws: the lists emptied, then every building cut.
    encode(pass) {
      if (destroyed || !count) return;
      if (viewChanged) { device.queue.writeBuffer(view, 0, viewWords); viewChanged = false; }
      pass.setBindGroup(0, cut);
      pass.setPipeline(P.reset);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(P.select);
      pass.dispatchWorkgroups(Math.min(count, CITY_CONTINUUM_ROW), Math.ceil(count / CITY_CONTINUUM_ROW));
    },
    // The view's four lists, one pipeline. `scene` and `clouds` are the land's groups 0 and 1.
    draw(pass, scene, clouds) {
      if (destroyed || !count || !drawn) return;
      pass.setPipeline(viewPipeline);
      pass.setBindGroup(0, scene); pass.setBindGroup(1, clouds); pass.setBindGroup(2, drawn);
      for (let index = 0; index < CITY_CONTINUUM_VIEW_LISTS; index++) drawList(pass, index);
    },
    drawShadow(pass) {
      if (destroyed || !count) return;
      pass.setPipeline(P.shadow);
      pass.setBindGroup(0, shadowGroups[0]); pass.setBindGroup(1, shadowGroups[1]);
      drawList(pass, CITY_CONTINUUM_LISTS.length - 1);
    },
    // For the continuum census (js/continuum-census.js): the view's draws.
    continuumDraws() { return !destroyed && count ? [{ buffer: draws, offset: 0, records: CITY_CONTINUUM_VIEW_LISTS, stride: 4 }] : []; },
    destroy() { destroyed = true; for (const resource of [places, flags, list, draws, view]) resource.destroy(); },
  };
}
