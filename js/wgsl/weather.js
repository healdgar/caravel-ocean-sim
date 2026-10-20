import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { HULL_PROFILE } from './hull.js';
import { INTERACTION_TYPES } from './interaction.js';
import { QUARTERDECK_START, QUARTERDECK_HEIGHT } from '../hull.js';

export const WEATHER_RENDER=FRAME_WGSL+ATMO_CORE_WGSL+HULL_PROFILE+INTERACTION_TYPES+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
struct Weather {drift:vec4f,strike:vec4f,phase:vec4f};
@group(0) @binding(4) var<uniform> W:Weather;
@group(0) @binding(5) var<uniform> H:InteractionHull;
`+SKY_RENDER_FUNCS+/* wgsl */ `
fn weatherHash(i:u32)->f32 {
  var h=i*747796405u+2891336453u;h=((h>>((h>>28u)+4u))^h)*277803737u;
  return f32((h>>22u)^h)/4294967296.0;
}
fn weatherCorner(i:u32)->vec2f {
  return array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i];
}
struct WeatherVertex {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f};
@vertex fn rainVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->WeatherVertex {
  let seed=vec3f(weatherHash(id*3u),weatherHash(id*3u+1u),weatherHash(id*3u+2u));
  let snow=F.reserved.y>.5 && F.reserved.y<1.5;let hail=F.reserved.y>2.5;
  let velocity=vec3f(W.drift.z*.7,-select(select(10.0,15.0,hail),1.3,snow),W.drift.w*.7);
  let time=F.reserved.w;
  let fall=vec3f(W.drift.xy*.7,0).xzy+vec3f(0,velocity.y*time,0);
  let span=vec3f(70,40,70);
  var p=F.camPos.xyz+(fract((seed*span+fall-F.camPos.xyz)/span+.5)-.5)*span;
  if(snow){p.x+=sin(time*1.8+seed.z*90.0)*.35;p.z+=cos(time*1.3+seed.x*90.0)*.35;}
  let delta=p-F.camPos.xyz;let distance=length(delta);
  let corner=weatherCorner(vertex);
  let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);
  let axis=normalize(velocity);
  let crossAxis=cross(axis,normalize(-delta));
  let side=select(right,normalize(crossAxis+vec3f(.00001)),length(crossAxis)>.01);
  let pixel=distance*length(F.camUp.xyz)*F.screen.w;
  let width=max(select(select(.009,.022,hail),.035,snow),pixel*.65);
  let halfLength=select(select(.19+seed.y*.18,.045,hail),.035,snow);
  let across=select(side,right,snow||hail);let along=select(axis,up,snow||hail);
  var alpha=(.18+seed.z*.2)*(1.0-smoothstep(22.0,35.0,distance))*smoothstep(.5,1.5,distance);
  // Do not spawn precipitation inside the cabin, hull, or below a solid deck.
  let q=p-H.origin.xyz;
  let local=vec3f(dot(q,H.right.xyz)/(H.size.x/3.6),dot(q,H.up.xyz)/shipY(H.right.w),-dot(q,H.forward.xyz)/(H.size.y/12.0));
  let floor=modelVesselDeck(local.z,H.rig.w);
  if(H.rig.z>.5 && local.z> -6.3 && local.z<5.6 && abs(local.x)<modelHullWidth(local.z,modelHullDeck(local.z,H.rig.w),H.rig.w) && local.y<floor){alpha=0.0;}
  var out:WeatherVertex;
  out.position=F.viewProj*vec4f(delta+across*corner.x*width+along*corner.y*halfLength,1);
  out.uv=corner;
  let ambient=skyAtmo(vec3f(0,1,0))*.7+vec3f(.04,.05,.06)+lightningLight()*.5;
  out.color=vec4f(ambient,alpha);return out;
}
@fragment fn rainFS(v:WeatherVertex)->@location(0) vec4f {
  let round=F.reserved.y>.5;
  let edge=select((1.0-smoothstep(.15,1.0,abs(v.uv.x)))*(1.0-smoothstep(.65,1.0,abs(v.uv.y))),
    1.0-smoothstep(.2,1.0,dot(v.uv,v.uv)),round);
  let a=v.color.a*edge;return vec4f(v.color.rgb*a,a);
}

fn boltPoint(t:f32,branch:u32)->vec3f {
  let seed=W.strike.w;
  let base=vec3f(W.strike.x,0,W.strike.y);
  let bend=vec2f(sin(t*31.0+seed)*.6+sin(t*83.0+seed)*.23,cos(t*27.0+seed)*.5+cos(t*73.0+seed)*.2);
  var p=base+vec3f(bend.x*W.strike.z*.085,t*W.strike.z,bend.y*W.strike.z*.085);
  if(branch>0u){p+=vec3f(sin(seed+f32(branch)*37.0),-.5,cos(seed+f32(branch)*37.0))*max(0.0,.65-t)*W.strike.z*.65;}
  return p;
}
@vertex fn boltVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->WeatherVertex {
  let segment=instance%48u;let branch=instance/48u;let corner=weatherCorner(vertex);
  let t0=f32(segment)/48.0;let t1=f32(segment+1u)/48.0;
  let a=boltPoint(t0,branch);let b=boltPoint(t1,branch);let mid=(a+b)*.5;
  let side=normalize(cross(b-a,F.camPos.xyz-mid)+vec3f(.00001));
  let width=max(.8,length(mid-F.camPos.xyz)*.0012)*select(1.0,.5,branch>0u);
  let p=mix(a,b,corner.y*.5+.5)+side*corner.x*width;
  var out:WeatherVertex;out.position=F.viewProj*vec4f(p-F.camPos.xyz,1);out.uv=corner;
  let branchFade=select(1.0,smoothstep(.15,.35,t0)*(1.0-smoothstep(.55,.7,t0)),branch>0u);
  out.color=vec4f(vec3f(.7,.82,1.0)*18.0,F.reserved.z*branchFade);return out;
}
@fragment fn boltFS(v:WeatherVertex)->@location(0) vec4f {
  let core=exp(-abs(v.uv.x)*8.0);let glow=exp(-abs(v.uv.x)*2.0)*.12;
  return vec4f(v.color.rgb*(core+glow)*v.color.a,0);
}
`;
