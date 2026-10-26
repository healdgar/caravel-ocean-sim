import { ISLAND, decodeIsland, decodeBiome, islandGeometry, islandVegetation, terrainSample, terrainSurfaceSample, constrainIslandMotion, safeLandfallStart, SPANISH_MAIN_1550_REGIONS, generateProceduralCoastalPack, upgradeProceduralPackWithRealDEM } from './terrain-model.js';
import { TREE_VARIANTS, TREE_VERTEX_FLOATS, TREE_PIXEL_ERROR, treeRenderGeometry, selectTreeLods, createForestPatches, visibleForestIds,
  GROUND_COVER,createGroundCoverPatches,groundCoverInstances,projectedGroundExtent,groundCoverError,groundCoverVisible,groundCoverGeometry } from './vegetation.js';
import { TERRAIN, TERRAIN_LIGHT } from './wgsl/terrain.js';
import { loadCanopyScenery, excludeCanopyRoots, createCanopyRenderer, canopyInspectionURL } from './canopy-scenery.js';
import {loadTerrainNear,terrainNearGeometry,terrainNearContains,terrainNearSample,terrainNearPatchBounds,sampleTerrainNear} from './terrain-near.js';
import {loadForestScenery,createForestRenderer,FOREST_VERTEX_WGSL} from './forest-scenery.js';
import {loadForestMass,createForestMassRenderer,forestMiddleWoodPartition,FOREST_MASS_VERTEX_WGSL} from './forest-mass.js';
import {loadForestMiddle} from './forest-middle.js';

import { portClearanceEnvelope, runLandfallDiscoveryPipeline, build1550HistoricalTerritoryPack } from './coastal-world.js';

