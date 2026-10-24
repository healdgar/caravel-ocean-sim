// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Experimental source-leaf clusters. Nothing in this module selects CPU geometry
// per frame or silently installs the botanical reference as a production tier.
const check=(ok,message)=>{if(!ok)throw Error(message);};
const uint=x=>Number.isSafeInteger(x)&&x>=0;
const vector=(x,n)=>Array.isArray(x)&&x.length===n&&x.every(Number.isFinite);
const receipt=x=>uint(x?.bytes)&&x.bytes>0&&/^[a-f0-9]{64}$/.test(x.sha256??'');
const safe=x=>typeof x==='string'&&!x.startsWith('/')&&!x.includes('\\')&&!x.includes('\0')&&!x.split('/').some(p=>!p||p==='.'||p==='..');
const channels=['albedo','normalDepth','lighting'];

export function validateForestClusterPilot(m){
 check(m?.format==='waterworld.forest-leaf-cluster-pilot'&&m.version===1,'Unsupported forest cluster pilot');
 check(Array.isArray(m.prototypes)&&m.prototypes.length>0&&m.prototypes.length<=5,'Invalid pilot prototypes');
 const ids=new Set();
 for(const p of m.prototypes){
  check(uint(p.id)&&!ids.has(p.id)&&Array.isArray(p.tiers)&&p.tiers.length>0&&p.tiers.length<=4,'Invalid cluster prototype');ids.add(p.id);
  check(uint(p.leafCount)&&p.leafCount>0&&Array.isArray(p.hierarchyNodes),'Missing pilot source ownership');
  const hierarchy=new Map(p.hierarchyNodes.map(n=>[n.id,n]));check(hierarchy.size===p.hierarchyNodes.length,'Duplicate source hierarchy IDs');
  const levels=new Set();let sharedProfile;
  for(const t of p.tiers){
   check(uint(t.maxLeaves)&&t.maxLeaves>0&&!levels.has(t.maxLeaves)&&Array.isArray(t.clusters)&&t.clusters.length>0&&t.clusters.length<=20000&&Array.isArray(t.pages)&&t.pages.length>0&&t.pages.length<=512,'Invalid cluster tier');levels.add(t.maxLeaves);
   for(const [id,c]of t.clusters.entries()){
    check(c.id===id&&uint(c.sourceNodeID)&&uint(c.firstLeaf)&&uint(c.leafCount)&&c.leafCount>0&&vector(c.centre,3)&&Number.isFinite(c.extent)&&c.extent>0&&Array.isArray(c.views)&&c.views.length===6,'Invalid cluster source ownership or bound');
    const source=hierarchy.get(c.sourceNodeID);check(source?.firstLeaf===c.firstLeaf&&source.leafCount===c.leafCount,'Cluster ownership differs from original hierarchy');
    for(const [i,v]of c.views.entries())check(v.index===i&&vector(v.direction,3)&&vector(v.right,3)&&vector(v.up,3)&&Math.abs(Math.hypot(...v.direction)-1)<1e-5&&uint(v.page)&&v.page<t.pages.length&&vector(v.tile,2)&&v.tile.every(uint),'Invalid cluster capture view');
   }
   const ranges=t.clusters.map(c=>[c.firstLeaf,c.firstLeaf+c.leafCount]).sort((a,b)=>a[0]-b[0]);let cursor=0;
   for(const [start,end]of ranges){check(start===cursor,'Cluster frontier has overlapping or missing source leaves');cursor=end;}check(cursor===p.leafCount,'Cluster frontier truncates source leaves');
   for(const c of t.clusters)for(const v of c.views)check(v.tile[0]<t.pages[v.page].grid[0]&&v.tile[1]<t.pages[v.page].grid[1],'Cluster tile outside source page');
   for(const [i,p]of t.pages.entries()){
    check(p.index===i&&vector(p.grid,2)&&p.grid.every(n=>uint(n)&&n>0&&n<=64)&&Array.isArray(p.mips)&&p.mips.length>0&&p.mips.length<=8,'Invalid cluster page');
    const profile=JSON.stringify([p.grid,p.mips.map(m=>[m.tilePixels,m.gutter,m.pitchPixels,m.atlasPixels,m.format,m.bytesPerTexel])]);
    if(sharedProfile===undefined)sharedProfile=profile;else check(profile===sharedProfile,'Inconsistent cluster page tile/mip profile');
    for(const [level,mip]of p.mips.entries()){
     check(mip.level===level&&uint(mip.tilePixels)&&mip.tilePixels>0&&uint(mip.gutter)&&mip.gutter>=1&&mip.pitchPixels===mip.tilePixels+2*mip.gutter&&vector(mip.atlasPixels,2)&&mip.atlasPixels.every(n=>uint(n)&&n>0&&n<=4096),'Invalid guttered cluster mip');
     check(['rgba8unorm','rgba16float'].includes(mip.format)&&mip.bytesPerTexel===(mip.format==='rgba8unorm'?4:8)&&mip.atlasPixels[0]===p.grid[0]*mip.pitchPixels&&mip.atlasPixels[1]===p.grid[1]*mip.pitchPixels,'Invalid cluster page byte layout');
     if(level>0)check(mip.tilePixels===Math.max(1,Math.floor(p.mips[level-1].tilePixels/2)),'Invalid cluster mip reduction');
     for(const name of channels){const r=mip.outputs?.[name];check(receipt(r)&&safe(r.file)&&receipt(r.gzip)&&safe(r.gzip.file)&&r.gzip.bytes<=64*1024*1024&&r.bytes===mip.atlasPixels[0]*mip.atlasPixels[1]*mip.bytesPerTexel,'Invalid cluster page receipt');}
    }
   }
  }
 }
 return m;
}
async function digest(raw){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');}
export async function loadForestClusterPilot(base,{fetchAsset=fetch,allowExperimental=false,maxDecodedBytes=256*1024*1024}={}){
 check(allowExperimental===true,'Unqualified forest clusters require explicit review mode');
 check(typeof base==='string'&&base.length>0,'Missing forest pilot URL');base=base.replace(/\/$/,'')+'/';
 const response=await fetchAsset(base+'manifest.json');check(response.ok,'Forest pilot manifest unavailable');const manifest=validateForestClusterPilot(await response.json());
 const pending=new Map();
 async function read(item){
  const response=await fetchAsset(base+item.gzip.file);check(response.ok,'Forest pilot page unavailable: '+item.gzip.file);
  const encoded=await response.arrayBuffer();check(encoded.byteLength===item.gzip.bytes&&await digest(encoded)===item.gzip.sha256,'Forest pilot encoded digest mismatch');
  check(item.bytes<=maxDecodedBytes,'Forest pilot page exceeds decode budget');
  const reader=new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),parts=[];let length=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;check(length<=item.bytes,'Forest pilot page expands beyond receipt');parts.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  const data=new Uint8Array(length);let at=0;for(const part of parts){data.set(part,at);at+=part.length;}
  check(length===item.bytes&&await digest(data)===item.sha256,'Forest pilot decoded digest mismatch');return data;
 }
 const loadPage=(p,t,page)=>{
  const key=p.id+':'+t.maxLeaves+':'+page.index;
  if(!pending.has(key)){const promise=(async()=>{
   let total=0;for(const mip of page.mips)for(const channel of channels)total+=mip.outputs[channel].bytes;
   check(total<=maxDecodedBytes,'Forest pilot page exceeds residency budget');
   const mips=[];for(const mip of page.mips){const data={};for(const channel of channels)data[channel]=await read(mip.outputs[channel]);mips.push({...mip,data});}return{...page,mips};
  })();pending.set(key,promise);promise.catch(()=>pending.delete(key));}
  return pending.get(key);
 };
 return{manifest,loadPage,releasePage(p,t,page){pending.delete(p.id+':'+t.maxLeaves+':'+page.index);}};
}

// A single packed array layer contains all independently filtered mip tiles.
// Their borders are never averaged with neighbouring clusters or page contents.
export function packForestClusterMips(mips){
 check(Array.isArray(mips)&&mips.length>0,'Missing cluster mip geometry');
 const minimum=mips[0].atlasPixels[0];
 for(const m of mips)check(m.atlasPixels[0]<=minimum&&m.atlasPixels.every(n=>uint(n)&&n>0),'Incompatible cluster mip dimensions');
 let best;
 // Bottom-left rectangle packing searches a small bounded range of widths.
 // It changes only immutable page placement: no filtering or gutter resampling.
 for(let width=minimum;width<=Math.min(4096,minimum+128);width+=4){
  const rects=[];let height=0;
  for(const m of mips){const [w,h]=m.atlasPixels,xs=[...new Set([0,...rects.map(r=>r[0]+r[2])])],ys=[...new Set([0,...rects.map(r=>r[1]+r[3])])];let chosen;
   for(const y of ys)for(const x of xs){if(x+w>width)continue;const r=[x,y,w,h];if(rects.some(a=>x<a[0]+a[2]&&x+w>a[0]&&y<a[1]+a[3]&&y+h>a[1]))continue;
    const cost=[Math.max(height,y+h),y,x];if(!chosen||cost.some((v,i)=>v<chosen.cost[i]&&cost.slice(0,i).every((n,j)=>n===chosen.cost[j])))chosen={r,cost};
   }
   check(chosen,'Cannot pack independent cluster mips');rects.push(chosen.r);height=chosen.cost[0];
  }
  if(!best||width*height<best.width*best.height)best={width,height,rects};
 }
 check(best,'Unsupported cluster mip page dimensions');return best;
}

