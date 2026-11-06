// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the guns have done near a town since the last frame, as the short list the walkers' compute pass reads:
// each ball's path over the frame, where a ball stopped, and masonry coming down. It says nothing about people. Who
// is struck and who runs is the GPU's to find, since only the GPU knows where anyone is.
import { TOWN_SHOT_LIMIT, TOWN_SHOT_WORDS } from './wgsl/townsfolk.js';

export const TOWN_SHOTS_WORDS = 4 + TOWN_SHOT_LIMIT * TOWN_SHOT_WORDS;
const BODY_RADIUS_M = 0.3;
// Below this a ball rolls off someone. The same as for soldiers, in strikeSoldierWithBall.
const LEAST_STRIKING_JOULES = 200;
const PASSING_REACH_M = 10;
const OUTSIDE_TOWN_M = 60;
// Round shot does not burst, but what it throws up does the same work near where it lands: stones, splinters, shock.
const LANDING_BLAST_M = Object.freeze({ least: 1.2, perRootMegajoule: 1.6, most: 4 });
const LANDING_REACH_M = Object.freeze({ least: 16, perRootMegajoule: 17, most: 50 });
const RUBBLE_BLAST_M = Object.freeze({ least: 3, perRootPiece: 0.6, most: 12 });
const RUBBLE_REACH_M = Object.freeze({ least: 28, perRootPiece: 3, most: 70 });
const MAGAZINE_BLAST_M = 22;
const MAGAZINE_REACH_M = 160;
const PIECES_LOCATED = 32;
// How long a building is watched for what comes down after it was last hit or last lost anything.
const WATCH_FRAMES = 600;

const within = (range, scale) => Math.min(range.most, range.least + scale);

export function createTownShots(streets) {
  const { x: townX, z: townZ, span } = streets.window;
  const townRadius = span * Math.SQRT1_2 + OUTSIDE_TOWN_M;
  const flights = new Map(), landings = [], watched = new Map();
  let serial = 0;
  const nextSeed = () => (serial = serial % 997 + 1);
  const burst = (x, y, z, blast, reach) => {
    if (landings.length < TOWN_SHOT_LIMIT) landings.push({ start: [x, y, z], end: [x, y, z], strike: 0, blast, reach, seed: nextSeed() });
  };
  // What came down from a building since the last look, in one place, at the foot of where it is coming from.
  const comeDown = (state, pieces) => {
    const { fracture, flying } = state;
    let x = 0, y = 0, z = 0, count = 0;
    for (const index of flying) {
      const shard = fracture?.shards?.[index];
      if (!shard) continue;
      x += shard.localMin[0] + shard.localMax[0]; y += shard.localMin[1] + shard.localMax[1]; z += shard.localMin[2] + shard.localMax[2];
      if (++count >= PIECES_LOCATED) break;
    }
    if (!count) return;
    const at = fracture.toWorld(x / (2 * count), y / (2 * count), z / (2 * count)), root = Math.sqrt(pieces);
    burst(at[0], fracture.groundAt(at[0], at[2]), at[2], within(RUBBLE_BLAST_M, root * RUBBLE_BLAST_M.perRootPiece), within(RUBBLE_REACH_M, root * RUBBLE_REACH_M.perRootPiece));
  };
  const lookAtBuildings = () => {
    for (const [building, seen] of watched) {
      const damage = building.damageState, state = damage?.fracture, broken = state?.brokenCount ?? 0;
      if (broken > seen.broken) {
        // Nothing in the air means a saved ruin coming back, not anything falling now.
        if (state.flying?.size) comeDown(state, broken - seen.broken);
        seen.broken = broken;
        seen.quiet = 0;
      }
      if (damage?.magazineExploded && !seen.blown) {
        seen.blown = true;
        burst(building.x ?? 0, building.y ?? 0, building.z ?? 0, MAGAZINE_BLAST_M, MAGAZINE_REACH_M);
      }
      if (++seen.quiet > WATCH_FRAMES) watched.delete(building);
    }
  };
  return {
    // One step of one ball's flight. Steps are far shorter than a frame, and a frame's worth is one straight line.
    note(from, to, hit, projectile) {
      const midX = (from[0] + to[0]) * 0.5 - townX, midZ = (from[2] + to[2]) * 0.5 - townZ;
      if (midX * midX + midZ * midZ > townRadius * townRadius) return;
      const v = projectile.velocity ?? [0, 0, 0], joules = 0.5 * (projectile.mass ?? 1) * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      const f = hit ? Math.max(0, Math.min(1, hit.fraction)) : 1;
      const end = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f];
      const flight = flights.get(projectile);
      if (flight) flight.end = end;
      else {
        const strike = joules >= LEAST_STRIKING_JOULES ? (projectile.sweepRadius ?? projectile.radius ?? 0.08) + BODY_RADIUS_M : 0;
        flights.set(projectile, { start: [from[0], from[1], from[2]], end, strike, blast: 0, reach: PASSING_REACH_M, seed: (projectile.townSeed ??= nextSeed()) });
      }
      if (!hit) return;
      const root = Math.sqrt(joules / 1e6);
      burst(end[0], end[1], end[2], within(LANDING_BLAST_M, root * LANDING_BLAST_M.perRootMegajoule), within(LANDING_REACH_M, root * LANDING_REACH_M.perRootMegajoule));
      const building = hit.building;
      if (building) {
        const seen = watched.get(building);
        if (seen) seen.quiet = 0;
        else watched.set(building, { broken: building.damageState?.fracture?.brokenCount ?? 0, blown: Boolean(building.damageState?.magazineExploded), quiet: 0 });
      }
    },
    // Writes the list as a uniform block and empties it, returning how many it holds. Landings first: when a great
    // many balls fly at once, a few of them are the ones not looked for.
    collect(words, floats) {
      if (watched.size) lookAtBuildings();
      let count = 0;
      const put = ({ start, end, strike, blast, reach, seed }) => {
        if (count >= TOWN_SHOT_LIMIT) return;
        const at = 4 + count++ * TOWN_SHOT_WORDS;
        floats[at] = start[0]; floats[at + 1] = start[1]; floats[at + 2] = start[2]; floats[at + 3] = strike;
        floats[at + 4] = end[0]; floats[at + 5] = end[1]; floats[at + 6] = end[2]; floats[at + 7] = blast;
        floats[at + 8] = reach; floats[at + 9] = seed;
      };
      for (const landing of landings) put(landing);
      for (const flight of flights.values()) put(flight);
      landings.length = 0;
      flights.clear();
      words[0] = count;
      return count;
    },
  };
}
