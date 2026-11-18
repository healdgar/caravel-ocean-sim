#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Bakes the prefabs of every historical port, on its own ground as the game first makes it (no real elevation), and the
// castle duel's two castles, into the bodies the page ships (js/prefab-continuum.js), so those ports stand at once:
//   node scripts/prepare-prefab-continuum.mjs [--ports=lisbon,havana] [--threads=12] [--out=assets/prefab-continuum]
// With --ports, the ports already baked by the same version are kept beside those baked now. Each body is kept as it is
// baked (node_modules/.cache/prefab-continuum/<version>/), so a run cut short, or one a body failed in, is taken up
// again where it stopped; a body that fails is named, and nothing is written until every body is baked.
// Each prefab is taken as the page takes it (prefabContinuumBody), baked by the one simplifier (js/continuum-bake.js)
// in worker threads, packed as the page's bake worker packs it, and kept under its fingerprint and the bake's version
// (the digest of the page's bake worker, scripts/continuum-bake-worker-bundle.mjs). A port on real elevation, or one
// of the player's own, bakes what is not here in the page's own workers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The ground the game makes before any real elevation, on a desktop.
export const PREFAB_CONTINUUM_GROUND = Object.freeze({ size: 513, biomeSize: 512, albedoSize: 1024, vegetationCandidates: 24000, deferSynthesis: false });