export function forestClusterNodes(prototype,inspection){
 const tiers=[...prototype.tiers].sort((a,b)=>b.maxLeaves-a.maxLeaves),nodes=[];
 for(const [depth,tier]of tiers.entries())for(const c of tier.clusters)nodes.push({...c,depth,maxLeaves:tier.maxLeaves,pageTier:tier,parent:-1,childCount:0});
 for(const c of nodes)if(c.depth>0){
  const parent=nodes.find(p=>p.depth===c.depth-1&&p.firstLeaf<=c.firstLeaf&&p.firstLeaf+p.leafCount>=c.firstLeaf+c.leafCount);
  check(parent,'Incomplete source cluster hierarchy');c.parent=nodes.indexOf(parent);parent.childCount++;
 }
 if(inspection){
  check(inspection.prototype.id===prototype.id&&inspection.prototype.leafCount===prototype.leafCount,'Inspection specimen differs');
  const reduced=inspection.reduction;
  check(!reduced||(reduced.format==='waterworld.forest-ribbon-inspection'&&reduced.version===1&&reduced.appearanceQualified===false),'Invalid derived inspection frontier');
  const frontiers=reduced?[{depth:tiers.length,representation:'ribbon'},{depth:tiers.length+1,representation:'original'}]:[{depth:tiers.length}];
  for(const {depth,representation}of frontiers)for(const c of inspection.clusters){
   if(representation&&c.representation!==representation)continue;
   const parent=nodes.find(p=>p.depth===depth-1&&p.firstLeaf<=c.firstLeaf&&p.firstLeaf+p.leafCount>=c.firstLeaf+c.leafCount);
   check(parent,'Inspection cluster has no source image/reduced parent');
   if(representation==='ribbon')check(Number.isFinite(c.reductionErrorMetres)&&c.reductionErrorMetres>=0,'Missing source ribbon geometric error');
   nodes.push({...c,depth,parent:nodes.indexOf(parent),childCount:0,native:true,ribbon:representation==='ribbon'});parent.childCount++;
  }
 }
 for(const parent of nodes.filter(c=>c.childCount)){
  const children=nodes.filter(c=>c.parent===nodes.indexOf(parent)).sort((a,b)=>a.firstLeaf-b.firstLeaf);let cursor=parent.firstLeaf;
  for(const child of children){check(child.firstLeaf===cursor,'Cluster children overlap or leave holes');cursor+=child.leafCount;}check(cursor===parent.firstLeaf+parent.leafCount,'Incomplete cluster child cover');
 }
 return{nodes,tiers};
}

