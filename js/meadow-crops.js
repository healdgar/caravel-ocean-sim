// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What grows on worked ground and what lies under trees, for the meadow's blades (js/wgsl/meadow-blades.js): the crop
// of each of a board's furlongs (js/old-world-board.js) as the year turns, and the litter each kind of tree drops.
// The CPU sets out the ground map when the land or the trees change, and the sward's mixes when the day changes; the
// GPU sows, keeps, thins and draws every stalk, leaf and needle as it does the meadow's grass.
//
// The ground map (rgba8, over the meadow's region): r its furlong's crop (MEADOW_GROUND, low four bits) and the kind
// of tree whose litter lies there (MEADOW_LITTER, high four bits), read at the nearest texel; g how far inside its
// furlong a point lies (MEADOW_GROUND_EDGE_STEP metres a step), read smoothly, so that a crop ends where its furlong
// does and not at the map's texels; b the way its strips run (0 to pi); a how thick the litter lies, read smoothly.
import { OLD_WORLD_LAND } from './old-world.js';

// A species of a sward: its share of its mix, height and width (m), colour at the foot and tip (linear), how far it
// droops at rest and how stiff it stands; the shares bearing a head (its colour and length along the blade), dry and
// in flower; its shape (MEADOW_SHAPE), how far a lying piece curls or a broad leaf cups, how much its height varies
// from plant to plant, and how far up its stalk a broad leaf begins (a share of its height).
export const MEADOW_SHAPE = Object.freeze({ BLADE: 0, LEAF: 1, OVAL: 2, LOBED: 3, PALMATE: 4, LANCE: 5, NEEDLE: 6, TWIG: 7, STRAP: 8 });
export const meadowSpecies = (share, height, width, foot, tip, droop, stiffness, { head = 0, headColour = [0.13, 0.12, 0.06], headLength = 0.2, dry = 0, flower = 0, shape = MEADOW_SHAPE.BLADE, curl = 0, vary = 0.28, stalk = 0.3 } = {}) =>
  Object.freeze({ share, height, width, foot, tip, droop, stiffness, head, headColour, headLength, dry, flower, shape, curl, vary, stalk });

// The crops a furlong may stand in (r's low four bits); each is mix MEADOW_GROUND_MIX + its code.
export const MEADOW_GROUND = Object.freeze({ NONE: 0, WHEAT: 1, BARLEY: 2, RYE: 3, FALLOW: 4, OLIVES: 5, VINES: 6, GARDEN: 7, MAIZE: 8 });
export const MEADOW_GROUND_MIX = 2;
export const MEADOW_GROUND_CROPS = 8;
// The litters (r's high four bits), by the species of tree (js/forest-scenery.js prototypes); each is mix
// MEADOW_LITTER_MIX + its slot.
export const MEADOW_LITTER = Object.freeze({ oak: 0, chestnut: 1, maple: 2, elm: 3, birch: 4, blueberry: 5, palm: 6, royal_palm: 6, ceiba: 7, mangrove: 8, pine: 9, olive: 10, broadleaf: 11, fir: 12, larch: 13 });
export const MEADOW_LITTER_MIX = MEADOW_GROUND_MIX + MEADOW_GROUND_CROPS + 1;
export const MEADOW_LITTERS = 14;
// The metres a step of the ground map's distance inside a furlong.
export const MEADOW_GROUND_EDGE_STEP = 0.05;

const meadowLerp = (a, b, t) => a + (b - a) * t;
const meadowLerp3 = (a, b, t) => [meadowLerp(a[0], b[0], t), meadowLerp(a[1], b[1], t), meadowLerp(a[2], b[2], t)];
const meadowRamp = (a, b, x) => Math.max(0, Math.min(1, (x - a) / (b - a)));
const meadowSmooth = (a, b, x) => { const t = meadowRamp(a, b, x); return t * t * (3 - 2 * t); };
// Days from 'from' to 'day' round the year (0 to 364).
const meadowSince = (day, from) => (((day - from) % 365) + 365) % 365;
// A mix's species, their shares made whole.
const meadowWhole = (species) => {
  const kept = species.filter((s) => s.share > 1e-4), total = kept.reduce((n, s) => n + s.share, 0) || 1;
  return kept.map((s) => ({ ...s, share: s.share / total }));
};

