import {seedVegetation} from './vegetation.js';
import {coastalFrame} from './coastal-world.js';
// A selected resident region, not a world texture. Every layer has one metric
// domain; additional river/coastal packs can use this same sampling contract.
export const LAND_REGIONS = Object.freeze({saba:Object.freeze({id:'saba',name:'Saba',latitude:17.635,longitude:-63.238,
  span:8192,size:513,biomeSize:512,albedoSize:1024,x:0,z:-6000,vegetationSeed:47231,vegetationCandidates:360000,
  assets:Object.freeze({height:'assets/world/saba/height.bin',albedo:'assets/world/saba/albedo.png',biome:'assets/world/saba/biome.bin'})})});
export const ISLAND = LAND_REGIONS.saba;
export const LANDFALL_VIEWS = Object.freeze({
  horizon:{x:-1800,z:10500,y:6,yaw:6.2,pitch:1},
  approach:{x:-1100,z:-1400,y:6,yaw:10.4,pitch:6},
  coast:{x:-1750,z:-7000,y:6,yaw:112,pitch:1,heading:112},
});
export function decodeIsland(buffer,region=ISLAND){
  if(buffer.byteLength!==region.size**2*2)throw new Error(`Incomplete ${region.name} elevation pack`);
  const view=new DataView(buffer),heights=new Float32Array(region.size**2);
  for(let i=0;i<heights.length;i++)heights[i]=view.getInt16(i*2,true)/4;
  return heights;
}
export function decodeBiome(buffer,region=ISLAND){
  if(buffer.byteLength!==region.biomeSize**2)throw new Error(`Incomplete ${region.name} vegetation mask`);
  return new Uint8Array(buffer);
}
export function terrainSample(heights,x,z,region=ISLAND){
  const n=region.size,s=(n-1)/region.span;
  const u=(x-region.x+region.span/2)*s,v=(z-region.z+region.span/2)*s;
  if(u<0||v<0||u>=n-1||v>=n-1)return -120;
  const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j,k=j*n+i;
  return (heights[k]*(1-a)+heights[k+1]*a)*(1-b)+(heights[k+n]*(1-a)+heights[k+n+1]*a)*b;
}
// Ground props rest on the rendered triangle, not the bilinear surface between
// four elevations (which can float above a diagonal on steep coastal ground).
export function terrainSurfaceSample(heights,x,z,region=ISLAND){
  const n=region.size,s=(n-1)/region.span,u=(x-region.x+region.span/2)*s,v=(z-region.z+region.span/2)*s;
  if(u<0||v<0||u>=n-1||v>=n-1)return -120;
  const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j,k=j*n+i;
  return a+b<=1?heights[k]+a*(heights[k+1]-heights[k])+b*(heights[k+n]-heights[k]):
    heights[k+n+1]+(1-a)*(heights[k+n]-heights[k+n+1])+(1-b)*(heights[k+1]-heights[k+n+1]);
}
export function islandGeometry(heights,replacedBounds=null){
  const n=ISLAND.size,step=ISLAND.span/(n-1),vertices=new Float32Array(n*n*8),indices=[],submergedIndices=[];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i,h=heights[k],x=ISLAND.x+(i/(n-1)-.5)*ISLAND.span,z=ISLAND.z+(j/(n-1)-.5)*ISLAND.span;
    const dx=(heights[j*n+Math.max(0,i-1)]-heights[j*n+Math.min(n-1,i+1)])/(2*step);
    const dz=(heights[Math.max(0,j-1)*n+i]-heights[Math.min(n-1,j+1)*n+i])/(2*step);
    const length=Math.hypot(dx,1,dz);
    vertices.set([x,h,z,dx/length,1/length,dz/length,0,0],k*8);
    const replaced=replacedBounds&&x>=replacedBounds[0]&&x+step<=replacedBounds[1]&&z>=replacedBounds[2]&&z+step<=replacedBounds[3];
    if(!replaced&&i<n-1&&j<n-1&&Math.max(h,heights[k+1],heights[k+n],heights[k+n+1])>-.5){
      indices.push(k,k+n,k+1,k+1,k+n,k+n+1);
    }
    if(!replaced&&i<n-1&&j<n-1&&Math.min(h,heights[k+1],heights[k+n],heights[k+n+1])<0&&Math.max(h,heights[k+1],heights[k+n],heights[k+n+1])>-45){
      submergedIndices.push(k,k+n,k+1,k+1,k+n,k+n+1);
    }
  }
  return {vertices,indices:new Uint32Array(indices),submergedIndices:new Uint32Array(submergedIndices)};
}
export function islandVegetation(heights,mask,region=ISLAND){
  return seedVegetation(region,(x,z)=>terrainSample(heights,x,z,region),mask);
}
export function islandCoordinates(x,z,region=ISLAND){
  return {latitude:region.latitude-(z-region.z)/111195,
    longitude:region.longitude+(x-region.x)/(111195*Math.cos(region.latitude*Math.PI/180))};
}
// Conservative hull envelope against an elevation-derived coastal skirt for safe spawn placement.
function islandHullClearance(heights,boat,x,z,region=ISLAND,sample=null){
  const radius=Math.hypot(boat.length,boat.beam)*.5+8;
  const threshold=-Math.max(3,(boat.hydrodynamics?.draft??2)+1);
  for(let k=0;k<9;k++){
    const a=k*Math.PI/4,r=k===8?0:radius;
    if((sample?sample(x+Math.cos(a)*r,z+Math.sin(a)*r):terrainSample(heights,x+Math.cos(a)*r,z+Math.sin(a)*r,region))>threshold)return false;
  }
  return true;
}
export const GROUNDING_SUBSTRATES = Object.freeze({
  stone: Object.freeze({
    id: 'stone',
    substrate: 'stone',
    label: 'coastal rocks & stone ledge',
    hardness: 1.35,
    safeTouchSpeed: 0.18,
    breachSpeedThreshold: 0.85,
    damageMultiplier: 1.65,
    breachMultiplier: 1.60,
    wavePoundMultiplier: 1.50,
    friction: 0.22,
  }),
  reef: Object.freeze({
    id: 'reef',
    substrate: 'reef',
    label: 'coral reef & limestone ledge',
    hardness: 1.10,
    safeTouchSpeed: 0.26,
    breachSpeedThreshold: 1.05,
    damageMultiplier: 1.32,
    breachMultiplier: 1.45,
    wavePoundMultiplier: 1.25,
    friction: 0.18,
  }),
  shoal: Object.freeze({
    id: 'shoal',
    substrate: 'shoal',
    label: 'shallow shoal & river bar',
    hardness: 0.65,
    safeTouchSpeed: 0.52,
    breachSpeedThreshold: 1.85,
    damageMultiplier: 0.72,
    breachMultiplier: 0.75,
    wavePoundMultiplier: 0.65,
    friction: 0.12,
  }),
  sand: Object.freeze({
    id: 'sand',
    substrate: 'sand',
    label: 'sandy beach & foreshore',
    hardness: 0.30,
    safeTouchSpeed: 1.05,
    breachSpeedThreshold: 3.10,
    damageMultiplier: 0.32,
    breachMultiplier: 0.35,
    wavePoundMultiplier: 0.28,
    friction: 0.08,
  }),
});

