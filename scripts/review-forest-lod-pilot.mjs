#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Root-only native WebGPU review; never imported by game startup.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {cpus,platform,arch,release} from 'node:os';
const root=dirname(dirname(fileURLToPath(import.meta.url))),o={};
for(let i=2;i<process.argv.length;i+=2){const key={'--pilot':'pilot','--wood':'wood','--inspection':'inspection','--out':'out','--width':'width','--height':'height','--port':'port','--serve':'serve','--stand':'stand','--layers':'layers','--grid':'grid','--shading':'shading','--samples':'samples','--warmup':'warmup','--compaction':'compaction','--leaves':'leaves','--ribbon-error':'ribbonError','--ribbons':'ribbons'}[process.argv[i]];if(!key||!process.argv[i+1])throw Error('Usage: --pilot PACK --wood PACK --out FRESH [--inspection PACK --stand edge|dense --grid 0|2|4|8 --width 1024 --height 900]');o[key]=process.argv[i+1];}
if(!o.pilot||!o.wood||!o.out)throw Error('Pilot, woody pack and fresh output required');
const directories={pilot:resolve(o.pilot),wood:resolve(o.wood),source:join(root,'assets/forest-scenery/saba')},width=Number(o.width||1024),height=Number(o.height||900),output=resolve(o.out);
if(o.inspection)directories.inspection=resolve(o.inspection);
if(o.ribbons){directories.ribbons=resolve(o.ribbons);o.leaves??='authored';}
await mkdir(output);const manifests=Object.fromEntries(await Promise.all(Object.entries(directories).map(async([key,dir])=>[key,JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'))])));
const allowed=new Map();
for(const [key,dir]of Object.entries(directories)){
 allowed.set('/'+key+'/manifest.json',join(dir,'manifest.json'));
 if(key==='pilot')for(const p of manifests[key].prototypes)for(const t of p.tiers)for(const page of t.pages)for(const mip of page.mips)for(const item of Object.values(mip.outputs))allowed.set('/'+key+'/'+item.gzip.file,join(dir,item.gzip.file));
 else if(key==='ribbons'){for(const p of manifests[key].prototypes)allowed.set('/ribbons/'+p.indices.gzip.file,join(dir,p.indices.gzip.file));}
 else if(key==='inspection'){for(const p of manifests[key].prototypes){for(const item of [p.hierarchy.leafOrder,...p.pages.flatMap(p=>Object.values(p.files))])allowed.set('/'+key+'/'+item.gzip.file,join(dir,item.gzip.file));}}
 else for(const [file,item]of Object.entries(manifests[key].files)){const name=item.gzip?.file??file;allowed.set('/'+key+'/'+name,join(dir,name));}
 if(key==='source'){allowed.set('/source/canopy-shade.json',join(dir,'canopy-shade.json'));allowed.set('/source/canopy-shade.bin.gz',join(dir,'canopy-shade.bin.gz'));}
}
for(const name of ['forest-lod-pilot.js','forest-lod-native-reference.js','forest-lod-inspection.js','forest-leaf-ribbons.js','forest-ribbon-assets.js'])allowed.set('/js/'+name,join(root,'js',name));
const hash=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}),snapshot=new Map(),inputs={code:{},manifests:{}};
for(const [url,path]of allowed)if(url.startsWith('/js/')||url.endsWith('/manifest.json')){const bytes=await readFile(path);snapshot.set(url,bytes);(url.startsWith('/js/')?inputs.code:inputs.manifests)[url]=hash(bytes);}
snapshot.set('/',await readFile(join(root,'tests/fixtures/forest-lod-pilot.html')));inputs.code['/']=hash(snapshot.get('/'));
const server=createServer(async(req,res)=>{
 try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}const path=u.pathname==='/'?join(root,'tests/fixtures/forest-lod-pilot.html'):allowed.get(u.pathname);if(!path){res.writeHead(404);res.end();return;}
  const bytes=snapshot.get(u.pathname)??await readFile(path);res.writeHead(200,{'content-type':path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':'application/octet-stream','cache-control':'no-store','content-length':bytes.length});res.end(bytes);
 }catch(error){res.writeHead(500);res.end(error.message);}
});server.listen(Number(o.port||0),'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const url=base+'/?w='+width+'&h='+height+(o.inspection?'&inspection=1':'')+(o.stand?'&stand='+encodeURIComponent(o.stand):'')+(o.layers?'&layers='+o.layers:'')+(o.grid?'&grid='+o.grid:'')+(o.shading?'&shading='+o.shading:'')+(o.compaction?'&compaction='+o.compaction:'')+(o.leaves?'&leaves='+o.leaves:'')+(o.ribbonError?'&ribbonError='+o.ribbonError:'');console.log(url);
if(o.serve==='1'){await new Promise(()=>{});}
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
 const page=await browser.newPage({viewport:{width:Math.min(2560,width*2),height:height+200}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log(m.text());});
 await page.goto(url);await page.waitForFunction(()=>['ready','failed'].includes(window.forestPilot?.state),undefined,{timeout:180000});
 const state=await page.evaluate(()=>({state:forestPilot.state,errors:forestPilot.errors,adapter:forestPilot.adapter}));if(state.state!=='ready')throw Error(JSON.stringify(state));state.browser=browser.version();state.host={platform:platform(),architecture:arch(),osRelease:release(),cpu:cpus()[0]?.model??null};state.createdAtUTC=new Date().toISOString();
 await page.addStyleTag({content:'.views span{display:none}.views>div{width:'+width+'px;flex-shrink:0}'});
 const sampleCount=Number(o.samples??60),warmup=Number(o.warmup??20);
 if(!Number.isSafeInteger(sampleCount)||sampleCount<10||sampleCount>600||!Number.isSafeInteger(warmup)||warmup<2||warmup>120)throw Error('Invalid timing sample/warmup count');
 const results=[];
 const cases=process.env.FOREST_PILOT_CASES?JSON.parse(process.env.FOREST_PILOT_CASES):[
  {name:'oak-near',prototypeID:0,distance:45,yaw:35,elevation:15,detail:1},
  {name:'oak-middle',prototypeID:0,distance:140,yaw:35,elevation:15,detail:0},
  {name:'oak-aerial',prototypeID:0,distance:80,yaw:115,elevation:60,detail:-1},
  {name:'birch-near',prototypeID:2,distance:25,yaw:35,elevation:15,detail:1},
  {name:'birch-middle',prototypeID:2,distance:85,yaw:75,elevation:15,detail:0},
 ];
 for(const supplied of cases){
  const c={nativeOnly:false,nativeOriginalWood:false,parallax:true,refinePixels:64,sun:[.7,.7,.2,1.25],...supplied};
  await page.evaluate(c=>forestPilot.render({...c,distance:2800,detail:-1,candidateOnly:true,display:0,refinePixels:c.refinePixels??64}),c);
  const timings=[];for(let i=0;i<warmup+sampleCount;i++){const r=await page.evaluate(c=>forestPilot.render({...c,display:0,candidateOnly:true}),c);if(i>=warmup&&r.gpuMs!==null)timings.push(r.gpuMs);}
  await page.evaluate(c=>forestPilot.render({...c,display:0,candidateOnly:false}),c);const receipt=await page.evaluate(()=>forestPilot.receipt);await page.locator('#reference').screenshot({path:join(output,c.name+'-reference.png')});await page.locator('#candidate').screenshot({path:join(output,c.name+'-candidate.png')});
  await page.evaluate(c=>forestPilot.render({...c,display:1}),c);await page.locator('#reference').screenshot({path:join(output,c.name+'-reference-mask.png')});await page.locator('#candidate').screenshot({path:join(output,c.name+'-candidate-mask.png')});
  timings.sort((a,b)=>a-b);receipt.gpuMsMedian=timings[Math.floor(timings.length/2)]??null;receipt.gpuMsP95=timings[Math.ceil(timings.length*.95)-1]??null;receipt.gpuMsMaximum=timings.at(-1)??null;receipt.timingWarmupFrames=warmup;receipt.timingSamples=timings;receipt.name=c.name;results.push(receipt);await writeFile(join(output,'receipt.json'),JSON.stringify({state,inputs,results,errors},null,2)+'\n');console.log(JSON.stringify({name:c.name,leafTriangles:receipt.leafTriangles,gpuMsP95:receipt.gpuMsP95}));
 }
 if(errors.length)throw Error(errors.join('\n'));await page.evaluate(()=>forestPilot.close());
}finally{await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
