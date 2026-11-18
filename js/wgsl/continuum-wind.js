// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one cut's WIND pose kind (js/wgsl/continuum-kinds.js): bodies that sway, trees (js/forest-continuum.js) and grass
// (js/meadow-grass.js). Every point reads the atlas's wind stream, its sway weight (0 at a trunk's foot, 1 at the
// tips it bends furthest) | its branch's phase << 16 (unorm16 each), and is carried along the wind (F.windP) by its
// instance's gust; a body may also stand draped over the ground, felled at a hinge, or wounded, and be pushed (a blast,
// a passing ball). A far-body point reads no stream, so the far body stands still: its sway is below its error.
//
// Pose data, three vec4f an instance, written by its family's own pass each frame:
//   [0] gust phase (radians), gust strength (metres of the type's own at full weight), stiffness (0 to 1: how much
//       faster a stiff body swings), form (CONTINUUM_WIND_FORM)
//   [1] the form's own:
//       DRAPED   the ground's height (the type's metres, from its position) under the four corners of its type's square
//                (low.xz to low.xz + span): low x low z, high x low z, low x high z, high x high z; each point is lifted
//                by the ground under it.
//       FELLED   [hinge height, bearing, angle, 0]: whatever stands above the hinge turned about it by `angle` (radians)
//                so that up goes toward `bearing` (radians in the type's frame, from +x toward +z).
//       WOUNDED  [height, bearing, severity (0 to 1), 0]: a gouge on the side the ball came from (bearing), its wood
//                pressed in (continuumWindWound; a material reads the same to show the raw wood).
//   [2] push: a displacement at full weight (the type's metres, in its frame), 0 for none; and in w the gust's wave
//       number along the wind (radians a metre of the scene's frame): a body wide enough to span the gust fronts, as a
//       meadow's patch is, sees them roll across it downwind, and its neighbours see the same fronts. 0 for a tree.
import { CONTINUUM_KIND, CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_STREAMS } from '../continuum-format.js';
import { defineContinuumKind } from './continuum-kinds.js';

export const CONTINUUM_WIND_FORM = Object.freeze({ STANDING: 0, DRAPED: 1, FELLED: 2, WOUNDED: 3 });
// The pose data an instance of the kind takes, in vec4f.
export const CONTINUUM_WIND_POSE = 3;
// A wind stream word: sway weight and branch phase, each in 0..1.
export function packContinuumWind(weight, phase) {
  const unit = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
  return (unit(weight) | (unit(phase - Math.floor(phase)) << 16)) >>> 0;
}

