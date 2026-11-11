// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons lays out a kingdom: its ground, rivers, towns, roads, fields and people. This game takes that
// generator whole (assets/board/game.js is its program, as written) and tunes it to a coast found from the sea. The tuning
// is this table and nothing else: each entry is a passage of the source as it stands and what it becomes. A passage
// that is not found exactly as many times as stated stops the vendoring, so a change upstream is seen, not lost.
//
// What the host sets, read from FURLONG_OPTIONS.board before the program runs:
//   spanMetres  the side of the ground, in metres (the source offers whole kilometres from 4 to 15)
//   seat        how many times the source's capital the seat of this coast is, in people and houses
//   walls       the walls a place of each kind starts with: {capital, town, village} of 0 none, 1 palisade, 2 stone
//   lived       true to found the realm in its early age (850) and let it live every day to the year asked, as the
//               source's own prehistory does, instead of drawing the year asked in one stroke
//   rivers      water fitted to true ground: {catchment, width, least, carve}. The source counts a river's water in
//               cells, each standing for a square kilometre or so of a kingdom; here a cell is some 27 metres of a
//               surveyed coast, and counted so, every gully ran a river. `catchment` is the ground (square metres)
//               that must drain to a point before a watercourse runs there; `width` the metres across it for each
//               root square kilometre drained; `least` its least half-width; `carve` how much of the source's bed
//               is cut into ground whose valleys are already real.
const BOARD = 'globalThis.FURLONG_OPTIONS?.board';

export const BOARD_TUNING = Object.freeze([
  {
    why: 'The ground is as wide as the coast it stands for, to the metre.',
    find: 'const MAPKM=(()=>{const m=/[#&]km=(\\d+)/.exec(WORLD_PARAMS);return m?Math.max(4,Math.min(15,+m[1])):9;})();',
    replace: `const MAPKM=${BOARD}?.spanMetres>0?${BOARD}.spanMetres/1000:(()=>{const m=/[#&]km=(\\d+)/.exec(WORLD_PARAMS);return m?Math.max(4,Math.min(15,+m[1])):9;})();`,
  },
  {
    why: 'The seat is a port city of the sixteenth century, not the capital of a small kingdom: more people.',
    find: "pop:Math.round((2200+randi('gen',700))*PS),minD:0}",
    replace: `pop:Math.round((2200+randi('gen',700))*PS*(${BOARD}?.seat??1)),minD:0}`,
  },
  {
    why: 'And ground enough to house them: its reach grows with the square root of its people.',
    find: 'let R0=saved?saved.R0:isCap?440:isTown?310:170',
    replace: `let R0=saved?saved.R0:isCap?440*Math.sqrt(${BOARD}?.seat??1):isTown?310:170`,
  },
  {
    why: 'And houses in proportion, where the source stops a capital at 620.',
    find: 'isCap?620:isTown?280:48);',
    replace: `isCap?Math.round(620*(${BOARD}?.seat??1)):isTown?280:48);`,
  },
  {
    why: 'The search for who holds what ground kept its costs in single precision and compared them in double, so two ways of the same cost queued a cell twice, and on even ground that compounds without end. Kept in double.',
    find: 'const N=GRID*GRID,cost=new Float32Array(N).fill(Infinity),dom=new Int16Array(N).fill(-1),heap=[];',
    replace: 'const N=GRID*GRID,cost=new Float64Array(N).fill(Infinity),dom=new Int16Array(N).fill(-1),heap=[];',
  },
  {
    why: 'A place may start walled, so the circuits its past would have raised are laid out with it.',
    find: 'prosperity:50,unrest:8,walls:0,',
    replace: `prosperity:50,unrest:8,walls:(${BOARD}?.walls?.[w.kind]??0),`,
  },
  {
    why: 'A watercourse runs where enough true ground drains to it, not where 140 cells of any size do.',
    find: 'const RIVT=140;',
    replace: `const RIVT=Math.max(140,(${BOARD}?.rivers?.catchment??0)/(CELL*CELL));`,
  },
  {
    why: 'Its bed is cut only as deep as ground that already has its valleys needs.',
    find: 'const dep=Math.min(7,2+W.flow[i]*0.004),cx=i%GRID,cz=(i/GRID)|0;',
    replace: `const dep=Math.min(7,2+W.flow[i]*0.004)*(${BOARD}?.rivers?.carve??1),cx=i%GRID,cz=(i/GRID)|0;`,
  },
  {
    why: 'It is as wide as the ground it drains makes it: metres for each root square kilometre.',
    find: 'w:Math.min(40,0.6*Math.sqrt(W.flow[c])),h:W.h[c],c});',
    replace: `w:Math.min(40,(${BOARD}?.rivers?.width>0?${BOARD}.rivers.width*CELL/1000:0.6)*Math.sqrt(W.flow[c])),h:W.h[c],c});`,
  },
  {
    why: 'And a brook may be narrower than the eight metres the source gives its least river.',
    find: 'const hw0=pts.map((p,k)=>Math.max(4,(p.w||10)/2)*Math.min(1,0.35+k/14)),',
    replace: `const hw0=pts.map((p,k)=>Math.max(${BOARD}?.rivers?.least??4,(p.w||10)/2)*Math.min(1,0.35+k/14)),`,
  },
  {
    why: 'A realm may be founded early and lived forward to the year asked, where the source starts any later age direct.',
    find: 'directEra=START_AD>FOUNDING_AD;',
    replace: `directEra=START_AD>FOUNDING_AD&&!${BOARD}?.lived;`,
  },
]);

// The source's program with the table applied.
export function tuneBoardSource(source) {
  let tuned = source;
  for (const { find, replace, count = 1 } of BOARD_TUNING) {
    const found = tuned.split(find).length - 1;
    if (found !== count) throw new Error(`Castle and Commons has changed: found ${found} of ${count} of "${find.slice(0, 70)}"`);
    tuned = tuned.split(find).join(replace);
  }
  return tuned;
}
