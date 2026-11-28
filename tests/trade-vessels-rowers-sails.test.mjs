import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCrewGLB } from '../js/gltf.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import {
  TRADE_VESSEL_ARCHETYPES,
  MAX_TRADE_VESSELS,
  getTradeVesselArchetype,
  inspectTradeVesselArchetypes,
  bargeOarPivotsForWGSL,
  bakeDeckCrewClips,
  buildTradeVesselRoutes,
  sampleTradeVesselState,
  createVesselAutopilotState,
  assignHarborBerthsAndQueue,
  stepTradeVesselAutopilot,
  REST_TO_POSED_WGSL,
  TRADE_VESSEL_CONTINUUM_MATERIAL,
  TRADE_VESSEL_WAVE_WGSL,
  DECK_CREW_PLACE_WGSL,
} from '../js/trade-vessels.js';
import { continuumModuleWGSL } from '../js/wgsl/continuum-cut.js';

// The trade vessels as the one cut draws them: their material's view, the DRAPED kind posing a whole vessel's canvas,
// oars and helm within it (js/wgsl/ship-kinds.js).
const TRADE_VESSEL_VIEW = continuumModuleWGSL({ pass: 'view', material: TRADE_VESSEL_CONTINUUM_MATERIAL });

function groupTriangleBounds(arch, group) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const verts = arch.vertices;
  const inds = arch.indices;
  const end = Math.min(inds.length, group.firstVertex + group.vertexCount);
  let triCount = 0;
  for (let i = group.firstVertex; i + 2 < end; i += 3) {
    triCount++;
    for (let k = 0; k < 3; k++) {
      const o = inds[i + k] * 9;
      for (let c = 0; c < 3; c++) {
        if (verts[o + c] < min[c]) min[c] = verts[o + c];
        if (verts[o + c] > max[c]) max[c] = verts[o + c];
      }
    }
  }
  return { min, max, triCount };
}

