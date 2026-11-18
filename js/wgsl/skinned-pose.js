// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How a family's own compute pass writes the SKINNED kind's pose data (js/wgsl/continuum-kinds.js): its joints as
// affine matrices, composed here, then each written as three rows with its posed bound. Animals (js/wgsl/herds.js,
// js/wgsl/dolphins.js) and people write their palettes through this, each into the pose buffer its scene reads.

// The joints' matrices and how they compose. `skinnedPoses` is the pass's own pose buffer, read_write.
export const SKINNED_POSE_WGSL = /* wgsl */`
// The rows of a 3x4 affine matrix: a point p goes to (dot(r0, (p, 1)), dot(r1, (p, 1)), dot(r2, (p, 1))).
struct SkinnedJoint { r0:vec4f, r1:vec4f, r2:vec4f };
fn skinnedIdentity()->SkinnedJoint { return SkinnedJoint(vec4f(1.0,0.0,0.0,0.0),vec4f(0.0,1.0,0.0,0.0),vec4f(0.0,0.0,1.0,0.0)); }
fn skinnedTranslate(t:vec3f)->SkinnedJoint { return SkinnedJoint(vec4f(1.0,0.0,0.0,t.x),vec4f(0.0,1.0,0.0,t.y),vec4f(0.0,0.0,1.0,t.z)); }
fn skinnedScale(s:vec3f)->SkinnedJoint { return SkinnedJoint(vec4f(s.x,0.0,0.0,0.0),vec4f(0.0,s.y,0.0,0.0),vec4f(0.0,0.0,s.z,0.0)); }
// Every point to one place: a joint that gathers what it carries to a point.
fn skinnedGather(at:vec3f)->SkinnedJoint { return SkinnedJoint(vec4f(0.0,0.0,0.0,at.x),vec4f(0.0,0.0,0.0,at.y),vec4f(0.0,0.0,0.0,at.z)); }
fn skinnedRotX(a:f32)->SkinnedJoint { let c=cos(a);let s=sin(a);return SkinnedJoint(vec4f(1.0,0.0,0.0,0.0),vec4f(0.0,c,-s,0.0),vec4f(0.0,s,c,0.0)); }
fn skinnedRotY(a:f32)->SkinnedJoint { let c=cos(a);let s=sin(a);return SkinnedJoint(vec4f(c,0.0,s,0.0),vec4f(0.0,1.0,0.0,0.0),vec4f(-s,0.0,c,0.0)); }
fn skinnedRotZ(a:f32)->SkinnedJoint { let c=cos(a);let s=sin(a);return SkinnedJoint(vec4f(c,-s,0.0,0.0),vec4f(s,c,0.0,0.0),vec4f(0.0,0.0,1.0,0.0)); }
// a after b.
fn skinnedThen(a:SkinnedJoint,b:SkinnedJoint)->SkinnedJoint {
  let x=vec4f(b.r0.x,b.r1.x,b.r2.x,0.0);let y=vec4f(b.r0.y,b.r1.y,b.r2.y,0.0);let z=vec4f(b.r0.z,b.r1.z,b.r2.z,0.0);let w=vec4f(b.r0.w,b.r1.w,b.r2.w,1.0);
  return SkinnedJoint(vec4f(dot(a.r0,x),dot(a.r0,y),dot(a.r0,z),dot(a.r0,w)),vec4f(dot(a.r1,x),dot(a.r1,y),dot(a.r1,z),dot(a.r1,w)),vec4f(dot(a.r2,x),dot(a.r2,y),dot(a.r2,z),dot(a.r2,w)));
}
// m about a pivot: the pivot is where m's frame has its origin.
fn skinnedAbout(pivot:vec3f,m:SkinnedJoint)->SkinnedJoint { return skinnedThen(skinnedTranslate(pivot),skinnedThen(m,skinnedTranslate(-pivot))); }
fn skinnedApply(m:SkinnedJoint,p:vec3f)->vec3f { let q=vec4f(p,1.0);return vec3f(dot(m.r0,q),dot(m.r1,q),dot(m.r2,q)); }
fn skinnedStretch(m:SkinnedJoint)->f32 { return max(max(length(vec3f(m.r0.x,m.r1.x,m.r2.x)),length(vec3f(m.r0.y,m.r1.y,m.r2.y))),length(vec3f(m.r0.z,m.r1.z,m.r2.z))); }
// The head of an instance's pose data at 'at' (vec4f): its joint count and its pose slack.
fn skinnedWriteHead(at:u32,count:u32,slack:f32) { skinnedPoses[at]=vec4f(f32(count),slack,0.0,0.0); }
// Joint j of 'count', and its bound: 'rest' the sphere about every point it carries at rest (a radius below 0: it
// carries none), posed by it and grown by the slack; hidden, it hides what it carries most.
fn skinnedWriteJoint(at:u32,count:u32,j:u32,m:SkinnedJoint,rest:vec4f,slack:f32,hidden:bool) {
  let row=at+1u+j*3u;
  skinnedPoses[row]=m.r0;skinnedPoses[row+1u]=m.r1;skinnedPoses[row+2u]=m.r2;
  skinnedPoses[at+1u+count*3u+j]=select(vec4f(skinnedApply(m,rest.xyz),rest.w*skinnedStretch(m)+slack),vec4f(rest.xyz,-1.0),hidden||rest.w<0.0);
}
// A unit quaternion turning by yaw about y after pitch about x after roll about z: Ry Rx Rz.
fn skinnedTurn(yaw:f32,pitch:f32,roll:f32)->vec4f {
  let y=vec4f(0.0,sin(yaw*0.5),0.0,cos(yaw*0.5));let x=vec4f(sin(pitch*0.5),0.0,0.0,cos(pitch*0.5));let z=vec4f(0.0,0.0,sin(roll*0.5),cos(roll*0.5));
  return skinnedQuat(skinnedQuat(y,x),z);
}
fn skinnedQuat(a:vec4f,b:vec4f)->vec4f { return vec4f(a.w*b.xyz+b.w*a.xyz+cross(a.xyz,b.xyz),a.w*b.w-dot(a.xyz,b.xyz)); }
`;

// How many vec4f an instance of `joints` joints takes in its pose buffer.
export const skinnedPoseVec4s = (joints) => 1 + joints * 4;
