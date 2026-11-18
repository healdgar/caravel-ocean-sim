// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The houses the peoples of the Americas build in Castle and Commons' model (scripts/board-native.mjs, its ARCH
// kinds), written in Cairn as the works of the Old World are (js/old-world-works.js), each the size the model gives
// it: x along the lane, z back from it, the lane at -z, the floor at y = 0.
//   Bark longhouse of the Iroquoian towns (Cartier at Hochelaga, 1535): a vault of bark over upright sides, a door
//     in each end, smoke holes along the ridge. Wetu (Massachusett): an oval dome of bark. Arbour house (Lenape,
//     Powhatan; Strachey's "like garden arbors"): a long low vault of reed mats. Bohío (Taíno; Oviedo): a round
//     wall of canes under a cone of palm thatch. Caney: the cacique's house, walls of cane under a gable of thatch,
//     a porch before it. Maloca (Tupinambá; Staden: "fourteen feet wide and a hundred and fifty long", vaulted to
//     the ground): palm thatch from the ground over, a door at each end. The chief's long house and the charnel
//     house (Powhatan) are vaults of bark and of mats; a sweat lodge a small dome.
// And the palisade a town of them is ringed by, stood a section at a time: stakes set in a bank of earth, pointed,
// bound with two rails. Each names the earth it stands on as its footing (partGroup 'foundation_plinth'). A type's
// height is its eaves, as a work's is. A house the model builds at many lengths (a longhouse by its hearths, a maloca
// by its bays, an arbour house by its hoops) is written at each of them, never stretched to its plot.
const NATIVE_FOOT_M = 4.5;
const nativeSpec = (name, width, length, height, materialKind, primitives, foundationDepth = NATIVE_FOOT_M) => ({ schemaVersion: '0.4', name, width, length, height, foundationDepth, materialKind, roofPitch: 2, waterfront: false, primitives });
const nativeBox = (name, from, to, material, more = {}) => ({ primitive: 'box', name, from, to, material, ...more });
const nativeFoot = (hw, hd, top = 0.12) => nativeBox('earth_floor', [-hw, -NATIVE_FOOT_M, -hd], [hw, top, hd], 'earth', { partGroup: 'foundation_plinth' });
const nativeDeg = (radians) => radians * 180 / Math.PI;
// The half-breadth of a vault's section at a height: upright to `wall`, a half-ellipse from there to `top`.
const nativeVaultHalf = (hd, wall, top, y) => (y <= wall ? hd : hd * Math.sqrt(Math.max(0, 1 - ((y - wall) / (top - wall)) ** 2)));
// A vault along x over a plot hw by hd: its section upright to `wall` (none if 0), then a half-ellipse to `top`, each
// facet a panel `th` thick laid inward of it; both ends closed in steps, each with a doorway where `doors` has one.
function nativeVault(name, hw, hd, wall, top, material, { facets = 12, th = 0.14, doors = [true, true], endMaterial = material } = {}) {
  const pts = wall > 0.05 ? [[-hd, 0]] : [];
  for (let i = 0; i <= facets; i++) { const a = Math.PI * i / facets; pts.push([-hd * Math.cos(a), wall + (top - wall) * Math.sin(a)]); }
  if (wall > 0.05) pts.push([hd, 0]);
  const parts = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [z0, y0] = pts[i], [z1, y1] = pts[i + 1], dz = z1 - z0, dy = y1 - y0, L = Math.hypot(dz, dy);
    parts.push({ primitive: 'group', name: `${name}_skin`, position: [0, (y0 + y1) / 2, (z0 + z1) / 2], rotation: [nativeDeg(Math.atan2(-dy, dz)), 0, 0], children: [
      nativeBox(`${name}_panel`, [-hw, -th, -L / 2 - 0.03], [hw, 0, L / 2 + 0.03], material)] });
  }
  const bands = 7, step = top / bands;
  [-1, 1].forEach((side, e) => {
    const x0 = side < 0 ? -hw : hw - th, x1 = side < 0 ? -hw + th : hw;
    for (let j = 0; j < bands; j++) {
      const ya = j * step, yb = (j + 1) * step, half = nativeVaultHalf(hd, wall, top, Math.min(top - 0.02, (ya + yb) / 2)) - th * 0.5;
      if (half > 0.05) parts.push(nativeBox(`${name}_end`, [x0, ya, -half], [x1, yb, half], endMaterial));
    }
    if (doors[e]) parts.push(nativeBox(`${name}_doorway`, [side < 0 ? -hw - 0.03 : hw - th - 0.02, 0.12, -0.5], [side < 0 ? -hw + th + 0.02 : hw + 0.03, Math.min(1.9, top * 0.6), 0.5], 'recess'));
  });
  return parts;
}
// An oval dome over a plot hw by hd, `top` high: bands of a frustum each, a smoke hole at its crown, a doorway to the lane.
function nativeDome(name, hw, hd, top, material, bands = 5) {
  const R = hw, rings = [];
  for (let i = 0; i < bands; i++) {
    const a0 = (Math.PI / 2) * i / bands, a1 = (Math.PI / 2) * (i + 1) / bands, y0 = top * Math.sin(a0), y1 = top * Math.sin(a1);
    rings.push(i + 1 < bands
      ? { primitive: 'cylinder', name: `${name}_shell`, base: [0, y0, 0], height: y1 - y0, radius: R * Math.cos(a0), radiusTop: R * Math.cos(a1), segments: 18, material }
      : { primitive: 'cone', name: `${name}_shell`, base: [0, y0, 0], height: top - y0, radius: R * Math.cos(a0), radiusTop: 0.22 * R / 2.75, segments: 18, material });
  }
  return [
    { primitive: 'group', name: `${name}_dome`, scale: [1, 1, hd / hw], children: [
      ...rings,
      { primitive: 'cylinder', name: `${name}_smoke_hole`, base: [0, top - 0.06, 0], height: 0.08, radius: 0.2 * R / 2.75, segments: 8, material: 'recess' },
    ] },
    nativeBox(`${name}_doorway`, [-0.42, 0.12, -hd - 0.04], [0.42, Math.min(1.45, top * 0.5), -hd + 0.5], 'recess'),
  ];
}

