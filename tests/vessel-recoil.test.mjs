// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createVesselRecoil} from '../js/vessel-recoil.js';
import {VESSEL_RECOIL_UPDATE} from '../js/wgsl/vessel-recoil.js';
import {createGunRecoilMap,createGunDefinitions,gunMuzzlePose} from '../js/gunnery-models.js';
import {createShipAssetCache} from '../js/ship-mesh.js';

function vesselRecoilTestDevice(){
  const buffers=[],writes=[],groups=[];
  const device={createBuffer(desc){const b={...desc,destroyed:false,destroyCalls:0,destroy(){this.destroyed=true;this.destroyCalls++;}};buffers.push(b);return b;},
    createBindGroup(desc){groups.push(desc);return desc;},queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,data:data.slice()});}}};
  return {device,buffers,writes,groups};
}
function vesselRecoilTestUsage(t){
  const prior=Object.getOwnPropertyDescriptor(globalThis,'GPUBufferUsage');
  Object.defineProperty(globalThis,'GPUBufferUsage',{configurable:true,value:{STORAGE:1,COPY_DST:2}});
  t.after(()=>prior?Object.defineProperty(globalThis,'GPUBufferUsage',prior):delete globalThis.GPUBufferUsage);
}

test('recoil uploads immutable actual gun vertex ownership once and only compact physical bore deltas thereafter',async t=>{
  vesselRecoilTestUsage(t);const cache=createShipAssetCache();
  for(const modelId of ['nina','victory','pinta','santa-maria']){
    const asset=cache.get(modelId),recoilMap=createGunRecoilMap(asset),original=new Float32Array(asset.vertices),mock=vesselRecoilTestDevice(),posedBuffer={};
    const pipeline={getBindGroupLayout(){return{};}};let compiled=0;
    const helper=await createVesselRecoil({device:mock.device,computePipe:async(code,label)=>{assert.equal(code,VESSEL_RECOIL_UPDATE);assert.match(label,/recoil/);compiled++;return pipeline;},posedBuffer,recoilMap});
    assert.equal(compiled,1);assert.ok(helper);assert.equal(mock.buffers.length,2);
    const records=mock.writes[0].data,expected=[];
    for(const [slot,gun]of recoilMap.guns.entries())for(const index of gun.indices)expected.push(index,slot);
    assert.deepEqual(records,Uint32Array.from(expected));assert.equal(mock.writes[0].buffer,helper.assets.records);
    assert.equal(helper.assets.recordCount,expected.length/2);assert.equal(mock.buffers[1].size,recoilMap.guns.length*16);
    assert.equal(mock.groups[0].entries[0].resource.buffer,posedBuffer);
    const boat={modelId,length:80,beam:11},defs=createGunDefinitions(modelId),offsets=new Map(defs.map(g=>[g.id,{offset:g.id%2?.17:.7}]));
    assert.equal(helper.update(offsets,boat),true);assert.equal(mock.writes.length,2);
    const deltas=mock.writes.at(-1).data;
    assert.equal(deltas.length,recoilMap.guns.length*4);
    for(const [slot,gun]of recoilMap.guns.entries()){
      const def=defs.find(g=>g.id===gun.id),rest=gunMuzzlePose(def,boat),moved=gunMuzzlePose({...def,offset:offsets.get(gun.id).offset},boat);
      const scale=[boat.beam/3.6,asset.model.designFrame.verticalScale,boat.length/12];
      for(let j=0;j<3;j++)assert.ok(Math.abs(deltas[slot*4+j]-(moved.localPosition[j]-rest.localPosition[j])/scale[j])<2e-7,modelId+' physical bore displacement '+gun.id);
      assert.equal(deltas[slot*4+3],0);
    }
    assert.equal(helper.update(offsets,boat),false);assert.equal(mock.writes.length,2,'unchanged compact state needs no upload');
    assert.deepEqual(asset.vertices,original,modelId+' CPU geometry is never modified');
    const calls=[],pass={setPipeline:p=>calls.push(p),setBindGroup:(i,g)=>calls.push(g),dispatchWorkgroups:n=>calls.push(n)};
    assert.equal(helper.encode(pass,false),false);assert.deepEqual(calls,[]);
    assert.equal(helper.encode(pass),true);assert.equal(calls.at(-1),Math.ceil(expected.length/2/64));
    assert.equal(helper.update(null,boat),true);assert.ok(mock.writes.at(-1).data.every(v=>v===0));
    assert.equal(helper.encode(pass),false,'canonical pose already restored zero-offset guns');
    helper.destroy();assert.equal(helper.encode(pass),false);assert.equal(helper.update(offsets,boat),false);
  }
});

