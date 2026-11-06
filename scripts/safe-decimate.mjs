// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Error-bounded decimation of a GLB, for parts baked at build time. Each part is reduced only as far
// as a shape error allows, then the result is measured against the original: surface distance both
// ways, and outline from every axis. Reducing a whole model to a triangle count instead wrecks it,
// because small flat parts collapse as readily as curved ones.
//
//   node scripts/safe-decimate.mjs in.glb                       table of every step, writes nothing
//   node scripts/safe-decimate.mjs in.glb --out out.glb         the fewest triangles that pass
//   --max-error 1%      worst surface distance allowed, of the diagonal; or 0.02m. Default 1%.
//   --max-drift 1%      how far the outline may move, measured the same way. Default 1.5%.
//   --type prop         tune for what it is: prop, structure, character or foliage. See ASSET_TYPES.
//   --budget 300        instead: the closest ladder step that fits this many triangles
//   --levels 2000,500   one file per triangle budget, named out-2000.glb and so on, each with its safe distance
//   --lods 0.5%,1%,2%   one file per error, named out-lod0.glb and so on
//   --indices out.json  for a skinned body: each level as index lists into the source file's vertices
//   --python venv/bin/python   bake the texture back with this Python, which must have bpy. See rebake-texture.py
//   --bake-size 512     pixels square of the baked texture. By default it follows the triangle count.
//   --height 18.5       real height in metres, so a generated model's safe distances are true
//   --drop-small        let parts smaller than the error vanish, as a distant model may
//   --keep-hidden       keep triangles no direction can see. Automatic if the model has joints.
//   --no-locks          do not hold the ends of each part's long axes in place
//   --no-uvs            drop texture coordinates, for a part that will be vertex-coloured
//   --crease 38         degrees between faces above which an edge is drawn hard
//   --report out.json   every step, as data
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';

// A cell's worth of error looks like one pixel from this far, on a 1080p screen with a 58 degree lens.
const SCREEN_FOCAL_PIXELS = 1080 / (2 * Math.tan((58 * Math.PI) / 360));
const LADDER = [0.0005, 0.001, 0.0015, 0.002, 0.003, 0.004, 0.006, 0.008, 0.012, 0.016, 0.024, 0.032, 0.048];
const OUTLINE_PIXELS = 512;
const HIDDEN_PIXELS = 384;
const HIDDEN_BIAS_PIXELS = 1.5;
const SMALLEST_PART_SHARE = 0.12;
// The simplifier scales each part to one unit, so these compare with an error of a few thousandths.
const NORMAL_WEIGHT = 0.01;
const UV_WEIGHT = 0.1;

// What each kind of asset can stand, from generated models looked at side by side. Limits are shares of
// the diagonal. Seams are dropped and the texture baked afresh where a mesh is textured, because a
// generated atlas is 40 to 99% seam corners and those stop a reduction long before the shape needs it.
export const ASSET_TYPES = Object.freeze({
  // Seen small and alone. A dock cleat held at 358 triangles of 3,041, and went blocky at 162.
  prop: Object.freeze({ maxError: 0.015, maxDrift: 0.015, ignoreUvs: true, bake: true, bakePixels: 32 }),
  // Thin members with air between them, and big enough that a share of the diagonal is a long way. A pier
  // kept its braces at 1.1% and lost its deck to holes by the next step.
  structure: Object.freeze({ maxError: 0.011, maxDrift: 0.015, ignoreUvs: true, bake: true, bakePixels: 32 }),
  // Bends at every joint, and is painted per vertex. Hidden triangles show once a limb moves, and evenly
  // shaped triangles fold better: the light setting halved slivers on a sailor for a tenth more error.
  character: Object.freeze({ maxError: 0.006, maxDrift: 0.01, ignoreUvs: true, locks: false, keepHidden: true, allowSkinned: true, flags: Object.freeze(['RegularizeLight']), crease: 70 }),
  // Leaves fused to their twigs. Led by error a crown thins to bare twigs, because each leaf is a small
  // error however much of the crown it makes: a tree of 16,000 kept half its outline at 500 triangles and
  // a fifth at 250. Merging nearby vertices regardless of what joins them keeps the mass, so a budget tries
  // both and the outline decides. Sheets, not solids, so it wants drawing from both sides.
  foliage: Object.freeze({ minOverlap: 0.85, ignoreUvs: true, bake: true, bakePixels: 16, locks: false, keepHidden: true, merge: true }),
});
// Shares of the source tried when a type chooses by outline, not by error.
const COUNT_LADDER = [0.75, 0.5, 0.35, 0.25, 0.15, 0.1, 0.05, 0.025, 0.012, 0.006];
const REACH_ERROR = 0.25;
const MERGE_WHOLENESS_SLACK = 0.03;
const MERGE_LEAST_SHARE = 0.6;
const MERGE_LEAST_MASS = 0.6;

