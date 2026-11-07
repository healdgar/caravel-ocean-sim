// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Sailors getting past each other: no walking through, no standing nose to nose, nobody over the side or through a gap.
// The harness and its numbers are scripts/crew-traffic.mjs, which is also how the baseline in CREW.md was measured.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BODY_DEEP_M, bodiesOverlap, clearDeckOrder, isWalking, runScene, stageWalkers } from '../scripts/crew-traffic.mjs';
import { createCompany, stepCompany } from '../js/crew.js';
import { crewOpenEdgeInset } from '../js/crew-overboard.js';
import { crewNavigationClear } from '../js/crew-navigation.js';
import { modelDeckWidth, vesselVerticalScale } from '../js/hull.js';
import { sailingState } from '../js/sailing.js';
import { applyFractureEvents, shipFractureStateOf } from '../js/ship-fracture.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { createVesselDamageState } from '../js/gunnery-control.js';
import { modelDeck } from '../js/hull.js';

const FRAME = 1 / 30, WIND = 6, assets = createShipAssetCache();
// A length of her bulwark really shot away, by the fracture tables a shot would use.
function openRail(boat, side, minZ, maxZ) {
  const { fracture } = assets.get(boat.modelId), events = [];
  for (const shard of fracture.strikable) {
    const [x, y, z] = fracture.shards[shard].centroid;
    if (Math.sign(x) === side && z >= minZ && z <= maxZ && y > modelDeck(boat, z) - 0.2) events.push({ x, y, z, side, severity: 2, stepDepth: 0.4 });
  }
  for (let pass = 0; pass < 3; pass++) applyFractureEvents(fracture, boat.damage, events, 0);
  shipFractureStateOf(boat.damage, fracture);
}

// Everyone along their lanes to the end, or until the time runs out, with what happened on the way.
function walkLanes({ boat, company, walkers }, seconds) {
  const seen = { deepest: -Infinity, longestStop: 0, frames: 0, finished: 0, stops: new Map(), offDeck: [], turned: 0 };
  const last = new Map(walkers.map((s) => [s, Array.from(s.position)]));
  let at = 0;
  for (; at < seconds; at += FRAME) {
    stepCompany(company, boat, FRAME, WIND);
    seen.frames++;
    for (const s of walkers) {
      const before = last.get(s), moved = Math.hypot(s.position[0] - before[0], s.position[2] - before[2]);
      last.set(s, Array.from(s.position));
      if (isWalking(s)) {
        const stopped = moved < 5e-4 ? (seen.stops.get(s) ?? 0) + FRAME : 0;
        seen.stops.set(s, stopped);
        seen.longestStop = Math.max(seen.longestStop, stopped);
      }
      if (Math.abs(s.shoulderTurn ?? 0) > 0.05) seen.turned++;
      // A level deck is as far as a body goes: clear of everything a route keeps clear of, wherever passing took him.
      const y = s.job?.position?.[1] ?? null;
      if (y !== null && isWalking(s) && !crewNavigationClear([s.position[0], s.position[1] - 0.028, s.position[2]], boat)) seen.offDeck.push([s.id, ...Array.from(s.position).map((v) => +v.toFixed(2))]);
    }
    for (let i = 0; i < company.crew.length; i++) for (let k = 0; k < i; k++) seen.deepest = Math.max(seen.deepest, bodiesOverlap(company.crew[i], company.crew[k]));
    if (!walkers.some(isWalking)) break;
  }
  seen.seconds = at;
  seen.finished = walkers.filter((s) => !isWalking(s)).length;
  return seen;
}
const laneSeconds = (lane, speed = 1.75) => lane.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - lane[i][0], p[1] - lane[i][1]), 0) / speed;
const reversed = (lane) => lane.slice().reverse();

test('two sailors meet head-on in the Nina\'s waist and neither stops', () => {
  const lane = [[0.6, -1.2], [0.6, 3.0]], stage = stageWalkers('nina', [lane, reversed(lane)]), seen = walkLanes(stage, laneSeconds(lane) + 6);
  assert.equal(seen.finished, 2, 'both get there');
  assert.ok(seen.deepest < BODY_DEEP_M, `no walking through: ${seen.deepest}`);
  assert.ok(seen.longestStop < 0.2, `neither stands waiting on an open deck: ${seen.longestStop}`);
  assert.ok(seen.seconds < laneSeconds(lane) * 1.2 + 0.5, `about the time it takes alone: ${seen.seconds} against ${laneSeconds(lane)}`);
});

