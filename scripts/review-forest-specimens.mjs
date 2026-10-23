#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Isolated production-native specimens. Only the diagnostic GPU culler changes;
// source geometry, maps, placement and all material/lighting shaders stay intact.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const output=resolve(process.env.FOREST_SPECIMEN_OUTPUT||'shots/forest-specimens');
const names=(process.env.FOREST_SPECIMEN_SPECIES||'oak,maple,birch,elm,chestnut').split(',');
const manifest=JSON.parse(await readFile(new URL('../assets/forest-scenery/saba/manifest.json',import.meta.url),'utf8'));
const rootsRaw=gunzipSync(await readFile(new URL('../assets/forest-scenery/saba/roots.bin.gz',import.meta.url)));
const roots=new Float32Array(rootsRaw.buffer,rootsRaw.byteOffset,rootsRaw.byteLength/4);
const original=await readFile(new URL('../js/forest-scenery.js',import.meta.url),'utf8');
await mkdir(output,{recursive:true});
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
const reports=[];
try{
 for(const name of names){
  const p=manifest.prototypes.find(p=>p.species===name);assert.ok(p,'known species');
  const id=p.firstRoot,r=Array.from(roots.subarray(id*12,id*12+12)),height=p.high[1]*r[3],camera=[r[0],r[1]+height*.55,r[2]+height*2.1,0,0];
  const page=await browser.newPage({viewport:{width:960,height:800}}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.log(JSON.stringify({species:name,pageError:e.message}));});page.on('console',m=>{if(/init failed|GPU error|Shader compile error/.test(m.text()))console.log(JSON.stringify({species:name,console:m.text()}));});
  await page.route('**/js/forest-scenery.js',route=>{
   const needle='if(id.x>=u32(parameters.x)){return;}';assert.equal(original.split(needle).length,2);
   return route.fulfill({status:200,contentType:'text/javascript',body:original.replace(needle,'if(id.x!='+id+'u||id.x>=u32(parameters.x)){return;}')});
  });
  await page.addInitScript(()=>{
   window.specimen={device:null,errors:[]};
   const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);specimen.device=d;d.addEventListener('uncapturederror',e=>specimen.errors.push(e.error.message));return d;};
  });
  const q=new URLSearchParams({landfall:'approach',view:'free',boat:'0',prow:'0',follower:'0',fleet:'',crew:'0',effects:'0',clouds:'0',sunElev:'40',sunAzim:'155',windSpeed:'0',swellHs:'0',ui:'0',resolution:'native',canopy:'near',forestMass:'off',forestImpostor:'off',cam:camera.join(','),w:'960',h:'800'});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?'+q);
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{timeout:30000}).catch(async error=>{console.log(JSON.stringify(await page.evaluate(()=>({startup:window.oceanStartup?.state,error:document.querySelector('#err')?.textContent,body:document.body.innerText.slice(0,900),gpu:specimen.errors}))));throw error;});
  assert.equal(await page.locator('#err').textContent(),'');
  await page.evaluate(async()=>{await specimen.device.queue.onSubmittedWorkDone();});
  const status=await page.evaluate(()=>({state:window.oceanStartup?.state,errors:specimen.errors}));
  assert.equal(status.state,'ready');assert.deepEqual([...errors,...status.errors],[]);
  const screenshot=join(output,name+'.png');await page.screenshot({path:screenshot});reports.push({species:name,root:id,originalPose:r,camera,screenshot,errors});
  console.log(JSON.stringify(reports.at(-1)));await page.close();
 }
 await writeFile(join(output,'receipt.json'),JSON.stringify({qualification:'Single production tree; diagnostic GPU root selection only. Not a whole-scene performance measurement.',reports},null,2)+'\n');
}finally{await browser.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
