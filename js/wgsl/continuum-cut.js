// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one cut (AGENTS.md rule 3) and the one pipeline family it is drawn by. Every family's instances are records of
// one format, of types in an atlas of one format (js/continuum-format.js), posed by their kind
// (js/wgsl/continuum-kinds.js); this reads them, chooses each frame how each is drawn, and composes every program that
// draws them: the select, the shadow map's, and for each family's material its view and its under-water capture. A
// family brings a material (how its surface is worn and lit, and, if it cuts or lets light through, how its shadow
// does) and its records, never its own selection, handoff or budget, and no shader here is made by rewriting another.
//
// One workgroup decides each frame how CONTINUUM_BATCH instances are drawn: clusters of each one's type cut by
// projected error, its far body at one step of its collapse, its splat, or two of them sharing each pixel's samples
// across a band; and, if it stands within the shadow map, the cut its shadow is cast at. The workgroup's lanes try the
// candidate clusters of all its instances together, so a small instance (a meadow patch) costs a few lanes and a large
// one (a ship close to) all of them. One drawn as clusters alone (broken, shattered, damaged, exact, or a body of
// pieces) is cut at the finest its error bound allows: a type's clusters are its parts' own, so no simplified surface
// spans two parts, and each rides its part's pose. Every list entry is one instance of a fixed-size draw: a cluster
// (384 vertices, or 96 for a small one), 32 far-body triangles (96), or a splat (3); the unused vertices are
// degenerate. The lists are sized from the scene's one budget (js/continuum-format.js continuumRoom). Where the cuts no
// longer fit, the nearest keep theirs and the farther yield, each to one of CONTINUUM_LEVELS coarser cuts, by a plan
// made from what every instance asked a frame before (continuumReset), never by which the GPU reached first; and the
// select counts the real triangles the scene's error asks for (js/continuum-census.js), so the budget's governor
// coarsens the one scalar until every cut fits again.
//
// The atlas is read through one accessor (continuumWord) across as many pages as the device needs to bind it
// (js/continuum-scene.js continuumAtlasPaging); its header and types always lie in the first.
import { FRAME_WGSL } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_CORE_WGSL, CONTINUUM_STEP_WORDS, CONTINUUM_HOPS, CONTINUUM_OPTICS_WORDS, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import {
  CONTINUUM_HEADER, CONTINUUM_GROUP_WHOLE, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_CLUSTER_WORDS, CONTINUUM_VERTEX_WORDS, CONTINUUM_TRIANGLE_WORDS, CONTINUUM_NEVER,
  CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_CLUSTER_TRIANGLES, CONTINUUM_SMALL_CLUSTER, CONTINUUM_LISTS, CONTINUUM_ENTRY_TRIANGLES, CONTINUUM_VIEW_LISTS, CONTINUUM_CAPTURE_LISTS,
  CONTINUUM_TYPE_PIECES, CONTINUUM_TYPE_DETAIL_SHIFT, CONTINUUM_KIND, CONTINUUM_KIND_SHIFT, CONTINUUM_GONE, CONTINUUM_STRUCK, CONTINUUM_BROKEN, CONTINUUM_EXACT, CONTINUUM_SEA,
  CONTINUUM_IMPORTANT_FLAG, CONTINUUM_SHATTERED, CONTINUUM_DAMAGED, CONTINUUM_STRETCHED, CONTINUUM_STREAMS, CONTINUUM_SURFACE_RANGE,
  CONTINUUM_CLUSTER_ENTRY, CONTINUUM_FAR_ENTRY, CONTINUUM_SPLAT_ENTRY, CONTINUUM_CARD_ENTRY, CONTINUUM_CARD_LIST, CONTINUUM_CARD_LEVELS,
} from '../continuum-format.js';
import { continuumKindsWGSL } from './continuum-kinds.js';
import { CONTINUUM_GROUNDED, continuumGroundWGSL } from '../continuum-ground.js';
import { CONTINUUM_HIZ_TEXTURE_BINDING, CONTINUUM_HIZ_UNIFORM_BINDING, continuumHiZWGSL } from '../continuum-hiz.js';

// The vertices of one entry of each list.
export const CONTINUUM_ENTRY_VERTICES = Object.freeze(CONTINUUM_ENTRY_TRIANGLES.map((n) => 3 * n));
// How many cuts an instance may take, each at twice the last's pixel error, when its finest no longer fits the lists.
export const CONTINUUM_LEVELS = 4;
// The draws buffer: each list's indirect draw (four words); the real triangles the scene's error asks of each of the
// view's lists; how many instances the select cuts this frame (the scene's count, or what its family's own pass
// stood); then the plan the cut yields by (continuumReset): the entries its instances ask of each list they yield in,
// at every level, summed by a key of how near they stand (the important ahead of all), and the level each key is cut
// from.
export const CONTINUUM_DRAW_WORDS = CONTINUUM_LISTS.length * 4;
export const CONTINUUM_LIVE_WORD = CONTINUUM_DRAW_WORDS + CONTINUUM_VIEW_LISTS;
export const CONTINUUM_PLAN_WORD = CONTINUUM_LIVE_WORD + 1;
// A key a quarter octave of distance and a slice of the instances' seeds' hash, so those as near as each other yield by
// a draw that every frame makes alike.
const CONTINUUM_PLAN_BUCKETS = 64;
const CONTINUUM_PLAN_SLICES = 4;
const CONTINUUM_PLAN_KEYS = CONTINUUM_PLAN_BUCKETS * CONTINUUM_PLAN_SLICES;
// What is asked, a row each: the view's clusters, its small clusters, the far body, the shadow's far body, the
// shadow's clusters. Planned, a group each: the view's clusters (both its lists at once), and each of the rest.
const CONTINUUM_PLAN_ROWS = 5;
export const CONTINUUM_PLAN_GROUPS = 4;
const CONTINUUM_PLAN_ASKED = CONTINUUM_PLAN_ROWS * CONTINUUM_LEVELS * CONTINUUM_PLAN_KEYS;
const CONTINUUM_PLAN_FLOORS = CONTINUUM_PLAN_WORD + CONTINUUM_PLAN_ASKED;
export const CONTINUUM_DRAWS_BYTES = (CONTINUUM_PLAN_FLOORS + CONTINUUM_PLAN_GROUPS * CONTINUUM_PLAN_KEYS) * 4;
// What of a list's room the plan fills: the rest takes what the view asks more of than it did a frame before.
const CONTINUUM_PLAN_FILL = 0.9;
export const CONTINUUM_VIEW_BYTES = 32 + CONTINUUM_LISTS.length * 16 + 96;
// The select's workgroups each cut this many instances, and are laid in rows of CONTINUUM_ROW.
export const CONTINUUM_BATCH = 8;
export const CONTINUUM_ROW = 8192;
// Workgroup lanes and packed 8-bit cluster-test cache (4 clusters per u32 -> 12,288 clusters cached in 12 KB).
// Total workgroup storage stays strictly under WebGPU's 16 KB guaranteed limit (~14.2 KB).
const CONTINUUM_WORKGROUP = 128;
const CONTINUUM_KEPT_ITERS = 96;
const CONTINUUM_KEPT_WORDS = (CONTINUUM_KEPT_ITERS / 4) * CONTINUUM_WORKGROUP;
// The entries ahead of the lists that hold an instance's state for the frame.
export const CONTINUUM_STATE_ENTRIES = 3;
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
export const CONTINUUM_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// How many shadow-map texels a shadow's cut may be in error (matches the 2x2 hardware PCF shadow filter footprint).
export const CONTINUUM_SHADOW_TEXELS = 2.0;
// A cast shadow is a filtered silhouette, with none of its caster's relief: its cut may be this many times coarser
// than the view's own cut of the caster, whatever the map's texel (a ship's own map resolves a centimetre, which
// no shadow on her deck is seen to). It reads the scene's one pixel error, so shadows yield under the one budget too.
export const CONTINUUM_SHADOW_COARSER = 4.0;
// What a shadow pass casts: 'whole' every surface, opaque or cut (a leaf's coverage); a ship's own maps hold her
// 'solid' surfaces apart from her 'canvas', whose depth and the colour it lets through go to a map of their own.
export const CONTINUUM_SHADOW_PARTS = Object.freeze(['whole', 'solid', 'canvas']);
export const CONTINUUM_SHADOW_CLOTH_FORMAT = 'rgba16float';
// An atlas bound whole, in one page: every program's paging unless its device binds less (js/continuum-scene.js).
export const CONTINUUM_SINGLE_PAGE = Object.freeze({ pages: 1, shift: 31 });
// Where the select binds the atlas's further pages: past the frame, the data, the draws and the ground field.
export const CONTINUUM_GROUND_BINDING = 8;
export const CONTINUUM_SELECT_PAGES_AT = 9;
// The data a pass binds: the atlas's first page, the records, the lists, the view, the pose buffer, then its further
// pages.
export const continuumDataBindings = (paging) => 4 + paging.pages;
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

// The one accessor every read of the atlas past its header and types goes through, across its pages.
function continuumWordWGSL({ pages, shift }) {
  if (pages === 1) return 'fn continuumWord(i:u32)->u32 { return continuumAtlas[i]; }\n';
  const reads = Array.from({ length: pages - 1 }, (_, p) => `  if(page==${p}u){return ${p ? `continuumAtlas${p}` : 'continuumAtlas'}[at];}`).join('\n');
  return /* wgsl */`fn continuumWord(i:u32)->u32 {
  let page=i>>${shift}u;let at=i&${(2 ** shift - 1) >>> 0}u;
${reads}
  return continuumAtlas${pages - 1}[at];
}
`;
}

