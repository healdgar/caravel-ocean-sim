// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Everything Castle and Commons' model builds besides a house, a church and a castle, written in Cairn: its mills by
// wind and water, granaries, barns, outbuildings, dovecotes, toll houses, hovels, winepresses, tanneries and dye
// works, the stone halls of chapter, refectory, hospital, bath and guild, cloisters, courtyard houses, wharves and
// quarries; what is left of a building burnt or thrown down; and the slighter works of its country: field fences of
// rail and of dry stone, the bridges its tracks cross water by, graves, memorial cairns, the tents and standards of
// camps and hosts, and the scaffold of a work in hand. Each is a type like any house (js/old-world-buildings.js):
// x along the street, z back from it, the street front at -z, the floor at y = 0. What is 'stucco' in a type takes
// the instance's wash or paint (js/wgsl/terrain.js). The builder lays a plinth of its own under any type that names
// none, so each names what it stands on.
const WORKS_FOOT_M = 6.5;
const worksSpec = (name, width, length, height, materialKind, primitives, foundationDepth = WORKS_FOOT_M) => ({ schemaVersion: '0.4', name, width, length, height, foundationDepth, materialKind, roofPitch: 2, waterfront: false, primitives });
const worksBox = (name, from, to, material, more = {}) => ({ primitive: 'box', name, from, to, material, ...more });
const worksFoot = (hw, hd, material = 'ashlar', top = 0) => ({ primitive: 'box', partGroup: 'foundation_plinth', from: [-hw, -WORKS_FOOT_M, -hd], to: [hw, top, hd], material });
const worksDoor = (offset, width = 1.1, height = 2.1) => ({ offset, width, height, door: true });
const worksWindow = (offset, width = 0.8, height = 1, sill = 1.1) => ({ offset, width, height, sill });
// Four walls round a plot, each with its openings: front (to the street), right, back and left. `at` moves the plot.
function worksWalls(name, hw, hd, y, height, th, material, openings = {}, at = [0, 0]) {
  const [cx, cz] = at, lines = [['front', -hw, -hd + th / 2, hw, -hd + th / 2], ['right', hw - th / 2, -hd, hw - th / 2, hd], ['back', hw, hd - th / 2, -hw, hd - th / 2], ['left', -hw + th / 2, hd, -hw + th / 2, -hd]];
  return lines.filter(([side]) => openings[side] !== null).map(([side, ax, az, bx, bz]) => (
    { primitive: 'wall', name: `${name}_${side}`, from: [cx + ax, y, cz + az], to: [cx + bx, y, cz + bz], height, thickness: th, material, openings: openings[side] ?? [] }));
}
// A roof over a plot: its ridge along the street ('x') or running back from it ('z').
function worksRoof(name, hw, hd, y, rise, ridge, material = 'roof_tile', wallMaterial = 'stucco', style = 'gable', overhang = 0.35, at = [0, 0]) {
  const [cx, cz] = at, roof = { primitive: 'roof', height: rise, style, overhang, material, wallMaterial };
  return ridge === 'z' ? { ...roof, name, from: [cx - hw, y, cz - hd], to: [cx + hw, y, cz + hd] }
    : { primitive: 'group', name, position: [cx, 0, cz], rotation: [0, 90, 0], children: [{ ...roof, from: [-hd, y, -hw], to: [hd, y, hw] }] };
}
const worksPost = (name, x, z, y0, y1, half = 0.09, material = 'oak') => worksBox(name, [x - half, y0, z - half], [x + half, y1, z + half], material);
const worksEvenly = (count, from, to) => Array.from({ length: count }, (_, k) => from + (to - from) * (count === 1 ? 0.5 : k / (count - 1)));

