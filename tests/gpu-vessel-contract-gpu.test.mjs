// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Observe real production commands; no renderer, mesh animator or shader stub.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {SHIP_MODELS} from '../js/ship-models.js';
import {MAX_FLEET_VESSELS} from '../js/fleet.js';
import {assertGPUVesselFrame} from './helpers/gpu-vessel-contract.mjs';

const contractModels=Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry).map(m=>m.id);
let contractServer,contractBrowser,contractOrigin;
before(async()=>{
  contractServer=createDevServer();contractServer.listen(0,'127.0.0.1');await once(contractServer,'listening');contractOrigin='http://127.0.0.1:'+contractServer.address().port;
  contractBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await contractBrowser?.close();if(contractServer)await new Promise(resolve=>contractServer.close(resolve));});

function instrumentVesselGPUContract(){
  const r=window.vesselGPUContract={callback:null,now:null,device:null,errors:[],groups:new WeakMap(),allGroups:[],pass:new WeakMap(),draws:[],dispatches:[],writes:[],copies:[]};
  window.requestAnimationFrame=f=>{r.callback=f;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...a){const d=await request.apply(this,a);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
  const create=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(d){const g=create.call(this,d);r.groups.set(g,d.entries);r.allGroups.push(g);return g;};
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,offset,data,start=0,count){const bytes=ArrayBuffer.isView(data)?data.BYTES_PER_ELEMENT??1:1;r.writes.push({buffer,offset,bytes:count===undefined?data.byteLength-start*bytes:count*bytes});return write.call(this,buffer,offset,data,start,count);};
  const copy=GPUCommandEncoder.prototype.copyBufferToBuffer;
  GPUCommandEncoder.prototype.copyBufferToBuffer=function(source,sourceOffset,destination,destinationOffset,size){
    r.copies.push({source,sourceOffset,destination,destinationOffset,bytes:size??Math.min(source.size-sourceOffset,destination.size-destinationOffset)});
    return copy.call(this,source,sourceOffset,destination,destinationOffset,size);
  };
  for(const prototype of [GPUComputePassEncoder.prototype,GPURenderPassEncoder.prototype]){
    const pipeline=prototype.setPipeline,group=prototype.setBindGroup;
    prototype.setPipeline=function(p){let s=r.pass.get(this);if(!s)r.pass.set(this,s={groups:[],vertices:[]});s.pipeline=p;return pipeline.call(this,p);};
    prototype.setBindGroup=function(i,g,...a){let s=r.pass.get(this);if(!s)r.pass.set(this,s={groups:[],vertices:[]});s.groups[i]=g;return group.call(this,i,g,...a);};
  }
  const vertices=GPURenderPassEncoder.prototype.setVertexBuffer;
  GPURenderPassEncoder.prototype.setVertexBuffer=function(i,b,...a){let s=r.pass.get(this);if(!s)r.pass.set(this,s={groups:[],vertices:[]});s.vertices[i]=b;return vertices.call(this,i,b,...a);};
  const draw=GPURenderPassEncoder.prototype.drawIndexed;
  GPURenderPassEncoder.prototype.drawIndexed=function(n,...a){const s=r.pass.get(this);r.draws.push({pipeline:s?.pipeline,vertices:s?.vertices.slice(),count:n});return draw.call(this,n,...a);};
  const dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...a){const s=r.pass.get(this);r.dispatches.push({pipeline:s?.pipeline,groups:s?.groups.slice(),size:a});return dispatch.apply(this,a);};
}

