// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How the one cut poses a ship's points (AGENTS.md rule 3; js/wgsl/continuum-kinds.js has the contract). A ship's
// atlas vertices carry, in the rider stream, which vertex of her assembly each rides (scripts/prepare-ship-continuum.mjs):
//   a cluster vertex   the assembly vertex it is (renumbered at load onto a player's ship as built, js/ship-continuum.js);
//   a far vertex       SHIP_RIDER_FAR | d: the cluster vertex d atlas vertices before it, which rides the assembly vertex
//                      nearest it of its own piece; the far vertex is carried as that vertex is;
//   a detail line      SHIP_RIDER_LINE | j: line vertex j of her detail layer (js/vessel-detail.js), laid each frame by
//                      her pose pass between the parts it rides.
// The vertex word is the assembly's material (f32 bits), the UV stream its UV clamped to the image (unorm).
//
// RIDER   a ship posed on the GPU by her own passes (js/vessel-pose.js: rig, recoil, parts, shards, colours, anchor),
//         or a damaged trade vessel's fracture pass: every point where her posed assembly has it. Pose data, vec4f:
//         [the posed assembly's first vec4f, vec4f a vertex (2: position | colours, normal | 0), the first line row,
//         line vertices], then [design units to the type's metres (x, y, z), 0]. A line vertex reads three rows (position
//         and u, normal and v, material | the vertex it wets as | shown). Spheres are the bake's: each holds its points
//         as far as they move.
// DRAPED  a whole trade vessel: her canvas brailed up its yards by her furl, her oars through their stroke and her helm
//         swung by her motion, posed in the vertex stage from the record's spare words (identity, phase, motion, furl).
//         Pose data, vec4f, one block a type: [design units to metres (x, y, z), what moves: 1 canvas, 2 oars, 4 helm],
//         sixteen sails' yard rows, sixteen lateen tack rows, twenty-four oar pivots (x, y, z, side), then [sweep, dip,
//         the oar's slope in metres, 0].
import { CONTINUUM_KIND, CONTINUUM_HEADER, CONTINUUM_STREAMS } from '../continuum-format.js';
import { defineContinuumKind } from './continuum-kinds.js';

export const SHIP_RIDER_FAR = 0x80000000;
export const SHIP_RIDER_LINE = 0x40000000;
export const SHIP_RIDER_HEADER = 2;
export const SHIP_DRAPED_SAILS = 16, SHIP_DRAPED_OARS = 24;
export const SHIP_DRAPED_BLOCK = 2 + SHIP_DRAPED_SAILS * 2 + SHIP_DRAPED_OARS;
export const SHIP_DRAPED_CANVAS = 1, SHIP_DRAPED_OARED = 2, SHIP_DRAPED_HELM = 4;
const shipStream = (name) => CONTINUUM_STREAMS.find((s) => s.name === name);

// The WGSL every kind of the ship family shares: which assembly vertex an atlas vertex rides, and its own words.
const SHIP_KINDS_COMMON = () => /* wgsl */`
const SHIP_RIDER_FAR:u32=${SHIP_RIDER_FAR >>> 0}u;
const SHIP_RIDER_LINE:u32=${SHIP_RIDER_LINE >>> 0}u;
fn shipRiderWord(vertex:u32)->u32 { return continuumStreamWord(${CONTINUUM_HEADER.rider}u,${shipStream('rider').bit}u,1u,vertex,0u); }
// The cluster vertex an atlas vertex stands for: itself, or a far vertex's.
fn shipRiderVertex(vertex:u32)->u32 {
  let word=shipRiderWord(vertex);
  return select(vertex,vertex-(word&0x7fffffffu),(word&SHIP_RIDER_FAR)!=0u);
}
fn shipDamageOf(normal:vec3f)->f32 { let l=length(normal);return select(0.0,clamp(l-1.0,0.0,1.5),l>1.002); }
`;

defineContinuumKind(CONTINUUM_KIND.RIDER, {
  name: 'Rider',
  wgsl: () => SHIP_KINDS_COMMON() + /* wgsl */`
fn continuumRiderPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  var out=p;
  let head=continuumPoses[data];let scale=max(continuumPoses[data+1u].xyz,vec3f(1e-4));
  let word=shipRiderWord(vertex);
  if((word&SHIP_RIDER_LINE)!=0u){
    let j=word&0x3fffffffu;
    if(f32(j)>=head.w){out.hidden=true;return out;}
    let at=u32(head.z)+j*3u;
    let shown=continuumPoses[at+2u].z;
    if(shown<0.5){out.hidden=true;return out;}
    out.position=continuumPoses[at].xyz*scale;
    out.normal=normalize(continuumPoses[at+1u].xyz/scale+vec3f(0.0,1e-6,0.0));
    return out;
  }
  let stride=u32(head.y);
  if((word&SHIP_RIDER_FAR)!=0u){
    // A far vertex moves as the assembly vertex it rides does: by that vertex's posed place less its rest.
    let cluster=vertex-(word&0x7fffffffu);
    let source=shipRiderWord(cluster);
    let rest=continuumPointAt(continuumTypeOf(record),cluster).position;
    out.position=p.position+continuumPoses[u32(head.x)+source*stride].xyz*scale-rest;
    return out;
  }
  let at=u32(head.x)+word*stride;
  out.position=continuumPoses[at].xyz*scale;
  let normal=continuumPoses[at+1u].xyz;
  out.normal=normalize(normal/scale+vec3f(0.0,1e-6,0.0));
  out.wear=shipDamageOf(normal);
  return out;
}
fn continuumRiderSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f { return sphere; }
`,
});