// The winter corns of a temperate coast: sown in early November, reaped from June, the stubble ploughed in October.
// Their height and colour green and ripe (foot, tip), the colour of their heads green and ripe, and the day after
// sowing they are reaped.
const MEADOW_CORNS = Object.freeze({
  [MEADOW_GROUND.WHEAT]: { height: 1.15, width: 0.0095, droop: 0.10, ripeDroop: 0.12, stiffness: 15, reap: 238,
    green: [[0.030, 0.083, 0.020], [0.058, 0.142, 0.032]], ripe: [[0.16, 0.12, 0.045], [0.40, 0.29, 0.095]],
    headGreen: [0.07, 0.15, 0.04], headRipe: [0.43, 0.31, 0.11], headLength: 0.13 },
  [MEADOW_GROUND.BARLEY]: { height: 0.85, width: 0.0105, droop: 0.12, ripeDroop: 0.40, stiffness: 11, reap: 218,
    green: [[0.034, 0.088, 0.026], [0.066, 0.150, 0.040]], ripe: [[0.19, 0.15, 0.07], [0.45, 0.37, 0.17]],
    headGreen: [0.08, 0.16, 0.05], headRipe: [0.49, 0.40, 0.19], headLength: 0.22 },
  [MEADOW_GROUND.RYE]: { height: 1.45, width: 0.0072, droop: 0.14, ripeDroop: 0.22, stiffness: 12, reap: 244,
    green: [[0.032, 0.080, 0.030], [0.062, 0.132, 0.048]], ripe: [[0.15, 0.12, 0.06], [0.33, 0.27, 0.13]],
    headGreen: [0.07, 0.13, 0.06], headRipe: [0.31, 0.25, 0.12], headLength: 0.12 },
});
const MEADOW_SOWN = 305;
const MEADOW_STRAW_FRESH = [[0.17, 0.14, 0.06], [0.34, 0.27, 0.11]], MEADOW_STRAW_GREY = [[0.09, 0.08, 0.06], [0.19, 0.17, 0.12]];
const MEADOW_WEED = [[0.026, 0.078, 0.016], [0.050, 0.150, 0.026]], MEADOW_WEED_DRY = [[0.10, 0.085, 0.04], [0.22, 0.18, 0.085]];
const MEADOW_POPPY = [0.36, 0.03, 0.02];

// A corn on a day: its stalks green, heading, ripening and reaped, then its stubble greying as the weeds come, then
// the ploughed ground. Broadcast on ridges a strip wide, the furrows between bare.
function meadowCornMix(kind, day) {
  const c = MEADOW_CORNS[kind], a = meadowSince(day, MEADOW_SOWN);
  // Broadcast, in ploughed strips with a bare furrow between.
  const rows = [0, 1, 14, 0.35];
  if (a < 12 || a >= 352) {
    // Ploughed and harrowed: a few weeds on the clods.
    return { density: 0.012, rows, species: [meadowSpecies(1, 0.07, 0.004, ...MEADOW_WEED, 0.5, 6)] };
  }
  if (a < c.reap) {
    const grow = a < 120 ? meadowLerp(0.05, 0.26, meadowRamp(12, 120, a)) : meadowLerp(0.26, 1, meadowSmooth(120, 172, a));
    const ripe = meadowSmooth(188, c.reap - 14, a), heads = meadowSmooth(158, 176, a), flowering = meadowSmooth(170, 182, a) * (1 - meadowSmooth(205, 220, a));
    const [foot, tip] = [meadowLerp3(c.green[0], c.ripe[0], ripe), meadowLerp3(c.green[1], c.ripe[1], ripe)];
    return {
      density: meadowLerp(0.55, 0.92, meadowRamp(12, 70, a)), rows,
      species: meadowWhole([
        meadowSpecies(0.88, c.height * grow, c.width * meadowLerp(0.6, 1, grow), foot, tip, meadowLerp(c.droop, c.ripeDroop, ripe), c.stiffness,
          { head: 0.92 * heads, headColour: meadowLerp3(c.headGreen, c.headRipe, ripe), headLength: c.headLength, dry: 0.02 + 0.04 * ripe, vary: 0.08 }),
        // Poppies and corn-marigold among it, flowering as it heads.
        meadowSpecies(0.07, 0.62 * c.height * grow, 0.004, meadowLerp3(MEADOW_WEED[0], MEADOW_WEED_DRY[0], ripe), meadowLerp3(MEADOW_WEED[1], MEADOW_WEED_DRY[1], ripe),
          0.2, 9, { head: 0.6 * flowering, headColour: MEADOW_POPPY, headLength: 0.1, vary: 0.3 }),
        meadowSpecies(0.05, 0.28 * Math.max(grow, 0.4), 0.007, ...MEADOW_WEED, 0.5, 6, { vary: 0.35 }),
      ]),
    };
  }
  // Reaped: the stubble, a hand high, fresh gold greying through the autumn as the weeds come up in it.
  const after = meadowRamp(c.reap, 352, a), [foot, tip] = [meadowLerp3(MEADOW_STRAW_FRESH[0], MEADOW_STRAW_GREY[0], after), meadowLerp3(MEADOW_STRAW_FRESH[1], MEADOW_STRAW_GREY[1], after)];
  return {
    density: meadowLerp(0.5, 0.38, after), rows,
    species: meadowWhole([
      meadowSpecies(meadowLerp(0.92, 0.6, after), 0.2 * (c.height / 1.15), 0.0045, foot, tip, 0.06, 18, { vary: 0.12 }),
      meadowSpecies(meadowLerp(0.05, 0.3, after), 0.12, 0.006, ...MEADOW_WEED, 0.5, 6, { vary: 0.35 }),
      meadowSpecies(meadowLerp(0.03, 0.1, after), 0.32, 0.004, ...MEADOW_WEED_DRY, 0.3, 9, { head: 0.4, headColour: [0.16, 0.12, 0.07], vary: 0.3 }),
    ]),
  };
}

