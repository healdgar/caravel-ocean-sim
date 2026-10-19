import { SAIL_PLAN, RIG_LINES } from '../lateen.js';
import { RIG_MASTS, mastPoint } from '../rigging.js';
import { vesselDeck } from '../hull.js';
const v3=p=>`vec3f(${p.join(',')})`,v4=p=>`vec4f(${p.join(',')})`;
const kinds={shroud:0,runner:0,stay:0,fall:1,forestay:2,sheet:3,halyard:4,tack:5};
export const LATEEN_MOTION=/* wgsl */ `
const rigCorners=array<vec3f,9>(${SAIL_PLAN.flatMap(s=>s.corners).map(v3)});
const rigPivots=array<vec3f,3>(${SAIL_PLAN.map(s=>v3(s.pivot))});
const rigMasts=array<vec4f,3>(${RIG_MASTS.map(m=>v4([m.z,m.height,m.rake,vesselDeck(m.z)]))});
struct RigLine {a:vec4f,b:vec4f,control:vec4f};
const rigLines=array<RigLine,${RIG_LINES.length}>(${RIG_LINES.map(l=>`RigLine(${v4([...l.a,l.r])},${v4([...l.b,l.r2])},${v4([kinds[l.kind],l.mast,l.side,0])})`)});
fn rigAxisRotate(p:vec3f,axis:vec3f,angle:f32)->vec3f {
  let c=cos(angle);let s=sin(angle);return p*c+cross(axis,p)*s+axis*dot(axis,p)*(1.0-c);
}
fn lateenCorners(id:u32)->array<vec3f,3> {
  let i=(id-1u)*3u;return array<vec3f,3>(rigCorners[i],rigCorners[i+1u],rigCorners[i+2u]);
}
fn lateenPivot(id:u32)->vec3f {return rigPivots[id-1u];}
fn isLateen(id:u32)->bool {return true;}
fn sailRestPoint(id:u32,uv:vec2f)->vec3f {
  let c=lateenCorners(id);var p=c[0]+(c[1]-c[0])*uv.x+(c[2]-c[0])*uv.y;
  p.x+=array<f32,3>(${SAIL_PLAN.map(s=>s.belly)})[id-1u]*27.0*uv.x*uv.y*(1.0-uv.x-uv.y);return p;
}
fn yardRotation(id:u32,p:vec3f)->vec3f {
  let c=lateenCorners(id);let dip=hull.lateen[id-1u].z;
  return rigAxisRotate(p,vec3f(1,0,0),-atan2(c[0].z-c[1].z,c[0].y-c[1].y)*dip);
}
fn yardPoint(id:u32,p:vec3f)->vec3f {
  let pose=hull.lateen[id-1u];let pivot=lateenPivot(id);
  let radius=array<f32,3>(.46,.40,.34)[id-1u]+pose.z*.22;
  return pivot+yardRotation(id,p-pivot)+vec3f(pose.y*radius,
    pose.z*array<f32,3>(.85,1.80,1.35)[id-1u],sqrt(max(0.0,1.0-pose.y*pose.y))*radius);
}
fn clothRotation(id:u32,p:vec3f)->vec3f {
  let c=lateenCorners(id);let pose=hull.lateen[id-1u];
  return yardRotation(id,rigAxisRotate(p,normalize(c[1]-c[0]),-pose.y*pose.x));
}
fn sailPoint(position:vec3f,uv:vec2f,id:u32,material:u32,anchored:bool)->vec3f {
  if(material==10u){return yardPoint(id,position);}
  let c=lateenCorners(id);let pose=hull.lateen[id-1u];let deployed=hull.sailSet[id-1u];
  let fill=pose.w;let time=hull.origin.w;
  let clewAlong=dot(c[2]-c[0],c[1]-c[0])/dot(c[1]-c[0],c[1]-c[0]);
  var p=mix(mix(c[0],c[1],uv.x+clewAlong*uv.y),position,mix(.012,1.0,deployed));
  let belly=27.0*uv.x*uv.y*max(0.0,1.0-uv.x-uv.y);let slack=1.0-smoothstep(.2,.85,fill);
  p.x=pose.y*(p.x*(.12+.88*fill)+deployed*min(hull.sailWind.z/4.0,1.0)*belly*
    (.15*slack*slack*sin(time*7.0+uv.x*17.0+uv.y*11.0)+.003*fill*sin(time*.7)));
  p=c[0]+rigAxisRotate(p-c[0],normalize(c[1]-c[0]),-pose.y*pose.x);
  return yardPoint(id,p);
}
fn sailBasePoint(position:vec3f,uv:vec2f,id:u32,material:u32,anchored:bool)->vec3f {
  return sailPoint(position,uv,id,material,anchored);
}
fn rigMastPoint(mast:u32,y:f32)->vec3f {
  let m=rigMasts[mast];return vec3f(0,y,m.x+m.z*(y-m.w)/(m.y-m.w));
}
fn rigRopePoint(index:u32,t:f32)->vec3f {
  let line=rigLines[index];let kind=u32(line.control.x);let mast=u32(line.control.y);let id=mast+1u;
  let side=line.control.z;let pose=hull.lateen[mast];var a=line.a.xyz;var b=line.b.xyz;
  if(kind<2u){
    let point=mix(a,b,t);let ease=select(max(select(0.0,1.0,pose.y*side>0.0),clamp(pose.z/.12,0.0,1.0)),1.0,kind==1u);
    let low=1.0-t;let foot=pow(low,32.0);let y=point.y-.12*sin(3.14159265*t);
    let axis=rigMastPoint(mast,y);
    let clear=vec3f(b.x+side*.08*low+(a.x-b.x-side*.08)*foot,y,
      axis.z+(a.z-rigMastPoint(mast,a.y).z)*foot);
    return mix(point,clear,ease);
  }
  if(kind==3u){a=sailPoint(sailRestPoint(id,vec2f(0,1)),vec2f(0,1),id,13u,false);}
  if(kind==4u){b=yardPoint(id,line.b.xyz);}
  if(kind==5u){a=yardPoint(id,lateenCorners(id)[1]);}
  var point=mix(a,b,t);
  if(kind==3u){
    let lazy=1.0-smoothstep(-.25,.25,side*pose.y);
    let lead=vec3f(-b.x,b.y-.05,b.z-.12);let q=select((t-.72)/.28,t/.72,t<.72);
    var slack=select(mix(lead,b,q),mix(a,lead,q),t<.72);
    slack.y-=sin(3.14159265*q)*select(.02,.25,t<.72);
    point.y-=sin(3.14159265*t)*(.04+pose.z*.35);point=mix(point,slack,lazy);
    if(mast==2u){point.z+=pose.z*.45*sin(3.14159265*t);}
  }
  if(kind==5u){point.y-=sin(3.14159265*t)*(.06+pose.z*.2);}
  return point;
}
fn ropeFrame(v:vec3f,oldAxis:vec3f,newAxis:vec3f)->vec3f {
  let axis=cross(oldAxis,newAxis);return v+cross(axis,v)+cross(axis,cross(axis,v))/max(.00001,1.0+dot(oldAxis,newAxis));
}
`;
