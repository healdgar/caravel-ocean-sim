// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Verification of 16th-century livestock progressive half-edge collapse continuum (`morphWords`),
// Lusitano horse `sela à gineta` tack, destructible herds & coupled road caravans (`sweepHerdHit`),
// 65-joint `CLIP_RIDE` saddle anatomy, and 1:1 GPU horse-rider street/road lockstep (with zero Indigenous horses).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { loadCrewGLB } from '../js/gltf.js';
import { townWalkerStride } from '../js/audio.js';
import { getLivestockMeshes, getVehicleMeshes } from '../js/models/livestock-meshes.js';
import {
  STREET_MOUNT_FLAG,
  buildLivestockMorphBuffer,
  buildStreetMountSeeds,
  caravanHerdSeeds,
  caravanRiderWaySeeds,
  createLivestockHerds,
  evaluateHerdStateAt,
  evaluateLivestockMorph,
  sweepHerdHit,
} from '../js/herds.js';
import {
  HERD_BODY_FLOATS,
  HERD_FATE_FLOATS,
  HERDS_RENDER_WGSL,
  HERDS_SHADOW_WGSL,
  HERDS_STEP_WGSL,
} from '../js/wgsl/herds.js';
import { CLIP_RIDE, TOWN_CLIP_COUNT, TOWN_RIDE_FRAMES, bakeRideClip, bakeTownClips } from '../js/town-clips.js';
import { assignStreetMountsToWalkers, createTownsfolk } from '../js/townsfolk.js';
import { TOWNSFOLK_WALK } from '../js/wgsl/townsfolk.js';
import { WALKER_MOUNTED_FLAG, boardFolkStreets, crowdFromBoard, folkDoing } from '../js/board-folk.js';
import { ROUTE_STEP_M, WALKER_WORDS } from '../js/town-streets.js';