defineContinuumKind(CONTINUUM_KIND.DRAPED, {
  name: 'Draped',
  wgsl: () => /* wgsl */`
// An oar through its stroke: swept about its pivot and dipped, feathered about its own shaft on the recovery.
fn shipDrapedOar(data:u32,station:u32,p:vec3f,n:vec3f,phase:f32,motion:f32,scale:vec3f)->array<vec3f,2> {
  let pivot=continuumPoses[data+${2 + SHIP_DRAPED_SAILS * 2}u+station];let stroke=continuumPoses[data+${SHIP_DRAPED_BLOCK}u];
  let side=pivot.w;
  let cycle=select(3.14159265,F.camPos.w*2.15+phase+f32(station>>1u)*0.16,motion>0.035);
  let sweep=sin(cycle)*stroke.x;let dip=-cos(cycle)*stroke.y;
  var d=p-pivot.xyz;var m=n;
  let shaft=normalize(vec3f(side/scale.x,stroke.z/scale.y,0.0));
  let feather=max(0.0,-cos(cycle))*0.65;
  if(feather>0.001){
    let cf=cos(feather);let sf=sin(feather);
    let dp=shaft*dot(shaft,d);d=dp+(d-dp)*cf+cross(shaft,d)*(sf*side);
    let np=shaft*dot(shaft,m);m=np+(m-np)*cf+cross(shaft,m)*(sf*side);
  }
  let cy=cos(sweep*side);let sy=sin(sweep*side);let cr=cos(dip*side);let sr=sin(dip*side);
  let dy=vec3f(d.x*cy-d.z*sy,d.y,d.x*sy+d.z*cy);let ny=vec3f(m.x*cy-m.z*sy,m.y,m.x*sy+m.z*cy);
  return array<vec3f,2>(pivot.xyz+vec3f(dy.x*cr-dy.y*sr,dy.x*sr+dy.y*cr,dy.z),vec3f(ny.x*cr-ny.y*sr,ny.x*sr+ny.y*cr,ny.z));
}
// Canvas and its bolt-ropes gathered up to the yard by the furl: a square sail's foot lifted beneath its yard, a lateen's
// cloth drawn to its oblique yard from peak to tack.
fn shipDrapedBrail(data:u32,p:vec3f,n:vec3f,material:f32,uv:vec2f,furl:f32)->array<vec3f,2> {
  let m=u32(max(0.0,floor(material)));
  if(furl<=0.002||(m!=9u&&m!=13u&&m!=19u)){return array<vec3f,2>(p,n);}
  let sail=min(15u,u32(max(0.0,round(fract(material)*64.0))));
  let a=continuumPoses[data+2u+sail];
  if(a.x< -0.5){return array<vec3f,2>(p,n);}
  var q=p;var o=n;
  let u=clamp(uv.x,0.0,1.0);let v=clamp(uv.y,0.0,1.0);let gate=clamp(v*20.0,0.0,1.0);
  if(a.x>0.5){
    let tack=continuumPoses[data+${2 + SHIP_DRAPED_SAILS}u+sail].yzw;
    let along=clamp(u+v*0.34,0.0,1.0);
    let yard=mix(a.yzw,tack,along)-vec3f(0.0,(0.045+0.085*sin(along*3.14159265))*v,0.0);
    q=mix(q,yard,furl*0.96*gate);
    o=normalize(mix(n,normalize(vec3f(0.88,-0.36*v-0.08,0.22*sin(u*12.566))),furl*0.52*gate));
  }else{
    let drop=(0.055+0.115*sin(u*3.14159265))*v;
    q.y=mix(q.y,min(a.y,a.y-drop),furl*0.96*gate);
    q.z=mix(q.z,a.z-(0.04+0.075*sin(u*3.14159265))*v,furl*0.92*gate);
    q.x*=1.0-0.16*furl*v;
    o=normalize(mix(n,normalize(vec3f((u-0.5)*0.25,-0.48*v,-0.86)),furl*0.52*gate));
  }
  return array<vec3f,2>(q,o);
}
fn continuumDrapedPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  var out=p;
  let head=continuumPoses[data];let scale=max(head.xyz,vec3f(1e-4));let moves=u32(head.w);
  let phase=bitcast<f32>(record.spare.y);let motion=bitcast<f32>(record.spare.z);let furl=clamp(bitcast<f32>(record.spare.w),0.0,1.0);
  let rides=shipRiderVertex(vertex);
  let material=bitcast<f32>(continuumPointAt(continuumTypeOf(record),rides).word);
  let m=u32(max(0.0,floor(material)));
  var q=p.position/scale;var n=normalize(p.normal*scale);
  let code=round((material-16.0)*64.0);
  if((moves&${SHIP_DRAPED_OARED}u)!=0u&&m==16u&&code>=1.0){
    let oar=shipDrapedOar(data,min(23u,u32(code)-1u),q,n,phase,motion,scale);q=oar[0];n=oar[1];
  }else if((moves&${SHIP_DRAPED_HELM}u)!=0u&&m==28u&&motion>0.05){
    q.x+=sin(F.camPos.w*1.45+phase)*0.075*min(motion,1.4);
  }
  if((moves&${SHIP_DRAPED_CANVAS}u)!=0u){
    let brailed=shipDrapedBrail(data,q,n,material,continuumUV(rides),furl);q=brailed[0];n=brailed[1];
  }
  out.position=q*scale;
  out.normal=normalize(n/scale);
  return out;
}
fn continuumDrapedSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f { return sphere; }
`,
});
