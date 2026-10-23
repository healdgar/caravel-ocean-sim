#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
/** Experimental complete-leaf cluster bake; root executes explicitly.
 * node scripts/bake-forest-lod-pilot.mjs --pack assets/forest-scenery/saba \
 *   --out /tmp/forest-cluster-pilot --prototype 0,2 --max-leaves 128,512 \
 *   --playwright-module /Users/alexwall/dev/waterworld/node_modules/playwright/index.mjs \
 *   --browser-executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
 * No growth, density shells, source leaf thinning or runtime work. Source MASK
 * is tested at LOD0 per geometric MSAA sample BEFORE spatial area filtering.
 * Every mip is a separate guttered atlas; ordinary whole-page mips are unsafe.
 * No appearance range, interpolation or performance qualification is implied.
 */
import {access,mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {endianness} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {partitionForestLeaves,selectForestClusterFrontier} from './forest-lod-clusters.mjs';

const ROOT=dirname(dirname(fileURLToPath(import.meta.url))),MAX_INPUT=384*1024*1024;
const CHANNELS=['albedo','normalDepth','lighting'];
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const receipt=raw=>({bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex')});
const same=(a,b)=>a?.bytes===b?.bytes&&a?.sha256===b?.sha256;
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const name=s=>{requireValue(typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s),'Unsafe native filename');return s;};
const exists=async path=>{try{await access(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

export function parsePilotArguments(argv){
 const o={prototype:'0,2',maxLeaves:'128,512',tilePixels:32,gutter:2,pageGrid:8,encoding:'rgba8',maxDecodedMiB:512,maxEncodedMiB:256,maxTotalMiB:768,timeout:1_800_000,
  nativeBaker:'/Users/alexwall/dev/forestmodeler/scripts/bake_waterworld_impostors.mjs'};
 const flags={'--pack':'pack','--out':'out','--prototype':'prototype','--max-leaves':'maxLeaves','--tile-pixels':'tilePixels',
  '--gutter':'gutter','--page-grid':'pageGrid','--encoding':'encoding','--max-decoded-mib':'maxDecodedMiB','--max-encoded-mib':'maxEncodedMiB','--max-total-mib':'maxTotalMiB','--timeout-ms':'timeout',
  '--playwright-module':'playwrightModule','--browser-executable':'browserExecutable','--native-baker':'nativeBaker'};
 for(let i=0;i<argv.length;i++){if(argv[i]==='--help'){o.help=true;continue;}const key=flags[argv[i]];requireValue(key&&i+1<argv.length,'Unknown/incomplete argument: '+argv[i]);o[key]=argv[++i];}
 if(o.help)return o;
 for(const key of ['pack','out','playwrightModule','browserExecutable'])requireValue(o[key],'Missing '+key);
 for(const key of ['prototype','maxLeaves']){o[key]=String(o[key]).split(',').map(Number);requireValue(o[key].length&&new Set(o[key]).size===o[key].length&&o[key].every(uint),'Invalid '+key);}
 requireValue(o.prototype.length<=5&&o.maxLeaves.length<=3&&o.maxLeaves.every(x=>[32,128,512].includes(x)),'Pilot permits at most three frontiers32/128/512');
 for(const key of ['tilePixels','gutter','pageGrid','maxDecodedMiB','maxEncodedMiB','maxTotalMiB','timeout'])o[key]=Number(o[key]);
 requireValue([8,16,32,64,128].includes(o.tilePixels)&&uint(o.gutter)&&o.gutter>=2&&o.gutter<=8&&uint(o.pageGrid)&&o.pageGrid>=1&&o.pageGrid<=16,'Unsafe tile/page layout');
 requireValue(['rgba8','rgba16f'].includes(o.encoding)&&['maxDecodedMiB','maxEncodedMiB','maxTotalMiB'].every(k=>uint(o[k])&&o[k]>=1&&o[k]<=4096)&&uint(o.timeout)&&o.timeout>=10000&&o.timeout<=3_600_000,'Unsafe explicit encoding/data/time budget');
 return o;
}

export function axisClusterViews(){
 const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 return [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map((direction,index)=>{
  const right=cross(Math.abs(direction[1])>.9?[0,0,1]:[0,1,0],direction),up=cross(direction,right);return{index,direction,right,up};});
}

export function clusterPilotShader(source){
 const replace=(from,to)=>{requireValue(source.includes(from),'Shared native shader changed: '+from.slice(0,70));source=source.replace(from,to);};
 replace('@group(0) @binding(0) var<uniform> C:Camera;','@group(0) @binding(0) var<uniform> C:Camera;\n@group(0) @binding(1) var<storage,read> pilotCanopyAO:array<u32>;');
 replace('@location(3) @interpolate(perspective,sample) colour:vec3f,','@location(3) @interpolate(perspective,sample) colour:vec3f,\n @location(4) @interpolate(perspective,sample) exposure:f32,\n @location(5) @interpolate(perspective,sample) canopyAO:f32,');
 replace('@location(3) uv:vec2f,@location(4) colour:vec3f,@location(5) nativeMaterial:f32)->V{','@location(3) uv:vec2f,@location(4) colour:vec3f,@location(5) nativeMaterial:f32,@builtin(vertex_index) sourceVertex:u32)->V{');
 replace('o.local=position;o.normal=normal;o.uv=uv;o.colour=colour;return o;','o.local=position;o.normal=normal;o.uv=uv;o.colour=colour;o.exposure=kindShade.y;o.canopyAO=f32((pilotCanopyAO[sourceVertex>>2u]>>((sourceVertex&3u)*8u))&255u)/255.;return o;');
 replace('struct Output {@location(0) albedo:vec4f,@location(1) normalDepth:vec4f};','struct Output {@location(0) albedo:vec4f,@location(1) normalDepth:vec4f,@location(2) lighting:vec4f};');
 replace('let pigment=textureSampleGrad(pigmentMap,materialSampler,in.uv,ux,uy);','let pigment=textureSampleLevel(pigmentMap,materialSampler,in.uv,0.);');
 const a=source.indexOf(' if(leaf){'),b=source.indexOf('\n var n=normalize(in.normal)',a);requireValue(a>=0&&b>a,'Missing native source coverage block');
 source=source.slice(0,a)+' if(leaf&&pigment.a<M.underside.w){discard;}\n'+source.slice(b);
 replace('if(leaf&&!front){n=-n;colour=mix(colour,M.underside.rgb,M.controls.x);}','if(leaf&&!front){colour=mix(colour,M.underside.rgb*in.colour,M.controls.x);}');
 const normalStart=source.indexOf(' let tangentNormal='),normalEnd=source.indexOf(' if(C.controls.x>.5)',normalStart);requireValue(normalStart>=0&&normalEnd>normalStart,'Missing shared native normal mapping');
 source=source.slice(0,normalStart)+` let detail=textureSampleLevel(normalMap,materialSampler,in.uv,0.).xyz*2.-1.;
 let determinant=ux.x*uy.y-ux.y*uy.x;let direction=select(-1.,1.,determinant>=0.);
 let tangent=px*uy.y-py*ux.y;let bitangent=py*ux.x-px*uy.x;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){
  let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;let sampled=normalize(detail);
  n=normalize(t*sampled.x+b*sampled.y+n*sampled.z);
 }
 // Match native forest convention: map the original front normal first, then
 // reverse the entire mapped vector on backfaces; never flip only its basis.
 if(leaf&&!front){n=-n;}
`+source.slice(normalEnd);
 replace('o.normalDepth=vec4f(n,depth);return o;','o.normalDepth=vec4f(n,depth);o.lighting=vec4f(clamp(in.exposure,0.,1.),clamp(in.canopyAO,0.,1.),M.controls.w,1.);return o;');
 return source;
}

export const CLUSTER_FILTER_WGSL=/*wgsl*/`
struct Layout {tile:u32,gutter:u32,sourceTile:u32,sourceGutter:u32};
@group(0) @binding(0)var<uniform>L:Layout;
@group(0) @binding(1)var source:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position)p:vec4f)->@location(0)vec4f{
 let pitch=L.tile+2u*L.gutter;let tile=vec2u(p.xy)/pitch;
 let q=clamp(vec2i(p.xy)-vec2i(tile*pitch)-vec2i(i32(L.gutter)),vec2i(0),vec2i(i32(L.tile)-1));
 let a=vec2i(tile*(L.sourceTile+2u*L.sourceGutter))+vec2i(i32(L.sourceGutter))+q*2;
 return .25*(textureLoad(source,a,0)+textureLoad(source,a+vec2i(1,0),0)+textureLoad(source,a+vec2i(0,1),0)+textureLoad(source,a+vec2i(1,1),0));
}`;

export const CLUSTER_ENCODE_WGSL=/*wgsl*/`
// Four scalar words are exactly16B in uniform address space. A vec3 padding
// member would start at16B and make this struct32B instead.
struct Mode {channel:u32,padding0:u32,padding1:u32,padding2:u32};
@group(0) @binding(0)var<uniform>M:Mode;
@group(0) @binding(1)var source:texture_2d<f32>;
@group(0) @binding(2)var coverage:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position)p:vec4f)->@location(0)vec4f{
 let q=vec2i(p.xy);let value=textureLoad(source,q,0);
 if(M.channel==1u){let a=textureLoad(coverage,q,0).a;return vec4f(.5*value.xyz+vec3f(.5*a),value.w);}
 return value;
}`;

async function loadPilotPack(pack,selected){
 requireValue(endianness()==='LE','Little-endian authoring host required');
 const path=resolve(pack),manifestPath=(await stat(path)).isDirectory()?join(path,'manifest.json'):path,folder=dirname(manifestPath);
 const manifestRaw=await readFile(manifestPath),manifest=JSON.parse(manifestRaw);
 requireValue(manifestRaw.length<=4*1024*1024&&manifest.format==='waterworld.forest-instances'&&manifest.version===2&&manifest.vertexStride===56&&manifest.units==='metres'&&manifest.upAxis==='Y'&&manifest.materialContract==='gene-surfaces-v3','Original native56B forest v2 required');
 const files=new Map(),records={},physical=new Map();let total=0;
 const read=async(file,item)=>{
  name(file);requireValue(uint(item?.bytes)&&item.bytes>0&&item.bytes<=256*1024*1024&&/^[a-f0-9]{64}$/.test(item.sha256??''),'Invalid source receipt');
  if(files.has(file)){requireValue(same(records[file],item),'Conflicting source receipt');return files.get(file);}
  let raw;if(await exists(join(folder,file))){raw=await readFile(join(folder,file));physical.set(file,receipt(raw));}
  else{const z=item.gzip;name(z?.file);const encoded=await readFile(join(folder,z.file));requireValue(same(receipt(encoded),z),'Encoded native source mismatch');physical.set(z.file,receipt(encoded));raw=gunzipSync(encoded,{maxOutputLength:item.bytes});}
  requireValue(same(receipt(raw),item),'Decoded original source mismatch: '+file);total+=raw.length;requireValue(total<=MAX_INPUT,'Explicit384MiB source budget exceeded');files.set(file,raw);records[file]=receipt(raw);return raw;
 };
 for(const file of ['vertices.bin','indices.bin','roots.bin'])await read(file,manifest.files[file]);
 const verticesRaw=files.get('vertices.bin'),indicesRaw=files.get('indices.bin');requireValue(verticesRaw.length%56===0&&indicesRaw.length%4===0,'Invalid native stream alignment');
 const vertices=new Float32Array(verticesRaw.buffer.slice(verticesRaw.byteOffset,verticesRaw.byteOffset+verticesRaw.length)),indices=new Uint32Array(indicesRaw.buffer.slice(indicesRaw.byteOffset,indicesRaw.byteOffset+indicesRaw.length));
 const lightPointer=manifest.canopyShade;requireValue(lightPointer?.file==='canopy-shade.json'&&lightPointer.bytes<=4*1024*1024,'Verified native canopy-shade pointer required');
 const lightRaw=await read(lightPointer.file,lightPointer),light=JSON.parse(lightRaw),shadeItem=light.files?.['canopy-shade.bin'];
 requireValue(light.format==='waterworld.native-canopy-light'&&light.version===1&&light.recipe?.version===1&&light.vertexCount===vertices.length/14&&
  shadeItem?.bytes===Math.ceil(light.vertexCount/4)*4&&shadeItem.gzip?.file==='canopy-shade.bin.gz'&&light.source?.method?.file==='scripts/prepare-forest-light.py'&&
  Object.keys(light.source.files??{}).length===3&&Array.isArray(light.prototypes)&&light.prototypes.length===manifest.prototypes.length,'Invalid native canopy-shade layout/provenance');
 for(const file of ['vertices.bin','indices.bin','roots.bin'])requireValue(same(light.source.files[file],manifest.files[file]),'Native canopy-shade source differs: '+file);
 for(const p of manifest.prototypes){const own=light.prototypes.find(q=>q.id===p.id);requireValue(own?.species===p.species,'Native canopy-shade specimen differs');
  for(const kind of ['wood','leaf']){const r=own.membership?.[kind],expected=p[kind];requireValue(r?.firstIndex===expected.firstIndex&&r.indexCount===expected.indexCount&&same(r.indices,receipt(new Uint8Array(indices.buffer,indices.byteOffset+expected.firstIndex*4,expected.indexCount*4))),'Native canopy-shade membership differs');}}
 const canopyAO=await read('canopy-shade.bin',shadeItem);for(let i=light.vertexCount;i<canopyAO.length;i++)requireValue(canopyAO[i]===255,'Native canopy-shade padding must be neutral');
 const prototypes=selected.map(id=>{const p=manifest.prototypes.find(p=>p.id===id);requireValue(p,'Unknown selected prototype');return p;});
 for(const p of prototypes){
  name(p.species);requireValue(Array.isArray(p.nativeMaterials)&&p.source?.native?.materialContract==='gene-surfaces-v3','Missing native material authority');
  for(const material of p.nativeMaterials.filter(m=>m.name.startsWith('foliage_'))){
   requireValue(uint(material.index)&&material.wrap==='clamp'&&[material.opacityThreshold,material.underside,material.roughness,material.transmission].every(x=>Number.isFinite(x)&&x>=0&&x<=1)&&Array.isArray(material.undersideReference)&&material.undersideReference.length===3&&material.undersideReference.every(x=>Number.isFinite(x)&&x>=0&&x<=1),'Invalid leaf material');
   for(const key of ['albedo','normal','roughnessMap'])if(material[key]){const map=material[key];requireValue(map.encoding===(key==='albedo'?'srgb':'linear')&&uint(map.width)&&uint(map.height)&&map.width>0&&map.height>0&&map.width<=4096&&map.height<=4096,'Invalid original map');
    requireValue(same(map,manifest.files[map.file])&&same(map,p.source.native.maps?.[map.file]),'Native map provenance differs');await read(map.file,map);}
   requireValue(material.albedo&&material.normal,'Native leaf pigment/normal maps required');
  }
 }
 return{folder,manifestPath,manifest,manifestRaw,vertices,indices,files,records,physical,prototypes,canopyShade:{manifest:{file:lightPointer.file,...receipt(lightRaw)},field:{file:'canopy-shade.bin',...receipt(canopyAO)},recipe:light.recipe,source:light.source}};
}

function clusterTier(p,h,maxLeaves,options){
 const views=axisClusterViews(),frontier=selectForestClusterFrontier(h,maxLeaves),capacity=options.pageGrid**2;
 const clusters=frontier.map((nodeID,id)=>{
  const n=h.nodes[nodeID],centre=n.centre.slice(),radius=Math.hypot(...n.high.map((v,k)=>(v-n.low[k])*.5));
  requireValue(radius>0&&n.indexCount===n.leafCount*h.indicesPerLeaf,'Invalid complete-blade node');
  const draws=[];for(let i=0;i<n.leafCount;i++){const slot=h.leafMaterials[h.leafOrder[n.firstLeaf+i]],last=draws.at(-1);
   if(last?.material===slot)last.indexCount+=h.indicesPerLeaf;else draws.push({material:slot,firstIndex:n.firstIndex+i*h.indicesPerLeaf,indexCount:h.indicesPerLeaf});}
  return{id,sourceNodeID:n.id,parentNodeID:n.parent,firstLeaf:n.firstLeaf,leafCount:n.leafCount,low:n.low.slice(),high:n.high.slice(),centre,radius,extent:radius*options.tilePixels/(options.tilePixels-2),sourceLeafCount:n.leafCount,
   sourceMembership:{firstLeaf:n.firstLeaf,leafCount:n.leafCount,firstIndex:n.firstIndex,indexCount:n.indexCount,
    leafIDs:receipt(new Uint8Array(h.leafOrder.buffer,h.leafOrder.byteOffset+n.firstLeaf*4,n.leafCount*4)),
    indices:receipt(new Uint8Array(h.orderedIndices.buffer,h.orderedIndices.byteOffset+n.firstIndex*4,n.indexCount*4))},draws,
   views:views.map(v=>{const tileID=id*6+v.index,page=Math.floor(tileID/capacity),slot=tileID%capacity,tile=[slot%options.pageGrid,Math.floor(slot/options.pageGrid)],pitch=options.tilePixels+options.gutter*2,size=options.pageGrid*pitch;
    const x=tile[0]*pitch+options.gutter,y=tile[1]*pitch+options.gutter;return{...v,page,tile,rect:[x,y,options.tilePixels,options.tilePixels],uvMin:[x/size,y/size],uvMax:[(x+options.tilePixels)/size,(y+options.tilePixels)/size]};})};
 });
 const pageCount=Math.ceil(clusters.length*6/capacity),pages=[];
 for(let index=0;index<pageCount;index++){const mips=[];for(let level=0,tile=options.tilePixels;tile>=1;level++,tile/=2){const pitch=tile+2*options.gutter,size=options.pageGrid*pitch;
   mips.push({level,tilePixels:tile,gutter:options.gutter,pitchPixels:pitch,atlasPixels:[size,size],format:options.encoding==='rgba8'?'rgba8unorm':'rgba16float',bytesPerTexel:options.encoding==='rgba8'?4:8,outputs:{}});}pages.push({index,grid:[options.pageGrid,options.pageGrid],mips});}
 return{maxLeaves,frontier,clusters,pages,sourceTriangleSubmissionsPerView:h.orderedIndices.length/3,
  decodedGPUTextureBytes:pages.reduce((s,page)=>s+page.mips.reduce((n,m)=>n+m.atlasPixels[0]**2*m.bytesPerTexel*3,0),0)};
}

// Serializable browser job. All inputs are previously verified local bytes.
async function initialiseClusterGPU({base,shader,filterShader,encodeShader,prototypes,configuration}){
 const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});if(!adapter)throw Error('Native hardware WebGPU required');
 const info=adapter.info??{},adapterInfo=Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,info[k]??'']));
 if(adapter.isFallbackAdapter===true||/swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(adapterInfo)))throw Error('Software GPU refused');
 const device=await adapter.requestDevice(),errors=[],B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage;
 device.onuncapturederror=e=>errors.push(e.error.message);device.lost.then(x=>{if(x.reason!=='destroyed')errors.push(x.message);});
 const get=async file=>{const r=await fetch(base+'/asset/'+encodeURIComponent(file));if(!r.ok)throw Error('Asset missing:'+file);return r;};
 const upload=async(key,raw)=>{const r=await fetch(base+'/result/'+key,{method:'POST',body:raw});if(!r.ok)throw Error(await r.text());return r.json();};
 const make=(data,usage,label)=>{const b=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
 const vertices=make(await(await get('vertices.bin')).arrayBuffer(),B.VERTEX,'Immutable original56B native vertices');
 const canopyAO=make(await(await get('canopy-shade.bin')).arrayBuffer(),B.STORAGE,'Verified global-index native canopy AO');
 const compile=async code=>{const m=device.createShaderModule({code}),bad=(await m.getCompilationInfo()).messages.filter(x=>x.type==='error');if(bad.length)throw Error(bad.map(x=>x.message).join('\n'));return m;};
 const module=await compile(shader),filter=await compile(filterShader),encode=await compile(encodeShader);
 const cameraLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform',minBindingSize:80}},
  {binding:1,visibility:S.VERTEX,buffer:{type:'read-only-storage',minBindingSize:4}}]});
 const materialLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.FRAGMENT,buffer:{type:'uniform',minBindingSize:32}},
  {binding:1,visibility:S.FRAGMENT,sampler:{}},{binding:2,visibility:S.FRAGMENT,texture:{}},{binding:3,visibility:S.FRAGMENT,texture:{}}]});
 const pipeline=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[cameraLayout,materialLayout]}),
  vertex:{module,entryPoint:'vs',buffers:[{arrayStride:56,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
   {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x2'},{shaderLocation:4,offset:40,format:'float32x3'},{shaderLocation:5,offset:52,format:'float32'}]}]},
  fragment:{module,entryPoint:'fs',targets:[0,1,2].map(()=>({format:'rgba16float'}))},primitive:{topology:'triangle-list',cullMode:'none'},
  depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'},multisample:{count:4}});
 const filterPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:filter,entryPoint:'vs'},fragment:{module:filter,entryPoint:'fs',targets:[{format:'rgba16float'}]}});
 const encodePipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:encode,entryPoint:'vs'},fragment:{module:encode,entryPoint:'fs',targets:[{format:'rgba8unorm'}]}});
 const toLinear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
 const image=async map=>{const bitmap=await createImageBitmap(await(await get(map.file)).blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none',imageOrientation:'none'});
  if(bitmap.width!==map.width||bitmap.height!==map.height)throw Error('Native image dimensions changed');
  const t=device.createTexture({size:[bitmap.width,bitmap.height],format:map.encoding==='srgb'?'rgba8unorm-srgb':'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST|T.RENDER_ATTACHMENT});
  device.queue.copyExternalImageToTexture({source:bitmap},{texture:t,premultipliedAlpha:false},[bitmap.width,bitmap.height]);bitmap.close();return t;};
 const half=(view,offset)=>{const h=view.getUint16(offset,true),s=h&32768?-1:1,e=(h>>10)&31,m=h&1023;return e===0?s*m*2**-24:e===31?NaN:s*(1+m/1024)*2**(e-15);};
 const contexts=new Map();
 for(const p of prototypes){const owned=[],materials=new Map(),index=make(await(await get('__ordered-'+p.id+'.bin')).arrayBuffer(),B.INDEX,'Shared spatially reordered complete blades');owned.push(index);
  for(const m of p.nativeMaterials.filter(m=>m.name.startsWith('foliage_'))){const pigment=await image(m.albedo),normal=await image(m.normal),state=make(new Float32Array([m.underside,1,m.roughness,m.transmission,...m.undersideReference.map(toLinear),m.opacityThreshold]),B.UNIFORM,'Original leaf optics');owned.push(pigment,normal,state);
   const sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
   materials.set(m.index,device.createBindGroup({layout:materialLayout,entries:[{binding:0,resource:{buffer:state}},{binding:1,resource:sampler},{binding:2,resource:pigment.createView()},{binding:3,resource:normal.createView()}]}));}
  contexts.set(p.id,{index,materials,owned});}
 globalThis.__forestClusterPilot={async page({prototype,maxLeaves,pageIndex,tiles,mips}){
  const context=contexts.get(prototype),grid=configuration.pageGrid,captureTile=configuration.tilePixels*2,width=grid*captureTile;
  if(width>device.limits.maxTextureDimension2D)throw Error('Capture exceeds real GPU texture limit');
  const owned=[],texture=(size,samples=1)=>{const t=device.createTexture({size:[size,size],format:'rgba16float',sampleCount:samples,usage:T.RENDER_ATTACHMENT|(samples===1?T.TEXTURE_BINDING|T.COPY_SRC:0)});owned.push(t);return t;};
  try{
   const resolved=[0,1,2].map(()=>texture(width)),msaa=[0,1,2].map(()=>texture(width,4)),depth=device.createTexture({size:[width,width],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});owned.push(depth);
   const frame=new Float32Array(tiles.length*64);tiles.forEach((t,i)=>{frame.set([...t.centre,t.extent],i*64);frame.set(t.direction,i*64+4);frame.set(t.right,i*64+8);frame.set(t.up,i*64+12);frame[i*64+17]=0;});
   const cameras=make(frame,B.UNIFORM,'Immutable cluster cameras');owned.push(cameras);const encoder=device.createCommandEncoder();
   const pass=encoder.beginRenderPass({colorAttachments:resolved.map((t,i)=>({view:msaa[i].createView(),resolveTarget:t.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'discard'})),
    depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});
   pass.setPipeline(pipeline);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(context.index,'uint32');
   tiles.forEach((t,i)=>{const x=t.tile[0]*captureTile,y=t.tile[1]*captureTile;pass.setViewport(x,y,captureTile,captureTile,0,1);pass.setScissorRect(x,y,captureTile,captureTile);
    pass.setBindGroup(0,device.createBindGroup({layout:cameraLayout,entries:[{binding:0,resource:{buffer:cameras,offset:i*256,size:80}},{binding:1,resource:{buffer:canopyAO}}]}));
    for(const draw of t.draws){const material=context.materials.get(draw.material);if(!material)throw Error('Unbound native leaf material');pass.setBindGroup(1,material);pass.drawIndexed(draw.indexCount,1,draw.firstIndex);}});pass.end();
   const readbacks=[];let previous=resolved;
   for(const mip of mips){const size=mip.atlasPixels[0],filtered=[0,1,2].map(()=>texture(size)),layout=make(new Uint32Array([mip.tilePixels,mip.gutter,mip.level===0?captureTile:mip.tilePixels*2,mip.level===0?0:mip.gutter]),B.UNIFORM,'Isolated tile filter');owned.push(layout);
    for(let channel=0;channel<3;channel++){const p=encoder.beginRenderPass({colorAttachments:[{view:filtered[channel].createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
     p.setPipeline(filterPipeline);p.setBindGroup(0,device.createBindGroup({layout:filterPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:layout}},{binding:1,resource:previous[channel].createView()}]}));p.draw(3);p.end();
    }
    for(let channel=0;channel<3;channel++){
     let target=filtered[channel];
     if(configuration.encoding==='rgba8'){
      target=device.createTexture({size:[size,size],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});owned.push(target);
      const mode=make(new Uint32Array([channel,0,0,0]),B.UNIFORM,'Output normal encoding');owned.push(mode);
      const p=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
      p.setPipeline(encodePipeline);p.setBindGroup(0,device.createBindGroup({layout:encodePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:mode}},{binding:1,resource:filtered[channel].createView()},{binding:2,resource:filtered[0].createView()}]}));p.draw(3);p.end();
     }
     const bytesPerTexel=mip.bytesPerTexel,bytesPerRow=Math.ceil(size*bytesPerTexel/256)*256,b=device.createBuffer({size:bytesPerRow*size,usage:B.COPY_DST|B.MAP_READ});owned.push(b);
     encoder.copyTextureToBuffer({texture:target},{buffer:b,bytesPerRow},[size,size]);readbacks.push({buffer:b,bytesPerRow,bytesPerTexel,size,channel,level:mip.level});}
    previous=filtered;
   }
   device.queue.submit([encoder.finish()]);const outputs=[];
   for(const r of readbacks){await r.buffer.mapAsync(GPUMapMode.READ);const mapped=new Uint8Array(r.buffer.getMappedRange()),raw=new Uint8Array(r.size*r.size*r.bytesPerTexel);
    for(let y=0;y<r.size;y++)raw.set(mapped.subarray(y*r.bytesPerRow,y*r.bytesPerRow+r.size*r.bytesPerTexel),y*r.size*r.bytesPerTexel);r.buffer.unmap();
    const view=new DataView(raw.buffer);let coverage=0;
    for(let at=0;at<raw.length;at+=r.bytesPerTexel){if(r.bytesPerTexel===8)for(let c=0;c<4;c++)if(!Number.isFinite(half(view,at+c*2)))throw Error('Nonfinite GPU atlas');
     if(r.channel!==1){const a=r.bytesPerTexel===8?half(view,at+6):raw[at+3]/255;if(a<0||a>1.001)throw Error('Invalid resolved coverage');coverage+=a;}}
    outputs.push({level:r.level,channel:r.channel,coverageSum:coverage,receipt:await upload(prototype+'/'+maxLeaves+'/'+pageIndex+'/'+r.level+'/'+r.channel,raw)});
   }
   if(errors.length)throw Error(errors.join('\n'));return outputs;
  }finally{for(const item of owned)item.destroy();}
 },async close(){await device.queue.onSubmittedWorkDone();for(const c of contexts.values())for(const item of c.owned)item.destroy();vertices.destroy();canopyAO.destroy();device.destroy();}};
 return{adapterInfo,limits:{maxTextureDimension2D:device.limits.maxTextureDimension2D,maxBufferSize:device.limits.maxBufferSize},features:Array.from(device.features)};
}