// What every pass knows of the atlas, the records and the pose buffer. Written when a module is, not as the bundle
// loads: the kinds read constants that load later.
export const continuumCommonWGSL = (paging) => CONTINUUM_RECORD_WGSL + continuumWordWGSL(paging) + /* wgsl */`
struct ContinuumView {
  counts:vec4u,             // instances, samples a pixel, 1 when shadows are cast, material salt | (singleSided << 31)
  scene:vec4f,              // the scene's pixel error, the world's offset x and z, unused
  lists:array<vec4u,${CONTINUUM_LISTS.length}>,     // each list's first entry and room
  aim:vec4f,                // where the player's guns would fall, in the scene's frame, and how far about it (0: none)
  curve:vec4f,              // symmetric family profile: errorScale, invTaperMetres, splatScale, taperPower
  limits:vec4f,             // symmetric family profile: minPixels, maxDistance, shadowMinError, shadowMaxDistance
  sea:vec4f,                // how far above its datum, and below, the sea now runs (js/continuum-core.js continuumSeaReach)
  cards:vec4f,              // its types' card grid (js/continuum-format.js computeContinuumCardGrid): levels (0: none), then each level's cells a side
  cardErrors:vec4f          // what a card of each level can be in error, in its type's metres
};
struct ContinuumPoint { position:vec3f, normal:vec3f, high:u32, word:u32 };
// A point as its kind poses it, in its type's own metres; wear (0 to ${CONTINUUM_SURFACE_RANGE}) how worn it is.
struct ContinuumPosed { position:vec3f, normal:vec3f, wear:f32, hidden:bool };
// One corner of an entry: posed, its material's words, the atlas vertex its side streams are read by, and its
// optical moments (ContinuumOptic).
struct ContinuumCorner { posed:ContinuumPosed, high:u32, word:u32, vertex:u32, shown:bool, optics:vec4f, albedo:vec4f };
const CONTINUUM_NEVER:u32=${CONTINUUM_NEVER}u;
const CONTINUUM_WHOLE:u32=0xffffffffu;
const CONTINUUM_NO_VERTEX:u32=0xffffffffu;
const CONTINUUM_CLUSTER_ENTRY:u32=${CONTINUUM_CLUSTER_ENTRY}u;
const CONTINUUM_FAR_ENTRY:u32=${CONTINUUM_FAR_ENTRY}u;
const CONTINUUM_SPLAT_ENTRY:u32=${CONTINUUM_SPLAT_ENTRY}u;
const CONTINUUM_CARD_ENTRY:u32=${CONTINUUM_CARD_ENTRY}u;
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
// A type's word: its record lies with the header in the atlas's first page.
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
  let w0=continuumWord(at);let w1=continuumWord(at+1u);
  let low=vec3f(continuumTypeF(model,${CONTINUUM_TYPE.low}u),continuumTypeF(model,${CONTINUUM_TYPE.low + 1}u),continuumTypeF(model,${CONTINUUM_TYPE.low + 2}u));
  var p:ContinuumPoint;
  p.position=low+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))*(continuumTypeF(model,${CONTINUUM_TYPE.span}u)/65535.0);
  p.normal=continuumOctahedral(unpack2x16unorm(continuumWord(at+2u)));
  p.high=w1>>16u;p.word=continuumWord(at+3u);
  return p;
}
// Word k of a side stream for atlas vertex 'vertex' (the header field of the stream's start, its bit, its words a
// vertex); 0 where the atlas carries none, or for a vertex of a body that had none.
fn continuumStreamWord(field:u32,bit:u32,words:u32,vertex:u32,k:u32)->u32 {
  if(vertex==CONTINUUM_NO_VERTEX||(continuumAtlas[${CONTINUUM_HEADER.streams}u]&bit)==0u){return 0u;}
  return continuumWord(continuumAtlas[field]+vertex*words+k);
}
fn continuumUV(vertex:u32)->vec2f { return unpack2x16unorm(continuumStreamWord(${CONTINUUM_HEADER.uv}u,${continuumStream('uv').bit}u,${continuumStream('uv').words}u,vertex,0u)); }
// How raw a face is (a cut through stone or timber) and how scorched, from its surface stream.
fn continuumSurfaceWear(vertex:u32)->f32 {
  let word=continuumStreamWord(${CONTINUUM_HEADER.surface}u,${continuumStream('surface').bit}u,${continuumStream('surface').words}u,vertex,0u);
  return max(f32(word&255u),f32((word>>8u)&255u))/255.0*${CONTINUUM_SURFACE_RANGE.toFixed(4)};
}
fn continuumStepWord(model:u32,step:u32,word:u32)->u32 { return continuumWord(continuumType(model,${CONTINUUM_TYPE.steps}u)+step*${CONTINUUM_STEP_WORDS}u+word); }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn continuumAncestor(model:u32,vertex:u32,step:u32)->u32 {
  let records=continuumType(model,${CONTINUUM_TYPE.records}u);
  var v=vertex;
  for(var hop=0u;hop<${CONTINUUM_HOPS}u;hop++){
    let record=continuumWord(records+v);
    let at=record&65535u;
    if(at==CONTINUUM_NEVER||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
fn continuumUnposed(position:vec3f,normal:vec3f)->ContinuumPosed { var p:ContinuumPosed;p.position=position;p.normal=normal;p.wear=0.0;p.hidden=false;return p; }
// A far body's optical moments (rule 3.3; js/continuum-bake.js continuumFarOptics): what a line of sight meets of the
// body the far surface stands for. normal: the mean of what it sees, leaning to the far surface's own as that
// disagrees; optics: x the sky that reaches what it sees, y the optical depth it is seen at, z the share of light
// that passes clean through, w how far the normals it sees agree (1 a plain face, about .4 leaves at every angle);
// albedo: the family's, if it gave one (linear colour, and its own fourth). Near, the clusters are the body:
// CONTINUUM_NEAR_OPTICS.
struct ContinuumOptic { normal:vec3f, optics:vec4f, albedo:vec4f };
const CONTINUUM_NEAR_OPTICS=vec4f(1.0,0.0,0.0,1.0);
// Far vertex v's moments (its whole body's past its last vertex), its own leaning to its region's by t: 0 at the
// far body's finest, 1 as it collapses into the vertex it joins.
fn continuumFarOptic(model:u32,v:u32,t:f32)->ContinuumOptic {
  let at=continuumType(model,${CONTINUUM_TYPE.steps}u)+(continuumType(model,${CONTINUUM_TYPE.stepCount}u)+1u)*${CONTINUUM_STEP_WORDS}u+v*${CONTINUUM_OPTICS_WORDS}u;
  let own=unpack4x8unorm(continuumWord(at));let region=unpack4x8unorm(continuumWord(at+1u));let deep=unpack4x8unorm(continuumWord(at+2u));
  var o:ContinuumOptic;
  o.normal=normalize(mix(continuumOctahedral(own.xy),continuumOctahedral(region.xy),t)+vec3f(0.0,1e-5,0.0));
  let depth=mix(deep.xy,deep.zw,t);
  o.optics=vec4f(mix(own.w,region.w,t),depth.x/max(1.0-depth.x,1e-3),depth.y,mix(own.z,region.z,t));
  let colour=mix(unpack4x8unorm(continuumWord(at+3u)),unpack4x8unorm(continuumWord(at+4u)),t);
  o.albedo=vec4f(colour.rgb*colour.rgb,colour.a);
  return o;
}
// How far along its life far vertex v is at (fractional) step 'when': 0 at the finest, 1 as it collapses.
fn continuumFarAge(model:u32,v:u32,when:f32)->f32 {
  var dies=continuumWord(continuumType(model,${CONTINUUM_TYPE.records}u)+v)&65535u;
  if(dies==CONTINUUM_NEVER){dies=continuumType(model,${CONTINUUM_TYPE.stepCount}u);}
  return clamp(when/f32(dies+1u),0.0,1.0);
}
// The whole body's moments, which its splat wears.
fn continuumBodyOptic(model:u32)->ContinuumOptic { return continuumFarOptic(model,continuumType(model,${CONTINUUM_TYPE.chainVertexCount}u),0.0); }
// One corner of the far body at a step, on its way to where the next collapse takes it, grown along its normals by
// what the collapses have taken off the outline, then posed. Its word is its triangle's; its normal and moments are
// its vertex's, morphed with it.
fn continuumFarCorner(record:ContinuumRecord,model:u32,chunk:u32,vertex:u32,step:u32,morph:f32)->ContinuumCorner {
  var out:ContinuumCorner;
  let triangle=chunk*${CONTINUUM_CHUNK_TRIANGLES}u+vertex/3u;
  out.shown=triangle<continuumStepWord(model,step,0u);
  if(!out.shown){return out;}
  let at=continuumType(model,${CONTINUUM_TYPE.triangles}u)+triangle*${CONTINUUM_TRIANGLE_WORDS}u;
  out.word=continuumWord(at+3u);
  let next=min(step+1u,continuumType(model,${CONTINUUM_TYPE.stepCount}u));
  let a=continuumAncestor(model,continuumWord(at+vertex%3u),step);let b=continuumAncestor(model,a,next);
  let first=continuumType(model,${CONTINUUM_TYPE.chainVertices}u);
  let pa=continuumPointAt(model,first+a);let pb=continuumPointAt(model,first+b);
  let grow=mix(bitcast<f32>(continuumStepWord(model,step,2u)),bitcast<f32>(continuumStepWord(model,next,2u)),morph);
  out.vertex=first+a;
  let when=f32(step)+morph;
  let oa=continuumFarOptic(model,a,continuumFarAge(model,a,when));let ob=continuumFarOptic(model,b,continuumFarAge(model,b,when));
  out.optics=mix(oa.optics,ob.optics,morph);out.albedo=mix(oa.albedo,ob.albedo,morph);
  out.posed=continuumPose(record,0u,out.vertex,continuumUnposed(mix(pa.position+pa.normal*grow,pb.position+pb.normal*grow,morph),normalize(mix(oa.normal,ob.normal,morph))));
  out.shown=!out.posed.hidden;
  return out;
}
// One corner of a cluster entry, posed with its cluster's part; hidden past its triangles.
fn continuumClusterCorner(record:ContinuumRecord,cluster:u32,vertex:u32)->ContinuumCorner {
  var out:ContinuumCorner;
  let at=continuumAtlas[${CONTINUUM_HEADER.clustersAt}u]+cluster*${CONTINUUM_CLUSTER_WORDS}u;
  let packed=continuumWord(at+15u);
  out.shown=vertex/3u<(packed&255u);
  if(!out.shown){return out;}
  out.vertex=continuumWord(continuumAtlas[${CONTINUUM_HEADER.indicesAt}u]+continuumWord(at+14u)+vertex);
  let p=continuumPointAt(continuumTypeOf(record),out.vertex);
  out.high=p.high;out.word=p.word;out.optics=CONTINUUM_NEAR_OPTICS;out.albedo=vec4f(0.0);
  out.posed=continuumPose(record,packed>>16u,out.vertex,continuumUnposed(p.position,p.normal));
  out.shown=!out.posed.hidden;
  return out;
}
// Whether a cluster is of its type's detail layer, which every cut takes whole.
fn continuumDetailCluster(model:u32,cluster:u32)->bool {
  return cluster-continuumType(model,${CONTINUUM_TYPE.clusterFirst}u)<(continuumType(model,${CONTINUUM_TYPE.flags}u)>>${CONTINUUM_TYPE_DETAIL_SHIFT}u);
}
// An instance's state for the frame, ${CONTINUUM_STATE_ENTRIES} entries ahead of the lists: handoff share | splat share << 8 | the view's
// ground lift << 16 (f16), step | shadow step << 16, then the morph (f32 bits) and the splat's scale | the captures'
// ground lift << 16 (two f16); then the far body's share of its shadow.
fn continuumState(instance:u32)->vec4u { let a=continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u];let b=continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u+1u];return vec4u(a.x,a.y,b.x,b.y); }
fn continuumShadowShare(instance:u32)->u32 { return continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u+2u].x; }
// Its cell cards (a scene whose types have a card grid; 0 for the rest): the share of a pixel's samples its cards and
// all past them take from its clusters | the share its cards' next level takes from the level entered << 8 | that
// level << 16.
fn continuumCardState(instance:u32)->u32 { return continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u+2u].y; }
// The share of a pixel's samples a cluster entry yields: its far body's, or its cell cards' where they stand nearer.
fn continuumClusterYield(instance:u32,state:u32)->u32 { return (state&0xff00u)|max(state&255u,continuumCardState(instance)&255u); }
// How far a GROUNDED instance is raised to the ground the land draws: by the view's cut, or (coarse) the captures'.
fn continuumLift(state:vec4u,coarse:bool)->vec3f { return vec3f(0.0,select(unpack2x16float(state.x>>16u).x,unpack2x16float(state.w).y,coarse),0.0); }
fn continuumShift()->vec3f { return vec3f(continuumView.scene.y,0.0,continuumView.scene.z); }
`;

// The data a pass binds, in this order from `first`: the atlas's first page, the records, the lists, the view, the
// pose buffer; and its further pages from `pagesAt`.
export const continuumDataWGSL = (group, first, lists, paging, pagesAt = first + 5) => /* wgsl */`
@group(${group}) @binding(${first}) var<storage,read> continuumAtlas:array<u32>;
@group(${group}) @binding(${first + 1}) var<storage,read> continuumRecords:array<ContinuumRecord>;
@group(${group}) @binding(${first + 2}) var<storage,${lists}> continuumLists:array<vec2u>;
@group(${group}) @binding(${first + 3}) var<uniform> continuumView:ContinuumView;
@group(${group}) @binding(${first + 4}) var<storage,read> continuumPoses:array<vec4f>;
${Array.from({ length: paging.pages - 1 }, (_, p) => `@group(${group}) @binding(${pagesAt + p}) var<storage,read> continuumAtlas${p + 1}:array<u32>;`).join('\n')}
`;
// A drawing pass names every binding of its group once, on a path never taken, so the layout it derives holds them all.
export const continuumTouchWGSL = (paging) => /* wgsl */`
fn continuumBindings()->f32 {
  if(continuumView.counts.y!=0xffffffffu){return 0.0;}
  return f32(continuumAtlas[0]${Array.from({ length: paging.pages - 1 }, (_, p) => `+continuumAtlas${p + 1}[0]`).join('')}+continuumRecords[0].tag.x+continuumLists[0].x)+continuumPoses[0].x;
}
struct ContinuumEntry { @location(0) entry:vec2u };
const CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
`;

