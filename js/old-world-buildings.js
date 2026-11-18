// The building types of an Old World city, written in Cairn, the game's declarative JSON
// building language (js/cairn-primitives.js): walls with their openings, arches, roofs, boxes.
// Each type is compiled once into a mesh, baked into the city's continuum (scripts/prepare-city-continuum.mjs) and
// drawn wherever the city's plan stands a building of that type, at the size it is written: nothing is stretched to
// its plot (AGENTS.md rule 1). A building the plan stands at many sizes is a family of types, one to each size it is
// built at in whole bays of a fixed real width (a house's windows, a church's nave bays, a wall's merlons, a hall's
// buttresses); doors, steps and storeys are one size in all. The plan stands the one nearest its plot (cityVariant).
//
// A type's local frame is the plan's: x along the street, z away from it, the street front at -z, the floor at y = 0.
import { CITY_WORKS, CITY_WORKS_BUILT, WORKS_BAY_M, WORKS_HOUSE_DEPTHS } from './old-world-works.js';
import { NATIVE_WORKS_TARGETS } from './native-works.js';

export const CITY_STOREY_M = 2.9;
// A house's front is so many bays of this width, a window or the door to each.
export const CITY_BAY_M = WORKS_BAY_M;
const FOOTING_M = 6.5; // Walls run this far below the floor, so a house on a slope has no gap under it.
// A length in whole bays, rid of the float's dust (5 bays of 2.2 m is 11 m, not 11.000000000000002).
const cityMetres = (v) => Math.round(v * 1000) / 1000;
const WALL_M = 0.42;

// A church is as long as its nave's bays, a tall window to each side of each, and its front and apse walls; a parish
// church is of one of two breadths, a chapel's or a parish's; the great church of one.
export const CITY_CHURCH = Object.freeze({
  bay: 5, ends: 2, towerRise: 9.5, spire: 3.4, // A bell tower's walls stand towerRise above the nave's.
  parish: Object.freeze([Object.freeze({ width: 8, height: 9, tower: 4.2 }), Object.freeze({ width: 11, height: 11, tower: 5 })]), parishBays: Object.freeze([3, 4, 5, 6]),
  great: Object.freeze({ width: 15, height: 15, tower: 6.4 }), greatBays: Object.freeze([4, 5, 6, 7, 8]),
});
// A tower of the wall is so many stages high, each this tall, on one of three sides; a keep is broader and higher.
export const CITY_TOWER = Object.freeze({ stage: 3.1, sides: Object.freeze([5.6, 6.6, 7.6]), stages: Object.freeze([3, 4, 5]) });
export const CITY_KEEP = Object.freeze({ sides: Object.freeze([10, 12, 14]), stages: Object.freeze([6, 7]) });
// A gate: its arch `span` across and `thick` through, the passage and the chamber over it; a tower of `tower` a side
// stands to either hand, its middle `reach` from the gate's.
export const CITY_GATE = Object.freeze({ span: 8, thick: 2.6, passage: 8.6, chamber: 2.9, tower: 5.6, reach: 6.5 });
export const CITY_HOUSE_STOREYS = 5;
// How far past its plot a type may stand across its front (shared between two neighbours) and back into its yard.
export const CITY_FIT = Object.freeze({ across: 0.7, along: 1.0 });

