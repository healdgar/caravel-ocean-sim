// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ship's detail on the GPU (js/vessel-detail.js): two compute passes of her pose (js/vessel-pose.js). The first
// places what of her assembly the compact state moves, her colours flown to the wind and her anchor's iron let go;
// the second lays her detail layer, lines thinner than a ball (her rig's connectors, her mooring lines and gangplanks,
// her anchor's rode), into the tail of her posed vertices, each held by the parts it rides.
import { ROPE_WAVE_WGSL } from '../rope-wave.js';
import { HULL_VERTICAL_SCALE } from '../hull.js';

// Her hull uniform's first six rows (js/main.js writes them): her axes, size, origin and time, and wind.
const VESSEL_DETAIL_COMMON = /* wgsl */ `
struct VesselDetailHull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f, rig:vec4f };
struct VesselDetailState {
  colours:vec4f,          // code, 1 when struck, the wind's direction (world x, z)
  wind:vec4f,             // the wind's speed (m/s), unused
  anchor:vec4f,           // the iron's origin (world), 1 when let go
  anchorTurn:vec4f,       // its heading (radians), the rode paid out (m), the bed (m), the eye above the origin (m)
  moor:vec4f,             // the lines' progress, their tension, 1 casting off, the gangplanks' progress
  moorKind:vec4f,         // lines out, 1 to a vessel, her side (0 port, 1 starboard), unused
  moorFar:array<vec4f,4>, // each line's far end: a bollard (world), or the other vessel's rail (her design, z forward)
  targetRight:vec4f,      // the other vessel's axes (world), her design scale in w
  targetUp:vec4f,
  targetForward:vec4f,
  targetOrigin:vec4f,     // her origin (world)
  spare:array<vec4f,2>,
};
@group(0) @binding(0) var<uniform> hull:VesselDetailHull;
fn vesselDetailScale()->vec3f { return vec3f(hull.size.x/3.6,select(${HULL_VERTICAL_SCALE},hull.right.w,hull.right.w>0.0),hull.size.y/12.0); }
// Design units to the world and back, as her hull program places her (rotateHull, design z aft).
fn vesselDetailWorld(d:vec3f)->vec3f { let m=d*vesselDetailScale(); return hull.origin.xyz+hull.right.xyz*m.x+hull.up.xyz*m.y-hull.forward.xyz*m.z; }
fn vesselDetailDesign(w:vec3f)->vec3f { let r=w-hull.origin.xyz; return vec3f(dot(r,hull.right.xyz),dot(r,hull.up.xyz),-dot(r,hull.forward.xyz))/vesselDetailScale(); }
// A world normal as her assembly carries normals: scaled so that her hull program's division by her scale restores it.
fn vesselDetailDesignNormal(n:vec3f)->vec3f { let l=vec3f(dot(n,hull.right.xyz),dot(n,hull.up.xyz),-dot(n,hull.forward.xyz))*vesselDetailScale(); return l/max(length(l),1e-12); }
`;

