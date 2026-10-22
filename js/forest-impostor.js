// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// These atlases are rendered from the native specimen, never invented crowns.
// Their initial projected-size policy is authored and awaits rendered error
// qualification. No global appearance-error certification is implied.
export const FOREST_IMPOSTOR_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/saba/impostors/manifest.json',
  'prototype-0-oak/albedo.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-0-oak/albedo.rgba16f.bin.gz',
  'prototype-0-oak/normal-depth.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-0-oak/normal-depth.rgba16f.bin.gz',
  'prototype-1-maple/albedo.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-1-maple/albedo.rgba16f.bin.gz',
  'prototype-1-maple/normal-depth.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-1-maple/normal-depth.rgba16f.bin.gz',
  'prototype-2-birch/albedo.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-2-birch/albedo.rgba16f.bin.gz',
  'prototype-2-birch/normal-depth.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-2-birch/normal-depth.rgba16f.bin.gz',
  'prototype-3-elm/albedo.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-3-elm/albedo.rgba16f.bin.gz',
  'prototype-3-elm/normal-depth.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-3-elm/normal-depth.rgba16f.bin.gz',
  'prototype-4-chestnut/albedo.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-4-chestnut/albedo.rgba16f.bin.gz',
  'prototype-4-chestnut/normal-depth.rgba16f.bin.gz':'assets/forest-scenery/saba/impostors/prototype-4-chestnut/normal-depth.rgba16f.bin.gz',
});
const forestAtlasFinite=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const forestAtlasReceipt=r=>r&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=32*1024*1024&&/^[a-f0-9]{64}$/.test(r.sha256)&&/^[a-z0-9./-]+$/.test(r.file)&&!r.file.startsWith('/')&&!r.file.split('/').includes('..');
export function validateForestImpostors(document,forest){
  const layout=document?.layout,grid=layout?.grid;
  if(document?.format!=='waterworld.native-impostors'||document.version!==1||document.complete!==true||document.units!=='metres'||document.upAxis!=='Y'||
    !forestAtlasFinite(grid,2)||grid[0]!==grid[1]||![8,16].includes(grid[0])||!forestAtlasFinite(layout.atlasPixels,2)||layout.atlasPixels.some(n=>n!==1024)||
    layout.tilePixels!==1024/grid[0]||!Array.isArray(layout.views)||layout.views.length!==grid[0]*grid[1]||!Array.isArray(document.prototypes)||document.prototypes.length!==forest.prototypes.length)throw Error('Unsupported native forest atlas');
  for(const [index,view]of layout.views.entries()){
    if(view.index!==index||view.row!==Math.floor(index/grid[0])||view.column!==index%grid[0]||!['direction','right','up'].every(key=>forestAtlasFinite(view[key],3)&&Math.abs(Math.hypot(...view[key])-1)<1e-5))throw Error('Invalid forest atlas camera');
    for(const [a,b]of [['direction','right'],['direction','up'],['right','up']])if(Math.abs(view[a].reduce((sum,v,k)=>sum+v*view[b][k],0))>1e-5)throw Error('Invalid forest atlas basis');
  }
  for(const name of ['vertices.bin','indices.bin','roots.bin'])if(document.source?.files?.[name]?.sha256!==forest.files[name].sha256||document.source.files[name].bytes!==forest.files[name].bytes)throw Error('Forest atlas source geometry mismatch');
  for(const [index,p]of document.prototypes.entries()){
    const source=forest.prototypes[index];
    if(p.id!==source.id||p.species!==source.species||!forestAtlasFinite(p.centre,3)||p.centre.some((v,k)=>v!==source.centre[k])||p.radius!==source.radius||
      !(p.projection?.extent>=source.radius&&p.projection.extent<source.radius*1.2)||p.detailedGeometry?.wood?.firstIndex!==source.wood.firstIndex||
      p.detailedGeometry.wood.indexCount!==source.wood.indexCount||p.detailedGeometry?.leaf?.firstIndex!==source.leaf.firstIndex||p.detailedGeometry.leaf.indexCount!==source.leaf.indexCount)throw Error('Forest atlas specimen mismatch');
    for(const material of source.nativeMaterials)for(const kind of ['albedo','normal','roughnessMap'].filter(key=>material[key])){
      const map=material[kind],receipt=document.source.files[map.file];if(receipt?.bytes!==map.bytes||receipt.sha256!==map.sha256)throw Error('Forest atlas native surface mismatch');
    }
    for(const kind of ['albedo','normalDepth']){
      const receipt=p.outputs?.[kind];
      if(!forestAtlasReceipt(receipt)||receipt.bytes!==1024*1024*8||!forestAtlasReceipt(receipt.gzip)||receipt.gzip.uncompressedSHA256!==receipt.sha256)throw Error('Invalid forest atlas receipt');
    }
  }
  return document;
}
export async function loadForestImpostors({forest,fetchAsset=fetch,assets=FOREST_IMPOSTOR_ASSETS}){
  const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered forest atlas asset: '+name);const r=await fetchAsset(assets[name]);if(!r.ok)throw Error('Forest atlas unavailable ('+r.status+'): '+name);return r;};
  const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
  if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Forest atlas requires receipt verification and gzip decoding');
  const manifestBytes=await(await load('manifest.json')).arrayBuffer();
  if(forest.impostors&&(forest.impostors.file!=='impostors/manifest.json'||manifestBytes.byteLength!==forest.impostors.bytes||await digest(manifestBytes)!==forest.impostors.sha256))throw Error('Forest atlas manifest digest mismatch');
  const manifest=validateForestImpostors(JSON.parse(new TextDecoder().decode(manifestBytes)),forest);
  const streams=await Promise.all(manifest.prototypes.map(async prototype=>{
    const row={};for(const kind of ['albedo','normalDepth']){
      const receipt=prototype.outputs[kind],compressed=await(await load(receipt.gzip.file)).arrayBuffer();
      if(compressed.byteLength!==receipt.gzip.bytes||await digest(compressed)!==receipt.gzip.sha256)throw Error('Forest atlas gzip digest mismatch');
      const raw=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      if(raw.byteLength!==receipt.bytes||await digest(raw)!==receipt.sha256)throw Error('Forest atlas decoded digest mismatch');row[kind]=raw;
    }return row;
  }));
  return {manifest,streams};
}

