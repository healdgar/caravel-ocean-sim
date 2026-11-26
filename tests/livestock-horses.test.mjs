// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Verification of the Tripo H3.1 4K livestock bodies baked into the one animal continuum (`RGB555` coats, crack-free
// seam welding, the atlas's receipt), 1550 Lusitano `sela à gineta` saddle & tack contour fit, 0.00 m horse-rider
// saddle contact & sloped-street ground lock, and the herds drawn only through the continuum's cut and indirect lists.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { loadCrewGLB } from '../js/gltf.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import { townWalkerStride } from '../js/audio.js';
import { getLivestockMeshes, getVehicleMeshes } from '../js/models/livestock-meshes.js';
import {
  STREET_MOUNT_FLAG,
  buildStreetMountSeeds,
  caravanHerdSeeds,
  caravanRiderWaySeeds,
  createLivestockHerds,
  evaluateHerdStateAt,
  herdAvoidSlack,
  herdShotNear,
  herdShotReach,
  sweepHerdHit,
} from '../js/herds.js';
import {
  HERD_AVOID_BEYOND_ROAM_M,
  HERD_AVOID_LEAST_M,
  HERD_CONTINUUM_MATERIAL_SPEC,
  HERD_FATE_FLOATS,
  HERD_MOUNT_AVOID_ASIDE_M,
  HERD_SEED_FLOATS,
  HERDS_STEP_WGSL,
} from '../js/wgsl/herds.js';
import { continuumModuleWGSL } from '../js/wgsl/continuum-cut.js';
import {
  CLIP_RIDE,
  HORSE_BARREL_MAX_RX,
  HORSE_POMMEL_TOP_Y,
  HORSE_SADDLE_SEAT_TOP_Y,
  HORSE_STIRRUP_BAR_TOP_Y,
  HORSE_STIRRUP_Z,
  TOWN_CLIP_COUNT,
  TOWN_RIDE_FRAMES,
  bakeRideClip,
  bakeTownClips,
} from '../js/town-clips.js';
import { assignStreetMountsToWalkers, createTownsfolk, townsfolkBodiesFor } from '../js/townsfolk.js';
import { crewContinuumBaked, crewContinuumDevice, crewContinuumGlobals, fetchCrewContinuumAsset } from './helpers/crew-continuum-fixture.mjs';
import { loadCrewContinuumBodies } from '../js/crew-continuum-draw.js';
import { TOWNSFOLK_RESET, TOWNSFOLK_WALK } from '../js/wgsl/townsfolk.js';
import { WALKER_MOUNTED_FLAG, boardFolkStreets, crowdFromBoard, folkDoing } from '../js/board-folk.js';
import { ROUTE_STEP_M, WALKER_WORDS } from '../js/town-streets.js';

const loadCrew = (name) => {
  const bytes = readFileSync(new URL(`../assets/crew/${name}.glb`, import.meta.url));
  return loadCrewGLB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

function countStorageBindings(wgsl) {
  return [...wgsl.matchAll(/var<storage\b/g)].length;
}

function countBodyBoundaryEdges(sp, positions) {
  const vc = sp.vertices.length / 8;
  const posKey = (idx) => {
    const o = idx * 3;
    return `${Math.round(positions[o] * 1000)},${Math.round(positions[o + 1] * 1000)},${Math.round(positions[o + 2] * 1000)}`;
  };
  const canon = new Int32Array(vc);
  const map = new Map();
  for (let i = 0; i < vc; i++) {
    if (sp.vertices[i * 8 + 6] >= 8.5) {
      canon[i] = -1;
      continue;
    }
    const k = posKey(i);
    let id = map.get(k);
    if (id === undefined) {
      id = i;
      map.set(k, id);
    }
    canon[i] = id;
  }
  const edgeCounts = new Map();
  let totalEdges = 0;
  for (let t = 0; t + 2 < sp.indices.length; t += 3) {
    const a = canon[sp.indices[t]], b = canon[sp.indices[t + 1]], c = canon[sp.indices[t + 2]];
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const lo = Math.min(u, v), hi = Math.max(u, v);
      const ek = `${lo}:${hi}`;
      edgeCounts.set(ek, (edgeCounts.get(ek) ?? 0) + 1);
      totalEdges++;
    }
  }
  let boundary = 0;
  for (const c of edgeCounts.values()) {
    if (c === 1) boundary++;
  }
  return { boundary, uniqueEdges: edgeCounts.size, totalEdges };
}

const animalManifest = JSON.parse(readFileSync(new URL('../assets/animal-continuum/manifest.json', import.meta.url), 'utf8'));

