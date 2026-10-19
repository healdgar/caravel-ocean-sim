import { TILLER_PIVOT, HULL_VERTICAL_SCALE, hullDeck } from '../hull.js';
import { SAIL_PLAN, LATEEN_CORNERS, LATEEN_PIVOT } from '../sailing.js';
const SAIL_RIG_INFO = SAIL_PLAN.map(s=>'vec4f('+[s.z,s.top,s.width,s.height].join(',')+')').join(',');
const SAIL_BELLIES = SAIL_PLAN.map(s=>s.belly).join(',');
const LATEEN_POINTS = LATEEN_CORNERS.map(p=>'vec3f('+p.join(',')+')').join(',');
// Shared deformation keeps visible geometry and shadow casters coincident.
export const VESSEL_RIG = /* wgsl */ `
struct Hull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f,
  sailSet:vec4f, sailTrim:vec4f, sailWind:vec4f };
fn rotateHull(p:vec3f)->vec3f { return hull.right.xyz*p.x+hull.up.xyz*p.y-hull.forward.xyz*p.z; }
fn sailRotate(p:vec3f,angle:f32)->vec3f {
  let c=cos(angle);let s=sin(angle);return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
}
fn sailRestPoint(id:u32,uv:vec2f)->vec3f {
  if(id==3u){
    let corners=array<vec3f,3>(${LATEEN_POINTS});
    var p=corners[0]+(corners[1]-corners[0])*uv.x+(corners[2]-corners[0])*uv.y;
    p.x+=0.8*27.0*uv.x*uv.y*(1.0-uv.x-uv.y);return p;
  }
  let info=array<vec4f,2>(${SAIL_RIG_INFO})[id-1u];
  let belly=array<f32,2>(${SAIL_BELLIES})[id-1u];
  return vec3f((uv.x-0.5)*info.z*(1.0-0.11*sin(uv.y*3.14159265)+0.025*uv.y),
    info.y-uv.y*info.w+0.28*sin(uv.x*3.14159265)*uv.y*uv.y,
    info.x-belly*sin(uv.x*3.14159265)*sin(uv.y*3.14159265*0.88));
}
fn sailPoint(position:vec3f,uv:vec2f,id:u32,material:u32,anchored:bool)->vec3f {
  var p=position;var pivot=vec3f(0);var yaw=hull.sailTrim.x;
  // Running ropes encode endpoint attachment in UV.y, independent of sail height.
  let weight=select(1.0,uv.y,anchored);
  let time=hull.origin.w;
  if(id<3u){
    let info=array<vec4f,2>(${SAIL_RIG_INFO})[id-1u];
    let deployed=hull.sailSet[id-1u];let fill=hull.sailTrim.z;
    pivot=vec3f(0,info.y,info.x);
    if(material!=10u){
      p.y=info.y+(p.y-info.y)*mix(0.025,1.0,deployed);
      p.z=info.x+(p.z-info.x)*mix(0.06,0.12+0.88*fill,deployed);
      if(material==9u){
        let edge=sin(uv.x*3.14159265)*uv.y;
        // Loose canvas luffs; loaded canvas has smaller trailing-edge flutter.
        p.z+=deployed*(0.02+0.16*(1.0-fill))*min(hull.sailWind.z/4.0,1.0)*sin(time*7.0+uv.x*15.0+uv.y*8.0)*edge;
        p.z+=(1.0-deployed)*0.05*sin(uv.y*62.83185)*sin(uv.x*3.14159265);
      }
    }
  }else{
    let deployed=hull.sailSet.z;let fill=hull.sailTrim.w;
    let corners=array<vec3f,3>(${LATEEN_POINTS});let yard=normalize(corners[1]-corners[0]);
    pivot=vec3f(${LATEEN_PIVOT.join(',')});yaw=hull.sailTrim.y;
    if(material!=10u){
      let onYard=corners[0]+yard*dot(position-corners[0],yard);
      p=mix(onYard,position,mix(0.025,1.0,deployed));
      p.x*=-hull.sailWind.w*(0.12+0.88*fill);
      if(material==13u){
        let belly=27.0*uv.x*uv.y*max(0.0,1.0-uv.x-uv.y);
        p.x+=deployed*(0.02+0.15*(1.0-fill))*min(hull.sailWind.z/4.0,1.0)*sin(time*7.0+uv.x*17.0+uv.y*11.0)*belly;
      }
    }
  }
  return mix(position,pivot+sailRotate(p-pivot,yaw),weight);
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
    if(base==9u || base==13u){
      let du=vec2f(0.0005,0);let dv=vec2f(0,0.0005);
      let tangent=sailPoint(sailRestPoint(id,uv+du),uv+du,id,base,false)-sailPoint(sailRestPoint(id,uv-du),uv-du,id,base,false);
      let vertical=sailPoint(sailRestPoint(id,uv+dv),uv+dv,id,base,false)-sailPoint(sailRestPoint(id,uv-dv),uv-dv,id,base,false);
      localN=normalize(cross(tangent,vertical));
    }else{localN=sailRotate(normal,select(hull.sailTrim.x,hull.sailTrim.y,id==3u));}
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
