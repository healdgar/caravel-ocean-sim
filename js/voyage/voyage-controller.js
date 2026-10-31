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
  NM_PER_LEAGUE,
} from './passage.js';
import { createHelmsman, steerHelmsman, orderCourse, orderTack, applyCanvasOrder, canvasAdvice, CANVAS_ORDERS } from './helmsman.js';
import {
  createCoastlineIndex,
  createDemProbe,
  scanForLand,
  coastlineToward,
  approachStage,
  approachWarpCap,
  regionLocalOrigin,
  visibilityRangeKm,
  lookoutEyeHeight,
} from './landfall-approach.js';
import { compassPointName, relativeBearingCall, formatLatitude, formatLongitude } from './compass.js';
import { formatJulianDate, localSolarHours, greatCircleKm, windDescription } from './ocean-climate.js';
import { createEncounterDirector } from './encounters.js';

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
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = cfg;

  let voyage = null;
  const helmsman = createHelmsman({ engaged: false });
  const weatherDriver = createWeatherDriver();
  let encounterDirector = createEncounterDirector();
  const probe = createDemProbe(demLoader ? { loadTile: demLoader } : {});
  let coastIndex = null;
  let listeners = new Set();
  let lastPersist = 0;
  let scanTimer = 0;
  let toastTimer = 0;
  let lastAdvice = null;
  let manualHelm = false;

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

  if (loadLandRings) {
    Promise.resolve()
      .then(loadLandRings)
      .then((rings) => { if (Array.isArray(rings)) coastIndex = createCoastlineIndex(rings); })
      .catch(() => {});
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
        <div class="voyage-warp" role="group" aria-label="Time warp"></div>
      </div>
      <div class="voyage-row voyage-helm">
        <button type="button" class="voyage-course-left" aria-label="Alter course one point to larboard" title="One point to larboard ( [ )">◀</button>
        <span class="voyage-course" aria-live="polite"></span>
        <button type="button" class="voyage-course-right" aria-label="Alter course one point to starboard" title="One point to starboard ( ] )">▶</button>
        <button type="button" class="voyage-keep" title="Helmsman: keep her as she goes (K)">Keep her so</button>
        <button type="button" class="voyage-tack" title="Go about (T)">Tack</button>
        <label class="voyage-beat"><input type="checkbox"> Beat</label>
        <label class="voyage-canvas-label">Canvas <select class="voyage-canvas" aria-label="Canvas order"></select></label>
      </div>
      <div class="voyage-row voyage-status"><span class="voyage-pos"></span><span class="voyage-helmsman"></span><span class="voyage-wind"></span><span class="voyage-stores"></span></div>
      <div class="voyage-callout" role="alert" hidden></div>
      <div class="voyage-toast" role="status" aria-live="polite" hidden></div>`;
    parent.append(root);
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
    return { root, warpButtons, canvasSel, beat };
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
    if (!interrupt) { box.hidden = true; box.innerHTML = ''; return; }
    hud.root.hidden = false;
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

  function resolveInterrupt(choiceId) {
    const it = voyage?.interrupt;
    if (!it) return;
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
          setWarp('deck');
          cfg.onHailVessel?.(enc);
        },
        onEngageVessel: (enc) => {
          setWarp('deck');
          manualHelm = true;
          helmsman.engaged = false;
          cfg.onEngageVessel?.(enc);
        },
      });
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
      orderCourse(helmsman, voyage.compassCourse, { beat: helmsman.beat });
      beginScene({ showHud: true });
    }
  }
  function setWarp(id) {
    promoteActive();
    if (voyage.interrupt) {
      clearInterrupt(voyage);
      showCallout(null);
      if (encounterDirector?.state) encounterDirector.state.active = null;
    }
    if (hud) hud.root.hidden = false;
    setWarpTier(voyage, id);
    const tierRate = warpTier(id).rate;
    if (tierRate > 1 && (approach.suppressLandHo || approach.landHoCalled)) {
      voyage.warpCap = 3600;
    }
    voyage.rate = Math.min(tierRate, voyage.warpCap ?? 3600);
    updateHud();
    emit('change');
  }
  function orderCompassCourse(compassDeg, { beat } = {}) {
    promoteActive();
    if (hud) hud.root.hidden = false;
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
    applyCanvasOrder(boat, voyage.canvas);
    approach.landHoCalled = false;
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
    if (hud) hud.root.hidden = true;
    showCallout(null);
    emit('change');
  }

  function attachExistingTerrain() {
    const t = getTerrain();
    approach.spawnedTerrain = t ?? null;
    approach.departureTerrain = t ?? null;
    approach.suppressLandHo = true;
    approach.landHoCalled = false;
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
      voyage.compassCourse = voyageWrap360(boat.heading - voyage.variation);
      orderCourse(helmsman, voyage.compassCourse, { beat: helmsman.beat });
    }
    attachExistingTerrain();
    syncAstronomy();
    updateHud();
  }

  function beginScene({ showHud = true, passive = false } = {}) {
    if (hud) hud.root.hidden = !showHud;
    if (hud) hud.canvasSel.value = voyage.canvas;
    weatherDriver.reset();
    if (astronomy && !passive) {
      astronomy.mode = 'astronomy';
      astronomy.rate = 0;
    }
    syncAstronomy();
    voyage.weather = null;
  }

  function persist(now) {
    if (!voyage || voyage.passive || !storage || now - lastPersist < 5000) return;
    lastPersist = now;
    try { storage.setItem(VOYAGE_STORAGE_KEY, serializeVoyage(voyage)); } catch { /* quota */ }
  }

  function syncAstronomy() {
    if (!astronomy || !voyage) return;
    // Always keep the geographic observer anchor synced to the ship's live lat/lon.
    astronomy.anchor = { latitude: voyage.true.lat, longitude: voyage.true.lon, x: boat.x, z: boat.z };
    if (!voyage.passive) {
      // Sun, moon and stars follow the warped voyage clock and the ship's true position.
      astronomy.mode = 'astronomy';
      astronomy.rate = 0;
      astronomy.epochMs = voyage.dateMs;
      astronomy.elapsedSeconds = 0;
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
    const terrain = getTerrain();
    const span = terrain?.region?.span ?? 8192;
    const tDist = terrain && terrain.region
      ? Math.hypot(
          boat.x - ((terrain.region.x ?? 0) + approach.offset.x),
          boat.z - ((terrain.region.z ?? 0) + approach.offset.z)
        )
      : Infinity;
    const isDepartureTerrain = Boolean(terrain && terrain === approach.departureTerrain);
    // When warping out of the departure port, once the ship clears the 3D harbor/gorge pack (~7.8 km),
    // free the departure terrain so open-ocean waves run at normal 1x real time while time and distance warp.
    if (isDepartureTerrain && voyage.rate > 1.05 && tDist >= span * 0.95 && cfg.disposeTerrain) {
      cfg.disposeTerrain(terrain);
      approach.spawnedTerrain = null;
      approach.departureTerrain = null;
      approach.offset = { x: 0, z: 0 };
    }
    const activeTerrain = getTerrain();
    const inCoastalPack = Boolean(
      activeTerrain &&
      approach.spawnedTerrain === activeTerrain &&
      typeof activeTerrain.setWorldOffset === 'function' &&
      (isDepartureTerrain ? tDist < span * 0.95 : tDist < span * 4.5)
    );
    const ignoreCurrent = Boolean(activeTerrain) && (voyage.rate <= 1.05 || inCoastalPack);
    const prevTrue = { lat: voyage.true.lat, lon: voyage.true.lon };
    const prevDr = { lat: voyage.dr.lat, lon: voyage.dr.lon };
    const prevDistTrue = voyage.distanceTrueNm;
    const prevDistLogged = voyage.distanceLoggedNm;
    const isConfirmedLand = (lat, lon) => {
      const elev = probe.elevation?.(lat, lon);
      if (elev !== undefined && elev > -900) return elev > 0.5;
      return Boolean(coastIndex?.isLand?.(lat, lon));
    };
    const wasOnCoarseLand = isConfirmedLand(prevTrue.lat, prevTrue.lon);
    const events = stepVoyage(voyage, dt, { boat, ignoreCurrent });
    handleEvents(events);

    const dxLocal = boat.x - approach.lastBoat.x, dzLocal = boat.z - approach.lastBoat.z;
    const { eastM, northM } = voyage.lastStep;
    const extraX = eastM - dxLocal, extraZ = -northM - dzLocal;
    const extraDist = Math.hypot(extraX, extraZ);

    // Prevent high warp in the open ocean from crossing onto continental land before coastal terrain has spawned.
    if (!inCoastalPack && voyage.rate > 1.05 && extraDist > 1 && !wasOnCoarseLand && isConfirmedLand(voyage.true.lat, voyage.true.lon)) {
      let lo = 0, hi = 1;
      for (let iter = 0; iter < 8; iter++) {
        const mid = (lo + hi) * 0.5;
        const mLat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * mid;
        const mLon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * mid;
        if (isConfirmedLand(mLat, mLon)) hi = mid;
        else lo = mid;
      }
      const safeFrac = Math.max(0, lo - Math.min(lo, 1500 / Math.max(1500, extraDist)));
      voyage.true.lat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * safeFrac;
      voyage.true.lon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * safeFrac;
      voyage.dr.lat = prevDr.lat + (voyage.dr.lat - prevDr.lat) * safeFrac;
      voyage.dr.lon = prevDr.lon + (voyage.dr.lon - prevDr.lon) * safeFrac;
      voyage.distanceTrueNm = prevDistTrue + (voyage.distanceTrueNm - prevDistTrue) * safeFrac;
      voyage.distanceLoggedNm = prevDistLogged + (voyage.distanceLoggedNm - prevDistLogged) * safeFrac;
      voyage.tier = 'deck';
      voyage.rate = 1;
      voyage.targetRate = 1;
      voyage.warpCap = 1;
      scanTimer = 0;
      showToast('Land ahead — dropping to real time off the coast.', 6);
    }

    // While inside a coastal pack, slide/commit the 3D terrain onto the hull so land, trees, and harbour works
    // stay locked to lat/lon and cannot be warped through. Outside the coastal pack (open ocean), waves act normal at 1x.
    if (inCoastalPack) {
      let safeFrac = 1;
      let stepExtraX = extraX, stepExtraZ = extraZ;
      if (extraDist > 1e-4 && typeof terrain.height === 'function') {
        const draft = boat.hydrodynamics?.draft ?? 2.0;
        const minSafeBed = -Math.max(3.2, draft * 1.35);
        const startBed = terrain.height(boat.x, boat.z);
        const bowLead = Math.max(18, (boat.length ?? 22) * 0.65);
        const steps = Math.max(1, Math.min(2000, Math.ceil(extraDist / 8)));
        const traceRay = (rx, rz) => {
          const rDist = Math.hypot(rx, rz) || 1;
          const dX = rx / rDist, dZ = rz / rDist;
          for (let k = 1; k <= steps; k++) {
            const frac = k / steps;
            const wx = boat.x + rx * frac, wz = boat.z + rz * frac;
            terrain.ensureSectionAt?.(wx, wz);
            const hKeel = terrain.height(wx, wz);
            const hBow = terrain.height(wx + dX * bowLead, wz + dZ * bowLead);
            const h = Math.max(hKeel, hBow);
            if (h > minSafeBed && (startBed <= minSafeBed || h > startBed + 0.05)) {
              return (k - 1) / steps;
            }
          }
          return 1;
        };
        safeFrac = traceRay(stepExtraX, stepExtraZ);
        // If a channel bank is grazed during warp, let the pilot steer up to ±24° into the deep fairway if available.
        if (safeFrac < 1 && voyage.rate > 1.05) {
          for (const deg of [5, -5, 10, -10, 15, -15, 20, -20, 24, -24]) {
            const rad = (deg * Math.PI) / 180;
            const c = Math.cos(rad), s = Math.sin(rad);
            const rx = extraX * c - extraZ * s;
            const rz = extraX * s + extraZ * c;
            if (traceRay(rx, rz) >= 1) {
              stepExtraX = rx;
              stepExtraZ = rz;
              safeFrac = 1;
              break;
            }
          }
        }
        if (safeFrac < 1) {
          voyage.true.lat = prevTrue.lat + (voyage.true.lat - prevTrue.lat) * safeFrac;
          voyage.true.lon = prevTrue.lon + (voyage.true.lon - prevTrue.lon) * safeFrac;
          voyage.dr.lat = prevDr.lat + (voyage.dr.lat - prevDr.lat) * safeFrac;
          voyage.dr.lon = prevDr.lon + (voyage.dr.lon - prevDr.lon) * safeFrac;
          voyage.distanceTrueNm = prevDistTrue + (voyage.distanceTrueNm - prevDistTrue) * safeFrac;
          voyage.distanceLoggedNm = prevDistLogged + (voyage.distanceLoggedNm - prevDistLogged) * safeFrac;
          if (voyage.rate > 1.05) {
            voyage.tier = 'deck';
            voyage.rate = 1;
            voyage.targetRate = 1;
            voyage.warpCap = 1;
            showToast('Shoal water ahead — dropping to real time before running aground.', 6);
          }
        }
      }
      const sx = -stepExtraX * safeFrac, sz = -stepExtraZ * safeFrac;
      if (Math.abs(sx) > 1e-4 || Math.abs(sz) > 1e-4) {
        approach.offset.x += sx;
        approach.offset.z += sz;
        terrain.setWorldOffset(approach.offset.x, approach.offset.z);
        approach.committed = false;
      }
      if (!approach.committed && typeof terrain.commitWorldOffset === 'function' && Math.hypot(approach.offset.x, approach.offset.z) >= 0.05) {
        const preCommitX = boat.x, preCommitZ = boat.z;
        terrain.commitWorldOffset({
          boat,
          camera: cfg.getCamera?.() ?? null,
          vessels: cfg.getVessels?.() ?? null,
        });
        approach.offset = { x: 0, z: 0 };
        approach.committed = true;
        if (tDist < span * 2.5 && typeof terrain.constrain === 'function') {
          const cdx = boat.x - preCommitX, cdz = boat.z - preCommitZ;
          const cDist = Math.hypot(cdx, cdz);
          const clampDist = Math.min(cDist, Math.max(0.5, Math.hypot(boat.surgeVelocity ?? 0, boat.leewayVelocity ?? 0) * dt));
          const cx = cDist > 1e-4 ? boat.x - (cdx / cDist) * clampDist : preCommitX;
          const cz = cDist > 1e-4 ? boat.z - (cdz / cDist) * clampDist : preCommitZ;
          terrain.constrain(boat, cx, cz);
        }
      }
      // Keep lat/lon strictly locked to the 3D coastal terrain while inside the pack.
      if (regionLatLon && terrain.region) {
        const g = regionLatLon(terrain, boat.x - approach.offset.x, boat.z - approach.offset.z);
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
    approach.lastBoat = { x: boat.x, z: boat.z };

    // Open-ocean encounters (whales & strange sails with lookout callouts).
    encounterDirector.step(voyage, boat, dt, {
      coastKm: approach.coastKm,
      marineLife: cfg.getMarineLife?.() ?? null,
      terrain,
      vessels: cfg.getVessels?.() ?? [],
      onSightVessel: (enc) => cfg.onSightVessel?.(enc),
      onToast: showToast,
      onInterrupt: showCallout,
    });

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
    const fastNearCoast = voyage.rate > 60 && (approach.coastKm < 180 || Boolean(terrain));
    if ((scanTimer <= 0 || fastNearCoast) && !voyage.passive) {
      scanTimer = fastNearCoast ? 0.08 : 0.5;
      runApproach(terrain);
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
    // Unknown (index still loading) counts as "near" so the DEM probe is consulted.
    const indexKm = coastIndex ? (indexCoast ? indexCoast.distanceKm : 600) : 0;
    const scanning = indexKm < 320;
    // The DEM probe is the authority near land (it sees islands the coarse index misses).
    if (scanning) probe.prefetch(lat, lon, 190);
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

    if (approach.suppressLandHo && scan.complete && voyage.distanceTrueNm > 28 && (!scan.forwardVisible || fwdCoastKm > 35 || voyage.distanceTrueNm > 55)) {
      approach.suppressLandHo = false;
    }

    // Account for approach.offset when measuring distance to a streamed terrain pack.
    const terrainDistM = terrain && terrain.region
      ? Math.hypot(
          boat.x - ((terrain.region.x ?? 0) + approach.offset.x),
          boat.z - ((terrain.region.z ?? 0) + approach.offset.z)
        )
      : Infinity;
    // Free the departure coast once the ship is out in the open ocean so open-ocean waves and destination streaming are clean.
    const isDepartureTerrain = Boolean(terrain && terrain === approach.departureTerrain);
    const geoDistKm = terrain && Number.isFinite(terrain.region?.latitude)
      ? greatCircleKm(lat, lon, terrain.region.latitude, terrain.region.longitude)
      : terrainDistM / 1000;
    const shouldDispose = isDepartureTerrain ? (geoDistKm >= 11.5 || terrainDistM >= (terrain?.region?.span ?? 8192) * 1.42) : terrainDistM > 150000;
    if (terrain && terrain.region && cfg.disposeTerrain && shouldDispose) {
      cfg.disposeTerrain(terrain);
      approach.spawnedTerrain = null;
      if (isDepartureTerrain) approach.departureTerrain = null;
      approach.offset = { x: 0, z: 0 };
      terrain = null;
    }
    const inPack = Boolean(
      terrain &&
      terrain.region &&
      !isDepartureTerrain &&
      !approach.suppressLandHo &&
      terrainDistM < (terrain.region.span ?? 18000) * 0.8
    );

    const governingCoastKm = approach.suppressLandHo || approach.landHoCalled ? Infinity : fwdCoastKm;
    const governingVisible = !approach.suppressLandHo && !approach.landHoCalled && Boolean(scan.forwardVisible);
    approach.stage = approachStage({
      coastKm: governingCoastKm,
      sightKm: approach.sightKm,
      visible: governingVisible,
      inPack,
    });

    // Direct local heightfield probe along the ship's course when terrain is resident.
    let localWarpCap = 3600;
    if (terrain && typeof terrain.height === 'function' && terrainDistM < (terrain.region?.span ?? 8192) * 2.5) {
      const draft = boat.hydrodynamics?.draft ?? 2.0;
      const minBed = -Math.max(2.2, draft * 1.15);
      const startBed = terrain.height(boat.x, boat.z);
      for (const d of [35, 80, 160, 300, 600, 1200, 2200, 3500]) {
        let allBlocked = true;
        for (const off of [0, 10, -10, 20, -20]) {
          const rad = ((courseDeg + off) * Math.PI) / 180;
          const h = terrain.height(boat.x + Math.sin(rad) * d, boat.z - Math.cos(rad) * d);
          if (!(h > minBed && (startBed <= minBed || h > startBed + 0.1))) {
            allBlocked = false;
            break;
          }
        }
        if (allBlocked) {
          localWarpCap = d <= 200 ? 1 : Math.max(1, Math.min(240, (d - 160) / (Math.max(1, ground) * 5)));
          break;
        }
      }
    }

    if (isDepartureTerrain && terrainDistM < (terrain.region?.span ?? 8192) * 1.65) {
      // While departing inside a high-res 3D coastal pack (e.g. Tagus Gorge), trust the 3D heightfield probe
      // rather than the 2.4 km/px zoom-6 DEM which blurs river mouths.
      voyage.warpCap = localWarpCap;
    } else if (approach.suppressLandHo || approach.landHoCalled) {
      // Departing beyond the pack or player already acknowledged Land Ho: govern down when land lies ahead.
      const fwdTarget = scan.forwardNearest ?? (!scan.complete ? indexForward : null);
      const bowDiff = fwdTarget
        ? Math.abs((((fwdTarget.bearing - courseDeg + 540) % 360) - 180))
        : 180;
      if (bowDiff <= (approach.suppressLandHo ? 22 : 45) && fwdCoastKm < 35) {
        voyage.warpCap = Math.max(1, Math.min(3600, ((fwdCoastKm - 1.8) * 1000) / (Math.max(0.8, ground) * 5)));
      } else {
        voyage.warpCap = 3600;
      }
    } else if (!Number.isFinite(fwdCoastKm)) {
      voyage.warpCap = 3600;
    } else {
      voyage.warpCap = approachWarpCap({
        coastKm: fwdCoastKm,
        sightKm: Math.min(approach.sightKm, 35),
        groundSpeed: ground,
        leadSeconds: 8,
        stage: approach.stage,
        demComplete: scan.complete,
      });
    }
    if (approach.spawning && fwdCoastKm < 60) {
      voyage.warpCap = Math.min(voyage.warpCap, fwdCoastKm < 35 ? 1 : 30);
    }
    voyage.warpCap = Math.min(voyage.warpCap, localWarpCap);

    // Land ho! (only for land ahead of the ship after clearing departure).
    const sighted = scan.forwardVisible ?? (!approach.suppressLandHo && voyage.distanceTrueNm > 25 ? scan.visible : null);
    if (sighted && !approach.landHoCalled && !approach.suppressLandHo) {
      approach.landHoCalled = true;
      const rel = sighted.bearing - boat.heading;
      const call = relativeBearingCall(rel);
      addMark(voyage, { kind: 'land', lat: sighted.lat, lon: sighted.lon, label: 'Land sighted' });
      raiseInterrupt(voyage, {
        type: 'land-ho',
        title: '¡Tierra! Land ho!',
        text: `The lookout sings out: "Land! Land ${call}!" High ground bearing ${compassPointName(sighted.bearing - voyage.variation)} by the compass, perhaps ${(sighted.distanceKm / 1.852 / NM_PER_LEAGUE).toFixed(0)} leagues off.`,
        bearing: sighted.bearing,
        choices: [{ id: 'stand-in', label: 'Stand in toward the land' }, { id: 'hold', label: 'Hold our course' }, { id: 'chart', label: 'Open the chart' }],
        log: `Land sighted ${call}, bearing ${compassPointName(sighted.bearing - voyage.variation)} by the compass.`,
      }, 'deck');
      showCallout(voyage.interrupt);
      emit('land-ho', sighted);
    } else if (!sighted && fwdCoastKm > approach.sightKm + 30) {
      approach.landHoCalled = false;
    }

    // Stream the coastal terrain before the land tops the horizon (never while departure suppression is active).
    if (!approach.suppressLandHo && (approach.stage === 'preload' || approach.stage === 'sighting' || (fwdLand && fwdCoastKm < 95)) && spawnTerrain && !approach.spawning && !terrain) {
      const landmark = fwdLand ?? scan.visible ?? scan.highest ?? scan.nearest ?? indexForward;
      if (landmark && (scan.complete || fwdCoastKm < 65)) {
        approach.spawning = true;
        const shore = scan.complete ? coastlineToward(probe, lat, lon, landmark) : landmark;
        const region = resolveLandfallRegion(shore.lat, shore.lon);
        const rLat = region.latitude ?? shore.lat, rLon = region.longitude ?? shore.lon;
        const placement = regionLocalOrigin({ shipLat: lat, shipLon: lon, shipX: boat.x, shipZ: boat.z, regionLat: rLat, regionLon: rLon });
        const spawnStart = { lat, lon, x: boat.x, z: boat.z, dateMs: voyage.dateMs };
        try {
          const t = await spawnTerrain({ region, placement: { x: placement.x, z: placement.z }, lat: rLat, lon: rLon, name: region.name });
          if (t && voyage) {
            approach.spawnedTerrain = t;
            // While the pack was building the voyage moved on; slide the land by the difference.
            const now = regionLocalOrigin({ shipLat: voyage.true.lat, shipLon: voyage.true.lon, shipX: boat.x, shipZ: boat.z, regionLat: rLat, regionLon: rLon });
            approach.offset = { x: now.x - placement.x, z: now.z - placement.z };
            t.setWorldOffset?.(approach.offset.x, approach.offset.z);
            if (typeof t.commitWorldOffset === 'function') {
              t.commitWorldOffset({
                boat,
                camera: cfg.getCamera?.() ?? null,
                vessels: cfg.getVessels?.() ?? null,
              });
              approach.offset = { x: 0, z: 0 };
              approach.committed = true;
            } else {
              approach.committed = false;
            }
            if (typeof t.height === 'function' && typeof t.safeStart === 'function') {
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

    // Arrival: inside a newly streamed coastal pack, at real time, after a real passage.
    const newCoast = terrain && terrain !== approach.departureTerrain;
    if (approach.stage === 'inshore' && !voyage.arrived && voyage.rate <= 1.05 && (newCoast || voyage.distanceTrueNm > 60)) {
      voyage.arrived = true;
      const { errorLeagues } = revealTruePosition(voyage, 'landfall');
      const verdict = reckoningVerdict(errorLeagues, voyage.dayAtSea);
      addLog(voyage, `Made our landfall after ${voyage.dayAtSea} days. By the land our reckoning was ${errorLeagues.toFixed(0)} leagues out. ${verdict.text}`, 'arrival');
      raiseInterrupt(voyage, {
        type: 'arrival',
        title: `Landfall · ${verdict.rank}`,
        text: `${voyage.dayAtSea} days at sea, ${(voyage.distanceLoggedNm / NM_PER_LEAGUE).toFixed(0)} leagues logged. Your reckoning was ${errorLeagues.toFixed(0)} leagues from the truth. ${verdict.text}`,
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
    r.querySelector('.voyage-stores').textContent = `Water ${Math.ceil(voyage.provisions.water)} d · Food ${Math.ceil(voyage.provisions.food)} d`;
    if (hud.beat.checked !== helmsman.beat) hud.beat.checked = helmsman.beat;
  }

  function onKey(e) {
    if (!voyage || e.metaKey || e.ctrlKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName ?? '')) return false;
    if (e.code === 'BracketLeft') { alterCourse(e.shiftKey ? -1 : -11.25); return true; }
    if (e.code === 'BracketRight') { alterCourse(e.shiftKey ? 1 : 11.25); return true; }
    if (e.code === 'KeyK' && !e.repeat) { keepHerSo(); return true; }
    if (e.code === 'KeyT' && !e.repeat) { tack(); return true; }
    if (e.code === 'Comma' || e.code === 'Period') {
      const i = WARP_TIERS.findIndex((t) => t.id === voyage.tier);
      const next = WARP_TIERS[Math.max(0, Math.min(WARP_TIERS.length - 1, i + (e.code === 'Period' ? 1 : -1)))];
      setWarp(next.id);
      return true;
    }
    if (e.code === 'Enter' && voyage.interrupt) {
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
