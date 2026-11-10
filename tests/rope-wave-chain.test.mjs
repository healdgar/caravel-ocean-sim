// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import {
  stepVesselRopeChain,
  resolveVesselRopeChain,
  packRopeChainUniform,
  unpackRopeChainUniform,
  computeRopeWaveModes,
  evaluateRopeWaveDisplacement,
} from '../js/rope-wave.js';
import { RIG_LINES, createLateenPoses, lateenRopePoint } from '../js/lateen.js';
import { standingRopePoint, climbingPoint, workingTacklePoint, mastPoint, RIG_MASTS } from '../js/rigging.js';
import { VICTORY_RUNNING_LINES, VICTORY_SAILS } from '../js/models/victory.js';
import { victoryPose, victoryClothPoint, victoryYardPoint } from '../js/victory-motion.js';
import { requirePlayableShipModel, resolveShipNode } from '../js/ship-models.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { createAdditionalAssetPose } from '../js/additional-ships.js';
import { createRigGPUFrame, writeRigGPUFrame } from '../js/rig-gpu-data.js';
import {
  buildVesselRigConnectors,
  createShipColorsRenderer,
  rigConnectorTopology,
  writeRigConnectorAnchors,
} from '../js/ship-colors.js';

// CPU oracle of the Victory running-line shader (victoryRopePoint in js/wgsl/victory.js). The
// game evaluates these lines on the GPU alone, so the oracle lives with its test. It is passed
// to the browser as source, hence the explicit dependencies.
function victoryRopeOracle(deps, index, t, state, time, wind, ropeChain) {
  const { VICTORY_RUNNING_LINES, VICTORY_SAILS, victoryPose, victoryClothPoint, victoryYardPoint, evaluateRopeWaveDisplacement } = deps;
  const line = VICTORY_RUNNING_LINES[index], sail = VICTORY_SAILS[line.sail - 1], pose = victoryPose(sail, state);
  const a = line.kind === 'sheet' ? victoryClothPoint(line.sail, ...line.uv, pose, time, wind) : victoryYardPoint(line.sail, line.a, pose);
  const b = line.bSail ? victoryYardPoint(line.bSail, line.b, victoryPose(VICTORY_SAILS[line.bSail - 1], state)) : line.b;
  const p = a.map((x, k) => x + (b[k] - x) * t);
  if (!(ropeChain?.active > 0)) return p;
  const fill = state.rig?.[sail.mast]?.fill ?? 0;
  const compliance = line.kind === 'sheet' ? 0.062 * (1.35 - 0.45 * fill) : 0.036;
  const wave = evaluateRopeWaveDisplacement(a, b, t, index, compliance, ropeChain.swayX ?? 0, ropeChain.swayZ ?? 0, time, wind);
  return [p[0] + wave[0], p[1] + wave[1], p[2] + wave[2]];
}
const victoryRopeDeps = { VICTORY_RUNNING_LINES, VICTORY_SAILS, victoryPose, victoryClothPoint, victoryYardPoint, evaluateRopeWaveDisplacement };

test('1D wave-equation normal modes keep endpoints pinned and displace interior rope stations transversely', () => {
  const a = [-1.4, 1.2, -2.5];
  const b = [0.0, 9.8, -1.8];
  const start = evaluateRopeWaveDisplacement(a, b, 0.0, 3, 0.06, 0.35, -0.2, 1.4, 9.0);
  const end = evaluateRopeWaveDisplacement(a, b, 1.0, 3, 0.06, 0.35, -0.2, 1.4, 9.0);
  assert.deepEqual(start, [0, 0, 0]);
  assert.deepEqual(end, [0, 0, 0]);

  const midT1 = evaluateRopeWaveDisplacement(a, b, 0.5, 3, 0.06, 0.35, -0.2, 1.0, 9.0);
  const midT2 = evaluateRopeWaveDisplacement(a, b, 0.5, 3, 0.06, 0.35, -0.2, 1.8, 9.0);
  const amp1 = Math.hypot(...midT1);
  const amp2 = Math.hypot(...midT2);
  assert.ok(amp1 > 0.02, `expected non-trivial wave/chain displacement at mid-span, got ${amp1}`);
  assert.ok(Math.hypot(midT1[0] - midT2[0], midT1[1] - midT2[1], midT1[2] - midT2[2]) > 0.005, 'wave modes must oscillate in time');

  // Higher compliance (slack running line) produces larger displacement than taut standing rigging
  const taut = evaluateRopeWaveDisplacement(a, b, 0.5, 3, 0.014, 0.35, -0.2, 1.0, 9.0);
  const slack = evaluateRopeWaveDisplacement(a, b, 0.5, 3, 0.085, 0.35, -0.2, 1.0, 9.0);
  assert.ok(Math.hypot(...slack) > Math.hypot(...taut) * 3.5, 'slack lines must sway more than taut standing rigging');

  const modes = computeRopeWaveModes(a, b, 3, 0.06, 0.4, 0.25, 1.2, 10.0);
  assert.ok(Math.hypot(...modes.mode1) > Math.hypot(...modes.mode3), 'fundamental mode dominates 3rd harmonic');
});

