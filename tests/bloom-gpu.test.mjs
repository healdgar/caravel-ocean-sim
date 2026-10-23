// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {isolatedGPUStageMilliseconds} from '../js/gpu-benchmark.js';
let bloomServer,bloomBrowser,bloomOrigin;
before(async()=>{
  bloomServer=createDevServer();bloomServer.listen(0,'127.0.0.1');await once(bloomServer,'listening');bloomOrigin='http://127.0.0.1:'+bloomServer.address().port;
  bloomBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await bloomBrowser?.close();bloomServer?.closeAllConnections?.();if(bloomServer)await new Promise(r=>bloomServer.close(r));});

test('isolated timing encloses overlapping stages and divides the complete batch, without adding spans',()=>{
  const values=BigUint64Array.from([105,120,100,125,103,119],x=>BigInt(x)*1000000n);
  assert.equal(isolatedGPUStageMilliseconds(values,5),5);
  assert.equal(isolatedGPUStageMilliseconds(new BigUint64Array([0n,0n]),4),0);
  assert.throws(()=>isolatedGPUStageMilliseconds(new BigUint64Array([5n,4n]),1),/Reversed/);
  assert.throws(()=>isolatedGPUStageMilliseconds(new BigUint64Array(),1),/Invalid/);
});

test('folded tent retains the full HDR bloom chain and final pixels against the original nine-fetch filter',{timeout:120000},async t=>{
  const reference=await readFile(new URL('fixtures/bloom-up-reference.wgsl',import.meta.url),'utf8'),page=await bloomBrowser.newPage();
  try{
    await page.route('**/__bloom-test',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(bloomOrigin+'/__bloom-test');
    const result=await page.evaluate(async reference=>{
      const {BLOOM_DOWN,BLOOM_UP,COMPOSITE}=await import('/js/wgsl/post.js'),adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,errors=[];
      device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const pipeline=async(code,format,add=false,constants={})=>{const module=device.createShaderModule({code}),info=await module.getCompilationInfo();if(info.messages.some(m=>m.type==='error'))throw Error(JSON.stringify(info.messages));return device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',constants,targets:[{format,...(add?{blend:{color:{srcFactor:'one',dstFactor:'one',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one',operation:'add'}}}: {})}]}});};
      const down=await pipeline(BLOOM_DOWN,'rgba16float'),ups={reference:await pipeline(reference,'rgba16float',true),folded:await pipeline(BLOOM_UP,'rgba16float',true),disabled:await pipeline(BLOOM_UP,'rgba16float',true,{bloomFoldTent:false})},composite=await pipeline(COMPOSITE,'rgba8unorm'),sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const half=value=>{if(value===0)return 0;const e=Math.floor(Math.log2(value));return ((e+15)<<10)+Math.round((value/2**e-1)*1024);};
      const buffer=values=>{const b=device.createBuffer({size:values.byteLength,usage:B.UNIFORM|B.COPY_DST});device.queue.writeBuffer(b,0,values);return b;};
      const texture=(w,h,levels,format='rgba16float')=>device.createTexture({size:[w,h],mipLevelCount:levels,format,usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC|T.COPY_DST});
      const bind=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const read=async(tex,w,h)=>{const stride=Math.ceil(w*4/256)*256,b=device.createBuffer({size:stride*h,usage:B.COPY_DST|B.MAP_READ}),e=device.createCommandEncoder();e.copyTextureToBuffer({texture:tex},{buffer:b,bytesPerRow:stride},[w,h]);device.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const mapped=new Uint8Array(b.getMappedRange()),out=new Uint8Array(w*h*4);for(let y=0;y<h;y++)out.set(mapped.subarray(y*stride,y*stride+w*4),y*w*4);b.unmap();b.destroy();return out;};
      const rows=[];
      for(const [width,height]of [[1,1],[13,9],[64,48],[257,155]])for(const pattern of ['glints','colour']){
        const bw=Math.max(1,width>>1),bh=Math.max(1,height>>1),levels=Math.min(8,Math.floor(Math.log2(Math.max(bw,bh)))+1),hdr=texture(width,height,1),pixels=new Uint16Array(width*height*4),targets={},uniforms=[];
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const hash=((x*73856093)^(y*19349663))>>>0,a=pattern==='glints'?((hash%71===0)?250:((hash%300)/300)**3):.005+(hash%1600)/100;
          pixels.set([a,a*(pattern==='colour'?.15+(x%9)*.17:.8),a*(pattern==='colour'?.1+(y%7)*.21:.6),1].map(half),(y*width+x)*4);
        }
        device.queue.writeTexture({texture:hdr},pixels,{bytesPerRow:width*8},[width,height]);
        for(const mode of ['reference','folded','disabled']){
          const tex=texture(bw,bh,levels),views=Array.from({length:levels},(_,m)=>tex.createView({baseMipLevel:m,mipLevelCount:1})),steps=[];
          for(let m=0;m<levels;m++){
            const sw=m?Math.max(1,bw>>(m-1)):width,sh=m?Math.max(1,bh>>(m-1)):height,u=buffer(new Float32Array([1/sw,1/sh,m?0:1,0]));uniforms.push(u);steps.push({pipe:down,group:bind(down,[m?views[m-1]:hdr.createView(),sampler,{buffer:u}]),view:views[m],load:'clear'});
          }
          for(let m=levels-1;m>0;m--){const u=buffer(new Float32Array([1/Math.max(1,bw>>m),1/Math.max(1,bh>>m),1,1]));uniforms.push(u);steps.push({pipe:ups[mode],group:bind(ups[mode],[views[m],sampler,{buffer:u}]),view:views[m-1],load:'load'});}
          const enc=device.createCommandEncoder();for(const s of steps){const p=enc.beginRenderPass({colorAttachments:[{view:s.view,loadOp:s.load,clearValue:[0,0,0,1],storeOp:'store'}]});p.setPipeline(s.pipe);p.setBindGroup(0,s.group);p.draw(3);p.end();}device.queue.submit([enc.finish()]);
          targets[mode]={tex,view:views[0],output:texture(width,height,1,'rgba8unorm')};
        }
        for(const strength of [.1,.3]){
          const u=buffer(new Float32Array([1.35,strength,7,.1,1.05,1.06,0,1/levels]));uniforms.push(u);const enc=device.createCommandEncoder();
          for(const mode of ['reference','folded','disabled']){const p=enc.beginRenderPass({colorAttachments:[{view:targets[mode].output.createView(),loadOp:'clear',storeOp:'store'}]});p.setPipeline(composite);p.setBindGroup(0,bind(composite,[hdr.createView(),targets[mode].view,sampler,{buffer:u}]));p.draw(3);p.end();}device.queue.submit([enc.finish()]);
          const a=await read(targets.reference.output,width,height),b=await read(targets.folded.output,width,height);let max=0,sum=0,changed=0;for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);max=Math.max(max,delta);sum+=delta;if(delta)changed++;}
          const disabled=await read(targets.disabled.output,width,height);let fallbackChanged=0;for(let i=0;i<a.length;i++)if(a[i]!==disabled[i])fallbackChanged++;
          rows.push({width,height,pattern,strength,max,mean:sum/a.length,changed,channels:a.length,fallbackChanged});
        }
        for(const u of uniforms)u.destroy();hdr.destroy();for(const t of Object.values(targets)){t.tex.destroy();t.output.destroy();}
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,rows};
    },reference);
    assert.deepEqual(result.errors,[]);for(const row of result.rows){t.diagnostic(JSON.stringify(row));assert.ok(row.max<=1,'final colour differs by more than one 8-bit rounding step: '+JSON.stringify(row));assert.equal(row.fallbackChanged,0,'reference specialization must remain bit-identical');assert.ok(row.mean<.002,'filter must retain the original bloom appearance: '+JSON.stringify(row));}
  }finally{await page.close();}
});