async function contractFrame(page,mutation=null){
  return page.evaluate(async mutation=>{
    const r=vesselGPUContract,ships=oceanFleet.vessels,lead=ships[0],callback=r.callback;
    if(typeof callback!=='function')throw Error('No actual production RAF callback');
    r.callback=null;r.draws=[];r.dispatches=[];r.writes=[];r.copies=[];let undo=()=>{};
    const groupBuffers=g=>(r.groups.get(g)??[]).flatMap(e=>e.resource?.buffer?[e.resource.buffer]:[]);
    if(mutation==='disabled-pipeline'){
      const encode=lead.pose.encode;lead.pose.encode=()=>false;undo=()=>{lead.pose.encode=encode;};
    }else if(['zero-work','zero-work-y','zero-work-z','short-work'].includes(mutation)){
      const group=r.allGroups.find(g=>{const buffers=groupBuffers(g);return buffers.includes(lead.pose.buffer)&&buffers.includes(lead.vertexBuffer);});
      if(!group)throw Error('Workgroup mutant could not find the actual canonical pose bind group');
      const count=Math.ceil(lead.pose.vertexCount/64),size=mutation==='zero-work'?[0,1,1]:mutation==='zero-work-y'?[count,0,1]:mutation==='zero-work-z'?[count,1,0]:[count-1,1,1];
      if(count<2)throw Error('Workgroup mutant needs at least two canonical workgroups');
      const encode=lead.pose.encode;
      lead.pose.encode=(pass,enabled=true)=>{
        if(!enabled)return false;
        pass.setPipeline(lead.pose.assets.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(...size);return true;
      };
      undo=()=>{lead.pose.encode=encode;};
    }else if(mutation==='recoil-only'){
      const recoil=lead.pose.assets.recoilAssets;
      if(!recoil?.recordCount)throw Error('Recoil-only mutant requires a gun-equipped lead vessel');
      const group=r.allGroups.find(g=>{const buffers=groupBuffers(g);return buffers.includes(lead.pose.buffer)&&buffers.includes(recoil.records);});
      if(!group)throw Error('Recoil-only mutant could not find the actual recoil bind group');
      const encode=lead.pose.encode;
      lead.pose.encode=(pass,enabled=true)=>{
        if(!enabled)return false;
        pass.setPipeline(recoil.pipeline);pass.setBindGroup(0,group);
        pass.dispatchWorkgroups(Math.ceil(recoil.recordCount/64));return true;
      };
      undo=()=>{lead.pose.encode=encode;};
    }else if(mutation==='cpu-fallback'){
      const asset=lead.asset;lead.asset={...asset,pose(){return true;}};undo=()=>{lead.asset=asset;};
    }else if(mutation==='full-mesh-upload')r.device.queue.writeBuffer(lead.vertexBuffer,0,lead.mesh);
    else if(mutation==='staging-copy'){
      const bytes=lead.mesh.byteLength,staging=r.device.createBuffer({label:'deliberate CPU animation staging mutant',size:bytes*2,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});
      const cpu=new Float32Array(staging.getMappedRange());cpu.set(lead.mesh);cpu.set(lead.mesh,lead.mesh.length);cpu[0]+=.025;staging.unmap();
      const encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(staging,0,lead.vertexBuffer,0,bytes);r.device.queue.submit([encoder.finish()]);
      undo=async()=>{
        const restore=r.device.createCommandEncoder();restore.copyBufferToBuffer(staging,bytes,lead.vertexBuffer,0,bytes);r.device.queue.submit([restore.finish()]);
        await r.device.queue.onSubmittedWorkDone();staging.destroy();
      };
    }
    r.now=(r.now??performance.now())+50;callback(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));
    const rows=ships.map(v=>{
      const posed=v.pose?.buffer,has=(d,b)=>d.groups.some(g=>groupBuffers(g).includes(b)),consumes=d=>d.vertices?.[1]===posed&&d.count>0;
      const canonical=posed?r.dispatches.filter(d=>d.pipeline===v.pose.assets.pipeline&&has(d,posed)):[];
      const complete=d=>d.size[0]>=Math.ceil(v.pose.vertexCount/64)&&(d.size[1]??1)>0&&(d.size[2]??1)>0;
      const writesTo=buffer=>[
        ...r.writes.filter(w=>w.buffer===buffer).map(({offset,bytes})=>({kind:'queue-write',offset,bytes})),
        ...r.copies.filter(c=>c.destination===buffer&&c.bytes>0).map(({destinationOffset:offset,bytes})=>({kind:'buffer-copy',offset,bytes})),
      ];
      let changed=false;for(let i=0;i<v.mesh.length;i++)if(v.mesh[i]!==v.asset.vertices[i]){changed=true;break;}
      return {id:v.id,model:v.asset.model.id,required:v.asset.gpuPose===true&&v.render.gpuPose===true,cpuPose:typeof v.asset.pose==='function',pose:!!posed,
        dispatches:canonical.filter(complete).length,canonicalDispatches:canonical.length,dispatchSizes:canonical.map(d=>d.size),
        recoilDispatches:posed?r.dispatches.filter(d=>d.pipeline===v.pose.assets.recoilAssets?.pipeline&&has(d,posed)).length:0,
        main:r.draws.filter(d=>d.pipeline===v.render.pipeline&&consumes(d)).length,
        submerged:r.draws.filter(d=>d.pipeline===v.render.submerged.pipeline&&consumes(d)).length,
        shadow:r.draws.filter(d=>/shadows/.test(d.pipeline?.label??'')&&consumes(d)).length,shadowExpected:true,
        wetness:posed?r.dispatches.filter(d=>has(d,posed)&&has(d,v.wetness.state)).length:0,
        geometryWrites:writesTo(v.vertexBuffer),poseWrites:writesTo(posed),cpuMeshChanged:changed};
    });
    await undo();return {errors:r.errors,rows};
  },mutation);
}

