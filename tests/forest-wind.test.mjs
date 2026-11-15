import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import {
  FOREST_WIND_BONES,
  FOREST_WIND_BONE_FLOATS,
  FOREST_WIND_SHARED_LANES,
  FOREST_WIND_ASSETS,
  SUBTROPICAL_FOREST_WIND_ASSETS,
  PORTUGAL_FOREST_WIND_ASSETS,
  packForestWindWeight,
  unpackForestWindWeight,
  evaluateFriedlanderWave,
  validateForestWindManifest,
  loadForestWind,
} from '../js/forest-wind.js';
import { FOREST_CLUSTER_VERTEX_WORDS, FOREST_CLUSTER_WORDS, FOREST_LEAF_VERTICES } from '../js/forest-clusters.js';

function serveLocalAssets(transform = null) {
  return async (assetPath) => {
    if (!fs.existsSync(assetPath)) return { ok: false, status: 404 };
    let bytes = fs.readFileSync(assetPath);
    if (transform) bytes = transform(bytes, assetPath);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(bytes.toString('utf8')),
      body: new Blob([bytes]).stream(),
    };
  };
}

test('forest dynamic wind streams verify SHA-256 receipts, topological bone hierarchy, and physical mass/frequency scaling across all packs', async () => {
  for (const [packName, assets, expectedProtos] of [
    ['portugal', PORTUGAL_FOREST_WIND_ASSETS, 12],
    ['subtropical', SUBTROPICAL_FOREST_WIND_ASSETS, 4],
    ['saba', FOREST_WIND_ASSETS, 5],
  ]) {
    const loaded = await loadForestWind({ assets, fetchAsset: serveLocalAssets() });
    assert.equal(loaded.manifest.prototypes.length, expectedProtos, `${packName} prototype count`);
    assert.equal(loaded.bones.byteLength, expectedProtos * FOREST_WIND_BONES * FOREST_WIND_BONE_FLOATS * 4);
    assert.equal(loaded.weights.byteLength, loaded.manifest.clusterVertexCount * 4);

    const bonesF = new Float32Array(loaded.bones.buffer, loaded.bones.byteOffset, loaded.bones.byteLength / 4);
    for (let p = 0; p < expectedProtos; p++) {
      const summary = loaded.manifest.prototypes[p];
      assert.ok(summary.totalMassKg > 0, `${packName}[${p}] mass > 0`);
      assert.ok(summary.totalDragAreaM2 > 0, `${packName}[${p}] drag > 0`);

      let g0Omega = 0, g0Count = 0, g1Omega = 0, g1Count = 0, g2Omega = 0, g2Count = 0;
      let g0Stiff = 0, g2Stiff = 0;
      for (let b = 0; b < FOREST_WIND_BONES; b++) {
        const at = (p * FOREST_WIND_BONES + b) * FOREST_WIND_BONE_FLOATS;
        const meta = Math.round(bonesF[at + 3]);
        const parent = (meta & 63) - 1;
        const group = (meta >>> 6) & 3;
        const active = (meta >>> 8) & 1;
        if (!active) continue;
        assert.ok(parent < b, `${packName}[${p}] bone ${b} parent ${parent} must precede it topologically`);
        if (b === 0) assert.equal(parent, -1, `${packName}[${p}] root bone 0 must have parent -1`);
        const stiffness = bonesF[at + 12];
        const natOmega = bonesF[at + 13];
        const damping = bonesF[at + 14];
        assert.ok(stiffness > 0 && Number.isFinite(stiffness));
        assert.ok(natOmega >= 1.0 && natOmega <= 17.0);
        assert.ok(damping >= 0.15 && damping <= 0.5);
        if (group === 0) { g0Omega += natOmega; g0Stiff += stiffness; g0Count++; }
        else if (group === 1) { g1Omega += natOmega; g1Count++; }
        else if (group === 2) { g2Omega += natOmega; g2Stiff += stiffness; g2Count++; }
      }
      assert.ok(g0Count >= 5 && g1Count >= 8 && g2Count >= 12, `${packName}[${p}] populates trunk, boughs, and branchlets`);
      assert.ok(g0Omega / g0Count < g1Omega / g1Count, `${packName}[${p}] boughs oscillate faster than trunk`);
      assert.ok(g1Omega / g1Count < g2Omega / g2Count, `${packName}[${p}] outer branchlets oscillate faster than boughs`);
      assert.ok(g0Stiff / g0Count > g2Stiff / g2Count, `${packName}[${p}] trunk is stiffer than outer branchlets`);
    }
  }

  // Physical species differentiation on Portugal: veteran elm/oak outweighs birch outweighs blueberry shrub,
  // while natural sway frequency scales inversely (blueberry > birch > oak/elm).
  const pt = JSON.parse(fs.readFileSync(PORTUGAL_FOREST_WIND_ASSETS['manifest.json'], 'utf8'));
  const oakVet = pt.prototypes.find((p) => p.species === 'oak' && p.cohort === 'veteran');
  const birchVet = pt.prototypes.find((p) => p.species === 'birch' && p.cohort === 'veteran');
  const blueberryCan = pt.prototypes.find((p) => p.species === 'blueberry' && p.cohort === 'canopy');
  assert.ok(oakVet.totalMassKg > birchVet.totalMassKg * 10);
  assert.ok(birchVet.totalMassKg > blueberryCan.totalMassKg * 20);
  assert.ok(blueberryCan.trunkNaturalFreqHz > birchVet.trunkNaturalFreqHz);
  assert.ok(birchVet.trunkNaturalFreqHz > oakVet.trunkNaturalFreqHz);

  // Tampered gzip stream must fail SHA-256 verification.
  const corrupted = serveLocalAssets((bytes, p) => {
    if (!p.endsWith('bones.bin.gz')) return bytes;
    const raw = zlib.gunzipSync(bytes);
    raw[12] ^= 0xff;
    return zlib.gzipSync(raw);
  });
  await assert.rejects(loadForestWind({ assets: PORTUGAL_FOREST_WIND_ASSETS, fetchAsset: corrupted }), /failed verification/);
  assert.throws(() => validateForestWindManifest({ format: 'wrong' }), /Invalid forest dynamic wind manifest/);
});

