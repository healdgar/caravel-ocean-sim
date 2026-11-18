// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The animal continuum's GPU side (js/animal-continuum.js, js/animal-continuum-draw.js). The cut and its handoffs are
// the shared core's (js/continuum-core.js); this supplies how an animal's data is read and placed. How it is posed and
// worn is its family's: the herds' rig (js/wgsl/herds.js), the sea's strokes and the whale's skin (js/wgsl/dolphins.js).
//
// One workgroup an animal decides each frame how it is drawn: clusters of its type cut by projected error, its far
// body at one step of its collapse, its splat, or two of them sharing each pixel's samples across a band; and the
// step its shadow (or its picture under the water) is cast at. Its lanes then enter its far body's pieces and cut its
// type's hierarchy. Every list entry is one instance of a fixed-size draw: a cluster (384 vertices, or 96 for a small
// one), 32 far-body triangles (96), or a splat (3); the unused vertices are degenerate. A family's view draws its four
// lists with one pipeline; its shadow map or water capture draws the fifth.
//
// Each cluster's spheres hold it in every pose its rig takes standing, so a standing animal is placed by its frame
// alone (where it stands, its yaw, pitch, roll and scale) and every cluster is cut and culled by its own spheres. An
// exact animal (felled, shattered) or a sea animal (whose pitch and height the waves give it) is cut whole at the
// nearest point of a sphere that holds it, every cluster at the finest its error bound allows there; an exact one is
// never handed to its far body or splat.
import { FRAME_WGSL } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import {
  ANIMAL_CONTINUUM_HEADER, ANIMAL_CONTINUUM_TYPE, ANIMAL_CONTINUUM_TYPE_WORDS, ANIMAL_CONTINUUM_CLUSTER_WORDS, ANIMAL_CONTINUUM_VERTEX_WORDS,
  ANIMAL_CONTINUUM_STEP_WORDS, ANIMAL_CONTINUUM_TRIANGLE_WORDS, ANIMAL_CONTINUUM_NEVER, ANIMAL_CONTINUUM_CHUNK_TRIANGLES, ANIMAL_CONTINUUM_CLUSTER_TRIANGLES,
  ANIMAL_CONTINUUM_SMALL_CLUSTER, ANIMAL_CONTINUUM_HOPS, ANIMAL_PLACE_CODE, ANIMAL_PLACE_SEED, ANIMAL_PLACE_EXACT, ANIMAL_PLACE_SHATTERED, ANIMAL_PLACE_SEA,
  ANIMAL_CONTINUUM_SEA_REACH, ANIMAL_CONTINUUM_TYPES,
} from '../animal-continuum.js';

// The lists an animal can be entered in, each with its own indirect draw, and the vertices of one entry.
export const ANIMAL_CONTINUUM_LISTS = Object.freeze(['clusters', 'small clusters', 'far body', 'splat', 'shadow']);
export const ANIMAL_CONTINUUM_INSTANCE_VERTICES = Object.freeze([3 * ANIMAL_CONTINUUM_CLUSTER_TRIANGLES, 3 * ANIMAL_CONTINUUM_SMALL_CLUSTER, 3 * ANIMAL_CONTINUUM_CHUNK_TRIANGLES, 3, 3 * ANIMAL_CONTINUUM_CHUNK_TRIANGLES]);
// The view's lists; the shadow map's (or the water capture's) is the last.
export const ANIMAL_CONTINUUM_VIEW_LISTS = 4;
export const ANIMAL_CONTINUUM_DRAW_WORDS = ANIMAL_CONTINUUM_LISTS.length * 4;
export const ANIMAL_CONTINUUM_VIEW_BYTES = 128;
// The select dispatch is laid in rows of this many workgroups, an animal to each.
export const ANIMAL_CONTINUUM_ROW = 8192;
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
export const ANIMAL_CONTINUUM_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// What the fifth list holds: nothing, or the far bodies the land's shadow map takes. (The water's picture of what
// lies under it is drawn from the view's own lists.)
export const ANIMAL_CONTINUUM_SHADOW = Object.freeze({ none: 0, land: 1 });
// How many shadow-map texels a shadow's far body may be in error.
export const ANIMAL_CONTINUUM_SHADOW_TEXELS = 1.5;
// What an entry is, in the top four bits of its second word.
export const ANIMAL_CONTINUUM_ENTRY = Object.freeze({ cluster: 1, far: 2, splat: 3 });

