// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people continuum's GPU side (js/crew-continuum.js, js/crew-continuum-draw.js). The cut and its handoffs are the
// shared core's (js/continuum-core.js); this supplies only how a person's data is read, posed and worn.
//
// One compute workgroup a person decides how that person is drawn this frame: clusters of the full body cut by
// projected error, the far body at one step of its collapse, the splat, or two of them sharing each pixel's samples
// across a band. Each list entry is one instance of a fixed-size draw: a cluster or 128 far-body triangles (384
// vertices, the unused ones degenerate), or a splat (3). Everything a list names is posed here from the joints the
// crew's own passes have just written, so the cut follows every limb.
import { FRAME_WGSL } from './common.js';
import { VESSEL_RIG } from './vessel.js';
import { SHADOW_FRAME } from './shadows.js';
import { CREW_SKIN, crewRenderWGSL } from './crew.js';
import { CONTINUUM_CORE_WGSL, continuumClusterPrefixWGSL, continuumMorphStepWGSL } from '../continuum-core.js';
import { CREW_JOINT_COUNT } from '../crew-skeleton.js';
import { CREW_CONTINUUM_VERTEX_WORDS, CREW_CONTINUUM_CLUSTER_WORDS, CREW_CONTINUUM_STEP_WORDS, CREW_CONTINUUM_NEVER } from '../crew-continuum.js';

// The lists a person can be entered in, each with its own indirect draw. Cut: people the camera stands among or who
// are torn, drawn depth first and shaded at equal depth. Shadow and submerged read the far body at a coarse step.
export const CREW_CONTINUUM_LISTS = Object.freeze(['clusters', 'chain', 'splat', 'clustersCut', 'chainCut', 'shadow']);
// Vertices per list instance.
export const CREW_CONTINUUM_INSTANCE_VERTICES = Object.freeze([384, 384, 3, 384, 384, 384]);
// How each draw reads its list: the list buffer bound as an instance-rate vertex buffer at the list's first entry.
export const CREW_CONTINUUM_ENTRY_LAYOUT = Object.freeze([Object.freeze({ arrayStride: 8, stepMode: 'instance', attributes: Object.freeze([Object.freeze({ shaderLocation: 0, offset: 0, format: 'uint32x2' })]) })]);
// Who is cut finer: a wounded person, one being spoken to, or one aimed at. Their pixel error is this share.
export const CREW_CONTINUUM_IMPORTANT = 0.5;
// How many shadow-map texels a shadow's far body may be in error.
export const CREW_CONTINUUM_SHADOW_TEXELS = 1.5;

// What every pass knows of a body and of the batch of people it draws (js/crew-continuum-draw.js writes both).
const CREW_CONTINUUM_STRUCTS = /* wgsl */`
struct CrewContinuumBody {
  low:vec4f,          // xyz lowest corner, w the span 16-bit positions cover
  uv:vec4f,           // uvLow, uvScale
  mesh:vec4u,         // cluster count, first index word in the mesh buffer, far-body vertices, far-body triangles
  chain:vec4u,        // first word of the far body in the shape buffer, of its records, its triangles, its steps
  far:vec4f,          // x the far body's base error, y step count, z splat ry, w splat rx
  splat:vec4f,        // xyz splat centre (bind), w its joint
  medians:array<vec4f,5>,  // each region's median colour; w 0 where the body has none of it
  shares:array<vec4f,5>,   // each region's mean colour in xyz and share of the outline in w
};
struct CrewContinuumPart {
  people:vec4u,       // first slot in the batch, count, samples a pixel, 1 when shadows are drawn
  view:vec4f,         // the scene's pixel error, the shadow map's texel (m), unused, unused
  lists:array<vec4u,6>,    // first entry, capacity, unused, unused
};
`;

