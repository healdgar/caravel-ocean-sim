#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every Cairn building type into the city continuum (AGENTS.md rule 3; js/city-continuum.js).
//   node scripts/prepare-city-continuum.mjs [--out=assets/city-continuum] [--workers=N]
// Each type, every size of every family (js/old-world-buildings.js: a house of so many bays, a wall of so many, a
// bridge of so many bents or of such an arch), comes from its builder (compileCityBuildingType), as drawn: every
// triangle with its kind and its part, and is baked by the one simplifier (js/continuum-bake.js: clusters by part, a
// closed far body collapsed a half-edge at a time, a splat), the same code the page's bake worker runs. The types are
// baked side by side, a worker thread to a core; each type's bake is its own and the same on any.
// One atlas of the one format (js/continuum-format.js) holds them all, in the catalogue's order, gzipped beside a
// manifest with its receipt and each type's source digest. Both are kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';
import { buildCityTypeGeometry } from '../js/coastal-world.js';
import { CITY_BUILDING_TYPES, CITY_TYPE_SLIGHT_FROM, compileCityBuildingType } from '../js/old-world-buildings.js';
import { CONTINUUM_HEADER, CONTINUUM_ATLAS_VERSION, assembleContinuumAtlas, continuumSourceBytes } from '../js/continuum-format.js';
import {
  CITY_CONTINUUM_FORMAT, CITY_CONTINUUM_VERSION, CITY_CONTINUUM_MATERIAL, CITY_CONTINUUM_ASSETS, packCityContinuumBody, validateCityContinuumManifest,
} from '../js/city-continuum.js';
import { bakeContinuumBody } from '../js/continuum-bake.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = option('out', path.dirname(CITY_CONTINUUM_ASSETS['manifest.json']));
const WORKERS = Math.max(1, Math.min(CITY_BUILDING_TYPES.length, Number(option('workers', Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1)))));
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ------------------------------------------------------------------------------------------------ one type
// Type `id` built, baked and packed, with what its manifest entry and its line tell of it.
async function bakeType(id) {
  const t0 = Date.now(), type = compileCityBuildingType(id, buildCityTypeGeometry);
  // The one simplifier (js/continuum-bake.js), as the page's bake worker runs it.
  const body = await bakeContinuumBody(type), { clusters, far } = body;
  const { words, low, span, centre, radius } = packCityContinuumBody({ triangles: type.triangles, slight: id >= CITY_TYPE_SLIGHT_FROM }, body);
  const ms = Date.now() - t0;
  const entry = {
    id, name: type.name, fingerprint: sha256(continuumSourceBytes(type)), sourceTriangles: type.triangles, parts: new Set(type.parts).size,
    quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(4) },
    chain: far.stats, splat: far.splat, bakeMs: ms,
  };
  const line = `${String(id).padStart(3)} ${type.name.slice(0, 44).padEnd(44)} ${String(type.triangles).padStart(5)} tris · ${String(clusters.count).padStart(3)} clusters ${clusters.levels} levels, root ${clusters.rootError.toFixed(3)} m · wrap ${far.stats.cell} m, ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps (depth ${far.stats.depth}), ${far.stats.errorRange.join('–')} m, handoff at step ${far.farFirst} (${far.stats.farFirstTriangles} ≤ ${far.stats.rootTriangles}, ${far.stats.handoffError} m) · ${(ms / 1000).toFixed(1)} s`;
  return { id, words, entry, farTriangles: far.index.length / 3, line };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const started = Date.now(), count = CITY_BUILDING_TYPES.length, baked = new Array(count);
  let next = 0, done = 0;
  await new Promise((resolve, reject) => {
    const script = fileURLToPath(import.meta.url);
    for (let w = 0; w < WORKERS; w++) {
      const worker = new Worker(script, { argv: args });
      const give = () => { if (next < count) worker.postMessage(next++); else worker.postMessage(-1); };
      worker.on('message', (result) => {
        baked[result.id] = result;
        console.log(result.line);
        if (++done === count) resolve();
        give();
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0 && done < count) reject(Error(`A bake worker stopped (${code})`)); });
      give();
    }
  });
  const atlas = assembleContinuumAtlas(baked.map((b) => b.words)), H = CONTINUUM_HEADER;
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: CITY_CONTINUUM_FORMAT, version: CITY_CONTINUUM_VERSION, generator: 'scripts/prepare-city-continuum.mjs',
    layout: { atlasVersion: CONTINUUM_ATLAS_VERSION, header: CONTINUUM_HEADER, material: CITY_CONTINUUM_MATERIAL, streams: atlas[H.streams] },
    totals: { types: count, clusters: atlas[H.clusterCount], vertices: atlas[H.vertexCount], indices: atlas[H.indexCount], sourceTriangles: baked.reduce((n, b) => n + b.entry.sourceTriangles, 0), farTriangles: baked.reduce((n, b) => n + b.farTriangles, 0) },
    types: baked.map((b) => b.entry),
    atlas: { words: atlas.length, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateCityContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${count} types · ${atlas[H.clusterCount]} clusters · atlas ${(bytes.length / 1048576).toFixed(2)} MiB, ${(gz.length / 1048576).toFixed(2)} MiB gzipped · ${manifest.bakeSeconds} s on ${WORKERS} workers`);
}

if (!isMainThread) {
  // A bake worker: types by id until told -1.
  parentPort.on('message', async (id) => {
    if (id < 0) { parentPort.close(); return; }
    const result = await bakeType(id);
    parentPort.postMessage(result, [result.words.buffer]);
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
