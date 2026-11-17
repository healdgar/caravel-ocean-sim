// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People drawn through the one continuum (AGENTS.md rule 3). js/crew-continuum.js holds the baked format and
// js/wgsl/crew-continuum.js the GPU side; this fetches bodies, keeps each batch's lists and issues its draws.
//
// A body is fetched once a device, in two steps. First its manifest, cut tables, far body and posing rig, small
// enough to wait for: from then on everyone wearing it is drawn by the far body and the splat. Then its full mesh
// and picture, after which the GPU cuts each person by projected error. A batch of people who share a body and a
// joint buffer runs one compute workgroup a person each frame and issues six indirect draws; the CPU writes only
// each person's orders and the batch's uniform.
import { loadCrewGLB } from './gltf.js';
import { requestOnce } from './gpu-program-cache.js';
import { CONTINUUM_TRIANGLE_BUDGET, continuumPixelError } from './continuum-core.js';
import {
  CREW_CONTINUUM_ASSETS, CREW_CONTINUUM_BODIES, CREW_CONTINUUM_CLUSTER_WORDS, CREW_CONTINUUM_REGIONS, CREW_CONTINUUM_VERTEX_WORDS,
  validateCrewContinuumManifest,
} from './crew-continuum.js';
import {
  CREW_CONTINUUM_ENTRY_LAYOUT, CREW_CONTINUUM_INSTANCE_VERTICES, CREW_CONTINUUM_LISTS,
  crewContinuumPoseWGSL, crewContinuumRenderWGSL, crewContinuumSelectWGSL, crewContinuumShadowWGSL,
} from './wgsl/crew-continuum.js';
import { CREW_JOINT_COUNT } from './crew-skeleton.js';

// What the GPU is told of a person, beside their joints and actor record (crewOrders in the cut).
export { CREW_CONTINUUM_ORDER_CUT, CREW_CONTINUUM_ORDER_IMPORTANT } from './wgsl/crew-continuum.js';
// Cluster entries a batch's list holds: enough for the whole scene's budget of 128-triangle clusters.
const CREW_CONTINUUM_CLUSTER_ROOM = Math.ceil(CONTINUUM_TRIANGLE_BUDGET / 128);
const CREW_CONTINUUM_BODY_BYTES = 256, CREW_CONTINUUM_PART_BYTES = 128, CREW_CONTINUUM_DRAW_BYTES = 16;

// Which body each person wears (the owner's choice of 2026-11-17): hands by sex, captains, soldiers, and each
// indigenous culture its own pair.
export function crewContinuumBodyFor({ sex = 'male', role = 'hand', culture = null } = {}) {
  const female = sex === 'female';
  if (culture) return `${culture}-${female ? 'female' : 'male'}`;
  if (role === 'captain') return 'captain';
  if (role === 'soldier') return female ? 'villager-female' : 'soldier';
  return female ? 'villager-female' : 'sailor-male';
}
// The baked cultures, by the archetypes js/crew.js names (INDIGENOUS_ARCHETYPE_IDS).
export const CREW_CONTINUUM_CULTURES = Object.freeze(['algonquian', 'caribbean', 'maya', 'andean']);

const crewContinuumCodecs = Object.freeze([
  Object.freeze({ feature: 'texture-compression-bc', format: 'bc7-rgba-unorm-srgb', stream: 'albedo.bc7.bin' }),
  Object.freeze({ feature: 'texture-compression-astc', format: 'astc-4x4-unorm-srgb', stream: 'albedo.astc.bin' }),
]);