for(const [entry,underwater]of [['/',false],['/docs/index.html',false],['/docs/index.html',true]])test(`${entry}${underwater?' underwater':''}: isolated bloom UI drains prior work, measures all passes, resumes rendering and stays on the phone screen`,{timeout:180000},async t=>{
  const page=await bloomBrowser.newPage({viewport:{width:320,height:568},deviceScaleFactor:2,isMobile:true,hasTouch:true}),errors=[];
  try{
    page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{
      const r=window.bloomDiagnosticTest={frames:0,queries:[],errors:[],mediumDraws:0},request=GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
      const query=GPUDevice.prototype.createQuerySet;GPUDevice.prototype.createQuerySet=function(desc){r.queries.push({label:desc.label,count:desc.count,frame:r.frames});return query.call(this,desc);};
      const set=GPURenderPassEncoder.prototype.setPipeline;GPURenderPassEncoder.prototype.setPipeline=function(pipe){if(pipe.label==='medium bloom source')r.mediumDraws++;return set.call(this,pipe);};
      const current=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return current.apply(this,args);};
    });
    await page.goto(bloomOrigin+entry+'?boat=1&crew=0&follower=0&clouds=0&resolution=native'+(underwater?'&view=ship&orbitElevation=-40&orbitDistance=45':'' ));await page.waitForFunction(()=>window.oceanStartup?.state==='ready',undefined,{timeout:120000});
    assert.equal(await page.evaluate(()=>bloomDiagnosticTest.queries.some(q=>q.label==='isolated stage timestamps')),false,'ordinary rendering never allocates benchmark resources');
    await page.getByRole('button',{name:'Performance stats',exact:true}).click();const measure=page.getByRole('button',{name:'Measure bloom alone',exact:true});await measure.click();
    await page.waitForFunction(()=>document.querySelector('#bloom-measurement')?.dataset.measurement||document.querySelector('#bloom-measurement')?.textContent.includes('unavailable'),undefined,{timeout:30000});
    assert.ok(await page.locator('#bloom-measurement').getAttribute('data-measurement'),await page.locator('#bloom-measurement').textContent());
    const result=await page.evaluate(()=>{const e=document.querySelector('#bloom-measurement'),b=e.getBoundingClientRect();return {measurement:JSON.parse(e.dataset.measurement),text:e.textContent,frames:bloomDiagnosticTest.frames,mediumDraws:bloomDiagnosticTest.mediumDraws,queries:bloomDiagnosticTest.queries,errors:bloomDiagnosticTest.errors,rect:{x:b.x,right:b.right},viewport:innerWidth,details:document.querySelector('#gpu-profile-details').textContent};});
    assert.equal(result.measurement.passCount,15);assert.equal(result.measurement.samples.length,3);assert.equal(result.measurement.repetitions,4);assert.equal(result.measurement.width,640);assert.equal(result.measurement.height,1136);assert.ok(result.measurement.milliseconds>=0&&result.measurement.milliseconds<30000);
    assert.equal(result.queries.filter(q=>q.label==='isolated stage timestamps').length,1);assert.match(result.text,/earlier GPU work excluded/);assert.ok(result.rect.x>=0&&result.rect.right<=result.viewport);assert.deepEqual(result.errors,[]);if(underwater)assert.ok(result.mediumDraws>=12,'isolated batches must use the actual underwater bloom source');
    await page.waitForFunction(frame=>bloomDiagnosticTest.frames>frame+3,result.frames);assert.equal(await measure.isEnabled(),true);assert.deepEqual(errors,[]);t.diagnostic(result.text);
  }finally{await page.close();}
});
