// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Solid source-crown union chunks. Native close trees remain immutable.
import {FRAME_WGSL} from './wgsl/common.js';
import {CANOPY_VERTEX_LAYOUT} from './canopy-scenery.js';
export const FOREST_CANOPY_ASSETS=Object.freeze({
 'manifest.json':'assets/forest-scenery/saba/canopy/manifest.json',
 'vertices.bin':'assets/forest-scenery/saba/canopy/vertices.bin',
 'indices.bin':'assets/forest-scenery/saba/canopy/indices.bin',
 'root-chunks.bin':'assets/forest-scenery/saba/canopy/root-chunks.bin',
 'vertices.bin.gz':'assets/forest-scenery/saba/canopy/vertices.bin.gz',
 'indices.bin.gz':'assets/forest-scenery/saba/canopy/indices.bin.gz',
 'root-chunks.bin.gz':'assets/forest-scenery/saba/canopy/root-chunks.bin.gz',
});
const forestCanopyNames=['vertices.bin','indices.bin','root-chunks.bin'];
const forestCanopyFinite=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const forestCanopyUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestCanopyHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const forestCanopyReceipt=r=>forestCanopyUint(r?.bytes)&&r.bytes>0&&forestCanopyHash(r.sha256);
const forestCanopySameReceipt=(a,b)=>forestCanopyReceipt(a)&&forestCanopyReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const forestCanopySampling=['cellMetres','horizontalCellDiagonalMetres','witnessHorizontalMetres','verticalExcessMetres','arithmeticAllowanceMetres'];
const forestCanopyErrorMethod='conservative-solid-column-union-containment-v1';
function forestCanopyCertificate(p,m,forest){
 const s=p.geometryErrorSource,t=p.sampling;
 if(!Number.isFinite(p.geometryErrorMetres)||p.geometryErrorMetres<0||Math.fround(p.geometryErrorMetres)!==p.geometryErrorMetres||
  p.geometryErrorMethod!==forestCanopyErrorMethod||m.geometryErrorMethod!==forestCanopyErrorMethod||
  !s||s.method?.file!=='scripts/prepare-forest-canopy.py'||s.method.file!==m.source?.method?.file||!forestCanopySameReceipt(s.method,m.source.method)||
  !forestCanopySameReceipt(s.rootOwnership,m.files['root-chunks.bin'])||s.range?.firstIndex!==p.firstIndex||s.range?.indexCount!==p.indexCount||
  typeof s.proof!=='string'||!s.proof||!forestCanopyReceipt(s.sourceRoots)||s.sourceRoots.bytes!==p.rootCount*4||
  !forestCanopyReceipt(s.seatedRoots)||s.seatedRoots.bytes!==p.rootCount*48||!forestCanopyReceipt(s.transformedCrowns)||
  !forestCanopyReceipt(s.unindexedShell)||s.unindexedShell.bytes!==p.indexCount*52||
  !forestCanopySameReceipt(s.sourceRoots,p.sourceRoots)||!forestCanopySameReceipt(s.seatedRoots,p.seatedRoots)||
  !forestCanopySameReceipt(s.transformedCrowns,p.sourceTransformedCrowns)||!forestCanopySameReceipt(s.unindexedShell,p.sourceUnindexedShell))throw Error('Invalid solid canopy geometry certificate');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!forestCanopySameReceipt(s.sourceFiles?.[name],forest.files?.[name])||
  !forestCanopySameReceipt(s.sourceFiles[name],m.source.files[name]))throw Error('Solid canopy certificate source mismatch');
 for(const name of ['vertices.bin','indices.bin'])if(!forestCanopySameReceipt(s.packedStreams?.[name],m.files[name]))throw Error('Solid canopy certificate packed stream mismatch');
 for(const key of forestCanopySampling)if(!Number.isFinite(t?.[key])||t[key]<0||s.sampling?.[key]!==t[key])throw Error('Solid canopy certificate sampling mismatch');
 const required=Math.hypot(t.witnessHorizontalMetres,t.verticalExcessMetres)+t.arithmeticAllowanceMetres;
 // The serialized bound is upward Float32; only double evaluation roundoff,
 // never a Float32 ULP or a pixel-error tolerance, may differ across hosts.
 if(p.geometryErrorMetres+Number.EPSILON*Math.max(1,required)*8<required)throw Error('Solid canopy certificate understates measured error');
}
export function validateForestCanopy(m,forest){
 if(m?.format!=='waterworld.forest-canopy'||m.version!==1||m.units!=='metres'||m.upAxis!=='Y'||m.vertexStride!==52||
  !Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>65535||!forestCanopyUint(forest?.rootCount))throw Error('Unsupported solid forest canopy');
 for(const [name,stride]of [['vertices.bin',52],['indices.bin',4],['root-chunks.bin',4]]){
  const f=m.files?.[name];if(!forestCanopyUint(f?.bytes)||!f.bytes||f.bytes%stride||f.bytes>256*1024*1024||!forestCanopyHash(f.sha256))throw Error('Invalid solid canopy stream receipt: '+name);
  if(f.gzip&&(f.gzip.file!==name+'.gz'||!forestCanopyUint(f.gzip.bytes)||!f.gzip.bytes||!forestCanopyHash(f.gzip.sha256)))throw Error('Invalid solid canopy gzip receipt');
 }
 if(m.files['root-chunks.bin'].bytes!==forest.rootCount*4)throw Error('Solid canopy root ownership length mismatch');
 for(const name of ['vertices.bin','indices.bin','roots.bin']){
  const source=m.source?.files?.[name],actual=forest.files?.[name];
  if(!actual||source?.bytes!==actual.bytes||source.sha256!==actual.sha256)throw Error('Solid canopy source forest mismatch');
 }
 let next=0;
 for(const [id,p]of m.chunks.entries()){
  if(p.id!==id||!forestCanopyFinite(p.low,3)||!forestCanopyFinite(p.high,3)||!forestCanopyFinite(p.centre,3)||
   !(p.radius>0&&Number.isFinite(p.radius))||p.low.some((v,k)=>v>p.high[k])||!forestCanopyUint(p.rootCount)||!p.rootCount||
   p.firstIndex!==next||!forestCanopyUint(p.indexCount)||!p.indexCount||p.indexCount%3)throw Error('Invalid solid canopy chunk');
  for(let bits=0;bits<8;bits++)if(Math.hypot(...p.low.map((v,k)=>(bits&(1<<k)?p.high[k]:v)-p.centre[k]))>p.radius+1e-4)throw Error('Solid canopy chunk bound misses geometry');
  if(!(p.sampling?.cellMetres>0&&Number.isFinite(p.sampling.cellMetres))||
   !(p.sampling.horizontalCellDiagonalMetres>=p.sampling.cellMetres*Math.SQRT2-1e-6))throw Error('Invalid solid canopy sampling metric');
  if(p.geometryErrorSupported===true)forestCanopyCertificate(p,m,forest);
  next+=p.indexCount;
 }
 if(next*4!==m.files['indices.bin'].bytes)throw Error('Incomplete solid canopy index ranges');
 return m;
}
function* forestCanopyChecks(manifest,streams,forest){
 validateForestCanopy(manifest,forest);
 for(const name of forestCanopyNames)if(!(streams[name] instanceof ArrayBuffer)||streams[name].byteLength!==manifest.files[name].bytes)throw Error('Incomplete solid canopy stream: '+name);
 const vertices=new Float32Array(streams['vertices.bin']),indices=new Uint32Array(streams['indices.bin']),rootChunks=new Uint32Array(streams['root-chunks.bin']);
 for(let i=0;i<vertices.length;i+=13){
  const row=vertices.subarray(i,i+13);
  if(!row.every(Number.isFinite)||row[6]!==4||row[7]<0||row[7]>1||row.subarray(10,13).some(v=>v<0)||Math.abs(Math.hypot(...row.subarray(3,6))-1)>.001)throw Error('Invalid opaque canopy vertex');
  if(((i/13)&1023)===0)yield;
 }
 for(const p of manifest.chunks)for(let i=p.firstIndex;i<p.firstIndex+p.indexCount;i++){
  const vertex=indices[i]*13;if(vertex>=vertices.length)throw Error('Solid canopy index outside geometry');
  for(let k=0;k<3;k++)if(vertices[vertex+k]<p.low[k]-.001||vertices[vertex+k]>p.high[k]+.001)throw Error('Solid canopy vertex outside chunk');
  if((i&4095)===0)yield;
 }
 const counts=new Uint32Array(manifest.chunks.length);
 for(let i=0;i<rootChunks.length;i++){
  const owner=rootChunks[i];if(owner!==0xffffffff){if(owner>=counts.length)throw Error('Invalid solid canopy root owner');counts[owner]++;}
  if((i&4095)===0)yield;
 }
 for(const p of manifest.chunks)if(counts[p.id]!==p.rootCount)throw Error('Solid canopy root ownership count mismatch');
 return{manifest,vertices,indices,rootChunks};
}
export function decodeForestCanopy(manifest,streams,forest){
 const iterator=forestCanopyChecks(manifest,streams,forest);let result;do{result=iterator.next();}while(!result.done);return result.value;
}
export async function loadForestCanopy({forest,fetchAsset=fetch,assets=FOREST_CANOPY_ASSETS}){
 const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered solid canopy asset: '+name);const response=await fetchAsset(assets[name]);if(!response.ok)throw Error('Solid canopy asset unavailable: '+name);return response;};
 const manifest=validateForestCanopy(await(await load('manifest.json')).json(),forest);
 if(!globalThis.crypto?.subtle)throw Error('Solid canopy receipts require Web Crypto');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const pairs=await Promise.all(forestCanopyNames.map(async name=>{
  const receipt=manifest.files[name];let bytes=await(await load(receipt.gzip?.file??name)).arrayBuffer();
  if(receipt.gzip){
   if(bytes.byteLength!==receipt.gzip.bytes||await digest(bytes)!==receipt.gzip.sha256)throw Error('Solid canopy encoded digest mismatch');
   if(typeof DecompressionStream!=='function')throw Error('Solid canopy gzip decoding unavailable');
   bytes=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  if(bytes.byteLength!==receipt.bytes||await digest(bytes)!==receipt.sha256)throw Error('Solid canopy decoded digest mismatch');
  return[name,bytes];
 }));
 const iterator=forestCanopyChecks(manifest,Object.fromEntries(pairs),forest);
 for(;;){const result=iterator.next();if(result.done)return result.value;await(globalThis.scheduler?.yield?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0)));}
}
export const FOREST_CANOPY_CULL_WGSL=FRAME_WGSL+/* wgsl */`
struct SolidForestChunk {bound:vec4f,lowError:vec4f,highSampling:vec4f,drawRange:vec4u};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>chunks:array<SolidForestChunk>;
@group(0)@binding(2)var<storage,read_write>commands:array<u32>;
@group(0)@binding(3)var<storage,read_write>selected:array<u32>;
@group(0)@binding(4)var<uniform>policy:vec4f;
@group(0)@binding(5)var<uniform>nativeResidency:vec4u;
@compute @workgroup_size(64)fn forestCanopyCull(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(policy.x)){return;}let p=chunks[id.x];let old=selected[id.x];selected[id.x]=0u;commands[id.x*5u+1u]=0u;
 if(policy.z==1.){return;}
 let relative=p.bound.xyz-F.camPos.xyz;let radius=p.bound.w;let clip=F.viewProj*vec4f(relative,1);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 for(var a=0u;a<2u;a++){
  let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
  if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}
 }
 if(clip.w<-radius*length(rowW)){return;}
 let depth=dot(relative,normalize(F.camFwd.xyz));let near=depth-radius;
 let lateral=sqrt(max(0.,dot(relative,relative)-depth*depth))+radius;let error=p.lowError.w;
 let threshold=policy.y*select(.88,1.,old==1u);
 let projected=F.screen.y/max(2.*length(F.camUp.xyz),.0001)*error*sqrt(1.+lateral*lateral/max(near*near,.0001))/max(near-error,.0001);
 let usable=policy.z==2.||nativeResidency.x==0u||(p.drawRange.w==1u&&near>error&&projected<=threshold);
 if(usable){selected[id.x]=1u;commands[id.x*5u+1u]=1u;}
}
`;
export async function createForestCanopyRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack,mode='auto',pixelError=3}){
 if(!['auto','near','far'].includes(mode)||!(pixelError>0&&pixelError<=3))throw Error('Invalid solid canopy LOD policy');
 const allocated=[],B=GPUBufferUsage,m=pack.manifest;
 const make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error(label+' exceeds device maxBufferSize');const buffer=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});allocated.push(buffer);if(data.byteLength)device.queue.writeBuffer(buffer,0,data);return buffer;};
 try{
  const vertices=make(pack.vertices,B.VERTEX,'forest canopy immutable vertices'),indices=make(pack.indices,B.INDEX,'forest canopy immutable indices');
  const metadata=new ArrayBuffer(m.chunks.length*64),floats=new Float32Array(metadata),words=new Uint32Array(metadata),draws=new Uint32Array(m.chunks.length*5);
  for(const p of m.chunks){const at=p.id*16;floats.set([...p.centre,p.radius,...p.low,p.geometryErrorMetres??0,...p.high,p.sampling.horizontalCellDiagonalMetres],at);
   words.set([p.firstIndex,p.indexCount,p.rootCount,p.geometryErrorSupported===true?1:0],at+12);draws.set([p.indexCount,0,p.firstIndex,0,0],p.id*5);}
  const chunks=make(new Uint8Array(metadata),B.STORAGE,'forest canopy immutable chunks'),commands=make(draws,B.STORAGE|B.INDIRECT,'forest canopy GPU indirect draws');
  const state=make(new Uint32Array(m.chunks.length),B.STORAGE,'forest canopy GPU selected chunks');
  const policy=make(new Float32Array([m.chunks.length,pixelError,['auto','near','far'].indexOf(mode),0]),B.UNIFORM,'forest canopy pixel error policy');
  const nativeResidency=make(new Uint32Array([0,0,0,0]),B.UNIFORM,'forest native residency');
  const code=await shader(FOREST_CANOPY_CULL_WGSL,'forest canopy GPU cull');
  const cull=await device.createComputePipelineAsync({label:'forest canopy cull and LOD',layout:'auto',compute:{module:code,entryPoint:'forestCanopyCull'}});
  const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frameUBO,chunks,commands,state,policy,nativeResidency].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const pipeline=await device.createRenderPipelineAsync({label:'forest canopy opaque closed mass',layout:'auto',vertex:{module,entryPoint:'bakedCanopyVS',buffers:[CANOPY_VERTEX_LAYOUT]},
   fragment:{module,entryPoint:'canopyOpaqueFS',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
   depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:false}});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.filter(([id])=>id<=6).map(([binding,resource])=>({binding,resource}))});
  const bundle=device.createRenderBundleEncoder({label:'forest canopy immutable indirect bundle',colorFormats:[format],depthStencilFormat:'depth32float',sampleCount:samples});
  bundle.setPipeline(pipeline);bundle.setBindGroup(0,group);bundle.setBindGroup(1,clouds.bindVolume(pipeline));bundle.setVertexBuffer(0,vertices);bundle.setIndexBuffer(indices,'uint32');
  for(const p of m.chunks)bundle.drawIndexedIndirect(commands,p.id*20);
  const recorded=[bundle.finish()],stats={loaded:true,chunks:m.chunks.length,sourceRoots:pack.rootChunks.length,mode,pixelError,gpuCulling:true,opaque:true,
   phase:'startup solid preview; error-limited selection begins after native residency',
   selectionMetric:'projected certified opaque crown-union exterior error',geometryErrorSupported:m.chunks.every(p=>p.geometryErrorSupported===true),appearanceErrorSupported:false,
   representation:'Authored solid source-crown union; native leaf alpha is not certified'};
  return{stats,rootChunks:pack.rootChunks,state,nativeResidency,
   encode(pass){pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(Math.ceil(m.chunks.length/64));},
   drawOpaque(pass){pass.executeBundles(recorded);},destroy(){for(const buffer of allocated)buffer.destroy();}};
 }catch(error){for(const buffer of allocated)buffer.destroy();throw error;}
}
