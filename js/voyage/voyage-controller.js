// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Chart Course voyage controller: glues the pure passage modules to the live scene.
//
// Per frame (called from js/main.js):
//   steer(dt)        – before stepVessel: the helmsman writes the rudder.
//   update(dt, ...)  – after the hull step: advances the warped voyage clock, drives weather,
//                      re-anchors the astronomy clock, runs the landfall approach (DEM scan,
//                      warp governor, late terrain spawn, terrain world-offset slide) and the HUD.
//
// The scene itself never runs faster than real time; see js/voyage/passage.js.

import {
  createVoyage,
  stepVoyage,
  setWarpTier,
  raiseInterrupt,
  interruptHoldsTheDeck,
  clearInterrupt,
  addLog,
  addMark,
  voyageSnapshot,
  serializeVoyage,
  restoreVoyage,
  revealTruePosition,
  reckoningVerdict,
  createWeatherDriver,
  hullVelocity,
  warpTier,
  WARP_TIERS,
  DEFAULT_DEPARTURE,
  voyageDateInEra,
  normaliseVoyageEra,
  NM_PER_LEAGUE,
} from './passage.js';
import { createHelmsman, steerHelmsman, orderCourse, orderTack, applyCanvasOrder, canvasAdvice, CANVAS_ORDERS } from './helmsman.js';
import {
  createCoastlineIndex,
  createDemProbe,
  scanForLand,
  coastlineToward,
  approachStage,
  destinationPoint,
  approachWarpCap,
  regionLocalOrigin,
  visibilityRangeKm,
  lookoutEyeHeight,
  pilotDropPoint,
  warpStandoffM,
  warpCapForHazard,
  WARP_MAP_COAST_STOP_KM,
  visibleLandPoint,
} from './landfall-approach.js';
import { compassPointName, relativeBearingCall, formatLatitude, formatLongitude } from './compass.js';
import { formatJulianDate, localSolarHours, greatCircleKm, initialBearing, windDescription } from './ocean-climate.js';
import { createEncounterDirector, describeEncounterThroughSpyglass } from './encounters.js';
import { controlIcon, keyIsForField } from '../controls.js';
import { probeHullBottomContact } from '../terrain-model.js';
import { computeAstronomy } from '../astronomy.js';

// Wind in metres a second at which a passage starts to cost hands, and the chance per game hour.
const GALE_LOSS_WIND = 24;
const GALE_LOSS_PER_HOUR = 0.015;

const VOYAGE_STORAGE_KEY = 'waterworld.voyage.v1';
const voyageWrap360 = (d) => ((d % 360) + 360) % 360;
const voyageEscapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Ship's watch and half-hour glass for a local solar time. */
export function shipWatch(solarHours) {
  const names = ['Middle watch', 'Morning watch', 'Forenoon watch', 'Afternoon watch', 'Dog watches', 'First watch'];
  const idx = Math.floor(solarHours / 4) % 6;
  const glass = Math.floor((solarHours % 4) * 2) + 1;
  return { name: names[idx], glass };
}

/**
 * @param {object} cfg
 *  boat, P, astronomy (clock from js/astronomy.js), hudParent (element),
 *  getTerrain(): terrain|null, spawnTerrain({region, placement, lat, lon, name}): Promise<terrain|null>,
 *  regionLatLon(terrain, x, z): {latitude, longitude} for the boat inside an existing terrain,
 *  onSpectrum(), onEnv(), resolveLandfallRegion(lat, lon): region spec (curated port id or coords),
 *  loadLandRings(): Promise<rings>, demLoader (optional tile loader), storage (localStorage).
 */
/**
 * A button that erases something takes a second, deliberate click. The first arms it and says
 * what will be lost; left alone it stands down by itself. The second click of a double-click
 * comes too soon to be a decision and is not taken for one.
 */
export function armBeforeErasing(button, { prompt, onConfirm, standDownMs = 6000, settleMs = 500, schedule = setTimeout, cancel = clearTimeout, now = () => performance.now() }) {
  const label = button.textContent;
  let timer = null, armedAt = 0;
  const standDown = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    delete button.dataset.armed;
    button.textContent = label;
  };
  button.onclick = () => {
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = typeof prompt === 'function' ? prompt() : prompt;
      timer = schedule(standDown, standDownMs);
      armedAt = now();
      return;
    }
    if (now() - armedAt < settleMs) return;
    standDown();
    onConfirm();
  };
  return { standDown };
}

