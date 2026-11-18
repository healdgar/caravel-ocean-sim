// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The prop continuum's baked atlas (scripts/prepare-prop-continuum.mjs) against what it was baked from and what the
// GPU reads of it: every prop baked from the very mesh its physics strikes, round shot a sphere, the atlas whole and
// laid out as the header says, each type's clusters in the order the core's prefix search needs and each cluster
// within one shard, its far body's steps rising to a core of a few triangles, and the build publishing both files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { weldDrawn, bakeClusters } from '../js/continuum-bake.js';
import { propContinuumSources } from '../scripts/prepare-prop-continuum.mjs';
import { CONTINUUM_HOPS, CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import {
  CONTINUUM_ATLAS_MAGIC, CONTINUUM_CLUSTER_TRIANGLES, CONTINUUM_CLUSTER_WORDS, CONTINUUM_HEADER, CONTINUUM_NEVER, CONTINUUM_STREAMS,
  CONTINUUM_TRIANGLE_WORDS, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_VERTEX_WORDS, continuumSourceBytes, unpackContinuumUV,
} from '../js/continuum-format.js';
import {
  PROP_CONTINUUM_ASSETS, PROP_CONTINUUM_MATERIAL, PROP_CONTINUUM_PLAIN, PROP_CONTINUUM_SHOT, PROP_CONTINUUM_TYPES,
  PROP_CONTINUUM_VERSION, roundShotSource, validatePropContinuumManifest,
} from '../js/prop-continuum.js';
import { PROP_MODELS } from '../js/port-props.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = validatePropContinuumManifest(JSON.parse(fs.readFileSync(PROP_CONTINUUM_ASSETS['manifest.json'], 'utf8')));
const gz = fs.readFileSync(PROP_CONTINUUM_ASSETS['atlas.bin.gz']), bytes = zlib.gunzipSync(gz);
const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), floats = new Float32Array(words.buffer, words.byteOffset, words.length);
const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE, M = PROP_CONTINUUM_MATERIAL;
const field = (type, f) => words[words[H.typesAt] + type * CONTINUUM_TYPE_WORDS + f];
const fieldFloat = (type, f) => floats[words[H.typesAt] + type * CONTINUUM_TYPE_WORDS + f];
// Where the side streams begin: the far bodies end there.
const streamsAt = Math.min(words.length, ...CONTINUUM_STREAMS.filter(({ bit }) => words[H.streams] & bit).map(({ name }) => words[H[name]]));
const sources = propContinuumSources();

test('every prop is baked from the mesh its physics strikes, and round shot from its sphere', () => {
  assert.deepEqual(manifest.types.map((type) => type.name), [...PROP_CONTINUUM_TYPES]);
  const stale = sources.filter(({ type }) => manifest.types[type.id].fingerprint !== sha256(continuumSourceBytes(type))).map(({ type }) => type.name);
  assert.deepEqual(stale, [], 'models changed since the bake: run node scripts/prepare-prop-continuum.mjs');
  for (const { type } of sources) assert.equal(manifest.types[type.id].sourceTriangles, type.triangles);
  // Each prop's pigment is its own model's, in the layer of its number; shot is plain cast iron.
  PROP_MODELS.forEach((spec, id) => assert.equal(field(id, M.layer), id, `${spec.id} reads its own pigment`));
  assert.equal(field(PROP_CONTINUUM_SHOT, M.layer), PROP_CONTINUUM_PLAIN);
  assert.ok(fieldFloat(PROP_CONTINUUM_SHOT, M.albedo) < 0.1 && fieldFloat(PROP_CONTINUUM_SHOT, M.roughness) > 0.3);
  // Every prop carries its pigment's UV beside its vertices.
  assert.ok(words[H.streams] & CONTINUUM_STREAMS.find(({ name }) => name === 'uv').bit, 'the atlas carries the UV stream');
  // The sphere is a sphere: every corner a unit from its centre.
  const ball = roundShotSource();
  for (let v = 0; v < ball.vertices.length; v += 8) assert.ok(Math.abs(Math.hypot(ball.vertices[v], ball.vertices[v + 1], ball.vertices[v + 2]) - 1) < 1e-6);
});

