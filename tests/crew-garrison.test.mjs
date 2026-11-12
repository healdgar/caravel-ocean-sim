// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a bombardment does to the men on a fort's walls, and how long it goes on doing it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFortGarrison, isCaptainActor, stepFortGarrison, reviveGarrisonSoldiers, garrisonReach, garrisonWithinSight, GARRISON_SIGHT_M, GARRISON_CASUALTY_STAY_S } from '../js/crew.js';
import { clearCrewWounds } from '../js/crew-wounds.js';
import { initArticulatedRagdoll } from '../js/crew-physics.js';
import { createGunnerySolidSweep } from '../js/gunnery-control.js';

const tower = (extra = {}) => ({ id: 'fort_1', prefabId: 'torreon_atalaya_farol', x: 0, y: 0, z: 0, width: 16, length: 16, height: 6, yaw: 0, damageState: { state: 'intact', craters: [], fires: [] }, ...extra });
const garrisonOf = (fort) => createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [fort] });
// As js/gunnery-control.js keeps a building's craters: the newest 32.
const crater = (fort, entry) => { const list = fort.damageState.craters; list.push(entry); if (list.length > 32) list.shift(); };
const beside = (s, extra = {}) => ({ localPosition: [s.lx - 0.6, s.ly + 0.8, s.lz - 0.6], radius: 1.2, severity: 0.9, ...extra });
const far = (s) => ({ localPosition: [s.lx + 400, s.ly, s.lz + 400], radius: 1.2, severity: 0.9 });
const unhurt = (s) => s.casualtyState !== 'fallen' && s.casualtyState !== 'wounded';

test('a garrison still takes harm from the shot after its building\'s thirty-second crater', () => {
  const fort = tower(), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  for (let i = 0; i < 40; i++) {
    crater(fort, far(man));
    stepFortGarrison(garrison, 0.05);
  }
  assert.equal(fort.damageState.craters.length, 32);
  assert.ok(unhurt(man));
  crater(fort, beside(man));
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.casualtyState, 'fallen', 'the forty-first crater, at his feet, fells him');
  assert.equal(man.pendingWounds?.length, 1, 'and once only, though the list it sits in has shifted');
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.pendingWounds?.length, 1);
});

test('several craters in one step each do their harm, and none does it twice', () => {
  const fort = tower(), garrison = garrisonOf(fort), [a, b] = garrison.soldiers;
  crater(fort, beside(a));
  crater(fort, beside(b));
  stepFortGarrison(garrison, 0.05);
  assert.equal(a.casualtyState, 'fallen');
  assert.equal(b.casualtyState, 'fallen');
  const wounds = a.pendingWounds.length;
  for (let i = 0; i < 5; i++) stepFortGarrison(garrison, 0.05);
  assert.equal(a.pendingWounds.length, wounds);
});

test('the men of a rebuilt building feel the next shot at it', () => {
  const fort = tower(), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  for (let i = 0; i < 6; i++) crater(fort, far(man));
  stepFortGarrison(garrison, 0.05);
  // As js/port-damage.js rebuilds: a new record, and the men back at their posts.
  fort.damageState = { state: 'intact', craters: [], fires: [] };
  reviveGarrisonSoldiers(fort);
  stepFortGarrison(garrison, 0.05);
  crater(fort, beside(man));
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.casualtyState, 'fallen', 'the first crater of the new building reaches him');
});

test('a shot into the foot of a wall leaves the sentry on top of it alone', () => {
  const fort = tower(), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  // Straight below him, six metres down: within reach in plan, and nowhere near him.
  crater(fort, { localPosition: [man.lx - 0.4, man.ly - 6, man.lz - 0.4], radius: 1.4, severity: 0.9 });
  stepFortGarrison(garrison, 0.05);
  assert.ok(unhurt(man));
  assert.equal(man.pendingWounds ?? null, null);
  assert.equal(man.knockdownTimer ?? 0, 0);
  // The same shot at the height of his chest kills him.
  crater(fort, { localPosition: [man.lx - 0.4, man.ly + 1.2, man.lz - 0.4], radius: 1.4, severity: 0.9 });
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.casualtyState, 'fallen');
});

test('a small crater hurts only as far as its own splinters go', () => {
  const fort = tower(), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  // 0.7 m of broken stone, 4 m off at his own height. Every crater used to reach 6 m.
  crater(fort, { localPosition: [man.lx - 4, man.ly + 0.8, man.lz], radius: 0.7, severity: 0.9 });
  stepFortGarrison(garrison, 0.05);
  assert.ok(unhurt(man));
  assert.equal(man.knockdownTimer ?? 0, 0);
  // At 1.5 m it knocks him down and wounds him, and does not kill.
  crater(fort, { localPosition: [man.lx - 1.5, man.ly + 0.8, man.lz], radius: 0.7, severity: 0.9 });
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.casualtyState, 'wounded');
  assert.ok(man.knockdownTimer > 1);
});

