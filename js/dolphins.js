import {createDolphinEncounter,DOLPHIN_LIMIT,DOLPHIN_SPLASH_LIMIT,DOLPHIN_SPLASH_SECONDS} from './dolphin-state.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {surfaceWaveGroups} from './surface-bindings.js';
import {ANIMAL_PLACE_FLOATS,ANIMAL_PLACE_SEA,ANIMAL_TYPE,animalPlaceCode} from './animal-continuum.js';
import {ANIMAL_CONTINUUM_ENTRY_LAYOUT} from './wgsl/animal-continuum.js';
import {createAnimalContinuumSet,requestAnimalContinuumAtlas,requestAnimalContinuumPipelines} from './animal-continuum-draw.js';
import {DOLPHIN_RENDER,SEA_CONTINUUM_BINDING,DOLPHIN_RIPPLE_SEGMENTS,DOLPHIN_RIPPLE_RINGS,DOLPHIN_RIPPLE_ROWS,DOLPHIN_SHEET_SEGMENTS,DOLPHIN_SHEET_ROWS,DOLPHIN_DROP_COUNT} from './wgsl/dolphins.js';

// The dolphins are drawn through the animal continuum: their places are written here each frame, the shared cut
// (encode) chooses each one's clusters, far body or splat, and one pipeline poses and lights what it chose, in the
// view and in the water's picture of what lies under it.
export async function createDolphins({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,random=Math.random,waterOptics=null,surfaceWaves=null}){
  const state=createDolphinEncounter(random),B=GPUBufferUsage;
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const places=new Float32Array(DOLPHIN_LIMIT*ANIMAL_PLACE_FLOATS),splashValues=new Float32Array(DOLPHIN_SPLASH_LIMIT*12);
  const splashes=buffer('dolphin water entries',splashValues,B.STORAGE);
  const [atlas,cut]=await Promise.all([requestAnimalContinuumAtlas(device),requestAnimalContinuumPipelines({device,shader})]);
  const animals=createAnimalContinuumSet({device,atlas,pipelines:cut,frame:frameUBO,capacity:DOLPHIN_LIMIT,samples,label:'dolphins'});
  const source=surfaceWaves?coupleSurfaceHeight(DOLPHIN_RENDER,'dolphinSea(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'seaSampler'}):DOLPHIN_RENDER;
  const module=await shader(source,'dolphins');
  const kinds=[['seaContinuum',ANIMAL_CONTINUUM_ENTRY_LAYOUT],['dolphinRipple',[]],['dolphinSplash',[]],['dolphinDrop',[]]];
  const pipelines=await Promise.all(kinds.map(([kind,buffers],i)=>device.createRenderPipelineAsync({label:['dolphins','dolphin ripples','dolphin splash crowns','dolphin spray'][i],layout:'auto',
    vertex:{module,entryPoint:kind+'VS',buffers},fragment:{module,entryPoint:kind+'FS',targets:[{format,...(i?{blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}:{})}]},
    primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:i===0,depthCompare:'greater'},multisample:{count:samples}})));
  const scene=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler].map((resource,binding)=>({binding,resource}));
  const bodyEntries=[...scene,...animals.entries(SEA_CONTINUUM_BINDING)];
  const groups=pipelines.map((pipe,i)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:i===0?bodyEntries:[...scene,{binding:9,resource:{buffer:splashes}}]}));
  const waveGroups=pipelines.map(pipe=>surfaceWaveGroups(device,pipe,surfaceWaves));
  const submerged=waterOptics?await waterOptics.capture({source,pipeline:pipelines[0],vertex:{entryPoint:'seaContinuumVS',buffers:ANIMAL_CONTINUUM_ENTRY_LAYOUT},entry:'seaContinuumCaptureFS',world:'v.world',groups:surfaceWaves?2:1}):null;
  const submergedGroup=submerged?.bindGroup(bodyEntries);
  const submergedWaves=submerged?surfaceWaveGroups(device,submerged.pipeline,surfaceWaves):null;
  const bind=(pass,i)=>{pass.setPipeline(pipelines[i]);pass.setBindGroup(0,groups[i]);if(waveGroups[i])pass.setBindGroup(1,waveGroups[i][surfaceWaves.current]);};
  let splashCount=0,burstCount=0;
  return {state,animals,
    update(dt,boat,settings,terrain=null,vessels=[boat]){
      state.step(dt,boat,settings,terrain,vessels);splashCount=0;burstCount=0;
      // Each one's place: where it swims, at its depth under the sea, turned to its heading (the continuum's yaw
      // turns the other way), pitched, at its scale, with its stroke's phase.
      places.fill(0);
      for(let i=0;i<state.count;i++){
        const a=state.animals[i];
        places.set([a.x,a.depth,a.z,-a.heading,a.pitch,0,a.scale,animalPlaceCode(ANIMAL_TYPE.dolphin,ANIMAL_PLACE_SEA,i+1),a.phase*Math.PI*2],i*ANIMAL_PLACE_FLOATS);
      }
      animals.writePlaces(places,state.active?state.count:0);
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
    // In the simulation's compute pass, after update: the cut.
    encode(pass){animals.encode(pass);},
    drawSubmerged(pass,above=false){
      if(!submerged||!animals.count)return;
      submerged.bind(pass,above);pass.setBindGroup(0,submergedGroup);if(submergedWaves)pass.setBindGroup(1,submergedWaves[surfaceWaves.current]);animals.drawView(pass);
    },
    draw(pass){
      if(animals.count){bind(pass,0);animals.drawView(pass);}
      if(splashCount){bind(pass,1);pass.draw(DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_RINGS*DOLPHIN_RIPPLE_ROWS*6,splashCount);}
      if(burstCount){
        bind(pass,2);pass.draw(DOLPHIN_SHEET_SEGMENTS*DOLPHIN_SHEET_ROWS*6,burstCount);
        bind(pass,3);pass.draw(6,burstCount*DOLPHIN_DROP_COUNT);
      }
    },
    // For the continuum census (js/continuum-census.js).
    continuumDraws(){return animals.continuumDraws();},
    destroy(){splashes.destroy();animals.destroy();},
  };
}
