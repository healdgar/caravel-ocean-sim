// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What shot has done to the ground. The ledger is the record of it: a few numbers per crater, and what is saved.
// Everything drawn follows from the ledger. JavaScript runs here only when a ball lands or a piece of land comes
// or goes, and then writes the tiles concerned. Each frame the GPU draws what they hold.
//
// Height queries do not see any of this. A pit is a metre or two across on ground the mesh holds at 16 m, and
// shot, walkers and hulls keep the land they always had (js/terrain.js height and groundSample).
import { LAND_CRATER_BAKE, LAND_CRATER_CAPTURE, LAND_CRATER_CELL_M, LAND_CRATER_DRAWN_CELLS, LAND_CRATER_GUTTER, LAND_CRATER_PER_TILE, LAND_CRATER_REACH, LAND_CRATER_TEXELS, LAND_CRATER_TILE_M } from './wgsl/land-craters.js';

const CRATER_REFERENCE_J = 1.1e6;
const CRATER_MERGE_WITHIN = 0.8;
const CRATER_LEDGER_LIMIT = 512;
const CRATER_SAVED_NUMBERS = 6;
const CRATER_RECORD_FLOATS = 10;
const CRATER_FIRST_LAYERS = 32;
const CRATER_INSTANCE_FLOATS = 4;

// A 24-pounder at 450 m/s digs about a cubic metre: a pit you could lie in, thrown out over a few paces. Energy
// goes as the volume dug, so repeated hits on one spot widen and deepen it by the cube root of what they add up to.
export function landCraterSize(energyJ) {
  const scale = Math.cbrt(Math.max(energyJ, 2e4) / CRATER_REFERENCE_J);
  const depth = Math.min(2.8, 0.55 * scale);
  return { radius: Math.min(6.5, 1.2 * scale), depth, rim: depth * 0.32 };
}

// How far from its centre a crater can touch anything, on sand, the widest ground.
export function landCraterReach(record) {
  return landCraterSize(record.energyJ).radius * 1.14 * LAND_CRATER_REACH * (1 + 0.32 * record.grazing);
}

const craterSeed = (x, z) => { const value = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return value - Math.floor(value); };
const craterRound = (value) => Math.round(value * 10) / 10;

/**
 * The craters of one coast. `saved` is what `snapshot` gave; positions are saved from the coast's own centre,
 * since the same coast can be laid out elsewhere on a later visit.
 */
export function createLandCraterLedger(saved = null, origin = { x: 0, z: 0 }) {
  const records = [];
  if (Array.isArray(saved)) {
    for (let at = 0; at + CRATER_SAVED_NUMBERS <= saved.length; at += CRATER_SAVED_NUMBERS) {
      const [x, z, kj, heading, grazing, sand] = saved.slice(at, at + CRATER_SAVED_NUMBERS);
      if (![x, z, kj, heading, grazing, sand].every(Number.isFinite)) continue;
      const angle = heading * Math.PI / 180;
      records.push({ x: origin.x + x / 10, z: origin.z + z / 10, energyJ: kj * 1000, hx: Math.cos(angle), hz: Math.sin(angle), grazing: grazing / 100, sand: sand / 100 });
    }
  }
  const nearest = (x, z, within) => {
    let best = null, bestDistance = Infinity;
    for (const record of records) {
      const distance = Math.hypot(record.x - x, record.z - z), reach = within(record);
      if (distance <= reach && distance < bestDistance) { best = record; bestDistance = distance; }
    }
    return best;
  };
  return {
    records,
    // A ball lands. Near an old crater it adds to that crater, which grows toward the new hit; otherwise it starts one.
    strike({ x, z, energyJ, velocity = [0, -1, 0], normal = [0, 1, 0], sand = 0 }) {
      const speed = Math.hypot(velocity[0], velocity[1], velocity[2]) || 1, level = Math.hypot(velocity[0], velocity[2]) || 1;
      const hx = velocity[0] / level, hz = velocity[2] / level;
      const grazing = Math.max(0, Math.min(1, 1 - Math.abs(velocity[0] * normal[0] + velocity[1] * normal[1] + velocity[2] * normal[2]) / speed));
      let record = nearest(x, z, (old) => landCraterSize(old.energyJ).radius * CRATER_MERGE_WITHIN);
      if (!record && records.length >= CRATER_LEDGER_LIMIT) record = nearest(x, z, () => Infinity);
      if (!record) {
        record = { x: craterRound(x), z: craterRound(z), energyJ, hx, hz, grazing, sand };
        records.push(record);
        return record;
      }
      const total = record.energyJ + energyJ, share = energyJ / total;
      record.x = craterRound(record.x + (x - record.x) * share);
      record.z = craterRound(record.z + (z - record.z) * share);
      const mx = record.hx + (hx - record.hx) * share, mz = record.hz + (hz - record.hz) * share, ml = Math.hypot(mx, mz) || 1;
      record.hx = mx / ml; record.hz = mz / ml;
      record.grazing += (grazing - record.grazing) * share;
      record.sand += (sand - record.sand) * share;
      record.energyJ = total;
      return record;
    },
    // Whether a point lies in a bowl or under its rim, where nothing goes on growing.
    covers(x, z) {
      for (const record of records) if (Math.hypot(record.x - x, record.z - z) < landCraterSize(record.energyJ).radius * 1.35) return true;
      return false;
    },
    // Six numbers a crater, the largest first so that a share link can keep what shows most.
    snapshot(limit = Infinity) {
      if (!records.length) return undefined;
      const out = [];
      for (const record of [...records].sort((a, b) => b.energyJ - a.energyJ).slice(0, limit)) {
        out.push(Math.round((record.x - origin.x) * 10), Math.round((record.z - origin.z) * 10), Math.round(record.energyJ / 1000),
          Math.round(Math.atan2(record.hz, record.hx) * 180 / Math.PI), Math.round(record.grazing * 100), Math.round(record.sand * 100));
      }
      return out;
    },
  };
}