async function crewContinuumFetch(path, fetchAsset) {
  const response = await fetchAsset(path);
  if (!response.ok) throw Error(`Crew continuum unavailable (${response.status}): ${path}`);
  return response;
}
// One stream, unpacked and checked against its receipt.
async function crewContinuumStream(manifest, name, fetchAsset) {
  const receipt = manifest.files[name], response = await crewContinuumFetch(CREW_CONTINUUM_ASSETS[manifest.id][receipt.gzip.file], fetchAsset);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== receipt.bytes) throw Error(`Crew continuum stream has the wrong size: ${manifest.id} ${name}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error(`Crew continuum stream failed verification: ${manifest.id} ${name}`);
  return bytes;
}

// The body's uniform (CrewContinuumBody). `full` once its mesh and picture are on the GPU; until then the far body
// draws everyone (far.x = 0).
function crewContinuumBodyUniform(manifest, full) {
  const bytes = new ArrayBuffer(CREW_CONTINUUM_BODY_BYTES), f = new Float32Array(bytes), u = new Uint32Array(bytes);
  const { quantization: q, chain, splat } = manifest;
  f.set([...q.low, q.posScale], 0);
  f.set([...q.uvLow, ...q.uvScale], 4);
  u.set([manifest.clusterCount, manifest.vertexCount * CREW_CONTINUUM_VERTEX_WORDS, chain.vertexCount, chain.triangleCount], 8);
  u.set([manifest.clusterCount * CREW_CONTINUUM_CLUSTER_WORDS, chain.offsets.records, chain.offsets.indices, chain.offsets.steps], 12);
  f.set([full ? chain.errorRange[0] : 0, chain.stepCount, splat.ry, splat.rx], 16);
  f.set([...splat.centre, splat.joint], 20);
  CREW_CONTINUUM_REGIONS.forEach((_, r) => {
    const median = manifest.regionMedians[r], share = splat.regions[r];
    f.set(median ? [...median, 1] : [0.5, 0.5, 0.5, 0], 24 + r * 4);
    f.set([...(share.mean ?? [0, 0, 0]), share.share], 44 + r * 4);
  });
  return bytes;
}

async function openCrewContinuumBody(device, id, fetchAsset) {
  if (!CREW_CONTINUUM_BODIES.some((b) => b.id === id)) throw Error(`Unknown crew continuum body: ${id}`);
  const B = GPUBufferUsage, paths = CREW_CONTINUUM_ASSETS[id];
  const manifest = validateCrewContinuumManifest(await (await crewContinuumFetch(paths['manifest.json'], fetchAsset)).json());
  const [clusters, chain, standIn] = await Promise.all([
    crewContinuumStream(manifest, 'clusters.bin', fetchAsset), crewContinuumStream(manifest, 'chain.bin', fetchAsset),
    crewContinuumFetch(paths['body.glb'], fetchAsset).then((r) => r.arrayBuffer()).then(loadCrewGLB),
  ]);
  const made = (label, size, usage) => device.createBuffer({ label, size: Math.max(16, size), usage: usage | B.COPY_DST });
  const shape = made(`crew continuum ${id} cut and far body`, clusters.byteLength + chain.byteLength, B.STORAGE);
  device.queue.writeBuffer(shape, 0, clusters);
  device.queue.writeBuffer(shape, clusters.byteLength, chain);
  const uniform = made(`crew continuum ${id} body`, CREW_CONTINUUM_BODY_BYTES, B.UNIFORM);
  device.queue.writeBuffer(uniform, 0, crewContinuumBodyUniform(manifest, false));
  const blank = device.createTexture({ label: `crew continuum ${id} picture (waiting)`, size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: blank }, new Uint8Array([128, 128, 128, 255]), { bytesPerRow: 4 }, [1, 1]);
  const body = {
    id, manifest, standIn, shape, uniform, version: 0, full: false,
    mesh: made(`crew continuum ${id} mesh (waiting)`, 16, B.STORAGE), texture: blank, albedo: blank.createView(),
    sampler: device.createSampler({ label: `crew continuum ${id} picture`, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 8 }),
    chunks: Math.ceil(manifest.chain.triangleCount / 128),
    triangles: manifest.source.triangles,
  };
  // The full mesh and picture, behind the far body. A device with neither texture codec keeps the far body near too.
  const codec = crewContinuumCodecs.find((c) => device.features.has(c.feature));
  body.loaded = !codec ? Promise.resolve(body) : Promise.all(['vertices.bin', 'indices.bin', codec.stream].map((name) => crewContinuumStream(manifest, name, fetchAsset))).then(([vertices, indices, picture]) => {
    const mesh = made(`crew continuum ${id} mesh`, vertices.byteLength + indices.byteLength, B.STORAGE);
    device.queue.writeBuffer(mesh, 0, vertices);
    device.queue.writeBuffer(mesh, vertices.byteLength, indices);
    const { width, height, levels } = manifest.texture;
    const texture = device.createTexture({ label: `crew continuum ${id} picture`, size: [width, height], mipLevelCount: levels.length, format: codec.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    levels.forEach((level, mipLevel) => {
      const across = Math.ceil(level.width / 4), down = Math.ceil(level.height / 4);
      device.queue.writeTexture({ texture, mipLevel }, picture, { offset: level.offset, bytesPerRow: across * 16, rowsPerImage: down }, [across * 4, down * 4]);
    });
    const waiting = [body.mesh, body.texture];
    Object.assign(body, { mesh, texture, albedo: texture.createView(), full: true });
    device.queue.writeBuffer(uniform, 0, crewContinuumBodyUniform(manifest, true));
    body.version++;
    // Bind groups made with the stand-ins are rebuilt before the next draw; the stand-ins go once that frame is done.
    device.queue.onSubmittedWorkDone().then(() => { for (const resource of waiting) resource.destroy(); });
    return body;
  });
  body.loaded.catch((error) => console.warn(`Crew continuum ${id}: the far body stands in near too`, error));
  return body;
}

const crewContinuumBodyCache = new WeakMap();
// A body on this device, fetched once. Resolves when it can be drawn; `body.loaded` when it is drawn in full.
export function loadCrewContinuumBody(device, id, { fetchAsset = fetch } = {}) {
  let bodies = crewContinuumBodyCache.get(device);
  if (!bodies) crewContinuumBodyCache.set(device, (bodies = new Map()));
  if (!bodies.has(id)) {
    const pending = openCrewContinuumBody(device, id, fetchAsset);
    pending.catch(() => { if (bodies.get(id) === pending) bodies.delete(id); });
    bodies.set(id, pending);
  }
  return bodies.get(id);
}

let crewContinuumRenderSource = null;
const crewContinuumRender = () => (crewContinuumRenderSource ??= crewContinuumRenderWGSL());

// Every program people are cut and drawn with, once a device and target. Those that draw under water are asked
// for apart, by whoever has the water's optics, so a garrison ashore asking first leaves them to the crew afloat.
export function requestCrewContinuumPipelines({ device, shader, format = 'rgba16float', samples = 4, waterOptics = null }) {
  const drawn = requestOnce(device, `crew continuum ${format} ${samples}`, async () => {
    const [selectModule, module, shadowModule] = await Promise.all([
      shader(crewContinuumSelectWGSL(), 'crew continuum cut'), shader(crewContinuumRender(), 'crew continuum'), shader(crewContinuumShadowWGSL(), 'crew continuum shadow'),
    ]);
    const laying = { depthWriteEnabled: true, depthCompare: 'greater' }, equal = { depthWriteEnabled: false, depthCompare: 'equal' };
    const draw = (label, vs, fs, depth, writeMask = GPUColorWrite.ALL) => device.createRenderPipelineAsync({
      label, layout: 'auto', vertex: { module, entryPoint: vs, buffers: CREW_CONTINUUM_ENTRY_LAYOUT },
      fragment: { module, entryPoint: fs, targets: [{ format, writeMask }] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', ...depth }, multisample: { count: samples },
    });
    const [select, clusters, far, splat, cutDepthClusters, cutDepthFar, cutClusters, cutFar, shadow] = await Promise.all([
      device.createComputePipelineAsync({ label: 'crew continuum cut', layout: 'auto', compute: { module: selectModule, entryPoint: 'crewContinuumSelect' } }),
      draw('crew continuum clusters', 'crewContinuumClusterVS', 'crewContinuumFS', laying),
      draw('crew continuum far body', 'crewContinuumChainVS', 'crewContinuumFarFS', laying),
      draw('crew continuum splat', 'crewContinuumSplatVS', 'crewContinuumFarFS', laying),
      draw('crew continuum surviving clusters', 'crewContinuumClusterVS', 'crewContinuumSurviving', laying, 0),
      draw('crew continuum surviving far body', 'crewContinuumChainVS', 'crewContinuumSurviving', laying, 0),
      draw('crew continuum cut clusters', 'crewContinuumClusterVS', 'crewContinuumFS', equal),
      draw('crew continuum cut far body', 'crewContinuumChainVS', 'crewContinuumFarFS', equal),
      device.createRenderPipelineAsync({
        label: 'crew continuum shadow', layout: 'auto', vertex: { module: shadowModule, entryPoint: 'crewContinuumShadowVS', buffers: CREW_CONTINUUM_ENTRY_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
    ]);
    return { select, clusters, far, splat, cutDepthClusters, cutDepthFar, cutClusters, cutFar, shadow };
  });
  if (!waterOptics) return drawn;
  const submerged = requestOnce(device, `crew continuum submerged ${format} ${samples}`, async () => {
    const optics = await waterOptics;
    const submerged = await (optics?.capture({ source: crewContinuumRender(), entry: 'crewContinuumSubmergedFarFS', world: 'c.world', vertex: { entryPoint: 'crewContinuumSubmergedVS', buffers: CREW_CONTINUUM_ENTRY_LAYOUT }, groups: 3 }) ?? null);
    return { submerged };
  });
  return Promise.all([drawn, submerged]).then(([pipelines, under]) => ({ ...pipelines, ...under }));
}

// The pass that poses people placed on the GPU (crewContinuumPoseWGSL), once a device.
export function requestCrewContinuumPose({ device, shader }) {
  return requestOnce(device, 'crew continuum pose', async () => device.createComputePipelineAsync({
    label: 'crew continuum pose', layout: 'auto', compute: { module: await shader(crewContinuumPoseWGSL(), 'crew continuum pose'), entryPoint: 'crewContinuumPose' },
  }));
}
// Where each joint of a rig stands at rest, in its bind space: what each inverse bind matrix undoes (vec4 a joint).
// The pose pass blends each joint about its own, and draws a parted limb in to its stump there.
export function crewContinuumRestPlaces(animator) {
  const places = new Float32Array(CREW_JOINT_COUNT * 4);
  for (let j = 0; j < CREW_JOINT_COUNT; j++) {
    const m = animator.inverseBinds.subarray(j * 16, j * 16 + 16);
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C || 1;
    const inverse = [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det);
    const t = [-m[12], -m[13], -m[14]];
    for (let r = 0; r < 3; r++) places[j * 4 + r] = inverse[r * 3] * t[0] + inverse[r * 3 + 1] * t[1] + inverse[r * 3 + 2] * t[2];
    places[j * 4 + 3] = 1;
  }
  return places;
}
// The frame people a GPU pass places in the world are drawn in. The shaders they share with sailors place a body in a
// ship's frame and look it up for gun flashes; for these that frame is the world's own, and no gun flashes.
export function createCrewContinuumWorldHull(device, label = 'crew continuum world frame') {
  const data = new Float32Array(52);
  data.set([1, 0, 0, 1], 0); data.set([0, 1, 0, 0], 4); data.set([0, 0, -1, 0], 8); data.set([3.6, 12, 1, 1], 12);
  const hull = device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(hull, 0, data);
  return hull;
}
// One run of placed people posed into a joint and actor buffer from `first` on, each with their batch's orders.
//   placed    the CrewPlaced records, indexed by slot as the joints are
//   palettes  the clips' skin matrices, CREW_JOINT_COUNT a frame; looks the CrewLook table; rest a body's rest places
//   counted   { buffer, offset } of the indirect dispatch (count, 1, 1) the placing pass wrote
export function createCrewContinuumPoser({ device, pipeline, placed, palettes, looks, rest, joints, actors, orders, first = 0, counted }) {
  const run = device.createBuffer({ label: 'crew continuum pose run', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(run, 0, new Uint32Array([first, 0, 0, 0]));
  const group = device.createBindGroup({
    label: 'crew continuum pose', layout: pipeline.getBindGroupLayout(0),
    entries: [placed, palettes, looks, rest, joints, actors, orders, run].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  return {
    // In a compute pass, after the placing pass and before the batch's cut.
    encode(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroupsIndirect(counted.buffer, counted.offset);
    },
    destroy() { run.destroy(); },
  };
}

// One batch: people `first`..`first + capacity` of a joint and actor buffer, all wearing `body`.
//   frame, hull, bones, actor   the crew's own buffers (group 0 of the cut)
//   main                        the crew's group-0 resources for drawing, in binding order (bindings 13 and 14 as entries)
//   shadows                     the shadow set: its `uniform` and `bind(pipeline)` for the lighting group
//   counted                     for people a GPU pass keeps: { buffer, offset } of the indirect dispatch (count, 1, 1)
//                               that sizes the cut; the orders are then the pose pass's to write, never the CPU's
export function createCrewContinuumBatch({ device, pipelines: P, body, capacity, first = 0, samples = 4, frame, hull, bones, actor, main, shadows, counted = null }) {
  const B = GPUBufferUsage, chunks = body.chunks;
  const room = [CREW_CONTINUUM_CLUSTER_ROOM, capacity * chunks, capacity, CREW_CONTINUUM_CLUSTER_ROOM, capacity * chunks, capacity * chunks];
  const lists = [];
  let entries = capacity * 2;
  for (const n of room) { lists.push([entries, n]); entries += n; }
  const list = device.createBuffer({ label: `crew continuum ${body.id} lists`, size: entries * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `crew continuum ${body.id} draws`, size: CREW_CONTINUUM_LISTS.length * CREW_CONTINUUM_DRAW_BYTES, usage: B.STORAGE | B.INDIRECT | B.COPY_DST | B.COPY_SRC });
  const orders = device.createBuffer({ label: `crew continuum ${body.id} orders`, size: Math.max(16, capacity * 4), usage: B.STORAGE | B.COPY_DST });
  device.queue.writeBuffer(orders, 0, new Uint32Array(Math.max(4, capacity)));
  const part = device.createBuffer({ label: `crew continuum ${body.id} batch`, size: CREW_CONTINUUM_PART_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const orderWords = new Uint32Array(Math.max(4, capacity)), partWords = new Uint32Array(CREW_CONTINUUM_PART_BYTES / 4), partFloats = new Float32Array(partWords.buffer);
  lists.forEach(([at, n], i) => partWords.set([at, n, 0, 0], 8 + i * 4));
  const resetDraws = new Uint32Array(CREW_CONTINUUM_LISTS.length * 4);
  CREW_CONTINUUM_INSTANCE_VERTICES.forEach((n, i) => { resetDraws[i * 4] = n; });

  const entriesOf = (resources) => resources.map((resource, binding) => (resource?.resource !== undefined ? resource : { binding, resource }));
  const groupOf = (pipeline, index, resources) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries: entriesOf(resources) });
  const select = groupOf(P.select, 0, [{ buffer: frame }, { buffer: hull }, { buffer: bones }, { buffer: actor }, { buffer: body.shape }, { buffer: list }, { buffer: draws }, { buffer: body.uniform }, { buffer: part }, { buffer: orders }, { buffer: shadows.uniform }]);
  const shading = ['clusters', 'far', 'splat', 'cutClusters', 'cutFar'], laying = ['cutDepthClusters', 'cutDepthFar'];
  let groups = null, version = -1;
  // Built again once the body's full mesh and picture replace their stand-ins.
  const bind = () => {
    if (version === body.version) return groups;
    version = body.version;
    const data = [{ buffer: body.mesh }, { buffer: body.shape }, { buffer: list }, { buffer: body.uniform }, { buffer: part }, body.albedo, body.sampler];
    groups = {};
    for (const name of [...shading, ...laying]) groups[name] = [groupOf(P[name], 0, main), shading.includes(name) ? shadows.bind(P[name]) : null, groupOf(P[name], 2, data)];
    groups.shadow = [groupOf(P.shadow, 0, [{ buffer: shadows.uniform }, { buffer: hull }, { buffer: bones }, { buffer: actor }]), null, groupOf(P.shadow, 2, data)];
    if (P.submerged) groups.submerged = [P.submerged.bindGroup(main, 0), shadows.bind(P.submerged.pipeline), P.submerged.bindGroup(data, 2)];
    return groups;
  };
  // A frame's cut runs once, after its lists are emptied; a pass that asks again in the same frame keeps the first.
  let count = 0, armed = false;
  const drawList = (pass, index) => {
    const [at, n] = lists[index];
    pass.setVertexBuffer(0, list, at * 8, n * 8);
    pass.drawIndirect(draws, index * CREW_CONTINUUM_DRAW_BYTES);
  };
  const drawWith = (pass, name, pipeline, indices) => {
    const [g0, g1, g2] = bind()[name];
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, g0);
    if (g1) pass.setBindGroup(1, g1);
    pass.setBindGroup(2, g2);
    for (const index of indices) drawList(pass, index);
  };
  return {
    body, lists, list, draws, orders,
    get count() { return count; },
    // Before the frame's passes: who is drawn, with what orders, at the scene's one pixel error.
    // `at` moves the batch's first slot, where a garrison's captains follow however many soldiers a port has.
    // A counted batch is given how many it may hold (a number), and the GPU says how many there are.
    update(people, orderOf = () => 0, castShadows = true, at = first) {
      count = Math.min(typeof people === 'number' ? people : people.length, capacity);
      if (!counted) for (let i = 0; i < count; i++) orderWords[i] = orderOf(people[i], i) >>> 0;
      if (count && !counted) device.queue.writeBuffer(orders, 0, orderWords, 0, Math.max(4, count));
      partWords.set([at, count, samples, castShadows ? 1 : 0], 0);
      partFloats[4] = continuumPixelError();
      device.queue.writeBuffer(part, 0, partWords);
      device.queue.writeBuffer(draws, 0, resetDraws);
      armed = true;
    },
    // In a compute pass, after every joint of the batch is final for the frame.
    encodeSelect(pass) {
      if (!count || !armed) return;
      armed = false;
      pass.setPipeline(P.select);
      pass.setBindGroup(0, select);
      if (counted) pass.dispatchWorkgroupsIndirect(counted.buffer, counted.offset);
      else pass.dispatchWorkgroups(count);
    },
    drawOpaque(pass) {
      if (!count) return;
      drawWith(pass, 'clusters', P.clusters, [0]);
      drawWith(pass, 'far', P.far, [1]);
      drawWith(pass, 'splat', P.splat, [2]);
    },
    // Depth first for those being cut away, then shaded where that depth held.
    drawCut(pass) {
      if (!count) return;
      drawWith(pass, 'cutDepthClusters', P.cutDepthClusters, [3]);
      drawWith(pass, 'cutDepthFar', P.cutDepthFar, [4]);
      drawWith(pass, 'cutClusters', P.cutClusters, [3]);
      drawWith(pass, 'cutFar', P.cutFar, [4]);
    },
    drawShadow(pass) {
      if (!count) return;
      drawWith(pass, 'shadow', P.shadow, [5]);
    },
    // Under water, single-sampled, through the water's own capture: the far bodies the shadow list already holds.
    drawSubmerged(pass, above = false) {
      if (!count || !P.submerged) return;
      const [g0, g1, g2] = bind().submerged;
      P.submerged.bind(pass, above);
      pass.setBindGroup(0, g0); pass.setBindGroup(1, g1); pass.setBindGroup(2, g2);
      drawList(pass, 5);
    },
    // For the continuum census: every draw's own indirect record.
    continuumDraws() { return count ? [{ buffer: draws, offset: 0, records: CREW_CONTINUUM_LISTS.length, stride: 4, people: count }] : []; },
    destroy() { for (const resource of [list, draws, orders, part]) resource.destroy(); },
  };
}
