// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Native leaf-density masses. Sampling estimates are authored, not certified
// equivalence to native leaf silhouettes, coverage, pigment or illumination.
import {FRAME_WGSL} from './wgsl/common.js';
import {createTaskYieldBudget,yieldCooperativeTask} from './task-yield.js';
import {CANOPY_VERTEX_LAYOUT} from './canopy-scenery.js';
import {ForestMeshoptDecoder} from './vendor/forest-meshopt.js';

export const FOREST_MASS_VERTEX_LAYOUT=Object.freeze({arrayStride:24,attributes:[
 {shaderLocation:0,offset:0,format:'float32x3'},
 {shaderLocation:1,offset:12,format:'snorm8x4'},
 {shaderLocation:6,offset:16,format:'float16x4'},
]});
export const FOREST_MASS_VERTEX_WGSL=/* wgsl */`
@vertex fn forestMassVS(@location(0)position:vec3f,@location(1)normal:vec4f,@location(6)colour:vec4f)->CanopyVertex{
 var o:CanopyVertex;o.world=position;o.normal=normalize(normal.xyz);o.kind=vec2f(4.,.8);o.leafUV=vec2f(0);o.colour=colour.rgb;
 o.pos=F.viewProj*vec4f(position-F.camPos.xyz,1);return o;
}
`;

export const FOREST_MASS_ASSETS=Object.freeze({
 'manifest.json':'assets/forest-scenery/saba/mass/manifest.json',
 'vertices.bin.gz':'assets/forest-scenery/saba/mass/vertices.bin.gz',
 'indices.bin.gz':'assets/forest-scenery/saba/mass/indices.bin.gz',
 'root-chunks.bin.gz':'assets/forest-scenery/saba/mass/root-chunks.bin.gz',
 'middle-vertices.bin.gz':'assets/forest-scenery/saba/mass/middle-vertices.bin.gz',
 'middle-indices.bin.gz':'assets/forest-scenery/saba/mass/middle-indices.bin.gz',
 'root-neighbors.bin.gz':'assets/forest-scenery/saba/mass/root-neighbors.bin.gz',
});
// Partition only verified, already-generated middle triangles, once at load.
// Volumetric foliage reuses their genuine native woody structure, without
// submitting the old opaque foliage isosurface underneath it.
export function forestMiddleWoodPartition(vertices,indices,prototypes){
 if(!(vertices instanceof Float32Array)||vertices.length%13||!(indices instanceof Uint32Array)||!Array.isArray(prototypes))throw Error('Invalid forest middle wood source');
 const selected=[],ranges=[];
 for(const p of prototypes){
  const firstIndex=selected.length;
  if(!Number.isSafeInteger(p.firstIndex)||!Number.isSafeInteger(p.indexCount)||p.indexCount%3||p.firstIndex<0||p.firstIndex+p.indexCount>indices.length)throw Error('Invalid forest middle wood range');
  for(let at=p.firstIndex;at<p.firstIndex+p.indexCount;at+=3){
   const face=indices.subarray(at,at+3),kinds=Array.from(face,id=>id*13+6<vertices.length?vertices[id*13+6]:NaN);
   if(!kinds.every(kind=>kind===kinds[0]&&(kind===3||kind===4)))throw Error('Mixed or invalid forest middle material triangle');
   if(kinds[0]===3)selected.push(...face);
  }
  ranges.push({...p,firstIndex,indexCount:selected.length-firstIndex});
 }
 return {indices:new Uint32Array(selected),prototypes:ranges};
}
const forestMassNames=['vertices.bin','indices.bin','root-chunks.bin'];
const forestMassMiddleNames=['middle-vertices.bin','middle-indices.bin'];
const forestMassStreams=m=>[...forestMassNames,...(m.prototypes?forestMassMiddleNames:[]),...(m.files['root-neighbors.bin']?['root-neighbors.bin']:[])];
const forestMassUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestMassVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const forestMassReceipt=r=>forestMassUint(r?.bytes)&&r.bytes>0&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256);
const forestMassSameReceipt=(a,b)=>forestMassReceipt(a)&&forestMassReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const forestMassUpward=value=>{const n=Math.fround(value);if(n>=value)return n;const bytes=new ArrayBuffer(4),floats=new Float32Array(bytes),words=new Uint32Array(bytes);floats[0]=n;words[0]++;return floats[0];};
const forestMassHalf=bits=>{const sign=bits&0x8000?-1:1,exponent=(bits>>10)&31,mantissa=bits&1023;return exponent===0?sign*mantissa*2**-24:exponent===31?(mantissa?NaN:sign*Infinity):sign*(1+mantissa/1024)*2**(exponent-15);};
const forestMassHalfValid=(()=>{const t=new Uint8Array(65536);for(let b=0;b<65536;b++){const v=forestMassHalf(b);if(Number.isFinite(v)&&v>=0)t[b]=v<=1?3:1;}return t;})();
function forestMassMeshoptReceipt(item,name,stride){
 if(item.meshopt===undefined)return;
 const codec=item.meshopt,mode=name==='vertices.bin'||name==='middle-vertices.bin'?'ATTRIBUTES':name==='indices.bin'||name==='middle-indices.bin'?'INDICES':null;
 if(!mode||!forestMassReceipt(codec)||codec.bytes>256*1024*1024||codec.mode!==mode||codec.stride!==stride||!forestMassUint(codec.count)||!codec.count||codec.count*codec.stride!==item.bytes||
  (codec.filter!==undefined&&codec.filter!=='NONE'))throw Error('Invalid lossless native forest meshopt receipt: '+name);
}

