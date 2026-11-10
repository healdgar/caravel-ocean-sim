// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every captain wears one painted body. The shader lays each captain's own skin, hair and coat over the painting from
// what the crew already sends for that person: the real shader function, run on the GPU in a headless page over paint
// taken from the painting, for three captains.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

// The painting's own colours, linear, as its texels average them.
const PAINT = { flesh: [0.454, 0.147, 0.070], shade: [0.299, 0.088, 0.039], hair: [0.046, 0.029, 0.018], navy: [0.013, 0.014, 0.018], maroon: [0.053, 0.011, 0.008], gold: [0.372, 0.272, 0.135], cream: [0.603, 0.485, 0.370], boot: [0.019, 0.014, 0.010] };
// Where on the body, in its rest pose, and whether the mesh marks the place as skin.
const PLACES = {
  cheek: { paint: PAINT.flesh, at: [0.03, 1.66, 0.09], skin: 1 },
  hand: { paint: PAINT.shade, at: [0.85, 1.42, 0.02], skin: 1 },
  crown: { paint: PAINT.hair, at: [0.02, 1.79, 0.0], skin: 0 },
  beard: { paint: PAINT.hair, at: [0.02, 1.55, 0.09], skin: 0 },
  coat: { paint: PAINT.navy, at: [0.12, 1.2, 0.1], skin: 0 },
  waistcoat: { paint: PAINT.maroon, at: [0.05, 1.1, 0.12], skin: 0 },
  trim: { paint: PAINT.gold, at: [0.12, 1.2, 0.1], skin: 0 },
  collar: { paint: PAINT.cream, at: [0.12, 1.5, 0.1], skin: 0 },
  boot: { paint: PAINT.boot, at: [0.1, 0.2, 0.0], skin: 0 },
};
// Skin, hair and shirt as the crew sends them; the whole part of skin.w is 2 for a woman in the captain's body.
const CAPTAINS = {
  ines: { skin: [0.209, 0.078, 0.040, 2.0], hair: [0.012, 0.007, 0.006], shirt: [0.55, 0.47, 0.31] },
  charlotte: { skin: [0.701, 0.381, 0.188, 2.21], hair: [0.008, 0.007, 0.007], shirt: [0.28, 0.30, 0.33] },
  rui: { skin: [0.716, 0.381, 0.231, 0.0], hair: [0.275, 0.037, 0.007], shirt: [0.045, 0.042, 0.040] },
};

test('each captain wears the painted body in their own skin, hair and coat', { timeout: 120000 }, async () => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const args = process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args });
    const page = await browser.newPage();
    await page.route('**/__captain-colours', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__captain-colours`);
    const result = await page.evaluate(async ({ places, captains }) => {
      const { CAPTAIN_OWN_COLOURS } = await import('/js/wgsl/crew.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);
      const cases = [];
      for (const [who, c] of Object.entries(captains)) for (const [where, place] of Object.entries(places)) cases.push({ who, where, data: [...place.paint, place.skin, ...place.at, 0, ...c.skin, ...c.hair, 0, ...c.shirt, 0] });
      const input = new Float32Array(cases.flatMap((c) => c.data));
      const code = CAPTAIN_OWN_COLOURS + `
struct Case { paint:vec4f, at:vec4f, skin:vec4f, hair:vec4f, shirt:vec4f };
@group(0) @binding(0) var<storage,read> cases:array<Case>;
@group(0) @binding(1) var<storage,read_write> worn:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let c=cases[id.x];
  worn[id.x]=vec4f(captainOwnColours(c.paint.rgb,c.at.xyz,c.paint.w,c.skin,c.hair.rgb,c.shirt.rgb),1.0);
}`;
      const module = device.createShaderModule({ code }), bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
      if (bad.length) return { errors: bad.map((m) => m.message) };
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const inBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(inBuf, 0, input);
      const outBuf = device.createBuffer({ size: cases.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const read = device.createBuffer({ size: cases.length * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] }));
      pass.dispatchWorkgroups(cases.length);
      pass.end();
      encoder.copyBufferToBuffer(outBuf, 0, read, 0, cases.length * 16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      const worn = {};
      cases.forEach((c, i) => { (worn[c.who] ??= {})[c.where] = [...out.subarray(i * 4, i * 4 + 3)]; });
      return { errors, worn };
    }, { places: PLACES, captains: CAPTAINS });
    assert.deepEqual(result.errors, []);
    const near = (got, want, slack, what) => got.forEach((v, k) => assert.ok(Math.abs(v - want[k]) <= slack * Math.max(want[k], 0.004), `${what}: ${got.map((x) => x.toFixed(4))} against ${want.map((x) => x.toFixed(4))}`));
    const scaled = (c, by) => c.slice(0, 3).map((v) => v * by);
    for (const [who, own] of Object.entries(CAPTAINS)) {
      const worn = result.worn[who], woman = own.skin[3] >= 1.5;
      // Lit flesh is a little brighter than the painting's middle skin and its shade a little darker, in the captain's own skin.
      near(worn.cheek, scaled(own.skin, 1.16), 0.12, `${who}'s cheek is their own skin`);
      near(worn.hand, scaled(own.skin, 0.72), 0.12, `${who}'s hand in shade is their own skin`);
      near(worn.crown, scaled(own.hair, 1), 0.06, `${who}'s hair is their own`);
      near(worn.coat, scaled(own.shirt, 0.3), 0.06, `${who}'s coat is their shirt's colour, deeper`);
      near(worn.beard, woman ? scaled(own.skin, 0.9) : scaled(own.hair, 1), 0.06, woman ? `${who}'s beard is painted out in her skin` : `${who}'s beard is his own hair`);
      // What is nobody's own stays as it was painted.
      for (const [where, paint] of [['waistcoat', PAINT.maroon], ['trim', PAINT.gold], ['collar', PAINT.cream], ['boot', PAINT.boot]]) near(worn[where], paint, 0.001, `${who}'s ${where} is left as painted`);
    }
    const apart = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
    assert.ok(apart(result.worn.ines.cheek, result.worn.charlotte.cheek) > 0.3, 'two captains are told apart by their skin');
    assert.ok(apart(result.worn.ines.coat, result.worn.rui.coat) > 0.1, 'and by their coats');
  } finally {
    await browser?.close();
    server.close();
  }
});
