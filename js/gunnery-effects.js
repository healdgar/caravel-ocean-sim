// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {GUNNERY_RENDER,GUNNERY_DEPTH_RESOLVE,GUNNERY_CROWN_SEGMENTS,GUNNERY_CROWN_ROWS,GUNNERY_DROP_COUNT,GUNNERY_RING_SEGMENTS,GUNNERY_RING_COUNT} from './wgsl/gunnery.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {surfaceWaveGroups} from './surface-bindings.js';

export const GUNNERY_FX_LIMITS=Object.freeze({shots:128,smoke:512,impacts:96,projectiles:128,arcSegments:256,smokeSeconds:18,impactSeconds:8,flashSeconds:.085});
const gunneryFxFinite=(v,fallback=0)=>Number.isFinite(v)?v:fallback;
const gunneryFxVector=(v,fallback=[0,0,0])=>fallback.map((n,i)=>gunneryFxFinite(v?.[i],n));
const gunneryFxClamp=(n,a,b)=>Math.max(a,Math.min(b,n));

// Effects consume the physics system's actual shot and water-contact events.
// They never infer a hit, integrate roundshot, or add a tracer to an iron ball.
export function createGunneryEffectState(){
  const shots=[],impacts=[],projectiles=[],aimArcs=[];let serial=0;
  function emitShot(event={}){
    if(!Array.isArray(event.position)&&!ArrayBuffer.isView(event.position))return false;
    if(!event.position.every(Number.isFinite))return false;
    const direction=gunneryFxVector(event.direction,[1,0,0]),length=Math.hypot(...direction);
    if(length<1e-8)return false;
    if(shots.length===GUNNERY_FX_LIMITS.shots)shots.shift();
    shots.push({id:event.id??++serial,position:gunneryFxVector(event.position),direction:direction.map(v=>v/length),age:0,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.chargeKg,3)/2.2),.82,2.25),seed:(++serial*.61803398875)%1,
      drift:[0,0,0],driftVelocity:[0,0,0]});return true;
  }
  function emitImpact(event={}){
    if((!Array.isArray(event.position)&&!ArrayBuffer.isView(event.position))||!event.position.every(Number.isFinite))return false;
    const velocity=gunneryFxVector(event.velocity),speed=Math.hypot(...velocity);
    if(speed<.1)return false;
    if(impacts.length===GUNNERY_FX_LIMITS.impacts)impacts.shift();
    const kindCode=event.kind==='ship'?1:(event.kind==='terrain'||event.kind==='scenery')?2:event.kind==='building'?3:0;
    impacts.push({id:event.id??++serial,position:gunneryFxVector(event.position),velocity,age:0,seed:(++serial*.61803398875)%1,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.massKg,12)/12),.4,1.6),wind:[0,0,0],kindCode});return true;
  }
  function setProjectiles(values=[]){
    projectiles.length=0;
    for(const p of values){
      if(projectiles.length===GUNNERY_FX_LIMITS.projectiles)break;
      if(!p?.position||p.position.length!==3||!Array.from(p.position).every(Number.isFinite))continue;
      const item={id:p.id,position:gunneryFxVector(p.position),radius:gunneryFxClamp(gunneryFxFinite(p.radius,.075),.015,.3)};
      if(p.ammo&&p.ammo!=='round')item.ammo=p.ammo;
      if(p.velocity)item.velocity=gunneryFxVector(p.velocity);
      if(Number.isFinite(p.age))item.age=p.age;
      projectiles.push(item);
    }
  }
  function setAimArcs(values=[]){
    aimArcs.length=0;
    if(!Array.isArray(values))return;
    for(const seg of values){
      if(aimArcs.length>=GUNNERY_FX_LIMITS.arcSegments)break;
      if(!seg?.p0||!seg?.p1||!seg?.style)continue;
      if(!seg.p0.every(Number.isFinite)||!seg.p1.every(Number.isFinite)||!seg.style.every(Number.isFinite))continue;
      aimArcs.push({
        p0:[seg.p0[0],seg.p0[1],seg.p0[2],seg.p0[3]],
        p1:[seg.p1[0],seg.p1[1],seg.p1[2],seg.p1[3]],
        style:[seg.style[0],seg.style[1],seg.style[2],seg.style[3]],
      });
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
  return {shots,impacts,projectiles,aimArcs,emitShot,emitImpact,setProjectiles,setAimArcs,step,
    get active(){return !!(shots.length||impacts.length||projectiles.length||aimArcs.length);},
    clear(){shots.length=impacts.length=projectiles.length=aimArcs.length=0;},
  };
}

// A small number of connected, expanding volumes per muzzle replaces smoke
// cards. These are bounded authored black-powder billows, not a fluid solver.
export function gunnerySmokeParcel(shot,index){
  const t=shot.age-index*.022;if(t<0)return null;
  const direction=shot.direction,scale=shot.scale;
  const travel=(.42+index*1.18)+(12.2-index*1.55)*(1-Math.exp(-t/(.26+index*.085)))*scale;
  const across=(.58+3.45*Math.pow(t,.70))*scale*(1-index*.06);
  const along=(.92+Math.min(t,.48)*(8.6-index*1.0)+t*.98)*scale;
  const centre=shot.position.map((v,k)=>v+direction[k]*travel+shot.drift[k]);
  centre[1]+=(.64*t+.72*(1-Math.exp(-t/.82)))*scale;
  const eddy=across*Math.min(1,t*.85)*.28,phase=shot.seed*37+index*2.4;
  const transverse=[direction[2],0,-direction[0]],transverseLength=Math.hypot(...transverse)||1;
  for(let k=0;k<3;k++)centre[k]+=transverse[k]/transverseLength*Math.sin(phase)*eddy;
  centre[1]+=Math.cos(phase)*eddy*.65;
  const vertical=across*(1.12+.14*Math.sin(shot.seed*17+index)+.22*Math.min(1,t*.4));
  // Random phase changes contours; no per-frame random spawning or even rows.
  // Black powder produces a substantial condensed aerosol load. A single
  // fresh discharge must obscure its own gun, and adjacent guns must combine
  // into a dense cloud-like bank before dilution clears it.
  const extinction=(148-index*20)*scale**3/(across*across*along)*Math.exp(-t/10.5)*(1-gunneryFxClamp((t-13)/5,0,1));
  return {centre,radii:[across,vertical,along],direction,extinction,age:t,seed:shot.seed*79+index*11};
}

export async function createGunneryEffects({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,surfaceWaves=null}){
  const state=createGunneryEffectState(),B=GPUBufferUsage,T=GPUTextureUsage;
  const volumes=new Float32Array((GUNNERY_FX_LIMITS.smoke+GUNNERY_FX_LIMITS.shots)*20);
  const balls=new Float32Array(GUNNERY_FX_LIMITS.projectiles*4),contacts=new Float32Array(GUNNERY_FX_LIMITS.impacts*16);
  const arcs=new Float32Array(GUNNERY_FX_LIMITS.arcSegments*12);
  const make=(label,bytes)=>device.createBuffer({label,size:bytes,usage:B.STORAGE|B.COPY_DST});
  const volumeBuffer=make('black powder smoke volumes',volumes.byteLength),ballBuffer=make('iron roundshot positions',balls.byteLength),contactBuffer=make('roundshot water contacts',contacts.byteLength),arcBuffer=make('ballistic aiming arcs',arcs.byteLength);
  const source=surfaceWaves?coupleSurfaceHeight(GUNNERY_RENDER,'gunnerySeaDisplacement(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'gunnerySeaSampler'}):GUNNERY_RENDER;
  const module=await shader(source,'black powder cannon effects');
  const transparent={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const types=[['gunneryBall',false],['gunneryVolume',true],['gunneryCrown',true],['gunneryDrop',true],['gunneryRing',true],['gunneryArc',true]];
  const pipelines=await Promise.all(types.map(([entry,blend],i)=>device.createRenderPipelineAsync({label:entry,layout:'auto',
    vertex:{module,entryPoint:entry+'VS'},fragment:{module,entryPoint:entry+'FS',targets:[{format,...(blend?{blend:transparent}:{})}]},
    primitive:{topology:'triangle-list',cullMode:i===1?'front':'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:i===0,depthCompare:i===1?'always':'greater'},multisample:{count:samples}})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler,{buffer:volumeBuffer},{buffer:ballBuffer},{buffer:contactBuffer},null,{buffer:arcBuffer}];
  // Auto layouts reflect each entry point. Keep this table explicit so resource
  // changes are checked by native pipeline creation and integration tests.
  const bindings=[[0,1,2,3,4,5,9],[0,1,2,3,5,8,11],[0,1,2,3,4,5,10],[0,1,2,3,4,5,10],[0,1,2,3,4,5,6,7,10],[0,1,2,3,5,12]];
  const ringWaves=surfaceWaveGroups(device,pipelines[4],surfaceWaves);
  let volumeCount=0,impactCount=0,ballCount=0,arcSegmentCount=0,depthTexture=null,depthWidth=0,depthHeight=0,depthSource=null,depthGroup=null;
  let volumeGroup=null,depthReady=false;
  const groups=pipelines.map((pipe,i)=>i===1?null:device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:bindings[i].map(binding=>({binding,resource:resources[binding]}))}));
  const depthModule=await shader(GUNNERY_DEPTH_RESOLVE(samples),'cannon effects depth snapshot');
  const depthPipeline=await device.createComputePipelineAsync({label:'resolve cannon effects depth',layout:'auto',compute:{module:depthModule,entryPoint:'gunneryResolveDepth'}});
  const volumeEntries=()=>bindings[1].map(binding=>({binding,resource:binding===11?depthTexture.createView():resources[binding]}));
  function writeVolume(at,centre,direction,radii,type,extinction,age,seed,subtype=0){
    let right=[direction[2],0,-direction[0]],length=Math.hypot(...right);
    if(length<1e-6){right=[1,0,0];length=1;}
    right=right.map(v=>v/length);
    const up=[direction[1]*right[2]-direction[2]*right[1],direction[2]*right[0]-direction[0]*right[2],direction[0]*right[1]-direction[1]*right[0]];
    volumes.set([...centre,type,...right,radii[0],...up,radii[1],...direction,radii[2],extinction,age,seed,subtype],at*20);
  }
  return {state,emitShot:state.emitShot,emitImpact:state.emitImpact,setProjectiles:state.setProjectiles,setAimArcs:state.setAimArcs,
    get active(){return state.active;},get transparentActive(){return !!(volumeCount||impactCount||arcSegmentCount);},
    get counts(){return {volumes:volumeCount,impacts:impactCount,projectiles:ballCount,arcs:arcSegmentCount};},
    update(dt,options={}){
      state.step(dt,options);depthReady=false;volumeCount=impactCount=ballCount=arcSegmentCount=0;
      const fires=Array.isArray(options.fires)?options.fires:[];
      if(!state.active&&!fires.length)return;
      const eye=gunneryFxVector(options.eye),ordered=[];
      const coalesce=state.shots.length>6;
      for(const shot of state.shots){
        const parcelsPerShot=state.shots.length>52?2:3;
        for(let k=0;k<parcelsPerShot;k++){
          const p=gunnerySmokeParcel(shot,k);
          if(!p||p.extinction<.015)continue;
          if(coalesce&&shot.age>.25){
            const mergeR2=(Math.max(1.8,p.radii[0]*.68))**2;
            let merged=false;
            for(let mIdx=0;mIdx<ordered.length;mIdx++){
              const m=ordered[mIdx];
              if(m.type!==0||Math.abs(m.age-p.age)>1.35)continue;
              const dx=m.centre[0]-p.centre[0],dy=m.centre[1]-p.centre[1],dz=m.centre[2]-p.centre[2];
              if(dx*dx+dy*dy+dz*dz<=mergeR2){
                const w=p.extinction/(m.extinction+p.extinction+1e-6);
                for(let c=0;c<3;c++){
                  m.centre[c]+=((p.centre[c]-m.centre[c])*w*.35);
                  m.radii[c]=Math.min(24,Math.max(m.radii[c],p.radii[c])*(1+.045*w));
                }
                m.extinction=Math.min(26,m.extinction+p.extinction*.42);
                merged=true;
                break;
              }
            }
            if(merged)continue;
          }
          ordered.push({...p,type:0});
        }
        if(shot.age<GUNNERY_FX_LIMITS.flashSeconds){
          const t=shot.age/GUNNERY_FX_LIMITS.flashSeconds;
          ordered.push({centre:shot.position.map((v,k)=>v+shot.direction[k]*(.55+1.1*t)*shot.scale),direction:shot.direction,
            radii:[(.12+.35*Math.sin(t*Math.PI))*shot.scale,(.12+.28*Math.sin(t*Math.PI))*shot.scale,(.6+1.1*Math.sin(t*Math.PI))*shot.scale],
            type:1,extinction:1-t,age:shot.age,seed:shot.seed*79});
        }
      }
      for(const e of state.impacts){
        if(!(e.kindCode>0)||e.age>=5.5)continue;
        const sc=Math.max(0.6,e.scale??1.0),age=e.age;
        if(age<0.12){
          const ft=age/0.12;
          const rFlash=(0.45+0.95*Math.sin(ft*Math.PI))*sc;
          ordered.push({
            centre:[e.position[0],e.position[1]+0.25*sc,e.position[2]],
            direction:[0,1,0],
            radii:[rFlash,rFlash*1.15,rFlash],
            type:1,
            extinction:(1-ft)*0.95,
            age,
            seed:e.seed*61,
          });
        }
        const expand=(0.85+2.35*Math.pow(age,0.58))*sc;
        const fade=Math.exp(-age/2.4)*(1-gunneryFxClamp((age-4.2)/1.3,0,1));
        const ext=(4.8*sc/(expand*0.65))*fade;
        if(ext>0.02){
          const w=e.wind??[0,0,0];
          ordered.push({
            centre:[
              e.position[0]+w[0]*age*0.28,
              e.position[1]+(0.55+1.35*Math.pow(age,0.65))*sc,
              e.position[2]+w[2]*age*0.28,
            ],
            direction:[0,1,0],
            radii:[expand,expand*1.18,expand],
            type:0,
            extinction:ext,
            age:age*0.8,
            seed:e.seed*83,
          });
        }
      }
      for(const f of fires){
        if(!f?.position||!(f.intensity>0.02))continue;
        const pos=gunneryFxVector(f.position),int=gunneryFxClamp(f.intensity,0.05,1.6),age=gunneryFxFinite(f.age,0),seed=gunneryFxFinite(f.seed,1.7);
        const wind=gunneryFxVector(options.wind);
        const pulse=0.88+0.14*Math.sin(age*11.3+seed*19.0)+0.08*Math.cos(age*19.7-seed*7.3);
        const rHoriz=(0.58+0.68*int)*pulse;
        const rVert=(1.05+1.35*int)*pulse;
        // 1. Primary roaring shipboard flame volume (direction=[0,1,0] -> radii[2] is vertical)
        ordered.push({
          centre:[pos[0]+wind[0]*0.04,pos[1]+0.55*rVert,pos[2]+wind[2]*0.04],
          direction:[0,1,0],
          radii:[rHoriz,rHoriz,rVert],
          type:1,
          subtype:1.0,
          extinction:0.95+0.85*int,
          age,
          seed:seed*53,
        });
        // 2. Upper flickering flame tongues & rising hot embers
        const tongueFlicker=0.82+0.24*Math.sin(age*16.4+seed*31.0);
        ordered.push({
          centre:[
            pos[0]+wind[0]*0.14+Math.sin(age*6.7+seed*13.0)*0.22*int,
            pos[1]+1.15*rVert,
            pos[2]+wind[2]*0.14+Math.cos(age*5.9+seed*17.0)*0.22*int,
          ],
          direction:[0,1,0],
          radii:[rHoriz*0.72*tongueFlicker,rHoriz*0.72*tongueFlicker,rVert*0.85*tongueFlicker],
          type:1,
          subtype:1.25,
          extinction:(0.68+0.62*int)*tongueFlicker,
          age:age*1.35+1.7,
          seed:seed*71+13,
        });
        // 3. Cycling, rising & wind-drifting dark pitch/tar smoke plume (3 overlapping parcels)
        const period=5.4;
        for(let pIdx=0;pIdx<3;pIdx++){
          const phase=((age+pIdx*(period/3)+seed*2.1)%period)/period;
          const env=Math.sin(phase*Math.PI);
          if(env<0.04)continue;
          const rise=(1.35+phase*6.8)*(0.75+0.55*int);
          const drift=phase*phase*2.4;
          const radH=(0.95+phase*2.45)*(0.75+0.55*int);
          const radV=(1.15+phase*2.85)*(0.75+0.55*int);
          ordered.push({
            centre:[
              pos[0]+wind[0]*drift+Math.sin(phase*6.28+seed*11+pIdx)*0.28,
              pos[1]+rise,
              pos[2]+wind[2]*drift+Math.cos(phase*6.28+seed*17+pIdx)*0.28,
            ],
            direction:[0,1,0],
            radii:[radH,radH,radV],
            type:0,
            subtype:2.0+phase*0.8,
            extinction:(3.6*int*env)/Math.max(1.0,radH*0.55),
            age:age*0.45+pIdx*3.1,
            seed:seed*97+pIdx*29,
          });
        }
      }
      ordered.sort((a,b)=>b.centre.reduce((sum,v,k)=>sum+(v-eye[k])**2,0)-a.centre.reduce((sum,v,k)=>sum+(v-eye[k])**2,0));
      const maxVolumes=Math.min(256,GUNNERY_FX_LIMITS.smoke+GUNNERY_FX_LIMITS.shots);
      const selected=ordered.length>maxVolumes?ordered.slice(ordered.length-maxVolumes):ordered;
      for(const p of selected){if(volumeCount>=maxVolumes)break;writeVolume(volumeCount++,p.centre,p.direction,p.radii,p.type,p.extinction,p.age,p.seed,p.subtype??0);}
      for(const p of state.projectiles){
        if(ballCount>=GUNNERY_FX_LIMITS.projectiles)break;
        const signedRadius=p.ammo==='hot'?-p.radius:p.radius;
        if(p.ammo==='chain'&&ballCount+1<GUNNERY_FX_LIMITS.projectiles){
          const spin=(p.age??0)*24.0+(p.id??0)*1.7;
          const offX=Math.cos(spin)*p.radius*2.2,offY=Math.sin(spin)*p.radius*1.4;
          balls.set([p.position[0]+offX,p.position[1]+offY,p.position[2],p.radius*0.88],ballCount++*4);
          balls.set([p.position[0]-offX,p.position[1]-offY,p.position[2],p.radius*0.88],ballCount++*4);
        }else{
          balls.set([...p.position,signedRadius],ballCount++*4);
        }
      }
      for(const e of state.impacts){contacts.set([...e.position,e.age,...e.velocity,e.scale,e.seed,...e.wind,e.kindCode??0,0,0,0],impactCount++*16);}
      for(const seg of state.aimArcs){
        if(arcSegmentCount>=GUNNERY_FX_LIMITS.arcSegments)break;
        arcs.set([...seg.p0,...seg.p1,...seg.style],arcSegmentCount++*12);
      }
      if(volumeCount)device.queue.writeBuffer(volumeBuffer,0,volumes,0,volumeCount*20);
      if(ballCount)device.queue.writeBuffer(ballBuffer,0,balls,0,ballCount*4);
      if(impactCount)device.queue.writeBuffer(contactBuffer,0,contacts,0,impactCount*16);
      if(arcSegmentCount)device.queue.writeBuffer(arcBuffer,0,arcs,0,arcSegmentCount*12);
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
      if(arcSegmentCount){
        pass.setPipeline(pipelines[5]);pass.setBindGroup(0,groups[5]);pass.draw(6,arcSegmentCount);
      }
      if(impactCount){
        pass.setPipeline(pipelines[2]);pass.setBindGroup(0,groups[2]);pass.draw(GUNNERY_CROWN_SEGMENTS*GUNNERY_CROWN_ROWS*6,impactCount);
        pass.setPipeline(pipelines[3]);pass.setBindGroup(0,groups[3]);pass.draw(6,impactCount*GUNNERY_DROP_COUNT);
        pass.setPipeline(pipelines[4]);pass.setBindGroup(0,groups[4]);if(ringWaves)pass.setBindGroup(1,ringWaves[surfaceWaves.current]);pass.draw(GUNNERY_RING_SEGMENTS*GUNNERY_RING_COUNT*6,impactCount);
      }
      if(volumeCount&&depthReady){pass.setPipeline(pipelines[1]);pass.setBindGroup(0,volumeGroup);pass.draw(36,volumeCount);}
    },
    clear(){state.clear();volumeCount=impactCount=ballCount=arcSegmentCount=0;depthReady=false;},
    destroy(){volumeBuffer.destroy();ballBuffer.destroy();contactBuffer.destroy();arcBuffer.destroy();depthTexture?.destroy();},
  };
}
