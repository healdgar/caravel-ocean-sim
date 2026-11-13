// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The board's country stamped onto a ground's colours by the GPU: a held furlong tinted in strips and softened at
// its bound, ground no one holds and woodland left exactly as the geography painted them, every way, roof, square
// and stream drawn at its own width, the town's trodden ground over its furlong, and the image's alpha untouched.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

let stampServer, stampBrowser, stampOrigin;
before(async () => {
  stampServer = createDevServer(); stampServer.listen(0, '127.0.0.1'); await once(stampServer, 'listening');
  stampOrigin = 'http://127.0.0.1:' + stampServer.address().port;
  stampBrowser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.WEBGPU_BACKEND === 'metal'
    ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'] });
});
after(async () => { await stampBrowser?.close(); stampServer?.closeAllConnections?.(); if (stampServer) await new Promise((done) => stampServer.close(done)); });

test('a board is stamped on its ground: furlongs, ways, roofs, water and town, the rest left as it was', { timeout: 180000 }, async (t) => {
  const page = await stampBrowser.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route('**/__board-stamp', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(stampOrigin + '/__board-stamp');
    const seen = await page.evaluate(async () => {
      const { createBoardStamp, boardStampTables } = await import('/js/board-stamp.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), faults = [];
      device.addEventListener('uncapturederror', (event) => faults.push(event.error.message));
      const shader = async (code, label) => {
        const module = device.createShaderModule({ code, label }), info = await module.getCompilationInfo();
        if (info.messages.some((m) => m.type === 'error')) throw Error(JSON.stringify(info.messages.map((m) => m.message)));
        return module;
      };
      // Ground 512 m square about (1000, -2000): corn to the west, ground no one holds in the middle, a wood to
      // the east, and a strip along the south in no furlong at all. Eight metres to a cell, four to a texel.
      const SPAN = 512, CELLS = 64, IMAGE = 128, ox = 1000, oz = -2000, LATTICE = 17;
      const index = new Uint16Array(CELLS * CELLS);
      for (let j = 0; j < 56; j++) for (let i = 0; i < CELLS; i++) index[j * CELLS + i] = i < 21 ? 1 : i < 43 ? 2 : 3;
      const town = new Float32Array(LATTICE * LATTICE);
      for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) town[j * LATTICE + i] = 1;
      const board = {
        size: CELLS, index, origin: { x: ox, z: oz }, span: SPAN, town,
        uses: [{ kind: 4, shade: 0.5, heading: 0, hedged: false }, { kind: 6, shade: 0.5, heading: 0, hedged: false, wild: true }, { kind: 8, shade: 0.5, heading: 0, hedged: false }],
        roads: [[[ox - 40, oz + 42], [ox, oz + 42], [ox + 40, oz + 42]]],
        lanes: [-60, 102, -20, 102],
        rivers: [[62, -200, 3, 62, -160, 3, 62, -120, 3, 62, -80, 3, 62, -40, 3]],
        streets: [{ pts: [[ox - 60, oz + 182], [ox - 20, oz + 182]], hw: 3 }],
        squares: [{ x: ox + 2, z: oz + 150, mean: 10 }],
        lots: [{ x: ox - 30, z: oz - 150, w: 12, d: 8, c: 1, s: 0 }],
      };
      const tables = boardStampTables(board);
      const BASE = [60, 120, 60, 200], pixels = new Uint8Array(IMAGE * IMAGE * 4);
      for (let k = 0; k < IMAGE * IMAGE; k++) pixels.set(BASE, k * 4);
      const image = device.createTexture({ size: [IMAGE, IMAGE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
      const paint = () => device.queue.writeTexture({ texture: image }, pixels, { bytesPerRow: IMAGE * 4 }, [IMAGE, IMAGE]);
      const read = async () => {
        const buffer = device.createBuffer({ size: IMAGE * IMAGE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: image }, { buffer, bytesPerRow: IMAGE * 4 }, [IMAGE, IMAGE]);
        device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
        const out = Array.from(new Uint8Array(buffer.getMappedRange())); buffer.unmap(); buffer.destroy();
        return out;
      };
      device.pushErrorScope('validation');
      const stamp = await createBoardStamp({ device, shader, board });
      paint(); stamp.stamp(image, IMAGE); const first = await read();
      // The model's life changes a field and the ground is painted afresh: the same stamp, run again.
      paint(); stamp.stamp(image, IMAGE); const second = await read();
      const again = await createBoardStamp({ device, shader, board });
      stamp.dispose(); again.dispose();
      const invalid = await device.popErrorScope();
      await device.queue.onSubmittedWorkDone();
      return { first, same: first.every((v, k) => v === second[k]), faults, invalid: invalid?.message ?? null, ways: tables.wayCount, parcels: stamp.parcels, IMAGE, BASE };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(seen.faults, []);
    assert.equal(seen.invalid, null);
    assert.ok(seen.same, 'stamped again on the ground painted afresh, it is the same country');
    assert.equal(seen.parcels, 3);
    // Bank and water of the stream, the road, the lane, the street, the square and the roof.
    assert.equal(seen.ways, 7);

    const { first, IMAGE, BASE } = seen, at = (x, y) => first.slice((y * IMAGE + x) * 4, (y * IMAGE + x) * 4 + 4);
    const near = (got, want, by, what) => { for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[c]) <= by, `${what}: ${got} for ${want.map(Math.round)}`); };
    const over = (tint, cover, under = BASE) => tint.map((v, c) => v * cover + under[c] * (1 - cover));
    t.diagnostic(JSON.stringify({ corn: at(20, 60), wild: at(64, 20), wood: at(110, 20), none: at(64, 120), road: at(64, 74), water: at(79, 40), bank: at(81, 40), roof: at(56, 26), square: at(64, 101), town: at(16, 16), bound: [at(41, 60), at(43, 60), at(46, 60)] }));

    // Alpha is the ground's own, everywhere.
    for (let k = 3; k < first.length; k += 4) assert.equal(first[k], BASE[3], `alpha of texel ${(k - 3) / 4}`);
    // Ground no one holds, woodland, and ground in no furlong: exactly as painted.
    for (const [x, y, what] of [[64, 20, 'wild'], [110, 20, 'wood'], [64, 120, 'no furlong'], [46, 60, 'wild, three texels from the corn']]) assert.deepEqual(at(x, y), BASE, what);
    // Corn: its own colour over most of the geography, in strips that run along its lie (here east and west).
    const corn = at(20, 60);
    near(corn, over([182, 158, 98], 0.88), 15, 'corn');
    assert.ok(corn[0] > corn[1] && corn[1] > corn[2] + 30, `corn is straw, not grass: ${corn}`);
    let low = 255, high = 0, acrossLow = 255, acrossHigh = 0;
    for (let y = 40; y <= 70; y++) { low = Math.min(low, at(20, y)[0]); high = Math.max(high, at(20, y)[0]); }
    for (let x = 6; x <= 30; x++) { acrossLow = Math.min(acrossLow, at(x, 60)[0]); acrossHigh = Math.max(acrossHigh, at(x, 60)[0]); }
    assert.ok(high - low >= 10, `strips across the furlong: ${low} to ${high}`);
    assert.ok(acrossHigh - acrossLow <= 2, `and none along it: ${acrossLow} to ${acrossHigh}`);
    // Its bound with the unheld ground is a soft band, not a stair.
    const inner = at(41, 60), outer = at(43, 60);
    assert.ok(inner[0] > BASE[0] + 20 && inner[0] < corn[0] - 10, `the corn's edge is thinned: ${inner}`);
    assert.ok(outer[0] > BASE[0] && outer[0] < inner[0], `and reaches a little past it: ${outer}`);
    // Ways at their own widths and colours.
    near(at(64, 74), over([176, 160, 130], 0.9), 4, 'road');
    const bank = over([70, 84, 58], 0.5);
    near(at(81, 40), bank, 4, 'stream bank');
    near(at(79, 40), over([46, 54, 48], 0.82, bank), 4, 'stream bed');
    near(at(64, 101), over([170, 160, 140], 0.95), 4, 'square');
    const roof = at(56, 26);
    assert.ok(roof[0] > roof[1] + 20 && roof[1] < BASE[1], `a tiled roof: ${roof}`);
    const lane = at(54, 89), street = at(54, 109);
    near(lane, over([170, 156, 128], 0.7 * 0.8), 4, 'a lane narrower than a texel, as faint as it is narrow');
    near(street, over([134, 124, 108], 0.95), 4, 'street');
    // The town's trodden ground lies over the corn it stands in.
    near(at(16, 16), over([0.588 * 255, 0.525 * 255, 0.431 * 255], 0.82), 4, 'town ground');
  } finally { await page.close(); }
});
