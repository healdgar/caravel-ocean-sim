import { TILLER_PIVOT, HULL_VERTICAL_SCALE, hullDeck, vesselDeck } from '../hull.js';
import { SAIL_PLAN, runningRiggingLines } from '../sailing.js';
import { RIG_MASTS, mastPoint, standingRiggingLines } from '../rigging.js';
const SAIL_RIG_INFO = SAIL_PLAN.map(s=>'vec4f('+[s.z??0,s.top??0,s.width??1,s.height??1].join(',')+')').join(',');
const SAIL_BELLIES = SAIL_PLAN.map(s=>s.belly).join(',');
const LATEEN_POINTS = SAIL_PLAN.flatMap(s=>s.corners??[[0,0,0],[0,1,0],[0,0,1]]).map(p=>'vec3f('+p.join(',')+')').join(',');
const LATEEN_PIVOTS = SAIL_PLAN.map(s=>'vec3f('+(s.pivot??[0,0,0]).join(',')+')').join(',');
const SAIL_KINDS = SAIL_PLAN.map(s=>s.kind==='lateen'?'true':'false').join(',');
export const RIG_OBSTACLES=[...standingRiggingLines(),...runningRiggingLines(),...RIG_MASTS.map((m,i)=>({a:mastPoint(i,vesselDeck(m.z)),b:mastPoint(i,m.height),r:m.r,r2:m.r*.35,id:0,weights:[0,0]}))];
const RIG_OBSTACLE_WGSL=RIG_OBSTACLES.map(o=>'RigObstacle(vec4f('+[...o.a,o.r].join(',')+'),vec4f('+[...o.b,o.r2].join(',')+'),vec4f('+[o.id,...o.weights,0].join(',')+'))').join(',');
// Shared deformation keeps visible geometry and shadow casters coincident.
export const VESSEL_RIG = /* wgsl */ `
struct Hull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f,
  sailSet:vec4f, sailTrim:vec4f, sailWind:vec4f };
fn rotateHull(p:vec3f)->vec3f { return hull.right.xyz*p.x+hull.up.xyz*p.y-hull.forward.xyz*p.z; }
fn sailRotate(p:vec3f,angle:f32)->vec3f {
  let c=cos(angle);let s=sin(angle);return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
}
fn isLateen(id:u32)->bool {return array<bool,3>(${SAIL_KINDS})[id-1u];}
fn lateenCorners(id:u32)->array<vec3f,3> {
  let points=array<vec3f,9>(${LATEEN_POINTS});let i=(id-1u)*3u;
  return array<vec3f,3>(points[i],points[i+1u],points[i+2u]);
}
fn lateenPivot(id:u32)->vec3f {return array<vec3f,3>(${LATEEN_PIVOTS})[id-1u];}
fn sailRestPoint(id:u32,uv:vec2f)->vec3f {
  if(isLateen(id)){
    let corners=lateenCorners(id);
    var p=corners[0]+(corners[1]-corners[0])*uv.x+(corners[2]-corners[0])*uv.y;
    p.x+=array<f32,3>(${SAIL_BELLIES})[id-1u]*27.0*uv.x*uv.y*(1.0-uv.x-uv.y);return p;
  }
  let info=array<vec4f,3>(${SAIL_RIG_INFO})[id-1u];
  let belly=array<f32,3>(${SAIL_BELLIES})[id-1u];
  return vec3f((uv.x-0.5)*info.z*(1.0-0.11*sin(uv.y*3.14159265)+0.025*uv.y),
    info.y-uv.y*info.w+0.28*sin(uv.x*3.14159265)*uv.y*uv.y,
    info.x-belly*sin(uv.x*3.14159265)*sin(uv.y*3.14159265*0.88));
}
fn sailBasePoint(position:vec3f,uv:vec2f,id:u32,material:u32,anchored:bool)->vec3f {
  var p=position;var pivot=vec3f(0);var yaw=hull.sailTrim.x;
  // Running ropes encode endpoint attachment in UV.y, independent of sail height.
  let weight=select(1.0,uv.y,anchored);
  let time=hull.origin.w;
  if(!isLateen(id)){
    let info=array<vec4f,3>(${SAIL_RIG_INFO})[id-1u];
    let deployed=hull.sailSet[id-1u];let fill=hull.sailTrim.z;
    pivot=vec3f(0,info.y,info.x);
    if(material!=10u){
      p.y=info.y+(p.y-info.y)*mix(0.025,1.0,deployed);
      p.z=info.x+(p.z-info.x)*mix(0.06,0.12+0.88*fill,deployed);
      if(material==9u){
        let edge=sin(uv.x*3.14159265)*sin(uv.y*3.14159265);
        let slack=1.0-smoothstep(.2,.85,fill);
        // Taut canvas holds its camber. Fast luffing belongs to unloaded cloth;
        // the bolt ropes pin its perimeter, with only slow pressure breathing.
        p.z+=deployed*min(hull.sailWind.z/4.0,1.0)*edge*(.16*slack*slack*sin(time*7.0+uv.x*15.0+uv.y*8.0)+.003*fill*sin(time*.7));
        p.z+=(1.0-deployed)*0.05*sin(uv.y*62.83185)*sin(uv.x*3.14159265);
      }
    }
  }else{
    let deployed=hull.sailSet[id-1u];let fill=hull.sailTrim.w;
    let corners=lateenCorners(id);let yard=normalize(corners[1]-corners[0]);
    pivot=lateenPivot(id);yaw=hull.sailTrim.y;
    if(material!=10u){
      var onYard=corners[0]+yard*dot(position-corners[0],yard);
      // Gather each cloth column to its yard attachment. Nearest projection
      // mixes columns and turns a curved gathered bundle into wide triangles.
      if(material==13u){onYard=mix(corners[0],corners[1],uv.x);}
      if(material==12u && anchored && distance(position,corners[2])<.05){onYard=corners[0];}
      p=mix(onYard,position,mix(0.025,1.0,deployed));
      p.x*=-hull.sailWind.w*(0.12+0.88*fill);
      if(material==13u){
        let belly=27.0*uv.x*uv.y*max(0.0,1.0-uv.x-uv.y);
        let slack=1.0-smoothstep(.2,.85,fill);
        p.x+=deployed*min(hull.sailWind.z/4.0,1.0)*belly*(.15*slack*slack*sin(time*7.0+uv.x*17.0+uv.y*11.0)+.003*fill*sin(time*.7));
      }
    }
  }
  // The lateen yard hangs alongside the mast, rather than through its axis.
  if(isLateen(id)){p.x-=hull.sailWind.w*.20;}
  return mix(position,pivot+sailRotate(p-pivot,yaw),weight);
}
struct RigObstacle {a:vec4f,b:vec4f,motion:vec4f};
const rigObstacles=array<RigObstacle,${RIG_OBSTACLES.length}>(${RIG_OBSTACLE_WGSL});
// Small, smooth contact dimples; never pull distant vertices across the rig.
fn sailClearRig(point:vec3f,uv:vec2f,id:u32)->vec3f {
  var offset=vec3f(0);
  let edge=select(min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y)),min(min(uv.x,uv.y),1.0-uv.x-uv.y),isLateen(id));
  let free=smoothstep(0.0,.12,edge);
  for(var i=0u;i<${RIG_OBSTACLES.length}u;i++){
    let line=rigObstacles[i];var a=line.a.xyz;var b=line.b.xyz;let other=u32(line.motion.x);
    if(other>0u){
      a=sailBasePoint(a,vec2f(0,line.motion.y),other,12u,true);
      b=sailBasePoint(b,vec2f(0,line.motion.z),other,12u,true);
    }
    if(any(point<min(a,b)-.23)||any(point>max(a,b)+.23)){continue;}
    let axis=b-a;let along=clamp(dot(point-a,axis)/max(dot(axis,axis),.00001),0.0,1.0);
    let q=point-mix(a,b,along);let d=length(q);let radius=mix(line.a.w,line.b.w,along)+.07;
    // A continuous vector field avoids a sign flip when the cloth crosses a rope.
    offset+=q/max(radius,.001)*.12*(1.0-smoothstep(0.0,radius,d));
  }
  return point+offset*(free*min(1.0,.06/max(length(offset),.00001)));
}
// Hide only rope fragments at a cloth contact. This fallback handles crossings
// without stretching canvas into spikes. Sewn bolt ropes are a separate material.
// Inverse parameterization is inexpensive and does not run the contact loop.
fn rigInsideCanvas(point:vec3f)->bool {
  for(var id=1u;id<=3u;id++){
    let deployed=mix(.025,1.0,hull.sailSet[id-1u]);var uv=vec2f(0);var material=9u;
    if(!isLateen(id)){
      let info=array<vec4f,3>(${SAIL_RIG_INFO})[id-1u];let pivot=vec3f(0,info.y,info.x);
      let p=pivot+sailRotate(point-pivot,-hull.sailTrim.x);
      uv=vec2f(p.x/info.z+.5,(info.y-p.y)/(info.w*deployed));
      for(var k=0u;k<3u;k++){
        uv.x=p.x/(info.z*(1.0-.11*sin(uv.y*3.14159265)+.025*uv.y))+.5;
        uv.y=(info.y-p.y)/deployed/info.w+.28*sin(uv.x*3.14159265)*uv.y*uv.y/info.w;
      }
      if(any(uv<vec2f(0))||any(uv>vec2f(1))){continue;}
    }else{
      material=13u;let pivot=lateenPivot(id);
      let p=pivot+sailRotate(point-pivot,-hull.sailTrim.y);
      let corners=lateenCorners(id);let a=corners[1].yz-corners[0].yz;
      let b=(corners[2].yz-corners[0].yz)*deployed;let q=p.yz-corners[0].yz;
      let det=a.x*b.y-a.y*b.x;
      uv=vec2f(q.x*b.y-q.y*b.x,a.x*q.y-a.y*q.x)/det;
      if(any(uv<vec2f(0))||uv.x+uv.y>1.0){continue;}
    }
    let cloth=sailBasePoint(sailRestPoint(id,uv),uv,id,material,false);
    // Includes the bounded 6 cm deflection and interpolation between mesh samples.
    if(distance(point,cloth)<.14){return true;}
  }
  return false;
}
fn sailPoint(position:vec3f,uv:vec2f,id:u32,material:u32,anchored:bool)->vec3f {
  let p=sailBasePoint(position,uv,id,material,anchored);
  if(material==9u || material==13u){return sailClearRig(p,uv,id);}
  return p;
}
struct RigVertex { position:vec3f, normal:vec3f, scale:vec3f };
fn rigVertex(position:vec3f,normal:vec3f,material:f32,uv:vec2f)->RigVertex {
  var scale=vec3f(hull.size.x/3.6,${HULL_VERTICAL_SCALE},hull.size.y/12.0);
  var local=position;var localN=normal;
  if(material==7.0 || material==8.0){
    let pivot=vec3f(${TILLER_PIVOT.join(',')});
    let angle=hull.size.w*0.0174532925;let c=cos(angle);let s=sin(angle);
    let q=position-pivot;
    local=vec3f(c*q.x+s*q.z,q.y,-s*q.x+c*q.z)+pivot;
    localN=vec3f(c*normal.x+s*normal.z,normal.y,-s*normal.x+c*normal.z);
  }
  if(material==18.0){
    let pivot=vec3f(0,${hullDeck(-2.65)+.085},-2.65);let q=position-pivot;
    let angle=(1.0-clamp(hull.sailSet.w,0.0,1.0))*1.5707963;
    let c=cos(angle);let s=sin(angle);
    local=vec3f(q.x,c*q.y-s*q.z,s*q.y+c*q.z)+pivot;
    localN=vec3f(normal.x,c*normal.y-s*normal.z,s*normal.y+c*normal.z);
  }
  if(material==14.0){
    // +X is starboard and +Z is aft: positive helm moves the trailing edge to starboard.
    let angle=hull.size.w*0.0174532925;let c=cos(angle);let s=sin(angle);
    let pivot=vec3f(0,-0.6,5.68);let q=position-pivot;
    local=vec3f(c*q.x+s*q.z,q.y,-s*q.x+c*q.z)+pivot;
    localN=vec3f(c*normal.x+s*normal.z,normal.y,-s*normal.x+c*normal.z);
  }
  let tag=u32(round(fract(material)*16.0));let id=tag&7u;let base=u32(material);
  if(id>0u && id<=3u){
    local=sailPoint(position,uv,id,base,(tag&8u)!=0u);
    if(base==19u){
      // Sewn bolt ropes share their exact cloth UV, including collision offsets.
      let rest=sailRestPoint(id,uv);let cloth=select(9u,13u,isLateen(id));
      local=sailPoint(rest,uv,id,cloth,false)+sailRotate(position-rest,select(hull.sailTrim.x,hull.sailTrim.y,isLateen(id)));
    }
    if(base==9u || base==13u){
      let du=vec2f(0.0005,0);let dv=vec2f(0,0.0005);
      let tangent=sailPoint(sailRestPoint(id,uv+du),uv+du,id,base,false)-sailPoint(sailRestPoint(id,uv-du),uv-du,id,base,false);
      let vertical=sailPoint(sailRestPoint(id,uv+dv),uv+dv,id,base,false)-sailPoint(sailRestPoint(id,uv-dv),uv-dv,id,base,false);
      localN=normalize(cross(tangent,vertical));
    }else{localN=sailRotate(normal,select(hull.sailTrim.x,hull.sailTrim.y,isLateen(id)));}
  }
  return RigVertex(local,localN,scale);
}
`;

