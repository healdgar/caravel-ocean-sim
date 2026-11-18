// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {createMarineLifeState,MARINE_ANIMAL_LIMIT,MARINE_EFFECT_LIMIT,MARINE_EFFECT_SECONDS} from './marine-life-state.js';
import {MARINE_LIFE_RENDER,MARINE_EFFECT_INIT,MARINE_MIST_COUNT,MARINE_BREATH_DROP_COUNT,MARINE_FALLOUT_COUNT,MARINE_IMPACT_SEGMENTS,MARINE_IMPACT_ROWS,MARINE_IMPACT_DROP_COUNT} from './wgsl/marine-life.js';
import {DOLPHIN_RIPPLE_SEGMENTS,DOLPHIN_RIPPLE_RINGS,DOLPHIN_RIPPLE_ROWS,MARINE_CONTINUUM_MATERIAL_SPEC,SEA_PLACE_VEC4S,seaStandWGSL} from './wgsl/dolphins.js';
import {seaSource} from './dolphins.js';
import {loadMarineGLB} from './marine-asset.js';
import {createMarineRig,marineStrokeAmplitude} from './marine-rig.js';
import {surfaceWaveGroups} from './surface-bindings.js';
import {ANIMAL_TYPE} from './animal-continuum.js';
import {requestAnimalContinuumAtlas,createAnimalScene} from './animal-scene.js';
import {requestContinuumPrograms,requestContinuumView,requestContinuumCapture,continuumCaptureDraw} from './continuum-scene.js';
import {LAND_SHADOW_FORMAT} from './shadows.js';

