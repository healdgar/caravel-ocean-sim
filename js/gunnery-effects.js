// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {GUNNERY_RENDER,GUNNERY_DEPTH_RESOLVE,GUNNERY_CROWN_SEGMENTS,GUNNERY_CROWN_ROWS,GUNNERY_DROP_COUNT,GUNNERY_RING_SEGMENTS,GUNNERY_RING_COUNT,GUNNERY_EARTH_COUNT,GUNNERY_DUST_COUNT} from './wgsl/gunnery.js';
import {landCraterSize} from './land-craters.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {isArrowAmmo} from './gunnery-state.js';
import {surfaceWaveGroups} from './surface-bindings.js';

// Smoke thinner than this draws nothing, so a parcel below it is not built and a shot wholly below it is dropped.
const GUNNERY_SMOKE_FLOOR=.015,GUNNERY_SMOKE_PARCELS=3,GUNNERY_MAX_VOLUMES=256;
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
    // A tree or timber jetty throws splinters as a hull does.
    const kindCode=event.kind==='ship'||event.kind==='scenery'||event.kind==='jetty'?1:event.kind==='terrain'?2:event.kind==='building'?3:0;
    // Every solid strike (hull timber, earth, or masonry) throws debris and dust from its contact energy, never powder smoke.
    const pit=kindCode>0?landCraterSize(.5*gunneryFxFinite(event.massKg,12)*speed*speed).radius:0;
    impacts.push({id:event.id??++serial,position:gunneryFxVector(event.position),velocity,age:0,seed:(++serial*.61803398875)%1,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.massKg,12)/12),.4,1.6),wind:[0,0,0],kindCode,pit,sand:gunneryFxClamp(gunneryFxFinite(event.damageReport?.sand,0),0,1)});return true;
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
// A parcel's density depends on its age alone: the charge scales its size and its powder alike.
export function gunnerySmokeParcel(shot,index){
  const t=shot.age-index*.020;if(t<0)return null;
  const direction=shot.direction,scale=shot.scale;
  // Three overlapping, axially-connected plume sections (0: leading vortex head,
  // 1: turbulent mid-body, 2: trailing muzzle stem) that form one continuous tapered jet
  // early on and shear apart into drifting, wispy cloud banks as wind entrains them.
  const seedJitter=Math.sin(shot.seed*53+index*7.1)*.28;
  const travel=(.55+index*.32)+(8.6-index*1.85+seedJitter)*(1-Math.exp(-t/(.20+index*.06)))*scale;
  const across=(.36+1.75*Math.pow(t,.65))*scale*(1-index*.08);
  const along=(.95+Math.min(t,.45)*(4.4-index*.55)+t*1.18)*scale;
  const centre=shot.position.map((v,k)=>v+direction[k]*travel+shot.drift[k]);
  centre[1]+=(.78*t+.58*(1-Math.exp(-t/.65)))*(1+index*.14)*scale;
  const eddy=across*Math.min(1,t*.85)*.28,phase=shot.seed*37+index*.82+t*.55;
  const transverse=[direction[2],0,-direction[0]],transverseLength=Math.hypot(...transverse)||1;
  for(let k=0;k<3;k++)centre[k]+=transverse[k]/transverseLength*Math.sin(phase)*eddy;
  centre[1]+=Math.cos(phase)*eddy*.48;
  const vertical=across*(1.04+.15*Math.sin(shot.seed*17+index)+.24*Math.min(1,t*.45));
  const dilution=.46*Math.exp(-t/.92)+.54*Math.exp(-t/3.1);
  const extinction=(16.2-index*2.5)*scale**3/(across*across*along)*dilution;
  return {centre,radii:[across,vertical,along],direction,extinction,age:t,seed:shot.seed*79+index*11,subtype:index*.35};
}
// How long a discharge's smoke can be seen: the age at which its last parcel has thinned below the floor, found
// from the parcels themselves so it follows any retuning of them. About four seconds.
function gunnerySmokeLifetime(){
  const shot={age:0,position:[0,0,0],direction:[1,0,0],scale:1,seed:0,drift:[0,0,0]};
  let last=0;
  for(let age=.05;age<60;age+=.05){
    shot.age=age;
    for(let k=0;k<GUNNERY_SMOKE_PARCELS;k++)if(gunnerySmokeParcel(shot,k)?.extinction>=GUNNERY_SMOKE_FLOOR)last=age;
    if(age-last>2)break;
  }
  return Math.round((last+.1)*100)/100;
}
export const GUNNERY_FX_LIMITS=Object.freeze({shots:128,impacts:96,projectiles:128,arcSegments:256,volumes:GUNNERY_MAX_VOLUMES,smokeSeconds:gunnerySmokeLifetime(),impactSeconds:8,flashSeconds:.085});

