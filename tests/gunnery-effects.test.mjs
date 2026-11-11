// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGunneryEffectState,createGunneryFireLedger,GUNNERY_FX_LIMITS,GUNNERY_BANK_GROUPING,GUNNERY_FIRE_TOLERANCE} from '../js/gunnery-effects.js';
import {SIM_CLOCK_LOOP_S} from '../js/wgsl/common.js';
import {gunneryBankSeconds,gunneryVolumeSlots,GUNNERY_FIRE_VOLUMES,GUNNERY_BANK_LOBES} from '../js/wgsl/gunnery.js';

const fxShot={position:[0,3,0],direction:[1,0,0],chargeKg:3};
test('cannon visuals consume real bounded shot/contact records and leave no idle simulation',()=>{
  const state=createGunneryEffectState();assert.equal(state.active,false);
  state.step(1,{time:12});assert.deepEqual(state.shots,[]);assert.deepEqual(state.banks,[]);assert.deepEqual(state.impacts,[]);
  assert.equal(state.emitShot({position:[NaN,1,0]}),false);assert.equal(state.emitShot({...fxShot,direction:[0,0,0]}),false);
  assert.equal(state.emitImpact({position:[0,0,0],velocity:[0,0,0]}),false);assert.equal(state.smoke,false);
  for(let i=0;i<400;i++){state.emitShot({...fxShot,id:i,position:[i*40,3,0]});state.emitImpact({id:i,position:[i,0,0],velocity:[200,-20,0]});}
  assert.equal(state.shots.length,GUNNERY_FX_LIMITS.shots);assert.equal(state.banks.length,GUNNERY_FX_LIMITS.banks);assert.equal(state.impacts.length,GUNNERY_FX_LIMITS.impacts);
  assert.equal(state.shots[0].id,400-GUNNERY_FX_LIMITS.shots);assert.equal(state.impacts[0].id,400-GUNNERY_FX_LIMITS.impacts);
  // Every record has a place of its own in what is sent, and a mark no other record shares.
  for(const [list,limit] of [[state.shots,GUNNERY_FX_LIMITS.shots],[state.banks,GUNNERY_FX_LIMITS.banks]]){
    assert.equal(new Set(list.map(v=>v.slot)).size,list.length);assert.ok(list.every(v=>v.slot>=0&&v.slot<limit&&v.generation>0));
  }
  assert.equal(new Set([...state.shots,...state.banks].map(v=>v.generation)).size,state.shots.length+state.banks.length);
  state.setProjectiles(Array.from({length:300},(_,id)=>({id,position:[id,2,0],radius:.075})));
  assert.equal(state.projectiles.length,GUNNERY_FX_LIMITS.projectiles);
  state.clear();assert.equal(state.active,false);assert.equal(state.fresh.shots.length,0);assert.equal(state.fresh.banks.size,0);
});

test('guns that fire together along her side leave one bank between them; a gun apart leaves its own',()=>{
  const state=createGunneryEffectState(),G=GUNNERY_BANK_GROUPING;state.step(0,{time:100});
  // Six guns 2.4 m apart, fired within a second, all laid on the beam.
  for(let i=0;i<6;i++){state.step(0,{time:100+i*.15});state.emitShot({position:[0,3,i*2.4],direction:[1,0,0],chargeKg:3});}
  assert.equal(state.banks.length,1);const bank=state.banks[0],mass=state.shots[0].scale**3;
  assert.equal(bank.guns,6);assert.ok(Math.abs(bank.strength-6*mass)<1e-9,'a bank holds all the smoke of its guns');
  assert.ok(Math.abs(bank.position[2]-6)<1e-9&&Math.abs(bank.span-6)<1e-9,'it lies along the guns that made it');
  assert.equal(bank.birth,100,'and is as old as its first gun');assert.ok(state.shots.every(shot=>shot.bank===bank));
  assert.deepEqual([...state.fresh.banks],[bank]);assert.equal(state.fresh.shots.length,6);
  // The other side, a gun far forward, and a gun long after each begin a bank of their own.
  state.emitShot({position:[0,3,6],direction:[-1,0,0],chargeKg:3});assert.equal(state.banks.length,2);
  state.emitShot({position:[0,3,6+G.metres+1],direction:[1,0,0],chargeKg:3});assert.equal(state.banks.length,3);
  state.step(0,{time:100+G.seconds+.2});state.emitShot({position:[0,3,6],direction:[1,0,0],chargeKg:3});assert.equal(state.banks.length,4);
  // A long broadside is many banks, none of more guns than a bank may hold, and no smoke is lost or made.
  const line=createGunneryEffectState();for(let i=0;i<52;i++)line.emitShot({position:[0,3+(i%3)*2,Math.floor(i/3)*3.1],direction:[1,0,0],chargeKg:3+(i%3)});
  assert.ok(line.banks.length>=6&&line.banks.length<=26,String(line.banks.length));assert.ok(line.banks.every(b=>b.guns<=G.guns));
  assert.equal(line.banks.reduce((sum,b)=>sum+b.guns,0),52);
  assert.ok(Math.abs(line.banks.reduce((sum,b)=>sum+b.strength,0)-line.shots.reduce((sum,shot)=>sum+shot.scale**3,0))<1e-9);
});