// The fallow, its year of rest: weeds grazed green in winter and spring, ploughed through the late spring, dry and
// thin through the summer, greening again with the first rains.
function meadowFallowMix(day) {
  const green = Math.max(1 - meadowSmooth(85, 100, day), meadowSmooth(300, 320, day)), ploughed = meadowSmooth(92, 105, day) * (1 - meadowSmooth(160, 175, day));
  const dryness = meadowSmooth(150, 180, day) * (1 - meadowSmooth(290, 315, day));
  const [foot, tip] = [meadowLerp3(MEADOW_WEED[0], MEADOW_WEED_DRY[0], dryness), meadowLerp3(MEADOW_WEED[1], MEADOW_WEED_DRY[1], dryness)];
  return {
    density: meadowLerp(meadowLerp(0.32, 0.72, green), 0.012, ploughed),
    species: meadowWhole([
      meadowSpecies(0.55, meadowLerp(0.14, 0.28, green) * (1 - 0.6 * ploughed), 0.004, foot, tip, 0.5, 7, { head: 0.15, headColour: [0.15, 0.12, 0.07], dry: 0.05 }),
      meadowSpecies(0.30, 0.12, 0.010, foot, tip, 0.6, 5, { flower: 0.08 * green }),
      // Thistle and dock, standing taller and dry.
      meadowSpecies(0.15, 0.5 * (1 - 0.7 * ploughed), 0.008, ...MEADOW_WEED_DRY, 0.2, 12, { head: 0.5, headColour: [0.18, 0.10, 0.14], headLength: 0.12, vary: 0.4 }),
    ]),
  };
}

// The ground under the olives of a close: grazed short, green from the first rains to May, straw through the summer.
function meadowOliveFloorMix(day) {
  const dryness = meadowSmooth(140, 170, day) * (1 - meadowSmooth(290, 320, day));
  const [foot, tip] = [meadowLerp3([0.030, 0.080, 0.018], MEADOW_WEED_DRY[0], dryness), meadowLerp3([0.056, 0.140, 0.030], MEADOW_WEED_DRY[1], dryness)];
  return {
    density: 0.68,
    species: meadowWhole([
      meadowSpecies(0.62, 0.16, 0.003, foot, tip, 0.55, 7, { head: 0.12, headColour: [0.16, 0.13, 0.08], dry: 0.06 }),
      meadowSpecies(0.25, 0.08, 0.011, foot, tip, 0.65, 5, { flower: 0.06 * (1 - dryness) }),
      meadowSpecies(0.13, 0.45, 0.008, ...MEADOW_WEED_DRY, 0.2, 12, { head: 0.5, headColour: [0.18, 0.10, 0.14], headLength: 0.12, vary: 0.4 }),
    ]),
  };
}

