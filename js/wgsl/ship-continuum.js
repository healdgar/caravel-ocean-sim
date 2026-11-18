// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ship continuum's GPU side (js/ship-continuum.js, js/ship-continuum-draw.js). The cut and its handoffs are the
// shared core's (js/continuum-core.js); this supplies only how a ship's data is read and placed.
//
// One compute workgroup a ship decides how that ship is drawn this frame: clusters of its whole assembly cut by
// projected error, its far body at one step of its collapse, its splat, or two of them sharing each pixel's samples
// across a band. Each list entry is one instance of a fixed-size draw: a cluster or 128 far-body triangles (384
// vertices, the unused ones degenerate), or a splat (3). A damaged ship draws its clusters only, at the finest cut its
// error bound allows, into a list of its own, so the draw can read the shard flight its fracture pass has posed.
import { FRAME_WGSL } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import { SHIP_CONTINUUM_CLUSTER_WORDS, SHIP_CONTINUUM_FAR_VERTEX_WORDS, SHIP_CONTINUUM_STEP_WORDS, SHIP_CONTINUUM_NEVER, SHIP_CONTINUUM_MAX_DEPTH } from '../ship-continuum.js';

// Ships a frame can hold that are damaged at once, each with its own list (and its fracture's posed vertices).
export const SHIP_CONTINUUM_DAMAGED_SLOTS = 16;
// The lists a ship can be entered in, each with its own indirect draw: clusters, the far body, the splat, the far body
// at the shadow map's step (shadows and the underwater capture), and each damaged ship's clusters.
export const SHIP_CONTINUUM_LISTS = Object.freeze(['clusters', 'far', 'splat', 'shadow', ...Array.from({ length: SHIP_CONTINUUM_DAMAGED_SLOTS }, (_, i) => `damaged${i}`)]);
// The far bodies at the shadow map's step (shadows, and ships seen from under the water), and the first damaged list.
export const SHIP_CONTINUUM_SHADOW_LIST = 3;
export const SHIP_CONTINUUM_DAMAGED_LIST = 4;
// Vertices per list instance.
export const SHIP_CONTINUUM_INSTANCE_VERTICES = Object.freeze(SHIP_CONTINUUM_LISTS.map((name) => (name === 'splat' ? 3 : 384)));
export const SHIP_CONTINUUM_DRAW_BYTES = 16;
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
export const SHIP_CONTINUUM_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// A ship's orders, the integer its instance record carries in anim.z (exact in f32): bit 0 cuts it finer (aimed at,
// flooding or damaged); bits 1 to 5 its damaged slot plus one (0 when whole); bits 8 to 22 who it is, for the hash
// that thins it and splits its samples, so no ship flickers as others come and go.
export const SHIP_CONTINUUM_ORDER_IMPORTANT = 1;
export const SHIP_CONTINUUM_DAMAGED_SHIFT = 1;
export const SHIP_CONTINUUM_IDENTITY_SHIFT = 8;
export function shipContinuumOrders({ important = false, damagedSlot = -1, identity = 0 } = {}) {
  return (important ? SHIP_CONTINUUM_ORDER_IMPORTANT : 0) + ((damagedSlot + 1) & 31) * 2 + (identity & 32767) * 256;
}
// Who is cut finer: their pixel error is this share of the scene's.
export const SHIP_CONTINUUM_IMPORTANT = 0.5;
// How many shadow-map texels a shadow's far body may be in error.
export const SHIP_CONTINUUM_SHADOW_TEXELS = 1.5;
// A ship's instance record, 12 floats: (x, y, z, yaw), (pitch, roll, scale, body), (phase, motion, orders, furl).
export const SHIP_CONTINUUM_INSTANCE_FLOATS = 12;
// The bodies a family loads, one uniform record each (js/ship-continuum-draw.js writes them).
export const SHIP_CONTINUUM_BODY_LIMIT = 8;
export const SHIP_CONTINUUM_BODY_BYTES = 112;
export const SHIP_CONTINUUM_CUT_BYTES = 32 + SHIP_CONTINUUM_LISTS.length * 16;

