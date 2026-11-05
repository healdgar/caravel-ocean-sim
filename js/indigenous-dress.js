// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What people of each Indigenous culture wear day to day, and what only a few wear, or only at
// ceremony. One body model holds every optional piece, and each person's look says which show, so
// variety costs no extra draws. An attempt from general history, not a study of any one people:
// people here dress for an ordinary day, so feathers and gold are the exception, as they were.

// Pieces of the model, in the order `buildIndigenousCrewModel` tags them.
export const DRESS_PIECES = Object.freeze(['HEADBAND', 'ONE_FEATHER', 'MORE_FEATHERS', 'PLAITS', 'LOOSE_HAIR', 'ROACH', 'GOLD_COLLAR', 'SHELL_COLLAR', 'JADE_COLLAR', 'QUETZAL_PLUMES', 'FEATHER_CROWN', 'LIP_PLUG']);
const dressBit = (index) => 2 ** index;
const HEADBAND = dressBit(0), ONE_FEATHER = dressBit(1), MORE_FEATHERS = dressBit(2), PLAITS = dressBit(3), LOOSE_HAIR = dressBit(4), ROACH = dressBit(5);
const GOLD_COLLAR = dressBit(6), SHELL_COLLAR = dressBit(7), JADE_COLLAR = dressBit(8), QUETZAL_PLUMES = dressBit(9), FEATHER_CROWN = dressBit(10), LIP_PLUG = dressBit(11);
// How the rest of the body is shown.
const SHAVED = dressBit(12), SHAVED_FRONT = dressBit(13), BARE_TORSO = dressBit(14), BARE_LEGS = dressBit(15), GENIPAP = dressBit(16), RED_FACE = dressBit(17);
export const DRESS_MASK_SCALE = dressBit(18);
export const DRESS_FEATHERS = ONE_FEATHER | MORE_FEATHERS | QUETZAL_PLUMES | FEATHER_CROWN;
export const DRESS_BARE_TORSO = BARE_TORSO;

const DRESS_COTTON = [[.72, .68, .58], [.66, .61, .50], [.58, .52, .40]];
const DRESS_DEERSKIN = [[.44, .31, .18], [.38, .26, .15], [.50, .37, .22]];
const DRESS_WARM_SKIN = [[168, 104, 68], [156, 94, 60], [178, 114, 76], [145, 86, 54], [184, 122, 82], [162, 98, 64]];
const DRESS_DARK_HAIR = [[18, 14, 12], [15, 12, 11], [20, 16, 14], [16, 13, 12], [22, 17, 14]];
const DRESS_FACES = [[1.04, 1.02, .004, .94], [1.05, 1.01, .003, .92], [1.03, 1, .005, .95], [1.06, 1.03, .002, .91], [1.02, .99, .004, .96], [1.04, 1.01, .003, .93]];