export const FOREST_CLUSTER_PILOT_WGSL=/* wgsl */`
struct PilotCamera {viewProj:mat4x4f,positionFocal:vec4f,sunExposure:vec4f,screen:vec4f,settings:vec4f};
struct Cluster {centreExtent:vec4f,owner:vec4u,tiles:array<vec4u,6>,low:vec4f,high:vec4f};
struct Root {positionScale:vec4f,yawTint:vec4f};
struct CaptureView {direction:vec4f,right:vec4f,up:vec4f};
struct Mip {rectangle:vec4f,tile:vec4f};
@group(0)@binding(0)var<uniform>C:PilotCamera;
@group(0)@binding(1)var<storage,read>clusters:array<Cluster>;
@group(0)@binding(2)var<storage,read>roots:array<Root>;
@group(0)@binding(3)var<storage,read>views:array<CaptureView>;
@group(0)@binding(4)var<storage,read>mips:array<Mip>;
@group(0)@binding(5)var pigmentAtlas:texture_2d_array<f32>;
@group(0)@binding(6)var normalAtlas:texture_2d_array<f32>;
@group(0)@binding(7)var lightingAtlas:texture_2d_array<f32>;
@group(0)@binding(8)var atlasSampler:sampler;
@group(0)@binding(9)var<storage,read>visible:array<u32>;
@group(1)@binding(0)var<storage,read_write>decisions:array<u32>;
@group(1)@binding(1)var<storage,read_write>visibleOut:array<u32>;
@group(1)@binding(2)var<storage,read_write>drawCommand:array<atomic<u32>>;
@group(2)@binding(0)var<storage,read>sourceLeafIndices:array<u32>;
@group(2)@binding(1)var<storage,read_write>selectedLeafIndices:array<u32>;
@group(2)@binding(2)var<storage,read>sourceLeafParts:array<vec4u>;
fn rotate(p:vec3f,yaw:f32)->vec3f{let c=cos(yaw);let s=sin(yaw);return vec3f(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
fn worldPoint(p:vec3f,r:Root)->vec3f{return r.positionScale.xyz+rotate(p*r.positionScale.w,r.yawTint.x);}
@compute @workgroup_size(1)fn clusterReset(){atomicStore(&drawCommand[1],0u);atomicStore(&drawCommand[4],0u);atomicStore(&drawCommand[9],0u);atomicStore(&drawCommand[10],0u);atomicStore(&drawCommand[11],0u);for(var slot=12u;slot+4u<arrayLength(&drawCommand);slot+=5u){atomicStore(&drawCommand[slot],0u);}}
@compute @workgroup_size(64)fn clusterRefine(@builtin(global_invocation_id)id:vec3u){
 let count=arrayLength(&clusters);if(id.x>=count*arrayLength(&roots)){return;}let node=id.x%count;let root=id.x/count;let c=clusters[node];let r=roots[root];
 let radius=c.centreExtent.w*r.positionScale.w;let relative=worldPoint(c.centreExtent.xyz,r)-C.positionFocal.xyz;let distance=length(relative);
 let depth=(C.viewProj*vec4f(worldPoint(c.centreExtent.xyz,r),1)).w;let near=depth-radius;let lateral=sqrt(max(0.,distance*distance-depth*depth))+radius;
 let projected=2.*C.positionFocal.w*radius*sqrt(1.+lateral*lateral/max(near*near,.000001))/max(near,.001);
 let threshold=C.screen.w*select(1.12,.88,decisions[id.x]!=0u);
 let geometricError=c.low.w*r.positionScale.w;
 let errorPixels=C.positionFocal.w*geometricError*sqrt(1.+lateral*lateral/max(near*near,.000001))/max(near-geometricError,.001);
 let errorLimit=c.high.w*select(1.12,.88,decisions[id.x]!=0u);
 let automatic=select(near<=0.||projected>threshold,near<=geometricError||errorPixels>errorLimit,c.high.w>0.);
 let requested=select(automatic,f32(c.owner.y)<C.settings.x,C.settings.x>=0.);
 decisions[id.x]=select(0u,1u,c.owner.z>0u&&requested);
}
@compute @workgroup_size(64)fn clusterCull(@builtin(global_invocation_id)id:vec3u){
 let count=arrayLength(&clusters);if(id.x>=count*arrayLength(&roots)){return;}let node=id.x%count;let root=id.x/count;let c=clusters[node];
 if(decisions[id.x]!=0u){return;}var parent=c.owner.x;
 for(var level=0u;level<4u&&parent!=0xffffffffu;level++){if(decisions[root*count+parent]==0u){return;}parent=clusters[parent].owner.x;}
 let r=roots[root];let radius=c.centreExtent.w*r.positionScale.w;let centre=worldPoint(c.centreExtent.xyz,r);let clip=C.viewProj*vec4f(centre,1);
 let rowW=vec3f(C.viewProj[0].w,C.viewProj[1].w,C.viewProj[2].w);
 for(var a=0u;a<2u;a++){let row=vec3f(C.viewProj[0][a],C.viewProj[1][a],C.viewProj[2][a]);if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}}
 if(clip.w<-radius*length(rowW)){return;}
 let rowZ=vec3f(C.viewProj[0].z,C.viewProj[1].z,C.viewProj[2].z);
 if(clip.z<-radius*length(rowZ)||clip.w-clip.z<-radius*length(rowW-rowZ)){return;}
 let native=(c.owner.w&0x80000000u)!=0u;
 if(native){
  let bins=atomicLoad(&drawCommand[6]);let capacity=atomicLoad(&drawCommand[7]);
  for(var part=0u;part<c.tiles[0].z;part++){
   let p=sourceLeafParts[c.tiles[0].x+part];let command=12u+(root*bins+p.z)*5u;
   let offset=root*capacity+p.w+atomicAdd(&drawCommand[command],p.y);
   for(var k=0u;k<p.y;k++){selectedLeafIndices[offset+k]=sourceLeafIndices[p.x+k];}
  }
  atomicAdd(&drawCommand[4],c.tiles[0].y);atomicAdd(&drawCommand[10],1u);
  if(atomicLoad(&drawCommand[8])!=0u){atomicAdd(&drawCommand[11],c.tiles[0].y);}
 }
 else {let slot=atomicAdd(&drawCommand[1],1u);visibleOut[slot]=id.x;}
 atomicAdd(&drawCommand[9],select(atomicLoad(&drawCommand[0])/3u,c.tiles[0].y/3u,native));
}
struct Vertex {@builtin(position)position:vec4f,@location(0)local:vec3f,@location(1)@interpolate(flat)node:u32,@location(2)@interpolate(flat)root:u32,@location(3)@interpolate(flat)view:u32};
@vertex fn clusterVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->Vertex{
 let address=visible[instance];let count=arrayLength(&clusters);let node=address%count;let ri=address/count;let c=clusters[node];let r=roots[ri];
 let cam=rotate((C.positionFocal.xyz-r.positionScale.xyz)/r.positionScale.w,-r.yawTint.x);let direction=normalize(cam-c.centreExtent.xyz);var best=0u;var score=-2.;
 for(var k=0u;k<6u;k++){let d=dot(direction,views[k].direction.xyz);if(d>score){score=d;best=k;}}
 if(vertex>=6u){best=best^1u;}
 let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));let q=corners[vertex%6u];
 let referenceUp=select(vec3f(0,1,0),vec3f(0,0,1),abs(direction.y)>.99);let cameraRight=normalize(cross(referenceUp,direction));let cameraUp=cross(direction,cameraRight);
 let distance=length(cam-c.centreExtent.xyz);let perspective=distance/sqrt(max(distance*distance-c.centreExtent.w*c.centreExtent.w,.0001));
 var lower=vec2f(1e30);var upper=vec2f(-1e30);var valid=true;
 // Project the actual source-leaf box onto this camera-facing plane. Include
 // one finest capture texel for filtered coverage. The broad sphere is retained
 // only for an invalid/inside diagnostic projection; no source vertices move.
 let padding=vec3f(2.*c.centreExtent.w/mips[0].tile.y);
 for(var corner=0u;corner<8u;corner++){
  let b=mix(c.low.xyz-padding,c.high.xyz+padding,vec3f(f32(corner&1u),f32((corner>>1u)&1u),f32((corner>>2u)&1u)));
  let relative=b-cam;let depth=dot(relative,-direction);if(depth<=.001){valid=false;}
  let point=cam+relative*(distance/max(depth,.001))-c.centreExtent.xyz;let xy=vec2f(dot(point,cameraRight),dot(point,cameraUp));lower=min(lower,xy);upper=max(upper,xy);
 }
 if(!valid){lower=vec2f(-c.centreExtent.w*perspective);upper=-lower;}
 let xy=mix(lower,upper,q);let local=c.centreExtent.xyz+cameraRight*xy.x+cameraUp*xy.y;
 var o:Vertex;o.local=local;o.position=C.viewProj*vec4f(worldPoint(local,r),1);o.node=node;o.root=ri;o.view=best;return o;
}
struct Surface {pigment:vec4f,normalDepth:vec4f,lighting:vec4f};
fn sampleSurface(c:Cluster,view:u32,uv:vec2f,level:u32)->Surface{
 let tile=c.tiles[view];let m=mips[level];let lower=m.rectangle.xy+vec2f(tile.xy)*m.tile.x+vec2f(m.tile.z);
 let xy=(lower+clamp(uv,vec2f(0),vec2f(1))*m.tile.y)/vec2f(textureDimensions(pigmentAtlas));var o:Surface;
 o.pigment=textureSampleLevel(pigmentAtlas,atlasSampler,xy,i32(tile.z),0.);
 o.normalDepth=textureSampleLevel(normalAtlas,atlasSampler,xy,i32(tile.z),0.);
 o.lighting=textureSampleLevel(lightingAtlas,atlasSampler,xy,i32(tile.z),0.);return o;
}
fn sampleFiltered(c:Cluster,view:u32,uv:vec2f,lod:f32)->Surface{
 let lo=u32(floor(lod));let hi=min(lo+1u,arrayLength(&mips)-1u);let a=sampleSurface(c,view,uv,lo);let b=sampleSurface(c,view,uv,hi);let f=fract(lod);var o:Surface;
 o.pigment=mix(a.pigment,b.pigment,f);o.normalDepth=mix(a.normalDepth,b.normalDepth,f);o.lighting=mix(a.lighting,b.lighting,f);return o;
}
// Optional experimental capture-depth grid: immutable source capture data is
// sampled in the VS. Rasterized triangles supply depth, never fragment depth.
struct MeshVertex {@builtin(position)position:vec4f,@location(0)uv:vec2f,@location(1)local:vec3f,@location(2)@interpolate(flat)node:u32,@location(3)@interpolate(flat)root:u32,@location(4)@interpolate(flat)view:u32};
@vertex fn clusterMeshVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->MeshVertex{
 let address=visible[instance];let count=arrayLength(&clusters);let node=address%count;let ri=address/count;let c=clusters[node];let r=roots[ri];
 let cam=rotate((C.positionFocal.xyz-r.positionScale.xyz)/r.positionScale.w,-r.yawTint.x);let direction=normalize(cam-c.centreExtent.xyz);var best=0u;var score=-2.;
 for(var k=0u;k<6u;k++){let d=dot(direction,views[k].direction.xyz);if(d>score){score=d;best=k;}}
 let segments=u32(C.settings.w);let cell=vertex/6u;let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let uv=(vec2f(f32(cell%segments),f32(cell/segments))+corners[vertex%6u])/f32(segments);let tile=c.tiles[best];let mip=mips[0];
 let lower=mip.rectangle.xy+vec2f(tile.xy)*mip.tile.x+vec2f(mip.tile.z);let xy=(lower+uv*mip.tile.y)/vec2f(textureDimensions(pigmentAtlas));
 let coverage=textureSampleLevel(pigmentAtlas,atlasSampler,xy,i32(tile.z),0.).a;let packedDepth=textureSampleLevel(normalAtlas,atlasSampler,xy,i32(tile.z),0.).a;
 let depth=mix(.5,clamp(packedDepth/max(coverage,1e-6),0.,1.),smoothstep(.04,.2,coverage));let v=views[best];let radius=c.centreExtent.w;
 let local=c.centreExtent.xyz+v.right.xyz*((2.*uv.x-1.)*radius)+v.up.xyz*((1.-2.*uv.y)*radius)+v.direction.xyz*((.5-depth)*2.*radius);
 var o:MeshVertex;o.position=C.viewProj*vec4f(worldPoint(local,r),1);o.uv=uv;o.local=local;o.node=node;o.root=ri;o.view=best;return o;
}
fn pilotHash(value:u32)->u32{var h=value;h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;return h;}
struct MeshFragment {@location(0)colour:vec4f,@builtin(sample_mask)mask:u32};
@fragment fn clusterMeshFS(in:MeshVertex)->MeshFragment{
 let c=clusters[in.node];let r=roots[in.root];let uv=in.uv;let texels=mips[0].tile.y;
 let rho=max(length(dpdx(uv)*texels),length(dpdy(uv)*texels));let lod=clamp(log2(max(rho,1.)),0.,f32(arrayLength(&mips)-1u));let surface=sampleFiltered(c,in.view,uv,lod);
 let alpha=surface.pigment.a;if(alpha<.001||any(uv<vec2f(0))||any(uv>vec2f(1))||in.local.y<0.){discard;}
 let colour=surface.pigment.rgb/max(alpha,1e-6);var n=surface.normalDepth.xyz/max(alpha,1e-6);if(C.settings.z>.5){n=n*2.-vec3f(1);}
 n=rotate(n,r.yawTint.x);n=select(vec3f(0,1,0),n*inverseSqrt(max(dot(n,n),1e-12)),dot(n,n)>1e-12);let light=surface.lighting.xyz/max(alpha,1e-6);let exposure=clamp(light.x,0.,1.);let ndl=dot(n,normalize(C.sunExposure.xyz));
 let canopyAO=clamp(light.y,0.,1.);let diffuse=(max(ndl,0.)+max(-ndl,0.)*light.z)*(.22+.78*exposure*exposure)*(.35+.65*canopyAO);let ambient=(.12+exposure*.55+abs(n.y)*.08)*canopyAO;
 var rgb=colour*(diffuse+ambient)*C.sunExposure.w;if(C.screen.z==2.){rgb=vec3f(f32(c.owner.y)*.45,.3,1.-f32(c.owner.y)*.4);}
 rgb=pow(max(rgb,vec3f(0))/(vec3f(1)+max(rgb,vec3f(0))),vec3f(1./2.2));if(C.screen.z==1.){rgb=vec3f(1);}
 let seed=(c.owner.w*1664525u+in.root*1013904223u+u32(in.position.x)*374761393u+u32(in.position.y)*668265263u);var mask=0u;
 for(var bit=0u;bit<4u;bit++){let threshold=(f32((bit+(seed&3u))&3u)+f32(pilotHash(seed)>>8u)/16777216.)*.25;if(alpha>=threshold){mask|=1u<<bit;}}
 var o:MeshFragment;o.colour=vec4f(rgb,alpha);o.mask=mask;return o;
}
struct Fragment {@location(0)colour:vec4f,@builtin(frag_depth)depth:f32,@builtin(sample_mask)mask:u32};
@fragment fn clusterFS(in:Vertex)->Fragment{
 let c=clusters[in.node];let r=roots[in.root];let v=views[in.view];let cameraLocal=rotate((C.positionFocal.xyz-r.positionScale.xyz)/r.positionScale.w,-r.yawTint.x);
 let ray=normalize(in.local-cameraLocal);let denominator=dot(ray,v.direction.xyz);let safeDenominator=select(min(denominator,-.001),max(denominator,.001),denominator>=0.);var local=in.local+ray*(-dot(in.local-c.centreExtent.xyz,v.direction.xyz)/safeDenominator);var uv=vec2f(dot(local-c.centreExtent.xyz,v.right.xyz),-dot(local-c.centreExtent.xyz,v.up.xyz))/(2.*c.centreExtent.w)+vec2f(.5);
 let texels=mips[0].tile.y;let rho=max(length(dpdx(uv)*texels),length(dpdy(uv)*texels));let lod=clamp(log2(max(rho,1.)),0.,f32(arrayLength(&mips)-1u));
 var surface=sampleFiltered(c,in.view,uv,lod);
 // Two bounded image-depth corrections. No full volume or unbounded ray march.
 for(var iteration=0u;iteration<2u;iteration++){
  let coverage=surface.pigment.a;let depth=mix(.5,clamp(surface.normalDepth.a/max(coverage,1e-6),0.,1.),smoothstep(.04,.2,coverage));let surfaceDepth=(.5-depth)*2.*c.centreExtent.w;
  if(C.settings.y>.5&&coverage>.001&&abs(denominator)>.1){local+=ray*((surfaceDepth-dot(local-c.centreExtent.xyz,v.direction.xyz))/denominator);}
  uv=vec2f(dot(local-c.centreExtent.xyz,v.right.xyz),-dot(local-c.centreExtent.xyz,v.up.xyz))/(2.*c.centreExtent.w)+vec2f(.5);surface=sampleFiltered(c,in.view,uv,lod);
 }
 let alpha=surface.pigment.a;if(alpha<.001||any(uv<vec2f(0))||any(uv>vec2f(1))||local.y<0.){discard;}
 let colour=surface.pigment.rgb/max(alpha,1e-6);var n=surface.normalDepth.xyz/max(alpha,1e-6);if(C.settings.z>.5){n=n*2.-vec3f(1);}
 n=rotate(n,r.yawTint.x);n=select(vec3f(0,1,0),n*inverseSqrt(max(dot(n,n),1e-12)),dot(n,n)>1e-12);let light=surface.lighting.xyz/max(alpha,1e-6);let exposure=clamp(light.x,0.,1.);let ndl=dot(n,normalize(C.sunExposure.xyz));
 let canopyAO=clamp(light.y,0.,1.);let diffuse=(max(ndl,0.)+max(-ndl,0.)*light.z)*(.22+.78*exposure*exposure)*(.35+.65*canopyAO);let ambient=(.12+exposure*.55+abs(n.y)*.08)*canopyAO;
 var rgb=colour*(diffuse+ambient)*C.sunExposure.w;
 if(C.screen.z==2.){rgb=vec3f(f32(c.owner.y)*.45,.3,1.-f32(c.owner.y)*.4);}
 rgb=pow(max(rgb,vec3f(0))/(vec3f(1)+max(rgb,vec3f(0))),vec3f(1./2.2));if(C.screen.z==1.){rgb=vec3f(1);}
 let world=worldPoint(local,r);let clip=C.viewProj*vec4f(world,1);if(clip.w<=0.||clip.z<0.||clip.z>clip.w){discard;}var o:Fragment;o.colour=vec4f(rgb,alpha);o.depth=clamp(clip.z/clip.w,0.,1.);
 let seed=(c.owner.w*1664525u+in.root*1013904223u+u32(in.position.x)*374761393u+u32(in.position.y)*668265263u);
 let samples=4u;var mask=0u;
 for(var bit=0u;bit<samples;bit++){let threshold=(f32((bit+(seed&3u))&3u)+f32(pilotHash(seed)>>8u)/16777216.)*.25;if(alpha>=threshold){mask|=1u<<bit;}}
 o.mask=mask;return o;
}
`;

