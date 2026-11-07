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
  ropeWaveHarmonicDifference,
  evaluateRopeWaveDisplacement,
} from '../js/rope-wave.js';
import { RIG_LINES, createLateenPoses, lateenRopePoint } from '../js/lateen.js';
import { standingRopePoint } from '../js/rigging.js';
import { VICTORY_RUNNING_LINES } from '../js/models/victory.js';
import { victoryRopePoint } from '../js/victory-motion.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { createAdditionalAssetPose } from '../js/additional-ships.js';
import { createRigGPUFrame, writeRigGPUFrame } from '../js/rig-gpu-data.js';
import { buildVesselRigConnectors } from '../js/ship-colors.js';

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

  // Harmonic difference identity matches sin(n*pi*t) - sin(n*pi*anchor)
  for (const n of [1, 2, 3]) {
    for (const [t, anchor] of [[0.251, 0.25], [0.749, 0.75], [0.5, 0.5]]) {
      const exact = Math.sin(n * Math.PI * t) - Math.sin(n * Math.PI * anchor);
      const factored = ropeWaveHarmonicDifference(n, t, anchor);
      assert.ok(Math.abs(exact - factored) < 1e-14);
    }
  }

  const modes = computeRopeWaveModes(a, b, 3, 0.06, 0.4, 0.25, 1.2, 10.0);
  assert.ok(Math.hypot(...modes.mode1) > Math.hypot(...modes.mode3), 'fundamental mode dominates 3rd harmonic');
});

test('coupled hanging-chain pendulum responds to boat roll, pitch, and angular acceleration and round-trips through Hull UBO packing', () => {
  const staticFixture = { roll: 0.2, pitch: -0.1 };
  assert.deepEqual(resolveVesselRopeChain(staticFixture), { active: 0, swayX: 0, swayZ: 0 });

  const boat = { roll: 0.22, pitch: -0.12, rollVelocity: 0.35, pitchVelocity: -0.18 };
  const s0 = stepVesselRopeChain(boat, 1 / 60, 0.5, 8.0);
  assert.equal(s0.active, 1);
  assert.ok(s0.swayX < -0.1, `starboard roll should swing hanging chain to port (-X), got ${s0.swayX}`);
  assert.ok(s0.swayZ < -0.05, `bow-down pitch should swing hanging chain forward (-Z), got ${s0.swayZ}`);

  // Abrupt roll-rate reversal (mast whip) excites chain velocity
  boat.rollVelocity = -0.65;
  const s1 = stepVesselRopeChain(boat, 1 / 60, 0.52, 8.0);
  assert.ok(s1.velX > 0.05, `mast-whip angular acceleration should drive positive chain velocity, got ${s1.velX}`);

  const packed = packRopeChainUniform(boat, 1 / 60, 0.54, 8.0);
  assert.ok(packed > 0.5);
  const unpacked = unpackRopeChainUniform(packed, 0, 0);
  const resolved = resolveVesselRopeChain(boat);
  assert.equal(unpacked.active, 1);
  assert.ok(Math.abs(unpacked.swayX - resolved.swayX) < 0.005);
  assert.ok(Math.abs(unpacked.swayZ - resolved.swayZ) < 0.005);
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
  const vicA = victoryRopePoint(0, 0.5, vState, 1.2, 8.0, chainA);
  const vicB = victoryRopePoint(0, 0.5, vState, 1.2, 8.0, chainB);
  assert.ok(Math.hypot(...vicA.map((v, i) => v - vicB[i])) > 0.04, 'Victory running line sways with hull motion');

  // 3. Descriptor-driven surfaces-v1 ship (Pinta) CPU & GPU frame packing
  const cache = createShipAssetCache();
  const pinta = cache.get('pinta');
  const boatPort = { modelId: 'pinta', length: 21, beam: 6.6, roll: 0.25, pitch: 0.1, rollVelocity: 0.2, pitchVelocity: 0.1, sailState: {} };
  const boatStarboard = { modelId: 'pinta', length: 21, beam: 6.6, roll: -0.25, pitch: -0.1, rollVelocity: -0.2, pitchVelocity: -0.1, sailState: {} };
  stepVesselRopeChain(boatPort, 1 / 60, 1.0, 9.0);
  stepVesselRopeChain(boatStarboard, 1 / 60, 1.0, 9.0);

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

  // 4. Stern outlicker catenary sheets
  const connA = buildVesselRigConnectors(boatPort, 1.0, 9.0);
  const connB = buildVesselRigConnectors(boatStarboard, 1.0, 9.0);
  assert.equal(connA.length, connB.length);
  let connDiff = 0;
  for (let i = 0; i < connA.length; i += 10) {
    connDiff = Math.max(connDiff, Math.hypot(connA[i] - connB[i], connA[i + 1] - connB[i + 1], connA[i + 2] - connB[i + 2]));
  }
  assert.ok(connDiff > 0.005, 'stern outlicker sheets sway with boat motion');
});

test('GPU compute shaders match CPU wave-equation and chain-pendulum rope sway across Niña, HMS Victory, and descriptor-driven vessels', { timeout: 120000 }, async () => {
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
    const result = await page.evaluate(async () => {
      const { createShipAssetCache } = await import('/js/ship-mesh.js');
      const { createVesselPose } = await import('/js/vessel-pose.js');
      const { createAdditionalAssetPose } = await import('/js/additional-ships.js');
      const { stepVesselRopeChain, packRopeChainUniform, unpackRopeChainUniform } = await import('/js/rope-wave.js');
      const { VESSEL_RIG } = await import('/js/wgsl/vessel.js');
      const { VICTORY_SAILS, VICTORY_RUNNING_LINES } = await import('/js/models/victory.js');
      const { victoryRopePoint } = await import('/js/victory-motion.js');

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
      stepVesselRopeChain(boat, 1 / 60, 1.35, 11.0);
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
      const packed = packRopeChainUniform(vBoat, 1 / 60, 2.1, 9.5);
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
        const exp = victoryRopePoint(idx, t, vState, 2.1, 9.5, unpacked);
        const err = Math.hypot(vVals[i * 4] - exp[0], vVals[i * 4 + 1] - exp[1], vVals[i * 4 + 2] - exp[2]);
        maxVictoryRopeErr = Math.max(maxVictoryRopeErr, err);
      }

      sBuf.destroy();
      sOut.destroy();
      sRead.destroy();
      hull.destroy();
      device.destroy();
      return { errors, ropeVertCount, maxSurfaceRopeErr, maxVictoryRopeErr };
    });
    assert.deepEqual(result.errors, []);
    assert.ok(result.ropeVertCount > 100);
    assert.ok(result.maxSurfaceRopeErr < 5e-4, `Pinta GPU/CPU rope wave parity error ${result.maxSurfaceRopeErr}`);
    assert.ok(result.maxVictoryRopeErr < 5e-4, `Victory GPU/CPU rope wave parity error ${result.maxVictoryRopeErr}`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

