// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Descriptor-driven rigs share the canonical GPU pose output. These helpers
// mirror rig-surface.js; immutable model/vertex data is uploaded only once.
export const GPU_RIG_SURFACES=/* wgsl */ `
struct Hull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f,
  sailSet:vec4f, sailTrim:vec4f, sailWind:vec4f, lateen:array<vec4f,3>, lateenPressure:vec4f };
@group(0)@binding(0)var<uniform>hull:Hull;
@group(0)@binding(1)var<storage,read>vesselPoseSource:array<f32>;
struct VesselPoseVertex {position:vec4f,normal:vec4f};
@group(0)@binding(2)var<storage,read_write>vesselPoseOutput:array<VesselPoseVertex>;
@group(0)@binding(3)var<storage,read>surfaceGpuModel:array<vec4f>;
@group(0)@binding(4)var<storage,read>surfaceGpuVertices:array<vec4f>;
@group(0)@binding(5)var<storage,read>surfaceGpuLive:array<vec4f>;
struct SurfaceGpuSurface {
  info:vec4f,pivot:vec4f,a:vec4f,b:vec4f,c:vec4f,d:vec4f,
  camber:vec4f,hinge:vec4f,transfer:vec4f,contact:vec4f
};
struct SurfaceGpuPose {yaw:f32,deployed:f32,fill:f32,side:f32,opening:f32,dip:f32,pressure:f32};
struct SurfaceGpuFrame {across:vec3f,up:vec3f};
struct SurfaceGpuRelative {origin:vec3f,offset:vec3f};
fn surfaceGpuUnit(p:vec3f)->vec3f {
  let n=length(p);if(n>1e-12){return p/n;}return vec3f(0,1,0);
}
fn surfaceGpuRotate(p:vec3f,axis:vec3f,angle:f32)->vec3f {
  let a=surfaceGpuUnit(axis);let c=cos(angle);let s=sin(angle);
  return p*c+cross(a,p)*s+a*dot(a,p)*(1.0-c);
}
fn surfaceGpuDescriptor(index:u32)->SurfaceGpuSurface {
  let at=u32(surfaceGpuModel[0].x)+index*10u;
  return SurfaceGpuSurface(surfaceGpuModel[at],surfaceGpuModel[at+1u],surfaceGpuModel[at+2u],surfaceGpuModel[at+3u],surfaceGpuModel[at+4u],
    surfaceGpuModel[at+5u],surfaceGpuModel[at+6u],surfaceGpuModel[at+7u],surfaceGpuModel[at+8u],surfaceGpuModel[at+9u]);
}
fn surfaceGpuPose(index:u32)->SurfaceGpuPose {
  let at=3u+index*2u;let a=surfaceGpuLive[at];let b=surfaceGpuLive[at+1u];
  return SurfaceGpuPose(a.x,a.y,a.z,a.w,b.x,b.y,b.z);
}
fn surfaceGpuRest(surface:SurfaceGpuSurface,uv:vec2f)->vec3f {
  if(surface.info.y<3.5){return surface.a.xyz+(surface.b.xyz-surface.a.xyz)*uv.x+(surface.c.xyz-surface.a.xyz)*uv.y;}
  var p=mix(mix(surface.a.xyz,surface.b.xyz,uv.x),mix(surface.d.xyz,surface.c.xyz,uv.x),uv.y);
  p.y+=surface.a.w*4.0*uv.x*(1.0-uv.x)*uv.y;return p;
}
fn surfaceGpuRotateVector(surface:SurfaceGpuSurface,p:vec3f,pose:SurfaceGpuPose)->vec3f {
  if(surface.info.x==2.0||surface.info.x==4.0){return surfaceGpuRotate(p,surface.b.xyz-surface.a.xyz,pose.yaw);}
  if(surface.info.x==3.0&&dot(surface.hinge.xyz,surface.hinge.xyz)>0.0){return surfaceGpuRotate(p,surface.hinge.xyz,pose.yaw);}
  return surfaceGpuRotate(p,vec3f(0,1,0),pose.yaw);
}
fn surfaceGpuYard(surface:SurfaceGpuSurface,p:vec3f,pose:SurfaceGpuPose)->vec3f {
  if(surface.info.x==1.0){
    let angle=-atan2(surface.a.z-surface.b.z,surface.a.y-surface.b.y)*pose.dip;
    var q=surfaceGpuRotate(p-surface.pivot.xyz,vec3f(1,0,0),angle);
    let radius=surface.transfer.x+pose.dip*surface.transfer.y;
    q.x+=pose.side*radius;q.z+=sqrt(max(0.0,1.0-pose.side*pose.side))*radius;q.y+=pose.dip*surface.transfer.z;
    return surface.pivot.xyz+q;
  }
  var pivot=surface.pivot.xyz;if(surface.info.x==2.0||surface.info.x==4.0){pivot=surface.a.xyz;}
  return pivot+surfaceGpuRotateVector(surface,p-pivot,pose);
}
fn surfaceGpuClothMotion(surface:SurfaceGpuSurface,point:vec3f,pose:SurfaceGpuPose)->vec3f {
  var p=point;
  if(surface.info.x==1.0){p=surface.a.xyz+surfaceGpuRotate(p-surface.a.xyz,surface.b.xyz-surface.a.xyz,-pose.side*pose.opening);}
  return surfaceGpuYard(surface,p,pose);
}
fn surfaceGpuSewnWeight(surface:SurfaceGpuSurface,uv:vec2f)->f32 {
  let mask=u32(surface.hinge.w);let band=surface.camber.w;var weight=1.0;
  if((mask&1u)!=0u){weight*=smoothstep(0.0,band,uv.x);}
  if((mask&2u)!=0u){weight*=smoothstep(0.0,band,1.0-uv.x);}
  if((mask&4u)!=0u){weight*=smoothstep(0.0,band,uv.y);}
  if((mask&8u)!=0u){weight*=smoothstep(0.0,band,1.0-uv.y);}
  if((mask&16u)!=0u){weight*=smoothstep(0.0,band,1.0-uv.x-uv.y);}
  return weight;
}
fn surfaceGpuSupports(point:vec3f,reference:vec3f,normal:vec3f,index:u32,surface:SurfaceGpuSurface,pose:SurfaceGpuPose,uv:vec2f,origin:vec3f)->vec3f {
  let pin=surfaceGpuSewnWeight(surface,uv);if(pin==0.0){return point;}
  let clearance=surface.transfer.w;let band=surface.contact.x;var p=point;
  let start=u32(surfaceGpuModel[0].z);let count=u32(surfaceGpuModel[0].w);
  for(var i=0u;i<count;i++){
    let at=start+i*4u;let A=surfaceGpuModel[at];let B=surfaceGpuModel[at+1u];let info=surfaceGpuModel[at+2u];let flags=u32(info.w);
    if((flags&2u)!=0u&&info.y==f32(index)){continue;}
    var a=A.xyz;var b=B.xyz;
    if(info.z>=0.0){let owner=u32(info.z);let descriptor=surfaceGpuDescriptor(owner);let ownerPose=surfaceGpuPose(owner);a=surfaceGpuYard(descriptor,a,ownerPose);b=surfaceGpuYard(descriptor,b,ownerPose);}
    a-=origin;b-=origin;
    let axis=b-a;let length2=dot(axis,axis);if(length2<1e-12){continue;}
    let t=clamp(dot(p-a,axis)/length2,0.0,1.0);let q=mix(a,b,t);let delta=p-q;let radius=mix(A.w,B.w,t)+clearance;
    let mastBarrier=(flags&1u)!=0u&&info.x==surface.info.w&&surface.contact.y!=0.0;
    var direction=normal;if(mastBarrier){direction=vec3f(0,0,surface.contact.y);}
    var contactNormal=direction-axis*dot(direction,axis)/length2;
    if(length(contactNormal)<1e-10){
      let restReference=reference-q;contactNormal=restReference-axis*dot(restReference,axis)/length2;
      if(length(contactNormal)<1e-10){var fallback=vec3f(1,0,0);if(abs(axis.y)/sqrt(length2)<.9){fallback=vec3f(0,1,0);}contactNormal=cross(axis,fallback);}
    }
    contactNormal=surfaceGpuUnit(contactNormal);
    let signed=dot(delta,contactNormal);let transverse=delta-contactNormal*signed;let distance=length(transverse);
    if(distance>=radius+band){continue;}
    let restSide=dot(reference-q,contactNormal);var side=1.0;
    if(!mastBarrier){
      if(abs(restSide)>1e-8){side=sign(restSide);}
      else if(surface.info.x==1.0){side=sign(pose.side);if(side==0.0){side=-1.0;}}
      else{side=-sign(pose.pressure);if(side==0.0){side=-1.0;}}
    }
    let penetration=radius-side*signed;
    if(penetration>0.0){p+=contactNormal*side*penetration*(1.0-smoothstep(radius,radius+band,distance))*pin;}
  }
  return p;
}
// Finite differences must share an origin. Subtracting two absolute design
// positions loses the thin furled sheet's tangent in f32. These factored rest
// differences preserve the original .0005 stencil without changing contacts.
fn surfaceGpuRestDifference(surface:SurfaceGpuSurface,uv:vec2f,anchor:vec2f)->vec3f {
  let delta=uv-anchor;let ba=surface.b.xyz-surface.a.xyz;let ca=surface.c.xyz-surface.a.xyz;
  if(surface.info.y<3.5){return ba*delta.x+ca*delta.y;}
  let da=surface.d.xyz-surface.a.xyz;let twist=surface.a.xyz-surface.b.xyz+surface.c.xyz-surface.d.xyz;
  var p=ba*delta.x+da*delta.y+twist*(delta.x*anchor.y+delta.y*uv.x);
  p.y+=surface.a.w*4.0*(delta.x*(1.0-uv.x-anchor.x)*anchor.y+uv.x*(1.0-uv.x)*delta.y);return p;
}
fn surfaceGpuClothRotate(surface:SurfaceGpuSurface,point:vec3f,pose:SurfaceGpuPose)->vec3f {
  if(surface.info.x!=1.0){return surfaceGpuRotateVector(surface,point,pose);}
  let opened=surfaceGpuRotate(point,surface.b.xyz-surface.a.xyz,-pose.side*pose.opening);
  let angle=-atan2(surface.a.z-surface.b.z,surface.a.y-surface.b.y)*pose.dip;
  return surfaceGpuRotate(opened,vec3f(1,0,0),angle);
}
fn surfaceGpuClothNear(index:u32,uv:vec2f,anchor:vec2f)->SurfaceGpuRelative {
  let surface=surfaceGpuDescriptor(index);let pose=surfaceGpuPose(index);let rest=surfaceGpuRest(surface,anchor);let triangle=surface.info.y<3.5;
  let restDifference=surfaceGpuRestDifference(surface,uv,anchor);var gathered:vec3f;var gatheredDifference:vec3f;
  if(surface.info.x==4.0){gathered=mix(surface.a.xyz,surface.c.xyz,anchor.y);gatheredDifference=(surface.c.xyz-surface.a.xyz)*(uv.y-anchor.y);}
  else if(triangle){let axis=surface.b.xyz-surface.a.xyz;let length2=dot(axis,axis);gathered=mix(surface.a.xyz,surface.b.xyz,dot(rest-surface.a.xyz,axis)/length2);gatheredDifference=axis*(dot(restDifference,axis)/length2);}
  else{gathered=surfaceGpuRest(surface,vec2f(anchor.x,0));gatheredDifference=(surface.b.xyz-surface.a.xyz)*(uv.x-anchor.x);}
  let deployed=clamp(pose.deployed,0.0,1.0);let fill=clamp(pose.fill,0.0,1.0);let factor=.012+.988*deployed;
  let flat=mix(gathered,rest,factor);let flatDifference=mix(gatheredDifference,restDifference,factor);
  var envelope=27.0*uv.x*uv.y*max(0.0,1.0-uv.x-uv.y);
  if(!triangle){var wave=0.0;if(uv.y>0.0&&uv.y<1.0){wave=sin(3.141592653589793*uv.y);}envelope=4.0*uv.x*(1.0-uv.x)*wave;}
  let slack=1.0-smoothstep(.2,.85,fill);
  let flutter=min(max(surfaceGpuLive[0].y,0.0)/4.0,1.0)*surface.c.w*slack*slack*sin(surfaceGpuLive[0].x*6.0+uv.x*17.0+uv.y*13.0);
  var side=1.0;if(surface.info.x==1.0){side=pose.side;}
  let camber=(surface.b.w*pose.pressure*side*(.12+.88*fill)+flutter)*envelope*deployed;
  let axis=surfaceGpuUnit(surface.camber.xyz);let origin=surfaceGpuClothMotion(surface,flat,pose);
  let reference=surfaceGpuClothRotate(surface,flatDifference,pose);var point=surfaceGpuClothRotate(surface,flatDifference+axis*camber,pose);
  if(surfaceGpuModel[0].w!=0.0){point=surfaceGpuSupports(point,reference,surfaceGpuUnit(surfaceGpuClothRotate(surface,axis,pose)),index,surface,pose,uv,origin);}
  return SurfaceGpuRelative(origin,point);
}
fn surfaceGpuCloth(index:u32,uv:vec2f)->vec3f {
  let point=surfaceGpuClothNear(index,uv,uv);return point.origin+point.offset;
}
fn surfaceGpuAttachment(position:vec4f,binding:vec4f)->vec3f {
  if(position.w<0.0||binding.x==0.0){return position.xyz;}
  let index=u32(position.w);
  if(binding.x==1.0){return surfaceGpuCloth(index,binding.yz);}
  return surfaceGpuYard(surfaceGpuDescriptor(index),position.xyz,surfaceGpuPose(index));
}
fn surfaceGpuSineDifference(a:f32,b:f32)->f32 {
  return 2.0*cos(3.141592653589793*(a+b)*.5)*sin(3.141592653589793*(a-b)*.5);
}
fn surfaceGpuRopeNear(index:u32,coordinate:f32,anchorCoordinate:f32)->SurfaceGpuRelative {
  let at=u32(surfaceGpuModel[1].x)+index*10u;let edge=surfaceGpuModel[at+8u];let edgeEnd=surfaceGpuModel[at+9u];let t=clamp(coordinate,0.0,1.0);let anchor=clamp(anchorCoordinate,0.0,1.0);
  if(edgeEnd.y!=0.0){let end=vec2f(edge.w,edgeEnd.x);return surfaceGpuClothNear(u32(edge.x),mix(edge.yz,end,t),mix(edge.yz,end,anchor));}
  let a=surfaceGpuAttachment(surfaceGpuModel[at],surfaceGpuModel[at+1u]);let b=surfaceGpuAttachment(surfaceGpuModel[at+2u],surfaceGpuModel[at+3u]);
  let info=surfaceGpuModel[at+6u];let leads=surfaceGpuModel[at+7u];var lazy=0.0;
  if(info.w!=0.0){
    var workingSide=leads.x;
    if(leads.y==0.0){var owner=surfaceGpuModel[at].w;if(owner<0.0){owner=surfaceGpuModel[at+2u].w;}if(owner<0.0){owner=edge.x;}workingSide=surfaceGpuPose(u32(owner)).side;}
    lazy=1.0-smoothstep(-.25,.25,info.z*workingSide);
  }
  var workingOrigin=mix(a,b,anchor);workingOrigin.y-=sin(3.141592653589793*anchor)*info.x;
  var workingDifference=(b-a)*(t-anchor);workingDifference.y-=surfaceGpuSineDifference(t,anchor)*info.x;
  if(lazy==0.0){return SurfaceGpuRelative(workingOrigin,workingDifference);}
  var looseOrigin:vec3f;var looseDifference:vec3f;
  if(leads.w!=0.0){
    let lead=surfaceGpuAttachment(surfaceGpuModel[at+4u],surfaceGpuModel[at+5u]);let split=leads.z;var q=(t-split)/(1.0-split);var anchorQ=(anchor-split)/(1.0-split);
    if(t<split){q=t/split;}if(anchor<split){anchorQ=anchor/split;looseOrigin=mix(a,lead,anchorQ);}else{looseOrigin=mix(lead,b,anchorQ);}
    if(t<split&&anchor<split){looseDifference=(lead-a)*(q-anchorQ);}
    else if(t>=split&&anchor>=split){looseDifference=(b-lead)*(q-anchorQ);}
    else if(t<split){looseDifference=(lead-a)*(q-1.0)-(b-lead)*anchorQ;}
    else{looseDifference=(b-lead)*q+(lead-a)*(1.0-anchorQ);}
    looseOrigin.y-=sin(3.141592653589793*anchorQ)*info.y;looseDifference.y-=surfaceGpuSineDifference(q,anchorQ)*info.y;
  }else{
    looseOrigin=mix(a,b,anchor);looseOrigin.y-=sin(3.141592653589793*anchor)*(info.x+info.y);
    looseDifference=(b-a)*(t-anchor);looseDifference.y-=surfaceGpuSineDifference(t,anchor)*(info.x+info.y);
  }
  return SurfaceGpuRelative(mix(workingOrigin,looseOrigin,lazy),mix(workingDifference,looseDifference,lazy));
}
fn surfaceGpuRope(index:u32,coordinate:f32)->vec3f {
  let point=surfaceGpuRopeNear(index,coordinate,coordinate);return point.origin+point.offset;
}
fn surfaceGpuRopeFrame(axis:vec3f,preferred:vec3f)->SurfaceGpuFrame {
  let direction=surfaceGpuUnit(axis);let projected=cross(direction,cross(preferred,direction));var across:vec3f;
  if(length(projected)>1e-12){across=surfaceGpuUnit(projected);}
  else if(surfaceGpuModel[2].z!=0.0){across=vec3f(0,1,0);}
  else{across=surfaceGpuUnit(cross(direction,vec3f(0,0,1)));}
  return SurfaceGpuFrame(across,cross(direction,across));
}
fn surfaceGpuVertex(vertex:u32,position:vec3f,normal:vec3f)->VesselPoseVertex {
  let vertexMetadata=surfaceGpuVertices[vertex*3u];let data=surfaceGpuVertices[vertex*3u+1u];let auxiliary=surfaceGpuVertices[vertex*3u+2u];
  let kind=u32(vertexMetadata.x);let index=u32(vertexMetadata.y);var p=position;var n=normal;
  if(kind==1u){
    let uv=vertexMetadata.zw;let e=.0005;p=surfaceGpuCloth(index,uv);
    let du=surfaceGpuClothNear(index,uv+vec2f(e,0),uv).offset-surfaceGpuClothNear(index,uv-vec2f(e,0),uv).offset;
    let dv=surfaceGpuClothNear(index,uv+vec2f(0,e),uv).offset-surfaceGpuClothNear(index,uv-vec2f(0,e),uv).offset;n=surfaceGpuUnit(cross(du,dv));
  }else if(kind==2u){
    let surface=surfaceGpuDescriptor(index);let pose=surfaceGpuPose(index);let origin=surfaceGpuYard(surface,vec3f(0),pose);
    let axes=mat3x3f(surfaceGpuYard(surface,vec3f(1,0,0),pose)-origin,surfaceGpuYard(surface,vec3f(0,1,0),pose)-origin,surfaceGpuYard(surface,vec3f(0,0,1),pose)-origin);
    p=origin+axes*position;n=surfaceGpuUnit(axes*normal);
  }else if(kind==3u){
    let t=vertexMetadata.z;let frame=surfaceGpuRopeFrame(surfaceGpuRopeNear(index,min(1.0,t+.001),t).offset-surfaceGpuRopeNear(index,max(0.0,t-.001),t).offset,auxiliary.xyz);
    p=surfaceGpuRope(index,t)+frame.across*data.x+frame.up*data.y;n=surfaceGpuUnit(frame.across*data.z+frame.up*data.w);
  }else if(kind==4u){
    let at=3u+u32(surfaceGpuLive[2].x)*2u+index*4u;let axes=mat3x3f(surfaceGpuLive[at+1u].xyz,surfaceGpuLive[at+2u].xyz,surfaceGpuLive[at+3u].xyz);
    let scale=surfaceGpuLive[1].xyz;p=(surfaceGpuLive[at].xyz+axes*data.xyz)/scale;n=surfaceGpuUnit((axes*auxiliary.xyz)*scale);
  }else if(kind==5u||kind==6u){
    let at=u32(surfaceGpuModel[1].z);var pivot=surfaceGpuModel[at].xyz;var axis=vec3f(0,1,0);var angle=surfaceGpuLive[0].z;
    if(kind==6u){pivot=surfaceGpuModel[at+1u].xyz;axis=surfaceGpuModel[at+2u].xyz;angle*=surfaceGpuModel[at+1u].w;}
    p=pivot+surfaceGpuRotate(position-pivot,axis,angle);n=surfaceGpuUnit(surfaceGpuRotate(normal,axis,angle));
  }else if(kind==7u){
    let pivot=surfaceGpuModel[u32(surfaceGpuModel[1].w)].xyz;let q=position-pivot;let c=cos(surfaceGpuLive[0].w);let s=sin(surfaceGpuLive[0].w);
    p=vec3f(position.x,pivot.y+c*q.y+s*q.z,pivot.z-s*q.y+c*q.z);n=vec3f(normal.x,c*normal.y+s*normal.z,-s*normal.y+c*normal.z);
  }
  return VesselPoseVertex(vec4f(p,0),vec4f(n,0));
}
`;
