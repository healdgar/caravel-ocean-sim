#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every tree of a forest pack into the one continuum (AGENTS.md rule 3; js/forest-continuum.js), in place of the
// forest's own cluster and crown bakes: the one simplifier (js/continuum-bake.js) clusters each prototype's wood by
// projected error and its leaf cards beside it, wraps the whole tree, crown and trunk, in one closed far body that
// collapses a half-edge at a time to a few triangles, and gives it one splat. One atlas of the one format holds a
// pack's prototypes, in their order, gzipped beside a manifest with its receipt and each prototype's source digest.
//   node scripts/prepare-forest-continuum.mjs portugal|saba|subtropical [--only=oak] [--check]
// --check reads the baked atlas back and checks it against its manifest and the pack, baking nothing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { CONTINUUM_HEADER, CONTINUUM_ATLAS_VERSION, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, assembleContinuumAtlas, checkContinuumAtlas, continuumAtlasTypes } from '../js/continuum-format.js';
import { weldDrawn, bakeClusters, bakeFar, continuumFarFirst } from '../js/continuum-bake.js';
import {
  FOREST_CONTINUUM_FORMAT, FOREST_CONTINUUM_VERSION, FOREST_CONTINUUM_MATERIAL, FOREST_CONTINUUM_BARK, FOREST_CONTINUUM_LEAF,
  FOREST_CONTINUUM_ASSETS, SUBTROPICAL_FOREST_CONTINUUM_ASSETS, PORTUGAL_FOREST_CONTINUUM_ASSETS, packForestContinuumBody, validateForestContinuumManifest,
} from '../js/forest-continuum.js';

const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith('--')) ?? 'portugal';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const checkOnly = args.includes('--check');
const ASSETS = { saba: FOREST_CONTINUUM_ASSETS, subtropical: SUBTROPICAL_FOREST_CONTINUUM_ASSETS, portugal: PORTUGAL_FOREST_CONTINUUM_ASSETS }[packName];
if (!ASSETS) throw Error(`No forest pack ${packName}`);
const dir = path.join('assets/forest-scenery', packName), OUT = path.dirname(ASSETS['manifest.json']);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
// A pack's source vertex: position, normal, a spare float, its exposure, its UV, its colour and its layer.
const SOURCE_STRIDE = 14;
const MASK_SIZE = 64;
// A coarser leaf level's error as a share of its size (third_party/threejs-nanites/dag/leaves.ts): the cluster bake's.
const LEAF_ERROR_SHARE = 0.35;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(path.join(dir, file)));
const asFloats = (buffer) => new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
const asWords = (buffer) => new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

// A leaf texture's alpha as a coarse mask, so coarser levels cover what the finer ones did.
function leafMask(file) {
  const out = path.join(os.tmpdir(), `forest-continuum-mask-${process.pid}.bin`);
  execFileSync('python3', ['-I', '-c', `import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGBA').split()[3].resize((${MASK_SIZE},${MASK_SIZE}));open(sys.argv[2],'wb').write(bytes(1 if v>127 else 0 for v in im.tobytes()))`, path.join(dir, file), out]);
  const bits = new Uint8Array(fs.readFileSync(out));
  fs.rmSync(out);
  return { size: MASK_SIZE, bits };
}

// A tree's foot flares into the ground it stands on, as the land's own roots do: the wood near the ground is drawn
// outward and down (what the forest's vertex stage did for every frame, here once).
function flareRoot([x, y, z]) {
  const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const r = Math.hypot(x, z), envelope = 0.32 + 0.14 * Math.min(r, 4) - 0.46 * smooth(1.15, 2.6, r);
  if (!(y < envelope + 0.04 && (r > 0.18 || y < 0.02))) return [x, y, z];
  const w = (1 - smooth(envelope - 0.08, envelope + 0.04, y)) * Math.max(smooth(0.18, 0.22, r), 1 - smooth(-0.01, 0.02, y));
  let px = x, pz = z;
  if (r > 0.2) { const out = 0.2 + 0.52 * (1 - Math.exp(-(r - 0.2) / 0.52)), k = 1 + (out / Math.max(r, 1e-5) - 1) * w; px *= k; pz *= k; }
  const dr = Math.max(0, r - 0.18), py = Math.max(-2.2, y - (1.35 * dr + 0.45 * Math.min(dr * dr, 4)));
  return [px, y + (py - y) * w, pz];
}

