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

// What each forest pipeline really drew, read back from its indirect arguments.
const instrument=()=>{
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap(),draws=(window.forestDraws=[]);window.forestCapture=false;
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  for(const name of ['drawIndirect','drawIndexedIndirect']){const original=pass[name];pass[name]=function(b,o){if(window.forestCapture)draws.push({label:pipelines.get(this),buffer:b,offset:o});return original.call(this,b,o);};}
  const createBuffer=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(d){return createBuffer.call(this,/indirect| draws/i.test(d.label||'')?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.forestDevice=await request.apply(this,a);};
};
const drawn=page=>page.evaluate(async()=>{
  forestDraws.length=0;forestCapture=true;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);forestCapture=false;
  const totals={__instances:{}},contents=new Map();
  for(const buffer of new Set(forestDraws.map(d=>d.buffer))){
    const read=forestDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=forestDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);forestDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    contents.set(buffer,new Uint32Array(read.getMappedRange().slice(0)));read.unmap();read.destroy();
  }
  for(const d of forestDraws){const words=contents.get(d.buffer),inst=words[d.offset/4+1]/2,n=words[d.offset/4]*inst/3;totals[d.label]=(totals[d.label]??0)+n;totals.__instances[d.label]=(totals.__instances[d.label]??0)+inst;}
  return totals;
});
// The forest has no representation but its continuum: no pipeline of the old native ladder draws, and the
// pack's own vertex and index streams, the bake source of its clusters and crowns, are never fetched.
function continuumAlone(totals,requested){
  assert.deepEqual(Object.keys(totals).filter(label=>label.startsWith('instanced forest')),[],JSON.stringify(totals));
  assert.deepEqual(requested.filter(path=>/\/forest-scenery\/[a-z]+\/(vertices|indices)\.bin|\/forest-scenery\/saba\/(lod|middle|mass|volumes|impostors)\/|canopy-shade/.test(path)),[],'the native ladder\'s streams are never fetched');
}
async function open(query,region='lisbon'){
  // Saba is the surveyed home island, approached from the sea; the others are generated coasts, seen from the dock.
  const url=region==='saba'?landfallStageURL(base,'coast','clear'):coastalRegionStageURL(base,region,'dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',...query}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  const requested=[];page.on('request',r=>requested.push(new URL(r.url()).pathname));
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  for(let waited=0;waited<120000&&!requested.some(path=>path.includes('/clusters/vertices.bin'));waited+=500)await page.waitForTimeout(500);
  assert.ok(requested.some(path=>path.includes('/clusters/vertices.bin')),'clusters were never requested');
  await page.waitForTimeout(9000);
  return {page,errors,requested};
}