test('they pass on the same hand every time, whichever way the ship has them walking', () => {
  for (const lane of [[[0.6, -1.2], [0.6, 3.0]], [[-0.9, -1.2], [-0.9, 2.4]]]) {
    const stage = stageWalkers('nina', [lane, reversed(lane)]), [a, b] = stage.walkers;
    let closest = Infinity, port = 0, starboard = 0, stood = 0;
    for (let at = 0; at < laneSeconds(lane) + 6 && stage.walkers.some(isWalking); at += FRAME) {
      const was = Array.from(a.position);
      stepCompany(stage.company, stage.boat, FRAME, WIND);
      if (isWalking(a) && Math.hypot(a.position[0] - was[0], a.position[2] - was[2]) < 5e-4) stood += FRAME;
      const dx = b.position[0] - a.position[0], dz = b.position[2] - a.position[2], d = Math.hypot(dx, dz);
      if (d >= closest || !isWalking(a)) continue;
      closest = d;
      // +X is starboard and +Z aft, so a body facing yaw has its right hand at (cos yaw, -sin yaw).
      const right = dx * Math.cos(a.yaw) - dz * Math.sin(a.yaw);
      if (right > 0) starboard = 1; else { port = 1; starboard = 0; }
    }
    assert.equal(port, 1, `the other goes by on his port hand: closest ${closest}`);
    assert.ok(closest > 0.5, `with room to spare on an open deck: ${closest}`);
    assert.ok(stood < 0.2, `and without standing about it: ${stood}`);
  }
});

// Victory's gangway past her guns is one body wide at each gun's recoil, with the bays between the guns to stand in.
const GANGWAY = [[3.74, -11.8], [3.74, -1.8]];
test('two meeting head-on in a one-body gap on Victory\'s gangway pass with no overlap and no deadlock', () => {
  const stage = stageWalkers('victory', [GANGWAY, reversed(GANGWAY)]), seen = walkLanes(stage, laneSeconds(GANGWAY) * 3);
  assert.equal(seen.finished, 2, `nobody is left stuck: ${stage.walkers.map((s) => s.job?.stage ?? 'home')}`);
  assert.ok(seen.deepest < BODY_DEEP_M, `no walking through: ${seen.deepest}`);
  assert.deepEqual(seen.offDeck, [], 'and nobody leaves the walkable deck');
  assert.ok(seen.seconds < laneSeconds(GANGWAY) + 7, `one waits for the other, and not for long: ${seen.seconds} against ${laneSeconds(GANGWAY)} alone`);
});

test('whoever gives way waits in a bay, clear of the gun\'s mouth, rather than meeting in the middle', () => {
  const stage = stageWalkers('victory', [GANGWAY, reversed(GANGWAY)], { stage: ['approach', 'return'] }), [urgent, other] = stage.walkers;
  let waited = 0, nearest = Infinity, waitX = 0;
  for (let at = 0; at < 30 && (isWalking(urgent) || isWalking(other)); at += FRAME) {
    const before = Array.from(other.position);
    stepCompany(stage.company, stage.boat, FRAME, WIND);
    if (isWalking(other) && Math.hypot(other.position[0] - before[0], other.position[2] - before[2]) < 5e-4) { waited += FRAME; waitX = Math.max(waitX, other.position[0]); }
    nearest = Math.min(nearest, Math.hypot(urgent.position[0] - other.position[0], urgent.position[2] - other.position[2]));
  }
  assert.ok(waited > 0.3, `the one with less to do stands and waits: ${waited}`);
  assert.ok(waitX > 3.74 + 0.3, `off the line of the gangway, out in the bay: ${waitX}`);
  assert.ok(nearest > 0.38, `and they never come to it: ${nearest}`);
});

test('right of way: a hand at an order goes before one strolling back, and someone carrying before anyone', () => {
  const run = (setup) => {
    const stage = stageWalkers('victory', [GANGWAY, reversed(GANGWAY)], setup.stages ? { stage: setup.stages } : {});
    setup.apply?.(stage.walkers);
    const stops = [0, 0];
    for (let at = 0; at < 30 && stage.walkers.some(isWalking); at += FRAME) {
      const before = stage.walkers.map((s) => Array.from(s.position));
      stepCompany(stage.company, stage.boat, FRAME, WIND);
      stage.walkers.forEach((s, i) => { if (isWalking(s) && Math.hypot(s.position[0] - before[i][0], s.position[2] - before[i][2]) < 5e-4) stops[i] += FRAME; });
    }
    return stops;
  };
  const order = run({ stages: ['approach', 'return'] });
  assert.ok(order[0] < order[1], `the order first: ${order}`);
  const orderOther = run({ stages: ['return', 'approach'] });
  assert.ok(orderOther[1] < orderOther[0], `whichever way round: ${orderOther}`);
  const carried = run({ apply: ([, b]) => { b.carrying = true; } });
  assert.ok(carried[1] < carried[0], `a load first: ${carried}`);
});

