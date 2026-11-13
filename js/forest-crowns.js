// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Far crowns: where a tree's leaf cards can no longer be told apart, one closed progressive surface stands
// for all of them, and one column for the trunk beneath. scripts/prepare-forest-crowns.mjs bakes a single
// genus-0 base mesh per species plus its continuous half-edge collapse sequence down to a 4-triangle core
// and 1-triangle horizon splat; js/forest-clusters.js decimates each tree smoothly on the GPU by eye-angle
// pixel span down to 1 pixel. A tree wholly in its crown draws no cluster of leaf or wood.

export const FOREST_CROWN_VERSION = 3;
export const FOREST_CROWN_STEP_WORDS = 4;
export const FOREST_CROWN_SPLAT_PIXELS = 3.5;
export const FOREST_CROWN_MIN_PIXELS = 1.0;
// A crown's single base mesh packs vertices as cluster vertices (packForestClusterVertex in js/forest-clusters.js),
// while morph.bin stores 4-word progressive collapse step headers and u8 cumulative vertex ancestor maps.
const CROWN_VERTEX_WORDS = 5;

// Literal paths: build.mjs finds what to publish by reading them from the source.
// Saba has no entry. Its far trees already wear the crown shells of js/forest-volume.js.
export const PORTUGAL_FOREST_CROWN_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/crowns/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/portugal/crowns/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/portugal/crowns/indices.bin.gz',
  'morph.bin.gz': 'assets/forest-scenery/portugal/crowns/morph.bin.gz',
});
export const SUBTROPICAL_FOREST_CROWN_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/crowns/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/subtropical/crowns/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/subtropical/crowns/indices.bin.gz',
  'morph.bin.gz': 'assets/forest-scenery/subtropical/crowns/morph.bin.gz',
});

export function validateForestCrowns(manifest) {
  if (manifest?.format !== 'waterworld.forest-crowns' || manifest.version !== FOREST_CROWN_VERSION || manifest.vertexWords !== CROWN_VERTEX_WORDS || manifest.stepHeaderWords !== FOREST_CROWN_STEP_WORDS || !(manifest.morphWordCount > 0)) throw Error('Invalid forest crown manifest');
  if (!Array.isArray(manifest.prototypes) || !manifest.prototypes.length) throw Error('Forest crowns hold no trees');
  if (manifest.widestLeafErrors !== undefined && !(manifest.widestLeafErrors > 0)) throw Error('Forest crowns name no breadth to change at');
  for (const p of manifest.prototypes) {
    if (!(p.vertexCount > 0) || p.vertexCount >= 250 || p.firstVertex + p.vertexCount > manifest.vertexCount) throw Error(`Forest crown vertices are malformed: ${p.species}`);
    if (!(p.baseIndexCount >= 12) || p.baseIndexCount % 3 || p.firstIndex + p.baseIndexCount > manifest.indexCount) throw Error(`Forest crown indices are malformed: ${p.species}`);
    if (!(p.stepCount >= 1) || p.morphOffset + (p.stepCount + 1) * FOREST_CROWN_STEP_WORDS > manifest.morphWordCount) throw Error(`Forest crown continuum is malformed: ${p.species}`);
    if (!(p.leafErrorMetres > 0)) throw Error(`Forest crown names no leaf cut: ${p.species}`);
    if (!(p.breadthMetres > 0)) throw Error(`Forest crown names no breadth: ${p.species}`);
    if (!(p.posScale > 0) || !(p.look?.alike > 0) || p.look.alike > 1 || p.look.undersideGain?.length !== 3) throw Error(`Forest crown look is malformed: ${p.species}`);
    if (!p.splat || p.splat.centre?.length !== 3 || !(p.splat.rx > 0) || !(p.splat.ry > 0) || p.splat.colour?.length !== 3) throw Error(`Forest crown splat is malformed: ${p.species}`);
  }
  return manifest;
}

