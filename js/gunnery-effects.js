// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {GUNNERY_RENDER,GUNNERY_BUILD,GUNNERY_NOISE,GUNNERY_NOISE_SIZE,GUNNERY_NOISE_LEVELS,GUNNERY_DEPTH_RESOLVE,GUNNERY_CROWN_SEGMENTS,GUNNERY_CROWN_ROWS,GUNNERY_DROP_COUNT,GUNNERY_RING_SEGMENTS,GUNNERY_RING_COUNT,GUNNERY_EARTH_COUNT,GUNNERY_DUST_COUNT,
  GUNNERY_FIRE_RECORD_FLOATS,GUNNERY_SMOKE_RECORD_FLOATS,GUNNERY_SMOKE_SECONDS,GUNNERY_BANK_LOBES,gunneryVolumeSlots,gunneryBankSeconds} from './wgsl/gunnery.js';
import {SIM_CLOCK_LOOP_S,FRAME_FIRE_SLOTS} from './wgsl/common.js';
import {landCraterSize} from './land-craters.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';
import {isArrowAmmo} from './gunnery-state.js';
import {surfaceWaveGroups} from './surface-bindings.js';

// shots: guns whose flash and jet of smoke are still in the air. banks: the smoke those guns leave between them.
// bankSeconds is the longest a bank hangs, in a dead calm; in a wind it is gone, and its record dropped, sooner.
export const GUNNERY_FX_LIMITS=Object.freeze({shots:128,banks:48,impacts:96,projectiles:128,arcSegments:256,fires:48,drawnVolumes:256,
  flashSeconds:GUNNERY_SMOKE_SECONDS.flash,jetSeconds:GUNNERY_SMOKE_SECONDS.jet,bankSeconds:GUNNERY_SMOKE_SECONDS.bank,impactSeconds:8});
// A record outlives what the GPU draws from it by this much, in seconds, so the two never disagree by a frame.
const GUNNERY_RECORD_MARGIN=Object.freeze({shot:.25,bank:1});
// Guns that fire within this many metres and seconds of one another, laid much the same way, share one bank.
export const GUNNERY_BANK_GROUPING=Object.freeze({metres:7.5,seconds:1.6,guns:10,alignment:.82});
const gunneryFxFinite=(v,fallback=0)=>Number.isFinite(v)?v:fallback;
const gunneryFxVector=(v,fallback=[0,0,0])=>fallback.map((n,i)=>gunneryFxFinite(v?.[i],n));
const gunneryFxClamp=(n,a,b)=>Math.max(a,Math.min(b,n));

