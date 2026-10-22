// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The old CPU triangle builder remains an offline geometry oracle only.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native GPU unit tubes reproduce actual chambers, rammers, sponges and tackle for every gun',{timeout:240000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gun-tool-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__gun-tool-gpu');
    const result=await page.evaluate(async()=>{
      const {SHIP_MODELS}=await import('/js/ship-models.js'),{createGunDefinitions}=await import('/js/gunnery-models.js'),{crewGunStation}=await import('/js/crew-work.js');
      const {GUNNERY_TOOL_GPU_GEOMETRY,createGunneryToolTemplate,writeGunneryToolInstances,buildGunneryToolVertices}=await import('/js/gunnery-tools.js');
      const template=createGunneryToolTemplate(),expected=[],shapes=[],probes=[],cases=[],scratch=new Float32Array(4096*8),compact=new Float32Array(68*8),gunIDs=[];
      for(const model of Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry))for(const definition of createGunDefinitions(model.id)){
        gunIDs.push(model.id+'/'+definition.id);
        for(const stage of ['swab','load','ram','runout','prime','ready'])for(const role of ['loader','tackle'])for(const progress of [.125,.875]){
          const boat={modelId:model.id,model,length:model.runtime.length*1.11,beam:model.runtime.beam*.89,heading:32,pitch:.1,roll:-.2,x:15,z:-8,heave:.4},gun={...definition,stage,progress,offset:definition.recoilLength*.65},station=crewGunStation(gun,role,boat),scale=[boat.beam/3.6,model.designFrame.verticalScale,boat.length/12];
          const company={crew:[{intent:'work',position:station.map((v,k)=>v*scale[k]),job:{kind:'gunnery',stage:'working',gunRole:role,gun}}]},before=JSON.stringify({company,boat});
          const count=buildGunneryToolVertices(company,boat,scratch),packed=writeGunneryToolInstances(company,boat,compact),shapeStart=shapes.length/8,first=probes.length/2;
          if(JSON.stringify({company,boat})!==before)throw Error('Graphics altered crew/physical gun state');
          shapes.push(...compact.subarray(0,packed.count*8));
          for(let bucket=0;bucket<packed.ranges.length;bucket++){
            const range=packed.ranges[bucket],mesh=template.ranges[bucket];
            for(let instance=0;instance<range.count;instance++)for(let vertex=0;vertex<mesh.count;vertex++)probes.push(mesh.first+vertex,shapeStart+range.first+instance);
          }
          if(probes.length/2-first!==count||packed.vertices!==count)throw Error('GPU template topology differs from the real CPU tool '+model.id+'/'+definition.id+'/'+stage+'/'+role);
          expected.push(...scratch.subarray(0,count*8));cases.push({model:model.id,gun:definition.id,stage,role,progress,first,count,instances:packed.count});
        }
      }
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const upload=(values,usage)=>{const b=device.createBuffer({size:values.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,values);return b;};
      const shape=upload(new Float32Array(shapes),B.STORAGE),vertices=upload(template.vertices,B.STORAGE),input=upload(new Uint32Array(probes),B.STORAGE),output=device.createBuffer({size:expected.length/8*48,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:output.size,usage:B.COPY_DST|B.MAP_READ});
      const module=device.createShaderModule({code:GUNNERY_TOOL_GPU_GEOMETRY+`
@group(0)@binding(0)var<storage,read>gunneryToolShapes:array<GunneryToolShape>;
@group(0)@binding(1)var<storage,read>toolTemplates:array<f32>;
@group(0)@binding(2)var<storage,read>toolProbes:array<vec2u>;
struct ToolAnswer{position:vec4f,normal:vec4f,kind:vec4f};
@group(0)@binding(3)var<storage,read_write>toolAnswers:array<ToolAnswer>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=arrayLength(&toolProbes)){return;}let probe=toolProbes[id.x];let at=probe.x*8u;
 let result=gunneryToolVertex(vec3f(toolTemplates[at],toolTemplates[at+1u],toolTemplates[at+2u]),vec3f(toolTemplates[at+3u],toolTemplates[at+4u],toolTemplates[at+5u]),probe.y);
 toolAnswers[id.x]=ToolAnswer(vec4f(result.position,0),vec4f(result.normal,0),vec4f(result.kind,0,0));
}`});
      const compilation=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message);if(compilation.length)throw Error(compilation.join('\n'));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[shape,vertices,input,output].map((buffer,binding)=>({binding,resource:{buffer}}))}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(probes.length/2/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,output.size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const actual=new Float32Array(read.getMappedRange());
      let position=0,normal=0,kindErrors=0,finite=true,worstPosition=null,worstNormal=null;const kinds=new Set();
      for(const c of cases)for(let vertex=c.first;vertex<c.first+c.count;vertex++){
        const p=Math.hypot(...[0,1,2].map(k=>actual[vertex*12+k]-expected[vertex*8+k])),n=Math.hypot(...[0,1,2].map(k=>actual[vertex*12+4+k]-expected[vertex*8+3+k]));
        if(p>position){position=p;worstPosition={...c,vertex,error:p};}if(n>normal){normal=n;worstNormal={...c,vertex,error:n};}
        if(actual[vertex*12+8]!==expected[vertex*8+6]||actual[vertex*12+9]!==expected[vertex*8+7])kindErrors++;kinds.add(actual[vertex*12+8]);if(!Number.isFinite(p+n))finite=false;
      }
      read.unmap();for(const b of [shape,vertices,input,output,read])b.destroy();device.destroy();return {errors,gunIDs,cases:cases.length,vertices:probes.length/2,position,normal,kindErrors,finite,worstPosition,worstNormal,kinds:[...kinds].sort(),emptyReady:cases.filter(c=>c.stage==='ready').every(c=>c.count===0&&c.instances===0),emptyPrime:cases.filter(c=>c.stage==='prime').every(c=>c.count===0&&c.instances===0)};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.ok(result.gunIDs.length>=116&&result.cases>1000&&result.vertices>100000);assert.ok(result.finite&&result.emptyReady&&result.emptyPrime);assert.equal(result.kindErrors,0);assert.deepEqual(result.kinds,[0,1,2]);assert.ok(result.position<=2e-5,'actual tool position error '+result.position+' '+JSON.stringify(result.worstPosition));assert.ok(result.normal<=1e-4,'actual tool normal error '+result.normal+' '+JSON.stringify(result.worstNormal));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
