// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass as blades made on the GPU each frame (js/meadow-grass.js for the CPU's part). No tile, patch or atlas:
// every blade is seeded from where it stands in the world, so the sward runs on unbroken and never repeats.
//
//   sow       The world's blades lie in a hierarchy of square cells (MEADOW_BLADE_LEVELS levels, each cell twice the
//             last's side), MEADOW_BLADE_CELL_BLADES to a cell, each at a jittered place in its eighth of the cell, so
//             every level is spread evenly over the ground. Each blade has a rank in [0, 1), level L holding the ranks
//             [4^-(L+1), 4^-L), so over all levels the ranks are even and a blade's rank says how few blades may be
//             drawn before it goes. The cells pass lists each level's cells about the eye that are in view and could
//             hold a blade kept; the sow pass makes each listed cell's blades and keeps those the eye needs.
//   keep      A blade is kept as long as the blades about it, drawn as they are drawn here, lay an optical depth over
//             the ground seen from the eye of at most MEADOW_BLADE_DEPTH (rule 3.4: a deterministic thinning by its
//             rank, the survivors widened to keep the cover). Drawn, no blade is narrower than CONTINUUM_MIN_PIXELS
//             or shorter on screen than CONTINUUM_SPLAT_PIXELS, at the scene's one pixel error: a blade seen end on
//             from above, or one far off, is drawn as a splat at its tip, a pixel or two of the sward where it stands
//             (meadowBladeFieldTop). Where the cover map thins the sward, blades go one by one by their rank. Whether
//             a blade is kept is decided at rest, so wind never makes one come or go; a blade near its rank's limit
//             narrows to nothing rather than vanishing.
//   wind      Each kept blade leans to its own side at rest and downwind as the meadow's wind field gusts over it,
//             with a flutter of its own; shot parts it, blast rings flatten it, craters bury it.
//   draw      Each blade is a curved strip that turns about its own stem to face the eye: six segments near, three
//             in the middle distance, one triangle far and as a splat. It is lit as its own leaf, facing the way its
//             rank's hash turned it: sun through the leaf from behind, sky and ground light, the gloss of its
//             cuticle, darker toward its foot where the sward shades it, lighter where a gust lays it over.
// Grass is never a target: shot passes through it.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SHADOW_FRAME, LAND_CLOTH_SHADOW } from './shadows.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SHADOW_BINDINGS } from './clouds.js';
import { CONTINUUM_CORE_WGSL } from '../continuum-core.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { MEADOW_COMMON_WGSL } from './meadow-continuum.js';
import { MEADOW_GROUND_MIX, MEADOW_LITTER_MIX, MEADOW_LITTERS, MEADOW_GROUND_EDGE_STEP, MEADOW_SHAPE } from '../meadow-crops.js';

// Levels of the blades' hierarchy, blades a cell, the side of a finest cell (metres), and how many cells across each
// level's square about the eye.
export const MEADOW_BLADE_LEVELS = 10;
export const MEADOW_BLADE_CELL_BLADES = 64;
export const MEADOW_BLADE_CELL0 = 0.1875;
export const MEADOW_BLADE_GRID = 192;
// Blades a square metre where the sward grows fullest: every level's cells' blades together.
export const MEADOW_BLADE_DENSITY = (4 / 3) * MEADOW_BLADE_CELL_BLADES / (MEADOW_BLADE_CELL0 * MEADOW_BLADE_CELL0);
// The farthest (in metres, along either axis from the eye) a blade of any rank stays as dense as the finest level
// can hold: each level's square reaches (GRID / 2 - 1) of its cells, and the blades it holds are needed only within
// twice this of the level's cell size over the finest's.
export const MEADOW_BLADE_REACH = (MEADOW_BLADE_GRID / 2 - 1) * MEADOW_BLADE_CELL0 / 2;
// The optical depth the kept blades lay over the ground seen from the eye: e^-5, under one ground pixel in a hundred
// and fifty, shows through.
export const MEADOW_BLADE_DEPTH = 5.0;
// Where the sward is thinner than this seen from the eye with every blade drawn (looking down on it near), its
// blades are widened, at most MEADOW_BLADE_WIDEN times, to lay it.
export const MEADOW_BLADE_FILL = 3.0, MEADOW_BLADE_WIDEN = 2.0;
// Where the levels hold fewer blades than the depth wants, the kept are drawn broader, to at most this many pixels.
export const MEADOW_BLADE_BROADEST = 24.0;
// A splat's breadth, in splat lengths, and how many times broader still a short blade may be drawn when the far list
// is full.
export const MEADOW_BLADE_SPLAT_WIDE = 2.0, MEADOW_BLADE_SPLAT_BROADEST = 8.0;
// Segments of a blade in each of the three lists: near, middle and far (and splats); and how long on screen, in
// pixels, a blade is drawn in the finer two.
export const MEADOW_BLADE_SEGMENTS = Object.freeze([6, 3, 1]);
export const MEADOW_BLADE_LIST_PIXELS = Object.freeze([48, 12]);
// A blade's record: two vec4u (its foot, its reach to the tip, its width, how much larger it is drawn than it is, its
// bend, its seed and its look).
export const MEADOW_BLADE_RECORD_BYTES = 32;
// The cells pass's buffer: the cells listed, the sow pass's workgroups (x, y, z), then two words a cell from word 8.
export const MEADOW_BLADE_CELL_HEADER = 8;
// The sow pass's buffer: each list's drawIndirect record (4 words), then each list's count of blades it was given.
export const MEADOW_BLADE_DRAW_WORDS = 16;
// A pack's sward (js/meadow-grass.js packMeadowSward): its mixes (the meadow's three roles, the crops of worked
// ground and the litters under trees, js/meadow-crops.js) of at most MEADOW_SPECIES_MOST species in all.
export const MEADOW_MIXES = MEADOW_LITTER_MIX + MEADOW_LITTERS;
export const MEADOW_SPECIES_MOST = 80;
export const MEADOW_MIX_BYTES = 64, MEADOW_SPECIES_BYTES = 96;
export const MEADOW_SWARD_BYTES = MEADOW_MIXES * MEADOW_MIX_BYTES + 16 + MEADOW_SPECIES_MOST * MEADOW_SPECIES_BYTES;
// Litter is sown no farther than this (m): farther, it is the ground's own colour, and under the crowns unseen.
export const MEADOW_LITTER_REACH = 260;
// The optical depth litter is kept to, of the sward's: lying flat, a few layers hide the ground.
export const MEADOW_LITTER_DEPTH = 0.6;
// The per-frame uniform, MeadowBladeFrame: 4 vec4.
export const MEADOW_BLADE_FRAME_BYTES = 64;