// What the GPU has been told of each fire, and whether that still holds. The GPU draws and lights a fire
// from its record and the frame clock alone, so a record is rewritten only when the simulation's fire
// stops agreeing with it: lit, struck again, moved, doused, or its growth changing pace. A fire burning
// steadily sends nothing. Fires are matched by their place in the list handed in.
//   fires: {position | localPosition, intensity, age, seed}; hulls[i] names the hull fire i burns on, or -1.
export const GUNNERY_FIRE_TOLERANCE=.004;
export function createGunneryFireLedger(limit=GUNNERY_FX_LIMITS.fires){
  const width=GUNNERY_FIRE_RECORD_FLOATS,records=new Float32Array(limit*width);
  const slots=Array.from({length:limit},()=>({live:false,hull:-1,x:0,y:0,z:0,seed:0,at:0,intensity:0,rate:0,started:0,seen:0}));
  const burningHulls=new Set();
  let count=0,clock=0,first=limit,last=-1;
  const touch=k=>{if(k<first)first=k;if(k>last)last=k;};
  function write(k){
    const s=slots[k],o=k*width;
    if(!s.live){records.fill(0,o,o+width);return;}
    records[o]=s.x;records[o+1]=s.y;records[o+2]=s.z;records[o+3]=s.hull;
    records[o+4]=s.at;records[o+5]=s.intensity;records[o+6]=s.rate;records[o+7]=s.started;
    records[o+8]=s.seed;records[o+9]=1;records[o+10]=0;records[o+11]=0;
  }
  return {records,slots,burningHulls,width,
    get count(){return count;},
    // What the GPU will make of fire k at this clock.
    intensity(k,time){const s=slots[k];return s.live?gunneryFxClamp(s.intensity+s.rate*(time-s.at),0,1.65):0;},
    // Returns the span of records that changed, or null when the GPU already has it right.
    sync(fires,hulls,time){
      first=limit;last=-1;
      // The frame clock starts again every SIM_CLOCK_LOOP_S; records move back with it.
      if(time<clock-SIM_CLOCK_LOOP_S*.5)for(let k=0;k<count;k++){const s=slots[k];if(!s.live)continue;s.at-=SIM_CLOCK_LOOP_S;s.started-=SIM_CLOCK_LOOP_S;write(k);touch(k);}
      clock=time;
      const n=Math.min(limit,fires?.length??0);
      for(let k=0;k<n;k++){
        const f=fires[k],s=slots[k],hull=Number.isInteger(hulls?.[k])&&hulls[k]>=0&&f?.localPosition?hulls[k]:-1;
        const at=hull>=0?f.localPosition:f?.position,intensity=gunneryFxFinite(f?.intensity);
        if(!at||!(intensity>.02)||![at[0],at[1],at[2]].every(Number.isFinite)){if(s.live){s.live=false;write(k);touch(k);}continue;}
        const seed=gunneryFxFinite(f.seed,1.7),age=Math.max(0,gunneryFxFinite(f.age));
        const same=s.live&&s.hull===hull&&s.seed===seed;
        const moved=!same||Math.abs(s.x-at[0])+Math.abs(s.y-at[1])+Math.abs(s.z-at[2])>1e-3;
        // Its pace since the record was last written. A blow that fed or doused it is no pace: it shows as a
        // jump no burning makes in one step, and the pace it had is kept.
        const struck=Math.abs(intensity-s.seen)>.02;
        const pace=same&&!struck&&time-s.at>1e-4?(intensity-s.intensity)/(time-s.at):s.rate;
        s.seen=intensity;
        const drifted=!same||Math.abs(gunneryFxClamp(s.intensity+s.rate*(time-s.at),0,1.65)-intensity)>GUNNERY_FIRE_TOLERANCE;
        const restarted=!same||Math.abs(time-s.started-age)>.5;
        if(!moved&&!drifted&&!restarted)continue;
        s.live=true;s.hull=hull;s.x=at[0];s.y=at[1];s.z=at[2];s.seed=seed;s.at=time;s.intensity=intensity;
        s.rate=!same?0:Math.abs(pace)<=.1?pace:s.rate;
        if(restarted)s.started=time-age;
        write(k);touch(k);
      }
      for(let k=n;k<count;k++)if(slots[k].live){slots[k].live=false;write(k);touch(k);}
      count=n;
      burningHulls.clear();for(let k=0;k<count;k++)if(slots[k].live&&slots[k].hull>=0)burningHulls.add(slots[k].hull);
      return last<0?null:{first,last};
    },
    clear(){
      const had=count;for(let k=0;k<count;k++)slots[k].live=false;
      records.fill(0);count=0;burningHulls.clear();return had>0?{first:0,last:had-1}:null;
    },
  };
}