// A vineyard's head-trained vines in their rows: bare canes through the winter, leafing in April, a bush of leaves on
// their shoots through the summer, the grapes black by September, turning in the autumn; the ground between the rows
// hoed bare.
function meadowVineMix(day) {
  const leaf = meadowSmooth(95, 135, day) * (1 - meadowSmooth(318, 340, day)), turn = meadowSmooth(280, 315, day);
  const species = [
    meadowSpecies(meadowLerp(1, 0.25, leaf), 0.45, 0.018, [0.040, 0.028, 0.018], [0.075, 0.052, 0.030], 0.2, 18, { vary: 0.3 }),
  ];
  if (leaf > 0.01) {
    species.push(meadowSpecies(0.75 * leaf, 0.72 * meadowLerp(0.5, 1, leaf), 0.13 * meadowLerp(0.5, 1, leaf), meadowLerp3([0.035, 0.095, 0.022], [0.18, 0.07, 0.03], turn),
      meadowLerp3([0.065, 0.165, 0.038], [0.36, 0.16, 0.04], turn), 0.45, 8, { shape: MEADOW_SHAPE.LEAF, curl: 0.3, vary: 0.5, stalk: 0.72, head: 0.12 * meadowSmooth(220, 250, day) * (1 - meadowSmooth(270, 285, day)), headColour: [0.05, 0.025, 0.05], headLength: 0.12 }));
  }
  return { density: meadowLerp(0.22, 1, leaf), rows: [1.8, 0.45, 0, 0], plants: [1.2, 0.55], species: meadowWhole(species) };
}

// A garden's beds of kale, onions and greens, the paths between them bare.
function meadowGardenMix(day) {
  const summer = meadowSmooth(120, 160, day) * (1 - meadowSmooth(260, 300, day));
  return {
    density: 0.82, rows: [1.6, 0.72, 0, 0],
    species: meadowWhole([
      meadowSpecies(0.45, meadowLerp(0.55, 0.42, summer), 0.16, [0.035, 0.075, 0.050], [0.072, 0.135, 0.092], 0.4, 9, { shape: MEADOW_SHAPE.LEAF, curl: 0.45, vary: 0.35, stalk: 0.15 }),
      meadowSpecies(0.30, 0.42, 0.009, [0.050, 0.090, 0.060], [0.090, 0.150, 0.100], 0.15, 12, { vary: 0.15, head: 0.25 * summer, headColour: [0.30, 0.28, 0.24], headLength: 0.08 }),
      meadowSpecies(0.25, 0.18, 0.10, [0.050, 0.120, 0.030], [0.100, 0.220, 0.050], 0.6, 6, { shape: MEADOW_SHAPE.LEAF, curl: 0.5, vary: 0.25, stalk: 0.1 }),
    ]),
  };
}

// The maize of a hot coast: sown with the rains, tasselled at midsummer, reaped as it dries; then its stalks.
function meadowMaizeMix(day) {
  const a = meadowSince(day, 110);
  if (a >= 200) {
    const after = meadowRamp(200, 364, a);
    return { density: meadowLerp(0.3, 0.12, after), rows: [0.9, 0.5, 0, 0], plants: [0.4, 0.55], species: meadowWhole([
      meadowSpecies(0.7, 0.9, 0.02, ...MEADOW_STRAW_FRESH, 0.25, 14, { vary: 0.3 }),
      meadowSpecies(0.3 + 0.4 * after, 0.35, 0.008, ...MEADOW_WEED, 0.45, 7, { vary: 0.35 }),
    ]) };
  }
  const grow = meadowSmooth(5, 85, a), ripe = meadowSmooth(130, 190, a), heads = meadowSmooth(70, 85, a);
  return { density: meadowLerp(0.4, 0.62, grow), rows: [0.9, 0.5, 0, 0], plants: [0.4, 0.55], species: meadowWhole([
    meadowSpecies(0.9, 2.2 * Math.max(grow, 0.05), 0.07 * meadowLerp(0.4, 1, grow), meadowLerp3([0.035, 0.095, 0.025], [0.18, 0.15, 0.07], ripe), meadowLerp3([0.065, 0.17, 0.04], [0.36, 0.30, 0.13], ripe),
      0.45, 10, { head: 0.35 * heads, headColour: meadowLerp3([0.30, 0.26, 0.10], [0.32, 0.24, 0.10], ripe), headLength: 0.1, vary: 0.1 }),
    meadowSpecies(0.1, 0.4, 0.008, ...MEADOW_WEED, 0.45, 7, { vary: 0.35 }),
  ]) };
}