const MEADOW_BLADE_TYPES_WGSL = /* wgsl */ `
const MEADOW_BLADE_LEVELS: u32 = ${MEADOW_BLADE_LEVELS}u;
const MEADOW_BLADE_CELL_BLADES: u32 = ${MEADOW_BLADE_CELL_BLADES}u;
const MEADOW_BLADE_CELL0: f32 = ${MEADOW_BLADE_CELL0.toFixed(6)};
const MEADOW_BLADE_GRID: i32 = ${MEADOW_BLADE_GRID};
const MEADOW_BLADE_DENSITY: f32 = ${MEADOW_BLADE_DENSITY.toFixed(3)};
const MEADOW_BLADE_FILL: f32 = ${MEADOW_BLADE_FILL.toFixed(3)};
const MEADOW_BLADE_WIDEN: f32 = ${MEADOW_BLADE_WIDEN.toFixed(3)};
const MEADOW_BLADE_BROADEST: f32 = ${MEADOW_BLADE_BROADEST.toFixed(3)};
const MEADOW_BLADE_SPLAT_WIDE: f32 = ${MEADOW_BLADE_SPLAT_WIDE.toFixed(3)};
const MEADOW_BLADE_SPLAT_BROADEST: f32 = ${MEADOW_BLADE_SPLAT_BROADEST.toFixed(3)};
const MEADOW_BLADE_CELL_HEADER: u32 = ${MEADOW_BLADE_CELL_HEADER}u;
const MEADOW_GROUND_MIX: u32 = ${MEADOW_GROUND_MIX}u;
const MEADOW_LITTER_MIX: u32 = ${MEADOW_LITTER_MIX}u;
const MEADOW_GROUND_EDGE_STEP: f32 = ${MEADOW_GROUND_EDGE_STEP.toFixed(4)};
const MEADOW_LITTER_REACH: f32 = ${MEADOW_LITTER_REACH.toFixed(1)};
const MEADOW_LITTER_DEPTH: f32 = ${MEADOW_LITTER_DEPTH.toFixed(3)};
const MEADOW_NO_MIX: u32 = 0xffffu;
// The shapes (js/meadow-crops.js MEADOW_SHAPE): from the oval on, a piece lies on the ground; a needle and a twig
// are round, the rest flat.
const MEADOW_SHAPE_LEAF: u32 = ${MEADOW_SHAPE.LEAF}u;
const MEADOW_SHAPE_OVAL: u32 = ${MEADOW_SHAPE.OVAL}u;
const MEADOW_SHAPE_LOBED: u32 = ${MEADOW_SHAPE.LOBED}u;
const MEADOW_SHAPE_PALMATE: u32 = ${MEADOW_SHAPE.PALMATE}u;
const MEADOW_SHAPE_LANCE: u32 = ${MEADOW_SHAPE.LANCE}u;
const MEADOW_SHAPE_NEEDLE: u32 = ${MEADOW_SHAPE.NEEDLE}u;
const MEADOW_SHAPE_TWIG: u32 = ${MEADOW_SHAPE.TWIG}u;
const MEADOW_SHAPE_STRAP: u32 = ${MEADOW_SHAPE.STRAP}u;
// A species: its colour at the foot (linear) and height (m); at the tip and width (m); its habit: where its share of
// its mix ends (the shares summed), how far it droops at rest (0 upright, 1 laid over), how stiff it is, the share
// bearing a head; then the shares dry and in flower; its head's colour and length (a share of the blade); and its
// form: how much its height varies from plant to plant, its shape, how far it curls or cups, how far up its stalk a
// broad leaf begins.
struct MeadowSpecies {
  foot: vec4f,
  tip: vec4f,
  habit: vec4f,
  extra: vec4f,
  head: vec4f,
  form: vec4f
};
// A mix: its first species, how many, the mix between its rows (MEADOW_NO_MIX for bare ground); its mean colour from
// above (linear) and how dense it grows (a share of the fullest); its rows (how far apart, m, 0 for none; the share
// of a row planted; a ploughed strip's width, m, 0 for none; the bare furrow between strips, m); its plants along a
// row (how far apart, m, 0 for none; the share planted).
struct MeadowMix {
  span: vec4u,
  look: vec4f,
  rows: vec4f,
  plants: vec4f
};
// The pack's sward: its mixes (the meadow's three roles, the crops by MEADOW_GROUND_MIX + their code, the litters by
// MEADOW_LITTER_MIX + their kind), the colour of its flowers, its species.
struct MeadowSward {
  mixes: array<MeadowMix, ${MEADOW_MIXES}>,
  flower: vec4f,
  species: array<MeadowSpecies, ${MEADOW_SPECIES_MOST}>
};
struct MeadowBladeFrame {
  sizes: vec4f,  // the narrowest a blade is drawn and the shortest (pixels), the optical depth kept, the reach (m)
  scene: vec4f,  // the farthest a blade is drawn (m; 0 for no limit), 0, 0, 0
  room: vec4u,   // the blades each list holds, the cells the cells pass may list
  more: vec4u    // 1 when the shot and craters are worth reading, 0, 0, 0
};
fn meadowBladeShift() -> vec3f { return vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z); }
fn meadowBladeFocal() -> f32 { return F.screen.y / max(2.0 * length(F.camUp.xyz), 1e-4); }
fn meadowBladeUnit(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
// Smooth noise over the lattice (0 to 1), at a point already scaled.
fn meadowBladeNoise(q: vec2f) -> f32 {
  let c = vec2i(floor(q));
  let f = fract(q);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(meadowBladeLattice(c), meadowBladeLattice(c + vec2i(1, 0)), u.x);
  let b = mix(meadowBladeLattice(c + vec2i(0, 1)), meadowBladeLattice(c + vec2i(1, 1)), u.x);
  return mix(a, b, u.y);
}
// Where the cover map is read for a point (local metres): moved a little, so a meadow's edge wanders as a sward's
// does instead of following the map's texels.
fn meadowBladeWarp(p: vec2f) -> vec2f {
  let coarse = vec2f(meadowBladeNoise(p * (1.0 / 3.5)), meadowBladeNoise(p * (1.0 / 3.5) + vec2f(31.7, 11.3))) - 0.5;
  let fine = vec2f(meadowBladeNoise(p * (1.0 / 1.1) + vec2f(7.1, 53.9)), meadowBladeNoise(p * (1.0 / 1.1) + vec2f(91.3, 2.7))) - 0.5;
  return coarse * 4.6 + fine * 1.3;
}
// Where a meadow's flowers grow: in drifts some metres across, between them none (0 to 1, local metres).
fn meadowBladeLattice(c: vec2i) -> f32 {
  return meadowBladeUnit(continuumHash((bitcast<u32>(c.x) * 0x27d4eb2du) ^ continuumHash(bitcast<u32>(c.y) * 0x165667b1u + 0x9e3779b9u)));
}
fn meadowBladeDrift(p: vec2f) -> f32 {
  let sum = meadowBladeNoise(p * (1.0 / 11.0)) * 0.65 + meadowBladeNoise(p * (2.7 / 11.0) + vec2f(17.3, 5.1)) * 0.35;
  return smoothstep(0.58, 0.86, sum) * 2.4;
}
// The ground map at a point (local metres, js/meadow-crops.js): its furlong's crop and the kind of its litter, at the
// nearest texel; how far inside its furlong it lies (m), read smoothly, so that a crop ends where its furlong does;
// the way its strips run; how thick its litter lies, read smoothly.
struct MeadowGround {
  code: u32,
  slot: u32,
  edge: f32,
  heading: f32,
  litter: f32
};
fn meadowGroundAt(at: vec2f) -> MeadowGround {
  let size = textureDimensions(meadowGround);
  let uv = meadowDomainUV(at);
  let nearest = textureLoad(meadowGround, min(vec2u(uv * vec2f(size)), size - 1u), 0);
  let soft = textureSampleLevel(meadowGround, landSampler, uv, 0.0);
  let r = u32(round(nearest.r * 255.0));
  return MeadowGround(r & 15u, r >> 4u, soft.g * 255.0 * MEADOW_GROUND_EDGE_STEP, nearest.b * 3.14159265, soft.a);
}
// What grows at a point: the mix a blade there is of (picked by its two hashes) and how much of the fullest sward
// grows there in all. Litter lies over whatever grows. A furlong's crop grows where the cover lets the ground be
// sown (not on the roads and yards carved from it), the margin's grasses on its headland, a ploughed strip's furrow
// bare, between its rows and plants its 'between'; elsewhere the meadow's mixes by the cover's role.
struct MeadowChoice {
  mix: u32,
  amount: f32
};
fn meadowBladeChoose(at: vec2f, cover: vec4f, ground: MeadowGround, pickLitter: f32, pickMix: f32) -> MeadowChoice {
  let worked = ground.code != 0u;
  let open = select(smoothstep(0.06, 0.55, cover.r), smoothstep(0.02, 0.2, cover.r), worked);
  let amount = min(1.0, open * (1.0 - 0.7 * ground.litter) + ground.litter);
  if (amount <= 0.0) { return MeadowChoice(0u, 0.0); }
  if (pickLitter * amount < ground.litter) { return MeadowChoice(MEADOW_LITTER_MIX + ground.slot, amount); }
  if (!worked) {
    let w = meadowMixWeights(cover.g, at);
    return MeadowChoice(select(select(2u, 1u, (pickMix < w.x + w.y)), 0u, (pickMix < w.x)), amount);
  }
  let texel = cfg.domain.z / f32(textureDimensions(meadowGround).x);
  if (ground.edge < 0.71 * texel + 0.6) { return MeadowChoice(2u, amount); }
  var mixAt = MEADOW_GROUND_MIX + ground.code;
  let m = sward.mixes[mixAt];
  let along = vec2f(cos(ground.heading), sin(ground.heading));
  let across = dot(at, vec2f(-along.y, along.x));
  if (m.rows.z > 0.0 && fract(across / m.rows.z) * m.rows.z < m.rows.w) { return MeadowChoice(0u, 0.0); }
  if (m.rows.x > 0.0) {
    let inRow = abs(fract(across / m.rows.x) - 0.5) * 2.0 < m.rows.y;
    let onPlant = (m.plants.x <= 0.0) || (abs(fract(dot(at, along) / m.plants.x) - 0.5) * 2.0 < m.plants.y);
    if (!(inRow && onPlant)) {
      if (m.span.z == MEADOW_NO_MIX) { return MeadowChoice(0u, 0.0); }
      mixAt = MEADOW_GROUND_MIX + m.span.z;
    }
  }
  return MeadowChoice(mixAt, amount);
}
// A species' shape: from the oval on it lies on the ground; a needle and a twig are round.
fn meadowShapeOf(sp: MeadowSpecies) -> u32 { return u32(sp.form.y + 0.5); }
`;

