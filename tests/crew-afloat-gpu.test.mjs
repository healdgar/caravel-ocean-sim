// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Men in the water are posed by the clip pass from loops baked once: the real pass on the real sailor rig, in a
// headless page, read back from the GPU and held against the pose JavaScript would have solved.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

test('the clip pass swims the living and floats the dead as the solved pose would, and leaves the rest alone', { timeout: 120000 }, async () => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const args = process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args });
    const page = await browser.newPage();
    await page.route('**/__crew-afloat', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__crew-afloat`);
    const result = await page.evaluate(async () => {
      const { loadCrewGLB } = await import('/js/gltf.js');
      const { createCrewClipBatch, createCrewClipPipeline } = await import('/js/crew-clip-pose.js');
      const { poseCrewWork, crewAfloatSeconds } = await import('/js/crew-pose.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);
      const model = loadCrewGLB(await (await fetch('/assets/crew/sailor.glb')).arrayBuffer()), a = model.animator;
      const people = 5, J = 65 * 16, marker = new Float32Array(people * J).fill(7);
      const joints = device.createBuffer({ size: marker.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      device.queue.writeBuffer(joints, 0, marker);
      const shader = async (code, label) => { const module = device.createShaderModule({ code, label }), bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(bad.map((m) => m.message).join()); return module; };
      const pipeline = await createCrewClipPipeline(device, shader), batch = createCrewClipBatch(device, pipeline, model, joints, people);
      // A swimmer, a body afloat, a walker far off, a second swimmer elsewhere in his stroke, and one left alone.
      const swimmer = (time, crewIndex, alive) => ({ casualtyState: 'fallen', overboard: { inWater: true, alive }, time, crewIndex, position: [0, 0, 0], scale: [1, 1, 1], yaw: 0 });
      const cast = [swimmer(3.21, 2, true), swimmer(40.7, 5, false), null, swimmer(13.0, 7, true), null];
      batch.begin(people);
      const took = [batch.loop(0, 'Swim', crewAfloatSeconds(cast[0])), batch.loop(1, 'Float', crewAfloatSeconds(cast[1])), batch.loop(3, 'Swim', crewAfloatSeconds(cast[3])), batch.loop(4, 'Dance', 1)];
      batch.set(2, 0.8, 0.3, 1);
      batch.off(4);
      batch.upload();
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      batch.encode(pass);
      pass.end();
      const read = device.createBuffer({ size: marker.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyBufferToBuffer(joints, 0, read, 0, marker.byteLength);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(read.getMappedRange().slice(0));
      read.unmap(); read.destroy();
      // Where a palette puts a joint: it maps the bind pose, so it is applied to the joint's place at rest.
      const names = ['pelvis', 'Head', 'hand_l', 'hand_r', 'foot_l', 'foot_r'];
      a.sample(null, 0);
      const rest = new Map(names.map((name) => [name, [...a.world[a.nodeIndex(name)].slice(12, 15)]]));
      const place = (palette, name) => {
        const at = a.joints.indexOf(a.nodeIndex(name)) * 16, [x, y, z] = rest.get(name);
        return [0, 1, 2].map((k) => palette[at + k] * x + palette[at + 4 + k] * y + palette[at + 8 + k] * z + palette[at + 12 + k]);
      };
      const body = (i) => out.subarray(i * J, (i + 1) * J);
      const rows = { errors, took, untouched: body(4).every((v) => v === 7), people: {} };
      for (const i of [0, 1, 3]) {
        a.sample('Idle', 0);
        poseCrewWork(a, cast[i], null);
        const solved = a.palette.slice();
        rows.people[i] = Object.fromEntries(names.map((name) => [name, Math.hypot(...place(solved, name).map((v, k) => v - place(body(i), name)[k]))]));
        rows.people[i].headHeight = place(body(i), 'Head')[1];
      }
      a.sample('Walk', 0.3);
      rows.walker = Object.fromEntries(names.map((name) => [name, Math.hypot(...place(a.palette, name).map((v, k) => v - place(body(2), name)[k]))]));
      rows.apart = Math.hypot(...place(body(0), 'hand_l').map((v, k) => v - place(body(3), 'hand_l')[k]));
      batch.destroy(); joints.destroy();
      return rows;
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.took, [true, true, true, false], 'the loops this model has, and not one it has not');
    assert.equal(result.untouched, true, 'a body left off keeps the joints something else wrote');
    // Baked at ten frames a second and five, and shown between frames, so within a centimetre or two of the solved pose.
    for (const [i, row] of Object.entries(result.people)) for (const name of ['pelvis', 'Head', 'hand_l', 'hand_r', 'foot_l', 'foot_r']) {
      assert.ok(row[name] < 0.025, `body ${i} ${name} is where the solved pose has it: ${row[name]}`);
    }
    for (const [name, off] of Object.entries(result.walker)) assert.ok(off < 0.03, `the walker's ${name} still comes from his standing and walking clips: ${off}`);
    assert.ok(result.apart > 0.03, `two swimmers are not in step: ${result.apart}`);
    assert.ok(result.people[0].headHeight < 0.9, `a swimmer is down in the water to his shoulders: ${result.people[0].headHeight}`);
  } finally {
    await browser?.close();
    server.close();
  }
});