test('coupled hanging-chain pendulum responds to boat roll, pitch, and angular acceleration and round-trips through Hull UBO packing', () => {
  const staticFixture = { roll: 0.2, pitch: -0.1 };
  assert.deepEqual(resolveVesselRopeChain(staticFixture), { active: 0, swayX: 0, swayZ: 0 });

  const boat = { roll: 0.22, pitch: -0.12, rollVelocity: 0.35, pitchVelocity: -0.18 };
  const s0 = stepVesselRopeChain(boat, 1 / 60);
  assert.equal(s0.active, 1);
  assert.ok(s0.swayX < -0.1, `starboard roll should swing hanging chain to port (-X), got ${s0.swayX}`);
  assert.ok(s0.swayZ < -0.05, `bow-down pitch should swing hanging chain forward (-Z), got ${s0.swayZ}`);

  // Abrupt roll-rate reversal (mast whip) excites chain velocity
  boat.rollVelocity = -0.65;
  const s1 = stepVesselRopeChain(boat, 1 / 60);
  assert.ok(s1.velX > 0.05, `mast-whip angular acceleration should drive positive chain velocity, got ${s1.velX}`);

  // The physics step has advanced this frame, so writing the hull uniform must not advance it again.
  const afterPhysics = { ...s1 };
  const packed = packRopeChainUniform(boat, 1 / 60);
  assert.ok(packed > 0.5);
  const afterUniform = stepVesselRopeChain(boat, 0);
  for (const key of ['swayX', 'swayZ', 'velX', 'velZ']) assert.equal(afterUniform[key], afterPhysics[key], `hull uniform stepped ${key} a second time`);
  // Crew hands, posed meshes and shaders all read the very state the uniform carries.
  assert.deepEqual(resolveVesselRopeChain(boat), unpackRopeChainUniform(Math.fround(packed), 0, 0));
  assert.ok(Math.abs(resolveVesselRopeChain(boat).swayX - afterPhysics.swayX) <= 0.001 + 1e-9, 'the uniform quantises sway to 0.002');
});

test('the rope oscillator advances once per vessel per frame whichever path runs, and not at all while paused', () => {
  const motion = { roll: 0.22, pitch: -0.12, rollVelocity: 0.35, pitchVelocity: -0.18 };
  const frames = 90, dt = 1 / 60;
  const reference = { ...motion }, sailing = { ...motion }, moored = { ...motion };
  for (let frame = 0; frame < frames; frame++) {
    const roll = 0.22 * Math.cos(frame * 0.07), rollVelocity = -0.22 * 0.07 * 60 * Math.sin(frame * 0.07);
    for (const boat of [reference, sailing, moored]) Object.assign(boat, { roll, rollVelocity });
    stepVesselRopeChain(reference, dt);
    // A sailing vessel: her physics steps the chain, then the hull uniform is written.
    stepVesselRopeChain(sailing, dt);
    packRopeChainUniform(sailing, dt);
    // A vessel whose physics does not run (aground, baked wreck): only the uniform is written.
    packRopeChainUniform(moored, dt);
  }
  const expected = stepVesselRopeChain(reference, 0);
  for (const [name, boat] of [['sailing', sailing], ['moored', moored]]) {
    const state = stepVesselRopeChain(boat, 0);
    for (const key of ['swayX', 'swayZ', 'velX', 'velZ']) assert.equal(state[key], expected[key], `${name} vessel ${key} after ${frames} frames`);
  }
  assert.ok(Math.abs(expected.velX) > 1e-3, 'the reference chain is in motion, so a double step would show');

  // Paused: a frame of no duration must leave the rope exactly where it hung.
  const before = { ...stepVesselRopeChain(moored, 0) }, packedBefore = packRopeChainUniform(moored, 0);
  moored.roll = -0.4;
  moored.rollVelocity = 0.9;
  for (let frame = 0; frame < 30; frame++) assert.equal(packRopeChainUniform(moored, 0), packedBefore, 'a paused frame moved the rope');
  const after = stepVesselRopeChain(moored, 0);
  for (const key of ['swayX', 'swayZ', 'velX', 'velZ']) assert.equal(after[key], before[key], `paused frames changed ${key}`);
  assert.equal(packRopeChainUniform(null, dt), 0);
});

test('a hand on a swinging rope follows the rope the shader draws, not its chord', () => {
  // Niña: climbing runner and working fall resolve through the same line index, time, wind and chain as the hull shader.
  const model = requirePlayableShipModel('nina');
  const boat = { modelId: 'nina', model, ...model.runtime, heading: 0, heave: 0, pitch: 0.1, roll: 0.3, rollVelocity: 0.5, pitchVelocity: 0.2, rudder: 0 };
  boat.sailState = { rig: createLateenPoses([1, 1, 1], 1) };
  const still = resolveShipNode(boat, 'mast.main.runner', { side: 1, step: 6, time: 2.5, wind: 12, space: 'design' });
  for (let i = 0; i < 40; i++) stepVesselRopeChain(boat, 1 / 60);
  const chain = resolveVesselRopeChain(boat);
  assert.equal(chain.active, 1);
  const swung = resolveShipNode(boat, 'mast.main.runner', { side: 1, step: 6, time: 2.5, wind: 12, space: 'design' });
  const runnerIndex = RIG_LINES.findIndex((l) => l.kind === 'runner' && l.mast === 1 && l.side === 1);
  const runner = RIG_LINES[runnerIndex];
  const direct = climbingPoint(1, 1, 6, boat.sailState.rig[1], { chain, time: 2.5, wind: 12 });
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(swung[k] - direct[k]) < 1e-9, 'structure node resolves the swinging runner');
  assert.ok(Math.hypot(...swung.map((v, k) => v - still[k])) > 0.004, 'the runner hand moves with the rope chain');
  // The same point straight from the drawn line's own parameters.
  const rungs = Math.ceil((runner.b[1] - Math.min(...RIG_LINES.filter((l) => l.kind === 'shroud' && l.mast === 1 && l.side === 1).map((l) => l.a[1]))) * model.designFrame.verticalScale / 0.35);
  const drawn = standingRopePoint(runner, 6 / rungs, boat.sailState.rig[1], chain, 2.5, 12, runnerIndex);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(drawn[k] - direct[k]) < 1e-9, `runner hand is off the drawn rope by ${Math.abs(drawn[k] - direct[k])}`);
  const fallIndex = RIG_LINES.findIndex((l) => l.kind === 'fall' && l.mast === 1);
  const fall = RIG_LINES[fallIndex], height = (fall.a[1] + fall.b[1]) / 2;
  const hand = workingTacklePoint(1, height, { chain, time: 2.5, wind: 12 });
  const fallDrawn = standingRopePoint(fall, 0.5, null, chain, 2.5, 12, fallIndex);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(hand[k] - fallDrawn[k]) < 1e-9, 'working fall hand is on the drawn fall');
  assert.ok(Math.hypot(...hand.map((v, k) => v - workingTacklePoint(1, height)[k])) > 0.004, 'the fall hand moves with the rope chain');
});

