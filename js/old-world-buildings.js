// The building types of an Old World city, written in Cairn, the game's declarative JSON
// building language (js/cairn-primitives.js): walls with their openings, arches, roofs, boxes.
// Each type is compiled once into a mesh and drawn as GPU instances wherever the city's plan
// stands a building of that type near the camera; farther off its plain block stands in.
//
// A type's local frame is the plan's: x along the street, z away from it, the street front at
// -z, the floor at y = 0. Its width, length and height are what an instance is scaled from.

export const CITY_STOREY_M = 2.9;
const FOOTING_M = 6.5; // Walls run this far below the floor, so a house on a slope has no gap under it.
const WALL_M = 0.42;

// What the plan and the types must agree on: a church's proportions, and how its towers stand.
export const CITY_CHURCH = Object.freeze({
  parish: Object.freeze({ width: 11, depth: 27, height: 11, tower: 5 }),
  great: Object.freeze({ width: 15, depth: 40, height: 15, tower: 6.4 }),
  towerRise: 9.5, // A bell tower's walls stand this far above the nave's.
  spire: 3.4,
});
export const CITY_GATE = Object.freeze({ span: 10, thick: 2.6, passage: 8.6, chamber: 2.9 });
export const CITY_HOUSE_STOREYS = 5;

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