// Lisbon wears the Portugal pack since 224cd17. Near trees draw as per-tree cluster cuts and farther trees
// decimate smoothly through their geomorphing crowns down to a 1-triangle horizon splat: one continuum, and
// nothing else. The view is over the wooded ground above the town, where planted trees stand near and far;
// the quay itself is the city's now, and has none.
test('Lisbon\'s trees draw as clusters near and hybrid continuum crowns to the horizon, and no map the compressed set replaces is fetched',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({view:'free',prow:0,cam:'5,70,-5760,0,-14'});
  try{
    const totals=await drawn(page);
    assert.ok(totals['forest clusters forestNativeOpaqueFS']>1000,JSON.stringify(totals));
    assert.ok(totals['forest clusters forestNativeLeafFS']>1000,JSON.stringify(totals));
    assert.equal(totals['forest clusters forestNativeLeafDepthFS'],totals['forest clusters forestNativeLeafFS'],'every leaf lays depth and then shades');
    assert.ok((totals['forest crowns forestCrownFS']??0)>0,`far trees draw through hybrid continuum crowns: ${JSON.stringify(totals)}`);
    continuumAlone(totals,requested);
    assert.ok(requested.some(path=>path.includes('/portugal/clusters/vertices.bin')),'Lisbon draws the Portugal pack\'s own clusters');
    assert.ok(requested.some(path=>path.includes('/portugal/crowns/morph.bin')),'Lisbon loads 3D geomorph targets for continuum crowns');
    assert.ok(requested.some(path=>/\/portugal\/surfaces\/family-\d+-albedo\.(bc7|astc)\.bin/.test(path)),'bark and leaves arrive block-compressed');
    assert.deepEqual(requested.filter(path=>path.includes('/forest-scenery/')&&path.endsWith('.png')),[],'the maps the compressed set replaces are never downloaded');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

// Far trees are one opaque surface each, not layers of leaf cards: on every pack that draws leaves as
// cards, from the same place with far crowns and without.
for(const [region,pack,query] of [['lisbon','portugal',{view:'free',prow:0,cam:'5,70,-5760,0,-14'}],['san-juan','subtropical',{view:'free',prow:0,cam:'3274.9,8.4,-2425.1,40,12'}]]){
  test(`far trees of the ${pack} pack draw through the opaque crown path`,{timeout:480000},async()=>{
    const read=async extra=>{
      const {page,errors,requested}=await open({...query,paused:1,...extra},region);
      try{return {totals:await drawn(page),errors,requested};}finally{await page.close();}
    };
    const crowned=await read({}),cards=await read({forestCrowns:0});
    const solid=crowned.totals['forest crowns forestCrownFS']??0,fading=crowned.totals['forest crowns forestCrownFadeFS']??0;
    const solidTrees=crowned.totals.__instances['forest crowns forestCrownFS']??0,fadingTrees=crowned.totals.__instances['forest crowns forestCrownFadeFS']??0;
    assert.ok(crowned.requested.some(path=>path.includes(`/${pack}/crowns/vertices.bin`)),'the pack\'s crowns were never requested');
    assert.ok(solid>0,`far trees draw as opaque crowns: ${JSON.stringify(crowned.totals)}`);
    assert.ok(fadingTrees<solidTrees,`only the trees at the change wear crown and leaves together (${fadingTrees} fading vs ${solidTrees} solid trees): ${JSON.stringify(crowned.totals)}`);
    // A tree in its crown draws no cluster, so both kinds fall, and every leaf still lays depth before it shades.
    for(const label of ['forest clusters forestNativeLeafFS','forest clusters forestNativeOpaqueFS'])assert.ok(crowned.totals[label]<cards.totals[label],`${label}: ${crowned.totals[label]} with crowns, ${cards.totals[label]} without`);
    assert.equal(crowned.totals['forest clusters forestNativeLeafDepthFS'],crowned.totals['forest clusters forestNativeLeafFS']);
    assert.ok(solid+fading<cards.totals['forest clusters forestNativeLeafFS']*2-crowned.totals['forest clusters forestNativeLeafFS']*2,'crowns draw fewer triangles than the leaf layers they replace');
    // Far trees cast into the land shadow map exactly as they did: the shadow cut never asks about crowns.
    for(const label of ['forest clusters forestClusterLeafShadowVS','forest clusters forestClusterWoodShadowVS'])assert.equal(crowned.totals[label]??0,cards.totals[label]??0,label);
    for(const label of ['forest crowns forestCrownFS','forest crowns forestCrownFadeFS'])assert.equal(cards.totals[label]??0,0,`${label} draws with crowns switched off`);
    // With crowns switched off the leaves draw as far as they go: there is no other far model to fall back on.
    continuumAlone(crowned.totals,crowned.requested);continuumAlone(cards.totals,cards.requested);
    assert.deepEqual(crowned.errors,[]);assert.deepEqual(cards.errors,[]);
  });
}

test('the surveyed island\'s far canopy is the one continuum\'s crowns, not its old shells and mass',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({},'saba');
  try{
    const totals=await drawn(page);
    // Saba's far trees take the continuum every pack takes (AGENTS.md rule 3): clusters near, its own baked crowns far.
    assert.ok(requested.some(path=>path.includes('/saba/crowns/morph.bin')),'Saba loads its own continuum crowns');
    assert.ok((totals['forest crowns forestCrownFS']??0)>0,`far trees draw through continuum crowns: ${JSON.stringify(totals)}`);
    // The per-family far tiers the crowns replaced are retired; their packs stay on disk and must not be fetched.
    for(const tier of ['/saba/mass/','/saba/middle/','/saba/volumes/','/saba/impostors/','/saba/lod/'])assert.ok(!requested.some(path=>path.includes(tier)),`Saba fetched its old far tier ${tier}`);
    assert.ok(totals['forest clusters forestNativeLeafFS']>0,`near trees draw as clusters: ${JSON.stringify(totals)}`);
    continuumAlone(totals,requested);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('tropical coasts draw palms as clusters near and continuum crowns far, down to 1-triangle horizon splats',{timeout:360000},async()=>{
  // Among the palms of the San Juan shore, looking inland.
  const {page,errors,requested}=await open({view:'free',prow:0,cam:'3274.9,8.4,-2425.1,40,12'},'san-juan');
  try{
    const totals=await drawn(page);
    assert.ok(totals['forest clusters forestNativeLeafFS']>0,JSON.stringify(totals));
    assert.ok((totals['forest crowns forestCrownFS']??0)>0,`far tropical trees draw through continuum crowns: ${JSON.stringify(totals)}`);
    continuumAlone(totals,requested);
    // Verify both progressive continuum triangles (firstVertex === 0) and 1-triangle horizon splats (firstIndex > 0) are actively drawn.
    const crownRegions=await page.evaluate(async()=>{
      forestDraws.length=0;forestCapture=true;await new Promise(requestAnimationFrame);forestCapture=false;
      const crownDraws=forestDraws.filter(d=>d.label==='forest crowns forestCrownFS');
      if(!crownDraws.length)return {continuumTris:0,splatTrees:0};
      const buf=crownDraws[0].buffer;
      const read=forestDevice.createBuffer({size:buf.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=forestDevice.createCommandEncoder();
      enc.copyBufferToBuffer(buf,0,read,0,buf.size);forestDevice.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
      const words=new Uint32Array(read.getMappedRange().slice(0));read.unmap();read.destroy();
      let continuumTris=0,splatTrees=0;
      for(const d of crownDraws){const at=d.offset/4;if(words[at]===3){if(words[at+2]>0)splatTrees+=words[at+1];else continuumTris+=words[at+1];}}
      return {continuumTris,splatTrees};
    });
    assert.ok(crownRegions.continuumTris>0,`mid-to-far trees decimate through progressive continuum triangles: ${JSON.stringify(crownRegions)}`);
    assert.ok(crownRegions.splatTrees>0,`distant horizon trees collapse to 1-triangle splats: ${JSON.stringify(crownRegions)}`);
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