// --------------------------------------------------------------------------------------------- the select
export function continuumSelectWGSL(paging = CONTINUUM_SINGLE_PAGE) {
  const sphereOf = (type) => `vec4f(continuumTypeF(${type},${CONTINUUM_TYPE.sphere}u),continuumTypeF(${type},${CONTINUUM_TYPE.sphere + 1}u),continuumTypeF(${type},${CONTINUUM_TYPE.sphere + 2}u),continuumTypeF(${type},${CONTINUUM_TYPE.sphere + 3}u))`;
  const atlasVec4 = (at) => `vec4f(bitcast<f32>(continuumWord(${at})),bitcast<f32>(continuumWord(${at}+1u)),bitcast<f32>(continuumWord(${at}+2u)),bitcast<f32>(continuumWord(${at}+3u)))`;
  const alone = CONTINUUM_BROKEN | CONTINUUM_SHATTERED | CONTINUUM_DAMAGED | CONTINUUM_EXACT;
  const important = CONTINUUM_IMPORTANT_FLAG | CONTINUUM_STRUCK | CONTINUUM_BROKEN | CONTINUUM_DAMAGED | CONTINUUM_SHATTERED;
  const B = CONTINUUM_BATCH, L = CONTINUUM_LEVELS, W = CONTINUUM_WORKGROUP;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + continuumDataWGSL(0, 2, 'read_write', paging, CONTINUUM_SELECT_PAGES_AT) + continuumCommonWGSL(paging) + continuumKindsWGSL()
    + continuumGroundWGSL(0, CONTINUUM_GROUND_BINDING) + continuumHiZWGSL(0, CONTINUUM_HIZ_TEXTURE_BINDING, CONTINUUM_HIZ_UNIFORM_BINDING) + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> SH:ShadowFrame;
@group(0) @binding(7) var<storage,read_write> continuumDraws:array<atomic<u32>>;
const CONTINUUM_SHADOW_TEXELS:f32=${CONTINUUM_SHADOW_TEXELS.toFixed(4)};
const CONTINUUM_SHADOW_COARSER:f32=${CONTINUUM_SHADOW_COARSER.toFixed(4)};
const CONTINUUM_FULL:u32=0xffffffffu;
const CONTINUUM_BATCH:u32=${B}u;
const CONTINUUM_LEVELS:u32=${L}u;
const CONTINUUM_KEPT_ITERS:u32=${CONTINUUM_KEPT_ITERS}u;
const CONTINUUM_KEPT_WORDS:u32=${CONTINUUM_KEPT_WORDS}u;
const CONTINUUM_LIVE:u32=${CONTINUUM_LIVE_WORD}u;
// The morph search reads the steps of the type in hand.
var<private> continuumStepsAt:u32;
${continuumClusterPrefixWGSL('continuumPrefix', (i) => `bitcast<f32>(continuumWord(continuumAtlas[${CONTINUUM_HEADER.clustersAt}u]+(${i})*${CONTINUUM_CLUSTER_WORDS}u+13u))`)}
${continuumMorphStepWGSL('continuumMorphStep', (i) => `bitcast<f32>(continuumWord(continuumStepsAt+(${i})*${CONTINUUM_STEP_WORDS}u+1u))`)}
// Whether a sphere (its centre from the eye) lies wholly outside the view. One that holds the eye never does.
fn continuumOutside(at:vec3f,reach:f32)->bool {
  if(dot(at,at)<=reach*reach){return false;}
  let m=F.viewProj;let p=vec4f(at,1.0);
  let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
  let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
  for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
  return false;
}
// Room for 'count' entries of a list, or CONTINUUM_FULL: taken whole or not at all.
fn continuumReserve(list:u32,count:u32)->u32 {
  if(count==0u){return CONTINUUM_FULL;}
  let at=atomicAdd(&continuumDraws[list*4u+1u],count);
  if(at+count>continuumView.lists[list].y){atomicSub(&continuumDraws[list*4u+1u],count);return CONTINUUM_FULL;}
  return continuumView.lists[list].x+at;
}
fn continuumChunks(model:u32,step:u32)->u32 { return (continuumStepWord(model,step,0u)+${CONTINUUM_CHUNK_TRIANGLES - 1}u)/${CONTINUUM_CHUNK_TRIANGLES}u; }
fn continuumFocal()->f32 { return F.screen.y/max(2.0*length(F.camUp.xyz),1e-4); }
// The pixel error of an instance's cut at level j, as a multiple of its own.
fn continuumLevel(j:u32)->f32 { return f32(1u<<j); }
// How near an instance stands, for the plan: the important first, then the rest a quarter octave of distance from
// its sphere's near side a bucket, and within one, a slice of its seed's hash.
fn continuumPlanKey(nearDist:f32,important:bool,seed:u32)->u32 {
  var bucket=0u;
  if(!important){bucket=1u+min(u32(log2(max(nearDist,0.5)/0.5)*4.0),${CONTINUUM_PLAN_BUCKETS - 2}u);}
  return bucket*${CONTINUUM_PLAN_SLICES}u+((seed*0x9e3779b9u)>>${32 - Math.log2(CONTINUUM_PLAN_SLICES)}u);
}
// What an instance asks of a row at a level, whether or not it is listed there.
fn continuumAsk(row:u32,level:u32,key:u32,n:u32){
  if(n>0u){atomicAdd(&continuumDraws[${CONTINUUM_PLAN_WORD}u+(row*CONTINUUM_LEVELS+level)*${CONTINUUM_PLAN_KEYS}u+key],n);}
}
// The finest level a group's key is listed at this frame (CONTINUUM_LEVELS: none).
fn continuumFloor(group:u32,key:u32)->u32 { return min(atomicLoad(&continuumDraws[${CONTINUUM_PLAN_FLOORS}u+group*${CONTINUUM_PLAN_KEYS}u+key]),CONTINUUM_LEVELS); }
var<workgroup> continuumPlanSumA:array<vec4u,${CONTINUUM_PLAN_KEYS}>;
var<workgroup> continuumPlanSumB:array<vec4u,${CONTINUUM_PLAN_KEYS}>;
var<workgroup> continuumPlanFirst:atomic<u32>;
// What a row asked of a key at each level, taken (cleared for this frame's asking); nothing of a row past the last (a
// group of one list).
fn continuumPlanTake(row:u32,key:u32)->vec4u {
  if(row>=${CONTINUUM_PLAN_ROWS}u){return vec4u(0u);}
  var asked=vec4u(0u);
  for(var j=0u;j<CONTINUUM_LEVELS;j++){asked[j]=atomicExchange(&continuumDraws[${CONTINUUM_PLAN_WORD}u+(row*CONTINUUM_LEVELS+j)*${CONTINUUM_PLAN_KEYS}u+key],0u);}
  return asked;
}
// What the keys nearer than x asked of each list, at each level.
fn continuumPlanBeforeA(x:u32)->vec4u { if(x==0u){return vec4u(0u);} return continuumPlanSumA[x-1u]; }
fn continuumPlanBeforeB(x:u32)->vec4u { if(x==0u){return vec4u(0u);} return continuumPlanSumB[x-1u]; }
// The first key from after on, short of limit, that fails (limit when none), as every lane of the plan finds at once.
fn continuumPlanFirstFailing(key:u32,after:u32,limit:u32,fails:bool)->u32 {
  if(key==0u){atomicStore(&continuumPlanFirst,limit);}
  workgroupBarrier();
  if(key>=after&&key<limit&&fails){atomicMin(&continuumPlanFirst,key);}
  workgroupBarrier();
  let first=atomicLoad(&continuumPlanFirst);
  workgroupBarrier();
  return first;
}
// Before each frame's cut: each list empty, its draw's vertex count set, the triangles asked cleared, and the
// instances cut set to the scene's count (a family's own pass may set them anew: continuumBatchArgs); and the plan
// this frame's cut yields by (AGENTS.md rule 3, item 5), made from what the last frame's asked, a workgroup a group
// and a lane a key. The nearest keys whose coarsest cuts fit together are listed, the rest not; of those, the nearest
// at the finest level that leaves the rest room for their coarsest, the next nearest at the next level that does,
// and so on, so a nearer key is never cut coarser than a farther. Made from what was asked, which no reservation
// changes, so a view is cut alike every frame whatever order the GPU reaches its instances in; the reservations' own
// fallback, a level coarser at a time, takes only what the view asks more of than it did the frame before.
@compute @workgroup_size(${CONTINUUM_PLAN_KEYS}) fn continuumReset(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) key:u32){
  let g=group.x;
  if(g==0u){
    let vertices=array<u32,${CONTINUUM_LISTS.length}>(${CONTINUUM_ENTRY_VERTICES.map((n) => `${n}u`).join(',')});
    if(key<CONTINUUM_LIVE){atomicStore(&continuumDraws[key],select(0u,vertices[min(key/4u,${CONTINUUM_LISTS.length - 1}u)],key%4u==0u&&key<${CONTINUUM_DRAW_WORDS}u));}
    if(key==CONTINUUM_LIVE){atomicStore(&continuumDraws[key],continuumView.counts.x);}
  }
  let rows=array<vec2u,${CONTINUUM_PLAN_GROUPS}>(vec2u(0u,1u),vec2u(2u,${CONTINUUM_PLAN_ROWS}u),vec2u(3u,${CONTINUUM_PLAN_ROWS}u),vec2u(4u,${CONTINUUM_PLAN_ROWS}u));
  let lists=array<vec2u,${CONTINUUM_PLAN_GROUPS}>(vec2u(0u,1u),vec2u(2u,2u),vec2u(4u,4u),vec2u(5u,5u));
  let row=rows[g];let list=lists[g];
  let room=vec2u(vec2f(f32(continuumView.lists[list.x].y),f32(continuumView.lists[list.y].y))*${CONTINUUM_PLAN_FILL});
  // What this key and every nearer one asked, of each list at each level.
  var sumA=continuumPlanTake(row.x,key);var sumB=continuumPlanTake(row.y,key);
  for(var o=1u;o<${CONTINUUM_PLAN_KEYS}u;o<<=1u){
    continuumPlanSumA[key]=sumA;continuumPlanSumB[key]=sumB;
    workgroupBarrier();
    if(key>=o){sumA+=continuumPlanSumA[key-o];sumB+=continuumPlanSumB[key-o];}
    workgroupBarrier();
  }
  continuumPlanSumA[key]=sumA;continuumPlanSumB[key]=sumB;
  workgroupBarrier();
  // The keys listed: the nearest whose coarsest cuts fit together. What a key and its nearer ones leave the rest of
  // those at their coarsest.
  let listed=continuumPlanFirstFailing(key,0u,${CONTINUUM_PLAN_KEYS}u,any(vec2u(sumA.w,sumB.w)>room));
  let rest=vec2u(continuumPlanBeforeA(listed).w,continuumPlanBeforeB(listed).w)-vec2u(sumA.w,sumB.w);
  // The nearest at level 0, then the next at 1, then at 2: each as far out as the room left for the rest allows.
  let at0=continuumPlanFirstFailing(key,0u,listed,any(vec2u(sumA.x,sumB.x)+rest>room));
  let a0=continuumPlanBeforeA(at0);let b0=continuumPlanBeforeB(at0);
  let taken0=vec2u(a0.x,b0.x);
  let at1=continuumPlanFirstFailing(key,at0,listed,any(taken0+vec2u(sumA.y-a0.y,sumB.y-b0.y)+rest>room));
  let a1=continuumPlanBeforeA(at1);let b1=continuumPlanBeforeB(at1);
  let taken1=taken0+vec2u(a1.y-a0.y,b1.y-b0.y);
  let at2=continuumPlanFirstFailing(key,at1,listed,any(taken1+vec2u(sumA.z-a1.z,sumB.z-b1.z)+rest>room));
  var level=CONTINUUM_LEVELS;
  if(key<at0){level=0u;}else if(key<at1){level=1u;}else if(key<at2){level=2u;}else if(key<listed){level=3u;}
  atomicStore(&continuumDraws[${CONTINUUM_PLAN_FLOORS}u+g*${CONTINUUM_PLAN_KEYS}u+key],level);
}
var<workgroup> continuumSlotRecord:array<ContinuumRecord,${B}>;
var<workgroup> continuumSlotCut:array<vec4f,${B}>;      // focal, allowed pixels, scale, the shadow's allowed error (metres of the type)
var<workgroup> continuumSlotTries:array<vec4u,${B}>;    // the view's clusters to try, the shadow's, its first cluster, its detail clusters
var<workgroup> continuumSlotFar:array<vec4u,${B}>;      // where its far body's pieces go and how many; its shadow's
var<workgroup> continuumSlotWet:array<vec4u,${B}>;      // where the captures' copies go: clusters, small clusters, far body; 1 if the sea can reach it
var<workgroup> continuumSlotLift:array<f32,${B}>;       // how far it is raised to the view's drawn ground
var<workgroup> continuumSlotKey:array<u32,${B}>;        // how near it stands, for the plan (continuumPlanKey)
var<workgroup> continuumSlotStart:array<u32,${B + 1}>;  // where each instance's tries begin among the workgroup's
var<workgroup> continuumWanted:array<atomic<u32>,${B * 3 * L}>; // each instance's clusters in each list (clusters, small, shadow) at each level
var<workgroup> continuumChosen:array<vec4u,${B}>;       // the level its view's clusters and its shadow's are listed at
var<workgroup> continuumBase:array<vec4u,${B}>;         // where its clusters, small clusters and shadow clusters go
var<workgroup> continuumCursor:array<atomic<u32>,${B * 3}>;
var<workgroup> continuumKept:array<u32,CONTINUUM_KEPT_WORDS>;
var<workgroup> continuumCounted:array<atomic<u32>,${CONTINUUM_VIEW_LISTS}>; // real triangles the scene's error asks of each view list
var<workgroup> continuumFrustum:array<vec4f,5>;         // unit-normal frustum planes, computed once per workgroup
var<workgroup> continuumCardWant:array<u32,${B}>;       // 1 if slot wants a list-3 splat/card entry (batched once per workgroup)
var<workgroup> continuumCardBase:u32;                   // reserved list-3 base entry for this workgroup
var<workgroup> continuumSlotCells:array<vec4u,${B}>;    // its cell cards: where they go, how many of the level entered, of the next, and that level
fn continuumOutsideFast(at:vec3f,reach:f32)->bool {
  if(dot(at,at)<=reach*reach){return false;}
  let p=vec4f(at,1.0);
  for(var i=0u;i<5u;i++){if(dot(continuumFrustum[i],p)< -reach){return true;}}
  return false;
}
// The instance a workgroup's tried cluster belongs to.
fn continuumSlotOf(f:u32)->u32 { var k=0u;for(var j=1u;j<CONTINUUM_BATCH;j++){if(f>=continuumSlotStart[j]){k=j;}} return k; }
// A group's sphere where the part that leads the group has posed it; where that part is out of sight (a limb shot
// away), where the cluster's own part has.
fn continuumGroupSphere(record:ContinuumRecord,lead:u32,part:u32,sphere:vec4f)->vec4f {
  let posed=continuumSphere(record,lead,sphere);
  if(posed.w>=0.0||lead==part){return posed;}
  return continuumSphere(record,part,sphere);
}
// One cluster of an instance tried at every level, by the core's own test, each sphere where its part's pose has it:
// bit j whether the view lists it at level j, bit 4 + j the shadow map; bit 8 small; its triangles from bit 16. A part
// posed out of sight takes its clusters with it. Evaluates cheapest bounds first so rejected clusters skip sphere/frustum reads.
fn continuumTry(slot:u32,i:u32)->u32 {
  let record=continuumSlotRecord[slot];let cut=continuumSlotCut[slot];let tries=continuumSlotTries[slot];
  let at=continuumAtlas[${CONTINUUM_HEADER.clustersAt}u]+(tries.z+i)*${CONTINUUM_CLUSTER_WORDS}u;
  let packed=continuumWord(at+15u);let part=packed>>16u;let triangles=packed&255u;
  // The parts that pose its own group's sphere and its parent group's: its own part, unless the atlas carries group
  // parts (a body whose parts are joined for good, whose groups span parts and must each be posed one way).
  var lodPart=part;var parentPart=part;
  let groupPartsAt=continuumAtlas[${CONTINUUM_HEADER.groupParts}u];
  if(groupPartsAt!=0u){
    let groupParts=continuumWord(groupPartsAt+tries.z+i);
    lodPart=select(groupParts&65535u,CONTINUUM_WHOLE,(groupParts&65535u)==${CONTINUUM_GROUP_WHOLE}u);
    parentPart=select((groupParts>>16u),CONTINUUM_WHOLE,(groupParts>>16u)==${CONTINUUM_GROUP_WHOLE}u);
  }
  // A cluster of the finest level has nothing finer to hand over to: its own error (a skin's or a sway's pose slack)
  // never keeps it from being drawn once its parent is too coarse, so an eye however near, or inside, draws the finest.
  let ownError=select(bitcast<f32>(continuumWord(at+12u))*cut.z,0.0,((packed>>8u)&255u)==0u);
  let parentError=bitcast<f32>(continuumWord(at+13u))*cut.z;
  var mask=0u;
  var checkedHide=false;
  if(i<tries.x){
    let shift=continuumShift()-F.camPos.xyz+vec3f(0.0,continuumSlotLift[slot],0.0);
    let parent=continuumGroupSphere(record,parentPart,part,${atlasVec4('at+4u')});
    checkedHide=parentPart==part;
    if(parent.w<0.0){return 0u;}
    let above=continuumPlace(record,parent.xyz)+shift;
    let parentPx=continuumPixels(parentError,cut.x,max(length(above)-parent.w*cut.z,CONTINUUM_NEAREST));
    if(parentPx>cut.y){
      let lod=continuumGroupSphere(record,lodPart,part,${atlasVec4('at')});
      if(lod.w<0.0){return 0u;}
      let own=continuumPlace(record,lod.xyz)+shift;
      let ownPx=continuumPixels(ownError,cut.x,max(length(own)-lod.w*cut.z,CONTINUUM_NEAREST));
      if(ownPx*0.42<=cut.y*continuumLevel(CONTINUUM_LEVELS-1u)){
        let cull=continuumSphere(record,part,${atlasVec4('at+8u')});
        if(cull.w<0.0){return 0u;}
        let cullWorld=continuumPlace(record,cull.xyz)+vec3f(0.0,continuumSlotLift[slot],0.0);
        let cullAt=cullWorld+continuumShift()-F.camPos.xyz;
        let sea=continuumFlagged(record,CONTINUUM_SEA);
        let cullR=cull.w*cut.z;
        // Skip per-cluster Hi-Z on low ground-draped clusters (e.g. meadow grass blades) where the terrain directly
        // beneath them sits inside the same coarse Hi-Z depth tile on rolling slopes and would flicker them frame-to-frame.
        let skipClusterHiZ=continuumFlagged(record,CONTINUUM_EXACT)||(continuumFlagged(record,CONTINUUM_GROUNDED)&&cullR<2.5);
        if(!continuumOutsideFast(select(earthCurve(cullAt,F.camPos.y),cullAt,sea),cullR)
          &&(skipClusterHiZ||!continuumHiZOccluded(cullWorld,cullR,sea))){
          var coneVisible=true;
          var edgeRelax=1.0;
          let conesAt=continuumAtlas[${CONTINUUM_HEADER.cones}u];
          if(conesAt!=0u&&continuumKindOf(record)==${CONTINUUM_KIND.RIGID}u&&!continuumFlagged(record,CONTINUUM_EXACT)){
            let cone=unpack4x8snorm(continuumWord(conesAt+tries.z+i));
            let sinHalf=cone.w;
            if(sinHalf>=0.0&&sinHalf<0.96){
              let axisW=continuumTurnNormal(record,cone.xyz);
              let viewDist=max(length(cullAt),1e-3);
              let toEye=-cullAt/viewDist;
              if((continuumView.counts.w&0x80000000u)!=0u){
                let sphereMargin=min(cullR/viewDist,1.0);
                if(dot(toEye,axisW)< -(sinHalf+sphereMargin+0.04)){coneVisible=false;}
              }
              if(coneVisible&&sinHalf<0.45){
                let cosT=abs(dot(toEye,axisW));
                let flatness=1.0-smoothstep(0.15,0.45,sinHalf);
                edgeRelax=mix(1.0,clamp(0.42+0.85*cosT,0.42,1.0),flatness*smoothstep(0.08,0.24,cosT));
              }
            }
          }
          if(coneVisible){
            let pPx=parentPx*edgeRelax;
            let oPx=ownPx*edgeRelax;
            for(var j=0u;j<CONTINUUM_LEVELS;j++){
              let allowedJ=cut.y*continuumLevel(j);
              if(pPx>allowedJ&&oPx<=allowedJ){mask|=1u<<j;}
            }
          }
        }
      }
    }
  }
  // The shadow map's light is parallel: the same test with every sphere at unit distance under a unit focal length
  // compares errors directly against the error it allows. Its detail is cast at every level.
  if(i<tries.y){
    var shdMask=0u;
    if(i<tries.w){shdMask=${((1 << L) - 1) << 4}u;}
    else{
      let shdBase=cut.w*cut.z;
      if(parentError>shdBase&&ownError<=shdBase*continuumLevel(CONTINUUM_LEVELS-1u)){
        for(var j=0u;j<CONTINUUM_LEVELS;j++){
          let allowedS=shdBase*continuumLevel(j);
          if(parentError>allowedS&&ownError<=allowedS){shdMask|=16u<<j;}
        }
      }
    }
    if(shdMask!=0u){
      let kind=continuumKindOf(record);
      if(!checkedHide&&(kind==${CONTINUUM_KIND.SHARDED}u||kind==${CONTINUUM_KIND.SKINNED}u)){
        if(continuumSphere(record,part,${atlasVec4('at')}).w<0.0){return 0u;}
      }
      mask|=shdMask;
    }
  }
  if(mask==0u){return 0u;}
  return mask|(triangles<<16u)|select(0u,256u,triangles<=${CONTINUUM_SMALL_CLUSTER}u);
}
@compute @workgroup_size(${W}) fn continuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let batch=(group.x+group.y*${CONTINUUM_ROW}u)*CONTINUUM_BATCH;
  // Each of the first lanes decides how its instance is drawn, and lists its splat and far body.
  if(lane<CONTINUUM_BATCH){
    let instance=batch+lane;
    var tries=vec4u(0u);var cut=vec4f(1.0,1.0,1.0,0.0);var far=vec4u(CONTINUUM_FULL,0u,CONTINUUM_FULL,0u);var lift=vec2f(0.0);
    var wantCard=0u;var cells=vec4u(CONTINUUM_FULL,0u,0u,0u);var cardState=0u;
    var wet=vec4u(CONTINUUM_FULL,CONTINUUM_FULL,CONTINUUM_FULL,0u);
    var planKey=${CONTINUUM_PLAN_KEYS - 1}u;
    var record:ContinuumRecord;
    if(instance<atomicLoad(&continuumDraws[CONTINUUM_LIVE])){
      record=continuumRecords[instance];
      let model=continuumTypeOf(record);
      var share=0u;var splatShare=0u;var shadowShare=0u;var step=0u;var shadowStep=0u;var morph=0.0;var splatScale=0.0;
      // Its kind bounds the whole of it; one gone, or posed wholly out of sight, is not drawn here at all.
      let bound=continuumSphere(record,CONTINUUM_WHOLE,${sphereOf('model')});
      if(!continuumFlagged(record,CONTINUUM_GONE)&&bound.w>=0.0){
        // Broken, shattered, damaged, exact, or a body of pieces: clusters alone, no simplified surface across parts.
        let alone=continuumFlagged(record,${alone >>> 0}u)||(continuumType(model,${CONTINUUM_TYPE.flags}u)&${CONTINUUM_TYPE_PIECES}u)!=0u;
        let scale=continuumScale(record);
        // One that stands on the land stands on the ground the land draws (js/continuum-ground.js), raised at its
        // anchor before it is culled: by the view's cut, and by the captures' for the coarse cut drawn under water.
        if(continuumFlagged(record,CONTINUUM_GROUNDED)){
          let anchor=(record.place.xyz+continuumShift()).xz;
          lift=vec2f(continuumGroundLift(anchor),continuumGroundLiftCut(anchor,1u));
        }
        let world=continuumPlace(record,bound.xyz)+vec3f(0.0,lift.x,0.0);
        // Its reach takes in whatever of it its kind carries past its type's sphere (pieces in the air, a limb).
        let reach=bound.w*scale+bitcast<f32>(record.tag.w);
        // What the water's captures draw (js/water-optics.js): what lies under the sea, and, the eye down at the
        // water, what stands over it. One whose whole sphere stands clear of the sea as it now runs is in neither, and
        // is entered in no capture list: the captures then run no vertex of a crew on a deck or a town on its hill.
        let seaLow=world.y-lift.x+min(min(lift.x,lift.y),0.0)-reach;let seaHigh=world.y-lift.x+max(max(lift.x,lift.y),0.0)+reach;
        if(seaLow<=continuumView.sea.x||(F.camPos.y<continuumView.sea.x+1.5&&seaHigh>= -continuumView.sea.x)){wet.w=1u;}
        let relative=world+continuumShift()-F.camPos.xyz;
        let away=max(length(relative),1e-3);
        let nearDist=max(away-reach,0.0);
        let maxDist=continuumView.limits.y;
        let focal=continuumFocal();
        // One important, struck, broken, wounded, or within the fall of the player's guns is cut finer, and yields to
        // the budget more slowly (rule 3, item 5); one exact, at its finest.
        let aim=continuumView.aim;
        let aimed=aim.w>0.0&&length(relative+F.camPos.xyz-aim.xyz)<=reach+aim.w;
        let isImportant=aimed||continuumFlagged(record,${important >>> 0}u);
        planKey=continuumPlanKey(nearDist,isImportant,record.tag.z);
        if(maxDist<=0.0||nearDist<maxDist||isImportant){
          let perspectiveFactor=continuumErrorScale(record,-relative/away);
          let pixels=select(continuumProfilePixels(continuumView.scene.x,isImportant,away,continuumView.curve)/perspectiveFactor,0.0,continuumFlagged(record,CONTINUUM_EXACT));
          let steps=continuumType(model,${CONTINUUM_TYPE.stepCount}u);
          // The far body is drawn from the first step no heavier than the clusters' coarsest cut; finer is theirs.
          let farFirst=continuumType(model,${CONTINUUM_TYPE.farFirst}u);
          let farError=bitcast<f32>(continuumStepWord(model,farFirst,1u));
          continuumStepsAt=continuumType(model,${CONTINUUM_TYPE.steps}u);
          let first=continuumType(model,${CONTINUUM_TYPE.clusterFirst}u);
          let clusterCount=continuumType(model,${CONTINUUM_TYPE.clusterCount}u);
          // Its detail layer: its leading clusters, cast and seen under water with its coarse cut, whole or not.
          let detail=min(continuumType(model,${CONTINUUM_TYPE.flags}u)>>${CONTINUUM_TYPE_DETAIL_SHIFT}u,clusterCount);
          tries.z=first;tries.w=detail;
          cut=vec4f(focal,pixels,scale,0.0);
          // Its shadow, cut coarse enough for the shadow map, is bounded by the map's frustum alone: no range and no
          // size switch. A caster narrower than the error its shadow is allowed cannot be resolved by the map, and
          // thins away by the one hash the horizon thins by (continuumThin), a caster at a time as the texel grows.
          // One that stands on the ground casts by its height above it: lower than that error, its shadow lies
          // within its own footprint, however wide it spreads (a sward, a kerb, a flat stone).
          let shadowTall=2.0*continuumTypeF(model,${CONTINUUM_TYPE.splatRy}u)*continuumStretch(record).y*record.place.w;
          let shadowSpan=select(2.0*reach,min(2.0*reach,shadowTall),continuumFlagged(record,CONTINUUM_GROUNDED))/max(CONTINUUM_SHADOW_TEXELS*SH.texel.x,1e-5);
          if(continuumView.counts.z!=0u&&(continuumFlagged(record,CONTINUUM_EXACT)||continuumThin(shadowSpan,record.tag.z*0x9e3779b9u+0x7f4a7c15u)>0.0)){
            let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
            let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
            if(abs(light.x)<=1.0+r.x&&abs(light.y)<=1.0+r.y&&light.z>= -r.z&&light.z<=1.0+r.z){
              let shadowFloor=select(continuumView.limits.z,0.0,continuumFlagged(record,CONTINUUM_EXACT));
              let lightPerspective=continuumErrorScale(record,normalize(SH.sun.xyz+vec3f(0.0,1e-5,0.0)));
              let allowed=max(max(CONTINUUM_SHADOW_TEXELS*SH.texel.x/lightPerspective,shadowFloor),CONTINUUM_SHADOW_COARSER*pixels*away/focal)/scale;
              if(!alone){shadowShare=u32(round(continuumHandoff(allowed,farError)*255.0));}
              // Every level is asked for the plan, and the finest the plan leaves it that fits is listed.
              if(shadowShare>0u){
                let planned=continuumFloor(2u,planKey);
                for(var j=0u;j<CONTINUUM_LEVELS;j++){
                  let s=max(farFirst,u32(continuumMorphStep(steps,allowed*continuumLevel(j)).x));
                  let chunks=continuumChunks(model,s);continuumAsk(3u,j,planKey,chunks);
                  if(j>=planned&&far.z==CONTINUUM_FULL){let at=continuumReserve(4u,chunks);if(at!=CONTINUUM_FULL){shadowStep=s;far.z=at;far.w=chunks;}}
                }
              }
              cut.w=allowed;
              tries.y=select(detail,continuumPrefix(first,clusterCount,allowed),shadowShare<255u);
            }
          }
          // Afloat, the earth's curve does not bend it: the sea's own surface is drawn flat about the eye.
          let sea=continuumFlagged(record,CONTINUUM_SEA);
          let groundSlack=select(0.0,min(reach*0.35,0.9),continuumFlagged(record,CONTINUUM_GROUNDED));
          let hiZWorld=world+vec3f(0.0,groundSlack,0.0);
          let hiZReach=reach+groundSlack*0.65;
          let viewVisible=!continuumOutside(select(earthCurve(relative,F.camPos.y),relative,sea),reach)
            &&(isImportant||continuumFlagged(record,CONTINUUM_EXACT)||away<=reach*1.4+4.0||!continuumHiZOccluded(hiZWorld,hiZReach,sea));
          if(viewVisible){
            // Smooth outer-range hash dissolve when maxDistance > 0 (never a hard pop).
            let seed=record.tag.z*0x9e3779b9u+0x85ebca6bu;
            let rangeKept=isImportant||maxDist<=0.0||away<=maxDist*0.80||continuumProfileThin(999.0,away,continuumView.limits,seed)>0.0;
            if(!rangeKept){
              share=255u;splatShare=255u;splatScale=0.0;
            }else if(!alone){
              let start=farError*scale*focal/max(pixels,1e-4);
              share=u32(round(continuumHandoff(away,start)*255.0));
              let stretch=continuumStretch(record);
              let span=2.0*max(continuumTypeF(model,${CONTINUUM_TYPE.splatRx}u)*0.5*(stretch.x+stretch.z),continuumTypeF(model,${CONTINUUM_TYPE.splatRy}u)*stretch.y)*record.place.w*focal/away;
              let basePixels=continuumImportance(continuumView.scene.x,isImportant);
              let cardCellSize=continuumView.scene.w;
              let hasCards=cardCellSize>0.5&&!continuumFlagged(record,CONTINUUM_STRUCK);
              // Nyquist handoff derived directly from attached card cellSize (1.0 for 1-triangle horizon splats;
              // ~0.45..0.68 * cellSize px for cellSize x cellSize octahedral cards, giving >=1.5x texel supersampling).
              let cardScale=select(1.0,max(cardCellSize*0.13,1.0),hasCards);
              let effCurve=vec4f(continuumView.curve.x,continuumView.curve.y,continuumView.curve.z*cardScale,continuumView.curve.w);
              splatShare=u32(round(continuumProfileSplatShare(span,basePixels,effCurve)*255.0));
              // A scene with relightable octahedral G-buffer cards (continuumView.scene.w > 0.5) hands off from its
              // clusters straight into the card (list 3) across the sample-mask band (rule 3, item 4); the rest morph
              // down their far body to the splat. Struck instances keep their clusters, so a felled or broken shape holds.
              if(hasCards){share=splatShare;splatShare=255u;}
              if(share>0u){
                splatScale=continuumProfileThin(span,select(away,0.0,isImportant),continuumView.limits,seed);
                if(splatShare>0u&&splatScale>0.0){
                  wantCard=1u;
                }
                if(splatShare<255u){
                  let planned=continuumFloor(1u,planKey);
                  for(var j=0u;j<CONTINUUM_LEVELS;j++){
                    let chosen=continuumMorphStep(steps,pixels*continuumLevel(j)*away/(focal*scale));
                    var s=u32(chosen.x);var m=chosen.y;
                    if(s<farFirst){s=farFirst;m=0.0;}
                    if(j==0u){atomicAdd(&continuumCounted[2],continuumStepWord(model,s,0u));}
                    let chunks=continuumChunks(model,s);continuumAsk(2u,j,planKey,chunks);
                    if(j>=planned&&far.x==CONTINUUM_FULL){let at=continuumReserve(2u,chunks);if(at!=CONTINUUM_FULL){step=s;morph=m;far.x=at;far.y=chunks;}}
                  }
                }
              }
            }
            // Its cell cards (a scene whose types have a card grid): each cell of its square a picture of its true
            // clusters, standing in for them from where a texel of the picture is within the error allowed (the
            // scene's own, without its kind's foreshortening: a picture's texel is as wide from above as from the
            // side) to where its far body takes over. Seen so steeply that the far body would begin before the cards
            // do, it has none, and they fade as that nears. Each level hands over to the next across the same band.
            var cardShare=0u;
            let cardLevels=u32(continuumView.cards.x);
            if(cardLevels>0u&&rangeKept&&!alone&&pixels>0.0&&!continuumFlagged(record,CONTINUUM_STRUCK)){
              let per=scale*focal/max(pixels*perspectiveFactor,1e-4);
              let cardStart=continuumView.cardErrors.x*per;
              let farStart=farError*scale*focal/max(pixels,1e-4);
              cardShare=u32(round(continuumHandoff(away,cardStart)*smoothstep(1.0,1.0+CONTINUUM_HANDOFF_BAND,farStart/max(cardStart,1e-3))*255.0));
              if(cardShare>share){
                var level=0u;var blend=0.0;
                for(var l=1u;l<cardLevels;l++){
                  let t=continuumHandoff(away,continuumView.cardErrors[l]*per);
                  if(t>=1.0){level=l;blend=0.0;}else if(t>0.0){blend=t;break;}else{break;}
                }
                let side=u32(continuumView.cards[1u+level]);
                let next=select(0u,u32(continuumView.cards[1u+min(level+1u,${CONTINUUM_CARD_LEVELS - 1}u)]),blend>0.0);
                let at=continuumReserve(${CONTINUUM_CARD_LIST}u,side*side+next*next);
                if(at!=CONTINUUM_FULL){
                  cells=vec4u(at,side*side,next*next,level);
                  cardState=cardShare|(u32(round(blend*255.0))<<8u)|(level<<16u);
                  atomicAdd(&continuumCounted[3],2u*(side*side+next*next));
                }
              }
            }
            // The clusters that can be drawn at its nearest point (the eye's own nearest, when it stands inside).
            if(max(share,cardState&255u)<255u){
              tries.x=continuumPrefix(first,clusterCount,pixels*max(away-reach,CONTINUUM_NEAREST)/(focal*scale));
            }
          }
        }
      }
      continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u]=vec2u(share|(splatShare<<8u)|(pack2x16float(vec2f(lift.x,0.0))<<16u),step|(shadowStep<<16u));
      continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u+1u]=vec2u(bitcast<u32>(morph),pack2x16float(vec2f(splatScale,lift.y)));
      continuumLists[instance*${CONTINUUM_STATE_ENTRIES}u+2u]=vec2u(shadowShare,cardState);
    }
    if(wet.w!=0u&&far.x!=CONTINUUM_FULL){wet.z=continuumReserve(${CONTINUUM_CAPTURE_LISTS[2]}u,far.y&0x7fffffffu);}
    continuumSlotWet[lane]=wet;
    continuumSlotRecord[lane]=record;continuumSlotCut[lane]=cut;continuumSlotTries[lane]=tries;continuumSlotFar[lane]=far;continuumSlotLift[lane]=lift.x;continuumSlotKey[lane]=planKey;continuumCardWant[lane]=wantCard;continuumSlotCells[lane]=cells;
  }
  workgroupBarrier();
  if(lane==0u){
    var total=0u;
    var cardTotal=0u;
    for(var k=0u;k<CONTINUUM_BATCH;k++){
      continuumSlotStart[k]=total;
      let t=continuumSlotTries[k];
      total+=max(t.x,t.y);
      let cw=continuumCardWant[k];
      continuumCardWant[k]=cardTotal|(cw<<16u);
      cardTotal+=cw;
    }
    continuumSlotStart[CONTINUUM_BATCH]=total;
    continuumCardBase=CONTINUUM_FULL;
    if(cardTotal>0u){
      atomicAdd(&continuumCounted[3],cardTotal);
      continuumCardBase=continuumReserve(3u,cardTotal);
    }
    if(total>0u){
      let m=F.viewProj;
      let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);
      let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);
      let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
      var raw=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
      for(var p=0u;p<5u;p++){continuumFrustum[p]=raw[p]/max(length(raw[p].xyz),1e-8);}
    }
  }
  workgroupBarrier();
  if(lane<CONTINUUM_BATCH&&continuumCardBase!=CONTINUUM_FULL){
    let cw=continuumCardWant[lane];
    if((cw>>16u)!=0u){continuumLists[continuumCardBase+(cw&65535u)]=vec2u(batch+lane,CONTINUUM_SPLAT_ENTRY<<28u);}
  }
  let total=continuumSlotStart[CONTINUUM_BATCH];
  if(total>0u){
    // Every candidate cluster of the workgroup's instances tried by its lanes together, and counted at each level.
    var pack=0u;
    for(var iter=0u;;iter++){
      let f=iter*${W}u+lane;
      if(f>=total){break;}
      let slot=continuumSlotOf(f);
      let tried=continuumTry(slot,f-continuumSlotStart[slot]);
      let mask=tried&255u;
      if(iter<CONTINUUM_KEPT_ITERS){
        let sub=iter&3u;
        if(sub==0u){pack=mask;}else{pack|=mask<<(sub*8u);}
        if(sub==3u||f+${W}u>=total){continuumKept[(iter>>2u)*${W}u+lane]=pack;}
      }
      if(mask!=0u){
        let small=(tried>>8u)&1u;
        for(var j=0u;j<CONTINUUM_LEVELS;j++){
          if((mask&(1u<<j))!=0u){atomicAdd(&continuumWanted[(slot*3u+small)*CONTINUUM_LEVELS+j],1u);}
          if((mask&(16u<<j))!=0u){atomicAdd(&continuumWanted[(slot*3u+2u)*CONTINUUM_LEVELS+j],1u);}
        }
        if((mask&1u)!=0u){atomicAdd(&continuumCounted[small],tried>>16u);}
      }
    }
  }
  workgroupBarrier();
  // Each instance's clusters are listed at the finest level the plan leaves it that the lists hold whole, after asking
  // the plan for every level. Where its larger clusters found room and its small ones none, the room taken is left
  // holding entries of nothing.
  if(total>0u&&lane<CONTINUUM_BATCH){
    let planKey=continuumSlotKey[lane];
    for(var j=0u;j<CONTINUUM_LEVELS;j++){
      for(var r=0u;r<3u;r++){continuumAsk(select(r,4u,r==2u),j,planKey,atomicLoad(&continuumWanted[(lane*3u+r)*CONTINUUM_LEVELS+j]));}
    }
    var chosen=vec4u(CONTINUUM_LEVELS,CONTINUUM_LEVELS,0u,0u);var base=vec4u(0u);
    for(var j=continuumFloor(0u,planKey);j<CONTINUUM_LEVELS;j++){
      let big=atomicLoad(&continuumWanted[(lane*3u)*CONTINUUM_LEVELS+j]);let small=atomicLoad(&continuumWanted[(lane*3u+1u)*CONTINUUM_LEVELS+j]);
      if(big+small==0u){chosen.x=j;break;}
      var a=0u;var b=0u;
      if(big>0u){a=continuumReserve(0u,big);if(a==CONTINUUM_FULL){continue;}}
      if(small>0u){
        b=continuumReserve(1u,small);
        if(b==CONTINUUM_FULL){for(var e=0u;e<big;e++){continuumLists[a+e]=vec2u(0u);}continue;}
      }
      chosen.x=j;base.x=a;base.y=b;break;
    }
    // The captures' copies of the clusters the view lists, where the sea can reach the instance.
    if(continuumSlotWet[lane].w!=0u&&chosen.x<CONTINUUM_LEVELS){
      let big=atomicLoad(&continuumWanted[(lane*3u)*CONTINUUM_LEVELS+chosen.x]);let small=atomicLoad(&continuumWanted[(lane*3u+1u)*CONTINUUM_LEVELS+chosen.x]);
      if(big>0u){continuumSlotWet[lane].x=continuumReserve(${CONTINUUM_CAPTURE_LISTS[0]}u,big);}
      if(small>0u){continuumSlotWet[lane].y=continuumReserve(${CONTINUUM_CAPTURE_LISTS[1]}u,small);}
    }
    for(var j=continuumFloor(3u,planKey);j<CONTINUUM_LEVELS;j++){
      let n=atomicLoad(&continuumWanted[(lane*3u+2u)*CONTINUUM_LEVELS+j]);
      if(n==0u){chosen.y=j;break;}
      let a=continuumReserve(5u,n);
      if(a!=CONTINUUM_FULL){chosen.y=j;base.z=a;break;}
    }
    continuumChosen[lane]=chosen;continuumBase[lane]=base;
  }
  workgroupBarrier();
  if(total>0u){
    for(var iter=0u;;iter++){
      let f=iter*${W}u+lane;
      if(f>=total){break;}
      var mask=0u;
      var smallKnown=false;
      var small=0u;
      var slot=0u;
      var i=0u;
      if(iter<CONTINUUM_KEPT_ITERS){
        mask=(continuumKept[(iter>>2u)*${W}u+lane]>>((iter&3u)*8u))&255u;
        if(mask==0u){continue;}
        slot=continuumSlotOf(f);i=f-continuumSlotStart[slot];
      }else{
        slot=continuumSlotOf(f);i=f-continuumSlotStart[slot];
        let tried=continuumTry(slot,i);
        mask=tried&255u;
        if(mask==0u){continue;}
        small=(tried>>8u)&1u;smallKnown=true;
      }
      let chosen=continuumChosen[slot];let base=continuumBase[slot];
      let wantView=chosen.x<CONTINUUM_LEVELS&&(mask&(1u<<chosen.x))!=0u;
      let wantShd=chosen.y<CONTINUUM_LEVELS&&(mask&(16u<<chosen.y))!=0u;
      if(!wantView&&!wantShd){continue;}
      let clusterIdx=continuumSlotTries[slot].z+i;
      let entry=vec2u(batch+slot,clusterIdx|(CONTINUUM_CLUSTER_ENTRY<<28u));
      if(wantView){
        if(!smallKnown){
          let at=continuumAtlas[${CONTINUUM_HEADER.clustersAt}u]+clusterIdx*${CONTINUUM_CLUSTER_WORDS}u;
          small=select(0u,1u,(continuumWord(at+15u)&255u)<=${CONTINUUM_SMALL_CLUSTER}u);
        }
        let listed=atomicAdd(&continuumCursor[slot*3u+small],1u);
        continuumLists[select(base.x,base.y,small==1u)+listed]=entry;
        let wetAt=select(continuumSlotWet[slot].x,continuumSlotWet[slot].y,small==1u);
        if(wetAt!=CONTINUUM_FULL){continuumLists[wetAt+listed]=entry;}
      }
      if(wantShd){
        continuumLists[base.z+atomicAdd(&continuumCursor[slot*3u+2u],1u)]=entry;
      }
    }
  }
  // Each far body's pieces, and its shadow's.
  for(var k=0u;k<CONTINUUM_BATCH;k++){
    let far=continuumSlotFar[k];
    let wetFar=continuumSlotWet[k].z;
    if(far.x!=CONTINUUM_FULL){
      for(var c=lane;c<far.y;c+=${W}u){
        continuumLists[far.x+c]=vec2u(batch+k,c|(CONTINUUM_FAR_ENTRY<<28u));
        if(wetFar!=CONTINUUM_FULL){continuumLists[wetFar+c]=vec2u(batch+k,c|(CONTINUUM_FAR_ENTRY<<28u));}
      }
    }
    if(far.z!=CONTINUUM_FULL){for(var c=lane;c<far.w;c+=${W}u){continuumLists[far.z+c]=vec2u(batch+k,c|(CONTINUUM_FAR_ENTRY<<28u));}}
    // Its cell cards: every cell of the level entered, then of the next, each its cell | its level << 16.
    let cells=continuumSlotCells[k];
    if(cells.x!=CONTINUUM_FULL){
      for(var c=lane;c<cells.y+cells.z;c+=${W}u){
        let later=c>=cells.y;
        continuumLists[cells.x+c]=vec2u(batch+k,select(c,c-cells.y,later)|((cells.w+select(0u,1u,later))<<16u)|(CONTINUUM_CARD_ENTRY<<28u));
      }
    }
  }
  // The real triangles the scene's error asked of this workgroup, for the census: once a workgroup.
  workgroupBarrier();
  if(lane<${CONTINUUM_VIEW_LISTS}u){let n=atomicLoad(&continuumCounted[lane]);if(n>0u){atomicAdd(&continuumDraws[${CONTINUUM_DRAW_WORDS}u+lane],n);}}
}
`;
}

// A scene whose records its family's own pass stands each frame: the select's workgroups for what it stood (the
// family's [workgroups across, rows, 1, records stood]), CONTINUUM_BATCH records a workgroup, and how many to cut.
export function continuumBatchArgsWGSL() {
  return /* wgsl */`