function main(source, indices, canopy) {
  const read = (v, offset, count) => source.subarray(v * SOURCE_STRIDE + offset, v * SOURCE_STRIDE + offset + count);
  // Leaves are two quads sharing an edge; a pack whose leaves are single quads has each cut across its middle into
  // the same two (the bake of the forest's clusters did likewise).
  function leafSource(p) {
    const first = p.leaf.firstIndex;
    if (p.leaf.indexCount >= 6 && indices[first + 3] === indices[first + 2] && indices[first + 4] === indices[first + 1]) {
      const leaves = p.leaf.indexCount / 6, map = new Uint32Array(leaves * 8);
      const pos = new Float32Array(map.length * 3), nrm = new Float32Array(map.length * 3), uv = new Float32Array(map.length * 2);
      const mean = (u, v, offset, count) => Array.from({ length: count }, (_, k) => (read(u, offset, count)[k] + read(v, offset, count)[k]) / 2);
      for (let leaf = 0; leaf < leaves; leaf++) {
        const at = p.leaf.firstIndex + leaf * 6, a = indices[at], b = indices[at + 1], c = indices[at + 2], d = indices[at + 5];
        if (indices[at + 3] !== c || indices[at + 4] !== b) throw Error(`${p.species}: leaf ${leaf} is not a single quad`);
        [[a, a], [b, b], [b, d], [a, c], [a, c], [b, d], [d, d], [c, c]].forEach(([u, v], k) => {
          const out = leaf * 8 + k;
          map[out] = u;
          pos.set(mean(u, v, 0, 3), out * 3);
          const n = mean(u, v, 3, 3), length = Math.hypot(...n) || 1;
          nrm.set(n.map((value) => value / length), out * 3);
          uv.set(mean(u, v, 8, 2), out * 2);
        });
      }
      return { map, leaves: { pos, nrm, uv, vpl: 8 } };
    }
    const leaves = p.leaf.indexCount / 12, map = new Uint32Array(leaves * 8);
    for (let leaf = 0; leaf < leaves; leaf++) {
      const at = p.leaf.firstIndex + leaf * 12, i = (k) => indices[at + k];
      map.set([i(0), i(1), i(2), i(5), i(6), i(7), i(8), i(11)], leaf * 8);
    }
    const pos = new Float32Array(map.length * 3), nrm = new Float32Array(map.length * 3), uv = new Float32Array(map.length * 2);
    map.forEach((v, k) => { pos.set(read(v, 0, 3), k * 3); nrm.set(read(v, 3, 3), k * 3); uv.set(read(v, 8, 2), k * 2); });
    return { map, leaves: { pos, nrm, uv, vpl: 8 } };
  }
  // A source vertex's surface, for the packer.
  const surfaceOf = (v, leaf) => ({
    material: Math.round(source[v * SOURCE_STRIDE + 13]), leaf, colour: Array.from(read(v, 10, 3)), exposure: source[v * SOURCE_STRIDE + 7], canopy: canopy ? canopy[v] / 255 : 1,
  });
  // How far a point of the tree moves at full gust strength (its type's metres), as the forest's own sway had it:
  // the whole bends by its height squared, a bough bobs by its reach from the trunk, a leaf flutters; the wood stays
  // fixed at its foot.
  const swayOf = ([x, y, z], leaf) => {
    const t = Math.max(0, Math.min(1, (y - 0.22) / (1.05 - 0.22))), collar = leaf ? 1 : t * t * (3 - 2 * t);
    return (0.0016 * y * y + 0.045 * Math.hypot(x, z) + (leaf ? 0.03 : 0)) * collar;
  };

  return async function bakePrototype(p, firstLayer) {
    const t0 = Date.now();
    const foliage = p.nativeMaterials.find((m) => m.name.startsWith('foliage') || m.name.startsWith('leaf'));
    const leaf = leafSource(p);
    // The wood, each corner with its source vertex in its kind, so corners weld only where the pack's mesh shares a
    // vertex; its foot flared into the ground.
    const woodIndex = indices.subarray(p.wood.firstIndex, p.wood.firstIndex + p.wood.indexCount), woodTriangles = woodIndex.length / 3;
    const leafTriangles = (leaf.map.length / 8) * 4, corners = new Float32Array((woodTriangles + leafTriangles) * 3 * 8);
    woodIndex.forEach((v, k) => corners.set([...flareRoot(read(v, 0, 3)), ...read(v, 3, 3), FOREST_CONTINUUM_BARK, v], k * 8));
    // The leaf cards, as triangles, for the far body's wrap.
    for (let card = 0, at = woodIndex.length; card < leaf.map.length / 8; card++) {
      for (const k of [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]) {
        const c = card * 8 + k;
        corners.set([...leaf.leaves.pos.subarray(c * 3, c * 3 + 3), ...leaf.leaves.nrm.subarray(c * 3, c * 3 + 3), FOREST_CONTINUUM_LEAF, leaf.map[c]], at * 8);
        at++;
      }
    }
    const name = `${p.species}${p.cohort ? `-${p.cohort}` : ''}`;
    const wood = { name, vertices: corners.subarray(0, woodTriangles * 24), triangles: woodTriangles, parts: new Uint32Array(woodTriangles) };
    const whole = { name, vertices: corners, triangles: woodTriangles + leafTriangles, parts: new Uint32Array(woodTriangles + leafTriangles) };
    const welded = weldDrawn(wood), woodUV = new Float32Array(welded.count * 2);
    for (let v = 0; v < welded.count; v++) woodUV.set(read(welded.kind[v * 2 + 1], 8, 2), v * 2);
    const clusters = await bakeClusters(welded, {
      uv: woodUV, leaves: { ...leaf.leaves, mask: foliage ? leafMask(foliage.albedo.file) : null, error: LEAF_ERROR_SHARE, part: 0 },
    });
    const far = bakeFar(whole, weldDrawn(whole));
    continuumFarFirst(clusters, far);

    // The packed vertices: the wood's welded ones, then the leaves' (js/continuum-bake.js bakeClusters).
    const L = clusters.leafVertices, W = welded.count, all = W + L.source.length;
    const position = new Float32Array(all * 3), normal = new Float32Array(all * 3);
    position.set(welded.position); position.set(L.position, W * 3); normal.set(welded.normal); normal.set(L.normal, W * 3);
    const isLeaf = (v) => v >= W, sourceOf = (v) => (isLeaf(v) ? leaf.map[L.source[v - W]] : welded.kind[v * 2 + 1]);
    const uvOf = (v) => (isLeaf(v) ? [L.uv[(v - W) * 2], L.uv[(v - W) * 2 + 1]] : [woodUV[v * 2], woodUV[v * 2 + 1]]);
    const uvLow = [Infinity, Infinity], uvHigh = [-Infinity, -Infinity];
    let sway = 1e-4;
    for (const v of clusters.order) {
      const uv = uvOf(v);
      for (let k = 0; k < 2; k++) { uvLow[k] = Math.min(uvLow[k], uv[k]); uvHigh[k] = Math.max(uvHigh[k], uv[k]); }
      sway = Math.max(sway, swayOf(position.subarray(v * 3, v * 3 + 3), isLeaf(v)));
    }
    const phaseOf = (v) => {
      if (isLeaf(v)) { const card = Math.floor(L.source[v - W] / 8); return ((card * 0.6180339887) % 1 + 1) % 1; }
      const P = position.subarray(v * 3, v * 3 + 3);
      return ((Math.atan2(P[2], P[0]) / (2 * Math.PI) + P[1] * 0.05) % 1 + 1) % 1;
    };
    // The splat wears the leaves' mean, of their commonest layer.
    const layers = new Map(), mean = [0, 0, 0, 0, 0];
    for (const v of leaf.map) {
      const s = surfaceOf(v, true);
      layers.set(s.material, (layers.get(s.material) ?? 0) + 1);
      mean[0] += s.colour[0]; mean[1] += s.colour[1]; mean[2] += s.colour[2]; mean[3] += s.exposure; mean[4] += s.canopy;
    }
    const n = Math.max(1, leaf.map.length), commonest = [...layers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const look = { material: commonest, leaf: leaf.map.length > 0, colour: mean.slice(0, 3).map((c) => c / n), exposure: mean[3] / n, canopy: mean[4] / n };
    const packed = packForestContinuumBody({
      triangles: woodTriangles + leafTriangles, surface: (v) => surfaceOf(sourceOf(v), isLeaf(v)), uv: uvOf,
      wind: (v) => [swayOf(position.subarray(v * 3, v * 3 + 3), isLeaf(v)) / sway, phaseOf(v)],
      farSurface: (t) => surfaceOf(far.kinds[t * 2 + 1], far.kinds[t * 2] === FOREST_CONTINUUM_LEAF),
      look, uvRange: [uvLow[0], uvLow[1], Math.max(uvHigh[0] - uvLow[0], 1e-3), Math.max(uvHigh[1] - uvLow[1], 1e-3)], sway, firstLayer,
    }, { welded: { position, normal }, clusters, far });
    const ms = Date.now() - t0;
    console.log(`${String(p.id).padStart(2)} ${name.padEnd(20)} wood ${woodTriangles} · leaves ${leafTriangles} tris · ${clusters.count} clusters, ${clusters.levels} levels, root ${clusters.rootError.toFixed(3)} m · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m, handoff at step ${far.farFirst} (${far.stats.farFirstTriangles} ≤ ${far.stats.rootTriangles}, ${far.stats.handoffError} m) · sway ${sway.toFixed(3)} m · ${(ms / 1000).toFixed(1)} s`);
    const fingerprint = sha256(Buffer.concat([asBytes(corners), Buffer.from(JSON.stringify([p.nativeMaterials, firstLayer]))]));
    return { p, name, clusters, far, packed, ms, fingerprint, sourceTriangles: woodTriangles + leafTriangles, sway };
  };
}

// The baked atlas read back and checked against its manifest and the pack: every prototype a type, in order, each
// with its clusters and its far body, and the atlas the cut reads.
function check() {
  const baked = JSON.parse(fs.readFileSync(ASSETS['manifest.json'], 'utf8'));
  validateForestContinuumManifest(baked);
  const bytes = zlib.gunzipSync(fs.readFileSync(ASSETS['atlas.bin.gz']));
  if (bytes.length !== baked.atlas.bytes || sha256(bytes) !== baked.atlas.sha256) throw Error(`${packName}: the forest atlas does not match its receipt`);
  const words = checkContinuumAtlas(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), 'forest');
  if (words[CONTINUUM_HEADER.typeCount] !== manifest.prototypes.length || baked.types.length !== manifest.prototypes.length) throw Error(`${packName}: the atlas holds ${baked.types.length} types for ${manifest.prototypes.length} prototypes`);
  baked.types.forEach((type, id) => {
    const p = manifest.prototypes[id], at = words[CONTINUUM_HEADER.typesAt] + id * CONTINUUM_TYPE_WORDS;
    if (type.name !== `${p.species}${p.cohort ? `-${p.cohort}` : ''}`) throw Error(`${packName}: type ${id} is ${type.name}, not prototype ${p.species}`);
    const floats = new Float32Array(words.buffer, words.byteOffset + at * 4, CONTINUUM_TYPE_WORDS);
    if (!(floats[FOREST_CONTINUUM_MATERIAL.sway - 0] > 0) || !(floats[CONTINUUM_TYPE.sphere + 3] > 0)) throw Error(`${packName}: type ${id} has no sway or no bound`);
  });
  const types = continuumAtlasTypes(words);
  console.log(`${packName}: ${types.length} types, ${words[CONTINUUM_HEADER.clusterCount]} clusters, ${words[CONTINUUM_HEADER.vertexCount]} vertices, far bodies of ${types.map((t) => t.farChunks).join('/')} chunks · checked`);
}