export const FOREST_ATLAS_MIPS_WGSL=/* wgsl */`
@group(0)@binding(0)var forestAtlasMipColour:texture_2d_array<f32>;
@group(0)@binding(1)var forestAtlasMipSurface:texture_2d_array<f32>;
@group(0)@binding(2)var forestAtlasMipColourOut:texture_storage_2d_array<rgba16float,write>;
@group(0)@binding(3)var forestAtlasMipSurfaceOut:texture_storage_2d_array<rgba16float,write>;
@compute @workgroup_size(8,8,1)fn main(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(forestAtlasMipColourOut);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy)*2;var colour=vec4f(0);var surface=vec4f(0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
   let q=p+vec2i(x,y);colour+=textureLoad(forestAtlasMipColour,q,i32(id.z),0);surface+=textureLoad(forestAtlasMipSurface,q,i32(id.z),0);
 }}
 textureStore(forestAtlasMipColourOut,vec2i(id.xy),i32(id.z),colour*.25);
 textureStore(forestAtlasMipSurfaceOut,vec2i(id.xy),i32(id.z),surface*.25);
}
`;

export async function createForestImpostorResources({device,shader,pack,forest}){
  validateForestImpostors(pack.manifest,forest);
  const count=forest.prototypes.length,layout=pack.manifest.layout,grid=layout.grid[0],tile=layout.tilePixels,viewCount=layout.views.length;
  const levels=1+Math.log2(tile),allocated=[],T=GPUTextureUsage,B=GPUBufferUsage;
  try{
    const texture=label=>{const t=device.createTexture({label,size:[1024,1024,count],format:'rgba16float',mipLevelCount:levels,usage:T.TEXTURE_BINDING|T.STORAGE_BINDING|T.COPY_DST});allocated.push(t);return t;};
    const albedo=texture('forest immutable native impostor pigment'),normalDepth=texture('forest immutable native impostor normal and depth');
    for(let layer=0;layer<count;layer++)for(const [kind,t]of [['albedo',albedo],['normalDepth',normalDepth]]){
      const raw=pack.streams[layer]?.[kind];if(!(raw instanceof ArrayBuffer)||raw.byteLength!==1024*1024*8)throw Error('Incomplete native forest atlas upload');
      device.queue.writeTexture({texture:t,origin:[0,0,layer]},raw,{bytesPerRow:1024*8},[1024,1024,1]);
    }
    const code=await shader(FOREST_ATLAS_MIPS_WGSL,'forest native impostor mips'),pipeline=await device.createComputePipelineAsync({label:'forest filter native impostor coverage',layout:'auto',compute:{module:code,entryPoint:'main'}});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);
    for(let level=1;level<levels;level++){
      const views=[albedo,normalDepth,albedo,normalDepth].map((t,i)=>t.createView({dimension:'2d-array',baseMipLevel:i<2?level-1:level,mipLevelCount:1}));
      pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:views.map((resource,binding)=>({binding,resource}))}));pass.dispatchWorkgroups(Math.ceil((1024>>level)/8),Math.ceil((1024>>level)/8),count);
    }
    pass.end();device.queue.submit([encoder.finish()]);
    // Header, then up to 256 actual camera bases, then prototype parameters.
    const fullSphere=layout.views.some(view=>view.direction[1]<0);
    const values=new Float32Array(4+256*12+count*8);values.set([grid,tile,viewCount,fullSphere?1:0]);
    for(const view of layout.views)values.set([...view.direction,0,...view.right,0,...view.up,0],4+view.index*12);
    for(const p of pack.manifest.prototypes){
      const leaf=forest.prototypes[p.id].nativeMaterials.find(m=>m.name.startsWith('foliage'))??forest.prototypes[p.id].nativeMaterials[0];
      values.set([...p.centre,p.projection.extent,leaf.roughness,leaf.transmission,0,0],4+256*12+p.id*8);
    }
    const metadata=device.createBuffer({label:'forest immutable native impostor cameras',size:values.byteLength,usage:B.STORAGE|B.COPY_DST});allocated.push(metadata);device.queue.writeBuffer(metadata,0,values);
    const indices=device.createBuffer({label:'forest immutable impostor quad indices',size:24,usage:B.INDEX|B.COPY_DST});allocated.push(indices);device.queue.writeBuffer(indices,0,new Uint32Array([0,1,2,0,2,3]));
    const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    return{albedo,normalDepth,metadata,indices,sampler,fullSphere,views:viewCount,
      bind(pipeline){return device.createBindGroup({layout:pipeline.getBindGroupLayout(3),entries:[
        {binding:0,resource:albedo.createView({dimension:'2d-array'})},{binding:1,resource:normalDepth.createView({dimension:'2d-array'})},
        {binding:2,resource:sampler},{binding:3,resource:{buffer:metadata}}]});},destroy(){for(const r of allocated)r.destroy();}};
  }catch(error){for(const r of allocated)r.destroy();throw error;}
}