// The crops of each MEADOW_GROUND code on a day of the year (0 to 364, the northern year's).
// Each is a mix: its density, its species, its rows (how far apart, the share of a row planted, a ploughed strip's
// width and the bare furrow between strips), its plants along a row (how far apart, the share of that planted) and
// what grows between its rows (a code, or none: bare).
export function meadowCropMixes(day) {
  const d = ((Math.round(day) % 365) + 365) % 365;
  const mixes = [];
  for (let code = 1; code <= MEADOW_GROUND_CROPS; code++) {
    const mix = code <= MEADOW_GROUND.RYE ? meadowCornMix(code, d) : code === MEADOW_GROUND.FALLOW ? meadowFallowMix(d) : code === MEADOW_GROUND.OLIVES ? meadowOliveFloorMix(d)
      : code === MEADOW_GROUND.VINES ? meadowVineMix(d) : code === MEADOW_GROUND.GARDEN ? meadowGardenMix(d) : meadowMaizeMix(d);
    mixes.push({ rows: [0, 1, 0, 0], plants: [0, 1], between: -1, ...mix });
  }
  return mixes;
}

// What each kind of tree drops: its leaf (length and width in metres, shape, fresh and old colours at the stalk and
// the tip, how far it curls as it dries), whether it sheds all at once in the autumn, how thickly it lies and the
// twigs among it.
const MEADOW_TWIG = [[0.050, 0.038, 0.026], [0.085, 0.064, 0.042]];
const MEADOW_LITTER_KINDS = Object.freeze([
  { leaf: [0.10, 0.062, MEADOW_SHAPE.LOBED], fresh: [[0.13, 0.075, 0.030], [0.20, 0.12, 0.045]], old: [[0.065, 0.045, 0.028], [0.10, 0.07, 0.04]], curl: 0.55, deciduous: true },
  { leaf: [0.18, 0.050, MEADOW_SHAPE.LANCE], fresh: [[0.18, 0.11, 0.035], [0.27, 0.17, 0.05]], old: [[0.07, 0.048, 0.028], [0.11, 0.075, 0.042]], curl: 0.45, deciduous: true },
  { leaf: [0.10, 0.110, MEADOW_SHAPE.PALMATE], fresh: [[0.21, 0.075, 0.025], [0.31, 0.10, 0.03]], old: [[0.075, 0.045, 0.028], [0.11, 0.065, 0.04]], curl: 0.5, deciduous: true },
  { leaf: [0.09, 0.050, MEADOW_SHAPE.OVAL], fresh: [[0.20, 0.14, 0.04], [0.29, 0.21, 0.06]], old: [[0.07, 0.05, 0.03], [0.11, 0.08, 0.045]], curl: 0.4, deciduous: true },
  { leaf: [0.05, 0.036, MEADOW_SHAPE.OVAL], fresh: [[0.24, 0.17, 0.04], [0.35, 0.26, 0.06]], old: [[0.08, 0.06, 0.035], [0.12, 0.09, 0.05]], curl: 0.35, deciduous: true },
  { leaf: [0.025, 0.014, MEADOW_SHAPE.OVAL], fresh: [[0.16, 0.04, 0.03], [0.22, 0.06, 0.04]], old: [[0.07, 0.04, 0.03], [0.10, 0.06, 0.04]], curl: 0.3, deciduous: true, thin: 0.5 },
  { leaf: [0.60, 0.032, MEADOW_SHAPE.STRAP], fresh: [[0.14, 0.11, 0.06], [0.21, 0.17, 0.09]], old: [[0.08, 0.065, 0.045], [0.12, 0.10, 0.065]], curl: 0.15, deciduous: false, thin: 0.75 },
  { leaf: [0.12, 0.035, MEADOW_SHAPE.LANCE], fresh: [[0.12, 0.08, 0.035], [0.17, 0.11, 0.05]], old: [[0.06, 0.045, 0.03], [0.09, 0.065, 0.04]], curl: 0.4, deciduous: true },
  { leaf: [0.10, 0.045, MEADOW_SHAPE.OVAL], fresh: [[0.16, 0.12, 0.04], [0.24, 0.19, 0.06]], old: [[0.07, 0.055, 0.03], [0.10, 0.08, 0.045]], curl: 0.25, deciduous: false },
  { leaf: [0.15, 0.0016, MEADOW_SHAPE.NEEDLE], fresh: [[0.16, 0.075, 0.03], [0.22, 0.105, 0.04]], old: [[0.08, 0.055, 0.035], [0.11, 0.075, 0.045]], curl: 0.1, deciduous: false },
  { leaf: [0.06, 0.012, MEADOW_SHAPE.LANCE], fresh: [[0.08, 0.08, 0.05], [0.11, 0.11, 0.07]], old: [[0.06, 0.05, 0.035], [0.09, 0.075, 0.05]], curl: 0.3, deciduous: false, thin: 0.7 },
  { leaf: [0.09, 0.050, MEADOW_SHAPE.OVAL], fresh: [[0.16, 0.10, 0.04], [0.24, 0.15, 0.055]], old: [[0.07, 0.05, 0.03], [0.10, 0.07, 0.04]], curl: 0.45, deciduous: true },
  // Balsam fir: flat needles two centimetres long, kept eight years or so and shed the year round, rust-brown
  // when they fall and dark as they rot, a deep mat with its twigs.
  { leaf: [0.022, 0.0019, MEADOW_SHAPE.NEEDLE], fresh: [[0.15, 0.065, 0.025], [0.21, 0.095, 0.035]], old: [[0.06, 0.04, 0.025], [0.085, 0.055, 0.032]], curl: 0.08, deciduous: false },
  // Tamarack: soft needles in tufts, two and a half centimetres, gold in October and all down by November, then
  // tawny through the winter.
  { leaf: [0.026, 0.0009, MEADOW_SHAPE.NEEDLE], fresh: [[0.36, 0.22, 0.045], [0.48, 0.31, 0.06]], old: [[0.11, 0.065, 0.032], [0.15, 0.09, 0.042]], curl: 0.12, deciduous: true },
]);
if (MEADOW_LITTER_KINDS.length !== MEADOW_LITTERS) throw Error('A litter for every slot');

