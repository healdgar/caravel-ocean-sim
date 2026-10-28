// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared GPU vertex/compute deformation and surface state for part-by-part
// procedural assembly, exploded views, structural cutaways and per-part wear.

export const PART_ASSEMBLY_WGSL = /* wgsl */ `
struct PartAssemblyUniform {
  control:vec4f,
  params:vec4f,
  impacts:array<vec4f,24>,
};
struct PartEvaluatedVertex {
  position:vec3f,
  normal:vec3f,
  appear:f32,
  wearAndDamage:f32,
  cutawayAlpha:f32,
  visible:f32,
};
fn evaluatePartAssemblyVertex(
  position:vec3f,
  normal:vec3f,
  attr0:vec4f,
  attr1:vec4f,
  desc0:vec4f,
  desc1:vec4f,
  state:vec4f,
  u:PartAssemblyUniform
)->PartEvaluatedVertex {
  let explodedOffset=attr0.yzw;
  let pivot=attr1.xyz;
  let appearStart=desc0.x;
  let appearEnd=max(appearStart+0.001,desc0.y);
  let layer=desc0.z;
  let cutawaySide=desc1.w;
  let windowAppear=smoothstep(appearStart,appearEnd,clamp(u.control.x,0.0,1.0));
  let appear=clamp(min(windowAppear,state.x),0.0,1.0);
  let explode=max(0.0,u.control.y+state.y);
  let wearAndDamage=clamp(u.params.z+state.z,0.0,1.0);
  var cutawayVis=clamp(state.w,0.0,1.0);
  let mode=u.control.w;
  let threshold=clamp(u.control.z,0.0,1.0);
  if(mode>0.5 && threshold>0.001){
    let minKeepLayer=5.0-threshold*4.5;
    if(mode<1.5){
      if(layer>minKeepLayer && layer>=0.5){cutawayVis=0.0;}
    }else if(mode<2.5){
      if(layer>=2.5 && (cutawaySide<-0.05 || position.x<-0.02) && layer>minKeepLayer*0.5){cutawayVis=0.0;}
    }else if(mode<3.5){
      if(layer>=2.5 && (cutawaySide>0.05 || position.x>0.02) && layer>minKeepLayer*0.5){cutawayVis=0.0;}
    }else{
      if(layer>=1.5 && position.z>(1.0-threshold*2.0)*6.0){cutawayVis=0.0;}
    }
  }
  if(appear<=0.0001 || (cutawayVis<=0.0001 && u.params.w<=0.001)){
    return PartEvaluatedVertex(pivot,normal,0.0,wearAndDamage,0.0,0.0);
  }
  let flyIn=1.0-appear;
  let scaleIn=smoothstep(0.0,0.28,appear);
  let arcLift=sin(appear*3.14159265)*flyIn*u.params.y;
  let damageJitter=explodedOffset*(wearAndDamage*0.045);
  let displacement=explodedOffset*(explode+flyIn*u.params.x)+vec3f(0.0,arcLift,0.0)+damageJitter;
  let posedPos=pivot+(position-pivot)*scaleIn+displacement;
  return PartEvaluatedVertex(posedPos,normal,appear,wearAndDamage,cutawayVis,1.0);
}
fn applyPartSurfaceState(albedo:vec3f,roughness:f32,wearAndDamage:f32,cutawayAlpha:f32)->vec4f {
  let w=clamp(wearAndDamage,0.0,1.0);
  let grimeTint=mix(vec3f(1.0),vec3f(0.42,0.36,0.30),w*0.68);
  let scorch=mix(albedo*grimeTint,vec3f(0.14,0.11,0.09),w*w*0.45);
  let xrayRim=select(vec3f(0.0),vec3f(0.18,0.42,0.65)*(1.0-cutawayAlpha),cutawayAlpha<0.99);
  let nextRough=clamp(roughness+w*0.28,0.04,0.99);
  return vec4f(scorch+xrayRim,nextRough);
}
`;

export const PART_ASSEMBLY_POSE_UPDATE = PART_ASSEMBLY_WGSL + /* wgsl */ `
struct PartAssemblyPoseVertex {position:vec4f,normal:vec4f};
@group(0)@binding(0)var<storage,read_write>partAssemblyPosed:array<PartAssemblyPoseVertex>;
@group(0)@binding(1)var<storage,read>partAssemblyVertexAttrs:array<vec4f>;
@group(0)@binding(2)var<storage,read>partAssemblyDescriptors:array<vec4f>;
@group(0)@binding(3)var<storage,read>partAssemblyStates:array<vec4f>;
@group(0)@binding(4)var<uniform>partAssemblyUniform:PartAssemblyUniform;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let v=id.x;
  if(v>=arrayLength(&partAssemblyPosed) || v*2u+1u>=arrayLength(&partAssemblyVertexAttrs)){return;}
  let attr0=partAssemblyVertexAttrs[v*2u];
  let attr1=partAssemblyVertexAttrs[v*2u+1u];
  let partIdx=u32(max(0.0,round(attr0.x)));
  if(partIdx*2u+1u>=arrayLength(&partAssemblyDescriptors) || partIdx>=arrayLength(&partAssemblyStates)){return;}
  let desc0=partAssemblyDescriptors[partIdx*2u];
  let desc1=partAssemblyDescriptors[partIdx*2u+1u];
  let state=partAssemblyStates[partIdx];
  let current=partAssemblyPosed[v];
  let eval=evaluatePartAssemblyVertex(current.position.xyz,current.normal.xyz,attr0,attr1,desc0,desc1,state,partAssemblyUniform);
  var posedPos=eval.position;
  var localDamage=0.0;
  if(eval.visible>0.5){
    for(var i=0u;i<24u;i++){
      let imp=partAssemblyUniform.impacts[i];
      if(imp.w<=0.001){break;}
      let diffEntry=vec3f((current.position.x-imp.x)*0.65,current.position.y-imp.y,current.position.z-imp.z);
      let diffExit=vec3f((current.position.x+imp.x)*0.65,current.position.y-imp.y,current.position.z-imp.z);
      let distEntry=length(diffEntry);
      let distExit=select(99.0,length(diffExit),imp.y>0.35);
      let dist=min(distEntry,distExit);
      let sideWeight=select(0.75,1.0,distEntry<=distExit);
      let radius=0.38+imp.w*0.42;
      if(dist<radius){
        let falloff=1.0-dist/radius;
        let core=falloff*falloff;
        localDamage=max(localDamage,clamp(imp.w*sideWeight*falloff*1.65,0.0,1.0));
        if(desc0.z<=3.5){
          let jag=fract(sin(f32(v)*12.9898+f32(i)*78.233)*43758.5453)-0.5;
          let inward=vec3f(-sign(select(1.0,current.position.x,abs(current.position.x)>0.02))*0.095,-0.025+jag*0.055,jag*0.045);
          posedPos+=inward*(core*imp.w*sideWeight);
        }
      }
    }
  }
  let totalDamage=clamp(max(eval.wearAndDamage,localDamage),0.0,1.0);
  let safeNorm=normalize(select(vec3f(0.0,1.0,0.0),eval.normal,dot(eval.normal,eval.normal)>0.0001));
  let encodedNorm=select(eval.normal,safeNorm*(1.0+totalDamage),totalDamage>0.001);
  partAssemblyPosed[v].position=vec4f(posedPos,current.position.w);
  partAssemblyPosed[v].normal=vec4f(encodedNorm,totalDamage);
}
`;
