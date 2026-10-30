// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {NINA_DESIGN} from './models/nina.js';
import {VICTORY_DESIGN,victorySheer,victoryHullHalfWidth,victoryVesselDeck} from './models/victory.js';
import {deckHalfWidth,vesselVerticalScale} from './hull.js';
import {boatRotate,boatForwardSpeed} from './boat.js';
import {deepFreeze} from './rig-definition.js';
import {ADDITIONAL_DESIGNS} from './models/additional.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {LATER_SAIL_DESIGNS} from './models/later-sail.js';
import {additionalGunAttachments} from './additional-rig.js';

// Attachments are authored in exactly the same design frame as the mesh. Gun
// id order follows the legacy geometry traversal, independent of crew or state.
function gunneryNinaDefinitions(){
  const result=[];
  for(const sign of[-1,1])for(const z of[3.25,4.9]){
    const x=sign*(deckHalfWidth(z)+.065),floor=NINA_DESIGN.quarterdeck.height,y=floor+.61;
    result.push({id:result.length,side:sign<0?'port':'starboard',sideSign:sign,deck:'quarter',
      meshGroup:`gun:${sign}:${z}`,muzzleDesign:[x+sign*.49,y+.025,z],breechDesign:[x-sign*.24,y,z],directionDesign:[sign*.73,.025,0],
      station:[x-sign*.36,floor,z],floorDesign:floor,visibleCrew:true,weatherDeck:true,
      calibre:2,type:'swivel',kind:'swivel',recoilLength:.09,recoilDuration:.45,breechMass:180});
  }
  return result;
}
function gunneryVictoryDefinitions(){
  const result=[],batteries=VICTORY_DESIGN.gunDecks.filter(g=>['lower','middle','upper'].includes(g.id));
  const ports=batteries.flatMap(g=>Array.from({length:g.count/2},(_,i)=>({deck:g.id,y:g.centre,z:g.start+(g.end-g.start)*i/(g.count/2-1),calibre:g.calibre})));
  for(const sign of[-1,1])for(const[index,p]of ports.entries()){
    const y=p.y+victorySheer(p.z),x=sign*victoryHullHalfWidth(p.z,y),floor=y-.21;
    result.push({id:result.length,side:sign<0?'port':'starboard',sideSign:sign,deck:p.deck,
      meshGroup:`gun.${p.deck}.${sign<0?'port':'starboard'}.${index}`,muzzleDesign:[x+sign*.195,y,p.z],breechDesign:[x-sign*.24,y,p.z],directionDesign:[sign,0,0],
      station:[x-sign*.50,floor,p.z],floorDesign:floor,visibleCrew:false,weatherDeck:false,
      calibre:p.calibre,type:'long-gun',kind:'long-gun',recoilLength:1.1});
  }
  for(const g of VICTORY_DESIGN.gunDecks.filter(g=>!batteries.includes(g)))for(const sign of[-1,1])for(let i=0;i<g.count/2;i++){
    const z=g.start+(g.end-g.start)*i/(g.count/2-1),floor=victoryVesselDeck(z),y=g.centre+victorySheer(z);
    const x=sign*(victoryHullHalfWidth(z,y)-.07),carronade=g.id==='forecastle'&&i===0;
    result.push({id:result.length,side:sign<0?'port':'starboard',sideSign:sign,deck:g.id,
      meshGroup:`gun.${g.id}.${sign<0?'port':'starboard'}.${i}`,muzzleDesign:[x+sign*(carronade?.21:.30),y,z],breechDesign:[x-sign*.15,y,z],directionDesign:[sign,0,0],
      station:[x-sign*.50,floor,z],floorDesign:floor,visibleCrew:true,weatherDeck:true,
      calibre:carronade?68:g.calibre,type:carronade?'carronade':'long-gun',kind:carronade?'carronade':'long-gun',
      recoilLength:carronade?.65:1.0,recoilDuration:.85});
  }
  return result;
}
const GUNNERY_MODEL_GUNS=deepFreeze({nina:gunneryNinaDefinitions(),victory:gunneryVictoryDefinitions(),
  ...Object.fromEntries(Object.keys(ADDITIONAL_DESIGNS).map(id=>[id,additionalGunAttachments(id)])),
  ...Object.fromEntries(Object.keys({...ROWING_DESIGNS,...LATER_SAIL_DESIGNS}).map(id=>[id,[]]))});
