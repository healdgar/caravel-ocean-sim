// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// GPU renderer for inland freshwater rivers, canals and ponds stood from a board's country.
import { requestOnce } from './gpu-program-cache.js';
import { INLAND_WATER_FLOATS, INLAND_WATER_WGSL } from './wgsl/inland-water.js';

const INLAND_WATER_LAYOUT = [{
  arrayStride: INLAND_WATER_FLOATS * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x2' },
    { shaderLocation: 2, offset: 20, format: 'float32x3' },
  ],
}];

export function requestInlandWaterPipeline({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `inland water ${format} ${samples}`, async () => {
    const module = await shader(INLAND_WATER_WGSL, 'inland water');
    return device.createRenderPipelineAsync({
      label: 'inland water',
      layout: 'auto',
      vertex: { module, entryPoint: 'inlandWaterVS', buffers: INLAND_WATER_LAYOUT },
      fragment: { module, entryPoint: 'inlandWaterFS', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    });
  });
}

export async function createInlandWater({ device, shader, format = 'rgba16float', samples = 4, resources, clouds, initialGeometry = null }) {
  const pipeline = await requestInlandWaterPipeline({ device, shader, format, samples });
  const wantedBindings = new Set([0, 1, 2, 3, 4, 12, 19, 20, 21]);
  const makeGroup = (entries) => device.createBindGroup({
    label: 'inland water',
    layout: pipeline.getBindGroupLayout(0),
    entries: entries.filter(([id]) => wantedBindings.has(id)).map(([binding, resource]) => ({ binding, resource })),
  });
  let group0 = makeGroup(resources);
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
    rebind(nextResources) { group0 = makeGroup(nextResources); },
    draw(pass) {
      if (!indexCount || !vertexBuf || !indexBuf) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
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
    },
  };
}
