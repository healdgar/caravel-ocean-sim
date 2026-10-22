// GPU-owned bow contacts, a moving local wake grid, and fixed-capacity spray.
import { WAKE_SIZE, SPRAY_COUNT, SHEET_COUNT, CONTACT_COUNT, SHEET_UPDATE, WATER_CONTACTS, WAKE_UPDATE, SPRAY_UPDATE, WATER_EFFECTS } from './wgsl/interaction.js';
import { boatForwardSpeed } from './boat.js';
import { createDeckWash } from './deck.js';

export async function createWaterInteraction({ device, frameUBO, hullUBO, seaView, seaSampler, envView, transView, skyView, sunVis, shader, computePipe, surfaceWaves=null,wakeTargets=null }) {
  const bu = GPUBufferUsage, tu = GPUTextureUsage;
  if(!sunVis){sunVis=device.createBuffer({size:16,usage:bu.STORAGE|bu.COPY_DST});device.queue.writeBuffer(sunVis,0,new Float32Array([1,1,1,1]));}
  const uniform = device.createBuffer({ size: 64, usage: bu.UNIFORM | bu.COPY_DST });
  const deck = await createDeckWash({device,frameUBO,hullUBO,uniform,seaView,seaSampler,envView,transView,skyView,sunVis,shader,computePipe,surfaceWaves});
  const contacts = device.createBuffer({ label: 'hull contacts', size: CONTACT_COUNT * 64, usage: bu.STORAGE | bu.COPY_SRC });
  const sheets=device.createBuffer({label:'impact sheets',size:SHEET_COUNT*64,usage:bu.STORAGE|bu.COPY_SRC});
  const drops = device.createBuffer({ label: 'spray particles', size: SPRAY_COUNT * 48, usage: bu.STORAGE | bu.COPY_SRC });
  const landings = device.createBuffer({ label: 'spray landing foam', size: WAKE_SIZE * WAKE_SIZE * 4, usage: bu.STORAGE | bu.COPY_SRC });
  const textures = wakeTargets?.textures??[0, 1].map(i => device.createTexture({ label: 'local wake ' + i, size: [WAKE_SIZE, WAKE_SIZE], format: 'rgba16float', usage: tu.TEXTURE_BINDING | tu.STORAGE_BINDING | tu.COPY_SRC }));
  const views = wakeTargets?.views??textures.map(t => t.createView());
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
  const [contactPipe, wakePipe, sprayPipe, sheetPipe, module] = await Promise.all([
    computePipe(WATER_CONTACTS, 'hull contact'), computePipe(WAKE_UPDATE, 'local wake'), computePipe(SPRAY_UPDATE, 'spray update'), computePipe(SHEET_UPDATE, 'impact sheets'), shader(WATER_EFFECTS, 'water effects'),
  ]);
  const buffer = b => ({ buffer: b });
  const bind = (pipe, resources) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
  const contactGroup = bind(contactPipe, [buffer(frameUBO), buffer(uniform), buffer(hullUBO), seaView, seaSampler, buffer(contacts)]);
  const sheetGroup=bind(sheetPipe,[buffer(frameUBO),buffer(uniform),seaView,seaSampler,buffer(contacts),buffer(sheets),buffer(landings)]);
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
  const renderGroups = views.map(()=>renderPipes.map((pipe, i) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: buffer(frameUBO) }, { binding: 1, resource: buffer(uniform) },
    { binding: [2,3][i], resource: buffer([sheets,drops][i]) },
    { binding: 4, resource: envView }, { binding: 5, resource: sampler }, { binding: 6, resource: transView },
    { binding: 7, resource: buffer(sunVis) },
  ] })));
  // Drop shading samples sky and transmittance, but not the contact population.
  const values = new Float32Array(16);
  let shadowGroups;
  let current = 0, prevX = 0, prevZ = 0, previousExtent = 0, previousRevision = -1, wasEnabled = false, enabled = false, needsClear = true;
  return {
    uniform, views, sampler, contacts, drops, sheets, textures, landings, deck,values,
    setShadows(shadows){deck.setShadows(shadows);shadowGroups=renderPipes.map(p=>shadows.bind(p));},
    get current() { return current; },
    update(boat, dt, time, frame, windSpeed, windDir, resetSea = false, precipitation = 0) {
      enabled = boat.showProw && boat.effects !== false;
      const extent = Math.max(128, boat.length * 4), dx = extent / WAKE_SIZE;
      const x = Math.round(boat.x / dx) * dx, z = Math.round(boat.z / dx) * dx;
      const reset = resetSea || enabled !== wasEnabled || previousRevision !== boat.revision || extent !== previousExtent || Math.hypot(x - prevX, z - prevZ) > extent * 0.25;
      values[0] = x; values[1] = z; values[2] = extent; values[3] = dx;
      values[4] = prevX; values[5] = prevZ; values[6] = Math.max(0, Math.min(0.1, dt)); values[7] = reset ? 1 : 0;
      values[8] = boatForwardSpeed(boat); values[9] = enabled ? 1 : 0;
      values[10] = Math.cos(windDir) * windSpeed; values[11] = Math.sin(windDir) * windSpeed;
      values[12] = time; values[13] = frame; values[14]=boat.length/12;values[15]=precipitation;
      device.queue.writeBuffer(uniform, 0, values);
      prevX = x; prevZ = z; previousExtent = extent; previousRevision = boat.revision; wasEnabled = enabled;
    },
    encode(cp,destination=null) {
      if (!enabled && !needsClear) return;
      needsClear = enabled;
      if(destination!==null)current=1-destination;
      deck.encode(cp);
      cp.setPipeline(contactPipe); cp.setBindGroup(0, contactGroup); cp.dispatchWorkgroups(1);
      cp.setPipeline(sheetPipe); cp.setBindGroup(0,sheetGroup); cp.dispatchWorkgroups(SHEET_COUNT/64);
      // Landing cells use the current domain and are consumed immediately by the wake pass.
      cp.setPipeline(sprayPipe); cp.setBindGroup(0, sprayGroups[current]); cp.dispatchWorkgroups(SPRAY_COUNT / 64);
      current = 1 - current;
      cp.setPipeline(wakePipe); cp.setBindGroup(0, wakeGroups[current]); cp.dispatchWorkgroups(WAKE_SIZE / 8, WAKE_SIZE / 8);
    },
    draw(pass) {
      if (!enabled) return;
      deck.draw(pass);
      // The continuous waterline crest belongs to the displaced ocean mesh.
      // Only detached impact water is a separate transparent surface.
      pass.setPipeline(renderPipes[0]); pass.setBindGroup(0, renderGroups[current][0]); pass.setBindGroup(1,shadowGroups[0]); pass.draw(8*10*6,SHEET_COUNT);
      pass.setPipeline(renderPipes[1]); pass.setBindGroup(0, renderGroups[current][1]); pass.setBindGroup(1,shadowGroups[1]); pass.draw(6, SPRAY_COUNT);
    },
  };
}