test('smoke is a record of where and when: nothing moves or ages it here, and it is dropped once it has blown away',()=>{
  const state=createGunneryEffectState();state.step(0,{time:SIM_CLOCK_LOOP_S-2});state.emitShot(fxShot);
  const shot=state.shots[0],bank=state.banks[0],told=JSON.stringify([shot.position,shot.direction,shot.birth,bank.position,bank.birth]);
  for(let i=0;i<60;i++)state.step(1/60);
  assert.equal(JSON.stringify([shot.position,shot.direction,shot.birth,bank.position,bank.birth]),told,'a second of frames changes no record');
  assert.ok(Math.abs(state.since(shot.birth)-1)<1e-9);
  // The frame clock starts again from nothing: the smoke is no younger for it.
  state.step(0,{time:1});assert.ok(Math.abs(state.since(shot.birth)-3)<1e-9);assert.equal(state.shots.length,1);
  state.step(0,{time:GUNNERY_FX_LIMITS.jetSeconds-1.5});assert.equal(state.shots.length,0,'the jet is spent');assert.equal(state.banks.length,1);assert.equal(state.smoke,true);
  state.step(0,{time:GUNNERY_FX_LIMITS.bankSeconds-2.5});assert.equal(state.banks.length,1);
  state.step(0,{time:GUNNERY_FX_LIMITS.bankSeconds-.5});assert.equal(state.banks.length,0);assert.equal(state.active,false);
  assert.ok(GUNNERY_FX_LIMITS.flashSeconds<.1);
  // It expires when it can no longer be seen: a wind tears a bank up sooner, and its record goes when the GPU stops
  // drawing it, a second's grace after. Nothing is built, sorted or drawn for smoke that has blown away.
  assert.equal(gunneryBankSeconds(0),GUNNERY_FX_LIMITS.bankSeconds);assert.equal(gunneryBankSeconds(9),GUNNERY_FX_LIMITS.bankSeconds/2);
  for(const wind of [[9,0,0],[0,0,-9],[16,0,0],[.5,0,0]]){
    const blown=createGunneryEffectState(),life=gunneryBankSeconds(Math.hypot(...wind));
    blown.step(0,{time:100,wind});blown.emitShot(fxShot);
    blown.step(0,{time:100+life+.9,wind});assert.equal(blown.smoke,true,`kept while it shows in a wind of ${Math.hypot(...wind)}`);
    blown.step(0,{time:100+life+1.1,wind});assert.equal(blown.smoke,false,'and dropped as soon as it does not');assert.equal(blown.active,false);
  }
  assert.ok(gunneryBankSeconds(16)<20&&gunneryBankSeconds(.5)>48);
});

