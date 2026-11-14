// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Trees as cluster hierarchies, cut per tree on the GPU so each stays within a pixel error at any
// distance. Built offline by scripts/prepare-forest-clusters.mjs with the builder from threejs-nanites.
import { FOREST_CROWN_SPLAT_PIXELS, FOREST_CROWN_MIN_PIXELS, FOREST_CROWN_LIMIT, FOREST_CROWN_NEAREST, FOREST_CROWN_BAND, forestCrownLook, forestCrownSplatLook } from './forest-crowns.js';

export const FOREST_CLUSTER_VERTEX_WORDS = 5;
export const FOREST_CLUSTER_WORDS = 16;
export const FOREST_LEAF_VERTICES = 6;
const CROWN_CONT_REGION = 0;
const CROWN_SPLAT_REGION = 1;
const CROWN_FADE_REGION = 2;
const CROWN_LISTS = 3;
const CROWN_CONT_TRIS_PER_SPECIES = 262144;

const unit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const unit8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
// Octahedral normal, so two 16-bit values hold a whole direction.
function octahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * .5 + .5, v * .5 + .5];
}
// One vertex as five 32-bit words. Colour is stored as its square root, which keeps dark values distinct.
export function packForestClusterVertex({ position, normal, uv, colour, material, shade, canopy }, { low, posScale, uvLow, uvScale }) {
  const p = position.map((v, a) => unit16((v - low[a]) / posScale)), n = octahedral(normal);
  return [
    (p[0] | (p[1] << 16)) >>> 0,
    (p[2] | (Math.max(0, material) << 16) | (unit8(shade) << 24)) >>> 0,
    (unit16(n[0]) | (unit16(n[1]) << 16)) >>> 0,
    (unit16((uv[0] - uvLow[0]) / uvScale[0]) | (unit16((uv[1] - uvLow[1]) / uvScale[1]) << 16)) >>> 0,
    (unit8(Math.sqrt(colour[0])) | (unit8(Math.sqrt(colour[1])) << 8) | (unit8(Math.sqrt(colour[2])) << 16) | (unit8(canopy) << 24)) >>> 0,
  ];
}

// Literal paths: build.mjs finds what to publish by reading them from the source.
export const FOREST_CLUSTER_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/saba/clusters/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/saba/clusters/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/saba/clusters/indices.bin.gz',
  'clusters.bin.gz': 'assets/forest-scenery/saba/clusters/clusters.bin.gz',
});
export const SUBTROPICAL_FOREST_CLUSTER_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/clusters/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/subtropical/clusters/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/subtropical/clusters/indices.bin.gz',
  'clusters.bin.gz': 'assets/forest-scenery/subtropical/clusters/clusters.bin.gz',
});

export const PORTUGAL_FOREST_CLUSTER_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/clusters/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/portugal/clusters/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/portugal/clusters/indices.bin.gz',
  'clusters.bin.gz': 'assets/forest-scenery/portugal/clusters/clusters.bin.gz',
});

