#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every port prop, round shot and the crews' tools into the prop continuum (AGENTS.md rule 3; js/prop-continuum.js).
//   node scripts/prepare-prop-continuum.mjs [--out=assets/prop-continuum]
// Each prop is read as its physics reads it (js/port-props.js readPropModel: its triangles cut into the shards a shot
// breaks it into), and round shot is a cast-iron sphere (roundShotSource). Every one is baked by the one bake
// (js/continuum-bake.js): clusters a shard at a time, so no simplified triangle spans two shards and a broken prop's
// every shard is a cut of its own; a far body wrapped round the whole, collapsed to a few triangles; and a splat. A
// point keeps its UV on its prop's pigment, which the browser decodes from the prop's own file. One atlas of the one
// format (js/continuum-format.js) holds them all, gzipped beside a manifest with its receipt and each type's source
// digest. Both are kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { bakeContinuumBody } from '../js/continuum-bake.js';
import { CONTINUUM_HEADER, CONTINUUM_ATLAS_VERSION, assembleContinuumAtlas, continuumSourceBytes } from '../js/continuum-format.js';
import { PROP_MODELS, readPropModel } from '../js/port-props.js';
import {
  PROP_CONTINUUM_FORMAT, PROP_CONTINUUM_VERSION, PROP_CONTINUUM_TYPES, PROP_CONTINUUM_PLAIN, PROP_CONTINUUM_SHOT_IRON, PROP_CONTINUUM_MATERIAL,
  PROP_CONTINUUM_ASSETS, PROP_CONTINUUM_TOOLS, PROP_CONTINUUM_TOOL_MATERIALS, packPropContinuumBody, roundShotSource, toolContinuumSource, propContinuumSource,
  validatePropContinuumManifest,
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
  for (const tool of PROP_CONTINUUM_TOOLS) {
    const { albedo, roughness } = PROP_CONTINUUM_TOOL_MATERIALS[tool.material];
    sources.push({ type: toolContinuumSource(tool), layer: PROP_CONTINUUM_PLAIN, albedo: [...albedo], roughness, rod: tool });
  }
  sources.forEach((source, id) => { source.type.id = id; if (source.type.name !== PROP_CONTINUUM_TYPES[id]) throw Error(`Prop continuum type ${id} is ${source.type.name}`); });
  return sources;
}

// A body's splat, where its outline is not a building's. A building stands on its floor, and its splat is what shows
// above it. A ball has none: its outline is its great circle, all round its centre. Nor has a rod: its outline side on
// is its length by its width about its middle, held at any angle, so its splat runs along it (its own up, turned as it
// is) and across it, with that outline's own area.
function propContinuumSplat(source, far) {
  if (source.sphere) return { centre: [0, 0, 0], rx: 1, ry: 1 };
  if (source.rod) return { centre: [0, source.rod.length / 2, 0], rx: source.rod.radius, ry: source.rod.length / 2, area: 2 * source.rod.radius * source.rod.length };
  return far.splat;
}

async function main() {
  await MeshoptSimplifier.ready;
  const started = Date.now(), sources = propContinuumSources(), baked = [];
  for (const source of sources) {
    // The one bake every body takes (js/continuum-bake.js): the far body takes over no sooner than it is as light as
    // the clusters' coarsest cut, as a building's does.
    const { type } = source, t0 = Date.now(), body = await bakeContinuumBody(type), { clusters, far } = body, splat = propContinuumSplat(source, far);
    const packed = packPropContinuumBody({ triangles: type.triangles, layer: source.layer, albedo: source.albedo, roughness: source.roughness, splat }, body);
    baked.push({ source, clusters, far, splat, packed, ms: Date.now() - t0 });
    console.log(`${String(type.id).padStart(2)} ${type.name.padEnd(16)} ${String(type.triangles).padStart(5)} tris, ${new Set(type.parts).size} shards · ${String(clusters.count).padStart(3)} clusters ${clusters.levels} levels, root ${clusters.rootError.toFixed(4)} m · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m, handoff at step ${far.farFirst} (${far.stats.farFirstTriangles} ≤ ${far.stats.rootTriangles}) · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const atlas = assembleContinuumAtlas(baked.map((b) => b.packed.words)), H = CONTINUUM_HEADER;
  const manifestTypes = baked.map(({ source, clusters, far, splat, packed: { low, span, centre, radius }, ms }) => ({
    id: source.type.id, name: source.type.name, fingerprint: sha256(continuumSourceBytes(source.type)), sourceTriangles: source.type.triangles, parts: new Set(source.type.parts).size,
    layer: source.layer === PROP_CONTINUUM_PLAIN ? null : source.layer, quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(5) },
    chain: far.stats, splat: { centre: splat.centre, rx: splat.rx, ry: splat.ry, area: splat.area ?? +(Math.PI * splat.rx * splat.ry).toFixed(6) }, bakeMs: ms,
  }));

  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: PROP_CONTINUUM_FORMAT, version: PROP_CONTINUUM_VERSION, generator: 'scripts/prepare-prop-continuum.mjs',
    layout: { atlasVersion: CONTINUUM_ATLAS_VERSION, header: CONTINUUM_HEADER, material: PROP_CONTINUUM_MATERIAL, streams: atlas[H.streams] },
    totals: { types: baked.length, clusters: atlas[H.clusterCount], vertices: atlas[H.vertexCount], indices: atlas[H.indexCount], sourceTriangles: baked.reduce((n, b) => n + b.source.type.triangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types: manifestTypes,
    atlas: { words: atlas.length, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validatePropContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${baked.length} types · ${atlas[H.clusterCount]} clusters · atlas ${(bytes.length / 1024).toFixed(1)} KiB, ${(gz.length / 1024).toFixed(1)} KiB gzipped · ${manifest.bakeSeconds} s`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