/* ---- mills ---- */
const WORKS_WINDMILL = worksSpec('Moinho de vento (tower windmill, four sails of cloth)', 6, 6, 8, 12, [
  { primitive: 'cylinder', partGroup: 'foundation_plinth', name: 'mill_footing', base: [0, -WORKS_FOOT_M, 0], height: WORKS_FOOT_M, radius: 2.98, segments: 12, material: 'ashlar' },
  { primitive: 'cylinder', name: 'mill_tower', base: [0, 0, 0], height: 6.2, radius: 2.9, radiusTop: 2.35, segments: 12, material: 'stucco' },
  worksBox('mill_door', [-0.5, 0, -2.99], [0.5, 2, -2.6], 'recess'),
  worksBox('mill_window', [-0.3, 3.7, -2.72], [0.3, 4.4, -2.2], 'recess'),
  { primitive: 'cone', name: 'mill_cap', base: [0, 6.2, 0], height: 1.8, radius: 2.7, radiusTop: 0.08, segments: 12, material: 'timber' },
  worksBox('mill_windshaft', [-0.12, 6.0, -2.98], [0.12, 6.24, -1.4], 'oak'),
  ...[0, 1, 2, 3].map((k) => ({ primitive: 'group', name: 'mill_sails', position: [0, 6.12, -2.9], rotation: [0, 0, 45 + 90 * k], children: [
    worksBox('sail_spar', [-0.06, 0, -0.06], [0.06, 4.2, 0.06], 'oak'),
    worksBox('sail_cloth', [0.06, 0.8, -0.03], [1.12, 4.0, 0.03], 'stucco'),
  ] })),
]);
// A wheel's half-breadth, how far its paddles reach, and how far out from the wall and above the floor its axle is.
export const WORKS_WHEEL = Object.freeze({ half: 0.5, reach: 2.45, out: 0.85, axle: 1.3 });
const WORKS_WATERMILL = (() => {
  const hw = 4.5, hd = 4.5, low = 2.8, eaves = 5.6, W = WORKS_WHEEL, wx = hw + W.out;
  return worksSpec('Azenha (watermill, its wheel under a launder)', 9, 9, eaves, 11, [
    worksFoot(hw, hd),
    ...worksWalls('mill_ground', hw, hd, 0, low, 0.6, 'ashlar', { front: [worksDoor(4.5, 1.3, 2.2), worksWindow(1.8, 0.7, 0.8, 1.3)], back: [worksWindow(4.5, 0.7, 0.8, 1.3)], left: [worksWindow(4.5, 0.7, 0.8, 1.3)] }),
    ...worksWalls('mill_loft', hw, hd, low, eaves - low, 0.45, 'stucco', { front: [worksWindow(2.2), worksWindow(6.8)], back: [worksWindow(4.5)], right: [worksWindow(2)], left: [worksWindow(4.5)] }),
    worksRoof('mill_roof', hw, hd, eaves, 2.2, 'x'),
    // The wheel, on its side of the mill: two shrouds, eight paddles standing out beyond them, the axle through the wall.
    // A cylinder is closed at its top only, so each shroud is turned to show its face: the outer one outward, the
    // inner one to the wall.
    { primitive: 'group', name: 'mill_wheel', position: [wx, W.axle, 0.5], rotation: [0, 0, -90], children: [
      { primitive: 'cylinder', name: 'wheel_shroud', base: [0, W.half - 0.2, 0], height: 0.2, radius: 1.95, segments: 12, material: 'dark_wood' },
      { primitive: 'cylinder', name: 'wheel_axle', base: [0, -W.half - 0.25, 0], height: 2 * W.half + 0.75, radius: 0.24, segments: 6, material: 'oak' },
      ...Array.from({ length: 8 }, (_, k) => ({ primitive: 'group', name: 'wheel_paddles', rotation: [0, 45 * k, 0], children: [worksBox('wheel_paddle', [1.2, -W.half + 0.2, -0.04], [W.reach, W.half - 0.2, 0.04], 'wood')] })),
    ] },
    { primitive: 'group', name: 'mill_wheel', position: [wx, W.axle, 0.5], rotation: [0, 0, 90], children: [
      { primitive: 'cylinder', name: 'wheel_shroud', base: [0, W.half - 0.2, 0], height: 0.2, radius: 1.95, segments: 12, material: 'dark_wood' },
    ] },
    // The launder that brings the water over it, on trestles from behind the mill.
    worksBox('mill_launder', [wx - 0.42, 3.82, 0.2], [wx + 0.42, 3.9, hd + 3.4], 'wood'),
    worksBox('mill_launder', [wx - 0.46, 3.9, 0.2], [wx - 0.4, 4.16, hd + 3.4], 'wood'),
    worksBox('mill_launder', [wx + 0.4, 3.9, 0.2], [wx + 0.46, 4.16, hd + 3.4], 'wood'),
    ...[hd + 0.4, hd + 3.1].flatMap((z) => [worksPost('launder_trestle', wx - 0.5, z, -2.2, 3.82), worksPost('launder_trestle', wx + 0.5, z, -2.2, 3.82)]),
  ]);
})();

/* ---- stores ---- */
const WORKS_GRANARY = (() => {
  const hw = 4, hd = 4, floor = 0.95, eaves = 4.6, staddles = worksEvenly(3, -3.1, 3.1);
  return worksSpec('Celeiro (granary raised on staddle stones)', 8, 8, eaves, 10, [
    worksFoot(3.6, 3.6, 'ashlar', 0.25),
    ...staddles.flatMap((x) => staddles.flatMap((z) => [
      { primitive: 'cylinder', name: 'staddle', base: [x, 0.25, z], height: 0.56, radius: 0.3, radiusTop: 0.2, segments: 6, material: 'limestone' },
      worksBox('staddle_cap', [x - 0.42, 0.81, z - 0.42], [x + 0.42, floor, z + 0.42], 'limestone'),
    ])),
    worksBox('granary_floor', [-hw, floor, -hd], [hw, floor + 0.2, hd], 'oak'),
    ...worksWalls('granary', hw, hd, floor + 0.2, eaves - floor - 0.2, 0.25, 'wood', { front: [worksDoor(4, 1.2, 1.9)], left: [worksWindow(4, 0.5, 0.5, 2.2)], right: [worksWindow(4, 0.5, 0.5, 2.2)] }),
    ...[-hw, hw].flatMap((x) => [-hd, hd].map((z) => worksPost('granary_corner', x - Math.sign(x) * 0.1, z - Math.sign(z) * 0.1, floor, eaves, 0.13))),
    { primitive: 'pyramid', name: 'granary_roof', from: [-hw - 0.2, eaves, -hd - 0.2], to: [hw + 0.2, eaves, hd + 0.2], height: 2.3, material: 'roof_tile' },
    worksBox('granary_step', [-0.9, 0, -hd - 0.64], [0.9, 0.36, -hd - 0.32], 'limestone'),
    worksBox('granary_step', [-0.9, 0, -hd - 0.32], [0.9, 0.72, -hd + 0.02], 'limestone'),
  ]);
})();
const WORKS_SHED = (() => {
  const hw = 2.5, hd = 2.25, eaves = 2.3;
  return worksSpec('Telheiro (outbuilding, open to its yard)', 5, 4.5, eaves, 10, [
    worksFoot(hw, hd, 'stone'),
    ...worksWalls('shed', hw, hd, 0, eaves, 0.2, 'wood', { front: null, right: [worksWindow(2.25, 0.5, 0.5, 1.3)] }),
    worksPost('shed_post', -hw + 0.1, -hd + 0.1, 0, eaves, 0.1), worksPost('shed_post', hw - 0.1, -hd + 0.1, 0, eaves, 0.1), worksPost('shed_post', 0, -hd + 0.1, 0, eaves, 0.08),
    worksBox('shed_plate', [-hw, eaves - 0.16, -hd], [hw, eaves, -hd + 0.2], 'oak'),
    worksRoof('shed_roof', hw, hd, eaves, 0.95, 'x', 'roof_tile', 'wood', 'gable', 0.3),
  ]);
})();
const WORKS_BARN = (() => {
  const hw = 6, hd = 6, eaves = 4.6, th = 0.6;
  return worksSpec('Celeiro grande (barn or storehouse, great doors to the street)', 12, 12, eaves, 12, [
    worksFoot(hw, hd),
    ...worksWalls('barn', hw, hd, 0, eaves, th, 'stucco', {
      front: [worksDoor(6, 2.8, 3.4), worksWindow(1.8, 0.35, 1.1, 2.3), worksWindow(10.2, 0.35, 1.1, 2.3)],
      back: [worksWindow(3, 0.35, 1.1, 2.3), worksWindow(9, 0.35, 1.1, 2.3)], left: [worksWindow(6, 0.35, 1.1, 2.3)], right: [worksWindow(6, 0.35, 1.1, 2.3)] }),
    worksBox('barn_door_head', [-1.7, 3.4, -hd - 0.08], [1.7, 3.72, -hd + 0.1], 'limestone'),
    worksBox('barn_door_jamb', [-1.72, 0, -hd - 0.06], [-1.4, 3.4, -hd + 0.1], 'limestone'), worksBox('barn_door_jamb', [1.4, 0, -hd - 0.06], [1.72, 3.4, -hd + 0.1], 'limestone'),
    ...[[-hw - 0.03, -hw + 0.4], [hw - 0.4, hw + 0.03]].map(([x0, x1]) => worksBox('barn_quoins', [x0, 0, -hd - 0.05], [x1, eaves, -hd + 0.35], 'limestone')),
    worksRoof('barn_roof', hw, hd, eaves, 3.1, 'x'),
  ]);
})();
const WORKS_DOVECOTE = worksSpec('Pombal (dovecote)', 6, 6, 7, 12, [
  { primitive: 'cylinder', partGroup: 'foundation_plinth', name: 'dovecote_footing', base: [0, -WORKS_FOOT_M, 0], height: WORKS_FOOT_M, radius: 2.6, segments: 12, material: 'ashlar' },
  { primitive: 'cylinder', name: 'dovecote_tower', base: [0, 0, 0], height: 5.4, radius: 2.5, radiusTop: 2.3, segments: 12, material: 'stucco' },
  { primitive: 'cylinder', name: 'dovecote_ledge', base: [0, 3.9, 0], height: 0.14, radius: 2.72, segments: 12, material: 'limestone' },
  worksBox('dovecote_door', [-0.4, 0, -2.56], [0.4, 1.6, -2.2], 'recess'),
  ...[-0.9, -0.3, 0.3, 0.9].map((x) => worksBox('dovecote_holes', [x - 0.12, 4.3, -2.42], [x + 0.12, 4.6, -2.0], 'recess')),
  { primitive: 'cone', name: 'dovecote_roof', base: [0, 5.4, 0], height: 1.6, radius: 2.75, radiusTop: 0.5, segments: 12, material: 'roof_tile' },
  { primitive: 'cylinder', name: 'dovecote_lantern', base: [0, 7, 0], height: 0.5, radius: 0.45, segments: 8, material: 'timber' },
  { primitive: 'cone', name: 'dovecote_cap', base: [0, 7.5, 0], height: 0.45, radius: 0.7, radiusTop: 0.08, segments: 8, material: 'roof_tile' },
]);