export const FOREST_IMPOSTOR_WGSL=/* wgsl */`
struct ForestAtlasView {direction:vec4f,right:vec4f,up:vec4f};
struct ForestAtlasPrototype {centreExtent:vec4f,material:vec4f};
struct ForestAtlasTable {config:vec4f,views:array<ForestAtlasView,256>,prototypes:array<ForestAtlasPrototype>};
@group(3)@binding(0)var forestAtlasAlbedo:texture_2d_array<f32>;
@group(3)@binding(1)var forestAtlasNormalDepth:texture_2d_array<f32>;
@group(3)@binding(2)var forestAtlasSampler:sampler;
@group(3)@binding(3)var<storage,read>forestAtlasTable:ForestAtlasTable;
struct ForestImpostorVertex {
 @builtin(position)pos:vec4f,@location(0)plane:vec3f,@location(1)rootScale:vec4f,
 @location(2)yawTint:vec4f,@location(3)@interpolate(flat)prototype:u32,
 @location(4)@interpolate(flat)frames:vec3u,@location(5)@interpolate(flat)weights:vec3f,
};
fn forestAtlasRotate(p:vec3f,yaw:f32)->vec3f {let c=cos(yaw);let s=sin(yaw);return vec3f(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
fn forestAtlasEncode(direction:vec3f,fullSphere:bool)->vec2f{
 let p=direction/max(dot(abs(direction),vec3f(1)),1e-8);
 if(!fullSphere){return vec2f(p.x+p.z,p.x-p.z);}
 if(p.y>=0.){return p.xz;}
 return (vec2f(1)-abs(p.zx))*select(vec2f(-1),vec2f(1),p.xz>=vec2f(0));
}
fn forestAtlasFrame(cell:vec2i,grid:i32,fullSphere:bool)->u32{
 var p=cell;
 // Octahedral seam neighbours occupy the reflected opposite atlas edge.
 // Clamping those views would pin the lower pole to one arbitrary azimuth.
 if(fullSphere){
   if(p.x<0){p.x=-p.x-1;p.y=grid-p.y-1;}else if(p.x>=grid){p.x=2*grid-p.x-1;p.y=grid-p.y-1;}
   if(p.y<0){p.y=-p.y-1;p.x=grid-p.x-1;}else if(p.y>=grid){p.y=2*grid-p.y-1;p.x=grid-p.x-1;}
 }else{p=clamp(p,vec2i(0),vec2i(grid-1));}
 return u32(p.y*grid+p.x);
}
@vertex fn forestImpostorVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->ForestImpostorVertex{
 let rootID=forestVisible[forestBin.x+instance];let root=forestRoots[rootID];let prototype=u32(root.identity.x);let source=forestAtlasTable.prototypes[prototype];
 let centre=root.rootScale.xyz+forestAtlasRotate(source.centreExtent.xyz,root.yawColour.x)*root.rootScale.w;
 let direction=normalize(forestAtlasRotate(F.camPos.xyz-centre,-root.yawColour.x));
 let grid=i32(forestAtlasTable.config.x);let fullSphere=forestAtlasTable.config.w>.5;
 let coordinates=(forestAtlasEncode(direction,fullSphere)+1.)*.5*f32(grid)-.5;
 let cell=vec2i(floor(coordinates));let fraction=fract(coordinates);var frames:vec3u;var weights:vec3f;
 if(fraction.x+fraction.y<=1.){frames=vec3u(forestAtlasFrame(cell,grid,fullSphere),forestAtlasFrame(cell+vec2i(1,0),grid,fullSphere),forestAtlasFrame(cell+vec2i(0,1),grid,fullSphere));weights=vec3f(1.-fraction.x-fraction.y,fraction.x,fraction.y);}
 else{frames=vec3u(forestAtlasFrame(cell+vec2i(1,1),grid,fullSphere),forestAtlasFrame(cell+vec2i(0,1),grid,fullSphere),forestAtlasFrame(cell+vec2i(1,0),grid,fullSphere));weights=vec3f(fraction.x+fraction.y-1.,1.-fraction.x,1.-fraction.y);}
 let corners=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,1));let q=corners[vertex];
 let plane=centre+(normalize(F.camRight.xyz)*q.x+normalize(F.camUp.xyz)*q.y)*source.centreExtent.w*root.rootScale.w;
 var o:ForestImpostorVertex;o.plane=plane;o.rootScale=root.rootScale;o.yawTint=root.yawColour;o.prototype=prototype;o.frames=frames;o.weights=weights;
 o.pos=F.viewProj*vec4f(plane-F.camPos.xyz,1);return o;
}
struct ForestAtlasSample {pigment:vec4f,normal:vec3f,distance:f32};
fn forestAtlasFetch(frame:u32,layer:u32,uv:vec2f,lod:f32)->ForestSurface{
 let grid=u32(forestAtlasTable.config.x);let tile=forestAtlasTable.config.y;let border=.5*exp2(ceil(lod))/tile;
 let local=clamp(uv,vec2f(border),vec2f(1.-border));let origin=vec2f(f32(frame%grid),f32(frame/grid));let atlas=(origin+local)/f32(grid);
 var result:ForestSurface;result.pigment=textureSampleLevel(forestAtlasAlbedo,forestAtlasSampler,atlas,i32(layer),lod);result.detail=textureSampleLevel(forestAtlasNormalDepth,forestAtlasSampler,atlas,i32(layer),lod);return result;
}
fn forestAtlasRay(frame:u32,layer:u32,origin:vec3f,ray:vec3f,dx:vec3f,dy:vec3f)->ForestAtlasSample{
 let camera=forestAtlasTable.views[frame];let source=forestAtlasTable.prototypes[layer].centreExtent;let extent=source.w;
 let denominator=dot(ray,camera.direction.xyz);var result:ForestAtlasSample;result.pigment=vec4f(0);result.normal=vec3f(0);result.distance=0.;
 if(abs(denominator)<.01){return result;}
 var distance=dot(source.xyz-origin,camera.direction.xyz)/denominator;
 let footprint=max(length(vec2f(dot(dx,camera.right.xyz),dot(dx,camera.up.xyz))),length(vec2f(dot(dy,camera.right.xyz),dot(dy,camera.up.xyz))))*.5/extent*forestAtlasTable.config.y;
 let lod=clamp(log2(max(1.,footprint)),0.,log2(forestAtlasTable.config.y));
 var uv=vec2f(0);var sampled:ForestSurface;
 for(var iteration=0u;iteration<3u;iteration++){
   let relative=origin+ray*distance-source.xyz;uv=vec2f(.5+.5*dot(relative,camera.right.xyz)/extent,.5-.5*dot(relative,camera.up.xyz)/extent);
   if(any(uv<vec2f(0))||any(uv>vec2f(1))){return result;}
   sampled=forestAtlasFetch(frame,layer,uv,lod);if(sampled.pigment.a<=1e-6){return result;}
   let z=extent*(1.-2.*sampled.detail.a/sampled.pigment.a);distance=(z-dot(origin-source.xyz,camera.direction.xyz))/denominator;
 }
 result.pigment=sampled.pigment;result.normal=sampled.detail.xyz;result.distance=distance;return result;
}
struct ForestImpostorOutput {@location(0)colour:vec4f,@builtin(frag_depth)depth:f32};
@fragment fn forestImpostorFS(in:ForestImpostorVertex)->ForestImpostorOutput{
 let scale=in.rootScale.w;let yaw=in.yawTint.x;
 let origin=forestAtlasRotate(F.camPos.xyz-in.rootScale.xyz,-yaw)/scale;
 let ray=normalize(forestAtlasRotate(in.plane-F.camPos.xyz,-yaw));
 let dx=forestAtlasRotate(dpdx(in.plane),-yaw)/scale;let dy=forestAtlasRotate(dpdy(in.plane),-yaw)/scale;
 var pigment=vec4f(0);var normal=vec3f(0);var distance=0.;
 for(var i=0u;i<3u;i++){
   let sampled=forestAtlasRay(in.frames[i],in.prototype,origin,ray,dx,dy);let weight=in.weights[i];
   pigment+=sampled.pigment*weight;normal+=sampled.normal*weight;distance+=sampled.distance*sampled.pigment.a*weight;
 }
 var o:ForestImpostorOutput;o.colour=vec4f(0);o.depth=0.;
 if(pigment.a<=1e-6||dot(normal,normal)<1e-10){return o;}
 let local=origin+ray*(distance/pigment.a);let world=in.rootScale.xyz+forestAtlasRotate(local,yaw)*scale;
 let projected=F.viewProj*vec4f(world-F.camPos.xyz,1);if(projected.w<=0.){return o;}
 let n=normalize(forestAtlasRotate(normal,yaw));let material=forestAtlasTable.prototypes[in.prototype].material;
 let colour=pigment.rgb/pigment.a*in.yawTint.yzw;let nDotL=dot(n,F.sunDir.xyz);
 let lit=landFinish(world,n,colour,max(nDotL,0.)+max(-nDotL,0.)*material.y,.2+max(n.y,0.)*.42,0.,material.x);
 o.colour=vec4f(lit.rgb,pigment.a);o.depth=clamp(projected.z/projected.w,0.,1.);return o;
}
`;
