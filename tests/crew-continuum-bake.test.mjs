// The people continuum's bake (scripts/prepare-crew-continuum.mjs): its files, and each guarantee the one cut leans on,
// checked on every body baked in this checkout. Manifests are in git; the streams are not, and a body whose streams are
// absent is skipped (bake them with `node scripts/prepare-crew-continuum.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { CREW_JOINT_NAMES, CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import { CONTINUUM_HOPS, CONTINUUM_STEP_WORDS } from '../js/continuum-core.js';
import {
  CONTINUUM_CLUSTER_WORDS, CONTINUUM_HEADER, CONTINUUM_NEVER, CONTINUUM_STREAMS, CONTINUUM_TYPE, CONTINUUM_TRIANGLE_WORDS,
  checkContinuumAtlas,
} from '../js/continuum-format.js';
import {
  CREW_CONTINUUM_ASSETS, CREW_CONTINUUM_BODIES, CREW_CONTINUUM_JOINT_PIECE, CREW_CONTINUUM_MOBILE_ASSETS, CREW_CONTINUUM_PIECES, CREW_CONTINUUM_REGIONS, CREW_CONTINUUM_STREAMS,
  crewContinuumRig, crewContinuumWear, CREW_CONTINUUM_RIG_VEC4S, CREW_CONTINUUM_WEAR_VEC4S, validateCrewContinuumManifest,
} from '../js/crew-continuum.js';
import { CREW_CONTINUUM_MATERIAL, CREW_STAND_FLAG_CLOTHED, crewContinuumStandWGSL } from '../js/wgsl/crew-continuum.js';
import { createCrewContinuumBatch, loadCrewContinuumBody, requestCrewContinuumPipelines } from '../js/crew-continuum-draw.js';
import { crewContinuumDevice, crewContinuumGlobals, fetchCrewContinuumAsset } from './helpers/crew-continuum-fixture.mjs';

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
  return bytes;
}
const wordsOf = (bytes) => new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);

test('every body\'s every file is named, spelled out where the build finds and publishes it', () => {
  const files = ['manifest.json', 'body.glb', ...CREW_CONTINUUM_STREAMS.map((name) => `${name}.gz`)];
  assert.deepEqual(Object.keys(CREW_CONTINUUM_ASSETS), CREW_CONTINUUM_BODIES.map(({ id }) => id));
  for (const { id } of CREW_CONTINUUM_BODIES) assert.deepEqual(CREW_CONTINUUM_ASSETS[id], Object.fromEntries(files.map((file) => [file, `assets/crew/continuum/${id}/${file}`])));
  // build.mjs rewrites only quoted asset paths (to versioned published copies); a composed path would go unpublished.
  const source = fs.readFileSync(new URL('../js/crew-continuum.js', import.meta.url), 'utf8');
  for (const paths of Object.values(CREW_CONTINUUM_ASSETS)) for (const path of Object.values(paths)) assert.ok(source.includes(`'${path}'`), path);
});

test('a joint falls in the piece a ball takes off with it', () => {
  const piece = (name) => CREW_CONTINUUM_PIECES[CREW_CONTINUUM_JOINT_PIECE[CREW_JOINT_NAMES.indexOf(name)]];
  for (const [joint, expected] of [['pelvis', 'pelvis'], ['spine_01', 'pelvis'], ['spine_03', 'spine_03'], ['clavicle_l', 'clavicle_l'], ['neck_01', 'neck_01'], ['head', 'head'],
    ['upperarm_l', 'upperarm_l'], ['hand_l', 'hand_l'], ['lowerarm_r', 'lowerarm_r'], ['thigh_r', 'thigh_r'], ['foot_r', 'foot_r'], ['ball_l', 'foot_l']]) {
    assert.equal(piece(joint), expected, joint);
  }
  assert.equal(CREW_CONTINUUM_JOINT_PIECE.length, CREW_JOINT_COUNT);
});

