// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ships drawn through the one continuum (AGENTS.md rule 3): each family's bodies loaded once onto the GPU, and one
// cut a frame (js/wgsl/ship-continuum.js) that enters every ship in the lists its draws read. A family supplies its
// bodies and its ships' instance records; how they are cut, handed off and counted is here and in the shared core.
import { SHIP_CONTINUUM_ASSETS, SHIP_CONTINUUM_FAR_VERTEX_WORDS, shipContinuumStreams, shipContinuumSourceKey, shipContinuumSurface, shipContinuumSurfaceMatches, validateShipContinuumManifest } from './ship-continuum.js';
import {
  SHIP_CONTINUUM_LISTS, SHIP_CONTINUUM_INSTANCE_VERTICES, SHIP_CONTINUUM_DRAW_BYTES, SHIP_CONTINUUM_DAMAGED_LIST, SHIP_CONTINUUM_DAMAGED_SLOTS, SHIP_CONTINUUM_SHADOW_CLUSTER_LIST, SHIP_CONTINUUM_LINE_LIST,
  SHIP_CONTINUUM_BODY_LIMIT, SHIP_CONTINUUM_BODY_BYTES, SHIP_CONTINUUM_CUT_BYTES, shipContinuumCutWGSL,
} from './wgsl/ship-continuum.js';
import { CONTINUUM_TRIANGLE_BUDGET, continuumPixelError } from './continuum-core.js';

async function shipContinuumFetch(path, fetchAsset) {
  const response = await fetchAsset(path);
  if (!response.ok) throw Error(`Ship continuum unavailable (${response.status}): ${path}`);
  return response;
}
const shipContinuumHex = (bytes) => Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
// One stream, unpacked and checked against its receipt.
async function shipContinuumStream(manifest, name, fetchAsset) {
  const receipt = manifest.files[name], response = await shipContinuumFetch(SHIP_CONTINUUM_ASSETS[manifest.id][receipt.gzip.file], fetchAsset);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== receipt.bytes) throw Error(`Ship continuum stream has the wrong size: ${manifest.id} ${name}`);
  if (shipContinuumHex(await crypto.subtle.digest('SHA-256', bytes)) !== receipt.sha256) throw Error(`Ship continuum stream failed verification: ${manifest.id} ${name}`);
  return bytes;
}
// A body is baked from one assembly; drawn over any other it would not be the ship the physics strikes, so a stale
// bake stops the game here. Its part groups and shards must be the ship's exactly, and its surface within noise.
async function shipContinuumCheckSource(manifest, source) {
  const key = shipContinuumHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shipContinuumSourceKey(source))));
  if (key !== manifest.source.key || source.fracture.shardCount !== manifest.source.shards || !shipContinuumSurfaceMatches(manifest.source.surface, shipContinuumSurface(source.vertices, source.indices))) {
    throw Error(`Ship continuum ${manifest.id} was baked from another assembly; run node scripts/prepare-ship-continuum.mjs`);
  }
}

