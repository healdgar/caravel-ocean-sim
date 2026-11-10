// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The vessel fragment shader decides a fragment's finish with a few small rules. These tests
// put questions to the production rules on the GPU, and count what the shader samples.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { CARAVEL, CARAVEL_DAMAGED } from '../js/wgsl/caravel.js';
import { vesselDeck } from '../js/hull.js';
import { LATER_SAIL_DESIGNS } from '../js/models/later-sail.js';

function functionBody(source, name) {
  const start = source.indexOf('fn ' + name + '(');
  assert.ok(start >= 0, name + ' is defined');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error('unterminated ' + name);
}
const occurrences = (text, needle) => text.split(needle).length - 1;

test('a vessel fragment reads the sea height once: three cascade samples, where it took nine or twelve', () => {
  for (const [label, source] of [['whole', CARAVEL], ['damaged', CARAVEL_DAMAGED]]) {
    const ocean = functionBody(source, 'oceanHeight');
    const cascades = Number(/for \(var c = 0u; c < (\d+)u; c\+\+\)/.exec(ocean)?.[1]);
    const perCall = cascades * occurrences(ocean, 'textureSampleLevel(');
    assert.equal(perCall, 3, 'one sample for each displacement cascade');
    const calls = occurrences(source, 'oceanHeight(') - 1;
    assert.equal(calls, 1, label + ' shader calls oceanHeight once; every water reflection reuses that height');
    assert.equal(occurrences(functionBody(source, 'waterLight'), 'oceanHeight('), 0, 'waterLight is handed the height');
    // The call stands in the fragment stage, outside every loop, behind the capture test.
    const guarded = /if\(!vesselWaterCapture \|\| F\.screen\.x < 0\.0\) \{ oceanY = oceanHeight\(in\.world\.xz\); \}/.test(source);
    assert.ok(guarded, 'the underwater capture samples no ocean height at all');
    assert.equal(perCall * calls, 3);
  }
});