export function validateForestMass(m,forest){
 const source=forest?.manifest??forest;
 if(m?.format!=='waterworld.native-forest-mass'||!((m.version===1&&m.vertexStride===52)||(m.version===2&&m.vertexStride===24))||m.units!=='metres'||m.upAxis!=='Y'||
  !forestMassUint(source?.rootCount)||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>65535)throw Error('Unsupported native forest mass');
 for(const [name,stride]of [['vertices.bin',m.vertexStride],['indices.bin',4],['root-chunks.bin',4]]){
  const item=m.files?.[name],encoded=item?.gzip;
  if(!forestMassReceipt(item)||item.bytes%stride||item.bytes>256*1024*1024||!forestMassReceipt(encoded)||encoded.file!==name+'.gz')throw Error('Invalid native forest mass stream receipt: '+name);
  forestMassMeshoptReceipt(item,name,stride);
 }
 if(m.files['root-chunks.bin'].bytes!==source.rootCount*4)throw Error('Native forest mass owner table length differs from source');
 if(m.files['root-neighbors.bin']){const item=m.files['root-neighbors.bin'];if(!forestMassReceipt(item)||item.bytes!==source.rootCount*16||!forestMassReceipt(item.gzip)||item.gzip.file!=='root-neighbors.bin.gz')throw Error('Invalid native forest mass neighbor receipt');forestMassMeshoptReceipt(item,'root-neighbors.bin',16);}
 for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!forestMassSameReceipt(m.source?.files?.[name],source.files?.[name]))throw Error('Native forest mass source forest mismatch');
 if(!forestMassReceipt(m.source?.nativeFieldManifest)||!forestMassReceipt(m.source?.method)||m.source.method.file!=='scripts/prepare-forest-mass.py'||
  !m.source.nativeFieldRecipe||!(typeof m.source.nativeFieldRecipe.version==='string'?m.source.nativeFieldRecipe.version.length>0:forestMassUint(m.source.nativeFieldRecipe.version)&&m.source.nativeFieldRecipe.version>0))throw Error('Missing native forest field/method provenance');
 if(m.appearanceErrorSupported===true||m.geometryErrorSupported===true)throw Error('Authored native forest mass cannot claim a native appearance/geometry certificate');
 let next=0,owners=0;
 for(const [id,p]of m.chunks.entries()){
  if(p.id!==id||!forestMassVector(p.nominalBoundsXZ,4)||p.nominalBoundsXZ[0]>=p.nominalBoundsXZ[1]||p.nominalBoundsXZ[2]>=p.nominalBoundsXZ[3]||
   !forestMassVector(p.low,3)||!forestMassVector(p.high,3)||!forestMassVector(p.centre,3)||p.low.some((v,k)=>v>p.high[k])||
   !(Number.isFinite(p.radius)&&p.radius>0&&Number.isFinite(Math.fround(p.radius)))||!(Number.isFinite(p.lodErrorMetres)&&p.lodErrorMetres>0&&Number.isFinite(Math.fround(p.lodErrorMetres)))||
   !forestMassUint(p.rootCount)||p.firstIndex!==next||!forestMassUint(p.indexCount)||!p.indexCount||p.indexCount%3)throw Error('Invalid native forest mass chunk');
  for(let bits=0;bits<8;bits++)if(Math.hypot(...p.low.map((v,k)=>(bits&(1<<k)?p.high[k]:v)-p.centre[k]))>p.radius+1e-4)throw Error('Native forest mass bound misses chunk');
  if(p.low[0]<p.nominalBoundsXZ[0]-.001||p.high[0]>p.nominalBoundsXZ[1]+.001||p.low[2]<p.nominalBoundsXZ[2]-.001||p.high[2]>p.nominalBoundsXZ[3]+.001)throw Error('Native forest mass extends beyond its nominal block');
  next+=p.indexCount;owners+=p.rootCount;
 }
 if(next*4!==m.files['indices.bin'].bytes||owners>source.rootCount)throw Error('Incomplete native forest mass ranges/ownership');
 const middle=forestMassMiddleNames.some(name=>m.files[name]!==undefined)||m.prototypes!==undefined;
 if(middle){
  for(const [name,stride]of [['middle-vertices.bin',52],['middle-indices.bin',4]]){const item=m.files[name];if(!forestMassReceipt(item)||item.bytes%stride||item.bytes>256*1024*1024||!forestMassReceipt(item.gzip)||item.gzip.file!==name+'.gz')throw Error('Invalid native forest middle stream receipt');forestMassMeshoptReceipt(item,name,stride);}
  if(!Array.isArray(m.prototypes)||!m.prototypes.length||m.prototypes.length!==source.prototypes?.length)throw Error('Incomplete native forest middle registry');
  let middleIndex=0;
  for(const [id,p]of m.prototypes.entries()){
   if(p.id!==id||p.species!==source.prototypes[id].species||p.firstIndex!==middleIndex||!forestMassUint(p.indexCount)||!p.indexCount||p.indexCount%3||
    !(Number.isFinite(p.lodErrorMetres)&&p.lodErrorMetres>0&&Number.isFinite(Math.fround(p.lodErrorMetres))))throw Error('Invalid native forest middle prototype');
   if((p.low!==undefined||p.high!==undefined)&&(!forestMassVector(p.low,3)||!forestMassVector(p.high,3)||p.low.some((v,k)=>v>p.high[k])))throw Error('Invalid native forest middle bound');
   middleIndex+=p.indexCount;
  }
  if(middleIndex*4!==m.files['middle-indices.bin'].bytes)throw Error('Incomplete native forest middle index ranges');
 }
 return m;
}
function* forestMassChecks(manifest,streams,forest){
 validateForestMass(manifest,forest);
 for(const name of forestMassStreams(manifest))if(!(streams[name] instanceof ArrayBuffer)||streams[name].byteLength!==manifest.files[name].bytes)throw Error('Incomplete native forest mass stream: '+name);
 const compact=manifest.version===2,vertices=compact?new Uint8Array(streams['vertices.bin']):new Float32Array(streams['vertices.bin']),indices=new Uint32Array(streams['indices.bin']),rootChunks=new Uint32Array(streams['root-chunks.bin']);
 const vFloats=compact?new Float32Array(streams['vertices.bin']):vertices,vInt8=compact?new Int8Array(streams['vertices.bin']):null,vUint16=compact?new Uint16Array(streams['vertices.bin']):null,vertexCount=streams['vertices.bin'].byteLength/manifest.vertexStride;
 for(let i=0;i<vertexCount;i++){
  if(compact){const fAt=i*6,bAt=i*24,hAt=i*12,x=vFloats[fAt],y=vFloats[fAt+1],z=vFloats[fAt+2],
    nx=Math.max(-127,vInt8[bAt+12]),ny=Math.max(-127,vInt8[bAt+13]),nz=Math.max(-127,vInt8[bAt+14]),
    len2=nx*nx+ny*ny+nz*nz,
    rgbaOk=(forestMassHalfValid[vUint16[hAt+8]]&forestMassHalfValid[vUint16[hAt+9]]&forestMassHalfValid[vUint16[hAt+10]]&1)!==0&&(forestMassHalfValid[vUint16[hAt+11]]&2)!==0;
   // Quantizing a unit vector to snorm8 changes its component lengths. Check
   // that quantized envelope, then normalize on GPU; never expand the stream.
   if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)||!rgbaOk||len2<15649||len2>16616)throw Error('Invalid packed native forest mass vertex');
  }else{const o=i*13;for(let k=0;k<13;k++)if(!Number.isFinite(vertices[o+k]))throw Error('Invalid native forest mass vertex');const nx=vertices[o+3],ny=vertices[o+4],nz=vertices[o+5];if(vertices[o+6]!==4||vertices[o+7]<0||vertices[o+7]>1||vertices[o+10]<0||vertices[o+11]<0||vertices[o+12]<0||Math.abs(Math.sqrt(nx*nx+ny*ny+nz*nz)-1)>.001)throw Error('Invalid native forest mass vertex');}
  if((i&4095)===0)yield;
 }
 const vStride=compact?6:13;
 for(const p of manifest.chunks){
  const low0=p.low[0]-.001,low1=p.low[1]-.001,low2=p.low[2]-.001,high0=p.high[0]+.001,high1=p.high[1]+.001,high2=p.high[2]+.001,end=p.firstIndex+p.indexCount;
  for(let i=p.firstIndex;i<end;i++){
   const index=indices[i];if(index>=vertexCount)throw Error('Native forest mass index outside geometry');
   const v=index*vStride,x=vFloats[v],y=vFloats[v+1],z=vFloats[v+2];
   if(x<low0||x>high0||y<low1||y>high1||z<low2||z>high2)throw Error('Native forest mass vertex outside chunk bound');
   if((i&16383)===0)yield;
  }
 }
 const counts=new Uint32Array(manifest.chunks.length),roots=forest?.roots;
 if(roots&&(!(roots instanceof Float32Array)||roots.length!==rootChunks.length*12))throw Error('Incomplete native forest mass source roots');
 for(let i=0;i<rootChunks.length;i++){
  const owner=rootChunks[i];if(owner!==0xffffffff){if(owner>=counts.length)throw Error('Native forest mass owner outside chunk table');counts[owner]++;
   if(roots){const box=manifest.chunks[owner].nominalBoundsXZ,x=roots[i*12],z=roots[i*12+2];if(x<box[0]||x>=box[1]||z<box[2]||z>=box[3])throw Error('Native forest mass owner disagrees with source root position');}}
  if((i&4095)===0)yield;
 }
 for(const p of manifest.chunks)if(counts[p.id]!==p.rootCount)throw Error('Native forest mass owner count mismatch');
 const rootNeighbors=manifest.files['root-neighbors.bin']?new Uint32Array(streams['root-neighbors.bin']):null;
 if(rootNeighbors)for(let i=0;i<rootNeighbors.length;i++){const id=rootNeighbors[i];if(id!==0xffffffff&&id!==0xfffffffe&&id>=manifest.chunks.length)throw Error('Native forest mass neighbor outside chunk table');if((i&4095)===0)yield;}
 let middleVertices=null,middleIndices=null;
 if(manifest.prototypes){middleVertices=new Float32Array(streams['middle-vertices.bin']);middleIndices=new Uint32Array(streams['middle-indices.bin']);
  for(let i=0;i<middleVertices.length;i+=13){for(let k=0;k<13;k++)if(!Number.isFinite(middleVertices[i+k]))throw Error('Invalid native forest middle vertex');const nx=middleVertices[i+3],ny=middleVertices[i+4],nz=middleVertices[i+5],v6=middleVertices[i+6];if((v6!==3&&v6!==4)||middleVertices[i+7]<0||middleVertices[i+7]>1||middleVertices[i+10]<0||middleVertices[i+11]<0||middleVertices[i+12]<0||Math.abs(Math.sqrt(nx*nx+ny*ny+nz*nz)-1)>.001)throw Error('Invalid native forest middle vertex');if(((i/13)&1023)===0)yield;}
  for(const p of manifest.prototypes)for(let i=p.firstIndex;i<p.firstIndex+p.indexCount;i++){const at=middleIndices[i]*13;if(at>=middleVertices.length)throw Error('Native forest middle index outside geometry');if(p.low)for(let k=0;k<3;k++)if(middleVertices[at+k]<p.low[k]-.001||middleVertices[at+k]>p.high[k]+.001)throw Error('Native forest middle vertex outside prototype');if((i&4095)===0)yield;}
 }
 return{manifest,vertices,indices,rootChunks,rootNeighbors,middleVertices,middleIndices,finiteValidated:true};
}
const CERTIFIED_SABA_MASS_SHAS=Object.freeze({
 'vertices.bin':'d3268a75895acfa30c1364409cb7b6c835fe4d0ca40cf16b4036851cab491ed3',
 'indices.bin':'d1c2444b62113ba3a615894a784bccfcbd41dce21f443e420ade191a31f2095f',
 'root-chunks.bin':'067d5130c813d34ed5ace7d1c6c058f173ad18151d8507aa177061ba34e5fe5a',
 'root-neighbors.bin':'22cdd8a96818ee7c9cec70b9516929fcebad85e73d81929945010a2c78943f3b',
 'middle-vertices.bin':'a1bd03c29fc65b5c436b9d754e43a52de378f56fac9b65da28970ea7b4860657',
 'middle-indices.bin':'9b852fa53812f95ec3411f4d554c7e1874f4aa9f71bde367020ce21154349b58',
});
export function decodeForestMass(manifest,streams,forest){const iterator=forestMassChecks(manifest,streams,forest);let next;do{next=iterator.next();}while(!next.done);return next.value;}
export async function loadForestMass({forest,rootsPromise=null,fetchAsset=fetch,assets=FOREST_MASS_ASSETS,manifestOnly=false,onManifest}){
 const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered native forest mass asset: '+name);const response=await fetchAsset(assets[name]);if(!response.ok)throw Error('Native forest mass asset unavailable: '+name);return response;};
 const manifest=validateForestMass(await(await load('manifest.json')).json(),forest);
 onManifest?.(manifest);
 if(manifestOnly)return{manifest,manifestOnly:true};
 if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Native forest mass requires verified gzip transport');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const streams={},streamNames=forestMassStreams(manifest);
 if(streamNames.some(name=>manifest.files[name].meshopt)&&ForestMeshoptDecoder.supported)ForestMeshoptDecoder.ready.catch(()=>{});
 const pending=new Map(streamNames.map(name=>[name,load(manifest.files[name].gzip.file).then(r=>r.arrayBuffer()).then(v=>({ok:true,v}),e=>({ok:false,e}))]));
 await Promise.all(streamNames.map(async name=>{
  const item=manifest.files[name],res=await pending.get(name);if(!res.ok)throw res.e;const encoded=res.v;
  if(encoded.byteLength!==item.gzip.bytes||await digest(encoded)!==item.gzip.sha256)throw Error('Native forest mass encoded digest mismatch');
  let raw=await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(item.meshopt){
   const codec=item.meshopt;if(raw.byteLength!==codec.bytes||await digest(raw)!==codec.sha256)throw Error('Native forest mass meshopt digest mismatch');
   if(!ForestMeshoptDecoder.supported)throw Error('Lossless native forest meshopt decoding unavailable');await ForestMeshoptDecoder.ready;
   const decoded=new Uint8Array(item.bytes);ForestMeshoptDecoder.decodeGltfBuffer(decoded,codec.count,codec.stride,new Uint8Array(raw),codec.mode,'NONE');raw=decoded.buffer;
  }
  // INDICES is the sequence codec: original index bytes/order must match,
  // rather than merely rendering equivalent triangles after a rotation.
  if(raw.byteLength!==item.bytes||await digest(raw)!==item.sha256)throw Error('Native forest mass decoded digest mismatch');streams[name]=raw;
 }));
 const resolvedForest=rootsPromise?(await rootsPromise)??forest:forest;
 const certifiedSaba=manifest.version===2&&streamNames.every(name=>manifest.files[name]?.sha256===CERTIFIED_SABA_MASS_SHAS[name])&&
  (!resolvedForest?.roots||(manifest.source?.files?.['roots.bin']?.sha256==='69bc2f787873f09944683f49e88c9bc09d8b068a33aee85453b626150050de9b'&&resolvedForest.roots.byteLength===4101648));
 if(certifiedSaba){
  await yieldCooperativeTask();
  return{
   manifest,
   vertices:new Uint8Array(streams['vertices.bin']),
   indices:new Uint32Array(streams['indices.bin']),
   rootChunks:new Uint32Array(streams['root-chunks.bin']),
   rootNeighbors:manifest.files['root-neighbors.bin']?new Uint32Array(streams['root-neighbors.bin']):null,
   middleVertices:manifest.prototypes?new Float32Array(streams['middle-vertices.bin']):null,
   middleIndices:manifest.prototypes?new Uint32Array(streams['middle-indices.bin']):null,
   finiteValidated:true,
  };
 }
 const iterator=forestMassChecks(manifest,streams,resolvedForest),pauseIfNeeded=createTaskYieldBudget();
 for(;;){const next=iterator.next();if(next.done)return next.value;const pause=pauseIfNeeded();if(pause)await pause;}
}

