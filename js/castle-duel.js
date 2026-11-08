// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// "Two Castles" Cannon Duel Side Game:
// Two manned 16th-century star-bastioned stone sea fortresses face each other across a ~210m channel.
// No aiming arcs allowed — players must elevate their guns (+7.5° to +11.5°) and adjust traverse
// by watching their roundshot and hot-shot splashes and masonry impacts.

import { buildPortPrefabGeometry } from './terrain-model.js';
import {
  createBuildingDamageState,
  createBuildingGunnery,
  stepPortDamage,
  detonateBuildingMagazine,
} from './gunnery-control.js';
import { createFortGarrison, stepFortGarrison, reviveGarrisonSoldiers } from './crew.js';
import { fireGunnery } from './gunnery-state.js';

export const CASTLE_DUEL_DISTANCE_M = 210;
export const CASTLE_DUEL_MUZZLE_SPEED_MPS = 72;

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

function getFrontBatteryGuns(battery) {
  if (!battery?.state?.guns) return [];
  return battery.state.guns.filter(
    (g) => g.side === 'port' && Math.abs(g.directionDesign?.[2] ?? 0) > 0.8,
  );
}

function applyGunAim(battery, elevationDeg, traverseDeg) {
  if (!battery?.building || !battery?.state?.guns) return;
  const elev = Math.max(-4, Math.min(18, Number(elevationDeg) || 0));
  const trav = Math.max(-28, Math.min(28, Number(traverseDeg) || 0));
  const travRad = (trav * Math.PI) / 180;
  const dirLocal = [Math.sin(travRad), 0, -Math.cos(travRad)];
  battery.building.gunneryElevation = elev;
  battery.building.gunneryTraverse = trav;
  for (const g of getFrontBatteryGuns(battery)) {
    g.elevation = elev;
    g.aimDirectionLocal = [...dirLocal];
    g.aimPoint = null;
  }
}

function countCastleStatus(inst, battery) {
  const dmg = inst?.damageState;
  const frontGuns = getFrontBatteryGuns(battery);
  const activeGuns = frontGuns.filter((g) => !g.dismounted).length;
  const readyGuns = frontGuns.filter((g) => !g.dismounted && g.stage === 'ready' && !g.queued).length;
  const totalGuns = frontGuns.length;
  const soldiers = inst?.garrisonSoldiers ?? [];
  const totalSoldiers = soldiers.length;
  const ableSoldiers = soldiers.filter((s) => s.casualtyState !== 'fallen').length;
  const integrityPct = Math.round(Math.max(0, Math.min(1, dmg?.integrity ?? 1)) * 100);
  const fires = dmg?.fires?.length ?? 0;
  const magazineExploded = Boolean(dmg?.magazineExploded || inst?.magazine?.exploded);
  const defeated =
    magazineExploded ||
    integrityPct <= 5 ||
    (totalGuns > 0 && activeGuns === 0) ||
    (totalSoldiers > 0 && ableSoldiers === 0);
  return {
    activeGuns,
    readyGuns,
    totalGuns,
    ableSoldiers,
    totalSoldiers,
    integrityPct,
    fires,
    magazineExploded,
    defeated,
  };
}

