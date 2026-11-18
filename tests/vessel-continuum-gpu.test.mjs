// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ships the player sails, cut and drawn through the ship continuum in the game itself (js/vessel-continuum.js on
// js/ship-continuum-draw.js): each vessel's cut read back after a frame and checked against her body as baked
// (assets/ships/continuum/player-<model>) and the boat she is placed from; then holed, her damaged list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { SHIP_CONTINUUM_ASSETS, SHIP_CONTINUUM_STEP_WORDS } from '../js/ship-continuum.js';
import {
  SHIP_CONTINUUM_DAMAGED_LIST, SHIP_CONTINUUM_DAMAGED_SLOTS, SHIP_CONTINUUM_INSTANCE_VERTICES, SHIP_CONTINUUM_LISTS,
  SHIP_CONTINUUM_SHADOW_LIST, SHIP_CONTINUUM_ORDER_IMPORTANT, SHIP_CONTINUUM_DAMAGED_SHIFT,
  SHIP_CONTINUUM_SHADOW_CLUSTER_LIST, SHIP_CONTINUUM_CLUSTERS_CAST, SHIP_CONTINUUM_LINE_LIST, SHIP_CONTINUUM_LINE_PIECE,
} from '../js/wgsl/ship-continuum.js';
import { createShipAssetCache } from '../js/ship-mesh.js';

const at = (file) => new URL(`../${file}`, import.meta.url);
// A body's cluster count and, for each step of its far body, the triangles alive.
function body(model) {
  const id = `player-${model}`, manifest = JSON.parse(fs.readFileSync(at(SHIP_CONTINUUM_ASSETS[id]['manifest.json']), 'utf8'));
  const far = zlib.gunzipSync(fs.readFileSync(at(SHIP_CONTINUUM_ASSETS[id]['far.bin.gz']))), words = new Uint32Array(far.buffer, far.byteOffset, far.length / 4);
  const alive = Array.from({ length: manifest.far.stepCount + 1 }, (_, s) => words[manifest.far.offsets.steps + s * SHIP_CONTINUUM_STEP_WORDS]);
  return { clusters: manifest.clusterCount, alive };
}
// The pieces of her detail layer's lines (js/vessel-detail.js), as her line list names them: each 384 vertices.
const shipAssets = createShipAssetCache();
const linePieces = (model) => Array.from({ length: Math.ceil(shipAssets.get(model).detail.lineVertexCount / 384) }, (_, c) => [0, (SHIP_CONTINUUM_LINE_PIECE | c) >>> 0]);

let browser, server, base;
before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

const instrument = () => {
  window.gpuErrors = [];
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...a) {
    if (!window.vesselContinuumDevice) {
      window.vesselContinuumDevice = await request.apply(this, a);
      window.vesselContinuumDevice.addEventListener('uncapturederror', (e) => window.gpuErrors.push(e.error.message));
    }
    return window.vesselContinuumDevice;
  };
};
// Each vessel's cut as it stands after a frame: her draws, her lists, her instance record and the boat it was made from.
const readCuts = (page) => page.evaluate(async () => {
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  const device = window.vesselContinuumDevice;
  const read = async (buffer, bytes) => {
    const copy = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, copy, 0, bytes); device.queue.submit([encoder.finish()]);
    await copy.mapAsync(GPUMapMode.READ); const out = copy.getMappedRange().slice(0); copy.destroy(); return out;
  };
  return Promise.all(window.oceanFleet.vessels.map(async (v) => {
    const { cut, instances } = v.continuum;
    const [draws, list, record] = await Promise.all([read(cut.draws, cut.draws.size), read(cut.list, cut.list.size), read(instances, instances.size)]);
    const b = v.boat;
    return {
      model: v.asset.model.id, shown: Boolean(b.showProw), lists: cut.lists,
      draws: Array.from(new Uint32Array(draws)), list: Array.from(new Uint32Array(list)), record: Array.from(new Float32Array(record)),
      boat: { x: b.x, heave: b.heave, z: b.z, heading: b.heading * Math.PI / 180, length: b.length, runtime: v.asset.model.runtime.length },
    };
  }));
});

async function open(query) {
  const url = new URL(base);
  for (const [k, v] of Object.entries({ follower: '0', clouds: '0', w: 960, h: 540, census: '1', ...query })) url.searchParams.set(k, String(v));
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 300000, polling: 200 });
  assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready', errors.join('\n'));
  await page.waitForTimeout(2000);
  return { page, errors };
}

