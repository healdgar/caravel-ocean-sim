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
// (js/continuum-scene.js draw: one drawIndirect a list, at the list's index times 16 bytes).
const LISTS=['clusters','small clusters','far body','splat'];
const instrument=()=>{
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap(),draws=(window.forestDraws=[]);window.forestCapture=false;
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  const original=pass.drawIndirect;pass.drawIndirect=function(b,o){if(window.forestCapture&&pipelines.get(this)==='forestContinuum view')draws.push({buffer:b,offset:o});return original.call(this,b,o);};
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

// Lisbon wears the Portugal pack. Near trees draw as clusters cut per tree by projected error, farther ones as their
// one far body, collapsing a half-edge at a time, and the farthest as 1-triangle splats: one continuum, and nothing
// else. The view stands under a chestnut in the open country outside the town, with planted trees near and far.
test('Lisbon\'s trees draw through the one cut, near to the horizon, and no map the compressed set replaces is fetched',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({view:'free',prow:0,cam:'-2165,60,-2548,40,4'});
  try{
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
  // Among the palms of the San Juan shore, looking inland.
  const {page,errors,requested}=await open({view:'free',prow:0,cam:'3274.9,8.4,-2425.1,40,12'},'san-juan');
  try{
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
