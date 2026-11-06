// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Canoes and early hulls fight with bows, yachts carry no weapons, and nothing powderless can explode.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNavalBattleGunDefinitions, bowElevationDegrees, vesselCarriesPowder, vesselSidearm } from '../js/gunnery-models.js';
import { createGunneryState, gunneryAmmoFlight, gunneryWeapon, GUNNERY_BOW_AMMO, GUNNERY_CANNON_AMMO } from '../js/gunnery-state.js';
import { ARROW_FIRE_INTENSITY, applyArrowImpact, consumeMagazineOrdnance, createShipGunnery, createVesselDamageState, createVesselMagazineState, resolveSolidGunneryImpact } from '../js/gunnery-control.js';
import { copyVessel, bindVesselModel } from '../js/vessels.js';
import { aimElevationForRange } from '../js/follower.js';
import { prizeCannonCount } from '../js/boarding-docking.js';
import { crewGunneryTool, manGunStationsImmediate } from '../js/crew-work.js';
import { createCompany } from '../js/crew.js';

const makeBoat = (modelId, extra = {}) => {
  const boat = { modelId, length: 15, beam: 2, x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, surgeVelocity: 0, leewayVelocity: 0, ...extra };
  bindVesselModel(boat, modelId);
  return boat;
};
const arrowHit = (boat, ammo, shotId, extra = {}) => ({ type: 'impact', kind: 'ship', targetBoat: boat, ammo, shotId, hitZone: 'hull', localPosition: [0, 1.2, 0], velocity: [50, -4, 0], mass: 0.065, energy: 90, ...extra });

test('canoes and early hulls carry bows, yachts nothing, and gunned ships keep their guns', () => {
  for (const id of ['taino-canoe', 'oseberg', 'lusoria']) {
    const guns = createNavalBattleGunDefinitions(id);
    assert.ok(guns.length > 0 && guns.every((gun) => gun.kind === 'bow'), id);
    assert.equal(vesselCarriesPowder(id), false, id);
    assert.ok(guns.every((gun) => gun.visibleCrew === false), 'archers never pull paddlers off their stations');
  }
  assert.deepEqual([...createNavalBattleGunDefinitions('gipsy-moth-iv')], []);
  assert.equal(vesselCarriesPowder('gipsy-moth-iv'), false);
  for (const id of ['nina', 'victory', 'flying-cloud']) {
    assert.ok(createNavalBattleGunDefinitions(id).every((gun) => gun.kind !== 'bow'), id);
    assert.equal(vesselCarriesPowder(id), true, id);
  }
});

test('a bow battery takes only arrows and a gun battery only shot', () => {
  const canoe = makeBoat('taino-canoe');
  const bows = createShipGunnery(canoe);
  assert.equal(bows.ammo, 'arrow');
  assert.equal(bows.setAmmo('fire-arrow'), 'fire-arrow');
  assert.equal(bows.setAmmo('grape'), 'arrow', 'grape shot is not a bow load');
  assert.equal(bows.magazine, null, 'no powder to report');
  const caravel = makeBoat('nina', { length: 20, beam: 6 });
  const guns = createShipGunnery(caravel);
  assert.equal(guns.ammo, 'round');
  assert.equal(guns.setAmmo('fire-arrow'), 'round');
  assert.deepEqual([...gunneryWeapon(bows.state.guns[0]).ammo], [...GUNNERY_BOW_AMMO]);
  assert.deepEqual([...gunneryWeapon(guns.state.guns[0]).ammo], [...GUNNERY_CANNON_AMMO]);
});

test('powderless hulls load and loose without powder, and burn none', () => {
  const canoe = makeBoat('taino-canoe');
  const mag = createVesselMagazineState(canoe);
  assert.equal(mag.initialPowderKg, 0);
  const bows = createShipGunnery(canoe);
  assert.ok(bows.prepare('port'));
  for (let i = 0; i < 400; i++) bows.update(1 / 60, [0, 0, 0]);
  const loaded = bows.summary('port');
  assert.equal(loaded.ready, loaded.total, 'an archer is ready within seven seconds');
  assert.ok(bows.canFire('port'));
  assert.equal(bows.blockedReason('port'), null);
  assert.equal(bows.stallReason('port'), null);
  assert.ok(bows.fire('port'));
  for (let i = 0; i < 180; i++) bows.update(1 / 60, [0, 0, 0]);
  assert.equal(bows.state.guns.filter((gun) => gun.side === 'port').every((gun) => gun.roundsFired === 1), true);
  assert.equal(canoe.magazine.shotsFired, 0);
  assert.equal(consumeMagazineOrdnance(canoe, { ammo: 'arrow', mass: 0.065 }).powderKg, 0);
});

