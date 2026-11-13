// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// GPU pasture herds manager: uploads static herd seeds once per coast, dispatches
// closed-form pasture grazing compute, and draws all 4 species via indirect instancing.
import { requestOnce } from './gpu-program-cache.js';
import { getLivestockMeshes, LIVESTOCK_VERTEX_FLOATS } from './models/livestock-meshes.js';
import {
  HERD_BODY_FLOATS,
  HERD_BUCKETS,
  HERD_DRAW_WORDS,
  HERD_SEED_FLOATS,
  HERD_SPECIES,
  HERDS_RENDER_WGSL,
  HERDS_SHADOW_WGSL,
  HERDS_STEP_WGSL,
} from './wgsl/herds.js';

const HERDS_VERTEX_LAYOUT = [{
  arrayStride: LIVESTOCK_VERTEX_FLOATS * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
  ],
}];

const HERD_BODY_BYTES = HERD_BODY_FLOATS * 4;
const HERD_ALIGN_BODIES = 16;
// Max downward neck-and-head grazing rotation (radians) per species: sheep, cattle, swine, horse.
const HERD_GRAZE_PITCH = [0.78, 0.62, 0.34, 0.74];

export function requestHerdsPipelines({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `livestock herds ${format} ${samples}`, async () => {
    const [renderMod, shadowMod, stepMod] = await Promise.all([
      shader(HERDS_RENDER_WGSL, 'livestock herds'),
      shader(HERDS_SHADOW_WGSL, 'livestock herds shadow'),
      shader(HERDS_STEP_WGSL, 'livestock herds step'),
    ]);
    return Promise.all([
      device.createRenderPipelineAsync({
        label: 'livestock herds',
        layout: 'auto',
        vertex: { module: renderMod, entryPoint: 'herdsVS', buffers: HERDS_VERTEX_LAYOUT },
        fragment: { module: renderMod, entryPoint: 'herdsFS', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }),
      device.createRenderPipelineAsync({
        label: 'livestock herds shadow',
        layout: 'auto',
        vertex: { module: shadowMod, entryPoint: 'herdsShadowVS', buffers: HERDS_VERTEX_LAYOUT },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
      }),
      device.createComputePipelineAsync({
        label: 'livestock herds step',
        layout: 'auto',
        compute: { module: stepMod, entryPoint: 'main' },
      }),
    ]);
  });
}

export async function createLivestockHerds({
  device,
  shader,
  format = 'rgba16float',
  samples = 4,
  frameUBO,
  landUniform,
  nearDomain,
  elevation,
  landShadowUniform,
  resources,
  clouds,
  initialHerds = null,
  isMobile = false,
}) {
  const B = GPUBufferUsage;
  const mkBuf = (label, data, usage) => {
    const buf = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST });
    if (data.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };
  const [pipeline, shadowPipeline, stepPipeline] = await requestHerdsPipelines({ device, shader, format, samples });
  const cloudGroup = clouds.bindVolume(pipeline);
  const speciesMeshes = getLivestockMeshes().map((sp, idx) => {
    const rigData = new Float32Array([
      sp.neckPivot[0], sp.neckPivot[1], sp.neckPivot[2], HERD_GRAZE_PITCH[idx] ?? 0.65,
      sp.legY, sp.frontZ, sp.backZ, sp.height,
    ]);
    return {
      indexCount: sp.indexCount,
      vertex: mkBuf(`livestock ${sp.name} vertices`, sp.vertices, B.VERTEX),
      index: mkBuf(`livestock ${sp.name} indices`, sp.indices, B.INDEX),
      rig: mkBuf(`livestock ${sp.name} rig`, rigData, B.UNIFORM),
    };
  });

  const wantedBindings = new Set([0, 1, 2, 3, 4, 12, 19, 20, 21]);
  let activeResources = resources;
  let state = null;

  function releaseState() {
    if (!state) return;
    state.seeds.destroy();
    state.bodies.destroy();
    state.draws.destroy();
    state.cfg.destroy();
    state = null;
  }

  function rebuildGroups() {
    if (!state) return;
    const baseEntries = activeResources.filter(([id]) => wantedBindings.has(id));
    const slice = (bucket) => ({
      buffer: state.bodies,
      offset: bucket * state.bucketSpan * HERD_BODY_BYTES,
      size: state.bucketSpan * HERD_BODY_BYTES,
    });
    state.renderGroups = speciesMeshes.map((sp, m) => device.createBindGroup({
      label: `livestock render ${m}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...baseEntries,
        [16, slice(m)],
        [17, { buffer: sp.rig }],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
    state.shadowGroups = speciesMeshes.map((sp, m) => device.createBindGroup({
      label: `livestock shadow ${m}`,
      layout: shadowPipeline.getBindGroupLayout(0),
      entries: [
        [0, { buffer: landShadowUniform }],
        [1, { buffer: nearDomain }],
        [2, slice(m + HERD_SPECIES)],
        [3, { buffer: sp.rig }],
      ].map(([binding, resource]) => ({ binding, resource })),
    }));
  }

  function setHerds(herdData) {
    releaseState();
    const rawCount = herdData?.length ? Math.floor(herdData.length / HERD_SEED_FLOATS) : 0;
    if (!rawCount) return;
    const count = isMobile ? Math.max(1, Math.round(rawCount * 0.55)) : rawCount;
    const sliceData = count < rawCount ? herdData.subarray(0, count * HERD_SEED_FLOATS) : herdData;
    const bucketSpan = Math.ceil(count / HERD_ALIGN_BODIES) * HERD_ALIGN_BODIES;

    const drawTemplate = new Uint32Array(HERD_BUCKETS * HERD_DRAW_WORDS);
    for (let m = 0; m < HERD_SPECIES; m++) {
      drawTemplate[m * HERD_DRAW_WORDS] = speciesMeshes[m].indexCount;
      drawTemplate[(m + HERD_SPECIES) * HERD_DRAW_WORDS] = speciesMeshes[m].indexCount;
    }

    const seeds = mkBuf('livestock seeds', sliceData, B.STORAGE);
    const bodies = device.createBuffer({
      label: 'livestock bodies',
      size: HERD_BUCKETS * bucketSpan * HERD_BODY_BYTES,
      usage: B.STORAGE,
    });
    const draws = mkBuf('livestock indirect draws', drawTemplate, B.STORAGE | B.INDIRECT);
    const cfg = mkBuf('livestock config', new Uint32Array([count, bucketSpan, 0, 0]), B.UNIFORM);

    const stepGroup = device.createBindGroup({
      label: 'livestock step',
      layout: stepPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: frameUBO } },
        { binding: 1, resource: { buffer: landUniform } },
        { binding: 2, resource: { buffer: nearDomain } },
        { binding: 3, resource: elevation.createView() },
        { binding: 4, resource: { buffer: cfg } },
        { binding: 5, resource: { buffer: seeds } },
        { binding: 6, resource: { buffer: bodies } },
        { binding: 7, resource: { buffer: draws } },
        { binding: 8, resource: { buffer: landShadowUniform } },
      ],
    });

    state = { count, bucketSpan, seeds, bodies, draws, cfg, drawTemplate, stepGroup, renderGroups: [], shadowGroups: [] };
    rebuildGroups();
  }

  setHerds(initialHerds);

  return {
    get count() { return state?.count ?? 0; },
    setHerds,
    rebind(nextResources) {
      activeResources = nextResources;
      rebuildGroups();
    },
    encode(pass) {
      if (!state) return;
      device.queue.writeBuffer(state.draws, 0, state.drawTemplate);
      pass.setPipeline(stepPipeline);
      pass.setBindGroup(0, state.stepGroup);
      pass.dispatchWorkgroups(Math.ceil(state.count / 64));
    },
    draw(pass) {
      if (!state) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, cloudGroup);
      for (let m = 0; m < HERD_SPECIES; m++) {
        pass.setBindGroup(0, state.renderGroups[m]);
        pass.setVertexBuffer(0, speciesMeshes[m].vertex);
        pass.setIndexBuffer(speciesMeshes[m].index, 'uint32');
        pass.drawIndexedIndirect(state.draws, m * HERD_DRAW_WORDS * 4);
      }
    },
    drawShadow(pass) {
      if (!state) return;
      pass.setPipeline(shadowPipeline);
      for (let m = 0; m < HERD_SPECIES; m++) {
        pass.setBindGroup(0, state.shadowGroups[m]);
        pass.setVertexBuffer(0, speciesMeshes[m].vertex);
        pass.setIndexBuffer(speciesMeshes[m].index, 'uint32');
        pass.drawIndexedIndirect(state.draws, (m + HERD_SPECIES) * HERD_DRAW_WORDS * 4);
      }
    },
    destroy() {
      releaseState();
      for (const sp of speciesMeshes) {
        sp.vertex.destroy();
        sp.index.destroy();
        sp.rig.destroy();
      }
    },
  };
}