if (!isMainThread) {
  const { bakeContinuumBody } = await import(pathToFileURL(path.join(root, 'js/continuum-bake.js')).href);
  const { packCityContinuumBody } = await import(pathToFileURL(path.join(root, 'js/city-continuum.js')).href);
  parentPort.on('message', async ({ body }) => {
    try {
      const started = performance.now(), words = packCityContinuumBody({ triangles: body.triangles }, await bakeContinuumBody(body)).words;
      parentPort.postMessage({ words, ms: Math.round(performance.now() - started) }, [words.buffer]);
    } catch (error) { parentPort.postMessage({ error: String(error?.stack ?? error) }); }
  });
} else {
  const args = process.argv.slice(2), option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const { PREFAB_CONTINUUM_ASSETS, PREFAB_CONTINUUM_FORMAT, prefabContinuumPlan } = await import(pathToFileURL(path.join(root, 'js/prefab-continuum.js')).href);
  const { generateProceduralCoastalPack, HISTORICAL_1550_PORTS, HISTORICAL_COLONIAL_PORTS } = await import(pathToFileURL(path.join(root, 'js/coastal-world.js')).href);
  const { bundleContinuumBakeWorker } = await import(pathToFileURL(path.join(root, 'scripts/continuum-bake-worker-bundle.mjs')).href);
  const { CASTLE_DUEL_PORT_ID, castleDuelCastles } = await import(pathToFileURL(path.join(root, 'js/castle-duel.js')).href);
  // A port as the game first stands it: a historical port on its own ground, or the duel's strait.
  const portOf = (id) => (id === CASTLE_DUEL_PORT_ID ? { regionId: id, instances: castleDuelCastles({ x: 0, z: 0 }) } : generateProceduralCoastalPack(id, PREFAB_CONTINUUM_GROUND).port);
  const OUT = path.resolve(root, option('out', path.dirname(PREFAB_CONTINUUM_ASSETS['manifest.json'])));
  const started = Date.now(), { version } = await bundleContinuumBakeWorker(root);
  const ports = option('ports', null)?.split(',') ?? [...new Set([...HISTORICAL_1550_PORTS, ...HISTORICAL_COLONIAL_PORTS].map((port) => port.id)), CASTLE_DUEL_PORT_ID];
  // Every body the ports need, once.
  const bodies = new Map();
  const prefabs = new Map();
  for (const id of ports) {
    const t0 = Date.now(), plan = await prefabContinuumPlan(portOf(id));
    prefabs.set(id, plan.instances.length);
    for (const { fingerprint, body } of plan.bodies) {
      const known = bodies.get(fingerprint);
      if (known) { if (!known.ports.includes(id)) known.ports.push(id); } else bodies.set(fingerprint, { fingerprint, body, ports: [id] });
    }
    console.log(`${id.padEnd(28)} ${String(plan.instances.length).padStart(3)} prefabs, ${String(plan.bodies.length).padStart(3)} bodies · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const wanted = [...bodies.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
  console.log(`${ports.length} ports · ${[...prefabs.values()].reduce((n, c) => n + c, 0)} prefabs · ${wanted.length} bodies, ${wanted.reduce((n, b) => n + b.body.triangles, 0)} triangles · version ${version.slice(0, 16)}`);
  // Bodies this version has baked before, then the rest in threads, each kept as it lands.
  const cache = path.join(root, 'node_modules/.cache/prefab-continuum', version);
  fs.mkdirSync(cache, { recursive: true });
  for (const entry of wanted) {
    try {
      const kept = fs.readFileSync(path.join(cache, `${entry.fingerprint}.bin`)), ms = JSON.parse(fs.readFileSync(path.join(cache, `${entry.fingerprint}.json`), 'utf8')).ms;
      Object.assign(entry, { words: new Uint32Array(kept.buffer.slice(kept.byteOffset, kept.byteOffset + kept.byteLength)), ms });
    } catch { /* not baked yet */ }
  }
  const todo = wanted.filter((entry) => !entry.words), failed = [];
  if (todo.length < wanted.length) console.log(`${wanted.length - todo.length} bodies kept from an earlier run`);
  const threads = Math.max(1, Math.min(Number(option('threads', Math.max(1, os.cpus().length - 2))), Math.max(1, todo.length)));
  const pool = Array.from({ length: Math.min(threads, todo.length) }, () => new Worker(fileURLToPath(import.meta.url)));
  let next = 0, done = 0;
  await Promise.all(pool.map((worker) => new Promise((resolve, reject) => {
    const give = () => {
      if (next >= todo.length) { worker.terminate(); resolve(); return; }
      const entry = todo[next++], { body } = entry;
      worker.once('message', (reply) => {
        if (reply.error) {
          failed.push(entry);
          console.log(`FAILED ${entry.fingerprint.slice(0, 16)} ${body.name}: ${reply.error.split('\n')[0]}`);
        } else {
          Object.assign(entry, { words: reply.words, ms: reply.ms });
          fs.writeFileSync(path.join(cache, `${entry.fingerprint}.bin`), Buffer.from(reply.words.buffer, reply.words.byteOffset, reply.words.byteLength));
          fs.writeFileSync(path.join(cache, `${entry.fingerprint}.json`), JSON.stringify({ name: body.name, ms: reply.ms }));
          console.log(`${String(++done).padStart(4)}/${todo.length} ${body.name.padEnd(30)} ${String(body.triangles).padStart(6)} tris · ${(reply.ms / 1000).toFixed(1)} s`);
        }
        give();
      });
      worker.postMessage({ body: { name: body.name, vertices: body.vertices, parts: body.parts, triangles: body.triangles } });
    };
    worker.once('error', reject);
    give();
  })));
  if (failed.length) {
    console.error(`${failed.length} of ${wanted.length} bodies failed (the rest are kept for the next run): ${failed.map((entry) => `${entry.body.name} in ${entry.ports.join(', ')}`).join('; ')}`);
    process.exit(1);
  }
  // One file a port, of every body it needs, and the receipt of them all.
  const sha256 = (b) => createHash('sha256').update(b).digest('hex'), byPrint = new Map(wanted.map((entry) => [entry.fingerprint, entry]));
  fs.mkdirSync(OUT, { recursive: true });
  // Ports baked before by this same version, and still on disk, are kept when only some are baked now.
  const before = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')); } catch { return null; } })();
  const shipped = {};
  if (option('ports', null) && before?.version === version) {
    for (const [id, entry] of Object.entries(before.ports ?? {})) if (!ports.includes(id) && fs.existsSync(path.join(OUT, entry.file))) shipped[id] = entry;
  }
  for (const id of ports) {
    const prints = [...bodies.values()].filter((entry) => entry.ports.includes(id)).map((entry) => entry.fingerprint).sort();
    if (!prints.length) continue;
    let at = 0;
    const listed = prints.map((fingerprint) => { const { body, words, ms } = byPrint.get(fingerprint); const entry = { fingerprint, name: body.name, at, words: words.length, sourceTriangles: body.triangles, bakeMs: ms }; at += words.length; return entry; });
    const all = new Uint32Array(at);
    listed.forEach((entry) => all.set(byPrint.get(entry.fingerprint).words, entry.at));
    const bytes = Buffer.from(all.buffer), gz = zlib.gzipSync(bytes, { level: 9 }), file = `${id}.bin.gz`;
    fs.writeFileSync(path.join(OUT, file), gz);
    shipped[id] = { file, prefabs: prefabs.get(id), bytes: bytes.length, sha256: sha256(bytes), gzip: { bytes: gz.length, sha256: sha256(gz) }, bodies: listed };
  }
  // The totals of every port shipped, each body counted once.
  const entries = Object.values(shipped), distinct = new Map(entries.flatMap((entry) => entry.bodies.map((body) => [body.fingerprint, body])));
  const rawBytes = entries.reduce((n, entry) => n + entry.bytes, 0), gzBytes = entries.reduce((n, entry) => n + entry.gzip.bytes, 0);
  const manifest = {
    format: PREFAB_CONTINUUM_FORMAT, generator: 'scripts/prepare-prefab-continuum.mjs', version, ground: PREFAB_CONTINUUM_GROUND,
    totals: {
      ports: entries.length, prefabs: entries.reduce((n, entry) => n + (entry.prefabs ?? 0), 0), bodies: distinct.size,
      sourceTriangles: [...distinct.values()].reduce((n, body) => n + body.sourceTriangles, 0), bytes: rawBytes, gzipBytes: gzBytes,
      bakeSeconds: +([...distinct.values()].reduce((n, body) => n + body.bakeMs, 0) / 1000).toFixed(1), threads,
    },
    ports: shipped, wallSeconds: +((Date.now() - started) / 1000).toFixed(1),
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  // Where each port's file lies, spelled out for the build (js/prefab-continuum-ports.js).
  const dir = path.relative(root, OUT).split(path.sep).join('/');
  const lines = Object.keys(shipped).sort().map((id) => `  ${JSON.stringify(id)}: '${dir}/${shipped[id].file}',`);
  if (dir === path.dirname(PREFAB_CONTINUUM_ASSETS['manifest.json'])) fs.writeFileSync(path.join(root, 'js/prefab-continuum-ports.js'), `// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.\n// Written by scripts/prepare-prefab-continuum.mjs: each historical port's baked prefab bodies (js/prefab-continuum.js).\nexport const PREFAB_CONTINUUM_PORT_BODIES = Object.freeze({\n${lines.join('\n')}\n});\n`);
  console.log(`${distinct.size} bodies in ${entries.length} ports · ${(rawBytes / 1048576).toFixed(2)} MiB, ${(gzBytes / 1048576).toFixed(2)} MiB gzipped · ${manifest.totals.bakeSeconds} s of baking in ${manifest.wallSeconds} s on ${threads} threads`);
}
