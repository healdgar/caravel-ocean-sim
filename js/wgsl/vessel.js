import { TILLER_PIVOT, HULL_VERTICAL_SCALE, hullDeck } from '../hull.js';
import { LATEEN_MOTION } from './lateen.js';
// Shared deformation keeps visible geometry, wetness and shadow casters coincident.
export const VESSEL_RIG = /* wgsl */ `
struct Hull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f,
  sailSet:vec4f, sailTrim:vec4f, sailWind:vec4f, lateen:array<vec4f,3>, lateenPressure:vec4f };
fn rotateHull(p:vec3f)->vec3f { return hull.right.xyz*p.x+hull.up.xyz*p.y-hull.forward.xyz*p.z; }
${LATEEN_MOTION}
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
  if(base==12u && uv.x>=100.0){
    let index=u32(round(uv.x-100.0));let line=rigLines[index];let t=uv.y;
    let oldAxis=normalize(line.b.xyz-line.a.xyz);
    let newAxis=normalize(rigRopePoint(index,min(1.0,t+.001))-rigRopePoint(index,max(0.0,t-.001)));
    local=rigRopePoint(index,t)+ropeFrame(position-mix(line.a.xyz,line.b.xyz,t),oldAxis,newAxis);
    localN=ropeFrame(normal,oldAxis,newAxis);
  }else if(id>0u && id<=3u){
    local=sailPoint(position,uv,id,base,false);
    if(base==19u){
      let rest=sailRestPoint(id,uv);
      local=sailPoint(rest,uv,id,13u,false)+clothRotation(id,position-rest);
    }
    if(base==9u || base==13u){
      let du=vec2f(.0005,0);let dv=vec2f(0,.0005);
      let tangent=sailPoint(sailRestPoint(id,uv+du),uv+du,id,base,false)-sailPoint(sailRestPoint(id,uv-du),uv-du,id,base,false);
      let vertical=sailPoint(sailRestPoint(id,uv+dv),uv+dv,id,base,false)-sailPoint(sailRestPoint(id,uv-dv),uv-dv,id,base,false);
      localN=normalize(cross(tangent,vertical));
    }else if(base==10u){localN=yardRotation(id,normal);}
    else{localN=clothRotation(id,normal);}
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