test('someone already in the gap goes first, whatever the other is about', () => {
  // She is in reach of the gun when he comes for it the other way, and his hurry does not back her out.
  const inGap = [[3.74, -6.9], [3.74, -1.8]], coming = [[3.74, -4.5], [3.74, -11.8]];
  const stage = stageWalkers('victory', [inGap, coming], { stage: ['return', 'approach'] }), [her, him] = stage.walkers;
  let herStop = 0, hisStop = 0, closest = Infinity;
  for (let at = 0; at < 20 && stage.walkers.some(isWalking); at += FRAME) {
    const was = Array.from(her.position), wasHis = Array.from(him.position);
    stepCompany(stage.company, stage.boat, FRAME, WIND);
    if (isWalking(her) && Math.hypot(her.position[0] - was[0], her.position[2] - was[2]) < 5e-4) herStop += FRAME;
    if (isWalking(him) && Math.hypot(him.position[0] - wasHis[0], him.position[2] - wasHis[2]) < 5e-4) hisStop += FRAME;
    closest = Math.min(closest, Math.hypot(her.position[0] - him.position[0], her.position[2] - him.position[2]));
  }
  assert.ok(herStop < 0.2, `she walks straight out of it: ${herStop}`);
  assert.ok(hisStop > 0.2, `he stands clear while she does: ${hisStop}`);
  assert.ok(closest > 0.5, `and nobody is hemmed: ${closest}`);
  assert.ok(!stage.walkers.some(isWalking), 'and both get there');
});

test('in a gap too narrow square-on the shoulders come round and the feet keep walking', () => {
  // A hand fixed at his work on one side of the lane, and the rail on the other: what is left is less than two pairs of shoulders.
  const lane = [[-1.25, -4.3], [-1.25, -5.9]], stage = stageWalkers('nina', [lane, [[-1.67, -5.17], [-1.67, -5.2]]], { stage: ['return', 'return'] });
  const [walker, fixed] = stage.walkers, place = [fixed.x, fixed.z];
  stage.boat.mooringActive = true;
  fixed.job = { kind: 'mooring', side: 'port', sideSign: -1, stage: 'working', path: [], cursor: 0, elapsed: 0, rung: 0, revision: stage.company.revision, position: [fixed.x, fixed.position[1] / vesselVerticalScale(stage.boat), fixed.z] };
  let widest = 0, closest = Infinity, slip = 0, stood = 0;
  for (let at = 0; at < 6 && isWalking(walker); at += FRAME) {
    const was = Array.from(walker.position);
    stepCompany(stage.company, stage.boat, FRAME, WIND);
    widest = Math.max(widest, Math.abs(walker.shoulderTurn ?? 0));
    closest = Math.min(closest, Math.hypot(walker.position[0] - fixed.position[0], walker.position[2] - fixed.position[2]));
    const vx = (walker.position[0] - was[0]) / FRAME, vz = (walker.position[2] - was[2]) / FRAME, speed = Math.hypot(vx, vz);
    if (speed < 0.01) { if (isWalking(walker)) stood += FRAME; continue; }
    // The legs walk the way he is going, whatever the shoulders are doing.
    slip = Math.max(slip, Math.abs(vx * Math.cos(walker.yaw) - vz * Math.sin(walker.yaw)));
  }
  assert.ok(!isWalking(walker), 'he gets by');
  assert.ok(widest > 0.3, `turning his shoulders to do it: ${widest}`);
  assert.ok(closest >= 0.38, `a brush, not a body through a body: ${closest}`);
  assert.ok(stood < 0.5, `without stopping to think about it: ${stood}`);
  assert.ok(slip < 1, `with his legs going where he goes: ${slip} m/s across them`);
  assert.deepEqual([fixed.x, fixed.z], place, 'the hand at his work does not budge');
  for (let i = 0; i < 40; i++) stepCompany(stage.company, stage.boat, FRAME, WIND);
  assert.equal(walker.shoulderTurn, 0, 'and square again once he is past');
});

