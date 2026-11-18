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
//
// The cut publishes the ground it draws (js/continuum-ground.js): every patch it keeps names the field's tiles it
// covers, and a pass then writes each of their texels with how far the patch's morphed triangles lie there from the
// true ground (landGroundWrite), the same walk the drawing takes.
import { FRAME_WGSL } from './common.js';
import { CONTINUUM_CORE_WGSL } from '../continuum-core.js';
import { CONTINUUM_GROUND_PLACE_WGSL, CONTINUUM_GROUND_TEXELS, CONTINUUM_GROUND_LEVELS, CONTINUUM_GROUND_CUTS, CONTINUUM_GROUND_TILE } from '../continuum-ground.js';
import { LAND_BANK_WGSL, LAND_BANK_LEVEL, LAND_BANK_CELL_M } from './land-banks.js';
import { LAND_CRATER_GROUND } from './land-craters.js';
import { withCapturedAir } from '../water-optics.js';

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
// The drawn ground's field (js/continuum-ground.js): its tiles a side in a level, and the most tiles a piece's patches
// can name in one frame: the most workgroups one dispatch holds, near three times every level of both cuts whole, as
// a tile across patches' edges is named by each. A tile names its patch, then its cut, level and place.
export const LAND_GROUND_TILES = CONTINUUM_GROUND_TEXELS / CONTINUUM_GROUND_TILE;
export const LAND_GROUND_ROOM = 65535;
// Words a slot of the field's work: the workgroups its pass dispatches, x y z.
export const LAND_GROUND_WORK_WORDS = 3;
const LAND_GROUND_BITS = Math.ceil(Math.log2(LAND_GROUND_TILES));
if (LAND_GROUND_ROOM > 65535 || CONTINUUM_GROUND_LEVELS > 16 || 5 + 2 * LAND_GROUND_BITS > 32) throw new Error('The drawn ground field does not fit its tiles\' words');

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
// Where a point of the piece is, from the grid the pieces share, so that two pieces place a shared point alike: the
// grid unit is exact, a whole number and a few binary places.
fn landContinuumXZ(p:vec2i)->vec2f {
  let g=vec2f(landPiece.place.xy)+ldexp(vec2f(p),vec2i(landPiece.place.z));
  return landPiece.grid.xy+g*landPiece.grid.z;
}
`;
}

// --------------------------------------------------------------------------------------------- the cut
export function landContinuumCutWGSL() {
  const S = LAND_CONTINUUM_SLOTS, L = LAND_CONTINUUM_LISTS, W = LAND_CONTINUUM_NODE_WORDS;
  const { firsts, counts } = landContinuumIndices();
  const T = CONTINUUM_GROUND_TILE, R = CONTINUUM_GROUND_TEXELS;
  return FRAME_WGSL + CONTINUUM_CORE_WGSL + CONTINUUM_GROUND_PLACE_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
` + landContinuumData(0, 1, 'read') + /* wgsl */`
@group(0) @binding(5) var<storage,read_write> landLists:array<u32>;
@group(0) @binding(6) var<storage,read_write> landDraws:array<atomic<u32>>;
// The drawn ground's field (js/continuum-ground.js): the piece's tiles to write, and every slot's workgroups.
@group(0) @binding(7) var<storage,read_write> landGroundTiles:array<vec2u>;
@group(0) @binding(8) var<storage,read_write> landGroundWork:array<atomic<u32>>;
// Every list emptied, its index count and first index set; every slot's field work emptied.
@compute @workgroup_size(64) fn landContinuumReset(@builtin(global_invocation_id) id:vec3u){
  if(id.x<${S * LAND_GROUND_WORK_WORDS}u){atomicStore(&landGroundWork[id.x],select(1u,0u,id.x%${LAND_GROUND_WORK_WORDS}u==0u));}
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
// The tiles of each level of the field whose texels' centres a kept patch may hold (a texel more each way: the write
// decides which patch holds a texel on an edge, half open, and only that one writes it), but those no point reads at
// that level. A tile holding several patches' texels is named by each, and each writes its own.
fn landGroundTileRange(level:u32,lo:vec2f,hi:vec2f,eye:vec2f)->vec4i {
  let spacing=continuumGroundSpacing(level);let origin=continuumGroundOrigin(level,eye);
  let first=clamp(vec2i(ceil((lo-origin)/spacing-0.5))-vec2i(1),vec2i(0),vec2i(${R}));
  let last=clamp(vec2i(ceil((hi-origin)/spacing-0.5))+vec2i(1),vec2i(0),vec2i(${R}));
  if(any(last<=first)){return vec4i(0,0,-1,-1);}
  return vec4i(first/${T},(last-vec2i(1))/${T});
}
fn landGroundTileRead(level:u32,tile:vec2i,eye:vec2f)->bool {
  let spacing=continuumGroundSpacing(level);let origin=continuumGroundOrigin(level,eye);
  let a=origin+(vec2f(tile*${T})+0.5)*spacing-eye;let b=a+${(T - 1).toFixed(1)}*spacing;
  return max(max(abs(a.x),abs(b.x)),max(abs(a.y),abs(b.y)))>=continuumGroundUnread(level);
}
fn landGroundEmit(cut:u32,node:u32){
  let at=node*${W}u;
  let corner=vec2i(i32(landNodes[at+6u]),i32(landNodes[at+7u]));
  let extent=i32(landNodes[at+9u])<<landNodes[at+8u];
  let shift=landContinuumShift().xz;let eye=F.camPos.xz;
  let lo=landContinuumXZ(corner)+shift;let hi=landContinuumXZ(corner+vec2i(extent))+shift;
  let work=landPiece.lists.x*${LAND_GROUND_WORK_WORDS}u;
  for(var level=0u;level<CONTINUUM_GROUND_LEVELS;level++){
    let range=landGroundTileRange(level,lo,hi,eye);
    var count=0u;
    for(var z=range.y;z<=range.w;z++){for(var x=range.x;x<=range.z;x++){if(landGroundTileRead(level,vec2i(x,z),eye)){count++;}}}
    if(count==0u){continue;}
    var slot=atomicAdd(&landGroundWork[work],count);
    if(slot+count>${LAND_GROUND_ROOM}u){atomicSub(&landGroundWork[work],count);return;}
    for(var z=range.y;z<=range.w;z++){for(var x=range.x;x<=range.z;x++){
      if(!landGroundTileRead(level,vec2i(x,z),eye)){continue;}
      landGroundTiles[slot]=vec2u(node,cut|(level<<1u)|(u32(x)<<5u)|(u32(z)<<${5 + LAND_GROUND_BITS}u));slot++;
    }}
  }
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
  if(continuumClusterDrawn(error,near,own.w,upError,up.xyz-eye,up.w,focal,landView.scene.x)){landContinuumAppend(0u,list,node);landGroundEmit(0u,node);}
  if(continuumClusterDrawn(error,near,own.w,upError,up.xyz-eye,up.w,focal,landView.scene.y)){landContinuumAppend(1u,list,node);landGroundEmit(1u,node);}
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
// The lattice's ground between its points, at q in finest units: landContinuumGround at any place, not only a point.
// Across the survey's far rim the piece's own cell, as the drawing has it there.
fn landContinuumGroundAt(q:vec2f)->f32 {
  let p=clamp(vec2i(floor(q)),vec2i(0),vec2i((1<<u32(landPiece.place.w))-1));
  var cell=landContinuumCell(p);var lo=p-(p&vec2i(cell-1));
  if(landContinuumWindowed(p)&&!landContinuumWindowed(lo+vec2i(cell))){cell=1<<landPiece.base.y;lo=p-(p&vec2i(cell-1));}
  let f=clamp((q-vec2f(lo))/f32(cell),vec2f(0.0),vec2f(1.0));
  let h00=landContinuumPoint(lo).x;let h10=landContinuumPoint(lo+vec2i(cell,0)).x;
  let h01=landContinuumPoint(lo+vec2i(0,cell)).x;let h11=landContinuumPoint(lo+vec2i(cell)).x;
  return select(h11+(1.0-f.x)*(h01-h11)+(1.0-f.y)*(h10-h11),h00+f.x*(h10-h00)+f.y*(h01-h00),f.x+f.y<=1.0);
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
// A square of the walk down from the piece's corners: its least corner and side in finest units, and its corners'
// true and drawn heights, numbered x + 2z.
struct LandContinuumSquare { lo:vec2i, size:i32, truth:array<f32,4>, drawn:array<f32,4> };
fn landContinuumRoot()->LandContinuumSquare {
  let size=1<<u32(landPiece.place.w);
  let truth=array<f32,4>(landContinuumTrue(vec2i(0)).x,landContinuumTrue(vec2i(size,0)).x,landContinuumTrue(vec2i(0,size)).x,landContinuumTrue(vec2i(size)).x);
  return LandContinuumSquare(vec2i(0),size,truth,truth);
}
// One step down the walk, into the square's quadrant q: the points that level brings in, each morphed.
fn landContinuumQuarter(s:ptr<function,LandContinuumSquare>,q:vec2u,eye:vec3f,focal:f32,pixels:f32){
  let lo=(*s).lo;let size=(*s).size;let half=size/2;
  var truth=(*s).truth;var drawn=(*s).drawn;
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
  (*s).truth=truth;(*s).drawn=drawn;(*s).lo=lo+vec2i(q)*half;(*s).size=half;
}
// The height drawn at a lattice point, walking down from the piece's corners.
fn landContinuumHeight(p:vec2i,pixels:f32)->f32 {
  let focal=landContinuumFocal();
  let eye=F.camPos.xyz-landContinuumShift();
  var s=landContinuumRoot();
  for(var step=0;step<30;step++){
    let r=p-s.lo;let size=s.size;
    if((r.x==0||r.x==size)&&(r.y==0||r.y==size)){return s.drawn[u32(r.x/size)+2u*u32(r.y/size)];}
    landContinuumQuarter(&s,vec2u(select(vec2i(0),vec2i(1),r>=vec2i(size/2))),eye,focal,pixels);
  }
  return s.drawn[0];
}
// The height drawn at any place q (finest units) of a patch of 'stride': the same walk, down to the patch's cell that
// holds q, then that cell's triangle there, split as the patches' index buffer splits it.
fn landContinuumDrawnAt(q:vec2f,stride:i32,pixels:f32)->f32 {
  let focal=landContinuumFocal();
  let eye=F.camPos.xyz-landContinuumShift();
  var s=landContinuumRoot();
  for(var step=0;step<30&&s.size>stride;step++){
    landContinuumQuarter(&s,select(vec2u(0u),vec2u(1u),q-vec2f(s.lo)>=vec2f(f32(s.size/2))),eye,focal,pixels);
  }
  let f=clamp((q-vec2f(s.lo))/f32(s.size),vec2f(0.0),vec2f(1.0));
  let d=s.drawn;
  return select(d[3]+(1.0-f.x)*(d[2]-d[3])+(1.0-f.y)*(d[1]-d[3]),d[0]+f.x*(d[1]-d[0])+f.y*(d[2]-d[0]),f.x+f.y<=1.0);
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

// --------------------------------------------------------------------------------------------- the drawn ground
// The field of the ground the cut draws (js/continuum-ground.js), after the cut: every texel emptied, then each tile
// a kept patch named written where that patch holds it, with how far its morphed triangles there lie from the true
// ground. Group 0 the frame and the field; group 2 the piece's own data as the drawing binds it (50 to 53), the
// craters' and banks' (54 to 61), and the tiles the cut named (62).
export function landGroundWriteWGSL() {
  const T = CONTINUUM_GROUND_TILE, W = LAND_CONTINUUM_NODE_WORDS, B = LAND_GROUND_BITS;
  return FRAME_WGSL + CONTINUUM_CORE_WGSL + CONTINUUM_GROUND_PLACE_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var landGroundOut:texture_storage_2d_array<r32float,write>;
` + landContinuumData(2, 50, 'read') + /* wgsl */`
@group(2) @binding(62) var<storage,read> landGroundTiles:array<vec2u>;
` + LAND_CRATER_GROUND + LAND_CONTINUUM_HEIGHT + LAND_CONTINUUM_RELIEF + /* wgsl */`
// Where no patch is kept the land draws nothing, and nothing stands lifted.
@compute @workgroup_size(8,8) fn landGroundClear(@builtin(global_invocation_id) id:vec3u){
  textureStore(landGroundOut,vec2i(id.xy),i32(id.z),vec4f(0.0));
}
@compute @workgroup_size(${T},${T}) fn landGroundWrite(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) local:vec3u){
  let tile=landGroundTiles[group.x];
  let at=tile.x*${W}u;let cut=tile.y&1u;let level=(tile.y>>1u)&15u;
  let texel=vec2i(i32((tile.y>>5u)&${LAND_GROUND_TILES - 1}u),i32(tile.y>>${5 + B}u))*${T}+vec2i(local.xy);
  let xz=continuumGroundOrigin(level,F.camPos.xz)+(vec2f(texel)+0.5)*continuumGroundSpacing(level)-landContinuumShift().xz;
  // The texel's place in the piece's finest units; the patch holds it half open, so a texel on an edge has one.
  let q=ldexp((xz-landPiece.grid.xy)/landPiece.grid.z-vec2f(landPiece.place.xy),vec2i(-landPiece.place.z));
  let corner=vec2i(i32(landNodes[at+6u]),i32(landNodes[at+7u]));
  let stride=1<<landNodes[at+8u];let far=corner+vec2i(i32(landNodes[at+9u])*stride);
  if(any(q<vec2f(corner))||any(q>=vec2f(far))){return;}
  let drawn=landContinuumDrawnAt(q,stride,select(landView.scene.x,landView.scene.y,cut==1u));
  let truth=landContinuumRelief(xz,landContinuumGroundAt(q));
  textureStore(landGroundOut,texel,i32(cut*CONTINUUM_GROUND_LEVELS+level),vec4f(drawn-truth,0.0,0.0,0.0));
}
`;
}

