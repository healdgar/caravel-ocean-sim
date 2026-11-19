// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { extractShallowWaterGeometry } from '../js/shallow-water.js';

test('extractShallowWaterGeometry extracts stone cutwater piers, timber pile bents, collapsed rubble, and river reaches', () => {
  const geo = extractShallowWaterGeometry({
    bridges: [
      { x: 100, z: 200, ux: 1, uz: 0, length: 27, halfWidth: 2.5, deckY: 4.0, span: 23, isStone: true, collapsed: false },
      { x: 300, z: 400, ux: 0, uz: 1, length: 14, halfWidth: 1.6, deckY: 3.2, span: 12, isStone: false, collapsed: false },
      { x: 500, z: 600, ux: 1, uz: 0, length: 18, halfWidth: 2.2, deckY: 3.5, span: 15, isStone: true, collapsed: true },
    ],
    riverReaches: [
      {
        id: 0, isCanal: false,
        points: [
          [100, 140, 12, 1.5, 2.2, 0, 1.4, 0, 0],
          [100, 260, 12, 1.4, 2.2, 0, 1.4, 0, 0],
        ],
      },
    ],
    waterfront: [
      { x: -50, z: -80, yaw: 0.4, length: 18, width: 3.5, kind: 'jetty' },
      { x: -120, z: -40, yaw: 0.0, length: 24, width: 5.0, kind: 'mole' },
    ],
    worldOffset: { x: 10, z: -20 },
  });

  assert.equal(geo.reaches.length, 1);
  assert.equal(geo.reaches[0].ax, 110);
  assert.equal(geo.reaches[0].az, 120);
  assert.ok(geo.reaches[0].hw >= 12);
  // Stone 27m bridge => 3 arches of 9m => 4 piers (2 interior cutwaters kind=1 + 2 abutments kind=0)
  const cutwaters = geo.obstacles.filter((o) => o.kind === 1);
  assert.ok(cutwaters.length >= 2, `expected >= 2 interior stone cutwaters, got ${cutwaters.length}`);
  // Timber 14m bridge + timber jetty pilings + collapsed rubble => cylinder piles (kind=2)
  const cylinders = geo.obstacles.filter((o) => o.kind === 2);
  assert.ok(cylinders.length >= 18, `expected timber bridge piles + jetty pilings + rubble mounds, got ${cylinders.length}`);
  // Solid stone harbor mole (kind=0) centered at (-110, -60)
  assert.ok(geo.obstacles.some((o) => o.kind === 0 && Math.abs(o.cx - (-110)) < 1e-6 && Math.abs(o.cz - (-60)) < 1e-6));
  // Timber jetty pilings flank (-40, -100) rather than stamping an impervious box
  const jettyPiles = geo.obstacles.filter((o) => o.kind === 2 && Math.hypot(o.cx - (-40), o.cz - (-100)) < 11);
  assert.ok(jettyPiles.length >= 8, `expected >= 8 cylindrical timber jetty pilings, got ${jettyPiles.length}`);
});

