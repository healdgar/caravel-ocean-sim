import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS, HULL_HOLE_LIMIT, HULL_CRATER_LIMIT, SANE_HDR } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { DECK_PROFILE, DECK_SAMPLING } from './deck.js';
import { VESSEL_RIG, VESSEL_LIGHTING, CANVAS_OPTICS } from './vessel.js';
import { SHADOW_SAMPLE } from './shadows.js';
import { ADDITIONAL_DESIGNS } from '../models/additional.js';

// Exact marker recognized by createSubmergedShader. Both hull and rudder retain
// their authored material IDs/finishes; only the surrounding optical medium
// changes in the capture variant. No new resource or vertex-layout contract.
export const VESSEL_MATERIAL_MEDIUM=/* wgsl */ `
const vesselWaterCapture=false;
fn vesselWoodDielectricF0()->f32 {
  let medium=select(1.0,1.333,vesselWaterCapture);
  let ratio=(1.5-medium)/(1.5+medium);return select(0.04,ratio*ratio,vesselWaterCapture);
}
fn vesselAirFilm(film:f32)->f32 {return select(film,0.0,vesselWaterCapture);}
fn vesselWoodMaterial(material:u32,paintedWood:bool)->bool {
  return paintedWood || material==0u || material==1u || material==5u || material==6u || material==7u || material==10u ||
    material==14u || material==15u || material==16u || material==17u || material==18u;
}
fn vesselWoodOptics(rough:f32,absorbed:f32,film:f32,relief:f32,grain:f32)->vec4f {
  let darkening=mix(1.0,0.58,absorbed);
  let intrinsic=mix(rough,max(0.62,rough-0.15),absorbed);
  // Once immersed there is no outer water/air boundary atop a wet board. Keep
  // absorption and grain, but do not varnish the submerged surface with that
  // air-side film lobe. This helper is shared by every timber material.
  let surfaceFilm=vesselAirFilm(film)*(0.35+0.65*(1.0-smoothstep(0.12,0.65,relief+grain*0.25)));
  return vec4f(darkening,mix(intrinsic,0.27+grain*0.09,surfaceFilm),vesselWoodDielectricF0(),surfaceFilm);
}
`;