test('the atlas is whole and laid out as its header says', () => {
  assert.equal(sha256(gz), manifest.atlas.gzip.sha256);
  assert.equal(bytes.byteLength, manifest.atlas.bytes);
  assert.equal(sha256(bytes), manifest.atlas.sha256);
  assert.equal(words[H.magic], CONTINUUM_ATLAS_MAGIC);
  assert.equal(words[H.version], PROP_CONTINUUM_VERSION);
  assert.equal(words[H.typeCount], manifest.types.length);
  assert.equal(words[H.clusterCount], manifest.totals.clusters);
  assert.equal(words[H.words], words.length);
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
    const S = field(type, T.stepCount), V = field(type, T.chainVertexCount), steps = field(type, T.steps);
    assert.ok(field(type, T.chainVertices) >= nextFarVertex && field(type, T.chainVertices) + V <= words[H.vertexCount], `${record.name}: its far vertices lie in the vertex section`);
    nextFarVertex = field(type, T.chainVertices) + V;
    assert.equal(field(type, T.records), nextChain);
    assert.equal(field(type, T.triangles), field(type, T.records) + V);
    const triangleCount = (steps - field(type, T.triangles)) / CONTINUUM_TRIANGLE_WORDS;
    assert.ok(Number.isInteger(triangleCount), `${record.name}: whole far triangles`);
    nextChain = steps + (S + 1) * CONTINUUM_STEP_WORDS;
    for (let s = 1; s <= S; s++) {
      const e0 = floats[steps + (s - 1) * CONTINUUM_STEP_WORDS + 1], e1 = floats[steps + s * CONTINUUM_STEP_WORDS + 1];
      assert.ok(e1 > e0, `${record.name}: step ${s} error ${e1} does not rise past ${e0}`);
      assert.ok(words[steps + s * CONTINUUM_STEP_WORDS] <= words[steps + (s - 1) * CONTINUUM_STEP_WORDS], `${record.name}: step ${s} gains triangles`);
    }
    assert.equal(words[steps], triangleCount, `${record.name}: step 0 is the whole far body`);
    // The city's wrap closes each piece apart, so a jetty's pilings each end as a small closed core of their own.
    assert.ok(words[steps + S * CONTINUUM_STEP_WORDS] >= 1 && words[steps + S * CONTINUUM_STEP_WORDS] * 20 <= triangleCount, `${record.name}: the core is not empty, and a small part of the whole`);
    const farFirst = field(type, T.farFirst);
    assert.ok(farFirst === S || words[steps + farFirst * CONTINUUM_STEP_WORDS] <= triangles, `${record.name}: the far body starts heavier than its root clusters`);
    // Every far triangle's UV lies on its pigment.
    for (let k = 0; k < triangleCount; k++) for (const v of unpackContinuumUV(words[field(type, T.triangles) + k * CONTINUUM_TRIANGLE_WORDS + 3])) assert.ok(v >= 0 && v <= 1);
    let depth = 0;
    for (let v = 0; v < V; v++) {
      let hops = 0;
      for (let w = v, word = words[field(type, T.records) + w]; (word & 0xffff) !== CONTINUUM_NEVER; w = word >>> 16, word = words[field(type, T.records) + w]) {
        if (++hops > CONTINUUM_HOPS) break;
      }
      depth = Math.max(depth, hops);
    }
    assert.ok(depth <= CONTINUUM_HOPS, `${record.name}: ${depth} hops`);
  }
  assert.equal(nextCluster, words[H.clusterCount]);
  assert.equal(nextChain, streamsAt, 'the chains fill the atlas to its side streams');
});

test('no cluster of a prop spans two shards, and the atlas names each cluster\'s shard', async () => {
  await MeshoptSimplifier.ready;
  for (const { type } of sources.slice(0, PROP_MODELS.length)) {
    const welded = weldDrawn(type), clusters = await bakeClusters(welded), first = field(type.id, T.clusterFirst);
    assert.equal(clusters.count, field(type.id, T.clusterCount), `${type.name}: the bake is the atlas's`);
    clusters.records.forEach((record, k) => {
      const parts = new Set();
      for (let i = record.first; i < record.first + record.triangles * 3; i++) parts.add(welded.part[clusters.order[clusters.indices[i]]]);
      assert.deepEqual([...parts], [record.part], `${type.name}: cluster ${k} lies within shard ${record.part}`);
      assert.equal(words[words[H.clustersAt] + (first + k) * CONTINUUM_CLUSTER_WORDS + 15] >>> 16, record.part, `${type.name}: cluster ${k}'s shard in the atlas`);
    });
    assert.equal(new Set(clusters.records.map((record) => record.part)).size, new Set(type.parts).size, `${type.name}: every shard has clusters`);
  }
});

test('the build publishes the atlas and its manifest, and bundles the continuum before the props', () => {
  const build = fs.readFileSync('build.mjs', 'utf8');
  assert.match(build, /PROP_CONTINUUM_ASSETS/);
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('js/continuum-format.js') > 0 && at('js/continuum-format.js') < at('js/prop-continuum.js') && at('js/prop-continuum.js') < at('js/wgsl/prop-continuum.js') && at('js/wgsl/prop-continuum.js') < at('js/props.js'), 'in the bundle order, before their readers');
  assert.equal(at('js/wgsl/props.js'), -1, 'the old props shader is gone');
  assert.equal(at('js/prop-continuum-draw.js'), -1, 'props are a material of the one family: no draw of their own');
  for (const path of Object.values(PROP_CONTINUUM_ASSETS)) assert.ok(fs.existsSync(path), `${path} is committed`);
});