/* ---- by the road and on the land ---- */
const WORKS_TOLL = (() => {
  const hw = 3, hd = 3, eaves = 3.2;
  return worksSpec('Portagem (toll house, its bar swung back along the wall)', 6, 6, eaves, 11, [
    worksFoot(hw, hd),
    ...worksWalls('toll', hw, hd, 0, eaves, 0.5, 'ashlar', { front: [worksDoor(1.6), worksWindow(4.2, 0.9, 0.9, 1.1)], right: [worksWindow(3, 0.7, 0.9, 1.1)], left: [worksWindow(3, 0.7, 0.9, 1.1)] }),
    worksRoof('toll_roof', hw, hd, eaves, 1.6, 'x', 'roof_tile', 'ashlar'),
    worksPost('toll_bar_pivot', hw - 0.3, -hd - 0.36, -1, 1.25, 0.1),
    worksBox('toll_bar', [-hw - 0.5, 1.0, -hd - 0.43], [hw + 0.3, 1.14, -hd - 0.29], 'stucco'),
    worksBox('toll_bar_weight', [hw + 0.02, 0.86, -hd - 0.52], [hw + 0.34, 1.2, -hd - 0.2], 'stone'),
  ]);
})();
const WORKS_COT = (() => {
  const hw = 2.5, hd = 2.25, eaves = 1.9;
  return worksSpec('Choça (cottar\'s hovel under thatch)', 5, 4.5, eaves, 12, [
    worksFoot(hw, hd, 'stone'),
    ...worksWalls('cot', hw, hd, 0, eaves, 0.3, 'plaster', { front: [worksDoor(1.6, 0.85, 1.7), worksWindow(3.7, 0.5, 0.5, 0.95)], back: [worksWindow(2.5, 0.45, 0.45, 1)] }),
    worksRoof('cot_thatch', hw, hd, eaves, 2.0, 'x', 'thatch', 'plaster', 'gable', 0.5),
    worksBox('cot_smoke_hole', [-0.3, eaves + 1.72, -0.2], [0.3, eaves + 2.06, 0.2], 'timber'),
  ]);
})();
const WORKS_WINEPRESS = (() => {
  const hw = 4.5, hd = 4, eaves = 3.4;
  return worksSpec('Lagar (winepress under its roof, open to the yard)', 9, 8, eaves, 11, [
    worksFoot(hw, hd),
    ...worksWalls('press_house', hw, hd, 0, eaves, 0.55, 'stone', { front: null, back: [worksWindow(2.2, 0.5, 0.7, 1.6), worksWindow(6.8, 0.5, 0.7, 1.6)] }),
    ...[-hw + 0.14, -1.5, 1.5, hw - 0.14].map((x) => worksPost('press_post', x, -hd + 0.14, 0, eaves, 0.14)),
    worksBox('press_plate', [-hw, eaves - 0.24, -hd], [hw, eaves, -hd + 0.28], 'oak'),
    worksRoof('press_roof', hw, hd, eaves, 2.0, 'x', 'roof_tile', 'stone'),
    // The press: a stone trough, the great beam over it between two cheeks, the screw at its free end.
    worksBox('press_trough', [-3.2, 0, -0.6], [-0.4, 0.55, 1.8], 'limestone'), worksBox('press_must', [-3.0, 0.5, -0.4], [-0.6, 0.57, 1.6], 'recess'),
    worksPost('press_cheek', -3.4, 0.6, 0, 2.5, 0.13), worksPost('press_cheek', -0.2, 0.6, 0, 2.5, 0.13),
    worksBox('press_beam', [-3.6, 1.7, 0.42], [3.4, 2.05, 0.78], 'oak'),
    { primitive: 'cylinder', name: 'press_screw', base: [3.0, 0, 0.6], height: 2.4, radius: 0.13, segments: 6, material: 'oak' },
    { primitive: 'cylinder', name: 'press_weight', base: [3.0, 0, 0.6], height: 0.6, radius: 0.5, segments: 8, material: 'limestone' },
    { primitive: 'cylinder', name: 'press_vat', base: [1.2, 0, -1.6], height: 0.95, radius: 0.85, radiusTop: 0.95, segments: 10, material: 'wood' },
  ]);
})();
const WORKS_VATS = (() => {
  const hw = 7, hd = 4, eaves = 3.0, vat = (x, z) => [
    { primitive: 'cylinder', name: 'vat', base: [x, 0, z], height: 0.75, radius: 0.85, radiusTop: 0.95, segments: 10, material: 'wood' },
    { primitive: 'cylinder', name: 'vat_liquor', base: [x, 0.7, z], height: 0.07, radius: 0.84, segments: 10, material: 'recess' }];
  return worksSpec('Oficina de curtidor ou tintureiro (tannery or dye works: vats in the yard, cloths on the frames)', 14, 8, eaves, 10, [
    worksFoot(hw, hd, 'stone'),
    // The shed along the back of the plot, open to its yard.
    ...worksWalls('works_shed', hw, 2, 0, eaves, 0.22, 'wood', { front: null }, [0, 2]),
    ...worksEvenly(5, -hw + 0.12, hw - 0.12).map((x) => worksPost('works_post', x, 0.12, 0, eaves, 0.11)),
    worksBox('works_plate', [-hw, eaves - 0.18, 0], [hw, eaves, 0.24], 'oak'),
    worksRoof('works_roof', hw, 2, eaves, 1.1, 'x', 'roof_tile', 'wood', 'gable', 0.3, [0, 2]),
    ...vat(-5.4, -2.1), ...vat(-3.2, -2.3), ...vat(-4.3, -0.6), ...vat(-1.6, -0.8),
    // The drying frames: a rail on posts, three lengths hung over it.
    ...[-2.9, -1.5].flatMap((z) => [
      worksPost('frame_post', 0.6, z, -0.5, 2.1, 0.06), worksPost('frame_post', 3.5, z, -0.5, 2.1, 0.06), worksPost('frame_post', 6.4, z, -0.5, 2.1, 0.06),
      worksBox('frame_rail', [0.5, 2.04, z - 0.04], [6.5, 2.12, z + 0.04], 'oak'),
      ...[[0.9, 2.5], [2.8, 4.3], [4.6, 6.1]].map(([x0, x1], k) => worksBox('frame_cloth', [x0, 0.55 + 0.12 * k, z - 0.07], [x1, 2.16, z + 0.07], 'stucco')),
    ]),
  ]);
})();