// A town house. Its plot, its storeys and its ridge (eaves or gable to the street) are the plan's; how it is built
// is its manner, and within a manner the particulars are thrown by dice of its own, so that a type is the same
// house on every machine. The manners are those of an Iberian street of the sixteenth century:
//   plain     limewashed rubble, a door and small windows, an iron balcony on the taller houses
//   ressalto  upper floors framed in oak and plastered between the timbers, each jettied out over the one below
//             on its brackets (the "andares de ressalto" the Crown kept ordering cut back from the streets)
//   cantaria  dressed stone at the corners, the floor lines and the eaves; tall windows opening on balconies
//   loja      a shop: a wide opening with its counter and pentice beside the door, a wooden balcony above
//   arcada    the ground floor set back behind a row of stone columns, as along the Rua Nova dos Mercadores
//   baixa     a low house under a hipped roof, with a great chimney
const HOUSE_ARCADE_M = 2.3, HOUSE_FRAME_WALL_M = 0.3;
const HOUSE_WINDOWS = Object.freeze({
  small: { width: 0.9, height: 1.35, sill: 0.85 }, tall: { width: 0.95, height: 1.75, sill: 0.55 },
  sacada: { width: 1.05, height: 2.25, sill: 0.02 }, paired: { width: 0.55, height: 1.05, sill: 1.0, apart: 0.42 },
});
function cityHouseDice(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// What a house of a manner is to have, floor by floor. `jetty` is how far a floor's front stands out past the plot's.
function cityHouseRecipe({ storeys, ridge, manner, bays, dice }) {
  const middle = Math.floor(bays / 2), end = dice() < 0.5 ? 0 : bays - 1, floors = [];
  for (let s = 0; s < storeys; s++) floors.push({ timber: false, jetty: 0, window: 'small' });
  const recipe = {
    ground: 'door', doorBay: middle, floors, balcony: storeys >= 3 ? { storey: 1, kind: 'iron', bay: -1 } : null,
    dressed: false, roof: 'gable', dormer: false, eaves: 0.3, chimney: { side: 1, back: 2.5, wide: 0.7, rise: 0.9, cap: false },
  };
  if (manner === 'plain') return recipe;
  recipe.chimney = { side: dice() < 0.5 ? -1 : 1, back: 1.6 + dice() * 2.2, wide: 0.62 + dice() * 0.2, rise: 0.7 + dice() * 0.5, cap: dice() < 0.5 };
  recipe.eaves = 0.3 + dice() * 0.22;
  recipe.doorBay = dice() < 0.5 ? middle : end;
  if (manner === 'ressalto') {
    // Stone below, timber above: from the first floor up, or in a tall house from the second.
    const from = storeys >= 3 && dice() < 0.4 ? 2 : 1;
    let out = 0;
    for (let s = from; s < storeys; s++) {
      out = Math.min(1.1, out + 0.36 + dice() * 0.16);
      floors[s] = { timber: true, jetty: out, window: s === storeys - 1 && dice() < 0.5 ? 'paired' : 'small' };
    }
    if (from === 2) floors[1].window = 'tall';
    recipe.balcony = null;
  } else if (manner === 'cantaria') {
    recipe.dressed = true;
    for (let s = 1; s < storeys; s++) floors[s].window = s === 1 ? 'sacada' : s === storeys - 1 && storeys > 2 ? 'small' : 'tall';
    recipe.balcony = storeys >= 2 ? { storey: 1, kind: 'iron', bay: storeys >= 3 && dice() < 0.6 ? -1 : middle } : null;
    recipe.doorBay = middle;
    if (ridge === 'street') { if (dice() < 0.5) recipe.roof = 'hip'; else recipe.dormer = true; }
  } else if (manner === 'loja') {
    recipe.ground = 'shop'; recipe.doorBay = end;
    recipe.balcony = storeys >= 2 ? { storey: 1, kind: 'wood', bay: dice() < 0.5 ? -1 : middle } : null;
    if (recipe.balcony) floors[1].window = 'sacada';
  } else if (manner === 'arcada') {
    recipe.ground = 'arcade'; recipe.doorBay = middle;
    floors[1].window = 'sacada'; recipe.balcony = { storey: 1, kind: 'iron', bay: -1 };
    for (let s = 2; s < storeys; s++) floors[s].window = 'tall';
    // The tallest carry a timber floor or two at the top, jettied over the merchants' street.
    if (storeys >= 4) {
      let out = 0;
      for (let s = storeys - (dice() < 0.5 ? 2 : 1); s < storeys; s++) { out += 0.38 + dice() * 0.12; floors[s] = { timber: true, jetty: out, window: s === storeys - 1 ? 'paired' : 'small' }; }
    } else recipe.dressed = dice() < 0.6;
    recipe.dormer = ridge === 'street' && !floors[storeys - 1].timber && dice() < 0.5;
  } else if (manner === 'baixa') {
    recipe.roof = 'hip'; recipe.doorBay = end; recipe.eaves = 0.5;
    recipe.chimney = { side: end === 0 ? 1 : -1, back: 1.2, wide: 1.15, rise: 1.5, cap: true };
  }
  return recipe;
}

// A house `bays` bays across its front (CITY_BAY_M each) and `depth` back from it, its storeys CITY_STOREY_M each.
function houseSpec({ name, storeys, bays, depth, ridge, manner = 'plain', seed = 0 }) {
  const S = CITY_STOREY_M, bay = CITY_BAY_M, front = cityMetres(bays * bay), hw = front / 2, hd = depth / 2, height = cityMetres(storeys * S);
  const R = cityHouseRecipe({ storeys, ridge, manner, bays, dice: cityHouseDice(seed) });
  const setback = R.ground === 'arcade' ? HOUSE_ARCADE_M : 0;
  const primitives = [{ primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -FOOTING_M, -hd], to: [hw, 0, hd], material: 'stucco' }];
  const add = (part) => primitives.push(part), box = (name, from, to, material) => add({ primitive: 'box', name, from, to, material });
  // The party walls, which under an arcade begin behind it.
  for (const [side, x0, x1] of [['left', -hw, -hw + WALL_M], ['right', hw - WALL_M, hw]]) {
    if (!setback) box(`party_wall_${side}`, [x0, 0, -hd + WALL_M], [x1, height, hd - WALL_M], 'stucco');
    else {
      box(`party_wall_${side}`, [x0, 0, -hd + setback], [x1, S, hd - WALL_M], 'stucco');
      box(`party_wall_${side}_upper`, [x0, S, -hd + WALL_M], [x1, height, hd - WALL_M], 'stucco');
    }
  }
  for (let storey = 0; storey < storeys; storey++) {
    const y = storey * S, F = R.floors[storey], thick = F.timber ? HOUSE_FRAME_WALL_M : WALL_M;
    const face = -hd - F.jetty + (storey === 0 ? setback : 0), openings = [];
    const form = HOUSE_WINDOWS[F.window];
    if (storey === 0 && R.ground === 'shop') {
      // The door at one end; the rest of the front is the shop's opening, its lower shutter let down as a counter.
      const doorAt = (R.doorBay + 0.5) * bay, a = R.doorBay === 0 ? bay + 0.25 : 0.45, b = R.doorBay === 0 ? front - 0.45 : front - bay - 0.25;
      openings.push({ offset: doorAt, width: 1.0, height: 2.15, door: true }, { offset: (a + b) / 2, width: b - a, height: 1.5, sill: 0.82 });
      box('shop_counter', [-hw + a - 0.05, 0.74, face - 0.34], [-hw + b + 0.05, 0.82, face + 0.03], 'oak');
      box('shop_pentice', [-hw + a - 0.2, 2.48, face - 0.6], [-hw + b + 0.2, 2.55, face + 0.03], 'oak');
    } else for (let k = 0; k < bays; k++) {
      const offset = (k + 0.5) * bay;
      if (storey === 0) {
        if (k === R.doorBay) openings.push(setback ? { offset, width: 1.3, height: 2.3, door: true } : { offset, width: 1.15, height: 2.15, door: true });
        else openings.push(setback ? { offset, width: Math.min(1.5, bay - 0.7), height: 1.5, sill: 0.8 } : { offset, width: 0.85, height: 1.0, sill: 1.15 });
      } else if (form.apart) openings.push({ offset: offset - form.apart, width: form.width, height: form.height, sill: form.sill }, { offset: offset + form.apart, width: form.width, height: form.height, sill: form.sill });
      else openings.push({ offset, width: form.width, height: form.height, sill: form.sill });
    }
    add({ primitive: 'wall', name: `street_front_${storey}`, from: [-hw, y, face + thick / 2], to: [hw, y, face + thick / 2], height: S, thickness: thick, material: 'stucco', ...(F.timber ? { surround: 'oak' } : {}), openings });
    add({ primitive: 'wall', name: `yard_wall_${storey}`, from: [hw, y, hd - WALL_M / 2], to: [-hw, y, hd - WALL_M / 2], height: S, thickness: WALL_M, material: 'stucco', openings: [{ offset: front / 2, width: 0.85, height: 1.1, sill: 1.0 }] });
    if (F.jetty > 0) {
      const below = R.floors[storey - 1].jetty;
      if (F.jetty > below + 0.01) {
        // The floor carried out over the street on its joists' ends, a bracket under each.
        box(`jetty_floor_${storey}`, [-hw, y - 0.16, -hd - F.jetty], [hw, y, -hd - below + 0.02], 'oak');
        for (let k = 0; k <= bays; k++) {
          const x = -hw + 0.1 + (front - 0.2) * k / bays;
          box(`jetty_brackets_${storey}`, [x - 0.08, y - 0.5, -hd - F.jetty + 0.07], [x + 0.08, y - 0.16, -hd - below], 'oak');
        }
      }
      for (const [x0, x1] of [[-hw, -hw + 0.22], [hw - 0.22, hw]]) box(`jetty_cheeks_${storey}`, [x0, y, face + thick], [x1, y + S, -hd + WALL_M], 'stucco');
    }
    if (F.timber) {
      // The frame, standing a little proud of its plaster: sill and head, a post at each bay, a rail under the
      // windows, and a brace in each end bay.
      const z0 = face - 0.05, z1 = face + 0.04, frame = `timber_frame_${storey}`, railTop = y + form.sill - 0.03;
      box(frame, [-hw - 0.02, y, z0 - 0.01], [hw + 0.02, y + 0.2, z1], 'oak');
      box(frame, [-hw - 0.02, y + S - 0.16, z0 - 0.01], [hw + 0.02, y + S, z1], 'oak');
      for (let k = 0; k <= bays; k++) {
        const x = -hw + front * k / bays, half = k === 0 || k === bays ? 0.09 : 0.065;
        box(frame, [Math.max(-hw - 0.02, x - half), y + 0.2, z0], [Math.min(hw + 0.02, x + half), y + S - 0.16, z1], 'oak');
        if (k < bays) box(frame, [x + half, railTop - 0.12, z0], [x + bay - 0.065, railTop, z1], 'oak');
      }
      const reach = (form.apart ? form.apart + form.width / 2 : form.width / 2) + 0.14, wide = bay / 2 - reach - 0.09, tall = S - 0.36;
      if (wide > 0.3) for (const side of [-1, 1]) {
        const length = Math.hypot(wide, tall) - 0.12;
        add({ primitive: 'group', name: frame, position: [side * (hw - 0.09 - wide / 2), y + 0.2 + tall / 2, 0], rotation: [0, 0, side * Math.atan2(tall, wide) * 180 / Math.PI],
          children: [{ primitive: 'box', from: [-length / 2, -0.055, z0 + 0.025], to: [length / 2, 0.055, z1], material: 'oak' }] });
      }
    }
  }
  if (setback) {
    // The arcade: a column to each bay line on its base, the beam they carry, and the boarded ceiling behind it.
    for (let k = 0; k <= bays; k++) {
      const x = -hw + 0.28 + (front - 0.56) * k / bays;
      box('arcade_columns', [x - 0.22, 0, -hd + 0.06], [x + 0.22, 0.16, -hd + 0.5], 'limestone');
      add({ primitive: 'cylinder', name: 'arcade_columns', base: [x, 0.16, -hd + 0.28], height: S - 0.58, radius: 0.16, segments: 8, material: 'limestone' });
    }
    box('arcade_beam', [-hw, S - 0.42, -hd], [hw, S, -hd + 0.5], 'limestone');
    box('arcade_ceiling', [-hw, S - 0.14, -hd + 0.5], [hw, S, -hd + setback + WALL_M], 'oak');
  }
  if (R.balcony) {
    const y = R.balcony.storey * S, x0 = R.balcony.bay < 0 ? -hw + 0.5 : -hw + R.balcony.bay * bay + 0.3, x1 = R.balcony.bay < 0 ? hw - 0.5 : -hw + (R.balcony.bay + 1) * bay - 0.3, wide = x1 - x0;
    if (R.balcony.kind === 'iron') {
      // On stone corbels with an iron rail.
      box('balcony', [x0, y - 0.14, -hd - 0.6], [x1, y, -hd], 'limestone');
      box('balcony_rail', [x0, y + 0.86, -hd - 0.6], [x1, y + 0.92, -hd - 0.54], 'iron');
      for (let k = 0, posts = Math.round(wide / 0.62); k <= posts; k++) {
        const x = x0 + (wide - 0.05) * k / posts;
        box('balcony_baluster', [x, y, -hd - 0.59], [x + 0.05, y + 0.86, -hd - 0.55], 'iron');
      }
      for (const x of [x0, x1 - 0.06]) box('balcony_return', [x, y + 0.86, -hd - 0.6], [x + 0.06, y + 0.92, -hd], 'iron');
    } else {
      // A wooden balcony: boards on joists, square posts and two rails.
      box('balcony', [x0, y - 0.12, -hd - 0.75], [x1, y, -hd], 'oak');
      for (let k = 0, posts = Math.max(2, Math.round(wide / 0.95)); k <= posts; k++) {
        const x = x0 + (wide - 0.08) * k / posts;
        box('balcony_baluster', [x, y, -hd - 0.75], [x + 0.08, y + 0.95, -hd - 0.67], 'oak');
      }
      for (const [low, high] of [[0.42, 0.48], [0.9, 0.98]]) {
        box('balcony_rail', [x0, y + low, -hd - 0.74], [x1, y + high, -hd - 0.68], 'oak');
        for (const x of [x0, x1 - 0.06]) box('balcony_return', [x, y + low, -hd - 0.68], [x + 0.06, y + high, -hd], 'oak');
      }
    }
  }
  if (R.dressed) {
    for (const [x0, x1] of [[-hw - 0.03, -hw + 0.34], [hw - 0.34, hw + 0.03]]) box('quoins', [x0, setback ? S : 0, -hd - 0.05], [x1, height, -hd + 0.3], 'limestone');
    for (let s = setback ? 2 : 1; s < storeys; s++) if (!(R.balcony && R.balcony.storey === s && R.balcony.bay < 0)) box('string_course', [-hw - 0.02, s * S - 0.09, -hd - 0.07], [hw + 0.02, s * S + 0.07, -hd + 0.02], 'limestone');
    box('cornice', [-hw - 0.03, height - 0.2, -hd - 0.12], [hw + 0.03, height, -hd + 0.02], 'limestone');
  }
  // The roof covers the top floor as far out as it is jettied.
  const out = R.floors[storeys - 1].jetty, rise = ridge === 'street' ? 0.36 * depth / 2 : 0.5 * front / 2;
  const roof = { primitive: 'roof', height: rise, style: R.roof, overhang: R.eaves, material: 'roof_tile', wallMaterial: 'stucco' };
  if (ridge === 'street') {
    const half = (depth + out) / 2;
    add({ primitive: 'group', name: 'roof', ...(out ? { position: [0, 0, -out / 2] } : {}), rotation: [0, 90, 0], children: [{ ...roof, from: [-half, height, -hw], to: [half, height, hw] }] });
    if (R.dormer) {
      // A dormer in the street slope: its own little gable, a window under it.
      const z = -out / 2 - half * 0.44, y = height + rise * 0.56;
      box('dormer', [-0.65, y - 0.4, z - 0.75], [0.65, y + 0.85, z + 0.5], 'stucco');
      box('dormer_window', [-0.34, y + 0.08, z - 0.78], [0.34, y + 0.68, z - 0.74], 'recess');
      add({ ...roof, name: 'dormer_roof', from: [-0.75, y + 0.85, z - 0.85], to: [0.75, y + 0.85, z + 1.5], height: 0.42, style: 'gable', overhang: 0.08 });
    }
  } else {
    add({ ...roof, from: [-hw, height, -hd - out], to: [hw, height, hd] });
    if (R.floors[storeys - 1].timber) {
      // The gable over a timber front is framed too: a king post and a collar.
      const z0 = -hd - out - 0.05, z1 = -hd - out + 0.04;
      box('gable_frame', [-0.07, height, z0], [0.07, height + rise - 0.3, z1], 'oak');
      box('gable_frame', [-hw * 0.5, height + rise * 0.42, z0 + 0.025], [hw * 0.5, height + rise * 0.42 + 0.12, z1], 'oak');
    }
  }
  const C = R.chimney, cx = C.side > 0 ? hw - 0.8 - C.wide : -hw + 0.8, top = height + 0.36 * depth / 2 + C.rise;
  box('chimney', [cx, height + 0.2, hd - C.back - C.wide], [cx + C.wide, top, hd - C.back], 'stucco');
  if (C.cap) box('chimney', [cx - 0.08, top, hd - C.back - C.wide - 0.08], [cx + C.wide + 0.08, top + 0.1, hd - C.back + 0.08], 'limestone');
  return { schemaVersion: '0.4', name, width: front, length: depth, height, foundationDepth: FOOTING_M, materialKind: 12, roofPitch: 2, waterfront: false, manner, primitives };
}