// What every pass knows of the atlas, of the animals and of an animal's place.
const ANIMAL_CONTINUUM_COMMON = /* wgsl */`
struct AnimalContinuumView {
  counts:vec4u,             // animals, samples a pixel, what the fifth list holds, unused
  scene:vec4f,              // the scene's pixel error, unused
  lists:array<vec4u,${ANIMAL_CONTINUUM_LISTS.length}>,     // each list's first entry and capacity
};
// An animal's place (js/animal-continuum.js ANIMAL_PLACE_FLOATS): root (x, y, z, yaw), frame (pitch, roll, scale,
// code), and its family's own pose.
struct AnimalPlace { root:vec4f, frame:vec4f, pose:vec4f, more:vec4f };
// A point of a type, in the type's own metres at rest, and its five words of skin.
struct AnimalPoint { position:vec3f, normal:vec3f, skin:vec4u, skin4:u32 };
// A corner to draw: a cluster's own point (b the same), or a far-body corner on its way from a to b.
struct AnimalCorner { a:AnimalPoint, b:AnimalPoint, morph:f32, shown:bool };
const ANIMAL_CONTINUUM_NEVER:u32=${ANIMAL_CONTINUUM_NEVER}u;
const ANIMAL_PLACE_EXACT:u32=${ANIMAL_PLACE_EXACT}u;
const ANIMAL_PLACE_SHATTERED:u32=${ANIMAL_PLACE_SHATTERED}u;
const ANIMAL_PLACE_SEA:u32=${ANIMAL_PLACE_SEA}u;
const ANIMAL_CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
fn animalPlaceOf(animal:u32)->AnimalPlace {
  let at=animal*4u;
  return AnimalPlace(animalPlaces[at],animalPlaces[at+1u],animalPlaces[at+2u],animalPlaces[at+3u]);
}
// The place's code: its type, its flags (EXACT, SHATTERED, SEA) and a seed of twelve bits for its thinning.
fn animalCodeOf(place:AnimalPlace)->u32 { return u32(max(place.frame.w,0.0)+0.5); }
fn animalTypeOf(place:AnimalPlace)->u32 { return min(animalCodeOf(place)%${ANIMAL_PLACE_CODE}u,${ANIMAL_CONTINUUM_TYPES.length - 1}u); }
fn animalFlagsOf(place:AnimalPlace)->u32 { return (animalCodeOf(place)/${ANIMAL_PLACE_CODE}u)&15u; }
fn animalSeedOf(place:AnimalPlace)->u32 { return animalCodeOf(place)/${ANIMAL_PLACE_SEED}u; }
fn animalType(archetype:u32,field:u32)->u32 { return animalAtlas[animalAtlas[${ANIMAL_CONTINUUM_HEADER.typesAt}u]+archetype*${ANIMAL_CONTINUUM_TYPE_WORDS}u+field]; }
fn animalTypeF(archetype:u32,field:u32)->f32 { return bitcast<f32>(animalType(archetype,field)); }
fn animalTypeV(archetype:u32,field:u32)->vec3f { return vec3f(animalTypeF(archetype,field),animalTypeF(archetype,field+1u),animalTypeF(archetype,field+2u)); }
fn animalRotX(v:vec3f,a:f32)->vec3f { let c=cos(a);let s=sin(a);return vec3f(v.x,v.y*c-v.z*s,v.y*s+v.z*c); }
fn animalRotY(v:vec3f,a:f32)->vec3f { let c=cos(a);let s=sin(a);return vec3f(v.x*c+v.z*s,v.y,-v.x*s+v.z*c); }
fn animalRotZ(v:vec3f,a:f32)->vec3f { let c=cos(a);let s=sin(a);return vec3f(v.x*c-v.y*s,v.x*s+v.y*c,v.z); }
// A point of the animal's own (posed, unscaled) stood where its frame stands it: root + Ry Rx Rz (scale * p).
fn animalFrame(p:vec3f,place:AnimalPlace)->vec3f { return place.root.xyz+animalRotY(animalRotX(animalRotZ(p*place.frame.z,place.frame.y),place.frame.x),place.root.w); }
fn animalFrameTurn(n:vec3f,place:AnimalPlace)->vec3f { return animalRotY(animalRotX(animalRotZ(n,place.frame.y),place.frame.x),place.root.w); }
fn animalOctahedral(e:vec2f)->vec3f {
  let f=e*2.0-1.0;
  var n=vec3f(f.x,f.y,1.0-abs(f.x)-abs(f.y));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
fn animalPoint(archetype:u32,at:u32)->AnimalPoint {
  let w0=animalAtlas[at];let w1=animalAtlas[at+1u];
  var p:AnimalPoint;
  p.position=animalTypeV(archetype,${ANIMAL_CONTINUUM_TYPE.low}u)+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))*(animalTypeF(archetype,${ANIMAL_CONTINUUM_TYPE.span}u)/65535.0);
  p.normal=animalOctahedral(unpack2x16unorm(animalAtlas[at+2u]));
  p.skin=vec4u(animalAtlas[at+3u],animalAtlas[at+4u],animalAtlas[at+5u],animalAtlas[at+6u]);
  p.skin4=animalAtlas[at+7u];
  return p;
}
fn animalStepWord(archetype:u32,step:u32,word:u32)->u32 { return animalAtlas[animalType(archetype,${ANIMAL_CONTINUUM_TYPE.steps}u)+step*${ANIMAL_CONTINUUM_STEP_WORDS}u+word]; }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn animalAncestor(archetype:u32,vertex:u32,step:u32)->u32 {
  let records=animalType(archetype,${ANIMAL_CONTINUUM_TYPE.records}u);
  var v=vertex;
  for(var hop=0u;hop<${ANIMAL_CONTINUUM_HOPS}u;hop++){
    let record=animalAtlas[records+v];
    let at=record&65535u;
    if(at==ANIMAL_CONTINUUM_NEVER||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
// A cluster's corner, its own point at both ends.
fn animalClusterCorner(archetype:u32,cluster:u32,vertex:u32)->AnimalCorner {
  var out:AnimalCorner;
  let at=animalAtlas[${ANIMAL_CONTINUUM_HEADER.clustersAt}u]+cluster*${ANIMAL_CONTINUUM_CLUSTER_WORDS}u;
  out.shown=vertex/3u<(animalAtlas[at+15u]&255u);
  if(!out.shown){return out;}
  let v=animalAtlas[animalAtlas[${ANIMAL_CONTINUUM_HEADER.indicesAt}u]+animalAtlas[at+14u]+vertex];
  out.a=animalPoint(archetype,animalAtlas[${ANIMAL_CONTINUUM_HEADER.verticesAt}u]+v*${ANIMAL_CONTINUUM_VERTEX_WORDS}u);
  out.b=out.a;
  return out;
}
// One corner of the far body at a step, on its way to where the next collapse takes it, both ends grown along their
// normals by what the collapses have taken off the outline. Each end is posed by its own skin, then the two mixed.
fn animalFarCorner(archetype:u32,chunk:u32,vertex:u32,step:u32,morph:f32)->AnimalCorner {
  var out:AnimalCorner;
  let triangle=chunk*${ANIMAL_CONTINUUM_CHUNK_TRIANGLES}u+vertex/3u;
  out.shown=triangle<animalStepWord(archetype,step,0u);
  if(!out.shown){return out;}
  let at=animalType(archetype,${ANIMAL_CONTINUUM_TYPE.triangles}u)+triangle*${ANIMAL_CONTINUUM_TRIANGLE_WORDS}u;
  let next=min(step+1u,animalType(archetype,${ANIMAL_CONTINUUM_TYPE.stepCount}u));
  let a=animalAncestor(archetype,animalAtlas[at+vertex%3u],step);let b=animalAncestor(archetype,a,next);
  let first=animalType(archetype,${ANIMAL_CONTINUUM_TYPE.chainVertices}u);
  out.a=animalPoint(archetype,first+a*${ANIMAL_CONTINUUM_VERTEX_WORDS}u);out.b=animalPoint(archetype,first+b*${ANIMAL_CONTINUUM_VERTEX_WORDS}u);
  let grow=mix(bitcast<f32>(animalStepWord(archetype,step,2u)),bitcast<f32>(animalStepWord(archetype,next,2u)),morph);
  out.a.position+=out.a.normal*grow;out.b.position+=out.b.normal*grow;
  out.morph=morph;
  return out;
}
// An animal's state for the frame, two entries ahead of the lists: handoff share | splat share << 8, step | shadow
// step << 16, then the morph and the splat's scale (f32 bits).
fn animalState(animal:u32)->vec4u { let a=animalLists[animal*2u];let b=animalLists[animal*2u+1u];return vec4u(a.x,a.y,b.x,b.y); }
// The splat's half width as the animal is seen from 'eye': its outline from the front, from the side, or between.
fn animalSplatRx(archetype:u32,place:AnimalPlace,centre:vec3f,eye:vec3f)->f32 {
  let local=animalRotY(eye-centre,-place.root.w);
  let side=abs(local.x)/max(length(local.xz),1e-4);
  return mix(animalTypeF(archetype,${ANIMAL_CONTINUUM_TYPE.splatRxFront}u),animalTypeF(archetype,${ANIMAL_CONTINUUM_TYPE.splatRxSide}u),side);
}
`;