/* ---- of stone: the halls of chapter, refectory, hospital, bath and guild; cloister and courtyard house ---- */
const WORKS_STONE_HALL = (() => {
  const hw = 8, hd = 5, low = 3.1, eaves = 6.4, th = 0.7, bays = 5, bay = 2 * hw / bays;
  const upper = Array.from({ length: bays }, (_, k) => worksWindow((k + 0.5) * bay, 0.8, 1.9, 0.7));
  return worksSpec('Casa de pedra (stone hall: chapter house, refectory, hospital, bath, guildhall)', 16, 10, eaves, 11, [
    worksFoot(hw, hd),
    ...worksWalls('hall_ground', hw, hd, 0, low, th, 'ashlar', {
      front: Array.from({ length: bays }, (_, k) => k === 2 ? worksDoor((k + 0.5) * bay, 1.6, 2.5) : worksWindow((k + 0.5) * bay, 0.5, 1.2, 1.1)),
      back: [worksWindow(4, 0.5, 1.2, 1.1), worksWindow(12, 0.5, 1.2, 1.1)], left: [worksWindow(5, 0.5, 1.2, 1.1)], right: [worksWindow(5, 0.5, 1.2, 1.1)] }),
    ...worksWalls('hall_upper', hw, hd, low, eaves - low, th, 'ashlar', { front: upper, back: upper, left: [worksWindow(5, 1.2, 2.2, 0.6)], right: [worksWindow(5, 1.2, 2.2, 0.6)] }),
    // A buttress at each bay line of the front and back, stepped once.
    ...Array.from({ length: bays + 1 }, (_, k) => -hw + k * bay).flatMap((x) => [-1, 1].flatMap((side) => {
      const z0 = side < 0 ? -hd - 0.62 : hd, z1 = side < 0 ? -hd : hd + 0.62, x0 = Math.max(-hw, x - 0.3), x1 = Math.min(hw, x + 0.3);
      return [worksBox('hall_buttress', [x0, 0, z0], [x1, low + 0.4, z1], 'limestone'), worksBox('hall_buttress', [x0, low + 0.4, side < 0 ? -hd - 0.34 : hd], [x1, eaves - 0.5, side < 0 ? -hd : hd + 0.34], 'limestone')];
    })),
    worksBox('hall_string_course', [-hw - 0.03, low - 0.08, -hd - 0.06], [hw + 0.03, low + 0.08, -hd + 0.02], 'limestone'),
    worksRoof('hall_roof', hw, hd, eaves, 3.2, 'x', 'roof_tile', 'ashlar'),
  ]);
})();
// The cloister's walk is this wide, under a pent roof falling from the outer wall to the arcade.
const WORKS_CLOISTER = (() => {
  const hw = 9.6, hd = 11, wall = 3.5, walk = 3, arcade = 2.5, ix = hw - walk, iz = hd - walk, slope = Math.atan2(wall - 0.3 - arcade, walk) * 180 / Math.PI;
  const run = Math.hypot(walk + 0.3, wall - 0.3 - arcade), parts = [
    worksFoot(hw, hd),
    ...worksWalls('cloister_wall', hw, hd, 0, wall, 0.6, 'ashlar', { front: [worksDoor(hw, 1.6, 2.5)], back: [worksWindow(hw, 0.6, 1.2, 1.4)] }),
    worksBox('cloister_garth', [-ix, -0.3, -iz], [ix, 0.04, iz], 'earth'),
    { primitive: 'cylinder', name: 'cloister_well', base: [0, 0, 0], height: 0.8, radius: 0.85, segments: 10, material: 'ashlar' },
    { primitive: 'cylinder', name: 'cloister_well_mouth', base: [0, 0.74, 0], height: 0.08, radius: 0.6, segments: 10, material: 'recess' },
  ];
  // The arcade about the garth: a low wall, a column to each bay, the beam they carry.
  const columns = (name, ax, az, bx, bz) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(2, Math.round(L / 2.6));
    for (let k = 0; k <= n; k++) parts.push({ primitive: 'cylinder', name: 'cloister_columns', base: [ax + (bx - ax) * k / n, 0.5, az + (bz - az) * k / n], height: arcade - 0.5, radius: 0.15, segments: 6, material: 'limestone' });
    parts.push(worksBox(name + '_sill', [Math.min(ax, bx) - 0.2, 0, Math.min(az, bz) - 0.2], [Math.max(ax, bx) + 0.2, 0.5, Math.max(az, bz) + 0.2], 'limestone'));
    parts.push(worksBox(name + '_beam', [Math.min(ax, bx) - 0.2, arcade, Math.min(az, bz) - 0.2], [Math.max(ax, bx) + 0.2, arcade + 0.22, Math.max(az, bz) + 0.2], 'limestone'));
  };
  columns('arcade_front', -ix, -iz, ix, -iz); columns('arcade_back', -ix, iz, ix, iz); columns('arcade_left', -ix, -iz, -ix, iz); columns('arcade_right', ix, -iz, ix, iz);
  // The pent roofs: each a sheet of tiles hinged on the outer wall and let down to the arcade.
  for (const [name, x, z, turn, half] of [['walk_front', 0, -hd + 0.3, 0, hw], ['walk_right', hw - 0.3, 0, -90, hd], ['walk_back', 0, hd - 0.3, 180, hw], ['walk_left', -hw + 0.3, 0, 90, hd]]) {
    parts.push({ primitive: 'group', name: `${name}_roof`, position: [x, wall - 0.3, z], rotation: [0, turn, 0], children: [
      { primitive: 'group', rotation: [slope, 0, 0], children: [worksBox('walk_tiles', [-half + 0.3, 0, 0], [half - 0.3, 0.1, run], 'roof_tile')] }] });
  }
  return worksSpec('Claustro (cloister: a covered walk about its garth)', 19.2, 22, wall, 11, parts);
})();
const WORKS_COURT = (() => {
  const hw = 8, hd = 8, storey = 3, eaves = 6, range = 4.5, ix = hw - range, iz = hd - range, th = 0.5;
  const row = (length, n, w = 0.85, h = 1.2, sill = 1) => Array.from({ length: n }, (_, k) => worksWindow((k + 0.5) * length / n, w, h, sill));
  const front0 = row(16, 5).map((o, k) => k === 2 ? worksDoor(8, 2.4, 2.8) : o);
  return worksSpec('Casa de pátio (courtyard house: four ranges about a court, a gateway to the street)', 16, 16, eaves, 12, [
    worksFoot(hw, hd),
    ...worksWalls('court_ground', hw, hd, 0, storey, th, 'stucco', { front: front0, back: row(16, 4), left: row(16, 4), right: row(16, 4) }),
    ...worksWalls('court_upper', hw, hd, storey, storey, th, 'stucco', { front: row(16, 5, 0.95, 1.5, 0.75), back: row(16, 4), left: row(16, 4), right: row(16, 4) }),
    // The court's own four walls, a gallery of timber along the back of it.
    worksBox('court_inner_front', [-ix, 0, -iz - 0.4], [ix, eaves, -iz], 'stucco'), worksBox('court_inner_back', [-ix, 0, iz], [ix, eaves, iz + 0.4], 'stucco'),
    worksBox('court_inner_left', [-ix - 0.4, 0, -iz], [-ix, eaves, iz], 'stucco'), worksBox('court_inner_right', [ix, 0, -iz], [ix + 0.4, eaves, iz], 'stucco'),
    worksBox('court_passage', [-1.2, 0, -iz - 0.42], [1.2, 2.8, -iz + 0.02], 'recess'),
    worksBox('court_gallery', [-ix, storey - 0.14, iz - 1.1], [ix, storey, iz], 'oak'), worksBox('court_gallery_rail', [-ix, storey + 0.86, iz - 1.1], [ix, storey + 0.94, iz - 1.02], 'oak'),
    ...worksEvenly(4, -ix + 0.1, ix - 0.1).map((x) => worksPost('court_gallery_post', x, iz - 1.0, 0, eaves, 0.08)),
    worksBox('court_paving', [-ix, -0.3, -iz], [ix, 0.03, iz], 'cobble'),
    worksBox('court_gate_head', [-1.5, 2.8, -hd - 0.08], [1.5, 3.12, -hd + 0.1], 'limestone'),
    worksBox('court_gate_jamb', [-1.52, 0, -hd - 0.06], [-1.2, 2.8, -hd + 0.1], 'limestone'), worksBox('court_gate_jamb', [1.2, 0, -hd - 0.06], [1.52, 2.8, -hd + 0.1], 'limestone'),
    worksRoof('court_roof_front', hw, range / 2, eaves, 1.5, 'x', 'roof_tile', 'stucco', 'gable', 0.3, [0, -hd + range / 2]),
    worksRoof('court_roof_back', hw, range / 2, eaves, 1.5, 'x', 'roof_tile', 'stucco', 'gable', 0.3, [0, hd - range / 2]),
    worksRoof('court_roof_left', range / 2, hd, eaves, 1.5, 'z', 'roof_tile', 'stucco', 'gable', 0.3, [-hw + range / 2, 0]),
    worksRoof('court_roof_right', range / 2, hd, eaves, 1.5, 'z', 'roof_tile', 'stucco', 'gable', 0.3, [hw - range / 2, 0]),
  ]);
})();

