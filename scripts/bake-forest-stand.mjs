#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
/** One explicit offline native stand witness; never a runtime startup job.
 *
 * node scripts/bake-forest-stand.mjs \
 *   --pack /tmp/waterworld-mature-dense-forest-237 \
 *   --region /Users/alexwall/.codex/worktrees/overnight-models/waterworld/assets/world/saba \
 *   --native-baker /Users/alexwall/dev/forestmodeler/scripts/bake_waterworld_impostors.mjs \
 *   --playwright-module /Users/alexwall/dev/waterworld/node_modules/playwright/index.mjs \
 *   --browser-executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
 *   --x -576 --z -5680 --out /tmp/waterworld-native-stand
 *
 * Original immutable 56B prototype vertices, original detailed wood/leaf
 * triangle membership, native material maps, source root identities and tint.
 * No growth, crown proxy, shell, geometry expansion, alpha union, gap filling,
 * colour substitution or runtime integration. Neighbouring complete native
 * bounds form an explicitly recorded halo. Exact resident terrain hides soil.
 *
 * The reference uses each source material's MASK cutoff against LOD0 alpha at
 * actual geometric samples. A4096px MSAA4 reference precedes GPU8x area
 * filtering to512px (256samples/output pixel). It does NOT use correlated ordered
 * coverage approximation. Source alpha, depth and silhouettes are retained;
 * no global image-error claim follows from these finite view witnesses.
 */
