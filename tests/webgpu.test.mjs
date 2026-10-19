import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const port = process.env.TEST_PORT || 8082;
const origin = `http://localhost:${port}`;
let server, browser;

before(async () => {
  server = spawn(process.execPath, ['server.mjs', port], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => { throw new Error(`Test server exited: ${code}`); }),
  ]);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test('fused FFT reproduces analytical travelling waves in every cascade', { timeout: 120000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__test`);
    const result = await page.evaluate(async () => {
      const { N, CASCADES } = await import('/js/wgsl/common.js');
      const { FFT_ROWS, FFT_COLS } = await import('/js/wgsl/sim.js');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter; enable software WebGPU or use a supported Chromium.');
      const device = await adapter.requestDevice();
      const errors = [];
      device.onuncapturederror = e => errors.push(e.error.message);
      const pipes = await Promise.all([FFT_ROWS, FFT_COLS].map(code => device.createComputePipelineAsync({
        layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      })));
      const buffer = (size, usage) => device.createBuffer({ size, usage });
      const bytes = N * N * CASCADES * 16;
      const ubo = buffer(224, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const h0 = buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const rows = [0, 1].map(() => buffer(bytes, GPUBufferUsage.STORAGE));
      const textures = [0, 1, 2].map(() => device.createTexture({
        size: [N, N, CASCADES], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      }));
      const bind = (pipe, resources) => device.createBindGroup({
        layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })),
      });
      const groups = [
        bind(pipes[0], [ubo, h0, ...rows].map(buffer => ({ buffer }))),
        bind(pipes[1], [...rows.map(buffer => ({ buffer })), ...textures.map(t => t.createView({ dimension: '2d-array' }))]),
      ];
      const sim = new Float32Array(56);
      sim.set([1103, 211.3, 39.7, 7.43, 1.393, 0.2617]);
      sim[50] = 600;
      const modes = [[3, 5], [-7, 2], [0, 11], [13, 0], [63, -41], [-127, 113]];
      const waves = modes.map(([x, y], c) => {
        const kx = 2 * Math.PI * x / sim[c], kz = 2 * Math.PI * y / sim[c];
        const k = Math.hypot(kx, kz), amplitude = Math.min(0.5, 0.05 / k);
        const w0 = 2 * Math.PI / sim[50];
        const omega = Math.floor(Math.sqrt(9.81 * k + 7.4e-5 * k ** 3) / w0) * w0;
        return { x, y, kx, kz, k, amplitude, omega };
      });
      const initial = new Float32Array(bytes / 4);
      for (let c = 0; c < CASCADES; c++) {
        const { x, y, amplitude } = waves[c];
        const index = (x, y) => ((c * N + (y + N) % N) * N + (x + N) % N) * 4;
        initial[index(x, y)] = amplitude / 2;
        initial[index(-x, -y) + 2] = amplitude / 2;
        initial[index(0, 0)] = 10; // The zero-frequency term must be suppressed.
      }
      device.queue.writeBuffer(h0, 0, initial);
      const points = [[0, 0], [1, 17], [31, 99], [128, 128], [197, 23], [255, 255]];
      const sampleCount = CASCADES * points.length * textures.length;
      const read = buffer(sampleCount * 256, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      function half(bits) {
        const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
        return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24);
      }
      let maxError = 0, checked = 0;
      for (const [time, choppy] of [[0, 1.25], [1.25, 0], [3.25, 1.25]]) {
        sim[48] = choppy; sim[52] = time;
        device.queue.writeBuffer(ubo, 0, sim);
        const enc = device.createCommandEncoder(), cp = enc.beginComputePass();
        for (let i = 0; i < pipes.length; i++) {
          cp.setPipeline(pipes[i]); cp.setBindGroup(0, groups[i]); cp.dispatchWorkgroups(N, 1, CASCADES);
        }
        cp.end();
        let sample = 0;
        for (let c = 0; c < CASCADES; c++) for (const [x, y] of points) for (const texture of textures) {
          enc.copyTextureToBuffer({ texture, origin: [x, y, c] }, { buffer: read, offset: sample++ * 256, bytesPerRow: 256 }, [1, 1, 1]);
        }
        device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = new Uint16Array(read.getMappedRange());
        sample = 0;
        for (let c = 0; c < CASCADES; c++) for (const [x, y] of points) {
          const w = waves[c], phase = 2 * Math.PI * (w.x * x + w.y * y) / N - w.omega * time;
          const height = w.amplitude * Math.cos(phase), slope = -w.amplitude * Math.sin(phase);
          const sx = slope * w.kx, sz = slope * w.kz, jacobian = -choppy * height / w.k;
          const expected = [
            [choppy * sx / w.k, height, choppy * sz / w.k, jacobian * w.kx * w.kz],
            [sx, sz, jacobian * w.kx ** 2, jacobian * w.kz ** 2],
            [sx * sx, sz * sz, sx * sz, jacobian * w.kx * w.kz],
          ];
          for (const vector of expected) {
            for (let j = 0; j < 4; j++) {
              const value = half(values[sample * 128 + j]);
              if (!Number.isFinite(value)) throw new Error('Non-finite FFT output');
              maxError = Math.max(maxError, Math.abs(value - vector[j])); checked++;
            }
            sample++;
          }
        }
        read.unmap();
      }
      device.destroy();
      return { maxError, checked, errors };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.checked, 1296);
    assert.ok(result.maxError < 0.0005, `FFT absolute error: ${result.maxError}`);
  } finally { await page.close(); }
});

// Keep scheduling deterministic and render to an ordinary GPU texture. Some headless
// SwiftShader builds support WebGPU but cannot present a WebGPU canvas swap chain.
function instrumentRenderer() {
  window.check = { callback: null, compute: {}, render: {}, errors: [], target: null, buffers: {} };
  window.requestAnimationFrame = callback => { check.callback = callback; return 1; };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    check.device = device;
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = desc => {
      const buffer = createBuffer(desc);
      if (desc.label === 'crest spray plumes') check.buffers.crest = buffer;
      return buffer;
    };
    device.addEventListener('uncapturederror', e => check.errors.push(e.error.message));
    return device;
  };
  const configs = new WeakMap(), configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function (desc) { configs.set(this, desc); return configure.call(this, desc); };
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const desc = configs.get(this), { width, height } = this.canvas;
    if (!check.target || check.target.width !== width || check.target.height !== height) {
      check.target?.destroy();
      check.target = desc.device.createTexture({ size: [width, height], format: desc.format, usage: desc.usage });
    }
    return check.target;
  };
  const labels = new WeakMap(), setCompute = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function (pipe) { labels.set(this, pipe.label); return setCompute.call(this, pipe); };
  const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function (x, y = 1, z = 1) {
    (check.compute[labels.get(this)] ||= []).push([x, y, z]);
    return dispatch.call(this, x, y, z);
  };
  const setRender = GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline = function (pipe) {
    check.render[pipe.label] = (check.render[pipe.label] || 0) + 1;
    return setRender.call(this, pipe);
  };
}

async function step(page,extraMs=0) {
  const result = await page.evaluate(async extraMs => {
    const callback = check.callback;
    check.callback = null; check.compute = {}; check.render = {};
    callback(performance.now()+extraMs);
    await check.device.queue.onSubmittedWorkDone();
    return { compute: check.compute, render: check.render, errors: check.errors };
  },extraMs);
  assert.deepEqual(result.errors, []);
  return result;
}

async function slider(page, label, value) {
  await page.locator('label').filter({ hasText: label }).locator('input').evaluate((input, value) => {
    input.value = value; input.dispatchEvent(new Event('input'));
  }, String(value));
}

test('indexed ship and direct HDR resolve match the original pixels, including profiled rendering', {timeout:180000}, async()=>{
  // Start on a sampled frame so the comparison also exercises timestamp writes.
  const source=(await readFile(new URL('../js/main.js',import.meta.url),'utf8')).replace('let frameIndex = 0;','let frameIndex = 7;');
  // Recreate the previous unindexed/copy schedule only inside this comparison.
  const legacy=source
    .replace('indexCaravelMesh(createCaravelMesh())','((vertices)=>({vertices,indices:Uint32Array.from({length:vertices.length/9},(_,i)=>i)}))(createCaravelMesh())')
    .replace("prowPass.setIndexBuffer(caravelIndexBuffer,'uint32'); prowPass.drawIndexed(caravelIndices.length);",'prowPass.draw(caravelMesh.length/9);')
    .replace('drawProw?waterView:hdrView','hdrView')
    .replace('format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });','format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_SRC });')
    .replace('usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.STORAGE_BINDING });','usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_DST });')
    .replace("const filterPass = enc.beginComputePass",'enc.copyTextureToTexture({texture:hdrTex},{texture:waterCopy},[W,H]);\n      const filterPass = enc.beginComputePass');
  const captures=[];
  for(const mode of ['legacy','optimized','profiled']){
    const page=await browser.newPage({viewport:{width:96,height:72}});
    try{
      const initErrors=[];
      page.on('pageerror',e=>initErrors.push(e.message));
      page.on('console',msg=>{if(msg.text().includes('init failed'))initErrors.push(msg.text());});
      await page.addInitScript(instrumentRenderer);
      await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:mode==='legacy'?legacy:source}));
      await page.goto(`${origin}/?view=ship&sunElev=35&sunAzim=30&clouds=0&shot=compare.png&frames=100000${mode==='profiled'?'&profile=1':''}`);
      try{await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:30000});}
      catch(e){throw new Error(`${mode} initialization: ${initErrors.join('\n')||e.message}`);}
      const frame=await step(page,1000);
      assert.ok(parseFloat(await page.locator('#fps').textContent())<2,'FPS must reflect a one-second frame, not the 100 ms simulation clamp');
      assert.equal(frame.render.caravel,1);
      const pixels=await page.evaluate(async()=>{
        const texture=check.target,bytesPerRow=Math.ceil(texture.width*4/256)*256;
        const buffer=check.device.createBuffer({size:bytesPerRow*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const enc=check.device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow},[texture.width,texture.height]);
        check.device.queue.submit([enc.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const result=Array.from(new Uint8Array(buffer.getMappedRange()));buffer.unmap();buffer.destroy();return result;
      });
      assert.ok(new Set(pixels).size>20,'render must contain actual shaded pixels');
      captures.push(pixels);
    }finally{await page.close();}
  }
  assert.deepEqual(captures[1],captures[0],'indexed/direct resolve pixels');
  assert.deepEqual(captures[2],captures[0],'profiling must preserve pixels');
});

test('early hull exclusion preserves water edges and the complete ship image', {timeout:180000}, async()=>{
  const ocean=await readFile(new URL('../js/wgsl/ocean.js',import.meta.url),'utf8');
  const block=ocean.match(/  \/\/ BEGIN HULL EARLY EXIT[\s\S]*?  \/\/ END HULL EARLY EXIT/)[0];
  const late=process.env.OCEAN_BASELINE?await readFile(process.env.OCEAN_BASELINE,'utf8'):
    ocean.replace(block,'').replace('  return vec4f(col, 1.0);',block.replace('${OCEAN_HULL_MASK}',"${OCEAN_HULL_MASK.replace('discard; return vec4f(0);','discard;')}")+'\n  return vec4f(col, 1.0);');
  const main=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
  for(const view of ['boat','ship']){
    const captures=[];
    for(const shader of [late,ocean]){
      const page=await browser.newPage({viewport:{width:96,height:72}});
      try{
        await page.addInitScript(instrumentRenderer);
        await page.route('**/js/wgsl/ocean.js',route=>route.fulfill({contentType:'text/javascript',
          body:shader.includes('export const OCEAN_VISIBLE')?shader:shader+'\nexport const OCEAN_VISIBLE=OCEAN;'}));
        // Expose the water cutout in the helm view, so the hull cannot hide a
        // masking regression. The exterior view retains all visible geometry.
        if(view==='boat')await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:main.replace('prowPass.drawIndexed(caravelIndices.length);','/* expose ocean cutout */')}));
        await page.goto(`${origin}/?view=${view}&sunElev=35&sunAzim=30&clouds=0&oceanDepth=0&shot=mask.png&frames=100000`);
        await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:30000});
        await step(page);
        captures.push(await page.evaluate(async()=>{
          const texture=check.target,row=Math.ceil(texture.width*4/256)*256;
          const buffer=check.device.createBuffer({size:row*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          const enc=check.device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[texture.width,texture.height]);
          check.device.queue.submit([enc.finish()]);await buffer.mapAsync(GPUMapMode.READ);
          const pixels=Array.from(new Uint8Array(buffer.getMappedRange()));buffer.unmap();buffer.destroy();return pixels;
        }));
      }finally{await page.close();}
    }
    assert.ok(new Set(captures[0]).size>20);
    assert.deepEqual(captures[1],captures[0],`${view}: moving the mask must preserve every pixel`);
  }
});

test('packed wave samples preserve sunset and rough-sea pixels', {timeout:180000}, async()=>{
  const ocean=await readFile(new URL('../js/wgsl/ocean.js',import.meta.url),'utf8');
  // Restore the old displacement read. Its alpha remains independently stored
  // and mip-filtered, so this checks the complete FFT -> filtering -> shading path.
  const legacy=ocean.replace('jxz += moments.w * gk;',
    'jxz += textureSample(dispTex, sampR, uv, c).w * gk;');
  assert.notEqual(legacy,ocean);
  for(const scene of ['view=boat','view=ship&windSpeed=18&swellHs=5&sunElev=35&sunAzim=30']){
    const captures=[];
    for(const shader of [legacy,ocean]){
      const page=await browser.newPage({viewport:{width:128,height:96}});
      try{
        await page.addInitScript(instrumentRenderer);
        await page.route('**/js/wgsl/ocean.js',route=>route.fulfill({contentType:'text/javascript',body:shader}));
        await page.goto(`${origin}/?${scene}&shot=packed.png&frames=100000`);
        await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:30000});
        await step(page);
        captures.push(await page.evaluate(async()=>{
          const texture=check.target,row=Math.ceil(texture.width*4/256)*256;
          const buffer=check.device.createBuffer({size:row*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          const enc=check.device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[texture.width,texture.height]);
          check.device.queue.submit([enc.finish()]);await buffer.mapAsync(GPUMapMode.READ);
          const pixels=Array.from(new Uint8Array(buffer.getMappedRange()));buffer.unmap();buffer.destroy();return pixels;
        }));
      }finally{await page.close();}
    }
    assert.ok(new Set(captures[0]).size>20);
    assert.deepEqual(captures[1],captures[0],`${scene}: packed wave samples must preserve every pixel`);
  }
});

test('ocean visibility stage preserves coverage and bounds shading error', {timeout:360000}, async()=>{
  const main=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
  const ocean=await readFile(new URL('../js/wgsl/ocean.js',import.meta.url),'utf8');
  const differences=[];
  for(const scene of ['view=boat','view=ship&windSpeed=18&swellHs=5&sunElev=35',
    'view=free&prow=0&cam=0,2.4,0,30,-5.5','view=boat&dbg=1','view=boat&effects=0&bloom=0']
    .filter(scene=>!process.env.OCEAN_COVERAGE_ONLY||scene.includes('bloom=0'))){
    const coverage=scene.includes('bloom=0');
    const captures=[];
    for(const mode of [0,1]){
      const page=await browser.newPage({viewport:{width:192,height:128}});
      try{
        await page.addInitScript(instrumentRenderer);
        // Expose the water cutout so the deck cannot conceal a mask regression.
        if(scene==='view=boat'||coverage)await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',
          body:main.replace('prowPass.drawIndexed(caravelIndices.length);','/* expose water edges */')}));
        // White water and black sky isolate sample coverage from floating-point
        // shading/compiler differences. The zero uniform keeps bindings active.
        if(coverage)await page.route('**/js/wgsl/ocean.js',route=>route.fulfill({contentType:'text/javascript',body:ocean
          .replace('return vec4f(col, 1.0);','return mix(vec4f(1.0),vec4f(col,1.0),F.reserved.x);')
          .replace('return vec4f(L, 1.0);','return mix(vec4f(0,0,0,1),vec4f(L,1.0),F.reserved.x);')}));
        await page.goto(`${origin}/?${scene}&oceanDepth=${mode}&shot=depth.png&frames=100000`);
        await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:30000});
        const frame=await step(page);
        assert.equal(frame.render['ocean visibility']||0,mode);
        captures.push(await page.evaluate(async()=>{
          const texture=check.target,row=Math.ceil(texture.width*4/256)*256;
          const buffer=check.device.createBuffer({size:row*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          const enc=check.device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[texture.width,texture.height]);
          check.device.queue.submit([enc.finish()]);await buffer.mapAsync(GPUMapMode.READ);
          const pixels=Array.from(new Uint8Array(buffer.getMappedRange()));buffer.unmap();buffer.destroy();return pixels;
        }));
      }finally{await page.close();}
    }
    assert.ok(new Set(captures[0]).size>(coverage?1:20));
    if(coverage){assert.deepEqual(captures[1],captures[0],'depth visibility must preserve exact MSAA water/hull/sky coverage');continue;}
    const delta=captures[1].map((v,i)=>Math.abs(v-captures[0][i])).filter((_,i)=>i%4!==3);
    const difference={scene,max:Math.max(...delta),mean:delta.reduce((a,b)=>a+b,0)/delta.length,
      rms:Math.sqrt(delta.reduce((a,b)=>a+b*b,0)/delta.length),aboveTwo:delta.filter(d=>d>2).length/delta.length};
    console.log('visibility comparison',difference);
    differences.push(difference);
  }
  // Different shader control flow changes rounding and helper-lane derivatives
  // around occlusion edges. Require sub-quarter-level RMS (over 60 dB PSNR),
  // sparse outliers, and no material single-channel deviation on a 0..255 scale.
  assert.ok(differences.every(d=>d.mean<0.01&&d.rms<0.25&&d.aboveTwo<0.001&&d.max<=32),JSON.stringify(differences));
});

test('GPU timing handles unsupported devices, query readback, and skipped passes', {timeout:30000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__timing_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__timing_test`);
    const result=await page.evaluate(async()=>{
      const {createGPUProfiler}=await import('/js/profiler.js');
      const unsupported=createGPUProfiler({features:new Set()},true);
      unsupported.beginFrame(8);
      const fallback={...unsupported.snapshot(),writes:unsupported.writes('Composite')===undefined,resolve:unsupported.resolve(null)};
      unsupported.destroy();
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter.features.has('timestamp-query'))return {fallback,supported:false};
      const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const detailed=createGPUProfiler(device,true),normal=createGPUProfiler(device);
      async function run(profiler,frame,optional){
        profiler.beginFrame(frame);const enc=device.createCommandEncoder();
        for(const name of ['Waves + effects',...(optional?['Sky + clouds']:[]),'Composite'])enc.beginComputePass({timestampWrites:profiler.writes(name)}).end();
        const resolved=profiler.resolve(enc);device.queue.submit([enc.finish()]);if(resolved)await profiler.read();
        return profiler.snapshot();
      }
      const enabled=await run(detailed,120,true),skipped=await run(detailed,128,false),total=await run(normal,8,true);
      detailed.destroy();normal.destroy();device.destroy();return {fallback,supported:true,enabled,skipped,total,errors};
    });
    assert.equal(result.fallback.supported,false);assert.equal(result.fallback.detailed,false);
    assert.equal(result.fallback.writes,true);assert.equal(result.fallback.resolve,false);
    if(result.supported){
      assert.deepEqual(result.errors,[]);
      assert.equal(result.enabled.sampleCount,1);assert.equal(result.skipped.sampleCount,2);
      assert.equal(result.skipped.latest['Sky + clouds'],0);
      assert.equal(result.total.sampleCount,1);assert.ok(Number.isFinite(result.total.totalMs));
      assert.equal(result.enabled.error,'');assert.equal(result.skipped.error,'');
    }
  }finally{await page.close();}
});

