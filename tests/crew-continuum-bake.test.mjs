// The people continuum's bake (scripts/prepare-crew-continuum.mjs): its format, and each guarantee the GPU cut leans
// on, checked on every body baked in this checkout. Manifests are in git; the streams are not, and a body whose
// streams are absent is skipped (bake them with `node scripts/prepare-crew-continuum.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { CREW_JOINT_NAMES, CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import { CREW_CONTINUUM_BAND } from '../js/wgsl/crew-continuum.js';
import {
  CREW_CONTINUUM_ASSETS, CREW_CONTINUUM_BODIES, CREW_CONTINUUM_CLUSTER_WORDS, CREW_CONTINUUM_JOINT_PART, CREW_CONTINUUM_NEVER,
  CREW_CONTINUUM_PARTS, CREW_CONTINUUM_REGIONS, CREW_CONTINUUM_STEP_WORDS, CREW_CONTINUUM_STREAMS, CREW_CONTINUUM_VERTEX_WORDS,
  crewContinuumOctahedral, crewContinuumWeightBytes, packCrewContinuumCluster, packCrewContinuumVertex, unpackCrewContinuumVertex,
  validateCrewContinuumManifest,
} from '../js/crew-continuum.js';

const at = (file) => new URL(`../${file}`, import.meta.url);
const exists = (file) => fs.existsSync(at(file));
const manifestOf = (id) => JSON.parse(fs.readFileSync(at(CREW_CONTINUUM_ASSETS[id]['manifest.json']), 'utf8'));
const baked = CREW_CONTINUUM_BODIES.filter(({ id }) => exists(CREW_CONTINUUM_ASSETS[id]['manifest.json']));
const streamed = baked.filter(({ id }) => CREW_CONTINUUM_STREAMS.every((name) => exists(CREW_CONTINUUM_ASSETS[id][`${name}.gz`])));
// A stream, checked against both its receipts.
function stream(id, name, manifest) {
  const gz = fs.readFileSync(at(CREW_CONTINUUM_ASSETS[id][`${name}.gz`])), receipt = manifest.files[name];
  assert.equal(createHash('sha256').update(gz).digest('hex'), receipt.gzip.sha256, `${id} ${name}.gz receipt`);
  const bytes = zlib.gunzipSync(gz);
  assert.equal(bytes.length, receipt.bytes, `${id} ${name} size`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256, `${id} ${name} receipt`);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}
const octahedralNormal = ([u, v]) => {
  const fx = u * 2 - 1, fy = v * 2 - 1, n = [fx, fy, 1 - Math.abs(fx) - Math.abs(fy)], t = Math.max(-n[2], 0);
  n[0] += n[0] >= 0 ? -t : t; n[1] += n[1] >= 0 ? -t : t;
  const l = Math.hypot(...n);
  return n.map((x) => x / l);
};

test('every body\'s every file is named, spelled out where the build finds and publishes it', () => {
  const files = ['manifest.json', 'body.glb', ...CREW_CONTINUUM_STREAMS.map((name) => `${name}.gz`)];
  assert.deepEqual(Object.keys(CREW_CONTINUUM_ASSETS), CREW_CONTINUUM_BODIES.map(({ id }) => id));
  for (const { id } of CREW_CONTINUUM_BODIES) assert.deepEqual(CREW_CONTINUUM_ASSETS[id], Object.fromEntries(files.map((file) => [file, `assets/crew/continuum/${id}/${file}`])));
  // build.mjs rewrites only quoted asset paths (to versioned published copies); a composed path would go unpublished.
  const source = fs.readFileSync(new URL('../js/crew-continuum.js', import.meta.url), 'utf8');
  for (const paths of Object.values(CREW_CONTINUUM_ASSETS)) for (const path of Object.values(paths)) assert.ok(source.includes(`'${path}'`), path);
});

