import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL,landfallStageURL} from '../js/landfall.js';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

// What the forest's view of the one cut really drew, list by list, read back from its indirect arguments
// (js/continuum-scene.js draw: one drawIndirect a list, at the list's index times 16 bytes). The forest's own view
// pipeline draws its clusters and far bodies; its splats, once its octahedral cards are baked, are drawn as cards by
// the pipeline every carded family shares, from the forest's own lists.
const LISTS=['clusters','small clusters','far body','splat'];
const instrument=()=>{
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap(),draws=(window.forestDraws=[]);window.forestCapture=false;
  const views=new Set(['forestContinuum view','continuum card view']);
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  const original=pass.drawIndirect;pass.drawIndirect=function(b,o){if(window.forestCapture&&b.label==='forest continuum draws'&&views.has(pipelines.get(this)))draws.push({buffer:b,offset:o});return original.call(this,b,o);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.forestDevice=await request.apply(this,a);};
};
const drawn=page=>page.evaluate(async(lists)=>{
  forestDraws.length=0;forestCapture=true;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);forestCapture=false;
  const totals=Object.fromEntries(lists.map(name=>[name,0])),contents=new Map();
  for(const buffer of new Set(forestDraws.map(d=>d.buffer))){
    const read=forestDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=forestDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);forestDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    contents.set(buffer,new Uint32Array(read.getMappedRange().slice(0)));read.unmap();read.destroy();
  }
  for(const d of forestDraws){const words=contents.get(d.buffer),at=d.offset/4;totals[lists[d.offset/16]]+=words[at]*words[at+1]/3;}
  return totals;
},LISTS);
// The forest has no representation but the one continuum: the pack's own vertex and index streams, the bake source
// of its atlas, and the old per-family tiers are never fetched.
function continuumAlone(requested){
  assert.deepEqual(requested.filter(path=>/\/forest-scenery\/[a-z]+\/(vertices|indices)\.bin|\/forest-scenery\/[a-z]+\/(clusters|crowns|wind|lod|middle|mass|volumes|impostors)\/|canopy-shade/.test(path)),[],'the old forest\'s streams are never fetched');
}
async function open(query,region='lisbon'){
  // Saba is the surveyed home island, approached from the sea; the others are generated coasts, seen from the dock.
  const url=region==='saba'?landfallStageURL(base,'coast','clear'):coastalRegionStageURL(base,region,'dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',...query}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  // Any error fails, and so does any GPU validation the browser reports only as a warning (a dispatch or binding
  // past the device's limits, an invalid command buffer), so a coast that outgrows the device cannot pass unseen.
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{const text=m.text();if((m.type()==='error'&&!/404|favicon/.test(text))||(m.type()==='warning'&&/\[Invalid |validation|exceeds|GPU error|While (calling|validating|encoding)/.test(text)))errors.push(text);});
  const requested=[];page.on('request',r=>requested.push(new URL(r.url()).pathname));
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  for(let waited=0;waited<120000&&!requested.some(path=>path.includes('/continuum/atlas.bin'));waited+=500)await page.waitForTimeout(500);
  assert.ok(requested.some(path=>/\/forest-scenery\/[a-z]+\/continuum\/atlas\.bin/.test(path)),'the forest\'s atlas was never requested');
  await page.waitForTimeout(9000);
  return {page,errors,requested};
}
// Stands the free camera `range` metres from a planted tree in the open, on dry ground with nothing between, looking at
// its crown: found from the forest's own roots (forestTrunks.grids), so the view keeps up with the coast's planting.
const standNear=async(page,range)=>{
  await page.waitForFunction(()=>window.oceanFleet?.terrain?.forestTrunks?.trees>0,null,{timeout:120000,polling:200});
  const stood=await page.evaluate(range=>{
    const t=oceanFleet.terrain,grids=t.forestTrunks.grids,cam=oceanFleet.freeCam,trees=[];
    for(const grid of grids)for(let i=0;i<grid.trees;i++)trees.push(grid.roots.subarray(grid.rootOf[i]*12,grid.rootOf[i]*12+12));
    const cx=t.port?.center?.x??0,cz=t.port?.center?.z??0;
    trees.sort((a,b)=>Math.hypot(a[0]-cx,a[2]-cz)-Math.hypot(b[0]-cx,b[2]-cz));
    for(const [x,y,z,scale] of trees){
      if(!(scale>0)||t.groundSample(x,z)<1.5)continue;
      for(let a=0;a<16;a++){
        const angle=a/16*Math.PI*2,ex=x+Math.cos(angle)*range,ez=z+Math.sin(angle)*range,eyeY=Math.max(t.groundSample(ex,ez)+2.2,y+2.4);
        if(t.groundSample(ex,ez)<1)continue;
        let clear=true;
        for(let s=0.08;s<=0.92&&clear;s+=0.04)clear=t.groundSample(x+(ex-x)*s,z+(ez-z)*s)<=y+1.6+(eyeY-y-1.6)*s-0.3;
        for(const q of trees){if(!clear)break;if(q[0]===x&&q[2]===z)continue;const along=((q[0]-ex)*(x-ex)+(q[2]-ez)*(z-ez))/(range*range);if(along>=-0.05&&along<=1&&Math.hypot(q[0]-(ex+(x-ex)*along),q[2]-(ez+(z-ez)*along))<6)clear=false;}
        if(!clear)continue;
        const dx=x-ex,dz=z-ez;
        Object.assign(cam,{x:ex,y:eyeY,z:ez,yaw:Math.atan2(dx,-dz),pitch:Math.atan2(y+4*scale-eyeY,Math.hypot(dx,dz))});
        return {x,z,ex,ez};
      }
    }
    return null;
  },range);
  assert.ok(stood,'no planted tree stands in the open with a clear view of it');
  await page.waitForTimeout(4000);
  return stood;
};