@group(0) @binding(0) var<storage,read> continuumStood:array<u32>;
@group(0) @binding(1) var<storage,read_write> continuumBatches:array<u32>;
@group(0) @binding(2) var<storage,read_write> continuumCut:array<u32>;
@group(0) @binding(3) var<uniform> continuumCounts:vec4u;
@compute @workgroup_size(1) fn continuumBatchArgs(){
  let n=min(continuumStood[3],continuumCounts.x);
  let groups=(n+${CONTINUUM_BATCH - 1}u)/${CONTINUUM_BATCH}u;
  continuumBatches[0]=min(groups,${CONTINUUM_ROW}u);continuumBatches[1]=(groups+${CONTINUUM_ROW - 1}u)/${CONTINUUM_ROW}u;continuumBatches[2]=1u;
  continuumCut[${CONTINUUM_LIVE_WORD}u]=n;
}
`;
}

// --------------------------------------------------------------------------------------------- drawing
// A splat's corner, facing the eye from its centre: the triangle that circumscribes the outline's ellipse, shrunk by
// its type's baked area factor to the outline's own area, and grown where the splat is thinned to keep the horizon's
// covered area. Its outline is the body's as seen along the line to the eye: across, its footprint's radius; up the
// screen, between its height and its footprint by how steeply it is seen, so from above it is the ground it covers and
// from the side the outline the bake measured. Its depth is drawn at its near side (pull), where the body's surface
// would be.
export const CONTINUUM_SPLAT = /* wgsl */`
struct ContinuumSplat { local:vec3f, world:vec3f, toward:vec3f, corner:vec2f, pull:f32 };
fn continuumSplatCorner(record:ContinuumRecord,eye:vec3f,vertex:u32,thinned:f32)->ContinuumSplat {
  let model=continuumTypeOf(record);
  var out:ContinuumSplat;
  out.local=vec3f(continuumTypeF(model,${CONTINUUM_TYPE.splatCentre}u),continuumTypeF(model,${CONTINUUM_TYPE.splatCentre + 1}u),continuumTypeF(model,${CONTINUUM_TYPE.splatCentre + 2}u));
  let centre=continuumPlace(record,out.local);
  out.toward=normalize(eye-centre);
  let stretch=continuumStretch(record);
  let rx=continuumTypeF(model,${CONTINUUM_TYPE.splatRx}u)*0.5*(stretch.x+stretch.z)*record.place.w;
  let ry=continuumTypeF(model,${CONTINUUM_TYPE.splatRy}u)*stretch.y*record.place.w;
  let axis=continuumQuat(record.turn,vec3f(0.0,1.0,0.0));
  let s=clamp(abs(dot(axis,out.toward)),0.0,1.0);let c=sqrt(max(1.0-s*s,0.0));
  var right=cross(axis,out.toward);
  if(dot(right,right)<1e-6){let x=continuumQuat(record.turn,vec3f(1.0,0.0,0.0));right=x-out.toward*dot(x,out.toward);}
  right=normalize(right);
  let up=cross(out.toward,right);
  let k=continuumTypeF(model,${CONTINUUM_TYPE.splatArea}u)*thinned;
  out.corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  out.world=centre+right*(out.corner.x*rx*k)+up*(out.corner.y*sqrt(rx*rx*s*s+ry*ry*c*c)*k);
  out.pull=sqrt(rx*rx*c*c+ry*ry*s*s);
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
  optics:vec4f,  // its optical moments (ContinuumOptic): a cluster's CONTINUUM_NEAR_OPTICS, a splat's its whole body's
  albedo:vec4f,  // the far body's albedo moment, where its family gave one (a cluster's: zero)
};
// What of the light reaches what a pixel of a far body sees (rule 3.3), from its optical moments, for a material to
// light it by: x the sun on the side it is seen from, after the body above it (as deep as it is seen, along the way
// the sun comes in); y the sun from behind that passes clean through to the eye; z the sky that reaches it; w how
// soft its normal is (0 a plain face, toward 1 leaves at every angle), so how far its light wraps past the terminator.
// Near, (1, 0, 1, 0): the clusters are the body.
fn continuumOpticLight(n:vec3f,sun:vec3f,optics:vec4f)->vec4f {
  let nl=dot(n,sun);
  // A line of sight comes in about the normal, a third of its depth aslant.
  let deep=optics.y*0.67;
  let front=exp(-deep/max(nl+0.25,0.12));
  let behind=max(-nl,0.0);
  let through=behind*pow(clamp(optics.z,0.0,1.0),1.0/max(behind,0.25));
  return vec4f(front,through,optics.x,1.0-clamp(optics.w,0.0,1.0));
}
// Where a point of the scene's frame is drawn; 'pull' metres nearer the eye along its line of sight for its depth.
fn continuumClipPulled(world:vec3f,pull:f32)->vec4f {
  let relative=world+continuumShift()-F.camPos.xyz;
  return F.viewProj*vec4f(earthCurve(relative*max(1.0-pull/max(length(relative),1e-3),0.05),F.camPos.y),1.0);
}
fn continuumClip(world:vec3f)->vec4f { return F.viewProj*vec4f(earthCurve(world+continuumShift()-F.camPos.xyz,F.camPos.y),1.0); }
// The eye, in the scene's frame.
fn continuumEye()->vec3f { return F.camPos.xyz-continuumShift(); }
// A corner of a cluster or far-body entry as a material reads it, or false where the entry draws nothing there.
fn continuumSurfaceOf(s:ptr<function,ContinuumSurface>,record:ContinuumRecord,what:u32,item:u32,vertex:u32,step:u32,morph:f32,lift:vec3f)->bool {
  var corner:ContinuumCorner;
  if(what==CONTINUUM_CLUSTER_ENTRY){corner=continuumClusterCorner(record,item,vertex);}
  else{corner=continuumFarCorner(record,(*s).model,item,vertex,step,morph);}
  if(!corner.shown){return false;}
  (*s).local=corner.posed.position;(*s).world=continuumPlace(record,(*s).local)+lift;(*s).normal=continuumTurnNormal(record,corner.posed.normal);
  (*s).high=corner.high;(*s).word=corner.word;(*s).vertex=corner.vertex;(*s).wear=max(corner.posed.wear,continuumSurfaceWear(corner.vertex));
  (*s).optics=corner.optics;(*s).albedo=corner.albedo;
  return true;
}
`;

// A family's material: what it brings to the pipeline family, as data.
//   name      its programs' names, and the prefix of its two functions: <name>Varying(s:ContinuumSurface,
//             v:ptr<function,ContinuumVarying>), which writes its own varyings for a corner, and <name>Shade(v:
//             ContinuumVarying, front:bool)->vec4f, which shades a fragment (its colour, opaque).
//   prelude() the WGSL its shading needs, with its own bindings (group 0 and 1; F, the frame, among them).
//   core      whether its prelude already holds the shared core (CONTINUUM_CORE_WGSL).
//   data      the group and first binding the scene's data takes in its programs (continuumDataBindings: the atlas's
//             first page, the records, the lists, the view, the poses, then its further pages).
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
//   shadow    how its shadow differs from an opaque body's, if it does: { prelude(), varyings, wgsl(), own, coverage,
//             canvas }. Its shadow program has the frame's two uniforms in group 0 (SH, the shadow's frame, at 0; F at
//             1), the scene's data in group 1, and, if `own`, the material's own bindings in group 2, whose entries its
//             family hands drawShadow (js/continuum-scene.js); its prelude() declares them and names every one. wgsl()
//             writes <name>ShadowVarying(s:ContinuumSurface, v:ptr<function,ContinuumShadowVarying>) and, as it says:
//               coverage  <name>ShadowCoverage(v:ContinuumShadowVarying)->u32, the samples (of one) its surface covers;
//               canvas    <name>ShadowCanvas(v:ContinuumShadowVarying)->bool, whether a corner is of cloth that lets
//                         light through, and <name>ShadowTransmit(v:ContinuumShadowVarying)->vec3f, what of the sun's
//                         light passes it. Its 'solid' shadow then casts all else and its 'canvas' shadow the cloth,
//                         with that colour (CONTINUUM_SHADOW_CLOTH_FORMAT).
// A heightfield (the land, js/wgsl/land-continuum.js) is cut by its own quadtree select, which lists nodes, not this
// one's clusters; it shares the core, the scene's pixel error and this family of programs. It sets instead:
//   heightfield true.
//   varying    its varying struct's name.
//   entryLayout the vertex buffers its lists are read through (one node a draw).
//   prelude(pass) its WGSL for that pass ('view' or 'capture'), its own data among it.
//   wgsl()     <name>Vertex(vertex:u32, node:u32, coarse:bool)->varying and <name>Shade(v:varying)->vec4f, opaque,
//              with no handoff; coarse for the captures' cut.
const continuumVaryingFields = (varyings, from) => varyings.map(([name, type, flat], i) => `  @location(${from + i})${flat ? ' @interpolate(flat)' : ''} ${name}:${type},`).join('\n');
function continuumVaryingWGSL(material) {
  return /* wgsl */`
