// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGunneryEffectState,gunnerySmokeParcel,GUNNERY_FX_LIMITS} from '../js/gunnery-effects.js';

const fxShot={position:[0,3,0],direction:[1,0,0],chargeKg:3};
test('cannon visuals consume real bounded shot/contact records and leave no idle simulation',()=>{
  const state=createGunneryEffectState();assert.equal(state.active,false);
  state.step(1,{wind:[12,0,0]});assert.deepEqual(state.shots,[]);assert.deepEqual(state.impacts,[]);
  assert.equal(state.emitShot({position:[NaN,1,0]}),false);assert.equal(state.emitShot({...fxShot,direction:[0,0,0]}),false);
  assert.equal(state.emitImpact({position:[0,0,0],velocity:[0,0,0]}),false);
  for(let i=0;i<400;i++){state.emitShot({...fxShot,id:i});state.emitImpact({id:i,position:[i,0,0],velocity:[200,-20,0]});}
  assert.equal(state.shots.length,GUNNERY_FX_LIMITS.shots);assert.equal(state.impacts.length,GUNNERY_FX_LIMITS.impacts);
  assert.equal(state.shots[0].id,400-GUNNERY_FX_LIMITS.shots);assert.equal(state.impacts[0].id,400-GUNNERY_FX_LIMITS.impacts);
  state.setProjectiles(Array.from({length:300},(_,id)=>({id,position:[id,2,0],radius:.075})));
  assert.equal(state.projectiles.length,GUNNERY_FX_LIMITS.projectiles);
  state.clear();assert.equal(state.active,false);
});

test('powder cloud momentum entrains to actual wind independently of frame partition',()=>{
  const a=createGunneryEffectState(),b=createGunneryEffectState();a.emitShot(fxShot);b.emitShot(fxShot);
  for(let i=0;i<120;i++)a.step(1/60,{wind:[8,0,-3]});
  for(let i=0;i<40;i++)b.step(.05,{wind:[8,0,-3]});
  assert.ok(Math.hypot(...a.shots[0].drift.map((v,k)=>v-b.shots[0].drift[k]))<1e-10);
  assert.ok(a.shots[0].drift[0]>5&&a.shots[0].drift[2]<-2);
  const early=a.shots[0].driftVelocity[0];for(let i=0;i<120;i++)a.step(1/60,{wind:[-8,0,3]});
  assert.ok(early>0&&a.shots[0].driftVelocity[0]<0,'wind reversal changes the advected cloud continuously');
});

test('three connected powder billows expand, decelerate, dilute and expire with no persistent flash',()=>{
  const state=createGunneryEffectState();state.emitShot(fxShot);const shot=state.shots[0];
  assert.equal(gunnerySmokeParcel(shot,1),null);
  const samples=[];for(const age of [.06,.15,.5,1,3,8,17,18]){shot.age=age;samples.push(gunnerySmokeParcel(shot,0));}
  for(const p of samples){assert.ok([...p.centre,...p.radii,p.extinction].every(Number.isFinite));assert.ok(p.radii.every(v=>v>0));}
  for(let i=1;i<samples.length;i++){assert.ok(samples[i].radii[0]>samples[i-1].radii[0]);assert.ok(samples[i].extinction<samples[i-1].extinction);}
  assert.ok(samples[1].centre[0]-samples[0].centre[0]>(samples[4].centre[0]-samples[3].centre[0])*.3,'initial muzzle momentum decays');
  // It expires when it can no longer be seen: nothing is built or sorted for smoke too thin to draw.
  const life=GUNNERY_FX_LIMITS.smokeSeconds,floor=.015,densest=age=>{shot.age=age;return Math.max(...[0,1,2].map(k=>gunnerySmokeParcel(shot,k)?.extinction??0));};
  assert.ok(life>2&&life<6,`a discharge is kept ${life} s`);
  for(const scale of [.82,1,2.25]){
    shot.scale=scale;
    assert.ok(densest(life)<floor,`at the end of its life a charge of scale ${scale} has no parcel left to draw (${densest(life)})`);
    assert.ok(densest(life-.4)>=floor,`and it is not dropped while one can still be seen (${densest(life-.4)})`);
  }
  shot.age=0;for(let t=0;t<life-.3;t+=.25)state.step(.25,{wind:[0,0,0]});assert.equal(state.active,true,'kept while it shows');
  state.step(.25,{wind:[0,0,0]});state.step(.25,{wind:[0,0,0]});assert.equal(state.active,false,'and dropped as soon as it does not');
  assert.ok(GUNNERY_FX_LIMITS.flashSeconds<.1);
});

test('roundshot poses and fixed impact births are copied without altering ballistics',()=>{
  const state=createGunneryEffectState(),position=[1,2,3];state.setProjectiles([{id:7,position,radius:.08},{position:[Infinity,2,3]}]);
  position[0]=90;assert.deepEqual(state.projectiles,[{id:7,position:[1,2,3],radius:.08}]);
  const impact={position:[2,.7,5],velocity:[180,-25,10],massKg:14};state.emitImpact(impact);state.step(.2,{wind:[10,0,0]});
  assert.deepEqual(state.impacts[0].position,[2,.7,5]);assert.deepEqual(state.impacts[0].velocity,[180,-25,10]);
  assert.equal(state.projectiles[0].position[1],2,'only the ballistics owner moves a projectile');
});

