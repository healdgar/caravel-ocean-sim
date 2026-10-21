// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {GUNNERY_RENDER,GUNNERY_DEPTH_RESOLVE,GUNNERY_CROWN_SEGMENTS,GUNNERY_CROWN_ROWS,GUNNERY_DROP_COUNT,GUNNERY_RING_SEGMENTS,GUNNERY_RING_COUNT} from './wgsl/gunnery.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {surfaceWaveGroups} from './surface-bindings.js';

export const GUNNERY_FX_LIMITS=Object.freeze({shots:64,smoke:192,impacts:40,projectiles:128,smokeSeconds:18,impactSeconds:8,flashSeconds:.085});
const gunneryFxFinite=(v,fallback=0)=>Number.isFinite(v)?v:fallback;
const gunneryFxVector=(v,fallback=[0,0,0])=>fallback.map((n,i)=>gunneryFxFinite(v?.[i],n));
const gunneryFxClamp=(n,a,b)=>Math.max(a,Math.min(b,n));

// Effects consume the physics system's actual shot and water-contact events.
// They never infer a hit, integrate roundshot, or add a tracer to an iron ball.
export function createGunneryEffectState(){
  const shots=[],impacts=[],projectiles=[];let serial=0;
  function emitShot(event={}){
    if(!Array.isArray(event.position)&&!ArrayBuffer.isView(event.position))return false;
    if(!event.position.every(Number.isFinite))return false;
    const direction=gunneryFxVector(event.direction,[1,0,0]),length=Math.hypot(...direction);
    if(length<1e-8)return false;
    if(shots.length===GUNNERY_FX_LIMITS.shots)shots.shift();
    shots.push({id:event.id??++serial,position:gunneryFxVector(event.position),direction:direction.map(v=>v/length),age:0,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.chargeKg,3)/3),.45,1.8),seed:(++serial*.61803398875)%1,
      drift:[0,0,0],driftVelocity:[0,0,0]});return true;
  }
  function emitImpact(event={}){
    if((!Array.isArray(event.position)&&!ArrayBuffer.isView(event.position))||!event.position.every(Number.isFinite))return false;
    const velocity=gunneryFxVector(event.velocity),speed=Math.hypot(...velocity);
    if(speed<.1)return false;
    if(impacts.length===GUNNERY_FX_LIMITS.impacts)impacts.shift();
    impacts.push({id:event.id??++serial,position:gunneryFxVector(event.position),velocity,age:0,seed:(++serial*.61803398875)%1,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.massKg,12)/12),.4,1.6),wind:[0,0,0]});return true;
  }
  function setProjectiles(values=[]){
    projectiles.length=0;
    for(const p of values){
      if(projectiles.length===GUNNERY_FX_LIMITS.projectiles)break;
      if(!p?.position||p.position.length!==3||!Array.from(p.position).every(Number.isFinite))continue;
      projectiles.push({id:p.id,position:gunneryFxVector(p.position),radius:gunneryFxClamp(gunneryFxFinite(p.radius,.075),.015,.3)});
    }
  }
  function step(dt,{wind=[0,0,0]}={}){
    dt=gunneryFxClamp(gunneryFxFinite(dt),0,.25);
    if(!dt||(!shots.length&&!impacts.length))return;
    const flow=gunneryFxVector(wind),tau=1.35,decay=Math.exp(-dt/tau);
    for(let i=shots.length-1;i>=0;i--){
      const s=shots[i];s.age+=dt;
      if(s.age>=GUNNERY_FX_LIMITS.smokeSeconds){shots.splice(i,1);continue;}
      // Exact constant-wind entrainment over this step. The smoke leaves the
      // muzzle rapidly, then its bulk motion follows ambient wind continuously.
      for(let k=0;k<3;k++){
        s.drift[k]+=flow[k]*dt+(s.driftVelocity[k]-flow[k])*tau*(1-decay);
        s.driftVelocity[k]=flow[k]+(s.driftVelocity[k]-flow[k])*decay;
      }
    }
    for(let i=impacts.length-1;i>=0;i--){
      const e=impacts[i];e.age+=dt;
      if(e.age>=GUNNERY_FX_LIMITS.impactSeconds)impacts.splice(i,1);
      else e.wind=flow;
    }
  }
  return {shots,impacts,projectiles,emitShot,emitImpact,setProjectiles,step,
    get active(){return !!(shots.length||impacts.length||projectiles.length);},
    clear(){shots.length=impacts.length=projectiles.length=0;},
  };
}

