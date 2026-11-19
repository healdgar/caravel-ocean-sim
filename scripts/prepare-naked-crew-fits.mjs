#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Builds clean, stain-free undressed anatomical male and female crew base bodies on the 93-joint Unreal skeleton
// from the CC0 Quaternius anatomical base meshes (`assets/crew/sailor-classic.glb`, `assets/crew/sailor-female-classic.glb`),
// stripping all legacy baked hair/belts/cuffs/garters/neck-bands and tagging 100% of body geometry as clean skin (region 3),
// eyes as crisp paint (region 0), and eyebrows as hair (region 4). Clothing is drawn separately by js/clothing-continuum.js.
//
// Usage:
//   node scripts/prepare-naked-crew-fits.mjs [--bake]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readGLB } from '../js/gltf.js';
import { CREW_CONTINUUM_BODIES, CREW_CONTINUUM_STREAMS, validateCrewContinuumManifest } from '../js/crew-continuum.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FITS = path.join(os.tmpdir(), 'ww-naked-crew-fits');
const CONTINUUM_DIR = path.join(ROOT, 'assets/crew/continuum');

const COMPONENT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorOf(asset, idx) {
  const a = asset.json.accessors[idx], v = asset.json.bufferViews[a.bufferView];
  const Type = COMPONENT[a.componentType], n = WIDTH[a.type];
  const off = asset.bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Type(asset.bin.buffer.slice(off, off + a.count * n * Type.BYTES_PER_ELEMENT));
}

// Minimal deterministic uncompressed/zlib-compressed RGBA PNG encoder (zero external deps).
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Build clean 512x512 neutral anatomical skin + lip + sclera + iris + eyebrow texture (sRGB PNG).
// Four clean, widely separated islands so mipmaps never bleed across skin, eyes, or eyebrows!
function buildAnatomicalTexture(size = 512) {
  const rgba = new Uint8Array(size * size * 4);
  // Fill entire background with clean neutral skin (#d4b49e) so mip bleed is impossible!
  const setPx = (x, y, r, g, b) => {
    const o = (y * size + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Subtle organic micro-grain (< 2%) so skin looks natural up close
      const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const n = ((h - Math.floor(h)) - 0.5) * 4;
      setPx(x, y, Math.round(212 + n), Math.round(180 + n * 0.8), Math.round(158 + n * 0.7));
    }
  }
  // Island 1 (top-right, u in [0.54..0.74], v in [0.04..0.24]): soft subtle anatomical lip tint (still region 3 skin!)
  for (let y = Math.floor(size * 0.04); y < Math.floor(size * 0.24); y++) {
    for (let x = Math.floor(size * 0.54); x < Math.floor(size * 0.74); x++) {
      setPx(x, y, 186, 134, 122);
    }
  }
  // Island 2 (top-far-right, u in [0.76..0.96], v in [0.04..0.24]): gentle recessed crease / under-brow skin shade
  for (let y = Math.floor(size * 0.04); y < Math.floor(size * 0.24); y++) {
    for (let x = Math.floor(size * 0.76); x < Math.floor(size * 0.96); x++) {
      setPx(x, y, 192, 160, 138);
    }
  }
  // Island 3 (bottom-right-left, u in [0.54..0.74], v in [0.54..0.74]): crisp eye sclera (region 0 paint)
  for (let y = Math.floor(size * 0.54); y < Math.floor(size * 0.74); y++) {
    for (let x = Math.floor(size * 0.54); x < Math.floor(size * 0.74); x++) {
      setPx(x, y, 224, 220, 214);
    }
  }
  // Island 4 (bottom-far-right, u in [0.76..0.96], v in [0.54..0.74]): deep dark iris & pupil (region 0 paint)
  for (let y = Math.floor(size * 0.54); y < Math.floor(size * 0.74); y++) {
    for (let x = Math.floor(size * 0.76); x < Math.floor(size * 0.96); x++) {
      setPx(x, y, 42, 30, 22);
    }
  }
  // Island 5 (bottom-left, u in [0.04..0.46], v in [0.54..0.96]): eyebrows (region 4 hair)
  for (let y = Math.floor(size * 0.54); y < Math.floor(size * 0.96); y++) {
    for (let x = Math.floor(size * 0.04); x < Math.floor(size * 0.46); x++) {
      setPx(x, y, 92, 68, 52);
    }
  }
  return encodePNG(size, size, rgba);
}