// `men` and `women` list everyday looks as [how common, pieces]. `elite` is the few: a cacique, a
// sachem, someone dressed for ceremony. `upper` and `lower` are the colours of their clothes.
export const INDIGENOUS_DRESS = Object.freeze({
  // Eastern Woodlands. Men often shaved the sides around a crest; a feather or two was personal.
  'abenaki-algonquian': {
    upper: DRESS_DEERSKIN, lower: DRESS_DEERSKIN, skin: DRESS_WARM_SKIN,
    men: [[4, ROACH | SHAVED], [4, LOOSE_HAIR], [2, PLAITS], [2, ROACH | SHAVED | ONE_FEATHER], [2, LOOSE_HAIR | BARE_TORSO]],
    women: [[5, PLAITS], [4, LOOSE_HAIR], [1, PLAITS | SHELL_COLLAR]],
    elite: { men: LOOSE_HAIR | HEADBAND | ONE_FEATHER | MORE_FEATHERS | SHELL_COLLAR, women: PLAITS | HEADBAND | SHELL_COLLAR },
  },
  'mid-atlantic-algonquian': {
    upper: DRESS_DEERSKIN, lower: DRESS_DEERSKIN, skin: DRESS_WARM_SKIN,
    men: [[4, ROACH | SHAVED | BARE_TORSO], [3, ROACH | SHAVED | BARE_TORSO | RED_FACE], [3, LOOSE_HAIR | BARE_TORSO], [1, ROACH | SHAVED | ONE_FEATHER]],
    women: [[5, LOOSE_HAIR], [3, PLAITS], [1, LOOSE_HAIR | SHELL_COLLAR]],
    elite: { men: ROACH | SHAVED | BARE_TORSO | RED_FACE | ONE_FEATHER | MORE_FEATHERS | SHELL_COLLAR, women: LOOSE_HAIR | SHELL_COLLAR | HEADBAND },
  },
  // Timucua and their neighbours are remembered for tattooing and for little clothing in the heat.
  'florida-gulf-chiefdoms': {
    upper: [[.34, .36, .24], [.40, .38, .26]], lower: [[.34, .36, .24], [.30, .26, .18], [.40, .38, .26]], skin: DRESS_WARM_SKIN,
    men: [[5, LOOSE_HAIR | BARE_TORSO | BARE_LEGS | GENIPAP], [3, ROACH | BARE_TORSO | BARE_LEGS | GENIPAP], [2, LOOSE_HAIR | BARE_TORSO | BARE_LEGS]],
    women: [[6, LOOSE_HAIR], [2, LOOSE_HAIR | GENIPAP], [1, PLAITS]],
    elite: { men: LOOSE_HAIR | BARE_TORSO | BARE_LEGS | GENIPAP | SHELL_COLLAR | ONE_FEATHER, women: LOOSE_HAIR | GENIPAP | SHELL_COLLAR },
  },
  // Feathers and gold for caciques and ceremonies. Most people dressed for the heat.
  'taino-greater-antilles': {
    upper: DRESS_COTTON, lower: DRESS_COTTON, skin: DRESS_WARM_SKIN,
    men: [[6, LOOSE_HAIR | BARE_TORSO | BARE_LEGS], [3, BARE_TORSO | BARE_LEGS], [1, LOOSE_HAIR | BARE_TORSO | BARE_LEGS | RED_FACE]],
    women: [[7, LOOSE_HAIR], [2, 0]],
    elite: { men: LOOSE_HAIR | BARE_TORSO | BARE_LEGS | GOLD_COLLAR | HEADBAND | ONE_FEATHER | MORE_FEATHERS, women: LOOSE_HAIR | GOLD_COLLAR | HEADBAND },
  },
  // Annatto reddened the skin of the Kalinago, and hair was worn long and bound.
  'kalinago-lesser-antilles': {
    upper: DRESS_COTTON, lower: [[.62, .55, .42], [.48, .26, .14]], skin: [[176, 88, 54], [164, 80, 50], [186, 96, 60], [152, 74, 46]],
    men: [[5, PLAITS | BARE_TORSO | BARE_LEGS], [4, LOOSE_HAIR | BARE_TORSO | BARE_LEGS], [2, LOOSE_HAIR | BARE_TORSO | BARE_LEGS | GENIPAP]],
    women: [[6, LOOSE_HAIR], [3, PLAITS]],
    elite: { men: LOOSE_HAIR | BARE_TORSO | BARE_LEGS | SHELL_COLLAR | HEADBAND | ONE_FEATHER | MORE_FEATHERS, women: LOOSE_HAIR | SHELL_COLLAR },
  },
  // Long quetzal plumes and jade marked the elite in ritual. Most wore plain white cotton.
  'maya-mesoamerica-coast': {
    upper: [[.78, .75, .66], [.74, .70, .60]], lower: [[.78, .75, .66], [.20, .24, .42], [.50, .14, .10]], skin: DRESS_WARM_SKIN,
    men: [[5, PLAITS | BARE_LEGS], [3, PLAITS | BARE_TORSO | BARE_LEGS], [2, BARE_LEGS]],
    women: [[6, PLAITS], [3, LOOSE_HAIR]],
    elite: { men: PLAITS | BARE_LEGS | JADE_COLLAR | HEADBAND | QUETZAL_PLUMES, women: PLAITS | JADE_COLLAR | HEADBAND },
  },
  // Guna, Wayuu, Warao and their neighbours: cotton, long mantas, gold for a chief.
  'tierra-firme-carib-arawak': {
    upper: [[.52, .20, .13], [.20, .30, .36], [.66, .60, .46]], lower: [[.52, .20, .13], [.66, .60, .46], [.20, .30, .36]], skin: DRESS_WARM_SKIN,
    men: [[6, BARE_TORSO | BARE_LEGS], [3, LOOSE_HAIR | BARE_TORSO | BARE_LEGS], [1, PLAITS | BARE_TORSO | BARE_LEGS]],
    women: [[6, LOOSE_HAIR], [3, PLAITS]],
    elite: { men: LOOSE_HAIR | BARE_TORSO | BARE_LEGS | GOLD_COLLAR | HEADBAND | ONE_FEATHER, women: LOOSE_HAIR | GOLD_COLLAR },
  },
  // Daily appearance was body paint, lip plugs and the shaved forehead. Feather crowns were ritual.
  'tupinamba-brazil-guiana': {
    upper: DRESS_COTTON, lower: [[.42, .30, .18], [.34, .22, .13]], skin: DRESS_WARM_SKIN,
    men: [[5, SHAVED_FRONT | LIP_PLUG | BARE_TORSO | BARE_LEGS | GENIPAP], [3, SHAVED_FRONT | LIP_PLUG | BARE_TORSO | BARE_LEGS | GENIPAP | RED_FACE], [2, SHAVED_FRONT | BARE_TORSO | BARE_LEGS]],
    women: [[6, LOOSE_HAIR | GENIPAP], [3, LOOSE_HAIR]],
    elite: { men: SHAVED_FRONT | LIP_PLUG | BARE_TORSO | BARE_LEGS | GENIPAP | RED_FACE | FEATHER_CROWN | SHELL_COLLAR, women: LOOSE_HAIR | GENIPAP | SHELL_COLLAR },
  },
  // Coasts from California to Chile, too many peoples for one look: bark cloth, wool, shell.
  'pacific-indigenous-coast': {
    upper: [[.36, .27, .17], [.46, .36, .22], [.30, .24, .20]], lower: [[.36, .27, .17], [.30, .24, .20]], skin: DRESS_WARM_SKIN,
    men: [[5, LOOSE_HAIR], [3, PLAITS], [2, LOOSE_HAIR | BARE_TORSO]],
    women: [[6, PLAITS], [3, LOOSE_HAIR], [1, PLAITS | SHELL_COLLAR]],
    elite: { men: LOOSE_HAIR | SHELL_COLLAR | HEADBAND, women: PLAITS | SHELL_COLLAR | HEADBAND },
  },
});
// Nothing known of this people, so nothing assumed: plain hair and plain clothes.
const UNKNOWN_DRESS = Object.freeze({
  upper: DRESS_DEERSKIN, lower: DRESS_DEERSKIN, skin: DRESS_WARM_SKIN,
  men: [[1, LOOSE_HAIR], [1, PLAITS], [1, 0]], women: [[1, LOOSE_HAIR], [1, PLAITS]],
  elite: { men: LOOSE_HAIR | SHELL_COLLAR, women: PLAITS | SHELL_COLLAR },
});

