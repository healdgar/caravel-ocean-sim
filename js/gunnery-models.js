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
export function createGunDefinitions(boatOrModelId='nina'){
  const id=typeof boatOrModelId==='string'?boatOrModelId:boatOrModelId.modelId??'nina';
  if(!GUNNERY_MODEL_GUNS[id])throw new Error('No playable gun attachments for '+id);
  return GUNNERY_MODEL_GUNS[id];
}
export function gunModelScale(boat){return[(boat.beam??(boat.modelId==='victory'?VICTORY_DESIGN.runtime.beam:NINA_DESIGN.runtime.beam))/3.6,
  vesselVerticalScale(boat),(boat.length??(boat.modelId==='victory'?VICTORY_DESIGN.runtime.length:NINA_DESIGN.runtime.length))/12];}
export function gunModelDirection(gun,scale){
  const d=gun.directionDesign.map((v,i)=>v*scale[i]),n=Math.hypot(...d);return d.map(v=>v/n);
}

// Matches boatRotate's R_heading R_pitch R_roll order. Its compass heading
// rotates about -worldY, so yaw angular velocity carries the corresponding sign.
// Translational velocity is physical sailing speed/leeway, never compressed
// voyage-coordinate speed. Point velocity includes omega cross muzzle offset.
export function gunMuzzlePose(gun,boat){
  const scale=gunModelScale(boat),localDirection=gunModelDirection(gun,scale),offset=Math.max(0,Number.isFinite(gun.offset)?gun.offset:0);
  const localPosition=gun.muzzleDesign.map((v,i)=>v*scale[i]-localDirection[i]*offset),direction=[0,0,0],r=[0,0,0];
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
