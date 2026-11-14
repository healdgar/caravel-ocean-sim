// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Groves: the canopy of a wood wherever a coast's ground is marked as forest, however far it runs. Trees
// planted one by one are a budget that a harbour's hills use up; a grove is a baked square of closed wood
// (scripts/prepare-forest-groves.mjs) that the GPU lays over all the rest: one canopy that follows the
// ground, parts round each planted tree, slopes down at the wood's edge, and is drawn coarser with
// distance until a grove is a few lumps on a far hill.
import { requestOnce } from './gpu-program-cache.js';
import { FRAME_WGSL } from './wgsl/common.js';
import { terrainSurfaceSample } from './terrain-model.js';
import { portClearanceEnvelope, PLANT_STREET_GAP_M } from './coastal-world.js';
import { streetEdgeAt } from './town-streets.js';
import { FOREST_CANOPY_RANGE_WGSL } from './forest-scenery.js';
import { createInlandWaterSampler } from './inland-water.js';

// A grove's maps are this many texels square, kept at this many levels each half as fine as the last,
// and a pack bakes this many groves that stand beside each other in any order.
export const FOREST_GROVE_TEXELS = 128;
export const FOREST_GROVE_LEVELS = 7;
export const FOREST_GROVE_VARIANTS = 4;
// The maps of one level: the canopy's height, owner and view of the sky; its colour and exposure; and
// the way its leaves and its surface face.
export const FOREST_GROVE_MAPS = 3;
// A tree of a grove: where it stands, its turn and scale, which tree of the pack it is, its crown's
// radius and height, and whether every grove shares it.
export const FOREST_GROVE_TREE_FLOATS = 8;
// A planted tree's record in the forest's roots (js/terrain.js): where it stands, its scale and its kind.
const FOREST_GROVE_ROOT_FLOATS = 12;
// How far below the ground a grove's canopy lies where no wood stands, so that the ground is drawn in
// front of it and it costs no pixel. A square of the canopy no broader than FOREST_GROVE_FLAT_METRES
// lies within one flat piece of the ground, and this is enough; a broader one spans ground that may
// hollow under it, and lies deeper by FOREST_GROVE_SUNK_SHARE of what it is broader by.
const FOREST_GROVE_SUNK_METRES = 3, FOREST_GROVE_FLAT_METRES = 16, FOREST_GROVE_SUNK_SHARE = 0.5;
// The canopy begins to rise where a cover says a wood's edge is, and stands to its whole height where the
// cover is nearly full; it has gone to ground where planted trees have nearly all of a square.
const FOREST_GROVE_EDGE = 0.45, FOREST_GROVE_FULL = 0.95, FOREST_GROVE_TAKEN = 0.9;
// Trees by a harbour are planted smaller than those inland (retargetForestPackToProcedural, js/terrain.js),
// and a grove's canopy is as much lower there: this share of its height at the port, all of it from
// FOREST_GROVE_INLAND_METRES[1] away. A grove of full-grown trees, which are planted at nearly one size
// everywhere, names a share of its own (harbourHeight in its manifest).
const FOREST_GROVE_HARBOUR_HEIGHT = 0.78, FOREST_GROVE_INLAND_METRES = [100, 580];
// Over these shares of the forest's canopy range (FOREST_CANOPY_RANGE_WGSL) the canopy closes over the
// hollows planted trees stand in, so it is whole before the trees are no longer drawn.
const FOREST_GROVE_CLOSING = [0.7, 0.94];

// Literal paths: build.mjs finds what to publish by reading them from the source.
// Saba has no entry. Its far woods are the masses of js/forest-mass.js.
export const PORTUGAL_FOREST_GROVE_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/groves/manifest.json',
  'maps.bin.gz': 'assets/forest-scenery/portugal/groves/maps.bin.gz',
  'trees.bin.gz': 'assets/forest-scenery/portugal/groves/trees.bin.gz',
});
export const SUBTROPICAL_FOREST_GROVE_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/groves/manifest.json',
  'maps.bin.gz': 'assets/forest-scenery/subtropical/groves/maps.bin.gz',
  'trees.bin.gz': 'assets/forest-scenery/subtropical/groves/trees.bin.gz',
});

// The bytes of one map of one grove: every level, finest first.
const forestGroveMapBytes = () => {
  let bytes = 0;
  for (let level = 0; level < FOREST_GROVE_LEVELS; level++) bytes += (FOREST_GROVE_TEXELS >> level) ** 2 * 4;
  return bytes;
};