function directions(count) {
  const out = [], golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2, r = Math.sqrt(1 - y * y), a = i * golden;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

// ---- reading ----------------------------------------------------------------------------------
// A skinned body can be measured and given lighter index lists, because a reduction only drops
// vertices and never moves them. allowSkinned says the caller knows the weights are not written out.
export function readGLB(bytes, { allowSkinned = false } = {}) {
  const data = Buffer.from(bytes);
  if (data.readUInt32LE(0) !== 0x46546c67) throw Error('Not a GLB file');
  const jsonLength = data.readUInt32LE(12), doc = JSON.parse(data.subarray(20, 20 + jsonLength).toString());
  for (const name of doc.extensionsRequired ?? []) if (name !== 'KHR_materials_unlit' && !name.startsWith('KHR_materials')) throw Error(`Cannot read ${name}: export the file uncompressed`);
  const binStart = 20 + jsonLength + 8, bin = data.subarray(binStart, binStart + (doc.buffers?.[0]?.byteLength ?? 0));
  const TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (index) => {
    const a = doc.accessors[index], view = doc.bufferViews[a.bufferView], Type = TYPES[a.componentType], size = SIZES[a.type];
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride || size * Type.BYTES_PER_ELEMENT, out = new Type(a.count * size);
    const source = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = source[get](start + i * stride + k * Type.BYTES_PER_ELEMENT, true);
    return out;
  };
  const multiply = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const t = n.translation ?? [0, 0, 0], [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
    return [(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0, 2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0, 2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, t[0], t[1], t[2], 1];
  };
  if (doc.skins?.length && !allowSkinned) throw Error('This model is skinned. Reducing it would need its weights kept, which this tool does not do');
  const parts = [];
  let joints = 0;
  const visit = (index, parent) => {
    const node = doc.nodes[index], world = multiply(parent, local(node));
    if (node.extras?.s3d_joint) joints++;
    if (node.mesh !== undefined) for (const primitive of doc.meshes[node.mesh].primitives) {
      if ((primitive.mode ?? 4) !== 4) continue;
      if (primitive.extensions?.KHR_draco_mesh_compression) throw Error('Cannot read Draco compression: export the file uncompressed');
      const raw = read(primitive.attributes.POSITION), positions = new Float32Array(raw.length);
      for (let k = 0; k < raw.length; k += 3) for (let r = 0; r < 3; r++) positions[k + r] = world[r] * raw[k] + world[4 + r] * raw[k + 1] + world[8 + r] * raw[k + 2] + world[12 + r];
      const count = raw.length / 3;
      const indices = primitive.indices === undefined ? Uint32Array.from({ length: count }, (_, i) => i) : Uint32Array.from(read(primitive.indices));
      const uvAccessor = primitive.attributes.TEXCOORD_0;
      const uvs = uvAccessor === undefined || doc.accessors[uvAccessor].componentType !== 5126 ? null : read(uvAccessor);
      parts.push({ name: node.name ?? `part${parts.length}`, material: primitive.material, positions, indices, uvs });
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const roots = doc.scenes?.[doc.scene ?? 0]?.nodes ?? doc.nodes.map((_, i) => i);
  for (const root of roots) visit(root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { doc, bin, parts, joints };
}

// Merge corners at one place, so the simplifier sees a closed surface and not split seams. A texture
// seam stays split, because a corner there has two places in the image.
function weld(part, epsilon) {
  const map = new Map(), remap = new Uint32Array(part.positions.length / 3), positions = [], uvs = part.uvs ? [] : null, origin = [];
  for (let i = 0; i < remap.length; i++) {
    const x = part.positions[i * 3], y = part.positions[i * 3 + 1], z = part.positions[i * 3 + 2];
    let key = `${Math.round(x / epsilon)},${Math.round(y / epsilon)},${Math.round(z / epsilon)}`;
    if (uvs) key += `,${Math.round(part.uvs[i * 2] * 4096)},${Math.round(part.uvs[i * 2 + 1] * 4096)}`;
    let id = map.get(key);
    if (id === undefined) { id = positions.length / 3; map.set(key, id); origin.push(i); positions.push(x, y, z); if (uvs) uvs.push(part.uvs[i * 2], part.uvs[i * 2 + 1]); }
    remap[i] = id;
  }
  const indices = [];
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = remap[part.indices[t]], b = remap[part.indices[t + 1]], c = remap[part.indices[t + 2]];
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { ...part, positions: new Float32Array(positions), uvs: uvs && new Float32Array(uvs), indices: Uint32Array.from(indices), origin: Uint32Array.from(origin) };
}

const faceNormal = (p, a, b, c) => {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
};
const unit = (n) => { const l = Math.hypot(n[0], n[1], n[2]) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };

// ---- reducing ---------------------------------------------------------------------------------
// Both ends of each part along its three long axes. A blade point or a spoke end sets the outline and
// is the first thing a simplifier trims. More locks than this leave too little for it to remove.
function principalAxes(part, used) {
  const p = part.positions, count = p.length / 3, mean = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < count; i++) if (used[i]) { n++; for (let k = 0; k < 3; k++) mean[k] += p[i * 3 + k]; }
  for (let k = 0; k < 3; k++) mean[k] /= n || 1;
  const c = new Float64Array(9);
  for (let i = 0; i < count; i++) if (used[i]) for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) c[r * 3 + q] += (p[i * 3 + r] - mean[r]) * (p[i * 3 + q] - mean[q]);
  const axes = [];
  for (const start of [[1, 0.31, 0.17], [0.23, 1, 0.41], [0.37, 0.29, 1]]) {
    let v = unit(start);
    for (let iteration = 0; iteration < 24; iteration++) {
      let next = [c[0] * v[0] + c[1] * v[1] + c[2] * v[2], c[3] * v[0] + c[4] * v[1] + c[5] * v[2], c[6] * v[0] + c[7] * v[1] + c[8] * v[2]];
      for (const axis of axes) { const d = next[0] * axis[0] + next[1] * axis[1] + next[2] * axis[2]; next = next.map((x, k) => x - d * axis[k]); }
      v = unit(next);
    }
    axes.push(v);
  }
  return axes;
}
function supportLocks(part) {
  const count = part.positions.length / 3, locks = new Uint8Array(count), used = new Uint8Array(count);
  for (let i = 0; i < part.indices.length; i++) used[part.indices[i]] = 1;
  for (const axis of principalAxes(part, used)) {
    let low = -1, high = -1, lowest = Infinity, highest = -Infinity;
    for (let i = 0; i < count; i++) {
      if (!used[i]) continue;
      const d = part.positions[i * 3] * axis[0] + part.positions[i * 3 + 1] * axis[1] + part.positions[i * 3 + 2] * axis[2];
      if (d < lowest) { lowest = d; low = i; }
      if (d > highest) { highest = d; high = i; }
    }
    if (low >= 0) { locks[low] = 1; locks[high] = 1; }
  }
  return locks;
}
function vertexAttributes(part) {
  const stride = part.uvs ? 5 : 3, count = part.positions.length / 3, values = new Float32Array(count * stride);
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = part.indices[t], b = part.indices[t + 1], c = part.indices[t + 2], n = faceNormal(part.positions, a, b, c);
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) values[v * stride + k] += n[k];
  }
  for (let i = 0; i < count; i++) {
    const n = unit([values[i * stride], values[i * stride + 1], values[i * stride + 2]]);
    values.set(n, i * stride);
    if (part.uvs) { values[i * stride + 3] = part.uvs[i * 2]; values[i * stride + 4] = part.uvs[i * 2 + 1]; }
  }
  const weights = part.uvs ? [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT, UV_WEIGHT, UV_WEIGHT] : [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT];
  return { values, stride, weights };
}
function reducePart(part, allowed, options) {
  const box = partBox(part), size = Math.hypot(box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]);
  // Without this a part smaller than the error collapses to nothing.
  const limit = options.dropSmall ? allowed : Math.min(allowed, size * SMALLEST_PART_SHARE);
  // Texture seams are not locked: corners that share a place are collapsed together along the seam,
  // which is what the simplifier does by itself. Locking them stalled a textured body at 6,000 triangles.
  const flags = ['ErrorAbsolute', ...(options.flags ?? [])];
  const attributes = (part.attributes ??= vertexAttributes(part));
  // A part that may vanish must not be pinned in place by its own ends.
  const mayVanish = options.dropSmall && size <= allowed;
  const locks = options.locks === false || mayVanish ? null : (part.locks ??= supportLocks(part));
  const [indices] = MeshoptSimplifier.simplifyWithAttributes(part.indices, part.positions, 3, attributes.values, attributes.stride, attributes.weights, locks, 3, limit, flags);
  return { ...part, indices: Uint32Array.from(indices) };
}
function partBox(part) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.indices.length; i++) for (let k = 0; k < 3; k++) {
    const v = part.positions[part.indices[i] * 3 + k];
    if (v < lo[k]) lo[k] = v;
    if (v > hi[k]) hi[k] = v;
  }
  return { lo, hi };
}
function modelBox(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) { if (!part.indices.length) continue; const b = partBox(part); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.lo[k]); hi[k] = Math.max(hi[k], b.hi[k]); } }
  return { lo, hi };
}