export const SHIP_CONTINUUM_STRUCTS = /* wgsl */`
struct ShipContinuumBody {
  clusters:vec4u,  // first word of its clusters in the shape buffer, cluster count, first index word in the mesh buffer, first vertex
  chain:vec4u,     // first word of its far body in the shape buffer, then (from there) its records, its triangles, its steps
  far:vec4f,       // the far body's base error (m), step count, splat ry (m), splat rx side on (m)
  splat:vec4f,     // splat centre (m, the ship's frame), splat rx end on (m)
  bound:vec4f,     // centre (m) and radius (m) of every pose
  colour:vec4f,    // splat colour, the far body's triangles
  scale:vec4f,     // design units to metres, vertices
};
struct ShipContinuumCut {
  counts:vec4u,    // ships, samples a pixel, 1 when shadows are drawn, unused
  view:vec4f,      // the scene's pixel error, the shadow map's texel (m), unused, unused
  lists:array<vec4u,${SHIP_CONTINUUM_LISTS.length}>,  // first entry, capacity
};
struct ShipContinuumInstance { posYaw:vec4f, attitude:vec4f, anim:vec4f };
const SHIP_CONTINUUM_NEVER:u32=${SHIP_CONTINUUM_NEVER}u;
`;

// What every pass reads of a body: its far body's points, their collapses and its steps.
export const SHIP_CONTINUUM_DECODE = /* wgsl */`
struct ShipContinuumPoint { position:vec3f, normal:vec3f, colour:vec3f, kind:u32, source:u32 };
fn shipContinuumOctahedral(e:vec2f)->vec3f {
  let f=e*2.0-1.0;
  var n=vec3f(f.x,f.y,1.0-abs(f.x)-abs(f.y));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
fn shipContinuumFarPoint(chain:u32,v:u32)->ShipContinuumPoint {
  let at=chain+v*${SHIP_CONTINUUM_FAR_VERTEX_WORDS}u;
  var p:ShipContinuumPoint;
  p.position=vec3f(bitcast<f32>(shipShape[at]),bitcast<f32>(shipShape[at+1u]),bitcast<f32>(shipShape[at+2u]));
  p.normal=shipContinuumOctahedral(unpack2x16unorm(shipShape[at+3u]));
  let c=unpack4x8unorm(shipShape[at+4u]);
  p.colour=c.xyz*c.xyz;p.kind=shipShape[at+4u]>>24u;p.source=shipShape[at+5u];
  return p;
}
fn shipContinuumStepWord(body:ShipContinuumBody,step:u32,word:u32)->u32 { return shipShape[body.chain.x+body.chain.w+step*${SHIP_CONTINUUM_STEP_WORDS}u+word]; }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn shipContinuumAncestor(body:ShipContinuumBody,vertex:u32,step:u32)->u32 {
  var v=vertex;
  for(var hop=0u;hop<${SHIP_CONTINUUM_MAX_DEPTH}u;hop++){
    let record=shipShape[body.chain.x+body.chain.y+v];
    let at=record&65535u;
    if(at==SHIP_CONTINUUM_NEVER||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
// The ship's state, two entries ahead of the lists: x = seed | handoff share << 8 | splat share << 16,
// y = step | shadow step << 16; then morph (f32 bits) and splat scale (f32 bits).
fn shipContinuumState(ship:u32)->vec4u { let a=shipList[ship*2u];let b=shipList[ship*2u+1u];return vec4u(a.x,a.y,b.x,b.y); }
// What a draw tells its fragments: which draw it is and the ship's seed (x), and the shares (y).
fn shipContinuumCoverage(kind:u32,state:u32)->vec2u { return vec2u(kind|((state&255u)<<8u),(state>>8u)&65535u); }
// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far body the handoff's
// share and the clusters the rest; of the far body's, the splat its own share and the far body the rest. Every
// sample is drawn by exactly one of the three. coverage.x names the draw in its low byte (1 clusters, 2 far body,
// 3 splat) and holds the ship's seed above it; coverage.y holds handoff | splat << 8.
fn shipContinuumMask(coverage:vec2u,pixel:vec2f,samples:u32)->u32 {
  let n=clamp(samples,1u,8u);
  let all=(1u<<n)-1u;
  let seed=(coverage.x>>8u)*0x9e3779b9u+1u;
  let handoff=continuumSamples(f32(coverage.y&255u)/255.0,pixel,n,seed);
  let splat=handoff&continuumSamples(f32((coverage.y>>8u)&255u)/255.0,pixel,n,seed+7u);
  let kind=coverage.x&255u;
  if(kind==1u){return all&~handoff;}
  if(kind==2u){return handoff&~splat;}
  return splat;
}
`;

