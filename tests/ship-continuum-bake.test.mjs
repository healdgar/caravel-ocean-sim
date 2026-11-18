// The ships' continuum bake (scripts/prepare-ship-continuum.mjs): its files, its freshness against the ships as they
// are built now, and each guarantee the GPU cut leans on, checked on every body. A body baked from another assembly
// than the one js/trade-vessels.js or js/ship-mesh.js builds fails here (rebake with
// `node scripts/prepare-ship-continuum.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  SHIP_CONTINUUM_ASSETS, SHIP_CONTINUUM_BODIES, SHIP_CONTINUUM_CLUSTER_WORDS, SHIP_CONTINUUM_FAR_VERTEX_WORDS, SHIP_CONTINUUM_MAX_DEPTH,
  SHIP_CONTINUUM_NEVER, SHIP_CONTINUUM_STEP_WORDS, shipContinuumStreams, shipContinuumSourceKey, shipContinuumSurface,
  shipContinuumSurfaceMatches, validateShipContinuumManifest,
} from '../js/ship-continuum.js';
import { TRADE_VESSEL_ARCHETYPES, getTradeVesselArchetype } from '../js/trade-vessels.js';
import { SHIP_MODELS } from '../js/ship-models.js';
import { createShipAssetCache } from '../js/ship-mesh.js';

const at = (file) => new URL(`../${file}`, import.meta.url);
const manifestOf = (id) => JSON.parse(fs.readFileSync(at(SHIP_CONTINUUM_ASSETS[id]['manifest.json']), 'utf8'));
// A stream, checked against both its receipts.
function stream(id, name, manifest) {
  const gz = fs.readFileSync(at(SHIP_CONTINUUM_ASSETS[id][`${name}.gz`])), receipt = manifest.files[name];
  assert.equal(createHash('sha256').update(gz).digest('hex'), receipt.gzip.sha256, `${id} ${name}.gz receipt`);
  const bytes = zlib.gunzipSync(gz);
  assert.equal(bytes.length, receipt.bytes, `${id} ${name} size`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256, `${id} ${name} receipt`);
  return bytes;
}
const words = (bytes) => new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
const floats = (bytes) => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
// The assembly a body is baked from, as it is built now: a trade vessel's archetype, or a ship the player sails as
// js/ship-mesh.js builds her (vertices of 9 floats, her index buffer, part groups and fracture).
const shipAssets = createShipAssetCache();
function assemblyOf({ family, archetype, model }) {
  if (family === 'trade') return getTradeVesselArchetype(archetype);
  const asset = shipAssets.get(model);
  return { vertices: asset.vertices, indices: asset.indices, groups: asset.groups, fracture: asset.fracture, vertexCount: asset.vertices.length / 9 };
}

test('every trade vessel archetype and every ship the player sails is one body, and every file of it is spelled out where the build publishes it', () => {
  const of = (family) => SHIP_CONTINUUM_BODIES.filter((b) => b.family === family);
  assert.deepEqual(of('trade').map((b) => b.archetype), Array.from({ length: TRADE_VESSEL_ARCHETYPES }, (_, a) => a));
  assert.deepEqual(of('player').map((b) => b.model).sort(), Object.keys(SHIP_MODELS).sort(), 'every ship model is a body');
  for (const { id, family, model } of SHIP_CONTINUUM_BODIES) assert.equal(id, family === 'trade' ? id : `player-${model}`);
  assert.equal(of('trade').length + of('player').length, SHIP_CONTINUUM_BODIES.length, 'every body is of a family');
  assert.deepEqual(Object.keys(SHIP_CONTINUUM_ASSETS), SHIP_CONTINUUM_BODIES.map(({ id }) => id));
  for (const { id, family } of SHIP_CONTINUUM_BODIES) {
    const files = ['manifest.json', ...shipContinuumStreams(family).map((name) => `${name}.gz`)];
    assert.deepEqual(SHIP_CONTINUUM_ASSETS[id], Object.fromEntries(files.map((file) => [file, `assets/ships/continuum/${id}/${file}`])));
    for (const file of Object.values(SHIP_CONTINUUM_ASSETS[id])) assert.ok(fs.existsSync(at(file)), `${file} is baked`);
  }
  // build.mjs publishes only quoted asset paths; a composed path would go unpublished.
  const source = fs.readFileSync(at('js/ship-continuum.js'), 'utf8');
  for (const paths of Object.values(SHIP_CONTINUUM_ASSETS)) for (const file of Object.values(paths)) assert.ok(source.includes(`'${file}'`), file);
  assert.match(fs.readFileSync(at('build.mjs'), 'utf8'), /SHIP_CONTINUUM_ASSETS/, 'build.mjs embeds the bodies');
});

