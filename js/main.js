import { createVolumetricClouds } from './clouds.js';
import { createTerrain } from './terrain.js';
import { COASTAL_WATER } from './wgsl/terrain.js';
import { LANDFALL_VIEWS } from './terrain-model.js';
import { createLandfallUI, LANDFALL_WEATHER } from './landfall.js';
import { createGPUProfiler } from './profiler.js';
import { createAdaptiveResolution } from './resolution.js';
import { createVesselShadows } from './shadows.js';
import { createWaterInteraction } from './interaction.js';
import { createSpindrift } from './spindrift.js';
import { createSurfaceWetness } from './wetness.js';
import { createCaravelMesh, indexCaravelMesh } from './caravel.js';
import { crewWorkLabel } from './crew-work.js';
import { createCrew, CAPTAIN_ORDERS } from './crew.js';
import { HELM_EYE_Z, HELM_EYE_HEIGHT, HULL_UNIFORM_BYTES, HULL_VERTICAL_SCALE, DEFAULT_BOAT_LENGTH, DEFAULT_BOAT_BEAM } from './hull.js';
import { SAIL_KEYS, sailingState, pointOfSail } from './sailing.js';
import { CARAVEL, WATER_FILTER } from './wgsl/caravel.js';
import { boatTargets, boatSpring, boatRotate, stepBoatSteering, stepBoatView, boatEyePosition, boatForwardSpeed, boatWaveSlope, stepBoatSurge, boatWaveAttitude, boatHydrodynamics, DEFAULT_PROVISION_DAYS, KNOT_TO_MPS } from './boat.js';
import { cameraModeFromLink, propulsionFromLink, createShareLink, ROUGH_SEAS } from './sharing.js';
// WebGPU ocean — custom renderer.
// FFT ocean (6 cascades) + CDLOD surface mesh + physically based sky + HDR post.
// All per-frame data lives in preallocated typed arrays / descriptors (no per-frame garbage
// apart from the unavoidable swap-chain view and command buffer objects).
import { N, CASCADES, SKY_W, SKY_H, ENV_SIZE, ENV_MIPS } from './wgsl/common.js';
import { SIM_INIT, FFT_ROWS, FFT_COLS, SIM_MIPS, FOAM_TEX, RGBA8_MIPS, FOAM_UPDATE, ARRAY16_MIPS, FOAM_RES } from './wgsl/sim.js';
import { TRANS_LUT, MS_LUT, SKYVIEW_LUT, ENV_CUBE, CUBE_MIPS, SUN_VIS } from './wgsl/sky.js';
import { OCEAN, OCEAN_VISIBLE, SKY_BG, HEIGHT_PROBE, createCoastalOcean } from './wgsl/ocean.js';
import { BLOOM_DOWN, BLOOM_UP, COMPOSITE } from './wgsl/post.js';

const qs = new URLSearchParams(location.search);
const LAND_STAGE=qs.has('landfall')?(Object.hasOwn(LANDFALL_VIEWS,qs.get('landfall'))?qs.get('landfall'):'approach'):null;
const LAND_WEATHER=Object.hasOwn(LANDFALL_WEATHER,qs.get('weather'))?qs.get('weather'):'clear';
const DBG = Number(qs.get('dbg')) || 0;
// Depth-first visibility avoids costly hidden-water shading; keep an A/B fallback.
const OCEAN_DEPTH = qs.get('oceanDepth') !== '0';
const D2R = Math.PI / 180;
const GU = GPUBufferUsage;
const TU = GPUTextureUsage;

// ----------------------------------------------------------------------------------------
// Tunable parameters (UI panel edits these)
// ----------------------------------------------------------------------------------------
export const P = {
  windSpeed: 7.0,      // m/s at 10 m
  windDir: 118,        // deg, direction waves travel (90 = towards +Z, i.e. towards the viewer)
  fetchKm: 90,
  swellHs: 1.8,        // m significant height
  swellDir: 94,
  swellLength: 120,    // m peak wavelength
  swellSpread: 48,     // cos^2s exponent
  choppy: 1.25,
  turbidity: 1.6,     // water body brightness (coastal sediment / plankton)
  foam: 1.0,
  spindrift: 1.0,     // wind-stripped breaking crests, independent of boat spray
  sunElev: 2.6,        // deg
  sunAzim: 4,          // deg (0 = straight ahead of the start view)
  exposure: 1.35,
  haze: 3.0,
  clouds: 0.55,
  cloudBase: 1.5,     // km
  cloudDepth: 2.2,    // km
  cloudDensity: 1.0,
  cloudAnvil: 0.15,
  cloudQuality: 0.5, // ray resolution fraction, capped at 1280 x 720
  bloom: 0.10,
};
const CASC_L = [1103.0, 211.3, 39.7, 7.43, 1.393, 0.2617];

function fail(msg) {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = msg;
  log('FATAL ' + msg);
  throw new Error(msg);
}
function log(msg) {
  console.log(msg);
  try { fetch('/__log', { method: 'POST', body: String(msg) }).catch(() => {}); } catch (e) { /* offline */ }
}

// ----------------------------------------------------------------------------------------
// Small math helpers writing into preallocated arrays
// ----------------------------------------------------------------------------------------
function mat4Mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