export async function loadForestCrowns({ assets, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Forest crowns unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = validateForestCrowns(await (await get('manifest.json')).json());
  const stream = async (name) => {
    const receipt = manifest.files[name], response = await get(`${name}.gz`);
    const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== receipt.bytes) throw Error(`Forest crown stream has the wrong size: ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error(`Forest crown stream failed verification: ${name}`);
    return bytes;
  };
  const [vertices, indices, morph] = await Promise.all(['vertices.bin', 'indices.bin', 'morph.bin'].map(stream));
  if (vertices.byteLength !== manifest.vertexCount * CROWN_VERTEX_WORDS * 4 || indices.byteLength !== manifest.indexCount * 4 || morph.byteLength !== manifest.morphWordCount * 4) throw Error('Forest crown streams do not match their manifest');
  return { manifest, vertices, indices, morph };
}

// What one species' crown shader reads: where its single base mesh and continuum table lie, and how its leaves take light.
export function forestCrownLook(info) {
  const { alike, transmission, roughness, undersideGain } = info.look;
  const buf = new ArrayBuffer(64);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  f.set([...info.low, info.posScale, alike, transmission, roughness, 0, ...undersideGain, 0], 0);
  u.set([info.firstVertex >>> 0, info.firstIndex >>> 0, info.morphOffset >>> 0, info.stepCount >>> 0], 12);
  return f;
}

// What one species' 1-triangle horizon splat reads: local foliage centre, silhouette half-extents, mean look, and trunk axis XZ.
export function forestCrownSplatLook(info) {
  const { centre, rx, ry, colour, exposure, escape, trunkAxisXZ } = info.splat;
  const tx = trunkAxisXZ ? trunkAxisXZ[0] : centre[0];
  const tz = trunkAxisXZ ? trunkAxisXZ[1] : centre[2];
  return new Float32Array([...centre, rx, ...colour, ry, exposure, escape, tx, tz]);
}

// A tree starts to wear its crown at the range where a leaf cut of error leafErrorMetres is drawn, which
// its manifest names: 330 m in a view 1117 pixels high and 58 degrees tall, and further in a sharper view
// or through a spyglass. Never nearer than FOREST_CROWN_NEAREST, short of which leaf cards have not
// reached their far shape and coverage. Over a further FOREST_CROWN_BAND of that distance the tree wears
// both, and beyond it its leaves and wood are gone. forestCrownChange is the rule of forestClusterSelect,
// for tests and for anything that must know where the change falls; leafPixels is the error the forest
// allows a leaf cluster on screen.
export const FOREST_CROWN_NEAREST = 330;
export const FOREST_CROWN_BAND = 0.3;
// Where a pack's trees stand apart on open ground its manifest also names widestLeafErrors: a crown then
// stands only for a tree no broader on screen than that many times the leaf error the forest allows, and
// a broader tree keeps its leaves until it is that small. An open ceiba 20 m across is plainly boughs and
// sky at 330 m, and a closed body that size is plainly not. In closed woods a crown is seen against other
// crowns, the manifest names none, and every tree changes at the one range.
// The share of the forest's pixel error each progressive triangle facet may span on screen before finer
// collapse steps remain active.
export const FOREST_CROWN_LIMIT = 0.7;
export function forestCrownChange({ leafErrorMetres, breadthMetres = 0, widestLeafErrors = 0, scale = 1, pixelsPerMetre, leafPixels }) {
  const broad = widestLeafErrors > 0 ? (breadthMetres * scale * pixelsPerMetre) / (leafPixels * widestLeafErrors) : 0;
  const start = Math.max(FOREST_CROWN_NEAREST, (leafErrorMetres * pixelsPerMetre) / leafPixels, broad);
  return { start, end: start * (1 + FOREST_CROWN_BAND) };
}

// Joins FOREST_VERTEX_WGSL in the land's module (js/terrain.js): it reads the cluster lists and unpacks the
// same vertex words, and forestPlace sways and fells a crown exactly as it does the leaves inside it. It
// stays out of FOREST_VERTEX_WGSL itself because it asks the land for its shadow map and the moon by name,
// which the forest's own shaders never do.
export const FOREST_CROWN_WGSL = /* wgsl */`
struct ForestCrownLook {bounds:vec4f,optics:vec4f,underside:vec4f,mesh:vec4u};
struct ForestCrownSplat {centre:vec4f,colour:vec4f,shade:vec4f};
struct ForestCrownUnpacked {pos:vec3f,lean:vec3f,shape:vec3f,col:vec3f,exposure:f32,escape:f32,wood:bool};
@group(3)@binding(5)var<uniform>forestCrown:ForestCrownLook;
@group(3)@binding(6)var<storage,read>forestCrownMorph:array<u32>;
@group(3)@binding(7)var<uniform>forestCrownSplat:ForestCrownSplat;
fn forestCrownSafeNorm(v:vec3f,fallback:vec3f)->vec3f{
 let d=dot(v,v);return select(fallback,v*inverseSqrt(max(d,1e-12)),d>1e-8);
}
fn forestCrownUnpack(gv:u32)->ForestCrownUnpacked{
 let at=gv*${CROWN_VERTEX_WORDS}u;
 let w0=forestClusterVertices[at];let w1=forestClusterVertices[at+1u];let w2=forestClusterVertices[at+2u];let w3=forestClusterVertices[at+3u];let w4=forestClusterVertices[at+4u];
 let pos=forestCrown.bounds.xyz+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))/65535.*forestCrown.bounds.w;
 let lean=forestClusterOctahedral(vec2f(f32(w2&65535u),f32(w2>>16u))/65535.*2.-1.);
 let shape=forestClusterOctahedral(vec2f(f32(w3&65535u),f32(w3>>16u))/65535.*2.-1.);
 let root=vec3f(f32(w4&255u),f32((w4>>8u)&255u),f32((w4>>16u)&255u))/255.;
 let wood=((w1>>16u)&255u)==1u;
 var u:ForestCrownUnpacked;
 u.pos=pos;u.lean=lean;u.shape=shape;u.col=root*root;u.exposure=f32(w1>>24u)/255.;u.escape=f32(w4>>24u)/255.;u.wood=wood;
 return u;
}
// A crown is lit as the leaves it stands for, not as the surface it is. Each leaf card is lit by its
// own normal, turned to face the viewer, and shows its underside from below; the leaves of one bough
// face much the same way (the vertex's normal) and differ by a known spread (optics.x, the length of
// their mean). Eight leaves around that mean, each counted by how much of it the viewer sees, give the
// light and colour a pixel full of them would average to. It is the arithmetic of forestNativeLeafFS.
const FOREST_CROWN_RING=8;
struct ForestCrownLight {colour:vec3f,kind:vec2f,leafUV:vec2f,normal:vec3f};
// The light and colour of a patch of crown at world: leaves is the way its leaves face in the mean,
// outward the way the body they make up faces there, and optics and underside are a ForestCrownLook's.
// A grove's canopy (js/forest-groves.js) is lit by it too, since it stands for the same leaves.
fn forestCrownLight(world:vec3f,leaves:vec3f,outward:vec3f,colour:vec3f,exposure:f32,escape:f32,optics:vec4f,underside:vec3f)->ForestCrownLight{
 let view=normalize(F.camPos.xyz-world);let middle=normalize(leaves);
 let side=normalize(cross(middle,select(vec3f(1.,0.,0.),vec3f(0.,0.,1.),abs(middle.x)>.9)));let other=cross(middle,side);
 let alike=clamp(optics.x,0.,1.);let spread=sqrt(1.-alike*alike);
 let moonDir=lunarDirection();
 var weight=0.;var gain=vec3f(0.);var lit=vec3f(0.);var mean=vec3f(0.);var level=0.;var moon=0.;
 for(var k=0;k<FOREST_CROWN_RING;k++){
  let a=(f32(k)+.5)*(6.2831853/f32(FOREST_CROWN_RING));
  var n=middle*alike+(side*cos(a)+other*sin(a))*spread;
  let facing=dot(n,view);let seen=abs(facing);
  if(facing<0.){n=-n;}
  let nDotL=dot(n,F.sunDir.xyz);let backlit=max(-nDotL,0.)*optics.y;
  let tint=select(underside,vec3f(1.),facing>=0.)*mix(vec3f(1.),vec3f(1.12,1.16,.78),backlit*exposure);
  gain+=tint*seen;lit+=tint*(seen*(max(nDotL,0.)+backlit));mean+=n*seen;level+=abs(n.y)*seen;moon+=max(dot(n,moonDir),0.)*seen;weight+=seen;
 }
 weight=max(weight,1e-4);mean/=weight;
 let luma=vec3f(.2126,.7152,.0722);
 var o:ForestCrownLight;
 o.colour=colour*gain/weight;
 o.kind=vec2f(dot(lit,luma)/max(dot(gain,luma),1e-4)*(.22+.78*exposure*exposure)*(.35+.65*escape),(.12+exposure*.56+level/weight*.09)*escape);
 let roughness=clamp(optics.z,.24,.92);
 // Leaves this small show no highlight of their own, so the surface is given none; a wet leaf's darker colour stays.
 o.leafUV=vec2f(clamp((1.-roughness)*.42*(.35+.65*exposure),0.,.36),max(roughness,.8));
 // The sky, the ground's bounce and the moon read the normal directly. The leaves' mean, left short of
 // unit length, is what their separate answers average to. By night the moon is the light that matters,
 // and the normal is turned so that it gives the leaves' own share of moonlight.
 var night=mean;let low=length(moonDir.xz);
 if(low>.05){let along=clamp((moon/weight-mean.y*moonDir.y)/low,-1.,1.);night=vec3f(moonDir.x/low*along,mean.y,moonDir.z/low*along);}
 o.normal=mix(mean,night,1.-smoothstep(-.12,.02,F.sunDir.y));
 // A crown is a rounded body as well as a mass of leaves. The side it turns from the sun is darker than
 // its leaves alone would say and the side it turns to the sun brighter, and its underside sees less sky
 // than its top. Over a whole crown the two factors average to one, so a wood is no lighter or darker.
 o.kind*=vec2f(mix(.68,1.36,smoothstep(-.45,.75,dot(outward,F.sunDir.xyz))),mix(.8,1.2,outward.y*.5+.5));
 return o;
}
@vertex fn forestCrownVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)vertex:u32)->ForestVertex{
 let item=forestClusterList[forestBin.x+instance];
 let r=forestRoots[item.x];
 if((forestBin.z&1024u)!=0u){
  let fade=f32(item.y>>24u)/255.;
  let corner=vertex%3u;
  let inflate=max(1.,f32((item.y>>8u)&65535u)/4096.);
  let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);let scale=r.rootScale.w;
  let localMid=forestCrownSplat.centre.xyz;
  var centreLocal=vec3f(c*localMid.x-s*localMid.z,localMid.y,s*localMid.x+c*localMid.z)*scale;
  centreLocal+=forestWind(r,centreLocal,localMid,true);
  var tint=forestCrownSplat.colour.rgb*r.yawColour.yzw;var fallen=false;
  if(r.identity.w!=0.){
   let struck=forestStruckPlace(r,localMid,centreLocal,vec3f(0.,1.,0.),tint,false);
   centreLocal=struck.local;tint=struck.colour;fallen=struck.fallen;
  }
  let centreWorld=r.rootScale.xyz+centreLocal;
  let toEye=normalize(F.camPos.xyz-centreWorld);
  let right=normalize(cross(select(vec3f(0.,1.,0.),vec3f(1.,0.,0.),abs(toEye.y)>.98),toEye));
  let up=cross(toEye,right);
  let rx=forestCrownSplat.centre.w*scale*inflate;let ry=forestCrownSplat.colour.w*scale*inflate;
  let uvCorner=select(select(vec2f(0.,1.58),vec2f(-1.325,-.79),corner==1u),vec2f(1.325,-.79),corner==2u);
  var world=centreWorld+right*(uvCorner.x*rx)+up*(uvCorner.y*ry);
  if(!fallen){world.y=max(world.y,r.rootScale.y);}
  let dome=normalize(toEye*.68+right*(uvCorner.x*.52)+up*(uvCorner.y*.56));
  let leaves=normalize(dome+vec3f(0.,.35,0.));
  let lit=forestCrownLight(world,leaves,dome,tint,forestCrownSplat.shade.x,forestCrownSplat.shade.y,forestCrown.optics,forestCrown.underside.rgb);
  var o:ForestVertex;
  o.world=world;o.normal=lit.normal;o.kind=lit.kind;o.leafUV=lit.leafUV;o.colour=lit.colour;
  o.nativeMaterial=-1;o.crownFade=fade;o.canopyAO=1.;
  o.coverageSeed=forestCoverageHash(vertex^(item.x*0x9e3779b9u));
  o.pos=F.viewProj*vec4f(earthCurve(world-F.camPos.xyz,F.camPos.y),1.);
  return o;
 }
 var gv0=vertex;
 var pos:vec3f;var lean:vec3f;var shape:vec3f;var col:vec3f;var exposure:f32;var escape:f32;var wood:bool;var fade=1.;
 if((forestBin.z&2048u)!=0u){
  fade=f32(item.y>>24u)/255.;
  let u0=forestCrownUnpack(gv0);
  pos=u0.pos;lean=u0.lean;shape=u0.shape;col=u0.col;exposure=u0.exposure;escape=u0.escape;wood=u0.wood;
 }else{
  let localTri=item.y&4095u;
  let stepIdx=min((item.y>>12u)&4095u,forestCrown.mesh.w);
  let morphT=f32(item.y>>24u)/255.;
  let baseGlobalV=forestClusterIndices[forestCrown.mesh.y+localTri*3u+(vertex%3u)];
  let localCorner=baseGlobalV-forestCrown.mesh.x;
  let hdr=forestCrown.mesh.z+stepIdx*4u;
  let h0=forestCrownMorph[hdr];
  let collapseV=(h0>>16u)&255u;
  let targetV=h0>>24u;
  let grow0=bitcast<f32>(forestCrownMorph[hdr+2u]);
  let mapOff=forestCrownMorph[hdr+3u];
  let mapWord=forestCrownMorph[mapOff+(localCorner>>2u)];
  let vMapped=(mapWord>>((localCorner&3u)*8u))&255u;
  gv0=forestCrown.mesh.x+vMapped;
  let u0=forestCrownUnpack(gv0);
  pos=u0.pos;lean=u0.lean;shape=u0.shape;col=u0.col;exposure=u0.exposure;escape=u0.escape;wood=u0.wood;
  if(wood){
   if(collapseV<250u&&vMapped==collapseV){
    let u1=forestCrownUnpack(forestCrown.mesh.x+targetV);
    pos=mix(pos,u1.pos,morphT);lean=forestCrownSafeNorm(mix(lean,u1.lean,morphT),lean);col=mix(col,u1.col,morphT);exposure=mix(exposure,u1.exposure,morphT);escape=mix(escape,u1.escape,morphT);
   }else if(collapseV==253u){
    pos=mix(pos,vec3f(forestCrownSplat.shade.z,pos.y,forestCrownSplat.shade.w),morphT);
   }
  }else{
   let grow1=select(grow0,bitcast<f32>(forestCrownMorph[hdr+6u]),stepIdx<forestCrown.mesh.w);
   let mid=forestCrownSplat.centre.xyz;
   if(collapseV<250u&&vMapped==collapseV){
    let u1=forestCrownUnpack(forestCrown.mesh.x+targetV);
    let p01=mix(pos,u1.pos,morphT);
    pos=mid+(p01-mid)*mix(grow0,grow1,morphT);
    lean=forestCrownSafeNorm(mix(lean,u1.lean,morphT),lean);shape=forestCrownSafeNorm(mix(shape,u1.shape,morphT),shape);col=mix(col,u1.col,morphT);exposure=mix(exposure,u1.exposure,morphT);escape=mix(escape,u1.escape,morphT);
   }else if(collapseV==255u){
    let scaled0=mid+(pos-mid)*grow0;
    let rx=max(forestCrownSplat.centre.w,1e-3);let ry=max(forestCrownSplat.colour.w,1e-3);
    let rel=(scaled0-mid)/vec3f(rx,ry,rx);
    let dir=forestCrownSafeNorm(rel,shape);
    let ellip=mid+dir*vec3f(rx,ry,rx)*.94;
    pos=mix(scaled0,ellip,morphT);
    shape=forestCrownSafeNorm(mix(shape,dir,morphT),dir);
    lean=forestCrownSafeNorm(mix(lean,forestCrownSafeNorm(dir+vec3f(0.,.35,0.),vec3f(0.,1.,0.)),morphT),lean);
    col=mix(col,forestCrownSplat.colour.rgb,morphT);
    exposure=mix(exposure,forestCrownSplat.shade.x,morphT);
    escape=mix(escape,forestCrownSplat.shade.y,morphT);
   }else{
    pos=mid+(pos-mid)*mix(grow0,grow1,morphT);
   }
  }
 }
 // Material 1 is the trunk below the crown, which moves and is lit as the wood it stands for (forestNativeOpaqueFS).
 var o=forestPlace(r,item.x,pos,lean,vec2f(select(4.,3.,wood),exposure),vec2f(0.),col,-1.,gv0,escape);
 o.crownFade=fade;
 if(wood){
  let n=normalize(o.normal);o.normal=n;
  o.kind=vec2f(max(dot(n,F.sunDir.xyz),0.)*(.35+.65*escape),(.36+max(n.y,0.)*.25)*escape);o.leafUV=vec2f(0.,.95);o.canopyAO=0.;
  return o;
 }
 let turn=vec2f(cos(r.yawColour.x),sin(r.yawColour.x));
 let outward=vec3f(turn.x*shape.x-turn.y*shape.z,shape.y,turn.y*shape.x+turn.x*shape.z);
 let lit=forestCrownLight(o.world,o.normal,outward,o.colour,exposure,escape,forestCrown.optics,forestCrown.underside.rgb);
 o.colour=lit.colour;o.kind=lit.kind;o.leafUV=lit.leafUV;o.normal=lit.normal;
 o.canopyAO=1.;
 return o;
}
// The surface lies just inside its outermost leaves, and where the land's shadow map reaches a crown
// those leaves are in the map. The lookup starts beyond them, or every crown would shade itself.
const FOREST_CROWN_SHADOW_LIFT=.45;
// Value noise on a lattice fixed to the ground, between -1 and 1.
fn forestCrownLattice(p:vec3f)->f32{
 let i=vec3i(floor(p));let f=fract(p);let u=f*f*(3.-2.*f);var sum=0.;
 for(var k=0;k<8;k++){
  let corner=vec3i(k&1,(k>>1)&1,k>>2);let q=bitcast<vec3u>(i+corner);
  let h=forestCoverageHash((q.x*0x8da6b343u)^forestCoverageHash((q.y*0xd8163841u)^forestCoverageHash(q.z*0xcb1ab31fu)));
  let w=mix(vec3f(1.)-u,u,vec3f(corner));
  sum+=w.x*w.y*w.z*f32(h&65535u)/65535.;
 }
 return sum*2.-1.;
}
// Leaves are not one even green: sprays of them catch the light or fall into the shade of the next, and
// whole boughs stand lighter or darker. Two sizes of that unevenness are laid over a crown, each fading
// out as it shrinks below what a pixel can show, so the crown is never busier than leaves would be.
const FOREST_CROWN_SPRAY=vec2f(1.1,.26);
const FOREST_CROWN_BOUGH=vec2f(3.4,.16);
fn forestCrownMottle(world:vec3f)->f32{
 let pixel=length(F.camPos.xyz-world)*2.*length(F.camUp.xyz)/max(F.screen.y,1.);
 let spray=forestCrownLattice(world/FOREST_CROWN_SPRAY.x)*FOREST_CROWN_SPRAY.y*(1.-smoothstep(.3,.8,pixel/FOREST_CROWN_SPRAY.x));
 let bough=forestCrownLattice(world/FOREST_CROWN_BOUGH.x+vec3f(17.3,5.1,9.7))*FOREST_CROWN_BOUGH.y*(1.-smoothstep(.3,.8,pixel/FOREST_CROWN_BOUGH.x));
 return 1.+spray+bough;
}
fn forestCrownShade(in:ForestVertex)->vec4f{
 let across=cross(dpdx(in.world),dpdy(in.world));let toEye=F.camPos.xyz-in.world;
 let outward=normalize(across*select(-1.,1.,dot(across,toEye)>=0.)+toEye*1e-9);
 let shadow=landShadowVisibility(in.world+outward*FOREST_CROWN_SHADOW_LIFT,outward);
 // The trunk (canopyAO 0) is bare wood.
 let mottle=mix(1.,forestCrownMottle(in.world),clamp(in.canopyAO,0.,1.));
 // A pixel whose centre lies off a triangle seen edge on reads what the triangle carries from beyond its
 // corners, where it overshoots without limit: a normal of any length, a wetness below nothing, which
 // the land's finish takes for metal. Each is held to what a leaf can be, so no pixel blazes for a frame.
 let span=dot(in.normal,in.normal);
 let normal=select(outward,in.normal*inverseSqrt(max(span,1e-12)),span>1e-6&&span<1e6);
 let colour=clamp(in.colour,vec3f(0.),vec3f(4.));let light=clamp(in.kind,vec2f(0.),vec2f(4.,1.));
 let finish=clamp(in.leafUV,vec2f(0.,.05),vec2f(1.));
 return landFinishShadowed(in.world,normal,colour,light.x*mottle,light.y*mix(1.,mottle,.6),finish.x,finish.y,shadow);
}
@fragment fn forestCrownFS(in:ForestVertex)->@location(0)vec4f{return forestCrownShade(in);}
// A crown coming in over its own leaves takes some of each pixel's samples and the leaves keep the rest
// (forestCrownSamples), so nothing is blended and nothing is drawn twice.
struct ForestCrownCoverage {@location(0)colour:vec4f,@builtin(sample_mask)mask:u32};
@fragment fn forestCrownFadeFS(in:ForestVertex)->ForestCrownCoverage{
 var o:ForestCrownCoverage;o.colour=forestCrownShade(in);o.mask=forestCrownSamples(in.crownFade,in.pos.xy);return o;
}
`;
