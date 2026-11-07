// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the land is made of when you stand on it. The land mesh is 16 m between vertices and its colour 8 m a
// texel, so up close grass, soil, sand and rock would be one smooth wash. One tiling texture, baked by a compute
// pass when the land loads and never written again, holds a height for each, and the land shader reads it at a
// few sizes. Its mips do the filtering, so nothing here can alias however the camera moves:
//   r  blades of grass: dark soil between them, tips the brightest
//   g  grit and pebbles of three sizes, each with a little shadow around it
//   b  rock: plates split by cracks, finer ones inside them
//   a  plain fractal noise, for tonal patches at the large size and speckle at the small one
// Every channel averages GROUND_DETAIL_MEAN at every mip, so subtracting that leaves a signal that is zero on
// average. Ground that has gone to a flat mip, or past the distance cut, is the colour it would have been anyway.
import { NOISE_WGSL, PERIODIC_WGSL } from './common.js';

export const GROUND_DETAIL_SIZE = 1024;
// Past this the land pays for none of it, not one fetch.
export const GROUND_DETAIL_CUT_M = 240;
export const GROUND_DETAIL_FADE_M = 150;
// The smallest size stops being read here. Its blades are under a pixel long before.
export const GROUND_DETAIL_FINE_CUT_M = 34;
export const GROUND_DETAIL_FINE_FADE_M = 18;
// What each channel averages at its top mip, measured from the bake and held by a test.
export const GROUND_DETAIL_MEAN = Object.freeze([.388, .388, .507, .502]);
const MEAN = `vec4f(${GROUND_DETAIL_MEAN.join(',')})`;

