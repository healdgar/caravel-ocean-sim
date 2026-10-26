// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// A sufficient terrain occlusion test, independent of screen resolution/LOD.
// Each pyramid texel bounds BOTH raster triangles, never a bilinear surface.
export function forestTerrainPyramid(heights,{size,span,x,z}){
 const cells=size-1;
 if(!(heights instanceof Float32Array)||heights.length!==size*size||!Number.isInteger(cells)||cells<2||(cells&(cells-1))||![span,x,z].every(Number.isFinite)||span<=0)throw Error('Invalid forest terrain grid');
 const base=new Float32Array(cells*cells*2);
 for(let j=0;j<cells;j++)for(let i=0;i<cells;i++){
  const at=j*size+i,a=heights[at],b=heights[at+1],c=heights[at+size],d=heights[at+size+1];
  if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(c)||!Number.isFinite(d))throw Error('Nonfinite forest terrain grid');
  const k=(j*cells+i)*2;base[k]=Math.min(a,b,c,d);base[k+1]=Math.max(a,b,c,d);
 }
 const levels=[base];
 for(let width=cells;width>1;width>>=1){
  const previous=levels.at(-1),nextWidth=width>>1,next=new Float32Array(nextWidth*nextWidth*2);
  for(let j=0;j<nextWidth;j++)for(let i=0;i<nextWidth;i++){
   const a=(j*2*width+i*2)*2,b=a+2,c=a+width*2,d=c+2,k=(j*nextWidth+i)*2;
   next[k]=Math.min(previous[a],previous[b],previous[c],previous[d]);next[k+1]=Math.max(previous[a+1],previous[b+1],previous[c+1],previous[d+1]);
  }levels.push(next);
 }
 return {cells,levels,domain:[x-span/2,z-span/2,span/cells]};
}

