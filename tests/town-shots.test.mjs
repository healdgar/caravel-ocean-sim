// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How long a town is under fire, and how long a hit building is watched, go by the clock and not by frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOWN_WATCH_MS, createTownShots } from '../js/town-shots.js';
import { TOWN_SHOT_LIMIT, TOWN_SHOT_WORDS } from '../js/wgsl/townsfolk.js';
import { computeTownAmbienceState } from '../js/audio.js';

const ball = { velocity: [400, 0, 0], mass: 11, radius: .075 };
const list = () => { const words = new Uint32Array(4 + TOWN_SHOT_LIMIT * TOWN_SHOT_WORDS); return [words, new Float32Array(words.buffer)]; };
const landing = (log) => log.note([0, 5, 0], [3, 5, 0], { fraction: 1, kind: 'terrain' }, { ...ball });

test('a town is under fire for ten seconds after a ball lands in it, however many frames that is', () => {
  let ms = 1000;
  const streets = { window: { x: 0, z: 0, span: 400 } }, log = createTownShots(streets, { now: () => ms }), [words, floats] = list();
  assert.equal(streets.underFireFrames, 0, 'not before anything lands');
  log.note([0, 5, 0], [3, 5, 0], null, { ...ball });
  assert.equal(streets.underFireFrames, 0, 'nor for a ball that only flies over');
  landing(log);
  assert.equal(streets.underFireCount, 1);
  assert.equal(TOWN_WATCH_MS, 10000);
  assert.equal(streets.underFireFrames, 600, 'ten seconds, told as frames at sixty a second');
  // A display drawing 240 frames in a second uses up one second of it, not four.
  for (let frame = 0; frame < 240; frame++) { ms += 1000 / 240; log.collect(words, floats); }
  assert.ok(Math.abs(streets.underFireFrames - 540) <= 1, `${streets.underFireFrames} left after a second at 240 Hz`);
  // Another town's people are drawn instead, and nothing here is collected again: it runs out all the same.
  ms = 1000 + 9900;
  assert.ok(streets.underFireFrames > 0);
  ms = 1000 + 10100;
  assert.equal(streets.underFireFrames, 0, 'over ten seconds on, with no frame of this town drawn');
  // Another ball starts it again.
  landing(log);
  assert.equal(streets.underFireFrames, 600);
  assert.equal(streets.underFireCount, 2);
  assert.equal('lastShotPoint' in streets, false, 'nothing is kept that nothing reads');
});

test('the sound of a town under fire lasts as long as the town says, and stops', () => {
  let ms = 0;
  const port = { x: 40, z: 0, instances: Array.from({ length: 14 }, (_, i) => ({ x: 40 + i * 2, z: 0 })), streets: { people: 30, window: { x: 40, z: 0, span: 120 } } };
  const listener = { x: 0, y: 2, z: 0, rightX: 1, rightZ: 0 }, log = createTownShots(port.streets, { now: () => ms });
  assert.equal(computeTownAmbienceState([port], listener, 25).underFire, false);
  log.note([40, 6, 0], [42, 2, 0], { fraction: 1 }, { mass: 8, velocity: [150, -10, 0] });
  assert.equal(computeTownAmbienceState([port], listener, 25).underFire, true);
  ms = 9000;
  assert.equal(computeTownAmbienceState([port], listener, 25).underFire, true);
  ms = 10500;
  assert.equal(computeTownAmbienceState([port], listener, 25).underFire, false, 'with no frame of the town drawn in between');
});

test('a hit building is watched for what it lets fall for ten seconds after it last lost anything', () => {
  let ms = 0;
  const log = createTownShots({ window: { x: 0, z: 0, span: 400 } }, { now: () => ms }), [words, floats] = list();
  const building = { x: 0, y: 0, z: 0, damageState: { fracture: { brokenCount: 0, flying: new Set([0]), fracture: { shards: [{ localMin: [1, 1, 1], localMax: [3, 3, 3] }], toWorld: (x, y, z) => [x, y, z], groundAt: () => 0 } } } };
  const state = building.damageState.fracture;
  log.note([0, 1, 0], [1, 1, 0], { fraction: 1, kind: 'building', building }, { ...ball });
  log.collect(words, floats);
  // A thousand frames inside one second do not use the watch up.
  for (let frame = 0; frame < 1000; frame++) { ms += 1; assert.equal(log.collect(words, floats), 0); }
  state.brokenCount = 5;
  assert.equal(log.collect(words, floats), 1, 'rubble coming down a second after the hit is told to the people');
  // Each fall keeps it watched a while longer.
  ms += 9000; state.brokenCount = 9;
  assert.equal(log.collect(words, floats), 1);
  ms += 9000; state.brokenCount = 12;
  assert.equal(log.collect(words, floats), 1);
  // Left alone for longer than that, it is no longer looked at.
  ms += TOWN_WATCH_MS + 1;
  assert.equal(log.collect(words, floats), 0);
  state.brokenCount = 30;
  assert.equal(log.collect(words, floats), 0, 'what falls long afterwards is not this bombardment');
});
