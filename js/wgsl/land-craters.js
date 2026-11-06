// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ground a ball has dug up. The land mesh is 16 m between vertices and cannot hold a pit a pace across, so
// damaged ground is drawn again over it from fine tiles held in two texture arrays:
//  - the ground as it was, rasterized from the land's own triangles once, when a tile first comes into use;
//  - what has been done to it, worked out from every crater near the tile, whenever a shot lands there.
// Drawing them costs JavaScript nothing. See js/land-craters.js for what is written when.
import { NOISE_WGSL } from './common.js';

export const LAND_CRATER_TILE_M = 8;
export const LAND_CRATER_CELLS = 64;
export const LAND_CRATER_CELL_M = LAND_CRATER_TILE_M / LAND_CRATER_CELLS;
// A shadow is followed this far past a tile's edge, so one falling across a seam does not stop at it.
export const LAND_CRATER_GUTTER = 8;
export const LAND_CRATER_TEXELS = LAND_CRATER_CELLS + 1 + 2 * LAND_CRATER_GUTTER;
export const LAND_CRATER_DRAWN_CELLS = LAND_CRATER_CELLS + 2;
export const LAND_CRATER_PER_TILE = 32;
// How far a crater's spoil reaches at most, in crater radii, before a flat shot draws it out.
export const LAND_CRATER_REACH = 3.05;
const CELL = LAND_CRATER_CELL_M.toFixed(4);
const GUTTER = LAND_CRATER_GUTTER.toFixed(1);
const TEXELS = LAND_CRATER_TEXELS.toFixed(1);

// What the land was here, in its own triangles: height above the tile's floor, normal x and z, and kind in the
// whole and fractional parts. Nothing is written where the land has no triangles, and that stays below zero.
export const LAND_CRATER_CAPTURE = /* wgsl */ `
struct LandCraterCapture{@builtin(position) pos:vec4f,@location(0) y:f32,@location(1) normal:vec3f,@location(2) kind:vec2f,@location(3) @interpolate(flat) floorY:f32};
@vertex fn landCraterCaptureVS(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f,@location(3) tile:vec4f)->LandCraterCapture{
  let texel=(position.xz-tile.xy)/${CELL}+${GUTTER}+.5;
  let at=texel/${TEXELS}*2.0-1.0;
  return LandCraterCapture(vec4f(at.x,-at.y,.5,1.0),position.y,normal,kind,tile.z);
}
@fragment fn landCraterCaptureFS(v:LandCraterCapture)->@location(0) vec4f{
  let n=normalize(v.normal);
  return vec4f(v.y-v.floorY,n.x,n.z,floor(v.kind.x+.5)+clamp(v.kind.y,0.0,.99));
}
`;

