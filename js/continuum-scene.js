// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one cut's scenes and programs (AGENTS.md rule 3; js/continuum-format.js for the data, js/wgsl/continuum-cut.js
// for the WGSL). A scene is a set of instances of one atlas's types, every one a record of the one format. The CPU
// writes a record when an instance is placed, struck, broken or moved (or a family's own compute pass stands its
// records each frame), and the view's few numbers when they change; every frame the GPU empties the lists, cuts every
// instance at the scene's one pixel error, and each list is drawn with one indirect call. Every family's scene is cut
// by the same select and cast by the same shadow program; each family's material has its view (and, if it is seen
// under water, its capture) composed by the one composer.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError } from './continuum-core.js';
import { continuumGroundView } from './continuum-ground.js';
import { CONTINUUM_RECORD_WORDS, CONTINUUM_RECORD, CONTINUUM_LISTS, CONTINUUM_VIEW_LISTS, writeContinuumRecord, continuumAtlasTypes } from './continuum-format.js';
import {
  CONTINUUM_ENTRY_LAYOUT, CONTINUUM_DRAW_WORDS, CONTINUUM_DRAWS_BYTES, CONTINUUM_VIEW_BYTES, CONTINUUM_ROW, CONTINUUM_DATA_BINDINGS, CONTINUUM_GROUND_BINDING, continuumModuleWGSL,
} from './wgsl/continuum-cut.js';

// The select and the shadow map's program, one set a device and shadow format for every family.
export function requestContinuumPrograms({ device, shader, shadowFormat }) {
  return requestOnce(device, `continuum programs ${shadowFormat}`, async () => {
    const [selectModule, shadowModule] = await Promise.all([shader(continuumModuleWGSL({ pass: 'select' }), 'continuum cut'), shader(continuumModuleWGSL({ pass: 'shadow' }), 'continuum shadow')]);
    const C = GPUShaderStage.COMPUTE, entry = (binding, buffer) => ({ binding, visibility: C, buffer: { type: buffer } });
    // One layout for the reset and the cut, so one bind group serves both; the cut reads the land's ground field.
    const computeLayout = device.createBindGroupLayout({
      label: 'continuum cut', entries: [entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'read-only-storage'), entry(4, 'storage'), entry(5, 'uniform'), entry(6, 'read-only-storage'), entry(7, 'storage'),
        { binding: CONTINUUM_GROUND_BINDING, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } }],
    });
    const layout = device.createPipelineLayout({ label: 'continuum cut', bindGroupLayouts: [computeLayout] });
    const [reset, select, shadow] = await Promise.all([
      device.createComputePipelineAsync({ label: 'continuum reset', layout, compute: { module: selectModule, entryPoint: 'continuumReset' } }),
      device.createComputePipelineAsync({ label: 'continuum cut', layout, compute: { module: selectModule, entryPoint: 'continuumSelect' } }),
      device.createRenderPipelineAsync({
        label: 'continuum shadow', layout: 'auto', vertex: { module: shadowModule, entryPoint: 'continuumShadowVS', buffers: CONTINUUM_ENTRY_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
    ]);
    return { reset, select, shadow, computeLayout };
  });
}

// A material's view: { pipeline, material }, one a device, material, target format and sample count.
export function requestContinuumView({ device, shader, material, format, samples }) {
  return requestOnce(device, `continuum view ${material.name} ${format} ${samples}`, async () => {
    const module = await shader(continuumModuleWGSL({ pass: 'view', material }), `${material.name} view`);
    const pipeline = await device.createRenderPipelineAsync({
      label: `${material.name} view`, layout: 'auto',
      vertex: { module, entryPoint: 'continuumVS', buffers: CONTINUUM_ENTRY_LAYOUT },
      fragment: { module, entryPoint: 'continuumFS', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: material.cullMode },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples },
    });
    return { pipeline, material };
  });
}

// A material's view under water: single-sampled, its fragment cut by the water's own capture (js/water-optics.js),
// drawing the coarse cut the shadow map's lists hold, as the sea blurs anything finer. Null without the water's optics.
export async function requestContinuumCapture(waterOptics, material) {
  const optics = await waterOptics;
  if (!optics) return null;
  const source = continuumModuleWGSL({ pass: 'capture', material, capture: { directive: optics.captureDirective, tail: (options) => optics.captureTail(options) } });
  const capture = await optics.captureComposed({ source, vertex: { entryPoint: 'continuumCaptureVS', buffers: CONTINUUM_ENTRY_LAYOUT }, groups: 3 });
  return { ...capture, material };
}
// A capture's groups for a family, from its view's: `main` its group 0's entries, `shadows` the shadow set it is lit by
// (group 1). `draw(pass, scenes, above)` then draws each scene's coarse cut.
export function continuumCaptureDraw(capture, main, shadows) {
  if (!capture) return null;
  const g0 = capture.bindGroup(main, 0), g1 = shadows.bind(capture.pipeline), groups = new WeakMap(), { group } = capture.material.data;
  return {
    draw(pass, scenes, above = false) {
      const drawn = scenes.filter((scene) => scene?.count);
      if (!drawn.length) return;
      capture.bind(pass, above);
      pass.setBindGroup(0, g0); pass.setBindGroup(1, g1);
      for (const scene of drawn) {
        if (!groups.has(scene)) groups.set(scene, scene.dataGroup(capture.pipeline, capture.material));
        pass.setBindGroup(group, groups.get(scene));
        scene.drawCoarse(pass);
      }
    },
  };
}

