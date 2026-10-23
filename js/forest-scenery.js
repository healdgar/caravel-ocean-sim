// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Grown temperate specimens are authored visual proxies, not surveyed Saba flora.
import {FRAME_WGSL} from './wgsl/common.js';
import {loadForestImpostors,createForestImpostorResources,FOREST_IMPOSTOR_WGSL} from './forest-impostor.js';

export const FOREST_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/saba/manifest.json',
  'vertices.bin':'assets/forest-scenery/saba/vertices.bin.gz',
  'indices.bin':'assets/forest-scenery/saba/indices.bin.gz',
  'roots.bin':'assets/forest-scenery/saba/roots.bin.gz',
  'leaf-oak-0-albedo.png':'assets/forest-scenery/saba/leaf-oak-0-albedo.png',
  'leaf-oak-0-normal.png':'assets/forest-scenery/saba/leaf-oak-0-normal.png',
  'leaf-oak-1-albedo.png':'assets/forest-scenery/saba/leaf-oak-1-albedo.png',
  'leaf-oak-1-normal.png':'assets/forest-scenery/saba/leaf-oak-1-normal.png',
  'leaf-oak-2-albedo.png':'assets/forest-scenery/saba/leaf-oak-2-albedo.png',
  'leaf-oak-2-normal.png':'assets/forest-scenery/saba/leaf-oak-2-normal.png',
  'leaf-maple-0-albedo.png':'assets/forest-scenery/saba/leaf-maple-0-albedo.png',
  'leaf-maple-0-normal.png':'assets/forest-scenery/saba/leaf-maple-0-normal.png',
  'leaf-maple-1-albedo.png':'assets/forest-scenery/saba/leaf-maple-1-albedo.png',
  'leaf-maple-1-normal.png':'assets/forest-scenery/saba/leaf-maple-1-normal.png',
  'leaf-maple-2-albedo.png':'assets/forest-scenery/saba/leaf-maple-2-albedo.png',
  'leaf-maple-2-normal.png':'assets/forest-scenery/saba/leaf-maple-2-normal.png',
  'leaf-birch-0-albedo.png':'assets/forest-scenery/saba/leaf-birch-0-albedo.png',
  'leaf-birch-0-normal.png':'assets/forest-scenery/saba/leaf-birch-0-normal.png',
  'leaf-birch-1-albedo.png':'assets/forest-scenery/saba/leaf-birch-1-albedo.png',
  'leaf-birch-1-normal.png':'assets/forest-scenery/saba/leaf-birch-1-normal.png',
  'leaf-birch-2-albedo.png':'assets/forest-scenery/saba/leaf-birch-2-albedo.png',
  'leaf-birch-2-normal.png':'assets/forest-scenery/saba/leaf-birch-2-normal.png',
  'leaf-elm-0-albedo.png':'assets/forest-scenery/saba/leaf-elm-0-albedo.png',
  'leaf-elm-0-normal.png':'assets/forest-scenery/saba/leaf-elm-0-normal.png',
  'leaf-elm-1-albedo.png':'assets/forest-scenery/saba/leaf-elm-1-albedo.png',
  'leaf-elm-1-normal.png':'assets/forest-scenery/saba/leaf-elm-1-normal.png',
  'leaf-elm-2-albedo.png':'assets/forest-scenery/saba/leaf-elm-2-albedo.png',
  'leaf-elm-2-normal.png':'assets/forest-scenery/saba/leaf-elm-2-normal.png',
  'leaf-chestnut-0-albedo.png':'assets/forest-scenery/saba/leaf-chestnut-0-albedo.png',
  'leaf-chestnut-0-normal.png':'assets/forest-scenery/saba/leaf-chestnut-0-normal.png',
  'leaf-chestnut-1-albedo.png':'assets/forest-scenery/saba/leaf-chestnut-1-albedo.png',
  'leaf-chestnut-1-normal.png':'assets/forest-scenery/saba/leaf-chestnut-1-normal.png',
  'leaf-chestnut-2-albedo.png':'assets/forest-scenery/saba/leaf-chestnut-2-albedo.png',
  'leaf-chestnut-2-normal.png':'assets/forest-scenery/saba/leaf-chestnut-2-normal.png',
  'oak-bark-albedo.png':'assets/forest-scenery/saba/oak-bark-albedo.png',
  'oak-bark-normal.png':'assets/forest-scenery/saba/oak-bark-normal.png',
  'oak-bark-roughness.png':'assets/forest-scenery/saba/oak-bark-roughness.png',
  'oak-wounds-albedo.png':'assets/forest-scenery/saba/oak-wounds-albedo.png',
  'oak-wounds-normal.png':'assets/forest-scenery/saba/oak-wounds-normal.png',
  'oak-wounds-roughness.png':'assets/forest-scenery/saba/oak-wounds-roughness.png',
  'maple-bark-albedo.png':'assets/forest-scenery/saba/maple-bark-albedo.png',
  'maple-bark-normal.png':'assets/forest-scenery/saba/maple-bark-normal.png',
  'maple-bark-roughness.png':'assets/forest-scenery/saba/maple-bark-roughness.png',
  'maple-wounds-albedo.png':'assets/forest-scenery/saba/maple-wounds-albedo.png',
  'maple-wounds-normal.png':'assets/forest-scenery/saba/maple-wounds-normal.png',
  'maple-wounds-roughness.png':'assets/forest-scenery/saba/maple-wounds-roughness.png',
  'birch-bark-albedo.png':'assets/forest-scenery/saba/birch-bark-albedo.png',
  'birch-bark-normal.png':'assets/forest-scenery/saba/birch-bark-normal.png',
  'birch-bark-roughness.png':'assets/forest-scenery/saba/birch-bark-roughness.png',
  'birch-wounds-albedo.png':'assets/forest-scenery/saba/birch-wounds-albedo.png',
  'birch-wounds-normal.png':'assets/forest-scenery/saba/birch-wounds-normal.png',
  'birch-wounds-roughness.png':'assets/forest-scenery/saba/birch-wounds-roughness.png',
  'elm-bark-albedo.png':'assets/forest-scenery/saba/elm-bark-albedo.png',
  'elm-bark-normal.png':'assets/forest-scenery/saba/elm-bark-normal.png',
  'elm-bark-roughness.png':'assets/forest-scenery/saba/elm-bark-roughness.png',
  'elm-wounds-albedo.png':'assets/forest-scenery/saba/elm-wounds-albedo.png',
  'elm-wounds-normal.png':'assets/forest-scenery/saba/elm-wounds-normal.png',
  'elm-wounds-roughness.png':'assets/forest-scenery/saba/elm-wounds-roughness.png',
  'chestnut-bark-albedo.png':'assets/forest-scenery/saba/chestnut-bark-albedo.png',
  'chestnut-bark-normal.png':'assets/forest-scenery/saba/chestnut-bark-normal.png',
  'chestnut-bark-roughness.png':'assets/forest-scenery/saba/chestnut-bark-roughness.png',
  'chestnut-wounds-albedo.png':'assets/forest-scenery/saba/chestnut-wounds-albedo.png',
  'chestnut-wounds-normal.png':'assets/forest-scenery/saba/chestnut-wounds-normal.png',
  'chestnut-wounds-roughness.png':'assets/forest-scenery/saba/chestnut-wounds-roughness.png',
});
export const FOREST_SPECIES=Object.freeze(['oak','maple','birch','elm','chestnut']);
export const FOREST_ROOT_FLOATS=12;
export const FOREST_VERTEX_LAYOUT=Object.freeze({arrayStride:56,attributes:[
  {shaderLocation:0,offset:0,format:'float32x3'},
  {shaderLocation:1,offset:12,format:'float32x3'},
  {shaderLocation:2,offset:24,format:'float32x2'},
  {shaderLocation:5,offset:32,format:'float32x2'},
  {shaderLocation:6,offset:40,format:'float32x3'},
  {shaderLocation:7,offset:52,format:'float32'},
]});
const finite=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const forestMapReceipt=(value,encoding)=>value&&/^[a-z0-9-]+\.png$/.test(value.file)&&uint(value.bytes)&&value.bytes>0&&value.bytes<=8*1024*1024&&/^[a-f0-9]{64}$/.test(value.sha256)&&value.encoding===encoding;
const forestSourceReceipt=value=>value&&typeof value.file==='string'&&value.file.length>0&&uint(value.bytes)&&value.bytes>0&&/^[a-f0-9]{64}$/.test(value.sha256);
const forestSameReceipt=(a,b)=>forestSourceReceipt(a)&&forestSourceReceipt(b)&&['file','bytes','sha256'].every(key=>a[key]===b[key]);
function validateForestGeometryError(p,manifest){
  if(p.geometryErrorSupported!==true)return;
  const certificate=p.geometryErrorSource,error=p.geometryErrorMetres;
  if(!Number.isFinite(error)||error<0||Math.fround(error)!==error||p.geometryErrorMethod!=='symmetric-fixed-opposing-vertex-triangle-bound-v1'||
    !forestSameReceipt(certificate?.nativeGLB,p.source?.native?.glb)||!forestSameReceipt(certificate?.farAsset,p.source?.directFar)||
    !forestSourceReceipt(certificate?.method)||certificate.method.file!=='scripts/prepare-canopy-scenery.py#conservative_error')throw Error('Invalid forest geometry error certificate');
  for(const name of ['vertices.bin','indices.bin']){
    const receipt=certificate.packedStreams?.[name],packed=manifest.files[name];
    if(receipt?.bytes!==packed.bytes||receipt.sha256!==packed.sha256)throw Error('Forest geometry certificate stream mismatch');
  }
  for(const key of ['wood','leaf','far']){
    const range=certificate.ranges?.[key],measured=certificate.measuredStreams?.[key];
    if(range?.firstIndex!==p[key].firstIndex||range.indexCount!==p[key].indexCount||measured?.strideFloats!==14||
      measured.vertexCount!==p[key].indexCount||measured.bytes!==measured.vertexCount*56||!/^[a-f0-9]{64}$/.test(measured.sha256))throw Error('Forest geometry certificate range mismatch');
  }
}
export function validateForestMaterials(prototypes){
  let count=0;const receipts=new Map();
  for(const p of prototypes){
    if(!Array.isArray(p.nativeMaterials)||!p.nativeMaterials.length||p.nativeMaterials.length>16)throw Error('Forest requires native materials');
    for(const material of p.nativeMaterials){
      if(!forestMapReceipt(material.albedo,'srgb')||!forestMapReceipt(material.normal,'linear')||
        (material.roughnessMap&&!forestMapReceipt(material.roughnessMap,'linear'))||
        (material.wrap!==undefined&&!['clamp','repeat'].includes(material.wrap))||
        (material.clearcoat!==undefined&&!(Number.isFinite(material.clearcoat)&&material.clearcoat>=0&&material.clearcoat<=1))||
        !['roughness','underside','transmission','opacityThreshold'].every(key=>Number.isFinite(material[key])&&material[key]>=0&&material[key]<=1)||
        !finite(material.undersideReference,3)||material.undersideReference.some(v=>v<0||v>1))throw Error('Invalid native forest material');
      for(const kind of ['albedo','normal','roughnessMap'].filter(key=>material[key])){
        const r=material[kind],identity=[r.bytes,r.sha256,r.encoding].join(':');
        if(receipts.has(r.file)&&receipts.get(r.file)!==identity)throw Error('Conflicting native forest surface receipt');receipts.set(r.file,identity);
      }
      count++;
    }
  }
  if(count>128)throw Error('Forest native material layer limit exceeded');
  return count;
}
export function validateForestScenery(m){
  if(m?.format!=='waterworld.forest-instances'||![1,2].includes(m.version)||m.units!=='metres'||m.upAxis!=='Y'||m.vertexStride!==(m.version===2?56:52)||m.rootStride!==48||
    !uint(m.rootCount)||!m.rootCount||m.rootCount>250000||!Array.isArray(m.prototypes)||!m.prototypes.length||m.prototypes.length>32)throw Error('Unsupported instanced forest');
  for(const [name,stride,count]of[['vertices.bin',m.vertexStride,'vertexCount'],['indices.bin',4,'indexCount'],['roots.bin',48,'rootCount']]){
    const f=m.files?.[name];if(!uint(f?.[count])||!f[count]||f.bytes!==f[count]*stride||f.bytes>512*1024*1024||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid forest stream receipt: '+name);
    if(f.gzip&&(!uint(f.gzip.bytes)||!f.gzip.bytes||f.gzip.bytes>192*1024*1024||!/^[a-f0-9]{64}$/.test(f.gzip.sha256)||f.gzip.file!==name+'.gz'))throw Error('Invalid encoded forest stream receipt: '+name);
  }
  if(m.files['roots.bin'].rootCount!==m.rootCount)throw Error('Forest root count mismatch');
  const c=m.coverage;
  if(c?.kind!=='occupied-cells'||!finite(c.originXZ,2)||!(c.cellMetres>0)||!finite(c.dimensions,2)||!c.dimensions.every(n=>uint(n)&&n>0)||
    !Array.isArray(c.cells)||new Set(c.cells).size!==c.cells.length||c.cells.some(n=>!uint(n)||n>=c.dimensions[0]*c.dimensions[1]))throw Error('Invalid forest occupied coverage');
  const native=m.version===2&&m.materialContract==='gene-surfaces-v3';
  if(m.version===2&&!native)throw Error('Current forest requires native material contract');
  if(m.materialContract&&!native)throw Error('Unsupported forest material contract');
  if(native)validateForestMaterials(m.prototypes);
  let nextIndex=0,nextRoot=0;
  for(const [i,p]of m.prototypes.entries()){
    if(p.id!==i||!FOREST_SPECIES.includes(p.species)||!finite(p.low,3)||!finite(p.high,3)||p.low.some((v,k)=>v>p.high[k])||
      !finite(p.centre,3)||!(p.radius>0)||!uint(p.firstRoot)||p.firstRoot!==nextRoot||!uint(p.rootCount))throw Error('Invalid forest prototype');
    for(let bits=0;bits<8;bits++)if(Math.hypot(...p.low.map((v,k)=>(bits&(1<<k)?p.high[k]:v)-p.centre[k]))>p.radius+1e-4)throw Error('Forest prototype bound misses geometry');
    for(const key of ['wood','leaf','far']){
      const r=p[key];if(!uint(r?.firstIndex)||r.firstIndex!==nextIndex||!uint(r.indexCount)||r.indexCount%3||r.firstIndex+r.indexCount>m.files['indices.bin'].indexCount)throw Error('Invalid forest index range');
      nextIndex+=r.indexCount;
    }
    if(!p.far.indexCount||!p.leaf.indexCount)throw Error('Forest requires detailed foliage and opaque far canopy');
    validateForestGeometryError(p,m);
    nextRoot+=p.rootCount;
  }
  if(nextIndex!==m.files['indices.bin'].indexCount||nextRoot!==m.rootCount)throw Error('Incomplete forest partitions');
  if(m.appearanceErrorSupported!==false)throw Error('Forest appearance LOD is not certified');
  return m;
}
function* forestRootChecks(manifest,roots){
  if(!(roots instanceof Float32Array)||roots.byteLength!==manifest.files['roots.bin'].bytes)throw Error('Incomplete forest roots');
  for(const p of manifest.prototypes)for(let i=p.firstRoot;i<p.firstRoot+p.rootCount;i++){
    const r=roots.subarray(i*12,i*12+12);
    if(!r.every(Number.isFinite)||r[3]<=0||r[3]>5||r[8]!==p.id||r[9]<0||r.subarray(5,8).some(v=>v<=0||v>2)||!forestCoversPoint(manifest,r[0],r[2]))throw Error('Invalid forest root transform');
    if((i&1023)===0)yield;
  }
}
function* forestGeometryChecks(manifest,streams){
  validateForestScenery(manifest);
  for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!(streams[name] instanceof ArrayBuffer)||streams[name].byteLength!==manifest.files[name].bytes)throw Error('Incomplete forest stream: '+name);
  const vertices=new Float32Array(streams['vertices.bin']),indices=new Uint32Array(streams['indices.bin']),roots=new Float32Array(streams['roots.bin']);
  const stride=manifest.vertexStride/4;
  for(let i=0;i<vertices.length;i+=stride){
    if(!vertices.subarray(i,i+stride).every(Number.isFinite)||Math.abs(Math.hypot(...vertices.subarray(i+3,i+6))-1)>.001||!uint(vertices[i+6])||vertices[i+6]<3||vertices[i+7]<0||vertices[i+7]>1||vertices.subarray(i+10,i+13).some(v=>v<0))throw Error('Invalid forest vertex');
    if(((i/stride)&1023)===0)yield;
  }
  for(const p of manifest.prototypes){
    for(const key of ['wood','leaf','far'])for(let j=p[key].firstIndex;j<p[key].firstIndex+p[key].indexCount;j++){
      const v=indices[j]*stride;if(v>=vertices.length)throw Error('Forest index outside stream');
      if((key==='wood'&&vertices[v+6]!==3)||(key==='far'&&![3,4].includes(vertices[v+6]))||
        (key==='leaf'&&(vertices[v+6]<4||vertices[v+6]>=4+(p.nativeMaterials?.length??1))))throw Error('Forest material range mismatch');
      for(let k=0;k<3;k++)if(vertices[v+k]<p.low[k]-.001||vertices[v+k]>p.high[k]+.001)throw Error('Forest vertex outside prototype bound');
      if(manifest.version===2){const material=vertices[v+13];if(key==='far'?material!==-1:!uint(material)||material>=p.nativeMaterials.length)throw Error('Forest native material index mismatch');}
      if(manifest.version===2&&(j-p[key].firstIndex)%3===0){
        const material=vertices[v+13];for(let corner=1;corner<3;corner++)if(vertices[indices[j+corner]*stride+13]!==material)throw Error('Forest triangle crosses native material groups');
      }
      if((j&4095)===0)yield;
    }
  }
  yield* forestRootChecks(manifest,roots);
  return {manifest,vertices,indices,roots};
}
export function decodeForestScenery(manifest,streams){
  const iterator=forestGeometryChecks(manifest,streams);let next;do{next=iterator.next();}while(!next.done);return next.value;
}
const forestLoadYield=()=>globalThis.scheduler?.yield?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0));
function forestLoadAbort(signal){if(signal?.aborted)throw signal.reason??new DOMException('Forest load aborted','AbortError');}
async function finishForestChecks(iterator,{yieldTask=forestLoadYield,signal}={}){
  for(;;){forestLoadAbort(signal);const next=iterator.next();if(next.done)return next.value;await yieldTask();}
}
export async function decodeForestSceneryAsync(manifest,streams,options){return finishForestChecks(forestGeometryChecks(manifest,streams),options);}
export async function loadForestScenery({fetchAsset=fetch,assets=FOREST_ASSETS,impostorAssets,loadAtlases=true}={}){
  const load=async(n,signal)=>{forestLoadAbort(signal);if(typeof assets[n]!=='string')throw Error('Unregistered forest asset: '+n);const r=await fetchAsset(assets[n],signal?{signal}:undefined);if(!r.ok)throw Error('Forest scenery unavailable ('+r.status+'): '+n);return r;};
  const manifest=validateForestScenery(await(await load('manifest.json')).json());
  if(!globalThis.crypto?.subtle)throw Error('Forest receipt verification requires Web Crypto');
  const digest=async raw=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
  const stream=async(name,signal)=>{
    const receipt=manifest.files[name];let raw=await(await load(name,signal)).arrayBuffer();
    if(receipt.gzip){
      if(raw.byteLength!==receipt.gzip.bytes||await digest(raw)!==receipt.gzip.sha256)throw Error('Forest encoded digest mismatch: '+name);
      if(typeof DecompressionStream!=='function')throw Error('Forest geometry requires gzip decoding');
      raw=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    forestLoadAbort(signal);if(raw.byteLength!==receipt.bytes||await digest(raw)!==receipt.sha256)throw Error('Forest digest mismatch: '+name);return raw;
  };
  // Old 42-tree stand packs use their separate loader. A regional production
  // forest must never silently borrow that stand's generic foliage image.
  if(manifest.version!==2||manifest.materialContract!=='gene-surfaces-v3')throw Error('Regional forest requires current native surfaces');
  validateForestMaterials(manifest.prototypes);
  const rootsPromise=stream('roots.bin'),atlasPromise=loadAtlases?loadForestImpostors({forest:manifest,fetchAsset,assets:impostorAssets}).then(impostors=>({impostors,impostorError:null})).catch(error=>({impostors:null,impostorError:error.message})):Promise.resolve({impostors:null,impostorError:null});
  const [rootBytes,atlas]=await Promise.all([rootsPromise,atlasPromise]),roots=new Float32Array(rootBytes);await finishForestChecks(forestRootChecks(manifest,roots));
  let nativePromise,nativeLoaded=false;
  const loadNative=({signal}={})=>nativePromise??=(async()=>{
    const textures={},pending=new Map();
    const materialPromise=Promise.all(manifest.prototypes.flatMap(p=>p.nativeMaterials.flatMap(material=>['albedo','normal','roughnessMap'].filter(kind=>material[kind]).map(async kind=>{
      const receipt=material[kind];if(pending.has(receipt.file))return pending.get(receipt.file);
      const request=(async()=>{
        const raw=await(await load(receipt.file,signal)).arrayBuffer();
        if(raw.byteLength!==receipt.bytes)throw Error('Incomplete forest surface: '+receipt.file);
        if(await digest(raw)!==receipt.sha256)throw Error('Forest surface digest mismatch: '+receipt.file);textures[receipt.file]=raw;
      })();pending.set(receipt.file,request);return request;
    }))));
    const [vertices,indices]=await Promise.all([stream('vertices.bin',signal),stream('indices.bin',signal),materialPromise]);
    const geometry=await decodeForestSceneryAsync(manifest,{'vertices.bin':vertices,'indices.bin':indices,'roots.bin':rootBytes},{signal});nativeLoaded=true;return{...geometry,textures};
  })();
  // Drop only our fulfilled cache reference after successful GPU installation.
  // Existing callers retain their immutable arrays; a later explicit native
  // load fetches and verifies fresh bytes. An in-flight load stays deduplicated.
  const releaseNativeCPU=()=>{if(!nativeLoaded)return false;nativePromise=undefined;nativeLoaded=false;return true;};
  // Only a complete full-sphere representation can display a forest without
  // native buffers. Upper-only legacy/missing atlases retain the eager path.
  const deferred=atlas.impostors?.manifest.layout.views.some(view=>view.direction[1]<0);
  return deferred?{manifest,roots,vertices:null,indices:null,textures:null,...atlas,loadNative,releaseNativeCPU}:
    {...await loadNative(),...atlas,loadNative,releaseNativeCPU};
}
const coverageSets=new WeakMap();
export function forestCoversPoint(manifest,x,z){
  const c=manifest.coverage,ix=Math.floor((x-c.originXZ[0])/c.cellMetres),iz=Math.floor((z-c.originXZ[1])/c.cellMetres);
  if(ix<0||iz<0||ix>=c.dimensions[0]||iz>=c.dimensions[1])return false;
  let cells=coverageSets.get(manifest);if(!cells){cells=new Set(c.cells);coverageSets.set(manifest,cells);}
  return cells.has(iz*c.dimensions[0]+ix);
}
export function excludeForestRoots(trees,manifest){
  if(!(trees instanceof Float32Array)||trees.length%8)throw Error('Invalid legacy forest roots');
  const out=[];for(let i=0;i<trees.length;i+=8)if(!forestCoversPoint(manifest,trees[i],trees[i+2]))out.push(...trees.subarray(i,i+8));
  return new Float32Array(out);
}

// Native pigment is sRGB; alpha is coverage, and normals are linear. Generate
// linear, coverage-weighted mips once on the GPU. Thresholding averaged alpha
// would delete subpixel leaves and turn an otherwise dense forest into haze.
export const FOREST_SURFACE_MIPS_WGSL=/* wgsl */`
@group(0)@binding(0)var forestMipAlbedo:texture_2d_array<f32>;
@group(0)@binding(1)var forestMipNormal:texture_2d_array<f32>;
@group(0)@binding(2)var forestMipColourOut:texture_storage_2d_array<rgba16float,write>;
@group(0)@binding(3)var forestMipNormalOut:texture_storage_2d_array<rgba16float,write>;
@group(0)@binding(4)var forestMipRoughness:texture_2d_array<f32>;
@group(0)@binding(5)var<storage,read>forestMipOptics:array<vec4f>;
fn forestMipLinear(c:vec3f)->vec3f{
 return select(pow((c+vec3f(.055))/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));
}
@compute @workgroup_size(8,8,1)fn forestSurfaceInit(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(forestMipColourOut);if(any(id.xy>=size)||id.z>=textureNumLayers(forestMipColourOut)){return;}
 let p=vec2i(id.xy);let layer=i32(id.z);let c=textureLoad(forestMipAlbedo,p,layer,0);
 let n=normalize(textureLoad(forestMipNormal,p,layer,0).xyz*2.-1.);
 var roughness=forestMipOptics[id.z].x;
 if(forestMipOptics[id.z].y>0.){roughness=textureLoad(forestMipRoughness,p,layer,0).r;}
 textureStore(forestMipColourOut,p,layer,vec4f(forestMipLinear(c.rgb)*c.a,c.a));
 textureStore(forestMipNormalOut,p,layer,vec4f(n*c.a,roughness*c.a));
}
@compute @workgroup_size(8,8,1)fn forestSurfaceMips(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(forestMipColourOut);if(any(id.xy>=size)||id.z>=textureNumLayers(forestMipColourOut)){return;}
 let edge=vec2i(textureDimensions(forestMipAlbedo))-1;let p=vec2i(id.xy)*2;let layer=i32(id.z);
 var colour=vec4f(0);var normal=vec4f(0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
   let q=min(p+vec2i(x,y),edge);colour+=textureLoad(forestMipAlbedo,q,layer,0);normal+=textureLoad(forestMipNormal,q,layer,0);
 }}
 textureStore(forestMipColourOut,vec2i(id.xy),layer,colour*.25);
 textureStore(forestMipNormalOut,vec2i(id.xy),layer,normal*.25);
}
`;

export async function createForestLeafSurfaces({device,shader,pack}){
  const layerCount=validateForestMaterials(pack.manifest.prototypes),materials=pack.manifest.prototypes.flatMap(p=>p.nativeMaterials);
  const images=[],families=[],textures=[],temporary=[];
  try{
    const optics=new Float32Array(layerCount*12);
    for(const [index,material]of materials.entries()){
      const maps={};for(const kind of ['albedo','normal','roughnessMap'].filter(key=>material[key])){
        const raw=pack.textures?.[material[kind].file];if(!(raw instanceof ArrayBuffer)||raw.byteLength!==material[kind].bytes)throw Error('Missing native forest surface: '+material[kind].file);
        const image=await createImageBitmap(new Blob([raw],{type:'image/png'}),{premultiplyAlpha:'none',colorSpaceConversion:'none'});images.push(image);maps[kind]=image;
      }
      const {width,height}=maps.albedo;
      if(width<1||height<1||width>2048||height>2048||(width&(width-1))||(height&(height-1))||Object.values(maps).some(image=>image.width!==width||image.height!==height))throw Error('Native material maps require matching power-of-two dimensions');
      let family=families.find(f=>f.width===width&&f.height===height);
      if(!family){family={width,height,id:families.length,rows:[],levels:1+Math.floor(Math.log2(Math.max(width,height)))};families.push(family);}
      if(families.length>4)throw Error('Native forest texture dimension family limit exceeded');
      optics.set([material.roughness,material.underside,material.transmission,material.opacityThreshold,...material.undersideReference,0,
        family.id,family.rows.length,material.wrap==='repeat'?1:0,material.clearcoat??0],index*12);
      family.rows.push({maps,material});
    }
    const T=GPUTextureUsage;
    const code=await shader(FOREST_SURFACE_MIPS_WGSL,'forest native surface mipmaps');
    const init=await device.createComputePipelineAsync({label:'forest initialise native surfaces',layout:'auto',compute:{module:code,entryPoint:'forestSurfaceInit'}});
    const mip=await device.createComputePipelineAsync({label:'forest filter native coverage',layout:'auto',compute:{module:code,entryPoint:'forestSurfaceMips'}});
    const encoder=device.createCommandEncoder({label:'forest immutable surface preparation'}),pass=encoder.beginComputePass();
    const view=(texture,level)=>texture.createView({dimension:'2d-array',baseMipLevel:level,mipLevelCount:1});
    for(const family of families){
      const {width,height,rows,levels}=family;
      const raw=label=>{const t=device.createTexture({label,size:[width,height,rows.length],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST|T.RENDER_ATTACHMENT});temporary.push(t);return t;};
      const sources=[raw('forest native source albedo'),raw('forest native source normal'),raw('forest native source roughness')];
      const target=label=>{const t=device.createTexture({label,size:[width,height,rows.length],format:'rgba16float',mipLevelCount:levels,usage:T.TEXTURE_BINDING|T.STORAGE_BINDING});textures.push(t);return t;};
      family.albedo=target('forest immutable native pigment and coverage mips');family.normal=target('forest immutable native normal and roughness mips');
      const rowOptics=new Float32Array(rows.length*4);for(const [layer,row]of rows.entries()){
        for(const [i,kind]of ['albedo','normal','roughnessMap'].entries())if(row.maps[kind])device.queue.copyExternalImageToTexture({source:row.maps[kind]},{texture:sources[i],origin:[0,0,layer]},[width,height]);
        rowOptics.set([row.material.roughness,row.maps.roughnessMap?1:0,0,0],layer*4);
      }
      const rowBuffer=device.createBuffer({label:'forest surface initial optics',size:rowOptics.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});temporary.push(rowBuffer);device.queue.writeBuffer(rowBuffer,0,rowOptics);
      for(let level=0;level<levels;level++){
        const pipeline=level?mip:init;pass.setPipeline(pipeline);
        const resources=[level?view(family.albedo,level-1):view(sources[0],0),level?view(family.normal,level-1):view(sources[1],0),view(family.albedo,level),view(family.normal,level)];
        const entries=resources.map((resource,binding)=>({binding,resource}));
        if(!level)entries.push({binding:4,resource:view(sources[2],0)},{binding:5,resource:{buffer:rowBuffer}});
        pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries}));
        pass.dispatchWorkgroups(Math.ceil(Math.max(1,width>>level)/8),Math.ceil(Math.max(1,height>>level)/8),rows.length);
      }
    }
    pass.end();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
    return {families,optics,layers:layerCount,destroy(){for(const texture of textures)texture.destroy();}};
  }catch(error){for(const texture of textures)texture.destroy();throw error;}
  finally{for(const image of images)image.close();for(const resource of temporary)resource.destroy();}
}

