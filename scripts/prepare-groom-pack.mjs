// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Packs the 10 canonically aligned 3D hair, coif, roach, and 1550 beard/mustache
// meshes into a single compact runtime asset (`assets/crew/groom-pack.glb`) with
// pre-computed near/mid/far LOD index tiers and Waterworld garment/paint COLOR_0 tags.
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;

const inJson = process.argv[2];
const inBin = process.argv[3];
const outGlb = process.argv[4] || 'assets/crew/groom-pack.glb';
if (!inJson || !inBin) {
  throw new Error('Usage: node scripts/prepare-groom-pack.mjs <canonical.json> <canonical.bin> [out.glb]');
}

const manifest = JSON.parse(readFileSync(inJson, 'utf8'));
const rawBin = readFileSync(inBin);

const TARGET_BUDGETS = {
  hair_1550_cropped: [400, 180, 80],
  hair_1550_wavy: [440, 190, 84],
  hair_1550_female_bun: [400, 180, 80],
  hair_1550_coif_cap: [400, 180, 80],
  hair_indigenous_long: [400, 180, 80],
  hair_indigenous_plaits: [440, 190, 84],
  hair_algonquian_roach: [420, 180, 80],
  beard_1550_pointed: [340, 150, 64],
  beard_1550_full_mariner: [360, 160, 68],
  beard_1550_tercio_strap: [340, 150, 64],
};

function linToSrgb(x) {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
}

function encodeGroomColors(mode, rawColors) {
  const count = rawColors.length / 3;
  const out = new Float32Array(count * 3);
  if (mode === 'paint') {
    for (let i = 0; i < count; i++) {
      out[i * 3 + 0] = Math.min(1.85, Math.max(0.02, rawColors[i * 3 + 0] * 1.06));
      out[i * 3 + 1] = Math.min(1.85, Math.max(0.02, rawColors[i * 3 + 1] * 1.06));
      out[i * 3 + 2] = Math.min(1.85, Math.max(0.02, rawColors[i * 3 + 2] * 1.06));
    }
    return out;
  }
  const lums = [];
  for (let i = 0; i < count; i++) {
    const r = rawColors[i * 3], g = rawColors[i * 3 + 1], b = rawColors[i * 3 + 2];
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const sorted = [...lums].sort((a, b) => a - b);
  const median = Math.max(0.02, sorted[Math.floor(sorted.length * 0.5)] ?? 0.12);
  for (let i = 0; i < count; i++) {
    const r = rawColors[i * 3], g = rawColors[i * 3 + 1], b = rawColors[i * 3 + 2];
    const sr = linToSrgb(r), sg = linToSrgb(g);
    if (mode === 'hair_with_red_ties' && (sr - sg) > 0.18) {
      // Crimson woven braid ties stay untinted paint (garment = 0)
      out[i * 3 + 0] = 0.55;
      out[i * 3 + 1] = 0.045;
      out[i * 3 + 2] = 0.038;
      continue;
    }
    if (mode === 'roach' && (sr - sg) > 0.16) {
      // Dyed crimson deer-hair crest bristles stay untinted crimson paint (garment = 0)
      out[i * 3 + 0] = Math.min(1.65, Math.max(0.28, r * 1.38));
      out[i * 3 + 1] = Math.min(0.45, Math.max(0.02, g * 0.45));
      out[i * 3 + 2] = Math.min(0.35, Math.max(0.02, b * 0.35));
      continue;
    }
    const shade = Math.min(1.85, Math.max(0.38, lums[i] / median));
    out[i * 3 + 0] = shade;
    out[i * 3 + 1] = shade;
    out[i * 3 + 2] = shade + 8.0; // garment = 4 (HAIR)
  }
  return out;
}

function recomputeSmoothNormals(positions, indices) {
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz;
    }
  }
  for (let i = 0; i < count; i++) {
    const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    normals[i * 3] /= len; normals[i * 3 + 1] /= len; normals[i * 3 + 2] /= len;
  }
  return normals;
}

