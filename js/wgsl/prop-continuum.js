// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The prop continuum's GPU side (js/prop-continuum.js, js/prop-continuum-draw.js): port props and round shot. The cut
// and its handoffs are the shared core's (js/continuum-core.js), and the atlas is laid out as the city's; this
// supplies only how a prop's data is read, placed, posed and worn.
//
// One workgroup an instance decides each frame how it is drawn: clusters of its type cut by projected error, its far
// body at one step of its collapse, its splat, or two of them sharing each pixel's samples across a band; and, if it
// stands within the shadow map, the cut its shadow is cast at. A prop a shot has broken is drawn as clusters alone,
// at the finest cut its error bound allows: its clusters are its shards' own (the bake keeps them apart), and each
// rides its shard's flight, so no simplified surface ever spans two shards or is left where a shard has flown from.
// Every list entry is one instance of a fixed-size draw: a cluster (384 vertices, or 96 for a small one), 32 far-body
// triangles (96), or a splat (3); the unused vertices are degenerate. The view draws its four lists with one
// pipeline; the shadow map draws the other two with another.
import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS, SIM_CLOCK_LOOP_S } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_FRAME, SHADOW_SAMPLE } from './shadows.js';
import { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import {
  CITY_CONTINUUM_HEADER, CITY_CONTINUUM_TYPE_WORDS, CITY_CONTINUUM_CLUSTER_WORDS, CITY_CONTINUUM_VERTEX_WORDS, CITY_CONTINUUM_STEP_WORDS,
  CITY_CONTINUUM_TRIANGLE_WORDS, CITY_CONTINUUM_NEVER, CITY_CONTINUUM_HOPS, CITY_CONTINUUM_CHUNK_TRIANGLES, CITY_CONTINUUM_CLUSTER_TRIANGLES,
  CITY_CONTINUUM_SMALL_CLUSTER,
} from '../city-continuum.js';
import { CITY_CONTINUUM_SHADOW_TEXELS } from './city-continuum.js';
import { FRACTURE_GRAVITY } from '../ship-fracture.js';
import { PROP_CONTINUUM_TYPE, PROP_CONTINUUM_PLAIN } from '../prop-continuum.js';

// The lists an instance can be entered in, each with its own indirect draw, and the vertices of one entry.
export const PROP_CONTINUUM_LISTS = Object.freeze(['clusters', 'small clusters', 'far body', 'splat', 'shadow far body', 'shadow clusters']);
export const PROP_CONTINUUM_INSTANCE_VERTICES = Object.freeze([3 * CITY_CONTINUUM_CLUSTER_TRIANGLES, 3 * CITY_CONTINUUM_SMALL_CLUSTER, 3 * CITY_CONTINUUM_CHUNK_TRIANGLES, 3, 3 * CITY_CONTINUUM_CHUNK_TRIANGLES, 3 * CITY_CONTINUUM_CLUSTER_TRIANGLES]);
// The view's lists come first; the shadow map's are the rest.
export const PROP_CONTINUUM_VIEW_LISTS = 4;
export const PROP_CONTINUUM_DRAW_WORDS = PROP_CONTINUUM_LISTS.length * 4;
export const PROP_CONTINUUM_VIEW_BYTES = 32 + PROP_CONTINUUM_LISTS.length * 16;
// The select dispatch is laid in rows of this many workgroups, an instance to each.
export const PROP_CONTINUUM_ROW = 8192;
// An instance: where it stands (its type turned by root.w and stood at root.xyz), how it is scaled (shape.xyz) and
// whether it glows (shape.w, hot iron); then its type | flags << 16, where its block of shard records starts (in
// vec4f), how far past its type's sphere its pieces may lie (metres, f32 bits), and the seed that thins its splat.
export const PROP_CONTINUUM_INSTANCE_FLOATS = 12;
export const PROP_CONTINUUM_BROKEN = 1, PROP_CONTINUUM_GONE = 2;
// What an entry is, in the top four bits of its second word.
export const PROP_CONTINUUM_CLUSTER_ENTRY = 1, PROP_CONTINUUM_FAR_ENTRY = 2, PROP_CONTINUUM_SPLAT_ENTRY = 3;
// The coarse pigment a far body reads, this many levels above the pigment's own one-texel mean (a 32-texel square of
// a 1024 one); a splat reads the mean itself.
const PROP_CONTINUUM_FAR_PIGMENT_LEVELS = 5;

// What every pass knows of the atlas, of the instances and of a broken prop's shards.
const PROP_CONTINUUM_COMMON = /* wgsl */`
struct PropContinuumView {
  counts:vec4u,             // instances, samples a pixel, 1 when shadows are cast, unused
  scene:vec4f,              // the scene's pixel error, unused
  lists:array<vec4u,${PROP_CONTINUUM_LISTS.length}>,     // each list's first entry and capacity
};
struct PropContinuumInstance { root:vec4f, shape:vec4f, tag:vec4u };
struct PropContinuumPoint { position:vec3f, normal:vec3f, uv:vec2f };
struct PropContinuumFar { position:vec3f, normal:vec3f, uv:vec2f, shown:bool };
struct PropContinuumPose { position:vec3f, normal:vec3f, hidden:bool };
const PROP_CONTINUUM_NEVER:u32=${CITY_CONTINUUM_NEVER}u;
const PROP_CONTINUUM_PLAIN:u32=${PROP_CONTINUUM_PLAIN}u;
fn propContinuumType(archetype:u32,field:u32)->u32 { return propAtlas[propAtlas[${CITY_CONTINUUM_HEADER.typesAt}u]+archetype*${CITY_CONTINUUM_TYPE_WORDS}u+field]; }
fn propContinuumTypeF(archetype:u32,field:u32)->f32 { return bitcast<f32>(propContinuumType(archetype,field)); }
fn propContinuumBroken(inst:PropContinuumInstance)->bool { return ((inst.tag.x>>16u)&${PROP_CONTINUUM_BROKEN}u)!=0u; }
// A point of the type, in the type's own metres, stood where the instance stands.
fn propContinuumPlace(p:vec3f,inst:PropContinuumInstance)->vec3f {
  let q=p*inst.shape.xyz;
  let c=cos(inst.root.w);let s=sin(inst.root.w);
  return inst.root.xyz+vec3f(q.x*c+q.z*s,q.y,-q.x*s+q.z*c);
}
fn propContinuumTurn(n:vec3f,inst:PropContinuumInstance)->vec3f {
  let m=normalize(n/max(inst.shape.xyz,vec3f(1e-4)));
  let c=cos(inst.root.w);let s=sin(inst.root.w);
  return vec3f(m.x*c+m.z*s,m.y,-m.x*s+m.z*c);
}
// How much an instance's scale lengthens any length of its type: its errors and bounds grow by this.
fn propContinuumScale(inst:PropContinuumInstance)->f32 { return max(max(inst.shape.x,inst.shape.y),inst.shape.z); }
fn propContinuumOctahedral(e:vec2f)->vec3f {
  let f=e*2.0-1.0;
  var n=vec3f(f.x,f.y,1.0-abs(f.x)-abs(f.y));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
fn propContinuumPoint(archetype:u32,at:u32)->PropContinuumPoint {
  let w0=propAtlas[at];let w1=propAtlas[at+1u];
  let low=vec3f(propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.low}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.low + 1}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.low + 2}u));
  var p:PropContinuumPoint;
  p.position=low+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))*(propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.span}u)/65535.0);
  p.normal=propContinuumOctahedral(unpack2x16unorm(propAtlas[at+2u]));
  p.uv=unpack2x16unorm(propAtlas[at+3u]);
  return p;
}
fn propContinuumStepWord(archetype:u32,step:u32,word:u32)->u32 { return propAtlas[propContinuumType(archetype,${PROP_CONTINUUM_TYPE.steps}u)+step*${CITY_CONTINUUM_STEP_WORDS}u+word]; }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn propContinuumAncestor(archetype:u32,vertex:u32,step:u32)->u32 {
  let records=propContinuumType(archetype,${PROP_CONTINUUM_TYPE.records}u);
  var v=vertex;
  for(var hop=0u;hop<${CITY_CONTINUUM_HOPS}u;hop++){
    let record=propAtlas[records+v];
    let at=record&65535u;
    if(at==PROP_CONTINUUM_NEVER||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
// One corner of the far body at a step, on its way to where the next collapse takes it, grown along its normals by
// what the collapses have taken off the outline.
fn propContinuumFarCorner(archetype:u32,chunk:u32,vertex:u32,step:u32,morph:f32)->PropContinuumFar {
  var out:PropContinuumFar;
  let triangle=chunk*${CITY_CONTINUUM_CHUNK_TRIANGLES}u+vertex/3u;
  out.shown=triangle<propContinuumStepWord(archetype,step,0u);
  if(!out.shown){return out;}
  let at=propContinuumType(archetype,${PROP_CONTINUUM_TYPE.triangles}u)+triangle*${CITY_CONTINUUM_TRIANGLE_WORDS}u;
  out.uv=unpack2x16unorm(propAtlas[at+3u]);
  let next=min(step+1u,propContinuumType(archetype,${PROP_CONTINUUM_TYPE.stepCount}u));
  let a=propContinuumAncestor(archetype,propAtlas[at+vertex%3u],step);let b=propContinuumAncestor(archetype,a,next);
  let first=propContinuumType(archetype,${PROP_CONTINUUM_TYPE.chainVertices}u);
  let pa=propContinuumPoint(archetype,first+a*${CITY_CONTINUUM_VERTEX_WORDS}u);let pb=propContinuumPoint(archetype,first+b*${CITY_CONTINUUM_VERTEX_WORDS}u);
  let grow=mix(bitcast<f32>(propContinuumStepWord(archetype,step,2u)),bitcast<f32>(propContinuumStepWord(archetype,next,2u)),morph);
  out.position=mix(pa.position+pa.normal*grow,pb.position+pb.normal*grow,morph);
  out.normal=normalize(mix(pa.normal,pb.normal,morph));
  return out;
}
fn propContinuumRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f { return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c); }
// Where a point of a broken prop's shard is now, in the prop's own frame. Its block of the shard records is one vec4f
// whose x is the frame time at which its debris clock read zero, then four vec4f a shard as js/ship-fracture.js lays
// them out: pivot and release time, velocity and settle time, spin and the age it is hidden at, then hinge, gravity,
// sink and what holds it (-2 standing, -1 in flight, otherwise the age it stopped at).
fn propContinuumPose(records:u32,shard:u32,position:vec3f,normal:vec3f)->PropContinuumPose {
  var pose:PropContinuumPose;pose.position=position;pose.normal=normal;pose.hidden=false;
  let at=records+1u+shard*4u;
  let motion=propShards[at+3u];
  if(motion.w< -1.5){return pose;}
  let origin=propShards[at];let flight=propShards[at+1u];let spinHide=propShards[at+2u];
  // The frame clock starts again every ${SIM_CLOCK_LOOP_S} s; no flight lasts that long.
  var clock=F.camPos.w-propShards[records].x;
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
    relative=propContinuumRotate(relative,axis,ca,sa);
    pose.normal=normalize(propContinuumRotate(normal,axis,ca,sa));
  }
  pose.position=origin.xyz+relative+flight.xyz*free-vec3f(0.0,drop,0.0);
  return pose;
}
// A point of a cluster's part, carried by its shard's flight when the prop is broken.
fn propContinuumPosed(inst:PropContinuumInstance,part:u32,position:vec3f,normal:vec3f)->PropContinuumPose {
  if(!propContinuumBroken(inst)){var pose:PropContinuumPose;pose.position=position;pose.normal=normal;pose.hidden=false;return pose;}
  return propContinuumPose(inst.tag.y,part,position,normal);
}
// An instance's state for the frame, two entries ahead of the lists: handoff share | splat share << 8, step | shadow
// step << 16, then the morph and the splat's scale (f32 bits).
fn propContinuumState(instance:u32)->vec4u { let a=propLists[instance*2u];let b=propLists[instance*2u+1u];return vec4u(a.x,a.y,b.x,b.y); }
// One vertex of a cluster entry, in the type's own metres and posed with its shard; hidden past its triangles.
fn propContinuumClusterPoint(inst:PropContinuumInstance,cluster:u32,vertex:u32)->PropContinuumFar {
  var out:PropContinuumFar;
  let at=propAtlas[${CITY_CONTINUUM_HEADER.clustersAt}u]+cluster*${CITY_CONTINUUM_CLUSTER_WORDS}u;
  out.shown=vertex/3u<(propAtlas[at+15u]&255u);
  if(!out.shown){return out;}
  let v=propAtlas[propAtlas[${CITY_CONTINUUM_HEADER.indicesAt}u]+propAtlas[at+14u]+vertex];
  let p=propContinuumPoint(inst.tag.x&65535u,propAtlas[${CITY_CONTINUUM_HEADER.verticesAt}u]+v*${CITY_CONTINUUM_VERTEX_WORDS}u);
  let pose=propContinuumPosed(inst,propAtlas[at+15u]>>16u,p.position,p.normal);
  out.shown=!pose.hidden;out.position=pose.position;out.normal=pose.normal;out.uv=p.uv;
  return out;
}
`;

// The data a pass binds: the atlas, the instances, the shard records, the lists, the view.
const propContinuumData = (group, first, lists) => /* wgsl */`
@group(${group}) @binding(${first}) var<storage,read> propAtlas:array<u32>;
@group(${group}) @binding(${first + 1}) var<storage,read> propInstances:array<PropContinuumInstance>;
@group(${group}) @binding(${first + 2}) var<storage,read> propShards:array<vec4f>;
@group(${group}) @binding(${first + 3}) var<storage,${lists}> propLists:array<vec2u>;
@group(${group}) @binding(${first + 4}) var<uniform> propView:PropContinuumView;
`;
// A drawing pass names every binding of its group once, on a path never taken, so the layout it derives holds them all.
const PROP_CONTINUUM_TOUCH = /* wgsl */`
fn propContinuumBindings()->f32 {
  if(propView.counts.y!=0xffffffffu){return 0.0;}
  return f32(propAtlas[0]+propInstances[0].tag.x+propLists[0].x)+propShards[0].x;
}
struct PropContinuumEntry { @location(0) entry:vec2u };
`;

// --------------------------------------------------------------------------------------------- the cut
export function propContinuumSelectWGSL() {
  const T = PROP_CONTINUUM_TYPE;
  const typeVec4 = (archetype, field) => `vec4f(propContinuumTypeF(${archetype},${field}u),propContinuumTypeF(${archetype},${field + 1}u),propContinuumTypeF(${archetype},${field + 2}u),propContinuumTypeF(${archetype},${field + 3}u))`;
  const atlasVec4 = (at) => `vec4f(bitcast<f32>(propAtlas[${at}]),bitcast<f32>(propAtlas[${at}+1u]),bitcast<f32>(propAtlas[${at}+2u]),bitcast<f32>(propAtlas[${at}+3u]))`;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + PROP_CONTINUUM_COMMON + propContinuumData(0, 2, 'read_write') + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> SH:ShadowFrame;
@group(0) @binding(7) var<storage,read_write> propDraws:array<atomic<u32>>;
const PROP_CONTINUUM_SHADOW_TEXELS:f32=${CITY_CONTINUUM_SHADOW_TEXELS.toFixed(4)};
const PROP_CONTINUUM_FULL:u32=0xffffffffu;
// The morph search reads the steps of the type in hand.
var<private> propContinuumSteps:u32;
${continuumClusterPrefixWGSL('propContinuumPrefix', (i) => `bitcast<f32>(propAtlas[propAtlas[${CITY_CONTINUUM_HEADER.clustersAt}u]+(${i})*${CITY_CONTINUUM_CLUSTER_WORDS}u+13u])`)}
${continuumMorphStepWGSL('propContinuumMorphStep', (i) => `bitcast<f32>(propAtlas[propContinuumSteps+(${i})*${CITY_CONTINUUM_STEP_WORDS}u+1u])`)}
fn propContinuumOutside(at:vec3f,reach:f32)->bool {
  let m=F.viewProj;let p=vec4f(at,1.0);
  let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
  let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
  for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
  return false;
}
fn propContinuumAppend(list:u32,count:u32)->u32 {
  if(count==0u){return PROP_CONTINUUM_FULL;}
  let at=atomicAdd(&propDraws[list*4u+1u],count);
  if(at+count>propView.lists[list].y){atomicSub(&propDraws[list*4u+1u],count);return PROP_CONTINUUM_FULL;}
  return propView.lists[list].x+at;
}
fn propContinuumChunks(archetype:u32,step:u32)->u32 { return (propContinuumStepWord(archetype,step,0u)+${CITY_CONTINUUM_CHUNK_TRIANGLES - 1}u)/${CITY_CONTINUUM_CHUNK_TRIANGLES}u; }
fn propContinuumFocal()->f32 { return F.screen.y/max(2.0*length(F.camUp.xyz),1e-4); }
// Each list empty, its draw's vertex count set.
@compute @workgroup_size(32) fn propContinuumReset(@builtin(local_invocation_index) i:u32){
  let vertices=array<u32,${PROP_CONTINUUM_LISTS.length}>(${PROP_CONTINUUM_INSTANCE_VERTICES.map((n) => `${n}u`).join(',')});
  if(i<${PROP_CONTINUUM_DRAW_WORDS}u){atomicStore(&propDraws[i],select(0u,vertices[i/4u],i%4u==0u));}
}
var<workgroup> propSelected:array<vec4u,2>; // clusters to try, the first, where the far body's pieces go, how many; the shadow's far pieces, how many, its clusters to try, broken
var<workgroup> propSelectedView:vec4f;      // focal, allowed pixels, scale, the shadow's allowed error (metres of the type)
@compute @workgroup_size(64) fn propContinuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let instance=group.x+group.y*${PROP_CONTINUUM_ROW}u;
  if(lane==0u){
    var candidates=0u;var firstCluster=0u;var farAt=PROP_CONTINUUM_FULL;var farChunks=0u;
    var shadowAt=PROP_CONTINUUM_FULL;var shadowChunks=0u;var shadowCandidates=0u;var broken=0u;
    var focal=1.0;var pixels=1.0;var scale=1.0;var shadowAllowed=0.0;
    if(instance<propView.counts.x){
      let inst=propInstances[instance];
      let archetype=inst.tag.x&65535u;
      var share=0u;var splatShare=0u;var step=0u;var shadowStep=0u;var morph=0.0;var splatScale=0.0;
      if(((inst.tag.x>>16u)&${PROP_CONTINUUM_GONE}u)==0u){
        broken=select(0u,1u,propContinuumBroken(inst));
        scale=propContinuumScale(inst);
        let sphere=${typeVec4('archetype', T.sphere)};
        let world=propContinuumPlace(sphere.xyz,inst);
        // A broken prop's reach takes in its timber in the air and on the beach.
        let reach=sphere.w*scale+bitcast<f32>(inst.tag.z);
        let relative=world-F.camPos.xyz;
        let away=max(length(relative),1e-3);
        focal=propContinuumFocal();
        pixels=propView.scene.x;
        let steps=propContinuumType(archetype,${T.stepCount}u);
        // The far body is drawn from the first step no heavier than the clusters' coarsest cut; finer is theirs.
        let farFirst=propContinuumType(archetype,${T.farFirst}u);
        propContinuumSteps=propContinuumType(archetype,${T.steps}u);
        firstCluster=propContinuumType(archetype,${T.clusterFirst}u);
        let clusterCount=propContinuumType(archetype,${T.clusterCount}u);
        // Its shadow, cut coarse enough for the shadow map, is cast whether it is seen or not: a whole prop's far body,
        // a broken one's shards, each a cut of its own clusters.
        if(propView.counts.z!=0u){
          let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
          let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
          if(abs(light.x)<1.0+r.x&&abs(light.y)<1.0+r.y&&light.z> -r.z&&light.z<1.0+r.z){
            let allowed=max(PROP_CONTINUUM_SHADOW_TEXELS*SH.texel.x,pixels*away/focal)/scale;
            if(broken==0u){
              shadowStep=max(farFirst,u32(propContinuumMorphStep(steps,allowed).x));
              shadowChunks=propContinuumChunks(archetype,shadowStep);
              shadowAt=propContinuumAppend(4u,shadowChunks);
            }else{
              shadowAllowed=allowed;
              shadowCandidates=propContinuumPrefix(firstCluster,clusterCount,allowed);
            }
          }
        }
        if(!propContinuumOutside(earthCurve(relative,F.camPos.y),reach)){
          // A whole prop hands over from its clusters to its far body where the far body's error at its first step
          // is all the scene allows, over a band of distance; then to its splat. A broken one stays its shards.
          if(broken==0u){
            let start=bitcast<f32>(propContinuumStepWord(archetype,farFirst,1u))*scale*focal/pixels;
            share=u32(round(continuumHandoff(away,start)*255.0));
            let span=2.0*max(propContinuumTypeF(archetype,${T.splatRx}u)*0.5*(inst.shape.x+inst.shape.z),propContinuumTypeF(archetype,${T.splatRy}u)*inst.shape.y)*focal/away;
            splatShare=u32(round(continuumSplatShare(span)*255.0));
            if(share>0u){
              splatScale=continuumThin(span,inst.tag.w*0x9e3779b9u+0x85ebca6bu);
              if(splatShare>0u&&splatScale>0.0){
                let at=propContinuumAppend(3u,1u);
                if(at!=PROP_CONTINUUM_FULL){propLists[at]=vec2u(instance,${PROP_CONTINUUM_SPLAT_ENTRY}u<<28u);}
              }
              if(splatShare<255u){
                let chosen=propContinuumMorphStep(steps,pixels*away/(focal*scale));
                step=u32(chosen.x);morph=chosen.y;
                if(step<farFirst){step=farFirst;morph=0.0;}
                farChunks=propContinuumChunks(archetype,step);
                farAt=propContinuumAppend(2u,farChunks);
              }
            }
          }
          // The clusters that can be drawn at its nearest point, each tried by the lanes below.
          if(share<255u){
            candidates=propContinuumPrefix(firstCluster,clusterCount,pixels*max(away-reach,0.25)/(focal*scale));
          }
        }
      }
      propLists[instance*2u]=vec2u(share|(splatShare<<8u),step|(shadowStep<<16u));
      propLists[instance*2u+1u]=vec2u(bitcast<u32>(morph),bitcast<u32>(splatScale));
    }
    propSelected[0]=vec4u(candidates,firstCluster,farAt,farChunks);
    propSelected[1]=vec4u(shadowAt,shadowChunks,shadowCandidates,broken);
    propSelectedView=vec4f(focal,pixels,scale,shadowAllowed);
  }
  let chosen=workgroupUniformLoad(&propSelected);
  let view=propSelectedView;
  if(chosen[0].z!=PROP_CONTINUUM_FULL){for(var c=lane;c<chosen[0].w;c+=64u){propLists[chosen[0].z+c]=vec2u(instance,c|(${PROP_CONTINUUM_FAR_ENTRY}u<<28u));}}
  if(chosen[1].x!=PROP_CONTINUUM_FULL){for(var c=lane;c<chosen[1].y;c+=64u){propLists[chosen[1].x+c]=vec2u(instance,c|(${PROP_CONTINUUM_FAR_ENTRY}u<<28u));}}
  let tries=max(chosen[0].x,chosen[1].z);
  if(tries==0u){return;}
  // The clusters drawn at this instance's distance, by the core's own test, each sphere carried with its shard. A
  // shard sunk out of sight takes its clusters with it.
  let inst=propInstances[instance];
  let shift=-F.camPos.xyz;
  let clusters=propAtlas[${CITY_CONTINUUM_HEADER.clustersAt}u];
  let up=vec3f(0.0,1.0,0.0);
  for(var i=lane;i<tries;i+=64u){
    let c=chosen[0].y+i;
    let at=clusters+c*${CITY_CONTINUUM_CLUSTER_WORDS}u;
    let part=propAtlas[at+15u]>>16u;
    let lod=${atlasVec4('at')};let parent=${atlasVec4('at+4u')};let cull=${atlasVec4('at+8u')};
    let own=propContinuumPosed(inst,part,lod.xyz,up);
    if(own.hidden){continue;}
    let ownError=bitcast<f32>(propAtlas[at+12u])*view.z;let parentError=bitcast<f32>(propAtlas[at+13u])*view.z;
    if(i<chosen[0].x){
      let parentAt=propContinuumPosed(inst,part,parent.xyz,up).position;
      let cullAt=propContinuumPosed(inst,part,cull.xyz,up).position;
      if(continuumClusterDrawn(ownError,propContinuumPlace(own.position,inst)+shift,lod.w*view.z,parentError,propContinuumPlace(parentAt,inst)+shift,parent.w*view.z,view.x,view.y)
        &&!propContinuumOutside(earthCurve(propContinuumPlace(cullAt,inst)+shift,F.camPos.y),cull.w*view.z)){
        let entry=propContinuumAppend(select(0u,1u,(propAtlas[at+15u]&255u)<=${CITY_CONTINUUM_SMALL_CLUSTER}u),1u);
        if(entry!=PROP_CONTINUUM_FULL){propLists[entry]=vec2u(instance,c|(${PROP_CONTINUUM_CLUSTER_ENTRY}u<<28u));}
      }
    }
    // The shadow map's light is parallel: the same test with every sphere at unit distance under a unit focal length
    // compares errors directly against the error it allows.
    if(i<chosen[1].z&&continuumClusterDrawn(ownError,vec3f(0.0,0.0,1.0),0.0,parentError,vec3f(0.0,0.0,1.0),0.0,1.0,view.w*view.z)){
      let entry=propContinuumAppend(5u,1u);
      if(entry!=PROP_CONTINUUM_FULL){propLists[entry]=vec2u(instance,c|(${PROP_CONTINUUM_CLUSTER_ENTRY}u<<28u));}
    }
  }
}
`;
}

// --------------------------------------------------------------------------------------------- drawing
const PROP_CONTINUUM_RENDER = /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
@group(0) @binding(11) var pigment:texture_2d_array<f32>;
@group(0) @binding(12) var pigmentSampler:sampler;
const PROP_CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
struct PropContinuumVertex {
  @builtin(position) position:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) uv:vec2f,
  @location(3) @interpolate(flat) coverage:vec4u, // x the draw (1 clusters, 2 far body, 3 splat), y handoff | splat << 8, z the instance, w samples
  @location(4) @interpolate(flat) surface:vec4u,  // x its pigment's layer (PROP_CONTINUUM_PLAIN for none), y the level a far body or splat reads it at
  @location(5) @interpolate(flat) plain:vec4f,    // a plain type's albedo and roughness
  @location(6) @interpolate(flat) glow:f32,       // 1 for hot iron
};
struct PropContinuumCoverage { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
fn propContinuumHidden()->PropContinuumVertex { var out:PropContinuumVertex;out.position=PROP_CONTINUUM_HIDDEN;return out; }
fn propContinuumClip(world:vec3f)->vec4f { return F.viewProj*vec4f(earthCurve(world-F.camPos.xyz,F.camPos.y),1.0); }
@vertex fn propContinuumVS(@builtin(vertex_index) vertex:u32,listed:PropContinuumEntry)->PropContinuumVertex {
  let touched=propContinuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  let state=propContinuumState(instance);
  let inst=propInstances[instance];
  let archetype=inst.tag.x&65535u;
  let levels=f32(textureNumLevels(pigment));
  var out:PropContinuumVertex;
  var point:PropContinuumFar;
  if(what==${PROP_CONTINUUM_CLUSTER_ENTRY}u){point=propContinuumClusterPoint(inst,item,vertex);}
  else if(what==${PROP_CONTINUUM_FAR_ENTRY}u){point=propContinuumFarCorner(archetype,item,vertex,state.y&65535u,bitcast<f32>(state.z));}
  else{
    // The splat: the triangle that circumscribes the outline's ellipse, shrunk to the ellipse's own area, facing the
    // eye, and grown where it is thinned to keep the horizon's covered area.
    let local=vec3f(propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.splatCentre}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.splatCentre + 1}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.splatCentre + 2}u));
    let centre=propContinuumPlace(local,inst);
    let toward=normalize(F.camPos.xyz-centre);
    let up=normalize(vec3f(0.0,1.0,0.0)-toward*toward.y+vec3f(0.0,1e-4,0.0));
    let right=normalize(cross(up,toward));
    let k=0.7776*bitcast<f32>(state.w);
    let corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
    let rx=propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.splatRx}u)*0.5*(inst.shape.x+inst.shape.z);
    let ry=propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.splatRy}u)*inst.shape.y;
    out.world=centre+right*(corner.x*rx*k)+up*(corner.y*ry*k);
    out.normal=toward;out.uv=vec2f(0.5);
    point.shown=true;
  }
  if(!point.shown){return propContinuumHidden();}
  if(what!=${PROP_CONTINUUM_SPLAT_ENTRY}u){
    out.world=propContinuumPlace(point.position,inst);
    out.normal=propContinuumTurn(point.normal,inst);
    out.uv=point.uv;
  }
  out.world+=vec3f(touched);
  out.position=propContinuumClip(out.world);
  out.coverage=vec4u(what,state.x&65535u,instance,propView.counts.y);
  let layer=propContinuumType(archetype,${PROP_CONTINUUM_TYPE.layer}u);
  out.surface=vec4u(layer,u32(select(max(levels-1.0-${PROP_CONTINUUM_FAR_PIGMENT_LEVELS}.0,0.0),levels-1.0,what==${PROP_CONTINUUM_SPLAT_ENTRY}u)),0u,0u);
  out.plain=vec4f(propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.albedo}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.albedo + 1}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.albedo + 2}u),propContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.roughness}u));
  out.glow=inst.shape.w;
  return out;
}
// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far side the handoff's
// share and the clusters the rest; of the far side's, the splat its own share and the far body the rest. Every sample
// is drawn by exactly one of the three.
fn propContinuumMask(coverage:vec4u,pixel:vec2f)->u32 {
  let samples=clamp(coverage.w,1u,8u);
  let all=(1u<<samples)-1u;
  let seed=coverage.z*0x9e3779b9u+3u;
  let handoff=continuumSamples(f32(coverage.y&255u)/255.0,pixel,samples,seed);
  let splat=handoff&continuumSamples(f32((coverage.y>>8u)&255u)/255.0,pixel,samples,seed+7u);
  if(coverage.x==${PROP_CONTINUUM_CLUSTER_ENTRY}u){return all&~handoff;}
  if(coverage.x==${PROP_CONTINUUM_FAR_ENTRY}u){return handoff&~splat;}
  return splat;
}
// A surface's albedo: its pigment where its own clusters are drawn, a coarse level of it on a far body (whose every
// triangle carries the UV of the surface nearest it) and its one-texel mean on a splat; a plain type's own.
fn propContinuumAlbedo(v:PropContinuumVertex)->vec3f {
  let layer=select(v.surface.x,0u,v.surface.x==PROP_CONTINUUM_PLAIN);
  let fine=textureSample(pigment,pigmentSampler,v.uv,layer).rgb;
  let coarse=textureSampleLevel(pigment,pigmentSampler,v.uv,layer,f32(v.surface.y)).rgb;
  return select(select(fine,coarse,v.coverage.x!=${PROP_CONTINUUM_CLUSTER_ENTRY}u),v.plain.rgb,v.surface.x==PROP_CONTINUUM_PLAIN);
}
@fragment fn propContinuumFS(v:PropContinuumVertex,@builtin(front_facing) front:bool)->PropContinuumCoverage {
  let plain=v.surface.x==PROP_CONTINUUM_PLAIN;
  let weathered=select(1.0,0.0,plain);
  let dx=dpdx(v.world);let dy=dpdy(v.world);
  // The far body is shaded flat, each face by its own plane: its corners' normals are the wrap's, rounded over edges.
  // Clusters are open shells, lit on whichever side is seen; a splat faces the eye whichever way it is wound.
  let plane=cross(dy,dx);
  let faceted=select(v.normal,normalize(plane)*select(-1.0,1.0,dot(plane,F.camPos.xyz-v.world)>=0.0),dot(plane,plane)>1e-16);
  let shell=select(normalize(v.normal)*select(-1.0,1.0,front),normalize(v.normal),v.coverage.x==${PROP_CONTINUUM_SPLAT_ENTRY}u);
  var n=select(shell,faceted,v.coverage.x==${PROP_CONTINUUM_FAR_ENTRY}u);let sun=F.sunDir.xyz;
  let albedo=propContinuumAlbedo(v);
  let luma=dot(albedo,vec3f(0.2126,0.7152,0.0722));
  let sx=cross(dy,n);let sy=cross(n,dx);
  let det=dot(dx,sx);
  let uvFootprint=max(length(dpdx(v.uv)),length(dpdy(v.uv)));
  let bumpFilter=(1.0-smoothstep(0.015,0.08,uvFootprint))*weathered;
  let propBump=luma*0.0045*bumpFilter;
  let propGrad=(dpdx(propBump)*sx+dpdy(propBump)*sy)/max(abs(det),0.000001)*sign(det);
  n=normalize(n-clamp(propGrad,vec3f(-0.26),vec3f(0.26)));
  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS - 1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-.65,n.z)),${ENV_MIPS - 1}.0).rgb;
  let view=normalize(F.camPos.xyz-v.world);
  // Timber by the tide: cavity shade, the waterline darkened, edges worn pale where hawsers chafe. Iron in the air
  // wears none of it.
  let tidalWet=(1.0-smoothstep(0.05,1.45,v.world.y))*weathered;
  let curvature=clamp(length(fwidth(n))*0.42*bumpFilter,0.0,1.0);
  let cavityAO=mix(1.0,clamp(0.72+0.28*smoothstep(0.08,0.52,luma)-0.16*tidalWet,0.52,1.0),weathered);
  let edgeChafe=curvature*smoothstep(0.35,1.65,v.world.y)*0.12;
  let weatheredAlbedo=clamp(albedo*cavityAO+vec3f(0.11,0.09,0.07)*edgeChafe,vec3f(0.02),vec3f(0.95));
  let rough=clamp(select(0.90-luma*0.18-tidalWet*0.18+edgeChafe*0.10,v.plain.w,plain),0.44,0.92);let f0=vec3f(.04);let spec=vesselSpecular(n,view,sun,rough,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS - 1}.0).rgb;
  let col=lunarSurface(n,view,weatheredAlbedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,weatheredAlbedo,rough)+gunFlashSurface(v.world,n,view,weatheredAlbedo,rough)+worldFireSurface(v.world,n,view,weatheredAlbedo,rough)
    +weatheredAlbedo*(direct*max(dot(n,sun),0.0)/PI+vesselAmbient(n,sky,sea))+direct*spec*max(dot(n,sun),0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  // Hot shot glows from within, brightest where its face turns to the eye.
  let core=clamp(dot(n,view),0.0,1.0);
  let hot=mix(vec3f(1.6,0.25,0.025),vec3f(3.8,0.95,0.12),core*core)*min(1.0,1.35/max(F.post.x,1e-3));
  var out:PropContinuumCoverage;
  out.colour=vec4f(surfaceAir(select(col,hot,v.glow>0.5),v.world),1.0);
  out.mask=propContinuumMask(v.coverage,v.position.xy);
  return out;
}
`;

// The view's module: lit as the ships are, with the land's shadow map (group 1), its data group 2.
export function propContinuumRenderWGSL() {
  return FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + SHADOW_SAMPLE + SKY_RENDER_FUNCS + CONTINUUM_CORE_WGSL + PROP_CONTINUUM_COMMON
    + propContinuumData(2, 0, 'read') + PROP_CONTINUUM_TOUCH + PROP_CONTINUUM_RENDER;
}

// The shadow map's module: a whole prop's far body at the step the cut chose for its shadow, unmorphed, and a broken
// one's shards at their own cut, each where its flight has it.
export function propContinuumShadowWGSL() {
  return FRAME_WGSL + SHADOW_FRAME + PROP_CONTINUUM_COMMON + propContinuumData(1, 0, 'read') + PROP_CONTINUUM_TOUCH + /* wgsl */`
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@group(0) @binding(1) var<uniform> F:Frame;
@vertex fn propContinuumShadowVS(@builtin(vertex_index) vertex:u32,listed:PropContinuumEntry)->@builtin(position) vec4f {
  let touched=propContinuumBindings();
  let instance=listed.entry.x;let item=listed.entry.y&0x0fffffffu;
  let inst=propInstances[instance];
  var point:PropContinuumFar;
  if((listed.entry.y>>28u)==${PROP_CONTINUUM_FAR_ENTRY}u){point=propContinuumFarCorner(inst.tag.x&65535u,item,vertex,propContinuumState(instance).y>>16u,0.0);}
  else{point=propContinuumClusterPoint(inst,item,vertex);}
  if(!point.shown){return vec4f(2.0,2.0,0.0,1.0);}
  let world=propContinuumPlace(point.position,inst)+vec3f(touched);
  return SH.lightView*vec4f(world-SH.origin.xyz,1.0);
}
`;
}
