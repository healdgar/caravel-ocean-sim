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

// A town house: so many storeys, so many bays, its door in the middle bay, its ridge along the
// street (eaves to the street) or along the plot (gable to the street).
function houseSpec({ name, storeys, front, depth, ridge }) {
  const hw = front / 2, hd = depth / 2, height = storeys * CITY_STOREY_M, bays = Math.max(2, Math.round(front / 2.4));
  const primitives = [
    { primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -FOOTING_M, -hd], to: [hw, 0, hd], material: 'stucco' },
    { primitive: 'box', name: 'party_wall_left', from: [-hw, 0, -hd + WALL_M], to: [-hw + WALL_M, height, hd - WALL_M], material: 'stucco' },
    { primitive: 'box', name: 'party_wall_right', from: [hw - WALL_M, 0, -hd + WALL_M], to: [hw, height, hd - WALL_M], material: 'stucco' },
  ];
  for (let storey = 0; storey < storeys; storey++) {
    const y = storey * CITY_STOREY_M, openings = [];
    for (let bay = 0; bay < bays; bay++) {
      const offset = (bay + 0.5) * front / bays;
      if (storey === 0) openings.push(bay === Math.floor(bays / 2) ? { offset, width: 1.15, height: 2.15, door: true } : { offset, width: 0.85, height: 1.0, sill: 1.15 });
      else openings.push({ offset, width: 0.9, height: 1.35, sill: 0.85 });
    }
    primitives.push({ primitive: 'wall', name: `street_front_${storey}`, from: [-hw, y, -hd + WALL_M / 2], to: [hw, y, -hd + WALL_M / 2], height: CITY_STOREY_M, thickness: WALL_M, material: 'stucco', openings });
    primitives.push({ primitive: 'wall', name: `yard_wall_${storey}`, from: [hw, y, hd - WALL_M / 2], to: [-hw, y, hd - WALL_M / 2], height: CITY_STOREY_M, thickness: WALL_M, material: 'stucco', openings: [{ offset: front / 2, width: 0.85, height: 1.1, sill: 1.0 }] });
  }
  // A balcony on the first floor of the taller houses, on stone corbels with an iron rail.
  if (storeys >= 3) {
    primitives.push({ primitive: 'box', name: 'balcony', from: [-hw + 0.5, CITY_STOREY_M - 0.14, -hd - 0.6], to: [hw - 0.5, CITY_STOREY_M, -hd], material: 'limestone' });
    primitives.push({ primitive: 'box', name: 'balcony_rail', from: [-hw + 0.5, CITY_STOREY_M + 0.86, -hd - 0.6], to: [hw - 0.5, CITY_STOREY_M + 0.92, -hd - 0.54], material: 'iron' });
    for (let k = 0, posts = Math.round((front - 1) / 0.62); k <= posts; k++) {
      const x = -hw + 0.5 + (front - 1 - 0.05) * k / posts;
      primitives.push({ primitive: 'box', name: 'balcony_baluster', from: [x, CITY_STOREY_M, -hd - 0.59], to: [x + 0.05, CITY_STOREY_M + 0.86, -hd - 0.55], material: 'iron' });
    }
    for (const x of [-hw + 0.5, hw - 0.56]) primitives.push({ primitive: 'box', name: 'balcony_return', from: [x, CITY_STOREY_M + 0.86, -hd - 0.6], to: [x + 0.06, CITY_STOREY_M + 0.92, -hd], material: 'iron' });
  }
  if (ridge === 'street') {
    primitives.push({ primitive: 'group', name: 'roof', rotation: [0, 90, 0], children: [
      { primitive: 'roof', from: [-hd, height, -hw], to: [hd, height, hw], height: 0.36 * depth / 2, style: 'gable', overhang: 0.3, material: 'roof_tile', wallMaterial: 'stucco' },
    ] });
  } else {
    primitives.push({ primitive: 'roof', from: [-hw, height, -hd], to: [hw, height, hd], height: 0.5 * front / 2, style: 'gable', overhang: 0.3, material: 'roof_tile', wallMaterial: 'stucco' });
  }
  primitives.push({ primitive: 'box', name: 'chimney', from: [hw - 1.5, height + 0.2, hd - 3.2], to: [hw - 0.8, height + 0.36 * depth / 2 + 0.9, hd - 2.5], material: 'stucco' });
  return { schemaVersion: '0.4', name, width: front, length: depth, height, foundationDepth: FOOTING_M, materialKind: 12, roofPitch: 2, waterfront: false, primitives };
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

// The city's types, in the order their numbers are used by the plan and the renderer.
const HOUSES = [
  ['Casa térrea', 'single-storey house', 6.6, 9.5],
  ['Sobrado', 'two-storey house', 6.4, 11],
  ['Casa de três andares', 'three-storey house', 6.2, 12.5],
  ['Casa de quatro andares', 'four-storey house', 6.2, 12.5],
  ['Casa alta', 'five-storey house', 6.2, 13],
];
export const CITY_BUILDING_TYPES = Object.freeze([
  ...HOUSES.map(([name, gloss, front, depth], k) => houseSpec({ name: `${name} (${gloss}, eaves to the street)`, storeys: k + 1, front, depth, ridge: 'street' })),
  ...HOUSES.map(([name, gloss, front, depth], k) => houseSpec({ name: `${name} de empena (${gloss}, gable to the street)`, storeys: k + 1, front, depth, ridge: 'depth' })),
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

const H = CITY_HOUSE_STOREYS;
export const CITY_TYPE = Object.freeze({ HOUSE_EAVES: 0, HOUSE_GABLE: H, CHURCH_LEFT: 2 * H, CHURCH_RIGHT: 2 * H + 1, CHURCH_GREAT: 2 * H + 2, WALL_TOWER: 2 * H + 3, KEEP: 2 * H + 4, GATE: 2 * H + 5, CURTAIN_SHORT: 2 * H + 6, CURTAIN_LONG: 2 * H + 7, HALL: 2 * H + 8 });
// What a type is to the guns: the name its damage is kept under and reported by. The wall and
// its towers, the keep and the gate are fortified stone (js/gunnery-control.js); the rest is masonry.
export function cityTypeTarget(type) {
  if (type < 2 * H) return { prefabId: 'city_house', label: 'Town house' };
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

// The type of a house of so many storeys, and its ridge.
export function cityHouseType(storeys, eavesToStreet) {
  return (eavesToStreet ? CITY_TYPE.HOUSE_EAVES : CITY_TYPE.HOUSE_GABLE) + Math.max(1, Math.min(CITY_HOUSE_STOREYS, storeys)) - 1;
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
