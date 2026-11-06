#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// One tree of each species at set distances, through each way of storing its surfaces. Everything else
// stays still, so the difference between two columns is the surfaces.
//   node scripts/review-forest-surfaces.mjs OUTPUT '[["fallback",{"forestSurfaces":"png"}],["bc7",{"forestSurfaces":"bc7"}]]'
// A row may add [["file.js","find","replace"]] edits, and a folder of baked surfaces to use instead.
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const output=resolve(process.argv[2]??'shots/forest-surfaces');
const rows=JSON.parse(process.argv[3]??'[["fallback",{"forestSurfaces":"png"}],["bc7",{"forestSurfaces":"bc7"}],["astc",{"forestSurfaces":"astc"}]]');
const SPECIES=(process.env.SURFACE_SPECIES||'oak,birch').split(','),DISTANCES=(process.env.SURFACE_DISTANCES||'10,30,90').split(',').map(Number);
const WIDTH=Number(process.env.SURFACE_WIDTH||1728),HEIGHT=Number(process.env.SURFACE_HEIGHT||1117);
const manifest=JSON.parse(await readFile(new URL('../assets/forest-scenery/saba/manifest.json',import.meta.url),'utf8'));
const rawRoots=gunzipSync(await readFile(new URL('../assets/forest-scenery/saba/roots.bin.gz',import.meta.url)));
const roots=new Float32Array(rawRoots.buffer,rawRoots.byteOffset,rawRoots.byteLength/4);
await mkdir(output,{recursive:true});
// SURFACE_SHIFT also takes each view a little to the side, to measure how much leaves shimmer in motion.
const SHIFT=Number(process.env.SURFACE_SHIFT||0);

// Trees standing well above their neighbours' ground, so the view back from them is open.
const specimens=SPECIES.map(name=>{
  const p=manifest.prototypes.find(q=>q.species===name);
  let best=p.firstRoot;for(let i=p.firstRoot;i<p.firstRoot+p.rootCount;i++)if(roots[i*12+1]>roots[best*12+1]&&roots[i*12+3]>.9)best=i;
  const r=Array.from(roots.subarray(best*12,best*12+12));
  return{name,root:best,x:r[0],y:r[1],z:r[2],scale:r[3],height:p.high[1]*r[3],crown:p.crownRadius*r[3]};
});
const trees=specimens.map(s=>s.root);
const pick=trees.map(id=>`tree!=${id}u`).join('&&');
const isolate=[
  ['forest-clusters.js','let tree=forestClusterTree(id.x);if(tree==0xffffffffu){return;}',`let tree=forestClusterTree(id.x);if(tree==0xffffffffu||(${pick})){return;}`],
  ['forest-scenery.js','if(id.x>=u32(parameters.x)){return;}',`if((${trees.map(id=>`id.x!=${id}u`).join('&&')})||id.x>=u32(parameters.x)){return;}`],
  ['main.js','const cam = {','const cam = window.surfaceCamera = {'],
];
// SURFACE_SCENE=far looks over the whole forest with every level of detail on, for the far canopy.
const FAR=process.env.SURFACE_SCENE==='far',lead=specimens[0];
const views=FAR?[[300,70,-8],[800,160,-10],[2000,400,-11]].map(([back,up,pitch])=>({name:`forest-${back}m`,cam:[lead.x,lead.y+up,lead.z+back,0,pitch]})):specimens.flatMap(s=>DISTANCES.flatMap(distance=>[
  {name:`${s.name}-bark-${distance}m`,cam:[s.x,s.y+1.7,s.z+distance+.5*s.scale,0,Math.atan2(1.3,distance)*180/Math.PI]},
  {name:`${s.name}-leaves-${distance}m`,cam:[s.x,s.y+s.height*.55,s.z+s.crown+distance,0,0]},
]));

const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
const report={width:WIDTH,height:HEIGHT,specimens,rows:{}};
try{
  for(const [label,extra={},edits=[],surfaces=null] of rows){
    const page=await browser.newPage({viewport:{width:WIDTH,height:HEIGHT}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
    const byFile=new Map();for(const [file,find,replace] of [...(FAR?isolate.slice(-1):isolate),...edits])byFile.set(file,[...(byFile.get(file)??[]),[find,replace]]);
    for(const [file,changes] of byFile)await page.route('**/js/'+file,async route=>{const response=await route.fetch();let text=await response.text();for(const [find,replace] of changes){if(!text.includes(find))throw Error('Edit not found: '+find);text=text.split(find).join(replace);}route.fulfill({response,body:text});});
    if(surfaces)await page.route('**/assets/forest-scenery/saba/surfaces/**',route=>route.fulfill({path:join(resolve(surfaces),new URL(route.request().url()).pathname.split('/').pop())}));
    await page.addInitScript(()=>{
      window.surfaceTextures=[];const create=GPUDevice.prototype.createTexture;
      GPUDevice.prototype.createTexture=function(desc){if(/forest immutable native/.test(desc.label||''))surfaceTextures.push({label:desc.label,format:desc.format});return create.call(this,desc);};
    });
    const q=new URLSearchParams({landfall:'approach',view:'free',boat:'0',prow:'0',follower:'0',fleet:'',crew:'0',effects:'0',clouds:'0',sunElev:'40',sunAzim:'155',windSpeed:'0',swellHs:'0',ui:'0',resolution:'native',polygons:'fixed',...(FAR?{}:{canopy:'near',forestMass:'off',forestImpostor:'off'}),cam:views[0].cam.join(','),w:String(WIDTH),h:String(HEIGHT),...extra});
    await page.goto(`http://127.0.0.1:${server.address().port}/?${q}`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
    await page.waitForFunction(()=>surfaceTextures.length>=2,null,{timeout:180000,polling:200}).catch(()=>errors.push('native surfaces never loaded'));
    await page.waitForTimeout(4000);
    for(const view of views){
      await page.evaluate(([x,y,z,yaw,pitch])=>Object.assign(surfaceCamera,{x,y,z,yaw:yaw*Math.PI/180,pitch:pitch*Math.PI/180}),view.cam);
      await page.waitForTimeout(FAR?4000:1500);
      await page.screenshot({path:join(output,`${label}.${view.name}.png`)});
      if(SHIFT){
        await page.evaluate(step=>{surfaceCamera.x+=step;},SHIFT);await page.waitForTimeout(400);
        await page.screenshot({path:join(output,`${label}.${view.name}-shift.png`)});
      }
    }
    report.rows[label]={errors,formats:await page.evaluate(()=>[...new Set(surfaceTextures.map(t=>t.format))])};
    console.log(label,JSON.stringify(report.rows[label]));
    await page.close();
  }
  report.views=views.map(v=>v.name);
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
}finally{await browser.close();server.closeAllConnections?.();server.close();}
process.exit(0);