// Authored aged/cast-iron finish, not a measured Victory conservation recipe.
// Oxide is a dark dielectric; exposed iron is a separate area fraction. A dark
// diffuse colour must not also stand in for the conductor's F0. Approximate
// linear bare-iron reflectance follows Filament's common-metal reference:
// https://google.github.io/filament/main/materials.html#materialmodels/litmodel/basecolor
// Water's IOR=1.33 gives about 2% normal-incidence reflectance. Its surface film
// is a second lobe, not absorbed timber moisture or a smoother metal substrate.
export const IRON_SURFACE = /* wgsl */ `
const vesselIronWaterF0=0.020059312;
struct VesselIronSurface {
  albedo:vec3f,f0:vec3f,rough:f32,bare:f32,relief:f32,film:f32,filmRough:f32,
};
fn vesselIronNoise(p:vec3f,frequency:f32)->f32 {
  return (gnoise(p.xy*frequency)+gnoise(p.yz*frequency+vec2f(7.1,3.9))+
    gnoise(p.zx*frequency+vec2f(13.7,19.3)))/3.0;
}
fn vesselIronSurface(p:vec3f,footprint:f32,film:f32)->VesselIronSurface {
  // Metres in the undeformed object frame keep the finish fixed to the gun.
  // Remove unresolved surface frequencies from colour, roughness AND relief.
  let coarse=vesselIronNoise(p,8.0)*(1.0-smoothstep(0.025,0.10,footprint));
  let pits=vesselIronNoise(p,85.0)*(1.0-smoothstep(0.002,0.008,footprint));
  var surface:VesselIronSurface;
  surface.bare=clamp(0.06+coarse*0.16,0.02,0.14);
  surface.albedo=vec3f(0.020,0.019,0.017)*(0.94+coarse*0.22);
  surface.f0=mix(vec3f(0.04),vec3f(0.55,0.57,0.57),surface.bare);
  surface.rough=clamp(0.73+coarse*0.16+pits*0.12,0.62,0.86);
  surface.relief=coarse*0.0007+pits*0.00016;
  surface.film=clamp(film,0.0,1.0);surface.filmRough=0.23+coarse*0.06;
  return surface;
}
fn vesselIronTransmission(film:f32,nv:f32,nl:f32)->f32 {
  let fv=vesselFresnel(vec3f(vesselIronWaterF0),nv).x;
  let fl=vesselFresnel(vec3f(vesselIronWaterF0),nl).x;
  return mix(1.0,(1.0-fv)*(1.0-fl),film);
}
`;
// Two shaders from one source. A whole ship has no damage code at all: no discard, so the GPU
// shades only what the eye can see of her. A damaged ship lays depth with `surviving`, which
// decides what shot and tearing have taken away, then `fs` shades just the surface that is left.
function vesselSource(damaged) { return FRAME_WGSL + ATMO_CORE_WGSL + DECK_PROFILE + VESSEL_RIG + VESSEL_LIGHTING + CANVAS_OPTICS + SHADOW_SAMPLE + VESSEL_MATERIAL_MEDIUM + IRON_SURFACE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<storage, read> sunVis: array<f32, 4>;
@group(0) @binding(6) var<uniform> hull: Hull;
@group(0) @binding(7) var waterScene: texture_2d<f32>;
@group(0) @binding(8) var dispTex: texture_2d_array<f32>;
@group(0) @binding(9) var repeatSamp: sampler;
@group(0) @binding(10) var oakAlbedo: texture_2d<f32>;
@group(0) @binding(11) var oakSampler: sampler;
@group(0) @binding(12) var deckWater: texture_2d<f32>;
@group(0) @binding(13) var<storage,read> moisture:array<vec2f>;
@group(0) @binding(14) var<storage,read> wetLookup:array<u32>;
${damaged?`// Holes in local metres with their radius, then craters in design coordinates. See hull-flood.js.
struct HullCrater { at:vec3f, packed:u32 };
struct HullDamage { scale:vec4f, level:vec4f, holes:array<vec4f,${HULL_HOLE_LIMIT}>, flows:array<vec4f,${HULL_HOLE_LIMIT}>, craters:array<HullCrater,${HULL_CRATER_LIMIT}> };
@group(0) @binding(15) var<uniform> hullDamage:HullDamage;
`:''}` + SKY_RENDER_FUNCS + DECK_SAMPLING + /* wgsl */ `
struct BoatVertex {
  ${damaged?'@invariant ':''}@builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) material: u32,
  @location(4) normalLocal: vec3f,
  @location(5) uv: vec2f,
  @location(6) wet:vec2f,
  ${damaged?'@location(7) damage: f32,':''}
};
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) material: f32, @location(3) uv: vec2f,@builtin(vertex_index) index:u32) -> BoatVertex {
  let inputNormLen=length(normal);
  let unitInputNormal=select(normal,normal/max(inputNormLen,0.0001),inputNormLen>1.002);
  let rig=rigVertex(position,normal,material,uv);
  let rawRigLen=length(rig.normal);
  let unitRigNormal=select(rig.normal,rig.normal/max(rawRigLen,0.0001),rawRigLen>1.002);
  let relative = rotateHull(rig.position * rig.scale) + hull.origin.xyz - F.camPos.xyz;
  var o: BoatVertex;
  o.pos = F.viewProj * vec4f(relative, 1.0);
  o.world = relative + F.camPos.xyz;
  o.normal = normalize(rotateHull(unitRigNormal / rig.scale));
  o.local = position;
  o.material = u32(material); o.normalLocal = unitInputNormal; o.uv=uv;o.wet=moisture[wetLookup[index]];
  ${damaged?'let rigNormLen=max(inputNormLen,rawRigLen);o.damage=select(0.0,clamp(rigNormLen-1.0,0.0,1.5),rigNormLen>1.002);':''}
  return o;
}
fn oceanHeight(p: vec2f) -> f32 {
  var h = 0.0;
  for (var c = 0u; c < 3u; c++) {
    h += textureSampleLevel(dispTex, repeatSamp, p * F.cascInvL[c >> 2u][c & 3u], c, 1.0).y;
  }
  return h;
}
// Roughness-filtered ocean radiance, with continuous screen-edge confidence.
fn waterLight(world: vec3f, direction: vec3f, roughness: f32) -> vec3f {
  let env = textureSampleLevel(envCube, sampC, direction, roughness * 8.0).rgb;
  let dy = min(direction.y, -0.03);
  let waterY = oceanHeight(world.xz);
  let t = clamp((waterY - world.y) / dy, 0.0, 100.0);
  let clip = F.viewProj * vec4f(world + direction * t - F.camPos.xyz, 1.0);
  let uv = clip.xy / max(clip.w, 0.0001) * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let confidence = smoothstep(0.015,0.14,edge) * smoothstep(0.0,0.5,clip.w)
      * smoothstep(0.025,0.16,-direction.y) * smoothstep(0.0,0.3,t);
  let lod = 0.5 + roughness * 5.0;
  let ocean = textureSampleLevel(waterScene, sampC, clamp(uv,vec2f(0.001),vec2f(0.999)), lod).rgb;
  // A rough timber reflection integrates light over a broad lobe. Individual
  // HDR sun glitter pixels must not behave as point emitters on the wood.
  let limit=env*4.0 + sunIlluminance()*sunVis[0]*0.08 + vec3f(0.02);
  let filteredOcean=min(ocean,limit);
  return mix(env,filteredOcean,confidence*0.55);
}
fn vesselPainted(material:u32)->bool {return material==20u || material==21u || material==23u || material==24u || material==26u;}
fn vesselClothEdge(uv:vec2f,material:u32)->f32 {
  let squareEdge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let triangleEdge=min(min(uv.x,uv.y),(1.0-uv.x-uv.y)*0.70710678);
  return select(squareEdge,triangleEdge,material==13u);
}
${damaged?`// A ball leaves a ragged opening, torn further along the run of the planks. How far into its
// splintered margin this point lies, or below zero inside the hole itself.
fn hullHoleRim(p:vec3f)->f32 {
  var rim=0.0;
  let metres=p*hullDamage.scale.xyz;
  for(var i=0u;i<u32(hullDamage.scale.w);i++){
    let hole=hullDamage.holes[i];
    // Measured across her side only: the planks around a hole have been stove in well inboard of it.
    let d=metres-hole.xyz;
    if(abs(d.x)>1.2){continue;}
    let distance=length(d.yz*vec2f(1.0,.82));
    if(distance>hole.w*1.8+.08){continue;}
    let around=d.yz/max(length(d.yz),.0001);
    let ragged=.84+.55*gnoise(around*1.7+hole.xz*9.0)+.2*gnoise(vec2f(metres.z*22.0,metres.y*48.0));
    let edge=hole.w*ragged;
    if(distance<edge){return -1.0;}
    rim=max(rim,1.0-smoothstep(edge,edge*1.3+.035,distance));
  }
  return rim;
}
fn ropeFray(p:vec3f)->f32 {return gnoise(vec2f((p.x+p.z)*32.0,p.y*48.0));}
fn ropeParted(p:vec3f,damage:f32)->bool {return damage>0.58 && ropeFray(p)>1.18-damage*0.65;}
// Anisotropic linen tear field: canvas rips preferentially along vertical warp strips
// and seams, with ragged shot holes and frayed cross-weft threads around the tear rim.
struct CanvasTear {value:f32,threshold:f32,fray:f32};
fn canvasTear(uv:vec2f,p:vec3f,material:u32,damage:f32)->CanvasTear {
  let warpTear=gnoise(vec2f(uv.x*42.0+floor(uv.x*10.0)*3.7,uv.y*8.5));
  let shotTear=gnoise(vec2f(uv.x*16.0+p.x*2.1,uv.y*16.0+p.y*1.9));
  let threadFray=gnoise(vec2f(uv.x*170.0,uv.y*55.0));
  let seamWeakness=(1.0-smoothstep(0.0,0.14,abs(fract(uv.x*10.0)-0.5)))*0.18;
  let keepRim=(1.0-smoothstep(0.0,0.035,vesselClothEdge(uv,material)))*0.35;
  return CanvasTear(warpTear*0.48+shotTear*0.34+threadFray*0.18+seamWeakness-keepRim,clamp(0.96-damage*0.56,0.24,0.92),threadFray);
}
// Depth for a damaged ship. Whatever fails here is gone, so it is never shaded.
@fragment fn surviving(in:BoatVertex)->@location(0) vec4f {
  if(vesselWoodMaterial(in.material,vesselPainted(in.material)) && hullHoleRim(in.local)<0.0){discard;}
  if((in.material==2u || in.material==12u || in.material==19u) && ropeParted(in.local,in.damage)){discard;}
  if((in.material==9u || in.material==13u) && in.damage>0.04){
    let tear=canvasTear(in.uv,in.local,in.material,in.damage);
    if(tear.value>tear.threshold){discard;}
  }
  return vec4f(0);
}
`:''}@fragment fn fs(in: BoatVertex, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let p = in.local;
  var wet=clamp(in.wet,vec2f(0),vec2f(1));
  if(in.material==0u && abs(p.y-deckFloor(p.z))<0.08){wet.x=max(wet.x,sampleDeck(deckUV(p)).z);}
  var n = normalize(in.normal) * select(-1.0,1.0,front);
  let grainUV = in.uv;
  let timber = pow(textureSample(oakAlbedo, oakSampler, grainUV).rgb, vec3f(2.2));
  let relief = dot(timber, vec3f(0.2126,0.7152,0.0722));
  let broad = gnoise(vec2f(grainUV.x * 18.0, grainUV.y * 0.7));
  let grain = gnoise(vec2f(grainUV.x * 180.0 + broad*3.0, grainUV.y * 5.0));
  let footprint = max(length(dpdx(grainUV)),length(dpdy(grainUV)));
  // Plank seams follow the hull's girth and the cabin's horizontal strakes.
  // Unlike a painted line, their recessed height also breaks the light response.
  let paintedWood=vesselPainted(in.material);
  let isProceduralFleet=hull.rig.w<.5 && abs(hull.size.y-20.0)>.2;
  let isCopper=in.material==22u || (in.material==20u && isProceduralFleet && p.y < -0.05);
  let isGilt=in.material==25u || (in.material==20u && isProceduralFleet && abs(p.y - 0.53) < 0.018 && abs(in.normalLocal.x) > 0.35);
  let isMastSpar=(in.material==1u && abs(p.x)<0.24 && p.y>0.65) || in.material==10u;
  ${damaged?`// Timber stands raw and splintered around a hole, and whatever is seen through it lies in the dark of the hold.
  let holedTimber=u32(hullDamage.scale.w)>0u && vesselWoodMaterial(in.material,paintedWood);
  let holeRim=select(0.0,max(hullHoleRim(p),0.0),holedTimber);
`:''}  let plankedWall=in.material==15u || (paintedWood && !isCopper && !isGilt && abs(in.normalLocal.y)<.5) || (in.material==1u && !isMastSpar && abs(in.normalLocal.y)<.35);
  // Wall strakes are the Niña's width in metres on every ship, not in the ship's design units.
  let course=select(p.y*hull.right.w/(.16*20.0/12.0),in.uv.x*18.0,in.material==15u);
  let board=floor(course);
  let edge=min(fract(course),1.0-fract(course));
  let seam=1.0-smoothstep(.008,.035+max(fwidth(course),.001),edge);
  let along=select(p.z,p.x,abs(in.normalLocal.z)>.75 && in.material!=15u);
  let buttCoord=(along+fract(sin(board*73.17)*4321.1)*2.6)/2.6;
  let butt=min(fract(buttCoord),1.0-fract(buttCoord));
  let buttSeam=1.0-smoothstep(.0008,.003+max(fwidth(buttCoord),.0003),butt);
  let deckCourse=(p.x+1.8)/.145;
  let deckPlankId=floor(deckCourse);
  let deckEdge=min(fract(deckCourse),1.0-fract(deckCourse));
  let deckSeam=1.0-smoothstep(.014,.038+max(fwidth(deckCourse),.002),deckEdge);
  let deckButtCoord=(p.z+fract(deckPlankId*0.413)*2.0)/2.3;
  let deckButtEdge=min(fract(deckButtCoord),1.0-fract(deckButtCoord));
  let deckButtSeam=1.0-smoothstep(.001,.004+max(fwidth(deckButtCoord),.001),deckButtEdge);
  // Pinta and Santa María carry their model code in rig.w, so isProceduralFleet
  // above never matches them. It stays off for the other descriptor-driven ships.
  let isAdditionalIberian=hull.rig.w>1.5 && hull.rig.w<3.5;
  let deckCaulk=select(0.0,max(deckSeam,deckButtSeam*.85),(isProceduralFleet || isAdditionalIberian) && in.material==0u);
  let castleFore=select(${ADDITIONAL_DESIGNS['santa-maria'].deckZones.find(zone=>zone.id==='forecastle').bounds[1]},${ADDITIONAL_DESIGNS.pinta.deckZones.find(zone=>zone.id==='forecastle').bounds[1]},hull.rig.w<2.5);
  let castleAft=select(${ADDITIONAL_DESIGNS['santa-maria'].deckZones.find(zone=>zone.id==='quarter').bounds[0]},${ADDITIONAL_DESIGNS.pinta.deckZones.find(zone=>zone.id==='quarter').bounds[0]},hull.rig.w<2.5);
  let isCastleWall=isAdditionalIberian && in.material==15u && p.y>.60 && (p.z>castleAft || p.z<castleFore);
  let castleMoulding=select(0.0,1.0-smoothstep(.14,.22,abs(fract(course*.3333)-.5)*3.0),isCastleWall);
  // Only the nao carries upright battens on her castles; the caravel stays plain.
  let castleFuttock=select(0.0,1.0-smoothstep(.038,.062,abs(fract(p.z/.62)-.5)),isCastleWall && hull.rig.w>2.5 && castleMoulding<.5);
  let castleRelief=(castleMoulding*.0024 + castleFuttock*.0018);
  let join=select(deckCaulk*.85,max(seam,buttSeam*.8),plankedWall);
  var bump=relief*.006 + grain*.00065*(1.0-smoothstep(.0005,.004,footprint)) - join*.0018 + castleRelief;
  ${damaged?'if(in.damage>0.05){bump+=smoothstep(0.05,0.45,clamp(in.damage,0.0,1.5))*gnoise(vec2f(p.z*28.0,p.y*165.0))*.016*(1.0-smoothstep(.002,.015,footprint));}':''}
  let dx = dpdx(in.world); let dy = dpdy(in.world);
  // Shadow depth rasterizes flat triangles, while cloth lighting uses smooth
  // analytic normals. Receiver-plane filtering must follow the actual triangle
  // or a wide filter can turn that mismatch into a ladder of self-shadow acne.
  let triangleNormal=cross(dx,dy);
  let shadowNormal=triangleNormal/max(length(triangleNormal),.000000000001);
  let sx = cross(dy,n); let sy = cross(n,dx);
  let det = dot(dx,sx);
  let gradient = (dpdx(bump)*sx + dpdy(bump)*sy) / max(abs(det), 0.000001) * sign(det);
  let isWood=vesselWoodMaterial(in.material,paintedWood) && !isCopper && !isGilt;
  n = normalize(n - clamp(gradient,vec3f(-.38),vec3f(.38))*select(0.0,1.0,isWood));
  let isIron=in.material==3u || in.material==8u;
  let materialPoint=p*vec3f(hull.size.x/3.6,hull.right.w,hull.size.y/12.0);
  let materialFootprint=max(length(dpdx(materialPoint)),length(dpdy(materialPoint)));
  var iron:VesselIronSurface;
  if(isIron){iron=vesselIronSurface(materialPoint,materialFootprint,vesselAirFilm(wet.y));}
  // Derivatives remain outside material-dependent control flow. They use the
  // same surface-gradient frame as timber but a separate, filtered cast relief.
  let ironGradient=(dpdx(iron.relief)*sx+dpdy(iron.relief)*sy)/max(abs(det),0.000001)*sign(det);
  if(isIron){n=normalize(n-clamp(ironGradient,vec3f(-.18),vec3f(.18)));}
  // Precompute staggered copper plate coordinates & surface-gradient relief outside control flow
  let cuRow=floor(materialPoint.y*3.2);
  let cuCol=floor(materialPoint.z*0.95+fract(cuRow*0.5)*0.5);
  let cuUV=vec2f(fract(materialPoint.z*0.95+fract(cuRow*0.5)*0.5),fract(materialPoint.y*3.2));
  let cuHash=fract(sin(cuRow*127.1+cuCol*311.7)*43758.5453);
  let cuEdge=min(min(cuUV.x,1.0-cuUV.x),min(cuUV.y,1.0-cuUV.y));
  let cuSeam=1.0-smoothstep(0.015,0.055,cuEdge);
  let cuNailCoord=vec2f(fract(cuUV.x*8.0)-0.5,fract(cuUV.y*4.0)-0.5);
  let cuNailRing=cuEdge<0.14 && cuEdge>0.025;
  let cuNail=select(0.0,1.0-smoothstep(0.12,0.28,length(cuNailCoord)),cuNailRing)*(1.0-smoothstep(0.01,0.05,materialFootprint));
  let cuRelief=(cuUV.y*0.0012 - cuSeam*0.0018 + cuNail*0.0009)*(1.0-smoothstep(0.02,0.09,materialFootprint));
  let cuGradient=(dpdx(cuRelief)*sx+dpdy(cuRelief)*sy)/max(abs(det),0.000001)*sign(det);
  // Precompute sail canvas panel pillowing, seam puckering & reef-band surface-gradient relief outside control flow
  let clothSeam=abs(fract(in.uv.x*10.0)-0.5);
  let clothAA=max(fwidth(clothSeam),0.001);
  let weaveAA=max(fwidth(in.uv.x+in.uv.y),0.001);
  let clothEdge=vesselClothEdge(in.uv,in.material);
  let edgeAA=max(fwidth(clothEdge),0.0005);
  let reefDist=min(abs(in.uv.y-0.26),abs(in.uv.y-0.52));
  let reefBand=select(0.0,1.0-smoothstep(0.007,0.014+max(fwidth(in.uv.y),0.0005),reefDist),in.material==9u);
  let reefGrommet=select(0.0,1.0-smoothstep(0.003,0.007,length(vec2f((fract(in.uv.x*20.0)-0.5)*0.05,reefDist))),in.material==9u && reefDist<0.012);
  let cornerDist=min(min(length(in.uv),length(in.uv-vec2f(1.0,0.0))),min(length(in.uv-vec2f(0.0,1.0)),length(in.uv-vec2f(1.0,1.0))));
  let cornerPatch=1.0-smoothstep(0.055,0.085,cornerDist);
  let panelPillow=sin(fract(in.uv.x*10.0)*3.14159265);
  let seamPucker=sin(in.uv.y*95.0+floor(in.uv.x*10.0)*2.3)*(1.0-smoothstep(0.0,0.08,clothSeam));
  let canvasRelief=(panelPillow*0.0032 + seamPucker*0.0011 + reefBand*0.0018 + cornerPatch*0.0012)*(1.0-smoothstep(0.004,0.025,weaveAA));
  let canvasGradient=(dpdx(canvasRelief)*sx+dpdy(canvasRelief)*sy)/max(abs(det),0.000001)*sign(det);
  var albedo = timber * vec3f(1.02,.98,.88);
  var rough = clamp(.86 + (.2-relief)*.20 + (grain-.5)*.08,.78,.95); var metal = 0.0;
  let canvasDepth=canvasThickness(in.uv,in.material)*canvasWetDepth(wet.x);
  let plank=select(floor((p.x+1.8)/.145),board,plankedWall);
  albedo *= .88 + .16 * fract(sin(plank*74.17)*4321.1);
  albedo *= 1.0-join*.58;
  // Fine end-grain joints, splits, and oxidised grain.
  let joint = abs(fract((p.z + fract(plank*0.413)*2.0)/2.3)-0.5);
  let jointAA = max(fwidth(joint),0.001);
  if(in.material==0u) {
    albedo *= mix(0.3,1.0,smoothstep(0.001,0.004+jointAA,joint));
    if(isProceduralFleet || isAdditionalIberian) {
      albedo = mix(albedo, vec3f(0.015,0.011,0.008), deckCaulk * 0.86);
      rough = mix(rough, 0.94, deckCaulk);
    }
  }
  if(in.material == 1u || in.material == 5u || in.material == 6u || in.material == 10u) {
    if(in.material != 10u) { albedo *= .87; }
    if(isMastSpar) {
      // Turned cylindrical spar: longitudinal pine/spruce grain, radial weather-checking, and iron mast hoops (wooldings)
      let sparAngle = atan2(in.normalLocal.x, in.normalLocal.z);
      let sparGrain = 0.92 + 0.08 * sin(sparAngle * 24.0 + gnoise(vec2f(p.y * 6.0, p.z * 6.0)) * 4.0);
      let checkCrack = smoothstep(0.86, 0.95, sin(sparAngle * 11.0 + p.y * 2.5));
      albedo = timber * vec3f(1.08, 0.92, 0.68) * sparGrain * (1.0 - checkCrack * 0.28);
      rough = clamp(0.74 + (1.0 - sparGrain) * 0.14 + checkCrack * 0.12, 0.68, 0.90);
      let isMastHoop = in.material == 1u && p.y > 0.85 && p.y < 6.4 && abs(fract(p.y * 1.35) - 0.5) < 0.036;
      if(isMastHoop) {
        albedo = vec3f(0.032, 0.031, 0.029);
        rough = 0.58;
        metal = 0.45;
      }
    } else if((isProceduralFleet || isAdditionalIberian) && in.material == 1u) {
      let isKeelOrPost = (abs(p.x) < 0.068 && p.y < -0.46) || (abs(p.x) < 0.055 && p.z > 5.25 && p.y < 1.05);
      let isCapRail = p.y > 0.58 && in.normalLocal.y > 0.52 && abs(p.x) > 0.32;
      if(isKeelOrPost) {
        albedo = timber * vec3f(.20,.18,.15);
        rough = .90;
        if(abs(p.x) < 0.055 && p.z > 5.25 && abs(fract((p.y + 0.85) / 0.42) - 0.5) < 0.085) {
          albedo = vec3f(0.045, 0.042, 0.040);
          rough = 0.56;
          metal = 0.62;
        }
      } else if(isCapRail) {
        albedo = timber * vec3f(1.10,1.0,.80);
        rough = clamp(rough - 0.04, 0.74, 0.92);
      }
    }
  }
  if(in.material==20u){
    albedo=vec3f(.009,.008,.006);rough=.88;
    if(isGilt) {
      albedo = vec3f(.48,.28,.055);
      rough = .42; metal = .68;
    }
  }
  if(in.material==21u){albedo=vec3f(.48,.265,.075);rough=.85;}
  if(isCopper){
    // Staggered 18th/19th-century Muntz-metal / copper hull sheathing plates with overlapped seams,
    // embossed tack rows, rolled-metal tone variation, and sea-salt verdigris patina near the waterline.
    let plateTone = 0.90 + 0.18 * cuHash;
    let rolledStreak = 0.96 + 0.04 * sin(materialPoint.z * 48.0 + cuRow * 5.1);
    let cuBase = vec3f(0.33, 0.135, 0.065) * plateTone * rolledStreak * (1.0 - cuSeam * 0.28 + cuNail * 0.14);
    let waterlineBand = smoothstep(-0.75, -0.02, p.y) * (1.0 - smoothstep(-0.02, 0.12, p.y));
    let verdigrisNoise = clamp(gnoise(vec2f(materialPoint.z * 3.5 + cuRow * 1.7, materialPoint.y * 8.0)) * 0.85 + cuSeam * 0.45, 0.0, 1.0);
    let verdigrisMask = clamp(waterlineBand * verdigrisNoise * 0.52 + cuSeam * 0.16, 0.0, 0.65);
    let verdigrisColor = vec3f(0.11, 0.29, 0.22);
    albedo = mix(cuBase, verdigrisColor, verdigrisMask);
    rough = mix(0.46 + (1.0 - plateTone) * 0.12, 0.82, verdigrisMask);
    metal = mix(0.72, 0.08, verdigrisMask);
    n = normalize(n - clamp(cuGradient, vec3f(-0.22), vec3f(0.22)));
  }
  if(in.material==23u){
    albedo=vec3f(.68,.65,.55);rough=.86;
    if(isProceduralFleet && hull.size.y < 20.0 && abs(in.normalLocal.x) > 0.25) {
      if(p.y < -0.03) {
        albedo = vec3f(.26,.028,.018); rough = .82;
      } else if(abs(p.y - 0.34) < 0.018) {
        albedo = vec3f(.015,.035,.09); rough = .84;
      }
    }
  }
  if(in.material==24u){albedo=vec3f(.26,.028,.018);rough=.83;}
  if(in.material==25u){albedo=vec3f(.48,.28,.055);rough=.42;metal=.68;}
  if(in.material==26u){albedo=vec3f(.015,.035,.09);rough=.88;}
  if(paintedWood && metal < 0.1){albedo*=mix(.88,1.04,relief)*(1.0-join*.46);}
  let ropeAA = max(materialFootprint, fwidth(in.uv.y) * (hull.size.y * 0.12));
  if(in.material == 2u || in.material == 12u || in.material==19u) {
    // MaterialCraft 3D Helical 3-Strand Laid Hemp Hawser (Z-twist lay + S-twist spun-yarn plies):
    // True cylindrical strand cross-section with recessed V-grooves, yarn-to-yarn bast fibre variation,
    // Stockholm pine-tar resin optics on standing rigging (2u), golden hackled hemp on running rigging (12u),
    // and marline-hitched sail bolt-ropes (19u), with exact Nyquist derivative band-limiting.
    let rLocal = normalize(in.normalLocal);
    let isDynLine = in.uv.x >= 99.5;
    let isBoltRope = in.material == 19u;
    let ropeMeters = select(
      select(in.uv.y * (hull.size.y / 9.0), in.uv.y * (hull.size.y * 0.65), isDynLine),
      (in.uv.x + in.uv.y) * (hull.size.y * 0.48),
      isBoltRope
    );
    let azFromNormal = select(atan2(rLocal.x, rLocal.z), atan2(rLocal.y, rLocal.x + rLocal.z * 0.7), abs(rLocal.y) > 0.76 && abs(rLocal.x) < 0.45);
    let ropeAz = select(in.uv.x * (6.2831853 / 0.7), azFromNormal, isDynLine || isBoltRope || in.uv.y == 0.0);
    let layPhase = ropeMeters * 52.0 + ropeAz * 3.0;
    let layFootprint = ropeAA * 52.0;
    let ropeLayFade = 1.0 - smoothstep(0.55, 2.6, layFootprint);
    let ropeYarnFade = 1.0 - smoothstep(0.18, 0.95, layFootprint);

    // Cylindrical 3-strand profile: u in [-0.5, 0.5] across each strand lobe
    let strandU = fract(layPhase * 0.15915494) - 0.5;
    let strandId = floor(layPhase * 0.15915494);
    let strandCrown = sqrt(max(0.06, 1.0 - 3.55 * strandU * strandU));
    let strandValleyAO = smoothstep(0.48, 0.18, abs(strandU));

    // Counter-twisted (S-twist) spun-yarn plies & individual hemp bast fibre hash
    let yarnCoord = ropeMeters * 240.0 - ropeAz * 9.0 + strandId * 2.1;
    let yarnId = floor(yarnCoord * 0.15915494);
    let yarnHash = fract(sin(yarnId * 127.1 + strandId * 311.7) * 43758.5453);
    let yarnTwist = sin(yarnCoord) * ropeYarnFade;
    let microFibre = sin(ropeMeters * 680.0 - ropeAz * 21.0 + yarnHash * 6.28) * (1.0 - smoothstep(0.06, 0.32, layFootprint));

    // Marline serving hitches on bolt-ropes (19u) every ~4.5 cm
    let hitchPhase = fract(ropeMeters * 22.0);
    let marlineHitch = select(0.0, 1.0 - smoothstep(0.06, 0.15, abs(hitchPhase - 0.5)), isBoltRope);
    let marlineShadow = select(0.0, (1.0 - smoothstep(0.12, 0.26, abs(hitchPhase - 0.5))) * (1.0 - marlineHitch), isBoltRope);

    let crownHemp = select(
      select(vec3f(0.43, 0.315, 0.175), vec3f(0.088, 0.058, 0.035), in.material == 2u),
      vec3f(0.31, 0.22, 0.118),
      isBoltRope
    );
    let valleyHemp = select(
      select(vec3f(0.145, 0.095, 0.048), vec3f(0.024, 0.016, 0.010), in.material == 2u),
      vec3f(0.11, 0.072, 0.036),
      isBoltRope
    );
    let yarnTone = 0.92 + 0.16 * (yarnHash - 0.5) * ropeYarnFade + 0.08 * yarnTwist + 0.04 * microFibre;
    let laidColor = mix(valleyHemp, crownHemp * yarnTone, (0.22 + 0.78 * strandCrown * strandValleyAO));
    let avgRopeColor = mix(valleyHemp, crownHemp, 0.68);
    var ropeAlbedo = mix(avgRopeColor, laidColor, ropeLayFade) * (1.0 - 0.24 * marlineShadow * ropeLayFade);
    albedo = mix(ropeAlbedo, vec3f(0.058, 0.038, 0.022) * (0.85 + 0.15 * strandCrown), marlineHitch * 0.86 * ropeLayFade);

    // Tarred standing rigging (2u) has a resinous pine-tar sheen on the strand crowns; running hemp (12u) is fibrous matte
    let baseRough = select(0.86, 0.64, in.material == 2u);
    rough = clamp(baseRough - 0.08 * strandCrown * ropeLayFade + 0.06 * (1.0 - strandValleyAO) * ropeLayFade - 0.04 * yarnTwist, 0.48, 0.95);

    // True cylindrical tangent & bitangent normal perturbation from the circular strand slope (-d/du of strandCrown) + yarn twist
    let ropeTang = normalize(cross(n, vec3f(0.35, 0.86, 0.35)) + vec3f(0.001, 0.0, 0.0));
    let ropeBitang = cross(n, ropeTang);
    let dStrand = clamp(-2.85 * strandU, -1.0, 1.0) * ropeLayFade + 0.24 * cos(yarnCoord) * ropeYarnFade;
    let dHitch = select(0.0, clamp((0.5 - hitchPhase) * 14.0, -1.0, 1.0) * marlineHitch * ropeLayFade, isBoltRope);
    n = normalize(n + ropeTang * (dStrand * 0.34 + dHitch * 0.28) + ropeBitang * (dStrand * 0.24));
    ${damaged?`if(in.damage>0.25){
      albedo*=mix(1.0,0.45+0.35*ropeFray(p),clamp(in.damage,0.0,1.0));
      rough=0.96;
    }`:''}
  }
  if(in.material == 4u) { albedo=vec3f(0.012,0.009,0.006); rough=0.92; }
  if(isIron){albedo=iron.albedo;rough=iron.rough;metal=iron.bare;}
  if(in.material == 9u || in.material == 13u) {
    let weave=sin(in.uv.x*1400.0)*sin(in.uv.y*1800.0)*(1.0-smoothstep(0.0004,0.003,weaveAA));
    let aged=0.94+0.045*gnoise(in.uv*vec2f(21.0,16.0));
    let panelTone=0.985+0.03*fract(sin(floor(in.uv.x*10.0)*91.7)*43758.5);
    let seam=1.0-smoothstep(0.004,0.013+clothAA,clothSeam);
    let hem=1.0-smoothstep(0.006,0.014+edgeAA,clothEdge);
    // Optical depth: overlapped stitching, reef bands, corner tabling patches and doubled edge cloth
    // block more light, while surface-gradient normal relief gives each cloth panel 3D pillowing.
    let stitchShade=1.0 - 0.13*seam - 0.09*hem - 0.08*reefBand - 0.06*cornerPatch - 0.22*reefGrommet;
    albedo=vec3f(0.58,0.55,0.48)*aged*panelTone*stitchShade*(1.0+0.025*weave);
    let baseClothN=normalize(in.normal)*select(-1.0,1.0,front);
    n=normalize(baseClothN - clamp(canvasGradient,vec3f(-0.24),vec3f(0.24)));
    rough=0.93;
    ${damaged?`if(in.damage>0.04){
      let tear=canvasTear(in.uv,p,in.material,in.damage);
      let rimBand=smoothstep(tear.threshold-0.16,tear.threshold,tear.value);
      if(rimBand>0.01){
        let frayWave=sin(in.uv.x*520.0+tear.fray*12.0)*0.5+0.5;
        let scorchMix=clamp(in.damage*0.55,0.15,0.72);
        let frayedColor=mix(vec3f(0.66,0.62,0.53),vec3f(0.14,0.11,0.08),scorchMix*(1.0-frayWave*0.45));
        albedo=mix(albedo,frayedColor,rimBand*0.88);
        let ripTang=normalize(cross(n,vec3f(0.0,1.0,0.0))+vec3f(0.001,0.0,0.0));
        n=normalize(n+ripTang*(tear.fray-0.5)*rimBand*0.65);
        rough=0.99;
      }
    }`:''}
  }
  var windowPaneMask = 1.0;
  var windowHoleMask = 0.0;
  var windowShardRim = 0.0;
  if(in.material == 11u) {
    // Georgian stern/quarter-gallery sash muntin grid (individual crown-glass panes)
    let isTransomWin = abs(in.normalLocal.z) > 0.45;
    let sashU = select(p.z * 34.0, p.x * 36.0, isTransomWin);
    let sashV = p.y * 28.0;
    let paneCoord = vec2f(sashU, sashV);
    let paneId = floor(paneCoord);
    let paneUV = fract(paneCoord) - vec2f(0.5);
    let paneEdge = min(0.5 - abs(paneUV.x), 0.5 - abs(paneUV.y));
    let muntinAA = max(ropeAA * 16.0, 0.015);
    // Fine painted wood glazing bars (muntins) between crown-glass panes
    windowPaneMask = smoothstep(0.038, 0.068 + muntinAA, paneEdge);
    let paneHash = fract(sin(dot(paneId, vec2f(127.1, 311.7))) * 43758.5453);
    let paneHash2 = fract(sin(dot(paneId, vec2f(269.5, 183.3))) * 43758.5453);
    // Hand-blown 18th-century crown glass has a slight bullseye meniscus curvature per pane
    // aligned to the window's horizontal tangent (X on stern transom, Z on quarter galleries).
    let rippleH = (paneUV.x * 0.11 + (paneHash - 0.5) * 0.06) * windowPaneMask;
    let rippleV = (paneUV.y * 0.11 + (paneHash2 - 0.5) * 0.06) * windowPaneMask;
    let crownRipple = select(vec3f(0.0, rippleV, rippleH), vec3f(rippleH, rippleV, 0.0), isTransomWin);
    n = normalize(n + rotateHull(crownRipple));
    let muntinColor = vec3f(0.42, 0.24, 0.055);
    let glassBase = vec3f(0.014, 0.028, 0.032);
    albedo = mix(muntinColor, glassBase, windowPaneMask);
    rough = mix(0.52, 0.065, windowPaneMask);
    metal = mix(0.35, 0.18, windowPaneMask);
  }
  if(in.material == 14u) { albedo*=0.6; }
  if(in.material == 15u) {
    albedo*=.93;
    let tar=(1.0-smoothstep(-0.75,-0.2,p.y)); albedo=mix(albedo,vec3f(0.025,0.022,0.018),tar*0.9);
    if(isAdditionalIberian) {
      let frameWeight = clamp(castleMoulding + castleFuttock * 0.88, 0.0, 1.0);
      if(frameWeight > 0.01) {
        albedo = mix(albedo, timber * vec3f(0.20, 0.18, 0.15), frameWeight);
        rough = mix(rough, 0.90, frameWeight);
      }
    }
  }
  if(in.material == 16u) { albedo=timber*vec3f(.20,.18,.15); }
  if(in.material == 17u) { albedo=timber*vec3f(1.10,1.0,.80); }
  // Dynamic waterline wave-lap capillary meniscus on exterior hull planking and sheathing
  let waterSurfY = select(0.0, oceanHeight(in.world.xz), !vesselWaterCapture && in.world.y < 2.2);
  let waveMeniscus = select(0.0, smoothstep(0.28, 0.0, abs(in.world.y - waterSurfY)) * step(waterSurfY - 0.06, in.world.y), !vesselWaterCapture && in.world.y < 2.2 && abs(p.x) > 0.18);
  wet = max(wet, vec2f(waveMeniscus * 0.65, waveMeniscus * 0.82));
  if(in.material==2u || in.material==12u || in.material==19u){
    albedo*=mix(1.0,.58,wet.x);rough=mix(rough,.65,wet.x);
  }else if(in.material==9u || in.material==13u){
    albedo*=mix(1.0,.72,wet.x);rough=mix(.93,.82,wet.x);
  }else if(in.material!=3u && in.material!=4u && in.material!=8u && in.material!=11u && !isCopper && !isGilt){
    // Absorbed moisture darkens coarse timber without varnishing it. Only the
    // transient surface film glints; grain valleys retain more water than ridges.
    let timberMoisture=vesselWoodOptics(rough,wet.x,wet.y,relief,grain);
    albedo*=timberMoisture.x;rough=timberMoisture.y;
  }
  var craterLightMul = 1.0;
  ${damaged?`
  let craterCount = u32(hullDamage.level.w);
  let isSternSurface = p.z > 4.2 && (isWood || paintedWood || in.material == 11u || in.material == 25u);
  let isSuperstructureWall = p.y > 0.45 && (isWood || paintedWood || in.material == 11u) && abs(in.normalLocal.y) < 0.68;
  let canCrater = ((isWood || paintedWood || in.material == 22u) && abs(p.x) > 0.22 && abs(in.normalLocal.x) > 0.16) || isSternSurface || isSuperstructureWall;
  var maxRim = 0.0;
  var maxPocket = 0.0;
  var maxBreach = 0.0;
  if (craterCount > 0u && canCrater) {
    let strakeH = 0.054;
    let strakeRow = floor(p.y / strakeH);
    let strakeFract = fract(p.y / strakeH);
    let strakeSeamDist = abs(strakeFract - 0.5);
    var noiseReady = false;
    var splFine = 0.0;
    var splMed = 0.0;
    var toothWave = 0.0;
    var splinterJag = 0.0;

    var bestDy = 0.0;
    var bestDz = 0.0;
    var bestCr = 0.068;
    var bestHits = 1.0;
    var bestDepth = 0.18;

    for (var ci = 0u; ci < craterCount; ci++) {
      let crater = hullDamage.craters[ci];
      let cx = crater.at.x;
      let cy = crater.at.y;
      let dy = p.y - cy;
      if (abs(dy) > 0.32) { continue; }
      let cz = crater.at.z;
      let isSternCrater = cz > 4.2 && p.z > 4.2;
      let isTransverseWall = abs(in.normalLocal.z) > 0.45 && abs(p.z - cz) < 0.34;
      let isCenterSuperstructure = p.y > 0.45 && abs(cx) < 0.75 && abs(p.x - cx) < 0.45;
      if (!isSternCrater && !isTransverseWall && !isCenterSuperstructure && cx * p.x <= 0.0) { continue; }
      if ((isSternCrater || isTransverseWall) && abs(p.x - cx) > 0.45) { continue; }
      let dz = select(p.z - cz, p.x - cx, (isSternCrater || isTransverseWall) && abs(in.normalLocal.z) > 0.45);
      if (abs(dz) > 0.46) { continue; }
      if (!noiseReady) {
        splFine = gnoise(vec2f(p.z * 44.0, p.y * 240.0));
        splMed = gnoise(vec2f(p.z * 18.0 + strakeRow * 4.3, p.y * 92.0));
        toothWave = gnoise(vec2f(strakeRow * 19.3 + floor(p.z * 8.0) * 7.1, p.y * 360.0));
        splinterJag = (splFine - 0.48) * 0.46 + (toothWave - 0.48) * 0.42;
        noiseReady = true;
      }

      let w3 = crater.packed;
      let cr = max(0.052, f32(w3 & 0xFFFu) / 4000.0);
      let cDepth = f32((w3 >> 12u) & 0xFFFu) / 1000.0;
      let cHits = f32(max(1u, (w3 >> 24u) & 0xFFu));

      // Stair-stepped horizontal strake fracture: each plank course snaps at a staggered
      // fore/aft offset with sharp horizontal splinter fingers projecting into the break.
      let crRowHash = fract(sin(strakeRow * 73.1 + floor(cz * 11.0) * 19.7) * 15731.3) - 0.5;
      let rowCenterY = (strakeRow + 0.5) * strakeH;
      let ayRaw = abs(dy) / (cr * 0.88);
      let ayQuant = abs(rowCenterY - cy) / (cr * 0.88);
      let ayStepped = mix(ayRaw, ayQuant, 0.52);
      let azRaw = abs(dz - crRowHash * cr * 0.44) / (cr * (1.22 + abs(crRowHash) * 0.42));
      let azJagged = max(0.0, azRaw - splinterJag * 0.48);
      let dPlank = max(ayStepped * 0.96, azJagged * 0.88 + ayStepped * 0.24);

      let seamReach = 1.45 + min(0.75, (cHits - 1.0) * 0.25);
      let seamSplit = smoothstep(0.37, 0.48, strakeSeamDist) * (1.0 - smoothstep(0.50, seamReach, azRaw)) * (1.0 - smoothstep(0.28, 0.96, ayRaw));
      let rimW = max(seamSplit * 0.90, 1.0 - smoothstep(0.66, 1.18, dPlank));
      if (rimW > maxRim) {
        maxRim = rimW;
        bestDy = dy;
        bestDz = dz;
        bestCr = cr;
        bestHits = max(bestHits, cHits);
        bestDepth = max(bestDepth, cDepth);
      }
      let pocketW = 1.0 - smoothstep(0.56, 0.74, dPlank);
      if (pocketW > maxPocket) {
        maxPocket = pocketW;
        bestDy = dy;
        bestDz = dz;
        bestCr = cr;
        bestHits = max(bestHits, cHits);
        bestDepth = max(bestDepth, cDepth);
      }
      let penetrated = cDepth >= 0.22 || cHits >= 1.5;
      let coreOpen = select(0.16, min(0.64, 0.38 + (cHits - 1.0) * 0.09), penetrated);
      let breachW = 1.0 - smoothstep(coreOpen - 0.12, coreOpen + 0.08, dPlank + (splFine - 0.5) * 0.18);
      if (breachW > maxBreach) {
        maxBreach = breachW;
        bestHits = max(bestHits, cHits);
        bestDepth = max(bestDepth, cDepth);
      }
    }

    if (maxRim > 0.01 && in.material != 11u) {
      let seamDark = smoothstep(0.38, 0.49, strakeSeamDist);
      let grainTone = clamp(0.44 + 0.82 * splFine + 0.36 * (splMed - 0.5), 0.18, 1.38);
      let freshOak = mix(vec3f(0.26, 0.15, 0.065), vec3f(0.76, 0.52, 0.25), clamp(grainTone * 0.78, 0.0, 1.0)) * (1.0 - 0.62 * seamDark);
      let stripPaint = smoothstep(0.08, 0.34, maxRim);
      albedo = mix(albedo, freshOak, stripPaint);
      rough = clamp(rough + stripPaint * 0.15, 0.04, 0.98);
      metal *= 1.0 - stripPaint * 0.92;

      // 3D beveled outer plank thickness: upper broken plank edge faces down into shadow,
      // lower broken plank edge faces up to catch bright sunlight, splinter tips catch grazing light.
      let bevelBand = stripPaint * (1.0 - maxPocket * 0.80);
      let dyNorm = clamp(bestDy / max(bestCr, 0.05), -1.25, 1.25);
      let dzNorm = clamp(bestDz / max(bestCr, 0.05), -1.25, 1.25);
      var localDeltaN = vec3f(
        -sign(p.x) * 0.35 * bevelBand,
        (-dyNorm * 0.95 + (splFine - 0.5) * 0.55) * bevelBand,
        (-dzNorm * 0.82 + (toothWave - 0.5) * 0.45) * bevelBand
      );

      if (maxPocket > 0.01) {
        // Layer 2: Recessed vertical English oak futtock framing ribs (62% fill) and
        // horizontal inner ceiling boards behind the ribs.
        let ribCoord = (p.z + 0.025) / 0.132;
        let ribFract = fract(ribCoord);
        let ribSigned = (ribFract - 0.5) * 2.0;
        let isRib = 1.0 - smoothstep(0.56, 0.68, abs(ribSigned));
        let ribEdgeShadow = smoothstep(0.45, 0.68, abs(ribSigned)) * isRib;
        let ribGrain = gnoise(vec2f(p.z * 230.0, p.y * 32.0));
        let futtockOak = mix(vec3f(0.24, 0.14, 0.06), vec3f(0.54, 0.35, 0.16), clamp(0.36 + 0.78 * ribGrain, 0.0, 1.0)) * (1.0 - 0.35 * ribEdgeShadow);
        let ceilingSeam = smoothstep(0.38, 0.49, abs(fract(p.y / 0.068) - 0.5));
        let backingCeiling = mix(vec3f(0.14, 0.082, 0.036), vec3f(0.32, 0.19, 0.085), clamp(0.35 + 0.65 * splFine, 0.0, 1.0)) * (1.0 - 0.55 * ceilingSeam);
        let lipShadow = clamp(smoothstep(-0.18, 0.48, dyNorm) * 0.42 + smoothstep(0.38, 0.82, abs(dzNorm)) * 0.20, 0.0, 0.54);
        let frameTimber = mix(backingCeiling, futtockOak, isRib) * (1.0 - lipShadow);

        // Layer 3: Spent/grazing shots (bestDepth < 0.22 && bestHits < 1.5) dent/splinter the outer
        // planking while leaving the vertical futtock ribs intact; point-blank hits (bestDepth >= 0.22)
        // punch a central through-breach into the dark gun-deck interior, and 2nd/3rd+ hits tear the
        // breach wider across multiple strakes and framing ribs.
        let ribStumpJag = (ribGrain - 0.45) * 0.28 + (toothWave - 0.5) * 0.22;
        let isPenetrated = bestDepth >= 0.22 || bestHits >= 1.5;
        let ribFractured = select(
          (1.0 - isRib) * 0.45,
          smoothstep(0.14, 0.46, maxBreach - isRib * 0.12 + ribStumpJag),
          isPenetrated
        );
        let cavityMask = clamp(maxBreach * ribFractured, 0.0, 1.0);
        let innerKnee = gnoise(vec2f((p.z + p.y) * 28.0, (p.y - p.z) * 28.0));
        let innerStructure = mix(vec3f(0.042, 0.026, 0.012), vec3f(0.16, 0.095, 0.042), clamp(0.25 + 0.75 * innerKnee, 0.0, 1.0));
        let deepCavity = mix(innerStructure, vec3f(0.018, 0.012, 0.006), clamp((bestDepth - 0.20) * 1.4 + (bestHits - 1.0) * 0.24, 0.0, 0.78));
        let pocketColor = mix(frameTimber, deepCavity, cavityMask);

        albedo = mix(albedo, pocketColor, maxPocket);
        rough = mix(rough, 0.94, maxPocket);
        craterLightMul = mix(1.0, mix(0.76, 0.24, cavityMask), maxPocket);

        let ribBevelZ = -ribSigned * isRib * (1.0 - cavityMask * 0.7) * 0.75;
        let stumpBevelY = -dyNorm * (0.45 + 0.40 * cavityMask);
        localDeltaN += vec3f(-sign(p.x) * 0.42 * maxPocket, stumpBevelY * maxPocket, ribBevelZ * maxPocket);
      }
      n = normalize(n + rotateHull(localDeltaN));
    }
  } else {
    let dmg=clamp(in.damage,0.0,1.5);
    if(dmg>0.01 && in.material != 11u){
      let splNoise=gnoise(vec2f(p.z*22.0+p.y*7.0,p.y*54.0-p.x*19.0));
      let splFine=gnoise(vec2f(p.z*95.0,p.y*185.0+splNoise*4.5));
      let strakeSplit=smoothstep(0.32,0.48,abs(fract(p.y*14.0+splNoise*0.25)-0.5));
      let rawOak=mix(timber*vec3f(1.38,0.98,0.56),vec3f(0.68,0.48,0.23),0.45)*(0.72+0.52*splFine)*(1.0-0.45*strakeSplit);
      let stripPaint=smoothstep(0.08,0.34,dmg+splNoise*0.12);
      if(isWood || paintedWood){
        albedo=mix(albedo,rawOak,stripPaint);
      }
      let rimScorch=smoothstep(0.06,0.22,dmg)*(1.0-smoothstep(0.28,0.55,dmg));
      albedo*=mix(1.0,0.52,rimScorch);
      let deepCavity=smoothstep(0.55,1.35,dmg+splNoise*0.10);
      let charredInterior=rawOak*0.18+vec3f(0.028,0.020,0.014);
      albedo=mix(albedo,charredInterior,deepCavity*0.88);
      rough=clamp(rough+stripPaint*0.18,0.04,0.99);
      metal*=1.0-stripPaint*0.85;
    }
  }

  // Unified stern & quarter-gallery window glass shattering (driven by both vertex damage and hull craters)
  if (in.material == 11u) {
    let winDmg = max(clamp(in.damage, 0.0, 1.5), maxRim * 1.35);
    if (winDmg > 0.04) {
      let sashU = select(p.z * 34.0, p.x * 36.0, abs(in.normalLocal.z) > 0.45);
      let sashV = p.y * 28.0;
      let paneCoord = vec2f(sashU, sashV);
      let paneId = floor(paneCoord);
      let paneUV = fract(paneCoord) - vec2f(0.5);
      let paneHash = fract(sin(dot(paneId, vec2f(127.1, 311.7))) * 43758.5453);
      let angle = atan2(paneUV.y, paneUV.x);
      // Angular jagged triangular glass teeth clinging to the muntin putty frame
      let shardRay = sin(angle * 7.0 + paneHash * 18.0) * 0.55 + cos(angle * 13.0 - paneHash * 29.0) * 0.45;
      let radialDist = length(paneUV * vec2f(1.08, 0.94));
      let paneBreakSeverity = winDmg + (paneHash - 0.38) * 0.42;
      let holeRadius = clamp((paneBreakSeverity - 0.18) * 0.62, 0.0, 0.52);
      let jaggedBoundary = holeRadius * (0.72 + 0.34 * shardRay);
      windowHoleMask = windowPaneMask * (1.0 - smoothstep(jaggedBoundary - 0.045, jaggedBoundary + 0.035, radialDist));
      // Spiderweb radial & concentric stress cracks in surviving glass shards
      let radialCrack = 1.0 - smoothstep(0.0, 0.085, abs(sin(angle * 6.0 + paneHash * 12.0 + radialDist * 4.5)));
      let ringCrack = 1.0 - smoothstep(0.0, 0.06, abs(fract(radialDist * 5.5 + shardRay * 0.22) - 0.5));
      let shardRimBand = windowPaneMask * (1.0 - windowHoleMask) * smoothstep(0.04, 0.45, paneBreakSeverity);
      let crackTrace = clamp((radialCrack * 0.72 + ringCrack * 0.48) * shardRimBand, 0.0, 1.0);
      let edgeBevel = windowPaneMask * (1.0 - windowHoleMask) * (1.0 - smoothstep(jaggedBoundary, jaggedBoundary + 0.14, radialDist)) * step(0.04, holeRadius);
      windowShardRim = clamp(edgeBevel + crackTrace * 0.75, 0.0, 1.0);
      let frostedShard = mix(vec3f(0.58, 0.68, 0.72), vec3f(0.92, 0.96, 0.98), clamp(edgeBevel * 1.2 + shardRay * 0.3, 0.0, 1.0));
      let darkCabinVoid = vec3f(0.008, 0.006, 0.005);
      albedo = mix(mix(albedo, frostedShard, windowShardRim * 0.88), darkCabinVoid, windowHoleMask);
      rough = mix(mix(rough, 0.18, windowShardRim), 0.98, windowHoleMask);
      metal = mix(metal, 0.0, max(windowHoleMask, windowShardRim * 0.5));
      craterLightMul = mix(1.0, 0.12, windowHoleMask);
      // Tilt surviving shard normals so broken glass teeth glint sharply in sunlight/candlelight
      let shardTilt = vec3f(
        cos(angle * 5.0 + paneHash * 9.0) * 0.48 * windowShardRim,
        sin(angle * 5.0 - paneHash * 7.0) * 0.48 * windowShardRim,
        0.22 * windowShardRim
      );
      n = normalize(n + rotateHull(shardTilt));
    }
  }
  `:''}
  let v=normalize(F.camPos.xyz-in.world); let l=F.sunDir.xyz;
  let nl=clamp(dot(n,l),0.0,1.0);
  ${damaged?`if(holeRim>0.0){
    albedo=mix(albedo,vec3f(.46,.33,.2)*(.55+.9*gnoise(vec2f(p.z*90.0,p.y*140.0))),holeRim);
    rough=max(rough,.92);
  }`:''}
  var f0=mix(vec3f(0.04),albedo,metal);
  if(isWood && metal<0.1){f0=vec3f(vesselWoodDielectricF0());}
  if(in.material==11u){f0=max(f0,vec3f(0.045));}
  if(isIron){
    f0=iron.f0;
    // The oxide's dielectric boundary changes medium too. Bare-metal F0 stays
    // the bounded authored conductor approximation; complex-IOR recalibration
    // and underwater multiple scattering are not provided by this material.
    if(vesselWaterCapture){f0=mix(vec3f(vesselWoodDielectricF0()),vec3f(0.55,0.57,0.57),iron.bare);}
  }
  let shadowSample=vesselShadow(in.world,shadowNormal);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,l.y)*solarShadowVisibility(shadowSample);
  // The last cube mip is a face average, not diffuse irradiance. Sampling it
  // along a vertical timber normal mixes in the sea, then counts that green
  // light again below. Use separate sky/sea hemispheres and their projected
  // visibility instead; keep directional ocean reflections in the specular term.
  var sky:vec3f;var reflected:vec3f;var bounce:vec3f;
  if(vesselWaterCapture&&F.screen.x>=0.0){
    // Low-frequency transmitted-ambient proxy, subsequently attenuated on the
    // light/view water legs by the common optics passes. It intentionally has
    // no directionally reflected image of the AIR sky or ocean. Snell-window
    // IBL and offscreen underwater transport require a separate renderer.
    sky=skyAtmo(vec3f(0,1,0));bounce=sky*0.08;
    reflected=vesselAmbient(n,sky,bounce);
  }else{
    // The invalid-dimensions fallback keeps the original resources reachable
    // to automatic layout reflection, matching the capture fog bypass pattern.
    sky=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),${ENV_MIPS - 1}.0).rgb;
    reflected=waterLight(in.world,reflect(-v,n),rough);
    bounce=waterLight(in.world,normalize(vec3f(n.x,-0.65,n.z)),0.9);
  }
  let skyVisibility=0.5+0.5*n.y;
  let ambient=vesselAmbient(n,sky,bounce);
  let ao=mix(0.65,1.0,smoothstep(0.72,1.5,p.y));
  let spec=vesselSpecular(n,v,l,rough,f0);
  var diffuse=albedo*(1.0-metal);
  var diffuseAmbient=diffuse;
  var directTransmission=craterLightMul;var environmentTransmission=craterLightMul;
  if(isIron){
    let halfVector=(v+l)/max(length(v+l),0.00001);
    let oxideF0=vesselWoodDielectricF0();
    diffuse*=vec3f(1)-vesselFresnel(vec3f(oxideF0),max(dot(v,halfVector),0.0));
    diffuseAmbient*=1.0-oxideF0;
    directTransmission=vesselIronTransmission(iron.film,max(dot(n,v),0.0),nl);
    // The host's environment mip chain is not GGX-convolved. This remains a
    // bounded two-pass attenuation approximation, not a split-sum IBL integral.
    environmentTransmission=vesselIronTransmission(iron.film,max(dot(n,v),0.0),max(dot(n,v),0.0));
  }
  // Below the deck and facing inboard is the hold, and it is dark.
  ${damaged?'if(holedTimber && p.y<deckFloor(p.z)+.06 && (!front || in.normalLocal.x*sign(p.x)< -.2)){directTransmission*=.04;environmentTransmission*=.1;}':''}
  var col=(diffuse/PI+spec)*direct*nl*directTransmission;
  col+=(diffuseAmbient*ambient*ao + reflected*F.windP[1].w*vesselEnvironment(n,v,rough,f0))*environmentTransmission;
  // Grazing-angle flax & hemp micro-fibre fuzz rim sheen on sails and ropes
  if(in.material==2u || in.material==12u || in.material==19u || in.material==9u || in.material==13u){
    let grazing=1.0-clamp(dot(n,v),0.0,1.0);
    let g2=grazing*grazing;
    let isRopeMat = in.material==2u || in.material==12u || in.material==19u;
    let rimBacklight = select(nl, max(nl, 0.28 + 0.72 * clamp(dot(-v, l), 0.0, 1.0)), isRopeMat);
    let sheenTint = select(albedo, mix(albedo, vec3f(0.62, 0.48, 0.28), select(0.35, 0.14, in.material==2u)), isRopeMat);
    let fiberSheen=g2*g2*(1.0-wet.x*0.65)*select(0.038, 0.115, isRopeMat);
    col+=(direct*rimBacklight + ambient*0.42)*sheenTint*fiberSheen*directTransmission;
  }
  // Upward-reflected solar water-caustic shimmer on lower hull planks & overhanging stern counters
  if(!vesselWaterCapture && l.y>0.02 && in.world.y>waterSurfY-0.05 && in.world.y<waterSurfY+3.2 && n.y<0.35 && abs(p.x)>0.18){
    let hAbove=max(0.0,in.world.y-waterSurfY);
    let cFade=(1.0-smoothstep(0.0,3.2,hAbove))*clamp(0.42-n.y,0.0,1.0)*step(0.0,dot(vec3f(l.x,0.0,l.z),vec3f(n.x,0.0,n.z))+0.35);
    if(cFade>0.005){
      let ct=hull.origin.w*1.65;
      let cw1=sin(in.world.x*3.4+in.world.z*2.7+ct)+cos(in.world.z*4.1-in.world.x*2.3-ct*1.2);
      let cw2=sin(in.world.x*6.2-in.world.z*5.1+ct*1.7)*cos(in.world.z*5.8+in.world.x*4.9-ct*1.4);
      let causticNet=smoothstep(0.45,1.65,cw1*0.6+cw2*0.85);
      col+=sunIlluminance()*sunVis[0]*l.y*diffuse*(causticNet*cFade*0.095*directTransmission);
    }
  }
  if(!vesselWaterCapture&&isIron&&iron.film>0.0001){
    let filmF0=vec3f(vesselIronWaterF0);
    col+=iron.film*vesselSpecular(n,v,l,iron.filmRough,filmF0)*direct*nl;
    let filmReflection=waterLight(in.world,reflect(-v,n),iron.filmRough);
    col+=iron.film*filmReflection*F.windP[1].w*vesselEnvironment(n,v,iron.filmRough,filmF0);
  }
  if(in.material == 9u || in.material == 13u) {
    let through=max(dot(-n,l),0.0);
    // Thin canvas transmits light without revealing the background. Beer
    // attenuation makes grazing rays and doubled cloth denser; blue absorption
    // gives unbleached canvas a warm glow. These are authored, not measured,
    // fabric coefficients. The view-facing normal makes both sides equivalent.
    let opticalDepth=vec3f(0.90,1.15,1.60)*canvasDepth;
    let transmitted=canvasTransmission(canvasDepth,through);
    let alignment=max(dot(-v,l),0.0);
    // A diffuse lobe plus a broad, normalized forward lobe around the sun.
    let scatter=0.70/PI+0.30*(34.0/(2.0*PI))*pow(alignment,32.0);
    col+=direct*transmitted*through*scatter;
    let behind=sky*(1.0-skyVisibility)+bounce*0.22*skyVisibility;
    col+=behind*exp(-opticalDepth)*0.7;
  }
  let moonVisibility=sunVis[1]*lunarShadowVisibility(shadowSample);
  col+=lunarSurface(n,v,diffuse,rough,f0,moonVisibility);
  if(in.material==9u||in.material==13u){
    let ml=lunarDirection();let throughMoon=max(dot(-n,ml),0.0);
    let moonScatter=.70/PI+.30*(34.0/(2.0*PI))*pow(max(dot(-v,ml),0.0),32.0);
    col+=lunarIlluminance()*moonVisibility*canvasTransmission(canvasDepth,throughMoon)*throughMoon*moonScatter;
  }
  col+=lightningSurface(n,v,albedo,rough)+gunFlashSurface(in.world,n,v,albedo,rough)+worldFireSurface(in.world,n,v,albedo,rough);
  if(in.material==9u || in.material==13u){col+=lightningLight()*albedo*max(dot(-n,lightningDirection()),0.0)*.12;}
  // Captain's & Admiral's cabin candle lanterns glowing through stern and quarter-gallery windows
  // in the evening, night, and early morning (compensated for night exposure so they never cause bloom glare).
  if(!vesselWaterCapture){
    let candleSchedule=1.0-smoothstep(-0.04,0.12,F.sunDir.y);
    if(candleSchedule>0.001){
      let candleExposure=1.0/max(F.post.x,1.0);
      if(in.material==11u){
        let bayX=select(floor(p.z*5.2),floor((p.x+1.0)*4.5),abs(in.normalLocal.z)>0.45);
        let bayY=floor((p.y-0.65)/0.50);
        let baySeed=fract(sin(bayX*37.1+bayY*91.7)*43758.5453);
        // Individual cabin bays have hanging gimbaled beeswax candle lanterns with gentle flicker
        let t=hull.origin.w;
        let flicker=0.84+0.10*sin(t*6.2+baySeed*19.3)+0.06*sin(t*14.7-baySeed*31.1)+0.04*cos(t*22.9+baySeed*7.3);
        let localU=select(fract(p.z*5.2),fract((p.x+1.0)*4.5),abs(in.normalLocal.z)>0.45)-0.5;
        let tierCenter=0.89+clamp(bayY,0.0,2.0)*0.51;
        let localV=(p.y-tierCenter)/0.24;
        // View-dependent interior parallax shifts the hanging candle flame inside the cabin
        let viewLocal=vec3f(dot(v,hull.right.xyz),dot(v,hull.up.xyz),dot(v,-hull.forward.xyz));
        let parallax=clamp(viewLocal.xy/max(abs(dot(n,v)),0.28),vec2f(-0.45),vec2f(0.45))*0.14;
        let flamePos=vec2f((baySeed-0.5)*0.22-parallax.x,-0.08-parallax.y*0.6);
        let dFlame=length((vec2f(localU,localV)-flamePos)*vec2f(1.15,1.35));
        let flameCore=exp(-dFlame*dFlame*18.0);
        let lanternHalo=exp(-dFlame*dFlame*3.4);
        let ceilingWarmth=smoothstep(-0.45,0.45,localV)*0.38+0.42;
        let candleColor=vec3f(0.42,0.19,0.045)*flameCore+vec3f(0.18,0.078,0.018)*lanternHalo+vec3f(0.065,0.026,0.006)*ceilingWarmth;
        // Intact crown-glass panes attenuate and softly diffuse the candle; shattered holes expose the raw flame
        let transmission=mix(windowPaneMask*0.78,1.15,windowHoleMask)+windowShardRim*0.65;
        col+=candleColor*(candleSchedule*flicker*transmission*candleExposure);
      }else if(hull.rig.w>.5 && p.z>5.15 && p.y>0.72 && (in.material==25u || in.material==21u || in.material==20u)){
        // Warm candlelight spill onto the gilded stern mullions, balusters, and window frames
        let spillFlicker=0.88+0.08*sin(hull.origin.w*6.8+p.x*5.0+p.y*7.0);
        let mullionWeight=select(0.025,0.055,in.material==25u);
        let facingUpOrIn=clamp(0.55-0.35*in.normalLocal.y,0.15,0.85);
        col+=vec3f(0.45,0.19,0.04)*(candleSchedule*spillFlicker*mullionWeight*facingUpOrIn*candleExposure);
      }
    }
  }
  col=surfaceAir(col,in.world);
  return vec4f(col,1.0);
}
`; }
export const CARAVEL = vesselSource(false);
export const CARAVEL_DAMAGED = vesselSource(true);

// HDR mip chain suppresses raw single-pixel sun glints in rough timber reflections.
export const WATER_FILTER = SANE_HDR + /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size=textureDimensions(dst); if(any(id.xy>=size)){return;}
  let extent=vec2i(textureDimensions(src))-1;
  let base=vec2i(id.xy)*2;
  let a=textureLoad(src,min(base,extent),0).rgb;
  let b=textureLoad(src,min(base+vec2i(1,0),extent),0).rgb;
  let c=textureLoad(src,min(base+vec2i(0,1),extent),0).rgb;
  let d=textureLoad(src,min(base+vec2i(1,1),extent),0).rgb;
  let weights=1.0/(vec4f(dot(a,vec3f(0.2126,0.7152,0.0722)),dot(b,vec3f(0.2126,0.7152,0.0722)),dot(c,vec3f(0.2126,0.7152,0.0722)),dot(d,vec3f(0.2126,0.7152,0.0722)))*0.03+1.0);
  // Infinity weighs nothing here, and nothing times infinity is NaN: one bad pixel must not reach a hull.
  let color=saneHDR((a*weights.x+b*weights.y+c*weights.z+d*weights.w)/dot(weights,vec4f(1.0)));
  textureStore(dst,vec2i(id.xy),vec4f(color,1.0));
}
`;