test('roundshot poses and fixed impact births are copied without altering ballistics',()=>{
  const state=createGunneryEffectState(),position=[1,2,3];state.setProjectiles([{id:7,position,radius:.08},{position:[Infinity,2,3]}]);
  position[0]=90;assert.deepEqual(state.projectiles,[{id:7,position:[1,2,3],radius:.08}]);
  const impact={position:[2,.7,5],velocity:[180,-25,10],massKg:14};state.step(0,{time:40});state.emitImpact(impact);state.fresh.impacts=false;state.step(.2,{time:40.2});
  assert.deepEqual(state.impacts[0].position,[2,.7,5]);assert.deepEqual(state.impacts[0].velocity,[180,-25,10]);assert.equal(state.impacts[0].birth,40);
  assert.equal(state.active,true);assert.equal(state.smoke,false,'what a strike throws up is no smoke');
  assert.equal(state.fresh.impacts,false,'a splash in the air is not sent again');
  assert.equal(state.projectiles[0].position[1],2,'only the ballistics owner moves a projectile');
  state.step(0,{time:40+GUNNERY_FX_LIMITS.impactSeconds});assert.equal(state.impacts.length,0);assert.equal(state.fresh.impacts,true,'its going is sent once');
});

test('the GPU is told of a fire when it is lit or changes, and of nothing while it burns steadily',()=>{
  const ledger=createGunneryFireLedger(4),fire={position:[40,3,-9],localPosition:[1,2,3],intensity:.8,age:0,seed:.4};
  let clock=590,sends=0;
  const burn=(seconds,rate,fires=[fire],hulls=[0])=>{sends=0;for(let i=0;i<seconds*60;i++){clock+=1/60;fire.age+=1/60;fire.intensity=Math.min(1.6,fire.intensity+rate/60);if(ledger.sync(fires,hulls,clock))sends++;}};
  assert.deepEqual(ledger.sync([fire],[0],clock),{first:0,last:0});
  assert.deepEqual(Array.from(ledger.records.subarray(0,10)),[1,2,3,0,590,.8,0,590,.4,1].map(Math.fround),'aboard, a record holds her own frame, not the world');
  assert.deepEqual([...ledger.burningHulls],[0]);
  burn(1,.012);assert.equal(sends,1,'its growth is learned once');
  burn(8,.012);assert.equal(sends,0);assert.ok(Math.abs(ledger.intensity(0,clock)-fire.intensity)<GUNNERY_FIRE_TOLERANCE);
  // The frame clock starts again: the record goes back with it and the fire neither jumps nor restarts.
  const before=ledger.intensity(0,clock);clock-=SIM_CLOCK_LOOP_S;
  assert.deepEqual(ledger.sync([fire],[0],clock),{first:0,last:0});assert.ok(Math.abs(ledger.intensity(0,clock)-before)<1e-6);
  assert.ok(Math.abs(clock-ledger.slots[0].started-fire.age)<.01);
  burn(4,.012);assert.equal(sends,0);
  // A second shot feeds it: one write, and the old pace is kept.
  fire.intensity+=.3;assert.ok(ledger.sync([fire],[0],clock));assert.ok(Math.abs(ledger.slots[0].rate-.012)<1e-3);
  burn(4,.012);assert.equal(sends,0);
  // Burning as hard as it can: the pace drops to nothing in a write or two.
  fire.intensity=1.6;ledger.sync([fire],[0],clock);burn(3,.012);assert.ok(sends<=2);burn(3,.012);assert.equal(sends,0);
  // Ashore a record holds the world position; a fire gone out or struck from the list is written off once.
  const ashore={position:[7,1,2],intensity:.5,age:3,seed:.2};
  assert.deepEqual(ledger.sync([fire,ashore],[0,-1],clock),{first:1,last:1});assert.deepEqual(Array.from(ledger.records.subarray(12,16)),[7,1,2,-1]);
  ashore.intensity=.01;assert.deepEqual(ledger.sync([fire,ashore],[0,-1],clock),{first:1,last:1});assert.equal(ledger.records[12+9],0);
  assert.equal(ledger.sync([fire,ashore],[0,-1],clock),null);
  assert.deepEqual(ledger.sync([],[],clock),{first:0,last:0});assert.equal(ledger.count,0);assert.equal(ledger.burningHulls.size,0);
  assert.equal(ledger.sync(null,null,clock),null);
  // More fires than there are records: the first are kept.
  const many=Array.from({length:9},(_,i)=>({position:[i,0,0],intensity:1,age:0,seed:.1}));
  assert.deepEqual(ledger.sync(many,many.map(()=>-1),clock),{first:0,last:3});assert.equal(ledger.count,4);
  assert.deepEqual(ledger.clear(),{first:0,last:3});assert.equal(ledger.clear(),null);
});

