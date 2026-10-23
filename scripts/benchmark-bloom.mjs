#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Root-only native GPU diagnostic. Two real kernels share one explicit layout;
// switching retains scene settings, resolution, filter radius and pass count.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
const output=resolve(process.env.BLOOM_BENCH_OUTPUT||'shots/bloom-benchmark');await mkdir(output,{recursive:true});
const reference=await readFile(new URL('../tests/fixtures/bloom-up-reference.wgsl',import.meta.url),'utf8');
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
const reports=[];
try{
 for(const [width,height]of [[1206,1998],[3840,2160]]){
  const page=await browser.newPage({viewport:{width:Math.ceil(width/3),height:Math.ceil(height/3)},deviceScaleFactor:3}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({reference})=>{
   const r=window.bloomAB={mode:'folded',frames:0,errors:[],reference:null,folded:null,adapter:null};
   const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){r.adapter={vendor:this.info.vendor,architecture:this.info.architecture,device:this.info.device};const d=await request.apply(this,a);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
   const create=GPUDevice.prototype.createRenderPipelineAsync;
   GPUDevice.prototype.createRenderPipelineAsync=async function(desc){
    if(desc.label!=='bloom up')return create.call(this,desc);
    const group=this.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:16}}]});
    const layout=this.createPipelineLayout({bindGroupLayouts:[group]}),module=this.createShaderModule({code:reference});
    r.reference=await create.call(this,{...desc,label:'reference bloom up',layout,vertex:{...desc.vertex,module},fragment:{...desc.fragment,module,constants:{}}});
    r.folded=await create.call(this,{...desc,layout});return r.folded;
   };
   const set=GPURenderPassEncoder.prototype.setPipeline;GPURenderPassEncoder.prototype.setPipeline=function(p){return set.call(this,p===r.folded&&r.mode==='reference'?r.reference:p);};
   const current=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return current.apply(this,args);};
  },{reference});
  const q=new URLSearchParams({boat:'1',follower:'0',view:'ship',resolution:'native',w:String(width),h:String(height),sunElev:'35',windSpeed:'8',swellHs:'1'});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?'+q);await page.waitForFunction(()=>window.oceanStartup?.state==='ready',undefined,{timeout:180000});await page.waitForFunction(()=>bloomAB.frames>=180,undefined,{timeout:60000});
  await page.getByRole('button',{name:'Performance stats',exact:true}).click();
  const measurements=[];
  for(const mode of ['reference','folded','folded','reference','reference','folded']){
   await page.evaluate(mode=>{bloomAB.mode=mode;},mode);await page.getByRole('button',{name:'Measure bloom alone',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#bloom-measurement').dataset.measurement,undefined,{timeout:30000});
   const measurement=await page.evaluate(()=>JSON.parse(document.querySelector('#bloom-measurement').dataset.measurement));measurements.push({mode,...measurement});
  }
  const info=await page.evaluate(()=>({adapter:bloomAB.adapter,errors:bloomAB.errors,summary:document.querySelector('#performance-summary').textContent}));
  assert.deepEqual([...errors,...info.errors],[]);const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)],referenceMs=med(measurements.filter(m=>m.mode==='reference').flatMap(m=>m.samples)),foldedMs=med(measurements.filter(m=>m.mode==='folded').flatMap(m=>m.samples));
  const report={width,height,...info,referenceMs,foldedMs,ratio:foldedMs/referenceMs,measurements};reports.push(report);console.log(JSON.stringify({width,height,referenceMs,foldedMs,ratio:report.ratio}));
  await page.screenshot({path:join(output,`${width}x${height}.png`)});await writeFile(join(output,'receipt.json'),JSON.stringify({scope:'same live scene; isolated bloom only; desktop, not physical iPhone',reports},null,2)+'\n');await page.close();
 }
}finally{await browser.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
