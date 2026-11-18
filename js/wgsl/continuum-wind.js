// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one cut's WIND pose kind (js/wgsl/continuum-kinds.js): bodies the wind moves, trees (js/forest-continuum.js) and
// grass (js/meadow-grass.js). Every point reads the atlas's wind stream, one word whose meaning is its body's:
//   a tree      bends by the bones of its skeleton (CONTINUUM_WIND_BONES at most, baked from its wood and leaves by
//               scripts/prepare-forest-continuum.mjs): the word names the two bones that carry the point and the first's
//               share (packContinuumWindBones), the phase its leaf flutters at, how far along its leaf from the foot it
//               lies and whether it is a leaf. Its family's pass steps each skeleton's bones as damped springs driven by
//               the wind's pressure on their wood and leaves (js/wgsl/forest-continuum.js), and a body pushed by a blast,
//               a passing ball or hull, or a walker steps a skeleton of its own; a point goes where its bones take it.
//               Its far body is carried by the same bones, so the whole tree, near and far, leans as one.
//   a sward     bends by its blades (packContinuumWind): the word is its sway weight (how far it bends at full gust, from
//               its height, how far along its stalk it stands and how supple it is) | its plant's phase << 16 (unorm16
//               each). A blade leans downwind, curls across it with the gusts' eddies, and drops as it leans so it never
//               stretches; its far body leans with it.
// A body may also stand draped over the ground, felled at a hinge, or wounded.
//
// Pose data, three vec4f an instance and a fourth for a draped one, written by its family's own pass each frame:
//   [0] DRAPED  [gust phase (radians), gust strength (metres of the type's own at full weight), the gust's share (0
//               to 1) over the body, form]
//       other   [where its skeleton for the wind's lane it stands in begins in the pose buffer (CONTINUUM_WIND_SKELETON
//               vec4f), where its own begins (-1: none), its own's share (0 to 1), form (CONTINUUM_WIND_FORM)]; a
//               skeleton below 0: it stands still.
//   [1] the form's own:
//       DRAPED   the ground's height (the type's metres, from its position) under the four corners of its type's square
//                (low.xz to low.xz + span): low x low z, high x low z, low x high z, high x high z; each point is lifted
//                by the ground under it.
//       FELLED   [hinge height, bearing, angle, 0]: whatever stands above the hinge turned about it by `angle` (radians)
//                so that up goes toward `bearing` (radians in the type's frame, from +x toward +z). It does not sway.
//       WOUNDED  [height, bearing, severity (0 to 1), 0]: a gouge on the side the ball came from (bearing), its wood
//                pressed in (continuumWindWound; a material reads the same to show the raw wood).
//   [2] DRAPED: push, a displacement at full weight (the type's metres, in its frame), 0 for none; and in w the gust's
//       wave number along the wind (radians a metre of the scene's frame): a body wide enough to span the gust fronts,
//       as a meadow's patch is, sees them roll across it downwind, and its neighbours see the same fronts. Otherwise 0.
//   [3] DRAPED only: the share of its plants standing at the four corners (as [1]'s): where the cover thins toward a
//       path, a beach or a bank, a plant stands mix(0.4, 1, share) of its height.
// A skeleton, in the pose buffer: [how far its pivots have moved at most, 2 sin(half the largest turn of any bone),
// the farthest pivot from the type's origin, 0] (what bounds where any point of the body can go: continuumWindReach),
// then two vec4f a bone: the unit quaternion turning it from rest, and [where the turn leaves the origin, 0], in the
// type's frame.
import { CONTINUUM_KIND, CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_STREAMS } from '../continuum-format.js';
import { defineContinuumKind } from './continuum-kinds.js';