export const FOREST_MASS_CULL_WGSL=FRAME_WGSL+/* wgsl */`
struct ForestMassBlock {bound:vec4f,lowError:vec4f,high:vec4f,draw:vec4u};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>forestMassBlocks:array<ForestMassBlock>;
@group(0)@binding(2)var<storage,read_write>forestMassCommands:array<u32>;
@group(0)@binding(3)var<storage,read_write>forestMassSelected:array<u32>;
@group(0)@binding(4)var<uniform>forestMassPolicy:vec4f;
@group(0)@binding(5)var<uniform>forestMassNativeResidency:vec4u;
@compute @workgroup_size(64)fn forestMassCull(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(forestMassPolicy.x)){return;}let item=forestMassBlocks[id.x];let old=forestMassSelected[id.x];forestMassSelected[id.x]=0u;forestMassCommands[id.x*5u+1u]=0u;
 if(forestMassPolicy.z==1.){return;}
 let relative=item.bound.xyz-F.camPos.xyz;let radius=item.bound.w;let clip=F.viewProj*vec4f(relative,1);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 for(var a=0u;a<2u;a++){let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
  if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}}
 if(clip.w<-radius*length(rowW)){return;}
 let forwardDir=normalize(F.camFwd.xyz);let dist=length(relative);
 let depth=dot(relative,forwardDir);let near=depth-radius;
 let lateral=sqrt(max(0.,dot(relative,relative)-depth*depth))+radius;let error=item.lowError.w;
 let threshold=forestMassPolicy.y*select(.88,1.,old==1u);
 let inCanopy=clamp((F.camPos.y-18.)/24.,0.,1.);
 let midNear=max(select(near,dist-radius*.45,inCanopy>0.),1.5);
 let cosGaze=clamp(depth/max(dist,.0001),0.,1.);let sinGaze2=1.-cosGaze*cosGaze;
 let elevAbove=max(0.,relative.y/max(dist,.0001)-forwardDir.y-.16);
 let gazeAcuity=1./(1.+4.5*sinGaze2+6.*sinGaze2*sinGaze2+120.*elevAbove*elevAbove);
 let canopyMask=1./(1.+max(0.,midNear-150.)*.025*min(1.,elevAbove*8.));
 let offAxis=sqrt(1.+lateral*lateral/max(near*near,.0001));
 let perceptualScreenY=mix(F.screen.y,min(F.screen.y,1080.),inCanopy);
 let perceptualFocal=perceptualScreenY/max(2.*length(F.camUp.xyz),.0001)*mix(offAxis,gazeAcuity*canopyMask,inCanopy);
 let effectiveNear=select(near,select(0.,midNear,midNear>180.),inCanopy>0.);
 let pixels=perceptualFocal*error/max(effectiveNear-error,.0001);
 // E is an authored sampling/support estimate. This projection bounds that
 // footprint, not native leaf appearance. Residency never bypasses it unless
 // the caller explicitly requests the separately labelled startup preview.
 let preview=forestMassPolicy.w==1.&&forestMassNativeResidency.x==0u;
 if(forestMassPolicy.z==2.||preview||(effectiveNear>error&&pixels<=threshold)){forestMassSelected[id.x]=1u;forestMassCommands[id.x*5u+1u]=1u;}
}
`;

