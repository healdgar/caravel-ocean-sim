// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {gunModelScale,gunModelDirection} from './gunnery-models.js';
import {VESSEL_RECOIL_UPDATE} from './wgsl/vessel-recoil.js';

const vesselRecoilOwners=new WeakMap();
function vesselRecoilDefinition(map){
  if(!map||!Array.isArray(map.guns)||!Number.isSafeInteger(map.vertexCount)||map.vertexCount<1)throw Error('GPU recoil needs an indexed gun map');
  const owned=new Set(),ids=new Set(),guns=[];let count=0;
  for(const gun of map.guns){
    if(!Number.isSafeInteger(gun.id)||gun.id<0||ids.has(gun.id)||!gun.axis||gun.axis.length!==3
      ||!Array.from(gun.axis).every(Number.isFinite)||!(Math.hypot(...gun.axis)>0)
      ||!(gun.indices instanceof Uint32Array))throw Error('Invalid GPU recoil gun descriptor');
    ids.add(gun.id);
    for(const index of gun.indices){
      if(index>=map.vertexCount||owned.has(index))throw Error('GPU recoil vertex ownership overlaps or exceeds its model');
      owned.add(index);count++;
    }
    guns.push(Object.freeze({id:gun.id,axis:Object.freeze(Array.from(gun.axis)),indices:new Uint32Array(gun.indices)}));
  }
  const records=new Uint32Array(count*2);let at=0;
  for(let slot=0;slot<guns.length;slot++)for(const index of guns[slot].indices){records[at++]=index;records[at++]=slot;}
  return {guns:Object.freeze(guns),records,recordCount:count,vertexCount:map.vertexCount};
}
function vesselRecoilCompatible(asset,definition){
  if(asset.vertexCount!==definition.vertexCount||asset.recordCount!==definition.recordCount||asset.guns.length!==definition.guns.length)return false;
  for(let i=0;i<asset.guns.length;i++){
    const a=asset.guns[i],b=definition.guns[i];
    if(a.id!==b.id||a.indices.length!==b.indices.length||a.axis.some((v,j)=>!Object.is(v,b.axis[j])))return false;
    for(let j=0;j<a.indices.length;j++)if(a.indices[j]!==b.indices[j])return false;
  }
  return true;
}

export async function createVesselRecoil({device,computePipe,posedBuffer,recoilMap,shared=null}){
  const definition=vesselRecoilDefinition(recoilMap);
  if(!definition.guns.length||!definition.recordCount)return null;
  if(!posedBuffer)throw Error('GPU recoil needs the canonical posed vertex buffer');
  let assets=shared,owner=shared&&vesselRecoilOwners.get(shared);
  if(shared){
    if(shared.device!==device)throw Error('GPU recoil assets belong to another graphics device');
    if(!owner||owner.destroyed)throw Error('GPU recoil assets are no longer available');
    if(!vesselRecoilCompatible(shared,definition))throw Error('GPU recoil assets belong to another gun layout');
  }else{
    const pipeline=await computePipe(VESSEL_RECOIL_UPDATE,'shared vessel recoil');
    const records=device.createBuffer({label:'immutable gun recoil vertex ownership',size:definition.records.byteLength,
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(records,0,definition.records);
    assets=Object.freeze({device,pipeline,records,recordCount:definition.recordCount,guns:definition.guns,vertexCount:definition.vertexCount});
    owner={references:0,destroyed:false};vesselRecoilOwners.set(assets,owner);
  }
  const values=new Float32Array(assets.guns.length*4),deltas=device.createBuffer({label:'per-vessel gun recoil deltas',size:values.byteLength,
    usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  let group;
  try{
    group=device.createBindGroup({layout:assets.pipeline.getBindGroupLayout(0),entries:[posedBuffer,assets.records,deltas]
      .map((buffer,binding)=>({binding,resource:{buffer}}))});
  }catch(error){deltas.destroy();if(!owner.references){assets.records.destroy();owner.destroyed=true;}throw error;}
  owner.references++;let destroyed=false,active=false;
  return {assets,
    update(guns,boat){
      if(destroyed)return false;
      const scale=gunModelScale(boat);
      if(!scale.every(v=>Number.isFinite(v)&&v>0))throw Error('Invalid GPU recoil vessel dimensions');
      let changed=false;active=false;
      for(let slot=0;slot<assets.guns.length;slot++){
        const gun=assets.guns[slot],value=guns?.get?guns.get(gun.id):guns?.[gun.id];
        const offset=Math.max(0,Number.isFinite(value?.offset)?value.offset:Number.isFinite(value)?value:0);
        const direction=offset===0?null:gunModelDirection({directionDesign:gun.axis},scale);
        for(let component=0;component<3;component++){
          const delta=offset===0?0:Math.fround(-direction[component]*offset/scale[component]),at=slot*4+component;
          if(!Number.isFinite(delta))throw Error('Non-finite GPU recoil delta');
          if(values[at]!==delta){values[at]=delta;changed=true;}
          active||=delta!==0;
        }
      }
      if(changed)device.queue.writeBuffer(deltas,0,values);
      return changed;
    },
    // Canonical pose must reset every visible vessel before this dispatch.
    // Applying recoil twice without that reset would accumulate translation.
    encode(pass,enabled=true){
      if(!enabled||destroyed||!active)return false;
      pass.setPipeline(assets.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(assets.recordCount/64));return true;
    },
    destroy(){
      if(destroyed)return;destroyed=true;deltas.destroy();owner.references--;
      if(!owner.references){assets.records.destroy();owner.destroyed=true;}
    },
  };
}
