// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Draws the generated, textured models about the nearest port. JavaScript uploads them once when a port
// comes into reach. After that it sends only what changes: a prop's reach when what it stood on has gone, and a
// prop's shard flights when a shot breaks it and again as each shard comes to rest. The shaders do the rest, whole
// props and broken ones in the same draw. Each model's texture is decoded by the browser, and loaded only once a
// port needs it.
import { PROP_MODELS, PROP_WORDS, preparePortJetties, propDrawRadius, readPropModel, stepJettyFracture } from './port-props.js';
import { SIM_CLOCK_LOOP_S } from './wgsl/common.js';
import { PROP_DRAW_WORDS, PROPS_CULL, PROPS_RENDER, PROPS_SHADOW } from './wgsl/props.js';

const PROP_REACH_M = 3000;
const PROP_CHECK_FRAMES = 30;
const PROP_BYTES = PROP_WORDS * 4;
const VERTEX_BYTES = 32;
// Storage bindings start on 256 bytes, so each model's list starts on a whole number of these.
const LIST_ALIGNMENT = 256 / PROP_BYTES;
// A prop's block in the shard records: one vec4f for its clock, then each shard's flight.
const BLOCK_HEAD_FLOATS = 4;
const VERTEX_LAYOUT = Object.freeze([
  {
    arrayStride: VERTEX_BYTES,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
    ],
  },
  { arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'uint32' }] },
]);

