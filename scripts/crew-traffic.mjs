// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How sailors get past each other: the numbers, ship by ship, with no GPU and no window.
//   node scripts/crew-traffic.mjs [--ships=nina,victory] [--scenes=watch,sail,guns] [--json=out.json]
// For a watch, a sail order and a gun drill it counts how often two bodies overlap, how long sailors stand blocked,
// how much slower a trip is than with nobody else aboard, how far the feet slide, and the simulation's own cost.
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadCrewGLB } from '../js/gltf.js';
import { createCompany, stepCompany, issueCaptainOrder } from '../js/crew.js';
import { crewDeckHeight } from '../js/crew-work.js';
import { crewMotionPolicy } from '../js/crew-motion.js';
import { advanceSails, sailingState, sailCanvasTarget } from '../js/sailing.js';
import { requirePlayableShipModel } from '../js/ship-models.js';
import { vesselVerticalScale } from '../js/hull.js';
import { createGunDefinitions, gunMuzzlePose } from '../js/gunnery-models.js';
import { createGunneryState, prepareGunnery, fireGunnery, gunnerySummary, stepGunnery } from '../js/gunnery-state.js';

export const TRAFFIC_SHIPS = ['nina', 'victory', 'santa-maria', 'oseberg'];
export const TRAFFIC_SCENES = ['watch', 'sail', 'guns'];
// Real bodies, measured from the sailor meshes in their walk: a torso about 0.48 m across and 0.38 m deep from above, with
// arms outside that. Two bodies overlap when these ellipses do, as each is standing, turned shoulders and all. Deep is by
// more than a tenth of the distance, which is one body in another rather than a graze.
const HALF_WIDTH = 0.24, HALF_DEPTH = 0.19, DEEP = 0.1;
const halfAlong = (s, dx, dz) => {
  const yaw = (s.yaw ?? 0) + (s.shoulderTurn ?? 0), length = Math.hypot(dx, dz) || 1, along = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / length, across = (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / length;
  return Math.hypot(HALF_WIDTH * across, HALF_DEPTH * along);
};
const WALKING = new Set(['approach', 'return', 'reposition', 'lookout-approach', 'lookout-return', 'traffic-yield']);
const WIND = 6, FRAME = 1 / 30;

export function trafficBoat(id, extra = {}) {
  const model = requirePlayableShipModel(id);
  return { modelId: id, model, ...model.runtime, x: 0, z: 0, heading: 0, heave: 0, pitch: 0, roll: 0, rollVelocity: 0, rudder: 0, sailFore: 1, sailMain: 1, sailMizzen: 1, crew: false, showProw: true, hatchesClosed: 0, ...extra };
}
const pathMetres = (s, path, boat) => {
  const scale = [boat.beam / 3.6, vesselVerticalScale(boat), boat.length / 12];
  let last = [s.position[0], s.position[1] - 0.028, s.position[2]], seconds = 0, length = 0;
  for (const p of path ?? []) {
    const q = p.map((v, i) => v * scale[i]), run = Math.hypot(q[0] - last[0], q[2] - last[2]), rise = q[1] - last[1], d = Math.hypot(run, rise);
    if (d > 1e-6) {
      seconds += d / crewMotionPolicy(boat, { purpose: 'work', grade: run > 1e-8 ? rise / run : 0 }).speedMetresPerSecond;
      length += d;
    }
    last = q;
  }
  return { seconds, length };
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

// What the feet really do: the walk clip through each body's transform, frame to frame, for whichever boot is down.
// A boot that is down should not move over the deck. A body's yaw snapping round moves it as surely as walking crabwise.
const crewMeshes = {};
function footAnimator(sex) {
  const file = sex === 'female' ? 'sailor-female.glb' : 'sailor.glb';
  return (crewMeshes[file] ??= loadCrewGLB(readFileSync(new URL('../assets/crew/' + file, import.meta.url)))).animator;
}
function feetOf(s) {
  const a = footAnimator(s.sex), m = s.transform;
  a.sample('Idle', s.time ?? 0, 'Walk', s.walkTime ?? 0, s.walk ?? 0);
  const at = (name) => { const w = a.world[a.nodeIndex(name)]; return [m[0] * w[12] + m[4] * w[13] + m[8] * w[14] + m[12], m[1] * w[12] + m[5] * w[13] + m[9] * w[14] + m[13], m[2] * w[12] + m[6] * w[13] + m[10] * w[14] + m[14]]; };
  return { l: at('foot_l'), r: at('foot_r') };
}

// One running tally for a company, read once per frame.
export function createTrafficTally(company, boat, { feet = false } = {}) {
  const pairs = new Map(), people = company.crew.map((s) => ({ s, x: s.position[0], y: s.position[1], z: s.position[2], yaw: s.yaw, walkDistance: s.walkDistance ?? 0, trip: null, stop: 0, feet: null }));
  const t = { frames: 0, seconds: 0, touchEvents: 0, throughEvents: 0, touchSeconds: 0, throughSeconds: 0, closest: Infinity, walkingSeconds: 0, blockedSeconds: 0, workWalking: 0, workBlocked: 0, longestStop: 0, trips: [], unfinished: 0, slip: [], yawPops: 0, offDeck: 0, worstPair: null, slide: [] };
  const end = (who, reason) => {
    const trip = who.trip;
    if (!trip) return;
    who.trip = null;
    if (reason === 'unfinished') { t.unfinished++; return; }
    if (trip.free > 1.5) t.trips.push({ id: who.s.id, kind: trip.kind, free: trip.free, took: t.seconds - trip.start, ratio: (t.seconds - trip.start) / trip.free });
  };
  return {
    tally: t,
    read(dt) {
      t.frames++; t.seconds += dt;
      for (const who of people) {
        const s = who.s, j = s.job, moved = Math.hypot(s.position[0] - who.x, s.position[1] - who.y, s.position[2] - who.z);
        const walking = !s.overboard && !s.aloftFall && s.casualtyState !== 'fallen' && ((j && WALKING.has(j.stage) && s.intent === 'work' && !s.observation.hazard) || (!j && s.intent === 'patrol' && s.navigationPath?.length && s.wait <= 0 && !(s.route && s.route[0] === s.route[1])));
        if (walking) {
          t.walkingSeconds += dt;
          if (j) t.workWalking += dt;
          // Turning on the spot to set off is not being in anyone's way.
          const turning = Math.abs(Math.atan2(Math.sin(s.yaw - who.yaw), Math.cos(s.yaw - who.yaw))) > 1e-3;
          if (moved < 0.0005 && !turning) { t.blockedSeconds += dt; if (j) t.workBlocked += dt; who.stop += dt; t.longestStop = Math.max(t.longestStop, who.stop); } else who.stop = 0;
        } else who.stop = 0;
        // A trip runs from when he sets off to when he is there, whatever detours it takes on the way.
        const key = j && WALKING.has(j.stage) ? j : !j && s.navigationPath?.length ? s.navigationPath : null;
        const stageKey = j ? j.stage : 'patrol';
        if (who.trip && (who.trip.key !== key && !(j && who.trip.key === j) || who.trip.stage !== stageKey)) end(who);
        if (!who.trip && key && walking) {
          const free = j ? pathMetres(s, j.path.slice(j.cursor), boat).seconds : pathMetres(s, s.navigationPath.slice(s.navigationCursor ?? 0), boat).seconds * 1.75 / 1.25;
          who.trip = { key, stage: stageKey, start: t.seconds, free, kind: j ? j.kind + '/' + j.stage : 'patrol' };
        }
        if (feet && dt > 0) {
          if (walking && s.walk > 0.5) {
            const now = feetOf(s), down = now.l[1] < now.r[1] ? 'l' : 'r';
            if (who.feet && who.feet.down === down && Math.abs(now.l[1] - now.r[1]) > 0.02) t.slide.push(Math.hypot(now[down][0] - who.feet[down][0], now[down][2] - who.feet[down][2]) / dt);
            who.feet = { ...now, down };
          } else who.feet = null;
        }
        // What the feet do: the walk clip carries them forward along his yaw, by the distance he has been credited with.
        const walked = (s.walkDistance ?? 0) - who.walkDistance;
        if (moved > 1e-4 && moved < 0.5 && dt > 0 && s.walk > 0.3) {
          const vx = (s.position[0] - who.x) / dt, vz = (s.position[2] - who.z) / dt, fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), rate = walked / dt;
          t.slip.push(Math.hypot(vx - fx * rate, vz - fz * rate));
          const turn = Math.abs(Math.atan2(Math.sin(s.yaw - who.yaw), Math.cos(s.yaw - who.yaw)));
          if (turn > 0.35) t.yawPops++;
        }
        who.x = s.position[0]; who.y = s.position[1]; who.z = s.position[2]; who.yaw = s.yaw; who.walkDistance = s.walkDistance ?? 0;
      }
      for (let a = 0; a < people.length; a++) {
        const A = people[a].s;
        if (A.overboard || A.casualtyState === 'fallen') continue;
        for (let b = 0; b < a; b++) {
          const B = people[b].s;
          if (B.overboard || B.casualtyState === 'fallen' || Math.abs(A.position[1] - B.position[1]) > 0.25) continue;
          const dx = B.position[0] - A.position[0], dz = B.position[2] - A.position[2], d = Math.hypot(dx, dz), key = a * 4096 + b, state = pairs.get(key) ?? 0, touch = halfAlong(A, dx, dz) + halfAlong(B, dx, dz);
          if (d < t.closest) { t.closest = d; t.worstPair = [A.id, B.id, A.job?.stage ?? 'idle', B.job?.stage ?? 'idle']; }
          const next = d < touch - DEEP ? 2 : d < touch ? 1 : 0;
          if (next >= 1 && state < 1) t.touchEvents++;
          if (next >= 2 && state < 2) t.throughEvents++;
          if (next >= 1) t.touchSeconds += dt;
          if (next >= 2) t.throughSeconds += dt;
          if (next !== state) pairs.set(key, next);
        }
      }
    },
    finish() { for (const who of people) if (who.trip) end(who, 'unfinished'); return t; },
  };
}

function gunFixture(boat, side = 'port') {
  boat.gunnery = createGunneryState(createGunDefinitions(boat));
  boat.gunnerySide = side;
  prepareGunnery(boat.gunnery, side);
  return { muzzle: (g) => gunMuzzlePose(g, boat), gunAttended: (g) => !g.visibleCrew || boat.gunneryAttendance?.has(g.id) };
}
const allSet = (company, boat) => !company.pending && !company.crew.some((s) => s.job && !['lookout'].includes(s.job.kind));

// Runs one scene. keep filters the company first, which is how a clear deck is had: only those the order needs.
export function runScene(id, scene, { keep = null, dt = FRAME, seconds = 180, fullWatch = true, inspect = null, feet = false } = {}) {
  const boat = trafficBoat(id, scene === 'sail' ? {} : {});
  const company = createCompany(undefined, id, { fullWatch });
  if (keep) company.crew = company.crew.filter(keep);
  sailingState(boat);
  stepCompany(company, boat, 0, WIND);
  if (boat.modelId === 'oseberg' || requirePlayableShipModel(id).geometry === 'rowing-procedural-v1') boat.rowingState = { phase: 0.22, rate: 0.45, effortPort: 0.6, effortStarboard: 0.6, cadence: 0.45 };
  const tally = createTrafficTally(company, boat, { feet }), workers = new Set();
  let environment = null, orderAt = null, finishedAt = null, drillReadyAt = null, stepMs = 0, steps = 0, stage = 0, lastArrival = 0;
  const frames = Math.round(seconds / dt);
  if (scene === 'sail') {
    if (!issueCaptainOrder(company, boat, 'reduced')) return null;
    orderAt = 0;
  } else if (scene === 'guns') {
    if (!createGunDefinitions(boat).some((g) => g.weatherDeck && !g.abstractCrew)) return null;
    environment = gunFixture(boat);
    orderAt = 0;
  }
  for (let frame = 0; frame < frames; frame++) {
    const at = frame * dt;
    advanceSails(boat, dt, WIND, 0);
    const before = performance.now();
    stepCompany(company, boat, dt, WIND);
    stepMs += performance.now() - before; steps++;
    if (environment) stepGunnery(boat.gunnery, dt, environment);
    tally.read(dt);
    inspect?.(company, boat, at);
    for (const s of company.crew) if (s.job && s.job.kind !== 'lookout') workers.add(s.id);
    const hands = company.crew.filter((s) => s.job && s.job.kind !== 'lookout');
    if (hands.some((s) => s.job.stage === 'approach' && s.job.kind !== 'yield')) lastArrival = at;
    if (scene === 'sail') {
      if (stage === 0 && at > 1 && allSet(company, boat)) { finishedAt = at; stage = 1; }
      if (stage === 1) break;
    } else if (scene === 'guns') {
      const summary = gunnerySummary(boat.gunnery, 'port');
      if (stage === 0 && summary.ready === summary.total && summary.total > 0) { drillReadyAt = at; fireGunnery(boat.gunnery, 'port'); stage = 1; }
      else if (stage === 1 && at > drillReadyAt + 6) { prepareGunnery(boat.gunnery, 'port'); stage = 2; }
      else if (stage === 2 && summary.ready === summary.total) { finishedAt = at; stage = 3; fireGunnery(boat.gunnery, 'port'); }
      else if (stage === 3 && at > finishedAt + 8) { boat.gunnery.guns.forEach((g) => { g.loading = false; g.queued = false; g.stage = 'empty'; }); stage = 4; }
      else if (stage === 4 && !company.crew.some((s) => s.job?.kind === 'gunnery')) { finishedAt = at; break; }
    }
  }
  const t = tally.finish(), minutes = t.seconds / 60, ratios = t.trips.map((r) => r.ratio);
  const work = t.trips.filter((r) => r.kind !== 'patrol'), workRatios = work.map((r) => r.ratio), rounds = t.trips.filter((r) => r.kind === 'patrol').map((r) => r.ratio), mean = (v) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  return {
    ship: id, scene, crew: company.crew.length, seconds: +t.seconds.toFixed(1), musterAt: +lastArrival.toFixed(1), finishedAt: finishedAt === null ? null : +finishedAt.toFixed(1), drillReadyAt: drillReadyAt === null ? null : +drillReadyAt.toFixed(1), workers: [...workers], tripLog: work.map((r) => ({ who: r.id, kind: r.kind, free: +r.free.toFixed(1), took: +r.took.toFixed(1) })),
    touchPerMin: +(t.touchEvents / minutes).toFixed(1), throughPerMin: +(t.throughEvents / minutes).toFixed(2), touchSecPerMin: +(t.touchSeconds / minutes).toFixed(2), throughSecPerMin: +(t.throughSeconds / minutes).toFixed(2), closest: +t.closest.toFixed(3), worstPair: t.worstPair,
    walkingSeconds: +t.walkingSeconds.toFixed(0), blockedShare: +(t.blockedSeconds / Math.max(1e-6, t.walkingSeconds)).toFixed(3), workBlockedShare: +(t.workBlocked / Math.max(1e-6, t.workWalking)).toFixed(3), blockedSeconds: +t.blockedSeconds.toFixed(1), longestStop: +t.longestStop.toFixed(1),
    trips: t.trips.length, unfinished: t.unfinished, workTrips: work.length, workTripRatio: +mean(workRatios).toFixed(2), workTripP95: +percentile(workRatios, 0.95).toFixed(2), workTripMax: +Math.max(0, ...workRatios).toFixed(1), roundTrips: rounds.length, roundRatio: +mean(rounds).toFixed(2),
    slipMean: +(t.slip.reduce((a, b) => a + b, 0) / Math.max(1, t.slip.length)).toFixed(3), slipP95: +percentile(t.slip, 0.95).toFixed(3), yawPopsPerMin: +(t.yawPops / minutes).toFixed(1), footSlideMean: +(t.slide.reduce((a, b) => a + b, 0) / Math.max(1, t.slide.length)).toFixed(3), footSlideP95: +percentile(t.slide, 0.95).toFixed(3), footSlideP99: +percentile(t.slide, 0.99).toFixed(3), stepMs: +(stepMs / Math.max(1, steps)).toFixed(3),
  };
}

// How far two bodies go into each other, as each stands. Above zero they touch, and above DEEP one is in the other.
export function bodiesOverlap(a, b) {
  if (Math.abs(a.position[1] - b.position[1]) > 0.25) return -Infinity;
  const dx = b.position[0] - a.position[0], dz = b.position[2] - a.position[2];
  return halfAlong(a, dx, dz) + halfAlong(b, dx, dz) - Math.hypot(dx, dz);
}
export const BODY_DEEP_M = DEEP;
// Sailors sent along lanes of their own, in metres on the deck, with nobody else aboard unless asked. Each lane is [[x,z],[x,z],...].
export function stageWalkers(id, lanes, { stage = 'return', others = false, boatExtra = {} } = {}) {
  const boat = trafficBoat(id, boatExtra), company = createCompany(undefined, id, others ? { fullWatch: true } : {}), sx = boat.beam / 3.6, sz = boat.length / 12, sy = vesselVerticalScale(boat);
  sailingState(boat);
  const able = company.crew.filter((s) => s.role !== 'Helmsman' && !s.seatedPose), walkers = lanes.map((_, i) => able[i]);
  if (!others) company.crew = walkers.slice();
  const floor = (s, x, z) => crewDeckHeight(boat, z / sz, x / sx);
  walkers.forEach((s, i) => {
    const lane = lanes[i], path = lane.slice(1).map(([x, z]) => [x / sx, floor(s, x, z), z / sz]), [x, z] = lane[0];
    s.x = x / sx; s.z = z / sz; s.home = [lane.at(-1)[0] / sx, lane.at(-1)[1] / sz]; s.wait = 0; s.intent = 'work'; s.decisionIn = 1;
    s.position.set([x, floor(s, x, z) * sy + 0.028, z]);
    s.yaw = Math.atan2(lane[1][0] - x, lane[1][1] - z);
    s.job = { kind: 'haul', mast: 0, stage: Array.isArray(stage) ? stage[i] : stage, path, cursor: 0, position: [x / sx, floor(s, x, z), z / sz], elapsed: 0, rung: 0, revision: company.revision };
  });
  return { boat, company, walkers };
}
export function isWalking(s) { return Boolean(s.job && WALKING.has(s.job.stage)); }

// A crowded order against the same order with only those it needs aboard.
export function clearDeckOrder(id) {
  const crowded = runScene(id, 'sail');
  if (!crowded) return null;
  const needed = new Set(crowded.workers), clear = runScene(id, 'sail', { keep: (s) => needed.has(s.id) });
  return { ship: id, crowded: crowded.finishedAt, clear: clear.finishedAt, ratio: crowded.finishedAt && clear.finishedAt ? +(crowded.finishedAt / clear.finishedAt).toFixed(2) : null, musterCrowded: crowded.musterAt, musterClear: clear.musterAt, workers: needed.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const ships = option('ships')?.split(',') ?? TRAFFIC_SHIPS, scenes = option('scenes')?.split(',') ?? TRAFFIC_SCENES, rows = [], orders = [];
  for (const id of ships) {
    for (const scene of scenes) {
      const row = runScene(id, scene, { feet: true });
      if (!row) { console.log(`${id} ${scene}: not this ship`); continue; }
      rows.push(row);
      console.log(`${id.padEnd(12)} ${scene.padEnd(6)} crew ${row.crew}  ${row.seconds}s done ${row.finishedAt}  touch/min ${row.touchPerMin} through/min ${row.throughPerMin} (${row.throughSecPerMin}s/min) closest ${row.closest}  blocked ${(row.blockedShare * 100).toFixed(1)}% at work ${(row.workBlockedShare * 100).toFixed(1)}% longest ${row.longestStop}s  work trips ${row.workTrips}+${row.unfinished} ratio ${row.workTripRatio} p95 ${row.workTripP95} max ${row.workTripMax} rounds ${row.roundTrips} ratio ${row.roundRatio}  feet ${row.footSlideMean}/${row.footSlideP95}/${row.footSlideP99} m/s pops/min ${row.yawPopsPerMin}  ${row.stepMs} ms`);
    }
    if (scenes.includes('sail')) { const order = clearDeckOrder(id); if (order) { orders.push(order); console.log(`${id.padEnd(12)} order crowded ${order.crowded}s clear ${order.clear}s ratio ${order.ratio}, all at work by ${order.musterCrowded}s against ${order.musterClear}s (${order.workers} workers)`); } }
  }
  const out = option('json');
  if (out) writeFileSync(out, JSON.stringify({ rows, orders }, null, 1));
}