test('surge probe averages incident slopes across cascades and filters unresolved chop', { timeout: 60000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__surge_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__surge_test`);
    const result = await page.evaluate(async () => {
      const { HEIGHT_PROBE } = await import('/js/wgsl/ocean.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
      const errors = []; device.onuncapturederror = e => errors.push(e.error.message);
      const B = GPUBufferUsage, T = GPUTextureUsage;
      const buffer = (size, usage) => device.createBuffer({size, usage});
      const frame = buffer(384, B.UNIFORM | B.COPY_DST), boat = buffer(32, B.UNIFORM | B.COPY_DST);
      const interaction = buffer(64, B.UNIFORM | B.COPY_DST), output = buffer(64, B.STORAGE | B.COPY_SRC);
      const read = buffer(64, B.MAP_READ | B.COPY_DST);
      const sea = device.createTexture({size:[8,8,6],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const slopes = device.createTexture({size:[8,8,6],mipLevelCount:4,format:'rgba16float',usage:T.TEXTURE_BINDING | T.COPY_DST});
      const wake = device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler = device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const f = new Float32Array(96); f.fill(1 / 8, 56, 62); device.queue.writeBuffer(frame,0,f);
      const b = new Float32Array([0,12,3.6,0,0,0,0,0]); device.queue.writeBuffer(boat,0,b);
      const i = new Float32Array(16); i[2]=128; device.queue.writeBuffer(interaction,0,i);
      const module = device.createShaderModule({code:HEIGHT_PROBE});
      const compilation = await module.getCompilationInfo();
      for (const m of compilation.messages) if (m.type === 'error') errors.push(m.message);
      const pipe = await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const group = device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[
        {buffer:frame}, sea.createView({dimension:'2d-array'}), sampler, {buffer:output}, {buffer:boat},
        {buffer:interaction}, wake.createView(), sampler, slopes.createView({dimension:'2d-array'}),
      ].map((resource,binding)=>({binding,resource}))});
      const fill = shortChop => {
        for(let mip=0;mip<4;mip++) for(let c=0;c<6;c++) {
          const size=8>>mip, data=new Uint16Array(size*size*4);
          for(let p=0;p<size*size;p++) {
            if (!shortChop) { data[p*4]=0x2400+c*0x400; data[p*4+1]=0xa000+c*0x400; }
            // A texel-alternating slope cancels completely in the coarser mips.
            else if(mip===0) data[p*4]=(p%2 ? 0xbc00 : 0x3c00);
          }
          device.queue.writeTexture({texture:slopes,mipLevel:mip,origin:[0,0,c]},data,{bytesPerRow:size*8},[size,size]);
        }
      };
      const sample = async heading => {
        b[0]=heading; device.queue.writeBuffer(boat,0,b);
        const enc=device.createCommandEncoder(), cp=enc.beginComputePass();
        cp.setPipeline(pipe);cp.setBindGroup(0,group);cp.dispatchWorkgroups(1);cp.end();
        enc.copyBufferToBuffer(output,0,read,0,64);device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const result=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return result;
      };
      fill(false); const forward=await sample(0), turned=await sample(Math.PI/2);
      fill(true); const chop=await sample(0);
      device.destroy();return {forward,turned,chop,errors};
    });
    assert.deepEqual(result.errors,[]);
    for(const sample of [result.forward,result.turned]) {
      assert.ok(Math.abs(sample[10]-0.984375)<1e-6);
      assert.ok(Math.abs(sample[11]+0.4921875)<1e-6);
      assert.ok(sample.slice(0,10).every(v=>v===0), 'pressure slopes do not alter buoyancy heights');
    }
    assert.equal(result.chop[10],0);
    assert.equal(result.chop[11],0);
  } finally { await page.close(); }
});

test('bow contacts, persistent wake, impact spray, landing foam, and resets agree on the GPU', { timeout: 180000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__interaction_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__interaction_test`);
    const result = await page.evaluate(async () => {
      const { createWaterInteraction } = await import('/js/interaction.js');
      const { WAKE_SIZE, SPRAY_COUNT, SHEET_COUNT } = await import('/js/wgsl/interaction.js');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const errors = []; device.onuncapturederror = e => errors.push(e.error.message);
      const B = GPUBufferUsage, T = GPUTextureUsage;
      const frame = device.createBuffer({ size: 384, usage: B.UNIFORM | B.COPY_DST });
      const hull = device.createBuffer({ size: 96, usage: B.UNIFORM | B.COPY_DST });
      const f = new Float32Array(96); f.fill(1, 48, 54); device.queue.writeBuffer(frame, 0, f);
      const h = new Float32Array(24); h[0] = h[5] = 1; h[10] = -1; h[12] = 3.6; h[13] = 12; h[22] = 1;
      const sea = device.createTexture({ size: [1, 1, 6], format: 'rgba16float', usage: T.TEXTURE_BINDING | T.COPY_DST });
      const env = device.createTexture({ size: [32, 32, 6], mipLevelCount: 6, format: 'rgba16float', usage: T.TEXTURE_BINDING });
      const trans = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: T.TEXTURE_BINDING });
      const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
      const shader = async (code, label) => {
        const module = device.createShaderModule({ code, label });
        const info = await module.getCompilationInfo();
        const bad = info.messages.filter(m => m.type === 'error');
        if (bad.length) throw new Error(label + ': ' + bad.map(m => m.message).join('\n'));
        return module;
      };
      const computePipe = async (code, label) => device.createComputePipelineAsync({ label, layout: 'auto', compute: { module: await shader(code, label), entryPoint: 'main' } });
      const fx = await createWaterInteraction({ device, frameUBO: frame, hullUBO: hull, seaView: sea.createView({ dimension: '2d-array' }), seaSampler: sampler, envView: env.createView({ dimension: 'cube' }), transView: trans.createView(), shader, computePipe });
      const boat = { showProw: true, effects: true, length: 12, beam: 3.6, x: 0, z: 0, speed: 12, surgeVelocity: 0, revision: 0 };
      let tick = 0, interactionTime = 0;
      async function advance(count, dt = 1 / 60, move = () => {}) {
        for (let i = 0; i < count; i++) {
          move(i);
          h[16] = boat.x; h[18] = boat.z;
          device.queue.writeBuffer(hull, 0, h);
          fx.update(boat, dt, interactionTime += dt, ++tick, 0, 0);
          const enc = device.createCommandEncoder(), cp = enc.beginComputePass(); fx.encode(cp); cp.end();
          device.queue.submit([enc.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
      }
      async function read(buffer, size) {
        const staging = device.createBuffer({ size, usage: B.COPY_DST | B.MAP_READ });
        const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(buffer, 0, staging, 0, size); device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap(); staging.destroy(); return out;
      }
      function half(n) {
        const e = (n >> 10) & 31, f = n & 1023;
        return (n & 32768 ? -1 : 1) * (e === 31 ? Infinity : e ? (1 + f / 1024) * 2 ** (e - 15) : f * 2 ** -24);
      }
      async function wake() {
        const size = WAKE_SIZE * WAKE_SIZE * 8;
        const staging = device.createBuffer({ size, usage: B.COPY_DST | B.MAP_READ });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: fx.textures[fx.current] }, { buffer: staging, bytesPerRow: WAKE_SIZE * 8 }, [WAKE_SIZE, WAKE_SIZE]);
        device.queue.submit([enc.finish()]); await staging.mapAsync(GPUMapMode.READ);
        const values = Float32Array.from(new Uint16Array(staging.getMappedRange()), half); staging.unmap(); staging.destroy(); return values;
      }
      const live = values => values.filter((v, i) => i % 12 === 3 && v > 0).length;
      await advance(2);
      const resting = { contacts: Array.from(await read(fx.contacts, 32 * 64)), live: live(await read(fx.drops, SPRAY_COUNT * 48)), wake: (await wake()).reduce((a, b) => Math.max(a, b), 0) };
      boat.speed = 0; boat.surgeVelocity = 12 * 0.514444;
      await advance(90);
      const movingContacts = await read(fx.contacts, 32 * 64), movingWake = await wake();
      let maxHeight = 0, foam = 0, finite = true;
      for (let i = 0; i < movingWake.length; i += 4) { maxHeight = Math.max(maxHeight, Math.abs(movingWake[i])); foam += movingWake[i + 2]; finite &&= Number.isFinite(movingWake[i]) && Number.isFinite(movingWake[i + 1]); }
      const moving = { live: live(await read(fx.drops, SPRAY_COUNT * 48)), sheets: (await read(fx.sheets,SHEET_COUNT*64)).filter((v,i)=>i%16===7 && v>0).length, maxHeight, foam };
      // Buoyancy and rendering sample this same field: probe its strongest texel centre.
      let peak = 0;
      for (let i = 0; i < movingWake.length; i += 4) if (movingWake[i] > movingWake[peak]) peak = i;
      const cell = peak / 4;
      f[16] = (cell % WAKE_SIZE + 0.5 - 128) * 0.5;
      f[18] = (Math.floor(cell / WAKE_SIZE) + 0.5 - 128) * 0.5;
      device.queue.writeBuffer(frame, 0, f);
      const { HEIGHT_PROBE } = await import('/js/wgsl/ocean.js');
      const probe = await computePipe(HEIGHT_PROBE, 'wake buoyancy fixture');
      const probeBoat = device.createBuffer({ size: 32, usage: B.UNIFORM });
      const probeOut = device.createBuffer({ size: 64, usage: B.STORAGE | B.COPY_SRC });
      const probeEnc = device.createCommandEncoder(), probePass = probeEnc.beginComputePass();
      probePass.setPipeline(probe);
      probePass.setBindGroup(0, device.createBindGroup({ layout: probe.getBindGroupLayout(0), entries: [
        { buffer: frame }, sea.createView({ dimension: '2d-array' }), sampler, { buffer: probeOut }, { buffer: probeBoat }, { buffer: fx.uniform }, fx.views[fx.current], fx.sampler, sea.createView({ dimension: '2d-array' }),
      ].map((resource, binding) => ({ binding, resource })) }));
      probePass.dispatchWorkgroups(1); probePass.end(); device.queue.submit([probeEnc.finish()]);
      const probeValues = await read(probeOut, 64);
      const probeError = Math.abs(probeValues[9] - movingWake[peak]);
      const selfPropulsion = Math.hypot(probeValues[10], probeValues[11]);
      // Recentring the grid retains the disturbance in world space.
      boat.x = 10;
      await advance(1);
      const shifted = await wake();
      let retained = 0;
      for (let y = 3; y < WAKE_SIZE - 3; y++) for (let x = 24; x < WAKE_SIZE - 3; x++) {
        const previous = movingWake[(y * WAKE_SIZE + x) * 4 + 2];
        if (previous > 0.02 && shifted[(y * WAKE_SIZE + x - 20) * 4 + 2] > previous * 0.8) retained++;
      }
      // Large dt and speed must remain bounded and finite, including sharp turns/changes.
      boat.speed = 40; boat.surgeVelocity = 40 * 0.514444;
      await advance(24, 0.1);
      for (const n of await wake()) finite &&= Number.isFinite(n);
      boat.effects = false; await advance(1);
      const disabled = { live: live(await read(fx.drops, SPRAY_COUNT * 48)), wake: (await wake()).some(n => n !== 0) };
      boat.effects = true; boat.speed = 0; boat.surgeVelocity = 0; boat.x = 0; boat.revision++; h[17] = 5;
      await advance(5);
      const dry = Array.from(await read(fx.contacts, 32 * 64));
      h[17] = 0; boat.revision++; await advance(2);
      // A stationary bow still throws spray as a crest rises into it. 0x3000 = 0.125 m.
      device.queue.writeTexture({ texture: sea }, new Uint16Array([0, 0x3000, 0, 0]), { bytesPerRow: 8 }, [1, 1, 1]);
      await advance(1);
      const impact = Array.from(await read(fx.contacts, 32 * 64));
      const launched=(await read(fx.sheets,SHEET_COUNT*64)).filter((v,i)=>i%16===7 && v>0).length;
      const impactWake=await wake();
      await advance(60);
      const propagatedWake=await wake();
      let outgoing=0;
      for(let cell=0;cell<WAKE_SIZE*WAKE_SIZE;cell++){
        const x=(cell%WAKE_SIZE+.5-128)*.5,z=(Math.floor(cell/WAKE_SIZE)+.5-128)*.5;
        let distance=Infinity;
        for(let c=0;c<32;c++)distance=Math.min(distance,Math.hypot(x-impact[c*16],z-impact[c*16+2]));
        if(distance>2.5)outgoing=Math.max(outgoing,Math.abs(propagatedWake[cell*4])-Math.abs(impactWake[cell*4]));
      }
      await advance(90);
      const settled={sheets:(await read(fx.sheets,SHEET_COUNT*64)).filter((v,i)=>i%16===7 && v>0).length,
        particles:live(await read(fx.drops,SPRAY_COUNT*48)),contacts:Array.from(await read(fx.contacts,32*64))};
      // A second distinct rise must launch another event, after the first sheet has vanished.
      device.queue.writeTexture({texture:sea},new Uint16Array([0,0x3400,0,0]),{bytesPerRow:8},[1,1,1]);
      await advance(1);
      const second=Array.from(await read(fx.contacts,32*64));
      device.queue.writeTexture({texture:sea},new Uint16Array([0,0x3000,0,0]),{bytesPerRow:8},[1,1,1]);
      // Deposit one known descending droplet into a quiet cell, without CPU production hooks.
      boat.effects = false; await advance(1); boat.effects = true; boat.revision++; await advance(2);
      const inject = await computePipe(`struct D { p:vec4f, v:vec4f, s:vec4f }; @group(0) @binding(0) var<storage,read_write> d:array<D>; @compute @workgroup_size(1) fn main(){ d[0].p=vec4f(20,0.14,20,1); d[0].v=vec4f(0,-3,0,1); d[0].s=vec4f(0.03,0,0,1); }`, 'landing fixture');
      const enc = device.createCommandEncoder(), cp = enc.beginComputePass(); cp.setPipeline(inject);
      cp.setBindGroup(0, device.createBindGroup({ layout: inject.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: fx.drops } }] })); cp.dispatchWorkgroups(1); cp.end(); device.queue.submit([enc.finish()]);
      await advance(1);
      const landing = (await wake())[((128 + 40) * WAKE_SIZE + 128 + 40) * 4 + 2];
      const landedLive = (await read(fx.drops, 48))[3];
      // Roll, pitch, and heading must move the emitter with the hull/water intersection.
      const { boatRotate } = await import('/js/boat.js');
      const { hullHalfWidth, HULL_VERTICAL_SCALE } = await import('/js/hull.js');
      boat.length=h[13]=20;boat.beam=h[12]=6;
      boatRotate(h.subarray(0, 3), 1, 0, 0, 0.7, 0.08, 0.25);
      boatRotate(h.subarray(4, 7), 0, 1, 0, 0.7, 0.08, 0.25);
      boatRotate(h.subarray(8, 11), 0, 0, -1, 0.7, 0.08, 0.25);
      boat.revision++; await advance(2);
      const tilted = await read(fx.contacts, 32 * 64);
      let contactError = 0;
      for (let i = 0; i < 32; i++) {
        const p = tilted.subarray(i * 16, i * 16 + 3);
        const dot = offset => p.reduce((sum, v, j) => sum + v * h[offset + j], 0);
        const x = dot(0), y = dot(4)/HULL_VERTICAL_SCALE, z = -dot(8)*12/boat.length;
        const expectedWidth = hullHalfWidth(z,y)*boat.beam/3.6;
        contactError = Math.max(contactError, Math.abs(Math.abs(x) - expectedWidth), Math.abs(p[1] - 0.125));
      }
      // A stern lifted clear of the sea must not inherit wetness from the bow.
      boatRotate(h.subarray(0,3),1,0,0,0,-0.4,0);
      boatRotate(h.subarray(4,7),0,1,0,0,-0.4,0);
      boatRotate(h.subarray(8,11),0,0,-1,0,-0.4,0);
      boat.revision++;await advance(2);
      const aftContacts=await read(fx.contacts,40*64);
      const liftedStern={bow:aftContacts[11],stern:(aftContacts[35*16+11]+aftContacts[39*16+11])*0.5};
      // Emit along a real travelled path, then turn and stop. Read old foam at
      // fixed world coordinates, independently of the vessel's new orientation.
      h.fill(0,0,12);h[0]=h[5]=1;h[10]=-1;h[17]=0;
      boat.x=boat.z=0;boat.surgeVelocity=3.1;boat.revision++;
      device.queue.writeTexture({texture:sea},new Uint16Array(4),{bytesPerRow:8},[1,1,1]);
      await advance(2);
      await advance(180,1/30,()=>{boat.z-=3.1/30;});
      const trail=await wake(),trailX=0,trailZ=boat.z+5.25+8;
      const foamAt=(field,x,z)=>{
        const qx=Math.round((x-Math.round(boat.x*2)*0.5)*2+127.5),qz=Math.round((z-Math.round(boat.z*2)*0.5)*2+127.5);
        return field[(qz*WAKE_SIZE+qx)*4+2];
      };
      const trailFoam=foamAt(trail,trailX,trailZ);
      await advance(150,1/30,i=>{
        const heading=(i+1)/150;
        boatRotate(h.subarray(0,3),1,0,0,heading,0,0);
        boatRotate(h.subarray(8,11),0,0,-1,heading,0,0);
        boat.x+=Math.sin(heading)*3.1/30;boat.z-=Math.cos(heading)*3.1/30;
      });
      const curved=await wake(),oldTrail=foamAt(curved,trailX,trailZ);
      const foamSum=field=>field.reduce((sum,v,i)=>sum+(i%4===2?v:0),0);
      const beforeStop=foamSum(curved);
      boat.surgeVelocity=0;await advance(180,1/30);
      const afterStop=foamSum(await wake());
      await advance(450,0.1);
      const afterDecay=foamSum(await wake());
      const trailHistory={trailFoam,oldTrail,beforeStop,afterStop,afterDecay};
      device.destroy();
      return { resting, moving, probeError, selfPropulsion, contacts: Array.from(movingContacts), retained, finite, disabled, dry, impact, landing, landedLive, contactError, launched, outgoing, settled, second, liftedStern, trailHistory, errors };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.resting.live, 0); assert.equal(result.resting.wake, 0);
    assert.ok(result.resting.contacts.every((v, i) => i % 16 !== 3 || v === 0));
    assert.equal(result.moving.live,0,'steady speed on flat water must not become a droplet fountain');
    assert.equal(result.moving.sheets,0,'calm displacement does not launch impact sheets');
    assert.ok(result.moving.maxHeight > 0.02 && result.moving.maxHeight <= 1.11);
    assert.ok(result.moving.foam > 1);
    assert.ok(result.probeError < 0.001, `Buoyancy differs from wake texture: ${result.probeError}`);
    assert.equal(result.selfPropulsion, 0, 'the local wake affects buoyancy but cannot propel its own ship');
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(result.contacts[i * 16] + result.contacts[(i + 16) * 16]) < 1e-5, 'port/starboard contact symmetry');
      assert.ok(Math.abs(result.contacts[i * 16 + 3] - result.contacts[(i + 16) * 16 + 3]) < 1e-5, 'port/starboard energy symmetry');
    }
    assert.ok(result.retained > 20, 'wake must remain in world space when its grid moves');
    assert.ok(result.finite); assert.deepEqual(result.disabled, { live: 0, wake: false });
    assert.ok(result.dry.every((v, i) => i % 16 !== 3 || v === 0), 'dry hull emits no spray');
    assert.ok(result.launched>10,'a rising crest launches a coherent sheet population');
    assert.ok(result.outgoing>0.0001,`impact must radiate away from the hull: ${result.outgoing}`);
    assert.equal(result.settled.sheets,0,'impact sheets expire between waves');
    assert.equal(result.settled.particles,0,'mist settles between waves');
    assert.ok(result.settled.contacts.every((v,i)=>i%16!==7 || v<0.0001),'impact energy decays on a held water level');
    assert.ok(result.second.some((v,i)=>i%16===15 && v>result.impact[i]),'the next crest triggers another launch');
    assert.ok(result.impact.some((v, i) => i % 16 === 3 && v > 0.2), 'relative wave impact drives emission at zero boat speed');
    assert.ok(result.landing > 0, 'landing deposits foam'); assert.ok(result.landedLive <= 0, 'landed particle is retired');
    assert.ok(result.contactError < 0.02, `Tilted hull contact error: ${result.contactError}`);
    assert.ok(result.liftedStern.bow>0.5 && result.liftedStern.stern===0,`stern contact must be independent: ${JSON.stringify(result.liftedStern)}`);
    const trail=result.trailHistory;
    assert.ok(trail.trailFoam>0.04,`foam survives eight metres astern: ${JSON.stringify(trail)}`);
    assert.ok(trail.oldTrail>trail.trailFoam*0.15,'a turn must leave old foam on its original world-space track');
    assert.ok(trail.afterStop<trail.beforeStop*0.8 && trail.afterStop>trail.beforeStop*0.15,'stopping ages the trail without deleting it or sustaining new foam');
    assert.ok(trail.afterDecay<trail.afterStop*0.03,'old wake foam eventually clears');
  } finally { await page.close(); }
});

