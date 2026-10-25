// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Authored intermediate optical volumes from original native leaf-area fields.
// Neither voxel spacing nor ray-step bounds certify native appearance error.
export const FOREST_VOLUME_ASSETS=Object.freeze({
 'manifest.json':'assets/forest-scenery/saba/volumes/manifest.json',
 'prototype-0-oak/field.rgba16f.bin.gz':'assets/forest-scenery/saba/volumes/prototype-0-oak/field.rgba16f.bin.gz',
 'prototype-0-oak/exposure.r8.bin.gz':'assets/forest-scenery/saba/volumes/prototype-0-oak/exposure.r8.bin.gz',
 'prototype-1-maple/field.rgba16f.bin.gz':'assets/forest-scenery/saba/volumes/prototype-1-maple/field.rgba16f.bin.gz',
 'prototype-1-maple/exposure.r8.bin.gz':'assets/forest-scenery/saba/volumes/prototype-1-maple/exposure.r8.bin.gz',
 'prototype-2-birch/field.rgba16f.bin.gz':'assets/forest-scenery/saba/volumes/prototype-2-birch/field.rgba16f.bin.gz',
 'prototype-2-birch/exposure.r8.bin.gz':'assets/forest-scenery/saba/volumes/prototype-2-birch/exposure.r8.bin.gz',
 'prototype-3-elm/field.rgba16f.bin.gz':'assets/forest-scenery/saba/volumes/prototype-3-elm/field.rgba16f.bin.gz',
 'prototype-3-elm/exposure.r8.bin.gz':'assets/forest-scenery/saba/volumes/prototype-3-elm/exposure.r8.bin.gz',
 'prototype-4-chestnut/field.rgba16f.bin.gz':'assets/forest-scenery/saba/volumes/prototype-4-chestnut/field.rgba16f.bin.gz',
 'prototype-4-chestnut/exposure.r8.bin.gz':'assets/forest-scenery/saba/volumes/prototype-4-chestnut/exposure.r8.bin.gz',
});
const forestVolumeMaxBytes=256*1024*1024;
const forestVolumeUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestVolumeVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const forestVolumeReceipt=r=>forestVolumeUint(r?.bytes)&&r.bytes>0&&r.bytes<=forestVolumeMaxBytes&&/^[a-f0-9]{64}$/.test(r.sha256??'');
const forestVolumeSame=(a,b)=>forestVolumeReceipt(a)&&forestVolumeReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const forestVolumeHalf=b=>{const s=b&0x8000?-1:1,e=(b>>10)&31,m=b&1023;return e===0?s*m*2**-24:e===31?(m?NaN:s*Infinity):s*(1+m/1024)*2**(e-15);};
function forestVolumeManifest(m,forest=null){
 if(m?.format!=='waterworld.native-forest-volume'||m.version!==1||m.recipe?.version!==1||m.recipe.nativeGroundPlaneY!==0||m.recipe.extinction!==.5||
  !forestVolumeReceipt(m.source?.nativeFieldManifest)||!forestVolumeReceipt(m.source?.method)||m.source.method.file!=='scripts/prepare-forest-volume.py'||
  !Array.isArray(m.prototypes)||m.prototypes.length<1||m.prototypes.length>16||!m.files||m.appearanceErrorSupported===true||m.geometryErrorSupported===true)throw Error('Invalid native forest volume manifest');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!forestVolumeReceipt(m.source?.files?.[name])||(forest&&!forestVolumeSame(m.source.files[name],forest.files?.[name])))throw Error('Native forest volume source mismatch: '+name);
 if(Object.keys(m.source.files).length!==3)throw Error('Unexpected native forest volume source streams');
 if(forest&&(!Array.isArray(forest.prototypes)||forest.prototypes.length!==m.prototypes.length))throw Error('Native forest volume specimen count mismatch');
 for(const [id,p]of m.prototypes.entries()){
  if(p?.id!==id||typeof p.species!=='string'||!/^[a-z]+$/.test(p.species)||!forestVolumeVector(p.originXYZ,3)||!forestVolumeVector(p.dimensionsXYZ,3)||
   p.dimensionsXYZ.some(n=>!forestVolumeUint(n)||n<2||n>256)||!Number.isFinite(p.cellMetres)||p.cellMetres<=0||p.cellMetres>4||
   !forestVolumeVector(p.low,3)||!forestVolumeVector(p.high,3)||!forestVolumeReceipt(p.sourceField)||typeof p.sourceField.file!=='string'||!p.sourceField.file||
   !Number.isFinite(p.samplingFootprintMetres)||p.samplingFootprintMetres<Math.sqrt(3)*p.cellMetres-1e-6||
   (forest&&(p.id!==forest.prototypes[id].id||p.species!==forest.prototypes[id].species)))throw Error('Invalid native forest volume specimen');
  for(let k=0;k<3;k++){
   const low=Math.max(k===1?0:-Infinity,p.originXYZ[k]-.5*p.cellMetres),high=p.originXYZ[k]+(p.dimensionsXYZ[k]-.5)*p.cellMetres;
   if(Math.abs(p.low[k]-low)>1e-5||Math.abs(p.high[k]-high)>1e-5||high<=low)throw Error('Native forest volume bounds do not match voxel centres');
  }
  const voxels=p.dimensionsXYZ.reduce((a,b)=>a*b,1),stem=`prototype-${id}-${p.species}/`;
  for(const [key,suffix,stride]of [['field','field.rgba16f.bin',8],['exposure','exposure.r8.bin',1]]){
   const r=p[key],entry=m.files[r?.file];
   if(!forestVolumeReceipt(r)||r.bytes>128*1024*1024||r.file!==stem+suffix||r.bytes!==voxels*stride||!forestVolumeReceipt(r.gzip)||r.gzip.file!==r.file+'.gz'||
    !forestVolumeSame(entry,r)||!forestVolumeSame(entry?.gzip,r.gzip)||entry.gzip.file!==r.gzip.file)throw Error('Invalid native forest volume stream: '+key);
  }
 }
 if(Object.keys(m.files).length!==m.prototypes.length*2)throw Error('Unexpected native forest volume streams');
 return m;
}