// Construction-only material partition of the verified complete inspection
// frontier. Triangle vertices/winding and the immutable60B records stay exact.
// GPU culling subsequently copies these parts into fixed root/material spans.
function inspectionMaterialBins(inspection){
 check(inspection.vertices instanceof Uint8Array&&inspection.vertices.byteLength%60===0&&inspection.indices instanceof Uint32Array&&inspection.indices.length>0&&inspection.indices.length%3===0&&Array.isArray(inspection.clusters)&&Array.isArray(inspection.materials)&&inspection.materials.length>0&&inspection.materials.length<=16,'Invalid inspection material partition inputs');
 const rows=new Float32Array(inspection.vertices.buffer,inspection.vertices.byteOffset,inspection.vertices.byteLength/4),vertexCount=inspection.vertices.byteLength/60,slots=new Map(),counts=new Uint32Array(inspection.materials.length),indices=new Uint32Array(inspection.indices.length),parts=[],clusters=new Map();let next=0,sourceNext=0;
 for(const [bin,m]of inspection.materials.entries()){check(uint(m.index)&&!slots.has(m.index),'Duplicate inspection material');slots.set(m.index,bin);}
 for(const c of inspection.clusters){
  check(uint(c.sourceNodeID)&&!clusters.has(c.selectionKey??c.sourceNodeID)&&c.firstIndex===sourceNext&&uint(c.indexCount)&&c.indexCount>0&&c.indexCount%3===0&&c.firstIndex+c.indexCount<=inspection.indices.length,'Inspection cluster index cover overlaps or omits source triangles');
  const groups=new Map(),firstPart=parts.length/4;
  for(let at=c.firstIndex;at<c.firstIndex+c.indexCount;at+=3){
   const ids=inspection.indices.subarray(at,at+3);check(ids.every(id=>id<vertexCount),'Inspection source index exceeds vertices');const material=rows[ids[0]*15+13],bin=slots.get(material);check(bin!==undefined&&ids.every(id=>rows[id*15+13]===material),'Inspection triangle crosses original materials');
   if(!groups.has(bin))groups.set(bin,[]);groups.get(bin).push(ids[0],ids[1],ids[2]);
  }
  for(let bin=0;bin<counts.length;bin++){const own=groups.get(bin);if(!own)continue;parts.push(next,own.length,bin,0);indices.set(own,next);next+=own.length;counts[bin]+=own.length;}
  clusters.set(c.selectionKey??c.sourceNodeID,{firstPart,partCount:parts.length/4-firstPart,indexCount:c.indexCount});sourceNext+=c.indexCount;
 }
 check(sourceNext===inspection.indices.length&&next===inspection.indices.length,'Inspection material partition loses original source cover');
 let firstIndex=0;const bins=inspection.materials.map((m,bin)=>{const record={material:m.index,firstIndex,indexCount:counts[bin]};firstIndex+=counts[bin];return record;});
 for(let at=0;at<parts.length;at+=4)parts[at+3]=bins[parts[at+2]].firstIndex;
 check(firstIndex===inspection.indices.length,'Inspection material capacities differ');return{indices,parts:Uint32Array.from(parts),bins,clusters};
}

// Construction-only upper bound over every valid parent-XOR-complete-children
// frontier. A coarse depth grid may cost more than all its exact native leaves.
function maximumClusterFrontierTriangles(nodes,bakedTriangles,nativePasses){
 const children=new Float64Array(nodes.length);let total=0;
 for(let i=nodes.length-1;i>=0;i--){const c=nodes[i],own=c.native?c.indexCount/3*nativePasses:bakedTriangles,cost=Math.max(own,children[i]);check(Number.isSafeInteger(cost)&&cost>0,'Invalid hierarchy triangle cost');
  if(c.parent<0)total+=cost;else{check(uint(c.parent)&&c.parent<i,'Non-topological cluster cost hierarchy');children[c.parent]+=cost;}
 }
 check(Number.isSafeInteger(total),'Hierarchy triangle budget overflows');return total;
}

// Serial is the existing review control. Parallel preserves every material-bin
// reservation and enqueues contiguous source-index copies instead of making
// one cull invocation copy an entire cluster's indices by itself.
export function forestInspectionCompactionShader(mode='serial'){
 check(['serial','parallel'].includes(mode),'Invalid inspection compaction mode');
 if(mode==='serial')return FOREST_CLUSTER_PILOT_WGSL;
 const from='for(var k=0u;k<p.y;k++){selectedLeafIndices[offset+k]=sourceLeafIndices[p.x+k];}';
 check(FOREST_CLUSTER_PILOT_WGSL.includes(from),'Inspection serial copy source changed');
 return FOREST_CLUSTER_PILOT_WGSL
  .replace('@group(2)@binding(0)var<storage,read>sourceLeafIndices:array<u32>;','')
  .replace('@group(2)@binding(1)var<storage,read_write>selectedLeafIndices:array<u32>;','')
  .replace('@compute @workgroup_size(1)fn clusterReset(){',`@group(3)@binding(0)var<storage,read_write>inspectionCopyTasks:array<vec4u>;
@group(3)@binding(1)var<storage,read_write>inspectionCopyState:array<atomic<u32>>;
@compute @workgroup_size(1)fn clusterReset(){atomicStore(&inspectionCopyState[0],0u);atomicStore(&inspectionCopyState[2],0u);`)
  .replace(from,`let task=atomicAdd(&inspectionCopyState[0],1u);
   if(task<atomicLoad(&inspectionCopyState[1])){inspectionCopyTasks[task]=vec4u(p.x,offset,p.y,0u);}
   else{atomicStore(&inspectionCopyState[2],1u);}`);
}