test('every baked body\'s manifest is whole, its rig and wear fill their tables, and a damaged one is refused', { skip: !baked.length && 'no crew continuum bakes here' }, () => {
  for (const { id, sex, role } of baked) {
    const manifest = validateCrewContinuumManifest(manifestOf(id));
    assert.equal(manifest.sex, sex);
    assert.equal(manifest.role, role);
    assert.deepEqual(manifest.pieces, CREW_CONTINUUM_PIECES);
    assert.deepEqual(manifest.regions, CREW_CONTINUUM_REGIONS);
    // Each piece rides the joint its points weigh on most: one of the piece's own.
    assert.equal(manifest.rig.leads.length, CREW_CONTINUUM_PIECES.length);
    manifest.rig.leads.forEach((lead, p) => assert.equal(CREW_CONTINUUM_JOINT_PIECE[CREW_JOINT_NAMES.indexOf(lead)], p, `${id} ${CREW_CONTINUUM_PIECES[p]} rides ${lead}`));
    // The pose slack bounds every piece's, and stays within half a metre of the joints: limbs are never culled wrongly.
    assert.ok(manifest.rig.slack >= Math.max(...Object.values(manifest.rig.pieceSlack)) && manifest.rig.slack < 0.7, `${id} slack ${manifest.rig.slack}`);
    assert.equal(crewContinuumRig(manifest).length, CREW_CONTINUUM_RIG_VEC4S * 4);
    assert.equal(crewContinuumWear(manifest).length, CREW_CONTINUUM_WEAR_VEC4S * 4);
    // The far end of the chain is a core of a few triangles (AGENTS.md rule 3.3).
    assert.ok(manifest.chain.coreTriangles <= 8, `${id} far body ends at ${manifest.chain.coreTriangles} triangles`);
    assert.equal(manifest.clusters.finestTriangles, manifest.source.triangles, `${id} the finest cut is the whole fitted body`);
    for (const [where, drift] of Object.entries(manifest.body.contactDrift)) assert.ok(Math.abs(drift) < 0.01, `${id} ${where} drifts ${drift} m`);
    for (const damage of [(m) => { m.version++; }, (m) => { m.id = 'nobody'; }, (m) => { m.atlas.bytes += 4; }, (m) => { delete m.files['atlas.bin'].sha256; }, (m) => { m.splat.regions.pop(); }, (m) => { m.rig.spheres.pop(); }]) {
      const copy = structuredClone(manifest);
      damage(copy);
      assert.throws(() => validateCrewContinuumManifest(copy));
    }
  }
});

