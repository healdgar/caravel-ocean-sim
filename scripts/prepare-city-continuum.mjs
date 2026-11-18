#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every Cairn building type into the city continuum (AGENTS.md rule 3; js/city-continuum.js).
//   node scripts/prepare-city-continuum.mjs [--out=assets/city-continuum]
// Each type comes from its builder (compileCityBuildingTypes), as drawn: every triangle with its kind and its part, and
// is baked by the one simplifier (js/continuum-bake.js: clusters by part, a closed far body collapsed a half-edge at a
// time, a splat), the same code the page's bake worker runs for the coasts' prefabs.
// One atlas holds them all, gzipped beside a manifest with its receipt and each type's source digest. Both are kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { buildPortPrefabGeometry } from '../js/coastal-world.js';
import { CITY_BUILDING_TYPES, CITY_TYPE_SLIGHT_FROM, compileCityBuildingTypes } from '../js/old-world-buildings.js';
import {
  CITY_CONTINUUM_FORMAT, CITY_CONTINUUM_VERSION, CITY_CONTINUUM_HEADER, CITY_CONTINUUM_HEADER_WORDS, CITY_CONTINUUM_TYPE_WORDS,
  CITY_CONTINUUM_CLUSTER_WORDS, CITY_CONTINUUM_VERTEX_WORDS, CITY_CONTINUUM_STEP_WORDS, CITY_CONTINUUM_TRIANGLE_WORDS, CITY_CONTINUUM_ASSETS,
  packCityContinuumBody, assembleCityContinuumAtlas, cityContinuumSourceBytes, validateCityContinuumManifest,
} from '../js/city-continuum.js';
import { bakeContinuumBody } from '../js/continuum-bake.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = option('out', path.dirname(CITY_CONTINUUM_ASSETS['manifest.json']));
// ------------------------------------------------------------------------------------------------ main
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const started = Date.now(), types = compileCityBuildingTypes(buildPortPrefabGeometry);
  if (types.length !== CITY_BUILDING_TYPES.length) throw Error('The catalogue and its compiled types disagree');
  const baked = [];
  for (const type of types) {
    // The one simplifier (js/continuum-bake.js), as the page's bake worker runs it.
    const t0 = Date.now(), { welded, clusters, far } = await bakeContinuumBody(type);
    const packed = packCityContinuumBody({ triangles: type.triangles, slight: type.id >= CITY_TYPE_SLIGHT_FROM }, { welded, clusters, far });
    baked.push({ type, clusters, far, packed, ms: Date.now() - t0 });
    console.log(`${String(type.id).padStart(2)} ${type.name.slice(0, 44).padEnd(44)} ${String(type.triangles).padStart(5)} tris · ${String(clusters.count).padStart(3)} clusters ${clusters.levels} levels, root ${clusters.rootError.toFixed(3)} m · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m, handoff at step ${far.farFirst} (${far.stats.farFirstTriangles} ≤ ${far.stats.rootTriangles}, ${far.stats.handoffError} m) · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const atlas = assembleCityContinuumAtlas(baked.map((b) => b.packed.words));
  const totalClusters = atlas[CITY_CONTINUUM_HEADER.clusterCount], totalVertices = atlas[CITY_CONTINUUM_HEADER.vertexCount], totalIndices = atlas[CITY_CONTINUUM_HEADER.indexCount], words = atlas.length;
  const manifestTypes = baked.map(({ type, clusters, far, packed: { low, span, centre, radius }, ms }) => ({
    id: type.id, name: type.name, fingerprint: sha256(cityContinuumSourceBytes(type)), sourceTriangles: type.triangles, parts: new Set(type.parts).size,
    quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4) },
    chain: far.stats, splat: far.splat, bakeMs: ms,
  }));

  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: CITY_CONTINUUM_FORMAT, version: CITY_CONTINUUM_VERSION, generator: 'scripts/prepare-city-continuum.mjs',
    layout: { headerWords: CITY_CONTINUUM_HEADER_WORDS, typeWords: CITY_CONTINUUM_TYPE_WORDS, clusterWords: CITY_CONTINUUM_CLUSTER_WORDS, vertexWords: CITY_CONTINUUM_VERTEX_WORDS, triangleWords: CITY_CONTINUUM_TRIANGLE_WORDS, stepWords: CITY_CONTINUUM_STEP_WORDS, header: CITY_CONTINUUM_HEADER },
    totals: { types: types.length, clusters: totalClusters, vertices: totalVertices, indices: totalIndices, sourceTriangles: types.reduce((n, t) => n + t.triangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types: manifestTypes,
    atlas: { words, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateCityContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${types.length} types · ${totalClusters} clusters · atlas ${(bytes.length / 1048576).toFixed(2)} MiB, ${(gz.length / 1048576).toFixed(2)} MiB gzipped · ${manifest.bakeSeconds} s`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