// The sharks and the whale are drawn through the one continuum (their procedural sources, js/marine-mesh.js and the
// whale's model, are baked by scripts/prepare-animal-continuum.mjs): their state writes each one's place and the
// whale's rig its bones, the stand (encode) sets each record on the moving sea and writes its joints, and the one cut
// chooses its clusters, far body or splat, in the view, in the land's shadow and in the water's picture of what lies
// under it. The whale's model lends its textures and its rig; its body is the continuum's.
export async function createMarineLife({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shadows,shader,format='rgba16float',samples=4,random=Math.random,waterOptics=null,surfaceWaves=null,state=createMarineLifeState(random)}){
  const response=await fetch('assets/wildlife/whale.glb');if(!response.ok)throw Error('Whale asset unavailable');
  const whaleModel=loadMarineGLB(await response.arrayBuffer()),whaleRig=createMarineRig(whaleModel);
  const B=GPUBufferUsage;
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const material=whaleModel.materials[0];
  async function marineTexture(reference,fallback,textureFormat){
    if(!reference){const texture=device.createTexture({size:[1,1],format:textureFormat,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture},new Uint8Array(fallback),{bytesPerRow:4},[1,1]);return texture;}
    const source=whaleModel.images[reference.image],bitmap=await createImageBitmap(new Blob([source.bytes],{type:source.mimeType}),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
    const levels=Math.floor(Math.log2(Math.max(bitmap.width,bitmap.height)))+1;
    const texture=device.createTexture({label:'whale '+textureFormat,size:[bitmap.width,bitmap.height],mipLevelCount:levels,format:textureFormat,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    for(let level=0;level<levels;level++){
      const w=Math.max(1,bitmap.width>>level),h=Math.max(1,bitmap.height>>level),canvas=new OffscreenCanvas(w,h);
      canvas.getContext('2d').drawImage(bitmap,0,0,w,h);device.queue.copyExternalImageToTexture({source:canvas},{texture,mipLevel:level},[w,h]);
    }
    bitmap.close();return texture;
  }
  const [textures,atlas,programs,view,submerged,stand]=await Promise.all([
    Promise.all([marineTexture(material.baseColorTexture,[255,255,255,255],'rgba8unorm-srgb'),marineTexture(material.normalTexture,[128,128,255,255],'rgba8unorm'),marineTexture(material.metallicRoughnessTexture,[255,150,0,255],'rgba8unorm')]),
    requestAnimalContinuumAtlas(device),
    requestContinuumPrograms({device,shader,shadowFormat:LAND_SHADOW_FORMAT}),
    requestContinuumView({device,shader,material:MARINE_CONTINUUM_MATERIAL_SPEC,format,samples}),
    requestContinuumCapture(waterOptics,MARINE_CONTINUUM_MATERIAL_SPEC),
    shader(seaSource(seaStandWGSL(true),surfaceWaves),'marine stand').then(code=>device.createComputePipelineAsync({label:'marine stand',layout:'auto',compute:{module:code,entryPoint:'seaStandCS'}})),
  ]);
  const animals=createAnimalScene({device,atlas,programs,view,count:MARINE_ANIMAL_LIMIT,types:[ANIMAL_TYPE.shark,ANIMAL_TYPE.whale],frame:frameUBO,shadowUniform:shadows.uniform,samples,label:'marine animals',profile:'animals'});
  const bones=buffer('whale joint poses',whaleRig.update(0,0),B.STORAGE);
  const placeWords=new Uint32Array(MARINE_ANIMAL_LIMIT*SEA_PLACE_VEC4S*4),places=new Float32Array(placeWords.buffer),placed=buffer('marine animal places',places,B.STORAGE);
  const effectValues=new Float32Array(MARINE_EFFECT_LIMIT*12);
  const effects=buffer('marine surface events',effectValues,B.STORAGE);
  const origins=buffer('marine emission origins',new Float32Array(MARINE_EFFECT_LIMIT*(1+MARINE_IMPACT_DROP_COUNT)*4),B.STORAGE);
  const seededBirthKeys=new Float64Array(MARINE_EFFECT_LIMIT),birthSeed=new Float32Array(4);
  const landings=buffer('marine droplet contacts',new Float32Array(MARINE_EFFECT_LIMIT*MARINE_BREATH_DROP_COUNT*4),B.STORAGE);
  const sheetContacts=buffer('marine sheet contacts',new Float32Array(MARINE_EFFECT_LIMIT*MARINE_IMPACT_SEGMENTS*(MARINE_IMPACT_ROWS+1)*4),B.STORAGE);
  const module=await shader(seaSource(MARINE_LIFE_RENDER,surfaceWaves),'marine water');
  const blend={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const kinds=[['dolphinRipple','marine ripples'],['marineImpactSheet','marine impact water sheet'],['marineImpactDrop','marine impact drops'],['marineBlow','whale breath mist'],['marineBreathDrop','whale breath water'],['marineFallout','marine water fallout']];
  const pipelines=await Promise.all(kinds.map(([kind,label])=>device.createRenderPipelineAsync({label,layout:'auto',
    vertex:{module,entryPoint:kind+'VS'},fragment:{module,entryPoint:kind+'FS',targets:[{format,blend}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:samples}})));
  // Every binding a marine pass may read, by number.
  const resources=new Map([[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envView],[5,{buffer:sunVis}],[6,seaView],[7,seaSampler],[9,{buffer:effects}],[10,{buffer:origins}],[11,{buffer:landings}],
    ...textures.map((t,k)=>[12+k,t.createView()]),[16,{buffer:sheetContacts}]]);
  const entries=bindings=>bindings.map(binding=>({binding,resource:resources.get(binding)}));
  // The bodies' material reads the frame, the sky's light and the whale's skin (its sampler the sea's); the land's
  // shadow set is their second group.
  const main=entries([0,1,2,3,4,5,7,12,13,14]);
  const bodyGroup=device.createBindGroup({layout:view.pipeline.getBindGroupLayout(0),entries:main}),lighting=shadows.bind(view.pipeline);
  const under=continuumCaptureDraw(submerged,main,shadows);
  const standGroup=device.createBindGroup({layout:stand.getBindGroupLayout(0),entries:[[0,{buffer:frameUBO}],[1,{buffer:placed}],[2,{buffer:animals.records}],[3,{buffer:animals.poses}],[4,{buffer:atlas.rig}],[5,{buffer:bones}],[6,seaView],[7,seaSampler]].map(([binding,resource])=>({binding,resource}))});
  const standWaves=surfaceWaveGroups(device,stand,surfaceWaves);
  const effectBindings=[[0,1,2,3,4,5,6,7,9],[0,1,2,3,4,5,6,7,9,10,16],[0,1,2,3,4,5,6,7,9,10,11],[0,1,2,3,5,6,7,9,10],[0,1,2,3,4,5,6,7,9,10,11],[0,1,2,3,4,5,6,7,9,11]];
  const groups=pipelines.map((pipe,i)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries(effectBindings[i])}));
  const waveGroups=pipelines.map(pipe=>surfaceWaveGroups(device,pipe,surfaceWaves));
  const birthModule=await shader(seaSource(MARINE_EFFECT_INIT,surfaceWaves),'marine emission height');
  const birthPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:birthModule,entryPoint:'marineBirthCS'}});
  const birthGroup=device.createBindGroup({layout:birthPipeline.getBindGroupLayout(0),entries:entries([0,6,7,9,10,11])});
  const birthWaves=surfaceWaveGroups(device,birthPipeline,surfaceWaves);
  const sheetContactPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:birthModule,entryPoint:'marineImpactContactCS'}});
  const sheetContactGroup=device.createBindGroup({layout:sheetContactPipeline.getBindGroupLayout(0),entries:entries([0,6,7,9,10,16])});
  const sheetContactWaves=surfaceWaveGroups(device,sheetContactPipeline,surfaceWaves);
  const bind=(pass,i)=>{pass.setPipeline(pipelines[i]);pass.setBindGroup(0,groups[i]);if(waveGroups[i])pass.setBindGroup(1,waveGroups[i][surfaceWaves.current]);};
  let waterCount=0,burstCount=0,blowCount=0,effectCount=0,standing=0;
  return {state,animals,trigger:(type,boat,options)=>state.trigger(type,boat,options),
    // In the simulation's compute pass, after update: the bodies' stand and cut, then the water's births and contacts.
    encode(pass){
      if(standing){
        pass.setPipeline(stand);pass.setBindGroup(0,standGroup);if(standWaves)pass.setBindGroup(1,standWaves[surfaceWaves.current]);
        pass.dispatchWorkgroups(Math.ceil(standing/64));
      }
      animals.encode(pass);
      if(!effectCount)return;pass.setPipeline(birthPipeline);pass.setBindGroup(0,birthGroup);if(birthWaves)pass.setBindGroup(1,birthWaves[surfaceWaves.current]);pass.dispatchWorkgroups(effectCount);
      if(burstCount){pass.setPipeline(sheetContactPipeline);pass.setBindGroup(0,sheetContactGroup);if(sheetContactWaves)pass.setBindGroup(1,sheetContactWaves[surfaceWaves.current]);pass.dispatchWorkgroups(burstCount);}
    },
    update(dt,boat,settings,terrain=null,vessels=[boat]){
      state.step(dt,boat,settings,terrain,vessels);waterCount=0;burstCount=0;blowCount=0;
      if(state.active&&state.animals[0].type==='whale')device.queue.writeBuffer(bones,0,whaleRig.update(state.age,marineStrokeAmplitude(state.animals[0].depth)));
      // Each one's place: where it swims, at its depth under the sea, turned to its heading (the continuum's yaw turns
      // the other way), pitched and rolled, at its scale, with its stroke's phase; the stand sets it on the sea.
      standing=state.active?state.count:0;
      for(let i=0;i<standing;i++){
        const a=state.animals[i],at=i*SEA_PLACE_VEC4S*4;
        places.set([a.x,a.depth,a.z,-a.heading,a.pitch,a.roll,a.scale,a.phase,a.type==='whale'?ANIMAL_TYPE.whale:ANIMAL_TYPE.shark],at);
        placeWords[at+9]=Math.imul(i+1,0x9e3779b9)>>>0;
      }
      if(standing)device.queue.writeBuffer(placed,0,places,0,standing*SEA_PLACE_VEC4S*4);
      animals.setCount(standing);
      let count=0;
      // Stable pool order: impact bursts, ordinary surface trails, then blows.
      for(const category of [0,1,2])for(const e of state.effects){
        const type=e.kind==='blow'?2:e.kind==='trail'?1:0;
        if(type!==category||e.age<0||e.age>=MARINE_EFFECT_SECONDS||e.strength<=0)continue;
        const kind=e.kind==='trail'?0:e.kind==='emerge'?1:e.kind==='entry'?2:3;
        effectValues.set([e.x,e.z,e.age,e.strength,e.heading,e.seed,kind,e.scale,e.kind==='blow'?e.height:e.speed,e.windX,e.windZ,e.id+1],count++*12);
        if(type===2&&Number.isFinite(e.anchorX)&&Number.isFinite(e.anchorZ)){
          const key=e.id+1,slot=key%MARINE_EFFECT_LIMIT;
          if(key>0&&seededBirthKeys[slot]!==key){
            // e.height is measured above sea under the animal root, not under
            // its displaced forehead. A negative nonzero key marks this one-
            // time root query; the GPU replaces it with the frozen birth.
            birthSeed.set([-key,0,e.anchorX,e.anchorZ]);device.queue.writeBuffer(origins,slot*16,birthSeed);
            seededBirthKeys[slot]=key;
          }
        }
        if(type===0)burstCount++;if(type===2)blowCount++;else waterCount++;
      }
      if(count)device.queue.writeBuffer(effects,0,effectValues,0,count*12);
      effectCount=count;
    },
    drawSubmerged(pass,above=false){under?.draw(pass,[animals],above);},
    drawShadow(pass){animals.drawShadow(pass);},
    draw(pass){
      animals.draw(pass,bodyGroup,lighting);
      if(waterCount){bind(pass,0);pass.draw(DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_RINGS*DOLPHIN_RIPPLE_ROWS*6,waterCount);}
      if(burstCount){bind(pass,1);pass.draw(MARINE_IMPACT_SEGMENTS*MARINE_IMPACT_ROWS*6,burstCount);
        bind(pass,2);pass.draw(6,burstCount*MARINE_IMPACT_DROP_COUNT);
        bind(pass,5);pass.draw(MARINE_FALLOUT_COUNT*6,burstCount);}
      if(blowCount){
        bind(pass,3);pass.draw(MARINE_MIST_COUNT*6,blowCount,0,waterCount);
        bind(pass,4);pass.draw(MARINE_BREATH_DROP_COUNT*6,blowCount,0,waterCount);
        bind(pass,5);pass.draw(MARINE_FALLOUT_COUNT*6,blowCount,0,waterCount);
      }
    },
    // For the continuum census (js/continuum-census.js).
    continuumDraws(){return animals.continuumDraws();},
    destroy(){for(const b of [effects,origins,landings,sheetContacts,bones,placed])b.destroy();for(const texture of textures)texture.destroy();animals.destroy();},
  };
}