// ------------------------------------------------------------------------------------------------- sow
export function meadowBladesComputeWGSL() {
  return FRAME_WGSL + CONTINUUM_CORE_WGSL + continuumGroundWGSL(0, 13) + MEADOW_COMMON_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> cfg: MeadowCfg;
@group(0) @binding(2) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var meadowCover: texture_2d<f32>;
@group(0) @binding(5) var<uniform> sward: MeadowSward;
@group(0) @binding(6) var<storage, read_write> bladesNear: array<vec4u>;
@group(0) @binding(7) var<storage, read_write> bladeDraws: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> bladeCells: array<atomic<u32>>;
@group(0) @binding(9) var<uniform> wakes: MeadowWakeFrame;
@group(0) @binding(10) var landCraterLookup: texture_2d<i32>;
@group(0) @binding(11) var landCraterField: texture_2d_array<f32>;
@group(0) @binding(12) var landSampler: sampler;
@group(0) @binding(14) var<uniform> bladeFrame: MeadowBladeFrame;
@group(0) @binding(15) var<storage, read> bladeCellsRead: array<u32>;
@group(0) @binding(16) var<storage, read_write> bladesMiddle: array<vec4u>;
@group(0) @binding(17) var<storage, read_write> bladesFar: array<vec4u>;
@group(0) @binding(18) var meadowGround: texture_2d<f32>;
` + MEADOW_BLADE_TYPES_WGSL + /* wgsl */ `
fn meadowBladeSegments(list: u32) -> u32 { return select(select(${MEADOW_BLADE_SEGMENTS[2]}u, ${MEADOW_BLADE_SEGMENTS[1]}u, (list == 1u)), ${MEADOW_BLADE_SEGMENTS[0]}u, (list == 0u)); }
fn meadowBladeEye() -> vec3f { return F.camPos.xyz - meadowBladeShift(); }
fn meadowBladeCellSize(level: u32) -> f32 { return ldexp(MEADOW_BLADE_CELL0, i32(level)); }
// The ranks a level holds: [4^-(L+1), 4^-L), the coarsest down to 0.
fn meadowBladeRankLow(level: u32) -> f32 { return select(ldexp(1.0, -2 * i32(level + 1u)), 0.0, level + 1u >= MEADOW_BLADE_LEVELS); }
fn meadowBladeRankHigh(level: u32) -> f32 { return ldexp(1.0, -2 * i32(level)); }
// The first cell of a level's square about the eye.
fn meadowBladeGridFirst(level: u32) -> vec2i {
  return vec2i(floor(meadowBladeEye().xz / meadowBladeCellSize(level))) - vec2i(MEADOW_BLADE_GRID / 2);
}
// The most of the field's blades that may be kept 'away' metres from the eye along either axis: what the levels'
// squares hold.
fn meadowBladeCap(away: f32) -> f32 { let r = bladeFrame.sizes.w / max(away, 1e-3); return min(1.0, r * r); }
// A sphere about the eye (its centre relative to the eye, in the frame's world) is in the view's frustum.
fn meadowBladeInView(centre: vec3f, radius: f32) -> bool {
  let z = dot(centre, F.camFwd.xyz);
  if (z < -radius) { return false; }
  let tx = length(F.camRight.xyz);
  let ty = length(F.camUp.xyz);
  let x = dot(centre, F.camRight.xyz) / max(tx, 1e-6);
  let y = dot(centre, F.camUp.xyz) / max(ty, 1e-6);
  if (abs(x) > z * tx + radius * sqrt(1.0 + tx * tx)) { return false; }
  return abs(y) <= z * ty + radius * sqrt(1.0 + ty * ty);
}

@compute @workgroup_size(16) fn meadowBladeReset(@builtin(local_invocation_index) i: u32) {
  // Word 15, the splats' breadth, is carried from frame to frame.
  if (i < 15u) { atomicStore(&bladeDraws[i], 0u); }
  if (i < MEADOW_BLADE_CELL_HEADER) { atomicStore(&bladeCells[i], 0u); }
}

// Each level's cells about the eye that lie in the region, in view and near enough to hold a blade kept, listed.
@compute @workgroup_size(64) fn meadowBladeCells(@builtin(global_invocation_id) id: vec3u) {
  let level = id.y;
  let across = u32(MEADOW_BLADE_GRID);
  if (id.x >= across * across || level >= MEADOW_BLADE_LEVELS) { return; }
  let side = meadowBladeCellSize(level);
  let cell = meadowBladeGridFirst(level) + vec2i(i32(id.x % across), i32(id.x / across));
  let lo = vec2f(cell) * side;
  let hi = lo + vec2f(side);
  let half = cfg.domain.z * 0.5;
  if (hi.x < cfg.domain.x - half || lo.x > cfg.domain.x + half || hi.y < cfg.domain.y - half || lo.y > cfg.domain.y + half) { return; }
  let eye = meadowBladeEye();
  let off = max(max(lo - eye.xz, eye.xz - hi), vec2f(0.0));
  if (meadowBladeRankLow(level) >= meadowBladeCap(max(off.x, off.y))) { return; }
  let most = bladeFrame.scene.x;
  if (most > 0.0 && length(off) > most) { return; }
  let mid = (lo + hi) * 0.5;
  let ground = meadowGroundY(mid, cfg.domain, elevation);
  let centre = vec3f(mid.x, ground + 0.6, mid.y) + meadowBladeShift() - F.camPos.xyz;
  if (!meadowBladeInView(centre, side * 1.25 + 3.0)) { return; }
  let slot = atomicAdd(&bladeCells[0], 1u);
  if (slot >= bladeFrame.room.w) { return; }
  atomicStore(&bladeCells[MEADOW_BLADE_CELL_HEADER + 2u * slot], bitcast<u32>(cell.x));
  atomicStore(&bladeCells[MEADOW_BLADE_CELL_HEADER + 2u * slot + 1u], (level << 24u) | (bitcast<u32>(cell.y) & 0xFFFFFFu));
}

// The sow pass's workgroups, a listed cell each, as many rows of 65535 as it takes.
@compute @workgroup_size(1) fn meadowBladeArgs() {
  let n = min(atomicLoad(&bladeCells[0]), bladeFrame.room.w);
  atomicStore(&bladeCells[1], min(n, 65535u));
  atomicStore(&bladeCells[2], max((n + 65534u) / 65535u, 1u));
  atomicStore(&bladeCells[3], 1u);
  // The splats' breadth the last frame left, for the sow pass to read.
  atomicStore(&bladeCells[4], atomicLoad(&bladeDraws[15]));
}

// One blade of a listed cell: made, kept or not, leaned by the wind and written to its list.
fn meadowBladeSowOne(cell: vec2i, level: u32, lane: u32) {
  let side = meadowBladeCellSize(level);
  var h = continuumHash((bitcast<u32>(cell.x) * 0x8da6b343u) ^ continuumHash((bitcast<u32>(cell.y) * 0xd8163841u) ^ (level * 0xcb1ab31fu + lane * 0x9e3779b9u)));
  let seed = h;
  h = continuumHash(h + 0x68e31da4u); let jx = meadowBladeUnit(h);
  h = continuumHash(h + 0xb5297a4du); let jz = meadowBladeUnit(h);
  h = continuumHash(h + 0x1b56c4e9u); let rank = mix(meadowBladeRankLow(level), meadowBladeRankHigh(level), meadowBladeUnit(h));
  let sub = vec2f(f32(lane % 8u), f32(lane / 8u));
  let at = (vec2f(cell) + (sub + vec2f(jx, jz)) / 8.0) * side;
  let eye = meadowBladeEye();
  let cap = meadowBladeCap(max(abs(at.x - eye.x), abs(at.y - eye.z)));
  if (rank >= cap) { return; }
  let uv = (at - cfg.domain.xy) / cfg.domain.z + 0.5;
  if (any((uv < vec2f(0.0))) || any((uv > vec2f(1.0)))) { return; }
  let cover = meadowCoverAt(at + meadowBladeWarp(at));
  // Its mix, by what grows here (the meadow, a furlong's crop or the litter under a tree), and its species, by the
  // mix's shares.
  let lies = meadowGroundAt(at);
  h = continuumHash(h + 0x2f1c3a7bu); let pickMix = meadowBladeUnit(h);
  h = continuumHash(h + 0x51ed270bu); let pickLitter = meadowBladeUnit(h);
  let choice = meadowBladeChoose(at, cover, lies, pickLitter, pickMix);
  if (rank >= cap * choice.amount) { return; }
  let mixAt = choice.mix;
  let mixOf = sward.mixes[mixAt];
  let litter = mixAt >= MEADOW_LITTER_MIX;
  var grows = choice.amount * mixOf.look.w;
  if (litter) { grows *= 1.0 - smoothstep(0.55 * MEADOW_LITTER_REACH, MEADOW_LITTER_REACH, distance(at, eye.xz)); }
  if (rank >= cap * grows) { return; }
  h = continuumHash(h + 0x7a2e91c5u); let pickSpecies = meadowBladeUnit(h);
  let span = mixOf.span;
  var species = span.x;
  for (var k = 0u; k + 1u < span.y; k++) {
    if (pickSpecies < sward.species[span.x + k].habit.x) { break; }
    species = span.x + k + 1u;
  }
  let sp = sward.species[species];
  let shape = meadowShapeOf(sp);
  let lying = shape >= MEADOW_SHAPE_OVAL;
  var ground = meadowGroundY(at, cfg.domain, elevation) + continuumGroundLift(at + meadowBladeShift().xz);
  if (ground < cfg.domain.w) { return; }
  h = continuumHash(h + 0x4c8a5f13u); let tall = meadowBladeUnit(h);
  h = continuumHash(h + 0x93d1e8b7u); let broad = meadowBladeUnit(h);
  h = continuumHash(h + 0x5e0f6a21u); let turn = meadowBladeUnit(h) * 6.2831853;
  h = continuumHash(h + 0xa7c34d09u); let droopShare = meadowBladeUnit(h);
  var height = sp.foot.w * (1.0 - sp.form.x + 2.0 * sp.form.x * tall);
  if (!lying) { height *= meadowWorldBillow(at).x; }
  if (mixAt < MEADOW_GROUND_MIX + 1u) { height *= 0.62 + 0.55 * cover.b; }
  let width = sp.tip.w * (0.78 + 0.44 * broad);
  // At rest it droops toward its own side; a leaf, a needle or a twig lies on the litter under it, turned its own
  // way.
  let droop = vec2f(cos(turn), sin(turn)) * (sp.habit.y * 0.42 * (0.6 + 0.8 * droopShare));
  if (lying) { ground += 0.004 + 0.022 * droopShare; }

  // Kept or not, at rest: as long as the blades about it, drawn as they are drawn, lay no more than the depth kept.
  let shift = meadowBladeShift();
  let restLean = droop * height;
  let restRise = sqrt(max(height * height - dot(restLean, restLean), 0.04 * height * height));
  let restStem = select(vec3f(restLean.x, restRise, restLean.y), vec3f(cos(turn), 0.0, sin(turn)) * height, lying);
  let root = vec3f(at.x, ground, at.y) + shift;
  let toMid = root + restStem * 0.5 - F.camPos.xyz;
  let dist = max(length(toMid), CONTINUUM_NEAREST);
  if (!meadowBladeInView(toMid, height * 0.75 + 0.1)) { return; }
  let view = toMid / dist;
  let perMetre = meadowBladeFocal() / dist;
  let lenPx = length(restStem - view * dot(restStem, view)) * perMetre;
  // A flat piece on the ground shows the eye its area foreshortened by the slant it is seen at: drawn as long as it
  // shows, as broad as makes that area. A round one, and a standing blade, is as broad as it is from every side.
  let flatShape = lying && shape != MEADOW_SHAPE_NEEDLE && shape != MEADOW_SHAPE_TWIG;
  var widthPx = width * perMetre;
  if (flatShape) { widthPx = min(widthPx, width * height * abs(view.y) * perMetre * perMetre / max(lenPx, 1e-4)); }
  let least = bladeFrame.sizes.x;
  let splat = bladeFrame.sizes.y;
  var drawnLen = max(lenPx, splat);
  var drawnWidth = max(max(widthPx, least), splat - lenPx);
  // A splat is drawn broad: its colour is the sward's under each of its pixels, and the broader, the fewer laid. So
  // is every short blade when the far list was full: they too show the sward's colour, not their own.
  drawnWidth = max(drawnWidth, splat * MEADOW_BLADE_SPLAT_WIDE * clamp(1.0 - lenPx / splat, 0.0, 1.0));
  if (drawnLen <= ${MEADOW_BLADE_LIST_PIXELS[1].toFixed(1)}) { drawnWidth *= clamp(bitcast<f32>(bladeCellsRead[4]), 1.0, MEADOW_BLADE_SPLAT_BROADEST); }
  // The blades a pixel's ground holds, the ground seen at a slant, and the depth they lay drawn so.
  let slant = max(abs(view.y), 0.03);
  let perPixel = MEADOW_BLADE_DENSITY * grows / (perMetre * perMetre * slant);
  // A broad leaf on its stalk hides the ground only with its leaf.
  let leafy = select(0.55, 0.62 * (1.0 - sp.form.w) + 0.08 * sp.form.w, shape == MEADOW_SHAPE_LEAF);
  let laid = perPixel * drawnLen * drawnWidth * leafy;
  let depth = bladeFrame.sizes.z * select(1.0, MEADOW_LITTER_DEPTH, lying);
  var keep = min(1.0, depth / max(laid, 1e-6));
  if (keep > cap) {
    // More are wanted than the levels hold this far out: the kept are drawn the larger, no taller than they stand
    // upright (a blade never rises above the sward), the rest of it in breadth.
    let grow = keep / cap;
    let upright = max(height * perMetre * sqrt(max(1.0 - view.y * view.y, 0.0)), drawnLen);
    let longer = clamp(upright / drawnLen, 1.0, sqrt(grow));
    drawnLen *= longer;
    drawnWidth = min(drawnWidth * grow / longer, max(drawnWidth, MEADOW_BLADE_BROADEST));
    keep = cap;
  } else if (laid < MEADOW_BLADE_FILL) {
    drawnWidth *= min(MEADOW_BLADE_FILL / max(laid, 1e-4), MEADOW_BLADE_WIDEN);
  }
  let most = bladeFrame.scene.x;
  if (most > 0.0) { keep *= 1.0 - smoothstep(most * 0.8, most, dist); }
  let limit = keep * grows;
  if (rank >= limit) { return; }
  // Near its rank's limit a blade narrows to nothing.
  drawnWidth *= clamp((limit - rank) / (0.2 * limit), 0.0, 1.0);

  // The wind: a lean downwind as the gusts roll over it, and a flutter of its own. What lies on the ground lies still.
  var bend = 0.0;
  var lean = vec2f(0.0);
  var singe = 0.0;
  if (!lying) {
  let time = F.camPos.w;
  let wind = meadowWindField(at, time, F.windP[0]);
  let windDir = meadowWindDirection();
  let crossWind = vec2f(-windDir.y, windDir.x);
  let speed = max(F.windP[0].z, 0.0);
  let curl = meadowWindCurl(at, time, windDir, speed);
  let stiffness = 9.5 / (clamp(sp.habit.z, 3.0, 22.0) + 4.5);
  // The gust's own shape (0 to 1), the field having scaled it by the wind's speed; the speed then says how far.
  // Gusts come in billows, not rows: the bands swell and fade under patches carried downwind with them.
  let carried = at - windDir * (time * max(speed, 0.8) * 0.9);
  let billow = meadowBladeNoise(carried * (1.0 / 19.0)) * 0.62 + meadowBladeNoise(carried * (1.0 / 6.5) + vec2f(13.1, 71.7)) * 0.38;
  let band = clamp(wind.x / max(smoothstep(0.35, 9.5, speed), 0.05) * mix(0.25, 1.75, billow), 0.0, 1.0);
  let speedShare = clamp(speed / 9.0, 0.0, 1.5);
  let quiver = smoothstep(0.15, 2.4, speed) * mix(0.55, 1.0, clamp(speed / 9.5, 0.0, 1.0));
  h = continuumHash(h + 0x3b9ac5f1u); let phase = meadowBladeUnit(h) * 6.2831853;
  let rate = 5.2 + 3.8 * meadowBladeUnit(continuumHash(h + 0x11u)) + min(speed, 16.0) * 0.22;
  let flutter = (sin(time * rate + phase + dot(at, windDir) * 2.9) * 0.09 + cos(time * rate * 1.37 + phase * 1.7) * 0.05) * quiver;
  bend = clamp((0.02 * quiver + (0.12 + 0.58 * band) * speedShare + flutter) * stiffness, 0.0, 0.85);
  let bendDir = normalize(windDir + crossWind * (curl * (0.10 + 0.22 * band)));
  lean = droop * height * (1.0 - 0.6 * bend) + bendDir * (bend * height * 0.78);
  }
  if (bladeFrame.more.x != 0u && dist < 90.0) {
    let shot = meadowEvalBallistics(at, ground, seed);
    if (shot.buryDepth > 0.92) { return; }
    if (!lying) {
      height *= (1.0 - 0.85 * shot.buryDepth) * (1.0 - 0.55 * shot.pressDown);
      lean += shot.pushXZ * height * 1.6;
    }
    singe = shot.hotSinge;
  }
  let leanLen = length(lean);
  if (leanLen > 0.95 * height) { lean *= 0.95 * height / leanLen; }
  let rise = sqrt(max(height * height - dot(lean, lean), 0.0025 * height * height));
  let stem = select(vec3f(lean.x, rise, lean.y), restStem, lying);

  // Drawn: seen end on, or far, it is drawn from near its tip as a splat; drawn out across the eye's line to the
  // length kept.
  let splatShare = clamp(1.0 - lenPx / splat, 0.0, 1.0);
  let foot = root + stem * (0.85 * splatShare);
  var reach = stem * (1.0 - 0.85 * splatShare);
  let reachAcross = reach - view * dot(reach, view);
  let acrossLen = length(reachAcross);
  let wantLen = drawnLen / perMetre;
  if (acrossLen < wantLen) {
    if (lying && acrossLen > 1e-5) {
      // Lying, it is drawn longer along the ground.
      reach *= wantLen / acrossLen;
    } else {
      // Standing, upward; lying end on, across the eye along the ground.
      let toward = select(F.camUp.xyz, F.camRight.xyz, lying);
      let up = toward - view * dot(toward, view);
      let along = select(normalize(up), reachAcross / max(acrossLen, 1e-6), acrossLen > 1e-5);
      reach += along * (wantLen - acrossLen);
    }
  }
  let list = select(select(2u, 1u, drawnLen > ${MEADOW_BLADE_LIST_PIXELS[1].toFixed(1)}), 0u, drawnLen > ${MEADOW_BLADE_LIST_PIXELS[0].toFixed(1)});
  let inflate = clamp((drawnWidth * drawnLen) / max(widthPx * max(lenPx, 0.05), 1e-4), 1.0, 60000.0);
  // A flat piece drawn near as large as it is lies flat on the ground, as broad as it is; drawn larger, it turns to
  // the eye as a blade does.
  let flat = flatShape && inflate <= 1.5;
  let drawnBreadth = select(drawnWidth / perMetre, width * drawnWidth / max(widthPx, 1e-6), flat);
  // Its look: species, whether it bears a head, a flower or is dry, how singed it is and how tall beside its kind.
  h = continuumHash(h + 0x6d2b79f5u);
  let headed = meadowBladeUnit(h) < sp.habit.w;
  h = continuumHash(h + 0x2545f491u);
  let flowering = meadowBladeUnit(h) < sp.extra.y * meadowBladeDrift(at);
  h = continuumHash(h + 0x9e3779b9u);
  let dry = meadowBladeUnit(h) < sp.extra.x;
  let flags = select(0u, 1u, headed) | select(0u, 2u, flowering) | select(0u, 4u, dry) | select(0u, 8u, flat);
  let stature = u32(clamp(tall, 0.0, 1.0) * 255.0);
  let look = species | (flags << 8u) | (u32(clamp(singe, 0.0, 1.0) * 255.0) << 16u) | (stature << 24u);
  let first = vec4u(bitcast<u32>(foot.x), bitcast<u32>(foot.y), bitcast<u32>(foot.z), pack2x16float(reach.xy));
  let second = vec4u(pack2x16float(vec2f(reach.z, drawnBreadth)), pack2x16float(vec2f(inflate, bend)), seed, look);
  let slot = atomicAdd(&bladeDraws[12u + list], 1u);
  if (slot >= bladeFrame.room[list]) { return; }
  if (list == 0u) { bladesNear[2u * slot] = first; bladesNear[2u * slot + 1u] = second; }
  else if (list == 1u) { bladesMiddle[2u * slot] = first; bladesMiddle[2u * slot + 1u] = second; }
  else { bladesFar[2u * slot] = first; bladesFar[2u * slot + 1u] = second; }
}

@compute @workgroup_size(64) fn meadowBladeSow(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let entry = group.x + group.y * 65535u;
  if (entry >= min(bladeCellsRead[0], bladeFrame.room.w)) { return; }
  let cx = bitcast<i32>(bladeCellsRead[MEADOW_BLADE_CELL_HEADER + 2u * entry]);
  let packed = bladeCellsRead[MEADOW_BLADE_CELL_HEADER + 2u * entry + 1u];
  let cz = bitcast<i32>(packed << 8u) >> 8u;
  meadowBladeSowOne(vec2i(cx, cz), packed >> 24u, lane);
}

// Each list's drawIndirect record, from the blades it was given.
@compute @workgroup_size(1) fn meadowBladeFinish() {
  // A splat takes its colour pixel by pixel from the sward under it, so how broad it is drawn shows nowhere: where
  // more were sown than the far list holds, the next frame's are broader and fewer, and narrower again as room frees.
  let was = bitcast<f32>(atomicLoad(&bladeDraws[15]));
  let breadth = select(1.0, was, (was >= 1.0) && (was <= MEADOW_BLADE_SPLAT_BROADEST));
  let want = f32(atomicLoad(&bladeDraws[14])) / (0.8 * f32(max(bladeFrame.room.z, 1u)));
  atomicStore(&bladeDraws[15], bitcast<u32>(clamp(breadth * clamp(sqrt(want), 0.85, 1.25), 1.0, MEADOW_BLADE_SPLAT_BROADEST)));
  for (var k = 0u; k < 3u; k++) {
    let n = min(atomicLoad(&bladeDraws[12u + k]), bladeFrame.room[k]);
    atomicStore(&bladeDraws[k * 4u], (2u * meadowBladeSegments(k) - 1u) * 3u);
    atomicStore(&bladeDraws[k * 4u + 1u], n);
    atomicStore(&bladeDraws[k * 4u + 2u], 0u);
    atomicStore(&bladeDraws[k * 4u + 3u], 0u);
  }
}
`;
}

// ------------------------------------------------------------------------------------------------- draw
export function meadowBladesDrawWGSL() {
  return FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SHADOW_BINDINGS + CONTINUUM_CORE_WGSL + MEADOW_COMMON_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<uniform> cfg: MeadowCfg;
@group(0) @binding(6) var<uniform> sward: MeadowSward;
@group(0) @binding(7) var<uniform> bladeFrame: MeadowBladeFrame;
@group(0) @binding(8) var<storage, read> blades: array<vec4u>;
@group(0) @binding(9) var<uniform> nearTerrain: MeadowNearDomain;
@group(0) @binding(10) var<uniform> wakes: MeadowWakeFrame;
@group(0) @binding(11) var landCraterLookup: texture_2d<i32>;
@group(0) @binding(12) var landCraterField: texture_2d_array<f32>;
@group(0) @binding(15) var landLight: texture_2d<f32>;
@group(0) @binding(16) var meadowCover: texture_2d<f32>;
@group(0) @binding(17) var meadowGround: texture_2d<f32>;
@group(0) @binding(18) var landSampler: sampler;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;
` + LAND_CLOTH_SHADOW + MEADOW_BLADE_TYPES_WGSL + /* wgsl */ `
override MEADOW_BLADE_SEGMENTS_DRAWN: u32 = 6u;
// Straw: a dry blade's foot and tip (linear).
const MEADOW_STRAW_FOOT = vec3f(0.092, 0.078, 0.036);
const MEADOW_STRAW_TIP = vec3f(0.215, 0.178, 0.084);
struct MeadowBladeVarying {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,                    // the frame's world
  @location(1) blade: vec2f,                    // how far along it (0 foot, 1 tip), across it (-1 to 1)
  @location(2) normal: vec3f,                   // its leaf's own facing
  @location(3) @interpolate(flat) foot: vec3f,  // its colour at the foot and the tip (linear)
  @location(4) @interpolate(flat) tip: vec3f,
  @location(5) @interpolate(flat) info: vec4f,  // how much larger it is drawn than it is, its bend, its singe, its stature
  @location(6) @interpolate(flat) look: vec4u   // its species, its flags (1 head, 2 flower, 4 dry, 8 flat), its seed, its shape
};

// A piece's breadth along it (0 at its foot, 1 at its tip), by its shape: a blade tapering to its point; a leaf on
// its stalk; an oval, an oak's lobes, a maple's broad palm, a willow's lance; a needle and a twig, near even; a
// palm's strap.
fn meadowBladeOutline(shape: u32, t: f32, stalk: f32) -> f32 {
  let leaf = pow(max(sin(3.14159265 * t), 0.0), 0.6);
  switch (shape) {
    case MEADOW_SHAPE_LEAF: { return max(0.08, pow(max(sin(3.14159265 * clamp((t - stalk) / max(1.0 - stalk, 0.05), 0.0, 1.0)), 0.0), 0.6)); }
    case MEADOW_SHAPE_OVAL: { return max(0.12, leaf); }
    case MEADOW_SHAPE_LOBED: { return max(0.1, leaf * (0.78 + 0.22 * cos(t * 6.2831853 * 3.5))); }
    case MEADOW_SHAPE_PALMATE: { return max(0.1, pow(max(sin(3.14159265 * pow(t, 0.8)), 0.0), 0.45) * (0.85 + 0.15 * cos(t * 6.2831853 * 2.5))); }
    case MEADOW_SHAPE_LANCE: { return 0.06 + max(sin(3.14159265 * t), 0.0) * (1.0 - 0.35 * t); }
    case MEADOW_SHAPE_NEEDLE, MEADOW_SHAPE_TWIG: { return 1.0 - 0.35 * t; }
    case MEADOW_SHAPE_STRAP: { return 1.0 - 0.5 * t * t; }
    default: { return sqrt(max(1.0 - t * t * t, 0.0)); }
  }
}

fn meadowShadowVis(world: vec3f, normal: vec3f) -> vec3f {
  if (landSH.origin.w < 0.5) { return vec3f(1.0); }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.05 + landSH.sun.xyz * 0.04, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return vec3f(1.0); }
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(vec3f(1.0), s * landClothShadow(uv, refZ), fade);
}

@vertex fn meadowBladeVS(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> MeadowBladeVarying {
  let first = blades[2u * instance];
  let second = blades[2u * instance + 1u];
  let foot = vec3f(bitcast<f32>(first.x), bitcast<f32>(first.y), bitcast<f32>(first.z));
  let reachXY = unpack2x16float(first.w);
  let reachZW = unpack2x16float(second.x);
  let reach = vec3f(reachXY.x, reachXY.y, reachZW.x);
  let width = reachZW.y;
  let drawn = unpack2x16float(second.y);
  let seed = second.z;
  let look = second.w;
  // Which of its points: rows 0..S across, two corners a row and one at the tip; a quad a segment, the last a
  // triangle.
  let S = MEADOW_BLADE_SEGMENTS_DRAWN;
  let tri = vertex / 3u;
  let corner = vertex % 3u;
  var row = 0u;
  var across = 0.0;
  if (tri < 2u * (S - 1u)) {
    let segment = tri / 2u;
    if ((tri & 1u) == 0u) {
      row = segment + select(0u, 1u, corner == 2u);
      across = select(-1.0, 1.0, corner == 1u);
    } else {
      row = segment + select(1u, 0u, corner == 1u);
      across = select(-1.0, 1.0, corner != 0u);
    }
  } else {
    row = select(S - 1u, S, corner == 2u);
    across = select(select(-1.0, 1.0, corner == 1u), 0.0, corner == 2u);
  }
  let t = f32(row) / f32(S);
  let sp = sward.species[look & 255u];
  let kind = meadowShapeOf(sp);
  let lying = kind >= MEADOW_SHAPE_OVAL;
  let flags = (look >> 8u) & 255u;
  let flat = (flags & 8u) != 0u;
  let curl = sp.form.z;
  var p = vec3f(0.0);
  var tangent = vec3f(0.0, 1.0, 0.0);
  if (lying) {
    // Lying on the ground, arched a little along it, its tip curling up as it dries.
    let len = length(reach);
    p = foot + reach * t + vec3f(0.0, curl * len * (0.10 * t * t + 0.05 * sin(3.14159265 * t)), 0.0);
    tangent = reach + vec3f(0.0, curl * len * (0.2 * t + 0.05 * 3.14159265 * cos(3.14159265 * t)), 0.0);
  } else {
    // Its stem: rising, then arching over toward its tip.
    let tipAt = foot + reach;
    let lift = max(reach.y, 0.0) * 0.78 + length(reach.xz) * 0.32;
    let control = foot + vec3f(reach.x * 0.18, lift, reach.z * 0.18);
    let s = 1.0 - t;
    p = s * s * foot + 2.0 * s * t * control + t * t * tipAt;
    tangent = 2.0 * s * (control - foot) + 2.0 * t * (tipAt - control);
  }
  tangent = select(vec3f(0.0, 1.0, 0.0), normalize(tangent), dot(tangent, tangent) > 1e-12);
  // Turned about its stem to face the eye; a flat piece on the ground lies flat, square to its stem along the ground;
  // a broad leaf on its stalk faces its own way, the way its seed turns it.
  let turn = f32(seed & 1023u) * (6.2831853 / 1024.0);
  let facing = vec3f(cos(turn), 0.22, sin(turn));
  let toward = p - F.camPos.xyz;
  var sideways = cross(tangent, toward);
  if (flat) { sideways = cross(vec3f(0.0, 1.0, 0.0), tangent); }
  if (kind == MEADOW_SHAPE_LEAF && drawn.x <= 1.5) { sideways = cross(tangent, facing); }
  sideways = select(normalize(F.camRight.xyz), normalize(sideways), dot(sideways, sideways) > 1e-12 * max(dot(toward, toward), 1.0));
  var shape = meadowBladeOutline(kind, t, sp.form.w);
  if (!lying && S >= 3u) {
    // A head is a little broader than its blade; a flower opens wide.
    if ((flags & 1u) != 0u) { shape *= 1.0 + 0.45 * smoothstep(1.0 - sp.head.w - 0.04, 1.0 - sp.head.w, t); }
    if ((flags & 2u) != 0u && S >= 6u) { shape *= 1.0 + 4.5 * smoothstep(0.7, 0.86, t); }
  }
  var at = p + sideways * (across * 0.5 * width * shape);
  // The leaf's own facing: turned the way its seed turns it, square to its stem, cupped across. A leaf on the ground
  // faces up, its edges curled up as it dries; a needle or a twig is lit as the ground it lies on.
  var n = normalize(facing - tangent * dot(facing, tangent) + sideways * (across * 0.35));
  if (lying) {
    if (flat) {
      at.y += across * across * curl * 0.3 * width * shape;
      n = normalize(vec3f(0.0, 1.0, 0.0) - sideways * (across * curl * 1.2));
    } else {
      n = normalize(vec3f(0.0, 1.0, 0.0) + facing * 0.3);
    }
  }
  // Its colours: its species', a little lighter or darker as its seed has it; straw if dry.
  let vary = 0.84 + 0.32 * f32((seed >> 10u) & 255u) / 255.0;
  let green = 0.94 + 0.12 * f32((seed >> 18u) & 255u) / 255.0;
  var footColour = sp.foot.rgb * vary;
  var tipColour = sp.tip.rgb * vary * vec3f(1.0, green, 1.0);
  if ((flags & 4u) != 0u) {
    footColour = mix(footColour, MEADOW_STRAW_FOOT * vary, 0.85);
    tipColour = mix(tipColour, MEADOW_STRAW_TIP * vary, 0.9);
  }
  var out: MeadowBladeVarying;
  out.position = F.viewProj * vec4f(at - F.camPos.xyz, 1.0);
  out.world = at;
  out.blade = vec2f(t, across);
  out.normal = n;
  out.foot = footColour;
  out.tip = tipColour;
  out.info = vec4f(drawn.x, drawn.y, f32((look >> 16u) & 255u) / 255.0, f32(look >> 24u) / 255.0);
  out.look = vec4u(look & 255u, flags, seed, kind);
  return out;
}

// What the sward shows from here at a point (local), each pixel 'foot' metres across, seen from 'up' (the eye's
// height over the ground, as a share of its distance): the colour of the blade whose tip is over it, the wind having
// leaned the tips downwind, or, looking down into it, the shade between them; where a pixel holds many blades, their
// mean. The alpha is how much of the sky the tips there see.
fn meadowBladeFieldTop(at: vec2f, foot: f32, up: f32) -> vec4f {
  let wind = meadowWindField(at, F.camPos.w, F.windP[0]);
  let speed = max(F.windP[0].z, 0.0);
  let lean = meadowWindDirection() * (0.05 + 0.20 * wind.x * smoothstep(0.5, 9.0, speed));
  let p = at - lean;
  let cover = meadowCoverAt(at + meadowBladeWarp(at));
  let lies = meadowGroundAt(at);
  // The mean of what grows here: the meadow's mixes by the cover's role, or the furlong's crop; the litter over it.
  let weights = meadowMixWeights(cover.g, at);
  var mean = weights.x * sward.mixes[0].look.rgb + weights.y * sward.mixes[1].look.rgb + weights.z * sward.mixes[2].look.rgb;
  if (lies.code != 0u) { mean = sward.mixes[MEADOW_GROUND_MIX + lies.code].look.rgb; }
  let spacing = inverseSqrt(MEADOW_BLADE_DENSITY);
  let grain = max(foot, spacing);
  let cell = vec2i(floor(p / grain));
  let h0 = continuumHash((bitcast<u32>(cell.x) * 0x8da6b343u) ^ continuumHash(bitcast<u32>(cell.y) * 0xd8163841u + 0x5bd1e995u));
  let choice = meadowBladeChoose(at, cover, lies, meadowBladeUnit(continuumHash(h0 + 0x51ed270bu)), meadowBladeUnit(h0));
  if (choice.amount > 0.0) { mean = mix(mean, sward.mixes[MEADOW_LITTER_MIX + lies.slot].look.rgb, clamp(lies.litter / choice.amount, 0.0, 1.0)); }
  let span = sward.mixes[choice.mix].span;
  let h1 = continuumHash(h0 + 0x7a2e91c5u);
  let pickSpecies = meadowBladeUnit(h1);
  var species = span.x;
  for (var k = 0u; k + 1u < span.y; k++) {
    if (pickSpecies < sward.species[span.x + k].habit.x) { break; }
    species = span.x + k + 1u;
  }
  let sp = sward.species[species];
  let h2 = continuumHash(h1 + 0x4c8a5f13u);
  // Looking down into the sward, between the tips: its shaded depth. Litter has none.
  let lying = meadowShapeOf(sp) >= MEADOW_SHAPE_OVAL;
  let deep = !lying && (meadowBladeUnit(continuumHash(h2 + 0x68e31da4u)) < 0.5 * smoothstep(0.2, 0.9, up));
  let along = select(0.55 + 0.45 * meadowBladeUnit(h2), 0.12 + 0.3 * meadowBladeUnit(h2), deep);
  var colour = mix(sp.foot.rgb, sp.tip.rgb, along) * (0.84 + 0.32 * meadowBladeUnit(continuumHash(h2 + 1u)));
  let h3 = continuumHash(h2 + 0x2545f491u);
  if (meadowBladeUnit(h3) < sp.extra.x) { colour = mix(MEADOW_STRAW_FOOT, MEADOW_STRAW_TIP, along); }
  if (!deep) {
    // A head is a little of its blade, a flower less: a pixel of either is mostly blade.
    if (meadowBladeUnit(continuumHash(h3 + 9u)) < sp.habit.w * 0.5) { colour = mix(colour, sp.head.rgb, 0.55); }
    if (meadowBladeUnit(continuumHash(h3 + 7u)) < sp.extra.y * 0.5 * meadowBladeDrift(p)) { colour = mix(colour, sward.flower.rgb, 0.8); }
  }
  // Many blades to a pixel: the mean, the more so the more there are.
  let single = clamp(spacing * 1.6 / max(foot, 1e-4), 0.0, 1.0);
  let lit = select(select(0.62 + 0.38 * along, 0.22 + 0.4 * along, deep), 0.7 + 0.2 * along, lying);
  return vec4f(mix(mean, colour, single), mix(mix(0.78, 0.52, smoothstep(0.2, 0.9, up)), lit, single));
}

@fragment fn meadowBladeFS(v: MeadowBladeVarying) -> @location(0) vec4f {
  let shift = meadowBladeShift();
  let local = v.world - shift;
  let toEye = F.camPos.xyz - v.world;
  let dist = length(toEye);
  let view = toEye / max(dist, 1e-4);
  let t = clamp(v.blade.x, 0.0, 1.0);
  let flags = v.look.y;
  let sp = sward.species[v.look.x];
  let lying = v.look.w >= MEADOW_SHAPE_OVAL;
  var albedo = mix(v.foot, v.tip, smoothstep(0.04, 0.96, t));
  if ((flags & 1u) != 0u) { albedo = mix(albedo, sp.head.rgb, smoothstep(1.0 - sp.head.w - 0.04, 1.0 - sp.head.w, t)); }
  if ((flags & 2u) != 0u) { albedo = mix(albedo, sward.flower.rgb, smoothstep(0.74, 0.82, t)); }
  // Deep in the sward a blade sees less of the sky and the sun: darker toward its foot, the more for a short one.
  // Litter lies under what stands over it, some pieces deeper in it than others.
  var shade = select(mix(0.1, 1.0, pow(t, 0.85)) * mix(0.75, 1.0, v.info.w), mix(0.5, 0.92, v.info.w), lying);
  var n = normalize(v.normal);
  // Drawn larger than it is, a blade shows the sward where it is drawn: the tips over each pixel, leaned by the wind.
  let field = smoothstep(1.8, 5.0, v.info.x);
  let windDir = meadowWindDirection();
  if (field > 0.0) {
    let foot = dist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0);
    let top = meadowBladeFieldTop(local.xz, foot, abs(view.y));
    albedo = mix(albedo, top.rgb, field);
    shade = mix(shade, top.a * mix(0.72, 1.0, t), field);
    let laid = vec3f(windDir.x, 0.0, windDir.y) * (0.25 + 0.6 * v.info.y);
    n = normalize(mix(n, normalize(vec3f(0.0, 1.0, 0.0) + laid), field));
  }
  // A gust lays the blades over, and their faces catch the sky: the wind's bands across the meadow.
  let crest = smoothstep(0.05, 0.34, v.info.y);
  if (!lying) { albedo *= mix(0.84, 1.16, crest); }
  let singe = v.info.z * smoothstep(0.35, 0.92, t);
  if (singe > 0.001) { albedo = mix(albedo, mix(vec3f(0.022, 0.016, 0.011), vec3f(0.11, 0.048, 0.014), smoothstep(0.7, 0.98, t)), singe * 0.88); }
  // Lit on the face the eye sees.
  if (dot(n, view) < 0.0) { n = -n; }
  let L = F.sunDir.xyz;
  let landUV = (local.xz - cfg.domain.xy) / cfg.domain.z + 0.5;
  let edge = min(min(landUV.x, 1.0 - landUV.x), min(landUV.y, 1.0 - landUV.y));
  let inDomain = select(0.0, smoothstep(0.0, 0.08, edge), cfg.more.z != 0u);
  let baked = textureSampleLevel(landLight, sampC, clamp(landUV, vec2f(0.0), vec2f(1.0)), 0.0).rg;
  var castShadow = vec3f(1.0);
  if (dist < 220.0) { castShadow = meadowShadowVis(local, n); }
  let sunSeen = mix(1.0, baked.r, inDomain) * solarShadowVisibility(vec3f(cloudShadowAt(v.world * 0.001, L))).x;
  let direct = sunIlluminance() * sunSeen * solarShadowVisibility(castShadow);
  let sunDeep = mix(shade, 1.0, 0.15);
  let nDotL = dot(n, L);
  let diffuse = max(nDotL, 0.0) * 0.86 + max(nDotL * 0.5 + 0.5, 0.0) * 0.14;
  // The sun through the leaf: from behind it, and most looking toward the sun.
  let behind = max(-nDotL, 0.0);
  let forward = pow(max(dot(-view, L), 0.0), 3.0);
  // A dead leaf lets little through.
  let through = (behind * 0.55 + forward * 0.9) * sunDeep * select(1.0, 0.25, lying);
  let throughColour = mix(albedo * vec3f(1.25, 1.45, 0.55), albedo * 1.2, f32((flags & 4u) != 0u));
  // The gloss of its cuticle.
  let halfway = normalize(view + L);
  let gloss = pow(max(dot(n, halfway), 0.0), 24.0) * (0.012 + 0.03 * pow(1.0 - max(dot(n, view), 0.0), 4.0));
  let skyLight = textureSampleLevel(envCube, sampC, normalize(vec3f(n.x * 0.6, max(n.y, 0.15), n.z * 0.6)), 6.0).rgb;
  // Under the tips the sky is seen through blades: the light there greener, the deeper the more.
  let canopy = select(mix(vec3f(1.0), vec3f(0.7, 1.0, 0.5), 0.3 + 0.5 * (1.0 - t)), vec3f(1.0), lying);
  let ambient = skyLight * canopy * mix(0.55, 1.0, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * shade;
  // Laid over by a gust, a blade's upper face mirrors the sky: the sheen of the wind's bands.
  let sheen = skyLight * (crest * 0.05 * pow(1.0 - max(dot(n, view), 0.0), 2.0) + crest * 0.012) * shade;
  var colour = albedo * (direct * diffuse * sunDeep / PI + ambient) + throughColour * direct * through * 0.32 / PI + direct * gloss * sunDeep / PI + sheen;
  colour += lunarSurface(n, view, albedo, 0.76, vec3f(0.034), vec3f(mix(1.0, baked.g, inDomain)) * lunarShadowVisibility(castShadow));
  return vec4f(surfaceAir(colour, v.world), 1.0);
}
`;
}