export const FOREST_TERRAIN_OCCLUSION_WGSL=/* wgsl */`
struct ForestTerrainDomains {coarse:vec4f,fine:vec4f};
@group(0)@binding(10)var<uniform>forestTerrainDomains:ForestTerrainDomains;
@group(0)@binding(11)var forestTerrainCoarse:texture_2d<f32>;
@group(0)@binding(12)var forestTerrainFine:texture_2d<f32>;
fn forestTerrainInside(low:vec2f,high:vec2f,domain:vec3f,n:u32)->bool{
 let extent=domain.xy+domain.z*f32(n);
 return all(low>=domain.xy)&&all(high<extent);
}
fn forestTerrainOverlap(low:vec2f,high:vec2f)->bool{
 if(forestTerrainDomains.coarse.w<.5){return false;}
 let a=forestTerrainDomains.fine.xy;let b=a+forestTerrainDomains.fine.z*f32(textureDimensions(forestTerrainFine,0).x);
 return all(high>=a)&&all(low<=b);
}
fn forestTerrainMinimum(image:texture_2d<f32>,domain:vec3f,low:vec2f,high:vec2f)->f32{
 let span=(high-low)/domain.z;
 let level=i32(clamp(ceil(log2(max(max(span.x,span.y),1.))),0.,f32(textureNumLevels(image)-1u)));
 let step=domain.z*exp2(f32(level));let a=vec2i(floor((low-domain.xy)/step));let b=vec2i(floor((high-domain.xy)/step));
 if(any(b-a>vec2i(1))){return -1e30;}
 // The selected mip covers a rectangle in at most two texels per axis. Take
 // every covering texel's MINIMUM; an uncovered/sea cell prevents rejection.
 return min(min(textureLoad(image,a,level).r,textureLoad(image,vec2i(b.x,a.y),level).r),
            min(textureLoad(image,vec2i(a.x,b.y),level).r,textureLoad(image,b,level).r));
}
fn forestTerrainCameraAbove(camera:vec3f)->bool{
 let p=camera.xz;let fine=forestTerrainDomains.fine.xyz;let coarse=forestTerrainDomains.coarse.xyz;
 if(forestTerrainDomains.coarse.w>.5&&forestTerrainInside(p,p,fine,textureDimensions(forestTerrainFine,0).x)){
  let cell=vec2i(floor((p-fine.xy)/fine.z));return camera.y>textureLoad(forestTerrainFine,cell,0).g+2.;
 }
 if(forestTerrainOverlap(p,p)){return false;}
 if(forestTerrainInside(p,p,coarse,textureDimensions(forestTerrainCoarse,0).x)){
  let cell=vec2i(floor((p-coarse.xy)/coarse.z));return camera.y>textureLoad(forestTerrainCoarse,cell,0).g+2.;
 }
 return forestTerrainDomains.fine.w>.5&&camera.y>2.;
}
fn forestTerrainHidden(centre:vec3f,radius:f32)->bool{
 let camera=F.camPos.xyz;
 if(camera.y<=2.||centre.y-radius<=2.||radius<=0.||distance(camera,centre)<=radius+2.||!forestTerrainCameraAbove(camera)){return false;}
 for(var slice=1u;slice<=3u;slice++){
  let t=f32(slice)*.25;let p=mix(camera,centre,t);let r=radius*t+2.;let low=p.xz-vec2f(r);let high=p.xz+vec2f(r);
  var minimum=-1e30;
  let fine=forestTerrainDomains.fine.xyz;let coarse=forestTerrainDomains.coarse.xyz;
  if(forestTerrainDomains.coarse.w>.5&&forestTerrainInside(low,high,fine,textureDimensions(forestTerrainFine,0).x)){
   minimum=forestTerrainMinimum(forestTerrainFine,fine,low,high);
  }else if(!forestTerrainOverlap(low,high)&&forestTerrainInside(low,high,coarse,textureDimensions(forestTerrainCoarse,0).x)){
   minimum=forestTerrainMinimum(forestTerrainCoarse,coarse,low,high);
  }
  // All rays from camera to the root sphere pass through this smaller sphere.
  // Terrain above its entire top necessarily intersects every such sightline.
  // Positive height also certifies that these raster terrain cells exist.
  if(minimum>max(2.,p.y+r+2.)){return true;}
 }
 return false;
}
fn forestCoastalStandHidden(centre:vec3f,rootScale:vec4f,identity:vec4f)->bool{
 if(identity.z>=0.){return false;}
 let camera=F.camPos.xyz;let distXZ=distance(camera.xz,centre.xz);
 if(camera.y<=1.5||distXZ<=45.){return false;}
 let coarse=forestTerrainDomains.coarse.xyz;let n=textureDimensions(forestTerrainCoarse,0).x;
 let crownHalfH=max(4.5,(centre.y-rootScale.y)*1.18);let treeTop=centre.y+crownHalfH;
 var canopyWallSlices=0u;
 for(var slice=1u;slice<=4u;slice++){
  let t=f32(slice)*.2;let p=mix(camera,centre,t);
  if(forestTerrainInside(p.xz,p.xz,coarse,n)){
   let cell=vec2i(floor((p.xz-coarse.xy)/coarse.z));
   let bounds=textureLoad(forestTerrainCoarse,cell,0).rg;
   let rayTopY=mix(camera.y,treeTop,t);
   if(bounds.r>max(1.5,rayTopY+.5)){return true;}
   if(camera.y<28.&&distXZ>155.&&bounds.g>=1.6&&rayTopY<bounds.g+16.5){canopyWallSlices+=1u;}
  }
 }
 if(canopyWallSlices>=2u&&distXZ>210.){return true;}
 return false;
}
`;
export function withForestTerrainOcclusion(source){
 const marker='previousLod[id.x]=select(select(0u,2u,midLod),1u,nearLod);';
 if(!source.includes(marker)||source.includes('fn forestTerrainHidden('))throw Error('Forest terrain occlusion source mismatch');
 return source.replace(marker,marker+'\n if(forestTerrainHidden(world,radius)){return;}\n if(forestCoastalStandHidden(world,r.rootScale,r.identity)){return;}')+FOREST_TERRAIN_OCCLUSION_WGSL;
}
export function createForestTerrainOcclusion({device,heights,region,near=null}){
 const textures=[];let uniform=null;try{const coarse=forestTerrainPyramid(heights,region),fine=near?forestTerrainPyramid(near.heights,near.manifest.domain):null;
 const upload=(p,label)=>{
  const texture=device.createTexture({label,size:[p.cells,p.cells],mipLevelCount:p.levels.length,format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});textures.push(texture);
  for(const [level,values]of p.levels.entries()){const n=p.cells>>level;device.queue.writeTexture({texture,mipLevel:level},values,{bytesPerRow:n*8},[n,n]);}
  return texture.createView();
 };
 const coarseView=upload(coarse,'forest immutable coarse terrain bounds'),fineView=fine?upload(fine,'forest immutable fine terrain bounds'):coarseView;
 let seaBoundary=true;for(let i=0;i<region.size;i++)for(const at of[i,(region.size-1)*region.size+i,i*region.size,i*region.size+region.size-1])if(heights[at]>0)seaBoundary=false;
 const data=new Float32Array([...coarse.domain,fine?1:0,...(fine?.domain??coarse.domain),seaBoundary?1:0]);uniform=device.createBuffer({label:'forest immutable terrain domains',size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(uniform,0,data);
 return {entries:[{binding:10,resource:{buffer:uniform}},{binding:11,resource:coarseView},{binding:12,resource:fineView}],
  update(nextHeights,nextRegion=region){
   if(!textures[0]||!(nextHeights instanceof Float32Array)||nextHeights.length!==region.size*region.size)return;
   const activeReg=nextRegion||region;
   const nextCoarse=forestTerrainPyramid(nextHeights,activeReg);
   for(const [level,values]of nextCoarse.levels.entries()){const n=nextCoarse.cells>>level;device.queue.writeTexture({texture:textures[0],mipLevel:level},values,{bytesPerRow:n*8},[n,n]);}
   if(uniform){
    const nextData=new Float32Array([...nextCoarse.domain,fine?1:0,...(fine?.domain??nextCoarse.domain),seaBoundary?1:0]);
    device.queue.writeBuffer(uniform,0,nextData);
   }
  },
  destroy(){uniform.destroy();for(const texture of textures)texture.destroy();}};
 }catch(error){uniform?.destroy();for(const texture of textures)texture.destroy();throw error;}
}
