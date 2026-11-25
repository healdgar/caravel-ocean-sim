import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import test from 'node:test';
import {
  CONTINUUM_HEADER, CONTINUUM_STREAMS, CONTINUUM_SURFEL_HEADER_WORDS, checkContinuumAtlas,
} from '../js/continuum-format.js';
import {
  HAIR_BODY_ANCHORS, HAIR_CONTINUUM_ASSETS, HAIR_CONTINUUM_TYPES, appendHairContinuumSurfels, hairContinuumShiftsFor, validateHairContinuumManifest,
} from '../js/hair-continuum.js';
import { HAIR_CONTINUUM_MATERIAL } from '../js/wgsl/crew-continuum.js';
import { CREW_CONTINUUM_BODIES } from '../js/crew-continuum.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';

test('hair continuum manifest and 12 strand grooms pass atlas, skin, and wind verification', () => {
  for (const file of Object.values(HAIR_CONTINUUM_ASSETS)) {
    assert.ok(fs.existsSync(file), `${file} exists`);
  }
  const manifest = validateHairContinuumManifest(JSON.parse(fs.readFileSync(HAIR_CONTINUUM_ASSETS['manifest.json'], 'utf8')));
  assert.equal(manifest.types.length, HAIR_CONTINUUM_TYPES.length);

  const raw = zlib.gunzipSync(fs.readFileSync(HAIR_CONTINUUM_ASSETS['atlas.bin.gz']));
  const words = checkContinuumAtlas(new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), 'hair continuum');
  const H = CONTINUUM_HEADER;
  assert.equal(words[H.typeCount], HAIR_CONTINUUM_TYPES.length);

  const skin = CONTINUUM_STREAMS.find((s) => s.name === 'skin');
  const wind = CONTINUUM_STREAMS.find((s) => s.name === 'wind');
  assert.ok((words[H.streams] & skin.bit) !== 0, 'carries skin stream');
  assert.ok((words[H.streams] & wind.bit) !== 0, 'carries wind stream');

  const V = words[H.vertexCount], skinAt = words[H.skin], windAt = words[H.wind];
  let flexibleVertices = 0;
  for (let v = 0; v < V; v++) {
    const J = words[skinAt + v * 2], W = words[skinAt + v * 2 + 1];
    const w = [0, 8, 16, 24].map((s) => (W >>> s) & 255);
    assert.equal(w[0] + w[1] + w[2] + w[3], 255, `vertex ${v} skin weights sum to 255`);
    assert.ok(w[0] >= w[1] && w[1] >= w[2] && w[2] >= w[3], `vertex ${v} skin weights sorted`);
    for (let k = 0; k < 4; k++) if (w[k]) assert.ok(((J >>> (k * 8)) & 255) < CREW_JOINT_COUNT, `vertex ${v} joint in bounds`);
    if ((words[windAt + v] & 65535) > 0) flexibleVertices++;
  }
  assert.ok(flexibleVertices > V * 0.5, 'free strand vertices carry non-zero wind cantilever flex');

  for (const { id, sex } of CREW_CONTINUUM_BODIES) {
    const shifts = hairContinuumShiftsFor(id, sex === 'female');
    assert.equal(shifts.length, 8);
    assert.equal(shifts[3], sex === 'female' ? 1 : 0);
  }
  assert.deepEqual(HAIR_BODY_ANCHORS['sailor-male'].scalp, [0, 0, 0], 'sailor-male scalp flush at [0,0,0]');
  assert.deepEqual(HAIR_BODY_ANCHORS['villager-female'].scalp, [0, 0, 0], 'villager-female scalp flush at [0,0,0]');

  // Fine mid-range hair surfels: dense (>= 1024 scalp / >= 512 beard) with >= 15 mm scalp handoffError (no 7 m blotches).
  const { words: withSurfels, counts } = appendHairContinuumSurfels(words);
  const surfelBase = withSurfels[H.surfels];
  assert.ok(surfelBase > 0, 'hair surfel section appended');
  const surfelF32 = new Float32Array(withSurfels.buffer, withSurfels.byteOffset, withSurfels.length);
  HAIR_CONTINUUM_TYPES.forEach((spec, ty) => {
    const hAt = surfelBase + ty * CONTINUUM_SURFEL_HEADER_WORDS;
    const sc = withSurfels[hAt + 1];
    const handoffErr = surfelF32[hAt + 3];
    assert.equal(sc, counts[ty]);
    if (spec.slot === 'scalp') {
      assert.ok(sc >= 1536, `${spec.id} scalp surfel count ${sc} >= 1536`);
      assert.ok(handoffErr >= Math.fround(0.015), `${spec.id} scalp handoffError ${handoffErr} >= 0.015 m`);
    } else {
      assert.ok(sc >= 512, `${spec.id} beard surfel count ${sc} >= 512`);
      assert.ok(handoffErr >= Math.fround(0.010), `${spec.id} beard handoffError ${handoffErr} >= 0.010 m`);
    }
  });

  // Fibrous MSAA hair coverage applies across mid/tip ribbon length (zero discard, no flat <0.85 rectangle bypass).
  const hairWgsl = HAIR_CONTINUUM_MATERIAL.wgsl().replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(hairWgsl, /\bdiscard\b/);
  assert.doesNotMatch(hairWgsl, /if\s*\(\s*along\s*<\s*0\.85\s*\)/);
  assert.match(hairWgsl, /continuumSamples\(/);

  const build = fs.readFileSync('build.mjs', 'utf8');
  assert.match(build, /HAIR_CONTINUUM_ASSETS/);
  assert.ok(build.includes("'js/hair-continuum.js'"));
});
