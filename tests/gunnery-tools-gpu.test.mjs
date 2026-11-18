// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Every tool a gun crew holds is stood on the GPU as an instance of its piece of the props' atlas (js/gunnery-tools.js
// GUNNERY_TOOL_PLACE_WGSL), which the one continuum then cuts. Here each instance is checked against its record: it
// stands at the record's first end in the world, its piece's own up turned onto the line to the second, a hauled
// piece drawn out to reach it, and a record with no piece stands nothing.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('the GPU stands every gun crew\'s tools as turned pieces of the props\' atlas',{timeout:240000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gun-tool-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__gun-tool-gpu');
    const result=await page.evaluate(async()=>{
      const {SHIP_MODELS}=await import('/js/ship-models.js'),{createGunDefinitions}=await import('/js/gunnery-models.js'),{crewGunStation}=await import('/js/crew-work.js');
      const {GUNNERY_TOOL_PLACE_WGSL,GUNNERY_TOOL_RECORDS,GUNNERY_TOOL_RECORD_FLOATS,writeGunneryToolInstances,gunneryToolPose}=await import('/js/gunnery-tools.js');
      const {PROP_CONTINUUM_TOOLS,PROP_CONTINUUM_TOOL_FIRST}=await import('/js/prop-continuum.js'),{CITY_CONTINUUM_GONE,CITY_CONTINUUM_INSTANCE_WORDS:W}=await import('/js/wgsl/city-continuum.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const module=device.createShaderModule({code:GUNNERY_TOOL_PLACE_WGSL});
      const compilation=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message);if(compilation.length)throw Error(compilation.join('\n'));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'gunneryToolPlace'}});
      const records=device.createBuffer({size:GUNNERY_TOOL_RECORDS*GUNNERY_TOOL_RECORD_FLOATS*4,usage:B.STORAGE|B.COPY_DST}),pose=device.createBuffer({size:64,usage:B.UNIFORM|B.COPY_DST});
      const out=device.createBuffer({size:GUNNERY_TOOL_RECORDS*W*4,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:out.size,usage:B.COPY_DST|B.MAP_READ});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[records,pose,out].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const turn=(q,v)=>{const t=[2*(q[1]*v[2]-q[2]*v[1]),2*(q[2]*v[0]-q[0]*v[2]),2*(q[0]*v[1]-q[1]*v[0])];return [0,1,2].map(k=>v[k]+q[3]*t[k]+[q[1]*t[2]-q[2]*t[1],q[2]*t[0]-q[0]*t[2],q[0]*t[1]-q[1]*t[0]][k]);};
      const values=new Float32Array(GUNNERY_TOOL_RECORDS*GUNNERY_TOOL_RECORD_FLOATS),gunIDs=[],pieces=new Set();
      let cases=0,stood=0,root=0,along=0,reach=0,typed=0,unit=0,emptyReady=true,emptyPrime=true;
      for(const model of Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry))for(const definition of createGunDefinitions(model.id)){
        gunIDs.push(model.id+'/'+definition.id);
        for(const stage of ['swab','load','ram','runout','prime','ready'])for(const role of ['loader','tackle'])for(const progress of [.125,.875]){
          const boat={modelId:model.id,model,length:model.runtime.length*1.11,beam:model.runtime.beam*.89,heading:32,pitch:.1,roll:-.2,x:15,z:-8,heave:.4},gun={...definition,stage,progress,offset:definition.recoilLength*.65},station=crewGunStation(gun,role,boat),scale=[boat.beam/3.6,model.designFrame.verticalScale,boat.length/12];
          const company={crew:[{intent:'work',position:station.map((v,k)=>v*scale[k]),job:{kind:'gunnery',stage:'working',gunRole:role,gun}}]},before=JSON.stringify({company,boat});
          const {count}=writeGunneryToolInstances(company,boat,values);cases++;
          if(JSON.stringify({company,boat})!==before)throw Error('Graphics altered crew/physical gun state');
          if(stage==='ready')emptyReady&&=count===0;if(stage==='prime')emptyPrime&&=count===0;
          if(!count)continue;
          // One record more with no piece, which must stand nothing.
          values.set([0,0,0,-1,1,1,1,0],count*GUNNERY_TOOL_RECORD_FLOATS);
          const P=gunneryToolPose(boat,count+1);
          device.queue.writeBuffer(records,0,values,0,(count+1)*GUNNERY_TOOL_RECORD_FLOATS);device.queue.writeBuffer(pose,0,P);
          const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
          encoder.copyBufferToBuffer(out,0,read,0,(count+1)*W*4);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ,0,(count+1)*W*4);
          const range=read.getMappedRange(0,(count+1)*W*4),floats=new Float32Array(range.slice(0)),words=new Uint32Array(floats.buffer);read.unmap();
          const world=p=>[0,1,2].map(k=>P[12+k]+P[k]*p[0]+P[4+k]*p[1]+P[8+k]*p[2]);
          for(let r=0;r<count;r++){
            const at=r*GUNNERY_TOOL_RECORD_FLOATS,piece=values[at+3],tool=PROP_CONTINUUM_TOOLS[piece],a=world(values.subarray(at,at+3)),b=world(values.subarray(at+4,at+7));
            const d=b.map((v,k)=>v-a[k]),n=Math.hypot(...d),i=r*W,q=Array.from(floats.subarray(i+12,i+16));
            pieces.add(tool.name);stood++;
            if(words[i+8]!==PROP_CONTINUUM_TOOL_FIRST+piece)typed++;
            root=Math.max(root,Math.hypot(...a.map((v,k)=>v-floats[i+k])));
            unit=Math.max(unit,Math.abs(Math.hypot(...q)-1));
            const up=turn(q,[0,1,0]);along=Math.max(along,Math.hypot(...up.map((v,k)=>v-d[k]/n)));
            const drawn=(tool.hauled?floats[i+5]:1)*tool.length;reach=Math.max(reach,tool.hauled?Math.abs(drawn-n):Math.abs(floats[i+5]-1));
          }
          if(!(words[count*W+8]&CITY_CONTINUUM_GONE))typed++;
        }
      }
      for(const b of [records,pose,out,read])b.destroy();device.destroy();
      return {errors,gunIDs,cases,stood,root,along,reach,typed,unit,emptyReady,emptyPrime,pieces:[...pieces].sort()};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.ok(result.gunIDs.length>=116&&result.cases>1000&&result.stood>1000);
    assert.ok(result.emptyReady&&result.emptyPrime,'ready and priming crews hold no tool');assert.equal(result.typed,0,'every instance is its piece, and a record with none is gone');
    for(const name of ['rammer-head','rammer-staff','sponge-head','tackle-fall'])assert.ok(result.pieces.includes(name),name+' is stood');
    assert.ok(result.root<=1e-4,'each piece stands at its first end: '+result.root);assert.ok(result.unit<=1e-5,'its turn is a unit quaternion: '+result.unit);
    assert.ok(result.along<=1e-4,'its own up lies along its line: '+result.along);assert.ok(result.reach<=1e-4,'a fall of tackle reaches its hands, and nothing else is stretched: '+result.reach);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
