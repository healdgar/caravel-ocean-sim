// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Fluvial water renderer (rivers, canals, ponds & estuary-to-sea swell convergence) and CPU spatial water sampler.
import { requestOnce } from './gpu-program-cache.js';
import { INLAND_WATER_FLOATS, INLAND_WATER_WGSL } from './wgsl/inland-water.js';

const INLAND_WATER_LAYOUT = [{
  arrayStride: INLAND_WATER_FLOATS * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x4' },
    { shaderLocation: 2, offset: 32, format: 'float32x4' },
  ],
}];

const WANTED_BASE_BINDINGS = new Set([0, 1, 2, 3, 4, 12, 19, 20, 21]);
const f32Scratch = new ArrayBuffer(4);
const f32View = new Float32Array(f32Scratch);
const u32View = new Uint32Array(f32Scratch);

function f32ToF16(val) {
  f32View[0] = val;
  const x = u32View[0];
  const sign = (x >>> 16) & 0x8000;
  const mant = x & 0x007fffff;
  const exp = (x >>> 23) & 0xff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x0200 : 0);
  if (exp === 0) return sign;
  const e16 = exp - 112;
  if (e16 >= 31) return sign | 0x7c00;
  if (e16 <= 0) {
    if (e16 < -10) return sign;
    const m = (mant | 0x00800000) >>> (1 - e16);
    return sign | ((m + 0x1000) >>> 13);
  }
  return sign | (e16 << 10) | ((mant + 0x1000) >>> 13);
}

function packRgba16f(r, g, b, a, layers = 1) {
  const out = new Uint16Array(4 * layers);
  const h = [f32ToF16(r), f32ToF16(g), f32ToF16(b), f32ToF16(a)];
  for (let l = 0; l < layers; l++) out.set(h, l * 4);
  return out;
}

