// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Native leaf-density masses. Sampling estimates are authored, not certified
// equivalence to native leaf silhouettes, coverage, pigment or illumination.
import {FRAME_WGSL} from './wgsl/common.js';
import {CANOPY_VERTEX_LAYOUT} from './canopy-scenery.js';

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
const forestMassNames=['vertices.bin','indices.bin','root-chunks.bin'];
const forestMassMiddleNames=['middle-vertices.bin','middle-indices.bin'];
const forestMassStreams=m=>[...forestMassNames,...(m.prototypes?forestMassMiddleNames:[]),...(m.files['root-neighbors.bin']?['root-neighbors.bin']:[])];
const forestMassUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestMassVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const forestMassReceipt=r=>forestMassUint(r?.bytes)&&r.bytes>0&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256);
const forestMassSameReceipt=(a,b)=>forestMassReceipt(a)&&forestMassReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const forestMassUpward=value=>{const n=Math.fround(value);if(n>=value)return n;const bytes=new ArrayBuffer(4),floats=new Float32Array(bytes),words=new Uint32Array(bytes);floats[0]=n;words[0]++;return floats[0];};
const forestMassHalf=bits=>{const sign=bits&0x8000?-1:1,exponent=(bits>>10)&31,mantissa=bits&1023;return exponent===0?sign*mantissa*2**-24:exponent===31?(mantissa?NaN:sign*Infinity):sign*(1+mantissa/1024)*2**(exponent-15);};