// A person's state, two entries ahead of the lists: x = flags | handoff share << 8 | splat share << 16, y = step;
// then morph (f32 bits) and splat scale (f32 bits).
const CREW_CONTINUUM_DECODE = /* wgsl */`
struct CrewContinuumPoint { position:vec3f, normal:vec3f, surface:u32, joints:vec4u, weights:vec4f, region:u32 };
fn crewContinuumOctahedral(e:vec2f)->vec3f {
  let f=e*2.0-1.0;
  var n=vec3f(f.x,f.y,1.0-abs(f.x)-abs(f.y));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
fn crewContinuumUnpack(w0:u32,w1:u32,w2:u32,w3:u32,w4:u32,w5:u32)->CrewContinuumPoint {
  var p:CrewContinuumPoint;
  p.position=crewBody.low.xyz+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))*(crewBody.low.w/65535.0);
  p.region=w1>>24u;
  p.normal=crewContinuumOctahedral(unpack2x16unorm(w2));
  p.surface=w3;
  p.joints=vec4u(w4&255u,(w4>>8u)&255u,(w4>>16u)&255u,w4>>24u);
  p.weights=unpack4x8unorm(w5);
  return p;
}
fn crewContinuumUV(surface:u32)->vec2f { return crewBody.uv.xy+unpack2x16unorm(surface)*crewBody.uv.zw; }
fn crewContinuumColour(surface:u32)->vec3f { let c=unpack4x8unorm(surface).xyz;return c*c; }
fn crewContinuumStepWord(step:u32,word:u32)->u32 { return crewShape[crewBody.chain.x+crewBody.chain.w+step*${CREW_CONTINUUM_STEP_WORDS}u+word]; }
// Where far-body vertex v has gone by step s: each record is the step it collapses at and the vertex it joins.
fn crewContinuumAncestor(vertex:u32,step:u32)->u32 {
  var v=vertex;
  for(var hop=0u;hop<64u;hop++){
    let record=crewShape[crewBody.chain.x+crewBody.chain.y+v];
    let at=record&65535u;
    if(at==${CREW_CONTINUUM_NEVER}u||at>=step){break;}
    v=record>>16u;
  }
  return v;
}
fn crewContinuumFarPoint(v:u32)->CrewContinuumPoint {
  let at=crewBody.chain.x+v*${CREW_CONTINUUM_VERTEX_WORDS}u;
  return crewContinuumUnpack(crewShape[at],crewShape[at+1u],crewShape[at+2u],crewShape[at+3u],crewShape[at+4u],crewShape[at+5u]);
}
fn crewContinuumSkinOf(slot:u32,p:CrewContinuumPoint)->mat4x4f {
  let b=p.joints+vec4u(slot*${CREW_JOINT_COUNT}u);
  return actors[slot].transform*(joints[b.x]*p.weights.x+joints[b.y]*p.weights.y+joints[b.z]*p.weights.z+joints[b.w]*p.weights.w);
}
`;

// The data bindings of the render passes, group 2.
const CREW_CONTINUUM_DATA = CREW_CONTINUUM_STRUCTS + /* wgsl */`
@group(2) @binding(0) var<storage,read> crewMesh:array<u32>;
@group(2) @binding(1) var<storage,read> crewShape:array<u32>;
@group(2) @binding(2) var<storage,read> crewList:array<vec2u>;
@group(2) @binding(3) var<uniform> crewBody:CrewContinuumBody;
@group(2) @binding(4) var<uniform> crewPart:CrewContinuumPart;
@group(2) @binding(5) var crewAlbedo:texture_2d<f32>;
@group(2) @binding(6) var crewAlbedoSampler:sampler;
// Every pass binds the same group 2. A vertex stage names each binding once here, on a path never taken, so the
// layout each pipeline derives holds all of them.
fn crewContinuumBindings()->f32 {
  if(crewPart.people.w!=0xffffffffu){return 0.0;}
  return f32(crewMesh[0]+crewShape[0]+crewList[0].x+crewBody.mesh.x)+textureSampleLevel(crewAlbedo,crewAlbedoSampler,vec2f(0.0),0.0).x;
}
// A list's entries reach the vertex stage as an instance attribute, read from the list buffer at the list's start:
// (person, cluster) or (person, piece of the far body).
struct CrewContinuumEntry { @location(0) entry:vec2u };
` + CREW_CONTINUUM_DECODE;

