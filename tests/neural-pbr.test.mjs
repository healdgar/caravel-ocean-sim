// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import {
  NEURAL_PBR_ASSET_PATH,
  NEURAL_PBR_MATERIAL_COUNT,
  NEURAL_PBR_WORDS_PER_BAND,
  NEURAL_PBR_WORDS_PER_MATERIAL,
  NEURAL_PBR_TOTAL_WORDS,
  NEURAL_PBR_UNIFORM_FLOATS,
  NEURAL_PBR_DEFAULT_WEIGHTS,
  NEURAL_PBR_MATERIALS,
} from '../js/models/neural-pbr-weights.js';
import { parseNeuralPbrLatentBinary } from '../js/neural-pbr.js';
import {
  createNeuralPbrWGSL,
  withNeuralPbrVessel,
  withNeuralPbrTerrain,
} from '../js/wgsl/neural-pbr.js';
import { CARAVEL } from '../js/wgsl/caravel.js';
import { VESSEL_CONTINUUM_MATERIAL } from '../js/vessel-continuum.js';
import { TERRAIN } from '../js/wgsl/terrain.js';
import { PROP_CONTINUUM_MATERIAL_SPEC } from '../js/wgsl/prop-continuum.js';
import { continuumModuleWGSL } from '../js/wgsl/continuum-cut.js';
import { createSubmergedShader } from '../js/water-optics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pbrServer, pbrBrowser, pbrOrigin;