export async function loadForestVolumes({forest,receipt=forest?.volume,fetchAsset=fetch,assets=FOREST_VOLUME_ASSETS}){
 if(receipt==null)return null;
 if(!forestVolumeReceipt(receipt)||receipt.file!=='volumes/manifest.json'||receipt.bytes>4*1024*1024)throw Error('Invalid native forest volume pointer');
 if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Native forest volumes require verified gzip transport');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered native forest volume asset: '+name);const r=await fetchAsset(assets[name]);if(!r.ok)throw Error('Native forest volume asset unavailable: '+name);return r.arrayBuffer();};
 const json=await load('manifest.json');if(json.byteLength!==receipt.bytes||await digest(json)!==receipt.sha256)throw Error('Native forest volume manifest digest mismatch');
 const manifest=forestVolumeManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json)),forest),prototypes=[];
 const pending=new Map(manifest.prototypes.flatMap(p=>['field','exposure'].map(key=>[p[key].gzip.file,load(p[key].gzip.file).then(v=>({ok:true,v}),e=>({ok:false,e}))])));
 // Decode one immutable stream at a time; do not multiply the region's peak
 // memory by issuing every 3D field decompression simultaneously.
 for(const p of manifest.prototypes){const row={};for(const key of ['field','exposure']){
  const r=p[key],res=await pending.get(r.gzip.file);if(!res.ok)throw res.e;const encoded=res.v;if(encoded.byteLength!==r.gzip.bytes||await digest(encoded)!==r.gzip.sha256)throw Error('Native forest volume encoded digest mismatch');
  const raw=await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(raw.byteLength!==r.bytes||await digest(raw)!==r.sha256)throw Error('Native forest volume decoded digest mismatch');row[key]=new Uint8Array(raw);
 }
  const view=new DataView(row.field.buffer,row.field.byteOffset,row.field.byteLength);
  for(let at=0;at<row.field.byteLength;at+=8){const density=forestVolumeHalf(view.getUint16(at+6,true));
   if(!Number.isFinite(density)||density<0)throw Error('Nonfinite/negative native forest volume density');
   for(let c=0;c<3;c++){const value=forestVolumeHalf(view.getUint16(at+c*2,true));if(!Number.isFinite(value)||value<0||(density===0&&value!==0))throw Error('Invalid native forest volume pigment moment');}
  }
  prototypes.push(row);
 }
 return{manifest,prototypes,sourceValidated:true};
}