// A parish church: a nave of `bays` bays with its portal and round window to the street, a tall window to each side of
// each bay, and a bell tower (or two) beside the front.
function churchSpec({ name, width, bays, height, tower, towers, material = 'whitewash' }) {
  const depth = cityMetres(bays * CITY_CHURCH.bay + CITY_CHURCH.ends), hw = width / 2, hd = depth / 2, th = 0.8, primitives = [
    { primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -FOOTING_M, -hd], to: [hw, 0, hd], material: 'ashlar' },
    { primitive: 'wall', name: 'west_front', from: [-hw, 0, -hd + th / 2], to: [hw, 0, -hd + th / 2], height, thickness: th, material, openings: [{ offset: width / 2, width: 1.6, height: 1.6, sill: height * 0.62 }] },
    { primitive: 'arch', name: 'portal', from: [-1.7, 0, -hd - 0.12], to: [1.7, 0, -hd - 0.12], height: 4.6, thickness: 0.5, voussoirs: 9, material: 'limestone' },
    { primitive: 'box', name: 'apse_wall', from: [-hw, 0, hd - th], to: [hw, height, hd], material },
  ];
  for (const side of [-1, 1]) {
    const openings = [];
    for (let k = 0; k < bays; k++) openings.push({ offset: CITY_CHURCH.ends / 2 + (k + 0.5) * CITY_CHURCH.bay, width: 0.9, height: height * 0.36, sill: height * 0.42 });
    primitives.push({ primitive: 'wall', name: side < 0 ? 'north_wall' : 'south_wall', from: [side * (hw - th / 2), 0, side < 0 ? hd : -hd], to: [side * (hw - th / 2), 0, side < 0 ? -hd : hd], height, thickness: th, material, openings });
  }
  primitives.push({ primitive: 'roof', from: [-hw, height, -hd], to: [hw, height, hd], height: 0.42 * hw + 0.6, style: 'gable', overhang: 0.35, material: 'roof_tile', wallMaterial: material });
  for (const side of towers) {
    const x = side * (hw + tower / 2 - 0.3), z = -hd + tower / 2, top = height + CITY_CHURCH.towerRise, ht = tower / 2;
    primitives.push({ primitive: 'group', name: side < 0 ? 'bell_tower_left' : 'bell_tower_right', position: [x, 0, z], children: [
      { primitive: 'box', from: [-ht, -FOOTING_M, -ht], to: [ht, top - 3.4, ht], material: 'ashlar' },
      { primitive: 'box', from: [-ht - 0.08, top - 3.5, -ht - 0.08], to: [ht + 0.08, top - 3.2, ht + 0.08], material: 'limestone' },
      ...[[-ht, -ht, ht, -ht], [ht, -ht, ht, ht], [ht, ht, -ht, ht], [-ht, ht, -ht, -ht]].map(([ax, az, bx, bz]) => (
        { primitive: 'wall', from: [ax, top - 3.2, az], to: [bx, top - 3.2, bz], height: 3.2, thickness: 0.5, material: 'ashlar', openings: [{ offset: tower / 2, width: tower * 0.36, height: 2.1, sill: 0.5 }] })),
      { primitive: 'pyramid', from: [-ht, top, -ht], to: [ht, top, ht], height: CITY_CHURCH.spire, material: 'roof_tile' },
    ] });
  }
  return { schemaVersion: '0.4', name, width, length: depth, height, foundationDepth: FOOTING_M, materialKind: 12, roofPitch: 3, waterfront: false, primitives };
}