// Half-size steps from the decoded image down to one pixel.
async function uploadPigment(device, model) {
  const bitmap = await createImageBitmap(new Blob([model.image], { type: model.mime }), { colorSpaceConversion: 'none' });
  const levels = Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1;
  const texture = device.createTexture({ label: 'prop pigment', size: [bitmap.width, bitmap.height], mipLevelCount: levels, format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  for (let level = 0; level < levels; level++) {
    const width = Math.max(1, bitmap.width >> level), height = Math.max(1, bitmap.height >> level);
    const source = level ? await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high', colorSpaceConversion: 'none' }) : bitmap;
    device.queue.copyExternalImageToTexture({ source }, { texture, mipLevel: level }, [width, height]);
    if (level) source.close();
  }
  bitmap.close();
  return texture;
}

export function createProps({ device, frameUBO, transView, skyView, sampClamp, envCubeView, sunVisBuf, shadows, shader, format = 'rgba16float', samples = 4 }) {
  const B = GPUBufferUsage;
  const buffer = (label, data, usage) => { const b = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | B.COPY_DST }); device.queue.writeBuffer(b, 0, data); return b; };
  const radiusWord = new Float32Array(1);
  let kit = null, kitLoading = null, unavailable = false, activePort = null, scene = null, frameCount = 0;

  // Nothing here costs anything until a port is near, and a failed download only leaves the port as it was.
  function loadKit() {
    kitLoading ??= (async () => {
      const models = await Promise.all(PROP_MODELS.map(async (spec) => {
        const response = await fetch(spec.file);
        if (!response.ok) throw Error(`Prop asset unavailable: ${spec.file}`);
        return readPropModel(new Uint8Array(await response.arrayBuffer()), spec);
      }));
      const [renderModule, shadowModule, cullModule] = await Promise.all([
        shader(PROPS_RENDER, 'props'),
        shader(PROPS_SHADOW, 'props shadow'),
        shader(PROPS_CULL, 'props cull'),
      ]);
      const [pipeline, shadowPipeline, cullPipeline, resetPipeline] = await Promise.all([
        device.createRenderPipelineAsync({
          label: 'props', layout: 'auto',
          vertex: { module: renderModule, entryPoint: 'propVS', buffers: VERTEX_LAYOUT },
          fragment: { module: renderModule, entryPoint: 'propFS', targets: [{ format }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
          multisample: { count: samples },
        }),
        device.createRenderPipelineAsync({
          label: 'props shadow', layout: 'auto',
          vertex: { module: shadowModule, entryPoint: 'propShadowVS', buffers: VERTEX_LAYOUT },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
        }),
        device.createComputePipelineAsync({ label: 'props cull', layout: 'auto', compute: { module: cullModule, entryPoint: 'main' } }),
        device.createComputePipelineAsync({ label: 'props reset', layout: 'auto', compute: { module: cullModule, entryPoint: 'reset' } }),
      ]);
      const vertexCount = models.reduce((sum, m) => sum + m.vertices.length, 0), vertices = new Float32Array(vertexCount), shardIds = new Uint32Array(vertexCount / 8), indexCount = models.reduce((sum, m) => sum + m.indices.length, 0), indices = new Uint32Array(indexCount);
      let vertexAt = 0, indexAt = 0;
      const pieces = [];
      for (const model of models) {
        const baseVertex = vertexAt / 8;
        vertices.set(model.vertices, vertexAt);
        shardIds.set(model.fracture.shardOfVertex, baseVertex);
        indices.set(model.indices, indexAt);
        pieces.push({ model, baseVertex, firstIndex: indexAt, indexCount: model.indices.length, pigment: await uploadPigment(device, model) });
        vertexAt += model.vertices.length;
        indexAt += model.indices.length;
      }
      // The shader shared with hulls looks up a ship for its gun flashes. There is none ashore.
      const hullData = new Float32Array(52);
      hullData.set([1, 0, 0, 1], 0); hullData.set([0, 1, 0, 0], 4); hullData.set([0, 0, -1, 0], 8); hullData.set([3.6, 12, 1, 1], 12);
      kit = {
        models,
        pieces, pipeline, shadowPipeline, cullPipeline, resetPipeline,
        lighting: shadows.bind(pipeline),
        vertexBuffer: buffer('prop vertices', vertices, B.VERTEX),
        shardBuffer: buffer('prop shard ids', shardIds, B.VERTEX),
        indexBuffer: buffer('prop indices', indices, B.INDEX),
        hull: buffer('prop ship stand-in', hullData, B.UNIFORM),
        sampler: device.createSampler({ label: 'prop pigment', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 }),
      };
    })().catch((error) => { unavailable = true; console.warn(error.message); });
    return kitLoading;
  }

  function dispose() {
    if (!scene) return;
    for (const item of scene.entries) if (item.prop.fracture?.onStruck === item.struck) item.prop.fracture.onStruck = null;
    for (const b of [scene.props, scene.shown, scene.draws, scene.records]) b.destroy();
    scene = null;
  }

  const ownerGone = (inst) => { const state = inst?.damageState?.state; return state === 'ruined' || state === 'breached'; };
  const ownerStateOf = (item) => item.inst?.damageState?.state ?? null;

  function buildScene(port) {
    dispose();
    const placed = port?.props;
    if (!placed?.length || !kit) return;
    // Every prop has its shards and its flight records from here on, as saved damage left them if there was any.
    preparePortJetties(port, kit.models);
    const counts = kit.pieces.map((_, m) => placed.filter((p) => p.model === m).length), starts = [], words = new ArrayBuffer(placed.length * PROP_BYTES), floats = new Float32Array(words), ints = new Uint32Array(words);
    let span = 0;
    for (const count of counts) { starts.push(span); span += Math.max(1, Math.ceil(count / LIST_ALIGNMENT)) * LIST_ALIGNMENT; }
    let recordFloats = 0;
    const entries = placed.map((prop, at) => {
      const item = { at, prop, inst: prop.owner >= 0 ? port.instances[prop.owner] : null, block: recordFloats, struck: null };
      recordFloats += BLOCK_HEAD_FLOATS + prop.fracture.flight.records.length;
      return item;
    });
    const recordData = new Float32Array(recordFloats), struck = new Set(), owners = new Map();
    for (const item of entries) {
      const { prop, at } = item, piece = kit.pieces[prop.model], word = at * PROP_WORDS, state = prop.fracture;
      floats.set([prop.x, prop.y ?? piece.model.standsAt, prop.z, prop.yaw], word);
      ints[word + 4] = item.block / 4; ints[word + 5] = prop.model; ints[word + 6] = starts[prop.model];
      floats[word + 7] = propDrawRadius(prop, piece.model, ownerStateOf(item));
      recordData.set(state.flight.records, item.block + BLOCK_HEAD_FLOATS);
      state.flight.dirty.clear();
      item.struck = () => struck.add(item);
      state.onStruck = item.struck;
      // Timber still in the air from before this port was last out of reach: the first frame sets its clock.
      if (state.flight.flying.size) struck.add(item);
      if (item.inst) { if (!owners.has(item.inst)) owners.set(item.inst, { gone: ownerGone(item.inst), items: [] }); owners.get(item.inst).items.push(item); }
    }
    const drawWords = new Uint32Array(kit.pieces.length * PROP_DRAW_WORDS);
    kit.pieces.forEach((piece, m) => { drawWords.set([piece.indexCount, 0, piece.firstIndex, piece.baseVertex, 0], m * PROP_DRAW_WORDS); });
    const props = buffer('props', new Uint8Array(words), B.STORAGE), shown = device.createBuffer({ label: 'props shown', size: span * PROP_BYTES, usage: B.STORAGE }), draws = buffer('prop draws', drawWords, B.STORAGE | B.INDIRECT), records = buffer('prop shard records', recordData, B.STORAGE);
    const cullGroup = device.createBindGroup({ label: 'props cull', layout: kit.cullPipeline.getBindGroupLayout(0), entries: [frameUBO, props, shown, draws].map((b, binding) => ({ binding, resource: { buffer: b } })) });
    const resetGroup = device.createBindGroup({ label: 'props reset', layout: kit.resetPipeline.getBindGroupLayout(0), entries: [{ binding: 3, resource: { buffer: draws } }] });
    const listOf = (m) => ({ buffer: shown, offset: starts[m] * PROP_BYTES, size: Math.max(1, Math.ceil(counts[m] / LIST_ALIGNMENT)) * LIST_ALIGNMENT * PROP_BYTES });
    const groups = kit.pieces.map((piece, m) => device.createBindGroup({
      label: 'props', layout: kit.pipeline.getBindGroupLayout(0),
      entries: [
        [0, { buffer: frameUBO }], [1, { buffer: kit.hull }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
        [10, listOf(m)], [11, piece.pigment.createView()], [12, kit.sampler], [13, { buffer: records }],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
    const shadowGroups = kit.pieces.map((_, m) => device.createBindGroup({
      label: 'props shadow', layout: kit.shadowPipeline.getBindGroupLayout(0),
      entries: [[0, { buffer: shadows.uniform }], [1, listOf(m)], [2, { buffer: records }], [3, { buffer: frameUBO }]].map(([binding, resource]) => ({ binding, resource })),
    }));
    scene = { count: placed.length, props, shown, draws, records, recordData, cullGroup, resetGroup, groups, shadowGroups, entries, owners, struck, flying: new Set() };
  }

  function sendRadius(item) {
    radiusWord[0] = propDrawRadius(item.prop, kit.pieces[item.prop.model].model, ownerStateOf(item));
    device.queue.writeBuffer(scene.props, item.at * PROP_BYTES + 28, radiusWord);
  }
  // A prop's flights as they now stand, with the frame time at which its debris clock read zero.
  function sendFlights(item, simTime) {
    const state = item.prop.fracture, flight = state.flight, data = scene.recordData, length = BLOCK_HEAD_FLOATS + flight.records.length;
    if (simTime !== null) data[item.block] = (((simTime - (state.now - flight.epoch)) % SIM_CLOCK_LOOP_S) + SIM_CLOCK_LOOP_S) % SIM_CLOCK_LOOP_S;
    data.set(flight.records, item.block + BLOCK_HEAD_FLOATS);
    flight.dirty.clear();
    device.queue.writeBuffer(scene.records, item.block * 4, data, item.block, length);
  }
  // What stood on a pier goes when the pier does. A pier is asked, not each thing on it.
  function followOwners() {
    for (const [inst, owner] of scene.owners) {
      const gone = ownerGone(inst);
      if (gone === owner.gone) continue;
      owner.gone = gone;
      for (const item of owner.items) sendRadius(item);
    }
  }
  // Only props a shot has broken are visited, and only while their timber is in the air or going under.
  function stepDebris(dt, simTime) {
    if (dt > 0) for (const item of scene.flying) {
      const flight = item.prop.fracture.flight, flying = stepJettyFracture(item.prop, dt);
      if (flight.dirty.size) sendFlights(item, null);
      if (!flying) { scene.flying.delete(item); sendRadius(item); }
    }
    if (!scene.struck.size) return;
    for (const item of scene.struck) {
      scene.flying.add(item);
      sendFlights(item, simTime);
      sendRadius(item);
    }
    scene.struck.clear();
  }

  return {
    get count() { return scene?.count ?? 0; },
    get placed() { return activePort?.props ?? []; },
    get port() { return activePort; },
    get models() { return kit?.models ?? []; },
    follow(ports, camera) {
      if (frameCount++ % PROP_CHECK_FRAMES || unavailable) return;
      let best = null, bestDistance = PROP_REACH_M;
      for (const port of ports ?? []) {
        if (!port?.props?.length) continue;
        const d = Math.hypot(port.center.x - camera.x, port.center.z - camera.z);
        if (d < bestDistance) { bestDistance = d; best = port; }
      }
      if (best && !kit) { loadKit(); return; }
      if (best !== activePort) { activePort = best; buildScene(best); }
      if (scene) followOwners();
    },
    // `dt` and `simTime` are the simulation's: paused, debris hangs where it is, as the sea does.
    encode(pass, dt = 0, simTime = 0) {
      if (!scene) return;
      if (scene.struck.size || scene.flying.size) stepDebris(dt, simTime);
      pass.setPipeline(kit.resetPipeline);
      pass.setBindGroup(0, scene.resetGroup);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(kit.cullPipeline);
      pass.setBindGroup(0, scene.cullGroup);
      pass.dispatchWorkgroups(Math.ceil(scene.count / 64));
    },
    draw(pass) {
      if (!scene) return;
      pass.setPipeline(kit.pipeline);
      pass.setBindGroup(1, kit.lighting);
      pass.setVertexBuffer(0, kit.vertexBuffer);
      pass.setVertexBuffer(1, kit.shardBuffer);
      pass.setIndexBuffer(kit.indexBuffer, 'uint32');
      for (let m = 0; m < kit.pieces.length; m++) {
        pass.setBindGroup(0, scene.groups[m]);
        pass.drawIndexedIndirect(scene.draws, m * PROP_DRAW_WORDS * 4);
      }
    },
    drawShadow(pass) {
      if (!scene || !kit) return;
      pass.setPipeline(kit.shadowPipeline);
      pass.setVertexBuffer(0, kit.vertexBuffer);
      pass.setVertexBuffer(1, kit.shardBuffer);
      pass.setIndexBuffer(kit.indexBuffer, 'uint32');
      for (let m = 0; m < kit.pieces.length; m++) {
        pass.setBindGroup(0, scene.shadowGroups[m]);
        pass.drawIndexedIndirect(scene.draws, m * PROP_DRAW_WORDS * 4);
      }
    },
    destroy() { dispose(); },
  };
}