/**
 * Keeps tiles of damaged ground in step with a ledger, and draws them.
 *   surfaces()       the land's meshes now: [{vertices,indices,count,region}]
 *   sectionAt(x,z)   which draw a point belongs to, or null where no land is loaded
 *   groundAt(x,z)    a rough height, as the tile's zero
 */
export function createLandCraters({ device, module, shader, computePipe, format, samples, ledger, surfaces, sectionAt, groundAt, maxLayers = 384 }) {
  const tiles = new Map();
  const quadIndices = new Uint16Array(LAND_CRATER_DRAWN_CELLS * LAND_CRATER_DRAWN_CELLS * 6);
  for (let j = 0, at = 0; j < LAND_CRATER_DRAWN_CELLS; j++) {
    for (let i = 0; i < LAND_CRATER_DRAWN_CELLS; i++, at += 6) {
      const k = j * (LAND_CRATER_DRAWN_CELLS + 1) + i;
      quadIndices.set([k, k + LAND_CRATER_DRAWN_CELLS + 1, k + LAND_CRATER_DRAWN_CELLS + 2, k, k + LAND_CRATER_DRAWN_CELLS + 2, k + 1], at);
    }
  }
  let indexBuffer = null, instanceBuffer = null, instanceSlots = 0, instances = new Float32Array(0);
  let groundTexture = null, fieldTexture = null, layerCount = 0, freeLayers = [];
  let recordBuffer = null, jobBuffer = null, listBuffer = null;
  let renderPipeline = null, bakePipeline = null, capturePipeline = null, fieldGroup = null, sampler = null;
  const retired = [];
  let draws = new Map(), overflow = false, anchor = { x: 0, z: 0 }, movedFrom = null, wanting = false, disposed = false;
  const stats = { tiles: 0, layers: 0, captures: 0, bakes: 0, overflow: false, get craters() { return ledger.records.length; } };
  const keyOf = (ix, iz) => `${ix},${iz}`;

  function storage(current, bytes, label) {
    if (current && current.size >= bytes) return current;
    current?.destroy();
    return device.createBuffer({ label, size: Math.max(256, bytes * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  function ensureLayers(encoder, needed) {
    if (needed <= layerCount) return;
    let next = Math.max(CRATER_FIRST_LAYERS, layerCount);
    while (next < needed) next *= 2;
    next = Math.min(next, Math.max(maxLayers, needed));
    const size = [LAND_CRATER_TEXELS, LAND_CRATER_TEXELS, next];
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const ground = device.createTexture({ label: 'land as it was, by crater tile', size, format: 'rgba16float', usage: usage | GPUTextureUsage.RENDER_ATTACHMENT });
    const field = device.createTexture({ label: 'land dug up, by crater tile', size, format: 'rgba16float', usage: usage | GPUTextureUsage.STORAGE_BINDING });
    if (layerCount) {
      const copied = [LAND_CRATER_TEXELS, LAND_CRATER_TEXELS, layerCount];
      encoder.copyTextureToTexture({ texture: groundTexture }, { texture: ground }, copied);
      encoder.copyTextureToTexture({ texture: fieldTexture }, { texture: field }, copied);
      // The old pair is in use by this encoder until it is submitted.
      retired.push(groundTexture, fieldTexture);
    }
    for (let layer = next - 1; layer >= layerCount; layer--) freeLayers.push(layer);
    groundTexture = ground; fieldTexture = field; layerCount = next; stats.layers = next;
    fieldGroup = device.createBindGroup({ layout: renderPipeline.getBindGroupLayout(2), entries: [
      { binding: 0, resource: ground.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: field.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: sampler },
    ] });
  }
  // Every tile each crater reaches, and each tile's craters. Where too many crowd one, the nearest its middle count.
  function tilesWanted() {
    const wanted = new Map();
    ledger.records.forEach((record, index) => {
      const reach = landCraterReach(record);
      const x0 = Math.floor((record.x - reach) / LAND_CRATER_TILE_M), x1 = Math.floor((record.x + reach) / LAND_CRATER_TILE_M);
      const z0 = Math.floor((record.z - reach) / LAND_CRATER_TILE_M), z1 = Math.floor((record.z + reach) / LAND_CRATER_TILE_M);
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
        const key = keyOf(ix, iz);
        let tile = wanted.get(key);
        if (!tile) {
          const x = ix * LAND_CRATER_TILE_M, z = iz * LAND_CRATER_TILE_M, section = sectionAt(x + LAND_CRATER_TILE_M / 2, z + LAND_CRATER_TILE_M / 2);
          if (section === null) continue;
          tile = { key, x, z, section, craters: [] };
          wanted.set(key, tile);
        }
        tile.craters.push(index);
      }
    });
    overflow = wanted.size > maxLayers;
    stats.overflow = overflow;
    if (overflow) {
      const away = (tile) => Math.hypot(tile.x + LAND_CRATER_TILE_M / 2 - anchor.x, tile.z + LAND_CRATER_TILE_M / 2 - anchor.z);
      const far = [...wanted.values()].sort((a, b) => away(b) - away(a));
      for (const tile of far.slice(0, wanted.size - maxLayers)) wanted.delete(tile.key);
    }
    for (const tile of wanted.values()) {
      if (tile.craters.length <= LAND_CRATER_PER_TILE) continue;
      const away = (index) => Math.hypot(ledger.records[index].x - tile.x - LAND_CRATER_TILE_M / 2, ledger.records[index].z - tile.z - LAND_CRATER_TILE_M / 2);
      tile.craters.sort((a, b) => away(a) - away(b));
      tile.craters.length = LAND_CRATER_PER_TILE;
    }
    return wanted;
  }
  const touches = (tile, region) => {
    const half = region.span / 2;
    return tile.x + LAND_CRATER_TILE_M + 1 >= region.x - half && tile.x - 1 <= region.x + half && tile.z + LAND_CRATER_TILE_M + 1 >= region.z - half && tile.z - 1 <= region.z + half;
  };
  function capture(encoder, list) {
    const meshes = surfaces();
    for (const tile of list) {
      const pass = encoder.beginRenderPass({ label: 'land under a crater tile', colorAttachments: [{
        view: groundTexture.createView({ dimension: '2d', baseArrayLayer: tile.layer, arrayLayerCount: 1 }),
        clearValue: { r: 0, g: 0, b: 0, a: -1 }, loadOp: 'clear', storeOp: 'store',
      }] });
      pass.setPipeline(capturePipeline);
      pass.setVertexBuffer(1, instanceBuffer);
      for (const mesh of meshes) {
        if (!mesh.count || (mesh.region && !touches(tile, mesh.region))) continue;
        pass.setVertexBuffer(0, mesh.vertices);
        pass.setIndexBuffer(mesh.indices, 'uint32');
        pass.drawIndexed(mesh.count, 1, 0, 0, tile.slot);
      }
      pass.end();
      tile.captured = true;
      stats.captures++;
    }
  }
  function bake(encoder, list) {
    const packed = new Float32Array(ledger.records.length * CRATER_RECORD_FLOATS);
    ledger.records.forEach((record, index) => {
      const size = landCraterSize(record.energyJ);
      packed.set([record.x, record.z, size.radius, size.depth, record.hx, record.hz, record.grazing, craterSeed(record.x, record.z), record.sand], index * CRATER_RECORD_FLOATS);
    });
    const jobs = new ArrayBuffer(list.length * 32), floats = new Float32Array(jobs), words = new Uint32Array(jobs), craterList = [];
    list.forEach((tile, index) => {
      floats.set([tile.x, tile.z, tile.floorY], index * 8);
      words.set([tile.layer, craterList.length, tile.craters.length], index * 8 + 3);
      craterList.push(...tile.craters);
      stats.bakes++;
    });
    const lists = new Uint32Array(craterList.length || 1);
    lists.set(craterList);
    recordBuffer = storage(recordBuffer, packed.byteLength, 'craters');
    jobBuffer = storage(jobBuffer, jobs.byteLength, 'crater tiles to work out');
    listBuffer = storage(listBuffer, lists.byteLength, 'craters by tile');
    device.queue.writeBuffer(recordBuffer, 0, packed);
    device.queue.writeBuffer(jobBuffer, 0, jobs);
    device.queue.writeBuffer(listBuffer, 0, lists);
    const pass = encoder.beginComputePass({ label: 'work out crater tiles' });
    pass.setPipeline(bakePipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: bakePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: recordBuffer } },
      { binding: 1, resource: { buffer: jobBuffer } },
      { binding: 2, resource: { buffer: listBuffer } },
      { binding: 3, resource: groundTexture.createView({ dimension: '2d-array' }) },
      { binding: 4, resource: fieldTexture.createView({ dimension: '2d-array' }) },
    ] }));
    pass.dispatchWorkgroups(9, 9, list.length);
    pass.end();
  }
  // Bring tiles and draws in line with the ledger. `changed`, if given, is the one crater that moved.
  function refresh(changed = null) {
    if (disposed) return;
    if (!renderPipeline) { wanting = true; return; }
    const wanted = tilesWanted();
    const encoder = device.createCommandEncoder({ label: 'crater tiles' });
    for (const [key, tile] of tiles) if (!wanted.has(key)) { freeLayers.push(tile.layer); tiles.delete(key); }
    ensureLayers(encoder, wanted.size);
    const touched = changed ? ledger.records.indexOf(changed) : -1, toBake = [];
    for (const [key, want] of wanted) {
      let tile = tiles.get(key);
      if (!tile) {
        tile = { ...want, layer: freeLayers.pop(), floorY: groundAt(want.x + LAND_CRATER_TILE_M / 2, want.z + LAND_CRATER_TILE_M / 2), captured: false, baked: false };
        tiles.set(key, tile);
      } else {
        tile.section = want.section;
      }
      const moved = tile.craters.length !== want.craters.length || tile.craters.some((v, i) => v !== want.craters[i]);
      tile.craters = want.craters;
      if (!tile.baked || moved || want.craters.includes(touched)) toBake.push(tile);
    }
    // Grouped by section, since each section draws with its own land textures.
    const bySection = new Map();
    for (const tile of tiles.values()) { if (!bySection.has(tile.section)) bySection.set(tile.section, []); bySection.get(tile.section).push(tile); }
    if (tiles.size > instanceSlots) {
      instanceBuffer?.destroy();
      instanceSlots = Math.max(64, tiles.size * 2);
      instanceBuffer = device.createBuffer({ label: 'crater tiles in use', size: instanceSlots * CRATER_INSTANCE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      instances = new Float32Array(instanceSlots * CRATER_INSTANCE_FLOATS);
    }
    draws = new Map();
    let slot = 0;
    for (const [section, list] of bySection) {
      draws.set(section, { first: slot, count: list.length });
      for (const tile of list) {
        tile.slot = slot;
        instances.set([tile.x, tile.z, tile.floorY, tile.layer], slot * CRATER_INSTANCE_FLOATS);
        slot++;
      }
    }
    if (slot) device.queue.writeBuffer(instanceBuffer, 0, instances, 0, slot * CRATER_INSTANCE_FLOATS);
    capture(encoder, toBake.filter((tile) => !tile.captured));
    if (toBake.length) {
      bake(encoder, toBake);
      for (const tile of toBake) tile.baked = true;
    }
    stats.tiles = tiles.size;
    device.queue.submit([encoder.finish()]);
    for (const texture of retired.splice(0)) texture.destroy();
  }
  const ready = (async () => {
    sampler = device.createSampler({ label: 'crater tiles', minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    indexBuffer = device.createBuffer({ label: 'crater tile cells', size: quadIndices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indexBuffer, 0, quadIndices);
    const captureModule = await shader(LAND_CRATER_CAPTURE, 'land under a crater tile');
    const tileLayout = { arrayStride: CRATER_INSTANCE_FLOATS * 4, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] };
    const landLayout = { arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }] };
    const [render, compute, grab] = await Promise.all([
      device.createRenderPipelineAsync({ label: 'land craters', layout: 'auto',
        vertex: { module, entryPoint: 'landCraterVS', buffers: [{ arrayStride: CRATER_INSTANCE_FLOATS * 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
        fragment: { module, entryPoint: 'landCraterFS', targets: [{ format }] },
        // No culling. The pit lies below the land's triangles, so a tiny facet turned away and left out would
        // show the land through the wall behind it. The nearest ground wins by depth, as it should.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples } }),
      computePipe(LAND_CRATER_BAKE, 'land crater tiles'),
      device.createRenderPipelineAsync({ label: 'land under a crater tile', layout: 'auto',
        vertex: { module: captureModule, entryPoint: 'landCraterCaptureVS', buffers: [landLayout, tileLayout] },
        fragment: { module: captureModule, entryPoint: 'landCraterCaptureFS', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' } }),
    ]);
    if (disposed) return;
    renderPipeline = render; bakePipeline = compute; capturePipeline = grab;
    if (wanting || ledger.records.length) refresh();
  })();
  ready.catch((error) => console.error('Land craters unavailable', error));
  return {
    stats, ledger, ready,
    get pipeline() { return renderPipeline; },
    // A ball has landed. Worked out and on the GPU before this frame's drawing starts.
    strike(hit) {
      const record = ledger.strike(hit);
      anchor = { x: hit.x, z: hit.z };
      refresh(record);
      return record;
    },
    // Land has changed under the tiles, or a section has come or gone. `region` limits it to the tiles there.
    invalidate(region = null) {
      for (const tile of tiles.values()) if (!region || touches(tile, region)) { tile.captured = false; tile.baked = false; }
      if (ledger.records.length) refresh();
    },
    // When the craters will not all fit, the ones nearest the camera get the tiles.
    follow(camera) {
      if (!overflow) return;
      if (movedFrom && Math.hypot(camera.x - movedFrom.x, camera.z - movedFrom.z) < 64) return;
      movedFrom = { x: camera.x, z: camera.z };
      anchor = movedFrom;
      refresh();
    },
    draw(pass, section, landGroup, cloudGroup) {
      const range = draws.get(section);
      if (!range?.count || !fieldGroup) return;
      pass.setPipeline(renderPipeline);
      pass.setBindGroup(0, landGroup);
      pass.setBindGroup(1, cloudGroup);
      pass.setBindGroup(2, fieldGroup);
      pass.setVertexBuffer(0, instanceBuffer);
      pass.setIndexBuffer(indexBuffer, 'uint16');
      pass.drawIndexed(quadIndices.length, range.count, 0, 0, range.first);
    },
    // What the tiles hold at a point. For tests and for looking into what went wrong.
    async probe(x, z) {
      const tile = tiles.get(keyOf(Math.floor(x / LAND_CRATER_TILE_M), Math.floor(z / LAND_CRATER_TILE_M)));
      if (!tile) return null;
      const texel = (world, origin) => Math.round((world - origin) / LAND_CRATER_CELL_M) + LAND_CRATER_GUTTER;
      const read = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      for (const [index, texture] of [groundTexture, fieldTexture].entries()) {
        encoder.copyTextureToBuffer({ texture, origin: [texel(x, tile.x), texel(z, tile.z), tile.layer] }, { buffer: read, offset: index * 256, bytesPerRow: 256 }, [1, 1, 1]);
      }
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const half = new Uint16Array(read.getMappedRange().slice(0));
      read.destroy();
      const value = (bits) => { const sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023; return sign * (e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15)); };
      return { groundY: tile.floorY + value(half[0]), kind: value(half[3]), height: value(half[128]), soil: value(half[129]), sand: value(half[130]), cover: value(half[131]) };
    },
    dispose() {
      disposed = true;
      indexBuffer?.destroy(); instanceBuffer?.destroy(); groundTexture?.destroy(); fieldTexture?.destroy();
      recordBuffer?.destroy(); jobBuffer?.destroy(); listBuffer?.destroy();
    },
  };
}