function buildUndressedFit(classicPath, female) {
  const bytes = fs.readFileSync(classicPath);
  const asset = readGLB(bytes), g = asset.json;
  // Meshes 0, 1, 2 in both sailor-classic.glb and sailor-female-classic.glb are:
  //   0: Eyebrows (Face / Eyebrows) -> region 4 (hair)
  //   1: Eyes (Face.001 / Eyes)     -> region 0 (paint: sclera vs dark iris/pupil)
  //   2: Full anatomical body       -> region 3 (100% clean undressed skin!)
  // Meshes 3+ (legacy hair, belt, cuffs, garters, neck band) are intentionally stripped!
  const keepMeshes = [0, 1, 2];
  const positions = [], normals = [], uvs = [], joints = [], weights = [], regions = [], indices = [];
  let vertBase = 0;

  // Measured mouth center for subtle lip tint on anatomical body
  const lipY = female ? 1.592 : 1.635;
  const lipZ = female ? 0.068 : 0.072;

  for (const mi of keepMeshes) {
    const prim = g.meshes[mi].primitives[0];
    const pos = accessorOf(asset, prim.attributes.POSITION);
    const nrm = accessorOf(asset, prim.attributes.NORMAL);
    const col = accessorOf(asset, prim.attributes.COLOR_0);
    const jnt = accessorOf(asset, prim.attributes.JOINTS_0);
    const wgt = accessorOf(asset, prim.attributes.WEIGHTS_0);
    const idx = accessorOf(asset, prim.indices);
    const n = pos.length / 3;

    for (let v = 0; v < n; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      positions.push(x, y, z);
      normals.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);

      let sum = 0;
      const w4 = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) { w4[k] = Math.max(0, wgt[v * 4 + k]); sum += w4[k]; }
      if (sum < 1e-6) { w4[0] = 1; sum = 1; }
      for (let k = 0; k < 4; k++) { joints.push(jnt[v * 4 + k]); weights.push(w4[k] / sum); }

      if (mi === 0) {
        // Eyebrows -> region 4 (hair) in bottom-left island [0.06..0.44, 0.56..0.94]
        const u = 0.08 + Math.min(0.34, Math.max(0, (x + 0.12) * 1.4));
        const vv = 0.58 + Math.min(0.34, Math.max(0, (y - 1.55) * 1.4));
        uvs.push(u, vv);
        regions.push(4, 0, 0, 0);
      } else if (mi === 1) {
        // Eyes -> region 0 (paint): bright sclera vs dark iris/pupil
        const lum = (col[v * 3] + col[v * 3 + 1] + col[v * 3 + 2]) / 3;
        const du = Math.min(0.14, Math.max(0, (x + 0.08) * 0.9));
        const dv = Math.min(0.14, Math.max(0, (y - 1.60) * 0.9));
        if (lum > 0.30) uvs.push(0.56 + du, 0.56 + dv);
        else uvs.push(0.78 + du, 0.56 + dv);
        regions.push(0, 0, 0, 0);
      } else {
        // Anatomical body -> 100% region 3 (clean stain-free skin!)
        const isLip = z > lipZ && Math.abs(x) < 0.026 && Math.abs(y - lipY) < 0.011;
        if (isLip) {
          const du = Math.min(0.14, Math.max(0, (x + 0.03) * 2.2));
          const dv = Math.min(0.14, Math.max(0, (y - (lipY - 0.015)) * 4.5));
          uvs.push(0.56 + du, 0.06 + dv);
        } else {
          // Smooth cylindrical unwrap into top-left clean skin island [0.06..0.44, 0.06..0.44]
          const ang = (Math.atan2(x, z) + Math.PI) / (2 * Math.PI);
          const u = 0.06 + ang * 0.38;
          const vv = 0.06 + Math.min(1, Math.max(0, (y + 0.04) / 1.90)) * 0.38;
          uvs.push(u, vv);
        }
        regions.push(3, 0, 0, 0);
      }
    }
    for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertBase);
    vertBase += n;
  }

  // Pack single-primitive GLB preserving the exact 93-joint Unreal skeleton & Idle/Walk/Brace animations
  const chunks = [], views = [], accessors = [];
  let length = 0;
  const addView = (buf, target) => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    const byteOffset = length;
    chunks.push(buf); length += buf.length;
    const vi = views.length;
    views.push(target ? { buffer: 0, byteOffset, byteLength: buf.length, target } : { buffer: 0, byteOffset, byteLength: buf.length });
    return vi;
  };
  const addAcc = (typed, type, componentType, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const bufferView = addView(buf, target);
    const width = WIDTH[type];
    const count = typed.length / width;
    const acc = { bufferView, componentType, count, type };
    if (type === 'VEC3' || type === 'SCALAR') {
      const min = Array(width).fill(Infinity), max = Array(width).fill(-Infinity);
      for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) {
        const val = typed[i * width + k];
        if (val < min[k]) min[k] = val;
        if (val > max[k]) max[k] = val;
      }
      acc.min = min; acc.max = max;
    }
    const ai = accessors.length;
    accessors.push(acc);
    return ai;
  };

  const copied = new Map();
  const copyAcc = (oldIdx) => {
    if (copied.has(oldIdx)) return copied.get(oldIdx);
    const a = g.accessors[oldIdx], data = accessorOf(asset, oldIdx);
    const ai = addAcc(data, a.type, a.componentType);
    copied.set(oldIdx, ai);
    return ai;
  };

  const attributes = {
    POSITION: addAcc(Float32Array.from(positions), 'VEC3', 5126, 34962),
    NORMAL: addAcc(Float32Array.from(normals), 'VEC3', 5126, 34962),
    TEXCOORD_0: addAcc(Float32Array.from(uvs), 'VEC2', 5126, 34962),
    JOINTS_0: addAcc(Uint8Array.from(joints), 'VEC4', 5121, 34962),
    WEIGHTS_0: addAcc(Float32Array.from(weights), 'VEC4', 5126, 34962),
    _REGION: addAcc(Uint8Array.from(regions), 'VEC4', 5121, 34962),
  };
  const idxAcc = addAcc(Uint32Array.from(indices), 'SCALAR', 5125, 34963);

  const skin0 = g.skins[0];
  const ibmAcc = copyAcc(skin0.inverseBindMatrices);
  const animations = g.animations.map((a) => ({
    name: a.name,
    channels: a.channels,
    samplers: a.samplers.map((s) => ({
      input: copyAcc(s.input),
      output: copyAcc(s.output),
      interpolation: s.interpolation ?? 'LINEAR',
    })),
  }));

  const png = buildAnatomicalTexture(512);
  const imgView = addView(png);
  const binPad = (4 - (length % 4)) % 4;
  if (binPad) { chunks.push(Buffer.alloc(binPad)); length += binPad; }

  // Strip extra mesh nodes (legacy hair/belt/cuffs) from the scene while keeping all 93 joint nodes and 1 body mesh node intact!
  const jointSet = new Set(skin0.joints);
  const bodyMeshNode = g.nodes.findIndex((n) => n.mesh === 2);
  const nodes = g.nodes.map((node, i) => {
    if (i === bodyMeshNode) return { name: female ? 'UndressedFemaleBody' : 'UndressedMaleBody', mesh: 0, skin: 0 };
    if (node.mesh !== undefined) return { name: node.name ?? `stripped_${i}` }; // empty node, never breaks indices!
    return node;
  });

  const json = {
    asset: { version: '2.0', generator: 'waterworld/scripts/prepare-naked-crew-fits.mjs' },
    scene: g.scene ?? 0,
    scenes: g.scenes,
    nodes,
    meshes: [{ name: female ? 'undressed-female' : 'undressed-male', primitives: [{ attributes, indices: idxAcc, material: 0 }] }],
    materials: [{
      name: 'Clean anatomical skin',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.78 },
      doubleSided: false,
    }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: imgView, mimeType: 'image/png' }],
    skins: [{ name: skin0.name, joints: skin0.joints, inverseBindMatrices: ibmAcc }],
    animations,
    buffers: [{ byteLength: length }],
    bufferViews: views,
    accessors,
  };

  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  jsonHeader.writeUInt32LE(text.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, text, binHeader, bin]);
}