for (const { id } of CREW_CONTINUUM_BODIES) {
  const ready = streamed.some((b) => b.id === id);
  test(`${id}: one type of the one format, its clusters riding their pieces' joints, every point wearing its skin`, { skip: !ready && 'streams not baked here' }, () => {
    const manifest = manifestOf(id), words = checkContinuumAtlas(wordsOf(stream(id, 'atlas.bin', manifest)), id), floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE;
    assert.equal(words[H.typeCount], 1);
    const type = words[H.typesAt], skin = CONTINUUM_STREAMS.find((s) => s.name === 'skin'), uv = CONTINUUM_STREAMS.find((s) => s.name === 'uv');
    assert.ok(words[H.streams] & skin.bit && words[H.streams] & uv.bit, `${id} carries skin and picture places`);
    // Every point's skin: four joints of the rig, four weights summing to one, strongest first.
    const V = words[H.vertexCount], skinAt = words[H.skin];
    for (let v = 0; v < V; v++) {
      const J = words[skinAt + v * 2], W = words[skinAt + v * 2 + 1], w = [0, 8, 16, 24].map((s) => (W >>> s) & 255);
      assert.equal(w[0] + w[1] + w[2] + w[3], 255, `${id} point ${v} weights`);
      assert.ok(w[0] >= w[1] && w[1] >= w[2] && w[2] >= w[3], `${id} point ${v} strongest first`);
      for (let k = 0; k < 4; k++) if (w[k]) assert.ok(((J >>> (k * 8)) & 255) < CREW_JOINT_COUNT, `${id} point ${v} joint`);
    }
    // Clusters: coarsest parent first, each finer than its parent, each riding its piece's lead joint; the finest
    // level is the whole fitted body.
    const C = words[type + T.clusterCount], leads = new Set(manifest.rig.leads.map((name) => CREW_JOINT_NAMES.indexOf(name)));
    assert.equal(C, manifest.clusters.count);
    let previous = Infinity, finest = 0, roots = 0;
    for (let k = 0; k < C; k++) {
      const o = words[H.clustersAt] + (words[type + T.clusterFirst] + k) * CONTINUUM_CLUSTER_WORDS, error = floats[o + 12], parentError = floats[o + 13];
      const triangles = words[o + 15] & 255, level = (words[o + 15] >>> 8) & 255, part = words[o + 15] >>> 16;
      assert.ok(error >= 0 && error <= parentError, `${id} cluster ${k}: error ${error} above its parent's ${parentError}`);
      assert.ok(parentError <= previous, `${id} cluster ${k} is out of order`);
      previous = parentError;
      assert.ok(leads.has(part), `${id} cluster ${k} rides joint ${part}, no piece's lead`);
      for (const s of [3, 7, 11]) assert.ok(floats[o + s] > 0, `${id} cluster ${k} sphere`);
      if (level === 0) finest += triangles;
      if (parentError >= 1e30) roots++;
    }
    assert.equal(finest, manifest.source.triangles, `${id} the finest cut is the whole fitted body`);
    assert.equal(roots, manifest.clusters.roots);
  });

  test(`${id}: the far body collapses as a prefix to its core, and its steps rise`, { skip: !ready && 'streams not baked here' }, () => {
    const manifest = manifestOf(id), words = wordsOf(stream(id, 'atlas.bin', manifest)), floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE, type = words[H.typesAt];
    const V = words[type + T.chainVertexCount], S = words[type + T.stepCount], records = words[type + T.records], trianglesAt = words[type + T.triangles], stepsAt = words[type + T.steps];
    assert.equal(S, manifest.chain.steps);
    const dies = (v) => words[records + v] & 65535, target = (v) => words[records + v] >>> 16;
    for (let v = 0; v < V; v++) {
      if (dies(v) === CONTINUUM_NEVER) continue;
      assert.ok(dies(v) < S && target(v) < V, `${id} far point ${v} record`);
      assert.ok(dies(target(v)) > dies(v), `${id} far point ${v} joins a point that is gone before it`);
    }
    // The cut follows at most CONTINUUM_HOPS hops.
    const ancestor = (v, s) => { let hops = 0; while (dies(v) !== CONTINUUM_NEVER && dies(v) < s) { v = target(v); assert.ok(++hops <= CONTINUUM_HOPS, 'ancestry too deep'); } return v; };
    const step = (s) => ({ alive: words[stepsAt + s * CONTINUUM_STEP_WORDS], error: floats[stepsAt + s * CONTINUUM_STEP_WORDS + 1], inflate: floats[stepsAt + s * CONTINUUM_STEP_WORDS + 2] });
    const triangles = step(0).alive;
    assert.equal(triangles, manifest.chain.baseTriangles);
    assert.equal(step(S).alive, manifest.chain.coreTriangles);
    for (let s = 1; s <= S; s++) {
      assert.ok(step(s).alive <= step(s - 1).alive, `${id} step ${s} gains triangles`);
      assert.ok(step(s).error >= step(s - 1).error, `${id} step ${s} error falls`);
      assert.ok(step(s).inflate >= 0 && Number.isFinite(step(s).inflate), `${id} step ${s} inflation`);
    }
    for (const s of [0, 1, S >> 2, S >> 1, S - 8, S - 1, S].filter((x) => x >= 0 && x <= S)) {
      const alive = step(s).alive, deadFaces = new Map();
      for (let t = alive; t < triangles; t++) {
        const corners = [0, 1, 2].map((k) => ancestor(words[trianglesAt + t * CONTINUUM_TRIANGLE_WORDS + k], s));
        if (corners[0] !== corners[1] && corners[1] !== corners[2] && corners[0] !== corners[2]) {
          const key = corners.slice().sort((a, b) => a - b).join(',');
          deadFaces.set(key, (deadFaces.get(key) ?? 0) + 1);
        }
      }
      for (let t = 0; t < triangles; t++) {
        const corners = [0, 1, 2].map((k) => ancestor(words[trianglesAt + t * CONTINUUM_TRIANGLE_WORDS + k], s));
        const whole = corners[0] !== corners[1] && corners[1] !== corners[2] && corners[0] !== corners[2];
        if (t < alive) {
          assert.equal(whole, true, `${id} step ${s}: triangle ${t} is gone inside the prefix`);
        } else if (whole) {
          const key = corners.slice().sort((a, b) => a - b).join(',');
          assert.equal((deadFaces.get(key) ?? 0) % 2, 0, `${id} step ${s}: triangle ${t} survives past the prefix without a cancelling twin`);
        }
      }
    }
  });

  test(`${id}: splat, picture and light mesh match their manifest`, { skip: !ready && 'streams not baked here' }, () => {
    const manifest = manifestOf(id), { splat, texture } = manifest;
    const shares = splat.regions.reduce((s, r) => s + r.share, 0);
    assert.ok(Math.abs(shares - 1) < 0.01, `${id} splat shares sum to ${shares}`);
    assert.ok(splat.rx < splat.ry && splat.ry > 0.6 && splat.ry < 1.1, `${id} splat ${splat.rx} × ${splat.ry}`);
    const levels = texture.levels.reduce((s, l) => s + l.bytes, 0);
    assert.equal(texture.levels.at(-1).width, 1);
    for (const codec of ['albedo.bc7.bin', 'albedo.astc.bin']) assert.equal(stream(id, codec, manifest).byteLength, levels, codec);
    const body = fs.readFileSync(at(CREW_CONTINUUM_ASSETS[id]['body.glb']));
    assert.equal(createHash('sha256').update(body).digest('hex'), manifest.body.sha256);
  });
}