test('gunwales exclude the external wave field above the deck without hiding surrounding water', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__hull_mask_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__hull_mask_test`);
    const result=await page.evaluate(async()=>{
      const {HULL_PROFILE}=await import('/js/wgsl/hull.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const locations=[
        [0,0,0], [0,1,0], [0,1.8,0], [1.7,1.8,0], // below/above rail, inside hull
        [0,3,4], [0,1.8,-6], // quarterdeck and narrow bow
        [2,1.8,0], [1,1.8,-6], [0,1.8,-6.5], [0,3,5.7], [0,-2,0],
      ];
      const B=GPUBufferUsage,size=locations.length*4;
      const points=device.createBuffer({size:locations.length*16,usage:B.STORAGE|B.COPY_DST});
      const output=device.createBuffer({size,usage:B.STORAGE|B.COPY_SRC});
      const read=device.createBuffer({size,usage:B.COPY_DST|B.MAP_READ});
      device.queue.writeBuffer(points,0,new Float32Array(locations.flatMap(p=>[...p,0])));
      const module=device.createShaderModule({code:HULL_PROFILE+`
        @group(0) @binding(0) var<storage,read> points:array<vec4f>;
        @group(0) @binding(1) var<storage,read_write> result:array<u32>;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
          result[id.x]=select(0u,1u,hullExcludesOcean(points[id.x].xyz));
        }
      `});
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:points}},{binding:1,resource:{buffer:output}}]});
      const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipe);cp.setBindGroup(0,group);cp.dispatchWorkgroups(locations.length);cp.end();
      enc.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
      const mask=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();device.destroy();return{mask,errors};
    });
    assert.deepEqual(result.errors,[]);
    assert.deepEqual(result.mask,[1,1,1,1,1,1,0,0,0,0,0],
      'crests above the rail must enter via deck wash, not reappear as ocean inside the hull');
  }finally{await page.close();}
});

test('deck overtopping retains water, flows downhill, drains, and dries independently', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__deck_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__deck_test`);
    const result=await page.evaluate(async()=>{
      const {createDeckWash}=await import('/js/deck.js');
      const {DECK_COLS:W,DECK_ROWS:H}=await import('/js/wgsl/deck.js');
      const {boatRotate}=await import('/js/boat.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=size=>device.createBuffer({size,usage:B.UNIFORM|B.COPY_DST});
      const frameUBO=buffer(384),hullUBO=buffer(96),uniform=buffer(64);
      const f=new Float32Array(96);f.fill(1,48,54);device.queue.writeBuffer(frameUBO,0,f);
      const h=new Float32Array(24);h[0]=h[5]=1;h[10]=-1;h[12]=3.6;h[13]=12;h[22]=1;
      const u=new Float32Array(16);u[9]=1;
      const sea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const env=device.createTexture({size:[32,32,6],mipLevelCount:6,format:'rgba16float',usage:T.TEXTURE_BINDING});
      const trans=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const shader=async(code,label)=>{
        const module=device.createShaderModule({code,label});
        const info=await module.getCompilationInfo();
        const bad=info.messages.filter(m=>m.type==='error');if(bad.length)throw new Error(bad.map(m=>m.message).join('\n'));
        return module;
      };
      const computePipe=async(code,label)=>device.createComputePipelineAsync({layout:'auto',compute:{module:await shader(code,label),entryPoint:'main'}});
      const deck=await createDeckWash({device,frameUBO,hullUBO,uniform,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,envView:env.createView({dimension:'cube'}),transView:trans.createView(),shader,computePipe});
      const seaHeight=half=>device.queue.writeTexture({texture:sea},new Uint16Array([0,half,0,0]),{bytesPerRow:8},[1,1,1]);
      async function advance(n,dt=1/60,reset=false){
        u[6]=dt;u[7]=reset?1:0;device.queue.writeBuffer(uniform,0,u);device.queue.writeBuffer(hullUBO,0,h);
        // Every submission advances exactly four bounded water substeps.
        for(let i=0;i<n;i++){
          const enc=device.createCommandEncoder(),cp=enc.beginComputePass();deck.encode(cp);cp.end();device.queue.submit([enc.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
      }
      async function read(){
        const size=W*H*16,read=device.createBuffer({size,usage:B.COPY_DST|B.MAP_READ});
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture:deck.textures[0]},{buffer:read,bytesPerRow:W*16},[W,H]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const a=new Float32Array(read.getMappedRange().slice(0));read.unmap();read.destroy();
        let water=0,wet=0,drain=0,center=0,moment=0,roof=0,forecastle=0,max=0,finite=true;
        for(let i=0;i<W*H;i++){
          const z=(Math.floor(i/W)+0.5)/H*11.9-6.3,x=i%W;
          const width=Math.max(0.04,1.8*Math.sqrt(Math.max(0.0006,1-(z<0?-z/6.4:z/7.4)**2))-0.04);
          const volume=a[i*4]*2*width/W*11.9/H;
          water+=volume;wet+=a[i*4+2];drain+=Math.max(0,a[i*4+3]);
          moment+=(x/(W-1)*2-1)*volume;max=Math.max(max,a[i*4]);
          if(x>10 && x<22)center+=volume;if(z>=2.7)roof+=volume;
          if(z<=-3.9)forecastle+=volume;
        }
        for(const n of a)finite&&=Number.isFinite(n);
        return{water,wet,drain,center,moment,roof,forecastle,max,finite};
      }
      await advance(1,1/60,true);seaHeight(0x3c00);await advance(60);const belowRail=await read();
      seaHeight(0x4200);await advance(120);const flooded=await read(); // three-metre crest
      seaHeight(0);await advance(1);const retained=await read();
      boatRotate(h.subarray(0,3),1,0,0,0,0,0.22);boatRotate(h.subarray(4,7),0,1,0,0,0,0.22);boatRotate(h.subarray(8,11),0,0,-1,0,0,0.22);
      await advance(90);const tilted=await read();
      await advance(600);const drained=await read();
      await advance(1800);const drying=await read();
      u[9]=0;await advance(1);const disabled=await read();u[9]=1;
      // The frame limit used during slow rendering still yields finite bounded water.
      seaHeight(0x4800);await advance(30,0.1);const submerged=await read();
      await advance(1,1/60,true);const reset=await read();
      device.destroy();return{belowRail,flooded,retained,tilted,drained,drying,disabled,submerged,reset,errors};
    });
    assert.deepEqual(result.errors,[]);
    assert.equal(result.belowRail.water,0,'water below the bulwark must not seep through the hull');
    assert.ok(result.flooded.water>0.1 && result.flooded.center>0.01,'overtopping must travel into the deck');
    assert.equal(result.flooded.roof,0,'a lower crest must not flood the raised quarterdeck');
    assert.ok(result.flooded.forecastle>0,'a three-metre crest can overtop the continuous foredeck');
    assert.ok(result.retained.water>result.flooded.water*0.8,'the deck must retain wash after the sea recedes');
    assert.ok(result.tilted.drain>0,'scupper outflow drives runoff strips');
    assert.ok(result.tilted.moment<0,'wash moves toward the low port rail');
    assert.ok(result.drained.water<result.retained.water*0.3,`water drains between encounters: ${JSON.stringify(result)}`);
    assert.ok(result.drained.wet>10,'wet timber outlasts standing water');
    assert.ok(result.drying.wet<result.drained.wet*0.9,'wetness must eventually dry instead of rounding to a permanent film');
    assert.ok(result.submerged.finite && result.submerged.max<=1.201,'deep immersion stays bounded at low frame rates');
    assert.equal(result.disabled.water,0);assert.equal(result.reset.water,0);assert.equal(result.reset.wet,0);
  }finally{await page.close();}
});

