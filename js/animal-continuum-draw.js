// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Animals cut and drawn through the one continuum (AGENTS.md rule 3; js/animal-continuum.js for the atlas,
// js/wgsl/animal-continuum.js for its programs). A family keeps one set: its animals' places, which its own step
// writes each frame (the herds' GPU pass, the sea's few CPU records), and the lists the cut fills. Every frame the
// GPU empties the lists, cuts every animal at the scene's one pixel error, and the family draws each list with one
// indirect call through its own pipeline, which poses and shades what the lists hold.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError } from './continuum-core.js';
import { loadAnimalContinuum, ANIMAL_PLACE_FLOATS } from './animal-continuum.js';
import {
  ANIMAL_CONTINUUM_LISTS, ANIMAL_CONTINUUM_VIEW_LISTS, ANIMAL_CONTINUUM_DRAW_WORDS, ANIMAL_CONTINUUM_VIEW_BYTES, ANIMAL_CONTINUUM_ROW,
  ANIMAL_CONTINUUM_SHADOW, animalContinuumSelectWGSL,
} from './wgsl/animal-continuum.js';

// Room in each list, per animal: clusters of every size, far-body pieces of 32 triangles for the view and for the
// shadow map, one splat; with floors, so a few animals seen close have room for every cluster they hold.
const ANIMAL_CONTINUUM_ROOM = Object.freeze({ clusters: 8, least: 16384, far: 24, leastFar: 4096, splat: 1, shadow: 24 });
// The shadow frame a set binds when it casts no shadow (ShadowFrame, js/wgsl/shadows.js: 112 bytes).
const ANIMAL_CONTINUUM_NO_SHADOW_BYTES = 112;

// The atlas, fetched and uploaded once a device.
export function requestAnimalContinuumAtlas(device, fetchAsset = fetch) {
  return requestOnce(device, 'animal continuum atlas', async () => {
    const { manifest, words } = await loadAnimalContinuum({ fetchAsset });
    const buffer = device.createBuffer({ label: 'animal continuum atlas', size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, words);
    return { manifest, words, buffer };
  });
}

// The cut's programs, one for every family.
export function requestAnimalContinuumPipelines({ device, shader }) {
  return requestOnce(device, 'animal continuum cut', async () => {
    const module = await shader(animalContinuumSelectWGSL(), 'animal continuum cut');
    const C = GPUShaderStage.COMPUTE, entry = (binding, buffer) => ({ binding, visibility: C, buffer: { type: buffer } });
    // One layout for the reset and the cut, so one bind group serves both.
    const computeLayout = device.createBindGroupLayout({
      label: 'animal continuum cut', entries: [entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'read-only-storage'), entry(4, 'storage'), entry(5, 'uniform'), entry(6, 'storage')],
    });
    const layout = device.createPipelineLayout({ label: 'animal continuum cut', bindGroupLayouts: [computeLayout] });
    const [reset, select] = await Promise.all([
      device.createComputePipelineAsync({ label: 'animal continuum reset', layout, compute: { module, entryPoint: 'animalContinuumReset' } }),
      device.createComputePipelineAsync({ label: 'animal continuum cut', layout, compute: { module, entryPoint: 'animalContinuumSelect' } }),
    ]);
    return { reset, select, computeLayout };
  });
}

// Where a set of `capacity` animals keeps its lists in its one list buffer: two entries an animal ahead of them hold
// its state for the frame, then each list's [first entry, room], in ANIMAL_CONTINUUM_LISTS order.
export function animalContinuumListLayout(capacity, shadows) {
  const R = ANIMAL_CONTINUUM_ROOM, clusters = Math.max(R.least, capacity * R.clusters), far = Math.max(R.leastFar, capacity * R.far);
  const room = [clusters, clusters, far, capacity * R.splat, shadows ? Math.max(R.leastFar, capacity * R.shadow) : 0];
  const lists = [];
  let entries = capacity * 2;
  for (const n of room) { lists.push([entries, n]); entries += n; }
  return { lists, entries };
}