test('bow elevation lands within a hull length across the range bows reach', () => {
  for (const ammo of ['arrow', 'fire-arrow']) {
    const flight = gunneryAmmoFlight(ammo), gun = createGunneryState(createNavalBattleGunDefinitions('taino-canoe')).guns[0];
    const reach = ammo === 'arrow' ? 170 : 110;
    for (const range of [30, 60, 100, reach]) {
      const degrees = bowElevationDegrees(range, gun.muzzleSpeed * flight.speed, flight.drag) * Math.PI / 180;
      const dragPerMetre = .5 * 1.225 * gun.dragCoefficient * flight.drag * Math.PI * (gun.diameter / 2) ** 2 / gun.mass;
      let x = 0, y = 1, vx = Math.cos(degrees) * gun.muzzleSpeed * flight.speed, vy = Math.sin(degrees) * gun.muzzleSpeed * flight.speed;
      while (y > 0.5 || vy > 0) {
        const speed = Math.hypot(vx, vy), h = 1 / 120;
        vx -= dragPerMetre * speed * vx * h;
        vy -= (dragPerMetre * speed * vy + 9.80665) * h;
        x += vx * h; y += vy * h;
      }
      assert.ok(Math.abs(x - range) <= 15, `${ammo} at ${range} m landed at ${x.toFixed(1)} m`);
    }
  }
  const bowBoat = { gunnery: createGunneryState(createNavalBattleGunDefinitions('taino-canoe')) };
  assert.ok(aimElevationForRange(bowBoat, null, 100) > 8, 'bows use a much higher arc than the cannon curve');
  const gunBoat = { gunnery: createGunneryState(createNavalBattleGunDefinitions('nina')) };
  assert.ok(aimElevationForRange(gunBoat, null, 100) < 2);
});

test('arrows leave the hull intact, and only those reaching a body hurt anyone', () => {
  const target = makeBoat('nina', { length: 20, beam: 6 });
  const damage = createVesselDamageState(target);
  const before = damage.hullIntegrity;
  let hurt = 0;
  for (let i = 0; i < 200; i++) { const r = applyArrowImpact(target, arrowHit(target, 'arrow', i)); hurt += r.casualtiesWounded + r.casualtiesKilled; }
  assert.equal(damage.hullIntegrity, before, 'no breach from any number of arrows');
  assert.equal(damage.breaches ?? 0, 0);
  assert.equal(damage.fires.length, 0, 'plain arrows start no fire');
  assert.equal(hurt, 0, 'planks shield the crew');
  assert.equal(target.magazine.exploded, false);
});

test('fire arrows catch more readily in rigging and never at the waterline', () => {
  const catches = (extra) => {
    const target = makeBoat('nina', { length: 20, beam: 6 });
    const damage = createVesselDamageState(target);
    let lit = 0;
    for (let i = 0; i < 300; i++) {
      damage.fires.length = 0;
      applyArrowImpact(target, arrowHit(target, 'fire-arrow', i, extra));
      if (damage.fires.length) lit++;
    }
    return lit;
  };
  const rigging = catches({ hitZone: 'rigging', mastGroup: 'main' }), hull = catches({}), wet = catches({ waterline: true });
  assert.ok(rigging > hull, `rigging ${rigging} vs hull ${hull}`);
  assert.ok(hull > 30);
  assert.equal(wet, 0);
});