/* ---- at the water and in the hill ---- */
const WORKS_WHARF = (() => {
  const hw = 3.5, hd = 15, rows = worksEvenly(7, -hd + 0.6, hd - 0.6);
  return worksSpec('Cais de madeira (timber wharf on its piles)', 7, 30, 1, 10, [
    worksBox('wharf_deck', [-hw, -0.28, -hd], [hw, 0, hd], 'wood', { partGroup: 'foundation_plinth' }),
    ...rows.flatMap((z) => [-hw + 0.3, 0, hw - 0.3].map((x) => ({ primitive: 'cylinder', name: 'wharf_piles', base: [x, -WORKS_FOOT_M, z], height: WORKS_FOOT_M - 0.28, radius: 0.19, segments: 6, material: 'timber' }))),
    ...rows.filter((_, k) => k % 2 === 0).flatMap((z) => [-hw + 0.3, hw - 0.3].map((x) => ({ primitive: 'cylinder', name: 'wharf_bollards', base: [x, 0, z], height: 0.85, radius: 0.17, segments: 6, material: 'timber' }))),
    worksBox('wharf_kerb', [-hw, 0, -hd], [-hw + 0.2, 0.18, hd], 'oak'), worksBox('wharf_kerb', [hw - 0.2, 0, -hd], [hw, 0.18, hd], 'oak'),
    worksBox('wharf_bales', [-1.4, 0, 6.2], [0.2, 0.9, 8.4], 'stucco'), worksBox('wharf_casks', [0.6, 0, 9.2], [2.2, 1.0, 10.4], 'wood'),
  ]);
})();
const WORKS_QUARRY = (() => {
  const hw = 10, hd = 7, legs = 4.8, lean = 13;
  return worksSpec('Pedreira (quarry: the worked face, cut stone, shear-legs)', 20, 14, 3, 11, [
    worksBox('quarry_face', [-hw, -WORKS_FOOT_M, 1.5], [hw, 1.3, hd], 'stone', { partGroup: 'foundation_plinth' }),
    worksBox('quarry_bench', [-hw + 1.5, 1.3, 3.6], [hw - 2.5, 2.5, hd], 'stone'),
    worksBox('quarry_bench', [-hw + 4, 2.5, 5.4], [hw - 6, 3.4, hd], 'dark_stone'),
    worksBox('quarry_floor', [-hw, -WORKS_FOOT_M, -hd], [hw, 0.04, 1.5], 'earth'),
    ...[[-6.5, -3.2, 1.3, 0.7, 0.8], [-4.6, -4.4, 1.1, 0.6, 0.7], [-5.4, -1.2, 1.5, 0.75, 0.8], [2.2, -4.8, 1.2, 0.65, 0.7], [4.4, -3.6, 1.2, 0.65, 0.9], [3.3, -3.9, 1.0, 1.25, 0.7], [7.2, -1.0, 1.4, 0.7, 0.8]]
      .map(([x, z, w, h, d]) => worksBox('quarry_blocks', [x - w / 2, 0, z - d / 2], [x + w / 2, h, z + d / 2], 'limestone')),
    // Shear-legs over the floor: two spars lashed at the head, the block hanging from them, a windlass at the foot.
    ...[-1, 1].map((side) => ({ primitive: 'group', name: 'shear_legs', position: [side * legs * Math.sin(lean * Math.PI / 180), 0, -1.6], rotation: [0, 0, side * lean], children: [worksBox('shear_leg', [-0.08, -0.4, -0.08], [0.08, legs, 0.08], 'timber')] })),
    worksBox('shear_rope', [-0.03, 1.5, -1.63], [0.03, legs * Math.cos(lean * Math.PI / 180), -1.57], 'oak'),
    worksBox('shear_load', [-0.5, 0.85, -2.0], [0.5, 1.5, -1.2], 'limestone'),
    worksBox('shear_windlass', [-1.5, 0.5, -0.2], [1.5, 0.66, -0.04], 'oak'), worksPost('shear_windlass_post', -1.4, -0.12, -0.3, 0.8, 0.07), worksPost('shear_windlass_post', 1.4, -0.12, -0.3, 0.8, 0.07),
  ]);
})();

