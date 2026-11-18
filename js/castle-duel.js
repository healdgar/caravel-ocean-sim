// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// "Two Castles" Cannon Duel Side Game:
// The mouth of Havana's harbour in 1600, where the Morro on its headland and La Punta across the channel faced each
// other: Antonelli and Tejeda's works of 1589–1600 (js/fort-records.js). Each is the work the board founds there in
// that year and stands of the city's types (js/old-world-board.js): its guns are the ones drawn on its platforms, its
// men its garrison, and it is struck through its pieces as any work is (js/gunnery-control.js strikeWorkThroughPiece).
// The player holds La Punta, the enemy the Morro. No aiming arcs: the guns are laid by watching where the shot falls.
//
// It is a debug side game, played on a coast of its own raised at open sea. While it runs the normal game waits:
// main.js stops stepping ships and the voyage, and this controller puts back everything it borrowed (the camera, the
// sky, the coast it raised) when it stops.

import { portWorkBuildings } from './fort-plan.js';
import {
  buildingGunBears,
  createBuildingDamageState,
  createBuildingGunnery,
  stepPortDamage,
} from './gunnery-control.js';
import { createFortGarrison, reviveGarrisonSoldiers, stepFortGarrison } from './crew.js';
import { fireGunnery, prepareGunnery } from './gunnery-state.js';

// The place and year the duel is fought in, and the works each side holds there.
export const CASTLE_DUEL_PLACE = Object.freeze({
  port: 'havana', name: 'Havana', latitude: 23.1355, longitude: -82.345, year: 1600,
  player: 'Castillo de San Salvador de la Punta', enemy: 'Castillo de los Tres Reyes del Morro',
});
export const CASTLE_DUEL_MUZZLE_SPEED_MPS = 300;
const CASTLE_DUEL_GRAVITY = 9.81;
// The score panel is read a few times a second; a hit or a shot refreshes it at once.
const CASTLE_DUEL_HUD_PERIOD_S = 0.5;
const CASTLE_DUEL_STILL_AIR = Object.freeze([0, 0, 0]);
const CASTLE_DUEL_BATTERY_STEP = Object.freeze({ skipBuildingDamage: true });
// Either side of the elevation that strikes the enemy's walls: laid lower the shot falls short at their foot, laid
// higher it clears the parapet. tests/castle-duel.test.mjs holds the band to the ballistics.
const CASTLE_DUEL_WALL_BAND_DEG = 1;
// How far a splash may fall from the enemy's line and still be called at its foot.
const CASTLE_DUEL_SPLASH_NEAR_M = 18;

const DUEL_RELOAD_DURATIONS = Object.freeze({
  swab: 0.35,
  load: 0.45,
  ram: 0.35,
  runout: 0.45,
  prime: 0.25,
});

function configureCastleDuelBattery(battery, muzzleSpeed = CASTLE_DUEL_MUZZLE_SPEED_MPS) {
  if (!battery?.state?.guns) return;
  for (const g of battery.state.guns) {
    g.muzzleSpeed = muzzleSpeed;
    g.dispersion = 0.007;
    g.speedVariation = 0.012;
    g.recoilDuration = 0.55;
    g.durations = { ...DUEL_RELOAD_DURATIONS };
  }
}

// The two works the duel is fought between, from the port the board stood: null where it has not both.
export function castleDuelCastles(port, place = CASTLE_DUEL_PLACE) {
  const works = portWorkBuildings(port);
  const player = works.find((w) => w.label === place.player), enemy = works.find((w) => w.label === place.enemy);
  return player && enemy ? { player, enemy } : null;
}

// The guns of a work that bear on the other: found once when a battery is raised, never per frame.
export function castleDuelFrontGuns(battery, target) {
  if (!battery?.state?.guns || !target) return [];
  return battery.state.guns.filter((g) => buildingGunBears(g, battery.building, target.x, target.z));
}

// The middle of some of a work's own points (local), in the world, `drop` metres lower.
function castleDuelMean(castle, guns, pointOf, drop = 0) {
  const c = Math.cos(castle.yaw ?? 0), s = Math.sin(castle.yaw ?? 0), base = castle.baseY ?? castle.y ?? 0;
  let x = 0, y = 0, z = 0;
  for (const g of guns) { const [lx, ly, lz] = pointOf(g); x += lx; y += ly; z += lz; }
  const n = Math.max(1, guns.length);
  x /= n; y /= n; z /= n;
  return [castle.x + x * c + z * s, base + y - drop, castle.z - x * s + z * c];
}

// Where a work's front guns fire from: the middle of their muzzles.
const castleDuelMuzzles = (castle, guns) => castleDuelMean(castle, guns, (g) => g.muzzleDesign ?? g.localPosition);

// Where a ball strikes a work's walls before those guns: the face of the parapet below their trunnions.
const CASTLE_DUEL_PARAPET_FACE_M = 1.5;
const castleDuelWall = (castle, guns) => castleDuelMean(castle, guns, (g) => g.localPosition, CASTLE_DUEL_PARAPET_FACE_M);

/**
 * The elevations, in degrees, that put a ball of `muzzleSpeed` from `from` into the walls at `to` (world points):
 * the low solution, with the band either side of it that still strikes stone.
 */
export function castleDuelWallElevation(from, to, muzzleSpeed = CASTLE_DUEL_MUZZLE_SPEED_MPS) {
  const d = Math.hypot(to[0] - from[0], to[2] - from[2]), dy = to[1] - from[1], v2 = muzzleSpeed * muzzleSpeed, g = CASTLE_DUEL_GRAVITY;
  const root = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  const deg = (Math.atan2(v2 - Math.sqrt(Math.max(0, root)), g * d) * 180) / Math.PI;
  return [deg - CASTLE_DUEL_WALL_BAND_DEG, deg + CASTLE_DUEL_WALL_BAND_DEG];
}

