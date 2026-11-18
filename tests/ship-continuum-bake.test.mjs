// The ships' continuum bake (scripts/prepare-ship-continuum.mjs): its files, its freshness against the ships as they
// are built now, and each guarantee the one cut leans on, checked on every body of the one atlas format
// (js/continuum-format.js). A body baked from another assembly than the one js/trade-vessels.js or js/ship-mesh.js
// builds fails here (rebake with `node scripts/prepare-ship-continuum.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { CONTINUUM_HOPS, CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import {
  CONTINUUM_CLUSTER_TRIANGLES, CONTINUUM_CLUSTER_WORDS, CONTINUUM_NEVER, CONTINUUM_STREAMS, CONTINUUM_TRIANGLE_WORDS, CONTINUUM_TYPE,
  CONTINUUM_TYPE_DETAIL_SHIFT, continuumBodyParts,
} from '../js/continuum-format.js';
import {
  SHIP_CONTINUUM_ASSETS, SHIP_CONTINUUM_BODIES, shipContinuumStreams, shipContinuumSourceKey, shipContinuumSurface,
  shipContinuumSurfaceMatches, validateShipContinuumManifest,
} from '../js/ship-continuum.js';
import { SHIP_RIDER_FAR, SHIP_RIDER_LINE } from '../js/wgsl/ship-kinds.js';
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
// A packed body: its words, its parts, and its rider stream (the assembly vertex each atlas vertex rides).
function bodyOf(id, manifest) {
  const bytes = stream(id, 'body.bin', manifest), u = words(bytes), f = floats(bytes), parts = continuumBodyParts(u);
  let from = parts.streamsAt, riders = null;
  for (const s of CONTINUUM_STREAMS) {
    if (!(parts.streams & s.bit)) continue;
    if (s.name === 'rider') riders = u.subarray(from, from + parts.vertices);
    from += s.words * parts.vertices;
  }
  assert.ok(riders, `${id} carries the rider stream`);
  const type = (field) => u[parts.typeAt + field];
  return { u, f, parts, riders, type };
}
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
  const build = fs.readFileSync(at('build.mjs'), 'utf8');
  assert.match(build, /SHIP_CONTINUUM_ASSETS/, 'build.mjs embeds the bodies');
  // Ships are a family of the one cut: no select, list or draw of their own.
  for (const gone of ['js/wgsl/ship-continuum.js', 'js/ship-continuum-draw.js']) {
    assert.ok(!fs.existsSync(at(gone)), `${gone} is gone`);
    assert.equal(build.indexOf(`'${gone}'`), -1, `${gone} is not bundled`);
  }
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
    assert.equal(manifest.source.indices, arch.indices.length);
    assert.equal(manifest.source.shards, arch.fracture.shardCount);
    const shards = arch.fracture.vertexShards;
    if (family === 'trade') {
      const vertices = stream(id, 'vertices.bin', manifest);
      assert.ok(Buffer.from(arch.vertices.buffer, arch.vertices.byteOffset, arch.vertices.byteLength).equals(vertices), `${id} vertices are the assembly's`);
      assert.deepEqual(Array.from(words(stream(id, 'shards.bin', manifest))), Array.from(shards), `${id} each vertex flies with its shard`);
    } else {
      assert.deepEqual(Array.from(words(stream(id, 'corners.bin', manifest))), Array.from(arch.indices), `${id} corners are the assembly's`);
    }

    const { u, f, parts, riders, type } = bodyOf(id, manifest), V = arch.vertexCount;
    assert.equal(parts.clusters, manifest.clusters.count);
    const key = (t) => { const s = t.slice().sort((a, b) => a - b); return `${s[0]},${s[1]},${s[2]}`; };
    const drawn = [];
    for (let t = 0; t < arch.indices.length; t += 3) {
      const tri = [arch.indices[t], arch.indices[t + 1], arch.indices[t + 2]];
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) drawn.push(key(tri));
    }
    assert.equal(parts.sourceTriangles, drawn.length, `${id} counts the triangles it draws`);
    // The detail layer leads her clusters, its count in her type's flags; every other point rides a ship vertex.
    const D = manifest.detail.clusters;
    assert.equal(type(CONTINUUM_TYPE.flags) >>> CONTINUUM_TYPE_DETAIL_SHIFT, D, `${id} flags its detail layer`);
    let lines = 0;
    for (let i = 0; i < parts.ownVertices; i++) {
      const r = riders[i];
      assert.equal(r & SHIP_RIDER_FAR, 0, `${id} cluster vertex ${i} rides no far vertex`);
      if (r & SHIP_RIDER_LINE) { lines++; assert.ok((r & ~SHIP_RIDER_LINE) < manifest.detail.lineVertices, `${id} line vertex ${i} is one of her lines`); }
      else assert.ok(r < V, `${id} cluster vertex ${i} rides a ship vertex`);
    }
    assert.equal(lines, manifest.detail.lineVertices, `${id} draws each of her line vertices once`);

    const finest = [];
    let roots = 0, lastParent = Infinity;
    for (let c = 0; c < parts.clusters; c++) {
      const o = parts.clustersAt + c * CONTINUUM_CLUSTER_WORDS, error = f[o + 12], parentError = f[o + 13], first = u[o + 14];
      const triangles = u[o + 15] & 255, level = (u[o + 15] >>> 8) & 255;
      assert.ok(triangles > 0 && triangles <= CONTINUUM_CLUSTER_TRIANGLES && first + triangles * 3 <= parts.indices, `${id} cluster ${c} lies in the index stream`);
      assert.ok(error <= parentError, `${id} cluster ${c} is finer than its parent`);
      assert.ok(parentError <= lastParent, `${id} clusters are ordered coarsest parent first`);
      lastParent = parentError;
      for (const k of [3, 7, 11]) assert.ok(f[o + k] > 0, `${id} cluster ${c} spheres hold its points`);
      const corner = (i) => u[parts.indicesAt + i];
      for (let i = first; i < first + triangles * 3; i++) assert.ok(corner(i) < parts.ownVertices, `${id} cluster ${c} names a cluster vertex`);
      if (c < D) {
        // A detail cluster is a root of error 0, drawn with the clusters, whole or not at all.
        assert.ok(error === 0 && parentError >= 1e30 && level === 0, `${id} detail cluster ${c} is a root of error 0`);
      } else if (parentError >= 1e30) roots++;
      // Simplification never crosses a part or shard boundary: a cluster of the ship is of one shard.
      const ridden = Array.from({ length: triangles * 3 }, (_, k) => riders[corner(first + k)]);
      if (ridden.some((r) => r & SHIP_RIDER_LINE)) {
        assert.ok(c < D && ridden.every((r) => r & SHIP_RIDER_LINE), `${id} cluster ${c} of lines is all lines, and of the detail layer`);
        continue;
      }
      const shard = shards[ridden[0]];
      for (const r of ridden) if (shards[r] !== shard) assert.fail(`${id} cluster ${c} crosses shards ${shard} and ${shards[r]}`);
      if (level === 0) for (let k = 0; k < ridden.length; k += 3) finest.push(ridden.slice(k, k + 3));
    }
    assert.equal(roots, manifest.clusters.roots, `${id} roots`);
    // The finest cut is the physical truth: level 0 and her iron are every triangle the assembly draws, once.
    assert.deepEqual(finest.map(key).sort(), drawn.sort(), `${id} finest cut is the assembly`);
  });

  test(`${id} far body collapses in error order to its core, every vertex riding a ship vertex`, () => {
    const manifest = manifestOf(id), { u, f, parts, riders, type } = bodyOf(id, manifest);
    const S = type(CONTINUUM_TYPE.stepCount), V = type(CONTINUUM_TYPE.chainVertexCount);
    const records = parts.chainAt + type(CONTINUUM_TYPE.records), triangles = parts.chainAt + type(CONTINUUM_TYPE.triangles), steps = parts.chainAt + type(CONTINUUM_TYPE.steps);
    assert.equal(type(CONTINUUM_TYPE.chainVertices), parts.ownVertices, `${id} far vertices follow her cluster vertices`);
    assert.equal(parts.ownVertices + V, parts.vertices);
    const T = (steps - triangles) / CONTINUUM_TRIANGLE_WORDS;
    assert.ok(Number.isInteger(T), `${id} whole far triangles`);
    assert.equal(steps + (S + 1) * CONTINUUM_STEP_WORDS, parts.streamsAt, `${id} the far body fills the body to its streams`);
    // Each far vertex rides the cluster vertex d before it, which rides a ship vertex (not a line).
    for (let i = 0; i < V; i++) {
      const r = riders[parts.ownVertices + i];
      assert.ok(r & SHIP_RIDER_FAR, `${id} far vertex ${i} rides a cluster vertex`);
      const ridden = parts.ownVertices + i - (r & ~SHIP_RIDER_FAR);
      assert.ok(ridden >= 0 && ridden < parts.ownVertices, `${id} far vertex ${i} rides a vertex of her clusters`);
      assert.ok(!(riders[ridden] & (SHIP_RIDER_LINE | SHIP_RIDER_FAR)) && riders[ridden] < manifest.source.vertices, `${id} far vertex ${i} rides a ship vertex`);
    }
    // Each vertex goes past its step (gone at every later one) into a vertex that outlives it, and every chain ends inside the GPU's walk.
    const dieStep = (v) => u[records + v] & 0xffff, target = (v) => u[records + v] >>> 16;
    let deepest = 0;
    for (let v = 0; v < V; v++) {
      if (dieStep(v) === CONTINUUM_NEVER) continue;
      assert.ok(dieStep(v) < S, `${id} far vertex ${v} goes between two steps`);
      let w = v, hops = 0;
      while (dieStep(w) !== CONTINUUM_NEVER && hops <= CONTINUUM_HOPS) {
        const next = target(w);
        assert.ok(next < V && next !== w && (dieStep(next) === CONTINUUM_NEVER || dieStep(next) > dieStep(w)), `${id} far vertex ${w} collapses into a survivor`);
        w = next; hops++;
      }
      deepest = Math.max(deepest, hops);
    }
    assert.ok(deepest <= CONTINUUM_HOPS, `${id} chains are at most ${CONTINUUM_HOPS} deep (${deepest})`);
    for (let k = 0; k < T; k++) for (let c = 0; c < 3; c++) assert.ok(u[triangles + k * CONTINUUM_TRIANGLE_WORDS + c] < V, `${id} far triangle corner names a far vertex`);
    // Steps: triangles alive fall, error rises, from the base to the core.
    const step = (s) => ({ alive: u[steps + s * CONTINUUM_STEP_WORDS], error: f[steps + s * CONTINUUM_STEP_WORDS + 1], inflate: f[steps + s * CONTINUUM_STEP_WORDS + 2] });
    assert.equal(step(0).alive, T);
    assert.equal(step(S).alive, manifest.far.coreTriangles);
    assert.ok(manifest.far.coreTriangles >= 4, `${id} core is closed (${manifest.far.coreTriangles})`);
    for (let s = 1; s <= S; s++) {
      const a = step(s - 1), b = step(s);
      assert.ok(b.alive <= a.alive && b.error >= a.error && Number.isFinite(b.inflate) && b.inflate >= 0, `${id} step ${s} coarsens`);
    }
    assert.ok(step(S).error > step(0).error);
    assert.equal(type(CONTINUUM_TYPE.farFirst), manifest.far.farFirst);
    const { splat } = manifest;
    assert.ok(splat.ry > 0 && splat.rxSide > 0 && splat.rxEnd > 0 && splat.colour.every((c) => Number.isFinite(c) && c >= 0), `${id} splat`);
    assert.ok(f[parts.typeAt + CONTINUUM_TYPE.splatRx] > 0 && f[parts.typeAt + CONTINUUM_TYPE.splatRy] > 0, `${id} type carries its splat`);
  });

  // The far end of the chain is a minimal core (AGENTS.md rule 3.3), bodies of many handles (a ship-rigged hull's
  // shrouds, ratlines and oar ports) included: the shared bake (js/continuum-bake.js) collapses them all.
  test(`${id} far body ends in a core of a few triangles`, () => {
    const { far } = manifestOf(id);
    assert.ok(far.coreTriangles < far.baseTriangles / 50, `${id} core is a few triangles (${far.coreTriangles})`);
  });
}