test('every Portugal L0 leaf shoot locks all 6 vertices to one bark-matched dual-bone skinning weight with zero detachment under bone rotation', () => {
  const dir = 'assets/forest-scenery/portugal';
  const windManifest = JSON.parse(fs.readFileSync(`${dir}/wind/manifest.json`, 'utf8'));
  const weightsBuf = zlib.gunzipSync(fs.readFileSync(`${dir}/wind/weights.bin.gz`));
  const weights = new Uint32Array(weightsBuf.buffer, weightsBuf.byteOffset, weightsBuf.byteLength / 4);

  const clusterManifest = JSON.parse(fs.readFileSync(`${dir}/clusters/manifest.json`, 'utf8'));
  const cBuf = zlib.gunzipSync(fs.readFileSync(`${dir}/clusters/clusters.bin.gz`));
  const cU32 = new Uint32Array(cBuf.buffer, cBuf.byteOffset, cBuf.byteLength / 4);
  const cF32 = new Float32Array(cBuf.buffer, cBuf.byteOffset, cBuf.byteLength / 4);

  for (const wp of windManifest.prototypes) {
    assert.ok(wp.l0BarkLockedShare >= 0.997, `${wp.species}/${wp.cohort} L0 bark lock ${wp.l0BarkLockedShare} < 0.997`);
  }

  // Verify across every leaf cluster of every Portugal prototype that all 6 vertices of each shoot carry identical packed skinning words!
  let checkedLeaves = 0;
  for (const cp of clusterManifest.prototypes) {
    for (let ci = cp.firstCluster; ci < cp.firstCluster + cp.clusterCount; ci++) {
      const shape = cU32[ci * FOREST_CLUSTER_WORDS + 15];
      if ((shape & 1) !== 1) continue;
      const first = cU32[ci * FOREST_CLUSTER_WORDS + 14];
      const tris = shape >>> 1;
      const leaves = Math.floor(tris / 4);
      for (let l = 0; l < leaves; l++) {
        const base = first + l * FOREST_LEAF_VERTICES;
        const w0 = weights[base];
        assert.notEqual(w0, 0xffffffff);
        for (let k = 1; k < FOREST_LEAF_VERTICES; k++) {
          assert.equal(weights[base + k], w0, `${cp.species} leaf ${l} vertex ${k} skin weight differs from shoot foot`);
        }
        const u = unpackForestWindWeight(w0);
        const repacked = packForestWindWeight(u);
        assert.equal(repacked, w0);
        checkedLeaves++;
      }
    }
  }
  assert.ok(checkedLeaves > 300000, `checked ${checkedLeaves} cluster leaves`);
  assert.equal(cF32.length, clusterManifest.clusterCount * FOREST_CLUSTER_WORDS);
  assert.equal(weights.length, clusterManifest.vertexCount);
});