function houseSpec({ name, storeys, front, depth, ridge, manner = 'plain', seed = 0 }) {
  const S = CITY_STOREY_M, hw = front / 2, hd = depth / 2, height = storeys * S, bays = Math.max(2, Math.round(front / 2.4)), bay = front / bays;
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

// A parish church: a nave with its portal and round window to the street, tall windows down
// each side, and a bell tower (or two) beside the front.
function churchSpec({ name, width, depth, height, tower, towers, material = 'whitewash' }) {
  const hw = width / 2, hd = depth / 2, th = 0.8, primitives = [
    { primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -FOOTING_M, -hd], to: [hw, 0, hd], material: 'ashlar' },
    { primitive: 'wall', name: 'west_front', from: [-hw, 0, -hd + th / 2], to: [hw, 0, -hd + th / 2], height, thickness: th, material, openings: [{ offset: width / 2, width: 1.6, height: 1.6, sill: height * 0.62 }] },
    { primitive: 'arch', name: 'portal', from: [-1.7, 0, -hd - 0.12], to: [1.7, 0, -hd - 0.12], height: 4.6, thickness: 0.5, voussoirs: 9, material: 'limestone' },
    { primitive: 'box', name: 'apse_wall', from: [-hw, 0, hd - th], to: [hw, height, hd], material },
  ];
  const windows = Math.max(2, Math.round((depth - 4) / 5.5));
  for (const side of [-1, 1]) {
    const openings = [];
    for (let k = 0; k < windows; k++) openings.push({ offset: 2 + (k + 0.5) * (depth - 4) / windows, width: 0.9, height: height * 0.36, sill: height * 0.42 });
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

// A square tower of the wall or the castle: an ashlar shaft with slits, a wall-walk and merlons.
function towerSpec({ name, side, height, slits }) {
  const h = side / 2, primitives = [
    { primitive: 'box', partGroup: 'foundation_plinth', from: [-h, -FOOTING_M, -h], to: [h, 0, h], material: 'dark_stone' },
    { primitive: 'box', name: 'shaft', from: [-h, 0, -h], to: [h, height - 1.2, h], topInset: 0.1, material: 'ashlar' },
    { primitive: 'box', name: 'wall_walk', from: [-h - 0.15, height - 1.2, -h - 0.15], to: [h + 0.15, height - 0.9, h + 0.15], material: 'limestone' },
  ];
  for (const [ax, az, bx, bz] of [[-h, -h, h, -h], [h, -h, h, h], [h, h, -h, h], [-h, h, -h, -h]]) {
    primitives.push({ primitive: 'wall', from: [ax, height - 0.9, az], to: [bx, height - 0.9, bz], height: 0.9, thickness: 0.5, material: 'ashlar', crenellated: true, merlonWidth: 1.05, merlonGap: 0.75, merlonHeight: 0.85 });
  }
  for (let k = 0; k < slits; k++) {
    const y = 3 + k * (height - 6) / Math.max(1, slits);
    for (const [x, z, w, d] of [[0, -h - 0.02, 0.2, 0.04], [0, h + 0.02, 0.2, 0.04], [-h - 0.02, 0, 0.04, 0.2], [h + 0.02, 0, 0.04, 0.2]]) {
      primitives.push({ primitive: 'box', name: 'arrow_slit', from: [x - w, y, z - d], to: [x + w, y + 1.5, z + d], material: 'recess' });
    }
  }
  return { schemaVersion: '0.4', name, width: side, length: side, height, foundationDepth: FOOTING_M, materialKind: 11, roofPitch: 0, waterfront: false, primitives };
}

// A length of the town's wall or the castle's: a thick ashlar curtain, its wall-walk behind a
// parapet of merlons. The parapet stands along the type's -x side; the plan turns that outward.
export const CITY_CURTAIN = Object.freeze({ thick: 2.4, height: 8.5, short: 7, long: 10, parapet: 0.8, merlon: 1.3, rise: 1.15 });
function curtainSpec({ name, length }) {
  const t = CITY_CURTAIN.thick / 2, h = length / 2, top = CITY_CURTAIN.height, sill = 0.3;
  return {
    schemaVersion: '0.4', name, width: CITY_CURTAIN.thick, length, height: top, foundationDepth: FOOTING_M, materialKind: 11, roofPitch: 0, waterfront: false,
    primitives: [
      { primitive: 'box', partGroup: 'foundation_plinth', from: [-t, -FOOTING_M, -h], to: [t, 0, h], material: 'dark_stone' },
      { primitive: 'box', name: 'curtain', from: [-t, 0, -h], to: [t, top, h], material: 'ashlar' },
      { primitive: 'wall', name: 'curtain_parapet', from: [-t + CITY_CURTAIN.parapet / 2, top, -h], to: [-t + CITY_CURTAIN.parapet / 2, top, h], height: sill, thickness: CITY_CURTAIN.parapet, material: 'ashlar', crenellated: true, merlonWidth: CITY_CURTAIN.merlon, merlonGap: CITY_CURTAIN.merlon, merlonHeight: CITY_CURTAIN.rise - sill },
    ],
  };
}

// The castle's hall: two tall storeys of limewashed wall under a hipped roof, its door in the long front.
export const CITY_HALL = Object.freeze({ width: 12, depth: 30, height: 10.5, roof: 3.2 });
function hallSpec({ name }) {
  const { width, depth, height, roof } = CITY_HALL, hw = width / 2, hd = depth / 2, th = 0.7, storey = height / 2;
  const primitives = [{ primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -FOOTING_M, -hd], to: [hw, 0, hd], material: 'ashlar' }];
  const sides = [[-hw, -hd + th / 2, hw, -hd + th / 2], [hw - th / 2, -hd, hw - th / 2, hd], [hw, hd - th / 2, -hw, hd - th / 2], [-hw + th / 2, hd, -hw + th / 2, -hd]];
  for (let level = 0; level < 2; level++) {
    sides.forEach(([ax, az, bx, bz], side) => {
      const run = Math.hypot(bx - ax, bz - az), bays = Math.max(2, Math.round(run / 4.2)), openings = [];
      for (let bay = 0; bay < bays; bay++) {
        const offset = (bay + 0.5) * run / bays;
        openings.push(level === 0 && side === 1 && bay === Math.floor(bays / 2) ? { offset, width: 1.8, height: 3.1, door: true } : { offset, width: 1, height: storey * 0.42, sill: storey * 0.3 });
      }
      primitives.push({ primitive: 'wall', name: `hall_wall_${level}_${side}`, from: [ax, level * storey, az], to: [bx, level * storey, bz], height: storey, thickness: th, material: 'stucco', openings });
    });
  }
  primitives.push({ primitive: 'roof', from: [-hw, height, -hd], to: [hw, height, hd], height: roof, style: 'hip', overhang: 0.4, material: 'roof_tile', wallMaterial: 'stucco' });
  return { schemaVersion: '0.4', name, width, length: depth, height, foundationDepth: FOOTING_M, materialKind: 12, roofPitch: 3, waterfront: false, primitives };
}

// The city's types, in the order their numbers are used by the plan and the renderer: the plain houses by their
// storeys, eaves to the street and then gable to it; then every other manner of house; then the rest.
const HOUSES = [
  ['Casa térrea', 'single-storey house', 6.6, 9.5],
  ['Sobrado', 'two-storey house', 6.4, 11],
  ['Casa de três andares', 'three-storey house', 6.2, 12.5],
  ['Casa de quatro andares', 'four-storey house', 6.2, 12.5],
  ['Casa alta', 'five-storey house', 6.2, 13],
];
// The manners a house of each height may be built in besides plainly, and how often each is met with (the plain
// house counts three).
const HOUSE_MANNERS = [['loja', 'baixa'], ['ressalto', 'loja', 'cantaria'], ['ressalto', 'cantaria', 'arcada'], ['ressalto', 'arcada'], ['arcada']];
const HOUSE_MANNER = Object.freeze({
  plain: { share: 3 },
  ressalto: { share: 3, words: ['de ressalto', 'timber-framed floors jettied over the street'] },
  cantaria: { share: 1.5, words: ['de cantaria', 'dressed stone, tall windows on balconies'] },
  loja: { share: 1.5, words: ['com loja', 'a shop below'] },
  arcada: { share: 2.5, words: ['de arcada', 'the ground floor behind an arcade of columns'] },
  baixa: { share: 2, words: ['de quatro águas', 'a hipped roof and a great chimney'] },
});
const HOUSE_RIDGES = [['street', '', 'eaves to the street'], ['depth', ' de empena', 'gable to the street']];
const houseTypes = HOUSE_RIDGES.flatMap(([ridge, suffix, lie]) => HOUSES.map(([name, gloss, front, depth], k) => houseSpec({ name: `${name}${suffix} (${gloss}, ${lie})`, storeys: k + 1, front, depth, ridge })));
// By ridge and storeys, the types a house may be: [type, share] with the plain one first.
const HOUSE_CHOICES = HOUSE_RIDGES.map((_, r) => HOUSES.map((_, k) => [[r * HOUSES.length + k, HOUSE_MANNER.plain.share]]));
HOUSE_RIDGES.forEach(([ridge, suffix, lie], r) => HOUSES.forEach(([name, gloss, front, depth], k) => HOUSE_MANNERS[k].forEach((manner, m) => {
  const { share, words } = HOUSE_MANNER[manner];
  HOUSE_CHOICES[r][k].push([houseTypes.length, share]);
  houseTypes.push(houseSpec({ name: `${name} ${words[0]}${suffix} (${gloss}, ${words[1]}, ${lie})`, storeys: k + 1, front, depth, ridge, manner, seed: 0x5eed0000 + r * 4099 + k * 257 + m * 31 }));
})));
export const CITY_HOUSE_TYPES = houseTypes.length;
export const CITY_BUILDING_TYPES = Object.freeze([
  ...houseTypes,
  churchSpec({ name: 'Igreja paroquial (parish church, tower to the left)', ...CITY_CHURCH.parish, towers: [-1] }),
  churchSpec({ name: 'Igreja paroquial (parish church, tower to the right)', ...CITY_CHURCH.parish, towers: [1] }),
  churchSpec({ name: 'Sé (great church, two towers)', ...CITY_CHURCH.great, towers: [-1, 1], material: 'limestone' }),
  towerSpec({ name: 'Torre da cerca (wall tower)', side: 6.2, height: 12.5, slits: 2 }),
  towerSpec({ name: 'Torre de menagem (keep)', side: 13, height: 21, slits: 3 }),
  (() => {
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
  })(),
  curtainSpec({ name: 'Pano de muralha (short length of wall)', length: CITY_CURTAIN.short }),
  curtainSpec({ name: 'Pano de muralha (long length of wall)', length: CITY_CURTAIN.long }),
  hallSpec({ name: 'Paço (castle hall)' }),
]);

const H = CITY_HOUSE_STOREYS, AFTER_HOUSES = CITY_HOUSE_TYPES;
export const CITY_TYPE = Object.freeze({ HOUSE_EAVES: 0, HOUSE_GABLE: H, CHURCH_LEFT: AFTER_HOUSES, CHURCH_RIGHT: AFTER_HOUSES + 1, CHURCH_GREAT: AFTER_HOUSES + 2, WALL_TOWER: AFTER_HOUSES + 3, KEEP: AFTER_HOUSES + 4, GATE: AFTER_HOUSES + 5, CURTAIN_SHORT: AFTER_HOUSES + 6, CURTAIN_LONG: AFTER_HOUSES + 7, HALL: AFTER_HOUSES + 8 });
// What a type is to the guns: the name its damage is kept under and reported by. The wall and
// its towers, the keep and the gate are fortified stone (js/gunnery-control.js); the rest is masonry.
export function cityTypeTarget(type) {
  if (type < AFTER_HOUSES) return { prefabId: 'city_house', label: 'Town house' };
  if (type === CITY_TYPE.CHURCH_GREAT) return { prefabId: 'city_church', label: 'Cathedral' };
  if (type < CITY_TYPE.WALL_TOWER) return { prefabId: 'city_church', label: 'Parish church' };
  if (type === CITY_TYPE.WALL_TOWER) return { prefabId: 'city_wall_tower', label: 'Wall tower' };
  if (type === CITY_TYPE.KEEP) return { prefabId: 'city_keep', label: 'Castle keep' };
  if (type === CITY_TYPE.GATE) return { prefabId: 'city_gate', label: 'City gate' };
  if (type === CITY_TYPE.HALL) return { prefabId: 'city_castle_hall', label: 'Castle hall' };
  return { prefabId: 'city_wall', label: 'City wall' };
}
// Eight numbers to an instance of a type: x, floor height, z, turn; scale across, up and along; tone.
export const CITY_TYPED_FLOATS = 8;
// How near a building must be to be drawn as its type rather than its block.
export const CITY_DETAIL_M = 240;
// A plan's block that a type replaces near the camera carries its roof form plus this.
export const CITY_TYPED_ROOF = 4;

// The type of a house of so many storeys, and its ridge. `pick` (0 to 1, the house's own throw) chooses its manner
// among those a house of that height is built in; none asked, it is the plain house.
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
export function compileCityBuildingTypes(buildGeometry) {
  return CITY_BUILDING_TYPES.map((spec, id) => {
    const built = buildGeometry({
      singleBuildingPrefab: true,
      instances: [{ prefabId: `city_type_${id}`, id: `city_type_${id}`, x: 0, y: 0, z: 0, yaw: 0, width: spec.width, length: spec.length, depth: spec.length, height: spec.height, foundationDepth: spec.foundationDepth, materialKind: spec.materialKind, roofPitch: spec.roofPitch, cairnSpec: spec }],
    }, null);
    const from = built.vertices, faces = [];
    let out = null;
    const corner = (index, flip) => { const o = index * 8; out.push(from[o], from[o + 1], from[o + 2], flip * from[o + 3], flip * from[o + 4], flip * from[o + 5], from[o + 6], from[o + 7]); };
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
      out = []; corner(a, 1); corner(b, 1); corner(c, 1);
      if (Math.floor(from[a * 8 + 6] + 0.01) === 13) { corner(a, -1); corner(c, -1); corner(b, -1); }
      faces.push({ out, rank: outward(a, b, c), order: faces.length });
    }
    faces.sort((p, q) => q.rank - p.rank || p.order - q.order);
    const vertices = new Float32Array(faces.reduce((sum, face) => sum + face.out.length, 0));
    let filled = 0;
    for (const face of faces) { vertices.set(face.out, filled); filled += face.out.length; }
    // What the builder made, as it made it: shot is traced against this, and the first hit cuts it into pieces.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let at = 0; at < from.length; at += 8) for (let axis = 0; axis < 3; axis++) {
      if (from[at + axis] < min[axis]) min[axis] = from[at + axis];
      if (from[at + axis] > max[axis]) max[axis] = from[at + axis];
    }
    const source = { vertices: from, indices: built.indices, partAssembly: built.partAssembly, min, max };
    return { id, name: spec.name, width: spec.width, length: spec.length, height: spec.height, vertices, count: vertices.length / 8, triangles: vertices.length / 24, source };
  });
}
