// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// "Two Castles" Cannon Duel Side Game:
// Two manned 16th-century star-bastioned stone sea fortresses face each other across a 280 m channel.
// No aiming arcs allowed — players must elevate their guns (about +2° to +4°) and adjust traverse
// by watching where their roundshot and hot shot strike.
//
// It is a debug side game played on the normal game's coast. While it runs the normal game waits:
// main.js stops stepping ships and the voyage, and this controller puts back everything it borrowed
// (the port, the camera, the sky, a coast it had to raise) when it stops.

import { buildPortPrefabGeometry } from './terrain-model.js';
import {
  createBuildingDamageState,
  createBuildingGunnery,
  stepPortDamage,
} from './gunnery-control.js';
import { createFortGarrison, stepFortGarrison } from './crew.js';
import { fireGunnery, prepareGunnery } from './gunnery-state.js';

export const CASTLE_DUEL_DISTANCE_M = 280;
export const CASTLE_DUEL_MUZZLE_SPEED_MPS = 300;
// Water the duel wants to itself: the channel between the castles and the camera stations beside it.
const CASTLE_DUEL_CLEAR_X_M = 180;
const CASTLE_DUEL_CLEAR_Z_M = 220;
const CASTLE_DUEL_RINGS_M = Object.freeze([320, 440, 560, 700, 860]);
// The score panel is read a few times a second; a hit or a shot refreshes it at once.
const CASTLE_DUEL_HUD_PERIOD_S = 0.5;
const CASTLE_DUEL_STILL_AIR = Object.freeze([0, 0, 0]);
const CASTLE_DUEL_BATTERY_STEP = Object.freeze({ skipBuildingDamage: true });
// The elevations that strike the enemy's walls across the strait: laid lower the shot finds the foundation
// under them, laid higher it clears the parapet. tests/castle-duel.test.mjs holds these to the ballistics.
export const CASTLE_DUEL_WALL_ELEVATION_DEG = Object.freeze([2, 4]);
const CASTLE_DUEL_ELEVATION_HINT = `+${CASTLE_DUEL_WALL_ELEVATION_DEG[0].toFixed(1)}° to +${CASTLE_DUEL_WALL_ELEVATION_DEG[1].toFixed(1)}°`;
const CASTLE_DUEL_AIM_HINT = `No arcs allowed! Elevate your guns (${CASTLE_DUEL_ELEVATION_HINT}) to strike the walls of Fuerte del Moro across the ${CASTLE_DUEL_DISTANCE_M} m strait.`;

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

// The guns that bear across the strait: found once when a battery is raised, never per frame.
function castleDuelFrontGuns(battery) {
  if (!battery?.state?.guns) return [];
  return battery.state.guns.filter(
    (g) => g.side === 'port' && Math.abs(g.directionDesign?.[2] ?? 0) > 0.8,
  );
}