// The data a pass binds: the atlas, the animals' places, the lists, the view.
const animalContinuumData = (group, first, lists) => /* wgsl */`
@group(${group}) @binding(${first}) var<storage,read> animalAtlas:array<u32>;
@group(${group}) @binding(${first + 1}) var<storage,read> animalPlaces:array<vec4f>;
@group(${group}) @binding(${first + 2}) var<storage,${lists}> animalLists:array<vec2u>;
@group(${group}) @binding(${first + 3}) var<uniform> animalView:AnimalContinuumView;
`;
// A drawing pass names every binding of its group once, on a path never taken, so the layout it derives holds them all.
const ANIMAL_CONTINUUM_TOUCH = /* wgsl */`
fn animalContinuumBindings()->f32 {
  if(animalView.counts.y!=0xffffffffu){return 0.0;}
  return f32(animalAtlas[0]+animalLists[0].x)+animalPlaces[0].x;
}
struct AnimalContinuumEntry { @location(0) entry:vec2u };
// The view-facing triangle of a splat: corner k of the triangle that circumscribes the outline's ellipse, shrunk to
// the ellipse's own area, and grown where the splat is thinned to keep the horizon's covered area.
struct AnimalSplatCorner { world:vec3f, toward:vec3f, right:vec3f, up:vec3f, corner:vec2f };
fn animalSplatCorner(archetype:u32,place:AnimalPlace,vertex:u32,splatScale:f32,eye:vec3f)->AnimalSplatCorner {
  var out:AnimalSplatCorner;
  let centre=animalFrame(animalTypeV(archetype,${ANIMAL_CONTINUUM_TYPE.splatCentre}u),place);
  out.toward=normalize(eye-centre);
  out.up=normalize(vec3f(0.0,1.0,0.0)-out.toward*out.toward.y+vec3f(0.0,1e-4,0.0));
  out.right=normalize(cross(out.up,out.toward));
  let k=0.7776*splatScale;
  out.corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  let rx=animalSplatRx(archetype,place,centre,eye)*place.frame.z;
  let ry=animalTypeF(archetype,${ANIMAL_CONTINUUM_TYPE.splatRy}u)*place.frame.z;
  out.world=centre+out.right*(out.corner.x*rx*k)+out.up*(out.corner.y*ry*k);
  return out;
}
// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far side the handoff's
// share and the clusters the rest; of the far side's, the splat its own share and the far body the rest. Every sample
// is drawn by exactly one of the three. coverage: what is drawn, handoff | splat << 8, the animal, samples a pixel.
fn animalContinuumMask(coverage:vec4u,pixel:vec2f)->u32 {
  let samples=clamp(coverage.w,1u,8u);
  let all=(1u<<samples)-1u;
  let seed=coverage.z*0x9e3779b9u+1u;
  let handoff=continuumSamples(f32(coverage.y&255u)/255.0,pixel,samples,seed);
  let splat=handoff&continuumSamples(f32((coverage.y>>8u)&255u)/255.0,pixel,samples,seed+7u);
  if(coverage.x==${ANIMAL_CONTINUUM_ENTRY.cluster}u){return all&~handoff;}
  if(coverage.x==${ANIMAL_CONTINUUM_ENTRY.far}u){return handoff&~splat;}
  return splat;
}
`;