// A family's bodies on the GPU, in body order (an instance's body field indexes them). `sources` are the ships as
// built here, checked against what each body was baked from. A trade vessel draws the vertices it was baked with
// (`assemblies`: 9 floats a vertex, position, normal, material, uv; and each vertex's fracture shard). A player's
// ship draws her own mesh as built here: her clusters' corners and her far body's riders are renumbered onto it,
// corner by corner of the assembly (the same triangles in the same order, whatever an engine's welding), and carries
// the line vertices of her detail layer (js/vessel-detail.js), which ride her clusters.
export async function loadShipContinuum(device, ids, sources, { fetchAsset = fetch, label = 'ship continuum' } = {}) {
  if (ids.length > SHIP_CONTINUUM_BODY_LIMIT) throw Error(`A ship continuum holds at most ${SHIP_CONTINUUM_BODY_LIMIT} bodies`);
  const loaded = await Promise.all(ids.map(async (id, b) => {
    const manifest = validateShipContinuumManifest(await (await shipContinuumFetch(SHIP_CONTINUUM_ASSETS[id]['manifest.json'], fetchAsset)).json());
    const names = shipContinuumStreams(manifest.family), source = sources[b];
    const [, ...streams] = await Promise.all([shipContinuumCheckSource(manifest, source), ...names.map((name) => shipContinuumStream(manifest, name, fetchAsset))]);
    const stream = Object.fromEntries(names.map((name, k) => [name, streams[k]])), words = (name) => new Uint32Array(stream[name].buffer, stream[name].byteOffset, stream[name].byteLength / 4);
    // The clusters name the bake's seam copies by their own numbers; each is drawn as the vertex it copies.
    const index = words('indices.bin').slice(), copy = words('copies.bin');
    const V = manifest.source.vertices;
    for (let i = 0; i < index.length; i++) if (index[i] >= V) index[i] = copy[index[i] - V];
    let far = stream['far.bin'], vertices, vertexShards;
    if (stream['corners.bin']) {
      const corners = words('corners.bin'), built = new Uint32Array(V);
      if (corners.length !== source.indices.length) throw Error(`Ship continuum ${manifest.id} has another assembly's corners`);
      for (let i = 0; i < corners.length; i++) built[corners[i]] = source.indices[i];
      for (let i = 0; i < index.length; i++) index[i] = built[index[i]];
      const farWords = new Uint32Array(far.buffer, far.byteOffset, far.byteLength / 4).slice();
      for (let v = 0; v < manifest.far.vertexCount; v++) { const at = v * SHIP_CONTINUUM_FAR_VERTEX_WORDS + 5; farWords[at] = built[farWords[at]]; }
      far = new Uint8Array(farWords.buffer);
      vertices = source.vertices;
      vertexShards = source.fracture.vertexShards;
    } else {
      vertices = new Float32Array(stream['vertices.bin'].buffer, stream['vertices.bin'].byteOffset, stream['vertices.bin'].byteLength / 4);
      vertexShards = words('shards.bin');
    }
    return { manifest, clusters: stream['clusters.bin'], index, far, vertices, vertexShards, vertexCount: vertices.length / 9, lines: source.detail?.lineVertexCount ?? 0 };
  }));
  let shapeWords = 0, meshWords = 0, vertexCount = 0;
  const places = loaded.map(({ clusters, index, far, vertexCount: count }) => {
    const at = { clusters: shapeWords, far: shapeWords + clusters.byteLength / 4, mesh: meshWords, vertex: vertexCount };
    shapeWords += (clusters.byteLength + far.byteLength) / 4;
    meshWords += index.length;
    vertexCount += count;
    return at;
  });
  const B = GPUBufferUsage, made = (name, size, usage) => device.createBuffer({ label: `${label} ${name}`, size: Math.max(16, size), usage: usage | B.COPY_DST });
  const shape = made('cut and far bodies', shapeWords * 4, B.STORAGE), mesh = made('cluster corners', meshWords * 4, B.STORAGE);
  const vertices = made('assemblies', vertexCount * 36, B.STORAGE), bodies = made('bodies', SHIP_CONTINUUM_BODY_LIMIT * SHIP_CONTINUUM_BODY_BYTES, B.UNIFORM);
  const table = new ArrayBuffer(SHIP_CONTINUUM_BODY_LIMIT * SHIP_CONTINUUM_BODY_BYTES), f = new Float32Array(table), u = new Uint32Array(table);
  loaded.forEach(({ manifest, clusters, index, far, vertices: source, vertexCount: count, lines }, b) => {
    const at = places[b], o = (b * SHIP_CONTINUUM_BODY_BYTES) / 4, { far: chain, splat, bound } = manifest;
    device.queue.writeBuffer(shape, at.clusters * 4, clusters);
    device.queue.writeBuffer(shape, at.far * 4, far);
    device.queue.writeBuffer(mesh, at.mesh * 4, index);
    device.queue.writeBuffer(vertices, at.vertex * 36, source.buffer, source.byteOffset, count * 36);
    u.set([at.clusters, manifest.clusterCount, at.mesh, at.vertex], o);
    u.set([at.far, chain.offsets.records, chain.offsets.triangles, chain.offsets.steps], o + 4);
    f.set([chain.baseError, chain.stepCount, splat.ry, splat.rxSide], o + 8);
    f.set([...splat.centre, splat.rxEnd], o + 12);
    f.set([...bound.centre, bound.radius], o + 16);
    f.set([...splat.colour, chain.triangleCount], o + 20);
    f.set([...manifest.source.designScale, count], o + 24);
    u.set([lines, 0, 0, 0], o + 28);
  });
  device.queue.writeBuffer(bodies, 0, table);
  const manifests = loaded.map((l) => l.manifest);
  return {
    shape, mesh, vertices, bodies, manifests,
    // Each body's assembly as baked, for a family that copies it (a damaged ship's scars and shard flight).
    assemblies: loaded.map((l) => ({ vertices: l.vertices, vertexShards: l.vertexShards, vertexCount: l.vertexCount })),
    // Most 128-triangle pieces any body's far body is cut into, and most clusters any body has.
    farChunks: Math.max(...manifests.map((m) => Math.ceil(m.far.triangleCount / 128))),
    clusterMost: Math.max(...manifests.map((m) => m.clusterCount)),
    // Most 128-triangle pieces any body's detail layer is cut into.
    linePieces: Math.max(0, ...loaded.map((l) => Math.ceil(l.lines / 384))),
    destroy() { for (const buffer of [shape, mesh, vertices, bodies]) buffer.destroy(); },
  };
}