// A square tower of the wall or the castle: an ashlar shaft with a slit to each face of each stage above the first, a
// wall-walk and merlons.
function towerSpec({ name, side, stages }) {
  const h = side / 2, height = cityMetres(stages * CITY_TOWER.stage), primitives = [
    { primitive: 'box', partGroup: 'foundation_plinth', from: [-h, -FOOTING_M, -h], to: [h, 0, h], material: 'dark_stone' },
    { primitive: 'box', name: 'shaft', from: [-h, 0, -h], to: [h, height - 1.2, h], topInset: 0.1, material: 'ashlar' },
    { primitive: 'box', name: 'wall_walk', from: [-h - 0.15, height - 1.2, -h - 0.15], to: [h + 0.15, height - 0.9, h + 0.15], material: 'limestone' },
  ];
  for (const [ax, az, bx, bz] of [[-h, -h, h, -h], [h, -h, h, h], [h, h, -h, h], [-h, h, -h, -h]]) {
    primitives.push({ primitive: 'wall', from: [ax, height - 0.9, az], to: [bx, height - 0.9, bz], height: 0.9, thickness: 0.5, material: 'ashlar', crenellated: true, merlonWidth: 1.05, merlonGap: 0.75, merlonHeight: 0.85 });
  }
  for (let k = 1; k + 1 < stages; k++) {
    const y = k * CITY_TOWER.stage + 0.8;
    for (const [x, z, w, d] of [[0, -h - 0.02, 0.2, 0.04], [0, h + 0.02, 0.2, 0.04], [-h - 0.02, 0, 0.04, 0.2], [h + 0.02, 0, 0.04, 0.2]]) {
      primitives.push({ primitive: 'box', name: 'arrow_slit', from: [x - w, y, z - d], to: [x + w, y + 1.5, z + d], material: 'recess' });
    }
  }
  return { schemaVersion: '0.4', name, width: side, length: side, height, foundationDepth: FOOTING_M, materialKind: 11, roofPitch: 0, waterfront: false, primitives };
}

// A section of the town's wall or the castle's: a thick ashlar curtain `bays` bays long, its wall-walk behind a parapet
// of a merlon and an embrasure to each bay. The parapet stands along the type's -x side; the plan turns that outward.
// It is built to one of five heights: a weir's, a low wall's, a colony's, a town's and a castle's.
export const CITY_CURTAIN = Object.freeze({ thick: 2.4, bay: 2.6, bays: Object.freeze([1, 2, 3, 4, 5]), heights: Object.freeze([3, 5.5, 7, 8.5, 10]), height: 8.5, parapet: 0.8, merlon: 1.3, rise: 1.15 });
function curtainSpec({ bays, height }) {
  const length = cityMetres(bays * CITY_CURTAIN.bay), t = CITY_CURTAIN.thick / 2, h = length / 2, sill = 0.3;
  return {
    schemaVersion: '0.4', name: `Pano de muralha (a length of wall, ${bays} bay${bays > 1 ? 's' : ''}, ${height} m high)`, width: CITY_CURTAIN.thick, length, height, foundationDepth: FOOTING_M, materialKind: 11, roofPitch: 0, waterfront: false,
    primitives: [
      { primitive: 'box', partGroup: 'foundation_plinth', from: [-t, -FOOTING_M, -h], to: [t, 0, h], material: 'dark_stone' },
      { primitive: 'box', name: 'curtain', from: [-t, 0, -h], to: [t, height, h], material: 'ashlar' },
      { primitive: 'wall', name: 'curtain_parapet', from: [-t + CITY_CURTAIN.parapet / 2, height, -h], to: [-t + CITY_CURTAIN.parapet / 2, height, h], height: sill, thickness: CITY_CURTAIN.parapet, material: 'ashlar', crenellated: true, merlonWidth: CITY_CURTAIN.merlon, merlonGap: CITY_CURTAIN.merlon, merlonHeight: CITY_CURTAIN.rise - sill },
    ],
  };
}

// An angled bastion of the Italian trace, standing out from the wall: two faces meeting at a right-angled salient and
// two flanks back to the curtain, filled with earth to its terreplein behind a parapet of an embrasure to each bay. Its
// faces are whole bays of the curtain's own; it is built to the curtain's heights. Its back (+x) stands on the wall's
// line, its salient (-x) outward; it is as broad as it stands out, `bays * bay / sqrt 2` to either side of its middle.
// The model's own trace (assets/board/game.js, its wall drawing) stands one every 88 m, none within 26 m of a run's
// end, each some 28 m across its gorge and standing 28 m out: the bastion of eight bays to a face, asked for by `half`.
export const CITY_BASTION = Object.freeze({ faces: Object.freeze([6, 8, 10]), heights: Object.freeze([5.5, 7, 8.5, 10]), every: 88, clear: 26, half: 15 });
function bastionSpec({ bays, height }) {
  const W = cityMetres(bays * CITY_CURTAIN.bay / Math.SQRT2), a = W / Math.SQRT2, p = CITY_CURTAIN.parapet, q = p / 2 / Math.SQRT2, sill = 0.3;
  const parapet = { primitive: 'wall', height: sill, thickness: p, material: 'ashlar', crenellated: true, merlonWidth: CITY_CURTAIN.bay - CITY_CURTAIN.merlon, merlonGap: CITY_CURTAIN.merlon, merlonHeight: CITY_CURTAIN.rise - sill };
  return {
    schemaVersion: '0.4', name: `Baluarte (an angled bastion, faces of ${bays} bays, ${height} m high)`, width: 2 * W, length: 2 * W, height, foundationDepth: FOOTING_M, materialKind: 11, roofPitch: 0, waterfront: false,
    primitives: [
      { primitive: 'box', partGroup: 'foundation_plinth', from: [0, -FOOTING_M, -W], to: [W, 0, W], material: 'dark_stone' },
      { primitive: 'box', name: 'bastion_flanks', from: [0, 0, -W], to: [W, height, W], material: 'ashlar' },
      { primitive: 'group', name: 'bastion_head', position: [0, 0, 0], rotation: [0, 45, 0], children: [
        { primitive: 'box', partGroup: 'foundation_plinth', from: [-a, -FOOTING_M, -a], to: [a, 0, a], material: 'dark_stone' },
        { primitive: 'box', name: 'bastion_faces', from: [-a, 0, -a], to: [a, height, a], material: 'ashlar' },
      ] },
      { ...parapet, name: 'bastion_flank_parapet', from: [W, height, -W + p / 2], to: [0, height, -W + p / 2] },
      { ...parapet, name: 'bastion_face_parapet', from: [q, height, -W + q], to: [-W + q, height, q] },
      { ...parapet, name: 'bastion_face_parapet', from: [-W + q, height, -q], to: [q, height, W - q] },
      { ...parapet, name: 'bastion_flank_parapet', from: [0, height, W - p / 2], to: [W, height, W - p / 2] },
    ],
  };
}

// The castle's hall: two tall storeys of limewashed wall under a hipped roof, its door in the long front; as long as
// its bays, a window to each of each storey, and of a narrower or a broader range.
export const CITY_HALL = Object.freeze({ bay: 4.2, widths: Object.freeze([10, 12]), bays: Object.freeze([4, 5, 6, 7]), height: 10.5, roof: 3.2 });
function hallSpec({ width, bays }) {
  const { height, roof } = CITY_HALL, depth = cityMetres(bays * CITY_HALL.bay), hw = width / 2, hd = depth / 2, th = 0.7, storey = height / 2;
  const primitives = [{ primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -FOOTING_M, -hd], to: [hw, 0, hd], material: 'ashlar' }];
  const sides = [[-hw, -hd + th / 2, hw, -hd + th / 2], [hw - th / 2, -hd, hw - th / 2, hd], [hw, hd - th / 2, -hw, hd - th / 2], [-hw + th / 2, hd, -hw + th / 2, -hd]];
  for (let level = 0; level < 2; level++) {
    sides.forEach(([ax, az, bx, bz], side) => {
      const run = Math.hypot(bx - ax, bz - az), n = side & 1 ? bays : Math.max(2, Math.round(width / CITY_HALL.bay)), openings = [];
      for (let bay = 0; bay < n; bay++) {
        const offset = (bay + 0.5) * run / n;
        openings.push(level === 0 && side === 1 && bay === Math.floor(n / 2) ? { offset, width: 1.8, height: 3.1, door: true } : { offset, width: 1, height: storey * 0.42, sill: storey * 0.3 });
      }
      primitives.push({ primitive: 'wall', name: `hall_wall_${level}_${side}`, from: [ax, level * storey, az], to: [bx, level * storey, bz], height: storey, thickness: th, material: 'stucco', openings });
    });
  }
  primitives.push({ primitive: 'roof', from: [-hw, height, -hd], to: [hw, height, hd], height: roof, style: 'hip', overhang: 0.4, material: 'roof_tile', wallMaterial: 'stucco' });
  return { schemaVersion: '0.4', name: `Paço (castle hall, ${bays} bays, ${width} m across)`, width, length: depth, height, foundationDepth: FOOTING_M, materialKind: 12, roofPitch: 3, waterfront: false, primitives };
}

