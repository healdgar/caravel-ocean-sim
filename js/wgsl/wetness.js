import { FRAME_WGSL } from './common.js';
import { INTERACTION_TYPES, INTERACTION_SEA, SPRAY_COUNT, SHEET_COUNT } from './interaction.js';
import { SPINDRIFT_STATE, SPINDRIFT_COUNT } from './spindrift.js';
import { VESSEL_RIG } from './vessel.js';
import { DECK_PROFILE, DECK_SAMPLING } from './deck.js';
import { QUARTERDECK_START, QUARTERDECK_HEIGHT } from '../hull.js';
import {ADDITIONAL_DESIGNS} from '../models/additional.js';

export const WET_GRID=[24,32,48];
export const WET_SEA_SIZE=32;
const WET_SPACE=/* wgsl */ `
fn wetMin()->vec3f {return select(vec3f(-4.2,-1.5,-8.7),vec3f(-4.2,-2.1,-10.8),hull.rig.w>.5);}
fn wetSpan()->vec3f {return select(vec3f(8.4,11.0,16.4),vec3f(8.4,15.7,17.8),hull.rig.w>.5);}
const wetSize=vec3u(${WET_GRID.join(',')});
fn wetLocal(world:vec3f)->vec3f {
  let q=world-hull.origin.xyz;
  return vec3f(dot(q,hull.right.xyz),dot(q,hull.up.xyz),-dot(q,hull.forward.xyz))/vec3f(hull.size.x/3.6,shipY(hull.right.w),hull.size.y/12.0);
}
fn wetWorld(p:vec3f)->vec3f {return rotateHull(p*vec3f(hull.size.x/3.6,shipY(hull.right.w),hull.size.y/12.0))+hull.origin.xyz;}
fn wetIndex(p:vec3u)->u32 {return (p.z*wetSize.y+p.y)*wetSize.x+p.x;}
fn wetShelteredStart()->f32 {
  ${Object.values(ADDITIONAL_DESIGNS).map(d=>`if(abs(hull.rig.w-${d.modelCode}.0)<.1){return ${d.deckZones.find(zone=>zone.id==='quarter').bounds[0].toFixed(5)};}`).join('\n')}
  return select(${QUARTERDECK_START},1.65,hull.rig.w>.5);
}
`;
// Absorbed moisture and a short-lived surface film have separate lifetimes.
// Rates are authored visual approximations; they do not add mass to the ship.
export const WET_MATERIAL=/* wgsl */ `
fn moistureStep(old:vec2f,water:f32,spray:f32,kind:u32,wind:f32,dt:f32)->vec2f {
  if(kind==4u){
    // Nonporous iron loses its film to drainage/evaporation more quickly than
    // wood or cloth. These visual rates are authored, not a corrosion model.
    // Water, actual deposited spray and the existing rain term supply the film;
    // humidity/absorbed moisture cannot keep a dry cannon permanently glossy.
    let film=old.y*exp(-dt*(0.9+min(wind,30.0)*0.035));
    let deposition=water*25.0+spray*4.0;
    return vec2f(0,clamp(film+(1.0-film)*(1.0-exp(-dt*deposition)),0.0,1.0));
  }
  let drying=array<f32,4>(0.004,0.002,0.006,0.004)[kind]*(1.0+min(wind,30.0)*0.025);
  let absorbed=old.x*exp(-dt*drying);
  let film=old.y*exp(-dt*(0.18+min(wind,30.0)*0.012));
  let uptake=water*18.0+spray*1.8;
  return clamp(vec2f(absorbed+(1.0-absorbed)*(1.0-exp(-dt*uptake)),
    film+(1.0-film)*(1.0-exp(-dt*(water*25.0+spray*4.0)))),vec2f(0),vec2f(1));
}
`;
export const WET_CLEAR=/* wgsl */ `
@group(0) @binding(0) var<storage,read_write> mist:array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x<arrayLength(&mist)){atomicStore(&mist[id.x],0u);}
}
`;
export const WET_DEPOSIT=INTERACTION_TYPES+VESSEL_RIG+DECK_PROFILE+SPINDRIFT_STATE+/* wgsl */ `
@group(0) @binding(0) var<uniform> hull:Hull;
@group(0) @binding(1) var<uniform> I:Interaction;
@group(0) @binding(2) var<storage,read_write> mist:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read> drops:array<Drop>;
@group(0) @binding(4) var<storage,read> sheets:array<Sheet>;
@group(0) @binding(5) var<storage,read> plumes:array<CrestPlume>;
`+WET_SPACE+/* wgsl */ `
fn deposit(world:vec3f,amount:f32){
  let q=(wetLocal(world)-wetMin())/wetSpan()*vec3f(wetSize)-0.5;
  let base=vec3i(floor(q));let f=fract(q);
  for(var i=0u;i<8u;i++){
    let corner=vec3i(vec3u(i&1u,(i>>1u)&1u,(i>>2u)&1u));let p=base+corner;
    if(all(p>=vec3i(0))&&all(p<vec3i(wetSize))){
      let w=mix(vec3f(1)-f,f,vec3f(corner));
      atomicAdd(&mist[wetIndex(vec3u(p))],u32(amount*w.x*w.y*w.z*4096.0));
    }
  }
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(I.motion.y<0.5 || I.previous.w>0.5){return;}
  let i=id.x;
  if(i<${SPRAY_COUNT}u){let d=drops[i];if(d.position.w>0.0){deposit(d.position.xyz,mix(0.6,0.18,d.shape.z));}}
  if(i<${SHEET_COUNT}u){let s=sheets[i];if(s.velocity.w>0.0){
    let t=s.origin.w*.8;let p=s.origin.xyz+s.velocity.xyz*t-vec3f(0,4.905*t*t,0);
    for(var j=-2;j<=2;j++){deposit(p+s.tangent.xyz*f32(j)*s.tangent.w*.5,s.axis.w*.45);}
  }}
  if(i<${SPINDRIFT_COUNT}u){let p=plumes[i];if(p.launch.w>0.0){
    let at=plumePosition(p,p.origin.w);
    for(var j=-1;j<=1;j++){deposit(at+p.crest.xyz*f32(j)*p.crest.w,p.shape.x*.12);}
  }}
}
`;
export const WET_SEA=FRAME_WGSL+VESSEL_RIG+DECK_PROFILE+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(2) var seaTex:texture_2d_array<f32>;
@group(0) @binding(3) var seaSamp:sampler;
@group(0) @binding(4) var levels:texture_storage_2d<r32float,write>;
`+WET_SPACE+INTERACTION_SEA+/* wgsl */ `
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  let uv=(vec2f(id.xy)+.5)/${WET_SEA_SIZE}.0;
  let p=vec3f(wetMin().x+uv.x*wetSpan().x,0,wetMin().z+uv.y*wetSpan().z);
  textureStore(levels,vec2i(id.xy),vec4f(interactionSea(wetWorld(p).xz)));
}
`;
export const WET_UPDATE=INTERACTION_TYPES+VESSEL_RIG+DECK_PROFILE+WET_MATERIAL+/* wgsl */ `
struct WetProbe {position:vec4f,uvKind:vec4f};
@group(0) @binding(0) var<uniform> hull:Hull;
@group(0) @binding(1) var<uniform> I:Interaction;
@group(0) @binding(2) var<storage,read> probes:array<WetProbe>;
@group(0) @binding(3) var<storage,read_write> moisture:array<vec2f>;
@group(0) @binding(4) var<storage,read> mist:array<u32>;
@group(0) @binding(5) var levels:texture_2d<f32>;
@group(0) @binding(6) var deckWater:texture_2d<f32>;
`+WET_SPACE+DECK_SAMPLING+/* wgsl */ `
fn mistAt(p:vec3f)->f32 {
  let q=(p-wetMin())/wetSpan()*vec3f(wetSize)-.5;let base=vec3i(floor(q));let f=fract(q);var value=0.0;
  for(var i=0u;i<8u;i++){
    let corner=vec3i(vec3u(i&1u,(i>>1u)&1u,(i>>2u)&1u));let at=base+corner;
    if(all(at>=vec3i(0))&&all(at<vec3i(wetSize))){let w=mix(vec3f(1)-f,f,vec3f(corner));value+=f32(mist[wetIndex(vec3u(at))])*w.x*w.y*w.z/4096.0;}
  }
  return min(value,8.0);
}
fn levelAt(world:vec3f)->f32 {
  // Project onto the local y=0 plane before looking up world-space sea heights.
  let qWorld=world.xz-hull.origin.xz;let r=hull.right.xz;let back=-hull.forward.xz;
  let det=max(.1,r.x*back.y-r.y*back.x);
  let p=vec2f(qWorld.x*back.y-qWorld.y*back.x,r.x*qWorld.y-r.y*qWorld.x)/det/vec2f(hull.size.x/3.6,hull.size.y/12.0);
  let uv=(p-wetMin().xz)/wetSpan().xz;
  let q=clamp(uv,vec2f(0),vec2f(1))*${WET_SEA_SIZE}.0-.5;let b=vec2i(floor(q));let f=fract(q);
  let hi=vec2i(${WET_SEA_SIZE-1});
  return mix(mix(textureLoad(levels,clamp(b,vec2i(0),hi),0).x,textureLoad(levels,clamp(b+vec2i(1,0),vec2i(0),hi),0).x,f.x),
    mix(textureLoad(levels,clamp(b+vec2i(0,1),vec2i(0),hi),0).x,textureLoad(levels,clamp(b+vec2i(1,1),vec2i(0),hi),0).x,f.x),f.y);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=arrayLength(&probes)){return;}let probe=probes[i];
  if(I.previous.w>.5 || probe.uvKind.w<.5){moisture[i]=vec2f(0);return;}
  let rig=rigVertex(probe.position.xyz,vec3f(0,1,0),probe.position.w,probe.uvKind.xy);
  let p=rig.position;let world=wetWorld(p);let modern=hull.rig.w>=3.5;
  let floor=deckFloorAt(p.z,p.x);let rail=deckRailAt(p.z,p.x);
  let rim=modelHullDeck(p.z,hull.rig.w);var threshold=rim-.08;var width=deckWidth(p.z)-.10;
  if(modern){
    let inset=.012/(hull.size.x/3.6);
    // Lower only actual interior/crew probes to the open floor. The outside
    // shell must still receive sea contact below the gunwale.
    let interior=probe.uvKind.z==3.0 || abs(p.x)<modelHullWidth(p.z,p.y,hull.rig.w)-inset;
    if(interior){threshold=floor-.08;}
    width=select(0.0,modelHullWidth(p.z,rim,hull.rig.w)-inset,interior);
  }
  let inFootprint=p.z>deckMinZ() && p.z<deckMinZ()+deckLength() && abs(p.x)<width && p.y>=threshold;
  // A historical quarterdeck roof is not a generic shelter on an open canoe,
  // rowing vessel, yacht cockpit or the clipper's authored deck arrangement.
  let sheltered=!modern && inFootprint && p.z>=wetShelteredStart() && p.y<floor-.08;
  var water=smoothstep(-.025,.08,levelAt(world)-world.y);
  var spray=mistAt(p);
  if(inFootprint && p.y<=floor+rail){
    let wash=sampleDeck(deckUV(p));
    water=smoothstep(.0003,.003,wash.x)*smoothstep(-.015,.035,wash.x-(p.y-floor)*shipY(hull.right.w));
    if(p.y<floor-.08){water=0.0;}
  }
  if(I.motion.y<.5){water=0.0;spray=0.0;}
  spray+=I.phase.w*.24;
  if(sheltered){water=0.0;spray=0.0;}
  moisture[i]=moistureStep(moisture[i],water,spray,u32(probe.uvKind.z),length(I.motion.zw),I.previous.z);
}
`;

// Reuse the authoritative indexed pose already produced on the GPU. Crew
// probes have a sentinel index and retain their separately updated positions.
// This variant needs neither a second rig evaluator nor a position readback.
export function withPosedWetnessProbes(source=WET_UPDATE){
  const sample='let rig=rigVertex(probe.position.xyz,vec3f(0,1,0),probe.position.w,probe.uvKind.xy);\n  let p=rig.position;';
  if(source.split(sample).length!==2)throw Error('Unrecognized wetness pose sample');
  return source.replace(sample,`var p=probe.position.xyz;
  let sourceIndex=wetPoseSourceVertices[i];
  if(sourceIndex!=0xffffffffu&&sourceIndex<arrayLength(&wetPosedVertices)){p=wetPosedVertices[sourceIndex].position.xyz;}`)+/* wgsl */ `
struct WetPosedVertex {position:vec4f,normal:vec4f};
@group(0) @binding(7) var<storage,read> wetPosedVertices:array<WetPosedVertex>;
@group(0) @binding(8) var<storage,read> wetPoseSourceVertices:array<u32>;
`;
}