struct ContinuumVarying {
  @invariant @builtin(position) position:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) @interpolate(flat) coverage:vec4u,   // x the entry (1 clusters, 2 far body, 3 splat, 5 card), y handoff | splat << 8, z the record's seed, w samples
  @location(3) optics:vec4f,                         // its optical moments (ContinuumSurface.optics)
${continuumVaryingFields(material.varyings, 4)}
};
struct ContinuumCoverage { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
// One corner of an entry. Coarse: an entry of the shadow map's lists, its far body at the step its shadow takes,
// unmorphed (an under-water capture draws those, as the sea blurs anything finer). An entry of nothing draws nothing.
fn continuumVertex(vertex:u32,listed:ContinuumEntry,coarse:bool)->ContinuumVarying {
  let touched=continuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  var out:ContinuumVarying;
  if(what==0u){out.position=CONTINUUM_HIDDEN;return out;}
  var state=continuumState(instance);
  let lift=continuumLift(state,coarse);
  let record=continuumRecords[instance];
  if(coarse){
    state.y=state.y>>16u;state.z=0u;
    state.x=select(continuumShadowShare(instance),0u,what==CONTINUUM_CLUSTER_ENTRY&&continuumDetailCluster(continuumTypeOf(record),item));
  }
  var s:ContinuumSurface;
  s.instance=instance;s.what=what;s.model=continuumTypeOf(record);s.record=record;s.vertex=CONTINUUM_NO_VERTEX;
  var pull=0.0;
  if(what==CONTINUUM_SPLAT_ENTRY){
    let splat=continuumSplatCorner(record,continuumEye(),vertex,unpack2x16float(state.w).x);
    s.local=splat.local;s.world=splat.world+lift;s.normal=splat.toward;s.corner=splat.corner;pull=splat.pull;
    let body=continuumBodyOptic(s.model);s.optics=body.optics;s.albedo=body.albedo;
  }else if(!continuumSurfaceOf(&s,record,what,item,vertex,state.y&65535u,bitcast<f32>(state.z),lift)){out.position=CONTINUUM_HIDDEN;return out;}
  out.world=s.world+vec3f(touched);
  out.normal=s.normal;out.optics=s.optics;
  out.position=continuumClipPulled(out.world,pull);
  out.coverage=vec4u(what,select(state.x&65535u,continuumClusterYield(instance,state.x&65535u),what==CONTINUUM_CLUSTER_ENTRY&&!coarse),record.tag.z,continuumView.counts.y);
  ${material.name}Varying(s,&out);
  return out;
}
`;
}

// The shadow map's programs: the coarse cut's corners from the light, each fragment keeping its share of the handoff
// between the far body and the clusters (a map holds one sample, so the share is a hash's dither of texels) and, as
// the material says, what its surface covers; a 'canvas' shadow writes what its cloth lets through.
function continuumShadowWGSL(material, part) {
  const hook = material?.shadow ?? null, name = material?.name;
  if (part !== 'whole' && !hook?.canvas) throw Error(`The ${name ?? 'kernel'} shadow has no ${part} part`);
  const sides = part === 'solid' ? `if(${name}ShadowCanvas(out)){out.position=CONTINUUM_HIDDEN;}\n` : part === 'canvas' ? `if(!${name}ShadowCanvas(out)){out.position=CONTINUUM_HIDDEN;}\n` : '';
  const mask = `continuumMask(v.coverage,v.position.xy,${material?.salt ?? 0}u)${hook?.coverage ? `&${name}ShadowCoverage(v)` : ''}`;
  return /* wgsl */`
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@group(0) @binding(1) var<uniform> F:Frame;
${hook ? hook.prelude() : ''}
struct ContinuumShadowVarying {
  @builtin(position) position:vec4f,
  @location(0) @interpolate(flat) coverage:vec4u,  // x the entry, y the far body's share of the map, z the record's seed, w 1
  @location(1) normal:vec3f,
${hook ? continuumVaryingFields(hook.varyings, 2) : ''}
};
${hook ? hook.wgsl() : ''}
@vertex fn continuumShadowVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumShadowVarying {
  let touched=continuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  var out:ContinuumShadowVarying;
  if(what==0u){out.position=CONTINUUM_HIDDEN;return out;}
  let record=continuumRecords[instance];
  let state=continuumState(instance);
  var s:ContinuumSurface;
  s.instance=instance;s.what=what;s.model=continuumTypeOf(record);s.record=record;s.vertex=CONTINUUM_NO_VERTEX;
  if(!continuumSurfaceOf(&s,record,what,item,vertex,state.y>>16u,0.0,continuumLift(state,false))){out.position=CONTINUUM_HIDDEN;return out;}
  out.position=SH.lightView*vec4f(s.world-SH.origin.xyz+vec3f(touched),1.0);
  out.normal=s.normal;
  out.coverage=vec4u(what,select(continuumShadowShare(instance),0u,what==CONTINUUM_CLUSTER_ENTRY&&continuumDetailCluster(s.model,item)),record.tag.z,1u);
  ${hook ? `${name}ShadowVarying(s,&out);\n  ${sides}` : ''}return out;
}
${part === 'canvas' ? /* wgsl */`
struct ContinuumShadowCloth { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
@fragment fn continuumShadowFS(v:ContinuumShadowVarying)->ContinuumShadowCloth {
  var out:ContinuumShadowCloth;
  out.colour=vec4f(${name}ShadowTransmit(v),1.0);
  out.mask=${mask};
  return out;
}` : /* wgsl */`
// Return a struct rather than a bare @builtin(sample_mask) u32 so Apple WebKit's parseFragmentReturnType
// never records a scalar MTLDataTypeUInt (33) at location(0) via returnTypeLocation().value_or(0).
struct ContinuumShadowMask { @builtin(sample_mask) mask:u32 };
@fragment fn continuumShadowFS(v:ContinuumShadowVarying)->ContinuumShadowMask {
  return ContinuumShadowMask(${mask});
}`}
`;
}

const continuumVisibilityWGSL = () => /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
struct ContinuumVisibilityVarying {
  @invariant @builtin(position) position:vec4f,
  @location(0) @interpolate(flat) coverage:vec4u
};
@vertex fn continuumVisibilityVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumVisibilityVarying {
  let touched=continuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  var out:ContinuumVisibilityVarying;
  if(what==0u){out.position=CONTINUUM_HIDDEN;return out;}
  let state=continuumState(instance);
  let lift=continuumLift(state,false);
  let record=continuumRecords[instance];
  var s:ContinuumSurface;
  s.instance=instance;s.what=what;s.model=continuumTypeOf(record);s.record=record;s.vertex=CONTINUUM_NO_VERTEX;
  var pull=0.0;
  if(what==CONTINUUM_SPLAT_ENTRY){
    let splat=continuumSplatCorner(record,continuumEye(),vertex,unpack2x16float(state.w).x);
    s.local=splat.local;s.world=splat.world+lift;s.normal=splat.toward;s.corner=splat.corner;pull=splat.pull;
  }else if(!continuumSurfaceOf(&s,record,what,item,vertex,state.y&65535u,bitcast<f32>(state.z),lift)){out.position=CONTINUUM_HIDDEN;return out;}
  out.position=continuumClipPulled(s.world+vec3f(touched),pull);
  out.coverage=vec4u(what,select(state.x&65535u,continuumClusterYield(instance,state.x&65535u),what==CONTINUUM_CLUSTER_ENTRY),record.tag.z,continuumView.counts.y);
  return out;
}
// Return a struct carrying @location(0) vec4f alongside @builtin(sample_mask) u32: Safari/WebKit WebGPU
// rejects a bare scalar u32 return type (MTLDataTypeUInt=33) when targets[0] is rgba16float (115), even with writeMask: 0.
struct ContinuumVisibilityOut { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
@fragment fn continuumVisibilityFS(v:ContinuumVisibilityVarying)->ContinuumVisibilityOut {
  return ContinuumVisibilityOut(vec4f(0.0), continuumMask(v.coverage,v.position.xy,continuumView.counts.w&0x7fffffffu));
}
`;

// Relightable octahedral G-buffer card baker (AGENTS.md rule 3): renders each type's level-0 clusters from 36 biased
// hemi-octahedral orthographic views into a 4x MSAA G-buffer (albedo + view-tangent normal + depth + material flag)
// with zero discard. Group 0: the material's own pure-albedo textures; Group 1: continuumData + continuumCardViews.
function continuumCardBakeWGSL(material) {
  const hook = material.cardBake, name = material.name;
  return /* wgsl */`
${hook.prelude ? hook.prelude() : ''}
struct ContinuumCardView { sphere:vec4f, right:vec4f, up:vec4f, dir:vec4f, info:vec4u };
struct ContinuumCardSample { albedo:vec3f, alpha:f32, normal:vec3f, matFlag:f32 };
@group(1) @binding(12) var<storage,read> continuumCardViews:array<ContinuumCardView>;
struct ContinuumCardBakeVarying {
  @builtin(position) position:vec4f,
  @location(0) local:vec3f,
  @location(1) normal:vec3f,
  @location(2) @interpolate(flat) viewIdx:u32,
  @location(3) @interpolate(flat) seed:u32,
${hook.varyings ? continuumVaryingFields(hook.varyings, 4) : ''}
};
struct ContinuumCardBakeOut {
  @location(0) albedo:vec4f,
  @location(1) geo:vec4f,
  @builtin(sample_mask) mask:u32
};
${hook.wgsl()}
@vertex fn continuumCardBakeVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumCardBakeVarying {
  let touched=continuumBindings();
  let viewIdx=listed.entry.x;
  let what=listed.entry.y>>28u;
  let item=listed.entry.y&0x0fffffffu;
  var out:ContinuumCardBakeVarying;
  if(what!=CONTINUUM_CLUSTER_ENTRY){out.position=CONTINUUM_HIDDEN;return out;}
  let view=continuumCardViews[viewIdx];
  let recordIdx=view.info.x;
  let record=continuumRecords[recordIdx];
  let corner=continuumClusterCorner(record,item,vertex);
  if(!corner.shown){out.position=CONTINUUM_HIDDEN;return out;}
  // A view frames its type's sphere, or (a cell card's, js/continuum-cards.js) its card's box as that view sees it:
  // one over its half-width, half-height and half-depth ride its three axes.
  let inverse=select(vec3f(1.0/max(view.sphere.w,1e-4)),vec3f(view.right.w,view.up.w,view.dir.w),view.right.w>0.0);
  let rel=corner.posed.position-view.sphere.xyz;
  let px=dot(rel,view.right.xyz)*inverse.x;
  let py=dot(rel,view.up.xyz)*inverse.y;
  let pz=dot(rel,view.dir.xyz)*inverse.z;
  out.position=vec4f(px+touched,py,clamp(0.5-0.5*pz,0.0,1.0),1.0);
  out.local=corner.posed.position;
  out.normal=normalize(corner.posed.normal+vec3f(0.0,1e-6,0.0));
  out.viewIdx=viewIdx;
  out.seed=continuumHash(corner.vertex^(viewIdx*0x9e3779b9u));
  var s:ContinuumSurface;
  s.instance=recordIdx;s.what=CONTINUUM_CLUSTER_ENTRY;s.model=continuumTypeOf(record);s.vertex=corner.vertex;
  s.record=record;s.local=corner.posed.position;s.world=corner.posed.position;s.normal=out.normal;
  s.high=corner.high;s.word=corner.word;s.wear=0.0;s.corner=vec2f(0.0);s.optics=CONTINUUM_NEAR_OPTICS;s.albedo=vec4f(0.0);
  ${name}CardBakeVarying(s,&out);
  return out;
}
@fragment fn continuumCardBakeFS(v:ContinuumCardBakeVarying,@builtin(front_facing) front:bool)->ContinuumCardBakeOut {
  let sample=${name}CardBake(v,front);
  let view=continuumCardViews[v.viewIdx];
  var n=normalize(sample.normal+vec3f(0.0,1e-6,0.0));
  if(dot(n,view.dir.xyz)<0.0){n=-n;}
  let nx=clamp(dot(n,view.right.xyz),-1.0,1.0);
  let ny=clamp(dot(n,view.up.xyz),-1.0,1.0);
  let depth01=clamp(v.position.z,0.0,1.0);
  let a=clamp(sample.alpha,0.0,1.0);
  let mask=select(0u,continuumSamples(a,v.position.xy,4u,v.seed),a>0.01);
  return ContinuumCardBakeOut(vec4f(clamp(sample.albedo,vec3f(0.0),vec3f(4.0)),1.0),vec4f(nx,ny,depth01,clamp(sample.matFlag,0.0,1.0)),mask);
}
`;
}

// A material's own WGSL with all it draws by: its prelude, the core, the scene's data, the kinds, the surface and
// varying it writes, and its two functions. Its view and capture are composed on it, and so are its cell cards
// (js/wgsl/continuum-cards.js continuumCellCardWGSL), which it shades as it shades its clusters.
export function continuumMaterialWGSL(material, pass, paging, air = !material.air ? '' : 'fn continuumAir(colour:vec3f,world:vec3f)->vec3f { return surfaceAir(colour,world); }\n') {
  return material.prelude(pass) + (material.core ? '' : CONTINUUM_CORE_WGSL) + continuumDataWGSL(material.data.group, material.data.binding, 'read', paging)
    + continuumCommonWGSL(paging) + continuumKindsWGSL() + continuumTouchWGSL(paging) + CONTINUUM_SPLAT + CONTINUUM_SURFACE + continuumVaryingWGSL(material) + air + material.wgsl();
}

// Every program of the one family, composed: the select ('select'), the shadow map's ('shadow': the kernel's, or a
// material's `part` of it), the visibility prepass ('visibility'), the octahedral card baker ('cardBake'), and a
// material's view ('view') or under-water capture ('capture', with `capture` the water's own tail: js/water-optics.js
// captureTail), for an atlas bound in `paging`'s pages.
export function continuumModuleWGSL({ pass, material = null, capture = null, paging = CONTINUUM_SINGLE_PAGE, part = 'whole' }) {
  if (pass === 'select') return continuumSelectWGSL(paging);
  if (pass === 'cardBake') {
    if (!material?.cardBake) throw Error(`The ${material?.name ?? 'unknown'} material has no cardBake hook`);
    return CONTINUUM_CORE_WGSL + continuumDataWGSL(1, 0, 'read', paging) + continuumCommonWGSL(paging)
      + 'fn continuumPose(record:ContinuumRecord,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed { return p; }\n'
      + continuumTouchWGSL(paging)
      + /* wgsl */`struct ContinuumSurface { instance:u32, what:u32, model:u32, vertex:u32, record:ContinuumRecord, local:vec3f, world:vec3f, normal:vec3f, high:u32, word:u32, wear:f32, corner:vec2f, optics:vec4f, albedo:vec4f };\n`
      + continuumCardBakeWGSL(material);
  }
  if (pass === 'visibility') {
    return FRAME_WGSL + CONTINUUM_CORE_WGSL + continuumDataWGSL(1, 0, 'read', paging) + continuumCommonWGSL(paging) + continuumKindsWGSL() + continuumTouchWGSL(paging)
      + CONTINUUM_SPLAT + CONTINUUM_SURFACE + continuumVisibilityWGSL();
  }
  if (pass === 'shadow') {
    if (material && !material.shadow) throw Error(`The ${material.name} material casts as the kernel does: draw its shadow with the kernel's program`);
    return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + continuumDataWGSL(1, 0, 'read', paging) + continuumCommonWGSL(paging) + continuumKindsWGSL() + continuumTouchWGSL(paging)
      + CONTINUUM_SPLAT + CONTINUUM_SURFACE + continuumShadowWGSL(material, part);
  }
  if (!material || (pass !== 'view' && pass !== 'capture')) throw Error(`No continuum pass ${pass}`);
  if (pass === 'capture' && (!material.capture || !capture)) throw Error(`The ${material.name} material has no under-water capture`);
  if (material.heightfield) {
    const V = material.varying, name = material.name;
    const body = material.prelude(pass) + (material.core ? '' : CONTINUUM_CORE_WGSL) + material.wgsl();
    const vertex = (entry, coarse) => `@vertex fn ${entry}(@builtin(vertex_index) vertex:u32,@location(0) node:u32)->${V} { return ${name}Vertex(vertex,node,${coarse}); }\n`;
    if (pass === 'view') return body + vertex('continuumVS', false) + `@fragment fn continuumFS(v:${V})->@location(0) vec4f { return ${name}Shade(v); }\n`;
    // Ground is captured a little above the surface, so a shore seen through a wave has ground behind it.
    return capture.directive + body + vertex('continuumCaptureVS', true) + `fn waterCaptureMaterial(v:${V})->vec4f { return ${name}Shade(v); }\n`
      + capture.tail({ fragment: `@fragment fn submergedFS(v:${V})->@location(0) vec4f`, args: 'v', world: 'v.world', land: true });
  }
  const air =!material.air ? '' : pass === 'view'
    ? 'fn continuumAir(colour:vec3f,world:vec3f)->vec3f { return surfaceAir(colour,world); }\n'
    // Under water the water's surface applies the air once; the call is kept so that every binding stays reachable.
    : 'fn continuumAir(colour:vec3f,world:vec3f)->vec3f { if(F.screen.x>=0.0&&captureMode.x<.5){return colour;} return surfaceAir(colour,world); }\n';
  const body = continuumMaterialWGSL(material, pass, paging, air);
  // The samples a fragment keeps: its share of the handoff, and the material's mask and coverage where it has them.
  const mask = `continuumMask(v.coverage,v.position.xy,${material.salt}u)${material.mask ? `&${material.name}Mask(v,front)` : ''}${material.coverage ? `&${material.name}Coverage(v,front)` : ''}`;
  if (pass === 'view') {
    return body + /* wgsl */`
@vertex fn continuumVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumVarying { return continuumVertex(vertex,listed,false); }
@fragment fn continuumFS(v:ContinuumVarying,@builtin(front_facing) front:bool)->ContinuumCoverage {
  var out:ContinuumCoverage;
  out.mask=${mask};
  out.colour=${material.name}Shade(v,front);
  return out;
}
@fragment fn continuumEqualFS(v:ContinuumVarying,@builtin(front_facing) front:bool)->@location(0) vec4f {
  return ${material.name}Shade(v,front);
}
`;
  }
  // A capture keeps only what lies on its side of the sea. An instance whose whole sphere stands clear of the highest
  // (or lowest) the sea now runs (`captureMode.y`, js/water-optics.js setSeaCrest) places no vertex: every family's, by
  // its own bound, as its fragments would all leave.
  const captureSphere = `vec4f(continuumTypeF(m,${CONTINUUM_TYPE.sphere}u),continuumTypeF(m,${CONTINUUM_TYPE.sphere + 1}u),continuumTypeF(m,${CONTINUUM_TYPE.sphere + 2}u),continuumTypeF(m,${CONTINUUM_TYPE.sphere + 3}u))`;
  const skipHigh = `if(listed.entry.x<continuumView.counts.x){let r=continuumRecords[listed.entry.x];let m=continuumTypeOf(r);let b=continuumSphere(r,CONTINUUM_WHOLE,${captureSphere});`
    + `let y=continuumPlace(r,b.xyz).y;let reach=b.w*continuumScale(r)+bitcast<f32>(r.tag.w);`
    + `if(b.w>=0.0&&select((y-reach>captureMode.y),(y+reach< -captureMode.y),(captureMode.x>0.5))){var h:ContinuumVarying;h.position=CONTINUUM_HIDDEN;return h;}}`;
  return capture.directive + body + /* wgsl */`
@vertex fn continuumCaptureVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumVarying { ${skipHigh}var out=continuumVertex(vertex,listed,false);out.coverage.w=1u;return out; }
fn waterCaptureMaterial(v:ContinuumVarying,front:bool)->vec4f { return ${material.name}Shade(v,front); }
` + capture.tail({ fragment: 'fn continuumCaptured(v:ContinuumVarying,front:bool)->vec4f', args: 'v,front', world: 'v.world' }) + /* wgsl */`
// Its one sample kept as the view keeps its samples: by the handoff's share and the material's mask and coverage (what
// shot has holed, parted or torn), so what the view leaves out reads from below as from above.
@fragment fn submergedFS(v:ContinuumVarying,@builtin(front_facing) front:bool)->ContinuumCoverage {
  var out:ContinuumCoverage;
  out.mask=${mask};
  out.colour=continuumCaptured(v,front);
  return out;
}
`;
}