// The data bindings of the render passes. A family's render source takes these at its own group.
export function shipContinuumDataWGSL(group) {
  return SHIP_CONTINUUM_STRUCTS + /* wgsl */`
@group(${group}) @binding(0) var<storage,read> shipShape:array<u32>;
@group(${group}) @binding(1) var<storage,read> shipMesh:array<u32>;
@group(${group}) @binding(2) var<storage,read> shipVertices:array<f32>;
@group(${group}) @binding(3) var<storage,read> shipInstances:array<ShipContinuumInstance>;
@group(${group}) @binding(4) var<storage,read> shipList:array<vec2u>;
@group(${group}) @binding(5) var<uniform> shipBodies:array<ShipContinuumBody,${SHIP_CONTINUUM_BODY_LIMIT}>;
@group(${group}) @binding(6) var<uniform> shipCut:ShipContinuumCut;
// Every pass binds the same group. A vertex stage names each binding once here, on a path never taken, so the
// layout each pipeline derives holds all of them.
fn shipContinuumBindings()->f32 {
  if(shipCut.counts.w!=0xffffffffu){return 0.0;}
  return f32(shipShape[0]+shipMesh[0]+shipList[0].x)+shipVertices[0]+shipInstances[0].anim.x+shipBodies[0].far.x;
}
// A list's entries reach the vertex stage as an instance attribute, read from the list buffer at the list's start:
// (ship, cluster) or (ship, piece of the far body).
struct ShipContinuumEntry { @location(0) entry:vec2u };
// One vertex of a ship's own assembly: (position, material), (normal, u), v in .x of the third.
struct ShipContinuumSource { position:vec3f, normal:vec3f, material:f32, uv:vec2f };
fn shipContinuumSourceVertex(body:ShipContinuumBody,v:u32)->ShipContinuumSource {
  let o=(body.clusters.w+v)*9u;
  var s:ShipContinuumSource;
  s.position=vec3f(shipVertices[o],shipVertices[o+1u],shipVertices[o+2u]);
  s.normal=vec3f(shipVertices[o+3u],shipVertices[o+4u],shipVertices[o+5u]);
  s.material=shipVertices[o+6u];s.uv=vec2f(shipVertices[o+7u],shipVertices[o+8u]);
  return s;
}
// The source vertex corner 'vertex' of cluster 'cluster' names (the cut entry's cluster), or 0xffffffff past its end.
fn shipContinuumClusterVertex(body:ShipContinuumBody,cluster:u32,vertex:u32)->u32 {
  let at=body.clusters.x+cluster*${SHIP_CONTINUUM_CLUSTER_WORDS}u;
  if(vertex/3u>=(shipShape[at+15u]&255u)){return 0xffffffffu;}
  return shipMesh[body.clusters.z+shipShape[at+14u]+vertex];
}
` + SHIP_CONTINUUM_DECODE;
}