// Effects consume the physics system's actual shot and water-contact events.
// They never infer a hit, integrate roundshot, or add a tracer to an iron ball.
//
// A shot or a strike is a record of what happened and when, by the frame's clock. Nothing here moves smoke
// or ages a splash: the GPU works out where everything is from those records each frame. This only keeps the
// lists bounded, drops what has blown away, and says which records are new (fresh) so they are sent once.
export function createGunneryEffectState(){
  const shots=[],banks=[],impacts=[],projectiles=[],aimArcs=[],fresh={shots:[],banks:new Set(),impacts:false};
  let serial=0,generation=0,clock=0,shotSlot=0,bankSlot=0;
  // Seconds since a record's clock, allowing for the clock starting again.
  const since=birth=>{const age=clock-birth;return age<-1?age+SIM_CLOCK_LOOP_S:age;};
  // The bank this shot's smoke joins: one its neighbours have just begun, or a new one of its own.
  function joinBank(shot){
    const G=GUNNERY_BANK_GROUPING,mass=shot.scale**3;
    for(let i=banks.length-1;i>=0&&i>=banks.length-8;i--){
      const b=banks[i];
      if(b.guns>=G.guns||since(b.birth)>G.seconds)continue;
      const d=shot.position.map((v,k)=>v-b.position[k]);
      if(Math.hypot(...d)>G.metres||b.direction.reduce((sum,v,k)=>sum+v*shot.direction[k],0)<G.alignment)continue;
      const total=b.strength+mass,share=mass/total;
      const aim=b.direction.map((v,k)=>v+(shot.direction[k]-v)*share),length=Math.hypot(...aim)||1;
      // How far along her side the bank's guns stand, measured across the line of fire from its first gun.
      const along=(shot.position[0]-b.first[0])*b.across[0]+(shot.position[2]-b.first[2])*b.across[1];
      b.low=Math.min(b.low,along);b.high=Math.max(b.high,along);b.span=(b.high-b.low)/2;
      for(let k=0;k<3;k++){b.position[k]+=d[k]*share;b.direction[k]=aim[k]/length;}
      b.strength=total;b.guns++;fresh.banks.add(b);return b;
    }
    if(banks.length===GUNNERY_FX_LIMITS.banks)banks.shift();
    const flat=Math.hypot(shot.direction[2],shot.direction[0])||1;
    const bank={position:[...shot.position],direction:[...shot.direction],strength:mass,guns:1,span:0,low:0,high:0,first:[...shot.position],
      across:[shot.direction[2]/flat,-shot.direction[0]/flat],seed:shot.seed,birth:clock,slot:bankSlot,generation:++generation};
    bankSlot=(bankSlot+1)%GUNNERY_FX_LIMITS.banks;banks.push(bank);fresh.banks.add(bank);return bank;
  }
  function emitShot(event={}){
    if(!Array.isArray(event.position)&&!ArrayBuffer.isView(event.position))return false;
    if(!event.position.every(Number.isFinite))return false;
    const direction=gunneryFxVector(event.direction,[1,0,0]),length=Math.hypot(...direction);
    if(length<1e-8)return false;
    if(shots.length===GUNNERY_FX_LIMITS.shots)shots.shift();
    const shot={id:event.id??++serial,position:gunneryFxVector(event.position),direction:direction.map(v=>v/length),birth:clock,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.chargeKg,3)/2.2),.82,2.25),seed:(++serial*.61803398875)%1,slot:shotSlot,generation:++generation};
    shotSlot=(shotSlot+1)%GUNNERY_FX_LIMITS.shots;shot.bank=joinBank(shot);shots.push(shot);fresh.shots.push(shot);return true;
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
    impacts.push({id:event.id??++serial,position:gunneryFxVector(event.position),velocity,birth:clock,seed:(++serial*.61803398875)%1,
      scale:gunneryFxClamp(Math.cbrt(gunneryFxFinite(event.massKg,12)/12),.4,1.6),kindCode,pit,sand:gunneryFxClamp(gunneryFxFinite(event.damageReport?.sand,0),0,1)});
    fresh.impacts=true;return true;
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
  // time is the frame's clock; without one, the clock is the sum of the steps. wind is the frame's wind, metres a second.
  function step(dt,{time,wind}={}){
    clock=Number.isFinite(time)?time:clock+gunneryFxClamp(gunneryFxFinite(dt),0,.25);
    // Oldest first. A record is kept while the GPU draws smoke from it and no longer: a jet for its few seconds, a
    // bank until this wind has torn it up. Once the last has gone nothing is built, sorted or drawn for smoke.
    const bankSeconds=gunneryBankSeconds(Math.hypot(gunneryFxFinite(wind?.[0]),gunneryFxFinite(wind?.[2])))+GUNNERY_RECORD_MARGIN.bank;
    while(shots.length&&since(shots[0].birth)>=GUNNERY_FX_LIMITS.jetSeconds+GUNNERY_RECORD_MARGIN.shot)shots.shift();
    while(banks.length&&since(banks[0].birth)>=bankSeconds)banks.shift();
    while(impacts.length&&since(impacts[0].birth)>=GUNNERY_FX_LIMITS.impactSeconds){impacts.shift();fresh.impacts=true;}
  }
  return {shots,banks,impacts,projectiles,aimArcs,fresh,emitShot,emitImpact,setProjectiles,setAimArcs,step,since,
    get clock(){return clock;},
    // Whether any powder smoke is in the air. A strike's splinters, dust and spray are no smoke.
    get smoke(){return !!(shots.length||banks.length);},
    get active(){return !!(shots.length||banks.length||impacts.length||projectiles.length||aimArcs.length);},
    clear(){shots.length=banks.length=impacts.length=projectiles.length=aimArcs.length=0;fresh.shots.length=0;fresh.banks.clear();fresh.impacts=true;},
  };
}