// What stands and hangs in a street, as Castle and Commons' own towns have it: a pentice over a shop's open front,
// a sign board on its bracket, the ale-stake's bush, and on the market place a cross and stalls; on a green, a well.
// Each is a type like any building: drawn, lit, struck and broken with the rest. A front's things are written from
// where they are fixed to the wall (y = 0, the wall at z = 0) and hang out over the street (-z); what is 'stucco'
// in them is painted cloth or board, and takes its colour from the instance's tint (js/wgsl/terrain.js). The builder
// lays a plinth of its own under any type that names none: each names what it stands on or is fixed by.
const cityFurnitureSpec = (name, width, length, height, primitives) => ({ schemaVersion: '0.4', name, width, length, height, foundationDepth: 0, materialKind: 10, roofPitch: 0, waterfront: false, primitives });
// A pentice spans its front's bays but for a little at each end, a bracket at each bay line.
export const CITY_PENTICE = Object.freeze({ bays: Object.freeze([2, 3, 4, 5, 6]), inset: 0.6 });
const CITY_PENTICES = CITY_PENTICE.bays.map((bays) => {
  const w = cityMetres(bays * CITY_BAY_M - CITY_PENTICE.inset), h = w / 2;
  return cityFurnitureSpec(`Alpendre (pentice over a shop front of ${bays} bays)`, w, 1.4, 0.4, [
    { primitive: 'box', name: 'pentice_cloth', from: [-h, 0, -1.4], to: [h, 0.1, 0], material: 'stucco' },
    { primitive: 'box', name: 'pentice_valance', from: [-h, -0.24, -1.4], to: [h, 0, -1.35], material: 'stucco' },
    ...Array.from({ length: bays + 1 }, (_, k) => Math.max(-h + 0.04, Math.min(h - 0.14, -h - CITY_PENTICE.inset / 2 + k * CITY_BAY_M - 0.05))).map((x, k) => (
      { primitive: 'box', name: k === 0 ? 'pentice_bracket_left' : 'pentice_bracket', ...(k === 0 ? { partGroup: 'foundation_plinth' } : {}), from: [x, -0.12, -1.38], to: [x + 0.1, 0, 0], material: 'oak' })),
  ]);
});
const CITY_STREET_FURNITURE = [
  ['SIGN', cityFurnitureSpec('Tabuleta (sign board on its bracket)', 0.2, 1.7, 1, [
    { primitive: 'box', name: 'sign_bracket', partGroup: 'foundation_plinth', from: [-0.07, 0, -1.6], to: [0.07, 0.14, 0], material: 'oak' },
    { primitive: 'box', name: 'sign_hanger_inner', from: [-0.02, -0.14, -0.88], to: [0.02, 0, -0.84], material: 'iron' },
    { primitive: 'box', name: 'sign_hanger_outer', from: [-0.02, -0.14, -1.56], to: [0.02, 0, -1.52], material: 'iron' },
    { primitive: 'box', name: 'sign_board', from: [-0.05, -0.86, -1.65], to: [0.05, -0.14, -0.75], material: 'stucco' },
    { primitive: 'box', name: 'sign_frame', from: [-0.065, -0.9, -1.68], to: [0.065, -0.86, -0.72], material: 'oak' },
  ])],
  ['ALE_STAKE', cityFurnitureSpec('Ramo (the ale-stake and its bush)', 1.2, 2.6, 1.2, [
    { primitive: 'box', name: 'ale_stake', partGroup: 'foundation_plinth', from: [-0.06, 0, -2.1], to: [0.06, 0.12, 0], material: 'oak' },
    { primitive: 'cylinder', name: 'ale_bush', base: [0, -0.58, -2.02], height: 0.6, radius: 0.16, radiusTop: 0.34, segments: 7, material: 'stucco' },
    { primitive: 'cone', name: 'ale_bush_crown', base: [0, 0.02, -2.02], height: 0.3, radius: 0.34, radiusTop: 0.08, segments: 7, material: 'stucco' },
  ])],
  ['STALL', cityFurnitureSpec('Banca de mercado (market stall)', 2.8, 3.6, 2.5, [
    { primitive: 'box', name: 'stall_board', from: [-1.1, 0.84, -1.5], to: [1.1, 0.94, 1.5], material: 'oak' },
    { primitive: 'box', name: 'stall_chest', partGroup: 'foundation_plinth', from: [-0.95, 0, -1.3], to: [0.95, 0.84, 1.3], material: 'wood' },
    ...[[-1.3, -1.7], [1.3, -1.7], [1.3, 1.7], [-1.3, 1.7]].map(([x, z], k) => ({ primitive: 'box', name: `stall_post_${k}`, from: [x - 0.05, -0.6, z - 0.05], to: [x + 0.05, 2.3, z + 0.05], material: 'timber' })),
    { primitive: 'box', name: 'stall_cloth', from: [-1.4, 2.3, -1.8], to: [1.4, 2.38, 1.8], material: 'stucco' },
    { primitive: 'box', name: 'stall_valance', from: [-1.4, 2.08, -1.8], to: [1.4, 2.3, -1.76], material: 'stucco' },
  ])],
  ['MARKET_CROSS', cityFurnitureSpec('Cruzeiro do mercado (market cross)', 3.2, 3.2, 5.2, [
    { primitive: 'box', name: 'cross_step_low', partGroup: 'foundation_plinth', from: [-1.6, -1.2, -1.6], to: [1.6, 0.28, 1.6], material: 'ashlar' },
    { primitive: 'box', name: 'cross_step_high', from: [-1.05, 0.28, -1.05], to: [1.05, 0.58, 1.05], material: 'ashlar' },
    { primitive: 'box', name: 'cross_plinth', from: [-0.5, 0.58, -0.5], to: [0.5, 1.3, 0.5], material: 'limestone' },
    { primitive: 'cylinder', name: 'cross_shaft', base: [0, 1.3, 0], height: 3, radius: 0.22, radiusTop: 0.17, segments: 8, material: 'limestone' },
    { primitive: 'box', name: 'cross_head', from: [-0.1, 4.3, -0.09], to: [0.1, 5.2, 0.09], material: 'limestone' },
    { primitive: 'box', name: 'cross_arms', from: [-0.42, 4.66, -0.09], to: [0.42, 4.84, 0.09], material: 'limestone' },
  ])],
  ['WELL', cityFurnitureSpec('Poço (well under its roof)', 4.2, 4.2, 4.6, [
    { primitive: 'cylinder', name: 'well_ring', partGroup: 'foundation_plinth', base: [0, -1.4, 0], height: 2.3, radius: 1.5, segments: 12, material: 'ashlar' },
    { primitive: 'cylinder', name: 'well_mouth', base: [0, 0.72, 0], height: 0.2, radius: 1.12, segments: 12, material: 'recess' },
    { primitive: 'box', name: 'well_post_left', from: [-1.38, 0.9, -0.08], to: [-1.22, 3, 0.08], material: 'oak' },
    { primitive: 'box', name: 'well_post_right', from: [1.22, 0.9, -0.08], to: [1.38, 3, 0.08], material: 'oak' },
    { primitive: 'box', name: 'well_windlass', from: [-1.3, 2.12, -0.07], to: [1.3, 2.26, 0.07], material: 'oak' },
    { primitive: 'cone', name: 'well_roof', base: [0, 3, 0], height: 1.6, radius: 2.1, radiusTop: 0.08, segments: 8, material: 'timber' },
  ])],
];

/* ---- the catalogue: every family of types, in the order their numbers are used by the plan and the renderer ---- */
// A family is one building at each of its sizes: `from` its first type, `count` of them, `canonical` the one its name
// stands for (the size the plan asks for when it has no plot to fit).
const cityFamilies = [], cityTypes = [];
const cityFamily = (key, specs, canonical = 0) => {
  const list = Array.isArray(specs) ? specs : [specs];
  const family = Object.freeze({ key, from: cityTypes.length, count: list.length, canonical: cityTypes.length + canonical });
  cityFamilies.push(family); cityTypes.push(...list);
  return family.canonical;
};

