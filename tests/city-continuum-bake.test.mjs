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
import { CONTINUUM_HOPS, CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import {
  CONTINUUM_ATLAS_MAGIC, CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_CLUSTER_TRIANGLES, CONTINUUM_CLUSTER_WORDS, CONTINUUM_HEADER, CONTINUUM_NEVER,
  CONTINUUM_STREAMS, CONTINUUM_TRIANGLE_WORDS, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_VERTEX_WORDS, continuumSourceBytes,
} from '../js/continuum-format.js';
import { CITY_CONTINUUM_ASSETS, CITY_CONTINUUM_VERSION, validateCityContinuumManifest } from '../js/city-continuum.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = validateCityContinuumManifest(JSON.parse(fs.readFileSync(CITY_CONTINUUM_ASSETS['manifest.json'], 'utf8')));
const gz = fs.readFileSync(CITY_CONTINUUM_ASSETS['atlas.bin.gz']), bytes = zlib.gunzipSync(gz);
const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), floats = new Float32Array(words.buffer, words.byteOffset, words.length);
const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE;
const field = (type, f) => words[words[H.typesAt] + type * CONTINUUM_TYPE_WORDS + f];
// Where the side streams begin: the far bodies end there.
const streamsAt = Math.min(words.length, ...CONTINUUM_STREAMS.filter(({ bit }) => words[H.streams] & bit).map(({ name }) => words[H[name]]));

test('every type is baked from its builder as it stands now', () => {
  const types = compileCityBuildingTypes(buildPortPrefabGeometry);
  assert.equal(types.length, CITY_BUILDING_TYPES.length);
  assert.equal(manifest.types.length, types.length, 'one baked record a type');
  const stale = types.filter((type) => manifest.types[type.id]?.fingerprint !== sha256(continuumSourceBytes(type))).map((type) => type.name);
  assert.deepEqual(stale, [], 'builders changed since the bake: run node scripts/prepare-city-continuum.mjs');
  for (const type of types) assert.equal(manifest.types[type.id].sourceTriangles, type.triangles);
});

test('the atlas is whole and laid out as its header says', () => {
  assert.equal(sha256(gz), manifest.atlas.gzip.sha256);
  assert.equal(bytes.byteLength, manifest.atlas.bytes);
  assert.equal(sha256(bytes), manifest.atlas.sha256);
  assert.equal(words[H.magic], CONTINUUM_ATLAS_MAGIC);
  assert.equal(words[H.version], CITY_CONTINUUM_VERSION);
  assert.equal(words[H.hops], CONTINUUM_HOPS, 'baked for the cut\'s hop limit');
  assert.equal(words[H.chunkTriangles], CONTINUUM_CHUNK_TRIANGLES, 'baked for the cut\'s chunk size');
  assert.equal(words[H.typeCount], manifest.types.length);
  assert.equal(words[H.clusterCount], manifest.totals.clusters);
  assert.equal(words[H.words], words.length);
  assert.ok(words[H.typesAt] < words[H.clustersAt] && words[H.clustersAt] < words[H.verticesAt] && words[H.verticesAt] < words[H.indicesAt] && words[H.indicesAt] < words[H.chainsAt]);
  assert.equal(words[H.clustersAt] + words[H.clusterCount] * CONTINUUM_CLUSTER_WORDS, words[H.verticesAt]);
  assert.equal(words[H.verticesAt] + words[H.vertexCount] * CONTINUUM_VERTEX_WORDS, words[H.indicesAt]);
  assert.equal(words[H.indicesAt] + words[H.indexCount], words[H.chainsAt]);
});

