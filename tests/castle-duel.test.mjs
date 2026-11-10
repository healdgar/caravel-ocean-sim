// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The Two Castles duel is a side game on the normal game's coast. It must take nothing it does not
// give back, refuse a coast that cannot hold it, and play by its own rules: guns that reload, a
// magazine that runs dry, a score read a few times a second.
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

const { CASTLE_DUEL_DISTANCE_M, CASTLE_DUEL_WALL_ELEVATION_DEG, castleDuelStatus, chooseCastleDuelArena, createCastleDuelController } = await import('../js/castle-duel.js');

// A procedural coast as the duel sees it: a port it can stand its own in place of, and deep water.
function coast({ baked = false } = {}) {
  const ownPort = { name: 'Cartagena', center: { x: 0, z: 0 }, seaDir: { x: 0, z: -1 }, instances: [] };
  let held = null;
  const terrain = {
    port: ownPort, ports: [ownPort], swaps: [], disposed: false,
    height: () => -30,
    setCustomPort(port = null, geometry = null) {
      if (baked) return false;
      if (port && geometry) { held ??= terrain.port; terrain.port = port; }
      else if (held) { terrain.port = held; held = null; }
      else return false;
      terrain.ports = [terrain.port];
      terrain.swaps.push({ port, geometry });
      return true;
    },
  };
  return { terrain, ownPort };
}