test('2D GPU Shallow Water solver builds physical bow-wave pileup, arch acceleration, wake foam, and spray at bridge piers', { timeout: 120000 }, async () => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'],
    });
    const page = await browser.newPage();
    await page.route('**/__swe_test', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(origin + '/__swe_test');

    const result = await page.evaluate(async () => {
      const { createSurfaceWaves } = await import('/js/surface-waves.js');
      const { createShallowWater } = await import('/js/shallow-water.js');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);

      const shader = async (code, label) => {
        const mod = device.createShaderModule({ code, label });
        const bad = (await mod.getCompilationInfo()).messages.filter((m) => m.type === 'error');
        if (bad.length) throw Error(`${label}: ${bad.map((m) => m.message).join('\n')}`);
        return mod;
      };
      const computePipe = async (code, label) => {
        const mod = await shader(code, label);
        return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
      };

      const B = GPUBufferUsage, T = GPUTextureUsage;
      const frameUBO = device.createBuffer({ size: 384, usage: B.UNIFORM | B.COPY_DST });
      const sunVisBuf = device.createBuffer({ size: 16, usage: B.STORAGE | B.COPY_DST });
      device.queue.writeBuffer(sunVisBuf, 0, new Float32Array([1, 1, 1, 1]));
      const lut = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: T.TEXTURE_BINDING });
      const samp = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });

      const sw = await createSurfaceWaves({ device, computePipe, size: 512 });
      const swe = await createShallowWater({
        device, shader, computePipe, surfaceWaves: sw,
        frameUBO, transView: lut.createView(), skyView: lut.createView(), sampClamp: samp, sunVisBuf,
        format: 'rgba16float', samples: 4, size: 512,
      });
      sw.attachShallowWater(swe);

      // Straight river flowing +Z at 1.8 m/s (x in [-16, 16], z in [-120, 120]), crossed by a stone bridge at z = 0
      // with an interior stone cutwater pier right at (x = 0, z = 0) and two arches at x = ±4.5 m!
      swe.setWorld({
        bridges: [
          { x: 0, z: 0, ux: 1, uz: 0, length: 18, halfWidth: 2.4, deckY: 4.0, span: 16, isStone: true, collapsed: false },
        ],
        riverReaches: [
          {
            id: 0, isCanal: false,
            points: [
              [0, -120, 16, 1.0, 2.0, 0, 1.8, 0, 0],
              [0, 120, 16, 1.0, 2.0, 0, 1.8, 0, 0],
            ],
          },
        ],
        waterfront: [],
      });

      // Step 120 frames (2.0 s at 60 FPS) so upstream bow wave & advected downstream wake establish
      for (let f = 0; f < 120; f++) {
        sw.update({ x: 0, z: 0 }, 1 / 60);
        const enc = device.createCommandEncoder();
        const cp = enc.beginComputePass();
        sw.encode(cp);
        cp.end();
        device.queue.submit([enc.finish()]);
      }
      await device.queue.onSubmittedWorkDone();

      // Read back Layer 2 (SWE: eta, u, v, foam)
      const size = 512, dx = 0.5;
      const half = (n) => {
        const e = (n >> 10) & 31, m = n & 1023;
        return (n & 32768 ? -1 : 1) * (e === 31 ? Infinity : e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24);
      };
      const rb = device.createBuffer({ size: size * size * 8, usage: B.MAP_READ | B.COPY_DST });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: sw.textures[sw.current], origin: [0, 0, 2] }, { buffer: rb, bytesPerRow: size * 8 }, [size, size]);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const data = Float32Array.from(new Uint16Array(rb.getMappedRange()), half);
      rb.unmap();
      rb.destroy();

      const sampleAt = (wx, wz) => {
        const gx = Math.max(0, Math.min(size - 1, Math.round(wx / dx + size / 2 - 0.5)));
        const gz = Math.max(0, Math.min(size - 1, Math.round(wz / dx + size / 2 - 0.5)));
        const o = (gz * size + gx) * 4;
        return { eta: data[o], u: data[o + 1], v: data[o + 2], foam: data[o + 3] };
      };

      let finite = true, maxEtaUp = -99, maxFoamNear = 0, maxWakeFoam = 0;
      for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) finite = false;

      // Upstream nose of center cutwater pier (x near 0, z in [-4.5, -2.5])
      for (let wz = -5.0; wz <= -2.0; wz += 0.5) {
        for (let wx = -1.5; wx <= 1.5; wx += 0.5) {
          const s = sampleAt(wx, wz);
          if (s.eta > maxEtaUp) maxEtaUp = s.eta;
          if (s.foam > maxFoamNear) maxFoamNear = s.foam;
        }
      }
      // Downstream wake behind center cutwater pier (z in [3.5, 14.0])
      for (let wz = 3.5; wz <= 14.0; wz += 0.5) {
        for (let wx = -2.5; wx <= 2.5; wx += 0.5) {
          const s = sampleAt(wx, wz);
          if (s.foam > maxWakeFoam) maxWakeFoam = s.foam;
        }
      }
      const archMid = sampleAt(4.5, 0.0);
      const freeStream = sampleAt(0.0, -35.0);
      // Measure Nyquist 2-cell checkerboard ringing across open river upstream (must stay near zero!)
      let maxCheckerboard = 0;
      for (let wz = -40.0; wz <= -12.0; wz += 1.0) {
        const a = sampleAt(3.0, wz - 0.5).eta;
        const b = sampleAt(3.0, wz).eta;
        const c = sampleAt(3.0, wz + 0.5).eta;
        const ring = Math.abs(a - 2 * b + c);
        if (ring > maxCheckerboard) maxCheckerboard = ring;
      }

      swe.destroy();
      sw.destroy();
      return {
        errors, finite, active: swe.stats.active, obs: swe.stats.obstacles, reaches: swe.stats.reaches,
        maxEtaUp, maxFoamNear, maxWakeFoam, archMid, freeStream, maxCheckerboard,
      };
    });

    assert.deepEqual(result.errors, [], 'zero WebGPU validation errors');
    assert.equal(result.finite, true, 'all 512x512 SWE cells must remain finite');
    assert.equal(result.active, true);
    assert.ok(result.obs >= 3, `expected bridge pier obstacles, got ${result.obs}`);
    assert.ok(result.maxEtaUp > 0.04, `expected physical upstream bow-wave pileup > 4 cm, got ${result.maxEtaUp.toFixed(4)} m`);
    assert.ok(result.maxFoamNear > 0.12, `expected aerated collar foam at cutwater > 0.12, got ${result.maxFoamNear.toFixed(3)}`);
    assert.ok(result.maxWakeFoam > 0.05, `expected advected downstream wake foam > 0.05, got ${result.maxWakeFoam.toFixed(3)}`);
    assert.ok(result.freeStream.foam < 0.02, `expected clear calm upstream river (zero uniform froth), got foam=${result.freeStream.foam.toFixed(4)}`);
    assert.ok(result.maxCheckerboard < 0.015, `expected zero 2-dx Nyquist zebra-stripe ringing (< 1.5 cm), got ${result.maxCheckerboard.toFixed(4)} m`);
    assert.ok(result.archMid.v > 1.2, `expected live downstream flow through bridge arch, got v=${result.archMid.v.toFixed(2)} m/s`);
    assert.ok(result.freeStream.v > 1.2, `expected sustained upstream river current, got v=${result.freeStream.v.toFixed(2)} m/s`);
  } finally {
    await browser?.close();
    server.close();
  }
});
