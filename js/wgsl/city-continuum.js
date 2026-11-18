// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The continuum's one cut for rigid bodies (js/city-continuum.js for the atlas, js/city-continuum-draw.js and
// js/prop-continuum-draw.js for the scenes): a city's buildings, a coast's prefabs, port props and round shot. The cut
// and its handoffs are the shared core's (js/continuum-core.js); this reads an atlas and its instances, places them,
// and poses a broken one's shards. A family brings only its atlas, its instances and how it shades a surface.
//
// One workgroup an instance decides each frame how it is drawn: clusters of its type cut by projected error, its far
// body at one step of its collapse, its splat, or two of them sharing each pixel's samples across a band; and, if it
// stands within the shadow map, the cut its shadow is cast at. A broken instance is drawn as clusters alone, at the
// finest cut its error bound allows: a type's clusters are its parts' own (the bake keeps them apart), and each rides
// its part's shard flight, so no simplified surface spans two pieces or is left where a piece has flown from. Every
// list entry is one instance of a fixed-size draw: a cluster (384 vertices, or 96 for a small one), 32 far-body
// triangles (96), or a splat (3); the unused vertices are degenerate. A family's view draws the first four lists with
// one pipeline; the shadow map draws the other two with another.
import { FRAME_WGSL, SIM_CLOCK_LOOP_S } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import {
  CITY_CONTINUUM_HEADER, CITY_CONTINUUM_TYPE, CITY_CONTINUUM_TYPE_WORDS, CITY_CONTINUUM_CLUSTER_WORDS, CITY_CONTINUUM_VERTEX_WORDS,
  CITY_CONTINUUM_STEP_WORDS, CITY_CONTINUUM_TRIANGLE_WORDS, CITY_CONTINUUM_NEVER, CITY_CONTINUUM_KIND_Y, CITY_CONTINUUM_CHUNK_TRIANGLES,
  CITY_CONTINUUM_CLUSTER_TRIANGLES, CITY_CONTINUUM_SMALL_CLUSTER, CITY_CONTINUUM_HOPS,
} from '../city-continuum.js';
import { FRACTURE_GRAVITY } from '../ship-fracture.js';

// The lists an instance can be entered in, each with its own indirect draw, and the vertices of one entry.
export const CITY_CONTINUUM_LISTS = Object.freeze(['clusters', 'small clusters', 'far body', 'splat', 'shadow far body', 'shadow clusters']);
export const CITY_CONTINUUM_INSTANCE_VERTICES = Object.freeze([3 * CITY_CONTINUUM_CLUSTER_TRIANGLES, 3 * CITY_CONTINUUM_SMALL_CLUSTER, 3 * CITY_CONTINUUM_CHUNK_TRIANGLES, 3, 3 * CITY_CONTINUUM_CHUNK_TRIANGLES, 3 * CITY_CONTINUUM_CLUSTER_TRIANGLES]);
// The view's lists come first; the shadow map's are the rest.
export const CITY_CONTINUUM_VIEW_LISTS = 4;
// The draws buffer: each list's draw, four words.
export const CITY_CONTINUUM_DRAW_WORDS = CITY_CONTINUUM_LISTS.length * 4;
export const CITY_CONTINUUM_VIEW_BYTES = 32 + CITY_CONTINUUM_LISTS.length * 16 + 16;
// An instance's record: its place (root, then shape), its tag, then its turn (the rest of its place).
export const CITY_CONTINUUM_INSTANCE_WORDS = 16;
// The select dispatch is laid in rows of this many workgroups, an instance to each.
export const CITY_CONTINUUM_ROW = 8192;
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
export const CITY_CONTINUUM_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// How many shadow-map texels a shadow's cut may be in error.
export const CITY_CONTINUUM_SHADOW_TEXELS = 1.5;
// An instance's tag: its type in the low 16 bits and these flags above; its block of shard records (in vec4f); how
// far past its type's sphere its pieces may lie (metres, f32 bits); the seed that thins its splat.
//   GONE    not drawn at all: a building standing as pieces drawn elsewhere, a prop sunk or not placed
//   STRUCK  shot has struck it, until it is stood again: cut at the core's CONTINUUM_IMPORTANT share of the error
//   BROKEN  in pieces: drawn as clusters alone, each riding its part's shard flight from its block of records
export const CITY_CONTINUUM_GONE = 1 << 16;
export const CITY_CONTINUUM_FELLED = CITY_CONTINUUM_GONE;
export const CITY_CONTINUUM_STRUCK = 1 << 17;
export const CITY_CONTINUUM_BROKEN = 1 << 18;
// A body's tint word (shape.w) when it is worn as its builder made it, not tinted and aged as a city's house: a
// coast's prefab (js/prefab-continuum.js), never stretched.
export const CITY_CONTINUUM_AS_BUILT = -1000;
// What an entry is, in the top four bits of its second word.
export const CITY_CONTINUUM_CLUSTER_ENTRY = 1, CITY_CONTINUUM_FAR_ENTRY = 2, CITY_CONTINUUM_SPLAT_ENTRY = 3;