function duel({ terrain = coast().terrain, vessels = [], ensureTerrain = null, scene = { cameraMode: 'boat', fovY: 1.01 } } = {}) {
  const calls = [], notices = [], disposed = [];
  const cam = { x: 5, y: 6, z: 7, yaw: 0.3, pitch: -0.1, fovY: 1.01 };
  let live = terrain, sun = 30;
  const ctrl = createCastleDuelController({
    getTerrain: () => live,
    ensureTerrain: ensureTerrain ? async () => { live = await ensureTerrain(); return live; } : null,
    disposeTerrain: (raised) => { disposed.push(raised); if (raised === live) live = null; },
    getVessels: () => vessels,
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
  return { ctrl, calls, notices, disposed, cam, hud, run, terrain, sun: () => sun, terrainNow: () => live };
}

test('the castles are sited clear of every ship, and no ship is moved for them', () => {
  const { terrain } = coast();
  const open = chooseCastleDuelArena(terrain, []);
  // A ship lying exactly where the castles would otherwise stand.
  const ship = { boat: { x: open.x, z: open.z, heading: 123, surgeVelocity: 2.5, leewayVelocity: 0.3, showProw: true } };
  const before = { ...ship.boat };
  const sited = chooseCastleDuelArena(terrain, [ship]);
  assert.ok(Math.abs(sited.x - ship.boat.x) >= 180 || Math.abs(sited.z - ship.boat.z) >= 220, `the strait is laid clear of her (${JSON.stringify(sited)})`);

  const { ctrl } = duel({ terrain, vessels: [ship] });
  assert.equal(ctrl.start(), true);
  assert.deepEqual(ship.boat, before, 'she lies where she lay, with the way she had on');
  assert.ok(Math.abs(ctrl.port.center.x - ship.boat.x) >= 180 || Math.abs(ctrl.port.center.z - ship.boat.z) >= 220);
  ctrl.stop();
  assert.deepEqual(ship.boat, before);
});

test('starting borrows the port, the camera and the sky, and stopping gives each back', () => {
  const { terrain, ownPort } = coast();
  const { ctrl, calls, cam, hud } = duel({ terrain });
  const button = element();
  ctrl.bindLaunchButton(button);
  assert.equal(button.textContent, '🏰 Castle Duel');
  assert.equal(ctrl.start(), true);
  assert.equal(ctrl.active, true);
  assert.deepEqual(calls, ['save', 'camera:free'], 'the scene is saved before the camera is taken');
  assert.equal(terrain.port, ctrl.port);
  assert.equal(ctrl.port.transient, true, 'the duel port is marked as no part of the career');
  assert.equal(ctrl.port.name, 'Strait of the Two Castles');
  assert.equal(bodyClasses.has('castle-duel-active'), true);
  assert.equal(hud.hidden, false);
  assert.equal(button.textContent, '🏰 Exit Castle Duel');
  assert.notEqual(cam.fovY, 1.01, 'the duel looks through its own lens');
  assert.equal(Math.abs(ctrl.playerCastle.z - ctrl.enemyCastle.z), CASTLE_DUEL_DISTANCE_M);

  ctrl.stop();
  assert.equal(ctrl.active, false);
  assert.equal(terrain.port, ownPort, 'the coast has its own port again');
  assert.deepEqual(terrain.swaps.at(-1), { port: null, geometry: null });
  assert.deepEqual(calls, ['save', 'camera:free', 'restore']);
  assert.equal(bodyClasses.has('castle-duel-active'), false);
  assert.equal(hud.hidden, true);
  assert.equal(button.textContent, '🏰 Castle Duel');
  assert.equal(ctrl.port, null, 'and the castles are let go');
  ctrl.stop();
  assert.deepEqual(calls, ['save', 'camera:free', 'restore'], 'stopping twice gives nothing back twice');
});

test('a coast that cannot take the castles refuses the duel and is left untouched', () => {
  const { terrain, ownPort } = coast({ baked: true });
  const { ctrl, calls, notices, cam, hud } = duel({ terrain });
  const lens = cam.fovY;
  assert.equal(ctrl.start(), false);
  assert.equal(ctrl.active, false);
  assert.deepEqual(calls, [], 'no scene saved, no camera taken');
  assert.equal(cam.fovY, lens);
  assert.equal(terrain.port, ownPort);
  assert.equal(bodyClasses.has('castle-duel-active'), false);
  assert.equal(hud.hidden, true);
  assert.equal(notices.length, 1, 'and the player is told why nothing happened');
  assert.match(notices[0], /cannot be raised on this coast/);
});

test('at open sea a coast is raised for the duel and taken away with it', async () => {
  const raised = coast().terrain;
  const { ctrl, disposed, calls, terrainNow } = duel({ terrain: null, ensureTerrain: async () => raised });
  const button = element();
  ctrl.bindLaunchButton(button);
  const starting = ctrl.start();
  assert.equal(typeof starting.then, 'function', 'the start waits for the coast');
  assert.equal(button.textContent, '⏳ Raising the castles…');
  assert.equal(ctrl.start(), starting, 'asking again while it loads raises no second coast');
  assert.equal(await starting, true);
  assert.equal(ctrl.active, true);
  assert.equal(terrainNow(), raised);
  ctrl.stop();
  assert.deepEqual(disposed, [raised], 'the coast raised for the duel goes when the duel does');
  assert.equal(terrainNow(), null, 'and the sea is open again');
  assert.equal(calls.at(-1), 'restore');

  const none = duel({ terrain: null, ensureTerrain: async () => null });
  none.ctrl.bindLaunchButton(button);
  assert.equal(await none.ctrl.start(), false);
  assert.equal(none.ctrl.active, false);
  assert.equal(none.notices.length, 1);
  assert.equal(button.textContent, '🏰 Castle Duel');

  // A coast raised only to find it cannot take the castles is not left standing either.
  const bakedCoast = coast({ baked: true }).terrain;
  const refused = duel({ terrain: null, ensureTerrain: async () => bakedCoast });
  assert.equal(await refused.ctrl.start(), false);
  assert.deepEqual(refused.disposed, [bakedCoast]);
  assert.deepEqual(refused.calls, []);
});

test('the debug panel closes when the duel is running, not while a coast is raised or after a refusal', async () => {
  let closed = 0;
  const here = duel();
  const button = element();
  here.ctrl.bindLaunchButton(button, () => closed++);
  button.click();
  assert.equal(here.ctrl.active, true);
  assert.equal(closed, 1, 'on a coast that takes the castles it closes at once');
  button.click();
  assert.equal(here.ctrl.active, false, 'the same button ends the duel');
  assert.equal(closed, 1);

  closed = 0;
  const baked = duel({ terrain: coast({ baked: true }).terrain });
  const bakedButton = element();
  baked.ctrl.bindLaunchButton(bakedButton, () => closed++);
  bakedButton.click();
  assert.equal(closed, 0, 'a refusal leaves the panel where the player can read why');

  let raise;
  const sea = duel({ terrain: null, ensureTerrain: () => new Promise((resolve) => { raise = resolve; }) });
  const seaButton = element();
  sea.ctrl.bindLaunchButton(seaButton, () => closed++);
  seaButton.click();
  await Promise.resolve();
  assert.equal(seaButton.textContent, '⏳ Raising the castles…');
  assert.equal(closed, 0, 'the panel stays up to say the coast is being raised');
  raise(coast().terrain);
  await sea.ctrl.start();
  await Promise.resolve();
  assert.equal(sea.ctrl.active, true);
  assert.equal(closed, 1, 'and closes when the castles stand');
  sea.ctrl.stop();
});

test('a coast the player already had is never disposed by the duel', () => {
  const { ctrl, disposed } = duel();
  ctrl.start();
  ctrl.stop();
  assert.deepEqual(disposed, []);
});

test('a fired gun must be loaded again, and a held key fires once', () => {
  const { ctrl, run } = duel();
  ctrl.start();
  const guns = ctrl.status().player.totalGuns;
  assert.ok(guns >= 2, `the castle has ${guns} guns bearing on the strait`);
  assert.equal(ctrl.status().player.readyGuns, guns);

  assert.equal(ctrl.fire(), 1, 'one gun fires');
  assert.equal(ctrl.fire(true), guns - 1, 'a salvo fires the guns still loaded, and only those');
  assert.equal(ctrl.fire(), 0, 'with every gun fired there is nothing to fire');
  assert.equal(ctrl.fire(true), 0);
  assert.match(ctrl.status().lastShotFeedback, /No gun is loaded/);
  run(0.6);
  assert.equal(ctrl.status().player.readyGuns, 0, 'half a second later they are still being served');
  // Read before the enemy's first volley (fired at 3 s) can land and dismount any of them.
  run(2.6);
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

test('the castles keep the fortress magazine, and a castle out of powder is silenced', () => {
  const { ctrl, run } = duel();
  ctrl.start();
  const status = ctrl.status();
  assert.ok(status.player.powderKg > 5000, `the magazine holds ${status.player.powderKg} kg, enough for a long duel`);
  assert.equal(status.player.silencedBy, null);

  ctrl.playerCastle.magazine.powderKg = 0;
  assert.equal(ctrl.fire(), 0);
  assert.match(ctrl.status().lastShotFeedback, /magazine is empty/);
  assert.equal(ctrl.status().player.silencedBy, 'powder');
  run(1);
  assert.equal(ctrl.winner, 'enemy', 'a castle that cannot fire has lost');

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

test('a rematch raises the same stone again with whole walls and a fresh garrison', () => {
  const { ctrl, terrain, calls } = duel();
  ctrl.start();
  const port = ctrl.port, geometry = terrain.swaps[0].geometry, garrison = port.garrison;
  ctrl.enemyCastle.damageState.integrity = 0.3;
  ctrl.enemyCastle.magazine.exploded = true;
  ctrl.setElevation(4);
  assert.equal(ctrl.rematch(), true);
  assert.equal(ctrl.port, port, 'the same strait');
  assert.equal(terrain.swaps.at(-1).geometry, geometry, 'the same geometry: nothing is built twice');
  assert.equal(terrain.swaps.at(-1).port, port);
  assert.equal(ctrl.enemyCastle.damageState.integrity, 1);
  assert.equal(ctrl.status().enemy.magazineExploded, false);
  assert.notEqual(port.garrison, garrison, 'new men on the walls');
  assert.equal(ctrl.winner, null);
  assert.equal(ctrl.elevation, 4, 'the player keeps his laying');
  assert.equal(calls.filter((call) => call === 'save').length, 1, 'the normal game\'s scene is saved once, at the start');
  ctrl.stop();
  assert.equal(ctrl.rematch(), false, 'there is no rematch of a duel that is over');
});

test('the score is written a few times a second, not every frame, and the camera mode is set once', () => {
  const { ctrl, calls, hud, run, cam } = duel();
  ctrl.start();
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
  cam.x += 500;
  ctrl.update(1 / 60, [0, 0, 0]);
  assert.ok(Math.abs(cam.x - ctrl.playerCastle.x) <= 135.01, 'a fixed view is held');
  ctrl.setView('free');
  assert.equal(ctrl.freeView, true);
  cam.x = 9999;
  ctrl.update(1 / 60, [0, 0, 0]);
  assert.equal(cam.x, 9999, 'the free view is the player\'s to fly');
  ctrl.stop();
  assert.equal(ctrl.freeView, false);
});

test('the night battle sets the sun by hand and says which way the button goes', () => {
  const { ctrl, hud, sun } = duel();
  ctrl.start();
  const night = hud.querySelector('#cd-night-btn');
  assert.equal(night.textContent, '🌙 Night Battle');
  night.click();
  assert.equal(sun(), -18);
  assert.equal(night.textContent, '☀️ Day Battle');
  night.click();
  assert.equal(sun(), 24);
  ctrl.stop();
});

test('the hint tells the truth: guns laid as it says strike the enemy walls', () => {
  // One gun at each laying, read before the enemy's first volley is in the air.
  const strike = (elevation) => {
    const { ctrl, run } = duel();
    ctrl.start();
    ctrl.setElevation(elevation);
    assert.equal(ctrl.fire(), 1);
    run(2.5);
    const hits = ctrl.enemyCastle.damageState.hits ?? 0, feedback = ctrl.status().lastShotFeedback;
    ctrl.stop();
    return { hits, feedback };
  };
  const [low, high] = CASTLE_DUEL_WALL_ELEVATION_DEG;
  for (const elevation of [low, (low + high) / 2, high]) {
    const shot = strike(elevation);
    assert.equal(shot.hits, 1, `laid at +${elevation}° the gun strikes Fuerte del Moro (${shot.feedback})`);
    assert.match(shot.feedback, /Fuerte del Moro/);
  }
  const over = strike(high + 0.5);
  assert.equal(over.hits, 0, `laid above the hint the shot clears the castle (${over.feedback})`);
  const under = strike(low - 0.75);
  assert.match(under.feedback, /foundation/, `laid below the hint it finds only the foundation (${under.feedback})`);
});