/* ---- the Iroquoian towns ---- */
// A longhouse grows a hearth at a time, each shared by the two families either side of it and this long.
const NATIVE_HEARTH_M = 6;
const NATIVE_BARK_LONGHOUSE = [3, 4, 5].map((hearths) => {
  const hw = hearths * NATIVE_HEARTH_M / 2, hd = 3, wall = 3.4, top = 6.6;
  return nativeSpec(`Bark longhouse (Iroquoian: a vault of elm bark, a door at each end, ${hearths} hearths, one to each two families)`, 2 * hw, 2 * hd, wall, 17, [
    nativeFoot(hw, hd),
    ...nativeVault('longhouse', hw, hd, wall, top, 'bark', { th: 0.16 }),
    // Poles lashed over the bark along its length, and the smoke holes of its hearths down the ridge.
    ...[-0.58, 0.58].map((t) => nativeBox('longhouse_pole', [-hw - 0.15, wall + (top - wall) * Math.cos(t) - 0.02, -hd * Math.sin(t) - 0.07], [hw + 0.15, wall + (top - wall) * Math.cos(t) + 0.12, -hd * Math.sin(t) + 0.07], 'timber')),
    ...Array.from({ length: hearths }, (_, k) => -hw + (k + 0.5) * NATIVE_HEARTH_M).map((x) => nativeBox('longhouse_smoke_hole', [x - 0.45, top - 0.1, -0.45], [x + 0.45, top + 0.08, 0.45], 'recess')),
  ]);
});

