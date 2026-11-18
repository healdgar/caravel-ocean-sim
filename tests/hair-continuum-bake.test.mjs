import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import test from 'node:test';
import {
  CONTINUUM_HEADER, CONTINUUM_STREAMS, checkContinuumAtlas,
} from '../js/continuum-format.js';
import {
  HAIR_CONTINUUM_ASSETS, HAIR_CONTINUUM_TYPES, hairContinuumShiftsFor, validateHairContinuumManifest,
} from '../js/hair-continuum.js';
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

  const build = fs.readFileSync('build.mjs', 'utf8');
  assert.match(build, /HAIR_CONTINUUM_ASSETS/);
  assert.ok(build.includes("'js/hair-continuum.js'"));
});