export async function createGunneryEffects({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,surfaceWaves=null}){
  const state=createGunneryEffectState(),B=GPUBufferUsage,T=GPUTextureUsage;
  const volumes=new Float32Array(GUNNERY_FX_LIMITS.volumes*20);
  const balls=new Float32Array(GUNNERY_FX_LIMITS.projectiles*4),contacts=new Float32Array(GUNNERY_FX_LIMITS.impacts*16);
  const arcs=new Float32Array(GUNNERY_FX_LIMITS.arcSegments*12);
  const make=(label,bytes)=>device.createBuffer({label,size:bytes,usage:B.STORAGE|B.COPY_DST});
  const volumeBuffer=make('black powder smoke volumes',volumes.byteLength),ballBuffer=make('iron roundshot positions',balls.byteLength),contactBuffer=make('roundshot water contacts',contacts.byteLength),arcBuffer=make('ballistic aiming arcs',arcs.byteLength);
  const source=surfaceWaves?coupleSurfaceHeight(GUNNERY_RENDER,'gunnerySeaDisplacement(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'gunnerySeaSampler'}):GUNNERY_RENDER;
  const module=await shader(source,'black powder cannon effects');
  const transparent={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  const types=[['gunneryBall',false],['gunneryVolume',true],['gunneryCrown',true],['gunneryDrop',true],['gunneryRing',true],['gunneryArc',true],['gunneryEarth',true],['gunneryDust',true]];
  // Everything but the volumes draws in the scene's multisampled pass. The volumes march against a resolved copy of
  // its depth, so they draw afterwards, onto the resolved colour, in a pass with no depth and one sample.
  const pipelines=await Promise.all(types.map(([entry,blend],i)=>device.createRenderPipelineAsync({label:entry,layout:'auto',
    vertex:{module,entryPoint:entry+'VS'},fragment:{module,entryPoint:entry+'FS',targets:[{format,...(blend?{blend:transparent}:{})}]},
    primitive:{topology:'triangle-list',cullMode:i===1?'front':'none'},
    ...(i===1?{multisample:{count:1}}:{depthStencil:{format:'depth32float',depthWriteEnabled:i===0,depthCompare:'greater'},multisample:{count:samples}})})));
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler,{buffer:volumeBuffer},{buffer:ballBuffer},{buffer:contactBuffer},null,{buffer:arcBuffer}];
  // Auto layouts reflect each entry point. Keep this table explicit so resource
  // changes are checked by native pipeline creation and integration tests.
  const bindings=[[0,1,2,3,4,5,9],[0,1,2,3,5,8,11],[0,1,2,3,4,5,6,7,10],[0,1,2,3,4,5,10],[0,1,2,3,4,5,6,7,10],[0,1,2,3,5,12],[0,1,2,3,5,10],[0,1,2,3,5,10]];
  const crownWaves=surfaceWaveGroups(device,pipelines[2],surfaceWaves);
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
    get active(){return state.active;},get transparentActive(){return !!(volumeCount||impactCount||arcSegmentCount);},get volumesActive(){return !!volumeCount;},
    get counts(){return {volumes:volumeCount,impacts:impactCount,projectiles:ballCount,arcs:arcSegmentCount};},
    update(dt,options={}){
      state.step(dt,options);depthReady=false;volumeCount=impactCount=ballCount=arcSegmentCount=0;
      const fires=Array.isArray(options.fires)?options.fires:[];
      if(!state.active&&!fires.length)return;
      const eye=gunneryFxVector(options.eye),ordered=[];
      const coalesce=state.shots.length>6;
      for(const shot of state.shots){
        const parcelsPerShot=state.shots.length>52?2:GUNNERY_SMOKE_PARCELS;
        for(let k=0;k<parcelsPerShot;k++){
          const p=gunnerySmokeParcel(shot,k);
          if(!p||p.extinction<GUNNERY_SMOKE_FLOOR)continue;
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
                m.extinction=Math.min(4.2,m.extinction+p.extinction*.22);
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
      // Iron striking timber, stone or earth makes no flash and no powder smoke: its debris and dust are drawn from the contacts.
      for(const f of fires){
        if(!f?.position||!(f.intensity>0.02))continue;
        const pos=gunneryFxVector(f.position),int=gunneryFxClamp(f.intensity,0.05,1.6),age=gunneryFxFinite(f.age,0),seed=gunneryFxFinite(f.seed,1.7);
        const wind=gunneryFxVector(options.wind);
        const pulse=0.88+0.14*Math.sin(age*11.3+seed*19.0)+0.08*Math.cos(age*19.7-seed*7.3);
        const rHoriz=(0.56+0.60*int)*pulse;
        const rVert=(0.98+1.18*int)*pulse;
        // 1. Primary roaring shipboard/structure flame volume (direction=[0,1,0] -> radii[2] is vertical)
        ordered.push({
          centre:[pos[0]+wind[0]*0.03,pos[1]+0.38*rVert,pos[2]+wind[2]*0.03],
          direction:[0,1,0],
          radii:[rHoriz,rHoriz,rVert*1.05],
          type:1,
          subtype:1.0,
          extinction:0.92+0.74*int,
          age,
          seed:seed*53,
        });
        // 2. Upper flickering flame tongues & buoyant glowing ember crown
        const tongueFlicker=0.84+0.24*Math.sin(age*15.4+seed*31.0);
        ordered.push({
          centre:[
            pos[0]+wind[0]*0.12+Math.sin(age*6.3+seed*13.0)*0.24*int,
            pos[1]+0.96*rVert,
            pos[2]+wind[2]*0.12+Math.cos(age*5.7+seed*17.0)*0.24*int,
          ],
          direction:[0,1,0],
          radii:[rHoriz*0.84*tongueFlicker,rHoriz*0.84*tongueFlicker,rVert*0.96*tongueFlicker],
          type:1,
          subtype:1.30,
          extinction:(0.76+0.62*int)*tongueFlicker,
          age:age*1.35+1.7,
          seed:seed*71+13,
        });
        // 3. Cycling, rising & wind-drifting dense pitch/tar smoke column (6 overlapping parcels)
        const period=6.4;
        const smokeScale=1.05+0.88*int;
        for(let pIdx=0;pIdx<6;pIdx++){
          const phase=((age+pIdx*(period/6)+seed*2.1)%period)/period;
          const env=Math.pow(Math.sin(phase*Math.PI),0.62);
          if(env<0.04)continue;
          const rise=(1.35+phase*18.8)*smokeScale;
          const drift=phase*(1.1+phase*3.4);
          const radH=(1.48+phase*4.15)*smokeScale;
          const radV=(1.85+phase*4.75)*smokeScale;
          ordered.push({
            centre:[
              pos[0]+wind[0]*drift+Math.sin(phase*6.28+seed*11+pIdx)*0.55*smokeScale,
              pos[1]+rise,
              pos[2]+wind[2]*drift+Math.cos(phase*6.28+seed*17+pIdx)*0.55*smokeScale,
            ],
            direction:[0,1,0],
            radii:[radH,radH,radV],
            type:0,
            subtype:2.0+phase*0.8,
            extinction:(26.0+22.0*int)*env,
            age:age*0.45+pIdx*3.1,
            seed:seed*97+pIdx*29,
          });
        }
      }
      ordered.sort((a,b)=>b.centre.reduce((sum,v,k)=>sum+(v-eye[k])**2,0)-a.centre.reduce((sum,v,k)=>sum+(v-eye[k])**2,0));
      const maxVolumes=GUNNERY_FX_LIMITS.volumes;
      const selected=ordered.length>maxVolumes?ordered.slice(ordered.length-maxVolumes):ordered;
      for(const p of selected){if(volumeCount>=maxVolumes)break;writeVolume(volumeCount++,p.centre,p.direction,p.radii,p.type,p.extinction,p.age,p.seed,p.subtype??0);}
      for(const p of state.projectiles){
        if(ballCount>=GUNNERY_FX_LIMITS.projectiles)break;
        if(isArrowAmmo(p.ammo)&&p.velocity){
          if(ballCount+3>GUNNERY_FX_LIMITS.projectiles)break;
          const speed=Math.hypot(...p.velocity)||1,lit=p.ammo==='fire-arrow';
          for(const[back,radius]of[[0,lit?-.075:.022],[.32,.016],[.64,.016]]){
            balls.set([p.position[0]-p.velocity[0]/speed*back,p.position[1]-p.velocity[1]/speed*back,p.position[2]-p.velocity[2]/speed*back,radius],ballCount++*4);
          }
          continue;
        }
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
      for(const e of state.impacts){contacts.set([...e.position,e.age,...e.velocity,e.scale,e.seed,...e.wind,e.kindCode??0,e.pit??0,e.sand??0,0],impactCount++*16);}
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
        depthSource=null;
        volumeGroup=device.createBindGroup({layout:pipelines[1].getBindGroupLayout(0),entries:volumeEntries()});
      }
      // Keyed on the view itself: pass the same view each frame, or this makes a bind group a frame.
      if(source!==depthSource){depthSource=source;depthGroup=device.createBindGroup({layout:depthPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:source},{binding:1,resource:depthTexture.createView()}]});}
      const pass=encoder.beginComputePass({label:'cannon smoke scene depth'});pass.setPipeline(depthPipeline);pass.setBindGroup(0,depthGroup);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();depthReady=true;return true;
    },
    drawInPass(pass){
      if(arcSegmentCount){
        pass.setPipeline(pipelines[5]);pass.setBindGroup(0,groups[5]);pass.draw(6,arcSegmentCount);
      }
      if(impactCount){
        pass.setPipeline(pipelines[2]);pass.setBindGroup(0,groups[2]);if(crownWaves)pass.setBindGroup(1,crownWaves[surfaceWaves.current]);pass.draw(GUNNERY_CROWN_SEGMENTS*GUNNERY_CROWN_ROWS*6,impactCount);
        pass.setPipeline(pipelines[3]);pass.setBindGroup(0,groups[3]);pass.draw(6,impactCount*GUNNERY_DROP_COUNT);
        pass.setPipeline(pipelines[7]);pass.setBindGroup(0,groups[7]);pass.draw(6,impactCount*GUNNERY_DUST_COUNT);
        pass.setPipeline(pipelines[6]);pass.setBindGroup(0,groups[6]);pass.draw(6,impactCount*GUNNERY_EARTH_COUNT);
        pass.setPipeline(pipelines[4]);pass.setBindGroup(0,groups[4]);if(ringWaves)pass.setBindGroup(1,ringWaves[surfaceWaves.current]);pass.draw(GUNNERY_RING_SEGMENTS*GUNNERY_RING_COUNT*6,impactCount);
      }
    },
    // After the scene pass has ended and `resolveDepth` has run, in a pass on the resolved colour.
    drawVolumes(pass){
      if(volumeCount&&depthReady){pass.setPipeline(pipelines[1]);pass.setBindGroup(0,volumeGroup);pass.draw(36,volumeCount);}
    },
    clear(){state.clear();volumeCount=impactCount=ballCount=arcSegmentCount=0;depthReady=false;},
    destroy(){volumeBuffer.destroy();ballBuffer.destroy();contactBuffer.destroy();arcBuffer.destroy();depthTexture?.destroy();},
  };
}