export function createVoyageController(cfg) {
  const {
    boat,
    P,
    astronomy,
    hudParent = typeof document !== 'undefined' ? document.body : null,
    getTerrain = () => null,
    spawnTerrain = null,
    regionLatLon = null,
    onSpectrum = () => {},
    onEnv = () => {},
    resolveLandfallRegion = (lat, lon) => ({ latitude: lat, longitude: lon, name: 'Uncharted coast' }),
    loadLandRings = null,
    demLoader = undefined,
    loadTile = undefined,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    dock = null,
  } = cfg;
  // Keep in step with the compact HUD media query in index.html.
  const HUD_COMPACT_QUERY = '(max-width:720px),(pointer:coarse),(max-height:580px)';
  const HUD_RIVAL_PANELS = ['sea-settings-open', 'ship-settings-open', 'captain-open', 'landfall-open', 'camera-open', 'performance-open', 'share-open'];
  // On roomier screens the panel is a drawer at the head of the screen. It stays as the player left it, and a folded
  // one comes down by itself only for a call that needs an answer.
  const HUD_FOLDED_KEY = 'waterworld.voyageHud.folded';
  const hudCompact = () => matchMedia(HUD_COMPACT_QUERY).matches;
  // Not `storage`: that one holds the voyage alone, whatever key it is handed.
  const hudPrefs = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
  const hudFolded = () => { try { return hudPrefs()?.getItem(HUD_FOLDED_KEY) === '1'; } catch { return false; } };
  const hudRestsOpen = () => !hudCompact() && !hudFolded();
  let hudExpanded = false, hudAutoExpanded = false;

  let voyage = null;
  const helmsman = createHelmsman({ engaged: false });
  const weatherDriver = createWeatherDriver();
  let encounterDirector = createEncounterDirector();
  const tileLoader = demLoader ?? loadTile;
  const probe = createDemProbe(tileLoader ? { loadTile: tileLoader } : {});
  let coastIndex = null;
  let listeners = new Set();
  let lastPersist = 0;
  let scanTimer = 0;
  let toastTimer = 0;
  let lastAdvice = null;
  let manualHelm = false;
  let lastAstroRevision = astronomy?.revision ?? -1;
  let respectManualSky = false;

  function alignDateToDaylightIfNight(v, targetSolarHour = 9.8) {
    if (!v || !Number.isFinite(v.dateMs)) return;
    const lon = Number.isFinite(v.true?.lon) ? v.true.lon : DEFAULT_DEPARTURE.lon;
    const solar = localSolarHours(v.dateMs, lon);
    if (solar < 6.5 || solar > 17.8) {
      const deltaHours = ((targetSolarHour - solar) % 24 + 24) % 24;
      v.dateMs += Math.round(deltaHours * 3600000);
    }
  }

  // Approach / terrain slide state
  const approach = {
    stage: 'open',
    coastKm: Infinity,
    sightKm: 40,
    visible: null,
    landHoCalled: false,
    spawning: false,
    spawnedTerrain: null,
    offset: { x: 0, z: 0 },
    committed: false,
    lastBoat: { x: boat.x, z: boat.z },
    scan: null,
  };

  // Active 3D ship pursuit / intercept state (steers toward target and stops time dilation at battle range)
  const pursuit = {
    active: false,
    mode: null, // 'fight' | 'board' | 'hail'
    encounter: null,
    battleRangeM: 235,
    boardRangeM: 24,
    hailRangeM: 72,
    battleRangeReached: false,
    actionTriggered: false,
  };

  // Until the coastline has arrived (or failed to), nobody aboard knows what lies ahead.
  let coastIndexPending = Boolean(loadLandRings);
  if (loadLandRings) {
    Promise.resolve()
      .then(loadLandRings)
      .then((rings) => { if (Array.isArray(rings)) coastIndex = createCoastlineIndex(rings); })
      .catch(() => {})
      .finally(() => { coastIndexPending = false; scanTimer = 0; });
  }

  // ------------------------------------------------------------------ HUD
  const hud = hudParent ? buildHud(hudParent) : null;

  function buildHud(parent) {
    const root = document.createElement('section');
    root.id = 'voyage-hud';
    root.hidden = true;
    root.setAttribute('aria-label', 'Voyage');
    root.innerHTML = `
      <div class="voyage-row voyage-clock">
        <span class="voyage-date" aria-live="off"></span>
        <span class="voyage-watch"></span>
      </div>
      <div class="voyage-row voyage-orders">
        <div class="voyage-warp" role="group" aria-label="Time warp"></div>
        <label class="voyage-canvas-label">Canvas <select class="voyage-canvas" aria-label="Canvas order"></select></label>
      </div>
      <div class="voyage-row voyage-helm">
        <button type="button" class="voyage-course-left" aria-label="Alter course one point to larboard" title="One point to larboard ( [ )">◀</button>
        <span class="voyage-course" aria-live="polite"></span>
        <button type="button" class="voyage-course-right" aria-label="Alter course one point to starboard" title="One point to starboard ( ] )">▶</button>
        <button type="button" class="voyage-keep" title="Helmsman: keep her as she goes (K)">Keep her so</button>
        <button type="button" class="voyage-tack" title="Go about (T)">Tack</button>
        <label class="voyage-beat"><input type="checkbox"> Beat</label>
        <button type="button" class="voyage-reset" title="Erase the saved career and start a new 1550 voyage. Asks once more before erasing.">Reset voyage</button>
      </div>
      <div class="voyage-row voyage-status"><span class="voyage-pos"></span><span class="voyage-helmsman"></span><span class="voyage-wind"></span><span class="voyage-stores"></span></div>
      <div class="voyage-callout" role="alert" hidden></div>
      <div class="voyage-toast" role="status" aria-live="polite" hidden></div>`;
    parent.append(root);
    // A choice is one press. Each new call takes the focus as it appears, so a key still held from
    // answering the last one would otherwise answer it too.
    root.querySelector('.voyage-callout').addEventListener('keydown', (e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); });
    // One handle shuts the panel and, where it folds to a bar rather than away, opens it again.
    const hide = controlIcon(document.createElement('button'), 'close', 'Hide voyage');
    hide.classList.add('voyage-hide');
    hide.setAttribute('aria-controls', 'voyage-hud');
    const foldByHand = (open) => {
      setHudExpanded(open);
      if (hudCompact()) { if (!open) toggle?.focus(); return; }
      try { hudPrefs()?.setItem(HUD_FOLDED_KEY, open ? '0' : '1'); } catch { /* storage may be blocked */ }
    };
    hide.onclick = () => foldByHand(!hudExpanded);
    root.querySelector('.voyage-clock').append(hide);
    // The folded bar opens from anywhere on it.
    root.addEventListener('click', (e) => { if (!hudExpanded && !hudCompact() && e.target.closest('.voyage-clock') && !e.target.closest('button')) foldByHand(true); });
    // A screen that changes kind (a turned tablet, a resized window) takes that kind's resting state, and keeps a call in view.
    matchMedia(HUD_COMPACT_QUERY).addEventListener?.('change', () => { if (!root.hidden) restHud(); });
    // Compact screens open this panel from the dock, as they do every other panel.
    const toggle = dock ? controlIcon(document.createElement('button'), 'voyage', 'Voyage') : null;
    if (toggle) {
      toggle.id = 'voyage-button';
      toggle.hidden = true;
      toggle.setAttribute('aria-controls', 'voyage-hud');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.onclick = () => { setHudExpanded(!hudExpanded); if (hudExpanded) hide.focus({ preventScroll: true }); };
      dock.append(toggle);
    }
    // Notices at the head of the screen stack below whatever the HUD occupies.
    const publishBottom = () => document.documentElement.style.setProperty('--voyage-hud-bottom', `${root.hidden ? 0 : root.getBoundingClientRect().bottom}px`);
    const hudBounds = new ResizeObserver(publishBottom);
    hudBounds.observe(root);
    hudBounds.observe(document.documentElement);
    new MutationObserver(() => {
      if (hudExpanded && hudCompact() && HUD_RIVAL_PANELS.some((c) => document.body.classList.contains(c))) setHudExpanded(false);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const warpBox = root.querySelector('.voyage-warp');
    const warpButtons = new Map();
    for (const tier of WARP_TIERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = tier.label;
      b.title = `${tier.label} (${tier.rate}×)`;
      b.onclick = () => setWarp(tier.id);
      warpButtons.set(tier.id, b);
      warpBox.append(b);
    }
    const canvasSel = root.querySelector('.voyage-canvas');
    for (const o of Object.values(CANVAS_ORDERS)) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      canvasSel.append(opt);
    }
    canvasSel.onchange = () => orderCanvas(canvasSel.value);
    root.querySelector('.voyage-course-left').onclick = () => alterCourse(-11.25);
    root.querySelector('.voyage-course-right').onclick = () => alterCourse(11.25);
    root.querySelector('.voyage-keep').onclick = () => keepHerSo();
    root.querySelector('.voyage-tack').onclick = () => tack();
    const beat = root.querySelector('.voyage-beat input');
    beat.onchange = () => { helmsman.beat = beat.checked; };
    const resetBtn = root.querySelector('.voyage-reset');
    if (resetBtn) {
      armBeforeErasing(resetBtn, {
        prompt: () => cfg.resetVoyagePrompt?.() ?? 'Erase this voyage?',
        onConfirm: () => {
          if (cfg.onResetVoyage) {
            cfg.onResetVoyage();
          } else {
            try { storage?.removeItem?.(VOYAGE_STORAGE_KEY); } catch { /* ignore */ }
            start({ dateMs: DEFAULT_DEPARTURE.dateMs, passive: Boolean(voyage?.passive) });
            showToast('Voyage reset to 1550.');
          }
        },
      });
    }
    return { root, toggle, hide, warpButtons, canvasSel, beat, resetBtn };
  }

  function setHudVisible(visible) {
    if (!hud) return;
    const shown = !hud.root.hidden;
    hud.root.hidden = !visible;
    if (hud.toggle) hud.toggle.hidden = !visible;
    if (!visible) setHudExpanded(false);
    else if (!shown) restHud();
  }

  // The panel as it stands when nothing calls for it: open on a roomy screen unless the player folded it, shut on a
  // compact one. A call still waiting for its answer keeps it open, and lets it fold again once answered.
  function restHud() {
    if (!hud) return;
    const calling = !hud.root.querySelector('.voyage-callout').hidden;
    const open = hudRestsOpen();
    setHudExpanded(open || calling);
    hudAutoExpanded = calling && !open;
  }

  function setHudExpanded(open) {
    if (!hud) return;
    hudAutoExpanded = false;
    const compact = hudCompact();
    if (open && !hudExpanded && compact) cfg.onHudOpen?.();
    hudExpanded = open;
    hud.root.dataset.expanded = String(open);
    hud.toggle?.setAttribute('aria-expanded', String(open));
    controlIcon(hud.hide, open ? (compact ? 'close' : 'fold') : 'unfold', open ? 'Hide voyage' : 'Show voyage');
    document.body.classList.toggle('voyage-open', open);
    if (open) hud.root.scrollTop = 0;
  }

  function showToast(text, seconds = 6) {
    if (!hud) return;
    const t = hud.root.querySelector('.voyage-toast');
    t.textContent = text;
    t.hidden = false;
    toastTimer = seconds;
  }

  function showCallout(interrupt) {
    if (!hud) return;
    const box = hud.root.querySelector('.voyage-callout');
    if (!interrupt) {
      box.hidden = true;
      box.innerHTML = '';
      if (hudAutoExpanded) setHudExpanded(false);
      return;
    }
    setHudVisible(true);
    // Whatever lies over the call (the chart, for one) is put away so that it can be seen and answered.
    cfg.onCallout?.(interrupt);
    // A call that needs an answer opens the compact panel; answering closes it again.
    if (!hudExpanded) { setHudExpanded(true); hudAutoExpanded = true; }
    box.hidden = false;
    box.innerHTML = `<p class="voyage-callout-title">${voyageEscapeHtml(interrupt.title ?? 'The lookout calls')}</p><p class="voyage-callout-text">${voyageEscapeHtml(interrupt.text)}</p><div class="voyage-callout-actions"></div>`;
    const actions = box.querySelector('.voyage-callout-actions');
    for (const choice of interrupt.choices ?? [{ id: 'ok', label: 'Very well' }]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice.label;
      b.onclick = () => resolveInterrupt(choice.id);
      actions.append(b);
    }
    actions.querySelector('button')?.focus({ preventScroll: true });
  }

  function beginEncounterPursuit(enc, mode = 'fight') {
    if (!enc || !voyage) return;
    promoteActive();
    pursuit.active = true;
    pursuit.mode = mode;
    pursuit.encounter = enc;
    pursuit.battleRangeReached = false;
    pursuit.actionTriggered = false;

    // Ensure sails are set so the ship makes way toward the target
    if (voyage.canvas === 'hove' || voyage.canvas === 'bare') {
      orderCanvas('full');
    }

    // Prepare the 3D encounter vessel (sets faction/colors/AI without snapping alongside)
    cfg.onBeginPursuit?.(enc, mode);

    const vessels = cfg.getVessels?.() ?? [];
    const targetV = vessels[1] ?? null;
    const tb = targetV?.boat ?? targetV;
    let dist = Infinity;
    let brgTrue = enc.bearingDeg ?? boat.heading ?? 0;
    if (tb && tb.showProw !== false) {
      const dx = (tb.x ?? 0) - (boat.x ?? 0);
      const dz = (tb.z ?? 0) - (boat.z ?? 0);
      dist = Math.hypot(dx, dz);
      if (dist > 1) {
        brgTrue = voyageWrap360((Math.atan2(dx, -dz) * 180) / Math.PI);
      }
    }

    // Engage helmsman to steer directly toward the target vessel
    helmsman.engaged = true;
    manualHelm = false;
    const compassTarget = voyageWrap360(brgTrue - (voyage.variation ?? 0));
    orderCourse(helmsman, compassTarget, { beat: true });
    voyage.compassCourse = helmsman.compassCourse;

    if (tb && tb.showProw !== false && dist > pursuit.battleRangeM) {
      // Keep time dilation at Watch (60×) while steering to close the distance to battle range!
      setWarpTier(voyage, 'watch');
      voyage.rate = Math.min(warpTier('watch').rate, voyage.warpCap ?? 3600);
      updateHud();
    } else {
      // Already within battle range (or headless test without 3D vessel): stop time dilation immediately
      pursuit.battleRangeReached = true;
      setWarp('deck');
      cfg.onEnterBattleRange?.(enc, mode, targetV);
      if (mode === 'board') {
        pursuit.actionTriggered = true;
        pursuit.active = false;
        cfg.onBoardVessel?.(enc, targetV);
      } else if (mode === 'hail') {
        pursuit.actionTriggered = true;
        pursuit.active = false;
        cfg.onHailVessel?.(enc, targetV);
      } else {
        pursuit.actionTriggered = true;
        pursuit.active = false;
        cfg.onEngageVessel?.(enc, { mode: 'fight', targetVessel: targetV });
      }
    }
  }

  function stepEncounterPursuit(dt) {
    if (!pursuit.active || !voyage) return;
    const vessels = cfg.getVessels?.() ?? [];
    const targetV = vessels[1] ?? null;
    const tb = targetV?.boat ?? targetV;
    if (!tb || tb.damage?.sunk || tb.showProw === false) {
      pursuit.active = false;
      return;
    }

    const dx = (tb.x ?? 0) - (boat.x ?? 0);
    const dz = (tb.z ?? 0) - (boat.z ?? 0);
    let dist = Math.hypot(dx, dz);
    const dirX = dist > 1e-3 ? dx / dist : 0;
    const dirZ = dist > 1e-3 ? dz / dist : -1;

    // Continuously steer the helmsman toward the target ship's live 3D position
    if (!manualHelm) {
      helmsman.engaged = true;
      const brgTrue = voyageWrap360((Math.atan2(dx, -dz) * 180) / Math.PI);
      const compassTarget = voyageWrap360(brgTrue - (voyage.variation ?? 0));
      orderCourse(helmsman, compassTarget, { beat: true });
      voyage.compassCourse = helmsman.compassCourse;
    }

    // While outside battle range, close the 3D distance proportional to time dilation so the
    // player visibly steers toward the distant ship and watches her grow larger on the horizon.
    if (!pursuit.battleRangeReached) {
      if (dist > pursuit.battleRangeM) {
        const playerSpd = Math.max(2.6, Math.hypot(boat.surgeVelocity ?? 0, boat.leewayVelocity ?? 0));
        const warpFactor = Math.max(1, Math.min(28, (voyage.rate ?? 1) * 0.42));
        const closeStep = Math.min(dist - (pursuit.battleRangeM - 6), playerSpd * warpFactor * dt);
        if (closeStep > 0) {
          tb.x -= dirX * closeStep;
          tb.z -= dirZ * closeStep;
          dist = Math.hypot((tb.x ?? 0) - (boat.x ?? 0), (tb.z ?? 0) - (boat.z ?? 0));
        }
      }

      if (dist <= pursuit.battleRangeM) {
        pursuit.battleRangeReached = true;
        // Stop time dilation immediately upon entering battle range!
        setWarpTier(voyage, 'deck');
        voyage.rate = 1;
        voyage.targetRate = 1;
        voyage.warpCap = 1;
        updateHud();

        const enc = pursuit.encounter;
        cfg.onEnterBattleRange?.(enc, pursuit.mode, targetV);
        if (pursuit.mode === 'fight') {
          cfg.onEngageVessel?.(enc, { mode: 'fight', targetVessel: targetV });
          showToast(`Within cannon range (${Math.round(dist)} m) of ${enc.shipName} — time dilation stopped (1× On deck)! Run out the guns!`, 8);
        } else if (pursuit.mode === 'board') {
          showToast(`Within battle range (${Math.round(dist)} m) — time dilation stopped (1×)! Steering alongside ${enc.shipName} to grapple & board!`, 8);
        } else if (pursuit.mode === 'hail') {
          showToast(`Within hailing approach (${Math.round(dist)} m) — time dilation stopped (1×)! Closing to speaking-trumpet range…`, 7);
        }
      }
      return;
    }

    // Inside battle range at 1× real time the game sails both hulls, so the target is never dragged:
    // the two manoeuvre into grappling reach by themselves. Only a caller that sails no hulls and says
    // so (cfg.closeHullsInPursuit) has the range closed for it here. It is never guessed from whether
    // the player moved: a ship aground or moored is still, and her chase must not be hauled alongside.
    const closeHulls = Boolean(cfg.closeHullsInPursuit);

    if (pursuit.mode === 'fight') {
      if (dist <= 165) {
        pursuit.actionTriggered = true;
        pursuit.active = false;
      }
    } else if (pursuit.mode === 'board') {
      if (tb && Number.isFinite(tb.surgeVelocity) && tb.surgeVelocity > 2.2) {
        tb.surgeVelocity = Math.max(1.8, tb.surgeVelocity - 0.6 * dt);
      }
      if (closeHulls && dist > pursuit.boardRangeM) {
        const closeStep = Math.min(dist - (pursuit.boardRangeM - 2), 14.5 * dt);
        tb.x -= dirX * closeStep;
        tb.z -= dirZ * closeStep;
        dist = Math.hypot((tb.x ?? 0) - (boat.x ?? 0), (tb.z ?? 0) - (boat.z ?? 0));
      }
      if (dist <= (closeHulls ? Math.max(pursuit.boardRangeM, 46) : pursuit.boardRangeM) && !pursuit.actionTriggered) {
        pursuit.actionTriggered = true;
        pursuit.active = false;
        cfg.onBoardVessel?.(pursuit.encounter, targetV);
      }
    } else if (pursuit.mode === 'hail') {
      if (closeHulls && dist > pursuit.hailRangeM) {
        const closeStep = Math.min(dist - (pursuit.hailRangeM - 2), 12.0 * dt);
        tb.x -= dirX * closeStep;
        tb.z -= dirZ * closeStep;
        dist = Math.hypot((tb.x ?? 0) - (boat.x ?? 0), (tb.z ?? 0) - (boat.z ?? 0));
      }
      if (dist <= pursuit.hailRangeM && !pursuit.actionTriggered) {
        pursuit.actionTriggered = true;
        pursuit.active = false;
        cfg.onHailVessel?.(pursuit.encounter, targetV);
      }
    }
  }

  function presentPrizeDisposition(targetVessel, plunder = {}) {
    if (!voyage || !targetVessel?.boat) return;
    const tb = targetVessel.boat;
    const shipName = tb.shipName || tb.name || 'Captured Prize';
    const stores = plunder.stores ?? {};
    const storesLabel = (id) => {
      const s = stores[id];
      return s ? `+${s.food} d food, +${s.water} d water` : '';
    };
    const cannonCount = plunder.cannons ?? 0;
    const ableCrew = plunder.impressCount ?? 0;
    const repairPct = Math.round((plunder.scuttleHullRepair ?? 0) * 100);
    const showIndigenousGift = Boolean(plunder.hasMetIndigenous || cfg.hasMetIndigenous?.());
    const choices = [
      { id: 'ally', label: `🏴 Add to Fleet as Allied Consort (${storesLabel('ally')})` },
      ...(showIndigenousGift
        ? [{ id: 'gift-indigenous', label: `🛡️ Gift Prize${plunder.giftCannons ? ' & Cannon' : ''} to Indigenous Allies (${storesLabel('gift-indigenous')})` }]
        : []),
      { id: 'impress-plunder', label: `⚓ ${ableCrew ? `Impress ${ableCrew} Hands` : 'Free Her Crew'}${cannonCount ? ` & Plunder ${cannonCount} Cannon` : ableCrew ? '' : ' & Take Her Stores'} (${storesLabel('impress-plunder')})` },
      { id: 'scuttle-repair', label: `🔨 Strip & Scuttle for Repairs (hull +${repairPct}%, ${storesLabel('scuttle-repair')})` },
    ];
    raiseInterrupt(
      voyage,
      {
        type: 'prize-disposition',
        title: `⚔️ Prize Taken · ${shipName}`,
        text: `Victory! ${shipName} has struck her colors to our boarding party. Aboard we find ${cannonCount ? `${cannonCount} serviceable cannon, ` : ''}${ableCrew ? `${ableCrew} able hands, and ` : ''}seasoned oak timber & canvas (+${repairPct}% hull & rig repair if scuttled). ${plunder.freedCaptives ? 'The captives in her hold are free, and we will carry them ashore. ' : ''}${plunder.coinLabel ? `Her strongbox holds ${plunder.coinLabel}${showIndigenousGift ? ', ours unless she is gifted' : ''}. ` : ''}What are your orders for the prize?`,
        targetVessel,
        plunder,
        choices,
        log: `Captured prize ${shipName}. Awaiting captain's disposition orders.`,
      },
      'deck'
    );
    showCallout(voyage.interrupt);
    emit('change');
  }

  // Our own ship is going down. Only one choice remains, so warp cannot dismiss it.
  function presentShipwreck() {
    if (!voyage || voyage.interrupt?.type === 'shipwreck') return;
    const shipName = voyage.shipName ?? 'The ship';
    raiseInterrupt(
      voyage,
      {
        type: 'shipwreck',
        title: `Abandon ship · ${shipName}`,
        text: `${shipName} is going down beneath us. Whatever is in her hold goes with her. All hands to the boats, and make for the nearest port.`,
        choices: [{ id: 'boats', label: 'Take to the boats' }],
        log: `${shipName} foundered. All hands ordered to the boats.`,
      },
      'deck'
    );
    showCallout(voyage.interrupt);
    emit('change');
  }

  function logExternal(text, kind = 'entry') {
    if (!voyage || !text) return;
    addLog(voyage, text, kind);
    emit('change');
  }

  function triggerSailEncounter() {
    if (cfg.isBattleActive?.()) {
      showToast('The lookout has no eyes for strange sails while we are engaged.');
      return null;
    }
    if (interruptHoldsTheDeck(voyage?.interrupt)) {
      showToast('The lookout is not heard until the call before us is answered.');
      return null;
    }
    promoteActive();
    setHudVisible(true);
    return encounterDirector.spawnSailEncounter(voyage, boat, {
      marineLife: cfg.getMarineLife?.() ?? null,
      terrain: getTerrain(),
      vessels: cfg.getVessels?.() ?? [],
      onSightVessel: (enc) => cfg.onSightVessel?.(enc),
      onToast: showToast,
      onInterrupt: showCallout,
    });
  }

  // Night as the lookout has it: null by day and twilight, else whether the Moon lights the land.
  function nightSight() {
    const sky = astronomy?.mode === 'astronomy' ? astronomy.state : null;
    if (!sky || sky.sun.altitude > -6) return null;
    return { moonlit: sky.moon.altitude > 5 && sky.moon.phase >= 0.25 };
  }
  const landHoChoices = (night) => [
    ...(night ? [{ id: 'lay-to', label: 'Lay to until first light' }] : []),
    { id: 'stand-in', label: 'Stand in toward the land' },
    { id: 'spyglass', label: '🔭 Spyglass' },
    { id: 'hold', label: 'Hold our course' },
    { id: 'chart', label: 'Open the chart' },
  ];
  // What a careful master did off a strange coast: stay put under little sail and wait for day.
  // First light where she lies: twenty minutes after the Sun next climbs to within six degrees of the horizon.
  // The hour that happens at runs from before five to after eight with the season and the latitude.
  function firstLightMs(v) {
    try {
      const observer = { latitude: v.true.lat, longitude: v.true.lon, height: 0 };
      let dark = false;
      for (let ms = v.dateMs, end = ms + 26 * 3600000; ms <= end; ms += 600000) {
        if (computeAstronomy(ms, observer).sun.altitude <= -6) dark = true;
        else if (dark) return ms + 1200000;
      }
    } catch { /* no ephemeris: fall back on the hour */ }
    return null;
  }
  function layToUntilFirstLight() {
    if (voyage.canvas !== 'furl') orderCanvas('hove');
    const dawn = firstLightMs(voyage);
    if (dawn) voyage.dateMs = dawn;
    else alignDateToDaylightIfNight(voyage, 7.2);
    addLog(voyage, 'Lay to until first light.', 'order');
  }

  function resolveInterrupt(choiceId) {
    const it = voyage?.interrupt;
    if (!it) return;
    if (it.type === 'sail' && choiceId === 'spyglass') {
      // Climb to the crow's nest and look at the distant ship through the spyglass without dismissing the tactical choices!
      const enc = it.encounter;
      const vessels = cfg.getVessels?.() ?? [];
      const report = cfg.onInspectEncounter?.(enc, vessels[1] ?? null) ?? describeEncounterThroughSpyglass(enc, vessels[1] ?? null);
      it.title = `🔭 Crow's Nest Spyglass · ${enc?.shipName ?? 'Strange Sail'}`;
      it.text = `${report} What are your orders?`;
      it.choices = [
        { id: 'fight', label: '⚔️ Clear for action! (Attack)' },
        { id: 'board', label: '🪝 Grapple & board her!' },
        { id: 'hail', label: '🎺 Close to hail' },
        { id: 'hold', label: 'Hold course' },
        { id: 'avoid', label: 'Bear away to avoid' },
        { id: 'spyglass', label: '🔭 Re-aim Spyglass' },
      ];
      addLog(voyage, report, 'encounter');
      showCallout(it);
      emit('change');
      return;
    }
    if (it.type === 'land-ho' && choiceId === 'spyglass') {
      // The decision stays open behind the glass.
      cfg.onInspectLand?.();
      return;
    }
    if (choiceId === 'lay-to') {
      layToUntilFirstLight();
      if (it.type === 'land-ho') {
        it.title = 'First light';
        it.text = `Hove to through the night. At first light the land lies ${relativeBearingCall((it.bearing ?? boat.heading) - boat.heading)}.`;
        it.choices = landHoChoices(false);
        showCallout(it);
        emit('change');
        return;
      }
    }
    clearInterrupt(voyage);
    showCallout(null);
    if (it.type === 'storm') {
      if (choiceId === 'shorten') orderCanvas('reduced');
      if (choiceId === 'storm') orderCanvas('storm');
      if (choiceId === 'heave') orderCanvas('hove');
    } else if (it.type === 'land-ho') {
      if (choiceId === 'stand-in') {
        const brg = it.bearing ?? boat.heading;
        orderCourse(helmsman, voyageWrap360(brg - voyage.variation), { beat: false });
        voyage.compassCourse = helmsman.compassCourse;
        setWarp('watch');
      } else if (choiceId === 'chart') {
        emit('open-chart');
      }
    } else if (it.type === 'canvas') {
      if (choiceId === 'apply' && it.suggest) orderCanvas(it.suggest);
    } else if (it.type === 'sail') {
      encounterDirector.resolveDecision(choiceId, voyage, boat, helmsman, {
        onOrderCompassCourse: (c) => orderCompassCourse(c),
        onToast: showToast,
        onHailVessel: (enc) => {
          beginEncounterPursuit(enc, 'hail');
        },
        onEngageVessel: (enc, opts) => {
          beginEncounterPursuit(enc, opts?.board ? 'board' : 'fight');
        },
        onBoardVessel: (enc) => {
          beginEncounterPursuit(enc, 'board');
        },
      });
    } else if (it.type === 'prize-disposition') {
      cfg.onPrizeDisposition?.(choiceId, it.targetVessel, it.plunder);
    } else if (it.type === 'shipwreck') {
      cfg.onAbandonShip?.();
    } else if (it.type === 'arrival') {
      if (choiceId === 'chart') emit('open-chart');
    }
    emit('change');
  }

  // ------------------------------------------------------------------ Orders
  function promoteActive() {
    if (!voyage) {
      start({ passive: false });
      return;
    }
    if (voyage.passive) {
      voyage.passive = false;
      helmsman.engaged = true;
      manualHelm = false;
      if ((!astronomy || astronomy.mode === 'manual' || respectManualSky) && (P?.sunElev ?? 32) > 2) {
        alignDateToDaylightIfNight(voyage, (P?.sunAzim ?? 135) > 180 ? 14.2 : 9.8);
      }
      orderCourse(helmsman, voyage.compassCourse, { beat: helmsman.beat });
      beginScene({ showHud: true });
    }
  }
  let lastStepRate = 1;
  // Warp ends here. A hull that was racing has all sail struck as it does, so she lies safe
  // even if nobody takes the helm straight away. A warp that never began changes nothing else.
  function stopWarpForDanger(text) {
    if (voyage.rate <= 1.05 && voyage.tier === 'deck') return;
    const wasRacing = voyage.rate > 1.5 || lastStepRate > 1.5;
    setWarpTier(voyage, 'deck');
    voyage.rate = 1;
    voyage.targetRate = 1;
    voyage.warpCap = 1;
    if (wasRacing && voyage.canvas !== 'furl') orderCanvas('furl');
    addLog(voyage, text, 'order');
    showToast(wasRacing ? `${text} Warp is off and all sail struck. Make sail and take the helm to work her clear.` : `${text} No warp here: take the helm.`, 9);
    if (wasRacing && nightSight() && !voyage.interrupt) {
      raiseInterrupt(voyage, {
        type: 'lay-to',
        title: 'Danger close, in the dark',
        text: `${text} All sail is struck. There is little to be seen from the deck tonight.`,
        choices: [{ id: 'lay-to', label: 'Lay to until first light' }, { id: 'stay', label: 'Stay on deck' }],
      }, 'deck');
      showCallout(voyage.interrupt);
    }
    updateHud();
  }
  // Fire and a gaining leak run in real time, as a fight does: the clock cannot be run past them.
  const shipInPeril = () => {
    const damage = boat.damage;
    if (!damage || damage.sunk) return null;
    if ((damage.fireIntensity ?? 0) > 0.05) return 'fire';
    return (damage.floodingRate ?? 0) > 0.002 ? 'flood' : null;
  };
  // A fight is fought in real time. Closing on a distant enemy may run at watch speed, no faster.
  const warpLimitInAction = () => {
    if (shipInPeril()) return 1;
    if (!cfg.isBattleActive?.()) return Infinity;
    return pursuit.active && !pursuit.battleRangeReached ? warpTier('watch').rate : 1;
  };
  function setWarp(requested) {
    const limit = warpLimitInAction();
    if (warpTier(requested).rate > limit && limit <= 1) {
      const peril = shipInPeril();
      showToast(peril === 'fire' ? 'Not with fire aboard. Put it out first.'
        : peril === 'flood' ? 'Not while she is gaining water. Plug her and pump first.'
        : 'Not with an enemy in range. Fight her or run clear.', 5);
      return;
    }
    const id = warpTier(requested).rate > limit ? 'watch' : requested;
    const tierRate = warpTier(id).rate;
    if (tierRate > 1) {
      respectManualSky = false;
      if (voyage && (!astronomy || astronomy.mode === 'manual') && (P?.sunElev ?? 32) > 2) {
        alignDateToDaylightIfNight(voyage, (P?.sunAzim ?? 135) > 180 ? 14.2 : 9.8);
      }
      if (astronomy) astronomy.mode = 'astronomy';
    }
    promoteActive();
    // The wreck leaves one choice and a prize waits on the captain's word: neither is waved away by the clock.
    if (voyage.interrupt?.type === 'shipwreck') return;
    if (voyage.interrupt?.type === 'prize-disposition') {
      showToast('The prize waits on your word, Captain.', 5);
      return;
    }
    if (voyage.interrupt) {
      clearInterrupt(voyage);
      showCallout(null);
      if (encounterDirector?.state) encounterDirector.state.active = null;
    }
    setHudVisible(true);
    setWarpTier(voyage, id);
    // Forcing warp past a sighting is allowed, but how fast she may go is settled before the clock moves, from where
    // she lies now: the limit left by the last look may be a long way astern.
    if (tierRate > 1) {
      scanTimer = 0.5;
      runApproach(getTerrain()).catch(() => {});
    }
    voyage.rate = Math.min(warpTier(voyage.tier).rate, voyage.warpCap ?? 3600);
    updateHud();
    emit('change');
  }
  function orderCompassCourse(compassDeg, { beat } = {}) {
    promoteActive();
    setHudVisible(true);
    orderCourse(helmsman, compassDeg, { beat: beat ?? helmsman.beat });
    voyage.compassCourse = helmsman.compassCourse;
    manualHelm = false;
    addLog(voyage, `Ordered the helmsman to steer ${compassPointName(helmsman.compassCourse)} by the compass.`, 'order');
    emit('change');
  }
  /** Course laid on the chart in TRUE degrees; the pilot converts with his believed variation. */
  function layCourse(courseTrue, target = null) {
    promoteActive();
    const compass = voyageWrap360(courseTrue - voyage.pilot.variationEstimate);
    if (target) voyage.destination = { lat: target.lat, lon: target.lon, name: target.name ?? 'Destination' };
    orderCompassCourse(compass);
  }
  function alterCourse(deltaDeg) {
    if (!voyage) return;
    orderCompassCourse(voyageWrap360(helmsman.compassCourse + deltaDeg));
  }
  function keepHerSo() {
    promoteActive();
    orderCompassCourse(voyageWrap360(boat.heading - voyage.variation));
  }
  function tack() {
    if (!voyage) return;
    promoteActive();
    orderTack(helmsman);
    manualHelm = false;
    addLog(voyage, 'Went about onto the other tack.', 'order');
  }
  function orderCanvas(id) {
    if (!voyage) return;
    applyCanvasOrder(boat, id);
    voyage.canvas = id;
    if (hud) hud.canvasSel.value = id;
    cfg.onCanvasOrder?.(id);
    addLog(voyage, `Ordered: ${CANVAS_ORDERS[id]?.label ?? id}.`, 'order');
    emit('change');
  }

  // ------------------------------------------------------------------ Lifecycle
  function startGeo() {
    const t = getTerrain();
    if (t && regionLatLon) {
      const g = regionLatLon(t, boat.x, boat.z);
      if (g && Number.isFinite(g.latitude)) return { lat: g.latitude, lon: g.longitude, name: t.region?.name ?? 'the anchorage' };
    }
    return { lat: 36.6, lon: -6.72, name: DEFAULT_DEPARTURE.name };
  }

  function start(opts = {}) {
    const geo = startGeo();
    const passive = Boolean(opts.passive);
    voyage = createVoyage({
      lat: opts.lat ?? geo.lat,
      lon: opts.lon ?? geo.lon,
      departureName: opts.departureName ?? geo.name,
      dateMs: opts.dateMs ?? DEFAULT_DEPARTURE.dateMs,
      modelId: boat.modelId ?? 'nina',
      shipName: opts.shipName ?? boat.model?.name ?? 'Niña',
      difficulty: opts.difficulty ?? 'pilot',
      seed: opts.seed ?? Math.floor(Math.random() * 1e9),
      compassCourse: voyageWrap360(boat.heading - 0),
    });
    if (opts.dateMs === undefined) {
      alignDateToDaylightIfNight(voyage, (P?.sunAzim ?? 135) > 180 ? 14.2 : 9.8);
    } else normaliseVoyageEra(voyage);
    voyage.passive = passive;
    voyage.compassCourse = voyageWrap360(boat.heading - voyage.variation);
    orderCourse(helmsman, voyage.compassCourse);
    helmsman.engaged = !passive;
    manualHelm = passive;
    encounterDirector = createEncounterDirector({ seed: voyage.seed ^ 0x1550cafe });
    attachExistingTerrain();
    addLog(voyage, `${formatJulianDate(voyage.dateMs)}. Weighed anchor at ${geo.name} and stood out to sea. Variation by the needle ${Math.abs(voyage.pilot.variationEstimate)}° ${voyage.pilot.variationEstimate >= 0 ? 'NE' : 'NW'}.`, 'departure');
    beginScene({ showHud: opts.showHud ?? true, passive });
    updateHud();
    emit('change');
    return voyage;
  }

  function resume() {
    const raw = storage?.getItem?.(VOYAGE_STORAGE_KEY);
    const v = raw ? restoreVoyage(raw) : null;
    if (!v) return null;
    voyage = v;
    orderCourse(helmsman, voyage.compassCourse);
    helmsman.engaged = !voyage.passive;
    manualHelm = Boolean(voyage.passive);
    encounterDirector = encounterDirector ?? createEncounterDirector({ seed: voyage.seed ^ 0x1550cafe });
    applyCanvasOrder(boat, voyage.canvas);
    approach.landHoCalled = false;
    approach.landSighted = null;
    approach.offset = { x: 0, z: 0 };
    attachExistingTerrain();
    beginScene();
    showToast(`Voyage resumed — ${formatJulianDate(voyage.dateMs)}, day ${voyage.dayAtSea} at sea.`);
    emit('change');
    return voyage;
  }

  function hasSavedVoyage() {
    try { return Boolean(storage?.getItem?.(VOYAGE_STORAGE_KEY)); } catch { return false; }
  }

  function end({ keepSave = false } = {}) {
    if (!voyage) return;
    if (!keepSave) try { storage?.removeItem?.(VOYAGE_STORAGE_KEY); } catch { /* ignore */ }
    voyage = null;
    helmsman.engaged = false;
    if (astronomy) astronomy.rate = 1;
    setHudVisible(false);
    showCallout(null);
    emit('change');
  }

  function attachExistingTerrain() {
    const t = getTerrain();
    approach.spawnedTerrain = t ?? null;
    approach.departureTerrain = t ?? null;
    approach.departureCoords = t?.region && Number.isFinite(t.region.latitude) && Number.isFinite(t.region.longitude)
      ? { lat: t.region.latitude, lon: t.region.longitude }
      : null;
    approach.suppressLandHo = Boolean(t);
    approach.landHoCalled = false;
    approach.landSighted = null;
    approach.forceCoastLatLon = null;
    approach.offset = t?.worldOffset ? { x: t.worldOffset.x, z: t.worldOffset.z } : { x: 0, z: 0 };
    approach.committed = true;
    approach.lastBoat = { x: boat.x, z: boat.z };
  }

  /** Re-sync voyage coordinates and compass course after terrain repositions the ship (e.g. 1550 dock upgrade). */
  function syncToTerrainBoat() {
    if (!voyage) return;
    const geo = startGeo();
    if (Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
      voyage.true.lat = geo.lat;
      voyage.true.lon = geo.lon;
      voyage.dr.lat = geo.lat;
      voyage.dr.lon = geo.lon;
    }
    if (voyage.passive || voyage.distanceTrueNm < 0.05) {
      const wasEngaged = helmsman.engaged;
      voyage.compassCourse = voyageWrap360(boat.heading - voyage.variation);
      orderCourse(helmsman, voyage.compassCourse, { beat: helmsman.beat });
      if (voyage.passive) helmsman.engaged = wasEngaged;
    }
    attachExistingTerrain();
    syncAstronomy();
    updateHud();
  }

  function beginScene({ showHud = true, passive = false } = {}) {
    setHudVisible(showHud);
    if (hud) hud.canvasSel.value = voyage.canvas;
    weatherDriver.reset();
    if (astronomy && !passive && !respectManualSky) {
      astronomy.mode = 'astronomy';
      astronomy.rate = 0;
    }
    syncAstronomy();
    if (astronomy) lastAstroRevision = astronomy.revision ?? -1;
    voyage.weather = null;
  }

  function persist(now) {
    if (!voyage || (voyage.passive && !voyage.keepSaved) || !storage || now - lastPersist < 5000) return;
    lastPersist = now;
    try { storage.setItem(VOYAGE_STORAGE_KEY, serializeVoyage(voyage)); } catch { /* quota */ }
  }

  function syncAstronomy() {
    if (!astronomy || !voyage) return;
    if (astronomy.revision !== undefined && astronomy.revision !== lastAstroRevision) {
      if (astronomy.mode === 'manual') {
        respectManualSky = true;
      } else {
        respectManualSky = false;
        const userTimeMs = astronomy.epochMs + (astronomy.elapsedSeconds || 0) * 1000;
        // A night picked from after the voyage's era is shown by the sky panel but never dates the log.
        if (voyageDateInEra(userTimeMs)) voyage.dateMs = userTimeMs;
      }
      lastAstroRevision = astronomy.revision;
    }
    // Always keep the geographic observer anchor synced to the ship's live lat/lon.
    astronomy.anchor = { latitude: voyage.true.lat, longitude: voyage.true.lon, x: boat.x, z: boat.z };
    // Free sail leaves the sky clock to the sky panel: writing it here every frame would stop its
    // time-lapse rate from ever accumulating and replace whatever night the player picked.
    if (!voyage.passive && !respectManualSky) {
      // Sun, moon and stars follow the warped voyage clock and the ship's true position.
      astronomy.mode = 'astronomy';
      astronomy.rate = 0;
      astronomy.epochMs = voyage.dateMs;
      astronomy.elapsedSeconds = 0;
      astronomy.update?.(0, boat);
    }
  }

  // ------------------------------------------------------------------ Per-frame
  function steer(dt) {
    if (!voyage || manualHelm || !helmsman.engaged) return;
    steerHelmsman(helmsman, boat, dt, {
      windSpeed: P.windSpeed,
      windDirection: (P.windDir * Math.PI) / 180,
      variation: voyage.variation,
      gameDt: dt * voyage.rate,
    });
  }

  /** Called when the player steers by hand (A/D). The helmsman stands by until re-ordered. */
  function manualSteering(active) {
    if (!voyage) return;
    if (active && !manualHelm) {
      manualHelm = true;
      showToast('You have the helm. Press K to give it back to the helmsman ("keep her so").', 5);
    }
  }

  function update(dt, now = typeof performance !== 'undefined' ? performance.now() : 0) {
    if (!voyage || !(dt > 0)) return { spectrum: false, env: false };
    // Time must not race past a ship that has taken the ground.
    if (voyage.rate > 1.05 && (boat.aground || boat.coastBlocked || boat.shoalScraping)) {
      setWarp('deck');
      showToast('She has taken the ground. Time slowed to deck watch: take the helm and work her off.', 8);
    }
    const actionLimit = warpLimitInAction();
    if (voyage.rate > actionLimit * 1.05 || warpTier(voyage.tier).rate > actionLimit) {
      const peril = shipInPeril();
      if (peril) showToast(peril === 'fire' ? 'Fire aboard! Time slowed to deck watch.' : 'She is gaining water! Time slowed to deck watch.', 7);
      setWarpTier(voyage, actionLimit <= 1 ? 'deck' : 'watch');
      voyage.rate = Math.min(voyage.rate, actionLimit);
      voyage.targetRate = voyage.rate;
      updateHud();
    }
    const terrain = getTerrain();
    const span = terrain?.region?.span ?? 8192;
    const baseReg0 = terrain?.baseRegion ?? terrain?.region;
    const tDist = baseReg0
      ? Math.hypot(
          boat.x - ((baseReg0.x ?? 0) + approach.offset.x),
          boat.z - ((baseReg0.z ?? 0) + approach.offset.z)
        )
      : Infinity;
    const isDepartureTerrain = Boolean(terrain && terrain === approach.departureTerrain);
    // Past the middle of her departure coast she may still be in its river or under its headlands: while its land
    // lies about her it stays, sliding by under warp like any coast, and is let go only once she is clear of it.
    if (isDepartureTerrain && tDist >= span * 0.95) {
      approach.coastHeldCheckIn = (approach.coastHeldCheckIn ?? 0) - dt;
      if (voyage.rate > 1.05 || approach.coastHeldCheckIn <= 0) {
        approach.coastHeldCheckIn = 0.5;
        approach.departureCoastHeld = tDist < span * COAST_REACH_SPANS && coastLiesAlongside(terrain, DEPARTURE_COAST_HOLD_M);
      }
    } else {
      approach.departureCoastHeld = false;
      approach.coastHeldCheckIn = 0;
    }
    const departureCoastHeld = approach.departureCoastHeld;
    // When warping out of the departure port, once the ship is clear of the 3D coast,
    // free the departure terrain so open-ocean waves run at normal 1x real time while time and distance warp.
    if (isDepartureTerrain && voyage.rate > 1.05 && tDist >= span * 0.95 && !departureCoastHeld && cfg.disposeTerrain) {
      cfg.disposeTerrain(terrain);
      approach.spawnedTerrain = null;
      approach.departureTerrain = null;
      approach.departureCoastHeld = false;
      if (voyage.distanceTrueNm >= 6) approach.suppressLandHo = false;
      approach.offset = { x: 0, z: 0 };
    }
    const activeTerrain = getTerrain();
    const inCoastalPack = Boolean(
      activeTerrain &&
      approach.spawnedTerrain === activeTerrain &&
      typeof activeTerrain.setWorldOffset === 'function' &&
      (isDepartureTerrain ? tDist < span * 0.95 || departureCoastHeld : tDist < 250000)
    );
    const ignoreCurrent = Boolean(activeTerrain) && (voyage.rate <= 1.05 || (inCoastalPack && tDist < span * 2.5));
    const prevTrue = { lat: voyage.true.lat, lon: voyage.true.lon };
    const prevDr = { lat: voyage.dr.lat, lon: voyage.dr.lon };
    const prevDistTrue = voyage.distanceTrueNm;
    const prevDistLogged = voyage.distanceLoggedNm;
    const prevDateMs = voyage.dateMs;
    const prevRate = voyage.rate;
    lastStepRate = prevRate;
    const isConfirmedLand = (lat, lon) => {
      const elev = probe.elevation?.(lat, lon);
      if (elev !== undefined && elev > -900) return elev > 0.5;
      return Boolean(coastIndex?.isLand?.(lat, lon));
    };
    const wasOnCoarseLand = isConfirmedLand(prevTrue.lat, prevTrue.lon);
    // Too fast to watch: a gale simply costs a hand now and then.
    if (!voyage.passive && voyage.rate > 30 && (P?.windSpeed ?? 0) >= GALE_LOSS_WIND) {
      const hours = (dt * voyage.rate) / 3600;
      if (Math.random() < hours * GALE_LOSS_PER_HOUR * (1 + (P.windSpeed - GALE_LOSS_WIND) / 6)) {
        const lost = cfg.onHandLostInGale?.();
        if (lost) {
          const name = lost.sailor?.name ?? 'A hand';
          addLog(voyage, `${name} was washed overboard in the gale and lost.`, 'order');
          showToast(`${name} was washed overboard in the gale and lost.`, 8);
        }
      }
    }
    const events = stepVoyage(voyage, dt, { boat, ignoreCurrent });
    handleEvents(events);

    const dxLocal = boat.x - approach.lastBoat.x, dzLocal = boat.z - approach.lastBoat.z;
    const { eastM, northM } = voyage.lastStep;
    let extraX = eastM - dxLocal, extraZ = -northM - dzLocal;
    let extraDist = Math.hypot(extraX, extraZ);

    // Prevent high warp in the open ocean from crossing onto continental land before coastal terrain has spawned or reached visual range.
    if (!(inCoastalPack && tDist < span * 0.75) && prevRate > 1.05 && extraDist > 1 && !wasOnCoarseLand && isConfirmedLand(voyage.true.lat, voyage.true.lon)) {
      let lo = 0, hi = 1;
      for (let iter = 0; iter < 8; iter++) {
        const mid = (lo + hi) * 0.5;
        const mLat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * mid;
        const mLon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * mid;
        if (isConfirmedLand(mLat, mLon)) hi = mid;
        else lo = mid;
      }
      const coastLat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * hi;
      const coastLon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * hi;
      const safeFrac = Math.max(0, lo - Math.min(lo, 1200 / Math.max(1200, extraDist)));
      voyage.true.lat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * safeFrac;
      voyage.true.lon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * safeFrac;
      voyage.dr.lat = prevDr.lat + (voyage.dr.lat - prevDr.lat) * safeFrac;
      voyage.dr.lon = prevDr.lon + (voyage.dr.lon - prevDr.lon) * safeFrac;
      voyage.distanceTrueNm = prevDistTrue + (voyage.distanceTrueNm - prevDistTrue) * safeFrac;
      voyage.distanceLoggedNm = prevDistLogged + (voyage.distanceLoggedNm - prevDistLogged) * safeFrac;
      voyage.dateMs = Math.round(prevDateMs + (voyage.dateMs - prevDateMs) * safeFrac);
      extraX *= safeFrac;
      extraZ *= safeFrac;
      extraDist *= safeFrac;
      approach.suppressLandHo = false;
      approach.forceCoastLatLon = { lat: coastLat, lon: coastLon };
      stopWarpForDanger('Land close ahead.');
      scanTimer = 0;
    }

    // While a coastal pack is resident, slide/commit the 3D terrain onto the hull so land, trees, and harbour works
    // stay locked to lat/lon and cannot be warped through. Outside the coastal pack (open ocean), waves act normal at 1x.
    // At deck watch the hull sails the land in real time and the land's own grounding rules stop her. What is left
    // over here is only what the reckoning leaves out (leeway, a haul on a line, a shove from another hull): sliding
    // the land by that, or reading it as a step toward a shoal, would hold the ship and her clock where they are.
    const warped = prevRate > 1.05 || voyage.rate > 1.05;
    // How far warp carried her this frame beyond what the hull sailed: whatever keeps its own place on the sea falls
    // astern by this much.
    let carryX = warped ? extraX : 0, carryZ = warped ? extraZ : 0;
    if (inCoastalPack) {
      let safeFrac = 1;
      const stepExtraX = warped ? extraX : 0, stepExtraZ = warped ? extraZ : 0;
      if (warped && tDist < span * COAST_REACH_SPANS && extraDist > 1e-4 && typeof activeTerrain.height === 'function') {
        const draft = boat.hydrodynamics?.draft ?? 2.0;
        const minSafeBed = -Math.max(3.2, draft * 1.35);
        const startBed = activeTerrain.height(boat.x, boat.z);
        const bowLead = Math.max(24, (boat.length ?? 22) * 1.1);
        const warping = prevRate > 1.05;
        const contactStandoffM = Math.max(42, (boat.length ?? 22) * 1.9);
        const hullSpeed = Math.hypot(boat.surgeVelocity ?? 0, boat.leewayVelocity ?? 0);
        const warpStopM = warpStandoffM(hullSpeed);
        const portsList = activeTerrain.ports ?? (activeTerrain.port ? [activeTerrain.port] : null);
        const steps = Math.max(1, Math.min(2000, Math.ceil(extraDist / 6)));
        const shoalAt = (h) => h > minSafeBed && (startBed <= minSafeBed || h > startBed + 0.05);
        let struckInStep = false;
        const traceRay = (rx, rz) => {
          const rDist = Math.hypot(rx, rz) || 1;
          const dX = rx / rDist, dZ = rz / rDist;
          const standoffM = warping ? warpStopM : contactStandoffM;
          for (let k = 1; k <= steps; k++) {
            const frac = k / steps;
            const wx = boat.x + rx * frac, wz = boat.z + rz * frac;
            activeTerrain.ensureSectionAt?.(wx, wz);
            const hKeel = activeTerrain.height(wx, wz);
            const hBow = activeTerrain.height(wx + dX * bowLead, wz + dZ * bowLead);
            let h = Math.max(hKeel, hBow);
            let hitStructure = false;
            if (activeTerrain.region) {
              const probeContact = probeHullBottomContact(
                null,
                boat,
                wx,
                wz,
                activeTerrain.region,
                (px, pz) => activeTerrain.height(px, pz),
                { ports: portsList }
              );
              if (Number.isFinite(probeContact.worstBed)) {
                h = Math.max(h, probeContact.worstBed);
              }
              hitStructure = Boolean(probeContact.hitStructure);
            }
            if (hitStructure || shoalAt(h)) {
              struckInStep = true;
              const clearDist = Math.max(0, ((k - 1) / steps) * rDist - standoffM);
              return clearDist / rDist;
            }
          }
          // Warp must also leave her room beyond the step to stop and turn.
          if (warping) {
            for (let d = rDist + 24; d <= rDist + standoffM; d += 24) {
              const wx = boat.x + dX * d, wz = boat.z + dZ * d;
              activeTerrain.ensureSectionAt?.(wx, wz);
              if (shoalAt(activeTerrain.height(wx, wz))) return Math.max(0, d - 24 - standoffM) / rDist;
            }
          }
          return 1;
        };
        safeFrac = traceRay(stepExtraX, stepExtraZ);
        if (safeFrac < 1) {
          voyage.true.lat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * safeFrac;
          voyage.true.lon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * safeFrac;
          voyage.dr.lat = prevDr.lat + (voyage.dr.lat - prevDr.lat) * safeFrac;
          voyage.dr.lon = prevDr.lon + (voyage.dr.lon - prevDr.lon) * safeFrac;
          voyage.distanceTrueNm = prevDistTrue + (voyage.distanceTrueNm - prevDistTrue) * safeFrac;
          voyage.distanceLoggedNm = prevDistLogged + (voyage.distanceLoggedNm - prevDistLogged) * safeFrac;
          voyage.dateMs = Math.round(prevDateMs + (voyage.dateMs - prevDateMs) * safeFrac);
          if (struckInStep && safeFrac < 0.08) {
            boat.surgeVelocity = Math.min(boat.surgeVelocity ?? 0, 0.6);
          }
          if (prevRate > 1.05 || voyage.rate > 1.05) stopWarpForDanger('Shoal water ahead.');
        }
      }
      let sx = -stepExtraX * safeFrac, sz = -stepExtraZ * safeFrac;
      carryX = stepExtraX * safeFrac;
      carryZ = stepExtraZ * safeFrac;
      const baseReg = activeTerrain.baseRegion ?? activeTerrain.region;
      if (!isDepartureTerrain && tDist >= span * 1.5 && Number.isFinite(baseReg?.latitude) && Number.isFinite(baseReg?.longitude)) {
        const desired = regionLocalOrigin({
          shipLat: voyage.true.lat,
          shipLon: voyage.true.lon,
          shipX: boat.x,
          shipZ: boat.z,
          regionLat: baseReg.latitude,
          regionLon: baseReg.longitude,
        });
        const curX = (baseReg.x ?? 0) + approach.offset.x;
        const curZ = (baseReg.z ?? 0) + approach.offset.z;
        sx = desired.x - curX;
        sz = desired.z - curZ;
      }
      if (Math.abs(sx) > 1e-4 || Math.abs(sz) > 1e-4) {
        approach.offset.x += sx;
        approach.offset.z += sz;
        activeTerrain.setWorldOffset(approach.offset.x, approach.offset.z);
        approach.committed = false;
      }
      if (!approach.committed && typeof activeTerrain.commitWorldOffset === 'function' && Math.hypot(approach.offset.x, approach.offset.z) >= 0.05) {
        const preCommitX = boat.x, preCommitZ = boat.z;
        const cam = cfg.getCamera?.() ?? null;
        activeTerrain.commitWorldOffset({
          boat,
          camera: cam,
          vessels: cfg.getVessels?.() ?? null,
          marineLife: cfg.getMarineLife?.() ?? null,
          dolphins: cfg.getDolphins?.() ?? null,
        });
        approach.offset = { x: 0, z: 0 };
        approach.committed = true;
        if (tDist < span * COAST_REACH_SPANS && typeof activeTerrain.constrain === 'function') {
          const postCommitX = boat.x, postCommitZ = boat.z;
          const constrained = activeTerrain.constrain(boat, preCommitX, preCommitZ, { warpStep: true });
          if (constrained || Math.hypot(boat.x - postCommitX, boat.z - postCommitZ) > 1e-3) {
            if (cam) {
              cam.x += boat.x - postCommitX;
              cam.z += boat.z - postCommitZ;
            }
            if (prevRate > 1.05 || voyage.rate > 1.05) stopWarpForDanger('Shoal water ahead.');
          }
        }
      }
      // Keep lat/lon strictly locked to the 3D coastal terrain while inside the pack.
      if (regionLatLon && activeTerrain.region && tDist < span * 1.5) {
        const g = regionLatLon(activeTerrain, boat.x - approach.offset.x, boat.z - approach.offset.z);
        if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
          voyage.true.lat = g.latitude;
          voyage.true.lon = g.longitude;
          if (tDist < span * 1.15 || safeFrac < 1 || boat.aground) {
            voyage.dr.lat = g.latitude;
            voyage.dr.lon = g.longitude;
          }
        }
      }
    }
    if (Math.abs(carryX) > 1e-4 || Math.abs(carryZ) > 1e-4) cfg.onWarpCarry?.(carryX, carryZ);
    approach.lastBoat = { x: boat.x, z: boat.z };

    // Open-ocean encounters (whales & strange sails with lookout callouts).
    encounterDirector.step(voyage, boat, dt, {
      battleActive: Boolean(cfg.isBattleActive?.()),
      coastKm: approach.coastKm,
      marineLife: cfg.getMarineLife?.() ?? null,
      terrain: activeTerrain,
      vessels: cfg.getVessels?.() ?? [],
      onSightVessel: (enc) => cfg.onSightVessel?.(enc),
      onToast: showToast,
      onInterrupt: showCallout,
    });

    // Active 3D ship pursuit: steer toward target and stop time dilation at battle range
    stepEncounterPursuit(dt);

    // Weather follows the voyage clock when the voyage is actively engaged.
    const w = voyage.passive
      ? { spectrum: false, env: false }
      : weatherDriver.update(P, voyage.weather, voyage.rate, dt);
    if (w.spectrum) onSpectrum();
    if (w.env) onEnv();
    syncAstronomy();

    // Seamanship advice when canvas doesn't suit the wind (only during active passage).
    const advice = voyage.passive ? null : canvasAdvice(voyage.canvas, P.windSpeed);
    const adviceKey = advice ? advice.severity + voyage.canvas : null;
    if (advice && adviceKey !== lastAdvice && !voyage.interrupt) {
      lastAdvice = adviceKey;
      showToast(advice.text, 7);
    } else if (!advice) lastAdvice = null;

    scanTimer -= dt;
    const fastNearCoast = voyage.rate > 60 && (approach.coastKm < 180 || Boolean(activeTerrain));
    if ((scanTimer <= 0 || fastNearCoast || approach.forceCoastLatLon) && !voyage.passive) {
      scanTimer = fastNearCoast ? 0.08 : 0.5;
      runApproach(activeTerrain);
    }
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0 && hud) hud.root.querySelector('.voyage-toast').hidden = true;
    }
    updateHud();
    persist(now);
    return w;
  }

  function handleEvents(events) {
    for (const e of events) {
      if (e.type === 'noon') {
        showToast(e.fix ? `Noon. The pilot shoots the sun with his astrolabe: ${formatLatitude(e.lat)}.` : 'Noon. Overcast — no sun to be had for the astrolabe.');
      } else if (e.type === 'storm') {
        const s = e.system;
        const side = relativeBearingCall(s.bearing - boat.heading);
        raiseInterrupt(voyage, {
          type: 'storm',
          title: s.kind === 'hurricane' ? '¡Huracán!' : 'Foul weather',
          text: s.kind === 'hurricane'
            ? `The glass is falling fast and a long swell runs from ${side}. The pilot fears a huracán. What are your orders?`
            : `The sky to ${compassPointName(s.bearing)} is the colour of a bruise and the wind is rising. What are your orders?`,
          choices: [{ id: 'shorten', label: 'Shorten sail' }, { id: 'storm', label: 'Storm canvas' }, { id: 'heave', label: 'Heave to' }, { id: 'carry', label: 'Carry on' }],
          log: `Weather threatening from the ${compassPointName(s.bearing)}.`,
        }, 'watch');
        showCallout(voyage.interrupt);
      } else if (e.type === 'provisions') {
        showToast(e.text, 8);
        addLog(voyage, e.text, 'stores');
      } else if (e.type === 'weather') {
        showToast(`The wind ${e.to > e.from ? 'freshens' : 'moderates'} — now ${windDescription(e.weather.windSpeed)} from the ${compassPointName(e.weather.windFrom)}.`);
      }
    }
    if (events.length) emit('change');
  }

  // Always false, so it can sit in the sighting test: builds the coast along a bearing.
  function requestCoastToward(terrain, bearing) {
    const rad = (bearing * Math.PI) / 180, sx = Math.sin(rad), sz = -Math.cos(rad), span = terrain.region?.span ?? 8192;
    for (let d = span * 0.5; d <= 34000; d += span * 0.5) terrain.ensureSectionAt?.(boat.x + sx * d, boat.z + sz * d);
    return false;
  }

  // A coast is built four spans either side of its middle (js/terrain.js coverageAt); the guards that read its bed
  // stop a little short of that, so what they look ahead at is still inside it.
  const COAST_REACH_SPANS = 3.9;
  // Land this near is still the coast she is leaving.
  const DEPARTURE_COAST_HOLD_M = 9000;
  function coastLiesAlongside(terrain, radiusM) {
    if (typeof terrain?.height !== 'function') return false;
    for (let a = 0; a < 16; a++) {
      const rad = (a * Math.PI) / 8, sx = Math.sin(rad), sz = -Math.cos(rad);
      for (const d of [radiusM * 0.25, radiusM * 0.5, radiusM * 0.75, radiusM]) {
        if (terrain.height(boat.x + sx * d, boat.z + sz * d) > 0.5) return true;
      }
    }
    return false;
  }

  async function runApproach(terrain) {
    const lat = voyage.true.lat, lon = voyage.true.lon;
    const eyeM = lookoutEyeHeight(boat.modelId);
    const v = hullVelocity(boat);
    const groundEast = v.east + voyage.current.east;
    const groundNorth = v.north + voyage.current.north;
    const ground = Math.hypot(groundEast, groundNorth);
    const courseDeg = ground > 0.25
      ? voyageWrap360((Math.atan2(groundEast, groundNorth) * 180) / Math.PI)
      : voyageWrap360(boat.heading ?? 0);
    const indexCoast = coastIndex ? coastIndex.nearestCoast(lat, lon, 600) : null;
    // Unknown (index still loading) or islands absent from the coarse ring index still consult the zoom-6 DEM probe.
    const indexKm = coastIndex ? (indexCoast ? indexCoast.distanceKm : 600) : 0;
    const scanning = true;
    // The DEM probe is the authority near land (it sees islands the coarse index misses).
    if (scanning) {
      probe.prefetch(lat, lon, 190).then(() => {
        if (approach.scan && !approach.scan.complete) scanTimer = 0;
      }).catch(() => {});
    }
    const scan = scanning
      ? scanForLand(probe, lat, lon, { eyeM, maxKm: 170, headingDeg: courseDeg, forwardHalfAngle: 55 })
      : { visible: null, nearest: null, highest: null, forwardVisible: null, forwardNearest: null, forwardHighest: null, complete: true };
    approach.scan = scan;
    if (!scanning) approach.coastKm = indexKm;
    else if (scan.nearest) approach.coastKm = scan.nearest.distanceKm;
    else if (scan.complete) approach.coastKm = Math.max(175, indexKm);
    else approach.coastKm = Math.min(indexKm, 175); // tiles still loading: stay conservative

    const indexForward = coastIndex?.forwardCoast
      ? coastIndex.forwardCoast(lat, lon, courseDeg, { maxKm: 200, halfAngle: 55 })
      : null;
    const fwdLand = scan.forwardVisible ?? scan.forwardHighest ?? scan.forwardNearest ?? (!scan.complete ? indexForward : null);
    const demFwdKm = scan.forwardNearest ? scan.forwardNearest.distanceKm : Infinity;
    const fwdCoastKm = !scan.complete && indexForward
      ? Math.min(demFwdKm, indexForward.distanceKm)
      : Number.isFinite(demFwdKm)
      ? demFwdKm
      : (indexForward ? indexForward.distanceKm : Infinity);
    approach.sightKm = scan.forwardHighest
      ? visibilityRangeKm(eyeM, scan.forwardHighest.elevation)
      : scan.highest
      ? visibilityRangeKm(eyeM, scan.highest.elevation)
      : visibilityRangeKm(eyeM, 30);

    const distFromDepartureKm = approach.departureCoords
      ? greatCircleKm(lat, lon, approach.departureCoords.lat, approach.departureCoords.lon)
      : voyage.distanceTrueNm * 1.852;
    if (approach.suppressLandHo && !approach.departureCoastHeld && (distFromDepartureKm >= 14 || voyage.distanceTrueNm >= 12 || (!approach.departureTerrain && voyage.distanceTrueNm >= 5))) {
      approach.suppressLandHo = false;
    }

    // Account for approach.offset when measuring distance to a streamed terrain pack.
    const tBase0 = terrain?.baseRegion ?? terrain?.region;
    let terrainDistM = tBase0
      ? Math.hypot(
          boat.x - ((tBase0.x ?? 0) + approach.offset.x),
          boat.z - ((tBase0.z ?? 0) + approach.offset.z)
        )
      : Infinity;
    // Free the departure coast once the ship is out in the open ocean so open-ocean waves and destination streaming are clean.
    const isDepartureTerrain = Boolean(terrain && terrain === approach.departureTerrain);
    const geoDistKm = terrain && Number.isFinite(terrain.region?.latitude)
      ? greatCircleKm(lat, lon, terrain.region.latitude, terrain.region.longitude)
      : terrainDistM / 1000;
    const forceCoast = approach.forceCoastLatLon;
    const fwdTargetForMismatch = forceCoast ?? fwdLand;
    // Does the 3D coast in memory actually hold the land the map shows ahead? The map's cell
    // is 2.4 km across, so a shallow anywhere near that point counts.
    const mapLandAhead = scan.forwardNearest ?? (!scan.complete ? indexForward : null);
    let landAheadIn3D = false;
    if (terrain && typeof terrain.height === 'function' && mapLandAhead) {
      const at = regionLocalOrigin({ shipLat: lat, shipLon: lon, shipX: boat.x, shipZ: boat.z, regionLat: mapLandAhead.lat, regionLon: mapLandAhead.lon });
      terrain.ensureSectionAt?.(at.x, at.z);
      // Built coast outranks the coarse map. Only built coast can ground her, and the map's cell
      // can sit kilometres from the shore, so a built section with no land at that point still counts.
      landAheadIn3D = (terrain.coverageAt?.(at.x, at.z) ?? 'known') === 'known'
        && (Boolean(terrain.coverageAt) || [[0, 0], [1500, 0], [-1500, 0], [0, 1500], [0, -1500]].some(([ox, oz]) => terrain.height(at.x + ox, at.z + oz) > -8));
    }
    const forwardCoastMismatch = Boolean(
      !isDepartureTerrain &&
      terrain &&
      Number.isFinite(terrain.region?.latitude) &&
      Number.isFinite(terrain.region?.longitude) &&
      terrainDistM > (terrain.region?.span ?? 8192) * 1.8 &&
      fwdTargetForMismatch &&
      (forceCoast || fwdCoastKm < 65) &&
      greatCircleKm(fwdTargetForMismatch.lat, fwdTargetForMismatch.lon, terrain.region.latitude, terrain.region.longitude) > 16
    );
    // Never drop a coast she is still beside, nor swap for one that would land her in the same
    // place: a large island's far shore can lie further from its centre than the test above allows.
    const mismatchWorthAct = forwardCoastMismatch && (
      !approach.spawnedAt || greatCircleKm(lat, lon, approach.spawnedAt.lat, approach.spawnedAt.lon) > 15
    ) && !coastLiesAlongside(terrain, 8000);
    const shouldDispose = isDepartureTerrain
      ? !approach.departureCoastHeld && (geoDistKm >= 11.5 || terrainDistM >= (terrain?.region?.span ?? 8192) * 1.42)
      : (terrainDistM > 150000 || mismatchWorthAct);
    if (terrain && terrain.region && cfg.disposeTerrain && shouldDispose) {
      cfg.disposeTerrain(terrain);
      approach.spawnedTerrain = null;
      if (isDepartureTerrain) approach.departureTerrain = null;
      approach.offset = { x: 0, z: 0 };
      terrain = null;
      terrainDistM = Infinity;
    }
    const inPack = Boolean(
      terrain &&
      terrain.region &&
      !isDepartureTerrain &&
      !approach.suppressLandHo &&
      terrainDistM < (terrain.region.span ?? 18000) * 0.8
    );

    const governingCoastKm = approach.suppressLandHo || approach.landHoCalled ? Infinity : fwdCoastKm;
    const visualRangeReached = !spawnTerrain || Boolean(
      terrain &&
      !isDepartureTerrain &&
      (terrainDistM <= 18000 || fwdCoastKm <= 16)
    );
    const governingVisible = !approach.suppressLandHo && !approach.landHoCalled && Boolean(scan.forwardVisible) && visualRangeReached;
    approach.stage = approachStage({
      coastKm: governingCoastKm,
      sightKm: Math.min(approach.sightKm, 18),
      visible: governingVisible,
      inPack,
    });

    // Direct local heightfield probe along the ship's course when terrain is resident.
    let localWarpCap = 3600, unbuiltWarpCap = 3600;
    if (terrain && typeof terrain.height === 'function' && terrainDistM < (terrain.region?.span ?? 8192) * COAST_REACH_SPANS) {
      const draft = boat.hydrodynamics?.draft ?? 2.0;
      const minBed = -Math.max(2.2, draft * 1.15);
      const startBed = terrain.height(boat.x, boat.z);
      const portsList = terrain.ports ?? (terrain.port ? [terrain.port] : null);
      const rad = (courseDeg * Math.PI) / 180, sinC = Math.sin(rad), cosC = Math.cos(rad);
      const reach = warpStandoffM(ground) + 3500;
      let hazardM = Infinity, unbuiltM = Infinity;
      // A corridor as wide as she needs, out past the distance warp must stop at.
      for (let d = 40; d <= reach && !Number.isFinite(hazardM); d += d < 1000 ? 40 : d < 3000 ? 80 : 160) {
        const px = boat.x + sinC * d, pz = boat.z - cosC * d;
        // Water not built yet reads as deep. Ask for it, and do not outrun it.
        if (terrain.coverageAt?.(px, pz) === 'pending') {
          terrain.ensureSectionAt?.(px, pz);
          unbuiltM = d;
          break;
        }
        for (const side of [0, 60, -60]) {
          let h = terrain.height(px + cosC * side, pz + sinC * side);
          let hitStructure = false;
          if (side === 0 && d <= 600 && terrain.region) {
            const probeContact = probeHullBottomContact(null, boat, px, pz, terrain.region, (qx, qz) => terrain.height(qx, qz), { ports: portsList });
            if (Number.isFinite(probeContact.worstBed)) h = Math.max(h, probeContact.worstBed);
            hitStructure = Boolean(probeContact.hitStructure);
          }
          if (hitStructure || (h > minBed && (startBed <= minBed || h > startBed + 0.1))) { hazardM = d; break; }
        }
      }
      localWarpCap = warpCapForHazard(hazardM, ground);
      unbuiltWarpCap = warpCapForHazard(unbuiltM + warpStandoffM(ground), ground);
    }

    let mapCoastStop = false;
    if (isDepartureTerrain && (terrainDistM < (terrain.region?.span ?? 8192) * 1.65 || approach.departureCoastHeld)) {
      // While departing inside a high-res 3D coastal pack (e.g. Tagus Gorge), trust the 3D heightfield probe
      // rather than the 2.4 km/px zoom-6 DEM which blurs river mouths.
      voyage.warpCap = localWarpCap;
    } else if (approach.suppressLandHo || approach.landHoCalled) {
      // Departing beyond the pack or player already acknowledged Land Ho: govern down when land lies ahead.
      const fwdTarget = scan.forwardNearest ?? (!scan.complete ? indexForward : null);
      const bowDiff = fwdTarget
        ? Math.abs((((fwdTarget.bearing - courseDeg + 540) % 360) - 180))
        : 180;
      if (bowDiff <= (approach.suppressLandHo ? 22 : 45) && fwdCoastKm < 35 && !landAheadIn3D) {
        voyage.warpCap = Math.max(1, Math.min(3600, ((fwdCoastKm - WARP_MAP_COAST_STOP_KM) * 1000) / (Math.max(0.8, ground) * 5)));
        mapCoastStop = fwdCoastKm <= WARP_MAP_COAST_STOP_KM;
      } else {
        voyage.warpCap = 3600;
      }
    } else if (!Number.isFinite(fwdCoastKm)) {
      voyage.warpCap = 3600;
    } else if (terrain && !isDepartureTerrain && terrainDistM > 18000) {
      const distToVisualM = Math.max(0, Math.min(terrainDistM, fwdCoastKm * 1000) - 14000);
      voyage.warpCap = Math.max(60, Math.min(1800, distToVisualM / (Math.max(1, ground) * 1.5)));
    } else {
      voyage.warpCap = approachWarpCap({
        coastKm: fwdCoastKm,
        sightKm: Math.min(approach.sightKm, 18),
        groundSpeed: ground,
        leadSeconds: 6,
        stage: approach.stage,
        demComplete: scan.complete,
      });
    }
    if (approach.spawning && fwdCoastKm < 60) {
      voyage.warpCap = Math.min(voyage.warpCap, fwdCoastKm < 35 ? 1 : 30);
    }
    voyage.warpCap = Math.min(voyage.warpCap, localWarpCap, unbuiltWarpCap);
    // Neither the coastline nor the soundings round her have arrived: she does not run blind.
    if (coastIndexPending && !scan.complete) voyage.warpCap = 1;
    // Warp reached its stopping distance: end it, rather than leave it ready to run on.
    if (localWarpCap <= 1 && warpTier(voyage.tier).rate > 1) {
      stopWarpForDanger('Shoal water ahead.');
    } else if (mapCoastStop && warpTier(voyage.tier).rate > 1) {
      stopWarpForDanger('Land close ahead.');
    }
    // The clock eases down over a second, which at full warp would be kilometres.
    if (voyage.rate > voyage.warpCap) voyage.rate = voyage.warpCap;

    // Stream the coastal terrain before the land tops the horizon (never while departure suppression is active).
    const wantSpawn = Boolean(
      !approach.suppressLandHo &&
      spawnTerrain &&
      !approach.spawning &&
      !terrain &&
      (forceCoast || approach.stage === 'preload' || approach.stage === 'sighting' || (fwdLand && fwdCoastKm < 95))
    );
    if (wantSpawn) {
      const landmark = forceCoast ?? fwdLand ?? scan.visible ?? scan.highest ?? scan.nearest ?? indexForward;
      if (landmark && (forceCoast || scan.complete || fwdCoastKm < 65)) {
        approach.spawning = true;
        approach.forceCoastLatLon = null;
        const shore = forceCoast
          ? { lat: forceCoast.lat, lon: forceCoast.lon, distanceKm: greatCircleKm(lat, lon, forceCoast.lat, forceCoast.lon) }
          : (scan.complete ? coastlineToward(probe, lat, lon, landmark) : landmark);
        const region = resolveLandfallRegion(shore.lat, shore.lon);
        const rLat = region.latitude ?? shore.lat, rLon = region.longitude ?? shore.lon;
        const placement = regionLocalOrigin({ shipLat: lat, shipLon: lon, shipX: boat.x, shipZ: boat.z, regionLat: rLat, regionLon: rLon });
        const spawnStart = { lat, lon, x: boat.x, z: boat.z, dateMs: voyage.dateMs };
        try {
          const t = await spawnTerrain({ region, placement: { x: placement.x, z: placement.z }, lat: rLat, lon: rLon, name: region.name });
          if (t && voyage) {
            approach.spawnedTerrain = t;
            approach.spawnedAt = { lat: voyage.true.lat, lon: voyage.true.lon };
            const actualLat = Number.isFinite(t.region?.latitude) ? t.region.latitude : rLat;
            const actualLon = Number.isFinite(t.region?.longitude) ? t.region.longitude : rLon;
            const now = regionLocalOrigin({ shipLat: voyage.true.lat, shipLon: voyage.true.lon, shipX: boat.x, shipZ: boat.z, regionLat: actualLat, regionLon: actualLon });
            const baseX = t.baseRegion?.x ?? t.region?.x ?? placement.x;
            const baseZ = t.baseRegion?.z ?? t.region?.z ?? placement.z;
            approach.offset = { x: now.x - baseX, z: now.z - baseZ };
            t.setWorldOffset?.(approach.offset.x, approach.offset.z);
            if (typeof t.commitWorldOffset === 'function') {
              t.commitWorldOffset({
                boat,
                camera: cfg.getCamera?.() ?? null,
                vessels: cfg.getVessels?.() ?? null,
                marineLife: cfg.getMarineLife?.() ?? null,
                dolphins: cfg.getDolphins?.() ?? null,
              });
              approach.offset = { x: 0, z: 0 };
              approach.committed = true;
            } else {
              approach.committed = false;
            }
            const postBase = t.baseRegion ?? t.region;
            const postDistM = postBase
              ? Math.hypot(boat.x - ((postBase.x ?? 0) + approach.offset.x), boat.z - ((postBase.z ?? 0) + approach.offset.z))
              : Infinity;
            if (postDistM < (t.region?.span ?? 8192) * 0.65 && typeof t.height === 'function' && typeof t.safeStart === 'function') {
              const draft = boat.hydrodynamics?.draft ?? 2.0;
              if (t.height(boat.x, boat.z) > -Math.max(3.0, draft + 1.0)) {
                try {
                  const prevX = boat.x, prevZ = boat.z;
                  const safe = t.safeStart({ x: boat.x, z: boat.z, heading: boat.heading ?? 0 }, boat);
                  boat.x = safe.x;
                  boat.z = safe.z;
                  const cam = cfg.getCamera?.();
                  if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.z)) {
                    cam.x += safe.x - prevX;
                    cam.z += safe.z - prevZ;
                  }
                } catch { /* retain position if safeStart fails */ }
              }
            }
            terrain = t;
            terrainDistM = postDistM;
            approach.lastBoat = { x: boat.x, z: boat.z };
            void spawnStart;
            emit('terrain', t);
          }
        } catch (err) {
          console.warn('Voyage terrain spawn failed', err);
        } finally {
          approach.spawning = false;
        }
      }
    }

    // Land ho! (only for land ahead of the ship after clearing departure and once 3D terrain is within visual range).
    const sighted = scan.forwardVisible ?? (!approach.suppressLandHo && voyage.distanceTrueNm > 25 ? scan.visible : null);
    const hasVisual3DLand = !spawnTerrain || Boolean(
      terrain &&
      terrain !== approach.departureTerrain &&
      (terrainDistM <= 18000 || fwdCoastKm <= 16 || sighted?.distanceKm <= 18) &&
      // The call means something to look at: land the glass can actually find.
      (!sighted || approach.landHoCalled || typeof terrain.height !== 'function' || requestCoastToward(terrain, sighted.bearing) || visibleLandPoint(
        (x, z) => terrain.height(x, z), boat.x, boat.z, sighted.bearing, { eyeM, stepDeg: 5 }
      ))
    );
    // A new coast in memory, well away from the last sighting, is a new landfall with its own call.
    if (approach.landHoCalled && sighted && terrain && approach.landHoTerrain && terrain !== approach.landHoTerrain && approach.landSighted
      && greatCircleKm(sighted.lat, sighted.lon, approach.landSighted.lat, approach.landSighted.lon) > 40) {
      approach.landHoCalled = false;
    }
    if (sighted && !approach.landHoCalled && !approach.suppressLandHo) {
      if (hasVisual3DLand) {
        approach.landHoCalled = true;
        approach.landSighted = { lat: sighted.lat, lon: sighted.lon };
        approach.landHoTerrain = terrain;
        const rel = sighted.bearing - boat.heading;
        const call = relativeBearingCall(rel);
        addMark(voyage, { kind: 'land', lat: sighted.lat, lon: sighted.lon, label: 'Land sighted' });
        const leaguesOff = Math.max(1, Math.round(Math.min(sighted.distanceKm, Number.isFinite(fwdCoastKm) ? fwdCoastKm : sighted.distanceKm) / 1.852 / NM_PER_LEAGUE));
        const night = nightSight();
        const bearingWords = `${compassPointName(sighted.bearing - voyage.variation)} by the compass`;
        const warning = 'Masters lay to rather than close a strange coast by night.';
        raiseInterrupt(voyage, {
          type: 'land-ho',
          title: !night ? '¡Tierra! Land ho!' : night.moonlit ? '¡Tierra! Land by moonlight' : 'Land near, in the dark',
          text: !night
            ? `The lookout sings out: "Land! Land ${call}!" High ground bearing ${bearingWords}, perhaps ${leaguesOff} leagues off.`
            : night.moonlit
              ? `The lookout sings out: "Land! Land ${call}!" A dark line against the moonlit sky, bearing ${bearingWords}, perhaps ${leaguesOff} leagues off. ${warning}`
              : `The lookout can make out nothing ahead, but land birds crossed at dusk and the wind smells of earth. The pilot reckons land ${call}, perhaps ${leaguesOff} leagues off. ${warning}`,
          bearing: sighted.bearing,
          choices: landHoChoices(Boolean(night)),
          log: `Land sighted ${call}, bearing ${bearingWords}.`,
        }, 'deck');
        showCallout(voyage.interrupt);
        emit('land-ho', sighted);
      } else {
        const distToVisualM = Math.max(0, Math.min(terrainDistM, fwdCoastKm * 1000) - 14000);
        // Mountains show from far beyond where the coast is built, so run on until it is in range.
        const toSpawnM = (fwdCoastKm - 95) * 1000;
        const closeCap = terrain
          ? Math.max(60, Math.min(1800, distToVisualM / (Math.max(1, ground) * 1.5)))
          : Math.max(30, Math.min(3600, toSpawnM / (Math.max(1, ground) * 6)));
        voyage.warpCap = Math.min(voyage.warpCap, closeCap);
      }
    } else if (!sighted && fwdCoastKm > approach.sightKm + 30) {
      approach.landHoCalled = false;
    approach.landSighted = null;
      approach.landSighted = null;
    }

    // A new passage begins once the land she made is well astern: the next landfall is judged on its own days and
    // leagues, and the pilot's true position is his secret again.
    if (voyage.arrived && approach.coastKm > 40) {
      voyage.arrived = false;
      voyage.legStartDay = voyage.dayAtSea;
      voyage.legStartLoggedNm = voyage.distanceLoggedNm;
    }
    // Arrival: inside a newly streamed coastal pack, at real time, after a real passage (and not overwriting a fresh Land Ho callout).
    const newCoast = terrain && terrain !== approach.departureTerrain;
    if (
      approach.stage === 'inshore' &&
      !voyage.arrived &&
      voyage.rate <= 1.05 &&
      voyage.interrupt?.type !== 'land-ho' &&
      (newCoast || voyage.distanceTrueNm > 60)
    ) {
      voyage.arrived = true;
      const { errorLeagues } = revealTruePosition(voyage, 'landfall');
      const legDays = Math.max(0, voyage.dayAtSea - (voyage.legStartDay ?? 0));
      const legLeagues = Math.max(0, voyage.distanceLoggedNm - (voyage.legStartLoggedNm ?? 0)) / NM_PER_LEAGUE;
      const verdict = reckoningVerdict(errorLeagues, legDays);
      addLog(voyage, `Made our landfall after ${legDays} days. By the land our reckoning was ${errorLeagues.toFixed(0)} leagues out. ${verdict.text}`, 'arrival');
      raiseInterrupt(voyage, {
        type: 'arrival',
        title: `Landfall · ${verdict.rank}`,
        text: `${legDays} days at sea, ${legLeagues.toFixed(0)} leagues logged. Your reckoning was ${errorLeagues.toFixed(0)} leagues from the truth. ${verdict.text}`,
        choices: [{ id: 'ok', label: 'Enter it in the log' }, { id: 'chart', label: 'Open the chart' }],
      }, 'deck');
      showCallout(voyage.interrupt);
      emit('arrival', { errorLeagues, verdict });
    }
  }

  function updateHud() {
    if (!hud || !voyage) return;
    const r = hud.root;
    const solar = localSolarHours(voyage.dateMs, voyage.true.lon);
    const watch = shipWatch(solar);
    r.querySelector('.voyage-date').textContent = `${formatJulianDate(voyage.dateMs)} · day ${voyage.dayAtSea}`;
    r.querySelector('.voyage-watch').textContent = `${watch.name}, glass ${watch.glass}`;
    for (const [id, b] of hud.warpButtons) {
      const pressed = voyage.tier === id;
      if (b.getAttribute('aria-pressed') !== String(pressed)) b.setAttribute('aria-pressed', String(pressed));
    }
    const cap = Math.round(voyage.rate);
    const capped = voyage.warpCap < warpTier(voyage.tier).rate - 1;
    r.querySelector('.voyage-warp').dataset.rate = `${cap}×${capped ? ' · land near' : ''}`;
    r.querySelector('.voyage-course').textContent = `${compassPointName(helmsman.compassCourse)} (${Math.round(helmsman.compassCourse)}°) by compass · heading ${compassPointName(boat.heading - voyage.variation)}`;
    const posEl = r.querySelector('.voyage-pos');
    if (posEl) posEl.textContent = `${formatLatitude(voyage.dr.lat)} · ${formatLongitude(voyage.dr.lon)}`;
    r.querySelector('.voyage-helmsman').textContent = manualHelm ? 'Helm: by hand' : `Helmsman: ${helmsman.status}`;
    const w = voyage.weather;
    r.querySelector('.voyage-wind').textContent = w ? `Wind ${compassPointName(w.windFrom)}, ${w.description}` : '';
    const purse = cfg.purseLabel?.();
    r.querySelector('.voyage-stores').textContent = `Water ${Math.ceil(voyage.provisions.water)} d · Food ${Math.ceil(voyage.provisions.food)} d${purse ? ` · ${purse}` : ''}`;
    if (hud.beat.checked !== helmsman.beat) hud.beat.checked = helmsman.beat;
    // Shut, the panel still says that time is running fast or that a call waits.
    const alert = String(Boolean(voyage.interrupt) || voyage.rate > 1);
    if (hud.toggle && hud.toggle.dataset.alert !== alert) hud.toggle.dataset.alert = alert;
    if (hud.root.dataset.alert !== alert) hud.root.dataset.alert = alert;
  }

  function onKey(e) {
    if (!voyage || e.metaKey || e.ctrlKey || e.altKey || keyIsForField(e)) return false;
    if (e.code === 'BracketLeft') { alterCourse(e.shiftKey ? -1 : -11.25); return true; }
    if (e.code === 'BracketRight') { alterCourse(e.shiftKey ? 1 : 11.25); return true; }
    if (e.code === 'KeyK' && !e.repeat) { keepHerSo(); return true; }
    if (e.code === 'KeyT' && !e.repeat) { tack(); return true; }
    if (e.code === 'Comma' || e.code === 'Period') {
      // One tier a press: a held key would run straight up to a crossing.
      if (e.repeat) return true;
      const i = WARP_TIERS.findIndex((t) => t.id === voyage.tier);
      const next = WARP_TIERS[Math.max(0, Math.min(WARP_TIERS.length - 1, i + (e.code === 'Period' ? 1 : -1)))];
      setWarp(next.id);
      return true;
    }
    if (e.code === 'Escape' && hudExpanded && matchMedia(HUD_COMPACT_QUERY).matches) { setHudExpanded(false); return true; }
    if (e.code === 'Enter' && voyage.interrupt) {
      // A held key answers nothing, and a button that has the focus answers for itself: Enter on
      // "Hold course" must not clear for action because that choice happens to stand first.
      if (e.repeat) return true;
      if (e.target?.tagName === 'BUTTON') return false;
      resolveInterrupt((voyage.interrupt.choices ?? [{ id: 'ok' }])[0].id);
      return true;
    }
    return false;
  }

  function emit(type, payload) {
    for (const fn of listeners) fn(type, payload);
  }

  return {
    get active() { return Boolean(voyage); },
    get voyage() { return voyage; },
    get helmsman() { return helmsman; },
    get approach() { return approach; },
    get pursuit() { return pursuit; },
    get rate() { return voyage?.rate ?? 1; },
    hud: hud?.root ?? null,
    start,
    resume,
    end,
    syncToTerrainBoat,
    hasSavedVoyage,
    steer,
    update,
    manualSteering,
    setWarp,
    orderCompassCourse,
    layCourse,
    alterCourse,
    keepHerSo,
    tack,
    orderCanvas,
    resolveInterrupt,
    presentPrizeDisposition,
    presentShipwreck,
    isBattleActive: () => Boolean(cfg.isBattleActive?.()),
    // Time spent ashore runs on the voyage's clock.
    passDays(days) {
      if (!voyage || !(days > 0)) return;
      voyage.dateMs += Math.round(days * 86400000);
      emit('change');
    },
    // A pilot takes her out past the bar and drops off in open water.
    pilotOut({ drop = null } = {}) {
      const terrain = getTerrain();
      if (!voyage || !terrain) return null;
      const { lat, lon } = voyage.true, shore = terrain.region?.shoreBearing;
      const seaward = Number.isFinite(shore) ? (shore + 180) % 360 : 0;
      const out = pilotDropPoint(lat, lon, shore, coastIndex, { drop }) ?? { ...destinationPoint(lat, lon, seaward, 30), bearing: seaward, distanceKm: 30 };
      const { bearing, distanceKm: clearKm } = out;
      voyage.true = { ...voyage.true, lat: out.lat, lon: out.lon };
      voyage.dr = { ...voyage.dr, lat: out.lat, lon: out.lon };
      voyage.dateMs += Math.round((clearKm / 8) * 3600000);
      cfg.disposeTerrain?.(terrain);
      approach.spawnedTerrain = null;
      approach.departureTerrain = null;
      approach.offset = { x: 0, z: 0 };
      approach.suppressLandHo = true;
      approach.landHoCalled = false;
      approach.landSighted = null;
      boat.heading = bearing;
      boat.aground = false;
      boat.coastBlocked = false;
      boat.shoalScraping = false;
      helmsman.compassCourse = (bearing - (voyage.variation ?? 0) + 360) % 360;
      helmsman.engaged = true;
      manualHelm = false;
      if (voyage.passive) promoteActive();
      addLog(voyage, `Dropped the pilot in open water, ${Math.round(clearKm / 5.556)} leagues off the port.`, 'order');
      emit('change');
      return { bearing, lat: out.lat, lon: out.lon };
    },
    // What the glass should hold on: the land standing highest above the horizon near the
    // sighting. Null until land has been called or when it is not in memory yet.
    landSightPoint({ eyeM = 20 } = {}) {
      const sighted = approach.landSighted, terrain = getTerrain();
      if (!voyage || !sighted || typeof terrain?.height !== 'function') return null;
      const center = initialBearing(voyage.true.lat, voyage.true.lon, sighted.lat, sighted.lon);
      return visibleLandPoint((x, z) => terrain.height(x, z), boat.x, boat.z, center, { eyeM });
    },
    // Something the master should hear about, and the log should remember.
    note(text, seconds = 7, kind = 'order') {
      if (voyage) addLog(voyage, text, kind);
      showToast(text, seconds);
      emit('change');
    },
    saveNow() {
      if (!voyage || !storage || (voyage.passive && !voyage.keepSaved)) return;
      lastPersist = performance.now();
      try { storage.setItem(VOYAGE_STORAGE_KEY, serializeVoyage(voyage)); } catch { /* quota */ }
    },
    logExternal,
    triggerSailEncounter,
    showToast,
    onKey,
    snapshot() {
      if (!voyage) return null;
      const s = voyageSnapshot(voyage);
      s.trueCourseSteered = helmsman.steeredTrue;
      s.positionLabel = `${formatLatitude(voyage.dr.lat)} · ${formatLongitude(voyage.dr.lon)} (by reckoning)`;
      s.approach = { stage: approach.stage, coastKm: approach.coastKm };
      return s;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _debug: { probe, get coastIndex() { return coastIndex; }, greatCircleKm },
  };
}