// One vessel's lists against her body: what she drew, and from which list.
function check(cut, { damaged = false } = {}) {
  const { lists, draws, list, record, boat } = cut, model = body(cut.model);
  const entries = (L) => {
    const [first, room] = lists[L], n = draws[L * 4 + 1];
    assert.equal(draws[L * 4], SHIP_CONTINUUM_INSTANCE_VERTICES[L], `${SHIP_CONTINUUM_LISTS[L]} draws its fixed size`);
    assert.ok(n <= room, `${SHIP_CONTINUUM_LISTS[L]} holds no more than its room`);
    return Array.from({ length: n }, (_, i) => [list[(first + i) * 2], list[(first + i) * 2 + 1]]);
  };
  // Her place: the boat's, at her scale over the model's.
  assert.ok(Math.hypot(record[0] - boat.x, record[2] - boat.z) < 2, `${cut.model} is cut where she floats`);
  assert.ok(Math.abs(record[6] - boat.length / boat.runtime) < 1e-5, `${cut.model} is cut at her own scale`);
  assert.equal(record[7], 0, 'her cut holds her one body');
  const orders = Math.round(record[10]);
  const step = list[1] & 65535, shadowStep = list[1] >>> 16, share = (list[0] >>> 8) & 255;
  if (damaged) {
    assert.equal((orders >> SHIP_CONTINUUM_DAMAGED_SHIFT) & 31, 1, 'a holed vessel is entered in her damaged list');
    const holed = entries(SHIP_CONTINUUM_DAMAGED_LIST);
    assert.ok(holed.length > 0, 'a holed vessel in view draws her clusters from her own list');
    for (const [ship, cluster] of holed) assert.ok(ship === 0 && cluster < model.clusters, 'each entry is one of her clusters');
    for (const L of [0, 1, 2, SHIP_CONTINUUM_SHADOW_LIST, SHIP_CONTINUUM_SHADOW_CLUSTER_LIST]) assert.equal(draws[L * 4 + 1], 0, `a holed vessel draws nothing from ${SHIP_CONTINUUM_LISTS[L]}`);
    assert.deepEqual(entries(SHIP_CONTINUUM_LINE_LIST), linePieces(cut.model), 'a holed vessel\'s lines ride her clusters');
    return { clusters: holed.length };
  }
  // Near the eye her clusters, cut to the shadow map's texel, cast her shadow; else none are entered for it.
  const cast = (list[0] & SHIP_CONTINUUM_CLUSTERS_CAST) !== 0, casting = entries(SHIP_CONTINUUM_SHADOW_CLUSTER_LIST);
  if (cast) assert.ok(casting.length > 0, `${cut.model}'s clusters cast her shadow`);
  else assert.equal(casting.length, 0, 'no clusters cast a far ship\'s shadow');
  for (const [ship, cluster] of casting) assert.ok(ship === 0 && cluster < model.clusters, 'each shadow entry is one of her clusters');
  for (let s = 0; s < SHIP_CONTINUUM_DAMAGED_SLOTS; s++) assert.equal(draws[(SHIP_CONTINUUM_DAMAGED_LIST + s) * 4 + 1], 0, 'a whole vessel has no damaged list');
  // Her shadow and her capture: her far body at the shadow map's step, every piece of it.
  const shadow = entries(SHIP_CONTINUUM_SHADOW_LIST), pieces = Math.ceil(model.alive[shadowStep] / 128);
  assert.deepEqual(shadow, Array.from({ length: pieces }, (_, c) => [0, c]), `${cut.model}'s shadow is her far body at step ${shadowStep}`);
  const clusters = entries(0);
  for (const [ship, cluster] of clusters) assert.ok(ship === 0 && cluster < model.clusters, 'each entry is one of her clusters');
  if (share < 255) assert.ok(clusters.length > 0, `${cut.model} in view draws her clusters`);
  // Her lines, colours' halyards, mooring lines and rode ride her clusters: every piece wherever her clusters are cut.
  assert.deepEqual(entries(SHIP_CONTINUUM_LINE_LIST), share < 255 ? linePieces(cut.model) : [], `${cut.model}'s lines ride her clusters`);
  const far = entries(1);
  if (share > 0) assert.deepEqual(far, Array.from({ length: Math.ceil(model.alive[step] / 128) }, (_, c) => [0, c]), 'her far body across the handoff');
  else assert.equal(far.length, 0, 'no far body before the handoff');
  return { clusters: clusters.length, orders, share, shadowStep, cast };
}

test('the player\'s ship is cut and drawn through the ship continuum, whole and holed', { timeout: 900000 }, async () => {
  const { page, errors } = await open({ ship: 'nina' });
  try {
    const [nina] = await readCuts(page);
    assert.equal(nina.model, 'nina');
    const whole = check(nina);
    assert.equal(whole.orders & SHIP_CONTINUUM_ORDER_IMPORTANT, SHIP_CONTINUUM_ORDER_IMPORTANT, 'the player\'s own ship is cut finest');
    assert.ok(whole.cast, 'the ship under the eye casts her shadow from her clusters, not her far body');
    fs.mkdirSync(at('shots'), { recursive: true });
    await page.screenshot({ path: at('shots/vessel-continuum-nina.png').pathname });
    // The census counts her from her draws; nothing sizes her on the CPU.
    await page.waitForFunction(() => (window.oceanContinuumCensus?.latest?.families?.ships ?? 0) > 0, null, { timeout: 60000, polling: 250 });
    // Holed: once the damaged programs are in, she draws her clusters only, from her own list.
    await page.waitForFunction(() => window.oceanFleet.renderAssets.get('nina')?.damaged, null, { timeout: 120000, polling: 250 });
    await page.evaluate(async () => {
      const { addHullHole } = await import('/js/hull-holes.js');
      addHullHole(window.oceanFleet.vessels[0].boat.damage, { design: [1.7, 0.2, 1], local: [3.1, 0.2, 1], radius: 0.2, side: 1, compartment: 'midStarboard' });
    });
    const [holed] = await readCuts(page);
    check(holed, { damaged: true });
    await page.screenshot({ path: at('shots/vessel-continuum-nina-holed.png').pathname });
    assert.deepEqual(await page.evaluate(() => window.gpuErrors), [], 'no GPU validation errors');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
