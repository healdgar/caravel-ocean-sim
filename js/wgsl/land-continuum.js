// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The land's GPU side (js/land-continuum.js bakes what it reads). The cut and its handoff are the shared core's
// (js/continuum-core.js); this supplies only how a heightfield is read.
//
// A piece of land (Saba with its surveyed bay, a coast's centre, each section round it) is one lattice of heights and
// a quadtree of patches over it, every patch 16 by 16 cells at its level's stride. The quadtree's root goes on up as
// one patch of 8, 4, 2 and finally 1 cell, two triangles: the continuum's far end. The cut keeps a patch whose
// projected error is within the scene's pixel error and whose parent's is not.
//
// A vertex's height is one function of where it is, the same for every patch and piece that holds it. Walking down
// from the piece's four corners, each point a level brings in sits on its coarser neighbours' line until the error
// that level would leave, seen from where the point is, falls under what the scene allows; across the handoff band
// it rises to the ground. The error a point waits for is the least of every patch coarser than its own level that
// holds it, so a coarser patch drawn beside a finer one always finds the finer one's edge points on its own edge, and
// a patch that splits brings in its points already lying where the coarse one drew them: no crack and no pop.
//
// Below the lattice the quadtree goes on, but only where something finer lies on it: where shot has dug, a patch
// splits down to the crater tiles' cell, and over a river's banks down to the banks' (js/wgsl/land-banks.js). Its
// points between the lattice's lie on the lattice's triangles with the pit or the bank in them, and wait for as much
// error as the pit or bank moves the ground over the 2 m block they are in (landCraterWaits, landBankWaits). Every
// piece counts in one finest unit, a power of two of the grid's, so two pieces still meet at the same points.
import { FRAME_WGSL } from './common.js';
import { CONTINUUM_CORE_WGSL } from '../continuum-core.js';
import { LAND_BANK_WGSL, LAND_BANK_LEVEL, LAND_BANK_CELL_M } from './land-banks.js';

