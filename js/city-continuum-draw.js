// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings, or a coast's prefabs, as records of the one cut (AGENTS.md rule 3; js/continuum-scene.js). Each
// building is an instance of its type in the city's atlas (js/city-continuum.js), stood and turned where its plan has
// it, stretched along its type's axes (a fence sheared along its slope) by a pose of its own, and worn in its own tint
// by the city's material (js/wgsl/city-continuum.js). The plan is written once; after that only flags change.
import { CITY_TYPED_FLOATS } from './old-world-buildings.js';
import { loadCityContinuum } from './city-continuum.js';
import { CONTINUUM_GONE, CONTINUUM_STRUCK, CONTINUUM_STRETCHED, continuumRoom } from './continuum-format.js';
import { CONTINUUM_GROUNDED } from './continuum-ground.js';
import { createContinuumScene, requestContinuumAtlas } from './continuum-scene.js';

if (CITY_TYPED_FLOATS !== 8) throw Error('A city building\'s plan is its place, its stretch and its tint');

// The city's atlas, fetched and uploaded once a device.
export function requestCityContinuumAtlas(device, fetchAsset = fetch) {
  return requestContinuumAtlas(device, 'city', () => loadCityContinuum({ fetchAsset }));
}

// A fence's slope along its length, from its tint word (-150 to -50 holds it, plus 100); 0 for every other building.
const citySlope = (tint) => (tint < -50 && tint > -150 ? Math.max(-0.95, Math.min(0.95, tint + 100)) : 0);

// One city, or a coast's prefabs. `typed` and `types` are its plan's (CITY_TYPED_FLOATS a building: x, y, z, yaw, its
// stretch along x, y and z, and its tint; and its type), written once. `atlas` is the city's (requestCityContinuumAtlas)
// or a coast's prefab bodies' ({ buffer, types }); `view` the city material's view (js/continuum-scene.js); `grounded`
// whether each building stands on the land (CONTINUUM_GROUNDED: it is stood on the ground the land draws), or none.
export function createCityContinuum({ device, atlas, programs, view = null, typed, types, grounded = null, frame, shadowUniform, samples = 4, label = 'city' }) {
  const count = types.length, counts = new Array(atlas.types.length).fill(0);
  for (let i = 0; i < count; i++) counts[types[i]]++;
  const { room } = continuumRoom(atlas.types, counts);
  const scene = createContinuumScene({ device, atlas, programs, capacity: count, room, view, poseRoom: count, frame, shadowUniform, samples, label });
  const stretches = new Float32Array(Math.max(1, count) * 4);
  for (let i = 0; i < count; i++) {
    const at = i * CITY_TYPED_FLOATS, tint = typed[at + 7];
    stretches.set([typed[at + 4], typed[at + 5], typed[at + 6], citySlope(tint)], i * 4);
    scene.place(i, { position: [typed[at], typed[at + 1], typed[at + 2]], yaw: typed[at + 3], type: types[i], flags: CONTINUUM_STRETCHED | (grounded?.[i] ? CONTINUUM_GROUNDED : 0), pose: i, identity: tint });
  }
  scene.writePoses(0, stretches);
  scene.send(0, count);
  scene.setCount(count);
  return Object.assign(scene, {
    // Buildings `index`..`index + n` hidden while they stand as pieces, or shown again.
    hide(index, n = 1, hidden = true) { scene.flag(index, n, CONTINUUM_GONE, hidden); },
    hidden(index) { return scene.flagged(index, CONTINUUM_GONE); },
    // Buildings `index`..`index + n` struck, so cut finer; or stood again.
    strike(index, n = 1, struck = true) { scene.flag(index, n, CONTINUUM_STRUCK, struck); },
    struck(index) { return scene.flagged(index, CONTINUUM_STRUCK); },
  });
}