test('foam forms at breaking compression, stays bounded, and clears between crests', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__foam_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__foam_test`);
    const result=await page.evaluate(async()=>{
      const {FOAM_MODEL}=await import('/js/wgsl/common.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const code=FOAM_MODEL+`@group(0) @binding(0) var<storage,read_write> out:array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
        let dt=select(1.0/30.0,1.0/120.0,id.x==1u); let steps=u32(round(8.0/dt));
        let calm=breakingCompression(-0.3,0.0,0.0,0.45);
        let crest=breakingCompression(-1.5,0.0,0.0,0.45);
        var f=0.0;for(var i=0u;i<steps;i++){f=foamCoverage(f,crest,1.7,0.85,dt);}
        let peak=f;for(var i=0u;i<u32(round(3.0/dt));i++){f=foamCoverage(f,calm,1.7,0.85,dt);}
        out[id.x]=vec4f(calm,crest,peak,f);
      }`;
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
      const out=device.createBuffer({size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const read=device.createBuffer({size:32,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipe);
      cp.setBindGroup(0,device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:out}}]}));cp.dispatchWorkgroups(2);cp.end();
      enc.copyBufferToBuffer(out,0,read,0,32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();device.destroy();return {values,errors};
    });
    assert.deepEqual(result.errors,[]);const a=result.values.slice(0,4),b=result.values.slice(4);
    assert.equal(a[0],0);assert.equal(a[1],1);
    assert.ok(a[2]>0.5 && a[2]<0.9,'sustained breaking remains fractional coverage');
    assert.ok(a[3]<0.08,'foam clears within three seconds after a crest passes');
    for(let i=0;i<4;i++)assert.ok(Math.abs(a[i]-b[i])<1e-5,'30 Hz and 120 Hz coverage agree');
  }finally{await page.close();}
});

test('crest spray requires wind and breaking, drifts downwind, excludes the hull and clears', { timeout: 120000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__crest_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__crest_test`);
    const result = await page.evaluate(async () => {
      const { SPINDRIFT_COUNT, SPINDRIFT_UPDATE, SPINDRIFT_STATE } = await import('/js/wgsl/spindrift.js');
      const { hullHalfWidth } = await import('/js/hull.js');
      const device = await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors = []; device.onuncapturederror = e => errors.push(e.error.message);
      const bu = GPUBufferUsage, tu = GPUTextureUsage;
      const make = (size, usage) => device.createBuffer({ size, usage });
      const frame = make(384, bu.UNIFORM | bu.COPY_DST), control = make(16, bu.UNIFORM | bu.COPY_DST), hull = make(96, bu.UNIFORM | bu.COPY_DST);
      const plumes = make(SPINDRIFT_COUNT * 64, bu.STORAGE | bu.COPY_SRC);
      const read = make(plumes.size, bu.MAP_READ | bu.COPY_DST);
      const textures = [0, 1].map(() => device.createTexture({ size: [1, 1, 6], format: 'rgba16float', usage: tu.TEXTURE_BINDING | tu.COPY_DST }));
      const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: SPINDRIFT_UPDATE }), entryPoint: 'main' } });
      const resources = [{ buffer: frame }, { buffer: control }, { buffer: hull }, ...textures.map(t => t.createView({ dimension: '2d-array' })), sampler, { buffer: plumes }];
      const group = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
      const f = new Float32Array(96), h = new Float32Array(24);
      f[17] = 8; f[30] = -1; f.set([1, 1, 1, 1, 1, 1], 48);
      h[0] = 1; h[5] = 1; h[10] = -1; h[12] = 3.6; h[13] = 12;
      function sea(breaking) {
        const d = new Uint16Array(24), j = new Uint16Array(24);
        d[1] = 0x3c00; // Constant height 1 m, only cascade zero contributes.
        j[2] = breaking ? 0xbe00 : 0; // -1.5: compressed/breaking; zero: flat.
        for (const [i, data] of [d, j].entries()) device.queue.writeTexture({ texture: textures[i] }, data, { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, 6]);
      }
      function dispatch(dt, reset, amount, index) {
        device.queue.writeBuffer(control, 0, new Float32Array([dt, reset, amount, index]));
        const enc = device.createCommandEncoder(), cp = enc.beginComputePass();
        cp.setPipeline(pipe); cp.setBindGroup(0, group); cp.dispatchWorkgroups(SPINDRIFT_COUNT / 64); cp.end();
        device.queue.submit([enc.finish()]);
      }
      async function snapshot() {
        const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(plumes, 0, read, 0, plumes.size); device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ); const a = new Float32Array(read.getMappedRange()).slice(); read.unmap();
        return Array.from({ length: SPINDRIFT_COUNT }, (_, i) => Array.from(a.slice(i * 16, i * 16 + 16))).filter(p => p[7] > 0);
      }
      async function run(speed, breaking, visible = false, dt = 1 / 30) {
        f[56] = 1; f[58] = speed; device.queue.writeBuffer(frame, 0, f);
        h[22] = visible ? 1 : 0; device.queue.writeBuffer(hull, 0, h); sea(breaking);
        dispatch(dt, 1, 1, 0);
        for (let i = 1; i <= Math.round(2 / dt); i++) dispatch(dt, 0, 1, i);
        return snapshot();
      }
      const calm = await run(7, true), flat = await run(28, false), moderate = await run(12, true), strong = await run(28, true);
      sea(false);
      for (let i = 61; i <= 150; i++) dispatch(1 / 30, 0, 1, i);
      const expired = (await snapshot()).length;
      const fast = await run(28, true, false, 1 / 120);
      // An enlarged hull makes exclusion meaningful over much of the emission domain.
      h[12] = 72; h[13] = 120;
      const protectedPlumes = await run(28, true, true);
      const {HULL_VERTICAL_SCALE}=await import('/js/hull.js');
      const hullViolations = protectedPlumes.filter(p => Math.abs(p[0] * 3.6 / h[12]) < hullHalfWidth(p[2] * 12 / h[13], p[1]/HULL_VERTICAL_SCALE)).length;
      dispatch(1 / 30, 0, 0, 61); const disabled = (await snapshot()).length;
      await run(28, true); dispatch(1 / 30, 1, 1, 61); const reset = (await snapshot()).length;
      // Exercise the actual shared trajectory helper with mirrored wind directions.
      const motionCode = `${SPINDRIFT_STATE}
        @group(0) @binding(0) var<storage, read_write> out: array<vec4f>;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
          let sign = select(1.0, -1.0, id.x == 1u);
          let p = CrestPlume(vec4f(0.0,1.0,0.0,0.0),vec4f(2.0*sign,2.0,0.0,2.0),vec4f(0.0),vec4f(1.0,0.0,20.0*sign,0.0));
          out[id.x] = vec4f(plumePosition(p, 1.0), 0.0);
        }`;
      const motionPipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: motionCode }), entryPoint: 'main' } });
      const motion = make(32, bu.STORAGE | bu.COPY_SRC), motionRead = make(32, bu.MAP_READ | bu.COPY_DST);
      const enc = device.createCommandEncoder(), cp = enc.beginComputePass(); cp.setPipeline(motionPipe);
      cp.setBindGroup(0, device.createBindGroup({ layout: motionPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: motion } }] }));
      cp.dispatchWorkgroups(2); cp.end(); enc.copyBufferToBuffer(motion, 0, motionRead, 0, 32); device.queue.submit([enc.finish()]);
      await motionRead.mapAsync(GPUMapMode.READ); const positions = Array.from(new Float32Array(motionRead.getMappedRange())); motionRead.unmap();
      device.destroy();
      return { errors, calm: calm.length, flat: flat.length, moderate: moderate.length, strong, expired, fast: fast.length, protectedCount: protectedPlumes.length, hullViolations, disabled, reset, positions };
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.calm, 0); assert.equal(result.flat, 0);
    assert.ok(result.moderate > 0 && result.strong.length > result.moderate * 1.5, JSON.stringify({ moderate: result.moderate, strong: result.strong.length }));
    assert.ok(result.strong.length <= 1024 && result.strong.every(p => p.every(Number.isFinite)));
    assert.ok(result.strong.every(p => Math.abs(p[1] - 1.12) < 1e-5), 'births sit on the sampled displaced surface');
    assert.ok(Math.abs(result.fast - result.strong.length) / result.strong.length < 0.25, 'emission density remains comparable at 30 and 120 Hz');
    assert.ok(result.protectedCount > 0); assert.equal(result.hullViolations, 0);
    assert.equal(result.expired, 0); assert.equal(result.disabled, 0); assert.equal(result.reset, 0);
    assert.ok(result.positions[0] > 6 && result.positions[4] < -6, 'spray entrains into the wind');
    assert.ok(Math.abs(result.positions[0] + result.positions[4]) < 1e-5);
  } finally { await page.close(); }
});

test('crest spray populates from the actual rough FFT ocean without the ship', { timeout: 180000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1, height: 1 } });
  try {
    await page.addInitScript(instrumentRenderer);
    await page.addInitScript(() => {
      // This fixture reads simulation state. Drawing millions of ocean vertices
      // on a CPU GPU adds no coverage; the scheduling fixture tests both draw paths.
      GPURenderPassEncoder.prototype.drawIndexed = function () {};
      GPURenderPassEncoder.prototype.draw = function () {};
    });
    await page.goto(`${origin}/?prow=0&clouds=0&cam=0,8,0,0,-8&windSpeed=26&windDir=65&swellHs=5&choppy=1.6&shot=test.png&frames=100000`);
    await page.waitForFunction(() => check.callback, undefined, { polling: 100, timeout: 120000 });
    // Two simulated seconds exercise crest encounters and the finite-lived population.
    for (let i = 0; i < 120; i++) await step(page);
    const stats = await page.evaluate(async () => {
      const device = check.device, source = check.buffers.crest;
      const read = device.createBuffer({ size: source.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(source, 0, read, 0, source.size); device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ); const a = new Float32Array(read.getMappedRange());
      let active = 0, finite = true;
      for (let i = 0; i < a.length; i += 16) { if (a[i + 7] > 0) active++; for (let k = 0; k < 16; k++) finite &&= Number.isFinite(a[i + k]); }
      read.unmap(); read.destroy(); return { active, finite };
    });
    assert.ok(stats.finite); assert.ok(stats.active > 5, `rough sea active wisps: ${stats.active}`);
    console.log('Rough FFT crest spray:', stats);
  } finally { await page.close(); }
});

test('renderer invalidates only changed sky inputs and skips disabled bloom', { timeout: 600000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 64, height: 48 } });
  try {
    await page.addInitScript(instrumentRenderer);
    // Scheduling is checked with clear volumes; the focused cloud fixture below
    // exercises populated raymarching without full 256px reflection faces on a CPU GPU.
    await page.goto(`${origin}/?prow=0&clouds=0&cam=0,30,0,0,-5.5&shot=test.png&frames=100000`);
    await page.waitForFunction(() => check.callback, undefined, { polling: 100, timeout: 120000 });
    let frame = await step(page);
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute['env cube'][0][2], 6);
    assert.ok(frame.compute['cube mips'].every(d => d[2] === 6));
    assert.equal(frame.compute['cloud density'].length, 1);
    assert.equal(frame.compute['cloud lighting'].length, 1);
    assert.equal(frame.compute['cloud rays'].length, 1);
    assert.equal(frame.compute['cloud resolve'].length, 1);
    assert.equal(frame.render['bloom down'], 6); // 32 x 24 supports six mip levels.
    assert.equal(frame.render['bloom up'], 5);
    assert.equal(frame.render['solid shadows'],undefined);
    assert.equal(frame.render['canvas shadows'],undefined);

    frame = await step(page);
    assert.equal(frame.compute.skyview, undefined);
    assert.equal(frame.compute.transmittance, undefined);
    assert.equal(frame.compute['sim init'], undefined);
    assert.equal(frame.compute['sim evolve'], undefined);
    assert.equal(frame.compute['height probe'], undefined);
    assert.equal(frame.compute['cloud density'], undefined);
    assert.equal(frame.compute['crest spray update'], undefined, 'calm wind skips crest work after its initial clear');
    assert.equal(frame.render['crest spray'], undefined);
    assert.equal(frame.compute['cloud lighting'], undefined);
    assert.equal(frame.compute['cloud rays'].length, 1);
    assert.equal(frame.compute['env cube'][0][2], 1);
    assert.ok(frame.compute['cube mips'].every(d => d[2] === 1));

    await slider(page, 'Sun azimuth', 25);
    frame = await step(page);
    assert.equal(frame.compute.skyview, undefined); // The LUT is relative to the sun.
    assert.equal(frame.compute['cloud density'], undefined);
    assert.equal(frame.compute['cloud lighting'].length, 1);
    assert.equal(frame.compute['env cube'][0][2], 6);

    await slider(page, 'Sun elevation', 10);
    frame = await step(page);
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute.transmittance, undefined);

    await slider(page, 'Haze', 4);
    frame = await step(page);
    for (const key of ['transmittance', 'multiscatter', 'skyview']) assert.equal(frame.compute[key].length, 1);

    await page.keyboard.down('KeyE');
    frame = await step(page);
    await page.keyboard.up('KeyE');
    assert.equal(frame.compute.skyview.length, 1);
    assert.equal(frame.compute.transmittance, undefined);

    await slider(page, 'Choppiness', 0.5);
    await slider(page, 'Bloom', 0);
    frame = await step(page);
    assert.equal(frame.compute['sim init'], undefined);
    assert.equal(frame.render['bloom down'], undefined);
    assert.equal(frame.render['bloom up'], undefined);

    assert.equal(frame.render.composite, 1);

    await slider(page, 'Wind speed', 10);
    await slider(page, 'Bloom', 0.1);
    await page.setViewportSize({ width: 1, height: 1 });
    frame = await step(page);
    assert.equal(frame.compute['sim init'].length, 1);
    assert.equal(frame.compute['cloud density'], undefined, 'wind advects the material instead of rebuilding it');
    assert.equal(frame.compute['height probe'].length, 1);
    assert.equal(frame.render['bloom down'], 1);
    assert.equal(frame.render['bloom up'], undefined);
    assert.equal(frame.compute['crest spray update'].length, 1);
    assert.equal(frame.render['crest spray'], 1, 'crest spray renders with the ship hidden');

    // The target is deliberately 1x1; exercise the control's change handler directly.
    await page.getByLabel('Show ship', { exact: true }).evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change')); });
    frame = await step(page);
    for (const key of ['hull contact', 'impact sheets', 'local wake', 'spray update', 'height probe']) assert.equal(frame.compute[key].length, 1);
    assert.equal(frame.render['bow sheets'], 1); assert.equal(frame.render.spray, 1);
    assert.equal(frame.render['solid shadows'],1);assert.equal(frame.render['canvas shadows'],1);
    await page.getByLabel('Wakes & spray', { exact: true }).evaluate(input => { input.checked = false; input.dispatchEvent(new Event('change')); });
    await step(page); // One dispatch clears active particles and the local field.
    frame = await step(page);
    assert.equal(frame.compute['local wake'], undefined);
    assert.equal(frame.compute['spray update'], undefined);
    assert.equal(frame.compute['crest spray update'].length, 1);
    assert.equal(frame.render['crest spray'], 1, 'crest spray survives disabling boat effects');
    assert.equal(frame.render['bow sheets'], undefined); assert.equal(frame.render.spray, undefined);
    assert.equal(frame.render['solid shadows'],1);assert.equal(frame.render['canvas shadows'],1);
    await page.setViewportSize({width:32,height:24});
    await page.getByLabel('Show ship', { exact: true }).evaluate(input => { input.checked = false; input.dispatchEvent(new Event('change')); });
    frame=await step(page);
    assert.equal(frame.render.caravel,undefined);assert.equal(frame.render.composite,1);
    assert.equal(frame.render['solid shadows'],undefined);
    await page.getByLabel('Show ship', { exact: true }).evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change')); });
    frame=await step(page);
    assert.equal(frame.render.caravel,1);assert.equal(frame.render['solid shadows'],1);
    await slider(page, 'Crest spray', 0);
    await step(page);
    frame = await step(page);
    assert.equal(frame.compute['crest spray update'], undefined);
    assert.equal(frame.render['crest spray'], undefined);
  } finally { await page.close(); }
});

