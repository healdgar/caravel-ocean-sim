// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one cut's scenes and programs (AGENTS.md rule 3; js/continuum-format.js for the data, js/wgsl/continuum-cut.js
// for the WGSL). A scene is a set of instances of one atlas's types, every one a record of the one format. The CPU
// writes a record when an instance is placed, struck, broken or moved (or a family's own compute pass stands its
// records each frame), and the view's few numbers when they change; every frame the GPU empties the lists, cuts every
// instance at the scene's one pixel error, and each list is drawn with one indirect call. Every family's scene is cut
// by the same select and cast by the same shadow program (or its material's part of it); each family's material has
// its view (and, if it is seen under water, its capture) composed by the one composer.
import { requestOnce } from './gpu-program-cache.js';
import { continuumPixelError, packContinuumProfile } from './continuum-core.js';
import { continuumProfile } from './continuum-profiles.js';
import { continuumGroundView } from './continuum-ground.js';
import { continuumHiZView, continuumHiZUniform, CONTINUUM_HIZ_TEXTURE_BINDING, CONTINUUM_HIZ_UNIFORM_BINDING } from './continuum-hiz.js';
import {
  CONTINUUM_HEADER, CONTINUUM_RECORD_WORDS, CONTINUUM_RECORD, CONTINUUM_LISTS, CONTINUUM_VIEW_LISTS, CONTINUUM_CHUNK_TRIANGLES,
  writeContinuumRecord, continuumAtlasTypes, continuumAtlasTotalWords, continuumAtlasMetaWords, buildContinuumClusterCones, buildContinuumSurfels,
} from './continuum-format.js';
import {
  CONTINUUM_ENTRY_LAYOUT, CONTINUUM_DRAW_WORDS, CONTINUUM_DRAWS_BYTES, CONTINUUM_VIEW_BYTES, CONTINUUM_ROW, CONTINUUM_BATCH, CONTINUUM_STATE_ENTRIES,
  CONTINUUM_GROUND_BINDING, CONTINUUM_SELECT_PAGES_AT, CONTINUUM_SHADOW_CLOTH_FORMAT, continuumDataBindings, continuumModuleWGSL, continuumBatchArgsWGSL,
} from './wgsl/continuum-cut.js';

// An atlas is bound in pages no larger than the device binds, each a power of two of words, so the cut's one accessor
// finds a word's page by a shift. An atlas takes as many pages as it needs, and its programs bind as many: an atlas
// that fits one page (every family's on a device that binds 512 MiB) costs no binding more. Four pages at most: the
// select's storage buffers are the atlas's pages, the records, the lists, the poses and the draws, eight in all.
export const CONTINUUM_ATLAS_PAGES = 4;
const continuumPagings = new WeakMap();
// The paging of an atlas of `pages` pages on `device`: { pages, shift, pageWords }, one object a device and count.
export function continuumAtlasPaging(device, pages = 1) {
  if (!(pages >= 1 && pages <= CONTINUUM_ATLAS_PAGES)) throw Error(`A continuum atlas is bound in 1 to ${CONTINUUM_ATLAS_PAGES} pages, not ${pages}`);
  let made = continuumPagings.get(device);
  if (!made) {
    const bytes = Math.min(device.limits?.maxStorageBufferBindingSize ?? 2 ** 31, device.limits?.maxBufferSize ?? 2 ** 31);
    const shift = Math.min(31, Math.floor(Math.log2(bytes / 4)));
    made = Array.from({ length: CONTINUUM_ATLAS_PAGES }, (_, p) => Object.freeze({ pages: p + 1, shift, pageWords: 2 ** shift }));
    continuumPagings.set(device, made);
  }
  return made[pages - 1];
}
// How many pages an atlas of `words` (Uint32Array or word count) takes on `device`.
export function continuumAtlasPages(device, words) {
  const total = typeof words === 'number' ? words : continuumAtlasTotalWords(words);
  const { pageWords } = continuumAtlasPaging(device);
  const pages = Math.max(1, Math.ceil(total / pageWords));
  if (pages > CONTINUUM_ATLAS_PAGES) throw Error(`A continuum atlas of ${total * 4} bytes is larger than the ${CONTINUUM_ATLAS_PAGES} pages of ${pageWords * 4} bytes this device binds`);
  return pages;
}