function applyGunAim(battery, frontGuns, elevationDeg, traverseDeg) {
  if (!battery?.building) return;
  const elev = Math.max(-4, Math.min(18, Number(elevationDeg) || 0));
  const trav = Math.max(-28, Math.min(28, Number(traverseDeg) || 0));
  const travRad = (trav * Math.PI) / 180;
  const sinT = Math.sin(travRad), cosT = Math.cos(travRad);
  battery.building.gunneryElevation = elev;
  battery.building.gunneryTraverse = trav;
  for (const g of frontGuns) {
    g.elevation = elev;
    g.aimDirectionLocal = [sinT, 0, -cosT];
    g.aimPoint = null;
  }
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
 * Open water for the two castles, off the port and seaward first. Water a ship is lying in is
 * taken only when there is no other: the duel never moves a ship of the normal game.
 */
export function chooseCastleDuelArena(terrain, vessels = []) {
  const portRef = terrain?.port;
  const baseX = portRef?.center?.x ?? 0;
  const baseZ = portRef?.center?.z ?? -420;
  const seaX = portRef?.seaDir?.x ?? 0;
  const seaZ = portRef?.seaDir?.z ?? -1;
  const arena = { x: baseX + seaX * 380, z: baseZ + seaZ * 380 };
  if (typeof terrain?.height !== 'function') return arena;
  const occupied = (cx, cz) => {
    for (const v of vessels) {
      const b = v?.boat ?? v;
      if (!b || b.showProw === false) continue;
      if (Math.abs((b.x ?? 0) - cx) < CASTLE_DUEL_CLEAR_X_M && Math.abs((b.z ?? 0) - cz) < CASTLE_DUEL_CLEAR_Z_M) return true;
    }
    return false;
  };
  let bestScore = Infinity;
  const baseAngle = Math.atan2(seaZ, seaX);
  for (const dist of CASTLE_DUEL_RINGS_M) {
    for (let k = 0; k < 16; k++) {
      const ang = baseAngle + (k * Math.PI * 2) / 16;
      const cx = baseX + Math.cos(ang) * dist;
      const cz = baseZ + Math.sin(ang) * dist;
      const maxBed = Math.max(
        terrain.height(cx, cz),
        terrain.height(cx, cz + 115),
        terrain.height(cx, cz - 115),
        Math.min(terrain.height(cx - 140, cz), terrain.height(cx + 140, cz)),
      );
      const score = maxBed + (occupied(cx, cz) ? 1000 : 0);
      if (score < bestScore) {
        bestScore = score;
        arena.x = cx;
        arena.z = cz;
      }
      if (bestScore < -4.0) return arena;
    }
  }
  return arena;
}

/**
 * @param {object} cfg
 *  getTerrain(): terrain|null. ensureTerrain(): Promise<terrain|null> raises a coast when there is
 *  none, and disposeTerrain(terrain) takes it away again when the duel stops.
 *  saveScene(): whatever the normal game needs to put its view and sky back (camera, field of view,
 *  camera mode, sun); restoreScene(saved) puts it back. The duel treats it as opaque.
 *  getVessels(): the fleet, to site the castles clear of it. getCamera(), setCameraMode(mode).
 *  getSunElevation(): degrees; setSunElevation(degrees) sets the sun by hand, whatever the sky mode.
 *  onNotice(text): a line for the player when the duel cannot be played here.
 */
export function createCastleDuelController({
  getTerrain,
  ensureTerrain,
  disposeTerrain,
  getVessels,
  getCamera,
  setCameraMode,
  saveScene,
  restoreScene,
  getSunElevation,
  setSunElevation,
  onShoreShot,
  onNotice,
}) {
  let active = false;
  let duelPort = null;
  let duelGeo = null;
  let playerCastle = null;
  let enemyCastle = null;
  let playerBattery = null;
  let enemyBattery = null;
  let playerFront = [];
  let enemyFront = [];
  let garrison = null;
  // What the normal game looked like, and a coast raised only for the duel: both given back by stop().
  let savedScene = null;
  let raisedTerrain = null;

  let elevationDeg = 1.0; // Starts low: the first shot strikes the foundation under the enemy's walls until the guns are raised.
  let traverseDeg = 0.0;
  let ammoType = 'round';
  let viewPreset = 'parapet'; // 'parapet' | 'embrasure' | 'spyglass' | 'channel' | 'free'
  let nextGunCursor = 0;

  let enemyCooldown = 3.2;
  let enemySalvoCount = 0;
  let winner = null; // null | 'player' | 'enemy' | 'draw'
  let lastShotFeedback = CASTLE_DUEL_AIM_HINT;
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
        <div style="font-weight:700;color:#9ef0b8;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">🛡️ Your Castle · San Felipe</div>
        <div id="cd-player-metrics" style="margin-top:3px;font-size:13px;"></div>
      </div>
      <div style="text-align:center;min-width:130px;">
        <div style="font-weight:800;font-size:14px;color:#ffd280;letter-spacing:0.04em;">⚔️ CASTLE DUEL ⚔️</div>
        <div style="font-size:11px;color:#cbb494;">Range: ${CASTLE_DUEL_DISTANCE_M} m · ${CASTLE_DUEL_MUZZLE_SPEED_MPS} m/s · No Arcs</div>
      </div>
      <div id="cd-enemy-score" style="flex:1;min-width:210px;padding:6px 10px;border-radius:8px;background:rgba(120,38,32,0.32);border:1px solid rgba(235,105,90,0.38);text-align:right;">
        <div style="font-weight:700;color:#ff9e92;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">🎯 Enemy · Fuerte del Moro</div>
        <div id="cd-enemy-metrics" style="margin-top:3px;font-size:13px;"></div>
      </div>
    </div>

    <div id="cd-banner" style="margin-bottom:9px;padding:6px 10px;border-radius:6px;background:rgba(255,215,130,0.10);border:1px solid rgba(255,215,130,0.24);color:#ffe2a8;font-size:12.5px;text-align:center;font-weight:500;">
      ${CASTLE_DUEL_AIM_HINT}
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

  // Where a fixed view stands and looks. It moves only when the view or the aim does.
  function refreshViewPose() {
    if (!playerCastle || !enemyCastle || viewPreset === 'free') return;
    const yTop = (playerCastle.y ?? 1.6) + (playerCastle.height ?? 7.6);
    const travRad = (traverseDeg * Math.PI) / 180;
    const pose = viewPose;
    if (viewPreset === 'parapet') {
      pose.x = playerCastle.x + Math.sin(travRad) * 2.0;
      pose.y = yTop + 2.25;
      pose.z = playerCastle.z - 11.4;
      pose.yaw = travRad * 0.65;
      pose.pitch = -0.04 + Math.max(0, elevationDeg - 5) * 0.007;
      pose.fovY = (52 * Math.PI) / 180;
    } else if (viewPreset === 'embrasure') {
      pose.x = playerCastle.x + 2.1;
      pose.y = yTop + 1.25;
      pose.z = playerCastle.z - 14.2;
      pose.yaw = travRad * 0.85;
      pose.pitch = (elevationDeg * 0.45 * Math.PI) / 180;
      pose.fovY = (46 * Math.PI) / 180;
    } else if (viewPreset === 'spyglass') {
      pose.x = playerCastle.x;
      pose.y = yTop + 2.4;
      pose.z = playerCastle.z - 15.2;
      pose.yaw = travRad * 0.9;
      pose.pitch = -0.015;
      pose.fovY = (20 * Math.PI) / 180;
    } else if (viewPreset === 'channel') {
      const terrain = getTerrain?.();
      const midZ = 0.5 * (playerCastle.z + enemyCastle.z);
      const hWest = typeof terrain?.height === 'function' ? terrain.height(playerCastle.x - 135, midZ) : -10;
      const hEast = typeof terrain?.height === 'function' ? terrain.height(playerCastle.x + 135, midZ) : -10;
      const useEast = hEast < hWest;
      pose.x = playerCastle.x + (useEast ? 135 : -135);
      pose.y = 22;
      pose.z = midZ;
      pose.yaw = useEast ? -Math.PI * 0.5 : Math.PI * 0.5;
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
    if (playerBattery) applyGunAim(playerBattery, playerFront, elevationDeg, traverseDeg);
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

  function handleDuelEvent(sideLabel, prefix, event) {
    onShoreShot?.(prefix, event);
    hudDirty = true;
    if (event.type !== 'impact' || sideLabel !== 'player' || !playerCastle) return;
    if (event.kind === 'water') {
      const dz = Math.abs((event.surfacePosition?.[2] ?? playerCastle.z) - playerCastle.z);
      const shortBy = Math.round(CASTLE_DUEL_DISTANCE_M - dz);
      if (shortBy > 18) {
        lastShotFeedback = `🌊 Splash in the channel (${Math.round(dz)}m out, ${shortBy}m short)! Aim higher (${CASTLE_DUEL_ELEVATION_HINT}).`;
      } else if (shortBy < -18) {
        lastShotFeedback = `🌊 Overshot the enemy castle (${Math.round(dz)}m)! Lower your elevation slightly.`;
      } else {
        lastShotFeedback = `🌊 Splash right at the base of Fuerte del Moro (${Math.round(dz)}m)! Raise your guns to ${CASTLE_DUEL_ELEVATION_HINT} to strike the walls.`;
      }
    } else if (event.kind === 'building' && event.building === enemyCastle) {
      const rep = event.damageReport;
      if (rep?.magazineExploded) {
        lastShotFeedback = `💥 CATACLYSMIC HIT! You detonated Fuerte del Moro's powder magazine!`;
      } else if (rep?.dismountedGuns > 0) {
        lastShotFeedback = `🎯 Direct hit on Fuerte del Moro (${rep.hitSubAssembly ?? 'rampart'})! Enemy guns dismounted: ${rep.dismountedGuns}, fires: ${rep.fires}.`;
      } else {
        lastShotFeedback = `🎯 Direct masonry hit on Fuerte del Moro (${rep?.hitSubAssembly ?? 'walls'})! Integrity ${Math.round((rep?.integrity ?? 1) * 100)}%.`;
      }
    }
  }

  // Whole walls, a full magazine and a fresh garrison for both castles: at the start and for a rematch.
  function manCastles() {
    for (const castle of duelPort.instances) {
      castle.damageState = null;
      castle.magazine = null;
      castle.gunnery = null;
      createBuildingDamageState(castle);
    }
    garrison = createFortGarrison(duelPort);
  }

  function mountBatteries() {
    playerBattery = createBuildingGunnery(playerCastle, {
      onEvent: (ev) => handleDuelEvent('player', 'duel-p-', ev),
      getVessels: () => [],
      getTerrain,
      town: { instances: [playerCastle], center: { x: playerCastle.x, z: playerCastle.z } },
    });
    enemyBattery = createBuildingGunnery(enemyCastle, {
      onEvent: (ev) => handleDuelEvent('enemy', 'duel-e-', ev),
      getVessels: () => [],
      getTerrain,
      town: { instances: [enemyCastle], center: { x: enemyCastle.x, z: enemyCastle.z } },
    });
    configureCastleDuelBattery(playerBattery);
    configureCastleDuelBattery(enemyBattery);
    playerFront = castleDuelFrontGuns(playerBattery);
    enemyFront = castleDuelFrontGuns(enemyBattery);

    winner = null;
    enemyCooldown = 3.0;
    enemySalvoCount = 0;
    nextGunCursor = 0;
    lastShotFeedback = CASTLE_DUEL_AIM_HINT;
    setAmmo(ammoType);
    syncAimUI();
    refreshHud();
  }

  // Raises the two castles in open water. False, with nothing of the normal game touched, when this
  // coast cannot take them.
  function buildArena(terrain) {
    const arena = chooseCastleDuelArena(terrain, getVessels?.() ?? []);
    const halfSpan = CASTLE_DUEL_DISTANCE_M * 0.5;
    playerCastle = {
      id: 'castle_duel_player',
      prefabId: 'bastion_trace_fortress',
      label: 'Castillo de San Felipe (Player)',
      x: arena.x,
      y: 1.6,
      baseY: 1.6,
      foundationDepth: 12.0,
      z: arena.z + halfSpan,
      yaw: 0, // -Z faces North toward enemyCastle
      width: 36,
      depth: 34,
      length: 34,
      height: 7.6,
      armed: true,
      friendlyToPlayer: true,
    };
    enemyCastle = {
      id: 'castle_duel_enemy',
      prefabId: 'bastion_trace_fortress',
      label: 'Fuerte del Moro (Enemy)',
      x: arena.x,
      y: 15.6,
      baseY: 15.6,
      foundationDepth: 26.0,
      z: arena.z - halfSpan,
      yaw: Math.PI, // -Z faces South (+Z) toward playerCastle
      width: 36,
      depth: 34,
      length: 34,
      height: 7.6,
      armed: true,
      friendlyToPlayer: false,
    };
    duelPort = {
      name: 'Strait of the Two Castles',
      // No part of the career: its damage is neither restored from the save nor written to it.
      transient: true,
      center: { x: arena.x, z: arena.z },
      seaDir: { x: 0, z: -1 },
      reach: 320,
      clearRadius: 280,
      instances: [playerCastle, enemyCastle],
      streets: null,
      sceneryBakes: [],
      sceneryFires: [],
    };
    duelGeo = buildPortPrefabGeometry(duelPort, null);
    manCastles();
    if (terrain.setCustomPort?.(duelPort, duelGeo) !== true) {
      clearArena();
      return false;
    }
    mountBatteries();
    return true;
  }

  function clearArena() {
    duelPort = null;
    duelGeo = null;
    playerCastle = null;
    enemyCastle = null;
    playerBattery = null;
    enemyBattery = null;
    playerFront = [];
    enemyFront = [];
    garrison = null;
  }

  // The same stone stands again: nothing is rebuilt but the damage, the garrison and the guns' state.
  function rematch() {
    if (!active || !duelPort) return false;
    manCastles();
    if (getTerrain?.()?.setCustomPort?.(duelPort, duelGeo) !== true) {
      stop();
      return false;
    }
    mountBatteries();
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
      say('🪣 The magazine is empty: San Felipe has no powder left to fire.');
      return 0;
    }
    applyGunAim(playerBattery, playerFront, elevationDeg, traverseDeg);
    let fired = 0;
    if (salvo) {
      fired = fireGunnery(playerBattery.state, 'port', { interval: 0.12, ammo: ammoType, only: playerFront });
    } else {
      const count = playerFront.length;
      for (let i = 0; i < count && !fired; i++) {
        const gun = playerFront[(nextGunCursor + i) % count];
        if (gun.dismounted || gun.stage !== 'ready' || gun.queued) continue;
        oneGun[0] = gun;
        fired = fireGunnery(playerBattery.state, 'port', { interval: 0.04, ammo: ammoType, only: oneGun });
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
    // The first volley strikes low on the player's wall; later ones walk up onto the parapet.
    const baseElev = enemySalvoCount === 1 ? -3.6 : -2.4;
    const jitterElev = (Math.sin(enemySalvoCount * 2.3) * 0.45) + (Math.random() - 0.5) * 0.45;
    const jitterTrav = (Math.cos(enemySalvoCount * 1.7) * 2.8) + (Math.random() - 0.5) * 2.0;
    enemyBattery.setAmmo(enemySalvoCount % 3 === 0 ? 'hot' : 'round');
    applyGunAim(enemyBattery, enemyFront, baseElev + jitterElev, jitterTrav);
    const fired = fireGunnery(enemyBattery.state, 'port', {
      interval: 0.18,
      ammo: enemyBattery.state.ammo,
      only: enemyVolley,
    });
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
        lastShotFeedback = `⚖️ MUTUAL DESTRUCTION! Both castles have been silenced (${SILENCED_BY[pStat.silencedBy]}; ${SILENCED_BY[eStat.silencedBy]}). Click Rematch to play again.`;
      } else if (eStat.defeated) {
        winner = 'player';
        lastShotFeedback = `🏆 VICTORY! Fuerte del Moro has been silenced (${SILENCED_BY[eStat.silencedBy]})! Castillo de San Felipe rules the strait!`;
      } else if (pStat.defeated) {
        winner = 'enemy';
        lastShotFeedback = `💀 DEFEAT! Castillo de San Felipe has been silenced (${SILENCED_BY[pStat.silencedBy]})! Click Rematch to try again.`;
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
    if (!terrain) return false;
    if (!buildArena(terrain)) {
      onNotice?.('The two castles cannot be raised on this coast. Try the duel from open sea or off another port.');
      return false;
    }
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
   * Starts the duel. True when it is running, false when it cannot be played here, and a promise of
   * one or the other when a coast has to be raised for it first (open sea).
   */
  let startingPromise = null;
  function start() {
    if (active) return true;
    if (startingPromise) return startingPromise;
    if (getTerrain?.() || typeof ensureTerrain !== 'function') return begin();
    setLaunchLabel('⏳ Raising the castles…');
    const failed = (raised) => {
      if (raised) disposeTerrain?.(raised);
      else onNotice?.('No coast could be raised for the two castles.');
      syncLaunchBtn();
      return false;
    };
    startingPromise = Promise.resolve().then(() => ensureTerrain()).then((raised) => {
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
    getTerrain?.()?.setCustomPort?.(null, null);
    restoreScene?.(savedScene);
    savedScene = null;
    if (raisedTerrain) {
      disposeTerrain?.(raisedTerrain);
      raisedTerrain = null;
    }
    clearArena();
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
        distanceMeters: CASTLE_DUEL_DISTANCE_M,
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
        prepareGunnery(playerBattery.state, 'port');
        prepareGunnery(enemyBattery.state, 'port');
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