// ---- hidden triangles --------------------------------------------------------------------------
// Parts overlap where they meet, and what is buried inside another part can never show. A triangle
// goes only if no sample of it is in front of the depth buffer from any of many directions.
export function dropHidden(parts, box, directionCount = 146) {
  const centre = box.lo.map((v, k) => (v + box.hi[k]) / 2), radius = Math.hypot(...box.hi.map((v, k) => v - box.lo[k])) / 2 || 1;
  const size = HIDDEN_PIXELS, scale = (size - 2) / (2 * radius), bias = HIDDEN_BIAS_PIXELS / scale;
  const seen = parts.map((p) => new Uint8Array(p.indices.length / 3));
  const depth = new Float32Array(size * size);
  for (const [dx, dy, dz] of directions(directionCount)) {
    const seed = Math.abs(dy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const rx = unit([dy * seed[2] - dz * seed[1], dz * seed[0] - dx * seed[2], dx * seed[1] - dy * seed[0]]);
    const ux = [dy * rx[2] - dz * rx[1], dz * rx[0] - dx * rx[2], dx * rx[1] - dy * rx[0]];
    const project = (p, v) => {
      const x = p[v * 3] - centre[0], y = p[v * 3 + 1] - centre[1], z = p[v * 3 + 2] - centre[2];
      return [(x * rx[0] + y * rx[1] + z * rx[2]) * scale + size / 2, (x * ux[0] + y * ux[1] + z * ux[2]) * scale + size / 2, x * dx + y * dy + z * dz];
    };
    depth.fill(-Infinity);
    const triangles = [];
    parts.forEach((part, partIndex) => {
      for (let t = 0; t < part.indices.length / 3; t++) triangles.push([partIndex, t, project(part.positions, part.indices[t * 3]), project(part.positions, part.indices[t * 3 + 1]), project(part.positions, part.indices[t * 3 + 2])]);
    });
    for (const [, , a, b, c] of triangles) {
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const w0 = ((b[0] - x - 0.5) * (c[1] - y - 0.5) - (b[1] - y - 0.5) * (c[0] - x - 0.5)) / area, w1 = ((c[0] - x - 0.5) * (a[1] - y - 0.5) - (c[1] - y - 0.5) * (a[0] - x - 0.5)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * a[2] + w1 * b[2] + w2 * c[2], at = y * size + x;
        if (d > depth[at]) depth[at] = d;
      }
    }
    for (const [partIndex, t, a, b, c] of triangles) {
      if (seen[partIndex][t]) continue;
      // Corners, edge middles and the centre, so a sliver too thin to cover a pixel still counts.
      for (const [u, v, w] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3]]) {
        const x = u * a[0] + v * b[0] + w * c[0], y = u * a[1] + v * b[1] + w * c[1], z = u * a[2] + v * b[2] + w * c[2];
        const at = Math.min(size - 1, Math.max(0, Math.floor(y))) * size + Math.min(size - 1, Math.max(0, Math.floor(x)));
        if (z >= depth[at] - bias) { seen[partIndex][t] = 1; break; }
      }
    }
  }
  return parts.map((part, partIndex) => {
    const kept = [];
    for (let t = 0; t < part.indices.length / 3; t++) if (seen[partIndex][t]) kept.push(part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]);
    return { ...part, indices: Uint32Array.from(kept) };
  });
}

