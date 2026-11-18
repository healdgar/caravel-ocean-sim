// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one cut (AGENTS.md rule 3) and the one pipeline family it is drawn by. Every family's instances are records of
// one format, of types in an atlas of one format (js/continuum-format.js), posed by their kind
// (js/wgsl/continuum-kinds.js); this reads them, chooses each frame how each is drawn, and composes every program that
// draws them: the select, the shadow map's, and for each family's material its view and its under-water capture. A
// family brings a material (how its surface is worn and lit) and its records, never its own selection, handoff or
// budget, and no shader here is made by rewriting another.
//
// One workgroup an instance decides each frame how it is drawn: clusters of its type cut by projected error, its far
// body at one step of its collapse, its splat, or two of them sharing each pixel's samples across a band; and, if it
// stands within the shadow map, the cut its shadow is cast at. One drawn as clusters alone (broken, shattered, damaged,
// exact, or a body of pieces) is cut at the finest its error bound allows: a type's clusters are its parts' own, so no
// simplified surface spans two parts, and each rides its part's pose. Every list entry is one instance of a fixed-size
// draw: a cluster (384 vertices, or 96 for a small one), 32 far-body triangles (96), or a splat (3); the unused vertices
// are degenerate, and the select counts the real triangles it lists for the census (js/continuum-census.js).
import { FRAME_WGSL } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_CORE_WGSL, CONTINUUM_STEP_WORDS, CONTINUUM_HOPS, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import {
  CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_CLUSTER_WORDS, CONTINUUM_VERTEX_WORDS, CONTINUUM_TRIANGLE_WORDS, CONTINUUM_NEVER,
  CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_CLUSTER_TRIANGLES, CONTINUUM_SMALL_CLUSTER, CONTINUUM_LISTS, CONTINUUM_ENTRY_TRIANGLES, CONTINUUM_VIEW_LISTS,
  CONTINUUM_TYPE_PIECES, CONTINUUM_TYPE_DETAIL_SHIFT, CONTINUUM_KIND_SHIFT, CONTINUUM_GONE, CONTINUUM_STRUCK, CONTINUUM_BROKEN, CONTINUUM_EXACT, CONTINUUM_SEA,
  CONTINUUM_IMPORTANT_FLAG, CONTINUUM_SHATTERED, CONTINUUM_DAMAGED, CONTINUUM_STRETCHED, CONTINUUM_STREAMS, CONTINUUM_SURFACE_RANGE,
  CONTINUUM_CLUSTER_ENTRY, CONTINUUM_FAR_ENTRY, CONTINUUM_SPLAT_ENTRY,
} from '../continuum-format.js';
import { continuumKindsWGSL } from './continuum-kinds.js';
import { CONTINUUM_GROUNDED, continuumGroundWGSL } from '../continuum-ground.js';

// The vertices of one entry of each list.
export const CONTINUUM_ENTRY_VERTICES = Object.freeze(CONTINUUM_ENTRY_TRIANGLES.map((n) => 3 * n));
// The draws buffer: each list's indirect draw (four words), then the real triangles listed in each of the view's lists.
export const CONTINUUM_DRAW_WORDS = CONTINUUM_LISTS.length * 4;
export const CONTINUUM_DRAWS_BYTES = (CONTINUUM_DRAW_WORDS + CONTINUUM_VIEW_LISTS) * 4;
export const CONTINUUM_VIEW_BYTES = 32 + CONTINUUM_LISTS.length * 16 + 16;
// The select dispatch is laid in rows of this many workgroups, an instance to each.
export const CONTINUUM_ROW = 8192;
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
export const CONTINUUM_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// How many shadow-map texels a shadow's cut may be in error.
export const CONTINUUM_SHADOW_TEXELS = 1.5;
const continuumStream = (name) => CONTINUUM_STREAMS.find((s) => s.name === name);

// An instance's record and its flags, for any pass that reads or writes records (a family's own pose pass too).
export const CONTINUUM_RECORD_WGSL = /* wgsl */`
// place: position and scale; turn: a unit quaternion; tag: type | kind << ${CONTINUUM_KIND_SHIFT} | flags, pose (vec4f), seed,
// reach (f32 bits); spare: identity, phase, motion, furl (its family's own).
struct ContinuumRecord { place:vec4f, turn:vec4f, tag:vec4u, spare:vec4u };
const CONTINUUM_GONE:u32=${CONTINUUM_GONE >>> 0}u;
const CONTINUUM_STRUCK:u32=${CONTINUUM_STRUCK >>> 0}u;
const CONTINUUM_BROKEN:u32=${CONTINUUM_BROKEN >>> 0}u;
const CONTINUUM_EXACT:u32=${CONTINUUM_EXACT >>> 0}u;
const CONTINUUM_SEA:u32=${CONTINUUM_SEA >>> 0}u;
const CONTINUUM_IMPORTANT_FLAG:u32=${CONTINUUM_IMPORTANT_FLAG >>> 0}u;
const CONTINUUM_SHATTERED:u32=${CONTINUUM_SHATTERED >>> 0}u;
const CONTINUUM_DAMAGED:u32=${CONTINUUM_DAMAGED >>> 0}u;
const CONTINUUM_STRETCHED:u32=${CONTINUUM_STRETCHED >>> 0}u;
const CONTINUUM_GROUNDED:u32=${CONTINUUM_GROUNDED >>> 0}u;
const CONTINUUM_KIND_SHIFT:u32=${CONTINUUM_KIND_SHIFT}u;
`;