export const LAND_CONTINUUM_PATCH = 16;
// The patch sizes a list draws, finest first: the quadtree's patches, then the root's own far end.
export const LAND_CONTINUUM_TESSELLATIONS = Object.freeze([16, 8, 4, 2, 1]);
export const LAND_CONTINUUM_LISTS = LAND_CONTINUUM_TESSELLATIONS.length;
// Pieces drawn at once: a coast's centre and every section within four of it, with room to spare.
export const LAND_CONTINUUM_SLOTS = 96;
export const LAND_CONTINUUM_DRAW_WORDS = 5;
// Two cuts of every piece: the view's, then the water captures' (js/water-optics.js), coarser.
export const LAND_CONTINUUM_RECORDS = 2 * LAND_CONTINUUM_SLOTS * LAND_CONTINUUM_LISTS;
export const LAND_CONTINUUM_CAPTURE_COARSENING = 4;
// A node: centre xyz, radius, error (0 for a leaf: nothing finer to give way to), parent, corner x z (finest units),
// level, patch cells, list, unused.
export const LAND_CONTINUUM_NODE_WORDS = 12;
// A lattice point: height, kind.y (sand on a coast, how far the survey trusts itself on Saba), the error it waits for.
export const LAND_CONTINUUM_POINT_FLOATS = 3;
export const LAND_CONTINUUM_PIECE_BYTES = 96;
export const LAND_CONTINUUM_VIEW_BYTES = 16;
// The finest the land is cut: the crater tiles' cell (LAND_CRATER_CELL_M in js/wgsl/land-craters.js), so a pit is
// drawn as finely as it is worked out.
export const LAND_CONTINUUM_FINEST_M = 0.125;
// Log2 finest units a grid unit, for a grid of `g` metres a unit.
export const landContinuumFinest = (g) => Math.max(0, Math.ceil(Math.log2(g / LAND_CONTINUUM_FINEST_M) - 1e-9));
export const LAND_CONTINUUM_ENTRY_LAYOUT = Object.freeze([{ arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32' }] }]);

// One index buffer: each patch size's grid of (c + 1)^2 vertices, every cell split along the anti-diagonal, as the
// land's height queries split it (terrainSurfaceSample in js/terrain-model.js).
export function landContinuumIndices() {
  const firsts = [], counts = [], all = [];
  for (const c of LAND_CONTINUUM_TESSELLATIONS) {
    firsts.push(all.length);
    for (let j = 0; j < c; j++) for (let i = 0; i < c; i++) {
      const k = j * (c + 1) + i;
      all.push(k, k + c + 1, k + 1, k + 1, k + c + 1, k + c + 2);
    }
    counts.push(all.length - firsts.at(-1));
  }
  return { indices: Uint16Array.from(all), firsts, counts };
}

// What the cut and the drawing both read. `group` and `first` place the bindings.
function landContinuumData(group, first, access) {
  return /* wgsl */`
struct LandContinuumView { scene:vec4f };  // the view's pixel error, the captures', the world's offset x and z
struct LandContinuumPiece {
  grid:vec4f,    // world x and z of grid point 0, metres a grid unit
  place:vec4i,   // grid point of the piece's own (0,0); log2 grid units a finest unit (below 0); log2 finest units across
  base:vec4u,    // lattice side; log2 finest units a lattice cell; first float; nodes
  window:vec4i,  // a finer survey inside: its (0,0) in finest units, finest units across (0 for none), first float
  lists:vec4u,   // draw slot; room in the patch list; where the captures' lists start; log2 finest units a survey cell
  near:vec4f,    // where the survey's own ground lies (world x0 x1 z0 z1), drawn as kind 1
};
@group(${group}) @binding(${first}) var<uniform> landView:LandContinuumView;
@group(${group}) @binding(${first + 1}) var<uniform> landPiece:LandContinuumPiece;
@group(${group}) @binding(${first + 2}) var<storage,${access}> landLattice:array<f32>;
@group(${group}) @binding(${first + 3}) var<storage,${access}> landNodes:array<u32>;
fn landContinuumFocal()->f32 { return F.screen.y/max(2.0*length(F.camUp.xyz),1e-4); }
fn landContinuumShift()->vec3f { return vec3f(landView.scene.z,0.0,landView.scene.w); }
`;
}

// --------------------------------------------------------------------------------------------- the cut
export function landContinuumCutWGSL() {
  const S = LAND_CONTINUUM_SLOTS, L = LAND_CONTINUUM_LISTS, W = LAND_CONTINUUM_NODE_WORDS;
  const { firsts, counts } = landContinuumIndices();
  return FRAME_WGSL + CONTINUUM_CORE_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
` + landContinuumData(0, 1, 'read') + /* wgsl */`
@group(0) @binding(5) var<storage,read_write> landLists:array<u32>;
@group(0) @binding(6) var<storage,read_write> landDraws:array<atomic<u32>>;
// Every list emptied, its index count and first index set.
@compute @workgroup_size(64) fn landContinuumReset(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=${LAND_CONTINUUM_RECORDS}u){return;}
  let counts=array<u32,${L}>(${counts.map((n) => `${n}u`).join(',')});
  let firsts=array<u32,${L}>(${firsts.map((n) => `${n}u`).join(',')});
  let list=id.x%${L}u;let at=id.x*${LAND_CONTINUUM_DRAW_WORDS}u;
  atomicStore(&landDraws[at],counts[list]);atomicStore(&landDraws[at+1u],0u);atomicStore(&landDraws[at+2u],firsts[list]);
  atomicStore(&landDraws[at+3u],0u);atomicStore(&landDraws[at+4u],0u);
}
fn landContinuumOutside(at:vec3f,reach:f32)->bool {
  let m=F.viewProj;let p=vec4f(at,1.0);
  let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
  let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
  for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
  return false;
}
fn landContinuumAppend(cut:u32,list:u32,node:u32){
  let record=cut*${S * L}u+landPiece.lists.x*${L}u+list;
  let at=atomicAdd(&landDraws[record*${LAND_CONTINUUM_DRAW_WORDS}u+1u],1u);
  let room=select(1u,landPiece.lists.y,list==0u);
  if(at>=room){atomicSub(&landDraws[record*${LAND_CONTINUUM_DRAW_WORDS}u+1u],1u);return;}
  landLists[select(0u,landPiece.lists.z,cut==1u)+select(landPiece.lists.y+list-1u,0u,list==0u)+at]=node;
}
fn landContinuumSphere(node:u32)->vec4f {
  let at=node*${W}u;
  return vec4f(bitcast<f32>(landNodes[at]),bitcast<f32>(landNodes[at+1u]),bitcast<f32>(landNodes[at+2u]),bitcast<f32>(landNodes[at+3u]));
}
// One node a thread: kept by the view's cut, by the captures', by both or by neither.
@compute @workgroup_size(64) fn landContinuumCut(@builtin(global_invocation_id) id:vec3u,@builtin(num_workgroups) groups:vec3u){
  let node=id.x+id.y*groups.x*64u;
  if(node>=landPiece.base.w){return;}
  let at=node*${W}u;
  let own=landContinuumSphere(node);
  let parent=landNodes[at+5u];
  var up=own;var upError=3.0e38;
  if(parent!=0xffffffffu){up=landContinuumSphere(parent);upError=bitcast<f32>(landNodes[parent*${W}u+4u]);}
  let eye=F.camPos.xyz-landContinuumShift();
  let near=own.xyz-eye;
  if(landContinuumOutside(earthCurve(near,F.camPos.y),own.w)){return;}
  let focal=landContinuumFocal();let error=bitcast<f32>(landNodes[at+4u]);let list=landNodes[at+10u];
  if(continuumClusterDrawn(error,near,own.w,upError,up.xyz-eye,up.w,focal,landView.scene.x)){landContinuumAppend(0u,list,node);}
  if(continuumClusterDrawn(error,near,own.w,upError,up.xyz-eye,up.w,focal,landView.scene.y)){landContinuumAppend(1u,list,node);}
}
`;
}

// --------------------------------------------------------------------------------------------- the ground
// The height drawn anywhere on a piece, for the drawing and for the probe below.
const LAND_CONTINUUM_HEIGHT = /* wgsl */`
fn landContinuumWindowed(p:vec2i)->bool {
  let w=landPiece.window;
  if(w.z==0){return false;}
  let q=p-w.xy;
  return all(q>=vec2i(0))&&all(q<=vec2i(w.z));
}
// The lattice's cell where a point is: the survey's inside the window, the piece's own outside.
fn landContinuumCell(p:vec2i)->i32 { return select(1<<landPiece.base.y,1<<landPiece.lists.w,landContinuumWindowed(p)); }
fn landContinuumOnLattice(p:vec2i)->bool { return all((p&vec2i(landContinuumCell(p)-1))==vec2i(0)); }
// A lattice point's record: height, kind.y, the error it waits for.
fn landContinuumPoint(p:vec2i)->vec3f {
  var at=0u;
  if(landContinuumWindowed(p)){
    let r=landPiece.lists.w;
    let q=vec2u(p-landPiece.window.xy)>>vec2u(r);
    at=u32(landPiece.window.w)+(q.y*((u32(landPiece.window.z)>>r)+1u)+q.x)*${LAND_CONTINUUM_POINT_FLOATS}u;
  }else{
    let q=vec2u(p)>>vec2u(landPiece.base.y);
    at=landPiece.base.z+(q.y*landPiece.base.x+q.x)*${LAND_CONTINUUM_POINT_FLOATS}u;
  }
  return vec3f(landLattice[at],landLattice[at+1u],landLattice[at+2u]);
}
// The ground anywhere on the piece, its height and kind.y: the lattice's own triangles, split as the height queries
// split them.
fn landContinuumGround(p:vec2i)->vec2f {
  let cell=landContinuumCell(p);
  let f=p&vec2i(cell-1);
  if(all(f==vec2i(0))){return landContinuumPoint(p).xy;}
  let lo=p-f;let a=f32(f.x)/f32(cell);let b=f32(f.y)/f32(cell);
  let h00=landContinuumPoint(lo).xy;let h10=landContinuumPoint(lo+vec2i(cell,0)).xy;
  let h01=landContinuumPoint(lo+vec2i(0,cell)).xy;let h11=landContinuumPoint(lo+vec2i(cell)).xy;
  return select(h11+(1.0-a)*(h01-h11)+(1.0-b)*(h10-h11),h00+a*(h10-h00)+b*(h01-h00),a+b<=1.0);
}
// Where a point of the piece is, from the grid the pieces share, so that two pieces place a shared point alike: the
// grid unit is exact, a whole number and a few binary places.
fn landContinuumXZ(p:vec2i)->vec2f {
  let g=vec2f(landPiece.place.xy)+ldexp(vec2f(p),vec2i(landPiece.place.z));
  return landPiece.grid.xy+g*landPiece.grid.z;
}
// The ground a point stands for, and the error it waits for. The ground is the lattice with whatever lies on it that
// is a function of the world alone (landContinuumRelief: the banks and the pits shot has dug, where the drawing has
// them), so every patch and piece that holds the point walks the same ground. A point between the lattice's waits for
// what lies there as fine as its level (landContinuumDug; its level, the finest stride its place is a multiple of),
// except on the survey's border, where the piece's own lattice outside draws a line.
fn landContinuumTrue(p:vec2i)->vec2f {
  let xz=landContinuumXZ(p);
  if(landContinuumOnLattice(p)){
    let r=landContinuumPoint(p);
    return vec2f(landContinuumRelief(xz,r.x),r.z);
  }
  let w=landPiece.window;
  let rim=w.z>0&&landContinuumWindowed(p)&&(p.x==w.x||p.x==w.x+w.z||p.y==w.y||p.y==w.y+w.z);
  let level=min(countTrailingZeros(u32(p.x)),countTrailingZeros(u32(p.y)));
  return vec2f(landContinuumRelief(xz,landContinuumGround(p).x),select(landContinuumDug(xz,level),0.0,rim));
}
// A point brought in at its level: its coarser neighbours' line, and as much of the ground's departure from it as
// the error it waits for, seen from where it is, calls for.
fn landContinuumMorph(p:vec2i,point:vec2f,lineTrue:f32,lineDrawn:f32,eye:vec3f,focal:f32,pixels:f32)->f32 {
  let xz=landContinuumXZ(p);
  let away=length(vec3f(xz.x,point.x,xz.y)-eye);
  let t=continuumHandoff(continuumAllowedError(pixels,focal,away),point.y/(1.0+CONTINUUM_HANDOFF_BAND));
  return lineDrawn+(1.0-t)*(point.x-lineTrue);
}
// The height drawn at a lattice point, walking down from the piece's corners. Corners are numbered x + 2z.
fn landContinuumHeight(p:vec2i,pixels:f32)->f32 {
  let focal=landContinuumFocal();
  let eye=F.camPos.xyz-landContinuumShift();
  var lo=vec2i(0);var size=1<<u32(landPiece.place.w);
  var truth=array<f32,4>(landContinuumTrue(lo).x,landContinuumTrue(vec2i(size,0)).x,landContinuumTrue(vec2i(0,size)).x,landContinuumTrue(vec2i(size)).x);
  var drawn=truth;
  for(var step=0;step<30;step++){
    let r=p-lo;
    if((r.x==0||r.x==size)&&(r.y==0||r.y==size)){return drawn[u32(r.x/size)+2u*u32(r.y/size)];}
    let half=size/2;
    let q=vec2u(select(vec2i(0),vec2i(1),r>=vec2i(half)));
    // The middle sits on the anti-diagonal, between corners 1 and 2; each edge's middle between that edge's ends.
    let pc=lo+vec2i(half);let rc=landContinuumTrue(pc);
    let dc=landContinuumMorph(pc,rc,(truth[1]+truth[2])*0.5,(drawn[1]+drawn[2])*0.5,eye,focal,pixels);
    let ph=lo+vec2i(half,i32(q.y)*size);let rh=landContinuumTrue(ph);let a=2u*q.y;
    let dh=landContinuumMorph(ph,rh,(truth[a]+truth[a+1u])*0.5,(drawn[a]+drawn[a+1u])*0.5,eye,focal,pixels);
    let pv=lo+vec2i(i32(q.x)*size,half);let rv=landContinuumTrue(pv);let b=q.x;
    let dv=landContinuumMorph(pv,rv,(truth[b]+truth[b+2u])*0.5,(drawn[b]+drawn[b+2u])*0.5,eye,focal,pixels);
    // The corner of the quadrant's own stays; the others are the edges' middles and the middle.
    let across=(1u-q.x)+2u*q.y;let above=q.x+2u*(1u-q.y);let opposite=(1u-q.x)+2u*(1u-q.y);
    truth[across]=rh.x;truth[above]=rv.x;truth[opposite]=rc.x;
    drawn[across]=dh;drawn[above]=dv;drawn[opposite]=dc;
    lo+=vec2i(q)*half;size=half;
  }
  return drawn[0];
}
fn landContinuumNormal(p:vec2i)->vec3f {
  let across=1<<u32(landPiece.place.w);
  let w=landPiece.window;let inner=w.z>0&&all(p>w.xy)&&all(p<w.xy+vec2i(w.z));
  let e=select(1<<landPiece.base.y,1<<landPiece.lists.w,inner);
  let x0=max(p.x-e,0);let x1=min(p.x+e,across);let z0=max(p.y-e,0);let z1=min(p.y+e,across);
  let metres=ldexp(landPiece.grid.z,landPiece.place.z);
  let dx=(landContinuumGround(vec2i(x0,p.y)).x-landContinuumGround(vec2i(x1,p.y)).x)/(f32(x1-x0)*metres);
  let dz=(landContinuumGround(vec2i(p.x,z0)).x-landContinuumGround(vec2i(p.x,z1)).x)/(f32(z1-z0)*metres);
  return normalize(vec3f(dx,1.0,dz));
}
`;

// What the GPU draws at given points of one piece, read back: for tests and for looking into what went wrong. The
// cut's bindings 0 to 4 (4 unread), then the points (finest units) and the heights out. `relief` is the body of
// landContinuumRelief(xz, h): the lattice alone unless a test lays something on it, as the pits are in the drawing;
// `dug` the body of landContinuumDug(xz, level), what a point between the lattice's waits for.
export function landContinuumProbeWGSL(relief = 'return h;', dug = 'return 0.0;') {
  return FRAME_WGSL + CONTINUUM_CORE_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
` + landContinuumData(0, 1, 'read') + LAND_CONTINUUM_HEIGHT + /* wgsl */`
fn landContinuumRelief(xz:vec2f,h:f32)->f32 { ${relief} }
fn landContinuumDug(xz:vec2f,level:u32)->f32 { ${dug} }
@group(0) @binding(5) var<storage,read> landProbePoints:array<vec4i>;
@group(0) @binding(6) var<storage,read_write> landProbeHeights:array<vec4f>;
@compute @workgroup_size(64) fn landContinuumProbe(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&landProbePoints)){return;}
  let point=landProbePoints[id.x];
  let p=point.xy;let xz=landContinuumXZ(p);
  landProbeHeights[id.x]=vec4f(xz.x,landContinuumHeight(p,select(landView.scene.x,landView.scene.y,point.z==1)),xz.y,landContinuumGround(p).x);
}
`;
}

// --------------------------------------------------------------------------------------------- the drawing
// Appended to the land's own module (js/wgsl/terrain.js), whose surface it shades with.
export const LAND_CONTINUUM_RENDER = landContinuumData(2, 50, 'read') + LAND_CONTINUUM_HEIGHT + LAND_BANK_WGSL + /* wgsl */`
// A river's banks (js/wgsl/land-banks.js), then the pits shot has dug in them (LAND_CRATER_PIT in
// js/wgsl/land-craters.js). Dug ground never goes under the water.
fn landContinuumRelief(xz:vec2f,h:f32)->f32 { let hb=h+landBankAt(xz).x;return max(hb+landCraterDepth(xz),min(hb,0.01)); }
// The banks are worked out to their own cell, so the points finer than it wait only for the pits.
fn landContinuumDug(xz:vec2f,level:u32)->f32 { return max(landCraterWaits(xz),select(0.0,landBankWaits(xz),level>=${LAND_BANK_LEVEL}u)); }
fn landContinuumVertex(vertex:u32,node:u32,pixels:f32)->LandVertex {
  let at=node*${LAND_CONTINUUM_NODE_WORDS}u;
  let corner=vec2i(i32(landNodes[at+6u]),i32(landNodes[at+7u]));
  let stride=1<<landNodes[at+8u];let c=landNodes[at+9u];
  let p=corner+vec2i(i32(vertex%(c+1u)),i32(vertex/(c+1u)))*stride;
  let xz=landContinuumXZ(p);
  var o:LandVertex;
  o.world=vec3f(xz.x,landContinuumHeight(p,pixels),xz.y);
  // The lattice's slope, and the banks' across their own cell.
  let bank=landBankAt(xz);let e=${(LAND_BANK_CELL_M).toFixed(3)};
  let slope=vec2f(landBankAt(xz-vec2f(e,0.0)).x-landBankAt(xz+vec2f(e,0.0)).x,landBankAt(xz-vec2f(0.0,e)).x-landBankAt(xz+vec2f(0.0,e)).x)/(2.0*e);
  let lattice=landContinuumNormal(p);
  o.normal=normalize(vec3f(lattice.x/lattice.y+slope.x,1.0,lattice.z/lattice.y+slope.y));
  let n=landPiece.near;
  // Bank where the banks cover the ground, wet as they are; else the lattice's own kind.
  o.kind=select(vec2f(select(0.0,1.0,xz.x>=n.x&&xz.x<=n.y&&xz.y>=n.z&&xz.y<=n.w),landContinuumGround(p).y),vec2f(2.0,bank.z),bank.y>0.5);
  o.leafUV=vec2f(0.0);
  o.pos=F.viewProj*vec4f(earthCurve(o.world+landContinuumShift()-F.camPos.xyz,F.camPos.y),1.0);
  return o;
}
@vertex fn landContinuumVS(@builtin(vertex_index) vertex:u32,@location(0) node:u32)->LandVertex { return landContinuumVertex(vertex,node,landView.scene.x); }
// The water's captures draw the coarser cut, morphed at its own pixel error.
@vertex fn landContinuumCaptureVS(@builtin(vertex_index) vertex:u32,@location(0) node:u32)->LandVertex { return landContinuumVertex(vertex,node,landView.scene.y); }
// One shading for all land, dug or not: the pit lights what it reaches and leaves the rest plain.
@fragment fn landContinuumFS(in:LandVertex)->@location(0) vec4f{
  let dx=dpdx(in.world);let dy=dpdy(in.world);
  return landSurface(in,landCraterPit(in.world,normalize(in.normal),dx,dy));
}
`;