test('Archetype 4 river barge keeps only 4 active wooden thwarts, dry raised sole, gangway cargo, neutral sweep oars, and zero-jackknife adult oarsmen', () => {
  const barge = getTradeVesselArchetype(4);
  const ds = barge.designScale;
  const verts = barge.vertices;
  const inds = barge.indices;
  const pivots = bargeOarPivotsForWGSL();

  // 1. Exactly 4 physical wooden thwarts (#2, #5, #8, #11) remain in `rowing.benches`
  const benchGroup = barge.groups.find((g) => g.id === 'rowing.benches');
  assert.ok(benchGroup && benchGroup.vertexCount > 0, 'rowing.benches group exists');
  const benchTriZs = [];
  for (let i = benchGroup.firstVertex; i + 2 < benchGroup.firstVertex + benchGroup.vertexCount; i += 3) {
    const i0 = inds[i], i1 = inds[i + 1], i2 = inds[i + 2];
    const czM = ((verts[i0 * 9 + 2] + verts[i1 * 9 + 2] + verts[i2 * 9 + 2]) / 3) * ds[2];
    const topYM = Math.max(verts[i0 * 9 + 1], verts[i1 * 9 + 1], verts[i2 * 9 + 1]) * ds[1];
    benchTriZs.push({ czM, topYM });
  }
  benchTriZs.sort((a, b) => a.czM - b.czM);
  const benchClusters = [];
  for (const tri of benchTriZs) {
    const last = benchClusters[benchClusters.length - 1];
    if (!last || tri.czM - last.maxZ > 0.35) {
      benchClusters.push({ minZ: tri.czM, maxZ: tri.czM, maxTopY: tri.topYM, count: 1 });
    } else {
      last.maxZ = Math.max(last.maxZ, tri.czM);
      last.maxTopY = Math.max(last.maxTopY, tri.topYM);
      last.count++;
    }
  }
  assert.equal(benchClusters.length, 4, `expected exactly 4 active wooden thwarts, found ${benchClusters.length}`);
  const benchMidZs = benchClusters.map((c) => (c.minZ + c.maxZ) * 0.5);

  // 2. Raised dry floorboards (>= +0.23 m hull metres -> >= +0.20 m dry above inlandWater), offset dunnage & stores with zero -y coplanar faces
  const floorGrp = barge.groups.find((g) => g.id === 'deck.floorboards');
  assert.ok(floorGrp && floorGrp.vertexCount > 0, 'deck.floorboards exists');
  const floorB = groupTriangleBounds(barge, floorGrp);
  const minFloorHullM = floorB.min[1] * ds[1];
  assert.ok(minFloorHullM >= 0.23, `raised barge floorboards (${minFloorHullM.toFixed(3)} m) stay >= +0.20 m dry above river level`);

  for (const g of barge.groups) {
    if (g.id.startsWith('deck.dunnage.') || g.id === 'deck.stores') {
      for (let i = g.firstVertex; i + 2 < g.firstVertex + g.vertexCount; i += 3) {
        const i0 = inds[i], i1 = inds[i + 1], i2 = inds[i + 2];
        const ny = (verts[i0 * 9 + 4] + verts[i1 * 9 + 4] + verts[i2 * 9 + 4]) / 3;
        const cyM = ((verts[i0 * 9 + 1] + verts[i1 * 9 + 1] + verts[i2 * 9 + 1]) / 3) * ds[1];
        assert.ok(!(ny < -0.82 && cyM < minFloorHullM + 0.04), `no coplanar bottom -y face in ${g.id}`);
      }
    }
    if (g.id.startsWith('cargo.') && !g.id.startsWith('cargo.coil.')) {
      const cb = groupTriangleBounds(barge, g);
      const maxCargoAbsXM = Math.max(Math.abs(cb.min[0]), Math.abs(cb.max[0])) * ds[0];
      assert.ok(maxCargoAbsXM <= 0.42, `${g.id} stays within central gangway |x| <= 0.42 m (got ${maxCargoAbsXM.toFixed(3)} m)`);
      for (const bz of benchMidZs) {
        const minZM = cb.min[2] * ds[2], maxZM = cb.max[2] * ds[2];
        assert.ok(maxZM < bz - 0.14 || minZM > bz + 0.14, `${g.id} [${minZM.toFixed(2)}, ${maxZM.toFixed(2)}] does not slice bench at z=${bz.toFixed(2)} m`);
      }
    }
  }

  // 3. Neutral athwartships rest pose (sweep = 0) on all 8 active barge oars
  const oarPropulsors = barge.groups.filter((g) => g.id.startsWith('rowing.propulsor.rower.'));
  assert.equal(oarPropulsors.length, 8, 'exactly 8 active barge sweep oars');
  for (const og of oarPropulsors) {
    const ob = groupTriangleBounds(barge, og);
    const v0 = inds[og.firstVertex] * 9;
    const m = verts[v0 + 6];
    const stIdx = Math.round((m - 16) * 64) - 1;
    const pz = pivots[stIdx * 4 + 2];
    const side = pivots[stIdx * 4 + 3];
    const midZ = (ob.min[2] + ob.max[2]) * 0.5;
    assert.ok(Math.abs(midZ - pz) < 0.02, `${og.id} rests athwartships at sweep=0 (midZ=${midZ.toFixed(3)} vs pz=${pz.toFixed(3)})`);
    const inboardTipXM = (side > 0 ? ob.min[0] : ob.max[0]) * ds[0];
    assert.ok(Math.abs(inboardTipXM) >= 0.42 && Math.abs(inboardTipXM) <= 0.68, `${og.id} inboard grip extends naturally to |x|=${Math.abs(inboardTipXM).toFixed(3)} m`);
    assert.ok(ob.min[1] * ds[1] < 0.0, `${og.id} outboard blade dips toward waterline (minY=${(ob.min[1] * ds[1]).toFixed(3)} m)`);
  }

  // 4. All 8 seated oarsmen align within <= 0.14 m of the 4 wooden thwarts with yaw === 0 and adult scale
  const rowStations = barge.deckStations.filter((s) => s.role === 'oarsman');
  assert.equal(rowStations.length, 8, '8 seated oarsman stations');
  for (const st of rowStations) {
    assert.equal(st.yaw, 0, `${st.station} faces straight aft (+Z, yaw === 0)`);
    const nearestBench = benchClusters.reduce((best, c) => {
      const mid = (c.minZ + c.maxZ) * 0.5;
      return Math.abs(st.z - mid) < Math.abs(st.z - best.mid) ? { ...c, mid } : best;
    }, { ...benchClusters[0], mid: (benchClusters[0].minZ + benchClusters[0].maxZ) * 0.5 });
    const zErr = Math.abs(st.z - nearestBench.mid);
    assert.ok(zErr <= 0.14, `${st.station} pelvis Z (${st.z.toFixed(3)} m) sits squarely on wooden bench (${nearestBench.mid.toFixed(3)} m, err=${zErr.toFixed(3)} m <= 0.14 m)`);
    assert.ok(st.seatHeightMetres >= 0.23 && st.seatHeightMetres <= 0.29, `${st.station} seatHeightMetres=${st.seatHeightMetres.toFixed(3)} m`);
    const buttTopM = st.y + st.seatHeightMetres;
    assert.ok(Math.abs(buttTopM - nearestBench.maxTopY) <= 0.03, `${st.station} butt rests directly on bench top (${buttTopM.toFixed(3)} vs ${nearestBench.maxTopY.toFixed(3)} m)`);
  }
  for (const standRole of ['pilot', 'merchant']) {
    const st = barge.deckStations.find((s) => s.role === standRole);
    assert.ok(st, `${standRole} station exists`);
    for (const bz of benchMidZs) {
      assert.ok(Math.abs(st.z - bz) > 0.30, `${standRole} at z=${st.z.toFixed(3)} m stands clear of bench at z=${bz.toFixed(3)} m`);
    }
  }

  // Adult human crewBodyScale === 1.0 where each deck hand is placed (never miniature scaleMul): the station scales
  // with the hull, the body never does.
  assert.match(DECK_CREW_PLACE_WGSL, /let\s+crewBodyScale\s*=\s*1\.0\s*;/);
  assert.doesNotMatch(DECK_CREW_PLACE_WGSL, /select\s*\(\s*1\.0\s*,\s*scaleMul/);

  // 5. Bake Clips 4 & 5 and verify zero spine jackknife (`neck_01.y > spine_03.y + 0.10`), natural spine rock, level shoulders, and forward-of-chest hands across all 24 frames
  const sailor = loadCrewGLB(readFileSync(new URL('../assets/crew/sailor.glb', import.meta.url)));
  const a = sailor.animator;
  a.sample(null, 0);
  const restWorldByNode = a.world.map((w) => Float32Array.from(w.subarray(12, 15)));
  const jointPosFromPalette = (pal, nodeName) => {
    const ni = a.nodeIndex(nodeName);
    const slot = a.joints.indexOf(ni);
    const rest = restWorldByNode[ni];
    const m = pal.subarray(slot * 16, slot * 16 + 16);
    return [
      m[0] * rest[0] + m[4] * rest[1] + m[8] * rest[2] + m[12],
      m[1] * rest[0] + m[5] * rest[1] + m[9] * rest[2] + m[13],
      m[2] * rest[0] + m[6] * rest[1] + m[10] * rest[2] + m[14],
    ];
  };
  const { palettes, layout } = bakeDeckCrewClips(a);
  for (const [label, clipSlot] of [['Clip 4 (port row)', 8], ['Clip 5 (stbd row)', 10]]) {
    const start = layout[clipSlot];
    const count = layout[clipSlot + 1];
    assert.equal(count, 24, `${label} has 24 frames`);
    for (let f = 0; f < count; f++) {
      const pal = palettes.subarray((start + f) * CREW_JOINT_COUNT * 16, (start + f + 1) * CREW_JOINT_COUNT * 16);
      const neck = jointPosFromPalette(pal, 'neck_01');
      const spine3 = jointPosFromPalette(pal, 'spine_03');
      const pelvis = jointPosFromPalette(pal, 'pelvis');
      const shL = jointPosFromPalette(pal, 'upperarm_l');
      const shR = jointPosFromPalette(pal, 'upperarm_r');
      const handL = jointPosFromPalette(pal, 'hand_l');
      const handR = jointPosFromPalette(pal, 'hand_r');
      assert.ok(
        neck[1] > spine3[1] + 0.10,
        `${label} frame ${f}: neck_01.y (${neck[1].toFixed(3)}) > spine_03.y + 0.10 (${(spine3[1] + 0.10).toFixed(3)})`,
      );
      const shDiff = Math.abs(shL[1] - shR[1]);
      assert.ok(shDiff < 0.035, `${label} frame ${f}: shoulders stay level (|shL.y - shR.y| = ${shDiff.toFixed(4)} m < 0.035 m)`);
      const spineDeg = (Math.atan2(spine3[2] - pelvis[2], spine3[1] - pelvis[1]) * 180) / Math.PI;
      assert.ok(spineDeg >= -12.5 && spineDeg <= 18.5, `${label} frame ${f}: natural spine rock ${spineDeg.toFixed(2)} deg in [-12, +18]`);
      assert.ok(handL[2] > pelvis[2] + 0.06 && handR[2] > pelvis[2] + 0.06, `${label} frame ${f}: both hands stay in front of torso (handL.z=${handL[2].toFixed(3)}, handR.z=${handR[2].toFixed(3)}, pelvis.z=${pelvis[2].toFixed(3)})`);
    }
  }
});

test('Archetypes 0..6 retain 3-mast Cog, moored furled sail bundles, 3D cambered square & lateen sails, and authentic single-mast Harbor Barque', () => {
  const archs = inspectTradeVesselArchetypes();
  assert.equal(archs.length, TRADE_VESSEL_ARCHETYPES);

  // 1. Archetypes 0 & 1 (Cog / Pinta): 18.6 x 5.7 m and all 3 authentic masts (`fore`, `main`, `mizzen`)
  for (const idx of [0, 1]) {
    const cog = archs[idx];
    assert.equal(cog.length, 18.6);
    assert.equal(cog.beam, 5.7);
    for (const mastId of ['mast.fore', 'mast.main', 'mast.mizzen']) {
      const mg = cog.groups.find((g) => g.id === mastId);
      assert.ok(mg && mg.vertexCount > 0, `Archetype ${idx} (${cog.label}) retains ${mastId}`);
    }
  }
  assert.match(TRADE_VESSEL_VIEW, /isCastleWall[\s\S]{0,80}p\.y\s*>\s*1\.85/, 'castle framing restricted to elevated bulkheads p.y > 1.85');

  // 2. Archetypes 1 & 3 (Moored Cog & Carrack): non-empty `sail.furled.*` bundles following true yard slopes
  for (const [idx, expectedFurled] of [
    [1, ['sail.furled.fore-course', 'sail.furled.main-course', 'sail.furled.mizzen-lateen']],
    [3, ['sail.furled.fore-course', 'sail.furled.main-course', 'sail.furled.mizzen-lateen', 'sail.furled.main-topsail', 'sail.furled.spritsail']],
  ]) {
    const moored = archs[idx];
    for (const fid of expectedFurled) {
      const fg = moored.groups.find((g) => g.id === fid);
      assert.ok(fg && fg.vertexCount >= 60, `Archetype ${idx} (${moored.label}) has physical ${fid} triangles (${fg?.vertexCount})`);
    }
    const furledMiz = moored.groups.find((g) => g.id === 'sail.furled.mizzen-lateen');
    const yardMiz = moored.groups.find((g) => g.id === 'yard.mizzen-lateen');
    const fb = groupTriangleBounds(moored, furledMiz);
    const yb = groupTriangleBounds(moored, yardMiz);
    const fSlope = (fb.max[1] - fb.min[1]) / Math.max(0.1, fb.max[2] - fb.min[2]);
    const ySlope = (yb.max[1] - yb.min[1]) / Math.max(0.1, yb.max[2] - yb.min[2]);
    assert.ok(Math.abs(fSlope - ySlope) < 0.22, `Archetype ${idx} furled mizzen bundle slope (${fSlope.toFixed(2)}) matches lateen yard slope (${ySlope.toFixed(2)})`);
  }

  // 3. Archetypes 0 & 2: square sails + bolt-ropes have real 3D forward (-Z) camber (> 0.20 m)
  for (const idx of [0, 2]) {
    const a = archs[idx];
    const dzScale = a.designScale[2];
    const sqGroups = a.groups.filter((g) => /^sail\.(?:fore-course|main-course|main-topsail|spritsail)(?:\.edge)?$/.test(g.id));
    assert.ok(sqGroups.length >= 4);
    for (const sg of sqGroups) {
      const sb = groupTriangleBounds(a, sg);
      const depthZM = (sb.max[2] - sb.min[2]) * dzScale;
      assert.ok(depthZM > 0.25, `Archetype ${idx} ${sg.id} has genuine 3D Z camber (${depthZM.toFixed(3)} m > 0.20 m)`);
    }
  }

  // 4. Archetypes 0, 2, 5, 6: lateen yards & sails clear wooden masts in +X and carry 3D leeward camber
  for (const idx of [0, 2, 5, 6]) {
    const a = archs[idx];
    const dxScale = a.designScale[0];
    const lateenYards = a.groups.filter((g) => /^yard\.(?:mizzen-lateen|fore|main|mizzen)$/.test(g.id) && g.vertexCount > 0);
    assert.ok(lateenYards.length >= 1);
    for (const yg of lateenYards) {
      const yb = groupTriangleBounds(a, yg);
      assert.ok(yb.min[0] > 0.12, `Archetype ${idx} ${yg.id} clears mast centerline (minX=${yb.min[0].toFixed(3)} > 0.12 design)`);
    }
    const lateenSails = a.groups.filter((g) => /^sail\.(?:mizzen-lateen|(?:fore|main|mizzen)\.(?:canvas|edge))(?:\.edge)?$/.test(g.id) && g.vertexCount > 0);
    assert.ok(lateenSails.length >= 2);
    for (const sg of lateenSails) {
      const sb = groupTriangleBounds(a, sg);
      assert.ok(sb.min[0] > 0.15, `Archetype ${idx} ${sg.id} clears mast at X=0 (minX=${sb.min[0].toFixed(3)})`);
      assert.ok((sb.max[0] - sb.min[0]) * dxScale > 0.22, `Archetype ${idx} ${sg.id} has 3D leeward X camber`);
    }
  }

  // 5. Archetype 6 (Harbor Barque): pruned bowsprit overhang, forward-stepped mainmast, forestay & shrouds
  const barque = archs[6];
  assert.ok(!barque.groups.some((g) => g.id === 'rig.stay-attachments'), 'Harbor Barque drops orphaned rig.stay-attachments');
  const bowGrp = barque.groups.find((g) => g.id === 'bow.structure');
  if (bowGrp) {
    const bb = groupTriangleBounds(barque, bowGrp);
    assert.ok(bb.min[2] >= -4.25, `Harbor Barque bow.structure overhang pruned cleanly (minZ=${bb.min[2].toFixed(2)} >= -4.25)`);
  }
  const barqueMast = barque.groups.find((g) => g.id === 'mast.main');
  const mb = groupTriangleBounds(barque, barqueMast);
  const mastMidZ = (mb.min[2] + mb.max[2]) * 0.5;
  assert.ok(mastMidZ < 0.95, `Harbor Barque mast.main stepped forward toward midships balance (midZ=${mastMidZ.toFixed(2)})`);
  assert.ok(barque.groups.some((g) => g.id === 'rig.standing.barque' && g.vertexCount > 0), 'Harbor Barque has forestay & gunwale shrouds');
  assert.ok(barque.groups.some((g) => g.id === 'rig.running.barque' && g.vertexCount > 0), 'Harbor Barque has tack/halyard/sheet lines');

  // 6. GPU Sail Brail WGSL handles m == 9u, 13u, and 19u bolt-ropes using exact yard tables: the DRAPED kind's, read
  // from each archetype's block of the pose buffer, and a damaged vessel's rest pose's own
  assert.match(TRADE_VESSEL_VIEW, /m\s*!=\s*9u\s*&&\s*m\s*!=\s*13u\s*&&\s*m\s*!=\s*19u/);
  assert.match(TRADE_VESSEL_VIEW, /fn\s+shipDrapedBrail\(/);
  assert.match(REST_TO_POSED_WGSL, /SAIL_BRAIL_A/);
});

test('Zero-flicker traffic invariants: no duplicate crew.sweep, caravan turnaround, berth >=42m deduplication, MAX_TRADE_VESSELS cap, river starboard lanes, and zero-discard WGSL', () => {
  // 1. No duplicate `crew.sweep` on Archetypes 4 & 6
  for (const idx of [4, 6]) {
    const arch = getTradeVesselArchetype(idx);
    assert.ok(!arch.groups.some((g) => g.id === 'crew.sweep'), `Archetype ${idx} (${arch.label}) has zero duplicate crew.sweep`);
  }
  assert.ok(getTradeVesselArchetype(4).groups.some((g) => g.id === 'helm.steering-oar'), 'Arch 4 retains authentic lusoria helm.steering-oar');
  assert.ok(getTradeVesselArchetype(6).groups.some((g) => g.id === 'helm.tiller'), 'Arch 6 retains authentic nina helm.tiller');

  // 2. Caravan turnaround in `stepTradeVesselAutopilot` prevents stacking at river mouth endpoints
  const caravanPts = [
    { x: 0, y: 0, z: 0, acc: 0 },
    { x: 0, y: 0, z: -120, acc: 120 },
    { x: 0, y: 0, z: -240, acc: 240 },
  ];
  const cRouteA = { id: 'caravan:a', mode: 'sea', phase: 'caravan', archetype: 0, scale: 0.94, depart: 0, arrive: 1, totalLen: 240, pts: caravanPts, phaseOffset: 0.1 };
  const cRouteB = { id: 'caravan:b', mode: 'sea', phase: 'caravan', archetype: 0, scale: 0.94, depart: 0, arrive: 1, totalLen: 240, pts: caravanPts, phaseOffset: 0.55 };
  const sA = sampleTradeVesselState(cRouteA, 5.0, 0.01, 0);
  const sB = sampleTradeVesselState(cRouteB, 5.0, 0.01, 0);
  assert.ok(Math.hypot(sA.x - sB.x, sA.z - sB.z) > 30, 'completed sea caravans do not spawn stacked at 0.000 m');

  const aiC = createVesselAutopilotState(cRouteA, 0, { x: 0, y: 0, z: -232, yaw: 0, speed: 3.0, motion: 1.0, phase: 0 }, 0);
  aiC.wpIndex = 2;
  aiC.dirSign = 1;
  stepTradeVesselAutopilot(aiC, cRouteA, 0, 2.0, { windVec: [0, -8], elapsedSec: 2 });
  assert.equal(aiC.dirSign, -1, 'sea caravan reverses dirSign cleanly upon reaching endpoint instead of trapping at river mouth');

  // 3. Docked `ship:*` berth deduplication (>= 42 m minimum spacing) + strict `MAX_TRADE_VESSELS` (84) cap + reach deduplication
  const duplicateShips = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    kind: i % 2 === 0 ? 'carrack' : 'cog',
    phase: 'dock',
    berth: { x: 0, z: 0, rot: 0.3, shore: true },
    points: [0, -600, 0, 0],
  }));
  const overflowCaravans = Array.from({ length: 110 }, (_, i) => ({
    key: `cv-${i}`,
    index: i,
    mode: 'sea',
    depart: 0,
    arrive: 2,
    points: [-400 - i * 3, -900, 300 + i * 3, -400],
  }));
  const riverReach = {
    points: Array.from({ length: 30 }, (_, k) => [1200 + k * 25, 400, 8.0, 1.5, 2.2, -0.5, 0.0, 0, 0]),
  };
  const routes = buildTradeVesselRoutes({
    ships: duplicateShips,
    list: overflowCaravans,
    riverBoats: [{ id: 1, points: [1200, 400, 1900, 400], scale: 0.96 }],
  }, { x: 0, z: 0 }, {
    places: [{ x: 0, z: 200, kind: 'capital', harbor: true }],
    terrain: { height: () => -12 },
    riverReaches: [riverReach],
  });
  assert.ok(routes.length <= MAX_TRADE_VESSELS, `routes capped strictly at MAX_TRADE_VESSELS (${routes.length} <= ${MAX_TRADE_VESSELS})`);
  const dockedShips = routes.filter((r) => r.id.startsWith('ship:') && r.phase === 'dock');
  assert.equal(dockedShips.length, 6, 'all 6 docked ships assigned distinct safe berths');
  for (let i = 0; i < dockedShips.length; i++) {
    for (let j = i + 1; j < dockedShips.length; j++) {
      const sep = Math.hypot(dockedShips[i].berth.x - dockedShips[j].berth.x, dockedShips[i].berth.z - dockedShips[j].berth.z);
      assert.ok(sep >= 42.0 - 1e-3, `docked ships ${dockedShips[i].id} & ${dockedShips[j].id} separated by ${sep.toFixed(2)} m >= 42 m`);
    }
  }

  // Verify synthetic `reach:*` boats are skipped on reaches already covered by `riverBoat:*`
  const riverOnlyRoutes = buildTradeVesselRoutes({
    ships: [],
    list: [],
    riverBoats: [{ id: 7, points: [1200, 400, 1900, 400], scale: 0.96 }],
  }, { x: 0, z: 0 }, {
    places: [],
    terrain: { height: () => 4 },
    riverReaches: [riverReach],
  });
  assert.equal(riverOnlyRoutes.filter((r) => r.id.startsWith('riverBoat:')).length, 1);
  assert.equal(riverOnlyRoutes.filter((r) => r.id.startsWith('reach:')).length, 0, 'synthetic reach:* skipped when board riverBoat:* already serves reach');

  // Verify opposite-bound river barges hold opposite starboard-hand channel offsets
  const rbRoute = riverOnlyRoutes[0];
  const wpOut = Math.max(2, rbRoute.pts.findIndex((p) => p.x >= 1410));
  const wpIn = Math.max(2, rbRoute.pts.findIndex((p) => p.x >= 1590));
  const aiOut = createVesselAutopilotState(rbRoute, 4, { x: 1400, y: 1.5, z: 400, yaw: Math.PI / 2, speed: 1.2, motion: 1, phase: 0 }, 0);
  const aiIn = createVesselAutopilotState(rbRoute, 4, { x: 1600, y: 1.5, z: 400, yaw: -Math.PI / 2, speed: 1.2, motion: 1, phase: 0 }, 0);
  aiOut.dirSign = 1; aiOut.wpIndex = wpOut;
  aiIn.dirSign = -1; aiIn.wpIndex = wpIn;
  for (let s = 0; s < 40; s++) {
    stepTradeVesselAutopilot(aiOut, rbRoute, 4, 0.25, {});
    stepTradeVesselAutopilot(aiIn, rbRoute, 4, 0.25, {});
  }
  assert.ok(Math.abs(aiOut.z - aiIn.z) > 3.8, `opposite-bound river barges separate laterally into starboard-hand lanes (dz=${Math.abs(aiOut.z - aiIn.z).toFixed(2)} m)`);

  // 4. Verify TBDR & WGSL rules across all opaque/main shader modules (zero `discard`, <= 8 storage buffers, <= 16 sampled textures, balanced braces)
  const opaqueShaders = [
    ['tradeVessels(view)', TRADE_VESSEL_VIEW],
    ['tradeVessels(material)', TRADE_VESSEL_CONTINUUM_MATERIAL.wgsl()],
    ['tradeVessels(restPose)', REST_TO_POSED_WGSL],
    ['continuumCut', continuumModuleWGSL({ pass: 'select' })],
    ['continuumShadow', continuumModuleWGSL({ pass: 'shadow' })],
    ['waveCompute', TRADE_VESSEL_WAVE_WGSL],
    ['crewPlace', DECK_CREW_PLACE_WGSL],
  ];
  for (const [name, code] of opaqueShaders) {
    let depth = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      assert.ok(depth >= 0, `${name} has unbalanced closing brace`);
    }
    assert.equal(depth, 0, `${name} has balanced WGSL braces`);

    // A damaged vessel is masked out of her samples by her material (rule 2): no pass drops a fragment.
    assert.doesNotMatch(code, /\bdiscard\b/, `${name} has zero discard in opaque/main passes`);

    const storageMatches = code.match(/var<storage\b/g) || [];
    assert.ok(storageMatches.length <= 8, `${name} uses <= 8 storage buffers (${storageMatches.length})`);
    const texMatches = code.match(/:\s*texture_(?!storage)/g) || [];
    assert.ok(texMatches.length <= 16, `${name} uses <= 16 sampled textures (${texMatches.length})`);
  }
});