export function validateForestGroves(manifest) {
  if (manifest?.format !== 'waterworld.forest-groves' || manifest.version !== 1 || manifest.texels !== FOREST_GROVE_TEXELS || manifest.levels !== FOREST_GROVE_LEVELS ||
    manifest.variants !== FOREST_GROVE_VARIANTS || manifest.maps !== FOREST_GROVE_MAPS || manifest.treeFloats !== FOREST_GROVE_TREE_FLOATS) throw Error('Invalid forest grove manifest');
  if (!(manifest.tileMetres > 0) || !(manifest.heightMetres > 0)) throw Error('Forest groves name no size');
  if (manifest.harbourHeight !== undefined && !(manifest.harbourHeight > 0 && manifest.harbourHeight <= 1)) throw Error('Forest groves name no height by the harbour');
  // A tree's number shares a word of the canopy map with its height, and has twelve bits of it.
  if (!Number.isInteger(manifest.maxTrees) || manifest.maxTrees < 2 || manifest.maxTrees > 4096) throw Error('Forest groves hold too many trees to name');
  const look = manifest.look;
  if (!(look?.alike > 0) || look.alike > 1 || !(look.transmission >= 0) || !(look.roughness > 0) || look.undersideGain?.length !== 3) throw Error('Forest grove look is malformed');
  if (manifest.files?.['maps.bin']?.bytes !== FOREST_GROVE_VARIANTS * FOREST_GROVE_MAPS * forestGroveMapBytes() ||
    manifest.files?.['trees.bin']?.bytes !== FOREST_GROVE_VARIANTS * manifest.maxTrees * FOREST_GROVE_TREE_FLOATS * 4) throw Error('Forest grove streams do not match their manifest');
  return manifest;
}