test('men who come into being on a ruin lie on its own ground and make no sound', () => {
  const fort = tower({ y: 14, baseY: 14, damageState: { state: 'ruined', craters: [], fires: [] } });
  const garrison = garrisonOf(fort);
  stepFortGarrison(garrison, 0.05);
  for (const s of garrison.soldiers) {
    assert.equal(s.casualtyState, 'fallen');
    assert.ok(Math.abs(s.ly - 14) < 0.5, `he lies at the fort's ground, not at the sea: ${s.ly}`);
    assert.equal(s.garrisonFall ?? null, null, 'and is not seen falling there');
  }
  assert.equal(garrison.audioEvents?.length ?? 0, 0, 'nobody screams for a fall that happened while no one was there');

  // A building that comes down in front of us is heard.
  const live = tower(), watched = garrisonOf(live);
  stepFortGarrison(watched, 0.05);
  live.damageState.state = 'ruined';
  stepFortGarrison(watched, 0.05);
  assert.equal(watched.audioEvents.filter((e) => e.type === 'casualty-scream').length, watched.soldiers.length);
});

test('a man already down still comes to rest on what is left when his wall is shot away', () => {
  const fort = tower(), garrison = garrisonOf(fort), [man, other] = garrison.soldiers;
  stepFortGarrison(garrison, 0.05);
  // Shot at chest height kills each where he stands. It comes from outside, so it throws him inward along the wall.
  for (const s of [man, other]) crater(fort, { localPosition: [s.lx + Math.sign(s.lx || 1) * 0.4, s.ly + 1.2, s.lz + Math.sign(s.lz || 1) * 0.4], radius: 1.4, severity: 0.9 });
  for (let i = 0; i < 80; i++) stepFortGarrison(garrison, 0.05);
  assert.equal(man.casualtyState, 'fallen');
  assert.equal(other.casualtyState, 'fallen');
  assert.equal(man.garrisonFall ?? null, null, 'thrown up and come down again, he lies on the wall');
  const top = man.baseLy, otherTop = other.baseLy, screams = garrison.audioEvents?.length ?? 0;
  assert.ok(top > 2, `on top of it: ${top}`);
  // The building in pieces: the stretch under each of them, from the ground to his feet, and no floor inside.
  const stretch = (s, index) => ({ index, localMin: [s.lx - 1.5, 0, s.lz - 1.5], localMax: [s.lx + 1.5, s.ly, s.lz + 1.5] });
  const state = { brokenCount: 0, broken: [false, false], flying: new Set(), heap: new Map(), fracture: { shards: [stretch(man, 0), stretch(other, 1)], toWorld: (x, y, z) => [x, y, z], floorAt: () => -Infinity, groundAt: () => 0 } };
  fort.damageState.fracture = state;
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.baseLy, top, 'nothing has gone yet');
  // The stretch under the first is shot away.
  state.broken[0] = true; state.brokenCount = 1; state.flying.add(0);
  stepFortGarrison(garrison, 0.05);
  assert.ok(man.garrisonFall, 'he goes down with it, dead or not');
  for (let i = 0; i < 80; i++) stepFortGarrison(garrison, 0.05);
  assert.ok(man.baseLy < 0.05 && man.ly < 0.05, `to the ground at its foot, not left in the air where the wall was: ${man.baseLy}`);
  assert.equal(man.garrisonFall ?? null, null);
  assert.equal(other.baseLy, otherTop, 'the one whose stretch still stands lies where he was');
  assert.equal(garrison.audioEvents?.length ?? 0, screams, 'and a dead man does not cry out again');
});

test('a body shot to pieces stays out of sight until the building is manned again', () => {
  const fort = tower(), garrison = garrisonOf(fort);
  // The one nearest the guns, with nobody and nothing between.
  const man = garrison.soldiers.reduce((a, b) => (a.position[2] < b.position[2] ? a : b));
  stepFortGarrison(garrison, 0.05);
  const sweep = createGunnerySolidSweep({ getTerrain: () => ({ port: garrison.port }) });
  for (let shot = 1; shot <= 4; shot++) {
    const [x, y, z] = man.position, aim = y + (shot === 1 ? 0.9 : 0.15);
    sweep([x, aim, z - (shot === 1 ? 4 : 0.6)], [x, aim, z + 0.5], { id: shot, ammo: 'round', radius: 0.08, mass: 8, velocity: [0, 0, 260] });
    // He drops where he stood, so that the next ball has the same clear path to him.
    man.knockbackVx = man.knockbackVz = man.knockbackVy = 0;
    if (shot < 4) {
      // Lying down by now: the next ball is aimed at where he lies.
      for (let i = 0; i < 40; i++) stepFortGarrison(garrison, 0.05);
      assert.equal(man.ballHits, shot);
      assert.equal(man.visible, true, `still there after ${shot}`);
    }
  }
  assert.equal(man.visible, false);
  for (let i = 0; i < 10; i++) stepFortGarrison(garrison, 0.05);
  assert.equal(man.visible, false, 'the garrison step does not put him back');
  reviveGarrisonSoldiers(fort);
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.visible, true);
  assert.equal(man.obliterated, false);
});