// The houses: by their ridge, their storeys and their manner; each at every front and depth it is built to. The
// plain house is first of each storeys and ridge, then the manners a house of that height may be built in besides,
// with how often each is met with (the plain house counts three).
const HOUSES = [
  ['Casa térrea', 'single-storey house'], ['Sobrado', 'two-storey house'], ['Casa de três andares', 'three-storey house'],
  ['Casa de quatro andares', 'four-storey house'], ['Casa alta', 'five-storey house'],
];
// The bays of its front and its depths, by storeys: a low house may be broad, a tall one is a merchant's narrow front;
// the depths are a single room, a room and a half and a double pile (WORKS_HOUSE_DEPTHS, as its ruin is).
const HOUSE_SIZES = [
  { bays: [2, 3, 4, 5, 6], depths: WORKS_HOUSE_DEPTHS.slice(0, 2) },
  { bays: [2, 3, 4, 5, 6], depths: WORKS_HOUSE_DEPTHS },
  { bays: [2, 3, 4, 5], depths: WORKS_HOUSE_DEPTHS },
  { bays: [2, 3, 4], depths: WORKS_HOUSE_DEPTHS.slice(1) },
  { bays: [2, 3, 4], depths: WORKS_HOUSE_DEPTHS.slice(1) },
];
// A gable is turned to the street by a narrow front only.
const HOUSE_GABLE_BAYS = 4;
export const CITY_HOUSE_DEPTHS = WORKS_HOUSE_DEPTHS;
const HOUSE_MANNERS = [['loja', 'baixa'], ['ressalto', 'loja', 'cantaria'], ['ressalto', 'cantaria', 'arcada'], ['ressalto', 'arcada'], ['arcada']];
const HOUSE_MANNER = Object.freeze({
  plain: { share: 3, words: ['', ''] },
  ressalto: { share: 3, words: [' de ressalto', 'timber-framed floors jettied over the street, '] },
  cantaria: { share: 1.5, words: [' de cantaria', 'dressed stone, tall windows on balconies, '] },
  loja: { share: 1.5, words: [' com loja', 'a shop below, '] },
  arcada: { share: 2.5, words: [' de arcada', 'the ground floor behind an arcade of columns, '] },
  baixa: { share: 2, words: [' de quatro águas', 'a hipped roof and a great chimney, '] },
});
const HOUSE_RIDGES = [['street', '', 'eaves to the street'], ['depth', ' de empena', 'gable to the street']];
// By ridge and storeys, the families a house may be: [canonical type, share] with the plain one first.
const HOUSE_CHOICES = HOUSE_RIDGES.map(([ridge, suffix, lie], r) => HOUSES.map(([name, gloss], k) => ['plain', ...HOUSE_MANNERS[k]].map((manner, m) => {
  const { share, words } = HOUSE_MANNER[manner], size = HOUSE_SIZES[k], bays = size.bays.filter((n) => ridge === 'street' || n <= HOUSE_GABLE_BAYS);
  const specs = bays.flatMap((n) => size.depths.map((depth) => houseSpec({
    name: `${name}${words[0]}${suffix} (${gloss}, ${words[1]}${lie}; ${n} bays, ${depth} m deep)`, storeys: k + 1, bays: n, depth, ridge, manner,
    seed: manner === 'plain' ? 0 : 0x5eed0000 + r * 4099 + k * 257 + (m - 1) * 31,
  })));
  // The size the name stands for: three bays, the middle depth.
  return [cityFamily('HOUSE', specs, bays.indexOf(3) * size.depths.length + Math.floor(size.depths.length / 2)), share];
})));
export const CITY_HOUSE_TYPES = cityTypes.length;
const CITY_TYPE_NAMED = {
  HOUSE_EAVES: HOUSE_CHOICES[0][0][0][0], HOUSE_GABLE: HOUSE_CHOICES[1][0][0][0],
  CHURCH_LEFT: cityFamily('CHURCH_LEFT', CITY_CHURCH.parish.flatMap((P) => CITY_CHURCH.parishBays.map((bays) => churchSpec({ name: `Igreja paroquial (parish church, tower to the left; ${bays} bays, ${P.width} m across)`, ...P, bays, towers: [-1] }))), 6),
  CHURCH_RIGHT: cityFamily('CHURCH_RIGHT', CITY_CHURCH.parish.flatMap((P) => CITY_CHURCH.parishBays.map((bays) => churchSpec({ name: `Igreja paroquial (parish church, tower to the right; ${bays} bays, ${P.width} m across)`, ...P, bays, towers: [1] }))), 6),
  CHURCH_GREAT: cityFamily('CHURCH_GREAT', CITY_CHURCH.greatBays.map((bays) => churchSpec({ name: `Sé (great church, two towers; ${bays} bays)`, ...CITY_CHURCH.great, bays, towers: [-1, 1], material: 'limestone' })), 3),
  WALL_TOWER: cityFamily('WALL_TOWER', CITY_TOWER.sides.flatMap((side) => CITY_TOWER.stages.map((stages) => towerSpec({ name: `Torre da cerca (wall tower, ${side} m a side, ${stages} stages)`, side, stages }))), 4),
  KEEP: cityFamily('KEEP', CITY_KEEP.sides.flatMap((side) => CITY_KEEP.stages.map((stages) => towerSpec({ name: `Torre de menagem (keep, ${side} m a side, ${stages} stages)`, side, stages }))), 3),
  GATE: cityFamily('GATE', (() => {
    const h = CITY_GATE.span / 2, t = CITY_GATE.thick / 2, top = CITY_GATE.passage + CITY_GATE.chamber - 0.9;
    const parapet = { primitive: 'wall', height: 0.9, thickness: 0.5, material: 'ashlar', crenellated: true, merlonWidth: 1.05, merlonGap: 0.75, merlonHeight: 0.85 };
    return {
      schemaVersion: '0.4', name: 'Porta da cidade (city gate)', width: CITY_GATE.span, length: CITY_GATE.thick, height: CITY_GATE.passage + CITY_GATE.chamber, foundationDepth: FOOTING_M, materialKind: 11, roofPitch: 0, waterfront: false,
      primitives: [
        { primitive: 'box', partGroup: 'foundation_plinth', from: [-h, -FOOTING_M, -t], to: [-h + 1.1, 0, t], material: 'dark_stone' },
        { primitive: 'box', name: 'pier_footing', from: [h - 1.1, -FOOTING_M, -t], to: [h, 0, t], material: 'dark_stone' },
        { primitive: 'arch', name: 'gate_arch', from: [-h, 0, 0], to: [h, 0, 0], height: CITY_GATE.passage, thickness: CITY_GATE.thick, voussoirs: 11, pierWidth: 1.1, openThrough: true, material: 'ashlar' },
        { primitive: 'box', name: 'gate_chamber', from: [-h, CITY_GATE.passage, -t], to: [h, top, t], material: 'ashlar' },
        { ...parapet, name: 'gate_parapet', from: [-h, top, -t + 0.25], to: [h, top, -t + 0.25] },
        { ...parapet, name: 'gate_parapet_inner', from: [h, top, t - 0.25], to: [-h, top, t - 0.25] },
      ],
    };
  })()),
  CURTAIN: cityFamily('CURTAIN', CITY_CURTAIN.heights.flatMap((height) => CITY_CURTAIN.bays.map((bays) => curtainSpec({ bays, height }))), CITY_CURTAIN.heights.indexOf(CITY_CURTAIN.height) * CITY_CURTAIN.bays.length + 3),
  BASTION: cityFamily('BASTION', CITY_BASTION.heights.flatMap((height) => CITY_BASTION.faces.map((bays) => bastionSpec({ bays, height }))), CITY_BASTION.heights.indexOf(CITY_CURTAIN.height) * CITY_BASTION.faces.length + 1),
  HALL: cityFamily('HALL', CITY_HALL.widths.flatMap((width) => CITY_HALL.bays.map((bays) => hallSpec({ width, bays }))), CITY_HALL.bays.length + 3),
  PENTICE: cityFamily('PENTICE', CITY_PENTICES, 1),
  ...Object.fromEntries(CITY_STREET_FURNITURE.map(([key, spec]) => [key, cityFamily(key, spec)])),
};
// Whatever else Castle and Commons' model builds (js/old-world-works.js), each family by its name there: WINDMILL to
// RUBBLE, then the native houses BARK_LONGHOUSE to SWEAT_LODGE, stand on footings; FENCE_RAIL and after (to PALISADE)
// are the slighter things.
CITY_WORKS.forEach(([key, specs, canonical = 0], k) => {
  if (k === CITY_WORKS_BUILT) CITY_TYPE_NAMED.SLIGHT_FROM = cityTypes.length;
  CITY_TYPE_NAMED[key] = cityFamily(key, specs, canonical);
});
// The first of the slighter works: from here on a type is written as large as it is, and asked for no footing.
export const CITY_TYPE_SLIGHT_FROM = CITY_TYPE_NAMED.SLIGHT_FROM;
delete CITY_TYPE_NAMED.SLIGHT_FROM;
export const CITY_BUILDING_TYPES = Object.freeze(cityTypes);
export const CITY_FAMILIES = Object.freeze(cityFamilies);
// Each type's family (an index into CITY_FAMILIES).
const CITY_TYPE_FAMILY = new Uint16Array(cityTypes.length);
cityFamilies.forEach((family, f) => CITY_TYPE_FAMILY.fill(f, family.from, family.from + family.count));
// The type a family's name stands for (its canonical size); a house's by cityHouseType.
export const CITY_TYPE = Object.freeze(CITY_TYPE_NAMED);
export const cityFamilyOf = (type) => CITY_FAMILIES[CITY_TYPE_FAMILY[type]];
const cityFamilyTypes = (...keys) => keys.flatMap((key) => {
  const family = cityFamilyOf(CITY_TYPE[key]);
  return Array.from({ length: family.count }, (_, k) => family.from + k);
});

