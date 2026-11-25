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
//   SKINNED  skinned bodies (people, animals). Pose data: [joint count j, pose slack in metres, 0, 0], then j joints
//            of three vec4f (the rows of the 3x4 matrix taking the bind pose to the posed one, in the type's frame), then
//            j posed spheres (a vec4f each: where joint k's bound lies and its radius, slack included; a radius below 0
//            hides the joint, and every point it carries most). A point reads the skin stream (four joints, four unorm
//            weights; all zero: joint 0 alone). A cluster's part is its dominant joint: its spheres are carried by that
//            joint's matrix and grown by the slack; WHOLE bounds the posed joint spheres. A count of 0 is the type as
//            baked. js/wgsl/skinned-pose.js writes this data.
// Hook points, declared for the families that bring them (a kind without its functions is never drawn):
//   RIDER    things that ride another body's posed surface: a ship on her own posed assembly, her lines and let-go
//            iron with her. A point reads the rider stream (the source vertex it rides) and is placed where that vertex
//            is posed. Brought by the ships: js/wgsl/ship-kinds.js has its pose data.
//   WIND     bodies the wind moves (js/wgsl/continuum-wind.js defines it and its pose data). A tree bends by the bones
//            of its skeleton, stepped as damped springs by its family's pass; a point reads the wind stream (its two
//            bones and the first's share, its leaf's flutter phase) and goes where its bones take it, near and far
//            alike. A sward drapes over the ground and bends by its blades: the stream is its sway weight | its plant's
//            phase << 16. Either may stand felled or wounded.
//   DRAPED   a whole vessel posed per vertex from her record alone: canvas brailed to its yards by her furl, oars swept
//            through their stroke, helm swung. Brought by the ships: js/wgsl/ship-kinds.js has its pose data.
//   HEIGHTFIELD  the land. Shares only the core test, the scene scalar, the census and the pipeline family: its pieces
//            are cut by their own select over a height grid (js/land-continuum.js), never through this dispatch.
import { FRACTURE_GRAVITY } from '../ship-fracture.js';
import { SIM_CLOCK_LOOP_S } from './common.js';
import { CONTINUUM_KIND, CONTINUUM_HEADER, CONTINUUM_STREAMS } from '../continuum-format.js';
import { HUMAN_MORPH_WGSL } from './human-morph.js';

const continuumKindsDefined = new Map();
// A kind's two functions, named continuum<Name>Pose and continuum<Name>Sphere in `wgsl` (a function, written when a
// module is, so it may read constants loaded later in the bundle), plus optional `errorScale: true` for
// continuum<Name>ErrorScale(record, data, toEye)->f32 when a pose kind's surface orientation foreshortens relief error.
export function defineContinuumKind(kind, { name, wgsl, errorScale = false }) {
  if (!Object.values(CONTINUUM_KIND).includes(kind)) throw Error(`No such continuum pose kind: ${kind}`);
  if (continuumKindsDefined.has(kind)) throw Error(`The continuum's ${name} kind is defined twice`);
  continuumKindsDefined.set(kind, { kind, name, wgsl, errorScale });
}
export const continuumKinds = () => [...continuumKindsDefined.values()].sort((a, b) => a.kind - b.kind);

