import { HULL_DRAFT } from '../hull.js';
import { HULL_PROFILE } from './hull.js';
// Local hull response and spray. Bounded visual approximation, not a fluid solver.
import { FRAME_WGSL, CASCADES, ATMO_CORE_WGSL, NOISE_WGSL } from './common.js';
import { SHADOW_SAMPLE } from './shadows.js';

export const WAKE_SIZE = 256;
export const SPRAY_COUNT = 4096;
export const SHEET_COUNT = 128;
// The first 32 contacts launch bow spray; eight aft contacts drive the stern wake.
export const CONTACT_COUNT = 40;
export const INTERACTION_TYPES = /* wgsl */ `
struct Interaction {
  domain: vec4f,   // world centre xz, extent, texel size
  previous: vec4f, // previous centre xz, dt, reset
  motion: vec4f,   // speed m/s, enabled, wind velocity xz
  phase: vec4f,    // time, frame, hull length scale, precipitation wetting
};
struct Contact { point: vec4f, axis: vec4f, flow: vec4f, state: vec4f };
// Contact: point.w = displacement forcing; axis.w = impact energy;
// state = previous immersion, time since launch, filtered rise velocity, launch serial.
struct Sheet { origin: vec4f, velocity: vec4f, axis: vec4f, tangent: vec4f };
struct Drop { position: vec4f, velocity: vec4f, shape: vec4f };
struct InteractionHull { right: vec4f, up: vec4f, forward: vec4f, size: vec4f, origin: vec4f, rig: vec4f };
`;
// All consumers query the same world-space field, including the buoyancy probe.
export const WAKE_SAMPLE = INTERACTION_TYPES + /* wgsl */ `
fn wakeAt(p: vec2f) -> vec4f {
  let uv = (p - I.domain.xy) / I.domain.z + 0.5;
  let edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
  if (I.motion.y < 0.5 || edge >= 0.495) { return vec4f(0.0); }
  return textureSampleLevel(wakeTex, wakeSamp, uv, 0.0) * (1.0 - smoothstep(0.45, 0.495, edge)) * I.motion.y;
}
`;
// Shared consumers (surface, foam and probes) see the sum of both independent
// wake grids. Local emitters continue to use their own WAKE_SAMPLE.
export const FLEET_WAKE_SAMPLE = WAKE_SAMPLE.replace('fn wakeAt(', 'fn firstWakeAt(') + /* wgsl */ `
fn wakeAt(p:vec2f)->vec4f {
  let uv=(p-I2.domain.xy)/I2.domain.z+0.5;
  let edge=max(abs(uv.x-.5),abs(uv.y-.5));
  var second=vec4f(0);
  if(I2.motion.y>.5&&edge<.495){second=textureSampleLevel(wakeTex2,wakeSamp,uv,0.0)*(1.0-smoothstep(.45,.495,edge))*I2.motion.y;}
  return firstWakeAt(p)+second;
}
`;
export const INTERACTION_SEA = /* wgsl */ `
fn interactionDisp(p: vec2f) -> vec3f {
  var d = vec3f(0.0);
  for (var c = 0u; c < ${CASCADES}u; c++) {
    d += textureSampleLevel(seaTex, seaSamp, p * F.cascInvL[c >> 2u][c & 3u], c, 0.0).xyz;
  }
  return d;
}
fn interactionSea(p: vec2f) -> f32 {
  var q = p;
  for (var k = 0; k < 3; k++) { q = p - interactionDisp(q).xz; }
  return interactionDisp(q).y;
}
fn interactionRandom(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return f32((x >> 22u) ^ x) / 4294967296.0;
}
`;