function buildFallbackRailBroadside(stations,{calibre=2,kind='swivel',type='swivel',y=0.52,floor=0.12,xHalf=1.42,recoilLength=0.08,recoilDuration=0.45,breechMass=180}={}){
  const result=[];
  for(const sign of[-1,1])for(const [i,z]of stations.entries()){
    const x=sign*xHalf;
    result.push({id:result.length,side:sign<0?'port':'starboard',sideSign:sign,deck:'weather',
      meshGroup:`battle.gun.${sign<0?'port':'starboard'}.${i}`,muzzleDesign:[x+sign*.28,y+.02,z],breechDesign:[x-sign*.18,y,z],directionDesign:[sign,0,0],
      station:[x-sign*.36,floor,z],floorDesign:floor,visibleCrew:false,weatherDeck:true,
      calibre,type,kind,recoilLength,recoilDuration,breechMass});
  }
  return result;
}
const NAVAL_BATTLE_FALLBACK_GUNS=deepFreeze({
  'flying-cloud':buildFallbackRailBroadside([-3.2,-1.1,1.1,3.2],{calibre:9,kind:'long-gun',type:'long-gun',y:0.86,floor:0.32,xHalf:1.48,recoilLength:0.55,recoilDuration:0.65,breechMass:820}),
  oseberg:buildFallbackRailBroadside([-2.2,2.2],{calibre:2,kind:'swivel',type:'swivel',y:0.52,floor:0.12,xHalf:1.45}),
  lusoria:buildFallbackRailBroadside([-2.4,2.4],{calibre:2,kind:'swivel',type:'swivel',y:0.48,floor:0.10,xHalf:1.38}),
  'taino-canoe':buildFallbackRailBroadside([0.0],{calibre:1,kind:'swivel',type:'swivel',y:0.35,floor:0.05,xHalf:1.15,recoilLength:0.06,recoilDuration:0.40,breechMass:120}),
  'gipsy-moth-iv':buildFallbackRailBroadside([1.4],{calibre:2,kind:'swivel',type:'swivel',y:0.62,floor:0.18,xHalf:1.42}),
});
export function createGunDefinitions(boatOrModelId='nina'){
  const id=typeof boatOrModelId==='string'?boatOrModelId:boatOrModelId.modelId??'nina';
  if(!GUNNERY_MODEL_GUNS[id])throw new Error('No playable gun attachments for '+id);
  return GUNNERY_MODEL_GUNS[id];
}
export function createNavalBattleGunDefinitions(boatOrModelId='nina'){
  const id=typeof boatOrModelId==='string'?boatOrModelId:(boatOrModelId?.model?.id??boatOrModelId?.modelId??'nina');
  const canonical=createGunDefinitions(id);
  if(canonical.length>0)return canonical;
  return NAVAL_BATTLE_FALLBACK_GUNS[id]??GUNNERY_MODEL_GUNS.nina;
}
export function gunElevationRange(gun){
  return gun?.kind==='swivel'?{min:-6,max:14}:{min:-4,max:10};
}
export function gunTraverseRange(gun){
  return gun?.kind==='swivel'?{min:-45,max:45}:{min:-8,max:8};
}
function defaultModelRuntime(boat){
  const id=boat?.model?.id??boat?.modelId??'nina';
  return boat?.model?.runtime??ADDITIONAL_DESIGNS[id]?.runtime??ROWING_DESIGNS[id]?.runtime??LATER_SAIL_DESIGNS[id]?.runtime??(id==='victory'?VICTORY_DESIGN.runtime:NINA_DESIGN.runtime);
}
export function gunModelScale(boat){const rt=defaultModelRuntime(boat);return[(boat.beam??rt.beam)/3.6,
  vesselVerticalScale(boat),(boat.length??rt.length)/12];}