export const CONTINUUM_WIND_FORM = Object.freeze({ STANDING: 0, DRAPED: 1, FELLED: 2, WOUNDED: 3 });
// The pose data an instance of the kind takes, in vec4f; a draped one takes one more.
export const CONTINUUM_WIND_POSE = 3;
export const CONTINUUM_WIND_DRAPED_POSE = 4;
// Bones a skeleton holds at most, and its block in the pose buffer: its reach, then two vec4f a bone.
export const CONTINUUM_WIND_BONES = 32;
export const CONTINUUM_WIND_SKELETON = 1 + 2 * CONTINUUM_WIND_BONES;
// How far a leaf's tip flutters at most, in metres of the world.
export const CONTINUUM_WIND_FLUTTER = 0.032;
const windUnit = (v, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(Math.max(0, Math.min(1, v)) * ((1 << bits) - 1))));
// A sward's wind word: sway weight and its plant's phase, each in 0..1.
export function packContinuumWind(weight, phase) {
  return (windUnit(weight, 16) | (windUnit(phase - Math.floor(phase), 16) << 16)) >>> 0;
}
// A tree's wind word: bone0 | bone1 << 5 | bone0's share << 10 (8 bits) | phase << 18 (6 bits) | how far along its leaf
// from the foot << 24 (7 bits) | leaf << 31.
export function packContinuumWindBones({ bone0, bone1 = bone0, weight0 = 1, phase = 0, along = 0, leaf = false }) {
  if (!(bone0 >= 0 && bone0 < CONTINUUM_WIND_BONES && bone1 >= 0 && bone1 < CONTINUUM_WIND_BONES)) throw Error(`No bone ${bone0} or ${bone1} in a skeleton`);
  return (bone0 | (bone1 << 5) | (windUnit(weight0, 8) << 10) | (windUnit(phase - Math.floor(phase), 6) << 18) | (windUnit(along, 7) << 24) | ((leaf ? 1 : 0) << 31)) >>> 0;
}

