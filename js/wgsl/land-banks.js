// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A river's banks as ground of the land (js/land-banks.js lays them): the board's bank mesh (riverCut in
// js/old-world-board.js), worked into tiles of how far it lowers or raises the land's lattice, how much of the ground
// is bank and how wet. The land's continuum walks them as it walks the pits (js/wgsl/land-continuum.js): its vertices
// stand on the banks and its ground there is drawn as bank (kind 2).

export const LAND_BANK_TILE_M = 32;
export const LAND_BANK_CELLS = 64;
export const LAND_BANK_CELL_M = LAND_BANK_TILE_M / LAND_BANK_CELLS;
// Texels a side: the tile's cells' corners, its edges shared with the tiles beside it.
export const LAND_BANK_TEXELS = LAND_BANK_CELLS + 1;
// Tiles a row of the atlas the tiles are laid in.
export const LAND_BANK_ATLAS_TILES = 64;
// A tile's blocks: what the land's cut keeps of the banks is kept block by block (landBankWaits).
export const LAND_BANK_BLOCK_M = 2;
export const LAND_BANK_BLOCKS = LAND_BANK_TILE_M / LAND_BANK_BLOCK_M;
// The level of the land's cut a bank's own cell is drawn at, in its finest units (LAND_CONTINUUM_FINEST_M, 1/8 m).
export const LAND_BANK_LEVEL = 2;

// Bound with the land's own (group 2, after the pits' 54 to 57); the pits' sampler reads them too.
export const LAND_BANK_WGSL = /* wgsl */ `
@group(2)@binding(58) var landBankLookup:texture_2d<i32>;
@group(2)@binding(59) var landBankField:texture_2d<f32>;
@group(2)@binding(60) var landBankBlocks:texture_2d<f32>;
// The lookup's origin x z, tiles across it, 1 to look; then the world rectangle every tile lies in (x0 x1 z0 z1).
struct LandBankPlace{origin:vec4f,bounds:vec4f};
@group(2)@binding(61) var<uniform> landBankPlace:LandBankPlace;
fn landBankNear(xz:vec2f)->bool{let b=landBankPlace.bounds;return landBankPlace.origin.w>0.5&&xz.x>=b.x&&xz.x<=b.y&&xz.y>=b.z&&xz.y<=b.w;}
// The tile a point is in: its slot in the atlas (below 0 for none), then the tile's place in the lookup.
fn landBankTile(xz:vec2f)->vec3i{
  let t=vec2i(floor((xz-landBankPlace.origin.xy)*${(1 / LAND_BANK_TILE_M).toFixed(6)}));
  if(any(t<vec2i(0))||any(t>=vec2i(i32(landBankPlace.origin.z)))){return vec3i(-1,t);}
  return vec3i(textureLoad(landBankLookup,t,0).r,t);
}
fn landBankCorner(slot:i32)->vec2i{return vec2i(slot%${LAND_BANK_ATLAS_TILES},slot/${LAND_BANK_ATLAS_TILES});}
// What the banks do at a point: how far they move the lattice's ground, how much of it is bank, how wet.
fn landBankAt(xz:vec2f)->vec3f{
  if(!landBankNear(xz)){return vec3f(0.0);}
  let tile=landBankTile(xz);
  if(tile.x<0){return vec3f(0.0);}
  let local=(xz-landBankPlace.origin.xy)*${(1 / LAND_BANK_CELL_M).toFixed(4)}-vec2f(tile.yz)*${LAND_BANK_CELLS.toFixed(1)};
  let texel=vec2f(landBankCorner(tile.x)*${LAND_BANK_TEXELS})+clamp(local,vec2f(0.0),vec2f(${LAND_BANK_CELLS.toFixed(1)}))+0.5;
  return textureSampleLevel(landBankField,landCraterSampler,texel/vec2f(textureDimensions(landBankField)),0.0).xyz;
}
// The error the land's cut waits for before it brings in a point between its lattice's: the most the banks move the
// ground over the block the point is in. Every patch that reaches the block keeps at least as much (landContinuumDig).
fn landBankWaits(xz:vec2f)->f32{
  if(!landBankNear(xz)){return 0.0;}
  let tile=landBankTile(xz);
  if(tile.x<0){return 0.0;}
  let b=clamp(vec2i(floor((xz-landBankPlace.origin.xy)*${(1 / LAND_BANK_BLOCK_M).toFixed(4)}))-tile.yz*${LAND_BANK_BLOCKS},vec2i(0),vec2i(${LAND_BANK_BLOCKS - 1}));
  return textureLoad(landBankBlocks,landBankCorner(tile.x)*${LAND_BANK_BLOCKS}+b,0).r;
}
`;