test('clearing a sailor\'s wounds undoes what shot hid, so no pooled hull inherits a missing hand', () => {
  const s = { visible: false, obliterated: true, ballHits: 5 };
  clearCrewWounds(s);
  assert.equal(s.visible, true);
  assert.equal(s.obliterated, false);
  // One hidden for another reason, such as a deck too small to stand on, stays hidden.
  const narrow = { visible: false, ballHits: 0 };
  clearCrewWounds(narrow);
  assert.equal(narrow.visible, false);
});

test('a fallen soldier\'s body goes to sleep once it lies still, and wakes when it is hit again', () => {
  const fort = tower(), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  crater(fort, beside(man));
  for (let i = 0; i < 20 * 8; i++) stepFortGarrison(garrison, 0.05);
  assert.equal(man.casualtyState, 'fallen');
  assert.equal(man.ragdoll.settled, true, `asleep after eight seconds, at age ${man.ragdoll.age}`);
  assert.equal(man._poseReady, true, 'and no longer posed');
  const age = man.ragdoll.age, lay = Float32Array.from(man.ragdoll.pos);
  for (let i = 0; i < 40; i++) stepFortGarrison(garrison, 0.05);
  assert.equal(man.ragdoll.age, age, 'a sleeping body is not stepped');
  assert.deepEqual(man.ragdoll.pos, lay);
  crater(fort, beside(man));
  stepFortGarrison(garrison, 0.05);
  assert.equal(man.ragdoll.settled, false);
  assert.equal(man._poseReady, false);
  assert.ok(man.ragdoll.age > age);
});

test('a body lies for a day of the game\'s calendar, wherever the ship has been meanwhile', () => {
  const fort = tower(), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  const day0 = Date.UTC(1492, 7, 3);
  crater(fort, beside(man));
  stepFortGarrison(garrison, 0.05, 0, day0);
  assert.equal(man.casualtyState, 'fallen');
  assert.equal(man.fallenAtMs, day0);
  stepFortGarrison(garrison, 0.05, 0, day0 + (GARRISON_CASUALTY_STAY_S - 60) * 1000);
  assert.equal(man.visible, true, 'still there a minute short of a day');
  // Two steps of sim time, and a day gone by on the calendar: a voyage out and back.
  stepFortGarrison(garrison, 0.05, 0, day0 + GARRISON_CASUALTY_STAY_S * 1000);
  assert.equal(man.visible, false);
});

test('a throw across a turned building carries the limbs the way it carries the body', () => {
  const thrown = (yaw, vx, vz) => {
    const s = { position: [0, 0, 0], yaw: 0, collapseYaw: 0, crewIndex: 1, fallDir: 1, knockbackVx: vx, knockbackVz: vz, building: { yaw } };
    const rag = initArticulatedRagdoll(s, null);
    return [(rag.pos[0] - rag.prev[0]) * 60, (rag.pos[2] - rag.prev[2]) * 60];
  };
  const still = thrown(Math.PI / 2, 0, 0), east = thrown(Math.PI / 2, 5, 0);
  // Along a building turned a quarter, its own +X is the world's -Z: where js/crew.js moves the body itself.
  assert.ok(Math.abs(east[0] - still[0]) < 1e-3, `no throw along world X: ${east[0] - still[0]}`);
  assert.ok(Math.abs(east[1] - still[1] + 5) < 1e-3, `all of it along world -Z: ${east[1] - still[1]}`);
  const square = thrown(0, 5, 0);
  assert.ok(Math.abs(square[0] - still[0] - 5) < 1e-3, 'and a building that is not turned throws as before');
});