export function createForestVolumeResources({device,pack}){
 const manifest=forestVolumeManifest(pack?.manifest);if(pack.sourceValidated!==true||!Array.isArray(pack.prototypes)||pack.prototypes.length!==manifest.prototypes.length)throw Error('Unverified native forest volume resources');
 const allocated=[],rows=[],bindings=new WeakMap(),T=GPUTextureUsage,B=GPUBufferUsage;let immutableBytes=0;
 try{
  const sampler=device.createSampler({label:'forest volume immutable trilinear sampler',minFilter:'linear',magFilter:'linear',mipmapFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',addressModeW:'clamp-to-edge'});
  for(const p of manifest.prototypes){const raw=pack.prototypes[p.id],size=p.dimensionsXYZ;
   if(size.some(n=>n>device.limits.maxTextureDimension3D)||!(raw?.field instanceof Uint8Array)||raw.field.byteLength!==p.field.bytes||!(raw.exposure instanceof Uint8Array)||raw.exposure.byteLength!==p.exposure.bytes)throw Error('Incomplete/oversized native forest volume upload');
   const texture=(format,label)=>{const t=device.createTexture({label,dimension:'3d',size,format,mipLevelCount:1,usage:T.TEXTURE_BINDING|T.COPY_DST});allocated.push(t);return t;};
   const field=texture('rgba16float','forest volume immutable native pigment density'),exposure=texture('r8unorm','forest volume immutable native escape');
   for(const [texture,bytes,stride]of [[field,raw.field,8],[exposure,raw.exposure,1]])device.queue.writeTexture({texture},bytes,{bytesPerRow:size[0]*stride,rowsPerImage:size[1]},size);
   const targetStep=Math.max(.35,Math.min(.5,p.cellMetres*.5)),diagonal=Math.hypot(...p.low.map((v,k)=>p.high[k]-v)),maxStep=Math.max(targetStep,diagonal/64);
   const values=new Float32Array([...p.originXYZ,p.cellMetres,...size,manifest.recipe.extinction,...p.low,targetStep,...p.high,0]);
   const metadata=device.createBuffer({label:'forest volume immutable voxel metadata',size:64,usage:B.UNIFORM|B.COPY_DST});allocated.push(metadata);device.queue.writeBuffer(metadata,0,values);
   immutableBytes+=raw.field.byteLength+raw.exposure.byteLength+64;rows.push({field,exposure,metadata,maxStep});
  }
  const indices=device.createBuffer({label:'forest volume immutable procedural box indices',size:144,usage:B.INDEX|B.COPY_DST});allocated.push(indices);device.queue.writeBuffer(indices,0,Uint32Array.from({length:36},(_,i)=>i));immutableBytes+=144;
  return{prototypes:manifest.prototypes,fieldBounds:manifest.prototypes.map(p=>({low:p.low,high:p.high})),samplingFootprints:manifest.prototypes.map(p=>Math.max(p.samplingFootprintMetres,Math.sqrt(3)*rows[p.id].maxStep)),
   indices,indexCount:36,immutableBytes,appearanceErrorSupported:false,outsideCameraOnly:true,
   qualification:'Authored native density/escape sampling and bounded ray steps; no global native silhouette/appearance certificate',
   bind(pipeline,pid){if(!forestVolumeUint(pid)||pid>=rows.length)throw Error('Invalid native forest volume prototype');let groups=bindings.get(pipeline);if(!groups){groups=[];bindings.set(pipeline,groups);}if(!groups[pid]){const r=rows[pid];groups[pid]=device.createBindGroup({layout:pipeline.getBindGroupLayout(3),entries:[{binding:0,resource:r.field.createView({dimension:'3d'})},{binding:1,resource:r.exposure.createView({dimension:'3d'})},{binding:2,resource:sampler},{binding:3,resource:{buffer:r.metadata}}]});}return groups[pid];},
   destroy(){for(const resource of allocated)resource.destroy();}};
 }catch(error){for(const resource of allocated)resource.destroy();throw error;}
}

// Append after FOREST_VERTEX_WGSL and terrain's F/landFinish definitions. Root,
// visible-index and offset bindings are the existing group2 bindings0/1/2.
export const FOREST_VOLUME_WGSL=/* wgsl */`
struct ForestVolumeMeta {originCell:vec4f,dimensionsExtinction:vec4f,lowStep:vec4f,highFloor:vec4f};
@group(3)@binding(0)var forestVolumeField:texture_3d<f32>;
@group(3)@binding(1)var forestVolumeEscape:texture_3d<f32>;
@group(3)@binding(2)var forestVolumeSampler:sampler;
@group(3)@binding(3)var<uniform>forestVolumeMeta:ForestVolumeMeta;
struct ForestVolumeVertex {@builtin(position)pos:vec4f,@location(0)local:vec3f,@location(1)@interpolate(flat)rootScale:vec4f,@location(2)@interpolate(flat)yawTint:vec4f};
fn forestVolumeRotate(p:vec3f,yaw:f32)->vec3f{let c=cos(yaw);let s=sin(yaw);return vec3f(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
@vertex fn forestVolumeVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->ForestVolumeVertex{
 let triangles=array<u32,36>(0,2,1,1,2,3,4,5,6,5,7,6,0,4,2,2,4,6,1,3,5,3,7,5,0,1,4,1,5,4,2,6,3,3,6,7);
 let corner=triangles[vertex];let upper=vec3<bool>((corner&1u)!=0u,(corner&2u)!=0u,(corner&4u)!=0u);
 let local=select(forestVolumeMeta.lowStep.xyz,forestVolumeMeta.highFloor.xyz,upper);
 let root=forestRoots[forestVisible[forestBin.x+instance]];let world=root.rootScale.xyz+forestVolumeRotate(local,root.yawColour.x)*root.rootScale.w;
 var o:ForestVolumeVertex;o.local=local;o.rootScale=root.rootScale;o.yawTint=root.yawColour;o.pos=F.viewProj*vec4f(world-F.camPos.xyz,1);return o;
}
fn forestVolumeUVW(p:vec3f)->vec3f{return (p-forestVolumeMeta.originCell.xyz+vec3f(.5*forestVolumeMeta.originCell.w))/(forestVolumeMeta.dimensionsExtinction.xyz*forestVolumeMeta.originCell.w);}
fn forestVolumeDensity(p:vec3f)->f32{return max(0.,textureSampleLevel(forestVolumeField,forestVolumeSampler,forestVolumeUVW(p),0).a);}
fn forestVolumeInterval(origin:vec3f,ray:vec3f)->vec2f{
 var near=-1e30;var far=1e30;
 for(var k=0u;k<3u;k++){let lo=forestVolumeMeta.lowStep[k];let hi=forestVolumeMeta.highFloor[k];
  if(abs(ray[k])<1e-8){if(origin[k]<lo||origin[k]>hi){return vec2f(-1);}}
  else{let a=(lo-origin[k])/ray[k];let b=(hi-origin[k])/ray[k];near=max(near,min(a,b));far=min(far,max(a,b));}}
 return vec2f(max(near,0.),far);
}
struct ForestVolumeFragment {@location(0)colour:vec4f,@builtin(frag_depth)depth:f32};
@fragment fn forestVolumeFS(in:ForestVolumeVertex)->ForestVolumeFragment{
 let origin=forestVolumeRotate(F.camPos.xyz-in.rootScale.xyz,-in.yawTint.x)/in.rootScale.w;
 if(all(origin>=forestVolumeMeta.lowStep.xyz)&&all(origin<=forestVolumeMeta.highFloor.xyz)){discard;}
 let ray=normalize(in.local-origin);let interval=forestVolumeInterval(origin,ray);let span=interval.y-interval.x;if(span<=0.){discard;}
 let steps=min(64u,max(1u,u32(ceil(span/forestVolumeMeta.lowStep.w))));let step=span/f32(steps);
 var transmittance=1.;var colour=vec3f(0);var escape=0.;var hit=0.;var weightSum=0.;var front=vec3f(0);var found=false;
 for(var i=0u;i<64u;i++){if(i>=steps){break;}let distance=interval.x+(f32(i)+.5)*step;let local=origin+ray*distance;
  if(local.y<forestVolumeMeta.highFloor.w){continue;}
  let uvw=forestVolumeUVW(local);let field=textureSampleLevel(forestVolumeField,forestVolumeSampler,uvw,0);let density=max(field.a,0.);
  let alpha=1.-exp(-forestVolumeMeta.dimensionsExtinction.w*density*step);let weight=transmittance*alpha;
  if(weight>0.){if(!found){front=local;found=true;}colour+=max(field.rgb,vec3f(0))/max(density,1e-20)*weight;
   escape+=textureSampleLevel(forestVolumeEscape,forestVolumeSampler,uvw,0).r*weight;hit+=distance*weight;weightSum+=weight;}
  transmittance*=1.-alpha;
 }
 if(weightSum<=0.){discard;}
 let h=forestVolumeMeta.originCell.w;let ex=vec3f(h,0,0);let ey=vec3f(0,h,0);let ez=vec3f(0,0,h);
 let gradient=vec3f(forestVolumeDensity(front+ex)-forestVolumeDensity(front-ex),forestVolumeDensity(front+ey)-forestVolumeDensity(front-ey),forestVolumeDensity(front+ez)-forestVolumeDensity(front-ez));
 var localNormal=-ray;if(dot(gradient,gradient)>1e-16){localNormal=-normalize(gradient);}
 let n=forestVolumeRotate(localNormal,in.yawTint.x);let exposure=clamp(escape/weightSum,0.,1.);
 let localHit=origin+ray*(hit/weightSum);let world=in.rootScale.xyz+forestVolumeRotate(localHit,in.yawTint.x)*in.rootScale.w;
 let clip=F.viewProj*vec4f(world-F.camPos.xyz,1);if(clip.w<=0.||clip.z<0.||clip.z>clip.w){discard;}
 let diffuse=(max(dot(n,F.sunDir.xyz),0.)+max(-dot(n,F.sunDir.xyz),0.)*.48)*(.22+.78*exposure*exposure);
 let lit=landFinish(world,n,colour/weightSum*in.yawTint.yzw,diffuse,.12+exposure*.55+abs(n.y)*.08,0.,.95);
 var o:ForestVolumeFragment;o.colour=vec4f(lit.rgb,clamp(1.-transmittance,0.,1.));o.depth=clip.z/clip.w;return o;
}
`;

// Append after FOREST_VOLUME_WGSL. Draw only original-field leaf shell ranges;
// woody ranges retain forestMiddleVS/FS. Opaque mesh depth restores early depth
// testing, while local field samples retain source colour/interior perspective.
// Six 0.25m interior samples and four 0.5m sunlight samples are authored local
// shading approximations, not complete solar or neighbouring-tree shadows.
export const FOREST_VOLUME_SHELL_WGSL=/* wgsl */`
struct ForestVolumeShellVertex {
 @builtin(position)pos:vec4f,@location(0)world:vec3f,@location(1)local:vec3f,@location(2)normal:vec3f,
 @location(3)@interpolate(flat)rootScale:vec4f,@location(4)@interpolate(flat)yawTint:vec4f,@location(5)colour:vec3f,
};
@vertex fn forestVolumeShellVS(@location(0)position:vec3f,@location(1)normal:vec3f,@location(6)colour:vec3f,
 @builtin(instance_index)instance:u32)->ForestVolumeShellVertex{
 let root=forestRoots[forestVisible[forestBin.x+instance]];let world=root.rootScale.xyz+forestVolumeRotate(position,root.yawColour.x)*root.rootScale.w;
 var o:ForestVolumeShellVertex;o.world=world;o.local=position;o.normal=normal;o.colour=colour;o.rootScale=root.rootScale;o.yawTint=root.yawColour;
 o.pos=F.viewProj*vec4f(world-F.camPos.xyz,1);o.pos.z*=1.-f32(forestVisible[forestBin.x+instance]&63u)*2e-7;return o;
}
@fragment fn forestVolumeShellFS(in:ForestVolumeShellVertex)->@location(0)vec4f{
 if(in.local.y<forestVolumeMeta.highFloor.w){discard;}
 let camera=forestVolumeRotate(F.camPos.xyz-in.rootScale.xyz,-in.yawTint.x)/in.rootScale.w;
 let ray=normalize(in.local-camera);var densitySum=0.;var moment=vec3f(0);var escapeMoment=0.;
 for(var i=0u;i<6u;i++){
  let p=in.local+ray*((f32(i)+.5)*.25);if(p.y<forestVolumeMeta.highFloor.w){continue;}
  let uvw=forestVolumeUVW(p);let field=textureSampleLevel(forestVolumeField,forestVolumeSampler,uvw,0);let density=max(field.a,0.);
  densitySum+=density;moment+=max(field.rgb,vec3f(0));escapeMoment+=textureSampleLevel(forestVolumeEscape,forestVolumeSampler,uvw,0).r*density;
 }
 var pigment=in.colour;var exposure=textureSampleLevel(forestVolumeEscape,forestVolumeSampler,forestVolumeUVW(in.local),0).r;
 if(densitySum>0.){pigment=moment/densitySum;exposure=escapeMoment/densitySum;}exposure=clamp(exposure,0.,1.);
 var localNormal=vec3f(0,1,0);if(dot(in.normal,in.normal)>1e-16){localNormal=normalize(in.normal);}
 // The field-shaded reduction profile preserves silhouette positions while
 // resampling appearance. Recover lobe normals from the original density,
 // rather than preserving thousands of triangles solely for vertex shading.
 let h=forestVolumeMeta.originCell.w;let ex=vec3f(h,0,0);let ey=vec3f(0,h,0);let ez=vec3f(0,0,h);
 let gradient=vec3f(forestVolumeDensity(in.local+ex)-forestVolumeDensity(in.local-ex),forestVolumeDensity(in.local+ey)-forestVolumeDensity(in.local-ey),forestVolumeDensity(in.local+ez)-forestVolumeDensity(in.local-ez));
 if(dot(gradient,gradient)>1e-16){localNormal=-normalize(gradient);}
 let n=forestVolumeRotate(localNormal,in.yawTint.x);var sunlight=1.;
 if(F.sunDir.y>0.){let sun=forestVolumeRotate(F.sunDir.xyz,-in.yawTint.x);var opticalDepth=0.;
  for(var i=0u;i<4u;i++){opticalDepth+=forestVolumeDensity(in.local+sun*((f32(i)+.5)*.5))*.5;}
  sunlight=exp(-forestVolumeMeta.dimensionsExtinction.w*opticalDepth);
 }
 let nDotL=dot(n,F.sunDir.xyz);let diffuse=(max(nDotL,0.)+max(-nDotL,0.)*.48)*(.22+.78*exposure*exposure)*sunlight;
 let lit=landFinish(in.world,n,pigment*in.yawTint.yzw,diffuse,.12+exposure*.55+abs(n.y)*.08,0.,.95);
 return vec4f(lit.rgb,1.);
}
`;
