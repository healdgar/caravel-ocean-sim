// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The land on the one continuum (AGENTS.md rule 3): pieces of land baked into patch hierarchies and cut on the GPU at
// the scene's pixel error. Read back, every cut covers each piece exactly once; the heights the GPU draws along every
// drawn patch's edges meet those of every patch beside it, across patch, level, window and section seams, with a pit
// dug across the seam or not, drawn below the lattice to the crater tiles' own cell; the far end is the root's two
// triangles; the census counts what the cut submits. And in a coast of the game, the land is cut and drawn through the
// continuum and nothing else.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { LAND_CONTINUUM_FINEST_M } from '../js/wgsl/land-continuum.js';
import { LAND_CRATER_CELL_M } from '../js/wgsl/land-craters.js';

const launch = () => chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
});

test('the land\'s cut covers every piece once and draws no crack across patches, levels, a window, a section seam or a pit', { timeout: 300000 }, async (t) => {
  assert.equal(LAND_CONTINUUM_FINEST_M, LAND_CRATER_CELL_M, 'the land is cut as finely as a pit is worked out');
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.route('**/__land_continuum', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__land_continuum`);
    const result = await page.evaluate(async () => {
      const { bakeLandContinuumPiece, landContinuumSeams, requestLandContinuumPipelines, createLandContinuum } = await import('/js/land-continuum.js');
      const W = await import('/js/wgsl/land-continuum.js');
      const { createContinuumCensus } = await import('/js/continuum-census.js');
      const device = await (await navigator.gpu.requestAdapter()).requestDevice(), errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const shader = async (code, label) => { const module = device.createShaderModule({ code, label }); const bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(label + ': ' + bad.map((m) => `${m.lineNum}:${m.message}`).join('\n')); return module; };
      const pipelines = await requestLandContinuumPipelines({ device, shader });
      const B = GPUBufferUsage, make = (data, usage) => { const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST }); device.queue.writeBuffer(buffer, 0, data); return buffer; };
      // A frame that culls nothing (only w = 1), a focal length of 1000 px; the camera is moved for each cut.
      const frame = new Float32Array(96);
      frame[15] = 1; frame.set([0, 0.5, 0, 0], 24); frame.set([1000, 1000, 0.001, 0.001], 36);
      const frameUBO = make(frame, B.UNIFORM);
      const hill = (x, z) => 40 * Math.sin(x * 0.0021) * Math.cos(z * 0.0017) + 12 * Math.sin(x * 0.013 + z * 0.007) + 3 * Math.sin(x * 0.07) * Math.sin(z * 0.05) + 8;
      // A pit as the drawing has one (landContinuumRelief), and what a point between the lattice's waits for inside
      // the rectangle it moves the ground in (landContinuumDug): `rect` that rectangle and the amount, worked into a
      // mark as the bake and a strike take one (landContinuumDig). The mark keeps the amount over every rectangle that
      // touches its own; the GPU waits for it only strictly inside.
      const pitOf = (cx, cz, radius, depth, rect) => ({
        mark: {
          ...rect, finest: 0,
          over: (ax, bx, az, bz) => (bx < rect.x0 - 0.01 || ax > rect.x1 + 0.01 || bz < rect.z0 - 0.01 || az > rect.z1 + 0.01 ? 0 : rect.amount),
          at: (x, z) => (x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1 ? rect.amount : 0),
        },
        probe: [`let d=distance(xz,vec2f(${cx.toFixed(3)},${cz.toFixed(3)}))/${radius.toFixed(3)};return max(h-${depth.toFixed(3)}*max(0.0,1.0-d*d),min(h,0.01));`,
          `return select(0.0,${rect.amount.toFixed(3)},xz.x>${rect.x0.toFixed(1)}&&xz.x<${rect.x1.toFixed(1)}&&xz.y>${rect.z0.toFixed(1)}&&xz.y<${rect.z1.toFixed(1)});`],
        centre: [cx, cz], depth,
      });
      const probes = new Map(), probeOf = async (pit) => {
        const key = pit ? pit.probe.join() : '';
        if (!probes.has(key)) probes.set(key, await device.createComputePipelineAsync({ layout: 'auto', compute: { module: await shader(W.landContinuumProbeWGSL(...(pit ? pit.probe : [])), 'land probe'), entryPoint: 'landContinuumProbe' } }));
        return probes.get(key);
      };

      // ---------------------------------------------------------------- the scenes
      // A coast's centre (129 points, the most authority) beside a mock section (65 points), 4 m a grid unit.
      const sectionScene = (ground = hill) => {
        const grid = { x0: 0, z0: 0, g: 4 }, specs = new Map();
        for (const [key, sx, n, authority] of [['0,0', 0, 129, 3], ['1,0', 1, 65, 1]]) {
          const cell = 1024 / (n - 1), heights = new Float32Array(n * n);
          for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = ground((sx * 1024 + i * cell) * grid.g, j * cell * grid.g);
          specs.set(key, { sx, sz: 0, n, cell, heights, authority, order: sx });
        }
        return { grid, pieces: [...specs].map(([key, s]) => { const seam = landContinuumSeams(specs, key); return { key, gx: s.sx * 1024, gz: 0, spec: { n: s.n, cell: s.cell, heights: seam.heights, gx: s.sx * 1024, gz: 0, edges: seam.edges, grid } }; }) };
      };
      // One piece with a finer survey in it, as Saba's bay: 33 points at 8 units, a window of 129 at 1 unit whose
      // border lies on the coarse lattice's own lines, its detail inside. 2 m a unit.
      const windowScene = () => {
        const grid = { x0: 0, z0: 0, g: 2 }, n = 33, cell = 8, heights = new Float32Array(n * n);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = hill(i * cell * grid.g * 9, j * cell * grid.g * 9) * 0.5;
        const surface = (gx, gz) => {
          const u = gx / cell, v = gz / cell, i = Math.min(n - 2, Math.floor(u)), j = Math.min(n - 2, Math.floor(v)), a = u - i, b = v - j, k = j * n + i;
          return a + b <= 1 ? heights[k] + a * (heights[k + 1] - heights[k]) + b * (heights[k + n] - heights[k]) : heights[k + n + 1] + (1 - a) * (heights[k + n] - heights[k + n + 1]) + (1 - b) * (heights[k + 1] - heights[k + n + 1]);
        };
        const wn = 129, wg = 128, win = new Float32Array(wn * wn);
        for (let j = 0; j < wn; j++) for (let i = 0; i < wn; i++) {
          const u = i / (wn - 1), v = j / (wn - 1);
          win[j * wn + i] = surface(wg + i, wg + j) + 6 * Math.sin(i * 0.31) * Math.sin(j * 0.23) * 16 * u * (1 - u) * v * (1 - v);
        }
        return { grid, pieces: [{ key: 'saba', gx: 0, gz: 0, spec: { n, cell, heights, gx: 0, gz: 0, grid, window: { n: wn, cell: 1, gx: wg, gz: wg, heights: win } } }] };
      };

      // ---------------------------------------------------------------- one cut, read back and checked
      const run = async (scene, { camera, pixels = 3, pit = null, late = false }) => {
        const land = createLandContinuum({ device, pipelines, view: null, frame: frameUBO, grid: scene.grid });
        const baked = new Map();
        for (const p of scene.pieces) {
          const b = bakeLandContinuumPiece({ ...p.spec, marks: pit && !late ? [pit.mark] : [] });
          baked.set(p.key, { ...p, b });
          land.set(p.key, b, { gx: p.gx, gz: p.gz, land: null });
        }
        // A pit dug after the bake, as a strike digs one: raised in place, in every piece it reaches.
        if (pit && late) for (const p of scene.pieces) land.raise(p.key, pit.mark);
        frame.set([camera[0], camera[1], camera[2], 0], 16); device.queue.writeBuffer(frameUBO, 0, frame);
        land.setPixelError(pixels);
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        land.encode(pass); pass.end(); device.queue.submit([encoder.finish()]);
        const cut = await land.readCut();
        // The census reads the same records the draws are made from.
        const census = createContinuumCensus(device), counted = device.createCommandEncoder();
        census.encode(counted, [{ name: 'land', draws: land.continuumDraws() }]); device.queue.submit([counted.finish()]); census.afterSubmit();
        await device.queue.onSubmittedWorkDone();
        for (let i = 0; i < 50 && !census.latest; i++) await new Promise((r) => setTimeout(r, 10));
        const censusLand = census.latest?.families?.land ?? null; census.destroy();
        const probe = await probeOf(pit);
        const out = { pieces: {}, levels: new Set(), lists: [0, 0, 0, 0, 0], submitted: 0, censusLand, coverage: [], compared: 0, between: 0, across: 0, worst: 0, worstAt: null, shared: 0, deepest: {} };
        // Every vertex placed in finest units, which every piece of a grid shares.
        const rows = new Map(), columns = new Map(), vertices = new Map(), edges = [];
        const along = (lines, line, at, v) => { if (!lines.has(line)) lines.set(line, []); lines.get(line).push({ at, ...v }); };
        for (const [key, piece] of baked) {
          const { b } = piece, words = b.nodes, K = 2 ** -b.shiftF;
          const node = (i) => ({ x0: words[i * 12 + 6], z0: words[i * 12 + 7], level: words[i * 12 + 8], cells: words[i * 12 + 9], list: words[i * 12 + 10] });
          const [view, captured] = cut.get(key);
          // Every piece under its drawn patches exactly once, for the view's cut and the captures': they lie inside it,
          // none overlaps another, and their areas sum to its.
          for (const lists of [view, captured]) {
            const squares = [];
            lists.forEach((entries, list) => entries.forEach((i) => {
              const d = node(i), extent = d.cells * 2 ** d.level;
              if (d.list !== list) out.coverage.push(`${key}: node ${i} of list ${d.list} in list ${list}`);
              if (d.x0 + extent > b.N || d.z0 + extent > b.N) out.coverage.push(`${key}: node ${i} outside the piece`);
              squares.push([d.x0, d.z0, extent]);
            }));
            const area = squares.reduce((sum, [, , e]) => sum + e * e, 0);
            if (area !== b.N * b.N) out.coverage.push(`${key}: ${area} of ${b.N * b.N} drawn`);
            for (let a = 0; a < squares.length; a++) for (let c = a + 1; c < squares.length; c++) {
              const [ax, az, ae] = squares[a], [cx, cz, ce] = squares[c];
              if (ax < cx + ce && cx < ax + ae && az < cz + ce && cz < az + ae) { out.coverage.push(`${key}: patches overlap`); a = squares.length; break; }
            }
          }
          out.pieces[key] = { view: view.map((l) => l.length), captured: captured.map((l) => l.length) };
          // The drawn patches' edge points, asked of the GPU.
          const points = [], patches = [];
          view.forEach((entries, list) => entries.forEach((i) => {
            const d = node(i), s = 2 ** d.level, c = d.cells;
            out.levels.add(`${key}:${d.level - b.R}`); out.lists[list]++; out.submitted += c * c * 2;
            const sides = [[0, 0, 1, 0], [0, c, 1, 0], [0, 0, 0, 1], [c, 0, 0, 1]].map(([ox, oz, dx, dz]) => Array.from({ length: c + 1 }, (_, k) => [d.x0 + (ox + dx * k) * s, d.z0 + (oz + dz * k) * s]));
            for (const side of sides) for (const p of side) points.push(p);
            patches.push(sides);
          }));
          const probeIn = make(new Int32Array(points.flatMap(([x, z]) => [x, z, 0, 0])), B.STORAGE);
          const probeOut = device.createBuffer({ size: points.length * 16, usage: B.STORAGE | B.COPY_SRC }), read = device.createBuffer({ size: points.length * 16, usage: B.MAP_READ | B.COPY_DST });
          const slot = land.pieces.get(key);
          const group = device.createBindGroup({ layout: probe.getBindGroupLayout(0), entries: [[0, frameUBO], [1, land.viewBuffer], [2, slot.uniform], [3, slot.lattice], [5, probeIn], [6, probeOut]].map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
          const e2 = device.createCommandEncoder(), p2 = e2.beginComputePass();
          p2.setPipeline(probe); p2.setBindGroup(0, group); p2.dispatchWorkgroups(Math.ceil(points.length / 64)); p2.end();
          e2.copyBufferToBuffer(probeOut, 0, read, 0, read.size); device.queue.submit([e2.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const heights = new Float32Array(read.getMappedRange().slice(0)); read.unmap();
          let at = 0;
          for (const sides of patches) {
            const drawn = sides.map((side) => side.map(([x, z]) => {
              const u = piece.gx * K + x, v = piece.gz * K + z, wx = heights[at * 4], h = heights[at * 4 + 1], wz = heights[at * 4 + 2], ground = heights[at * 4 + 3]; at++;
              // How far below its ground the deepest drawn vertex near the pit's middle stands, in each piece.
              if (pit && Math.hypot(wx - pit.centre[0], wz - pit.centre[1]) < 1.25) out.deepest[key] = Math.min(out.deepest[key] ?? 0, h - ground);
              return { u, v, h };
            }));
            for (const side of drawn) {
              for (const p of side) {
                const k = `${p.u},${p.v}`;
                if (!vertices.has(k)) { vertices.set(k, []); along(rows, p.v, p.u, { key, h: p.h, k }); along(columns, p.u, p.v, { key, h: p.h, k }); }
                vertices.get(k).push({ key, h: p.h });
              }
              edges.push({ key, side });
            }
          }
        }
        // Every vertex any patch draws on another patch's edge lies on that edge's line, between its vertices or on them.
        for (const { key, side } of edges) {
          for (let k = 0; k + 1 < side.length; k++) {
            const a = side[k], b = side[k + 1], flat = a.v === b.v, line = flat ? rows.get(a.v) : columns.get(a.u);
            const from = flat ? Math.min(a.u, b.u) : Math.min(a.v, b.v), to = flat ? Math.max(a.u, b.u) : Math.max(a.v, b.v), span = to - from;
            for (const point of line) {
              if (point.at < from || point.at > to) continue;
              const q = point.at - from, h = (flat ? (a.u < b.u ? a : b) : (a.v < b.v ? a : b)).h, h2 = (flat ? (a.u < b.u ? b : a) : (a.v < b.v ? b : a)).h, lineH = h + (h2 - h) * q / span;
              for (const o of vertices.get(point.k)) {
                const gap = Math.abs(o.h - lineH);
                out.compared++; if (q > 0 && q < span) out.between++; if (o.key !== key) out.across++;
                if (gap > out.worst) { out.worst = gap; out.worstAt = { key, other: o.key, at: point.k, line: lineH, h: o.h, q, span }; }
              }
            }
          }
        }
        for (const list of vertices.values()) if (new Set(list.map((v) => v.key)).size > 1) out.shared++;
        land.destroy();
        return { ...out, levels: [...out.levels].sort() };
      };

      const sections = sectionScene(), saba = windowScene();
      // Smooth ground, whose own error is under a pit's: there the pit, not the ground, sets the cut.
      const plain = sectionScene((x, z) => 40 * Math.sin(x * 0.0021) * Math.cos(z * 0.0017) + 8);
      // A pit a ball digs, astride the seam at x = 4096 m, far finer than either lattice (32 and 64 m), in the crater
      // tiles it reaches; and a great one, wider than a lattice cell, to be seen from a way off.
      // Each on dry ground: dug ground never goes under the water.
      const hole = pitOf(4097, 40, 2.5, 0.6, { x0: 4088, x1: 4112, z0: 32, z1: 48, amount: 0.8 });
      const crater = pitOf(4100, 2000, 40, 3, { x0: 4056, x1: 4144, z0: 1952, z1: 2048, amount: 3.5 });
      const windowHole = pitOf(297, 273, 2.5, 0.6, { x0: 288, x1: 304, z0: 264, z1: 280, amount: 0.8 });
      // Eight metres up and ten off the hole, over the ground there.
      const over = (x, z, ground) => [x - 6, ground + 8, z + 8];
      const cases = {
        // Close to the seam, low: fine patches near, coarser beyond, either side of it.
        seam: await run(sections, { camera: [4096, 60, 2000] }),
        coarser: await run(sections, { camera: [4096, 60, 2000], pixels: 12 }),
        side: await run(sections, { camera: [1000, 200, 3000] }),
        // The hole across the seam, baked in, then dug after the bake, seen from close by.
        hole: await run(sections, { camera: over(4097, 40, hill(4097, 40)), pit: hole }),
        dug: await run(sections, { camera: over(4097, 40, hill(4097, 40)), pit: hole, late: true }),
        // The great crater seen from a way off, with and without it.
        away: await run(plain, { camera: [4096, 300, 0] }),
        craterAway: await run(plain, { camera: [4096, 300, 0], pit: crater }),
        dugAway: await run(plain, { camera: [4096, 300, 0], pit: crater, late: true }),
        // From far off, the far end: each piece its root's two triangles.
        far: await run(sections, { camera: [-1e6, 500, 2000] }),
        // The window: fine patches inside it beside coarse ones outside, then a hole in it.
        window: await run(saba, { camera: [256, 30, 300], pixels: 1 }),
        windowHole: await run(saba, { camera: [291, 40, 281], pixels: 1, pit: windowHole, late: true }),
      };
      await device.queue.onSubmittedWorkDone();
      return { errors, cases };
    });
    t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(result.cases).map(([k, c]) => [k, { pieces: c.pieces, levels: c.levels, lists: c.lists, compared: c.compared, between: c.between, across: c.across, shared: c.shared, worst: c.worst, worstAt: c.worstAt, submitted: c.submitted, census: c.censusLand, deepest: c.deepest }]))));
    assert.deepEqual(result.errors, []);
    for (const [name, c] of Object.entries(result.cases)) {
      assert.deepEqual(c.coverage, [], `${name}: every piece drawn exactly once, in the view's cut and the captures'`);
      assert.ok(c.worst < 2e-3, `${name}: no crack, the widest gap ${c.worst} m at ${JSON.stringify(c.worstAt)}`);
      assert.equal(c.censusLand, c.submitted, `${name}: the census counts the triangles the cut submits`);
    }
    const { seam, coarser, hole, dug, away, craterAway, dugAway, far, window, windowHole } = result.cases;
    const level = (l) => +l.split(':')[1];
    // Not vacuous: patches of several levels, vertices met between another patch's, and the seam's two pieces met.
    for (const c of [seam, coarser, hole, dug, window, windowHole]) assert.ok(c.between > 0, 'T-junctions were checked');
    for (const c of [seam, coarser, hole, dug]) assert.ok(c.across > 0 && c.shared > 0, 'across the section seam');
    const depth = (c) => new Set(c.levels.map(level)).size;
    assert.ok(depth(seam) >= 2 && depth(coarser) >= 3, `several levels at once: ${seam.levels} at 3 px, ${coarser.levels} at 12 px`);
    assert.ok(window.levels.some((l) => level(l) < 3) && window.levels.some((l) => level(l) >= 3), `window and coarse patches together: ${window.levels}`);
    // The scene's one scalar moves the cut: a coarser error, fewer patches.
    assert.ok(coarser.submitted < seam.submitted, `${coarser.submitted} triangles at 12 px, ${seam.submitted} at 3`);
    // A pit is ground drawn: the cut goes below the lattice there, in both pieces across the seam, and the vertices
    // at its middle stand as deep as it is, baked in or dug after.
    for (const [name, c] of Object.entries({ hole, dug, windowHole })) {
      assert.ok(c.levels.some((l) => level(l) < 0), `${name}: patches finer than the lattice: ${c.levels}`);
      for (const key of name === 'windowHole' ? ['saba'] : ['0,0', '1,0']) assert.ok(c.deepest[key] < -0.4, `${name}: the pit's middle drawn ${c.deepest[key]} m below the ground in ${key}`);
    }
    assert.ok(seam.levels.every((l) => level(l) >= 0), 'and nowhere else');
    // A great crater brings the cut down where it is, seen from a way off.
    for (const c of [craterAway, dugAway]) assert.ok(c.submitted > away.submitted && c.levels.some((l) => level(l) === 0), `the crater is cut finer: ${away.submitted} triangles without it (${away.levels}), ${c.submitted} with (${c.levels})`);
    // The far end: every piece one patch of one cell, two triangles.
    assert.deepEqual(far.lists, [0, 0, 0, 0, 2]);
    assert.equal(far.submitted, 4);
    // The captures cut coarser than the view.
    for (const [key, p] of Object.entries(seam.pieces)) assert.ok(p.captured.reduce((a, b) => a + b, 0) <= p.view.reduce((a, b) => a + b, 0), `${key}: captures no finer than the view`);
  } finally { await browser?.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

test('the land draws through the continuum and nothing else: no land mesh, no crater draw, no fallback', () => {
  const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const terrain = read('js/terrain.js'), craters = read('js/land-craters.js');
  assert.doesNotMatch(terrain, /islandGeometry|terrainNearGeometry|submergedIndices|fineMesh|craters\.draw\(|craterLand/, 'the old land meshes and the crater draw are gone');
  assert.doesNotMatch(terrain, /'island (vertices|indices)|coastal section \([^)]*\) (vertices|indices|submerged)/, 'no land vertex or index buffer is made');
  assert.match(terrain, /landContinuum\?\.draw\(pass,landClouds\)/);
  assert.match(terrain, /landContinuum\?\.drawCapture\(pass,submergedClouds\)/);
  assert.match(terrain, /\['land',landContinuum\]/, 'the land is in the census');
  assert.doesNotMatch(craters, /createRenderPipeline|beginRenderPass|drawIndexed/, 'the crater tiles draw nothing of their own');
});

test('a coast of the game cuts and draws its land through the continuum', { timeout: 420000 }, async (t) => {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); });
    await page.addInitScript(() => {
      const r = window.landContinuumAudit = { errors: [], buffers: [], pipelines: [], frames: 0, landDraws: 0 };
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) { const d = await request.apply(this, args); d.addEventListener('uncapturederror', (e) => r.errors.push(e.error.message)); return d; };
      const make = GPUDevice.prototype.createBuffer;
      GPUDevice.prototype.createBuffer = function (desc) { if (desc?.label) r.buffers.push(desc.label); return make.call(this, desc); };
      const pipeline = GPUDevice.prototype.createRenderPipelineAsync;
      GPUDevice.prototype.createRenderPipelineAsync = function (desc) { r.pipelines.push(desc.label); return pipeline.call(this, desc); };
      const pass = GPURenderPassEncoder.prototype, set = pass.setPipeline, indirect = pass.drawIndexedIndirect, current = new WeakMap();
      pass.setPipeline = function (p) { current.set(this, p.label); return set.call(this, p); };
      pass.drawIndexedIndirect = function (...args) { if (current.get(this) === 'land continuum') r.landDraws++; return indirect.apply(this, args); };
      const texture = GPUCanvasContext.prototype.getCurrentTexture;
      GPUCanvasContext.prototype.getCurrentTexture = function (...args) { r.frames++; return texture.apply(this, args); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?region=lisbon&landfall=harbor&follower=0`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 240000, polling: 250 });
    assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');
    await page.waitForFunction(() => window.landContinuumAudit.frames > 90, undefined, { timeout: 120000, polling: 200 });
    const result = await page.evaluate(async () => {
      const r = window.landContinuumAudit, terrain = window.oceanFleet.terrain, cut = await terrain.readLandCut();
      const pieces = {};
      for (const [key, [view, captured]] of cut) pieces[key] = { view: view.map((l) => l.length), captured: captured.map((l) => l.length) };
      return {
        errors: r.errors, frames: r.frames, landDraws: r.landDraws, pieces,
        sources: terrain.continuumSources().map((s) => s.name),
        oldBuffers: r.buffers.filter((l) => /^island (vertices|indices)|^submerged island|^coastal section .* (vertices|indices|submerged|restitched)|crater tile cells|crater tiles in use/.test(l)),
        oldPipelines: r.pipelines.filter((l) => /^land craters$|^land under a crater tile$/.test(l)),
      };
    });
    t.diagnostic(JSON.stringify({ frames: result.frames, landDraws: result.landDraws, pieces: result.pieces, sources: result.sources }));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(errors, []);
    assert.ok(result.sources.includes('land'), 'the land is counted against the scene budget');
    assert.ok(result.pieces['0,0'], 'the coast\'s own lattice is a piece');
    // Pieces behind the camera are culled whole; the captures share the camera, so they keep the same pieces.
    const total = (lists) => lists.reduce((a, b) => a + b, 0), seen = Object.keys(result.pieces).filter((key) => total(result.pieces[key].view) > 0);
    assert.ok(total(result.pieces['0,0'].view) > 0 && seen.length > 1, `the coast and its sections in view are cut: ${seen}`);
    for (const [key, p] of Object.entries(result.pieces)) assert.equal(total(p.view) > 0, total(p.captured) > 0, `${key}: the captures cut what the view cuts`);
    assert.ok(result.landDraws >= result.frames * 5 * 0.5, `indirect land draws every frame: ${result.landDraws} over ${result.frames} frames`);
    assert.deepEqual(result.oldBuffers, [], 'no land mesh is uploaded');
    assert.deepEqual(result.oldPipelines, [], 'no crater pipeline is made');
  } finally { await browser?.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});
