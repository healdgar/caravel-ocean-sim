// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {FRAME_WGSL, CASCADES} from './common.js';

export const HULL_CONTACT_COUNT = 10;
export const HULL_CONTACT_RECORD_BYTES = 96;
export const HULL_CONTACT_FLAGS = Object.freeze({valid: 1, armed: 2, wet: 4, event: 8});

// Incident FFT surface only: all six cascades, including horizontal displacement.
// Local wake grids are deliberately excluded. No pressure or force is generated.
export const HULL_CONTACT_QUERY = FRAME_WGSL + /* wgsl */ `
struct ContactHull {right:vec4f,up:vec4f,forward:vec4f,size:vec4f,origin:vec4f,rig:vec4f};
struct ContactControl {step:vec4f,gates:vec4f,tags:vec4u};
struct UnderProbe {position:vec4f,normal:vec4f};
struct UnderContact {
  previous:vec4f, // previous world point xyz and sampled sea Y
  current:vec4f,  // current world point xyz and signed immersion
  motion:vec4f,   // hull Vy, sampled-height Vy, relative Vy, normal closing diagnostic
  phase:vec4f,    // dry duration, event age, peak closing, unwrapped event time
  event:vec4f,    // preserved first-wet world point xyz and closing at entry
  tags:vec4u,     // epoch, event serial, sample ID, flags
};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<uniform>H:ContactHull;
@group(0)@binding(2)var<uniform>U:ContactControl;
@group(0)@binding(3)var<storage,read>probes:array<UnderProbe,${HULL_CONTACT_COUNT}>;
@group(0)@binding(4)var seaTex:texture_2d_array<f32>;
@group(0)@binding(5)var seaSampler:sampler;
@group(0)@binding(6)var<storage,read_write>contacts:array<UnderContact,${HULL_CONTACT_COUNT}>;
const VALID:u32=${HULL_CONTACT_FLAGS.valid}u;
const ARMED:u32=${HULL_CONTACT_FLAGS.armed}u;
const WET:u32=${HULL_CONTACT_FLAGS.wet}u;
const EVENT:u32=${HULL_CONTACT_FLAGS.event}u;
fn contactDisp(p:vec2f)->vec3f {
  var d=vec3f(0);
  for(var c=0u;c<${CASCADES}u;c++){
    d+=textureSampleLevel(seaTex,seaSampler,p*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;
  }
  return d;
}
fn contactSea(p:vec2f)->f32 {
  var q=p;
  for(var j=0u;j<3u;j++){q=p-contactDisp(q).xz;}
  return contactDisp(q).y;
}
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let i=id.x;
  if(i>=min(U.tags.z,${HULL_CONTACT_COUNT}u)||U.tags.y==0u){return;}
  var old=contacts[i];let epoch=U.tags.x;let dt=U.step.x;
  // A broken step invalidates history. Keep its serial inside the same epoch;
  // otherwise a later recovery could reuse an already consumed event number.
  if(!(dt>0.0&&dt<=0.100001)){
    old.tags=vec4u(epoch,select(0u,old.tags.y,old.tags.x==epoch),U.tags.w,0u);
    contacts[i]=old;return;
  }
  let scale=vec3f(H.size.x/3.6,H.right.w,H.size.y/12.0);
  if(!all(scale>vec3f(0))||!all(abs(scale)<vec3f(1e8))){old.tags.w=0u;contacts[i]=old;return;}
  let local=probes[i].position.xyz*scale;
  let p=H.origin.xyz+H.right.xyz*local.x+H.up.xyz*local.y-H.forward.xyz*local.z;
  let sea=contactSea(p.xz);let immersion=sea-p.y;
  if(!all(abs(p)<vec3f(1e15))||!(abs(sea)<1e8)){
    old.tags=vec4u(epoch,select(0u,old.tags.y,old.tags.x==epoch),U.tags.w,0u);
    contacts[i]=old;return;
  }
  let seed=old.tags.x!=epoch||(old.tags.w&VALID)==0u;
  if(seed){
    let flags=VALID|select(0u,WET,immersion>=U.step.w);
    contacts[i]=UnderContact(vec4f(p,sea),vec4f(p,immersion),vec4f(0),vec4f(0),vec4f(0),
      vec4u(epoch,select(0u,old.tags.y,old.tags.x==epoch),U.tags.w,flags));
    return;
  }
  let hullVy=(p.y-old.previous.y)/dt;
  // This sea-height derivative follows the moving probe. It is NOT a water
  // particle velocity or a calibrated impact pressure.
  let seaVy=(sea-old.previous.w)/dt;
  let relativeVy=hullVy-seaVy;
  if(!(abs(hullVy)<1e12&&abs(seaVy)<1e12&&abs(relativeVy)<1e12)){
    old.tags.w=0u;contacts[i]=old;return;
  }
  let closing=max(0.0,-relativeVy);
  let wasWet=(old.tags.w&WET)!=0u;
  let wet=select(select(wasWet,false,immersion<=-U.step.z),true,immersion>=U.step.w);
  let dry=immersion<=-U.step.z;
  let dryDuration=select(0.0,old.phase.x+dt,dry);
  var armed=(old.tags.w&ARMED)!=0u||(dry&&dryDuration>=U.gates.x);
  var flags=VALID|select(0u,WET,wet)|(old.tags.w&EVENT);
  var event=old.event;var serial=old.tags.y;
  var age=select(0.0,old.phase.y+dt,(old.tags.w&EVENT)!=0u);
  var peak=old.phase.z;var eventTime=old.phase.w;
  let entry=wet&&!wasWet;
  if(entry){
    if(armed&&relativeVy < -U.gates.z){
      serial+=1u;flags|=EVENT;age=0.0;peak=closing;eventTime=U.step.y;
      event=vec4f(p,closing);
    }
    // Consume the return even if its relative velocity was not inward. Another
    // event requires a genuinely dry interval, not a grey-band oscillation.
    armed=false;
  }
  if((flags&EVENT)!=0u&&wet&&age<=U.gates.w){peak=max(peak,closing);}
  flags|=select(0u,ARMED,armed);
  let nLocal=probes[i].normal.xyz/scale;
  let n=normalize(H.right.xyz*nLocal.x+H.up.xyz*nLocal.y-H.forward.xyz*nLocal.z);
  let normalClosing=max(0.0,dot(n,vec3f(0,relativeVy,0)));
  contacts[i]=UnderContact(vec4f(p,sea),vec4f(p,immersion),
    vec4f(hullVy,seaVy,relativeVy,normalClosing),vec4f(dryDuration,age,peak,eventTime),
    event,vec4u(epoch,serial,U.tags.w,flags));
}
`;