export const FOREST_INSPECTION_TASK_FINALIZE_WGSL=/*wgsl*/`
@group(0)@binding(0)var<storage,read>state:vec4u;
@group(0)@binding(1)var<storage,read_write>dispatch:vec4u;
@group(0)@binding(2)var<storage,read_write>commands:array<atomic<u32>>;
@compute @workgroup_size(1)fn inspectionFinalize(){
 if(state.z!=0u||state.x>state.y){
  // Capacity is proven from all immutable material parts times root count.
  // If that contract is violated, never draw stale/uncopied native indices.
  atomicSub(&commands[9],atomicLoad(&commands[4])/3u);
  atomicStore(&commands[4],0u);atomicStore(&commands[10],0u);atomicStore(&commands[11],0u);
  for(var slot=12u;slot+4u<arrayLength(&commands);slot+=5u){atomicStore(&commands[slot],0u);}
  dispatch=vec4u(0,1,1,0);return;
 }
 let width=min(state.x,state.w);let height=(state.x+max(width,1u)-1u)/max(width,1u);
 dispatch=vec4u(width,max(height,1u),1u,0u);
}`;

export const FOREST_INSPECTION_TASK_COPY_WGSL=/*wgsl*/`
@group(0)@binding(0)var<storage,read>tasks:array<vec4u>;
@group(0)@binding(1)var<storage,read>source:array<u32>;
@group(0)@binding(2)var<storage,read_write>selected:array<u32>;
@group(0)@binding(3)var<storage,read>state:vec4u;
@compute @workgroup_size(64)fn inspectionCopy(@builtin(workgroup_id)group:vec3u,@builtin(local_invocation_index)lane:u32){
 let taskID=group.x+group.y*min(state.x,state.w);if(taskID>=min(state.x,state.y)){return;}
 let task=tasks[taskID];for(var index=lane;index<task.z;index+=64u){selected[task.y+index]=source[task.x+index];}
}`;

