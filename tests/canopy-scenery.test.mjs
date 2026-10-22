// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Independent byte/layout, conservative visibility and pixel-budget fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {CANOPY_SCENERY_ASSETS,CANOPY_VERTEX_LAYOUT,validateCanopyScenery,decodeCanopyScenery,loadCanopyScenery,
  canopyCoversPoint,excludeCanopyRoots,canopyProjectedError,selectCanopyPatches,canopyInspectionURL} from '../js/canopy-scenery.js';

const canopyTestHash=raw=>createHash('sha256').update(new Uint8Array(raw)).digest('hex');
function canopyTestFixture(){
  const stream=kind=>new Float32Array([[-1,-1,-10],[1,-1,-10],[0,1,-10]].flatMap((p,i)=>[...p,0,0,1,kind,.5,...[[0,0],[1,0],[0,1]][i],.18,.30,.07])).buffer;
  const streams={'near.bin':stream(3),'leaf.bin':stream(4),'far.bin':stream(4)},files={};
  for(const [name,raw]of Object.entries(streams))files[name]={bytes:raw.byteLength,sha256:canopyTestHash(raw),vertexCount:3,triangleCount:1};
  const manifest={format:'waterworld.canopy-runtime',version:1,units:'metres',upAxis:'Y',vertexLayout:{strideFloats:13,strideBytes:52,attributes:['x','y','z','nx','ny','nz','kind','shade','u','v','linearR','linearG','linearB']},
    coverage:{kind:'rectangle',boundsXZ:[-40,40,-40,40]},files,stems:[{index:0,genome:'retained-source',yaw_rad:.7}],
    textureAlphaErrorMetres:null,textureAlphaErrorSupported:false,
    patches:[{id:'0:0',low:[-1,-1,-10],high:[1,1,-10],centre:[0,0,-10],radius:Math.sqrt(2)+1e-5,
      near:{firstVertex:0,vertexCount:3},leaf:{firstVertex:0,vertexCount:3},far:{firstVertex:0,vertexCount:3},geometryErrorSupported:true,geometryErrorMetres:1}]};
  return {manifest,streams};
}
function canopyTestAtDepth(manifest,depth,x=0){
  const result=structuredClone(manifest),p=result.patches[0];p.low=p.low.map((v,i)=>v+(i===2?10-depth:i===0?x:0));p.high=p.high.map((v,i)=>v+(i===2?10-depth:i===0?x:0));p.centre=[x,0,-depth];return result;
}
const canopyTestCamera={x:0,y:0,z:0,forward:[0,0,-1],screenHeight:600,tanHalfFovY:Math.tan(Math.PI/6)};
function canopyTestPixelCamera(patch,error,pixels){
  // Independent on-axis perspective bound: focalPixels * e * offAxis / (near-e).
  const depth=-patch.centre[2],near=depth-patch.radius,magnification=Math.sqrt(1+(patch.radius/near)**2),tan=Math.tan(Math.PI/6);
  return {...canopyTestCamera,tanHalfFovY:tan,screenHeight:pixels*2*tan*(near-error)/(error*magnification)};
}

test('runtime keeps baked world coordinates, source UVs and already-linear colours byte-for-byte',()=>{
  const {manifest,streams}=canopyTestFixture(),before=structuredClone({manifest,streams}),pack=decodeCanopyScenery(manifest,streams);
  assert.equal(CANOPY_VERTEX_LAYOUT.arrayStride,52);
  assert.deepEqual(CANOPY_VERTEX_LAYOUT.attributes.map(a=>[a.shaderLocation,a.offset]),[[0,0],[1,12],[2,24],[5,32],[6,40]]);
  for(const name of ['near','leaf','far'])assert.deepEqual(new Uint8Array(pack[name].buffer),new Uint8Array(before.streams[name+'.bin']),'decoder neither reapplies instance transforms nor gamma-converts material factors');
  assert.deepEqual(manifest,before.manifest);assert.deepEqual(streams,before.streams);
  assert.equal(pack.near[10],Math.fround(.18));assert.equal(pack.near[11],Math.fround(.30));
  assert.ok(Object.values(CANOPY_SCENERY_ASSETS).every(path=>path.startsWith('assets/canopy-scenery/')),'pack resources remain project-local');
});