// Her stations: each vertex of her colours' cloth (role 0 the ensign, 1 the pennant) flown from its hoist down the
// wind, its colours' code left in the posed position's w for her hull program; and each vertex of her anchor's iron
// (role 2), once let go, carried from the cathead to where her anchor's state has it, turned to its heading.
export const VESSEL_DETAIL_STATIONS = VESSEL_DETAIL_COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage,read_write> vesselDetailPosed:array<vec4f>;
@group(0) @binding(2) var<storage,read> vesselDetailSource:array<f32>;
@group(0) @binding(3) var<storage,read> vesselDetailModel:array<vec4f>;
@group(0) @binding(4) var<uniform> vesselDetailState:VesselDetailState;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  let head=vesselDetailModel[0u];
  if(id.x>=u32(head.w)){return;}
  let station=vesselDetailModel[u32(vesselDetailModel[1u].w)+id.x];
  let v=u32(station.x);let role=u32(station.y);let o=v*9u;
  if(o+8u>=arrayLength(&vesselDetailSource)||v*2u+1u>=arrayLength(&vesselDetailPosed)){return;}
  let rest=vec3f(vesselDetailSource[o],vesselDetailSource[o+1u],vesselDetailSource[o+2u]);
  let restNormal=vec3f(vesselDetailSource[o+3u],vesselDetailSource[o+4u],vesselDetailSource[o+5u]);
  let s=vesselDetailScale();
  let damage=vesselDetailPosed[v*2u+1u].w;
  let state=vesselDetailState;
  if(role==2u){
    if(state.anchor.w<0.5){return;}
    let q=(rest-vesselDetailModel[4u].xyz)*s;
    let c=cos(state.anchorTurn.x);let si=sin(state.anchorTurn.x);
    let n=normalize(restNormal/s);
    let world=state.anchor.xyz+vec3f(c*q.x-si*q.z,q.y,si*q.x+c*q.z);
    vesselDetailPosed[v*2u]=vec4f(vesselDetailDesign(world),0.0);
    vesselDetailPosed[v*2u+1u]=vec4f(vesselDetailDesignNormal(vec3f(c*n.x-si*n.z,n.y,si*n.x+c*n.z)),damage);
    return;
  }
  let u=clamp(vesselDetailSource[o+7u],0.0,1.0);let w=clamp(vesselDetailSource[o+8u],0.0,1.0);
  let pennant=role==1u;
  let surrendered=state.colours.y>0.5;
  let time=hull.origin.w;
  let windSpeed=clamp(state.wind.x,1.5,22.0);
  let base=select(vesselDetailModel[2u].xyz,vesselDetailModel[3u].xyz,pennant);
  // A struck ensign is dipped on its staff.
  let hoistTop=base.y+select(2.35,-0.03,pennant)+select(0.0,-0.32,surrendered&&!pennant);
  let hoistY=hoistTop-w*select(1.28,0.24*(1.0-0.72*u),pennant);
  let hoistZ=select(base.z+(hoistY-base.y)*0.58,base.z,pennant);
  let aft=-hull.forward.xyz;
  let hoist=hull.origin.xyz+hull.right.xyz*(base.x*s.x)+hull.up.xyz*(hoistY*s.y)+aft*(hoistZ*s.z);
  // The cloth streams down the wind with a travelling wave; an ensign running before it is carried into the lee
  // quarter, abaft the taffrail, clear of her mizzen.
  let wind2=normalize(select(vec2f(0.7,0.7),state.colours.zw,length(state.colours.zw)>1e-3));
  let windWorld=vec3f(wind2.x,0.0,wind2.y);
  let windRight=dot(windWorld,hull.right.xyz);
  let windAft=dot(windWorld,aft);
  let lee=select(-1.0,1.0,windRight>=0.0);
  let ensignRight=select(windRight,lee*max(abs(windRight),0.52),windAft<0.42);
  let stream=normalize(select(aft*max(0.42,windAft)+hull.right.xyz*ensignRight-hull.up.xyz*0.06,vec3f(wind2.x,-0.06,wind2.y),pennant));
  let side=normalize(vec3f(-stream.z,0.0,stream.x));
  let phase=time*(3.2+0.38*windSpeed)-u*6.8+w*0.9;
  let flutter=(sin(phase)+0.38*sin(phase*2.3+1.1))*(0.06+0.16*u*u);
  let sag=u*(1.0-0.35*u)*select(0.14,0.26,surrendered);
  let reach=max(0.85,s.x);
  let world=hoist+stream*(u*select(2.25,2.85,pennant)*reach)+side*(flutter*reach)-vec3f(0.0,sag*s.y,0.0);
  let normal=normalize(side-stream*(cos(phase)*0.85*u*0.32)+vec3f(0.0,0.12,0.0));
  vesselDetailPosed[v*2u]=vec4f(vesselDetailDesign(world),round(state.colours.x)+select(0.0,16.0,pennant));
  vesselDetailPosed[v*2u+1u]=vec4f(vesselDetailDesignNormal(normal),damage);
}
`;

// Her detail layer. Each line vertex names its tube, and each tube its two anchors: a point held at a fixed place (in
// metres) in the frame of one triangle of her posed assembly, so a line rides the parts it is made fast to and is
// shown only while every one of them is still aboard (js/ship-fracture.js: a shard in flight takes its lines with it).
// Rig tubes hang between their anchors in design units with the rope wave of her rig; her mooring lines, gangplanks
// and her anchor's rode are laid in the world from her compact state. Each vertex is written as three rows after her
// assembly's posed vertices: position and u, normal and v, then material, the vertex her wetness is read at, and 1
// when shown.
export const VESSEL_DETAIL_LINES = VESSEL_DETAIL_COMMON + ROPE_WAVE_WGSL + /* wgsl */ `
@group(0) @binding(1) var<storage,read_write> vesselDetailPosed:array<vec4f>;
@group(0) @binding(2) var<storage,read> vesselDetailModel:array<vec4f>;
@group(0) @binding(3) var<storage,read> vesselDetailShards:array<u32>;
@group(0) @binding(4) var<storage,read> vesselDetailRecords:array<vec4f>;
@group(0) @binding(5) var<uniform> vesselDetailState:VesselDetailState;
const VESSEL_DETAIL_PI=3.141592653589793;
fn vesselDetailAboard(v:u32)->bool {
  if(v>=arrayLength(&vesselDetailShards)){return true;}
  let shard=vesselDetailShards[v];
  if(shard==0u||shard*4u+3u>=arrayLength(&vesselDetailRecords)){return true;}
  return vesselDetailRecords[shard*4u+3u].w< -1.5;
}
struct VesselDetailAnchor { at:vec3f, held:bool, rider:u32 };
fn vesselDetailAnchor(i:u32,s:vec3f)->VesselDetailAnchor {
  let base=u32(vesselDetailModel[1u].x)+i*2u;
  let corners=vesselDetailModel[base];let local=vesselDetailModel[base+1u].xyz;
  let v0=u32(corners.x);let v1=u32(corners.y);let v2=u32(corners.z);
  let p0=vesselDetailPosed[v0*2u].xyz*s;let p1=vesselDetailPosed[v1*2u].xyz*s;let p2=vesselDetailPosed[v2*2u].xyz*s;
  let along=p1-p0;let across=cross(along,p2-p0);
  let held=vesselDetailAboard(v0)&&vesselDetailAboard(v1)&&vesselDetailAboard(v2)&&length(along)>1e-7&&length(across)>1e-12;
  if(!held){return VesselDetailAnchor(p0/s,false,v0);}
  let e1=normalize(along);let n=normalize(across);let e2=cross(n,e1);
  return VesselDetailAnchor((p0+e1*local.x+e2*local.y+n*local.z)/s,true,v0);
}
struct VesselDetailRing { p:vec3f, n:vec3f };
fn vesselDetailRing(a:vec3f,b:vec3f,ring:f32,end:f32,r0:f32,r1:f32)->VesselDetailRing {
  let chord=b-a;let dir=chord/max(length(chord),1e-6);
  let seed=select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(dir.y)>0.9);
  let across=normalize(cross(dir,seed));let up=cross(dir,across);
  let angle=ring*6.283185307179586;
  let n=across*cos(angle)+up*sin(angle);
  return VesselDetailRing(a+chord*end+n*mix(r0,r1,end),n);
}
fn vesselDetailCatenary(a:vec3f,b:vec3f,t:f32,sag:f32,line:f32,chain:RopeChainState,time:f32,wind:f32)->vec3f {
  let wave=evaluateRopeWaveAt(a,b,t,line,sag*1.35,chain,time,wind);
  return a+(b-a)*t-vec3f(0.0,4.0*t*(1.0-t)*sag,0.0)+wave;
}
// The other vessel's rail: her design point (z forward) in the world, as she lies.
fn vesselDetailTarget(p:vec3f)->vec3f {
  let st=vesselDetailState;
  return st.targetOrigin.xyz+st.targetRight.xyz*(p.x*st.targetRight.w)+st.targetUp.xyz*(p.y*st.targetUp.w)+st.targetForward.xyz*(p.z*st.targetForward.w);
}
fn vesselDetailWrite(j:u32,p:vec3f,n:vec3f,material:f32,uv:vec2f,rider:u32,shown:bool) {
  let at=u32(vesselDetailModel[6u].x)*2u+j*3u;
  if(at+2u>=arrayLength(&vesselDetailPosed)){return;}
  vesselDetailPosed[at]=vec4f(p,uv.x);
  vesselDetailPosed[at+1u]=vec4f(n,uv.y);
  vesselDetailPosed[at+2u]=vec4f(material,f32(rider),select(0.0,1.0,shown),0.0);
}
// A rope's u marks it as laid along its length, v its metres along over her hull program's lay (js/wgsl/caravel.js).
fn vesselDetailRopeUV(metres:f32)->vec2f { return vec2f(100.0,metres/max(hull.size.y*0.65,1e-3)); }
// A gangplank: a box, each face two triangles of its quad, corners as (along, side, height).
const VESSEL_DETAIL_PLANK=array<vec3f,24>(
  vec3f(0,-1,1),vec3f(1,-1,1),vec3f(1,1,1),vec3f(0,1,1),
  vec3f(0,-1,0),vec3f(0,1,0),vec3f(1,1,0),vec3f(1,-1,0),
  vec3f(0,-1,0),vec3f(1,-1,0),vec3f(1,-1,1),vec3f(0,-1,1),
  vec3f(0,1,0),vec3f(0,1,1),vec3f(1,1,1),vec3f(1,1,0),
  vec3f(0,-1,0),vec3f(0,-1,1),vec3f(0,1,1),vec3f(0,1,0),
  vec3f(1,-1,0),vec3f(1,1,0),vec3f(1,1,1),vec3f(1,-1,1));