// A small number of connected, expanding volumes per muzzle replaces smoke
// cards. These are bounded authored black-powder billows, not a fluid solver.
export function gunnerySmokeParcel(shot,index){
  const t=shot.age-index*.022;if(t<0)return null;
  const direction=shot.direction,scale=shot.scale;
  const travel=(.2+index*.48)+(4.4-index*.7)*(1-Math.exp(-t/(.27+index*.085)))*scale;
  const across=(.17+.92*Math.pow(t,.7))*scale*(1-index*.09);
  const along=(.32+Math.min(t,.35)*(4.5-index*.6)+t*.27)*scale;
  const centre=shot.position.map((v,k)=>v+direction[k]*travel+shot.drift[k]);
  centre[1]+=(.24*t+.16*(1-Math.exp(-t/.7)))*scale;
  const eddy=across*Math.min(1,t*.8)*.28,phase=shot.seed*37+index*2.4;
  const transverse=[direction[2],0,-direction[0]],transverseLength=Math.hypot(...transverse)||1;
  for(let k=0;k<3;k++)centre[k]+=transverse[k]/transverseLength*Math.sin(phase)*eddy;
  centre[1]+=Math.cos(phase)*eddy;
  // Random phase changes contours; no per-frame random spawning or even rows.
  // Black powder produces a substantial condensed aerosol load. A single
  // fresh discharge must obscure its own gun, and adjacent guns must combine
  // into a dense bank before dilution clears it. This remains a visual mass
  // calibration; the expanding volume and wind entrainment are unchanged.
  const extinction=(11.1-index*1.8)*scale**3/(across*across*along)*Math.exp(-t/9)*(1-gunneryFxClamp((t-13)/5,0,1));
  return {centre,radii:[across,across*(1+.12*Math.sin(shot.seed*17+index)),along],direction,extinction,age:t,seed:shot.seed*79+index*11};
}