// What every pass knows of the atlas, the records and the pose buffer. Written when a module is, not as the bundle
// loads: the kinds read constants that load later.
const continuumCommonWGSL = () => CONTINUUM_RECORD_WGSL + /* wgsl */`
struct ContinuumView {
  counts:vec4u,             // instances, samples a pixel, 1 when shadows are cast, unused
  scene:vec4f,              // the scene's pixel error, the world's offset x and z, unused
  lists:array<vec4u,${CONTINUUM_LISTS.length}>,     // each list's first entry and room
  aim:vec4f,                // where the player's guns would fall, in the scene's frame, and how far about it (0: none)
};
struct ContinuumPoint { position:vec3f, normal:vec3f, high:u32, word:u32 };
// A point as its kind poses it, in its type's own metres; wear (0 to ${CONTINUUM_SURFACE_RANGE}) how worn it is.
struct ContinuumPosed { position:vec3f, normal:vec3f, wear:f32, hidden:bool };
// One corner of an entry: posed, its material's words, the atlas vertex its side streams are read by.
struct ContinuumCorner { posed:ContinuumPosed, high:u32, word:u32, vertex:u32, shown:bool };
const CONTINUUM_NEVER:u32=${CONTINUUM_NEVER}u;
const CONTINUUM_WHOLE:u32=0xffffffffu;
const CONTINUUM_NO_VERTEX:u32=0xffffffffu;
const CONTINUUM_CLUSTER_ENTRY:u32=${CONTINUUM_CLUSTER_ENTRY}u;
const CONTINUUM_FAR_ENTRY:u32=${CONTINUUM_FAR_ENTRY}u;
const CONTINUUM_SPLAT_ENTRY:u32=${CONTINUUM_SPLAT_ENTRY}u;
fn continuumTypeOf(record:ContinuumRecord)->u32 { return record.tag.x&65535u; }
fn continuumKindOf(record:ContinuumRecord)->u32 { return (record.tag.x>>CONTINUUM_KIND_SHIFT)&15u; }
fn continuumFlagged(record:ContinuumRecord,flags:u32)->bool { return (record.tag.x&flags)!=0u; }
// A STRETCHED instance's stretch along its type's axes, and the shear of its y along z; (1, 1, 1, 0) for the rest.
fn continuumStretch(record:ContinuumRecord)->vec4f { return select(vec4f(1.0,1.0,1.0,0.0),continuumPoses[record.tag.y],continuumFlagged(record,CONTINUUM_STRETCHED)); }
// Where its kind's pose data begins, past its stretch.
fn continuumKindData(record:ContinuumRecord)->u32 { return record.tag.y+select(0u,1u,continuumFlagged(record,CONTINUUM_STRETCHED)); }
// A vector turned by a unit quaternion.
fn continuumQuat(q:vec4f,v:vec3f)->vec3f { let t=2.0*cross(q.xyz,v);return v+q.w*t+cross(q.xyz,t); }
// A point of its type, in the type's own metres and posed, stood where the instance stands (in the scene's frame,
// without the world's offset): stretched and sheared, grown by its scale, turned, and stood at its position.
fn continuumPlace(record:ContinuumRecord,p:vec3f)->vec3f {
  let stretch=continuumStretch(record);let s=p*stretch.xyz;
  return record.place.xyz+continuumQuat(record.turn,vec3f(s.x,s.y+s.z*stretch.w,s.z)*record.place.w);
}
fn continuumTurnNormal(record:ContinuumRecord,n:vec3f)->vec3f {
  let stretch=continuumStretch(record);let b=n/max(stretch.xyz,vec3f(1e-3));
  return continuumQuat(record.turn,normalize(vec3f(b.x,b.y,b.z-stretch.w*b.y)));
}
// How much its placing can lengthen any length of its type: its errors and bounds grow by this.
fn continuumScale(record:ContinuumRecord)->f32 { let s=continuumStretch(record);return record.place.w*max(max(s.x,s.y),s.z)*(1.0+abs(s.w)); }
// Its heading: the bearing its turn gives its type's +x, about the vertical.
fn continuumYaw(record:ContinuumRecord)->f32 { let x=continuumQuat(record.turn,vec3f(1.0,0.0,0.0));return atan2(-x.z,x.x); }
fn continuumType(model:u32,field:u32)->u32 { return continuumAtlas[continuumAtlas[${CONTINUUM_HEADER.typesAt}u]+model*${CONTINUUM_TYPE_WORDS}u+field]; }
fn continuumTypeF(model:u32,field:u32)->f32 { return bitcast<f32>(continuumType(model,field)); }
fn continuumOctahedral(e:vec2f)->vec3f {
  let f=e*2.0-1.0;
  var n=vec3f(f.x,f.y,1.0-abs(f.x)-abs(f.y));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
// Atlas vertex 'vertex' of its type.
fn continuumPointAt(model:u32,vertex:u32)->ContinuumPoint {
  let at=continuumAtlas[${CONTINUUM_HEADER.verticesAt}u]+vertex*${CONTINUUM_VERTEX_WORDS}u;
  let w0=continuumAtlas[at];let w1=continuumAtlas[at+1u];
  let low=vec3f(continuumTypeF(model,${CONTINUUM_TYPE.low}u),continuumTypeF(model,${CONTINUUM_TYPE.low + 1}u),continuumTypeF(model,${CONTINUUM_TYPE.low + 2}u));
  var p:ContinuumPoint;
  p.position=low+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))*(continuumTypeF(model,${CONTINUUM_TYPE.span}u)/65535.0);
  p.normal=continuumOctahedral(unpack2x16unorm(continuumAtlas[at+2u]));
  p.high=w1>>16u;p.word=continuumAtlas[at+3u];
  return p;
}
// Word k of a side stream for atlas vertex 'vertex' (the header field of the stream's start, its bit, its words a
// vertex); 0 where the atlas carries none, or for a vertex of a body that had none.
fn continuumStreamWord(field:u32,bit:u32,words:u32,vertex:u32,k:u32)->u32 {
  if(vertex==CONTINUUM_NO_VERTEX||(continuumAtlas[${CONTINUUM_HEADER.streams}u]&bit)==0u){return 0u;}
  return continuumAtlas[continuumAtlas[field]+vertex*words+k];
}
fn continuumUV(vertex:u32)->vec2f { return unpack2x16unorm(continuumStreamWord(${CONTINUUM_HEADER.uv}u,${continuumStream('uv').bit}u,${continuumStream('uv').words}u,vertex,0u)); }
// How raw a face is (a cut through stone or timber) and how scorched, from its surface stream.
fn continuumSurfaceWear(vertex:u32)->f32 {
  let word=continuumStreamWord(${CONTINUUM_HEADER.surface}u,${continuumStream('surface').bit}u,${continuumStream('surface').words}u,vertex,0u);
  return max(f32(word&255u),f32((word>>8u)&255u))/255.0*${CONTINUUM_SURFACE_RANGE.toFixed(4)};
}
fn continuumStepWord(model:u32,step:u32,word:u32)->u32 { return continuumAtlas[continuumType(model,${CONTINUUM_TYPE.steps}u)+step*${CONTINUUM_STEP_WORDS}u+word]; }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn continuumAncestor(model:u32,vertex:u32,step:u32)->u32 {
  let records=continuumType(model,${CONTINUUM_TYPE.records}u);
  var v=vertex;
  for(var hop=0u;hop<${CONTINUUM_HOPS}u;hop++){
    let record=continuumAtlas[records+v];
    let at=record&65535u;
    if(at==CONTINUUM_NEVER||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
fn continuumUnposed(position:vec3f,normal:vec3f)->ContinuumPosed { var p:ContinuumPosed;p.position=position;p.normal=normal;p.wear=0.0;p.hidden=false;return p; }
// One corner of the far body at a step, on its way to where the next collapse takes it, grown along its normals by
// what the collapses have taken off the outline, then posed. Its word is its triangle's.
fn continuumFarCorner(record:ContinuumRecord,model:u32,chunk:u32,vertex:u32,step:u32,morph:f32)->ContinuumCorner {
  var out:ContinuumCorner;
  let triangle=chunk*${CONTINUUM_CHUNK_TRIANGLES}u+vertex/3u;
  out.shown=triangle<continuumStepWord(model,step,0u);
  if(!out.shown){return out;}
  let at=continuumType(model,${CONTINUUM_TYPE.triangles}u)+triangle*${CONTINUUM_TRIANGLE_WORDS}u;
  out.word=continuumAtlas[at+3u];
  let next=min(step+1u,continuumType(model,${CONTINUUM_TYPE.stepCount}u));
  let a=continuumAncestor(model,continuumAtlas[at+vertex%3u],step);let b=continuumAncestor(model,a,next);
  let first=continuumType(model,${CONTINUUM_TYPE.chainVertices}u);
  let pa=continuumPointAt(model,first+a);let pb=continuumPointAt(model,first+b);
  let grow=mix(bitcast<f32>(continuumStepWord(model,step,2u)),bitcast<f32>(continuumStepWord(model,next,2u)),morph);
  out.vertex=first+a;
  out.posed=continuumPose(record,0u,out.vertex,continuumUnposed(mix(pa.position+pa.normal*grow,pb.position+pb.normal*grow,morph),normalize(mix(pa.normal,pb.normal,morph))));
  out.shown=!out.posed.hidden;
  return out;
}
// One corner of a cluster entry, posed with its cluster's part; hidden past its triangles.
fn continuumClusterCorner(record:ContinuumRecord,cluster:u32,vertex:u32)->ContinuumCorner {
  var out:ContinuumCorner;
  let at=continuumAtlas[${CONTINUUM_HEADER.clustersAt}u]+cluster*${CONTINUUM_CLUSTER_WORDS}u;
  out.shown=vertex/3u<(continuumAtlas[at+15u]&255u);
  if(!out.shown){return out;}
  out.vertex=continuumAtlas[continuumAtlas[${CONTINUUM_HEADER.indicesAt}u]+continuumAtlas[at+14u]+vertex];
  let p=continuumPointAt(continuumTypeOf(record),out.vertex);
  out.high=p.high;out.word=p.word;
  out.posed=continuumPose(record,continuumAtlas[at+15u]>>16u,out.vertex,continuumUnposed(p.position,p.normal));
  out.shown=!out.posed.hidden;
  return out;
}
// An instance's state for the frame, two entries ahead of the lists: handoff share | splat share << 8 | the view's
// ground lift << 16 (f16), step | shadow step << 16, then the morph (f32 bits) and the splat's scale | the captures'
// ground lift << 16 (two f16).
fn continuumState(instance:u32)->vec4u { let a=continuumLists[instance*2u];let b=continuumLists[instance*2u+1u];return vec4u(a.x,a.y,b.x,b.y); }
// How far a GROUNDED instance is raised to the ground the land draws: by the view's cut, or (coarse) the captures'.
fn continuumLift(state:vec4u,coarse:bool)->vec3f { return vec3f(0.0,select(unpack2x16float(state.x>>16u).x,unpack2x16float(state.w).y,coarse),0.0); }
fn continuumShift()->vec3f { return vec3f(continuumView.scene.y,0.0,continuumView.scene.z); }
`;

