// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {createDolphinEncounter,DOLPHIN_LIMIT,DOLPHIN_SPLASH_LIMIT,DOLPHIN_SPLASH_SECONDS} from './dolphin-state.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {surfaceWaveGroups} from './surface-bindings.js';
import {ANIMAL_TYPE} from './animal-continuum.js';
import {requestAnimalContinuumAtlas,createAnimalScene} from './animal-scene.js';
import {requestContinuumPrograms,requestContinuumView,requestContinuumCapture,continuumCaptureDraw} from './continuum-scene.js';
import {LAND_SHADOW_FORMAT} from './shadows.js';
import {DOLPHIN_RENDER,DOLPHIN_CONTINUUM_MATERIAL_SPEC,SEA_PLACE_VEC4S,seaStandWGSL,DOLPHIN_RIPPLE_SEGMENTS,DOLPHIN_RIPPLE_RINGS,DOLPHIN_RIPPLE_ROWS,DOLPHIN_SHEET_SEGMENTS,DOLPHIN_SHEET_ROWS,DOLPHIN_DROP_COUNT} from './wgsl/dolphins.js';

// A sea module's moving sea, with the surface's own waves where the water carries them (group 1).
export function seaSource(source,surfaceWaves){
  return surfaceWaves?coupleSurfaceHeight(source,'dolphinSea(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'seaSampler'}):source;
}

// The dolphins are drawn through the one continuum: their state writes each one's place, the stand (encode) sets its
// record on the moving sea and writes its spine's joints, and the one cut chooses its clusters, far body or splat, in
// the view, in the land's shadow and in the water's picture of what lies under it. Their water is their own.
export async function createDolphins({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shadows,shader,format='rgba16float',samples=4,random=Math.random,waterOptics=null,surfaceWaves=null}){
  const state=createDolphinEncounter(random),B=GPUBufferUsage;
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const placeWords=new Uint32Array(DOLPHIN_LIMIT*SEA_PLACE_VEC4S*4),places=new Float32Array(placeWords.buffer),splashValues=new Float32Array(DOLPHIN_SPLASH_LIMIT*12);
  const placed=buffer('dolphin places',places,B.STORAGE),splashes=buffer('dolphin water entries',splashValues,B.STORAGE);
  const [atlas,programs,view,submerged,module,stand]=await Promise.all([
    requestAnimalContinuumAtlas(device),
    requestContinuumPrograms({device,shader,shadowFormat:LAND_SHADOW_FORMAT}),
    requestContinuumView({device,shader,material:DOLPHIN_CONTINUUM_MATERIAL_SPEC,format,samples}),
    requestContinuumCapture(waterOptics,DOLPHIN_CONTINUUM_MATERIAL_SPEC),
    shader(seaSource(DOLPHIN_RENDER,surfaceWaves),'dolphin water'),
    shader(seaSource(seaStandWGSL(false),surfaceWaves),'dolphin stand').then(code=>device.createComputePipelineAsync({label:'dolphin stand',layout:'auto',compute:{module:code,entryPoint:'seaStandCS'}})),
  ]);
  const animals=createAnimalScene({device,atlas,programs,view,count:DOLPHIN_LIMIT,types:[ANIMAL_TYPE.dolphin],frame:frameUBO,shadowUniform:shadows.uniform,samples,label:'dolphins',profile:'animals'});
  const entries=list=>list.map(([binding,resource])=>({binding,resource}));
  const main=entries([[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envView],[5,{buffer:sunVis}]]);
  const bodyGroup=device.createBindGroup({layout:view.pipeline.getBindGroupLayout(0),entries:main}),lighting=shadows.bind(view.pipeline);
  const under=continuumCaptureDraw(submerged,main,shadows);
  const standGroup=device.createBindGroup({layout:stand.getBindGroupLayout(0),entries:entries([[0,{buffer:frameUBO}],[1,{buffer:placed}],[2,{buffer:animals.records}],[3,{buffer:animals.poses}],[4,{buffer:atlas.rig}],[6,seaView],[7,seaSampler]])});
  const standWaves=surfaceWaveGroups(device,stand,surfaceWaves);
  const blend={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const pipelines=await Promise.all([['dolphinRipple','dolphin ripples'],['dolphinSplash','dolphin splash crowns'],['dolphinDrop','dolphin spray']].map(([kind,label])=>device.createRenderPipelineAsync({label,layout:'auto',
    vertex:{module,entryPoint:kind+'VS'},fragment:{module,entryPoint:kind+'FS',targets:[{format,blend}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:samples}})));
  const scene=entries([[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envView],[5,{buffer:sunVis}],[6,seaView],[7,seaSampler],[9,{buffer:splashes}]]);
  const groups=pipelines.map(pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:scene}));
  const waveGroups=pipelines.map(pipe=>surfaceWaveGroups(device,pipe,surfaceWaves));
  const bind=(pass,i)=>{pass.setPipeline(pipelines[i]);pass.setBindGroup(0,groups[i]);if(waveGroups[i])pass.setBindGroup(1,waveGroups[i][surfaceWaves.current]);};
  let splashCount=0,burstCount=0,standing=0;
  return {state,animals,
    update(dt,boat,settings,terrain=null,vessels=[boat]){
      state.step(dt,boat,settings,terrain,vessels);splashCount=0;burstCount=0;
      // Each one's place: where it swims, at its depth under the sea, turned to its heading (the continuum's yaw turns
      // the other way), pitched, at its scale, with its stroke's phase; the stand sets it on the sea.
      standing=state.active?state.count:0;
      for(let i=0;i<standing;i++){
        const a=state.animals[i],at=i*SEA_PLACE_VEC4S*4;
        places.set([a.x,a.depth,a.z,-a.heading,a.pitch,0,a.scale,a.phase*Math.PI*2,ANIMAL_TYPE.dolphin],at);
        placeWords[at+9]=Math.imul(i+1,0x9e3779b9)>>>0;
      }
      if(standing)device.queue.writeBuffer(placed,0,places,0,standing*SEA_PLACE_VEC4S*4);
      animals.setCount(standing);
      // Burst records come first: surface swimming draws rings only, while
      // emergence/reentry also draws a short connected sheet and secondary drops.
      for(const trail of [false,true])for(const s of state.splashes){
        if(s.age<0||s.age>=DOLPHIN_SPLASH_SECONDS||s.strength<=0||(s.kind==='trail')!==trail)continue;
        const kind=trail?0:s.kind==='emerge'?1:2;
        splashValues.set([s.x,s.z,s.age,s.strength,s.heading,s.seed,kind,s.scale??1,s.speed??0,0,0,0],splashCount++*12);
        if(!trail)burstCount++;
      }
      if(splashCount)device.queue.writeBuffer(splashes,0,splashValues,0,splashCount*12);
    },
    // In the simulation's compute pass, after update: the stand, then the cut.
    encode(pass){
      if(standing){
        pass.setPipeline(stand);pass.setBindGroup(0,standGroup);if(standWaves)pass.setBindGroup(1,standWaves[surfaceWaves.current]);
        pass.dispatchWorkgroups(Math.ceil(standing/64));
      }
      animals.encode(pass);
    },
    drawSubmerged(pass,above=false){under?.draw(pass,[animals],above);},
    drawShadow(pass){animals.drawShadow(pass);},
    draw(pass){
      animals.draw(pass,bodyGroup,lighting);
      if(splashCount){bind(pass,0);pass.draw(DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_RINGS*DOLPHIN_RIPPLE_ROWS*6,splashCount);}
      if(burstCount){
        bind(pass,1);pass.draw(DOLPHIN_SHEET_SEGMENTS*DOLPHIN_SHEET_ROWS*6,burstCount);
        bind(pass,2);pass.draw(6,burstCount*DOLPHIN_DROP_COUNT);
      }
    },
    // For the continuum census (js/continuum-census.js).
    continuumDraws(){return animals.continuumDraws();},
    destroy(){placed.destroy();splashes.destroy();animals.destroy();},
  };
}