export async function createForestMassRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack,middlePack=null,mode='auto',pixelError=3,preview=false}){
 if(!['auto','near','far'].includes(mode)||!(pixelError>0&&pixelError<=3)||typeof preview!=='boolean'||pack.finiteValidated!==true)throw Error('Invalid native forest mass render policy/validation');
 const allocated=[],B=GPUBufferUsage,m=pack.manifest,make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error(label+' exceeds GPU maxBufferSize');const buffer=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});allocated.push(buffer);if(data.byteLength)device.queue.writeBuffer(buffer,0,data);return buffer;};
 try{
  const pipelinesPromise=Promise.all([
    shader(FOREST_MASS_CULL_WGSL,'forest mass GPU cull').then(code=>device.createComputePipelineAsync({label:'forest mass GPU block selection',layout:'auto',compute:{module:code,entryPoint:'forestMassCull'}})),
    device.createRenderPipelineAsync({label:'forest mass opaque native density surface',layout:'auto',vertex:{module,entryPoint:m.version===2?'forestMassVS':'bakedCanopyVS',buffers:[m.version===2?FOREST_MASS_VERTEX_LAYOUT:CANOPY_VERTEX_LAYOUT]},fragment:{module,entryPoint:'canopyOpaqueFS',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:false}}),
  ]);
  pipelinesPromise.catch(()=>{});
  const vertices=make(pack.vertices,B.VERTEX,'forest mass immutable vertices'),indices=make(pack.indices,B.INDEX,'forest mass immutable indices');
  if(middlePack&&middlePack.sourceValidated!==true)throw Error('Unverified reduced forest middle');
  const middleSource=middlePack??(pack.middleVertices?{vertices:pack.middleVertices,indices:pack.middleIndices,prototypes:m.prototypes}:null);
  const wood=middleSource?forestMiddleWoodPartition(middleSource.vertices,middleSource.indices,middleSource.prototypes):null;
  const middle=middleSource?{vertices:make(middleSource.vertices,B.VERTEX,'forest middle immutable native-derived vertices'),indices:make(middleSource.indices,B.INDEX,'forest middle immutable native-derived indices'),prototypes:middleSource.prototypes,reduced:!!middlePack,
   woodIndices:make(wood.indices,B.INDEX,'forest middle immutable native wood indices'),woodPrototypes:wood.prototypes}:null;
  const neighbors=pack.rootNeighbors?make(pack.rootNeighbors,B.STORAGE,'forest mass immutable root neighbors'):null;
  const metadata=new ArrayBuffer(m.chunks.length*64),floats=new Float32Array(metadata),words=new Uint32Array(metadata),draws=new Uint32Array(m.chunks.length*5);
  for(const p of m.chunks){const at=p.id*16,centre=p.centre.map(Math.fround),radius=forestMassUpward(p.radius+Math.hypot(...centre.map((v,k)=>v-p.centre[k])));floats.set([...centre,radius,...p.low,forestMassUpward(p.lodErrorMetres),...p.high,0],at);words.set([p.firstIndex,p.indexCount,p.rootCount,0],at+12);draws.set([p.indexCount,0,p.firstIndex,0,0],p.id*5);}
  const blocks=make(new Uint8Array(metadata),B.STORAGE,'forest mass immutable block bounds'),commands=make(draws,B.STORAGE|B.INDIRECT,'forest mass GPU indirect draws');
  const modeIndex=['auto','near','far'].indexOf(mode);
  let currentPixelError=pixelError;
  const state=make(new Uint32Array(m.chunks.length),B.STORAGE,'forest mass GPU selected blocks'),policy=make(new Float32Array([m.chunks.length,pixelError,modeIndex,preview?1:0]),B.UNIFORM,'forest mass authored pixel error policy');
  const nativeResidency=make(new Uint32Array([0,0,0,0]),B.UNIFORM,'forest mass shared native residency');
  const [cull,pipeline]=await pipelinesPromise;
  const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frameUBO,blocks,commands,state,policy,nativeResidency].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.filter(([id])=>id<=6).map(([binding,resource])=>({binding,resource}))});
  const bundle=device.createRenderBundleEncoder({label:'forest mass immutable indirect bundle',colorFormats:[format],depthStencilFormat:'depth32float',sampleCount:samples});bundle.setPipeline(pipeline);bundle.setBindGroup(0,group);bundle.setBindGroup(1,clouds.bindVolume(pipeline));bundle.setVertexBuffer(0,vertices);bundle.setIndexBuffer(indices,'uint32');for(const p of m.chunks)bundle.drawIndexedIndirect(commands,p.id*20);const recorded=[bundle.finish()];
  const stats={loaded:true,blocks:m.chunks.length,sourceRoots:pack.rootChunks.length,gpuCulling:true,opaque:true,mode,pixelError,preview,finiteValidated:true,sourceReceiptsValidated:true,vertexStride:m.vertexStride,quantization:m.quantization??null,appearanceErrorSupported:false,geometryErrorSupported:false,nativeValidation:m.validation??null,neighborGuard:!!neighbors,middle:{loaded:!!middle,reduced:!!middlePack,prototypes:middle?.prototypes.length??0,triangles:middle?.prototypes.map(p=>p.indexCount/3)??[],errorQualification:'Authored native sampling/wood-clustering footprint; no appearance certificate'},
   phase:mode==='far'?'forced far debug; pixel threshold bypassed':mode==='near'?'native-only debug; mass disabled':preview?'explicit startup mass preview until native residency':'authored error-limited selection',selectionMetric:'Projected authored leaf-support/sampling footprint; native appearance unqualified',representation:'Continuous surface from original native leaf-area density and source pigment'};
  return{stats,rootChunks:pack.rootChunks,chunks:m.chunks,state,nativeResidency,commands,middle,neighbors,
   setPixelError(next){if(Number.isFinite(next)&&next>0&&Math.abs(next-currentPixelError)>1e-4){currentPixelError=next;stats.pixelError=next;device.queue.writeBuffer(policy,0,new Float32Array([m.chunks.length,next,modeIndex,preview?1:0]));}},
   encode(pass){pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(Math.ceil(m.chunks.length/64));},drawOpaque(pass){pass.executeBundles(recorded);},destroy(){for(const buffer of allocated)buffer.destroy();}};
 }catch(error){for(const buffer of allocated)buffer.destroy();throw error;}
}
