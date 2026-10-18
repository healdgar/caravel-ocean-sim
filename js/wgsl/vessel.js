// Shared deformation keeps visible geometry and shadow casters coincident.
export const VESSEL_RIG = /* wgsl */ `
struct Hull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f };
fn rotateHull(p:vec3f)->vec3f { return hull.right.xyz*p.x+hull.up.xyz*p.y-hull.forward.xyz*p.z; }
struct RigVertex { position:vec3f, normal:vec3f, scale:vec3f };
fn rigVertex(position:vec3f,normal:vec3f,material:f32,uv:vec2f)->RigVertex {
  var scale=vec3f(hull.size.x/3.6,1.0,hull.size.y/12.0);
  var local=position;var localN=normal;
  if(material==7.0 || material==8.0){
    scale=vec3f(1.0);
    let angle=-hull.size.w/35.0*6.2831853;let c=cos(angle);let s=sin(angle);
    let pivot=vec3f(0,1.43,-1.7);let q=position-pivot;
    local=vec3f(c*q.x-s*q.y,s*q.x+c*q.y,q.z)+pivot;
    localN=vec3f(c*normal.x-s*normal.y,s*normal.x+c*normal.y,normal.z);
  }
  if(material==14.0){
    let angle=-hull.size.w*0.0174532925;let c=cos(angle);let s=sin(angle);
    let pivot=vec3f(0,-0.6,5.68);let q=position-pivot;
    local=vec3f(c*q.x+s*q.z,q.y,-s*q.x+c*q.z)+pivot;
    localN=vec3f(c*normal.x+s*normal.z,normal.y,-s*normal.x+c*normal.z);
  }
  if(material==13.0){local.x+=min(hull.rig.y*0.002,0.04)*sin(hull.origin.w*2.5+position.y*4.0)*27.0*uv.x*uv.y*max(0.0,1.0-uv.x-uv.y);}
  if(material==9.0){
    let flutter=min(hull.rig.y*0.0015,0.035)*sin(hull.origin.w*2.5+position.x*3.0+position.y*4.0);
    local.z+=flutter*sin(uv.x*3.14159265)*uv.y*uv.y;
  }
  return RigVertex(local,localN,scale);
}
`;

export const CANVAS_OPTICS = /* wgsl */ `
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
