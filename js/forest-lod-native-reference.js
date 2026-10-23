// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Explicit immutable-specimen/stand REVIEW reference. Never install as a production
// tier, streaming fallback, or frame-loop CPU geometry/deformation path.
const check=(ok,message)=>{if(!ok)throw Error('Forest native review: '+message);};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const receipt=r=>uint(r?.bytes)&&r.bytes>0&&r.bytes<=256*1024*1024&&/^[a-f0-9]{64}$/.test(r.sha256??'');
const same=(a,b)=>receipt(a)&&receipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const safe=name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..');
const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
const vertexLayout={arrayStride:56,attributes:[
 {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
 {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x2'},
 {shaderLocation:4,offset:40,format:'float32x3'},{shaderLocation:5,offset:52,format:'float32'},
]};
const SOURCE_SHADER=/* wgsl */`
struct PilotCamera {viewProj:mat4x4f,positionFocal:vec4f,sunExposure:vec4f,screen:vec4f,settings:vec4f};
struct Material {controls:vec4f,underside:vec4f};
struct ReviewRoot {positionScale:vec4f,yawPadding:vec4f};
@group(0)@binding(0)var<uniform>C:PilotCamera;
@group(0)@binding(1)var<storage,read>canopyAO:array<u32>;
@group(0)@binding(2)var<storage,read>reviewRoots:array<ReviewRoot>;
@group(1)@binding(0)var<uniform>M:Material;
@group(1)@binding(1)var materialSampler:sampler;
@group(1)@binding(2)var pigmentMap:texture_2d<f32>;
@group(1)@binding(3)var normalMap:texture_2d<f32>;
@group(2)@binding(0)var<storage,read>sourceVertexIDs:array<u32>;
struct Input {@location(0)position:vec3f,@location(1)normal:vec3f,@location(2)kindShade:vec2f,@location(3)uv:vec2f,@location(4)colour:vec3f,@location(5)material:f32};
struct Vertex {
 @builtin(position)position:vec4f,
 @location(0)@interpolate(perspective,sample)local:vec3f,
 @location(1)@interpolate(perspective,sample)normal:vec3f,
 @location(2)@interpolate(perspective,sample)uv:vec2f,
 @location(3)@interpolate(perspective,sample)colour:vec3f,
 @location(4)@interpolate(perspective,sample)exposure:f32,
 @location(5)@interpolate(perspective,sample)canopyAO:f32,
 @location(6)@interpolate(flat)rootRotation:vec2f,
};
fn reviewRotate(p:vec3f,rotation:vec2f)->vec3f{return vec3f(rotation.x*p.x-rotation.y*p.z,p.y,rotation.y*p.x+rotation.x*p.z);}
fn nativeVertex(in:Input,sourceVertex:u32,instance:u32)->Vertex{
 let root=reviewRoots[instance];let rotation=vec2f(cos(root.yawPadding.x),sin(root.yawPadding.x));let world=root.positionScale.xyz+reviewRotate(in.position*root.positionScale.w,rotation);
 var o:Vertex;o.position=C.viewProj*vec4f(world,1);o.local=in.position;o.normal=reviewRotate(in.normal,rotation);o.uv=in.uv;o.colour=in.colour;o.exposure=in.kindShade.y;o.rootRotation=rotation;
 o.canopyAO=f32((canopyAO[sourceVertex>>2u]>>((sourceVertex&3u)*8u))&255u)/255.;return o;
}
@vertex fn nativeVS(in:Input,@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->Vertex{return nativeVertex(in,vertex,instance);}
@vertex fn woodVS(in:Input,@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->Vertex{return nativeVertex(in,sourceVertexIDs[vertex],instance);}
@fragment fn nativeFS(in:Vertex,@builtin(front_facing)front:bool,@builtin(sample_index)sampleIndex:u32)->@location(0)vec4f{
 // Positive uniform scale cancels when tangent vectors normalize. Rotate the
 // original local derivatives with the world normal, retaining localY for soil.
 let dx=reviewRotate(dpdx(in.local),in.rootRotation);let dy=reviewRotate(dpdy(in.local),in.rootRotation);let ux=dpdx(in.uv);let uy=dpdy(in.uv);
 // Physical bake reference: evaluate original source MASK at LOD0 for each
 // geometric MSAA sample, NOT the game's filtered fractional-footprint masks.
 let pigment=textureSampleLevel(pigmentMap,materialSampler,in.uv,0.);let leaf=M.controls.y>.5;
 if(in.local.y<0.||(leaf&&pigment.a<M.underside.w)){discard;}
 var n=normalize(in.normal);let detail=textureSampleLevel(normalMap,materialSampler,in.uv,0.).xyz*2.-vec3f(1);
 let determinant=ux.x*uy.y-ux.y*uy.x;let direction=select(-1.,1.,determinant>=0.);
 let tangent=dx*uy.y-dy*ux.y;let bitangent=dy*ux.x-dx*uy.x;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){
  let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;let sampled=normalize(detail);n=normalize(t*sampled.x+b*sampled.y+n*sampled.z);
 }
 // Native convention: map the original front normal before reversing the
 // complete vector on leaf backs. Wood retains its geometric front direction.
 var colour=pigment.rgb*in.colour;
 if(leaf&&!front){n=-n;colour=mix(colour,M.underside.rgb*in.colour,M.controls.x);}
 let exposure=clamp(in.exposure,0.,1.);let ao=clamp(in.canopyAO,0.,1.);let ndl=dot(n,normalize(C.sunExposure.xyz));
 let diffuse=(max(ndl,0.)+max(-ndl,0.)*M.controls.w)*(.22+.78*exposure*exposure)*(.35+.65*ao);
 let ambient=(.12+.55*exposure+.08*abs(n.y))*ao;
 if(C.screen.z==1.){return vec4f(1);}
 let rgb=max(colour*(diffuse+ambient)*C.sunExposure.w,vec3f(0));return vec4f(pow(rgb/(vec3f(1)+rgb),vec3f(1./2.2)),1);
}
`;

/** Camera ABI:32 f32 = mat4 viewProj, positionFocal, sunExposure, screen,
 * settings. Source records remain unchanged, Y up, metres. Immutable GPU roots
 * are [x,y,z,positiveUniformScale,yawRadians]. rootsByPrototype is a Map or object
 * keyed by prototype ID; omitted entries use one origin root, [] draws none.
 * Root rows are copied at construction; changes require a new review adapter.
 * draw(reference:true) uses original wood; false uses the requested woody LOD.
 * includeLeaves uses ORIGINAL leaves; a cluster candidate normally passes false
 * and draws its own clusters separately. No automatic tier/residency selection.
 */
export async function createForestLODNativeReference({device,sourceBase,woodBase,fetchAsset=fetch,format='rgba8unorm',samples=4,rootsByPrototype,woodShading='sample'}){
 check(device&&typeof sourceBase==='string'&&sourceBase&&typeof woodBase==='string'&&woodBase,'device and explicit source/wood URLs required');
 check(['sample','pixel'].includes(woodShading),'invalid reduced wood shading mode');
 check(samples===1||samples===4,'only native1/4-sample review supported');
 sourceBase=sourceBase.replace(/\/+$/,'')+'/';woodBase=woodBase.replace(/\/+$/,'')+'/';
 const owned=[],B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage;let destroyed=false,cameraReady=false,decodedBytes=0;
 const stats={reviewOnly:true,productionFallback:false,samples,woodShading,rootCount:0,rootBufferBytes:0,sourceMask:'LOD0 original source cutoff at each geometric sample; differs from game fractional coverage/mip integration',geometryUploads:0,immutableBufferBytes:0,cameraBytes:128,textureBytes:0,verifiedMapFiles:0,cameraWrites:0,draws:0,lastDraw:null,prototypes:[]};
 // Snapshot caller-owned placements before the first await. Never transform or
 // duplicate native records on the CPU, and never upload roots during draw.
 check(rootsByPrototype===undefined||rootsByPrototype instanceof Map||(rootsByPrototype!==null&&typeof rootsByPrototype==='object'&&!Array.isArray(rootsByPrototype)),'rootsByPrototype must be an ID mapping');
 const rootOverrides=new Map(),rootByteLimit=Math.min(device.limits.maxBufferSize,device.limits.maxStorageBufferBindingSize);let overrideRootBytes=0;
 if(rootsByPrototype!==undefined)for(const [key,rows]of rootsByPrototype instanceof Map?rootsByPrototype:Object.entries(rootsByPrototype)){
  const id=typeof key==='string'&&/^(0|[1-9][0-9]*)$/.test(key)?Number(key):key;
  check(uint(id)&&id<=0xffffffff&&!rootOverrides.has(id)&&Array.isArray(rows),'invalid or duplicate root prototype ID/array');
  overrideRootBytes+=rows.length*32;check(overrideRootBytes<=rootByteLimit,'root transforms exceed GPU storage binding limit');
  const data=new Float32Array(rows.length*8);
  for(const [instance,row]of rows.entries()){
   check((Array.isArray(row)||row instanceof Float32Array)&&row.length===5&&row.every(Number.isFinite)&&row[3]>0,'root must contain five finite values and positive scale');
   for(let k=0;k<5;k++)data[instance*8+k]=row[k];
   check(data.subarray(instance*8,instance*8+5).every(Number.isFinite)&&data[instance*8+3]>0,'root transform cannot be represented as finite positive-scale Float32');
  }
  rootOverrides.set(id,data);
 }
 const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 const checked=async(bytes,item,label)=>check(receipt(item)&&bytes.byteLength===item.bytes&&await hash(bytes)===item.sha256,label+' digest mismatch');
 async function raw(base,name,limit){
  check(safe(name),'unsafe asset path');const response=await fetchAsset(base+name);check(response.ok,'asset unavailable: '+name);
  const bytes=new Uint8Array(await response.arrayBuffer());check(bytes.byteLength<=limit,'asset exceeds byte bound: '+name);return bytes;
 }
 async function read(base,name,item){
  check(safe(name)&&receipt(item),'invalid asset receipt: '+name);const transport=item.gzip??item;check(receipt(transport),'invalid transport receipt');
  const encoded=await raw(base,item.gzip?transport.file:name,transport.bytes);await checked(encoded,transport,name+' encoded');let bytes=encoded;
  if(item.gzip){
   const reader=new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),chunks=[];let length=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;check(length<=item.bytes,'gzip expands beyond receipt: '+name);chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
   bytes=new Uint8Array(length);let cursor=0;for(const chunk of chunks){bytes.set(chunk,cursor);cursor+=chunk.byteLength;}
  }
  await checked(bytes,item,name+' decoded');decodedBytes+=bytes.byteLength;check(decodedBytes<=384*1024*1024,'review decoded asset budget384MiB exceeded');return bytes;
 }
 const json=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 const buffer=(data,usage,label)=>{check(data.byteLength<=device.limits.maxBufferSize,'GPU buffer exceeds device limit');const b=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});owned.push(b);device.queue.writeBuffer(b,0,data);if(!label.endsWith('camera128B'))stats.immutableBufferBytes+=data.byteLength;if(usage&(B.VERTEX|B.INDEX))stats.geometryUploads++;return b;};
 try{
  const manifestRaw=await raw(sourceBase,'manifest.json',4*1024*1024),source=json(manifestRaw),wood=json(await raw(woodBase,'manifest.json',4*1024*1024));
  check(source.format==='waterworld.forest-instances'&&source.version===2&&source.vertexStride===56&&source.units==='metres'&&source.upAxis==='Y'&&source.materialContract==='gene-surfaces-v3'&&Array.isArray(source.prototypes),'original native56B v2 source required');
  check(wood.format==='waterworld.forest-lod-wood-pilot'&&wood.version===1&&wood.vertexStride===56&&wood.units==='metres'&&wood.upAxis==='Y'&&Array.isArray(wood.prototypes)&&wood.prototypes.length>0&&wood.prototypes.length<=5,'woody pilot v1 required');
  const rootRanges=new Map();let rootCount=0;
  for(const p of wood.prototypes){
   check(uint(p.id)&&!rootRanges.has(p.id),'invalid or duplicate woody prototype ID');
   const data=rootOverrides.get(p.id),count=data?data.length/8:1;
   rootRanges.set(p.id,{rootFirst:rootCount,rootCount:count});rootCount+=count;
  }
  for(const id of rootOverrides.keys())check(rootRanges.has(id),'root placement names a missing woody prototype');
  check(rootCount<=0xffffffff&&Math.max(1,rootCount)*32<=rootByteLimit,'combined roots exceed GPU storage binding limit');
  const rootData=new Float32Array(Math.max(1,rootCount)*8);
  for(const p of wood.prototypes){const range=rootRanges.get(p.id);rootData.set(rootOverrides.get(p.id)??[0,0,0,1,0,0,0,0],range.rootFirst*8);}
  stats.rootCount=rootCount;stats.rootBufferBytes=rootData.byteLength;
  const manifestReceipt={bytes:manifestRaw.byteLength,sha256:await hash(manifestRaw)};
  check(same(wood.source?.manifest,manifestReceipt)||same(wood.source?.manifest,source.runtimePackaging?.sourceManifest),'woody source manifest identity differs');
  check(same(wood.source?.vertices,source.files?.['vertices.bin'])&&same(wood.source?.indices,source.files?.['indices.bin']),'woody source geometry identity differs');
  const vRaw=await read(sourceBase,'vertices.bin',source.files['vertices.bin']),iRaw=await read(sourceBase,'indices.bin',source.files['indices.bin']);
  check(vRaw.byteLength%56===0&&iRaw.byteLength%4===0,'unaligned source records');
  const vertices=new Float32Array(vRaw.buffer,vRaw.byteOffset,vRaw.byteLength/4),sourceWords=new Uint32Array(vRaw.buffer,vRaw.byteOffset,vRaw.byteLength/4),indices=new Uint32Array(iRaw.buffer,iRaw.byteOffset,iRaw.byteLength/4),vertexCount=vRaw.byteLength/56;
  const lightPointer=source.canopyShade;check(lightPointer?.file==='canopy-shade.json'&&lightPointer.bytes<=4*1024*1024,'pinned original canopy AO required');
  const light=json(await read(sourceBase,lightPointer.file,lightPointer)),aoItem=light.files?.['canopy-shade.bin'];
  check(light.format==='waterworld.native-canopy-light'&&light.version===1&&light.recipe?.version===1&&light.vertexCount===vertexCount&&aoItem?.bytes===Math.ceil(vertexCount/4)*4&&Array.isArray(light.prototypes)&&light.prototypes.length===source.prototypes.length&&Object.keys(light.source?.files??{}).length===3,'invalid original AO layout');
  for(const name of ['vertices.bin','indices.bin','roots.bin'])check(same(light.source.files[name],source.files[name]),'AO source mismatch: '+name);
  for(const p of source.prototypes){const own=light.prototypes.find(q=>q.id===p.id);check(own?.species===p.species,'AO specimen differs');
   for(const kind of ['wood','leaf']){const range=p[kind],part=own.membership?.[kind];check(uint(range?.firstIndex)&&uint(range.indexCount)&&range.indexCount>0&&range.indexCount%3===0&&range.firstIndex+range.indexCount<=indices.length&&part?.firstIndex===range.firstIndex&&part.indexCount===range.indexCount,'AO source membership differs');await checked(iRaw.subarray(range.firstIndex*4,(range.firstIndex+range.indexCount)*4),part.indices,'AO '+p.species+' '+kind+' membership');}
  }
  const aoRaw=await read(sourceBase,'canopy-shade.bin',aoItem);for(let at=vertexCount;at<aoRaw.length;at++)check(aoRaw[at]===255,'AO padding must stay neutral');
  const camera=buffer(new Float32Array(32),B.UNIFORM,'forest native review camera128B'),ao=buffer(aoRaw,B.STORAGE,'forest native review immutable original packed AO'),roots=buffer(rootData,B.STORAGE,'forest native review immutable32B roots'),nativeVertices=buffer(vRaw,B.VERTEX,'forest native review immutable original56B vertices'),dummy=buffer(new Uint32Array([0]),B.STORAGE,'forest native review unused identity mapping');
  const module=device.createShaderModule({label:'forest source LOD0 MASK and retained wood reference',code:SOURCE_SHADER}),errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');check(!errors.length,errors.map(m=>m.message).join('\n'));
  const frameLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform',minBindingSize:128}},{binding:1,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:S.VERTEX,buffer:{type:'read-only-storage',minBindingSize:32}}]}),materialLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.FRAGMENT,buffer:{type:'uniform',minBindingSize:32}},{binding:1,visibility:S.FRAGMENT,sampler:{}},{binding:2,visibility:S.FRAGMENT,texture:{}},{binding:3,visibility:S.FRAGMENT,texture:{}}]}),idLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX,buffer:{type:'read-only-storage'}}]}),layout=device.createPipelineLayout({bindGroupLayouts:[frameLayout,materialLayout,idLayout]});
  const woodModule=woodShading==='sample'?module:device.createShaderModule({label:'forest reduced wood shared pixel shading',code:SOURCE_SHADER.replaceAll('@interpolate(perspective,sample)','@interpolate(perspective,centroid)').replace(',@builtin(sample_index)sampleIndex:u32','')});
  const pipeline=(entryPoint,leaf,pixelWood=false)=>device.createRenderPipelineAsync({layout,vertex:{module:pixelWood?woodModule:module,entryPoint,buffers:[vertexLayout]},fragment:{module:pixelWood?woodModule:module,entryPoint:'nativeFS',targets:[{format}]},primitive:{topology:'triangle-list',frontFace:'ccw',cullMode:leaf?'none':'back'},depthStencil:{format:'depth32float',depthCompare:'less',depthWriteEnabled:true},multisample:{count:samples,alphaToCoverageEnabled:false}});
  const nativeWood=await pipeline('nativeVS',false),nativeLeaf=await pipeline('nativeVS',true),reducedWood=await pipeline('woodVS',false,true),frameGroup=device.createBindGroup({layout:frameLayout,entries:[{binding:0,resource:{buffer:camera}},{binding:1,resource:{buffer:ao}},{binding:2,resource:{buffer:roots}}]}),idsGroup=b=>device.createBindGroup({layout:idLayout,entries:[{binding:0,resource:{buffer:b}}]}),nativeIDs=idsGroup(dummy);
  const images=new Map(),verifiedMaps=new Map(),prototypes=new Map();
  async function mapBytes(map,p){
   check(receipt(map)&&safe(map.file)&&same(map,source.files[map.file])&&same(map,p.source?.native?.maps?.[map.file]),'map source identity differs');
   if(!verifiedMaps.has(map.file))verifiedMaps.set(map.file,read(sourceBase,map.file,map));
   return verifiedMaps.get(map.file);
  }
  async function image(map,p,encoding){
   check(map.encoding===encoding&&uint(map.width)&&uint(map.height)&&map.width>0&&map.height>0&&map.width<=4096&&map.height<=4096,'invalid native image dimensions/encoding');
   const bytes=await mapBytes(map,p);if(images.has(map.file)){const existing=images.get(map.file);check(existing.width===map.width&&existing.height===map.height&&existing.format===(encoding==='srgb'?'rgba8unorm-srgb':'rgba8unorm'),'conflicting native image layout');return existing;}const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}),{premultiplyAlpha:'none',colorSpaceConversion:'none',imageOrientation:'none'});
   try{check(bitmap.width===map.width&&bitmap.height===map.height,'source PNG dimensions changed');const texture=device.createTexture({label:'forest native review immutable '+map.file,size:[map.width,map.height],format:encoding==='srgb'?'rgba8unorm-srgb':'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST|T.RENDER_ATTACHMENT});owned.push(texture);device.queue.copyExternalImageToTexture({source:bitmap},{texture,premultipliedAlpha:false},[map.width,map.height]);stats.textureBytes+=map.width*map.height*4;images.set(map.file,texture);return texture;}finally{bitmap.close();}
  }
  const checkedVertices=new Uint8Array(vertexCount);
  function nativeParts(p,kind,membership){
   const range=p[kind],groups=new Map();
   for(let at=range.firstIndex;at<range.firstIndex+range.indexCount;at+=3){let material=-1;
    for(let k=0;k<3;k++){const id=indices[at+k];check(id<vertexCount,'source index outside original vertices');const start=id*14,slot=vertices[start+13];check(uint(slot)&&slot<p.nativeMaterials.length&&(kind==='wood'?vertices[start+6]===3:vertices[start+6]>=4),'source native kind/material differs');if(k===0)material=slot;else check(slot===material,'source triangle crosses materials');
     check(p.nativeMaterials[slot].name.startsWith('foliage_')===(kind==='leaf'),'source material/part mismatch');if(kind==='wood')membership[id]=1;
     if(!checkedVertices[id]){const row=vertices.subarray(start,start+14);check(row.every(Number.isFinite)&&Math.abs(Math.hypot(row[3],row[4],row[5])-1)<=.01,'invalid native vertex/normal');checkedVertices[id]=1;}
    }
    groups.set(material,(groups.get(material)??0)+3);
   }
   const packed=new Map([...groups].map(([material,count])=>[material,{material,data:new Uint32Array(count),cursor:0}]));
   for(let at=range.firstIndex;at<range.firstIndex+range.indexCount;at+=3){const part=packed.get(vertices[indices[at]*14+13]);part.data.set(indices.subarray(at,at+3),part.cursor);part.cursor+=3;}
   return [...packed.values()].map(part=>({material:part.material,indexCount:part.data.length,buffer:buffer(part.data,B.INDEX,'forest native review immutable '+p.species+' '+kind+' material'+part.material)}));
  }
  for(const p of wood.prototypes){
   const original=source.prototypes.find(q=>q.id===p.id);check(uint(p.id)&&original?.species===p.species&&!prototypes.has(p.id)&&Array.isArray(original.nativeMaterials)&&original.nativeMaterials.length>0&&original.nativeMaterials.length<=16&&Array.isArray(p.tiers)&&p.tiers.length===3,'invalid pilot specimen/materials/tiers');
   const materials=new Map();
   for(const [index,m]of original.nativeMaterials.entries()){
    check(m.index===index&&typeof m.name==='string'&&['roughness','underside','transmission','opacityThreshold'].every(key=>Number.isFinite(m[key])&&m[key]>=0&&m[key]<=1)&&Array.isArray(m.undersideReference)&&m.undersideReference.length===3&&m.undersideReference.every(x=>Number.isFinite(x)&&x>=0&&x<=1)&&['clamp','repeat'].includes(m.wrap),'invalid source material optics');
    const albedo=await image(m.albedo,original,'srgb'),normal=await image(m.normal,original,'linear');if(m.roughnessMap)await mapBytes(m.roughnessMap,original);
    const state=buffer(new Float32Array([m.underside,m.name.startsWith('foliage_')?1:0,m.roughness,m.transmission,...m.undersideReference.map(linear),m.opacityThreshold]),B.UNIFORM,'forest native review immutable original optics'),sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'nearest',addressModeU:m.wrap==='repeat'?'repeat':'clamp-to-edge',addressModeV:m.wrap==='repeat'?'repeat':'clamp-to-edge'});
    materials.set(index,device.createBindGroup({layout:materialLayout,entries:[{binding:0,resource:{buffer:state}},{binding:1,resource:sampler},{binding:2,resource:albedo.createView()},{binding:3,resource:normal.createView()}]}));
   }
   const membership=new Uint8Array(vertexCount),woodParts=nativeParts(original,'wood',membership),leafParts=nativeParts(original,'leaf',membership),tiers=new Map();
   for(const t of p.tiers){
    check(uint(t.tier)&&t.tier<=2&&!tiers.has(t.tier)&&Array.isArray(t.parts)&&t.parts.length>0,'invalid woody tier');
    const verticesRaw=await read(woodBase,t.vertices,wood.files[t.vertices]),indicesRaw=await read(woodBase,t.indices,wood.files[t.indices]),idsRaw=await read(woodBase,t.sourceVertexIDs,wood.files[t.sourceVertexIDs]);
    check(verticesRaw.byteLength%56===0&&indicesRaw.byteLength%12===0&&idsRaw.byteLength===verticesRaw.byteLength/56*4,'invalid woody retained record layout');
    const words=new Uint32Array(verticesRaw.buffer),localVertices=new Float32Array(verticesRaw.buffer),localIndices=new Uint32Array(indicesRaw.buffer),sourceIDs=new Uint32Array(idsRaw.buffer);let next=0;
    for(let local=0;local<sourceIDs.length;local++){const sourceID=sourceIDs[local];check(sourceID<vertexCount&&membership[sourceID]===1,'woody AO source ID leaves original specimen');for(let k=0;k<14;k++)check(words[local*14+k]===sourceWords[sourceID*14+k],'woody LOD changed an original retained vertex record');}
    for(const part of t.parts){check(uint(part.material)&&materials.has(part.material)&&!original.nativeMaterials[part.material].name.startsWith('foliage_')&&part.firstIndex===next&&uint(part.indexCount)&&part.indexCount>0&&part.indexCount%3===0&&next+part.indexCount<=localIndices.length,'woody material range overlap/hole');
     for(let at=next;at<next+part.indexCount;at++)check(localIndices[at]<sourceIDs.length&&localVertices[localIndices[at]*14+13]===part.material,'woody material/local index differs');next+=part.indexCount;
    }
    check(next===localIndices.length&&t.triangles===next/3,'incomplete woody index/triangle counts');
    const geometry=buffer(verticesRaw,B.VERTEX,'forest native review immutable '+p.species+' tier'+t.tier+' retained56B'),elements=buffer(indicesRaw,B.INDEX,'forest native review immutable woody indices'),sourceMap=buffer(idsRaw,B.STORAGE,'forest native review immutable AO source IDs');
    tiers.set(t.tier,{vertices:geometry,indices:elements,sourceIDs:idsGroup(sourceMap),parts:t.parts.map(part=>({...part})),triangles:t.triangles});
   }
   check([0,1,2].every(id=>tiers.has(id)),'missing woody tier; no raw fallback permitted');
   const placement=rootRanges.get(p.id);prototypes.set(p.id,{materials,woodParts,leafParts,tiers,...placement});stats.prototypes.push({id:p.id,species:p.species,...placement,referenceWoodTriangles:original.wood.indexCount/3*placement.rootCount,referenceLeafTriangles:original.leaf.indexCount/3*placement.rootCount,referenceWoodTrianglesPerRoot:original.wood.indexCount/3,referenceLeafTrianglesPerRoot:original.leaf.indexCount/3,woodTiers:[...tiers].map(([tier,value])=>({tier,triangles:value.triangles*placement.rootCount,trianglesPerRoot:value.triangles}))});
  }
  stats.verifiedMapFiles=verifiedMaps.size;stats.decodedBytes=decodedBytes;stats.sourceManifest=manifestReceipt;stats.canopyShade={...lightPointer};stats.roughness='Source roughness maps verified; pilot lighting is Lambert/ambient, not specular';
  return{
   stats,
   writeCamera(values){check(!destroyed&&values instanceof Float32Array&&values.length===32&&values.every(Number.isFinite),'camera must be32 finite Float32 values');device.queue.writeBuffer(camera,0,values);cameraReady=true;stats.cameraWrites++;},
   draw(pass,{prototypeID,reference=false,woodTier=0,includeLeaves=true}={}){
    check(!destroyed&&cameraReady&&uint(prototypeID)&&prototypes.has(prototypeID)&&typeof reference==='boolean'&&uint(woodTier)&&woodTier<=2&&typeof includeLeaves==='boolean','invalid explicit native review draw');
    const p=prototypes.get(prototypeID),tier=p.tiers.get(woodTier);let triangles=0,draws=0;pass.setBindGroup(0,frameGroup);
    if(reference){pass.setPipeline(nativeWood);pass.setVertexBuffer(0,nativeVertices);pass.setBindGroup(2,nativeIDs);for(const part of p.woodParts){pass.setBindGroup(1,p.materials.get(part.material));pass.setIndexBuffer(part.buffer,'uint32');pass.drawIndexed(part.indexCount,p.rootCount,0,0,p.rootFirst);triangles+=part.indexCount/3*p.rootCount;draws++;}}
    else{pass.setPipeline(reducedWood);pass.setVertexBuffer(0,tier.vertices);pass.setIndexBuffer(tier.indices,'uint32');pass.setBindGroup(2,tier.sourceIDs);for(const part of tier.parts){pass.setBindGroup(1,p.materials.get(part.material));pass.drawIndexed(part.indexCount,p.rootCount,part.firstIndex,0,p.rootFirst);triangles+=part.indexCount/3*p.rootCount;draws++;}}
    if(includeLeaves){pass.setPipeline(nativeLeaf);pass.setVertexBuffer(0,nativeVertices);pass.setBindGroup(2,nativeIDs);for(const part of p.leafParts){pass.setBindGroup(1,p.materials.get(part.material));pass.setIndexBuffer(part.buffer,'uint32');pass.drawIndexed(part.indexCount,p.rootCount,0,0,p.rootFirst);triangles+=part.indexCount/3*p.rootCount;draws++;}}
    stats.draws+=draws;stats.lastDraw={prototypeID,reference,woodTier:reference?null:woodTier,includeLeaves,rootFirst:p.rootFirst,rootCount:p.rootCount,triangles,draws};
   },
   destroy(){if(!destroyed){destroyed=true;for(const item of owned)item.destroy();}},
  };
 }catch(error){for(const item of owned)item.destroy();throw error;}
}