// A device that records what is asked of it, so the renderer's bookkeeping can be checked without a GPU.
async function recordedEffects(){
  globalThis.GPUBufferUsage??={STORAGE:1,COPY_DST:2,UNIFORM:4,COPY_SRC:8,INDIRECT:16};globalThis.GPUTextureUsage??={STORAGE_BINDING:1,TEXTURE_BINDING:2};
  const {createGunneryEffects}=await import('../js/gunnery-effects.js');
  const log={pipelines:[],buffers:[],groups:[],uploads:[],draws:[],dispatches:[]};
  const computePass=()=>{let stage='';return {setPipeline(p){stage=p.label;},setBindGroup(){},dispatchWorkgroups(){log.dispatches.push(stage);},dispatchWorkgroupsIndirect(buffer){log.dispatches.push(stage+' by '+buffer.label);},end(){}};};
  const encoder={beginComputePass:computePass,finish:()=>({})};
  const device={
    createBuffer:d=>{log.buffers.push(d);return {label:d.label,destroy(){}};},
    createRenderPipelineAsync:async d=>{log.pipelines.push(d);return {label:d.label,getBindGroupLayout:()=>({})};},
    createComputePipelineAsync:async d=>({label:d.label,getBindGroupLayout:()=>({})}),
    createBindGroup:d=>{log.groups.push(d);return {};},
    createTexture:()=>({createView:()=>({}),destroy(){}}),createSampler:()=>({}),createCommandEncoder:()=>encoder,
    queue:{writeBuffer(buffer){log.uploads.push(buffer.label);},submit(){}},
  };
  const effects=await createGunneryEffects({device,frameUBO:{},shader:async()=>({}),samples:4});
  log.dispatches.length=0;log.uploads.length=0;
  const pass={setPipeline:p=>log.draws.push(p.label),setBindGroup(){},draw(){},drawIndirect(buffer){log.draws.push('by '+buffer.label);}};
  return {effects,log,encoder,pass};
}

test('the smoke has one pipeline, the one the game draws: single-sampled, with no depth attachment',async()=>{
  const {effects,log,encoder,pass}=await recordedEffects();
  const volume=log.pipelines.filter(p=>p.vertex.entryPoint==='gunneryVolumeVS');
  assert.deepEqual(volume.map(p=>p.label),['gunneryVolume'],'one volume pipeline, under the name the frame counters look for');
  assert.equal(volume[0].multisample.count,1);assert.equal(volume[0].depthStencil,undefined);
  for(const p of log.pipelines)if(p!==volume[0]){assert.equal(p.multisample.count,4);assert.equal(p.depthStencil.format,'depth32float');}
  // Iron on timber, stone or earth is no powder: a contact is a row for the GPU and never a volume, and the
  // stages that lay smoke out are not even handed the contacts.
  const labels=group=>group.entries.map(entry=>entry.resource?.buffer?.label);
  const smokeStages=log.groups.filter(group=>labels(group).includes('cannon smoke shots'));
  assert.equal(smokeStages.length,2);for(const group of smokeStages)assert.ok(!labels(group).includes('roundshot water contacts'));
  effects.emitImpact({position:[4,0,0],velocity:[150,-30,0],kind:'terrain'});effects.emitImpact({position:[8,2,0],velocity:[150,-30,0],kind:'ship'});
  effects.update(.2,{time:.2});assert.deepEqual([effects.counts.impacts,effects.counts.volumes],[2,0]);
  assert.ok(effects.state.impacts.every(impact=>impact.pit>0),'timber and earth alike throw debris from the strike\'s energy');
  assert.equal(effects.volumesActive,false);assert.equal(effects.encode(encoder),false,'so nothing is built or sorted for a strike');
  assert.equal(effects.resolveDepth(encoder,{},64,64),false);effects.drawInPass(pass);effects.drawVolumes(pass);
  assert.ok(log.draws.length>0&&!log.draws.includes('gunneryVolume'),'what it throws up is drawn in the scene\'s pass, and no volume');
  effects.clear();effects.update(.2,{time:.4});effects.encode(encoder);log.draws.length=0;log.dispatches.length=0;
  effects.emitShot(fxShot);effects.update(.2,{time:.6});assert.equal(effects.volumesActive,true);
  assert.equal(effects.resolveDepth(encoder,{},64,64),false,'no depth is taken before the volumes are laid out and sorted');
  assert.equal(effects.encode(encoder),true);
  effects.drawVolumes(pass);assert.deepEqual(log.draws,[],'nothing is drawn against a depth that was not resolved this frame');
  assert.equal(effects.resolveDepth(encoder,{},64,64),true);effects.drawVolumes(pass);
  assert.deepEqual(log.draws,['gunneryVolume','by cannon smoke indirect draw'],'as many volumes as the GPU\'s sort found in view');
  assert.deepEqual(log.dispatches,['cannon smoke wind carry','cannon smoke volumes','cannon smoke draw order','resolve cannon effects depth by cannon smoke indirect draw'],
    'the depth is taken only as far as the sort says: not at all with no volume in view');
  assert.equal(effects.draw,undefined,'and no second way to draw them that only a test would use');
});