// What a drawing pass appends to its family's module: the data (group `group`, from binding `first`) and how to read
// it. The module brings Frame and the core (CONTINUUM_CORE_WGSL) itself.
export function animalContinuumRenderWGSL(group, first = 0) {
  return animalContinuumData(group, first, 'read') + ANIMAL_CONTINUUM_COMMON + ANIMAL_CONTINUUM_TOUCH;
}

// --------------------------------------------------------------------------------------------- the cut
export function animalContinuumSelectWGSL() {
  const T = ANIMAL_CONTINUUM_TYPE;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + animalContinuumData(0, 2, 'read_write') + ANIMAL_CONTINUUM_COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> SH:ShadowFrame;
@group(0) @binding(6) var<storage,read_write> animalDraws:array<atomic<u32>>;
const ANIMAL_CONTINUUM_SHADOW_TEXELS:f32=${ANIMAL_CONTINUUM_SHADOW_TEXELS.toFixed(4)};
const ANIMAL_CONTINUUM_SEA_REACH:f32=${ANIMAL_CONTINUUM_SEA_REACH.toFixed(2)};
const ANIMAL_CONTINUUM_FULL:u32=0xffffffffu;
// The morph search reads the steps of the type in hand.
var<private> animalSteps:u32;
${continuumClusterPrefixWGSL('animalContinuumPrefix', (i) => `bitcast<f32>(animalAtlas[animalAtlas[${ANIMAL_CONTINUUM_HEADER.clustersAt}u]+(${i})*${ANIMAL_CONTINUUM_CLUSTER_WORDS}u+13u])`)}
${continuumMorphStepWGSL('animalContinuumMorphStep', (i) => `bitcast<f32>(animalAtlas[animalSteps+(${i})*${ANIMAL_CONTINUUM_STEP_WORDS}u+1u])`)}
fn animalOutside(at:vec3f,reach:f32)->bool {
  let m=F.viewProj;let p=vec4f(at,1.0);
  let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
  let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
  for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
  return false;
}
fn animalAppend(list:u32,count:u32)->u32 {
  if(count==0u){return ANIMAL_CONTINUUM_FULL;}
  let at=atomicAdd(&animalDraws[list*4u+1u],count);
  if(at+count>animalView.lists[list].y){atomicSub(&animalDraws[list*4u+1u],count);return ANIMAL_CONTINUUM_FULL;}
  return animalView.lists[list].x+at;
}
fn animalChunks(archetype:u32,step:u32)->u32 { return (animalStepWord(archetype,step,0u)+${ANIMAL_CONTINUUM_CHUNK_TRIANGLES - 1}u)/${ANIMAL_CONTINUUM_CHUNK_TRIANGLES}u; }
fn animalFocal()->f32 { return F.screen.y/max(2.0*length(F.camUp.xyz),1e-4); }
// Each list empty, its draw's vertex count set.
@compute @workgroup_size(32) fn animalContinuumReset(@builtin(local_invocation_index) i:u32){
  let vertices=array<u32,${ANIMAL_CONTINUUM_LISTS.length}>(${ANIMAL_CONTINUUM_INSTANCE_VERTICES.map((n) => `${n}u`).join(',')});
  if(i<${ANIMAL_CONTINUUM_DRAW_WORDS}u){atomicStore(&animalDraws[i],select(0u,vertices[i/4u],i%4u==0u));}
}
var<workgroup> animalSelected:array<vec4u,2>; // clusters to try, the first, where the far body's pieces go, how many; the fifth list's, how many, whole
var<workgroup> animalSelectedView:vec4f;      // focal, allowed pixels, scale, the error allowed at the nearest point (whole)
@compute @workgroup_size(64) fn animalContinuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let animal=group.x+group.y*${ANIMAL_CONTINUUM_ROW}u;
  if(lane==0u){
    var candidates=0u;var firstCluster=0u;var farAt=ANIMAL_CONTINUUM_FULL;var farChunks=0u;var fifthAt=ANIMAL_CONTINUUM_FULL;var fifthChunks=0u;var whole=0u;
    var focal=1.0;var pixels=1.0;var scale=1.0;var nearest=0.0;
    if(animal<animalView.counts.x){
      let place=animalPlaceOf(animal);
      let archetype=animalTypeOf(place);let flags=animalFlagsOf(place);
      var share=0u;var splatShare=0u;var step=0u;var fifthStep=0u;var morph=0.0;var splatScale=0.0;
      // A hidden animal's scale is 0.
      if(place.frame.z>0.0){
        scale=place.frame.z;
        let exact=(flags&ANIMAL_PLACE_EXACT)!=0u;let shattered=(flags&ANIMAL_PLACE_SHATTERED)!=0u;let sea=(flags&ANIMAL_PLACE_SEA)!=0u;
        whole=select(0u,1u,exact||sea);
        let sphere=vec4f(animalTypeV(archetype,${T.sphere}u),animalTypeF(archetype,${T.sphere + 3}u));
        var radius=sphere.w;
        if(exact){radius=select(animalTypeF(archetype,${T.felledRadius}u),sphere.w+animalTypeF(archetype,${T.shatterReach}u),shattered);}
        let world=animalFrame(sphere.xyz,place);
        let reach=radius*scale+select(0.0,ANIMAL_CONTINUUM_SEA_REACH,sea);
        let relative=world-F.camPos.xyz;
        let away=max(length(relative),1e-3);
        focal=animalFocal();
        pixels=animalView.scene.x;
        let steps=animalType(archetype,${T.stepCount}u);
        // The far body is drawn from the first step no heavier than the clusters' coarsest cut; finer is theirs.
        let farFirst=animalType(archetype,${T.farFirst}u);
        animalSteps=animalType(archetype,${T.steps}u);
        // The far body, coarse enough for the shadow map, casts every shadow the map holds, seen or not. Shattered
        // pieces cast none: the far body would cross them.
        if(animalView.counts.z==${ANIMAL_CONTINUUM_SHADOW.land}u&&!shattered){
          let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
          let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
          if(SH.origin.w>0.5&&abs(light.x)<1.0+r.x&&abs(light.y)<1.0+r.y&&light.z> -r.z&&light.z<1.0+r.z){
            fifthStep=max(farFirst,u32(animalContinuumMorphStep(steps,max(ANIMAL_CONTINUUM_SHADOW_TEXELS*SH.texel.x,pixels*away/focal)/scale).x));
            fifthChunks=animalChunks(archetype,fifthStep);
            fifthAt=animalAppend(4u,fifthChunks);
          }
        }
        // The sea's animals are drawn on the flat sea the ships sail; the land's, on the curving earth.
        let curved=select(earthCurve(relative,F.camPos.y),relative,sea);
        if(!animalOutside(curved,reach)){
          // Where the far body's error at its first step is all the scene allows, it takes over from the clusters,
          // over a band of distance; an exact animal keeps to its clusters.
          if(!exact){
            let start=bitcast<f32>(animalStepWord(archetype,farFirst,1u))*scale*focal/pixels;
            share=u32(round(continuumHandoff(away,start)*255.0));
            let centre=animalFrame(animalTypeV(archetype,${T.splatCentre}u),place);
            let span=2.0*max(animalSplatRx(archetype,place,centre,F.camPos.xyz),animalTypeF(archetype,${T.splatRy}u))*scale*focal/away;
            splatShare=u32(round(continuumSplatShare(span)*255.0));
            if(share>0u){
              // Thinned by the place's own seed, so the beasts and wagon of a hitch go together.
              splatScale=continuumThin(span,animalSeedOf(place)*0x9e3779b9u+0x85ebca6bu);
              if(splatShare>0u&&splatScale>0.0){
                let at=animalAppend(3u,1u);
                if(at!=ANIMAL_CONTINUUM_FULL){animalLists[at]=vec2u(animal,${ANIMAL_CONTINUUM_ENTRY.splat}u<<28u);}
              }
              if(splatShare<255u){
                let chosen=animalContinuumMorphStep(steps,pixels*away/(focal*scale));
                step=u32(chosen.x);morph=chosen.y;
                if(step<farFirst){step=farFirst;morph=0.0;}
                farChunks=animalChunks(archetype,step);
                farAt=animalAppend(2u,farChunks);
              }
            }
          }
          // The clusters that can be drawn at its nearest point, each tried by the lanes below.
          if(share<255u){
            firstCluster=animalType(archetype,${T.clusterFirst}u);
            nearest=pixels*max(away-reach,0.25)/(focal*scale);
            candidates=animalContinuumPrefix(firstCluster,animalType(archetype,${T.clusterCount}u),nearest);
          }
        }
      }
      animalLists[animal*2u]=vec2u(share|(splatShare<<8u),step|(fifthStep<<16u));
      animalLists[animal*2u+1u]=vec2u(bitcast<u32>(morph),bitcast<u32>(splatScale));
    }
    animalSelected[0]=vec4u(candidates,firstCluster,farAt,farChunks);
    animalSelected[1]=vec4u(fifthAt,fifthChunks,whole,0u);
    animalSelectedView=vec4f(focal,pixels,scale,nearest);
  }
  let chosen=workgroupUniformLoad(&animalSelected);
  let view=animalSelectedView;
  if(chosen[0].z!=ANIMAL_CONTINUUM_FULL){for(var c=lane;c<chosen[0].w;c+=64u){animalLists[chosen[0].z+c]=vec2u(animal,c|(${ANIMAL_CONTINUUM_ENTRY.far}u<<28u));}}
  if(chosen[1].x!=ANIMAL_CONTINUUM_FULL){for(var c=lane;c<chosen[1].y;c+=64u){animalLists[chosen[1].x+c]=vec2u(animal,c|(${ANIMAL_CONTINUUM_ENTRY.far}u<<28u));}}
  if(chosen[0].x==0u){return;}
  let place=animalPlaceOf(animal);
  let clusters=animalAtlas[${ANIMAL_CONTINUUM_HEADER.clustersAt}u];
  for(var i=lane;i<chosen[0].x;i+=64u){
    let c=chosen[0].y+i;
    let at=clusters+c*${ANIMAL_CONTINUUM_CLUSTER_WORDS}u;
    if(chosen[1].z!=0u){
      // Whole: the cut at the nearest point of the sphere that holds it. The prefix holds every cluster whose parent
      // is too coarse there; of them, those fine enough are drawn.
      if(bitcast<f32>(animalAtlas[at+12u])>view.w){continue;}
    }else{
      // Standing: by the core's own test on its spheres, placed by its frame, those in view.
      let lod=vec4f(bitcast<f32>(animalAtlas[at]),bitcast<f32>(animalAtlas[at+1u]),bitcast<f32>(animalAtlas[at+2u]),bitcast<f32>(animalAtlas[at+3u]));
      let parent=vec4f(bitcast<f32>(animalAtlas[at+4u]),bitcast<f32>(animalAtlas[at+5u]),bitcast<f32>(animalAtlas[at+6u]),bitcast<f32>(animalAtlas[at+7u]));
      if(!continuumClusterDrawn(bitcast<f32>(animalAtlas[at+12u])*view.z,animalFrame(lod.xyz,place)-F.camPos.xyz,lod.w*view.z,
        bitcast<f32>(animalAtlas[at+13u])*view.z,animalFrame(parent.xyz,place)-F.camPos.xyz,parent.w*view.z,view.x,view.y)){continue;}
      let cull=vec4f(bitcast<f32>(animalAtlas[at+8u]),bitcast<f32>(animalAtlas[at+9u]),bitcast<f32>(animalAtlas[at+10u]),bitcast<f32>(animalAtlas[at+11u]));
      if(animalOutside(earthCurve(animalFrame(cull.xyz,place)-F.camPos.xyz,F.camPos.y),cull.w*view.z)){continue;}
    }
    let entry=animalAppend(select(0u,1u,(animalAtlas[at+15u]&255u)<=${ANIMAL_CONTINUUM_SMALL_CLUSTER}u),1u);
    if(entry!=ANIMAL_CONTINUUM_FULL){animalLists[entry]=vec2u(animal,c|(${ANIMAL_CONTINUUM_ENTRY.cluster}u<<28u));}
  }
}
`;
}

// The fifth list drawn into the land's shadow map: the far body at the step the cut chose for its shadow, unmorphed,
// posed by the family's `pose` (a WGSL function animalShadowPose(corner:AnimalPoint, place:AnimalPlace,
// archetype:u32)->vec3f giving the world point), which `prelude` (its rig) supplies. Its data is group 1; the shadow
// frame is group 0, binding 0.
export function animalContinuumShadowWGSL(prelude) {
  return SHADOW_FRAME + CONTINUUM_CORE_WGSL + animalContinuumData(1, 0, 'read') + ANIMAL_CONTINUUM_COMMON + ANIMAL_CONTINUUM_TOUCH + prelude + /* wgsl */`
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@vertex fn animalContinuumShadowVS(@builtin(vertex_index) vertex:u32,listed:AnimalContinuumEntry)->@builtin(position) vec4f {
  let touched=animalContinuumBindings();
  let animal=listed.entry.x;
  let place=animalPlaceOf(animal);let archetype=animalTypeOf(place);
  let far=animalFarCorner(archetype,listed.entry.y&0x0fffffffu,vertex,animalState(animal).y>>16u,0.0);
  if(!far.shown){return ANIMAL_CONTINUUM_HIDDEN;}
  let world=animalShadowPose(far.a,place,archetype)+vec3f(touched);
  return SH.lightView*vec4f(world-SH.origin.xyz,1.0);
}
`;
}