const dressLinear = (rgb) => rgb.map((byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
function dressHash(index, salt) {
  let v = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d);
  return ((v ^ (v >>> 13)) >>> 0) / 4294967296;
}
const dressPick = (list, index, salt) => list[Math.floor(dressHash(index, salt) * list.length) % list.length];
function dressWeighted(list, index, salt) {
  let roll = dressHash(index, salt) * list.reduce((sum, [share]) => sum + share, 0);
  for (const [share, pieces] of list) { roll -= share; if (roll <= 0) return pieces; }
  return list[list.length - 1][1];
}
// Roles that dress their rank: a chief at home, a captain at his post.
const DRESS_ELITE_ROLE = /cacique|sachem|halach|behique|noble|speaker|captain/i;

// A person's look. The same culture, sex and index always give the same person.
export function indigenousDress(cultureId, sex, index, { role = '', elite = DRESS_ELITE_ROLE.test(role) } = {}) {
  const dress = INDIGENOUS_DRESS[cultureId] ?? UNKNOWN_DRESS, female = sex === 'female';
  const mask = elite ? (female ? dress.elite.women : dress.elite.men) : dressWeighted(female ? dress.women : dress.men, index, 1);
  const face = dressPick(DRESS_FACES, index, 2);
  return {
    shirt: dressPick(dress.upper, index, 3),
    trousers: dressPick(dress.lower, index, 4),
    skin: dressLinear(dressPick(dress.skin, index, 5)),
    hair: dressLinear(dressPick(DRESS_DARK_HAIR, index, 6)),
    face: [face[0], face[1], face[2], face[3] + 2],
    mask,
    elite,
  };
}
