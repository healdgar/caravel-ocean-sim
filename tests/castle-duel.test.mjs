// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The Two Castles duel is a side game fought at the mouth of Havana in 1600, on the works the board stands there, raised
// at open sea. It must take nothing it does not give back, refuse where it cannot be fought, and play by its own rules:
// guns that reload, a magazine that runs dry, a score read a few times a second, a band that is the ballistics.
import assert from 'node:assert/strict';
import test from 'node:test';

// The page, as far as the controller touches it.
function element() {
  const listeners = {}, found = new Map();
  let text = '';
  const el = {
    style: {}, dataset: {}, hidden: false, value: '', writes: 0, listeners,
    get textContent() { return text; },
    set textContent(next) { text = String(next); el.writes++; },
    set innerHTML(_markup) {},
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    click() { for (const fn of listeners.click ?? []) fn({ target: el }); },
    querySelector(selector) { if (!found.has(selector)) found.set(selector, element()); return found.get(selector); },
    appendChild() {},
  };
  return el;
}
const bodyClasses = new Set();
const hudRoot = { current: null };
globalThis.document = {
  getElementById: () => null,
  createElement: (tag) => { const el = element(); if (tag === 'div') hudRoot.current = el; return el; },
  head: element(),
  body: Object.assign(element(), { classList: { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), contains: (c) => bodyClasses.has(c) } }),
};
const windowKeys = [];
globalThis.window = { addEventListener(type, fn) { if (type === 'keydown') windowKeys.push(fn); } };
const press = (code, extra = {}) => {
  const event = { code, repeat: false, target: { tagName: 'CANVAS' }, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
  for (const fn of windowKeys) fn(event);
  return event;
};

const { CASTLE_DUEL_PLACE, CASTLE_DUEL_MUZZLE_SPEED_MPS, castleDuelStatus, castleDuelWallElevation, createCastleDuelController } = await import('../js/castle-duel.js');
const CHANNEL_M = 480;

// A work as the board records it (js/old-world-board.js standWorkOf): a square 40 m across on ground 4 m up, its deck
// 5 m above that, five guns along its front wall looking out along `turn`.
function workRecord(name, x, z, turn) {
  const c = Math.cos(turn), s = Math.sin(turn), world = ([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c];
  const outline = [[-20, -20], [20, -20], [20, 20], [-20, 20]].map(world);
  const guns = [-12, -6, 0, 6, 12].map((lx, i) => {
    const [gx, gz] = world([lx, -19]);
    return { x: gx, y: 9, z: gz, nx: -s, nz: -c, wall: 0, on: 0, piece: 1 + i };
  });
  return {
    kind: 'fort', form: 'bastioned', name, x, y: 4, z, turn, w: 40, d: 40, outline, guns, salients: [], gate: null,
    types: [0, 6], bore: { axis: 1.07, muzzle: 1.74, breech: 1.26, calibre: 12 },
  };
}

// Havana as the board stands it in 1600: La Punta, and the Morro across the channel from it. `castles: false` stands a
// coast without them.
function havana({ castles = true } = {}) {
  const works = castles
    ? [workRecord(CASTLE_DUEL_PLACE.player, 0, 0, 0), workRecord(CASTLE_DUEL_PLACE.enemy, 0, -CHANNEL_M, Math.PI)]
    : [workRecord('Castillo de la Real Fuerza', 0, 0, 0)];
  const port = { name: 'Havana', regionId: 'havana', center: { x: 0, z: -CHANNEL_M / 2 }, instances: [], works };
  const terrain = {
    port, ports: [port], rebuilt: [], disposed: false,
    height: () => -30,
    rebuildPortBuilding(instance) { terrain.rebuilt.push(instance); },
  };
  return terrain;
}

function duel({ terrain = null, raise = () => havana(), scene = { cameraMode: 'boat', fovY: 1.01 } } = {}) {
  const calls = [], notices = [], disposed = [], places = [];
  const cam = { x: 5, y: 6, z: 7, yaw: 0.3, pitch: -0.1, fovY: 1.01 };
  let live = terrain, sun = 30;
  const ctrl = createCastleDuelController({
    getTerrain: () => live,
    ensureTerrain: raise ? async (place) => { places.push(place); live = await raise(); return live; } : null,
    disposeTerrain: (raised) => { disposed.push(raised); if (raised === live) live = null; },
    getCamera: () => cam,
    setCameraMode: (mode) => calls.push(`camera:${mode}`),
    saveScene: () => { calls.push('save'); return scene; },
    restoreScene: (saved) => { calls.push('restore'); assert.equal(saved, scene, 'the scene given back is the one that was taken'); },
    getSunElevation: () => sun,
    setSunElevation: (degrees) => { sun = degrees; calls.push(`sun:${degrees}`); },
    onNotice: (text) => notices.push(text),
  });
  const hud = hudRoot.current;
  const run = (seconds, dt = 1 / 30) => { for (let t = 0; t < seconds; t += dt) ctrl.update(dt, [0, 0, 0]); };
  return { ctrl, calls, notices, disposed, places, cam, hud, run, sun: () => sun, terrainNow: () => live };
}

// A duel running on a raised Havana.
async function fought(options = {}) {
  const d = duel(options);
  assert.equal(await d.ctrl.start(), true);
  return d;
}

test('at open sea Havana in 1600 is raised for the duel, and the camera, the sky and the coast are given back', async () => {
  const { ctrl, calls, cam, hud, disposed, places, terrainNow } = duel();
  const button = element();
  ctrl.bindLaunchButton(button);
  assert.equal(button.textContent, '🏰 Castle Duel');
  const starting = ctrl.start();
  assert.equal(typeof starting.then, 'function', 'the start waits for the coast');
  assert.equal(button.textContent, '⏳ Raising Havana…');
  assert.equal(ctrl.start(), starting, 'asking again while it loads raises no second coast');
  assert.equal(await starting, true);
  assert.deepEqual(places, [CASTLE_DUEL_PLACE], 'the place raised is the duel\'s, in its year');
  assert.equal(places[0].port, 'havana');
  assert.equal(places[0].year, 1600);
  const raised = terrainNow();
  assert.deepEqual(calls, ['save', 'camera:free'], 'the scene is saved before the camera is taken');
  assert.equal(ctrl.port, raised.port, 'the duel is fought in the port the board stood');
  assert.equal(ctrl.port.transient, true, 'which is marked as no part of the career');
  assert.equal(ctrl.playerCastle.label, CASTLE_DUEL_PLACE.player);
  assert.equal(ctrl.enemyCastle.label, CASTLE_DUEL_PLACE.enemy);
  assert.equal(ctrl.playerCastle.work, raised.port.works[0], 'each side holds the work its record stands');
  assert.equal(bodyClasses.has('castle-duel-active'), true);
  assert.equal(hud.hidden, false);
  assert.equal(button.textContent, '🏰 Exit Castle Duel');
  assert.notEqual(cam.fovY, 1.01, 'the duel looks through its own lens');
  const range = ctrl.status().rangeM;
  assert.ok(Math.abs(range - (CHANNEL_M - 2 * 19)) < 3, `the range is from La Punta's muzzles to the Morro's front (${range.toFixed(1)} m)`);

  ctrl.stop();
  assert.equal(ctrl.active, false);
  assert.deepEqual(disposed, [raised], 'the coast raised for the duel goes when the duel does');
  assert.equal(terrainNow(), null, 'and the sea is open again');
  assert.deepEqual(calls, ['save', 'camera:free', 'restore']);
  assert.equal(bodyClasses.has('castle-duel-active'), false);
  assert.equal(hud.hidden, true);
  assert.equal(button.textContent, '🏰 Castle Duel');
  assert.equal(ctrl.port, null, 'and the works are let go');
  ctrl.stop();
  assert.deepEqual(calls, ['save', 'camera:free', 'restore'], 'stopping twice gives nothing back twice');
});

test('off a coast the duel is refused, and nothing of it is touched', () => {
  const coast = havana();
  const { ctrl, calls, notices, cam, hud, disposed, places } = duel({ terrain: coast });
  const lens = cam.fovY;
  assert.equal(ctrl.start(), false);
  assert.equal(ctrl.active, false);
  assert.deepEqual(places, [], 'no coast is raised over the one in view');
  assert.deepEqual(disposed, [], 'and the one the player had is never disposed');
  assert.deepEqual(calls, [], 'no scene saved, no camera taken');
  assert.equal(cam.fovY, lens);
  assert.equal(coast.port.transient, undefined);
  assert.equal(bodyClasses.has('castle-duel-active'), false);
  assert.equal(hud.hidden, true);
  assert.equal(notices.length, 1, 'and the player is told why nothing happened');
  assert.match(notices[0], /put out from this coast/);
});

test('a coast raised without both castles is taken away again', async () => {
  const bare = havana({ castles: false });
  const refused = duel({ raise: () => bare });
  assert.equal(await refused.ctrl.start(), false);
  assert.deepEqual(refused.disposed, [bare]);
  assert.deepEqual(refused.calls, []);
  assert.match(refused.notices[0], /could not be raised/);

  const none = duel({ raise: () => null });
  const button = element();
  none.ctrl.bindLaunchButton(button);
  assert.equal(await none.ctrl.start(), false);
  assert.equal(none.ctrl.active, false);
  assert.equal(none.notices.length, 1);
  assert.equal(button.textContent, '🏰 Castle Duel');
});

test('the debug panel closes when the duel is running, not while a coast is raised or after a refusal', async () => {
  let closed = 0;
  const ashore = duel({ terrain: havana() });
  const ashoreButton = element();
  ashore.ctrl.bindLaunchButton(ashoreButton, () => closed++);
  ashoreButton.click();
  assert.equal(closed, 0, 'a refusal leaves the panel where the player can read why');

  let raise;
  const sea = duel({ raise: () => new Promise((resolve) => { raise = resolve; }) });
  const seaButton = element();
  sea.ctrl.bindLaunchButton(seaButton, () => closed++);
  seaButton.click();
  await Promise.resolve();
  assert.equal(seaButton.textContent, '⏳ Raising Havana…');
  assert.equal(closed, 0, 'the panel stays up to say the coast is being raised');
  raise(havana());
  await sea.ctrl.start();
  await Promise.resolve();
  assert.equal(sea.ctrl.active, true);
  assert.equal(closed, 1, 'and closes when the castles stand');
  seaButton.click();
  assert.equal(sea.ctrl.active, false, 'the same button ends the duel');
});

test('a fired gun must be loaded again, and a held key fires once', async () => {
  const { ctrl, run } = await fought();
  const guns = ctrl.status().player.totalGuns;
  assert.equal(guns, 5, 'every gun on La Punta\'s front bears on the Morro');
  assert.equal(ctrl.status().enemy.totalGuns, 5, 'and every gun on the Morro\'s on La Punta');
  assert.equal(ctrl.status().player.readyGuns, guns);

  assert.equal(ctrl.fire(), 1, 'one gun fires');
  assert.equal(ctrl.fire(true), guns - 1, 'a salvo fires the guns still loaded, and only those');
  assert.equal(ctrl.fire(), 0, 'with every gun fired there is nothing to fire');
  assert.equal(ctrl.fire(true), 0);
  assert.match(ctrl.status().lastShotFeedback, /No gun is loaded/);
  run(0.6);
  assert.equal(ctrl.status().player.readyGuns, 0, 'half a second later they are still being served');
  // Read before the enemy's first volley (fired at 3 s) can land and dismount any of them.
  run(2.2);
  assert.equal(ctrl.status().player.readyGuns, guns, 'and after the drill they are loaded again');

  // Held down, Space repeats thirty times a second: only the press itself fires.
  const pressed = press('Space');
  assert.equal(pressed.prevented, true);
  for (let i = 0; i < 30; i++) press('Space', { repeat: true });
  for (let i = 0; i < 30; i++) press('KeyF', { repeat: true });
  assert.equal(ctrl.status().player.readyGuns, guns - 1, 'one gun gone, not the battery');
  // The aim keys may be held.
  const elevation = ctrl.elevation;
  press('ArrowUp'); press('ArrowUp', { repeat: true });
  assert.equal(ctrl.elevation, elevation + 1);
  // Typing in a field is not gunnery.
  press('Space', { target: { tagName: 'INPUT' } });
  assert.equal(ctrl.status().player.readyGuns, guns - 1);
  ctrl.stop();
  const quiet = press('Space');
  assert.equal(quiet.prevented, false, 'once the duel is over its keys are nobody\'s');
});

test('each work keeps a fort\'s magazine, and a work out of powder is silenced', async () => {
  const { ctrl, run } = await fought();
  const status = ctrl.status();
  assert.ok(status.player.powderKg > 5000, `the magazine holds ${status.player.powderKg} kg, enough for a long duel`);
  assert.equal(status.player.silencedBy, null);

  ctrl.playerCastle.magazine.powderKg = 0;
  assert.equal(ctrl.fire(), 0);
  assert.match(ctrl.status().lastShotFeedback, /magazine is empty/);
  assert.equal(ctrl.status().player.silencedBy, 'powder');
  run(1);
  assert.equal(ctrl.winner, 'enemy', 'a work that cannot fire has lost');

  assert.equal(ctrl.rematch(), true);
  assert.equal(ctrl.winner, null);
  ctrl.playerCastle.magazine.powderKg = 0;
  ctrl.enemyCastle.magazine.powderKg = 0;
  run(1);
  assert.equal(ctrl.winner, 'draw', 'two empty magazines end it, rather than leaving it to stall');
  ctrl.stop();
});

test('castleDuelStatus names what silenced a castle', () => {
  const guns = [{ stage: 'ready' }, { stage: 'spent' }, { stage: 'ready', queued: true }, { dismounted: true, stage: 'dismounted' }];
  const whole = { damageState: { integrity: 0.82, fires: [1] }, magazine: { powderKg: 900 }, garrisonSoldiers: [{}, { casualtyState: 'fallen' }] };
  const out = {};
  assert.equal(castleDuelStatus(whole, guns, out), out, 'it writes into what it is given');
  assert.deepEqual({ ...out }, { activeGuns: 3, readyGuns: 1, totalGuns: 4, ableSoldiers: 1, totalSoldiers: 2, integrityPct: 82, fires: 1, powderKg: 900, magazineExploded: false, silencedBy: null, defeated: false });
  assert.equal(castleDuelStatus({ ...whole, magazine: { powderKg: 0 } }, guns).silencedBy, 'powder');
  assert.equal(castleDuelStatus({ ...whole, magazine: { powderKg: 50, exploded: true } }, guns).silencedBy, 'magazine');
  assert.equal(castleDuelStatus({ ...whole, damageState: { integrity: 0.04 } }, guns).silencedBy, 'walls');
  assert.equal(castleDuelStatus(whole, [{ dismounted: true }]).silencedBy, 'guns');
  assert.equal(castleDuelStatus({ ...whole, garrisonSoldiers: [{ casualtyState: 'fallen' }] }, guns).silencedBy, 'garrison');
});

test('a rematch stands the struck pieces again, with whole walls and the garrison back at its posts', async () => {
  const { ctrl, calls, terrainNow } = await fought();
  const port = ctrl.port, garrison = port.garrison, terrain = terrainNow();
  // A piece of the Morro shot down, and a man of its garrison fallen with it.
  const piece = { id: 'city_7', workBuilding: ctrl.enemyCastle, damageState: { hits: 4, integrity: 0.1 } };
  port.instances.push(piece);
  const man = ctrl.enemyCastle.garrisonSoldiers[0];
  man.casualtyState = 'fallen';
  ctrl.enemyCastle.damageState.integrity = 0.3;
  ctrl.enemyCastle.magazine.exploded = true;
  ctrl.setElevation(4);
  assert.equal(ctrl.rematch(), true);
  assert.equal(ctrl.port, port, 'the same harbour');
  assert.deepEqual(terrain.rebuilt, [piece], 'the struck piece stands again, and nothing else is raised');
  assert.ok(!piece.damageState.hits, 'whole');
  assert.equal(ctrl.enemyCastle.damageState.integrity, 1);
  assert.equal(ctrl.status().enemy.magazineExploded, false);
  assert.equal(port.garrison, garrison, 'the same garrison');
  assert.equal(man.casualtyState, 'able', 'back on its walls');
  assert.equal(ctrl.winner, null);
  assert.equal(ctrl.elevation, 4, 'the player keeps his laying');
  assert.equal(calls.filter((call) => call === 'save').length, 1, 'the normal game\'s scene is saved once, at the start');
  ctrl.stop();
  assert.equal(ctrl.rematch(), false, 'there is no rematch of a duel that is over');
});

test('the score is written a few times a second, not every frame, and the camera mode is set once', async () => {
  const { ctrl, calls, hud, run, cam } = await fought();
  run(0.1);
  const metrics = hud.querySelector('#cd-player-metrics'), banner = hud.querySelector('#cd-banner');
  const before = metrics.writes + banner.writes;
  run(2.5, 1 / 60); // a hundred and fifty frames before the enemy first fires
  assert.equal(metrics.writes + banner.writes - before, 0, 'with nothing changed nothing is rewritten');
  assert.equal(calls.filter((call) => call === 'camera:free').length, 1);

  // A shot shows at once: the next frame's score has one gun fewer loaded.
  const guns = ctrl.status().player.totalGuns;
  ctrl.fire();
  ctrl.update(1 / 60, [0, 0, 0]);
  assert.match(metrics.textContent, new RegExp(`\\(${guns - 1} loaded\\)`));

  // The fixed views hold the camera; the free view leaves it to the player.
  ctrl.setView('channel');
  ctrl.update(1 / 60, [0, 0, 0]);
  const held = cam.x;
  assert.ok(Math.abs(held - ctrl.playerCastle.x) >= 135, 'the channel view stands off the line between the works');
  cam.x += 500;
  ctrl.update(1 / 60, [0, 0, 0]);
  assert.equal(cam.x, held, 'a fixed view is held');
  ctrl.setView('free');
  assert.equal(ctrl.freeView, true);
  cam.x = 9999;
  ctrl.update(1 / 60, [0, 0, 0]);
  assert.equal(cam.x, 9999, 'the free view is the player\'s to fly');
  ctrl.stop();
  assert.equal(ctrl.freeView, false);
});

test('the night battle sets the sun by hand and says which way the button goes', async () => {
  const { ctrl, hud, sun } = await fought();
  const night = hud.querySelector('#cd-night-btn');
  assert.equal(night.textContent, '🌙 Night Battle');
  night.click();
  assert.equal(sun(), -18);
  assert.equal(night.textContent, '☀️ Day Battle');
  night.click();
  assert.equal(sun(), 24);
  ctrl.stop();
});

test('the band the hint names is the ballistics: its middle strikes the walls, its edges fall short and carry over', async () => {
  // A ball in still air from the muzzles, as far as the range: where it is when it gets there.
  const heightAt = (from, to, degrees) => {
    const d = Math.hypot(to[0] - from[0], to[2] - from[2]), a = (degrees * Math.PI) / 180, v = CASTLE_DUEL_MUZZLE_SPEED_MPS;
    const t = d / (v * Math.cos(a));
    return from[1] + v * Math.sin(a) * t - 0.5 * 9.81 * t * t;
  };
  const from = [0, 10, 0], to = [0, 7.5, -442];
  const [low, high] = castleDuelWallElevation(from, to);
  assert.ok(Math.abs(heightAt(from, to, (low + high) / 2) - to[1]) < 0.05, 'laid in the middle of the band the ball meets the wall');
  assert.ok(heightAt(from, to, low) < to[1] - 5, 'at its foot it falls short');
  assert.ok(heightAt(from, to, high) > to[1] + 5, 'at its head it carries over the parapet');

  const { ctrl } = await fought();
  const { wallBand, lastShotFeedback } = ctrl.status();
  assert.ok(wallBand[0] > 0 && wallBand[1] < 4, `across the channel the band is a low one (${wallBand.map((v) => v.toFixed(2))})`);
  assert.match(lastShotFeedback, new RegExp(`\\+${wallBand[0].toFixed(1)}° to \\+${wallBand[1].toFixed(1)}°`), 'and the hint names it');
  ctrl.stop();
});