// Weld spatially coincident vertices sharing same material band so Meshopt collapses cleanly
function weldPiece(positions, rawColors, mode, indices) {
  const encoded = encodeGroomColors(mode, rawColors);
  const count = positions.length / 3;
  const map = new Map();
  const remap = new Uint32Array(count);
  const outPos = [], outCol = [];
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const band = encoded[i * 3 + 2] >= 7 ? 1 : 0;
    const key = `${band}:${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;
    let dst = map.get(key);
    if (dst === undefined) {
      dst = outPos.length / 3;
      map.set(key, dst);
      outPos.push(x, y, z);
      outCol.push(encoded[i * 3], encoded[i * 3 + 1], encoded[i * 3 + 2]);
    }
    remap[i] = dst;
  }
  const outIdx = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]], b = remap[indices[i + 1]], c = remap[indices[i + 2]];
    if (a !== b && b !== c && a !== c) outIdx.push(a, b, c);
  }
  const posArr = new Float32Array(outPos);
  const colArr = new Float32Array(outCol);
  const idxArr = new Uint32Array(outIdx);
  const normArr = recomputeSmoothNormals(posArr, idxArr);
  return { positions: posArr, normals: normArr, colors: colArr, indices: idxArr };
}

function simplifyToTarget(mesh, targetTris) {
  const count = mesh.positions.length / 3;
  const attrs = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    attrs[i * 6 + 0] = mesh.normals[i * 3 + 0];
    attrs[i * 6 + 1] = mesh.normals[i * 3 + 1];
    attrs[i * 6 + 2] = mesh.normals[i * 3 + 2];
    attrs[i * 6 + 3] = mesh.colors[i * 3 + 0];
    attrs[i * 6 + 4] = mesh.colors[i * 3 + 1];
    attrs[i * 6 + 5] = mesh.colors[i * 3 + 2] >= 7 ? 2.0 : 0.0;
  }
  const weights = [0.01, 0.01, 0.01, 0.02, 0.02, 0.5];
  const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
    mesh.indices,
    mesh.positions,
    3,
    attrs,
    6,
    weights,
    null,
    targetTris * 3,
    0.25,
    ['Permissive', 'RegularizeLight'],
  );
  return new Uint32Array(simplified);
}

const nodes = [];
const meshes = [];
const bufferViews = [];
const accessors = [];
const chunks = [];
let byteLength = 0;

function appendAccessor(typed, type, componentType, target) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.byteLength % 4)) % 4;
  const viewIdx = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
  chunks.push(bytes);
  if (pad) chunks.push(new Uint8Array(pad));
  byteLength += bytes.byteLength + pad;

  const nComp = type === 'VEC3' ? 3 : 1;
  const count = typed.length / nComp;
  const acc = { bufferView: viewIdx, componentType, count, type };
  if (type === 'VEC3' && componentType === 5126) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = typed[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    acc.min = min;
    acc.max = max;
  }
  const accIdx = accessors.length;
  accessors.push(acc);
  return accIdx;
}

for (const entry of manifest) {
  const sliceF32 = ([off, len]) => new Float32Array(rawBin.buffer.slice(rawBin.byteOffset + off, rawBin.byteOffset + off + len));
  const sliceU32 = ([off, len]) => new Uint32Array(rawBin.buffer.slice(rawBin.byteOffset + off, rawBin.byteOffset + off + len));
  const welded = weldPiece(sliceF32(entry.v), sliceF32(entry.c), entry.mode, sliceU32(entry.f));
  const [nearBudget, midBudget, farBudget] = TARGET_BUDGETS[entry.name] ?? [380, 170, 75];
  const nearRaw = simplifyToTarget(welded, nearBudget);

  // Compact to only vertices referenced by nearRaw, then simplify mid & far over compacted vertices!
  const used = new Uint8Array(welded.positions.length / 3);
  for (const idx of nearRaw) used[idx] = 1;
  const remap = new Int32Array(used.length).fill(-1);
  let compactCount = 0;
  for (let i = 0; i < used.length; i++) if (used[i]) remap[i] = compactCount++;

  const pos = new Float32Array(compactCount * 3);
  const col = new Float32Array(compactCount * 3);
  for (let i = 0; i < used.length; i++) {
    const dst = remap[i];
    if (dst < 0) continue;
    pos.set(welded.positions.subarray(i * 3, i * 3 + 3), dst * 3);
    col.set(welded.colors.subarray(i * 3, i * 3 + 3), dst * 3);
  }
  const nearIdx32 = Uint32Array.from(nearRaw, (idx) => remap[idx]);
  const norm = recomputeSmoothNormals(pos, nearIdx32);
  const compactMesh = { positions: pos, normals: norm, colors: col, indices: nearIdx32 };
  const midIdx32 = simplifyToTarget(compactMesh, midBudget);
  const farIdx32 = simplifyToTarget(compactMesh, farBudget);

  const nearIdx = Uint16Array.from(nearIdx32);
  const midIdx = Uint16Array.from(midIdx32);
  const farIdx = Uint16Array.from(farIdx32);

  const posAcc = appendAccessor(pos, 'VEC3', 5126, 34962);
  const normAcc = appendAccessor(norm, 'VEC3', 5126, 34962);
  const colAcc = appendAccessor(col, 'VEC3', 5126, 34962);
  const idxAcc = appendAccessor(nearIdx, 'SCALAR', 5123, 34963);
  const midAcc = appendAccessor(midIdx, 'SCALAR', 5123, 34963);
  const farAcc = appendAccessor(farIdx, 'SCALAR', 5123, 34963);

  const meshIdx = meshes.length;
  meshes.push({
    name: entry.name,
    primitives: [{
      attributes: { POSITION: posAcc, NORMAL: normAcc, COLOR_0: colAcc },
      indices: idxAcc,
      mode: 4,
      extras: { crewLevels: [midAcc, farAcc] },
    }],
  });
  nodes.push({ name: entry.name, mesh: meshIdx });
  console.log(`${entry.name.padEnd(26)}: verts=${String(compactCount).padStart(4)} tris=${nearIdx.length / 3} / ${midIdx.length / 3} / ${farIdx.length / 3}`);
}

const gltf = {
  asset: { version: '2.0', generator: 'waterworld prepare-groom-pack' },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  meshes,
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
};

const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const jsonPadded = jsonPad ? Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]) : jsonBuf;
const binBuf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
const totalLength = 12 + 8 + jsonPadded.length + 8 + binBuf.length;
const header = Buffer.alloc(12);
header.write('glTF', 0, 4, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);
const jHdr = Buffer.alloc(8);
jHdr.writeUInt32LE(jsonPadded.length, 0);
jHdr.writeUInt32LE(0x4e4f534a, 4);
const bHdr = Buffer.alloc(8);
bHdr.writeUInt32LE(binBuf.length, 0);
bHdr.writeUInt32LE(0x004e4942, 4);

const outBytes = Buffer.concat([header, jHdr, jsonPadded, bHdr, binBuf]);
writeFileSync(outGlb, outBytes);
console.log(`Wrote ${outGlb}: ${(outBytes.length / 1024).toFixed(1)} KB`);