// hulls: the scene's hull transforms, one 96-byte record a vessel, bound for reading as storage. A fire aboard
// follows the record its hull index names.
export async function createGunneryEffects({device,frameUBO,transView,skyView,sampler,envView,sunVis,seaView,seaSampler,shader,format='rgba16float',samples=4,surfaceWaves=null,hulls=null,hullCount=1}){
  const state=createGunneryEffectState(),B=GPUBufferUsage,T=GPUTextureUsage,L=GUNNERY_FX_LIMITS;
  const slots=gunneryVolumeSlots(L),width=GUNNERY_SMOKE_RECORD_FLOATS;
  const balls=new Float32Array(L.projectiles*4),contacts=new Float32Array(L.impacts*16),arcs=new Float32Array(L.arcSegments*12);
  const shotRecords=new Float32Array(L.shots*width),bankRecords=new Float32Array(L.banks*width);
  const make=(label,bytes,usage=B.STORAGE|B.COPY_DST)=>device.createBuffer({label,size:bytes,usage});
  // Every volume drawn is written here by the GPU; nothing uploads to it.
  const volumeBuffer=make('black powder smoke volumes',slots.total*80,B.STORAGE|B.COPY_SRC),ballBuffer=make('iron roundshot positions',balls.byteLength),contactBuffer=make('roundshot water contacts',contacts.byteLength),arcBuffer=make('ballistic aiming arcs',arcs.byteLength);
  const shotBuffer=make('cannon smoke shots',shotRecords.byteLength),bankBuffer=make('cannon smoke banks',bankRecords.byteLength);
  const stateBuffer=make('cannon smoke wind carry',32+(L.shots+L.banks)*16,B.STORAGE);
  const fires=createGunneryFireLedger(L.fires),hullSlots=Math.max(1,Math.floor(hullCount));
  const fireBuffer=make('fires burning',fires.records.byteLength),orderBuffer=make('cannon smoke draw order',slots.total*4,B.STORAGE);
  // The sort leaves the volumes' indirect draw here, and after it the workgroups the depth snapshot is dispatched with.
  const drawBuffer=make('cannon smoke indirect draw',32,B.STORAGE|B.INDIRECT|B.COPY_SRC),DEPTH_DISPATCH_OFFSET=16;
  const countBuffer=make('cannon smoke volume counts',16,B.UNIFORM|B.COPY_DST);
  const lightBuffer=make('fire lights',32+Math.ceil(hullSlots/4)*16,B.STORAGE|B.COPY_SRC);
  const ownHulls=hulls?null:make('cannon effects stand-in hull',96,B.STORAGE|B.COPY_DST);
  // counts: fires burning, the most volumes drawn, and the workgroups that cover the scene's depth (set in resolveDepth).
  const hullBuffer=hulls??ownHulls,counts=new Uint32Array([0,L.drawnVolumes,0,0]),sentCounts=counts.slice();
  device.queue.writeBuffer(countBuffer,0,counts);
  // The billows all smoke is carved from: made once, here, on the GPU, then halved three times over.
  const noise=device.createTexture({label:'cannon smoke billows',size:[GUNNERY_NOISE_SIZE,GUNNERY_NOISE_SIZE,GUNNERY_NOISE_SIZE],dimension:'3d',format:'rgba8unorm',mipLevelCount:GUNNERY_NOISE_LEVELS,usage:T.STORAGE_BINDING|T.TEXTURE_BINDING});
  const noiseSampler=device.createSampler({label:'cannon smoke billows',minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat'});
  {
    const noiseModule=await shader(GUNNERY_NOISE,'cannon smoke billows'),level=baseMipLevel=>noise.createView({baseMipLevel,mipLevelCount:1});
    const [make,halve]=await Promise.all(['gunneryMakeNoise','gunneryHalveNoise'].map(entryPoint=>device.createComputePipelineAsync({label:'cannon smoke billows',layout:'auto',compute:{module:noiseModule,entryPoint}})));
    const encoder=device.createCommandEncoder();
    let pass=encoder.beginComputePass({label:'cannon smoke billows'});
    pass.setPipeline(make);pass.setBindGroup(0,device.createBindGroup({layout:make.getBindGroupLayout(0),entries:[{binding:0,resource:level(0)}]}));
    pass.dispatchWorkgroups(GUNNERY_NOISE_SIZE/4,GUNNERY_NOISE_SIZE/4,GUNNERY_NOISE_SIZE/4);pass.end();
    for(let n=1;n<GUNNERY_NOISE_LEVELS;n++){
      // A pass of its own each: the level read was written by the one before.
      const groups=Math.max(1,(GUNNERY_NOISE_SIZE>>n)/4);pass=encoder.beginComputePass({label:'cannon smoke billows, halved'});
      pass.setPipeline(halve);pass.setBindGroup(0,device.createBindGroup({layout:halve.getBindGroupLayout(0),entries:[{binding:1,resource:level(n-1)},{binding:2,resource:level(n)}]}));
      pass.dispatchWorkgroups(groups,groups,groups);pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }
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
  const resources=[{buffer:frameUBO},transView,skyView,sampler,envView,{buffer:sunVis},seaView,seaSampler,{buffer:volumeBuffer},{buffer:ballBuffer},{buffer:contactBuffer},null,{buffer:arcBuffer},{buffer:orderBuffer},
    {buffer:stateBuffer},noise.createView(),noiseSampler];
  // Auto layouts reflect each entry point. Keep this table explicit so resource
  // changes are checked by native pipeline creation and integration tests.
  const bindings=[[0,1,2,3,4,5,9],[0,1,2,3,5,8,11,13,14,15,16],[0,1,2,3,4,5,6,7,10],[0,1,2,3,4,5,10],[0,1,2,3,4,5,6,7,10],[0,1,2,3,5,12],[0,1,2,3,5,10],[0,1,2,3,5,10]];
  const crownWaves=surfaceWaveGroups(device,pipelines[2],surfaceWaves);
  const ringWaves=surfaceWaveGroups(device,pipelines[4],surfaceWaves);
  let impactCount=0,ballCount=0,arcSegmentCount=0,depthTexture=null,depthWidth=0,depthHeight=0,depthSource=null,depthGroup=null;
  // settle: smoke has just gone, and the GPU has one more pass to make to write that down.
  let volumeGroup=null,depthReady=false,sorted=false,settle=false;
  const groups=pipelines.map((pipe,i)=>i===1?null:device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:bindings[i].map(binding=>({binding,resource:resources[binding]}))}));
  const depthModule=await shader(GUNNERY_DEPTH_RESOLVE(samples),'cannon effects depth snapshot');
  const depthPipeline=await device.createComputePipelineAsync({label:'resolve cannon effects depth',layout:'auto',compute:{module:depthModule,entryPoint:'gunneryResolveDepth'}});
  // Smoke and fire volumes, the order they are drawn in and the light fires throw are all worked out on the GPU.
  const buildModule=await shader(GUNNERY_BUILD(L),'cannon smoke and fire volumes');
  // The smoke stages read no contact: iron striking timber, stone, earth or water is never a volume.
  const buildResources=[{buffer:frameUBO},{buffer:fireBuffer},{buffer:hullBuffer},{buffer:volumeBuffer},{buffer:countBuffer},{buffer:orderBuffer},{buffer:drawBuffer},{buffer:lightBuffer},
    {buffer:shotBuffer},{buffer:bankBuffer},null,{buffer:stateBuffer}];
  const buildStages=await Promise.all([['gunnerySmokeAdvance','cannon smoke wind carry',[0,8,9,11]],['gunneryBuildSmoke','cannon smoke volumes',[0,3,8,9,11]],['gunneryBuildFires','fire volumes',[0,1,2,3,4]],
    ['gunnerySortVolumes','cannon smoke draw order',[0,3,4,5,6]],['gunneryFireLighting','fire lights',[0,1,2,4,7]]].map(async([entryPoint,label,used])=>{
    const pipeline=await device.createComputePipelineAsync({label,layout:'auto',compute:{module:buildModule,entryPoint}});
    return {pipeline,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:used.map(binding=>({binding,resource:buildResources[binding]}))})};
  }));
  const [carryStage,smokeStage,fireStage,sortStage,lightStage]=buildStages;
  // Where the frame and each hull keep the fire light their shaders read: [bytes into the light buffer, bytes into the
  // target, length]. The frame's eight floats sit in its spare slots; neighbouring slots go in one copy.
  const FRAME_FIRE_LIGHT_SPANS=FRAME_FIRE_SLOTS.reduce((spans,slot,k)=>{
    const last=spans.at(-1);
    if(last&&last[1]+last[2]===slot*4)last[2]+=4;else spans.push([k*4,slot*4,4]);
    return spans;
  },[]),HULL_FIRE_LIGHT_OFFSET=204;
  function sendCounts(){
    counts[0]=fires.count;
    if(counts[0]===sentCounts[0]&&counts[2]===sentCounts[2]&&counts[3]===sentCounts[3])return;
    sentCounts.set(counts);device.queue.writeBuffer(countBuffer,0,counts);
  }
  function sendFires(span){if(span)device.queue.writeBuffer(fireBuffer,span.first*GUNNERY_FIRE_RECORD_FLOATS*4,fires.records,span.first*GUNNERY_FIRE_RECORD_FLOATS,(span.last-span.first+1)*GUNNERY_FIRE_RECORD_FLOATS);}
  // New shots and the banks they joined go up once, as one run of records each.
  function sendRecords(buffer,records,items,fields){
    let first=Infinity,last=-1;
    for(const item of items){records.set(fields(item),item.slot*width);first=Math.min(first,item.slot);last=Math.max(last,item.slot);}
    if(last>=0)device.queue.writeBuffer(buffer,first*width*4,records,first*width,(last-first+1)*width);
  }
  function sendSmoke(){
    const fresh=state.fresh;
    if(fresh.shots.length){sendRecords(shotBuffer,shotRecords,fresh.shots,s=>[...s.position,s.birth,...s.direction,s.scale,s.seed,s.generation,0,0]);fresh.shots.length=0;}
    if(fresh.banks.size){sendRecords(bankBuffer,bankRecords,fresh.banks,b=>[...b.position,b.birth,...b.direction,b.strength,b.seed,b.generation,b.guns,b.span]);fresh.banks.clear();}
    if(fresh.impacts){
      fresh.impacts=false;impactCount=0;
      // When it struck, by the frame's clock: the GPU ages the splash, and nothing is sent again until the list changes.
      for(const e of state.impacts)contacts.set([...e.position,e.birth,...e.velocity,e.scale,e.seed,0,0,0,e.kindCode??0,e.pit??0,e.sand??0,0],impactCount++*16);
      if(impactCount)device.queue.writeBuffer(contactBuffer,0,contacts,0,impactCount*16);
    }
  }
  if(ownHulls)device.queue.writeBuffer(ownHulls,0,new Float32Array([1,0,0,1,0,1,0,0,0,0,-1,0,3.6,12,0,0,0,0,0,0,0,0,0,0]));
  const volumeEntries=()=>bindings[1].map(binding=>({binding,resource:binding===11?depthTexture.createView():resources[binding]}));
  return {state,emitShot:state.emitShot,emitImpact:state.emitImpact,setProjectiles:state.setProjectiles,setAimArcs:state.setAimArcs,
    get active(){return state.active||fires.count>0;},get transparentActive(){return !!(state.smoke||impactCount||arcSegmentCount||fires.count);},
    // Whether there is smoke or fire for the volumes pass to draw. With neither, the frame takes no snapshot of
    // its depth and opens no pass for them.
    get volumesActive(){return state.smoke||fires.count>0;},
    // volumes: the most smoke volumes these shots and banks could be drawn as.
    get counts(){return {shots:state.shots.length,banks:state.banks.length,volumes:state.shots.length*2+state.banks.length*GUNNERY_BANK_LOBES,impacts:impactCount,projectiles:ballCount,arcs:arcSegmentCount,fires:fires.count};},
    // The GPU's own lists, for reading back: every volume in its slot, and what the sort found to draw.
    fires,volumeBuffer,drawBuffer,volumeSlots:slots,
    // options.time is the frame's clock, the one its uniform carries. options.fires lists every fire burning
    // and options.fireHulls the hull each is aboard (-1 ashore): see createGunneryFireLedger. options.wind is
    // the frame's wind, and here it only says when a bank's record can be dropped: the smoke itself takes the
    // wind from the frame uniform, on the GPU.
    update(dt,options={}){
      state.step(dt,options);depthReady=sorted=false;ballCount=arcSegmentCount=0;
      sendFires(fires.sync(Array.isArray(options.fires)?options.fires:null,options.fireHulls,state.clock));
      sendSmoke();if(state.smoke)settle=true;
      for(const p of state.projectiles){
        if(ballCount>=L.projectiles)break;
        if(isArrowAmmo(p.ammo)&&p.velocity){
          if(ballCount+3>L.projectiles)break;
          const speed=Math.hypot(...p.velocity)||1,lit=p.ammo==='fire-arrow';
          for(const[back,radius]of[[0,lit?-.075:.022],[.32,.016],[.64,.016]]){
            balls.set([p.position[0]-p.velocity[0]/speed*back,p.position[1]-p.velocity[1]/speed*back,p.position[2]-p.velocity[2]/speed*back,radius],ballCount++*4);
          }
          continue;
        }
        const signedRadius=p.ammo==='hot'?-p.radius:p.radius;
        if(p.ammo==='chain'&&ballCount+1<L.projectiles){
          const spin=(p.age??0)*24.0+(p.id??0)*1.7;
          const offX=Math.cos(spin)*p.radius*2.2,offY=Math.sin(spin)*p.radius*1.4;
          balls.set([p.position[0]+offX,p.position[1]+offY,p.position[2],p.radius*0.88],ballCount++*4);
          balls.set([p.position[0]-offX,p.position[1]-offY,p.position[2],p.radius*0.88],ballCount++*4);
        }else{
          balls.set([...p.position,signedRadius],ballCount++*4);
        }
      }
      for(const seg of state.aimArcs){
        if(arcSegmentCount>=L.arcSegments)break;
        arcs.set([...seg.p0,...seg.p1,...seg.style],arcSegmentCount++*12);
      }
      sendCounts();
      if(ballCount)device.queue.writeBuffer(ballBuffer,0,balls,0,ballCount*4);
      if(arcSegmentCount)device.queue.writeBuffer(arcBuffer,0,arcs,0,arcSegmentCount*12);
    },
    drawProjectiles(pass){
      if(!ballCount)return;
      pass.setPipeline(pipelines[0]);pass.setBindGroup(0,groups[0]);pass.draw(12*8*6,ballCount);
    },
    // Fire light for this frame, put where the frame's and each burning hull's shaders read it. Encode it
    // before any pass that lights a surface. frame is the frame uniform; hull(i) gives vessel i's own.
    encodeLights(encoder,{frame=frameUBO,hull=null}={}){
      if(!fires.count)return false;
      const pass=encoder.beginComputePass({label:'fire lights'});pass.setPipeline(lightStage.pipeline);pass.setBindGroup(0,lightStage.group);pass.dispatchWorkgroups(1);pass.end();
      for(const [from,to,bytes] of FRAME_FIRE_LIGHT_SPANS)encoder.copyBufferToBuffer(lightBuffer,from,frame,to,bytes);
      if(hull)for(const index of fires.burningHulls){const target=index<hullSlots?hull(index):null;if(target)encoder.copyBufferToBuffer(lightBuffer,32+index*4,target,HULL_FIRE_LIGHT_OFFSET,4);}
      return true;
    },
    // Smoke and fire volumes from their records, then the order they are drawn in. Encode it before the scene
    // pass. With no smoke in the air and nothing burning it encodes nothing.
    encode(encoder){
      if(!state.smoke&&!settle&&!fires.count)return false;
      const pass=encoder.beginComputePass({label:'cannon smoke and fire volumes'});
      if(state.smoke||settle){
        pass.setPipeline(carryStage.pipeline);pass.setBindGroup(0,carryStage.group);pass.dispatchWorkgroups(1);
        pass.setPipeline(smokeStage.pipeline);pass.setBindGroup(0,smokeStage.group);pass.dispatchWorkgroups(Math.ceil((L.shots+L.banks)/64));
        settle=state.smoke;
      }
      if(fires.count){pass.setPipeline(fireStage.pipeline);pass.setBindGroup(0,fireStage.group);pass.dispatchWorkgroups(Math.ceil(fires.count/64));}
      pass.setPipeline(sortStage.pipeline);pass.setBindGroup(0,sortStage.group);pass.dispatchWorkgroups(Math.ceil(slots.total/64));
      pass.end();sorted=true;return true;
    },
    // A single-sampled copy of the scene's depth for the volumes to be drawn against, taken after the scene pass has
    // ended. The sort says how much of it to take: none when no volume is in view.
    resolveDepth(encoder,source,width,height){
      if(!sorted)return false;
      if(!depthTexture||width!==depthWidth||height!==depthHeight){
        depthTexture?.destroy();depthWidth=width;depthHeight=height;
        depthTexture=device.createTexture({label:'cannon smoke opaque depth',size:[width,height],format:'r32float',usage:T.STORAGE_BINDING|T.TEXTURE_BINDING});
        depthSource=null;
        volumeGroup=device.createBindGroup({layout:pipelines[1].getBindGroupLayout(0),entries:volumeEntries()});
        // This reaches the GPU before the frame's commands run, so the sort already encoded dispatches by it.
        counts[2]=Math.ceil(width/8);counts[3]=Math.ceil(height/8);sendCounts();
      }
      // Keyed on the view itself: pass the same view each frame, or this makes a bind group a frame.
      if(source!==depthSource){depthSource=source;depthGroup=device.createBindGroup({layout:depthPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:source},{binding:1,resource:depthTexture.createView()}]});}
      const pass=encoder.beginComputePass({label:'cannon smoke scene depth'});pass.setPipeline(depthPipeline);pass.setBindGroup(0,depthGroup);pass.dispatchWorkgroupsIndirect(drawBuffer,DEPTH_DISPATCH_OFFSET);pass.end();depthReady=true;return true;
    },
    // In the scene's own pass: aiming arcs, and what a strike throws up.
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
    // After the scene pass has ended and `resolveDepth` has run, in a pass on the resolved colour. The GPU's sort
    // says how many volumes: only those in view, nearest last.
    drawVolumes(pass){
      if(depthReady&&sorted){pass.setPipeline(pipelines[1]);pass.setBindGroup(0,volumeGroup);pass.drawIndirect(drawBuffer,0);}
    },
    clear(){
      state.clear();sendFires(fires.clear());ballCount=arcSegmentCount=0;depthReady=sorted=false;
      // No shot or bank has generation zero: emptied records are smoke that never was.
      shotRecords.fill(0);bankRecords.fill(0);device.queue.writeBuffer(shotBuffer,0,shotRecords);device.queue.writeBuffer(bankBuffer,0,bankRecords);
      sendSmoke();sendCounts();settle=true;
    },
    destroy(){for(const buffer of [volumeBuffer,ballBuffer,contactBuffer,arcBuffer,shotBuffer,bankBuffer,stateBuffer,fireBuffer,orderBuffer,drawBuffer,countBuffer,lightBuffer,ownHulls])buffer?.destroy();noise.destroy();depthTexture?.destroy();},
  };
}
