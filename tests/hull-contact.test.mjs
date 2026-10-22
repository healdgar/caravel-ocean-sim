// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHullContactDefinitions,createHullContactConsumer,createHullContactProbe,
  hullContactWorldPoint,HULL_CONTACT_LIMITS} from '../js/hull-contact.js';
import {HULL_CONTACT_COUNT,HULL_CONTACT_RECORD_BYTES,HULL_CONTACT_FLAGS as FLAGS} from '../js/wgsl/hull-contact.js';
import {createCaravelMesh} from '../js/caravel.js';
import {createVictoryMesh} from '../js/victory.js';
import {createAdditionalShipMesh} from '../js/additional-ships.js';
import {NINA_DESIGN} from '../js/models/nina.js';
import {VICTORY_DESIGN} from '../js/models/victory.js';
import {segmentTriangleDistance} from '../scripts/rig-clearance.mjs';

const byteCount=HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES;
const emptyRecords=()=>new ArrayBuffer(byteCount);
function eventRecord(buffer,probe,epoch,{serial=1,time=1,age=.1,closing=2,peak=3,position=[2,-1,4]}={}){
  const f=new Float32Array(buffer),u=new Uint32Array(buffer),at=probe*24;
  f.set([age,peak,time],at+13);f.set([...position,closing],at+16);
  u.set([epoch,serial,10,FLAGS.valid|FLAGS.event|FLAGS.wet],at+20);return buffer;
}
const near=(a,b,tolerance=2e-6)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} versus ${b}`);
const vertexKey=p=>Array.from(p,v=>Math.fround(v)).join(',');

test('ten authored underside probes lie on actual current hull meshes, including the Niña keel bottom',()=>{
  for(const [modelId,builder,skinGroup] of [['nina',createCaravelMesh,'hull'],['victory',createVictoryMesh,'hull.planking'],
    ...['pinta','santa-maria'].map(id=>[id,options=>createAdditionalShipMesh(id,options),'hull.planking'])]){
    const definitions=createHullContactDefinitions(modelId),groups=[],raw=builder({groups});
    assert.equal(definitions.points.length,10);assert.equal(definitions.values.byteLength,320);
    const skin=groups.find(g=>g.id===skinGroup);assert.ok(skin);
    const vertices=new Set();
    for(let i=skin.firstVertex;i<skin.firstVertex+skin.vertexCount;i++)vertices.add(vertexKey(raw.subarray(i*9,i*9+3)));
    for(const probe of definitions.points.filter(p=>p.source.group===skinGroup)){
      assert.ok(vertices.has(vertexKey(probe.position)),`${modelId}/${probe.id} is an actual loft vertex`);
      assert.ok(probe.position[1]<0);assert.ok(probe.normal[1]<0);
      near(Math.hypot(...probe.normal),1);
    }
    if(modelId==='nina'){
      const keel=groups.find(g=>g.id==='hull.keel-stem');assert.ok(keel);
      for(const probe of definitions.points.filter(p=>p.source.group===keel.id)){
        let nearest=Infinity;
        for(let i=keel.firstVertex;i<keel.firstVertex+keel.vertexCount;i+=3){
          const triangle=[0,1,2].map(j=>Array.from(raw.subarray((i+j)*9,(i+j)*9+3)));
          nearest=Math.min(nearest,segmentTriangleDistance(...triangle,probe.position,probe.position));
        }
        assert.ok(nearest<2e-6,`keel underside misses actual timber by ${nearest}`);
        near(probe.position[1],-NINA_DESIGN.hull.draft-.075);
      }
    }
  }
  assert.throws(()=>createHullContactDefinitions('unknown-ship'),/No underside geometry/);
});

test('bilge pairs mirror exactly and transforms preserve scale, attitude, loading datum and compass heading',()=>{
  for(const [modelId,design]of [['nina',NINA_DESIGN],['victory',VICTORY_DESIGN]]){
    const definitions=createHullContactDefinitions(modelId),boat={modelId,length:design.runtime.length,beam:design.runtime.beam,
      x:12,z:-7,heave:-.6,pitch:0,roll:0,heading:0};
    for(let i=0;i<8;i+=2){
      const a=definitions.points[i].position,b=definitions.points[i+1].position;
      near(a[0],-b[0]);near(a[1],b[1]);near(a[2],b[2]);
    }
    const p={position:[.5,-1,2]},sx=boat.beam/3.6,sy=design.frame.verticalScale,sz=boat.length/12;
    let result=hullContactWorldPoint(p,boat);
    near(result[0],12+.5*sx);near(result[1],-.6-sy);near(result[2],-7+2*sz);
    result=hullContactWorldPoint(p,{...boat,heading:90});
    near(result[0],12-2*sz);near(result[1],-.6-sy);near(result[2],-7+.5*sx);
    result=hullContactWorldPoint(p,{...boat,roll:Math.PI/2});
    near(result[0],12+sy);near(result[1],-.6+.5*sx);near(result[2],-7+2*sz);
    result=hullContactWorldPoint(p,{...boat,pitch:Math.PI/2});
    near(result[0],12+.5*sx);near(result[1],-.6-2*sz);near(result[2],-7-sy);
    // KG and loaded draft are NOT an additional translation of visible geometry.
    assert.deepEqual(hullContactWorldPoint(p,{...boat,hydrodynamics:{draft:99,centreOfGravity:55,sinkage:11}}),hullContactWorldPoint(p,boat));
  }
});

test('consumer preserves per-probe serial identity across decimation and consumes expired or receding records silently',()=>{
  const consumer=createHullContactConsumer();consumer.reset(7);
  const values=eventRecord(eventRecord(emptyRecords(),0,7),1,7);
  let events=consumer.consume(values,{epoch:7,now:1.12});
  assert.equal(events.length,2);assert.deepEqual(events.map(e=>e.probe),[0,1]);
  assert.ok(events.every(e=>e.kind==='underside-reentry'&&e.closing===2&&e.peakClosing===3));
  assert.deepEqual(consumer.consume(values,{epoch:7,now:1.13}),[],'same retained serial cannot replay');
  eventRecord(values,0,7,{serial:2,time:.2});
  assert.deepEqual(consumer.consume(values,{epoch:7,now:2}),[],'stale event is consumed without replay');
  assert.equal(consumer.snapshot().serials[0],2);
  eventRecord(values,0,7,{serial:3,time:2,closing:-1});
  assert.deepEqual(consumer.consume(values,{epoch:7,now:2.1}),[],'receding relative velocity is not entry');
  eventRecord(values,0,7,{serial:4,time:2,closing:NaN});
  assert.deepEqual(consumer.consume(values,{epoch:7,now:2.1}),[]);
  const before=consumer.snapshot();consumer.consume(values,{epoch:6,now:2.1});
  assert.deepEqual(consumer.snapshot(),before,'old epoch cannot alter serial ledger');
  consumer.reset(8);eventRecord(values,0,8,{serial:1,time:3});
  assert.equal(consumer.consume(values,{epoch:8,now:3.1}).length,1,'new epoch has independent serials');
});

// This fake owns only GPU transfer lifecycle. Actual dry/wet semantics and six
// cascade sampling are exercised by the separate native GPU fixture.
async function lifecycleFixture(limits={}){
  globalThis.GPUBufferUsage??={STORAGE:1,COPY_DST:2,COPY_SRC:4,UNIFORM:8,MAP_READ:16};
  globalThis.GPUMapMode??={READ:1};
  let wall=0,writes=0,dispatches=0,copies=0;
  const buffers=[];
  const device={queue:{writeBuffer(buffer,offset,data){writes++;const bytes=ArrayBuffer.isView(data)
    ?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);buffer.bytes.set(bytes,offset);}},
    createBuffer({size,label}){
      let resolveMap;
      const buffer={label,bytes:new Uint8Array(size),mapState:'unmapped',
        mapAsync(){this.mapState='pending';return new Promise(resolve=>{resolveMap=resolve;});},
        finishMap(){this.mapState='mapped';resolveMap();},getMappedRange(){return this.bytes.buffer;},
        unmap(){this.mapState='unmapped';},destroy(){this.mapState='unmapped';}};
      buffers.push(buffer);return buffer;
    },createBindGroup(value){return value;}};
  const probe=await createHullContactProbe({device,frameUBO:{},hullUBO:{},seaView:{},seaSampler:{},
    computePipe:async()=>({getBindGroupLayout(){return {};}}),clock:()=>wall,limits});
  const cp={setPipeline(){},setBindGroup(){},dispatchWorkgroups(){dispatches++;}};
  const encoder={copyBufferToBuffer(source,from,target,to,size){copies++;target.bytes.set(source.bytes.subarray(from,from+size),to);}};
  const boat={modelId:'nina',x:0,z:0,heave:0,length:20,beam:6,heading:0,pitch:0,roll:0,
    showProw:true,propulsion:'sail',revision:0,surgeVelocity:0};
  function queue(eventIndices=[0]){
    probe.output.bytes.fill(0);
    for(const index of eventIndices)eventRecord(probe.output.bytes.buffer,index,probe.epoch,{time:probe.snapshot().time});
    assert.equal(probe.copy(encoder,8),true);
  }
  return {probe,boat,cp,encoder,queue,counts:()=>({writes,dispatches,copies}),setWall:value=>{wall=value;},
    active(){assert.equal(probe.update(boat,.04,{enabled:true}),true);assert.equal(probe.encode(cp),true);}};
}

test('disabled probe produces no idle queue writes, dispatches or copies; enable/visibility/revision reset history',async()=>{
  const f=await lifecycleFixture(),start=f.counts();
  for(let i=0;i<3;i++){
    assert.equal(f.probe.update(f.boat,.04,{enabled:false}),false);
    assert.equal(f.probe.encode(f.cp),false);assert.equal(f.probe.copy(f.encoder,8),false);
  }
  assert.deepEqual(f.counts(),start);
  f.active();const epoch=f.probe.epoch;
  f.probe.update(f.boat,.04,{enabled:true,hidden:true});assert.ok(f.probe.epoch>epoch);
  const paused=f.counts();assert.equal(f.probe.encode(f.cp),false);assert.deepEqual(f.counts(),paused);
  f.active();let next=f.probe.epoch;f.boat.revision++;f.active();assert.ok(f.probe.epoch>next);
  next=f.probe.epoch;f.probe.update(f.boat,.04,{enabled:true,resetSea:true});assert.ok(f.probe.epoch>next);
  next=f.probe.epoch;f.probe.update(f.boat,0,{enabled:true});assert.ok(f.probe.epoch>next);
  f.probe.destroy();
});

test('copy/read promises reject pending old epochs before consumption and refresh age at final application',async()=>{
  const f=await lifecycleFixture();f.active();f.queue();const delivered=[];
  const pending=f.probe.read(event=>delivered.push(event));
  f.probe.reset();f.probe.readback.finishMap();assert.equal(await pending,0);
  assert.deepEqual(delivered,[]);assert.deepEqual(f.probe.snapshot().consumer.serials,Array(10).fill(0));
  f.active();f.queue();const next=f.probe.read(event=>delivered.push(event));
  f.probe.readback.finishMap();assert.equal(await next,1);assert.equal(delivered.length,1);
  assert.ok(f.probe.refreshEvent(delivered[0]));
  f.setWall(1000);assert.equal(f.probe.refreshEvent(delivered[0]),null,'delayed waterline application rechecks wall age');
  f.probe.destroy();
});

test('read consumes but does not deliver callbacks after wall stalls or slow earlier callbacks',async()=>{
  const f=await lifecycleFixture();f.active();f.queue();const delivered=[];
  const stalled=f.probe.read(e=>delivered.push(e));f.setWall(1000);f.probe.readback.finishMap();
  assert.equal(await stalled,0);assert.equal(delivered.length,0);
  assert.equal(f.probe.snapshot().consumer.serials[0],1,'stale event was consumed');
  f.setWall(1100);f.probe.reset();f.active();f.queue([0,1]);
  const slow=f.probe.read(async event=>{delivered.push(event);f.setWall(2100);});
  f.probe.readback.finishMap();assert.equal(await slow,1);
  assert.equal(delivered.length,1,'second callback expires while the first is awaited');
  f.probe.destroy();
});

test('out-of-band point/attitude jumps reseed instead of manufacturing entry',async()=>{
  const f=await lifecycleFixture();f.active();let epoch=f.probe.epoch;
  f.boat.heading=180;f.active();assert.ok(f.probe.epoch>epoch,'stationary half-turn is a discontinuity');
  epoch=f.probe.epoch;f.boat.roll=Math.PI;f.active();assert.ok(f.probe.epoch>epoch,'stationary half-roll is a discontinuity');
  epoch=f.probe.epoch;f.boat.x=100;f.active();assert.ok(f.probe.epoch>epoch,'teleport is a discontinuity');
  epoch=f.probe.epoch;f.boat.x+=.04;f.boat.surgeVelocity=1;f.active();assert.equal(f.probe.epoch,epoch,'small physical travel retains history');
  assert.equal(HULL_CONTACT_LIMITS.staleSeconds,.35);f.probe.destroy();
});