/**
 * The type of `type`'s family that best fits a plot `across` its front and `along` back from it, and `up` high (any
 * may be null, not to be asked): as broad as it can be without standing more than CITY_FIT.across past the plot's
 * front, and as deep within CITY_FIT.along of its back; failing that, the least past it. Never stretched: a plot is
 * filled by choosing among sizes, not by changing one.
 */
export function cityVariant(type, across = null, along = null, up = null) {
  const family = cityFamilyOf(type);
  if (family.count === 1 || (across === null && along === null && up === null)) return type;
  let best = family.canonical, least = Infinity;
  for (let id = family.from; id < family.from + family.count; id++) {
    const T = cityTypes[id];
    let cost = 0;
    if (across !== null) { const over = T.width - across; cost += Math.abs(over) + (over > CITY_FIT.across + 1e-6 ? 1000 + over : 0); }
    if (along !== null) { const over = T.length - along; cost += 0.4 * Math.abs(over) + (over > CITY_FIT.along + 1e-6 ? 1000 + over : 0); }
    if (up !== null) cost += Math.abs(T.height - up);
    if (cost < least - 1e-9) { least = cost; best = id; }
  }
  return best;
}

// What hangs over a street from a front: whoever walks there passes under it.
export const CITY_TYPES_OVERHEAD = Object.freeze(new Set(cityFamilyTypes('PENTICE', 'SIGN', 'ALE_STAKE')));
// Bridges are destructible gunnery targets whose intact spans let walkers and caravans cross rivers cleanly.
export const CITY_TYPES_BRIDGES = Object.freeze(new Set(cityFamilyTypes('FOOTBRIDGE', 'STONE_BRIDGE', 'STONE_BRIDGE_SPAN')));
// What stands in or over the water, never on the ground the land draws.
export const CITY_TYPES_WATERSIDE = Object.freeze(new Set([...cityFamilyTypes('WHARF', 'WATERMILL'), ...CITY_TYPES_BRIDGES]));
// What is too slight to be laid as a gun's target or to stop anyone walking: what hangs overhead, a fence,
// graves, a cairn, a standard.
export const CITY_TYPES_SLIGHT = Object.freeze(new Set([...CITY_TYPES_OVERHEAD, ...cityFamilyTypes('FENCE_RAIL', 'FENCE_POST', 'FENCE_STONE', 'GRAVES', 'CAIRN', 'STANDARD')]));
// Of those, what is stone standing on the ground in its own right, and shatters when struck.
export const CITY_TYPES_STONE_SLIGHT = Object.freeze(new Set(cityFamilyTypes('CAIRN', 'FENCE_STONE', 'GRAVES')));
// The paints a front's cloth and boards take, as tints of the land shader's limewash: after its five washes.
export const CITY_PAINT = Object.freeze({ LINEN: 1, RED: 5, BLUE: 6, GOLD: 7, GREEN: 8, BROWN: 9, DARK: 10 });
// What a type is to the guns: the name its damage is kept under and reported by. The wall, its
// towers and bastions, the keep and the gate are fortified stone (js/gunnery-control.js); the rest is masonry.
const CITY_TARGETS = Object.freeze({
  HOUSE: { prefabId: 'city_house', label: 'Town house' }, CHURCH_LEFT: { prefabId: 'city_church', label: 'Parish church' }, CHURCH_RIGHT: { prefabId: 'city_church', label: 'Parish church' },
  CHURCH_GREAT: { prefabId: 'city_church', label: 'Cathedral' }, WALL_TOWER: { prefabId: 'city_wall_tower', label: 'Wall tower' }, KEEP: { prefabId: 'city_keep', label: 'Castle keep' },
  GATE: { prefabId: 'city_gate', label: 'City gate' }, CURTAIN: { prefabId: 'city_wall', label: 'City wall' }, BASTION: { prefabId: 'city_bastion', label: 'Bastion' }, HALL: { prefabId: 'city_castle_hall', label: 'Castle hall' },
  PENTICE: { prefabId: 'city_shop_front', label: 'Shop front' }, SIGN: { prefabId: 'city_shop_front', label: 'Shop front' }, ALE_STAKE: { prefabId: 'city_shop_front', label: 'Shop front' },
  STALL: { prefabId: 'city_market_stall', label: 'Market stall' }, MARKET_CROSS: { prefabId: 'city_market_cross', label: 'Market cross' }, WELL: { prefabId: 'city_well', label: 'Well' },
  WINDMILL: { prefabId: 'city_windmill', label: 'Windmill' }, WATERMILL: { prefabId: 'city_watermill', label: 'Watermill' }, GRANARY: { prefabId: 'city_granary', label: 'Granary' },
  SHED: { prefabId: 'city_outbuilding', label: 'Outbuilding' }, BARN: { prefabId: 'city_barn', label: 'Barn' }, DOVECOTE: { prefabId: 'city_dovecote', label: 'Dovecote' },
  TOLL: { prefabId: 'city_toll_house', label: 'Toll house' }, COT: { prefabId: 'city_hovel', label: 'Hovel' }, THATCH_HOUSE: { prefabId: 'city_hovel', label: 'Thatched house' }, THATCH_LONGHOUSE: { prefabId: 'city_hovel', label: 'Thatched longhouse' }, WINEPRESS: { prefabId: 'city_winepress', label: 'Winepress' },
  VATS: { prefabId: 'city_works', label: 'Tannery or dye works' }, STONE_HALL: { prefabId: 'city_stone_hall', label: 'Stone hall' }, CLOISTER: { prefabId: 'city_cloister', label: 'Cloister' },
  COURT: { prefabId: 'city_courtyard_house', label: 'Courtyard house' }, WHARF: { prefabId: 'city_wharf', label: 'Wharf' }, QUARRY: { prefabId: 'city_quarry', label: 'Quarry' },
  RUIN: { prefabId: 'city_ruin', label: 'Ruin' }, RUBBLE: { prefabId: 'city_rubble', label: 'Rubble' }, FENCE_RAIL: { prefabId: 'city_fence', label: 'Fence' }, FENCE_POST: { prefabId: 'city_fence', label: 'Fence' }, FENCE_STONE: { prefabId: 'city_fence', label: 'Dry-stone wall' },
  FOOTBRIDGE: { prefabId: 'city_timber_bridge', label: 'Timber bridge' }, STONE_BRIDGE: { prefabId: 'city_stone_bridge', label: 'Stone bridge' }, STONE_BRIDGE_SPAN: { prefabId: 'city_stone_bridge', label: 'Stone bridge' }, GRAVES: { prefabId: 'city_graves', label: 'Graves' },
  CAIRN: { prefabId: 'city_cairn', label: 'Cairn' }, TENT: { prefabId: 'city_tent', label: 'Tent' }, STANDARD: { prefabId: 'city_standard', label: 'Standard' }, SCAFFOLD: { prefabId: 'city_scaffold', label: 'Scaffold' },
  ...NATIVE_WORKS_TARGETS,
});
for (const family of cityFamilies) if (!CITY_TARGETS[family.key]) throw Error(`The city's ${family.key} is no target the guns know`);
export function cityTypeTarget(type) { return CITY_TARGETS[cityFamilyOf(type).key]; }
// Five numbers to an instance of a type: x, floor height, z, turn; tone. It stands at its type's own size.
export const CITY_TYPED_FLOATS = 5;
// A plan's block that a type replaces near the camera carries its roof form plus this.
export const CITY_TYPED_ROOF = 4;
// And this besides where its roof is thatch: far off, its block is roofed in straw and not in tile.
export const CITY_THATCH_ROOF = 8;

