// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How the one cut poses an instance's points (AGENTS.md rule 3): its pose kind (js/continuum-format.js CONTINUUM_KIND),
// in the packed word of its record. The cut (js/wgsl/continuum-cut.js) is written once for every kind: it asks the
// kind where a point of the type's own mesh now lies, and where a cluster's sphere does, then places the result as
// every instance is placed (stretched, scaled, turned, stood). A family whose bodies move otherwise defines its kind
// here, in its own file, by defineContinuumKind; it never edits the select, the lists or the budget.
//
// A kind is two WGSL functions, named by the kind:
//   fn continuum<Name>Pose(record:ContinuumRecord, data:u32, part:u32, vertex:u32, p:ContinuumPosed)->ContinuumPosed
//     a point p (its position and normal in the type's own metres; hidden false, wear 0) of cluster part `part`, atlas
//     vertex `vertex` (whose side streams it may read: continuumStreamWord), posed. Set hidden to leave it out; set
//     wear (0 to CONTINUUM_SURFACE_RANGE) for how worn it is (a shard's scorch). A far-body corner comes with part 0.
//   fn continuum<Name>Sphere(record:ContinuumRecord, data:u32, part:u32, sphere:vec4f)->vec4f
//     where a sphere of part `part` (a cluster's LOD, parent or culling sphere, in the type's own metres) now lies and
//     how large, every point of the part posed within it; w below 0 when the whole part is out of sight. With part
//     CONTINUUM_WHOLE it bounds the whole instance (its record's reach is added after).
// `data` is where the kind's pose data begins in the scene's pose buffer (continuumPoses, vec4f), past the stretch a
// STRETCHED instance's begins with. Both functions may read the frame (F), the atlas and the pose buffer.
//
// Implemented:
//   RIGID    nothing moves: the type as baked. No pose data.
//   SHARDED  a broken body: each part a shard on its own flight (js/ship-fracture.js's records). Pose data, vec4f:
//            [the frame time at which the flight clock read zero, shard count n, 0, 0], then four a shard (pivot and
//            release time; velocity and settle time; spin and the age it is hidden at; hinge, gravity, sink and what
//            holds it: -2 standing, -1 in flight, else the age it stopped at), then ceil(n / 4) of wear, a float a shard.
// Hook points, declared for the families that bring them (a kind without its functions is never drawn):
//   SKINNED  skinned bodies (crew, animals). Pose data: [joint count j, pose slack in metres, 0, 0], then j joints of
//            three vec4f (the rows of the 3x4 matrix taking the bind pose to the posed one, in the type's frame), then j
//            posed spheres (a vec4f each: where joint k's bound lies and its radius, slack included). A point reads the
//            skin stream (four joints, four unorm weights; all zero for a far-body point: joint 0 alone). A cluster's
//            part is its dominant joint: its spheres are carried by that joint's matrix and grown by the slack; WHOLE is
//            the union of the posed joint spheres.
//   RIDER    things that ride another body's posed surface (rigging on a heeling hull, a figure on a cart). Pose data:
//            [the offset, in vec4f, of the posed source buffer region it reads from, its vertex count, 0, 0]. A point
//            reads the rider stream (the source vertex it rides) and is carried by that vertex's posed offset (a vec4f
//            a source vertex in the pose buffer: displacement and its normal's turn as an angle about the source normal).
//   WIND     foliage and cloth that sway. Pose data: [gust phase, gust strength, stiffness, 0]. A point reads the wind
//            stream (sway weight | branch phase << 16) and is displaced along the wind (F.windP) by both.
//   DRAPED   sails and flags hung from spars. Pose data: [furl (0 set, 1 furled), billow, luff phase, 0], then the
//            yard's two ends; a point reads the UV stream for where it hangs (u along the yard, v down the drop).
//   HEIGHTFIELD  the land. Shares only the core test, the scene scalar, the census and the pipeline family: its pieces
//            are cut by their own select over a height grid (js/land-continuum.js), never through this dispatch.
import { FRACTURE_GRAVITY } from '../ship-fracture.js';
import { SIM_CLOCK_LOOP_S } from './common.js';
import { CONTINUUM_KIND } from '../continuum-format.js';