export function gunModelDirection(gun,scale,elevationDegrees=0,traverseDegrees=0){
  const d=gun.directionDesign.map((v,i)=>v*scale[i]),n=Math.hypot(...d),base=d.map(v=>v/n);
  const hasElev=Number.isFinite(elevationDegrees)&&Math.abs(elevationDegrees)>=1e-12;
  const hasTrav=Number.isFinite(traverseDegrees)&&Math.abs(traverseDegrees)>=1e-12;
  if(!hasElev&&!hasTrav)return base;
  const range=gunElevationRange(gun),elev=hasElev?Math.max(range.min,Math.min(range.max,elevationDegrees))*Math.PI/180:0;
  const tRange=gunTraverseRange(gun),trav=hasTrav?Math.max(tRange.min,Math.min(tRange.max,traverseDegrees))*Math.PI/180:0;
  const h=Math.hypot(base[0],base[2]);if(h<1e-9)return base;
  const angle=Math.atan2(base[1],h)+elev;
  const cosA=Math.cos(angle),sinA=Math.sin(angle);
  let hx=base[0]/h,hz=base[2]/h;
  if(hasTrav){
    // Positive traverse trains the muzzle forward toward the bow (-Z in local ship space);
    // negative traverse trains the muzzle aft toward the stern (+Z in local ship space).
    const sideSign=(gun.sideSign??(base[0]<0?-1:1))<0?-1:1;
    const ct=Math.cos(trav),st=Math.sin(trav);
    const nx=hx*ct+sideSign*hz*st;
    const nz=-sideSign*hx*st+hz*ct;
    hx=nx;hz=nz;
  }
  return [hx*cosA,sinA,hz*cosA];
}

// Matches boatRotate's R_heading R_pitch R_roll order. Its compass heading
// rotates about -worldY, so yaw angular velocity carries the corresponding sign.
// Translational velocity is physical sailing speed/leeway, never compressed
// voyage-coordinate speed. Point velocity includes omega cross muzzle offset.
export function gunMuzzlePose(gun,boat){
  const scale=gunModelScale(boat);
  const elevation=Number.isFinite(gun.elevation)?gun.elevation:Number.isFinite(boat?.gunneryElevation)?boat.gunneryElevation:0;
  const traverse=Number.isFinite(gun.traverse)?gun.traverse:Number.isFinite(boat?.gunneryTraverse)?boat.gunneryTraverse:0;
  const baseDirection=gunModelDirection(gun,scale,0,0);
  const localDirection=(elevation||traverse)?gunModelDirection(gun,scale,elevation,traverse):baseDirection;
  const offset=Math.max(0,Number.isFinite(gun.offset)?gun.offset:0);
  let localPosition=gun.muzzleDesign.map((v,i)=>v*scale[i]-baseDirection[i]*offset);
  if(traverse&&gun.breechDesign){
    // Swivel pintle / carriage trunnion pivot in scaled local metres
    const pivot=gun.breechDesign.map((b,i)=>(b*0.65+gun.muzzleDesign[i]*0.35)*scale[i]);
    const armLen=Math.max(0.15,Math.hypot(
      gun.muzzleDesign[0]*scale[0]-pivot[0],
      gun.muzzleDesign[1]*scale[1]-pivot[1],
      gun.muzzleDesign[2]*scale[2]-pivot[2],
    )-offset);
    localPosition=[
      pivot[0]+localDirection[0]*armLen,
      pivot[1]+localDirection[1]*armLen,
      pivot[2]+localDirection[2]*armLen,
    ];
  }
  const direction=[0,0,0],r=[0,0,0];
  const heading=(boat.heading??0)*Math.PI/180,pitch=boat.pitch??0,roll=boat.roll??0;
  boatRotate(r,...localPosition,heading,pitch,roll);boatRotate(direction,...localDirection,heading,pitch,roll);
  const ch=Math.cos(heading),sh=Math.sin(heading),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const pitchRate=boat.pitchVelocity??0,rollRate=boat.rollVelocity??0,yawRate=boat.yawRate??0;
  const omega=[pitchRate*ch-rollRate*sh*cp,-yawRate-rollRate*sp,pitchRate*sh+rollRate*ch*cp];
  const forward=boatForwardSpeed(boat),surge=Number.isFinite(forward)?forward:0,leeway=boat.leewayVelocity??0;
  const velocity=[surge*sh+leeway*ch+omega[1]*r[2]-omega[2]*r[1],
    (boat.heaveVelocity??0)+omega[2]*r[0]-omega[0]*r[2],
    -surge*ch+leeway*sh+omega[0]*r[1]-omega[1]*r[0]];
  return {position:[r[0]+(boat.x??0),r[1]+(boat.heave??0),r[2]+(boat.z??0)],direction,velocity,localPosition};
}

