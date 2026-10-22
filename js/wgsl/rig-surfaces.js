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
struct SurfaceGpuScalarPair {value:f32,change:f32};
struct SurfaceGpuVectorPair {value:vec3f,change:vec3f};
// Compensated products/reductions keep the support's small transverse
// component when its design coordinates or nearly parallel axes are large.
fn surfaceGpuDot(a:vec3f,b:vec3f)->f32 {
  let products=a*b;let productError=fma(a,b,-products);
  let xy=products.x+products.y;let yPart=xy-products.x;let xyError=(products.x-(xy-yPart))+(products.y-yPart);
  let xyz=xy+products.z;let zPart=xyz-xy;let xyzError=(xy-(xyz-zPart))+(products.z-zPart);
  return xyz+(((xyError+xyzError)+productError.x+productError.y)+productError.z);
}
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
// A paired value is its centre plus an explicitly small stencil change.
// Factoring the changes keeps a furled sheet's derivative through contact
// pushes, without widening the stencil or changing collision branches.
fn surfaceGpuClampChange(value:f32,change:f32)->f32 {
  if(value<=0.0){return clamp(value+change,0.0,1.0);}
  if(value>=1.0){return clamp(value-1.0+change,-1.0,0.0);}
  return clamp(change,-value,1.0-value);
}
fn surfaceGpuPositivePair(pair:SurfaceGpuScalarPair)->SurfaceGpuScalarPair {
  let next=pair.value+pair.change;
  if(pair.value>0.0&&next>0.0){return pair;}
  if(pair.value<=0.0&&next<=0.0){return SurfaceGpuScalarPair(0,0);}
  let value=max(0.0,pair.value);return SurfaceGpuScalarPair(value,max(0.0,next)-value);
}
fn surfaceGpuPairMultiply(a:SurfaceGpuScalarPair,b:SurfaceGpuScalarPair)->SurfaceGpuScalarPair {
  return SurfaceGpuScalarPair(a.value*b.value,a.value*b.change+a.change*b.value+a.change*b.change);
}
fn surfaceGpuSmoothPair(pair:SurfaceGpuScalarPair)->SurfaceGpuScalarPair {
  let x=clamp(pair.value,0.0,1.0);let d=surfaceGpuClampChange(pair.value,pair.change);
  return SurfaceGpuScalarPair(x*x*(3.0-2.0*x),d*(6.0*x*(1.0-x)+d*(3.0-6.0*x-2.0*d)));
}
fn surfaceGpuSinPair(pair:SurfaceGpuScalarPair)->SurfaceGpuScalarPair {
  return SurfaceGpuScalarPair(sin(pair.value),2.0*cos(pair.value+pair.change*.5)*sin(pair.change*.5));
}
fn surfaceGpuLengthChange(value:vec3f,change:vec3f)->f32 {
  let denominator=length(value)+length(value+change);
  if(denominator>1e-20){return (2.0*surfaceGpuDot(value,change)+surfaceGpuDot(change,change))/denominator;}return 0.0;
}
fn surfaceGpuUnitPair(pair:SurfaceGpuVectorPair)->SurfaceGpuVectorPair {
  let size=length(pair.value);let nextSize=length(pair.value+pair.change);
  if(size<=1e-12||nextSize<=1e-12){let value=surfaceGpuUnit(pair.value);return SurfaceGpuVectorPair(value,surfaceGpuUnit(pair.value+pair.change)-value);}
  let value=pair.value/size;
  return SurfaceGpuVectorPair(value,(pair.change-value*surfaceGpuLengthChange(pair.value,pair.change))/nextSize);
}
fn surfaceGpuDotPair(a:SurfaceGpuVectorPair,b:SurfaceGpuVectorPair)->SurfaceGpuScalarPair {
  return SurfaceGpuScalarPair(surfaceGpuDot(a.value,b.value),surfaceGpuDot(a.value,b.change)+surfaceGpuDot(a.change,b.value)+surfaceGpuDot(a.change,b.change));
}
fn surfaceGpuSewnPair(surface:SurfaceGpuSurface,anchor:vec2f,change:vec2f)->SurfaceGpuScalarPair {
  let mask=u32(surface.hinge.w);let band=surface.camber.w;var weight=SurfaceGpuScalarPair(1,0);
  if((mask&1u)!=0u){weight=surfaceGpuPairMultiply(weight,surfaceGpuSmoothPair(SurfaceGpuScalarPair(anchor.x/band,change.x/band)));}
  if((mask&2u)!=0u){weight=surfaceGpuPairMultiply(weight,surfaceGpuSmoothPair(SurfaceGpuScalarPair((1.0-anchor.x)/band,-change.x/band)));}
  if((mask&4u)!=0u){weight=surfaceGpuPairMultiply(weight,surfaceGpuSmoothPair(SurfaceGpuScalarPair(anchor.y/band,change.y/band)));}
  if((mask&8u)!=0u){weight=surfaceGpuPairMultiply(weight,surfaceGpuSmoothPair(SurfaceGpuScalarPair((1.0-anchor.y)/band,-change.y/band)));}
  if((mask&16u)!=0u){weight=surfaceGpuPairMultiply(weight,surfaceGpuSmoothPair(SurfaceGpuScalarPair((1.0-anchor.x-anchor.y)/band,(-change.x-change.y)/band)));}
  return weight;
}
fn surfaceGpuContactSide(value:f32,mastBarrier:bool,surface:SurfaceGpuSurface,pose:SurfaceGpuPose)->f32 {
  if(mastBarrier){return 1.0;}if(abs(value)>1e-8){return sign(value);}
  var side=-sign(pose.pressure);if(surface.info.x==1.0){side=sign(pose.side);}if(side==0.0){side=-1.0;}return side;
}
fn surfaceGpuSupportsPair(initial:SurfaceGpuVectorPair,reference:SurfaceGpuVectorPair,normal:vec3f,index:u32,surface:SurfaceGpuSurface,pose:SurfaceGpuPose,anchor:vec2f,uvChange:vec2f,origin:vec3f)->SurfaceGpuVectorPair {
  let pin=surfaceGpuSewnPair(surface,anchor,uvChange);if(pin.value==0.0&&pin.change==0.0){return initial;}
  let clearance=surface.transfer.w;let band=surface.contact.x;var p=initial;
  let start=u32(surfaceGpuModel[0].z);let count=u32(surfaceGpuModel[0].w);
  for(var i=0u;i<count;i++){
    let at=start+i*4u;let A=surfaceGpuModel[at];let B=surfaceGpuModel[at+1u];let info=surfaceGpuModel[at+2u];let flags=u32(info.w);
    if((flags&2u)!=0u&&info.y==f32(index)){continue;}
    var a=A.xyz;var axis=B.xyz-A.xyz;
    if(info.z>=0.0){
      let owner=u32(info.z);let descriptor=surfaceGpuDescriptor(owner);let ownerPose=surfaceGpuPose(owner);
      a=surfaceGpuYard(descriptor,a,ownerPose);
      if(descriptor.info.x==1.0){let angle=-atan2(descriptor.a.z-descriptor.b.z,descriptor.a.y-descriptor.b.y)*ownerPose.dip;axis=surfaceGpuRotate(axis,vec3f(1,0,0),angle);}
      else{axis=surfaceGpuRotateVector(descriptor,axis,ownerPose);}
    }
    let length2=surfaceGpuDot(axis,axis);if(length2<1e-12){continue;}a-=origin;
    let projection=surfaceGpuDot(p.value-a,axis)/length2;let coordinate=clamp(projection,0.0,1.0);
    let coordinateChange=surfaceGpuClampChange(projection,surfaceGpuDot(p.change,axis)/length2);
    let q=SurfaceGpuVectorPair(a+axis*coordinate,axis*coordinateChange);
    let delta=SurfaceGpuVectorPair(p.value-q.value,p.change-q.change);
    let radius=SurfaceGpuScalarPair(A.w+(B.w-A.w)*coordinate+clearance,(B.w-A.w)*coordinateChange);
    let mastBarrier=(flags&1u)!=0u&&info.x==surface.info.w&&surface.contact.y!=0.0;
    var direction=normal;if(mastBarrier){direction=vec3f(0,0,surface.contact.y);}
    var contactNormal=SurfaceGpuVectorPair(cross(axis,cross(direction,axis))/length2,vec3f(0));
    let restReference=SurfaceGpuVectorPair(reference.value-q.value,reference.change-q.change);
    if(length(contactNormal.value)<1e-10){
      contactNormal=SurfaceGpuVectorPair(restReference.value-axis*surfaceGpuDot(restReference.value,axis)/length2,restReference.change-axis*surfaceGpuDot(restReference.change,axis)/length2);
      var fallback=vec3f(1,0,0);if(abs(axis.y)/sqrt(length2)<.9){fallback=vec3f(0,1,0);}fallback=cross(axis,fallback);
      if(length(contactNormal.value)<1e-10){
        let query=contactNormal.value+contactNormal.change;contactNormal.value=fallback;
        if(length(query)<1e-10){contactNormal.change=vec3f(0);}else{contactNormal.change=query-fallback;}
      }else if(length(contactNormal.value+contactNormal.change)<1e-10){contactNormal.change=fallback-contactNormal.value;}
    }
    contactNormal=surfaceGpuUnitPair(contactNormal);
    let signed=surfaceGpuDotPair(delta,contactNormal);
    let transverse=SurfaceGpuVectorPair(delta.value-contactNormal.value*signed.value,delta.change-contactNormal.value*signed.change-contactNormal.change*signed.value-contactNormal.change*signed.change);
    let distance=SurfaceGpuScalarPair(length(transverse.value),surfaceGpuLengthChange(transverse.value,transverse.change));
    let restSide=surfaceGpuDotPair(restReference,contactNormal);
    let side=surfaceGpuContactSide(restSide.value,mastBarrier,surface,pose);let nextSide=surfaceGpuContactSide(restSide.value+restSide.change,mastBarrier,surface,pose);
    let penetration=surfaceGpuPositivePair(SurfaceGpuScalarPair(radius.value-side*signed.value,radius.change-nextSide*signed.change+(side-nextSide)*signed.value));
    if(penetration.value==0.0&&penetration.change==0.0){continue;}
    let tension=surfaceGpuSmoothPair(SurfaceGpuScalarPair((distance.value-radius.value)/band,(distance.change-radius.change)/band));
    let weight=surfaceGpuPairMultiply(SurfaceGpuScalarPair(1.0-tension.value,-tension.change),pin);
    let correction=surfaceGpuPairMultiply(surfaceGpuPairMultiply(penetration,weight),SurfaceGpuScalarPair(side,nextSide-side));
    p.value+=contactNormal.value*correction.value;
    p.change+=contactNormal.value*correction.change+contactNormal.change*correction.value+contactNormal.change*correction.change;
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
  let uvChange=uv-anchor;
  let U=SurfaceGpuScalarPair(anchor.x,uvChange.x);let V=SurfaceGpuScalarPair(anchor.y,uvChange.y);
  var envelope=surfaceGpuPairMultiply(surfaceGpuPairMultiply(U,V),surfaceGpuPositivePair(SurfaceGpuScalarPair(1.0-anchor.x-anchor.y,-uvChange.x-uvChange.y)));
  envelope.value*=27.0;envelope.change*=27.0;
  if(!triangle){
    var wave=surfaceGpuSinPair(SurfaceGpuScalarPair(3.141592653589793*anchor.y,3.141592653589793*uvChange.y));
    if(anchor.y<=0.0||anchor.y>=1.0){let next=wave.value+wave.change;wave.value=0.0;wave.change=next;}
    if(uv.y<=0.0||uv.y>=1.0){wave.change=-wave.value;}
    envelope=surfaceGpuPairMultiply(surfaceGpuPairMultiply(U,SurfaceGpuScalarPair(1.0-anchor.x,-uvChange.x)),wave);envelope.value*=4.0;envelope.change*=4.0;
  }
  let slack=1.0-smoothstep(.2,.85,fill);let flutterScale=min(max(surfaceGpuLive[0].y,0.0)/4.0,1.0)*surface.c.w*slack*slack;
  var flutter=surfaceGpuSinPair(SurfaceGpuScalarPair(surfaceGpuLive[0].x*6.0+anchor.x*17.0+anchor.y*13.0,uvChange.x*17.0+uvChange.y*13.0));
  flutter.value*=flutterScale;flutter.change*=flutterScale;
  var side=1.0;if(surface.info.x==1.0){side=pose.side;}
  var camber=surfaceGpuPairMultiply(SurfaceGpuScalarPair(surface.b.w*pose.pressure*side*(.12+.88*fill)+flutter.value,flutter.change),envelope);camber.value*=deployed;camber.change*=deployed;
  let axis=surfaceGpuUnit(surface.camber.xyz);let origin=surfaceGpuClothMotion(surface,flat,pose);
  let reference=SurfaceGpuVectorPair(vec3f(0),surfaceGpuClothRotate(surface,flatDifference,pose));
  var point=SurfaceGpuVectorPair(surfaceGpuClothRotate(surface,axis*camber.value,pose),surfaceGpuClothRotate(surface,flatDifference+axis*camber.change,pose));
  if(surfaceGpuModel[0].w!=0.0){point=surfaceGpuSupportsPair(point,reference,surfaceGpuUnit(surfaceGpuClothRotate(surface,axis,pose)),index,surface,pose,anchor,uvChange,origin);}
  return SurfaceGpuRelative(origin+point.value,point.change);
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