test('volumetric clouds clear, occlude, advect, and invalidate temporal history', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__cloud_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__cloud_test`);
    const result=await page.evaluate(async()=>{
      const {createVolumetricClouds}=await import('/js/clouds.js');
      const {FRAME_WGSL,ATMO_CORE_WGSL}=await import('/js/wgsl/common.js');
      const {SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const {CLOUD_SAMPLE}=await import('/js/wgsl/clouds.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const computePipe=async(code,label)=>device.createComputePipelineAsync({label,layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
      const frameUBO=device.createBuffer({size:384,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const lut=device.createTexture({size:[1,1],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      device.queue.writeTexture({texture:lut},new Uint16Array([0x3c00,0x3c00,0x3c00,0x3c00]),{bytesPerRow:8},[1,1]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const clouds=await createVolumetricClouds({device,frameUBO,transView:lut.createView(),skyView:lut.createView(),sampler,computePipe,fieldSize:[32,16,32]});
      const settings={clouds:0,cloudBase:1,cloudDepth:2,cloudDensity:1,cloudAnvil:0.8,cloudQuality:0.5,haze:3};
      const f=new Float32Array(96);f[17]=2;
      // Look upward through the layer. A camera-relative projection supplies
      // real history coordinates, including rotation and perspective divide.
      f[0]=2;f[7]=1;f[9]=2;f[14]=0.1;
      f[20]=0.5;f[26]=0.5;f[29]=1;f[33]=1;f[35]=14;
      f[36]=64;f[37]=48;f[38]=1/64;f[39]=1/48;f[56]=1;f[58]=20;f[72]=3;f[73]=0.01;
      const half=b=>{const e=(b>>10)&31,m=b&1023;return (b&32768?-1:1)*(e===31?(m?NaN:Infinity):e?(1+m/1024)*2**(e-15):m*2**-24);};
      async function read(texture){
        const row=Math.ceil(texture.width*8/256)*256;
        const buffer=device.createBuffer({size:row*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[texture.width,texture.height]);device.queue.submit([enc.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);const src=new Uint16Array(buffer.getMappedRange());const out=[];
        for(let y=0;y<texture.height;y++)for(let x=0;x<texture.width;x++)for(let c=0;c<4;c++)out.push(half(src[y*row/2+x*4+c]));
        buffer.unmap();buffer.destroy();return out;
      }
      async function advance(dt=1/60){
        f[70]++;device.queue.writeBuffer(frameUBO,0,f);clouds.update(f,settings,dt);
        const history=clouds.historyValid;const enc=device.createCommandEncoder(),pass=enc.beginComputePass();clouds.encode(pass);pass.end();device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();return history;
      }
      await advance();const clear=await read(clouds.output);
      settings.clouds=0.9;const coverageReset=await advance();const cloudy=await read(clouds.output);
      const accumulated=await advance();
      settings.cloudDensity=2;const densityReset=await advance();const dense=await read(clouds.output);
      await advance(20);const moved=await read(clouds.output);
      // Same volume / optical law powers the sunlight and reflected rays.
      const visibility=await computePipe(FRAME_WGSL+ATMO_CORE_WGSL+`
        @group(0) @binding(0) var<uniform> F:Frame;
        @group(0) @binding(1) var transLUT:texture_2d<f32>;
        @group(0) @binding(2) var skyLUT:texture_2d<f32>;
        @group(0) @binding(3) var sampC:sampler;
        @group(0) @binding(4) var<storage,read_write> result:array<f32>;
      `+SKY_RENDER_FUNCS+CLOUD_SAMPLE+`
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
          let origin=vec3f(f32(id.x%8u)*2.0-7.0,0.002,f32(id.x/8u)*2.0-3.0);
          result[id.x]=volumeSunVisibility(origin,vec3f(0,1,0));
        }
      `,'test cloud sunlight');
      const output=device.createBuffer({size:128,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const readback=device.createBuffer({size:128,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const visGroup=device.createBindGroup({layout:visibility.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:output}}]});
      const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(visibility);pass.setBindGroup(0,visGroup);pass.setBindGroup(1,clouds.bindVolume(visibility,true));pass.dispatchWorkgroups(32);pass.end();enc.copyBufferToBuffer(output,0,readback,0,128);device.queue.submit([enc.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const sun=new Float32Array(readback.getMappedRange()).reduce((a,b)=>a+b,0)/32;readback.unmap();
      f[36]=1;f[37]=1;const resized=await advance();const tiny=await read(clouds.output);
      f[16]=1000;const teleported=await advance();settings.clouds=0;await advance();const cleared=await read(clouds.output);
      const meanAlpha=v=>v.filter((_,i)=>i%4===3).reduce((a,b)=>a+b,0)/(v.length/4);
      const diff=dense.reduce((sum,v,i)=>sum+Math.abs(v-moved[i]),0)/dense.length;
      clouds.destroy();device.destroy();
      return {errors,clear:meanAlpha(clear),cloudy:meanAlpha(cloudy),dense:meanAlpha(dense),cleared:meanAlpha(cleared),diff,sun,
        coverageReset,densityReset,accumulated,resized,teleported,tiny:tiny.length,finite:[...clear,...cloudy,...dense,...moved,...tiny].every(Number.isFinite)};
    });
    assert.deepEqual(result.errors,[]);
    assert.ok(result.finite);
    assert.equal(result.clear,0);assert.equal(result.cleared,0);
    assert.ok(result.cloudy>0.05,JSON.stringify(result));
    assert.ok(result.dense>=result.cloudy,'greater optical density must not make clouds transparent');
    assert.ok(result.diff>0.005,'wind changes the visible material');
    assert.ok(result.sun>=0 && result.sun<1,'the same volume occludes direct sunlight');
    assert.equal(result.accumulated,true);
    for(const key of ['coverageReset','densityReset','resized','teleported'])assert.equal(result[key],false,key);
    assert.equal(result.tiny,4);
  }finally{await page.close();}
});

test('clouds extinguish the HDR sun and surface light together', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__sun_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__sun_test`);
    const result=await page.evaluate(async()=>{
      const {SUN_VIS}=await import('/js/wgsl/sky.js');
      const {SKY_BG}=await import('/js/wgsl/ocean.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(size,usage)=>device.createBuffer({size,usage});
      const frame=buffer(384,B.UNIFORM|B.COPY_DST),cloud=buffer(128,B.UNIFORM|B.COPY_DST);
      const sun=buffer(16,B.STORAGE|B.COPY_SRC);
      const f=new Float32Array(96),c=new Float32Array(32);
      f[17]=2;f.set([0,0.5,-Math.sqrt(0.75)],28);f.set([0,0.5,-Math.sqrt(0.75),14],32);
      f.set([1,1,1,1/1024],36);f[72]=3;f[73]=0.01;
      c[24]=1;c[25]=2;c[31]=1;
      device.queue.writeBuffer(frame,0,f);
      const density=device.createTexture({dimension:'3d',size:[8,8,8],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:density},new Uint16Array(8*8*8*4).fill(0x3c00),{bytesPerRow:64,rowsPerImage:8},[8,8,8]);
      const lut=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:lut},new Uint16Array(4).fill(0x3c00),{bytesPerRow:8},[1,1]);
      const screen=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      // Camera rays stop at <0.8% transmittance. That is adequate for cloud
      // radiance, but must never be used to attenuate a 200,000-radiance sun.
      device.queue.writeTexture({texture:screen},new Uint16Array([0x3400,0x3400,0x3400,0x3bf0]),{bytesPerRow:8},[1,1]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const vis=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:SUN_VIS}),entryPoint:'main'}});
      const module=device.createShaderModule({code:SKY_BG});
      const sky=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba32float'}]}});
      const group=(pipe,index,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(index),entries:entries.map(([binding,resource])=>({binding,resource}))});
      const vg=group(vis,0,[[0,{buffer:frame}],[4,{buffer:sun}]]);
      const vc=group(vis,1,[[0,{buffer:cloud}],[1,density.createView()],[3,sampler]]);
      const sg=group(sky,0,[[0,{buffer:frame}],[1,lut.createView()],[2,lut.createView()],[3,sampler],[4,{buffer:sun}]]);
      const sc=group(sky,1,[[4,screen.createView()]]);
      const target=device.createTexture({size:[1,1],format:'rgba32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const read=buffer(512,B.COPY_DST|B.MAP_READ),values=[];
      for(const extinction of [0,0.4,8,30]){
        c[26]=extinction;device.queue.writeBuffer(cloud,0,c);
        const enc=device.createCommandEncoder(),cp=enc.beginComputePass();
        cp.setPipeline(vis);cp.setBindGroup(0,vg);cp.setBindGroup(1,vc);cp.dispatchWorkgroups(1);cp.end();
        const rp=enc.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
        rp.setPipeline(sky);rp.setBindGroup(0,sg);rp.setBindGroup(1,sc);rp.draw(3);rp.end();
        enc.copyBufferToBuffer(sun,0,read,0,16);enc.copyTextureToBuffer({texture:target},{buffer:read,offset:256,bytesPerRow:256},[1,1]);
        device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=new Float32Array(read.getMappedRange());values.push({visibility:data[0],radiance:data[64]});read.unmap();
      }
      device.destroy();return {errors,values};
    });
    assert.deepEqual(result.errors,[]);
    const [clear,thin,opaque,thicker]=result.values;
    assert.equal(clear.visibility,1);assert.ok(clear.radiance>100000);
    assert.ok(thin.visibility>0.15 && thin.visibility<0.25,'thin cloud follows Beer attenuation');
    assert.ok(opaque.visibility<1e-8 && thicker.visibility<1e-8,'opaque clouds must not retain a sunlight floor');
    assert.ok(opaque.radiance<1 && thicker.radiance<1,'opaque clouds must hide the HDR solar disc');
    assert.ok(Math.abs((thin.radiance-opaque.radiance)/(clear.radiance-opaque.radiance)-thin.visibility)<1e-5,
      'visible disc and surface sunlight must use identical attenuation');
  }finally{await page.close();}
});

test('GPU tiller opposes the rudder trailing edge and agrees with port and starboard steering', { timeout: 30000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/__rudder_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`${origin}/__rudder_test`);
    const result = await page.evaluate(async () => {
      const { VESSEL_RIG } = await import('/js/wgsl/vessel.js');
      const { createCaravelMesh } = await import('/js/caravel.js');
      const { TILLER_HANDLE, tillerPoint } = await import('/js/hull.js');
      const { stepBoatSteering } = await import('/js/boat.js');
      const mesh = createCaravelMesh(), blade = [];
      for (let i = 0; i < mesh.length; i += 9) if (mesh[i + 6] === 14) blade.push([mesh[i], mesh[i + 1], mesh[i + 2], 14]);
      const trailingZ = Math.max(...blade.map(p => p[2]));
      const points = blade.filter(p => p[2] === trailingZ);
      points.push([...TILLER_HANDLE,7]);
      const device = await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors = []; device.onuncapturederror = e => errors.push(e.error.message);
      const B = GPUBufferUsage, size = points.length * 16;
      const buffer = (size, usage) => device.createBuffer({ size, usage });
      const hull = buffer(144, B.UNIFORM | B.COPY_DST), input = buffer(size, B.STORAGE | B.COPY_DST);
      const output = buffer(size, B.STORAGE | B.COPY_SRC), read = buffer(size, B.MAP_READ | B.COPY_DST);
      device.queue.writeBuffer(input, 0, new Float32Array(points.flat()));
      const module = device.createShaderModule({ code: VESSEL_RIG + `
        @group(0) @binding(0) var<uniform> hull: Hull;
        @group(0) @binding(1) var<storage, read> points: array<vec4f>;
        @group(0) @binding(2) var<storage, read_write> result: array<vec4f>;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
          let p = points[id.x]; let v = rigVertex(p.xyz, vec3f(1,0,0), p.w, vec2f(0));
          result[id.x] = vec4f(v.position * v.scale, 1.0);
        }` });
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const group = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [hull, input, output].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const h = new Float32Array(24); h[12] = 3.6; h[13] = 12;
      const samples = [];
      for (const angle of [-35, -8.75, 0, 8.75, 35]) {
        h[15] = angle; device.queue.writeBuffer(hull, 0, h);
        const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.dispatchWorkgroups(points.length); pass.end();
        enc.copyBufferToBuffer(output, 0, read, 0, size); device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ); const values = new Float32Array(read.getMappedRange());
        let trailingX = 0; for (let i = 0; i < points.length - 1; i++) trailingX += values[i * 4] / (points.length - 1);
        const tillerX = values[(points.length - 1) * 4]; read.unmap();
        const boat = { speed: 6, length: 12, heading: 0, rudder: angle, rudderTarget: angle, yawRate: 0 };
        stepBoatSteering(boat, 0, 1 / 60);
        samples.push({ angle, trailingX, tillerX, expectedX:tillerPoint({...boat,beam:3.6})[0], yaw: boat.yawRate });
      }
      device.destroy(); return { samples, errors };
    });
    assert.deepEqual(result.errors, []);
    for (const { angle, trailingX, tillerX, expectedX, yaw } of result.samples) {
      if (angle === 0) { assert.ok(Math.abs(trailingX) < 1e-6); assert.equal(yaw, 0); }
      else {
        assert.equal(Math.sign(trailingX), Math.sign(yaw), 'blade trailing edge follows the commanded turn');
        assert.equal(Math.sign(trailingX), Math.sign(angle));
        assert.equal(Math.sign(tillerX), -Math.sign(trailingX), 'direct tiller moves opposite the rudder trailing edge');
        // WGSL trig permits small approximation error; keep alignment within 0.1 mm.
        assert.ok(Math.abs(tillerX-expectedX)<1e-4,`crew grip agrees with GPU steering geometry: ${JSON.stringify({angle,tillerX,expectedX})}`);
      }
    }
  } finally { await page.close(); }
});

