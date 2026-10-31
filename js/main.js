import {withSceneHullProfile} from './wgsl/hull.js';
import {pruneWGSLFunctions} from './wgsl-prune.js';
import {createGPUProgramCache} from './gpu-program-cache.js';
import {createAstronomyClock,writeAstronomyFrame} from './astronomy.js';
import {createCelestialRenderer} from './celestial.js';
import {withCelestialFrame,CELESTIAL_FRAME_BYTES,CELESTIAL_FRAME_FLOATS} from './wgsl/celestial.js';
import { createSailingInstruments } from './instruments.js';
import { controlIcon, createHelmControls } from './controls.js';
import { createSceneAudio } from './audio.js';
import { createShipGunnery, createPortGunnery, resolveVesselCollisions } from './gunnery-control.js';
import { createGunneryControls } from './gunnery-ui.js';
import { createGunneryEffects } from './gunnery-effects.js';
import { createGunnerySeaProbe } from './gunnery-sea-probe.js';
import { createGunportSafety } from './gunport-safety.js';
import { createHullContactProbe } from './hull-contact.js';
import { createGunRecoilMap } from './gunnery-models.js';
import { CREW_VOICES } from './voice-assets.js';
import { createAnchorState } from './anchor-state.js';
import { createAnchorRenderer } from './anchor.js';
import { createDolphins } from './dolphins.js';
import { createDolphinControls } from './dolphin-ui.js';
import { createDeferredMarineLife } from './marine-loader.js';
import { createMarineControls } from './marine-ui.js';
import { createWeatherState, createImpactDetector, STORM_WEATHER, WEATHER_TYPES } from './weather-state.js';
import { createWeatherRenderer } from './weather.js';
import { writeLateenUniform, yardTransferAvailable } from './lateen.js';
import { createVolumetricClouds } from './clouds.js';
import { createTerrain, createDeepWaterGroup } from './terrain.js';
import { COASTAL_WATER } from './wgsl/terrain.js';
import { ISLAND, LANDFALL_VIEWS, SPANISH_MAIN_1550_REGIONS } from './terrain-model.js';
import { createLandfallUI, LANDFALL_WEATHER, LANDFALL_SEA, coastalSeaForRegion, landfallCameraYaw } from './landfall.js';
import { createVoyageController } from './voyage/voyage-controller.js';
import { createChartDrawer } from './voyage/chart-drawer.js';
import { islandCoordinates } from './terrain-model.js';
import { greatCircleKm } from './voyage/ocean-climate.js';
import { createGPUProfiler } from './profiler.js';
import { measureIsolatedGPUStage } from './gpu-benchmark.js';
import { createAdaptiveResolution, createAdaptivePolygons } from './resolution.js';
import { bindVesselModel, copyVessel, createVesselProbeState, acceptVesselProbe, stepVessel } from './vessels.js';
import { createFollower, steerFollower, commandFriendlyFleet, stepVesselCombatAI } from './follower.js';
import {readyFleetModels,fleetFromSearch,fleetToSearch,fleetFormation,broadsideFormation,fleetModelCode,fleetViewBounds,createFleetWakePool,validateFleetDevice,normalizeVesselFaction,MAX_FOLLOWERS} from './fleet.js';
import {withPooledFleetWakes} from './wgsl/fleet-wakes.js';
import {SCENE_WAKE_SAMPLE} from './wgsl/surface-coupling.js';
import {withSceneShadowCount, SHADOW_CAST} from './wgsl/shadows.js';
import { createVesselShadows, createSceneShadows } from './shadows.js';
import { createWaterInteraction } from './interaction.js';
import { WATER_CONTACTS, WAKE_UPDATE, SPRAY_UPDATE, SHEET_UPDATE, WATER_EFFECTS } from './wgsl/interaction.js';
import { SCENE_DECK_UPDATE, DECK_RENDER } from './wgsl/deck.js';
import { createSurfaceWaves } from './surface-waves.js';
import { createSpindrift } from './spindrift.js';
import { SPINDRIFT_UPDATE, SPINDRIFT_RENDER } from './wgsl/spindrift.js';
import { createSurfaceWetness } from './wetness.js';
import { WET_CLEAR, WET_DEPOSIT, WET_SEA, withPosedWetnessProbes } from './wgsl/wetness.js';
import {createRowingWaterProbe} from './rowing-water.js';
import {createRowingSurfaceEvents} from './rowing-surface-events.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import { createWaterOptics } from './water-optics.js';
import { createUnderwater } from './underwater.js';
import { createShipAssetCache } from './ship-mesh.js';
import { createVesselPose, POSED_VERTEX_LAYOUT, withPosedVesselVertices } from './vessel-pose.js';
import { VESSEL_POSE_UPDATE, VESSEL_SURFACE_POSE_UPDATE } from './wgsl/vessel-pose.js';
import {getShipModel} from './ship-models.js';
import {getShipParts} from './ship-parts.js';
import {vesselVerticalScale} from './hull.js';
import { crewWorkLabel, manGunStationsImmediate } from './crew-work.js';
import { createCrew, createFortSoldiers, preloadCrewModels, CAPTAIN_ORDERS } from './crew.js';
import { HELM_EYE_Z, HELM_EYE_HEIGHT, HULL_UNIFORM_BYTES, HULL_VERTICAL_SCALE, DEFAULT_BOAT_LENGTH, DEFAULT_BOAT_BEAM } from './hull.js';
import { SAIL_KEYS, sailingState, pointOfSail } from './sailing.js';
import { CARAVEL, WATER_FILTER } from './wgsl/caravel.js';
import { boatTargets, boatSpring, boatRotate, stepBoatSteering, stepBoatView, stepDeckWalk, resetDeckWalk, boatEyePosition, boatForwardSpeed, boatWaveSlope, stepBoatSurge, boatWaveAttitude, boatHydrodynamics, setBoatViewStation, deckStationLabel, DEFAULT_PROVISION_DAYS, KNOT_TO_MPS } from './boat.js';
import { SHIP_COLORS, DEFAULT_SHIP_COLORS, getShipColorsInfo, setVesselColors, strikeVesselColors, createShipColorsRenderer } from './ship-colors.js';
import { createDockingBoardingState, computeBoardingStrength } from './boarding-docking.js';
import { cameraModeFromLink, propulsionFromLink, createShareLink, encodeGameStateParam, decodeGameStateParam, ROUGH_SEAS } from './sharing.js';
import { ORBIT_LIMIT, orbitElevation, orbitDistance, panOrbit, placeOrbitCamera } from './camera.js';
// WebGPU ocean — custom renderer.
// FFT ocean (6 cascades) + CDLOD surface mesh + physically based sky + HDR post.
// All per-frame data lives in preallocated typed arrays / descriptors (no per-frame garbage
// apart from the unavoidable swap-chain view and command buffer objects).
import { N, CASCADES, SKY_W, SKY_H, ENV_SIZE, ENV_MIPS } from './wgsl/common.js';
import { SIM_INIT, FFT_ROWS, FFT_COLS, SIM_MIPS, FOAM_TEX, RGBA8_MIPS, SCENE_FOAM_UPDATE, ARRAY16_MIPS, FOAM_RES } from './wgsl/sim.js';
import { TRANS_LUT, MS_LUT, SKYVIEW_LUT, ENV_CUBE, CUBE_MIPS, SUN_VIS } from './wgsl/sky.js';
import { SKY_BG, SCENE_HEIGHT_PROBE, createOpticalOcean,withFleetHullCount } from './wgsl/ocean.js';
import { OCEAN_LIGHTING, withCachedOceanLighting } from './wgsl/ocean-lighting.js';
import { BLOOM_DOWN, BLOOM_UP, COMPOSITE, createUnderwaterPost } from './wgsl/post.js';

const qs = new URLSearchParams(location.search);
const urlGameState = qs.has('state') ? decodeGameStateParam(qs.get('state')) : null;
if (urlGameState) {
  const backfill = (k, v) => { if (v !== undefined && v !== null && !qs.has(k)) qs.set(k, String(v)); };
  const p = urlGameState.pos, s = urlGameState.ship, v = urlGameState.voyage;
  if (p) {
    backfill('lat', p.lat); backfill('lon', p.lon); backfill('drLat', p.drLat); backfill('drLon', p.drLon);
    backfill('region', p.region); backfill('boatX', p.x); backfill('boatZ', p.z);
    backfill('boatHeading', p.heading); backfill('boatSpeed', p.speed); backfill('boatRudder', p.rudder);
  }
  if (s) {
    backfill('ship', s.id); backfill('colors', s.colors); backfill('station', s.station);
    backfill('propulsion', s.propulsion); backfill('provisionDays', s.provisionDays); backfill('cargoTonnes', s.cargoTonnes);
    if (Array.isArray(s.sails)) {
      backfill('sailFore', s.sails[0]); backfill('sailMain', s.sails[1]); backfill('sailMizzen', s.sails[2]);
    }
  }
  if (v) {
    backfill('canvas', v.canvas); backfill('course', v.course); backfill('warp', v.warp);
  }
}
const BROADSIDE_SCENARIO=qs.get('broadside')==='1'||qs.get('scenario')==='broadside'||qs.get('situation')==='broadside';
const BROADSIDE_SIDE=qs.get('broadsideSide')==='port'?'port':'starboard';
const astronomy=createAstronomyClock(qs,{x:Number(qs.get('boatX'))||0,z:Number(qs.get('boatZ'))||0});
const READY_SHIPS=readyFleetModels();
const SHIP_ID=READY_SHIPS.some(model=>model.id===qs.get('ship'))?qs.get('ship'):(BROADSIDE_SCENARIO?'victory':'nina');
const rawLat=qs.has('lat')?Number(qs.get('lat')):qs.has('latitude')?Number(qs.get('latitude')):NaN;
const rawLon=qs.has('lon')?Number(qs.get('lon')):qs.has('longitude')?Number(qs.get('longitude')):NaN;
const matchedSpanishMain=Number.isFinite(rawLat)&&Number.isFinite(rawLon)
  ?Object.values(SPANISH_MAIN_1550_REGIONS).find(r=>Math.abs(rawLat-r.latitude)<0.05&&Math.abs(rawLon-r.longitude)<0.05)??null
  :null;
const hasExplicitLatLon=qs.has('lat')&&qs.has('lon')&&Number.isFinite(Number(qs.get('lat')))&&Number.isFinite(Number(qs.get('lon')));
const hasFallbackLandfallCoords=!hasExplicitLatLon&&Number.isFinite(rawLat)&&Number.isFinite(rawLon)&&
  (Math.abs(rawLat-ISLAND.latitude)>0.12||Math.abs(rawLon-ISLAND.longitude)>0.12)&&
  (qs.has('landfall')||qs.has('region')||(Boolean(matchedSpanishMain)&&qs.has('boatZ')&&Math.abs(Number(qs.get('boatZ'))-ISLAND.z)<4000));
const HAS_CUSTOM_COORDS=hasExplicitLatLon||hasFallbackLandfallCoords;
const IS_HEADLESS_TEST=qs.has('w')||qs.has('h')||qs.has('shot')||Boolean(window.victoryCheck)||Boolean(window.check);
const DEFAULT_LISBON_DOCK=!BROADSIDE_SCENARIO&&!IS_HEADLESS_TEST&&qs.get('ocean')!=='1'&&!qs.has('landfall')&&!qs.has('region')&&!HAS_CUSTOM_COORDS&&!qs.has('cam')&&!qs.has('boatX')&&!qs.has('boatZ');
const HAS_COASTAL_REGION=(qs.has('region')&&qs.get('region')!=='saba')||HAS_CUSTOM_COORDS||DEFAULT_LISBON_DOCK;
const VALID_LAND_STAGES=new Set([...Object.keys(LANDFALL_VIEWS),'harbor','dock']);
const LAND_STAGE=(qs.has('landfall')||HAS_COASTAL_REGION)?(VALID_LAND_STAGES.has(qs.get('landfall'))?qs.get('landfall'):DEFAULT_LISBON_DOCK?'dock':HAS_COASTAL_REGION?'coast':'approach'):null;
const LAND_WEATHER=Object.hasOwn(LANDFALL_WEATHER,qs.get('weather'))?qs.get('weather'):'clear';
const DBG = Number(qs.get('dbg')) || 0;
// Depth-first visibility avoids costly hidden-water shading; keep an A/B fallback.
const OCEAN_DEPTH = qs.get('oceanDepth') !== '0';
const D2R = Math.PI / 180;
const GU = globalThis.GPUBufferUsage;
const TU = globalThis.GPUTextureUsage;

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
  turbidity: 1.6,     // sediment/plankton scatter and submerged visibility
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
  rain: 0,           // precipitation amount; type selected independently
  precipitation: 0,  // rain, snow, sleet, hail
  thunder: 0,        // storm discharge frequency (zero disables flashes)
  soundVolume: .7,
  seabirds: .25,
  bloom: 0.10,
};
if(BROADSIDE_SCENARIO){
  Object.assign(P,{windSpeed:7.5,windDir:300,swellHs:2.0,swellDir:25,swellLength:110,sunElev:14,sunAzim:155});
}
const CASC_L = [1103.0, 211.3, 39.7, 7.43, 1.393, 0.2617];