test('finish rules: spars by material, hoops that fade at range, a dry inboard face, and cloths that belly between seams', { timeout: 120000 }, async () => {
  const flyingCloud = LATER_SAIL_DESIGNS['flying-cloud'].modelCode;
  const probes = [];
  const ask = (name, kind, material, model, p, n, expected) => probes.push({ name, kind, material, model, p, n, expected });
  // kind 0: vesselMastSpar(material, model, p)
  const bowspritFoot = [0, vesselDeck(-4.8) + 0.12, -4.8], bowspritTip = [0, 2.05, -8.4];
  const along = (t) => bowspritFoot.map((v, i) => v + (bowspritTip[i] - v) * t);
  for (const model of [0, 1, 2, 5, flyingCloud]) ask('spar material is a spar on model ' + model, 0, 10, model, [1.4, 3, 2], [0, 0, 0], 1);
  ask('Niña binnacle trim on the centreline is not a mast', 0, 1, 0, [0, 1.6, 3.2], [0, 0, 0], 0);
  ask('Niña cabin lintel on the centreline is not a mast', 0, 1, 0, [0.1, 2.2, 4.4], [0, 0, 0], 0);
  ask('Victory stair rail on the centreline is not a mast', 0, 1, 1, [0.05, 2.4, 1.0], [0, 0, 0], 0);
  ask('Pinta bitts on the centreline are not a mast', 0, 1, 2, [0, 1.2, -2.0], [0, 0, 0], 0);
  ask('Niña bowsprit, built as trim, is a spar at its foot', 0, 1, 0, along(0.05), [0, 0, 0], 1);
  ask('Niña bowsprit is a spar at its middle', 0, 1, 0, along(0.5), [0, 0, 0], 1);
  ask('Niña bowsprit surface near the tip', 0, 1, 0, along(0.95).map((v, i) => v + (i === 0 ? 0.045 : 0)), [0, 0, 0], 1);
  ask('trim beside the Niña bowsprit is not a spar', 0, 1, 0, along(0.5).map((v, i) => v + (i === 0 ? 0.22 : 0)), [0, 0, 0], 0);
  ask('Flying Cloud mast, built as trim, is still a spar', 0, 1, flyingCloud, [0.1, 5, 0.3], [0, 0, 0], 1);
  ask('Flying Cloud rail trim off the centreline is not', 0, 1, flyingCloud, [1.2, 5, 0.3], [0, 0, 0], 0);
  ask('deck planking is never a spar', 0, 0, flyingCloud, [0, 1, 0], [0, 0, 0], 0);
  // kind 1: mastHoopBand(material, model, height, footprint); p = (height, footprint, -, -)
  const band = 0.5 / 1.35 + 2 / 1.35; // a height whose fract(height*1.35) is one half
  ask('a hoop is solid on its band up close', 1, 1, flyingCloud, [band, 0.0005, 0], [0, 0, 0], 1);
  ask('and absent between bands', 1, 1, flyingCloud, [band + 0.25 / 1.35, 0.0005, 0], [0, 0, 0], 0);
  ask('a hoop a pixel wide is partly covered, not aliased', 1, 1, flyingCloud, [band, 0.1, 0], [0, 0, 0], 'partial');
  ask('at range, where a pixel spans half a period, the hoops are gone', 1, 1, flyingCloud, [band, 0.5, 0], [0, 0, 0], 0);
  ask('no painted hoops on a mast that models its own', 1, 10, 0, [band, 0.0005, 0], [0, 0, 0], 0);
  ask('no painted hoops on Victory trim', 1, 1, 1, [band, 0.0005, 0], [0, 0, 0], 0);
  ask('no painted hoops on Niña trim', 1, 1, 0, [band, 0.0005, 0], [0, 0, 0], 0);
  // kind 2: hullExteriorFace(p, normal)
  ask('starboard planking facing outboard meets the sea', 2, 0, 0, [2.1, 0.1, 0.5], [0.97, -0.2, 0.05], 1);
  ask('port planking facing outboard meets the sea', 2, 0, 0, [-2.1, 0.1, 0.5], [-0.97, -0.2, 0.05], 1);
  ask('the inboard face of the starboard planking stays dry', 2, 0, 0, [2.0, 0.1, 0.5], [-0.97, 0.2, 0], 0);
  ask('the inboard face of the port planking stays dry', 2, 0, 0, [-2.0, 0.1, 0.5], [0.97, 0.2, 0], 0);
  ask('a deck or floor board stays dry', 2, 0, 0, [1.0, 0.05, 0.5], [0, 1, 0], 0);
  ask('the end of a thwart amidships stays dry', 2, 0, 0, [0.9, 0.2, 1.0], [0, 0, 1], 0);
  ask('the transom meets the sea', 2, 0, 0, [0.9, 0.2, 6.2], [0, 0.1, 0.99], 1);
  ask('the bow planking meets the sea', 2, 0, 0, [-0.4, 0.2, -6.0], [-0.5, 0, -0.86], 1);
  ask('the keel line itself has no waterline', 2, 0, 0, [0.05, -0.5, 0], [1, 0, 0], 0);
  // kind 3: (sailClothSeam(u), sailPanelPillow(u)); p.x = u
  for (let cloth = 0; cloth < 10; cloth++) {
    ask('seam of cloth ' + cloth, 3, 0, 0, [(cloth + 0.5) / 10, 0, 0], [0, 0, 0], 'seam');
    ask('middle of cloth ' + cloth, 3, 0, 0, [(cloth + 1) / 10 - 1e-4, 0, 0], [0, 0, 0], 'belly');
  }

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
    await page.route('**/__vessel-finish-gpu', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__vessel-finish-gpu`);
    const result = await page.evaluate(async (questions) => {
      const { VESSEL_FINISH_RULES } = await import('/js/wgsl/caravel.js');
      const device = await (await navigator.gpu.requestAdapter()).requestDevice();
      const errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const B = GPUBufferUsage, count = questions.length, data = new Float32Array(count * 12);
      for (const [i, q] of questions.entries()) data.set([q.kind, q.material, q.model, 0, ...q.p, 0, ...q.n, 0], i * 12);
      const input = device.createBuffer({ size: data.byteLength, usage: B.STORAGE | B.COPY_DST });
      device.queue.writeBuffer(input, 0, data);
      const output = device.createBuffer({ size: count * 16, usage: B.STORAGE | B.COPY_SRC });
      const read = device.createBuffer({ size: count * 16, usage: B.COPY_DST | B.MAP_READ });
      const module = device.createShaderModule({
        label: 'vessel finish rules',
        code:
          VESSEL_FINISH_RULES +
          `
struct Question {head:vec4f,p:vec4f,n:vec4f};
@group(0)@binding(0)var<storage,read>questions:array<Question>;
@group(0)@binding(1)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
  if(i.x>=arrayLength(&questions)){return;}
  let q=questions[i.x];let kind=u32(q.head.x);let material=u32(q.head.y);
  var a=vec4f(0.0);
  if(kind==0u){a.x=select(0.0,1.0,vesselMastSpar(material,q.head.z,q.p.xyz));}
  else if(kind==1u){a.x=mastHoopBand(material,q.head.z,q.p.x,q.p.y);}
  else if(kind==2u){a.x=select(0.0,1.0,hullExteriorFace(q.p.xyz,q.n.xyz));}
  else{a=vec4f(sailClothSeam(q.p.x),sailPanelPillow(q.p.x),0.0,0.0);}
  answers[i.x]=a;
}`,
      });
      const info = await module.getCompilationInfo();
      errors.push(...info.messages.filter((m) => m.type === 'error').map((m) => m.message));
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, count * 16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const answers = Array.from(new Float32Array(read.getMappedRange()));
      read.unmap();
      for (const b of [input, output, read]) b.destroy();
      await device.queue.onSubmittedWorkDone();
      return { errors, answers };
    }, probes);
    assert.deepEqual(result.errors, []);
    for (const [i, q] of probes.entries()) {
      const [x, y] = result.answers.slice(i * 4, i * 4 + 2);
      if (q.expected === 'partial') assert.ok(x > 0.2 && x < 0.9, `${q.name}: ${x}`);
      else if (q.expected === 'seam') {
        assert.ok(x < 1e-4, `${q.name}: seam distance ${x}`);
        assert.ok(Math.abs(y) < 1e-3, `${q.name}: the cloth lies flat on its stitching, pillow ${y}`);
      } else if (q.expected === 'belly') {
        assert.ok(Math.abs(x - 0.5) < 1e-2, `${q.name}: farthest from a seam, ${x}`);
        assert.ok(y > 0.999, `${q.name}: the cloth bellies most midway, pillow ${y}`);
      } else assert.ok(Math.abs(x - q.expected) < 1e-4, `${q.name}: expected ${q.expected}, got ${x}`);
    }
  } finally {
    await browser?.close();
    server.close();
  }
});