test('vessel shadows follow the sun and hull, transmit canvas, and leave unblocked receivers lit', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__shadow_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__shadow_test`);
    const result=await page.evaluate(async()=>{
      const {createVesselShadows}=await import('/js/shadows.js');
      const {SHADOW_SAMPLE}=await import('/js/wgsl/shadows.js');
      const {HULL_VERTICAL_SCALE:S}=await import('/js/hull.js');
      const {boatRotate}=await import('/js/boat.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,buffer=(size,usage)=>device.createBuffer({size,usage});
      const shader=async(code,label)=>device.createShaderModule({code,label});
      const mesh=[];
      for(const [cx,material,width] of [[0,0,1],[3,9,1],[-3,0,0.035]])for(const [x,z] of [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]])
        mesh.push(cx+x*width,2,z,0,1,0,material,0.025,0.5);
      const vertices=new Float32Array(mesh),vertexBuffer=buffer(vertices.byteLength,B.VERTEX|B.COPY_DST);
      device.queue.writeBuffer(vertexBuffer,0,vertices);
      const hull=new Float32Array(24);hull[0]=1;hull[5]=1;hull[10]=-1;hull[12]=3.6;hull[13]=12;
      const hullUBO=buffer(144,B.UNIFORM|B.COPY_DST);
      const wetState=buffer(8,B.STORAGE|B.COPY_DST),wetLookup=buffer(vertices.length/9*4,B.STORAGE);
      const shadows=await createVesselShadows({device,hullUBO,mesh:vertices,vertexBuffer,shader,resolution:256,wetness:{state:wetState,lookup:wetLookup}});
      const module=await shader(SHADOW_SAMPLE+`
        @group(0) @binding(0) var<storage,read> points:array<vec4f>;
        @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
          let point=points[id.x];
          if(point.w>0.5){
            let rough=point.w>1.5;
            result[id.x]=vec4f(waterVesselShadow(point.xyz,
              normalize(select(vec3f(0,1,0),vec3f(0.45,1,0.2),rough)),
              select(vec3f(0,1,0),vec3f(0.6,0.8,0),rough),select(0.0,0.12,rough)),1.0);
          }else{result[id.x]=vec4f(vesselShadow(point.xyz,vec3f(0,1,0)),1.0);}
        }
      `,'shadow receivers');
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const points=buffer(80,B.STORAGE|B.COPY_DST),output=buffer(80,B.STORAGE|B.COPY_SRC),read=buffer(80,B.COPY_DST|B.MAP_READ);
      const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:points}},{binding:1,resource:{buffer:output}}]});
      const receivers=shadows.bind(pipe);
      async function sample(sun,locations,enabled=true){
        device.queue.writeBuffer(hullUBO,0,hull);shadows.update(hull,sun,enabled);
        const positions=locations.flatMap(([x,y,z,water=0])=>[x+hull[16],y+hull[17],z+hull[18],water]);
        device.queue.writeBuffer(points,0,new Float32Array(positions));
        const enc=device.createCommandEncoder();shadows.encode(enc);
        const cp=enc.beginComputePass();cp.setPipeline(pipe);cp.setBindGroup(0,group);cp.setBindGroup(1,receivers);cp.dispatchWorkgroups(locations.length);cp.end();
        enc.copyBufferToBuffer(output,0,read,0,80);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=Array.from(new Float32Array(read.getMappedRange())).slice(0,locations.length*4);read.unmap();return values;
      }
      const locations=[[0,0,0],[3,0,0],[6,0,0],[0,3*S,0],[0,2*S,0]];
      const overhead=await sample([0,1,0],locations);
      const waterLocations=[[0,0,0,1],[3,0,0,1],[20,0,20,1],[-3,0,0,1],[0.95,0,0,1]];
      const water=await sample([0,1,0],waterLocations);
      const choppy=await sample([0,1,0],waterLocations.map(([x,y,z])=>[x,y,z,2]));
      const thinSurface=await sample([0,1,0],[[-3,0,0]]);
      const waterHidden=await sample([0,1,0],waterLocations,false);
      hull[16]=10000;hull[17]=2;hull[18]=-8000;
      const moved=await sample([0,1,0],locations);
      boatRotate(hull.subarray(0,3),1,0,0,0.8,0.2,-0.15);
      boatRotate(hull.subarray(4,7),0,1,0,0.8,0.2,-0.15);
      boatRotate(hull.subarray(8,11),0,0,-1,0.8,0.2,-0.15);
      const solidCenter=new Float32Array(3),clothCenter=new Float32Array(3);
      boatRotate(solidCenter,0,2*S,0,0.8,0.2,-0.15);boatRotate(clothCenter,3,2*S,0,0.8,0.2,-0.15);
      const tilted=await sample([0,1,0],[[solidCenter[0],0,solidCenter[2]],[clothCenter[0],0,clothCenter[2]],
        [20,0,20],[solidCenter[0],solidCenter[1]+1,solidCenter[2]],Array.from(solidCenter)]);
      hull.fill(0,0,12);hull[0]=1;hull[5]=1;hull[10]=-1;
      const oblique=await sample([Math.SQRT1_2,Math.SQRT1_2,0],[[-2*S,0,0],[3-2*S,0,0],[-4*S,0,0],[0,3*S,0],[6,0,0]]);
      const hidden=await sample([0,1,0],locations,false),night=await sample([0,-1,0],locations);
      device.queue.writeBuffer(wetState,0,new Float32Array([1,1]));
      const wetCloth=await sample([0,1,0],locations);
      shadows.destroy();device.destroy();return {errors,overhead,moved,tilted,oblique,hidden,night,water,choppy,thinSurface,waterHidden,wetCloth};
    });
    assert.deepEqual(result.errors,[]);
    for(const values of [result.overhead,result.moved,result.tilted,result.oblique]){
      assert.ok(values[0]<0.01,'solid geometry blocks sunlight below it');
      assert.ok(values[4]>0.15 && values[4]<0.5,'canvas transmits a fraction of sunlight');
      assert.ok(values[4]>values[5] && values[5]>values[6],'canvas shadow retains warm transmission');
      assert.ok(values[8]>0.99 && values[12]>0.99,'outside/above the caster stays lit');
    }
    assert.ok(result.wetCloth[4]>result.overhead[4]+.04 && result.wetCloth[4]<.65,'wet canvas reduces scattering without becoming clear');
    assert.ok(result.overhead[16]>0.99,'caster surface must not shadow itself');
    assert.ok(result.water[0]<0.25,'a broad hull shadow survives water scattering');
    assert.ok(result.water[4]>result.water[5] && result.water[5]>result.water[6],'water preserves warm canvas transmission');
    assert.ok(result.water[8]>0.99 && result.choppy[8]>0.99,'water beyond the vessel footprint stays lit');
    assert.ok(result.thinSurface[0]<0.1 && result.water[12]>0.75,'fine rigging blocks surface glints but fades in scattered water light');
    assert.ok(result.water[16]>0.1 && result.water[16]<0.9,'water integrates across the silhouette edge');
    assert.ok(Math.abs(result.water[16]-result.choppy[16])>0.05,'wave normal and refracted view alter the underwater footprint');
    assert.ok(result.waterHidden.every(v=>v===1),'hidden vessel skips water shadowing');
    for(let i=0;i<result.moved.length;i++)assert.ok(Math.abs(result.moved[i]-result.overhead[i])<0.005,'translation retains the shadow');
    for(const values of [result.hidden,result.night])assert.ok(values.every(v=>v===1),'hidden/night shadows are disabled');
  }finally{await page.close();}
});

test('GPU canvas furls independently, braces with its yards and keeps finite lighting normals', {timeout:60000}, async()=>{
  const page=await browser.newPage();
  try {
    await page.route('**/__sail_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__sail_test`);
    const result=await page.evaluate(async()=>{
      const {VESSEL_RIG}=await import('/js/wgsl/vessel.js');
      const {createCaravelMesh}=await import('/js/caravel.js');
      const {hullScale}=await import('/js/hull.js');
      const scale=hullScale();
      const mesh=createCaravelMesh(),points=[];
      for(let i=0;i<mesh.length;i+=27)if(mesh[i+6]%1!==0)points.push(...mesh.subarray(i,i+27));
      const n=points.length/9,device=await(await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,buffer=(size,usage)=>device.createBuffer({size,usage});
      const hull=buffer(144,B.UNIFORM|B.COPY_DST),input=buffer(points.length*4,B.STORAGE|B.COPY_DST);
      const output=buffer(n*32,B.STORAGE|B.COPY_SRC),read=buffer(n*32,B.MAP_READ|B.COPY_DST);
      device.queue.writeBuffer(input,0,new Float32Array(points));
      const module=device.createShaderModule({code:VESSEL_RIG+`
        @group(0) @binding(0) var<uniform> hull:Hull;
        @group(0) @binding(1) var<storage,read> points:array<f32>;
        @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
          let i=gid.x*9u;if(i+8u>=arrayLength(&points)){return;}
          let v=rigVertex(vec3f(points[i],points[i+1u],points[i+2u]),vec3f(points[i+3u],points[i+4u],points[i+5u]),points[i+6u],vec2f(points[i+7u],points[i+8u]));
          result[gid.x*2u]=vec4f(v.position*v.scale,1);result[gid.x*2u+1u]=vec4f(v.normal,0);
        }`});
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[hull,input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const h=new Float32Array(36);h[12]=6;h[13]=20;h[19]=1.25;h[30]=h[31]=1;h[34]=7;h[35]=1;
      const samples=[];let full;
      for(const [set,yaw,tack] of [[[1,1,1],0,1],[[.5,.5,.5],0,1],[[0,0,0],0,1],[[0,1,1],0,1],[[1,1,1],.6,-1]]){
        h.set(set,24);h[28]=yaw;h[29]=-yaw;h[35]=tack;device.queue.writeBuffer(hull,0,h);
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(n/64));pass.end();
        enc.copyBufferToBuffer(output,0,read,0,n*32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const v=new Float32Array(read.getMappedRange()).slice();read.unmap();
        if(!full)full=v;
        const area=[0,0,0],motion=[0,0,0];let normalError=0,fixedError=0,yardHeightError=0;
        for(let i=0;i<n;i++){
          const material=points[i*9+6],base=Math.floor(material),tag=Math.round(material%1*16),id=tag&7,mast=id-1;
          normalError=Math.max(normalError,Math.abs(Math.hypot(...v.subarray(i*8+4,i*8+7))-1));
          const d=Math.hypot(...[0,1,2].map(j=>v[i*8+j]-full[i*8+j]));
          if(base===9||base===13)motion[mast]=Math.max(motion[mast],d);
          if(base===10)yardHeightError=Math.max(yardHeightError,Math.abs(v[i*8+1]-full[i*8+1]));
          if((tag&8)&&points[i*9+8]===0)fixedError=Math.max(fixedError,Math.hypot(...[0,1,2].map(j=>v[i*8+j]-points[i*9+j]*scale[j])));
          if(i%3===0&&(base===9||base===13)){
            const a=[0,1,2].map(j=>v[(i+1)*8+j]-v[i*8+j]),b=[0,1,2].map(j=>v[(i+2)*8+j]-v[i*8+j]);
            area[mast]+=.5*Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]);
          }
        }
        samples.push({area,motion,normalError,fixedError,yardHeightError,finite:v.every(Number.isFinite)});
      }
      device.destroy();return {samples,errors};
    });
    assert.deepEqual(result.errors,[]);
    const [full,reef,bare,fore,tack]=result.samples;
    for(const sample of result.samples){assert.equal(sample.finite,true);assert.ok(sample.normalError<.001);assert.ok(sample.fixedError<1e-6);assert.ok(sample.yardHeightError<1e-6);}
    for(let mast=0;mast<3;mast++){
      assert.ok(reef.area[mast]>full.area[mast]*.3&&reef.area[mast]<full.area[mast]*.65,'reef reduces exposed canvas');
      assert.ok(bare.area[mast]<full.area[mast]*.12,`bare poles retain gathered cloth: mast ${mast}, areas ${bare.area[mast]} / ${full.area[mast]}`);
      assert.ok(tack.motion[mast]>.5,'wind change rotates each sail group');
    }
    assert.ok(fore.motion[0]>2);assert.equal(fore.motion[1],0);assert.equal(fore.motion[2],0);
  }finally{await page.close();}
});

test('sailing controls drive finite hull uniforms through startup, lowering and mode changes', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.addInitScript(instrumentRenderer);
    await page.addInitScript(()=>{
      // Exercise the complete application loop/UI without rasterizing hundreds of test frames.
      GPURenderPassEncoder.prototype.draw=function(){};GPURenderPassEncoder.prototype.drawIndexed=function(){};
      GPUComputePassEncoder.prototype.dispatchWorkgroups=function(){};
      const write=GPUQueue.prototype.writeBuffer;
      GPUQueue.prototype.writeBuffer=function(buffer,offset,data,...args){
        if(buffer.label==='hull transform')check.hull=Array.from(data);
        return write.call(this,buffer,offset,data,...args);
      };
    });
    await page.goto(`${origin}/?view=ship&windSpeed=20&windDir=165&boatHeading=0&w=32&h=32`);
    await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:90000});
    assert.equal(await page.locator('#boat-propulsion').inputValue(),'sail');
    assert.equal(await page.locator('#boat-speed').isVisible(),false);
    const advance=async count=>page.evaluate(async count=>{
      check.now??=0;
      for(let i=0;i<count;i++){check.callback(check.now);check.now+=100;await check.device.queue.onSubmittedWorkDone();}
      return check.hull;
    },count);
    let hull=await advance(1);assert.ok(hull.every(Number.isFinite));assert.deepEqual(hull.slice(24,27),[1,1,1]);
    hull=await advance(80);assert.ok(hull[4]<-.01,'wind torque reaches the rendered hull lean');
    await page.getByRole('button',{name:'Captain',exact:true}).click();
    await page.getByRole('button',{name:'Furl all sails',exact:true}).click();
    hull=await advance(2);assert.equal(hull[24],1,'canvas waits for hands to reach the rigging');
    hull=await advance(1000);assert.ok(hull.every(Number.isFinite));assert.deepEqual(hull.slice(24,27),[0,0,0]);
    hull=await advance(200);assert.ok(Math.abs(hull[4])<.001,'bare poles settle upright on flat water');
    await page.getByRole('button',{name:'Reduce sail',exact:true}).click();
    hull=await advance(1000);assert.deepEqual(hull.slice(24,27),[.5,.5,.5]);
    await page.getByRole('button',{name:'Hide captain orders',exact:true}).click();
    await page.locator('#boat-propulsion').selectOption('manual');
    assert.equal(await page.locator('#boat-speed').isVisible(),true);assert.equal(await page.locator('#sail-controls').isVisible(),false);
    hull=await advance(3);assert.ok(hull.every(Number.isFinite));
    assert.deepEqual(await page.evaluate(()=>check.errors),[]);
  }finally{await page.close();}
});

