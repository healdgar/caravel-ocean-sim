// GPU-owned bow contacts, a moving local wake grid, and fixed-capacity spray.
import { WAKE_SIZE, SPRAY_COUNT, WATER_CONTACTS, WAKE_UPDATE, SPRAY_UPDATE, WATER_EFFECTS } from './wgsl/interaction.js';

export async function createWaterInteraction({ device, frameUBO, hullUBO, seaView, seaSampler, envView, transView, shader, computePipe }) {
  const bu = GPUBufferUsage, tu = GPUTextureUsage;
  const uniform = device.createBuffer({ size: 64, usage: bu.UNIFORM | bu.COPY_DST });
  const contacts = device.createBuffer({ label: 'hull contacts', size: 32 * 64, usage: bu.STORAGE | bu.COPY_SRC });
  const drops = device.createBuffer({ label: 'spray particles', size: SPRAY_COUNT * 48, usage: bu.STORAGE | bu.COPY_SRC });
  const landings = device.createBuffer({ label: 'spray landing foam', size: WAKE_SIZE * WAKE_SIZE * 4, usage: bu.STORAGE | bu.COPY_SRC });
  const textures = [0, 1].map(i => device.createTexture({ label: 'local wake ' + i, size: [WAKE_SIZE, WAKE_SIZE], format: 'rgba16float', usage: tu.TEXTURE_BINDING | tu.STORAGE_BINDING | tu.COPY_SRC }));
  const views = textures.map(t => t.createView());
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
  const [contactPipe, wakePipe, sprayPipe, module] = await Promise.all([
    computePipe(WATER_CONTACTS, 'hull contact'), computePipe(WAKE_UPDATE, 'local wake'), computePipe(SPRAY_UPDATE, 'spray update'), shader(WATER_EFFECTS, 'water effects'),
  ]);
  const buffer = b => ({ buffer: b });
  const bind = (pipe, resources) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
  const contactGroup = bind(contactPipe, [buffer(frameUBO), buffer(uniform), buffer(hullUBO), seaView, seaSampler, buffer(contacts)]);
  const wakeGroups = views.map((v, i) => bind(wakePipe, [buffer(uniform), buffer(hullUBO), views[1 - i], v, buffer(contacts), buffer(landings)]));
  const sprayGroups = views.map(v => bind(sprayPipe, [buffer(frameUBO), buffer(uniform), seaView, seaSampler, v, sampler, buffer(contacts), buffer(drops), buffer(landings)]));
  const renderPipes = await Promise.all(['sheet', 'drop'].map(kind => device.createRenderPipelineAsync({
    label: kind === 'sheet' ? 'bow sheets' : 'spray', layout: 'auto',
    vertex: { module, entryPoint: kind + 'VS' },
    fragment: { module, entryPoint: kind + 'FS', targets: [{ format: 'rgba16float', blend: {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    } }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' }, multisample: { count: 4 },
  })));
  // Auto layouts omit the unused population's binding in each render entry point.
  const renderGroups = views.map(wakeView => renderPipes.map((pipe, i) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: buffer(frameUBO) }, { binding: 1, resource: buffer(uniform) },
    { binding: i === 0 ? 2 : 3, resource: buffer(i === 0 ? contacts : drops) },
    { binding: 4, resource: envView }, { binding: 5, resource: sampler }, { binding: 6, resource: transView },
    ...(i === 0 ? [{ binding: 7, resource: wakeView }, { binding: 8, resource: sampler }] : []),
  ] })));
  // Drop shading samples sky and transmittance, but not the contact population.
  const values = new Float32Array(16);
  let current = 0, prevX = 0, prevZ = 0, previousExtent = 0, previousRevision = -1, wasEnabled = false, enabled = false, needsClear = true;
  return {
    uniform, views, sampler, contacts, drops, textures, landings,
    get current() { return current; },
    update(boat, dt, time, frame, windSpeed, windDir, resetSea = false) {
      enabled = boat.showProw && boat.effects !== false;
      const extent = Math.max(128, boat.length * 4), dx = extent / WAKE_SIZE;
      const x = Math.round(boat.x / dx) * dx, z = Math.round(boat.z / dx) * dx;
      const reset = resetSea || enabled !== wasEnabled || previousRevision !== boat.revision || extent !== previousExtent || Math.hypot(x - prevX, z - prevZ) > extent * 0.25;
      values[0] = x; values[1] = z; values[2] = extent; values[3] = dx;
      values[4] = prevX; values[5] = prevZ; values[6] = Math.max(0, Math.min(0.1, dt)); values[7] = reset ? 1 : 0;
      values[8] = boat.speed * 0.514444; values[9] = enabled ? 1 : 0;
      values[10] = Math.cos(windDir) * windSpeed; values[11] = Math.sin(windDir) * windSpeed;
      values[12] = time; values[13] = frame;
      device.queue.writeBuffer(uniform, 0, values);
      prevX = x; prevZ = z; previousExtent = extent; previousRevision = boat.revision; wasEnabled = enabled;
    },
    encode(cp) {
      if (!enabled && !needsClear) return;
      needsClear = enabled;
      cp.setPipeline(contactPipe); cp.setBindGroup(0, contactGroup); cp.dispatchWorkgroups(1);
      // Landing cells use the current domain and are consumed immediately by the wake pass.
      cp.setPipeline(sprayPipe); cp.setBindGroup(0, sprayGroups[current]); cp.dispatchWorkgroups(SPRAY_COUNT / 64);
      current = 1 - current;
      cp.setPipeline(wakePipe); cp.setBindGroup(0, wakeGroups[current]); cp.dispatchWorkgroups(WAKE_SIZE / 8, WAKE_SIZE / 8);
    },
    draw(pass) {
      if (!enabled) return;
      pass.setPipeline(renderPipes[0]); pass.setBindGroup(0, renderGroups[current][0]); pass.draw(2 * 15 * 10 * 6);
      pass.setPipeline(renderPipes[1]); pass.setBindGroup(0, renderGroups[current][1]); pass.draw(6, SPRAY_COUNT);
    },
  };
}