const VESSEL_DETAIL_QUAD=array<u32,6>(0u,1u,2u,0u,2u,3u);
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  let head=vesselDetailModel[0u];let at=vesselDetailModel[1u];
  let j=id.x;
  if(j>=u32(head.z)){return;}
  let lv=vesselDetailModel[u32(at.z)+j];
  let t=u32(at.y)+u32(lv.x)*4u;
  let ta=vesselDetailModel[t];let tb=vesselDetailModel[t+1u];let cat=vesselDetailModel[t+2u];let shape=vesselDetailModel[t+3u];
  let mode=u32(round(shape.w));
  let s=vesselDetailScale();
  let st=vesselDetailState;
  if(mode==0u){
    // A connector of her rig: between its two anchors, straight or hanging in its catenary with the rope wave.
    let a0=vesselDetailAnchor(u32(ta.w),s);let b0=vesselDetailAnchor(u32(tb.w),s);
    var a=a0.at+ta.xyz;var b=b0.at+tb.xyz;
    var reach=0.0;
    if(cat.x>=0.0){
      let packed=unpackHullRopeChain(hull.size.z,hull.right.y,hull.forward.y);
      let chain=RopeChainState(1.0,packed.swayX,packed.swayZ);
      reach=cat.x*length((b-a)*s);
      let head2=vesselDetailCatenary(a,b,cat.x,cat.z,cat.w,chain,hull.origin.w,st.wind.x);
      let tail=vesselDetailCatenary(a,b,cat.y,cat.z,cat.w,chain,hull.origin.w,st.wind.x);
      a=head2;b=tail;
    }
    let ring=vesselDetailRing(a,b,lv.y,lv.z,shape.x,shape.y);
    let metres=reach+length((b-a)*s)*lv.z;
    let uv=select(vec2f(lv.y,metres),vesselDetailRopeUV(metres),shape.z>11.5&&shape.z<12.5);
    vesselDetailWrite(j,ring.p,normalize(ring.n*s),shape.z,uv,a0.rider,a0.held&&b0.held&&length(b-a)>1e-5);
    return;
  }
  let line=u32(round(cat.w));
  let vessel=st.moorKind.y>0.5;
  let moorAt=u32(vesselDetailModel[5u].x);
  if(mode==1u||mode==3u){
    // A mooring line, from her rail to a bollard or the other vessel's rail: thrown in an arc, landed in a catenary
    // that pulls taut with tension, or slacked off and hauled back aboard.
    let ship=vesselDetailAnchor(moorAt+select(0u,8u,vessel)+min(u32(st.moorKind.z),1u)*4u+min(line,3u),s);
    let out=line<u32(round(st.moorKind.x))&&ship.held;
    if(mode==3u){
      // A gangplank, run out from her rail to the other vessel's.
      let progress=clamp(st.moor.w,0.0,1.0);
      let start=vesselDetailWorld(ship.at+vec3f(0.0,0.06,0.0));
      let far=vesselDetailTarget(st.moorFar[min(line,3u)].xyz+vec3f(0.0,0.06,0.0));
      let end=start+(far-start)*progress;
      let d=end-start;let flat=max(length(d.xz),1e-4);
      let side=vec3f(-d.z/flat,0.0,d.x/flat);
      let dir=d/max(length(d),1e-4);
      let face=u32(lv.y);let corner=VESSEL_DETAIL_PLANK[min(face,5u)*4u+VESSEL_DETAIL_QUAD[min(u32(lv.z),5u)]];
      let p=mix(start,end,corner.x)+side*(corner.y*shape.x*0.5)+vec3f(0.0,corner.z*shape.y,0.0);
      let normals=array<vec3f,6>(vec3f(0.0,1.0,0.0),vec3f(0.0,-1.0,0.0),-side,side,-dir,dir);
      vesselDetailWrite(j,vesselDetailDesign(p),vesselDetailDesignNormal(normals[min(face,5u)]),shape.z,vec2f(corner.y*0.5+0.5,corner.x*length(d)),ship.rider,
        out&&vessel&&progress>0.05&&length(d)>1e-3);
      return;
    }
    let start=vesselDetailWorld(ship.at);
    var far=st.moorFar[min(line,3u)].xyz;
    if(vessel){far=vesselDetailTarget(far);}
    let stagger=f32(line)*0.08;
    let lp=clamp((clamp(st.moor.x,0.0,1.0)-stagger)/(1.0-stagger*0.5),0.04,1.0);
    let arc=sin(lp*VESSEL_DETAIL_PI);
    let castingOff=st.moor.z>0.5;
    let lift=select(select(0.0,arc*1.45,lp<1.0),-0.45*arc,castingOff);
    let end=start+(far-start)*lp+vec3f(0.0,lift,0.0);
    let span=length((end-start).xz);
    let tension=clamp(st.moor.y,0.0,1.0);
    let sag=select(select(-0.35*arc,clamp(span*(0.14-0.095*tension),0.12,1.45),lp>=0.99),clamp(span*0.18,0.16,1.35),castingOff);
    let pa=start+(end-start)*cat.x-vec3f(0.0,4.0*sag*cat.x*(1.0-cat.x),0.0);
    let pb=start+(end-start)*cat.y-vec3f(0.0,4.0*sag*cat.y*(1.0-cat.y),0.0);
    let ring=vesselDetailRing(pa,pb,lv.y,lv.z,shape.x,shape.y);
    vesselDetailWrite(j,vesselDetailDesign(ring.p),vesselDetailDesignNormal(ring.n),shape.z,vesselDetailRopeUV(length(end-start)*mix(cat.x,cat.y,lv.z)),ship.rider,out);
    return;
  }
  // Her anchor's rode, from the fairlead to the iron's eye: a bounded sag that straightens as it takes the strain and
  // never lies below the bed.
  let fair=vesselDetailAnchor(u32(vesselDetailModel[5u].y),s);
  let a=vesselDetailWorld(fair.at);
  let b=st.anchor.xyz+vec3f(0.0,st.anchorTurn.w,0.0);
  let rode=st.anchorTurn.y;let bed=st.anchorTurn.z;
  let slack=max(0.0,rode-length(b-a));
  let sag=min(max(0.0,(a.y-bed)*0.8),sqrt(slack*max(1.0,rode))*0.5);
  let ya=max(bed+0.04,mix(a.y,b.y,cat.x)-sin(VESSEL_DETAIL_PI*cat.x)*sag);
  let yb=max(bed+0.04,mix(a.y,b.y,cat.y)-sin(VESSEL_DETAIL_PI*cat.y)*sag);
  let pa=vec3f(mix(a.x,b.x,cat.x),ya,mix(a.z,b.z,cat.x));
  let pb=vec3f(mix(a.x,b.x,cat.y),yb,mix(a.z,b.z,cat.y));
  let ring=vesselDetailRing(pa,pb,lv.y,lv.z,shape.x,shape.y);
  vesselDetailWrite(j,vesselDetailDesign(ring.p),vesselDetailDesignNormal(ring.n),shape.z,vesselDetailRopeUV(length(b-a)*mix(cat.x,cat.y,lv.z)),fair.rider,
    st.anchor.w>0.5&&fair.held&&length(b-a)>1e-3);
}
`;