function hash32Forest(value) {
  let v = value >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

export function retargetForestPackToProcedural(forestPack, proceduralPack, groundSample, { isMobile = false } = {}) {
  const protoCount = forestPack.manifest.prototypes.length;
  const buckets = Array.from({ length: protoCount }, () => []);
  const region = proceduralPack.region;
  const span = region.span ?? 8192;
  const x0 = region.x - span * 0.5;
  const z0 = region.z - span * 0.5;
  const biome = proceduralPack.biome;
  const maskSize = region.biomeSize ?? 256;
  const beaches = proceduralPack.beaches;
  const port = proceduralPack.port;
  const seed = (region.vegetationSeed ?? 47231) >>> 0;
  const maxRoots = isMobile ? 16000 : 58000;

  // Grid-free 2D Poisson-disc + closed-canopy grove expansion guided by the co-registered
  // satellite/1550-map vegetation mask (`biome`) and foreshore beach masks.
  // Eliminates all 1D/2D grid-walk row/lattice artifacts while interlocking neighboring crowns
  // into a continuous closed-canopy forest across the entire territory.
  if (biome instanceof Uint8Array && biome.length === maskSize * maskSize) {
    const crownSpacingFactor = isMobile ? 0.52 : 0.44;
    const cellSize = 24;
    const hashW = Math.ceil(span / cellSize) + 1;
    const head = new Int32Array(hashW * hashW).fill(-1);
    const next = new Int32Array(maxRoots);
    const rx = new Float32Array(maxRoots);
    const rz = new Float32Array(maxRoots);
    const rr = new Float32Array(maxRoots);
    let totalPlaced = 0;

    const isTrop = region.climate === 'tropical' || region.climate === 'subtropical';
    const portCx = port ? port.center.x : region.x;
    const portCz = port ? port.center.z : region.z;
    // Broad-crowned spreading prototypes (oak=0, elm=3, chestnut=4, maple=1) form closed canopy
    const broadTable = [0, 3, 4, 0, 3, 4, 0, 1];

    const sampleBiomeByte = (wx, wz) => {
      const u = (wx - x0) / span;
      const v = (wz - z0) / span;
      if (u <= 0.005 || u >= 0.995 || v <= 0.005 || v >= 0.995) return 0;
      const bi = Math.min(maskSize - 1, Math.floor(u * maskSize));
      const bj = Math.min(maskSize - 1, Math.floor(v * maskSize));
      const idx = bj * maskSize + bi;
      if (beaches?.drySandMask?.[idx] > 110 || beaches?.swashMask?.[idx] > 64) return 0;
      return biome[idx];
    };

    const tryPlaceTree = (x, z, key) => {
      if (totalPlaced >= maxRoots) return -1;
      if (x <= x0 + 32 || x >= x0 + span - 32 || z <= z0 + 32 || z >= z0 + span - 32) return -1;

      const probByte = sampleBiomeByte(x, z);
      if (probByte < 68) return -1;
      if (probByte < 145 && (hash32Forest(key + 5) & 255) > probByte + 64) return -1;

      if (port) {
        const clearEnv = !portClearanceEnvelope(port, x, z, port.hasOrthophotoFootprints ? 8 : 10);
        const clearRad =
          !port.hasOrthophotoFootprints && Math.hypot(x - port.center.x, z - port.center.z) < port.clearRadius * 0.72;
        if (clearEnv || clearRad) return -1;
      }

      const gy = groundSample(x, z);
      if (!Number.isFinite(gy) || gy < 1.25 || gy > 845) return -1;
      const sx = (groundSample(x + 2, z) - groundSample(x - 2, z)) * 0.25;
      const sz = (groundSample(x, z + 2) - groundSample(x, z - 2)) * 0.25;
      const slope = Math.hypot(sx, sz);
      if (!Number.isFinite(slope) || slope > 1.08) return -1;

      const protoId =
        protoCount >= 5
          ? broadTable[hash32Forest(key + 1) & 7] % protoCount
          : hash32Forest(key + 1) % protoCount;
      const proto = forestPack.manifest.prototypes[protoId];

      // Smoothly transition crown scale from architectural/palm scale near the port (1.12..1.56)
      // to broad interlocking canopy crowns across the inland territory (1.58..2.28)
      const distPort = Math.hypot(x - portCx, z - portCz);
      const inlandBlend = Math.max(0, Math.min(1, (distPort - 220) / 680));
      const scaleMin = 1.12 + inlandBlend * 0.46;
      const scaleSpan = 0.44 + inlandBlend * 0.26;
      const scale = scaleMin + (hash32Forest(key + 2) / 4294967296) * scaleSpan;
      const crownR = (proto.crownRadius ?? 8.5) * scale;
      const rimCheckR = Math.min(9.5, crownR * 0.38);
      if (
        sampleBiomeByte(x + rimCheckR, z) < 24 ||
        sampleBiomeByte(x - rimCheckR, z) < 24 ||
        sampleBiomeByte(x, z + rimCheckR) < 24 ||
        sampleBiomeByte(x, z - rimCheckR) < 24 ||
        groundSample(x + rimCheckR, z) < 0.55 ||
        groundSample(x - rimCheckR, z) < 0.55 ||
        groundSample(x, z + rimCheckR) < 0.55 ||
        groundSample(x, z - rimCheckR) < 0.55
      ) {
        return -1;
      }

      const gx = Math.max(0, Math.min(hashW - 1, Math.floor((x - x0) / cellSize)));
      const gz = Math.max(0, Math.min(hashW - 1, Math.floor((z - z0) / cellSize)));
      let collision = false;
      for (let dz = -1; dz <= 1 && !collision; dz++) {
        const nz = gz + dz;
        if (nz < 0 || nz >= hashW) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= hashW) continue;
          for (let idx = head[nz * hashW + nx]; idx !== -1; idx = next[idx]) {
            const ddx = x - rx[idx];
            const ddz = z - rz[idx];
            const minD = crownSpacingFactor * (crownR + rr[idx]);
            if (ddx * ddx + ddz * ddz < minD * minD) {
              collision = true;
              break;
            }
          }
          if (collision) break;
        }
      }
      if (collision) return -1;

      const placedIdx = totalPlaced;
      const cell = gz * hashW + gx;
      rx[placedIdx] = x;
      rz[placedIdx] = z;
      rr[placedIdx] = crownR;
      next[placedIdx] = head[cell];
      head[cell] = placedIdx;
      totalPlaced++;

      const basal = proto.basalRadius ?? 1.2;
      const sink = Math.max(0.12, basal * scale * slope + 0.08);
      const yaw = (hash32Forest(key + 3) / 4294967296) * Math.PI * 2;
      const tint = 0.92 + (hash32Forest(key + 4) / 4294967296) * 0.16;
      const rTint = isTrop ? tint * 0.78 : tint;
      const gTint = isTrop ? tint * 1.12 : tint;
      const bTint = isTrop ? tint * 0.68 : tint;
      buckets[protoId].push(x, gy - sink, z, scale, yaw, rTint, gTint, bTint, protoId, sink, -1, 0);
      return placedIdx;
    };

    // Grid-free 2D independent hash sampling + golden-angle interlocking canopy cluster growth
    const maxCandidates = maxRoots * 5;
    const baseSeed = (seed ^ 0x9e3779b9) >>> 0;
    for (let step = 0; step < maxCandidates && totalPlaced < maxRoots; step++) {
      const h1 = hash32Forest(baseSeed + Math.imul(step, 0x9e3779b1));
      const h2 = hash32Forest(h1 ^ Math.imul(step, 0x85ebca6b) ^ 0xc2b2ae35);
      const u = h1 / 4294967296;
      const v = h2 / 4294967296;
      const sx = x0 + u * span;
      const sz = z0 + v * span;
      const rootIdx = tryPlaceTree(sx, sz, h2);
      if (rootIdx < 0) continue;

      // Expand into a tightly interlocking closed-canopy grove around the accepted tree
      const baseR = rr[rootIdx];
      const baseAngle = (hash32Forest(h2 + 17) / 4294967296) * Math.PI * 2;
      for (let c = 0; c < 8 && totalPlaced < maxRoots; c++) {
        const cKey = hash32Forest(h2 ^ Math.imul(c + 1, 0x27d4eb2d));
        const angle = baseAngle + c * 2.39996323 + ((cKey & 1023) / 1024 - 0.5) * 0.45;
        const ringMul = c < 4 ? 0.96 : 1.68;
        const dist = baseR * ringMul * (0.90 + ((cKey >>> 10) & 1023) / 1024 * 0.32);
        const nx = sx + Math.cos(angle) * dist;
        const nz = sz + Math.sin(angle) * dist;
        tryPlaceTree(nx, nz, cKey);
      }
    }
  }

  // Fallback to explicit scrub/upland arrays if biome grid did not place roots
  if (buckets.every((b) => b.length === 0)) {
    const sources = [
      ...(proceduralPack.vegetation?.scrub || []),
      ...(proceduralPack.vegetation?.upland || []),
    ];
    for (let i = 0; i < sources.length; i += 8) {
      const x = sources[i], z = sources[i + 2];
      const legacyScale = sources[i + 3], yaw = sources[i + 4];
      const gy = groundSample(x, z);
      if (!Number.isFinite(gy) || gy < 2.0) continue;
      const sx = (groundSample(x + 1, z) - groundSample(x - 1, z)) * 0.5;
      const sz = (groundSample(x, z + 1) - groundSample(x, z - 1)) * 0.5;
      const slope = Math.hypot(sx, sz);
      if (!Number.isFinite(slope) || slope > 1.08) continue;
      const hash = ((Math.sin(x * 0.071 + z * 0.113 + yaw) * 43758.5453) % 1 + 1) % 1;
      const protoId = Math.min(protoCount - 1, Math.floor(hash * protoCount));
      const scale = Math.max(0.90, Math.min(1.36, 0.72 + legacyScale * 0.085));
      const tint = 0.92 + ((hash * 7.3) % 0.16);
      const basal = forestPack.manifest.prototypes[protoId].basalRadius ?? 1.2;
      const sink = Math.max(0.12, basal * scale * slope + 0.08);
      buckets[protoId].push(x, gy - sink, z, scale, yaw, tint, tint, tint, protoId, sink, -1, 0);
    }
  }
  // Ensure at least one subterranean sentinel root if a small coral cay has 0 upland trees
  if (buckets.every(b => b.length === 0)) {
    buckets[0].push(proceduralPack.region.x, -500, proceduralPack.region.z, 0, 0, 1, 1, 1, 0, 0, -1, 0);
  }
  let firstRoot = 0;
  const prototypes = forestPack.manifest.prototypes.map((p, id) => {
    const rootCount = buckets[id].length / 12;
    const next = { ...p, firstRoot, rootCount };
    firstRoot += rootCount;
    return next;
  });
  const roots = new Float32Array(firstRoot * 12);
  let offset = 0;
  for (let id = 0; id < protoCount; id++) {
    roots.set(buckets[id], offset);
    offset += buckets[id].length;
  }
  return {
    ...forestPack,
    roots,
    maxRootCapacity: maxRoots,
    manifest: {
      ...forestPack.manifest,
      rootCount: firstRoot,
      prototypes,
    },
  };
}

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples,waterOptics=null,
  canopyMode=typeof location==='undefined'?'auto':new URLSearchParams(location.search).get('canopy')||'auto'}){
  if(!['auto','near','far','off'].includes(canopyMode))throw Error('Unknown canopy scenery mode');
  // createTerrain is itself deferred until landfall; optional stand downloads
  // never run on the open-ocean startup path. Failure retains all old roots.
  const search=typeof location==='undefined'?new URLSearchParams():new URLSearchParams(location.search);
  const regionParam=search.get('region');
  const hasCustomCoords=search.has('lat')&&search.has('lon')&&Number.isFinite(Number(search.get('lat')))&&Number.isFinite(Number(search.get('lon')));
  const presetMatch=regionParam&&regionParam!=='saba'&&Object.hasOwn(SPANISH_MAIN_1550_REGIONS,regionParam)?SPANISH_MAIN_1550_REGIONS[regionParam]:null;
  const isKnownSpanishMain=Boolean(presetMatch&&(!hasCustomCoords||(Math.abs(Number(search.get('lat'))-presetMatch.latitude)<0.05&&Math.abs(Number(search.get('lon'))-presetMatch.longitude)<0.05)));
  const isCustomSabaOverride=hasCustomCoords&&regionParam==='saba'&&(Math.abs(Number(search.get('lat'))-ISLAND.latitude)>0.05||Math.abs(Number(search.get('lon'))-ISLAND.longitude)>0.05);
  const useProcedural=isKnownSpanishMain||(hasCustomCoords&&(regionParam!=='saba'||isCustomSabaOverride));
  const isMobile=typeof navigator!=='undefined'&&(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1));
  const skipNativeForest=isMobile;
  const load=async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`Saba terrain unavailable (${response.status})`);return response;};
  // Start shader compilation, foliage fetch, and forest downloads immediately in parallel with DEM/terrain loading
  const modulePromise=shader(TERRAIN+FOREST_VERTEX_WGSL+FOREST_MASS_VERTEX_WGSL,'island terrain');
  const leafBitmapPromise=load('assets/tree-foliage.png').then(r=>r.blob()).then(b=>createImageBitmap(b));
  let canopyFailure=null;
  let forestFailure=null;
  const forestPromise=canopyMode==='off'?Promise.resolve(null):loadForestScenery({skipNative:skipNativeForest,deferNative:!skipNativeForest&&useProcedural,skipRoots:useProcedural}).catch(error=>{forestFailure=error.message;return null;});
  const forestMassMode=typeof location==='undefined'?canopyMode:search.get('forestMass')||canopyMode;
  if(!['auto','near','far','off'].includes(forestMassMode))throw Error('Unknown native forest mass mode');
  const forestAtlasDebug=typeof location!=='undefined'&&['auto','force'].includes(search.get('forestImpostor'));
  let forestMassFailure=null,forestMiddleFailure=null;
  // This is a new optional asset, never an alias of the rejected crown pack.
  // Missing/unqualified transport retains the existing native/atlas forest.
  const forestMassPromise=forestPromise.then(forest=>forest&&forestMassMode!=='off'?loadForestMass({forest,manifestOnly:skipNativeForest||useProcedural}).catch(error=>{forestMassFailure=error.message;return null;}):null);
  const forestMiddlePromise=Promise.all([forestPromise,forestMassPromise]).then(async([forest,mass])=>{
    if(!forest||!mass||forestAtlasDebug)return null;
    try{
      const middle=await loadForestMiddle({forest,mass});
      if(middle?.manifest.recipe.leafShading==='field'&&!forest.volumes)throw Error('Field-shaded middle requires verified native foliage fields');
      return middle;
    }catch(error){forestMiddleFailure=error.message;return null;}
  });
  // Regional native trees replace the entire old population. The small legacy
  // example is a fallback, never a second stand mixed into the new forest.
  const canopyPromise=forestPromise.then(forest=>useProcedural||forest||canopyMode==='off'?null:loadCanopyScenery().catch(error=>{canopyFailure=error.message;return null;}));
  const autoCurated1550=isKnownSpanishMain&&search.get('discover')!=='1'&&search.get('era')!=='2026';
  const useRealDEM=useProcedural&&search.get('realDEM')!=='off'&&!(isMobile&&autoCurated1550);
  const proceduralGridOpts=isMobile
    ?{size:257,biomeSize:256,albedoSize:512,vegetationCandidates:12000,deferSynthesis:useRealDEM}
    :{size:513,biomeSize:512,albedoSize:1024,vegetationCandidates:24000,deferSynthesis:useRealDEM};
  const proceduralPack=useProcedural?generateProceduralCoastalPack(isKnownSpanishMain?regionParam:{
    id:regionParam||undefined,
    name:search.get('regionName')||undefined,
    latitude:Number(search.get('lat')),
    longitude:Number(search.get('lon')),
  },proceduralGridOpts):null;
  if(proceduralPack&&useRealDEM){
    await upgradeProceduralPackWithRealDEM(proceduralPack);
  }
  let activeRegion=proceduralPack?proceduralPack.region:ISLAND;
  let heights,biome,nearTile=null,nearFailure=null,albedoImage=null;
  if(proceduralPack){
    heights=proceduralPack.heights;biome=proceduralPack.biome;
  }else{
    const [heightResponse,biomeResponse,albedoResponse,regionResponse]=await Promise.all([load(ISLAND.assets.height),load(ISLAND.assets.biome),load(ISLAND.assets.albedo),load('assets/world/saba/manifest.json')]);
    heights=decodeIsland(await heightResponse.arrayBuffer());biome=decodeBiome(await biomeResponse.arrayBuffer());
    const baseManifest=await regionResponse.json(),nearDisabled=typeof location!=='undefined'&&search.get('nearTerrain')==='off';
    if(!nearDisabled)try{nearTile=await loadTerrainNear({baseManifest,baseHeights:heights});}catch(error){nearFailure=error.message;}
    albedoImage=await createImageBitmap(await albedoResponse.blob());
    if(albedoImage.width!==ISLAND.albedoSize||albedoImage.height!==ISLAND.albedoSize)throw new Error('Incomplete Saba imagery seed');
  }
  const groundSample=(x,z)=>proceduralPack?terrainSurfaceSample(heights,x,z,activeRegion):sampleTerrainNear(nearTile,heights,x,z);
  const heightSample=(x,z)=>proceduralPack?terrainSample(heights,x,z,activeRegion):(terrainNearSample(nearTile,x,z)??terrainSample(heights,x,z));
  let mesh=proceduralPack?proceduralPack.mesh:islandGeometry(heights,nearTile?.bounds);const fineMesh=nearTile?terrainNearGeometry(nearTile,mesh):null;
  const originalTrees=proceduralPack?proceduralPack.vegetation.trees:islandVegetation(heights,biome),canopyPack=await canopyPromise;
  // Root positions change once at asset preparation, never as an animation.
  if(nearTile)for(let i=0;i<originalTrees.length;i+=8)if(terrainNearContains(nearTile,originalTrees[i],originalTrees[i+2]))originalTrees[i+1]=groundSample(originalTrees[i],originalTrees[i+2]);
  const canopyTrees=canopyPack?excludeCanopyRoots(originalTrees,canopyPack.manifest):originalTrees,forestPack=await forestPromise;
  const trees=forestPack?new Float32Array(0):canopyTrees;
  let groundPatches=createGroundCoverPatches(activeRegion,groundSample,nearTile?(x,z,span)=>terrainNearPatchBounds(nearTile,x,z,span):null);
  const buffer=(data,usage,label)=>{
    const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST,label});
    if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;
  };
  let vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices');
  let indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices');
  let submergedIndices=mesh.submergedIndices?buffer(mesh.submergedIndices,GPUBufferUsage.INDEX,'submerged island indices'):indices;
  let submergedCount=mesh.submergedIndices?.length??mesh.indices.length;
  let portMesh=proceduralPack?.portGeometry?.indices?.length?{
    vertices:buffer(proceduralPack.portGeometry.vertices,GPUBufferUsage.VERTEX,'coastal port prefab vertices'),
    indices:buffer(proceduralPack.portGeometry.indices,GPUBufferUsage.INDEX,'coastal port prefab indices'),
    count:proceduralPack.portGeometry.indices.length,
  }:null;
  const fine=fineMesh?{vertices:buffer(fineMesh.vertices,GPUBufferUsage.VERTEX,'Wells Bay immutable near vertices'),
    indices:buffer(fineMesh.indices,GPUBufferUsage.INDEX,'Wells Bay near indices'),
    submerged:buffer(fineMesh.submergedIndices,GPUBufferUsage.INDEX,'Wells Bay submerged near indices')}:null;
  const nearDomain=buffer(new Float32Array(nearTile?[nearTile.manifest.domain.x,nearTile.manifest.domain.z,nearTile.manifest.domain.span,1,nearTile.manifest.domain.size,0,0,0]:[0,0,1,0,1,0,0,0]),GPUBufferUsage.UNIFORM,'Wells Bay near domain');
  // Four exact height loads from immutable storage avoid consuming another
  // sampled-texture slot in the already texture-heavy ocean fragment stage.
  const nearElevation=buffer(nearTile?.heights??new Float32Array([-120]),GPUBufferUsage.STORAGE,'Wells Bay immutable near elevation');
  const uniform=buffer(new Float32Array([activeRegion.x,activeRegion.z,activeRegion.span,1]),GPUBufferUsage.UNIFORM,'land domain');
  const elevation=device.createTexture({label:'island elevation',size:[activeRegion.size,activeRegion.size],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
  const lighting=device.createTexture({label:'island sunlight',size:[64,64],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
  const albedoMips=1+Math.log2(activeRegion.albedoSize);
  const albedo=device.createTexture({label:'registered island imagery seed',size:[activeRegion.albedoSize,activeRegion.albedoSize],format:'rgba8unorm',mipLevelCount:albedoMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  if(proceduralPack){
    device.queue.writeTexture({texture:albedo},proceduralPack.albedo,{bytesPerRow:activeRegion.albedoSize*4},[activeRegion.albedoSize,activeRegion.albedoSize]);
  }else{
    device.queue.copyExternalImageToTexture({source:albedoImage},{texture:albedo},[ISLAND.albedoSize,ISLAND.albedoSize]);albedoImage.close();
  }
  const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(mipPipe);
  for(let m=1;m<albedoMips;m++){
    cp.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:albedo.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:albedo.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    cp.dispatchWorkgroups(Math.ceil((activeRegion.albedoSize>>m)/8),Math.ceil((activeRegion.albedoSize>>m)/8));
  }
  cp.end();device.queue.submit([enc.finish()]);
  let nearAlbedo=albedo;
  if(nearTile){
    const image=await createImageBitmap(new Blob([nearTile.albedo],{type:'image/png'}));
    if(image.width!==1024||image.height!==1024)throw Error('Incomplete Wells Bay near imagery');
    nearAlbedo=device.createTexture({label:'Wells Bay registered near imagery',size:[1024,1024],format:'rgba8unorm',mipLevelCount:11,
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    device.queue.copyExternalImageToTexture({source:image},{texture:nearAlbedo},[1024,1024]);image.close();
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(mipPipe);
    for(let m=1;m<11;m++){
      pass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
        {binding:0,resource:nearAlbedo.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:nearAlbedo.createView({baseMipLevel:m,mipLevelCount:1})}]}));
      pass.dispatchWorkgroups(Math.ceil((1024>>m)/8),Math.ceil((1024>>m)/8));
    }
    pass.end();device.queue.submit([encoder.finish()]);
  }
  const leafImage=await leafBitmapPromise;
  // Preserve the exact source foliage's integrated linear colour when its
  // individual leaves are below the geometric LOD threshold. One authoring
  // image readback at load time; opaque fragments never fetch a leaf texture.
  const leafCanvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(leafImage.width,leafImage.height):Object.assign(document.createElement('canvas'),{width:leafImage.width,height:leafImage.height});
  const leafContext=leafCanvas.getContext('2d',{willReadFrequently:true});leafContext.drawImage(leafImage,0,0);
  const leafPixels=leafContext.getImageData(0,0,leafImage.width,leafImage.height).data,leafRGB=[0,0,0];let leafWeight=0;
  for(let i=0;i<leafPixels.length;i+=4){const alpha=leafPixels[i+3]/255;leafWeight+=alpha;for(let c=0;c<3;c++)leafRGB[c]+=Math.pow(leafPixels[i+c]/255,2.2)*alpha;}
  const leafMean=buffer(new Float32Array([...leafRGB.map(v=>v/Math.max(leafWeight,1)),leafWeight/(leafPixels.length/4)]),GPUBufferUsage.UNIFORM,'source foliage mean colour');
  const leafMips=1+Math.floor(Math.log2(Math.max(leafImage.width,leafImage.height)));
  const leafTexture=device.createTexture({label:'procedural twig and leaf cutouts',size:[leafImage.width,leafImage.height],format:'rgba8unorm',mipLevelCount:leafMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  device.queue.copyExternalImageToTexture({source:leafImage},{texture:leafTexture},[leafImage.width,leafImage.height]);leafImage.close();
  const leafEncoder=device.createCommandEncoder(),leafPass=leafEncoder.beginComputePass();leafPass.setPipeline(mipPipe);
  for(let m=1;m<leafMips;m++){
    leafPass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:leafTexture.createView({baseMipLevel:m-1,mipLevelCount:1})},
      {binding:1,resource:leafTexture.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    leafPass.dispatchWorkgroups(Math.ceil(Math.max(1,leafTexture.width>>m)/8),Math.ceil(Math.max(1,leafTexture.height>>m)/8));
  }
  leafPass.end();device.queue.submit([leafEncoder.finish()]);
  const biomeTexture=device.createTexture({label:'regional vegetation probability',size:[activeRegion.biomeSize,activeRegion.biomeSize],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
  const landSampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',maxAnisotropy:4});
  const module=await modulePromise;
  const makePipe=(entryPoint,buffers,fragmentEntry='fs')=>device.createRenderPipelineAsync({label:entryPoint==='vs'?'island':entryPoint==='groundVS'?'island ground cover':fragmentEntry==='leafFS'?'island trees':'island canopy and wood',layout:'auto',
    vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:fragmentEntry,targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:fragmentEntry==='leafFS'&&samples>1}});
  const meshLayout={arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]};
  const treeLayout={arrayStride:TREE_VERTEX_FLOATS*4,attributes:[...meshLayout.attributes,{shaderLocation:5,offset:32,format:'float32x2'}]};
  const treeBuffers=[treeLayout,{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'},{shaderLocation:4,offset:16,format:'float32x4'}]}];
  const [terrainPipe,opaqueTreePipe,treePipe,groundPipe,lightPipe]=await Promise.all([
    makePipe('vs',[meshLayout]),
    makePipe('treeVS',treeBuffers,'opaqueFS'),
    makePipe('treeVS',treeBuffers,'leafFS'),
    makePipe('groundVS',treeBuffers,'groundFS'),
    computePipe(TERRAIN_LIGHT,'island sunlight'),
  ]);
  const groundMeshes=Array.from({length:GROUND_COVER.variants},(_,variant)=>{
    const geometry=groundCoverGeometry(variant);return{buffer:buffer(geometry,GPUBufferUsage.VERTEX,`ground cover ${variant}`),count:geometry.length/TREE_VERTEX_FLOATS};
  });
  const groundBatches=groundMeshes.map((_,variant)=>({buffer:null,capacity:0,label:`ground cover instances ${variant}`,data:[],count:0}));
  const groundStats={patches:groundPatches.length,resident:0,rocks:0,grass:0,triangles:0},previousGround=new Set();
  const treeMeshes=Array.from({length:3},(_,lod)=>Array.from({length:TREE_VARIANTS},(_,variant)=>{
    const data=treeRenderGeometry(variant,lod);let opaqueEnd=0;
    while(opaqueEnd<data.length&&data[opaqueEnd+6]!==2)opaqueEnd+=TREE_VERTEX_FLOATS*3;
    const part=(data,label)=>({buffer:buffer(data,GPUBufferUsage.VERTEX,label),count:data.length/TREE_VERTEX_FLOATS});
    return {opaque:part(data.subarray(0,opaqueEnd),`tree wood/canopy ${variant} detail ${lod}`),
      leaves:part(data.subarray(opaqueEnd),`tree leaves ${variant} detail ${lod}`)};
  }));
  const treeBatches=Array.from({length:3*TREE_VARIANTS},(_,id)=>({
    buffer:null,capacity:0,label:`tree instances ${id}`,data:[],count:0,
  }));
  const previousLods=new Map(),forestPatches=createForestPatches(trees),lodStats={near:0,middle:0,far:0,budgetOverflow:0};
  let lastCamera=null,lastView=null,lastPixels=null,currentPixelError=TREE_PIXEL_ERROR;
  let importedCanopy=null;
  function updateTrees(camera,viewProjection){
    if(Number.isFinite(camera?.pixelError)&&camera.pixelError>0){
      currentPixelError=camera.pixelError;
      forestMass?.setPixelError?.(currentPixelError);
      forest?.setPixelError?.(currentPixelError);
    }
    // Its stricter projection bound must not inherit the legacy tree batching
    // cache's one-metre/view tolerance when crossing a three-pixel threshold.
    importedCanopy?.prepare(camera,viewProjection);
    const sameView=(!viewProjection&&!lastView)||(viewProjection&&lastView&&lastView.every((v,i)=>Math.abs(v-viewProjection[i])<.004));
    const pixels=[camera.screenHeight,camera.tanHalfFovY,currentPixelError,...(camera.forward??[])];
    const samePixels=lastPixels&&pixels.length===lastPixels.length&&pixels.every((v,i)=>v===lastPixels[i]);
    if(lastCamera&&sameView&&samePixels&&Math.hypot(camera.x-lastCamera.x,camera.y-lastCamera.y,camera.z-lastCamera.z)<1)return;
    lastPixels=pixels;
    lastCamera={x:camera.x,y:camera.y,z:camera.z};lastView=viewProjection?Array.from(viewProjection).slice(0,16):null;
    lodStats.near=0;lodStats.middle=0;lodStats.far=0;lodStats.budgetOverflow=0;
    for(const batch of treeBatches){batch.data=[];batch.count=0;}
    const candidates=visibleForestIds(forestPatches,camera,viewProjection);
    for(const tree of selectTreeLods(trees,{...camera,pixelError:currentPixelError},previousLods,undefined,candidates)){
      const batch=treeBatches[tree.lod*TREE_VARIANTS+tree.variant];
      batch.data.push(...trees.subarray(tree.id*8,tree.id*8+8));batch.count++;
      lodStats[['far','middle','near'][tree.lod]]++;if(tree.qualityBudgetOverflow)lodStats.budgetOverflow++;
    }
    for(const batch of treeBatches)if(batch.count){
      // Regional plant count bounds residency. Quality budgets must never
      // overflow a fixed 96/512-instance buffer or silently lower detail.
      if(batch.count>batch.capacity){
        batch.buffer?.destroy();batch.capacity=Math.min(trees.length/8,Math.max(batch.count,Math.ceil(batch.capacity*1.5),32));
        batch.buffer=device.createBuffer({size:batch.capacity*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,label:batch.label});
      }
      device.queue.writeBuffer(batch.buffer,0,new Float32Array(batch.data));
    }
    for(const batch of groundBatches){batch.data=[];batch.count=0;}
    const groundNow=new Set();groundStats.resident=0;groundStats.rocks=0;groundStats.grass=0;groundStats.triangles=0;
    for(const id of visibleForestIds(groundPatches,camera,viewProjection)){
      const patch=groundPatches[id];
      if(projectedGroundExtent(...patch.centre,GROUND_COVER.maxExtent,camera,patch.radius)<currentPixelError*.88)continue;
      const instances=groundCoverInstances(patch,activeRegion,groundSample,biome);groundStats.resident++;
      for(let variant=0;variant<GROUND_COVER.variants;variant++){
        if(variant>=2&&projectedGroundExtent(...patch.centre,3.3,camera,patch.radius)<currentPixelError*.88)continue;
        const data=instances[variant],batch=groundBatches[variant];
        for(let i=0;i<data.length;i+=8){
          const key=id+':'+variant+':'+i,error=groundCoverError(data[i],data[i+1],data[i+2],data[i+3],data[i+4],camera);
          // Hysteresis retains small visible props a little longer; an omitted
          // prop never exceeds the three-pixel geometric extent threshold.
          if(!groundCoverVisible(error,previousGround.has(key),currentPixelError))continue;
          groundNow.add(key);batch.data.push(...data.subarray(i,i+8));batch.count++;
        }
      }
    }
    previousGround.clear();for(const key of groundNow)previousGround.add(key);
    for(let variant=0;variant<groundBatches.length;variant++){
      const batch=groundBatches[variant];if(!batch.count)continue;
      if(batch.count>batch.capacity){
        batch.buffer?.destroy();batch.capacity=Math.min(groundPatches.length*(GROUND_COVER.grassPerPatch+GROUND_COVER.rocksPerPatch),Math.max(batch.count,Math.ceil(batch.capacity*1.5),32));
        batch.buffer=device.createBuffer({size:batch.capacity*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,label:batch.label});
      }
      device.queue.writeBuffer(batch.buffer,0,new Float32Array(batch.data));
      groundStats[variant<2?'rocks':'grass']+=batch.count;groundStats.triangles+=batch.count*groundMeshes[variant].count/3;
    }
  }
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,albedo.createView()],[8,landSampler],[9,biomeTexture.createView()],[10,leafTexture.createView()],[11,{buffer:leafMean}]];
  if(canopyPack)importedCanopy=await createCanopyRenderer({device,module,resources,clouds,format,samples,pack:canopyPack,mode:canopyMode});
  const [forestMassPack,forestMiddlePack]=await Promise.all([forestMassPromise,forestMiddlePromise]);
  let forestMass=null,proceduralMiddle=null;
  if(forestMassPack&&!forestMassPack.manifestOnly&&!proceduralPack)try{forestMass=await createForestMassRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack:forestMassPack,middlePack:forestMiddlePack,mode:forestAtlasDebug?'near':forestMassMode,preview:false});}catch(error){forestMassFailure=error.message;}
  if((skipNativeForest||proceduralPack)&&forestMassPack&&!forestAtlasDebug)try{
    const middleSource=forestMiddlePack??(forestMassPack.middleVertices?{vertices:forestMassPack.middleVertices,indices:forestMassPack.middleIndices,prototypes:forestMassPack.manifest.prototypes}:null);
    if(middleSource){
      const wood=forestMiddleWoodPartition(middleSource.vertices,middleSource.indices,middleSource.prototypes);
      proceduralMiddle={
        vertices:buffer(middleSource.vertices,GPUBufferUsage.VERTEX,'procedural forest middle vertices'),
        indices:buffer(middleSource.indices,GPUBufferUsage.INDEX,'procedural forest middle indices'),
        prototypes:middleSource.prototypes,
        reduced:!!forestMiddlePack,
        woodIndices:buffer(wood.indices,GPUBufferUsage.INDEX,'procedural forest middle wood indices'),
        woodPrototypes:wood.prototypes,
      };
    }
  }catch(error){proceduralMiddle=null;forestMiddleFailure=error.message;}
  const activeForestPack=proceduralPack&&forestPack?retargetForestPackToProcedural(forestPack,proceduralPack,groundSample,{isMobile}):forestPack;
  const activeForestMiddle=forestAtlasDebug?null:(proceduralMiddle??forestMass?.middle??null);
  const forest=activeForestPack?await createForestRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack:activeForestPack,groundSample:proceduralPack?null:groundSample,forestMass,forestMiddle:activeForestMiddle,mode:canopyMode,terrainOcclusion:typeof location!=='undefined'&&new URLSearchParams(location.search).get('forestOcclusion')==='off'?null:{heights,region:activeRegion,near:nearTile}}):null;
  const forestStats=forest?.stats??{loaded:false,mode:canopyMode,error:forestFailure};
  forestStats.mass=forestMass?.stats??{loaded:false,error:forestMassFailure,appearanceErrorSupported:false};
  if(forestStats.mass.middle)forestStats.mass.middle.error=forestMiddleFailure;
  forestStats.replacedProceduralTrees=(canopyTrees.length-trees.length)/8;forestStats.coverage=forestPack?.manifest.coverage??null;
  const canopyStats=importedCanopy?.stats??{loaded:false,mode:canopyMode,error:canopyFailure};
  canopyStats.replacedProceduralTrees=(originalTrees.length-canopyTrees.length)/8;
  canopyStats.coverage=canopyPack?.manifest.coverage??null;
  const canopyInspectionLink=canopyPack&&typeof location!=='undefined'?canopyInspectionURL(location.href,canopyPack.manifest):null;
  // Opaque entry points have no leaf texture in their reachable call graph.
  // Auto layouts therefore correctly omit that binding instead of retaining a
  // dummy sample that would defeat the mobile opaque/feedback separation.
  const opaqueResources=resources.filter(([binding])=>binding!==10);
  const nearResources=[...opaqueResources,[12,{buffer:nearDomain}],[13,nearAlbedo.createView()]];
  const leafResources=resources.filter(([binding])=>binding!==9&&binding!==11);
  const groups=[bind(terrainPipe,nearResources),bind(opaqueTreePipe,nearResources),bind(treePipe,leafResources)];
  const groundGroup=bind(groundPipe,opaqueResources);
  const cloudGroups=[terrainPipe,opaqueTreePipe,treePipe].map(pipe=>clouds.bindVolume(pipe));
  const [submerged,submergedGround]=waterOptics?await Promise.all([
    waterOptics.capture({source:TERRAIN,pipeline:terrainPipe,vertex:{buffers:[meshLayout]},world:'in.world',groups:2}),
    waterOptics.capture({source:TERRAIN,pipeline:groundPipe,vertex:{entryPoint:'groundVS',buffers:treeBuffers},entry:'groundFS',world:'in.world',groups:1}),
  ]):[null,null];
  const submergedGroup=submerged?.bindGroup(nearResources.map(([binding,resource])=>({binding,resource}))),submergedClouds=submerged?clouds.bindVolume(submerged.pipeline):null;
  const submergedGroundGroup=submergedGround?.bindGroup(opaqueResources.map(([binding,resource])=>({binding,resource})));
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}],[7,{buffer:nearDomain}],[8,{buffer:nearElevation}]]);
  const cloudLight=clouds.bindVolume(lightPipe,true);
  let tick=0;

  function regenerateAlbedoMips(){
    const mEnc=device.createCommandEncoder(),mPass=mEnc.beginComputePass();mPass.setPipeline(mipPipe);
    for(let m=1;m<albedoMips;m++){
      mPass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
        {binding:0,resource:albedo.createView({baseMipLevel:m-1,mipLevelCount:1})},
        {binding:1,resource:albedo.createView({baseMipLevel:m,mipLevelCount:1})},
      ]}));
      mPass.dispatchWorkgroups(Math.ceil((activeRegion.albedoSize>>m)/8),Math.ceil((activeRegion.albedoSize>>m)/8));
    }
    mPass.end();device.queue.submit([mEnc.finish()]);
  }

  const baseSnapshot=proceduralPack?{
    region:activeRegion,
    heights:new Float32Array(heights),
    biome:new Uint8Array(biome),
    albedo:proceduralPack.albedo?new Uint8Array(proceduralPack.albedo):null,
    mesh:proceduralPack.mesh,
    portGeometry:proceduralPack.portGeometry,
    vegetation:proceduralPack.vegetation,
    beaches:proceduralPack.beaches,
    views:proceduralPack.views,
    port:proceduralPack.port,
  }:null;

  function applyUpgradedPack(upgradedPack,boat=null,isUpgraded=true){
    if(!proceduralPack||!upgradedPack?.heights||!upgradedPack?.mesh)return false;
    if(upgradedPack.region?.span&&upgradedPack.region.span!==activeRegion.span){
      activeRegion=Object.freeze({...activeRegion,span:upgradedPack.region.span});
      proceduralPack.region=activeRegion;
      device.queue.writeBuffer(uniform,0,new Float32Array([activeRegion.x,activeRegion.z,activeRegion.span,1]));
    }
    if(upgradedPack.views)proceduralPack.views=upgradedPack.views;
    if(upgradedPack.port)proceduralPack.port=upgradedPack.port;
    heights.set(upgradedPack.heights);
    device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
    if(upgradedPack.biome&&upgradedPack.biome.byteLength===biome.byteLength){
      biome.set(upgradedPack.biome);
      device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
    }
    if(upgradedPack.albedo){
      device.queue.writeTexture({texture:albedo},upgradedPack.albedo,{bytesPerRow:activeRegion.albedoSize*4},[activeRegion.albedoSize,activeRegion.albedoSize]);
      regenerateAlbedoMips();
    }
    const oldVerts=vertices,oldIdx=indices,oldSubIdx=submergedIndices!==indices?submergedIndices:null,oldPort=portMesh;
    mesh=upgradedPack.mesh;
    vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices 1550');
    indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices 1550');
    submergedIndices=mesh.submergedIndices?buffer(mesh.submergedIndices,GPUBufferUsage.INDEX,'submerged island indices 1550'):indices;
    submergedCount=mesh.submergedIndices?.length??mesh.indices.length;
    portMesh=upgradedPack.portGeometry?.indices?.length?{
      vertices:buffer(upgradedPack.portGeometry.vertices,GPUBufferUsage.VERTEX,'coastal port prefab vertices 1550'),
      indices:buffer(upgradedPack.portGeometry.indices,GPUBufferUsage.INDEX,'coastal port prefab indices 1550'),
      count:upgradedPack.portGeometry.indices.length,
    }:null;
    oldVerts?.destroy?.();oldIdx?.destroy?.();oldSubIdx?.destroy?.();
    oldPort?.vertices?.destroy?.();oldPort?.indices?.destroy?.();

    groundPatches=createGroundCoverPatches(activeRegion,groundSample,null);
    groundStats.patches=groundPatches.length;
    previousGround.clear();
    lastCamera=null;
    tick=0;

    if(forest&&forestPack){
      const nextForestPack=retargetForestPackToProcedural(forestPack,upgradedPack,groundSample,{isMobile});
      forest.updatePack(nextForestPack,heights,activeRegion);
    }
    if(boat&&Number.isFinite(boat.x)&&Number.isFinite(boat.z)){
      const draft=boat.hydrodynamics?.draft??2.1;
      if(heightSample(boat.x,boat.z)>-draft*1.15){
        const safe=safeLandfallStart(heights,{x:boat.x,z:boat.z,heading:boat.heading??0},boat,activeRegion,heightSample);
        boat.x=safe.x;boat.z=safe.z;
      }
    }
    discovery.applied=Boolean(isUpgraded);
    discovery.status=isUpgraded?'applied':'reverted';
    notifyDiscovery();
    return true;
  }

  const discoveryListeners=new Set();
  const discovery={
    enabled:Boolean(proceduralPack),
    status:proceduralPack?'checking':'none',
    isFirstExplorer:false,
    isCurated1550:Boolean(isKnownSpanishMain),
    applied:false,
    visits:1,
    message:'',
    stats:null,
    upgradedPack:null,
    subscribe(fn){
      discoveryListeners.add(fn);
      fn(discovery);
      return ()=>discoveryListeners.delete(fn);
    },
    swapToUpgraded(boat=null){
      if(!discovery.upgradedPack){
        discovery.upgradedPack=build1550HistoricalTerritoryPack( { ...proceduralPack, heights: baseSnapshot ? baseSnapshot.heights : proceduralPack.heights });
        discovery.stats=discovery.upgradedPack.territory1550;
      }
      return applyUpgradedPack(discovery.upgradedPack,boat,true);
    },
    revertToBase(boat=null){
      if(!baseSnapshot)return false;
      return applyUpgradedPack(baseSnapshot,boat,false);
    },
    toggleUpgraded(boat=null){
      return discovery.applied?discovery.revertToBase(boat):discovery.swapToUpgraded(boat);
    },
  };
  function notifyDiscovery(){
    for(const fn of discoveryListeners){
      try{fn(discovery);}catch{/* ignore UI listener error */}
    }
  }

  if(proceduralPack){
    const forceFirstExplorer=search.get('discover')==='1';
    const autoApply1550=!forceFirstExplorer&&search.get('era')!=='2026';
    setTimeout(()=>{
      runLandfallDiscoveryPipeline({ ...proceduralPack, heights: baseSnapshot.heights },{
        forceFirstExplorer,
        onFirstExplorer(info){
          discovery.status='charting';
          discovery.isFirstExplorer=true;
          discovery.message=`You are the first mariner to sail to ${info.name} (${info.coordLabel}). Reconstructing 1550 historical territory…`;
          notifyDiscovery();
        },
        onProgress(prog){
          discovery.status='charting';
          discovery.message=prog.message;
          notifyDiscovery();
        },
        onUpgradeReady(res){
          discovery.status='ready';
          discovery.isFirstExplorer=!autoApply1550;
          discovery.visits=1;
          discovery.upgradedPack=res.upgradedPack;
          discovery.stats=res.stats;
          discovery.message=`Congratulations on your discovery! The 1550 historical territory for ${res.name} is ready.`;
          if(autoApply1550){
            discovery.swapToUpgraded();
          }else{
            notifyDiscovery();
          }
        },
        onCachedReady(res){
          discovery.status='cached';
          discovery.isFirstExplorer=false;
          discovery.visits=res.visits;
          discovery.upgradedPack=res.upgradedPack;
          discovery.stats=res.stats;
          discovery.message=`1550 historical territory charted · Mariner #${res.visits}`;
          if(autoApply1550){
            discovery.swapToUpgraded();
          }else{
            notifyDiscovery();
          }
        },
      }).catch(()=>{/* non-fatal */});
    },120);
  }

  return {
    waterGroup:pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:elevation.createView()},{binding:2,resource:{buffer:nearDomain}},{binding:3,resource:{buffer:nearElevation}}]}),
    get triangles(){return (mesh.indices.length+(fineMesh?.indices.length??0))/3;},
    get trees(){return trees.length/8+(forest?.stats.roots??0);},
    forestPatches:forestPatches.length,
    farTreeTriangles:treeMeshes[0].map(mesh=>mesh.opaque.count/3),
    lodStats,groundStats,groundTriangles:groundMeshes.map(mesh=>mesh.count/3),canopyStats,forestStats,canopyInspectionURL:canopyInspectionLink,
    prepare:updateTrees,
    setPixelError(next){if(Number.isFinite(next)&&next>0){currentPixelError=next;forestMass?.setPixelError?.(next);forest?.setPixelError?.(next);}},
    nearStats:{loaded:!!nearTile,error:nearFailure,domain:nearTile?.manifest.domain??null,triangles:(fineMesh?.indices.length??0)/3},
    height:heightSample,groundSample,get region(){return activeRegion;},get views(){return proceduralPack?.views??null;},get port(){return proceduralPack?.port??null;},
    discovery,applyUpgradedPack,
    safeStart:(view,boat)=>safeLandfallStart(heights,view,boat,activeRegion,heightSample),
    constrain:(boat,x,z)=>constrainIslandMotion(heights,boat,x,z,heightSample,activeRegion),
    encode(pass,changed=false){
      forestMass?.encode(pass);
      forest?.encode(pass);
      if((tick++%8)!==0&&!changed)return;
      pass.setPipeline(lightPipe);pass.setBindGroup(0,lightGroup);pass.setBindGroup(1,cloudLight);pass.dispatchWorkgroups(8,8);
    },
    drawSubmerged(pass,above=false){
      if(!submerged)return;
      if(above){
        submerged.bind(pass,true);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedClouds);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
        if(fine&&fineMesh.indices.length){pass.setVertexBuffer(0,fine.vertices);pass.setIndexBuffer(fine.indices,'uint32');pass.drawIndexed(fineMesh.indices.length);}
      }else{
        if(!submergedCount&&!fineMesh?.submergedIndices.length)return;
        submerged.bind(pass,false);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedClouds);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(submergedIndices,'uint32');pass.drawIndexed(submergedCount);
        if(fine&&fineMesh.submergedIndices.length){pass.setVertexBuffer(0,fine.vertices);pass.setIndexBuffer(fine.submerged,'uint32');pass.drawIndexed(fineMesh.submergedIndices.length);}
      }
      if(submergedGround){
        submergedGround.bind(pass,above);pass.setBindGroup(0,submergedGroundGroup);
        for(let i=0;i<groundBatches.length;i++)if(groundBatches[i].count){
          pass.setVertexBuffer(0,groundMeshes[i].buffer);pass.setVertexBuffer(1,groundBatches[i].buffer);pass.draw(groundMeshes[i].count,groundBatches[i].count);
        }
      }
    },
    draw(pass,camera={x:0,y:6,z:0},viewProjection=null){
      updateTrees(camera,viewProjection);
      pass.setPipeline(terrainPipe);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,cloudGroups[0]);
      pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
      if(fine&&fineMesh.indices.length){pass.setVertexBuffer(0,fine.vertices);pass.setIndexBuffer(fine.indices,'uint32');pass.drawIndexed(fineMesh.indices.length);}
      if(portMesh){pass.setVertexBuffer(0,portMesh.vertices);pass.setIndexBuffer(portMesh.indices,'uint32');pass.drawIndexed(portMesh.count);}
      // Opaque ground props have no cutout/depth reconstruction and no cloud
      // ray march per blade. They remain in Apple's opaque visibility path.
      pass.setPipeline(groundPipe);pass.setBindGroup(0,groundGroup);
      for(let i=0;i<groundBatches.length;i++)if(groundBatches[i].count){
        pass.setVertexBuffer(0,groundMeshes[i].buffer);pass.setVertexBuffer(1,groundBatches[i].buffer);pass.draw(groundMeshes[i].count,groundBatches[i].count);
      }
      // Draw solid crowns/wood before cutout leaves for Apple hidden-surface
      // removal. The far tier has no alpha foliage or expensive bark fallback.
      for(const[pipe,groupIndex,part]of[[opaqueTreePipe,1,'opaque'],[treePipe,2,'leaves']]){
        // All imported wood/crowns draw before either family's cutout leaves.
        // Opaque terrain and both solid forest paths retain mobile HSR.
        if(part==='opaque'){forestMass?.drawOpaque(pass);importedCanopy?.drawOpaque(pass);forest?.drawOpaque(pass);}
        pass.setPipeline(pipe);pass.setBindGroup(0,groups[groupIndex]);pass.setBindGroup(1,cloudGroups[groupIndex]);
        for(let lod=0;lod<3;lod++)for(let variant=0;variant<TREE_VARIANTS;variant++){
          const batch=treeBatches[lod*TREE_VARIANTS+variant],mesh=treeMeshes[lod][variant][part];if(!batch.count||!mesh.count)continue;
          pass.setVertexBuffer(0,mesh.buffer);pass.setVertexBuffer(1,batch.buffer);pass.draw(mesh.count,batch.count);
        }
      }
      importedCanopy?.drawCutout(pass);
      forest?.drawCutout(pass);
    },
  };
}