test('malformed manifests, overlapping/omitted ranges, bad vertices and incomplete bounds are rejected',()=>{
  const edits=[m=>m.version=2,m=>m.upAxis='Z',m=>m.vertexLayout.strideBytes=40,m=>m.vertexLayout.attributes[0]='z',m=>m.patches=[],m=>m.coverage.boundsXZ[1]=m.coverage.boundsXZ[0],
    m=>m.files['near.bin'].bytes--,m=>m.files['near.bin'].sha256='unverified',m=>m.patches[0].near.firstVertex=1,
    m=>m.patches[0].near.vertexCount=6,m=>m.patches[0].near.vertexCount=0,m=>m.patches.push(structuredClone(m.patches[0])),
    m=>m.patches[0].radius=.1,m=>m.patches[0].high[0]=-2,m=>m.patches[0].centre[1]=NaN,
    m=>m.patches[0].geometryErrorMetres=-1,m=>{m.textureAlphaErrorSupported=true;m.textureAlphaErrorMetres=null;},
    m=>{const p=structuredClone(m.patches[0]);p.id='other';m.patches.push(p);}];
  for(const edit of edits){const {manifest}=canopyTestFixture();edit(manifest);assert.throws(()=>validateCanopyScenery(manifest));}
  for(const [offset,value]of [[0,NaN],[3,0],[7,2],[10,-.1],[0,30]]){
    const {manifest,streams}=canopyTestFixture(),data=new Float32Array(streams['near.bin']);if(offset===3)data.fill(0,3,6);else data[offset]=value;
    assert.throws(()=>decodeCanopyScenery(manifest,streams),'finite unit direction, exposure, colour and complete culling support are required');
  }
  for(const [name,kind]of [['near.bin',4],['leaf.bin',3],['far.bin',2]]){const {manifest,streams}=canopyTestFixture();new Float32Array(streams[name])[6]=kind;assert.throws(()=>decodeCanopyScenery(manifest,streams),'native opaque/cutout material kinds cannot be silently reclassified');}
  const {manifest,streams}=canopyTestFixture();streams['near.bin']=streams['near.bin'].slice(4);assert.throws(()=>decodeCanopyScenery(manifest,streams));
});

test('optional loader verifies actual binary digests and rejects missing/corrupted assets',async()=>{
  const {manifest,streams}=canopyTestFixture(),assets=Object.fromEntries(['manifest.json',...Object.keys(streams)].map(name=>[name,name])),requests=[];
  const fetchAsset=async name=>{requests.push(name);return name==='manifest.json'?Response.json(manifest):new Response(streams[name]);};
  const loaded=await loadCanopyScenery({fetchAsset,assets});assert.equal(loaded.near.length,39);assert.equal(requests[0],'manifest.json');assert.equal(new Set(requests).size,4);
  const corrupt=streams['near.bin'].slice(0);new Uint8Array(corrupt)[100]^=1;
  await assert.rejects(loadCanopyScenery({assets,fetchAsset:async name=>name==='near.bin'?new Response(corrupt):fetchAsset(name)}),/digest|receipt/i,'correct byte length alone cannot certify a source stream');
  await assert.rejects(loadCanopyScenery({assets,fetchAsset:async name=>name==='leaf.bin'?new Response(null,{status:404}):fetchAsset(name)}),/unavailable|404/i);
});

test('only procedural roots in the imported coverage rectangle are suppressed, preserving outside bytes',()=>{
  const {manifest}=canopyTestFixture(),inside=[0,9,0,2,6,.5,.1,.2],boundary=[40,10,-40,3,8,.1,.4,.5],outside=[40.001,77,0,4,13,.8,.7,.9],outside2=[0,-5,-40.001,8,7,.2,.3,.4];
  const trees=new Float32Array([...inside,...outside,...boundary,...outside2]),original=trees.slice(),filtered=excludeCanopyRoots(trees,manifest);
  assert.equal(canopyCoversPoint(manifest,-40,40),true);assert.equal(canopyCoversPoint(manifest,40.001,0),false);
  assert.deepEqual(filtered,new Float32Array([...outside,...outside2]));assert.deepEqual(trees,original);
  assert.throws(()=>excludeCanopyRoots(new Float32Array(7),manifest));
});

test('projected geometric error follows rendered pixels, field of view, off-axis depth and near-plane safety',()=>{
  const {manifest}=canopyTestFixture(),patch=canopyTestAtDepth(manifest,1000).patches[0],camera=canopyTestCamera,e=canopyProjectedError(1,patch,camera);
  assert.ok(e>0&&Number.isFinite(e));assert.ok(Math.abs(canopyProjectedError(1,patch,{...camera,screenHeight:1200})/e-2)<1e-12);
  assert.ok(Math.abs(canopyProjectedError(1,patch,{...camera,tanHalfFovY:camera.tanHalfFovY/2})/e-2)<1e-12);
  assert.equal(canopyProjectedError(1,patch,{...camera,forward:[0,0,-3]}),e,'forward normalization cannot change screen error');
  assert.ok(canopyProjectedError(1,patch,{...camera,x:-1000})>e,'edge-of-view perspective magnification is not treated as radial distance');
  for(const bad of [{...camera,screenHeight:0},{...camera,tanHalfFovY:NaN},{...camera,forward:[0,0,0]}])assert.equal(canopyProjectedError(1,patch,bad),Infinity);
  const crossing={...patch,centre:[0,0,-1]};assert.equal(canopyProjectedError(1,crossing,camera),Infinity);
});