if (checkOnly) check();
else {
  const started = Date.now();
  await MeshoptSimplifier.ready;
  const source = asFloats(gunzip('vertices.bin.gz')), indices = asWords(gunzip('indices.bin.gz'));
  const canopyFile = path.join(dir, 'canopy-shade.bin.gz'), canopy = fs.existsSync(canopyFile) ? zlib.gunzipSync(fs.readFileSync(canopyFile)) : null;
  if (source.length / SOURCE_STRIDE >= 1 << 24) throw Error('A pack this large cannot name its source vertices in a float');
  const bakePrototype = main(source, indices, canopy), baked = [];
  let firstLayer = 0;
  for (const p of manifest.prototypes) {
    if (!only || p.species === only) baked.push(await bakePrototype(p, firstLayer));
    firstLayer += p.nativeMaterials.length;
  }
  if (only) { console.log(`--only bakes nothing to disk: ${((Date.now() - started) / 1000).toFixed(1)} s`); process.exit(0); }
  const atlas = assembleContinuumAtlas(baked.map((b) => b.packed.words)), H = CONTINUUM_HEADER;
  const types = baked.map(({ p, name, clusters, far, packed: { low, span, centre, radius }, ms, fingerprint, sourceTriangles, sway }) => ({
    id: p.id, name, fingerprint, sourceTriangles, sway: +sway.toFixed(4),
    quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4), leafClusters: clusters.stats.leafClusters, leafLevels: clusters.stats.leafLevels },
    chain: far.stats, splat: far.splat, bakeMs: ms,
  }));
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(ASSETS['atlas.bin.gz'], gz);
  const out = {
    format: FOREST_CONTINUUM_FORMAT, version: FOREST_CONTINUUM_VERSION, generator: 'scripts/prepare-forest-continuum.mjs', pack: packName,
    layout: { atlasVersion: CONTINUUM_ATLAS_VERSION, header: CONTINUUM_HEADER, material: FOREST_CONTINUUM_MATERIAL, streams: atlas[H.streams] },
    totals: { types: types.length, clusters: atlas[H.clusterCount], vertices: atlas[H.vertexCount], indices: atlas[H.indexCount], sourceTriangles: types.reduce((n, t) => n + t.sourceTriangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types,
    atlas: { words: atlas.length, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateForestContinuumManifest(out);
  fs.writeFileSync(ASSETS['manifest.json'], `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${packName}: ${types.length} types · ${atlas[H.clusterCount]} clusters · atlas ${(bytes.length / 1048576).toFixed(1)} MiB, ${(gz.length / 1048576).toFixed(1)} MiB gzipped · ${out.bakeSeconds} s`);
  check();
}