// --------------------------------------------------------------------------------------------- the drawing
// Appended to the land's own module (js/wgsl/terrain.js), whose surface it shades with.
// What lies on the lattice wherever the land is worked out: a river's banks (js/wgsl/land-banks.js), then the pits
// shot has dug in them (LAND_CRATER_GROUND in js/wgsl/land-craters.js). Dug ground never goes under the water.
const LAND_CONTINUUM_RELIEF = LAND_BANK_WGSL + /* wgsl */`
fn landContinuumRelief(xz:vec2f,h:f32)->f32 { let hb=h+landBankAt(xz).x;return max(hb+landCraterDepth(xz),min(hb,0.01)); }
// The banks are worked out to their own cell, so the points finer than it wait only for the pits.
fn landContinuumDug(xz:vec2f,level:u32)->f32 { return max(landCraterWaits(xz),select(0.0,landBankWaits(xz),level>=${LAND_BANK_LEVEL}u)); }
`;
export const LAND_CONTINUUM_RENDER = landContinuumData(2, 50, 'read') + LAND_CONTINUUM_HEIGHT + LAND_CONTINUUM_RELIEF + /* wgsl */`
fn landContinuumVertex(vertex:u32,node:u32,coarse:bool)->LandVertex {
  // The water's captures draw the coarser cut, morphed at its own pixel error.
  let pixels=select(landView.scene.x,landView.scene.y,coarse);
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
// One shading for all land, dug or not: the pit lights what it reaches and leaves the rest plain.
fn landContinuumShade(in:LandVertex)->vec4f{
  let dx=dpdx(in.world);let dy=dpdy(in.world);
  return landSurface(in,landCraterPit(in.world,normalize(in.normal),dx,dy));
}
`;

// The land as a material of the one family's programs (continuumModuleWGSL in js/wgsl/continuum-cut.js), a
// heightfield: its view and its under-water capture, composed over the land's own shading (`landSource`, js/wgsl/
// terrain.js), whose air the capture leaves to the water's surface (withCapturedAir).
export function landContinuumMaterial(landSource) {
  const captured = withCapturedAir(landSource);
  return Object.freeze({
    name: 'landContinuum', heightfield: true, varying: 'LandVertex', entryLayout: LAND_CONTINUUM_ENTRY_LAYOUT,
    prelude: (pass) => (pass === 'capture' ? captured : landSource), core: true, wgsl: () => LAND_CONTINUUM_RENDER,
    cullMode: 'none', capture: true,
  });
}