/* ---- what is left of a building: burnt to its walls, or thrown down ---- */
const WORKS_RUIN = (() => {
  const hw = 4, hd = 4, th = 0.5, broken = (name, x0, z0, x1, z1, heights) => heights.map((h, k) => {
    const a = k / heights.length, b = (k + 1) / heights.length;
    return worksBox(name, [x0 + (x1 - x0) * (x1 - x0 > th ? a : 0), 0, z0 + (z1 - z0) * (z1 - z0 > th ? a : 0)], [x1 - x0 > th ? x0 + (x1 - x0) * b : x1, h, z1 - z0 > th ? z0 + (z1 - z0) * b : z1], 'stucco');
  });
  return worksSpec('Ruína (a house burnt to its walls)', 8, 8, 4, 12, [
    worksFoot(hw, hd, 'stone'),
    ...broken('ruin_front', -hw, -hd, hw, -hd + th, [3.6, 2.2, 0.9, 2.8, 4.0]), ...broken('ruin_back', -hw, hd - th, hw, hd, [4.0, 3.4, 1.6, 2.4, 3.1]),
    ...broken('ruin_left', -hw, -hd + th, -hw + th, hd - th, [3.2, 1.4, 2.6, 3.8]), ...broken('ruin_right', hw - th, -hd + th, hw, hd - th, [2.6, 3.9, 1.1, 2.9]),
    worksBox('ruin_door', [-0.55, 0, -hd - 0.02], [0.55, 2.0, -hd + th + 0.02], 'recess'),
    ...[[-2.2, -1.4, 28], [0.6, 0.8, -22], [2.1, -2.0, 40]].map(([x, z, tilt], k) => ({ primitive: 'group', name: 'ruin_beams', position: [x, 0.2, z], rotation: [0, 35 * k, tilt], children: [worksBox('charred_beam', [-0.1, 0, -0.1], [0.1, 3.4, 0.1], 'dark_wood')] })),
    ...[[-1.4, 1.6, 1.2, 0.5], [1.5, 2.2, 0.9, 0.4], [0.2, -1.9, 1.4, 0.6], [-2.6, -0.2, 0.8, 0.45]].map(([x, z, w, h]) => worksBox('ruin_fallen', [x - w / 2, 0, z - w / 2], [x + w / 2, h, z + w / 2], 'stone')),
  ]);
})();
const WORKS_RUBBLE = worksSpec('Entulho (the heap where a building stood)', 8, 8, 1.4, 11, [
  worksFoot(3.6, 3.6, 'stone', 0.2),
  ...[[-1.6, -1.2, 2.4, 0.9], [1.3, -0.8, 2.0, 1.2], [0.2, 1.5, 2.8, 0.8], [-2.2, 1.6, 1.6, 1.1], [2.3, 1.9, 1.5, 0.7], [-0.3, -2.4, 1.8, 0.6]].map(([x, z, r, h], k) => (
    { primitive: 'cone', name: 'rubble_heap', base: [x, 0.2, z], height: h, radius: r / 2 + 0.5, radiusTop: 0.3, segments: 6, material: k % 2 ? 'stone' : 'dark_stone' })),
  ...[[-0.8, 0.4, 62], [1.6, 0.6, -70]].map(([x, z, tilt], k) => ({ primitive: 'group', name: 'rubble_beams', position: [x, 0.5, z], rotation: [0, 50 + 70 * k, tilt], children: [worksBox('charred_beam', [-0.09, -0.6, -0.09], [0.09, 2.6, 0.09], 'dark_wood')] })),
]);