export const GROUND_DETAIL_BAKE = NOISE_WGSL + PERIODIC_WGSL + /* wgsl */ `
@group(0)@binding(0) var detailOut:texture_storage_2d<rgba8unorm,write>;
const TAU=6.28318530718;
fn detailHash(cell:vec2i,period:i32,seed:u32)->vec4f{
  let c=((cell%period)+period)%period;
  let a=pcgHash(u32(c.x)+u32(c.y)*u32(period)+seed*7919u);
  let b=pcgHash(a);
  return vec4f(f32(a&65535u),f32(a>>16u),f32(b&65535u),f32(b>>16u))/65535.0;
}
// The tallest blade over this point, with its height falling from tip to root and from spine to edge.
// The grass's lay (which way it leans here) turns slowly across the tile, and each blade strays a long way from it.
fn detailBlades(uv:vec2f,lay:f32,cells:i32,seed:u32,long:f32,wide:f32,straying:f32)->f32{
  let q=uv*f32(cells);let base=vec2i(floor(q));
  let reach=i32(ceil(long));
  var best=0.0;
  for(var j=-reach;j<=reach;j++){for(var i=-reach;i<=reach;i++){
    let cell=base+vec2i(i,j);
    let r=detailHash(cell,cells,seed);
    let s=detailHash(cell,cells,seed+1u);
    let root=vec2f(cell)+r.xy;
    let angle=lay+(r.z-.5)*straying;
    let along=vec2f(cos(angle),sin(angle));
    let side=vec2f(-along.y,along.x);
    let rel=q-root;
    let size=long*(.55+.45*r.w);
    let t=clamp(dot(rel,along)/size,0.0,1.0);
    let bend=(s.x-.5)*.9*size*t*t;
    let off=dot(rel,side)-bend;
    let past=dot(rel,along)-t*size;
    let halfWidth=wide*(1.0-t*t*.82);
    let d=sqrt(off*off+past*past);
    if(d>=halfWidth){continue;}
    let spine=1.0-d/halfWidth;
    best=max(best,(.38+.62*t)*(.72+.28*spine)*(.55+.45*s.y)*smoothstep(0.0,.28,spine));
  }}
  return best;
}
// Round stones scattered on a jittered grid: their height over the point (x), a dark ring on the ground around
// each (y), and a tone of their own (z).
fn detailStones(uv:vec2f,cells:i32,seed:u32,chance:f32,least:f32,most:f32)->vec3f{
  let q=uv*f32(cells);let base=vec2i(floor(q));
  var height=0.0;var ring=0.0;var tone=.5;
  for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){
    let cell=base+vec2i(i,j);
    let r=detailHash(cell,cells,seed);
    if(r.w>chance){continue;}
    let s=detailHash(cell,cells,seed+1u);
    let centre=vec2f(cell)+.5+(r.xy-.5)*.7;
    let rel=q-centre;
    let c=cos(r.z*TAU);let k=sin(r.z*TAU);
    let turned=vec2f(rel.x*c-rel.y*k,(rel.x*k+rel.y*c)/(.68+.32*s.x));
    let angle=atan2(turned.y,turned.x);
    let radius=mix(least,most,s.y)*(1.0+.14*sin(angle*3.0+s.z*9.0)+.07*sin(angle*5.0+s.w*7.0));
    let at=length(turned)/radius;
    ring=max(ring,1.0-smoothstep(.95,1.55,at));
    if(at<1.0){
      let dome=sqrt(1.0-at*at);
      if(dome>height){height=dome;tone=s.z;}
    }
  }}
  return vec3f(height,ring,tone);
}
// Distance to the nearest crack, and a tone for the plate.
fn detailPlates(uv:vec2f,cells:i32,seed:u32)->vec2f{
  let wander=vec2f(pnoise(uv*7.0,7),pnoise(uv*7.0+vec2f(3.1,5.7),7))*.09+vec2f(pnoise(uv*31.0,31),pnoise(uv*31.0+vec2f(1.7,9.2),31))*.018;
  let q=(uv+wander)*f32(cells);let base=vec2i(floor(q));
  var nearest=9.0;var second=9.0;var tone=0.0;
  for(var j=-1;j<=1;j++){for(var i=-1;i<=1;i++){
    let cell=base+vec2i(i,j);
    let r=detailHash(cell,cells,seed);
    let d=length(vec2f(cell)+.5+(r.xy-.5)*.9-q);
    if(d<nearest){second=nearest;nearest=d;tone=r.z;}else if(d<second){second=d;}
  }}
  return vec2f(second-nearest,tone);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  let uv=(vec2f(id.xy)+.5)/${GROUND_DETAIL_SIZE}.0;
  // Grass: fine blades and longer leaves over dark soil, in tufts that rise and fall.
  let tuft=.5+pfbm(uv*21.0,21,4)*1.25;
  let lay=pfbm(uv*5.0,5,2)*4.0;
  let fineBlade=detailBlades(uv,lay,172,11u,3.0,.17,3.4);
  let leaf=detailBlades(uv,lay+1.3,61,23u,2.6,.11,3.0);
  let soilGrain=pfbm(uv*96.0,96,3);
  let bladeHeight=max(fineBlade,leaf*.92)*mix(.5,1.2,clamp(tuft,0.0,1.0));
  let grass=mix(.1+soilGrain*.1,.28+bladeHeight*.86,smoothstep(0.0,.16,bladeHeight));
  // Grit: three sizes of stone over gritty ground.
  let small=detailStones(uv,288,41u,.72,.26,.44);
  let middle=detailStones(uv,118,53u,.42,.2,.42);
  let large=detailStones(uv,47,67u,.26,.22,.44);
  var grit=.36+pfbm(uv*128.0,128,3)*.34;
  grit-=max(small.y*.09,max(middle.y*.14,large.y*.2));
  grit=mix(grit,(.3+.42*small.z)*(.55+.45*small.x),smoothstep(0.0,.22,small.x));
  grit=mix(grit,(.34+.5*middle.z)*(.5+.5*middle.x),smoothstep(0.0,.2,middle.x));
  grit=mix(grit,(.36+.56*large.z)*(.46+.54*large.x),smoothstep(0.0,.16,large.x));
  // Rock: plates, cracks between them, finer cracks across them, and a grain to the stone.
  let plate=detailPlates(uv,11,71u);
  let shard=detailPlates(uv,37,83u);
  let crack=max(1.0-smoothstep(.012,.05,plate.x),(1.0-smoothstep(.012,.06,shard.x))*.62);
  let rock=(.56+(plate.y-.5)*.22+(shard.y-.5)*.1+pfbm(uv*48.0,48,4)*.3)*(1.0-.82*crack);
  // Patches and speckle.
  let patches=.5+pfbm(uv*3.0,3,7)*1.05+(pnoise(uv*256.0,256)+pnoise(uv*411.0,411)*.8)*.34;
  textureStore(detailOut,id.xy,vec4f(grass,grit,rock,patches));
}
`;