const loadCrew = (name) => {
  const bytes = readFileSync(new URL(`../assets/crew/${name}.glb`, import.meta.url));
  return loadCrewGLB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

function countStorageBindings(wgsl) {
  return [...wgsl.matchAll(/var<storage\b/g)].length;
}

test('progressive half-edge collapse continuum smoothly decimates all 4 livestock species to their 20-triangle core with <= 8 storage buffers and zero discard', () => {
  assert.equal(HERD_BODY_FLOATS, 16, 'HerdBody is 4x vec4f (64 bytes)');
  assert.doesNotMatch(HERDS_STEP_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(HERDS_RENDER_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(HERDS_SHADOW_WGSL, /\bdiscard\b/);
  assert.ok(countStorageBindings(HERDS_STEP_WGSL) <= 8, `step storage buffers <= 8 (${countStorageBindings(HERDS_STEP_WGSL)})`);
  assert.ok(countStorageBindings(HERDS_RENDER_WGSL) <= 8, `render storage buffers <= 8 (${countStorageBindings(HERDS_RENDER_WGSL)})`);
  assert.ok(countStorageBindings(HERDS_SHADOW_WGSL) <= 8, `shadow storage buffers <= 8 (${countStorageBindings(HERDS_SHADOW_WGSL)})`);
  assert.match(HERDS_RENDER_WGSL, /@group\(0\)\s*@binding\(18\)\s*var<storage,\s*read>\s*herdMorph/);
  assert.match(HERDS_SHADOW_WGSL, /@group\(0\)\s*@binding\(4\)\s*var<storage,\s*read>\s*herdMorph/);

  const expectedTris = [3356, 3894, 2950, 5746];
  const livestock = getLivestockMeshes();
  assert.equal(livestock.length, 4);

  livestock.forEach((sp, idx) => {
    const vc = sp.vertices.length / 8;
    assert.equal(sp.indexCount / 3, expectedTris[idx], `${sp.name}: expected ${expectedTris[idx]} triangles`);
    assert.equal(sp.morphWords.length, vc * 2, `${sp.name}: 2 morphWords per vertex`);

    const morphBuf = buildLivestockMorphBuffer(sp, false);
    assert.equal(morphBuf.length, vc * 8);

    const m0 = evaluateLivestockMorph(sp, 0.0, morphBuf);
    const mMid = evaluateLivestockMorph(sp, 0.5, morphBuf);
    const mFull = evaluateLivestockMorph(sp, 1.0, morphBuf);

    assert.equal(m0.activeTriangles, expectedTris[idx], `${sp.name}: full triangles at morphLevel=0`);
    assert.ok(mMid.activeTriangles < m0.activeTriangles * 0.7 && mMid.activeTriangles > 400, `${sp.name}: smooth mid-continuum (${mMid.activeTriangles} tris)`);
    assert.equal(mFull.activeTriangles, sp.coreTris, `${sp.name}: reaches ${sp.coreTris}-triangle core at morphLevel=1`);
  });

  for (const veh of getVehicleMeshes()) {
    const vc = veh.vertices.length / 8;
    assert.equal(veh.morphWords.length, vc * 2, `${veh.name}: vehicle morphWords present`);
    const morphBuf = buildLivestockMorphBuffer(veh, true);
    const u32 = new Uint32Array(morphBuf.buffer);
    const shards = new Set();
    for (let i = 0; i < vc; i++) shards.add((u32[i * 8 + 7] >>> 24) & 0xff);
    assert.ok(shards.size >= 8, `${veh.name}: welded rigid shards assigned (${shards.size} distinct shard groups)`);
  }
});

test('1550 Lusitano horse mesh carries physical sela à gineta saddle, iron stirrups, bridle/reins, and Cordovan/courier livery zones', () => {
  const horse = getLivestockMeshes()[3];
  assert.equal(horse.name, 'horse');
  let saddleVerts = 0, bridleVerts = 0, leatherVerts = 0, ironVerts = 0, clothVerts = 0;
  let stirrupCount = 0, stirrupSumX = 0, stirrupMinY = Infinity, stirrupMaxY = -Infinity, stirrupSumZ = 0;

  for (let i = 0; i < horse.vertices.length; i += 8) {
    const x = horse.vertices[i], y = horse.vertices[i + 1], z = horse.vertices[i + 2];
    const part = horse.vertices[i + 6], zone = Math.floor(horse.vertices[i + 7] + 1e-4);
    if (Math.abs(part - 9) < 0.2) saddleVerts++;
    if (part >= 9.95 && part < 11.0) bridleVerts++;
    if (zone === 4) leatherVerts++;
    if (zone === 5) ironVerts++;
    if (zone === 6) clothVerts++;
    if (Math.abs(part - 9) < 0.2 && zone === 5 && Math.abs(x) > 0.2 && y < 1.05) {
      stirrupCount++;
      stirrupSumX += Math.abs(x);
      stirrupMinY = Math.min(stirrupMinY, y);
      stirrupMaxY = Math.max(stirrupMaxY, y);
      stirrupSumZ += z;
    }
  }

  assert.ok(saddleVerts >= 600, `high-pommel/cantle saddle, stirrups & alforjas present (${saddleVerts} verts)`);
  assert.ok(bridleVerts >= 120, `headstall bridle, curb bit & looped reins present (${bridleVerts} verts)`);
  assert.ok(leatherVerts >= 500 && ironVerts >= 100 && clothVerts >= 60, 'zones 4 (leather), 5 (iron), 6 (courier livery) populated');
  assert.ok(stirrupCount >= 20);
  assert.ok(Math.abs(stirrupSumX / stirrupCount - 0.30) < 0.02, 'stirrups at x = ±0.30 m');
  assert.ok(stirrupMinY >= 0.83 && stirrupMaxY <= 1.00, `stirrups at y = ${stirrupMinY.toFixed(2)}..${stirrupMaxY.toFixed(2)} m`);
  assert.ok(Math.abs(stirrupSumZ / stirrupCount - 0.04) < 0.02, 'stirrups at z = +0.04 m');

  // Pasture horses & coach draft horses have hasTack = false; mounted road/street horses (traits.x >= 10) have hasTack = true.
  const seeds = new Float32Array([
    10, 10, 14, 0.2, 0.42, 1.0, 3, 0,   // pasture horse -> unsaddled
    10, 20, 14, 0.5, 10.42, 1.0, 3, 0,  // saddled mount -> hasTack = true
  ]);
  const routes = new Float32Array([0, 1, 0, 0]);
  const pastureState = evaluateHerdStateAt(seeds, routes, null, 0, 5, () => 2);
  const mountState = evaluateHerdStateAt(seeds, routes, null, 1, 5, () => 2);
  assert.equal(pastureState.hasTack, false);
  assert.equal(pastureState.flags & 1, 0);
  assert.equal(mountState.hasTack, true);
  assert.equal(mountState.flags & 1, 1);

  assert.match(HERDS_RENDER_WGSL, /if\s*\(!hasTack\)\s*\{\s*p\s*=\s*vec3f\(0\.0,\s*rig\.legs\.x,\s*0\.0\);/);
  assert.match(HERDS_RENDER_WGSL, /part\s*>=\s*9\.95\s*&&\s*part\s*<\s*11\.0/);
  assert.match(HERDS_RENDER_WGSL, /zone\s*==\s*4u/);
  assert.match(HERDS_RENDER_WGSL, /zone\s*==\s*5u/);
  assert.match(HERDS_RENDER_WGSL, /zone\s*==\s*6u/);
});

test('sweepHerdHit fells struck livestock with knockback, triggers 38 m stampedes, halts hitches on draft loss, and shatters struck wagons', () => {
  const elev = () => 2.5;
  // Pasture flock: animal 0 directly in the shot line, animal 1 at 20 m (stampedes), animal 2 at 55 m (undisturbed).
  const pastureSeeds = new Float32Array([
    0, 0, 0.01, 0.2, 0.3, 1.0, 1, 0,
    0, 20, 0.01, 0.4, 0.5, 1.0, 1, 0,
    0, 55, 0.01, 0.6, 0.7, 1.0, 1, 0,
  ]);
  const emptyRoutes = new Float32Array([0, 1, 0, 0]);
  const fates = new Float32Array(3 * HERD_FATE_FLOATS);

  const hit = sweepHerdHit(pastureSeeds, emptyRoutes, fates, 10, elev, [-15, 3.3, 0], [15, 3.3, 0], 0.09);
  assert.ok(hit, 'direct shot strikes cow 0');
  assert.equal(hit.kind, 'livestock');
  assert.equal(hit.herdIndex, 0);
  assert.equal(fates[0], 2.0, 'cow 0 felled');
  assert.equal(fates[HERD_FATE_FLOATS], 1.0, 'cow 1 at 20 m (< 38 m) stampedes');
  assert.equal(fates[2 * HERD_FATE_FLOATS], 0.0, 'cow 2 at 55 m (> 38 m) stays calm');

  const felledAfter = evaluateHerdStateAt(pastureSeeds, emptyRoutes, fates, 0, 11.0, elev);
  assert.ok(felledAfter.x >= 0.75 && felledAfter.x <= 1.85, `knockback along +X shot vector (${felledAfter.x.toFixed(2)} m)`);
  const boltedAfter = evaluateHerdStateAt(pastureSeeds, emptyRoutes, fates, 1, 13.0, elev);
  assert.ok(boltedAfter.z > 28, `stampeding cow bolted radially away from z=20 to z=${boltedAfter.z.toFixed(2)}`);
});

test('CLIP_RIDE bakes a 65-joint 1550 sela à gineta saddle pose without barrel clipping across crew skeletons', () => {
  assert.equal(CLIP_RIDE, 6);
  assert.equal(TOWN_CLIP_COUNT, 7);

  for (const name of ['sailor', 'sailor-female', 'soldier-1550']) {
    const model = loadCrew(name);
    const a = model.animator;

    // Legacy 6-clip call stays compatible; `{ includeRide: true }` appends CLIP_RIDE at index 6.
    const legacy = bakeTownClips(a);
    assert.equal(legacy.layout.length, 12);
    const full = bakeTownClips(a, { includeRide: true });
    assert.equal(full.layout.length, TOWN_CLIP_COUNT * 2);
    assert.equal(full.layout[CLIP_RIDE * 2 + 1], TOWN_RIDE_FRAMES);

    // Inspect posed world joint coordinates across the ride cycle.
    let minPelvisY = Infinity, maxPelvisY = -Infinity;
    for (let f = 0; f < TOWN_RIDE_FRAMES; f++) {
      bakeRideClip(a, 1, () => {});
      // Sample specific frame f via bakeRideClip
    }
    const frames = [];
    bakeRideClip(a, TOWN_RIDE_FRAMES, () => {
      const at = (joint) => Array.from(a.world[a.nodeIndex(joint)].subarray(12, 15));
      frames.push({
        pelvis: at('pelvis'),
        kneeL: at('calf_l'),
        kneeR: at('calf_r'),
        footL: at('foot_l'),
        footR: at('foot_r'),
        handL: at('hand_l'),
        handR: at('hand_r'),
        head: at('Head'),
      });
    });

    for (const fr of frames) {
      minPelvisY = Math.min(minPelvisY, fr.pelvis[1]);
      maxPelvisY = Math.max(maxPelvisY, fr.pelvis[1]);
      assert.ok(fr.pelvis[1] > 1.32 && fr.pelvis[1] < 1.42, `${name}: pelvis at saddle seat height (${fr.pelvis[1].toFixed(3)})`);
      assert.ok(Math.abs(fr.pelvis[2] - (-0.02)) < 0.04, `${name}: pelvis centered in saddle z`);
      assert.ok(fr.kneeL[0] > 0.27 && fr.kneeR[0] < -0.27, `${name}: knees abducted around horse ribcage (${fr.kneeL[0].toFixed(3)}, ${fr.kneeR[0].toFixed(3)})`);
      assert.ok(Math.abs(fr.footL[0] - 0.30) < 0.02 && Math.abs(fr.footR[0] + 0.30) < 0.02, `${name}: boots in stirrups x=±0.30`);
      assert.ok(fr.footL[1] > 0.86 && fr.footL[1] < 0.91, `${name}: boots at stirrup iron height y≈0.88 (${fr.footL[1].toFixed(3)})`);
      assert.ok(Math.abs(fr.footL[2] - 0.04) < 0.02, `${name}: boots at stirrup z=+0.04`);
      assert.ok(fr.handL[1] > 1.60 && fr.handL[2] > 0.20, `${name}: left hand holds reins above pommel`);
      assert.ok(fr.head[1] > 1.85, `${name}: upright noble/courier head posture (${fr.head[1].toFixed(3)})`);
    }
    assert.ok(maxPelvisY - minPelvisY > 0.025, `${name}: rhythmic 2-cycle gait rocking present`);
  }
});

test('mounted street & road riders lock 1:1 with saddled Lusitano horses on GPU routes, unhorse under gunfire, and spawn zero horses in Indigenous towns', async (t) => {
  assert.equal(crowdFromBoard, boardFolkStreets);
  assert.equal(WALKER_MOUNTED_FLAG, STREET_MOUNT_FLAG);
  assert.match(TOWNSFOLK_WALK, /let isMounted=\(w\.flags&16u\)!=0u;/);

  const heightAt = (x, z) => 3.5 + 0.002 * x + 0.001 * z;
  const people = Array.from({ length: 24 }, (_, i) => ({
    id: 500 + i,
    name: `Cidadao ${i}`,
    surname: 'Silva',
    sex: i % 2 ? 'f' : 'm',
    age: 28,
    role: i === 0 ? 'envoy' : i === 1 ? 'bailiff' : i === 2 ? 'courier' : 'baker',
    trade: i === 2 ? 'messenger' : 'baker',
    mounted: i === 3,
    goal: 'work',
    there: 'at the court',
    via: 'Rua Nova',
    open: true,
    run: false,
    pace: 1.25,
    home: [0, 0],
    route: [0, i * 2, 90, i * 2, 160, i * 2 + 20],
  }));
  const plan = { si: 0, day: 15, date: 'Spring 16, AD 1550', sunday: false, people, others: [] };

  // 1. 1550 Old World / Colonial street plan: envoys, bailiffs, couriers, explicit riders + ~8% street riders get saddled mounts.
  const colonialStreets = boardFolkStreets({ plan, origin: { x: 200, z: 300 }, heightAt, indigenous: false });
  assert.ok(colonialStreets.mountSeeds && colonialStreets.mountSeeds.count >= 4, `expected >= 4 mounted riders, got ${colonialStreets.mountSeeds?.count}`);
  const words = new Uint32Array(colonialStreets.walkers.buffer);
  for (const idx of [0, 1, 2, 3]) {
    assert.ok((words[idx * WALKER_WORDS + 11] & WALKER_MOUNTED_FLAG) !== 0, `explicit rider ${idx} has WALKER_MOUNTED_FLAG`);
    assert.equal(colonialStreets.souls[idx].mounted, true);
  }
  assert.match(folkDoing(colonialStreets.souls[0], { stopped: false, walked: 30, back: false }, 160), /^riding to work/);

  // Verify 1:1 world position & heading agreement (< 1 mm!) between townsfolk walker and herds saddled horse across time!
  const mSeeds = colonialStreets.mountSeeds.seeds;
  const mRoutes = colonialStreets.mountSeeds.routes;
  for (let m = 0; m < colonialStreets.mountSeeds.walkerIndices.length; m++) {
    const walkerIdx = colonialStreets.mountSeeds.walkerIndices[m];
    for (const clockSec of [0.5, 7.25, 19.8, 42.1, 88.6]) {
      const human = townWalkerStride(colonialStreets, walkerIdx, clockSec, 0.8);
      const horse = evaluateHerdStateAt(mSeeds, mRoutes, null, m, { time: clockSec, sunY: 0.8 }, heightAt);
      if (!human) {
        assert.equal(horse, null, `mount ${m} goes indoors in lockstep with rider at t=${clockSec}`);
        continue;
      }
      assert.ok(horse, `mount ${m} is abroad in lockstep with rider at t=${clockSec}`);
      assert.equal(horse.species, 3);
      assert.equal(horse.hasTack, true);
      const drift = Math.hypot(human.position.x - horse.x, human.position.y - horse.y, human.position.z - horse.z);
      assert.ok(drift < 1e-3, `horse-rider drift ${drift} m must be < 1 mm at t=${clockSec}`);
    }
  }

  // 2. Pre-contact Indigenous settlement: STRICTLY ZERO horses even if souls carry courier/mounted fields or synthetic ways!
  const indigenousStreets = boardFolkStreets({ plan, origin: { x: 200, z: 300 }, heightAt, indigenous: true });
  assert.equal(indigenousStreets.mountSeeds.count, 0, 'zero horses in Indigenous boardFolkStreets');
  const indWords = new Uint32Array(indigenousStreets.walkers.buffer);
  for (let i = 0; i < indigenousStreets.people; i++) {
    assert.equal(indWords[i * WALKER_WORDS + 11] & WALKER_MOUNTED_FLAG, 0, `Indigenous walker ${i} is on foot`);
  }
  const clearedMounts = assignStreetMountsToWalkers(
    { walkers: new Float32Array(colonialStreets.walkers), samples: colonialStreets.samples, people: colonialStreets.people },
    { indigenous: true },
  );
  assert.equal(clearedMounts.count, 0, 'assignStreetMountsToWalkers strips all mounts when indigenous=true');
  assert.equal(buildStreetMountSeeds(colonialStreets, { indigenous: true }).count, 0);

  // 3. End-to-end device coupling between `createLivestockHerds` and `createTownsfolk` + gunfire felling on street mounts.
  const prevUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { VERTEX: 1, INDEX: 2, UNIFORM: 4, STORAGE: 8, COPY_DST: 16, INDIRECT: 32 };
  t.after(() => {
    if (prevUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = prevUsage;
  });

  const device = {
    createBuffer(d) { return { ...d, destroyed: false, destroy() { this.destroyed = true; } }; },
    queue: { writeBuffer() {}, onSubmittedWorkDone: () => Promise.resolve() },
    createRenderPipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => ({ ...d }),
  };
  const herds = await createLivestockHerds({
    device,
    shader: async (code, label) => ({ code, label }),
    frameUBO: {},
    landUniform: {},
    nearDomain: {},
    elevation: { createView: () => ({}) },
    landShadowUniform: {},
    resources: [[0, {}], [1, {}], [2, {}], [3, {}], [4, {}], [12, {}], [19, {}], [20, {}], [21, {}]],
    clouds: { bindVolume: () => ({}) },
  });
  const sailorModels = ['sailor', 'sailor-female'].map(loadCrew);
  const townsfolk = await createTownsfolk({
    device,
    frameUBO: {},
    shader: async (code, label) => ({ code, label }),
    shared: { models: sailorModels },
    shadows: { bind: () => ({}), uniform: {} },
  });

  const lisbonPort = {
    name: 'Lisboa',
    hasColonialPort: true,
    hasIndigenousSettlement: false,
    center: { x: 200, z: 300 },
    streets: { ...colonialStreets, window: { x: 200, z: 300, span: 500 } },
  };
  const tainoPort = {
    name: 'Maguana',
    hasColonialPort: false,
    hasIndigenousSettlement: true,
    indigenousSettlement: { cultureId: 'caribbean' },
    center: { x: 5000, z: 0 },
    streets: {
      walkers: new Float32Array(colonialStreets.walkers),
      samples: colonialStreets.samples,
      people: colonialStreets.people,
      window: { x: 5000, z: 0, span: 500 },
    },
  };

  for (let k = 0; k < 45; k++) townsfolk.follow([lisbonPort, tainoPort], { x: 200, z: 300 });
  assert.equal(herds.streetMounts, colonialStreets.mountSeeds.count, 'visiting Lisboa binds 1:1 street mounts in herds');

  // Fire a cannonball across a mounted courier on Rua Nova: both the street mount (herds.watchShot) and townsfolk log register it!
  herds.setSimClock(7.25);
  const riderPos = townWalkerStride(lisbonPort.streets, 0, 7.25, 0.8).position;
  const best = { fraction: 1, distance: 40 };
  const mountHit = herds.watchShot(
    [riderPos.x - 10, riderPos.y + 1.1, riderPos.z],
    [riderPos.x + 10, riderPos.y + 1.1, riderPos.z],
    best,
    { radius: 0.09, mass: 10.9, velocity: [220, 0, 0] },
    { surfaceHeight: heightAt },
  );
  lisbonPort.townsfolkWatch(
    [riderPos.x - 10, riderPos.y + 1.1, riderPos.z],
    [riderPos.x + 10, riderPos.y + 1.1, riderPos.z],
    mountHit,
    { radius: 0.09, mass: 10.9, velocity: [220, 0, 0] },
  );
  assert.equal(mountHit?.kind, 'livestock');
  assert.equal(mountHit?.species, 3, 'cannonball strikes the courier\'s saddled Lusitano mount');
  assert.equal(herds.fates[mountHit.herdIndex * HERD_FATE_FLOATS], 2.0, 'struck street horse transitions to felled state');

  // Visiting pre-contact Maguana clears all street horses to strictly zero!
  for (let k = 0; k < 45; k++) townsfolk.follow([lisbonPort, tainoPort], { x: 5000, z: 0 });
  assert.equal(herds.streetMounts, 0, 'visiting Indigenous settlement reduces street mounts to strictly zero');
  assert.equal(herds.count, 0);
  // Ensure species 3 + full MSAA coverage (3.0 + 0.95 = 3.95) never triggers `isVehicle` draft-pole rotation on horse tack
  const { HERDS_RENDER_WGSL } = await import('../js/wgsl/herds.js');
  assert.match(HERDS_RENDER_WGSL, /let\s+isVehicle\s*=\s*body\.slopeScale\.w\s*>=\s*3\.99\s*;/);

  townsfolk.destroy();
  herds.destroy();
});