for(const path of ['/', '/docs/index.html'])test(`${path}: every registered vessel dispatches on GPU and reuses its output across every graphics consumer`,{timeout:600000},async()=>{
  for(let start=0;start<contractModels.length;start+=MAX_FLEET_VESSELS){
    const models=contractModels.slice(start,start+MAX_FLEET_VESSELS),page=await contractBrowser.newPage({viewport:{width:384,height:256}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(instrumentVesselGPUContract);
    const query=new URLSearchParams({ship:models[0],fleet:models.slice(1).join(','),view:'ship',crew:'0',boatHeading:'90',windDir:'118',windSpeed:'9',sunElev:'35',clouds:'0',swellHs:'.2',w:'160',h:'108'});
    try{
      await page.goto(contractOrigin+path+'?'+query);
      await page.waitForFunction(()=>vesselGPUContract.callback||oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:300000});
      assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
      for(let i=0;i<3;i++)await contractFrame(page);
      assertGPUVesselFrame(await contractFrame(page),models);assert.deepEqual(errors,[]);
      // These are actual runtime mutations followed by actual production frames,
      // not invented JSON flags. The same qualification must reject each.
      for(const mutant of ['disabled-pipeline','recoil-only','zero-work','zero-work-y','zero-work-z','short-work','cpu-fallback','full-mesh-upload','staging-copy']){
        const bad=await contractFrame(page,mutant);
        if(mutant==='recoil-only'){
          assert.equal(bad.rows[0].dispatches,0,'recoil dispatch cannot qualify as canonical pose');
          assert.ok(bad.rows[0].recoilDispatches>0,'mutant must dispatch the actual recoil pipeline');
        }
        if(['zero-work','zero-work-y','zero-work-z','short-work'].includes(mutant)){
          assert.ok(bad.rows[0].canonicalDispatches>0,'mutant must issue an actual canonical dispatch call');
          assert.equal(bad.rows[0].dispatches,0,'zero or insufficient work must not qualify: '+JSON.stringify(bad.rows[0].dispatchSizes));
        }
        if(mutant==='staging-copy'){
          assert.equal(bad.rows[0].cpuMeshChanged,false,'staging mutant must preserve the observed CPU rest mesh');
          assert.ok(bad.rows[0].dispatches>0,'staging mutant must retain complete canonical GPU work');
          assert.ok(bad.rows[0].geometryWrites.some(w=>w.kind==='buffer-copy'&&w.bytes>0),'mutant must submit a real staging copy into immutable GPU geometry');
          assert.ok(bad.rows[0].geometryWrites.every(w=>w.kind==='buffer-copy'),'mutant must exercise the copy guard without a direct mesh writeBuffer');
        }
        assert.throws(()=>assertGPUVesselFrame(bad,models),undefined,mutant+' must fail');
        assertGPUVesselFrame(await contractFrame(page),models);
      }
    }finally{await page.close();}
  }
});