// What a fragment of ground reads, all of it zero on average. fine is zero past its own cut, and everything is
// zero, and nothing fetched, past the whole cut. landDetailWeight's rule holds here too: mips remove what a pixel
// cannot hold, so a smoothstep over these values never makes more than the texture does.
export const GROUND_DETAIL_RENDER = /* wgsl */ `
@group(0)@binding(16) var groundDetailTexture:texture_2d<f32>;
@group(0)@binding(17) var groundDetailSampler:sampler;
struct GroundDetail{
  near:f32,
  closeBy:f32,
  fine:vec4f,
  mid:vec4f,
  big:vec4f,
};
// Each size is turned by a right-triangle rotation, so it comes back on itself after a whole number of tiles along
// world x and z. Wrapping first keeps the coordinate small enough to hold a texel far from the origin.
fn groundDetailTexel(p:vec2f,dx:vec2f,dy:vec2f,turn:vec2f,tile:f32,wrap:f32,shift:vec2f)->vec4f{
  let m=mat2x2f(turn.x,turn.y,-turn.y,turn.x);
  let at=p-wrap*floor(p/wrap);
  return textureSampleGrad(groundDetailTexture,groundDetailSampler,(m*at+shift)/tile,m*dx/tile,m*dy/tile)-${MEAN};
}
fn groundDetailAt(world:vec3f,dx:vec3f,dy:vec3f,wander:vec2f,wanderFine:vec2f)->GroundDetail{
  var d=GroundDetail(0.0,0.0,vec4f(0.0),vec4f(0.0),vec4f(0.0));
  let away=distance(world+vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z),F.camPos.xyz);
  if(away>=${GROUND_DETAIL_CUT_M}.0){return d;}
  d.near=1.0-smoothstep(${GROUND_DETAIL_FADE_M}.0,${GROUND_DETAIL_CUT_M}.0,away);
  // The largest size only ever says what sort of patch this is. Read it blurred, so its speckle stays out of that.
  d.big=groundDetailTexel(world.xz,dx.xz+vec2f(.6,0.0),dy.xz+vec2f(0.0,.6),vec2f(15.0,-8.0)/17.0,67.3,17.0*67.3,vec2f(0.0))*d.near;
  // Slow noise that never repeats slides the smaller sizes about, so their repeats cannot line up.
  d.mid=groundDetailTexel(world.xz,dx.xz,dy.xz,vec2f(12.0,5.0)/13.0,16.7,13.0*16.7,wander*2.0)*d.near;
  if(away<${GROUND_DETAIL_FINE_CUT_M}.0){
    d.closeBy=1.0-smoothstep(${GROUND_DETAIL_FINE_FADE_M}.0,${GROUND_DETAIL_FINE_CUT_M}.0,away);
    d.fine=groundDetailTexel(world.xz,dx.xz,dy.xz,vec2f(4.0,3.0)/5.0,4.1,5.0*4.1,wanderFine*.7)*d.closeBy;
  }
  return d;
}
// One ground gives way to the next along its blades and stones rather than in a blend: w becomes how much of the
// ground it covers, so from further off the mean is what the blend was. The break-up works only between the two, so
// it cannot start rock on a lawn, and near decides how much of this there is.
fn groundDetailEdge(w:f32,breakup:f32,near:f32)->f32{
  if(near<=0.0){return w;}
  return mix(w,smoothstep(-.06,.06,w-.5+breakup*2.5*min(1.0,8.0*w*(1.0-w))),near);
}
struct GroundLook{albedo:vec3f,relief:f32};
// Bedding runs level round a slope, so rock is read off a world-true face with its plates drawn out along the level.
fn groundDetailStrata(world:vec3f,n:vec3f,dx:vec3f,dy:vec3f)->f32{
  let bias=abs(n.z)-abs(n.x);
  let along=select(world.z,world.x,bias>0.0);
  let alongX=select(dx.z,dx.x,bias>0.0);
  let alongY=select(dy.z,dy.x,bias>0.0);
  let stretch=vec2f(.2,1.0)/5.3;
  let wrap=5.3/.2;
  let at=vec2f((along-wrap*floor(along/wrap))*stretch.x,world.y*stretch.y);
  let s=textureSampleGrad(groundDetailTexture,groundDetailSampler,at,vec2f(alongX,dx.y)*stretch,vec2f(alongY,dy.y)*stretch).b-${GROUND_DETAIL_MEAN[2]};
  return s*smoothstep(0.0,.08,abs(bias));
}
// Grass, soil, sand and rock from the same few fetches. Colour is scaled about its own value by a signal that is
// zero on average, so from further off, as the mips flatten, each ground is just the colour it already was.
fn groundDetailLook(d:GroundDetail,base:vec3f,world:vec3f,n:vec3f,dx:vec3f,dy:vec3f,grass:f32,sand:f32,rock:f32,cliff:f32,scree:f32,canopy:f32,wetSand:f32)->GroundLook{
  let slope=1.0-n.y;
  // Green ground is grass, whatever else the cover makes of it, right down to a low shore.
  let top=max(base.r,max(base.g,base.b));
  let cover=max(grass,smoothstep(.05,.22,(base.g-max(base.r,base.b))/max(top,.02)));
  let midGain=mix(1.0,.55,d.closeBy);
  let patches=d.big.a*1.05+d.mid.a*.55;
  let grit=d.fine.g*1.0+d.mid.g*midGain+d.big.g*.35;
  // A normal needs its bump a few pixels across, or the slope between neighbouring pixels flickers as the view moves.
  // Colour holds a pattern far beyond where its normals may. Past these footprints it is colour alone.
  let footprint=max(length(dx),length(dy));
  let fineBump=1.0-smoothstep(.003,.012,footprint);
  let midBump=(1.0-smoothstep(.012,.05,footprint))*midGain;
  let gritRelief=d.fine.g*.003*fineBump+d.mid.g*.01*midBump+d.big.g*.016;
  // Grass: blades over patches of richer and drier growth, thinning to bare soil where the patches run low.
  let blades=d.fine.r*1.15+d.mid.r*midGain+d.big.r*.5;
  let bladeRelief=d.fine.r*.002*fineBump+d.mid.r*.006*midBump+d.big.r*.012;
  let bareAt=d.fine.a*1.3+d.mid.a*.5-d.big.a*.5-.26+smoothstep(.03,.2,slope)*.3-blades*.2;
  let bare=smoothstep(-.03,.03,bareAt)*d.near;
  let soil=vec3f(.053,.047,.039)*(1.0+patches*.5);
  let grey=dot(base,vec3f(.2126,.7152,.0722));
  let leafBase=mix(base,vec3f(grey),.14*d.near);
  // Tips catch the light yellow; between the blades it is simply dark. Dry patches go straw, rich ones deep.
  let lit=1.0+max(blades,0.0)*vec3f(1.85,1.05,.4)+min(blades,0.0)*vec3f(1.15,1.15,1.15);
  let grown=1.0+max(patches,0.0)*vec3f(1.3,.45,-.3)+min(patches,0.0)*vec3f(.9,.65,.8);
  let growth=max(leafBase*lit*grown,vec3f(0.0));
  let turf=mix(growth,soil*(1.0+grit*2.4),bare);
  // Bare ground: grit and stones on its own colour.
  let ground=base*(1.0+grit*1.35+patches*.4);
  var albedo=mix(ground,turf,cover);
  var relief=mix(gritRelief,mix(bladeRelief,gritRelief,bare),cover);
  // Loose stone below a face: the larger stones stand out and grass keeps to the gaps.
  if(scree>.01){
    let stones=d.mid.g*1.5+d.fine.g*.6;
    albedo=mix(albedo,base*(1.0+stones*1.5+patches*.4),scree*.8*(1.0-rock));
    relief=mix(relief,d.mid.g*.03*midBump+d.fine.g*.005*fineBump,scree*.8*(1.0-rock));
  }
  // Rock: strata and cracks that follow the slope. Only rock pays for the fourth fetch.
  if(rock>.01){
    let strata=groundDetailStrata(world,n,dx,dy)*d.near;
    let crack=d.mid.b*.7+d.fine.b*.8+d.big.b*.5;
    let face=strata*mix(.3,1.0,cliff);
    albedo=mix(albedo,base*(1.0+crack*1.1+face*1.3+patches*.35),rock);
    relief=mix(relief,(d.mid.b*.7*midBump+d.fine.b*.8*fineBump+d.big.b*.5)*.018+face*.04,rock);
  }
  // Sand: fine grain and wind ripples. Wet sand is smooth and dark, and holds neither.
  if(sand>.01){
    let dry=1.0-wetSand;
    let grain=d.fine.a*2.2+d.mid.a*.8+d.fine.g*.3;
    let k=vec2f(40.0,27.0);
    let cycles=length(vec2f(dot(dx.xz,k),dot(dy.xz,k)))/6.28318530718;
    let flat=1.0-smoothstep(.04,.12,slope);
    let rippled=landDetailWeight(cycles)*flat*dry*smoothstep(-.1,.1,d.big.a+.03)*d.near;
    var ripple=0.0;
    if(rippled>0.0){
      let wave=sin(dot(world.xz,k)+d.big.a*34.0+d.mid.a*11.0);
      ripple=wave*(.65+.35*wave)*rippled;
    }
    // A little sand hides the stones as well as a lot does.
    let sandy=smoothstep(.02,.4,sand);
    albedo=mix(albedo,base*(1.0+grain*mix(.16,.34,dry)+patches*.12+ripple*.07),sandy);
    relief=mix(relief,(d.fine.a*.0015*fineBump+ripple*.0012*(1.0-smoothstep(.01,.06,footprint)))*dry,sandy);
  }
  return GroundLook(albedo,relief);
}
`;
