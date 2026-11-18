// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass on the one continuum (AGENTS.md rule 3): a flat meadow cut on the GPU at the scene's pixel error,
// read back patch by patch. Every pixel is shared by its own distance from one start for every patch: near, a patch
// is its sward's clusters; across the handoff band its clusters and canopy body both; farther its body alone,
// collapsing with distance; at a few pixels its splat; under a pixel its splat thinned and grown. The sun's list
// holds the same bodies, coarser, for the patches in its box. And in Lisbon itself, nothing draws grass but the
// meadow continuum's lists, which the census counts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

const launch = () => chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
});

// In the page: each listed entry checked against the patch it names, from the atlas's own words.
const AUDIT = /* js */ `(${function audit({ words, C, lists, counters, states, room }) {
  const H = C.MEADOW_CONTINUUM_HEADER, V = C.MEADOW_CONTINUUM_VARIANT, CHUNK = C.MEADOW_CONTINUUM_CHUNK_TRIANGLES;
  const variant = (v, field) => words[words[H.variantsAt] + v * C.MEADOW_CONTINUUM_VARIANT_WORDS + field];
  const alive = (v, s) => words[variant(v, V.steps) + s * C.MEADOW_CONTINUUM_STEP_WORDS];
  const half = (h) => { const e = (h >> 10) & 31, m = h & 1023; return e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15); };
  const rooms = [room.clusters, room.far, room.splat, room.shadow];
  const firsts = rooms.map((_, k) => rooms.slice(0, k).reduce((sum, n) => sum + n, 0));
  const drawn = states.length ? Math.min(counters[16], room.states) : 0;
  const swept = new Map(), wrong = [], flaw = (why) => { if (wrong.length < 12) wrong.push(why); };
  const fits = (v, step, chunk) => step >= variant(v, V.farFirst) && step <= variant(v, V.stepCount) && chunk < Math.ceil(alive(v, step) / CHUNK);
  const entries = [0, 1, 2, 3].map((list) => {
    const n = counters[list * 4 + 1], out = [];
    if (n > rooms[list]) flaw(`list ${list} holds ${n} of ${rooms[list]}`);
    for (let k = 0; k < Math.min(n, rooms[list]); k++) {
      const at = (firsts[list] + k) * 2, slot = lists[at], word = lists[at + 1], what = word >>> 28, item = word & 0x0fffffff;
      if (slot >= drawn) { flaw(`list ${list} names patch ${slot} of ${drawn}`); continue; }
      const s = states.subarray(slot * 4, slot * 4 + 4), v = s[1] & 255, step = s[2] & 65535, scale = half(s[1] >>> 16);
      if (v >= 12) { flaw(`patch ${slot} of variant ${v}`); continue; }
      if (list === 0) {
        if (what !== 1 || item < variant(v, V.clusterFirst) || item >= variant(v, V.clusterFirst) + variant(v, V.clusterCount)) flaw(`cluster ${item} is not variant ${v}'s`);
        else swept.set(slot, (swept.get(slot) ?? 0) + (words[words[H.clustersAt] + item * C.MEADOW_CONTINUUM_CLUSTER_WORDS + 15] & 255));
      } else if (list === 1) {
        if (what !== 2 || !fits(v, step, item)) flaw(`far piece ${item} of patch ${slot} at step ${step}`);
      } else if (list === 2) {
        if (what !== 3 || item !== 0 || !(scale > 0)) flaw(`patch ${slot} splatted at scale ${scale}`);
      } else if (what !== 4 || !fits(v, (item >> 5) & 511, item & 31)) flaw(`shadow piece ${item & 31} of patch ${slot} at step ${(item >> 5) & 511}`);
      out.push({ slot, item });
    }
    return out;
  });
  return { wrong, entries, drawn, swept };
}})`;

test('a flat meadow through the continuum: clusters, handoff, collapsing body, splat, thinned below a pixel, the sun\'s cut', { timeout: 300000 }, async (t) => {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.route('**/__meadow_continuum', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__meadow_continuum`);
    const result = await page.evaluate(async (auditSource) => {
      const audit = eval(auditSource);
      const M = await import('/js/meadow-grass.js'), C = await import('/js/meadow-continuum.js'), core = await import('/js/continuum-core.js');
      // The atlas is bound whole, as the game binds it (js/webgpu-adapter.js asks for up to 256 MiB).
      const adapter = await navigator.gpu.requestAdapter(), A = adapter.limits;
      const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(A.maxStorageBufferBindingSize, 256 * 1024 * 1024), maxBufferSize: Math.min(A.maxBufferSize, 512 * 1024 * 1024) } }), errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const shader = async (code, label) => { const module = device.createShaderModule({ code, label }); const bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(label + ': ' + bad.map((m) => `${m.lineNum}:${m.message}`).join('\n')); return module; };
      const pack = await C.loadMeadowGrass();
      const B = GPUBufferUsage, T = GPUTextureUsage;
      const make = (data, usage) => { const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST }); device.queue.writeBuffer(buffer, 0, data); return buffer; };
      // A flat field 10 m up, 3 km across; the camera 5 m over its southern edge looking north: clip = (x, y, 0.1, z),
      // a focal length of 1000 px.
      const n = 97, span = 3072, ground = 10, region = { x: 0, z: 0, span, size: n }, heights = new Float32Array(n * n).fill(ground);
      const elevation = device.createTexture({ size: [n, n], format: 'r32float', usage: T.TEXTURE_BINDING | T.COPY_DST });
      device.queue.writeTexture({ texture: elevation }, heights, { bytesPerRow: n * 4 }, [n, n]);
      const camera = [0, ground + 5, -1500], focal = 1000;
      const frame = new Float32Array(128);
      frame[0] = 1; frame[5] = 1; frame[11] = 1; frame[14] = 0.1; frame.set([...camera, 0], 16); frame.set([0.5, 0, 0, 0], 20); frame.set([0, 0.5, 0, 0], 24); frame.set([0, 0, 1, 0], 28); frame.set([0.3, 0.9, 0.3, 1], 32); frame.set([1000, 1000, 0.001, 0.001], 36); frame.set([0.82, 0.57, 6, 0], 56);
      const frameUBO = make(frame, B.UNIFORM), nearDomain = make(new Float32Array(8), B.UNIFORM), shadowUBO = make(new Float32Array(28), B.UNIFORM), cloudUBO = make(new Float32Array(32), B.UNIFORM);
      // The sun straight overhead, its box 240 m across about the camera, 100 m deep: half of it behind the camera.
      const R = 120, light = new Float32Array(28);
      light[0] = 1 / R; light[6] = -1 / 100; light[9] = 1 / R; light[14] = 0.5; light[15] = 1;
      light.set([camera[0], ground, camera[2], 1], 16); light.set([0, 1, 0, 1], 20); light.set([2 * R / 2048, 2 * R / 2048, 1, 0], 24);
      const flat = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: T.TEXTURE_BINDING }).createView();
      const cube = device.createTexture({ size: [1, 1, 6], format: 'rgba16float', usage: T.TEXTURE_BINDING }).createView({ dimension: 'cube' });
      const volume = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: T.TEXTURE_BINDING }).createView();
      const depth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: T.TEXTURE_BINDING }).createView();
      const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }), compare = device.createSampler({ compare: 'less' });
      const resources = [[0, { buffer: frameUBO }], [1, flat], [2, flat], [3, sampler], [4, cube], [5, flat], [7, flat], [8, sampler], [19, { buffer: shadowUBO }], [20, depth], [21, compare]];
      const clouds = { bindVolume: (pipe) => device.createBindGroup({ layout: pipe.getBindGroupLayout(1), entries: [[0, { buffer: cloudUBO }], [1, volume], [2, volume], [3, sampler]].map(([binding, resource]) => ({ binding, resource })) }) };
      const meadow = await M.createMeadowGrass({ device, shader, pack, region, heights, biome: null, elevation, nearDomain, resources, clouds });
      const read = async (buffer) => {
        const out = device.createBuffer({ size: buffer.size, usage: B.MAP_READ | B.COPY_DST }), encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, out, 0, buffer.size); device.queue.submit([encoder.finish()]);
        await out.mapAsync(GPUMapMode.READ); const words = new Uint32Array(out.getMappedRange().slice(0)); out.unmap(); out.destroy(); return words;
      };
      const H = C.MEADOW_CONTINUUM_HEADER, V = C.MEADOW_CONTINUUM_VARIANT, words = pack.words, LEVELS = C.MEADOW_CONTINUUM_LEVELS;
      const variant = (v, field) => words[words[H.variantsAt] + v * C.MEADOW_CONTINUUM_VARIANT_WORDS + field];
      const float = (word) => new Float32Array(new Uint32Array([word]).buffer)[0];
      const half = (h) => { const e = (h >> 10) & 31, m = h & 1023; return e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15); };
      const farError = float(words[H.farError]), canopy = float(words[H.canopy]);
      // How many pixels a patch spans from 'away' metres along 'toward' (meadowSpan).
      const spanOf = (toward, away) => 2 * Math.sqrt((16 * Math.abs(toward[1]) + 4 * canopy * (Math.abs(toward[0]) + Math.abs(toward[2]))) / Math.PI) * focal / Math.max(away, 1e-3);
      // Each variant's triangles at each level of its cluster hierarchy: a whole cut lies between the coarsest and finest.
      const levelTris = Array.from({ length: words[H.variantCount] }, (_, v) => {
        const sums = new Array(LEVELS).fill(0), first = variant(v, V.clusterFirst);
        for (let c = first; c < first + variant(v, V.clusterCount); c++) { const w = words[words[H.clustersAt] + c * C.MEADOW_CONTINUUM_CLUSTER_WORDS + 15]; sums[(w >> 8) & 15] += w & 255; }
        return sums;
      });
      const side = C.MEADOW_PATCH_METRES * M.MEADOW_BLOCK_PATCHES, firstBlock = Math.floor((region.x - span / 2) / side);
      const run = async (pixels, sun = null) => {
        core.setContinuumPixelError(pixels);
        device.queue.writeBuffer(shadowUBO, 0, sun ?? new Float32Array(28));
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        meadow.encode(pass); pass.end(); device.queue.submit([encoder.finish()]);
        const [counters, lists, states] = [await read(meadow.counters), await read(meadow.listBuffer), await read(meadow.states)];
        const checked = audit({ words, C, lists, counters, states, room: meadow.stats.room });
        const by = (list) => new Set(checked.entries[list].map((e) => e.slot));
        const [clustered, bodied, splatted, shadowed] = [0, 1, 2, 3].map(by);
        // Each patch drawn: where it lies, how far its bounds are from the eye, and which lists hold it.
        const patches = [];
        for (let slot = 0; slot < checked.drawn; slot++) {
          const s = states.subarray(slot * 4, slot * 4 + 4), v = s[1] & 255, cell = [(s[0] & 65535) + firstBlock * 16, (s[0] >>> 16) + firstBlock * 16];
          const sphere = [0, 1, 2, 3].map((k) => float(variant(v, V.sphere + k)));
          const relative = [cell[0] * 4 + sphere[0] - camera[0], ground + sphere[1] - camera[1], cell[1] * 4 + sphere[2] - camera[2]];
          const away = Math.hypot(...relative), reach = sphere[3] + 0.75, toward = relative.map((x) => x / away);
          const levels = levelTris[v], cut = checked.swept.get(slot) ?? 0, ahead = cell[1] * 4 + 2 - camera[2], aside = Math.abs(cell[0] * 4 + 2 - camera[0]);
          patches.push({ slot, away, nearest: Math.max(away - reach, 0.25), farthest: away + reach, ahead, farSpan: spanOf(toward, away + reach), cut,
            whole: ahead > 4 && aside < 0.6 * ahead ? (cut >= levels[LEVELS - 1] && cut <= levels[0]) : null, cutShare: cut / levels[0],
            step: s[2] & 65535, scale: half(s[1] >>> 16), farFirst: variant(v, V.farFirst),
            clustered: clustered.has(slot), bodied: bodied.has(slot), splatted: splatted.has(slot), shadowed: shadowed.has(slot) });
        }
        return { counters: Array.from(counters.slice(0, 20)), wrong: checked.wrong, patches, start: farError * focal / pixels, entries: checked.entries.map((e) => e.length) };
      };
      const base = await run(3), coarse = await run(6), lit = await run(3, light);
      // The patches of the ring 2.4 to 3 km off in view, where a patch is under a pixel across.
      let ringCells = 0;
      for (let j = -384; j < 384; j++) for (let i = -384; i < 384; i++) {
        const x = i * 4 + 2 - camera[0], z = j * 4 + 2 - camera[2], d = Math.hypot(x, z);
        if (z > 0 && Math.abs(x) < z && d > 2400 && d < 3000) ringCells++;
      }
      // Drawn, into a multisampled target and into the sun's map, with no complaint from the device.
      const colour = device.createTexture({ size: [64, 64], format: 'rgba16float', sampleCount: 4, usage: T.RENDER_ATTACHMENT });
      const depthTarget = device.createTexture({ size: [64, 64], format: 'depth32float', sampleCount: 4, usage: T.RENDER_ATTACHMENT });
      const shadowMap = device.createTexture({ size: [64, 64], format: 'depth32float', usage: T.RENDER_ATTACHMENT });
      const encoder = device.createCommandEncoder();
      const draw = encoder.beginRenderPass({ colorAttachments: [{ view: colour.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }], depthStencilAttachment: { view: depthTarget.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 } });
      meadow.draw(draw); draw.end();
      const cast = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadowMap.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
      meadow.drawShadow(cast); cast.end();
      device.queue.submit([encoder.finish()]);
      const census = meadow.continuumDraws().map((d) => ({ same: d.buffer === meadow.counters, offset: d.offset, records: d.records, stride: d.stride }));
      await device.queue.onSubmittedWorkDone();
      const least = (list) => list.reduce((m, p) => Math.min(m, p.away), Infinity);
      const summary = (r) => {
        const P = r.patches, start = r.start, band = start * (1 + core.CONTINUUM_HANDOFF_BAND);
        const near = P.filter((p) => p.farthest < start - 1), bodies = P.filter((p) => p.bodied).sort((a, b) => a.away - b.away);
        const steps = [bodies.slice(0, 50), bodies.slice(-50)].map((list) => list.reduce((s, p) => s + p.step, 0) / Math.max(list.length, 1));
        const splats = P.filter((p) => p.splatted);
        return {
          drawn: P.length, start, near: near.length, nearOnly: near.every((p) => !p.bodied && !p.splatted),
          clusteredOutside: P.filter((p) => p.clustered && p.nearest > band + 1).length,
          bodiedInside: P.filter((p) => p.bodied && p.farthest < start - 1).length,
          both: P.filter((p) => p.clustered && p.bodied).length, bodyOnly: P.filter((p) => p.bodied && !p.clustered && !p.splatted).length,
          splatOnly: P.filter((p) => p.splatted && !p.bodied && !p.clustered).length, splatTooNear: splats.filter((p) => p.farSpan > 5.25 * 1.05).length,
          steps, lowest: P.filter((p) => p.bodied).reduce((m, p) => Math.min(m, p.step - p.farFirst), Infinity),
          inflated: splats.filter((p) => p.scale > 1.001).length, smallestScale: splats.reduce((m, p) => Math.min(m, p.scale), Infinity),
          ring: splats.filter((p) => p.away > 2400 && p.away < 3000).length, nearest: least(P), farthest: P.reduce((m, p) => Math.max(m, p.away), 0),
          shadowed: P.filter((p) => p.shadowed).length, shadowBehind: P.filter((p) => p.shadowed && p.ahead < -10 && !p.clustered && !p.bodied && !p.splatted).length,
          entries: r.entries, counters: r.counters, wrong: r.wrong,
          cuts: { judged: P.filter((p) => p.clustered && p.whole !== null && p.farthest < start - 1).length, broken: P.filter((p) => p.clustered && p.whole === false && p.farthest < start - 1).map((p) => [Math.round(p.away), p.cut]).slice(0, 8),
            share: P.filter((p) => p.clustered).map((p) => +p.cutShare.toFixed(3)).sort((a, b) => a - b).filter((_, k, all) => k === 0 || k === all.length - 1 || k === all.length >> 1) },
        };
      };
      return { errors, ringCells, base: summary(base), coarse: summary(coarse), lit: summary(lit), census, stats: { ...meadow.stats, room: undefined }, region: { span } };
    }, AUDIT);
    t.diagnostic(JSON.stringify(result));
    const { base, coarse, lit } = result;
    assert.deepEqual(result.errors, []);
    assert.deepEqual(base.wrong, [], 'every entry names a drawn patch, its own variant\'s cluster or piece, drawn as its state says');
    assert.deepEqual(base.counters.filter((_, i) => i < 16 && i % 4 === 0), [384, 96, 3, 96], 'each list draws its fixed entry');
    assert.equal(base.counters[17], 0, 'no patch lost for room');
    // Near: clusters alone, each near patch in plain view a whole cut of its hierarchy.
    assert.ok(base.near > 0 && base.nearOnly, 'short of the handoff, a patch is its clusters alone');
    assert.ok(base.entries[0] > 0);
    assert.ok(base.cuts.judged > 0 && base.cuts.broken.length === 0, `whole cuts (${JSON.stringify(base.cuts)})`);
    // The handoff: one start for every patch, from the far error; clusters only short of the band's end, bodies only
    // past its start, and both where a patch spans it.
    assert.equal(base.clusteredOutside, 0, 'no patch beyond the band is cut by clusters');
    assert.equal(base.bodiedInside, 0, 'no patch short of the band draws its body');
    assert.ok(base.both > 0, 'across the band, clusters and canopy body together');
    // Farther: the body alone, never finer than its first step, collapsing with distance.
    assert.ok(base.bodyOnly > 0 && base.lowest >= 0);
    assert.ok(base.steps[1] > base.steps[0], `the body collapses with distance (${base.steps[0]} → ${base.steps[1]})`);
    // A few pixels across: the splat; under a pixel, thinned, the survivors grown.
    assert.ok(base.splatOnly > 0, 'far off, a patch is its splat alone');
    assert.equal(base.splatTooNear, 0, 'no splat where the patch spans more than the splat band');
    assert.ok(base.inflated > 0 && base.smallestScale >= 1, 'below a pixel the kept splats grow to keep the meadow\'s area');
    assert.ok(base.ring > 0 && base.ring < 0.7 * result.ringCells, `below a pixel, splats thinned (${base.ring} of ${result.ringCells} patches 2.4 to 3 km off)`);
    // No sun's box, no sun's list.
    assert.equal(base.counters[13], 0, 'nothing cast where the land casts no shadow');
    // The scene's one scalar moves the cut: at twice the error, the start halves and fewer clusters are cut.
    assert.ok(coarse.start < base.start && coarse.entries[0] < base.entries[0], `coarser error, fewer clusters (${base.entries[0]} → ${coarse.entries[0]})`);
    assert.deepEqual(coarse.wrong, []);
    assert.equal(coarse.clusteredOutside, 0);
    // The sun's cut: the bodies of every patch in its box, those behind the camera too, and no camera list changed.
    assert.deepEqual(lit.wrong, []);
    assert.ok(lit.counters[13] > 0 && lit.shadowed > 0, 'the patches in the sun\'s box are cast');
    assert.ok(lit.shadowBehind > 0, 'patches the camera does not see still cast');
    assert.deepEqual(lit.entries.slice(0, 3), base.entries.slice(0, 3), 'the sun\'s cut leaves the camera\'s alone');
    // The census counts the camera's records.
    assert.deepEqual(result.census, [{ same: true, offset: 0, records: 3, stride: 4 }]);
  } finally { await browser?.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

test('Lisbon\'s grass is cut on the GPU and drawn only through the meadow continuum', { timeout: 300000 }, async (t) => {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const r = window.meadowContinuumAudit = { device: null, buffers: {}, errors: [], pipelines: [], frames: 0, draws: 0 };
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) { const d = await request.apply(this, args); r.device ??= d; d.addEventListener('uncapturederror', (e) => r.errors.push(e.error.message)); return d; };
      const make = GPUDevice.prototype.createBuffer;
      GPUDevice.prototype.createBuffer = function (desc) { const b = make.call(this, desc); if (desc.label?.startsWith('meadow continuum')) r.buffers[desc.label] = b; return b; };
      for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync']) {
        const original = GPUDevice.prototype[name];
        GPUDevice.prototype[name] = function (desc) { r.pipelines.push(desc.label ?? ''); return original.call(this, desc); };
      }
      const pass = GPURenderPassEncoder.prototype, set = pass.setPipeline, indirect = pass.drawIndirect, current = new WeakMap();
      pass.setPipeline = function (p) { current.set(this, p.label); return set.call(this, p); };
      pass.drawIndirect = function (...args) { if (/^meadow continuum (clusters|far)$/.test(current.get(this) ?? '')) r.draws++; return indirect.apply(this, args); };
      const texture = GPUCanvasContext.prototype.getCurrentTexture;
      GPUCanvasContext.prototype.getCurrentTexture = function (...args) { r.frames++; return texture.apply(this, args); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?region=lisbon&landfall=harbor&follower=0`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 200000, polling: 250 });
    await page.waitForFunction(() => window.meadowContinuumAudit.buffers['meadow continuum draws'] && window.meadowContinuumAudit.frames > 60, undefined, { timeout: 90000, polling: 200 });
    const before = await page.evaluate(() => ({ frames: meadowContinuumAudit.frames, draws: meadowContinuumAudit.draws }));
    await page.waitForFunction((from) => meadowContinuumAudit.frames >= from + 60, before.frames, { timeout: 90000, polling: 100 });
    const result = await page.evaluate(async (auditSource) => {
      const audit = eval(auditSource);
      const r = window.meadowContinuumAudit, device = r.device, B = GPUBufferUsage, frames = r.frames, drawCalls = r.draws;
      const M = await import('/js/meadow-grass.js'), C = await import('/js/meadow-continuum.js');
      const { words } = await C.loadMeadowGrass();
      const read = async (buffer) => {
        const out = device.createBuffer({ size: buffer.size, usage: B.MAP_READ | B.COPY_DST }), encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, out, 0, buffer.size); device.queue.submit([encoder.finish()]);
        await out.mapAsync(GPUMapMode.READ); const read = new Uint32Array(out.getMappedRange().slice(0)); out.unmap(); out.destroy(); return read;
      };
      const [counters, lists, states] = await Promise.all(['draws', 'lists', 'states'].map((name) => read(r.buffers[`meadow continuum ${name}`])));
      const room = M.MEADOW_CONTINUUM_ROOM, checked = audit({ words, C, lists, counters, states, room });
      return { counters: Array.from(counters.slice(0, 20)), wrong: checked.wrong, drawn: checked.drawn, entries: checked.entries.map((e) => e.length), listBytes: lists.byteLength,
        roomBytes: (room.clusters + room.far + room.splat + room.shadow) * 8, frames, drawCalls, errors: r.errors, pipelines: r.pipelines,
        census: window.oceanContinuumCensus?.latest ?? null, state: window.oceanStartup.state, err: document.querySelector('#err')?.textContent ?? '' };
    }, AUDIT).catch((error) => ({ failed: String(error) }));
    t.diagnostic(JSON.stringify({ counters: result.counters, entries: result.entries, drawn: result.drawn, census: result.census?.families, frames: result.frames - before.frames, drawCalls: result.drawCalls - before.draws }));
    assert.equal(result.failed, undefined, result.failed);
    assert.equal(result.state, 'ready', result.err);
    assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
    // Grass has one path: the meadow continuum's cut, its two camera pipelines and its cast into the sun's map. The
    // ground cover's grass, its cull and the meadow's old tile tiers are gone.
    const grassy = result.pipelines.filter((label) => /meadow|ground cover|grass/i.test(label));
    assert.deepEqual([...new Set(grassy)].sort(), ['meadow continuum blocks', 'meadow continuum clusters', 'meadow continuum far', 'meadow continuum patches', 'meadow continuum reset', 'meadow continuum shadow']);
    // The camera's three lists, every frame.
    const frames = result.frames - before.frames, calls = result.drawCalls - before.draws;
    assert.ok(calls >= 3 * (frames - 2) && calls <= 3 * (frames + 2), `${calls} meadow draws in ${frames} frames`);
    // Read back: every entry names a patch drawn this frame and is drawn as its state says.
    assert.equal(result.listBytes, result.roomBytes);
    assert.deepEqual(result.wrong, []);
    assert.equal(result.counters[17], 0, 'no patch lost for room');
    assert.ok(result.drawn > 0 && result.entries.slice(0, 3).some((n) => n > 0), 'the hills about Lisbon hold grass in view');
    // The census counts the meadow from these very records.
    assert.ok(result.census?.families?.meadow > 0, 'the meadow reaches the continuum census');
    assert.ok(!('ground' in (result.census?.families ?? {})), 'no ground-cover grass in the census');
    await page.screenshot({ path: 'shots/meadow-continuum-lisbon-harbor.png' });
  } finally { await browser?.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});
