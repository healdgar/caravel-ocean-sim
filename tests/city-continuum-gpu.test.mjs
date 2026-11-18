// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings on the one continuum (AGENTS.md rule 3): one house cut on the GPU at the scene's pixel error,
// near as clusters, across the handoff band as clusters and far body sharing samples, then far body alone at a step
// of its collapse, then a splat; a building shot down not at all; one struck, or where the player's guns would fall,
// cut finer. And in Lisbon itself, the cut lists the game's own frames leave, read back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

const launch = () => chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
});

test('one house through the city continuum: clusters, handoff, far body, splat, none once felled, finer once struck or aimed at', { timeout: 240000 }, async (t) => {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.route('**/__city_continuum', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__city_continuum`);
    const result = await page.evaluate(async () => {
      const { requestCityContinuumAtlas, createCityContinuum } = await import('/js/city-continuum-draw.js');
      const { requestContinuumPrograms } = await import('/js/continuum-scene.js');
      const { CONTINUUM_TYPE: T, CONTINUUM_HEADER: H, CONTINUUM_TYPE_WORDS } = await import('/js/continuum-format.js');
      const { CONTINUUM_STEP_WORDS, setContinuumPixelError } = await import('/js/continuum-core.js');
      const device = await (await navigator.gpu.requestAdapter()).requestDevice(), errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const shader = async (code, label) => { const module = device.createShaderModule({ code, label }); const bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(label + ': ' + bad.map((m) => `${m.lineNum}:${m.message}`).join('\n')); return module; };
      const atlas = await requestCityContinuumAtlas(device);
      const programs = await requestContinuumPrograms({ device, shader, shadowFormat: 'depth32float' });
      const B = GPUBufferUsage, make = (data, usage) => { const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST }); device.queue.writeBuffer(buffer, 0, data); return buffer; };
      // A camera 5 m up looking down +z: clip = (x, y, 0.1, z), a focal length of 1000 px.
      const frame = new Float32Array(96);
      frame[0] = 1; frame[5] = 1; frame[11] = 1; frame[14] = 0.1; frame.set([0, 5, 0, 0], 16); frame.set([0.5, 0, 0, 0], 20); frame.set([0, 0.5, 0, 0], 24); frame.set([0, 0, 1, 0], 28); frame.set([0, 1, 0, 1], 32); frame.set([1000, 1000, 0.001, 0.001], 36);
      const frameUBO = make(frame, B.UNIFORM), shadowUBO = make(new Float32Array(28), B.UNIFORM);
      const typeField = (type, field) => atlas.words[atlas.words[H.typesAt] + type * CONTINUUM_TYPE_WORDS + field];
      const typeFloat = (type, field) => new Float32Array(new Uint32Array([typeField(type, field)]).buffer)[0];
      const steps = typeField(0, T.steps), stepError = (s) => new Float32Array(atlas.words.buffer, atlas.words.byteOffset + (steps + s * CONTINUUM_STEP_WORDS + 1) * 4, 1)[0];
      const house = { farFirst: typeField(0, T.farFirst), stepCount: typeField(0, T.stepCount), clusterFirst: typeField(0, T.clusterFirst), clusterCount: typeField(0, T.clusterCount), rx: typeFloat(0, T.splatRx), ry: typeFloat(0, T.splatRy) };
      house.handoff = stepError(house.farFirst);
      const run = async ({ away, pixels = 3, felled = false, struck = false, aim = null }) => {
        const city = createCityContinuum({ device, atlas, programs, view: null, typed: new Float32Array([0, 0, away, 0, 1, 1, 1, 0.5]), types: new Uint32Array([0]), frame: frameUBO, shadowUniform: shadowUBO, samples: 4 });
        // The scene's one pixel error, which every cut reads as it encodes.
        setContinuumPixelError(pixels); city.setShadows(false);
        if (felled) city.hide(0, 1, true);
        if (struck) city.strike(0, 1, true);
        city.setAim(aim);
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        city.encode(pass); pass.end();
        const readDraws = device.createBuffer({ size: city.draws.size, usage: B.MAP_READ | B.COPY_DST }), readList = device.createBuffer({ size: city.list.size, usage: B.MAP_READ | B.COPY_DST });
        encoder.copyBufferToBuffer(city.draws, 0, readDraws, 0, city.draws.size); encoder.copyBufferToBuffer(city.list, 0, readList, 0, city.list.size);
        device.queue.submit([encoder.finish()]);
        await Promise.all([readDraws.mapAsync(GPUMapMode.READ), readList.mapAsync(GPUMapMode.READ)]);
        const draws = Array.from(new Uint32Array(readDraws.getMappedRange())), list = new Uint32Array(readList.getMappedRange().slice(0));
        readDraws.unmap(); readList.unmap();
        const entries = (index) => { const [at] = city.lists[index], n = draws[index * 4 + 1], out = []; for (let k = 0; k < n; k++) out.push([list[(at + k) * 2], list[(at + k) * 2 + 1]]); return out; };
        const clusters = [...entries(0), ...entries(1)].map(([b, word]) => ({ b, what: word >>> 28, cluster: word & 0x0fffffff }));
        const far = entries(2).map(([b, word]) => ({ b, what: word >>> 28, chunk: word & 0x0fffffff }));
        const splat = entries(3).map(([b, word]) => ({ b, what: word >>> 28 }));
        const state = { share: list[0] & 255, splatShare: (list[0] >> 8) & 255, step: list[1] & 65535, morph: new Float32Array(new Uint32Array([list[2]]).buffer)[0] };
        city.destroy();
        return { away, pixels, draws: draws.slice(0, 20), vertices: [0, 1, 2, 3, 4].map((i) => draws[i * 4]), clusters, far, splat, state };
      };
      // Across the handoff band (from where the far body's error at its first step is the scene's 3 px, 30% on).
      const start = house.handoff * 1000 / 3;
      const splatAt = 2 * Math.max(house.rx, house.ry) * 1000 / 2.5;
      const cases = {
        near: await run({ away: 40 }), band: await run({ away: start * 1.15 }), coarser: await run({ away: start * 1.15, pixels: 6 }),
        far: await run({ away: start * 3 }), farther: await run({ away: start * 9 }), splat: await run({ away: splatAt }),
        felled: await run({ away: 40, felled: true }),
        // At twice the scene's error, a house struck or under the guns' fall is cut as at the scene's own.
        struck: await run({ away: start * 1.15, pixels: 6, struck: true }),
        aimed: await run({ away: start * 1.15, pixels: 6, aim: { x: 0, y: 0, z: start * 1.15, radius: 2 } }),
        aimedAside: await run({ away: start * 1.15, pixels: 6, aim: { x: 400, y: 0, z: start * 1.15, radius: 2 } }),
        felledStruck: await run({ away: 40, felled: true, struck: true }),
      };
      await device.queue.onSubmittedWorkDone();
      return { errors, house, start, splatAt, cases };
    });
    t.diagnostic(JSON.stringify({ house: result.house, start: result.start, splatAt: result.splatAt, summary: Object.fromEntries(Object.entries(result.cases).map(([k, c]) => [k, { clusters: c.clusters.length, far: c.far.length, splat: c.splat.length, ...c.state }])) }));
    assert.deepEqual(result.errors, []);
    const { house, cases } = result;
    assert.deepEqual(cases.near.vertices, [384, 96, 96, 3, 96], 'each list draws its fixed instance');
    const inType = (c) => c.cluster >= house.clusterFirst && c.cluster < house.clusterFirst + house.clusterCount;
    // Close to: clusters of its own type only, no far body, no splat.
    assert.ok(cases.near.clusters.length > 0 && cases.near.clusters.every((c) => c.b === 0 && c.what === 1 && inType(c)), 'near, the house is its clusters');
    assert.equal(cases.near.far.length + cases.near.splat.length, 0);
    assert.equal(cases.near.state.share, 0);
    // In the band both sides are drawn, the far body from its first step on, splitting the samples by the share.
    assert.ok(cases.band.clusters.length > 0 && cases.band.far.length > 0, 'in the band, clusters and far body together');
    assert.ok(cases.band.state.share > 0 && cases.band.state.share < 255, `the handoff share ${cases.band.state.share}`);
    assert.ok(cases.band.state.step >= house.farFirst, 'the far body never draws finer than its first step');
    assert.ok(cases.band.far.every((f) => f.what === 2), 'far-body entries');
    // The scene's one scalar moves the cut: at twice the error the same distance is past the band.
    assert.equal(cases.coarser.state.share, 255);
    assert.equal(cases.coarser.clusters.length, 0);
    // Farther, the far body alone, collapsing as it goes.
    assert.equal(cases.far.clusters.length, 0);
    assert.ok(cases.far.far.length > 0 && cases.farther.far.length > 0);
    assert.ok(cases.farther.state.step > cases.far.state.step, `collapses with distance (${cases.far.state.step} → ${cases.farther.state.step})`);
    assert.ok(cases.farther.far.length <= cases.far.far.length);
    assert.ok(cases.far.state.morph >= 0 && cases.far.state.morph <= 1);
    // A few pixels across, its splat alone.
    assert.deepEqual([cases.splat.clusters.length, cases.splat.far.length, cases.splat.splat.length], [0, 0, 1], 'a house 2.5 px across is its splat');
    assert.equal(cases.splat.state.splatShare, 255);
    // Shot down, it is drawn as its pieces (js/building-fracture.js), and not here.
    assert.deepEqual([cases.felled.clusters.length, cases.felled.far.length, cases.felled.splat.length], [0, 0, 0]);
    // Struck or aimed at, it is cut at the core's CONTINUUM_IMPORTANT share of the error: at twice the scene's 3 px it
    // stands in the band, as at 3 px; aimed at elsewhere, it does not.
    for (const name of ['struck', 'aimed']) {
      assert.deepEqual(cases[name].state, cases.band.state, `${name}: cut as at half the error`);
      assert.deepEqual([cases[name].clusters.length, cases[name].far.length], [cases.band.clusters.length, cases.band.far.length]);
    }
    assert.deepEqual(cases.aimedAside.state, cases.coarser.state, 'a fall elsewhere leaves it at the scene\'s error');
    assert.deepEqual([cases.felledStruck.clusters.length, cases.felledStruck.far.length, cases.felledStruck.splat.length], [0, 0, 0], 'struck and in pieces, still not here');
  } finally { await browser?.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

test('Lisbon\'s buildings are cut on the GPU: the game\'s own lists, read back', { timeout: 300000 }, async (t) => {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const r = window.cityContinuumAudit = { device: null, buffers: {}, errors: [], pipelines: [], frames: 0, draws: 0, uploads: {} };
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) { const d = await request.apply(this, args); r.device ??= d; d.addEventListener('uncapturederror', (e) => r.errors.push(e.error.message)); return d; };
      const make = GPUDevice.prototype.createBuffer;
      GPUDevice.prototype.createBuffer = function (desc) { const b = make.call(this, desc); if (desc.label?.startsWith('city continuum') || desc.label?.startsWith('city ')) r.buffers[desc.label] = b; return b; };
      const write = GPUQueue.prototype.writeBuffer;
      GPUQueue.prototype.writeBuffer = function (buffer, ...rest) { if (buffer?.label?.startsWith('city')) r.uploads[buffer.label] = (r.uploads[buffer.label] ?? 0) + 1; return write.call(this, buffer, ...rest); };
      const pipeline = GPUDevice.prototype.createRenderPipelineAsync;
      GPUDevice.prototype.createRenderPipelineAsync = function (desc) { r.pipelines.push(desc.label); return pipeline.call(this, desc); };
      const pass = GPURenderPassEncoder.prototype, set = pass.setPipeline, indirect = pass.drawIndirect, current = new WeakMap();
      pass.setPipeline = function (p) { current.set(this, p.label); return set.call(this, p); };
      pass.drawIndirect = function (...args) { if (current.get(this) === 'cityContinuum view') r.draws++; return indirect.apply(this, args); };
      const texture = GPUCanvasContext.prototype.getCurrentTexture;
      GPUCanvasContext.prototype.getCurrentTexture = function (...args) { r.frames++; return texture.apply(this, args); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?region=lisbon&landfall=harbor&follower=0`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 200000, polling: 250 });
    await page.waitForFunction(() => window.cityContinuumAudit.buffers['city continuum draws'] && window.cityContinuumAudit.frames > 60, undefined, { timeout: 90000, polling: 200 });
    const before = await page.evaluate(() => ({ frames: cityContinuumAudit.frames, draws: cityContinuumAudit.draws, uploads: { ...cityContinuumAudit.uploads } }));
    await page.waitForFunction((from) => cityContinuumAudit.frames >= from + 60, before.frames, { timeout: 90000, polling: 100 });
    const result = await page.evaluate(async () => {
      const r = window.cityContinuumAudit, device = r.device, B = GPUBufferUsage, uploads = { ...r.uploads }, frames = r.frames, drawCalls = r.draws;
      const { requestCityContinuumAtlas } = await import('/js/city-continuum-draw.js');
      const { continuumListLayout } = await import('/js/continuum-scene.js');
      const { CONTINUUM_STEP_WORDS } = await import('/js/continuum-core.js');
      const {
        CONTINUUM_TYPE: T, CONTINUUM_HEADER: H, CONTINUUM_TYPE_WORDS, CONTINUUM_CLUSTER_WORDS, CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_SMALL_CLUSTER,
        CONTINUUM_RECORD_WORDS, CONTINUUM_RECORD, CONTINUUM_GONE, continuumRoom,
      } = await import('/js/continuum-format.js');
      // The atlas the game uploaded (one a device), read here from its own words.
      const { words, types: atlasTypes } = await requestCityContinuumAtlas(device);
      const read = async (buffer) => {
        const out = device.createBuffer({ size: buffer.size, usage: B.MAP_READ | B.COPY_DST }), encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, out, 0, buffer.size); device.queue.submit([encoder.finish()]);
        await out.mapAsync(GPUMapMode.READ); const read = new Uint32Array(out.getMappedRange().slice(0)); out.unmap(); out.destroy(); return read;
      };
      const [draws, list, records] = await Promise.all(['draws', 'lists', 'records'].map((name) => read(r.buffers[`city continuum ${name}`])));
      // Every entry checked against the building it names, its type and its state for the frame.
      const count = records.length / CONTINUUM_RECORD_WORDS, flags = Array.from({ length: count }, (_, b) => records[b * CONTINUUM_RECORD_WORDS + CONTINUUM_RECORD.packed]);
      const counts = new Array(atlasTypes.length).fill(0);
      for (const packed of flags) counts[packed & 0xffff]++;
      const { lists } = continuumListLayout(count, continuumRoom(atlasTypes, counts).room), field = (type, f) => words[words[H.typesAt] + type * CONTINUUM_TYPE_WORDS + f];
      const wrong = [], buildings = [new Set(), new Set(), new Set(), new Set(), new Set()];
      const flaw = (why) => { if (wrong.length < 12) wrong.push(why); };
      for (let index = 0; index < 5; index++) {
        const [at, room] = lists[index], n = draws[index * 4 + 1];
        if (n > room) flaw(`list ${index} holds ${n} of ${room}`);
        for (let k = 0; k < Math.min(n, room); k++) {
          const b = list[(at + k) * 2], word = list[(at + k) * 2 + 1], what = word >>> 28, item = word & 0x0fffffff;
          if (b >= count) { flaw(`list ${index} names building ${b} of ${count}`); continue; }
          if (flags[b] & CONTINUUM_GONE) flaw(`list ${index} draws felled building ${b}`);
          const type = flags[b] & 0xffff, share = list[b * 4] & 255, splatShare = (list[b * 4] >> 8) & 255, step = list[b * 4 + 1] & 0xffff, shadowStep = list[b * 4 + 1] >>> 16;
          const chunks = (s) => Math.ceil(words[field(type, T.steps) + s * CONTINUUM_STEP_WORDS] / CONTINUUM_CHUNK_TRIANGLES);
          buildings[index].add(b);
          if (index < 2) {
            const first = field(type, T.clusterFirst), triangles = words[words[H.clustersAt] + item * CONTINUUM_CLUSTER_WORDS + 15] & 255;
            if (what !== 1 || item < first || item >= first + field(type, T.clusterCount)) flaw(`cluster ${item} is not one of type ${type}'s`);
            if ((triangles <= CONTINUUM_SMALL_CLUSTER) !== (index === 1)) flaw(`cluster ${item} of ${triangles} triangles in list ${index}`);
            if (share >= 255) flaw(`building ${b} handed off whole yet drawn as clusters`);
          } else if (index === 2) {
            if (what !== 2 || step < field(type, T.farFirst) || item >= chunks(step)) flaw(`far piece ${item} of building ${b} at step ${step}`);
            if (share === 0 || splatShare >= 255) flaw(`building ${b} drawn as far body with shares ${share}, ${splatShare}`);
          } else if (index === 3) {
            if (what !== 3 || splatShare === 0) flaw(`building ${b} splatted with share ${splatShare}`);
          } else if (what !== 2 || shadowStep < field(type, T.farFirst) || item >= chunks(shadowStep)) flaw(`shadow piece ${item} of building ${b} at step ${shadowStep}`);
        }
      }
      return { draws: Array.from(draws), count, wrong, drawn: buildings.map((s) => s.size), frames, drawCalls, errors: r.errors, pipelines: r.pipelines, uploads,
        census: window.oceanContinuumCensus?.latest ?? null, state: window.oceanStartup.state, err: document.querySelector('#err')?.textContent ?? '' };
    }).catch((error) => ({ failed: String(error) }));
    t.diagnostic(JSON.stringify({ draws: result.draws, census: result.census, frames: result.frames - before.frames, drawCalls: result.drawCalls - before.draws, uploads: result.uploads, before: before.uploads }));
    assert.equal(result.failed, undefined, result.failed);
    assert.equal(result.state, 'ready', result.err);
    assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
    assert.ok(result.pipelines.includes('cityContinuum view') && result.pipelines.includes('continuum shadow'), 'the city material\'s view and the one shadow program draw the city continuum');
    // The view's four lists, every frame; nothing of the old block or type tiers.
    const frames = result.frames - before.frames, calls = result.drawCalls - before.draws;
    assert.ok(calls >= 4 * (frames - 2) && calls <= 4 * (frames + 2), `${calls} city draws in ${frames} frames`);
    assert.ok(!result.pipelines.some((label) => label === 'city blocks' || label === 'city buildings' || label === 'city solid blocks'), 'the block and type tiers are retired');
    // Read back: who is drawn how. Every entry names a standing building and, for a cluster, one of its type's own.
    const [clusters, small, far, splat, shadow] = [0, 1, 2, 3, 4].map((i) => result.draws[i * 4 + 1]);
    t.diagnostic(JSON.stringify({ buildings: result.count, entries: { clusters, small, far, splat, shadow }, drawn: result.drawn }));
    assert.deepEqual(result.wrong, [], 'every entry is a standing building, its own type\'s cluster or piece, drawn as its state says');
    // From the anchorage the town lies a few hundred metres off: as far bodies, the farthest as splats, and clusters
    // only where a building comes within its handoff (tests/old-world-city-gpu.test.mjs looks from over the quay).
    assert.ok(far > 0 && splat > 0, 'the town is drawn as far bodies, and the farthest as splats');
    assert.ok(shadow > 0, 'the far bodies cast the shadow map\'s shadows');
    // The census counts the city's real triangles, as the cut listed them.
    const listed = (result.draws[0] / 3) * clusters + (result.draws[4] / 3) * small + (result.draws[8] / 3) * far + splat;
    assert.ok(result.census?.families?.city > 0, 'the city reaches the continuum census');
    assert.ok(listed > 0);
    // With the camera still, nothing of the city is uploaded but, at most, the view's few numbers.
    for (const [label, n] of Object.entries(result.uploads)) if (label !== 'city continuum view') assert.equal(n, before.uploads[label] ?? 0, `${label} written while still`);
    fs.mkdirSync('shots', { recursive: true });
    await page.screenshot({ path: 'shots/city-continuum-lisbon-harbor.png' });
  } finally { await browser?.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});