// One shadow program: the kernel's (`material` null) or a material's `part` of its own (its cut leaves, its canvas).
async function requestContinuumShadow({ device, shader, material = null, part = 'whole', shadowFormat, paging }) {
  const label = material ? `${material.name} shadow ${part}` : 'continuum shadow';
  const module = await shader(continuumModuleWGSL({ pass: 'shadow', material, part, paging }), label);
  const pipeline = await device.createRenderPipelineAsync({
    label, layout: 'auto',
    vertex: { module, entryPoint: 'continuumShadowVS', buffers: CONTINUUM_ENTRY_LAYOUT },
    fragment: { module, entryPoint: 'continuumShadowFS', targets: part === 'canvas' ? [{ format: CONTINUUM_SHADOW_CLOTH_FORMAT }] : [] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
  });
  return { pipeline, own: Boolean(material?.shadow?.own) };
}

// The select and the shadow map's program, one set a device, shadow format and atlas paging for every family. `pages`
// (or a promise of it) is how many its atlas takes (continuumAtlasPages; an uploaded atlas's `pages.length`).
export async function requestContinuumPrograms({ device, shader, shadowFormat, pages = 1 }) {
  const paging = continuumAtlasPaging(device, await pages);
  return requestOnce(device, `continuum programs ${shadowFormat}${paging.pages > 1 ? ` ${paging.pages} pages` : ''}`, async () => {
    const [selectModule, batchModule, shadow] = await Promise.all([
      shader(continuumModuleWGSL({ pass: 'select', paging }), 'continuum cut'), shader(continuumBatchArgsWGSL(), 'continuum batches'),
      requestContinuumShadow({ device, shader, shadowFormat, paging }),
    ]);
    const C = GPUShaderStage.COMPUTE, entry = (binding, buffer) => ({ binding, visibility: C, buffer: { type: buffer } });
    // One layout for the reset and the cut, so one bind group serves both; the cut reads the land's ground field and Hi-Z pyramid.
    const computeLayout = device.createBindGroupLayout({
      label: 'continuum cut', entries: [entry(0, 'uniform'), entry(1, 'uniform'), entry(2, 'read-only-storage'), entry(3, 'read-only-storage'), entry(4, 'storage'), entry(5, 'uniform'), entry(6, 'read-only-storage'), entry(7, 'storage'),
        { binding: CONTINUUM_GROUND_BINDING, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
        ...Array.from({ length: paging.pages - 1 }, (_, p) => entry(CONTINUUM_SELECT_PAGES_AT + p, 'read-only-storage')),
        { binding: CONTINUUM_HIZ_TEXTURE_BINDING, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        entry(CONTINUUM_HIZ_UNIFORM_BINDING, 'uniform')],
    });
    const layout = device.createPipelineLayout({ label: 'continuum cut', bindGroupLayouts: [computeLayout] });
    const [reset, select, batches] = await Promise.all([
      device.createComputePipelineAsync({ label: 'continuum reset', layout, compute: { module: selectModule, entryPoint: 'continuumReset' } }),
      device.createComputePipelineAsync({ label: 'continuum cut', layout, compute: { module: selectModule, entryPoint: 'continuumSelect' } }),
      device.createComputePipelineAsync({ label: 'continuum batches', layout: 'auto', compute: { module: batchModule, entryPoint: 'continuumBatchArgs' } }),
    ]);
    return { reset, select, batches, shadow, computeLayout, paging };
  });
}

// In-pass TBDR visibility prepass (AGENTS.md rule 2): lays exact per-sample depth with @builtin(sample_mask) and
// writeMask: 0 so the main material shader can run at depthCompare: 'equal' with zero sample_mask and full hardware HSR.
function requestContinuumVisibility({ device, shader, format, samples, cullMode, paging }) {
  return requestOnce(device, `continuum visibility ${format} ${samples} ${cullMode}${paging.pages > 1 ? ` ${paging.pages} pages` : ''}`, async () => {
    const module = await shader(continuumModuleWGSL({ pass: 'visibility', paging }), 'continuum visibility');
    const pipeline = await device.createRenderPipelineAsync({
      label: 'continuum visibility', layout: 'auto',
      vertex: { module, entryPoint: 'continuumVisibilityVS', buffers: CONTINUUM_ENTRY_LAYOUT },
      fragment: { module, entryPoint: 'continuumVisibilityFS', targets: [{ format, writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    });
    return { pipeline };
  });
}

// A material's view: { pipeline, equalPipeline, visibility, material, shadows, paging }, one a device, material, target
// format, sample count and atlas paging (`pages`, as requestContinuumPrograms has it). A material with a shadow of its
// own (its `shadow`) has its parts' programs in `shadows` ('whole', or 'solid' and 'canvas'), cast into maps of
// `shadowFormat`. When `material.visibility` is true, `visibility` lays per-sample depth first so shading runs at
// `depthCompare: 'equal'` without `@builtin(sample_mask)`.
export async function requestContinuumView({ device, shader, material, format, samples, shadowFormat = 'depth32float', pages = 1 }) {
  const paging = continuumAtlasPaging(device, await pages);
  return requestOnce(device, `continuum view ${material.name} ${format} ${samples}${paging.pages > 1 ? ` ${paging.pages} pages` : ''}`, async () => {
    const parts = !material.shadow ? [] : material.shadow.canvas ? ['solid', 'canvas'] : ['whole'];
    const useVisibility = Boolean(material.visibility && !material.heightfield);
    const pureEqual = useVisibility && !material.mask && !material.coverage;
    const [module, visibility, ...cast] = await Promise.all([
      shader(continuumModuleWGSL({ pass: 'view', material, paging }), `${material.name} view`),
      useVisibility ? requestContinuumVisibility({ device, shader, format, samples, cullMode: material.cullMode, paging }) : Promise.resolve(null),
      ...parts.map((part) => requestContinuumShadow({ device, shader, material, part, shadowFormat, paging })),
    ]);
    const makePipe = (equal) => device.createRenderPipelineAsync({
      label: `${material.name} view`, layout: 'auto',
      vertex: { module, entryPoint: 'continuumVS', buffers: material.entryLayout ?? CONTINUUM_ENTRY_LAYOUT },
      fragment: { module, entryPoint: equal ? 'continuumEqualFS' : 'continuumFS', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: material.cullMode },
      depthStencil: { format: 'depth32float', depthWriteEnabled: !equal, depthCompare: equal ? 'equal' : 'greater' },
      multisample: { count: samples },
    });
    const [pipeline, equalPipeline] = await Promise.all([
      makePipe(pureEqual),
      useVisibility && !pureEqual ? makePipe(true) : Promise.resolve(null),
    ]);
    return {
      pipeline, equalPipeline: equalPipeline ?? (pureEqual ? pipeline : null), visibility, pureEqual,
      material, paging, shadows: Object.fromEntries(parts.map((part, i) => [part, cast[i]])),
    };
  });
}

// A material's view under water: single-sampled, its fragment cut by the water's own capture (js/water-optics.js),
// drawing the coarse cut the shadow map's lists hold, as the sea blurs anything finer. Null without the water's optics.
// `pages` as requestContinuumPrograms has it.
export async function requestContinuumCapture(waterOptics, material, pages = 1) {
  const optics = await waterOptics;
  if (!optics) return null;
  const paging = continuumAtlasPaging(optics.device, await pages);
  const source = continuumModuleWGSL({ pass: 'capture', material, paging, capture: { directive: optics.captureDirective, tail: (options) => optics.captureTail(options) } });
  const capture = await optics.captureComposed({ source, vertex: { entryPoint: 'continuumCaptureVS', buffers: material.entryLayout ?? CONTINUUM_ENTRY_LAYOUT }, groups: 3 });
  return { ...capture, material, paging };
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
        if (scene.paging !== capture.paging) throw Error(`The ${capture.material.name} capture binds ${capture.paging.pages} atlas pages, its scene ${scene.paging.pages}`);
        if (!groups.has(scene)) groups.set(scene, scene.dataGroup(capture.pipeline, capture.material));
        pass.setBindGroup(group, groups.get(scene));
        scene.drawCaptureLists(pass);
      }
    },
  };
}

// A family's baked atlas, fetched once a device by `load` (resolving to { manifest, words }) and uploaded.
// Releases the full CPU vertex/index/stream word array immediately after GPU upload, retaining only the compact
// header + types + clusters prefix (<2%) needed by card baking and metadata readers.
export function requestContinuumAtlas(device, label, load, options = {}) {
  return requestOnce(device, `${label} continuum atlas`, async () => {
    const { manifest, words } = await load();
    const uploaded = uploadContinuumAtlas(device, words, label, options);
    const metaWords = continuumAtlasMetaWords(words);
    return { manifest, words: metaWords, atlasBytes: words.byteLength, ...uploaded };
  });
}
const CONTINUUM_UPLOAD_CHUNK_WORDS = 4 * 1024 * 1024; // 16 MiB chunks prevent large IPC staging spikes in WebKit
function writeBufferChunked(device, buffer, dstByteOffset, src, startWord, endWord) {
  for (let at = startWord; at < endWord; at += CONTINUUM_UPLOAD_CHUNK_WORDS) {
    const next = Math.min(endWord, at + CONTINUUM_UPLOAD_CHUNK_WORDS);
    device.queue.writeBuffer(buffer, dstByteOffset + (at - startWord) * 4, src.subarray(at, next));
  }
}
// Isolated factory so the returned destroy() closure never captures uploadContinuumAtlas's `words`, `cones`, or `surfels`
// buffers in a shared JS engine function context (which would otherwise pin 100-800 MB of raw CPU atlas words forever).
function makeAtlasDestroy(pages) {
  return function destroy() { for (const page of pages) page.destroy(); };
}
// An atlas on the GPU, in as many pages as the device needs to bind it (continuumAtlasPages), with what each of its
// types can enter in the lists (continuumAtlasTypes): { pages, buffer (the first page, which holds its header and
// types), types, destroy() }. Every scene of the one cut binds its atlas so, with programs of as many pages.
// Appends per-cluster normal cones and optional universal prefix micro-surfels directly into GPU upload pages.
export function uploadContinuumAtlas(device, words, label, { surfels = false } = {}) {
  const needCones = words[CONTINUUM_HEADER.cones] === 0 && words[CONTINUUM_HEADER.clusterCount] > 0;
  const cones = needCones ? buildContinuumClusterCones(words) : null;
  const conesAt = cones ? words.length : words[CONTINUUM_HEADER.cones];
  const afterCones = cones ? words.length + cones.length : words.length;
  const needSurfels = Boolean(surfels) && words[CONTINUUM_HEADER.surfels] === 0 && words[CONTINUUM_HEADER.clusterCount] > 0;
  const surfelBuild = needSurfels ? buildContinuumSurfels(words, typeof surfels === 'object' ? surfels : {}) : null;
  const surfelWords = surfelBuild?.words?.length ? surfelBuild.words : null;
  const surfelsAt = surfelWords ? afterCones : words[CONTINUUM_HEADER.surfels];
  const totalWords = surfelWords ? afterCones + surfelWords.length : afterCones;
  const count = continuumAtlasPages(device, totalWords), { pageWords } = continuumAtlasPaging(device, count);
  const segments = [[0, words]];
  if (cones) segments.push([words.length, cones]);
  if (surfelWords) segments.push([afterCones, surfelWords]);
  const pages = [];
  for (let p = 0; p < count; p++) {
    const pageStart = p * pageWords;
    const pageEnd = Math.min(totalWords, (p + 1) * pageWords);
    const buffer = device.createBuffer({ label: `${label} continuum atlas${count > 1 ? ` page ${p}` : ''}`, size: (pageEnd - pageStart) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    for (const [segStart, arr] of segments) {
      const s0 = Math.max(pageStart, segStart);
      const s1 = Math.min(pageEnd, segStart + arr.length);
      if (s0 < s1) {
        writeBufferChunked(device, buffer, (s0 - pageStart) * 4, arr, s0 - segStart, s1 - segStart);
      }
    }
    if (p === 0 && cones) {
      device.queue.writeBuffer(buffer, CONTINUUM_HEADER.cones * 4, new Uint32Array([conesAt]));
    }
    if (p === 0 && surfelWords) {
      device.queue.writeBuffer(buffer, CONTINUUM_HEADER.surfels * 4, new Uint32Array([surfelsAt]));
    }
    pages.push(buffer);
  }
  const types = continuumAtlasTypes(words);
  if (surfelBuild?.counts) {
    for (let t = 0; t < types.length; t++) {
      const sc = surfelBuild.counts[t];
      if (sc > 0) types[t].farChunks = Math.max(types[t].farChunks, Math.ceil(sc / CONTINUUM_CHUNK_TRIANGLES));
    }
  }
  return { pages, buffer: pages[0], types, destroy: makeAtlasDestroy(pages) };
}

// Where a scene of `capacity` instances keeps its lists in its one list buffer: CONTINUUM_STATE_ENTRIES entries an
// instance ahead of them hold its state for the frame, then each list's [first entry, room], in CONTINUUM_LISTS order.
// A device that cannot bind so large a buffer has each list's room cut in proportion: the budget's governor then holds
// the scene within what is left (js/wgsl/continuum-cut.js).
export function continuumListLayout(capacity, room, mostBytes = Infinity) {
  const ahead = capacity * CONTINUUM_STATE_ENTRIES, wanted = room.reduce((sum, n) => sum + Math.max(1, n), 0);
  const fit = Math.min(1, (Math.floor(mostBytes / 8) - ahead) / wanted);
  if (!(fit > 0)) throw Error(`A continuum scene of ${capacity} instances is larger than this device can bind`);
  const lists = [];
  let entries = ahead;
  for (const n of room) { const k = Math.max(1, Math.floor(Math.max(1, n) * fit)); lists.push([entries, k]); entries += k; }
  return { lists, entries };
}

// One scene of the one cut. `capacity` instances and `room` each list's (js/continuum-format.js continuumRoom); `atlas`
// its uploaded atlas (uploadContinuumAtlas); `view` its material's view (requestContinuumView), or none for a scene only
// cast into the shadow map; `poses` the buffer its records' pose data lie in (a family's shard flights, joint palettes),
// or else `poseRoom` vec4f of its own, which `writePoses` fills; `frame` and `shadowUniform` the frame's and the shadow's
// uniforms. Every family's instances are the same record: `words` and `floats` hold them on the CPU, `place` writes
// one, `send` uploads a range. A scene `written` on the GPU (a family's own pass stands its records each frame,
// encode's `indirect`) keeps none on the CPU.
export function createContinuumScene({ device, atlas, programs: P, capacity, room, view = null, poses = null, poseRoom = 1, frame, shadowUniform, samples = 4, label, written = false, profile = null }) {
  const B = GPUBufferUsage, W = CONTINUUM_RECORD_WORDS, packed = CONTINUUM_RECORD.packed;
  const { paging } = P;
  if (!atlas?.pages?.length) throw Error(`The ${label} scene's atlas is not uploaded (uploadContinuumAtlas)`);
  if (atlas.pages.length !== paging.pages || (view && view.paging !== paging)) throw Error(`The ${label} scene's atlas takes ${atlas.pages.length} pages; its programs bind ${paging.pages}${view ? ` and its view ${view.paging.pages}` : ''} (request them with its pages)`);
  const { lists, entries } = continuumListLayout(capacity, room, Math.min(device.limits?.maxStorageBufferBindingSize ?? Infinity, device.limits?.maxBufferSize ?? Infinity));
  const words = new Uint32Array((written ? 1 : Math.max(1, capacity)) * W), floats = new Float32Array(words.buffer);
  const onCPU = () => { if (written) throw Error(`The ${label} scene's records are written on the GPU`); };
  const records = device.createBuffer({ label: `${label} continuum records`, size: Math.max(1, capacity) * W * 4, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
  const ownPoses = poses ? null : device.createBuffer({ label: `${label} continuum poses`, size: Math.max(1, poseRoom) * 16, usage: B.STORAGE | B.COPY_DST });
  const list = device.createBuffer({ label: `${label} continuum lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} continuum draws`, size: CONTINUUM_DRAWS_BYTES, usage: B.STORAGE | B.INDIRECT | B.COPY_SRC });
  const viewBuffer = device.createBuffer({ label: `${label} continuum view`, size: CONTINUUM_VIEW_BYTES, usage: B.UNIFORM | B.COPY_DST });
  // The select's workgroups for what a family's own pass stood, made from its count on the GPU.
  const batches = written ? device.createBuffer({ label: `${label} continuum batches`, size: 16, usage: B.STORAGE | B.INDIRECT }) : null;
  const viewWords = new Uint32Array(CONTINUUM_VIEW_BYTES / 4), viewFloats = new Float32Array(viewWords.buffer);
  const singleSided = view?.material?.cullMode === 'back' ? 0x80000000 : 0;
  viewWords.set([0, samples, 1, (((view?.material?.salt ?? 0) & 0x7fffffff) | singleSided) >>> 0], 0);
  lists.forEach(([at, n], i) => viewWords.set([at, n, 0, 0], 8 + i * 4));
  const aimAt = 8 + CONTINUUM_LISTS.length * 4;
  const curveAt = aimAt + 4;
  const profileScratch = new Float32Array(8);
  let profileSpec = profile;
  let viewChanged = true;
  const setWord = (at, value) => { if (viewWords[at] !== value) { viewWords[at] = value; viewChanged = true; } };
  const setFloat = (at, value) => { if (viewFloats[at] !== Math.fround(value)) { viewFloats[at] = value; viewChanged = true; } };
  const syncProfile = () => {
    packContinuumProfile(continuumProfile(profileSpec), profileScratch, 0);
    for (let k = 0; k < 8; k++) setFloat(curveAt + k, profileScratch[k]);
  };
  syncProfile();

  const group = (layout, resources) => device.createBindGroup({ layout, entries: resources.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  // The scene's data, as every program binds it from its first binding, the further pages from `pagesAt`.
  const data = [atlas.pages[0], records, list, viewBuffer, poses ?? ownPoses];
  const further = atlas.pages.slice(1);
  const dataAt = (first, pagesAt = first + data.length) => [...data.map((buffer, i) => [first + i, buffer]), ...further.map((buffer, p) => [pagesAt + p, buffer])];
  if (dataAt(0).length !== continuumDataBindings(paging)) throw Error('A continuum scene binds the wrong data');
  const dataGroupFor = (pipeline, material) => group(pipeline.getBindGroupLayout(material.data.group), dataAt(material.data.binding));
  const cut = device.createBindGroup({
    layout: P.computeLayout,
    entries: [...[[0, frame], [1, shadowUniform], ...dataAt(2, CONTINUUM_SELECT_PAGES_AT), [7, draws]].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      { binding: CONTINUUM_GROUND_BINDING, resource: continuumGroundView(device) },
      { binding: CONTINUUM_HIZ_TEXTURE_BINDING, resource: continuumHiZView(device) },
      { binding: CONTINUUM_HIZ_UNIFORM_BINDING, resource: { buffer: continuumHiZUniform(device) } }],
  });
  const batching = batches ? new WeakMap() : null;
  const batchGroup = (stood) => {
    if (!batching.has(stood)) batching.set(stood, group(P.batches.getBindGroupLayout(0), [[0, stood], [1, batches], [2, draws], [3, viewBuffer]]));
    return batching.get(stood);
  };
  const drawn = view ? dataGroupFor(view.pipeline, view.material) : null;
  const equalDrawn = view?.equalPipeline && view.equalPipeline !== view.pipeline ? dataGroupFor(view.equalPipeline, view.material) : drawn;
  const visibilityGroups = view?.visibility
    ? { frame: group(view.visibility.pipeline.getBindGroupLayout(0), [[0, frame]]), data: group(view.visibility.pipeline.getBindGroupLayout(1), dataAt(0)) }
    : null;
  // Each shadow program's groups: the frame's two uniforms, the data, and its material's own (`own`, from its family).
  const shadowGroups = new Map();
  const shadowGroupsFor = (program, own) => {
    let groups = shadowGroups.get(program);
    if (!groups) {
      groups = { frame: group(program.pipeline.getBindGroupLayout(0), [[0, shadowUniform], [1, frame]]), data: group(program.pipeline.getBindGroupLayout(1), dataAt(0)), own: null, from: null };
      shadowGroups.set(program, groups);
    }
    if (program.own && groups.from !== own) {
      if (!own) throw Error(`The ${label} scene's shadow needs its material's own bindings`);
      groups.own = device.createBindGroup({ layout: program.pipeline.getBindGroupLayout(2), entries: own });
      groups.from = own;
    }
    return groups;
  };
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * 16);
  };
  let count = 0, destroyed = false, cards = null;
  const drawCards = (pass) => {
    if (!cards) return;
    pass.setPipeline(cards.renderer.pipeline);
    pass.setBindGroup(0, cards.bindings.sceneGroup);
    pass.setBindGroup(1, cards.bindings.cloudGroup);
    pass.setBindGroup(2, cards.dataGroup);
    pass.setBindGroup(3, cards.atlas.bindGroup);
    drawList(pass, CONTINUUM_VIEW_LISTS - 1);
  };
  const scene = {
    capacity, lists, list, draws, records, words, floats, poses: poses ?? ownPoses, paging,
    get count() { return count; },
    get hasCards() { return Boolean(cards); },
    // Attaches (or clears) a baked octahedral G-buffer card atlas (js/continuum-cards.js) for list 3.
    // Ownership of `cardAtlas` stays with the caller (so scene resize/recreation can re-attach the same atlas).
    setCards(cardAtlas, cardRenderer, cardBindings) {
      if (destroyed) return;
      if (!cardAtlas || !cardRenderer || !cardBindings) {
        cards = null;
        setFloat(7, 0);
        return;
      }
      if (cardRenderer.paging !== paging) throw Error(`Card renderer paging (${cardRenderer.paging.pages}) does not match ${label} scene (${paging.pages})`);
      const dataGroup = group(cardRenderer.pipeline.getBindGroupLayout(2), dataAt(0));
      cards = { atlas: cardAtlas, renderer: cardRenderer, bindings: cardBindings, dataGroup };
      setFloat(7, 1);
    },
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
    setProfile(next) { profileSpec = next; syncProfile(); },
    // In the frame's compute pass, before any pass draws: the lists emptied, then every instance cut at the scene's
    // one pixel error (js/continuum-core.js), which only a governor moves, CONTINUUM_BATCH instances a workgroup.
    // `indirect` ({ buffer }): a written scene's family stood its records this frame in its own pass and counted them
    // in that buffer's fourth word (its first three, its own workgroups, are not read); its count is then its capacity.
    encode(pass, indirect = null) {
      if (destroyed) return;
      setFloat(4, continuumPixelError());
      syncProfile();
      if (viewChanged) { device.queue.writeBuffer(viewBuffer, 0, viewWords); viewChanged = false; }
      pass.setBindGroup(0, cut);
      pass.setPipeline(P.reset);
      pass.dispatchWorkgroups(1);
      if (!count) return;
      if (indirect) {
        if (!batches) throw Error(`The ${label} scene's records are not written on the GPU`);
        pass.setPipeline(P.batches);
        pass.setBindGroup(0, batchGroup(indirect.buffer));
        pass.dispatchWorkgroups(1);
        pass.setBindGroup(0, cut);
        pass.setPipeline(P.select);
        pass.dispatchWorkgroupsIndirect(batches, 0);
        return;
      }
      const groups = Math.ceil(count / CONTINUUM_BATCH);
      pass.setPipeline(P.select);
      pass.dispatchWorkgroups(Math.min(groups, CONTINUUM_ROW), Math.ceil(groups / CONTINUUM_ROW));
    },
    drawVisibility(pass) {
      if (destroyed || !count || !visibilityGroups) return;
      pass.setPipeline(view.visibility.pipeline);
      pass.setBindGroup(0, visibilityGroups.frame); pass.setBindGroup(1, visibilityGroups.data);
      const limit = cards ? CONTINUUM_VIEW_LISTS - 1 : CONTINUUM_VIEW_LISTS;
      for (let index = 0; index < limit; index++) drawList(pass, index);
    },
    drawEqual(pass, sceneGroup, second) {
      if (destroyed || !count || !equalDrawn || !view?.equalPipeline) return;
      if (visibilityGroups) scene.drawVisibility(pass);
      pass.setPipeline(view.equalPipeline);
      pass.setBindGroup(0, sceneGroup); pass.setBindGroup(1, second); pass.setBindGroup(view.material.data.group, equalDrawn);
      const limit = cards ? CONTINUUM_VIEW_LISTS - 1 : CONTINUUM_VIEW_LISTS;
      for (let index = 0; index < limit; index++) drawList(pass, index);
      drawCards(pass);
    },
    // The view's four lists, one pipeline (with in-pass visibility first when the material is pure visibility-equal,
    // and the shared octahedral card pipeline for list 3 when cards are attached).
    // `sceneGroup` and `second` are the material's groups 0 and 1.
    draw(pass, sceneGroup, second) {
      if (destroyed || !count || !drawn) return;
      if (view.pureEqual && visibilityGroups) scene.drawVisibility(pass);
      pass.setPipeline(view.pipeline);
      pass.setBindGroup(0, sceneGroup); pass.setBindGroup(1, second); pass.setBindGroup(view.material.data.group, drawn);
      const limit = cards ? CONTINUUM_VIEW_LISTS - 1 : CONTINUUM_VIEW_LISTS;
      for (let index = 0; index < limit; index++) drawList(pass, index);
      drawCards(pass);
    },
    // Its coarse cut into a shadow map: `part` 'whole' (every surface), or into a ship's own maps 'solid' or 'canvas'
    // (js/shadows.js createVesselShadows). Its material's own shadow program casts it where it has one, its `own`
    // entries bound as that program's group 2; the kernel's casts the rest, and a material with no canvas casts nothing
    // into a canvas map.
    drawShadow(pass, { part = 'whole', own = null } = {}) {
      if (destroyed || !count) return;
      const program = view?.shadows?.[part] ?? (part === 'canvas' ? null : P.shadow);
      if (!program) return;
      const groups = shadowGroupsFor(program, own);
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, groups.frame); pass.setBindGroup(1, groups.data);
      if (program.own) pass.setBindGroup(2, groups.own);
      scene.drawCoarse(pass);
    },
    // The shadow map's lists, the coarse cut it casts, by whatever pipeline and groups are bound.
    drawCoarse(pass) {
      if (destroyed || !count) return;
      for (let index = CONTINUUM_VIEW_LISTS; index < CONTINUUM_LISTS.length; index++) drawList(pass, index);
    },
    // The camera view's body lists (clusters + far body, omitting horizon splats) for underwater/above-water refraction
    // capture so floating/submerged bodies are never culled by a shadow frustum or nighttime shadow disable.
    drawCaptureLists(pass) {
      if (destroyed || !count) return;
      for (let index = 0; index < CONTINUUM_VIEW_LISTS - 1; index++) drawList(pass, index);
    },
    dataGroup: dataGroupFor,
    // For the continuum census (js/continuum-census.js): the real triangles the scene's error asked of the view,
    // alongside the draw/list buffer so diagnostics can also read submitted hardware triangles, shadow cuts, and list fill.
    continuumDraws() {
      return !destroyed && count
        ? [{ buffer: draws, offset: CONTINUUM_DRAW_WORDS * 4, records: CONTINUUM_VIEW_LISTS, stride: 1, continuumScene: { buffer: draws, words: CONTINUUM_DRAWS_BYTES / 4, capacity, lists, label } }]
        : [];
    },
    destroy() { destroyed = true; for (const resource of [records, ownPoses, list, draws, viewBuffer, batches]) resource?.destroy(); },
  };
  return scene;
}