export async function main(argv=process.argv.slice(2)){
 const o=parsePilotArguments(argv);if(o.help){console.log('Experimental complete-leaf six-axis bake: --pack --out --prototype0,2 --max-leaves128,512 --tile-pixels32 --playwright-module --browser-executable. Optional --page-grid8 --gutter2 --max-decoded-mib512 --native-baker.');return;}
 requireValue(process.platform==='darwin','This pilot requires native macOS Metal; no software backend');const out=resolve(o.out);requireValue(!await exists(out),'Fresh output required');
 const input=await loadPilotPack(o.pack,o.prototype),nativePath=resolve(o.nativeBaker),nativeRaw=await readFile(nativePath),helperRaw=await readFile(join(ROOT,'scripts/forest-lod-clusters.mjs')),ownRaw=await readFile(fileURLToPath(import.meta.url));
 const {BAKE_WGSL}=await import(pathToFileURL(nativePath).href);requireValue(typeof BAKE_WGSL==='string','Shared native baker must export BAKE_WGSL');const shader=clusterPilotShader(BAKE_WGSL);
 const hierarchies=new Map(),prototypes=input.prototypes.map(p=>{const h=partitionForestLeaves(input.vertices,input.indices,p.leaf,{maxLeaves:32});hierarchies.set(p.id,h);input.files.set('__ordered-'+p.id+'.bin',Buffer.from(h.orderedIndices.buffer,h.orderedIndices.byteOffset,h.orderedIndices.byteLength));
  return{id:p.id,species:p.species,source:p.source,nativeMaterials:p.nativeMaterials,low:p.low,high:p.high,centre:p.centre,radius:p.radius,biologicalRootXYZ:[0,0,0],groundPlaneY:0,
   canopyBounds:{low:h.nodes[h.root].low,high:h.nodes[h.root].high},canopyHeightMetres:h.nodes[h.root].high[1],leafTriangles:h.leafTriangles,leafCount:h.leafCount,
   hierarchyNodes:h.nodes.map(({id,parent,children,firstLeaf,leafCount})=>({id,parent,children,firstLeaf,leafCount})),
   hierarchy:{root:h.root,nodes:h.nodes,orderedIndices:receipt(new Uint8Array(h.orderedIndices.buffer,h.orderedIndices.byteOffset,h.orderedIndices.byteLength))},
   sourceLeafRange:{...p.leaf,indices:receipt(new Uint8Array(input.indices.buffer,input.indices.byteOffset+p.leaf.firstIndex*4,p.leaf.indexCount*4))},
   tiers:o.maxLeaves.map(n=>clusterTier(p,h,n,o))};});
 const decoded=prototypes.reduce((s,p)=>s+p.tiers.reduce((n,t)=>n+t.decodedGPUTextureBytes,0),0);requireValue(decoded<=o.maxDecodedMiB*1024*1024&&decoded<=o.maxTotalMiB*1024*1024,'Pilot exceeds explicit decoded/combined texture budget; select fewer prototypes/frontiers or a smaller tile. No truncation.');
 await mkdir(dirname(out),{recursive:true});const staging=out+'.baking-'+randomUUID();await mkdir(staging);const allowed=new Map(),uploaded=new Map();
 for(const p of prototypes){const h=hierarchies.get(p.id),prefix='prototype-'+p.id+'-'+name(p.species);await mkdir(join(staging,prefix));
  const raw=Buffer.from(h.leafOrder.buffer,h.leafOrder.byteOffset,h.leafOrder.byteLength),gz=gzipSync(raw,{level:9,mtime:0}),file=prefix+'/leaf-order.u32.bin';await writeFile(join(staging,file+'.gz'),gz,{flag:'wx'});p.hierarchy.leafOrder={file,...receipt(raw),gzip:{file:file+'.gz',...receipt(gz)}};
  for(const tier of p.tiers){await mkdir(join(staging,prefix,'tier-'+tier.maxLeaves));for(const page of tier.pages)for(const mip of page.mips)for(const [channel,label]of CHANNELS.entries()){
   const file=prefix+'/tier-'+tier.maxLeaves+'/page-'+page.index+'-mip-'+mip.level+'-'+label+'.'+o.encoding+'.bin';allowed.set(p.id+'/'+tier.maxLeaves+'/'+page.index+'/'+mip.level+'/'+channel,{file,bytes:mip.atlasPixels[0]**2*mip.bytesPerTexel});}}
 }
 let encodedTextureBytes=0;
 const token='/'+randomUUID(),server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&path===token+'/bake'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><title>Experimental native leaf cluster bake</title>');return;}
  if(req.method==='GET'&&path.startsWith(token+'/asset/')){const file=decodeURIComponent(path.slice((token+'/asset/').length)),raw=input.files.get(file);requireValue(raw,'Unverified source request');res.writeHead(200,{'Content-Type':file.endsWith('.png')?'image/png':'application/octet-stream','Content-Length':raw.length});res.end(raw);return;}
  if(req.method==='POST'&&path.startsWith(token+'/result/')){const key=path.slice((token+'/result/').length),target=allowed.get(key);requireValue(target&&!uploaded.has(key),'Unknown/repeated output');const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;requireValue(size<=target.bytes,'Oversized GPU page');chunks.push(chunk);}requireValue(size===target.bytes,'Incomplete GPU page');
   const raw=Buffer.concat(chunks),gz=gzipSync(raw,{level:9,mtime:0});encodedTextureBytes+=gz.length;requireValue(encodedTextureBytes<=o.maxEncodedMiB*1024*1024&&encodedTextureBytes+decoded<=o.maxTotalMiB*1024*1024,'Encoded/combined pilot texture budget exceeded; no partial pack published');
   await writeFile(join(staging,target.file+'.gz'),gz,{flag:'wx'});const item={file:target.file,...receipt(raw),gzip:{file:target.file+'.gz',...receipt(gz)}};uploaded.set(key,item);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(item));return;}
  res.writeHead(404);res.end('Not found');
 }catch(e){res.writeHead(400,{'Content-Type':'text/plain'});res.end(e.message);}});
 let browser,timer;
 try{
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});const base='http://127.0.0.1:'+server.address().port+token;
  let module=resolve(o.playwrightModule);if((await stat(module)).isDirectory())module=join(module,'index.mjs');const {chromium}=await import(pathToFileURL(module).href);
  browser=await chromium.launch({executablePath:resolve(o.browserExecutable),headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog','--disable-background-networking']});
  const cdp=await browser.newBrowserCDPSession(),system=await cdp.send('SystemInfo.getInfo');await cdp.detach();const renderer=JSON.stringify({devices:system.gpu.devices,renderer:system.gpu.auxAttributes?.glRenderer});requireValue(/metal/i.test(renderer)&&!/swiftshader|llvmpipe|lavapipe/i.test(renderer),'Browser did not expose a native Metal renderer');
  const page=await browser.newPage();page.setDefaultTimeout(o.timeout);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());await page.goto(base+'/bake');
  const work=async()=>{
   const gpu=await page.evaluate(initialiseClusterGPU,{base,shader,filterShader:CLUSTER_FILTER_WGSL,encodeShader:CLUSTER_ENCODE_WGSL,prototypes:prototypes.map(({id,nativeMaterials})=>({id,nativeMaterials})),configuration:o});
   for(const p of prototypes)for(const tier of p.tiers)for(const atlasPage of tier.pages){
    const tiles=[];for(const cluster of tier.clusters)for(const view of cluster.views)if(view.page===atlasPage.index)tiles.push({...view,centre:cluster.centre,extent:cluster.extent,draws:cluster.draws});
    console.log(JSON.stringify({prototype:p.id,maxLeaves:tier.maxLeaves,page:atlasPage.index,pages:tier.pages.length,clusters:tier.clusters.length,decodedGPUTextureBytes:tier.decodedGPUTextureBytes}));
    const results=await page.evaluate(job=>globalThis.__forestClusterPilot.page(job),{prototype:p.id,maxLeaves:tier.maxLeaves,pageIndex:atlasPage.index,tiles,mips:atlasPage.mips});
    for(const r of results)atlasPage.mips[r.level].outputs[CHANNELS[r.channel]]={...r.receipt,coverageSum:r.coverageSum};
   }
   await page.evaluate(()=>globalThis.__forestClusterPilot.close());requireValue(!errors.length,errors.join('\n'));requireValue(uploaded.size===allowed.size,'Missing completed atlas outputs');
   for(const [file,expected]of input.physical)requireValue(same(receipt(await readFile(join(input.folder,file))),expected),'Physical source changed: '+file);
   requireValue((await readFile(input.manifestPath)).equals(input.manifestRaw)&&(await readFile(nativePath)).equals(nativeRaw)&&(await readFile(join(ROOT,'scripts/forest-lod-clusters.mjs'))).equals(helperRaw)&&(await readFile(fileURLToPath(import.meta.url))).equals(ownRaw),'Source or method changed during bake');
   const document={format:'waterworld.forest-leaf-cluster-pilot',version:1,experimental:true,complete:true,units:'metres',upAxis:'Y',qualified:false,
    source:{manifest:{file:'manifest.json',...receipt(input.manifestRaw)},files:input.records,nativeSource:input.manifest.nativeSource,canopyShade:input.canopyShade,
     methods:[{file:'scripts/bake-forest-lod-pilot.mjs',...receipt(ownRaw)},{file:'scripts/forest-lod-clusters.mjs',...receipt(helperRaw)},{file:nativePath,...receipt(nativeRaw)}],shader:receipt(Buffer.from(shader))},
    layout:{views:axisClusterViews(),tilePixels:o.tilePixels,gutter:o.gutter,pageGrid:o.pageGrid,captureScale:2,sampleCount:4,finalPixelSamples:16,encoding:o.encoding,
     mips:'Separate guttered page per level; NEVER generate ordinary whole-page hardware mips. Every2x2 filter is restricted to its own prior tile; gutters duplicate that tile edge.',
     viewRect:'rect/uvMin/uvMax describe level0 interior. For mip m use the same tile coordinates and that mip pitch/tilePixels/gutter. Row0 top; texel centres (pixel+.5)/atlasPixels.',
     sourceMask:'Physical-reference LOD0 source MASK cutoff at each geometric MSAA sample, before2x spatial filtering. This differs from current native forestFS fractional coverage/mip integration with independent footprint masks; it is NOT a bit-equivalent current-FS reference. No leaf enlargement or cutoff after averaging.'},
    channels:{albedo:'Unlit linear native pigmentRGB premultiplied by coverage; A=coverage. RGBA8 is normalized linear quantization, NOT sRGB.',normalDepth:o.encoding==='rgba8'?'RGBA8 RGB=(localMappedNormal*.5+.5)*coverage, A=normalizedFrontDepth*coverage. Decode normal=2*RGB/albedoA-1, depth=A/albedoA.':
     'LE RGBA16F local mapped normalXYZ and normalized frontDepth, all premultiplied by albedo coverage; divide before normalizing',
     lighting:'Original kindShade.y exposure, verified per-original-vertex canopyAO, scalar material transmission, coverage; all premultiplied. Roughness stays in source material metadata. No fixed sunlight baked.',
     reconstruction:'local=cluster.centre+right*((2u-1)*extent)+up*((1-2v)*extent)+direction*(extent-2extent*depth); UVu/v are within the interior rect. Averaged depth is not a certified surface distance.',
     normalVariance:'Length of coverage-divided averaged normal retains coherence; do not normalize before spatial filtering. Original normal maps use native tangent mapping and full mapped-normal backface reversal; native underside pigment includes original vertex colour.'},
    quantization:o.encoding==='rgba8'?'GPU UNORM8 encode AFTER floating-point per-tile mip filtering; each stored channel rounding/clamping is lossy. Low coverage amplifies normal/depth quantization; quality remains unqualified.':'RGBA16F render/resolve/filter quantization; no claim of lossless source appearance.',
    decodedGPUTextureBytes:decoded,encodedTextureBytes,maximumDecodedGPUTextureBytes:o.maxDecodedMiB*1024*1024,maximumEncodedTextureBytes:o.maxEncodedMiB*1024*1024,maximumCombinedTextureBytes:o.maxTotalMiB*1024*1024,gpu:{...gpu,requestedBackend:'Metal',browserRenderer:JSON.parse(renderer)},
    prototypes,limitations:['Six nearest-axis captures need independent intermediate-angle/parallax/coverage qualification. No quality range is claimed.',
     'Original native complete blades only; wood remains a separate root-owned representation. Below biological localY0 samples are soil-occluded, never clipped out of the source mesh.',
     'Source roughness maps/scalars remain metadata; lighting pixels store transmission alongside source exposure/canopyAO. Wind, underside direction dependence and temporal transitions remain unqualified.',
     'RGBA16F and finite spatial samples quantize pigment/coverage/depth. Source kindShade exposure is retained as authored, not replaced with a guessed sun shadow.']};
   await writeFile(join(staging,'manifest.json'),JSON.stringify(document,null,2)+'\n',{flag:'wx'});requireValue(!await exists(out),'Output occupied during bake');await rename(staging,out);return document;
  };
  return await Promise.race([work(),new Promise((_,bad)=>{timer=setTimeout(()=>bad(Error('Pilot timeout; partial source-only staging retained: '+staging)),o.timeout);})]);
 }catch(e){console.error('No qualified output published. Partial experimental staging: '+staging);throw e;}
 finally{clearTimeout(timer);await browser?.close();await new Promise(ok=>server.close(ok));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack??e);process.exitCode=1;});