test('smoke costs no bind group a frame while it is handed the same depth view, sends nothing while it drifts, and costs nothing once it has blown away',async()=>{
  const {effects,log,encoder}=await recordedEffects();
  for(let i=0;i<52;i++)effects.emitShot({position:[i*2.2,4,0],direction:[0,.05,1],chargeKg:4});
  const view={},wind=[9,0,0],life=gunneryBankSeconds(9);let made=-1,built=0,snapshots=0,uploadsAfterFirst=0;
  for(let frame=0;frame<40*30;frame++){
    const sent=log.uploads.length;effects.update(1/30,{time:frame/30,wind});
    if(frame>0)uploadsAfterFirst+=log.uploads.length-sent;
    if(effects.encode(encoder))built++;
    if(effects.volumesActive&&effects.resolveDepth(encoder,view,640,360)){
      snapshots++;
      if(made<0)made=log.groups.length;else assert.equal(log.groups.length,made,'no bind group after the first frame of smoke');
    }
  }
  assert.ok(made>0);assert.equal(uploadsAfterFirst,0,'the records went up with the broadside and nothing was sent after');
  assert.ok(snapshots>=life*30&&snapshots<=(life+1)*30+2,`its depth is taken for the ${life} s a bank lasts in this wind, not the ${GUNNERY_FX_LIMITS.bankSeconds} s of a calm (${snapshots} frames)`);
  assert.equal(built,snapshots+1,'and it is laid out once more, to write down that it has gone');
  assert.equal(effects.active,false,'forty seconds on, nothing is left to step');
  assert.equal(effects.volumesActive,false);assert.equal(effects.encode(encoder),false);assert.equal(effects.resolveDepth(encoder,view,640,360),false);
  // Every volume has a place of its own in the list the GPU fills and sorts; the nearest are drawn.
  const slots=gunneryVolumeSlots(GUNNERY_FX_LIMITS),volumes=log.buffers.find(b=>b.label==='black powder smoke volumes');
  assert.equal(slots.total,GUNNERY_FX_LIMITS.shots*2+GUNNERY_FX_LIMITS.banks*GUNNERY_BANK_LOBES+GUNNERY_FX_LIMITS.fires*GUNNERY_FIRE_VOLUMES);
  assert.equal(volumes.size,slots.total*20*4);assert.equal(volumes.usage&GPUBufferUsage.COPY_DST,0,'nothing uploads to it');
  assert.ok(GUNNERY_FX_LIMITS.drawnVolumes<=256);
  // The game keeps the view: a new one every frame would defeat the cache above.
  const {readFileSync}=await import('node:fs');
  const call=readFileSync(new URL('../js/main.js',import.meta.url),'utf8').match(/gunEffects\.resolveDepth\(([^;]*)\);/);
  assert.ok(call,'main.js resolves the smoke\'s depth');assert.ok(!call[1].includes('createView('),`main.js passes a kept view, not ${call[1]}`);
});