let defaultGroundingDamageHandler = null;
export function setGroundingDamageHandler(fn) {
  defaultGroundingDamageHandler = typeof fn === 'function' ? fn : null;
}

export function classifyGroundingSubstrate(arg0, arg1, arg2 = {}, arg3 = null, arg4 = null) {
  let x, z, opts;
  if (typeof arg0 === 'function') {
    x = arg1;
    z = arg2;
    opts = { ...(arg4 || {}), sample: arg0, region: arg3 ?? arg4?.region ?? ISLAND };
  } else {
    x = arg0;
    z = arg1;
    opts = arg2 || {};
  }
  const {
    heights = null,
    region = ISLAND,
    sample = null,
    beaches = null,
    ports = null,
    substrate = null,
    hitStructure = null,
  } = opts;
  if (substrate && Object.hasOwn(GROUNDING_SUBSTRATES, substrate)) {
    return GROUNDING_SUBSTRATES[substrate];
  }
  if (hitStructure) {
    const pid = hitStructure.prefabId ?? '';
    if (pid === 'stone_sea_bastion' || pid === 'bastion_trace_fortress' || pid === 'stone_quay_seawall') {
      return GROUNDING_SUBSTRATES.stone;
    }
    return GROUNDING_SUBSTRATES.shoal;
  }
  if (Array.isArray(ports)) {
    for (const port of ports) {
      const instances = port?.instances;
      if (!Array.isArray(instances) || !instances.length) continue;
      if (port.center && (port.clearRadius ?? 0) > 0) {
        const pRad = port.clearRadius + 140;
        if (Math.abs(x - (port.center.x ?? 0)) > pRad || Math.abs(z - (port.center.z ?? 0)) > pRad) continue;
      }
      for (const inst of instances) {
        const baseY = inst.baseY ?? inst.y ?? 0;
        const foundDepth = inst.foundationDepth ?? 4.5;
        if (baseY - foundDepth > 0.8) continue;
        const dx = x - inst.x, dz = z - inst.z;
        const hw = (inst.width ?? 12) * 0.5 + 1.2;
        const hl = (inst.depth ?? inst.length ?? 20) * 0.5 + 1.2;
        const maxR = hw + hl;
        if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) continue;
        const cosY = Math.cos(inst.yaw ?? 0), sinY = Math.sin(inst.yaw ?? 0);
        const lx = dx * cosY - dz * sinY;
        const lz = dx * sinY + dz * cosY;
        if (Math.abs(lx) <= hw && Math.abs(lz) <= hl) {
          const pid = inst.prefabId ?? '';
          if (pid === 'stone_sea_bastion' || pid === 'bastion_trace_fortress' || pid === 'stone_quay_seawall') {
            return GROUNDING_SUBSTRATES.stone;
          }
          return GROUNDING_SUBSTRATES.shoal;
        }
      }
    }
  }

  const evalH = sample
    ? (px, pz) => sample(px, pz)
    : heights
      ? (px, pz) => terrainSample(heights, px, pz, region)
      : () => -10;
  const h = evalH(x, z);
  const sx = (evalH(x + 6, z) - evalH(x - 6, z)) / 12;
  const sz = (evalH(x, z + 6) - evalH(x, z - 6)) / 12;
  const slope = Math.hypot(sx, sz);
  const roughness = Math.abs(evalH(x + 5, z) + evalH(x - 5, z) + evalH(x, z + 5) + evalH(x, z - 5) - 4 * h);

  // Check explicit beach swash / dry-sand mask or beach array if available
  let isBeachSand = false;
  if (beaches?.swashMask && region?.biomeSize && region?.span) {
    const m = region.biomeSize;
    const u = Math.floor(((x - (region.x ?? 0)) / region.span + 0.5) * m);
    const v = Math.floor(((z - (region.z ?? 0)) / region.span + 0.5) * m);
    if (u >= 0 && u < m && v >= 0 && v < m) {
      const idx = v * m + u;
      if ((beaches.swashMask[idx] ?? 0) >= 48 || (beaches.drySandMask?.[idx] ?? 0) >= 48) {
        isBeachSand = true;
      }
    }
  } else if (Array.isArray(beaches)) {
    for (const b of beaches) {
      if (!b) continue;
      const r = Math.max(40, (b.length ?? 80) * 0.75);
      if (Math.hypot(x - (b.x ?? 0), z - (b.z ?? 0)) <= r) {
        isBeachSand = true;
        break;
      }
    }
  }

  const isVolcanic = region?.id === 'saba' || region?.coastalArchetype === 'volcanic-island';
  const hasEstuary =
    region?.coastalArchetype === 'river-mouth' ||
    region?.coastalArchetype === 'estuary-bay' ||
    region?.coastalClass === 'river-port' ||
    region?.coastalClass === 'river-gorge' ||
    Boolean(region?.hasRiver);
  const frame = Number.isFinite(region?.shoreBearing) ? coastalFrame(region, x, z) : null;
  const along = frame ? frame.along : 0;
  const inland = frame ? frame.inland : 0;

  // 1. River & estuary gorge banks: steep outer bends or rocky ledges are solid rock/stone
  if (hasEstuary && (inland > 0 || !frame) && h < 4.5) {
    if (slope >= 0.085 || roughness >= 0.25) return GROUNDING_SUBSTRATES.stone;
    if (!isBeachSand) return GROUNDING_SUBSTRATES.shoal;
  }

  // 2. Volcanic cliffs, rocky headlands, Morro promontory, or steep rocky shores
  if (
    slope >= 0.13 ||
    (isVolcanic && slope >= 0.085) ||
    (frame && Math.abs(along) > 560 && slope >= 0.08) ||
    (frame && Math.abs(along - 115) < 80 && slope >= 0.075 && !isBeachSand)
  ) {
    return GROUNDING_SUBSTRATES.stone;
  }

  // 3. Submerged coral reefs & jagged limestone ledges
  if (
    h <= 0.45 &&
    !isBeachSand &&
    (roughness >= 0.16 ||
      Boolean(region?.reefBarrier) ||
      region?.coastalClass === 'coral-archipelago' ||
      (h <= -0.30 && slope >= 0.068 && (!frame || Math.abs(along) > 150)))
  ) {
    return GROUNDING_SUBSTRATES.reef;
  }

  // 4. Gentle sandy beaches & swash zone
  if (isBeachSand || (!hasEstuary && h >= -0.85 && h <= 2.6 && slope < 0.058 && (!frame || Math.abs(along) <= 480))) {
    return GROUNDING_SUBSTRATES.sand;
  }

  return GROUNDING_SUBSTRATES.shoal;
}

