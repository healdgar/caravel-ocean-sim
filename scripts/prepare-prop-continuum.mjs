#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every port prop and round shot into the prop continuum (AGENTS.md rule 3; js/prop-continuum.js).
//   node scripts/prepare-prop-continuum.mjs [--out=assets/prop-continuum]
// Each prop is read as its physics reads it (js/port-props.js readPropModel: its triangles cut into the shards a shot
// breaks it into), and round shot is a cast-iron sphere (roundShotSource). Both are baked by the city's own bake
// (scripts/prepare-city-continuum.mjs): clusters a shard at a time, so no simplified triangle spans two shards and a
// broken prop's every shard is a cut of its own; a far body wrapped round the whole, collapsed to a few triangles;
// and a splat. A vertex keeps its UV on its prop's pigment, which the browser decodes from the prop's own file. One
// atlas holds them all, gzipped beside a manifest with its receipt and each type's source digest. Both are kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { bakeContinuumBody } from '../js/continuum-bake.js';
import {
  CITY_CONTINUUM_HEADER, CITY_CONTINUUM_HEADER_WORDS, CITY_CONTINUUM_TYPE_WORDS, CITY_CONTINUUM_CLUSTER_WORDS, CITY_CONTINUUM_VERTEX_WORDS,
  CITY_CONTINUUM_STEP_WORDS, CITY_CONTINUUM_TRIANGLE_WORDS, CITY_CONTINUUM_NEVER, CITY_CONTINUUM_HOPS, packCityContinuumCluster, cityContinuumSourceBytes,
} from '../js/city-continuum.js';
import { PROP_MODELS, readPropModel } from '../js/port-props.js';
import {
  PROP_CONTINUUM_FORMAT, PROP_CONTINUUM_VERSION, PROP_CONTINUUM_MAGIC, PROP_CONTINUUM_TYPE, PROP_CONTINUUM_TYPES, PROP_CONTINUUM_PLAIN, PROP_CONTINUUM_SHOT_IRON,
  PROP_CONTINUUM_ASSETS, packPropContinuumVertex, packPropContinuumUV, roundShotSource, propContinuumSource, validatePropContinuumManifest,
} from '../js/prop-continuum.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = option('out', path.dirname(PROP_CONTINUUM_ASSETS['manifest.json']));
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Every type the atlas holds, in PROP_CONTINUUM_TYPES order: its source as the bake reads it, its pigment's layer, and
// for a plain one its own albedo and roughness.
export function propContinuumSources(read = (file) => fs.readFileSync(file)) {
  const sources = PROP_MODELS.map((spec, layer) => ({ type: propContinuumSource(readPropModel(new Uint8Array(read(spec.file)), spec), spec.id), layer, albedo: [0, 0, 0], roughness: 0 }));
  sources.push({ type: roundShotSource(), layer: PROP_CONTINUUM_PLAIN, albedo: [...PROP_CONTINUUM_SHOT_IRON.albedo], roughness: PROP_CONTINUUM_SHOT_IRON.roughness, sphere: true });
  sources.forEach((source, id) => { source.type.id = id; if (source.type.name !== PROP_CONTINUUM_TYPES[id]) throw Error(`Prop continuum type ${id} is ${source.type.name}`); });
  return sources;
}