const ROOT_WGSL=/* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
`;
export const FOREST_VERTEX_WGSL=ROOT_WGSL+/* wgsl */`
@group(2)@binding(0)var<storage,read>forestRoots:array<ForestRoot>;
@group(2)@binding(1)var<storage,read>forestVisible:array<u32>;
@group(2)@binding(2)var<uniform>forestBin:vec4u;
struct ForestLeafMaterial {optics:vec4f,underside:vec4f,coordinates:vec4f};
@group(2)@binding(3)var forestNativeAlbedo0:texture_2d_array<f32>;
@group(2)@binding(4)var forestNativeNormal0:texture_2d_array<f32>;
@group(2)@binding(5)var forestNativeSampler:sampler;
@group(2)@binding(6)var<storage,read>forestNativeMaterials:array<ForestLeafMaterial>;
@group(2)@binding(7)var forestNativeAlbedo1:texture_2d_array<f32>;
@group(2)@binding(8)var forestNativeNormal1:texture_2d_array<f32>;
@group(2)@binding(9)var forestNativeAlbedo2:texture_2d_array<f32>;
@group(2)@binding(10)var forestNativeNormal2:texture_2d_array<f32>;
@group(2)@binding(11)var forestNativeAlbedo3:texture_2d_array<f32>;
@group(2)@binding(12)var forestNativeNormal3:texture_2d_array<f32>;
@group(2)@binding(13)var forestNativeRepeatSampler:sampler;
struct ForestVertex {
 @builtin(position)pos:vec4f,@location(0)world:vec3f,@location(1)normal:vec3f,
 @location(2)kind:vec2f,@location(3)leafUV:vec2f,@location(4)colour:vec3f,
 @location(5)@interpolate(flat)nativeMaterial:i32,
};
@vertex fn forestCanopyVS(@location(0)position:vec3f,@location(1)normal:vec3f,@location(2)kind:vec2f,
 @location(5)leafUV:vec2f,@location(6)colour:vec3f,@location(7)nativeMaterial:f32,@builtin(instance_index)instance:u32)->ForestVertex{
 let r=forestRoots[forestVisible[forestBin.x+instance]];let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let local=vec3f(c*position.x-s*position.z,position.y,s*position.x+c*position.z)*r.rootScale.w;
 var o:ForestVertex;o.world=r.rootScale.xyz+local;
 o.normal=vec3f(c*normal.x-s*normal.z,normal.y,s*normal.x+c*normal.z);
 o.nativeMaterial=i32(nativeMaterial);if(o.nativeMaterial>=0){o.nativeMaterial+=i32(forestBin.y);}
 o.kind=kind;o.leafUV=leafUV;o.colour=colour*r.yawColour.yzw;o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
fn forestNativeLinear(c:vec3f)->vec3f{
 return select(pow((c+vec3f(.055))/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));
}
struct ForestSurface {pigment:vec4f,detail:vec4f};
fn forestNativePair(albedo:texture_2d_array<f32>,normal:texture_2d_array<f32>,uv:vec2f,ux:vec2f,uy:vec2f,layer:i32,repeating:bool)->ForestSurface{
 var result:ForestSurface;
 if(repeating){result.pigment=textureSampleGrad(albedo,forestNativeRepeatSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeRepeatSampler,uv,layer,ux,uy);}
 else{result.pigment=textureSampleGrad(albedo,forestNativeSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeSampler,uv,layer,ux,uy);}
 return result;
}
fn forestReadNative(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->ForestSurface{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let repeating=material.coordinates.z>0.;
 if(family==0u){return forestNativePair(forestNativeAlbedo0,forestNativeNormal0,uv,ux,uy,layer,repeating);}
 if(family==1u){return forestNativePair(forestNativeAlbedo1,forestNativeNormal1,uv,ux,uy,layer,repeating);}
 if(family==2u){return forestNativePair(forestNativeAlbedo2,forestNativeNormal2,uv,ux,uy,layer,repeating);}
 return forestNativePair(forestNativeAlbedo3,forestNativeNormal3,uv,ux,uy,layer,repeating);
}
fn forestMappedNormal(geometric:vec3f,detail:vec3f,dx:vec3f,dy:vec3f,ux:vec2f,uy:vec2f)->vec3f{
 let determinant=ux.x*uy.y-ux.y*uy.x;
 let direction=select(-1.,1.,determinant>=0.);
 let tangent=dx*uy.y-dy*ux.y;let bitangent=dy*ux.x-dx*uy.x;
 var n=geometric;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){
   let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;
   let sampled=normalize(detail);n=normalize(t*sampled.x+b*sampled.y+geometric*sampled.z);
 }
 return n;
}
@fragment fn forestNativeOpaqueFS(in:ForestVertex,@builtin(front_facing)front:bool)->@location(0)vec4f{
 let dx=dpdx(in.world);let dy=dpdy(in.world);let ux=dpdx(in.leafUV);let uy=dpdy(in.leafUV);
 let geometric=normalize(in.normal);let exposure=clamp(in.kind.y,0.,1.);
 // This explicitly labelled legacy far approximation is permitted only when
 // the complete specimen fits three pixels. Its dome UVs are not native UVs.
 if(in.nativeMaterial<0){
   let ambient=select(.36+max(geometric.y,0.)*.25,.14+exposure*.47+max(geometric.y,0.)*.08,in.kind.x>3.5);
   return landFinish(in.world,geometric,in.colour,max(dot(geometric,F.sunDir.xyz),0.),ambient,0.,.95);
 }
 let material=forestNativeMaterials[u32(in.nativeMaterial)];let surface=forestReadNative(material,in.leafUV,ux,uy);
 let colour=surface.pigment.rgb/max(surface.pigment.a,1e-8)*in.colour;
 let n=forestMappedNormal(geometric,surface.detail.xyz,dx,dy,ux,uy)*select(-1.,1.,front);
 let roughness=clamp(surface.detail.a/max(surface.pigment.a,1e-8),0.,1.);
 return landFinish(in.world,n,colour,max(dot(n,F.sunDir.xyz),0.),.36+max(n.y,0.)*.25,0.,roughness);
}
@fragment fn forestNativeLeafFS(in:ForestVertex,@builtin(front_facing)front:bool)->@location(0)vec4f{
 let material=forestNativeMaterials[u32(in.nativeMaterial)];
 let dx=dpdx(in.world);let dy=dpdy(in.world);let ux=dpdx(in.leafUV);let uy=dpdy(in.leafUV);
 let surface=forestReadNative(material,in.leafUV,ux,uy);let pigment=surface.pigment;
 let n=forestMappedNormal(normalize(in.normal),surface.detail.xyz,dx,dy,ux,uy)*select(-1.,1.,front);
 var colour=pigment.rgb/max(pigment.a,1e-8)*in.colour;
 if(!front){colour=mix(colour,forestNativeLinear(material.underside.rgb)*in.colour,material.optics.y);}
 let exposure=clamp(in.kind.y,0.,1.);let nDotL=dot(n,F.sunDir.xyz);
 let diffuse=(max(nDotL,0.)+max(-nDotL,0.)*material.optics.z)*(.22+.78*exposure*exposure);
 let ambient=.12+exposure*.55+abs(n.y)*.08;
 let roughness=clamp(surface.detail.a/max(pigment.a,1e-8),0.,1.);
 let lit=landFinish(in.world,n,colour,diffuse,ambient,0.,roughness);
 // The source cutout was supersampled into alpha. Its opacityThreshold is
 // retained as source metadata, not applied to averaged mip coverage. MSAA
 // consumes that fractional coverage; transmission never changes opacity.
 return vec4f(lit.rgb,pigment.a);
}
`+FOREST_IMPOSTOR_WGSL;
export const FOREST_CULL_WGSL=FRAME_WGSL+ROOT_WGSL+/* wgsl */`
struct ForestPrototype {bound:vec4f,roots:vec4u,wood:vec4u,leaf:vec4u,far:vec4u};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>roots:array<ForestRoot>;
@group(0)@binding(2)var<storage,read>prototypes:array<ForestPrototype>;
@group(0)@binding(3)var<storage,read_write>visible:array<u32>;
@group(0)@binding(4)var<storage,read_write>commands:array<atomic<u32>>;
@group(0)@binding(5)var<storage,read_write>previousLod:array<u32>;
@group(0)@binding(6)var<uniform>parameters:vec4f;
@group(0)@binding(7)var<uniform>forestResidency:vec4u;
@compute @workgroup_size(64)fn forestReset(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(parameters.y)*4u){return;}atomicStore(&commands[id.x*5u+1u],0u);
}
@compute @workgroup_size(64)fn forestCull(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(parameters.x)){return;}
 let r=roots[id.x];if(r.rootScale.w<=0.0){return;}let pi=u32(r.identity.x);let p=prototypes[pi];let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let b=p.bound.xyz*r.rootScale.w;
 let world=r.rootScale.xyz+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z);let relative=world-F.camPos.xyz;let radius=p.bound.w*r.rootScale.w;
 let clip=F.viewProj*vec4f(relative,1);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 for(var a=0u;a<2u;a++){
   let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
   if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}
 }
 if(clip.w<-radius*length(rowW)){return;}
 let depth=dot(relative,normalize(F.camFwd.xyz));let near=depth-radius;
 let lateral=sqrt(max(0.0,dot(relative,relative)-depth*depth))+radius;
 let projected=F.screen.y/max(2.0*length(F.camUp.xyz),.0001)*2.0*radius*sqrt(1.0+lateral*lateral/max(near*near,.0001))/max(near,.0001);
 // A source-bound symmetric geometry certificate may bound displacement.
 // Without it, collapse only when the WHOLE crown fits three pixels. Neither
 // path certifies alpha/colour appearance; forced far mode is debug-only.
 let threshold=parameters.z*select(.88,1.0,previousLod[id.x]==0u);
 let resident=forestResidency.x>0u;
 let geometricError=bitcast<f32>(p.far.z)*r.rootScale.w;
 let farError=select(projected,projected*geometricError/(2.0*radius),p.far.w==1u);
 let farLod=resident&&(parameters.w==2.0||(parameters.w!=1.0&&near>radius&&farError<=threshold));
 let atlasSupported=p.roots.z>0u&&((p.roots.z&2u)!=0u||F.camPos.y>=world.y);
 let atlasThreshold=f32(p.roots.w)*select(.88,1.0,previousLod[id.x]==2u);
 let midLod=!farLod&&atlasSupported&&(!resident||(parameters.w==0.0&&near>radius&&(((p.roots.z&4u)!=0u)||projected<=atlasThreshold)));
 let nearLod=resident&&!farLod&&!midLod;
 if(!nearLod&&!farLod&&!midLod){return;}
 previousLod[id.x]=select(select(0u,2u,midLod),1u,nearLod);
 let command=(pi*4u+select(select(2u,3u,midLod),0u,nearLod))*5u;
 let slot=atomicAdd(&commands[command+1u],1u);
 let base=p.roots.x*3u+p.roots.y*select(select(1u,2u,midLod),0u,nearLod);
 visible[base+slot]=id.x;
 if(nearLod){atomicAdd(&commands[(pi*4u+1u)*5u+1u],1u);}
}
`;
// Optional block ownership extends the same GPU cull; its absence preserves
// the canonical bindings and direct-GPU fixtures. No CPU visibility fallback.
export const FOREST_MASS_ROOT_CULL_WGSL=FOREST_CULL_WGSL.replace(
 '@group(0)@binding(7)var<uniform>forestResidency:vec4u;',
 '@group(0)@binding(7)var<uniform>forestResidency:vec4u;\n@group(0)@binding(8)var<storage,read>forestMassOwnerSelected:array<u32>;'
).replace('let r=roots[id.x];if(r.rootScale.w<=0.0){return;}',
 'let r=roots[id.x];if(r.rootScale.w<=0.0){return;}if(r.identity.z>=0.&&forestMassOwnerSelected[u32(r.identity.z)]==1u){return;}');