// The dispatch every pass calls: by the record's kind, to the kinds defined.
export function continuumKindsWGSL(kinds = continuumKinds()) {
  const cases = (call) => kinds.map(({ kind, name }) => `case ${kind}u:{out=continuum${name}${call};}`).join('');
  const scaleCases = kinds.filter((k) => k.errorScale).map(({ kind, name }) => `case ${kind}u:{out=continuum${name}ErrorScale(record,data,toEye);}`).join('');
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
fn continuumErrorScale(record:ContinuumRecord,toEye:vec3f)->f32 {
  var out=1.0;${scaleCases ? `let data=continuumKindData(record);switch(continuumKindOf(record)){${scaleCases}default:{}}` : ''}
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
  if(shard<count){let wear=continuumPoses[data+1u+count*4u+shard/4u];pose.wear=abs(wear[shard%4u]);}
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
fn continuumShardedPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  var pose=continuumShardedFlight(data,part,p);
  let count=u32(continuumPoses[data].y);
  // Hide internal raw-cut faces of standing blocks until an adjacent piece actually breaks away (positive wear).
  if(part>0u&&part<count&&continuumPoses[data+1u+part*4u+3u].w< -1.5){
    let rawWear=continuumPoses[data+1u+count*4u+part/4u][part%4u];
    if(rawWear<=0.0&&continuumSurfaceWear(vertex)>0.0){pose.hidden=true;}
  }
  return pose;
}
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

defineContinuumKind(CONTINUUM_KIND.SKINNED, {
  name: 'Skinned',
  wgsl: () => {
    const skin = CONTINUUM_STREAMS.find((s) => s.name === 'skin');
    const wind = CONTINUUM_STREAMS.find((s) => s.name === 'wind');
    return HUMAN_MORPH_WGSL + /* wgsl */`
// Joint j's matrix, its three rows as the columns of a mat3x4f, so that vec4f(p, 1) * m is the posed point.
fn continuumSkinnedJoint(data:u32,count:u32,j:u32)->mat3x4f {
  let at=data+1u+min(j,count-1u)*3u;
  return mat3x4f(continuumPoses[at],continuumPoses[at+1u],continuumPoses[at+2u]);
}
fn continuumSkinnedPose(record:ContinuumRecord,data:u32,part:u32,vertex:u32,p:ContinuumPosed)->ContinuumPosed {
  let count=u32(continuumPoses[data].x);
  if(count==0u){return p;}
  let joints=continuumStreamWord(${CONTINUUM_HEADER.skin}u,${skin.bit}u,${skin.words}u,vertex,0u);
  let packed=continuumStreamWord(${CONTINUUM_HEADER.skin}u,${skin.bit}u,${skin.words}u,vertex,1u);
  let weights=select(unpack4x8unorm(packed),vec4f(1.0,0.0,0.0,0.0),packed==0u);
  var m=mat3x4f(vec4f(0.0),vec4f(0.0),vec4f(0.0));
  var lead=0u;
  for(var k=0u;k<4u;k++){
    if(weights[k]>0.0){m+=continuumSkinnedJoint(data,count,(joints>>(8u*k))&255u)*weights[k];}
    if(weights[k]>weights[lead]){lead=k;}
  }
  m=m*(1.0/max(weights.x+weights.y+weights.z+weights.w,1e-6));
  var out=p;
  let morphed=humanMorphPosNrm(p.position,p.normal,record.spare.z,record.spare.w);
  let bodyPos=humanBodyUnderClothInset(morphed.pos,morphed.nrm,record.spare.z,record.spare.w);
  out.position=vec4f(bodyPos,1.0)*m;
  out.normal=normalize(vec4f(morphed.nrm,0.0)*m);
  out.hidden=continuumPoses[data+1u+count*3u+min((joints>>(8u*lead))&255u,count-1u)].w<0.0;
  let windWord=continuumStreamWord(${CONTINUUM_HEADER.wind}u,${wind.bit}u,${wind.words}u,vertex,0u);
  if(!out.hidden&&windWord!=0u){
    let flex=f32(windWord&65535u)/65535.0;
    if(flex>0.0){
      let isGarment=p.position.y<1.47;
      let phase=f32(windWord>>16u)/65535.0*6.2831853+f32(record.tag.z&1023u)*0.173;
      let wLen=length(F.windP[0].xy);
      let wDir=select(vec2f(0.8,0.6),F.windP[0].xy/max(wLen,1e-4),wLen>1e-4);
      let speed=clamp(F.windP[0].z,0.0,22.0);
      let t=F.camPos.w;
      let gust=0.68+0.32*sin(dot(record.place.xz,wDir)*0.16-t*(1.5+speed*0.20)+phase);
      let pushCap=select(0.055,0.024,isGarment);
      let push=min(pushCap,(0.004+speed*select(0.0034,0.0018,isGarment))*gust);
      let flutter=vec3f(
        sin(t*(4.1+speed*0.40)+phase*3.1)*0.0038,
        cos(t*(3.4+speed*0.32)+phase*2.3)*(0.0020+push*0.12),
        cos(t*(3.8+speed*0.38)+phase*2.7)*0.0038
      );
      let motion=continuumPoses[data].zw;
      var delta=(vec3f(wDir.x*push+motion.x,flutter.y-push*0.15,wDir.y*push+motion.y)+vec3f(flutter.x,0.0,flutter.z))*flex;
      if(isGarment){
        // Never allow wind/stride sway to push garment cloth INWARD through legs, hips, or torso skin!
        let inwardCloth=dot(delta,out.normal);
        if(inwardCloth<0.0){delta-=out.normal*inwardCloth*0.95;}
      }else{
        // Deflect only inward wind/motion delta tangentially around the posed head core so rest-pose strands never puff
        // outward into a halo, while strong wind slides around the face instead of clipping into it.
        let headSph=continuumPoses[data+1u+count*3u+min(9u,count-1u)];
        if(headSph.w>0.0){
          let restRel=out.position-headSph.xyz;
          let restR=length(restRel);
          if(restR>1e-4){
            let radDir=restRel/restR;
            let inward=dot(delta,radDir);
            if(inward<0.0&&restR<0.125){delta-=radDir*inward;}
          }
          let movedRel=restRel+delta;
          let movedR=length(movedRel);
          let minR=min(restR,0.086);
          if(movedR<minR&&movedR>1e-4){delta+=(minR-movedR)*(movedRel/movedR);}
        }
      }
      out.position+=delta;
      out.normal=normalize(out.normal+vec3f(delta.x,delta.y*0.4,delta.z)*1.8);
    }
  }
  return out;
}
// A part's sphere rides its joint, as far as the joint's matrix stretches it, grown by the pose slack; the whole is the
// sphere about the posed joints' spheres.
fn continuumSkinnedSphere(record:ContinuumRecord,data:u32,part:u32,sphere:vec4f)->vec4f {
  let count=u32(continuumPoses[data].x);
  if(count==0u){return sphere;}
  let spheres=data+1u+count*3u;
  if(part==CONTINUUM_WHOLE){
    var lo=vec3f(1e30);var hi=vec3f(-1e30);
    for(var k=0u;k<count;k++){let s=continuumPoses[spheres+k];if(s.w>=0.0){lo=min(lo,s.xyz-vec3f(s.w));hi=max(hi,s.xyz+vec3f(s.w));}}
    if(lo.x>hi.x){return vec4f(sphere.xyz,-1.0);}
    let centre=(lo+hi)*0.5;
    return vec4f(centre,length(hi-centre));
  }
  let j=min(part,count-1u);
  if(continuumPoses[spheres+j].w<0.0){return vec4f(sphere.xyz,-1.0);}
  let m=continuumSkinnedJoint(data,count,j);
  let stretch=max(max(length(vec3f(m[0].x,m[1].x,m[2].x)),length(vec3f(m[0].y,m[1].y,m[2].y))),length(vec3f(m[0].z,m[1].z,m[2].z)));
  let mGrow=select(1.0,1.24,(record.spare.z&1u)!=0u);
  return vec4f(vec4f(sphere.xyz,1.0)*m,sphere.w*stretch*mGrow+continuumPoses[data].y);
}
`;
  },
});