test('a pendant gathered alongside its mast never swings inboard through the spar', () => {
  // Lee shrouds, runners and stays are eased against the mast; so are the falls.
  for (const side of [-1, 1]) {
    const poses = createLateenPoses([1, 1, 1], side);
    for (const [index, line] of RIG_LINES.entries()) {
      if (!['shroud', 'runner', 'stay', 'fall'].includes(line.kind)) continue;
      const gathered = line.kind === 'fall' || poses[line.mast].side * line.side > 0;
      if (!gathered) continue;
      for (const sway of [-0.8, -0.3, 0.3, 0.8]) for (const time of [0, 1.3, 4.1]) for (const t of [0.2, 0.4, 0.6, 0.8]) {
        const chain = { active: 1, swayX: sway, swayZ: -sway * 0.5 };
        const rest = standingRopePoint(line, t, poses[line.mast]);
        const swung = standingRopePoint(line, t, poses[line.mast], chain, time, 14, index);
        assert.ok(line.side * (swung[0] - rest[0]) >= -1e-12, `${line.kind} ${index} swung ${line.side * (swung[0] - rest[0])} m inboard of its place against the mast`);
        // It still swings: outboard or fore and aft.
        assert.ok(Number.isFinite(swung[2]));
      }
    }
  }
  // A taut weather shroud is not gathered and keeps its full (small) sway either way.
  const poses = createLateenPoses([1, 1, 1], -1), index = RIG_LINES.findIndex((l) => l.kind === 'shroud' && l.side === 1);
  const taut = RIG_LINES[index], rest = standingRopePoint(taut, 0.5, poses[taut.mast]);
  const inward = [-0.8, 0.8].map((swayX) => taut.side * (standingRopePoint(taut, 0.5, poses[taut.mast], { active: 1, swayX, swayZ: 0 }, 0.4, 2, index)[0] - rest[0]));
  assert.ok(Math.min(...inward) < 0, 'weather shroud may move either way');
  assert.ok(RIG_MASTS.length === 3 && mastPoint(0, 3).length === 3);
});

test('Niña, HMS Victory, descriptor-driven vessels, and stern outlicker sheets sway with boat motion and wave modes', () => {
  const poses = createLateenPoses([1, 1, 1], -1);
  const chainA = { active: 1, swayX: -0.35, swayZ: 0.20 };
  const chainB = { active: 1, swayX: 0.35, swayZ: -0.20 };

  // 1. Niña standing & running lines
  const shroud = RIG_LINES.find((l) => l.kind === 'shroud');
  const sheet = RIG_LINES.find((l) => l.kind === 'sheet');
  const shroudA = standingRopePoint(shroud, 0.5, poses[shroud.mast], chainA, 1.0, 9.0, 0);
  const shroudB = standingRopePoint(shroud, 0.5, poses[shroud.mast], chainB, 1.0, 9.0, 0);
  assert.ok(Math.hypot(...shroudA.map((v, i) => v - shroudB[i])) > 0.01, 'Niña standing shroud sways with hull roll/pitch');

  const sheetA = lateenRopePoint(sheet, 0.5, poses, 1.0, 9.0, chainA, 20);
  const sheetB = lateenRopePoint(sheet, 0.5, poses, 1.0, 9.0, chainB, 20);
  assert.ok(Math.hypot(...sheetA.map((v, i) => v - sheetB[i])) > 0.05, 'Niña running sheet sways with hull roll/pitch');
  assert.deepEqual(
    lateenRopePoint(sheet, 0.0, poses, 1.0, 9.0, chainA, 20),
    lateenRopePoint(sheet, 0.0, poses, 1.0, 9.0, null, 20),
    'Niña sheet clew attachment remains pinned at t = 0',
  );

  // 2. HMS Victory running lines
  const vState = {
    squareYaw: 0.2,
    lateenYaw: 0.3,
    windSide: 4,
    windForward: 6,
    set: [1, 1, 1],
    rig: [{ fill: 0.8 }, { fill: 0.8 }, { fill: 0.8 }],
  };
  assert.ok(VICTORY_RUNNING_LINES.length > 30);
  const vicA = victoryRopeOracle(victoryRopeDeps, 0, 0.5, vState, 1.2, 8.0, chainA);
  const vicB = victoryRopeOracle(victoryRopeDeps, 0, 0.5, vState, 1.2, 8.0, chainB);
  assert.ok(Math.hypot(...vicA.map((v, i) => v - vicB[i])) > 0.04, 'Victory running line sways with hull motion');

  // 3. Descriptor-driven surfaces-v1 ship (Pinta) CPU & GPU frame packing
  const cache = createShipAssetCache();
  const pinta = cache.get('pinta');
  const boatPort = { modelId: 'pinta', length: 21, beam: 6.6, roll: 0.25, pitch: 0.1, rollVelocity: 0.2, pitchVelocity: 0.1, sailState: {} };
  const boatStarboard = { modelId: 'pinta', length: 21, beam: 6.6, roll: -0.25, pitch: -0.1, rollVelocity: -0.2, pitchVelocity: -0.1, sailState: {} };
  stepVesselRopeChain(boatPort, 1 / 60);
  stepVesselRopeChain(boatStarboard, 1 / 60);

  const framePort = createRigGPUFrame(pinta.rigGPUData);
  const frameStarboard = createRigGPUFrame(pinta.rigGPUData);
  writeRigGPUFrame(pinta.rigGPUData, boatPort, 1.0, 9.0, framePort);
  writeRigGPUFrame(pinta.rigGPUData, boatStarboard, 1.0, 9.0, frameStarboard);
  assert.equal(framePort[7], 1, 'stepped vessel activates GPU rope chain mode in surfaceGpuLive[1].w');
  assert.ok(framePort[10] < 0 && frameStarboard[10] > 0, 'opposite rolls produce opposite swayX in surfaceGpuLive[2].z');

  const pintaPose = createAdditionalAssetPose(pinta);
  const posedPort = new Float32Array(pinta.vertices);
  const posedStarboard = new Float32Array(pinta.vertices);
  pintaPose(boatPort, 1.0, 9.0, posedPort);
  pintaPose(boatStarboard, 1.0, 9.0, posedStarboard);
  let maxRopeDiff = 0;
  for (let i = 0; i < pinta.vertices.length; i += 9) {
    if (Math.floor(pinta.vertices[i + 6]) === 12 && pinta.vertices[i + 7] >= 100) {
      const d = Math.hypot(
        posedPort[i] - posedStarboard[i],
        posedPort[i + 1] - posedStarboard[i + 1],
        posedPort[i + 2] - posedStarboard[i + 2],
      );
      maxRopeDiff = Math.max(maxRopeDiff, d);
    }
  }
  assert.ok(maxRopeDiff > 0.04, `expected Pinta running rigging vertices to sway with boat roll, got maxRopeDiff=${maxRopeDiff}`);

  // 4. Stern outlicker catenary sheets & full-fleet spar-to-mast rig connectors
  const connA = buildVesselRigConnectors(boatPort, 1.0, 9.0);
  const connB = buildVesselRigConnectors(boatStarboard, 1.0, 9.0);
  assert.equal(connA.length, connB.length);
  let connDiff = 0;
  for (let i = 0; i < connA.length; i += 10) {
    connDiff = Math.max(connDiff, Math.hypot(connA[i] - connB[i], connA[i + 1] - connB[i + 1], connA[i + 2] - connB[i + 2]));
  }
  assert.ok(connDiff > 0.005, 'stern outlicker sheets sway with boat motion');

  for (const modelId of ['nina', 'victory', 'pinta', 'santa-maria', 'flying-cloud', 'gipsy-moth-iv', 'oseberg', 'lusoria']) {
    const connBraceA = buildVesselRigConnectors({ modelId, sailState: { squareYaw: -0.32, lateenYaw: -0.35 } }, 1.0, 8.0);
    const connBraceB = buildVesselRigConnectors({ modelId, sailState: { squareYaw: 0.32, lateenYaw: 0.35 } }, 1.0, 8.0);
    assert.ok(connBraceA.length >= 300, `${modelId} must generate spar-to-mast rig connectors (got ${connBraceA.length})`);
    assert.equal(connBraceA.length, connBraceB.length, `${modelId} connector vertex count stays stable across sail bracing`);
    assert.ok(connBraceA.every(Number.isFinite), `${modelId} connector vertices must be finite`);
    if (modelId === 'victory' || modelId === 'flying-cloud' || modelId === 'gipsy-moth-iv' || modelId === 'santa-maria') {
      let braceShift = 0;
      for (let i = 0; i < connBraceA.length; i += 10) {
        braceShift = Math.max(
          braceShift,
          Math.hypot(connBraceA[i] - connBraceB[i], connBraceA[i + 1] - connBraceB[i + 1], connBraceA[i + 2] - connBraceB[i + 2]),
        );
      }
      assert.ok(braceShift > 0.01, `${modelId} spar-to-mast connectors must track live sailState bracing (got ${braceShift})`);
    }
  }
});