export function probeHullBottomContact(heights, boat, x, z, region = ISLAND, sample = null, options = null) {
  const evalH = sample
    ? (px, pz) => sample(px, pz)
    : heights
      ? (px, pz) => terrainSample(heights, px, pz, region)
      : () => -20;
  const L = Math.max(4, boat.length ?? 20), B = Math.max(1.5, boat.beam ?? 6);
  const hRad = ((boat.heading ?? 0) * Math.PI) / 180;
  const sinH = Math.sin(hRad), cosH = Math.cos(hRad);
  const bowD = L * 0.40, beamD = B * 0.42;
  // Stations in (wx, wz, localX, localZ, stationName) where localZ < 0 is bow, localX > 0 is starboard
  const pts = [
    [x, z, 0, 0, 'keel'],
    [x + sinH * bowD, z - cosH * bowD, 0, -bowD, 'bow'],
    [x - sinH * bowD, z + cosH * bowD, 0, bowD, 'stern'],
    [x + cosH * beamD, z + sinH * beamD, beamD, 0, 'starboard-bilge'],
    [x - cosH * beamD, z - sinH * beamD, -beamD, 0, 'port-bilge'],
    [x + sinH * bowD * 0.6 + cosH * beamD * 0.7, z - cosH * bowD * 0.6 + sinH * beamD * 0.7, beamD * 0.7, -bowD * 0.6, 'starboard-bow'],
    [x + sinH * bowD * 0.6 - cosH * beamD * 0.7, z - cosH * bowD * 0.6 - sinH * beamD * 0.7, -beamD * 0.7, -bowD * 0.6, 'port-bow'],
  ];

  let worstBed = -Infinity;
  let bestIdx = 0;
  let hitStructure = null;
  const rawPorts = options?.ports ?? null;
  let nearPorts = null;
  if (Array.isArray(rawPorts)) {
    for (let p = 0; p < rawPorts.length; p++) {
      const port = rawPorts[p];
      if (!Array.isArray(port?.instances) || !port.instances.length) continue;
      if (port.center && (port.clearRadius ?? 0) > 0) {
        const pRad = port.clearRadius + L + 140;
        if (Math.abs(x - (port.center.x ?? 0)) > pRad || Math.abs(z - (port.center.z ?? 0)) > pRad) continue;
      }
      if (!nearPorts) nearPorts = [];
      nearPorts.push(port);
    }
  }

  for (let i = 0; i < pts.length; i++) {
    const px = pts[i][0], pz = pts[i][1];
    let h = evalH(px, pz);
    let ptStruct = null;
    if (nearPorts) {
      for (const port of nearPorts) {
        const instances = port.instances;
        for (const inst of instances) {
          const baseY = inst.baseY ?? inst.y ?? 0;
          const foundDepth = inst.foundationDepth ?? 4.5;
          if (baseY - foundDepth > 0.5) continue;
          const dx = px - inst.x, dz = pz - inst.z;
          const hw = (inst.width ?? 12) * 0.5;
          const hl = (inst.depth ?? inst.length ?? 20) * 0.5;
          const maxR = hw + hl;
          if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) continue;
          const cosY = Math.cos(inst.yaw ?? 0), sinY = Math.sin(inst.yaw ?? 0);
          const lx = dx * cosY - dz * sinY;
          const lz = dx * sinY + dz * cosY;
          if (Math.abs(lx) <= hw && Math.abs(lz) <= hl) {
            const structTop = Math.max(h, Math.min(2.5, baseY));
            if (structTop > h) {
              h = structTop;
              ptStruct = inst;
            }
          }
        }
      }
    }
    if (h > worstBed) {
      worstBed = h;
      bestIdx = i;
      hitStructure = ptStruct;
    }
  }
  const chosen = pts[bestIdx];
  return {
    worstBed,
    position: [chosen[0], worstBed, chosen[1]],
    localPosition: [chosen[2], -(boat.hydrodynamics?.draft ?? 2) * 0.85, chosen[3]],
    station: chosen[4],
    hitStructure,
  };
}