export async function loadForestClusters({ assets = FOREST_CLUSTER_ASSETS, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Forest clusters unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = await (await get('manifest.json')).json();
  if (manifest?.format !== 'waterworld.forest-clusters' || manifest.version !== 1 || manifest.vertexWords !== FOREST_CLUSTER_VERTEX_WORDS || manifest.clusterWords !== FOREST_CLUSTER_WORDS) throw Error('Invalid forest cluster manifest');
  const stream = async (name) => {
    const receipt = manifest.files[name], response = await get(receipt.gzip.file);
    const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== receipt.bytes) throw Error(`Forest cluster stream has the wrong size: ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error(`Forest cluster stream failed verification: ${name}`);
    return bytes;
  };
  const [vertices, indices, clusters] = await Promise.all(['vertices.bin', 'indices.bin', 'clusters.bin'].map(stream));
  return { manifest, vertices, indices, clusters };
}

// The cut one tree draws, as the GPU picks it: a cluster is drawn when its own error is within the
// limit and its parent's is not. Used by tests; the game does this in FOREST_CLUSTER_SELECT.
export function forestClusterIsDrawn({ error, parentError, lodDistance, parentDistance }, pixelsPerMetre, limit) {
  const projected = (e, d) => (e * pixelsPerMetre) / Math.max(d, 1e-3);
  return projected(error, lodDistance) <= limit && projected(parentError, parentDistance) > limit;
}

// Trees already culled and sorted into near, mid and far lists by the forest's own pass. This takes
// each near or mid tree's cut and lists its clusters for one indirect draw per species and kind.
export const FOREST_CLUSTER_SELECT = (FRAME, crown = {}) => FRAME + /* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
struct ForestCluster {lod:vec4f,parentLod:vec4f,cull:vec4f,err:f32,parentErr:f32,first:u32,shape:u32};
struct ForestClusterBucket {
 firstCluster:u32,clusterCount:u32,listWood:u32,listLeaf:u32,
 near:vec2u,mid:vec2u,far:vec2u,drawWood:u32,drawLeaf:u32,
 centre:vec4f,capacity:vec4u,
 // Far crowns (js/forest-crowns.js): continuum triangle list base, first crown indirect draw, stepStates
 // (stepCount + 1, or 0 when disabled), continuum triangle capacity; then splat/fade list bases, rootCount,
 // and morphOffset in crownMorph.
 crown:vec4u,crownLists:vec4u,
 // crownSize.x = breadthMetres / widestLeafErrors (0 in closed woods), crownSize.y = breadthMetres,
 // crownSize.z = leafErrorMetres.
 crownSize:vec4f,
 horizon:vec4u,
};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>roots:array<ForestRoot>;
@group(0)@binding(2)var<storage,read>visible:array<u32>;
@group(0)@binding(3)var<storage,read>commands:array<u32>;
@group(0)@binding(4)var<storage,read>clusters:array<ForestCluster>;
@group(0)@binding(5)var<storage,read_write>list:array<vec2u>;
@group(0)@binding(6)var<storage,read_write>draws:array<atomic<u32>>;
@group(0)@binding(7)var<uniform>parameters:vec4f;
@group(0)@binding(8)var<uniform>bucket:ForestClusterBucket;
struct ForestClusterShadowBox {lightView:mat4x4f,origin:vec4f,sun:vec4f,texel:vec4f};
@group(0)@binding(9)var<uniform>shadowBox:ForestClusterShadowBox;
@group(0)@binding(10)var<storage,read>crownMorph:array<u32>;
// Shares of the forest's pixel error each kind may use. A leaf's error is its size, which stays
// visible as a card, so leaves need the tighter limit. Wood is thin and hides among them.
// Each halving of the leaf share draws four times the cards. At .2 the cards stayed about two pixels
// across and Lisbon's town view drew 23 million leaf triangles; at .4 it draws 6 million and the canopy
// looks the same.
const FOREST_CLUSTER_LEAF_LIMIT=.4;
const FOREST_CLUSTER_WOOD_LIMIT=.5;
// A crown takes over from a tree's leaves at the range where a leaf cut of the error its manifest names
// (crownSize.z) is drawn, so a sharper view or a spyglass carries the change further out; never nearer
// than the range at which leaf cards have reached their far shape and coverage (forestClusterVertex,
// forestNativeLeafDepthFS). Over a further share of that distance a tree wears both, sample by sample
// (forestCrownSamples). Beyond that, its single genus-0 base mesh decimates smoothly one half-edge collapse
// at a time by angular pixel span down to a 4-triangle core and 1-triangle horizon splat at 1 pixel.
const FOREST_CROWN_LIMIT=${(crown.limit ?? FOREST_CROWN_LIMIT).toFixed(4)};
const FOREST_CROWN_NEAREST=${(crown.nearest ?? FOREST_CROWN_NEAREST).toFixed(2)};
const FOREST_CROWN_BAND=${(crown.band ?? FOREST_CROWN_BAND).toFixed(4)};
const FOREST_CROWN_SPLAT_PIXELS=${(crown.splatPixels ?? FOREST_CROWN_SPLAT_PIXELS).toFixed(4)};
const FOREST_CROWN_MIN_PIXELS=${(crown.minPixels ?? FOREST_CROWN_MIN_PIXELS).toFixed(4)};
fn forestClusterHash(value:u32)->u32{var x=value;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}
fn forestClusterTree(index:u32)->u32{
 let nearCount=commands[bucket.near.y*5u+1u];
 if(index<nearCount){return visible[bucket.near.x+index];}
 let midCount=commands[bucket.mid.y*5u+1u];
 if(index-nearCount<midCount){return visible[bucket.mid.x+index-nearCount];}
 let farCount=commands[bucket.far.y*5u+1u];
 if(index-nearCount-midCount<farCount){return visible[bucket.far.x+index-nearCount-midCount];}
 if(bucket.horizon.z!=0u){
  let horizonCount=commands[bucket.horizon.y*5u+1u];
  let rem=index-nearCount-midCount-farCount;
  if(rem<horizonCount){return visible[bucket.horizon.x+rem];}
 }
 return 0xffffffffu;
}
@compute @workgroup_size(64)fn forestClusterSelect(@builtin(global_invocation_id)id:vec3u){
 let tree=forestClusterTree(id.x);if(tree==0xffffffffu){return;}
 let r=roots[tree];let scale=r.rootScale.w;let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let origin=r.rootScale.xyz-F.camPos.xyz;
 let focal=F.screen.y/max(2.0*length(F.camUp.xyz),.0001);
 let limitLeaf=parameters.z*FOREST_CLUSTER_LEAF_LIMIT;let limitWood=parameters.z*FOREST_CLUSTER_WOOD_LIMIT;let limit=min(limitLeaf,limitWood);
 let b=bucket.centre.xyz*scale;
 let centre=origin+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z);
 let nearest=max(length(centre)-bucket.centre.w*scale,.25);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 let rowX=vec3f(F.viewProj[0].x,F.viewProj[1].x,F.viewProj[2].x);
 let rowY=vec3f(F.viewProj[0].y,F.viewProj[1].y,F.viewProj[2].y);
 let planeL=rowW+rowX;let planeR=rowW-rowX;let planeB=rowW+rowY;let planeT=rowW-rowY;
 let lengthL=length(planeL);let lengthR=length(planeR);let lengthB=length(planeB);let lengthT=length(planeT);
 // The share of each pixel's samples the tree's crown takes, of 255. At 255 the progressive crown and its
 // trunk are the whole tree: no cluster is listed.
 var crownShare=0u;
 if(bucket.crown.z>0u){
  let stepCount=bucket.crown.z-1u;
  let away=length(origin);let pixels=parameters.z*FOREST_CROWN_LIMIT;
  let start=max(max(FOREST_CROWN_NEAREST,bucket.crownSize.z*focal/limitLeaf),bucket.crownSize.x*scale*focal/limitLeaf);
  let share=clamp((away-start)/(start*FOREST_CROWN_BAND),0.,1.);
  if(share>0.){
   crownShare=max(u32(share*255.),1u);
   if(crownShare<255u){
    let slot=atomicAdd(&draws[(bucket.crown.y+${CROWN_FADE_REGION}u)*5u+1u],1u);
    if(slot<bucket.crownLists.z){list[bucket.crownLists.y+slot]=vec2u(tree,crownShare<<24u);}
   }else{
    let crownReach=bucket.centre.w*scale+.35+F.windP[0].z*.08;
    if(r.identity.w>=0.&&(dot(planeL,centre)<-crownReach*lengthL||dot(planeR,centre)<-crownReach*lengthR||dot(planeB,centre)<-crownReach*lengthB||dot(planeT,centre)<-crownReach*lengthT||dot(rowW,centre)<-crownReach*length(rowW))){return;}
    let crownPixels=bucket.crownSize.y*scale*focal/max(away,.25);
    var inflateQ=4096u;
    if(crownPixels<FOREST_CROWN_MIN_PIXELS){
     let h=forestClusterHash(tree^0x9e3779b9u);
     if(crownPixels<.16||f32(h&65535u)/65535.>crownPixels*crownPixels){return;}
     inflateQ=u32(clamp(FOREST_CROWN_MIN_PIXELS/max(crownPixels,.16)*4096.,4096.,65535.));
    }
    if(crownPixels<=FOREST_CROWN_SPLAT_PIXELS){
     let slot=atomicAdd(&draws[(bucket.crown.y+${CROWN_SPLAT_REGION}u)*5u+1u],1u);
     if(slot<bucket.crownLists.z){list[bucket.crownLists.x+slot]=vec2u(tree,(255u<<24u)|(inflateQ<<8u));}
     return;
    }
    let allowedErr=pixels*away/max(scale*focal,1e-4);
    let mBase=bucket.crownLists.w;
    var sLo=0u;var sHi=stepCount;
    while(sLo<sHi){
     let sMid=(sLo+sHi+1u)/2u;
     if(bitcast<f32>(crownMorph[mBase+sMid*4u+1u])<=allowedErr){sLo=sMid;}else{sHi=sMid-1u;}
    }
    var stepIdx=sLo;
    if(crownPixels<5.2){stepIdx=stepCount;}
    let hdr=mBase+stepIdx*4u;
    let aliveTris=crownMorph[hdr]&65535u;
    var morphT=0.;
    if(stepIdx<stepCount){
     let e0=bitcast<f32>(crownMorph[hdr+1u]);let e1=bitcast<f32>(crownMorph[hdr+5u]);
     morphT=clamp((allowedErr-e0)/max(e1-e0,1e-5),0.,1.);
    }else{
     morphT=1.-smoothstep(FOREST_CROWN_SPLAT_PIXELS,5.2,crownPixels);
    }
    let morphByte=u32(clamp(morphT,0.,1.)*255.);
    let baseSlot=atomicAdd(&draws[(bucket.crown.y+${CROWN_CONT_REGION}u)*5u+1u],aliveTris);
    if(baseSlot+aliveTris<=bucket.crown.w){
     let packedHi=(morphByte<<24u)|((stepIdx&4095u)<<12u);
     for(var t=0u;t<aliveTris;t++){list[bucket.crown.x+baseSlot+t]=vec2u(tree,packedHi|t);}
    }
    return;
   }
  }
 }
 // Clusters run from coarsest parent to finest, so only a prefix can be drawn at this distance.
 let finest=limit*nearest/(scale*focal);
 var low=0u;var high=bucket.clusterCount;
 while(low<high){let middle=(low+high)/2u;if(clusters[bucket.firstCluster+middle].parentErr>finest){low=middle+1u;}else{high=middle;}}
 for(var i=0u;i<low;i++){
  let index=bucket.firstCluster+i;let k=clusters[index];
  let isLeaf=(k.shape&1u)==1u;let allowed=select(limitWood,limitLeaf,isLeaf);
  let parentAt=origin+vec3f(c*k.parentLod.x-s*k.parentLod.z,k.parentLod.y,s*k.parentLod.x+c*k.parentLod.z)*scale;
  if(k.parentErr*scale*focal/max(length(parentAt)-k.parentLod.w*scale,.001)<=allowed){continue;}
  let ownAt=origin+vec3f(c*k.lod.x-s*k.lod.z,k.lod.y,s*k.lod.x+c*k.lod.z)*scale;
  if(k.err*scale*focal/max(length(ownAt)-k.lod.w*scale,.001)>allowed){continue;}
  let at=origin+vec3f(c*k.cull.x-s*k.cull.z,k.cull.y,s*k.cull.x+c*k.cull.z)*scale;
  // Wind carries leaves past the shapes they were baked from.
  let reach=k.cull.w*scale+.2+F.windP[0].z*.07;
  // A felled tree no longer stands where its clusters were baked.
  if(r.identity.w>=0.&&(dot(planeL,at)<-reach*lengthL||dot(planeR,at)<-reach*lengthR||dot(planeB,at)<-reach*lengthB||dot(planeT,at)<-reach*lengthT||dot(rowW,at)<-reach*length(rowW))){continue;}
  let draw=select(bucket.drawWood,bucket.drawLeaf,isLeaf);
  let slot=atomicAdd(&draws[draw*5u+1u],1u);
  // A leaf cluster carries its tree's crown share above its own number, and close cross-shoots pack layer bits into upper item.x.
  if(slot<bucket.capacity.x){list[select(bucket.listWood,bucket.listLeaf,isLeaf)+slot]=vec2u(tree,index|select(0u,crownShare<<24u,isLeaf));}
  if(isLeaf&&crownShare==0u&&nearest<32.0){
   let slotCrossA=atomicAdd(&draws[draw*5u+1u],1u);
   if(slotCrossA<bucket.capacity.x){list[bucket.listLeaf+slotCrossA]=vec2u(tree|(1u<<28u),index);}
   if(nearest<20.0){
    let slotCrossB=atomicAdd(&draws[draw*5u+1u],1u);
    if(slotCrossB<bucket.capacity.x){list[bucket.listLeaf+slotCrossB]=vec2u(tree|(2u<<28u),index);}
   }
  }
 }
}
// What casts into the land shadow map is chosen here, from every tree of the species and against the
// light's box. The camera's own lists hold only what it can see, and a tree behind it or beside the
// view still shades the ground in front. A shadow cannot show detail finer than a few of the map's
// texels, nor finer than a few pixels where the camera sees it fall, so the cut is that coarse.
const FOREST_CLUSTER_SHADOW_TEXELS=vec2f(1.5,2.5);
const FOREST_CLUSTER_SHADOW_PIXELS=1.5;
@compute @workgroup_size(64)fn forestClusterShadowSelect(@builtin(global_invocation_id)id:vec3u){
 if(shadowBox.origin.w<.5||id.x>=bucket.capacity.z){return;}
 let tree=bucket.capacity.y+id.x;
 let r=roots[tree];let scale=r.rootScale.w;if(scale<=0.){return;}
 let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let rowX=vec3f(shadowBox.lightView[0].x,shadowBox.lightView[1].x,shadowBox.lightView[2].x);
 let rowY=vec3f(shadowBox.lightView[0].y,shadowBox.lightView[1].y,shadowBox.lightView[2].y);
 let rowZ=vec3f(shadowBox.lightView[0].z,shadowBox.lightView[1].z,shadowBox.lightView[2].z);
 let scales=vec3f(length(rowX),length(rowY),length(rowZ));
 let b=bucket.centre.xyz*scale;
 let fromBox=r.rootScale.xyz-shadowBox.origin.xyz;
 let lit=(shadowBox.lightView*vec4f(fromBox+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z),1.)).xyz;
 // A felled tree lies as far as its own height from where it stood.
 let whole=bucket.centre.w*scale*select(1.,2.,r.identity.w<0.)*scales;
 if(abs(lit.x)>1.+whole.x||abs(lit.y)>1.+whole.y||lit.z<-whole.z||lit.z>1.+whole.z){return;}
 let origin=r.rootScale.xyz-F.camPos.xyz;
 let focal=F.screen.y/max(2.0*length(F.camUp.xyz),.0001);
 let texel=max(shadowBox.texel.x,shadowBox.texel.y);
 let floorWood=texel*FOREST_CLUSTER_SHADOW_TEXELS.x;let floorLeaf=texel*FOREST_CLUSTER_SHADOW_TEXELS.y;
 let perMetre=parameters.z*FOREST_CLUSTER_SHADOW_PIXELS/focal;
 let centre=origin+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z);
 let nearest=max(length(centre)-bucket.centre.w*scale,.25);
 let finest=max(floorWood,perMetre*nearest)/scale;
 var low=0u;var high=bucket.clusterCount;
 while(low<high){let middle=(low+high)/2u;if(clusters[bucket.firstCluster+middle].parentErr>finest){low=middle+1u;}else{high=middle;}}
 let drawBase=u32(parameters.y)*2u;
 for(var i=0u;i<low;i++){
  let index=bucket.firstCluster+i;let k=clusters[index];
  let isLeaf=(k.shape&1u)==1u;let least=select(floorWood,floorLeaf,isLeaf);
  let parentAt=origin+vec3f(c*k.parentLod.x-s*k.parentLod.z,k.parentLod.y,s*k.parentLod.x+c*k.parentLod.z)*scale;
  if(k.parentErr*scale<=max(least,perMetre*max(length(parentAt)-k.parentLod.w*scale,.001))){continue;}
  let ownAt=origin+vec3f(c*k.lod.x-s*k.lod.z,k.lod.y,s*k.lod.x+c*k.lod.z)*scale;
  if(k.err*scale>max(least,perMetre*max(length(ownAt)-k.lod.w*scale,.001))){continue;}
  let at=(shadowBox.lightView*vec4f(fromBox+vec3f(c*k.cull.x-s*k.cull.z,k.cull.y,s*k.cull.x+c*k.cull.z)*scale,1.)).xyz;
  let reach=(k.cull.w*scale+.2+F.windP[0].z*.07)*scales;
  if(r.identity.w>=0.&&(abs(at.x)>1.+reach.x||abs(at.y)>1.+reach.y||at.z<-reach.z||at.z>1.+reach.z)){continue;}
  let draw=drawBase+select(bucket.drawWood,bucket.drawLeaf,isLeaf);
  let slot=atomicAdd(&draws[draw*5u+1u],1u);
  if(slot<bucket.capacity.w){list[select(bucket.drawWood,bucket.drawLeaf,isLeaf)*bucket.capacity.w+slot]=vec2u(tree,index);}
 }
}
@compute @workgroup_size(64)fn forestClusterReset(@builtin(global_invocation_id)id:vec3u){
 if(id.x<u32(parameters.y)*${4 + CROWN_LISTS}u){atomicStore(&draws[id.x*5u+1u],0u);}
}
`;

// Shares forestPlace with the ordinary tree shader, so clusters light and sway exactly alike.
export const FOREST_CLUSTER_VERTEX_WGSL = /* wgsl */`
struct ForestCluster {lod:vec4f,parentLod:vec4f,cull:vec4f,err:f32,parentErr:f32,first:u32,shape:u32};
@group(3)@binding(0)var<storage,read>forestClusterList:array<vec2u>;
@group(3)@binding(1)var<storage,read>forestClusters:array<ForestCluster>;
@group(3)@binding(2)var<storage,read>forestClusterVertices:array<u32>;
@group(3)@binding(3)var<storage,read>forestClusterIndices:array<u32>;
@group(3)@binding(4)var<uniform>forestClusterBounds:array<vec4f,2>;
fn forestClusterOctahedral(e:vec2f)->vec3f{
 var n=vec3f(e,1.-abs(e.x)-abs(e.y));
 if(n.z<0.){let x=n.x;n.x=(1.-abs(n.y))*select(-1.,1.,x>=0.);n.y=(1.-abs(x))*select(-1.,1.,n.y>=0.);}
 return normalize(n);
}
fn forestClusterVertexCross(tree:u32,vertex:u32,kindValue:f32,crossLayer:u32)->ForestVertex{
 let at=vertex*${FOREST_CLUSTER_VERTEX_WORDS}u;
 let w0=forestClusterVertices[at];let w1=forestClusterVertices[at+1u];let w2=forestClusterVertices[at+2u];let w3=forestClusterVertices[at+3u];let w4=forestClusterVertices[at+4u];
 let unit=vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))/65535.;
 var position=forestClusterBounds[0].xyz+unit*forestClusterBounds[0].w;
 let r=forestRoots[tree];
 var normal=forestClusterOctahedral(vec2f(f32(w2&65535u),f32(w2>>16u))/65535.*2.-1.);
 let uv=forestClusterBounds[1].xy+vec2f(f32(w3&65535u),f32(w3>>16u))/65535.*forestClusterBounds[1].zw;
 if(kindValue>=3.5){
  let dist=length(r.rootScale.xyz-F.camPos.xyz);
  let invScale=1./max(r.rootScale.w,.85);
  let upRef=select(vec3f(0.,1.,0.),vec3f(1.,0.,0.),abs(normal.y)>.9);
  let t1=normalize(cross(normal,upRef));let t2=cross(normal,t1);
  let uvOff=clamp(uv-vec2f(.5,.5),vec2f(-.65),vec2f(.65));
  // Close-range 3D bough relief: cup base cards out of the plane and angle cross-shoots in 3D space so edge-on trees show real twig-and-leaf depth instead of flat billboards.
  let nearRelief=1.-smoothstep(14.,52.,dist);
  if(nearRelief>0.&&crossLayer==0u){
   let cup=(dot(uvOff,uvOff)*2.2-0.28)*0.22*nearRelief*invScale;
   position+=normal*cup;
   normal=normalize(normal+(t1*uvOff.x+t2*uvOff.y)*(.36*nearRelief));
  }else if(crossLayer>0u){
   let layerFade=select(1.-smoothstep(13.,20.,dist),1.-smoothstep(22.,32.,dist),crossLayer==1u);
   let tiltSpan=0.46*layerFade*invScale;
   let sSign=select(-1.,1.,crossLayer==1u);
   let tiltOut=normal*((uvOff.x*0.72*sSign+uvOff.y*0.44+0.05*sSign)*tiltSpan);
   let tiltIn=-t1*(uvOff.x*0.20*tiltSpan)+t2*(uvOff.y*0.14*sSign*tiltSpan);
   position+=tiltOut+tiltIn;
   normal=normalize(normal+t1*(0.65*sSign*layerFade)+t2*(0.38*layerFade));
  }
  let midBlend=smoothstep(55.,320.,dist);
  if(midBlend>0.){
   let isSubBroadleaf=(forestBin.z&768u)!=0u;
   let baseInflate=select(.18,.48,isSubBroadleaf)*midBlend*invScale;
   position+=t1*(uvOff.x*baseInflate)+t2*(uvOff.y*baseInflate);
   normal=normalize(normal+(t1*uvOff.x+t2*uvOff.y)*(.10*midBlend));
  }
 }
 let root=vec3f(f32(w4&255u),f32((w4>>8u)&255u),f32((w4>>16u)&255u))/255.;
 return forestPlace(r,tree,position,normal,vec2f(kindValue,f32(w1>>24u)/255.),uv,root*root,f32((w1>>16u)&255u),vertex,f32(w4>>24u)/255.);
}
fn forestClusterVertex(tree:u32,vertex:u32,kindValue:f32)->ForestVertex{
 return forestClusterVertexCross(tree,vertex,kindValue,0u);
}
// A cluster with fewer triangles than the draw's fixed count collapses the rest to a point.
@vertex fn forestClusterWoodVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->ForestVertex{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(index>=(cluster.shape>>1u)*3u){var o:ForestVertex;return o;}
 return forestClusterVertex(item.x,forestClusterIndices[cluster.first+index],3.);
}
@vertex fn forestClusterLeafVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->ForestVertex{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y&0xffffffu];
 if(index>=(cluster.shape>>1u)/4u*${FOREST_LEAF_VERTICES}u){var o:ForestVertex;return o;}
 let treeId=item.x&0x0fffffffu;
 let crossLayer=(item.x>>28u)&3u;
 var o=forestClusterVertexCross(treeId,cluster.first+index,4.,crossLayer);
 // The share of each pixel this tree's far crown has taken from its leaves (forestClusterSelect).
 o.crownFade=f32(item.y>>24u)/255.;
 return o;
}
`;
// How many clusters one species and kind may cast into the land shadow map, which is cut far coarser
// than the camera's view: about 6 million triangles. A count past this draws nothing more.
const SHADOW_CLUSTERS_PER_DRAW = 48000;
// Casters arrive already chosen for the light's box by forestClusterShadowSelect. Leaves are tested
// against their own outlines, so a crown lets through the light its gaps let through.
export const FOREST_CLUSTER_SHADOW_WGSL = /* wgsl */ `
struct ForestClusterShadowVertex {@builtin(position)pos:vec4f,@location(0)leafUV:vec2f,@location(1)@interpolate(flat)nativeMaterial:i32};
@vertex fn forestClusterWoodShadowVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->@builtin(position)vec4f{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(instance>=${SHADOW_CLUSTERS_PER_DRAW}u||index>=(cluster.shape>>1u)*3u){return vec4f(2.,2.,0.,1.);}
 let v=forestClusterVertex(item.x,forestClusterIndices[cluster.first+index],3.);
 return landSH.lightView*vec4f(v.world-landSH.origin.xyz,1.);
}
@vertex fn forestClusterLeafShadowVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->ForestClusterShadowVertex{
 var o:ForestClusterShadowVertex;o.pos=vec4f(2.,2.,0.,1.);
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(instance>=${SHADOW_CLUSTERS_PER_DRAW}u||index>=(cluster.shape>>1u)/4u*${FOREST_LEAF_VERTICES}u){return o;}
 let v=forestClusterVertex(item.x,cluster.first+index,4.);
 o.pos=landSH.lightView*vec4f(v.world-landSH.origin.xyz,1.);o.leafUV=v.leafUV;o.nativeMaterial=v.nativeMaterial;
 return o;
}
// The threshold varies from texel to texel, so a card that is half leaf shades half of what it covers.
// The map's texels are fixed to the ground, so the pattern does not crawl as the camera moves.
@fragment fn forestClusterLeafShadowFS(in:ForestClusterShadowVertex){
 let alpha=forestNativeAlpha(forestNativeMaterials[u32(in.nativeMaterial)],in.leafUV,dpdx(in.leafUV),dpdy(in.leafUV));
 let threshold=fract(52.9829189*fract(dot(floor(in.pos.xy),vec2f(.06711056,.00583715))));
 if(alpha<=mix(.12,.88,threshold)){discard;}
}
`;

// ForestClusterBucket, as FOREST_CLUSTER_SELECT lays it out.
const BUCKET_BYTES = 144;
const CLUSTER_TRIANGLES = 128;
const CLUSTER_INDICES = CLUSTER_TRIANGLES * 3;
const CLUSTER_LEAVES = CLUSTER_TRIANGLES / 4;
// How many clusters one species and kind may draw: about 25 million triangles.
const CLUSTERS_PER_DRAW = 200000;
const LEAF_PATTERN = [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5];

// The far crowns' lists follow the clusters' in one buffer: one progressive continuum triangle list per species,
// one 1-triangle horizon splat list, and one crossfade list for trees still changing over.
const ROOT_BYTES = 48;

export async function createForestClusters({ device, shader, module, frame, source, crowns = null, crownChange = {}, prototypes, roots, visible, commands, parameters, format, samples, sceneEntries, cloudEntries, surfaceEntries, firstMaterials, bind, hasLandShadow = false, shadowUniform = null, shadowFormat = 'depth32float' }) {
  const B = GPUBufferUsage, owned = [], count = prototypes.length;
  // A leaf cluster's place in the list shares a word with its tree's crown share (forestClusterSelect).
  if (source.manifest.clusterCount >= 1 << 24) throw Error('Forest clusters outnumber the bits that name them');
  const crownInfo = crowns ? prototypes.map((p, id) => {
    const info = crowns.manifest.prototypes.find((q) => q.id === id && q.species === p.species && (q.cohort ?? null) === (p.cohort ?? null));
    if (!info) throw Error(`Forest crowns lack species ${p.species}`);
    return info;
  }) : null;
  const maxRoots = Math.floor(roots.size / ROOT_BYTES), crownListBase = count * 2 * CLUSTERS_PER_DRAW;
  const crownTotalSlots = crownInfo ? count * CROWN_CONT_TRIS_PER_SPECIES + 2 * maxRoots : 0;
  const make = (data, usage, label) => {
    const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | B.COPY_DST });
    owned.push(buffer);
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const vertices = make(source.vertices, B.STORAGE, 'forest cluster vertices'), indices = make(source.indices, B.STORAGE, 'forest cluster indices'), clusters = make(source.clusters, B.STORAGE, 'forest clusters');
  const list = device.createBuffer({ label: 'forest clusters to draw', size: (crownListBase + crownTotalSlots) * 8, usage: B.STORAGE });
  owned.push(list);
  // Each species has four draws: wood and leaves for the camera, then wood and leaves for the shadow map.
  // After every species' four come CROWN_LISTS draws: progressive continuum triangles, 1-triangle splat, and crossfade.
  const crownDraw = (id, region) => {
    if (!crownInfo) return [3, 0, 0, 0, 0];
    if (region === CROWN_CONT_REGION) return [3, 0, 0, 0, 0];
    if (region === CROWN_SPLAT_REGION) return [3, 0, crowns.manifest.splatFirstIndex ?? 0, 0, 0];
    return [crownInfo[id].baseIndexCount, 0, crownInfo[id].firstIndex, 0, 0];
  };
  const draws = make(new Uint32Array([
    ...Array.from({ length: count * 4 }, () => [CLUSTER_INDICES, 0, 0, 0, 0]).flat(),
    ...Array.from({ length: count * CROWN_LISTS }, (_, i) => crownDraw(Math.floor(i / CROWN_LISTS), i % CROWN_LISTS)).flat(),
  ]), B.STORAGE | B.INDIRECT, 'forest cluster indirect draws');
  const crownVertices = crownInfo ? make(crowns.vertices, B.STORAGE, 'forest crown vertices') : null;
  const crownIndices = crownInfo ? make(crowns.indices, B.INDEX | B.STORAGE, 'forest crown indices') : null;
  const crownMorph = make(crownInfo ? crowns.morph : new Uint32Array(4), B.STORAGE, 'forest crown morph');
  const shadowList = hasLandShadow ? device.createBuffer({ label: 'forest clusters casting shadows', size: count * 2 * SHADOW_CLUSTERS_PER_DRAW * 8, usage: B.STORAGE }) : null;
  if (shadowList) owned.push(shadowList);
  const leafIndices = make(Uint32Array.from({ length: CLUSTER_LEAVES * LEAF_PATTERN.length }, (_, i) => Math.floor(i / LEAF_PATTERN.length) * FOREST_LEAF_VERTICES + LEAF_PATTERN[i % LEAF_PATTERN.length]), B.INDEX, 'forest cluster leaf pattern');

  const compute = await shader(FOREST_CLUSTER_SELECT(frame, crownChange), 'forest cluster cut');
  // A crown is closed and drawn whole: no coverage to test, so the tiler can drop what other crowns hide.
  // The few trees changing over take part of each pixel's samples instead, and that costs them the saving.
  const renderCrown = (fragment) => device.createRenderPipelineAsync({
    label: `forest crowns ${fragment}`, layout: 'auto', vertex: { module, entryPoint: 'forestCrownVS' },
    fragment: { module, entryPoint: fragment, targets: [{ format }] }, primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples, alphaToCoverageEnabled: false },
  });
  const render = (entryPoint, fragment, target, depthStencil) => device.createRenderPipelineAsync({
    label: `forest clusters ${fragment}`, layout: 'auto', vertex: { module, entryPoint },
    fragment: { module, entryPoint: fragment, targets: [target] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', ...depthStencil }, multisample: { count: samples, alphaToCoverageEnabled: false },
  });
  // A constant bias is counted in steps of the depth format, and a float's are too fine to matter. The slope
  // bias and the receiver's own offset along its normal keep a crown from shading itself.
  const renderShadow = (entryPoint, fragment) => device.createRenderPipelineAsync({
    label: `forest clusters ${entryPoint}`, layout: 'auto', vertex: { module, entryPoint },
    ...(fragment ? { fragment: { module, entryPoint: fragment, targets: [] } } : {}),
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBiasSlopeScale: 1.5 },
  });
  const lay = { depthWriteEnabled: true, depthCompare: 'greater' };
  const [select, reset, woodPipeline, leafDepthPipeline, leafPipeline, woodShadowPipeline, leafShadowPipeline, shadowSelect, crownPipeline, crownFadePipeline] = await Promise.all([
    device.createComputePipelineAsync({ label: 'forest cluster cut', layout: 'auto', compute: { module: compute, entryPoint: 'forestClusterSelect' } }),
    device.createComputePipelineAsync({ label: 'forest cluster reset', layout: 'auto', compute: { module: compute, entryPoint: 'forestClusterReset' } }),
    render('forestClusterWoodVS', 'forestNativeOpaqueFS', { format }, lay),
    render('forestClusterLeafVS', 'forestNativeLeafDepthFS', { format, writeMask: 0 }, lay),
    render('forestClusterLeafVS', 'forestNativeLeafFS', { format }, { depthWriteEnabled: false, depthCompare: 'equal' }),
    hasLandShadow ? renderShadow('forestClusterWoodShadowVS') : null,
    hasLandShadow ? renderShadow('forestClusterLeafShadowVS', 'forestClusterLeafShadowFS') : null,
    hasLandShadow ? device.createComputePipelineAsync({ label: 'forest cluster shadow cut', layout: 'auto', compute: { module: compute, entryPoint: 'forestClusterShadowSelect' } }) : null,
    crownInfo ? renderCrown('forestCrownFS') : null,
    crownInfo ? renderCrown('forestCrownFadeFS') : null,
  ]);
  const resetGroup = device.createBindGroup({ layout: reset.getBindGroupLayout(0), entries: [{ binding: 6, resource: { buffer: draws } }, { binding: 7, resource: { buffer: parameters } }] });
  const groups = {
    wood: { zero: bind(woodPipeline), cloud: cloudEntries(woodPipeline) },
    leafDepth: { zero: bind(leafDepthPipeline, [0]) },
    leaf: { zero: bind(leafPipeline), cloud: cloudEntries(leafPipeline) },
    woodShadow: woodShadowPipeline ? { zero: bind(woodShadowPipeline, [0, 19]), empty1: device.createBindGroup({ layout: woodShadowPipeline.getBindGroupLayout(1), entries: [] }) } : null,
    leafShadow: leafShadowPipeline ? { zero: bind(leafShadowPipeline, [0, 19]), empty1: device.createBindGroup({ layout: leafShadowPipeline.getBindGroupLayout(1), entries: [] }) } : null,
    crown: crownPipeline ? { zero: bind(crownPipeline), cloud: cloudEntries(crownPipeline) } : null,
    crownFade: crownFadePipeline ? { zero: bind(crownFadePipeline), cloud: cloudEntries(crownFadePipeline) } : null,
  };
  const species = prototypes.map((p, id) => {
    const info = source.manifest.prototypes.find((q) => q.id === id);
    if (!info) throw Error(`Forest clusters lack species ${p.species}`);
    const words = new ArrayBuffer(BUCKET_BYTES), bucket = make(words, B.UNIFORM, 'forest cluster bucket');
    const boundsData = new Float32Array([...info.low, info.posScale, ...info.uvLow, ...info.uvScale]);
    const bounds = make(boundsData, B.UNIFORM, 'forest cluster bounds');
    const subRoot = (p.species === 'ceiba' || p.species === 'mangrove') ? 256 : 0, closedCrown = p.cohort ? 512 : 0;
    const uniform = (listBase, extraFlags = 0) => make(new Uint32Array([listBase, firstMaterials[id], extraFlags | closedCrown | subRoot | p.nativeMaterials.length, samples]), B.UNIFORM, 'forest cluster bin');
    const wood = uniform(id * 2 * CLUSTERS_PER_DRAW), leaf = uniform((id * 2 + 1) * CLUSTERS_PER_DRAW);
    const woodShadow = uniform(id * 2 * SHADOW_CLUSTERS_PER_DRAW), leafShadow = uniform((id * 2 + 1) * SHADOW_CLUSTERS_PER_DRAW);
    const clusterGroup = (pipeline, hasIndices, from = list) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(3),
      entries: [{ binding: 0, resource: { buffer: from } }, { binding: 1, resource: { buffer: clusters } }, { binding: 2, resource: { buffer: vertices } }, ...(hasIndices ? [{ binding: 3, resource: { buffer: indices } }] : []), { binding: 4, resource: { buffer: bounds } }],
    });
    const shadowSurface = (pipeline, offset) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(2),
      entries: [{ binding: 0, resource: { buffer: roots } }, { binding: 2, resource: { buffer: offset } }],
    });
    // Progressive continuum triangles, 1-triangle splat (bit 1024), and crossfade list (bit 2048).
    const crown = crownInfo ? (() => {
      const look = make(forestCrownLook(crownInfo[id]), B.UNIFORM, 'forest crown look');
      const splat = make(forestCrownSplatLook(crownInfo[id]), B.UNIFORM, 'forest crown splat');
      const bins = [uniform(0, 0), uniform(0, 1024), uniform(0, 2048)];
      const groups = (pipeline) => ({
        cluster: device.createBindGroup({ layout: pipeline.getBindGroupLayout(3), entries: [{ binding: 0, resource: { buffer: list } }, { binding: 2, resource: { buffer: crownVertices } }, { binding: 3, resource: { buffer: crownIndices } }, { binding: 5, resource: { buffer: look } }, { binding: 6, resource: { buffer: crownMorph } }, { binding: 7, resource: { buffer: splat } }] }),
        surface: bins.map((bin) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: [{ binding: 0, resource: { buffer: roots } }, { binding: 2, resource: { buffer: bin } }] })),
      });
      return { info: crownInfo[id], bins, solid: groups(crownPipeline), fade: groups(crownFadePipeline) };
    })() : null;
    return {
      info, bucket, crown, rootCount: p.rootCount,
      select: device.createBindGroup({ layout: select.getBindGroupLayout(0), entries: [frameEntry(0), ...[roots, visible, commands, clusters, list, draws, parameters, bucket].map((buffer, k) => ({ binding: k + 1, resource: { buffer } })), { binding: 10, resource: { buffer: crownMorph } }] }),
      wood: { surface: surfaceEntries(woodPipeline, p.id, wood, true), cluster: clusterGroup(woodPipeline, true) },
      leafDepth: { surface: surfaceEntries(leafDepthPipeline, p.id, leaf, false), cluster: clusterGroup(leafDepthPipeline, false) },
      leaf: { surface: surfaceEntries(leafPipeline, p.id, leaf, true), cluster: clusterGroup(leafPipeline, false) },
      shadowSelect: shadowSelect ? device.createBindGroup({ layout: shadowSelect.getBindGroupLayout(0), entries: [frameEntry(0), ...[[1, roots], [4, clusters], [5, shadowList], [6, draws], [7, parameters], [8, bucket], [9, shadowUniform]].map(([binding, buffer]) => ({ binding, resource: { buffer } }))] }) : null,
      woodShadow: woodShadowPipeline ? { surface: shadowSurface(woodShadowPipeline, woodShadow), cluster: clusterGroup(woodShadowPipeline, true, shadowList) } : null,
      leafShadow: leafShadowPipeline ? { surface: surfaceEntries(leafShadowPipeline, p.id, leafShadow, false), cluster: clusterGroup(leafShadowPipeline, false, shadowList) } : null,
    };
  });
  function frameEntry(binding) { return { binding, resource: { buffer: bind.frameUBO } }; }
  function placeTrees() {
    const crownSplatBase = crownListBase + count * CROWN_CONT_TRIS_PER_SPECIES;
    const crownFadeBase = crownSplatBase + maxRoots;
    prototypes.forEach((p, id) => {
      const s = species[id], slots = count * 4 + id * 4;
      s.rootCount = p.rootCount;
      const data = new ArrayBuffer(BUCKET_BYTES), u = new Uint32Array(data), f = new Float32Array(data);
      u.set([s.info.firstCluster, s.info.clusterCount, id * 2 * CLUSTERS_PER_DRAW, (id * 2 + 1) * CLUSTERS_PER_DRAW,
        p.firstRoot * 4, id * 4, p.firstRoot * 4 + p.rootCount * 2, slots, p.firstRoot * 4 + p.rootCount * 3, slots + 2, id * 2, id * 2 + 1]);
      f.set([...p.centre, p.radius], 12);
      u.set([CLUSTERS_PER_DRAW, p.firstRoot, p.rootCount, SHADOW_CLUSTERS_PER_DRAW], 16);
      // Each species keeps its own progressive continuum triangle slice plus root-indexed splat and fade stretches.
      if (s.crown) {
        const contBase = crownListBase + id * CROWN_CONT_TRIS_PER_SPECIES;
        const splatBase = crownSplatBase + p.firstRoot;
        const fadeBase = crownFadeBase + p.firstRoot;
        u.set([contBase, count * 4 + id * CROWN_LISTS, s.crown.info.stepCount + 1, CROWN_CONT_TRIS_PER_SPECIES], 20);
        u.set([splatBase, fadeBase, p.rootCount, s.crown.info.morphOffset], 24);
        const widest = crownChange.widest ?? crowns.manifest.widestLeafErrors ?? 0;
        f.set([widest > 0 ? s.crown.info.breadthMetres / widest : 0, s.crown.info.breadthMetres, s.crown.info.leafErrorMetres, 0], 28);
        u.set([p.firstRoot * 4 + p.rootCount, id * 4 + 2, 1, 0], 32);
        device.queue.writeBuffer(s.crown.bins[CROWN_CONT_REGION], 0, new Uint32Array([contBase]));
        device.queue.writeBuffer(s.crown.bins[CROWN_SPLAT_REGION], 0, new Uint32Array([splatBase]));
        device.queue.writeBuffer(s.crown.bins[CROWN_FADE_REGION], 0, new Uint32Array([fadeBase]));
      }
      device.queue.writeBuffer(s.bucket, 0, data);
    });
  }
  placeTrees();
  const drawWith = (pass, pipeline, group, cloud, part, leafDraw, firstDraw = 0) => {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (cloud) pass.setBindGroup(1, cloud);
    if (leafDraw) pass.setIndexBuffer(leafIndices, 'uint32');
    species.forEach((s, id) => {
      pass.setBindGroup(2, s[part].surface);
      pass.setBindGroup(3, s[part].cluster);
      if (leafDraw) pass.drawIndexedIndirect(draws, (firstDraw + id * 2 + 1) * 20);
      else pass.drawIndirect(draws, (firstDraw + id * 2) * 20);
    });
  };
  const drawCrowns = (pass, pipeline, group, part, regions) => {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group.zero);
    pass.setBindGroup(1, group.cloud);
    pass.setIndexBuffer(crownIndices, 'uint32');
    species.forEach((s, id) => {
      pass.setBindGroup(3, s.crown[part].cluster);
      for (const region of regions) {
        pass.setBindGroup(2, s.crown[part].surface[region]);
        const offset = (count * 4 + id * CROWN_LISTS + region) * 20;
        if (region === CROWN_CONT_REGION) pass.drawIndirect(draws, offset);
        else pass.drawIndexedIndirect(draws, offset);
      }
    });
  };
  const crownSolidRegions = [CROWN_CONT_REGION, CROWN_SPLAT_REGION];
  return {
    placeTrees,
    crowns: Boolean(crownInfo),
    encode(pass) {
      pass.setPipeline(reset);
      pass.setBindGroup(0, resetGroup);
      pass.dispatchWorkgroups(Math.ceil(count * (4 + CROWN_LISTS) / 64));
      pass.setPipeline(select);
      species.forEach((s) => {
        if (!s.rootCount) return;
        pass.setBindGroup(0, s.select);
        pass.dispatchWorkgroups(Math.ceil(s.rootCount / 64));
      });
      if (!shadowSelect) return;
      pass.setPipeline(shadowSelect);
      species.forEach((s) => {
        if (!s.rootCount) return;
        pass.setBindGroup(0, s.shadowSelect);
        pass.dispatchWorkgroups(Math.ceil(s.rootCount / 64));
      });
    },
    drawOpaque(pass) {
      drawWith(pass, woodPipeline, groups.wood.zero, groups.wood.cloud, 'wood', false);
      if (!crownInfo) return;
      drawCrowns(pass, crownPipeline, groups.crown, 'solid', crownSolidRegions);
      drawCrowns(pass, crownFadePipeline, groups.crownFade, 'fade', [CROWN_FADE_REGION]);
    },
    drawLeafDepth(pass) { drawWith(pass, leafDepthPipeline, groups.leafDepth.zero, null, 'leafDepth', true); },
    drawLeaves(pass) { drawWith(pass, leafPipeline, groups.leaf.zero, groups.leaf.cloud, 'leaf', true); },
    drawShadow(pass) {
      if (woodShadowPipeline && groups.woodShadow) {
        drawWith(pass, woodShadowPipeline, groups.woodShadow.zero, groups.woodShadow.empty1, 'woodShadow', false, count * 2);
      }
      if (leafShadowPipeline && groups.leafShadow) {
        drawWith(pass, leafShadowPipeline, groups.leafShadow.zero, groups.leafShadow.empty1, 'leafShadow', true, count * 2);
      }
    },
    destroy() { for (const buffer of owned) buffer.destroy(); },
  };
}
