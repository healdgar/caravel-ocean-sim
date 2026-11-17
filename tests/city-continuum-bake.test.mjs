// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The city continuum's baked atlas (scripts/prepare-city-continuum.mjs) against what it was baked from and what the
// GPU reads of it: every Cairn type's builder unchanged since the bake, the atlas whole and laid out as the header
// says, each type's clusters in the order the core's prefix search needs, its far body's steps rising and ending in a
// core of a few triangles, no vertex followed past the GPU's hops, and the build publishing both files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { buildPortPrefabGeometry } from '../js/coastal-world.js';
import { CITY_BUILDING_TYPES, compileCityBuildingTypes } from '../js/old-world-buildings.js';
import {
  CITY_CONTINUUM_ASSETS, CITY_CONTINUUM_CLUSTER_TRIANGLES, CITY_CONTINUUM_CLUSTER_WORDS, CITY_CONTINUUM_HEADER, CITY_CONTINUUM_HOPS,
  CITY_CONTINUUM_MAGIC, CITY_CONTINUUM_NEVER, CITY_CONTINUUM_STEP_WORDS, CITY_CONTINUUM_TRIANGLE_WORDS, CITY_CONTINUUM_TYPE,
  CITY_CONTINUUM_TYPE_WORDS, CITY_CONTINUUM_VERSION, CITY_CONTINUUM_VERTEX_WORDS, cityContinuumSourceBytes, validateCityContinuumManifest,
} from '../js/city-continuum.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = validateCityContinuumManifest(JSON.parse(fs.readFileSync(CITY_CONTINUUM_ASSETS['manifest.json'], 'utf8')));
const gz = fs.readFileSync(CITY_CONTINUUM_ASSETS['atlas.bin.gz']), bytes = zlib.gunzipSync(gz);
const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), floats = new Float32Array(words.buffer, words.byteOffset, words.length);
const H = CITY_CONTINUUM_HEADER, T = CITY_CONTINUUM_TYPE;
const field = (type, f) => words[words[H.typesAt] + type * CITY_CONTINUUM_TYPE_WORDS + f];

test('every type is baked from its builder as it stands now', () => {
  const types = compileCityBuildingTypes(buildPortPrefabGeometry);
  assert.equal(types.length, CITY_BUILDING_TYPES.length);
  assert.equal(manifest.types.length, types.length, 'one baked record a type');
  const stale = types.filter((type) => manifest.types[type.id]?.fingerprint !== sha256(cityContinuumSourceBytes(type))).map((type) => type.name);
  assert.deepEqual(stale, [], 'builders changed since the bake: run node scripts/prepare-city-continuum.mjs');
  for (const type of types) assert.equal(manifest.types[type.id].sourceTriangles, type.triangles);
});

test('the atlas is whole and laid out as its header says', () => {
  assert.equal(sha256(gz), manifest.atlas.gzip.sha256);
  assert.equal(bytes.byteLength, manifest.atlas.bytes);
  assert.equal(sha256(bytes), manifest.atlas.sha256);
  assert.equal(words[H.magic], CITY_CONTINUUM_MAGIC);
  assert.equal(words[H.version], CITY_CONTINUUM_VERSION);
  assert.equal(words[H.typeCount], manifest.types.length);
  assert.equal(words[H.clusterCount], manifest.totals.clusters);
  assert.equal(words[H.words], words.length);
  assert.ok(words[H.typesAt] < words[H.clustersAt] && words[H.clustersAt] < words[H.verticesAt] && words[H.verticesAt] < words[H.indicesAt] && words[H.indicesAt] < words[H.chainsAt]);
  assert.equal(words[H.clustersAt] + words[H.clusterCount] * CITY_CONTINUUM_CLUSTER_WORDS, words[H.verticesAt]);
  assert.equal(words[H.verticesAt] + words[H.vertexCount] * CITY_CONTINUUM_VERTEX_WORDS, words[H.indicesAt]);
  assert.equal(words[H.indicesAt] + words[H.indexCount], words[H.chainsAt]);
});