function hullWorstBedHeight(heights,boat,x,z,region=ISLAND,sample=null,options=null){
  return probeHullBottomContact(heights,boat,x,z,region,sample,options).worstBed;
}
// Camera presets were authored for the shallow-draft caravel. Keep valid starts
// exact, but move a deeper/larger hull offshore before its first simulation step.
// The broad elevation-derived shelf can exceed 500m; search the entire resident
// region, using the same footprint/depth margin as the movement constraint.
export function safeLandfallStart(heights,view,boat,region=ISLAND,sample=null){
  const result=(x,z)=>({...view,x,z,moved:x!==view.x||z!==view.z,depth:-(sample?sample(x,z):terrainSample(heights,x,z,region))});
  if(islandHullClearance(heights,boat,view.x,view.z,region,sample))return result(view.x,view.z);
  const dx=view.x-region.x,dz=view.z-region.z,distance=Math.hypot(dx,dz);
  const ux=distance?dx/distance:1,uz=distance?dz/distance:0;
  const limit=region.span*2+Math.hypot(boat.length,boat.beam);
  const hasCoastalBearing=Number.isFinite(region?.shoreBearing)&&region!==ISLAND;
  const hRad=((view.heading??region?.shoreBearing??0)*Math.PI)/180;
  const fwdX=Math.sin(hRad),fwdZ=-Math.cos(hRad);
  const hasForwardRoom=(x,z)=>!hasCoastalBearing||islandHullClearance(heights,boat,x+fwdX*60,z+fwdZ*60,region,sample);
  let firstValid=null;
  if(hasCoastalBearing){
    const sbRad=(region.shoreBearing*Math.PI)/180;
    const offX=-Math.sin(sbRad),offZ=Math.cos(sbRad);
    for(let d=16;d<=limit;d+=16){
      const x=view.x+offX*d,z=view.z+offZ*d;
      if(islandHullClearance(heights,boat,x,z,region,sample)){
        if(!firstValid)firstValid={x,z};
        if(hasForwardRoom(x,z))return result(x,z);
      }
    }
  }
  for(let d=50;d<=limit;d+=50){
    const x=view.x+ux*d,z=view.z+uz*d;
    if(islandHullClearance(heights,boat,x,z,region,sample)){
      if(!firstValid)firstValid={x,z};
      if(hasForwardRoom(x,z))return result(x,z);
    }
  }
  if(firstValid)return result(firstValid.x,firstValid.z);
  throw new RangeError('No landfall start clears this vessel draft and hull envelope');
}
export function constrainIslandMotion(heights,boat,previousX,previousZ,sample=null,region=ISLAND,options=null){
  const dx=boat.x-previousX,dz=boat.z-previousZ,distance=Math.hypot(dx,dz);
  const draft=boat.hydrodynamics?.draft??2;
  const groundingThreshold=-Math.min(2.4,Math.max(1.15,draft*0.34));
  const shoalThreshold=-Math.max(2.6,draft*0.85);
  const prevBed=hullWorstBedHeight(heights,boat,previousX,previousZ,region,sample,options);
  const preSurge=Number.isFinite(boat.surgeVelocity)?boat.surgeVelocity:0;
  const preLeeway=Number.isFinite(boat.leewayVelocity)?boat.leewayVelocity:0;
  const stepImpactSpeed=distance>1e-4?Math.max(Math.hypot(preSurge,preLeeway),Math.min(12,distance*2)):Math.hypot(preSurge,preLeeway);
  const wasAground=Boolean(boat.aground);
  const steps=Math.max(1,Math.ceil(distance/6));
  for(let step=1;step<=steps;step++){
    const t=step/steps,x=previousX+dx*t,z=previousZ+dz*t;
    const probe=probeHullBottomContact(heights,boat,x,z,region,sample,options);
    const bed=probe.worstBed;
    if(bed>groundingThreshold){
      // Allow a vessel that is already on a shoal to back or turn off toward deeper water
      if(distance>1e-5&&prevBed>groundingThreshold&&bed<prevBed-1e-4){
        boat.aground=bed>groundingThreshold;
        continue;
      }
      const safe=(step-1)/steps;
      boat.x=previousX+dx*safe;boat.z=previousZ+dz*safe;
      boat.surgeVelocity=0;boat.leewayVelocity=0;boat.leewayDistance=0;
      boat.aground=true;
      const evalH=sample?(px,pz)=>sample(px,pz):(px,pz)=>terrainSample(heights,px,pz,region);
      const hRad=((boat.heading??0)*Math.PI)/180;
      const rightX=Math.cos(hRad),rightZ=Math.sin(hRad);
      const fwdX=Math.sin(hRad),fwdZ=-Math.cos(hRad);
      const slopeSide=(evalH(boat.x+rightX*4,boat.z+rightZ*4)-evalH(boat.x-rightX*4,boat.z-rightZ*4))/8;
      const slopeFwd=(evalH(boat.x+fwdX*6,boat.z+fwdZ*6)-evalH(boat.x-fwdX*6,boat.z-fwdZ*6))/12;
      boat.groundingRoll=Math.max(-0.22,Math.min(0.22,-slopeSide*0.45));
      boat.groundingPitch=Math.max(-0.12,Math.min(0.12,slopeFwd*0.35));

      const subInfo=classifyGroundingSubstrate(probe.position[0],probe.position[2],{
        heights,
        region,
        sample,
        beaches:options?.beaches??null,
        ports:options?.ports??null,
        substrate:options?.substrate??boat.groundingSubstrateOverride??null,
        hitStructure:probe.hitStructure,
      });
      const gradX=(evalH(probe.position[0]+4,probe.position[2])-evalH(probe.position[0]-4,probe.position[2]))/8;
      const gradZ=(evalH(probe.position[0],probe.position[2]+4)-evalH(probe.position[0],probe.position[2]-4))/8;
      const gLen=Math.hypot(gradX,1,gradZ)||1;
      const contact={
        type:'grounding',
        substrate:subInfo.id,
        substrateLabel:subInfo.label,
        substrateInfo:subInfo,
        position:probe.position,
        localPosition:probe.localPosition,
        normal:[-gradX/gLen,1/gLen,-gradZ/gLen],
        station:probe.station,
        hitStructure:probe.hitStructure,
        bedElevation:bed,
        draft,
        penetration:Math.max(0.05,bed-groundingThreshold),
        impactSpeed:stepImpactSpeed,
        preSurgeVelocity:preSurge,
        preLeewayVelocity:preLeeway,
        freshImpact:!wasAground||stepImpactSpeed>0.4,
      };
      boat.groundingContact=contact;
      const handler=options?.onGroundingDamage??defaultGroundingDamageHandler;
      if(typeof handler==='function'&&contact.freshImpact){
        const rep=handler(boat,contact,options);
        if(rep&&typeof options?.onGrounding==='function'){
          options.onGrounding(boat,contact,rep);
        }
      }
      return true;
    }
    if(bed>shoalThreshold){
      const scrape=Math.max(0,Math.min(1,(bed-shoalThreshold)/(groundingThreshold-shoalThreshold)));
      const subInfo=classifyGroundingSubstrate(probe.position[0],probe.position[2],{
        heights,
        region,
        sample,
        beaches:options?.beaches??null,
        ports:options?.ports??null,
        substrate:options?.substrate??boat.groundingSubstrateOverride??null,
        hitStructure:probe.hitStructure,
      });
      const dragFactor=subInfo.friction??0.08;
      if(typeof boat.surgeVelocity==='number')boat.surgeVelocity*=(1-scrape*dragFactor);
      if(typeof boat.leewayVelocity==='number')boat.leewayVelocity*=(1-scrape*dragFactor);
      boat.shoalScraping=scrape>0.05;
      if(boat.shoalScraping&&step===steps){
        const contact={
          type:'shoal-scrape',
          substrate:subInfo.id,
          substrateLabel:subInfo.label,
          substrateInfo:subInfo,
          position:probe.position,
          localPosition:probe.localPosition,
          normal:[0,1,0],
          station:probe.station,
          bedElevation:bed,
          draft,
          scrapeSeverity:scrape,
          impactSpeed:stepImpactSpeed,
          preSurgeVelocity:preSurge,
          preLeewayVelocity:preLeeway,
          freshImpact:true,
        };
        boat.groundingContact=contact;
        const handler=options?.onGroundingDamage??defaultGroundingDamageHandler;
        if(typeof handler==='function'&&stepImpactSpeed>subInfo.safeTouchSpeed){
          const rep=handler(boat,contact,options);
          if(rep&&typeof options?.onGrounding==='function'){
            options.onGrounding(boat,contact,rep);
          }
        }
      }
    }else{
      boat.shoalScraping=false;
    }
  }
  boat.aground=false;
  if(!boat.shoalScraping)boat.groundingContact=null;
  if(boat.groundingRoll)boat.groundingRoll*=0.9;
  if(boat.groundingPitch)boat.groundingPitch*=0.9;
  return false;
}
export { SPANISH_MAIN_1550_REGIONS, COLONIAL_ERAS, resolveColonialEra, HISTORICAL_1550_PORTS, HISTORICAL_COLONIAL_PORTS, findHistoricalColonialPort, hasHistorical1550ColonialPort, computeColonyGrowthProfile, PORT_PREFABS, COCONUT_PALM_GENOME_SPEC, coastalUberNoise2D, coastalFrame, resolveGlobalCoastalRegion, classifyKoppenClimateFromNormals, estimateLocalClimateProfile, fetchPublicClimateProfile, synthesizeCoastalTerrain, synthesizeCoastalBeaches, synthesizeCoastalBiome, synthesizeCoastalAlbedo, placeCoastalPort, portClearanceEnvelope, buildPortPrefabGeometry, seedCoastalVegetation, generateProceduralCoastalPack, upgradeProceduralPackWithRealDEM } from './coastal-world.js';