// ---- measuring --------------------------------------------------------------------------------
function samplesOf(part, count) {
  const triangles = part.indices.length / 3, cumulative = new Float64Array(triangles);
  let total = 0;
  for (let t = 0; t < triangles; t++) { const n = faceNormal(part.positions, part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]); total += Math.hypot(n[0], n[1], n[2]) / 2; cumulative[t] = total; }
  const points = new Float32Array(count * 3);
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let s = 0; s < count; s++) {
    const pick = random() * total;
    let lo = 0, hi = triangles - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < pick) lo = mid + 1; else hi = mid; }
    let u = random(), v = random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = part.indices[lo * 3] * 3, b = part.indices[lo * 3 + 1] * 3, c = part.indices[lo * 3 + 2] * 3, p = part.positions;
    for (let k = 0; k < 3; k++) points[s * 3 + k] = p[a + k] + u * (p[b + k] - p[a + k]) + v * (p[c + k] - p[a + k]);
  }
  return points;
}
// A small bounding-volume tree, so measuring stays quick on a 300,000-triangle generated model.
function buildTree(part) {
  const count = part.indices.length / 3, order = Uint32Array.from({ length: count }, (_, i) => i), centres = new Float32Array(count * 3), p = part.positions, I = part.indices;
  for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) centres[t * 3 + k] = (p[I[t * 3] * 3 + k] + p[I[t * 3 + 1] * 3 + k] + p[I[t * 3 + 2] * 3 + k]) / 3;
  const nodes = [];
  const build = (start, end) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) for (const c of [0, 1, 2]) for (let k = 0; k < 3; k++) {
      const v = p[I[order[i] * 3 + c] * 3 + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
    const node = { lo, hi, start, end, left: -1, right: -1 }, id = nodes.push(node) - 1;
    if (end - start > 8) {
      const axis = [0, 1, 2].sort((a, b) => hi[b] - lo[b] - (hi[a] - lo[a]))[0], slice = Array.from(order.subarray(start, end)).sort((a, b) => centres[a * 3 + axis] - centres[b * 3 + axis]);
      order.set(slice, start);
      const mid = (start + end) >> 1;
      node.left = build(start, mid);
      node.right = build(mid, end);
    }
    return id;
  };
  build(0, count);
  return { nodes, order };
}
function distanceToTriangle(px, py, pz, p, a, b, c) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2], bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2], cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const near = (x, y, z) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
  if (d1 <= 0 && d2 <= 0) return near(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return near(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const k = d1 / (d1 - d3); return near(ax + k * abx, ay + k * aby, az + k * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return near(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const k = d2 / (d2 - d6); return near(ax + k * acx, ay + k * acy, az + k * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const k = (d4 - d3) / (d4 - d3 + (d5 - d6)); return near(bx + k * (cx - bx), by + k * (cy - by), bz + k * (cz - bz)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return near(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
const TREES = new WeakMap();
function worstDistance(points, part) {
  if (!part.indices.length) return Infinity;
  if (!TREES.has(part.indices)) TREES.set(part.indices, buildTree(part));
  const { nodes, order } = TREES.get(part.indices), I = part.indices, p = part.positions;
  let worst = 0;
  for (let s = 0; s < points.length; s += 3) {
    const px = points[s], py = points[s + 1], pz = points[s + 2];
    let best = Infinity;
    const stack = [0];
    while (stack.length) {
      const node = nodes[stack.pop()];
      const dx = Math.max(node.lo[0] - px, 0, px - node.hi[0]), dy = Math.max(node.lo[1] - py, 0, py - node.hi[1]), dz = Math.max(node.lo[2] - pz, 0, pz - node.hi[2]);
      if (dx * dx + dy * dy + dz * dz >= best) continue;
      if (node.left < 0) {
        for (let i = node.start; i < node.end; i++) { const t = order[i], d = distanceToTriangle(px, py, pz, p, I[t * 3], I[t * 3 + 1], I[t * 3 + 2]); if (d < best) best = d; }
      } else { stack.push(node.left, node.right); }
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}
function outlineOf(parts, axis, box) {
  const u = (axis + 1) % 3, v = (axis + 2) % 3, size = OUTLINE_PIXELS, scale = (size - 4) / Math.max(box.hi[u] - box.lo[u], box.hi[v] - box.lo[v], 1e-9), mask = new Uint8Array(size * size);
  for (const part of parts) for (let t = 0; t < part.indices.length / 3; t++) {
    const P = (i) => [(part.positions[part.indices[t * 3 + i] * 3 + u] - box.lo[u]) * scale + 2, (part.positions[part.indices[t * 3 + i] * 3 + v] - box.lo[v]) * scale + 2];
    const [a, b, c] = [P(0), P(1), P(2)];
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0]))), y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const e0 = (b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0]), e1 = (c[0] - b[0]) * (y + 0.5 - b[1]) - (c[1] - b[1]) * (x + 0.5 - b[0]), e2 = (a[0] - c[0]) * (y + 0.5 - c[1]) - (a[1] - c[1]) * (x + 0.5 - c[0]);
      if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) mask[y * size + x] = 1;
    }
  }
  return { mask, metresPerPixel: 1 / scale };
}
// Distance of every pixel to the nearest filled one.
function distanceField(mask, size) {
  const field = new Float32Array(size * size).fill(1e9), D = Math.SQRT2;
  for (let i = 0; i < mask.length; i++) if (mask[i]) field[i] = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (x) field[i] = Math.min(field[i], field[i - 1] + 1);
    if (y) { field[i] = Math.min(field[i], field[i - size] + 1); if (x) field[i] = Math.min(field[i], field[i - size - 1] + D); if (x < size - 1) field[i] = Math.min(field[i], field[i - size + 1] + D); }
  }
  for (let y = size - 1; y >= 0; y--) for (let x = size - 1; x >= 0; x--) {
    const i = y * size + x;
    if (x < size - 1) field[i] = Math.min(field[i], field[i + 1] + 1);
    if (y < size - 1) { field[i] = Math.min(field[i], field[i + size] + 1); if (x < size - 1) field[i] = Math.min(field[i], field[i + size + 1] + D); if (x) field[i] = Math.min(field[i], field[i + size - 1] + D); }
  }
  return field;
}
// Overlap is harsh on thin shapes: a blade one pixel off scores near nothing. Drift says how far the
// outline really moved, in metres, whichever way it went.
function compareOutlines(source, reduced, box) {
  let overlap = 1, drift = 0, wasFilled = 0, isFilled = 0;
  for (let axis = 0; axis < 3; axis++) {
    const a = source.outlines[axis], b = outlineOf(reduced, axis, box);
    let both = 0, either = 0;
    for (let i = 0; i < a.mask.length; i++) { if (a.mask[i] && b.mask[i]) both++; if (a.mask[i] || b.mask[i]) either++; wasFilled += a.mask[i]; isFilled += b.mask[i]; }
    overlap = Math.min(overlap, both / Math.max(1, either));
    const toB = distanceField(b.mask, OUTLINE_PIXELS);
    for (let i = 0; i < a.mask.length; i++) {
      if (a.mask[i] && !b.mask[i]) drift = Math.max(drift, toB[i] * a.metresPerPixel);
      if (b.mask[i] && !a.mask[i]) drift = Math.max(drift, a.field[i] * a.metresPerPixel);
    }
  }
  // Mass says whether a tree thinned out, which overlap alone cannot tell from one that grew.
  return { overlap, drift, mass: isFilled / Math.max(1, wasFilled) };
}
function openEdges(part) {
  const edges = new Map();
  for (let t = 0; t < part.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = part.indices[t + e], b = part.indices[t + ((e + 1) % 3)], key = a < b ? `${a}_${b}` : `${b}_${a}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let open = 0;
  for (const count of edges.values()) if (count === 1) open++;
  return open;
}

// ---- merging -----------------------------------------------------------------------------------
// Merges vertices by place and ignores what joins them, so leaves become sheets that span the gaps between
// them. It stops short of what it is asked for, so the ask is raised until it lands just under.
function mergedPart(part, target) {
  const [merged] = MeshoptSimplifier.simplifySloppy(part.indices, part.positions, 3, null, Math.min(target * 3, part.indices.length), 1), kept = [];
  for (let t = 0; t < merged.length; t += 3) {
    const n = faceNormal(part.positions, merged[t], merged[t + 1], merged[t + 2]);
    if (n[0] || n[1] || n[2]) kept.push(merged[t], merged[t + 1], merged[t + 2]);
  }
  return { ...part, indices: Uint32Array.from(kept) };
}
// Share of the outline in its largest connected blob, from the side. A merge can part a crown from its
// trunk, and where the cells fall changes with the count, so another count nearby usually holds together.
function wholeness(parts, box) {
  let worst = 1;
  for (const axis of [0, 2]) {
    const { mask } = outlineOf(parts, axis, box), size = OUTLINE_PIXELS, seen = new Uint8Array(mask.length), stack = [];
    let filled = 0, largest = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      let blob = 0;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const at = stack.pop(), x = at % size, y = (at - x) / size;
        blob++;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy, next = ny * size + nx;
          if (nx >= 0 && ny >= 0 && nx < size && ny < size && mask[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
      filled += blob;
      largest = Math.max(largest, blob);
    }
    worst = Math.min(worst, largest / Math.max(1, filled));
  }
  return worst;
}
function mergeToBudget(parts, budget, box) {
  const total = parts.reduce((sum, part) => sum + part.indices.length / 3, 0), at = (share) => parts.map((part) => mergedPart(part, Math.max(1, Math.round((part.indices.length / 3) * share))));
  const size = (list) => list.reduce((sum, part) => sum + part.indices.length / 3, 0);
  const tried = [];
  let low = 0, high = Math.min(1, (budget * 4) / total);
  for (let i = 0; i < 14; i++) {
    const middle = (low + high) / 2, list = at(middle);
    if (size(list) <= budget) { low = middle; tried.push(list); } else high = middle;
  }
  // Nearby counts as well, because the search above closes in on one set of cells.
  for (let share = low * 0.98, i = 0; i < 16; i++, share *= 0.97) tried.push(at(share));
  tried.sort((a, b) => size(b) - size(a));
  const within = tried.filter((list) => size(list) <= budget && size(list) >= budget * MERGE_LEAST_SHARE);
  const whole = wholeness(parts, box) - MERGE_WHOLENESS_SLACK;
  return within.find((list) => wholeness(list, box) >= whole) ?? tried[0] ?? at(budget / total);
}

// ---- the search --------------------------------------------------------------------------------
export function createDecimator(input, options = {}) {
  const { doc, bin, parts, joints } = readGLB(input, { allowSkinned: options.allowSkinned });
  if (!parts.length) throw Error('This file has no triangles');
  const raw = modelBox(parts), diagonal = Math.hypot(...raw.hi.map((v, k) => v - raw.lo[k]));
  // A body that will be vertex-coloured has no seams to respect, which frees far more triangles.
  const source = options.ignoreUvs ? parts.map((part) => ({ ...part, uvs: null })) : parts;
  const welded = source.map((part) => weld(part, diagonal * 1e-5)).filter((part) => part.indices.length);
  const box = modelBox(welded), keepHidden = options.keepHidden ?? joints > 0;
  const original = { outlines: [0, 1, 2].map((axis) => outlineOf(welded, axis, box)) };
  for (const outline of original.outlines) outline.field = distanceField(outline.mask, OUTLINE_PIXELS);
  const sourceSamples = welded.map((part) => samplesOf(part, Math.min(3000, Math.max(300, part.indices.length))));
  const triangles = (list) => list.reduce((sum, part) => sum + part.indices.length / 3, 0);
  // At this distance the error is one pixel: closer than this, a viewer could see the difference.
  const metres = options.height ? options.height / (box.hi[1] - box.lo[1] || 1) : 1;
  const safeMetres = (distance) => distance * SCREEN_FOCAL_PIXELS * metres;
  const reduceAll = (allowed) => welded.map((part) => reducePart(part, diagonal * allowed, options));
  const measure = (allowed, reduced) => {
    let distance = 0;
    reduced.forEach((part, i) => {
      if (!part.indices.length) return;
      const away = worstDistance(sourceSamples[i], part), back = worstDistance(samplesOf(part, Math.min(1500, Math.max(200, part.indices.length * 4))), welded[i]);
      distance = Math.max(distance, away, back);
    });
    const outline = compareOutlines(original, reduced, box);
    return {
      allowed, parts: reduced, triangles: triangles(reduced), distance, overlap: outline.overlap, drift: outline.drift, mass: outline.mass,
      lost: reduced.filter((part) => !part.indices.length).length, open: reduced.reduce((sum, part) => sum + openEdges(part), 0),
      safeMetres: safeMetres(distance),
    };
  };
  const step = (allowed) => measure(allowed, reduceAll(allowed));
  // The smallest error shared by every part that fits, so all give up the same amount of shape. A share
  // per part would flatten the small ones first.
  const atBudget = (budget) => {
    let low = 1e-5, high = REACH_ERROR;
    if (triangles(reduceAll(high)) <= budget) for (let i = 0; i < 14; i++) {
      const middle = Math.sqrt(low * high);
      if (triangles(reduceAll(middle)) <= budget) high = middle; else low = middle;
    }
    const led = step(high);
    if (!options.merge) return led;
    const merged = measure(null, mergeToBudget(welded, budget, box));
    const chosen = merged.overlap > led.overlap || led.triangles > budget ? merged : led;
    // Too little left to read as the same thing, or a merge parted the crown from its trunk. Only merging
    // can do that: a reduction led by error keeps what joined what.
    return { ...chosen, parted: chosen.mass < MERGE_LEAST_MASS || (chosen === merged && wholeness(chosen.parts, box) < wholeness(welded, box) - MERGE_WHOLENESS_SLACK) };
  };
  // What is written loses what can never be seen, and is measured again to prove the outline held.
  const finish = (row) => {
    if (keepHidden) return { ...row, hiddenRemoved: 0 };
    const shown = dropHidden(row.parts, box), outline = compareOutlines(original, shown, box), kept = triangles(shown);
    return { ...row, parts: shown, triangles: kept, hiddenRemoved: row.triangles - kept, overlap: outline.overlap, mass: outline.mass, drift: Math.max(row.drift, outline.drift) };
  };
  return { doc, bin, welded, box, diagonal, joints, keepHidden, source: triangles(welded), textured: parts.some((part) => part.uvs) && (doc.images?.length ?? 0) > 0, step, atBudget, finish };
}
const passes = (row, diagonal, limits) => (limits.minOverlap !== undefined ? row.overlap >= limits.minOverlap : row.distance <= limits.maxError * diagonal && row.drift <= limits.maxDrift * diagonal) && (limits.dropSmall || row.lost === 0);
export function bestStep(decimator, { maxError = 0.01, maxDrift = 0.015, minOverlap, budget = null, dropSmall = false } = {}) {
  const rows = minOverlap !== undefined ? COUNT_LADDER.map((share) => decimator.atBudget(Math.round(decimator.source * share))) : LADDER.map((allowed) => decimator.step(allowed));
  let best = null;
  if (budget !== null) best = rows.find((row) => row.triangles <= budget && (dropSmall || row.lost === 0)) ?? null;
  else for (const row of rows) if (passes(row, decimator.diagonal, { maxError, maxDrift, minOverlap, dropSmall }) && (!best || row.triangles < best.triangles)) best = row;
  return { rows, best };
}
// Index lists into the file's own vertices, which a skinned body needs: its weights stay where they are.
export function sourceIndices(row) {
  return row.parts.map((part) => ({ name: part.name, indices: Array.from(part.indices, (v) => part.origin[v]) }));
}

// ---- writing ----------------------------------------------------------------------------------
// Corners split where faces meet at more than the crease angle, so flat faces stay flat.
export function hardenNormals(part, creaseDegrees = 38) {
  const cosine = Math.cos((creaseDegrees * Math.PI) / 180), faces = [], around = new Map();
  for (let t = 0; t < part.indices.length; t += 3) {
    const n = faceNormal(part.positions, part.indices[t], part.indices[t + 1], part.indices[t + 2]), id = t / 3;
    faces.push({ n, u: unit(n) });
    for (let e = 0; e < 3; e++) { const v = part.indices[t + e]; if (!around.has(v)) around.set(v, []); around.get(v).push(id); }
  }
  const positions = [], normals = [], uvs = part.uvs ? [] : null, indices = [], seen = new Map();
  for (let t = 0; t < part.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const v = part.indices[t + e], me = faces[t / 3].u, sum = [0, 0, 0];
    for (const other of around.get(v)) {
      const o = faces[other];
      if (me[0] * o.u[0] + me[1] * o.u[1] + me[2] * o.u[2] >= cosine) for (let k = 0; k < 3; k++) sum[k] += o.n[k];
    }
    const n = unit(sum), key = `${v}:${n[0].toFixed(3)},${n[1].toFixed(3)},${n[2].toFixed(3)}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = positions.length / 3;
      seen.set(key, at);
      positions.push(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]);
      normals.push(...n);
      if (uvs) uvs.push(part.uvs[v * 2], part.uvs[v * 2 + 1]);
    }
    indices.push(at);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: uvs && new Float32Array(uvs), indices: new Uint32Array(indices) };
}
export function writeGLB(decimator, parts, { crease = 38 } = {}) {
  const { doc, bin } = decimator, accessors = [], bufferViews = [], meshes = [], nodes = [], chunks = [];
  let offset = 0, vertices = 0;
  const pushBytes = (bytes, target) => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), pad = (4 - (buffer.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length, ...(target ? { target } : {}) });
    chunks.push(buffer, Buffer.alloc(pad));
    offset += buffer.length + pad;
    return bufferViews.length - 1;
  };
  const pushAccessor = (values, target, type, component, extra = {}) => {
    const size = { VEC2: 2, VEC3: 3, SCALAR: 1 }[type];
    accessors.push({ bufferView: pushBytes(values, target), componentType: component, count: values.length / size, type, ...extra });
    return accessors.length - 1;
  };
  for (const part of parts) {
    if (!part.indices.length) continue;
    const hard = hardenNormals(part, crease), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < hard.positions.length; i++) { const k = i % 3; if (hard.positions[i] < lo[k]) lo[k] = hard.positions[i]; if (hard.positions[i] > hi[k]) hi[k] = hard.positions[i]; }
    vertices += hard.positions.length / 3;
    const attributes = { POSITION: pushAccessor(hard.positions, 34962, 'VEC3', 5126, { min: lo, max: hi }), NORMAL: pushAccessor(hard.normals, 34962, 'VEC3', 5126) };
    if (hard.uvs) attributes.TEXCOORD_0 = pushAccessor(hard.uvs, 34962, 'VEC2', 5126);
    meshes.push({ primitives: [{ attributes, indices: pushAccessor(hard.indices, 34963, 'SCALAR', 5125), ...(part.material === undefined ? {} : { material: part.material }) }] });
    nodes.push({ mesh: meshes.length - 1, name: part.name });
  }
  // Images embedded in the source travel with it.
  const images = (doc.images ?? []).map((image) => {
    if (image.bufferView === undefined) return image;
    const view = doc.bufferViews[image.bufferView], bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    return { ...image, bufferView: pushBytes(bytes) };
  });
  const body = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'waterworld safe-decimate' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: body.length }],
    ...(doc.materials ? { materials: doc.materials } : {}), ...(doc.textures ? { textures: doc.textures } : {}), ...(doc.samplers ? { samplers: doc.samplers } : {}), ...(images.length ? { images } : {}),
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + body.length, 8);
  jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  binHead.writeUInt32LE(body.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonHead, json, binHead, body]), vertices };
}