export async function createForestClusterPilotRenderer({device,pack,prototypeID,inspection,captureLayers=1,meshSegments=0,roots=[[0,0,0,1,0]],format='rgba8unorm',samples=4,maxTextureBytes=448*1024*1024,maxTriangles=6_000_000,additionalTriangles=0,inspectionDepthPrepass=false,inspectionShading='sample',inspectionCompaction='serial',ribbonErrorPixels=.25}){
 const prototype=pack.manifest.prototypes.find(p=>p.id===prototypeID);check(prototype,'Missing pilot source species');
 check(samples===4,'Pilot sample masks require four MSAA samples');
 check(captureLayers===1||captureLayers===2,'Pilot supports one/two capture surfaces');
 check([0,2,4,8].includes(meshSegments)&&(!meshSegments||captureLayers===1),'Depth-grid mode requires2/4/8 segments and a single capture surface');
 check(uint(maxTriangles)&&maxTriangles>0&&maxTriangles<=6_000_000,'Pilot hard submitted-triangle budget cannot exceed6M');
 check(['sample','pixel','pixel-depth'].includes(inspectionShading),'Invalid inspection shading mode');
 check(['serial','parallel'].includes(inspectionCompaction),'Invalid inspection compaction mode');
 check(Number.isFinite(ribbonErrorPixels)&&ribbonErrorPixels>=.05&&ribbonErrorPixels<=.75,'Ribbon geometric error limit must be0.05..0.75 pixels');
 check(inspectionShading!=='pixel-depth'||inspectionDepthPrepass,'Pixel-depth shading requires the original sample depth prepass');
 check(typeof inspectionDepthPrepass==='boolean','Inspection depth-prepass flag must be explicit boolean');
 const selection=inspection?inspectionMaterialBins(inspection):null,{nodes,tiers}=forestClusterNodes(prototype,inspection),finest=tiers.at(-1),bakedTriangles=meshSegments?2*meshSegments*meshSegments:2*captureLayers,finestTriangles=nodes.filter(n=>!n.childCount).reduce((sum,n)=>sum+(n.native?n.indexCount/3:bakedTriangles),0)*roots.length,additionalDepthTriangles=inspection&&inspectionDepthPrepass?finestTriangles:0,maximumColourFrontierTriangles=maximumClusterFrontierTriangles(nodes,bakedTriangles,1)*roots.length,maximumFrontierTriangles=maximumClusterFrontierTriangles(nodes,bakedTriangles,inspectionDepthPrepass?2:1)*roots.length;
 check(uint(additionalTriangles)&&maximumFrontierTriangles+additionalTriangles<=maxTriangles,'Pilot maximum submitted frontier exceeds hard triangle budget');
 const firstPage=tiers[0].pages[0],layout=packForestClusterMips(firstPage.mips),bpp=firstPage.mips[0].outputs.albedo.bytes/(firstPage.mips[0].atlasPixels[0]*firstPage.mips[0].atlasPixels[1]);
 check(bpp===4||bpp===8,'Unsupported cluster texel layout');const textureFormat=bpp===4?'rgba8unorm':'rgba16float';
 const pages=tiers.flatMap(t=>t.pages.map(p=>({tier:t,page:p}))),bytes=layout.width*layout.height*pages.length*bpp*3;
 const nativeMaps=new Map();for(const m of inspection?.materials||[])for(const key of ['albedo','normal'])nativeMaps.set(m[key].file,m[key].width*m[key].height*4);const nativeTextureBytes=[...nativeMaps.values()].reduce((a,b)=>a+b,0);
 check(pages.length<=device.limits.maxTextureArrayLayers&&layout.width<=device.limits.maxTextureDimension2D&&layout.height<=device.limits.maxTextureDimension2D&&bytes+nativeTextureBytes<=maxTextureBytes,'Pilot texture pages exceed bounded GPU residency');
 const B=GPUBufferUsage,T=GPUTextureUsage,buffers=[],textures=[],pageIDs=new Map();let bufferBytes=0;
 const make=(data,usage,label)=>{check(data.byteLength<=device.limits.maxBufferSize&&(!(usage&B.STORAGE)||data.byteLength<=device.limits.maxStorageBufferBindingSize),'Pilot buffer exceeds device residency limit');const b=device.createBuffer({label,size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});buffers.push(b);bufferBytes+=Math.max(4,data.byteLength);if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;};
 try{
  for(const channel of channels)textures.push(device.createTexture({label:'forest pilot '+channel,size:[layout.width,layout.height,pages.length],format:textureFormat,usage:T.COPY_DST|T.TEXTURE_BINDING}));
  for(const [layer,row]of pages.entries()){
   const page=await pack.loadPage(prototype,row.tier,row.page);pageIDs.set(row.tier.maxLeaves+':'+row.page.index,layer);
   check(JSON.stringify(packForestClusterMips(page.mips))===JSON.stringify(layout),'Inconsistent pilot page mip dimensions');
   for(const [level,mip]of page.mips.entries())for(const [channel,name]of channels.entries()){
    const [x,y,w,h]=layout.rects[level];check(mip.data[name].byteLength===w*h*bpp,'Pilot texel byte layout mismatch');
    device.queue.writeTexture({texture:textures[channel],origin:[x,y,layer]},mip.data[name],{bytesPerRow:w*bpp,rowsPerImage:h},[w,h]);
   }
   pack.releasePage(prototype,row.tier,row.page);
  }
  const data=new ArrayBuffer(nodes.length*160),f=new Float32Array(data),u=new Uint32Array(data);
  for(const [id,c]of nodes.entries()){
   const at=id*40;f.set([...c.centre,c.extent],at);u.set([c.parent<0?0xffffffff:c.parent,c.depth,c.childCount,c.native?(id|0x80000000)>>>0:id],at+4);
   const low=c.low??c.centre.map(n=>n-c.extent),high=c.high??c.centre.map(n=>n+c.extent);check(vector(low,3)&&vector(high,3)&&low.every((n,i)=>n<=high[i]),'Invalid source cluster bounds');const errorValue=new Float32Array([c.ribbon?c.reductionErrorMetres:0]);if(errorValue[0]<(c.reductionErrorMetres??0))new Uint32Array(errorValue.buffer)[0]++;check(Number.isFinite(errorValue[0]),'Ribbon error exceeds GPU Float32 range');f.set([...low,errorValue[0],...high,c.ribbon?ribbonErrorPixels:0],at+32);
   if(c.native){const part=selection.clusters.get(c.selectionKey??c.sourceNodeID);check(part&&part.indexCount===c.indexCount,'Inspection material cover differs');u.set([part.firstPart,c.indexCount,part.partCount,0],at+8);}
   else for(const v of c.views)u.set([v.tile[0],v.tile[1],pageIDs.get(c.maxLeaves+':'+v.page),0],at+8+v.index*4);
  }
  const clusterBuffer=make(new Uint8Array(data),B.STORAGE,'forest pilot immutable source cluster bounds and captures');
  const rootData=new Float32Array(roots.length*8);for(const [id,r]of roots.entries()){check(r.length>=5&&r.every(Number.isFinite)&&r[3]>0,'Invalid pilot root transform');rootData.set([...r.slice(0,4),r[4],1,1,1],id*8);}
  const rootBuffer=make(rootData,B.STORAGE,'forest pilot immutable root instances'),viewData=new Float32Array(6*12);
  for(const [i,v]of nodes[0].views.entries())viewData.set([...v.direction,0,...v.right,0,...v.up,0],i*12);
  const viewBuffer=make(viewData,B.STORAGE,'forest pilot capture frames'),mipData=new Float32Array(firstPage.mips.length*8);
  for(const [level,mip]of firstPage.mips.entries())mipData.set([...layout.rects[level],mip.pitchPixels,mip.tilePixels,mip.gutter,0],level*8);
  const mipBuffer=make(mipData,B.STORAGE,'forest pilot independent mip rectangles'),camera=make(new Float32Array(32),B.UNIFORM,'forest pilot camera and review controls');
  check(!inspection||roots.length<=64,'Inspection pilot limits native draw slots to64 roots');
  check(!inspection||roots.length===1||device.features.has('indirect-first-instance'),'Multi-root inspection requires indirect-first-instance');
  // Header12: existing4=colour indices,9=colour triangles,10=native clusters;
  // static6=bin count,7=index capacity/root,8=prepass;11=extra depth indices.
  // Commands follow root-major/material-minor, five u32 each. Their firstIndex
  // owns a fixed bin span; only indexCount changes during GPU selection.
  const binCount=selection?.bins.length||1,initialCommands=new Uint32Array(12+roots.length*binCount*5);initialCommands[0]=bakedTriangles*3;initialCommands[5]=1;initialCommands[6]=selection?.bins.length||0;initialCommands[7]=inspection?.indices.length||0;initialCommands[8]=inspection&&inspectionDepthPrepass?1:0;
  for(let root=0;root<roots.length;root++)for(let bin=0;bin<binCount;bin++)initialCommands.set([0,1,root*(inspection?.indices.length||0)+(selection?.bins[bin].firstIndex||0),0,root],12+(root*binCount+bin)*5);
  const count=nodes.length*roots.length,decisions=make(new Uint32Array(count),B.STORAGE,'forest pilot previous refinement'),visible=make(new Uint32Array(count),B.STORAGE|B.COPY_SRC,'forest pilot GPU visible clusters'),commands=make(initialCommands,B.STORAGE|B.INDIRECT|B.COPY_SRC,'forest pilot bounded indirect draws');
  check(!inspection||inspection.vertices.byteLength/60*roots.length<=0xffffffff,'Inspection root-address range exceeds u32');
  const sourceIndices=make(selection?.indices||new Uint32Array(1),B.STORAGE,'forest inspection immutable material-part source indices');
  const sourceParts=make(selection?.parts||new Uint32Array(4),B.STORAGE,'forest inspection immutable cluster material parts');
  const selectedIndices=make(new Uint32Array(Math.max(1,(inspection?.indices.length||0)*roots.length)),B.STORAGE|B.INDEX,'forest inspection GPU compacted indexed cover');
  const parallelCompaction=!!inspection&&roots.length>0&&inspectionCompaction==='parallel',taskCapacity=parallelCompaction?selection.parts.length/4*roots.length:0;
  const taskDispatchWidth=Math.min(256,device.limits.maxComputeWorkgroupsPerDimension);
  check(!parallelCompaction||uint(taskCapacity)&&taskCapacity>0&&taskCapacity<=0xffffffff&&taskCapacity*16<=device.limits.maxBufferSize&&taskCapacity*16<=device.limits.maxStorageBufferBindingSize&&taskCapacity<=taskDispatchWidth*device.limits.maxComputeWorkgroupsPerDimension,'Inspection copy task queue exceeds bounded device buffer/dispatch limits');
  const copyTasks=parallelCompaction?make(new Uint32Array(taskCapacity*4),B.STORAGE,'forest inspection bounded GPU copy tasks'):null;
  const copyState=parallelCompaction?make(new Uint32Array([0,taskCapacity,0,taskDispatchWidth]),B.STORAGE,'forest inspection GPU task count/capacity/overflow/width'):null;
  const copyDispatch=parallelCompaction?make(new Uint32Array([0,1,1,0]),B.STORAGE|B.INDIRECT,'forest inspection separate indirect copy dispatch'):null;
  const module=device.createShaderModule({label:'forest pilot cluster detail',code:forestInspectionCompactionShader(parallelCompaction?'parallel':'serial')}),errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');check(errors.length===0,errors.map(e=>e.message).join('\n'));
  const S=GPUShaderStage,commonLayout=device.createBindGroupLayout({entries:[
   {binding:0,visibility:S.VERTEX|S.FRAGMENT|S.COMPUTE,buffer:{type:'uniform'}},
   ...[1,2,3,4,9].map(binding=>({binding,visibility:S.VERTEX|S.FRAGMENT|([1,2].includes(binding)?S.COMPUTE:0),buffer:{type:'read-only-storage'}})),
   ...[5,6,7].map(binding=>({binding,visibility:S.VERTEX|S.FRAGMENT,texture:{viewDimension:'2d-array'}})),{binding:8,visibility:S.VERTEX|S.FRAGMENT,sampler:{type:'filtering'}}]}),
   computeLayout=device.createBindGroupLayout({entries:[0,1,2].map(binding=>({binding,visibility:S.COMPUTE,buffer:{type:'storage'}}))});
  const commonEntries=[{binding:0,resource:{buffer:camera}},...[clusterBuffer,rootBuffer,viewBuffer,mipBuffer].map((buffer,i)=>({binding:i+1,resource:{buffer}})),...textures.map((t,i)=>({binding:i+5,resource:t.createView({dimension:'2d-array'})})),{binding:8,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},{binding:9,resource:{buffer:visible}}];
  // Render and compute intentionally use different layouts for visible-read vs
  // visible-write, avoiding an alias in one dispatch resource usage scope.
  const drawGroup=device.createBindGroup({layout:commonLayout,entries:commonEntries});
  const computeCommon=device.createBindGroup({layout:commonLayout,entries:commonEntries.map(e=>e.binding===9?{binding:9,resource:{buffer:mipBuffer}}:e)});
  const computeGroup=device.createBindGroup({layout:computeLayout,entries:[decisions,visible,commands].map((buffer,binding)=>({binding,resource:{buffer}}))});
  // Parallel culling reads only source parts. Removing unused index bindings
  // keeps its explicit layout at eight compute storage buffers, the core limit.
  const indexLayout=device.createBindGroupLayout({entries:[...(parallelCompaction?[]:[{binding:0,visibility:S.COMPUTE,buffer:{type:'read-only-storage'}},{binding:1,visibility:S.COMPUTE,buffer:{type:'storage'}}]),{binding:2,visibility:S.COMPUTE,buffer:{type:'read-only-storage'}}]});
  const indexGroup=device.createBindGroup({layout:indexLayout,entries:[...(parallelCompaction?[]:[{binding:0,resource:{buffer:sourceIndices}},{binding:1,resource:{buffer:selectedIndices}}]),{binding:2,resource:{buffer:sourceParts}}]});
  const taskLayout=parallelCompaction?device.createBindGroupLayout({entries:[0,1].map(binding=>({binding,visibility:S.COMPUTE,buffer:{type:'storage'}}))}):null;
  const taskGroup=parallelCompaction?device.createBindGroup({layout:taskLayout,entries:[copyTasks,copyState].map((buffer,binding)=>({binding,resource:{buffer}}))}):null;
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[commonLayout,computeLayout,indexLayout,...(parallelCompaction?[taskLayout]:[])]});
  const reset=await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'clusterReset'}}),refine=await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'clusterRefine'}}),cull=await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'clusterCull'}});
  let finalizePipeline,copyPipeline,finalizeGroup,copyGroup;
  if(parallelCompaction){
   const compile=async(code,label)=>{const m=device.createShaderModule({label,code}),errors=(await m.getCompilationInfo()).messages.filter(m=>m.type==='error');check(errors.length===0,errors.map(e=>e.message).join('\n'));return m;};
   const finalizeModule=await compile(FOREST_INSPECTION_TASK_FINALIZE_WGSL,'forest inspection bounded task dispatch'),copyModule=await compile(FOREST_INSPECTION_TASK_COPY_WGSL,'forest inspection coalesced64-lane copies');
   const finalizeLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.COMPUTE,buffer:{type:'read-only-storage'}},...[1,2].map(binding=>({binding,visibility:S.COMPUTE,buffer:{type:'storage'}}))]});
   const copyLayout=device.createBindGroupLayout({entries:[0,1,2,3].map(binding=>({binding,visibility:S.COMPUTE,buffer:{type:binding===2?'storage':'read-only-storage'}}))});
   finalizeGroup=device.createBindGroup({layout:finalizeLayout,entries:[copyState,copyDispatch,commands].map((buffer,binding)=>({binding,resource:{buffer}}))});
   copyGroup=device.createBindGroup({layout:copyLayout,entries:[copyTasks,sourceIndices,selectedIndices,copyState].map((buffer,binding)=>({binding,resource:{buffer}}))});
   finalizePipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[finalizeLayout]}),compute:{module:finalizeModule,entryPoint:'inspectionFinalize'}});
   copyPipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[copyLayout]}),compute:{module:copyModule,entryPoint:'inspectionCopy'}});
  }
  const render=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[commonLayout]}),vertex:{module,entryPoint:meshSegments?'clusterMeshVS':'clusterVS'},fragment:{module,entryPoint:meshSegments?'clusterMeshFS':'clusterFS',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'},multisample:{count:samples}});
  const native=inspection?await createInspectionDraw({device,inspection,make,textures,commonLayout,format,samples,depthPrepass:inspectionDepthPrepass,inspectionShading}):null;
  return{prototype,nodes,roots,commands,visible,camera,stats:{candidate:true,appearanceStatus:'unqualified',nodes:nodes.length,finestTriangles,additionalTriangles,additionalDepthTriangles,finestSubmittedTriangles:finestTriangles+additionalDepthTriangles,maximumColourFrontierTriangles,maximumFrontierTriangles,maximumSubmittedTriangles:maximumFrontierTriangles+additionalTriangles,captureLayers,meshSegments,inspectionSourceTriangles:inspection?.reduction?.sourceTriangles??(inspection?.indices.length/3||0),inspectionStoredTriangles:inspection?.indices.length/3||0,inspectionReducedTriangles:inspection?.reduction?.reducedTriangles??null,inspectionReduction:inspection?.reduction??null,inspectionRibbonErrorPixels:ribbonErrorPixels,inspectionDepthPrepass:!!inspection&&inspectionDepthPrepass,inspectionShading,inspectionCompaction,parallelInspectionCompaction:parallelCompaction,inspectionCopyTaskCapacity:taskCapacity,inspectionCopyTaskBytes:parallelCompaction?taskCapacity*16+32:0,inspectionCopyLanes:parallelCompaction?64:0,inspectionMaterialBins:selection?.bins.map(b=>({...b}))||[],indirectHeaderWords:12,indirectRootStride:binCount*20,textureBytes:bytes+(native?.textureBytes||0),bufferBytes,layers:pages.length,layout,bpp},
   writeCamera(data){check(data instanceof Float32Array&&data.length===32,'Invalid pilot camera uniforms');data[30]=bpp===4?1:0;data[31]=meshSegments;device.queue.writeBuffer(camera,0,data);},
   encode(encoder,descriptor={}){
    let firstDescriptor=descriptor,lastDescriptor={label:'forest inspection coalesced index copy'};
    // Preserve one caller timing interval over all three passes. Never reuse a
    // query index for both the cull end and the final copy end.
    if(parallelCompaction&&descriptor.timestampWrites){const {beginningOfPassWriteIndex,endOfPassWriteIndex,...timing}=descriptor.timestampWrites;
     firstDescriptor={...descriptor,timestampWrites:beginningOfPassWriteIndex===undefined?undefined:{...timing,beginningOfPassWriteIndex}};
     lastDescriptor={...lastDescriptor,timestampWrites:endOfPassWriteIndex===undefined?undefined:{...timing,endOfPassWriteIndex}};
    }
    const p=encoder.beginComputePass(firstDescriptor);p.setBindGroup(0,computeCommon);p.setBindGroup(1,computeGroup);p.setBindGroup(2,indexGroup);if(parallelCompaction)p.setBindGroup(3,taskGroup);
    p.setPipeline(reset);p.dispatchWorkgroups(1);p.setPipeline(refine);p.dispatchWorkgroups(Math.ceil(count/64));p.setPipeline(cull);p.dispatchWorkgroups(Math.ceil(count/64));p.end();
    if(parallelCompaction){
     const finalize=encoder.beginComputePass({label:'forest inspection finalize copy dispatch'});finalize.setPipeline(finalizePipeline);finalize.setBindGroup(0,finalizeGroup);finalize.dispatchWorkgroups(1);finalize.end();
     // copyDispatch has INDIRECT usage only in this pass; it is not a storage
     // binding here. Task/state/source reads are separate from selected writes.
     const copy=encoder.beginComputePass(lastDescriptor);copy.setPipeline(copyPipeline);copy.setBindGroup(0,copyGroup);copy.dispatchWorkgroupsIndirect(copyDispatch,0);copy.end();
    }
   },
   draw(pass){pass.setPipeline(render);pass.setBindGroup(0,drawGroup);pass.drawIndirect(commands,0);if(native){pass.setVertexBuffer(0,native.vertices);pass.setIndexBuffer(selectedIndices,'uint32');if(native.depthPipeline){pass.setPipeline(native.depthPipeline);for(let bin=0;bin<binCount;bin++){pass.setBindGroup(1,native.groups[bin]);for(let root=0;root<roots.length;root++)pass.drawIndexedIndirect(commands,48+(root*binCount+bin)*20);}}pass.setPipeline(native.pipeline);for(let bin=0;bin<binCount;bin++){pass.setBindGroup(1,native.groups[bin]);for(let root=0;root<roots.length;root++)pass.drawIndexedIndirect(commands,48+(root*binCount+bin)*20);}}},
   destroy(){for(const b of buffers)b.destroy();for(const t of textures)t.destroy();}};
 }catch(error){for(const b of buffers)b.destroy();for(const t of textures)t.destroy();throw error;}
}

