// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone runs validation.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {forestTerrainPyramid,withForestTerrainOcclusion} from '../js/forest-occlusion.js';
import {FOREST_CULL_WGSL,FOREST_MASS_MIDDLE_NEIGHBOR_ROOT_CULL_WGSL} from '../js/forest-scenery.js';

test('terrain bounds cover both raster triangles at every pyramid level, including saddle cells',()=>{
 const size=9,heights=Float32Array.from({length:size*size},(_,i)=>((i*17)%31)-10),region={size,span:80,x:0,z:0},p=forestTerrainPyramid(heights,region);
 for(let level=0;level<p.levels.length;level++){
  const step=1<<level,n=8>>level,data=p.levels[level];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
   const nodes=[];for(let z=j*step;z<=(j+1)*step;z++)for(let x=i*step;x<=(i+1)*step;x++)nodes.push(heights[z*size+x]);
   assert.equal(data[(j*n+i)*2],Math.min(...nodes));assert.equal(data[(j*n+i)*2+1],Math.max(...nodes));
  }
 }
 const saddle=new Float32Array([0,100,0,100,0,100,0,100,0]);const bounds=forestTerrainPyramid(saddle,{size:3,span:2,x:0,z:0});
 assert.equal(bounds.levels[0][0],0,'a positive bilinear height is not an opaque triangle guarantee');
 assert.throws(()=>forestTerrainPyramid(new Float32Array(16),{size:4,span:3,x:0,z:0}),/grid/);
 heights[0]=NaN;assert.throws(()=>forestTerrainPyramid(heights,region),/Nonfinite/);
});
test('terrain occlusion extends both standalone and production neighbor culling without changing LOD thresholds',()=>{
 for(const source of [FOREST_CULL_WGSL,FOREST_MASS_MIDDLE_NEIGHBOR_ROOT_CULL_WGSL]){
  const extended=withForestTerrainOcclusion(source);
  assert.ok(extended.includes('if(forestTerrainHidden(world,radius)){return;}'));
  assert.ok(extended.includes('farError<=threshold'));
  assert.throws(()=>withForestTerrainOcclusion(extended),/mismatch/);
 }
});
test('GPU terrain curtain keeps visible crowns, saddle apertures, near seams and underwater views',{timeout:120000},async t=>{
 const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/tests/fixtures/forest-gpu.html');
  const result=await page.evaluate(async()=>{
   const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{FOREST_TERRAIN_OCCLUSION_WGSL,createForestTerrainOcclusion}=await import('/js/forest-occlusion.js');
   const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
   const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
   const module=device.createShaderModule({code:FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>spheres:array<vec4f>;
@group(0)@binding(2)var<storage,read_write>hidden:array<u32>;`+FOREST_TERRAIN_OCCLUSION_WGSL+`
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){if(id.x<arrayLength(&spheres)){let s=spheres[id.x];hidden[id.x]=u32(forestTerrainHidden(s.xyz,s.w));}}`});
   const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));
   const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),region={size:9,span:80,x:0,z:0};
   const grid=(r,fn)=>Float32Array.from({length:r.size*r.size},(_,i)=>fn(r.x-r.span/2+(i%r.size)*r.span/(r.size-1),r.z-r.span/2+Math.floor(i/r.size)*r.span/(r.size-1)));
   const ridge=grid(region,x=>Math.abs(x)<=10?80:0),flat=grid(region,()=>0),rows=[];
   async function run(name,heights,camera,spheres,near=null){
    const terrain=createForestTerrainOcclusion({device,heights,region,near}),fd=new Float32Array(96);fd.set(camera,16);
    const frame=make(fd,B.UNIFORM),input=make(new Float32Array(spheres.flat()),B.STORAGE),output=make(new Uint32Array(spheres.length),B.STORAGE|B.COPY_SRC),read=device.createBuffer({size:spheres.length*4,usage:B.COPY_DST|B.MAP_READ});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[frame,input,output].map((buffer,binding)=>({binding,resource:{buffer}})).concat(terrain.entries)}),enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(spheres.length/64));pass.end();enc.copyBufferToBuffer(output,0,read,0,spheres.length*4);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();for(const b of[frame,input,output,read])b.destroy();terrain.destroy();rows.push({name,values});return values;
   }
   await run('ridge',ridge,[-30,30,0],[[30,30,0,2],[30,120,0,2],[30,30,30,30],[30,5,0,10]]);
   await run('above',ridge,[-30,120,0],[[30,120,0,2]]);
   await run('inside',ridge,[0,30,0],[[30,30,0,2]]);
   await run('underwater',ridge,[-30,-10,0],[[30,30,0,2]]);
   await run('open-sea',flat,[-30,30,0],[[30,30,0,2]]);
   const closed=grid(region,(x,z)=>Math.abs(x)<=20&&Math.abs(z)<=20?80:0);
   await run('certified-outside-sea-camera',closed,[-55,8,0],[[30,8,0,1]]);
   const raisedEdge=closed.slice();raisedEdge[0]=10;
   await run('uncertain-outside-camera',raisedEdge,[-55,8,0],[[30,8,0,1]]);
   const fineRegion={size:33,span:40,x:0,z:0},fine=(fn)=>({heights:grid(fineRegion,fn),manifest:{domain:fineRegion}});
   await run('near-clears-coarse-ridge',ridge,[-30,30,0],[[30,30,0,2]],fine(()=>0));
   await run('near-ridge',flat,[-30,30,0],[[30,30,0,2],[10,30,0,12]],fine((x,z)=>Math.abs(x)<18&&Math.abs(z)<18?80:0));
   // A low diagonal saddle must remain open even though bilinear interpolation
   // would invent a high occluder through its centre.
   const saddle=grid(region,(x,z)=>x===0&&z===0?0:Math.abs(x)<=10&&Math.abs(z)<=10?100:0);
   await run('saddle',saddle,[-30,10,0],[[30,10,0,1]]);
   await device.queue.onSubmittedWorkDone();device.destroy();return {errors,rows};
  });
  assert.deepEqual(result.errors,[]);const by=Object.fromEntries(result.rows.map(r=>[r.name,r.values]));
  assert.deepEqual(by.ridge,[1,0,0,0]);for(const name of ['above','inside','underwater','open-sea','near-clears-coarse-ridge','saddle'])assert.deepEqual(by[name],[0],name);
  assert.deepEqual(by['certified-outside-sea-camera'],[1]);assert.deepEqual(by['uncertain-outside-camera'],[0]);
  assert.deepEqual(by['near-ridge'],[1,0],'near triangles may occlude; uncertain replacement seams must retain the tree');t.diagnostic(JSON.stringify(result.rows));
 }finally{await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
});