import {access,mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {ISLAND,decodeIsland,islandGeometry} from '../js/terrain-model.js';
import {loadTerrainNear,sampleTerrainNear,terrainNearGeometry} from '../js/terrain-near.js';

const sha=x=>createHash('sha256').update(x).digest('hex');
const receipt=x=>({bytes:x.byteLength,sha256:sha(x)});
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
export function parseStandArguments(argv){
 const options={x:-576,z:-5680,span:128,tile:512,referenceTile:4096,timeout:1_800_000,multiview:false};
 const names={'--pack':'pack','--region':'region','--out':'out','--native-baker':'nativeBaker','--playwright-module':'playwrightModule','--browser-executable':'browserExecutable','--x':'x','--z':'z','--tile-pixels':'tile','--reference-pixels':'referenceTile','--timeout-ms':'timeout','--mass':'mass'};
 for(let i=0;i<argv.length;i++){if(argv[i]==='--help'){options.help=true;continue;}if(argv[i]==='--multiview'){options.multiview=true;continue;}const key=names[argv[i]];requireValue(key&&i+1<argv.length,'Unknown or incomplete argument: '+argv[i]);options[key]=argv[++i];}
 if(options.help)return options;
 for(const name of ['pack','region','out','nativeBaker','playwrightModule'])requireValue(options[name],'Missing '+name);
 for(const name of ['x','z','tile','referenceTile','timeout']){options[name]=Number(options[name]);requireValue(Number.isFinite(options[name]),'Nonfinite '+name);}
 requireValue(options.tile===512&&options.referenceTile===4096,'First native witness requires4096px capture and512px downfilter');
 requireValue(Number.isSafeInteger(options.timeout)&&options.timeout>=10000&&options.timeout<=3_600_000,'Timeout must be10 seconds through60 minutes');return options;
}

export function standView(azimuth,elevation,index){
 const a=azimuth*Math.PI/180,e=elevation*Math.PI/180,direction=[Math.sin(a)*Math.cos(e),Math.sin(e),Math.cos(a)*Math.cos(e)];
 const reference=Math.abs(direction[1])>.999?[0,0,1]:[0,1,0],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const r=cross(reference,direction),right=r.map(v=>v/Math.hypot(...r)),up=cross(direction,right);return{index,azimuthDegrees:azimuth,elevationDegrees:elevation,direction,right,up};
}
async function readGround(folder){
 const files=new Map(),records={};
 const load=async name=>{requireValue(!name.includes('..')&&!name.startsWith('/'),'Unsafe terrain path');const raw=await readFile(join(folder,name));files.set(name,raw);records[name]=receipt(raw);return raw;};
 const raw=await load('manifest.json'),manifest=JSON.parse(raw),height=await load('height.bin');
 requireValue(manifest.id==='saba'&&manifest.gridSize===ISLAND.size&&manifest.spanMetres===ISLAND.span&&manifest.localOrigin.x===ISLAND.x&&manifest.localOrigin.z===ISLAND.z,'Stand terrain does not match production Saba domain');
 requireValue(sha(height)===manifest.heightSHA256,'Coarse terrain digest mismatch');
 const heights=decodeIsland(height.buffer.slice(height.byteOffset,height.byteOffset+height.byteLength));
 const near=await loadTerrainNear({baseManifest:manifest,baseHeights:heights,fetchAsset:async path=>new Response(await load(path.replace(/^assets\/world\/saba\//,'')))});
 const sample=(x,z)=>sampleTerrainNear(near,heights,x,z),nearHeights=near?.heights??new Float32Array(0);
 const joined=new Float32Array(heights.length+nearHeights.length);joined.set(heights);joined.set(nearHeights,heights.length);
 const coarseMesh=islandGeometry(heights,near?.bounds),fineMesh=near?terrainNearGeometry(near,coarseMesh):null;
 return{sample,records,files,meshes:[coarseMesh,...(fineMesh?[fineMesh]:[])],heights:joined,coarse:[ISLAND.x,ISLAND.z,ISLAND.span,ISLAND.size],near:near?[near.bounds[0],near.bounds[2],near.manifest.domain.spacing,near.manifest.domain.size]:[0,0,1,0],nearOffset:heights.length};
}
export function seatStandRoots(manifest,source,sample){
 requireValue(source instanceof Float32Array&&source.length===manifest.rootCount*12,'Incomplete source roots');const rooted=source.slice(),excluded=[];
 for(let i=0;i<rooted.length;i+=12){const x=rooted[i],z=rooted[i+2],height=sample(x,z),slope=Math.hypot((sample(x+1,z)-sample(x-1,z))*.5,(sample(x,z+1)-sample(x,z-1))*.5);
  if(rooted[i+3]<=0||height<18||height>840||!Number.isFinite(slope)||slope>1.1){rooted[i+3]=0;excluded.push(i/12);continue;}
  const prototype=manifest.prototypes[rooted[i+8]];requireValue(prototype,'Unknown root prototype');rooted[i+9]=Math.max(rooted[i+9],(prototype.basalRadius??0)*rooted[i+3]*slope+.08);rooted[i+1]=height-rooted[i+9];
 }return{rooted,excluded};
}
function rootBounds(prototype,row){
 const support=prototype.captureSupport.coverageBounds,low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],c=Math.cos(row[4]),s=Math.sin(row[4]);
 for(let bits=0;bits<8;bits++){const q=support.low.map((v,k)=>(bits&(1<<k)?support.high[k]:v)*row[3]),p=[row[0]+c*q[0]-s*q[2],row[1]+q[1],row[2]+s*q[0]+c*q[2]];
  for(let k=0;k<3;k++){low[k]=Math.min(low[k],p[k]);high[k]=Math.max(high[k],p[k]);}}
 return{low,high};
}
export function selectStand(manifest,prototypes,roots,{x,z,span=128}){
 const nominal=[x-span/2,x+span/2,z-span/2,z+span/2],byID=new Map(prototypes.map(p=>[p.id,p])),owners=[],bounds=new Map();
 for(let i=0;i<roots.length;i+=12)if(roots[i+3]>0&&roots[i]>=nominal[0]&&roots[i]<nominal[1]&&roots[i+2]>=nominal[2]&&roots[i+2]<nominal[3])owners.push(i/12);
 requireValue(owners.length>0,'Selected128m stand has no resident source owners');
 const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],extend=b=>{for(let k=0;k<3;k++){low[k]=Math.min(low[k],b.low[k]);high[k]=Math.max(high[k],b.high[k]);}};
 for(const id of owners){const row=roots.subarray(id*12,id*12+12),b=rootBounds(byID.get(row[8]),row);bounds.set(id,b);extend(b);}
 const ownerBounds={low:low.slice(),high:high.slice()},ownerSet=new Set(owners),halo=[];
 for(let id=0;id<manifest.rootCount;id++)if(!ownerSet.has(id)&&roots[id*12+3]>0){const row=roots.subarray(id*12,id*12+12),b=rootBounds(byID.get(row[8]),row);
  if(b.high[0]>=ownerBounds.low[0]&&b.low[0]<=ownerBounds.high[0]&&b.high[2]>=ownerBounds.low[2]&&b.low[2]<=ownerBounds.high[2]){halo.push(id);bounds.set(id,b);}}
 const ids=[...owners,...halo].sort((a,b)=>roots[a*12+8]-roots[b*12+8]||a-b);requireValue(ids.length<=2048,'Native stand exceeds explicit2048-root budget; no truncation');
 for(const id of halo)extend(bounds.get(id));
 const instanceRows=new Float32Array(ids.length*12),ranges=[];let instanceCount=0,triangles=0;
 for(const p of prototypes){const selected=ids.filter(id=>roots[id*12+8]===p.id);if(!selected.length)continue;
  ranges.push({prototype:p.id,firstInstance:instanceCount,instanceCount:selected.length,wood:{...p.wood},leaf:{...p.leaf}});triangles+=selected.length*(p.wood.indexCount+p.leaf.indexCount)/3;
  for(const id of selected){instanceRows.set(roots.subarray(id*12,id*12+12),instanceCount++*12);}}
 requireValue(triangles<=1_000_000_000,'Native stand exceeds explicit one-billion triangles/view safety budget; no approximation');
 return{nominal,owners,halo,ids,ownerBounds,low,high,centre:low.map((v,k)=>(v+high[k])*.5),radius:Math.hypot(...high.map((v,k)=>(v-low[k])*.5)),instanceRows,ranges,triangles};
}
export function nativeStandShader(source){
 const replace=(from,to)=>{requireValue(source.includes(from),'Shared native shader changed: '+from.slice(0,64));source=source.replace(from,to);};
 replace('@location(3) @interpolate(perspective,sample) colour:vec3f,','@location(3) @interpolate(perspective,sample) colour:vec3f,\n @location(4) @interpolate(flat) sourceGround:f32,');
 replace('struct Camera {centreExtent:vec4f,direction:vec4f,right:vec4f,up:vec4f,controls:vec4f};','struct Camera {centreExtent:vec4f,direction:vec4f,right:vec4f,up:vec4f,controls:vec4f,anchor:vec4f,coarse:vec4f,nearDomain:vec4f};');
 replace('@group(0) @binding(0) var<uniform> C:Camera;',`@group(0) @binding(0) var<uniform> C:Camera;
struct Root {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
@group(0) @binding(1) var<storage,read> standRoots:array<Root>;
@group(0) @binding(2) var<storage,read> terrainHeights:array<f32>;
fn standTriangleHeight(u:f32,v:f32,n:u32,offset:u32)->f32{
 let i=min(n-2u,u32(floor(u)));let j=min(n-2u,u32(floor(v)));let a=u-f32(i);let b=v-f32(j);let k=offset+j*n+i;
 if(a+b<=1.){return terrainHeights[k]+a*(terrainHeights[k+1u]-terrainHeights[k])+b*(terrainHeights[k+n]-terrainHeights[k]);}
 return terrainHeights[k+n+1u]+(1.-a)*(terrainHeights[k+n]-terrainHeights[k+n+1u])+(1.-b)*(terrainHeights[k+1u]-terrainHeights[k+n+1u]);
}
fn standGround(local:vec2f)->f32{
 let world=local+C.anchor.xz;let q=(world-C.nearDomain.xy)/C.nearDomain.z;let n=u32(C.nearDomain.w);
 if(n>0u&&all(q>=vec2f(0))&&all(q<=vec2f(f32(n-1u)))){return standTriangleHeight(q.x,q.y,n,u32(C.anchor.w))-C.anchor.y;}
 let uv=(world-C.coarse.xy+vec2f(C.coarse.z*.5))*(C.coarse.w-1.)/C.coarse.z;let count=u32(C.coarse.w);
 if(any(uv<vec2f(0))||any(uv>=vec2f(f32(count-1u)))){return -120.-C.anchor.y;}
 return standTriangleHeight(uv.x,uv.y,count,0u)-C.anchor.y;
}`);
 const start=source.indexOf('@vertex fn vs('),end=source.indexOf('struct Output',start);requireValue(start>=0&&end>start,'Missing shared native vertex entry');
 source=source.slice(0,start)+`@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kindShade:vec2f,
 @location(3) uv:vec2f,@location(4) colour:vec3f,@location(5) nativeMaterial:f32,@builtin(instance_index) instance:u32)->V{
 let root=standRoots[instance];let c=cos(root.yawColour.x);let s=sin(root.yawColour.x);let q=position*root.rootScale.w;
 let local=root.rootScale.xyz-C.anchor.xyz+vec3f(c*q.x-s*q.z,q.y,s*q.x+c*q.z);
 let relative=local-C.centreExtent.xyz;let extent=C.centreExtent.w;var o:V;
 o.pixel=vec4f(dot(relative,C.right.xyz)/extent,dot(relative,C.up.xyz)/extent,.5-dot(relative,C.direction.xyz)/(2.*extent),1);
 o.local=local;o.normal=vec3f(c*normal.x-s*normal.z,normal.y,s*normal.x+c*normal.z);o.uv=uv;o.colour=colour*root.yawColour.yzw;o.sourceGround=root.rootScale.y-C.anchor.y;return o;
}
`+source.slice(end);
 replace('if(in.local.y<C.controls.y){discard;}',`if(in.local.y<max(standGround(in.local.xz),in.sourceGround)){discard;}
 if(C.controls.y>C.controls.x&&(in.local.x<C.controls.x||in.local.x>C.controls.y||in.local.z<C.controls.z||in.local.z>C.controls.w)){discard;}`);
 const alphaStart=source.indexOf(' if(leaf){'),alphaEnd=source.indexOf('\n var n=normalize(in.normal)',alphaStart);requireValue(alphaStart>=0&&alphaEnd>alphaStart,'Missing shared native coverage block');
 source=source.slice(0,alphaStart)+` // Source MASK evaluated before minification: physical LOD0 samples,
 // supersampled in space. No screen-only stochastic/correlated coverage.
 if(leaf&&textureSampleLevel(pigmentMap,materialSampler,in.uv,0.).a<M.underside.w){discard;}
`+source.slice(alphaEnd);
 return source+`
@vertex fn terrainVS(@location(0) position:vec3f)->@builtin(position)vec4f{
 let relative=position-C.anchor.xyz-C.centreExtent.xyz;let extent=C.centreExtent.w;
 return vec4f(dot(relative,C.right.xyz)/extent,dot(relative,C.up.xyz)/extent,.5-dot(relative,C.direction.xyz)/(2.*extent),1);
}
@fragment fn terrainFS()->Output{var o:Output;o.albedo=vec4f(0);o.normalDepth=vec4f(0);return o;}
@vertex fn massVS(@location(0)position:vec3f,@location(1)normal:vec3f,@location(2)kindShade:vec2f,@location(3)uv:vec2f,@location(4)colour:vec3f)->V{
 let local=position-C.anchor.xyz;let relative=local-C.centreExtent.xyz;let extent=C.centreExtent.w;var o:V;
 o.pixel=vec4f(dot(relative,C.right.xyz)/extent,dot(relative,C.up.xyz)/extent,.5-dot(relative,C.direction.xyz)/(2.*extent),1);
 o.local=local;o.normal=normal;o.uv=uv;o.colour=colour;return o;
}
@fragment fn massFS(in:V)->Output{
 if(in.local.y<standGround(in.local.xz)){discard;}
 var o:Output;o.albedo=vec4f(in.colour,1);o.normalDepth=vec4f(normalize(in.normal),in.pixel.z);return o;
}
`;
}

// Self-contained because Playwright serializes this function. Node verifies
// every served source byte; GPU triangle grouping validates exact membership.
async function initialiseStandGPU({base,prototypes,stand,shader,mipShader,ground,anchor,mass=false}){
 const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('Real WebGPU adapter required');
 const info=adapter.info??{},adapterInfo=Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,info[k]??'']));
 if(adapter.isFallbackAdapter||/swiftshader|llvmpipe|lavapipe/i.test(JSON.stringify(adapterInfo)))throw Error('Software GPU refused');
 const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);const B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage;
 const get=async name=>{const r=await fetch(base+'/asset/'+encodeURIComponent(name));if(!r.ok)throw Error('Source unavailable: '+name);return r;};
 const make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error('Source exceeds GPU maxBufferSize');const b=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
 const geometry=await(await get('vertices.bin')).arrayBuffer(),indexBytes=await(await get('indices.bin')).arrayBuffer(),sourceVertices=new Float32Array(geometry),sourceIndices=new Uint32Array(indexBytes);
 const vertices=make(geometry,B.VERTEX,'Original native56B source vertices'),roots=make(await(await get('__stand-roots.bin')).arrayBuffer(),B.STORAGE,'Actual resident stand root instances');
 const heights=make(await(await get('__terrain.bin')).arrayBuffer(),B.STORAGE,'Exact source resident terrain triangles');
 const compile=async code=>{const m=device.createShaderModule({code});const bad=(await m.getCompilationInfo()).messages.filter(x=>x.type==='error');if(bad.length)throw Error(bad.map(x=>x.message).join('\n'));return m;};
 const module=await compile(shader),mip=await compile(mipShader),cameraLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform',minBindingSize:128}},...[1,2].map(binding=>({binding,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'read-only-storage'}}))]});
 const materialLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.FRAGMENT,buffer:{type:'uniform',minBindingSize:32}},{binding:1,visibility:S.FRAGMENT,sampler:{}},...[2,3].map(binding=>({binding,visibility:S.FRAGMENT,texture:{}}))]});
 const layout=device.createPipelineLayout({bindGroupLayouts:[cameraLayout,materialLayout]}),attributes=[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x2'},{shaderLocation:4,offset:40,format:'float32x3'},{shaderLocation:5,offset:52,format:'float32'}];
 const pipeline=leaf=>device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'vs',buffers:[{arrayStride:56,attributes}]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float'},{format:'rgba16float'}]},primitive:{topology:'triangle-list',cullMode:leaf?'none':'back'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'},multisample:{count:4}});
 const wood=await pipeline(false),leaf=await pipeline(true),average=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:mip,entryPoint:'vs'},fragment:{module:mip,entryPoint:'fs',targets:[{format:'rgba16float'}]}});
 const massPipeline=mass?await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'massVS',buffers:[{arrayStride:52,attributes:attributes.slice(0,5)}]},fragment:{module,entryPoint:'massFS',targets:[{format:'rgba16float'},{format:'rgba16float'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'},multisample:{count:4}}):null;
 const terrainPipeline=await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'terrainVS',buffers:[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment:{module,entryPoint:'terrainFS',targets:[{format:'rgba16float',writeMask:0},{format:'rgba16float',writeMask:0}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'},multisample:{count:4}});
 const owned=[vertices,roots,heights],draws=[],materials=new Map(),terrainMeshes=[];for(let i=0;i<ground.meshes;i++){const v=make(await(await get('__terrain-'+i+'-vertices.bin')).arrayBuffer(),B.VERTEX,'Unchanged resident terrain vertices'),ids=make(await(await get('__terrain-'+i+'-indices.bin')).arrayBuffer(),B.INDEX,'Unchanged resident terrain indices');owned.push(v,ids);terrainMeshes.push({vertices:v,indices:ids,count:ids.size/4});}
 const massVertices=mass?make(await(await get('__mass-vertices.bin')).arrayBuffer(),B.VERTEX,'Actual leaf-field forest mass'):null,massIndices=mass?make(await(await get('__mass-indices.bin')).arrayBuffer(),B.INDEX,'Actual leaf-field forest mass indices'):null;if(mass)owned.push(massVertices,massIndices);
 const toLinear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
 const image=async map=>{const bitmap=await createImageBitmap(await(await get(map.file)).blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none',imageOrientation:'none'});if(bitmap.width!==map.width||bitmap.height!==map.height)throw Error('Native map dimensions differ');
  const texture=device.createTexture({label:map.file,size:[bitmap.width,bitmap.height],format:map.encoding==='srgb'?'rgba8unorm-srgb':'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST|T.RENDER_ATTACHMENT});owned.push(texture);device.queue.copyExternalImageToTexture({source:bitmap},{texture,premultipliedAlpha:false},[bitmap.width,bitmap.height]);bitmap.close();return texture;};
 for(const range of stand.ranges){const p=prototypes.find(p=>p.id===range.prototype);if(!p)throw Error('Unknown native prototype');
  for(const m of p.nativeMaterials){const albedo=await image(m.albedo),normal=await image(m.normal),state=make(new Float32Array([m.underside,m.name.startsWith('foliage_')?1:0,m.roughness,m.transmission,...m.undersideReference.map(toLinear),m.opacityThreshold]),B.UNIFORM,'Original native material controls');owned.push(state);
   materials.set(p.id+':'+m.index,{leaf:m.name.startsWith('foliage_'),group:device.createBindGroup({layout:materialLayout,entries:[{binding:0,resource:{buffer:state}},{binding:1,resource:device.createSampler({addressModeU:m.wrap==='repeat'?'repeat':'clamp-to-edge',addressModeV:m.wrap==='repeat'?'repeat':'clamp-to-edge',magFilter:'linear',minFilter:'linear'})},{binding:2,resource:albedo.createView()},{binding:3,resource:normal.createView()}]})});}
  const grouped=new Map();
  for(const kind of ['wood','leaf'])for(let at=range[kind].firstIndex;at<range[kind].firstIndex+range[kind].indexCount;at+=3){const triangle=sourceIndices.subarray(at,at+3),slot=sourceVertices[triangle[0]*14+13],m=materials.get(p.id+':'+slot);if(!m||!Number.isInteger(slot)||m.leaf!==(kind==='leaf'))throw Error('Invalid source native material');
   for(const id of triangle){const v=sourceVertices.subarray(id*14,id*14+14);if(v.length!==14||!v.every(Number.isFinite)||v[13]!==slot||(kind==='wood'?v[6]!==3:v[6]<4))throw Error('Source triangle not detailed native geometry');}
   if(!grouped.has(slot))grouped.set(slot,[]);grouped.get(slot).push(...triangle);}
  for(const [slot,ids]of grouped){const index=make(new Uint32Array(ids),B.INDEX,'Exact native material triangle membership');owned.push(index);draws.push({prototype:p.id,slot,index,indexCount:ids.length,firstInstance:range.firstInstance,instanceCount:range.instanceCount,...materials.get(p.id+':'+slot)});}
 }
 const half=(view,at)=>{const h=view.getUint16(at,true),s=h&32768?-1:1,e=(h>>10)&31,m=h&1023;return e===0?s*m*2**-24:e===31?(m?NaN:s*Infinity):s*(1+m/1024)*2**(e-15);};
 const png=async(data,width,height,normalData=null)=>{const src=new DataView(data.buffer,data.byteOffset,data.byteLength),surface=normalData?new DataView(normalData.buffer,normalData.byteOffset,normalData.byteLength):null,pixels=new Uint8ClampedArray(width*height*4),encode=x=>x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055;
  for(let i=0;i<width*height;i++){const a=half(src,i*8+6);pixels[i*4+3]=Math.round(Math.max(0,Math.min(1,a))*255);let shade=1;
   if(surface&&a>0){const n=[0,1,2].map(k=>half(surface,i*8+k*2)/a),l=Math.hypot(...n);shade=.35+.65*Math.max(0,(n[0]*.4+n[1]*.7+n[2]*.6)/(l*Math.hypot(.4,.7,.6)));}
   for(let k=0;k<3;k++)pixels[i*4+k]=Math.round(Math.max(0,Math.min(1,encode(Math.max(0,half(src,i*8+k*2)/Math.max(a,1e-8))*shade)))*255);}
  const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d');context.putImageData(new ImageData(pixels,width,height),0,0);return new Uint8Array(await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer());};
 const renderOne=async(view,tile,keepReference=false,representation='native')=>{const size=4096;if(size>device.limits.maxTextureDimension2D)throw Error('4096px reference exceeds device texture limit');
  const texture=(format,sampleCount=1)=>device.createTexture({size:[size,size],format,sampleCount,usage:T.RENDER_ATTACHMENT|(sampleCount===1?T.TEXTURE_BINDING|T.COPY_SRC:0)}),targets=[texture('rgba16float'),texture('rgba16float')],ms=[texture('rgba16float',4),texture('rgba16float',4)],depth=texture('depth32float',4),filtered=[],intermediate=[];
  const frame=new Float32Array(32),extent=stand.radius*tile/(tile-4);
  frame.set([...stand.centre.map((v,k)=>v-anchor[k]),extent]);frame.set(view.direction,4);frame.set(view.right,8);frame.set(view.up,12);if(mass)frame.set([stand.nominal[0]-anchor[0],stand.nominal[1]-anchor[0],stand.nominal[2]-anchor[2],stand.nominal[3]-anchor[2]],16);frame.set([...anchor,ground.nearOffset],20);frame.set(ground.coarse,24);frame.set(ground.near,28);
  const camera=make(frame,B.UNIFORM,'Immutable actual stand camera'),encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:targets.map((target,i)=>({view:ms[i].createView(),resolveTarget:target.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]})),depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});
  pass.setBindGroup(0,device.createBindGroup({layout:cameraLayout,entries:[{binding:0,resource:{buffer:camera}},{binding:1,resource:{buffer:roots}},{binding:2,resource:{buffer:heights}}]}));pass.setBindGroup(1,draws[0].group);
  // Actual resident terrain writes depth only. It cannot add ground pigment or
  // alpha to the forest channels, and it occludes roots on sloping terrain.
  pass.setPipeline(terrainPipeline);for(const mesh of terrainMeshes){pass.setVertexBuffer(0,mesh.vertices);pass.setIndexBuffer(mesh.indices,'uint32');pass.drawIndexed(mesh.count);}
  pass.setVertexBuffer(0,vertices);
  if(representation==='mass'){if(!massPipeline)throw Error('Mass comparison not configured');pass.setPipeline(massPipeline);pass.setVertexBuffer(0,massVertices);pass.setIndexBuffer(massIndices,'uint32');pass.drawIndexed(massIndices.size/4);}
  else for(const d of draws){pass.setPipeline(d.leaf?leaf:wood);pass.setBindGroup(1,d.group);pass.setIndexBuffer(d.index,'uint32');pass.drawIndexed(d.indexCount,d.instanceCount,0,0,d.firstInstance);}pass.end();
  for(let i=0;i<2;i++){let source=targets[i];for(let n=size/2;n>=tile;n/=2){const target=device.createTexture({size:[n,n],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC});intermediate.push(target);const p=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});p.setPipeline(average);p.setBindGroup(0,device.createBindGroup({layout:average.getBindGroupLayout(0),entries:[{binding:0,resource:source.createView()}]}));p.draw(3);p.end();source=target;}filtered.push(source);}
  const readTextures=[...filtered,...(keepReference?targets:[])],reads=readTextures.map((texture,i)=>{const n=i<2?tile:size,r=device.createBuffer({size:n*n*8,usage:B.COPY_DST|B.MAP_READ});encoder.copyTextureToBuffer({texture},{buffer:r,bytesPerRow:n*8},[n,n]);return r;});
  device.queue.submit([encoder.finish()]);const all=[];try{for(const r of reads){await r.mapAsync(GPUMapMode.READ);all.push(new Uint8Array(r.getMappedRange()).slice());r.unmap();}}finally{for(const resource of [...targets,...ms,depth,...intermediate,...reads,camera])resource.destroy();}
  if(errors.length)throw Error(errors.join('\n'));return{data:all.slice(0,2),reference:all.slice(2),extent};};
 const upload=async(name,bytes)=>{
  let result;const part=4*1024*1024;
  for(let offset=0;offset<bytes.byteLength;offset+=part){
   const r=await fetch(base+'/result/'+name+'?offset='+offset+'&total='+bytes.byteLength,{method:'POST',body:bytes.subarray(offset,Math.min(bytes.byteLength,offset+part))});
   if(!r.ok)throw Error(await r.text());result=await r.json();
  }
  return result;
 };
 const publish=async(name,data,width,height,views,tile)=>{let covered=0;const values=data.map(b=>new DataView(b.buffer));for(let i=0;i<width*height;i++){const a=half(values[0],i*8+6);if(!Number.isFinite(a)||a<0||a>1)throw Error('Invalid stand coverage');if(a>0)covered++;for(let c=0;c<2;c++)for(let k=0;k<4;k++)if(!Number.isFinite(half(values[c],i*8+k*2)))throw Error('Nonfinite stand capture');}
  if(!covered)throw Error('Empty native stand witness');return{tilePixels:tile,atlasPixels:[width,height],views,coveredPixels:covered,outputs:{albedo:await upload(name+'-albedo',data[0]),normalDepth:await upload(name+'-normal-depth',data[1]),png:await upload(name+'-png',await png(data[0],width,height,data[1]))}};};
 globalThis.__nativeStand={async capture(name,views,tile,columns,keepReference=false,representation='native'){const rows=Math.ceil(views.length/columns),width=columns*tile,height=rows*tile,combined=[new Uint8Array(width*height*8),new Uint8Array(width*height*8)],perView=[];let reference=null;
  for(let i=0;i<views.length;i++){const rendered=await renderOne(views[i],tile,keepReference&&i===0,representation),v={...views[i],column:i%columns,row:Math.floor(i/columns),extent:rendered.extent,capturePixels:4096,captureWorldMetresPerPixel:2*rendered.extent/4096,finalWorldMetresPerPixel:2*rendered.extent/tile};for(let channel=0;channel<2;channel++)for(let y=0;y<tile;y++)combined[channel].set(rendered.data[channel].subarray(y*tile*8,(y+1)*tile*8),((Math.floor(i/columns)*tile+y)*width+i%columns*tile)*8);perView.push(v);
   if(keepReference&&i===0)reference=await publish('reference',rendered.reference,4096,4096,[{...v,column:0,row:0,finalWorldMetresPerPixel:2*rendered.extent/4096}],4096);}
  return{capture:await publish(name,combined,width,height,perView,tile),reference};
 },async close(){await device.queue.onSubmittedWorkDone();for(const resource of owned)resource.destroy();device.destroy();}};
 return{adapterInfo,materialDraws:draws.map(({prototype,slot,indexCount,firstInstance,instanceCount})=>({prototype,nativeMaterial:slot,indexCount,firstInstance,instanceCount})),limits:{maxBufferSize:device.limits.maxBufferSize}};
}

export async function main(argv=process.argv.slice(2)){
 const options=parseStandArguments(argv);if(options.help){console.log('See scripts/bake-forest-stand.mjs source header. Required: --pack --region --out --native-baker --playwright-module. One128m source stand; default centre(-576,-5680).');return;}
 const out=resolve(options.out);requireValue(!await exists(out),'Fresh output required');
 const bakerPath=resolve(options.nativeBaker),bakerSource=await readFile(bakerPath),shared=await import(pathToFileURL(bakerPath).href);
 requireValue(typeof shared.readPack==='function'&&typeof shared.BAKE_WGSL==='string'&&typeof shared.MIP_WGSL==='string','Native baker requires named readPack/BAKE_WGSL/MIP_WGSL exports');
 const input=await shared.readPack(options.pack,null),ground=await readGround(resolve(options.region)),rootBytes=input.files.get('roots.bin'),sourceRoots=new Float32Array(rootBytes.buffer.slice(rootBytes.byteOffset,rootBytes.byteOffset+rootBytes.byteLength));
 const {rooted,excluded}=seatStandRoots(input.manifest,sourceRoots,ground.sample),stand=selectStand(input.manifest,input.prototypes,rooted,options),anchor=[options.x,ground.sample(options.x,options.z),options.z];
 const sourceIndices=new Uint32Array(input.files.get('indices.bin').buffer.slice(input.files.get('indices.bin').byteOffset,input.files.get('indices.bin').byteOffset+input.files.get('indices.bin').byteLength));
 const drawReceipts=stand.ranges.map(range=>({...range,woodIndices:receipt(sourceIndices.subarray(range.wood.firstIndex,range.wood.firstIndex+range.wood.indexCount)),leafIndices:receipt(sourceIndices.subarray(range.leaf.firstIndex,range.leaf.firstIndex+range.leaf.indexCount))}));
 const captureViews=options.multiview?[-30,0,30,60].flatMap(elevation=>[0,90,180,270].map(azimuth=>standView(azimuth,elevation,0))).map((v,index)=>({...v,index})):[standView(225,-10,0)];
 const heldOutViews=[-15,50].flatMap(elevation=>[22.5,112.5,202.5,292.5].map(azimuth=>standView(azimuth,elevation,0))).map((v,index)=>({...v,index}));
 const shader=nativeStandShader(shared.BAKE_WGSL),staging=out+'.baking-'+randomUUID();await mkdir(staging,{recursive:true});
 const files=new Map(input.files);files.set('__stand-roots.bin',Buffer.from(stand.instanceRows.buffer));files.set('__terrain.bin',Buffer.from(ground.heights.buffer));
 let massSource=null;
 if(options.mass){
  const folder=resolve(options.mass),raw=await readFile(join(folder,'manifest.json')),m=JSON.parse(raw);requireValue(m.format==='waterworld.native-forest-mass'&&m.chunks.length===1,'Comparison requires one native-field witness mass');
  requireValue(m.chunks[0].nominalBoundsXZ.every((v,k)=>v===stand.nominal[k]),'Mass/native stand bounds differ');
  for(const name of ['vertices.bin','indices.bin','roots.bin'])requireValue(m.source.files[name].sha256===input.manifest.files[name].sha256,'Mass/native original source differs');
  for(const name of ['vertices.bin','indices.bin']){const r=m.files[name],encoded=await readFile(join(folder,r.gzip.file));requireValue(sha(encoded)===r.gzip.sha256,'Mass encoded digest differs');let bytes=gunzipSync(encoded);requireValue(bytes.length===r.bytes&&sha(bytes)===r.sha256,'Mass decoded digest differs');
   if(name==='vertices.bin'&&m.version===2){
    requireValue(m.vertexStride===24&&bytes.length%24===0,'Invalid compact witness vertices');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),rows=new Float32Array(bytes.length/24*13);
    const half=u=>{const sign=u&32768?-1:1,e=u>>10&31,f=u&1023;return e===0?sign*f*2**-24:e===31?(f?NaN:sign*Infinity):sign*(1+f/1024)*2**(e-15);};
    for(let i=0;i<bytes.length/24;i++){for(let k=0;k<3;k++){rows[i*13+k]=v.getFloat32(i*24+k*4,true);rows[i*13+3+k]=v.getInt8(i*24+12+k)/127;rows[i*13+10+k]=half(v.getUint16(i*24+16+k*2,true));}rows[i*13+6]=4;rows[i*13+7]=.8;}
    bytes=Buffer.from(rows.buffer); // Offline comparison transport only; runtime uploads the compact bytes directly.
   }files.set('__mass-'+name,bytes);}
  massSource={manifest:receipt(raw),source:m.source,files:m.files};
 }
 for(const [i,mesh]of ground.meshes.entries())for(const kind of ['vertices','indices'])files.set('__terrain-'+i+'-'+kind+'.bin',Buffer.from(mesh[kind].buffer,mesh[kind].byteOffset,mesh[kind].byteLength));
 const columns=options.multiview?4:1,outputs=new Map(),targets=new Map(),outputLayouts=[['capture',captureViews.length,options.tile,columns],['reference',1,options.referenceTile,1],...(options.multiview?[['validation',heldOutViews.length,options.tile,4]]:[]),...(massSource?[['mass',captureViews.length,options.tile,columns],...(options.multiview?[['mass-validation',heldOutViews.length,options.tile,4]]:[])]:[])];
 for(const [name,count,tile,cols]of outputLayouts)for(const kind of ['albedo','normal-depth','png'])targets.set(name+'-'+kind,{file:name+'-'+kind+(kind==='png'?'.png':'.rgba16f.bin'),bytes:kind==='png'?null:Math.ceil(count/cols)*cols*tile*tile*8});
 const partial=new Map(),token='/'+randomUUID(),server=createServer(async(req,res)=>{try{const requestURL=new URL(req.url,'http://localhost'),path=requestURL.pathname;
  if(req.method==='GET'&&path===token+'/bake'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'"});res.end('<!doctype html><title>Actual native forest stand</title>');return;}
  if(req.method==='GET'&&path.startsWith(token+'/asset/')){const name=decodeURIComponent(path.slice((token+'/asset/').length));requireValue(files.has(name),'Unverified source request');const bytes=files.get(name);res.writeHead(200,{'Content-Type':name.endsWith('.png')?'image/png':'application/octet-stream'});res.end(bytes);return;}
  if(req.method==='POST'&&path.startsWith(token+'/result/')){const name=path.slice((token+'/result/').length),target=targets.get(name);requireValue(target&&!outputs.has(name),'Unknown/repeated output');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.byteLength;requireValue(size<=(target.bytes??64*1024*1024),'Oversized output');chunks.push(chunk);}const total=Number(requestURL.searchParams.get('total')),offset=Number(requestURL.searchParams.get('offset'));
   requireValue(Number.isSafeInteger(total)&&total>0&&total<=(target.bytes??64*1024*1024)&&(target.bytes===null||total===target.bytes)&&Number.isSafeInteger(offset)&&offset>=0&&size<=4*1024*1024,'Invalid output part');
   const state=partial.get(name)??{total,size:0,chunks:[]};requireValue(state.total===total&&offset===state.size&&state.size+size<=total,'Output parts out of order');
   state.chunks.push(...chunks);state.size+=size;partial.set(name,state);
   if(state.size<total){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({pending:true,bytes:state.size}));return;}
   const raw=Buffer.concat(state.chunks);partial.delete(name);requireValue(target.bytes===null||raw.byteLength===target.bytes,'Incomplete GPU output');if(target.bytes===null)requireValue(raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Not PNG');
   await writeFile(join(staging,target.file),raw,{flag:'wx'});const record={file:target.file,...receipt(raw)};if(target.bytes!==null){const compressed=gzipSync(raw,{level:9});await writeFile(join(staging,target.file+'.gz'),compressed,{flag:'wx'});record.gzip={file:target.file+'.gz',...receipt(compressed)};}outputs.set(name,record);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(record));return;}
  res.writeHead(404);res.end('Not found');}catch(error){res.writeHead(400);res.end(error.message);}});
 let browser,timer;try{
  let moduleFile=resolve(options.playwrightModule);if((await stat(moduleFile)).isDirectory())moduleFile=join(moduleFile,'index.mjs');const {chromium}=await import(pathToFileURL(moduleFile).href);
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});const base='http://127.0.0.1:'+server.address().port+token;
  browser=await chromium.launch({executablePath:options.browserExecutable?resolve(options.browserExecutable):undefined,headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog','--disable-background-networking']});const page=await browser.newPage(),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(base+'/bake');
  const work=async()=>{const gpu=await page.evaluate(initialiseStandGPU,{base,prototypes:input.prototypes,stand:{ranges:stand.ranges,centre:stand.centre,radius:stand.radius,nominal:stand.nominal},shader,mipShader:shared.MIP_WGSL,ground:{coarse:ground.coarse,near:ground.near,nearOffset:ground.nearOffset,meshes:ground.meshes.length},anchor,mass:!!massSource});
   console.log(JSON.stringify({owners:stand.owners.length,halo:stand.halo.length,trianglesPerView:stand.triangles,sourceOnly:'detailed wood+leaf'}));
   const {capture,reference}=await page.evaluate(({views,tile,columns})=>globalThis.__nativeStand.capture('capture',views,tile,columns,true),{views:captureViews,tile:options.tile,columns});
   const validation=options.multiview?(await page.evaluate(({views,tile})=>globalThis.__nativeStand.capture('validation',views,tile,4),{views:heldOutViews,tile:options.tile})).capture:null;
   const mass=massSource?(await page.evaluate(({views,tile,columns})=>globalThis.__nativeStand.capture('mass',views,tile,columns,false,'mass'),{views:captureViews,tile:options.tile,columns})).capture:null;
   const massValidation=massSource&&options.multiview?(await page.evaluate(({views,tile})=>globalThis.__nativeStand.capture('mass-validation',views,tile,4,false,'mass'),{views:heldOutViews,tile:options.tile})).capture:null;
   await page.evaluate(()=>globalThis.__nativeStand.close());requireValue(!pageErrors.length,pageErrors.join('\n'));
   for(const [name,expected]of Object.entries(input.receipts)){const bytes=await readFile(join(input.folder,name));requireValue(bytes.byteLength===expected.bytes&&sha(bytes)===expected.sha256,'Native source changed during capture');}
   requireValue(sha(await readFile(input.manifestPath))===input.manifestReceipt.sha256&&sha(await readFile(bakerPath))===sha(bakerSource),'Source recipe changed during capture');
   for(const [name,expected]of Object.entries(ground.records)){const bytes=await readFile(join(resolve(options.region),name));requireValue(bytes.byteLength===expected.bytes&&sha(bytes)===expected.sha256,'Terrain changed during capture');}
   for(const [name,bytes]of [['owner-root-ids.bin',new Uint32Array(stand.owners)],['halo-root-ids.bin',new Uint32Array(stand.halo)],['draw-root-ids.bin',new Uint32Array(stand.ids)],['resident-root-instances.bin',stand.instanceRows]])await writeFile(join(staging,name),new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength),{flag:'wx'});
   const document={format:'waterworld.native-forest-stand',version:1,complete:true,units:'metres',upAxis:'Y',nominalBoundsXZ:stand.nominal,anchor,sourceBounds:{low:stand.low,high:stand.high,centre:stand.centre,radius:stand.radius},ownerBounds:stand.ownerBounds,
    roots:{owners:stand.owners.length,halo:stand.halo.length,excludedSourceRoots:excluded.length,selection:'Nominal owner centres plus every complete above-ground detailed-native bound intersecting owner support XZ; no truncation',ownerIDs:{file:'owner-root-ids.bin',...receipt(new Uint32Array(stand.owners))},haloIDs:{file:'halo-root-ids.bin',...receipt(new Uint32Array(stand.halo))},drawIDs:{file:'draw-root-ids.bin',...receipt(new Uint32Array(stand.ids))},residentInstances:{file:'resident-root-instances.bin',...receipt(stand.instanceRows)}},
    source:{manifest:input.manifestReceipt,files:input.receipts,terrain:ground.records,terrainDirectory:resolve(options.region),nativeSource:input.manifest.nativeSource,draws:drawReceipts,geometry:'Original detailed wood+leaf only; immutable prototype bytes; instance transforms/yaw/scale/tint from original root identities, production terrain seating. No coarse crown draw membership is read or substituted.'},
    recipe:{file:'scripts/bake-forest-stand.mjs',...receipt(await readFile(fileURLToPath(import.meta.url))),sharedNativeBaker:{file:bakerPath,...receipt(bakerSource)},shader:receipt(Buffer.from(shader)),gpu,sampleCount:4,capturePixels:4096,captureScale:8,finalPixelSamples:256,referencePixelSamples:4,alpha:'Source material MASK cutoff on bilinear LOD0 alpha at each supersampled geometric sample; no ordered-coverage or A2C approximation. No fixed cutoff is applied to an averaged mip.',ground:'Exact resident coarse+near source triangles draw first with depthWrite=true and both colorWriteMasks=0. They contribute no forest pigment/coverage. Actual height sampling additionally rejects buried source fragments.',roughness:'Original map/scalar receipts retained; unlit colour/normal/front-depth capture has no separate per-pixel roughness channel.'},
    channels:{albedo:'Little-endian linear RGBA16F, RGB premultiplied by geometric/source-mask coverage, A coverage; backgroundRGBA0',normalDepth:'Little-endian RGBA16F world-basis normalXYZ and front depth, all premultiplied by same coverage; divide by albedo.A, then normalize normal; backgroundRGBA0',reconstruction:'world=sourceBounds.centre+right*((2u-1)*extent)+up*((1-2v)*extent)+direction*(extent-2*extent*depth); pixel-centre u=(x+.5)/tilePixels,v=(y+.5)/tilePixels,row0top',png:'Inspection derivative only: unpremultiplied sRGB with source-normal Lambert display light; underlying arrays remain unlit'},
    capture,reference,validation,mass,massValidation,massSource,appearanceErrorSupported:false,limitations:['One128m stand and explicit full native halo only; no whole-island bake.',options.multiview?'Held-out validation directions differ from capture directions.':'First witness has one view only: multiview fusion is forbidden until explicit --multiview capture and held-out validation.','Neither averaged front depth nor averaged normals certify distance to an actual source surface. MSAA reference depth may itself mix4 visible samples. No interpolation/silhouette bound is inferred.','Static source geometry; no wind animation or baked environmental lighting.',massSource?'Native and mass clipped to identical nominal XZ witness bounds. Field mass is an authored optical approximation, not a native appearance certificate.':'This is not a solid hull, proxy crown, hole-fill or leaf-density reconstruction.']};
   requireValue(outputs.size===outputLayouts.length*3,'Incomplete native stand outputs');await writeFile(join(staging,'manifest.json'),JSON.stringify(document,null,2)+'\n',{flag:'wx'});await rename(staging,out);console.log(JSON.stringify({output:out,owners:stand.owners.length,halo:stand.halo.length,views:captureViews.length,heldOutViews:validation?heldOutViews.length:0,gpu:gpu.adapterInfo}));return document;};
  return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Explicit stand bake timeout; partial output retained at '+staging)),options.timeout);})]);
 }finally{clearTimeout(timer);await browser?.close();await new Promise(ok=>server.listening?server.close(ok):ok());}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
