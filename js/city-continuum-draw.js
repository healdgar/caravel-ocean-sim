// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings as records of the one cut (AGENTS.md rule 3; js/continuum-scene.js). Each building is an instance
// of its type in the city's atlas (js/city-continuum.js), stood and turned where its plan has it at its type's own
// baked size (a family's variants are its sizes: js/old-world-buildings.js cityVariant; nothing is stretched), and worn
// in its own tint by the city's material (js/wgsl/city-continuum.js). The plan is written once; after that only flags
// change.
import { CITY_TYPED_FLOATS } from './old-world-buildings.js';
import { loadCityContinuum } from './city-continuum.js';
import { CONTINUUM_GONE, CONTINUUM_STRUCK, continuumRoom } from './continuum-format.js';
import { CONTINUUM_GROUNDED } from './continuum-ground.js';
import { createContinuumScene, requestContinuumAtlas } from './continuum-scene.js';

if (CITY_TYPED_FLOATS !== 5) throw Error('A city building\'s plan is its place and its tint');

// The city's atlas, fetched and uploaded once a device.
export function requestCityContinuumAtlas(device, fetchAsset = fetch) {
  return requestContinuumAtlas(device, 'city', () => loadCityContinuum({ fetchAsset }));
}

// One city. `typed` and `types` are its plan's (CITY_TYPED_FLOATS a building: x, y, z, yaw and its tint; and its
// type), written once. `atlas` is the city's (requestCityContinuumAtlas); `view` the city material's view
// (js/continuum-scene.js); `grounded` whether each building stands on the land (CONTINUUM_GROUNDED: it is stood on the
// ground the land draws), or none.
export function createCityContinuum({ device, atlas, programs, view = null, typed, types, grounded = null, frame, shadowUniform, samples = 4, label = 'city' }) {
  const count = types.length, counts = new Array(atlas.types.length).fill(0);
  for (let i = 0; i < count; i++) counts[types[i]]++;
  const { room } = continuumRoom(atlas.types, counts);
  const scene = createContinuumScene({ device, atlas, programs, capacity: count, room, view, frame, shadowUniform, samples, label });
  for (let i = 0; i < count; i++) {
    const at = i * CITY_TYPED_FLOATS;
    scene.place(i, { position: [typed[at], typed[at + 1], typed[at + 2]], yaw: typed[at + 3], type: types[i], flags: grounded?.[i] ? CONTINUUM_GROUNDED : 0, identity: typed[at + 4] });
  }
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