export async function loadForestGroves({ assets, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Forest groves unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = validateForestGroves(await (await get('manifest.json')).json());
  const stream = async (name) => {
    const receipt = manifest.files[name], response = await get(`${name}.gz`);
    const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== receipt.bytes) throw Error(`Forest grove stream has the wrong size: ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error(`Forest grove stream failed verification: ${name}`);
    return bytes;
  };
  const [maps, trees] = await Promise.all(['maps.bin', 'trees.bin'].map(stream));
  return { manifest, maps, trees: new Float32Array(trees.buffer, trees.byteOffset, trees.byteLength / 4) };
}

// Where a wood may stand on one section of coast, as two bytes for each of size by size squares of it.
// The first is how far, of 255, into a wood the square lies: nothing on water, sand, bare or steep ground,
// in a town, or a few squares outside a wood; half at a wood's edge; and all of it three squares inside. They
// are the rules by which js/terrain.js plants a tree, so a grove ends where planted trees would, and the
// canopy comes down to that edge over the squares before it. The second byte is forestGroveOccupy's.
export function forestGroveCover({ region, heights, biome, beaches = null, port = null, mangrove = false, size }) {
  const span = region.span, x0 = region.x - span / 2, z0 = region.z - span / 2, step = span / size, mask = region.biomeSize;
  const cover = new Uint8Array(size * size * 2);
  if (!(biome instanceof Uint8Array) || biome.length !== mask * mask) return cover;
  const dry = beaches?.drySandMask, swash = beaches?.swashMask, lowest = mangrove ? 0.32 : 0.75;
  const inside = span / 2 - 0.01;
  const ground = (x, z) => terrainSurfaceSample(heights, Math.max(region.x - inside, Math.min(region.x + inside, x)), Math.max(region.z - inside, Math.min(region.z + inside, z)), region);
  const town = port?.clearRadius > 0 ? port : null;
  const pad = town ? (town.hasOrthophotoFootprints ? 8 : town.hasIndigenousSettlement ? 8.5 : 10) : 0;
  const cleared = town && !town.hasOrthophotoFootprints && !town.hasIndigenousSettlement ? (town.clearRadius * 0.38) ** 2 : 0;
  const waterWide = port?.country ? createInlandWaterSampler(port.country, { margin: 8.0 }) : null;
  for (let j = 0; j < size; j++) {
    const z = z0 + (j + 0.5) * step, row = Math.min(mask - 1, Math.floor((j + 0.5) * mask / size)) * mask;
    for (let i = 0; i < size; i++) {
      const cell = row + Math.min(mask - 1, Math.floor((i + 0.5) * mask / size)), marked = biome[cell];
      if (marked < 42 || (dry && dry[cell] > 110) || (swash && swash[cell] > 64)) continue;
      const x = x0 + (i + 0.5) * step, y = ground(x, z);
      if (!(y >= lowest) || y > 845) continue;
      if (waterWide?.(x, z)) continue;
      const slope = Math.hypot(ground(x + 2, z) - ground(x - 2, z), ground(x, z + 2) - ground(x, z - 2)) * 0.25;
      if (!(slope <= 0.84) || (y < 24 && slope > 0.36)) continue;
      if (town && (!portClearanceEnvelope(town, x, z, pad) || (x - town.center.x) ** 2 + (z - town.center.z) ** 2 < cleared || streetEdgeAt(town.streets, x, z) < PLANT_STREET_GAP_M)) continue;
      // Ground marked thinly is a wood's margin: scrub, then trees.
      cover[(j * size + i) * 2] = marked >= 108 ? 255 : Math.round((marked - 41) / 67 * 255);
    }
  }
  // Each square takes in its neighbours four times over, so the edge of a wood is a slope and not a step.
  const line = new Float32Array(size);
  for (let pass = 0; pass < 4; pass++) for (const stride of [2, size * 2]) for (let row = 0; row < size; row++) {
    const first = stride === 2 ? row * size * 2 : row * 2;
    for (let k = 0; k < size; k++) line[k] = cover[first + k * stride];
    for (let k = 0; k < size; k++) cover[first + k * stride] = Math.round((line[Math.max(0, k - 1)] + line[k] + line[Math.min(size - 1, k + 1)]) / 3);
  }
  if (port?.country) {
    const waterChannel = createInlandWaterSampler(port.country, { margin: 3.5 });
    if (waterChannel) {
      for (let j = 0; j < size; j++) {
        const z = z0 + (j + 0.5) * step;
        for (let i = 0; i < size; i++) {
          if (waterChannel(x0 + (i + 0.5) * step, z)) cover[(j * size + i) * 2] = 0;
        }
      }
    }
  }
  return cover;
}

// Marks, in a cover's second byte, how much of each square planted trees have: all of it at a trunk,
// a third at the edge of its crown, and none a quarter of a crown beyond. A grove's canopy gives way by
// as much, so a planted tree stands in a hollow of the canopy that its own crown fills, with the wood
// closed round it, and where trees are planted close the canopy is the lower growth between them.
// Far off the canopy closes over those hollows (forestGroveVS) and the trees give way to it.
export function forestGroveOccupy(cover, size, region, roots, reach) {
  for (let k = 1; k < cover.length; k += 2) cover[k] = 0;
  if (!roots?.length) return cover;
  const step = region.span / size, x0 = region.x - region.span / 2, z0 = region.z - region.span / 2;
  for (let k = 0; k + FOREST_GROVE_ROOT_FLOATS <= roots.length; k += FOREST_GROVE_ROOT_FLOATS) {
    const scale = roots[k + 3];
    if (!(scale > 0)) continue;
    // A crown narrower than a square still takes the square its trunk stands in.
    const u = (roots[k] - x0) / step, v = (roots[k + 2] - z0) / step, crown = reach(roots[k + 8], scale) / step, r = Math.max(crown * 1.25, 1.2), all = Math.min(crown * 0.5, r - 0.7);
    if (u < -r || v < -r || u > size + r || v > size + r) continue;
    const i0 = Math.max(0, Math.floor(u - r)), i1 = Math.min(size - 1, Math.floor(u + r)), j0 = Math.max(0, Math.floor(v - r)), j1 = Math.min(size - 1, Math.floor(v + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const taken = Math.round(255 * Math.min(1, (r - Math.hypot(i + 0.5 - u, j + 0.5 - v)) / (r - all))), at = (j * size + i) * 2 + 1;
      if (taken > cover[at]) cover[at] = taken;
    }
  }
  return cover;
}

// Sets, a bit for each planted tree in the roots' order, those that stand in closed wood: where the
// canopy, were the tree not there, would stand to half its height or more. From far off the forest
// leaves these to the canopy (forestWithGroveCanopy in js/forest-scenery.js). A tree at a wood's very
// edge, or in thin growth, is always drawn as itself.
export function forestGroveStands(cover, size, region, roots, stands) {
  const step = region.span / size, x0 = region.x - region.span / 2, z0 = region.z - region.span / 2;
  const least = (FOREST_GROVE_EDGE + FOREST_GROVE_FULL) / 2 * 255;
  for (let k = 0, tree = 0; k + FOREST_GROVE_ROOT_FLOATS <= roots.length; k += FOREST_GROVE_ROOT_FLOATS, tree++) {
    if (!(roots[k + 3] > 0)) continue;
    const i = Math.floor((roots[k] - x0) / step), j = Math.floor((roots[k + 2] - z0) / step);
    if (i >= 0 && j >= 0 && i < size && j < size && cover[(j * size + i) * 2] >= least) stands[tree >> 5] |= 1 << (tree & 31);
  }
  return stands;
}

// The groves a section draws: each tile of its ground on which some wood is marked, counting a square
// of the cover beyond the tile's edge, over which the canopy's edge slopes down. A tile wholly taken
// by planted trees is drawn too, since from far off the canopy closes over them. Four floats a tile:
// its corner, then the lowest and highest ground under it.
export function forestGroveTiles({ cover, size, region, heights, tileMetres }) {
  const span = region.span, x0 = region.x - span / 2, z0 = region.z - span / 2, side = Math.ceil(span / tileMetres - 1e-6), per = size / span * tileMetres;
  const n = region.size, grid = (n - 1) / span, tiles = [];
  for (let tj = 0; tj < side; tj++) for (let ti = 0; ti < side; ti++) {
    const a0 = Math.max(0, Math.floor(ti * per) - 1), a1 = Math.min(size, Math.ceil((ti + 1) * per) + 1), b0 = Math.max(0, Math.floor(tj * per) - 1), b1 = Math.min(size, Math.ceil((tj + 1) * per) + 1);
    let stands = false;
    search: for (let j = b0; j < b1; j++) for (let i = a0; i < a1; i++) {
      if (cover[(j * size + i) * 2] > FOREST_GROVE_EDGE * 255) { stands = true; break search; }
    }
    if (!stands) continue;
    const i0 = Math.max(0, Math.floor(ti * tileMetres * grid)), i1 = Math.min(n - 1, Math.ceil((ti + 1) * tileMetres * grid));
    const j0 = Math.max(0, Math.floor(tj * tileMetres * grid)), j1 = Math.min(n - 1, Math.ceil((tj + 1) * tileMetres * grid));
    let low = Infinity, high = -Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const h = heights[j * n + i]; if (h < low) low = h; if (h > high) high = h; }
    tiles.push(x0 + ti * tileMetres, z0 + tj * tileMetres, low, high);
  }
  return new Float32Array(tiles);
}

// What tells one state of a section's ground from another, so that a section is baked again only when
// its ground, its marking or its town has changed.
function forestGroveStamp(section) {
  const { region, heights, biome } = section;
  let ground = 0, marked = 0;
  for (let i = 0; i < heights.length; i += 7) ground = (ground * 31 + Math.round(heights[i] * 64)) | 0;
  for (let i = 0; i < biome.length; i += 5) marked = (marked * 33 + biome[i]) | 0;
  return [region.x, region.z, region.span, region.size, region.biomeSize, ground, marked, section.port?.instances?.length ?? 0, section.port?.streets?.size ?? 0, section.beaches?.drySandMask ? 1 : 0, section.port?.country?.riverReaches?.length ?? 0].join(',');
}

// Chooses, for one section, which of its groves the camera sees and how coarse each is drawn. A grove is
// drawn at the first level whose squares are no smaller on screen than a few pixels.
export const FOREST_GROVE_CULL_WGSL = FRAME_WGSL + /* wgsl */`
struct ForestGroveSection {domain:vec4f,counts:vec4f};
@group(0)@binding(0)var<uniform>F:Frame;
// How many pixels a square of a grove's canopy may span before a finer level is drawn; a grove's
// breadth in metres; the height of its tallest canopy; and how many levels it has.
@group(0)@binding(1)var<uniform>forestGrovePolicy:vec4f;
@group(0)@binding(2)var<uniform>forestGroveSection:ForestGroveSection;
@group(0)@binding(3)var<storage,read>forestGroveTiles:array<vec4f>;
@group(0)@binding(4)var<storage,read_write>forestGroveList:array<u32>;
@group(0)@binding(5)var<storage,read_write>forestGroveDraws:array<atomic<u32>>;
@compute @workgroup_size(1)fn forestGroveReset(){
 for(var level=0u;level<${FOREST_GROVE_LEVELS}u;level++){atomicStore(&forestGroveDraws[level*5u+1u],0u);}
}
@compute @workgroup_size(64)fn forestGroveCull(@builtin(global_invocation_id)id:vec3u){
 let count=u32(forestGroveSection.counts.x);if(id.x>=count){return;}
 let tile=forestGroveTiles[id.x];let breadth=forestGrovePolicy.y;
 let low=vec3f(tile.x,tile.z,tile.y);let high=vec3f(tile.x+breadth,tile.w+forestGrovePolicy.z,tile.y+breadth);
 let relative=(low+high)*.5-F.camPos.xyz;let away=length(relative);
 // The far ground falls away with the earth's curve, and a grove with it.
 let radius=length(high-low)*.5+away*away/12742000.;
 let clip=F.viewProj*vec4f(relative,1);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 for(var a=0u;a<2u;a++){let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
  if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}}
 if(clip.w<-radius*length(rowW)){return;}
 let nearest=clamp(F.camPos.xyz,low,high)-F.camPos.xyz;
 let focal=F.screen.y/max(2.*length(F.camUp.xyz),.0001);
 let square=breadth/${FOREST_GROVE_TEXELS}.;
 let level=u32(clamp(floor(log2(max(forestGrovePolicy.x*max(length(nearest),1.)/(focal*square),1.))),0.,forestGrovePolicy.w-1.));
 let slot=atomicAdd(&forestGroveDraws[level*5u+1u],1u);
 forestGroveList[level*count+slot]=id.x;
}
`;

// Joins the land's module after FOREST_CROWN_WGSL (js/terrain.js): a grove is lit as far crowns are, by
// forestCrownLight and forestCrownShade, since it stands for the same leaves.
export const FOREST_GROVE_WGSL = /* wgsl */`
// optics: how alike the leaves of a bough face, the light they pass, their roughness, and the height in
// metres of the tallest canopy a map can hold. underside: the colour of a leaf's underside against its
// top, and how many trees a grove may hold. tint: the climate's cast, and a grove's breadth in metres.
struct ForestGroveLook {optics:vec4f,underside:vec4f,tint:vec4f};
// domain: the section's corner, its breadth, and how many heights it has to a side. counts: how many
// groves it draws, where the harbour is that its trees are planted about, and the share of its height the
// canopy keeps there.
struct ForestGroveSection {domain:vec4f,counts:vec4f};
@group(2)@binding(20)var<uniform>forestGrove:ForestGroveLook;
@group(2)@binding(21)var forestGroveCanopy:texture_2d_array<f32>;
@group(2)@binding(22)var forestGroveColour:texture_2d_array<f32>;
@group(2)@binding(23)var forestGroveFacing:texture_2d_array<f32>;
@group(2)@binding(24)var<storage,read>forestGroveTrees:array<vec4f>;
@group(2)@binding(25)var<uniform>forestGroveSection:ForestGroveSection;
@group(2)@binding(26)var forestGroveGround:texture_2d<f32>;
@group(2)@binding(27)var forestGroveCover:texture_2d<f32>;
@group(2)@binding(28)var<storage,read>forestGroveTiles:array<vec4f>;
@group(2)@binding(29)var<storage,read>forestGroveList:array<u32>;
@group(2)@binding(30)var forestGroveSampler:sampler;
// The level this draw is of, and how many squares it has to a side.
@group(3)@binding(8)var<uniform>forestGroveLevel:vec4u;
// The ground as it is drawn: two triangles to each square of heights (terrainSurfaceSample).
fn forestGroveGroundAt(p:vec2f)->f32{
 let n=forestGroveSection.domain.w;
 let uv=clamp((p-forestGroveSection.domain.xy)*(n-1.)/forestGroveSection.domain.z,vec2f(0.),vec2f(n-1.001));
 let i=vec2i(floor(uv));let f=uv-vec2f(i);
 let h00=textureLoad(forestGroveGround,i,0).r;let h10=textureLoad(forestGroveGround,i+vec2i(1,0),0).r;
 let h01=textureLoad(forestGroveGround,i+vec2i(0,1),0).r;let h11=textureLoad(forestGroveGround,i+vec2i(1,1),0).r;
 if(f.x+f.y<=1.){return h00+f.x*(h10-h00)+f.y*(h01-h00);}
 return h11+(1.-f.x)*(h01-h11)+(1.-f.y)*(h10-h11);
}
${FOREST_CANOPY_RANGE_WGSL}
// How much of its height the canopy stands to at a place: none where no wood is marked or a planted
// tree has the ground, and all of it a square or two of the cover further in. So a wood's edge slopes to
// the ground as its mantle does, and the canopy parts round a planted tree instead of standing over it.
// parted is how far it parts for planted trees at all: wholly near the camera, and not at all from just
// short of the range beyond which the forest draws no tree in closed wood.
fn forestGroveStanding(p:vec2f,parted:f32)->f32{
 let cover=textureSampleLevel(forestGroveCover,forestGroveSampler,clamp((p-forestGroveSection.domain.xy)/forestGroveSection.domain.z,vec2f(.0005),vec2f(.9995)),0.).rg;
 return smoothstep(${FOREST_GROVE_EDGE},${FOREST_GROVE_FULL},cover.r)*(1.-parted*smoothstep(0.,${FOREST_GROVE_TAKEN},cover.g));
}
@vertex fn forestGroveVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)vertex:u32)->ForestVertex{
 let level=forestGroveLevel.x;let squares=forestGroveLevel.y;let side=squares+3u;
 let tile=forestGroveTiles[forestGroveList[level*u32(forestGroveSection.counts.x)+instance]];
 let breadth=forestGrove.tint.w;let square=breadth/f32(squares);
 // A ring of vertices round the grove repeats its edge lower down: a skirt that closes the crack
 // against a neighbour drawn at another level.
 let ring=vec2u(vertex%side,vertex/side);
 let skirt=ring.x==0u||ring.y==0u||ring.x==side-1u||ring.y==side-1u;
 let grid=vec2u(clamp(vec2i(ring)-1,vec2i(0),vec2i(i32(squares))));
 let local=vec2f(grid)*square;let at=tile.xy+local;
 // The far edge reads the near edge's texels, which every grove of the pack shares.
 let texel=vec2i(grid%vec2u(squares));
 let place=vec2i(round(tile.xy/breadth));
 let variant=forestCoverageHash((bitcast<u32>(place.x)*0x9e3779b9u)^forestCoverageHash(bitcast<u32>(place.y)))%${FOREST_GROVE_VARIANTS}u;
 let canopy=textureLoad(forestGroveCanopy,texel,variant,level);
 let bytes=vec3u(round(canopy.rgb*255.));
 let owner=((bytes.y&15u)<<8u)|bytes.z;
 let inland=smoothstep(${FOREST_GROVE_INLAND_METRES[0].toFixed(1)},${FOREST_GROVE_INLAND_METRES[1].toFixed(1)},distance(at,forestGroveSection.counts.yz));
 let tall=f32((bytes.x<<4u)|(bytes.y>>4u))/4095.*forestGrove.optics.w*mix(forestGroveSection.counts.w,1.,inland);
 // The tree this part of the canopy belongs to, which may be rooted in the next grove: each tree is
 // its own shade of the pack's green, wherever it is drawn from.
 let tree=forestGroveTrees[(variant*u32(forestGrove.underside.w)+owner)*2u];
 let home=place+vec2i(round((local-tree.xy)/breadth));
 let seed=forestCoverageHash(owner^forestCoverageHash((bitcast<u32>(home.x)*0x9e3779b9u)^forestCoverageHash(bitcast<u32>(home.y)+0x51ed270bu)));
 // The canopy lies over the ground as the wood does, so it follows every rise and hollow.
 let ground=forestGroveGroundAt(at);
 let parted=1.-smoothstep(${FOREST_GROVE_CLOSING[0]},${FOREST_GROVE_CLOSING[1]},distance(vec3f(at.x,ground,at.y),F.camPos.xyz)/forestCanopyRange());
 let standing=forestGroveStanding(at,parted);
 let sunk=${FOREST_GROVE_SUNK_METRES.toFixed(1)}+max(square-${FOREST_GROVE_FLAT_METRES.toFixed(1)},0.)*${FOREST_GROVE_SUNK_SHARE};
 var y=ground+(tall+sunk)*standing-sunk;
 if(skirt){y-=min((tall+sunk)*standing,3.+1.5*square);}
 if(standing<=0.001){y-=24.0;}
 var o:ForestVertex;
 o.nativeMaterial=-1;o.crownFade=1.;o.canopyAO=1.;o.coverageSeed=seed;
 o.world=vec3f(at.x,y,at.y);
 let look=textureLoad(forestGroveColour,texel,variant,level);
 let facing=textureLoad(forestGroveFacing,texel,variant,level);
 let leaves=forestClusterOctahedral(facing.xy*2.-1.);
 // Which way the canopy faces: as its own lumps do, as the ground under it slopes, and outward where
 // the wood's edge comes down. A wooded hill is lit as a hill.
 let lump=facing.zw*2.-1.;let up=max(sqrt(max(1.-dot(lump,lump),0.)),.25);
 let reach=max(square,4.);
 let east=at+vec2f(reach,0.);let south=at+vec2f(0.,reach);
 let rise=vec2f(forestGroveGroundAt(east)-ground,forestGroveGroundAt(south)-ground)/reach
  +(tall+sunk)*vec2f(forestGroveStanding(east,parted)-standing,forestGroveStanding(south,parted)-standing)/reach
  -lump/up*standing;
 let outward=normalize(vec3f(-rise.x,1.,-rise.y));
 let colour=look.rgb*look.rgb*forestGrove.tint.rgb*mix(.92,1.08,f32((seed>>24u)&255u)/255.);
 let lit=forestCrownLight(o.world,leaves,outward,colour,look.a,canopy.a,forestGrove.optics,forestGrove.underside.rgb);
 o.colour=lit.colour;o.kind=lit.kind;o.leafUV=lit.leafUV;o.normal=lit.normal;
 o.pos=F.viewProj*vec4f(earthCurve(o.world-F.camPos.xyz,F.camPos.y),1.);
 return o;
}
// Plain opaque, every fragment kept: what lies behind another part of the canopy, or under the ground,
// is never shaded.
@fragment fn forestGroveFS(in:ForestVertex)->@location(0)vec4f{return forestCrownShade(in);}
`;

// Every level's grid in one index buffer: a square of vertices for each square of the level, and a ring
// more all round for its skirt. A vertex has no data; forestGroveVS places it by its number.
function forestGroveGrids() {
  const ranges = [], indices = [];
  for (let level = 0; level < FOREST_GROVE_LEVELS; level++) {
    const squares = FOREST_GROVE_TEXELS >> level, side = squares + 3, first = indices.length;
    for (let j = 0; j < side - 1; j++) for (let i = 0; i < side - 1; i++) {
      const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    ranges.push({ squares, first, count: indices.length - first });
  }
  return { ranges, indices: new Uint16Array(indices) };
}

// Lays the pack's groves over every section of the coast. sync is told what sections there are and
// what trees are planted, after either has changed, and bakes in JavaScript what a section's cover and
// groves are; nothing is computed there again until the next change. Each frame the GPU alone chooses
// the groves in view and their levels (encode) and draws them (drawOpaque).
// The groves' choice of tiles and their sheet over the ground, asked for once a device. `module` is the land's own,
// or the promise of it: the land asks for these while it is still being made.
export function requestForestGrovePipelines({ device, shader, module, format, samples }) {
  return requestOnce(device, `forest groves ${format} ${samples}`, () => Promise.all([
    shader(FOREST_GROVE_CULL_WGSL, 'forest grove choice').then((code) => Promise.all([
      device.createComputePipelineAsync({ label: 'forest grove reset', layout: 'auto', compute: { module: code, entryPoint: 'forestGroveReset' } }),
      device.createComputePipelineAsync({ label: 'forest grove choice', layout: 'auto', compute: { module: code, entryPoint: 'forestGroveCull' } }),
    ])),
    // A grove is a sheet over the ground, seen from above and from its edge, so neither face is culled.
    Promise.resolve(module).then((land) => device.createRenderPipelineAsync({
      label: 'forest groves', layout: 'auto', vertex: { module: land, entryPoint: 'forestGroveVS' },
      fragment: { module: land, entryPoint: 'forestGroveFS', targets: [{ format }] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, multisample: { count: samples, alphaToCoverageEnabled: false },
    })),
  ]));
}
export async function createForestGroves({ device, shader, module, frameUBO, pack, format, samples, bind, cloudEntries, tint = [1, 1, 1], pixelsPerSquare = 6, baseCoverSize = 1024, sectionCoverSize = 512 }) {
  const B = GPUBufferUsage, T = GPUTextureUsage, m = pack.manifest, owned = [];
  const make = (data, usage, label) => {
    const buffer = device.createBuffer({ label, size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | B.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const keep = (resource) => { owned.push(resource); return resource; };
  try {
    const pipelines = requestForestGrovePipelines({ device, shader, module, format, samples });
    pipelines.catch(() => {});
    const maps = Array.from({ length: FOREST_GROVE_MAPS }, (_, map) => keep(device.createTexture({
      label: `forest grove map ${map}`, size: [FOREST_GROVE_TEXELS, FOREST_GROVE_TEXELS, FOREST_GROVE_VARIANTS], format: 'rgba8unorm', mipLevelCount: FOREST_GROVE_LEVELS, usage: T.TEXTURE_BINDING | T.COPY_DST,
    })));
    let at = 0;
    for (let variant = 0; variant < FOREST_GROVE_VARIANTS; variant++) for (let map = 0; map < FOREST_GROVE_MAPS; map++) for (let level = 0; level < FOREST_GROVE_LEVELS; level++) {
      const n = FOREST_GROVE_TEXELS >> level, bytes = n * n * 4;
      device.queue.writeTexture({ texture: maps[map], mipLevel: level, origin: [0, 0, variant] }, pack.maps, { offset: at, bytesPerRow: n * 4, rowsPerImage: n }, [n, n, 1]);
      at += bytes;
    }
    const trees = keep(make(pack.trees, B.STORAGE, 'forest grove trees'));
    const look = keep(make(new Float32Array([m.look.alike, m.look.transmission, m.look.roughness, m.heightMetres, ...m.look.undersideGain, m.maxTrees, ...tint, m.tileMetres]), B.UNIFORM, 'forest grove look'));
    const policy = keep(make(new Float32Array([pixelsPerSquare, m.tileMetres, m.heightMetres, FOREST_GROVE_LEVELS]), B.UNIFORM, 'forest grove policy'));
    const grids = forestGroveGrids(), indices = keep(make(grids.indices, B.INDEX, 'forest grove grids'));
    const sampler = device.createSampler({ label: 'forest grove cover', magFilter: 'linear', minFilter: 'linear' });
    const [[reset, cull], pipeline] = await pipelines;
    const levels = grids.ranges.map(({ squares }, level) => {
      const uniform = keep(make(new Uint32Array([level, squares, 0, 0]), B.UNIFORM, 'forest grove level'));
      return device.createBindGroup({ layout: pipeline.getBindGroupLayout(3), entries: [{ binding: 8, resource: { buffer: uniform } }] });
    });
    const scene = bind(pipeline), cloud = cloudEntries(pipeline);
    const sections = new Map(), stats = { loaded: true, tileMetres: m.tileMetres, levels: FOREST_GROVE_LEVELS, pixelsPerSquare, sections: 0, groves: 0, bakes: 0 };
    const release = (section) => { for (const resource of section.owned) resource.destroy(); };
    const prepare = (key, source) => {
      const region = source.region, base = !!source.ground, size = base ? baseCoverSize : sectionCoverSize, span = region.span;
      const most = Math.ceil(span / m.tileMetres - 1e-6) ** 2, mine = [];
      const hold = (resource) => { mine.push(resource); return resource; };
      // The base section's heights are already on the GPU for the land; a streamed section's are sent here.
      const ground = source.ground ?? hold(device.createTexture({ label: `forest grove ground ${key}`, size: [region.size, region.size], format: 'r32float', usage: T.TEXTURE_BINDING | T.COPY_DST }));
      const cover = hold(device.createTexture({ label: `forest grove cover ${key}`, size: [size, size], format: 'rg8unorm', usage: T.TEXTURE_BINDING | T.COPY_DST }));
      const tiles = hold(device.createBuffer({ label: `forest grove tiles ${key}`, size: most * 16, usage: B.STORAGE | B.COPY_DST }));
      const list = hold(device.createBuffer({ label: `forest groves to draw ${key}`, size: most * FOREST_GROVE_LEVELS * 4, usage: B.STORAGE }));
      const draws = hold(make(new Uint32Array(grids.ranges.flatMap(({ first, count }) => [count, 0, first, 0, 0])), B.STORAGE | B.INDIRECT, `forest grove draws ${key}`));
      const uniform = hold(device.createBuffer({ label: `forest grove section ${key}`, size: 32, usage: B.UNIFORM | B.COPY_DST }));
      const entry = (binding, buffer) => ({ binding, resource: { buffer } });
      return {
        owned: mine, ownsGround: !source.ground, ground, cover, tiles, draws, uniform, size, most, count: 0, stamp: '', bytes: null,
        resetGroup: device.createBindGroup({ layout: reset.getBindGroupLayout(0), entries: [entry(5, draws)] }),
        cullGroup: device.createBindGroup({ layout: cull.getBindGroupLayout(0), entries: [entry(0, frameUBO), entry(1, policy), entry(2, uniform), entry(3, tiles), entry(4, list), entry(5, draws)] }),
        drawGroup: device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: [
          entry(20, look), ...maps.map((texture, map) => ({ binding: 21 + map, resource: texture.createView({ dimension: '2d-array' }) })), entry(24, trees), entry(25, uniform),
          { binding: 26, resource: ground.createView() }, { binding: 27, resource: cover.createView() }, entry(28, tiles), entry(29, list), { binding: 30, resource: sampler },
        ] }),
      };
    };
    return {
      stats,
      // sources: every section of ground there is, each with its region, heights, biome, beaches and
      // port, and for the base section the land's own texture of its heights. roots: the trees planted
      // one by one, twelve floats each. reach: how far a planted tree's crown spreads, from its kind and scale.
      // Returns forestGroveStands' bits: the planted trees the canopy stands in for from far off.
      sync(sources, roots, reach, mangrove = false) {
        const seen = new Set(), stands = new Uint32Array(Math.ceil((roots?.length ?? 0) / FOREST_GROVE_ROOT_FLOATS / 32));
        let groves = 0;
        for (const source of sources) {
          const key = source.key, stamp = forestGroveStamp(source);
          seen.add(key);
          let section = sections.get(key);
          if (section && (section.size !== (source.ground ? baseCoverSize : sectionCoverSize) || section.most !== Math.ceil(source.region.span / m.tileMetres - 1e-6) ** 2 || section.ownsGround !== !source.ground)) { release(section); section = null; }
          if (!section) { section = prepare(key, source); sections.set(key, section); }
          const region = source.region;
          if (section.stamp !== stamp) {
            section.bytes = forestGroveCover({ region, heights: source.heights, biome: source.biome, beaches: source.beaches, port: source.port, mangrove, size: section.size });
            section.stamp = stamp; stats.bakes++;
            if (section.ownsGround) device.queue.writeTexture({ texture: section.ground }, source.heights, { bytesPerRow: region.size * 4 }, [region.size, region.size]);
          }
          forestGroveOccupy(section.bytes, section.size, region, roots, reach);
          if (roots?.length) forestGroveStands(section.bytes, section.size, region, roots, stands);
          device.queue.writeTexture({ texture: section.cover }, section.bytes, { bytesPerRow: section.size * 2 }, [section.size, section.size]);
          const tiles = forestGroveTiles({ cover: section.bytes, size: section.size, region, heights: source.heights, tileMetres: m.tileMetres });
          section.count = tiles.length / 4;
          if (section.count) device.queue.writeBuffer(section.tiles, 0, tiles);
          const harbour = source.port?.center ?? sources[0].port?.center ?? sources[0].region;
          device.queue.writeBuffer(section.uniform, 0, new Float32Array([region.x - region.span / 2, region.z - region.span / 2, region.span, region.size, section.count, harbour.x, harbour.z, m.harbourHeight ?? FOREST_GROVE_HARBOUR_HEIGHT]));
          groves += section.count;
        }
        for (const [key, section] of sections) if (!seen.has(key)) { release(section); sections.delete(key); }
        stats.sections = sections.size; stats.groves = groves;
        return stands;
      },
      // The climate's cast on the leaves, which a coast learns late (js/terrain.js).
      setTint(next) { device.queue.writeBuffer(look, 32, new Float32Array(next.slice(0, 3))); },
      encode(pass) {
        for (const section of sections.values()) {
          if (!section.count) continue;
          pass.setPipeline(reset); pass.setBindGroup(0, section.resetGroup); pass.dispatchWorkgroups(1);
          pass.setPipeline(cull); pass.setBindGroup(0, section.cullGroup); pass.dispatchWorkgroups(Math.ceil(section.count / 64));
        }
      },
      drawOpaque(pass) {
        if (!stats.groves) return;
        pass.setPipeline(pipeline); pass.setBindGroup(0, scene); pass.setBindGroup(1, cloud); pass.setIndexBuffer(indices, 'uint16');
        for (const section of sections.values()) {
          if (!section.count) continue;
          pass.setBindGroup(2, section.drawGroup);
          for (let level = 0; level < FOREST_GROVE_LEVELS; level++) { pass.setBindGroup(3, levels[level]); pass.drawIndexedIndirect(section.draws, level * 20); }
        }
      },
      destroy() { for (const section of sections.values()) release(section); sections.clear(); for (const resource of owned) resource.destroy(); },
    };
  } catch (error) { for (const resource of owned) resource.destroy(); throw error; }
}