// What every pass knows of the atlas, of the instances and of a broken one's shards. A point carries its two words a
// family reads as it will (a building's kind, a prop's UV): `high` the top half of its second, `surface` its fourth.
// Written when a module is, not as the bundle loads: it reads the fracture's constants, which load later.
export const cityContinuumCommonWGSL = () => /* wgsl */`
struct CityContinuumView {
  counts:vec4u,             // instances, samples a pixel, 1 when shadows are cast, unused
  scene:vec4f,              // the scene's pixel error, the world's offset x and z, unused
  lists:array<vec4u,${CITY_CONTINUUM_LISTS.length}>,     // each list's first entry and capacity
  aim:vec4f,                // where the player's guns would fall, in the scene's frame, and how far about it (0: none)
};
// Where an instance stands (its type's mesh stretched by shape.xyz, turned by the unit quaternion turn, then about
// the vertical by root.w, and stood at root.xyz); shape.w its family's own word: a building's tint, or, from -150 to
// -50, a fence's slope along its length (plus 100), or, below that, CITY_CONTINUUM_AS_BUILT; a prop's glow. A body
// that stands upright keeps the turn (0, 0, 0, 1); one held at any angle (a rammer, a spyglass, an arrow) is turned.
struct CityContinuumPlace { root:vec4f, shape:vec4f, turn:vec4f };
struct CityContinuumInstance { root:vec4f, shape:vec4f, tag:vec4u, turn:vec4f };
struct CityContinuumPoint { position:vec3f, normal:vec3f, high:u32, surface:u32 };
struct CityContinuumFar { position:vec3f, normal:vec3f, high:u32, surface:u32, shown:bool };
struct CityContinuumPose { position:vec3f, normal:vec3f, hidden:bool };
const CITY_CONTINUUM_NEVER:u32=${CITY_CONTINUUM_NEVER}u;
fn cityContinuumPlaceOf(instance:u32)->CityContinuumPlace { let at=cityInstances[instance];return CityContinuumPlace(at.root,at.shape,at.turn); }
// A vector turned by a unit quaternion.
fn cityContinuumQuat(q:vec4f,v:vec3f)->vec3f { let t=2.0*cross(q.xyz,v);return v+q.w*t+cross(q.xyz,t); }
fn cityContinuumTypeOf(instance:u32)->u32 { return cityInstances[instance].tag.x&65535u; }
fn cityContinuumBroken(tag:vec4u)->bool { return (tag.x&${CITY_CONTINUUM_BROKEN}u)!=0u; }
fn cityContinuumType(archetype:u32,field:u32)->u32 { return cityAtlas[cityAtlas[${CITY_CONTINUUM_HEADER.typesAt}u]+archetype*${CITY_CONTINUUM_TYPE_WORDS}u+field]; }
fn cityContinuumTypeF(archetype:u32,field:u32)->f32 { return bitcast<f32>(cityContinuumType(archetype,field)); }
fn cityContinuumSlope(shape:vec4f)->f32 { return select(0.0,clamp(shape.w+100.0,-0.95,0.95),shape.w< -50.0&&shape.w> -150.0); }
// A point of the type, in the type's own metres, stood where the instance stands (without the world's offset).
fn cityContinuumPlace(p:vec3f,place:CityContinuumPlace)->vec3f {
  let s0=p*place.shape.xyz;
  let q=cityContinuumQuat(place.turn,vec3f(s0.x,s0.y+s0.z*cityContinuumSlope(place.shape),s0.z));
  let c=cos(place.root.w);let s=sin(place.root.w);
  return place.root.xyz+vec3f(q.x*c+q.z*s,q.y,-q.x*s+q.z*c);
}
fn cityContinuumTurn(n:vec3f,place:CityContinuumPlace)->vec3f {
  let b=n/max(place.shape.xyz,vec3f(1e-3));
  let m=cityContinuumQuat(place.turn,normalize(vec3f(b.x,b.y,b.z-cityContinuumSlope(place.shape)*b.y)));
  let c=cos(place.root.w);let s=sin(place.root.w);
  return vec3f(m.x*c+m.z*s,m.y,-m.x*s+m.z*c);
}
// How much an instance's stretch can lengthen any length of its type: its errors and bounds grow by this.
fn cityContinuumScale(place:CityContinuumPlace)->f32 { return max(max(place.shape.x,place.shape.y),place.shape.z)*(1.0+abs(cityContinuumSlope(place.shape))); }
fn cityContinuumOctahedral(e:vec2f)->vec3f {
  let f=e*2.0-1.0;
  var n=vec3f(f.x,f.y,1.0-abs(f.x)-abs(f.y));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
fn cityContinuumPoint(archetype:u32,at:u32)->CityContinuumPoint {
  let w0=cityAtlas[at];let w1=cityAtlas[at+1u];
  let low=vec3f(cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.low}u),cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.low + 1}u),cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.low + 2}u));
  var p:CityContinuumPoint;
  p.position=low+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))*(cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.span}u)/65535.0);
  p.normal=cityContinuumOctahedral(unpack2x16unorm(cityAtlas[at+2u]));
  p.high=w1>>16u;p.surface=cityAtlas[at+3u];
  return p;
}
fn cityContinuumStepWord(archetype:u32,step:u32,word:u32)->u32 { return cityAtlas[cityContinuumType(archetype,${CITY_CONTINUUM_TYPE.steps}u)+step*${CITY_CONTINUUM_STEP_WORDS}u+word]; }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn cityContinuumAncestor(archetype:u32,vertex:u32,step:u32)->u32 {
  let records=cityContinuumType(archetype,${CITY_CONTINUUM_TYPE.records}u);
  var v=vertex;
  for(var hop=0u;hop<${CITY_CONTINUUM_HOPS}u;hop++){
    let record=cityAtlas[records+v];
    let at=record&65535u;
    if(at==CITY_CONTINUUM_NEVER||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
// One corner of the far body at a step, on its way to where the next collapse takes it, grown along its normals by
// what the collapses have taken off the outline. Its surface is its triangle's.
fn cityContinuumFarCorner(archetype:u32,chunk:u32,vertex:u32,step:u32,morph:f32)->CityContinuumFar {
  var out:CityContinuumFar;
  let triangle=chunk*${CITY_CONTINUUM_CHUNK_TRIANGLES}u+vertex/3u;
  out.shown=triangle<cityContinuumStepWord(archetype,step,0u);
  if(!out.shown){return out;}
  let at=cityContinuumType(archetype,${CITY_CONTINUUM_TYPE.triangles}u)+triangle*${CITY_CONTINUUM_TRIANGLE_WORDS}u;
  out.surface=cityAtlas[at+3u];
  let next=min(step+1u,cityContinuumType(archetype,${CITY_CONTINUUM_TYPE.stepCount}u));
  let a=cityContinuumAncestor(archetype,cityAtlas[at+vertex%3u],step);let b=cityContinuumAncestor(archetype,a,next);
  let first=cityContinuumType(archetype,${CITY_CONTINUUM_TYPE.chainVertices}u);
  let pa=cityContinuumPoint(archetype,first+a*${CITY_CONTINUUM_VERTEX_WORDS}u);let pb=cityContinuumPoint(archetype,first+b*${CITY_CONTINUUM_VERTEX_WORDS}u);
  let grow=mix(bitcast<f32>(cityContinuumStepWord(archetype,step,2u)),bitcast<f32>(cityContinuumStepWord(archetype,next,2u)),morph);
  out.position=mix(pa.position+pa.normal*grow,pb.position+pb.normal*grow,morph);
  out.normal=normalize(mix(pa.normal,pb.normal,morph));
  return out;
}
fn cityContinuumRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f { return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c); }
// Where a point of a broken instance's shard is now, in its type's own frame. Its block of the shard records is one
// vec4f whose x is the frame time at which its debris clock read zero, then four vec4f a shard as js/ship-fracture.js
// lays them out: pivot and release time, velocity and settle time, spin and the age it is hidden at, then hinge,
// gravity, sink and what holds it (-2 standing, -1 in flight, otherwise the age it stopped at).
fn cityContinuumPose(records:u32,shard:u32,position:vec3f,normal:vec3f)->CityContinuumPose {
  var pose:CityContinuumPose;pose.position=position;pose.normal=normal;pose.hidden=false;
  let at=records+1u+shard*4u;
  let motion=cityShards[at+3u];
  if(motion.w< -1.5){return pose;}
  let origin=cityShards[at];let flight=cityShards[at+1u];let spinHide=cityShards[at+2u];
  // The frame clock starts again every ${SIM_CLOCK_LOOP_S} s; no flight lasts that long.
  var clock=F.camPos.w-cityShards[records].x;
  if(clock<0.0){clock+=${SIM_CLOCK_LOOP_S.toFixed(1)};}
  let age=select(max(0.0,clock-origin.w),motion.w,motion.w>=0.0);
  if(spinHide.w>=0.0&&age>=spinHide.w){pose.hidden=true;return pose;}
  let settle=flight.w;let hinge=motion.x;let rate=length(spinHide.xyz);
  let free=max(0.0,min(age,settle)-hinge);let held=min(age,hinge);
  var angle=rate*free;
  if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
  let drop=0.5*${FRACTURE_GRAVITY}*motion.y*free*free+motion.z*max(0.0,age-settle);
  var relative=position-origin.xyz;
  if(rate>1e-5){
    let axis=spinHide.xyz/rate;let ca=cos(angle);let sa=sin(angle);
    relative=cityContinuumRotate(relative,axis,ca,sa);
    pose.normal=normalize(cityContinuumRotate(normal,axis,ca,sa));
  }
  pose.position=origin.xyz+relative+flight.xyz*free-vec3f(0.0,drop,0.0);
  return pose;
}
// A point of a cluster's part, carried by its shard's flight when the instance is broken.
fn cityContinuumPosed(tag:vec4u,part:u32,position:vec3f,normal:vec3f)->CityContinuumPose {
  if(!cityContinuumBroken(tag)){var pose:CityContinuumPose;pose.position=position;pose.normal=normal;pose.hidden=false;return pose;}
  return cityContinuumPose(tag.y,part,position,normal);
}
// An instance's state for the frame, two entries ahead of the lists: handoff share | splat share << 8, step | shadow
// step << 16, then the morph and the splat's scale (f32 bits).
fn cityContinuumState(instance:u32)->vec4u { let a=cityLists[instance*2u];let b=cityLists[instance*2u+1u];return vec4u(a.x,a.y,b.x,b.y); }
// One vertex of a cluster entry, in the type's own metres and posed with its part's shard; hidden past its triangles.
fn cityContinuumClusterPoint(instance:u32,cluster:u32,vertex:u32)->CityContinuumFar {
  var out:CityContinuumFar;
  let at=cityAtlas[${CITY_CONTINUUM_HEADER.clustersAt}u]+cluster*${CITY_CONTINUUM_CLUSTER_WORDS}u;
  out.shown=vertex/3u<(cityAtlas[at+15u]&255u);
  if(!out.shown){return out;}
  let v=cityAtlas[cityAtlas[${CITY_CONTINUUM_HEADER.indicesAt}u]+cityAtlas[at+14u]+vertex];
  let p=cityContinuumPoint(cityContinuumTypeOf(instance),cityAtlas[${CITY_CONTINUUM_HEADER.verticesAt}u]+v*${CITY_CONTINUUM_VERTEX_WORDS}u);
  let pose=cityContinuumPosed(cityInstances[instance].tag,cityAtlas[at+15u]>>16u,p.position,p.normal);
  out.shown=!pose.hidden;out.position=pose.position;out.normal=pose.normal;out.high=p.high;out.surface=p.surface;
  return out;
}
`;