// ---- command line -----------------------------------------------------------------------------
// Fewer triangles are seen smaller, so their texture can be too: this many pixels along the root of the count.
export const bakeSize = (triangles, pixels) => 2 ** Math.round(Math.log2(Math.min(2048, Math.max(64, pixels * Math.sqrt(triangles)))));
function share(text, diagonal) {
  if (text === undefined) return undefined;
  return text.endsWith('m') ? Number(text.slice(0, -1)) / diagonal : Number(text.replace('%', '')) / (text.endsWith('%') ? 100 : 1);
}
async function main(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { args._.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    if (['drop-small', 'keep-hidden', 'no-locks', 'no-uvs'].includes(name)) args[name] = true;
    else args[name] = argv[++i];
  }
  if (!args._[0]) { console.log('Usage: node scripts/safe-decimate.mjs in.glb [--type prop|structure|character|foliage] [--out out.glb] [--levels 2000,500] [--indices out.json] [--python venv/bin/python] [--bake-size 512] [--height 18.5] [--max-error 1%] [--max-drift 1.5%] [--budget N] [--lods 0.5%,1%] [--drop-small] [--keep-hidden] [--no-locks] [--no-uvs] [--crease 38] [--report out.json]'); return 2; }
  if (args.type && !ASSET_TYPES[args.type]) { console.error(`Unknown --type ${args.type}. One of: ${Object.keys(ASSET_TYPES).join(', ')}`); return 2; }
  await MeshoptSimplifier.ready;
  const type = ASSET_TYPES[args.type] ?? {};
  const decimator = createDecimator(readFileSync(args._[0]), {
    ...type, dropSmall: args['drop-small'] ?? type.dropSmall, keepHidden: args['keep-hidden'] ? true : type.keepHidden, locks: args['no-locks'] ? false : type.locks,
    ignoreUvs: args['no-uvs'] ?? type.ignoreUvs, height: args.height ? Number(args.height) : undefined,
  });
  const { diagonal } = decimator;
  const crease = args.crease ? Number(args.crease) : (type.crease ?? 38);
  // What a type dropped from the mesh comes back from the source, baked onto the fresh surface.
  const bakeBack = (path, triangles) => {
    if (!type.bake || !decimator.textured) return true;
    const script = join(dirname(fileURLToPath(import.meta.url)), 'rebake-texture.py'), size = args['bake-size'] ?? String(bakeSize(triangles, type.bakePixels));
    if (!args.python) { console.log(`${path} has no texture yet. Bake it with: <python with bpy> ${script} ${args._[0]} ${path} ${path} ${size}`); return true; }
    const run = spawnSync(args.python, [script, args._[0], path, path, size], { encoding: 'utf8' });
    if (run.status !== 0) { console.error(`The bake failed:\n${run.stderr || run.stdout}`); return false; }
    console.log(run.stdout.split('\n').filter((line) => line.startsWith('BAKED')).join('\n'));
    return true;
  };
  const describe = (row) => `${row.triangles} triangles, outline moved ${((row.drift / diagonal) * 100).toFixed(2)}%, overlap ${(row.overlap * 100).toFixed(1)}%, mass ${(row.mass * 100).toFixed(0)}%, one pixel from ${row.safeMetres.toFixed(1)} m${row.allowed === null ? ', by merging' : ''}${row.parted ? '. CAME APART: too few triangles for this shape' : ''}`;
  console.log(`${decimator.welded.length} parts, ${decimator.source} triangles, diagonal ${diagonal.toFixed(3)} m${decimator.keepHidden ? ', hidden triangles stay' : ''}${args.type ? `, as ${args.type}` : ''}`);
  if (args.levels) {
    const base = (args.out ?? args._[0]).replace(/\.glb$/, ''), levels = [];
    for (const budget of args.levels.split(',').map(Number)) {
      const row = decimator.finish(decimator.atBudget(budget));
      levels.push({ budget, triangles: row.triangles, distance: row.distance, drift: row.drift, overlap: row.overlap, mass: row.mass, safeMetres: row.safeMetres, parts: args.indices ? sourceIndices(row) : undefined });
      console.log(`${String(budget).padStart(7)}: ${describe(row)}`);
      if (args.out || !args.indices) {
        const path = `${base}-${budget}.glb`;
        writeFileSync(path, writeGLB(decimator, row.parts, { crease }).bytes);
        if (!bakeBack(path, row.triangles)) return 1;
      }
    }
    if (args.indices) writeFileSync(args.indices, JSON.stringify({ source: args._[0], levels }));
    return 0;
  }
  const limits = { maxError: share(args['max-error'], diagonal) ?? type.maxError ?? 0.01, maxDrift: share(args['max-drift'], diagonal) ?? type.maxDrift ?? 0.015, minOverlap: type.minOverlap, budget: args.budget ? Number(args.budget) : null, dropSmall: !!args['drop-small'] };
  const { rows, best } = bestStep(decimator, limits);
  console.log('allowed  triangles  surface error  outline moved  overlap  mass  parts lost  one pixel from');
  for (const row of rows) console.log(`${(row.allowed === null ? 'count' : `${(row.allowed * 100).toFixed(2)}%`).padStart(7)}  ${String(row.triangles).padStart(9)}  ${((row.distance / diagonal) * 100).toFixed(2).padStart(12)}%  ${((row.drift / diagonal) * 100).toFixed(2).padStart(12)}%  ${(row.overlap * 100).toFixed(1).padStart(6)}%  ${(row.mass * 100).toFixed(0).padStart(3)}%  ${String(row.lost).padStart(10)}  ${row.safeMetres.toFixed(1).padStart(12)} m${row === best ? '  <- chosen' : ''}`);
  const report = { source: decimator.source, diagonal, chosen: best?.allowed ?? null, steps: rows.map(({ parts, ...row }) => row) };
  if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 1));
  if (args.lods) {
    const base = (args.out ?? args._[0]).replace(/\.glb$/, '');
    args.lods.split(',').forEach((text, i) => {
      const row = decimator.finish(decimator.step(share(text, diagonal))), { bytes, vertices } = writeGLB(decimator, row.parts, { crease });
      writeFileSync(`${base}-lod${i}.glb`, bytes);
      console.log(`lod${i}: ${row.triangles} triangles, ${vertices} vertices, safe from ${row.safeMetres.toFixed(1)} m`);
    });
    return 0;
  }
  if (!args.out) return 0;
  if (!best) { console.error('No step passes those limits, so nothing was written. Loosen them or use --budget.'); return 1; }
  const final = decimator.finish(best);
  const { bytes, vertices } = writeGLB(decimator, final.parts, { crease });
  writeFileSync(args.out, bytes);
  console.log(`wrote ${args.out}: ${final.triangles} triangles (${final.hiddenRemoved} never seen, removed), ${vertices} vertices, outline moved ${((final.drift / diagonal) * 100).toFixed(2)}%`);
  return bakeBack(args.out, final.triangles) ? 0 : 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