async function main() {
  if (!navigator.gpu) fail('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fail('No WebGPU adapter found.');
  const hasTS = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: hasTS ? ['timestamp-query'] : [],
  });
  device.lost.then((i) => log('device lost: ' + i.message));
  let firstGpuError = false;
  device.onuncapturederror = (e) => { if (firstGpuError) return; firstGpuError = true; log('GPU error: ' + e.error.message); const errorPanel = document.getElementById('err'); errorPanel.style.display = 'block'; errorPanel.textContent = e.error.message; };

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('webgpu');
  const swapFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: swapFormat, alphaMode: 'opaque', usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });

  async function shader(code, label) {
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    let bad = false;
    for (const msg of info.messages) {
      if (msg.type === 'error') bad = true;
      if (msg.type !== 'info') {
        const line = code.split('\n')[msg.lineNum - 1];
        log(`[${label}] ${msg.type} ${msg.lineNum}:${msg.linePos} ${msg.message}\n    ${line}`);
      }
    }
    if (bad) fail('Shader compile error in ' + label + ' (see console)');
    return m;
  }
  async function computePipe(code, label) {
    const module = await shader(code, label);
    return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  // --------------------------------------------------------------------------------------
  // Simulation resources
  // --------------------------------------------------------------------------------------
  const C = CASCADES;
  const SIM_MIP_COUNT = Math.log2(N) + 1;
  const specBytes = N * N * C * 16;
  const mkBuf = (size, usage, label) => device.createBuffer({ size, usage, label });
  const simUBO = mkBuf(224, GU.UNIFORM | GU.COPY_DST, 'sim ubo');
  const h0Buf = mkBuf(specBytes, GU.STORAGE, 'h0');
  const tmpA = mkBuf(specBytes, GU.STORAGE, 'tmpA');
  const tmpB = mkBuf(specBytes, GU.STORAGE, 'tmpB');

  const mkSimTex = (label) => device.createTexture({
    label, size: [N, N, C], format: 'rgba16float', mipLevelCount: SIM_MIP_COUNT,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const dispTex = mkSimTex('disp');
  const derivTex = mkSimTex('deriv');
  const momTex = mkSimTex('moments');
  const lvl = (t, m, dim = '2d-array') => t.createView({ dimension: dim, baseMipLevel: m, mipLevelCount: 1 });
  const fullArr = (t) => t.createView({ dimension: '2d-array' });

  const [initPipe, rowsPipe, colsPipe, simMipPipe, foamGenPipe, rgba8MipPipe,
    transPipe, msPipe, skyViewPipe, envPipe, cubeMipPipe, foamUpdPipe, arr16MipPipe, sunVisPipe] = await Promise.all([
    computePipe(SIM_INIT, 'sim init'),
    computePipe(FFT_ROWS, 'fft rows'),
    computePipe(FFT_COLS, 'fft cols'),
    computePipe(SIM_MIPS, 'sim mips'),
    computePipe(FOAM_TEX, 'foam tex'),
    computePipe(RGBA8_MIPS, 'rgba8 mips'),
    computePipe(TRANS_LUT, 'transmittance'),
    computePipe(MS_LUT, 'multiscatter'),
    computePipe(SKYVIEW_LUT, 'skyview'),
    computePipe(ENV_CUBE, 'env cube'),
    computePipe(CUBE_MIPS, 'cube mips'),
    computePipe(FOAM_UPDATE, 'foam update'),
    computePipe(ARRAY16_MIPS, 'array16 mips'),
    computePipe(SUN_VIS, 'sun visibility'),
  ]);

  const bg = (pipe, entries, label) => device.createBindGroup({
    label, layout: pipe.getBindGroupLayout(0),
    entries: entries.map((r, i) => ({ binding: i, resource: r })),
  });
  const bgInit = bg(initPipe, [{ buffer: simUBO }, { buffer: h0Buf }], 'init');
  const bgRows = bg(rowsPipe, [{ buffer: simUBO }, { buffer: h0Buf }, { buffer: tmpA }, { buffer: tmpB }], 'rows');
  const bgCols = bg(colsPipe, [{ buffer: tmpA }, { buffer: tmpB },
    lvl(dispTex, 0), lvl(derivTex, 0), lvl(momTex, 0)], 'cols');
  const bgSimMips = [];
  for (let m = 1; m < SIM_MIP_COUNT; m++) {
    bgSimMips.push(bg(simMipPipe, [lvl(dispTex, m - 1), lvl(derivTex, m - 1), lvl(momTex, m - 1),
      lvl(dispTex, m), lvl(derivTex, m), lvl(momTex, m)], 'simmip' + m));
  }

  // Foam micro-structure texture (generated once)
  const FOAM_SIZE = 512, FOAM_MIPS = 10;
  const foamTex = device.createTexture({
    label: 'foam detail', size: [FOAM_SIZE, FOAM_SIZE], format: 'rgba8unorm', mipLevelCount: FOAM_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  {
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(foamGenPipe);
    cp.setBindGroup(0, bg(foamGenPipe, [lvl(foamTex, 0, '2d')]));
    cp.dispatchWorkgroups(FOAM_SIZE / 8, FOAM_SIZE / 8);
    cp.setPipeline(rgba8MipPipe);
    for (let m = 1; m < FOAM_MIPS; m++) {
      const s = FOAM_SIZE >> m;
      cp.setBindGroup(0, bg(rgba8MipPipe, [lvl(foamTex, m - 1, '2d'), lvl(foamTex, m, '2d')]));
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8));
    }
    cp.end();
    device.queue.submit([enc.finish()]);
  }

  // World-space foam clipmaps (ping-pong)
  const FOAM_LEVEL_SIZE = [128.0, 1024.0];
  const FOAMW_MIPS = Math.log2(FOAM_RES) + 1;
  const foamW = [0, 1].map((i) => device.createTexture({
    label: 'foam world ' + i, size: [FOAM_RES, FOAM_RES, 2], format: 'rgba16float', mipLevelCount: FOAMW_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  }));
  const foamUBO = mkBuf(144, GU.UNIFORM | GU.COPY_DST, 'foam ubo');
  const foamUArr = new ArrayBuffer(144);
  const foamUI = new Int32Array(foamUArr);
  const foamUF = new Float32Array(foamUArr);
  const foamSnap = new Int32Array(4);  // previous camera texel per level
  let foamFirst = true;
  let foamCur = 0;
  const samplerSim = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
  });
  const bgFoamMips = [0, 1].map((i) => {
    const out = [];
    for (let m = 1; m < FOAMW_MIPS; m++) out.push(bg(arr16MipPipe, [lvl(foamW[i], m - 1), lvl(foamW[i], m)]));
    return out;
  });

  // --------------------------------------------------------------------------------------
  // Atmosphere resources
  // --------------------------------------------------------------------------------------
  const atmoUBO = mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'atmo ubo');
  const mkLut = (w, h, label) => device.createTexture({
    label, size: [w, h], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const transLUT = mkLut(256, 64, 'transmittance');
  const msLUT = mkLut(32, 32, 'multiscatter');
  const skyLUT = mkLut(SKY_W, SKY_H, 'skyview');
  const envTex = device.createTexture({
    label: 'env cube', size: [ENV_SIZE, ENV_SIZE, 6], format: 'rgba16float', mipLevelCount: ENV_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const envCubeView = envTex.createView({ dimension: 'cube' });
  const sampClamp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
  });
  const sampRepeat = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 16,
  });
  const frameUBO = mkBuf(384, GU.UNIFORM | GU.COPY_DST, 'frame ubo');
  const sunVisBuf = mkBuf(16, GU.STORAGE, 'sun visibility');
  const transView = transLUT.createView();
  const msView = msLUT.createView();
  const skyView = skyLUT.createView();

  const bgTrans = bg(transPipe, [{ buffer: atmoUBO }, transView], 'trans');
  const bgMS = bg(msPipe, [{ buffer: atmoUBO }, transView, sampClamp, msView], 'ms');
  const bgSkyView = bg(skyViewPipe, [{ buffer: frameUBO }, transView, msView, sampClamp, skyView], 'skyview');
  const bgEnv = bg(envPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, lvl(envTex, 0), { buffer: sunVisBuf }], 'env');
  const bgSunVis = device.createBindGroup({ label:'sunvis', layout:sunVisPipe.getBindGroupLayout(0), entries:[
    { binding:0, resource:{ buffer:frameUBO } }, { binding:4, resource:{ buffer:sunVisBuf } },
  ] });
  const bgCubeMips = [];
  for (let m = 1; m < ENV_MIPS; m++) bgCubeMips.push(bg(cubeMipPipe, [lvl(envTex, m - 1), lvl(envTex, m), { buffer: frameUBO }], 'cubemip' + m));

  // --------------------------------------------------------------------------------------
  // Render pipelines
  // --------------------------------------------------------------------------------------
  const MSAA = 4;
  const HDR = 'rgba16float';
  const [oceanMod, skyMod, downMod, upMod, compMod] = await Promise.all([
    shader(LAND_STAGE?createCoastalOcean(COASTAL_WATER,OCEAN_DEPTH):OCEAN_DEPTH ? OCEAN_VISIBLE : OCEAN, 'ocean'), shader(SKY_BG, 'sky'), shader(BLOOM_DOWN, 'bloom down'),
    shader(BLOOM_UP, 'bloom up'), shader(COMPOSITE, 'composite'),
  ]);
  const oceanPipe = await device.createRenderPipelineAsync({
    label: 'ocean', layout: 'auto',
    vertex: {
      module: oceanMod, entryPoint: 'vs',
      buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module: oceanMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: !OCEAN_DEPTH, depthCompare: OCEAN_DEPTH ? 'equal' : 'greater' },
    multisample: { count: MSAA },
  });
  const oceanDepthPipe = OCEAN_DEPTH ? await device.createRenderPipelineAsync({
    label: 'ocean visibility', layout: 'auto',
    vertex: {
      module: oceanMod, entryPoint: 'vs',
      buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module: oceanMod, entryPoint: 'depthOnly', targets: [{ format: HDR, writeMask: 0 }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: MSAA },
  }) : null;
  const skyPipe = await device.createRenderPipelineAsync({
    label: 'sky', layout: 'auto',
    vertex: { module: skyMod, entryPoint: 'vs' },
    fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
    multisample: { count: MSAA },
  });
  const downPipe = await device.createRenderPipelineAsync({
    label: 'bloom down', layout: 'auto',
    vertex: { module: downMod, entryPoint: 'vs' },
    fragment: { module: downMod, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const upPipe = await device.createRenderPipelineAsync({
    label: 'bloom up', layout: 'auto',
    vertex: { module: upMod, entryPoint: 'vs' },
    fragment: {
      module: upMod, entryPoint: 'fs',
      targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
    },
  });
  const compPipe = await device.createRenderPipelineAsync({
    label: 'composite', layout: 'auto',
    vertex: { module: compMod, entryPoint: 'vs' },
    fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
  });

  const waterFilterPipe = await computePipe(WATER_FILTER, 'water reflections filter');
  const caravelMod = await shader(CARAVEL, 'caravel');
  const caravelPipe = await device.createRenderPipelineAsync({
    label: 'caravel', layout: 'auto',
    vertex: { module: caravelMod, entryPoint: 'vs', buffers: [{ arrayStride: 36, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' },
      { shaderLocation: 3, offset: 28, format: 'float32x2' },
    ] }] },
    fragment: { module: caravelMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: MSAA },
  });
  const {vertices:caravelMesh,indices:caravelIndices} = indexCaravelMesh(createCaravelMesh());
  const caravelBuffer = mkBuf(caravelMesh.byteLength, GU.VERTEX | GU.COPY_DST, 'caravel geometry');
  device.queue.writeBuffer(caravelBuffer, 0, caravelMesh);
  const caravelIndexBuffer=mkBuf(caravelIndices.byteLength,GU.INDEX|GU.COPY_DST,'caravel indices');
  device.queue.writeBuffer(caravelIndexBuffer,0,caravelIndices);
  const oakImage = await createImageBitmap(await (await fetch('assets/caravel-oak-albedo.webp')).blob());
  const oakMips = Math.floor(Math.log2(Math.max(oakImage.width, oakImage.height))) + 1;
  const oakTex = device.createTexture({ size: [oakImage.width, oakImage.height], format: 'rgba8unorm',
    mipLevelCount: oakMips, usage: TU.COPY_DST | TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.RENDER_ATTACHMENT });
  device.queue.copyExternalImageToTexture({ source: oakImage }, { texture: oakTex }, [oakImage.width, oakImage.height]);
  const oakEnc = device.createCommandEncoder(); const oakPass = oakEnc.beginComputePass();
  oakPass.setPipeline(rgba8MipPipe);
  for (let m = 1; m < oakMips; m++) {
    oakPass.setBindGroup(0, bg(rgba8MipPipe, [lvl(oakTex, m - 1, '2d'), lvl(oakTex, m, '2d')]));
    oakPass.dispatchWorkgroups(Math.ceil(Math.max(1, oakImage.width >> m) / 8), Math.ceil(Math.max(1, oakImage.height >> m) / 8));
  }
  oakPass.end(); device.queue.submit([oakEnc.finish()]); oakImage.close();
  const oakSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
  const hullUBO = mkBuf(HULL_UNIFORM_BYTES, GU.UNIFORM | GU.COPY_DST, 'hull transform');
  const hullData = new Float32Array(HULL_UNIFORM_BYTES / 4);
  const wetness=await createSurfaceWetness({device,mesh:caravelMesh,hullUBO,frameUBO,computePipe});
  const shadows=await createVesselShadows({device,hullUBO,mesh:caravelMesh,meshIndices:caravelIndices,vertexBuffer:caravelBuffer,shader,wetness});
  const oceanShadows=shadows.bind(oceanPipe),caravelShadows=shadows.bind(caravelPipe);
  let crew=null,crewError='';
  try { crew=await createCrew({device,frameUBO,hullUBO,transView,sampClamp,envCubeView,sunVisBuf,shadows,wetness,shader,format:HDR,samples:MSAA}); }
  catch(error) { crewError='Crew unavailable'; console.warn('Crew initialization:',error); }
  let bgCaravel;
  const interaction = await createWaterInteraction({ device, frameUBO, hullUBO, seaView: fullArr(dispTex), seaSampler: samplerSim, envView: envCubeView, transView, sunVis:sunVisBuf, shader, computePipe });
  interaction.setShadows(shadows);
  const spindrift = await createSpindrift({ device, frameUBO, hullUBO, seaView: fullArr(dispTex), derivView: fullArr(derivTex), seaSampler: samplerSim, envView: envCubeView, transView, sunVis: sunVisBuf, shader, computePipe, shadows });
  wetness.connect(interaction,spindrift,fullArr(dispTex),samplerSim);
  const bgFoamUpd = [0, 1].map(i => [0, 1].map(w => bg(foamUpdPipe, [{ buffer: foamUBO }, lvl(foamW[1 - i], 0), lvl(foamW[i], 0),
    fullArr(dispTex), fullArr(derivTex), samplerSim, samplerSim, { buffer: interaction.uniform }, interaction.views[w], interaction.sampler], 'foamupd' + i)));

  const oceanResources = (i,w) => [{ buffer: frameUBO }, transView, skyView, sampClamp,
    fullArr(dispTex), fullArr(derivTex), fullArr(momTex), foamTex.createView(), envCubeView, sampRepeat,
    fullArr(foamW[i]), { buffer: sunVisBuf }, { buffer: hullUBO }, { buffer: interaction.uniform }, interaction.views[w], interaction.sampler];
  const bgOcean = [0, 1].map(i => [0, 1].map(w => device.createBindGroup({
    label:'ocean'+i, layout:oceanPipe.getBindGroupLayout(0),
    entries:oceanResources(i,w).map((resource,binding)=>({binding,resource})).filter(e=>!OCEAN_DEPTH || e.binding!==12),
  })));
  const bgOceanDepth = OCEAN_DEPTH ? [0,1].map(w=>device.createBindGroup({
    label:'ocean visibility', layout:oceanDepthPipe.getBindGroupLayout(0),
    entries:oceanResources(0,w).map((resource,binding)=>({binding,resource})).filter(e=>[0,4,9,12,13,14,15].includes(e.binding)),
  })) : [];
  const bgSky = bg(skyPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, { buffer: sunVisBuf }], 'sky');
  const clouds = await createVolumetricClouds({ device, frameUBO, transView, skyView, sampler:sampClamp, computePipe });
  clouds.setSkyPipeline(skyPipe);
  const bgEnvClouds = clouds.bindVolume(envPipe);
  const bgSunClouds = clouds.bindVolume(sunVisPipe,true);
  const terrain=LAND_STAGE?await createTerrain({device,frameUBO,transView,skyView,sampler:sampClamp,envCubeView,clouds,shader,computePipe,mipPipe:rgba8MipPipe,format:HDR,samples:MSAA}):null;
  const coastalGroup=terrain?.waterGroup(oceanPipe);

  // Water height under the camera (async readback, a few frames of latency) so the
  // floating camera rides above passing crests instead of clipping into them.
  const probePipe = await computePipe(HEIGHT_PROBE, 'height probe');
  const probeOut = mkBuf(64, GU.STORAGE | GU.COPY_SRC, 'probe out');
  const probeRead = mkBuf(64, GU.MAP_READ | GU.COPY_DST, 'probe read');
  const boatUBO = mkBuf(32, GU.UNIFORM | GU.COPY_DST, 'boat probe');
  const boatUniform = new Float32Array(8);
  const bgProbe = [0, 1].map(w => bg(probePipe, [{ buffer: frameUBO }, fullArr(dispTex), samplerSim, { buffer: probeOut }, { buffer: boatUBO }, { buffer: interaction.uniform }, interaction.views[w], interaction.sampler, fullArr(derivTex)], 'probe'));
  let probePending = false, waterH = 0;
  let probeLength = DEFAULT_BOAT_LENGTH, probeBeam = DEFAULT_BOAT_BEAM, probeRevision = 0;
  let probeTime=0, targetTime=-1, targetRevision=-1;
  const boatAxes=['heave','pitch','roll'];
  const targetRate={heave:0,pitch:0,roll:0};
  const onProbe = () => {
    const heights = new Float32Array(probeRead.getMappedRange(0, 64));
    waterH = heights[9];
    if (probeRevision === boat.revision) {
      const next={...boatTargets(heights.subarray(0,9),probeLength,probeBeam),
        ...boatWaveAttitude(heights[10],heights[11],boat.heading)};
      const elapsed=probeTime-targetTime;
      const placed=targetTime<0;
      for(const key of boatAxes){
        const limit=key==='heave'?8:1.2;
        const valid=targetRevision===probeRevision && elapsed>0 && elapsed<0.25;
        const rate=valid?Math.max(-limit,Math.min(limit,(next[key]-boat.target[key])/elapsed)):0;
        targetRate[key]=valid?targetRate[key]+(rate-targetRate[key])*(1-Math.exp(-elapsed*8)):0;
        // Spawn on the sampled surface, including after a sea-preset change.
        if(placed){
          boat[key]=next[key]-(key==='heave'?boat.hydrodynamics.sinkage:0);boat[key+'Velocity']=0;
        }
      }
      if(placed)boat.revision++; // a pose placement must not launch a false impact
      Object.assign(boat.target,next);targetTime=probeTime;targetRevision=boat.revision;
      boat.waveSlopeX=heights[10]; boat.waveSlopeZ=heights[11];
      boat.waveSampleTime=probeTime; boat.waveRevision=boat.revision;
    }
    probeRead.unmap();
    probePending = false;
  };
  const onProbeFail = () => { probePending = false; };

  // CDLOD grid mesh
  const GRID = 32;
  const LEAF = 2.0;           // finest node size (m) -> 6.25 cm vertex spacing
  const R0 = 8 * LEAF;        // LOD 0 range
  const LODS = 17;
  const MAX_DIST = 160000;
  const MAX_NODES = 8192;
  const idx = new Uint16Array(GRID * GRID * 6);
  {
    let k = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = i + j * (GRID + 1), b = a + 1, c = a + GRID + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }
  const idxBuf = mkBuf(idx.byteLength, GU.INDEX | GU.COPY_DST, 'grid idx');
  device.queue.writeBuffer(idxBuf, 0, idx);
  const instData = new Float32Array(MAX_NODES * 4);
  const instBuf = mkBuf(instData.byteLength, GU.VERTEX | GU.COPY_DST, 'instances');

  // --------------------------------------------------------------------------------------
  // Screen-size dependent targets
  // --------------------------------------------------------------------------------------
  const BLOOM_LEVELS = 8;
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const compUBO = mkBuf(32, GU.UNIFORM | GU.COPY_DST, 'composite ubo');
  const compData = new Float32Array(8);
  const bloomUBOs = [];
  for (let i = 0; i < BLOOM_LEVELS * 2; i++) bloomUBOs.push(mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'bloom ubo'));

  let W = 0, H = 0;
  const forcedWidth = Math.max(0, Number(qs.get('w')) || 0), forcedHeight = Math.max(0, Number(qs.get('h')) || 0);
  const fixedResolution = forcedWidth > 0 || forcedHeight > 0 || !!qs.get('shot');
  const requestedResolution = qs.get('resolution') || 'auto';
  const resolution = createAdaptiveResolution(fixedResolution ? 'fixed' : ['auto','native','0.75','0.5'].includes(requestedResolution) ? requestedResolution : 'auto');
  let nativeWidth = 0, nativeHeight = 0;
  let colorMS, depthMS, hdrTex, bloomTex, waterCopy, hdrView, waterView;
  let waterMips = 1, waterMipGroups = [];
  const mainPass = {
    colorAttachments: [{ view: null, resolveTarget: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
    depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  };
  const compPass = {
    colorAttachments: [{ view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    timestampWrites: undefined,
  };
  let bloomLevels = 0, bloomPasses = [], bgComp = null;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const nw = Math.max(1, Math.round(canvas.clientWidth * dpr)), nh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (nw !== nativeWidth || nh !== nativeHeight) { nativeWidth=nw; nativeHeight=nh; resolution.reset(); }
    const limit = device.limits.maxTextureDimension2D;
    const w = Math.max(1, Math.min(limit, Math.round(forcedWidth || nw * resolution.scale)));
    const h = Math.max(1, Math.min(limit, Math.round(forcedHeight || nh * resolution.scale)));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    for (const t of [colorMS, depthMS, hdrTex, bloomTex, waterCopy]) t && t.destroy();
    colorMS = device.createTexture({ size: [W, H], format: HDR, sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    depthMS = device.createTexture({ size: [W, H], format: 'depth32float', sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    hdrTex = device.createTexture({ size: [W, H], format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    waterMips = Math.min(8, Math.floor(Math.log2(Math.max(W,H)))+1);
    waterCopy = device.createTexture({ size: [W, H], format: HDR, mipLevelCount: waterMips,
      usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.STORAGE_BINDING });
    waterMipGroups = [];
    for (let m=1;m<waterMips;m++) waterMipGroups.push(bg(waterFilterPipe,
      [lvl(waterCopy,m-1,'2d'),lvl(waterCopy,m,'2d')], 'water reflection mip'));
    bgCaravel = bg(caravelPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp,
      envCubeView, { buffer: sunVisBuf }, { buffer: hullUBO }, waterCopy.createView(), fullArr(dispTex), samplerSim, oakTex.createView(), oakSampler, interaction.deck.view,
      {buffer:wetness.state}, {buffer:wetness.lookup}], 'caravel');
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1);
    bloomLevels = Math.min(BLOOM_LEVELS, Math.floor(Math.log2(Math.max(bw, bh))) + 1);
    bloomTex = device.createTexture({ size: [bw, bh], format: HDR, mipLevelCount: bloomLevels, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    mainPass.colorAttachments[0].view = colorMS.createView();
    mainPass.depthStencilAttachment.view = depthMS.createView();
    hdrView = hdrTex.createView();
    waterView = waterCopy.createView({baseMipLevel:0,mipLevelCount:1});
    const bv = [];
    for (let m = 0; m < bloomLevels; m++) bv.push(bloomTex.createView({ baseMipLevel: m, mipLevelCount: 1 }));
    bloomPasses = [];
    const tmp = new Float32Array(4);
    for (let m = 0; m < bloomLevels; m++) {
      const srcW = m === 0 ? W : Math.max(1, bw >> (m - 1));
      const srcH = m === 0 ? H : Math.max(1, bh >> (m - 1));
      tmp[0] = 1 / srcW; tmp[1] = 1 / srcH; tmp[2] = m === 0 ? 1 : 0; tmp[3] = 0;
      device.queue.writeBuffer(bloomUBOs[m], 0, tmp);
      bloomPasses.push({
        pipeline: downPipe,
        timingName: `Bloom down ${m}`,
        bindGroup: bg(downPipe, [m === 0 ? hdrView : bv[m - 1], linSamp, { buffer: bloomUBOs[m] }]),
        descriptor: { colorAttachments: [{ view: bv[m], clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] },
      });
    }
    for (let m = bloomLevels - 1; m > 0; m--) {
      const sw = Math.max(1, bw >> m), sh = Math.max(1, bh >> m);
      tmp[0] = 1 / sw; tmp[1] = 1 / sh; tmp[2] = 1.0; tmp[3] = 1.0;
      const ubo = bloomUBOs[BLOOM_LEVELS + m];
      device.queue.writeBuffer(ubo, 0, tmp);
      bloomPasses.push({
        pipeline: upPipe,
        timingName: `Bloom up ${m}`,
        bindGroup: bg(upPipe, [bv[m], linSamp, { buffer: ubo }]),
        descriptor: { colorAttachments: [{ view: bv[m - 1], loadOp: 'load', storeOp: 'store' }] },
      });
    }
    bgComp = bg(compPipe, [hdrView, bv[0], linSamp, { buffer: compUBO }]);
  }

  // --------------------------------------------------------------------------------------
  // GPU timing
  // --------------------------------------------------------------------------------------
  const profiler=createGPUProfiler(device,qs.get('profile')==='1');
  let profileSummary='Waiting for frame timing…';
  let profilePanel=null, profileDetails=null, profileToggle=null;
  if(qs.get('profile')==='1'){
    profileDetails=document.createElement('details');profileDetails.id='gpu-profile';
    profileDetails.open=!matchMedia('(max-width:900px), (pointer:coarse)').matches;
    profileToggle=document.createElement('summary');profileToggle.textContent='Performance';
    profilePanel=document.createElement('pre');profilePanel.id='gpu-profile-details';
    profilePanel.textContent=profiler.text();profileDetails.append(profileToggle,profilePanel);
    document.body.append(profileDetails);
  }

  // --------------------------------------------------------------------------------------
  // Uniform data
  // --------------------------------------------------------------------------------------
  const simF = new Float32Array(56);
  const frameF = new Float32Array(96);
  const atmoF = new Float32Array(4);
  const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
  const LOOP = 600.0;  // s, spectrum time loop (frequencies quantised to it)
  let needSpectrum = true, envFull = true;
  let skySun = NaN, skyHaze = NaN, skyHeight = NaN;

  function writeSimStatic() {
    for (let c = 0; c < C; c++) {
      const L = CASC_L[c];
      simF[c] = L;
      simF[8 + c] = c === 0 ? Math.PI / L : (2 * Math.PI * 6) / L;            // kMin
      simF[16 + c] = c < C - 1 ? (2 * Math.PI * 6) / CASC_L[c + 1] : (Math.PI * N / L) * 0.98; // kMax
    }
    for (let c = 1; c < C; c++) simF[8 + c] = simF[16 + c - 1];
    simF[40] = P.windSpeed; simF[41] = P.windDir * D2R; simF[42] = P.fetchKm * 1000; simF[43] = 3.3;
    const ks = 2 * Math.PI / P.swellLength;
    simF[44] = P.swellHs; simF[45] = P.swellDir * D2R; simF[46] = Math.sqrt(9.81 * ks); simF[47] = P.swellSpread;
    simF[49] = 0.0012; simF[50] = LOOP; simF[51] = 1;
    simF[54] = 2.2; simF[55] = 1.0;
  }

  // --------------------------------------------------------------------------------------
  // Camera & input
  // --------------------------------------------------------------------------------------
  const cam = { x: 0, y: 2.4, z: 0, yaw: 0, pitch: -5.5 * D2R, fovY: 58 * D2R, speed: 6 };
  if(LAND_STAGE){const view=LANDFALL_VIEWS[LAND_STAGE];Object.assign(cam,view);cam.yaw=view.yaw*D2R;cam.pitch=view.pitch*D2R;cam.speed=45;}
  if (qs.get('cam')) {
    const v = qs.get('cam').split(',').map(Number);
    cam.x = v[0]; cam.y = v[1]; cam.z = v[2]; cam.yaw = (v[3] || 0) * D2R; cam.pitch = (v[4] || 0) * D2R;
  }
  if (qs.get('fov')) cam.fovY = Number(qs.get('fov')) * D2R;
  const param = (key, fallback, min, max) => {
    const value = Number(qs.get(key));
    return qs.has(key) && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  };
  let cameraMode = cameraModeFromLink(qs);
  const propulsion = propulsionFromLink(qs);
  const boat = {
    effects: qs.get('effects') !== '0', enabled: cameraMode === 'boat', showProw: qs.get('prow') !== '0', length: param('boatLength', DEFAULT_BOAT_LENGTH, 3, 100),
    beam: param('boatBeam', DEFAULT_BOAT_BEAM, 1, 20), heading: param('boatHeading', LAND_STAGE?0:propulsion === 'sail' ? param('windDir',P.windDir,0,360) : 0, 0, 360),
    propulsion, sailFore:param('sailFore',1,0,1), sailMain:param('sailMain',1,0,1), sailMizzen:param('sailMizzen',1,0,1),
    speed: param('boatSpeed', 6, 0, 40), eye: param('boatEye', HELM_EYE_HEIGHT, 1, 15),
    provisionDays:param('provisionDays',DEFAULT_PROVISION_DAYS,0,120),cargoTonnes:param('cargoTonnes',0,0,40),
    x: cam.x, z: cam.z, rudderTarget: param('boatRudder', 0, -35, 35), rudder: param('boatRudder', 0, -35, 35), yawRate: 0,
    heave: 0, pitch: 0, roll: 0, revision: 0, target: { heave: 0, pitch: 0, roll: 0 },
    waveSlopeX: 0, waveSlopeZ: 0, waveSampleTime: -1, waveRevision: -1,
  };
  boat.hydrodynamics=boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes);
  boat.heave=-boat.hydrodynamics.sinkage;
  const shipOrbit = { yaw:boat.heading*D2R+param('orbitYaw',57.3,-360,360)*D2R,
    elevation:param('orbitElevation',14.3,3.5,72)*D2R, distance:param('orbitDistance',32,10,120) };
  const eyePosition = new Float32Array(3);
  const boatForward = new Float32Array(3), boatRight = new Float32Array(3), boatUp = new Float32Array(3);
  const keys = Object.create(null);
  addEventListener('keydown', (e) => {
    if (/INPUT|SELECT/.test(e.target.tagName)) return;
    if (boat.enabled && ['ArrowLeft','ArrowRight','KeyA','KeyD','KeyX'].includes(e.code)) e.preventDefault();
    keys[e.code] = true;
    if (e.code === 'KeyH' && !e.repeat) togglePanel();
    if (e.code === 'KeyX') boat.rudderTarget = 0;
    if (e.code === 'KeyB' && !e.repeat) setCameraMode(boat.enabled ? 'free' : 'boat');
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  let suppressLookClick = false;
  canvas.addEventListener('click', () => {
    if(suppressLookClick) { suppressLookClick=false; return; }
    if (cameraMode !== 'ship' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(()=>{});
  });
  let dragging = false;
  canvas.addEventListener('mousedown', (e) => { if (e.button === 2 || (cameraMode === 'ship' && e.button === 0)) dragging = true; });
  addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  function turnView(dx,dy) {
    if(cameraMode === 'ship') {
      shipOrbit.yaw -= dx * 0.005;
      shipOrbit.elevation = Math.max(0.06,Math.min(1.25,shipOrbit.elevation+dy*0.004));
    } else {
      cam.yaw += dx * 0.0022;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - dy * 0.0022));
    }
  }
  addEventListener('mousemove', (e) => {
    if ((document.pointerLockElement === canvas || dragging)) turnView(e.movementX,e.movementY);
  });
  let touchLook=null;
  canvas.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'||e.defaultPrevented||touchLook)return;
    e.preventDefault();suppressLookClick=true;touchLook={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    if(touchLook?.id!==e.pointerId)return;
    turnView(e.clientX-touchLook.x,e.clientY-touchLook.y);touchLook.x=e.clientX;touchLook.y=e.clientY;
  });
  const releaseTouch=e=>{if(touchLook?.id===e.pointerId)touchLook=null;};
  canvas.addEventListener('pointerup',releaseTouch);canvas.addEventListener('pointercancel',releaseTouch);canvas.addEventListener('lostpointercapture',releaseTouch);
  canvas.addEventListener('wheel', (e) => {
    if(cameraMode === 'ship') shipOrbit.distance=Math.max(10,Math.min(120,shipOrbit.distance*(e.deltaY<0?0.9:1/0.9)));
    else cam.speed = Math.max(0.5, Math.min(400, cam.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  }, { passive: true });

  function updateBoat(dt) {
    const previousX=boat.x,previousZ=boat.z;
    const steering = boat.enabled ? (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) : 0;
    const age=Math.max(0,simTime-targetTime);
    const predicted=boat.waveAttitude??={heave:0,pitch:0,roll:0};
    for(const key of boatAxes){
      const rate=age<.25 && targetRevision===boat.revision?targetRate[key]:0;
      predicted[key]=boat.target[key]+rate*Math.min(age,.25);
    }
    const distance = stepBoatSurge(boat, boatWaveSlope(boat, simTime), dt, P.windSpeed, P.windDir * D2R);
    const previousHeading = boat.heading * D2R, previousYaw = boat.yawRate;
    stepBoatSteering(boat, steering, dt);
    const heading = previousHeading + (previousYaw + boat.yawRate) * dt * 0.25;
    boat.x += Math.sin(heading) * distance; boat.z -= Math.cos(heading) * distance;
    boat.x += Math.cos(heading) * boat.leewayDistance; boat.z += Math.sin(heading) * boat.leewayDistance;
    if(terrain)boat.coastBlocked=terrain.constrain(boat,previousX,previousZ);
    // Heave retains water-velocity compensation for asynchronous readback;
    // rotation instead integrates pressure and wind through physical inertia.
    const rate=age<.25 && targetRevision===boat.revision?targetRate.heave:0;
    boatSpring(boat,'heave',predicted.heave-boat.hydrodynamics.sinkage,boat.hydrodynamics.heaveOmega,dt,rate);
  }
  function updateCamera(dt) {
    if (boat.enabled) {
      stepBoatView(boat,dt);
      boatEyePosition(eyePosition,boat);
      cam.x=eyePosition[0]; cam.y=eyePosition[1]; cam.z=eyePosition[2];
      return;
    }
    if (cameraMode === 'ship') {
      const radius=shipOrbit.distance * Math.max(0.7,Math.sqrt(boat.length/DEFAULT_BOAT_LENGTH));
      const horizontal=radius*Math.cos(shipOrbit.elevation);
      cam.x=boat.x+Math.sin(shipOrbit.yaw)*horizontal;
      cam.z=boat.z+Math.cos(shipOrbit.yaw)*horizontal;
      cam.y=4*HULL_VERTICAL_SCALE+radius*Math.sin(shipOrbit.elevation);
      cam.yaw=Math.atan2(boat.x-cam.x,cam.z-boat.z);
      cam.pitch=-shipOrbit.elevation;
      return;
    }
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    let mx = 0, my = 0, mz = 0;
    const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const up = (keys.KeyE || keys.Space ? 1 : 0) - (keys.KeyQ || keys.KeyC ? 1 : 0);
    mx += fwd * cp * sy + str * cy;
    my += fwd * sp + up;
    mz += -fwd * cp * cy + str * sy;
    const boost = keys.ShiftLeft || keys.ShiftRight ? 5 : 1;
    const v = cam.speed * boost * dt;
    cam.x += mx * v; cam.y += my * v; cam.z += mz * v;
    cam.y = Math.max(1.0, Math.min(3000, cam.y));
    // keep clear of the actual (displaced) water surface under the camera
    if (cam.y < waterH + 0.9) cam.y += (waterH + 0.9 - cam.y) * Math.min(1, dt * 12);
    if(terrain)cam.y=Math.max(cam.y,terrain.height(cam.x,cam.z)+2);
  }

  // --------------------------------------------------------------------------------------
  // CDLOD node selection (CPU, allocation free)
  // --------------------------------------------------------------------------------------
  const ranges = new Float64Array(LODS);
  for (let l = 0; l < LODS; l++) ranges[l] = R0 * Math.pow(2, l);
  const planes = new Float64Array(16);
  let HB = 12.0;  // conservative bounds follow the selected sea state
  let XB = 8.0;
  let nodeCount = 0, ccx = 0, ccy = 0, ccz = 0;

  function sphereHit(x0, z0, size, r) {
    const dx = Math.max(x0 - ccx, 0, ccx - (x0 + size));
    const dz = Math.max(z0 - ccz, 0, ccz - (z0 + size));
    const dy = Math.max(-HB - ccy, 0, ccy - HB);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }
  function inFrustum(x0, z0, size) {
    const minx = x0 - XB - ccx, maxx = x0 + size + XB - ccx;
    const minz = z0 - XB - ccz, maxz = z0 + size + XB - ccz;
    const miny = -HB - ccy, maxy = HB - ccy;
    for (let p = 0; p < 16; p += 4) {
      const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
      const px = a > 0 ? maxx : minx, py = b > 0 ? maxy : miny, pz = c > 0 ? maxz : minz;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
  function addNode(x0, z0, size, lod) {
    if (nodeCount >= MAX_NODES) return;
    const o = nodeCount * 4;
    instData[o] = x0; instData[o + 1] = z0; instData[o + 2] = size; instData[o + 3] = lod;
    nodeCount++;
  }
  function selectNode(x0, z0, size, lod) {
    if (!sphereHit(x0, z0, size, ranges[lod])) return false;
    if (!sphereHit(x0, z0, size, MAX_DIST) || !inFrustum(x0, z0, size)) return true;
    if (lod === 0 || !sphereHit(x0, z0, size, ranges[lod - 1])) { addNode(x0, z0, size, lod); return true; }
    const h = size * 0.5;
    for (let i = 0; i < 4; i++) {
      const nx = x0 + (i & 1) * h, nz = z0 + (i >> 1) * h;
      if (!selectNode(nx, nz, h, lod - 1)) {
        if (sphereHit(nx, nz, h, MAX_DIST) && inFrustum(nx, nz, h)) addNode(nx, nz, h, lod - 1);
      }
    }
    return true;
  }
  function selectAll() {
    HB = 4 + 2 * P.swellHs + 0.025 * P.windSpeed * P.windSpeed;
    XB = Math.max(4, HB * P.choppy * 0.65);
    nodeCount = 0;
    ccx = cam.x; ccy = cam.y; ccz = cam.z;
    // side planes from the camera-relative view-projection (rows 3±0, 3±1)
    const m = viewProj;
    for (let i = 0; i < 4; i++) {
      const r = i >> 1, s = (i & 1) ? -1 : 1;
      planes[i * 4] = m[3] + s * m[r];
      planes[i * 4 + 1] = m[7] + s * m[4 + r];
      planes[i * 4 + 2] = m[11] + s * m[8 + r];
      planes[i * 4 + 3] = m[15] + s * m[12 + r];
    }
    const top = LODS - 1;
    const ts = LEAF * Math.pow(2, top);
    const x0 = Math.floor((ccx - MAX_DIST) / ts), x1 = Math.floor((ccx + MAX_DIST) / ts);
    const z0 = Math.floor((ccz - MAX_DIST) / ts), z1 = Math.floor((ccz + MAX_DIST) / ts);
    for (let zi = z0; zi <= z1; zi++) {
      for (let xi = x0; xi <= x1; xi++) selectNode(xi * ts, zi * ts, ts, top);
    }
  }

  // --------------------------------------------------------------------------------------
  // Per-frame uniforms
  // --------------------------------------------------------------------------------------
  let simTime = Number(qs.get('t')) || 0;
  let frameIndex = 0;

  function writeFrame(time) {
    const aspect = W / H;
    const tanY = Math.tan(cam.fovY * 0.5), tanX = tanY * aspect;
    const near = 0.05;
    proj.fill(0);
    proj[0] = 1 / tanX; proj[5] = 1 / tanY; proj[11] = -1; proj[14] = near;
    // Look just outside the sail envelope; manual look remains relative to this
    // forward quarter, and the bias follows the captain's smooth tack crossing.
    const viewYaw=cam.yaw+(boat.enabled?(boat.eyeSide??1)*15*D2R:0);
    const cy = Math.cos(viewYaw), sy = Math.sin(viewYaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    let fx = cp * sy, fy = sp, fz = -cp * cy;            // forward
    let rx = cy, ry = 0, rz = sy;                          // right
    let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx; // up = right x fwd
    if (boat.enabled) {
      boatRotate(boatForward, fx, fy, fz, boat.heading * D2R, boat.pitch, boat.roll);
      boatRotate(boatRight, rx, ry, rz, boat.heading * D2R, boat.pitch, boat.roll);
      boatRotate(boatUp, ux, uy, uz, boat.heading * D2R, boat.pitch, boat.roll);
      fx = boatForward[0]; fy = boatForward[1]; fz = boatForward[2];
      rx = boatRight[0]; ry = boatRight[1]; rz = boatRight[2];
      ux = boatUp[0]; uy = boatUp[1]; uz = boatUp[2];
    }
    view.fill(0);
    view[0] = rx; view[4] = ry; view[8] = rz;
    view[1] = ux; view[5] = uy; view[9] = uz;
    view[2] = -fx; view[6] = -fy; view[10] = -fz;
    view[15] = 1;
    mat4Mul(viewProj, proj, view);
    const f = frameF;
    f.set(viewProj, 0);
    f[16] = cam.x; f[17] = cam.y; f[18] = cam.z; f[19] = time;
    f[20] = rx * tanX; f[21] = ry * tanX; f[22] = rz * tanX; f[23] = 0;
    f[24] = ux * tanY; f[25] = uy * tanY; f[26] = uz * tanY; f[27] = 0;
    f[28] = fx; f[29] = fy; f[30] = fz; f[31] = 0;
    const se = P.sunElev * D2R, sa = P.sunAzim * D2R;
    f[32] = Math.sin(sa) * Math.cos(se); f[33] = Math.sin(se); f[34] = -Math.cos(sa) * Math.cos(se); f[35] = 14.0;
    f[36] = W; f[37] = H; f[38] = 1 / W; f[39] = 1 / H;
    for (let c = 0; c < C; c++) { f[40 + c] = CASC_L[c]; f[48 + c] = 1 / CASC_L[c]; }
    f[56] = Math.cos(P.windDir * D2R); f[57] = Math.sin(P.windDir * D2R); f[58] = P.windSpeed;
    f[60] = boat.heading * D2R; f[61] = boat.length; f[62] = boat.beam;
    f[63] = boat.showProw && qs.get('boatReflections') !== '0' ? 1 : 0;
    f[64] = R0; f[65] = GRID; f[66] = FOAM_LEVEL_SIZE[0]; f[67] = FOAM_LEVEL_SIZE[1];
    f[68] = P.exposure; f[69] = P.bloom; f[70] = frameIndex; f[71] = DBG;
    f[72] = P.haze; f[73] = Math.max(cam.y, 10) * 0.001;
    // deep water body scatter colour (greenish coastal water), unresolved slope variance
    f[76] = 0.016 * P.turbidity; f[77] = 0.080 * P.turbidity; f[78] = 0.096 * P.turbidity; f[79] = 0.0024;
    f[80] = 0.035; f[81] = 0.120; f[82] = 0.085; f[83] = 2.6;
    f[84] = 0.45; f[85] = 1.0; f[86] = Math.min(1,P.foam); f[87] = 1.0;
    f[88] = (5.802e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[89] = (13.558e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[90] = (33.1e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[91] = 1.1e-4;
    device.queue.writeBuffer(frameUBO, 0, f);
  }

  // --------------------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------------------
  const panel = document.getElementById('panel');
  function setPanelOpen(open) {
    if(open){setCaptainOpen(false);landfallUI.close();}
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('sea-settings-open', open);
    seaSettingsButton.setAttribute('aria-expanded', String(open));
  }
  function togglePanel() { setPanelOpen(panel.classList.contains('hidden')); }
  const boatPanel = document.createElement('section');
  boatPanel.id = 'boat-panel';
  boatPanel.setAttribute('aria-labelledby','boat-title');
  boatPanel.innerHTML = `<div class="panel-header"><strong id="boat-title">Boat perspective</strong></div>
    <div class="panel-body" id="boat-controls"><p>Use Rudder or A/D to steer. The helmsman works the tiller below the quarterdeck. Heading 0° follows the original view; 90° turns right.</p></div>`;
  const boatBody=boatPanel.querySelector('.panel-body');
  panel.before(boatPanel);
  const collapseBoat = document.createElement('button');
  collapseBoat.className = 'collapse'; collapseBoat.textContent = 'Hide';
  collapseBoat.setAttribute('aria-label', 'Toggle boat controls');
  collapseBoat.setAttribute('aria-controls','boat-controls');collapseBoat.setAttribute('aria-expanded','true');
  collapseBoat.onclick = () => { const compact = boatPanel.classList.toggle('compact'); collapseBoat.textContent = compact ? 'Controls' : 'Hide'; collapseBoat.setAttribute('aria-expanded',String(!compact)); };
  boatPanel.querySelector('.panel-header').append(collapseBoat);
  const prowLabel = document.createElement('label');
  prowLabel.textContent = 'Show ship';
  const prowToggle = document.createElement('input');
  prowToggle.type = 'checkbox'; prowToggle.checked = boat.showProw;
  prowToggle.addEventListener('change', () => { boat.showProw = prowToggle.checked; });
  prowLabel.append(prowToggle); boatBody.append(prowLabel);
  boat.crew=qs.get('crew')!=='0';
  const crewLabel=document.createElement('label');crewLabel.textContent='Show crew';
  const crewToggle=document.createElement('input');crewToggle.type='checkbox';crewToggle.checked=boat.crew;crewToggle.disabled=!crew;
  crewToggle.addEventListener('change',()=>{boat.crew=crewToggle.checked;});crewLabel.append(crewToggle);boatBody.append(crewLabel);
  const effectsLabel = document.createElement('label'); effectsLabel.textContent = 'Wakes & spray';
  const effectsToggle = document.createElement('input'); effectsToggle.type = 'checkbox'; effectsToggle.checked = boat.effects;
  effectsToggle.addEventListener('change', () => { boat.effects = effectsToggle.checked; });
  effectsLabel.append(effectsToggle); boatBody.append(effectsLabel);
  const cameraDock=document.createElement('div'); cameraDock.id='camera-dock';
  cameraDock.setAttribute('role','group'); cameraDock.setAttribute('aria-label','Scene controls');
  const cameraButtons=new Map();
  for(const [mode,label] of [['boat','Boat camera'],['free','Free camera'],['ship','View ship']]) {
    const button=document.createElement('button'); button.textContent=label;
    button.addEventListener('click',()=>setCameraMode(mode));
    cameraDock.append(button); cameraButtons.set(mode,button);
  }
  const seaSettingsButton = document.createElement('button');
  seaSettingsButton.textContent = 'Sea settings';
  seaSettingsButton.setAttribute('aria-controls', 'panel');
  seaSettingsButton.setAttribute('aria-expanded', 'false');
  seaSettingsButton.onclick = togglePanel;
  const captainButton=document.createElement('button');captainButton.textContent='Captain';
  captainButton.setAttribute('aria-controls','captain-panel');captainButton.setAttribute('aria-expanded','false');
  const captainPanel=document.createElement('section');captainPanel.id='captain-panel';captainPanel.hidden=true;
  captainPanel.setAttribute('aria-labelledby','captain-title');
  captainPanel.innerHTML='<div class="panel-header"><strong id="captain-title">Captain’s orders</strong></div><div class="panel-body"><p>Command the ship. The crew attends to its stations.</p></div>';
  panel.before(captainPanel);
  const captainBody=captainPanel.querySelector('.panel-body'),captainHide=document.createElement('button');
  captainHide.textContent='Hide';captainHide.setAttribute('aria-label','Hide captain orders');
  captainHide.onclick=()=>{setCaptainOpen(false);captainButton.focus();};captainPanel.querySelector('.panel-header').append(captainHide);
  function setCaptainOpen(open){
    captainPanel.hidden=!open;document.body.classList.toggle('captain-open',open);captainButton.setAttribute('aria-expanded',String(open));
    if(open){setPanelOpen(false);landfallUI.close();if(document.pointerLockElement)document.exitPointerLock();captainHide.focus();}
  }
  captainButton.onclick=()=>setCaptainOpen(captainPanel.hidden);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!captainPanel.hidden)captainHide.click();});
  const crewStatus=document.createElement('p');crewStatus.id='crew-status';crewStatus.setAttribute('role','status');crewStatus.textContent=crewError||'Sea watch · 12 aboard';captainBody.append(crewStatus);
  const orderButtons=new Map(),orders=document.createElement('div');orders.className='captain-orders';
  for(const order of CAPTAIN_ORDERS){
    const button=document.createElement('button');button.type='button';button.disabled=!crew;button.dataset.order=order.id;
    button.setAttribute('aria-label',order.label);button.setAttribute('aria-pressed',String(order.id==='watch'));
    const name=document.createElement('strong'),detail=document.createElement('span');name.textContent=order.label;detail.textContent=order.detail;button.append(name,detail);
    button.onclick=()=>{if(crew?.order(boat,order.id)){propulsionInput.value=boat.propulsion;showPropulsionControls();for(const [i,key] of SAIL_KEYS.entries())sailInputs[i].input.value=boat[key]*100;updateCrewUI();}};
    orders.append(button);orderButtons.set(order.id,button);
  }
  captainBody.append(orders);
  const crewDetails=document.createElement('details'),crewSummary=document.createElement('summary');crewSummary.textContent='Ship’s company · 6 women · 6 men';crewDetails.append(crewSummary);
  const crewList=document.createElement('ul');crewList.id='crew-roster';
  const crewRows=crew?crew.state.crew.map(s=>{const row=document.createElement('li');row.textContent=`${s.name} · ${s.role}`;crewList.append(row);return row;}):[];
  crewDetails.append(crewList);captainBody.append(crewDetails);
  function updateCrewUI(){
    if(!crew)return;
    const status=crew.status();if(crewStatus.textContent!==status)crewStatus.textContent=status;
    for(const [id,button] of orderButtons)button.setAttribute('aria-pressed',String(crew.state.order===id));
    if(crewDetails.open)for(const [i,s] of crew.state.crew.entries())crewRows[i].textContent=`${s.name} · ${s.role} · ${crewWorkLabel(s)}`;
  }
  const shareButton = document.createElement('button');
  shareButton.textContent = 'Copy share link';
  const sharePanel = document.createElement('div'); sharePanel.id = 'share-panel'; sharePanel.hidden = true;
  const shareInput = document.createElement('input');
  shareInput.type = 'url'; shareInput.readOnly = true; shareInput.setAttribute('aria-label', 'Share link');
  shareInput.addEventListener('click', () => shareInput.select());
  const closeShare = document.createElement('button'); closeShare.textContent = 'Close';
  closeShare.onclick = () => { sharePanel.hidden = true; shareButton.focus(); };
  const shareStatus = document.createElement('span'); shareStatus.setAttribute('role', 'status');
  sharePanel.append(shareInput, closeShare, shareStatus);
  shareButton.onclick = async () => {
    const url = createShareLink(location.href, P, boat, cameraMode);
    sharePanel.hidden = false; shareInput.value = url;
    // Also leave a shareable address in the browser if clipboard access is unavailable.
    try { history.replaceState(null, '', url); } catch { /* standalone file */ }
    try {
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = 'Link copied. It includes the sea, lighting, boat, and camera mode settings.';
    } catch {
      shareInput.focus(); shareInput.select();
      shareStatus.textContent = 'Select and copy this link to share your settings.';
    }
  };
  cameraDock.append(captainButton,seaSettingsButton, shareButton, sharePanel);
  const landfallUI=createLandfallUI({dock:cameraDock,active:!!terrain,stage:LAND_STAGE,weather:LAND_WEATHER,
    onOpen:()=>{setPanelOpen(false);setCaptainOpen(false);},
    getPosition:()=>boat,onWeather:settings=>{Object.assign(P,settings);for(const [key,{input,output}] of seaSliders){input.value=P[key];output.textContent=String(P[key]);}needSpectrum=true;envFull=true;}});
  if(LAND_STAGE){boatPanel.classList.add('compact');collapseBoat.textContent='Controls';collapseBoat.setAttribute('aria-expanded','false');}
  if(profileDetails)cameraDock.append(profileDetails);
  panel.before(cameraDock);
  // Keep controls in the visible viewport, including browser bars and keyboards.
  const layoutControls=()=>{
    const viewport=window.visualViewport, top=viewport?.offsetTop || 0, height=viewport?.height || innerHeight;
    if(profileDetails?.open && height<420 && innerHeight-height>100)profileDetails.open=false;
    const css=document.documentElement.style;
    css.setProperty('--view-top',top+'px');css.setProperty('--view-height',height+'px');
    css.setProperty('--keyboard-inset',Math.max(0,innerHeight-top-height)+'px');
    css.setProperty('--controls-bottom',(cameraDock.getBoundingClientRect().bottom+8)+'px');
  };
  new ResizeObserver(layoutControls).observe(cameraDock);
  window.visualViewport?.addEventListener('resize',layoutControls);
  window.visualViewport?.addEventListener('scroll',layoutControls);
  addEventListener('resize',layoutControls);layoutControls();
  const updateHelp = () => {
    document.querySelector('#hud .help').textContent = boat.enabled
      ? 'A/D or arrows: steer | X: centre rudder | B: free camera | click sea: look | Esc: release | H: sea settings'
      : cameraMode === 'ship' ? 'Drag: orbit ship | wheel: zoom | B: board ship | H: sea settings'
      : 'WASD: fly | Space/E: up | Q/C: down | wheel: speed | B: board ship | H: sea settings';
    for(const [mode,button] of cameraButtons) button.setAttribute('aria-pressed',String(mode===cameraMode));
  };
  function setCameraMode(mode) {
    if(mode===cameraMode) return;
    if(boat.enabled) {
      const viewYaw=cam.yaw+(boat.eyeSide??1)*15*D2R;
      boatRotate(boatForward,Math.cos(cam.pitch)*Math.sin(viewYaw),Math.sin(cam.pitch),-Math.cos(cam.pitch)*Math.cos(viewYaw),boat.heading*D2R,boat.pitch,boat.roll);
      cam.yaw=Math.atan2(boatForward[0],-boatForward[2]);
      cam.pitch=Math.asin(Math.max(-1,Math.min(1,boatForward[1])));
    }
    cameraMode=mode; boat.enabled=mode==='boat';
    if(boat.enabled) {cam.yaw=0;cam.pitch=-5.5*D2R;boat.eyeSide=boat.sailState?.tack??1;boat.eyeSideVelocity=0;boat.showProw=true;prowToggle.checked=true;}
    if(mode==='ship') {shipOrbit.yaw=boat.heading*D2R+1.0;boat.showProw=true;prowToggle.checked=true;}
    if(document.pointerLockElement) document.exitPointerLock();
    for(const k in keys) keys[k]=false;
    updateHelp();
  }
  updateHelp();
  const propulsionRow=document.createElement('label');propulsionRow.textContent='Propulsion';
  const propulsionInput=document.createElement('select');propulsionInput.id='boat-propulsion';
  for(const [value,label] of [['sail','Sailing'],['manual','Set speed']]){
    const option=document.createElement('option');option.value=value;option.textContent=label;propulsionInput.append(option);
  }
  propulsionInput.value=boat.propulsion;propulsionRow.append(propulsionInput);boatBody.append(propulsionRow);
  const boatMotion = document.createElement('p'); boatMotion.id='boat-motion'; boatBody.append(boatMotion);
  const sailControls=document.createElement('div');sailControls.id='sail-controls';boatBody.append(sailControls);
  const sailInputs=[];
  for(const [i,key] of SAIL_KEYS.entries()){
    const row=document.createElement('label'),name=document.createElement('span');name.textContent=['Fore course','Main course','Mizzen sail'][i];
    const input=document.createElement('input');Object.assign(input,{type:'range',min:0,max:100,step:5,value:boat[key]*100,id:'boat-'+key});
    input.setAttribute('aria-label',name.textContent);
    const output=document.createElement('output');output.textContent=Math.round(boat[key]*100)+'%';
    input.addEventListener('input',()=>{boat[key]=Number(input.value)/100;});
    row.append(name,input,output);sailControls.append(row);sailInputs.push({input,output});
  }
  const sailStatus=document.createElement('p');sailStatus.id='sail-status';sailControls.append(sailStatus);
  let speedRow;
  for (const [key, label, min, max, step] of [
    ['length', 'Length (m)', 3, 100, 0.5], ['beam', 'Beam (m)', 1, 20, 0.1],
    ['heading', 'Heading (°)', 0, 360, 1], ['speed', 'Calm-water speed (kn)', 0, 40, 0.5],
    ['eye', 'Camera height (m)', 1, 15, 0.1],
  ]) {
    const row = document.createElement('label');
    const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min, max, step, value: boat[key], id: 'boat-' + key });
    input.addEventListener('input', () => {
      if (!input.validity.valid || input.value === '') return;
      boat[key] = Number(input.value);
      if (key === 'length' || key === 'beam' || key === 'heading') boat.revision++;
    });
    row.append(name, input); boatBody.append(row);
    if(key==='speed')speedRow=row;
  }
  const loadingPanel=document.createElement('details');loadingPanel.id='boat-loading';
  const loadingTitle=document.createElement('summary');loadingTitle.textContent='Supplies and cargo';loadingPanel.append(loadingTitle);
  for(const [key,label,max,step] of [['provisionDays','Provisions for 12 (days)',120,5],['cargoTonnes','Additional cargo (t)',40,.5]]){
    const row=document.createElement('label'),name=document.createElement('span'),input=document.createElement('input');name.textContent=label;
    Object.assign(input,{type:'number',min:0,max,step,value:boat[key],id:'boat-'+key});input.setAttribute('aria-label',label);
    input.addEventListener('input',()=>{if(input.validity.valid&&input.value!==''){boat[key]=Number(input.value);boat.revision++;}});
    row.append(name,input);loadingPanel.append(row);
  }
  const loadingStatus=document.createElement('p');loadingStatus.id='boat-loading-status';loadingPanel.append(loadingStatus);boatBody.append(loadingPanel);
  function showPropulsionControls(){
    speedRow.hidden=boat.propulsion==='sail';sailControls.hidden=boat.propulsion!=='sail';
    note.textContent=boat.propulsion==='sail'
      ? 'Sails trim automatically. Reef in strong wind; lower all to coast. Waves and inertia continue to affect motion.'
      : 'Waves change speed and hull motion. Set the calm-water speed above.';
  }
  propulsionInput.addEventListener('change',()=>{boat.propulsion=propulsionInput.value;showPropulsionControls();});
  const rudderRow = document.createElement('label');
  rudderRow.textContent = 'Rudder';
  const rudderInput = document.createElement('input');
  Object.assign(rudderInput,{type:'range',min:-35,max:35,step:0.5,value:boat.rudderTarget,id:'boat-rudder'});
  const rudderValue = document.createElement('output'); rudderValue.textContent='0 deg';
  rudderInput.addEventListener('input',()=>{boat.rudderTarget=Number(rudderInput.value);});
  rudderRow.append(rudderInput,rudderValue); boatBody.append(rudderRow);
  const centreRudder = document.createElement('button'); centreRudder.textContent = 'Centre rudder';
  centreRudder.onclick = ()=>{boat.rudderTarget=0;}; boatBody.append(centreRudder);
  const helmReadout=document.createElement('p'); helmReadout.id='helm-readout'; boatBody.append(helmReadout);
  const centerView = document.createElement('button'); centerView.textContent = 'Look ahead';
  centerView.onclick = () => { setCameraMode('boat'); cam.yaw = 0; cam.pitch = -5.5 * D2R; };
  boatBody.append(centerView);
  const boatStatus = document.createElement('p'); boatStatus.setAttribute('aria-live', 'off'); boatBody.append(boatStatus);
  const note = document.createElement('p'); boatBody.append(note);showPropulsionControls();
  if(LAND_STAGE)Object.assign(P,LANDFALL_WEATHER[LAND_WEATHER],{swellHs:.65,windSpeed:5.5});
  for (const k of Object.keys(P)) if (qs.has(k) && Number.isFinite(Number(qs.get(k)))) P[k] = Number(qs.get(k));
  const seaTitle = document.createElement('strong'); seaTitle.textContent = 'Sea settings';
  seaTitle.id='sea-title';panel.setAttribute('aria-labelledby','sea-title');
  const seaHeader=document.createElement('div');seaHeader.className='panel-header';
  const hideSea=document.createElement('button');hideSea.textContent='Hide';hideSea.setAttribute('aria-label','Hide sea settings');
  hideSea.onclick=()=>{setPanelOpen(false);seaSettingsButton.focus();};seaHeader.append(seaTitle,hideSea);
  const seaBody=document.createElement('div');seaBody.className='panel-body';panel.append(seaHeader,seaBody);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.classList.contains('hidden'))hideSea.click();});
  const resolutionLabel=document.createElement('label');resolutionLabel.className='resolution-control';resolutionLabel.textContent='Render resolution';
  const resolutionInput=document.createElement('select');resolutionInput.id='render-resolution';
  for(const [value,label] of [['auto','Auto · 30+ FPS'],['native','Native (100%)'],['0.75','75%'],['0.5','50%'],...(fixedResolution?[['fixed','Fixed by URL']]:[])]) {
    const option=document.createElement('option');option.value=value;option.textContent=label;resolutionInput.append(option);
  }
  resolutionInput.value=resolution.mode;resolutionInput.disabled=fixedResolution;
  resolutionInput.addEventListener('change',()=>{resolution.setMode(resolutionInput.value);resize();updateResolutionStatus();});
  resolutionLabel.append(resolutionInput);
  const resolutionStatus=document.createElement('p');resolutionStatus.id='resolution-status';
  const updateResolutionStatus=()=>{resolutionStatus.textContent=`${W} × ${H} · ${resolution.mode==='fixed'?'fixed by URL':Math.round(resolution.scale*100)+'%'}${resolution.mode==='auto'?' · target 30 FPS':''}${resolution.mode==='auto'&&resolution.scale===resolution.minimum?' · minimum resolution':''}`;};
  seaBody.append(resolutionLabel,resolutionStatus);
  const roughButton = document.createElement('button'); roughButton.textContent = 'Hella rough';
  roughButton.title = '28 m/s wind, 8 m swell, and crossing waves';
  const seaSliders = new Map();
  roughButton.onclick = () => {
    Object.assign(P, ROUGH_SEAS);
    for (const [key, { input, output }] of seaSliders) { input.value = P[key]; output.textContent = String(P[key]); }
    needSpectrum = true; envFull = true;
  };
  seaBody.append(roughButton);
  const SLIDERS = [
    ['windSpeed', 'Wind speed at 10 m (m/s)', 0, 32, 0.1, 'spec'],
    ['windDir', 'Wind direction (deg)', 0, 360, 1, 'spec'],
    ['fetchKm', 'Fetch (km)', 5, 800, 1, 'spec'],
    ['swellHs', 'Swell height (m)', 0, 10, 0.05, 'spec'],
    ['swellLength', 'Swell wavelength (m)', 30, 300, 1, 'spec'],
    ['swellDir', 'Swell direction (deg)', 0, 360, 1, 'spec'],
    ['choppy', 'Choppiness', 0, 1.6, 0.01, ''],
    ['turbidity', 'Water turbidity', 0.2, 3, 0.01, ''],
    ['foam', 'Foam', 0, 3, 0.01, ''],
    ['spindrift', 'Crest spray', 0, 2, 0.05, ''],
    ['sunElev', 'Sun elevation (deg)', -2, 60, 0.1, ''],
    ['sunAzim', 'Sun azimuth (deg)', -180, 180, 0.5, ''],
    ['haze', 'Haze', 0.5, 15, 0.1, ''],
    ['clouds', 'Cloud coverage', 0, 1, 0.01, ''],
    ['cloudBase', 'Cloud base (km)', 0.3, 5, 0.1, ''],
    ['cloudDepth', 'Cloud depth (km)', 0.5, 5, 0.1, ''],
    ['cloudDensity', 'Cloud density', 0.1, 3, 0.05, ''],
    ['cloudAnvil', 'Storm development', 0, 1, 0.01, ''],
    ['cloudQuality', 'Cloud quality', 0.25, 1, 0.05, ''],
    ['exposure', 'Exposure', 0.1, 4, 0.01, ''],
    ['bloom', 'Bloom', 0, 0.3, 0.001, ''],
  ];
  for (const [key, label, min, max, step, kind] of SLIDERS) {
    const row = document.createElement('label');
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('output'); val.textContent = String(P[key]);
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'range', min, max, step, value: P[key], id: 'sea-' + key });
    inp.setAttribute('aria-label', label);
    seaSliders.set(key, { input: inp, output: val });
    inp.addEventListener('input', () => {
      P[key] = Number(inp.value); val.textContent = inp.value;
      if (kind === 'spec') needSpectrum = true;
      envFull = true;
    });
    row.append(name, inp, val);
    seaBody.appendChild(row);
  }
  if (qs.get('ui') === '0') { document.getElementById('hud').style.display = 'none'; panel.classList.add('hidden'); boatPanel.hidden = true; cameraDock.hidden=true; }


  const hudFps = document.getElementById('fps');

  // --------------------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------------------
  const submitList = [null];
  const shotName = qs.get('shot');
  const shotFrames = Number(qs.get('frames')) || 240;
  const shotSeq = Number(qs.get('seq')) || 1;
  let shotIdx = 0;
  const fixedDt = shotName ? 1 / 60 : 0;
  let last = performance.now();
  let fpsN = 0, fpsT = 0;
  let shooting = false;
  document.addEventListener('visibilitychange',()=>{last=performance.now();fpsN=0;fpsT=0;resolution.reset();});

  function encodeSim(cp) {
    cp.setPipeline(rowsPipe);
    cp.setBindGroup(0, bgRows);
    cp.dispatchWorkgroups(N, 1, C);
    cp.setPipeline(colsPipe);
    cp.setBindGroup(0, bgCols);
    cp.dispatchWorkgroups(N, 1, C);
    cp.setPipeline(simMipPipe);
    for (let m = 1; m < SIM_MIP_COUNT; m++) {
      const s = N >> m;
      cp.setBindGroup(0, bgSimMips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), C);
    }
    interaction.encode(cp);
    spindrift.encode(cp);
    wetness.encode(cp,boat.showProw && boat.effects!==false);
    // foam clipmaps
    foamCur = 1 - foamCur;
    cp.setPipeline(foamUpdPipe);
    cp.setBindGroup(0, bgFoamUpd[foamCur][interaction.current]);
    cp.dispatchWorkgroups(FOAM_RES / 8, FOAM_RES / 8, 2);
    cp.setPipeline(arr16MipPipe);
    const fm = bgFoamMips[foamCur];
    for (let m = 1; m < FOAMW_MIPS; m++) {
      const s = Math.max(1, FOAM_RES >> m);
      cp.setBindGroup(0, fm[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 2);
    }
  }

  function writeFoamUniforms(dt) {
    for (let l = 0; l < 2; l++) {
      const ts = FOAM_LEVEL_SIZE[l] / FOAM_RES;
      const cx = Math.floor(cam.x / ts), cz = Math.floor(cam.z / ts);
      foamUI[l * 4] = cx; foamUI[l * 4 + 1] = cz;
      // first frame: pretend the previous window was far away so everything is reset
      foamUI[l * 4 + 2] = foamFirst ? cx + 100000 : foamSnap[l * 2];
      foamUI[l * 4 + 3] = foamFirst ? cz + 100000 : foamSnap[l * 2 + 1];
      foamSnap[l * 2] = cx; foamSnap[l * 2 + 1] = cz;
      foamUF[8 + l] = ts;
    }
    foamFirst = false;
    foamUF[10] = dt; foamUF[11] = 0.85;          // decay 1/s
    foamUF[12] = 0.45; foamUF[13] = 1.0; foamUF[14] = P.foam; foamUF[15] = 0;
    for (let c = 0; c < C; c++) { foamUF[16 + c] = CASC_L[c]; foamUF[24 + c] = 1 / CASC_L[c]; }
    const drift = 0.03 * P.windSpeed;
    foamUF[32] = Math.cos(P.windDir * D2R) * drift; foamUF[33] = Math.sin(P.windDir * D2R) * drift;
    device.queue.writeBuffer(foamUBO, 0, foamUArr);
  }

  function frame(now) {
    if (shooting) return;  // paused while a screenshot is read back
    requestAnimationFrame(frame);
    landfallUI.update(now);
    const elapsed = Math.max(0, (now - last) / 1000);
    resolution.sample(elapsed,!document.hidden);
    resize();
    let dt = Math.min(0.1, elapsed);
    last = now;
    fpsN++; fpsT += elapsed;
    if (fpsT > 0.5) {
      const fps = fpsN / fpsT;
      hudFps.textContent = `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(2)} ms` +
        (hasTS ? `  |  GPU ${profiler.detailed?'window':'endpoints'} ${profiler.totalMs.toFixed(2)} ms` : '') + `  |  ${nodeCount} nodes  ${W}x${H}`;
      profileSummary=`${fps.toFixed(1)} fps · ${(1000/fps).toFixed(1)} ms/frame\n${W} × ${H} pixels · DPR ${window.devicePixelRatio||1}\nResolution: ${resolution.mode} · ${Math.round(resolution.scale*100)}%${resolution.mode==='auto'?' · target 30 FPS':''}\nOcean visibility: ${OCEAN_DEPTH?'depth first':'inline'}`;
      if(profilePanel)profilePanel.textContent=profileSummary+'\n'+profiler.text();
      if(profileToggle)profileToggle.textContent=`Performance · ${fps.toFixed(1)} FPS · ${Math.round(resolution.scale*100)}%`;
      updateResolutionStatus();
      updateCrewUI();
      boatStatus.textContent = boat.enabled
        ? `Pitch ${(boat.pitch / D2R).toFixed(1)}° · Roll ${(boat.roll / D2R).toFixed(1)}° · Heave ${boat.heave.toFixed(2)} m`
        : 'Ship continues to float while the camera explores';
      const hydro=boat.hydrodynamics;
      boatMotion.textContent = `Speed ${(boatForwardSpeed(boat)/KNOT_TO_MPS).toFixed(2)} kn · Displacement ${(hydro.mass/1000).toFixed(1)} t · Draft ${hydro.draft.toFixed(2)} m`;
      loadingStatus.textContent=`Crew ${(hydro.crewMass/1000).toFixed(2)} t · Water ${(hydro.waterMass/1000).toFixed(2)} t · Food ${(hydro.foodMass/1000).toFixed(2)} t · Casks and spares ${(hydro.storesMass/1000).toFixed(2)} t · Cargo ${(hydro.cargoMass/1000).toFixed(1)} t. Main-deck freeboard ${hydro.freeboard.toFixed(2)} m.${hydro.overloadKg>0?' Overloaded: this loading exceeds the supported draft.':''}`;
      const sails=sailingState(boat),angle=sails.apparentAngle/D2R;
      sailStatus.textContent=`${pointOfSail(sails.apparentAngle,sails.apparentSpeed)} · apparent wind ${sails.apparentSpeed.toFixed(1)} m/s, ${Math.abs(angle).toFixed(0)}° ${angle>=0?'starboard':'port'} · ${sails.area.toFixed(0)} m² set · wind torque ${Math.abs(sails.rollMoment/1000).toFixed(1)} kN·m`;
      for(let i=0;i<3;i++)sailInputs[i].output.textContent=Math.round(sails.set[i]*100)+'%';
      if(document.activeElement!==document.getElementById('boat-heading')) document.getElementById('boat-heading').value=boat.heading.toFixed(1);
      if(document.activeElement!==rudderInput) rudderInput.value=boat.rudderTarget;
      rudderValue.textContent=boat.rudder.toFixed(1)+' deg';
      helmReadout.textContent=`Heading ${boat.heading.toFixed(1)} deg | Rudder ${boat.rudder.toFixed(1)} deg | Turn ${(boat.yawRate/D2R).toFixed(1)} deg/s`;
      fpsN = 0; fpsT = 0;
    }
    if (fixedDt) dt = fixedDt;
    if(needSpectrum){boat.revision++;targetTime=-1;}
    updateBoat(dt);
    updateCamera(dt);
    simTime += dt;
    if (simTime > LOOP) simTime -= LOOP;
    frameIndex++;

    writeFrame(simTime);
    if (clouds.update(frameF,P,dt)) envFull = true;
    boatRotate(hullData.subarray(0, 3), 1, 0, 0, boat.heading * D2R, boat.pitch, boat.roll);
    boatRotate(hullData.subarray(4, 7), 0, 1, 0, boat.heading * D2R, boat.pitch, boat.roll);
    boatRotate(hullData.subarray(8, 11), 0, 0, -1, boat.heading * D2R, boat.pitch, boat.roll);
    hullData[12] = boat.beam; hullData[13] = boat.length; hullData[14] = boat.eye; hullData[15] = boat.rudder;
    hullData[16]=boat.x; hullData[17]=boat.heave; hullData[18]=boat.z; hullData[19]=simTime;
    hullData[20]=P.windDir*D2R-boat.heading*D2R; hullData[21]=P.windSpeed; hullData[22]=boat.showProw?1:0;
    const sails=sailingState(boat);
    hullData.set(sails.set,24);hullData[27]=boat.hatchesClosed??0;hullData[28]=sails.squareYaw;hullData[29]=sails.lateenYaw;
    hullData[30]=sails.squareFill;hullData[31]=sails.lateenFill;
    hullData[32]=sails.windSide;hullData[33]=-sails.windForward;hullData[34]=sails.apparentSpeed;hullData[35]=sails.canvasTack;
    device.queue.writeBuffer(hullUBO, 0, hullData);
    shadows.update(hullData,frameF.subarray(32,35),boat.showProw && qs.get('shadows')!=='0');
    crew?.update(boat,dt,P.windSpeed);
    wetness.updateCrew(crew?.state,boat);
    interaction.update(boat, dt, simTime, frameIndex, P.windSpeed, P.windDir * D2R, needSpectrum);
    spindrift.update(frameF, P.spindrift, dt, needSpectrum);
    if (needSpectrum) writeSimStatic();
    simF[48] = P.choppy;
    simF[52] = simTime; simF[53] = dt;
    device.queue.writeBuffer(simUBO, 0, simF);
    writeFoamUniforms(dt);
    selectAll();
    if (nodeCount) device.queue.writeBuffer(instBuf, 0, instData, 0, nodeCount * 4);

    const enc = device.createCommandEncoder();
    profiler.beginFrame(frameIndex);
    let cp = enc.beginComputePass({timestampWrites:profiler.writes('Waves + effects')});
    if (needSpectrum) {
      cp.setPipeline(initPipe);
      cp.setBindGroup(0, bgInit);
      cp.dispatchWorkgroups(N / 16, N / 16, C);
      needSpectrum = false;
    }
    const hazeChanged = frameF[72] !== skyHaze;
    const skyChanged = hazeChanged || frameF[33] !== skySun || frameF[73] !== skyHeight;
    if (hazeChanged) {
      atmoF[0] = P.haze;
      device.queue.writeBuffer(atmoUBO, 0, atmoF);
      cp.setPipeline(transPipe);
      cp.setBindGroup(0, bgTrans);
      cp.dispatchWorkgroups(256 / 8, 64 / 8);
      cp.setPipeline(msPipe);
      cp.setBindGroup(0, bgMS);
      cp.dispatchWorkgroups(32 / 8, 32 / 8);
    }
    encodeSim(cp);
    const doProbe = !probePending && (boat.showProw || boat.enabled || (frameIndex & 7) === 0);
    if (doProbe) {
      probeLength = boat.length; probeBeam = boat.beam; probeRevision = boat.revision;
      probeTime=simTime;
      boatUniform[0] = boat.heading * D2R; boatUniform[1] = boat.length;
      boatUniform[2] = boat.beam;
      boatUniform[4]=boat.x; boatUniform[5]=boat.heave; boatUniform[6]=boat.z;
      device.queue.writeBuffer(boatUBO, 0, boatUniform);
      cp.setPipeline(probePipe);
      cp.setBindGroup(0, bgProbe[interaction.current]);
      cp.dispatchWorkgroups(1);
    }
    if(profiler.detailed){cp.end();cp=enc.beginComputePass({timestampWrites:profiler.writes('Sky + clouds')});}
    // This LUT depends only on sun elevation, haze and effective camera altitude.
    if (skyChanged) {
      cp.setPipeline(skyViewPipe);
      cp.setBindGroup(0, bgSkyView);
      cp.dispatchWorkgroups(Math.ceil(SKY_W / 8), Math.ceil(SKY_H / 8));
      skySun = frameF[33]; skyHaze = frameF[72]; skyHeight = frameF[73];
    }
    clouds.encode(cp);
    terrain?.encode(cp,skyChanged);
    cp.setPipeline(sunVisPipe);
    cp.setBindGroup(0, bgSunVis);
    cp.setBindGroup(1, bgSunClouds);
    cp.dispatchWorkgroups(1);
    if(profiler.detailed){cp.end();cp=enc.beginComputePass({timestampWrites:profiler.writes('Reflections')});}
    cp.setPipeline(envPipe);
    cp.setBindGroup(0, bgEnv);
    cp.setBindGroup(1, bgEnvClouds);
    // one cube face per frame (all six on start-up / after parameter changes)
    const envFaces = envFull ? 6 : 1;
    cp.dispatchWorkgroups(ENV_SIZE / 8, ENV_SIZE / 8, envFaces);
    envFull = false;
    cp.setPipeline(cubeMipPipe);
    for (let m = 1; m < ENV_MIPS; m++) {
      const s = Math.max(1, ENV_SIZE >> m);
      cp.setBindGroup(0, bgCubeMips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), envFaces);
    }
    cp.end();

    const drawProw = boat.showProw;
    // Resolve the ocean straight into the reflection pyramid. The ship pass
    // preserves MSAA color/depth and resolves the finished scene into hdrView.
    mainPass.colorAttachments[0].resolveTarget=drawProw?waterView:hdrView;
    shadows.encode(enc,profiler,crew?.drawShadow);
    mainPass.timestampWrites=profiler.writes('Ocean + sky');
    mainPass.colorAttachments[0].storeOp = drawProw ? 'store' : 'discard';
    mainPass.depthStencilAttachment.depthStoreOp = drawProw ? 'store' : 'discard';
    const rp = enc.beginRenderPass(mainPass);
    terrain?.draw(rp);
    if (nodeCount) {
      rp.setVertexBuffer(0, instBuf);
      rp.setIndexBuffer(idxBuf, 'uint16');
      // Keep depth and colour in one render pass so tile attachments stay live.
      // The second draw shades only the surviving surface, with no discard.
      if (OCEAN_DEPTH) {
        rp.setPipeline(oceanDepthPipe);
        rp.setBindGroup(0, bgOceanDepth[interaction.current]);
        rp.drawIndexed(GRID * GRID * 6, nodeCount);
      }
      rp.setPipeline(oceanPipe);
      rp.setBindGroup(0, bgOcean[foamCur][interaction.current]);
      rp.setBindGroup(1, oceanShadows);
      if(coastalGroup)rp.setBindGroup(2,coastalGroup);
      rp.drawIndexed(GRID * GRID * 6, nodeCount);
    }
    rp.setPipeline(skyPipe);
    rp.setBindGroup(0, bgSky);
    clouds.drawSky(rp);
    rp.draw(3);
    if (!drawProw) spindrift.draw(rp);
    rp.end();

    if (drawProw) {
      const filterPass = enc.beginComputePass({timestampWrites:profiler.writes('Water reflection filter')}); filterPass.setPipeline(waterFilterPipe);
      for(let m=1;m<waterMips;m++) {
        filterPass.setBindGroup(0,waterMipGroups[m-1]);
        filterPass.dispatchWorkgroups(Math.ceil(Math.max(1,W>>m)/8),Math.ceil(Math.max(1,H>>m)/8));
      }
      filterPass.end();
      const prowPass = enc.beginRenderPass({
        timestampWrites:profiler.writes('Ship + spray'),
        colorAttachments: [{ view: mainPass.colorAttachments[0].view, resolveTarget: hdrView,
          loadOp: 'load', storeOp: 'discard' }],
        depthStencilAttachment: { view: mainPass.depthStencilAttachment.view, depthClearValue:0, depthLoadOp: 'load', depthStoreOp: 'discard' },
      });
      prowPass.setPipeline(caravelPipe); prowPass.setBindGroup(0, bgCaravel);
      prowPass.setBindGroup(1,caravelShadows);
      prowPass.setVertexBuffer(0, caravelBuffer); prowPass.setIndexBuffer(caravelIndexBuffer,'uint32'); prowPass.drawIndexed(caravelIndices.length);
      crew?.draw(prowPass);
      interaction.draw(prowPass); spindrift.draw(prowPass); prowPass.end();
    }

    if (P.bloom > 0) {
      for (const { descriptor, pipeline, bindGroup, timingName } of bloomPasses) {
        descriptor.timestampWrites=profiler.writes(timingName);
        const p = enc.beginRenderPass(descriptor);
        p.setPipeline(pipeline);
        p.setBindGroup(0, bindGroup);
        p.draw(3);
        p.end();
      }
    }

    compData[0] = P.exposure; compData[1] = P.bloom; compData[2] = frameIndex % 64; compData[3] = 0.10;
    // Neutral white balance: a fixed cool grade turned shaded oak green in daylight.
    compData[4] = 1.05; compData[5] = 1.06; compData[6] = 0; compData[7] = 1 / bloomLevels;
    device.queue.writeBuffer(compUBO, 0, compData);
    const swapTex = ctx.getCurrentTexture();
    compPass.colorAttachments[0].view = swapTex.createView();
    compPass.timestampWrites=profiler.writes('Composite');
    const pc = enc.beginRenderPass(compPass);
    pc.setPipeline(compPipe);
    pc.setBindGroup(0, bgComp);
    pc.draw(3);
    pc.end();

    if (doProbe) enc.copyBufferToBuffer(probeOut, 0, probeRead, 0, 64);
    const doTs=profiler.resolve(enc);
    let readBuf = null;
    if (shotName && shotIdx < shotSeq && frameIndex >= shotFrames + shotIdx) {
      shooting = true;
      const bpr = Math.ceil(W * 4 / 256) * 256;
      readBuf = device.createBuffer({ size: bpr * H, usage: GU.MAP_READ | GU.COPY_DST });
      enc.copyTextureToBuffer({ texture: swapTex }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
    }
    submitList[0] = enc.finish();
    device.queue.submit(submitList);
    if (doProbe) { probePending = true; probeRead.mapAsync(GPUMapMode.READ).then(onProbe, onProbeFail); }
    if (doTs) profiler.read();
    if (readBuf) saveShot(readBuf, Math.ceil(W * 4 / 256) * 256);
  }

  async function saveShot(buf, bpr) {
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(W, H);
    const bgra = swapFormat === 'bgra8unorm';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = y * bpr + x * 4, d = (y * W + x) * 4;
        img.data[d] = src[s + (bgra ? 2 : 0)];
        img.data[d + 1] = src[s + 1];
        img.data[d + 2] = src[s + (bgra ? 0 : 2)];
        img.data[d + 3] = 255;
      }
    }
    buf.unmap();
    buf.destroy();
    const oc = new OffscreenCanvas(W, H);
    oc.getContext('2d').putImageData(img, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    const nm = shotSeq > 1 ? shotName.replace('.png', `_${shotIdx}.png`) : shotName;
    await fetch('/__shot?name=' + encodeURIComponent(nm), { method: 'POST', body: blob });
    if(profilePanel){
      await profiler.settled();profilePanel.textContent=profileSummary+'\n'+profiler.text();
      await fetch('/__shot?name='+encodeURIComponent(nm.replace(/\.png$/i,'')+'.json'),{method:'POST',body:JSON.stringify({width:W,height:H,frame:frameIndex,oceanDepth:OCEAN_DEPTH,resolution:{mode:resolution.mode,scale:resolution.scale,targetFPS:resolution.targetFPS},parameters:P,boat:{targetKnots:boat.speed,speedKnots:boatForwardSpeed(boat)/KNOT_TO_MPS,acceleration:boat.surgeAcceleration,massKg:boat.hydrodynamics?.mass},profile:profiler.snapshot()},null,2)});
    }
    log('shot saved ' + nm + ' gpu ' + profiler.totalMs.toFixed(2) + 'ms nodes ' + nodeCount);
    shotIdx++;
    shooting = false;
    if (shotIdx < shotSeq) { requestAnimationFrame(frame); return; }
    if (shotSeq > 1) await fetch('/__shot?name=' + encodeURIComponent(shotName), { method: 'POST', body: blob });
    document.title = 'SHOT DONE';
    if (qs.get('keep') === '1') requestAnimationFrame(frame);
  }

  resize();
  updateResolutionStatus();
  addEventListener('resize', resize);
  requestAnimationFrame(frame);
}

main().catch((e) => { log('init failed: ' + (e && e.stack || e)); });