export async function createForestRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack,groundSample,forestMass=null,mode='auto',nearPixels=3,
  impostorPixels=typeof location==='undefined'?32:Number(new URLSearchParams(location.search).get('forestImpostorPixels')||32),
  impostorMode=typeof location==='undefined'?'auto':new URLSearchParams(location.search).get('forestImpostor')||'auto'}){
  if(!['auto','near','far'].includes(mode)||!(nearPixels>0&&nearPixels<=3))throw Error('Invalid forest LOD policy');
  if(!['auto','off','force'].includes(impostorMode)||!Number.isInteger(impostorPixels)||impostorPixels<3||impostorPixels>256)throw Error('Invalid authored forest impostor policy');
  if(samples<2)throw Error('Native forest coverage requires MSAA');
  const m=pack.manifest,allocated=[],B=GPUBufferUsage;
  const make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error(label+' exceeds GPU maxBufferSize');const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST,label});allocated.push(b);if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;};
  const abort=new AbortController(),nativeStatus={status:'deferred',resident:false,error:null,uploadedBytes:0,totalBytes:m.files['vertices.bin'].bytes+m.files['indices.bin'].bytes};
  let atlas,native=null,destroyed=false;
  try{
    if(pack.impostors&&impostorMode!=='off')atlas=await createForestImpostorResources({device,shader,pack:pack.impostors,forest:m});
    const samplerOptions={minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4};
    const nativeSampler=device.createSampler({...samplerOptions,addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    const nativeRepeatSampler=device.createSampler({...samplerOptions,addressModeU:'repeat',addressModeV:'repeat'});
    const rooted=pack.roots.slice();let excludedRoots=0;
    if(forestMass){
      if(forestMass.rootChunks.length!==m.rootCount)throw Error('Native forest mass owner table differs from original root count');
      for(let i=0;i<rooted.length;i+=12){const owner=forestMass.rootChunks[i/12];rooted[i+10]=owner===0xffffffff?-1:owner;}
    }
    if(groundSample)for(let i=0;i<rooted.length;i+=12){
      const x=rooted[i],z=rooted[i+2],y=groundSample(x,z);
      if(!Number.isFinite(y))throw Error('Non-finite forest ground sampler');
      const sx=(groundSample(x+1,z)-groundSample(x-1,z))*.5,sz=(groundSample(x,z+1)-groundSample(x,z-1))*.5,slope=Math.hypot(sx,sz);
      // A measured near tile can expose a cliff/beach hidden by coarse data.
      // Reject that root once; never leave it floating or grow a replacement.
      if(y<18||y>840||!Number.isFinite(slope)||slope>1.1){rooted[i+3]=0;excludedRoots++;continue;}
      const basal=m.prototypes[rooted[i+8]].basalRadius??0;
      rooted[i+9]=Math.max(rooted[i+9],basal*rooted[i+3]*slope+.08);rooted[i+1]=y-rooted[i+9];
    }
    const roots=make(rooted,B.STORAGE,'forest immutable root transforms');
    const meta=new ArrayBuffer(m.prototypes.length*80),floats=new Float32Array(meta),words=new Uint32Array(meta),draws=new Uint32Array(m.prototypes.length*20);
    for(const p of m.prototypes){const base=p.id*20;floats.set([...p.centre,p.radius],base);words.set([p.firstRoot,p.rootCount,atlas?((atlas.fullSphere?2:1)|(impostorMode==='force'?4:0)):0,impostorPixels],base+4);
      for(const [i,name]of ['wood','leaf','far'].entries()){const r=p[name];words.set([r.firstIndex,r.indexCount,0,0],base+8+i*4);draws.set([r.indexCount,0,r.firstIndex,0,0],(p.id*4+i)*5);}
      if(p.geometryErrorSupported===true){floats[base+18]=p.geometryErrorMetres;words[base+19]=1;}
      draws.set([6,0,0,0,0],(p.id*4+3)*5);
    }
    const prototypes=make(new Uint8Array(meta),B.STORAGE,'forest prototype bounds and ranges');
    const visible=make(new Uint32Array(m.rootCount*3),B.STORAGE,'forest GPU visible root IDs');
    const commands=make(draws,B.STORAGE|B.INDIRECT,'forest GPU indirect draws');
    const previous=make(new Uint32Array(m.rootCount),B.STORAGE,'forest GPU previous LOD');
    const parameters=make(new Float32Array([m.rootCount,m.prototypes.length,nearPixels,['auto','near','far'].indexOf(mode)]),B.UNIFORM,'forest projected size policy');
    const residency=forestMass?.nativeResidency??make(new Uint32Array([0,0,0,0]),B.UNIFORM,'forest native residency');
    const compute=await shader(forestMass?FOREST_MASS_ROOT_CULL_WGSL:FOREST_CULL_WGSL,'forest GPU cull and compact');
    const reset=await device.createComputePipelineAsync({label:'forest reset indirect counts',layout:'auto',compute:{module:compute,entryPoint:'forestReset'}});
    const cull=await device.createComputePipelineAsync({label:'forest cull and LOD',layout:'auto',compute:{module:compute,entryPoint:'forestCull'}});
    const resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:commands}},{binding:6,resource:{buffer:parameters}}]});
    const cullBuffers=[frameUBO,roots,prototypes,visible,commands,previous,parameters,residency,...(forestMass?[forestMass.state]:[])];
    const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:cullBuffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    const pipe=fragment=>device.createRenderPipelineAsync({label:'instanced forest '+fragment,layout:'auto',vertex:{module,entryPoint:'forestCanopyVS',buffers:[FOREST_VERTEX_LAYOUT]},
      fragment:{module,entryPoint:fragment,targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:fragment==='forestNativeLeafFS'}});
    const opaque=await pipe('forestNativeOpaqueFS'),leaf=await pipe('forestNativeLeafFS');
    const impostor=atlas?await device.createRenderPipelineAsync({label:'instanced forest native depth impostor',layout:'auto',vertex:{module,entryPoint:'forestImpostorVS'},
      fragment:{module,entryPoint:'forestImpostorFS',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:true}}):null;
    const bind=(p,ids)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.filter(([i])=>ids.includes(i)).map(([binding,resource])=>({binding,resource}))});
    const opaqueGroup=bind(opaque,[0,1,2,3,4,5,6]),leafGroup=bind(leaf,[0,1,2,3,4,5,6]);
    const impostorGroup=impostor?bind(impostor,[0,1,2,3,4,5,6]):null,impostorAtlas=impostor?atlas.bind(impostor):null;
    const opaqueCloud=clouds.bindVolume(opaque),leafCloud=clouds.bindVolume(leaf);
    const impostorCloud=impostor?clouds.bindVolume(impostor):null;
    let materialBase=0;
    const bins=m.prototypes.map(p=>{
      const firstMaterial=materialBase;materialBase+=p.nativeMaterials.length;
      return [0,1,2].map(tier=>{
        const offset=make(new Uint32Array([p.firstRoot*3+tier*p.rootCount,firstMaterial,p.nativeMaterials.length,0]),B.UNIFORM,'forest bin offset');
        return{offset,opaque:null,leaf:null,impostor:tier===2&&impostor?device.createBindGroup({layout:impostor.getBindGroupLayout(2),entries:[roots,visible,offset].map((buffer,binding)=>({binding,resource:{buffer}}))}):null};
      });
    });
    const stats={loaded:true,roots:m.rootCount-excludedRoots,excludedRoots,prototypes:m.prototypes.length,gpuCulling:true,nearPixels,appearanceErrorSupported:false,mode,
      get backend(){return forestMass?'native / atlas / authored native-density mass':'native / atlas';},
      materialContract:m.materialContract,nativeMaterialLayers:0,nativeTextureFamilies:[],coverageFiltering:'linear alpha with MSAA',native:nativeStatus,
      certifiedGeometryPrototypes:m.prototypes.filter(p=>p.geometryErrorSupported===true).length,
      impostor:{loaded:!!atlas,error:pack.impostorError??null,views:atlas?.views??0,fullSphere:atlas?.fullSphere??false,projectedPixels:impostorPixels,
        mode:impostorMode,appearanceErrorSupported:false,qualification:'Authored initial policy; native rendered comparisons required'},
      species:[...new Set(m.prototypes.map(p=>p.species))],sourceClaim:m.sourceClaim};
    async function installNative(){
      let surfaces;const candidateBuffers=[];
      try{
        forestLoadAbort(abort.signal);
        for(const name of ['vertices.bin','indices.bin'])if(m.files[name].bytes>device.limits.maxBufferSize){nativeStatus.status='unsupported';throw Error('Native forest '+name+' exceeds device maxBufferSize ('+device.limits.maxBufferSize+')');}
        nativeStatus.status='loading';const source=pack.vertices?pack:await pack.loadNative({signal:abort.signal});forestLoadAbort(abort.signal);
        surfaces=await createForestLeafSurfaces({device,shader,pack:source});forestLoadAbort(abort.signal);
        const upload=async(data,usage,label)=>{
          const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength),buffer=device.createBuffer({label,size:bytes.byteLength,usage:usage|B.COPY_DST});allocated.push(buffer);candidateBuffers.push(buffer);
          // Each byte is uploaded once. Yield between transfer chunks rather
          // than copying hundreds of megabytes in one main-thread call.
          for(let offset=0;offset<bytes.length;offset+=1024*1024){forestLoadAbort(abort.signal);const size=Math.min(1024*1024,bytes.length-offset);device.queue.writeBuffer(buffer,offset,bytes,offset,size);nativeStatus.uploadedBytes+=size;await forestLoadYield();}
          return buffer;
        };
        nativeStatus.status='uploading';const vertices=await upload(source.vertices,B.VERTEX,'forest immutable prototype vertices'),indices=await upload(source.indices,B.INDEX,'forest immutable prototype indices');
        const materials=make(surfaces.optics,B.STORAGE,'forest immutable native material optics');candidateBuffers.push(materials);
        for(const p of m.prototypes)for(let tier=0;tier<2;tier++){
          const bin=bins[p.id][tier],group=pipeline=>{
            const entries=[...[roots,visible,bin.offset].map((buffer,binding)=>({binding,resource:{buffer}})),
              {binding:5,resource:nativeSampler},{binding:6,resource:{buffer:materials}},{binding:13,resource:nativeRepeatSampler}];
            for(let family=0;family<4;family++){const texture=surfaces.families[family]??surfaces.families[0],first=family?5+family*2:3;
              entries.push({binding:first,resource:texture.albedo.createView({dimension:'2d-array'})},{binding:first+1,resource:texture.normal.createView({dimension:'2d-array'})});}
            return device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries});
          };
          bin.opaque=group(opaque);if(tier===0)bin.leaf=group(leaf);
        }
        forestLoadAbort(abort.signal);native={vertices,indices,surfaces};
        stats.nativeMaterialLayers=surfaces.layers;stats.nativeTextureFamilies=surfaces.families.map(f=>({width:f.width,height:f.height,layers:f.rows.length,mipLevels:f.levels}));
        device.queue.writeBuffer(residency,0,new Uint32Array([1,0,0,0]));nativeStatus.resident=true;nativeStatus.status='resident';
        if(forestMass&&forestMass.stats.mode==='auto')forestMass.stats.phase='authored error-limited selection; native resources resident';
        pack.releaseNativeCPU?.();return true;
      }catch(error){surfaces?.destroy();for(const buffer of candidateBuffers)buffer.destroy();nativeStatus.error=error.message;
        if(!destroyed&&nativeStatus.status!=='unsupported')nativeStatus.status='failed';if(!atlas)throw error;return false;}
    }
    const deferred=atlas?.fullSphere&&mode==='auto'&&!pack.vertices;
    const nativeReady=deferred?new Promise(resolve=>setTimeout(resolve,0)).then(installNative):Promise.resolve(await installNative());
    const draw=(pass,pipeline,group,cloud,cutout)=>{
      if(!native)return;pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(1,cloud);pass.setVertexBuffer(0,native.vertices);pass.setIndexBuffer(native.indices,'uint32');
      for(const p of m.prototypes)for(const slot of cutout?[1]:[0,2]){
        if(!p[['wood','leaf','far'][slot]].indexCount)continue;
        pass.setBindGroup(2,bins[p.id][slot===2?1:0][cutout?'leaf':'opaque']);pass.drawIndexedIndirect(commands,(p.id*4+slot)*20);
      }
    };
    const drawImpostors=pass=>{
      if(!impostor)return;pass.setPipeline(impostor);pass.setBindGroup(0,impostorGroup);pass.setBindGroup(1,impostorCloud);pass.setBindGroup(3,impostorAtlas);pass.setIndexBuffer(atlas.indices,'uint32');
      for(const p of m.prototypes){pass.setBindGroup(2,bins[p.id][2].impostor);pass.drawIndexedIndirect(commands,(p.id*4+3)*20);}
    };
    return {stats,nativeReady,prepare(){},
      encode(pass){pass.setPipeline(reset);pass.setBindGroup(0,resetGroup);pass.dispatchWorkgroups(Math.ceil(m.prototypes.length*4/64));pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(Math.ceil(m.rootCount/64));},
      drawOpaque(pass){draw(pass,opaque,opaqueGroup,opaqueCloud,false);},drawCutout(pass){draw(pass,leaf,leafGroup,leafCloud,true);drawImpostors(pass);},destroy(){destroyed=true;abort.abort();nativeStatus.status='destroyed';nativeStatus.resident=false;for(const b of allocated)b.destroy();native?.surfaces.destroy();atlas?.destroy();}};
  }catch(error){destroyed=true;abort.abort();for(const b of allocated)b.destroy();native?.surfaces.destroy();atlas?.destroy();throw error;}
}
