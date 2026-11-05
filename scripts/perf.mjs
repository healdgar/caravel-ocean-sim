// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// One stressful scene, Lisbon with HMS Victory, showing where a frame's time goes on the CPU and on
// the GPU side by side. Compare rows within one run: other work on the machine moves every number.
//   npm run perf                                     the scene as it stands
//   npm run perf -- '[["no crew",{"crew":"0"}]]'     rows of [label, URL parameters]
//   rows may add source edits to try: [label, parameters, [["forest-clusters.js","find","replace"]]]
//   npm run perf -- --tris                           also count triangles per pipeline
//   npm run perf -- --uploads                        what the CPU sends the GPU each frame, by buffer
//   npm run perf -- --profile                        JavaScript time per function
//   npm run perf -- --textures                       live GPU texture memory by format, forest download
// PANEL=1 adds the game's own GPU pass spans. HEADED=1 shows the window. PERF_SHOTS=folder keeps a picture of each row.
import {once} from 'node:events';
import {execSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

const args=process.argv.slice(2),wantTriangles=args.includes('--tris'),wantUploads=args.includes('--uploads'),wantProfile=args.includes('--profile'),wantTextures=args.includes('--textures');
const rows=JSON.parse(args.find(a=>a.startsWith('['))??'[["base",{}]]');
const SAMPLE_SECONDS=6,SETTLE_MS=5000,CPU_LIMITED_MS=14,GPU_BUSY_PERCENT=85;
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}/`,tag=`perf${process.pid}`;
const browser=await chromium.launch({headless:!process.env.HEADED,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog',`--perf-tag=${tag}`]});
const mean=values=>values.reduce((sum,v)=>sum+v,0)/Math.max(1,values.length);

// The GPU's own counters, for the whole machine: device busy, fragment (renderer), vertex (tiler).
function gpuCounters(){
  try{
    const text=execSync('ioreg -r -d 1 -w 0 -c AGXAccelerator',{encoding:'utf8',maxBuffer:1<<24});
    const read=name=>Number(new RegExp(`"${name}"=(\\d+)`).exec(text)?.[1]??NaN);
    return {device:read('Device Utilization %'),renderer:read('Renderer Utilization %'),tiler:read('Tiler Utilization %'),splits:read('SplitSceneCount'),tiled:read('TiledSceneBytes')};
  }catch{return {device:NaN,renderer:NaN,tiler:NaN,splits:NaN,tiled:NaN};}
}
// CPU seconds so far for this browser's busiest renderer and its GPU process.
function cpuSeconds(){
  const table=execSync('ps -axo pid=,ppid=,time=,command=',{encoding:'utf8',maxBuffer:1<<26}).split('\n').map(line=>{
    const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);if(!m)return null;
    const t=m[3].split(':').map(Number);return {pid:+m[1],ppid:+m[2],seconds:t.length===3?t[0]*3600+t[1]*60+t[2]:t[0]*60+t[1],command:m[4]};
  }).filter(Boolean);
  const root=table.find(p=>p.command.includes(`--perf-tag=${tag}`)&&!p.command.includes('--type='));
  const family=new Set([root?.pid]);for(let depth=0;depth<3;depth++)for(const p of table)if(family.has(p.ppid))family.add(p.pid);
  const of=type=>Math.max(0,...table.filter(p=>family.has(p.pid)&&p.command.includes(`--type=${type}`)).map(p=>p.seconds));
  return {renderer:of('renderer'),gpu:of('gpu-process')};
}
function instrument(){
  const raf=window.requestAnimationFrame.bind(window),work=(window.perfWork=[]);
  window.requestAnimationFrame=callback=>raf(t=>{const start=performance.now();try{callback(t);}finally{work.push(performance.now()-start);if(work.length>2000)work.shift();}});
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap(),draws=(window.perfDraws=[]);window.perfCapture=false;
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'unlabelled');return setPipeline.call(this,p);};
  const draw=pass.draw;pass.draw=function(n,i=1,...r){if(window.perfCapture)draws.push({label:pipelines.get(this),count:n*i});return draw.call(this,n,i,...r);};
  const indexed=pass.drawIndexed;pass.drawIndexed=function(n,i=1,...r){if(window.perfCapture)draws.push({label:pipelines.get(this),count:n*i});return indexed.call(this,n,i,...r);};
  const indirect=pass.drawIndexedIndirect;pass.drawIndexedIndirect=function(b,o){if(window.perfCapture)draws.push({label:pipelines.get(this),buffer:b,offset:o});return indirect.call(this,b,o);};
  const plainIndirect=pass.drawIndirect;pass.drawIndirect=function(b,o){if(window.perfCapture)draws.push({label:pipelines.get(this),buffer:b,offset:o});return plainIndirect.call(this,b,o);};
  const createBuffer=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){return createBuffer.call(this,/indirect| draws/i.test(desc.label||'')?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.perfDevice=await request.apply(this,a);};
  performance.setResourceTimingBufferSize(4096);
  const textures=(window.perfTextures=new Map());
  const createTexture=GPUDevice.prototype.createTexture;GPUDevice.prototype.createTexture=function(desc){const texture=createTexture.call(this,desc);textures.set(texture,desc);return texture;};
  const destroyTexture=GPUTexture.prototype.destroy;GPUTexture.prototype.destroy=function(){textures.delete(this);return destroyTexture.call(this);};
  const uploads=(window.perfUploads=new Map());
  const writeBuffer=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset=0,size){
    const row=uploads.get(buffer.label||'unlabelled')??{bytes:0,calls:0};uploads.set(buffer.label||'unlabelled',row);
    const unit=ArrayBuffer.isView(data)?data.BYTES_PER_ELEMENT:1;row.bytes+=(size??((data.length??data.byteLength)-dataOffset))*unit;row.calls++;
    return size===undefined?writeBuffer.call(this,buffer,offset,data,dataOffset):writeBuffer.call(this,buffer,offset,data,dataOffset,size);
  };
}
// Everything drawn over two frames, reading indirect arguments back from the GPU.
const countTriangles=page=>page.evaluate(async()=>{
  perfDraws.length=0;perfCapture=true;
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);perfCapture=false;
  const device=perfDevice,contents=new Map();
  for(const buffer of new Set(perfDraws.filter(d=>d.buffer).map(d=>d.buffer))){
    const read=device.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    contents.set(buffer,new Uint32Array(read.getMappedRange().slice(0)));read.unmap();read.destroy();
  }
  const totals={};
  for(const d of perfDraws){
    const words=d.buffer&&contents.get(d.buffer),triangles=words?words[d.offset/4]*words[d.offset/4+1]/3:d.count/3;
    const row=totals[d.label]??={triangles:0,draws:0};row.triangles+=triangles/2;row.draws+=.5;
  }
  return totals;
});

// Bytes the textures still alive would occupy, by format, and what the forest's surfaces cost to fetch.
const textureMemory=page=>page.evaluate(()=>{
  const texel={r8unorm:1,r16float:2,r32float:4,rg8unorm:2,rg16float:4,rg32float:8,rgba8unorm:4,'rgba8unorm-srgb':4,bgra8unorm:4,'bgra8unorm-srgb':4,rgba16float:8,rgba32float:16,rgb10a2unorm:4,rg11b10ufloat:4,depth32float:4,depth24plus:4,'depth24plus-stencil8':4,'depth32float-stencil8':5};
  const bytes=d=>{
    const [w,h,depth]=Array.isArray(d.size)?[d.size[0],d.size[1]??1,d.size[2]??1]:[d.size.width,d.size.height??1,d.size.depthOrArrayLayers??1],compressed=/^(bc7|astc-4x4)/.test(d.format);
    let total=0;for(let level=0;level<(d.mipLevelCount??1);level++){
      const across=Math.max(1,w>>level),down=Math.max(1,h>>level),layers=d.dimension==='3d'?Math.max(1,depth>>level):depth;
      total+=(compressed?Math.ceil(across/4)*Math.ceil(down/4)*16:across*down*(texel[d.format]??NaN))*layers*(d.sampleCount??1);
    }
    return total;
  };
  const byFormat={},forest={};let total=0,unknown=[];
  for(const d of perfTextures.values()){
    const b=bytes(d);if(!Number.isFinite(b)){unknown.push(d.format);continue;}
    total+=b;byFormat[d.format]=(byFormat[d.format]??0)+b;
    if(/forest (immutable )?native/.test(d.label||''))forest[d.format]=(forest[d.format]??0)+b;
  }
  const fetched=performance.getEntriesByType('resource').filter(e=>/forest-scenery\//.test(e.name)),sum=test=>fetched.filter(e=>test.test(e.name)).reduce((s,e)=>s+e.encodedBodySize,0);
  return{total,byFormat,forest,unknown:[...new Set(unknown)],sources:[...perfTextures.values()].filter(d=>/forest native source/.test(d.label||'')).length,
    maps:sum(/\.png/),blocks:sum(/surfaces\/.*\.gz/),allForest:fetched.reduce((s,e)=>s+e.encodedBodySize,0)};
});

const idle=[];for(let i=0;i<4;i++){idle.push(gpuCounters().device);await new Promise(resolve=>setTimeout(resolve,250));}
console.log(`GPU busy before loading: ${mean(idle).toFixed(0)}% (other work on this machine)`);
console.log('scene'.padEnd(20),'frame p50/p95   fps  | JS ms mean/p95 | CPU cores main+gpu | GPU busy frag vert | limit');
for(const [label,extra,edits] of rows){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [key,value] of Object.entries({ship:'victory',w:1728,h:1117,polygons:'fixed',...extra}))url.searchParams.set(key,String(value));
  const page=await browser.newPage({viewport:{width:1728,height:1117}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  const byFile=new Map();for(const [file,find,replace] of edits??[])byFile.set(file,[...(byFile.get(file)??[]),[find,replace]]);
  for(const [file,changes] of byFile)await page.route('**/js/'+file,async route=>{const response=await route.fetch();let text=await response.text();for(const [find,replace] of changes){if(!text.includes(find))console.log('EDIT NOT FOUND',find);text=text.split(find).join(replace);}route.fulfill({response,body:text});});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  if(process.env.PANEL)await page.evaluate(()=>document.getElementById('performance-toggle')?.click());
  await page.waitForTimeout(SETTLE_MS);
  const session=wantProfile?await page.context().newCDPSession(page):null;
  if(session){await session.send('Profiler.enable');await session.send('Profiler.setSamplingInterval',{interval:500});await session.send('Profiler.start');}
  await page.evaluate(()=>perfUploads.clear());
  const cpuBefore=cpuSeconds(),samples=[],sampling=setInterval(()=>samples.push(gpuCounters()),400);
  const result=await page.evaluate(seconds=>new Promise(resolve=>{
    perfWork.length=0;const frames=[];let last=performance.now();const start=last;
    const tick=t=>{frames.push(t-last);last=t;if(t-start<seconds*1000){requestAnimationFrame(tick);return;}
      frames.shift();frames.sort((a,b)=>a-b);const work=[...perfWork].sort((a,b)=>a-b);
      resolve({fps:frames.length/seconds,p50:frames[frames.length>>1],p95:frames[Math.floor(frames.length*.95)],jsMean:work.reduce((s,v)=>s+v,0)/Math.max(1,work.length),jsP95:work[Math.floor(work.length*.95)],stages:window.oceanFrameStages?.()??{}});};
    requestAnimationFrame(tick);}),SAMPLE_SECONDS);
  clearInterval(sampling);
  const cpuAfter=cpuSeconds(),main=(cpuAfter.renderer-cpuBefore.renderer)/SAMPLE_SECONDS,gpuProcess=(cpuAfter.gpu-cpuBefore.gpu)/SAMPLE_SECONDS;
  const g={device:mean(samples.map(s=>s.device)),renderer:mean(samples.map(s=>s.renderer)),tiler:mean(samples.map(s=>s.tiler)),splits:(samples.at(-1).splits-samples[0].splits)/SAMPLE_SECONDS,tiledMB:Math.max(...samples.map(s=>s.tiled))/1048576};
  const stagesTotal=Object.values(result.stages).reduce((sum,v)=>sum+v,0);
  const limit=stagesTotal>CPU_LIMITED_MS?'CPU':g.device>GPU_BUSY_PERCENT?(g.tiler>g.renderer?'GPU vertex':'GPU fragment'):result.p50>17.5?'pacing':'none';
  console.log(label.padEnd(20),`${result.p50.toFixed(0).padStart(5)}/${result.p95.toFixed(0).padEnd(4)} ${result.fps.toFixed(1).padStart(6)}  | ${result.jsMean.toFixed(1).padStart(5)}/${result.jsP95.toFixed(1).padEnd(6)}   | ${main.toFixed(2).padStart(6)} + ${gpuProcess.toFixed(2).padEnd(6)}    | ${g.device.toFixed(0).padStart(4)}% ${g.renderer.toFixed(0).padStart(3)}% ${g.tiler.toFixed(0).padStart(3)}% | ${limit} · tiled ${g.tiledMB.toFixed(0)} MB · splits/s ${g.splits.toFixed(0)}`,errors.length?`ERROR ${errors[0].slice(0,120)}`:'');
  console.log(' '.repeat(20),`main thread ${stagesTotal.toFixed(1)} ms:`,Object.entries(result.stages).filter(([,ms])=>ms>=.05).sort((a,b)=>b[1]-a[1]).map(([name,ms])=>`${name} ${ms.toFixed(1)}`).join(' · '));
  if(process.env.PANEL){
    const text=await page.evaluate(()=>document.getElementById('gpu-profile')?.textContent??document.querySelector('[id*=profile]')?.textContent??'');
    console.log(' '.repeat(20),text.split('\n').filter(line=>/ ms$/.test(line)&&!/ 0\.00 ms/.test(line)).map(line=>line.replace(/\s+/g,' ').replace('GPU pass timing','')).join(' | '));
  }
  if(wantUploads){
    const frames=result.fps*SAMPLE_SECONDS,uploads=await page.evaluate(()=>[...perfUploads].map(([label,row])=>[label,row.bytes,row.calls]));
    const total=uploads.reduce((sum,[,bytes])=>sum+bytes,0)/frames/1024;
    console.log(' '.repeat(20),`${total.toFixed(0)} KB uploaded per frame:`);
    for(const [name,bytes,calls] of uploads.sort((a,b)=>b[1]-a[1]).slice(0,16))console.log(' '.repeat(20),`${(bytes/frames/1024).toFixed(1).padStart(8)} KB ${(calls/frames).toFixed(1).padStart(6)} writes  ${name}`);
  }
  if(session){
    const {profile}=await session.send('Profiler.stop'),nodes=new Map(profile.nodes.map(n=>[n.id,n])),self=new Map();
    profile.samples.forEach((id,i)=>{const f=nodes.get(id).callFrame;if(/^\((idle|root)\)$/.test(f.functionName))return;const key=`${f.functionName||'(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber+1}`;self.set(key,(self.get(key)??0)+(profile.timeDeltas[i]??0));});
    const frames=result.fps*SAMPLE_SECONDS;
    console.log(' '.repeat(20),'JavaScript per frame, by function:');
    for(const [name,micros] of [...self].sort((a,b)=>b[1]-a[1]).slice(0,18))console.log(' '.repeat(20),`${(micros/1000/frames).toFixed(2).padStart(6)} ms  ${name}`);
  }
  if(process.env.PERF_SHOTS)await page.screenshot({path:`${process.env.PERF_SHOTS}/${label.replace(/\W+/g,'-')}.png`});
  if(wantTextures){
    const t=await textureMemory(page),mib=v=>(v/1048576).toFixed(1).padStart(7);
    console.log(' '.repeat(20),`${mib(t.total)} MiB in live textures · forest surfaces ${mib(Object.values(t.forest).reduce((s,v)=>s+v,0))} MiB (${Object.entries(t.forest).map(([f,v])=>f+' '+mib(v)).join(', ')}) · source copies alive ${t.sources}`);
    console.log(' '.repeat(20),'by format:',Object.entries(t.byFormat).sort((a,b)=>b[1]-a[1]).map(([f,v])=>`${f} ${(v/1048576).toFixed(1)}`).join(' · '),t.unknown.length?`· unsized: ${t.unknown}`:'');
    console.log(' '.repeat(20),`forest fetched: maps ${mib(t.maps)} MiB · blocks ${mib(t.blocks)} MiB · everything under forest-scenery ${mib(t.allForest)} MiB`);
  }
  if(wantTriangles){
    const totals=Object.entries(await countTriangles(page)).sort((a,b)=>b[1].triangles-a[1].triangles);
    console.log(' '.repeat(20),`${(totals.reduce((sum,[,r])=>sum+r.triangles,0)/1e6).toFixed(1)} M triangles per frame:`);
    for(const [name,row] of totals)if(row.triangles>=5000)console.log(' '.repeat(20),`${(row.triangles/1e6).toFixed(2).padStart(6)} M ${String(row.draws).padStart(4)} draws  ${name}`);
  }
  await page.close();
}
await browser.close();server.closeAllConnections?.();server.close();process.exit(0);
