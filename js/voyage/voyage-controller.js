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
      beginScene({ showHud: true });
    }
  }
  function setWarp(id) {
    promoteActive();
    if (voyage.interrupt && warpTier(id).rate > 60) return showToast('Answer the call before making way at speed.');
    if (hud) hud.root.hidden = false;
    setWarpTier(voyage, id);
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
    beginScene({ showHud: !passive, passive });
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
    const nearTerrainAtRealtime = Boolean(terrain) && voyage.rate <= 1.05;
    const events = stepVoyage(voyage, dt, { boat, ignoreCurrent: nearTerrainAtRealtime });
    handleEvents(events);

    // Slide the streamed terrain by however much further the voyage moved than the hull did,
    // so land stays at its true bearing and distance during warp.
    if (terrain && approach.spawnedTerrain === terrain && typeof terrain.setWorldOffset === 'function') {
      const dxLocal = boat.x - approach.lastBoat.x, dzLocal = boat.z - approach.lastBoat.z;
      const { eastM, northM } = voyage.lastStep;
      const sx = -(eastM - dxLocal), sz = -(-northM - dzLocal);
      if (Math.abs(sx) > 1e-4 || Math.abs(sz) > 1e-4) {
        approach.offset.x += sx;
        approach.offset.z += sz;
        terrain.setWorldOffset(approach.offset.x, approach.offset.z);
        approach.committed = false;
      }
      if (!approach.committed && voyage.rate <= 1.05 && (approach.stage === 'inshore' || approach.stage === 'sighting')) {
        terrain.commitWorldOffset?.({
          boat,
          camera: cfg.getCamera?.() ?? null,
          vessels: cfg.getVessels?.() ?? null,
        });
        approach.offset = { x: 0, z: 0 };
        approach.committed = true;
      }
    }
    approach.lastBoat = { x: boat.x, z: boat.z };

    // Open-ocean encounters (whales & strange sails with lookout callouts).
    encounterDirector.step(voyage, boat, dt, {
      coastKm: approach.coastKm,
      marineLife: cfg.getMarineLife?.() ?? null,
      terrain,
      vessels: cfg.getVessels?.() ?? [],
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
      if (advice.severity === 'info') showToast(advice.text, 7);
      else raiseInterrupt(voyage, { type: 'canvas', title: 'The sailing master', text: advice.text, suggest: advice.severity === 'danger' ? 'storm' : 'reduced', choices: [{ id: 'apply', label: advice.severity === 'danger' ? 'Storm canvas' : 'Shorten sail' }, { id: 'ignore', label: 'Carry on' }] }, 'watch');
      if (voyage.interrupt) showCallout(voyage.interrupt);
    } else if (!advice) lastAdvice = null;

    scanTimer -= dt;
    if (scanTimer <= 0 && !voyage.passive) {
      scanTimer = 0.5;
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
    const indexCoast = coastIndex ? coastIndex.nearestCoast(lat, lon, 600) : null;
    // Unknown (index still loading) counts as "near" so the DEM probe is consulted.
    const indexKm = coastIndex ? (indexCoast ? indexCoast.distanceKm : 600) : 0;
    const scanning = indexKm < 320;
    // The DEM probe is the authority near land (it sees islands the coarse index misses).
    if (scanning) probe.prefetch(lat, lon, 190);
    const scan = scanning ? scanForLand(probe, lat, lon, { eyeM, maxKm: 170 }) : { visible: null, nearest: null, highest: null, complete: true };
    approach.scan = scan;
    if (!scanning) approach.coastKm = indexKm;
    else if (scan.nearest) approach.coastKm = scan.nearest.distanceKm;
    else if (scan.complete) approach.coastKm = Math.max(175, indexKm);
    else approach.coastKm = Math.min(indexKm, 175); // tiles still loading: stay conservative
    approach.sightKm = scan.highest ? visibilityRangeKm(eyeM, scan.highest.elevation) : visibilityRangeKm(eyeM, 30);
    if (approach.suppressLandHo && scan.complete && !scan.visible && voyage.distanceTrueNm > 18) approach.suppressLandHo = false;
    // Free the departure coast once it is far astern so the destination can be streamed.
    if (terrain && terrain.region && cfg.disposeTerrain && Math.hypot(boat.x - terrain.region.x, boat.z - terrain.region.z) > 150000) {
      cfg.disposeTerrain(terrain);
      approach.spawnedTerrain = null;
      approach.offset = { x: 0, z: 0 };
      terrain = null;
    }
    const inPack = Boolean(terrain && terrain.region && (() => {
      const r = terrain.region;
      return Math.hypot(boat.x - r.x, boat.z - r.z) < r.span * 0.8;
    })());
    approach.stage = approachStage({ coastKm: approach.coastKm, sightKm: approach.sightKm, visible: Boolean(scan.visible), inPack });
    const v = hullVelocity(boat);
    const ground = Math.hypot(v.east + voyage.current.east, v.north + voyage.current.north);
    voyage.warpCap = approachWarpCap({ coastKm: approach.coastKm, sightKm: approach.sightKm, groundSpeed: ground, stage: approach.stage, demComplete: scan.complete });

    // Land ho!
    if (scan.visible && !approach.landHoCalled && !approach.suppressLandHo) {
      approach.landHoCalled = true;
      const rel = scan.visible.bearing - boat.heading;
      const call = relativeBearingCall(rel);
      addMark(voyage, { kind: 'land', lat: scan.visible.lat, lon: scan.visible.lon, label: 'Land sighted' });
      raiseInterrupt(voyage, {
        type: 'land-ho',
        title: '¡Tierra! Land ho!',
        text: `The lookout sings out: "Land! Land ${call}!" High ground bearing ${compassPointName(scan.visible.bearing - voyage.variation)} by the compass, perhaps ${(scan.visible.distanceKm / 1.852 / NM_PER_LEAGUE).toFixed(0)} leagues off.`,
        bearing: scan.visible.bearing,
        choices: [{ id: 'stand-in', label: 'Stand in toward the land' }, { id: 'hold', label: 'Hold our course' }, { id: 'chart', label: 'Open the chart' }],
        log: `Land sighted ${call}, bearing ${compassPointName(scan.visible.bearing - voyage.variation)} by the compass.`,
      }, 'deck');
      showCallout(voyage.interrupt);
      emit('land-ho', scan.visible);
    } else if (!scan.visible && approach.coastKm > approach.sightKm + 30) {
      approach.landHoCalled = false;
    }

    // Stream the coastal terrain before the land tops the horizon.
    if ((approach.stage === 'preload' || approach.stage === 'sighting') && spawnTerrain && !approach.spawning && !terrain) {
      const landmark = scan.visible ?? scan.highest ?? scan.nearest;
      if (landmark && scan.complete) {
        approach.spawning = true;
        const shore = coastlineToward(probe, lat, lon, landmark);
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
            approach.committed = false;
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
