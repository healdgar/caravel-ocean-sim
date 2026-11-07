// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A body turned to go by someone: the real pass on the real sailor rig, in a headless page, read back from the GPU.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

test('the shoulder turn moves what is above the hips, leaves the legs on their line, and costs nothing while square', { timeout: 120000 }, async () => {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const args = process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args });
    const page = await browser.newPage();
    await page.route('**/__crew-turn', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__crew-turn`);
    const result = await page.evaluate(async () => {
      const { loadCrewGLB } = await import('/js/gltf.js');
      const { createCrewTurnBatch, createCrewTurnPipeline } = await import('/js/crew-clip-pose.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);
      const model = loadCrewGLB(await (await fetch('/assets/crew/sailor.glb')).arrayBuffer()), a = model.animator;
      a.sample('Walk', 0.4);
      const people = 3, palette = new Float32Array(people * 65 * 16);
      for (let i = 0; i < people; i++) palette.set(a.palette, i * 65 * 16);
      const joints = device.createBuffer({ size: palette.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      device.queue.writeBuffer(joints, 0, palette);
      const shader = async (code, label) => { const module = device.createShaderModule({ code, label }), bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(bad.map((m) => m.message).join()); return module; };
      const pipeline = await createCrewTurnPipeline(device, shader), batch = createCrewTurnBatch(device, pipeline, model, joints, people);
      const run = async (turns) => {
        batch.update(turns.map((shoulderTurn) => ({ shoulderTurn })));
        device.queue.writeBuffer(joints, 0, palette);
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        const dispatches = [];
        const spy = { setPipeline: (p) => pass.setPipeline(p), setBindGroup: (i, g) => pass.setBindGroup(i, g), dispatchWorkgroups: (n) => { dispatches.push(n); pass.dispatchWorkgroups(n); } };
        batch.encode(spy);
        pass.end();
        const read = device.createBuffer({ size: palette.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyBufferToBuffer(joints, 0, read, 0, palette.byteLength);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(read.getMappedRange().slice(0));
        read.unmap(); read.destroy();
        return { out, dispatches };
      };
      const square = await run([0, 0, 0]), turned = await run([0, 1, -1]);
      const joint = (name) => a.joints.indexOf(a.nodeIndex(name));
      // Where a joint's bind position ends up, for one body. Palette times the joint's bind position gives its posed place.
      const place = (buffer, body, name) => {
        const j = joint(name), m = buffer.subarray((body * 65 + j) * 16, (body * 65 + j + 1) * 16), n = a.nodeIndex(name), restWorld = a.world[n], p = [restWorld[12], restWorld[13], restWorld[14]];
        // The palette maps bind space, so compare what each does to one fixed point.
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
      };
      const rows = { dispatchWhileSquare: square.dispatches.length, dispatchWhileTurned: turned.dispatches.length, errors };
      for (const name of ['foot_l', 'foot_r', 'calf_l', 'thigh_r', 'upperarm_l', 'upperarm_r', 'pelvis', 'spine_02']) {
        rows[name] = { square: place(square.out, 1, name), turned: place(turned.out, 1, name), left: place(turned.out, 2, name), still: place(turned.out, 0, name) };
      }
      batch.destroy(); joints.destroy();
      return rows;
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.dispatchWhileSquare, 0, 'everyone square: nothing dispatched');
    assert.equal(result.dispatchWhileTurned, 1, 'anyone turned: one dispatch for the batch');
    const moved = (row, key = 'turned') => Math.hypot(...row[key].map((v, i) => v - row.square[i]));
    for (const name of ['foot_l', 'foot_r', 'calf_l', 'thigh_r']) assert.ok(moved(result[name]) < 1e-5, `${name} stays on the line he walks: ${moved(result[name])}`);
    for (const name of ['upperarm_l', 'upperarm_r']) {
      assert.ok(moved(result[name]) > 0.1, `${name} comes round: ${moved(result[name])}`);
      assert.ok(moved(result[name], 'still') < 1e-6, `${name} of the body who is square stays put`);
      // Positive turn is the same sense as yaw, so +z comes round toward +x: a left shoulder (+x) goes toward -z.
    }
    assert.ok(result.upperarm_l.turned[2] < result.upperarm_l.square[2] - 0.05, 'in the sense of his yaw');
    assert.ok(result.upperarm_l.left[2] > result.upperarm_l.square[2] + 0.05, 'and the other way for the other hand');
    assert.ok(moved(result.spine_02) < moved(result.upperarm_l), 'less at the waist than at the shoulder');
  } finally {
    await browser?.close();
    server.close();
  }
});