export const CANVAS_OPTICS = /* wgsl */ `
// Reduced fibre/medium index contrast lowers scattering when damp. This modest
// optical adjustment is authored, not a measured historical canvas coefficient.
fn canvasWetDepth(wet:f32)->f32 {return 1.0-0.18*clamp(wet,0.0,1.0);}
fn canvasThickness(uv:vec2f,material:u32)->f32 {
  let seamDistance=abs(fract(uv.x*10.0)-0.5);
  let seam=1.0-smoothstep(0.004,0.013+max(fwidth(seamDistance),0.001),seamDistance);
  let squareEdge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let triangleEdge=min(min(uv.x,uv.y),(1.0-uv.x-uv.y)*0.70710678);
  let edge=select(squareEdge,triangleEdge,material==13u);
  let hem=1.0-smoothstep(0.006,0.014+max(fwidth(edge),0.0005),edge);
  let fold=pow(0.5+0.5*cos(uv.x*62.83185+sin(uv.y*9.0)*0.35),8.0);
  let weave=sin(uv.x*1400.0)*sin(uv.y*1800.0)*(1.0-smoothstep(0.0004,0.003,max(fwidth(uv.x+uv.y),0.001)));
  return 1.0+0.95*seam+0.85*hem+0.18*fold+0.035*weave;
}
fn canvasTransmission(thickness:f32,incidence:f32)->vec3f {
  return exp(-vec3f(0.90,1.15,1.60)*thickness/max(incidence,0.12));
}
`;