// The data a pass binds, in this order from `first`: the atlas, the records, the lists, the view, the pose buffer.
export const CONTINUUM_DATA_BINDINGS = 5;
// Where the select reads the land's ground field (js/continuum-ground.js): group 0, past the frame, the data and the
// draws.
export const CONTINUUM_GROUND_BINDING = 8;
const continuumDataWGSL = (group, first, lists) => /* wgsl */`
@group(${group}) @binding(${first}) var<storage,read> continuumAtlas:array<u32>;
@group(${group}) @binding(${first + 1}) var<storage,read> continuumRecords:array<ContinuumRecord>;
@group(${group}) @binding(${first + 2}) var<storage,${lists}> continuumLists:array<vec2u>;
@group(${group}) @binding(${first + 3}) var<uniform> continuumView:ContinuumView;
@group(${group}) @binding(${first + 4}) var<storage,read> continuumPoses:array<vec4f>;
`;
// A drawing pass names every binding of its group once, on a path never taken, so the layout it derives holds them all.
const CONTINUUM_TOUCH = /* wgsl */`
fn continuumBindings()->f32 {
  if(continuumView.counts.y!=0xffffffffu){return 0.0;}
  return f32(continuumAtlas[0]+continuumRecords[0].tag.x+continuumLists[0].x)+continuumPoses[0].x;
}
struct ContinuumEntry { @location(0) entry:vec2u };
const CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
`;