for (const entry of SHIP_CONTINUUM_BODIES) {
  const { id, family } = entry;
  test(`${id} is baked from the ship as it is built now, its finest cut the whole assembly, part by part`, () => {
    const manifest = manifestOf(id), arch = assemblyOf(entry);
    validateShipContinuumManifest(manifest);
    assert.equal(manifest.family, family);
    // Fresh: the same triangles, part groups and fracture shards, the same surface, and (here, where the bake runs) the
    // very vertices a trade vessel draws, or the very corners a player's ship is renumbered by where she is drawn.
    assert.equal(manifest.source.key, createHash('sha256').update(shipContinuumSourceKey(arch)).digest('hex'), `${id} part and shard table`);
    assert.ok(shipContinuumSurfaceMatches(manifest.source.surface, shipContinuumSurface(arch.vertices, arch.indices)), `${id} surface`);
    assert.equal(manifest.source.vertices, arch.vertexCount);
    assert.equal(manifest.source.shards, arch.fracture.shardCount);
    let shards = arch.fracture.vertexShards;
    if (family === 'trade') {
      const vertices = stream(id, 'vertices.bin', manifest);
      shards = words(stream(id, 'shards.bin', manifest));
      assert.ok(Buffer.from(arch.vertices.buffer, arch.vertices.byteOffset, arch.vertices.byteLength).equals(vertices), `${id} vertices are the assembly's`);
      assert.deepEqual(Array.from(shards), Array.from(arch.fracture.vertexShards), `${id} each vertex flies with its shard`);
    } else {
      assert.deepEqual(Array.from(words(stream(id, 'corners.bin', manifest))), Array.from(arch.indices), `${id} corners are the assembly's`);
    }

    const V = arch.vertexCount, copies = words(stream(id, 'copies.bin', manifest)), indices = words(stream(id, 'indices.bin', manifest));
    const clusterBytes = stream(id, 'clusters.bin', manifest), cu = words(clusterBytes), cf = floats(clusterBytes);
    assert.equal(copies.length, manifest.copyCount);
    for (const c of copies) assert.ok(c < V, `${id} a seam copy names a ship vertex`);
    const sourceOf = (i) => (i < V ? i : copies[i - V]);
    const finest = [];
    let roots = 0, lastParent = Infinity;
    for (let c = 0; c < manifest.clusterCount; c++) {
      const o = c * SHIP_CONTINUUM_CLUSTER_WORDS, error = cf[o + 12], parentError = cf[o + 13], first = cu[o + 14];
      const triangles = cu[o + 15] & 255, level = cu[o + 15] >>> 8;
      assert.ok(triangles > 0 && first + triangles * 3 <= indices.length, `${id} cluster ${c} lies in the index stream`);
      assert.ok(error <= parentError, `${id} cluster ${c} is finer than its parent`);
      assert.ok(parentError <= lastParent, `${id} clusters are ordered coarsest parent first`);
      lastParent = parentError;
      if (parentError >= 1e30) roots++;
      for (const k of [3, 7, 11]) assert.ok(cf[o + k] > 0, `${id} cluster ${c} spheres hold its points`);
      // Simplification never crosses a part or shard boundary: a cluster is of one shard.
      const shard = shards[sourceOf(indices[first])];
      for (let i = first; i < first + triangles * 3; i++) {
        assert.ok(indices[i] < V + copies.length, `${id} cluster ${c} names a vertex there is`);
        if (shards[sourceOf(indices[i])] !== shard) assert.fail(`${id} cluster ${c} crosses shards ${shard} and ${shards[sourceOf(indices[i])]}`);
      }
      if (level === 0) for (let i = first; i < first + triangles * 3; i += 3) finest.push([sourceOf(indices[i]), sourceOf(indices[i + 1]), sourceOf(indices[i + 2])]);
    }
    assert.equal(roots, manifest.clusters.roots, `${id} roots`);
    // The finest cut is the physical truth: level 0 is every triangle the assembly draws, once.
    const key = (t) => { const s = t.slice().sort((a, b) => a - b); return `${s[0]},${s[1]},${s[2]}`; };
    const drawn = [];
    for (let t = 0; t < arch.indices.length; t += 3) {
      const tri = [arch.indices[t], arch.indices[t + 1], arch.indices[t + 2]];
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) drawn.push(key(tri));
    }
    assert.deepEqual(finest.map(key).sort(), drawn.sort(), `${id} finest cut is the assembly`);
  });

  test(`${id} far body collapses in error order to its core, every vertex riding a ship vertex`, () => {
    const manifest = manifestOf(id), { far, splat } = manifest, bytes = stream(id, 'far.bin', manifest), u = words(bytes), f = floats(bytes);
    const { vertexCount: V, triangleCount: T, stepCount: S, offsets } = far;
    for (let v = 0; v < V; v++) {
      const o = v * SHIP_CONTINUUM_FAR_VERTEX_WORDS;
      for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(f[o + k]), `${id} far vertex ${v} position`);
      assert.ok(u[o + 5] < manifest.source.vertices, `${id} far vertex ${v} rides a ship vertex`);
    }
    // Each vertex goes past its step (gone at every later one) into a vertex that outlives it, and every chain ends inside the GPU's walk.
    const dieStep = (v) => u[offsets.records + v] & 0xffff, target = (v) => u[offsets.records + v] >>> 16;
    let deepest = 0;
    for (let v = 0; v < V; v++) {
      if (dieStep(v) === SHIP_CONTINUUM_NEVER) continue;
      assert.ok(dieStep(v) < S, `${id} far vertex ${v} goes between two steps`);
      let w = v, hops = 0;
      while (dieStep(w) !== SHIP_CONTINUUM_NEVER && hops <= SHIP_CONTINUUM_MAX_DEPTH) {
        const next = target(w);
        assert.ok(next < V && next !== w && (dieStep(next) === SHIP_CONTINUUM_NEVER || dieStep(next) > dieStep(w)), `${id} far vertex ${w} collapses into a survivor`);
        w = next; hops++;
      }
      deepest = Math.max(deepest, hops);
    }
    assert.ok(deepest <= SHIP_CONTINUUM_MAX_DEPTH, `${id} chains are at most ${SHIP_CONTINUUM_MAX_DEPTH} deep (${deepest})`);
    for (let i = offsets.triangles; i < offsets.steps; i++) assert.ok(u[i] < V, `${id} far triangle corner names a vertex`);
    // Steps: triangles alive fall, error rises, from the base to the core.
    const step = (s) => ({ alive: u[offsets.steps + s * SHIP_CONTINUUM_STEP_WORDS], error: f[offsets.steps + s * SHIP_CONTINUUM_STEP_WORDS + 1], inflate: f[offsets.steps + s * SHIP_CONTINUUM_STEP_WORDS + 2] });
    assert.equal(step(0).alive, T);
    assert.equal(step(S).alive, far.coreTriangles);
    assert.ok(far.coreTriangles >= 4, `${id} core is closed (${far.coreTriangles})`);
    for (let s = 1; s <= S; s++) {
      const a = step(s - 1), b = step(s);
      assert.ok(b.alive <= a.alive && b.error >= a.error && Number.isFinite(b.inflate) && b.inflate >= 0, `${id} step ${s} coarsens`);
    }
    assert.ok(step(S).error > step(0).error);
    assert.ok(splat.ry > 0 && splat.rxSide > 0 && splat.rxEnd > 0 && splat.colour.every((c) => Number.isFinite(c) && c >= 0), `${id} splat`);
  });

  // The far end of the chain is a minimal core (AGENTS.md rule 3.3), bodies of many handles (a ship-rigged hull's
  // shrouds, ratlines and oar ports) included: the shared bake (js/continuum-bake.js) collapses them all.
  test(`${id} far body ends in a core of a few triangles`, () => {
    const { far } = manifestOf(id);
    assert.ok(far.coreTriangles < far.triangleCount / 50, `${id} core is a few triangles (${far.coreTriangles})`);
  });
}