test('a fort far from the middle of its port is in sight of a camera standing in it', () => {
  // As at Lisbon, where the fort at the river mouth stands four kilometres from the town.
  const fort = tower({ x: -4006, z: 936 }), garrison = garrisonOf(fort), man = garrison.soldiers[0];
  const reach = garrisonReach(garrison);
  assert.ok(reach > 3900 && reach < 4200, `the garrison reaches its fort: ${reach}`);
  assert.ok(garrisonWithinSight(garrison, { x: man.position[0] + 20, z: man.position[2] }), 'a camera beside its sentry sees it');
  assert.ok(garrisonWithinSight(garrison, { x: 0, z: 0 }), 'and so does one in the town, which further tests then cull by the nearest man');
  assert.ok(!garrisonWithinSight(garrison, { x: reach + GARRISON_SIGHT_M + 500, z: 0 }), 'one beyond every man of it does not');
  assert.ok(!garrisonWithinSight(garrisonOf(tower()), { x: GARRISON_SIGHT_M + 200, z: 0 }), 'nor one far from a fort in the town');
});

// A port of a founded country: its posts are the model's people.
const man = (id, more = {}) => ({ id, name: `Soul ${id}`, surname: 'Soul', sex: 'm', age: 30, role: 'baker', of: 'watch', ...more });
const rollOf = (count, more = {}) => ({ place: 'Lisboa', day: 0, garrison: count, militia: 0, captain: null, hosts: [], men: Array.from({ length: count }, (_, k) => man(100 + k, k === 2 ? { sex: 'f', name: 'Aldonça Soul' } : {})), ...more });

test('the posts of a founded port are manned from the model\'s own roll, each figure one of its people', () => {
  const own = garrisonOf(tower()), posts = own.soldiers.length;
  assert.ok(posts >= 6, `${posts} posts`); assert.equal(own.watch, null); assert.ok(own.soldiers.every((s) => !s.soul), 'a port with no roll keeps its own company');
  const watch = rollOf(posts + 5), garrison = createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [tower()], watch });
  assert.equal(garrison.watch, watch); assert.equal(garrison.soldiers.length, posts);
  garrison.soldiers.forEach((s, k) => {
    const person = watch.men[k];
    assert.equal(s.soul, person, 'in the roll\'s order'); assert.equal(s.name, person.name); assert.equal(s.sex, person.sex === 'f' ? 'female' : 'male');
    assert.equal(s.role, own.soldiers[k].role, 'the post is the port\'s'); assert.equal(s.stationKind, own.soldiers[k].stationKind);
    assert.deepEqual([...s.position], [...own.soldiers[k].position], 'and stands where it stood');
    assert.ok(s.skin.length === 3 && s.hair.length === 3 && s.face.length === 4);
  });
  assert.equal(garrison.soldiers[2].sex, 'female'); assert.equal(garrison.soldiers[2].name, 'Aldonça Soul');
  // One person, one face, wherever they are posted.
  const again = createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [tower()], watch: { ...watch, men: watch.men.slice(0, posts).reverse() } });
  const of = (g, id) => g.soldiers.find((s) => s.soul.id === id);
  assert.notEqual(again.soldiers.indexOf(of(again, 100)), garrison.soldiers.indexOf(of(garrison, 100)), 'at another post');
  assert.deepEqual(of(again, 100).skin, of(garrison, 100).skin); assert.deepEqual(of(again, 100).face, of(garrison, 100).face);
});

test('a post the roll has no one for stands empty, and whoever holds the place has a captain\'s post', () => {
  const few = createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [tower()], watch: rollOf(3) });
  assert.equal(few.soldiers.length, 3); assert.deepEqual(few.soldiers.map((s) => s.soul.id), [100, 101, 102]);
  assert.equal(few.units[0].length, 3, 'the building\'s own men are those three');
  const none = createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [tower()], watch: rollOf(0) });
  assert.equal(none.soldiers.length, 0);
  // A work with a captain's post: the place's holder stands it, and no one else's post is his.
  const bastion = () => ({ id: 'fort_2', prefabId: 'stone_sea_bastion', x: 0, y: 0, z: 0, width: 30, length: 34, height: 7, yaw: 0, damageState: { state: 'intact', craters: [], fires: [] } });
  const plain = createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [bastion()] }), captains = plain.soldiers.filter(isCaptainActor).length;
  const holder = man(7, { of: 'office', office: 'warden of Lisboa', role: null });
  const held = createFortGarrison({ center: { x: 0, z: 0 }, reach: 200, instances: [bastion()], watch: rollOf(plain.soldiers.length, { captain: holder }) });
  const his = held.soldiers.filter((s) => s.soul === holder);
  if (captains) { assert.equal(his.length, 1); assert.ok(isCaptainActor(his[0])); } else assert.equal(his.length, 0, 'no captain\'s post, and he stands none');
  assert.equal(new Set(held.soldiers.map((s) => s.soul.id)).size, held.soldiers.length);
});