test('rig connectors are a static mesh: a steady rig uploads nothing but the pose, and the picture is the one the old builder drew', async () => {
  // Frozen from the JavaScript builder this mesh replaced, which rebuilt and uploaded every
  // vertex every frame: [vertices, hemp vertices, sum x, sum y, sum z, sum(|x| + y/2 + |z|/4)]
  // for one braced, part-furled, heeled state per model. A full comparison at the changeover
  // agreed to 2.3e-6 m over nine models, four rig states and two times.
  const frozen = {
    nina: [1884, 1350, 1.312, 8798.426, 6004.037, 6632.309],
    victory: [4536, 3150, 71.691, 35407.529, 3982.784, 21136.018],
    pinta: [2244, 1710, -74.025, 13456.583, 3717.746, 9241.379],
    'santa-maria': [3396, 2610, -53.371, 19132.133, -579.876, 13547.606],
    'flying-cloud': [10098, 7830, -13.958, 56308.488, 7576.567, 36902.873],
    'gipsy-moth-iv': [1032, 780, 85.888, 1183.075, 1093.015, 1242.765],
    oseberg: [576, 450, -0.242, 3102.77, 11.374, 1834.231],
    lusoria: [576, 450, -0.182, 2813.84, -67.776, 1651.163],
    'taino-canoe': [0, 0, 0, 0, 0, 0],
  };
  const rigged = () => ({
    sailState: {
      squareYaw: 0.3, lateenYaw: 0.35, windSide: 4, windForward: 5, set: [1, 0.6, 0.3],
      rig: [
        { side: 1, opening: 0.3, dip: 0.05, fill: 0.8, deployed: 1, pressure: 1 },
        { side: 1, opening: 0.25, dip: 0, fill: 0.6, deployed: 0.6, pressure: 1 },
        { side: -1, opening: 0.3, dip: 0.1, fill: 0.3, deployed: 0.3, pressure: 0.8 },
      ],
    },
    roll: 0.2,
    pitch: -0.1,
  });
  for (const [modelId, [count, hemp, sx, sy, sz, weight]] of Object.entries(frozen)) {
    const v = buildVesselRigConnectors({ modelId, ...rigged() }, 3.7, 14);
    const got = [0, 0, 0, 0, 0];
    for (let i = 0; i < v.length; i += 10) {
      got[0] += v[i + 8] === 7 ? 1 : 0;
      got[1] += v[i];
      got[2] += v[i + 1];
      got[3] += v[i + 2];
      got[4] += Math.abs(v[i]) + v[i + 1] * 0.5 + Math.abs(v[i + 2]) * 0.25;
    }
    assert.equal(v.length / 10, count, `${modelId} connector vertex count`);
    assert.equal(got[0], hemp, `${modelId} hemp vertex count`);
    for (const [k, want] of [sx, sy, sz, weight].entries()) assert.ok(Math.abs(got[k + 1] - want) < 0.02, `${modelId} connector geometry moved: sum ${k} is ${got[k + 1]}, was ${want}`);
    // The same anchors whatever the rig is doing, or tubes would join the wrong points.
    const topology = rigConnectorTopology(modelId);
    for (const boat of [{ modelId }, { modelId, ...rigged() }, { modelId, damage: { mastState: { fore: 2, main: 1, mizzen: 2 } } }]) {
      assert.equal(writeRigConnectorAnchors(boat, 1, 9, new Float32Array(topology.anchorCount * 4)), true, `${modelId} anchors`);
    }
  }

  // The renderer against a recording device.
  globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
  const created = [], writes = [];
  const device = {
    createBuffer: (d) => { const buffer = { label: d.label, size: d.size, destroyed: false, destroy() { this.destroyed = true; } }; created.push(buffer); return buffer; },
    queue: { writeBuffer: (buffer, offset, data, dataOffset, size) => writes.push({ label: buffer.label, bytes: size ?? data.byteLength }) },
    createBindGroup: (d) => ({ entries: d.entries }),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
  };
  const renderer = await createShipColorsRenderer({
    device, frameUBO: {}, transView: {}, skyView: {}, sampClamp: {}, envCubeView: {}, sunVisBuf: {},
    shadows: { bind: () => ({}) }, shader: async () => ({}), format: 'rgba16float', samples: 4, maxVessels: 3,
  });
  const victory = { modelId: 'victory', x: 0, z: 0, heading: 20, roll: 0.05, pitch: 0.01, ...rigged() };
  const consort = { modelId: 'victory', x: 80, z: 10, heading: 200, ...rigged() };
  const nina = { modelId: 'nina', x: -60, z: 5, heading: 90, ...rigged() };
  const frame = (time) => {
    writes.length = 0;
    renderer.updateVessel(0, victory, time, 0.7, 0.7, 9);
    renderer.updateVessel(1, consort, time, 0.7, 0.7, 9);
    renderer.updateVessel(2, nina, time, 0.7, 0.7, 9);
    return writes.map((w) => w.label + ':' + w.bytes);
  };
  const first = frame(0);
  assert.equal(first.filter((w) => w.startsWith('ship rig connector mesh victory')).length, 1, 'two Victories share one static mesh ' + first);
  assert.equal(first.filter((w) => w.startsWith('ship rig connector anchors')).length, 3, 'each vessel uploads its anchors once');
  // Steady frames: time, heel and position change, the rig does not.
  for (let i = 1; i <= 5; i++) {
    victory.roll = 0.05 * Math.cos(i);
    victory.x += 1;
    assert.deepEqual(frame(i / 60), ['ship colors pose 0:144', 'ship colors pose 1:144', 'ship colors pose 2:144'], 'a steady rig uploads only the three pose uniforms');
  }
  // Trimming the spanker moves anchors on that ship alone, and only anchors: 38 of them, 608 bytes.
  victory.sailState.lateenYaw = -0.2;
  assert.deepEqual(frame(0.2), ['ship colors pose 0:144', 'ship rig connector anchors 0:' + rigConnectorTopology('victory').anchorCount * 16, 'ship colors pose 1:144', 'ship colors pose 2:144']);
  assert.equal(rigConnectorTopology('victory').anchorCount * 16, 608);
  assert.deepEqual(frame(0.3), ['ship colors pose 0:144', 'ship colors pose 1:144', 'ship colors pose 2:144']);
  // No buffer scales with a per-slot worst case any more (it was 491,520 bytes a slot).
  const perSlot = created.filter((b) => /anchors \d|pose \d/.test(b.label));
  assert.ok(perSlot.length === 6 && perSlot.every((b) => b.size <= 608), 'per-vessel buffers are the pose and the anchors alone');
  assert.equal(created.filter((b) => b.label.startsWith('ship rig connector mesh')).length, 2, 'one mesh per model');
  // A slot given another ship rebinds to that model's mesh; a hidden vessel costs nothing.
  renderer.updateVessel(1, { modelId: 'taino-canoe', x: 0, z: 0 }, 1, 0.7, 0.7, 9);
  writes.length = 0;
  renderer.updateVessel(1, { modelId: 'taino-canoe', x: 0, z: 0 }, 1.1, 0.7, 0.7, 9);
  renderer.updateVessel(2, null, 1.1, 0.7, 0.7, 9);
  assert.deepEqual(writes.map((w) => w.label + ':' + w.bytes), ['ship colors pose 1:144']);
  const draws = [];
  renderer.draw({ setPipeline() {}, setBindGroup() {}, setVertexBuffer: (slot, buffer) => draws.push(buffer.label), draw: (count) => draws.push(count) });
  assert.deepEqual(draws.filter((d) => typeof d === 'string' && d.includes('connector')), ['ship rig connector mesh victory'], 'only the Victory still draws connectors');
  assert.ok(draws.includes(4536));
  renderer.destroy();
  assert.ok(created.every((b) => b.destroyed), 'every buffer is released');
});