export function validateForestMass(m,forest){
 const source=forest?.manifest??forest;
 if(m?.format!=='waterworld.native-forest-mass'||!((m.version===1&&m.vertexStride===52)||(m.version===2&&m.vertexStride===24))||m.units!=='metres'||m.upAxis!=='Y'||
  !forestMassUint(source?.rootCount)||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>65535)throw Error('Unsupported native forest mass');
 for(const [name,stride]of [['vertices.bin',m.vertexStride],['indices.bin',4],['root-chunks.bin',4]]){
  const item=m.files?.[name],encoded=item?.gzip;
  if(!forestMassReceipt(item)||item.bytes%stride||item.bytes>256*1024*1024||!forestMassReceipt(encoded)||encoded.file!==name+'.gz')throw Error('Invalid native forest mass stream receipt: '+name);
 }
 if(m.files['root-chunks.bin'].bytes!==source.rootCount*4)throw Error('Native forest mass owner table length differs from source');
 if(m.files['root-neighbors.bin']){const item=m.files['root-neighbors.bin'];if(!forestMassReceipt(item)||item.bytes!==source.rootCount*16||!forestMassReceipt(item.gzip)||item.gzip.file!=='root-neighbors.bin.gz')throw Error('Invalid native forest mass neighbor receipt');}
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
  for(const [name,stride]of [['middle-vertices.bin',52],['middle-indices.bin',4]]){const item=m.files[name];if(!forestMassReceipt(item)||item.bytes%stride||item.bytes>256*1024*1024||!forestMassReceipt(item.gzip)||item.gzip.file!==name+'.gz')throw Error('Invalid native forest middle stream receipt');}
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
 const packed=compact?new DataView(streams['vertices.bin']):null,vertexCount=streams['vertices.bin'].byteLength/manifest.vertexStride;
 for(let i=0;i<vertexCount;i++){
  if(compact){const at=i*24,x=packed.getFloat32(at,true),y=packed.getFloat32(at+4,true),z=packed.getFloat32(at+8,true),
    nx=Math.max(-1,packed.getInt8(at+12)/127),ny=Math.max(-1,packed.getInt8(at+13)/127),nz=Math.max(-1,packed.getInt8(at+14)/127),
    r=forestMassHalf(packed.getUint16(at+16,true)),g=forestMassHalf(packed.getUint16(at+18,true)),b=forestMassHalf(packed.getUint16(at+20,true)),a=forestMassHalf(packed.getUint16(at+22,true));
   // Quantizing a unit vector to snorm8 changes its component lengths. Check
   // that quantized envelope, then normalize on GPU; never expand the stream.
   if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)||!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)||!Number.isFinite(a)||r<0||g<0||b<0||a<0||a>1||Math.abs(Math.hypot(nx,ny,nz)-1)>.015)throw Error('Invalid packed native forest mass vertex');
  }else{const row=vertices.subarray(i*13,i*13+13);if(!row.every(Number.isFinite)||row[6]!==4||row[7]<0||row[7]>1||row.subarray(10,13).some(v=>v<0)||Math.abs(Math.hypot(...row.subarray(3,6))-1)>.001)throw Error('Invalid native forest mass vertex');}
  if((i&1023)===0)yield;
 }
 for(const p of manifest.chunks)for(let i=p.firstIndex;i<p.firstIndex+p.indexCount;i++){
  const index=indices[i];if(index>=vertexCount)throw Error('Native forest mass index outside geometry');
  for(let k=0;k<3;k++){const coordinate=compact?packed.getFloat32(index*24+k*4,true):vertices[index*13+k];if(coordinate<p.low[k]-.001||coordinate>p.high[k]+.001)throw Error('Native forest mass vertex outside chunk bound');}
  if((i&4095)===0)yield;
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
  for(let i=0;i<middleVertices.length;i+=13){const row=middleVertices.subarray(i,i+13);if(!row.every(Number.isFinite)||![3,4].includes(row[6])||row[7]<0||row[7]>1||row.subarray(10,13).some(v=>v<0)||Math.abs(Math.hypot(...row.subarray(3,6))-1)>.001)throw Error('Invalid native forest middle vertex');if(((i/13)&1023)===0)yield;}
  for(const p of manifest.prototypes)for(let i=p.firstIndex;i<p.firstIndex+p.indexCount;i++){const at=middleIndices[i]*13;if(at>=middleVertices.length)throw Error('Native forest middle index outside geometry');if(p.low)for(let k=0;k<3;k++)if(middleVertices[at+k]<p.low[k]-.001||middleVertices[at+k]>p.high[k]+.001)throw Error('Native forest middle vertex outside prototype');if((i&4095)===0)yield;}
 }
 return{manifest,vertices,indices,rootChunks,rootNeighbors,middleVertices,middleIndices,finiteValidated:true};
}
export function decodeForestMass(manifest,streams,forest){const iterator=forestMassChecks(manifest,streams,forest);let next;do{next=iterator.next();}while(!next.done);return next.value;}
export async function loadForestMass({forest,fetchAsset=fetch,assets=FOREST_MASS_ASSETS}){
 const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered native forest mass asset: '+name);const response=await fetchAsset(assets[name]);if(!response.ok)throw Error('Native forest mass asset unavailable: '+name);return response;};
 const manifest=validateForestMass(await(await load('manifest.json')).json(),forest);
 if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Native forest mass requires verified gzip transport');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const streams=Object.fromEntries(await Promise.all(forestMassStreams(manifest).map(async name=>{
  const item=manifest.files[name],encoded=await(await load(item.gzip.file)).arrayBuffer();
  if(encoded.byteLength!==item.gzip.bytes||await digest(encoded)!==item.gzip.sha256)throw Error('Native forest mass encoded digest mismatch');
  const raw=await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(raw.byteLength!==item.bytes||await digest(raw)!==item.sha256)throw Error('Native forest mass decoded digest mismatch');return[name,raw];
 })));
 const iterator=forestMassChecks(manifest,streams,forest);for(;;){const next=iterator.next();if(next.done)return next.value;await(globalThis.scheduler?.yield?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0)));}
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
 let depth=dot(relative,normalize(F.camFwd.xyz));let near=depth-radius;
 let lateral=sqrt(max(0.,dot(relative,relative)-depth*depth))+radius;let error=item.lowError.w;
 let threshold=forestMassPolicy.y*select(.88,1.,old==1u);
 let pixels=F.screen.y/max(2.*length(F.camUp.xyz),.0001)*error*sqrt(1.+lateral*lateral/max(near*near,.0001))/max(near-error,.0001);
 // E is an authored sampling/support estimate. This projection bounds that
 // footprint, not native leaf appearance. Residency never bypasses it unless
 // the caller explicitly requests the separately labelled startup preview.
 let preview=forestMassPolicy.w==1.&&forestMassNativeResidency.x==0u;
 if(forestMassPolicy.z==2.||preview||(near>error&&pixels<=threshold)){forestMassSelected[id.x]=1u;forestMassCommands[id.x*5u+1u]=1u;}
}
`;

export async function createForestMassRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack,mode='auto',pixelError=3,preview=false}){
 if(!['auto','near','far'].includes(mode)||!(pixelError>0&&pixelError<=3)||typeof preview!=='boolean'||pack.finiteValidated!==true)throw Error('Invalid native forest mass render policy/validation');
 const allocated=[],B=GPUBufferUsage,m=pack.manifest,make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error(label+' exceeds GPU maxBufferSize');const buffer=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});allocated.push(buffer);if(data.byteLength)device.queue.writeBuffer(buffer,0,data);return buffer;};
 try{
  const vertices=make(pack.vertices,B.VERTEX,'forest mass immutable vertices'),indices=make(pack.indices,B.INDEX,'forest mass immutable indices');
  const middle=pack.middleVertices?{vertices:make(pack.middleVertices,B.VERTEX,'forest middle immutable native-derived vertices'),indices:make(pack.middleIndices,B.INDEX,'forest middle immutable native-derived indices'),prototypes:m.prototypes}:null;
  const neighbors=pack.rootNeighbors?make(pack.rootNeighbors,B.STORAGE,'forest mass immutable root neighbors'):null;
  const metadata=new ArrayBuffer(m.chunks.length*64),floats=new Float32Array(metadata),words=new Uint32Array(metadata),draws=new Uint32Array(m.chunks.length*5);
  for(const p of m.chunks){const at=p.id*16,centre=p.centre.map(Math.fround),radius=forestMassUpward(p.radius+Math.hypot(...centre.map((v,k)=>v-p.centre[k])));floats.set([...centre,radius,...p.low,forestMassUpward(p.lodErrorMetres),...p.high,0],at);words.set([p.firstIndex,p.indexCount,p.rootCount,0],at+12);draws.set([p.indexCount,0,p.firstIndex,0,0],p.id*5);}
  const blocks=make(new Uint8Array(metadata),B.STORAGE,'forest mass immutable block bounds'),commands=make(draws,B.STORAGE|B.INDIRECT,'forest mass GPU indirect draws');
  const state=make(new Uint32Array(m.chunks.length),B.STORAGE,'forest mass GPU selected blocks'),policy=make(new Float32Array([m.chunks.length,pixelError,['auto','near','far'].indexOf(mode),preview?1:0]),B.UNIFORM,'forest mass authored pixel error policy');
  const nativeResidency=make(new Uint32Array([0,0,0,0]),B.UNIFORM,'forest mass shared native residency'),code=await shader(FOREST_MASS_CULL_WGSL,'forest mass GPU cull');
  const cull=await device.createComputePipelineAsync({label:'forest mass GPU block selection',layout:'auto',compute:{module:code,entryPoint:'forestMassCull'}});
  const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frameUBO,blocks,commands,state,policy,nativeResidency].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const pipeline=await device.createRenderPipelineAsync({label:'forest mass opaque native density surface',layout:'auto',vertex:{module,entryPoint:m.version===2?'forestMassVS':'bakedCanopyVS',buffers:[m.version===2?FOREST_MASS_VERTEX_LAYOUT:CANOPY_VERTEX_LAYOUT]},fragment:{module,entryPoint:'canopyOpaqueFS',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:false}});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.filter(([id])=>id<=6).map(([binding,resource])=>({binding,resource}))});
  const bundle=device.createRenderBundleEncoder({label:'forest mass immutable indirect bundle',colorFormats:[format],depthStencilFormat:'depth32float',sampleCount:samples});bundle.setPipeline(pipeline);bundle.setBindGroup(0,group);bundle.setBindGroup(1,clouds.bindVolume(pipeline));bundle.setVertexBuffer(0,vertices);bundle.setIndexBuffer(indices,'uint32');for(const p of m.chunks)bundle.drawIndexedIndirect(commands,p.id*20);const recorded=[bundle.finish()];
  const stats={loaded:true,blocks:m.chunks.length,sourceRoots:pack.rootChunks.length,gpuCulling:true,opaque:true,mode,pixelError,preview,finiteValidated:true,sourceReceiptsValidated:true,vertexStride:m.vertexStride,quantization:m.quantization??null,appearanceErrorSupported:false,geometryErrorSupported:false,nativeValidation:m.validation??null,neighborGuard:!!neighbors,middle:{loaded:!!middle,prototypes:middle?.prototypes.length??0,errorQualification:'Authored native sampling/wood-clustering footprint; no appearance certificate'},
   phase:mode==='far'?'forced far debug; pixel threshold bypassed':mode==='near'?'native-only debug; mass disabled':preview?'explicit startup mass preview until native residency':'authored error-limited selection',selectionMetric:'Projected authored leaf-support/sampling footprint; native appearance unqualified',representation:'Continuous surface from original native leaf-area density and source pigment'};
  return{stats,rootChunks:pack.rootChunks,chunks:m.chunks,state,nativeResidency,commands,middle,neighbors,
   encode(pass){pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(Math.ceil(m.chunks.length/64));},drawOpaque(pass){pass.executeBundles(recorded);},destroy(){for(const buffer of allocated)buffer.destroy();}};
 }catch(error){for(const buffer of allocated)buffer.destroy();throw error;}
}