fs.mkdirSync(OUT_FITS, { recursive: true });
const maleGLB = buildUndressedFit(path.join(ROOT, 'assets/crew/sailor-classic.glb'), false);
const femaleGLB = buildUndressedFit(path.join(ROOT, 'assets/crew/sailor-female-classic.glb'), true);
fs.writeFileSync(path.join(OUT_FITS, 'sailor-male.glb'), maleGLB);
fs.writeFileSync(path.join(OUT_FITS, 'villager-female.glb'), femaleGLB);
console.log(`Wrote clean undressed fits: sailor-male.glb (${maleGLB.length} B), villager-female.glb (${femaleGLB.length} B)`);

if (process.argv.includes('--bake')) {
  console.log('Baking clean undressed male & female base bodies through One Continuum...');
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts/prepare-crew-continuum.mjs'),
    `--fits=${OUT_FITS}`,
    `--out=${CONTINUUM_DIR}`,
    '--only=sailor-male,villager-female',
    '--texture=512',
    '--far=8000',
    '--standin=8000',
  ], { stdio: 'inherit', cwd: ROOT });

  // Propagate the exact validated undressed male / female continuum base body to all 12 CREW_CONTINUUM_BODIES
  // (every person wears clean stain-free skin underneath and gets their role/culture outfit from clothing-continuum.js!).
  for (const entry of CREW_CONTINUUM_BODIES) {
    if (entry.id === 'sailor-male' || entry.id === 'villager-female') continue;
    const srcId = entry.sex === 'female' ? 'villager-female' : 'sailor-male';
    const srcDir = path.join(CONTINUUM_DIR, srcId);
    const dstDir = path.join(CONTINUUM_DIR, entry.id);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const file of ['body.glb', ...CREW_CONTINUUM_STREAMS.map((s) => `${s}.gz`)]) {
      fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
    manifest.id = entry.id;
    manifest.sex = entry.sex;
    manifest.role = entry.role;
    validateCrewContinuumManifest(manifest);
    fs.writeFileSync(path.join(dstDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    console.log(`  propagated clean undressed ${srcId} -> ${entry.id}`);
  }
  console.log('All 12 crew continuum base bodies updated to clean undressed anatomical meshes!');
}