const continuumKindsDefined = new Map();
// A kind's two functions, named continuum<Name>Pose and continuum<Name>Sphere in `wgsl` (a function, written when a
// module is, so it may read constants loaded later in the bundle).
export function defineContinuumKind(kind, { name, wgsl }) {
  if (!Object.values(CONTINUUM_KIND).includes(kind)) throw Error(`No such continuum pose kind: ${kind}`);
  if (continuumKindsDefined.has(kind)) throw Error(`The continuum's ${name} kind is defined twice`);
  continuumKindsDefined.set(kind, { kind, name, wgsl });
}
export const continuumKinds = () => [...continuumKindsDefined.values()].sort((a, b) => a.kind - b.kind);

// The dispatch every pass calls: by the record's kind, to the kinds defined.
export function continuumKindsWGSL(kinds = continuumKinds()) {
  const cases = (call) => kinds.map(({ kind, name }) => `case ${kind}u:{out=continuum${name}${call};}`).join('');
  return kinds.map(({ wgsl }) => wgsl()).join('\n') + /* wgsl */`
fn continuumPose(record:ContinuumRecord,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  var out=p;let data=continuumKindData(record);
  switch(continuumKindOf(record)){${cases('Pose(record,data,part,vertex,p)')}default:{out.hidden=true;}}
  return out;
}
fn continuumSphere(record:ContinuumRecord,part:u32,sphere:vec4f)->vec4f {
  var out=vec4f(sphere.xyz,-1.0);let data=continuumKindData(record);
  switch(continuumKindOf(record)){${cases('Sphere(record,data,part,sphere)')}default:{}}
  return out;
}
`;
}

defineContinuumKind(CONTINUUM_KIND.RIGID, {
  name: 'Rigid',
  wgsl: () => /* wgsl */`
fn continuumRigidPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed { return p; }
fn continuumRigidSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f { return sphere; }
`,
});

defineContinuumKind(CONTINUUM_KIND.SHARDED, {
  name: 'Sharded',
  wgsl: () => /* wgsl */`
fn continuumShardedRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f { return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c); }
// Where a point of shard 'shard' is now, in the type's own frame.
fn continuumShardedFlight(data:u32,shard:u32,p:ContinuumPosed)->ContinuumPosed {
  var pose=p;
  let count=u32(continuumPoses[data].y);
  if(shard<count){let wear=continuumPoses[data+1u+count*4u+shard/4u];pose.wear=wear[shard%4u];}
  let at=data+1u+shard*4u;
  let motion=continuumPoses[at+3u];
  if(shard>=count||motion.w< -1.5){return pose;}
  let origin=continuumPoses[at];let flight=continuumPoses[at+1u];let spinHide=continuumPoses[at+2u];
  // The frame clock starts again every ${SIM_CLOCK_LOOP_S} s; no flight lasts that long.
  var clock=F.camPos.w-continuumPoses[data].x;
  if(clock<0.0){clock+=${SIM_CLOCK_LOOP_S.toFixed(1)};}
  let age=select(max(0.0,clock-origin.w),motion.w,motion.w>=0.0);
  if(spinHide.w>=0.0&&age>=spinHide.w){pose.hidden=true;return pose;}
  let settle=flight.w;let hinge=motion.x;let rate=length(spinHide.xyz);
  let free=max(0.0,min(age,settle)-hinge);let held=min(age,hinge);
  var angle=rate*free;
  if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
  let drop=0.5*${FRACTURE_GRAVITY}*motion.y*free*free+motion.z*max(0.0,age-settle);
  var relative=p.position-origin.xyz;
  if(rate>1e-5){
    let axis=spinHide.xyz/rate;let ca=cos(angle);let sa=sin(angle);
    relative=continuumShardedRotate(relative,axis,ca,sa);
    pose.normal=continuumShardedRotate(p.normal,axis,ca,sa);
  }
  pose.position=origin.xyz+relative+flight.xyz*free-vec3f(0.0,drop,0.0);
  return pose;
}
fn continuumShardedPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed { return continuumShardedFlight(data,part,p); }
// A shard's sphere is carried with its centre; a shard turns about its pivot, which keeps the radius. The whole
// instance is the type's sphere, its record's reach taking in its pieces in the air and on the ground.
fn continuumShardedSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f {
  if(part==CONTINUUM_WHOLE){return sphere;}
  var at:ContinuumPosed;at.position=sphere.xyz;at.normal=vec3f(0.0,1.0,0.0);at.hidden=false;at.wear=0.0;
  let posed=continuumShardedFlight(data,part,at);
  return vec4f(posed.position,select(sphere.w,-1.0,posed.hidden));
}
`,
});