test('GPU compute shaders match CPU wave-equation and chain-pendulum rope sway across Niña, HMS Victory, and descriptor-driven vessels', { timeout: 120000 }, async (t) => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args:
        process.env.WEBGPU_BACKEND === 'metal'
          ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog']
          : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
    });
    const page = await browser.newPage();
    await page.route('**/__rope-wave-gpu', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__rope-wave-gpu`);
    const result = await page.evaluate(async (victoryRopeOracleSource) => {
      const { createShipAssetCache } = await import('/js/ship-mesh.js');
      const { createVesselPose } = await import('/js/vessel-pose.js');
      const { createAdditionalAssetPose } = await import('/js/additional-ships.js');
      const { stepVesselRopeChain, packRopeChainUniform, unpackRopeChainUniform, resolveVesselRopeChain, evaluateRopeWaveDisplacement, ROPE_WAVE_WGSL } = await import('/js/rope-wave.js');
      const { VESSEL_RIG } = await import('/js/wgsl/vessel.js');
      const { VICTORY_SAILS, VICTORY_RUNNING_LINES } = await import('/js/models/victory.js');
      const { victoryPose, victoryClothPoint, victoryYardPoint } = await import('/js/victory-motion.js');
      const { RIG_LINES, lateenRopePoint, writeLateenUniform } = await import('/js/lateen.js');
      const { standingRopePoint } = await import('/js/rigging.js');
      const { rigConnectorTopology, writeRigConnectorAnchors, rigConnectorSway, expandRigConnectors, RIG_CONNECTOR_WGSL } = await import('/js/ship-colors.js');
      const victoryRopeOracle = new Function('return ' + victoryRopeOracleSource)();
      const victoryRopeDeps = { VICTORY_RUNNING_LINES, VICTORY_SAILS, victoryPose, victoryClothPoint, victoryYardPoint, evaluateRopeWaveDisplacement };

      const device = await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const B = GPUBufferUsage;
      const computePipe = async (code, label) => {
        const module = device.createShaderModule({ code, label });
        const bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
        if (bad.length) throw Error(label + ': ' + bad.map((m) => m.message).join('\n'));
        return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
      };

      // 1. Test descriptor-driven GPU pose (Pinta) with active chain pendulum vs CPU oracle
      const cache = createShipAssetCache();
      const pinta = cache.get('pinta');
      const count = pinta.vertices.length / 9;
      const raw = device.createBuffer({ size: pinta.vertices.byteLength, usage: B.STORAGE | B.VERTEX | B.COPY_DST });
      device.queue.writeBuffer(raw, 0, pinta.vertices);
      const hull = device.createBuffer({ size: 208, usage: B.UNIFORM | B.COPY_DST });
      const read = device.createBuffer({ size: count * 32, usage: B.MAP_READ | B.COPY_DST });
      const pose = await createVesselPose({
        device,
        computePipe,
        sourceBuffer: raw,
        vertexCount: count,
        hullUBO: hull,
        rigData: pinta.rigGPUData,
      });
      const cpuPose = createAdditionalAssetPose(pinta);
      const boat = {
        modelId: 'pinta',
        length: pinta.model.runtime.length,
        beam: pinta.model.runtime.beam,
        roll: 0.24,
        pitch: -0.14,
        rollVelocity: 0.32,
        pitchVelocity: -0.22,
        sailState: {},
      };
      stepVesselRopeChain(boat, 1 / 60);
      const expected = new Float32Array(pinta.vertices);
      cpuPose(boat, 1.35, 11.0, expected);
      pose.update(boat, 1.35, 11.0);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pose.encode(pass);
      pass.end();
      enc.copyBufferToBuffer(pose.buffer, 0, read, 0, count * 32);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(read.getMappedRange()).slice();
      read.unmap();

      let maxSurfaceRopeErr = 0;
      let ropeVertCount = 0;
      for (let i = 0; i < count; i++) {
        if (pinta.rigGPUData.vertices[i * 12] === 3) {
          ropeVertCount++;
          const err = Math.hypot(
            actual[i * 8] - expected[i * 9],
            actual[i * 8 + 1] - expected[i * 9 + 1],
            actual[i * 8 + 2] - expected[i * 9 + 2],
          );
          maxSurfaceRopeErr = Math.max(maxSurfaceRopeErr, err);
        }
      }
      pose.destroy();
      raw.destroy();
      read.destroy();

      // 2. Test Victory GPU victoryRopePoint with packed hull.size.z vs CPU victoryRopePoint
      const vBoat = { roll: -0.20, pitch: 0.12, rollVelocity: -0.28, pitchVelocity: 0.16 };
      const packed = packRopeChainUniform(vBoat, 1 / 60);
      const unpacked = unpackRopeChainUniform(packed, 0, 0);
      const vState = {
        squareYaw: 0.25,
        lateenYaw: 0.4,
        windSide: 3.5,
        windForward: 5.5,
        set: [1, 1, 1],
        rig: [{ fill: 0.75 }, { fill: 0.75 }, { fill: 0.75 }],
      };
      const samples = [];
      for (let i = 0; i < VICTORY_RUNNING_LINES.length; i++) {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) samples.push([i, t, 0, 0]);
      }
      const sInput = new Float32Array(samples.flat());
      const sBuf = device.createBuffer({ size: sInput.byteLength, usage: B.STORAGE | B.COPY_DST });
      const sOut = device.createBuffer({ size: sInput.byteLength, usage: B.STORAGE | B.COPY_SRC });
      const sRead = device.createBuffer({ size: sInput.byteLength, usage: B.MAP_READ | B.COPY_DST });
      device.queue.writeBuffer(sBuf, 0, sInput);
      const vPipe = await computePipe(
        VESSEL_RIG +
          `
        @group(0) @binding(0) var<uniform> hull: Hull;
        @group(0) @binding(1) var<storage, read> pts: array<vec4f>;
        @group(0) @binding(2) var<storage, read_write> res: array<vec4f>;
        @compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id: vec3u) {
          if (id.x >= arrayLength(&pts)) { return; }
          let p = pts[id.x];
          res[id.x] = vec4f(victoryRopePoint(u32(p.x), p.y), 0.0);
        }`,
        'victory rope wave test',
      );
      const u = new Float32Array(52);
      u[0] = 1;
      u[5] = 1;
      u[10] = -1;
      u[14] = packed;
      u[19] = 2.1;
      u[21] = 9.5;
      u[23] = 1;
      u.set(vState.set, 24);
      u[28] = vState.squareYaw;
      u[29] = vState.lateenYaw;
      u[32] = vState.windSide;
      u[33] = -vState.windForward;
      for (let m = 0; m < 3; m++) u[39 + m * 4] = 0.75;
      device.queue.writeBuffer(hull, 0, u);
      const vBind = device.createBindGroup({
        layout: vPipe.getBindGroupLayout(0),
        entries: [hull, sBuf, sOut].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const enc2 = device.createCommandEncoder();
      const pass2 = enc2.beginComputePass();
      pass2.setPipeline(vPipe);
      pass2.setBindGroup(0, vBind);
      pass2.dispatchWorkgroups(Math.ceil(samples.length / 32));
      pass2.end();
      enc2.copyBufferToBuffer(sOut, 0, sRead, 0, sInput.byteLength);
      device.queue.submit([enc2.finish()]);
      await sRead.mapAsync(GPUMapMode.READ);
      const vVals = new Float32Array(sRead.getMappedRange()).slice();
      sRead.unmap();

      let maxVictoryRopeErr = 0;
      for (let i = 0; i < samples.length; i++) {
        const [idx, t] = samples[i];
        const exp = victoryRopeOracle(victoryRopeDeps, idx, t, vState, 2.1, 9.5, unpacked);
        const err = Math.hypot(vVals[i * 4] - exp[0], vVals[i * 4 + 1] - exp[1], vVals[i * 4 + 2] - exp[2]);
        maxVictoryRopeErr = Math.max(maxVictoryRopeErr, err);
      }

      sBuf.destroy();
      sOut.destroy();
      sRead.destroy();

      // Runs one compute pipeline over a storage input and returns its vec4 results.
      const runCompute = async (pipe, buffers, outFloats, invocations, groupSize) => {
        const out = device.createBuffer({ size: outFloats * 4, usage: B.STORAGE | B.COPY_SRC });
        const back = device.createBuffer({ size: outFloats * 4, usage: B.MAP_READ | B.COPY_DST });
        const bind = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [...buffers, out].map((buffer, binding) => ({ binding, resource: { buffer } })),
        });
        const encoder = device.createCommandEncoder();
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(pipe);
        computePass.setBindGroup(0, bind);
        computePass.dispatchWorkgroups(Math.ceil(invocations / groupSize));
        computePass.end();
        encoder.copyBufferToBuffer(out, 0, back, 0, outFloats * 4);
        device.queue.submit([encoder.finish()]);
        await back.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(back.getMappedRange()).slice();
        back.unmap();
        out.destroy();
        back.destroy();
        return values;
      };
      const storage = (data) => {
        const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: B.STORAGE | B.COPY_DST });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };

      // 3. Niña: every standing and running line of the hull shader against the CPU the crew use.
      // The vessel is stepped as in play; both sides read the chain through the packed uniform.
      const nBoat = { roll: 0.26, pitch: -0.11, rollVelocity: 0.4, pitchVelocity: -0.2 };
      for (let i = 0; i < 24; i++) stepVesselRopeChain(nBoat, 1 / 60);
      const nPacked = packRopeChainUniform(nBoat, 1 / 60);
      const nChain = resolveVesselRopeChain(nBoat);
      const nPoses = [
        { side: -1, opening: 0.30, dip: 0, fill: 0.8, deployed: 1, pressure: 1 },
        { side: 1, opening: 0.26, dip: 0.07, fill: 0.5, deployed: 0.7, pressure: 1 },
        { side: 1, opening: 0.30, dip: 0.12, fill: 0.2, deployed: 0.4, pressure: 1 },
      ];
      const nTime = 3.4, nWind = 13.0;
      const nSamples = [];
      for (let i = 0; i < RIG_LINES.length; i++) for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) nSamples.push([i, t, 0, 0]);
      const nHull = new Float32Array(52);
      nHull[0] = 1;
      nHull[5] = 1;
      nHull[10] = -1;
      nHull[14] = nPacked;
      nHull[19] = nTime;
      nHull[21] = nWind;
      nHull[34] = nWind;
      writeLateenUniform(nHull, { rig: nPoses });
      device.queue.writeBuffer(hull, 0, nHull);
      const nPipe = await computePipe(
        VESSEL_RIG +
          `
        @group(0) @binding(0) var<uniform> hull: Hull;
        @group(0) @binding(1) var<storage, read> pts: array<vec4f>;
        @group(0) @binding(2) var<storage, read_write> res: array<vec4f>;
        @compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id: vec3u) {
          if (id.x >= arrayLength(&pts)) { return; }
          let p = pts[id.x];
          res[id.x] = vec4f(rigRopePoint(u32(p.x), p.y), 0.0);
        }`,
        'nina rope wave test',
      );
      const nInput = storage(new Float32Array(nSamples.flat()));
      const nVals = await runCompute(nPipe, [hull, nInput], nSamples.length * 4, nSamples.length, 32);
      nInput.destroy();
      let maxNinaRopeErr = 0, maxNinaSway = 0, gatheredInboard = 0;
      for (let i = 0; i < nSamples.length; i++) {
        const [index, t] = nSamples[i], line = RIG_LINES[index];
        const standing = ['shroud', 'runner', 'stay', 'fall', 'forestay'].includes(line.kind);
        const expected = standing
          ? standingRopePoint(line, t, nPoses[line.mast], nChain, nTime, nWind, index)
          : lateenRopePoint(line, t, nPoses, nTime, nWind, nChain, index);
        const still = standing ? standingRopePoint(line, t, nPoses[line.mast]) : lateenRopePoint(line, t, nPoses, nTime, nWind);
        maxNinaRopeErr = Math.max(maxNinaRopeErr, Math.hypot(nVals[i * 4] - expected[0], nVals[i * 4 + 1] - expected[1], nVals[i * 4 + 2] - expected[2]));
        maxNinaSway = Math.max(maxNinaSway, Math.hypot(nVals[i * 4] - still[0], nVals[i * 4 + 1] - still[1], nVals[i * 4 + 2] - still[2]));
        const gathered = line.kind === 'fall' || (['shroud', 'runner', 'stay'].includes(line.kind) && nPoses[line.mast].side * line.side > 0);
        if (gathered) gatheredInboard = Math.min(gatheredInboard, line.side * (nVals[i * 4] - still[0]));
      }

      // 4. Rig connectors: the vertex function the ship colours shader poses the static mesh with,
      // against its CPU mirror, for a stepped vessel of each rig family.
      const connectorPipe = await computePipe(
        ROPE_WAVE_WGSL +
          RIG_CONNECTOR_WGSL +
          `
        struct ConnectorParams { sway: vec2f, time: f32, wind: f32 };
        @group(0) @binding(0) var<uniform> params: ConnectorParams;
        @group(0) @binding(1) var<storage, read> tubes: array<RigTube>;
        @group(0) @binding(2) var<storage, read> anchors: array<vec4f>;
        @group(0) @binding(3) var<storage, read> verts: array<f32>;
        @group(0) @binding(4) var<storage, read_write> res: array<vec4f>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
          let i = id.x;
          if (i * 2u >= arrayLength(&res)) { return; }
          let tube = tubes[u32(verts[i * 10u])];
          let point = rigConnectorVertex(tube, anchors[u32(tube.a.w)], anchors[u32(tube.b.w)], anchors[u32(tube.shape.z)].w,
            verts[i * 10u + 1u], verts[i * 10u + 2u], params.sway, params.time, params.wind);
          res[i * 2u] = vec4f(point.position, point.visible);
          res[i * 2u + 1u] = vec4f(point.normal, 0.0);
        }`,
        'rig connector vertex test',
      );
      const connectors = {};
      const paramBuffer = device.createBuffer({ size: 16, usage: B.UNIFORM | B.COPY_DST });
      for (const modelId of ['nina', 'victory', 'santa-maria', 'flying-cloud', 'gipsy-moth-iv', 'oseberg']) {
        const topology = rigConnectorTopology(modelId);
        const cBoat = {
          modelId,
          roll: 0.21,
          pitch: -0.09,
          rollVelocity: 0.3,
          pitchVelocity: 0.15,
          sailState: { squareYaw: 0.27, lateenYaw: -0.31, windSide: 3, windForward: 5, set: [1, 0.7, 0.4], rig: nPoses },
        };
        for (let i = 0; i < 30; i++) stepVesselRopeChain(cBoat, 1 / 60);
        const anchors = new Float32Array(topology.anchorCount * 4);
        const described = writeRigConnectorAnchors(cBoat, 5.2, 12.5, anchors);
        const sway = rigConnectorSway(cBoat);
        const expected = expandRigConnectors(topology, anchors, sway[0], sway[1], 5.2, 12.5);
        device.queue.writeBuffer(paramBuffer, 0, new Float32Array([sway[0], sway[1], 5.2, 12.5]));
        const tubeBuffer = storage(topology.tubes), anchorBuffer = storage(anchors), vertexBuffer = storage(topology.vertices);
        const values = await runCompute(connectorPipe, [paramBuffer, tubeBuffer, anchorBuffer, vertexBuffer], topology.vertexCount * 8, topology.vertexCount, 64);
        tubeBuffer.destroy();
        anchorBuffer.destroy();
        vertexBuffer.destroy();
        let maxPosition = 0, maxNormal = 0, hidden = 0;
        for (let i = 0; i < topology.vertexCount; i++) {
          if (values[i * 8 + 3] < 0.5) hidden++;
          maxPosition = Math.max(maxPosition, Math.hypot(values[i * 8] - expected[i * 10], values[i * 8 + 1] - expected[i * 10 + 1], values[i * 8 + 2] - expected[i * 10 + 2]));
          maxNormal = Math.max(maxNormal, Math.hypot(values[i * 8 + 4] - expected[i * 10 + 3], values[i * 8 + 5] - expected[i * 10 + 4], values[i * 8 + 6] - expected[i * 10 + 5]));
        }
        connectors[modelId] = { described, vertices: topology.vertexCount, expected: expected.length / 10, hidden, maxPosition, maxNormal };
      }
      paramBuffer.destroy();
      hull.destroy();
      device.destroy();
      return { errors, ropeVertCount, maxSurfaceRopeErr, maxVictoryRopeErr, maxNinaRopeErr, maxNinaSway, gatheredInboard, ninaSamples: nSamples.length, connectors };
    }, victoryRopeOracle.toString());
    t.diagnostic(JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    assert.ok(result.ropeVertCount > 100);
    assert.ok(result.maxSurfaceRopeErr < 5e-4, `Pinta GPU/CPU rope wave parity error ${result.maxSurfaceRopeErr}`);
    assert.ok(result.maxVictoryRopeErr < 5e-4, `Victory GPU/CPU rope wave parity error ${result.maxVictoryRopeErr}`);
    assert.ok(result.ninaSamples > 300);
    assert.ok(result.maxNinaRopeErr < 5e-4, `Niña GPU/CPU rope wave parity error ${result.maxNinaRopeErr}`);
    assert.ok(result.maxNinaSway > 0.02, `Niña shader ropes must actually sway (max ${result.maxNinaSway})`);
    assert.ok(result.gatheredInboard > -5e-5, `a gathered Niña pendant swung ${-result.gatheredInboard} m inboard through its mast on the GPU`);
    for (const [modelId, c] of Object.entries(result.connectors)) {
      assert.equal(c.described, true, `${modelId} anchors describe the model`);
      assert.ok(c.vertices > 500 && c.expected === c.vertices && c.hidden === 0, `${modelId} connector mesh is drawn whole ${JSON.stringify(c)}`);
      assert.ok(c.maxPosition < 2e-4, `${modelId} connector vertex shader is ${c.maxPosition} m off its CPU mirror`);
      assert.ok(c.maxNormal < 2e-3, `${modelId} connector normal is ${c.maxNormal} off its CPU mirror`);
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