test('each type\'s clusters are its own, coarsest parent first, and its far body collapses to a core', () => {
  let nextCluster = 0, nextChain = words[H.chainsAt], nextFarVertex = 0;
  for (const record of manifest.types) {
    const type = record.id, first = field(type, T.clusterFirst), count = field(type, T.clusterCount);
    assert.equal(first, nextCluster, `${record.name}: clusters follow the type before`);
    assert.equal(count, record.clusters.count);
    nextCluster += count;
    // The core's prefix search (continuumClusterPrefixWGSL) needs parent errors that never rise along the run, and
    // every cluster's indices must be inside the atlas's.
    let previous = Infinity, roots = 0, triangles = 0;
    for (let c = first; c < first + count; c++) {
      const at = words[H.clustersAt] + c * CONTINUUM_CLUSTER_WORDS, parent = floats[at + 13], error = floats[at + 12], n = words[at + 15] & 255;
      assert.ok(parent <= previous, `${record.name}: cluster ${c - first} has a coarser parent than the one before`);
      assert.ok(error <= parent, `${record.name}: cluster ${c - first} is coarser than its parent`);
      assert.ok(n > 0 && n <= CONTINUUM_CLUSTER_TRIANGLES);
      assert.ok(words[at + 14] + n * 3 <= words[H.indexCount]);
      previous = parent;
      if (parent >= 1e30) { roots++; triangles += n; }
    }
    assert.equal(roots, record.clusters.roots, `${record.name}: its roots`);
    // The far body: its vertices follow its clusters' in the vertex section, its pieces lie one after another, its
    // steps' errors rise strictly, its alive triangles fall to a core of a few, and it is drawn from a step no heavier
    // than the clusters' coarsest cut.
    const S = field(type, T.stepCount), V = field(type, T.chainVertexCount), steps = field(type, T.steps);
    assert.ok(field(type, T.chainVertices) >= nextFarVertex && field(type, T.chainVertices) + V <= words[H.vertexCount], `${record.name}: its far vertices lie in the vertex section`);
    nextFarVertex = field(type, T.chainVertices) + V;
    assert.equal(field(type, T.records), nextChain);
    assert.equal(field(type, T.triangles), field(type, T.records) + V);
    const triangleCount = (steps - field(type, T.triangles)) / CONTINUUM_TRIANGLE_WORDS;
    assert.ok(Number.isInteger(triangleCount), `${record.name}: whole far triangles`);
    nextChain = steps + (S + 1) * CONTINUUM_STEP_WORDS;
    assert.equal(S, record.chain.steps);
    for (let s = 1; s <= S; s++) {
      const e0 = floats[steps + (s - 1) * CONTINUUM_STEP_WORDS + 1], e1 = floats[steps + s * CONTINUUM_STEP_WORDS + 1];
      assert.ok(e1 > e0, `${record.name}: step ${s} error ${e1} does not rise past ${e0}`);
      assert.ok(words[steps + s * CONTINUUM_STEP_WORDS] <= words[steps + (s - 1) * CONTINUUM_STEP_WORDS], `${record.name}: step ${s} gains triangles`);
    }
    assert.equal(words[steps], triangleCount, `${record.name}: step 0 is the whole far body`);
    assert.ok(words[steps + S * CONTINUUM_STEP_WORDS] >= 1, `${record.name}: the core is not empty`);
    const farFirst = field(type, T.farFirst);
    assert.ok(farFirst <= S, `${record.name}: its first far step ${farFirst} of ${S}`);
    assert.ok(farFirst === S || words[steps + farFirst * CONTINUUM_STEP_WORDS] <= triangles, `${record.name}: the far body starts heavier than its root clusters (${words[steps + farFirst * CONTINUUM_STEP_WORDS]} > ${triangles})`);
    // No vertex is followed through more collapses than the GPU walks, and every collapse goes to a vertex that
    // outlives it.
    let depth = 0;
    for (let v = 0; v < V; v++) {
      let hops = 0;
      for (let w = v, word = words[field(type, T.records) + w]; (word & 0xffff) !== CONTINUUM_NEVER; w = word >>> 16, word = words[field(type, T.records) + w]) {
        const target = word >>> 16, then = words[field(type, T.records) + target] & 0xffff;
        assert.ok(target < V && target !== w, `${record.name}: vertex ${w} collapses nowhere`);
        assert.ok(then === CONTINUUM_NEVER || then > (word & 0xffff), `${record.name}: vertex ${w} collapses into one gone before it`);
        if (++hops > CONTINUUM_HOPS) break;
      }
      depth = Math.max(depth, hops);
    }
    assert.ok(depth <= CONTINUUM_HOPS, `${record.name}: ${depth} hops`);
  }
  assert.equal(nextCluster, words[H.clusterCount]);
  assert.equal(nextChain, streamsAt, 'the chains fill the atlas to its side streams');
});

test('the build publishes the atlas and its manifest', () => {
  const build = fs.readFileSync('build.mjs', 'utf8');
  assert.match(build, /CITY_CONTINUUM_ASSETS/);
  assert.ok(build.indexOf("'js/continuum-format.js'") > 0 && build.indexOf("'js/city-continuum.js'") > build.indexOf("'js/continuum-format.js'") && build.indexOf("'js/wgsl/city-continuum.js'") > build.indexOf("'js/city-continuum.js'"), 'the format and both modules are in the bundle order');
  for (const path of Object.values(CITY_CONTINUUM_ASSETS)) assert.ok(fs.existsSync(path), `${path} is committed`);
});
