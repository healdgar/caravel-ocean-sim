// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Keeps a ship's battle damage on the GPU in one uniform buffer, and draws the water in her hold.
// Holes and hold water change while she floods. Craters change only when she is hit.
import { requestOnce } from './gpu-program-cache.js';
import { HULL_FLOOD_RENDER, HULL_FLOOD_JET_SEGMENTS } from './wgsl/hull-flood.js';
import { HULL_HOLE_LIMIT, HULL_CRATER_LIMIT } from './wgsl/common.js';
import { hullFloodLevel } from './hull-holes.js';
import { modelDeckWidth } from './hull.js';
import { SHIP_MODELS } from './ship-models.js';

const HULL_FLOOD_WORDS = 4 * (2 + 2 * HULL_HOLE_LIMIT);
export const HULL_DAMAGE_UNIFORM_BYTES = 4 * HULL_FLOOD_WORDS + 16 * HULL_CRATER_LIMIT;
const HULL_FLOOD_STATIONS = 21;
const HULL_FLOOD_WIDTH_SHARE = 0.82;
const HULL_FLOOD_MIN_TONNES = 0.1;

export function writeHullFloodUniform(data, boat) {
  const damage = boat?.damage, holes = damage?.holes ?? [];
  const frame = SHIP_MODELS[boat?.model?.id ?? boat?.modelId]?.designFrame;
  data[0] = frame?.beam ? boat.beam / frame.beam : 1;
  data[1] = frame?.verticalScale ?? 1;
  data[2] = frame?.length ? boat.length / frame.length : 1;
  const count = Math.min(HULL_HOLE_LIMIT, holes.length);
  data[3] = count;
  const tonnes = damage?.floodingTonnes ?? 0;
  data[4] = hullFloodLevel(boat, damage);
  let flowing = 0;
  for (let i = 0; i < count; i++) {
    const hole = holes[i], at = 8 + i * 4, flowAt = 8 + (HULL_HOLE_LIMIT + i) * 4;
    data[at] = hole.local[0];
    data[at + 1] = hole.local[1];
    data[at + 2] = hole.local[2];
    data[at + 3] = hole.radius;
    data[flowAt] = hole.flow ?? 0;
    flowing += hole.flow ?? 0;
  }
  data[5] = Math.min(1, flowing * 2);
  data[6] = tonnes;
  data[7] = Math.min(HULL_CRATER_LIMIT, damage?.craters?.length ?? 0);
  return { count, tonnes, craters: data[7] };
}

// Position in design coordinates, then radius, depth and hits packed into one word.
export function writeHullCraters(floats, craters = []) {
  const words = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
  const count = Math.min(HULL_CRATER_LIMIT, craters.length);
  for (let i = 0; i < count; i++) {
    const crater = craters[craters.length - count + i], at = i * 4;
    floats[at] = Number(crater.x) || 0;
    floats[at + 1] = Number(crater.y) || 0;
    floats[at + 2] = Number(crater.z) || 0;
    const radius = Math.max(0, Math.min(4095, Math.round((Number(crater.radius) || 0.08) * 4000)));
    const depth = Math.max(0, Math.min(4095, Math.round((Number(crater.depth) || 0.2) * 1000)));
    const hits = Math.max(1, Math.min(255, Math.round(Number(crater.hits) || 1)));
    words[at + 3] = ((hits << 24) | (depth << 12) | radius) >>> 0;
  }
  return count;
}

export function hullFloodOutline(boat) {
  const frame = SHIP_MODELS[boat?.model?.id ?? boat?.modelId]?.designFrame;
  const designLength = frame?.length ?? 12;
  const sx = frame?.beam ? boat.beam / frame.beam : 1, sz = frame?.length ? boat.length / frame.length : 1;
  const out = new Float32Array(HULL_FLOOD_STATIONS * 4);
  for (let i = 0; i < HULL_FLOOD_STATIONS; i++) {
    const z = (i / (HULL_FLOOD_STATIONS - 1) - 0.5) * designLength * 0.92;
    const half = Math.max(0.02, modelDeckWidth(boat, z)) * sx * HULL_FLOOD_WIDTH_SHARE;
    out.set([-half, z * sz, half, z * sz], i * 4);
  }
  return out;
}