test('each type\'s clusters are its own, coarsest parent first, and its far body collapses to a core', () => {
  let nextCluster = 0, nextChain = words[H.chainsAt];
  for (const record of manifest.types) {
    const type = record.id, first = field(type, T.clusterFirst), count = field(type, T.clusterCount);
    assert.equal(first, nextCluster, `${record.name}: clusters follow the type before`);
    assert.equal(count, record.clusters.count);
    nextCluster += count;
    // The core's prefix search (continuumClusterPrefixWGSL) needs parent errors that never rise along the run, and
    // every cluster's indices must be inside the atlas's.
    let previous = Infinity, roots = 0, triangles = 0;
    for (let c = first; c < first + count; c++) {
      const at = words[H.clustersAt] + c * CITY_CONTINUUM_CLUSTER_WORDS, parent = floats[at + 13], error = floats[at + 12], n = words[at + 15] & 255;
      assert.ok(parent <= previous, `${record.name}: cluster ${c - first} has a coarser parent than the one before`);
      assert.ok(error <= parent, `${record.name}: cluster ${c - first} is coarser than its parent`);
      assert.ok(n > 0 && n <= CITY_CONTINUUM_CLUSTER_TRIANGLES);
      assert.ok(words[at + 14] + n * 3 <= words[H.indexCount]);
      previous = parent;
      if (parent >= 1e30) { roots++; triangles += n; }
    }
    assert.equal(roots, record.clusters.roots, `${record.name}: its roots`);
    // The far body: its pieces lie one after another, its steps' errors rise strictly, its alive triangles fall to
    // a core of a few, and it is drawn from a step no heavier than the clusters' coarsest cut.
    const S = field(type, T.stepCount), V = field(type, T.chainVertexCount), triangleCount = field(type, T.chainTriangleCount), steps = field(type, T.steps);
    assert.equal(field(type, T.chainVertices), nextChain);
    assert.equal(field(type, T.records), nextChain + V * CITY_CONTINUUM_VERTEX_WORDS);
    assert.equal(field(type, T.triangles), field(type, T.records) + V);
    assert.equal(steps, field(type, T.triangles) + triangleCount * CITY_CONTINUUM_TRIANGLE_WORDS);
    nextChain = steps + (S + 1) * CITY_CONTINUUM_STEP_WORDS;
    assert.equal(S, record.chain.steps);
    for (let s = 1; s <= S; s++) {
      const e0 = floats[steps + (s - 1) * CITY_CONTINUUM_STEP_WORDS + 1], e1 = floats[steps + s * CITY_CONTINUUM_STEP_WORDS + 1];
      assert.ok(e1 > e0, `${record.name}: step ${s} error ${e1} does not rise past ${e0}`);
      assert.ok(words[steps + s * CITY_CONTINUUM_STEP_WORDS] <= words[steps + (s - 1) * CITY_CONTINUUM_STEP_WORDS], `${record.name}: step ${s} gains triangles`);
    }
    assert.equal(words[steps], triangleCount, `${record.name}: step 0 is the whole far body`);
    assert.ok(words[steps + S * CITY_CONTINUUM_STEP_WORDS] >= 1, `${record.name}: the core is not empty`);
    const farFirst = field(type, T.farFirst);
    assert.ok(farFirst <= S, `${record.name}: its first far step ${farFirst} of ${S}`);
    assert.ok(farFirst === S || words[steps + farFirst * CITY_CONTINUUM_STEP_WORDS] <= triangles, `${record.name}: the far body starts heavier than its root clusters (${words[steps + farFirst * CITY_CONTINUUM_STEP_WORDS]} > ${triangles})`);
    // No vertex is followed through more collapses than the GPU walks, and every collapse goes to a vertex that
    // outlives it.
    let depth = 0;
    for (let v = 0; v < V; v++) {
      let hops = 0;
      for (let w = v, word = words[field(type, T.records) + w]; (word & 0xffff) !== CITY_CONTINUUM_NEVER; w = word >>> 16, word = words[field(type, T.records) + w]) {
        const target = word >>> 16, then = words[field(type, T.records) + target] & 0xffff;
        assert.ok(target < V && target !== w, `${record.name}: vertex ${w} collapses nowhere`);
        assert.ok(then === CITY_CONTINUUM_NEVER || then > (word & 0xffff), `${record.name}: vertex ${w} collapses into one gone before it`);
        if (++hops > CITY_CONTINUUM_HOPS) break;
      }
      depth = Math.max(depth, hops);
    }
    assert.ok(depth <= CITY_CONTINUUM_HOPS, `${record.name}: ${depth} hops`);
  }
  assert.equal(nextCluster, words[H.clusterCount]);
  assert.equal(nextChain, words.length, 'the chains fill the atlas to its end');
});

test('the build publishes the atlas and its manifest', () => {
  const build = fs.readFileSync('build.mjs', 'utf8');
  assert.match(build, /CITY_CONTINUUM_ASSETS/);
  assert.ok(build.indexOf("'js/city-continuum.js'") > 0 && build.indexOf("'js/wgsl/city-continuum.js'") > build.indexOf("'js/city-continuum.js'"), 'both modules are in the bundle order');
  for (const path of Object.values(CITY_CONTINUUM_ASSETS)) assert.ok(fs.existsSync(path), `${path} is committed`);
});