// --------------------------------------------------------------------------------------------- the select
export function continuumSelectWGSL() {
  const sphereOf = (type) => `vec4f(continuumTypeF(${type},${CONTINUUM_TYPE.sphere}u),continuumTypeF(${type},${CONTINUUM_TYPE.sphere + 1}u),continuumTypeF(${type},${CONTINUUM_TYPE.sphere + 2}u),continuumTypeF(${type},${CONTINUUM_TYPE.sphere + 3}u))`;
  const atlasVec4 = (at) => `vec4f(bitcast<f32>(continuumAtlas[${at}]),bitcast<f32>(continuumAtlas[${at}+1u]),bitcast<f32>(continuumAtlas[${at}+2u]),bitcast<f32>(continuumAtlas[${at}+3u]))`;
  const alone = CONTINUUM_BROKEN | CONTINUUM_SHATTERED | CONTINUUM_DAMAGED | CONTINUUM_EXACT;
  const important = CONTINUUM_IMPORTANT_FLAG | CONTINUUM_STRUCK | CONTINUUM_BROKEN | CONTINUUM_DAMAGED | CONTINUUM_SHATTERED;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + continuumDataWGSL(0, 2, 'read_write') + continuumCommonWGSL() + continuumKindsWGSL()
    + continuumGroundWGSL(0, CONTINUUM_GROUND_BINDING) + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> SH:ShadowFrame;
@group(0) @binding(7) var<storage,read_write> continuumDraws:array<atomic<u32>>;
const CONTINUUM_SHADOW_TEXELS:f32=${CONTINUUM_SHADOW_TEXELS.toFixed(4)};
const CONTINUUM_FULL:u32=0xffffffffu;
// The morph search reads the steps of the type in hand.
var<private> continuumStepsAt:u32;
${continuumClusterPrefixWGSL('continuumPrefix', (i) => `bitcast<f32>(continuumAtlas[continuumAtlas[${CONTINUUM_HEADER.clustersAt}u]+(${i})*${CONTINUUM_CLUSTER_WORDS}u+13u])`)}
${continuumMorphStepWGSL('continuumMorphStep', (i) => `bitcast<f32>(continuumAtlas[continuumStepsAt+(${i})*${CONTINUUM_STEP_WORDS}u+1u])`)}
fn continuumOutside(at:vec3f,reach:f32)->bool {
  let m=F.viewProj;let p=vec4f(at,1.0);
  let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
  let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
  for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
  return false;
}
fn continuumAppend(list:u32,count:u32)->u32 {
  if(count==0u){return CONTINUUM_FULL;}
  let at=atomicAdd(&continuumDraws[list*4u+1u],count);
  if(at+count>continuumView.lists[list].y){atomicSub(&continuumDraws[list*4u+1u],count);return CONTINUUM_FULL;}
  return continuumView.lists[list].x+at;
}
fn continuumChunks(model:u32,step:u32)->u32 { return (continuumStepWord(model,step,0u)+${CONTINUUM_CHUNK_TRIANGLES - 1}u)/${CONTINUUM_CHUNK_TRIANGLES}u; }
fn continuumFocal()->f32 { return F.screen.y/max(2.0*length(F.camUp.xyz),1e-4); }
// Each list empty, its draw's vertex count set, and the triangles counted cleared.
@compute @workgroup_size(32) fn continuumReset(@builtin(local_invocation_index) i:u32){
  let vertices=array<u32,${CONTINUUM_LISTS.length}>(${CONTINUUM_ENTRY_VERTICES.map((n) => `${n}u`).join(',')});
  if(i<${CONTINUUM_DRAW_WORDS + CONTINUUM_VIEW_LISTS}u){atomicStore(&continuumDraws[i],select(0u,vertices[min(i/4u,${CONTINUUM_LISTS.length - 1}u)],i%4u==0u&&i<${CONTINUUM_DRAW_WORDS}u));}
}
var<workgroup> continuumSelected:array<vec4u,2>; // clusters to try, the first, where the far body's pieces go, how many; the shadow's far pieces, how many, its clusters to try, its detail clusters
var<workgroup> continuumSelectedView:vec4f;      // focal, allowed pixels, scale, the shadow's allowed error (metres of the type)
var<workgroup> continuumSelectedLift:f32;        // how far it is raised to the view's drawn ground
var<workgroup> continuumCounted:array<atomic<u32>,${CONTINUUM_VIEW_LISTS}>; // real triangles listed in each of the view's lists
@compute @workgroup_size(64) fn continuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let instance=group.x+group.y*${CONTINUUM_ROW}u;
  if(lane==0u){
    var candidates=0u;var firstCluster=0u;var farAt=CONTINUUM_FULL;var farChunks=0u;
    var shadowAt=CONTINUUM_FULL;var shadowChunks=0u;var shadowCandidates=0u;var detail=0u;
    var focal=1.0;var pixels=1.0;var scale=1.0;var shadowAllowed=0.0;var lift=vec2f(0.0);
    if(instance<continuumView.counts.x){
      let record=continuumRecords[instance];
      let model=continuumTypeOf(record);
      var share=0u;var splatShare=0u;var step=0u;var shadowStep=0u;var morph=0.0;var splatScale=0.0;
      // Its kind bounds the whole of it; one gone, or posed wholly out of sight, is not drawn here at all.
      let bound=continuumSphere(record,CONTINUUM_WHOLE,${sphereOf('model')});
      if(!continuumFlagged(record,CONTINUUM_GONE)&&bound.w>=0.0){
        // Broken, shattered, damaged, exact, or a body of pieces: clusters alone, no simplified surface across parts.
        let alone=continuumFlagged(record,${alone >>> 0}u)||(continuumType(model,${CONTINUUM_TYPE.flags}u)&${CONTINUUM_TYPE_PIECES}u)!=0u;
        scale=continuumScale(record);
        // One that stands on the land stands on the ground the land draws (js/continuum-ground.js), raised at its
        // anchor before it is culled: by the view's cut, and by the captures' for the coarse cut drawn under water.
        if(continuumFlagged(record,CONTINUUM_GROUNDED)){
          let anchor=(record.place.xyz+continuumShift()).xz;
          lift=vec2f(continuumGroundLift(anchor),continuumGroundLiftCut(anchor,1u));
        }
        let world=continuumPlace(record,bound.xyz)+vec3f(0.0,lift.x,0.0);
        // Its reach takes in whatever of it its kind carries past its type's sphere (pieces in the air, a limb).
        let reach=bound.w*scale+bitcast<f32>(record.tag.w);
        let relative=world+continuumShift()-F.camPos.xyz;
        let away=max(length(relative),1e-3);
        focal=continuumFocal();
        // One important, struck, broken, wounded, or within the fall of the player's guns is cut finer (rule 3, item
        // 5); one exact, at its finest.
        let aim=continuumView.aim;
        let aimed=aim.w>0.0&&length(relative+F.camPos.xyz-aim.xyz)<=reach+aim.w;
        pixels=select(continuumImportance(continuumView.scene.x,aimed||continuumFlagged(record,${important >>> 0}u)),0.0,continuumFlagged(record,CONTINUUM_EXACT));
        let steps=continuumType(model,${CONTINUUM_TYPE.stepCount}u);
        // The far body is drawn from the first step no heavier than the clusters' coarsest cut; finer is theirs.
        let farFirst=continuumType(model,${CONTINUUM_TYPE.farFirst}u);
        continuumStepsAt=continuumType(model,${CONTINUUM_TYPE.steps}u);
        firstCluster=continuumType(model,${CONTINUUM_TYPE.clusterFirst}u);
        let clusterCount=continuumType(model,${CONTINUUM_TYPE.clusterCount}u);
        // Its detail layer: its leading clusters, cast and seen under water with its coarse cut, whole or not.
        detail=min(continuumType(model,${CONTINUUM_TYPE.flags}u)>>${CONTINUUM_TYPE_DETAIL_SHIFT}u,clusterCount);
        // Its shadow, cut coarse enough for the shadow map, is cast whether it is seen or not: the far body of one
        // drawn whole, the clusters of one drawn alone, each a cut of its own.
        if(continuumView.counts.z!=0u){
          let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
          let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
          if(abs(light.x)<1.0+r.x&&abs(light.y)<1.0+r.y&&light.z> -r.z&&light.z<1.0+r.z){
            let allowed=max(CONTINUUM_SHADOW_TEXELS*SH.texel.x,pixels*away/focal)/scale;
            if(!alone){
              shadowStep=max(farFirst,u32(continuumMorphStep(steps,allowed).x));
              shadowChunks=continuumChunks(model,shadowStep);
              shadowAt=continuumAppend(4u,shadowChunks);
              shadowCandidates=detail;
            }else{
              shadowAllowed=allowed;
              shadowCandidates=continuumPrefix(firstCluster,clusterCount,allowed);
            }
          }
        }
        // Afloat, the earth's curve does not bend it: the sea's own surface is drawn flat about the eye.
        let sea=continuumFlagged(record,CONTINUUM_SEA);
        if(!continuumOutside(select(earthCurve(relative,F.camPos.y),relative,sea),reach)){
          // One drawn whole hands over from its clusters to its far body where the far body's error at its first step
          // is all the scene allows, over a band of distance; then to its splat.
          if(!alone){
            let start=bitcast<f32>(continuumStepWord(model,farFirst,1u))*scale*focal/pixels;
            share=u32(round(continuumHandoff(away,start)*255.0));
            let stretch=continuumStretch(record);
            let span=2.0*max(continuumTypeF(model,${CONTINUUM_TYPE.splatRx}u)*0.5*(stretch.x+stretch.z),continuumTypeF(model,${CONTINUUM_TYPE.splatRy}u)*stretch.y)*record.place.w*focal/away;
            splatShare=u32(round(continuumSplatShare(span)*255.0));
            if(share>0u){
              splatScale=continuumThin(span,record.tag.z*0x9e3779b9u+0x85ebca6bu);
              if(splatShare>0u&&splatScale>0.0){
                let at=continuumAppend(3u,1u);
                if(at!=CONTINUUM_FULL){continuumLists[at]=vec2u(instance,CONTINUUM_SPLAT_ENTRY<<28u);atomicAdd(&continuumCounted[3],1u);}
              }
              if(splatShare<255u){
                let chosen=continuumMorphStep(steps,pixels*away/(focal*scale));
                step=u32(chosen.x);morph=chosen.y;
                if(step<farFirst){step=farFirst;morph=0.0;}
                farChunks=continuumChunks(model,step);
                farAt=continuumAppend(2u,farChunks);
                if(farAt!=CONTINUUM_FULL){atomicAdd(&continuumCounted[2],continuumStepWord(model,step,0u));}
              }
            }
          }
          // The clusters that can be drawn at its nearest point, each tried by the lanes below.
          if(share<255u){
            candidates=continuumPrefix(firstCluster,clusterCount,pixels*max(away-reach,0.25)/(focal*scale));
          }
        }
      }
      continuumLists[instance*2u]=vec2u(share|(splatShare<<8u)|(pack2x16float(vec2f(lift.x,0.0))<<16u),step|(shadowStep<<16u));
      continuumLists[instance*2u+1u]=vec2u(bitcast<u32>(morph),pack2x16float(vec2f(splatScale,lift.y)));
    }
    continuumSelected[0]=vec4u(candidates,firstCluster,farAt,farChunks);
    continuumSelected[1]=vec4u(shadowAt,shadowChunks,shadowCandidates,detail);
    continuumSelectedView=vec4f(focal,pixels,scale,shadowAllowed);
    continuumSelectedLift=lift.x;
  }
  let chosen=workgroupUniformLoad(&continuumSelected);
  let view=continuumSelectedView;
  if(chosen[0].z!=CONTINUUM_FULL){for(var c=lane;c<chosen[0].w;c+=64u){continuumLists[chosen[0].z+c]=vec2u(instance,c|(CONTINUUM_FAR_ENTRY<<28u));}}
  if(chosen[1].x!=CONTINUUM_FULL){for(var c=lane;c<chosen[1].y;c+=64u){continuumLists[chosen[1].x+c]=vec2u(instance,c|(CONTINUUM_FAR_ENTRY<<28u));}}
  // The clusters drawn at this instance's distance, by the core's own test, each sphere where its part's pose has it,
  // those in view entered in the list for their size. A part posed out of sight takes its clusters with it.
  let tries=max(chosen[0].x,chosen[1].z);
  if(tries>0u){
    let record=continuumRecords[instance];
    let shift=continuumShift()-F.camPos.xyz+vec3f(0.0,continuumSelectedLift,0.0);
    let sea=continuumFlagged(record,CONTINUUM_SEA);
    let clusters=continuumAtlas[${CONTINUUM_HEADER.clustersAt}u];
    for(var i=lane;i<tries;i+=64u){
      let c=chosen[0].y+i;
      let at=clusters+c*${CONTINUUM_CLUSTER_WORDS}u;
      let part=continuumAtlas[at+15u]>>16u;let triangles=continuumAtlas[at+15u]&255u;
      let lod=continuumSphere(record,part,${atlasVec4('at')});
      if(lod.w<0.0){continue;}
      let ownError=bitcast<f32>(continuumAtlas[at+12u])*view.z;let parentError=bitcast<f32>(continuumAtlas[at+13u])*view.z;
      if(i<chosen[0].x){
        let parent=continuumSphere(record,part,${atlasVec4('at+4u')});let cull=continuumSphere(record,part,${atlasVec4('at+8u')});
        let cullAt=continuumPlace(record,cull.xyz)+shift;
        if(continuumClusterDrawn(ownError,continuumPlace(record,lod.xyz)+shift,lod.w*view.z,parentError,continuumPlace(record,parent.xyz)+shift,parent.w*view.z,view.x,view.y)
          &&!continuumOutside(select(earthCurve(cullAt,F.camPos.y),cullAt,sea),cull.w*view.z)){
          let small=select(0u,1u,triangles<=${CONTINUUM_SMALL_CLUSTER}u);
          let entry=continuumAppend(small,1u);
          if(entry!=CONTINUUM_FULL){continuumLists[entry]=vec2u(instance,c|(CONTINUUM_CLUSTER_ENTRY<<28u));atomicAdd(&continuumCounted[small],triangles);}
        }
      }
      // The shadow map's light is parallel: the same test with every sphere at unit distance under a unit focal length
      // compares errors directly against the error it allows.
      if(i<chosen[1].z&&(i<chosen[1].w||continuumClusterDrawn(ownError,vec3f(0.0,0.0,1.0),0.0,parentError,vec3f(0.0,0.0,1.0),0.0,1.0,view.w*view.z))){
        let entry=continuumAppend(5u,1u);
        if(entry!=CONTINUUM_FULL){continuumLists[entry]=vec2u(instance,c|(CONTINUUM_CLUSTER_ENTRY<<28u));}
      }
    }
  }
  // The real triangles this instance listed, for the census: once a workgroup.
  workgroupBarrier();
  if(lane==0u){
    for(var k=0u;k<${CONTINUUM_VIEW_LISTS}u;k++){let n=atomicLoad(&continuumCounted[k]);if(n>0u){atomicAdd(&continuumDraws[${CONTINUUM_DRAW_WORDS}u+k],n);}}
  }
}
`;
}

// --------------------------------------------------------------------------------------------- drawing
// A splat's corner, facing the eye from its centre: the triangle that circumscribes the outline's ellipse, shrunk by
// its type's baked area factor to the outline's own area, and grown where the splat is thinned to keep the horizon's
// covered area. Its height is along the body's own up, turned as the body is.
const CONTINUUM_SPLAT = /* wgsl */`
struct ContinuumSplat { local:vec3f, world:vec3f, toward:vec3f, corner:vec2f };
fn continuumSplatCorner(record:ContinuumRecord,eye:vec3f,vertex:u32,thinned:f32)->ContinuumSplat {
  let model=continuumTypeOf(record);
  var out:ContinuumSplat;
  out.local=vec3f(continuumTypeF(model,${CONTINUUM_TYPE.splatCentre}u),continuumTypeF(model,${CONTINUUM_TYPE.splatCentre + 1}u),continuumTypeF(model,${CONTINUUM_TYPE.splatCentre + 2}u));
  let centre=continuumPlace(record,out.local);
  out.toward=normalize(eye-centre);
  let lift=continuumQuat(record.turn,vec3f(0.0,1.0,0.0));
  let up=normalize(lift-out.toward*dot(lift,out.toward)+vec3f(0.0,1e-4,0.0));
  let right=normalize(cross(up,out.toward));
  let k=continuumTypeF(model,${CONTINUUM_TYPE.splatArea}u)*thinned;
  out.corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  let stretch=continuumStretch(record);
  let rx=continuumTypeF(model,${CONTINUUM_TYPE.splatRx}u)*0.5*(stretch.x+stretch.z)*record.place.w;
  let ry=continuumTypeF(model,${CONTINUUM_TYPE.splatRy}u)*stretch.y*record.place.w;
  out.world=centre+right*(out.corner.x*rx*k)+up*(out.corner.y*ry*k);
  return out;
}
// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far side the handoff's
// share and the clusters the rest; of the far side's, the splat its own share and the far body the rest. Every sample
// is drawn by exactly one of the three. coverage: the draw, handoff | splat << 8, the record's seed (js/continuum-format.js:
// it splits the samples, so an instance a family's own pass lists anew each frame keeps its pattern), samples.
fn continuumMask(coverage:vec4u,pixel:vec2f,salt:u32)->u32 {
  let samples=clamp(coverage.w,1u,8u);
  let all=(1u<<samples)-1u;
  let seed=coverage.z*0x9e3779b9u+salt;
  let handoff=continuumSamples(f32(coverage.y&255u)/255.0,pixel,samples,seed);
  let splat=handoff&continuumSamples(f32((coverage.y>>8u)&255u)/255.0,pixel,samples,seed+7u);
  if(coverage.x==CONTINUUM_CLUSTER_ENTRY){return all&~handoff;}
  if(coverage.x==CONTINUUM_FAR_ENTRY){return handoff&~splat;}
  return splat;
}
`;

// What the vertex stage hands a material for each corner, and the corner it is drawn at. A material reads what it
// wears from here: its type's material block (continuumType), its vertex's words (a cluster corner's own; a far-body
// corner's are its triangle's: high 0, word the triangle's), its side streams by `vertex`, its record's spare words.
const CONTINUUM_SURFACE = /* wgsl */`
struct ContinuumSurface {
  instance:u32, what:u32, model:u32, vertex:u32, // what: the entry (cluster, far body, splat); vertex: CONTINUUM_NO_VERTEX for a splat
  record:ContinuumRecord,
  local:vec3f,   // the point in its type's own metres, posed (a splat's: its centre)
  world:vec3f,   // where it is drawn, in the scene's frame
  normal:vec3f,  // its normal, turned and of unit length
  high:u32, word:u32,
  wear:f32,      // how worn it is: its kind's wear (a shard's scorch) or its surface stream's, whichever is more
  corner:vec2f,  // a splat's corner: (0, 2) at its apex, (±√3, -1) at its base
};
fn continuumClip(world:vec3f)->vec4f { return F.viewProj*vec4f(earthCurve(world+continuumShift()-F.camPos.xyz,F.camPos.y),1.0); }
// The eye, in the scene's frame.
fn continuumEye()->vec3f { return F.camPos.xyz-continuumShift(); }
`;

// A family's material: what it brings to the pipeline family, as data.
//   name      its programs' names, and the prefix of its two functions: <name>Varying(s:ContinuumSurface,
//             v:ptr<function,ContinuumVarying>), which writes its own varyings for a corner, and <name>Shade(v:
//             ContinuumVarying, front:bool)->vec4f, which shades a fragment (its colour, opaque).
//   prelude() the WGSL its shading needs, with its own bindings (group 0 and 1; F, the frame, among them).
//   core      whether its prelude already holds the shared core (CONTINUUM_CORE_WGSL).
//   data      the group and first binding the scene's data takes in its programs (5 bindings).
//   varyings  its own varyings: [name, type, flat?], laid after the core's.
//   wgsl()    its two functions.
//   salt      the seed its handoff's sample pattern is salted with.
//   cullMode  'back' for closed bodies wound outward, 'none' for open shells.
//   air       whether it calls continuumAir (the air between it and the eye, surfaceAir; bypassed under water).
//   capture   whether it is drawn under water too (its prelude then must leave group 3 free).
//   mask      whether it brings <name>Mask(v:ContinuumVarying, front:bool)->u32, the samples of a fragment it keeps
//             (what shot and tearing have taken away is none), ANDed into the handoff's: no discard, rule 2.
//   coverage  whether its surface cuts (a leaf card's alpha): it then also writes <name>Coverage(v:ContinuumVarying,
//             front:bool)->u32, the samples of the pixel its surface covers, and the view keeps only those (rule 2: a
//             cut by the sample mask, never discard).
function continuumVaryingWGSL(material) {
  const fields = material.varyings.map(([name, type, flat], i) => `  @location(${3 + i})${flat ? ' @interpolate(flat)' : ''} ${name}:${type},`).join('\n');
  return /* wgsl */`