/* ---- the Algonquian peoples of the coast ---- */
// Each house the size the model gives it.
const NATIVE_WETU = nativeSpec('Wetu (Massachusett: an oval dome of bark over bent saplings)', 4.8, 4.3, 1.4, 17, [
  nativeFoot(2.4, 2.15),
  ...nativeDome('wetu', 2.4, 2.15, 3.1, 'bark'),
]);
// An arbour house is as long as its hoops of bent poles, a pair of metres apart.
const NATIVE_ARBOUR_HOUSE = [5, 6, 7].map((pairs) => {
  const hw = pairs, hd = 2.6, wall = 0.9, top = 4.9, rise = top - wall;
  return nativeSpec(`Arbour house (Lenape and Powhatan: a long low vault of reed mats, "like garden arbors"; ${2 * hw} m)`, 2 * hw, 2 * hd, 2, 15, [
    nativeFoot(hw, hd),
    ...nativeVault('arbour', hw, hd, wall, top, 'reed', { th: 0.12, doors: [true, true] }),
    ...[-0.7, 0.7].map((t) => nativeBox('arbour_binding', [-hw - 0.1, wall + rise * Math.cos(t) - 0.02, -hd * Math.sin(t) - 0.05], [hw + 0.1, wall + rise * Math.cos(t) + 0.08, -hd * Math.sin(t) + 0.05], 'timber')),
    nativeBox('arbour_smoke_hole', [-0.4, top - 0.1, -0.35], [0.4, top + 0.06, 0.35], 'recess'),
  ]);
});
const NATIVE_CHIEF_HOUSE = nativeSpec('Long house of a chief (a vault of bark, his kin and his guard within)', 10.2, 6, 2.6, 17, [
  nativeFoot(5.1, 3),
  ...nativeVault('chief_house', 5.1, 3, 1.4, 5.8, 'bark', { th: 0.15 }),
  ...[-0.6, 0.6].map((t) => nativeBox('chief_house_pole', [-5.22, 1.4 + 4.4 * Math.cos(t) - 0.02, -3 * Math.sin(t) - 0.06], [5.22, 1.4 + 4.4 * Math.cos(t) + 0.1, -3 * Math.sin(t) + 0.06], 'timber')),
  ...[-2.2, 2.2].map((x) => nativeBox('chief_house_smoke_hole', [x - 0.4, 5.7, -0.38], [x + 0.4, 5.86, 0.38], 'recess')),
]);
const NATIVE_CHARNEL_HOUSE = nativeSpec('Charnel house (Powhatan: a vault of mats on a scaffold of poles, the dead of the chiefs within; carved posts before it)', 10.2, 4.3, 2.3, 15, [
  nativeFoot(5.1, 2.15),
  ...nativeVault('charnel_house', 5.1, 2.15, 1.2, 5.2, 'reed', { th: 0.12, doors: [true, false] }),
  // The carved posts at its door, at the end toward the lane.
  ...[-1.1, 1.1].map((z) => ({ primitive: 'cylinder', name: 'charnel_posts', base: [-5.7, -0.8, z], height: 3.4, radius: 0.18, segments: 7, material: 'dark_wood' })),
]);
const NATIVE_SWEAT_LODGE = nativeSpec('Sweat lodge (a small dome of bark, its stones heated at the door)', 2.2, 2.2, 0.8, 17, [
  nativeFoot(1.1, 1.1),
  ...nativeDome('sweat_lodge', 1.1, 1.1, 1.75, 'bark', 4),
  { primitive: 'cone', name: 'sweat_stones', base: [0.8, 0.1, -1.55], height: 0.35, radius: 0.4, radiusTop: 0.12, segments: 6, material: 'stone' },
]);