// The family of a house of so many storeys, and its ridge (its canonical type; cityVariant fits it to a plot). `pick`
// (0 to 1, the house's own throw) chooses its manner among those a house of that height is built in; none asked, it
// is the plain house.
export function cityHouseType(storeys, eavesToStreet, pick = 0) {
  const choices = HOUSE_CHOICES[eavesToStreet ? 0 : 1][Math.max(1, Math.min(CITY_HOUSE_STOREYS, storeys)) - 1];
  let all = 0;
  for (const [, share] of choices) all += share;
  let at = Math.max(0, Math.min(0.999999, pick)) * all;
  for (const [type, share] of choices) { if (at < share) return type; at -= share; }
  return choices[0][0];
}
// A house's own throw, from where it stands: the same house is the same type however the town is made again.
export function cityHousePick(x, z) {
  let h = Math.imul(Math.round(x * 3) ^ 0x51ed270b, 0x85ebca6b) ^ Math.imul(Math.round(z * 3) + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Compile every type with the port's own Cairn builder, each standing at the origin unturned,
// into a plain list of vertices (position, normal, kind) the renderer can instance. Every
// triangle is wound to face the way its normals point, so the renderer may leave out the faces
// turned away: the insides of walls, footings and party walls, half of all there is to shade.
// A roof is a sheet, seen from under its eaves too, so its tiles are given both faces. The
// triangles are then put in order from the outside in, so that whatever the camera sees is
// drawn first and the walls behind it fail the depth test before they are shaded.
// Each type also keeps its `source`, the builder's own mesh and part catalogue with its bounds,
// which js/city-targets.js stands in the world when shot comes near a building.
// One type alone, as the bake and a struck building need it.
export function compileCityBuildingType(id, buildGeometry) {
  const spec = CITY_BUILDING_TYPES[id];
  const built = buildGeometry({
    singleBuildingPrefab: true,
    instances: [{ prefabId: `city_type_${id}`, id: `city_type_${id}`, x: 0, y: 0, z: 0, yaw: 0, width: spec.width, length: spec.length, depth: spec.length, height: spec.height, foundationDepth: spec.foundationDepth, materialKind: spec.materialKind, roofPitch: spec.roofPitch, cairnSpec: spec }],
  }, null);
  return { id, name: spec.name, width: spec.width, length: spec.length, height: spec.height, ...compileContinuumBody(built, spec) };
}
export function compileCityBuildingTypes(buildGeometry) {
  return CITY_BUILDING_TYPES.map((_, id) => compileCityBuildingType(id, buildGeometry));
}

// One building as its builder made it (buildPortPrefabGeometry, a single instance at the origin, unturned), as the
// continuum bakes and draws it (js/continuum-bake.js): every drawn corner in triangles, outermost first, a roof sheet
// drawn from both sides, a timber's grain riding its shade, and each triangle's part; with `source`, what the builder
// made, for shot and fracture. `box` is the plot it was built on ({ width, length, height }).
export function compileContinuumBody(built, box) {
  const spec = box;
  {
    const from = built.vertices, faces = [];
    let out = null;
    // A timber's grain runs its length. Which way that is (1 upright, 2 across the plot, 3 along it; 0 where it has
    // none to speak of) is the long axis of the part it belongs to, and rides in twos on the vertex's shade, where
    // the renderer takes it off again (cityContinuumWorn): a post is then not shaded as a stack of plank ends.
    const assembly = built.partAssembly, grains = new Map();
    const grainOf = (triangle) => {
      const number = assembly?.trianglePartIds?.[triangle];
      if (number === undefined) return 0;
      if (!grains.has(number)) {
        const bounds = (assembly.partsById?.get?.(number) ?? assembly.parts?.find((part) => part.partNumber === number))?.bounds;
        const size = bounds ? [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] : [0, 0, 0];
        const long = size.indexOf(Math.max(...size)), next = Math.max(...size.filter((_, axis) => axis !== long));
        grains.set(number, size[long] > next * 1.3 ? [2, 1, 3][long] : 0);
      }
      return grains.get(number);
    };
    let grain = 0;
    const corner = (index, flip) => { const o = index * 8; out.push(from[o], from[o + 1], from[o + 2], flip * from[o + 3], flip * from[o + 4], flip * from[o + 5], from[o + 6], Math.floor(from[o + 6] + 0.01) === 10 ? Math.min(0.99, Math.max(0, from[o + 7])) + 2 * grain : from[o + 7]); };
    // How far out a point lies: 1 on the plot's own walls and roof, more beyond them, less within.
    const outward = (a, b, c) => {
      const x = (from[a * 8] + from[b * 8] + from[c * 8]) / 3, y = (from[a * 8 + 1] + from[b * 8 + 1] + from[c * 8 + 1]) / 3, z = (from[a * 8 + 2] + from[b * 8 + 2] + from[c * 8 + 2]) / 3;
      return Math.max(Math.abs(x) / (spec.width / 2), Math.abs(z) / (spec.length / 2), Math.abs(y - spec.height / 2) / (spec.height / 2));
    };
    for (let k = 0; k + 2 < built.indices.length; k += 3) {
      let a = built.indices[k], b = built.indices[k + 1], c = built.indices[k + 2];
      const ux = from[b * 8] - from[a * 8], uy = from[b * 8 + 1] - from[a * 8 + 1], uz = from[b * 8 + 2] - from[a * 8 + 2];
      const vx = from[c * 8] - from[a * 8], vy = from[c * 8 + 1] - from[a * 8 + 1], vz = from[c * 8 + 2] - from[a * 8 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-12) continue; // A sliver with no face.
      const facing = nx * (from[a * 8 + 3] + from[b * 8 + 3] + from[c * 8 + 3]) + ny * (from[a * 8 + 4] + from[b * 8 + 4] + from[c * 8 + 4]) + nz * (from[a * 8 + 5] + from[b * 8 + 5] + from[c * 8 + 5]);
      if (facing < 0) [b, c] = [c, b];
      out = []; grain = grainOf(k / 3); corner(a, 1); corner(b, 1); corner(c, 1);
      const roofKind = Math.floor(from[a * 8 + 6] + 0.01);
      if (roofKind === 13 || roofKind === 15) { corner(a, -1); corner(c, -1); corner(b, -1); }
      faces.push({ out, rank: outward(a, b, c), order: faces.length, part: assembly?.trianglePartIds?.[k / 3] ?? 0 });
    }
    faces.sort((p, q) => q.rank - p.rank || p.order - q.order);
    const vertices = new Float32Array(faces.reduce((sum, face) => sum + face.out.length, 0));
    // Each drawn triangle's part in the builder's assembly (a roof's underside is its sheet's), so the continuum's bake
    // (scripts/prepare-city-continuum.mjs) never simplifies across one.
    const parts = new Uint32Array(vertices.length / 24);
    let filled = 0;
    for (const face of faces) {
      for (let t = 0; t < face.out.length / 24; t++) parts[filled / 24 + t] = face.part;
      vertices.set(face.out, filled); filled += face.out.length;
    }
    // What the builder made, as it made it: shot is traced against this, and the first hit cuts it into pieces.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let at = 0; at < from.length; at += 8) for (let axis = 0; axis < 3; axis++) {
      if (from[at + axis] < min[axis]) min[axis] = from[at + axis];
      if (from[at + axis] > max[axis]) max[axis] = from[at + axis];
    }
    const source = { vertices: from, indices: built.indices, partAssembly: built.partAssembly, min, max };
    return { vertices, parts, count: vertices.length / 8, triangles: vertices.length / 24, source };
  }
}