test('Friedlander blast wave propagates at waveSpeed with positive shock front and negative suction phase', () => {
  const r = 14, speed = 280;
  const arrival = r / speed;
  assert.equal(evaluateFriedlanderWave(r, 0.0, speed, 34, 900), 0, 'zero before shock arrival');
  const peak = evaluateFriedlanderWave(r, arrival + 0.002, speed, 34, 900);
  assert.ok(peak > 400, `positive overpressure shock front (${peak} Pa)`);
  const suction = evaluateFriedlanderWave(r, arrival + 0.22, speed, 34, 900);
  assert.ok(suction < -20, `negative Friedlander suction phase (${suction} Pa)`);
  assert.equal(evaluateFriedlanderWave(r, arrival + 5.0, speed, 34, 900), 0, 'settles back to zero');
});

test('WebGPU bone spring-damper simulation responds quadratically to wind speed, promotes close trees, and deflects under Friedlander shockwaves and push capsules', { timeout: 120000 }, async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>wind-gpu</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const portugalManifest = JSON.parse(fs.readFileSync('assets/forest-scenery/portugal/manifest.json', 'utf8'));
    const windManifest = JSON.parse(fs.readFileSync(PORTUGAL_FOREST_WIND_ASSETS['manifest.json'], 'utf8'));
    const bonesBytes = Array.from(zlib.gunzipSync(fs.readFileSync(PORTUGAL_FOREST_WIND_ASSETS['bones.bin.gz'])));
    // Only header + small slice of weights needed for compute pose verification.
    const simSource = fs.readFileSync('js/forest-wind.js', 'utf8');
    const commonSource = fs.readFileSync('js/wgsl/common.js', 'utf8');

    const result = await page.evaluate(async ({ simSource, commonSource, protos, windManifest, bonesBytes }) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return { skipped: true };
      const device = await adapter.requestDevice();
      const gpuErrors = [];
      device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const strip = (s) => s.replace(/^export\s+/gm, '');
      const commonMod = new Function(`${strip(commonSource)}; return { FRAME_WGSL };`)();
      const windMod = new Function(`${strip(simSource)}; return { createForestWind, FOREST_WIND_BONES, FOREST_WIND_SHARED_LANES, FOREST_WIND_EVENT_FRIEDLANDER, FOREST_WIND_BASIS_RADIAL };`)();

      const shader = async (code, label) => {
        const m = device.createShaderModule({ label, code });
        const info = await m.getCompilationInfo();
        const errs = info.messages.filter((x) => x.type === 'error');
        if (errs.length) throw Error(`${label}: ${errs.map((x) => x.message).join('; ')}`);
        return m;
      };

      // Minimal Frame UBO matching FRAME_WGSL layout (camPos at offset 80..96 or check exact offset via WGSL helper!).
      // Better yet: find exact byte offsets of F.camPos and F.windP[0] via a tiny reflection compute kernel!
      const probeMod = await shader(commonMod.FRAME_WGSL + `
        @group(0) @binding(0) var<uniform> F: Frame;
        @group(0) @binding(1) var<storage, read_write> out: array<vec4f, 2>;
        @compute @workgroup_size(1) fn main() { out[0] = F.camPos; out[1] = F.windP[0]; }
      `, 'probe');
      const probePipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: probeMod, entryPoint: 'main' } });
      const frameFloats = new Float32Array(512);
      for (let i = 0; i < 512; i++) frameFloats[i] = i + 1;
      const frameUBO = device.createBuffer({ size: 2048, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(frameUBO, 0, frameFloats);
      const probeOut = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const probeRead = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const probeBG = device.createBindGroup({ layout: probePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameUBO } }, { binding: 1, resource: { buffer: probeOut } }] });
      let enc = device.createCommandEncoder();
      let pass = enc.beginComputePass(); pass.setPipeline(probePipe); pass.setBindGroup(0, probeBG); pass.dispatchWorkgroups(1); pass.end();
      enc.copyBufferToBuffer(probeOut, 0, probeRead, 0, 32);
      device.queue.submit([enc.finish()]);
      await probeRead.mapAsync(GPUMapMode.READ);
      const probed = new Float32Array(probeRead.getMappedRange().slice(0));
      probeRead.unmap();
      const camPosIdx = Math.round(probed[0]) - 1;
      const windP0Idx = Math.round(probed[4]) - 1;

      const setFrame = (camX, camY, camZ, time, windDx, windDz, windSpeed) => {
        frameFloats.fill(0);
        frameFloats[camPosIdx + 0] = camX;
        frameFloats[camPosIdx + 1] = camY;
        frameFloats[camPosIdx + 2] = camZ;
        frameFloats[camPosIdx + 3] = time;
        frameFloats[windP0Idx + 0] = windDx;
        frameFloats[windP0Idx + 1] = windDz;
        frameFloats[windP0Idx + 2] = windSpeed;
        device.queue.writeBuffer(frameUBO, 0, frameFloats);
      };

      // Two trees of prototype 0 (oak veteran): tree 0 at (10, 0, 0) [close < 48m], tree 1 at (260, 0, 0) [far > 48m].
      const rootData = new Float32Array(2 * 12);
      rootData.set([10, 0, 0, 1.0, 0.0, 1, 1, 1, 0, 0, -1, 0], 0);
      rootData.set([260, 0, 0, 1.0, 0.0, 1, 1, 1, 0, 0, -1, 0], 12);
      const roots = device.createBuffer({ size: rootData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(roots, 0, rootData);

      const wind = await windMod.createForestWind({
        device,
        shader,
        frameWGSL: commonMod.FRAME_WGSL,
        frameUBO,
        windSource: {
          manifest: windManifest,
          bones: new Uint8Array(bonesBytes),
          weights: new Uint8Array(64),
        },
        roots,
        maxRoots: 8,
        prototypes: protos.map((p, i) => ({ ...p, firstRoot: i === 0 ? 0 : 2, rootCount: i === 0 ? 2 : 0 })),
      });
      wind.updateRoots(2);

      const readPoses = async () => {
        const rb = device.createBuffer({ size: wind.posesBuffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const ce = device.createCommandEncoder();
        ce.copyBufferToBuffer(wind.posesBuffer, 0, rb, 0, wind.posesBuffer.size);
        device.queue.submit([ce.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const raw = rb.getMappedRange().slice(0);
        rb.unmap(); rb.destroy();
        return { f32: new Float32Array(raw), u32: new Uint32Array(raw) };
      };

      const stepFrames = (n, startT, windSpeed) => {
        let t = startT;
        for (let i = 0; i < n; i++) {
          t += 0.016;
          setFrame(0, 2, 0, t, 1, 0, windSpeed);
          const ce = device.createCommandEncoder();
          const cp = ce.beginComputePass();
          wind.encode(cp);
          cp.end();
          device.queue.submit([ce.finish()]);
        }
        return t;
      };

      // 1. Step at 4 m/s light breeze and measure crown bend angle of shared lane 8 (wind +X) bone 4 (upper trunk) & bone 20 (branchlet).
      let now = stepFrames(35, 1.0, 4.0);
      const lowWind = await readPoses();
      const poseBase = lowWind.u32[0];
      const slot0 = lowWind.u32[4] & 65535;
      const slot1 = lowWind.u32[5] & 65535;

      const quatAngle = (f32, skelIdx, boneIdx) => {
        const at = (poseBase + (skelIdx * windMod.FOREST_WIND_BONES + boneIdx) * 2) * 4;
        const qw = Math.min(1, Math.abs(f32[at + 3]));
        return 2 * Math.acos(qw);
      };

      const bend4ms = quatAngle(lowWind.f32, 8, 4);

      // 2. Increase wind speed to 14 m/s: bend angle must increase substantially across trunk & boughs.
      now = stepFrames(90, now, 14.0);
      const highWind = await readPoses();
      const bend14ms = quatAngle(highWind.f32, 8, 4);

      // 3. Calm wind back down and fire a Friedlander blast wave + Push Capsule right next to far tree 1 at (260, 0, 0)!
      now = stepFrames(40, now, 1.0);
      const preBlast = await readPoses();
      const slot1BeforeBlast = preBlast.u32[5] & 65535;

      wind.emitForce({ x: 254, y: 6, z: 0, radius: 32, strengthPa: 1200, basis: windMod.FOREST_WIND_BASIS_RADIAL, eventType: windMod.FOREST_WIND_EVENT_FRIEDLANDER, now, waveSpeed: 280 });
      wind.setPushCapsule(2, { ax: 257, ay: 1, az: 0, bx: 257, by: 12, bz: 0, radius: 8.0, strength: 16000, now, duration: 2.0 });
      now = stepFrames(12, now, 1.0);
      const postBlast = await readPoses();
      const slot1AfterBlast = postBlast.u32[5] & 65535;
      const promoSkel1 = protos.length * windMod.FOREST_WIND_SHARED_LANES + (slot1AfterBlast - 1);
      const blastBranchAngle = slot1AfterBlast > 0 ? quatAngle(postBlast.f32, promoSkel1, 16) : 0;

      wind.destroy();
      await device.queue.onSubmittedWorkDone();
      return {
        skipped: false,
        gpuErrors,
        slot0,
        slot1,
        bend4ms,
        bend14ms,
        slot1BeforeBlast,
        slot1AfterBlast,
        blastBranchAngle,
      };
    }, { simSource, commonSource, protos: portugalManifest.prototypes, windManifest, bonesBytes });

    assert.equal(result.skipped, false, 'WebGPU adapter must be available on loopback secure context');
    assert.deepEqual(result.gpuErrors, [], `WebGPU validation errors: ${result.gpuErrors?.join('; ')}`);
    assert.ok(result.slot0 > 0, `close tree 0 (<48m) promoted to slot ${result.slot0}`);
    assert.equal(result.slot1, 0, 'far tree 1 (260m) remains on shared directional wind lanes');
    assert.ok(result.bend14ms > result.bend4ms * 2.2, `14 m/s trunk bend (${result.bend14ms.toFixed(4)} rad) > 2.2x 4 m/s (${result.bend4ms.toFixed(4)} rad)`);
    assert.equal(result.slot1BeforeBlast, 0);
    assert.ok(result.slot1AfterBlast > 0, 'Friedlander blast + push capsule promoted far tree 1 on GPU');
    assert.ok(result.blastBranchAngle > 0.08, `promoted tree branchlet deflected (${result.blastBranchAngle.toFixed(3)} rad) under blast & push capsule`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