// The water inside a holed hull and the jets through the holes, asked for once a device.
export function requestHullFloodPipelines({ device, shader, format, samples }) {
  return requestOnce(device, `hull flood ${format} ${samples}`, async () => {
    const module = await shader(HULL_FLOOD_RENDER, 'hull flood');
    const base = {
      layout: 'auto',
      fragment: { module, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    };
    return Promise.all([
      device.createRenderPipelineAsync({
        ...base, label: 'hull flood water',
        vertex: { module, entryPoint: 'planeVS', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
        fragment: { ...base.fragment, entryPoint: 'planeFS' },
      }),
      device.createRenderPipelineAsync({
        ...base, label: 'hull flood jets',
        vertex: { module, entryPoint: 'jetVS' },
        fragment: { ...base.fragment, entryPoint: 'jetFS' },
      }),
    ]);
  });
}
export async function createHullFlood({ device, frameUBO, envCubeView, sampler, shader, format, samples }) {
  const [plane, jet] = await requestHullFloodPipelines({ device, shader, format, samples });
  const indexData = new Uint16Array((HULL_FLOOD_STATIONS - 1) * 6);
  for (let i = 0; i < HULL_FLOOD_STATIONS - 1; i++) {
    const a = i * 2;
    indexData.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
  }
  const index = device.createBuffer({ label: 'hull flood indices', size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(index, 0, indexData);

  return {
    // One per ship. `uniform` is the same buffer the damaged hull shader reads.
    vessel(uniform, hullUBO) {
      const data = new Float32Array(HULL_FLOOD_WORDS);
      const craterData = new Float32Array(HULL_CRATER_LIMIT * 4);
      const outline = device.createBuffer({ label: 'hull flood outline', size: HULL_FLOOD_STATIONS * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      const resources = [{ buffer: frameUBO }, { buffer: hullUBO }, { buffer: uniform }, envCubeView, sampler];
      const group = (pipeline) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
      const planeGroup = group(plane), jetGroup = group(jet);
      let outlineKey = '', count = 0, tonnes = 0, craters = 0, wroteEmpty = false, wroteCraters = 0, craterRevision = 0;
      return {
        update(boat) {
          const key = `${boat?.model?.id ?? boat?.modelId}/${boat.length}/${boat.beam}`;
          if (key !== outlineKey) {
            outlineKey = key;
            device.queue.writeBuffer(outline, 0, hullFloodOutline(boat));
          }
          ({ count, tonnes, craters } = writeHullFloodUniform(data, boat));
          const revision = boat?.damage?.cratersRevision ?? 0;
          if (revision !== craterRevision) {
            craterRevision = revision;
            writeHullCraters(craterData, boat.damage.craters ?? []);
            device.queue.writeBuffer(uniform, HULL_FLOOD_WORDS * 4, craterData);
          }
          // An undamaged ship writes nothing after its first empty frame.
          if (count === 0 && tonnes <= 0 && craters === wroteCraters && wroteEmpty) return;
          wroteEmpty = count === 0 && tonnes <= 0;
          wroteCraters = craters;
          device.queue.writeBuffer(uniform, 0, data);
        },
        draw(pass) {
          if (tonnes > HULL_FLOOD_MIN_TONNES) {
            pass.setPipeline(plane);
            pass.setBindGroup(0, planeGroup);
            pass.setVertexBuffer(0, outline);
            pass.setIndexBuffer(index, 'uint16');
            pass.drawIndexed(indexData.length);
          }
          if (count > 0) {
            pass.setPipeline(jet);
            pass.setBindGroup(0, jetGroup);
            pass.draw(6 * HULL_FLOOD_JET_SEGMENTS, count);
          }
        },
        destroy() { outline.destroy(); },
      };
    },
    destroy() { index.destroy(); },
  };
}