export function requestInlandWaterPipeline({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `inland water ${format} ${samples}`, async () => {
    const module = await shader(INLAND_WATER_WGSL, 'inland water');
    return device.createRenderPipelineAsync({
      label: 'inland water',
      layout: 'auto',
      vertex: { module, entryPoint: 'inlandWaterVS', buffers: INLAND_WATER_LAYOUT },
      fragment: {
        module,
        entryPoint: 'inlandWaterFS',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      multisample: { count: samples },
    });
  });
}

export async function createInlandWater({
  device,
  shader,
  format = 'rgba16float',
  samples = 4,
  resources,
  clouds,
  coastalField = null,
  oceanBridge = null,
  initialGeometry = null,
}) {
  const [pipeline, surfaceWaves] = await Promise.all([
    requestInlandWaterPipeline({ device, shader, format, samples }),
    oceanBridge?.surfaceWaves ? Promise.resolve(oceanBridge.surfaceWaves) : Promise.resolve(null),
  ]);

  const ownedTextures = [];
  const ownedBuffers = [];

  const needArray6 = !(oceanBridge?.dispView && oceanBridge?.derivView && oceanBridge?.momView);
  const needFoam = !oceanBridge?.foamDetailView;
  const needRepeatSamp = !oceanBridge?.repeatSampler;
  const needSunVis = !oceanBridge?.sunVisBuf;
  const needSurfaceWaves = !surfaceWaves;
  const needCoastal = !coastalField;

  const mk1x1Array = (label, layers, r, g, b, a) => {
    const tex = device.createTexture({
      label,
      size: [1, 1, layers],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: tex }, packRgba16f(r, g, b, a, layers), { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, layers]);
    ownedTextures.push(tex);
    return tex;
  };

  let fbArray6View = null;
  if (needArray6) {
    fbArray6View = mk1x1Array('inland water fallback cascade', 6, 0, 0, 0, 0).createView({ dimension: '2d-array' });
  }

  let fbFoamView = null;
  if (needFoam) {
    const foamTex = device.createTexture({
      label: 'inland water fallback foam',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: foamTex }, new Uint8Array([128, 128, 128, 128]), { bytesPerRow: 4 }, [1, 1]);
    ownedTextures.push(foamTex);
    fbFoamView = foamTex.createView();
  }

  const fbRepeatSampler = needRepeatSamp
    ? device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' })
    : null;

  let fbSunVisBuf = null;
  if (needSunVis) {
    fbSunVisBuf = device.createBuffer({
      label: 'inland water fallback sunVis',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(fbSunVisBuf, 0, new Float32Array([1, 1, 1, 1]));
    ownedBuffers.push(fbSunVisBuf);
  }

  let fbSwUniform = null, fbSwArray2View = null;
  if (needSurfaceWaves) {
    fbSwUniform = device.createBuffer({
      label: 'inland water fallback sw ubo',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    ownedBuffers.push(fbSwUniform);
    fbSwArray2View = mk1x1Array('inland water fallback sw tex', 2, 0, 0, 0, 0).createView({ dimension: '2d-array' });
  }

  let group2 = null;
  if (!needCoastal) {
    group2 = coastalField.waterGroup(pipeline);
  } else {
    const shelterTex = mk1x1Array('inland water fallback shelter', 1, 1, 1, -20, 0);
    const slopeTex = mk1x1Array('inland water fallback slope', 1, 0, 0, 0, 1);
    const coastSamp = fbRepeatSampler ?? device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    const winBuf = device.createBuffer({
      label: 'inland water fallback coast window',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(winBuf, 0, new Float32Array([0, 0, 2048, 0.5]));
    ownedBuffers.push(winBuf);
    group2 = device.createBindGroup({
      label: 'inland water fallback coastal',
      layout: pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 0, resource: shelterTex.createView() },
        { binding: 1, resource: slopeTex.createView() },
        { binding: 2, resource: coastSamp },
        { binding: 3, resource: { buffer: winBuf } },
      ],
    });
  }

  const makeGroup0 = (baseEntries, swIdx) => {
    const filtered = baseEntries
      .filter(([id]) => WANTED_BASE_BINDINGS.has(id))
      .map(([binding, resource]) => ({ binding, resource }));
    filtered.push(
      { binding: 5, resource: oceanBridge?.dispView ?? fbArray6View },
      { binding: 6, resource: oceanBridge?.derivView ?? fbArray6View },
      { binding: 7, resource: oceanBridge?.momView ?? fbArray6View },
      { binding: 8, resource: oceanBridge?.foamDetailView ?? fbFoamView },
      { binding: 9, resource: oceanBridge?.repeatSampler ?? fbRepeatSampler },
      { binding: 10, resource: { buffer: oceanBridge?.sunVisBuf ?? fbSunVisBuf } },
      { binding: 14, resource: { buffer: surfaceWaves?.uniform ?? fbSwUniform } },
      { binding: 15, resource: surfaceWaves ? surfaceWaves.views[swIdx] : fbSwArray2View },
    );
    return device.createBindGroup({
      label: `inland water g0[${swIdx}]`,
      layout: pipeline.getBindGroupLayout(0),
      entries: filtered,
    });
  };

  let groups0 = [makeGroup0(resources, 0), makeGroup0(resources, 1)];
  const group1 = clouds.bindVolume(pipeline);
  let vertexBuf = null, indexBuf = null, indexCount = 0;

  function setGeometry(geo) {
    vertexBuf?.destroy();
    indexBuf?.destroy();
    vertexBuf = null;
    indexBuf = null;
    indexCount = 0;
    if (!geo?.vertices?.byteLength || !geo?.indices?.length) return;
    vertexBuf = device.createBuffer({
      label: 'inland water vertices',
      size: geo.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuf, 0, geo.vertices);
    indexBuf = device.createBuffer({
      label: 'inland water indices',
      size: geo.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuf, 0, geo.indices);
    indexCount = geo.indices.length;
  }

  setGeometry(initialGeometry);

  return {
    get count() { return indexCount; },
    setGeometry,
    rebind(nextResources) {
      groups0 = [makeGroup0(nextResources, 0), makeGroup0(nextResources, 1)];
    },
    draw(pass) {
      if (!indexCount || !vertexBuf || !indexBuf) return;
      const g0 = groups0[surfaceWaves ? (surfaceWaves.current & 1) : 0];
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, g0);
      pass.setBindGroup(1, group1);
      pass.setBindGroup(2, group2);
      pass.setVertexBuffer(0, vertexBuf);
      pass.setIndexBuffer(indexBuf, 'uint32');
      pass.drawIndexed(indexCount);
    },
    destroy() {
      vertexBuf?.destroy();
      indexBuf?.destroy();
      vertexBuf = null;
      indexBuf = null;
      indexCount = 0;
      for (const t of ownedTextures) t.destroy();
      for (const b of ownedBuffers) b.destroy();
      ownedTextures.length = 0;
      ownedBuffers.length = 0;
    },
  };
}

/**
 * Spatial hash lookup for river reaches, canals, and estate ponds on a country layout.
 * Skips open-sea estuary plume stations (`estuaryT > 0.48 && wy <= 0.03`) so open sea stays ocean water.
 */
export function createInlandWaterSampler(country, opts = null) {
  const reaches = country?.riverReaches ?? [];
  const ponds = country?.ponds ?? [];
  if (!reaches.length && !ponds.length) return null;
  const extra = typeof opts === 'number' ? opts : (opts?.margin ?? 0.6);

  const CELL_M = 64;
  const reachGrid = new Map();
  const pondGrid = new Map();
  const keyOf = (cx, cz) => `${cx},${cz}`;

  const insertBox = (grid, minX, maxX, minZ, maxZ, item) => {
    const cx0 = Math.floor(minX / CELL_M), cx1 = Math.floor(maxX / CELL_M);
    const cz0 = Math.floor(minZ / CELL_M), cz1 = Math.floor(maxZ / CELL_M);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = keyOf(cx, cz);
        let bucket = grid.get(k);
        if (!bucket) { bucket = []; grid.set(k, bucket); }
        bucket.push(item);
      }
    }
  };

  for (const reach of reaches) {
    const stations = Array.isArray(reach?.stations)
      ? reach.stations
      : Array.isArray(reach?.points)
        ? reach.points.map(([wx, wz, hw, wy, depth, vx, vz, thalwegB, estuaryT]) => ({
            wx, wz, hw, wy, depth, vx, vz, thalwegB, estuaryT,
          }))
        : null;
    if (!stations || stations.length < 2) continue;
    const kind = reach.canal ? 'canal' : 'river';
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i], b = stations[i + 1];
      if (!a || !b) continue;
      if ((a.estuaryT ?? 0) > 0.48 && (b.estuaryT ?? 0) > 0.48 && Math.max(a.wy ?? 0, b.wy ?? 0) <= 0.03) continue;
      const dx = b.wx - a.wx, dz = b.wz - a.wz;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-6) continue;
      const len = Math.sqrt(lenSq);
      const pad = Math.max(a.hw ?? 2, b.hw ?? 2) + extra;
      const hasFlow = Number.isFinite(a.vx) && Number.isFinite(a.vz) && Number.isFinite(b.vx) && Number.isFinite(b.vz);
      const seg = {
        a, b, dx, dz, invLenSq: 1 / lenSq,
        ux: dx / len, uz: dz / len,
        hasFlow, kind,
      };
      insertBox(reachGrid, Math.min(a.wx, b.wx) - pad, Math.max(a.wx, b.wx) + pad, Math.min(a.wz, b.wz) - pad, Math.max(a.wz, b.wz) + pad, seg);
    }
  }

  for (const p of ponds) {
    const wx = p?.wx ?? p?.cx, wz = p?.wz ?? p?.cz;
    const baseRx = p?.rx ?? p?.radius, baseRz = p?.rz ?? p?.radius;
    if (!Number.isFinite(wx) || !Number.isFinite(wz) || !(baseRx > 0) || !(baseRz > 0)) continue;
    const rx = baseRx + extra, rz = baseRz + extra;
    const r = Math.hypot(rx, rz);
    const rot = p.rot ?? 0;
    const pond = {
      wx, wz, rx, rz,
      cos: Math.cos(-rot), sin: Math.sin(-rot),
      wy: p.wy ?? 0.2, depth: p.depth ?? 1.4,
    };
    insertBox(pondGrid, wx - r, wx + r, wz - r, wz + r, pond);
  }

  if (!reachGrid.size && !pondGrid.size) return null;

  return function sampleInlandWater(wx, wz) {
    const k = keyOf(Math.floor(wx / CELL_M), Math.floor(wz / CELL_M));
    const segs = reachGrid.get(k);
    let best = null, bestRatio = Infinity;
    if (segs) {
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i], { a, b } = seg;
        const px = wx - a.wx, pz = wz - a.wz;
        const t = Math.max(0, Math.min(1, (px * seg.dx + pz * seg.dz) * seg.invLenSq));
        const cx = a.wx + seg.dx * t, cz = a.wz + seg.dz * t;
        const dist = Math.hypot(wx - cx, wz - cz);
        const hw = (a.hw ?? 2) + ((b.hw ?? 2) - (a.hw ?? 2)) * t;
        if (dist <= hw + extra) {
          const ratio = dist / Math.max(0.25, hw);
          if (ratio < bestRatio) {
            bestRatio = ratio;
            const wy = (a.wy ?? 0) + ((b.wy ?? 0) - (a.wy ?? 0)) * t;
            const depth = (a.depth ?? 1.1) + ((b.depth ?? 1.1) - (a.depth ?? 1.1)) * t;
            const estuaryT = (a.estuaryT ?? 0) + ((b.estuaryT ?? 0) - (a.estuaryT ?? 0)) * t;
            const thalwegB = (a.thalwegB ?? 0) + ((b.thalwegB ?? 0) - (a.thalwegB ?? 0)) * t;
            const vx = seg.hasFlow ? a.vx + (b.vx - a.vx) * t : seg.ux;
            const vz = seg.hasFlow ? a.vz + (b.vz - a.vz) * t : seg.uz;
            best = { wy, depth, vx, vz, hw, estuaryT, thalwegB, kind: seg.kind };
          }
        }
      }
    }
    if (best) return best;

    const pList = pondGrid.get(k);
    if (pList) {
      for (let i = 0; i < pList.length; i++) {
        const p = pList[i];
        const dx = wx - p.wx, dz = wz - p.wz;
        const lx = dx * p.cos - dz * p.sin;
        const lz = dx * p.sin + dz * p.cos;
        const r2 = (lx / p.rx) ** 2 + (lz / p.rz) ** 2;
        if (r2 <= 1) {
          return {
            wy: p.wy,
            depth: p.depth * (1 - 0.65 * r2),
            vx: 0,
            vz: 0,
            hw: Math.min(p.rx, p.rz),
            estuaryT: 0,
            thalwegB: 0,
            kind: 'pond',
          };
        }
      }
    }
    return null;
  };
}
