#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every tree of a forest pack into a cluster hierarchy the GPU can cut at any level of detail.
//   node scripts/prepare-forest-clusters.mjs saba [--only=oak] [--stats]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildDag } from '../third_party/threejs-nanites/dag/build.ts';
import { FOREST_CLUSTER_VERTEX_WORDS, FOREST_CLUSTER_WORDS, FOREST_LEAF_VERTICES, packForestClusterVertex } from '../js/forest-clusters.js';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'saba';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const dir = path.join('assets/forest-scenery', packName);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const SOURCE_STRIDE = 14;
const MASK_SIZE = 64;
// A coarser leaf level's error as a share of its size. Our leaves are half as long as this measure.
const LEAF_ERROR_SHARE = 0.35;

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(path.join(dir, file)));
const asFloats = (buffer) => new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
const asWords = (buffer) => new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
const source = asFloats(gunzip('vertices.bin.gz'));
const indices = asWords(gunzip('indices.bin.gz'));
const canopyFile = path.join(dir, 'canopy-shade.bin.gz');
const canopy = fs.existsSync(canopyFile) ? zlib.gunzipSync(fs.readFileSync(canopyFile)) : null;

// A leaf texture's alpha as a coarse mask, so coarser levels cover what the finer ones did.
function leafMask(file) {
  const out = path.join(os.tmpdir(), `forest-mask-${process.pid}.bin`);
  execFileSync('python3', ['-c', `import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGBA').split()[3].resize((${MASK_SIZE},${MASK_SIZE}));open(sys.argv[2],'wb').write(bytes(1 if v>127 else 0 for v in im.getdata()))`, path.join(dir, file), out]);
  const bits = new Uint8Array(fs.readFileSync(out));
  fs.rmSync(out);
  return { size: MASK_SIZE, bits };
}

// Our leaves are two quads sharing an edge. The builder wants each leaf's quads in order, so the
// shared edge is written twice here, and dropped again when the result is packed.
function leafSource(p) {
  const leaves = p.leaf.indexCount / 12, map = new Uint32Array(leaves * 8);
  for (let leaf = 0; leaf < leaves; leaf++) {
    const at = p.leaf.firstIndex + leaf * 12, i = (k) => indices[at + k];
    map.set([i(0), i(1), i(2), i(5), i(6), i(7), i(8), i(11)], leaf * 8);
  }
  const pos = new Float32Array(map.length * 3), nrm = new Float32Array(map.length * 3), uv = new Float32Array(map.length * 2);
  map.forEach((v, k) => {
    const s = v * SOURCE_STRIDE;
    pos.set(source.subarray(s, s + 3), k * 3);
    nrm.set(source.subarray(s + 3, s + 6), k * 3);
    uv.set(source.subarray(s + 8, s + 10), k * 2);
  });
  return { map, leaves: { pos, nrm, uv, vpl: 8 } };
}
function woodSource(p) {
  const range = indices.subarray(p.wood.firstIndex, p.wood.firstIndex + p.wood.indexCount);
  const remap = new Map(), map = [];
  const idx = Uint32Array.from(range, (v) => {
    let local = remap.get(v);
    if (local === undefined) { local = map.length; remap.set(v, local); map.push(v); }
    return local;
  });
  const pos = new Float32Array(map.length * 3), nrm = new Float32Array(map.length * 3), uv = new Float32Array(map.length * 2);
  map.forEach((v, k) => {
    const s = v * SOURCE_STRIDE;
    pos.set(source.subarray(s, s + 3), k * 3);
    nrm.set(source.subarray(s + 3, s + 6), k * 3);
    uv.set(source.subarray(s + 8, s + 10), k * 2);
  });
  return { map, bark: { pos, nrm, uv, idx } };
}