// Original complete leaf blades are an inspection child, never an automatic
// whole-plant fallback. Static pages upload once; GPU compaction selects every
// branch and compacts its indices, retaining indexed vertex-cache reuse. No
// per-frame CPU geometry work, padded triangles or per-node draw calls.
const INSPECTION_SHADER=FOREST_CLUSTER_PILOT_WGSL.split('@group(1)')[0]+/* wgsl */`
struct Material {controls:vec4f,underside:vec4f};
@group(1)@binding(0)var<uniform>M:Material;
@group(1)@binding(1)var leafSampler:sampler;
@group(1)@binding(2)var leafPigment:texture_2d<f32>;
@group(1)@binding(3)var leafNormals:texture_2d<f32>;
fn leafRotate(p:vec3f,rotation:vec2f)->vec3f{return vec3f(rotation.x*p.x-rotation.y*p.z,p.y,rotation.y*p.x+rotation.x*p.z);}
struct LeafVertex {
 @builtin(position)position:vec4f,
 @location(0)@interpolate(perspective,sample)local:vec3f,
 @location(1)@interpolate(perspective,sample)normal:vec3f,
 @location(2)@interpolate(perspective,sample)uv:vec2f,
 @location(3)@interpolate(perspective,sample)colour:vec3f,
 @location(4)@interpolate(perspective,sample)light:vec2f,
 @location(5)@interpolate(flat)rootRotation:vec2f,
};
struct LeafInput {@location(0)local:vec3f,@location(1)normal:vec3f,@location(2)kindShade:vec2f,@location(3)uv:vec2f,@location(4)colour:vec3f,@location(5)material:f32,@location(6)ao:f32};
@vertex fn leafVS(in:LeafInput,@builtin(instance_index)root:u32)->LeafVertex{
 let r=roots[root];let rotation=vec2f(cos(r.yawTint.x),sin(r.yawTint.x));let world=r.positionScale.xyz+leafRotate(in.local*r.positionScale.w,rotation);
 var o:LeafVertex;o.position=C.viewProj*vec4f(world,1);o.local=in.local;o.normal=leafRotate(in.normal,rotation);o.uv=in.uv;o.colour=in.colour;
 o.light=vec2f(in.kindShade.y,in.ao);o.rootRotation=rotation;return o;
}
@fragment fn leafDepthFS(in:LeafVertex,@builtin(sample_index)sampleIndex:u32)->@location(0)vec4f{
 let alpha=textureSampleLevel(leafPigment,leafSampler,in.uv,0.).a;if(in.local.y<0.||alpha<M.underside.w){discard;}return vec4f(0);
}
@fragment fn leafFS(in:LeafVertex,@builtin(front_facing)front:bool,@builtin(sample_index)sampleIndex:u32)->@location(0)vec4f{
 // Match the native reference: derivatives precede source MASK discard;
 // alpha rejection precedes normal-map shading, then map before back-flip.
 let dx=leafRotate(dpdx(in.local),in.rootRotation);let dy=leafRotate(dpdy(in.local),in.rootRotation);let ux=dpdx(in.uv);let uy=dpdy(in.uv);
 let pigment=textureSampleLevel(leafPigment,leafSampler,in.uv,0.);if(in.local.y<0.||pigment.a<M.underside.w){discard;}
 var n=normalize(in.normal);let detail=textureSampleLevel(leafNormals,leafSampler,in.uv,0.).xyz*2.-vec3f(1);
 let determinant=ux.x*uy.y-ux.y*uy.x;let direction=select(-1.,1.,determinant>=0.);let tangent=dx*uy.y-dy*ux.y;let bitangent=dy*ux.x-dx*uy.x;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;let sampled=normalize(detail);n=normalize(t*sampled.x+b*sampled.y+n*sampled.z);}
 var colour=pigment.rgb*in.colour;if(!front){n=-n;colour=mix(colour,M.underside.rgb*in.colour,M.controls.x);}
 let exposure=clamp(in.light.x,0.,1.);let ao=clamp(in.light.y,0.,1.);let ndl=dot(n,normalize(C.sunExposure.xyz));
 let diffuse=(max(ndl,0.)+max(-ndl,0.)*M.controls.w)*(.22+.78*exposure*exposure)*(.35+.65*ao);let ambient=(.12+.55*exposure+.08*abs(n.y))*ao;
 if(C.screen.z==1.){return vec4f(1);}if(C.screen.z==2.){return vec4f(1,.3,.2,1);}
 let rgb=max(colour*(diffuse+ambient)*C.sunExposure.w,vec3f(0));return vec4f(pow(rgb/(vec3f(1)+rgb),vec3f(1./2.2)),1);
}
`;