/* ---- the Taíno ---- */
const NATIVE_BOHIO = nativeSpec('Bohío (Taíno: a round wall of canes under a cone of palm thatch)', 8, 8, 2.3, 15, [
  nativeFoot(3.9, 3.9),
  { primitive: 'cylinder', name: 'bohio_wall', base: [0, 0.12, 0], height: 2.3, radius: 3.6, segments: 18, material: 'wood' },
  ...Array.from({ length: 8 }, (_, k) => ({ primitive: 'group', name: 'bohio_posts', rotation: [0, 45 * k + 22.5, 0], children: [{ primitive: 'cylinder', name: 'bohio_post', base: [0, -0.6, -3.66], height: 3.0, radius: 0.1, segments: 6, material: 'timber' }] })),
  { primitive: 'cone', name: 'bohio_thatch', base: [0, 2.25, 0], height: 5.0, radius: 4.15, radiusTop: 0.14, segments: 18, material: 'palm_thatch' },
  { primitive: 'cylinder', name: 'bohio_finial', base: [0, 7.15, 0], height: 0.35, radius: 0.1, segments: 6, material: 'timber' },
  nativeBox('bohio_doorway', [-0.5, 0.12, -3.72], [0.5, 2.0, -3.2], 'recess'),
]);
const NATIVE_CANEY = (() => {
  const hw = 5.5, hd = 3.2, eaves = 3, rise = 5, porch = 1.6;
  return nativeSpec('Caney (Taíno: the cacique\'s house, walls of cane under a high gable of palm thatch, a porch before it)', 13, 8, eaves, 15, [
    nativeFoot(6.5, 4),
    ...[['front', -hw, -hd + 0.1, hw, -hd + 0.1], ['right', hw - 0.1, -hd, hw - 0.1, hd], ['back', hw, hd - 0.1, -hw, hd - 0.1], ['left', -hw + 0.1, hd, -hw + 0.1, -hd]].map(([side, ax, az, bx, bz]) => (
      { primitive: 'wall', name: `caney_${side}`, from: [ax, 0.12, az], to: [bx, 0.12, bz], height: eaves - 0.12, thickness: 0.2, material: 'wood', openings: side === 'front' ? [{ offset: hw, width: 1.4, height: 2.2, door: true }] : [] })),
    { primitive: 'group', name: 'caney_thatch', position: [0, 0, 0], rotation: [0, 90, 0], children: [{ primitive: 'roof', height: rise, style: 'gable', overhang: 0.7, material: 'palm_thatch', wallMaterial: 'reed', from: [-hd, eaves, -hw], to: [hd, eaves, hw] }] },
    // The porch: posts before the front, a pent of thatch on them from the eaves.
    ...[-hw + 0.3, -1.8, 1.8, hw - 0.3].map((x) => ({ primitive: 'cylinder', name: 'caney_porch_posts', base: [x, -0.6, -hd - porch + 0.15], height: 0.6 + eaves - 0.75, radius: 0.11, segments: 6, material: 'timber' })),
    { primitive: 'group', name: 'caney_porch', position: [0, eaves - 0.05, -hd], rotation: [-nativeDeg(Math.atan2(0.7, porch)), 0, 0], children: [
      nativeBox('caney_porch_thatch', [-hw - 0.3, -0.12, -porch - 0.25], [hw + 0.3, 0.05, 0.1], 'palm_thatch')] },
  ]);
})();

/* ---- the Tupinambá ---- */
// A maloca is as long as the families it houses, a bay of this length to each pair of them.
const NATIVE_MALOCA_BAY_M = 6;
const NATIVE_MALOCA = [5, 6, 7, 8].map((bays) => {
  const hw = bays * NATIVE_MALOCA_BAY_M / 2, hd = 2.2, top = 4.2;
  return nativeSpec(`Maloca (Tupinambá: a long house of many families, palm thatch vaulted from the ground, a door at each end; ${bays} bays)`, 2 * hw, 2 * hd, 1.6, 15, [
    nativeFoot(hw, hd),
    ...nativeVault('maloca', hw, hd, 0, top, 'palm_thatch', { th: 0.2, endMaterial: 'palm_thatch' }),
    ...[-0.55, 0.55].map((t) => nativeBox('maloca_binding', [-hw - 0.1, top * Math.cos(t) - 0.02, -hd * Math.sin(t) - 0.05], [hw + 0.1, top * Math.cos(t) + 0.08, -hd * Math.sin(t) + 0.05], 'timber')),
  ]);
});