async function importFromGitRef(ref, relPath) {
  const src = execFileSync('git', ['show', `${ref}:${relPath}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const baseDir = path.dirname(path.join(ROOT, relPath));
  const rewritten = src.replace(
    /(from\s+['"])(\.[^'"]+)(['"])/g,
    (_m, pre, spec, post) => `${pre}${pathToFileURL(path.resolve(baseDir, spec)).href}${post}`
  );
  const b64 = Buffer.from(rewritten, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
}

before(async () => {
  pbrServer = createDevServer();
  pbrServer.listen(0, '127.0.0.1');
  await once(pbrServer, 'listening');
  pbrOrigin = 'http://127.0.0.1:' + pbrServer.address().port;
  pbrBrowser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: process.env.WEBGPU_BACKEND === 'metal'
      ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog']
      : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
  });
});

after(async () => {
  await pbrBrowser?.close();
  pbrServer?.closeAllConnections?.();
  if (pbrServer) await new Promise(resolve => pbrServer.close(resolve));
});

test('NPBR v1 binary latent pyramids and uniform weights satisfy exact layout and mip-6 zero-identity invariants', () => {
  assert.equal(NEURAL_PBR_DEFAULT_WEIGHTS.length, NEURAL_PBR_UNIFORM_FLOATS);
  assert.equal(NEURAL_PBR_DEFAULT_WEIGHTS.byteLength, 2384);
  assert.equal(NEURAL_PBR_DEFAULT_WEIGHTS.byteLength % 16, 0, 'Uniform buffer must be 16-byte aligned');
  assert.ok(NEURAL_PBR_DEFAULT_WEIGHTS.every(Number.isFinite));
  assert.equal(NEURAL_PBR_MATERIALS.length, 12);

  const gzPath = path.join(ROOT, NEURAL_PBR_ASSET_PATH);
  assert.ok(fs.existsSync(gzPath), `Missing trained NPBR binary at ${gzPath}`);
  const gzBytes = fs.readFileSync(gzPath);
  assert.ok(gzBytes.byteLength < 550 * 1024, `Expected compact <550 KB gzipped bank, got ${gzBytes.byteLength} B`);

  const rawBytes = zlib.gunzipSync(gzBytes);
  const words = parseNeuralPbrLatentBinary(rawBytes);
  assert.equal(words.length, NEURAL_PBR_TOTAL_WORDS);

  for (let m = 0; m < NEURAL_PBR_MATERIAL_COUNT; m++) {
    const matBase = m * NEURAL_PBR_WORDS_PER_MATERIAL;
    const band0Base = matBase;
    const band1Base = matBase + NEURAL_PBR_WORDS_PER_BAND;

    // Mip 6 (offset 5460) MUST be exact zero in both bands so far-field == identity
    assert.equal(words[band0Base + 5460], 0, `Material ${m} (${NEURAL_PBR_MATERIALS[m].slug}) band 0 mip 6 must be 0`);
    assert.equal(words[band1Base + 5460], 0, `Material ${m} (${NEURAL_PBR_MATERIALS[m].slug}) band 1 mip 6 must be 0`);

    // Mips 3..5 of micro-band (offsets 5376..5459) are attenuated to 0 to prevent sub-Nyquist aliasing
    for (let i = 5376; i < 5460; i++) {
      assert.equal(words[band1Base + i], 0, `Material ${m} micro-band coarse word ${i - 5376} must be 0`);
    }

    // Mip 0 (offsets 0..4095) must carry non-trivial learned meso & micro structure
    let nonZero0 = 0, nonZero1 = 0;
    for (let i = 0; i < 4096; i++) {
      if (words[band0Base + i] !== 0) nonZero0++;
      if (words[band1Base + i] !== 0) nonZero1++;
    }
    assert.ok(nonZero0 > 3000, `Material ${m} meso mip 0 under-populated (${nonZero0}/4096)`);
    assert.ok(nonZero1 > 3000, `Material ${m} micro mip 0 under-populated (${nonZero1}/4096)`);
  }
});

test('WGSL transforms respect zero-sampled-texture budget, minification invariance, and reject malformed shader sources', () => {
  const wgslBlock = createNeuralPbrWGSL({ group: 0, latentBinding: 16, weightBinding: 17 });
  assert.doesNotMatch(wgslBlock, /\btexture_2d\b|\btexture_cube\b|\bsampler\b/, 'NPBR must add zero textures/samplers');
  assert.doesNotMatch(wgslBlock, /\bdiscard\b/, 'NPBR must never introduce discard into opaque passes');

  const baseSubTer = createSubmergedShader(TERRAIN, 'fs', 'in.world', true, true);
  const npbrSubTer = createSubmergedShader(withNeuralPbrTerrain(TERRAIN), 'fs', 'in.world', true, true);
  const countTex = s => [...s.matchAll(/\bvar\s+\w+\s*:\s*texture_(?!storage)/g)].length;
  assert.equal(countTex(npbrSubTer), countTex(baseSubTer), 'NPBR must add zero sampled textures to submerged terrain');

  const minify = src => src.replace(/\s+/g, ' ').replace(/ ?([{}()[\],;:=<>*&|^!%@.]) ?/g, '$1');
  assert.match(withNeuralPbrVessel(minify(CARAVEL)), /neuralPbrAnisoSpecular/);
  assert.match(withNeuralPbrTerrain(minify(TERRAIN)), /evalNeuralPbr/);
  // The props' material writes the bank into its own shade: its composed view carries it with no rewriting.
  assert.match(continuumModuleWGSL({ pass: 'view', material: PROP_CONTINUUM_MATERIAL_SPEC }), /neuralPbrAnisoSpecular/);

  assert.throws(() => withNeuralPbrVessel('fn broken() {}'), /missing anchor/);
  assert.throws(() => withNeuralPbrTerrain('fn broken() {}'), /missing anchor/);
});

test('WebGPU compiles HEAD + submerged + direct `main`-branch shaders with zero errors and isolates non-landSurface bindings', { timeout: 120000 }, async () => {
  // Load actual `main` branch shader modules directly from git to prove zero-conflict portability!
  const [mainCaravel, mainTerrain] = await Promise.all([
    importFromGitRef('main', 'js/wgsl/caravel.js'),
    importFromGitRef('main', 'js/wgsl/terrain.js'),
  ]);

  const mainVariants = {
    caravel: withNeuralPbrVessel(mainCaravel.CARAVEL),
    terrain: withNeuralPbrTerrain(mainTerrain.TERRAIN),
  };

  const headVariants = {
    caravel: withNeuralPbrVessel(CARAVEL),
    // The ships' continuum view wears the bank in her shading, damage and all (js/vessel-continuum.js).
    vessel: continuumModuleWGSL({ pass: 'view', material: VESSEL_CONTINUUM_MATERIAL }),
    terrain: withNeuralPbrTerrain(TERRAIN),
    terrainSubmerged: createSubmergedShader(withNeuralPbrTerrain(TERRAIN), 'fs', 'in.world', true, true),
    vesselSubmerged: createSubmergedShader(withNeuralPbrVessel(CARAVEL), 'fs', 'in.world', false, false),
    props: continuumModuleWGSL({ pass: 'view', material: PROP_CONTINUUM_MATERIAL_SPEC }),
  };

  const page = await pbrBrowser.newPage();
  try {
    await page.route('**/__neural-pbr-compile', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(pbrOrigin + '/__neural-pbr-compile');

    const report = await page.evaluate(async ({ headSrcs, mainSrcs }) => {
      const { withCelestialFrame } = await import('/js/wgsl/celestial.js');
      const { pruneWGSLFunctions } = await import('/js/wgsl-prune.js');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU adapter unavailable');
      const device = await adapter.requestDevice();
      const uncaptured = [];
      device.addEventListener('uncapturederror', e => uncaptured.push(e.error.message));

      async function compileCheck(label, rawCode) {
        const code = pruneWGSLFunctions(withCelestialFrame(rawCode));
        const mod = device.createShaderModule({ label, code });
        const info = await mod.getCompilationInfo();
        const errs = info.messages.filter(m => m.type === 'error').map(m => `${label}:${m.lineNum}:${m.linePos} ${m.message}`);
        return { mod, errs };
      }

      const errors = [];
      const compiledHead = {};
      for (const [k, src] of Object.entries(headSrcs)) {
        const res = await compileCheck(`HEAD.${k}`, src);
        errors.push(...res.errs);
        compiledHead[k] = res.mod;
      }
      for (const [k, src] of Object.entries(mainSrcs)) {
        const res = await compileCheck(`main.${k}`, src);
        errors.push(...res.errs);
      }


      await device.queue.onSubmittedWorkDone();
      return { errors, uncaptured };
    }, { headSrcs: headVariants, mainSrcs: mainVariants });

    assert.deepEqual(report.errors, [], `Shader compilation errors:\n${report.errors.join('\n')}`);
    assert.deepEqual(report.uncaptured, [], `Uncaptured WebGPU errors:\n${report.uncaptured.join('\n')}`);
  } finally {
    await page.close();
  }
});

test('GPU decoder probe verifies exact f(0)=identity, distance/mip fade, 12-material micro-detail, and Burley anisotropic GGX parity', { timeout: 120000 }, async () => {
  const page = await pbrBrowser.newPage();
  try {
    await page.goto(pbrOrigin + '/index.html?neuralPbrProbeOnly=1', { waitUntil: 'domcontentloaded' });
    // Navigate to clean blank origin route so main.js doesn't contend with unit test device
    await page.route('**/__neural-pbr-probe', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(pbrOrigin + '/__neural-pbr-probe');

    const probe = await page.evaluate(async () => {
      const { createNeuralPbrBank } = await import('/js/neural-pbr.js');
      const { createNeuralPbrWGSL } = await import('/js/wgsl/neural-pbr.js');
      const { VESSEL_LIGHTING } = await import('/js/wgsl/vessel.js');
      const { PI_WGSL } = await import('/js/wgsl/common.js').catch(() => ({ PI_WGSL: 'const PI: f32 = 3.141592653589793;\n' }));

      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();

      // 1) Bank with autoLoad: false -> zeroed latentBuffer (simulates frame 0 before fetch)
      const zeroBank = createNeuralPbrBank(device, { autoLoad: false, strength: 1.0 });

      // 2) Bank loaded from real `/assets/neural-pbr/neural-pbr-latents.bin.gz`
      const liveBank = createNeuralPbrBank(device, { autoLoad: true, strength: 1.0 });
      const loadedOk = await liveBank.ready;

      const probeWGSL = `
const PI: f32 = 3.141592653589793;
${VESSEL_LIGHTING}
${createNeuralPbrWGSL({ group: 0, latentBinding: 0, weightBinding: 1 })}

struct ProbeCfg {
  matId: u32,
  camDist: f32,
  uvSpan: f32,
  anisoTest: f32,
};
@group(0) @binding(2) var<uniform> cfg: ProbeCfg;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  let pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(pts[vid], 0.5, 1.0);
  o.uv = (pts[vid] * 0.5 + 0.5) * cfg.uvSpan;
  return o;
}

struct FSOut {
  @location(0) a: vec4f,
  @location(1) b: vec4f,
};

@fragment fn fs(in: VSOut) -> FSOut {
  let dx = dpdx(in.uv);
  let dy = dpdy(in.uv);
  let s = evalNeuralPbr(cfg.matId, in.uv, dx, dy, cfg.camDist, 1.0);
  let n = vec3f(0.0, 1.0, 0.0);
  let basis = neuralPbrTangentBasis(n, vec3f(1.0, 0.0, 0.0));
  let v = normalize(vec3f(0.35, 0.65, 0.45));
  let l = normalize(vec3f(-0.25, 0.72, -0.40));
  let isoRef = vesselSpecular(n, v, l, 0.35, vec3f(0.04));
  let anisoZero = neuralPbrAnisoSpecular(n, basis, v, l, 0.35, 0.0, vec3f(0.04));
  let anisoPos = neuralPbrAnisoSpecular(n, basis, v, l, 0.35, cfg.anisoTest, vec3f(0.04));
  return FSOut(
    vec4f(s.albedoMul, s.roughDelta),
    vec4f(s.normalTS, s.cavityAO, length(anisoZero - isoRef) + length(anisoPos - isoRef) * 1000.0)
  );
}
`;
      const mod = device.createShaderModule({ code: probeWGSL });
      const info = await mod.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error').map(m => m.message);
      if (errs.length) throw new Error(errs.join('\n'));

      const pipe = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: {
          module: mod,
          entryPoint: 'fs',
          targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
        },
      });

      const W = 32, H = 32;
      const texA = device.createTexture({ size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const texB = device.createTexture({ size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const cfgBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

      async function evalGrid(bank, matId, camDist, uvSpan, anisoTest = 0.7) {
        const ab = new ArrayBuffer(16);
        const dv = new DataView(ab);
        dv.setUint32(0, matId, true);
        dv.setFloat32(4, camDist, true);
        dv.setFloat32(8, uvSpan, true);
        dv.setFloat32(12, anisoTest, true);
        device.queue.writeBuffer(cfgBuf, 0, ab);

        const bg = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: bank.latentBuffer } },
            { binding: 1, resource: { buffer: bank.weightBuffer } },
            { binding: 2, resource: { buffer: cfgBuf } },
          ],
        });

        const bpr = W * 16; // 32 * 16 = 512 (256-byte aligned!)
        const readA = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const readB = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [
            { view: texA.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
            { view: texB.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          ],
        });
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
        enc.copyTextureToBuffer({ texture: texA }, { buffer: readA, bytesPerRow: bpr }, [W, H]);
        enc.copyTextureToBuffer({ texture: texB }, { buffer: readB, bytesPerRow: bpr }, [W, H]);
        device.queue.submit([enc.finish()]);

        await Promise.all([readA.mapAsync(GPUMapMode.READ), readB.mapAsync(GPUMapMode.READ)]);
        const fa = new Float32Array(readA.getMappedRange()).slice();
        const fb = new Float32Array(readB.getMappedRange()).slice();
        readA.unmap(); readB.unmap();
        readA.destroy(); readB.destroy();

        let maxIdErr = 0, albStd = 0, normEnergy = 0, roughSpan = 0, finiteOk = true;
        let minR = 99, maxR = -99, meanAlb = 0;
        const nPx = W * H;
        for (let i = 0; i < nPx; i++) {
          const ar = fa[i * 4], ag = fa[i * 4 + 1], ab2 = fa[i * 4 + 2], rd = fa[i * 4 + 3];
          const nx = fb[i * 4], ny = fb[i * 4 + 1], ao = fb[i * 4 + 2];
          if (![ar, ag, ab2, rd, nx, ny, ao].every(Number.isFinite)) finiteOk = false;
          maxIdErr = Math.max(
            maxIdErr,
            Math.abs(ar - 1), Math.abs(ag - 1), Math.abs(ab2 - 1),
            Math.abs(rd), Math.abs(nx), Math.abs(ny), Math.abs(ao - 1)
          );
          meanAlb += (ar + ag + ab2) / 3;
          normEnergy += Math.hypot(nx, ny);
          if (rd < minR) minR = rd;
          if (rd > maxR) maxR = rd;
        }
        meanAlb /= nPx;
        for (let i = 0; i < nPx; i++) {
          const l = (fa[i * 4] + fa[i * 4 + 1] + fa[i * 4 + 2]) / 3;
          albStd += (l - meanAlb) ** 2;
        }
        albStd = Math.sqrt(albStd / nPx);
        normEnergy /= nPx;
        roughSpan = maxR - minR;
        const specPack = fb[3];
        return { maxIdErr, albStd, normEnergy, roughSpan, finiteOk, specPack };
      }

      const zeroCheck = await evalGrid(zeroBank, 0, 1.5, 0.024);
      liveBank.setStrength(0.0);
      const strengthZeroCheck = await evalGrid(liveBank, 0, 1.5, 0.024);
      liveBank.setStrength(1.0);
      const farDistCheck = await evalGrid(liveBank, 0, 210.0, 0.024);
      const coarseMip6Check = await evalGrid(liveBank, 0, 10.0, 64.0); // huge UV footprint -> lod0 == 6

      const materialStats = [];
      for (let m = 0; m < 12; m++) {
        materialStats.push(await evalGrid(liveBank, m, 1.5, 0.024));
      }

      return {
        loadedOk,
        zeroCheck,
        strengthZeroCheck,
        farDistCheck,
        coarseMip6Check,
        materialStats,
      };
    });

    assert.equal(probe.loadedOk, true, 'Expected live NPBR bank to load & decompress over HTTP');
    assert.ok(probe.zeroCheck.maxIdErr < 1e-6, `Frame-0 zero latent buffer must be exact identity, got err ${probe.zeroCheck.maxIdErr}`);
    assert.ok(probe.strengthZeroCheck.maxIdErr < 1e-6, `strength=0 must be exact identity, got err ${probe.strengthZeroCheck.maxIdErr}`);
    assert.ok(probe.farDistCheck.maxIdErr < 1e-6, `camDist > maxDistM must fade cleanly to exact identity, got err ${probe.farDistCheck.maxIdErr}`);
    assert.ok(probe.coarseMip6Check.maxIdErr < 1e-6, `lod0 >= 6 must evaluate to exact identity, got err ${probe.coarseMip6Check.maxIdErr}`);

    // Verify Burley anisotropic GGX reduces to vesselSpecular at aniso=0 (low fractional part == 0)
    // and produces distinct fiber reflection when aniso=0.7 (scaled *1000 > 1.0)
    const specPack = probe.materialStats[0].specPack;
    assert.ok(specPack > 5.0, `Expected strong anisotropic vs isotropic highlight delta, got ${specPack}`);

    for (let m = 0; m < 12; m++) {
      const s = probe.materialStats[m];
      const slug = NEURAL_PBR_MATERIALS[m].slug;
      assert.equal(s.finiteOk, true, `Material ${m} (${slug}) produced non-finite output`);
      assert.ok(s.albStd > 0.015, `Material ${m} (${slug}) micro-albedo std too weak: ${s.albStd}`);
      assert.ok(s.normEnergy > 0.035, `Material ${m} (${slug}) micro-normal relief too weak: ${s.normEnergy}`);
      assert.ok(s.roughSpan > 0.035, `Material ${m} (${slug}) specular micro-roughness span too weak: ${s.roughSpan}`);
    }
  } finally {
    await page.close();
  }
});
