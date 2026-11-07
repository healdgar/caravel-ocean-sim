// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Where a body can stand on each ship, read from the mesh that is drawn and written to js/models/crew-deck-masks.js:
// real floor at the height the crew walk on, and nothing solid from the knee to the head.
//   node scripts/bake-crew-deck.mjs [--check]
// With --check it writes nothing, and fails if the masks have drifted from the mesh. tests/crew-traffic.test.mjs does too.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { floorBeneath, loadShip, PART, SHIP_IDS } from './model-audit-lib.mjs';
import { CREW_DECK_CELL_M, crewDeckEncode } from '../js/crew-deck.js';
import { crewDeckHeight } from '../js/crew-work.js';
import { modelDeckWidth } from '../js/hull.js';

// A coaming or a thwart is stepped over, and a boot goes a little under an overhang.
const KNEE_M = 0.25, HEAD_M = 1.7, FLOOR_TOLERANCE_M = 0.14, STEP_M = 0.1, SAMPLE_M = 0.04;

export function bakeCrewDeckMask(id) {
  const ship = loadShip(id), boat = ship.boat(), s = ship.scale, indices = ship.asset.indices, pos = ship.positions;
  const halfX = boat.beam / 2 + CREW_DECK_CELL_M, halfZ = boat.length / 2 + 1, nx = Math.ceil(2 * halfX / CREW_DECK_CELL_M), nz = Math.ceil(2 * halfZ / CREW_DECK_CELL_M);
  const deck = new Float32Array(nx * nz).fill(NaN), open = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const X = -halfX + (i + 0.5) * CREW_DECK_CELL_M, Z = -halfZ + (j + 0.5) * CREW_DECK_CELL_M, xd = X / s[0], zd = Z / s[2];
    let half, y;
    try { half = modelDeckWidth(boat, zd) * s[0]; y = crewDeckHeight(boat, zd, xd) * s[1]; } catch { continue; }
    if (!(half > 0) || !Number.isFinite(y) || Math.abs(X) > half) continue;
    deck[j * nx + i] = y;
    const floor = floorBeneath(ship, X, y + 0.5, Z, y);
    open[j * nx + i] = floor && Math.abs(y - floor.y) < FLOOR_TOLERANCE_M ? 1 : 0;
  }
  // What stands on that floor. Rope is no wall, and a line drawn in fitting material is still a line.
  const mask = PART.hull | PART.mast | PART.gun;
  for (let t = 0; t < indices.length / 3; t++) {
    if (!(ship.partOf[t] & mask) || ship.isLine(t)) continue;
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const longest = Math.max(Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]), Math.hypot(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]), Math.hypot(pos[c] - pos[b], pos[c + 1] - pos[b + 1], pos[c + 2] - pos[b + 2]));
    const n = Math.max(1, Math.ceil(longest / SAMPLE_M));
    for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
      const w = n - u - v, x = (pos[a] * u + pos[b] * v + pos[c] * w) / n, y = (pos[a + 1] * u + pos[b + 1] * v + pos[c + 1] * w) / n, z = (pos[a + 2] * u + pos[b + 2] * v + pos[c + 2] * w) / n;
      const i = Math.floor((x + halfX) / CREW_DECK_CELL_M), j = Math.floor((z + halfZ) / CREW_DECK_CELL_M);
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const height = y - deck[j * nx + i];
      if (height > KNEE_M && height < HEAD_M) open[j * nx + i] = 0;
    }
  }
  // A step in the deck is an edge to whoever is not on a stair.
  const stepped = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const here = deck[j * nx + i];
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (i + di >= nx || j + dj >= nz) continue;
      const there = deck[(j + dj) * nx + i + di];
      if (Math.abs(here - there) > STEP_M) { stepped[j * nx + i] = 1; stepped[(j + dj) * nx + i + di] = 1; }
    }
  }
  for (let k = 0; k < open.length; k++) if (stepped[k]) open[k] = 0;
  return { x0: -halfX / s[0], z0: -halfZ / s[2], dx: CREW_DECK_CELL_M / s[0], dz: CREW_DECK_CELL_M / s[2], nx, nz, open };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check'), target = new URL('../js/models/crew-deck-masks.js', import.meta.url);
  const rows = [];
  for (const id of SHIP_IDS) {
    const { open, ...grid } = bakeCrewDeckMask(id);
    rows.push(`  ${JSON.stringify(id)}: {x0:${grid.x0},z0:${grid.z0},dx:${grid.dx},dz:${grid.dz},nx:${grid.nx},nz:${grid.nz},runs:${JSON.stringify(crewDeckEncode(open))}},`);
    console.log(`${id}: ${grid.nx}x${grid.nz}, ${open.reduce((sum, v) => sum + v, 0)} open cells, ${rows.at(-1).length} bytes`);
  }
  const text = `// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.\n// Written by scripts/bake-crew-deck.mjs from the mesh each ship draws. Do not edit.\nexport const CREW_DECK_MASKS=Object.freeze({\n${rows.join('\n')}\n});\n`;
  if (!check) writeFileSync(target, text);
}