// A family's baked atlas, fetched once a device by `load` (resolving to { manifest, words }) and uploaded, with what
// each of its types can enter in the lists (continuumAtlasTypes).
export function requestContinuumAtlas(device, label, load) {
  return requestOnce(device, `${label} continuum atlas`, async () => {
    const { manifest, words } = await load();
    return { manifest, words, types: continuumAtlasTypes(words), buffer: uploadContinuumAtlas(device, words, label) };
  });
}
export function uploadContinuumAtlas(device, words, label) {
  const buffer = device.createBuffer({ label: `${label} continuum atlas`, size: words.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, words);
  return buffer;
}

// Where a scene of `capacity` instances keeps its lists in its one list buffer: two entries an instance ahead of them
// hold its state for the frame, then each list's [first entry, room], in CONTINUUM_LISTS order.
export function continuumListLayout(capacity, room) {
  const lists = [];
  let entries = capacity * 2;
  for (const n of room) { const k = Math.max(1, n); lists.push([entries, k]); entries += k; }
  return { lists, entries };
}

// One scene of the one cut. `capacity` instances and `room` each list's (js/continuum-format.js continuumRoom); `view`
// its material's view (requestContinuumView), or none for a scene only cast into the shadow map; `poses` the buffer its
// records' pose data lie in (a family's shard flights, joint palettes), or else `poseRoom` vec4f of its own, which
// `writePoses` fills; `frame` and `shadowUniform` the frame's and the land shadow's uniforms. Every family's instances
// are the same record: `words` and `floats` hold them on the CPU, `place` writes one, `send` uploads a range. A scene
// `written` on the GPU (a family's own pass stands its records each frame, encode's `indirect`) keeps none on the CPU.
export function createContinuumScene({ device, atlas, programs: P, capacity, room, view = null, poses = null, poseRoom = 1, frame, shadowUniform, samples = 4, label, written = false }) {
  const B = GPUBufferUsage, W = CONTINUUM_RECORD_WORDS, packed = CONTINUUM_RECORD.packed;
  const { lists, entries } = continuumListLayout(capacity, room);
  const words = new Uint32Array((written ? 1 : Math.max(1, capacity)) * W), floats = new Float32Array(words.buffer);
  const onCPU = () => { if (written) throw Error(`The ${label} scene's records are written on the GPU`); };
  const records = device.createBuffer({ label: `${label} continuum records`, size: Math.max(1, capacity) * W * 4, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
  const ownPoses = poses ? null : device.createBuffer({ label: `${label} continuum poses`, size: Math.max(1, poseRoom) * 16, usage: B.STORAGE | B.COPY_DST });
  const list = device.createBuffer({ label: `${label} continuum lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} continuum draws`, size: CONTINUUM_DRAWS_BYTES, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const viewBuffer = device.createBuffer({ label: `${label} continuum view`, size: CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const viewWords = new Uint32Array(CONTINUUM_VIEW_BYTES / 4), viewFloats = new Float32Array(viewWords.buffer);
  viewWords.set([0, samples, 1, 0], 0);
  lists.forEach(([at, n], i) => viewWords.set([at, n, 0, 0], 8 + i * 4));
  const aimAt = 8 + CONTINUUM_LISTS.length * 4;
  let viewChanged = true;
  const setWord = (at, value) => { if (viewWords[at] !== value) { viewWords[at] = value; viewChanged = true; } };
  const setFloat = (at, value) => { if (viewFloats[at] !== Math.fround(value)) { viewFloats[at] = value; viewChanged = true; } };

  const group = (layout, resources) => device.createBindGroup({ layout, entries: resources.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const data = [atlas.buffer, records, list, viewBuffer, poses ?? ownPoses];
  if (data.length !== CONTINUUM_DATA_BINDINGS) throw Error('A continuum scene binds the wrong data');
  const dataGroupFor = (pipeline, material) => group(pipeline.getBindGroupLayout(material.data.group), data.map((buffer, i) => [material.data.binding + i, buffer]));
  const cut = device.createBindGroup({
    layout: P.computeLayout,
    entries: [...[[0, frame], [1, shadowUniform], ...data.map((buffer, i) => [2 + i, buffer]), [7, draws]].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      { binding: CONTINUUM_GROUND_BINDING, resource: continuumGroundView(device) }],
  });
  const drawn = view ? dataGroupFor(view.pipeline, view.material) : null;
  const shadowGroups = [group(P.shadow.getBindGroupLayout(0), [[0, shadowUniform], [1, frame]]), group(P.shadow.getBindGroupLayout(1), data.map((buffer, i) => [i, buffer]))];
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * 16);
  };
  let count = 0, destroyed = false;
  const scene = {
    capacity, lists, list, draws, records, words, floats, poses: poses ?? ownPoses,
    get count() { return count; },
    // Instance `index`'s record (js/continuum-format.js writeContinuumRecord), on the CPU until sent.
    place(index, record) { onCPU(); writeContinuumRecord(words, floats, index, record); },
    // Instances `first`..`first + n` sent as they now stand.
    send(first = 0, n = count) {
      if (destroyed || n <= 0) return;
      onCPU();
      device.queue.writeBuffer(records, first * W * 4, words, first * W, n * W);
    },
    // Its own pose buffer's vec4f from `at`, written.
    writePoses(at, values) { if (!destroyed && ownPoses) device.queue.writeBuffer(ownPoses, at * 16, values); },
    // Flag `bit` of instances `index`..`index + n` set or cleared, sent only where it changed.
    flag(index, n, bit, on) {
      if (!(index >= 0) || index >= capacity) return;
      onCPU();
      const end = Math.min(capacity, index + n);
      let first = -1, last = -1;
      for (let i = index; i < end; i++) {
        const at = i * W + packed, word = (on ? words[at] | bit : words[at] & ~bit) >>> 0;
        if (word !== words[at]) { words[at] = word; if (first < 0) first = i; last = i; }
      }
      if (first >= 0) scene.send(first, last - first + 1);
    },
    flagged(index, bit) { return (words[index * W + packed] & bit) !== 0; },
    setCount(n) { count = Math.max(0, Math.min(capacity, n)); setWord(0, count); },
    setWorldOffset(x, z) { setFloat(5, x); setFloat(6, z); },
    setShadows(on) { setWord(2, on ? 1 : 0); },
    // Where the player's guns would fall now, in the scene's frame, and how far about it (js/gunnery-control.js
    // aimSummary.fall): every instance within it is cut finer. A radius of 0, or none, aims at nothing.
    setAim(fall) {
      const on = fall && fall.radius > 0;
      setFloat(aimAt, on ? fall.x : 0); setFloat(aimAt + 1, on ? fall.y : 0); setFloat(aimAt + 2, on ? fall.z : 0); setFloat(aimAt + 3, on ? fall.radius : 0);
    },
    // In the frame's compute pass, before any pass draws: the lists emptied, then every instance cut at the scene's
    // one pixel error (js/continuum-core.js), which only a governor moves. `indirect` ({ buffer, offset }): a family's
    // own pass listed its records this frame, and wrote the cut's workgroups there (CONTINUUM_ROW a row, every record
    // of the last row past its own marked GONE); its count is then the scene's capacity.
    encode(pass, indirect = null) {
      if (destroyed) return;
      setFloat(4, continuumPixelError());
      if (viewChanged) { device.queue.writeBuffer(viewBuffer, 0, viewWords); viewChanged = false; }
      pass.setBindGroup(0, cut);
      pass.setPipeline(P.reset);
      pass.dispatchWorkgroups(1);
      if (!count) return;
      pass.setPipeline(P.select);
      if (indirect) pass.dispatchWorkgroupsIndirect(indirect.buffer, indirect.offset ?? 0);
      else pass.dispatchWorkgroups(Math.min(count, CONTINUUM_ROW), Math.ceil(count / CONTINUUM_ROW));
    },
    // The view's four lists, one pipeline. `sceneGroup` and `second` are the material's groups 0 and 1.
    draw(pass, sceneGroup, second) {
      if (destroyed || !count || !drawn) return;
      pass.setPipeline(view.pipeline);
      pass.setBindGroup(0, sceneGroup); pass.setBindGroup(1, second); pass.setBindGroup(view.material.data.group, drawn);
      for (let index = 0; index < CONTINUUM_VIEW_LISTS; index++) drawList(pass, index);
    },
    drawShadow(pass) {
      if (destroyed || !count) return;
      pass.setPipeline(P.shadow);
      pass.setBindGroup(0, shadowGroups[0]); pass.setBindGroup(1, shadowGroups[1]);
      scene.drawCoarse(pass);
    },
    // The shadow map's lists, the coarse cut it casts, by whatever pipeline and groups are bound: the shadow's own, or
    // an under-water capture of the material's view, whose data group `dataGroup` makes.
    drawCoarse(pass) {
      if (destroyed || !count) return;
      for (let index = CONTINUUM_VIEW_LISTS; index < CONTINUUM_LISTS.length; index++) drawList(pass, index);
    },
    dataGroup: dataGroupFor,
    // For the continuum census (js/continuum-census.js): the real triangles the select listed for the view.
    continuumDraws() { return !destroyed && count ? [{ buffer: draws, offset: CONTINUUM_DRAW_WORDS * 4, records: CONTINUUM_VIEW_LISTS, stride: 1 }] : []; },
    destroy() { destroyed = true; for (const resource of [records, ownPoses, list, draws, viewBuffer]) resource?.destroy(); },
  };
  return scene;
}