/* ---- the slighter works: a length of fence, a track's bridge, graves, a cairn, a tent, a standard, a scaffold ---- */
// A fence is stood a length at a time; each length is this long before it is fitted to its run.
export const WORKS_FENCE_M = 5;
const WORKS_FENCE_RAIL = worksSpec('Cerca (post-and-rail fence, a length)', 0.3, WORKS_FENCE_M, 1.2, 10, [
  worksPost('fence_post', 0, -2.5 + 0.09, -1.3, 1.2, 0.09, 'timber'),
  worksBox('fence_post', [-0.09, -1.3, -0.09], [0.09, 1.2, 0.09], 'timber', { partGroup: 'foundation_plinth' }),
  worksBox('fence_rail', [-0.04, 0.42, -2.5], [0.04, 0.56, 2.5], 'wood'), worksBox('fence_rail', [-0.04, 0.9, -2.5], [0.04, 1.04, 2.5], 'wood'),
], 1.3);
const WORKS_FENCE_STONE = worksSpec('Muro de pedra solta (dry-stone wall, a length)', 0.7, WORKS_FENCE_M, 1.15, 11, [
  worksBox('drystone_wall', [-0.32, -1.3, -2.5], [0.32, 1.0, 2.5], 'stone', { partGroup: 'foundation_plinth', topInset: 0.06 }),
  ...worksEvenly(7, -2.2, 2.2).map((z, k) => worksBox('drystone_cope', [-0.3, 1.0, z - 0.3], [0.3, 1.1 + 0.05 * (k % 2), z + 0.3], 'dark_stone')),
], 1.3);
// A bridge is written this long and stretched to its span; its deck is the floor.
export const WORKS_BRIDGE_M = 9;
const WORKS_FOOTBRIDGE = worksSpec('Pontão (timber bridge of a track)', 3, WORKS_BRIDGE_M, 6, 10, [
  worksBox('bridge_deck', [-1.4, -0.24, -4.5], [1.4, 0, 4.5], 'wood', { partGroup: 'foundation_plinth' }),
  worksBox('bridge_beam', [-1.25, -0.5, -4.5], [-0.95, -0.24, 4.5], 'oak'), worksBox('bridge_beam', [0.95, -0.5, -4.5], [1.25, -0.24, 4.5], 'oak'),
  ...[-2.4, 2.4].flatMap((z) => [-1.1, 1.1].map((x) => ({ primitive: 'cylinder', name: 'bridge_piles', base: [x, -5, z], height: 4.5, radius: 0.16, segments: 6, material: 'timber' }))),
  ...[-1.34, 1.34].flatMap((x) => [...worksEvenly(4, -4.3, 4.3).map((z) => worksPost('bridge_rail_post', x, z, 0, 1.0, 0.06)), worksBox('bridge_rail', [x - 0.04, 0.92, -4.4], [x + 0.04, 1.0, 4.4], 'oak')]),
], 5);
const WORKS_STONE_BRIDGE = worksSpec('Ponte de pedra (stone bridge of a track, one arch)', 3.9, WORKS_BRIDGE_M, 6, 11, [
  worksBox('bridge_deck', [-1.8, -0.4, -4.5], [1.8, 0, 4.5], 'cobble', { partGroup: 'foundation_plinth' }),
  { primitive: 'group', name: 'bridge_arch', rotation: [0, 90, 0], children: [
    { primitive: 'arch', name: 'bridge_arch', from: [-3.1, -3.8, 0], to: [3.1, -3.8, 0], height: 3.4, thickness: 3.6, voussoirs: 9, pierWidth: 0.9, openThrough: true, material: 'ashlar' }] },
  worksBox('bridge_abutment', [-1.8, -5, -4.5], [1.8, -0.4, -3.1], 'ashlar'), worksBox('bridge_abutment', [-1.8, -5, 3.1], [1.8, -0.4, 4.5], 'ashlar'),
  worksBox('bridge_parapet', [-1.8, 0, -4.5], [-1.5, 0.85, 4.5], 'ashlar'), worksBox('bridge_parapet', [1.5, 0, -4.5], [1.8, 0.85, 4.5], 'ashlar'),
], 5);
const WORKS_GRAVES = worksSpec('Campas (graves of a churchyard)', 6, 6, 1.2, 11, [
  worksBox('grave_slab', [-2.6, -0.4, -2.4], [-1.7, 0.14, -0.5], 'stone', { partGroup: 'foundation_plinth' }),
  ...[[-0.4, -2.2], [1.6, -1.9], [2.3, 0.4], [0.3, 0.2], [-1.9, 1.0], [1.1, 1.4]].flatMap(([x, z], k) => k % 3 === 2
    ? [worksBox('grave_slab', [x - 0.45, -0.3, z - 0.95], [x + 0.45, 0.14, z + 0.95], 'stone')]
    : [worksBox('grave_cross', [x - 0.07, -0.4, z - 0.06], [x + 0.07, 1.05 + 0.1 * (k % 2), z + 0.06], 'limestone'), worksBox('grave_cross', [x - 0.3, 0.66, z - 0.06], [x + 0.3, 0.8, z + 0.06], 'limestone'),
      worksBox('grave_mound', [x - 0.4, -0.3, z + 0.1], [x + 0.4, 0.12, z + 1.5], 'earth')]),
], 0.4);
const WORKS_CAIRN = worksSpec('Moledro (memorial cairn)', 2.4, 2.4, 1.7, 11, [
  { primitive: 'cone', partGroup: 'foundation_plinth', name: 'cairn_heap', base: [0, -0.6, 0], height: 1.7, radius: 1.2, radiusTop: 0.3, segments: 7, material: 'stone' },
  worksBox('cairn_cross', [-0.06, 1.0, -0.05], [0.06, 1.7, 0.05], 'oak'), worksBox('cairn_cross', [-0.25, 1.36, -0.05], [0.25, 1.46, 0.05], 'oak'),
], 0.6);
const WORKS_TENT = worksSpec('Tenda (a tent of a camp)', 3.8, 3.8, 2.6, 10, [
  { primitive: 'cone', partGroup: 'foundation_plinth', name: 'tent_cloth', base: [0, -0.3, 0], height: 2.8, radius: 1.9, radiusTop: 0.1, segments: 8, material: 'stucco' },
  worksPost('tent_pole', 0, 0, 2.3, 2.6, 0.04), worksBox('tent_door', [-0.35, 0, -1.72], [0.35, 1.3, -1.2], 'recess'),
], 0.3);
const WORKS_STANDARD = worksSpec('Estandarte (the standard of a host)', 1.9, 0.2, 6, 10, [
  worksBox('standard_staff', [-0.05, -1, -0.05], [0.05, 6, 0.05], 'oak', { partGroup: 'foundation_plinth' }),
  worksBox('standard_cloth', [0.05, 4.5, -0.02], [1.85, 5.8, 0.02], 'stucco'),
], 1);
const WORKS_SCAFFOLD = worksSpec('Andaime (a work in hand: scaffold, stone and timber stacked by it)', 6, 6, 6, 10, [
  worksBox('scaffold_stack', [-2.9, -0.5, -2.8], [-1.1, 0.9, -1.4], 'limestone', { partGroup: 'foundation_plinth' }),
  ...[-2.4, 2.4].flatMap((x) => [0.2, 2.6].map((z) => worksPost('scaffold_pole', x, z, -0.8, 6, 0.07, 'timber'))),
  ...[2, 4].flatMap((y) => [worksBox('scaffold_boards', [-2.6, y, 0.1], [2.6, y + 0.07, 2.7], 'wood'), worksBox('scaffold_ledger', [-2.6, y - 0.12, 0.14], [2.6, y, 0.26], 'timber'), worksBox('scaffold_ledger', [-2.6, y - 0.12, 2.54], [2.6, y, 2.66], 'timber')]),
  { primitive: 'group', name: 'scaffold_ladder', position: [1.6, 0, -1.2], rotation: [-18, 0, 0], children: [worksBox('ladder_rail', [-0.28, 0, -0.04], [-0.22, 4.4, 0.04], 'oak'), worksBox('ladder_rail', [0.22, 0, -0.04], [0.28, 4.4, 0.04], 'oak'),
    ...worksEvenly(6, 0.5, 3.9).map((y) => worksBox('ladder_rung', [-0.22, y, -0.03], [0.22, y + 0.05, 0.03], 'oak'))] },
  worksBox('scaffold_timber', [0.4, 0, -2.9], [2.8, 0.5, -2.1], 'timber'),
], 0.8);