// The houses, in the order they follow the Old World's works (CITY_WORKS); `key` is each one's name in CITY_TYPE,
// then its variants and the one the name stands for (as CITY_WORKS has them).
export const NATIVE_WORKS = Object.freeze([
  ['BARK_LONGHOUSE', NATIVE_BARK_LONGHOUSE, 1], ['WETU', NATIVE_WETU], ['ARBOUR_HOUSE', NATIVE_ARBOUR_HOUSE, 1], ['BOHIO', NATIVE_BOHIO], ['CANEY', NATIVE_CANEY],
  ['MALOCA', NATIVE_MALOCA, 1], ['CHIEF_HOUSE', NATIVE_CHIEF_HOUSE], ['CHARNEL_HOUSE', NATIVE_CHARNEL_HOUSE], ['SWEAT_LODGE', NATIVE_SWEAT_LODGE],
]);

/* ---- the palisade, a section at a time ---- */
// A palisade is stood a section at a time, each a whole number of its stakes (three to the metre), from a metre to
// five; and this high.
export const NATIVE_PALISADE = Object.freeze({ stake: 1 / 3, stakes: [3, 6, 9, 12, 15], high: 4.6 });
const NATIVE_PALISADES = NATIVE_PALISADE.stakes.map((stakes) => {
  const length = stakes * NATIVE_PALISADE.stake, half = length / 2, high = NATIVE_PALISADE.high - 0.45;
  return nativeSpec(`Palisade (stakes set in a bank of earth, pointed, bound with two rails; ${stakes} stakes)`, 1.1, length, NATIVE_PALISADE.high, 10, [
    nativeBox('palisade_bank', [-0.55, -1.3, -half], [0.55, 0.2, half], 'earth', { partGroup: 'foundation_plinth' }),
    ...Array.from({ length: stakes }, (_, k) => {
      const z = -half + (k + 0.5) * NATIVE_PALISADE.stake, r = 0.14 + 0.02 * ((k * 7) % 3) / 2, h = high - 0.18 * ((k * 5) % 3);
      return [
        { primitive: 'cylinder', name: 'palisade_stakes', base: [0, -1.2, z], height: h + 1.2, radius: r, segments: 7, material: 'timber' },
        { primitive: 'cone', name: 'palisade_points', base: [0, h, z], height: 0.45, radius: r, radiusTop: 0.04, segments: 7, material: 'timber' },
      ];
    }).flat(),
    ...[1.3, 3.2].map((y) => nativeBox('palisade_rail', [0.14, y, -half], [0.3, y + 0.16, half], 'dark_wood')),
  ], 1.3);
});
// The slighter works, after the Old World's: a palisade stops shot and whoever walks, so it is no slight thing to the
// guns (it is not in CITY_TYPES_SLIGHT), only written as large as it is.
export const NATIVE_SLIGHT_WORKS = Object.freeze([['PALISADE', NATIVE_PALISADES, NATIVE_PALISADES.length - 1]]);

// What each is to the guns: the name its damage is kept under and reported by.
export const NATIVE_WORKS_TARGETS = Object.freeze({
  BARK_LONGHOUSE: { prefabId: 'native_longhouse', label: 'Bark longhouse' }, WETU: { prefabId: 'native_house', label: 'Wetu' }, ARBOUR_HOUSE: { prefabId: 'native_house', label: 'Arbour house' },
  BOHIO: { prefabId: 'native_house', label: 'Bohío' }, CANEY: { prefabId: 'native_chief_house', label: 'Caney' }, MALOCA: { prefabId: 'native_longhouse', label: 'Maloca' },
  CHIEF_HOUSE: { prefabId: 'native_chief_house', label: 'Chief\'s house' }, CHARNEL_HOUSE: { prefabId: 'native_charnel_house', label: 'Charnel house' }, SWEAT_LODGE: { prefabId: 'native_sweat_lodge', label: 'Sweat lodge' },
  PALISADE: { prefabId: 'native_palisade', label: 'Palisade' },
});