// Canonical groups address raw triangle vertices; indexing preserves that index
// order. Build a compact immutable rest-position map. Reject any deduplicated
// vertex shared with fixed geometry, rather than moving a gunport with its gun.
export function createGunRecoilMap(asset){
  const groups=asset.groups.filter(g=>g.motion?.type==='gun-recoil'),indexOwner=new Int32Array(asset.indices.length);indexOwner.fill(-1);
  const vertexOwner=new Map(),guns=[];
  for(const g of groups){
    const gunId=g.motion.gunId,vertices=new Set();
    for(let i=g.firstVertex;i<g.firstVertex+g.vertexCount;i++){
      const index=asset.indices[i];indexOwner[i]=gunId;
      if(vertexOwner.has(index)&&vertexOwner.get(index)!==gunId)throw new Error('Recoil vertex shared between guns');
      vertexOwner.set(index,gunId);vertices.add(index);
    }
    guns.push({id:gunId,axis:[...g.motion.axis],indices:Uint32Array.from([...vertices].sort((a,b)=>a-b)),lastOffset:0});
  }
  for(let i=0;i<asset.indices.length;i++)if(indexOwner[i]===-1&&vertexOwner.has(asset.indices[i]))throw new Error('Recoil vertex shared with fixed ship geometry');
  const rest=new Map();for(const index of vertexOwner.keys())rest.set(index,Array.from(asset.vertices.subarray(index*9,index*9+3)));
  return {guns,rest,vertexCount:asset.vertices.length/9};
}

// Only positions change; normals/materials/UVs and canonical shared asset data
// remain bit-identical. Returned ranges contain full interleaved records, ready
// for writeBuffer(targetGpu,byteOffset,targetVertices,firstFloat,floatCount).
export function updateGunRecoilVertices(map,targetVertices,offsets,boat){
  const scale=gunModelScale(boat),scaleKey=scale.join('/'),changed=[];
  for(const gun of map.guns){
    const value=offsets?.get?offsets.get(gun.id):offsets?.[gun.id],offset=Math.max(0,Number.isFinite(value?.offset)?value.offset:Number.isFinite(value)?value:0);
    if(Math.abs(offset-gun.lastOffset)<1e-9&&(!(offset>0)||map.scaleKey===scaleKey))continue;
    const direction=gunModelDirection({directionDesign:gun.axis},scale),delta=direction.map((v,i)=>-v*offset/scale[i]);
    for(const index of gun.indices){const base=map.rest.get(index),at=index*9;for(let j=0;j<3;j++)targetVertices[at+j]=offset===0?base[j]:base[j]+delta[j];changed.push(index);}
    gun.lastOffset=offset;
  }
  map.scaleKey=scaleKey;
  changed.sort((a,b)=>a-b);const ranges=[];
  for(const index of changed){
    const previous=ranges.at(-1),firstFloat=index*9;
    if(previous&&firstFloat===previous.firstFloat+previous.floatCount){previous.floatCount+=9;previous.byteLength+=36;}
    else ranges.push({firstFloat,floatCount:9,byteOffset:firstFloat*4,byteLength:36});
  }
  return ranges;
}