// One tile from every crater that reaches it. A pure function of the craters and the ground, so overlapping
// tiles agree along their shared texels, a hit rewrites only what it touched, and a saved list replays exactly.
export const LAND_CRATER_BAKE = NOISE_WGSL + /* wgsl */ `
struct LandCraterRecord{centre:vec2f,radius:f32,depth:f32,heading:vec2f,grazing:f32,seed:f32,sand:f32,pad:f32};
struct LandCraterJob{origin:vec2f,floorY:f32,layer:u32,first:u32,count:u32,pad0:u32,pad1:u32};
@group(0)@binding(0) var<storage,read> craterRecords:array<LandCraterRecord>;
@group(0)@binding(1) var<storage,read> craterJobs:array<LandCraterJob>;
@group(0)@binding(2) var<storage,read> craterLists:array<u32>;
@group(0)@binding(3) var craterGroundIn:texture_2d_array<f32>;
@group(0)@binding(4) var craterFieldOut:texture_storage_2d_array<rgba16float,write>;
struct LandCraterStamp{height:f32,inside:f32,soil:f32,cover:f32};
fn landCraterStamp(c:LandCraterRecord,p:vec2f,rock:f32)->LandCraterStamp{
  let sand=c.sand;
  // Sand slumps to a wider, shallower bowl. Rock barely gives.
  let radius=c.radius*(1.0+.14*sand)*(1.0-.38*rock);
  let depth=c.depth*(1.0-.28*sand)*(1.0-.6*rock);
  // A flat shot drives the pit long and throws its spoil on ahead.
  let off=p-c.centre;
  let side=vec2f(-c.heading.y,c.heading.x);
  let q=vec2f((dot(off,c.heading)-.22*c.grazing*radius)/(1.0+.32*c.grazing),dot(off,side)/(1.0-.06*c.grazing))/radius;
  let angle=atan2(q.y,q.x);
  let ahead=cos(angle);
  let dir=q/max(length(q),.0001);
  let r=max(length(q)*(1.0+gnoise(dir*1.3+c.seed*17.0)*.12+gnoise(p*.85+c.seed*31.0)*.07),.0001);
  // Thrown ground goes out in uneven tongues.
  let ray=clamp(.5+gnoise(dir*2.3+c.seed*43.0)*.75+gnoise(dir*5.1-c.seed*29.0)*.45,0.0,1.0);
  let rim=depth*.32*(.72+.34*ray+.38*c.grazing*ahead);
  let reach=mix(2.2,3.0,clamp(.5+.5*ahead*c.grazing+(ray-.5)*.6,0.0,1.0));
  // Nothing passes this. landCraterReach in js/land-craters.js picks the tiles by the same figure.
  let limit=radius*${LAND_CRATER_REACH.toFixed(2)}*(1.0+.32*c.grazing);
  let fade=1.0-smoothstep(limit*.8,limit,length(off));
  // Bowl to the crest of the rim, then the spoil thinning as the cube of the distance, as thrown ground does.
  let bowl=-depth+(depth+rim)*pow(min(r,1.0),mix(2.5,2.0,sand));
  let apron=rim*pow(max(r,1.0),-3.0)*(1.0-smoothstep(reach*.72,reach,r));
  let clods=gnoise(p*2.9+c.seed*11.0)*.6+gnoise(p*4.4-c.seed*23.0)*.4;
  let rough=clods*depth*mix(.05,.11,smoothstep(.35,1.0,r))*(1.0-smoothstep(1.2,reach,r))*(1.0-.55*sand);
  return LandCraterStamp((mix(bowl,apron,smoothstep(.95,1.06,r))+rough)*fade,1.0-smoothstep(.7,1.02,r),
    max(1.0-smoothstep(1.02,1.3+.5*ray,r),min(pow(ray,1.5)*.8/(r*r),1.0)*(1.0-smoothstep(reach*.7,reach,r)))*fade,(1.0-smoothstep(reach,reach+.3,r))*fade);
}
@compute @workgroup_size(9,9) fn main(@builtin(global_invocation_id) id:vec3u){
  let job=craterJobs[id.z];
  let texel=vec2i(id.xy);
  let layer=i32(job.layer);
  let ground=textureLoad(craterGroundIn,texel,layer,0);
  if(ground.a<0.0){textureStore(craterFieldOut,texel,layer,vec4f(0.0));return;}
  let p=job.origin+(vec2f(id.xy)-${GUTTER})*${CELL};
  let rock=smoothstep(.22,.5,1.0-sqrt(max(1.0-ground.y*ground.y-ground.z*ground.z,0.0)));
  var stamps:array<LandCraterStamp,${LAND_CRATER_PER_TILE}>;
  let count=min(job.count,${LAND_CRATER_PER_TILE}u);
  for(var i=0u;i<count;i++){stamps[i]=landCraterStamp(craterRecords[craterLists[job.first+i]],p,rock);}
  // Bowls cut into each other. A rim stands unless another bowl has dug it away.
  var carve=0.0;var pile=0.0;var soil=0.0;var sand=0.0;var cover=0.0;
  for(var i=0u;i<count;i++){
    let cut=min(stamps[i].height,0.0);
    let k=min(.18,-max(carve,cut)*2.0);
    let h=max(k-abs(carve-cut),0.0)/max(k,.0001);
    carve=min(carve,cut)-h*h*k*.25;
    var standing=1.0;
    for(var j=0u;j<count;j++){if(j!=i){standing*=1.0-stamps[j].inside;}}
    pile+=max(stamps[i].height,0.0)*standing;
    soil=max(soil,stamps[i].soil);
    if(stamps[i].cover>cover){cover=stamps[i].cover;sand=craterRecords[craterLists[job.first+i]].sand;}
  }
  textureStore(craterFieldOut,texel,layer,vec4f(carve+pile,soil,sand,cover));
}
`;

