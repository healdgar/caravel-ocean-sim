// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal family's way into the one cut (js/continuum-scene.js): the animal atlas with its rigs, and a scene of
// it. The herds (js/herds.js) and the sea's animals (js/dolphins.js, js/marine-life.js) each stand their records and
// write their joints in a compute pass of their own; the select, the shadow and the view are the one cut's.
import { requestOnce } from './gpu-program-cache.js';
import { ANIMAL_POSE_VEC4S, animalRigTable, loadAnimalContinuum } from './animal-continuum.js';
import { continuumRoom } from './continuum-format.js';
import { requestContinuumAtlas, createContinuumScene } from './continuum-scene.js';

// The animal atlas, once a device, with every type's rig (js/animal-continuum.js animalRigTable) in a uniform buffer for
// the passes that write their joints.
export function requestAnimalContinuumAtlas(device) {
  return requestOnce(device, 'animal continuum atlas and rigs', async () => {
    const atlas = await requestContinuumAtlas(device, 'animal', () => loadAnimalContinuum());
    const table = animalRigTable(atlas.manifest);
    const rig = device.createBuffer({ label: 'animal rigs', size: table.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(rig, 0, table);
    return { ...atlas, rig };
  });
}

// A scene of the one cut for `count` animals, each of any of `types`: its lists have the room the heaviest of them
// would take were all of that type; its joints lie in a pose buffer of its own, which its family's pass writes
// (ANIMAL_POSE_VEC4S an instance).
export function createAnimalScene({ device, atlas, programs, view, count, types, frame, shadowUniform, samples, label, profile = null }) {
  const room = types.map((t) => continuumRoom(atlas.types, atlas.types.map((_, u) => (u === t ? count : 0))).room).reduce((a, b) => a.map((n, i) => Math.max(n, b[i])));
  return createContinuumScene({ device, atlas, programs, capacity: count, room, view, poseRoom: count * ANIMAL_POSE_VEC4S, frame, shadowUniform, samples, label, profile });
}