// The data a pass binds: the atlas, the instances, the lists, the view, the shard records.
export const cityContinuumData = (group, first, lists) => /* wgsl */`
@group(${group}) @binding(${first}) var<storage,read> cityAtlas:array<u32>;
@group(${group}) @binding(${first + 1}) var<storage,read> cityInstances:array<CityContinuumInstance>;
@group(${group}) @binding(${first + 2}) var<storage,${lists}> cityLists:array<vec2u>;
@group(${group}) @binding(${first + 3}) var<uniform> cityView:CityContinuumView;
@group(${group}) @binding(${first + 4}) var<storage,read> cityShards:array<vec4f>;
`;
// A drawing pass names every binding of its group once, on a path never taken, so the layout it derives holds them all.
export const CITY_CONTINUUM_TOUCH = /* wgsl */`
fn cityContinuumBindings()->f32 {
  if(cityView.counts.y!=0xffffffffu){return 0.0;}
  return f32(cityAtlas[0]+cityInstances[0].tag.x+cityLists[0].x)+cityShards[0].x;
}
struct CityContinuumEntry { @location(0) entry:vec2u };
`;

// --------------------------------------------------------------------------------------------- the cut
export function cityContinuumSelectWGSL() {
  const T = CITY_CONTINUUM_TYPE;
  const sphereOf = (archetype) => `vec4f(cityContinuumTypeF(${archetype},${T.sphere}u),cityContinuumTypeF(${archetype},${T.sphere + 1}u),cityContinuumTypeF(${archetype},${T.sphere + 2}u),cityContinuumTypeF(${archetype},${T.sphere + 3}u))`;
  const atlasVec4 = (at) => `vec4f(bitcast<f32>(cityAtlas[${at}]),bitcast<f32>(cityAtlas[${at}+1u]),bitcast<f32>(cityAtlas[${at}+2u]),bitcast<f32>(cityAtlas[${at}+3u]))`;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + cityContinuumData(0, 2, 'read_write') + cityContinuumCommonWGSL() + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> SH:ShadowFrame;
@group(0) @binding(7) var<storage,read_write> cityDraws:array<atomic<u32>>;
const CITY_CONTINUUM_SHADOW_TEXELS:f32=${CITY_CONTINUUM_SHADOW_TEXELS.toFixed(4)};
const CITY_CONTINUUM_FULL:u32=0xffffffffu;
// The morph search reads the steps of the type in hand.
var<private> cityContinuumSteps:u32;
${continuumClusterPrefixWGSL('cityContinuumPrefix', (i) => `bitcast<f32>(cityAtlas[cityAtlas[${CITY_CONTINUUM_HEADER.clustersAt}u]+(${i})*${CITY_CONTINUUM_CLUSTER_WORDS}u+13u])`)}
${continuumMorphStepWGSL('cityContinuumMorphStep', (i) => `bitcast<f32>(cityAtlas[cityContinuumSteps+(${i})*${CITY_CONTINUUM_STEP_WORDS}u+1u])`)}
fn cityContinuumOutside(at:vec3f,reach:f32)->bool {
  let m=F.viewProj;let p=vec4f(at,1.0);
  let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
  let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
  for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
  return false;
}
fn cityContinuumAppend(list:u32,count:u32)->u32 {
  if(count==0u){return CITY_CONTINUUM_FULL;}
  let at=atomicAdd(&cityDraws[list*4u+1u],count);
  if(at+count>cityView.lists[list].y){atomicSub(&cityDraws[list*4u+1u],count);return CITY_CONTINUUM_FULL;}
  return cityView.lists[list].x+at;
}
fn cityContinuumChunks(archetype:u32,step:u32)->u32 { return (cityContinuumStepWord(archetype,step,0u)+${CITY_CONTINUUM_CHUNK_TRIANGLES - 1}u)/${CITY_CONTINUUM_CHUNK_TRIANGLES}u; }
fn cityContinuumFocal()->f32 { return F.screen.y/max(2.0*length(F.camUp.xyz),1e-4); }
fn cityContinuumShift()->vec3f { return vec3f(cityView.scene.y,0.0,cityView.scene.z); }
// Each list empty, its draw's vertex count set.
@compute @workgroup_size(32) fn cityContinuumReset(@builtin(local_invocation_index) i:u32){
  let vertices=array<u32,${CITY_CONTINUUM_LISTS.length}>(${CITY_CONTINUUM_INSTANCE_VERTICES.map((n) => `${n}u`).join(',')});
  if(i<${CITY_CONTINUUM_DRAW_WORDS}u){atomicStore(&cityDraws[i],select(0u,vertices[i/4u],i%4u==0u));}
}
var<workgroup> citySelected:array<vec4u,2>; // clusters to try, the first, where the far body's pieces go, how many; the shadow's far pieces, how many, its clusters to try
var<workgroup> citySelectedView:vec4f;      // focal, allowed pixels, scale, the shadow's allowed error (metres of the type)
@compute @workgroup_size(64) fn cityContinuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let instance=group.x+group.y*${CITY_CONTINUUM_ROW}u;
  if(lane==0u){
    var candidates=0u;var firstCluster=0u;var farAt=CITY_CONTINUUM_FULL;var farChunks=0u;
    var shadowAt=CITY_CONTINUUM_FULL;var shadowChunks=0u;var shadowCandidates=0u;
    var focal=1.0;var pixels=1.0;var scale=1.0;var shadowAllowed=0.0;
    if(instance<cityView.counts.x){
      let tag=cityInstances[instance].tag;
      let archetype=tag.x&65535u;
      var share=0u;var splatShare=0u;var step=0u;var shadowStep=0u;var morph=0.0;var splatScale=0.0;
      // One gone (a building standing as pieces drawn elsewhere, a prop sunk) is not drawn here at all.
      if((tag.x&${CITY_CONTINUUM_GONE}u)==0u){
        let broken=cityContinuumBroken(tag);
        let place=cityContinuumPlaceOf(instance);
        scale=cityContinuumScale(place);
        let sphere=${sphereOf('archetype')};
        let world=cityContinuumPlace(sphere.xyz,place);
        // A broken one's reach takes in its pieces in the air and on the ground.
        let reach=sphere.w*scale+bitcast<f32>(tag.z);
        let relative=world+cityContinuumShift()-F.camPos.xyz;
        let away=max(length(relative),1e-3);
        focal=cityContinuumFocal();
        // One struck, broken, or within the fall of the player's guns is cut finer (rule 3, item 5).
        let aim=cityView.aim;
        let aimed=aim.w>0.0&&length(relative+F.camPos.xyz-aim.xyz)<=reach+aim.w;
        pixels=continuumImportance(cityView.scene.x,aimed||broken||(tag.x&${CITY_CONTINUUM_STRUCK}u)!=0u);
        let steps=cityContinuumType(archetype,${T.stepCount}u);
        // The far body is drawn from the first step no heavier than the clusters' coarsest cut; finer is theirs.
        let farFirst=cityContinuumType(archetype,${T.farFirst}u);
        cityContinuumSteps=cityContinuumType(archetype,${T.steps}u);
        firstCluster=cityContinuumType(archetype,${T.clusterFirst}u);
        let clusterCount=cityContinuumType(archetype,${T.clusterCount}u);
        // Its shadow, cut coarse enough for the shadow map, is cast whether it is seen or not: a whole one's far body,
        // a broken one's pieces, each a cut of its own clusters.
        if(cityView.counts.z!=0u){
          let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
          let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
          if(abs(light.x)<1.0+r.x&&abs(light.y)<1.0+r.y&&light.z> -r.z&&light.z<1.0+r.z){
            let allowed=max(CITY_CONTINUUM_SHADOW_TEXELS*SH.texel.x,pixels*away/focal)/scale;
            if(!broken){
              shadowStep=max(farFirst,u32(cityContinuumMorphStep(steps,allowed).x));
              shadowChunks=cityContinuumChunks(archetype,shadowStep);
              shadowAt=cityContinuumAppend(4u,shadowChunks);
            }else{
              shadowAllowed=allowed;
              shadowCandidates=cityContinuumPrefix(firstCluster,clusterCount,allowed);
            }
          }
        }
        if(!cityContinuumOutside(earthCurve(relative,F.camPos.y),reach)){
          // A whole one hands over from its clusters to its far body where the far body's error at its first step is
          // all the scene allows, over a band of distance; then to its splat. A broken one stays its pieces.
          if(!broken){
            let start=bitcast<f32>(cityContinuumStepWord(archetype,farFirst,1u))*scale*focal/pixels;
            share=u32(round(continuumHandoff(away,start)*255.0));
            let span=2.0*max(cityContinuumTypeF(archetype,${T.splatRx}u)*0.5*(place.shape.x+place.shape.z),cityContinuumTypeF(archetype,${T.splatRy}u)*place.shape.y)*focal/away;
            splatShare=u32(round(continuumSplatShare(span)*255.0));
            if(share>0u){
              splatScale=continuumThin(span,tag.w*0x9e3779b9u+0x85ebca6bu);
              if(splatShare>0u&&splatScale>0.0){
                let at=cityContinuumAppend(3u,1u);
                if(at!=CITY_CONTINUUM_FULL){cityLists[at]=vec2u(instance,${CITY_CONTINUUM_SPLAT_ENTRY}u<<28u);}
              }
              if(splatShare<255u){
                let chosen=cityContinuumMorphStep(steps,pixels*away/(focal*scale));
                step=u32(chosen.x);morph=chosen.y;
                if(step<farFirst){step=farFirst;morph=0.0;}
                farChunks=cityContinuumChunks(archetype,step);
                farAt=cityContinuumAppend(2u,farChunks);
              }
            }
          }
          // The clusters that can be drawn at its nearest point, each tried by the lanes below.
          if(share<255u){
            candidates=cityContinuumPrefix(firstCluster,clusterCount,pixels*max(away-reach,0.25)/(focal*scale));
          }
        }
      }
      cityLists[instance*2u]=vec2u(share|(splatShare<<8u),step|(shadowStep<<16u));
      cityLists[instance*2u+1u]=vec2u(bitcast<u32>(morph),bitcast<u32>(splatScale));
    }
    citySelected[0]=vec4u(candidates,firstCluster,farAt,farChunks);
    citySelected[1]=vec4u(shadowAt,shadowChunks,shadowCandidates,0u);
    citySelectedView=vec4f(focal,pixels,scale,shadowAllowed);
  }
  let chosen=workgroupUniformLoad(&citySelected);
  let view=citySelectedView;
  if(chosen[0].z!=CITY_CONTINUUM_FULL){for(var c=lane;c<chosen[0].w;c+=64u){cityLists[chosen[0].z+c]=vec2u(instance,c|(${CITY_CONTINUUM_FAR_ENTRY}u<<28u));}}
  if(chosen[1].x!=CITY_CONTINUUM_FULL){for(var c=lane;c<chosen[1].y;c+=64u){cityLists[chosen[1].x+c]=vec2u(instance,c|(${CITY_CONTINUUM_FAR_ENTRY}u<<28u));}}
  let tries=max(chosen[0].x,chosen[1].z);
  if(tries==0u){return;}
  // The clusters drawn at this instance's distance, by the core's own test, each sphere carried with its part's
  // shard, those in view entered in the list for their size. A shard sunk out of sight takes its clusters with it.
  let tag=cityInstances[instance].tag;
  let place=cityContinuumPlaceOf(instance);
  let shift=cityContinuumShift()-F.camPos.xyz;
  let clusters=cityAtlas[${CITY_CONTINUUM_HEADER.clustersAt}u];
  let up=vec3f(0.0,1.0,0.0);
  for(var i=lane;i<tries;i+=64u){
    let c=chosen[0].y+i;
    let at=clusters+c*${CITY_CONTINUUM_CLUSTER_WORDS}u;
    let part=cityAtlas[at+15u]>>16u;
    let lod=${atlasVec4('at')};let parent=${atlasVec4('at+4u')};let cull=${atlasVec4('at+8u')};
    let own=cityContinuumPosed(tag,part,lod.xyz,up);
    if(own.hidden){continue;}
    let ownError=bitcast<f32>(cityAtlas[at+12u])*view.z;let parentError=bitcast<f32>(cityAtlas[at+13u])*view.z;
    if(i<chosen[0].x){
      let parentAt=cityContinuumPosed(tag,part,parent.xyz,up).position;
      let cullAt=cityContinuumPosed(tag,part,cull.xyz,up).position;
      if(continuumClusterDrawn(ownError,cityContinuumPlace(own.position,place)+shift,lod.w*view.z,parentError,cityContinuumPlace(parentAt,place)+shift,parent.w*view.z,view.x,view.y)
        &&!cityContinuumOutside(earthCurve(cityContinuumPlace(cullAt,place)+shift,F.camPos.y),cull.w*view.z)){
        let entry=cityContinuumAppend(select(0u,1u,(cityAtlas[at+15u]&255u)<=${CITY_CONTINUUM_SMALL_CLUSTER}u),1u);
        if(entry!=CITY_CONTINUUM_FULL){cityLists[entry]=vec2u(instance,c|(${CITY_CONTINUUM_CLUSTER_ENTRY}u<<28u));}
      }
    }
    // The shadow map's light is parallel: the same test with every sphere at unit distance under a unit focal length
    // compares errors directly against the error it allows.
    if(i<chosen[1].z&&continuumClusterDrawn(ownError,vec3f(0.0,0.0,1.0),0.0,parentError,vec3f(0.0,0.0,1.0),0.0,1.0,view.w*view.z)){
      let entry=cityContinuumAppend(5u,1u);
      if(entry!=CITY_CONTINUUM_FULL){cityLists[entry]=vec2u(instance,c|(${CITY_CONTINUUM_CLUSTER_ENTRY}u<<28u));}
    }
  }
}
`;
}

// --------------------------------------------------------------------------------------------- the splat
// A splat's corner, facing the eye from `centre` (in the scene's frame): the triangle that circumscribes the outline's
// ellipse, shrunk to the ellipse's own area, and grown where the splat is thinned to keep the horizon's covered area.
export const CITY_CONTINUUM_SPLAT = /* wgsl */`
struct CityContinuumSplat { world:vec3f, toward:vec3f, corner:vec2f };
fn cityContinuumSplatCorner(archetype:u32,place:CityContinuumPlace,eye:vec3f,vertex:u32,thinned:f32)->CityContinuumSplat {
  let local=vec3f(cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.splatCentre}u),cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.splatCentre + 1}u),cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.splatCentre + 2}u));
  let centre=cityContinuumPlace(local,place);
  var out:CityContinuumSplat;
  out.toward=normalize(eye-centre);
  // Its height is along the body's own up, turned as the body is; an upright body's is the world's.
  let raised=cityContinuumQuat(place.turn,vec3f(0.0,1.0,0.0));let c=cos(place.root.w);let s=sin(place.root.w);
  let lift=vec3f(raised.x*c+raised.z*s,raised.y,-raised.x*s+raised.z*c);
  let up=normalize(lift-out.toward*dot(lift,out.toward)+vec3f(0.0,1e-4,0.0));
  let right=normalize(cross(up,out.toward));
  let k=CONTINUUM_SPLAT_AREA*thinned;
  out.corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  let rx=cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.splatRx}u)*0.5*(place.shape.x+place.shape.z);
  let ry=cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.splatRy}u)*place.shape.y;
  out.world=centre+right*(out.corner.x*rx*k)+up*(out.corner.y*ry*k);
  return out;
}
// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far side the handoff's
// share and the clusters the rest; of the far side's, the splat its own share and the far body the rest. Every sample
// is drawn by exactly one of the three. coverage: the draw, handoff | splat << 8, the instance, samples.
fn cityContinuumMask(coverage:vec4u,pixel:vec2f,salt:u32)->u32 {
  let samples=clamp(coverage.w,1u,8u);
  let all=(1u<<samples)-1u;
  let seed=coverage.z*0x9e3779b9u+salt;
  let handoff=continuumSamples(f32(coverage.y&255u)/255.0,pixel,samples,seed);
  let splat=handoff&continuumSamples(f32((coverage.y>>8u)&255u)/255.0,pixel,samples,seed+7u);
  if(coverage.x==${CITY_CONTINUUM_CLUSTER_ENTRY}u){return all&~handoff;}
  if(coverage.x==${CITY_CONTINUUM_FAR_ENTRY}u){return handoff&~splat;}
  return splat;
}
`;

// --------------------------------------------------------------------------------------------- a city's drawing
// Appended to the land's own module (js/wgsl/terrain.js TERRAIN), whose group 0 it shades with: landOpaque, the
// near terrain's world offset, a roof's shade and age. Its data is group 2.
const CITY_CONTINUUM_RENDER = /* wgsl */`
const CITY_CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
struct CityContinuumVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) kind:vec2f,
  @location(3) leafUV:vec2f,
  @location(4) @interpolate(flat) coverage:vec4u,   // x the draw (1 clusters, 2 far body, 3 splat), y handoff | splat << 8, z the building, w samples
  @location(5) @interpolate(flat) splatKinds:vec4f, // a splat's walls' kind, then its roof's
  @location(6) splat:vec2f,                         // a splat: how high across it (-1 at its base, 2 at its apex), where its roof begins
};
struct CityContinuumCoverage { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
struct CityContinuumWorn { kind:vec2f, leafUV:vec2f };
fn cityContinuumHidden()->CityContinuumVertex { var out:CityContinuumVertex;out.pos=CITY_CONTINUUM_HIDDEN;return out; }
fn cityContinuumClip(world:vec3f)->vec4f {
  return F.viewProj*vec4f(earthCurve(world+vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z)-F.camPos.xyz,F.camPos.y),1.0);
}
// A vertex's kind (material | fraction << 8 in its surface word, kind.y in its high half-word); a far-body
// triangle's (material | fraction << 8 | kind.y << 20).
fn cityContinuumKind(high:u32,surface:u32)->vec2f { return vec2f(f32(surface&255u)+f32(surface>>8u)/16777215.0,f32(high)/65535.0*${CITY_CONTINUUM_KIND_Y.toFixed(1)}); }
fn cityContinuumFarKind(packed:u32)->vec2f { return vec2f(f32(packed&255u)+f32((packed>>8u)&4095u)/4095.0,f32(packed>>20u)/4095.0*${CITY_CONTINUUM_KIND_Y.toFixed(1)}); }
// A surface as this building wears it: limewash in its own tint, tiles and thatch in its own shade and age, masonry
// turned with it, a timber's grain in place of the age only a tile reads; and below -1, how high it stands above the
// building's floor, by which its walls weather. A window keeps its place in its pane.
fn cityContinuumWorn(kind:vec2f,place:CityContinuumPlace,height:f32)->CityContinuumWorn {
  let root=place.root;let shape=place.shape;
  let tone=select(fract(shape.w),0.5,shape.w< -50.0);
  let built=shape.w< -150.0;
  let material=floor(kind.x+0.01);
  var out:CityContinuumWorn;
  out.kind=kind;
  if(abs(material-14.0)>0.5){
    let turn=0.02+0.46*fract((fract(kind.x)-0.02)/0.46+root.w/PI);
    if(built){out.kind=vec2f(material+turn,kind.y);}
    else if(abs(material-12.0)<0.5){out.kind=vec2f(19.0+turn,floor(shape.w)+clamp(tone*kind.y,0.02,0.98));}
    else if(abs(material-13.0)<0.5||abs(material-15.0)<0.5){out.kind=vec2f(material+turn,kind.y*cityRoofShade(root,tone));}
    else{out.kind=vec2f(material+turn,kind.y);}
  }
  var grain=0.0;
  if(abs(material-10.0)<0.5){grain=floor(kind.y*0.5);out.kind=vec2f(out.kind.x,kind.y-2.0*grain);}
  out.leafUV=vec2f(select(select(cityRoofAge(root,tone),0.0,built),grain,grain>0.5),select(-1.0-max(height,0.0),-1.0,built));
  return out;
}
fn cityContinuumSurfaceVertex(point:CityContinuumFar,kind:vec2f,place:CityContinuumPlace)->CityContinuumVertex {
  if(!point.shown){return cityContinuumHidden();}
  var out:CityContinuumVertex;
  out.world=cityContinuumPlace(point.position,place);
  out.normal=cityContinuumTurn(point.normal,place);
  let worn=cityContinuumWorn(kind,place,point.position.y*place.shape.y);
  out.kind=worn.kind;out.leafUV=worn.leafUV;
  out.pos=cityContinuumClip(out.world);
  return out;
}
fn cityContinuumSplatVertex(building:u32,vertex:u32,state:vec4u)->CityContinuumVertex {
  let archetype=cityContinuumTypeOf(building);
  let place=cityContinuumPlaceOf(building);
  let splat=cityContinuumSplatCorner(archetype,place,F.camPos.xyz-vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z),vertex,bitcast<f32>(state.w));
  var out:CityContinuumVertex;
  out.world=splat.world;
  out.normal=splat.toward;
  let height=cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.splatCentre + 1}u)*place.shape.y;
  let wall=cityContinuumWorn(vec2f(cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.wallKind}u),cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.wallKind + 1}u)),place,height);
  let roof=cityContinuumWorn(vec2f(cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.roofKind}u),cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.roofKind + 1}u)),place,height);
  out.kind=wall.kind;out.leafUV=wall.leafUV;out.splatKinds=vec4f(wall.kind,roof.kind);
  // The roof takes the top of the triangle, as much of its area as it takes of the outline: above corner height t
  // (the apex at 2, the base at -1) lies ((2 - t) / 3)^2 of it.
  let share=cityContinuumTypeF(archetype,${CITY_CONTINUUM_TYPE.roofShare}u);
  out.splat=vec2f(splat.corner.y,2.0-3.0*sqrt(clamp(share,0.0,1.0)));
  out.pos=cityContinuumClip(out.world);
  return out;
}
@vertex fn cityContinuumVS(@builtin(vertex_index) vertex:u32,listed:CityContinuumEntry)->CityContinuumVertex {
  let touched=cityContinuumBindings();
  let building=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  let state=cityContinuumState(building);
  var out:CityContinuumVertex;
  if(what==${CITY_CONTINUUM_CLUSTER_ENTRY}u){
    let point=cityContinuumClusterPoint(building,item,vertex);
    out=cityContinuumSurfaceVertex(point,cityContinuumKind(point.high,point.surface),cityContinuumPlaceOf(building));
  }else if(what==${CITY_CONTINUUM_FAR_ENTRY}u){
    // Every corner of a far-body triangle carries the triangle's own kind.
    let point=cityContinuumFarCorner(cityContinuumTypeOf(building),item,vertex,state.y&65535u,bitcast<f32>(state.z));
    out=cityContinuumSurfaceVertex(point,cityContinuumFarKind(point.surface),cityContinuumPlaceOf(building));
  }else{out=cityContinuumSplatVertex(building,vertex,state);}
  out.world+=vec3f(touched);
  out.coverage=vec4u(what,state.x&65535u,building,cityView.counts.y);
  return out;
}
@fragment fn cityContinuumFS(in:CityContinuumVertex)->CityContinuumCoverage {
  // The far body is shaded flat, each face by its own plane: its corners' normals are the wrap's, rounded over edges.
  let across=dpdx(in.world);let down=dpdy(in.world);
  let plane=cross(down,across);
  let toEye=F.camPos.xyz-(in.world+vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z));
  let faceted=select(in.normal,normalize(plane)*select(-1.0,1.0,dot(plane,toEye)>=0.0),dot(plane,plane)>1e-16);
  var normal=in.normal;var kind=in.kind;
  if(in.coverage.x==${CITY_CONTINUUM_FAR_ENTRY}u){normal=faceted;}
  else if(in.coverage.x==${CITY_CONTINUUM_SPLAT_ENTRY}u){
    let roof=in.splat.x>in.splat.y;
    kind=select(in.splatKinds.xy,in.splatKinds.zw,roof);
    normal=select(in.normal,normalize(vec3f(0.0,1.0,0.0)+in.normal*0.6),roof);
  }
  var out:CityContinuumCoverage;
  out.colour=landOpaque(LandVertex(in.pos,in.world,normal,kind,in.leafUV));
  out.mask=cityContinuumMask(in.coverage,in.pos.xy,1u);
  return out;
}
`;

export function cityContinuumRenderWGSL() {
  return cityContinuumData(2, 40, 'read') + cityContinuumCommonWGSL() + CITY_CONTINUUM_TOUCH + CITY_CONTINUUM_SPLAT + CITY_CONTINUUM_RENDER;
}

// The shadow map's module, every family's: a whole instance's far body at the step the cut chose for its shadow,
// unmorphed, and a broken one's pieces at their own cut, each where its flight has it.
export function cityContinuumShadowWGSL() {
  return FRAME_WGSL + SHADOW_FRAME + cityContinuumData(1, 0, 'read') + cityContinuumCommonWGSL() + CITY_CONTINUUM_TOUCH + /* wgsl */`
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@group(0) @binding(1) var<uniform> F:Frame;
@vertex fn cityContinuumShadowVS(@builtin(vertex_index) vertex:u32,listed:CityContinuumEntry)->@builtin(position) vec4f {
  let touched=cityContinuumBindings();
  let instance=listed.entry.x;let item=listed.entry.y&0x0fffffffu;
  var point:CityContinuumFar;
  if((listed.entry.y>>28u)==${CITY_CONTINUUM_FAR_ENTRY}u){point=cityContinuumFarCorner(cityContinuumTypeOf(instance),item,vertex,cityContinuumState(instance).y>>16u,0.0);}
  else{point=cityContinuumClusterPoint(instance,item,vertex);}
  if(!point.shown){return vec4f(2.0,2.0,0.0,1.0);}
  let world=cityContinuumPlace(point.position,cityContinuumPlaceOf(instance))+vec3f(touched);
  return SH.lightView*vec4f(world-SH.origin.xyz,1.0);
}
`;
}
