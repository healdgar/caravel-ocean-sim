// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared GPU baker and renderer for relightable depth-aware octahedral G-buffer cards in the One Continuum
// (AGENTS.md rule 3; WGSL in js/wgsl/continuum-cards.js and js/wgsl/continuum-cut.js).
// Zero asset-format changes: bakes each placed type's level-0 clusters directly on the GPU at load time into a
// cell-isolated mipmapped 2D-array atlas (albedo + view-tangent normal + depth + material flag).
import { requestOnce } from './gpu-program-cache.js';
import {
  CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_CLUSTER_WORDS,
  CONTINUUM_RECORD_WORDS, CONTINUUM_CLUSTER_ENTRY, CONTINUUM_KIND, writeContinuumRecord,
} from './continuum-format.js';
import { continuumAtlasPaging } from './continuum-scene.js';
import {
  CONTINUUM_ENTRY_LAYOUT, CONTINUUM_ENTRY_VERTICES, CONTINUUM_VIEW_BYTES, continuumModuleWGSL,
} from './wgsl/continuum-cut.js';
import {
  CONTINUUM_CARD_GRID, CONTINUUM_CARD_VIEWS, CONTINUUM_CARD_PAD,
  continuumCardDirJS, continuumCardBasisJS,
  CONTINUUM_CARD_DILATE_WGSL, CONTINUUM_CARD_MIP_WGSL, continuumCardViewWGSL,
} from './wgsl/continuum-cards.js';

const CONTINUUM_CARD_SCENE_IDS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 19, 20, 21, 24]);
const continuumCardBakeChains = new WeakMap();

// Serializes GPU card bakes per device so multiple families never contend on scratch MSAA VRAM or stack batches in one frame.
function enqueueContinuumCardBake(device, task) {
  const prev = continuumCardBakeChains.get(device) ?? Promise.resolve();
  const next = prev.then(task, task);
  continuumCardBakeChains.set(device, next.then(() => {}, () => {}));
  return next;
}

// One shared card renderer (view pipeline + pack/dilate + cell-isolated mip compute pipelines + sampler) per device.
export async function requestContinuumCardRenderer({ device, shader, format, samples = 4, pages = 1 }) {
  const paging = continuumAtlasPaging(device, await pages);
  return requestOnce(device, `continuum card renderer ${format} ${samples}${paging.pages > 1 ? ` ${paging.pages} pages` : ''}`, async () => {
    const [viewMod, dilateMod, mipMod] = await Promise.all([
      shader(continuumCardViewWGSL(paging), 'continuum card view'),
      shader(CONTINUUM_CARD_DILATE_WGSL, 'continuum card dilate'),
      shader(CONTINUUM_CARD_MIP_WGSL, 'continuum card mip'),
    ]);
    const [pipeline, dilatePipeline, mipPipeline] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'continuum card view', layout: 'auto',
        vertex: { module: viewMod, entryPoint: 'continuumCardVS', buffers: CONTINUUM_ENTRY_LAYOUT },
        fragment: { module: viewMod, entryPoint: 'continuumCardFS', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      }),
      device.createComputePipelineAsync({ label: 'continuum card dilate', layout: 'auto', compute: { module: dilateMod, entryPoint: 'continuumCardPackDilate' } }),
      device.createComputePipelineAsync({ label: 'continuum card mip', layout: 'auto', compute: { module: mipMod, entryPoint: 'continuumCardMip' } }),
    ]);
    const sampler = device.createSampler({
      label: 'continuum card sampler',
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    return { pipeline, dilatePipeline, mipPipeline, sampler, paging };
  });
}

// Shared Group 0 (TERRAIN_FINISH_ONLY) + Group 1 (CLOUD_SHADOW_BINDINGS) bind groups used by every card scene.
export function createContinuumCardSceneBindings({ device, renderer, resources, clouds }) {
  const sceneGroup = device.createBindGroup({
    label: 'continuum card scene',
    layout: renderer.pipeline.getBindGroupLayout(0),
    entries: resources.filter(([i]) => CONTINUUM_CARD_SCENE_IDS.includes(i)).map(([binding, resource]) => ({ binding, resource })),
  });
  const cloudGroup = clouds.bindVolume(renderer.pipeline, 'shadow');
  return { sceneGroup, cloudGroup };
}

