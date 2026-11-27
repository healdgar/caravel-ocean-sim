// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What grows on worked ground and lies under trees (js/meadow-crops.js): each furlong's crop set out to its own
// figure, the litter under each tree by its kind, and the crops and litter following the year.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEADOW_GROUND, MEADOW_LITTER, MEADOW_GROUND_EDGE_STEP, MEADOW_SHAPE, bakeMeadowGroundFields, layMeadowLitter, meadowCropMixes,
  meadowLitterMixes, meadowGrowthDay, meadowTreesSignature,
} from '../js/meadow-crops.js';
import { OLD_WORLD_LAND } from '../js/old-world.js';

const region = { x: 0, z: 0, span: 256 };
const square = (x0, z0, x1, z1) => new Float64Array([x0, z0, x1, z0, x1, z1, x0, z1]);

test('a furlong\'s crop is set out to its figure, how far inside it each point lies, and the way its strips run', () => {
  const board = {
    size: 32, span: 256, origin: { x: 0, z: 0 }, index: new Uint16Array(32 * 32).fill(1),
    uses: [{ kind: OLD_WORLD_LAND.VINES, wild: false, heading: Math.PI / 4 }, { kind: OLD_WORLD_LAND.PASTURE, wild: false }],
    figures: [square(-40, -40, 40, 40), square(50, 50, 90, 90)],
  };
  const size = 256, map = bakeMeadowGroundFields({ region, board, size });
  const at = (x, z) => (Math.floor((z + 128) / (256 / size)) * size + Math.floor((x + 128) / (256 / size))) * 4;
  assert.equal(map[at(0, 0)] & 15, MEADOW_GROUND.VINES);
  assert.ok(Math.abs(map[at(0, 0) + 1] * MEADOW_GROUND_EDGE_STEP - 12.75) < 0.1, 'deep inside, as far as a step holds');
  assert.ok(Math.abs(map[at(37.5, 0) + 1] * MEADOW_GROUND_EDGE_STEP - 2) < 0.6, 'two metres from its side');
  assert.equal(map[at(45, 0)] & 15, MEADOW_GROUND.NONE, 'nothing outside its figure');
  assert.equal(map[at(70, 70)] & 15, MEADOW_GROUND.NONE, 'pasture is the meadow\'s, not a crop');
  assert.ok(Math.abs(map[at(0, 0) + 2] / 255 - 0.25) < 0.01, 'its strips run its way');
  // On a hot coast, a vineyard is a garden.
  assert.equal(bakeMeadowGroundFields({ region, board, size, tropical: true })[at(0, 0)] & 15, MEADOW_GROUND.GARDEN);
  // A wood-cleared corner of the index is not sown.
  const cleared = { ...board, index: board.index.slice() };
  cleared.index[16 * 32 + 16] = 0;
  const left = bakeMeadowGroundFields({ region, board: cleared, size });
  assert.equal(left[at(4, 4)] & 15, MEADOW_GROUND.NONE);
  assert.equal(left[at(-4, -4)] & 15, MEADOW_GROUND.VINES);
});

test('litter lies under each tree as wide as its crown, of its kind, and the kind holds a step past where it fades', () => {
  const map = new Uint8Array(256 * 256 * 4);
  const trees = {
    prototypes: [{ species: 'oak', crownRadius: 8 }, { species: 'palm', crownRadius: 4 }],
    sections: [{ parts: [new Float32Array([0, 5, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 60, 5, 60, 1, 0, 1, 1, 1, 1, 0, 2, 0, 100, -500, 100, 1, 0, 1, 1, 1, 0, 0, -2, 0])] }],
  };
  const laid = layMeadowLitter(map, { region, size: 256, trees });
  assert.ok(laid > 0);
  const at = (x, z) => ((z + 128) * 256 + (x + 128)) * 4;
  assert.equal(map[at(0, 0)] >> 4, MEADOW_LITTER.oak);
  assert.ok(map[at(0, 0) + 3] > 200, 'thickest under the crown');
  assert.equal(map[at(0, 12) + 3], 0, 'none past the crown');
  assert.equal(map[at(60, 60)] >> 4, MEADOW_LITTER.palm);
  assert.ok(map[at(60, 60) + 3] < map[at(0, 0) + 3], 'a palm drops less');
  assert.equal(map[at(100, 100) + 3], 0, 'a root below the land drops nothing');
  assert.equal(meadowTreesSignature(region, trees), meadowTreesSignature(region, { ...trees }));
});

test('the corn is sown in autumn, heads in spring, ripens and is reaped in summer; deciduous litter falls in autumn', () => {
  const wheat = (day) => meadowCropMixes(day)[MEADOW_GROUND.WHEAT - 1];
  const tallest = (mix) => Math.max(...mix.species.map((s) => s.height));
  assert.ok(tallest(wheat(30)) < 0.4, 'winter: young blades');
  assert.ok(tallest(wheat(150)) > 0.9, 'late May: full height');
  assert.ok(wheat(150).species[0].head > 0.5, 'late May: in ear');
  assert.ok(wheat(170).species[0].tip[0] > 0.3, 'June: ripe gold');
  assert.ok(wheat(230).species[0].height < 0.3, 'August: stubble');
  assert.ok(wheat(300).density < 0.1, 'late October: ploughed for sowing');
  assert.ok(wheat(325).species[0].height < 0.1, 'late November: just up');
  for (const day of [0, 100, 200, 300]) {
    for (const mix of [...meadowCropMixes(day), ...meadowLitterMixes(day)]) {
      assert.ok(Math.abs(mix.species.reduce((n, s) => n + s.share, 0) - 1) < 1e-6, 'a mix\'s shares make the whole');
    }
  }
  const oak = (day) => meadowLitterMixes(day)[MEADOW_LITTER.oak];
  assert.ok(oak(320).species[0].share > oak(200).species[0].share, 'fresh leaves in autumn');
  assert.ok(oak(320).species.every((s) => s.shape >= MEADOW_SHAPE.OVAL), 'litter lies on the ground');
  assert.equal(meadowGrowthDay(Date.UTC(1550, 3, 1), 38.7), 90);
  assert.equal(meadowGrowthDay(Date.UTC(1550, 3, 1), -20), 272, 'south of the line the year turns half round');
});