// Keep the physical per-sample shader as the review control. Pixel shading
// evaluates four source MASK probes but shares normal-map and light evaluation.
// Probe positions are an explicit approximation, not portable hardware sample
// locations; rendered support/coverage gates must qualify each intended tier.
export function forestInspectionShader(mode='sample'){
 check(['sample','pixel','pixel-depth'].includes(mode),'Invalid inspection shading mode');
 if(mode==='sample')return INSPECTION_SHADER;
 const coverage=`
struct LeafFragment {@location(0)colour:vec4f,@builtin(sample_mask)mask:u32};
struct LeafCoverage {mask:u32,uv:vec2f,pigment:vec4f};
fn leafCoverage(uv:vec2f,ux:vec2f,uy:vec2f,y:f32,yx:f32,yy:f32)->LeafCoverage{
 let offsets=array<vec2f,4>(vec2f(-.125,-.375),vec2f(.375,-.125),vec2f(-.375,.125),vec2f(.125,.375));
 var o:LeafCoverage;var count=0.;
 for(var bit=0u;bit<4u;bit++){
  let q=uv+ux*offsets[bit].x+uy*offsets[bit].y;let pigment=textureSampleLevel(leafPigment,leafSampler,q,0.);
  if(pigment.a>=M.underside.w&&y+yx*offsets[bit].x+yy*offsets[bit].y>=0.){o.mask|=1u<<bit;o.uv+=q;o.pigment+=pigment;count+=1.;}
 }
 if(count>0.){o.uv/=count;o.pigment/=count;}else{o.uv=uv;o.pigment=textureSampleLevel(leafPigment,leafSampler,uv,0.);}
 return o;
}
fn leafOutput(rgb:vec4f,mask:u32)->LeafFragment{var o:LeafFragment;o.colour=rgb;o.mask=mask;return o;}
`;
 let code=INSPECTION_SHADER.replaceAll('@interpolate(perspective,sample)','@interpolate(perspective,center)')
  .replace('struct LeafVertex {',coverage+'struct LeafVertex {')
  .replace('@fragment fn leafDepthFS(in:LeafVertex,@builtin(sample_index)sampleIndex:u32)->@location(0)vec4f{',
   '@fragment fn leafDepthFS(in:LeafVertex)->LeafFragment{')
  .replace('let alpha=textureSampleLevel(leafPigment,leafSampler,in.uv,0.).a;if(in.local.y<0.||alpha<M.underside.w){discard;}return vec4f(0);',
   'let coverage=leafCoverage(in.uv,dpdx(in.uv),dpdy(in.uv),in.local.y,dpdx(in.local.y),dpdy(in.local.y));if(coverage.mask==0u){discard;}return leafOutput(vec4f(0),coverage.mask);')
  .replace('@fragment fn leafFS(in:LeafVertex,@builtin(front_facing)front:bool,@builtin(sample_index)sampleIndex:u32)->@location(0)vec4f{',
   '@fragment fn leafFS(in:LeafVertex,@builtin(front_facing)front:bool)->LeafFragment{')
  .replace('let pigment=textureSampleLevel(leafPigment,leafSampler,in.uv,0.);if(in.local.y<0.||pigment.a<M.underside.w){discard;}',
   'let coverage=leafCoverage(in.uv,ux,uy,in.local.y,dpdx(in.local.y),dpdy(in.local.y));let mask=coverage.mask;let pigment=coverage.pigment;if(mask==0u){discard;}')
  .replace('textureSampleLevel(leafNormals,leafSampler,in.uv,0.)','textureSampleLevel(leafNormals,leafSampler,coverage.uv,0.)')
  .replace('return vec4f(1);','return leafOutput(vec4f(1),mask);')
  .replace('return vec4f(1,.3,.2,1);','return leafOutput(vec4f(1,.3,.2,1),mask);')
  .replace('return vec4f(pow(rgb/(vec3f(1)+rgb),vec3f(1./2.2)),1);','return leafOutput(vec4f(pow(rgb/(vec3f(1)+rgb),vec3f(1./2.2)),1),mask);');
 if(mode==='pixel-depth')code=code
  .replace('@fragment fn leafFS(in:LeafVertex,@builtin(front_facing)front:bool)->LeafFragment{','@fragment fn leafFS(in:LeafVertex,@builtin(front_facing)front:bool)->@location(0)vec4f{')
  .replace('if(mask==0u){discard;}','')
  .replace('return leafOutput(vec4f(1),mask);','return vec4f(1);')
  .replace('return leafOutput(vec4f(1,.3,.2,1),mask);','return vec4f(1,.3,.2,1);')
  .replace('return leafOutput(vec4f(pow(rgb/(vec3f(1)+rgb),vec3f(1./2.2)),1),mask);','return vec4f(pow(rgb/(vec3f(1)+rgb),vec3f(1./2.2)),1);');
 check(!code.includes('@builtin(sample_index)'),'Pixel shading accidentally retained per-sample execution');return code;
}

async function createInspectionDraw({device,inspection,make,textures,commonLayout,format,samples,depthPrepass,inspectionShading}){
 const B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage,materials=inspection.materials;
 check(materials.length>0&&materials.length<=16,'Invalid inspection materials');let textureBytes=0;
 const vertices=make(inspection.vertices,B.VERTEX,'forest inspection immutable original60B leaf vertices'),linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
 const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:S.FRAGMENT,buffer:{type:'uniform',minBindingSize:32}},{binding:1,visibility:S.FRAGMENT,sampler:{}},...[2,3].map(binding=>({binding,visibility:S.FRAGMENT,texture:{}}))]}),images=new Map(),groups=[];
 function image(r,encoding){
  const existing=images.get(r.file);if(existing){check(existing.encoding===encoding,'Conflicting inspection image encoding');return existing.texture;}
  const source=inspection.textures.get(r.file);check(source&&source.width===r.width&&source.height===r.height&&source.encoding===encoding,'Inspection original texture dimensions/encoding differ');
  const texture=device.createTexture({label:'forest inspection original '+r.file,size:[r.width,r.height],format:encoding==='srgb'?'rgba8unorm-srgb':'rgba8unorm',usage:T.COPY_DST|T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});textures.push(texture);textureBytes+=r.width*r.height*4;
  device.queue.copyExternalImageToTexture({source:source.bitmap},{texture,premultipliedAlpha:false},[r.width,r.height]);images.set(r.file,{texture,encoding});return texture;
 }
 for(const m of materials){
  const albedo=image(m.albedo,'srgb'),normal=image(m.normal,'linear'),optics=make(new Float32Array([m.underside,1,m.roughness,m.transmission,...m.undersideReference.map(linear),m.opacityThreshold]),B.UNIFORM,'forest inspection immutable material'+m.index+' optics'),sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
  groups.push(device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:optics}},{binding:1,resource:sampler},{binding:2,resource:albedo.createView()},{binding:3,resource:normal.createView()}]}));
 }
 const module=device.createShaderModule({label:'forest original leaf inspection',code:forestInspectionShader(inspectionShading)}),errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');check(errors.length===0,errors.map(e=>e.message).join('\n'));
 const vertexLayout={arrayStride:60,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x2'},{shaderLocation:4,offset:40,format:'float32x3'},{shaderLocation:5,offset:52,format:'float32'},{shaderLocation:6,offset:56,format:'float32'}]};
 const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[commonLayout,layout]}),base={layout:pipelineLayout,vertex:{module,entryPoint:'leafVS',buffers:[vertexLayout]},primitive:{topology:'triangle-list',frontFace:'ccw',cullMode:'none'},multisample:{count:samples,alphaToCoverageEnabled:false}};
 const depthModule=inspectionShading==='pixel-depth'?device.createShaderModule({label:'forest original sample MASK depth',code:INSPECTION_SHADER}):module;
 const depthPipeline=depthPrepass?await device.createRenderPipelineAsync({...base,vertex:{...base.vertex,module:depthModule},fragment:{module:depthModule,entryPoint:'leafDepthFS',targets:[{format,writeMask:0}]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}}):null;
 const pipeline=await device.createRenderPipelineAsync({...base,fragment:{module,entryPoint:'leafFS',targets:[{format}]},depthStencil:{format:'depth32float',depthWriteEnabled:!depthPrepass,depthCompare:depthPrepass?'equal':'less'}});
 return{pipeline,depthPipeline,groups,textureBytes,vertices};
}
