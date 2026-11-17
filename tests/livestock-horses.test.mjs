// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Verification of Tripo H3.1 4K livestock progressive half-edge collapse continuum (`morphWords` + `RGB555` coats),
// crack-free seam welding, 1550 Lusitano `sela à gineta` saddle & tack contour fit, 0.00 m horse-rider saddle contact
// & sloped-street ground lock, TBDR Early-Z `herdsSolidFS`, active-species draw skipping, and GPU draw-reset passes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { loadCrewGLB } from '../js/gltf.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
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
  HERD_BUCKETS,
  HERD_FADE_BUCKET,
  HERD_FATE_FLOATS,
  HERDS_RENDER_WGSL,
  HERDS_RESET_WGSL,
  HERDS_SHADOW_WGSL,
  HERDS_STEP_WGSL,
} from '../js/wgsl/herds.js';
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
import { assignStreetMountsToWalkers, createTownsfolk } from '../js/townsfolk.js';
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

test('Tripo H3.1 4K livestock continuum packs RGB555 coats, crack-free manifolds, <= 8 storage buffers, and TBDR Early-Z herdsSolidFS', () => {
  assert.equal(HERD_BODY_FLOATS, 16, 'HerdBody is 4x vec4f (64 bytes)');
  assert.equal(HERD_FADE_BUCKET, 15);
  assert.equal(HERD_BUCKETS, 22);
  assert.doesNotMatch(HERDS_STEP_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(HERDS_RENDER_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(HERDS_SHADOW_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(HERDS_RESET_WGSL, /\bdiscard\b/);
  assert.ok(countStorageBindings(HERDS_STEP_WGSL) <= 8, `step storage buffers <= 8 (${countStorageBindings(HERDS_STEP_WGSL)})`);
  assert.ok(countStorageBindings(HERDS_RENDER_WGSL) <= 8, `render storage buffers <= 8 (${countStorageBindings(HERDS_RENDER_WGSL)})`);
  assert.ok(countStorageBindings(HERDS_SHADOW_WGSL) <= 8, `shadow storage buffers <= 8 (${countStorageBindings(HERDS_SHADOW_WGSL)})`);
  assert.ok(countStorageBindings(HERDS_RESET_WGSL) <= 8, `reset storage buffers <= 8 (${countStorageBindings(HERDS_RESET_WGSL)})`);
  assert.ok(countStorageBindings(TOWNSFOLK_RESET) <= 8, `townsfolk reset storage buffers <= 8`);
  assert.match(HERDS_RENDER_WGSL, /@group\(0\)\s*@binding\(18\)\s*var<storage,\s*read>\s*herdMorph/);
  assert.match(HERDS_SHADOW_WGSL, /@group\(0\)\s*@binding\(4\)\s*var<storage,\s*read>\s*herdMorph/);

  // Verify herdsSolidFS has ZERO @builtin(sample_mask) so Apple Silicon TBDR Early-Z / HSR stays active on solid instances!
  const solidMatch = /@fragment\s+fn\s+herdsSolidFS\s*\([^)]*\)\s*->\s*([^{]+)\{([^}]*)\}/.exec(HERDS_RENDER_WGSL);
  assert.ok(solidMatch, 'herdsSolidFS entry point defined in HERDS_RENDER_WGSL');
  assert.match(solidMatch[1], /@location\(0\)\s*vec4f/, 'herdsSolidFS returns plain @location(0) vec4f without HerdFragOut');
  assert.doesNotMatch(solidMatch[0], /sample_mask/, 'herdsSolidFS has strictly zero sample_mask');
  assert.match(HERDS_RENDER_WGSL, /@fragment\s+fn\s+herdsFadeFS\s*\([^)]*\)\s*->\s*HerdFragOut/, 'herdsFadeFS retains MSAA sample_mask crossfade');
  assert.match(HERDS_STEP_WGSL, /pxSpan\s*>=\s*CONTINUUM_SPLAT_BAND_PIXELS/, 'HERDS_STEP_WGSL splits solid (above the core\'s splat band) vs fade (in it) buckets');

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
    assert.equal(sp.morphWords.length, vc * 2, `${sp.name}: 2 morphWords per vertex`);

    // Verify single sheep extraction (no twin sheep!) & grounded hooves + RGB555 4K texture vertex colors
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const distinctColors = new Set();
    let bodyVerts = 0, rgbVerts = 0;
    for (let i = 0; i < vc; i++) {
      const o = i * 8;
      const x = sp.vertices[o], y = sp.vertices[o + 1], part = sp.vertices[o + 6], coat = sp.vertices[o + 7];
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

    const morphBuf = buildLivestockMorphBuffer(sp, false);
    assert.equal(morphBuf.length, vc * 8);

    const m0 = evaluateLivestockMorph(sp, 0.0, morphBuf);
    const mMid = evaluateLivestockMorph(sp, 0.5, morphBuf);
    const mFull = evaluateLivestockMorph(sp, 1.0, morphBuf);

    // Verify welded crack-free manifold (zero UV-seam cracks!) at full detail and mid-continuum
    const seam0 = countBodyBoundaryEdges(sp, m0.positions);
    const seamMid = countBodyBoundaryEdges(sp, mMid.positions);
    assert.ok(seam0.boundary <= 12, `${sp.name}: crack-free welded UV seams at morph=0 (${seam0.boundary}/${seam0.uniqueEdges} boundary edges)`);
    assert.ok(seamMid.boundary <= 16, `${sp.name}: crack-free continuum under evaluateLivestockMorph (${seamMid.boundary} boundary edges)`);

    assert.equal(m0.activeTriangles, tris, `${sp.name}: full triangles at morphLevel=0`);
    assert.ok(mMid.activeTriangles < m0.activeTriangles * 0.72 && mMid.activeTriangles > 350, `${sp.name}: smooth mid-continuum (${mMid.activeTriangles} tris)`);
    assert.equal(mFull.activeTriangles, 20, `${sp.name}: reaches exact 20-triangle core at morphLevel=1`);
    assert.equal(sp.coreTris, 20);
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

test('mounted street riders lock < 1 mm on sloped banks, skip zero-population species & offshore >3km crowds, and spawn zero horses in Indigenous towns', async (t) => {
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

  // Device coupling + activeSpeciesMask draw skipping + GPU reset + offshore 3,000 m townsfolk culling
  const prevUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { VERTEX: 1, INDEX: 2, UNIFORM: 4, STORAGE: 8, COPY_DST: 16, INDIRECT: 32 };
  t.after(() => {
    if (prevUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = prevUsage;
  });

  const writes = [], indexedDraws = [], dispatches = [];
  const device = {
    createBuffer(d) { return { ...d, destroyed: false, destroy() { this.destroyed = true; } }; },
    queue: { writeBuffer(b) { writes.push(b.label); }, onSubmittedWorkDone: () => Promise.resolve() },
    createRenderPipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async (d) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => ({ ...d }),
  };
  const makePass = () => {
    let pipe = '';
    return {
      setPipeline(p) { pipe = p.label; },
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      dispatchWorkgroups(n) { dispatches.push({ pipe, n }); },
      drawIndexedIndirect(_b, off) { indexedDraws.push({ pipe, off }); },
      drawIndirect() {},
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
  assert.equal(herds.streetMounts, colonialStreets.mountSeeds.count);
  assert.equal(herds.activeSpeciesMask, 1 << 3, 'only species 3 (horses) active when only street mounts are installed');

  // Verify herds skips all 6 unpopulated species in draw & drawShadow and uses GPU compute reset!
  writes.length = 0; dispatches.length = 0; indexedDraws.length = 0;
  herds.encode(makePass(), 7.25);
  herds.draw(makePass());
  herds.drawShadow(makePass());
  assert.ok(!writes.includes('livestock indirect draws'), 'herds resets indirect draws on GPU without writeBuffer');
  assert.equal(dispatches[0].pipe, 'livestock herds reset');
  assert.equal(indexedDraws.filter((d) => d.pipe === 'livestock herds solid').length, 1, 'only 1 active species drawn in solid pass');
  assert.equal(indexedDraws.filter((d) => d.pipe === 'livestock herds fade').length, 1, 'only 1 active species drawn in fade pass');
  assert.equal(indexedDraws.filter((d) => d.pipe === 'livestock herds shadow').length, 1, 'only 1 active species drawn in shadow pass');

  // Verify townsfolk skips encode/draw/drawShadow when camera moves > 3,000 m offshore (e.g. 3,100 m away within 3,200 m reach)
  townsfolk.follow([lisbonPort], { x: 3310, z: 300 }); // 3,110 m > 3,000 m
  dispatches.length = 0; indexedDraws.length = 0;
  townsfolk.encode(makePass(), Date.now());
  townsfolk.draw(makePass());
  townsfolk.drawShadow(makePass());
  assert.equal(dispatches.length, 0, 'townsfolk skips compute when > 3,000 m offshore');
  assert.equal(indexedDraws.length, 0, 'townsfolk skips draw/drawShadow when > 3,000 m offshore');
  townsfolk.follow([lisbonPort], { x: 200, z: 300 });

  // Fire a cannonball across a mounted courier on Rua Nova
  herds.setSimClock(7.25);
  const riderPos = townWalkerStride(lisbonPort.streets, 0, 7.25, 0.8).position;
  const best = { fraction: 1, distance: 40 };
  const mountHit = herds.watchShot(
    [riderPos.x - 10, riderPos.y + 1.1, riderPos.z],
    [riderPos.x + 10, riderPos.y + 1.1, riderPos.z],
    best,
    { radius: 0.09, mass: 10.9, velocity: [220, 0, 0] },
    { surfaceHeight: centerlineHeightAt },
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

  // Visiting pre-contact Maguana clears all street horses to strictly zero
  for (let k = 0; k < 45; k++) townsfolk.follow([lisbonPort, tainoPort], { x: 5000, z: 0 });
  assert.equal(herds.streetMounts, 0);
  assert.equal(herds.count, 0);
  assert.match(HERDS_RENDER_WGSL, /let\s+isVehicle\s*=\s*body\.slopeScale\.w\s*>=\s*3\.99\s*;/);

  townsfolk.destroy();
  herds.destroy();
});