test('recoil shares same-model GPU records while each vessel owns its live state and posed output',async t=>{
  vesselRecoilTestUsage(t);const mock=vesselRecoilTestDevice(),pipeline={getBindGroupLayout(){return{};}};let compiled=0;
  const computePipe=async()=>{compiled++;return pipeline;},map={vertexCount:8,guns:[{id:7,axis:[1,.2,0],indices:new Uint32Array([2,6])}]};
  const posedA={},posedB={},a=await createVesselRecoil({device:mock.device,computePipe,posedBuffer:posedA,recoilMap:map});
  const b=await createVesselRecoil({device:mock.device,computePipe,posedBuffer:posedB,recoilMap:map,shared:a.assets});
  assert.equal(compiled,1);assert.equal(a.assets,b.assets);assert.equal(mock.buffers.length,3);
  assert.notEqual(mock.groups[0].entries[2].resource.buffer,mock.groups[1].entries[2].resource.buffer);
  assert.equal(mock.groups[0].entries[0].resource.buffer,posedA);assert.equal(mock.groups[1].entries[0].resource.buffer,posedB);
  const boat={modelId:'nina',length:20,beam:6};a.update(new Map([[7,.4]]),boat);
  const pass={setPipeline(){},setBindGroup(){},dispatchWorkgroups(){}};
  assert.equal(a.encode(pass),true);assert.equal(b.encode(pass),false);
  a.destroy();a.destroy();assert.equal(mock.buffers[1].destroyCalls,1);assert.equal(a.assets.records.destroyed,false);
  b.update({7:.2},boat);assert.equal(b.encode(pass),true);b.destroy();
  assert.equal(a.assets.records.destroyCalls,1);assert.equal(mock.buffers[2].destroyCalls,1);
  await assert.rejects(createVesselRecoil({device:mock.device,computePipe,posedBuffer:{},recoilMap:map,shared:a.assets}),/no longer available/);
});

test('recoil refuses overlapping vertex owners, incompatible shared layouts and foreign graphics devices',async t=>{
  vesselRecoilTestUsage(t);const mock=vesselRecoilTestDevice(),computePipe=async()=>({getBindGroupLayout(){return{};}});
  const map={vertexCount:8,guns:[{id:0,axis:[1,0,0],indices:new Uint32Array([1])}]};
  const a=await createVesselRecoil({device:mock.device,computePipe,posedBuffer:{},recoilMap:map});
  await assert.rejects(createVesselRecoil({device:mock.device,computePipe,posedBuffer:{},recoilMap:{vertexCount:8,guns:[...map.guns,{id:1,axis:[1,0,0],indices:new Uint32Array([1])}]}}),/ownership overlaps/);
  await assert.rejects(createVesselRecoil({device:mock.device,computePipe,posedBuffer:{},recoilMap:{vertexCount:8,guns:[{id:0,axis:[1,0,0],indices:new Uint32Array([3])}]},shared:a.assets}),/another gun layout/);
  await assert.rejects(createVesselRecoil({device:{},computePipe,posedBuffer:{},recoilMap:map,shared:a.assets}),/another graphics device/);
  assert.equal(await createVesselRecoil({device:mock.device,computePipe,posedBuffer:{},recoilMap:{vertexCount:8,guns:[]}}),null);
  assert.match(VESSEL_RECOIL_UPDATE,/vesselRecoilPosed\[record\.x\]\.position\+=/);
  assert.doesNotMatch(VESSEL_RECOIL_UPDATE,/\.normal\s*=/,'recoil cannot change surface normals');
  a.destroy();
});