// Each kind of tree's litter on a day of the year: a deciduous tree's fresh in the autumn, rotting through the winter
// and thin by the summer; an evergreen's the same all year.
export function meadowLitterMixes(day) {
  const d = ((Math.round(day) % 365) + 365) % 365;
  // How much of a deciduous litter is this year's fall: falling from October, rotting from January to July.
  const fall = d >= 278 ? meadowSmooth(278, 330, d) : 1 - meadowSmooth(10, 200, d);
  return MEADOW_LITTER_KINDS.map((k) => {
    const fresh = k.deciduous ? meadowLerp(0.12, 0.78, fall) : 0.5;
    const [length, width, shape] = k.leaf;
    return {
      density: (k.thin ?? 1) * (k.deciduous ? meadowLerp(0.62, 1, fall) : 0.92),
      species: meadowWhole([
        meadowSpecies(0.86 * fresh, length, width, ...k.fresh, 0, 1, { shape, curl: k.curl, vary: 0.3 }),
        meadowSpecies(0.86 * (1 - fresh), length * 0.85, width * 0.8, ...k.old, 0, 1, { shape, curl: k.curl * 0.6, vary: 0.35 }),
        meadowSpecies(0.14, shape === MEADOW_SHAPE.STRAP ? 0.9 : 0.24, shape === MEADOW_SHAPE.STRAP ? 0.012 : 0.0065, ...MEADOW_TWIG, 0, 1, { shape: MEADOW_SHAPE.TWIG, curl: 0.08, vary: 0.5 }),
      ]),
    };
  });
}

// The day of the year (0 to 364) whose growth a date sees at a latitude: south of the line the seasons turn half a
// year apart, so its day is moved by half a year.
export function meadowGrowthDay(dateMs, latitude = 40) {
  if (!Number.isFinite(dateMs)) return null;
  const date = new Date(dateMs), year = date.getUTCFullYear();
  const day = Math.floor((dateMs - Date.UTC(year, 0, 1)) / 86400000);
  return ((day + (latitude < 0 ? 182 : 0)) % 365 + 365) % 365;
}