test('with her rail shot away beside them, two passing keep off the open edge', () => {
  // They meet abreast of the gap. One of them keeps to starboard toward it, and the deck stops him going there.
  const sx = 6 / 3.6, sz = 20 / 12, lane = [[1.9, -3.2], [1.9, 3.2]], stage = stageWalkers('nina', [lane, reversed(lane)]), boat = stage.boat;
  createVesselDamageState(boat);
  openRail(boat, 1, -0.3, 0.3);
  assert.ok(crewOpenEdgeInset(boat, 0, 1) > 0, 'the deck is narrower beside the gap');
  let tooNear = 0, steps = 0, closest = Infinity, stood = 0;
  for (let at = 0; at < 12 && stage.walkers.some(isWalking); at += FRAME) {
    const was = stage.walkers.map((s) => Array.from(s.position));
    stepCompany(stage.company, boat, FRAME, WIND);
    stage.walkers.forEach((s, i) => { if (isWalking(s) && Math.hypot(s.position[0] - was[i][0], s.position[2] - was[i][2]) < 5e-4) stood += FRAME; });
    closest = Math.min(closest, Math.hypot(stage.walkers[0].position[0] - stage.walkers[1].position[0], stage.walkers[0].position[2] - stage.walkers[1].position[2]));
    for (const s of stage.walkers) {
      if (!isWalking(s)) continue;
      steps++;
      const z = s.position[2] / sz, edge = modelDeckWidth(boat, z) - crewOpenEdgeInset(boat, z, 1);
      if (s.position[0] / sx + 0.3 / sx > edge + 1e-3) tooNear++;
    }
  }
  assert.ok(steps > 100, 'they did walk it');
  assert.equal(tooNear, 0, 'nobody stands nearer the open edge than a route may');
  assert.ok(closest > 0.4, `and they did not walk through each other instead: ${closest}`);
  assert.ok(stood < 0.4, `or stand off, nose to nose: ${stood}`);
  assert.ok(!stage.walkers.some(isWalking), 'and both get by');
});

test('a crowded sail order finishes in about the time a clear deck takes, with nobody standing blocked', { timeout: 300000 }, () => {
  for (const id of ['nina', 'victory', 'santa-maria']) {
    const order = clearDeckOrder(id);
    assert.ok(order.ratio !== null && order.ratio < 1.12, `${id} crowded ${order.crowded} s against ${order.clear} s clear`);
    const scene = runScene(id, 'sail');
    assert.ok(scene.longestStop < 6, `${id}: nobody stands waiting to get by for long: ${scene.longestStop} s, between ${scene.worstPair}`);
    assert.ok(scene.throughPerMin === 0, `${id}: nobody walks through anybody: ${scene.throughPerMin} a minute`);
  }
});

test('a gun drill walks nobody through anybody, on any ship with visible guns', { timeout: 300000 }, () => {
  for (const id of ['nina', 'victory', 'santa-maria']) {
    const scene = runScene(id, 'guns');
    assert.equal(scene.throughPerMin, 0, `${id}: ${scene.throughPerMin} a minute, closest ${scene.closest} between ${scene.worstPair}`);
    assert.ok(scene.longestStop < 8, `${id}: stood ${scene.longestStop} s`);
  }
});

test('a long watch has hands walking their rounds, not standing blocked, and the helmsman never budges', { timeout: 300000 }, () => {
  for (const id of ['nina', 'victory']) {
    const boat = stageWalkers(id, []).boat, company = createCompany(undefined, id, { fullWatch: true });
    sailingState(boat);
    stepCompany(company, boat, 0, WIND);
    const helm = company.crew.find((s) => s.role === 'Helmsman'), place = Array.from(helm.position), seats = company.crew.filter((s) => s.seatedPose);
    const seatPlaces = seats.map((s) => Array.from(s.position));
    for (let at = 0; at < 60; at += FRAME) stepCompany(company, boat, FRAME, WIND);
    assert.deepEqual(Array.from(helm.position), place, `${id} helmsman holds the helm`);
    seats.forEach((s, i) => assert.deepEqual(Array.from(s.position), seatPlaces[i], `${id} ${s.id} keeps her seat`));
    const scene = runScene(id, 'watch', { seconds: 90 });
    assert.ok(scene.longestStop < 6, `${id}: nobody stands blocked on his rounds for long: ${scene.longestStop} s`);
  }
});

test('the same orders come out the same, frame for frame', () => {
  const run = () => {
    const stage = stageWalkers('nina', [[[0.6, -1.2], [0.6, 3.0]], [[0.6, 3.0], [0.6, -1.2]], [[-0.2, 0.8], [1.4, 0.8]]], { others: true }), path = [];
    for (let i = 0; i < 300; i++) { stepCompany(stage.company, stage.boat, FRAME, WIND); path.push(...stage.company.crew.flatMap((s) => Array.from(s.position))); }
    return path;
  };
  assert.deepEqual(run(), run());
});