test('mobile panels keep Hide reachable while scrolling, profiling and rotating', {timeout:120000}, async()=>{
  const page=await browser.newPage({viewport:{width:402,height:666}});
  try {
    await page.addInitScript(instrumentRenderer);
    await page.goto(`${origin}/index.html?boat=1&profile=1`);
    await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:90000});
    const reachable=async selector=>{
      const box=await page.locator(selector).evaluate(el=>{
        const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,hit:el===hit||el.contains(hit),obstruction:hit?.outerHTML.slice(0,250),controlsBottom:getComputedStyle(document.documentElement).getPropertyValue('--controls-bottom')};
      });
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.w<=box.vw+1&&box.y+box.h<=box.vh+1,`${selector} outside viewport: ${JSON.stringify(box)}`);
      assert.ok(box.w>=44&&box.h>=44,`${selector} needs a touch target`);
      assert.equal(box.hit,true,`${selector} is obstructed: ${JSON.stringify(box)}`);
    };
    assert.equal(await page.locator('#gpu-profile').getAttribute('open'),null,'phone profiler starts collapsed');
    for(const [width,height] of [[320,568],[402,666],[390,844],[844,390],[768,1024],[320,360]]) {
      await page.setViewportSize({width,height});
      for(const expanded of [false,true]) {
        const open=await page.locator('#gpu-profile').evaluate(el=>el.open);
        if(open!==expanded)await page.locator('#gpu-profile summary').click();
        // ResizeObserver places the panels after the disclosure/viewport layout.
        await page.waitForFunction(()=>{
          const css=getComputedStyle(document.documentElement);
          return Math.abs(parseFloat(css.getPropertyValue('--view-height'))-innerHeight)<1 &&
            Math.abs(parseFloat(css.getPropertyValue('--controls-bottom'))-document.querySelector('#camera-dock').getBoundingClientRect().bottom-8)<1;
        },undefined,{polling:20,timeout:2000});
        await page.locator('#boat-controls').evaluate(el=>el.scrollTop=el.scrollHeight);
        await reachable('#boat-panel .collapse');
        await page.getByRole('button',{name:'Toggle boat controls'}).click();
        assert.equal(await page.locator('#boat-controls').isVisible(),false);
        await reachable('#boat-panel .collapse');
        await page.getByRole('button',{name:'Toggle boat controls'}).click();
        await page.getByRole('button',{name:'Sea settings',exact:true}).click();
        assert.equal(await page.locator('#boat-panel').isVisible(),false,'mobile panels do not cover each other');
        await page.locator('#panel .panel-body').evaluate(el=>el.scrollTop=el.scrollHeight);
        await reachable('#panel .panel-header button');
        assert.equal(await page.locator('#panel .panel-body').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'settings have no horizontal overflow');
        await page.getByRole('button',{name:'Hide sea settings'}).click();
        assert.equal(await page.locator('#panel').isVisible(),false);
        assert.equal(await page.locator('#boat-panel').isVisible(),true);
        await page.getByRole('button',{name:'Captain',exact:true}).click();
        assert.equal(await page.locator('#boat-panel').isVisible(),false);
        assert.equal(await page.locator('#panel').isVisible(),false);
        await page.locator('#captain-panel .panel-body').evaluate(el=>el.scrollTop=el.scrollHeight);
        await reachable('#captain-panel .panel-header button');
        assert.equal(await page.locator('#captain-panel .panel-body').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
        await page.getByRole('button',{name:'Sea settings',exact:true}).click();
        assert.equal(await page.locator('#captain-panel').isVisible(),false);
        await page.getByRole('button',{name:'Hide sea settings'}).click();
      }
    }
    assert.deepEqual(await page.evaluate(()=>check.errors),[]);
  }finally{await page.close();}
});

test('resolution controls resize GPU targets and explicit dimensions stay fixed', {timeout:120000}, async()=>{
  const page=await browser.newPage({viewport:{width:320,height:360}});
  try {
    await page.addInitScript(instrumentRenderer);
    await page.goto(`${origin}/index.html?boat=1`);
    await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:90000});
    await page.getByRole('button',{name:'Sea settings',exact:true}).click();
    assert.equal(await page.getByLabel('Render resolution').inputValue(),'auto');
    for(const [mode,width,height] of [['0.5',160,180],['native',320,360],['0.75',240,270]]) {
      await page.getByLabel('Render resolution').selectOption(mode);
      await step(page);
      assert.deepEqual(await page.locator('#c').evaluate(el=>[el.width,el.height]),[width,height]);
      assert.deepEqual(await page.evaluate(()=>check.errors),[]);
    }
    await page.goto(`${origin}/index.html?boat=1&w=128&h=96`);
    await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:90000});
    assert.equal(await page.getByLabel('Render resolution').inputValue(),'fixed');
    assert.equal(await page.getByLabel('Render resolution').isDisabled(),true);
    await step(page);
    assert.deepEqual(await page.locator('#c').evaluate(el=>[el.width,el.height]),[128,96]);
    assert.deepEqual(await page.evaluate(()=>check.errors),[]);
  }finally{await page.close();}
});

test('crew renders twelve independent sailors in two batches, obeys captain orders and hides with the ship', {timeout:120000}, async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}}),warnings=[];
  page.on('pageerror',error=>warnings.push(error.message));
  page.on('console',msg=>{if(msg.type()==='warning'||msg.type()==='error')warnings.push(msg.text());});
  try{
    await page.addInitScript(instrumentRenderer);
    await page.addInitScript(()=>{
      const pipeline=GPURenderPassEncoder.prototype.setPipeline,draw=GPURenderPassEncoder.prototype.drawIndexed;
      GPURenderPassEncoder.prototype.setPipeline=function(p){this.crewLabel=p.label;return pipeline.call(this,p);};
      GPURenderPassEncoder.prototype.drawIndexed=function(n,instances,...rest){
        if(this.crewLabel==='crew')check.crewInstances=(check.crewInstances||[]).concat(instances);
        return draw.call(this,n,instances,...rest);
      };
      const write=GPUQueue.prototype.writeBuffer;
      GPUQueue.prototype.writeBuffer=function(buffer,offset,data,...rest){
        if(buffer.label==='crew joints')check.crewBones=Array.from(data);
        if(buffer.label==='crew transforms')check.crewActors=(check.crewActors||[]).concat(Array.from(data));
        return write.call(this,buffer,offset,data,...rest);
      };
    });
    await page.goto(`${origin}/?boat=1&boatSpeed=0&windSpeed=2&swellHs=.1&sunElev=45&w=64&h=48`);
    try{await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:30000});}
    catch(error){throw Error(error.message+'; '+warnings.join('\n'));}
    assert.equal(await page.getByLabel('Show crew',{exact:true}).isEnabled(),true);
    const first=await step(page,100);assert.equal(first.render.crew,1);assert.equal(first.render['crew shadow'],1);
    assert.deepEqual(await page.evaluate(()=>check.crewInstances),[6,6]);
    assert.equal(await page.locator('#boat-length').inputValue(), '20');
    assert.equal(await page.locator('#boat-beam').inputValue(), '6');
    assert.equal(await page.evaluate(()=>check.crewActors.filter((v,i)=>i%36===19&&v===1).length),0,'the helmsman below the quarterdeck remains visible');
    assert.equal(await page.evaluate(()=>check.crewActors.filter((v,i)=>i%36===23&&v===1).length),12,'near-camera transparency is enabled for every sailor');
    await page.getByRole('button',{name:'View ship',exact:true}).click();
    await page.evaluate(()=>check.crewActors=[]);await step(page,100);
    assert.equal(await page.evaluate(()=>check.crewActors.filter((v,i)=>i%36===19&&v===1).length),0,'exterior restores all twelve sailors');
    assert.equal(await page.evaluate(()=>check.crewActors.filter((v,i)=>i%36===23&&v===1).length),0,'exterior disables the camera fade');
    const bones=await page.evaluate(()=>check.crewBones);
    assert.equal(bones.length,6*65*16);assert.notDeepEqual(bones.slice(0,65*16),bones.slice(65*16,2*65*16));
    await step(page,100);assert.notDeepEqual(await page.evaluate(()=>check.crewBones),bones);
    assert.equal(await page.locator('#boat-panel #crew-order').count(),0);
    await page.getByRole('button',{name:'Captain',exact:true}).click();
    await page.getByRole('button',{name:'Prepare for heavy weather',exact:true}).click();
    await step(page,600);await step(page,600);assert.match(await page.locator('#crew-status').textContent(),/Prepare for heavy weather/);
    assert.equal(await page.locator('#crew-roster li').count(),12);
    await page.getByRole('button',{name:'Hide captain orders',exact:true}).click();
    await page.getByLabel('Show crew',{exact:true}).uncheck();
    const hidden=await step(page,100);assert.equal(hidden.render.crew,undefined);assert.equal(hidden.render['crew shadow'],undefined);
    await page.getByLabel('Show crew',{exact:true}).check();await page.getByLabel('Show ship',{exact:true}).uncheck();
    const shipHidden=await step(page,100);assert.equal(shipHidden.render.crew,undefined);assert.equal(shipHidden.render['crew shadow'],undefined);
    assert.deepEqual(warnings,[]);
  }finally{await page.close();}
});

test('crew face morphs keep the body fixed, bound facial displacement and preserve finite normals', {timeout:60000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__crew_faces',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__crew_faces`);
    const result=await page.evaluate(async()=>{
      const {CREW_SKIN}=await import('/js/wgsl/crew.js');
      const {createCompany,CREW_ACTOR_FLOATS}=await import('/js/crew.js');
      const {loadCrewGLB}=await import('/js/gltf.js');
      const device=await (await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const report=[];
      for(const sex of ['male','female']){
        const model=loadCrewGLB(await (await fetch(`/assets/crew/sailor${sex==='female'?'-female':''}.glb`)).arrayBuffer());
        const vertices=new Float32Array(model.vertices.buffer),count=model.vertexCount;
        const input=new Float32Array(count*8),people=createCompany().crew.filter(s=>s.sex===sex);
        people.push({id:'identity',face:[1,1,0,1]});
        const actors=new Float32Array(people.length*CREW_ACTOR_FLOATS);
        for(let i=0;i<count;i++){input.set(vertices.subarray(i*15,i*15+3),i*8);input.set(vertices.subarray(i*15+3,i*15+6),i*8+4);}
        for(let i=0;i<people.length;i++){actors[i*CREW_ACTOR_FLOATS+27]=Number(sex==='female');actors.set(people[i].face,i*CREW_ACTOR_FLOATS+32);}
        const module=device.createShaderModule({code:'struct Hull { unused:vec4f };'+CREW_SKIN+`
          @group(0) @binding(0) var<storage,read> vertices:array<vec4f>;
          @group(0) @binding(4) var<storage,read_write> result:array<vec4f>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
            let i=id.x;if(i>=${count*people.length}u){return;}
            let vertex=i%${count}u;
            let v=CrewInput(vertices[vertex*2u].xyz,vertices[vertex*2u+1u].xyz,vec3f(0),vec4u(0),vec4f(1,0,0,0),i/${count}u);
            let surface=crewSurface(v);result[i*2u]=vec4f(surface.position,1);result[i*2u+1u]=vec4f(surface.normal,0);
          }`});
        const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
        const points=buffer(input,GPUBufferUsage.STORAGE),cast=buffer(actors,GPUBufferUsage.STORAGE);
        const size=count*people.length*32,output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
        const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:points}},{binding:3,resource:{buffer:cast}},{binding:4,resource:{buffer:output}}]});
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count*people.length/64));pass.end();enc.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);const data=new Float32Array(read.getMappedRange());
        for(let actor=0;actor<people.length;actor++){
          let maxShift=0,bodyShift=0,normalError=0,finite=true;
          for(let i=0;i<count;i++){
            const at=(actor*count+i)*8,p=i*8;
            const shift=Math.hypot(data[at]-input[p],data[at+1]-input[p+1],data[at+2]-input[p+2]);
            maxShift=Math.max(maxShift,shift);
            if(input[p+1]<(sex==='female'?1.5646:1.6148))bodyShift=Math.max(bodyShift,shift);
            normalError=Math.max(normalError,Math.abs(Math.hypot(data[at+4],data[at+5],data[at+6])-1));
            for(let k=0;k<8;k++)finite=finite&&Number.isFinite(data[at+k]);
          }
          report.push({sex,id:people[actor].id,maxShift,bodyShift,normalError,finite});
        }
        read.unmap();for(const b of [points,cast,output,read])b.destroy();
      }
      device.destroy();return {report,errors};
    });
    assert.deepEqual(result.errors,[]);
    for(const s of result.report){
      assert.ok(s.finite,JSON.stringify(s));assert.ok(s.normalError<1e-5,JSON.stringify(s));
      assert.equal(s.bodyShift,0,JSON.stringify(s));assert.ok(s.maxShift<.025,JSON.stringify(s));
      if(s.id==='identity')assert.equal(s.maxShift,0);else assert.ok(s.maxShift>.001,JSON.stringify(s));
    }
  }finally{await page.close();}
});