// --------------------------------------------------------------------------------------------- the cut
export function shipContinuumCutWGSL() {
  return CONTINUUM_CORE_WGSL + FRAME_WGSL + SHADOW_FRAME + SHIP_CONTINUUM_STRUCTS + /* wgsl */`
struct ShipContinuumOffset { domain:vec4f, grid:vec4f };
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> shipOffset:ShipContinuumOffset;
@group(0) @binding(2) var<uniform> SH:ShadowFrame;
@group(0) @binding(3) var<storage,read> shipInstances:array<ShipContinuumInstance>;
@group(0) @binding(4) var<storage,read> shipShape:array<u32>;
@group(0) @binding(5) var<uniform> shipBodies:array<ShipContinuumBody,${SHIP_CONTINUUM_BODY_LIMIT}>;
@group(0) @binding(6) var<storage,read_write> shipList:array<vec2u>;
@group(0) @binding(7) var<storage,read_write> shipDraws:array<atomic<u32>>;
@group(0) @binding(8) var<uniform> shipCut:ShipContinuumCut;
const SHIP_CONTINUUM_IMPORTANT:f32=${SHIP_CONTINUUM_IMPORTANT.toFixed(4)};
const SHIP_CONTINUUM_SHADOW_TEXELS:f32=${SHIP_CONTINUUM_SHADOW_TEXELS.toFixed(4)};
${continuumClusterPrefixWGSL('shipContinuumPrefix', (i) => `bitcast<f32>(shipShape[shipCutBody.clusters.x+(${i})*${SHIP_CONTINUUM_CLUSTER_WORDS}u+13u])`)}
${continuumMorphStepWGSL('shipContinuumMorphStep', (i) => `bitcast<f32>(shipShape[shipCutBody.chain.x+shipCutBody.chain.w+(${i})*${SHIP_CONTINUUM_STEP_WORDS}u+1u])`)}
var<private> shipCutBody:ShipContinuumBody;
var<workgroup> shipShared:vec4u;   // candidate clusters, list, ship body, unused
var<workgroup> shipView:vec4f;     // focal, allowed pixels, scale, 1 when clusters are culled to the view
var<workgroup> shipPose:vec4f;     // yaw, pitch, roll, unused
var<workgroup> shipAt:vec3f;       // the ship's origin from the camera
fn shipContinuumRotate(v:vec3f,heading:f32,pitch:f32,roll:f32)->vec3f {
  let cr=cos(roll);let sr=sin(roll);let cp=cos(pitch);let sp=sin(pitch);let ch=cos(heading);let sh=sin(heading);
  let xx=cr*v.x-sr*v.y;let yy=sr*v.x+cr*v.y;let yp=cp*yy-sp*v.z;let zp=sp*yy+cp*v.z;
  return vec3f(ch*xx-sh*zp,yp,sh*xx+ch*zp);
}
// A point of the ship's frame (metres at scale 1) from the camera.
fn shipContinuumPlace(p:vec3f)->vec3f { return shipAt+shipContinuumRotate(p*shipView.z,shipPose.x,shipPose.y,shipPose.z); }
fn shipContinuumOutside(at:vec3f,reach:f32)->bool {
  let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
  let rowX=vec3f(F.viewProj[0].x,F.viewProj[1].x,F.viewProj[2].x);
  let rowY=vec3f(F.viewProj[0].y,F.viewProj[1].y,F.viewProj[2].y);
  let l=rowW+rowX;let r=rowW-rowX;let b=rowW+rowY;let t=rowW-rowY;
  return dot(l,at)< -reach*length(l)||dot(r,at)< -reach*length(r)||dot(b,at)< -reach*length(b)||dot(t,at)< -reach*length(t)||dot(rowW,at)< -reach*length(rowW);
}
fn shipContinuumAppend(list:u32,count:u32)->u32 {
  let at=atomicAdd(&shipDraws[list*4u+1u],count);
  if(at+count>shipCut.lists[list].y){atomicSub(&shipDraws[list*4u+1u],count);return 0xffffffffu;}
  return shipCut.lists[list].x+at;
}
// A step's 128-triangle pieces of the far body, entered in a list.
fn shipContinuumChunks(list:u32,ship:u32,step:u32){
  let alive=shipShape[shipCutBody.chain.x+shipCutBody.chain.w+step*${SHIP_CONTINUUM_STEP_WORDS}u];
  let chunks=(alive+127u)/128u;
  let at=shipContinuumAppend(list,chunks);
  if(at==0xffffffffu){return;}
  for(var c=0u;c<chunks;c++){shipList[at+c]=vec2u(ship,c);}
}
@compute @workgroup_size(64) fn shipContinuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let ship=group.x;
  if(lane==0u){
    var candidates=0u;var list=0u;var share=0u;
    let inst=shipInstances[ship];
    let orders=u32(max(round(inst.anim.z),0.0));
    let damaged=(orders>>${SHIP_CONTINUUM_DAMAGED_SHIFT}u)&31u;
    let identity=orders>>${SHIP_CONTINUUM_IDENTITY_SHIFT}u;
    let bodyIndex=min(u32(max(round(inst.attitude.w),0.0)),${SHIP_CONTINUUM_BODY_LIMIT - 1}u);
    shipCutBody=shipBodies[bodyIndex];
    let seed=continuumHash(identity+1u)&255u;var step=0u;var shadowStep=0u;var morph=0.0;var splatScale=1.0;var splatShare=0u;
    let scale=max(inst.attitude.z,1e-3);
    let focal=F.screen.y/max(2.0*length(F.camUp.xyz),1e-4);
    let important=(orders&${SHIP_CONTINUUM_ORDER_IMPORTANT}u)!=0u||damaged!=0u;
    let pixels=shipCut.view.x*select(1.0,SHIP_CONTINUUM_IMPORTANT,important);
    shipAt=inst.posYaw.xyz+vec3f(shipOffset.grid.y,0.0,shipOffset.grid.z)-F.camPos.xyz;
    shipPose=vec4f(inst.posYaw.w,inst.attitude.x,inst.attitude.y,0.0);
    shipView=vec4f(focal,pixels,scale,select(1.0,0.0,damaged!=0u));
    let centre=shipContinuumPlace(shipCutBody.bound.xyz);
    let away=max(length(centre),1e-3);
    let reach=shipCutBody.bound.w*scale;
    let nearest=max(away-reach,0.25);
    let steps=u32(shipCutBody.far.y);
    if(damaged!=0u){
      // A damaged ship draws its clusters only, the finest its error bound allows, wherever its shards have flown.
      if(!shipContinuumOutside(centre,reach*2.0+20.0)){
        candidates=shipContinuumPrefix(0u,shipCutBody.clusters.y,pixels*nearest/(focal*scale));
        list=${SHIP_CONTINUUM_DAMAGED_LIST}u+min(damaged-1u,${SHIP_CONTINUUM_DAMAGED_SLOTS - 1}u);
      }
    } else {
      // The far body, coarse enough for the shadow map, casts every shadow, seen or not, and stands for the ship under water.
      shadowStep=u32(shipContinuumMorphStep(steps,max(SHIP_CONTINUUM_SHADOW_TEXELS*SH.texel.x,pixels*away/focal)/scale).x);
      shipContinuumChunks(${SHIP_CONTINUUM_SHADOW_LIST}u,ship,shadowStep);
      if(!shipContinuumOutside(centre,reach)){
        // Where the far body's own error is all the scene allows, it takes over, over a band of distance.
        let start=shipCutBody.far.x*scale*focal/pixels;
        let handoff=continuumHandoff(away,start);
        share=u32(round(handoff*255.0));
        let span=2.0*max(shipCutBody.far.z,shipCutBody.far.w)*scale*focal/away;
        splatShare=u32(round(continuumSplatShare(span)*255.0));
        if(share>0u){
          splatScale=continuumThin(span,identity*0x9e3779b9u+0x85ebca6bu);
          if(splatShare>0u&&splatScale>0.0){
            let at=shipContinuumAppend(2u,1u);
            if(at!=0xffffffffu){shipList[at]=vec2u(ship,0u);}
          }
          if(splatShare<255u){
            let chosen=shipContinuumMorphStep(steps,pixels*away/(focal*scale));
            step=u32(chosen.x);morph=chosen.y;
            shipContinuumChunks(1u,ship,step);
          }
        }
        if(share<255u){candidates=shipContinuumPrefix(0u,shipCutBody.clusters.y,pixels*nearest/(focal*scale));list=0u;}
      }
    }
    shipList[ship*2u]=vec2u(seed|(share<<8u)|(splatShare<<16u),step|(shadowStep<<16u));
    shipList[ship*2u+1u]=vec2u(bitcast<u32>(morph),bitcast<u32>(splatScale));
    shipShared=vec4u(candidates,list,bodyIndex,0u);
  }
  let cut=workgroupUniformLoad(&shipShared);
  let view=shipView;
  let body=shipBodies[cut.z];
  let scale=view.z;
  for(var i=lane;i<cut.x;i+=64u){
    let at=body.clusters.x+i*${SHIP_CONTINUUM_CLUSTER_WORDS}u;
    let lod=vec4f(bitcast<f32>(shipShape[at]),bitcast<f32>(shipShape[at+1u]),bitcast<f32>(shipShape[at+2u]),bitcast<f32>(shipShape[at+3u]));
    let parent=vec4f(bitcast<f32>(shipShape[at+4u]),bitcast<f32>(shipShape[at+5u]),bitcast<f32>(shipShape[at+6u]),bitcast<f32>(shipShape[at+7u]));
    if(!continuumClusterDrawn(bitcast<f32>(shipShape[at+12u])*scale,shipContinuumPlace(lod.xyz),lod.w*scale,bitcast<f32>(shipShape[at+13u])*scale,shipContinuumPlace(parent.xyz),parent.w*scale,view.x,view.y)){continue;}
    let cull=vec4f(bitcast<f32>(shipShape[at+8u]),bitcast<f32>(shipShape[at+9u]),bitcast<f32>(shipShape[at+10u]),bitcast<f32>(shipShape[at+11u]));
    if(view.w>0.5&&shipContinuumOutside(shipContinuumPlace(cull.xyz),cull.w*scale)){continue;}
    let entry=shipContinuumAppend(cut.y,1u);
    if(entry!=0xffffffffu){shipList[entry]=vec2u(group.x,i);}
  }
}
`;
}