test('all 12 restored bodies are unique ~1.9M-triangle dressed historical meshes with compact mobile fallbacks', { skip: streamed.length < 12 && 'all 12 crew bodies not baked here' }, () => {
  const source = fs.readFileSync(new URL('../js/crew-continuum.js', import.meta.url), 'utf8');
  const sourceShas = new Set();
  for (const { id } of CREW_CONTINUUM_BODIES) {
    const manifest = manifestOf(id);
    sourceShas.add(manifest.source.sha256);
    assert.ok(manifest.source.triangles > 1_500_000, `${id} has ${manifest.source.triangles} triangles`);
    assert.ok(manifest.regionMedians[1] && manifest.regionMedians[2], `${id} carries baked shirt and trousers regions`);

    const mobilePaths = CREW_CONTINUUM_MOBILE_ASSETS[id];
    for (const file of Object.values(mobilePaths)) assert.ok(source.includes(`'${file}'`), `mobile path quoted: ${file}`);
    assert.ok(exists(mobilePaths['manifest.json']), `${id} mobile manifest exists`);
    const mobileManifest = validateCrewContinuumManifest(JSON.parse(fs.readFileSync(at(mobilePaths['manifest.json']), 'utf8')));
    assert.ok(mobileManifest.atlas.bytes < 4 * 1024 * 1024, `${id} mobile atlas ${mobileManifest.atlas.bytes} B < 4 MiB`);
    assert.ok(mobileManifest.texture.width <= 1024, `${id} mobile texture ${mobileManifest.texture.width} <= 1024`);
    assert.ok(mobileManifest.clusters.finestTriangles >= 20000 && mobileManifest.clusters.finestTriangles <= 60000, `${id} mobile tris ${mobileManifest.clusters.finestTriangles}`);

    const mGz = fs.readFileSync(at(mobilePaths['atlas.bin.gz']));
    assert.equal(createHash('sha256').update(mGz).digest('hex'), mobileManifest.files['atlas.bin'].gzip.sha256);
    const mRaw = zlib.gunzipSync(mGz);
    assert.equal(createHash('sha256').update(mRaw).digest('hex'), mobileManifest.files['atlas.bin'].sha256);
    const words = checkContinuumAtlas(wordsOf(mRaw), `${id} mobile`);
    const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE, tb = words[H.typesAt];
    const C = words[tb + T.clusterCount];
    let prevPErr = Infinity;
    for (let k = 0; k < C; k++) {
      const o = words[H.clustersAt] + (words[tb + T.clusterFirst] + k) * CONTINUUM_CLUSTER_WORDS;
      const err = floats[o + 12], pErr = floats[o + 13], lvl = (words[o + 15] >>> 8) & 255;
      assert.ok(err >= 0 && err <= pErr, `${id} mobile cluster ${k} error order`);
      assert.ok(pErr <= prevPErr, `${id} mobile cluster ${k} parentError order`);
      if (lvl === 0) assert.equal(err, 0, `${id} mobile L0 cluster ${k} ownErr === 0`);
      prevPErr = pErr;
    }
    for (const codec of ['albedo.bc7.bin', 'albedo.astc.bin']) {
      const tGz = fs.readFileSync(at(mobilePaths[`${codec}.gz`]));
      assert.equal(createHash('sha256').update(tGz).digest('hex'), mobileManifest.files[codec].gzip.sha256);
      const tRaw = zlib.gunzipSync(tGz);
      assert.equal(createHash('sha256').update(tRaw).digest('hex'), mobileManifest.files[codec].sha256);
    }
  }
  assert.equal(sourceShas.size, CREW_CONTINUUM_BODIES.length, 'all 12 bodies have unique source GLB hashes');
});