test('a vertex keeps its place, normal, skin, part and region through packing', () => {
  const quant = { low: [-1, 0, -0.5], posScale: 2, uvLow: [0, 0], uvScale: [1, 1] };
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 500; i++) {
    const normal = [random() - 0.5, random() - 0.5, random() - 0.5], l = Math.hypot(...normal);
    const vertex = {
      position: [random() * 2 - 1, random() * 2, random() - 0.5], normal: normal.map((x) => x / l), uv: [random(), random()],
      joints: [0, 1, 2, 3].map(() => Math.floor(random() * CREW_JOINT_COUNT)), weights: [random(), random(), random() * 0.1, 0],
      part: Math.floor(random() * CREW_CONTINUUM_PARTS.length), region: Math.floor(random() * CREW_CONTINUUM_REGIONS.length),
    };
    const words = Uint32Array.from(packCrewContinuumVertex(vertex, quant)), back = unpackCrewContinuumVertex(words, 0, quant);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(back.position[k] - vertex.position[k]) <= quant.posScale / 65535, 'position');
    const decoded = octahedralNormal([(words[2] & 65535) / 65535, (words[2] >>> 16) / 65535]);
    assert.ok(decoded.reduce((s, x, k) => s + x * vertex.normal[k], 0) > 0.9999, 'normal');
    assert.ok(Math.abs(back.uv[0] - vertex.uv[0]) < 2e-5 && Math.abs(back.uv[1] - vertex.uv[1]) < 2e-5, 'uv');
    assert.deepEqual(back.joints, vertex.joints);
    assert.equal(back.weights.reduce((s, w) => s + w, 0).toFixed(6), '1.000000');
    assert.equal(back.part, vertex.part);
    assert.equal(back.region, vertex.region);
  }
  assert.deepEqual(crewContinuumOctahedral([0, 0, 1]), [0.5, 0.5]);
  for (const weights of [[1, 0, 0, 0], [0.5, 0.5, 0, 0], [1 / 3, 1 / 3, 1 / 3, 0], [0.26, 0.26, 0.24, 0.24]]) assert.equal(crewContinuumWeightBytes(weights).reduce((s, b) => s + b, 0), 255);
});

test('a joint falls in the part a ball takes off with it', () => {
  const part = (name) => CREW_CONTINUUM_PARTS[CREW_CONTINUUM_JOINT_PART[CREW_JOINT_NAMES.indexOf(name)]];
  for (const [joint, expected] of [['pelvis', 'trunk'], ['spine_03', 'trunk'], ['clavicle_l', 'trunk'], ['neck_01', 'head'], ['head', 'head'], ['upperarm_l', 'upperarm_l'], ['hand_l', 'lowerarm_l'], ['lowerarm_r', 'lowerarm_r'], ['thigh_r', 'thigh_r'], ['foot_r', 'calf_r'], ['ball_l', 'calf_l']]) {
    assert.equal(part(joint), expected, joint);
  }
  assert.equal(CREW_CONTINUUM_JOINT_PART.length, CREW_JOINT_COUNT);
});

test('a root cluster\'s parent error stays finite for the GPU', () => {
  const words = packCrewContinuumCluster({ lod: [0, 1, 0, 0.5], parentLod: [0, 1, 0, 0.5], cull: [0, 1, 0, 0.5], error: 0.4, parentError: Infinity, first: 0, triangles: 128, ownJoint: 1, parentJoint: 1, cullJoint: 2, part: 0, level: 12 });
  const f = new Float32Array(words.buffer);
  assert.ok(Number.isFinite(f[13]) && f[13] >= 1e29 && f[13] * 1e8 < 3.4e38, `${f[13]}`);
});

test('every baked body\'s manifest is whole, and a damaged one is refused', { skip: !baked.length && 'no crew continuum bakes here' }, () => {
  for (const { id, sex, role } of baked) {
    const manifest = validateCrewContinuumManifest(manifestOf(id));
    assert.equal(manifest.sex, sex);
    assert.equal(manifest.role, role);
    assert.deepEqual(manifest.parts, CREW_CONTINUUM_PARTS);
    assert.deepEqual(manifest.regions, CREW_CONTINUUM_REGIONS);
    // Skirts and wraps, held to the range of motion, keep the far body's own error near a quarter metre.
    assert.ok(manifest.chain.baseError > 0 && manifest.chain.baseError < 0.3, `${id} far body error ${manifest.chain.baseError}`);
    // Where a fold or a closed loop of cloth refuses the last collapses, the splat takes over above them.
    assert.ok(manifest.chain.coreTriangles <= 400, `${id} far body ends at ${manifest.chain.coreTriangles} triangles`);
    for (const [where, drift] of Object.entries(manifest.body.contactDrift)) assert.ok(Math.abs(drift) < 0.01, `${id} ${where} drifts ${drift} m`);
    for (const damage of [(m) => { m.version++; }, (m) => { m.id = 'nobody'; }, (m) => { m.chain.offsets.steps++; }, (m) => { m.files['clusters.bin'].bytes += 4; }, (m) => { delete m.files['chain.bin'].sha256; }, (m) => { m.splat.regions.pop(); }]) {
      const copy = structuredClone(manifest);
      damage(copy);
      assert.throws(() => validateCrewContinuumManifest(copy));
    }
  }
});