// --------------------------------------------------------------------------------------------- the cut
export function crewContinuumSelectWGSL() {
  return FRAME_WGSL + VESSEL_RIG + CREW_SKIN + SHADOW_FRAME + CONTINUUM_CORE_WGSL + CREW_CONTINUUM_STRUCTS + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(4) var<storage,read> crewShape:array<u32>;
@group(0) @binding(5) var<storage,read_write> crewList:array<vec2u>;
@group(0) @binding(6) var<storage,read_write> crewDraws:array<atomic<u32>>;
@group(0) @binding(7) var<uniform> crewBody:CrewContinuumBody;
@group(0) @binding(8) var<uniform> crewPart:CrewContinuumPart;
@group(0) @binding(9) var<storage,read> crewOrders:array<u32>;
@group(0) @binding(10) var<uniform> SH:ShadowFrame;
const CREW_CONTINUUM_IMPORTANT:f32=${CREW_CONTINUUM_IMPORTANT.toFixed(4)};
const CREW_CONTINUUM_SHADOW_TEXELS:f32=${CREW_CONTINUUM_SHADOW_TEXELS.toFixed(4)};
${continuumClusterPrefixWGSL('crewContinuumPrefix', (i) => `bitcast<f32>(crewShape[(${i})*${CREW_CONTINUUM_CLUSTER_WORDS}u+13u])`)}
${continuumMorphStepWGSL('crewContinuumMorphStep', (i) => `bitcast<f32>(crewShape[crewBody.chain.x+crewBody.chain.w+(${i})*${CREW_CONTINUUM_STEP_WORDS}u+1u])`)}
// Each joint carried into the hull's frame for this person, once, for every bound the cut poses.
var<workgroup> crewPlaced:array<mat4x4f,${CREW_JOINT_COUNT}>;
var<workgroup> crewShared:vec4u;   // candidate clusters, list, share, scale bits
var<workgroup> crewView:vec4f;     // focal, allowed pixels, scale, unused
fn crewContinuumPlace(joint:u32,p:vec3f)->vec3f { return rotateHull((crewPlaced[joint]*vec4f(p,1.0)).xyz)+hull.origin.xyz-F.camPos.xyz; }
fn crewContinuumOutside(at:vec3f,reach:f32)->bool {
  let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
  let rowX=vec3f(F.viewProj[0].x,F.viewProj[1].x,F.viewProj[2].x);
  let rowY=vec3f(F.viewProj[0].y,F.viewProj[1].y,F.viewProj[2].y);
  let l=rowW+rowX;let r=rowW-rowX;let b=rowW+rowY;let t=rowW-rowY;
  return dot(l,at)< -reach*length(l)||dot(r,at)< -reach*length(r)||dot(b,at)< -reach*length(b)||dot(t,at)< -reach*length(t)||dot(rowW,at)< -reach*length(rowW);
}
fn crewContinuumAppend(list:u32,count:u32)->u32 {
  let at=atomicAdd(&crewDraws[list*4u+1u],count);
  if(at+count>crewPart.lists[list].y){atomicSub(&crewDraws[list*4u+1u],count);return 0xffffffffu;}
  return crewPart.lists[list].x+at;
}
// A step's 128-triangle pieces of the far body, entered in a list.
fn crewContinuumChunks(list:u32,person:u32,step:u32){
  let alive=crewShape[crewBody.chain.x+crewBody.chain.w+step*${CREW_CONTINUUM_STEP_WORDS}u];
  let chunks=(alive+127u)/128u;
  let at=crewContinuumAppend(list,chunks);
  if(at==0xffffffffu){return;}
  for(var c=0u;c<chunks;c++){crewList[at+c]=vec2u(person,c);}
}
@compute @workgroup_size(64) fn crewContinuumSelect(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let person=group.x;
  let slot=crewPart.people.x+person;
  for(var j=lane;j<${CREW_JOINT_COUNT}u;j+=64u){crewPlaced[j]=actors[slot].transform*joints[slot*${CREW_JOINT_COUNT}u+j];}
  workgroupBarrier();
  if(lane==0u){
    var candidates=0u;var list=0u;var share=0u;
    let actor=actors[slot];
    let orders=crewOrders[person];
    var flags=0u;var step=0u;var shadowStep=0u;var morph=0.0;var splatScale=1.0;var splatShare=0u;
    let scale=max(length(actor.transform[0].xyz),1e-3);
    let focal=F.screen.y/max(2.0*length(F.camUp.xyz),1e-4);
    let pixels=crewPart.view.x*select(1.0,CREW_CONTINUUM_IMPORTANT,(orders&2u)!=0u);
    if(actor.shirt.w<=0.5){
      let centre=crewContinuumPlace(u32(crewBody.splat.w),crewBody.splat.xyz);
      let away=max(length(centre),1e-3);
      let reach=(crewBody.far.z+0.6)*scale;
      let nearest=max(away-reach,0.25);
      let steps=u32(crewBody.far.y);
      // The far body, coarse enough for the shadow map, casts every shadow, seen or not.
      if(crewPart.people.w!=0u){
        shadowStep=u32(crewContinuumMorphStep(steps,max(CREW_CONTINUUM_SHADOW_TEXELS*SH.texel.x,pixels*away/focal)/scale).x);
        crewContinuumChunks(5u,person,shadowStep);
      }
      if(!crewContinuumOutside(centre,reach)){
        let cut=(orders&1u)!=0u;
        // Where the far body's own error is all the scene allows, it takes over, over a band of distance.
        // Until a body's full mesh has arrived (far.x is 0), the far body draws everyone.
        let start=crewBody.far.x*scale*focal/pixels;
        let handoff=select(continuumHandoff(away,start),1.0,crewBody.far.x<=0.0);
        share=u32(round(handoff*255.0));
        let span=2.0*max(crewBody.far.z,crewBody.far.w)*scale*focal/away;
        let splat=continuumSplatShare(span);
        splatShare=u32(round(splat*255.0));
        if(share>0u){
          splatScale=continuumThin(span,slot*0x9e3779b9u+0x85ebca6bu);
          if(splatShare>0u&&splatScale>0.0){
            let at=crewContinuumAppend(2u,1u);
            if(at!=0xffffffffu){crewList[at]=vec2u(person,0u);}
          }
          if(splatShare<255u){
            let chosen=crewContinuumMorphStep(steps,pixels*away/(focal*scale));
            step=u32(chosen.x);morph=chosen.y;
            crewContinuumChunks(select(1u,4u,cut),person,step);
          }
        }
        if(share<255u){candidates=crewContinuumPrefix(0u,crewBody.mesh.x,pixels*nearest/(focal*scale));list=select(0u,3u,cut);}
      }
    }
    crewList[person*2u]=vec2u(flags|(share<<8u)|(splatShare<<16u),step|(shadowStep<<16u));
    crewList[person*2u+1u]=vec2u(bitcast<u32>(morph),bitcast<u32>(splatScale));
    crewShared=vec4u(candidates,list,share,bitcast<u32>(scale));
    crewView=vec4f(focal,pixels,scale,0.0);
  }
  let cut=workgroupUniformLoad(&crewShared);
  let view=crewView;
  let scale=view.z;
  for(var i=lane;i<cut.x;i+=64u){
    let at=i*${CREW_CONTINUUM_CLUSTER_WORDS}u;
    let lod=vec4f(bitcast<f32>(crewShape[at]),bitcast<f32>(crewShape[at+1u]),bitcast<f32>(crewShape[at+2u]),bitcast<f32>(crewShape[at+3u]));
    let parent=vec4f(bitcast<f32>(crewShape[at+4u]),bitcast<f32>(crewShape[at+5u]),bitcast<f32>(crewShape[at+6u]),bitcast<f32>(crewShape[at+7u]));
    let packed=crewShape[at+16u];
    let ownAt=crewContinuumPlace(packed&255u,lod.xyz);
    let parentAt=crewContinuumPlace((packed>>8u)&255u,parent.xyz);
    if(!continuumClusterDrawn(bitcast<f32>(crewShape[at+12u])*scale,ownAt,lod.w*scale,bitcast<f32>(crewShape[at+13u])*scale,parentAt,parent.w*scale,view.x,view.y)){continue;}
    let cull=vec4f(bitcast<f32>(crewShape[at+8u]),bitcast<f32>(crewShape[at+9u]),bitcast<f32>(crewShape[at+10u]),bitcast<f32>(crewShape[at+11u]));
    if(crewContinuumOutside(crewContinuumPlace((packed>>16u)&255u,cull.xyz),cull.w*scale)){continue;}
    let entry=crewContinuumAppend(cut.y,1u);
    if(entry!=0xffffffffu){crewList[entry]=vec2u(group.x,i);}
  }
}
`;
}

// --------------------------------------------------------------------------------------------- drawing
const CREW_CONTINUUM_RENDER = /* wgsl */`
const CREW_CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
// The crew's group 0, named whole on a path never taken, so every pass here takes the crew's own bindings.
fn crewContinuumSceneBindings()->f32 {
  if(crewPart.people.w!=0xffffffffu){return 0.0;}
  return textureSampleLevel(transLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(skyLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),0.0).x
    +textureSampleLevel(captainTex,captainSampler,vec2f(0.0),0.0).x+sunVis[0]+moisture[0].x;
}
struct CrewContinuumVertex {
  @invariant @builtin(position) position:vec4f, @location(0) @interpolate(perspective,centroid) world:vec3f,
  @location(1) @interpolate(perspective,centroid) normal:vec3f, @location(2) @interpolate(perspective,centroid) color:vec3f, @location(3) @interpolate(flat) helm:f32,
  @location(4) @interpolate(perspective,centroid) wet:vec2f, @location(5) @interpolate(perspective,centroid) skin:f32,
  @location(6) @interpolate(perspective,centroid) bodyPos:vec3f, @location(7) @interpolate(flat) damage:vec3f,
  @location(8) @interpolate(flat) paint:u32, @location(9) @interpolate(flat) actor:u32,
  @location(10) @interpolate(perspective,centroid) uv:vec2f, @location(11) @interpolate(flat) region:u32,
  @location(12) @interpolate(flat) coverage:vec2u,
};
fn crewContinuumHidden()->CrewContinuumVertex { var out:CrewContinuumVertex;out.position=CREW_CONTINUUM_HIDDEN;return out; }
// What this person wears where the body is of a region. Skin, hair and paint are worn as the picture has them; cloth
// takes the person's own shirt and trousers, at the shade the picture holds against that region's median, so folds
// and stitching survive any colour. The cloth labels were carried onto these bodies from the old ones by nearness and
// stray onto necks and wrists, so where the picture is the colour of this body's skin it is worn as skin.
fn crewContinuumWorn(region:u32,picture:vec3f,actor:CrewActor)->vec4f {
  let median=crewBody.medians[min(region,4u)];
  if(region==0u||region>=3u||median.w<0.5){return vec4f(picture,select(0.0,1.0,region==3u));}
  let worn=select(actor.trousers.rgb,actor.shirt.rgb,region==1u);
  // Bounded, so a stain or a pale fleck in dark cloth stays a fleck and does not blaze in a pale shirt.
  let shade=clamp(picture/max(median.xyz,vec3f(1e-3)),vec3f(0.35),vec3f(1.45));
  let dyed=worn*mix(vec3f(dot(shade,vec3f(0.299,0.587,0.114))),shade,0.2);
  let skin=crewBody.medians[3u];
  let bright=max(dot(picture,vec3f(0.3333)),1e-3);let skinBright=max(dot(skin.xyz,vec3f(0.3333)),1e-3);
  let away=length(picture/bright-skin.xyz/skinBright)+abs(log2(bright/skinBright))*0.15;
  let cloth=select(1.0,smoothstep(0.1,0.28,away),skin.w>0.5);
  return vec4f(mix(picture,dyed,cloth),1.0-cloth);
}
// Everything but the surface, as the crew's own vertex stage sets it.
fn crewContinuumFinish(slot:u32,world:vec3f,normal:vec3f,bodyPos:vec3f)->CrewContinuumVertex {
  var out:CrewContinuumVertex;
  out.position=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  out.world=world;out.normal=normal;out.bodyPos=bodyPos;out.actor=slot;
  let actor=actors[slot];out.helm=floor(actor.trousers.w+0.01);
  let woundAmt=select(clamp(actor.shirt.w/0.45,0.0,1.0),0.0,actor.shirt.w>0.5);
  out.damage=vec3f(woundAmt,clamp(fract(actor.trousers.w)/0.42,0.0,1.0),fract(actor.skin.w));
  let base=crewMoistureBase(actor.hair.w);let y=bodyPos.y;
  let lower=mix(moisture[base],moisture[base+1u],smoothstep(.08,.48,y));
  let upper=mix(moisture[base+2u],moisture[base+3u],smoothstep(1.02,1.48,y));
  out.wet=mix(lower,upper,smoothstep(.48,1.02,y));
  out.paint=crewDressOf(actor.hair.w)>>16u;
  if(actor.shirt.w>0.5){out.position=CREW_CONTINUUM_HIDDEN;}
  return out;
}
fn crewContinuumState(person:u32)->vec4u { let a=crewList[person*2u];let b=crewList[person*2u+1u];return vec4u(a.x,a.y,b.x,b.y); }
@vertex fn crewContinuumClusterVS(@builtin(vertex_index) vertex:u32,listed:CrewContinuumEntry)->CrewContinuumVertex {
  let touched=crewContinuumBindings()+crewContinuumSceneBindings();
  let entry=listed.entry;
  let at=entry.y*${CREW_CONTINUUM_CLUSTER_WORDS}u;
  if(vertex/3u>=crewShape[at+15u]){return crewContinuumHidden();}
  let index=crewMesh[crewBody.mesh.y+crewShape[at+14u]+vertex]*${CREW_CONTINUUM_VERTEX_WORDS}u;
  let p=crewContinuumUnpack(crewMesh[index],crewMesh[index+1u],crewMesh[index+2u],crewMesh[index+3u],crewMesh[index+4u],crewMesh[index+5u]);
  let slot=crewPart.people.x+entry.x;
  let skin=crewContinuumSkinOf(slot,p);
  let world=rotateHull((skin*vec4f(p.position,1.0)).xyz)+hull.origin.xyz+vec3f(touched);
  var out=crewContinuumFinish(slot,world,normalize(rotateHull(crewOrthonormal3x3(skin)*p.normal)),p.position);
  out.uv=crewContinuumUV(p.surface);out.region=p.region;
  // The full body gives up the samples the far body takes across the handoff.
  out.coverage=vec2u(1u,(crewContinuumState(entry.x).x>>8u)&65535u);
  return out;
}
// One far-body vertex at the person's step, on its way to where the next collapse takes it.
fn crewContinuumFarVertex(person:u32,chunk:u32,vertex:u32,state:vec4u)->CrewContinuumVertex {
  let step=state.y&65535u;let morph=bitcast<f32>(state.z);
  let triangle=chunk*128u+vertex/3u;
  if(triangle>=crewContinuumStepWord(step,0u)){return crewContinuumHidden();}
  let corner=crewShape[crewBody.chain.x+crewBody.chain.z+triangle*3u+vertex%3u];
  let next=min(step+1u,u32(crewBody.far.y));
  let a=crewContinuumAncestor(corner,step);let b=crewContinuumAncestor(a,next);
  let pa=crewContinuumFarPoint(a);let pb=crewContinuumFarPoint(b);
  let grow=mix(bitcast<f32>(crewContinuumStepWord(step,2u)),bitcast<f32>(crewContinuumStepWord(next,2u)),morph);
  let slot=crewPart.people.x+person;
  let sa=crewContinuumSkinOf(slot,pa);let sb=crewContinuumSkinOf(slot,pb);
  let posed=mix((sa*vec4f(pa.position+pa.normal*grow,1.0)).xyz,(sb*vec4f(pb.position+pb.normal*grow,1.0)).xyz,morph);
  let normal=normalize(mix(crewOrthonormal3x3(sa)*pa.normal,crewOrthonormal3x3(sb)*pb.normal,morph));
  var out=crewContinuumFinish(slot,rotateHull(posed)+hull.origin.xyz,normalize(rotateHull(normal)),mix(pa.position,pb.position,morph));
  let actor=actors[slot];
  let worn=mix(crewContinuumWorn(pa.region,crewContinuumColour(pa.surface),actor),crewContinuumWorn(pb.region,crewContinuumColour(pb.surface),actor),morph);
  out.color=worn.rgb;out.skin=worn.w;out.region=pa.region;
  return out;
}
@vertex fn crewContinuumChainVS(@builtin(vertex_index) vertex:u32,listed:CrewContinuumEntry)->CrewContinuumVertex {
  let touched=crewContinuumBindings()+crewContinuumSceneBindings();
  let entry=listed.entry;
  let state=crewContinuumState(entry.x);
  var out=crewContinuumFarVertex(entry.x,entry.y,vertex,state);
  out.world+=vec3f(touched);
  // The far body takes the handoff's share from the full body and gives the splat its own.
  out.coverage=vec2u(2u,(state.x>>8u)&65535u);
  return out;
}
@vertex fn crewContinuumSplatVS(@builtin(vertex_index) vertex:u32,listed:CrewContinuumEntry)->CrewContinuumVertex {
  let touched=crewContinuumBindings()+crewContinuumSceneBindings();
  let entry=listed.entry;
  let state=crewContinuumState(entry.x);
  let slot=crewPart.people.x+entry.x;
  let actor=actors[slot];
  let pelvis=actor.transform*joints[slot*${CREW_JOINT_COUNT}u+u32(crewBody.splat.w)];
  let centre=rotateHull((pelvis*vec4f(crewBody.splat.xyz,1.0)).xyz)+hull.origin.xyz;
  let scale=max(length(actor.transform[0].xyz),1e-3)*bitcast<f32>(state.w);
  let toward=normalize(F.camPos.xyz-centre);
  var up=rotateHull((pelvis*vec4f(0.0,1.0,0.0,0.0)).xyz);
  up=normalize(up-toward*dot(up,toward)+vec3f(0.0,1e-4,0.0));
  let right=normalize(cross(up,toward));
  // The triangle that circumscribes the outline's ellipse, shrunk to the ellipse's own area.
  let k=0.7776*scale;
  let corner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  let world=centre+right*(corner.x*crewBody.far.w*k)+up*(corner.y*crewBody.far.z*k)+vec3f(touched);
  var out=crewContinuumFinish(slot,world,toward,crewBody.splat.xyz);
  var colour=vec3f(0.0);var skin=0.0;
  for(var r=0u;r<5u;r++){
    let share=crewBody.shares[r];
    if(share.w<=0.0){continue;}
    let worn=crewContinuumWorn(r,share.xyz,actor);
    colour+=worn.rgb*share.w;skin+=worn.w*share.w;
  }
  out.color=colour;out.skin=skin;out.region=0u;
  out.coverage=vec2u(3u,(state.x>>8u)&65535u);
  return out;
}
// The samples of this pixel each draw takes (continuumSamples, the shared core's split): the far body the handoff's
// share and the full body the rest; of the far body's, the splat its own share and the far body the rest. Every
// sample is drawn by exactly one of the three. coverage.x names the draw, coverage.y holds handoff | splat << 8.
fn crewContinuumMask(coverage:vec2u,pixel:vec2f,actor:u32)->u32 {
  let samples=clamp(crewPart.people.z,1u,8u);
  let all=(1u<<samples)-1u;
  let seed=actor*0x9e3779b9u+1u;
  let handoff=continuumSamples(f32(coverage.y&255u)/255.0,pixel,samples,seed);
  let splat=handoff&continuumSamples(f32((coverage.y>>8u)&255u)/255.0,pixel,samples,seed+7u);
  if(coverage.x==1u){return all&~handoff;}
  if(coverage.x==2u){return handoff&~splat;}
  return splat;
}
fn crewContinuumAsCrew(c:CrewContinuumVertex,base:vec4f)->CrewVertex {
  var v:CrewVertex;
  v.position=c.position;v.world=c.world;v.normal=c.normal;v.color=base.rgb;v.helm=c.helm;v.wet=c.wet;v.skin=base.w;
  v.bodyPos=c.bodyPos;v.damage=c.damage;v.paint=c.paint;v.actor=c.actor;
  return v;
}
// The full body wears its picture; the far body and the splat their vertex colours, worn already.
fn crewContinuumPictured(c:CrewContinuumVertex)->vec4f {
  return crewContinuumWorn(c.region,textureSample(crewAlbedo,crewAlbedoSampler,c.uv).rgb,actors[c.actor]);
}
struct CrewContinuumCoverage { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
@fragment fn crewContinuumFS(c:CrewContinuumVertex,@builtin(front_facing) front:bool)->CrewContinuumCoverage {
  let surface=crewContinuumPictured(c);
  var out:CrewContinuumCoverage;
  out.colour=crewShade(crewContinuumAsCrew(c,surface),front,surface.rgb);
  out.mask=crewContinuumMask(c.coverage,c.position.xy,c.actor);
  return out;
}
@fragment fn crewContinuumFarFS(c:CrewContinuumVertex,@builtin(front_facing) front:bool)->CrewContinuumCoverage {
  var out:CrewContinuumCoverage;
  out.colour=crewShade(crewContinuumAsCrew(c,vec4f(c.color,c.skin)),front,c.color);
  out.mask=crewContinuumMask(c.coverage,c.position.xy,c.actor);
  return out;
}
// Under water, single-sampled, the water's own capture wrapping it: everyone's far body at the step their shadow
// takes, as coarse as the old bodies' last level was here. The sea blurs anything finer.
@vertex fn crewContinuumSubmergedVS(@builtin(vertex_index) vertex:u32,listed:CrewContinuumEntry)->CrewContinuumVertex {
  let touched=crewContinuumBindings()+crewContinuumSceneBindings();
  let entry=listed.entry;
  var state=crewContinuumState(entry.x);
  state.y=state.y>>16u;state.z=0u;
  var out=crewContinuumFarVertex(entry.x,entry.y,vertex,state);
  out.world+=vec3f(touched);
  out.coverage=vec2u(2u,0u);
  return out;
}
@fragment fn crewContinuumSubmergedFarFS(c:CrewContinuumVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  return crewShade(crewContinuumAsCrew(c,vec4f(c.color,c.skin)),front,c.color);
}
// Depth first for anyone the camera stands among or who is torn, as the crew's 'surviving' pass: screen-door
// transparency by the helm, and frayed cuffs and hems. The equal-depth pass then shades what is left.
@fragment fn crewContinuumSurviving(c:CrewContinuumVertex)->CrewContinuumCoverage {
  let opacity=select(1.0,smoothstep(1.4,4.8,distance(c.world,F.camPos.xyz)),c.helm>.5);
  let pixel=vec2u(c.position.xy)%4u;
  let bayer=array<f32,16>(0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
  if(opacity<(bayer[pixel.y*4u+pixel.x]+.5)/16.0){discard;}
  let woundAmt=c.damage.x;let scorchAmt=c.damage.y;
  if(c.region!=3u&&(woundAmt+scorchAmt)>0.45){
    let bp=c.bodyPos;let bSeed=c.damage.z;
    let isCuffOrHem=(bp.y>0.16&&bp.y<0.28)||(bp.y>0.64&&bp.y<0.78)||(abs(bp.x)>0.20&&bp.y>0.82&&bp.y<1.06);
    if(isCuffOrHem){
      let nHash=fract(sin(dot(bp*vec3f(19.3,27.1,23.7)+vec3f(bSeed*31.0),vec3f(12.9898,78.233,45.164)))*43758.5453);
      let fray=sin(bp.x*95.0+bp.z*85.0+bSeed*50.0)*0.5+0.5;
      if(fray*0.65+nHash*0.35>1.12-(woundAmt*0.32+scorchAmt*0.25)){discard;}
    }
  }
  var out:CrewContinuumCoverage;out.colour=vec4f(0.0);out.mask=crewContinuumMask(c.coverage,c.position.xy,c.actor);
  return out;
}
`;

export function crewContinuumRenderWGSL() {
  return crewRenderWGSL() + CONTINUUM_CORE_WGSL + CREW_CONTINUUM_DATA + CREW_CONTINUUM_RENDER;
}

export function crewContinuumShadowWGSL() {
  return VESSEL_RIG + CREW_SKIN + SHADOW_FRAME + CREW_CONTINUUM_DATA + /* wgsl */`
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@vertex fn crewContinuumShadowVS(@builtin(vertex_index) vertex:u32,listed:CrewContinuumEntry)->@builtin(position) vec4f {
  let touched=crewContinuumBindings();
  let entry=listed.entry;
  let slot=crewPart.people.x+entry.x;
  if(actors[slot].shirt.w>0.5){return vec4f(2.0,2.0,0.0,1.0);}
  // The shadow's step is chosen with the list and kept in the state's high half; it stands at that step unmorphed.
  let shadowStep=crewList[entry.x*2u].y>>16u;
  let triangle=entry.y*128u+vertex/3u;
  if(triangle>=crewContinuumStepWord(shadowStep,0u)){return vec4f(2.0,2.0,0.0,1.0);}
  let corner=crewShape[crewBody.chain.x+crewBody.chain.z+triangle*3u+vertex%3u];
  let p=crewContinuumFarPoint(crewContinuumAncestor(corner,shadowStep));
  let grow=bitcast<f32>(crewContinuumStepWord(shadowStep,2u));
  let world=rotateHull((crewContinuumSkinOf(slot,p)*vec4f(p.position+p.normal*grow,1.0)).xyz)+hull.origin.xyz+vec3f(touched);
  return SH.lightView*vec4f(world-SH.origin.xyz,1.0);
}
`;
}