function fail(msg) {
  window.oceanStartup?.fail(msg);
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
  const fleetConfig=fleetFromSearch(qs,SHIP_ID);
  if(!IS_HEADLESS_TEST&&!BROADSIDE_SCENARIO&&!qs.has('fleet')&&qs.get('follower')!=='1'){
    fleetConfig.length=0;
  }
  if(BROADSIDE_SCENARIO&&fleetConfig.length){
    fleetConfig[0].enabled=true;
    fleetConfig[0].faction??='enemy';
  }
  const broadsideRangeLengths=qs.has('broadsideRange')&&Number.isFinite(Number(qs.get('broadsideRange')))?Math.max(0.85,Number(qs.get('broadsideRange'))/getShipModel(SHIP_ID).runtime.length):1.22;
  const activeFleetSpecs=fleetConfig.flatMap((entry,index)=>{
    if(!entry.enabled)return [];
    const faction=normalizeVesselFaction(entry,{broadside:BROADSIDE_SCENARIO,index});
    return [{...entry,faction,formation:BROADSIDE_SCENARIO?broadsideFormation(index,{side:BROADSIDE_SIDE,rangeLengths:broadsideRangeLengths}):fleetFormation(index)}];
  });
  const standbyEncounterSpec=!IS_HEADLESS_TEST&&activeFleetSpecs.length===0&&qs.get('noEncounterShip')!=='1'&&qs.get('follower')!=='0'&&(!qs.has('fleet')||qs.get('fleet')!=='')
    ?[{id:'encounter-1',modelId:SHIP_ID,faction:'friendly',dormantEncounter:true,formation:fleetFormation(0)}]
    :[];
  const fleetSpecs=[{id:'player',modelId:SHIP_ID,faction:'friendly'},...activeFleetSpecs,...standbyEncounterSpec];
  const fleetCount=fleetSpecs.length;
  const sceneModelCodes=fleetSpecs.map(spec=>fleetModelCode(getShipModel(spec.modelId)));
  window.oceanStartup?.stage('adapter','Starting the graphics device…');
  if (!navigator.gpu) fail('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fail('No WebGPU adapter found.');
  const hasTS = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: hasTS ? ['timestamp-query'] : [],
  });
  validateFleetDevice(device.limits,fleetCount);
  let firstGpuError = false,oceanStartupDeviceLost=false,oceanStartupFirstFrameSubmitted=false;
  device.lost.then((i) => {oceanStartupDeviceLost=true;log('device lost: ' + i.message);window.oceanStartup?.fail('The graphics device was lost during startup. '+i.message);});
  device.onuncapturederror = (e) => { if (firstGpuError) return; firstGpuError = true; window.oceanStartup?.fail(e.error); log('GPU error: ' + e.error.message); const errorPanel = document.getElementById('err'); errorPanel.style.display = 'block'; errorPanel.textContent = e.error.message; };

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('webgpu');
  const swapFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: swapFormat, alphaMode: 'opaque', usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });
  window.oceanStartup?.stage('ocean-sky','Preparing the ocean and sky…');

  const {shader,computePipe}=createGPUProgramCache({device,prepare(code){
    if(qs.get('shaderModels')!=='all')code=withSceneHullProfile(code,sceneModelCodes);
    code=withCelestialFrame(code);code=withSceneShadowCount(code,fleetCount);
    if(code.includes(SCENE_WAKE_SAMPLE))code=withPooledFleetWakes(code,fleetCount);
    return qs.get('shaderPrune')==='off'?code:pruneWGSLFunctions(code);
  },report(messages,code,label){
    for(const msg of messages)if(msg.type!=='info'){
      const line=code.split('\n')[msg.lineNum-1];
      log(`[${label}] ${msg.type} ${msg.lineNum}:${msg.linePos} ${msg.message}\n    ${line}`);
    }
    if(messages.some(msg=>msg.type==='error'))fail('Shader compile error in '+label+' (see console)');
  }});

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

  // Foam micro-structure texture & world-space foam clipmaps
  const FOAM_SIZE = 512, FOAM_MIPS = 10;
  const foamTex = device.createTexture({
    label: 'foam detail', size: [FOAM_SIZE, FOAM_SIZE], format: 'rgba8unorm', mipLevelCount: FOAM_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
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
  const frameUBO = mkBuf(CELESTIAL_FRAME_BYTES, GU.UNIFORM | GU.COPY_DST, 'frame ubo (celestial528)');
  const sunVisBuf = mkBuf(64, GU.STORAGE, 'sun visibility and ocean lighting');
  const transView = transLUT.createView();
  const msView = msLUT.createView();
  const skyView = skyLUT.createView();
  const MSAA = 4;
  const HDR = 'rgba16float';

  // Kick off all ocean, atmosphere, cloud, and landfall shader/pipeline compilations and asset fetches concurrently
  const oakImagePromise = fetch('assets/caravel-oak-albedo.webp').then(r => r.blob()).then(b => createImageBitmap(b));
  oakImagePromise.catch(() => {});
  preloadCrewModels()?.catch(() => {});
  const rgba8MipPipePromise = computePipe(RGBA8_MIPS, 'rgba8 mips');
  const waterFilterPipePromise = computePipe(WATER_FILTER, 'water reflections filter');
  const surfaceWavesPromise = createSurfaceWaves({ device, computePipe });
  const waterOpticsPromise = surfaceWavesPromise.then(sw => createWaterOptics({ device, shader, seaView: fullArr(dispTex), seaSampler: samplerSim, format: HDR, surfaceWaves: sw }));
  const cloudsPromise = createVolumetricClouds({ device, frameUBO, transView, skyView, sampler: sampClamp, computePipe });
  const terrainPromise = LAND_STAGE ? createTerrain({ waterOptics: waterOpticsPromise, device, frameUBO, transView, skyView, sampler: sampClamp, envCubeView, clouds: cloudsPromise, shader, computePipe, mipPipe: rgba8MipPipePromise, format: HDR, samples: MSAA }) : Promise.resolve(null);
  const prewarmPromises = [
    computePipe(SCENE_DECK_UPDATE, 'deck wash'),
    shader(DECK_RENDER, 'deck water'),
    computePipe(WATER_CONTACTS, 'hull contact'),
    computePipe(WAKE_UPDATE, 'local wake'),
    computePipe(SPRAY_UPDATE, 'spray update'),
    computePipe(SHEET_UPDATE, 'impact sheets'),
    shader(WATER_EFFECTS, 'water effects'),
    computePipe(WET_CLEAR, 'wetting grid clear'),
    computePipe(WET_DEPOSIT, 'spray deposition'),
    computePipe(WET_SEA, 'wetting sea heights'),
    computePipe(withPosedWetnessProbes(), 'surface moisture'),
    shader(withPosedVesselVertices(SHADOW_CAST), 'vessel shadows'),
    computePipe(SPINDRIFT_UPDATE, 'crest spray update'),
    shader(SPINDRIFT_RENDER, 'crest spray'),
    ...(sceneModelCodes.some(c => c <= 1) ? [computePipe(VESSEL_POSE_UPDATE, 'shared vessel deformation')] : []),
    ...(sceneModelCodes.some(c => c >= 2) ? [computePipe(VESSEL_SURFACE_POSE_UPDATE, 'shared vessel deformation')] : []),
  ];
  for (const p of [rgba8MipPipePromise, waterFilterPipePromise, surfaceWavesPromise, waterOpticsPromise, cloudsPromise, terrainPromise, ...prewarmPromises]) p.catch(() => {});

  const oceanModPromise = shader(withCachedOceanLighting(withFleetHullCount(createOpticalOcean(COASTAL_WATER, OCEAN_DEPTH, true, true), fleetCount)), 'ocean');
  const renderPipesPromise = Promise.all([
    oceanModPromise.then(oceanMod => device.createRenderPipelineAsync({
      label: 'ocean', layout: 'auto',
      vertex: {
        module: oceanMod, entryPoint: 'vs',
        buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
      },
      fragment: { module: oceanMod, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: !OCEAN_DEPTH, depthCompare: OCEAN_DEPTH ? 'equal' : 'greater' },
      multisample: { count: MSAA },
    })),
    OCEAN_DEPTH ? oceanModPromise.then(oceanMod => device.createRenderPipelineAsync({
      label: 'ocean visibility', layout: 'auto',
      vertex: {
        module: oceanMod, entryPoint: 'vs',
        buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
      },
      fragment: { module: oceanMod, entryPoint: 'depthOnly', targets: [{ format: HDR, writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: MSAA },
    })) : null,
    shader(SKY_BG, 'sky').then(skyMod => device.createRenderPipelineAsync({
      label: 'sky', layout: 'auto',
      vertex: { module: skyMod, entryPoint: 'vs' },
      fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
      multisample: { count: MSAA },
    })),
    shader(BLOOM_DOWN, 'bloom down').then(downMod => device.createRenderPipelineAsync({
      label: 'bloom down', layout: 'auto',
      vertex: { module: downMod, entryPoint: 'vs' },
      fragment: { module: downMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    })),
    shader(BLOOM_UP, 'bloom up').then(upMod => device.createRenderPipelineAsync({
      label: 'bloom up', layout: 'auto',
      vertex: { module: upMod, entryPoint: 'vs' },
      fragment: {
        module: upMod, entryPoint: 'fs', constants: { bloomFoldTent: qs.get('bloomFilter') !== 'reference' },
        targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
      },
    })),
    shader(COMPOSITE, 'composite').then(compMod => device.createRenderPipelineAsync({
      label: 'composite', layout: 'auto',
      vertex: { module: compMod, entryPoint: 'vs' },
      fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
    })),
    shader(createUnderwaterPost(BLOOM_DOWN, 'bloom'), 'medium bloom source').then(mediumDownMod => device.createRenderPipelineAsync({
      label: 'medium bloom source', layout: 'auto',
      vertex: { module: mediumDownMod, entryPoint: 'vs' }, fragment: { module: mediumDownMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    })),
    shader(createUnderwaterPost(COMPOSITE, 'composite'), 'medium composite source').then(mediumCompMod => device.createRenderPipelineAsync({
      label: 'medium composite source', layout: 'auto',
      vertex: { module: mediumCompMod, entryPoint: 'vs' }, fragment: { module: mediumCompMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
    })),
  ]);
  renderPipesPromise.catch(() => {});

  const [initPipe, rowsPipe, colsPipe, simMipPipe, foamGenPipe, rgba8MipPipe,
    transPipe, msPipe, skyViewPipe, envPipe, cubeMipPipe, foamUpdPipe, arr16MipPipe, sunVisPipe,
    celestial, oceanLightingPipe] = await Promise.all([
    computePipe(SIM_INIT, 'sim init'),
    computePipe(FFT_ROWS, 'fft rows'),
    computePipe(FFT_COLS, 'fft cols'),
    computePipe(SIM_MIPS, 'sim mips'),
    computePipe(FOAM_TEX, 'foam tex'),
    rgba8MipPipePromise,
    computePipe(TRANS_LUT, 'transmittance'),
    computePipe(MS_LUT, 'multiscatter'),
    computePipe(SKYVIEW_LUT, 'skyview'),
    computePipe(ENV_CUBE, 'env cube'),
    computePipe(CUBE_MIPS, 'cube mips'),
    computePipe(SCENE_FOAM_UPDATE, 'foam update'),
    computePipe(ARRAY16_MIPS, 'array16 mips'),
    computePipe(SUN_VIS, 'sun visibility'),
    createCelestialRenderer({ device, shader, frameUBO, clock: astronomy, sampler: sampClamp, format: 'rgba16float', samples: 4 }),
    computePipe(OCEAN_LIGHTING, 'ocean frame lighting'),
  ]);

  const bg = (pipe, entries, label) => device.createBindGroup({
    label, layout: pipe.getBindGroupLayout(0),
    entries: entries.map((r, i) => ({ binding: i, resource: r })).filter(entry=>entry.resource!==null),
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

  const bgFoamMips = [0, 1].map((i) => {
    const out = [];
    for (let m = 1; m < FOAMW_MIPS; m++) out.push(bg(arr16MipPipe, [lvl(foamW[i], m - 1), lvl(foamW[i], m)]));
    return out;
  });

  const bgTrans = bg(transPipe, [{ buffer: atmoUBO }, transView], 'trans');
  const bgMS = bg(msPipe, [{ buffer: atmoUBO }, transView, sampClamp, msView], 'ms');
  const bgSkyView = bg(skyViewPipe, [{ buffer: frameUBO }, transView, msView, sampClamp, skyView], 'skyview');
  const bgEnv = bg(envPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, lvl(envTex, 0), { buffer: sunVisBuf },celestial.view], 'env');
  const bgSunVis = device.createBindGroup({ label:'sunvis', layout:sunVisPipe.getBindGroupLayout(0), entries:[
    { binding:0, resource:{ buffer:frameUBO } }, { binding:4, resource:{ buffer:sunVisBuf } },
  ] });
  const bgCubeMips = [];
  for (let m = 1; m < ENV_MIPS; m++) bgCubeMips.push(bg(cubeMipPipe, [lvl(envTex, m - 1), lvl(envTex, m), { buffer: frameUBO }], 'cubemip' + m));
  const bgOceanLighting=bg(oceanLightingPipe,[{buffer:frameUBO},transView,sampClamp,envCubeView,{buffer:sunVisBuf}]);

  // --------------------------------------------------------------------------------------
  // Render pipelines
  // --------------------------------------------------------------------------------------
  const [oceanPipe,oceanDepthPipe,skyPipe,downPipe,upPipe,compPipe,mediumDownPipe,mediumCompPipe]=await renderPipesPromise;

  window.oceanStartup?.stage('ship-crew','Building the ships and loading their crew…');
  const [waterFilterPipe, surfaceWaves, waterOptics] = await Promise.all([
    waterFilterPipePromise,
    surfaceWavesPromise,
    waterOpticsPromise,
  ]);
  const rowingSurfaceEvents=createRowingSurfaceEvents(surfaceWaves);
  const shipAssets=createShipAssetCache(),renderAssets=new Map();
  const sceneShadows=createSceneShadows(device,fleetCount),wakePool=createFleetWakePool(device,fleetCount);
  const fleetHullUBO=mkBuf(96*fleetCount,GU.UNIFORM|GU.COPY_DST,'scene hull masks'),fleetHullData=new Float32Array(24*fleetCount);
  const oceanShadows=sceneShadows.bind(oceanPipe);
  const oakSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
  async function shipRenderAsset(modelId){
    if(renderAssets.has(modelId))return renderAssets.get(modelId);
    const asset=shipAssets.get(modelId),gpuPose=asset.gpuPose;
    if(gpuPose!==true||typeof asset.pose==='function')throw Error('Ship rendering cannot bypass shared WebGPU deformation');
    fleetModelCode(asset.model); // A future model needs an explicit hull backend.
    const source=gpuPose?withPosedVesselVertices(CARAVEL):CARAVEL;
    const vertexLayouts=[{arrayStride:36,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32'},{shaderLocation:3,offset:28,format:'float32x2'},
    ]},...(gpuPose?[POSED_VERTEX_LAYOUT]:[])];
    const submergedPromise=waterOptics.capture({source,vertex:{entryPoint:'vs',buffers:vertexLayouts},world:'in.world',groups:2});
    submergedPromise.catch(()=>{});
    const module=await shader(source,modelId+' vessel');
    const pipeline=await device.createRenderPipelineAsync({label:modelId+' vessel',layout:'auto',
      vertex:{module,entryPoint:'vs',buffers:vertexLayouts},fragment:{module,entryPoint:'fs',targets:[{format:HDR}]},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:MSAA}});
    const submerged=await submergedPromise;
    const indexBuffer=mkBuf(asset.indices.byteLength,GU.INDEX|GU.COPY_DST,modelId+' shared indices');
    device.queue.writeBuffer(indexBuffer,0,asset.indices);
    const result={asset,gpuPose,pipeline,submerged,indexBuffer,poseAssets:null};
    renderAssets.set(modelId,result);return result;
  }
  const dolphinsPromise=createDolphins({waterOptics,surfaceWaves,device,frameUBO,transView,skyView,sampler:sampClamp,envView:envCubeView,sunVis:sunVisBuf,seaView:fullArr(dispTex),seaSampler:samplerSim,shader,format:HDR,samples:MSAA});
  const gunEffectsPromise=createGunneryEffects({surfaceWaves,device,frameUBO,transView,skyView,sampler:sampClamp,envView:envCubeView,sunVis:sunVisBuf,seaView:fullArr(dispTex),seaSampler:samplerSim,shader,format:HDR,samples:MSAA,depthSamples:MSAA});
  const gunSeaPromise=createGunnerySeaProbe({surfaceWaves,device,frameUBO,seaView:fullArr(dispTex),seaSampler:samplerSim,shader,computePipe});
  const gunportSafetyPromise=createGunportSafety({surfaceWaves,device,frameUBO,seaView:fullArr(dispTex),seaSampler:samplerSim,computePipe,maxAge:1.5,maxTravel:6.0});
  const probePipePromise=computePipe(SCENE_HEIGHT_PROBE,'height probe');
  const uniqueShipAssetsPromise=Promise.all([...new Set(fleetSpecs.map(s=>s.modelId))].map(shipRenderAsset));
  for(const p of [dolphinsPromise,gunEffectsPromise,gunSeaPromise,gunportSafetyPromise,probePipePromise,uniqueShipAssetsPromise])p.catch(()=>{});
  const oakImage = await oakImagePromise;
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
  await uniqueShipAssetsPromise;
  const vessels=[];let sharedCrew=null,crewError='';
  for(const [index,spec]of fleetSpecs.entries()){
    const render=await shipRenderAsset(spec.modelId),asset=render.asset,mesh=new Float32Array(asset.vertices);
    const vertexBuffer=mkBuf(mesh.byteLength,GU.VERTEX|GU.COPY_DST|(render.gpuPose?GU.STORAGE:0),spec.id+' geometry');
    device.queue.writeBuffer(vertexBuffer,0,mesh);
    const hullUBO=mkBuf(HULL_UNIFORM_BYTES,GU.UNIFORM|GU.COPY_DST,spec.id+' hull'),hullData=new Float32Array(HULL_UNIFORM_BYTES/4);
    const recoilMap=createGunRecoilMap(asset);
    const interactionPromise=createWaterInteraction({device,frameUBO,hullUBO,seaView:fullArr(dispTex),seaSampler:samplerSim,envView:envCubeView,transView,skyView,sunVis:sunVisBuf,shader,computePipe,surfaceWaves,wakeTargets:wakePool.layer(index)});
    const rowingWaterPromise=Object.hasOwn(ROWING_DESIGNS,spec.modelId)?createRowingWaterProbe({device,frameUBO,seaView:fullArr(dispTex),seaSampler:samplerSim,computePipe,modelId:spec.modelId,surfaceWaves}):null;
    interactionPromise.catch(()=>{});rowingWaterPromise?.catch(()=>{});
    const pose=await createVesselPose({device,computePipe,sourceBuffer:vertexBuffer,mesh,vertexCount:mesh.length/9,hullUBO,shared:render.poseAssets,rigData:asset.rigGPUData??null,recoilMap,partAssembly:asset.partAssembly??null});
    if(pose)render.poseAssets=pose.assets;
    const wetnessPromise=createSurfaceWetness({device,mesh:asset.vertices,hullUBO,frameUBO,computePipe,crewCount:Object.keys(asset.model.crewStations).length+Object.keys(asset.model.supplementalCrewStations??{}).length,posed:pose});
    const shadowsPromise=wetnessPromise.then(wetness=>createVesselShadows({device,hullUBO,mesh:asset.vertices,meshIndices:asset.indices,vertexBuffer,shader,wetness,targets:sceneShadows.layer(index),posed:pose}));
    const [wetness,shadows,interaction,rowingWater]=await Promise.all([
      wetnessPromise,
      shadowsPromise,
      interactionPromise,
      rowingWaterPromise,
    ]);
    let crew=null;
    try{crew=await createCrew({waterOptics,device,frameUBO,hullUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,wetness,shader,format:HDR,samples:MSAA,shared:sharedCrew,modelId:asset.model.id});sharedCrew??=crew.assets;}
    catch(error){if(index===0)crewError='Crew unavailable';console.warn(spec.id+' crew initialization:',error);}
    interaction.setShadows(shadows);
    vessels.push({...spec,boat:null,asset,render,hullUBO,hullData,mesh,vertexBuffer,pose,wetness,shadows,crew,interaction,
      rowingWater,lighting:shadows.bind(render.pipeline),submergedLighting:shadows.bind(render.submerged.pipeline),recoilMap});
  }
  const playerVessel=vessels[0],shipAsset=playerVessel.asset,hullUBO=playerVessel.hullUBO,crew=playerVessel.crew,interaction=playerVessel.interaction,shadows=playerVessel.shadows;
  let fortSoldiers=null;
  try{if(sharedCrew)fortSoldiers=await createFortSoldiers({device,frameUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,shader,format:HDR,samples:MSAA,shared:sharedCrew});}catch(error){console.warn('Fort garrison initialization:',error);}
  const spindriftPromise=createSpindrift({device,frameUBO,hullUBO,seaView:fullArr(dispTex),derivView:fullArr(derivTex),seaSampler:samplerSim,envView:envCubeView,transView,sunVis:sunVisBuf,shader,computePipe,shadows});
  const weatherRendererPromise=createWeatherRenderer({device,frameUBO,hullUBO,transView,skyView,sampler:sampClamp,shader,format:HDR,samples:MSAA});
  const hullContactProbePromise=createHullContactProbe({device,frameUBO,hullUBO,seaView:fullArr(dispTex),seaSampler:samplerSim,computePipe,modelId:shipAsset.model.id});
  const noAnchorRenderer=Object.freeze({update(){},draw(){},drawSubmerged(){}});
  const anchorsPromise=Promise.all(vessels.map(async v=>{v.anchorRenderer=getShipParts(v.modelId).equipment.anchor===null?noAnchorRenderer:await createAnchorRenderer({waterOptics,device,frameUBO,transView,skyView,sampler:sampClamp,envCubeView,sunVisBuf,shadows:sceneShadows,shader,format:HDR,samples:MSAA});}));
  const shipColorsPromise=createShipColorsRenderer({device,frameUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows:sceneShadows,shader,format:HDR,samples:MSAA,maxVessels:Math.max(4,vessels.length)});
  for(const p of [spindriftPromise,weatherRendererPromise,hullContactProbePromise,anchorsPromise,shipColorsPromise])p.catch(()=>{});
  const spindrift=await spindriftPromise;
  const shipColorsRenderer=await shipColorsPromise.catch(()=>null);
  for(const v of vessels)v.wetness.connect(v.interaction,spindrift,fullArr(dispTex),samplerSim);
  const wakeIndices=[0,1,2,3],wakeIndex=()=>wakePool.current+2*surfaceWaves.current;
  const bgFoamUpd=[0,1].map(i=>wakeIndices.map(w=>bg(foamUpdPipe,[{buffer:foamUBO},lvl(foamW[1-i],0),lvl(foamW[i],0),
    fullArr(dispTex),fullArr(derivTex),samplerSim,samplerSim,{buffer:wakePool.uniform},wakePool.views[w&1],interaction.sampler,
    null,null,{buffer:surfaceWaves.uniform},surfaceWaves.views[w>>1]],'foamupd'+i)));
  const oceanResources=(i,w)=>[{buffer:frameUBO},transView,skyView,sampClamp,
    fullArr(dispTex),fullArr(derivTex),fullArr(momTex),foamTex.createView(),envCubeView,sampRepeat,
    fullArr(foamW[i]),{buffer:sunVisBuf},{buffer:fleetHullUBO},{buffer:wakePool.uniform},wakePool.views[w&1],interaction.sampler,
    null,null,{buffer:surfaceWaves.uniform},surfaceWaves.views[w>>1]];
  const bgOcean=[0,1].map(i=>wakeIndices.map(w=>device.createBindGroup({label:'ocean'+i,layout:oceanPipe.getBindGroupLayout(0),
    entries:oceanResources(i,w).map((resource,binding)=>({binding,resource})).filter(e=>e.resource!==null&&(!OCEAN_DEPTH||e.binding!==12))})));
  const bgOceanDepth=OCEAN_DEPTH?wakeIndices.map(w=>device.createBindGroup({label:'ocean visibility',layout:oceanDepthPipe.getBindGroupLayout(0),
    entries:oceanResources(0,w).map((resource,binding)=>({binding,resource})).filter(e=>e.resource!==null&&[0,4,9,12,13,14,15,18,19].includes(e.binding))})):[];
  const bgSky=bg(skyPipe,[{buffer:frameUBO},transView,skyView,sampClamp,{buffer:sunVisBuf},celestial.view],'sky');
  window.oceanStartup?.stage('weather-wildlife','Preparing weather, scenery and wildlife…');
  const clouds = await cloudsPromise;
  clouds.setSkyPipeline(skyPipe);
  const bgEnvClouds = clouds.bindVolume(envPipe);
  const bgSunClouds = clouds.bindVolume(sunVisPipe,true);
  const weather=createWeatherState();
  let [terrain,weatherRenderer,,dolphins,gunEffects,gunSea,gunportSafety,hullContactProbe,probePipe]=await Promise.all([
    terrainPromise,
    weatherRendererPromise,
    anchorsPromise,
    dolphinsPromise,
    gunEffectsPromise,
    gunSeaPromise,
    gunportSafetyPromise,
    hullContactProbePromise,
    probePipePromise,
  ]);
  const deepWaterGroup=createDeepWaterGroup(device,oceanPipe);
  const deepWaterDepthGroup=OCEAN_DEPTH?createDeepWaterGroup(device,oceanDepthPipe):null;
  let coastalGroup=terrain?terrain.waterGroup(oceanPipe):deepWaterGroup;
  let coastalDepthGroup=OCEAN_DEPTH?(terrain?terrain.waterGroup(oceanDepthPipe):deepWaterDepthGroup):null;
  async function spawnTerrainLate({region,placement,lat,lon,name}={}){
    const nextTerrain=await createTerrain({
      waterOptics,device,frameUBO,transView,skyView,sampler:sampClamp,envCubeView,clouds,shader,computePipe,mipPipe:rgba8MipPipe,format:HDR,samples:MSAA,
      region:{...(typeof region==='object'?region:{}),id:region?.id,name:name??region?.name,latitude:lat??region?.latitude,longitude:lon??region?.longitude},
      placement,
      options:{lateSpawn:true},
    });
    if(!nextTerrain)return null;
    terrain=nextTerrain;
    coastalGroup=terrain.waterGroup(oceanPipe);
    coastalDepthGroup=OCEAN_DEPTH?terrain.waterGroup(oceanDepthPipe):null;
    if(typeof anchorEnvironment==='object'&&anchorEnvironment)anchorEnvironment.terrain=terrain;
    terrain.setPixelError?.(polygons.pixelError);
    envFull=true;
    return terrain;
  }
  function disposeTerrainLate(oldTerrain){
    if(oldTerrain&&oldTerrain!==terrain){oldTerrain.dispose?.();return;}
    terrain?.dispose?.();
    terrain=null;
    coastalGroup=deepWaterGroup;
    coastalDepthGroup=deepWaterDepthGroup;
    if(typeof anchorEnvironment==='object'&&anchorEnvironment)anchorEnvironment.terrain=null;
    envFull=true;
  }
  const marineLife=createDeferredMarineLife({waterOptics,surfaceWaves,device,frameUBO,transView,skyView,sampler:sampClamp,envView:envCubeView,sunVis:sunVisBuf,seaView:fullArr(dispTex),seaSampler:samplerSim,shader,format:HDR,samples:MSAA});
  dolphins.state.onSurfaceEvent=event=>surfaceWaves.emit(event);
  marineLife.state.onSurfaceEvent=event=>surfaceWaves.emit(event);
  const impactDetector=createImpactDetector();
  const audioRead=mkBuf(72*64,GU.MAP_READ|GU.COPY_DST,'audio hull contact readback');
  let audioPending=false;

  // Water height under the inspection camera; optics use it as a coarse host
  // scheduling hint. The inspection camera may cross the surface freely.
  let waterH=0;
  for(const vessel of vessels){
    const output=mkBuf(64,GU.STORAGE|GU.COPY_SRC,vessel.id+' probe output');
    const read=mkBuf(64,GU.MAP_READ|GU.COPY_DST,vessel.id+' probe read');
    const uniform=mkBuf(32,GU.UNIFORM|GU.COPY_DST,vessel.id+' probe');
    const groups=wakeIndices.map(w=>bg(probePipe,[{buffer:frameUBO},fullArr(dispTex),samplerSim,{buffer:output},{buffer:uniform},
      {buffer:wakePool.uniform},wakePool.views[w&1],interaction.sampler,fullArr(derivTex),
      null,null,{buffer:surfaceWaves.uniform},surfaceWaves.views[w>>1]],vessel.id+' probe'));
    vessel.probe={output,read,uniform,groups,values:new Float32Array(8),pending:false,requested:false,state:createVesselProbeState()};
  }
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
  const fixedPolygons = fixedResolution && !qs.has('polygons');
  const polygons = createAdaptivePolygons(fixedPolygons ? 'fixed' : qs.get('polygons') || 'auto');
  terrain?.setPixelError?.(polygons.pixelError);
  let nativeWidth = 0, nativeHeight = 0;
  let colorMS, depthMS, hdrTex, bloomTex, waterCopy, hdrView, waterView;
  let submergedColor,aboveWaterColor,submergedDepth,oceanOpticsGroup;
  const opticsUBO=mkBuf(16,GU.UNIFORM|GU.COPY_DST,'water extinction'),opticsData=new Float32Array(4);
  const underwaterMedium=await createUnderwater({device,shader,frameUBO,opticsUBO,transView,skyView,sampler:sampClamp,sunVis:sunVisBuf,
    derivView:fullArr(derivTex),seaSampler:samplerSim,cameraProbe:vessels[0].probe.output,surfaceWaves,sceneShadows,format:HDR,samples:MSAA,skipAir:true});
  const opticsEmptyLayout=device.createBindGroupLayout({entries:[]});
  const opticsEmptyGroup=device.createBindGroup({layout:opticsEmptyLayout,entries:[]});
  const submergedPass={label:'Submerged geometry',colorAttachments:[{view:null,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}],
    depthStencilAttachment:{view:null,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'discard'}};
  const aboveWaterPass={label:'Above-water geometry',colorAttachments:[{view:null,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}],
    depthStencilAttachment:{view:null,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'discard'}};
  let waterMips = 1, waterMipGroups = [];
  const mainPass = {
    colorAttachments: [{ view: null, resolveTarget: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
    depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  };
  const compPass = {
    colorAttachments: [{ view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    timestampWrites: undefined,
  };
  let bloomLevels = 0, bloomPasses = [], bgComp = null,bgCompUnderwater=null;
  let bloomMeasuring=false,bloomMeasureRequested=false,bloomCameraMediumBand=false,bloomFrameReady=false;

  function resize() {
    if(bloomMeasuring)return;
    const dpr = window.devicePixelRatio || 1;
    const nw = Math.max(1, Math.round(canvas.clientWidth * dpr)), nh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (nw !== nativeWidth || nh !== nativeHeight) { nativeWidth=nw; nativeHeight=nh; resolution.reset(); }
    const limit = device.limits.maxTextureDimension2D;
    const w = Math.max(1, Math.min(limit, Math.round(forcedWidth || nw * resolution.scale)));
    const h = Math.max(1, Math.min(limit, Math.round(forcedHeight || nh * resolution.scale)));
    if (w === W && h === H) return;
    W = w; H = h;bloomFrameReady=false;
    canvas.width = W; canvas.height = H;
    for (const t of [colorMS, depthMS, hdrTex, bloomTex, waterCopy,submergedColor,aboveWaterColor,submergedDepth]) t && t.destroy();
    submergedColor=device.createTexture({label:'submerged radiance and eye depth',size:[W,H],format:HDR,usage:TU.RENDER_ATTACHMENT|TU.TEXTURE_BINDING});
    aboveWaterColor=device.createTexture({label:'above-water radiance and eye depth',size:[W,H],format:HDR,usage:TU.RENDER_ATTACHMENT|TU.TEXTURE_BINDING});
    submergedDepth=device.createTexture({label:'submerged visibility',size:[W,H],format:'depth32float',usage:TU.RENDER_ATTACHMENT});
    submergedPass.colorAttachments[0].view=submergedColor.createView();
    submergedPass.depthStencilAttachment.view=submergedDepth.createView();
    aboveWaterPass.colorAttachments[0].view=aboveWaterColor.createView();
    aboveWaterPass.depthStencilAttachment.view=submergedDepth.createView();
    oceanOpticsGroup=device.createBindGroup({label:'water transmission',layout:oceanPipe.getBindGroupLayout(3),entries:[
      {binding:0,resource:submergedColor.createView()},{binding:1,resource:linSamp},{binding:2,resource:{buffer:opticsUBO}},
      {binding:3,resource:{buffer:vessels[0].probe.output}},{binding:4,resource:aboveWaterColor.createView()}]});
    colorMS = device.createTexture({ size: [W, H], format: HDR, sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    depthMS = device.createTexture({ size: [W, H], format: 'depth32float', sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    hdrTex = device.createTexture({ size: [W, H], format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    waterMips = Math.min(8, Math.floor(Math.log2(Math.max(W,H)))+1);
    waterCopy = device.createTexture({ size: [W, H], format: HDR, mipLevelCount: waterMips,
      usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.STORAGE_BINDING });
    waterMipGroups = [];
    for (let m=1;m<waterMips;m++) waterMipGroups.push(bg(waterFilterPipe,
      [lvl(waterCopy,m-1,'2d'),lvl(waterCopy,m,'2d')], 'water reflection mip'));
    for(const v of vessels){
      const resources=[{buffer:frameUBO},transView,skyView,sampClamp,
        envCubeView,{buffer:sunVisBuf},{buffer:v.hullUBO},waterCopy.createView(),fullArr(dispTex),samplerSim,oakTex.createView(),oakSampler,v.interaction.deck.view,
        {buffer:v.wetness.state},{buffer:v.wetness.lookup}];
      v.bindGroup=bg(v.render.pipeline,resources,v.id+' vessel');v.submergedGroup=v.render.submerged.bindGroup(resources);
    }
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1);
    bloomLevels = Math.min(BLOOM_LEVELS, Math.floor(Math.log2(Math.max(bw, bh))) + 1);
    bloomTex = device.createTexture({ size: [bw, bh], format: HDR, mipLevelCount: bloomLevels, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    mainPass.colorAttachments[0].view = colorMS.createView();
    mainPass.depthStencilAttachment.view = depthMS.createView();
    hdrView = hdrTex.createView();
    const mediumView=underwaterMedium.resize({width:W,height:H,hdrView,depthView:depthMS.createView(),submergedView:submergedColor.createView()});
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
        underwaterPipeline:m===0?mediumDownPipe:null,
        timingName: `Bloom down ${m}`,
        bindGroup: bg(downPipe, [m === 0 ? hdrView : bv[m - 1], linSamp, { buffer: bloomUBOs[m] }]),
        underwaterBindGroup:m===0?bg(mediumDownPipe,[mediumView,linSamp,{buffer:bloomUBOs[m]},hdrView,{buffer:frameUBO},{buffer:vessels[0].probe.output}]):null,
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
    bgCompUnderwater=bg(mediumCompPipe,[mediumView,bv[0],linSamp,{buffer:compUBO},hdrView,{buffer:frameUBO},{buffer:vessels[0].probe.output}]);
  }

  // --------------------------------------------------------------------------------------
  // GPU timing
  // --------------------------------------------------------------------------------------
  const profiler=createGPUProfiler(device,qs.get('profile')==='1');
  let profileSummary='Waiting for frame timing…';
  const performancePanel=document.createElement('section');performancePanel.id='performance-panel';
  performancePanel.hidden=qs.get('profile')!=='1'||matchMedia('(max-width:900px), (pointer:coarse)').matches;
  performancePanel.setAttribute('aria-labelledby','performance-title');
  performancePanel.innerHTML='<div class="panel-header"><strong id="performance-title">Performance</strong></div><div class="panel-body"></div>';
  const profileDetails=document.createElement('details');profileDetails.id='gpu-profile';profileDetails.open=true;
  const profileToggle=document.createElement('summary');profileToggle.textContent='GPU pass timing';
  const profilePanel=document.createElement('pre');profilePanel.id='gpu-profile-details';
  profilePanel.textContent=profiler.text();profileDetails.append(profileToggle,profilePanel);
  const performanceSummary=document.createElement('pre');performanceSummary.id='performance-summary';performanceSummary.textContent=profileSummary;
  const bloomMeasureButton=document.createElement('button');bloomMeasureButton.type='button';bloomMeasureButton.textContent='Measure bloom alone';bloomMeasureButton.disabled=!hasTS;
  const bloomMeasureResult=document.createElement('p');bloomMeasureResult.id='bloom-measurement';bloomMeasureResult.setAttribute('role','status');
  bloomMeasureResult.textContent=hasTS?'Pauses briefly to exclude earlier GPU waits.':'Separate bloom timing needs browser GPU timestamp support.';
  bloomMeasureButton.addEventListener('click',()=>{bloomMeasureRequested=true;delete bloomMeasureResult.dataset.measurement;bloomMeasureButton.disabled=true;bloomMeasureResult.textContent='Measuring bloom alone…';});
  performancePanel.querySelector('.panel-body').append(performanceSummary,bloomMeasureButton,bloomMeasureResult,profileDetails);document.body.append(performancePanel);
  const bloomProfileWrites=(_,name)=>profiler.writes(name);
  function encodeBloom(encoder,timestamps,mediumBand=bloomCameraMediumBand){
    for(let i=0;i<bloomPasses.length;i++){
      const {descriptor,pipeline,underwaterPipeline,bindGroup,underwaterBindGroup,timingName}=bloomPasses[i];
      descriptor.timestampWrites=timestamps?.(i,timingName);
      const pass=encoder.beginRenderPass(descriptor);
      pass.setPipeline(mediumBand&&underwaterPipeline?underwaterPipeline:pipeline);
      pass.setBindGroup(0,mediumBand&&underwaterBindGroup?underwaterBindGroup:bindGroup);pass.draw(3);pass.end();
    }
  }
  async function measureBloomAlone(){
    bloomMeasuring=true;bloomMeasureRequested=false;
    try{
      const result=await measureIsolatedGPUStage({device,encode:encodeBloom,passCount:bloomPasses.length,width:W,height:H});
      bloomMeasureResult.textContent=`Bloom alone: ${result.milliseconds>0?result.milliseconds.toFixed(2)+' ms':'below timer precision'} · ${W} × ${H} · ${bloomPasses.length} passes. Median of ${result.samples.length} isolated batches; earlier GPU work excluded.`;
      bloomMeasureResult.dataset.measurement=JSON.stringify(result);
    }catch(error){bloomMeasureResult.textContent='Bloom measurement unavailable: '+(error.message||error);}
    finally{
      bloomMeasuring=false;bloomMeasureButton.disabled=!hasTS;
      last=performance.now();fpsN=0;fpsT=0;resolution.reset();requestAnimationFrame(frame);
    }
  }
  let performanceButton=null;
  function setPerformanceOpen(open){
    performancePanel.hidden=!open;profiler.setDetailed(open);
    performanceButton?.setAttribute('aria-pressed',String(open));performanceButton?.setAttribute('aria-expanded',String(open));
    document.body.classList.toggle('performance-open',open);document.body.classList.toggle('show-performance',open);
    if(open){performanceSummary.textContent=profileSummary;profilePanel.textContent=profiler.text();}
  }
  document.body.classList.toggle('performance-open',!performancePanel.hidden);

  // --------------------------------------------------------------------------------------
  // Uniform data
  // --------------------------------------------------------------------------------------
  const simF = new Float32Array(56);
  const frameF = new Float32Array(CELESTIAL_FRAME_FLOATS);
  const atmoF = new Float32Array(4);
  const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
  const LOOP = 600.0;  // s, spectrum time loop (frequencies quantised to it)
  let needSpectrum = true, envFull = true;
  // Chart Course voyage (covert time warp); created once the dock/UI exists.
  let voyageCtl = null, chartDrawer = null, propulsionInput = null, sailInputs = [], speedRow = null, sailControls = null, note = null, helm = null;
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
  const activeLandViews=terrain?.views??LANDFALL_VIEWS;
  if(LAND_STAGE){const view=activeLandViews[LAND_STAGE]??LANDFALL_VIEWS[LAND_STAGE];Object.assign(cam,view);cam.yaw=view.yaw*D2R;cam.pitch=view.pitch*D2R;cam.speed=45;}
  if (qs.get('cam')) {
    const v = qs.get('cam').split(',').map(Number);
    if (v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])) {
      cam.x = v[0]; cam.y = v[1]; cam.z = v[2]; cam.yaw = (v[3] || 0) * D2R; cam.pitch = (v[4] || 0) * D2R;
    }
  }
  if (qs.get('fov')) cam.fovY = Number(qs.get('fov')) * D2R;
  const param = (key, fallback, min, max) => {
    const value = Number(qs.get(key));
    return qs.has(key) && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  };
  let cameraMode = (BROADSIDE_SCENARIO&&!qs.has('view')&&!qs.has('boat')&&!qs.has('cam'))?'ship':cameraModeFromLink(qs);
  cam.yaw=landfallCameraYaw(LAND_STAGE,cameraMode,qs.has('cam'),cam.yaw);
  const propulsion = propulsionFromLink(qs);
  const defaultCanvas = BROADSIDE_SCENARIO ? 0.55 : 1;
  const boat = {
    modelId:SHIP_ID,effects: qs.get('effects') !== '0', enabled: cameraMode === 'boat', showProw: qs.get('prow') !== '0', length: SHIP_ID!=='nina'?shipAsset.model.runtime.length:param('boatLength', DEFAULT_BOAT_LENGTH, 3, 100),
    beam: SHIP_ID!=='nina'?shipAsset.model.runtime.beam:param('boatBeam', DEFAULT_BOAT_BEAM, 1, 20), heading: param('boatHeading', LAND_STAGE?((activeLandViews[LAND_STAGE]??LANDFALL_VIEWS[LAND_STAGE]).heading??0):BROADSIDE_SCENARIO?0:propulsion === 'sail' ? param('windDir',P.windDir,0,360) : 0, 0, 360),
    propulsion, sailFore:param('sailFore',defaultCanvas,0,1), sailMain:param('sailMain',defaultCanvas,0,1), sailMizzen:param('sailMizzen',defaultCanvas,0,1),
    speed: param('boatSpeed', LAND_STAGE === 'dock' ? 1.5 : BROADSIDE_SCENARIO ? 4.2 : 6, 0, 40), eye: param('boatEye',SHIP_ID!=='nina'?shipAsset.model.nodes['helm.camera'].position[1]*shipAsset.model.designFrame.verticalScale:HELM_EYE_HEIGHT,1,25),
    provisionDays:param('provisionDays',getShipParts(SHIP_ID).loading.provisionDays,0,120),cargoTonnes:param('cargoTonnes',0,0,40),
    rowingEffort:param('rowingEffort',0,0,1),rowingTurn:param('rowingTurn',0,-1,1),rowingCadence:param('rowingCadence',ROWING_DESIGNS[SHIP_ID]?.propulsion.cadence??.45,.12,.70),
    x:param('boatX',cam.x,-1e7,1e7),z:param('boatZ',cam.z,-1e7,1e7),rudderTarget: param('boatRudder', 0, -35, 35), rudder: param('boatRudder', 0, -35, 35), yawRate: 0,
    heave: 0, pitch: 0, roll: 0, revision: 0, target: { heave: 0, pitch: 0, roll: 0 },
    waveSlopeX: 0, waveSlopeZ: 0, waveSampleTime: -1, waveRevision: -1,
  };
  bindVesselModel(boat);
  boat.hydrodynamics=boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes,boat.modelId);
  boat.heave=-boat.hydrodynamics.sinkage;
  if(BROADSIDE_SCENARIO)boat.surgeVelocity=boat.speed*KNOT_TO_MPS;
  if(terrain&&LAND_STAGE){
    const start=terrain.safeStart({x:boat.x,z:boat.z},boat);boat.x=start.x;boat.z=start.z;
    if(terrain.region&&!qs.has('astroLat')&&!qs.has('astroLon')){
      try{astronomy.set({latitude:terrain.region.latitude,longitude:terrain.region.longitude},boat);}catch{/* ignore */}
    }
  }
  let followerEnabled=vessels.slice(1).some(v=>!v.dormantEncounter);
  let squadronGunneryOrders=qs.get('squadronGuns')==='1'||vessels.slice(1).some(v=>!v.dormantEncounter&&v.faction==='enemy');
  const shouldSquadronObeyGunnery=()=>followerEnabled&&(squadronGunneryOrders||vessels.slice(1).some(v=>v.faction==='enemy'));
  boat.isPlayerVessel=true;
  boat.colors=qs.get('colors')||DEFAULT_SHIP_COLORS;
  if(qs.get('view')==='crows-nest')setBoatViewStation(boat,'crows-nest');
  boat.followingShip=followerEnabled;boat.fleet=fleetConfig;vessels[0].boat=boat;vessels[0].faction='friendly';
  boat.partAssembly=vessels[0].asset.partAssembly;
  for(const [idx,v] of vessels.slice(1).entries()){
    const L=Math.max(boat.length,v.asset.model.runtime.length),formation=v.formation;
    v.faction=normalizeVesselFaction(v,{broadside:BROADSIDE_SCENARIO,index:idx});
    v.boat=copyVessel(boat,{id:v.id,modelId:v.modelId,distance:L*formation.trail,side:L*formation.side});
    v.boat.faction=v.faction;
    v.boat.colors=v.faction==='enemy'?'jolly-roger':'castile';
    v.boat.battleColors=v.faction==='enemy'?'jolly-roger':'castile';
    v.boat.partAssembly=v.asset.partAssembly;
    if(BROADSIDE_SCENARIO)v.boat.surgeVelocity=boat.surgeVelocity;
    if(v.dormantEncounter){
      v.boat.showProw=false;
      v.boat.x=boat.x+50000;
      v.boat.z=boat.z+50000;
    }else{
      v.boat.showProw=true;
    }
    v.boat.onSurrender=(surrenderedBoat,dmg,reason)=>{
      const shipTitle=surrenderedBoat.shipName||v.asset?.model?.name||v.id||'Enemy vessel';
      const msg=`🏳️ ${shipTitle} has struck her colors and hoisted the white flag of surrender! (${reason})`;
      voyageCtl?.logExternal?.(msg,'combat');
      gunControls?.update?.();
      helm?.update?.(performance.now(),true);
    };
    v.follower=createFollower(formation,{
      faction:v.faction,
      salvoDelay:BROADSIDE_SCENARIO&&v.faction==='enemy'?8.0:0,
    });
    if(!v.dormantEncounter&&terrain&&LAND_STAGE){const start=terrain.safeStart(v.boat,v.boat);v.boat.x=start.x;v.boat.z=start.z;}
  }
  const makeGunneryOptions=(ownerBoat,prefix='')=>({
    deferSeaCollision:ownerBoat===boat,
    waterHeight:()=>ownerBoat.target?.heave??0,
    muzzleBlock:ownerBoat===boat?(gun,pose)=>{
      const r=gunportSafety.block(gun,pose,ownerBoat.gunnery.time,ownerBoat.revision);
      return r==='Checking sea at gunports'&&(BROADSIDE_SCENARIO||ownerBoat.gunnery.queue.length>0)?null:r;
    }:()=>null,
    getVessels:()=>vessels,
    getTerrain:()=>terrain,
    onOrder:(id,b)=>{
      sceneAudio.gunneryOrder(id,b);
      if(BROADSIDE_SCENARIO&&ownerBoat===boat&&(id==='fire-port'||id==='fire-starboard')){
        if(typeof setCaptainOpen==='function')setCaptainOpen(false);
        for(const v of vessels.slice(1)){
          if(v.faction!=='enemy'||!v.gunnery)continue;
          if(v.follower)v.follower.salvoDelay=0;
          const oppSide=id==='fire-port'?'starboard':'port';
          if(!v.gunnery.ordered&&!v.gunnery.state.queue.length){
            v.gunnery.readyAtQuarters(oppSide);
            if(v.crew)manGunStationsImmediate(v.crew.state,v.boat);
            v.gunnery.fire(oppSide);
          }
        }
      }
    },
    onEvent:event=>{
      sceneAudio.gunneryEvent(event);
      const shotKey=prefix+event.shotId;
      if(event.type==='shot')gunEffects.emitShot({...event,id:shotKey,chargeKg:event.mass*.3});
      else if(event.type==='impact'&&event.kind==='water'){
        gunEffects.emitImpact({...event,id:shotKey,position:event.surfacePosition,massKg:event.mass});
        surfaceWaves.emit({source:'roundshot',id:shotKey,kind:'entry',x:event.surfacePosition[0],z:event.surfacePosition[2],
          radiusMetres:Math.max(.18,event.radius*2),closingSpeed:Math.max(0,-event.velocity[1]),velocity:event.velocity,massKg:event.mass,
          age:Math.max(0,ownerBoat.gunnery.time-event.time)});
      }else if(event.type==='impact'){
        gunEffects.emitImpact({...event,id:shotKey,position:event.surfacePosition,massKg:event.mass,kind:event.kind});
        sceneAudio.impact({x:event.surfacePosition[0],z:event.surfacePosition[2],strength:Math.min(1,Math.cbrt(event.mass/12))});
        gunControls?.update?.();helm?.update?.(performance.now(),true);
      }
    },
  });
  const shipGuns=createShipGunnery(boat,makeGunneryOptions(boat,''));
  {
    const origPrepare=shipGuns.prepare.bind(shipGuns);
    const origFire=shipGuns.fire.bind(shipGuns);
    const origFireLoaded=shipGuns.fireLoaded.bind(shipGuns);
    const origSetFireAtWill=shipGuns.setFireAtWill.bind(shipGuns);
    const origCease=shipGuns.cease.bind(shipGuns);
    const origStandDown=shipGuns.standDown.bind(shipGuns);
    const origSetAmmo=shipGuns.setAmmo.bind(shipGuns);
    const origSetElevation=shipGuns.setElevation.bind(shipGuns);
    const origSetTraverse=shipGuns.setTraverse.bind(shipGuns);
    const origTrainOnTarget=shipGuns.trainOnTarget.bind(shipGuns);
    shipGuns.prepare=side=>{const ok=origPrepare(side);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'prepare',side});return ok;};
    shipGuns.fire=(side,opts)=>{const ok=origFire(side,opts);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:opts?.allowPartial?'fire-loaded':'fire',side});return ok;};
    shipGuns.fireLoaded=side=>{const ok=origFireLoaded(side);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'fire-loaded',side});return ok;};
    shipGuns.setFireAtWill=(enabled,side)=>{const ok=origSetFireAtWill(enabled,side);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'fire-at-will',enabled,side});return ok;};
    shipGuns.cease=()=>{origCease();if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'cease'});};
    shipGuns.standDown=()=>{origStandDown();if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'stand-down'});};
    shipGuns.setAmmo=type=>{const next=origSetAmmo(type);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'ammo',ammo:next});return next;};
    shipGuns.setElevation=deg=>{const next=origSetElevation(deg);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'elevation',elevation:next});return next;};
    shipGuns.setTraverse=deg=>{const next=origSetTraverse(deg);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'traverse',traverse:next});return next;};
    shipGuns.trainOnTarget=side=>{const res=origTrainOnTarget(side);if(shouldSquadronObeyGunnery())commandFriendlyFleet(vessels,{type:'train-target',side});return res;};
  }
  vessels[0].gunnery=shipGuns;
  for(const v of vessels.slice(1))v.gunnery=createShipGunnery(v.boat,makeGunneryOptions(v.boat,v.id+'-'));
  let activePortRef=terrain?.port??null;
  let portGunnery=activePortRef?createPortGunnery(activePortRef,{
    getVessels:()=>followerEnabled?vessels:[vessels[0]],
    getTerrain:()=>terrain,
    onEvent:event=>{
      sceneAudio.gunneryEvent(event);
      const shotKey='port-'+event.shotId;
      if(event.type==='shot')gunEffects.emitShot({...event,id:shotKey,chargeKg:event.mass*.3});
      else if(event.type==='impact'&&event.kind==='water'){
        gunEffects.emitImpact({...event,id:shotKey,position:event.surfacePosition,massKg:event.mass});
      }else if(event.type==='impact'){
        gunEffects.emitImpact({...event,id:shotKey,position:event.surfacePosition,massKg:event.mass,kind:event.kind});
      }
    },
  }):null;
  if(qs.get('ammo'))for(const v of vessels)v.gunnery.setAmmo?.(qs.get('ammo'));
  if(BROADSIDE_SCENARIO&&qs.get('gunsReady')!=='0'){
    shipGuns.readyAtQuarters(BROADSIDE_SIDE);
    if(crew)manGunStationsImmediate(crew.state,boat);
    const companionSide=BROADSIDE_SIDE==='port'?'starboard':'port';
    for(const v of vessels.slice(1)){
      v.gunnery.readyAtQuarters(companionSide);
      if(v.crew)manGunStationsImmediate(v.crew.state,v.boat);
    }
  }
  for(const v of vessels)v.anchor=createAnchorState(v.boat,{source:'anchor:'+v.id,onSurfaceEvent:event=>surfaceWaves.emit(event)});
  for(const v of vessels)if(v.rowingWater)v.boat.rowingWater=v.rowingWater;
  // Refresh the entry level from the latest local wave probe throughout the fall.
  const anchor=vessels[0].anchor,anchorEnvironment={terrain,settings:P,waterHeight:()=>boat.target.heave};
  const dockingBoarding=createDockingBoardingState(boat,{
    company:crew?.state??null,
    getAdditionalVessels:()=>followerEnabled?vessels.slice(1).filter(v=>v?.boat?.showProw):[],
    onEvent:ev=>{
      if(ev.type==='vessel-captured'&&voyageCtl?.voyage){
        const p=ev.plunder;
        if(voyageCtl.voyage.provisions){
          voyageCtl.voyage.provisions.water=Math.min(90,(voyageCtl.voyage.provisions.water??30)+(p?.waterDays??10));
          voyageCtl.voyage.provisions.food=Math.min(120,(voyageCtl.voyage.provisions.food??40)+(p?.foodDays??14));
        }
        voyageCtl.logExternal?.(`🏴 ${ev.state.statusText}`,'combat');
      }else if(ev.type==='boarding-repulsed'){
        voyageCtl?.logExternal?.(`⚔️ ${ev.state.statusText}`,'combat');
      }else if(ev.type==='dock-complete'||ev.type==='cast-off-complete'){
        voyageCtl?.logExternal?.(`🪢 ${ev.state.statusText}`,'order');
      }
      if(typeof updateCrewUI==='function')updateCrewUI();
      helm?.update?.(performance.now(),true);
    },
  });
  window.oceanDockingBoarding=dockingBoarding;
  const dolphinVessels=vessels.map(v=>v.boat),dolphinPlayer=[boat];
  window.oceanFleet={vessels,config:fleetConfig,wakes:wakePool,renderAssets};

  const broadsideMidPan=BROADSIDE_SCENARIO&&followerEnabled?(vessels[1].boat.x-boat.x)*0.5:0;
  const shipOrbit = { yaw:boat.heading*D2R+param('orbitYaw',BROADSIDE_SCENARIO?8:57.3,-360,360)*D2R,
    elevation:param('orbitElevation',BROADSIDE_SCENARIO?15:14.3,-ORBIT_LIMIT/D2R,ORBIT_LIMIT/D2R)*D2R,
    distance:param('orbitDistance',BROADSIDE_SCENARIO?64:shipAsset.model.geometry==='rowing-procedural-v1'||shipAsset.model.geometry==='later-sail-procedural-v1'?Math.max(12,shipAsset.model.runtime.length*1.6):SHIP_ID==='victory'?65:32,1,600),
    panX:param('orbitPanX',broadsideMidPan,-10000,10000),panY:param('orbitPanY',0,-10000,10000),panZ:param('orbitPanZ',0,-10000,10000),
    fleet:qs.get('fleetView')==='1',wildlife:qs.get('dolphinView')==='1',fleetZoom:1,radius:32 };
  const eyePosition = new Float32Array(3);
  const boatForward = new Float32Array(3), boatRight = new Float32Array(3), boatUp = new Float32Array(3);
  const keys = Object.create(null);
  addEventListener('keydown', (e) => {
    if (/INPUT|SELECT/.test(e.target.tagName)) return;
    if (voyageCtl?.onKey(e)) { e.preventDefault(); return; }
    if (e.code === 'KeyM' && !e.repeat && chartDrawer) { chartDrawer.toggle(); e.preventDefault(); return; }
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code) || (boat.enabled && ['KeyA','KeyD','KeyW','KeyS','KeyQ','KeyE','KeyX'].includes(e.code))) e.preventDefault();
    keys[e.code] = true;
    if (e.code === 'KeyH' && !e.repeat) togglePanel();
    if (e.code === 'KeyP' && !e.repeat) setSimPaused(!simPaused);
    if (e.code === 'KeyX') boat.rudderTarget = 0;
    if (e.code === 'KeyB' && !e.repeat) setCameraMode(boat.enabled ? 'free' : 'boat');
    if (e.code === 'KeyV' && !e.repeat) {
      setBoatViewStation(boat, boat.viewStation === 'crows-nest' ? 'deck' : 'crows-nest');
      setCameraMode('boat');
      helm?.update?.(performance.now(), true);
    }
    if (e.code === 'KeyF' && !e.repeat && shipGuns.state.guns.length > 0) {
      const side = shipGuns.selectedSide || BROADSIDE_SIDE;
      if (e.shiftKey) {
        shipGuns.readyAtQuarters(side);
        if (crew) manGunStationsImmediate(crew.state, boat);
        shipGuns.fire(side);
      } else if (shipGuns.canFire(side)) {
        shipGuns.fire(side);
      } else if (!shipGuns.ordered) {
        shipGuns.prepare(side);
      }
      gunControls?.update?.();helm?.update?.(performance.now(),true);
    }
    if (e.code === 'KeyG' && !e.repeat && followerEnabled && vessels[1]?.gunnery?.state.guns.length > 0) {
      const oppSide = BROADSIDE_SIDE === 'port' ? 'starboard' : 'port';
      vessels[1].gunnery.readyAtQuarters(oppSide);
      if (vessels[1].crew) manGunStationsImmediate(vessels[1].crew.state, vessels[1].boat);
      vessels[1].gunnery.fire(oppSide);
    }
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  function turnView(dx,dy) {
    if(cameraMode === 'ship') {
      shipOrbit.yaw -= dx * 0.005;
      shipOrbit.elevation = orbitElevation(shipOrbit.elevation+dy*0.004);
    } else {
      cam.yaw += dx * 0.0022;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - dy * 0.0022));
    }
  }
  const lookPointers=new Map();
  const panView=(dx,dy)=>panOrbit(shipOrbit,dx,dy,shipOrbit.radius,cam.fovY,canvas.clientHeight);
  canvas.addEventListener('pointerdown',e=>{
    if(e.defaultPrevented||lookPointers.size>=2||![0,2].includes(e.button))return;
    if(lookPointers.size&&e.pointerType!=='touch')return;
    e.preventDefault();lookPointers.set(e.pointerId,{x:e.clientX,y:e.clientY,pan:e.button===2||e.shiftKey});canvas.setPointerCapture(e.pointerId);
    document.body.classList.add('has-looked');
  });
  canvas.addEventListener('pointermove',e=>{
    const pointer=lookPointers.get(e.pointerId);if(!pointer)return;
    const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
    if(cameraMode==='ship'&&lookPointers.size===2){
      const other=[...lookPointers.entries()].find(([id])=>id!==e.pointerId)[1];
      const before=Math.hypot(pointer.x-other.x,pointer.y-other.y);
      const after=Math.hypot(e.clientX-other.x,e.clientY-other.y);
      panView(dx*.5,dy*.5);
      if(before>8&&after>8){
        const ratio=before/after;
        if(shipOrbit.fleet||shipOrbit.wildlife)shipOrbit.fleetZoom=Math.max(.1,Math.min(6,shipOrbit.fleetZoom*ratio));
        else shipOrbit.distance=orbitDistance(shipOrbit.distance*ratio);
      }
    }else if(cameraMode==='ship'&&(pointer.pan||e.shiftKey))panView(dx,dy);
    else turnView(dx,dy);
    pointer.x=e.clientX;pointer.y=e.clientY;
  });
  const releaseTouch=e=>lookPointers.delete(e.pointerId);
  canvas.addEventListener('pointerup',releaseTouch);canvas.addEventListener('pointercancel',releaseTouch);canvas.addEventListener('lostpointercapture',releaseTouch);
  canvas.addEventListener('wheel', (e) => {
    // Trackpad pinch arrives as Ctrl-wheel in Chromium. The scene owns this
    // gesture; allowing its browser default would also scale the HUD/panels.
    e.preventDefault();
    if(cameraMode === 'ship'&&(shipOrbit.fleet||shipOrbit.wildlife))shipOrbit.fleetZoom=Math.max(.1,Math.min(6,shipOrbit.fleetZoom*(e.deltaY<0?.9:1/.9)));
    else if(cameraMode === 'ship') shipOrbit.distance=orbitDistance(shipOrbit.distance*(e.deltaY<0?0.9:1/0.9));
    else cam.speed = Math.max(0.5, Math.min(400, cam.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  }, { passive: false });

  function updateBoat(dt,resetSea=false){
    if(terrain&&!terrain.onGrounding){
      terrain.onGrounding=(groundedBoat,contact,report)=>{
        if(!contact||!report)return;
        const grdId=`grd-${Math.round(simTime*20)}`;
        const kind=contact.substrate==='stone'?'building':'terrain';
        const pos=[contact.worldX,(groundedBoat.heave??0)-Math.min(0.6,groundedBoat.draft??1.2)*0.3,contact.worldZ];
        const energy=Math.max(25000,(report.energyKj??40)*1000);
        gunEffects?.emitImpact?.({
          type:'impact',
          id:grdId,
          kind,
          ammo:'round',
          position:pos,
          surfacePosition:pos,
          normal:[contact.normalX??0,0.45,contact.normalZ??1],
          velocity:[-(contact.normalX??0)*(contact.impactSpeed??2)*12,2.5,-(contact.normalZ??1)*(contact.impactSpeed??2)*12],
          mass:10.9,
          massKg:10.9,
          energy,
        });
        surfaceWaves?.emit?.({
          source:'grounding',
          id:grdId,
          kind:'entry',
          x:contact.worldX,
          z:contact.worldZ,
          radiusMetres:Math.max(1.2,Math.min(4.2,1.0+(contact.overlap??0.3)*2.2)),
          closingSpeed:Math.max(1.0,(contact.impactSpeed??1.5)*1.4),
          velocity:[0,-1.5,0],
          massKg:120,
          age:0,
        });
        sceneAudio?.impact?.({
          x:contact.worldX,
          z:contact.worldZ,
          strength:Math.min(1,Math.max(0.3,(contact.impactSpeed??1.5)/4.5)),
        });
        gunControls?.update?.();
        helm?.update?.(performance.now(),true);
      };
    }
    const fieldTime=simTime+dt,wrapped=fieldTime>LOOP;
    for(const v of vessels)if(!v.bakedWreck||resetSea)v.rowingWater?.update(v.boat,dt,{time:wrapped?fieldTime-LOOP:fieldTime,choppy:P.choppy,hidden:document.hidden,resetSea:resetSea||wrapped});
    const steering=boat.enabled?(keys.KeyD?1:0)-(keys.KeyA?1:0):0;
    if(voyageCtl?.active){voyageCtl.manualSteering(steering!==0);if(steering===0)voyageCtl.steer(dt);}
    if(!vessels[0].bakedWreck||resetSea)stepVessel(boat,vessels[0].probe.state,dt,simTime,P.windSpeed,P.windDir*D2R,steering,terrain);
    if(followerEnabled){
      for(const v of vessels.slice(1)){
        if(v.dormantEncounter)continue;
        if(v.bakedWreck&&!resetSea){
          if(v.follower)v.follower.status='Sunk (wreck)';
          continue;
        }
        let steerRef=boat;
        if(v.faction==='enemy'){
          let bestDist=Infinity;
          for(const candidate of vessels){
            if((candidate.faction??'friendly')==='enemy'||candidate.boat?.damage?.sunk)continue;
            const d=Math.hypot((candidate.boat.x??0)-(v.boat.x??0),(candidate.boat.z??0)-(v.boat.z??0));
            if(d<bestDist){bestDist=d;steerRef=candidate.boat;}
          }
        }
        steerFollower(v.follower,v.boat,steerRef,dt,P.windSpeed,P.windDir*D2R,dolphinVessels);
        stepVesselCombatAI(v,{vessels,dt});
        stepVessel(v.boat,v.probe.state,dt,simTime,P.windSpeed,P.windDir*D2R,0,terrain);
      }
    }
    if(dt>0&&!resetSea&&followerEnabled&&vessels.length>1){
      resolveVesselCollisions(vessels,dt,{
        terrain,
        onCollision:ev=>{
          const colId=`col-${Math.round(simTime*20)}`;
          gunEffects?.emitImpact?.({...ev,id:colId,position:ev.surfacePosition,massKg:ev.mass,kind:'ship'});
          surfaceWaves?.emit?.({
            source:'collision',
            id:colId,
            kind:'entry',
            x:ev.surfacePosition[0],
            z:ev.surfacePosition[2],
            radiusMetres:Math.max(1.2,Math.min(4.5,ev.penetration*2+1.2)),
            closingSpeed:Math.max(1.2,ev.impactSpeed*1.6),
            velocity:ev.velocity,
            massKg:ev.mass*12,
            age:0,
          });
          sceneAudio?.impact?.({
            x:ev.surfacePosition[0],
            z:ev.surfacePosition[2],
            strength:Math.min(1,Math.max(0.35,ev.impactSpeed/5)),
          });
          gunControls?.update?.();
          helm?.update?.(performance.now(),true);
        },
      });
    }
  }
  function updateCamera(dt) {
    const lookYaw=(keys.ArrowRight?1:0)-(keys.ArrowLeft?1:0);
    const lookPitch=(keys.ArrowDown?1:0)-(keys.ArrowUp?1:0);
    if(lookYaw||lookPitch){
      turnView(lookYaw*dt*420,lookPitch*dt*320);
      document.body.classList.add('has-looked');
    }
    if (boat.enabled) {
      const walkFwd=(keys.KeyW?1:0)-(keys.KeyS?1:0);
      const walkStrafe=(keys.KeyE?1:0)-(keys.KeyQ?1:0);
      stepDeckWalk(boat,walkFwd,walkStrafe,cam.yaw+(boat.eyeSide??1)*15*D2R,dt);
      stepBoatView(boat,dt);
      boatEyePosition(eyePosition,boat);
      cam.x=eyePosition[0]; cam.y=eyePosition[1]; cam.z=eyePosition[2];
      return;
    }
    if (cameraMode === 'ship') {
      const fleet=shipOrbit.fleet&&followerEnabled;
      const wildlifeState=shipOrbit.marine?marineLife.state:dolphins.state;
      const wildlife=shipOrbit.wildlife&&wildlifeState.active;
      const fleetBounds=fleet?fleetViewBounds(dolphinVessels):null;
      let centreX=fleet?fleetBounds.x:boat.x,centreZ=fleet?fleetBounds.z:boat.z;
      let wildlifeRadius=0;
      if(wildlife){
        centreX=centreZ=0;const n=wildlifeState.count;
        for(let i=0;i<n;i++){centreX+=wildlifeState.animals[i].x/n;centreZ+=wildlifeState.animals[i].z/n;}
        for(let i=0;i<n;i++){const a=wildlifeState.animals[i];wildlifeRadius=Math.max(wildlifeRadius,Math.hypot(a.x-centreX,a.z-centreZ)+(shipOrbit.marine?(a.kind==='shark'?3:9):0));}
      }
      const halfFov=Math.atan(Math.tan(cam.fovY*.5)*Math.min(1,W/H));
      const fit=wildlife?(wildlifeRadius+4)/Math.sin(halfFov)*1.1:fleet?fleetBounds.radius/Math.sin(halfFov)*1.1:0;
      const radius=fleet||wildlife?fit*shipOrbit.fleetZoom:shipOrbit.distance * Math.max(0.7,Math.sqrt(boat.length/DEFAULT_BOAT_LENGTH));
      shipOrbit.radius=radius;
      placeOrbitCamera(cam,shipOrbit,centreX,wildlife?(shipOrbit.marine?2:.25):boat.heave+4*vesselVerticalScale(boat),centreZ,radius);
      if(terrain)cam.y=Math.max(cam.y,terrain.height(cam.x,cam.z)+.35);
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
    cam.y = Math.max(-500, Math.min(3000, cam.y));
    if(terrain)cam.y=Math.max(cam.y,terrain.height(cam.x,cam.z)+.35);
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
  let maxOceanNodes = MAX_NODES;
  let minOceanLod = 0;
  function addNode(x0, z0, size, lod) {
    if (nodeCount >= MAX_NODES) return;
    const o = nodeCount * 4;
    instData[o] = x0; instData[o + 1] = z0; instData[o + 2] = size; instData[o + 3] = lod;
    nodeCount++;
  }
  function selectNode(x0, z0, size, lod) {
    if (!sphereHit(x0, z0, size, ranges[lod])) return false;
    if (!sphereHit(x0, z0, size, MAX_DIST) || !inFrustum(x0, z0, size)) return true;
    if (lod <= minOceanLod || nodeCount + 64 > maxOceanNodes || !sphereHit(x0, z0, size, ranges[lod - 1])) { addNode(x0, z0, size, lod); return true; }
    const h = size * 0.5;
    const firstX = ccx >= x0 + h ? 1 : 0, firstZ = ccz >= z0 + h ? 2 : 0;
    for (let k = 0; k < 4; k++) {
      const i = k === 0 ? (firstX | firstZ) : k === 3 ? ((firstX ^ 1) | (firstZ ^ 2)) : k === 1 ? ((firstX ^ 1) | firstZ) : (firstX | (firstZ ^ 2));
      const nx = x0 + (i & 1) * h, nz = z0 + (i >> 1) * h;
      if (!selectNode(nx, nz, h, lod - 1)) {
        if (sphereHit(nx, nz, h, MAX_DIST) && inFrustum(nx, nz, h)) addNode(nx, nz, h, lod - 1);
      }
    }
    return true;
  }
  function selectAll() {
    maxOceanNodes = polygons.maxNodes(MAX_NODES);
    minOceanLod = polygons.scale < 0.2 ? 2 : polygons.scale < 0.45 ? 1 : 0;
    const r0 = Math.max(4, R0 * polygons.oceanRangeScale);
    for (let l = 0; l < LODS; l++) ranges[l] = r0 * Math.pow(2, l);
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
    const roots = [];
    for (let zi = z0; zi <= z1; zi++) {
      for (let xi = x0; xi <= x1; xi++) {
        const rx = xi * ts, rz = zi * ts, dx = rx + ts * 0.5 - ccx, dz = rz + ts * 0.5 - ccz;
        roots.push({ rx, rz, d2: dx * dx + dz * dz });
      }
    }
    roots.sort((a, b) => a.d2 - b.d2);
    for (const root of roots) selectNode(root.rx, root.rz, ts, top);
  }

  // --------------------------------------------------------------------------------------
  // Per-frame uniforms
  // --------------------------------------------------------------------------------------
  let simTime = Number(qs.get('t')) || 0;
  let frameIndex = 0;
  let simPaused = qs.get('paused') === '1';
  let pauseButton = null;
  function setSimPaused(paused) {
    simPaused = !!paused;
    if (pauseButton) {
      controlIcon(pauseButton, simPaused ? 'play' : 'pause', 'Pause simulation');
      pauseButton.title = simPaused ? 'Resume simulation (P)' : 'Pause simulation (P)';
      pauseButton.setAttribute('aria-pressed', String(simPaused));
    }
  }

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
    if(astronomy.mode==='astronomy')f.set(astronomy.state.sun.direction,32);
    writeAstronomyFrame(f,astronomy);
    f[36] = W; f[37] = H; f[38] = 1 / W; f[39] = 1 / H;
    for (let c = 0; c < C; c++) { f[40 + c] = CASC_L[c]; f[48 + c] = 1 / CASC_L[c]; }
    f[46] = P.swellHs; f[47] = P.swellLength;
    f[56] = Math.cos(P.windDir * D2R); f[57] = Math.sin(P.windDir * D2R); f[58] = P.windSpeed; f[59] = P.swellDir * D2R + 2 * Math.PI;
    f[60] = boat.heading * D2R; f[61] = boat.length; f[62] = boat.beam;
    f[63] = boat.showProw && qs.get('boatReflections') !== '0' ? 1 : 0;
    f[64] = Math.max(4, R0 * polygons.oceanRangeScale); f[65] = GRID; f[66] = FOAM_LEVEL_SIZE[0]; f[67] = FOAM_LEVEL_SIZE[1];
    f[68] = P.exposure*(astronomy.mode==='astronomy'?astronomy.state.exposureScale:1); f[69] = P.bloom; f[70] = frameIndex; f[71] = DBG;
    f[72] = P.haze; f[73] = Math.max(cam.y, 10) * 0.001;
    const strike=weather.strike,dx=strike?strike.x-cam.x:0,dz=strike?strike.z-cam.z:1,range=Math.hypot(dx,dz)||1;
    f[74]=dx/range;f[75]=dz/range;
    // deep water body scatter colour (greenish coastal water), unresolved slope variance
    f[76] = 0.016 * P.turbidity; f[77] = 0.080 * P.turbidity; f[78] = 0.096 * P.turbidity; f[79] = 0.0024;
    f[80] = 0.035; f[81] = 0.120; f[82] = 0.085; f[83] = 2.6;
    f[84] = 0.45; f[85] = 1.0; f[86] = Math.min(1,P.foam); f[87] = 1.0;
    f[88] = (5.802e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[89] = (13.558e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[90] = (33.1e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[91] = 1.1e-4;
    f[92]=weather.intensity;f[93]=weather.type;f[94]=weather.flash;f[95]=weather.time;
    device.queue.writeBuffer(frameUBO, 0, f);
    opticsData[0]=P.turbidity;opticsData[1]=qs.get('waterOptics')==='0'?0:1;
    opticsData[2]=waterH;opticsData[3]=1;
    device.queue.writeBuffer(opticsUBO,0,opticsData);
  }

  // --------------------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------------------
  const panel = document.getElementById('panel');
  function setPanelOpen(open) {
    if(open){setPerformanceOpen(false);setCaptainOpen(false);landfallUI.close();setBoatOpen(false);setCameraOpen(false);setShareOpen(false);}
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('sea-settings-open', open);
    seaSettingsButton.setAttribute('aria-expanded', String(open));
    if(open)hideSea.focus({preventScroll:true});
  }
  function togglePanel() { setPanelOpen(panel.classList.contains('hidden')); }
  const boatPanel = document.createElement('section');
  boatPanel.id = 'boat-panel';
  boatPanel.hidden=true;
  boatPanel.setAttribute('aria-labelledby','boat-title');
  boatPanel.innerHTML = `<div class="panel-header"><strong id="boat-title">Ship settings</strong></div>
    <div class="panel-body" id="boat-controls"></div>`;
  const boatBody=boatPanel.querySelector('.panel-body');
  panel.before(boatPanel);
  const collapseBoat = document.createElement('button');
  controlIcon(collapseBoat,'close','Hide ship settings');
  collapseBoat.onclick = () => {setBoatOpen(false);shipSettingsButton.focus();};
  boatPanel.querySelector('.panel-header').append(collapseBoat);
  function setBoatOpen(open){
    if(open){setPerformanceOpen(false);setPanelOpen(false);setCaptainOpen(false);landfallUI.close();setCameraOpen(false);setShareOpen(false);}
    boatPanel.hidden=!open;shipSettingsButton.setAttribute('aria-expanded',String(open));document.body.classList.toggle('ship-settings-open',open);
    if(open)collapseBoat.focus({preventScroll:true});
  }
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
  const fleetDraft=fleetConfig.map(entry=>({...entry}));
  const applyFleet=()=>{
    const hasActiveFollower=fleetDraft.some(entry=>entry.enabled);
    const url=new URL(location.href);
    url.searchParams.set('fleet',fleetToSearch(fleetDraft));
    url.searchParams.set('follower',hasActiveFollower?'1':'0');
    if(!hasActiveFollower&&url.searchParams.has('state')){
      const st=decodeGameStateParam(url.searchParams.get('state'));
      if(st&&st.encounter){
        delete st.encounter;
        const enc=encodeGameStateParam(st);
        if(enc)url.searchParams.set('state',enc);
        else url.searchParams.delete('state');
      }
    }
    location.assign(url.href);
  };
  const followerLabel=document.createElement('label');followerLabel.textContent='Following ships';
  const followerToggle=document.createElement('input');followerToggle.id='follower-toggle';followerToggle.type='checkbox';followerToggle.checked=followerEnabled;
  followerToggle.addEventListener('change',()=>{
    if(!fleetDraft.length&&followerToggle.checked)fleetDraft.push({modelId:SHIP_ID,enabled:true});
    for(const entry of fleetDraft)entry.enabled=followerToggle.checked;applyFleet();
  });
  followerLabel.append(followerToggle);boatBody.append(followerLabel);
  const fleetBox=document.createElement('fieldset');fleetBox.id='fleet-controls';
  const fleetLegend=document.createElement('legend');fleetLegend.textContent='Fleet';fleetBox.append(fleetLegend);
  const fleetRows=document.createElement('div');fleetBox.append(fleetRows);
  const addFollower=document.createElement('button');addFollower.id='fleet-add';addFollower.textContent='Add following ship';
  const applyFollower=document.createElement('button');applyFollower.id='fleet-apply';applyFollower.textContent='Apply fleet';applyFollower.addEventListener('click',applyFleet);
  function refreshFleetRows(){
    fleetRows.replaceChildren();addFollower.disabled=fleetDraft.length>=MAX_FOLLOWERS;
    for(const [index,entry]of fleetDraft.entries()){
      const row=document.createElement('div');row.style.cssText='display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap';
      const label=document.createElement('label');label.textContent='Ship '+(index+1);label.style.cssText='display:flex;gap:6px;align-items:center;flex:1';
      const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=entry.enabled;enabled.setAttribute('aria-label','Enable following ship '+(index+1));
      enabled.onchange=()=>entry.enabled=enabled.checked;
      const select=document.createElement('select');select.id='fleet-model-'+index;select.setAttribute('aria-label','Following ship '+(index+1)+' model');select.style.cssText='min-width:100px;max-width:100%;flex:1';
      for(const model of READY_SHIPS){const option=document.createElement('option');option.value=model.id;option.textContent=model.name;select.append(option);}
      select.value=entry.modelId;select.onchange=()=>entry.modelId=select.value;
      const factionSelect=document.createElement('select');factionSelect.id='fleet-faction-'+index;factionSelect.setAttribute('aria-label','Following ship '+(index+1)+' allegiance');
      for(const [val,text] of [['friendly','Friendly'],['enemy','Enemy']]){const option=document.createElement('option');option.value=val;option.textContent=text;factionSelect.append(option);}
      factionSelect.value=normalizeVesselFaction(entry,{broadside:BROADSIDE_SCENARIO,index});
      factionSelect.onchange=()=>{entry.faction=factionSelect.value;};
      const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove following ship '+(index+1));
      remove.onclick=()=>{fleetDraft.splice(index,1);refreshFleetRows();};
      label.append(enabled,select,factionSelect);row.append(label,remove);fleetRows.append(row);
    }
  }
  addFollower.onclick=()=>{if(fleetDraft.length<MAX_FOLLOWERS){fleetDraft.push({modelId:SHIP_ID,enabled:true,faction:'friendly'});refreshFleetRows();}};
  fleetBox.append(addFollower,applyFollower);refreshFleetRows();boatBody.append(fleetBox);
  const followerStatus=document.createElement('p');followerStatus.id='follower-status';boatBody.append(followerStatus);
  const instruments=createSailingInstruments(boat,qs,boatBody);
  const cameraDock=document.createElement('div'); cameraDock.id='camera-dock';
  cameraDock.setAttribute('role','group'); cameraDock.setAttribute('aria-label','Scene controls');
  const cameraButton=controlIcon(document.createElement('button'),'camera','Camera views');
  cameraButton.setAttribute('aria-controls','camera-panel');cameraButton.setAttribute('aria-expanded','false');
  const cameraPanel=document.createElement('section');cameraPanel.id='camera-panel';cameraPanel.hidden=true;cameraPanel.setAttribute('aria-labelledby','camera-title');
  cameraPanel.innerHTML='<div class="panel-header"><strong id="camera-title">View</strong></div><div class="panel-body camera-choices"></div>';
  const cameraBody=cameraPanel.querySelector('.panel-body');
  const cameraClose=controlIcon(document.createElement('button'),'close','Hide camera views');
  cameraClose.onclick=()=>{setCameraOpen(false);cameraButton.focus();};cameraPanel.querySelector('.panel-header').append(cameraClose);
  panel.before(cameraPanel);
  function setCameraOpen(open){
    if(open){setPerformanceOpen(false);setPanelOpen(false);setCaptainOpen(false);landfallUI.close();setBoatOpen(false);setShareOpen(false);}
    cameraPanel.hidden=!open;cameraButton.setAttribute('aria-expanded',String(open));document.body.classList.toggle('camera-open',open);
    if(open)cameraClose.focus({preventScroll:true});
  }
  cameraButton.onclick=()=>setCameraOpen(cameraPanel.hidden);cameraDock.append(cameraButton);
  const cameraButtons=new Map();
  for(const [mode,label] of [['boat','Boat camera'],['crows-nest',"Crow's nest"],['free','Free camera'],['ship','View ship']]) {
    const button=document.createElement('button'); button.textContent=label;
    button.addEventListener('click',()=>{
      shipOrbit.fleet=false;shipOrbit.wildlife=false;
      if(mode==='crows-nest'){
        setBoatViewStation(boat,'crows-nest');
        setCameraMode('boat');
      }else{
        if(mode==='boat')setBoatViewStation(boat,'deck');
        setCameraMode(mode);
      }
      setCameraOpen(false);cameraButton.focus();helm?.update?.(performance.now(),true);
    });
    cameraBody.append(button); cameraButtons.set(mode,button);
  }
  const fleetViewButton=document.createElement('button');fleetViewButton.textContent='View fleet';fleetViewButton.id='view-fleet';fleetViewButton.disabled=!followerEnabled;
  fleetViewButton.onclick=()=>{setCameraMode('ship');shipOrbit.fleet=true;shipOrbit.wildlife=false;shipOrbit.fleetZoom=1;shipOrbit.elevation=.31;setCameraOpen(false);};cameraBody.append(fleetViewButton);
  const recenterView=document.createElement('button');recenterView.textContent='Centre inspection view';
  recenterView.onclick=()=>{shipOrbit.panX=shipOrbit.panY=shipOrbit.panZ=0;setCameraOpen(false);};cameraBody.append(recenterView);
  const cameraHint=document.createElement('p');cameraHint.className='help';
  cameraHint.textContent='View ship: drag to orbit; right-drag or Shift-drag to pan; wheel to zoom. Touch: two fingers pan and pinch to zoom. Orbit below the surface to inspect underwater.';
  cameraBody.append(cameraHint);
  const seaSettingsButton = controlIcon(document.createElement('button'),'weather','Sea settings');
  seaSettingsButton.setAttribute('aria-controls', 'panel');
  seaSettingsButton.setAttribute('aria-expanded', 'false');
  seaSettingsButton.onclick = togglePanel;
  const captainButton=controlIcon(document.createElement('button'),'captain','Captain');
  const shipSettingsButton=controlIcon(document.createElement('button'),'ship','Ship settings');
  shipSettingsButton.setAttribute('aria-controls','boat-panel');shipSettingsButton.setAttribute('aria-expanded','false');
  shipSettingsButton.onclick=()=>setBoatOpen(boatPanel.hidden);
  captainButton.setAttribute('aria-controls','captain-panel');captainButton.setAttribute('aria-expanded','false');
  const captainPanel=document.createElement('section');captainPanel.id='captain-panel';captainPanel.hidden=true;
  captainPanel.setAttribute('aria-labelledby','captain-title');
  captainPanel.innerHTML='<div class="panel-header"><strong id="captain-title">Captain’s orders</strong></div><div class="panel-body"><p>Command the ship. The crew attends to its stations.</p></div>';
  panel.before(captainPanel);
  const captainBody=captainPanel.querySelector('.panel-body'),captainHide=document.createElement('button');
  const captainSound=document.createElement('button');captainSound.textContent='Enable sound';captainSound.setAttribute('aria-pressed','false');
  captainSound.onclick=()=>soundButton.click();captainBody.append(captainSound);
  controlIcon(captainHide,'close','Hide captain orders');
  captainHide.onclick=()=>{setCaptainOpen(false);captainButton.focus();};captainPanel.querySelector('.panel-header').append(captainHide);
  function setCaptainOpen(open){
    captainPanel.hidden=!open;document.body.classList.toggle('captain-open',open);captainButton.setAttribute('aria-expanded',String(open));
    if(open){setPerformanceOpen(false);setPanelOpen(false);landfallUI.close();setBoatOpen(false);setCameraOpen(false);setShareOpen(false);if(document.pointerLockElement)document.exitPointerLock();captainHide.focus({preventScroll:true});}
  }
  captainButton.onclick=()=>setCaptainOpen(captainPanel.hidden);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!captainPanel.hidden)captainHide.click();});
  const crewStatus=document.createElement('p');crewStatus.id='crew-status';crewStatus.setAttribute('role','status');crewStatus.textContent=crewError||'Sea watch · 12 aboard';captainBody.append(crewStatus);
  const orderButtons=new Map(),orders=document.createElement('div');orders.className='captain-orders';
  for(const order of CAPTAIN_ORDERS){
    const button=document.createElement('button');button.type='button';button.disabled=!crew;button.dataset.order=order.id;
    button.setAttribute('aria-label',order.label);button.setAttribute('aria-pressed',String(order.id==='watch'));
    const name=document.createElement('strong'),detail=document.createElement('span');name.textContent=order.label;detail.textContent=order.detail;button.append(name,detail);
    button.onclick=()=>{
      if(crew?.order(boat,order.id)){
        shipGuns.standDown();
        commandFriendlyFleet(vessels,{type:'crew',id:order.id},{anchorEnv:anchorEnvironment});
        sceneAudio.order(order.id,{boat});propulsionInput.value=boat.propulsion;showPropulsionControls();for(const [i,key] of SAIL_KEYS.entries())sailInputs[i].input.value=boat[key]*100;updateCrewUI();
      }
    };
    orders.append(button);orderButtons.set(order.id,button);
  }
  captainBody.append(orders);
  const anchorDrop=document.createElement('button'),anchorWeigh=document.createElement('button');
  anchorDrop.id='drop-anchor';anchorDrop.setAttribute('aria-label','Drop anchor');anchorDrop.innerHTML='<strong>Drop anchor</strong><span>Let go the port anchor near visible land.</span>';
  anchorWeigh.id='weigh-anchor';anchorWeigh.setAttribute('aria-label','Weigh anchor');anchorWeigh.innerHTML='<strong>Weigh anchor</strong><span>Haul in the rode and raise the anchor.</span>';
  anchorDrop.onclick=()=>{if(anchor.drop(boat,anchorEnvironment)){commandFriendlyFleet(vessels,{type:'crew',id:'drop-anchor'},{anchorEnv:anchorEnvironment});sceneAudio.order('drop-anchor',{boat});updateAnchorUI();}};
  anchorWeigh.onclick=()=>{if(anchor.weigh()){commandFriendlyFleet(vessels,{type:'crew',id:'weigh-anchor'},{anchorEnv:anchorEnvironment});sceneAudio.order('weigh-anchor',{boat});updateAnchorUI();}};
  orders.append(anchorDrop,anchorWeigh);
  const anchorStatus=document.createElement('p');anchorStatus.id='anchor-status';anchorStatus.setAttribute('role','status');captainBody.append(anchorStatus);
  if(followerEnabled){
    const squadronRow=document.createElement('label');squadronRow.id='squadron-orders-row';
    squadronRow.style.cssText='display:flex;gap:8px;align-items:center;margin:6px 0;font-size:.92em';
    const squadronCheck=document.createElement('input');squadronCheck.type='checkbox';squadronCheck.id='squadron-gunnery-orders';
    squadronCheck.checked=shouldSquadronObeyGunnery();
    squadronCheck.onchange=()=>{squadronGunneryOrders=squadronCheck.checked;};
    const squadronText=document.createElement('span');
    squadronText.textContent='Friendly ships obey gunnery orders (sailing & anchor orders always followed)';
    squadronRow.append(squadronCheck,squadronText);captainBody.append(squadronRow);
  }
  const gunControls=createGunneryControls(captainBody,shipGuns);
  gunControls.element.hidden=shipGuns.state.guns.length===0;
  gunControls.update();
  const colorsSection=document.createElement('section');colorsSection.className='captain-colors-section';
  colorsSection.style.cssText='margin:8px 0;padding:8px 0;border-top:1px solid rgba(255,255,255,.12);display:grid;gap:6px';
  const colorsRow=document.createElement('div');colorsRow.style.cssText='display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const colorsLabel=document.createElement('label');colorsLabel.textContent='Ship’s colors';colorsLabel.htmlFor='ship-colors-select';
  const colorsSelect=document.createElement('select');colorsSelect.id='ship-colors-select';
  for(const info of Object.values(SHIP_COLORS)){
    const opt=document.createElement('option');opt.value=info.id;opt.textContent=info.name;
    colorsSelect.append(opt);
  }
  colorsSelect.value=boat.colors??DEFAULT_SHIP_COLORS;
  const strikeBtn=document.createElement('button');strikeBtn.type='button';strikeBtn.id='strike-colors-btn';
  strikeBtn.textContent='Strike colors (Surrender 🏳️)';
  const moraleStatus=document.createElement('p');moraleStatus.id='crew-morale-status';moraleStatus.setAttribute('role','status');
  moraleStatus.style.cssText='margin:0;font-size:.9em;opacity:.92';
  colorsSelect.onchange=()=>{
    setVesselColors(boat,colorsSelect.value);
    updateCrewUI();helm?.update?.(performance.now(),true);
  };
  strikeBtn.onclick=()=>{
    if(boat.damage?.surrendered){
      setVesselColors(boat,boat.previousColors||DEFAULT_SHIP_COLORS);
      colorsSelect.value=boat.colors;
    }else{
      strikeVesselColors(boat,'Struck colors by Captain’s order');
      shipGuns.standDown();
      for(const key of SAIL_KEYS)boat[key]=0;
      colorsSelect.value='surrender';
      voyageCtl?.logExternal?.('🏳️ Struck our colors and hoisted the white flag of truce.','combat');
    }
    updateCrewUI();helm?.update?.(performance.now(),true);
  };
  colorsRow.append(colorsLabel,colorsSelect,strikeBtn);
  colorsSection.append(colorsRow,moraleStatus);
  captainBody.append(colorsSection);

  const boardingSection=document.createElement('section');boardingSection.className='captain-boarding-section';
  boardingSection.style.cssText='margin:8px 0;padding:8px 0;border-top:1px solid rgba(255,255,255,.12);display:grid;gap:6px';
  const boardingActionsRow=document.createElement('div');boardingActionsRow.style.cssText='display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const dockPierBtn=document.createElement('button');dockPierBtn.type='button';dockPierBtn.id='dock-pier-btn';
  dockPierBtn.textContent='🪢 Throw mooring lines (Dock)';
  const castOffBtn=document.createElement('button');castOffBtn.type='button';castOffBtn.id='cast-off-btn';
  castOffBtn.textContent='🪢 Cast off lines';
  const boardShipBtn=document.createElement('button');boardShipBtn.type='button';boardShipBtn.id='board-ship-btn';
  boardShipBtn.textContent='⚔️ Grapple & board vessel';
  const boardingStatus=document.createElement('p');boardingStatus.id='boarding-docking-status';boardingStatus.setAttribute('role','status');
  boardingStatus.style.cssText='margin:0;font-size:.9em;opacity:.92';
  dockPierBtn.onclick=()=>{
    const activeShip=followerEnabled&&vessels[1]?.boat?.showProw&&!vessels[1].boat.damage?.sunk?vessels[1]:null;
    if(activeShip&&Math.hypot((activeShip.boat.x??0)-boat.x,(activeShip.boat.z??0)-boat.z)<140){
      dockingBoarding.grappleShip(activeShip,{mode:'moor'});
    }else{
      dockingBoarding.dockAtPier({terrain,portLabel:terrain?.region?.name||'Harbor Pier'});
    }
    updateCrewUI();helm?.update?.(performance.now(),true);
  };
  castOffBtn.onclick=()=>{
    dockingBoarding.castOff();
    updateCrewUI();helm?.update?.(performance.now(),true);
  };
  boardShipBtn.onclick=()=>{
    if(vessels.length>1&&(!followerEnabled||!vessels[1].boat?.showProw)){
      vessels[1].dormantEncounter=false;
      followerEnabled=true;
      boat.followingShip=true;
      vessels[1].boat.showProw=true;
      vessels[1].faction=vessels[1].faction||'enemy';
      vessels[1].boat.faction=vessels[1].faction;
      vessels[1].boat.colors=vessels[1].faction==='enemy'?'jolly-roger':'castile';
    }
    dockingBoarding.boardVessel(vessels[1]);
    updateCrewUI();helm?.update?.(performance.now(),true);
  };
  boardingActionsRow.append(dockPierBtn,castOffBtn,boardShipBtn);
  boardingSection.append(boardingActionsRow,boardingStatus);
  captainBody.append(boardingSection);
  function updateAnchorUI(){
    anchorDrop.hidden=anchorWeigh.hidden=anchor.installed===false;
    anchorDrop.disabled=anchor.active||!anchor.eligibility.allowed;anchorDrop.title=anchor.active?'Anchor already deployed':anchor.eligibility.reason;
    anchorWeigh.disabled=!anchor.active||anchor.phase==='weighing';
    const text=anchor.status+(anchor.installed===false?'':anchor.active?` · ${anchor.rode.toFixed(0)} m rode`:' · Requires visible land, safe depth and less than 1.5 knots');
    if(anchorStatus.textContent!==text)anchorStatus.textContent=text;
  }
  updateAnchorUI();
  const crewDetails=document.createElement('details'),crewSummary=document.createElement('summary');
  const companyRoster=crew?.state.crew??[],women=companyRoster.filter(person=>person.sex==='female').length,men=companyRoster.filter(person=>person.sex==='male').length;
  crewSummary.textContent='Ship’s company'+(companyRoster.length?' · '+women+' women · '+men+' men':' · unavailable');crewDetails.append(crewSummary);
  const crewList=document.createElement('ul');crewList.id='crew-roster';
  const crewRows=crew?crew.state.crew.map(s=>{const row=document.createElement('li');row.textContent=`${s.name} · ${s.role}`;crewList.append(row);return row;}):[];
  crewDetails.append(crewList);captainBody.append(crewDetails);
  function updateCrewUI(){
    if(colorsSelect&&document.activeElement!==colorsSelect)colorsSelect.value=boat.colors??DEFAULT_SHIP_COLORS;
    if(strikeBtn){
      const isSurr=Boolean(boat.damage?.surrendered||boat.colors==='surrender');
      strikeBtn.textContent=isSurr?'Re-hoist national colors':'Strike colors (Surrender 🏳️)';
      strikeBtn.setAttribute('aria-pressed',String(isSurr));
    }
    if(moraleStatus){
      const dmg=boat.damage;
      const cas=dmg?.crewCasualties;
      const moralePct=Math.round((dmg?.battleMorale??1)*100);
      const colorsInfo=getShipColorsInfo(boat.colors);
      const enemyShip=followerEnabled&&vessels[1]?.boat?.showProw?vessels[1].boat:null;
      const enemyColors=enemyShip?getShipColorsInfo(enemyShip.colors):null;
      const enemyMorale=enemyShip?.damage?` · Sighted ship: ${enemyShip.shipName||vessels[1].asset?.model?.name||'Vessel'} (${enemyColors.shortLabel}, Morale ${Math.round((enemyShip.damage.battleMorale??1)*100)}%${enemyShip.damage.surrendered?' · 🏳️ SURRENDERED':''})`:'';
      const mTxt=`Colors: ${colorsInfo.shortLabel} · Crew: ${cas?`${cas.able}/${cas.total} able (${cas.wounded} wounded, ${cas.killed} fallen)`:'full complement'} · Battle morale: ${moralePct}% (${dmg?.moraleState??'steady'})${enemyMorale}`;
      if(moraleStatus.textContent!==mTxt)moraleStatus.textContent=mTxt;
    }
    if(boardingStatus){
      const dbState=dockingBoarding.state;
      const pStr=dockingBoarding.computePlayerStrength();
      const targetV=followerEnabled&&vessels[1]?.boat?.showProw?vessels[1]:null;
      const tBoat=targetV?.boat;
      const isSurr=Boolean(tBoat?.damage?.surrendered||tBoat?.colors==='surrender');
      const isCap=Boolean(tBoat?.captured);
      if(boardShipBtn){
        boardShipBtn.textContent=isCap?'🏴 Prize Captured':isSurr?'⚔️ Board & take surrendered prize':'⚔️ Grapple, board & fight';
        boardShipBtn.disabled=isCap||dbState.boardingPhase==='boarding-melee';
      }
      if(castOffBtn){
        castOffBtn.disabled=dbState.mooringPhase==='clear'||dbState.mooringPhase==='casting-off';
      }
      if(dockPierBtn){
        dockPierBtn.disabled=dbState.mooringPhase==='moored'||dbState.mooringPhase==='grappled'||dbState.mooringPhase==='making-fast'||dbState.mooringPhase==='throwing-lines';
      }
      const bTxt=`${dbState.statusText} · Boarding power: ${pStr.effectiveStrength.toFixed(1)} (${pStr.femaleHands}♀=${pStr.meanFemaleStrength.toFixed(1)}, ${pStr.maleHands}♂=${pStr.meanMaleStrength.toFixed(1)})`;
      if(boardingStatus.textContent!==bTxt)boardingStatus.textContent=bTxt;
    }
    if(!crew)return;
    const status=crew.status();if(crewStatus.textContent!==status)crewStatus.textContent=status;
    const sails=boat.sailState??sailingState(boat);
    for(const [id,button] of orderButtons){
      if(['full','reduced','furl'].includes(id))button.hidden=shipAsset.model.rig.sails.length===0;
      button.setAttribute('aria-pressed',String(id==='transfer'?!!sails.maneuver:crew.state.order===id));
      if(id==='transfer'){const possible=getShipParts(SHIP_ID).rig.transferYards;button.hidden=!possible;button.disabled=!possible||!yardTransferAvailable(sails);button.title=sails.maneuver?'Transfer underway':yardTransferAvailable(sails)?'Move yards to leeward':'Available on the bad tack, once clear of the wind';}
    }
    if(crewDetails.open)for(const [i,s] of crew.state.crew.entries())crewRows[i].textContent=`${s.name} · ${s.role} · ${crewWorkLabel(s)}`;
  }
  updateCrewUI();
  const shareButton = controlIcon(document.createElement('button'),'share','Copy share link');
  shareButton.setAttribute('aria-controls','share-panel');shareButton.setAttribute('aria-expanded','false');
  const sharePanel = document.createElement('div'); sharePanel.id = 'share-panel'; sharePanel.hidden = true;
  const shareInput = document.createElement('input');
  shareInput.type = 'url'; shareInput.readOnly = true; shareInput.setAttribute('aria-label', 'Share link');
  shareInput.addEventListener('click', () => shareInput.select());
  const closeShare = controlIcon(document.createElement('button'),'close','Close share link');
  function setShareOpen(open){if(open)setPerformanceOpen(false);sharePanel.hidden=!open;shareButton.setAttribute('aria-expanded',String(open));document.body.classList.toggle('share-open',open);}
  closeShare.onclick = () => { setShareOpen(false); shareButton.focus(); };
  const shareStatus = document.createElement('span'); shareStatus.setAttribute('role', 'status');
  sharePanel.append(shareInput, closeShare, shareStatus);
  const buildShareCameraPayload = () => {
    const v = voyageCtl?.voyage;
    const tRegion = terrain?.region;
    const geo = tRegion ? islandCoordinates(boat.x, boat.z, tRegion) : null;
    const lat = Number.isFinite(v?.true?.lat) ? v.true.lat : Number.isFinite(v?.truePos?.lat) ? v.truePos.lat : Number.isFinite(geo?.latitude) ? geo.latitude : astronomy.state?.observer?.latitude;
    const lon = Number.isFinite(v?.true?.lon) ? v.true.lon : Number.isFinite(v?.truePos?.lon) ? v.truePos.lon : Number.isFinite(geo?.longitude) ? geo.longitude : astronomy.state?.observer?.longitude;
    const drLat = Number.isFinite(v?.dr?.lat) ? v.dr.lat : lat;
    const drLon = Number.isFinite(v?.dr?.lon) ? v.dr.lon : lon;
    const num = (n, d = 4) => Number.isFinite(n) ? Number(n.toFixed(d)) : undefined;
    const vInfo = {
      lat: num(lat, 5),
      lon: num(lon, 5),
      drLat: num(drLat, 5),
      drLon: num(drLon, 5),
      region: tRegion?.id ?? (qs.get('region') || undefined),
      canvas: v?.canvas,
      course: num(v?.compassCourse, 1),
      warp: v?.tier,
      autopilot: Boolean(voyageCtl?.helmsman?.engaged),
      day: v?.dayAtSea,
    };
    const dmg = boat.damage;
    const encVessel = vessels[1];
    const encActive = Boolean(followerEnabled && encVessel && !encVessel.dormantEncounter && encVessel.boat?.showProw);
    const gameState = {
      v: 1,
      pos: {
        lat: num(lat, 5),
        lon: num(lon, 5),
        drLat: num(drLat, 5),
        drLon: num(drLon, 5),
        x: num(boat.x, 2),
        z: num(boat.z, 2),
        heading: num(boat.heading, 2),
        speed: num(boatForwardSpeed(boat) / KNOT_TO_MPS, 2),
        rudder: num(boat.rudderTarget, 1),
        region: vInfo.region,
      },
      ship: {
        id: boat.modelId ?? 'nina',
        colors: boat.colors ?? DEFAULT_SHIP_COLORS,
        station: boat.viewStation ?? 'deck',
        propulsion: boat.propulsion ?? 'sail',
        sails: SAIL_KEYS.map(k => num(boat[k], 2)),
        set: (boat.sailState?.set ? Array.from(boat.sailState.set) : SAIL_KEYS.map(k => boat[k])).map(val => num(val, 2)),
        provisionDays: num(boat.provisionDays, 1),
        cargoTonnes: num(boat.cargoTonnes, 1),
      },
      voyage: v ? {
        active: !v.passive,
        day: v.dayAtSea,
        dateMs: Math.round(v.dateMs),
        canvas: v.canvas,
        course: num(v.compassCourse, 1),
        warp: v.tier,
        autopilot: Boolean(voyageCtl?.helmsman?.engaged),
        beat: Boolean(voyageCtl?.helmsman?.beatToWind),
        waterDays: num(v.provisions?.water ?? v.stores?.waterDays, 1),
        foodDays: num(v.provisions?.food ?? v.stores?.foodDays, 1),
        hull: num(boat.damage?.hullIntegrity ?? v.ship?.hull, 3),
        morale: num(v.morale ?? v.crew?.morale, 3),
      } : undefined,
      damage: dmg ? {
        hullIntegrity: num(dmg.hullIntegrity, 3),
        battleMorale: num(dmg.battleMorale, 3),
        surrendered: Boolean(dmg.surrendered),
        sunk: Boolean(dmg.sunk),
        casualties: dmg.crewCasualties ? {
          total: dmg.crewCasualties.total,
          able: dmg.crewCasualties.able,
          wounded: dmg.crewCasualties.wounded,
          killed: dmg.crewCasualties.killed,
        } : undefined,
      } : undefined,
      encounter: encActive ? {
        name: encVessel.boat.shipName,
        faction: encVessel.faction,
        colors: encVessel.boat.colors,
        x: num(encVessel.boat.x, 1),
        z: num(encVessel.boat.z, 1),
        heading: num(encVessel.boat.heading, 1),
        surrendered: Boolean(encVessel.boat.damage?.surrendered),
      } : undefined,
    };
    return { cam, orbit: shipOrbit, astronomy: astronomy.share(), voyage: vInfo, gameState };
  };
  let lastUrlSyncMs = 0;
  const syncBrowserUrlState = (now = performance.now(), force = false) => {
    if (IS_HEADLESS_TEST && !force) return;
    if (!force && now - lastUrlSyncMs < 4000) return;
    lastUrlSyncMs = now;
    try {
      const url = createShareLink(location.href, P, boat, cameraMode, buildShareCameraPayload());
      history.replaceState(null, '', url);
      if (!sharePanel.hidden) shareInput.value = url;
    } catch { /* standalone file */ }
  };
  shareButton.onclick = async () => {
    const url = createShareLink(location.href, P, boat, cameraMode, buildShareCameraPayload());
    setPanelOpen(false);setBoatOpen(false);setCaptainOpen(false);setCameraOpen(false);landfallUI.close();
    setShareOpen(true); shareInput.value = url;
    // Also leave a shareable address in the browser if clipboard access is unavailable.
    try { history.replaceState(null, '', url); lastUrlSyncMs = performance.now(); } catch { /* standalone file */ }
    try {
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = 'Link copied. It includes position, ship, voyage state, sea, lighting, and camera settings.';
    } catch {
      shareInput.focus(); shareInput.select();
      shareStatus.textContent = 'Select and copy this link to share your settings.';
    }
  };
  cameraDock.append(captainButton);
  panel.before(sharePanel);
  const seaSliders = new Map();
  let initial1550AutoRepositioned=false;
  terrain?.discovery?.subscribe?.(disc=>{
    if(!initial1550AutoRepositioned&&disc.applied&&disc.isCurated1550&&LAND_STAGE&&!qs.has('boatX')&&!qs.has('boatZ')&&!qs.has('cam')){
      initial1550AutoRepositioned=true;
      const v=terrain.views?.[LAND_STAGE];
      if(v){
        const safe=terrain.safeStart({x:v.x,z:v.z},boat);
        boat.x=safe.x;boat.z=safe.z;if(Number.isFinite(v.heading))boat.heading=v.heading;
        if(boat.enabled){cam.x=boat.x;cam.z=boat.z;}
        else{cam.x=v.x;cam.y=v.y;cam.z=v.z;cam.yaw=v.yaw*D2R;cam.pitch=v.pitch*D2R;}
        for(const esc of vessels.slice(1)){
          if(esc.dormantEncounter)continue;
          const L=Math.max(boat.length,esc.asset.model.runtime.length),formation=esc.formation;
          const hRad=(boat.heading||0)*D2R;
          const fwdX=Math.sin(hRad),fwdZ=-Math.cos(hRad);
          const rightX=Math.cos(hRad),rightZ=Math.sin(hRad);
          const targetPos={
            x:boat.x-fwdX*(L*formation.trail)+rightX*(L*formation.side),
            z:boat.z-fwdZ*(L*formation.trail)+rightZ*(L*formation.side),
          };
          const start=terrain.safeStart(targetPos,esc.boat);
          esc.boat.x=start.x;esc.boat.z=start.z;esc.boat.heading=boat.heading;
          esc.boat.showProw=true;
        }
      }
      if(terrain.region&&terrain.region.id!=='saba'&&(!qs.has('swellDir')||Number(qs.get('swellDir'))===22)&&(!qs.has('windDir')||Number(qs.get('windDir'))===118)){
        const naturalSea=coastalSeaForRegion(terrain.region,LAND_STAGE);
        P.swellDir=naturalSea.swellDir;P.windDir=naturalSea.windDir;
        for(const k of ['swellDir','windDir']){const s=seaSliders.get(k);if(s){s.input.value=String(P[k]);s.output.textContent=String(P[k]);}}
        needSpectrum=true;
      }
      voyageCtl?.syncToTerrainBoat?.();
      envFull=true;
    }
  });
  const landfallUI=createLandfallUI({dock:cameraDock,active:!!terrain,stage:LAND_STAGE,weather:LAND_WEATHER,region:terrain?.region??undefined,
    discovery:terrain?.discovery??null,onUpgradeApplied:()=>{envFull=true;},
    onOpen:()=>{setPerformanceOpen(false);setPanelOpen(false);setCaptainOpen(false);setBoatOpen(false);setCameraOpen(false);setShareOpen(false);},
    getPosition:()=>boat,onWeather:settings=>{Object.assign(P,settings);if(astronomy.mode!=='manual')applyAstronomy({mode:'manual'});for(const [key,{input,output}] of seaSliders){input.value=P[key];output.textContent=String(P[key]);}for(const k of ['sunElev','sunAzim']){const m=landfallMirrorSliders[k];if(m&&P[k]!==undefined){m.input.value=String(P[k]);m.output.textContent=String(P[k]);}}needSpectrum=true;envFull=true;}});
  controlIcon(cameraDock.querySelector('#landfall-button'),'map','Landfall');
  cameraDock.append(seaSettingsButton,shipSettingsButton,shareButton);
  // ---------------------------------------------------------------- Chart Course voyage
  {
    const curatedNear=(lat,lon,maxKm=30)=>{
      let best=null,bestKm=maxKm;
      for(const r of Object.values(SPANISH_MAIN_1550_REGIONS)){
        const km=greatCircleKm(lat,lon,r.latitude,r.longitude);
        if(km<bestKm){bestKm=km;best=r;}
      }
      return best;
    };
    const geoOfBoat=()=>{
      if(terrain?.region)return islandCoordinates(boat.x,boat.z,terrain.region);
      const o=astronomy.state?.observer;
      return o?{latitude:o.latitude,longitude:o.longitude}:{latitude:astronomy.anchor.latitude,longitude:astronomy.anchor.longitude};
    };
    const activateEncounterVessel=(enc,{mode='sight'}={})=>{
      if(vessels.length<=1)return;
      const target=vessels[1];
      target.dormantEncounter=false;
      followerEnabled=true;
      boat.followingShip=true;
      if(fleetViewButton)fleetViewButton.disabled=false;
      const isHostile=mode==='engage'?(enc?.actuallyHostile??true):mode==='sight'?Boolean(enc?.apparentHostile):false;
      target.faction=isHostile?'enemy':'friendly';
      if(target.follower){
        target.follower.faction=target.faction;
        target.follower.combatInitialized=false;
        if(mode==='hail'){
          const sideSign=(enc?.relBearingDeg??25)<0?-1:1;
          target.follower.formation={trail:0.12,side:sideSign*2.2};
          target.follower.status=`Hailed (${enc?.shipName||'Consort'})`;
        }else if(mode==='engage'){
          target.follower.salvoDelay=1.2;
          target.follower.status=`Engaging (${enc?.shipName||'Corsair'})`;
        }
      }
      if(target.boat){
        target.boat.showProw=true;
        target.boat.faction=target.faction;
        target.boat.aiGunneryAttended=true;
        target.boat.shipName=enc?.shipName??enc?.archetype?.title??'Strange Sail';
        target.boat.battleColors=enc?.battleColors??(enc?.actuallyHostile?'jolly-roger':(enc?.colors??'castile'));
        const chosenColors=mode==='engage'&&enc?.actuallyHostile
          ?(enc?.battleColors??'jolly-roger')
          :(enc?.colors??'castile');
        setVesselColors(target.boat,chosenColors);
        if(target.boat.damage){
          target.boat.damage.surrendered=false;
          target.boat.damage.surrenderReason=null;
          target.boat.damage.battleMorale=1.0;
          target.boat.damage.moraleShock=0;
          target.boat.damage.moraleState='steady';
        }
        const sideSign=(enc?.relBearingDeg??25)<0?-1:1;
        const brgRad=mode==='hail'
          ?((boat.heading+sideSign*78)*Math.PI)/180
          :mode==='engage'
          ?((boat.heading+sideSign*68)*Math.PI)/180
          :((enc?.bearingDeg??(boat.heading+sideSign*30))*Math.PI)/180;
        const distM=mode==='hail'?52:mode==='engage'?165:420;
        target.boat.x=boat.x+Math.sin(brgRad)*distM;
        target.boat.z=boat.z-Math.cos(brgRad)*distM;
        target.boat.heading=mode==='hail'
          ?boat.heading
          :mode==='engage'
          ?((boat.heading-sideSign*22)%360+360)%360
          :((boat.heading+160)%360+360)%360;
        target.boat.surgeVelocity=mode==='hail'?(boat.surgeVelocity??2.5):2.8;
        target.boat.revision=(target.boat.revision??0)+1;
        if(mode==='engage'&&isHostile&&target.gunnery){
          const initialSide=sideSign<0?'starboard':'port';
          target.gunnery.readyAtQuarters?.(initialSide);
          if(target.follower)target.follower.combatInitialized=true;
        }
        if(mode==='hail'||mode==='engage'){
          const dx=target.boat.x-boat.x,dz=target.boat.z-boat.z;
          const worldAngle=Math.atan2(dx,-dz);
          cam.yaw=worldAngle-(boat.heading||0)*D2R;
        }
      }
      updateCrewUI();
      helm?.update?.(performance.now(),true);
    };
    voyageCtl=createVoyageController({
      boat,P,astronomy,hudParent:document.body,
      getTerrain:()=>terrain,
      getCamera:()=>cam,
      getVessels:()=>vessels.map(v=>v.boat),
      getMarineLife:()=>{marineLife.load?.().catch(()=>{});return marineLife;},
      onSightVessel:enc=>activateEncounterVessel(enc,{mode:'sight'}),
      onHailVessel:enc=>activateEncounterVessel(enc,{mode:'hail'}),
      onEngageVessel:enc=>activateEncounterVessel(enc,{mode:'engage'}),
      onBoardVessel:enc=>{
        activateEncounterVessel(enc,{mode:'engage'});
        if(vessels[1])dockingBoarding.boardVessel(vessels[1]);
        updateCrewUI();
        helm?.update?.(performance.now(),true);
      },
      onCanvasOrder:id=>{
        shipGuns.standDown();
        const crewOrder=id==='full'?'full':id==='reefed'?'reduced':id==='storm'?'weather':id==='heave-to'?'furl':'watch';
        const savedTargets=SAIL_KEYS.map(k=>boat[k]);
        crew?.order(boat,crewOrder);
        if(id==='working'||id==='heave-to'){
          for(let i=0;i<SAIL_KEYS.length;i++)boat[SAIL_KEYS[i]]=savedTargets[i];
        }
        commandFriendlyFleet(vessels,{type:'crew',id:crewOrder},{anchorEnv:anchorEnvironment});
        if(typeof propulsionInput!=='undefined'&&propulsionInput)propulsionInput.value=boat.propulsion;
        if(typeof sailInputs!=='undefined'&&sailInputs.length){
          for(const [i,key] of SAIL_KEYS.entries()){
            if(sailInputs[i]){
              sailInputs[i].input.value=boat[key]*100;
              sailInputs[i].output.textContent=Math.round(boat[key]*100)+'%';
            }
          }
        }
        if(typeof showPropulsionControls==='function')showPropulsionControls();
        updateCrewUI();
        helm?.update?.(performance.now(),true);
      },
      regionLatLon:(t,x,z)=>islandCoordinates(x,z,t.region),
      onSpectrum:()=>{needSpectrum=true;},
      onEnv:()=>{envFull=true;},
      resolveLandfallRegion:(lat,lon)=>{
        const r=curatedNear(lat,lon);
        return r?{id:r.id,name:r.name,latitude:r.latitude,longitude:r.longitude}:{latitude:lat,longitude:lon,name:'Uncharted coast'};
      },
      loadLandRings:()=>fetch('assets/world/land.json').then(r=>r.ok?r.json():null),
      spawnTerrain:typeof spawnTerrainLate==='function'?spawnTerrainLate:null,
      disposeTerrain:typeof disposeTerrainLate==='function'?disposeTerrainLate:null,
    });
    voyageCtl.subscribe(type=>{if(type==='open-chart')chartDrawer?.open();});
    const idleSnapshot=()=>{
      const g=geoOfBoat();
      return {drPos:{lat:g.latitude,lon:g.longitude},drTrack:[],revealTrue:false,courseTrue:boat.heading,warpTiers:[],warp:1,
        ship:{name:shipAsset?.model?.name??'Ship'},
        log:[{date:new Date().toISOString(),text:voyageCtl.hasSavedVoyage()?'A voyage is laid up in the log. Lay a course with the parallel rule to begin anew, or press Resume voyage.':'Lay a course with the parallel rule and press “Lay this course” to put to sea.'}]};
    };
    chartDrawer=createChartDrawer({
      dock:cameraDock,
      onSetCourse:({courseTrue,target,setDestination})=>{
        if(setDestination&&voyageCtl.active){voyageCtl.voyage.destination={lat:target.lat,lon:target.lon,name:'Destination'};return;}
        voyageCtl.layCourse(courseTrue,setDestination?target:null);
      },
      onWarp:id=>{if(!voyageCtl.active)voyageCtl.start();voyageCtl.setWarp(id);},
      getSnapshot:()=>voyageCtl.snapshot()??idleSnapshot(),
    });
    if(qs.get('voyage')==='resume'||(qs.get('voyage')==='1'&&voyageCtl.hasSavedVoyage()&&qs.get('newVoyage')!=='1'))voyageCtl.resume()||voyageCtl.start();
    else if(qs.get('voyage')==='1')voyageCtl.start({difficulty:qs.get('voyageMode')==='easy'?'easy':'pilot'});
    else voyageCtl.start({passive:true,showHud:qs.get('ui')!=='0',difficulty:qs.get('voyageMode')==='easy'?'easy':'pilot'});
    // Restore URL-encoded position, ship colors, view station, voyage state, damage, and active encounter
    try{
      if(qs.has('colors')&&SHIP_COLORS[qs.get('colors')]){
        setVesselColors(boat,qs.get('colors'));
        if(colorsSelect)colorsSelect.value=boat.colors;
      }
      if(qs.has('station')){
        setBoatViewStation(boat,qs.get('station'));
      }
      if(voyageCtl.voyage){
        const v=voyageCtl.voyage;
        const qLat=Number(qs.get('lat')),qLon=Number(qs.get('lon'));
        if(Number.isFinite(qLat)&&Number.isFinite(qLon)&&qs.has('lat')&&qs.has('lon')){
          if(v.true){v.true.lat=qLat;v.true.lon=qLon;}
          if(v.dr){
            v.dr.lat=qs.has('drLat')&&Number.isFinite(Number(qs.get('drLat')))?Number(qs.get('drLat')):qLat;
            v.dr.lon=qs.has('drLon')&&Number.isFinite(Number(qs.get('drLon')))?Number(qs.get('drLon')):qLon;
          }
        }
        if(urlGameState?.voyage){
          const uv=urlGameState.voyage;
          if(Number.isFinite(uv.day))v.dayAtSea=uv.day;
          if(Number.isFinite(uv.dateMs))v.dateMs=uv.dateMs;
          if(v.provisions){
            if(Number.isFinite(uv.waterDays))v.provisions.water=uv.waterDays;
            if(Number.isFinite(uv.foodDays))v.provisions.food=uv.foodDays;
          }
          if(Number.isFinite(uv.morale))v.morale=uv.morale;
        }
        if(qs.has('canvas')&&['full','working','reefed','storm','heave-to'].includes(qs.get('canvas'))){
          voyageCtl.orderCanvas(qs.get('canvas'));
        }
        if(qs.has('course')&&Number.isFinite(Number(qs.get('course')))){
          if(qs.get('autopilot')==='1'||urlGameState?.voyage?.autopilot){
            voyageCtl.orderCompassCourse(Number(qs.get('course')));
          }else{
            v.compassCourse=((Number(qs.get('course'))%360)+360)%360;
          }
        }
        if(qs.has('warp')&&['deck','watch','passage','crossing'].includes(qs.get('warp'))&&qs.get('warp')!=='deck'){
          voyageCtl.setWarp(qs.get('warp'));
        }
      }
      if(urlGameState?.ship?.set&&Array.isArray(urlGameState.ship.set)&&boat.sailState?.set){
        for(let i=0;i<Math.min(3,urlGameState.ship.set.length);i++){
          if(Number.isFinite(urlGameState.ship.set[i]))boat.sailState.set[i]=urlGameState.ship.set[i];
        }
      }
      if(urlGameState?.damage&&boat.damage){
        const ud=urlGameState.damage;
        if(Number.isFinite(ud.hullIntegrity))boat.damage.hullIntegrity=ud.hullIntegrity;
        if(Number.isFinite(ud.battleMorale))boat.damage.battleMorale=ud.battleMorale;
        if(ud.surrendered)strikeVesselColors(boat,'Restored surrendered state');
        if(ud.casualties&&boat.damage.crewCasualties){
          Object.assign(boat.damage.crewCasualties,ud.casualties);
        }
      }
      const allowRestoredEncounter=qs.get('follower')!=='0'&&(!qs.has('fleet')||qs.get('fleet')!=='');
      if(allowRestoredEncounter&&urlGameState?.encounter&&vessels[1]){
        const ue=urlGameState.encounter;
        activateEncounterVessel({
          shipName:ue.name,
          actuallyHostile:ue.faction==='enemy',
          apparentHostile:ue.faction==='enemy',
          colors:ue.colors,
          battleColors:ue.colors,
        },{mode:ue.faction==='enemy'?'engage':'hail'});
        if(Number.isFinite(ue.x))vessels[1].boat.x=ue.x;
        if(Number.isFinite(ue.z))vessels[1].boat.z=ue.z;
        if(Number.isFinite(ue.heading))vessels[1].boat.heading=ue.heading;
        if(ue.surrendered)strikeVesselColors(vessels[1].boat,'Surrendered');
      }
    }catch(restoreErr){
      console.warn('URL state restore warning:',restoreErr);
    }
    updateCrewUI();
    window.oceanVoyage=voyageCtl;
  }
  performanceButton=document.createElement('button');performanceButton.id='performance-toggle';performanceButton.type='button';performanceButton.className='icon-button';
  performanceButton.title='Performance stats';performanceButton.setAttribute('aria-label','Performance stats');performanceButton.setAttribute('aria-controls','performance-panel');
  performanceButton.setAttribute('aria-pressed',String(!performancePanel.hidden));performanceButton.setAttribute('aria-expanded',String(!performancePanel.hidden));
  performanceButton.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3v18h18M7 16v-4m5 4V7m5 9v-7"/></svg>';
  const performanceClose=controlIcon(document.createElement('button'),'close','Hide performance stats');
  performanceClose.onclick=()=>{setPerformanceOpen(false);performanceButton.focus();};performancePanel.querySelector('.panel-header').append(performanceClose);
  performanceButton.onclick=()=>{
    const open=performancePanel.hidden;
    if(open){setPanelOpen(false);setCaptainOpen(false);setBoatOpen(false);setCameraOpen(false);setShareOpen(false);landfallUI.close();if(document.pointerLockElement)document.exitPointerLock();}
    setPerformanceOpen(open);
  };
  pauseButton=controlIcon(document.createElement('button'),simPaused?'play':'pause','Pause simulation');
  pauseButton.id='pause-toggle';pauseButton.title=simPaused?'Resume simulation (P)':'Pause simulation (P)';
  pauseButton.setAttribute('aria-pressed',String(simPaused));
  pauseButton.onclick=()=>setSimPaused(!simPaused);
  cameraDock.append(pauseButton,performanceButton);
  panel.before(cameraDock);
  addEventListener('keydown',e=>{
    if(e.key!=='Escape')return;
    if(!boatPanel.hidden)collapseBoat.click();
    if(!cameraPanel.hidden)cameraClose.click();
    if(!panel.classList.contains('hidden'))hideSea.click();
    if(!sharePanel.hidden)closeShare.click();
    if(!performancePanel.hidden)performanceClose.click();
  });
  // Keep controls in the visible viewport, including browser bars and keyboards.
  const layoutControls=()=>{
    const viewport=window.visualViewport, top=viewport?.offsetTop || 0, height=viewport?.height || innerHeight;
    if(profileDetails?.open && height<420 && innerHeight-height>100)profileDetails.open=false;
    const css=document.documentElement.style;
    css.setProperty('--view-top',top+'px');css.setProperty('--view-height',height+'px');
    css.setProperty('--keyboard-inset',Math.max(0,innerHeight-top-height)+'px');
    const instrumentsBottom=instruments.root.hidden?top+8:instruments.root.getBoundingClientRect().bottom;
    css.setProperty('--instruments-bottom',instrumentsBottom+'px');
    css.setProperty('--controls-bottom',Math.max(cameraDock.getBoundingClientRect().bottom,instrumentsBottom)+8+'px');
  };
  const controlsObserver=new ResizeObserver(layoutControls);controlsObserver.observe(cameraDock);controlsObserver.observe(instruments.root);
  window.visualViewport?.addEventListener('resize',layoutControls);
  window.visualViewport?.addEventListener('scroll',layoutControls);
  addEventListener('resize',layoutControls);layoutControls();
  if(BROADSIDE_SCENARIO&&qs.get('panel')==='captain'){
    setCaptainOpen(true);
    requestAnimationFrame(()=>gunControls?.element?.scrollIntoView?.({block:'end'}));
  }
  const lookHint=document.createElement('div');lookHint.id='look-hint';
  const updateHelp = (flashHint=false) => {
    const gunHint = BROADSIDE_SCENARIO ? ' · F: fire broadside · G: enemy return fire' : '';
    document.querySelector('#hud .help').textContent = (boat.enabled
      ? 'Drag / ↑↓←→: turn view · W/S/Q/E: walk deck · A/D: rudder · X: centre · B: change camera · H: sea settings'
      : cameraMode === 'ship' ? 'Drag / ↑↓←→: orbit ship | Shift-drag: pan | wheel: zoom | B: board ship | H: sea settings'
      : 'WASD: fly | Space/E: up | Q/C: down | wheel: speed | B: board ship | H: sea settings') + gunHint;
    lookHint.textContent = boat.enabled
      ? 'Drag mouse or ↑↓←→ keys to turn view · W S Q E walk deck'
      : cameraMode === 'ship'
      ? 'Drag mouse or ↑↓←→ keys to orbit · Scroll zoom · Shift-drag pan'
      : 'Drag mouse or ↑↓←→ keys to look · WASD fly · E/Q up/down';
    if(flashHint&&lookHint.isConnected){
      document.body.classList.remove('has-looked');
      lookHint.style.animation='none';
      void lookHint.offsetWidth;
      lookHint.style.animation='';
    }
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
    updateHelp(true);
  }
  updateHelp();
  const propulsionRow=document.createElement('label');propulsionRow.textContent='Propulsion';
  const shipChoice=document.createElement('label');shipChoice.textContent='Vessel';
  const shipSelect=document.createElement('select');shipSelect.id='ship-model';shipSelect.setAttribute('aria-label','Vessel');
  for(const model of READY_SHIPS){const option=document.createElement('option');option.value=model.id;option.textContent=model.name;shipSelect.append(option);}
  shipSelect.value=SHIP_ID;shipSelect.onchange=()=>{const url=new URL(location.href);url.searchParams.set('ship',shipSelect.value);for(const key of ['boatLength','boatBeam','boatEye','cam'])url.searchParams.delete(key);location.assign(url.href);};
  shipChoice.append(shipSelect);boatBody.append(shipChoice);
  if(SHIP_ID==='victory'){const spec=document.createElement('p');spec.textContent='1805 reconstruction · 56.69 m gun deck · 15.85 m beam · 104 guns. Twelve visible hands represent a working watch; the loading model accounts for 820 aboard.';boatBody.append(spec);}
  else if(SHIP_ID!=='nina'){
    const model=getShipModel(SHIP_ID),parts=getShipParts(SHIP_ID),spec=document.createElement('p');
    spec.textContent=model.name+' · '+model.runtime.length.toFixed(2)+' m length · '+model.runtime.beam.toFixed(2)+' m beam · '+model.rig.sails.length+' sail surfaces. Authored reconstruction; '+parts.crew.representedCount+' visible hands'+(parts.crew.representedCount!==parts.loading.manifest.crew?' represent '+parts.loading.manifest.crew+' aboard.': ' aboard.');boatBody.append(spec);
  }
  propulsionInput=document.createElement('select');propulsionInput.id='boat-propulsion';
  const rowingModel=Object.hasOwn(ROWING_DESIGNS,SHIP_ID),activeSailGroups=new Set(shipAsset.model.rig.sails.map(s=>s.controlGroup));
  for(const [value,label] of [['sail',rowingModel?(activeSailGroups.size?'Wind and rowing':'Paddling'):'Sailing'],['manual','Set speed']]){
    const option=document.createElement('option');option.value=value;option.textContent=label;propulsionInput.append(option);
  }
  propulsionInput.value=boat.propulsion;propulsionRow.append(propulsionInput);boatBody.append(propulsionRow);
  const boatMotion = document.createElement('p'); boatMotion.id='boat-motion'; boatBody.append(boatMotion);
  sailControls=document.createElement('div');sailControls.id='sail-controls';boatBody.append(sailControls);
  sailInputs=[];
  for(const [i,key] of SAIL_KEYS.entries()){
    const row=document.createElement('label'),name=document.createElement('span');name.textContent=(SHIP_ID==='gipsy-moth-iv'?['Headsails','Mainsail','Mizzen']:SHIP_ID!=='nina'?['Foremast canvas','Mainmast canvas','Mizzen canvas']:['Fore course','Main course','Mizzen sail'])[i];
    row.hidden=!activeSailGroups.has(['fore','main','mizzen'][i]);
    const input=document.createElement('input');Object.assign(input,{type:'range',min:0,max:100,step:5,value:boat[key]*100,id:'boat-'+key});
    input.setAttribute('aria-label',name.textContent);
    const output=document.createElement('output');output.textContent=Math.round(boat[key]*100)+'%';
    input.addEventListener('input',()=>{shipGuns.standDown();boat[key]=Number(input.value)/100;});
    row.append(name,input,output);sailControls.append(row);sailInputs.push({input,output});
  }
  const sailStatus=document.createElement('p');sailStatus.id='sail-status';sailControls.append(sailStatus);
  if(rowingModel){
    const row=document.createElement('label'),name=document.createElement('span'),input=document.createElement('input');name.textContent='Stroke rate (per minute)';
    Object.assign(input,{type:'number',min:7.2,max:ROWING_DESIGNS[SHIP_ID].propulsion.maxCadence*60,step:.1,value:boat.rowingCadence*60,id:'boat-rowing-cadence'});input.setAttribute('aria-label',name.textContent);
    input.oninput=()=>{if(input.validity.valid&&input.value!=='')boat.rowingCadence=Number(input.value)/60;};row.append(name,input);boatBody.append(row);
  }
  for (const [key, label, min, max, step] of [
    ['length', 'Length (m)', 3, 100, 0.5], ['beam', 'Beam (m)', 1, 20, 0.1],
    ['heading', 'Heading (°)', 0, 360, 1], ['speed', 'Calm-water speed (kn)', 0, 40, 0.5],
    ['eye', 'Camera height (m)', 1, 15, 0.1],
  ]) {
    const row = document.createElement('label');
    const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min, max, step, value: boat[key], id: 'boat-' + key });
    if(SHIP_ID!=='nina' && (key==='length'||key==='beam'))input.readOnly=true;
    input.addEventListener('input', () => {
      if (!input.validity.valid || input.value === '') return;
      boat[key] = Number(input.value);
      if (key === 'length' || key === 'beam' || key === 'heading') {
        boat.revision++;
        // Explicit hull edits rebuild its anchor attachment. Ordinary wave,
        // weather and sail revisions retain the deployed world-space anchor.
        anchor.reset(boat);boat.externalForce=anchor.force;updateAnchorUI();
      }
    });
    row.append(name, input); boatBody.append(row);
    if(key==='speed')speedRow=row;
  }
  const loadingPanel=document.createElement('details');loadingPanel.id='boat-loading';
  const loadingTitle=document.createElement('summary');loadingTitle.textContent='Supplies and cargo';loadingPanel.append(loadingTitle);
  for(const [key,label,max,step] of [['provisionDays','Provisions for '+getShipParts(SHIP_ID).loading.manifest.crew+' (days)',120,5],['cargoTonnes','Additional cargo (t)',40,.5]]){
    const row=document.createElement('label'),name=document.createElement('span'),input=document.createElement('input');name.textContent=label;
    Object.assign(input,{type:'number',min:0,max,step,value:boat[key],id:'boat-'+key});input.setAttribute('aria-label',label);
    input.addEventListener('input',()=>{if(input.validity.valid&&input.value!==''){boat[key]=Number(input.value);boat.revision++;}});
    row.append(name,input);loadingPanel.append(row);
  }
  const loadingStatus=document.createElement('p');loadingStatus.id='boat-loading-status';loadingPanel.append(loadingStatus);boatBody.append(loadingPanel);
  function showPropulsionControls(){
    if(!speedRow||!sailControls||!note)return;
    speedRow.hidden=boat.propulsion==='sail';sailControls.hidden=boat.propulsion!=='sail'||activeSailGroups.size===0;
    note.textContent=boat.propulsion==='sail'
      ? rowingModel?'Choose Rest, Easy or Full effort at the helm. Blades act against the moving water; the steering oar and unequal strokes turn the hull.':getShipParts(SHIP_ID).rig.transferYards?'Sails trim automatically. In irons: wind can push the ship astern. The rudder steers that backward flow; centre it as the sails begin drawing again. Captain → Transfer yards is optional on the bad tack.':SHIP_ID==='gipsy-moth-iv'?'Headsails, main and mizzen trim independently to the apparent wind. The ketch has two physical masts and three sail controls.':'Square yards brace with the apparent wind. Furl, reef or set the three mast groups. Headway and heel follow forces on the actual canvas.'
      : 'Waves change speed and hull motion. Set the calm-water speed above.';
  }
  propulsionInput.addEventListener('change',()=>{boat.propulsion=propulsionInput.value;showPropulsionControls();});
  helm=createHelmControls(boat,value=>{
    const order=value===1?'full':value===0?'furl':'reduced';
    shipGuns.standDown();
    if(!crew?.order(boat,order)){boat.propulsion='sail';for(const key of SAIL_KEYS)boat[key]=value;}
    if(voyageCtl?.voyage){
      const vCanvas=value===1?'full':value===0?'heave-to':'reefed';
      voyageCtl.voyage.canvas=vCanvas;
      const vSel=voyageCtl.hud?.querySelector?.('select');
      if(vSel)vSel.value=vCanvas;
    }
    commandFriendlyFleet(vessels,{type:'crew',id:order},{anchorEnv:anchorEnvironment});
    sceneAudio.order(order,{boat});
    propulsionInput.value=boat.propulsion;
    for(const [i,key] of SAIL_KEYS.entries()){
      sailInputs[i].input.value=boat[key]*100;
      sailInputs[i].output.textContent=Math.round(boat[key]*100)+'%';
    }
    showPropulsionControls();updateCrewUI();
    syncBrowserUrlState(performance.now(),true);
  },()=>{propulsionInput.value=boat.propulsion;showPropulsionControls();},{
    gunnery:shipGuns,
    anchor,
    broadside:BROADSIDE_SCENARIO,
    broadsideSide:BROADSIDE_SIDE,
    getVessels:()=>vessels,
    getPortGunnery:()=>portGunnery,
    getDockingBoarding:()=>dockingBoarding,
    onGunneryChange:()=>gunControls?.update?.(),
    onDockToggle:()=>{
      const phase=dockingBoarding.state.mooringPhase;
      if(phase==='moored'||phase==='grappled'||phase==='making-fast'||phase==='throwing-lines'){
        dockingBoarding.castOff();
      }else{
        const activeShip=followerEnabled&&vessels[1]?.boat?.showProw&&!vessels[1].boat.damage?.sunk?vessels[1]:null;
        if(activeShip&&Math.hypot((activeShip.boat.x??0)-boat.x,(activeShip.boat.z??0)-boat.z)<140){
          dockingBoarding.grappleShip(activeShip,{mode:'moor'});
        }else{
          dockingBoarding.dockAtPier({terrain,portLabel:terrain?.region?.name||'Harbor Pier'});
        }
      }
      updateCrewUI();
    },
    onBoardVessel:()=>{
      if(vessels.length>1&&(!followerEnabled||!vessels[1].boat?.showProw)){
        vessels[1].dormantEncounter=false;
        followerEnabled=true;
        boat.followingShip=true;
        vessels[1].boat.showProw=true;
        vessels[1].faction=vessels[1].faction||'enemy';
        vessels[1].boat.faction=vessels[1].faction;
        vessels[1].boat.colors=vessels[1].faction==='enemy'?'jolly-roger':'castile';
      }
      if(vessels[1])dockingBoarding.boardVessel(vessels[1]);
      updateCrewUI();
    },
    onAnchorToggle:()=>{
      if(anchor.active){
        if(anchor.weigh()){commandFriendlyFleet(vessels,{type:'crew',id:'weigh-anchor'},{anchorEnv:anchorEnvironment});sceneAudio.order('weigh-anchor',{boat});updateAnchorUI();}
      }else if(anchor.drop(boat,anchorEnvironment)){
        commandFriendlyFleet(vessels,{type:'crew',id:'drop-anchor'},{anchorEnv:anchorEnvironment});sceneAudio.order('drop-anchor',{boat});updateAnchorUI();
      }
    },
    getCameraMode:()=>cameraMode,
    getShipOrbit:()=>shipOrbit,
    onToggleView:()=>{
      shipOrbit.fleet=false;shipOrbit.wildlife=false;
      if(cameraMode==='boat'&&boat.viewStation!=='crows-nest'){
        setBoatViewStation(boat,'crows-nest');
      }else if(cameraMode==='boat'){
        setBoatViewStation(boat,'deck');
        setCameraMode('ship');
      }else{
        setBoatViewStation(boat,'deck');
        setCameraMode('boat');
      }
    },
    onResetView:()=>{
      if(cameraMode==='boat'){
        setBoatViewStation(boat,'deck');
        resetDeckWalk(boat);
        cam.yaw=0;cam.pitch=-5.5*D2R;
      }else{
        shipOrbit.panX=shipOrbit.panY=shipOrbit.panZ=0;
      }
    },
  });
  const helmReadout=document.createElement('p'); helmReadout.id='helm-readout'; boatBody.append(helmReadout);
  const centerView = document.createElement('button'); centerView.textContent = 'Look ahead';
  centerView.onclick = () => { resetDeckWalk(boat); setCameraMode('boat'); cam.yaw = 0; cam.pitch = -5.5 * D2R; setCameraOpen(false); };
  cameraBody.append(centerView);
  const boatStatus = document.createElement('p'); boatStatus.setAttribute('aria-live', 'off'); boatBody.append(boatStatus);
  note = document.createElement('p'); boatBody.append(note);showPropulsionControls();
  if(LAND_STAGE)Object.assign(P,LANDFALL_WEATHER[LAND_WEATHER],coastalSeaForRegion(terrain?.region,LAND_STAGE));
  for (const k of Object.keys(P)) if (qs.has(k) && Number.isFinite(Number(qs.get(k)))) P[k] = Number(qs.get(k));
  if(LAND_STAGE&&terrain?.region&&terrain.region.id!=='saba'&&Number(qs.get('swellDir'))===22&&Number(qs.get('windDir'))===118){
    const naturalSea=coastalSeaForRegion(terrain.region,LAND_STAGE);
    P.swellDir=naturalSea.swellDir;P.windDir=naturalSea.windDir;
  }
  // Old signed-azimuth links retain their direction on the full-circle controls.
  for(const key of ['windDir','swellDir','sunAzim'])if(P[key]<0||P[key]>360)P[key]=((P[key]%360)+360)%360;
  P.sunElev=Math.max(-90,Math.min(90,P.sunElev));
  const seaTitle = document.createElement('strong'); seaTitle.textContent = 'Sea settings';
  seaTitle.id='sea-title';panel.setAttribute('aria-labelledby','sea-title');
  const seaHeader=document.createElement('div');seaHeader.className='panel-header';
  const hideSea=controlIcon(document.createElement('button'),'close','Hide sea settings');
  hideSea.onclick=()=>{setPanelOpen(false);seaSettingsButton.focus();};seaHeader.append(seaTitle,hideSea);
  const seaBody=document.createElement('div');seaBody.className='panel-body';panel.append(seaHeader,seaBody);
  const astronomyControls=document.createElement('details');astronomyControls.id='astronomy-controls';astronomyControls.open=true;
  const astronomySummary=document.createElement('summary');astronomySummary.textContent='Sun, Moon & sky time';astronomyControls.append(astronomySummary);
  const skyMode=document.createElement('select');skyMode.id='sky-mode';skyMode.innerHTML='<option value="manual">Manual Sun</option><option value="astronomy">Astronomical sky</option>';skyMode.value=astronomy.mode;
  const skyDate=document.createElement('input');skyDate.id='astronomy-date';skyDate.type='datetime-local';skyDate.step='1';skyDate.value=astronomy.state.date.slice(0,19);
  const astroInputs={};
  const MONTH_NAMES=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_DAYS=[31,28,31,30,31,30,31,31,30,31,30,31];
  function formatTimeOfDay(hours){
    const totalMin=((Math.round(hours*60)%1440)+1440)%1440;
    return `${String(Math.floor(totalMin/60)).padStart(2,'0')}:${String(totalMin%60).padStart(2,'0')}`;
  }
  function formatDayOfYear(doy){
    let rem=Math.max(1,Math.min(365,Math.round(doy)));
    for(let m=0;m<12;m++){
      if(rem<=MONTH_DAYS[m]||m===11)return `${MONTH_NAMES[m]} ${rem}`;
      rem-=MONTH_DAYS[m];
    }
    return 'Dec 31';
  }
  function getLocalAstroDecomp(){
    const utcMs=astronomy.epochMs+astronomy.elapsedSeconds*1000;
    const lon=Number(astronomy.state?.observer?.longitude??astronomy.anchor.longitude)||0;
    const tzMs=(lon/15)*3600000;
    const localDate=new Date(utcMs+tzMs);
    const year=localDate.getUTCFullYear();
    const startOfYearMs=Date.UTC(year,0,1,0,0,0);
    const dayOfYear=Math.max(1,Math.min(365,Math.floor((localDate.getTime()-startOfYearMs)/86400000)+1));
    const hours=localDate.getUTCHours()+localDate.getUTCMinutes()/60+localDate.getUTCSeconds()/3600;
    return {year,dayOfYear,hours,tzMs};
  }
  function buildUtcIsoFromLocal(year,dayOfYear,hours,tzMs){
    const localMs=Date.UTC(year,0,1,0,0,0)+(Math.max(1,Math.min(365,Math.round(dayOfYear)))-1)*86400000+Math.round(hours*3600000);
    return new Date(localMs-tzMs).toISOString();
  }
  const initDecomp=getLocalAstroDecomp();
  const timeOfDayRow=document.createElement('label');timeOfDayRow.className='astronomy-slider-row';
  const timeOfDaySpan=document.createElement('span');timeOfDaySpan.textContent='Time of day (local)';
  const timeOfDayInput=document.createElement('input');Object.assign(timeOfDayInput,{type:'range',min:0,max:24,step:0.05,value:initDecomp.hours.toFixed(2),id:'astronomy-time-of-day'});timeOfDayInput.setAttribute('aria-label','Time of day (local)');
  const timeOfDayOut=document.createElement('output');timeOfDayOut.textContent=formatTimeOfDay(initDecomp.hours);
  timeOfDayRow.append(timeOfDaySpan,timeOfDayInput,timeOfDayOut);
  const dayOfYearRow=document.createElement('label');dayOfYearRow.className='astronomy-slider-row';
  const dayOfYearSpan=document.createElement('span');dayOfYearSpan.textContent='Time of year';
  const dayOfYearInput=document.createElement('input');Object.assign(dayOfYearInput,{type:'range',min:1,max:365,step:1,value:String(initDecomp.dayOfYear),id:'astronomy-day-of-year'});dayOfYearInput.setAttribute('aria-label','Time of year');
  const dayOfYearOut=document.createElement('output');dayOfYearOut.textContent=formatDayOfYear(initDecomp.dayOfYear);
  dayOfYearRow.append(dayOfYearSpan,dayOfYearInput,dayOfYearOut);
  const sunSliderAnchor=document.createElement('div');
  astronomyControls.append(timeOfDayRow,dayOfYearRow,sunSliderAnchor);
  function astroControl(text,element){const label=document.createElement('label');label.textContent=text;if(element===skyDate)label.className='astronomy-date-control';label.append(element);astronomyControls.append(label);}
  astroControl('Sky mode',skyMode);astroControl('Date / time (UT-like, proleptic Gregorian)',skyDate);
  for(const [key,label,min,max,value] of [['latitude','Latitude (north +)',-90,90,astronomy.anchor.latitude],['longitude','Longitude (east +)',-180,180,astronomy.anchor.longitude],['rate','Sky clock rate',0,3600,astronomy.rate]]){const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step=key==='rate'?'1':'.001';input.value=value;input.id='astronomy-'+key;astroInputs[key]=input;astroControl(label,input);}
  for(const [key,label] of [['stars','Stars'],['constellations','Constellation guide lines']]){const input=document.createElement('input');input.type='checkbox';input.checked=astronomy[key];input.id='astronomy-'+key;astroInputs[key]=input;astroControl(label,input);}
  const astroStatus=document.createElement('p');astroStatus.id='astronomy-status';astronomyControls.append(astroStatus);
  const skyHelp=document.createElement('p');skyHelp.textContent='Use Time of day & Time of year for astronomical Sun, Moon & stars at this latitude/longitude, or Sun elevation & azimuth for direct manual angles.';astronomyControls.append(skyHelp);
  const landfallMirrorSliders={};
  function syncAstronomySliders(syncSunAngles=false){
    skyMode.value=astronomy.mode;
    if(astronomy.state?.date)skyDate.value=astronomy.state.date.slice(0,19);
    const dec=getLocalAstroDecomp();
    timeOfDayInput.value=dec.hours.toFixed(2);
    timeOfDayOut.textContent=formatTimeOfDay(dec.hours);
    dayOfYearInput.value=String(dec.dayOfYear);
    dayOfYearOut.textContent=formatDayOfYear(dec.dayOfYear);
    if(landfallMirrorSliders.timeOfDay){
      landfallMirrorSliders.timeOfDay.input.value=timeOfDayInput.value;
      landfallMirrorSliders.timeOfDay.output.textContent=timeOfDayOut.textContent;
    }
    if(landfallMirrorSliders.dayOfYear){
      landfallMirrorSliders.dayOfYear.input.value=dayOfYearInput.value;
      landfallMirrorSliders.dayOfYear.output.textContent=dayOfYearOut.textContent;
    }
    if(syncSunAngles&&astronomy.mode==='astronomy'&&astronomy.state?.sun){
      P.sunElev=Math.max(-90,Math.min(90,Number(astronomy.state.sun.altitude.toFixed(1))));
      P.sunAzim=Number((((astronomy.state.sun.azimuth%360)+360)%360).toFixed(1));
      for(const k of ['sunElev','sunAzim']){
        const s=seaSliders?.get(k);
        if(s){s.input.value=String(P[k]);s.output.textContent=String(P[k]);}
        const m=landfallMirrorSliders[k];
        if(m){m.input.value=String(P[k]);m.output.textContent=String(P[k]);}
      }
    }
  }
  function applyAstronomy(values,syncSunAngles=false){try{astronomy.set(values,boat);envFull=true;syncAstronomySliders(syncSunAngles);astroStatus.textContent=astronomy.mode==='astronomy'?'Real Sun/Moon directions; sky clock is separate from wave simulation.':'Manual Sun controls active.';}catch(error){astroStatus.textContent=error.message;}}
  timeOfDayInput.addEventListener('input',()=>{
    const hrs=Number(timeOfDayInput.value);
    const dec=getLocalAstroDecomp();
    applyAstronomy({mode:'astronomy',date:buildUtcIsoFromLocal(dec.year,dec.dayOfYear,hrs,dec.tzMs)},true);
  });
  dayOfYearInput.addEventListener('input',()=>{
    const doy=Number(dayOfYearInput.value);
    const dec=getLocalAstroDecomp();
    const hrs=(astronomy.mode==='manual'&&(astronomy.state?.sun?.altitude??0)<=0&&P.sunElev>2)?14.5:dec.hours;
    applyAstronomy({mode:'astronomy',date:buildUtcIsoFromLocal(dec.year,doy,hrs,dec.tzMs)},true);
  });
  skyMode.onchange=()=>applyAstronomy({mode:skyMode.value},skyMode.value==='astronomy');
  skyDate.onchange=()=>applyAstronomy({mode:'astronomy',date:skyDate.value+'Z'},true);
  astroInputs.latitude.onchange=astroInputs.longitude.onchange=()=>applyAstronomy({latitude:astroInputs.latitude.value,longitude:astroInputs.longitude.value},astronomy.mode==='astronomy');
  astroInputs.rate.onchange=()=>applyAstronomy({rate:astroInputs.rate.value});for(const key of ['stars','constellations'])astroInputs[key].onchange=()=>applyAstronomy({[key]:astroInputs[key].checked});
  seaBody.append(astronomyControls);
  window.oceanAstronomy={clock:astronomy,get state(){return astronomy.state;},set(values){applyAstronomy(values);skyMode.value=astronomy.mode;skyDate.value=astronomy.state.date.slice(0,19);return astronomy.state;},update(elapsed=0){return astronomy.update(elapsed,boat);}};

  const soundButton=document.createElement('button');soundButton.textContent='Enable sound';soundButton.id='sound-toggle';
  soundButton.setAttribute('aria-pressed','false');
  const soundStatus=document.createElement('p');soundStatus.id='sound-status';soundStatus.setAttribute('aria-live','polite');
  soundStatus.textContent='Enable sound for wind, hull, weather and seabirds.';
  const sceneAudio=createSceneAudio({onStatus:state=>{
    soundButton.textContent=state.enabled?'Mute sound':'Enable sound';soundButton.setAttribute('aria-pressed',String(state.enabled));
    captainSound.textContent=state.enabled?'Mute sound':'Enable sound';captainSound.setAttribute('aria-pressed',String(state.enabled));
    soundStatus.textContent=state.loading?'Loading sounds…':state.ready?(state.missing?`${state.missing} sounds unavailable; toggle sound to retry.`:'Sound follows the wind, ship motion and weather.'):'Enable sound for wind, hull, weather and seabirds.';
  }});
  soundButton.onclick=()=>sceneAudio.toggle().catch(()=>{soundStatus.textContent='Could not start audio. Tap Enable sound to retry.';});
  seaBody.append(soundButton,soundStatus);
  const soundDefaultOn=qs.get('sound')==='1'||(qs.get('sound')!=='0'&&!navigator.webdriver);
  if(soundDefaultOn){
    sceneAudio.enable?.().catch(()=>{});
    const unlockDefaultAudio=e=>{
      if(e?.target===soundButton||e?.target===captainSound)return;
      if(sceneAudio.enabled)sceneAudio.resume?.();
    };
    for(const evt of ['pointerdown','keydown','touchstart','wheel'])addEventListener(evt,unlockDefaultAudio,{passive:true});
  }
  const voiceControls=document.createElement('details');voiceControls.id='voice-controls';voiceControls.innerHTML='<summary>Crew voices</summary><p>Twelve named voices. Orders use Captain Trevenen’s rough Cornish voice.</p>';
  const voiceRow=document.createElement('label');voiceRow.textContent='Crew member';
  const voiceSelect=document.createElement('select');voiceSelect.setAttribute('aria-label','Crew voice');
  for(const person of CREW_VOICES){const o=document.createElement('option');o.value=person.id;o.textContent=person.name;voiceSelect.append(o);}
  const previewVoice=document.createElement('button');previewVoice.textContent='Hear crew voice';
  const previewStatus=document.createElement('p');previewStatus.setAttribute('role','status');
  previewVoice.onclick=()=>{const name=sceneAudio.previewCrew(voiceSelect.value,boat);previewStatus.textContent=name?`${name}: “Aye captain!”`:sceneAudio.enabled?'Wait for the current line or sound loading to finish.':'Enable sound first.';};
  voiceRow.append(voiceSelect);voiceControls.append(voiceRow,previewVoice,previewStatus);seaBody.append(voiceControls);
  const typeLabel=document.createElement('label');typeLabel.className='resolution-control';typeLabel.textContent='Precipitation';
  const typeSelect=document.createElement('select');typeSelect.id='precipitation-type';typeSelect.setAttribute('aria-label','Precipitation type');
  WEATHER_TYPES.forEach((label,i)=>{const o=document.createElement('option');o.value=i;o.textContent=label;typeSelect.append(o);});
  typeSelect.value=String(P.precipitation);typeSelect.onchange=()=>{P.precipitation=Number(typeSelect.value);};
  typeLabel.append(typeSelect);seaBody.append(typeLabel);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.classList.contains('hidden'))hideSea.click();});
  const resolutionLabel=document.createElement('label');resolutionLabel.className='resolution-control';resolutionLabel.textContent='Render resolution';
  const resolutionInput=document.createElement('select');resolutionInput.id='render-resolution';
  for(const [value,label] of [['auto','Auto · 60 FPS'],['native','Native (100%)'],['0.75','75%'],['0.5','50%'],...(fixedResolution?[['fixed','Fixed by URL']]:[])]) {
    const option=document.createElement('option');option.value=value;option.textContent=label;resolutionInput.append(option);
  }
  resolutionInput.value=resolution.mode;resolutionInput.disabled=fixedResolution;
  resolutionInput.addEventListener('change',()=>{resolution.setMode(resolutionInput.value);resize();updateResolutionStatus();});
  resolutionLabel.append(resolutionInput);
  const resolutionStatus=document.createElement('p');resolutionStatus.id='resolution-status';
  const updateResolutionStatus=()=>{resolutionStatus.textContent=`${W} × ${H} · ${resolution.mode==='fixed'?'fixed by URL':Math.round(resolution.scale*100)+'%'}${resolution.mode==='auto'?' · target '+resolution.targetFPS+' FPS':''}${resolution.mode==='auto'&&resolution.scale===resolution.minimum?' · minimum resolution':''}`;};
  seaBody.append(resolutionLabel,resolutionStatus);
  const polygonLabel=document.createElement('label');polygonLabel.className='resolution-control';polygonLabel.textContent='Polygon budget';
  const polygonInput=document.createElement('select');polygonInput.id='polygon-budget';
  for(const [value,label] of [['auto','Auto · 60 FPS'],['native','High (100%)'],['0.75','Medium (75%)'],['0.5','Low (50%)'],['0.25','Mobile (25%)'],['0.1','Ultra-low (10%)'],...(fixedPolygons?[['fixed','Fixed by URL']]:[])]) {
    const option=document.createElement('option');option.value=value;option.textContent=label;polygonInput.append(option);
  }
  polygonInput.value=polygons.mode;polygonInput.disabled=fixedPolygons;
  const polygonStatus=document.createElement('p');polygonStatus.id='polygon-status';
  const updatePolygonStatus=()=>{polygonStatus.textContent=`${polygons.mode==='fixed'?'fixed by URL':Math.round(polygons.scale*100)+'% budget'} · ${polygons.pixelError.toFixed(1)} px LOD threshold${polygons.mode==='auto'?' · target '+polygons.targetFPS+' FPS':''}`;};
  polygonInput.addEventListener('change',()=>{polygons.setMode(polygonInput.value);terrain?.setPixelError?.(polygons.pixelError);updatePolygonStatus();});
  polygonLabel.append(polygonInput);
  seaBody.append(polygonLabel,polygonStatus);
  const roughButton = document.createElement('button'); roughButton.textContent = 'Hella rough';
  roughButton.title = '28 m/s wind, 8 m swell, and crossing waves';
  const stormButton=document.createElement('button');stormButton.textContent='Thunderstorm';
  const dryButton=document.createElement('button');dryButton.textContent='Stop precipitation & lightning';
  const applyWeather=settings=>{Object.assign(P,settings);typeSelect.value=String(P.precipitation);for(const [key,{input,output}] of seaSliders){input.value=P[key];output.textContent=String(P[key]);}envFull=true;};
  stormButton.onclick=()=>applyWeather(STORM_WEATHER);dryButton.onclick=()=>applyWeather({rain:0,thunder:0});
  seaBody.append(stormButton,dryButton);
  roughButton.onclick = () => {
    Object.assign(P, ROUGH_SEAS);
    for (const [key, { input, output }] of seaSliders) { input.value = P[key]; output.textContent = String(P[key]); }
    needSpectrum = true; envFull = true;
  };
  seaBody.append(roughButton);
  const SLIDERS = [
    ['rain', 'Precipitation intensity', 0, 1, .01, ''],
    ['thunder', 'Lightning & thunder', 0, 1, .01, ''],
    ['soundVolume', 'Sound volume', 0, 1, .01, ''],
    ['seabirds', 'Seabird activity', 0, 1, .01, ''],
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
    ['sunElev', 'Sun elevation (deg)', -90, 90, 0.1, ''],
    ['sunAzim', 'Sun azimuth (deg)', 0, 360, 0.5, ''],
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
    if(key==='sunElev'||key==='sunAzim')row.className='astronomy-slider-row';
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('output'); val.textContent = String(P[key]);
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'range', min, max, step, value: P[key], id: 'sea-' + key });
    inp.setAttribute('aria-label', label);
    seaSliders.set(key, { input: inp, output: val });
    inp.addEventListener('input', () => {
      P[key] = Number(inp.value); val.textContent = inp.value;
      if(key==='sunElev'||key==='sunAzim'){
        if(astronomy.mode!=='manual')applyAstronomy({mode:'manual'});
        skyMode.value='manual';
        const m=landfallMirrorSliders[key];
        if(m){m.input.value=inp.value;m.output.textContent=inp.value;}
      }
      if (kind === 'spec') needSpectrum = true;
      envFull = true;
    });
    row.append(name, inp, val);
    (key==='sunElev'||key==='sunAzim'?sunSliderAnchor:seaBody).appendChild(row);
  }
  const landfallSunBox=document.getElementById('landfall-sun-sliders');
  if(landfallSunBox){
    const addMirror=(key,labelText,srcInput,srcOut)=>{
      const row=document.createElement('label');
      const name=document.createElement('span');name.textContent=labelText;
      const out=document.createElement('output');out.textContent=srcOut.textContent;
      const inp=document.createElement('input');
      Object.assign(inp,{type:'range',min:srcInput.min,max:srcInput.max,step:srcInput.step,value:srcInput.value,id:'landfall-'+key});
      inp.setAttribute('aria-label',labelText);
      inp.addEventListener('input',()=>{
        srcInput.value=inp.value;
        srcInput.dispatchEvent(new Event('input',{bubbles:true}));
      });
      row.append(name,inp,out);
      landfallSunBox.append(row);
      landfallMirrorSliders[key]={input:inp,output:out};
    };
    addMirror('timeOfDay','Time of day (local)',timeOfDayInput,timeOfDayOut);
    addMirror('dayOfYear','Time of year',dayOfYearInput,dayOfYearOut);
    addMirror('sunElev','Sun elevation (°)',seaSliders.get('sunElev').input,seaSliders.get('sunElev').output);
    addMirror('sunAzim','Sun azimuth (°)',seaSliders.get('sunAzim').input,seaSliders.get('sunAzim').output);
  }
  syncAstronomySliders(astronomy.mode==='astronomy');
  const dolphinControls=createDolphinControls({parent:seaBody,encounter:dolphins.state,boat,getTerrain:()=>terrain,getVessels:()=>followerEnabled?dolphinVessels:dolphinPlayer,
    onView:()=>{setCameraMode('ship');shipOrbit.fleet=false;shipOrbit.wildlife=true;shipOrbit.marine=false;shipOrbit.fleetZoom=1;shipOrbit.elevation=.28;setPanelOpen(false);}});
  const marineControls=createMarineControls({parent:dolphinControls.root,encounter:marineLife.state,boat,getTerrain:()=>terrain,getVessels:()=>followerEnabled?dolphinVessels:dolphinPlayer,notice:dolphinControls.notice,
    onView:()=>{setCameraMode('ship');shipOrbit.fleet=false;shipOrbit.wildlife=true;shipOrbit.marine=true;shipOrbit.fleetZoom=1;shipOrbit.elevation=.28;setPanelOpen(false);}});
  const marineDebug=qs.get('shark')==='1'?'shark':qs.has('whale')?(['breach','fluke','blow'].includes(qs.get('whale'))?qs.get('whale'):'breach'):null;
  if(marineDebug){
    window.oceanStartup?.stage('marine-encounter','Loading the requested marine encounter…');
    await marineLife.load();marineControls.trigger(marineDebug);
    if(qs.get('marineView')==='1'){shipOrbit.wildlife=true;shipOrbit.marine=true;}
  }
  if(qs.get('dolphins')==='1'){dolphins.state.trigger(boat,{terrain,vessels:followerEnabled?dolphinVessels:dolphinPlayer});dolphinControls.notice(dolphins.state.event);}
  document.body.append(lookHint);
  if (qs.get('ui') === '0') { document.getElementById('hud').style.display = 'none'; panel.classList.add('hidden'); boatPanel.hidden = true;performancePanel.hidden=true; cameraDock.hidden=true;helm.root.hidden=true;lookHint.hidden=true; }
  if(qs.get('ui')==='0')dolphinControls.toast.style.display='none';
  if(qs.get('profile')==='1')document.body.classList.add('show-performance');


  const hudFps = document.getElementById('fps');

  // --------------------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------------------
  const submitList = [null];
  const allProjectiles = [];
  const activeFires = [];
  const shotName = qs.get('shot');
  const shotFrames = Number(qs.get('frames')) || 240;
  const shotSeq = Number(qs.get('seq')) || 1;
  let shotIdx = 0;
  const fixedDt = shotName ? 1 / 60 : 0;
  let last = performance.now();
  let fpsN = 0, fpsT = 0;
  let frameWorkMs=0;
  let shooting = false;
  document.addEventListener('visibilitychange',()=>{last=performance.now();fpsN=0;fpsT=0;resolution.reset();polygons.reset();hullContactProbe.reset();sceneAudio.visibility(document.hidden);});

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
    surfaceWaves.encode(cp);
    for(const v of vessels)if(!v.bakedWreck&&!v.dormantEncounter)v.pose?.encode(cp,v.boat.showProw);
    for(const v of vessels)if(!v.bakedWreck&&!v.dormantEncounter)v.interaction.encode(cp,wakePool.next);
    wakePool.commit();
    hullContactProbe.encode(cp);
    spindrift.encode(cp);
    marineLife.encode(cp);
    for(const v of vessels)if(!v.bakedWreck&&!v.dormantEncounter){
      v.wetness.encode(cp,v.boat.showProw);
      if(v.bakingWreck){v.bakingWreck=false;v.bakedWreck=true;}
    }
    // foam clipmaps
    foamCur = 1 - foamCur;
    cp.setPipeline(foamUpdPipe);
    cp.setBindGroup(0, bgFoamUpd[foamCur][wakeIndex()]);
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
    if(bloomMeasureRequested&&bloomFrameReady){measureBloomAlone();return;}
    const cpuFrameStart=performance.now();
    requestAnimationFrame(frame);
    landfallUI.update(now);
    const elapsed = Math.max(0, (now - last) / 1000);
    const workSample = profiler.totalMs>0?Math.max(frameWorkMs,profiler.totalMs):null;
    const resChanged = resolution.sample(elapsed,!document.hidden,workSample);
    if(resChanged&&elapsed<1/28)polygons.reset();
    if(polygons.sample(elapsed,!document.hidden,workSample))terrain?.setPixelError?.(polygons.pixelError);
    resize();
    let camDt = Math.min(0.1, elapsed);
    last = now;
    fpsN++; fpsT += elapsed;
    if (fpsT > 0.5) {
      const fps = fpsN / fpsT;
      hudFps.textContent = `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(2)} ms` +
        (hasTS ? `  |  GPU ${profiler.detailed?'window':'endpoints'} ${profiler.totalMs.toFixed(2)} ms` : '') + `  |  ${nodeCount} nodes  ${W}x${H}`;
      profileSummary=`${fps.toFixed(1)} fps · ${(1000/fps).toFixed(1)} ms/frame\n${W} × ${H} pixels · DPR ${window.devicePixelRatio||1}\nResolution: ${resolution.mode} · ${Math.round(resolution.scale*100)}%${resolution.mode==='auto'?' · target '+resolution.targetFPS+' FPS':''}\nPolygons: ${polygons.mode} · ${Math.round(polygons.scale*100)}% · ${polygons.pixelError.toFixed(1)} px\nCPU frame work: ${frameWorkMs.toFixed(2)} ms\nOcean nodes: ${nodeCount} · Active vessels: ${1+(followerEnabled?vessels.length-1:0)}\nOcean visibility: ${OCEAN_DEPTH?'depth first':'inline'}`;
      if(!performancePanel.hidden){performanceSummary.textContent=profileSummary;profilePanel.textContent=profiler.text();}
      updateResolutionStatus();
      updatePolygonStatus();
      updateCrewUI();
      updateAnchorUI();gunControls.update();fleetViewButton.disabled=!followerEnabled;
      followerStatus.textContent=followerEnabled?vessels.slice(1).map(v=>{const dmg=v.boat.damage;const grdText=dmg?.wreckedOnRocks?` · Wrecked on ${v.boat.groundingContact?.label??'rocks'}`:v.boat.aground?` · Aground (${v.boat.groundingContact?.label??'shoal'})`:'';const dmgText=dmg&&dmg.hits?` · Hull ${Math.round(dmg.hullIntegrity*100)}%`:'';const tag=v.faction==='enemy'?'[Enemy] ':'[Friendly] ';return tag+v.asset.model.name+': '+v.follower.status+' · '+v.follower.separation.toFixed(0)+' m · '+(boatForwardSpeed(v.boat)/KNOT_TO_MPS).toFixed(1)+' kn'+dmgText+grdText;}).join(' / '):'No active followers';
      const playerGrdText=boat.damage?.wreckedOnRocks?` · Wrecked on ${boat.groundingContact?.label??'rocks'}`:boat.aground?` · Aground on ${boat.groundingContact?.label??'shoal'}`:boat.scrapingBottom?` · Scraping ${boat.groundingContact?.label??'shoal'}`:'';
      boatStatus.textContent = boat.enabled
        ? `Pitch ${(boat.pitch / D2R).toFixed(1)}° · Roll ${(boat.roll / D2R).toFixed(1)}° · Heave ${boat.heave.toFixed(2)} m${playerGrdText}`
        : 'Ship continues to float while the camera explores' + playerGrdText;
      const hydro=boat.hydrodynamics;
      boatMotion.textContent = `Speed ${(boatForwardSpeed(boat)/KNOT_TO_MPS).toFixed(2)} kn · Displacement ${(hydro.mass/1000).toFixed(1)} t · Draft ${hydro.draft.toFixed(2)} m`;
      loadingStatus.textContent=`Crew ${(hydro.crewMass/1000).toFixed(2)} t · Water ${(hydro.waterMass/1000).toFixed(2)} t · Food ${(hydro.foodMass/1000).toFixed(2)} t · Casks and spares ${(hydro.storesMass/1000).toFixed(2)} t · Cargo ${(hydro.cargoMass/1000).toFixed(1)} t. Main-deck freeboard ${hydro.freeboard.toFixed(2)} m.${hydro.overloadKg>0?' Overloaded: this loading exceeds the supported draft.':''}`;
      const sails=boat.sailState??sailingState(boat),angle=sails.apparentAngle/D2R;
      sailStatus.textContent=`${pointOfSail(sails.apparentAngle,sails.apparentSpeed)} · apparent wind ${sails.apparentSpeed.toFixed(1)} m/s, ${Math.abs(angle).toFixed(0)}° ${angle>=0?'starboard':'port'} · ${sails.area.toFixed(0)} m² set · wind torque ${Math.abs(sails.rollMoment/1000).toFixed(1)} kN·m`;
      for(let i=0;i<3;i++)sailInputs[i].output.textContent=Math.round(sails.rig[i].deployed*100)+'%';
      if(document.activeElement!==document.getElementById('boat-heading')) document.getElementById('boat-heading').value=boat.heading.toFixed(1);
      helmReadout.textContent=`Heading ${boat.heading.toFixed(1)} deg | Rudder ${boat.rudder.toFixed(1)} deg | Turn ${(boat.yawRate/D2R).toFixed(1)} deg/s`;
      fpsN = 0; fpsT = 0;
    }
    if (fixedDt) camDt = fixedDt;
    const dt = simPaused ? 0 : camDt;
    if(needSpectrum)for(const v of vessels){v.boat.revision++;v.probe.state.time=-1;}
    if(needSpectrum)surfaceWaves.reset();
    const rowingSurfaceTime=simTime+dt,rowingSurfaceWrapped=rowingSurfaceTime>LOOP;
    if(dt>0||needSpectrum||frameIndex===0){
      boat.externalForce=anchor.step(dt,boat,anchorEnvironment);
      for(const event of anchor.events)sceneAudio.anchor(event,boat);
      dockingBoarding.step(dt);
      updateBoat(dt,needSpectrum||elapsed>.5);
      dolphins.update(dt,boat,P,terrain,followerEnabled?dolphinVessels:dolphinPlayer);dolphinControls.update(now);
      marineLife.update(dt,boat,P,terrain,followerEnabled?dolphinVessels:dolphinPlayer);marineControls.update(now);
      rowingSurfaceEvents.flush({time:rowingSurfaceWrapped?rowingSurfaceTime-LOOP:rowingSurfaceTime,dt,
        hidden:document.hidden,resetSea:needSpectrum||elapsed>.5||rowingSurfaceWrapped});
      surfaceWaves.update(boat,dt);
    }
    if(voyageCtl?.active&&dt>0)voyageCtl.update(dt,now);
    instruments.update(now);
    helm.update(now);
    updateCamera(camDt);
    simTime += dt;
    if (simTime > LOOP) simTime -= LOOP;
    frameIndex++;

    astronomy.update(simPaused ? 0 : elapsed,boat);
    if(voyageCtl?.active&&!voyageCtl.voyage?.passive&&(frameIndex&7)===0)syncAstronomySliders(true);
    weather.step(dt,P,cam);
    writeFrame(simTime);
    weatherRenderer.update(weather,P,dt);
    sceneAudio.update(dt,P,boat,frameF,weather);
    if (clouds.update(frameF,P,dt)) envFull = true;
    for(const v of vessels.slice(1)){v.boat.showProw=!v.dormantEncounter&&followerEnabled;v.boat.crew=boat.crew;v.boat.effects=boat.effects;}
    for(const [index,v] of vessels.entries()){
      const ship=v.boat,data=v.hullData,dmg=ship.damage;
      if(v.bakedWreck&&(needSpectrum||(dmg?.pendingBakes?.length??0)>0))v.bakedWreck=false;
      if(v.bakedWreck){
        if(dt>0&&v.gunnery.state.projectiles.length>0){
          v.gunnery.update(dt,[Math.cos(P.windDir*D2R)*P.windSpeed,0,Math.sin(P.windDir*D2R)*P.windSpeed]);
        }
        continue;
      }
      if(!index||followerEnabled){
        if(dt>0)v.gunnery.update(dt,[Math.cos(P.windDir*D2R)*P.windSpeed,0,Math.sin(P.windDir*D2R)*P.windSpeed]);
      }
      const settlingBake=Boolean(dmg?.settledWreck&&(dmg?.pendingBakes?.length??0)===0&&v.gunnery.state.projectiles.length===0);
      if(settlingBake){
        while(dmg?.pendingBakes?.length)v.pose.updateDamage?.(ship);
        for(const g of v.gunnery.state.guns)g.offset=0;
        ship.sailFore=0;ship.sailMain=0;ship.sailMizzen=0;
        v.bakingWreck=true;
        v.entirelySubmerged=((ship.heave??0)+(ship.length??20)*0.95)<-1.5;
      }
      v.visible=ship.showProw;
      boatRotate(data.subarray(0,3),1,0,0,ship.heading*D2R,ship.pitch,ship.roll);
      data[3]=vesselVerticalScale(ship);
      boatRotate(data.subarray(4,7),0,1,0,ship.heading*D2R,ship.pitch,ship.roll);
      boatRotate(data.subarray(8,11),0,0,-1,ship.heading*D2R,ship.pitch,ship.roll);
      data[12]=ship.beam;data[13]=ship.length;data[14]=ship.eye;data[15]=ship.rudder;
      data[16]=ship.x;data[17]=ship.heave;data[18]=ship.z;data[19]=simTime;
      data[20]=P.windDir*D2R-ship.heading*D2R;data[21]=settlingBake?0:P.windSpeed;
      const deckSubmerged=Boolean(dmg?.sunk&&(dmg.sinkingDepth??0)>(ship.hydrodynamics?.freeboard??1.8));
      data[22]=ship.showProw&&!deckSubmerged?1:0;
      data[23]=fleetModelCode(v.asset.model);
      const flash=settlingBake?null:v.gunnery.flash;data[7]=flash?.energy??0;data[11]=flash?.gunId??0;
      const sails=ship.sailState??sailingState(ship);
      data.set(sails.set,24);data[27]=ship.hatchesClosed??0;data[28]=sails.squareYaw;data[29]=sails.lateenYaw;
      data[30]=sails.squareFill;data[31]=sails.lateenFill;data[32]=sails.windSide;data[33]=-sails.windForward;data[34]=sails.apparentSpeed;data[35]=sails.canvasTack;
      writeLateenUniform(data,sails);device.queue.writeBuffer(v.hullUBO,0,data);
      fleetHullData.set(data.subarray(0,24),index*24);
      v.shadows.update(data,frameF.subarray(frameF[115]>.5?96:32,frameF[115]>.5?99:35),ship.showProw&&!v.entirelySubmerged&&qs.get('shadows')!=='0');
      if((!index||followerEnabled)&&dt>0&&!dmg?.sunk){v.crew?.update(ship,dt,P.windSpeed,cam);v.wetness.updateCrew(v.crew?.state,ship);}
      if(!index||followerEnabled){
        v.pose.updateRecoil(v.gunnery.state.guns,ship);
        v.pose.updateDamage?.(ship);
        v.wetness.updateDamage?.(ship.damage);
      }
      if(!index||followerEnabled)v.pose.update(ship,simTime,settlingBake?0:P.windSpeed);
      if(ship.showProw&&!settlingBake)v.anchorRenderer.update(v.anchor,ship);
      if(settlingBake){
        const savedEffects=ship.effects;ship.effects=false;
        v.interaction.update(ship,0,simTime,frameIndex,0,0,true,0);
        ship.effects=savedEffects;
      }else if(dt>0&&!v.dormantEncounter){
        v.interaction.update(ship,dt,simTime,frameIndex,P.windSpeed,P.windDir*D2R,needSpectrum,weather.intensity*(weather.type===1?.1:1));
      }
    }
    if(dt>0)rowingSurfaceEvents.collect(followerEnabled?vessels:[vessels[0]],{time:simTime,dt,
      hidden:document.hidden,resetSea:needSpectrum||elapsed>.5||rowingSurfaceWrapped});
    if(terrain?.port&&terrain.port!==activePortRef){
      activePortRef=terrain.port;
      portGunnery=createPortGunnery(activePortRef,{
        getVessels:()=>followerEnabled?vessels:[vessels[0]],
        getTerrain:()=>terrain,
        onEvent:event=>{
          sceneAudio.gunneryEvent(event);
          const shotKey='port-'+event.shotId;
          if(event.type==='shot')gunEffects.emitShot({...event,id:shotKey,chargeKg:event.mass*.3});
          else if(event.type==='impact'&&event.kind==='water'){
            gunEffects.emitImpact({...event,id:shotKey,position:event.surfacePosition,massKg:event.mass});
          }else if(event.type==='impact'){
            gunEffects.emitImpact({...event,id:shotKey,position:event.surfacePosition,massKg:event.mass,kind:event.kind});
          }
        },
      });
    }
    const windVec=[Math.cos(P.windDir*D2R)*P.windSpeed,0,Math.sin(P.windDir*D2R)*P.windSpeed];
    portGunnery?.update(dt,windVec);
    fortSoldiers?.update(terrain?.port??null,dt,P.windSpeed,cam,!portGunnery);
    terrain?.updatePortDamage?.();
    const activeVesselCount=followerEnabled?vessels.length:1;
    allProjectiles.length=0;
    for(let i=0;i<activeVesselCount;i++)for(const p of vessels[i].gunnery.state.projectiles)allProjectiles.push(p);
    if(portGunnery){const portProj=portGunnery.projectiles;for(let i=0;i<portProj.length;i++)allProjectiles.push(portProj[i]);}
    gunEffects.setProjectiles(allProjectiles);
    if(boat.showProw&&boat.effects!==false){
      const aimFallback=(helm.inBattle||!captainPanel.hidden)?(shipGuns.selectedSide??BROADSIDE_SIDE??'port'):null;
      const aimArcs=shipGuns.computeAimTrajectories?.({wind:windVec,fallbackSide:aimFallback})??[];
      gunEffects.setAimArcs?.(aimArcs);
      if(!captainPanel.hidden&&(frameIndex&3)===0)gunControls.update();
    }else{
      gunEffects.setAimArcs?.([]);
    }
    hullContactProbe.update(boat,dt,{enabled:sceneAudio.enabled&&sceneAudio.ready&&boat.effects!==false,hidden:document.hidden,resetSea:needSpectrum||elapsed>.5});
    activeFires.length=0;
    for(let i=0;i<activeVesselCount;i++){const fires=vessels[i].boat.damage?.worldFires;if(fires)for(const f of fires)activeFires.push(f);}
    if(portGunnery){const portFires=portGunnery.worldFires;for(let i=0;i<portFires.length;i++)activeFires.push(portFires[i]);}
    gunEffects.update(dt,{wind:windVec,eye:[cam.x,cam.y,cam.z],fires:activeFires});
    wakePool.update(vessels);
    device.queue.writeBuffer(fleetHullUBO,0,fleetHullData);sceneShadows.update(vessels);
    spindrift.update(frameF, P.spindrift, dt, needSpectrum);
    if (needSpectrum) writeSimStatic();
    simF[48] = P.choppy;
    simF[52] = simTime; simF[53] = dt;
    device.queue.writeBuffer(simUBO, 0, simF);
    writeFoamUniforms(dt);
    selectAll();
    // A conservative band schedules the optional pass. Its shaders use the
    // current GPU eye-height probe, so crests switch the interface without a
    // CPU readback delay. High aerial views pay no additional render pass.
    const cameraMediumBand=cam.y<waterH+HB+2;
    if (nodeCount) device.queue.writeBuffer(instBuf, 0, instData, 0, nodeCount * 4);

    const enc = device.createCommandEncoder();
    if(celestial.update())envFull=true;celestial.encode(enc);
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
    for(const v of vessels){
      const ship=v.boat,p=v.probe;
      p.requested=!p.pending&&!v.bakedWreck&&(v.id==='player'?(ship.showProw||ship.enabled||(frameIndex&7)===0):followerEnabled);
      if(!p.requested&&!(v.id==='player'&&cameraMediumBand))continue;
      if(p.requested){
        p.length=ship.length;p.beam=ship.beam;p.revision=ship.revision;p.time=simTime;
        p.values[0]=ship.heading*D2R;p.values[1]=ship.length;p.values[2]=ship.beam;
        p.values[4]=ship.x;p.values[5]=ship.heave;p.values[6]=ship.z;
        device.queue.writeBuffer(p.uniform,0,p.values);
      }
      cp.setPipeline(probePipe);cp.setBindGroup(0,p.groups[wakeIndex()]);cp.dispatchWorkgroups(1);
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
    cp.setPipeline(oceanLightingPipe);cp.setBindGroup(0,bgOceanLighting);cp.dispatchWorkgroups(1);
    cp.end();

    for(const v of vessels)v.rowingWater?.encode(enc);
    gunSea.encode(enc,shipGuns.state.projectiles,simTime);
    gunportSafety.encode(enc,boat,shipGuns.state.time);
    const drawProw=vessels.some(v=>v.boat.showProw);
    const gunTransparent=gunEffects.transparentActive;
    // Resolve the ocean straight into the reflection pyramid. The ship pass
    // preserves MSAA color/depth and resolves the finished scene into hdrView.
    mainPass.colorAttachments[0].resolveTarget=drawProw?waterView:hdrView;
    for(const [i,v] of vessels.entries())if((!v.bakedWreck||skyChanged)&&!v.dormantEncounter)v.shadows.encode(enc,profiler,v.boat.damage?.sunk?null:v.crew?.drawShadow,i?v.id+' ':'');
    const terrainCamera={x:frameF[16],y:frameF[17],z:frameF[18],screenHeight:H,pixelError:polygons.pixelError,
      tanHalfFovY:Math.hypot(frameF[24],frameF[25],frameF[26]),forward:frameF.subarray(28,31)};
    terrain?.prepare(terrainCamera,frameF);
    submergedPass.timestampWrites=profiler.writes('Submerged geometry');
    const underwater=enc.beginRenderPass(submergedPass);
    terrain?.drawSubmerged(underwater);
    for(const v of vessels){
      if(!v.boat.showProw)continue;
      if(v.bakedWreck&&v.entirelySubmerged&&Math.hypot((v.boat.x??0)-cam.x,(v.boat.z??0)-cam.z)>350)continue;
      v.render.submerged.bind(underwater);underwater.setBindGroup(0,v.submergedGroup);underwater.setBindGroup(1,v.submergedLighting);
      underwater.setVertexBuffer(0,v.vertexBuffer);if(v.pose)underwater.setVertexBuffer(1,v.pose.buffer);underwater.setIndexBuffer(v.render.indexBuffer,'uint32');underwater.drawIndexed(v.asset.indices.length);
      if(!v.boat.damage?.sunk)v.crew?.drawSubmerged(underwater);
      if(!v.bakedWreck)v.anchorRenderer.drawSubmerged(underwater);
    }
    dolphins.drawSubmerged(underwater);marineLife.drawSubmerged(underwater);underwater.end();
    if(cam.y<waterH+Math.min(HB,1.5)){
      const aboveWater=enc.beginRenderPass(aboveWaterPass);
      terrain?.drawSubmerged(aboveWater,true);
      for(const v of vessels){
        if(!v.boat.showProw||(v.bakedWreck&&v.entirelySubmerged))continue;
        v.render.submerged.bind(aboveWater,true);aboveWater.setBindGroup(0,v.submergedGroup);aboveWater.setBindGroup(1,v.submergedLighting);
        aboveWater.setVertexBuffer(0,v.vertexBuffer);if(v.pose)aboveWater.setVertexBuffer(1,v.pose.buffer);aboveWater.setIndexBuffer(v.render.indexBuffer,'uint32');aboveWater.drawIndexed(v.asset.indices.length);
        if(!v.boat.damage?.sunk)v.crew?.drawSubmerged(aboveWater,true);
        if(!v.bakedWreck)v.anchorRenderer.drawSubmerged(aboveWater,true);
      }
      dolphins.drawSubmerged(aboveWater,true);marineLife.drawSubmerged(aboveWater,true);aboveWater.end();
    }
    mainPass.timestampWrites=profiler.writes('Ocean + sky');
    mainPass.colorAttachments[0].storeOp = drawProw||gunTransparent ? 'store' : 'discard';
    mainPass.depthStencilAttachment.depthStoreOp = drawProw||gunTransparent||cameraMediumBand ? 'store' : 'discard';
    const rp = enc.beginRenderPass(mainPass);
    terrain?.draw(rp,terrainCamera,frameF);
    if (nodeCount) {
      rp.setVertexBuffer(0, instBuf);
      rp.setIndexBuffer(idxBuf, 'uint16');
      // Keep depth and colour in one render pass so tile attachments stay live.
      // The second draw shades only the surviving surface, with no discard.
      if (OCEAN_DEPTH) {
        rp.setPipeline(oceanDepthPipe);
        rp.setBindGroup(0, bgOceanDepth[wakeIndex()]);
        if (coastalDepthGroup) {
          rp.setBindGroup(1, opticsEmptyGroup);
          rp.setBindGroup(2, coastalDepthGroup);
        }
        rp.drawIndexed(GRID * GRID * 6, nodeCount);
      }
      rp.setPipeline(oceanPipe);
      rp.setBindGroup(0, bgOcean[foamCur][wakeIndex()]);
      rp.setBindGroup(1, oceanShadows);
      rp.setBindGroup(2,coastalGroup??opticsEmptyGroup);
      rp.setBindGroup(3,oceanOpticsGroup);
      rp.drawIndexed(GRID * GRID * 6, nodeCount);
    }
    rp.setPipeline(skyPipe);
    rp.setBindGroup(0, bgSky);
    clouds.drawSky(rp);
    rp.draw(3);
    celestial.drawLines(rp,clouds.output);
    if (!drawProw) {fortSoldiers?.draw(rp);dolphins.draw(rp);marineLife.draw(rp);gunEffects.drawProjectiles(rp);spindrift.draw(rp);if(!gunTransparent)weatherRenderer.draw(rp);}
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
          loadOp: 'load', storeOp: gunTransparent?'store':'discard' }],
        depthStencilAttachment: { view: mainPass.depthStencilAttachment.view, depthClearValue:0, depthLoadOp: 'load', depthStoreOp: gunTransparent||cameraMediumBand?'store':'discard' },
      });
      for(let i=0;i<vessels.length;i++){
        const v=vessels[i];
        const visible=Boolean(v.boat.showProw&&!(v.bakedWreck&&v.entirelySubmerged)&&!v.boat.damage?.sunk);
        shipColorsRenderer?.updateVessel(i,visible?v.boat:null,simTime,Math.cos(P.windDir*D2R),Math.sin(P.windDir*D2R),P.windSpeed);
      }
      shipColorsRenderer?.updateMooringVertices(dockingBoarding.buildVertices());
      for(const v of vessels){
        if(!v.boat.showProw||(v.bakedWreck&&v.entirelySubmerged))continue;
        prowPass.setPipeline(v.render.pipeline);prowPass.setBindGroup(0,v.bindGroup);prowPass.setBindGroup(1,v.lighting);
        prowPass.setVertexBuffer(0,v.vertexBuffer);if(v.pose)prowPass.setVertexBuffer(1,v.pose.buffer);prowPass.setIndexBuffer(v.render.indexBuffer,'uint32');prowPass.drawIndexed(v.asset.indices.length);
        if(!v.boat.damage?.sunk)v.crew?.draw(prowPass);
        if(!v.bakedWreck)v.anchorRenderer.draw(prowPass);
      }
      shipColorsRenderer?.draw(prowPass,vessels.length);
      fortSoldiers?.draw(prowPass);
      for(const v of vessels)if(!v.bakedWreck&&!v.dormantEncounter&&v.boat.showProw)v.interaction.draw(prowPass);
      dolphins.draw(prowPass);marineLife.draw(prowPass);gunEffects.drawProjectiles(prowPass);spindrift.draw(prowPass);if(!gunTransparent)weatherRenderer.draw(prowPass);prowPass.end();
    }

    if(gunTransparent){
      gunEffects.resolveDepth(enc,depthMS.createView(),W,H);
      const effects=enc.beginRenderPass({colorAttachments:[{view:mainPass.colorAttachments[0].view,resolveTarget:hdrView,loadOp:'load',storeOp:'discard'}],depthStencilAttachment:{view:depthMS.createView(),depthLoadOp:'load',depthStoreOp:cameraMediumBand?'store':'discard'}});
      gunEffects.draw(effects);weatherRenderer.draw(effects);effects.end();
    }

    underwaterMedium.encode(enc,cameraMediumBand,cameraMediumBand?profiler.writes('Underwater medium'):undefined);
    bloomCameraMediumBand=cameraMediumBand;
    if(P.bloom>0)encodeBloom(enc,bloomProfileWrites,cameraMediumBand);

    compData[0] = frameF[68]; compData[1] = P.bloom; compData[2] = frameIndex % 64; compData[3] = 0.10;
    // Neutral white balance: a fixed cool grade turned shaded oak green in daylight.
    compData[4] = 1.05; compData[5] = 1.06; compData[6] = 0; compData[7] = 1 / bloomLevels;
    device.queue.writeBuffer(compUBO, 0, compData);
    const swapTex = ctx.getCurrentTexture();
    compPass.colorAttachments[0].view = swapTex.createView();
    compPass.timestampWrites=profiler.writes('Composite');
    const pc = enc.beginRenderPass(compPass);
    pc.setPipeline(cameraMediumBand?mediumCompPipe:compPipe);
    pc.setBindGroup(0, cameraMediumBand?bgCompUnderwater:bgComp);
    pc.draw(3);
    pc.end();

    for(const {probe:p} of vessels)if(p.requested)enc.copyBufferToBuffer(p.output,0,p.read,0,64);
    const doAudio=sceneAudio.enabled&&sceneAudio.ready&&!document.hidden&&!audioPending&&boat.showProw&&boat.effects!==false&&(frameIndex&7)===0;
    const audioRevision=boat.revision,audioEpoch=hullContactProbe.epoch,audioRequestedAt=performance.now(),audioSimTime=simTime;
    if(doAudio){enc.copyBufferToBuffer(interaction.contacts,0,audioRead,0,72*64);hullContactProbe.copy(enc,frameIndex);}
    const doTs=profiler.resolve(enc);
    let readBuf = null;
    if (shotName && shotIdx < shotSeq && frameIndex >= shotFrames + shotIdx) {
      shooting = true;
      const bpr = Math.ceil(W * 4 / 256) * 256;
      readBuf = device.createBuffer({ size: bpr * H, usage: GU.MAP_READ | GU.COPY_DST });
      enc.copyTextureToBuffer({ texture: swapTex }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
    }
    submitList[0] = enc.finish();
    device.queue.submit(submitList);bloomFrameReady=true;
    for(const v of vessels)v.rowingWater?.readback();
    if(!oceanStartupFirstFrameSubmitted){
      oceanStartupFirstFrameSubmitted=true;
      // Setup uploads submit earlier too. Only this submission contains the
      // first canvas composite, and its completion must precede revealing it.
      device.queue.onSubmittedWorkDone().then(()=>{
        if(!firstGpuError&&!oceanStartupDeviceLost)window.oceanStartup?.ready();
      },error=>window.oceanStartup?.fail(error));
    }
    gunSea.read(contact=>{
      if(terrain&&contact?.position){
        const landY=terrain.height(contact.position[0],contact.position[2]);
        if(landY>(contact.surfacePosition?.[1]??0)+0.05)return;
      }
      shipGuns.impact(contact);
    });
    gunportSafety.read();
    if(doAudio){
      audioPending=true;
      const bottomEvents=[],bottomReady=hullContactProbe.read(event=>bottomEvents.push(event));
      audioRead.mapAsync(GPUMapMode.READ).then(async()=>{
        try{
          // Resolve true underside returns before selecting a waterline accent.
          // Neither RAF nor the GPU waits for these two small asynchronous maps.
          await bottomReady;
          if(audioRevision!==boat.revision||audioEpoch!==hullContactProbe.epoch||!sceneAudio.enabled||document.hidden||performance.now()-audioRequestedAt>350)return;
          const event=impactDetector.sample(new Float32Array(audioRead.getMappedRange()),audioRevision,{now:audioSimTime});
          sceneAudio.hullContact(impactDetector.contact);
          for(const bottom of bottomEvents){const fresh=hullContactProbe.refreshEvent(bottom);if(fresh)sceneAudio.hullUnderside(fresh);}
          sceneAudio.impact(event);
        }finally{if(audioRead.mapState==='mapped')audioRead.unmap();audioPending=false;}
      }).catch(()=>{audioPending=false;});
    }
    for(const v of vessels){const p=v.probe;if(p.requested){p.pending=true;p.read.mapAsync(GPUMapMode.READ).then(()=>{
      const heights=new Float32Array(p.read.getMappedRange(0,64)).slice();
      const shelter=terrain?.waveShelter?terrain.waveShelter(v.boat.x,v.boat.z,P.swellDir*D2R):1;
      if(shelter<0.999){
        for(let i=0;i<12;i++)heights[i]*=shelter;
      }
      if(v.id==='player')waterH=heights[9];
      acceptVesselProbe(v.boat,p.state,heights,p.time,p.revision,p.length,p.beam);p.read.unmap();p.pending=false;
    },()=>{p.pending=false;});}}
    if (doTs) profiler.read();
    if (readBuf) saveShot(readBuf, Math.ceil(W * 4 / 256) * 256);
    syncBrowserUrlState(now);
    frameWorkMs=performance.now()-cpuFrameStart;
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
    if(qs.get('profile')==='1'||!performancePanel.hidden){
      await profiler.settled();performanceSummary.textContent=profileSummary;profilePanel.textContent=profiler.text();
      await fetch('/__shot?name='+encodeURIComponent(nm.replace(/\.png$/i,'')+'.json'),{method:'POST',body:JSON.stringify({width:W,height:H,frame:frameIndex,oceanDepth:OCEAN_DEPTH,resolution:{mode:resolution.mode,scale:resolution.scale,targetFPS:resolution.targetFPS},polygons:{mode:polygons.mode,scale:polygons.scale,pixelError:polygons.pixelError,targetFPS:polygons.targetFPS},parameters:P,boat:{targetKnots:boat.speed,speedKnots:boatForwardSpeed(boat)/KNOT_TO_MPS,acceleration:boat.surgeAcceleration,massKg:boat.hydrodynamics?.mass},profile:profiler.snapshot()},null,2)});
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
  updatePolygonStatus();
  addEventListener('resize', resize);
  window.oceanStartup?.stage('first-frame','Rendering the first view…');
  requestAnimationFrame(frame);
}

main().catch((e) => {
  log('init failed: ' + (e && e.stack || e));window.oceanStartup?.fail(e);
  const oceanStartupErrorPanel=document.getElementById('err');oceanStartupErrorPanel.style.display='block';oceanStartupErrorPanel.textContent=e?.message||String(e);
});
