// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { COMPOSITE, createUnderwaterPost } from '../js/wgsl/post.js';
import { createNeuralComposite } from '../js/wgsl/neural-post.js';
import {
  NEURAL_LIGHT_WEIGHT_FLOATS,
  NEURAL_LIGHT_WEIGHT_BYTES,
  NEURAL_LIGHT_WEIGHTS_FAST,
  NEURAL_LIGHT_WEIGHTS_DEPTH,
} from '../js/models/neural-light-weights.js';

let neuralServer, neuralBrowser, neuralOrigin;

before(async () => {
  neuralServer = createDevServer();
  neuralServer.listen(0, '127.0.0.1');
  await once(neuralServer, 'listening');
  neuralOrigin = 'http://127.0.0.1:' + neuralServer.address().port;
  neuralBrowser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: process.env.WEBGPU_BACKEND === 'metal'
      ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog']
      : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
  });
});

after(async () => {
  await neuralBrowser?.close();
  neuralServer?.closeAllConnections?.();
  if (neuralServer) await new Promise(resolve => neuralServer.close(resolve));
});

test('neural weights and composite shader variants satisfy layout and minification invariants', () => {
  assert.equal(NEURAL_LIGHT_WEIGHT_FLOATS * 4, NEURAL_LIGHT_WEIGHT_BYTES);
  assert.equal(NEURAL_LIGHT_WEIGHTS_FAST.length, NEURAL_LIGHT_WEIGHT_FLOATS);
  assert.equal(NEURAL_LIGHT_WEIGHTS_DEPTH.length, NEURAL_LIGHT_WEIGHT_FLOATS);
  assert.equal(NEURAL_LIGHT_WEIGHTS_FAST.byteLength, NEURAL_LIGHT_WEIGHT_BYTES);
  assert.equal(NEURAL_LIGHT_WEIGHTS_DEPTH.byteLength, NEURAL_LIGHT_WEIGHT_BYTES);
  assert.ok(NEURAL_LIGHT_WEIGHTS_FAST.every(Number.isFinite));
  assert.ok(NEURAL_LIGHT_WEIGHTS_DEPTH.every(Number.isFinite));

  const minify = src => src.replace(/\s+/g, ' ').replace(/ ?([{}()[\],;:=<>*&|^!%@.]) ?/g, '$1');
  for (const base of [COMPOSITE, minify(COMPOSITE)]) {
    const plain = createNeuralComposite(base);
    assert.match(plain, /neuralApplyHDR\s*\(/);
    assert.doesNotMatch(plain, /postCameraSea/);

    const medium = createNeuralComposite(createUnderwaterPost(base, 'composite'));
    assert.match(medium, /neuralApplyHDR\s*\(/);
    assert.match(medium, /if\s*\(\s*postCameraSea\[9\]\s*-\s*postFrame\.camPos\.y\s*<=\s*\.005\s*\)/);
  }
  assert.throws(() => createNeuralComposite('not a composite shader'), /Unrecognized/);
});

test('WebGPU neural light pass compiles cleanly, leaves pure sky untouched, modulates 3D surfaces, and converges temporally', { timeout: 120000 }, async t => {
  const page = await neuralBrowser.newPage();
  try {
    await page.route('**/__neural-post-unit', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(neuralOrigin + '/__neural-post-unit');
    const result = await page.evaluate(async () => {
      const { createGPUProgramCache } = await import('/js/gpu-program-cache.js');
      const { withCelestialFrame, CELESTIAL_FRAME_FLOATS } = await import('/js/wgsl/celestial.js');
      const { pruneWGSLFunctions } = await import('/js/wgsl-prune.js');
      const { COMPOSITE } = await import('/js/wgsl/post.js');
      const { createNeuralLightPass } = await import('/js/neural-post.js');
      const { measureIsolatedGPUStage } = await import('/js/gpu-benchmark.js');

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU adapter unavailable');
      const hasTS = adapter.features.has('timestamp-query');
      const device = await adapter.requestDevice({
        requiredFeatures: hasTS ? ['timestamp-query'] : [],
      });
      const errors = [];
      device.addEventListener('uncapturederror', e => errors.push(e.error.message));

      const compileErrors = [];
      const { shader } = createGPUProgramCache({
        device,
        prepare: code => pruneWGSLFunctions(withCelestialFrame(code)),
        report(messages, _code, label) {
          for (const m of messages) if (m.type === 'error') compileErrors.push(`${label}: ${m.message}`);
        },
      });

      const B = GPUBufferUsage, T = GPUTextureUsage;
      const half = value => {
        if (value < 0) return half(-value) | 32768;
        if (value === 0) return 0;
        const e = Math.floor(Math.log2(value));
        return Math.max(0, Math.min(65535, ((e + 15) << 10) + Math.round((value / 2 ** e - 1) * 1024)));
      };

      const frameF = new Float32Array(CELESTIAL_FRAME_FLOATS);
      // Standard perspective viewProj looking slightly downward across a textured harbour surface
      const viewProj = new Float32Array([
        1.2, 0, 0, 0,
        0, 1.6, 0, 0,
        0, 0, 0, -1,
        0, 0, 0.05, 0,
      ]);
      frameF.set(viewProj, 0);
      frameF.set([0, 4, 0, 0], 16);
      frameF.set([0.83, 0, 0, 0], 20);
      frameF.set([0, 0.62, 0, 0], 24);
      frameF.set([0, -0.12, -0.9927, 0], 28);
      frameF.set([0.45, 0.35, -0.82, 14], 32);

      const frameUBO = device.createBuffer({ size: frameF.byteLength, usage: B.UNIFORM | B.COPY_DST });
      device.queue.writeBuffer(frameUBO, 0, frameF);
      const compUBO = device.createBuffer({ size: 32, usage: B.UNIFORM | B.COPY_DST });
      device.queue.writeBuffer(compUBO, 0, new Float32Array([1.35, 0, 3, 0.1, 1.05, 1.06, 0, 1]));
      const probeBuf = device.createBuffer({ size: 64, usage: B.STORAGE | B.COPY_DST });
      const linSamp = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });

      const compMod = await shader(COMPOSITE, 'ref composite');
      const refCompPipe = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: compMod, entryPoint: 'vs' },
        fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });

      const neural = await createNeuralLightPass({
        device,
        shader,
        frameUBO,
        linSamp,
        swapFormat: 'rgba8unorm',
        samples: 1,
        initialMode: 'fast',
      });

      const readRGBA8 = async (tex, w, h) => {
        const bpr = Math.ceil((w * 4) / 256) * 256;
        const buf = device.createBuffer({ size: bpr * h, usage: B.COPY_DST | B.MAP_READ });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
        device.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(buf.getMappedRange());
        const out = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) out.set(mapped.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
        buf.unmap();
        buf.destroy();
        return out;
      };

      const diffStats = (a, b) => {
        let max = 0, sum = 0, changed = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a[i + c] - b[i + c]);
            if (d > max) max = d;
            sum += d;
            if (d > 0) changed++;
          }
        }
        return { max, mean: sum / ((a.length / 4) * 3), changed };
      };

      // 1. Pure sky check (looking straight up at uniform sky, zero depth)
      {
        const w = 64, h = 48;
        frameF.set([0, 0.85, -0.52, 0], 28); // looking high into sky (ray.y > 0.25 everywhere)
        frameF.set([w, h, 1 / w, 1 / h], 36);
        device.queue.writeBuffer(frameUBO, 0, frameF);

        const hdr = device.createTexture({ size: [w, h], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
        const bloom = device.createTexture({ size: [w >> 1, h >> 1], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
        const depth = device.createTexture({ size: [w, h], format: 'depth32float', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
        const outRef = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
        const outNeu = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });

        const skyPx = new Uint16Array(w * h * 4);
        const px = [half(0.22), half(0.36), half(0.68), half(1.0)];
        for (let i = 0; i < w * h; i++) skyPx.set(px, i * 4);
        device.queue.writeTexture({ texture: hdr }, skyPx, { bytesPerRow: w * 8 }, [w, h]);

        neural.resize({
          width: w, height: h,
          hdrView: hdr.createView(),
          mediumView: hdr.createView(),
          bloomView: bloom.createView(),
          compUBO,
          cameraProbe: probeBuf,
          depthView: depth.createView(),
        });

        const refGroup = device.createBindGroup({
          layout: refCompPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: hdr.createView() },
            { binding: 1, resource: bloom.createView() },
            { binding: 2, resource: linSamp },
            { binding: 3, resource: { buffer: compUBO } },
          ],
        });

        const enc = device.createCommandEncoder();
        const dp = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
        dp.end();
        neural.update({ viewProj, camX: 0, camY: 4, camZ: 0, strength: 0.85, resetHistory: true });
        neural.encode(enc);
        const pRef = enc.beginRenderPass({ colorAttachments: [{ view: outRef.createView(), loadOp: 'clear', storeOp: 'store' }] });
        pRef.setPipeline(refCompPipe); pRef.setBindGroup(0, refGroup); pRef.draw(3); pRef.end();
        const pNeu = enc.beginRenderPass({ colorAttachments: [{ view: outNeu.createView(), loadOp: 'clear', storeOp: 'store' }] });
        neural.drawComposite(pNeu, false); pNeu.end();
        device.queue.submit([enc.finish()]);

        const skyDiff = diffStats(await readRGBA8(outRef, w, h), await readRGBA8(outNeu, w, h));
        for (const t of [hdr, bloom, depth, outRef, outNeu]) t.destroy();
        if (skyDiff.max > 1) throw new Error('Pure sky altered by neural pass: ' + JSON.stringify(skyDiff));
      }

      // 2. Textured 3D wall/crevice check across fast & depth modes + temporal convergence
      const w = 96, h = 64;
      frameF.set([0, -0.25, -0.968, 0], 28); // looking down at lit stone & shaded crease
      frameF.set([w, h, 1 / w, 1 / h], 36);
      device.queue.writeBuffer(frameUBO, 0, frameF);

      const hdr = device.createTexture({ size: [w, h], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
      const bloom = device.createTexture({ size: [w >> 1, h >> 1], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
      const depth = device.createTexture({ size: [w, h], format: 'depth32float', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
      const outRef = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
      const outFast0 = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
      const outFast1 = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
      const outFast2 = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
      const outDepth = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });

      const surfPx = new Uint16Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const litWall = x < w * 0.48;
          const micro = ((x * 7 + y * 13) % 5) * 0.035;
          const r = (litWall ? 0.95 : 0.16) + micro;
          const g = (litWall ? 0.68 : 0.15) + micro * 0.8;
          const b = (litWall ? 0.36 : 0.18) + micro * 0.5;
          surfPx.set([half(r), half(g), half(b), half(1.0)], (y * w + x) * 4);
        }
      }
      device.queue.writeTexture({ texture: hdr }, surfPx, { bytesPerRow: w * 8 }, [w, h]);
      {
        const dMod = device.createShaderModule({
          code: `
            @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
              let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
              return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
            }
            @fragment fn fs(@builtin(position) pos: vec4f) -> @builtin(frag_depth) f32 {
              let u = pos.x / ${w}.0;
              let v = pos.y / ${h}.0;
              // Concave 3D interior corner between a sunlit wall (u < 0.48) and a shaded wall (u >= 0.48)
              let cornerT = abs(u - 0.48);
              let zEye = 4.2 + cornerT * 7.5 + (1.0 - v) * 2.0;
              return 0.05 / zEye;
            }
          `,
        });
        const dPipe = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module: dMod, entryPoint: 'vs' },
          fragment: { module: dMod, entryPoint: 'fs', targets: [] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        });
        const enc = device.createCommandEncoder();
        const dp = enc.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        dp.setPipeline(dPipe);
        dp.draw(3);
        dp.end();
        device.queue.submit([enc.finish()]);
      }

      neural.resize({
        width: w, height: h,
        hdrView: hdr.createView(),
        mediumView: hdr.createView(),
        bloomView: bloom.createView(),
        compUBO,
        cameraProbe: probeBuf,
        depthView: depth.createView(),
      });

      const refGroup = device.createBindGroup({
        layout: refCompPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: hdr.createView() },
          { binding: 1, resource: bloom.createView() },
          { binding: 2, resource: linSamp },
          { binding: 3, resource: { buffer: compUBO } },
        ],
      });

      const runFrame = outTex => {
        const enc = device.createCommandEncoder();
        neural.update({ viewProj, camX: 0, camY: 4, camZ: 0, strength: 0.85 });
        neural.encode(enc);
        const p = enc.beginRenderPass({ colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store' }] });
        neural.drawComposite(p, false);
        p.end();
        device.queue.submit([enc.finish()]);
      };

      {
        const enc = device.createCommandEncoder();
        const p = enc.beginRenderPass({ colorAttachments: [{ view: outRef.createView(), loadOp: 'clear', storeOp: 'store' }] });
        p.setPipeline(refCompPipe); p.setBindGroup(0, refGroup); p.draw(3); p.end();
        device.queue.submit([enc.finish()]);
      }

      runFrame(outFast0);
      runFrame(outFast1);
      runFrame(outFast2);

      await neural.setMode('depth');
      runFrame(outDepth);

      let isolatedMs = null;
      if (hasTS) {
        const timing = await measureIsolatedGPUStage({
          device,
          encode: neural.encodeIsolated,
          passCount: neural.passCount,
          width: w,
          height: h,
        });
        isolatedMs = timing.milliseconds;
      }

      await neural.setMode('fast');

      const refBytes = await readRGBA8(outRef, w, h);
      const f0Bytes = await readRGBA8(outFast0, w, h);
      const f1Bytes = await readRGBA8(outFast1, w, h);
      const f2Bytes = await readRGBA8(outFast2, w, h);
      const dBytes = await readRGBA8(outDepth, w, h);

      const fastEffect = diffStats(refBytes, f2Bytes);
      const depthEffect = diffStats(refBytes, dBytes);
      const modeDelta = diffStats(f2Bytes, dBytes);
      const step01 = diffStats(f0Bytes, f1Bytes);
      const step12 = diffStats(f1Bytes, f2Bytes);

      neural.destroy();
      for (const t of [hdr, bloom, depth, outRef, outFast0, outFast1, outFast2, outDepth]) t.destroy();
      frameUBO.destroy(); compUBO.destroy(); probeBuf.destroy();
      await device.queue.onSubmittedWorkDone();
      device.destroy();

      return {
        errors,
        compileErrors,
        hasTS,
        isolatedMs,
        fastEffect,
        depthEffect,
        modeDelta,
        step01,
        step12,
      };
    });

    t.diagnostic(JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.compileErrors, []);
    assert.ok(result.fastEffect.changed > 100 && result.fastEffect.max >= 3, 'fast neural mode must actively modulate 3D lit/shaded surfaces');
    assert.ok(result.depthEffect.changed > 100 && result.depthEffect.max >= 3, 'depth neural mode must actively modulate 3D lit/shaded surfaces');
    assert.ok(result.modeDelta.changed > 0, 'depth mode uses distinct 3D normal/depth weights from fast mode');
    assert.ok(result.step12.mean <= result.step01.mean + 1e-6, 'static-camera temporal reprojection must be contractive');
    if (result.hasTS) {
      assert.ok(Number.isFinite(result.isolatedMs) && result.isolatedMs >= 0 && result.isolatedMs < 5000);
    }
  } finally {
    await page.close();
  }
});

