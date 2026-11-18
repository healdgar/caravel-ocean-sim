#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes every boulder archetype into the boulder continuum (AGENTS.md rule 3; js/boulder-continuum.js).
//   node scripts/prepare-boulder-continuum.mjs [--out=assets/boulder-continuum]
// Each archetype is read as a shot reads it: its outer cleavage polyhedron (getBoulderCleavageTemplate), the very
// triangles the ray-sweep meets. Every one is baked by the one bake (js/continuum-bake.js): clusters, a far body that
// is the closed polyhedron itself collapsed one half-edge at a time to a few triangles, and a splat. One atlas of the
// one format (js/continuum-format.js) holds them all, gzipped beside a manifest with its receipt and each type's
// source digest. Both are kept.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { bakeContinuumBody } from '../js/continuum-bake.js';
import { CONTINUUM_HEADER, CONTINUUM_ATLAS_VERSION, assembleContinuumAtlas, continuumSourceBytes } from '../js/continuum-format.js';
import {
  BOULDER_CONTINUUM_FORMAT, BOULDER_CONTINUUM_VERSION, BOULDER_CONTINUUM_TYPES, BOULDER_CONTINUUM_MATERIAL, BOULDER_CONTINUUM_ASSETS,
  boulderContinuumSource, packBoulderContinuumBody, validateBoulderContinuumManifest,
} from '../js/boulder-continuum.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = option('out', path.dirname(BOULDER_CONTINUUM_ASSETS['manifest.json']));
const asBytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  await MeshoptSimplifier.ready;
  const started = Date.now(), baked = [];
  for (let archetype = 0; archetype < BOULDER_CONTINUUM_TYPES.length; archetype++) {
    const type = { ...boulderContinuumSource(archetype), id: archetype }, t0 = Date.now(), body = await bakeContinuumBody(type), { clusters, far } = body;
    const packed = packBoulderContinuumBody({ triangles: type.triangles, archetype }, body);
    baked.push({ type, clusters, far, packed, ms: Date.now() - t0 });
    console.log(`${archetype} ${type.name.padEnd(10)} ${String(type.triangles).padStart(4)} tris · ${String(clusters.count).padStart(2)} clusters ${clusters.levels} levels, root ${clusters.rootError.toFixed(4)} · ${far.stats.baseTriangles} → ${far.stats.coreTriangles} in ${far.stats.steps} steps, handoff at step ${far.farFirst} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const atlas = assembleContinuumAtlas(baked.map((b) => b.packed.words)), H = CONTINUUM_HEADER;
  const types = baked.map(({ type, clusters, far, packed: { low, span, centre, radius }, ms }) => ({
    id: type.id, name: type.name, fingerprint: sha256(continuumSourceBytes(type)), sourceTriangles: type.triangles,
    quantization: { low: low.map((v) => +v.toFixed(5)), span: +span.toFixed(5) }, sphere: [...centre.map((v) => +v.toFixed(4)), +radius.toFixed(4)],
    clusters: { count: clusters.count, levels: clusters.levels, roots: clusters.roots, finestTriangles: clusters.finestTriangles, rootError: +clusters.rootError.toFixed(5) },
    chain: far.stats, splat: { centre: far.splat.centre, rx: far.splat.rx, ry: far.splat.ry, area: far.splat.area ?? +(Math.PI * far.splat.rx * far.splat.ry).toFixed(6) }, bakeMs: ms,
  }));

  fs.mkdirSync(OUT, { recursive: true });
  const bytes = asBytes(atlas), gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(path.join(OUT, 'atlas.bin.gz'), gz);
  const manifest = {
    format: BOULDER_CONTINUUM_FORMAT, version: BOULDER_CONTINUUM_VERSION, generator: 'scripts/prepare-boulder-continuum.mjs',
    layout: { atlasVersion: CONTINUUM_ATLAS_VERSION, header: CONTINUUM_HEADER, material: BOULDER_CONTINUUM_MATERIAL, streams: atlas[H.streams] },
    totals: { types: baked.length, clusters: atlas[H.clusterCount], vertices: atlas[H.vertexCount], indices: atlas[H.indexCount], sourceTriangles: baked.reduce((n, b) => n + b.type.triangles, 0), farTriangles: baked.reduce((n, b) => n + b.far.index.length / 3, 0) },
    types,
    atlas: { words: atlas.length, bytes: bytes.length, sha256: sha256(bytes), gzip: { file: 'atlas.bin.gz', bytes: gz.length, sha256: sha256(gz) } },
    bakeSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  validateBoulderContinuumManifest(manifest);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${baked.length} types · ${atlas[H.clusterCount]} clusters · atlas ${(bytes.length / 1024).toFixed(1)} KiB, ${(gz.length / 1024).toFixed(1)} KiB gzipped · ${manifest.bakeSeconds} s`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