export function createCastleDuelController({
  getTerrain,
  ensureTerrain,
  getVessels,
  getCamera,
  setCameraMode,
  getSimTime,
  getSettings,
  applySunPreset,
  onShoreShot,
  gunEffects,
}) {
  let active = false;
  let duelPort = null;
  let duelGeo = null;
  let playerCastle = null;
  let enemyCastle = null;
  let playerBattery = null;
  let enemyBattery = null;
  let garrison = null;

  let elevationDeg = 4.5; // Starts slightly low so first test shot splashes in the channel unless aimed up!
  let traverseDeg = 0.0;
  let ammoType = 'round';
  let viewPreset = 'parapet'; // 'parapet' | 'embrasure' | 'spyglass' | 'channel' | 'free'
  let nextGunCursor = 0;

  let enemyCooldown = 3.2;
  let enemySalvoCount = 0;
  let winner = null; // null | 'player' | 'enemy' | 'draw'
  let lastShotFeedback = 'No arcs allowed! Elevate your guns (+8° to +11°) to reach Fuerte del Moro across the 210m channel.';

  const cachedProjectiles = [];
  const cachedWorldFires = [];

  // Inject style rule to hide ship sailing HUD while Castle Duel is active
  if (!document.getElementById('castle-duel-style')) {
    const st = document.createElement('style');
    st.id = 'castle-duel-style';
    st.textContent = `
      body.castle-duel-active #hud,
      body.castle-duel-active #helm,
      body.castle-duel-active #helm-controls,
      body.castle-duel-active #sailing-instruments,
      body.castle-duel-active #port-call,
      body.castle-duel-active #look-hint,
      body.castle-duel-active #landfall-discovery-banner,
      body.castle-duel-active #voyage-hud,
      body.castle-duel-active #moor-shore-prompt,
      body.castle-duel-active .territory-toast {
        display: none !important;
      }
    `;
    document.head.appendChild(st);
  }

  // Launch button is mounted inside the Debug Menu (#environment-debug) via bindLaunchButton
  let launchBtn = null;
  let closePanelFn = null;
  function syncLaunchBtn() {
    if (!launchBtn) return;
    launchBtn.textContent = active ? '🏰 Exit Castle Duel' : '🏰 Castle Duel';
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
        <div id="cd-player-metrics" style="margin-top:3px;font-size:13px;">Walls 100% · Guns 4/4 · Garrison 16/16</div>
      </div>
      <div style="text-align:center;min-width:130px;">
        <div style="font-weight:800;font-size:14px;color:#ffd280;letter-spacing:0.04em;">⚔️ CASTLE DUEL ⚔️</div>
        <div style="font-size:11px;color:#cbb494;">Range: 210 m · No Aim Arcs</div>
      </div>
      <div id="cd-enemy-score" style="flex:1;min-width:210px;padding:6px 10px;border-radius:8px;background:rgba(120,38,32,0.32);border:1px solid rgba(235,105,90,0.38);text-align:right;">
        <div style="font-weight:700;color:#ff9e92;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">🎯 Enemy · Fuerte del Moro</div>
        <div id="cd-enemy-metrics" style="margin-top:3px;font-size:13px;">Walls 100% · Guns 4/4 · Garrison 16/16</div>
      </div>
    </div>

    <div id="cd-banner" style="margin-bottom:9px;padding:6px 10px;border-radius:6px;background:rgba(255,215,130,0.10);border:1px solid rgba(255,215,130,0.24);color:#ffe2a8;font-size:12.5px;text-align:center;font-weight:500;">
      No arcs allowed! Elevate your guns (+8° to +11°) to reach Fuerte del Moro across the 210m channel.
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:220px;">
        <label style="font-weight:600;min-width:112px;color:#f3d5a5;">Elevation: <span id="cd-elev-val">+4.5°</span></label>
        <button type="button" id="cd-elev-down" style="padding:4px 8px;border-radius:5px;border:1px solid #8a6b43;background:#2b1d11;color:#f5dec0;cursor:pointer;">−</button>
        <input id="cd-elev-slider" type="range" min="-2" max="16" step="0.25" value="4.5" style="flex:1;accent-color:#e5a94c;cursor:pointer;" />
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

  function syncAimUI() {
    elElevVal.textContent = `${elevationDeg >= 0 ? '+' : ''}${elevationDeg.toFixed(1)}°`;
    elTravVal.textContent = `${traverseDeg >= 0 ? '+' : ''}${traverseDeg.toFixed(1)}°`;
    elElevSlider.value = String(elevationDeg);
    elTravSlider.value = String(traverseDeg);
    if (playerBattery) applyGunAim(playerBattery, elevationDeg, traverseDeg);
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

  function positionDuelCamera() {
    const cam = getCamera?.();
    if (!cam || !playerCastle || !enemyCastle) return;
    const yTop = (playerCastle.y ?? 1.6) + (playerCastle.height ?? 7.6);
    if (viewPreset === 'free') return;
    setCameraMode?.('free');
    const travRad = (traverseDeg * Math.PI) / 180;
    if (viewPreset === 'parapet') {
      cam.x = playerCastle.x + Math.sin(travRad) * 2.0;
      cam.y = yTop + 2.25;
      cam.z = playerCastle.z - 11.4;
      cam.yaw = travRad * 0.65;
      cam.pitch = -0.04 + Math.max(0, elevationDeg - 5) * 0.007;
      cam.fovY = (52 * Math.PI) / 180;
    } else if (viewPreset === 'embrasure') {
      cam.x = playerCastle.x + 2.1;
      cam.y = yTop + 1.25;
      cam.z = playerCastle.z - 14.2;
      cam.yaw = travRad * 0.85;
      cam.pitch = (elevationDeg * 0.45 * Math.PI) / 180;
      cam.fovY = (46 * Math.PI) / 180;
    } else if (viewPreset === 'spyglass') {
      cam.x = playerCastle.x;
      cam.y = yTop + 2.4;
      cam.z = playerCastle.z - 15.2;
      cam.yaw = travRad * 0.9;
      cam.pitch = -0.015;
      cam.fovY = (20 * Math.PI) / 180;
    } else if (viewPreset === 'channel') {
      const terrain = getTerrain?.();
      const midZ = 0.5 * (playerCastle.z + enemyCastle.z);
      const hWest = typeof terrain?.height === 'function' ? terrain.height(playerCastle.x - 135, midZ) : -10;
      const hEast = typeof terrain?.height === 'function' ? terrain.height(playerCastle.x + 135, midZ) : -10;
      const useEast = hEast < hWest;
      cam.x = playerCastle.x + (useEast ? 135 : -135);
      cam.y = 22;
      cam.z = midZ;
      cam.yaw = useEast ? -Math.PI * 0.5 : Math.PI * 0.5;
      cam.pitch = -0.10;
      cam.fovY = (56 * Math.PI) / 180;
    }
  }

  function handleDuelEvent(sideLabel, prefix, event) {
    onShoreShot?.(prefix, event);
    if (event.type !== 'impact') return;
    if (sideLabel === 'player') {
      if (event.kind === 'water') {
        const dz = Math.abs((event.surfacePosition?.[2] ?? playerCastle.z) - playerCastle.z);
        const shortBy = Math.round(CASTLE_DUEL_DISTANCE_M - dz);
        if (shortBy > 18) {
          lastShotFeedback = `🌊 Splash in the channel (${Math.round(dz)}m out, ${shortBy}m short)! Aim higher (+8.5° to +11°).`;
        } else if (shortBy < -18) {
          lastShotFeedback = `🌊 Overshot the enemy castle (${Math.round(dz)}m)! Lower your elevation slightly.`;
        } else {
          lastShotFeedback = `🌊 Splash right at the base of Fuerte del Moro (${Math.round(dz)}m)! Raise elevation +1° to hit the parapet.`;
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
  }

  function buildArena() {
    const terrain = getTerrain?.();
    if (!terrain) return false;

    // Choose an open water arena center off the coast so no terrain blocks the 210m channel or side cameras
    const portRef = terrain.port;
    const baseX = portRef?.center?.x ?? 0;
    const baseZ = portRef?.center?.z ?? -420;
    const seaX = portRef?.seaDir?.x ?? 0;
    const seaZ = portRef?.seaDir?.z ?? -1;
    let centerX = baseX + seaX * 380;
    let centerZ = baseZ + seaZ * 380;

    if (typeof terrain.height === 'function') {
      let bestScore = Infinity;
      const baseAngle = Math.atan2(seaZ, seaX);
      for (const dist of [320, 440, 560, 700, 860]) {
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
          if (maxBed < bestScore) {
            bestScore = maxBed;
            centerX = cx;
            centerZ = cz;
          }
          if (bestScore < -4.0) break;
        }
        if (bestScore < -4.0) break;
      }
    }

    // Move ships clear of the 210m cannon duel channel so they don't block shots
    const vessels = getVessels?.() ?? [];
    for (let i = 0; i < vessels.length; i++) {
      const b = vessels[i]?.boat;
      if (!b) continue;
      if (Math.abs((b.x ?? 0) - centerX) < 180 && Math.abs((b.z ?? 0) - centerZ) < 220) {
        b.x = centerX + 260 + i * 45;
        b.z = centerZ + (i - 1) * 55;
        b.surgeVelocity = 0;
        b.leewayVelocity = 0;
      }
    }

    const halfSpan = CASTLE_DUEL_DISTANCE_M * 0.5;
    playerCastle = {
      id: 'castle_duel_player',
      prefabId: 'bastion_trace_fortress',
      label: 'Castillo de San Felipe (Player)',
      x: centerX,
      y: 1.6,
      baseY: 1.6,
      foundationDepth: 12.0,
      z: centerZ + halfSpan,
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
      x: centerX,
      y: 1.6,
      baseY: 1.6,
      foundationDepth: 12.0,
      z: centerZ - halfSpan,
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
      center: { x: centerX, z: centerZ },
      seaDir: { x: 0, z: -1 },
      reach: 320,
      clearRadius: 280,
      instances: [playerCastle, enemyCastle],
      streets: null,
      sceneryBakes: [],
      sceneryFires: [],
    };

    duelGeo = buildPortPrefabGeometry(duelPort, null);
    createBuildingDamageState(playerCastle);
    createBuildingDamageState(enemyCastle);

    // Give each castle a generous powder magazine for the duel
    if (playerCastle.magazine) {
      playerCastle.magazine.powderKg = 600;
      playerCastle.magazine.initialPowderKg = 600;
    }
    if (enemyCastle.magazine) {
      enemyCastle.magazine.powderKg = 600;
      enemyCastle.magazine.initialPowderKg = 600;
    }

    garrison = createFortGarrison(duelPort);
    terrain.setCustomPort?.(duelPort, duelGeo);

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

    winner = null;
    enemyCooldown = 3.0;
    enemySalvoCount = 0;
    nextGunCursor = 0;
    lastShotFeedback = 'No arcs allowed! Elevate your guns (+8.5° to +11°) to hit Fuerte del Moro across the 210m channel.';

    setAmmo(ammoType);
    applyGunAim(playerBattery, elevationDeg, traverseDeg);
    positionDuelCamera();
    updateScoreHUD();
    return true;
  }

  function firePlayerGun(salvo = false) {
    if (!active || !playerBattery || winner) return 0;
    applyGunAim(playerBattery, elevationDeg, traverseDeg);
    const frontGuns = getFrontBatteryGuns(playerBattery).filter((g) => !g.dismounted);
    if (!frontGuns.length) return 0;

    if (salvo) {
      // When the player clicks "Fire Salvo", ready all front embrasure guns immediately so a full broadside fires
      for (const g of frontGuns) {
        g.stage = 'ready';
        g.loading = false;
        g.progress = 1;
        g.offset = 0;
        g.queued = false;
      }
      return fireGunnery(playerBattery.state, 'port', {
        interval: 0.12,
        ammo: ammoType,
        only: frontGuns,
      });
    }

    const chosen = frontGuns[nextGunCursor % frontGuns.length];
    nextGunCursor = (nextGunCursor + 1) % Math.max(1, frontGuns.length);
    chosen.stage = 'ready';
    chosen.loading = false;
    chosen.progress = 1;
    chosen.offset = 0;
    chosen.queued = false;
    return fireGunnery(playerBattery.state, 'port', {
      interval: 0.04,
      ammo: ammoType,
      only: [chosen],
    });
  }

  function fireEnemyAI() {
    if (!active || !enemyBattery || !playerCastle || winner) return 0;
    const frontGuns = getFrontBatteryGuns(enemyBattery).filter((g) => !g.dismounted);
    if (!frontGuns.length) return 0;
    for (const g of frontGuns) {
      if (g.stage !== 'ready' && !g.queued) {
        g.stage = 'ready';
        g.loading = false;
        g.progress = 1;
        g.offset = 0;
      }
    }
    enemySalvoCount++;
    // First shot splashes slightly short in the channel; subsequent shots walk onto the player's parapet
    const baseElev = enemySalvoCount === 1 ? 6.2 : 9.4;
    const jitterElev = (Math.sin(enemySalvoCount * 2.3) * 1.15) + (Math.random() - 0.5) * 1.2;
    const jitterTrav = (Math.cos(enemySalvoCount * 1.7) * 3.2) + (Math.random() - 0.5) * 2.4;
    enemyBattery.setAmmo(enemySalvoCount % 3 === 0 ? 'hot' : 'round');
    applyGunAim(enemyBattery, baseElev + jitterElev, jitterTrav);
    const count = Math.min(frontGuns.length, enemySalvoCount === 1 ? 2 : 3);
    const subset = frontGuns.slice(0, count);
    return fireGunnery(enemyBattery.state, 'port', {
      interval: 0.18,
      ammo: enemyBattery.state.ammo,
      only: subset,
    });
  }

  function updateScoreHUD() {
    if (!playerCastle || !enemyCastle) return;
    const pStat = countCastleStatus(playerCastle, playerBattery);
    const eStat = countCastleStatus(enemyCastle, enemyBattery);

    elPlayerMetrics.textContent = `Walls ${pStat.integrityPct}% · Guns ${pStat.activeGuns}/${pStat.totalGuns} · Garrison ${pStat.ableSoldiers}/${pStat.totalSoldiers}${pStat.fires ? ` · 🔥${pStat.fires}` : ''}`;
    elEnemyMetrics.textContent = `Walls ${eStat.integrityPct}% · Guns ${eStat.activeGuns}/${eStat.totalGuns} · Garrison ${eStat.ableSoldiers}/${eStat.totalSoldiers}${eStat.fires ? ` · 🔥${eStat.fires}` : ''}`;

    if (!winner) {
      if (eStat.defeated && pStat.defeated) {
        winner = 'draw';
        lastShotFeedback = '⚖️ MUTUAL DESTRUCTION! Both castles have been silenced! Click Rematch to play again.';
      } else if (eStat.defeated) {
        winner = 'player';
        lastShotFeedback = '🏆 VICTORY! Fuerte del Moro has been silenced! Castillo de San Felipe rules the strait!';
      } else if (pStat.defeated) {
        winner = 'enemy';
        lastShotFeedback = '💀 DEFEAT! Castillo de San Felipe has fallen to Fuerte del Moro! Click Rematch to try again.';
      }
    }
    elBanner.textContent = lastShotFeedback;
    if (winner === 'player') {
      elBanner.style.background = 'rgba(46, 160, 88, 0.28)';
      elBanner.style.borderColor = 'rgba(110, 235, 150, 0.65)';
      elBanner.style.color = '#b8ffcf';
    } else if (winner === 'enemy') {
      elBanner.style.background = 'rgba(180, 42, 36, 0.32)';
      elBanner.style.borderColor = 'rgba(255, 110, 100, 0.65)';
      elBanner.style.color = '#ffc2bc';
    } else {
      elBanner.style.background = 'rgba(255, 215, 130, 0.10)';
      elBanner.style.borderColor = 'rgba(255, 215, 130, 0.24)';
      elBanner.style.color = '#ffe2a8';
    }
  }

  let startingPromise = null;
  function start() {
    if (!getTerrain?.() && typeof ensureTerrain === 'function') {
      if (!startingPromise) {
        if (launchBtn) launchBtn.textContent = '⏳ Loading Castles…';
        startingPromise = Promise.resolve(ensureTerrain()).then((t) => {
          startingPromise = null;
          if (t) start();
          else syncLaunchBtn();
        });
      }
      return true;
    }
    if (!buildArena()) return false;
    active = true;
    hud.hidden = false;
    document.body.classList.add('castle-duel-active');
    syncLaunchBtn();
    gunEffects?.setAimArcs?.([]);
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    hud.hidden = true;
    document.body.classList.remove('castle-duel-active');
    syncLaunchBtn();
    const terrain = getTerrain?.();
    terrain?.setCustomPort?.(null, null);
    setCameraMode?.('ship');
  }

  function bindLaunchButton(btn, onClosePanel = null) {
    launchBtn = btn;
    closePanelFn = onClosePanel;
    if (!btn) return;
    syncLaunchBtn();
    btn.addEventListener('click', () => {
      if (active) {
        stop();
      } else {
        start();
        closePanelFn?.();
      }
    });
  }
  hud.querySelector('#cd-elev-down').addEventListener('click', () => {
    setElevation(elevationDeg - 0.5);
    if (viewPreset !== 'free') positionDuelCamera();
  });
  hud.querySelector('#cd-elev-up').addEventListener('click', () => {
    setElevation(elevationDeg + 0.5);
    if (viewPreset !== 'free') positionDuelCamera();
  });
  elElevSlider.addEventListener('input', (e) => {
    setElevation(parseFloat(e.target.value));
    if (viewPreset !== 'free') positionDuelCamera();
  });
  hud.querySelector('#cd-trav-left').addEventListener('click', () => {
    setTraverse(traverseDeg - 1.0);
    if (viewPreset !== 'free') positionDuelCamera();
  });
  hud.querySelector('#cd-trav-right').addEventListener('click', () => {
    setTraverse(traverseDeg + 1.0);
    if (viewPreset !== 'free') positionDuelCamera();
  });
  elTravSlider.addEventListener('input', (e) => {
    setTraverse(parseFloat(e.target.value));
    if (viewPreset !== 'free') positionDuelCamera();
  });
  hud.querySelector('#cd-fire-one').addEventListener('click', () => firePlayerGun(false));
  hud.querySelector('#cd-fire-salvo').addEventListener('click', () => firePlayerGun(true));
  elAmmoBtn.addEventListener('click', () => setAmmo(ammoType === 'round' ? 'hot' : 'round'));

  const VIEW_ORDER = ['parapet', 'embrasure', 'spyglass', 'channel', 'free'];
  const VIEW_LABELS = {
    parapet: '📷 View: Parapet',
    embrasure: '📷 View: Embrasure',
    spyglass: '🔭 View: Spyglass',
    channel: '🌊 View: Channel',
    free: '🕊️ View: Free Cam',
  };
  elViewBtn.addEventListener('click', () => {
    const idx = VIEW_ORDER.indexOf(viewPreset);
    viewPreset = VIEW_ORDER[(idx + 1) % VIEW_ORDER.length];
    elViewBtn.textContent = VIEW_LABELS[viewPreset];
    positionDuelCamera();
  });

  hud.querySelector('#cd-night-btn').addEventListener('click', () => {
    const P = getSettings?.();
    if (!P) return;
    const isNight = (P.sunElev ?? 20) < 0;
    applySunPreset?.(isNight ? 24 : -18);
  });

  hud.querySelector('#cd-reset-btn').addEventListener('click', () => {
    if (active) buildArena();
  });
  hud.querySelector('#cd-exit-btn').addEventListener('click', () => stop());

  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'ArrowUp' || (viewPreset !== 'free' && e.code === 'KeyW')) {
      e.preventDefault();
      setElevation(elevationDeg + 0.5);
      positionDuelCamera();
    } else if (e.code === 'ArrowDown' || (viewPreset !== 'free' && e.code === 'KeyS')) {
      e.preventDefault();
      setElevation(elevationDeg - 0.5);
      positionDuelCamera();
    } else if (e.code === 'ArrowLeft' || (viewPreset !== 'free' && e.code === 'KeyA')) {
      e.preventDefault();
      setTraverse(traverseDeg - 1.0);
      positionDuelCamera();
    } else if (e.code === 'ArrowRight' || (viewPreset !== 'free' && e.code === 'KeyD')) {
      e.preventDefault();
      setTraverse(traverseDeg + 1.0);
      positionDuelCamera();
    } else if (e.code === 'Space') {
      e.preventDefault();
      firePlayerGun(false);
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      firePlayerGun(true);
    }
  });

  return {
    get active() { return active; },
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
    rematch: buildArena,
    setElevation,
    setTraverse,
    setAmmo,
    setView(preset) {
      if (VIEW_ORDER.includes(preset)) {
        viewPreset = preset;
        elViewBtn.textContent = VIEW_LABELS[viewPreset];
        positionDuelCamera();
      }
    },
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
        player: countCastleStatus(playerCastle, playerBattery),
        enemy: countCastleStatus(enemyCastle, enemyBattery),
      };
    },
    update(dt, windVec = [0, 0, 0]) {
      if (!active || !duelPort) return;
      // Enforce NO AIM ARCS ALLOWED in Castle Duel mode
      gunEffects?.setAimArcs?.([]);

      if (dt > 0) {
        stepPortDamage(duelPort, dt);
        if (garrison) {
          stepFortGarrison(garrison, dt, Math.hypot(windVec[0] ?? 0, windVec[2] ?? 0));
        }
        playerBattery?.update(dt, windVec, { skipBuildingDamage: true });
        enemyBattery?.update(dt, windVec, { skipBuildingDamage: true });

        if (!winner) {
          enemyCooldown -= dt;
          if (enemyCooldown <= 0) {
            fireEnemyAI();
            enemyCooldown = 4.6 + Math.random() * 1.4;
          }
        }
      }
      if (viewPreset !== 'free') {
        positionDuelCamera();
      }
      updateScoreHUD();
    },
  };
}
