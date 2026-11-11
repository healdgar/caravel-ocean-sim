// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Far crowns: where a tree's leaf cards can no longer be told apart, one closed surface stands for all
// of them, and one column for the trunk beneath. scripts/prepare-forest-crowns.mjs bakes both from the
// clusters the pack already has, and js/forest-clusters.js chooses, tree by tree on the GPU, which trees
// wear them. A tree wholly in its crown draws no cluster of leaf or wood.

// Levels of detail every crown is baked at, finest first.
export const FOREST_CROWN_LEVELS = 3;
// A crown's vertices are packed as cluster vertices are (packForestClusterVertex in js/forest-clusters.js).
const CROWN_VERTEX_WORDS = 5;

// Literal paths: build.mjs finds what to publish by reading them from the source.
// Saba has no entry. Its far trees already wear the crown shells of js/forest-volume.js.
export const PORTUGAL_FOREST_CROWN_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/crowns/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/portugal/crowns/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/portugal/crowns/indices.bin.gz',
});
export const SUBTROPICAL_FOREST_CROWN_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/crowns/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/subtropical/crowns/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/subtropical/crowns/indices.bin.gz',
});

export function validateForestCrowns(manifest) {
  if (manifest?.format !== 'waterworld.forest-crowns' || manifest.version !== 1 || manifest.vertexWords !== CROWN_VERTEX_WORDS || manifest.levels !== FOREST_CROWN_LEVELS) throw Error('Invalid forest crown manifest');
  if (!Array.isArray(manifest.prototypes) || !manifest.prototypes.length) throw Error('Forest crowns hold no trees');
  if (manifest.widestLeafErrors !== undefined && !(manifest.widestLeafErrors > 0)) throw Error('Forest crowns name no breadth to change at');
  for (const p of manifest.prototypes) {
    if (!Array.isArray(p.levels) || p.levels.length !== FOREST_CROWN_LEVELS) throw Error(`Forest crown lacks a level: ${p.species}`);
    let last = 0;
    for (const level of p.levels) {
      if (!(level.indexCount > 0) || level.indexCount % 3 || level.firstIndex + level.indexCount > manifest.indexCount || !(level.errorMetres >= last)) throw Error(`Forest crown level is malformed: ${p.species}`);
      last = level.errorMetres;
    }
    if (!(p.leafErrorMetres > 0)) throw Error(`Forest crown names no leaf cut: ${p.species}`);
    if (!(p.breadthMetres > 0)) throw Error(`Forest crown names no breadth: ${p.species}`);
    if (!(p.posScale > 0) || !(p.look?.alike > 0) || p.look.alike > 1 || p.look.undersideGain?.length !== 3) throw Error(`Forest crown look is malformed: ${p.species}`);
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
  const [vertices, indices] = await Promise.all(['vertices.bin', 'indices.bin'].map(stream));
  if (vertices.byteLength !== manifest.vertexCount * CROWN_VERTEX_WORDS * 4 || indices.byteLength !== manifest.indexCount * 4) throw Error('Forest crown streams do not match their manifest');
  return { manifest, vertices, indices };
}

// What one species' crown shader reads: where its vertices lie, and how its leaves take light.
export function forestCrownLook(info) {
  const { alike, transmission, roughness, undersideGain } = info.look;
  return new Float32Array([...info.low, info.posScale, alike, transmission, roughness, 0, ...undersideGain, 0]);
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
// The share of the forest's pixel error a crown level may stray by before a finer one is drawn. At the
// whole of it the coarsest level came in by 500 m, and trees on a skyline stood as blocks.
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
struct ForestCrownLook {bounds:vec4f,optics:vec4f,underside:vec4f};
@group(3)@binding(5)var<uniform>forestCrown:ForestCrownLook;
// A crown is lit as the leaves it stands for, not as the surface it is. Each leaf card is lit by its
// own normal, turned to face the viewer, and shows its underside from below; the leaves of one bough
// face much the same way (the vertex's normal) and differ by a known spread (optics.x, the length of
// their mean). Eight leaves around that mean, each counted by how much of it the viewer sees, give the
// light and colour a pixel full of them would average to. It is the arithmetic of forestNativeLeafFS.
const FOREST_CROWN_RING=8;
@vertex fn forestCrownVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)vertex:u32)->ForestVertex{
 let item=forestClusterList[forestBin.x+instance];
 let at=vertex*${CROWN_VERTEX_WORDS}u;
 let w0=forestClusterVertices[at];let w1=forestClusterVertices[at+1u];let w2=forestClusterVertices[at+2u];let w3=forestClusterVertices[at+3u];let w4=forestClusterVertices[at+4u];
 let position=forestCrown.bounds.xyz+vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))/65535.*forestCrown.bounds.w;
 let lean=forestClusterOctahedral(vec2f(f32(w2&65535u),f32(w2>>16u))/65535.*2.-1.);
 let exposure=f32(w1>>24u)/255.;let escape=f32(w4>>24u)/255.;
 let root=vec3f(f32(w4&255u),f32((w4>>8u)&255u),f32((w4>>16u)&255u))/255.;
 let r=forestRoots[item.x];
 // Material 1 is the trunk below the crown, which moves and is lit as the wood it stands for (forestNativeOpaqueFS).
 let wood=((w1>>16u)&255u)==1u;
 var o=forestPlace(r,item.x,position,lean,vec2f(select(4.,3.,wood),exposure),vec2f(0.),root*root,-1.,vertex,escape);
 o.crownFade=f32(item.y>>24u)/255.;
 if(wood){
  let n=normalize(o.normal);o.normal=n;
  o.kind=vec2f(max(dot(n,F.sunDir.xyz),0.)*(.35+.65*escape),(.36+max(n.y,0.)*.25)*escape);o.leafUV=vec2f(0.,.95);o.canopyAO=0.;
  return o;
 }
 let view=normalize(F.camPos.xyz-o.world);let middle=normalize(o.normal);
 let side=normalize(cross(middle,select(vec3f(1.,0.,0.),vec3f(0.,0.,1.),abs(middle.x)>.9)));let other=cross(middle,side);
 let alike=clamp(forestCrown.optics.x,0.,1.);let spread=sqrt(1.-alike*alike);
 let moonDir=lunarDirection();
 var weight=0.;var gain=vec3f(0.);var lit=vec3f(0.);var mean=vec3f(0.);var level=0.;var moon=0.;
 for(var k=0;k<FOREST_CROWN_RING;k++){
  let a=(f32(k)+.5)*(6.2831853/f32(FOREST_CROWN_RING));
  var n=middle*alike+(side*cos(a)+other*sin(a))*spread;
  let facing=dot(n,view);let seen=abs(facing);
  if(facing<0.){n=-n;}
  let nDotL=dot(n,F.sunDir.xyz);let backlit=max(-nDotL,0.)*forestCrown.optics.y;
  let tint=select(forestCrown.underside.rgb,vec3f(1.),facing>=0.)*mix(vec3f(1.),vec3f(1.12,1.16,.78),backlit*exposure);
  gain+=tint*seen;lit+=tint*(seen*(max(nDotL,0.)+backlit));mean+=n*seen;level+=abs(n.y)*seen;moon+=max(dot(n,moonDir),0.)*seen;weight+=seen;
 }
 weight=max(weight,1e-4);mean/=weight;
 let luma=vec3f(.2126,.7152,.0722);
 o.colour=o.colour*gain/weight;
 o.kind=vec2f(dot(lit,luma)/max(dot(gain,luma),1e-4)*(.22+.78*exposure*exposure)*(.35+.65*escape),(.12+exposure*.56+level/weight*.09)*escape);
 let roughness=clamp(forestCrown.optics.z,.24,.92);
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
 let shape=forestClusterOctahedral(vec2f(f32(w3&65535u),f32(w3>>16u))/65535.*2.-1.);
 let turn=vec2f(cos(r.yawColour.x),sin(r.yawColour.x));
 let outward=vec3f(turn.x*shape.x-turn.y*shape.z,shape.y,turn.y*shape.x+turn.x*shape.z);
 o.kind*=vec2f(mix(.68,1.36,smoothstep(-.45,.75,dot(outward,F.sunDir.xyz))),mix(.8,1.2,outward.y*.5+.5));
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
 let mottle=mix(1.,forestCrownMottle(in.world),in.canopyAO);
 return landFinishShadowed(in.world,in.normal,in.colour,in.kind.x*mottle,in.kind.y*mix(1.,mottle,.6),in.leafUV.x,in.leafUV.y,shadow);
}
@fragment fn forestCrownFS(in:ForestVertex)->@location(0)vec4f{return forestCrownShade(in);}
// A crown coming in over its own leaves takes some of each pixel's samples and the leaves keep the rest
// (forestCrownSamples), so nothing is blended and nothing is drawn twice.
struct ForestCrownCoverage {@location(0)colour:vec4f,@builtin(sample_mask)mask:u32};
@fragment fn forestCrownFadeFS(in:ForestVertex)->ForestCrownCoverage{
 var o:ForestCrownCoverage;o.colour=forestCrownShade(in);o.mask=forestCrownSamples(in.crownFade,in.pos.xy);return o;
}
`;
