// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {SHIP_MODELS,requirePlayableShipModel} from './ship-models.js';
import {WAKE_SIZE} from './wgsl/interaction.js';

export const MAX_FOLLOWERS=8;
export const MAX_FLEET_VESSELS=MAX_FOLLOWERS+1;
export function readyFleetModels(){return Object.values(SHIP_MODELS).filter(model=>model.status==='ready').map(model=>requirePlayableShipModel(model.id));}

// A missing fleet retains the original same-model escort. Explicit entries are
// independent selections; ! preserves a disabled row without allocating a ship.
export function fleetFromSearch(search,playerModel='nina'){
  const entries=search.has('fleet')?search.get('fleet').split(',').filter(Boolean):[(search.get('follower')==='0'?'!':'')+playerModel];
  if(entries.length>MAX_FOLLOWERS)throw new RangeError('A fleet supports at most '+MAX_FOLLOWERS+' followers');
  return entries.map((entry,index)=>{
    const enabled=!entry.startsWith('!'),modelId=enabled?entry:entry.slice(1);
    requirePlayableShipModel(modelId);
    return {id:'escort-'+(index+1),modelId,enabled};
  });
}
export function fleetToSearch(entries){
  if(!Array.isArray(entries)||entries.length>MAX_FOLLOWERS)throw new RangeError('Invalid fleet selections');
  return entries.map(entry=>(entry.enabled===false?'!':'')+requirePlayableShipModel(entry.modelId).id).join(',');
}
export function fleetFormation(index){
  if(!Number.isSafeInteger(index)||index<0||index>=MAX_FOLLOWERS)throw new RangeError('Invalid formation station');
  return {trail:2.8*(1+Math.floor(index/2)),side:index%2?-1.5:1.5};
}
export function fleetModelCode(model){
  const code=model.modelCode??({nina:0,victory:1})[model.id];
  if(!Number.isSafeInteger(code)||code<0)throw new Error('Missing GPU hull backend for '+model.id);
  return code;
}
export function fleetViewBounds(boats){
  if(!boats.length)return {x:0,z:0,radius:0};
  let x=0,z=0;for(const boat of boats){x+=boat.x/boats.length;z+=boat.z/boats.length;}
  let radius=0;for(const boat of boats)radius=Math.max(radius,Math.hypot(boat.x-x,boat.z-z)+boat.length);
  return {x,z,radius};
}
export function validateFleetDevice(limits,count,shadowResolution=2048){
  if(!Number.isSafeInteger(count)||count<1||count>MAX_FLEET_VESSELS)throw new RangeError('Invalid active fleet size');
  if(limits.maxTextureArrayLayers<count||limits.maxTextureDimension2D<Math.max(WAKE_SIZE,shadowResolution)||limits.maxUniformBufferBindingSize<112*count)
    throw new Error('This graphics device cannot allocate the selected fleet');
}

// Two shared banks retain the original per-hull wake update and sampling. Every
// enabled hull writes one layer to the same destination bank; consumer bindings
// depend on two parities, never on 2^ship-count combinations.
export function createFleetWakePool(device,count){
  validateFleetDevice(device.limits,count);
  const T=GPUTextureUsage,B=GPUBufferUsage;
  const textures=[0,1].map(i=>device.createTexture({label:'fleet wake bank '+i,size:[WAKE_SIZE,WAKE_SIZE,count],format:'rgba16float',usage:T.TEXTURE_BINDING|T.STORAGE_BINDING|T.COPY_SRC|T.COPY_DST}));
  const views=textures.map(texture=>texture.createView({dimension:'2d-array'}));
  const uniform=device.createBuffer({label:'fleet wake domains',size:64*count,usage:B.UNIFORM|B.COPY_DST});
  const values=new Float32Array(16*count);let current=0;
  return {textures,views,uniform,count,get current(){return current;},get next(){return 1-current;},
    layer(index){
      if(!Number.isInteger(index)||index<0||index>=count)throw new RangeError('Invalid fleet wake layer');
      return {textures,views:textures.map(texture=>texture.createView({dimension:'2d',baseArrayLayer:index,arrayLayerCount:1}))};
    },
    update(vessels){
      if(vessels.length!==count)throw new Error('Fleet wake roster changed without rebuilding resources');
      for(let i=0;i<count;i++)values.set(vessels[i].interaction.values,i*16);
      device.queue.writeBuffer(uniform,0,values);
    },
    commit(){current=1-current;},
    destroy(){uniform.destroy();for(const texture of textures)texture.destroy();},
  };
}