// Added to the land shader, which runs its material for these fragments too, so the ground under the spoil and
// past the edge of it is the same ground. Only the land as it was decides what material a point is; the pit
// decides its lighting and what lies on top.
export const LAND_CRATER_RENDER = /* wgsl */ `
@group(2)@binding(0) var landCraterGround:texture_2d_array<f32>;
@group(2)@binding(1) var landCraterField:texture_2d_array<f32>;
@group(2)@binding(2) var landCraterSampler:sampler;
struct LandCraterVertex{
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) ground:vec3f,
  @location(2) kind:vec2f,
  @location(3) uv:vec2f,
  @location(4) groundY:f32,
  @location(5) @interpolate(flat) layer:i32,
  @location(6) @interpolate(flat) floorY:f32,
};
struct LandCraterPixel{@location(0) colour:vec4f,@builtin(frag_depth) depth:f32};
@vertex fn landCraterVS(@builtin(vertex_index) index:u32,@location(0) tile:vec4f)->LandCraterVertex{
  var o:LandCraterVertex;
  let shift=vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z);
  let away=length(vec3f(tile.x+${(LAND_CRATER_TILE_M / 2).toFixed(1)},tile.z,tile.y+${(LAND_CRATER_TILE_M / 2).toFixed(1)})+shift-F.camPos.xyz);
  if(away>1600.0){o.pos=vec4f(0.0,0.0,-1.0,1.0);return o;}
  // Coarser with distance, a tile at a time.
  let stride=1u<<u32(clamp(floor(log2(max(away,1.0)/70.0)+1.0),0.0,4.0));
  let raw=vec2u(index%${LAND_CRATER_DRAWN_CELLS + 1}u,index/${LAND_CRATER_DRAWN_CELLS + 1}u);
  // A cell past each edge, into the gutter: a hairline between tiles down in a pit would show the land above it.
  let cell=vec2i(min((raw+vec2u(stride>>1u))/stride*stride,vec2u(${LAND_CRATER_DRAWN_CELLS}u)))-vec2i(1);
  let texel=cell+vec2i(${LAND_CRATER_GUTTER});
  o.layer=i32(tile.w);
  o.floorY=tile.z;
  let ground=textureLoad(landCraterGround,texel,o.layer,0);
  let field=textureLoad(landCraterField,texel,o.layer,0);
  o.groundY=tile.z+ground.x;
  // Dug below the tide on a beach, a pit stands full to the sea's own level.
  o.world=vec3f(tile.x+f32(cell.x)*${CELL},max(o.groundY+field.x,min(o.groundY,.01)),tile.y+f32(cell.y)*${CELL});
  o.ground=vec3f(ground.y,sqrt(max(1.0-ground.y*ground.y-ground.z*ground.z,.0001)),ground.z);
  o.kind=vec2f(floor(ground.w),fract(ground.w));
  o.uv=(vec2f(texel)+.5)/${TEXELS};
  o.pos=F.viewProj*vec4f(earthCurve(o.world+shift-F.camPos.xyz,F.camPos.y),1.0);
  return o;
}
fn landCraterHeight(uv:vec2f,layer:i32)->f32{return textureSampleLevel(landCraterField,landCraterSampler,uv,layer,0.0).r;}
@fragment fn landCraterFS(v:LandCraterVertex)->LandCraterPixel{
  let field=textureSampleLevel(landCraterField,landCraterSampler,v.uv,v.layer,0.0);
  if(field.a<=.002){discard;}
  let texel=1.0/${TEXELS};
  let metres=1.0/(${TEXELS}*${CELL});
  // The surface as it is now: the land's slope and the pit's together.
  let e=vec2f(texel,0.0);
  let gradient=vec2f(landCraterHeight(v.uv+e.xy,v.layer)-landCraterHeight(v.uv-e.xy,v.layer),landCraterHeight(v.uv+e.yx,v.layer)-landCraterHeight(v.uv-e.yx,v.layer))/(2.0*${CELL});
  let tilt=v.ground.xz/max(v.ground.y,.05);
  let pool=1.0-smoothstep(0.0,.03,v.world.y);
  let normal=normalize(mix(vec3f(tilt.x-gradient.x,1.0,tilt.y-gradient.y),vec3f(0.0,1.0,0.0),pool));
  // Walk the height toward the sun, closely at first. The land's light bake knows nothing this small.
  var sun=1.0;
  let sunward=length(F.sunDir.xz);
  if(F.sunDir.y>0.0&&sunward>.001){
    let along=F.sunDir.xz/sunward;
    let climb=F.sunDir.y/sunward+dot(tilt,along);
    var blocked=-1.0;
    for(var i=0u;i<12u;i++){
      let t=pow(f32(i)+1.0,1.5)*.06;
      blocked=max(blocked,landCraterHeight(v.uv+along*t*metres,v.layer)-field.r-t*climb);
    }
    sun=1.0-smoothstep(.0,.09,blocked);
  }
  // How much of the sky the ground around leaves open.
  let d=.4*metres;
  let around=.25*(landCraterHeight(v.uv+vec2f(d,0.0),v.layer)+landCraterHeight(v.uv-vec2f(d,0.0),v.layer)+landCraterHeight(v.uv+vec2f(0.0,d),v.layer)+landCraterHeight(v.uv-vec2f(0.0,d),v.layer));
  let sky=(1.0-.62*clamp((around-field.r)/.42,0.0,1.0))*(1.0-.3*clamp(-field.r/1.1,0.0,1.0));
  // Turned-over earth: broken clods near, thinning to thrown scatter.
  let dx=dpdx(v.world);let dy=dpdy(v.world);
  let width=max(length(dx.xz),length(dy.xz));
  let coarse=landFilteredNoise(v.world.xz*1.7,width*1.7);let fine=landFilteredNoise(v.world.xz*6.3,width*6.3);
  let scatter=coarse*.55+fine*.45;
  // Clods a hand across and lumps a span across, each only as long as a few pixels can hold it.
  let clodNear=1.0-smoothstep(.01,.04,width);
  let lumpNear=1.0-smoothstep(.03,.12,width);
  var clods=vec2f(0.0,1.0);var lumps=vec2f(0.0,1.0);
  if(clodNear>0.0){clods=landStones(v.world.xz*19.0+scatter*1.5);}
  if(lumpNear>0.0){lumps=landStones(vec2f(v.world.x*.6+v.world.z*.8,v.world.z*.6-v.world.x*.8)*6.5+vec2f(5.3,71.9)+scatter*.8);}
  // Each clod or lump of earth is there or it is not, likelier the nearer the pit. From far off that is a tone.
  let chance=field.g*1.25+scatter*.22-.1;
  let piece=max(smoothstep(1.0-chance-.03,1.0-chance+.03,.5+.5*clods.x),smoothstep(1.0-chance*.8-.03,1.0-chance*.8+.03,.5+.5*lumps.x));
  let lying=max(field.a*mix(smoothstep(.3,.62,chance),piece,lumpNear),pool);
  let rock=smoothstep(.22,.5,1.0-v.ground.y);
  let deep=clamp(-field.r/.5,0.0,1.0);
  let topsoil=mix(vec3f(.085,.055,.034),vec3f(.032,.021,.014),clamp(.5+scatter*.9+deep*.35,0.0,1.0));
  let stone=vec3f(.3,.27,.23)*(1.0+coarse*.2);
  let broken=1.0+(clods.x*.3-(1.0-clods.y)*.38)*clodNear+(lumps.x*.3-(1.0-lumps.y)*.3)*lumpNear;
  let relief=((clods.y-.55)*.03*clodNear+(lumps.y-.55)*.07*lumpNear+coarse*.035+fine*.012)*(1.0-pool);
  let colour=landSurface(LandVertex(v.pos,v.world,v.ground,v.kind,vec2f(0.0)),
    LandPit(normal,lying,mix(topsoil,stone,rock)*broken,relief,sun,sky,pool,(1.0-.62*deep)*(.72+scatter*.2)*mix(1.0,broken,.45),field.b));
  // The land's own triangles lie between the eye and a pit. Where the view goes down into the ground, write the
  // depth of the place it went in, keeping a trace of the true distance so that nearer ground in the pit still wins.
  let shift=vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z);
  let point=v.world+shift;
  let eye=F.camPos.xyz;
  let going=point-eye;
  var surface=point;
  let facing=min(dot(v.ground,going),-.00001);
  let first=dot(v.ground,vec3f(point.x,v.groundY+.03,point.z)-eye)/facing;
  if(first>0.0&&first<1.0){
    // That place is found on the land itself: the land's facets need not lie in the plane it has here.
    let entry=(eye+going*first).xz-point.xz;
    let land=v.floorY+textureSampleLevel(landCraterGround,landCraterSampler,v.uv+entry*metres,v.layer,0.0).r;
    let lifted=vec3f(point.x+entry.x,max(land,v.groundY-dot(tilt,entry))+.03+length(entry)*.015,point.z+entry.y);
    let through=dot(v.ground,lifted-eye)/facing;
    if(through>0.0&&through<1.0){surface=eye+going*mix(through,1.0,.005);}
  }
  let clip=F.viewProj*vec4f(earthCurve(surface-eye,F.camPos.y),1.0);
  return LandCraterPixel(colour,clip.z/clip.w);
}
`;