async function main() {
  await MeshoptSimplifier.ready;
  const started = Date.now(), sources = propContinuumSources(), baked = [];
  for (const source of sources) {
    // The one bake every body takes (js/continuum-bake.js): the far body takes over no sooner than it is as light as
    // the clusters' coarsest cut, as a building's does.
    const { type } = source, t0 = Date.now(), { welded, clusters, far } = await bakeContinuumBody(type), rootTriangles = far.stats.rootTriangles;
    // A building stands on its floor, and its splat is what shows above it. A ball has none: its outline is its
    // great circle, all round its centre.
    if (source.sphere) Object.assign(far.splat, { centre: [0, 0, 0], rx: 1, ry: 1, roofShare: 0 });
    baked.push({ source, welded, clusters, far, ms: Date.now() - t0 });
    console.log(`${String(type.id).padStart(2)} ${type.name.padEnd(16)} ${String(type.triangles).padStart(5)} tris, ${new Set(type.parts).size} shards · ${String(clusters.count).padStart(3)} clusters ${clusters.levels} levels, root ${clusters.rootError.toFixed(4)} m · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m, handoff at step ${far.farFirst} (${far.stats.farFirstTriangles} ≤ ${rootTriangles}) · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  const totalClusters = baked.reduce((n, b) => n + b.clusters.count, 0), totalVertices = baked.reduce((n, b) => n + b.clusters.order.length, 0), totalIndices = baked.reduce((n, b) => n + b.clusters.indices.length, 0);
  const chainWords = baked.map((b) => (b.far.position.length / 3) * (CITY_CONTINUUM_VERTEX_WORDS + 1) + (b.far.index.length / 3) * CITY_CONTINUUM_TRIANGLE_WORDS + b.far.steps.length);
  const typesAt = CITY_CONTINUUM_HEADER_WORDS, clustersAt = typesAt + baked.length * CITY_CONTINUUM_TYPE_WORDS, verticesAt = clustersAt + totalClusters * CITY_CONTINUUM_CLUSTER_WORDS;
  const indicesAt = verticesAt + totalVertices * CITY_CONTINUUM_VERTEX_WORDS, chainsAt = indicesAt + totalIndices, words = chainsAt + chainWords.reduce((s, n) => s + n, 0);
  const atlas = new Uint32Array(words), floats = new Float32Array(atlas.buffer), H = CITY_CONTINUUM_HEADER;
  atlas[H.magic] = PROP_CONTINUUM_MAGIC; atlas[H.version] = PROP_CONTINUUM_VERSION;
  atlas.set([baked.length, typesAt, clustersAt, totalClusters, verticesAt, totalVertices, indicesAt, totalIndices, chainsAt, words], H.typeCount);
  let clusterAt = 0, vertexAt = 0, indexAt = 0, chainAt = chainsAt;
  const manifestTypes = [];
  for (const { source, welded, clusters, far, ms } of baked) {
    const { type } = source, low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const P of [welded.position, far.position]) for (let v = 0; v < P.length / 3; v++) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], P[v * 3 + k]); high[k] = Math.max(high[k], P[v * 3 + k]); }
    const span = Math.max(...high.map((v, k) => v - low[k])), quant = { low, span };
    // Every point it can draw, grown by the far body's largest inflation, within one sphere.
    const centre = low.map((v, k) => (v + high[k]) / 2);
    let radius = 0;
    for (const P of [welded.position, far.position]) for (let v = 0; v < P.length / 3; v++) radius = Math.max(radius, Math.hypot(P[v * 3] - centre[0], P[v * 3 + 1] - centre[1], P[v * 3 + 2] - centre[2]));
    radius += far.stats.inflateMax + 0.001;
    clusters.records.forEach((record, k) => atlas.set(packCityContinuumCluster({ ...record, first: indexAt + record.first }), clustersAt + (clusterAt + k) * CITY_CONTINUUM_CLUSTER_WORDS));
    clusters.order.forEach((v, i) => atlas.set(packPropContinuumVertex({ position: welded.position.subarray(v * 3, v * 3 + 3), normal: welded.normal.subarray(v * 3, v * 3 + 3), uv: welded.kind.subarray(v * 2, v * 2 + 2) }, quant), verticesAt + (vertexAt + i) * CITY_CONTINUUM_VERTEX_WORDS));
    clusters.indices.forEach((v, i) => { atlas[indicesAt + indexAt + i] = vertexAt + v; });
    // The far body: vertices, each vertex's collapse (the step it goes at, and where), triangles in order of death
    // with the UV of the surface nearest each, and steps.
    const V = far.position.length / 3, T = far.index.length / 3, S = far.chain.steps.length;
    if (far.stats.depth > CITY_CONTINUUM_HOPS) throw Error(`${type.name}: a far-body vertex collapses past the GPU's ${CITY_CONTINUUM_HOPS} hops`);
    const recordsAt = chainAt + V * CITY_CONTINUUM_VERTEX_WORDS, trianglesAt = recordsAt + V, stepsAt = trianglesAt + T * CITY_CONTINUUM_TRIANGLE_WORDS;
    for (let i = 0; i < V; i++) {
      atlas.set(packPropContinuumVertex({ position: far.position.subarray(i * 3, i * 3 + 3), normal: far.normal.subarray(i * 3, i * 3 + 3), uv: [0, 0] }, quant), chainAt + i * CITY_CONTINUUM_VERTEX_WORDS);
      atlas[recordsAt + i] = ((far.chain.dieStep[i] < 0 ? CITY_CONTINUUM_NEVER : far.chain.dieStep[i]) | ((far.chain.target[i] < 0 ? i : far.chain.target[i]) << 16)) >>> 0;
    }
    far.order.forEach((t, k) => {
      for (let c = 0; c < 3; c++) atlas[trianglesAt + k * CITY_CONTINUUM_TRIANGLE_WORDS + c] = far.index[t * 3 + c];
      atlas[trianglesAt + k * CITY_CONTINUUM_TRIANGLE_WORDS + 3] = packPropContinuumUV([far.kinds[t * 2], far.kinds[t * 2 + 1]]);
    });
    atlas.set(far.steps, stepsAt);
    const at = typesAt + type.id * CITY_CONTINUUM_TYPE_WORDS, F = PROP_CONTINUUM_TYPE;
    floats.set([...low, span], at + F.low);
    floats.set([...centre, radius], at + F.sphere);
    atlas.set([clusterAt, clusters.count, chainAt, S, V, recordsAt, trianglesAt, stepsAt], at + F.clusterFirst);
    floats.set([far.baseError, clusters.rootError, far.splat.rx, far.splat.ry, ...far.splat.centre], at + F.baseError);
    atlas[at + F.layer] = source.layer;
    floats.set([...source.albedo, source.roughness], at + F.albedo);
    atlas.set([T, 0, type.triangles, far.farFirst], at + F.chainTriangleCount);
    manifestTypes.push({
      id: type.id, name: type.name, fingerprint: sha256(cityContinuumSourceBytes(type)), sourceTriangles: type.triangles, parts: new Set(type.parts).size,
      layer: source.layer === PROP_CONTINUUM_PLAIN ? null : source.layer, quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
      clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(5) },
      chain: far.stats, splat: { centre: far.splat.centre, rx: far.splat.rx, ry: far.splat.ry }, bakeMs: ms,
    });
    clusterAt += clusters.count; vertexAt += clusters.order.length; indexAt += clusters.indices.length; chainAt = stepsAt + far.steps.length;
  }
  if (chainAt !== words) throw Error('The atlas layout does not add up');

  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: PROP_CONTINUUM_FORMAT, version: PROP_CONTINUUM_VERSION, generator: 'scripts/prepare-prop-continuum.mjs',
    layout: { headerWords: CITY_CONTINUUM_HEADER_WORDS, typeWords: CITY_CONTINUUM_TYPE_WORDS, clusterWords: CITY_CONTINUUM_CLUSTER_WORDS, vertexWords: CITY_CONTINUUM_VERTEX_WORDS, triangleWords: CITY_CONTINUUM_TRIANGLE_WORDS, stepWords: CITY_CONTINUUM_STEP_WORDS, header: CITY_CONTINUUM_HEADER, type: PROP_CONTINUUM_TYPE },
    totals: { types: baked.length, clusters: totalClusters, vertices: totalVertices, indices: totalIndices, sourceTriangles: baked.reduce((n, b) => n + b.source.type.triangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types: manifestTypes,
    atlas: { words, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validatePropContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${baked.length} types · ${totalClusters} clusters · atlas ${(bytes.length / 1024).toFixed(1)} KiB, ${(gz.length / 1024).toFixed(1)} KiB gzipped · ${manifest.bakeSeconds} s`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