// Lisbon wears the Portugal pack. Near trees draw as clusters cut per tree by projected error, farther ones as their
// one far body, collapsing a half-edge at a time, and the farthest as 1-triangle splats: one continuum, and nothing
// else. The view stands by a planted tree in the open country, with others near and far.
test('Lisbon\'s trees draw through the one cut, near to the horizon, and no map the compressed set replaces is fetched',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({view:'free',prow:0});
  try{
    await standNear(page,18);
    const totals=await drawn(page);
    assert.ok(totals.clusters+totals['small clusters']>1000,JSON.stringify(totals));
    assert.ok(totals['far body']+totals.splat>0,`far trees draw as their far body and splats: ${JSON.stringify(totals)}`);
    continuumAlone(requested);
    assert.ok(requested.some(path=>path.includes('/portugal/continuum/atlas.bin')),'Lisbon draws the Portugal pack\'s own atlas');
    assert.ok(requested.some(path=>/\/portugal\/surfaces\/family-\d+-albedo\.(bc7|astc)\.bin/.test(path)),'bark and leaves arrive block-compressed');
    assert.deepEqual(requested.filter(path=>path.includes('/forest-scenery/')&&path.endsWith('.png')),[],'the maps the compressed set replaces are never downloaded');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('the surveyed island\'s forest is the one continuum, not its old shells and mass',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({},'saba');
  try{
    const totals=await drawn(page);
    assert.ok(requested.some(path=>path.includes('/saba/continuum/atlas.bin')),'Saba loads its own atlas');
    assert.ok(totals['far body']+totals.splat>0,`far trees draw as their far body and splats: ${JSON.stringify(totals)}`);
    continuumAlone(requested);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('tropical coasts draw palms through the one cut, down to 1-triangle horizon splats',{timeout:360000},async()=>{
  // By a palm of the San Juan shore.
  const {page,errors,requested}=await open({view:'free',prow:0},'san-juan');
  try{
    await standNear(page,14);
    const totals=await drawn(page);
    assert.ok(totals.clusters+totals['small clusters']>0,JSON.stringify(totals));
    assert.ok(totals.splat>0,`distant trees collapse to 1-triangle splats: ${JSON.stringify(totals)}`);
    continuumAlone(requested);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('the forest bends in the wind, and hard wind moves it further',{timeout:360000},async()=>{
  const sample=async windSpeed=>{
    const {page,errors}=await open({windSpeed,weather:'clear',view:'free',prow:0,cam:'-2165,60,-2548,40,4'});
    try{
      const frames=[];
      for(let i=0;i<2;i++){frames.push(await page.screenshot({clip:{x:0,y:0,width:960,height:360}}));await page.waitForTimeout(900);}
      assert.deepEqual(errors,[]);
      return await page.evaluate(async([a,b])=>{
        const read=async b64=>{const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();const c=new OffscreenCanvas(img.width,img.height),x=c.getContext('2d');x.drawImage(img,0,0);return x.getImageData(0,0,img.width,img.height).data;};
        const [p,q]=await Promise.all([read(a),read(b)]);let changed=0;for(let i=0;i<p.length;i+=4)if(Math.abs(p[i]-q[i])+Math.abs(p[i+1]-q[i+1])+Math.abs(p[i+2]-q[i+2])>24)changed++;return changed;
      },frames.map(f=>f.toString('base64')));
    }finally{await page.close();}
  };
  const calm=await sample(.01),gale=await sample(16);
  assert.ok(gale>calm,`hard wind should change more of the picture: calm ${calm}, gale ${gale}`);
});