const meadowHashUnit = (n) => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
// The crop a furlong stands in: its corn wheat, barley or rye as its number falls (maize on a hot coast), and its
// olive close, vineyard or garden a garden where olives and vines do not grow.
function meadowGroundCodeOf(use, id, tropical) {
  if (use.wild) return MEADOW_GROUND.NONE;
  switch (use.kind) {
    case OLD_WORLD_LAND.CORN: {
      if (tropical) return MEADOW_GROUND.MAIZE;
      const u = meadowHashUnit(id + 1);
      return u < 0.55 ? MEADOW_GROUND.WHEAT : u < 0.85 ? MEADOW_GROUND.BARLEY : MEADOW_GROUND.RYE;
    }
    case OLD_WORLD_LAND.FALLOW: return MEADOW_GROUND.FALLOW;
    case OLD_WORLD_LAND.OLIVES: return tropical ? MEADOW_GROUND.GARDEN : MEADOW_GROUND.OLIVES;
    case OLD_WORLD_LAND.VINES: return tropical ? MEADOW_GROUND.GARDEN : MEADOW_GROUND.VINES;
    case OLD_WORLD_LAND.GARDEN: return MEADOW_GROUND.GARDEN;
    default: return MEADOW_GROUND.NONE;
  }
}

const meadowInsideFigure = (fig, x, z) => {
  let inside = false;
  for (let k = 0, m = fig.length / 2, l = m - 1; k < m; l = k++) {
    const ax = fig[2 * l], az = fig[2 * l + 1], bx = fig[2 * k], bz = fig[2 * k + 1];
    if ((bz > z) !== (az > z) && x < ax + (bx - ax) * (z - az) / (bz - az)) inside = !inside;
  }
  return inside;
};
// The ground map's furlongs: every texel inside a worked furlong its crop, how far inside it lies and the way its
// strips run, from the furlong's own figure. Where the board's index has cleared a furlong's wooded corner, nothing is
// sown there. Set out once a board and region; the litter is laid over a copy (layMeadowLitter).
export function bakeMeadowGroundFields({ region, board, size, tropical = false }) {
  const map = new Uint8Array(size * size * 4);
  if (!region || !board?.figures || !board?.uses) return map;
  const span = region.span, x0 = region.x - span * 0.5, z0 = region.z - span * 0.5, step = span / size, inv = size / span;
  const bSize = board.size, bIndex = board.index, bSpan = board.span ?? span;
  const bx0 = (board.origin?.x ?? region.x) - bSpan * 0.5, bz0 = (board.origin?.z ?? region.z) - bSpan * 0.5, bCell = bSpan / bSize;
  const steps = 255 * MEADOW_GROUND_EDGE_STEP;
  board.uses.forEach((use, id) => {
    const code = meadowGroundCodeOf(use, id, tropical), fig = board.figures[id];
    if (!code || !fig || fig.length < 6) return;
    const m = fig.length / 2;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < m; k++) {
      const x = fig[2 * k], z = fig[2 * k + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const i0 = Math.max(0, Math.floor((minX - x0) * inv)), i1 = Math.min(size - 1, Math.floor((maxX - x0) * inv));
    const j0 = Math.max(0, Math.floor((minZ - z0) * inv)), j1 = Math.min(size - 1, Math.floor((maxZ - z0) * inv));
    if (i0 > i1 || j0 > j1) return;
    const lie = ((((use.heading || 0) % Math.PI) + Math.PI) % Math.PI) / Math.PI;
    const lieByte = Math.min(255, Math.round(lie * 255));
    for (let j = j0; j <= j1; j++) {
      const wz = z0 + (j + 0.5) * step;
      const cj = Math.floor((wz - bz0) / bCell);
      for (let i = i0; i <= i1; i++) {
        const wx = x0 + (i + 0.5) * step;
        const ci = Math.floor((wx - bx0) / bCell);
        // A cell of the index whose middle lies in the furlong and that holds none was cleared for its wood.
        if (bIndex && ci >= 0 && cj >= 0 && ci < bSize && cj < bSize && bIndex[cj * bSize + ci] === 0
          && meadowInsideFigure(fig, bx0 + (ci + 0.5) * bCell, bz0 + (cj + 0.5) * bCell)) continue;
        let inside = false, best = Infinity;
        for (let k = 0, l = m - 1; k < m; l = k++) {
          const ax = fig[2 * l], az = fig[2 * l + 1], bx = fig[2 * k], bz = fig[2 * k + 1];
          if ((bz > wz) !== (az > wz) && wx < ax + (bx - ax) * (wz - az) / (bz - az)) inside = !inside;
          const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz;
          const t = len > 1e-9 ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / len)) : 0;
          const ex = wx - ax - dx * t, ez = wz - az - dz * t, d2 = ex * ex + ez * ez;
          if (d2 < best) best = d2;
        }
        if (!inside) continue;
        const o = (j * size + i) * 4;
        map[o] = code;
        map[o + 1] = Math.min(255, Math.round(Math.min(Math.sqrt(best), steps) / MEADOW_GROUND_EDGE_STEP));
        map[o + 2] = lieByte;
      }
    }
  });
  return map;
}