export async function createGunneryEffects({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,surfaceWaves=null}){
  const state=createGunneryEffectState(),B=GPUBufferUsage,T=GPUTextureUsage;
  const volumes=new Float32Array((GUNNERY_FX_LIMITS.smoke+GUNNERY_FX_LIMITS.shots)*20);
  const balls=new Float32Array(GUNNERY_FX_LIMITS.projectiles*4),contacts=new Float32Array(GUNNERY_FX_LIMITS.impacts*16);
  const make=(label,bytes)=>device.createBuffer({label,size:bytes,usage:B.STORAGE|B.COPY_DST});
  const volumeBuffer=make('black powder smoke volumes',volumes.byteLength),ballBuffer=make('iron roundshot positions',balls.byteLength),contactBuffer=make('roundshot water contacts',contacts.byteLength);
  const source=surfaceWaves?coupleSurfaceHeight(GUNNERY_RENDER,'gunnerySeaDisplacement(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'gunnerySeaSampler'}):GUNNERY_RENDER;
  const module=await shader(source,'black powder cannon effects');
  const transparent={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const types=[['gunneryBall',false],['gunneryVolume',true],['gunneryCrown',true],['gunneryDrop',true],['gunneryRing',true]];
  const pipelines=await Promise.all(types.map(([entry,blend],i)=>device.createRenderPipelineAsync({label:entry,layout:'auto',
    vertex:{module,entryPoint:entry+'VS'},fragment:{module,entryPoint:entry+'FS',targets:[{format,...(blend?{blend:transparent}:{})}]},
    primitive:{topology:'triangle-list',cullMode:i===1?'front':'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:i===0,depthCompare:i===1?'always':'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler,{buffer:volumeBuffer},{buffer:ballBuffer},{buffer:contactBuffer}];
  // Auto layouts reflect each entry point. Keep this table explicit so resource
  // changes are checked by native pipeline creation and integration tests.
  const bindings=[[0,1,2,3,4,5,9],[0,1,2,3,5,8,11],[0,1,2,3,4,5,10],[0,1,2,3,4,5,10],[0,1,2,3,4,5,6,7,10]];
  const ringWaves=surfaceWaveGroups(device,pipelines[4],surfaceWaves);
  let volumeCount=0,impactCount=0,ballCount=0,depthTexture=null,depthWidth=0,depthHeight=0,depthSource=null,depthGroup=null;
  let volumeGroup=null,depthReady=false;
  const groups=pipelines.map((pipe,i)=>i===1?null:device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:bindings[i].map(binding=>({binding,resource:resources[binding]}))}));
  const depthModule=await shader(GUNNERY_DEPTH_RESOLVE(samples),'cannon effects depth snapshot');
  const depthPipeline=await device.createComputePipelineAsync({label:'resolve cannon effects depth',layout:'auto',compute:{module:depthModule,entryPoint:'gunneryResolveDepth'}});
  const volumeEntries=()=>bindings[1].map(binding=>({binding,resource:binding===11?depthTexture.createView():resources[binding]}));
  function writeVolume(at,centre,direction,radii,type,extinction,age,seed){
    let right=[direction[2],0,-direction[0]],length=Math.hypot(...right);
    if(length<1e-6){right=[1,0,0];length=1;}
    right=right.map(v=>v/length);
    const up=[direction[1]*right[2]-direction[2]*right[1],direction[2]*right[0]-direction[0]*right[2],direction[0]*right[1]-direction[1]*right[0]];
    volumes.set([...centre,type,...right,radii[0],...up,radii[1],...direction,radii[2],extinction,age,seed,0],at*20);
  }
  return {state,emitShot:state.emitShot,emitImpact:state.emitImpact,setProjectiles:state.setProjectiles,
    get active(){return state.active;},get transparentActive(){return !!(volumeCount||impactCount);},
    get counts(){return {volumes:volumeCount,impacts:impactCount,projectiles:ballCount};},
    update(dt,options={}){
      state.step(dt,options);depthReady=false;volumeCount=impactCount=ballCount=0;
      if(!state.active)return;
      const eye=gunneryFxVector(options.eye),ordered=[];
      for(const shot of state.shots){
        for(let k=0;k<3;k++){const p=gunnerySmokeParcel(shot,k);if(p)ordered.push({...p,type:0});}
        if(shot.age<GUNNERY_FX_LIMITS.flashSeconds){
          const t=shot.age/GUNNERY_FX_LIMITS.flashSeconds;
          ordered.push({centre:shot.position.map((v,k)=>v+shot.direction[k]*(.55+1.1*t)*shot.scale),direction:shot.direction,
            radii:[(.12+.35*Math.sin(t*Math.PI))*shot.scale,(.12+.28*Math.sin(t*Math.PI))*shot.scale,(.6+1.1*Math.sin(t*Math.PI))*shot.scale],
            type:1,extinction:1-t,age:shot.age,seed:shot.seed*79});
        }
      }
      ordered.sort((a,b)=>b.centre.reduce((sum,v,k)=>sum+(v-eye[k])**2,0)-a.centre.reduce((sum,v,k)=>sum+(v-eye[k])**2,0));
      for(const p of ordered)writeVolume(volumeCount++,p.centre,p.direction,p.radii,p.type,p.extinction,p.age,p.seed);
      for(const p of state.projectiles)balls.set([...p.position,p.radius],ballCount++*4);
      for(const e of state.impacts){contacts.set([...e.position,e.age,...e.velocity,e.scale,e.seed,...e.wind,0,0,0,0],impactCount++*16);}
      if(volumeCount)device.queue.writeBuffer(volumeBuffer,0,volumes,0,volumeCount*20);
      if(ballCount)device.queue.writeBuffer(ballBuffer,0,balls,0,ballCount*4);
      if(impactCount)device.queue.writeBuffer(contactBuffer,0,contacts,0,impactCount*16);
    },
    drawProjectiles(pass){
      if(!ballCount)return;
      pass.setPipeline(pipelines[0]);pass.setBindGroup(0,groups[0]);pass.draw(12*8*6,ballCount);
    },
    resolveDepth(encoder,source,width,height){
      if(!volumeCount)return false;
      if(!depthTexture||width!==depthWidth||height!==depthHeight){
        depthTexture?.destroy();depthWidth=width;depthHeight=height;
        depthTexture=device.createTexture({label:'cannon smoke opaque depth',size:[width,height],format:'r32float',usage:T.STORAGE_BINDING|T.TEXTURE_BINDING});
        depthSource=null;volumeGroup=device.createBindGroup({layout:pipelines[1].getBindGroupLayout(0),entries:volumeEntries()});
      }
      if(source!==depthSource){depthSource=source;depthGroup=device.createBindGroup({layout:depthPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:source},{binding:1,resource:depthTexture.createView()}]});}
      const pass=encoder.beginComputePass({label:'cannon smoke scene depth'});pass.setPipeline(depthPipeline);pass.setBindGroup(0,depthGroup);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();depthReady=true;return true;
    },
    draw(pass){
      if(impactCount){
        pass.setPipeline(pipelines[2]);pass.setBindGroup(0,groups[2]);pass.draw(GUNNERY_CROWN_SEGMENTS*GUNNERY_CROWN_ROWS*6,impactCount);
        pass.setPipeline(pipelines[3]);pass.setBindGroup(0,groups[3]);pass.draw(6,impactCount*GUNNERY_DROP_COUNT);
        pass.setPipeline(pipelines[4]);pass.setBindGroup(0,groups[4]);if(ringWaves)pass.setBindGroup(1,ringWaves[surfaceWaves.current]);pass.draw(GUNNERY_RING_SEGMENTS*GUNNERY_RING_COUNT*6,impactCount);
      }
      if(volumeCount&&depthReady){pass.setPipeline(pipelines[1]);pass.setBindGroup(0,volumeGroup);pass.draw(36,volumeCount);}
    },
    clear(){state.clear();volumeCount=impactCount=ballCount=0;depthReady=false;},
    destroy(){volumeBuffer.destroy();ballBuffer.destroy();contactBuffer.destroy();depthTexture?.destroy();},
  };
}