// A device that records what is asked of it, so the renderer's bookkeeping can be checked without a GPU.
async function recordedEffects(){
  globalThis.GPUBufferUsage??={STORAGE:1,COPY_DST:2,UNIFORM:4};globalThis.GPUTextureUsage??={STORAGE_BINDING:1,TEXTURE_BINDING:2};
  const {createGunneryEffects}=await import('../js/gunnery-effects.js');
  const log={pipelines:[],buffers:[],groups:0,volumeFloats:0,draws:[]};
  const device={
    createBuffer:d=>{log.buffers.push(d);return {label:d.label,destroy(){}};},
    createRenderPipelineAsync:async d=>{log.pipelines.push(d);return {label:d.label,getBindGroupLayout:()=>({})};},
    createComputePipelineAsync:async d=>({label:d.label,getBindGroupLayout:()=>({})}),
    createBindGroup:()=>(log.groups++,{}),
    createTexture:()=>({createView:()=>({}),destroy(){}}),
    queue:{writeBuffer(buffer,offset,data,start=0,count=0){if(buffer.label==='black powder smoke volumes')log.volumeFloats=count;}},
  };
  const effects=await createGunneryEffects({device,frameUBO:{},shader:async()=>({}),samples:4});
  const encoder={beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}})};
  const pass={setPipeline:p=>log.draws.push(p.label),setBindGroup(){},draw(){}};
  return {effects,log,encoder,pass};
}

test('the smoke has one pipeline, the one the game draws: single-sampled, with no depth attachment',async()=>{
  const {effects,log,encoder,pass}=await recordedEffects();
  const volume=log.pipelines.filter(p=>p.vertex.entryPoint==='gunneryVolumeVS');
  assert.deepEqual(volume.map(p=>p.label),['gunneryVolume'],'one volume pipeline, under the name the frame counters look for');
  assert.equal(volume[0].multisample.count,1);assert.equal(volume[0].depthStencil,undefined);
  for(const p of log.pipelines)if(p!==volume[0]){assert.equal(p.multisample.count,4);assert.equal(p.depthStencil.format,'depth32float');}
  // Iron on timber, stone or earth is no powder: a contact is a row for the GPU and never a volume built here.
  effects.emitImpact({position:[4,0,0],velocity:[150,-30,0],kind:'earth',pit:1});effects.emitImpact({position:[8,2,0],velocity:[150,-30,0],kind:'wood'});
  effects.update(.2,{eye:[0,3,20]});assert.deepEqual([effects.counts.impacts,effects.counts.volumes],[2,0]);
  effects.clear();
  effects.emitShot(fxShot);effects.update(.2,{eye:[0,3,20]});
  effects.drawVolumes(pass);assert.deepEqual(log.draws,[],'nothing is drawn against a depth that was not resolved this frame');
  effects.resolveDepth(encoder,{},64,64);effects.drawVolumes(pass);assert.deepEqual(log.draws,['gunneryVolume']);
  assert.equal(effects.draw,undefined,'and no second way to draw them that only a test would use');
});

test('smoke costs no bind group a frame while it is handed the same depth view, and builds nothing once it has cleared',async()=>{
  const {effects,log,encoder}=await recordedEffects();
  for(let i=0;i<52;i++)effects.emitShot({position:[i*2.2,4,0],direction:[0,.05,1],chargeKg:4});
  const view={};let made=-1,framesWithShots=0,framesWithSmoke=0;
  for(let t=0;t<12;t+=1/30){
    effects.update(1/30,{eye:[50,6,-80],wind:[1.5,0,.5]});
    if(effects.state.shots.length)framesWithShots++;
    if(effects.counts.volumes)framesWithSmoke++;
    if(effects.resolveDepth(encoder,view,640,360)){if(made<0)made=log.groups;else assert.equal(log.groups,made,'no bind group after the first frame of smoke');}
  }
  assert.ok(made>0);assert.ok(framesWithSmoke>60);
  assert.ok(framesWithShots-framesWithSmoke<=6,`a discharge is carried ${framesWithShots} frames for ${framesWithSmoke} frames of smoke`);
  assert.equal(effects.active,false,'twelve seconds on, nothing is left to step');
  const volumes=log.buffers.find(b=>b.label==='black powder smoke volumes');
  assert.equal(volumes.size,GUNNERY_FX_LIMITS.volumes*20*4,'the buffer holds what can be drawn and no more');
  // The game keeps the view: a new one every frame would defeat the cache above.
  const {readFileSync}=await import('node:fs');
  const call=readFileSync(new URL('../js/main.js',import.meta.url),'utf8').match(/gunEffects\.resolveDepth\(([^;]*)\);/);
  assert.ok(call,'main.js resolves the smoke\'s depth');assert.ok(!call[1].includes('createView('),`main.js passes a kept view, not ${call[1]}`);
});