test('auto detail requires alpha proof or sub-three-pixel whole support; hysteresis never exceeds three pixels',()=>{
  const {manifest}=canopyTestFixture(),m=canopyTestAtDepth(manifest,1000),p=m.patches[0],past=new Map();
  let camera=canopyTestPixelCamera(p,1,2.5),selected=selectCanopyPatches(m,camera)[0];
  assert.ok(selected.geometryPixels<3&&selected.supportPixels>3);assert.equal(selected.tier,'near','geometry/texel metadata cannot masquerade as unsupported alpha appearance proof');
  m.patches[0].leafAlphaTexelMetres=0;assert.equal(selectCanopyPatches(m,camera)[0].tier,'near','a base-texel world footprint is not alpha/silhouette reconstruction error');
  m.textureAlphaErrorSupported=true;m.textureAlphaErrorMetres=1;
  camera=canopyTestPixelCamera(p,1,2.8);assert.equal(selectCanopyPatches(m,camera,null,'auto',past)[0].tier,'near');
  camera=canopyTestPixelCamera(p,1,2.5);assert.equal(selectCanopyPatches(m,camera,null,'auto',past)[0].tier,'far');
  camera=canopyTestPixelCamera(p,1,2.8);assert.equal(selectCanopyPatches(m,camera,null,'auto',past)[0].tier,'far','hysteresis retains a still-qualified representation');
  camera=canopyTestPixelCamera(p,1,3.01);assert.equal(selectCanopyPatches(m,camera,null,'auto',past)[0].tier,'near','the three-pixel limit is never relaxed by hysteresis');
  m.textureAlphaErrorSupported=false;m.textureAlphaErrorMetres=null;camera=canopyTestPixelCamera(p,p.radius*2,2.5);
  selected=selectCanopyPatches(m,camera)[0];assert.equal(selected.tier,'far');assert.equal(selected.reason,'collapsed-support');assert.ok(selected.supportPixels<=3);
  selected=selectCanopyPatches(m,{...camera,screenHeight:camera.screenHeight*2})[0];assert.equal(selected.tier,'near','more real pixels restore distinguishable source geometry');
  const debug=selectCanopyPatches(m,canopyTestCamera,null,'far')[0];assert.equal(debug.tier,'far');assert.equal(debug.reason,'uncertified-debug');
  assert.equal(selectCanopyPatches(m,camera,null,'near')[0].tier,'near');assert.throws(()=>selectCanopyPatches(m,camera,null,'invented'));
});

test('actual camera-relative projection culls only completely disjoint patches and inspection changes no ship coordinates',()=>{
  const {manifest}=canopyTestFixture(),matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,0,-1,0,0,.05,0]);
  assert.equal(selectCanopyPatches(canopyTestAtDepth(manifest,100),canopyTestCamera,matrix).length,1);
  assert.equal(selectCanopyPatches(canopyTestAtDepth(manifest,-100),canopyTestCamera,matrix).length,0);
  assert.equal(selectCanopyPatches(canopyTestAtDepth(manifest,100,2000),canopyTestCamera,matrix).length,0);
  assert.equal(selectCanopyPatches(canopyTestAtDepth(manifest,100,2000),canopyTestCamera).length,1,'missing projection does not guess a captain view');
  const href='https://example.test/game/?ship=victory&x=27&z=-60&heading=118&windSpeed=12&follower=1',url=new URL(canopyInspectionURL(href,manifest)),original=new URL(href);
  for(const key of ['ship','x','z','heading','windSpeed','follower'])assert.equal(url.searchParams.get(key),original.searchParams.get(key));
  assert.equal(url.searchParams.get('canopy'),'near');assert.equal(url.searchParams.get('view'),'free');assert.equal(url.searchParams.get('landfall'),'approach');
  assert.equal(url.searchParams.get('cam').split(',').map(Number).every(Number.isFinite),true);
  const coastHref='https://example.test/game/?landfall=coast&ship=victory&boatHeading=112&weather=clear&fleet=nina,pinta',coast=new URL(canopyInspectionURL(coastHref,manifest)),coastBefore=new URL(coastHref);
  for(const key of ['landfall','ship','boatHeading','weather','fleet'])assert.equal(coast.searchParams.get(key),coastBefore.searchParams.get(key));
  for(const key of ['boatX','boatZ','x','z'])assert.equal(coast.searchParams.has(key),false,'inspection preserves implicit coast spawn rather than inventing explicit ship coordinates');
  assert.equal(coast.searchParams.get('view'),'free');assert.equal(coast.searchParams.get('canopy'),'near');assert.equal(coast.searchParams.get('boat'),'0');
  assert.equal(coast.searchParams.get('cam').split(',').map(Number).every(Number.isFinite),true);
  const explicit=new URL(canopyInspectionURL(coastHref+'&boatX=-1750&boatZ=-7000',manifest));
  assert.equal(explicit.searchParams.get('landfall'),'coast');assert.equal(explicit.searchParams.get('boatX'),'-1750');assert.equal(explicit.searchParams.get('boatZ'),'-7000');
  assert.equal(explicit.searchParams.get('fleet'),'nina,pinta');assert.equal(explicit.searchParams.get('boat'),'0');
});