// One family's animals. `frame` is the scene's frame uniform; `shadowUniform` the land's shadow frame when its
// animals cast shadows there (the fifth list), or none. The family writes `places` (ANIMAL_PLACE_FLOATS an animal),
// with its GPU step or with writePlaces, and binds `entries(first)` to its drawing pipelines.
export function createAnimalContinuumSet({ device, atlas, pipelines: P, frame, shadowUniform = null, capacity, samples = 4, label = 'animals' }) {
  const B = GPUBufferUsage, shadows = Boolean(shadowUniform);
  capacity = Math.max(1, capacity | 0);
  const { lists, entries } = animalContinuumListLayout(capacity, shadows);
  const places = device.createBuffer({ label: `${label} continuum places`, size: capacity * ANIMAL_PLACE_FLOATS * 4, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
  const list = device.createBuffer({ label: `${label} continuum lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} continuum draws`, size: ANIMAL_CONTINUUM_DRAW_WORDS * 4, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const view = device.createBuffer({ label: `${label} continuum view`, size: ANIMAL_CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const noShadow = shadows ? null : device.createBuffer({ label: `${label} continuum casts no shadow`, size: ANIMAL_CONTINUUM_NO_SHADOW_BYTES, usage: B.UNIFORM });
  const viewWords = new Uint32Array(ANIMAL_CONTINUUM_VIEW_BYTES / 4), viewFloats = new Float32Array(viewWords.buffer);
  viewWords.set([0, samples, shadows ? ANIMAL_CONTINUUM_SHADOW.land : ANIMAL_CONTINUUM_SHADOW.none, 0], 0);
  viewFloats[4] = continuumPixelError();
  lists.forEach(([at, n], i) => viewWords.set([at, n, 0, 0], 8 + i * 4));
  let viewChanged = true, count = 0, destroyed = false;

  const group = (layout, resources) => device.createBindGroup({ layout, entries: resources.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const cut = group(P.computeLayout, [[0, frame], [1, shadowUniform ?? noShadow], [2, atlas.buffer], [3, places], [4, list], [5, view], [6, draws]]);
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    if (!n) return;
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * 16);
  };
  return {
    capacity, lists, list, draws, places,
    get count() { return count; },
    // How many of the places are animals this frame (the rest are not read).
    setCount(n) {
      const next = Math.max(0, Math.min(capacity, n | 0));
      if (next !== viewWords[0]) { viewWords[0] = next; viewChanged = true; }
      count = next;
    },
    // The sea's animals, written by the CPU: `values` holds `n` places.
    writePlaces(values, n) {
      this.setCount(n);
      if (count) device.queue.writeBuffer(places, 0, values.buffer, values.byteOffset, count * ANIMAL_PLACE_FLOATS * 4);
    },
    // The bindings every drawing pass of the family reads: the atlas, the places, the lists and the view, from `first`.
    entries(first) { return [atlas.buffer, places, list, view].map((buffer, k) => ({ binding: first + k, resource: { buffer } })); },
    // In a compute pass after the family's places are written and before any pass draws: the lists emptied, then
    // every animal cut at the scene's one pixel error.
    encode(pass) {
      if (destroyed) return;
      const pixels = Math.fround(continuumPixelError());
      if (viewFloats[4] !== pixels) { viewFloats[4] = pixels; viewChanged = true; }
      if (viewChanged) { device.queue.writeBuffer(view, 0, viewWords); viewChanged = false; }
      pass.setBindGroup(0, cut);
      pass.setPipeline(P.reset);
      pass.dispatchWorkgroups(1);
      if (!count) return;
      pass.setPipeline(P.select);
      pass.dispatchWorkgroups(Math.min(count, ANIMAL_CONTINUUM_ROW), Math.ceil(count / ANIMAL_CONTINUUM_ROW));
    },
    // The view's four lists, through the family's pipeline and groups, already set.
    drawView(pass) {
      if (destroyed || !count) return;
      for (let index = 0; index < ANIMAL_CONTINUUM_VIEW_LISTS; index++) drawList(pass, index);
    },
    // The fifth list: the shadow map's far bodies.
    drawShadow(pass) {
      if (destroyed || !count || !shadows) return;
      drawList(pass, ANIMAL_CONTINUUM_LISTS.length - 1);
    },
    // For the continuum census (js/continuum-census.js): the view's draws.
    continuumDraws() { return !destroyed && count ? [{ buffer: draws, offset: 0, records: ANIMAL_CONTINUUM_VIEW_LISTS, stride: 4 }] : []; },
    destroy() { destroyed = true; for (const resource of [places, list, draws, view, noShadow]) resource?.destroy(); },
  };
}
