// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Draws the generated, textured models about the nearest port. JavaScript uploads them once when a port
// comes into reach, and after that only says when a building they stood on has gone or when a prop itself
// is broken apart by cannonfire. Each model's texture is decoded by the browser, and loaded only once a port needs it.
import { PROP_MODELS, PROP_WORDS, preparePortJetties, readPropModel, stepJettyFracture } from './port-props.js';
import { FRACTURE_GRAVITY } from './ship-fracture.js';
import { PROP_DRAW_WORDS, PROPS_CULL, PROPS_FRACTURED_RENDER, PROPS_RENDER, PROPS_SHADOW } from './wgsl/props.js';

const PROP_REACH_M = 3000;
const PROP_CHECK_FRAMES = 30;
const PROP_BYTES = PROP_WORDS * 4;
const VERTEX_BYTES = 32;
// Storage bindings start on 256 bytes, so each model's list starts on a whole number of these.
const LIST_ALIGNMENT = 256 / PROP_BYTES;
const VERTEX_LAYOUT = Object.freeze([{
  arrayStride: VERTEX_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
  ],
}]);
const FRACTURED_VERTEX_LAYOUT = Object.freeze([
  ...VERTEX_LAYOUT,
  {
    arrayStride: 4,
    attributes: [
      { shaderLocation: 3, offset: 0, format: 'uint32' },
    ],
  },
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
  let kit = null, kitLoading = null, unavailable = false, activePort = null, scene = null, frameCount = 0;

  // Nothing here costs anything until a port is near, and a failed download only leaves the port as it was.
  function loadKit() {
    kitLoading ??= (async () => {
      const models = await Promise.all(PROP_MODELS.map(async (spec) => {
        const response = await fetch(spec.file);
        if (!response.ok) throw Error(`Prop asset unavailable: ${spec.file}`);
        return readPropModel(new Uint8Array(await response.arrayBuffer()), spec);
      }));
      const [renderModule, fracturedModule, shadowModule, cullModule] = await Promise.all([
        shader(PROPS_RENDER, 'props'),
        shader(PROPS_FRACTURED_RENDER, 'props fractured'),
        shader(PROPS_SHADOW, 'props shadow'),
        shader(PROPS_CULL, 'props cull'),
      ]);
      const [pipeline, fracturedPipeline, shadowPipeline, cullPipeline, resetPipeline] = await Promise.all([
        device.createRenderPipelineAsync({
          label: 'props', layout: 'auto',
          vertex: { module: renderModule, entryPoint: 'propVS', buffers: VERTEX_LAYOUT },
          fragment: { module: renderModule, entryPoint: 'propFS', targets: [{ format }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
          multisample: { count: samples },
        }),
        device.createRenderPipelineAsync({
          label: 'props fractured', layout: 'auto',
          vertex: { module: fracturedModule, entryPoint: 'propFracturedVS', buffers: FRACTURED_VERTEX_LAYOUT },
          fragment: { module: fracturedModule, entryPoint: 'propFS', targets: [{ format }] },
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
        if (model.fracture?.shardOfVertex) shardIds.set(model.fracture.shardOfVertex, baseVertex);
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
        pieces, pipeline, fracturedPipeline, shadowPipeline, cullPipeline, resetPipeline,
        lighting: shadows.bind(pipeline),
        fracturedLighting: shadows.bind(fracturedPipeline),
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
    for (const b of [scene.props, scene.shown, scene.draws]) b.destroy();
    for (const fj of scene.fracturedProps) {
      fj.uniform.destroy();
      fj.records.destroy();
    }
    scene = null;
  }

  function createFracturedPropGPU(entry) {
    const piece = kit.pieces[entry.prop.model];
    const fState = entry.prop.fracture;
    const uniformData = new Float32Array([
      entry.prop.x,
      entry.prop.y ?? piece.model.standsAt,
      entry.prop.z,
      entry.prop.yaw ?? 0,
      fState.now - fState.flight.epoch,
      FRACTURE_GRAVITY,
      1,
      0,
    ]);
    const uniform = buffer('fractured prop uniform', uniformData, B.UNIFORM);
    const records = buffer('fractured prop records', fState.flight.records, B.STORAGE);
    const group = device.createBindGroup({
      label: 'props fractured',
      layout: kit.fracturedPipeline.getBindGroupLayout(0),
      entries: [
        [0, { buffer: frameUBO }], [1, { buffer: kit.hull }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
        [11, piece.pigment.createView()], [12, kit.sampler],
        [13, { buffer: uniform }], [14, { buffer: records }],
      ].map(([binding, resource]) => ({ binding, resource })),
    });
    return {
      entry,
      piece,
      uniform,
      uniformData,
      records,
      group,
      lastClock: fState.now - fState.flight.epoch,
      lastSteppedNow: fState.now,
    };
  }

  function buildScene(port) {
    dispose();
    const placed = port?.props;
    if (!placed?.length || !kit) return;
    preparePortJetties(port, kit.models);
    const counts = kit.pieces.map((_, m) => placed.filter((p) => p.model === m).length), starts = [], words = new ArrayBuffer(placed.length * PROP_BYTES), floats = new Float32Array(words), ints = new Uint32Array(words);
    let span = 0;
    for (const count of counts) { starts.push(span); span += Math.max(1, Math.ceil(count / LIST_ALIGNMENT)) * LIST_ALIGNMENT; }
    const entriesList = [];
    placed.forEach((p, i) => {
      const piece = kit.pieces[p.model], at = i * PROP_WORDS;
      const ownerState = p.owner >= 0 ? port.instances?.[p.owner]?.damageState?.state : null;
      const ownerGone = ownerState === 'ruined' || ownerState === 'breached';
      const damaged = Boolean(p.fracture?.damaged);
      floats.set([p.x, p.y ?? piece.model.standsAt, p.z, p.yaw, 1], at);
      ints[at + 5] = p.model; ints[at + 6] = starts[p.model];
      floats[at + 7] = ownerGone || damaged ? 0 : piece.model.radius;
      entriesList.push({
        at: i,
        prop: p,
        inst: p.owner >= 0 ? port.instances[p.owner] : null,
        gone: ownerGone || damaged,
        fractureGpu: null,
      });
    });
    const drawWords = new Uint32Array(kit.pieces.length * PROP_DRAW_WORDS);
    kit.pieces.forEach((piece, m) => { drawWords.set([piece.indexCount, 0, piece.firstIndex, piece.baseVertex, 0], m * PROP_DRAW_WORDS); });
    const props = buffer('props', new Uint8Array(words), B.STORAGE), shown = device.createBuffer({ label: 'props shown', size: span * PROP_BYTES, usage: B.STORAGE }), draws = buffer('prop draws', drawWords, B.STORAGE | B.INDIRECT);
    const entries = [frameUBO, props, shown, draws].map((b, binding) => ({ binding, resource: { buffer: b } }));
    const cullGroup = device.createBindGroup({ label: 'props cull', layout: kit.cullPipeline.getBindGroupLayout(0), entries });
    const resetGroup = device.createBindGroup({ label: 'props reset', layout: kit.resetPipeline.getBindGroupLayout(0), entries: [{ binding: 3, resource: { buffer: draws } }] });
    const groups = kit.pieces.map((piece, m) => device.createBindGroup({
      label: 'props', layout: kit.pipeline.getBindGroupLayout(0),
      entries: [
        [0, { buffer: frameUBO }], [1, { buffer: kit.hull }], [4, transView], [5, sampClamp], [6, envCubeView], [7, { buffer: sunVisBuf }], [9, skyView],
        [10, { buffer: shown, offset: starts[m] * PROP_BYTES, size: Math.max(1, Math.ceil(counts[m] / LIST_ALIGNMENT)) * LIST_ALIGNMENT * PROP_BYTES }],
        [11, piece.pigment.createView()], [12, kit.sampler],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
    const shadowGroups = kit.pieces.map((piece, m) => device.createBindGroup({
      label: 'props shadow', layout: kit.shadowPipeline.getBindGroupLayout(0),
      entries: [
        [0, { buffer: shadows.uniform }],
        [1, { buffer: shown, offset: starts[m] * PROP_BYTES, size: Math.max(1, Math.ceil(counts[m] / LIST_ALIGNMENT)) * LIST_ALIGNMENT * PROP_BYTES }],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
    scene = { count: placed.length, props, shown, draws, cullGroup, resetGroup, groups, shadowGroups, entries: entriesList, fracturedProps: [] };
  }

  // What stood on a pier goes when the pier does; what a cannonball strikes switches to its fractured shard draw.
  function syncProps(dt = 0) {
    if (!scene || !kit) return;
    for (const item of scene.entries) {
      const state = item.inst?.damageState?.state;
      const ownerGone = state === 'ruined' || state === 'breached';
      const fState = item.prop.fracture;
      const damaged = Boolean(fState?.damaged);
      const gone = ownerGone || damaged;
      if (gone !== item.gone) {
        item.gone = gone;
        const radius = gone ? 0 : kit.pieces[item.prop.model].model.radius;
        device.queue.writeBuffer(scene.props, item.at * PROP_BYTES + 28, new Float32Array([radius]));
      }
      if (!damaged || ownerGone) continue;
      if (!item.fractureGpu) {
        item.fractureGpu = createFracturedPropGPU(item);
        fState.flight.dirty.clear();
        scene.fracturedProps.push(item.fractureGpu);
      }
      const fj = item.fractureGpu;
      if (dt > 0 && fState.flight.flying.size > 0 && fState.now === fj.lastSteppedNow) {
        stepJettyFracture(item.prop, dt);
      }
      fj.lastSteppedNow = fState.now;
      if (fState.flight.dirty.size > 0) {
        device.queue.writeBuffer(fj.records, 0, fState.flight.records);
        fState.flight.dirty.clear();
      }
      const clock = fState.now - fState.flight.epoch;
      if (fj.lastClock !== clock) {
        fj.lastClock = clock;
        fj.uniformData[4] = clock;
        device.queue.writeBuffer(fj.uniform, 0, fj.uniformData);
      }
    }
  }

  return {
    get count() { return scene?.count ?? 0; },
    get fracturedCount() { return scene?.fracturedProps.length ?? 0; },
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
      syncProps(0);
    },
    encode(pass, dt = 1 / 60) {
      if (!scene) return;
      syncProps(dt);
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
      pass.setIndexBuffer(kit.indexBuffer, 'uint32');
      for (let m = 0; m < kit.pieces.length; m++) {
        pass.setBindGroup(0, scene.groups[m]);
        pass.drawIndexedIndirect(scene.draws, m * PROP_DRAW_WORDS * 4);
      }
      if (scene.fracturedProps.length > 0) {
        pass.setPipeline(kit.fracturedPipeline);
        pass.setBindGroup(1, kit.fracturedLighting);
        pass.setVertexBuffer(0, kit.vertexBuffer);
        pass.setVertexBuffer(1, kit.shardBuffer);
        pass.setIndexBuffer(kit.indexBuffer, 'uint32');
        for (const fj of scene.fracturedProps) {
          const fState = fj.entry.prop.fracture;
          if (!fState || (fState.aliveCount <= 0 && fState.flight.flying.size <= 0)) continue;
          pass.setBindGroup(0, fj.group);
          pass.drawIndexed(fj.piece.indexCount, 1, fj.piece.firstIndex, fj.piece.baseVertex, 0);
        }
      }
    },
    drawShadow(pass) {
      if (!scene || !kit) return;
      pass.setPipeline(kit.shadowPipeline);
      pass.setVertexBuffer(0, kit.vertexBuffer);
      pass.setIndexBuffer(kit.indexBuffer, 'uint32');
      for (let m = 0; m < kit.pieces.length; m++) {
        pass.setBindGroup(0, scene.shadowGroups[m]);
        pass.drawIndexedIndirect(scene.draws, m * PROP_DRAW_WORDS * 4);
      }
    },
    destroy() { dispose(); },
  };
}
