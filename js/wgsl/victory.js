import {VICTORY_SAILS,VICTORY_RUNNING_LINES,VICTORY_STANDING_LINES} from '../models/victory.js';
const victoryVec=p=>'vec4f('+[...p,0].map(x=>Number(x).toFixed(9)).join(',')+')';
export const VICTORY_MOTION=/* wgsl */`
struct VictorySail {a:vec4f,b:vec4f,c:vec4f,d:vec4f,pivot:vec4f,shape:vec4f};
const victorySails=array<VictorySail,${VICTORY_SAILS.length}>(
${VICTORY_SAILS.map(s=>`VictorySail(${s.corners.concat(s.corners.length===3?[s.corners[2]]:[]).map(victoryVec).join(',')},${victoryVec(s.pivot)},vec4f(${s.mast}.0,${s.kind==='square'?0:s.kind==='headsail'?1:2}.0,${s.belly.toFixed(9)},${(s.footRise??0).toFixed(9)}))`).join(',\n')});
fn victoryRestPoint(id:u32,uv:vec2f)->vec3f {
 let s=victorySails[id-1u];
 if(s.shape.y==1.0){return s.a.xyz*(1.0-uv.x-uv.y)+s.b.xyz*uv.x+s.c.xyz*uv.y;}
 var p=mix(mix(s.a.xyz,s.b.xyz,uv.x),mix(s.d.xyz,s.c.xyz,uv.x),uv.y);
 p.y+=s.shape.w*4.0*uv.x*(1.0-uv.x)*uv.y;return p;
}
fn victoryYaw(id:u32)->f32 {let kind=victorySails[id-1u].shape.y;if(kind==2.0){return clamp(hull.sailTrim.y,-.5,.5);}return select(hull.sailTrim.y,clamp(hull.sailTrim.x,-.4,.4),kind==0.0);}
fn victoryRotate(p:vec3f,id:u32)->vec3f {
 let a=victoryYaw(id);let c=cos(a);let s=sin(a);let sail=victorySails[id-1u];
 if(sail.shape.y==1.0){let axis=normalize(sail.a.xyz-sail.b.xyz);return p*c+cross(axis,p)*s+axis*dot(axis,p)*(1.0-c);}
 return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
}
fn victoryYardPoint(id:u32,p:vec3f)->vec3f {let pivot=victorySails[id-1u].pivot.xyz;return pivot+victoryRotate(p-pivot,id);}
struct VictorySupport {a:vec4f,b:vec4f};
const victorySupports=array<VictorySupport,${VICTORY_STANDING_LINES.filter(l=>l.kind!=='forestay').length}>(
${VICTORY_STANDING_LINES.filter(l=>l.kind!=='forestay').map(l=>`VictorySupport(${victoryVec(l.a)},${victoryVec(l.b)})`).join(',\n')});
fn victoryContact(point:vec3f,mast:u32,lateral:bool,clothV:f32)->vec3f {
 var p=point;
 for(var i=mast*26u;i<(mast+1u)*26u;i++){
  let line=victorySupports[i];let t=(p.y-line.a.y)/(line.b.y-line.a.y);
  if(t<=0.0||t>=1.0){continue;}
  let q=mix(line.a.xyz,line.b.xyz,t);let d=select(abs(p.x-q.x),abs(p.z-q.z),lateral);let weight=(1.0-smoothstep(.28,.60,d))*smoothstep(0.0,.06,clothV);
  if(lateral){
   if(p.x*q.x>0.0&&abs(p.x)>abs(q.x)-.055){p.x=mix(p.x,sign(p.x)*max(0.0,abs(q.x)-.055),weight);}
  }else if(p.z>q.z-.055){p.z=mix(p.z,q.z-.055,weight);}
 }
 return p;
}
fn victoryClothPoint(id:u32,uv:vec2f)->vec3f {
 let s=victorySails[id-1u];let m=u32(s.shape.x);let square=s.shape.y==0.0;let quad=s.shape.y!=1.0;
 let rest=victoryRestPoint(id,uv);
 let top=victoryRestPoint(id,vec2f(select(uv.x+uv.y*.5,uv.x,quad),0));
 let deployed=hull.sailSet[m];let fill=hull.lateen[m].w;let yaw=victoryYaw(id);
 let normal=victoryRotate(select(vec3f(1,0,0),vec3f(0,0,1),square),id);
 let pressure=clamp((hull.sailWind.x*normal.x+hull.sailWind.y*normal.z)/1.5,-1.0,1.0);
 var p=mix(top,rest,.012+.988*deployed);
 let envelope=select(27.0*uv.x*uv.y*max(0.0,1.0-uv.x-uv.y),4.0*uv.x*(1.0-uv.x)*sin(3.14159265358979*uv.y),quad);
 let slack=1.0-clamp((fill-.2)/.65,0.0,1.0);
 let ripple=min(hull.rig.y/4.0,1.0)*.035*slack*slack*sin(hull.origin.w*6.0+uv.x*17.0+uv.y*13.0);
 let camber=s.shape.z*envelope*deployed*pressure*(.15+.85*fill)+ripple*envelope*deployed;
 if(square){p.z+=camber;}else{p.x+=camber;}
 let posed=victoryYardPoint(id,p);if(square||s.shape.y==2.0){return victoryContact(posed,m,s.shape.y==2.0,uv.y);}return posed;
}
struct VictoryLine {a:vec4f,b:vec4f,motion:vec4f};
const victoryLines=array<VictoryLine,${VICTORY_RUNNING_LINES.length}>(
${VICTORY_RUNNING_LINES.map(l=>`VictoryLine(${victoryVec(l.a)},${victoryVec(l.b)},vec4f(${l.sail}.0,${l.kind==='sheet'?1:0}.0,${(l.uv??[0,0]).join(',')}))`).join(',\n')});
const victoryLineTargets=array<u32,${VICTORY_RUNNING_LINES.length}>(${VICTORY_RUNNING_LINES.map(l=>(l.bSail??0)+'u').join(',')});
fn victoryRopePoint(index:u32,t:f32)->vec3f {
 let line=victoryLines[index];let id=u32(line.motion.x);
 var a=victoryYardPoint(id,line.a.xyz);
 if(line.motion.y>.5){a=victoryClothPoint(id,line.motion.zw);}
 var b=line.b.xyz;let otherSail=victoryLineTargets[index];
 if(otherSail>0u){b=victoryYardPoint(otherSail,b);}
 return mix(a,b,t);
}
`;