defineContinuumKind(CONTINUUM_KIND.WIND, {
  name: 'Wind',
  wgsl: () => {
    const wind = CONTINUUM_STREAMS.find((s) => s.name === 'wind'), F = CONTINUUM_WIND_FORM;
    return /* wgsl */`
fn continuumWindFall(v:vec3f,bearing:f32,angle:f32)->vec3f {
  let b=vec2f(cos(bearing),sin(bearing));let s=sin(angle);let c=cos(angle);
  let along=v.x*b.x+v.z*b.y;let reach=along*c+v.y*s;
  return vec3f(v.x-b.x*along+b.x*reach,v.y*c-along*s,v.z-b.y*along+b.y*reach);
}
// The ground under a point of a draped instance, from the four corners its pose holds.
fn continuumWindDrape(record:ContinuumRecord,data:u32,at:vec2f)->f32 {
  let model=continuumTypeOf(record);
  let low=vec2f(continuumTypeF(model,${CONTINUUM_TYPE.low}u),continuumTypeF(model,${CONTINUUM_TYPE.low + 2}u));
  let f=clamp((at-low)/max(continuumTypeF(model,${CONTINUUM_TYPE.span}u),1e-4),vec2f(0.0),vec2f(1.0));
  let h=continuumPoses[data+1u];
  return mix(mix(h.x,h.y,f.x),mix(h.z,h.w,f.x),f.y);
}
// How deep a wound marks a point of a wounded instance, 0 to 1 (0 for any other form): along the trunk about the
// height it was struck at, on the side the ball came from, the trunk alone.
fn continuumWindWound(data:u32,position:vec3f,normal:vec3f)->f32 {
  if(abs(continuumPoses[data].w-${F.WOUNDED}.0)>0.5){return 0.0;}
  let w=continuumPoses[data+1u];
  let along=abs(position.y-w.x)/(0.6+0.6*w.z);
  if(along>=1.0){return 0.0;}
  let facing=smoothstep(-0.6,0.5,-dot(normal.xz,vec2f(cos(w.y),sin(w.y))));
  return (1.0-along*along)*facing*(1.0-smoothstep(0.9,1.25,length(position.xz)));
}
fn continuumWindPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  var out=p;
  let gust=continuumPoses[data];let form=u32(round(gust.w));let held=continuumPoses[data+1u];
  if(form==${F.DRAPED}u){out.position.y+=continuumWindDrape(record,data,p.position.xz);}
  else if(form==${F.FELLED}u){
    if(p.position.y>held.x){let hinge=vec3f(0.0,held.x,0.0);out.position=hinge+continuumWindFall(p.position-hinge,held.y,held.z);out.normal=continuumWindFall(p.normal,held.y,held.z);}
  }
  else if(form==${F.WOUNDED}u){out.position-=p.normal*continuumWindWound(data,p.position,p.normal)*(0.03+0.09*held.z);}
  let word=continuumStreamWord(${CONTINUUM_HEADER.wind}u,${wind.bit}u,${wind.words}u,vertex,0u);
  let weight=f32(word&65535u)/65535.0;
  if(weight<=0.0){return out;}
  let branch=f32(word>>16u)/65535.0*6.2831853;
  // The whole bends with the gust, its branches bob, its leaves flutter: three motions at three speeds.
  let t=F.camPos.w;let rate=1.0+gust.z;
  let toward=continuumQuat(vec4f(-record.turn.xyz,record.turn.w),vec3f(F.windP[0].x,0.0,F.windP[0].y));
  let push=continuumPoses[data+2u];
  let downwind=F.windP[0].xy/max(length(F.windP[0].xy),1e-4);
  let front=gust.x-push.w*dot(continuumPlace(record,p.position).xz,downwind);
  let bend=0.65+0.35*sin(t*1.1*rate+front);
  let bob=0.3*sin(t*2.3*rate+front+branch);
  let flutter=0.25*sin(t*9.0*rate+branch*7.0);
  let sway=gust.y*weight;
  out.position+=toward*(sway*(bend+bob+flutter))+vec3f(0.0,sway*0.6*(bob+flutter),0.0)+push.xyz*weight;
  return out;
}
fn continuumWindSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f {
  let gust=continuumPoses[data];let form=u32(round(gust.w));let held=continuumPoses[data+1u];
  var s=sphere;
  if(form==${F.DRAPED}u){
    let at=continuumWindDrape(record,data,s.xz);
    s=vec4f(s.x,s.y+at,s.z,s.w+max(max(abs(held.x-at),abs(held.y-at)),max(abs(held.z-at),abs(held.w-at))));
  }else if(form==${F.FELLED}u&&part!=CONTINUUM_WHOLE){
    // The whole of a felled body is its type's sphere and its record's reach; a part above the hinge falls with it,
    // and one across it lies between where it stood and where it fell.
    let hinge=vec3f(0.0,held.x,0.0);let fallen=hinge+continuumWindFall(s.xyz-hinge,held.y,held.z);
    if(s.y-s.w>held.x){s=vec4f(fallen,s.w);}
    else if(s.y+s.w>held.x){s=vec4f((s.xyz+fallen)*0.5,s.w+0.5*length(fallen-s.xyz));}
  }
  return vec4f(s.xyz,s.w+abs(gust.y)*1.8+length(continuumPoses[data+2u].xyz));
}
`;
  },
});