// The works in the order their numbers follow the street's: what stands on a footing as a house does, then the
// slighter things. `key` is each one's name in CITY_TYPE.
export const CITY_WORKS = Object.freeze([
  ['WINDMILL', WORKS_WINDMILL], ['WATERMILL', WORKS_WATERMILL], ['GRANARY', WORKS_GRANARY], ['SHED', WORKS_SHED], ['BARN', WORKS_BARN], ['DOVECOTE', WORKS_DOVECOTE], ['TOLL', WORKS_TOLL], ['COT', WORKS_COT],
  ['WINEPRESS', WORKS_WINEPRESS], ['VATS', WORKS_VATS], ['STONE_HALL', WORKS_STONE_HALL], ['CLOISTER', WORKS_CLOISTER], ['COURT', WORKS_COURT], ['WHARF', WORKS_WHARF], ['QUARRY', WORKS_QUARRY], ['RUIN', WORKS_RUIN], ['RUBBLE', WORKS_RUBBLE],
  ['FENCE_RAIL', WORKS_FENCE_RAIL], ['FENCE_STONE', WORKS_FENCE_STONE], ['FOOTBRIDGE', WORKS_FOOTBRIDGE], ['STONE_BRIDGE', WORKS_STONE_BRIDGE], ['GRAVES', WORKS_GRAVES], ['CAIRN', WORKS_CAIRN], ['TENT', WORKS_TENT], ['STANDARD', WORKS_STANDARD], ['SCAFFOLD', WORKS_SCAFFOLD],
]);
// How many of them stand on a footing as a house does; the rest are the slighter works.
export const CITY_WORKS_BUILT = 17;