// The way a work looks at the other, in its own frame, turned `traverseDeg` (positive to the right).
function castleDuelBearing(from, to, traverseDeg = 0) {
  const c = Math.cos(from.yaw ?? 0), s = Math.sin(from.yaw ?? 0), dx = to.x - from.x, dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1, lx = (dx * c - dz * s) / length, lz = (dx * s + dz * c) / length;
  const t = (traverseDeg * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
  return [lx * ct - lz * st, 0, lx * st + lz * ct];
}

function applyGunAim(battery, frontGuns, target, elevationDeg, traverseDeg) {
  if (!battery?.building || !target) return;
  const elev = Math.max(-4, Math.min(18, Number(elevationDeg) || 0));
  const trav = Math.max(-28, Math.min(28, Number(traverseDeg) || 0));
  battery.building.gunneryElevation = elev;
  battery.building.gunneryTraverse = trav;
  const way = castleDuelBearing(battery.building, target, trav);
  for (const g of frontGuns) {
    g.elevation = elev;
    g.aimDirectionLocal = [...way];
    g.aimPoint = null;
  }
}

// Fires `guns` of a battery, whichever side of its work each looks out of.
function fireCastleDuelGuns(battery, guns, options) {
  let fired = 0;
  for (const side of ['port', 'starboard']) fired += fireGunnery(battery.state, side, { ...options, only: guns });
  return fired;
}

/**
 * What state a castle is in, written into `out` so that reading it allocates nothing.
 * A castle is silenced by a blown magazine, ruined walls, no gun left mounted, no soldier left
 * standing, or an empty magazine: `silencedBy` says which.
 */
export function castleDuelStatus(inst, frontGuns = [], out = {}) {
  const dmg = inst?.damageState;
  let activeGuns = 0, readyGuns = 0;
  for (const g of frontGuns) {
    if (g.dismounted) continue;
    activeGuns++;
    if (g.stage === 'ready' && !g.queued) readyGuns++;
  }
  const soldiers = inst?.garrisonSoldiers;
  const totalSoldiers = soldiers?.length ?? 0;
  let ableSoldiers = 0;
  for (let i = 0; i < totalSoldiers; i++) if (soldiers[i].casualtyState !== 'fallen') ableSoldiers++;
  const magazine = inst?.magazine;
  out.activeGuns = activeGuns;
  out.readyGuns = readyGuns;
  out.totalGuns = frontGuns.length;
  out.ableSoldiers = ableSoldiers;
  out.totalSoldiers = totalSoldiers;
  out.integrityPct = Math.round(Math.max(0, Math.min(1, dmg?.integrity ?? 1)) * 100);
  out.fires = dmg?.fires?.length ?? 0;
  out.powderKg = magazine ? Math.max(0, magazine.powderKg ?? 0) : null;
  out.magazineExploded = Boolean(dmg?.magazineExploded || magazine?.exploded);
  out.silencedBy = out.magazineExploded ? 'magazine'
    : out.integrityPct <= 5 ? 'walls'
      : out.totalGuns > 0 && activeGuns === 0 ? 'guns'
        : totalSoldiers > 0 && ableSoldiers === 0 ? 'garrison'
          : out.powderKg !== null && out.powderKg <= 0 ? 'powder'
            : null;
  out.defeated = out.silencedBy !== null;
  return out;
}

/**
 * @param {object} cfg
 *  getTerrain(): terrain|null. ensureTerrain(place): Promise<terrain|null> raises the duel's place at open sea, in
 *  its year; disposeTerrain(terrain) takes it away again when the duel stops.
 *  saveScene(): whatever the normal game needs to put its view and sky back (camera, field of view,
 *  camera mode, sun); restoreScene(saved) puts it back. The duel treats it as opaque.
 *  getCamera(), setCameraMode(mode).
 *  getSunElevation(): degrees; setSunElevation(degrees) sets the sun by hand, whatever the sky mode.
 *  onNotice(text): a line for the player when the duel cannot be played here.
 */

export function createCastleDuelController({
  getTerrain,
  ensureTerrain,
  disposeTerrain,
  getCamera,
  setCameraMode,
  saveScene,
  restoreScene,
  getSunElevation,
  setSunElevation,
  onShoreShot,
  onNotice,
}) {
  const place = CASTLE_DUEL_PLACE;
  let active = false;
  let duelPort = null;
  let duelTerrain = null;
  let playerCastle = null;
  let enemyCastle = null;
  let playerBattery = null;
  let enemyBattery = null;
  let playerFront = [];
  let enemyFront = [];
  let garrison = null;
  // The strait as the two works lie: the range between them, and the elevations that strike the enemy's walls.
  let rangeM = 0;
  let wallBand = [0, 0];
  let enemyBand = [0, 0];
  let enemyMuzzles = [0, 0, 0];
  // What the normal game looked like, and the coast raised for the duel: both given back by stop().
  let savedScene = null;
  let raisedTerrain = null;

  let elevationDeg = 0; // Laid below the walls when the duel begins (begin).
  let traverseDeg = 0.0;
  let ammoType = 'round';
  let viewPreset = 'parapet'; // 'parapet' | 'embrasure' | 'spyglass' | 'channel' | 'free'
  let nextGunCursor = 0;

  let enemyCooldown = 3.2;
  let enemySalvoCount = 0;
  let winner = null; // null | 'player' | 'enemy' | 'draw'
  const bandText = () => `+${wallBand[0].toFixed(1)}° to +${wallBand[1].toFixed(1)}°`;
  const aimHint = () => `No arcs allowed! Elevate your guns (${bandText()}) to strike the walls of the Morro across the ${Math.round(rangeM)} m channel.`;
  let lastShotFeedback = '';
  let hudDirty = true;
  let hudTimer = 0;
  const playerStatus = {};
  const enemyStatus = {};
  // The fixed views: worked out when the view or the aim changes, copied to the camera each frame.
  const viewPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fovY: 0 };

  const cachedProjectiles = [];
  const cachedWorldFires = [];

  // While the duel runs, the normal game's controls are out of sight: its ships and voyage are waiting.
  if (!document.getElementById('castle-duel-style')) {
    const st = document.createElement('style');
    st.id = 'castle-duel-style';
    st.textContent = `
      body.castle-duel-active #hud,
      body.castle-duel-active #helm-controls,
      body.castle-duel-active #sailing-instruments,
      body.castle-duel-active #port-call,
      body.castle-duel-active #look-hint,
      body.castle-duel-active #key-list,
      body.castle-duel-active #landfall-discovery-banner,
      body.castle-duel-active #voyage-hud,
      body.castle-duel-active #camera-dock,
      body.castle-duel-active #captain-panel,
      body.castle-duel-active #boat-panel,
      body.castle-duel-active #camera-panel,
      body.castle-duel-active #landfall-panel,
      body.castle-duel-active #share-panel,
      body.castle-duel-active #chart-drawer,
      body.castle-duel-active #spyglass-overlay,
      body.castle-duel-active #encounter-notice {
        display: none !important;
      }
      /* The free camera's cannon sight: nothing here is aimed through it. */
      body.castle-duel-active::after {
        display: none !important;
      }
    `;
    document.head.appendChild(st);
  }

  // Launch buttons live in the debug panel and are bound through bindLaunchButton.
  const launchBtns = new Set();
  function setLaunchLabel(text) {
    for (const btn of launchBtns) btn.textContent = text;
  }
  function syncLaunchBtn() {
    setLaunchLabel(active ? '🏰 Exit Castle Duel' : '🏰 Castle Duel');
  }

  const hud = document.createElement('div');
  hud.id = 'castle-duel-hud';
  hud.hidden = true;
  Object.assign(hud.style, {
    position: 'fixed',
    left: '50%',
    bottom: '16px',
    transform: 'translateX(-50%)',
    zIndex: '1190',
    width: 'min(820px, calc(100vw - 24px))',
    padding: '12px 16px',
    borderRadius: '12px',
    border: '1px solid rgba(232, 186, 110, 0.48)',
    background: 'linear-gradient(180deg, rgba(28, 19, 12, 0.92), rgba(15, 10, 6, 0.95))',
    color: '#f4e2c6',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    boxShadow: '0 10px 32px rgba(0,0,0,0.65)',
    userSelect: 'none',
  });

  hud.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap;">
      <div id="cd-player-score" style="flex:1;min-width:210px;padding:6px 10px;border-radius:8px;background:rgba(45,95,65,0.28);border:1px solid rgba(110,205,145,0.35);">
        <div style="font-weight:700;color:#9ef0b8;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">🛡️ Your Castle · La Punta</div>
        <div id="cd-player-metrics" style="margin-top:3px;font-size:13px;"></div>
      </div>
      <div style="text-align:center;min-width:130px;">
        <div style="font-weight:800;font-size:14px;color:#ffd280;letter-spacing:0.04em;">⚔️ CASTLE DUEL ⚔️</div>
        <div style="font-size:11px;color:#cbb494;"><span id="cd-range">Havana, 1600</span> · ${CASTLE_DUEL_MUZZLE_SPEED_MPS} m/s · No Arcs</div>
      </div>
      <div id="cd-enemy-score" style="flex:1;min-width:210px;padding:6px 10px;border-radius:8px;background:rgba(120,38,32,0.32);border:1px solid rgba(235,105,90,0.38);text-align:right;">
        <div style="font-weight:700;color:#ff9e92;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">🎯 Enemy · El Morro</div>
        <div id="cd-enemy-metrics" style="margin-top:3px;font-size:13px;"></div>
      </div>
    </div>

    <div id="cd-banner" style="margin-bottom:9px;padding:6px 10px;border-radius:6px;background:rgba(255,215,130,0.10);border:1px solid rgba(255,215,130,0.24);color:#ffe2a8;font-size:12.5px;text-align:center;font-weight:500;">
      Havana, 1600: the Morro and La Punta across the channel.
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:220px;">
        <label style="font-weight:600;min-width:112px;color:#f3d5a5;">Elevation: <span id="cd-elev-val">+1.0°</span></label>
        <button type="button" id="cd-elev-down" style="padding:4px 8px;border-radius:5px;border:1px solid #8a6b43;background:#2b1d11;color:#f5dec0;cursor:pointer;">−</button>
        <input id="cd-elev-slider" type="range" min="-2" max="16" step="0.25" value="1.0" style="flex:1;accent-color:#e5a94c;cursor:pointer;" />
        <button type="button" id="cd-elev-up" style="padding:4px 8px;border-radius:5px;border:1px solid #8a6b43;background:#2b1d11;color:#f5dec0;cursor:pointer;">+</button>
      </div>

      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:220px;">
        <label style="font-weight:600;min-width:108px;color:#f3d5a5;">Traverse: <span id="cd-trav-val">0.0°</span></label>
        <button type="button" id="cd-trav-left" style="padding:4px 8px;border-radius:5px;border:1px solid #8a6b43;background:#2b1d11;color:#f5dec0;cursor:pointer;">◀</button>
        <input id="cd-trav-slider" type="range" min="-22" max="22" step="0.5" value="0" style="flex:1;accent-color:#e5a94c;cursor:pointer;" />
        <button type="button" id="cd-trav-right" style="padding:4px 8px;border-radius:5px;border:1px solid #8a6b43;background:#2b1d11;color:#f5dec0;cursor:pointer;">▶</button>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;flex-wrap:wrap;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" id="cd-fire-one" style="padding:7px 14px;border-radius:7px;border:1px solid #f2b45c;background:linear-gradient(180deg,#b8541a,#7d310a);color:#fff4e0;font-weight:700;cursor:pointer;">🔥 Fire Gun (Space)</button>
        <button type="button" id="cd-fire-salvo" style="padding:7px 14px;border-radius:7px;border:1px solid #ff9c6b;background:linear-gradient(180deg,#9c2718,#631309);color:#ffe8e0;font-weight:700;cursor:pointer;">💥 Fire Salvo (F)</button>
        <button type="button" id="cd-ammo-btn" style="padding:7px 11px;border-radius:7px;border:1px solid #8a6b43;background:#2d1f12;color:#f3d5a5;font-weight:600;cursor:pointer;">Ammo: Round Shot</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" id="cd-view-btn" style="padding:6px 10px;border-radius:7px;border:1px solid #8a6b43;background:#261a10;color:#e8cfa6;cursor:pointer;">📷 View: Parapet</button>
        <button type="button" id="cd-night-btn" style="padding:6px 10px;border-radius:7px;border:1px solid #8a6b43;background:#261a10;color:#e8cfa6;cursor:pointer;">🌙 Night Battle</button>
        <button type="button" id="cd-reset-btn" style="padding:6px 10px;border-radius:7px;border:1px solid #8a6b43;background:#261a10;color:#e8cfa6;cursor:pointer;">🔄 Rematch</button>
        <button type="button" id="cd-exit-btn" style="padding:6px 10px;border-radius:7px;border:1px solid rgba(220,100,90,0.5);background:#3a1815;color:#ffbfb8;cursor:pointer;">✕ Exit</button>
      </div>
    </div>
  `;
  document.body.appendChild(hud);

  const elPlayerMetrics = hud.querySelector('#cd-player-metrics');
  const elEnemyMetrics = hud.querySelector('#cd-enemy-metrics');
  const elBanner = hud.querySelector('#cd-banner');
  const elElevVal = hud.querySelector('#cd-elev-val');
  const elTravVal = hud.querySelector('#cd-trav-val');
  const elElevSlider = hud.querySelector('#cd-elev-slider');
  const elTravSlider = hud.querySelector('#cd-trav-slider');
  const elAmmoBtn = hud.querySelector('#cd-ammo-btn');
  const elViewBtn = hud.querySelector('#cd-view-btn');
  const elNightBtn = hud.querySelector('#cd-night-btn');

  const VIEW_ORDER = ['parapet', 'embrasure', 'spyglass', 'channel', 'free'];
  const VIEW_LABELS = {
    parapet: '📷 View: Parapet',
    embrasure: '📷 View: Embrasure',
    spyglass: '🔭 View: Spyglass',
    channel: '🌊 View: Channel',
    free: '🕊️ View: Free Cam',
  };

  // Where a fixed view stands and looks, from the player's guns toward the enemy's. It moves only when the view or the
  // aim does.
  let playerMuzzles = [0, 0, 0];
  function refreshViewPose() {
    if (!playerCastle || !enemyCastle || viewPreset === 'free') return;
    const [mx, my, mz] = playerMuzzles, dx = enemyCastle.x - mx, dz = enemyCastle.z - mz, length = Math.hypot(dx, dz) || 1;
    const fx = dx / length, fz = dz / length, rx = -fz, rz = fx, ahead = Math.atan2(fx, -fz);
    const travRad = (traverseDeg * Math.PI) / 180;
    const pose = viewPose;
    if (viewPreset === 'parapet') {
      pose.x = mx - fx * 6 + rx * Math.sin(travRad) * 2.0;
      pose.y = my + 2.25;
      pose.z = mz - fz * 6 + rz * Math.sin(travRad) * 2.0;
      pose.yaw = ahead + travRad * 0.65;
      pose.pitch = -0.04 + Math.max(0, elevationDeg - 5) * 0.007;
      pose.fovY = (52 * Math.PI) / 180;
    } else if (viewPreset === 'embrasure') {
      pose.x = mx - fx * 1.5 + rx * 2.1;
      pose.y = my + 1.25;
      pose.z = mz - fz * 1.5 + rz * 2.1;
      pose.yaw = ahead + travRad * 0.85;
      pose.pitch = (elevationDeg * 0.45 * Math.PI) / 180;
      pose.fovY = (46 * Math.PI) / 180;
    } else if (viewPreset === 'spyglass') {
      pose.x = mx - fx * 3;
      pose.y = my + 2.4;
      pose.z = mz - fz * 3;
      pose.yaw = ahead + travRad * 0.9;
      pose.pitch = -0.015;
      pose.fovY = (20 * Math.PI) / 180;
    } else if (viewPreset === 'channel') {
      // From the water off the channel's middle, on whichever hand is open water.
      const terrain = getTerrain?.(), cx = (mx + enemyCastle.x) * 0.5, cz = (mz + enemyCastle.z) * 0.5, off = Math.max(135, length * 0.45);
      const hRight = typeof terrain?.height === 'function' ? terrain.height(cx + rx * off, cz + rz * off) : -10;
      const hLeft = typeof terrain?.height === 'function' ? terrain.height(cx - rx * off, cz - rz * off) : -10;
      const hand = hRight < hLeft ? 1 : -1;
      pose.x = cx + rx * off * hand;
      pose.y = 22;
      pose.z = cz + rz * off * hand;
      pose.yaw = Math.atan2(-rx * hand, rz * hand);
      pose.pitch = -0.10;
      pose.fovY = (56 * Math.PI) / 180;
    }
  }

  function applyViewPose() {
    if (viewPreset === 'free') return;
    const cam = getCamera?.();
    if (!cam) return;
    cam.x = viewPose.x;
    cam.y = viewPose.y;
    cam.z = viewPose.z;
    cam.yaw = viewPose.yaw;
    cam.pitch = viewPose.pitch;
    cam.fovY = viewPose.fovY;
  }

  function syncAimUI() {
    elElevVal.textContent = `${elevationDeg >= 0 ? '+' : ''}${elevationDeg.toFixed(1)}°`;
    elTravVal.textContent = `${traverseDeg >= 0 ? '+' : ''}${traverseDeg.toFixed(1)}°`;
    elElevSlider.value = String(elevationDeg);
    elTravSlider.value = String(traverseDeg);
    if (playerBattery) applyGunAim(playerBattery, playerFront, enemyCastle, elevationDeg, traverseDeg);
    refreshViewPose();
  }

  function setElevation(deg) {
    elevationDeg = Math.round(Math.max(-2, Math.min(16, Number(deg) || 0)) * 4) / 4;
    syncAimUI();
    return elevationDeg;
  }

  function setTraverse(deg) {
    traverseDeg = Math.round(Math.max(-22, Math.min(22, Number(deg) || 0)) * 2) / 2;
    syncAimUI();
    return traverseDeg;
  }

  function setAmmo(nextAmmo) {
    ammoType = nextAmmo === 'hot' ? 'hot' : 'round';
    if (playerBattery) playerBattery.setAmmo(ammoType);
    elAmmoBtn.textContent = ammoType === 'hot' ? '🔥 Ammo: Hot Shot' : '⚫ Ammo: Round Shot';
    return ammoType;
  }

  function setView(preset) {
    if (!VIEW_ORDER.includes(preset)) return viewPreset;
    viewPreset = preset;
    elViewBtn.textContent = VIEW_LABELS[viewPreset];
    refreshViewPose();
    if (active) applyViewPose();
    return viewPreset;
  }

  function say(text) {
    lastShotFeedback = text;
    hudDirty = true;
  }

  // What the player's last shot did, read from where it fell and from the Morro's own state.
  function handleDuelEvent(sideLabel, prefix, event) {
    onShoreShot?.(prefix, event);
    hudDirty = true;
    if (event.type !== 'impact' || sideLabel !== 'player' || !playerCastle || !enemyCastle) return;
    const struck = event.building?.workBuilding ?? event.building;
    if (event.kind === 'water') {
      const [sx, , sz] = event.surfacePosition ?? event.position ?? playerMuzzles;
      const out = Math.hypot(sx - playerMuzzles[0], sz - playerMuzzles[2]), shortBy = Math.round(rangeM - out);
      if (shortBy > CASTLE_DUEL_SPLASH_NEAR_M) {
        lastShotFeedback = `🌊 Splash in the channel, ${Math.round(out)} m out and ${shortBy} m short. Raise the guns (${bandText()}).`;
      } else if (shortBy < -CASTLE_DUEL_SPLASH_NEAR_M) {
        lastShotFeedback = `🌊 Over the Morro, ${Math.round(out)} m out. Lower the guns a little.`;
      } else {
        lastShotFeedback = `🌊 Splash at the foot of the Morro (${Math.round(out)} m). Raise the guns to ${bandText()} to strike its walls.`;
      }
    } else if (event.kind === 'building' && struck === enemyCastle) {
      const status = castleDuelStatus(enemyCastle, enemyFront, enemyStatus);
      if (status.magazineExploded) {
        lastShotFeedback = `💥 The Morro's powder magazine has gone up!`;
      } else {
        const down = status.totalGuns - status.activeGuns;
        lastShotFeedback = `🎯 Hit on the Morro: walls ${status.integrityPct}%, ${down ? `${down} of its ${status.totalGuns} guns dismounted` : 'its guns still mounted'}.`;
      }
    } else if (event.kind === 'building' || event.kind === 'terrain') {
      lastShotFeedback = `🪨 The ball struck the shore short of the Morro's walls. Lay the guns along the channel.`;
    }
  }

  // The pieces of a work that a ball has struck: each stands whole again for a rematch.
  function restoreWork(castle) {
    const terrain = getTerrain?.();
    for (const piece of duelPort.instances) {
      if (piece.workBuilding !== castle || !piece.damageState?.hits) continue;
      terrain?.rebuildPortBuilding?.(piece);
      piece.damageState = null;
      piece.magazine = null;
      createBuildingDamageState(piece);
    }
    castle.damageState = null;
    castle.magazine = null;
    castle.gunnery = null;
    createBuildingDamageState(castle);
    reviveGarrisonSoldiers(castle);
  }

  // Whole walls, a full magazine and the garrison back at its posts in both works: at the start and for a rematch.
  function manCastles() {
    garrison = duelPort.garrison ?? createFortGarrison(duelPort);
    restoreWork(playerCastle);
    restoreWork(enemyCastle);
  }

  // Each work's guns that bear on the other, where they fire from, and the walls they strike.
  function mountBatteries() {
    playerBattery = createBuildingGunnery(playerCastle, {
      onEvent: (ev) => handleDuelEvent('player', 'duel-p-', ev),
      getTerrain,
      town: duelPort,
    });
    enemyBattery = createBuildingGunnery(enemyCastle, {
      onEvent: (ev) => handleDuelEvent('enemy', 'duel-e-', ev),
      getTerrain,
      town: duelPort,
    });
    configureCastleDuelBattery(playerBattery);
    configureCastleDuelBattery(enemyBattery);
    playerFront = castleDuelFrontGuns(playerBattery, enemyCastle);
    enemyFront = castleDuelFrontGuns(enemyBattery, playerCastle);
    if (!playerFront.length || !enemyFront.length) return false;
    playerMuzzles = castleDuelMuzzles(playerCastle, playerFront);
    enemyMuzzles = castleDuelMuzzles(enemyCastle, enemyFront);
    const playerWall = castleDuelWall(playerCastle, playerFront), enemyWall = castleDuelWall(enemyCastle, enemyFront);
    rangeM = Math.hypot(enemyWall[0] - playerMuzzles[0], enemyWall[2] - playerMuzzles[2]);
    wallBand = castleDuelWallElevation(playerMuzzles, enemyWall);
    enemyBand = castleDuelWallElevation(enemyMuzzles, playerWall);

    winner = null;
    enemyCooldown = 3.0;
    enemySalvoCount = 0;
    nextGunCursor = 0;
    lastShotFeedback = aimHint();
    setAmmo(ammoType);
    syncAimUI();
    refreshHud();
    return true;
  }

  // The duel is fought on the works the board stood at Havana in 1600. False, with nothing of the normal game touched,
  // where this coast has not both.
  function takeArena(terrain) {
    const port = terrain?.port, castles = port ? castleDuelCastles(port, place) : null;
    if (!castles) return false;
    duelPort = port;
    // No part of the career: what is shot down here is never written to the save.
    duelPort.transient = true;
    playerCastle = castles.player;
    enemyCastle = castles.enemy;
    manCastles();
    if (mountBatteries()) return true;
    clearArena();
    return false;
  }

  function clearArena() {
    duelPort = null;
    playerCastle = null;
    enemyCastle = null;
    playerBattery = null;
    enemyBattery = null;
    playerFront = [];
    enemyFront = [];
    garrison = null;
  }

  // The same stone stands again: nothing is raised anew but the struck pieces, the garrison and the guns' state.
  function rematch() {
    if (!active || !duelPort) return false;
    manCastles();
    if (!mountBatteries()) {
      stop();
      return false;
    }
    return true;
  }

  function magazineDry(castle) {
    const magazine = castle?.magazine;
    return Boolean(magazine) && (magazine.exploded || !(magazine.powderKg > 0));
  }

  // Fires what is loaded: the next ready gun, or every ready gun for a salvo. A fired gun must be
  // swabbed, loaded and run out again before it can speak.
  const oneGun = [null];
  function firePlayerGun(salvo = false) {
    if (!active || !playerBattery || winner) return 0;
    if (magazineDry(playerCastle)) {
      say('🪣 The magazine is empty: La Punta has no powder left to fire.');
      return 0;
    }
    applyGunAim(playerBattery, playerFront, enemyCastle, elevationDeg, traverseDeg);
    let fired = 0;
    if (salvo) {
      fired = fireCastleDuelGuns(playerBattery, playerFront, { interval: 0.12, ammo: ammoType });
    } else {
      const count = playerFront.length;
      for (let i = 0; i < count && !fired; i++) {
        const gun = playerFront[(nextGunCursor + i) % count];
        if (gun.dismounted || gun.stage !== 'ready' || gun.queued) continue;
        oneGun[0] = gun;
        fired = fireCastleDuelGuns(playerBattery, oneGun, { interval: 0.04, ammo: ammoType });
        if (fired) nextGunCursor = (nextGunCursor + i + 1) % count;
      }
      oneGun[0] = null;
    }
    if (!fired) say('⏳ No gun is loaded yet: the crews are still swabbing and ramming.');
    else hudDirty = true;
    return fired;
  }

  const enemyVolley = [];
  function fireEnemyAI() {
    if (!active || !enemyBattery || !playerCastle || winner || magazineDry(enemyCastle)) return 0;
    const wanted = enemySalvoCount === 0 ? 2 : 3;
    enemyVolley.length = 0;
    for (const gun of enemyFront) {
      if (enemyVolley.length >= wanted) break;
      if (!gun.dismounted && gun.stage === 'ready' && !gun.queued) enemyVolley.push(gun);
    }
    if (!enemyVolley.length) return 0;
    enemySalvoCount++;
    // The first volley falls short at the foot of the player's walls; later ones walk up onto them.
    const middle = (enemyBand[0] + enemyBand[1]) * 0.5;
    const baseElev = enemySalvoCount === 1 ? enemyBand[0] - 0.6 : middle;
    const jitterElev = (Math.sin(enemySalvoCount * 2.3) * 0.45) + (Math.random() - 0.5) * 0.45;
    const jitterTrav = (Math.cos(enemySalvoCount * 1.7) * 1.2) + (Math.random() - 0.5) * 1.0;
    enemyBattery.setAmmo(enemySalvoCount % 3 === 0 ? 'hot' : 'round');
    applyGunAim(enemyBattery, enemyFront, playerCastle, baseElev + jitterElev, jitterTrav);
    const fired = fireCastleDuelGuns(enemyBattery, enemyVolley, { interval: 0.18, ammo: enemyBattery.state.ammo });
    enemyVolley.length = 0;
    return fired;
  }

  const SILENCED_BY = {
    magazine: 'magazine blown',
    walls: 'walls in ruin',
    guns: 'every gun dismounted',
    garrison: 'garrison fallen',
    powder: 'powder spent',
  };
  function metricsText(s) {
    const powder = s.powderKg === null ? '' : ` · Powder ${s.powderKg >= 1000 ? `${(s.powderKg / 1000).toFixed(1)} t` : `${Math.round(s.powderKg)} kg`}`;
    return `Walls ${s.integrityPct}% · Guns ${s.activeGuns}/${s.totalGuns} (${s.readyGuns} loaded) · Garrison ${s.ableSoldiers}/${s.totalSoldiers}${powder}${s.fires ? ` · 🔥${s.fires}` : ''}`;
  }

  // Written when something has happened and a few times a second besides, and only what has changed.
  let shownPlayer = '', shownEnemy = '', shownBanner = '', shownMood = '';
  function refreshHud() {
    hudDirty = false;
    hudTimer = CASTLE_DUEL_HUD_PERIOD_S;
    if (!playerCastle || !enemyCastle) return;
    const pStat = castleDuelStatus(playerCastle, playerFront, playerStatus);
    const eStat = castleDuelStatus(enemyCastle, enemyFront, enemyStatus);
    const playerText = metricsText(pStat), enemyText = metricsText(eStat);
    if (playerText !== shownPlayer) elPlayerMetrics.textContent = shownPlayer = playerText;
    if (enemyText !== shownEnemy) elEnemyMetrics.textContent = shownEnemy = enemyText;

    if (!winner) {
      if (eStat.defeated && pStat.defeated) {
        winner = 'draw';
        lastShotFeedback = `⚖️ MUTUAL DESTRUCTION! Both works have been silenced (${SILENCED_BY[pStat.silencedBy]}; ${SILENCED_BY[eStat.silencedBy]}). Click Rematch to play again.`;
      } else if (eStat.defeated) {
        winner = 'player';
        lastShotFeedback = `🏆 VICTORY! The Morro has been silenced (${SILENCED_BY[eStat.silencedBy]})! La Punta holds the mouth of Havana!`;
      } else if (pStat.defeated) {
        winner = 'enemy';
        lastShotFeedback = `💀 DEFEAT! La Punta has been silenced (${SILENCED_BY[pStat.silencedBy]})! Click Rematch to try again.`;
      }
    }
    if (lastShotFeedback !== shownBanner) elBanner.textContent = shownBanner = lastShotFeedback;
    const mood = winner === 'player' ? 'won' : winner === 'enemy' ? 'lost' : 'open';
    if (mood === shownMood) return;
    shownMood = mood;
    if (mood === 'won') {
      elBanner.style.background = 'rgba(46, 160, 88, 0.28)';
      elBanner.style.borderColor = 'rgba(110, 235, 150, 0.65)';
      elBanner.style.color = '#b8ffcf';
    } else if (mood === 'lost') {
      elBanner.style.background = 'rgba(180, 42, 36, 0.32)';
      elBanner.style.borderColor = 'rgba(255, 110, 100, 0.65)';
      elBanner.style.color = '#ffc2bc';
    } else {
      elBanner.style.background = 'rgba(255, 215, 130, 0.10)';
      elBanner.style.borderColor = 'rgba(255, 215, 130, 0.24)';
      elBanner.style.color = '#ffe2a8';
    }
  }

  function syncNightBtn() {
    elNightBtn.textContent = (getSunElevation?.() ?? 20) < 0 ? '☀️ Day Battle' : '🌙 Night Battle';
  }

  function begin() {
    if (active) return true;
    const terrain = getTerrain?.();
    if (!terrain || !takeArena(terrain)) return false;
    // The guns start laid low: the first shot falls short at the foot of the Morro until they are raised.
    setElevation(Math.floor((wallBand[0] - 1) * 4) / 4);
    // Only now is anything of the normal game borrowed: all of it goes back in stop().
    savedScene = saveScene?.() ?? null;
    active = true;
    hud.hidden = false;
    document.body.classList.add('castle-duel-active');
    setCameraMode?.('free');
    refreshViewPose();
    applyViewPose();
    syncNightBtn();
    syncLaunchBtn();
    return true;
  }

  /**
   * Starts the duel: Havana in 1600 is raised at open sea, clear of the ship. A promise of true once it is running, or
   * false (at once, off a coast) when it cannot be played.
   */
  let startingPromise = null;
  function start() {
    if (active) return true;
    if (startingPromise) return startingPromise;
    if (getTerrain?.() || typeof ensureTerrain !== 'function') {
      onNotice?.(`The duel is fought at the mouth of ${place.name} in ${place.year}, raised for it at open sea: put out from this coast first.`);
      return false;
    }
    setLaunchLabel(`⏳ Raising ${place.name}…`);
    const failed = (raised) => {
      if (raised) disposeTerrain?.(raised);
      onNotice?.(`${place.name} in ${place.year} could not be raised with both its castles.`);
      syncLaunchBtn();
      return false;
    };
    startingPromise = Promise.resolve().then(() => ensureTerrain(place)).then((raised) => {
      startingPromise = null;
      if (!raised || getTerrain?.() !== raised || !begin()) return failed(raised);
      raisedTerrain = raised;
      return true;
    }, () => {
      startingPromise = null;
      return failed(null);
    });
    return startingPromise;
  }

  function stop() {
    if (!active) return;
    active = false;
    hud.hidden = true;
    document.body.classList.remove('castle-duel-active');
    restoreScene?.(savedScene);
    savedScene = null;
    clearArena();
    if (raisedTerrain) {
      disposeTerrain?.(raisedTerrain);
      raisedTerrain = null;
    }
    cachedProjectiles.length = 0;
    cachedWorldFires.length = 0;
    syncLaunchBtn();
  }

  function bindLaunchButton(btn, onClosePanel = null) {
    if (!btn) return;
    launchBtns.add(btn);
    syncLaunchBtn();
    btn.addEventListener('click', () => {
      if (active) {
        stop();
        return;
      }
      // The panel stays up while a coast is being raised, so its label can say so, and when the
      // duel is refused: it closes only once the duel is running.
      const running = start();
      if (running === true) onClosePanel?.();
      else if (running) running.then((ok) => { if (ok) onClosePanel?.(); });
    });
  }

  hud.querySelector('#cd-elev-down').addEventListener('click', () => setElevation(elevationDeg - 0.5));
  hud.querySelector('#cd-elev-up').addEventListener('click', () => setElevation(elevationDeg + 0.5));
  elElevSlider.addEventListener('input', (e) => setElevation(parseFloat(e.target.value)));
  hud.querySelector('#cd-trav-left').addEventListener('click', () => setTraverse(traverseDeg - 1.0));
  hud.querySelector('#cd-trav-right').addEventListener('click', () => setTraverse(traverseDeg + 1.0));
  elTravSlider.addEventListener('input', (e) => setTraverse(parseFloat(e.target.value)));
  hud.querySelector('#cd-fire-one').addEventListener('click', () => firePlayerGun(false));
  hud.querySelector('#cd-fire-salvo').addEventListener('click', () => firePlayerGun(true));
  elAmmoBtn.addEventListener('click', () => setAmmo(ammoType === 'round' ? 'hot' : 'round'));
  elViewBtn.addEventListener('click', () => setView(VIEW_ORDER[(VIEW_ORDER.indexOf(viewPreset) + 1) % VIEW_ORDER.length]));
  elNightBtn.addEventListener('click', () => {
    if (!active || typeof setSunElevation !== 'function') return;
    setSunElevation((getSunElevation?.() ?? 20) < 0 ? 24 : -18);
    syncNightBtn();
  });
  hud.querySelector('#cd-reset-btn').addEventListener('click', () => rematch());
  hud.querySelector('#cd-exit-btn').addEventListener('click', () => stop());

  // The aim keys may be held; a held fire key fires once. In the free view W A S D fly the camera
  // (main.js lets those through), so only the arrows lay the guns there.
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const fixedView = viewPreset !== 'free';
    if (e.code === 'ArrowUp' || (fixedView && e.code === 'KeyW')) {
      e.preventDefault();
      setElevation(elevationDeg + 0.5);
    } else if (e.code === 'ArrowDown' || (fixedView && e.code === 'KeyS')) {
      e.preventDefault();
      setElevation(elevationDeg - 0.5);
    } else if (e.code === 'ArrowLeft' || (fixedView && e.code === 'KeyA')) {
      e.preventDefault();
      setTraverse(traverseDeg - 1.0);
    } else if (e.code === 'ArrowRight' || (fixedView && e.code === 'KeyD')) {
      e.preventDefault();
      setTraverse(traverseDeg + 1.0);
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) firePlayerGun(false);
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      if (!e.repeat) firePlayerGun(true);
    }
  });

  return {
    get active() { return active; },
    // True while the player flies the camera himself, so the fly keys are his.
    get freeView() { return active && viewPreset === 'free'; },
    get port() { return duelPort; },
    get playerCastle() { return playerCastle; },
    get enemyCastle() { return enemyCastle; },
    get playerBattery() { return playerBattery; },
    get enemyBattery() { return enemyBattery; },
    get elevation() { return elevationDeg; },
    get traverse() { return traverseDeg; },
    get winner() { return winner; },
    get projectiles() {
      cachedProjectiles.length = 0;
      if (!active) return cachedProjectiles;
      if (playerBattery?.state?.projectiles) {
        for (const p of playerBattery.state.projectiles) cachedProjectiles.push(p);
      }
      if (enemyBattery?.state?.projectiles) {
        for (const p of enemyBattery.state.projectiles) cachedProjectiles.push(p);
      }
      return cachedProjectiles;
    },
    get worldFires() {
      cachedWorldFires.length = 0;
      if (!active || !duelPort?.instances) return cachedWorldFires;
      for (const inst of duelPort.instances) {
        const list = inst.damageState?.worldFires;
        if (list) for (const f of list) cachedWorldFires.push(f);
      }
      return cachedWorldFires;
    },
    start,
    stop,
    bindLaunchButton,
    rematch,
    setElevation,
    setTraverse,
    setAmmo,
    setView,
    fire: firePlayerGun,
    fireEnemy: fireEnemyAI,
    status() {
      return {
        active,
        place,
        rangeM,
        wallBand: [...wallBand],
        elevationDeg,
        traverseDeg,
        ammoType,
        viewPreset,
        winner,
        lastShotFeedback,
        player: castleDuelStatus(playerCastle, playerFront),
        enemy: castleDuelStatus(enemyCastle, enemyFront),
      };
    },
    update(dt, windVec = CASTLE_DUEL_STILL_AIR) {
      if (!active || !duelPort) return;
      if (dt > 0) {
        stepPortDamage(duelPort, dt);
        if (garrison) {
          stepFortGarrison(garrison, dt, Math.hypot(windVec[0] ?? 0, windVec[2] ?? 0));
        }
        // Every fired gun goes straight back through its drill.
        for (const side of ['port', 'starboard']) {
          prepareGunnery(playerBattery.state, side);
          prepareGunnery(enemyBattery.state, side);
        }
        playerBattery.update(dt, windVec, CASTLE_DUEL_BATTERY_STEP);
        enemyBattery.update(dt, windVec, CASTLE_DUEL_BATTERY_STEP);

        if (!winner) {
          enemyCooldown -= dt;
          if (enemyCooldown <= 0) {
            fireEnemyAI();
            enemyCooldown = 4.6 + Math.random() * 1.4;
          }
        }
        hudTimer -= dt;
      }
      applyViewPose();
      if (hudDirty || hudTimer <= 0) refreshHud();
    },
  };
}
