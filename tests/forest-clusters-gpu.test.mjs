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
  browser=await chromium.launch({args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
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
  const totals={},contents=new Map();
  for(const buffer of new Set(forestDraws.map(d=>d.buffer))){
    const read=forestDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=forestDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);forestDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    contents.set(buffer,new Uint32Array(read.getMappedRange().slice(0)));read.unmap();read.destroy();
  }
  for(const d of forestDraws){const words=contents.get(d.buffer),n=words[d.offset/4]*words[d.offset/4+1]/3/2;totals[d.label]=(totals[d.label]??0)+n;}
  return totals;
});
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

// Lisbon wears the Portugal pack since 224cd17. That pack has no crown shells: beyond its far crowns
// (js/forest-crowns.js) its farthest trees are small models from the native streams, drawn by the native
// wood pipeline, as the tropical pack's are.
// The dock faces a city now, not a wood: its trees stand round the square, in walled gardens and back
// yards, and in the country behind, so the view is taken from over the square, looking inland.
test('Lisbon\'s trees draw as clusters, far ones keep their small models, and no map the compressed set replaces is fetched',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({view:'free',prow:0,cam:'-70,45,-6250,0,-12'});
  try{
    const totals=await drawn(page);
    assert.ok(totals['forest clusters forestNativeOpaqueFS']>1000,JSON.stringify(totals));
    assert.ok(totals['forest clusters forestNativeLeafFS']>1000,JSON.stringify(totals));
    assert.equal(totals['forest clusters forestNativeLeafDepthFS'],totals['forest clusters forestNativeLeafFS'],'every leaf lays depth and then shades');
    assert.ok((totals['instanced forest forestNativeOpaqueFS']??0)>0,`far trees still draw their small models: ${JSON.stringify(totals)}`);
    assert.ok(totals['instanced forest forestNativeOpaqueFS']<totals['forest clusters forestNativeOpaqueFS'],'the native pipeline draws far models only, a small part of the wood');
    for(const label of ['forestNativeLeafFS','forestNativeLeafDepthFS'])assert.equal(totals[`instanced forest ${label}`]??0,0,`${label} must not draw beside clusters`);
    assert.ok(requested.some(path=>path.includes('/portugal/clusters/vertices.bin')),'Lisbon draws the Portugal pack\'s own clusters');
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
    assert.ok(crowned.requested.some(path=>path.includes(`/${pack}/crowns/vertices.bin`)),'the pack\'s crowns were never requested');
    assert.ok(solid>0,`far trees draw as opaque crowns: ${JSON.stringify(crowned.totals)}`);
    assert.ok(fading<solid,`only the trees at the change wear crown and leaves together: ${JSON.stringify(crowned.totals)}`);
    // A tree in its crown draws no cluster, so both kinds fall, and every leaf still lays depth before it shades.
    for(const label of ['forest clusters forestNativeLeafFS','forest clusters forestNativeOpaqueFS'])assert.ok(crowned.totals[label]<cards.totals[label],`${label}: ${crowned.totals[label]} with crowns, ${cards.totals[label]} without`);
    assert.equal(crowned.totals['forest clusters forestNativeLeafDepthFS'],crowned.totals['forest clusters forestNativeLeafFS']);
    assert.ok(solid+fading<cards.totals['forest clusters forestNativeLeafFS']*2-crowned.totals['forest clusters forestNativeLeafFS']*2,'crowns draw fewer triangles than the leaf layers they replace');
    // Far trees cast into the land shadow map exactly as they did: the shadow cut never asks about crowns.
    for(const label of ['forest clusters forestClusterLeafShadowVS','forest clusters forestClusterWoodShadowVS'])assert.equal(crowned.totals[label]??0,cards.totals[label]??0,label);
    for(const label of ['forest crowns forestCrownFS','forest crowns forestCrownFadeFS'])assert.equal(cards.totals[label]??0,0,`${label} draws with crowns switched off`);
    assert.deepEqual(crowned.errors,[]);assert.deepEqual(cards.errors,[]);
  });
}

test('the surveyed island keeps crown shells on its far canopy',{timeout:360000},async()=>{
  const {page,errors,requested}=await open({},'saba');
  try{
    const totals=await drawn(page);
    assert.ok(totals['instanced forest shaded native crown shell']>0,`the far canopy keeps its look: ${JSON.stringify(totals)}`);
    // Its far canopy is opaque already, so it is given no far crowns.
    assert.ok(!requested.some(path=>path.includes('/crowns/')),'Saba asked for far crowns');
    for(const label of ['forest crowns forestCrownFS','forest crowns forestCrownFadeFS'])assert.equal(totals[label]??0,0,label);
    for(const label of ['forestNativeOpaqueFS','forestNativeLeafFS','forestNativeLeafDepthFS'])assert.equal(totals[`instanced forest ${label}`]??0,0,`${label} must not draw beside clusters`);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('tropical coasts draw palms as clusters, with far models still present',{timeout:360000},async()=>{
  // Among the palms of the San Juan shore, looking inland.
  const {page,errors}=await open({view:'free',prow:0,cam:'3274.9,8.4,-2425.1,40,12'},'san-juan');
  try{
    const totals=await drawn(page);
    assert.ok(totals['forest clusters forestNativeLeafFS']>0,JSON.stringify(totals));
    assert.ok((totals['instanced forest forestNativeOpaqueFS']??0)>0,`far tropical trees still draw their small models: ${JSON.stringify(totals)}`);
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