// A tree's litter: as wide as its crown and a little more, thickest under it; a shrub's and a palm's thinner.
function meadowLitterOf(proto) {
  const slot = MEADOW_LITTER[proto?.species] ?? MEADOW_LITTER.broadleaf;
  const crown = proto?.crownRadius ?? proto?.crownRadiusMetres ?? 6;
  const weight = proto?.species === 'blueberry' ? 0.55 : slot === MEADOW_LITTER.palm ? 0.8 : 1;
  return { slot, crown, weight };
}

// Which of the forest's trees stand on a region, as a signature: when it is unchanged the litter is too.
export function meadowTreesSignature(region, trees) {
  if (!region || !trees?.sections) return '';
  const half = region.span * 0.5 + 20;
  let count = 0, sum = 0;
  for (const section of trees.sections) for (const part of section.parts ?? []) {
    for (let k = 0; k + 11 < part.length; k += 12) {
      const x = part[k], z = part[k + 2];
      if (Math.abs(x - region.x) > half || Math.abs(z - region.z) > half || part[k + 1] < -100) continue;
      count++; sum += x * 0.37 + z * 0.61 + part[k + 3];
    }
  }
  return `${count}:${sum.toFixed(2)}`;
}

// The litter under every tree standing on the region, laid into a ground map's high bits of r (whose litter) and a
// (how thick): where crowns overlap, the thickest.
export function layMeadowLitter(map, { region, size, trees }) {
  if (!region || !trees?.sections || !trees?.prototypes) return 0;
  const span = region.span, x0 = region.x - span * 0.5, z0 = region.z - span * 0.5, step = span / size, inv = size / span;
  const kinds = trees.prototypes.map(meadowLitterOf);
  let laid = 0;
  for (const section of trees.sections) for (const part of section.parts ?? []) {
    for (let k = 0; k + 11 < part.length; k += 12) {
      const x = part[k], y = part[k + 1], z = part[k + 2], scale = part[k + 3], kind = kinds[part[k + 8] | 0];
      if (!kind || !(scale > 0) || y < -100) continue;
      const reach = Math.max(1.2, Math.min(16, kind.crown * scale * 0.9)) * 1.12;
      // The amount is read smoothly and the kind at the nearest texel, so the texels a step beyond the litter take
      // its kind where none lies: where the amount fades out, the kind is still the litter's.
      const outer = reach + 1.5 * step;
      const i0 = Math.max(0, Math.floor((x - outer - x0) * inv)), i1 = Math.min(size - 1, Math.floor((x + outer - x0) * inv));
      const j0 = Math.max(0, Math.floor((z - outer - z0) * inv)), j1 = Math.min(size - 1, Math.floor((z + outer - z0) * inv));
      if (i0 > i1 || j0 > j1) continue;
      const inv2 = 1 / (reach * reach), rim = (outer * outer) * inv2, slotBits = kind.slot << 4;
      for (let j = j0; j <= j1; j++) {
        const dz = z0 + (j + 0.5) * step - z, dz2 = dz * dz * inv2;
        if (dz2 >= rim) continue;
        for (let i = i0; i <= i1; i++) {
          const dx = x0 + (i + 0.5) * step - x, d2 = dx * dx * inv2 + dz2;
          if (d2 >= rim) continue;
          const o = (j * size + i) * 4;
          if (d2 >= 1) {
            if (map[o + 3] === 0) map[o] = (map[o] & 15) | slotBits;
            continue;
          }
          const f = 1 - d2, b = Math.round(f * Math.sqrt(f) * kind.weight * 255);
          if (b > map[o + 3]) {
            if (map[o + 3] === 0) laid++;
            map[o + 3] = b;
            map[o] = (map[o] & 15) | slotBits;
          }
        }
      }
    }
  }
  return laid;
}