test('crews douse one fire arrow, but several on one spot outrun them', () => {
  const burn = (arrows) => {
    const target = makeBoat('nina', { length: 20, beam: 6 });
    const guns = createShipGunnery(target), damage = target.damage;
    for (let i = 0; i < arrows; i++) damage.fires.length ? (damage.fires[0].intensity += ARROW_FIRE_INTENSITY * .65) : damage.fires.push({ localPosition: [0, 1.2, 0], hitZone: 'hull', mastGroup: null, intensity: ARROW_FIRE_INTENSITY, age: 0, seed: .37 });
    const start = damage.fires[0].intensity;
    for (let i = 0; i < 300; i++) guns.update(.1, [0, 0, 0]);
    return { start, end: damage.fires[0]?.intensity ?? 0 };
  };
  const one = burn(1), many = burn(6);
  assert.equal(one.end, 0, 'out within half a minute');
  assert.ok(many.end > many.start, `spreading: ${many.start} to ${many.end}`);
});

test('arrows striking a fort do no damage but mark who loosed them', () => {
  const source = makeBoat('taino-canoe');
  const building = { prefabId: 'stone_sea_bastion', x: 0, z: 0, height: 8 };
  assert.equal(resolveSolidGunneryImpact({ type: 'impact', kind: 'building', building, ammo: 'arrow', sourceBoat: source }), null);
  assert.equal(building.damageState.attackers.has(source), true);
  assert.equal(building.damageState.breaches ?? 0, 0);
});

test('a prize yields cannon only if she mounts them and we can use them', () => {
  const withGuns = (id) => { const boat = makeBoat(id, { length: 20, beam: 6 }); createShipGunnery(boat); return boat; };
  const nina = withGuns('nina'), canoe = withGuns('taino-canoe'), yacht = withGuns('gipsy-moth-iv');
  assert.equal(prizeCannonCount(nina, nina), 4);
  assert.equal(prizeCannonCount(canoe, nina), 0, 'a canoe has no cannon to take');
  assert.equal(prizeCannonCount(yacht, nina), 0, 'nor has a yacht');
  assert.equal(prizeCannonCount(nina, canoe), 0, 'a canoe cannot use them');
});

test('batteries without authored stations leave the crew at their work, with sound positions', () => {
  for (const id of ['taino-canoe', 'oseberg', 'lusoria', 'flying-cloud']) {
    const boat = makeBoat(id, { length: 14, beam: 1.8 });
    const battery = createShipGunnery(boat);
    const company = createCompany(boat, id, { fullWatch: true });
    battery.readyAtQuarters('port');
    manGunStationsImmediate(company, boat);
    assert.equal(company.crew.filter((s) => s.job?.kind === 'gunnery').length, 0, id);
    assert.ok(battery.state.guns.every((gun) => gun.visibleCrew === false), id);
    for (const s of company.crew) assert.ok([...s.position].every(Number.isFinite), `${id} ${s.id}`);
  }
});

test('crews draw a cutlass or macana at the rail in a boarding fight, and no tool otherwise', () => {
  const sailor = (time) => ({ time, crewIndex: 2, yaw: 0, scale: [1, 1, 1], position: [1, 2, 3], job: { kind: 'boarding', stage: 'working' } });
  const reach = (tool) => Math.hypot(...tool.a.map((v, i) => v - tool.b[i]));
  const steel = crewGunneryTool(sailor(.4), makeBoat('nina', { length: 20, beam: 6 }));
  assert.equal(steel.kind, 'blade');
  assert.ok(Math.abs(reach(steel) - vesselSidearm('nina').length) < 1e-6);
  assert.ok(steel.a[1] > 2.9, 'held at chest height');
  assert.equal(crewGunneryTool(sailor(.4), makeBoat('taino-canoe')).kind, 'club');
  const resting = { ...sailor(.4), job: { kind: 'rig', stage: 'working' } };
  assert.equal(crewGunneryTool(resting, makeBoat('nina', { length: 20, beam: 6 })), null);
});

test('copied vessels of a powderless model start with no powder', () => {
  const source = makeBoat('taino-canoe', { eye: 1, sailFore: 0, sailMain: 0, sailMizzen: 0, provisionDays: 10, cargoTonnes: 0, speed: 0 });
  const copy = copyVessel(source, { modelId: 'taino-canoe' });
  assert.equal(createVesselMagazineState(copy).initialPowderKg, 0);
});