for (const bundle of ['ocean.html', 'ocean.min.html', 'docs/index.html']) {
  test(`${bundle} initializes all JavaScript and WGSL pipelines`, { timeout: 120000 }, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.addInitScript(instrumentRenderer);
      await page.goto(`${origin}/${bundle}?w=1&h=1`);
      await page.waitForFunction(() => check.callback, undefined, { polling: 100, timeout: 90000 });
      assert.equal(await page.getByLabel('Show crew',{exact:true}).isEnabled(),true,'both embedded crew assets and pipelines initialize');
      assert.deepEqual(await page.evaluate(async () => {
        await check.device.queue.onSubmittedWorkDone();
        return check.errors;
      }), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test('surface moisture follows water, spray, moving sails and crew, then dries and resets', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__wet_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__wet_test`);
    const result=await page.evaluate(async()=>{
      const {createSurfaceWetness,createWetnessData}=await import('/js/wetness.js');
      const {HULL_VERTICAL_SCALE:S,hullDeck}=await import('/js/hull.js');
      const {SPRAY_COUNT,SHEET_COUNT}=await import('/js/wgsl/interaction.js');
      const {SPINDRIFT_COUNT}=await import('/js/wgsl/spindrift.js');
      const {SAIL_PLAN}=await import('/js/sailing.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(size,usage=B.STORAGE)=>device.createBuffer({size,usage:usage|B.COPY_DST});
      const shader=async(code,label)=>{
        const module=device.createShaderModule({code,label});
        const info=await module.getCompilationInfo();
        const errors=info.messages.filter(m=>m.type==='error');
        if(errors.length)throw Error(label+': '+errors.map(e=>e.message).join('\n'));
        return module;
      };
      const computePipe=async(code,label)=>device.createComputePipelineAsync({label,layout:'auto',compute:{module:await shader(code,label),entryPoint:'main'}});
      // One probe each: submerged exterior, dry deck, sheltered cabin, exposed
      // wood/rope/canvas at the same height, high dry rigging, actual moving sail.
      const plan=SAIL_PLAN[0],sail=[0,plan.top-plan.height+.28,plan.z-plan.belly*Math.sin(Math.PI*.88)];
      const positions=[[2,-.3,0,15],[0,hullDeck(0),0,0],[0,1.1,4,1],
        [2.1,3,0,10],[2.1,3,0,2],[2.1,3,0,9],[2,8,0,2],[...sail,9.0625]];
      const mesh=new Float32Array(positions.flatMap(([x,y,z,mat])=>[x,y,z,0,1,0,mat,.5,1]));
      const descriptors=createWetnessData(mesh);
      const hull=new Float32Array(36);hull[0]=1;hull[5]=1;hull[10]=-1;hull[12]=3.6;hull[13]=12;hull.set([1,1,1,1],24);hull.set([0,0,1,1],28);hull[35]=-1;
      const hullUBO=buffer(144,B.UNIFORM),frameUBO=buffer(512,B.UNIFORM),uniform=buffer(64,B.UNIFORM);
      device.queue.writeBuffer(hullUBO,0,hull);
      const sea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const deck=device.createTexture({size:[1,1],format:'rgba32float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const drops=buffer(SPRAY_COUNT*48),sheets=buffer(SHEET_COUNT*64),plumes=buffer(SPINDRIFT_COUNT*64);
      const wet=await createSurfaceWetness({device,mesh,hullUBO,frameUBO,computePipe});
      wet.connect({uniform,drops,sheets,deck:{view:deck.createView()}},{plumes},sea.createView({dimension:'2d-array'}),device.createSampler());
      const read=buffer(wet.probeCount*8,B.MAP_READ),control=new Float32Array(16);control[6]=.1;control[9]=1;
      const writeControl=()=>device.queue.writeBuffer(uniform,0,control);
      async function sample(frames=1){
        writeControl();const enc=device.createCommandEncoder(),cp=enc.beginComputePass();
        for(let i=0;i<frames;i++)wet.encode(cp);cp.end();
        enc.copyBufferToBuffer(wet.state,0,read,0,wet.probeCount*8);device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();
        return positions.map((_,i)=>values.slice(descriptors.lookup[i]*2,descriptors.lookup[i]*2+2)).concat([values.slice(wet.crewOffset*2,wet.crewOffset*2+8)]);
      }
      function drop(x,y,z){device.queue.writeBuffer(drops,0,new Float32Array([x,y,z,10,0,0,0,0,0,0,0,0]));}
      const dry=await sample(10);
      drop(2.1,3*S,0);const sprayed=await sample(30);
      device.queue.writeBuffer(drops,0,new Float32Array(12));const drained=await sample(50);
      // A covered tiller space is not wet just because an external wave is high.
      const seaBytes=new Uint16Array(6*4);seaBytes[1]=0x4400; // 4 m in cascade zero
      device.queue.writeTexture({texture:sea},seaBytes,{bytesPerRow:8,rowsPerImage:1},[1,1,6]);
      const highSea=await sample(10);
      device.queue.writeTexture({texture:deck},new Float32Array([.2,0,.9,0]),{bytesPerRow:16},[1,1]);
      const washed=await sample(10);
      device.queue.writeTexture({texture:sea},new Uint16Array(24),{bytesPerRow:8,rowsPerImage:1},[1,1,6]);
      device.queue.writeTexture({texture:deck},new Float32Array(4),{bytesPerRow:16},[1,1]);
      // Wet the deployed foot, then furl/brace it; moisture remains attached.
      drop(sail[0],sail[1]*S,sail[2]);const sailWet=await sample(40);
      hull[24]=0;hull[28]=.7;device.queue.writeBuffer(hullUBO,0,hull);
      device.queue.writeBuffer(drops,0,new Float32Array(12));const furled=await sample(1);
      wet.updateCrew({crew:[{position:[-2,3*S,0],scale:[1,1,1],visible:true}]},{beam:3.6,length:12});
      drop(-2,3*S+.08,0);const crewWet=await sample(40);
      wet.updateCrew({crew:[{position:[0,5*S,1],scale:[1,1,1],visible:true}]},{beam:3.6,length:12});
      device.queue.writeBuffer(drops,0,new Float32Array(12));const crewMoved=await sample(1);
      control[7]=1;const reset=await sample(1);control[7]=0;
      drop(2.1,3*S,0);await sample(5);control[9]=0;const disabled=await sample(1);
      control[9]=1;device.queue.writeBuffer(drops,0,new Float32Array(12));
      device.queue.writeBuffer(sheets,0,new Float32Array([2.1,3*S,0,.2,0,0,0,5,0,1,0,1,1,0,0,.5]));
      const sheetWet=await sample(30);
      control[7]=1;await sample();control[7]=0;device.queue.writeBuffer(sheets,0,new Float32Array(16));
      device.queue.writeBuffer(plumes,0,new Float32Array([2.1,3*S,0,0,0,0,0,5,1,0,0,.2,1,0,0,0]));
      const crestWet=await sample(30);
      wet.destroy();device.destroy();return {errors,dry,sprayed,drained,highSea,washed,sailWet,furled,crewWet,crewMoved,reset,disabled,sheetWet,crestWet};
    });
    assert.deepEqual(result.errors,[]);
    assert.ok(result.dry[0][0]>.8,'submerged exterior absorbs water');
    for(let i=1;i<8;i++)assert.deepEqual(result.dry[i],[0,0],'no spontaneous moisture on a dry surface');
    for(const i of [3,4,5])assert.ok(result.sprayed[i][0]>.1,'actual particle positions wet wood, rope and canvas');
    assert.deepEqual(result.sprayed[6],[0,0],'dry high rigging is not soaked by global wind');
    for(const i of [3,4,5]){
      assert.ok(result.drained[i][0]<result.sprayed[i][0]);
      assert.ok(result.drained[i][0]>result.sprayed[i][0]*.9,'absorbed moisture persists');
      assert.ok(result.drained[i][1]<result.sprayed[i][1]*.5,'surface film drains faster');
    }
    const retention=i=>result.drained[i][0]/result.sprayed[i][0];
    assert.ok(retention(4)>retention(3)&&retention(3)>retention(5),'rope dries slower than timber, canvas faster');
    assert.equal(result.highSea[1][0],0,'external sea cannot wet sheltered deck through the hull');
    assert.equal(result.highSea[2][0],0,'quarterdeck protects the cabin');
    assert.ok(result.washed[1][0]>.8,'retained deck wash wets planks');
    assert.ok(result.sailWet[7][0]>.1,'deployed sail catches local spray');
    assert.ok(result.furled[7][0]>result.sailWet[7][0]*.99,'furling retains wetness');
    assert.ok(result.crewWet[8][0]>.1 && result.crewWet[8][6]===0,'boots can get wet without the head');
    assert.ok(result.crewMoved[8][0]>result.crewWet[8][0]*.99,'crew carry damp clothes when moving');
    assert.ok(result.reset.flat().every(v=>v===0));assert.ok(result.disabled.flat().every(v=>v===0));
    assert.ok(result.sheetWet[3][0]>.1,'impact sheet lips deposit moisture');
    assert.ok(result.crestWet[3][0]>.03,'wind-blown crest plumes deposit moisture');
  }finally{await page.close();}
});

test('wet materials visibly shade the ship and crew and return to their dry appearance', {timeout:120000}, async()=>{
  const page=await browser.newPage({viewport:{width:128,height:96}});
  try{
    await page.addInitScript(instrumentRenderer);
    await page.addInitScript(()=>{
      const request=GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await request.apply(this,args),create=device.createBuffer.bind(device);
        device.createBuffer=desc=>{const b=create(desc);if(desc.label==='surface moisture')check.moisture=b;return b;};
        return device;
      };
      const write=GPUQueue.prototype.writeBuffer;
      GPUQueue.prototype.writeBuffer=function(buffer,...args){
        if(!check.freezeScene || buffer.label==='surface moisture')return write.call(this,buffer,...args);
      };
      const labels=new WeakMap(),set=GPUComputePassEncoder.prototype.setPipeline,dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
      GPUComputePassEncoder.prototype.setPipeline=function(p){labels.set(this,p.label);return set.call(this,p);};
      GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...args){if(!check.freezeScene && labels.get(this)!=='surface moisture')return dispatch.apply(this,args);};
    });
    await page.goto(`${origin}/?view=ship&boatSpeed=0&sunElev=35&clouds=0&windSpeed=2&swellHs=.1&w=128&h=96`);
    await page.waitForFunction(()=>check.callback,undefined,{polling:100,timeout:30000});
    const render=()=>page.evaluate(async()=>{check.callback(1000);await check.device.queue.onSubmittedWorkDone();});
    await render();
    const capture=()=>page.evaluate(async()=>{
      const texture=check.target,bytesPerRow=Math.ceil(texture.width*4/256)*256;
      const read=check.device.createBuffer({size:bytesPerRow*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const enc=check.device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:read,bytesPerRow},[texture.width,texture.height]);
      check.device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Uint8Array(read.getMappedRange()));read.unmap();read.destroy();return values;
    });
    // Freeze asynchronous buoyancy readbacks, rotating environment updates and
    // uniforms too; equal timestamps alone do not freeze the rendered scene.
    await page.evaluate(()=>check.freezeScene=true);
    await render();const dry=await capture();
    await page.evaluate(()=>check.device.queue.writeBuffer(check.moisture,0,new Float32Array(check.moisture.size/4).fill(1)));
    await render();const wet=await capture();
    await page.evaluate(()=>check.device.queue.writeBuffer(check.moisture,0,new Float32Array(check.moisture.size/4)));
    await render();const restored=await capture();
    const rms=(a,b)=>Math.sqrt(a.reduce((sum,x,i)=>sum+(x-b[i])**2,0)/a.length);
    assert.ok(rms(dry,wet)>1,'material state changes visible shading');
    assert.ok(rms(dry,restored)<rms(dry,wet)*.05,`dry state restores material response: restored ${rms(dry,restored)}, wet ${rms(dry,wet)}`);
    assert.deepEqual(await page.evaluate(()=>check.errors),[]);
  }finally{await page.close();}
});

test('loaded canvas steadies, slack canvas luffs, and cloth contacts stay bounded and sewn ropes stay attached', {timeout:120000}, async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__cloth_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__cloth_test`);
    const result=await page.evaluate(async()=>{
      const {VESSEL_RIG,RIG_OBSTACLES}=await import('/js/wgsl/vessel.js');
      const {createCaravelMesh}=await import('/js/caravel.js');
      const raw=createCaravelMesh(),points=[];
      for(let i=0;i<raw.length;i+=27)if([9,13,19].includes(Math.floor(raw[i+6])))points.push(...raw.subarray(i,i+27));
      const n=points.length/9,device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,buffer=(size,usage)=>device.createBuffer({size,usage});
      const hull=buffer(144,B.UNIFORM|B.COPY_DST),input=buffer(points.length*4,B.STORAGE|B.COPY_DST);
      const bytes=(n+RIG_OBSTACLES.length)*32;
      const output=buffer(bytes,B.STORAGE|B.COPY_SRC),read=buffer(bytes,B.MAP_READ|B.COPY_DST);
      device.queue.writeBuffer(input,0,new Float32Array(points));
      const module=device.createShaderModule({code:VESSEL_RIG+`
        @group(0) @binding(0) var<uniform> hull:Hull;
        @group(0) @binding(1) var<storage,read> points:array<f32>;
        @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
          let i=gid.x*9u;if(i+8u>=arrayLength(&points)){return;}
          let p=vec3f(points[i],points[i+1u],points[i+2u]);let material=points[i+6u];let uv=vec2f(points[i+7u],points[i+8u]);
          let v=rigVertex(p,vec3f(points[i+3u],points[i+4u],points[i+5u]),material,uv);
          result[gid.x*2u]=vec4f(v.position,1);
          let id=u32(round(fract(material)*16.0));
          var centre=sailBasePoint(p,uv,id,u32(material),false);
          if(u32(material)==19u){centre=sailPoint(sailRestPoint(id,uv),uv,id,select(9u,13u,id==3u),false);}
          result[gid.x*2u+1u]=vec4f(centre,1);
          if(gid.x<${RIG_OBSTACLES.length}u){
            let line=rigObstacles[gid.x];let other=u32(line.motion.x);var a=line.a.xyz;var b=line.b.xyz;
            if(other>0u){a=sailBasePoint(a,vec2f(0,line.motion.y),other,12u,true);b=sailBasePoint(b,vec2f(0,line.motion.z),other,12u,true);}
            result[(${n}u+gid.x)*2u]=vec4f(a,1);result[(${n}u+gid.x)*2u+1u]=vec4f(b,1);
          }
        }
        @compute @workgroup_size(64) fn mask(@builtin(global_invocation_id) gid:vec3u){
          let i=gid.x*9u;if(i+2u>=arrayLength(&points)){return;}
          result[gid.x*2u]=vec4f(select(0.0,1.0,rigInsideCanvas(vec3f(points[i],points[i+1u],points[i+2u]))),0,0,0);
        }`});
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const maskPipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'mask'}});
      const maskGroup=device.createBindGroup({layout:maskPipe.getBindGroupLayout(0),entries:[hull,input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[hull,input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const h=new Float32Array(36);h[12]=6;h[13]=20;h[34]=12;h[35]=1;
      const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sub=(a,b)=>a.map((x,i)=>x-b[i]),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
      function hit(a,b,c,line){
        const e1=sub(b,a),e2=sub(c,a),dir=sub(line.b,line.a),p=cross(dir,e2),det=dot(e1,p);
        if(Math.abs(det)<1e-8)return false;
        const t=sub(line.a,a),u=dot(t,p)/det;if(u<1e-5||u>1-1e-5)return false;
        const q=cross(t,e1),v=dot(dir,q)/det;if(v<1e-5||u+v>1-1e-5)return false;
        const distance=dot(e2,q)/det;return distance>.001&&distance<.999?line.a.map((x,i)=>x+distance*dir[i]):null;
      }
      const captures=[],collisions=[],sewn=[],deflections=[];
      for(const [fill,yaw,time,set,tack=1] of [[1,0,0,1],[1,0,.2,1],[0,0,0,1],[0,0,.2,1],[1,.6,1,1],[1,-.6,1,1],[.6,.6,1,.5],[0,0,1,0],[1,0,0,1,-1],[1,.6,2,1,-1],[0,-.6,2,1,-1],[1,1.047,1,1],[1,-1.047,1,1]]){
        h[35]=tack;h.set([set,set,set],24);h[28]=yaw;h[29]=-yaw;h[30]=h[31]=fill;h[19]=time;device.queue.writeBuffer(hull,0,h);
        const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipe);cp.setBindGroup(0,group);cp.dispatchWorkgroups(Math.ceil(n/64));cp.end();enc.copyBufferToBuffer(output,0,read,0,bytes);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=new Float32Array(read.getMappedRange()).slice();read.unmap();captures.push(values);
        const hits={},contacts=[];let ropeError=0,deflection=0;
        const lines=RIG_OBSTACLES.map((line,j)=>({...line,a:Array.from(values.subarray((n+j)*8,(n+j)*8+3)),b:Array.from(values.subarray((n+j)*8+4,(n+j)*8+7))}));
        for(let i=0;i<n;i++){
          const base=Math.floor(points[i*9+6]);
          if(base===19){const distance=Math.hypot(values[i*8]-values[i*8+4],values[i*8+1]-values[i*8+5],values[i*8+2]-values[i*8+6]);ropeError=Math.max(ropeError,Math.max(0,distance-.01501));}
          if(base!==19)deflection=Math.max(deflection,Math.hypot(...[0,1,2].map(k=>values[i*8+k]-values[i*8+4+k])));
          if(base===19||i%3)continue;
          const tri=[0,1,2].map(j=>Array.from(values.subarray((i+j)*8,(i+j)*8+3)));
          for(const [j,line] of lines.entries()){const point=hit(...tri,line);if(point)contacts.push({point,j});}
        }
        contacts.push({point:[0,-1,0],j:-1},{point:[8,8,8],j:-1});
        if(contacts.length){
          const probes=new Float32Array(contacts.length*9);contacts.forEach(({point},i)=>probes.set(point,i*9));device.queue.writeBuffer(input,0,probes);
          const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(maskPipe);cp.setBindGroup(0,maskGroup);cp.dispatchWorkgroups(Math.ceil(contacts.length/64));cp.end();enc.copyBufferToBuffer(output,0,read,0,bytes);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
          const masks=new Float32Array(read.getMappedRange());contacts.forEach(({j},i)=>{if(j===-1?masks[i*8]>.5:(j>=43||masks[i*8]<.5))hits[j]=(hits[j]??0)+1;});read.unmap();device.queue.writeBuffer(input,0,new Float32Array(points));
        }
        collisions.push(hits);sewn.push(ropeError);deflections.push(deflection);
      }
      const movement=(a,b)=>{
        let max=0;for(let i=0;i<n;i++)if(Math.floor(points[i*9+6])!==19)max=Math.max(max,Math.hypot(...[0,1,2].map(k=>captures[a][i*8+k]-captures[b][i*8+k])));return max;
      };
      const loaded=movement(0,1),slack=movement(2,3);device.destroy();return {errors,loaded,slack,collisions,sewn,deflections};
    });
    assert.deepEqual(result.errors,[]);
    assert.ok(result.loaded<.01,`loaded motion ${result.loaded}`);assert.ok(result.slack>.05,`slack motion ${result.slack}`);
    assert.ok(result.sewn.every(e=>e<1e-5),`bolt-rope attachment error: ${result.sewn}`);
    assert.ok(result.deflections.every(d=>d<=.06001),`contact cannot stretch cloth into spikes: ${result.deflections}`);
    assert.deepEqual(result.collisions,result.collisions.map(()=>({})),'rope crossings must be masked; masts must clear canvas');
  }finally{await page.close();}
});