const vertexWords = [], clusterWords = [], indexWords = [], prototypes = [];
let vertexCount = 0, indexCount = 0, clusterCount = 0;
for (const p of manifest.prototypes) {
  if (only && p.species !== only) continue;
  const started = Date.now();
  const foliage = p.nativeMaterials.find((m) => m.name.startsWith('foliage') || m.name.startsWith('leaf'));
  const wood = woodSource(p), leaf = leafSource(p);
  const dag = await buildDag({ id: p.id, bark: wood.bark, leaves: leaf.leaves, leafErr: LEAF_ERROR_SHARE, leafMask: foliage ? leafMask(foliage.albedo.file) : undefined });
  // Bounds, so positions and texture coordinates fit 16 bits.
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity], uvLow = [Infinity, Infinity], uvHigh = [-Infinity, -Infinity];
  const total = dag.vtx.length / 8;
  for (let i = 0; i < total; i++) {
    for (let a = 0; a < 3; a++) { low[a] = Math.min(low[a], dag.vtx[i * 8 + a]); high[a] = Math.max(high[a], dag.vtx[i * 8 + a]); }
    uvLow[0] = Math.min(uvLow[0], dag.vtx[i * 8 + 3]); uvHigh[0] = Math.max(uvHigh[0], dag.vtx[i * 8 + 3]);
    uvLow[1] = Math.min(uvLow[1], dag.vtx[i * 8 + 7]); uvHigh[1] = Math.max(uvHigh[1], dag.vtx[i * 8 + 7]);
  }
  const posScale = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2], 1e-3), uvScale = [Math.max(uvHigh[0] - uvLow[0], 1e-3), Math.max(uvHigh[1] - uvLow[1], 1e-3)];
  const quant = { low, posScale, uvLow, uvScale };
  const sourceOf = (packed) => packed < dag.barkVertices ? wood.map[packed] : leaf.map[dag.leafSource[packed - dag.barkVertices]];
  const write = (packed, out) => {
    const s = sourceOf(packed) * SOURCE_STRIDE, i = packed * 8, v = dag.vtx;
    out.push(...packForestClusterVertex({
      position: [v[i], v[i + 1], v[i + 2]], normal: [v[i + 4], v[i + 5], v[i + 6]], uv: [v[i + 3], v[i + 7]],
      colour: [source[s + 10], source[s + 11], source[s + 12]], material: source[s + 13], shade: source[s + 7],
      canopy: canopy ? canopy[sourceOf(packed)] / 255 : 1,
    }, quant));
  };
  // Clusters coarsest first: the GPU takes a prefix per tree instead of testing them all.
  const count = dag.meta.length / 4, order = Array.from({ length: count }, (_, c) => c).sort((a, b) => dag.rec[b * 16 + 13] - dag.rec[a * 16 + 13]);
  const firstVertex = vertexCount, firstCluster = clusterCount, shared = new Map();
  const out = [];
  let tiny = 0, leafClusters = 0;
  for (const c of order) {
    const at = dag.meta[c * 4], tris = dag.meta[c * 4 + 1], kind = dag.meta[c * 4 + 3];
    let first;
    if (kind === 1) {
      // Six vertices per leaf, in the order every leaf's fixed index pattern expects.
      leafClusters++;
      first = vertexCount;
      for (let leafAt = 0; leafAt < tris * 3; leafAt += 12) {
        const quad = dag.idx.subarray(at + leafAt, at + leafAt + 12);
        for (const packed of [quad[0], quad[1], quad[2], quad[5], quad[8], quad[11]]) write(packed, out);
        vertexCount += FOREST_LEAF_VERTICES;
      }
    } else {
      first = indexCount;
      for (let k = 0; k < tris * 3; k++) {
        const packed = dag.idx[at + k];
        let local = shared.get(packed);
        if (local === undefined) { local = vertexCount++; shared.set(packed, local); write(packed, out); }
        indexWords.push(local);
      }
      indexCount += tris * 3;
    }
    const r = dag.rec.subarray(c * 16, c * 16 + 16);
    clusterWords.push({ lod: [...r.subarray(0, 4)], parent: [...r.subarray(4, 8)], cull: [...r.subarray(8, 12)], err: r[12], parentErr: Math.min(r[13], 1e30), first, tris, kind });
    if (tris < 16) tiny++;
    clusterCount++;
  }
  vertexWords.push(Uint32Array.from(out));
  prototypes.push({ id: p.id, species: p.species, firstCluster, clusterCount: count, firstVertex, low, posScale, uvLow, uvScale, stats: { ...dag.stats, leafGrowth: dag.stats.leafGrowth.map((g) => +g.toFixed(3)), tinyClusters: tiny, leafClusters } });
  console.log(p.species.padEnd(12), `wood ${dag.stats.barkTris} tris, ${dag.stats.barkClusters} clusters, ${dag.stats.barkLevels} levels · leaves ${(p.leaf.indexCount / 12) | 0}, ${dag.stats.leafClusters} clusters, ${dag.stats.leafLevels} levels · ${((out.length * 4) / 1e6).toFixed(1)} MB vertices · ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

const vertexBytes = Buffer.concat(vertexWords.map((w) => Buffer.from(w.buffer, w.byteOffset, w.byteLength)));
const words = new ArrayBuffer(clusterWords.length * FOREST_CLUSTER_WORDS * 4), floats = new Float32Array(words), uints = new Uint32Array(words);
clusterWords.forEach((c, i) => {
  const at = i * FOREST_CLUSTER_WORDS;
  floats.set(c.lod, at); floats.set(c.parent, at + 4); floats.set(c.cull, at + 8);
  floats[at + 12] = c.err; floats[at + 13] = c.parentErr; uints[at + 14] = c.first; uints[at + 15] = (c.tris << 1) | c.kind;
});
const outputs = { 'vertices.bin': vertexBytes, 'indices.bin': Buffer.from(Uint32Array.from(indexWords).buffer), 'clusters.bin': Buffer.from(words) };
const outDir = path.join(dir, 'clusters');
fs.mkdirSync(outDir, { recursive: true });
const files = {};
for (const [name, bytes] of Object.entries(outputs)) {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(outDir, `${name}.gz`), gz);
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), gzip: { file: `${name}.gz`, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex') } };
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ format: 'waterworld.forest-clusters', version: 1, vertexWords: FOREST_CLUSTER_VERTEX_WORDS, clusterWords: FOREST_CLUSTER_WORDS, vertexCount, indexCount, clusterCount, files, prototypes }, null, 1));
console.log('total', (vertexBytes.length / 1e6).toFixed(0), 'MB vertices,', (outputs['indices.bin'].length / 1e6).toFixed(0), 'MB indices,', (outputs['clusters.bin'].length / 1e6).toFixed(1), 'MB clusters');
for (const [name, f] of Object.entries(files)) console.log(' ', name, (f.gzip.bytes / 1e6).toFixed(1), 'MB gz');