export function requestShipContinuumCut({ device, shader }) {
  return shader(shipContinuumCutWGSL(), 'ship continuum cut').then((module) => device.createComputePipelineAsync({
    label: 'ship continuum cut', layout: 'auto', compute: { module, entryPoint: 'shipContinuumSelect' },
  }));
}

// The lists and draws of one family's ships: `capacity` ships, cut each frame from `instances` (12 floats a ship).
// `frame`, `offset` and `shadowFrame` are the scene's bindings (its Frame, its near-domain shift and its shadow frame).
export function createShipContinuumCut({ device, pipeline, data, instances, capacity, frame, offset, shadowFrame, samples = 4, label = 'ship continuum' }) {
  const B = GPUBufferUsage, L = SHIP_CONTINUUM_LISTS.length;
  // Room in each list: the scene's whole budget of clusters, seen and casting shadows; every ship's far body, twice
  // (seen and shadow); a splat each; each damaged ship every cluster it has; and every ship's lines.
  const room = SHIP_CONTINUUM_LISTS.map((name, i) => (i === 0 || i === SHIP_CONTINUUM_SHADOW_CLUSTER_LIST ? Math.ceil(CONTINUUM_TRIANGLE_BUDGET / 128) : i === 1 || i === 3 ? capacity * data.farChunks : i === 2 ? capacity : i === SHIP_CONTINUUM_LINE_LIST ? Math.max(1, capacity * (data.linePieces ?? 0)) : data.clusterMost));
  const lists = [];
  let first = capacity * 2;
  for (const size of room) { lists.push([first, size]); first += size; }
  const list = device.createBuffer({ label: `${label} lists`, size: first * 8, usage: B.STORAGE | B.VERTEX | B.COPY_SRC });
  const draws = device.createBuffer({ label: `${label} draws`, size: L * SHIP_CONTINUUM_DRAW_BYTES, usage: B.STORAGE | B.INDIRECT | B.COPY_DST | B.COPY_SRC });
  const cut = device.createBuffer({ label: `${label} cut`, size: SHIP_CONTINUUM_CUT_BYTES, usage: B.UNIFORM | B.COPY_DST });
  const reset = new Uint32Array(L * 4);
  SHIP_CONTINUUM_INSTANCE_VERTICES.forEach((n, i) => { reset[i * 4] = n; });
  const cutData = new ArrayBuffer(SHIP_CONTINUUM_CUT_BYTES), cutU = new Uint32Array(cutData), cutF = new Float32Array(cutData);
  lists.forEach(([at, size], i) => cutU.set([at, size, 0, 0], 8 + i * 4));
  let group = null;
  const bind = (scene) => {
    ({ frame, offset, shadowFrame } = { frame, offset, shadowFrame, ...scene });
    group = device.createBindGroup({
      label: `${label} cut`, layout: pipeline.getBindGroupLayout(0),
      entries: [frame, offset, shadowFrame, { buffer: instances }, { buffer: data.shape }, { buffer: data.bodies }, { buffer: list }, { buffer: draws }, { buffer: cut }].map((resource, binding) => ({ binding, resource })),
    });
  };
  bind({});
  const dataEntries = [data.shape, data.mesh, data.vertices, instances, list, data.bodies, cut].map((buffer, binding) => ({ binding, resource: { buffer } }));
  return {
    list, draws, cut, lists,
    // The scene's bindings again, when it makes new ones.
    rebind: bind,
    // The cut for `count` ships this frame, in the frame's compute pass. Its draws start over even when no ship is cut.
    encode(pass, count) {
      device.queue.writeBuffer(draws, 0, reset);
      cutU.set([count, samples, 0, 0], 0);
      cutF.set([continuumPixelError(), 0, 0, 0], 4);
      device.queue.writeBuffer(cut, 0, cutData);
      if (!count) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.min(count, capacity));
    },
    // The bodies, the instances and the lists, at `index` of a render pipeline that reads them
    // (shipContinuumDataWGSL), with any of the family's own entries after them. `vertices` stands in for the bodies'
    // assemblies where a ship draws her own copy of one (a player's ship, whose scars are baked into hers).
    dataGroup(renderPipeline, index, extra = [], { vertices = null } = {}) {
      const entries = vertices ? dataEntries.map((entry) => (entry.binding === 2 ? { binding: 2, resource: { buffer: vertices } } : entry)) : dataEntries;
      return device.createBindGroup({ label: `${label} data`, layout: renderPipeline.getBindGroupLayout(index), entries: [...entries, ...extra] });
    },
    // One list's indirect draw, its entries bound at the list's start as the instance attribute.
    draw(pass, index) {
      const [at, size] = lists[index];
      pass.setVertexBuffer(0, list, at * 8, size * 8);
      pass.drawIndirect(draws, index * SHIP_CONTINUUM_DRAW_BYTES);
    },
    damagedList: (slot) => SHIP_CONTINUUM_DAMAGED_LIST + Math.min(slot, SHIP_CONTINUUM_DAMAGED_SLOTS - 1),
    // What the census reads of the scene pass: the clusters, far bodies and splats, each damaged ship's clusters
    // twice (their surviving depth, then their shade), and the lines. The shadow lists are drawn in the shadow map, not
    // counted here.
    continuumDraws: () => [
      { buffer: draws, offset: 0, records: 3, stride: 4 },
      { buffer: draws, offset: SHIP_CONTINUUM_DAMAGED_LIST * SHIP_CONTINUUM_DRAW_BYTES, records: SHIP_CONTINUUM_DAMAGED_SLOTS, stride: 4 },
      { buffer: draws, offset: SHIP_CONTINUUM_DAMAGED_LIST * SHIP_CONTINUUM_DRAW_BYTES, records: SHIP_CONTINUUM_DAMAGED_SLOTS, stride: 4 },
      { buffer: draws, offset: SHIP_CONTINUUM_LINE_LIST * SHIP_CONTINUUM_DRAW_BYTES, records: 1, stride: 4 },
    ],
    destroy() { for (const buffer of [list, draws, cut]) buffer.destroy(); },
  };
}