function requestContinuumCardBakePipeline({ device, shader, material, paging }) {
  return requestOnce(device, `continuum card bake ${material.name}${paging.pages > 1 ? ` ${paging.pages} pages` : ''}`, async () => {
    const module = await shader(continuumModuleWGSL({ pass: 'cardBake', material, paging }), `${material.name} card bake`);
    return device.createRenderPipelineAsync({
      label: `${material.name} card bake`, layout: 'auto',
      vertex: { module, entryPoint: 'continuumCardBakeVS', buffers: CONTINUUM_ENTRY_LAYOUT },
      fragment: { module, entryPoint: 'continuumCardBakeFS', targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: material.cullMode ?? 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 4 },
    });
  });
}

// Collects a half-texel-accurate cluster cut (error <= R / cellSize, matching the Continuum DAG cut) for `typeId`
// directly from the atlas word stream. For dense multi-million-triangle trees this cuts bake triangles by ~67x while
// remaining sub-texel identical at `cellSize x cellSize` resolution.
export function collectContinuumLevel0Clusters(words, typeId, cellSize = 64, overrideSphere = null) {
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const typesAt = words[CONTINUUM_HEADER.typesAt];
  const clustersAt = words[CONTINUUM_HEADER.clustersAt];
  const typeBase = typesAt + typeId * CONTINUUM_TYPE_WORDS;
  const first = words[typeBase + CONTINUUM_TYPE.clusterFirst];
  const count = words[typeBase + CONTINUUM_TYPE.clusterCount];
  const sphere = overrideSphere && overrideSphere[3] > 0
    ? [overrideSphere[0], overrideSphere[1], overrideSphere[2], overrideSphere[3]]
    : [
      f32[typeBase + CONTINUUM_TYPE.sphere],
      f32[typeBase + CONTINUUM_TYPE.sphere + 1],
      f32[typeBase + CONTINUUM_TYPE.sphere + 2],
      f32[typeBase + CONTINUUM_TYPE.sphere + 3],
    ];
  // Half-texel orthographic error tolerance: diameter 2*R across cellSize texels -> 0.5 texel = R / cellSize.
  const allowed = Math.max(sphere[3] / Math.max(cellSize, 8), 1e-4);
  const clusters = [];
  for (let i = 0; i < count; i++) {
    const cb = clustersAt + (first + i) * CONTINUUM_CLUSTER_WORDS;
    const packed = words[cb + 15];
    const lvl = (packed >>> 8) & 255;
    const ownErr = lvl === 0 ? 0 : f32[cb + 12];
    const parentErr = f32[cb + 13];
    if (parentErr > allowed && ownErr <= allowed) clusters.push(first + i);
  }
  if (!clusters.length) {
    let minLevel = 255;
    for (let i = 0; i < count; i++) {
      const lvl = (words[clustersAt + (first + i) * CONTINUUM_CLUSTER_WORDS + 15] >>> 8) & 255;
      if (lvl < minLevel) minLevel = lvl;
    }
    for (let i = 0; i < count; i++) {
      if (((words[clustersAt + (first + i) * CONTINUUM_CLUSTER_WORDS + 15] >>> 8) & 255) === minLevel) clusters.push(first + i);
    }
  }
  return { clusters, sphere };
}

// Bakes relightable depth-aware octahedral G-buffer cards for `typeIds` on the GPU from their half-texel cluster cut.
// Packs T x T types per 2D array layer when `typeIds.length > maxTextureArrayLayers` (e.g. all 563 city types in 141
// 2x2-tiled layers) so zero types ever fall back to flat discs, while keeping cell-isolated power-of-two mipmaps.
// Returns { albedoTex, geoTex, layerBuf, sphereBuf, paramsBuf, bindGroup, layerCount, typeCount, tilesPerSide, cellSize, destroy() }.
export function bakeContinuumCardAtlas(options) {
  return enqueueContinuumCardBake(options.device, () => runContinuumCardBake(options));
}