export const WATER_CONTACTS = FRAME_WGSL + INTERACTION_TYPES + HULL_PROFILE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var<uniform> H: InteractionHull;
@group(0) @binding(3) var seaTex: texture_2d_array<f32>;
@group(0) @binding(4) var seaSamp: sampler;
@group(0) @binding(5) var<storage, read_write> contacts: array<Contact, ${CONTACT_COUNT}>;
` + INTERACTION_SEA + /* wgsl */ `
// Pressure integrates a hull-sized patch; centimetre ripples should not fire a splash.
// The geometric intersection above still follows the full-resolution surface.
fn pressureDisp(p: vec2f) -> vec3f {
  var d=vec3f(0.0);
  for(var c=0u;c<${CASCADES}u;c++){
    let invL=F.cascInvL[c>>2u][c&3u];
    let lod=max(0.0,log2(max(invL*256.0*0.65,0.001)));
    d+=textureSampleLevel(seaTex,seaSamp,p*invL,c,lod).xyz;
  }
  return d;
}
fn pressureSea(p: vec2f) -> f32 {
  var q=p;for(var k=0;k<3;k++){q=p-pressureDisp(q).xz;}
  return pressureDisp(q).y;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if(i >= ${CONTACT_COUNT}u){return;}
  let aft = i >= 32u;
  let u = select(f32(i % 16u) / 15.0, f32(i % 4u) / 3.0, aft);
  let side = select(-1.0, 1.0, (i >= 16u && i < 32u) || i >= 36u);
  let a = mix(0.28, 0.992, u);
  let z = select(-select(6.4,6.0,H.rig.w>.5) * a, mix(2.0,select(5.25,5.65,H.rig.w>.5),u), aft);
  let deck = modelHullDeck(z,H.rig.w);
  let halfWidth = modelHullWidth(z,0.0,H.rig.w) * H.size.x / 3.6;
  let spine = H.origin.xyz - H.forward.xyz * (z * H.size.y / 12.0);
  let rest = spine + H.right.xyz * side * halfWidth * 0.9;
  var p = rest;
  var level = 0.0;
  var localY = 0.0;
  var width = halfWidth * 0.9;
  for (var j = 0; j < 5; j++) {
    level = interactionSea(p.xz);
    localY = (level - spine.y - H.right.y * side * width) / (max(0.35, H.up.y)*shipY(H.right.w));
    width = modelHullWidth(z,localY,H.rig.w) * H.size.x / 3.6;
    p = spine + H.right.xyz * side * width + H.up.xyz * localY*shipY(H.right.w);
  }
  p.y = level;
  let signedWater = pressureSea(p.xz) - rest.y;
  let old = contacts[i];
  let dt = max(I.previous.z, 0.001);
  let reset = I.previous.w > 0.5 || old.state.y < 0.0001;
  let rise = clamp((signedWater - old.state.x) / dt, -8.0, 8.0);
  let closing = select(mix(old.state.z, rise, 1.0-exp(-dt*18.0)), 0.0, reset);
  let wet = smoothstep(-modelHullDraft(H.rig.w),-modelHullDraft(H.rig.w)*.65,localY) * smoothstep(0.0, 0.08, width) * (1.0 - smoothstep(deck + 0.3, deck + 1.1, localY)) * I.motion.y;
  let speed = max(I.motion.x, 0.0);
  // Gradient of the actual planking, including the fine entry and changing
  // section flare. Splash direction must change with the rebuilt hull.
  let eps=0.04;
  let dz=(modelHullWidth(z+eps,localY,H.rig.w)-modelHullWidth(z-eps,localY,H.rig.w))/(2.0*eps)*H.size.x/3.6/(H.size.y/12.0);
  let dy=(modelHullWidth(z,localY+eps,H.rig.w)-modelHullWidth(z,localY-eps,H.rig.w))/(2.0*eps)*H.size.x/3.6/shipY(H.right.w);
  let normal=normalize(H.right.xyz*side+H.forward.xyz*dz-H.up.xyz*dy);
  let outward=normalize(vec3f(normal.x,0.0,normal.z)+H.right.xyz*side*0.12);
  let entry=clamp(dot(outward,H.forward.xyz),0.0,1.0);
  // Relative rise already includes heave, pitch, and motion through the wave.
  // Quadratic impact pressure distinguishes a hard slam from a gentle swell.
  let approach=max(0.0,closing-0.28);
  let hit=wet*min(3.5,approach*approach*.20)*(0.45+0.55*entry)*mix(.55,1.0,u);
  let impact=select(max(hit,old.axis.w*exp(-dt*7.0))*wet,0.0,reset);
  // Continuous stagnation pressure exists on flat water too. The wave-driven
  // impact remains separate, so steady headway does not fire ballistic spray.
  let pressureHead=min(.55,speed*speed/(2.0*9.81)*.85);
  let drive=wet*(pressureHead*(.18+.82*entry)*mix(.5,1.0,u)+impact*.8);
  let age=select(old.state.y+dt,1.0,reset);
  // Re-arm when the face recedes, or on a distinctly stronger subsequent slam.
  let launch=!reset && hit>.12 && age>.28 && (old.state.z<=.3 || (hit>old.axis.w*1.18 && age>.5));
  contacts[i].point = vec4f(p,drive);
  contacts[i].axis = vec4f(outward,impact);
  // Headway peels water outwards; calm water at rest has no constant lateral jet.
  let peel=min(speed*.75,sqrt(2.0*9.81*pressureHead)*(.20+.65*entry))+sqrt(impact)*1.9;
  contacts[i].flow = vec4f(H.forward.xyz*speed*0.8+outward*peel,wet);
  contacts[i].state = vec4f(signedWater,select(age,0.001,launch),closing,select(old.state.w,old.state.w+1.0,launch));
  if(reset){contacts[i].state.w=0.0;}

}
`;

export const WAKE_UPDATE = INTERACTION_TYPES + /* wgsl */ `
@group(0) @binding(0) var<uniform> I: Interaction;
@group(0) @binding(1) var<uniform> H: InteractionHull;
@group(0) @binding(2) var prevWake: texture_2d<f32>;
@group(0) @binding(3) var dstWake: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<storage, read> contacts: array<Contact, ${CONTACT_COUNT}>;
@group(0) @binding(5) var<storage, read_write> landings: array<atomic<u32>>;
fn previousCell(q: vec2i) -> vec4f {
  if (any(q < vec2i(1)) || any(q >= vec2i(${WAKE_SIZE - 1})) || I.previous.w > 0.5) { return vec4f(0.0); }
  return textureLoad(prevWake, q, 0);
}
fn previousFoam(q:vec2f)->vec2f {
  let cell=vec2i(floor(q));let f=fract(q);
  return mix(mix(previousCell(cell).zw,previousCell(cell+vec2i(1,0)).zw,f.x),
    mix(previousCell(cell+vec2i(0,1)).zw,previousCell(cell+vec2i(1,1)).zw,f.x),f.y);
}
// Interpolate the measured waterline rather than switching whole emitters at
// each half-contact. In particular, Victory's aft span ends at 5.65, not 5.25.
fn wakeContact(first:u32,count:u32,u:f32)->Contact {
  let at=clamp(u,0.0,1.0)*f32(count-1u);
  let index=min(u32(floor(at)),count-2u);let t=at-f32(index);
  let a=contacts[first+index];let b=contacts[first+index+1u];
  let axis=mix(a.axis.xyz,b.axis.xyz,t);
  return Contact(mix(a.point,b.point,t),vec4f(axis/max(length(axis),.0001),mix(a.axis.w,b.axis.w,t)),mix(a.flow,b.flow,t),mix(a.state,b.state,t));
}
fn wakeForeU(along:f32)->f32 {
  return clamp((along/max(H.size.y*select(6.4,6.0,H.rig.w>.5)/12.0,.1)-.28)/.712,0.0,1.0);
}
fn wakeAftU(along:f32)->f32 {
  return clamp((-along/max(H.size.y/12.0,.1)-2.0)/(select(5.25,5.65,H.rig.w>.5)-2.0),0.0,1.0);
}
struct WakePressure { shape:vec4f, drift:vec2f };
fn wakePressure(p:vec2f,c:Contact,width:f32)->WakePressure {
  let delta=p-c.point.xz;let r2=dot(delta,delta)/(width*width);
  let outside=dot(delta,c.axis.xz);
  let edge=smoothstep(-.2,.25,outside);
  let tangent=dot(delta,vec2f(-c.axis.z,c.axis.x))/width;
  // Equal-width translated kernels balance each local pressure pair. Moving
  // interpolation and hull clipping still do not constitute volume conservation.
  // Their breadth is resolved by the wake grid, not a separate reflective strip.
  let crest=exp(-pow((outside-width*.2)/(width*.7),2.0)-tangent*tangent);
  let hollow=exp(-pow((outside-width*1.6)/(width*.7),2.0)-tangent*tangent);
  let pulse=exp(-r2*2.0)*(1.0-r2*2.0)*smoothstep(-.1,.2,outside)*c.axis.w;
  let relativeFlow=c.flow.xz-H.forward.xz*max(0.0,I.motion.x)*.8;
  let peel=max(0.0,dot(relativeFlow,c.axis.xz));
  return WakePressure(vec4f(crest*c.point.w,hollow*c.point.w,pulse,crest*edge*c.point.w*peel/max(width,.1)),c.axis.xz*peel*crest*edge*c.flow.w);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let q = vec2i(id.xy);
  let deposited = f32(atomicExchange(&landings[id.y * ${WAKE_SIZE}u + id.x], 0u)) / 4096.0;
  if (I.motion.y < 0.5) { textureStore(dstWake, q, vec4f(0.0)); return; }
  let shift = vec2i(round((I.domain.xy - I.previous.xy) / I.domain.w));
  let pq = q + shift;
  let old = previousCell(pq);
  let neighbours = previousCell(pq + vec2i(1,0)) + previousCell(pq - vec2i(1,0)) + previousCell(pq + vec2i(0,1)) + previousCell(pq - vec2i(0,1));
  let lap = neighbours.x - 4.0 * old.x;
  let p = (vec2f(id.xy) + 0.5 - ${WAKE_SIZE / 2}.0) * I.domain.w + I.domain.xy;
  let delta = p - H.origin.xz;
  let along = dot(delta, H.forward.xz);
  let u=wakeForeU(along);let aftU=wakeAftU(along);
  // Resolve the pressure crest in the simulation grid; the removed sub-texel
  // reflective ribbon cannot substitute for this actual surface displacement.
  let width=max(max(.55,H.size.x*.18),I.domain.w*1.5);
  let port=wakePressure(p,wakeContact(0u,16u,u),width);
  let starboard=wakePressure(p,wakeContact(16u,16u,u),width);
  let aftPort=wakePressure(p,wakeContact(32u,4u,aftU),width);
  let aftStarboard=wakePressure(p,wakeContact(36u,4u,aftU),width);
  // Both sides contribute continuously around the stem, without a side-selector seam.
  let pressure=port.shape+starboard.shape+(aftPort.shape+aftStarboard.shape)*.45;
  let source=pressure.x;let hollow=pressure.y;let pulse=pressure.z;
  // Sample the actual aft waterline: bow immersion cannot stand in for a dry stern.
  let sternCentre = (contacts[35].point.xz + contacts[39].point.xz) * 0.5;
  let sternDelta = p-sternCentre;
  let horizontalForward=H.forward.xz/max(length(H.forward.xz),.001);
  let horizontalRight=vec2f(-horizontalForward.y,horizontalForward.x);
  let sternAlong = dot(sternDelta,horizontalForward);
  let sternAcross = dot(sternDelta,horizontalRight);
  let sternLength=max(I.domain.w*2.0,H.size.y*.065);
  let sternWidth=max(I.domain.w*1.5,H.size.x*.32);
  let stern=exp(-pow(sternAlong/sternLength,2.0)-pow(sternAcross/sternWidth,2.0));
  let sternWet = (contacts[35].flow.w + contacts[39].flow.w) * 0.5;
  let forwardSpeed = max(0.0, I.motion.x);
  // A trough at the transom and a recovery crest behind it radiate into the trail.
  // U²/g controls the longitudinal scale; grid/domain bounds keep this local.
  // The non-dispersive propagation below still does not establish a Kelvin angle.
  let recoveryDistance=max(I.domain.w*2.0,min(H.size.y*.35,3.14159265*forwardSpeed*forwardSpeed/9.81));
  let recoveryLength=max(I.domain.w*2.0,recoveryDistance*.6);
  let recoveryWidth=max(I.domain.w*1.5,H.size.x*.5);
  let recovery=exp(-pow((sternAlong+recoveryDistance)/recoveryLength,2.0)-pow(sternAcross/recoveryWidth,2.0));
  let recoveryWeight=sternLength*sternWidth/(recoveryLength*recoveryWidth);
  let headway=smoothstep(.15,1.2,forwardSpeed);
  let sternHead=min(.35,forwardSpeed*forwardSpeed/(2.0*9.81)*.30)*sternWet*headway;
  // Compact alternating pressure lobes shed real waves at the wet quarter.
  // Their mean is zero over the plane; nothing is painted/forced along a long
  // ship-attached trail. Timing is an authored beam-scaled visual approximation,
  // not a propeller jet, calibrated vortex model, or deep-water Kelvin solver.
  let shedLength=max(I.domain.w*2.0,H.size.x*.42);
  let shedWidth=max(I.domain.w*1.5,H.size.x*.20);
  let shedAlong=(sternAlong+sternLength*.6)/shedLength;
  let portR2=shedAlong*shedAlong+pow((sternAcross+H.size.x*.23)/shedWidth,2.0);
  let starboardR2=shedAlong*shedAlong+pow((sternAcross-H.size.x*.23)/shedWidth,2.0);
  let shedding=sin(I.phase.x*sqrt(9.81/max(H.size.x,1.0))*1.1)*((1.0-portR2)*exp(-portR2)-(1.0-starboardR2)*exp(-starboardR2));
  let forcing=(source-hollow)*10.0+pulse*14.0
    +(recovery*recoveryWeight-stern)*sternWet*min(.65,forwardSpeed*forwardSpeed*.035)
    +shedding*sternHead*2.0;
  let dt = I.previous.z;
  // c=2.5 m/s and dx>=0.5 m remain CFL-stable at the host's maximum dt=0.1 s.
  let velocity = clamp((old.y + (6.25 * lap / (I.domain.w * I.domain.w) + forcing - old.x * 0.6) * dt) * exp(-dt * 0.38), -3.0, 3.0);
  let edge = 1.0 - smoothstep(0.43, 0.495, max(abs(p.x - I.domain.x), abs(p.y - I.domain.y)) / I.domain.z);
  let height = clamp(old.x + velocity * dt, -0.7, 1.1) * edge;
  let froude=forwardSpeed/sqrt(9.81*max(H.size.y,1.0));
  // Broad, intermittent entrainment, not a propeller jet. Texture stays in world
  // space, so an old trail follows the travelled track through turns and stops.
  let churn=.72+.28*shedding;
  let foamSource=(source*2.8+pressure.w*.7)*smoothstep(.6,3.5,forwardSpeed)+max(pulse,0.0)*1.4+stern*sternWet*min(4.0,forwardSpeed*.95)*smoothstep(.04,.28,froude)*churn;
  let eddy=vec2f(cos(p.y*0.65+I.phase.x*0.5),-cos(p.x*0.65-I.phase.x*0.4))*0.24;
  let peelDrift=port.drift+starboard.drift+(aftPort.drift+aftStarboard.drift)*.45;
  let drift=I.motion.zw*.012+eddy+peelDrift/max(1.0,length(peelDrift)/2.0);
  let transported=previousFoam(vec2f(pq)-drift*dt/I.domain.w);
  let spread=1.0-exp(-dt*0.28/(I.domain.w*I.domain.w));
  let aged=mix(transported,neighbours.zw*0.25,spread)*exp(-dt*vec2f(0.11,0.8));
  let born=1.0-exp(-foamSource*dt);
  let foam=clamp(aged+(vec2f(1.0)-aged)*born+deposited,vec2f(0.0),vec2f(1.0))*edge;
  textureStore(dstWake, q, vec4f(height, velocity * edge, foam));
}
`;

export const SHEET_UPDATE = FRAME_WGSL + INTERACTION_TYPES + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var seaTex: texture_2d_array<f32>;
@group(0) @binding(3) var seaSamp: sampler;
@group(0) @binding(4) var<storage, read> contacts: array<Contact, ${CONTACT_COUNT}>;
@group(0) @binding(5) var<storage, read_write> sheets: array<Sheet, ${SHEET_COUNT}>;
@group(0) @binding(6) var<storage, read_write> landings:array<atomic<u32>>;
` + INTERACTION_SEA + /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i=id.x; var s=sheets[i]; let dt=I.previous.z;
  if(I.motion.y<0.5 || I.previous.w>0.5){sheets[i].velocity.w=0.0;return;}
  s.origin.w+=dt;
  if(s.velocity.w>0.0){
    let t=s.origin.w*0.8;
    let p=s.origin.xyz+s.velocity.xyz*t-vec3f(0.0,4.905*t*t,0.0);
    let landed=t>0.2 && s.velocity.y-9.81*t<0.0 && p.y<interactionSea(p.xz);
    if(s.origin.w>s.velocity.w || landed){
      if(landed){for(var j=-2;j<=2;j++){
        let at=p.xz+s.tangent.xz*f32(j)*s.tangent.w*.6;
        let cell=vec2i(floor((at-I.domain.xy)/I.domain.w+${WAKE_SIZE/2}.0));
        if(all(cell>=vec2i(0)) && all(cell<vec2i(${WAKE_SIZE}))){atomicAdd(&landings[u32(cell.y)*${WAKE_SIZE}u+u32(cell.x)],u32(min(800.0,s.axis.w*240.0)));}
      }
      }
      s.velocity.w=0.0;
    }
  }
  let ci=i/4u;let c=contacts[ci];
  let neighbor=contacts[min(ci+1u,(ci/16u)*16u+15u)];
  if(ci%2u==0u && c.state.y<0.002 && u32(c.state.w)%4u==i%4u && c.axis.w>0.1){
    let energy=c.axis.w;
    s.origin=vec4f(mix(c.point.xyz,neighbor.point.xyz,.5)+vec3f(0.0,0.04,0.0),0.001);
    s.velocity=vec4f(c.flow.xyz+vec3f(0.0,1.2+sqrt(energy)*3.0,0.0),0.7+sqrt(energy)*0.32);
    s.axis=vec4f(c.axis.xyz,energy);
    s.tangent=vec4f(normalize(vec3f(-c.axis.z,0.0,c.axis.x)),clamp(distance(c.point.xyz,neighbor.point.xyz)*1.3,.32,1.1));
  }
  sheets[i]=s;
}
`;

export const SPRAY_UPDATE = FRAME_WGSL + WAKE_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var seaTex: texture_2d_array<f32>;
@group(0) @binding(3) var seaSamp: sampler;
@group(0) @binding(4) var wakeTex: texture_2d<f32>;
@group(0) @binding(5) var wakeSamp: sampler;
@group(0) @binding(6) var<storage, read> contacts: array<Contact, ${CONTACT_COUNT}>;
@group(0) @binding(7) var<storage, read_write> drops: array<Drop, ${SPRAY_COUNT}>;
@group(0) @binding(8) var<storage, read_write> landings: array<atomic<u32>>;
` + INTERACTION_SEA + /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  var d = drops[i];
  let dt = I.previous.z;
  if (I.motion.y < 0.5 || I.previous.w > 0.5) { drops[i].position.w = 0.0; return; }
  if (d.position.w > 0.0) {
    d.position.w -= dt;
    let mist = d.shape.z;
    let drag = 1.0 - exp(-dt * mix(0.35, 2.2, mist));
    d.velocity = vec4f(mix(d.velocity.xyz, vec3f(I.motion.z * 0.5, 0.0, I.motion.w * 0.5), drag), d.velocity.w);
    d.velocity.y -= mix(9.81, 3.0, mist) * dt;
    d.position = vec4f(d.position.xyz + d.velocity.xyz * dt, d.position.w);
    let level = interactionSea(d.position.xz) + wakeAt(d.position.xz + I.domain.xy - I.previous.xy).x;
    if (d.position.y <= level && d.velocity.y < 0.0) {
      let cell = vec2i(floor((d.position.xz - I.domain.xy) / I.domain.w + ${WAKE_SIZE / 2}.0));
      if (all(cell >= vec2i(0)) && all(cell < vec2i(${WAKE_SIZE}))) {
        atomicAdd(&landings[u32(cell.y) * ${WAKE_SIZE}u + u32(cell.x)], select(100u, 24u, mist > 0.5));
      }
      d.position.w = 0.0;
    }
    drops[i] = d;
    return;
  }
  let seed = i * 1399u + u32(I.phase.y) * 7919u;
  let r0 = interactionRandom(seed); let r1 = interactionRandom(seed + 1u); let r2 = interactionRandom(seed + 2u);
  let ci=u32(r0*31.999); let next=min(ci+1u,(ci/16u)*16u+15u);
  let contact=contacts[ci]; let neighbor=contacts[next];
  let energy=mix(contact.axis.w,neighbor.axis.w,r2);
  let rate=max(0.0,energy-0.18)*0.28*smoothstep(.06,.2,contact.state.y)*(1.0-smoothstep(.45,.85,contact.state.y));
  if (r1 > 1.0 - exp(-rate * dt)) { return; }
  let mist = select(0.0, 1.0, i % 24u != 0u);
  let life = mix(0.45+r2*0.25,0.65+r2*0.55,mist);
  let lift = 1.0+sqrt(energy)*(2.4+r1*1.3);
  let velocity = contact.flow.xyz * (0.65 + r2 * 0.35) + vec3f(0.0, lift, 0.0);
  // Fragmenting sheet lips emit mist in flight, rather than bead streams at the hull.
  let flight=min(.38,contact.state.y*.65);
  let p=mix(contact.point.xyz,neighbor.point.xyz,r2)+velocity*flight-vec3f(0,4.905*flight*flight,0)
    +contact.axis.xyz*(.10+r1*.20)+vec3f(0,.12,0);
  drops[i].position = vec4f(p, life);
  drops[i].velocity = vec4f(velocity, life);
  drops[i].shape = vec4f(mix(0.003+r0*0.004,0.22+r0*0.32,mist),r2,mist,energy);
}
`;

// Both populations share the ocean's sky/sun illumination and reverse-Z depth buffer.
export const WATER_EFFECTS = FRAME_WGSL + ATMO_CORE_WGSL + NOISE_WGSL + INTERACTION_TYPES + SHADOW_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var<storage, read> sheets: array<Sheet, ${SHEET_COUNT}>;
@group(0) @binding(3) var<storage, read> drops: array<Drop, ${SPRAY_COUNT}>;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var effectSamp: sampler;
@group(0) @binding(6) var transLUT: texture_2d<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
struct EffectVertex { @builtin(position) position: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) data: vec4f };
fn sheetPoint(s: Sheet, u: f32, q: f32) -> vec3f {
  let t=s.origin.w*(0.35+0.65*q)*(1.0+0.06*sin(u*4.0+s.origin.x*2.0));
  let fan=s.tangent.w*(0.65+q)*(1.0+t*1.6);
  let curl=(1.0-u*u)*sin(q*3.14159)*s.axis.w*0.12;
  return s.origin.xyz+s.velocity.xyz*t-vec3f(0.0,4.905*t*t-curl,0.0)+s.tangent.xyz*u*fan+vec3f(I.motion.z,0,I.motion.w)*(.08*t*t*q);
}
@vertex fn sheetVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> EffectVertex {
  let corners=array<vec2u,6>(vec2u(0,0),vec2u(1,0),vec2u(1,1),vec2u(0,0),vec2u(1,1),vec2u(0,1));
  let cell=vi/6u; let corner=corners[vi%6u];
  let u=f32(cell/10u+corner.x)/8.0*2.0-1.0;
  let q=f32(cell%10u+corner.y)/10.0;
  let s=sheets[i]; let p=sheetPoint(s,u,q);
  let a=sheetPoint(s,u+0.01,q)-sheetPoint(s,u-0.01,q);
  let b=sheetPoint(s,u,q+0.01)-sheetPoint(s,u,q-0.01);
  let crossN=cross(a,b); var o:EffectVertex;
  o.position=F.viewProj*vec4f(p-F.camPos.xyz,1.0);
  o.world=p; o.normal=crossN/max(length(crossN),0.0001); o.uv=vec2f(u*0.5+0.5,q);
  o.data=vec4f(select(0.0,s.axis.w,s.velocity.w>0.0),s.origin.w/max(s.velocity.w,0.001),f32(i),0.0);
  return o;
}
@vertex fn dropVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> EffectVertex {
  let corners = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let d = drops[i];
  let age = clamp(1.0 - d.position.w / max(0.01, d.velocity.w), 0.0, 1.0);
  let distanceToEye = distance(d.position.xyz, F.camPos.xyz);
  let size = min(d.shape.x * mix(1.0, 1.0 + age * 2.4, d.shape.z), distanceToEye * length(F.camUp.xyz) * mix(1.2, 70.0, d.shape.z) / F.screen.y);
  let uv = corners[vi];
  let right = normalize(F.camRight.xyz); let up = normalize(F.camUp.xyz);
  let projected = vec2f(dot(d.velocity.xyz, right), dot(d.velocity.xyz, up));
  let direction = (projected + vec2f(0.0, 0.001)) / max(length(projected + vec2f(0.0, 0.001)), 0.001);
  let stretch = mix(1.0 + min(1.3, length(projected) * 0.06), 1.0, d.shape.z);
  let offset = direction * uv.y * stretch + vec2f(direction.y, -direction.x) * uv.x;
  let p = d.position.xyz + (right * offset.x + up * offset.y) * size;
  var o: EffectVertex;
  o.position = F.viewProj * vec4f(p - F.camPos.xyz, 1.0);
  o.world = p; o.normal = vec3f(0,1,0); o.uv = uv;
  o.data = vec4f(select(0.0, smoothstep(0.35, 1.2, distanceToEye), d.position.w > 0.0), age, d.shape.z, d.shape.y);
  return o;
}
fn sprayLight(p: vec3f) -> vec3f {
  let sky = textureSampleLevel(envCube, effectSamp, vec3f(0,1,0), 5.0).rgb;
  let sun = textureSampleLevel(transLUT, effectSamp, transRMuToUV(RG + F.atmo.y, F.sunDir.y), 0.0).rgb * F.sunDir.w * sunVis[0] * vesselShadow(p,vec3f(0,1,0));
  let view = normalize(F.camPos.xyz - p);
  let scatter = pow(max(dot(-view, F.sunDir.xyz), 0.0), 12.0);
  return sky * 0.85 + sun * (0.12 + scatter * 0.65)+vec3f(.65,.78,1.0)*F.reserved.z*1.5;
}
@fragment fn sheetFS(o: EffectVertex) -> @location(0) vec4f {
  let n = normalize(o.normal + vec3f(0.0, 0.0001, 0.0));
  let view = normalize(F.camPos.xyz - o.world);
  let reflected = textureSampleLevel(envCube, effectSamp, reflect(-view, n), 1.3).rgb;
  let noise=clamp(0.5+gnoise(o.uv*vec2f(9.0,5.0)+vec2f(o.data.z*2.7,-o.data.y*1.3)),0.0,1.0);
  let lip=smoothstep(0.72,0.98,o.uv.y);
  let foam=lip*(0.35+noise*0.45);
  let fresnel=0.04+0.65*pow(1.0-abs(dot(n,view)),5.0);
  let color=mix(reflected*(0.45+fresnel)+F.waterCol.rgb*0.3,sprayLight(o.world),foam);
  let ends=smoothstep(0.0,0.16,o.uv.x)*(1.0-smoothstep(0.84,1.0,o.uv.x));
  let holes=mix(1.0,smoothstep(0.25,0.58,noise),smoothstep(0.3,0.85,o.data.y)*smoothstep(0.3,0.95,o.uv.y));
  let fade=smoothstep(0.0,0.08,o.data.y)*(1.0-smoothstep(0.5,1.0,o.data.y));
  let rim=smoothstep(0.0,0.12,o.uv.y)*(1.0-smoothstep(0.76+noise*0.14,1.0,o.uv.y));
  let alpha=smoothstep(0.05,0.3,o.data.x)*ends*rim*holes*fade*(0.20+foam*0.45)*I.motion.y;
  return vec4f(color * alpha, alpha);
}
@fragment fn dropFS(o: EffectVertex) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  let alpha = exp(-r2 * mix(3.5, 2.5, o.data.z)) * (1.0 - smoothstep(0.65, 1.0, r2)) * (1.0 - smoothstep(0.55, 1.0, o.data.y)) * mix(0.16, 0.028, o.data.z) * o.data.x * I.motion.y;
  return vec4f(sprayLight(o.world) * alpha, alpha);
}
`;