test('crew stand gates body inset on CREW_STAND_FLAG_CLOTHED, exposes aux load errors, and verifies SHA-256 by default', { skip: !exists(CREW_CONTINUUM_ASSETS['sailor-male']['atlas.bin.gz']) && 'streams not baked here' }, async (t) => {
  crewContinuumGlobals(t);
  const standWgsl = crewContinuumStandWGSL(false);
  assert.match(standWgsl, /crewStandRun\.flags\s*&\s*4u/, 'body inset bit gated on CREW_STAND_FLAG_CLOTHED (4u)');
  assert.match(CREW_CONTINUUM_MATERIAL.wgsl(), /let\s+isEye\s*=\s*!hasBakedCloth/, 'eyeball UV clamp gated off on dressed bodies');

  const writes = [];
  const makeMockDevice = (limits = {}) => crewContinuumDevice({
    limits,
    createBuffer: (d) => ({ ...d, destroy() {} }),
    createBindGroup: (d) => ({ ...d }),
    createShaderModule: (d) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async (d) => ({ ...d, getBindGroupLayout: () => ({}) }),
    createRenderPipelineAsync: async (d) => ({ ...d, getBindGroupLayout: () => ({}) }),
    queue: {
      writeBuffer(buf, off, data) { writes.push({ label: buf.label, off, words: new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4)).slice() }); },
    },
  });

  // 1. Failing hair/clothing fetch must NOT fail silently: must expose hairError/clothingError and record to __waterworldAssetErrors.
  const devErr = makeMockDevice();
  const prevErrors = globalThis.__waterworldAssetErrors;
  const origConsoleError = console.error;
  const logged = [];
  globalThis.__waterworldAssetErrors = [];
  console.error = (...args) => logged.push(args.join(' '));
  let Pfail;
  try {
    Pfail = await requestCrewContinuumPipelines({
      device: devErr,
      shader: async (code) => ({ code }),
      fetchAsset: async () => new Response(null, { status: 404 }),
    });
  } finally {
    console.error = origConsoleError;
  }
  assert.equal(Pfail.hair, null);
  assert.equal(Pfail.clothing, null);
  assert.ok(Pfail.hairError instanceof Error, 'hairError exposed');
  assert.ok(Pfail.clothingError instanceof Error, 'clothingError exposed');
  assert.ok(logged.length >= 2, 'errors logged via console.error');
  assert.ok(globalThis.__waterworldAssetErrors.length >= 2, 'errors recorded on globalThis.__waterworldAssetErrors');
  globalThis.__waterworldAssetErrors = prevErrors;

  // 2. Dressed body never attaches modular clothingScene and never sets CREW_STAND_FLAG_CLOTHED (4).
  const devDressed = makeMockDevice();
  const dressedBody = await loadCrewContinuumBody(devDressed, 'sailor-male', { fetchAsset: fetchCrewContinuumAsset, mobile: true });
  assert.equal(dressedBody.mobile, true, 'compact mobile pack loaded when mobile=true');
  const PfakeCloth = {
    ...Pfail,
    clothing: { atlas: dressedBody.atlas, types: dressedBody.types },
  };
  writes.length = 0;
  const batchDressed = createCrewContinuumBatch({
    device: devDressed, pipelines: PfakeCloth, body: dressedBody, capacity: 2,
    frame: {}, hull: {}, bones: {}, actor: {}, main: [], shadows: { uniform: {}, bind: () => ({}) },
  });
  assert.equal(batchDressed.clothingScene, null, 'dressed body skips modular clothingScene');
  batchDressed.update([{}]);
  const dressedStand = writes.findLast((w) => w.label === 'crew continuum sailor-male stand');
  assert.equal((dressedStand.words[3] & CREW_STAND_FLAG_CLOTHED), 0, 'CREW_STAND_FLAG_CLOTHED clear on dressed body');

  // 3. Undressed body whose clothing failed to load also leaves CREW_STAND_FLAG_CLOTHED clear (never shrinks body!).
  const undressedBody = { ...dressedBody, manifest: { ...dressedBody.manifest, regionMedians: [dressedBody.manifest.regionMedians[0], null, null, dressedBody.manifest.regionMedians[3], null] } };
  writes.length = 0;
  const batchNakedFail = createCrewContinuumBatch({
    device: devDressed, pipelines: Pfail, body: undressedBody, capacity: 2,
    frame: {}, hull: {}, bones: {}, actor: {}, main: [], shadows: { uniform: {}, bind: () => ({}) },
  });
  assert.equal(batchNakedFail.clothingScene, null);
  batchNakedFail.update([{}]);
  const nakedStand = writes.findLast((w) => w.label === 'crew continuum sailor-male stand');
  assert.equal((nakedStand.words[3] & CREW_STAND_FLAG_CLOTHED), 0, 'CREW_STAND_FLAG_CLOTHED clear when clothing failed');

  // 4. Undressed body WITH loaded clothing DOES attach clothingScene and sets CREW_STAND_FLAG_CLOTHED (4).
  writes.length = 0;
  const batchClothed = createCrewContinuumBatch({
    device: devDressed, pipelines: PfakeCloth, body: undressedBody, capacity: 2,
    frame: {}, hull: {}, bones: {}, actor: {}, main: [], shadows: { uniform: {}, bind: () => ({}) },
  });
  assert.ok(batchClothed.clothingScene != null);
  batchClothed.update([{}]);
  const clothedStand = writes.findLast((w) => w.label === 'crew continuum sailor-male stand');
  assert.equal((clothedStand.words[3] & CREW_STAND_FLAG_CLOTHED), CREW_STAND_FLAG_CLOTHED, 'CREW_STAND_FLAG_CLOTHED set when modular clothing active');

  // 5. SHA-256 verification rejects tampered compressed stream by default.
  const devTamper = makeMockDevice();
  const tamperedFetch = async (url, init) => {
    const res = await fetchCrewContinuumAsset(url, init);
    if (init?.method === 'HEAD' || !url.endsWith('albedo.bc7.bin.gz')) return res;
    const raw = Buffer.from(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
    raw[0] ^= 0xff;
    return new Response(zlib.gzipSync(raw));
  };
  await assert.rejects(
    loadCrewContinuumBody(devTamper, 'sailor-male', { fetchAsset: tamperedFetch, mobile: true }),
    /failed verification/,
    'tampered stream rejected by default SHA-256 check',
  );
  const devOptOut = makeMockDevice();
  const loadedOptOut = await loadCrewContinuumBody(devOptOut, 'sailor-male', { fetchAsset: tamperedFetch, mobile: true, verifySha256: false });
  assert.equal(loadedOptOut.id, 'sailor-male', 'explicit verifySha256: false opts out cleanly');
});