test('live scene keeps TBDR depth discard in fast mode, measures neural pass alone, and switches cleanly to depth mode', { timeout: 180000 }, async t => {
  const page = await neuralBrowser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.addInitScript(() => {
      const diag = window.__neuralSceneDiag = { depthStores: 0, depthDiscards: 0, errors: [] };
      const req = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const dev = await req.apply(this, args);
        dev.addEventListener('uncapturederror', e => diag.errors.push(e.error.message));
        return dev;
      };
      const beginRP = GPUCommandEncoder.prototype.beginRenderPass;
      GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
        const ds = desc?.depthStencilAttachment;
        if (ds && desc?.colorAttachments?.[0]?.resolveTarget) {
          if (ds.depthStoreOp === 'store') diag.depthStores++;
          else if (ds.depthStoreOp === 'discard') diag.depthDiscards++;
        }
        return beginRP.call(this, desc);
      };
    });

    // Place camera high above water (view=free, cam=0,35,60) so cameraMediumBand is false -> isolates neuralPass depthStoreOp behavior!
    await page.goto(neuralOrigin + '/docs/index.html?ocean=1&boat=0&cam=0,35,60,0,-18&crew=0&follower=0&clouds=0&neural=0.75&w=640&h=400');
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');

    const fastCheck = await page.evaluate(() => ({
      mode: window.oceanNeuralLight?.mode,
      active: window.oceanNeuralLight?.active,
      wantsDepth: window.oceanNeuralLight?.wantsDepth,
      depthStores: window.__neuralSceneDiag.depthStores,
      depthDiscards: window.__neuralSceneDiag.depthDiscards,
      errors: window.__neuralSceneDiag.errors,
    }));
    assert.equal(fastCheck.mode, 'fast');
    assert.equal(fastCheck.active, true);
    assert.equal(fastCheck.wantsDepth, false);
    assert.equal(fastCheck.depthStores, 0, 'fast mode above water must never force MSAA depthStoreOp = store');
    assert.ok(fastCheck.depthDiscards > 0);
    assert.deepEqual(fastCheck.errors, []);

    // Measure isolated neural pass from Performance stats panel
    await page.getByRole('button', { name: 'Performance stats', exact: true }).click();
    const measureBtn = page.getByRole('button', { name: 'Measure neural pass alone', exact: true });
    if (await measureBtn.isEnabled()) {
      await measureBtn.click();
      await page.waitForFunction(
        () => document.querySelector('#neural-measurement')?.dataset.measurement || document.querySelector('#neural-measurement')?.textContent.includes('unavailable'),
        undefined,
        { timeout: 30000 },
      );
      const text = await page.locator('#neural-measurement').textContent();
      t.diagnostic(text);
      const raw = await page.locator('#neural-measurement').getAttribute('data-measurement');
      assert.ok(raw, text);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.passCount, 2);
      assert.equal(parsed.width, 640);
      assert.equal(parsed.height, 400);
    }

    // Switch live to 3D depth-guided mode and verify depthStoreOp switches to 'store' with zero GPU errors
    await page.evaluate(async () => {
      window.__neuralSceneDiag.depthStores = 0;
      await window.oceanNeuralLight.setMode('depth');
    });
    await page.waitForFunction(() => window.__neuralSceneDiag.depthStores >= 3, undefined, { timeout: 15000 });
    const depthCheck = await page.evaluate(() => ({
      mode: window.oceanNeuralLight.mode,
      wantsDepth: window.oceanNeuralLight.wantsDepth,
      depthStores: window.__neuralSceneDiag.depthStores,
      errors: window.__neuralSceneDiag.errors,
    }));
    assert.equal(depthCheck.mode, 'depth');
    assert.equal(depthCheck.wantsDepth, true);
    assert.ok(depthCheck.depthStores >= 3);
    assert.deepEqual(depthCheck.errors, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