struct ContinuumVarying {
  @builtin(position) position:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) @interpolate(flat) coverage:vec4u,   // x the entry (1 clusters, 2 far body, 3 splat), y handoff | splat << 8, z the record's seed, w samples
${fields}
};
struct ContinuumCoverage { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
// One corner of an entry. Coarse: an entry of the shadow map's lists, its far body at the step its shadow takes,
// unmorphed (an under-water capture draws those, as the sea blurs anything finer).
fn continuumVertex(vertex:u32,listed:ContinuumEntry,coarse:bool)->ContinuumVarying {
  let touched=continuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  var state=continuumState(instance);
  let lift=continuumLift(state,coarse);
  if(coarse){state.y=state.y>>16u;state.z=0u;state.x=0u;}
  let record=continuumRecords[instance];
  var s:ContinuumSurface;
  s.instance=instance;s.what=what;s.model=continuumTypeOf(record);s.record=record;s.vertex=CONTINUUM_NO_VERTEX;
  var out:ContinuumVarying;
  if(what==CONTINUUM_SPLAT_ENTRY){
    let splat=continuumSplatCorner(record,continuumEye(),vertex,unpack2x16float(state.w).x);
    s.local=splat.local;s.world=splat.world+lift;s.normal=splat.toward;s.corner=splat.corner;
  }else{
    var corner:ContinuumCorner;
    if(what==CONTINUUM_CLUSTER_ENTRY){corner=continuumClusterCorner(record,item,vertex);}
    else{corner=continuumFarCorner(record,s.model,item,vertex,state.y&65535u,bitcast<f32>(state.z));}
    if(!corner.shown){out.position=CONTINUUM_HIDDEN;return out;}
    s.local=corner.posed.position;s.world=continuumPlace(record,s.local)+lift;s.normal=continuumTurnNormal(record,corner.posed.normal);
    s.high=corner.high;s.word=corner.word;s.vertex=corner.vertex;s.wear=max(corner.posed.wear,continuumSurfaceWear(corner.vertex));
  }
  out.world=s.world+vec3f(touched);
  out.normal=s.normal;
  out.position=continuumClip(out.world);
  out.coverage=vec4u(what,state.x&65535u,record.tag.z,continuumView.counts.y);
  ${material.name}Varying(s,&out);
  return out;
}
`;
}

// Every program of the one family, composed: the select ('select'), the shadow map's ('shadow'), and a material's view
// ('view') or under-water capture ('capture', with `capture` the water's own tail: js/water-optics.js captureTail).
export function continuumModuleWGSL({ pass, material = null, capture = null }) {
  if (pass === 'select') return continuumSelectWGSL();
  if (pass === 'shadow') {
    return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + continuumDataWGSL(1, 0, 'read') + continuumCommonWGSL() + continuumKindsWGSL() + CONTINUUM_TOUCH + /* wgsl */`
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@group(0) @binding(1) var<uniform> F:Frame;
// One drawn whole casts its far body at the step the cut chose for its shadow, unmorphed; one drawn alone, its
// clusters at their own cut, each where its pose has it.
@vertex fn continuumShadowVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->@builtin(position) vec4f {
  let touched=continuumBindings();
  let instance=listed.entry.x;let item=listed.entry.y&0x0fffffffu;
  let record=continuumRecords[instance];
  var corner:ContinuumCorner;
  if((listed.entry.y>>28u)==CONTINUUM_FAR_ENTRY){corner=continuumFarCorner(record,continuumTypeOf(record),item,vertex,continuumState(instance).y>>16u,0.0);}
  else{corner=continuumClusterCorner(record,item,vertex);}
  if(!corner.shown){return CONTINUUM_HIDDEN;}
  let world=continuumPlace(record,corner.posed.position)+continuumLift(continuumState(instance),false)+vec3f(touched);
  return SH.lightView*vec4f(world-SH.origin.xyz,1.0);
}
`;
  }
  if (!material || (pass !== 'view' && pass !== 'capture')) throw Error(`No continuum pass ${pass}`);
  if (pass === 'capture' && (!material.capture || !capture)) throw Error(`The ${material.name} material has no under-water capture`);
  const air = !material.air ? '' : pass === 'view'
    ? 'fn continuumAir(colour:vec3f,world:vec3f)->vec3f { return surfaceAir(colour,world); }\n'
    // Under water the water's surface applies the air once; the call is kept so that every binding stays reachable.
    : 'fn continuumAir(colour:vec3f,world:vec3f)->vec3f { if(F.screen.x>=0.0&&captureMode.x<.5){return colour;} return surfaceAir(colour,world); }\n';
  const body = material.prelude() + (material.core ? '' : CONTINUUM_CORE_WGSL) + continuumDataWGSL(material.data.group, material.data.binding, 'read')
    + continuumCommonWGSL() + continuumKindsWGSL() + CONTINUUM_TOUCH + CONTINUUM_SPLAT + CONTINUUM_SURFACE + continuumVaryingWGSL(material) + air + material.wgsl();
  if (pass === 'view') {
    return body + /* wgsl */`
@vertex fn continuumVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumVarying { return continuumVertex(vertex,listed,false); }
@fragment fn continuumFS(v:ContinuumVarying,@builtin(front_facing) front:bool)->ContinuumCoverage {
  var out:ContinuumCoverage;
  out.colour=${material.name}Shade(v,front);
  out.mask=continuumMask(v.coverage,v.position.xy,${material.salt}u)${material.mask ? `&${material.name}Mask(v,front)` : ''}${material.coverage ? `&${material.name}Coverage(v,front)` : ''};
  return out;
}
`;
  }
  return capture.directive + body + /* wgsl */`
@vertex fn continuumCaptureVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumVarying { return continuumVertex(vertex,listed,true); }
fn waterCaptureMaterial(v:ContinuumVarying,front:bool)->vec4f { return ${material.name}Shade(v,front); }
` + capture.tail({ fragment: '@fragment fn submergedFS(v:ContinuumVarying,@builtin(front_facing) front:bool)->@location(0) vec4f', args: 'v,front', world: 'v.world' });
}