defineContinuumKind(CONTINUUM_KIND.WIND, {
  name: 'Wind',
  wgsl: () => {
    const wind = CONTINUUM_STREAMS.find((s) => s.name === 'wind'), F = CONTINUUM_WIND_FORM;
    return /* wgsl */`
struct ContinuumWindCarried { position:vec3f, normal:vec3f };
fn continuumWindFall(v:vec3f,bearing:f32,angle:f32)->vec3f {
  let b=vec2f(cos(bearing),sin(bearing));let s=sin(angle);let c=cos(angle);
  let along=v.x*b.x+v.z*b.y;let reach=along*c+v.y*s;
  return vec3f(v.x-b.x*along+b.x*reach,v.y*c-along*s,v.z-b.y*along+b.y*reach);
}
// Where a point of a draped instance lies across its type's square, 0 to 1 each way.
fn continuumWindAcross(record:ContinuumRecord,at:vec2f)->vec2f {
  let model=continuumTypeOf(record);
  let low=vec2f(continuumTypeF(model,${CONTINUUM_TYPE.low}u),continuumTypeF(model,${CONTINUUM_TYPE.low + 2}u));
  return clamp((at-low)/max(continuumTypeF(model,${CONTINUUM_TYPE.span}u),1e-4),vec2f(0.0),vec2f(1.0));
}
fn continuumWindCorners(h:vec4f,f:vec2f)->f32 { return mix(mix(h.x,h.y,f.x),mix(h.z,h.w,f.x),f.y); }
// The ground under a point of a draped instance, from the four corners its pose holds.
fn continuumWindDrape(record:ContinuumRecord,data:u32,at:vec2f)->f32 { return continuumWindCorners(continuumPoses[data+1u],continuumWindAcross(record,at)); }
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
// A point and its normal carried by bone b of the skeleton beginning at 'skeleton'.
fn continuumWindBone(skeleton:u32,b:u32,p:ContinuumWindCarried)->ContinuumWindCarried {
  let at=skeleton+1u+b*2u;let q=continuumPoses[at];
  return ContinuumWindCarried(continuumQuat(q,p.position)+continuumPoses[at+1u].xyz,continuumQuat(q,p.normal));
}
// By the two bones its word names, in their shares.
fn continuumWindSkin(skeleton:u32,word:u32,p:ContinuumWindCarried)->ContinuumWindCarried {
  let b0=word&31u;let b1=(word>>5u)&31u;let w0=f32((word>>10u)&255u)/255.0;
  var out=continuumWindBone(skeleton,b0,p);
  if(b1!=b0&&w0<0.998){let other=continuumWindBone(skeleton,b1,p);out=ContinuumWindCarried(mix(other.position,out.position,w0),mix(other.normal,out.normal,w0));}
  return out;
}
// How far the bones of a skeleton can carry any point of a sphere (the type's metres): a bone turns a point about its
// pivot, so it moves by as far as the pivot has, and by its turn times how far it lies from the pivot.
fn continuumWindReach(skeleton:u32,s:vec4f)->f32 { let h=continuumPoses[skeleton];return h.x+h.y*(length(s.xyz)+s.w+h.z); }
// A leaf flutters about its foot as the wind sheds eddies off it: it pitches and rolls the more the further along it a
// point lies, faster and further as the wind freshens, alive even in a light air.
fn continuumWindFlutter(record:ContinuumRecord,word:u32,p:ContinuumWindCarried)->ContinuumWindCarried {
  let along=f32((word>>24u)&127u)/127.0;
  let speed=F.windP[0].z;
  let ramp=clamp((speed-3.0)/17.0,0.0,1.0);let swing=smoothstep(0.08,1.4,speed)*mix(0.22,1.0,ramp);
  let phase=f32((word>>18u)&63u)/63.0*6.2831853+f32(record.tag.z&1023u)*0.0061;
  let at=F.camPos.w*(9.5+6.5*fract(phase*0.3183))*mix(0.32,1.0,ramp)+phase;
  let pitch=sin(at)+0.38*sin(at*2.17+1.1);let roll=cos(at*1.31+0.7);
  let reach=swing*${CONTINUUM_WIND_FLUTTER}/max(record.place.w,0.85);
  let side=normalize(cross(p.normal,select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(p.normal.y)>0.9)));let mid=cross(side,p.normal);
  return ContinuumWindCarried(p.position+p.normal*(reach*along*0.85*pitch)+side*(reach*0.28*along*roll),
    normalize(p.normal+mid*(pitch*swing*0.2*along)+side*(roll*swing*0.26*(0.35+0.65*along))));
}
// A point of a tree: its leaf fluttered, then carried by its bones, by its lane's skeleton and its own in their shares;
// its wood pinned at the foot, where the trunk stands in the ground.
fn continuumWindBones(record:ContinuumRecord,data:u32,word:u32,p:ContinuumPosed)->ContinuumPosed {
  var out=p;
  let bones=continuumPoses[data];
  if(bones.x<0.0){return out;}
  let leaf=(word>>31u)!=0u;
  var rest=ContinuumWindCarried(p.position,p.normal);
  if(leaf){rest=continuumWindFlutter(record,word,rest);}
  var carried=continuumWindSkin(u32(bones.x),word,rest);
  if(bones.y>=0.0&&bones.z>0.0){
    let own=continuumWindSkin(u32(bones.y),word,rest);
    carried=ContinuumWindCarried(mix(carried.position,own.position,bones.z),mix(carried.normal,own.normal,bones.z));
  }
  let pin=select(smoothstep(0.22,1.05,p.position.y),1.0,leaf);
  out.position=mix(rest.position,carried.position,pin);
  out.normal=normalize(mix(rest.normal,carried.normal,pin));
  return out;
}
// The eddies the gusts roll along: a blade curls across the wind by this, -1 to 1.
fn continuumWindCurl(at:vec2f,downwind:vec2f,speed:f32)->f32 {
  let t=F.camPos.w;let u=dot(at,downwind)-t*max(speed,5.2)*1.15;let v=dot(at,vec2f(-downwind.y,downwind.x));
  return sin(v*1.38+u*0.42)*cos(u*1.12-v*0.54+t*0.9);
}
// A point of a draped sward: stood as tall as its plants stand where the cover thins, its supple tops pressed down a
// little as the gust packet passes, leaned downwind as the gust front crossing it bends it and its tip flutters,
// curled across the wind by the eddies, pushed by shot, dropped as it leans so its blade keeps its length, and lifted
// onto the ground under it. Its material lights the bend (js/wgsl/meadow-continuum.js); the normal is left at rest.
fn continuumWindSward(record:ContinuumRecord,data:u32,vertex:u32,word:u32,p:ContinuumPosed)->ContinuumPosed {
  var out=p;
  let gust=continuumPoses[data];let push=continuumPoses[data+2u];
  let across=continuumWindAcross(record,p.position.xz);
  let stand=mix(0.4,1.0,continuumWindCorners(continuumPoses[data+3u],across));
  // How far along its stalk a point stands; a far body's points carry none and bend as the tops they stand for.
  var along=0.0;
  if(vertex!=CONTINUUM_NO_VERTEX){along=f32(continuumPointAt(continuumTypeOf(record),vertex).high&255u)/255.0;}
  let flexAlong=select(clamp(along*1.26,0.0,1.12),1.0,along==0.0);
  let press=1.0-0.14*gust.z*smoothstep(0.15,0.80,flexAlong);
  let height=max(p.position.y,0.0)*stand*press;
  out.position.y=p.position.y*stand*press;
  let weight=f32(word&65535u)/65535.0*stand;
  if(weight>0.0){
    let plant=f32(word>>16u)/65535.0*6.2831853;
    let speed=max(F.windP[0].z,5.2);
    let downwind=select(vec2f(0.82,0.57),normalize(F.windP[0].xy),dot(F.windP[0].xy,F.windP[0].xy)>0.0004);
    let at=continuumPlace(record,p.position).xz;
    let front=gust.x-push.w*dot(at,downwind);
    let tip=0.045*gust.z/(0.08+0.62*gust.z*clamp(speed/9.2,0.58,1.42))*sin(dot(at,downwind)*2.35-F.camPos.w*5.8+plant);
    let bend=gust.y*(0.65+0.35*sin(F.camPos.w*1.1+front)+tip);
    let curl=continuumWindCurl(at,downwind,speed)*(0.12+0.22*gust.z);
    let lean=normalize(downwind+vec2f(-downwind.y,downwind.x)*curl);
    let toward=continuumQuat(vec4f(-record.turn.xyz,record.turn.w),vec3f(lean.x,0.0,lean.y));
    let flex=select(smoothstep(0.04,0.75,along),1.0,along==0.0);
    let moved=toward*(weight*bend)+push.xyz*weight*flex;
    out.position+=vec3f(moved.x,0.0,moved.z);
    // The blade bends along an arc: as far as it leans, its point comes down (its lean and height scaled by the
    // patch's stretch, which the kind's points are posed before).
    let stretch=continuumStretch(record);
    let leaning=clamp(length(moved.xz*stretch.xz)/max(height*stretch.y,0.055),0.0,0.78);
    out.position.y-=height*(1.0-sqrt(max(0.25,1.0-leaning*leaning)))*smoothstep(0.08,0.65,flexAlong);
  }
  out.position.y+=continuumWindDrape(record,data,p.position.xz);
  return out;
}
fn continuumWindPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  let form=u32(round(continuumPoses[data].w));let held=continuumPoses[data+1u];
  let word=continuumStreamWord(${CONTINUUM_HEADER.wind}u,${wind.bit}u,${wind.words}u,vertex,0u);
  if(form==${F.DRAPED}u){return continuumWindSward(record,data,vertex,word,p);}
  var out=p;
  if(form==${F.FELLED}u){
    if(p.position.y>held.x){let hinge=vec3f(0.0,held.x,0.0);out.position=hinge+continuumWindFall(p.position-hinge,held.y,held.z);out.normal=continuumWindFall(p.normal,held.y,held.z);}
    return out;
  }
  if(form==${F.WOUNDED}u){out.position-=p.normal*continuumWindWound(data,p.position,p.normal)*(0.03+0.09*held.z);}
  return continuumWindBones(record,data,word,out);
}
fn continuumWindSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f {
  let gust=continuumPoses[data];let form=u32(round(gust.w));let held=continuumPoses[data+1u];
  var s=sphere;
  if(form==${F.DRAPED}u){
    let at=continuumWindDrape(record,data,s.xz);
    s=vec4f(s.x,s.y+at,s.z,s.w+max(max(abs(held.x-at),abs(held.y-at)),max(abs(held.z-at),abs(held.w-at))));
    // Its tips lean by its gust and flutter (a tenth of it at most) and its push.
    return vec4f(s.xyz,s.w+abs(gust.y)*1.1+length(continuumPoses[data+2u].xyz));
  }
  if(form==${F.FELLED}u){
    if(part!=CONTINUUM_WHOLE){
      // The whole of a felled body is its type's sphere and its record's reach; a part above the hinge falls with it,
      // and one across it lies between where it stood and where it fell.
      let hinge=vec3f(0.0,held.x,0.0);let fallen=hinge+continuumWindFall(s.xyz-hinge,held.y,held.z);
      if(s.y-s.w>held.x){s=vec4f(fallen,s.w);}
      else if(s.y+s.w>held.x){s=vec4f((s.xyz+fallen)*0.5,s.w+0.5*length(fallen-s.xyz));}
    }
    return s;
  }
  // As far as its bones can carry it, and its leaves flutter.
  if(gust.x<0.0){return s;}
  var reach=continuumWindReach(u32(gust.x),s);
  if(gust.y>=0.0&&gust.z>0.0){reach=max(reach,continuumWindReach(u32(gust.y),s));}
  return vec4f(s.xyz,s.w+reach+${(CONTINUUM_WIND_FLUTTER * 1.6).toFixed(4)}/max(record.place.w,0.85));
}
`;
  },
});