test('Harbor stern z-separation, 0.000 mm collinear river-barge oars, over-gunwale steering sweep, sealed cuddy decks & TBDR solid entry points', async () => {
  const { rowingHullDeck } = await import('../js/models/rowing.js');

  // 1. Harbor Cog (pinta: Arch 0, 1) & Carrack (santa-maria: Arch 2, 3) have zero coplanar stern taffrail/window faces
  for (const archIdx of [0, 1, 2, 3]) {
    const arch = getTradeVesselArchetype(archIdx);
    const v = arch.vertices;
    const ind = arch.indices;
    for (const bId of ['bulwark.port', 'bulwark.starboard']) {
      const bg = arch.groups.find((g) => g.id === bId);
      assert.ok(bg, `Arch ${archIdx} retains ${bId}`);
      for (let t = bg.firstVertex; t + 2 < bg.firstVertex + bg.vertexCount; t += 3) {
        const i0 = ind[t], i1 = ind[t + 1], i2 = ind[t + 2];
        const cz = (v[i0 * 9 + 2] + v[i1 * 9 + 2] + v[i2 * 9 + 2]) / 3;
        const nz = (v[i0 * 9 + 5] + v[i1 * 9 + 5] + v[i2 * 9 + 5]) / 3;
        assert.ok(
          !(cz > 5.992 && Math.abs(nz) > 0.90),
          `Arch ${archIdx} ${bId} has zero +Z/-Z stern taffrail triangle coplanar with hull.closure.stern at z=6.0`,
        );
      }
    }

    const winGrp = arch.groups.find((g) => g.id === 'stern.windows');
    assert.ok(winGrp && winGrp.vertexCount > 0, `Arch ${archIdx} retains stern.windows`);
    let maxCasingZ = -Infinity;
    let minGlassZ = Infinity;
    let minMuntinZ = Infinity;
    for (let t = winGrp.firstVertex; t + 2 < winGrp.firstVertex + winGrp.vertexCount; t += 3) {
      const i0 = ind[t], i1 = ind[t + 1], i2 = ind[t + 2];
      const cx = (v[i0 * 9] + v[i1 * 9] + v[i2 * 9]) / 3;
      const cy = (v[i0 * 9 + 1] + v[i1 * 9 + 1] + v[i2 * 9 + 1]) / 3;
      const cz = (v[i0 * 9 + 2] + v[i1 * 9 + 2] + v[i2 * 9 + 2]) / 3;
      const nz = (v[i0 * 9 + 5] + v[i1 * 9 + 5] + v[i2 * 9 + 5]) / 3;
      const mat = Math.floor(v[i0 * 9 + 6]);
      if (archIdx === 2 || archIdx === 3) {
        if (mat === 11 && cy < 1.95) {
          assert.ok(Math.abs(cx) >= 0.13, `Santa María Arch ${archIdx} drops center sternpost-impaled window at x=0 (cx=${cx.toFixed(3)})`);
        }
      }
      if (cy < 1.95 && cz < 6.06 && nz > 0.85) {
        if (mat === 1) maxCasingZ = Math.max(maxCasingZ, cz);
        else if (mat === 11) minGlassZ = Math.min(minGlassZ, cz);
        else if (mat === 17 && cz > 6.020) minMuntinZ = Math.min(minMuntinZ, cz);
      }
    }
    assert.ok(minGlassZ - maxCasingZ >= 0.012, `Arch ${archIdx} stern window glass (${minGlassZ.toFixed(4)}) stands >= 0.012 design Z proud of oak casing (${maxCasingZ.toFixed(4)})`);
    assert.ok(minMuntinZ - minGlassZ >= 0.004, `Arch ${archIdx} stern muntins (${minMuntinZ.toFixed(4)}) stand >= 0.004 design Z proud of glass (${minGlassZ.toFixed(4)})`);
  }

  // 2. River Barge (Arch 4): 0.000 mm collinear sweep oar shaft ray, Rodrigues uShaft feathering, over-gunwale steering sweep & sealed hold
  const barge = getTradeVesselArchetype(4);
  const ds = barge.designScale;
  const bv = barge.vertices;
  const bi = barge.indices;
  const pivots = bargeOarPivotsForWGSL();

  let maxCenterlineErrMm = 0;
  for (const og of barge.groups.filter((g) => g.id.startsWith('rowing.propulsor.rower.'))) {
    const uniq = new Set();
    for (let t = og.firstVertex; t < og.firstVertex + og.vertexCount; t++) uniq.add(bi[t]);
    const firstV = bi[og.firstVertex] * 9;
    const stIdx = Math.round((bv[firstV + 6] - 16) * 64) - 1;
    const pivDes = [pivots[stIdx * 4], pivots[stIdx * 4 + 1], pivots[stIdx * 4 + 2]];
    const side = pivots[stIdx * 4 + 3];
    const uDes = [side / ds[0], -0.37 / ds[1], 0];
    const uDesLen = Math.hypot(uDes[0], uDes[1], uDes[2]);
    uDes[0] /= uDesLen; uDes[1] /= uDesLen;
    const uRayM = [side, -0.37, 0];
    const uLenM = Math.hypot(uRayM[0], uRayM[1], uRayM[2]);
    uRayM[0] /= uLenM; uRayM[1] /= uLenM;

    // Group all cylinder & blade vertices by exact design-space station sDes along uDes
    const buckets = [];
    for (const vi of uniq) {
      const pd = [bv[vi * 9], bv[vi * 9 + 1], bv[vi * 9 + 2]];
      const ddx = pd[0] - pivDes[0], ddy = pd[1] - pivDes[1], ddz = pd[2] - pivDes[2];
      const sDes = ddx * uDes[0] + ddy * uDes[1] + ddz * uDes[2];
      let b = buckets.find((bk) => Math.abs(bk.sDes - sDes) < 1e-3);
      if (!b) { b = { sDes, ptsM: [] }; buckets.push(b); }
      const pm = [ddx * ds[0], ddy * ds[1], ddz * ds[2]];
      if (!b.ptsM.some((q) => Math.hypot(q[0] - pm[0], q[1] - pm[1], q[2] - pm[2]) < 1e-5)) {
        b.ptsM.push(pm);
      }
    }
    assert.equal(buckets.length, 5, `${og.id} has 5 collinear stations (tipIn, collarIn, collarOut, neckEnd, bladeTip)`);
    for (const b of buckets) {
      assert.ok(b.ptsM.length >= 4, `station at s=${b.sDes.toFixed(3)} has symmetric ring/blade vertices`);
      let cx = 0, cy = 0, cz = 0;
      for (const p of b.ptsM) { cx += p[0]; cy += p[1]; cz += p[2]; }
      cx /= b.ptsM.length; cy /= b.ptsM.length; cz /= b.ptsM.length;
      const dot = cx * uRayM[0] + cy * uRayM[1] + cz * uRayM[2];
      const perpM = Math.hypot(cx - uRayM[0] * dot, cy - uRayM[1] * dot, cz - uRayM[2] * dot);
      maxCenterlineErrMm = Math.max(maxCenterlineErrMm, perpM * 1000);
    }
  }
  assert.ok(maxCenterlineErrMm < 0.01, `all 8 river-barge oar rings & blades lie on exact 3D straight line (err=${maxCenterlineErrMm.toFixed(5)} mm < 0.01 mm)`);
  assert.match(TRADE_VESSEL_VIEW, /let\s+shaft\s*=\s*normalize\(/, 'the DRAPED oar feathers by a rigid Rodrigues rotation about its shaft');
  assert.match(REST_TO_POSED_WGSL, /let\s+uShaft\s*=\s*normalize\(/, 'a damaged vessel\'s rest pose feathers its oars the same way');
  for (const code of [TRADE_VESSEL_VIEW, REST_TO_POSED_WGSL]) assert.doesNotMatch(code, /\baxisY\b/, 'legacy dog-leg axisY feathering removed');

  // Verify over-gunwale stern steering sweep (`helm.steering-oar`) stays strictly above gunwale `railY` where it crosses the quarter
  const steerGrp = barge.groups.find((g) => g.id === 'helm.steering-oar');
  assert.ok(steerGrp && steerGrp.vertexCount > 0, 'Arch 4 has rebuilt helm.steering-oar');
  assert.ok(!barge.groups.some((g) => /^anchor(?:\.|$)/i.test(g.id)), 'Arch 4 strips sea anchors');
  for (let t = steerGrp.firstVertex; t < steerGrp.firstVertex + steerGrp.vertexCount; t++) {
    const o = bi[t] * 9;
    const z = bv[o + 2];
    if (z >= 4.70 && z <= 4.98) {
      const railY = rowingHullDeck('lusoria', z);
      assert.ok(bv[o + 1] > railY + 0.025, `helm.steering-oar clears gunwale at z=${z.toFixed(2)} (y=${bv[o + 1].toFixed(3)} > railY=${railY.toFixed(3)})`);
    }
  }
  assert.ok(barge.groups.some((g) => g.id === 'hull.cuddy.fore' && g.vertexCount > 0), 'fore cuddy deck seals bow bay');
  assert.ok(barge.groups.some((g) => g.id === 'hull.cuddy.aft' && g.vertexCount > 0), 'aft cuddy deck seals stern bay');
  assert.ok(barge.groups.some((g) => g.id === 'hull.sole.ceiling' && g.vertexCount > 0), 'bilge ceiling seals sub-sole hold');

  // 3. The clusters, the far body and the splat each keep only their own samples of a pixel across a handoff, through
  // the one shared split (continuumMask), a damaged vessel's holes ANDed out by her material, never by discard or blending.
  const start = TRADE_VESSEL_VIEW.indexOf('@fragment fn continuumFS');
  assert.ok(start >= 0, 'the vessels\' view defines @fragment fn continuumFS');
  const snippet = TRADE_VESSEL_VIEW.slice(start, TRADE_VESSEL_VIEW.indexOf('\n}', start) + 2);
  assert.match(snippet, /continuumMask\(v\.coverage[^;]*&\s*tradeVesselContinuumMask\(/, 'continuumFS keeps its samples through the shared split and the material\'s mask');
  assert.doesNotMatch(snippet, /\bdiscard\b/);
});

test('Trade ship hull textures use metric strakes (never unorm16-clamped in.uv.x), harbor berth scheduler queues excess ships cleanly, and COLREG brakes behind blocking ships', () => {
  // 1. Hull strake courses derive strictly from metric tvMetres.y, not clamped continuum in.uv.x
  assert.match(TRADE_VESSEL_VIEW, /let\s+course\s*=\s*tvMetres\.y\s*\/\s*0\.22\s*;/);
  assert.doesNotMatch(TRADE_VESSEL_VIEW, /in\.uv\.x\s*\*\s*18\.0/);
  assert.match(TRADE_VESSEL_VIEW, /let\s+transomFace\s*=\s*abs\(in\.normalLocal\.z\)\s*>\s*0\.72\s*;/);

  // 2. Harbor berth reservation & FIFO waiting queue across 4 arriving ships and 2 docks
  const berths = [
    { key: 'berth:0', x: 0, y: 0, z: 0, rot: 0, shore: true },
    { key: 'berth:1', x: 65, y: 0, z: 0, rot: 0, shore: true },
  ];
  const approachPts = [
    { x: 0, y: 0, z: 320, acc: 0 },
    { x: 0, y: 0, z: 90, acc: 230 },
  ];
  const makeInbound = (id, x, z) => {
    const route = { id: `ship:${id}`, shipId: id, mode: 'sea', phase: 'in', waited: 0, portBerths: berths, pts: approachPts, totalLen: 230, phaseOffset: id * 0.1 };
    const ai = createVesselAutopilotState(route, 2, { x, y: 0, z, yaw: 0, speed: 2.5, motion: 1, dist: 200 }, 0);
    ai.wpIndex = 1;
    return { route, ai, boat: { id: route.id, x, z, yaw: 0, speed: 2.5, length: 20, beam: 5.5, damage: { sunk: false } } };
  };
  const fleet = [
    makeInbound(1, 0, 120),
    makeInbound(2, 65, 125),
    makeInbound(3, -15, 140),
    makeInbound(4, 45, 150),
  ];

  assignHarborBerthsAndQueue(fleet, { dt: 0.1, elapsedSec: 10, storm: false });
  assert.equal(fleet[0].ai.state, 'approaching', 'ship 1 claims first free dock');
  assert.equal(fleet[1].ai.state, 'approaching', 'ship 2 claims second free dock');
  assert.notEqual(fleet[0].ai.berthKey, fleet[1].ai.berthKey, 'ships 1 and 2 reserve distinct berths');
  assert.equal(fleet[2].ai.state, 'waiting_berth', 'ship 3 queues when all docks are occupied');
  assert.equal(fleet[3].ai.state, 'waiting_berth', 'ship 4 queues behind ship 3');
  assert.equal(fleet[2].ai.queueRank, 0);
  assert.equal(fleet[3].ai.queueRank, 1);

  // Player ship mooring at berth:0 forces an approaching ship off berth:0 or into the queue
  const playerAtBerth0 = [{ id: 'player', x: 2, z: 2, length: 18, beam: 4.8 }];
  assignHarborBerthsAndQueue(fleet, { dt: 0.1, elapsedSec: 12, storm: false, avoidVessels: playerAtBerth0 });
  assert.equal(fleet[0].ai.state, 'waiting_berth', 'ship approaching berth:0 yields to player moored there');
  assert.equal(fleet[1].ai.berthKey, 'berth:1', 'ship at unobstructed berth:1 keeps its reservation');

  // When ship 2 departs and clears berth:1, the front-of-queue waiting ship is promoted automatically
  fleet[1].ai.state = 'departing';
  fleet[1].ai.x = 65;
  fleet[1].ai.z = 90;
  assignHarborBerthsAndQueue(fleet, { dt: 0.1, elapsedSec: 15, storm: false, avoidVessels: playerAtBerth0 });
  const promoted = fleet.filter((v) => v.ai.state === 'approaching');
  assert.equal(promoted.length, 1, 'exactly one front-of-queue ship is promoted into the newly opened dock');
  assert.equal(promoted[0].ai.berthKey, 'berth:1');

  // 3. COLREG collision avoidance brakes to zero behind a stationary ship directly ahead
  const trailRoute = { id: 'ship:trail', mode: 'sea', phase: 'in', pts: [{ x: 0, y: 0, z: 200, acc: 0 }, { x: 0, y: 0, z: -200, acc: 400 }], totalLen: 400, phaseOffset: 0.2 };
  const trailAi = createVesselAutopilotState(trailRoute, 0, { x: 0, y: 0, z: 24, yaw: 0, speed: 3.2, motion: 1, dist: 176 }, 0);
  trailAi.wpIndex = 1;
  const blocker = [{ id: 'ship:block', x: 0, z: 0, yaw: 0, speed: 0, vx: 0, vz: 0, length: 18, beam: 5.0 }];
  for (let i = 0; i < 12; i++) {
    stepTradeVesselAutopilot(trailAi, trailRoute, 0, { dt: 0.25, elapsedSec: i * 0.25, windVec: [8, 0], avoidTargets: blocker, length: 18, beam: 5.0 });
  }
  assert.ok(trailAi.speed < 0.8, `trailing vessel brakes sharply behind dead-ahead blocker (speed=${trailAi.speed.toFixed(2)})`);
  assert.ok(Math.hypot(trailAi.x, trailAi.z) > 12, 'trailing vessel does not plow through the stationary blocker');
});