async function runContinuumCardBake({
  device, shader, renderer, atlas, words = atlas.words, material, typeIds,
  bakeGroup0Entries = null, cellSize = 64, gridSize = CONTINUUM_CARD_GRID, tintMode = 0, salt = 0, neutralSpareX = 0,
  aboveGround = false, batchSize = 2, isCancelled = null, label = 'continuum cards',
}) {
  if (!words || !atlas?.pages?.length) throw Error(`Cannot bake ${label}: atlas words/pages missing`);
  const maxLayers = Math.min(256, device.limits?.maxTextureArrayLayers ?? 256);
  const maxTexDim = device.limits?.maxTextureDimension2D ?? 8192;
  const totalTypes = atlas.types.length;
  const grid = Math.max(2, gridSize | 0);
  const tileDim = grid * cellSize;
  const seen = new Set();
  const uniqueIds = [];
  for (const rawId of typeIds) {
    const id = rawId | 0;
    if (id < 0 || id >= totalTypes || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  if (!uniqueIds.length) return null;

  // Choose smallest power-of-two T x T tiling per array layer so EVERY requested type fits within device layer limits.
  let tilesPerSide = 1;
  while (Math.ceil(uniqueIds.length / (tilesPerSide * tilesPerSide)) > maxLayers && tilesPerSide * 2 * tileDim <= maxTexDim && tilesPerSide < 16) {
    tilesPerSide *= 2;
  }
  const tilesPerLayer = tilesPerSide * tilesPerSide;
  const maxTypes = maxLayers * tilesPerLayer;
  if (uniqueIds.length > maxTypes) uniqueIds.length = maxTypes;

  const paging = continuumAtlasPaging(device, atlas.pages.length);
  if (renderer.paging !== paging) {
    throw Error(`Card renderer paging (${renderer.paging.pages}) does not match ${label} atlas (${paging.pages})`);
  }
  const bakePipeline = await requestContinuumCardBakePipeline({ device, shader, material, paging });
  if (isCancelled?.()) return null;

  const viewsPerType = grid * grid;
  const atlasDim = tileDim * tilesPerSide;
  const mipLevels = Math.round(Math.log2(cellSize)) + 1;
  const bakedCount = uniqueIds.length;
  const layerCount = Math.ceil(bakedCount / tilesPerLayer);
  const B = GPUBufferUsage, T = GPUTextureUsage;

  const cardAlbedoTex = device.createTexture({
    label: `${label} albedo`, size: [atlasDim, atlasDim, layerCount], mipLevelCount: mipLevels,
    format: 'rgba8unorm', usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
  });
  const cardGeoTex = device.createTexture({
    label: `${label} geo`, size: [atlasDim, atlasDim, layerCount], mipLevelCount: mipLevels,
    format: 'rgba8unorm', usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
  });

  // Reusable single-type 4x MSAA scratch targets (sized to one tileDim x tileDim type sheet, never tiled atlasDim).
  const msaaAlbedo = device.createTexture({ label: `${label} msaa albedo`, size: [tileDim, tileDim], sampleCount: 4, format: 'rgba16float', usage: T.RENDER_ATTACHMENT });
  const msaaGeo = device.createTexture({ label: `${label} msaa geo`, size: [tileDim, tileDim], sampleCount: 4, format: 'rgba16float', usage: T.RENDER_ATTACHMENT });
  const msaaDepth = device.createTexture({ label: `${label} msaa depth`, size: [tileDim, tileDim], sampleCount: 4, format: 'depth32float', usage: T.RENDER_ATTACHMENT });
  const resAlbedo = device.createTexture({ label: `${label} res albedo`, size: [tileDim, tileDim], format: 'rgba16float', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
  const resGeo = device.createTexture({ label: `${label} res geo`, size: [tileDim, tileDim], format: 'rgba16float', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });

  const msaaAlbedoView = msaaAlbedo.createView(), msaaGeoView = msaaGeo.createView(), msaaDepthView = msaaDepth.createView();
  const resAlbedoView = resAlbedo.createView(), resGeoView = resGeo.createView();

  const tempBuffers = [];
  const makeBuf = (arr, usage, name) => {
    const b = device.createBuffer({ label: `${label} ${name}`, size: Math.max(16, arr.byteLength), usage: usage | B.COPY_DST });
    device.queue.writeBuffer(b, 0, arr);
    tempBuffers.push(b);
    return b;
  };

  // Precompute view directions and tangent bases once for the grid x grid biased hemi-octahedral grid.
  const viewDirs = [], viewBases = [];
  for (let iy = 0; iy < grid; iy++) {
    for (let ix = 0; ix < grid; ix++) {
      const dir = continuumCardDirJS(ix, iy, grid);
      viewDirs.push(dir);
      viewBases.push(continuumCardBasisJS(dir));
    }
  }

  // Tight per-type spheres computed from Level-0 geometry (and above-ground clipping for buildings with buried footings).
  const srcSpheres = aboveGround ? (atlas.aboveGroundSpheres ?? atlas.tightSpheres) : atlas.tightSpheres;
  const sphereTable = new Float32Array(Math.max(1, totalTypes) * 4);

  // Build 1 neutral ContinuumRecord per baked type and viewsPerType ContinuumCardView structs per type (80 bytes each).
  const recWords = new Uint32Array(bakedCount * CONTINUUM_RECORD_WORDS);
  const recFloats = new Float32Array(recWords.buffer);
  const viewFloats = new Float32Array(bakedCount * viewsPerType * 20);
  const viewU32 = new Uint32Array(viewFloats.buffer);
  const typeClusters = new Array(bakedCount);

  for (let r = 0; r < bakedCount; r++) {
    const typeId = uniqueIds[r];
    writeContinuumRecord(recWords, recFloats, r, {
      position: [0, 0, 0], scale: 1, yaw: 0, type: typeId, kind: CONTINUUM_KIND.RIGID,
      flags: 0, pose: 0, seed: (r + 1) * 2654435761, reach: 0, identity: 0,
    });
    // Set neutral spare.x word directly (e.g. packed neutral tint for forest, neutral f32 for city).
    recWords[r * CONTINUUM_RECORD_WORDS + 12] = neutralSpareX >>> 0;
    const tightSp = srcSpheres && (typeId * 4 + 3) < srcSpheres.length
      ? [srcSpheres[typeId * 4], srcSpheres[typeId * 4 + 1], srcSpheres[typeId * 4 + 2], srcSpheres[typeId * 4 + 3]]
      : null;
    const info = collectContinuumLevel0Clusters(words, typeId, cellSize, tightSp);
    typeClusters[r] = info.clusters;
    const [cx, cy, cz, rawR] = info.sphere;
    sphereTable.set([cx, cy, cz, rawR], typeId * 4);
    const R = Math.max(rawR, 1e-4) * CONTINUUM_CARD_PAD;
    for (let v = 0; v < viewsPerType; v++) {
      const at = (r * viewsPerType + v) * 20;
      const d = viewDirs[v], { right, up } = viewBases[v];
      viewFloats[at] = cx; viewFloats[at + 1] = cy; viewFloats[at + 2] = cz; viewFloats[at + 3] = R;
      viewFloats[at + 4] = right[0]; viewFloats[at + 5] = right[1]; viewFloats[at + 6] = right[2]; viewFloats[at + 7] = 0;
      viewFloats[at + 8] = up[0]; viewFloats[at + 9] = up[1]; viewFloats[at + 10] = up[2]; viewFloats[at + 11] = 0;
      viewFloats[at + 12] = d[0]; viewFloats[at + 13] = d[1]; viewFloats[at + 14] = d[2]; viewFloats[at + 15] = 0;
      viewU32[at + 16] = r; viewU32[at + 17] = typeId; viewU32[at + 18] = v; viewU32[at + 19] = 0;
    }
  }

  const bakeRecordsBuf = makeBuf(recWords, B.STORAGE, 'bake records');
  const bakeListsBuf = makeBuf(new Uint32Array(4), B.STORAGE, 'bake lists');
  const bakeViewBuf = makeBuf(new Uint32Array(CONTINUUM_VIEW_BYTES / 4), B.UNIFORM, 'bake view');
  const bakePosesBuf = makeBuf(new Float32Array(4), B.STORAGE, 'bake poses');
  const bakeViewsBuf = makeBuf(viewFloats, B.STORAGE, 'bake views');
  const packParamsBufs = Array.from({ length: tilesPerLayer }, (_, slot) => {
    const tx = slot % tilesPerSide, ty = Math.floor(slot / tilesPerSide);
    return makeBuf(new Uint32Array([cellSize, grid, tx * tileDim, ty * tileDim]), B.UNIFORM, `pack params ${slot}`);
  });

  const bakeGroup0 = bakeGroup0Entries?.length
    ? device.createBindGroup({ label: `${label} bake g0`, layout: bakePipeline.getBindGroupLayout(0), entries: bakeGroup0Entries })
    : null;
  const bakeDataEntries = [
    { binding: 0, resource: { buffer: atlas.pages[0] } },
    { binding: 1, resource: { buffer: bakeRecordsBuf } },
    { binding: 2, resource: { buffer: bakeListsBuf } },
    { binding: 3, resource: { buffer: bakeViewBuf } },
    { binding: 4, resource: { buffer: bakePosesBuf } },
    ...atlas.pages.slice(1).map((buffer, p) => ({ binding: 5 + p, resource: { buffer } })),
    { binding: 12, resource: { buffer: bakeViewsBuf } },
  ];
  const bakeGroup1 = device.createBindGroup({ label: `${label} bake g1`, layout: bakePipeline.getBindGroupLayout(1), entries: bakeDataEntries });

  const dilateLayout = renderer.dilatePipeline.getBindGroupLayout(0);
  const mipLayout = renderer.mipPipeline.getBindGroupLayout(0);

  let scratchFreed = false;
  const destroyScratchNow = () => {
    if (scratchFreed) return;
    scratchFreed = true;
    for (const tex of [msaaAlbedo, msaaGeo, msaaDepth, resAlbedo, resGeo]) tex.destroy();
    for (const buf of tempBuffers) buf.destroy();
  };
  const retireScratch = () => {
    if (typeof device.queue?.onSubmittedWorkDone === 'function') {
      device.queue.onSubmittedWorkDone().then(destroyScratchNow, destroyScratchNow);
    } else {
      destroyScratchNow();
    }
  };
  const nextFrame = () => new Promise((resolve) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(resolve) : setTimeout(resolve, 0)));

  const layersPerBatch = Math.max(1, Math.ceil(batchSize / tilesPerLayer));
  let submittedAny = false;
  try {
    for (let layerStart = 0; layerStart < layerCount; layerStart += layersPerBatch) {
      if (isCancelled?.()) {
        if (submittedAny && typeof device.queue?.onSubmittedWorkDone === 'function') {
          device.queue.onSubmittedWorkDone().then(() => { cardAlbedoTex.destroy(); cardGeoTex.destroy(); }, () => {});
        } else {
          cardAlbedoTex.destroy(); cardGeoTex.destroy();
        }
        return null;
      }
      const layerEnd = Math.min(layerCount, layerStart + layersPerBatch);
      const rStart = layerStart * tilesPerLayer;
      const rEnd = Math.min(bakedCount, layerEnd * tilesPerLayer);
      let batchEntryCount = 0;
      for (let r = rStart; r < rEnd; r++) batchEntryCount += typeClusters[r].length * viewsPerType;
      if (batchEntryCount === 0) continue;

      const entries = new Uint32Array(batchEntryCount * 2);
      const offsets = new Map();
      let cursor = 0;
      for (let r = rStart; r < rEnd; r++) {
        const clusters = typeClusters[r];
        const firstForType = cursor;
        for (let v = 0; v < viewsPerType; v++) {
          const globalViewIdx = r * viewsPerType + v;
          for (let c = 0; c < clusters.length; c++) {
            entries[cursor * 2] = globalViewIdx;
            entries[cursor * 2 + 1] = (clusters[c] | (CONTINUUM_CLUSTER_ENTRY << 28)) >>> 0;
            cursor++;
          }
        }
        offsets.set(r, { first: firstForType, perView: clusters.length });
      }
      const entriesBuf = device.createBuffer({ label: `${label} bake entries`, size: entries.byteLength, usage: B.VERTEX | B.COPY_DST });
      device.queue.writeBuffer(entriesBuf, 0, entries);
      tempBuffers.push(entriesBuf);

      const encoder = device.createCommandEncoder({ label: `${label} bake layers ${layerStart}-${layerEnd - 1}` });
      for (let layerIdx = layerStart; layerIdx < layerEnd; layerIdx++) {
        const dstMip0A = cardAlbedoTex.createView({ dimension: '2d', baseArrayLayer: layerIdx, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 });
        const dstMip0G = cardGeoTex.createView({ dimension: '2d', baseArrayLayer: layerIdx, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 });
        const slotStart = layerIdx * tilesPerLayer;
        const slotEnd = Math.min(bakedCount, slotStart + tilesPerLayer);
        let anyTile = false;
        for (let r = slotStart; r < slotEnd; r++) {
          const info = offsets.get(r);
          if (!info?.perView) continue;
          anyTile = true;
          const slot = r - slotStart;
          const rpass = encoder.beginRenderPass({
            colorAttachments: [
              { view: msaaAlbedoView, resolveTarget: resAlbedoView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' },
              { view: msaaGeoView, resolveTarget: resGeoView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' },
            ],
            depthStencilAttachment: { view: msaaDepthView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
          });
          rpass.setPipeline(bakePipeline);
          if (bakeGroup0) rpass.setBindGroup(0, bakeGroup0);
          rpass.setBindGroup(1, bakeGroup1);
          rpass.setVertexBuffer(0, entriesBuf);
          for (let iy = 0; iy < grid; iy++) {
            for (let ix = 0; ix < grid; ix++) {
              const v = iy * grid + ix;
              rpass.setViewport(ix * cellSize, iy * cellSize, cellSize, cellSize, 0, 1);
              rpass.setScissorRect(ix * cellSize, iy * cellSize, cellSize, cellSize);
              rpass.draw(CONTINUUM_ENTRY_VERTICES[0], info.perView, 0, info.first + v * info.perView);
            }
          }
          rpass.end();

          const dpass = encoder.beginComputePass();
          const dilateBG = device.createBindGroup({
            layout: dilateLayout,
            entries: [
              { binding: 0, resource: resAlbedoView },
              { binding: 1, resource: resGeoView },
              { binding: 2, resource: dstMip0A },
              { binding: 3, resource: dstMip0G },
              { binding: 4, resource: { buffer: packParamsBufs[slot] } },
            ],
          });
          dpass.setPipeline(renderer.dilatePipeline);
          dpass.setBindGroup(0, dilateBG);
          dpass.dispatchWorkgroups(Math.ceil(tileDim / 8), Math.ceil(tileDim / 8));
          dpass.end();
        }
        if (!anyTile) continue;
        const mpass = encoder.beginComputePass();
        mpass.setPipeline(renderer.mipPipeline);
        for (let m = 1; m < mipLevels; m++) {
          const dimM = atlasDim >> m;
          const srcA = cardAlbedoTex.createView({ dimension: '2d', baseArrayLayer: layerIdx, arrayLayerCount: 1, baseMipLevel: m - 1, mipLevelCount: 1 });
          const srcG = cardGeoTex.createView({ dimension: '2d', baseArrayLayer: layerIdx, arrayLayerCount: 1, baseMipLevel: m - 1, mipLevelCount: 1 });
          const dstA = cardAlbedoTex.createView({ dimension: '2d', baseArrayLayer: layerIdx, arrayLayerCount: 1, baseMipLevel: m, mipLevelCount: 1 });
          const dstG = cardGeoTex.createView({ dimension: '2d', baseArrayLayer: layerIdx, arrayLayerCount: 1, baseMipLevel: m, mipLevelCount: 1 });
          const mipBG = device.createBindGroup({
            layout: mipLayout,
            entries: [
              { binding: 0, resource: srcA },
              { binding: 1, resource: srcG },
              { binding: 2, resource: dstA },
              { binding: 3, resource: dstG },
            ],
          });
          mpass.setBindGroup(0, mipBG);
          mpass.dispatchWorkgroups(Math.ceil(dimM / 8), Math.ceil(dimM / 8));
        }
        mpass.end();
      }
      device.queue.submit([encoder.finish()]);
      submittedAny = true;
      // Pace tiny batches across frames WITHOUT blocking GPU-CPU onSubmittedWorkDone flushes (avoids Metal render stalls).
      if (layerEnd < layerCount) await nextFrame();
    }
  } finally {
    if (submittedAny) retireScratch();
    else destroyScratchNow();
  }

  if (isCancelled?.()) {
    cardAlbedoTex.destroy(); cardGeoTex.destroy();
    return null;
  }

  const layerTable = new Uint32Array(Math.max(1, totalTypes)).fill(0xffffffff);
  for (let i = 0; i < bakedCount; i++) {
    const layerIdx = Math.floor(i / tilesPerLayer);
    const slot = i % tilesPerLayer;
    const tx = slot % tilesPerSide, ty = Math.floor(slot / tilesPerSide);
    layerTable[uniqueIds[i]] = ((layerIdx << 8) | (ty << 4) | tx) >>> 0;
  }
  const layerBuf = device.createBuffer({ label: `${label} layers`, size: layerTable.byteLength, usage: B.STORAGE | B.COPY_DST });
  device.queue.writeBuffer(layerBuf, 0, layerTable);

  const sphereBuf = device.createBuffer({ label: `${label} spheres`, size: sphereTable.byteLength, usage: B.STORAGE | B.COPY_DST });
  device.queue.writeBuffer(sphereBuf, 0, sphereTable);

  const paramsBuf = device.createBuffer({ label: `${label} params`, size: 16, usage: B.UNIFORM | B.COPY_DST });
  device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([(grid | (tilesPerSide << 16)) >>> 0, cellSize, tintMode >>> 0, salt >>> 0]));

  const bindGroup = device.createBindGroup({
    label: `${label} group`,
    layout: renderer.pipeline.getBindGroupLayout(3),
    entries: [
      { binding: 0, resource: cardAlbedoTex.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: cardGeoTex.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: renderer.sampler },
      { binding: 3, resource: { buffer: layerBuf } },
      { binding: 4, resource: { buffer: paramsBuf } },
      { binding: 5, resource: { buffer: sphereBuf } },
    ],
  });

  let disposed = false;
  return {
    albedoTex: cardAlbedoTex,
    geoTex: cardGeoTex,
    layerBuf,
    sphereBuf,
    paramsBuf,
    bindGroup,
    layerCount,
    typeCount: bakedCount,
    tilesPerSide,
    cellSize,
    destroy() {
      if (disposed) return;
      disposed = true;
      cardAlbedoTex.destroy();
      cardGeoTex.destroy();
      layerBuf.destroy();
      sphereBuf.destroy();
      paramsBuf.destroy();
    },
  };
}