for (const { id } of CREW_CONTINUUM_BODIES) {
  const ready = streamed.some((b) => b.id === id);
  test(`${id}: clusters keep their parts, rise in error and cover the body once at any cut`, { skip: !ready && 'streams not baked here' }, () => {
    const manifest = manifestOf(id), quant = manifest.quantization;
    const vertices = stream(id, 'vertices.bin', manifest), indices = stream(id, 'indices.bin', manifest), clusters = stream(id, 'clusters.bin', manifest);
    const floats = new Float32Array(clusters.buffer, clusters.byteOffset, clusters.length);
    const V = manifest.vertexCount, C = manifest.clusterCount;
    // Every vertex carries its whole skin.
    for (let v = 0; v < V; v++) {
      const j = vertices[v * 6 + 4], w = vertices[v * 6 + 5];
      assert.equal((w & 255) + ((w >>> 8) & 255) + ((w >>> 16) & 255) + (w >>> 24), 255, `vertex ${v} weights`);
      for (let k = 0; k < 4; k++) assert.ok(((j >>> (k * 8)) & 255) < CREW_JOINT_COUNT, `vertex ${v} joint`);
    }
    const part = (v) => (vertices[v * 6 + 1] >>> 16) & 255, position = (v, out) => {
      out[0] = quant.low[0] + ((vertices[v * 6] & 65535) / 65535) * quant.posScale;
      out[1] = quant.low[1] + ((vertices[v * 6] >>> 16) / 65535) * quant.posScale;
      out[2] = quant.low[2] + ((vertices[v * 6 + 1] & 65535) / 65535) * quant.posScale;
    };
    const area = new Float64Array(C), a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
    let next = 0, previousParent = Infinity, level0 = 0;
    for (let k = 0; k < C; k++) {
      const w = k * CREW_CONTINUUM_CLUSTER_WORDS, error = floats[w + 12], parentError = floats[w + 13], first = clusters[w + 14], triangles = clusters[w + 15], own = clusters[w + 16] >>> 24;
      assert.ok(error >= 0 && error <= parentError, `cluster ${k}: error ${error} above its parent's ${parentError}`);
      assert.ok(parentError <= previousParent, `cluster ${k} is out of order`);
      previousParent = parentError;
      assert.equal(first, next, `cluster ${k} does not follow the one before`);
      assert.ok(triangles > 0 && triangles <= 128, `cluster ${k} has ${triangles} triangles`);
      for (const s of [0, 4, 8]) assert.ok(floats[w + s + 3] > 0, `cluster ${k} sphere`);
      for (let i = first; i < first + triangles * 3; i += 3) {
        assert.ok(part(indices[i]) === own && part(indices[i + 1]) === own && part(indices[i + 2]) === own, `cluster ${k}: a triangle spans two parts`);
        position(indices[i], a); position(indices[i + 1], b); position(indices[i + 2], c);
        const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        area[k] += 0.5 * Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
      }
      if (error === 0) level0 += triangles;
      next += triangles * 3;
    }
    assert.equal(next, manifest.indexCount);
    assert.equal(level0, manifest.source.triangles, 'the finest cut is the whole source body');
    // Any cut by error alone draws each part of the body once: ever fewer triangles, never two layers of one surface.
    // Clusters draw only until the far body has taken over (CREW_CONTINUUM_BAND past its own error); to there the
    // surface holds, and past it, where thin cloth and fingers fold away, it may only shrink.
    const drawn = Math.min(manifest.clusters.rootError, manifest.chain.baseError * (1 + CREW_CONTINUUM_BAND));
    let whole = 0, previous = Infinity;
    const cut = (allowed) => {
      let triangles = 0, surface = 0;
      for (let k = 0; k < C; k++) {
        const w = k * CREW_CONTINUUM_CLUSTER_WORDS;
        if (floats[w + 12] <= allowed && allowed < floats[w + 13]) { triangles += clusters[w + 15]; surface += area[k]; }
      }
      return { triangles, surface };
    };
    for (const allowed of [0, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, drawn, manifest.clusters.rootError].sort((x, y) => x - y)) {
      const { triangles, surface } = cut(allowed);
      if (!whole) whole = surface;
      assert.ok(triangles <= previous, `${allowed} m draws more than a finer cut`);
      assert.ok(surface / whole < 1.08, `${allowed} m covers ${(surface / whole * 100).toFixed(1)}% of the body`);
      // A tenth of a metre keeps the surface whole; beyond it, the skirt that holds the far body off longest folds in.
      if (allowed <= drawn) assert.ok(surface / whole > (allowed <= 0.1 ? 0.92 : 0.85), `${allowed} m covers ${(surface / whole * 100).toFixed(1)}% of the body`);
      previous = triangles;
    }
  });

  test(`${id}: the far body collapses as a prefix, every point keeps its skin, and its steps rise`, { skip: !ready && 'streams not baked here' }, () => {
    const manifest = manifestOf(id), chain = manifest.chain, words = stream(id, 'chain.bin', manifest), floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    const { vertexCount: V, triangleCount: T, stepCount: S, offsets } = chain;
    const record = (v) => words[offsets.records + v], dies = (v) => record(v) & 65535, target = (v) => record(v) >>> 16;
    for (let v = 0; v < V; v++) {
      const w = words[offsets.vertices + v * CREW_CONTINUUM_VERTEX_WORDS + 5];
      assert.equal((w & 255) + ((w >>> 8) & 255) + ((w >>> 16) & 255) + (w >>> 24), 255, `far vertex ${v} weights`);
      if (dies(v) === CREW_CONTINUUM_NEVER) continue;
      assert.ok(dies(v) < S && target(v) < V, `far vertex ${v} record`);
      assert.ok(dies(target(v)) > dies(v), `far vertex ${v} joins a point that is gone before it`);
    }
    // The GPU follows at most 64 hops.
    const ancestor = (v, s) => { let hops = 0; while (dies(v) !== CREW_CONTINUUM_NEVER && dies(v) < s) { v = target(v); assert.ok(++hops <= 64, 'ancestry too deep'); } return v; };
    const step = (s) => ({ alive: words[offsets.steps + s * CREW_CONTINUUM_STEP_WORDS], error: floats[offsets.steps + s * CREW_CONTINUUM_STEP_WORDS + 1], inflate: floats[offsets.steps + s * CREW_CONTINUUM_STEP_WORDS + 2] });
    assert.equal(step(0).alive, T);
    assert.equal(step(S).alive, chain.coreTriangles);
    for (let s = 1; s <= S; s++) {
      assert.ok(step(s).alive <= step(s - 1).alive, `step ${s} gains triangles`);
      assert.ok(step(s).error > step(s - 1).error, `step ${s} error does not rise`);
      assert.ok(step(s).inflate >= 0 && step(s).inflate < 0.3, `step ${s} inflation`);
    }
    assert.ok(Number.isFinite(step(S).error) && step(S).error < 2.5, `last error ${step(S).error}`);
    for (const s of [0, 1, S >> 3, S >> 2, S >> 1, S - 48, S - 8, S - 1, S].filter((x) => x >= 0 && x <= S)) {
      const alive = step(s).alive;
      for (let t = 0; t < T; t++) {
        const corners = [0, 1, 2].map((k) => ancestor(words[offsets.indices + t * 3 + k], s));
        const whole = corners[0] !== corners[1] && corners[1] !== corners[2] && corners[0] !== corners[2];
        assert.equal(whole, t < alive, `step ${s}: triangle ${t} ${t < alive ? 'is gone inside' : 'survives past'} the prefix`);
        if (whole) for (const v of corners) assert.ok(dies(v) === CREW_CONTINUUM_NEVER || dies(v) >= s, `step ${s}: triangle ${t} names a collapsed point`);
      }
    }
    // The base is closed: no edge borders a hole. Where the weld pinched two layers of cloth together an edge may
    // join three faces; those few are counted, and stop collapses there.
    const edges = new Map();
    for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
      const p = words[offsets.indices + t * 3 + k], q = words[offsets.indices + t * 3 + ((k + 1) % 3)], key = Math.min(p, q) * 65536 + Math.max(p, q);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    let open = 0, pinched = 0;
    for (const n of edges.values()) { if (n === 1) open++; if (n > 2) pinched++; }
    assert.equal(open, chain.boundaryEdges); assert.equal(pinched, chain.nonManifoldEdges);
    assert.ok(open <= 32, `${open} edges border a hole`);
    assert.ok(pinched <= edges.size * 0.01, `${pinched} of ${edges.size} edges join more than two faces`);
  });

  test(`${id}: splat, texture and stand-in body match their manifest`, { skip: !ready && 'streams not baked here' }, () => {
    const manifest = manifestOf(id), { splat, texture } = manifest;
    const shares = splat.regions.reduce((s, r) => s + r.share, 0);
    assert.ok(Math.abs(shares - 1) < 0.01, `splat shares sum to ${shares}`);
    assert.ok(splat.rx < splat.ry && splat.ry > 0.6 && splat.ry < 1.1, `splat ${splat.rx} × ${splat.ry}`);
    const levels = texture.levels.reduce((s, l) => s + l.bytes, 0);
    assert.equal(texture.levels.at(-1).width, 1);
    for (const codec of ['albedo.bc7.bin', 'albedo.astc.bin']) assert.equal(stream(id, codec, manifest).byteLength, levels, codec);
    const body = fs.readFileSync(at(CREW_CONTINUUM_ASSETS[id]['body.glb']));
    assert.equal(createHash('sha256').update(body).digest('hex'), manifest.body.sha256);
  });
}