test('Tripo H3.1 4K livestock bodies bake whole into the one continuum: RGB555 coats, crack-free manifolds, <= 8 storage buffers, no discard', () => {
  // The herds' view, the shadow and the select are the one cut's (js/wgsl/continuum-cut.js), the view in the herds'
  // material; the step is their own.
  const view = continuumModuleWGSL({ pass: 'view', material: HERD_CONTINUUM_MATERIAL_SPEC });
  const programs = [['step', HERDS_STEP_WGSL], ['view', view], ['shadow', continuumModuleWGSL({ pass: 'shadow' })], ['cut', continuumModuleWGSL({ pass: 'select' })]];
  for (const [name, wgsl] of programs) {
    assert.doesNotMatch(wgsl, /\bdiscard\b/, `herd ${name} program has no discard`);
    assert.ok(countStorageBindings(wgsl) <= 8, `herd ${name} storage buffers <= 8 (${countStorageBindings(wgsl)})`);
  }
  assert.ok(countStorageBindings(TOWNSFOLK_RESET) <= 8, `townsfolk reset storage buffers <= 8`);
  // The view reads the beasts' bodies from the scene's data (group 2: the atlas, the records, the lists, the view, the
  // joints), and the step writes only the records and their joints.
  assert.match(view, /@group\(2\)\s*@binding\(0\)\s*var<storage,\s*read>\s*continuumAtlas/);
  assert.match(HERDS_STEP_WGSL, /@group\(0\)\s*@binding\(6\)\s*var<storage,\s*read_write>\s*herdRecords:\s*array<ContinuumRecord>/);
  assert.match(HERDS_STEP_WGSL, /@group\(0\)\s*@binding\(7\)\s*var<storage,\s*read_write>\s*skinnedPoses/);
  assert.match(view, /@fragment\s+fn\s+continuumFS\s*\(v:ContinuumVarying[^{]*->\s*ContinuumCoverage/, 'one fragment entry, with the sample-mask handoff');
  assert.equal(view.match(/@fragment\s+fn\s+continuumFS\b/g).length, 1, 'one fragment entry');

  const expectedHeights = [0.82, 1.52, 0.66, 1.84];
  const triRanges = [[3300, 3500], [3700, 3900], [2900, 3100], [5800, 6400]];
  const livestock = getLivestockMeshes();
  assert.equal(livestock.length, 4);

  livestock.forEach((sp, idx) => {
    const vc = sp.vertices.length / 8;
    const tris = sp.indexCount / 3;
    const [loT, hiT] = triRanges[idx];
    assert.ok(tris >= loT && tris <= hiT, `${sp.name}: expected ${loT}..${hiT} triangles, got ${tris}`);
    assert.ok(Math.abs(sp.height - expectedHeights[idx]) < 0.02, `${sp.name}: height ${sp.height}`);

    // Verify single sheep extraction (no twin sheep!) & grounded hooves + RGB555 4K texture vertex colors
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const distinctColors = new Set();
    const positions = new Float32Array(vc * 3);
    let bodyVerts = 0, rgbVerts = 0;
    for (let i = 0; i < vc; i++) {
      const o = i * 8;
      const x = sp.vertices[o], y = sp.vertices[o + 1], part = sp.vertices[o + 6], coat = sp.vertices[o + 7];
      positions.set(sp.vertices.subarray(o, o + 3), i * 3);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (part < 8.5) {
        bodyVerts++;
        if (coat >= 17.0 && coat <= 32783.0) {
          rgbVerts++;
          distinctColors.add(Math.round(coat - 16.0));
        }
      }
    }
    assert.equal(rgbVerts, bodyVerts, `${sp.name}: 100% of body vertices carry packed 4K RGB555 colors`);
    assert.ok(distinctColors.size >= 60, `${sp.name}: rich 4K texture RGB555 palette (${distinctColors.size} distinct colors)`);
    assert.ok(Math.abs(minY) <= 0.005, `${sp.name}: hooves grounded at y=0 (minY=${minY.toFixed(4)})`);
    if (sp.name === 'sheep') {
      assert.ok(maxX - minX < 0.48 && Math.abs(minX + maxX) < 0.05, `single centered Merino sheep (${minX.toFixed(3)}..${maxX.toFixed(3)})`);
    }

    // Welded crack-free manifold (zero UV-seam cracks) at the full detail the continuum's finest cut draws.
    const seam = countBodyBoundaryEdges(sp, positions);
    assert.ok(seam.boundary <= 12, `${sp.name}: crack-free welded UV seams (${seam.boundary}/${seam.uniqueEdges} boundary edges)`);

    // The continuum holds the whole body: its finest clusters are every source triangle, and its chain closes far below them.
    const baked = animalManifest.types[idx];
    assert.equal(baked.name, sp.name);
    assert.equal(baked.sourceTriangles, tris, `${sp.name}: baked from this body`);
    assert.equal(baked.clusters.finestTriangles, tris, `${sp.name}: finest cut is every source triangle`);
    assert.ok(baked.chain.coreTriangles < baked.chain.farFirstTriangles, `${sp.name}: far body collapses (${baked.chain.farFirstTriangles} -> ${baked.chain.coreTriangles})`);
  });

  // Wagons and coaches shatter by their baked pieces, each riding its own transform.
  for (const veh of getVehicleMeshes()) {
    const baked = animalManifest.types.find((t) => t.family === 'vehicle' && t.sourceTriangles === veh.indexCount / 3);
    assert.ok(baked, `${veh.name}: baked into the continuum`);
    assert.equal(baked.clusters.finestTriangles, veh.indexCount / 3);
    assert.ok(baked.pieces >= 8, `${veh.name}: welded rigid shards assigned (${baked.pieces} pieces)`);
    assert.ok(baked.shatterReach > 0, `${veh.name}: shards fly a bounded reach (${baked.shatterReach} m)`);
  }
});

test('1550 Lusitano horse mesh fits sela à gineta tack to Tripo H3.1 contours with zero-merge CLIP_RIDE clearance on male & female skeletons', () => {
  const horse = getLivestockMeshes()[3];
  assert.equal(horse.name, 'horse');
  let saddleVerts = 0, bridleVerts = 0, leatherVerts = 0, ironVerts = 0, clothVerts = 0, tailLegSplit = 0;
  let stirrupCount = 0, stirrupSumX = 0, stirrupMinY = Infinity, stirrupMaxY = -Infinity, stirrupSumZ = 0;
  let seatTopY = -Infinity, clothMaxRx = 0, spineAtSeatY = -Infinity;

  for (let i = 0; i < horse.vertices.length; i += 8) {
    const x = horse.vertices[i], y = horse.vertices[i + 1], z = horse.vertices[i + 2];
    const part = horse.vertices[i + 6], coat = horse.vertices[i + 7];
    const zone = coat < 16 ? Math.floor(coat + 1e-4) : -1;
    if (part < 8.5 && z < horse.backZ - 0.12 * horse.height && y > 0.10 * horse.height) {
      if (Math.round(part) !== 6) tailLegSplit++;
    }
    if (part < 8.5 && Math.abs(z - (-0.02)) < 0.045 && Math.abs(x) < 0.12 && y > 0.8) {
      spineAtSeatY = Math.max(spineAtSeatY, y);
    }
    if (Math.abs(part - 9) < 0.2) saddleVerts++;
    if (part >= 9.95 && part < 11.0) bridleVerts++;
    if (zone === 4) leatherVerts++;
    if (zone === 5) ironVerts++;
    if (zone === 6) {
      clothVerts++;
      clothMaxRx = Math.max(clothMaxRx, Math.abs(x));
    }
    if (Math.abs(part - 9) < 0.2 && zone === 4 && Math.abs(x) < 0.08 && Math.abs(z - (-0.02)) < 0.08) {
      seatTopY = Math.max(seatTopY, y);
    }
    if (Math.abs(part - 9) < 0.2 && zone === 5 && Math.abs(x) > 0.2 && y < 1.02) {
      stirrupCount++;
      stirrupSumX += Math.abs(x);
      stirrupMinY = Math.min(stirrupMinY, y);
      stirrupMaxY = Math.max(stirrupMaxY, y);
      stirrupSumZ += z;
    }
  }

  assert.equal(tailLegSplit, 0, 'zero hanging horse tail vertices misclassified into hind legs');
  assert.ok(saddleVerts >= 600, `high-pommel/cantle saddle, stirrups & alforjas present (${saddleVerts} verts)`);
  assert.ok(bridleVerts >= 100, `headstall bridle, curb bit & looped reins present (${bridleVerts} verts)`);
  assert.ok(leatherVerts >= 500 && ironVerts >= 100 && clothVerts >= 60, 'zones 4 (leather), 5 (iron), 6 (courier livery) populated');
  assert.ok(seatTopY - spineAtSeatY >= 0.05 && seatTopY - spineAtSeatY <= 0.12, `saddle seat hugs horse spine without floating (${spineAtSeatY.toFixed(3)} -> ${seatTopY.toFixed(3)})`);
  assert.ok(Math.abs(seatTopY - HORSE_SADDLE_SEAT_TOP_Y) <= 0.01, `saddleSeatTopY matches bakeRideClip (${seatTopY.toFixed(3)} vs ${HORSE_SADDLE_SEAT_TOP_Y})`);
  assert.ok(Math.abs(clothMaxRx - HORSE_BARREL_MAX_RX) <= 0.01, `barrelMaxRx matches bakeRideClip (${clothMaxRx.toFixed(3)} vs ${HORSE_BARREL_MAX_RX})`);
  assert.ok(stirrupCount >= 20);
  assert.ok(Math.abs(stirrupSumX / stirrupCount - Math.max(0.335, HORSE_BARREL_MAX_RX + 0.085)) < 0.02, `stirrups at x = ±${(stirrupSumX / stirrupCount).toFixed(3)} m`);
  assert.ok(stirrupMinY >= 0.73 && stirrupMaxY <= 0.92, `stirrups at y = ${stirrupMinY.toFixed(2)}..${stirrupMaxY.toFixed(2)} m`);
  assert.ok(Math.abs(stirrupSumZ / stirrupCount - HORSE_STIRRUP_Z) < 0.02, 'stirrups at z = +0.04 m');

  // Programmatically verify 0.00 m centaur merge across ALL frames of CLIP_RIDE on sailor, sailor-female & soldier-1550!
  for (const name of ['sailor', 'sailor-female', 'soldier-1550']) {
    const model = loadCrew(name);
    const a = model.animator;
    const legacy = bakeTownClips(a);
    assert.equal(legacy.layout.length, 12);
    const full = bakeTownClips(a, { includeRide: true });
    assert.equal(full.layout.length, TOWN_CLIP_COUNT * 2);
    assert.equal(full.layout[CLIP_RIDE * 2 + 1], TOWN_RIDE_FRAMES);

    const palettes = bakeRideClip(a, TOWN_RIDE_FRAMES);
    const dv = new DataView(model.vertices.buffer, model.vertices.byteOffset, model.vertices.byteLength);
    const jNames = a.joints.map((n) => a.names[n]);
    const footSet = new Set(jNames.map((nm, i) => /^(foot|ball)_[lr]$/.test(nm) ? i : -1).filter((i) => i >= 0));

    let buttMinY = Infinity, thighInnerMinX = Infinity, maxSoleErr = 0;
    for (let f = 0; f < TOWN_RIDE_FRAMES; f++) {
      const base = f * CREW_JOINT_COUNT * 16;
      let frameSoleMinY = Infinity;
      for (let v = 0; v < model.vertexCount; v++) {
        const o = v * 60;
        const px = dv.getFloat32(o, true), py = dv.getFloat32(o + 4, true), pz = dv.getFloat32(o + 8, true);
        const cg = dv.getFloat32(o + 28, true);
        if (cg >= 1.5) continue;
        let ox = 0, oy = 0, oz = 0, wButt = 0, wLimb = 0, wFoot = 0;
        for (let k = 0; k < 4; k++) {
          const b = dv.getUint16(o + 36 + k * 2, true);
          const w = dv.getFloat32(o + 44 + k * 4, true);
          const nm = jNames[b];
          if (nm === 'pelvis' || (py > 0.68 && /^thigh_[lr]$/.test(nm))) wButt += w;
          if (/^(thigh|calf)_[lr]$/.test(nm) && Math.abs(px) > 0.055) wLimb += w;
          if (footSet.has(b)) wFoot += w;
          const mat = base + b * 16;
          ox += w * (palettes[mat] * px + palettes[mat + 4] * py + palettes[mat + 8] * pz + palettes[mat + 12]);
          oy += w * (palettes[mat + 1] * px + palettes[mat + 5] * py + palettes[mat + 9] * pz + palettes[mat + 13]);
          oz += w * (palettes[mat + 2] * px + palettes[mat + 6] * py + palettes[mat + 10] * pz + palettes[mat + 14]);
        }
        if (wButt >= 0.6 && Math.abs(ox) < 0.12) buttMinY = Math.min(buttMinY, oy);
        if (wLimb >= 0.6 && oy > 0.96 && oy < 1.18 && Math.abs(oz) < 0.22) {
          thighInnerMinX = Math.min(thighInnerMinX, Math.abs(ox));
        }
        if (wFoot >= 0.5) frameSoleMinY = Math.min(frameSoleMinY, oy);
      }
      maxSoleErr = Math.max(maxSoleErr, Math.abs(frameSoleMinY - HORSE_STIRRUP_BAR_TOP_Y));
    }

    assert.ok(
      buttMinY >= seatTopY - 0.015 && buttMinY <= seatTopY + 0.09,
      `${name}: buttocks rest squarely ON saddle seat (buttMinY=${buttMinY.toFixed(3)}, seatTopY=${seatTopY.toFixed(3)})`,
    );
    assert.ok(
      thighInnerMinX >= clothMaxRx - 0.01,
      `${name}: inner thighs/shins clear horse barrel (${thighInnerMinX.toFixed(3)} >= ${(clothMaxRx - 0.01).toFixed(3)})`,
    );
    assert.ok(
      maxSoleErr <= 0.025,
      `${name}: boot soles rest squarely on iron stirrup bar (maxSoleErr=${maxSoleErr.toFixed(4)} m)`,
    );

    const frames = [];
    bakeRideClip(a, TOWN_RIDE_FRAMES, () => {
      const at = (joint) => Array.from(a.world[a.nodeIndex(joint)].subarray(12, 15));
      frames.push({
        pelvis: at('pelvis'),
        handL: at('hand_l'),
        head: at('head'),
      });
    });
    for (const fr of frames) {
      assert.ok(fr.handL[1] > HORSE_POMMEL_TOP_Y + 0.03 && fr.handL[2] > 0.16, `${name}: left hand holds reins above pommel (${fr.handL[1].toFixed(3)}, ${fr.handL[2].toFixed(3)})`);
      assert.ok(fr.head[1] > 1.95, `${name}: upright noble/courier head posture (${fr.head[1].toFixed(3)})`);
    }
  }
});

test('sweepHerdHit fells struck livestock with knockback, triggers 38 m stampedes, halts hitches on draft loss, and shatters struck wagons', () => {
  const elev = () => 2.5;
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

// The step draws a loose beast or a street mount aside of its closed-form place by an offset it sums on the GPU, which
// JavaScript never reads. The shot test's broad phase is laid from the bound of that offset, so no drawn beast is
// missed by it; a shot that sweeps no beast's reach stands none.
test('a shot stands only the beasts whose reach it sweeps, and that reach holds wherever the step may draw them', () => {
  const elev = () => 2.5;
  const pasture = [];
  for (let i = 0; i < 40; i++) pasture.push(-300 + (i % 8) * 90, -260 + Math.floor(i / 8) * 110, 1 + (i % 5) * 7, (i * 0.137) % 1, 0.3, 1, i % 4, i * 0.7);
  const road = caravanHerdSeeds([
    { mode: 'cart', key: 'grain', good: 'grain', carts: 2, points: [-400, 420, 300, 470, 900, 1100], depart: 0, arrive: 4 },
    { mode: 'cart', key: 'flock', good: 'sheep', qty: 9, points: [-400, 420, 300, 470, 900, 1100], depart: 0, arrive: 4 },
    { mode: 'rider', key: 'post', riders: 2, points: [900, 1100, 300, 470, -400, 420], depart: 0, arrive: 4 },
  ], { x: 0, z: 0 });
  const seeds = new Float32Array([...pasture, ...road.seeds]);
  const count = seeds.length / HERD_SEED_FLOATS, firstOnRoad = pasture.length / HERD_SEED_FLOATS;
  const reach = herdShotReach(seeds, road.routes);

  // What the step never moves aside is tested exactly; what it does is bounded by the step's own clamp.
  assert.equal(herdAvoidSlack(seeds, 4), 1 + 4 * 7 + HERD_AVOID_BEYOND_ROAM_M, 'a grazing beast: its roam and the step\'s margin');
  assert.equal(herdAvoidSlack(seeds, 0), HERD_AVOID_LEAST_M);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => herdAvoidSlack(seeds, firstOnRoad + k)), [0, 0, 0, 0, 0, 0], 'two wains and their yokes are never moved aside');
  assert.equal(herdAvoidSlack(seeds, firstOnRoad + 6), HERD_AVOID_LEAST_M, 'a drove walks loose');
  assert.equal(herdAvoidSlack(seeds, count - 1), HERD_AVOID_LEAST_M, 'and so does a road rider\'s horse');

  const at = (x, z, margin = 0) => herdShotNear(reach, [x, 3, z], [x, 3, z], 0, 0, margin);
  let stood = 0;
  for (let step = 0; step < 60; step++) {
    const clock = { time: step * 9.7, boardDay: step * 4 / 59, daysPerSecond: 0 };
    for (let idx = 0; idx < count; idx++) {
      const st = evaluateHerdStateAt(seeds, road.routes, null, idx, clock, elev);
      if (!st) continue;
      stood++;
      const slack = herdAvoidSlack(seeds, idx);
      for (let dir = 0; dir < 8; dir++) {
        const x = st.x + Math.cos(dir * Math.PI / 4) * slack, z = st.z + Math.sin(dir * Math.PI / 4) * slack;
        assert.ok(at(x, z).includes(idx), `beast ${idx} drawn ${slack} m aside at t=${clock.time} is within its reach`);
      }
    }
  }
  assert.ok(stood > count * 30, `beasts stand on pasture and road (${stood})`);

  // The same answer and the same fates as a sweep of the whole herd, by far fewer beasts; under a shifted world too.
  let rnd = 12345;
  const roll = () => (rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 4294967296;
  let hits = 0, started = 0, none = 0, most = 0;
  for (let shot = 0; shot < 400; shot++) {
    const shiftX = shot % 2 ? 5000 : 0, shiftZ = shot % 2 ? -3000 : 0;
    const clock = { time: roll() * 500, boardDay: roll() * 4, daysPerSecond: 0, shiftX, shiftZ };
    const aim = evaluateHerdStateAt(seeds, road.routes, null, Math.floor(roll() * count), clock, elev);
    const wild = shot % 4 === 3 || !aim;
    const cx = wild ? -2000 + roll() * 4000 : aim.x + (roll() - 0.5) * 30, cz = wild ? -2000 + roll() * 4000 : aim.z + (roll() - 0.5) * 30;
    const bearing = roll() * Math.PI * 2, half = 2 + roll() * 12;
    const from = [cx - Math.cos(bearing) * half, 3.2, cz - Math.sin(bearing) * half], to = [cx + Math.cos(bearing) * half, 3.0, cz + Math.sin(bearing) * half];
    const whole = new Float32Array(count * HERD_FATE_FLOATS), few = new Float32Array(count * HERD_FATE_FLOATS);
    const near = herdShotNear(reach, from, to, shiftX, shiftZ);
    most = Math.max(most, near.length);
    if (!near.length) none++;
    const wholeHit = sweepHerdHit(seeds, road.routes, whole, clock, elev, from, to, 0.09);
    assert.deepEqual(sweepHerdHit(seeds, road.routes, few, clock, elev, from, to, 0.09, near), wholeHit);
    assert.deepEqual(few, whole);
    if (wholeHit) hits++;
    if (whole.some((v, k) => k % HERD_FATE_FLOATS === 0 && v === 1)) started++;
  }
  assert.ok(hits > 5 && started > 100 && none > 20, `shots strike (${hits}), start stampedes (${started}) and pass clear of every reach (${none})`);
  assert.ok(most < count, `no shot stands the whole herd (${most} of ${count} at most)`);

  // Whoever a shot may have started running leaves its reach, and is stood for every shot until it has settled.
  const fates = new Float32Array(count * HERD_FATE_FLOATS);
  const cow = evaluateHerdStateAt(seeds, road.routes, fates, 1, 20, elev);
  const miss = [[cow.x - 9, 3, cow.z - 15], [cow.x - 9, 3, cow.z + 15]];
  assert.equal(sweepHerdHit(seeds, road.routes, fates, 20, elev, miss[0], miss[1], 0.09, herdShotNear(reach, miss[0], miss[1]), reach.astray), null);
  assert.equal(fates[HERD_FATE_FLOATS], 1.0, 'a ball 9 m off starts it');
  assert.ok(reach.astray.has(1) && !reach.astray.has(count - 1));
  assert.deepEqual([...at(6000, 6000, 38)], [...reach.astray.keys()].sort((a, b) => a - b), 'a shot leagues off stands the astray and no other');
  reach.astray.clear();
  assert.equal(at(6000, 6000, 38).length, 0);

  // A street mount keeps to its way but may be anywhere along it: its reach is the whole way and the step's room aside.
  const way = caravanRiderWaySeeds([{ mode: 'rider', key: 'envoy', riders: 2, points: [0, 0, 160, 30, 260, 180] }], { x: 0, z: 0 }).mountSeeds;
  const wayReach = herdShotReach(way.seeds, way.routes);
  assert.equal(way.count, 2);
  assert.equal(herdAvoidSlack(way.seeds, 0), Infinity);
  for (let idx = 0; idx < way.count; idx++) {
    const rh = Math.round(way.seeds[idx * HERD_SEED_FLOATS]) * 4, samples = Math.round(way.routes[rh]);
    for (let k = 0; k < samples; k += 3) {
      for (let dir = 0; dir < 8; dir++) {
        const x = way.routes[rh + 8 + k * 4] + Math.cos(dir * Math.PI / 4) * HERD_MOUNT_AVOID_ASIDE_M, z = way.routes[rh + 10 + k * 4] + Math.sin(dir * Math.PI / 4) * HERD_MOUNT_AVOID_ASIDE_M;
        assert.ok(herdShotNear(wayReach, [x, 3, z], [x, 3, z], 0, 0, 0).includes(idx), `mount ${idx} aside of sample ${k} is within its reach`);
      }
    }
  }
  assert.equal(herdShotNear(wayReach, [900, 3, 900], [910, 3, 900]).length, 0);
});

// Townsfolk are drawn through the continuum alone, from bodies baked here (their streams are not committed).
test('mounted street riders lock < 1 mm on sloped banks, draw only through the continuum, skip offshore >3km crowds, and spawn zero horses in Indigenous towns', { skip: !crewContinuumBaked(townsfolkBodiesFor()) && 'continuum bodies not baked here' }, async (t) => {
  assert.equal(crowdFromBoard, boardFolkStreets);
  assert.equal(WALKER_MOUNTED_FLAG, STREET_MOUNT_FLAG);
  assert.match(TOWNSFOLK_WALK, /let isMounted=\(w\.flags&16u\)!=0u;/);

  // Steep lateral street bank: terrain rises sharply across Z so `elev(worldX, worldZ) > wayGroundY` on the right-hand lane!
  // Horse MUST lock to `wayGroundY` (NOT `max(groundY, wayGroundY)`) so horse.y === human.position.y!
  const centerlineHeightAt = (x, z) => 3.5 + 0.015 * x + 0.002 * z;
  const bankedTerrainHeightAt = (x, z) => centerlineHeightAt(x, z) + 0.65;
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

  const colonialStreets = boardFolkStreets({ plan, origin: { x: 200, z: 300 }, heightAt: centerlineHeightAt, indigenous: false });
  assert.ok(colonialStreets.mountSeeds && colonialStreets.mountSeeds.count >= 4);
  const words = new Uint32Array(colonialStreets.walkers.buffer);
  for (const idx of [0, 1, 2, 3]) {
    assert.ok((words[idx * WALKER_WORDS + 11] & WALKER_MOUNTED_FLAG) !== 0);
    assert.equal(colonialStreets.souls[idx].mounted, true);
  }
  assert.match(folkDoing(colonialStreets.souls[0], { stopped: false, walked: 30, back: false }, 160), /^riding to work/);

  const mSeeds = colonialStreets.mountSeeds.seeds;
  const mRoutes = colonialStreets.mountSeeds.routes;
  for (let m = 0; m < colonialStreets.mountSeeds.walkerIndices.length; m++) {
    const walkerIdx = colonialStreets.mountSeeds.walkerIndices[m];
    for (const clockSec of [0.5, 7.25, 19.8, 42.1, 88.6]) {
      const human = townWalkerStride(colonialStreets, walkerIdx, clockSec, 0.8);
      const horse = evaluateHerdStateAt(mSeeds, mRoutes, null, m, { time: clockSec, sunY: 0.8 }, bankedTerrainHeightAt);
      if (!human) {
        assert.equal(horse, null);
        continue;
      }
      assert.ok(horse);
      assert.equal(horse.species, 3);
      assert.equal(horse.hasTack, true);
      const drift = Math.hypot(human.position.x - horse.x, human.position.y - horse.y, human.position.z - horse.z);
      assert.ok(drift < 1e-3, `horse-rider 3D drift on banked street (${drift} m) must be < 1 mm at t=${clockSec}`);
    }
  }

  // Indigenous zero-horse guarantee
  const indigenousStreets = boardFolkStreets({ plan, origin: { x: 200, z: 300 }, heightAt: centerlineHeightAt, indigenous: true });
  assert.equal(indigenousStreets.mountSeeds.count, 0);
  const clearedMounts = assignStreetMountsToWalkers(
    { walkers: new Float32Array(colonialStreets.walkers), samples: colonialStreets.samples, people: colonialStreets.people },
    { indigenous: true },
  );
  assert.equal(clearedMounts.count, 0);
  assert.equal(buildStreetMountSeeds(colonialStreets, { indigenous: true }).count, 0);

  // Device coupling: the herds' step, the continuum's GPU reset and cut, its indirect lists, and offshore 3,000 m townsfolk culling
  crewContinuumGlobals(t);
  const prevStage = globalThis.GPUShaderStage, prevFetch = globalThis.fetch;
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // The animal atlas, served from the checkout as the page serves it.
  globalThis.fetch = async (path) => new Response(readFileSync(new URL(`../${path}`, import.meta.url)));
  t.after(() => {
    if (prevStage === undefined) delete globalThis.GPUShaderStage;
    else globalThis.GPUShaderStage = prevStage;
    globalThis.fetch = prevFetch;
  });

  const writes = [], indexedDraws = [], indirectDraws = [], dispatches = [];
  const device = crewContinuumDevice({
    createBuffer(d) { return { ...d, destroyed: false, destroy() { this.destroyed = true; } }; },
    queue: { writeBuffer(b) { writes.push(b.label); }, onSubmittedWorkDone: () => Promise.resolve() },
    createRenderPipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroupLayout: (d) => ({ ...d }),
    createPipelineLayout: (d) => ({ ...d }),
    createBindGroup: (d) => ({ ...d }),
  });
  const makePass = () => {
    let pipe = '';
    return {
      setPipeline(p) { pipe = p.label; },
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      dispatchWorkgroups(n) { dispatches.push({ pipe, n }); },
      dispatchWorkgroupsIndirect() { dispatches.push({ pipe }); },
      drawIndexedIndirect(_b, off) { indexedDraws.push({ pipe, off }); },
      drawIndirect(b, off) { indirectDraws.push({ pipe, buffer: b.label, off }); },
    };
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
  const townsfolk = await createTownsfolk({
    device,
    frameUBO: {},
    shader: async (code, label) => ({ code, label }),
    shared: { captainTexView: {}, captainSampler: {} },
    shadows: { bind: () => ({}), uniform: {} },
    fetchAsset: fetchCrewContinuumAsset,
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
  assert.equal(herds.streetMounts, colonialStreets.mountSeeds.count);
  assert.equal(herds.animals.count, herds.count, 'every installed beast is a place in the continuum set');

  // Every beast's body and fate are copied as the last step left them, the step places every beast reading its
  // neighbours from that copy, the GPU empties and refills the continuum's lists, and one pipeline draws the view's
  // four lists (clusters, small clusters, far body, splat) and one the shadow map's far bodies, all indirect.
  writes.length = 0; dispatches.length = 0; indexedDraws.length = 0; indirectDraws.length = 0;
  herds.encode(makePass(), 7.25);
  herds.draw(makePass());
  herds.drawShadow(makePass());
  assert.ok(!writes.includes('livestock continuum draws') && !writes.includes('livestock continuum lists'), 'the GPU resets the lists and draws without writeBuffer');
  assert.deepEqual(dispatches.map((d) => d.pipe), ['livestock herds seen', 'livestock herds step', 'continuum reset', 'continuum cut']);
  assert.equal(dispatches[0].n, dispatches[1].n, 'the copy covers every beast the step places');
  assert.equal(indexedDraws.length, 0, 'herds draw no indexed meshes');
  assert.deepEqual(indirectDraws.filter((d) => d.pipe === 'livestock herds').map((d) => d.off), [0, 16, 32, 48], 'the view draws the four continuum lists');
  assert.deepEqual(indirectDraws.filter((d) => d.pipe === 'livestock herds shadow').map((d) => d.off), [64], 'the shadow map draws the fifth');
  assert.ok(indirectDraws.every((d) => d.buffer === 'livestock continuum draws'));
  assert.equal(indirectDraws.length, 5);

  // Verify townsfolk skips encode/draw/drawShadow when camera moves > 3,000 m offshore (e.g. 3,100 m away within 3,200 m reach)
  townsfolk.follow([lisbonPort], { x: 3310, z: 300 }); // 3,110 m > 3,000 m
  dispatches.length = 0; indexedDraws.length = 0; indirectDraws.length = 0;
  townsfolk.encode(makePass(), Date.now());
  townsfolk.draw(makePass());
  townsfolk.drawShadow(makePass());
  assert.equal(dispatches.length, 0, 'townsfolk skips compute when > 3,000 m offshore');
  assert.equal(indexedDraws.length + indirectDraws.length, 0, 'townsfolk skips draw/drawShadow when > 3,000 m offshore');
  townsfolk.follow([lisbonPort], { x: 200, z: 300 });

  // Fire a cannonball across a mounted courier on Rua Nova
  herds.setSimClock(7.25);
  const riderPos = townWalkerStride(lisbonPort.streets, 0, 7.25, 0.8).position;
  // A ball out at sea sweeps no beast's reach: none is stood for it, and it takes none of the step's places. Where the
  // land is not given the world's shift is unknown, and the step is sent the shot all the same.
  const atSea = [[riderPos.x + 4000, 3, riderPos.z], [riderPos.x + 4010, 3, riderPos.z]];
  writes.length = 0;
  assert.equal(herds.watchShot(atSea[0], atSea[1], { fraction: 1 }, { radius: 0.09 }, { surfaceHeight: centerlineHeightAt, getWorldOffset: () => ({ x: 0, z: 0 }) }), null);
  herds.encode(makePass(), 7.25);
  assert.ok(!writes.includes('livestock shots'), 'a shot clear of every reach is not sent to the step');
  assert.equal(herds.watchShot(atSea[0], atSea[1], { fraction: 1 }, { radius: 0.09 }), null);
  herds.encode(makePass(), 7.25);
  assert.ok(writes.includes('livestock shots'), 'a shot is sent to the step when the land, and so the shift, is not given');
  herds.encode(makePass(), 7.25);
  writes.length = 0;
  const best = { fraction: 1, distance: 40 };
  const mountHit = herds.watchShot(
    [riderPos.x - 10, riderPos.y + 1.1, riderPos.z],
    [riderPos.x + 10, riderPos.y + 1.1, riderPos.z],
    best,
    { radius: 0.09, mass: 10.9, velocity: [220, 0, 0] },
    { surfaceHeight: centerlineHeightAt, getWorldOffset: () => ({ x: 0, z: 0 }) },
  );
  lisbonPort.townsfolkWatch(
    [riderPos.x - 10, riderPos.y + 1.1, riderPos.z],
    [riderPos.x + 10, riderPos.y + 1.1, riderPos.z],
    mountHit,
    { radius: 0.09, mass: 10.9, velocity: [220, 0, 0] },
  );
  assert.equal(mountHit?.kind, 'livestock');
  assert.equal(mountHit?.species, 3);
  assert.equal(herds.fates[mountHit.herdIndex * HERD_FATE_FLOATS], 2.0);
  herds.encode(makePass(), 7.25);
  assert.ok(writes.includes('livestock shots'), 'the shot that swept a mount\'s way is sent to the step');

  // Visiting pre-contact Maguana clears all street horses to strictly zero
  for (let k = 0; k < 45; k++) townsfolk.follow([lisbonPort, tainoPort], { x: 5000, z: 0 });
  assert.equal(herds.streetMounts, 0);
  assert.equal(herds.count, 0);
  assert.match(HERDS_STEP_WGSL, /let\s+isVehicle\s*=\s*species\s*>=\s*4u\s*;/);

  // Maguana's own pair of bodies was asked for on the way in: it comes before the town is let go.
  await loadCrewContinuumBodies(device, townsfolkBodiesFor('caribbean'), { fetchAsset: fetchCrewContinuumAsset });
  townsfolk.destroy();
  herds.destroy();
});
