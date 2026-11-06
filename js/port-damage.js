// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a port has suffered, kept when it is out of sight or the game is closed. A building's record holds its
// standing, and the hits it took (js/building-fracture.js replays them to put every stone back where it fell).
// A town rebuilds what was shot down: a building comes back whole once it has gone long enough unshot.
// The career save holds every port. A share link holds the one in view, as much as fits.
// The ground has its record here too: nobody rebuilds a crater, so it stays until the save does.
// So do trees shot down, a list per coast. Nothing regrows them.
import { encodeBuildingEvent } from './building-fracture.js';
import { reviveGarrisonSoldiers } from './crew.js';
import { classifyBuildingMaterial, createBuildingDamageState } from './gunnery-control.js';

const PORT_DAY_MS = 86400000;
// Days to rebuild from nothing, by what it is built of. A week's clearing up comes first, however light the damage.
const REBUILD_DAYS = Object.freeze({ timber: 30, masonry: 60, 'fortified-stone': 90 });
const REBUILD_MINIMUM_DAYS = 7;
const LINK_LIMIT = 9000;
// Craters by coast, under a key no port can have. Six numbers each, largest first (js/land-craters.js).
const GROUND_KEY = '@ground';
const LINK_GROUND_NUMBERS = 6 * 60;
const DAMAGE_FLAGS = ['damageCollapseBaked', 'breachCollapseBaked', 'ruinCollapseBaked', 'magazineHit', 'magazineExploded', 'silenced'];

const FOREST_RECORD_PREFIX = 'forest:';
// A fort's plan, so that a save made when it had another shape does not put stones back on walls that are not there.
const planKeyOf = (building) => {
  if (building.trace) return `t${building.trace.outline.length}:${Math.round(building.width)}x${Math.round(building.length)}`;
  if (building.gateSide !== undefined || building.enclosureShape) return `e${building.enclosureShape ?? 'triangle'}${building.gateSide ?? 0}`;
  return null;
};
const portKeyOf = (port) => String(port?.regionId ?? port?.id ?? port?.name ?? 'port');
const buildingKeyOf = (building, index) => String(building.id ?? `${building.prefabId ?? 'building'}_${index}`);

export function buildingRebuildDays(damage) {
  const days = REBUILD_DAYS[damage?.materialClass] ?? REBUILD_DAYS.masonry;
  return REBUILD_MINIMUM_DAYS + days * (1 - Math.max(0, Math.min(1, damage?.integrity ?? 1)));
}

function buildingDamageRecord(building) {
  const d = building.damageState;
  if (!d || !(d.hits || d.replayLog || d.fractureLog || d.pendingBakes?.length)) return null;
  const originX = building.x ?? 0, originZ = building.z ?? 0;
  let log = (d.replayLog ?? '') + (d.fractureLog ?? '');
  for (const event of d.pendingBakes ?? []) if (event) log += encodeBuildingEvent(event, originX, originZ);
  const record = {
    p: building.prefabId ?? null, x: Math.round(originX), z: Math.round(originZ),
    s: d.state, i: +d.integrity.toFixed(4), j: Math.round(d.damageJoules), h: d.hits, b: d.breaches ?? 0, t: d.throughBreaches ?? 0, g: d.dismountedGuns ?? 0,
    c: +(d.collapseDropFrac ?? 0).toFixed(3), f: DAMAGE_FLAGS.reduce((bits, name, i) => (d[name] ? bits | (1 << i) : bits), 0),
    a: d.lastHitDateMs ?? null, l: log,
  };
  const planKey = planKeyOf(building);
  if (planKey) record.k = planKey;
  const guns = building.gunnery?.guns;
  if (Array.isArray(guns)) {
    const down = [];
    guns.forEach((gun, i) => { if (gun.dismounted) down.push(i); });
    if (down.length) record.d = down;
  } else if (d.restoredGuns?.length) record.d = d.restoredGuns;
  const magazine = building.magazine;
  if (magazine?.exploded || magazine?.deflagrated) record.m = [Math.round(magazine.powderKg ?? 0), magazine.exploded ? 1 : 0, magazine.deflagrated ? 1 : 0];
  return record;
}

function applyBuildingDamageRecord(building, record) {
  building.damageState = null;
  building.magazine = null;
  const d = createBuildingDamageState(building), magazine = building.magazine;
  d.state = record.s ?? 'damaged';
  d.integrity = record.i ?? 1;
  d.damageJoules = record.j ?? 0;
  d.hits = record.h ?? 0;
  d.forgivenHits = d.hits;
  d.breaches = record.b ?? 0;
  d.throughBreaches = record.t ?? 0;
  d.dismountedGuns = record.g ?? 0;
  d.collapseDropFrac = record.c ?? 0;
  DAMAGE_FLAGS.forEach((name, i) => { d[name] = Boolean((record.f ?? 0) & (1 << i)); });
  d.lastHitDateMs = record.a ?? null;
  d.pendingBakes = [];
  d.fractureLog = '';
  // The next fracture update puts every piece back from this. A port still loading does so before it is seen.
  d.replayLog = record.l || null;
  d.restoredGuns = record.d ?? [];
  if (Array.isArray(building.gunnery?.guns)) for (const i of d.restoredGuns) if (building.gunnery.guns[i]) building.gunnery.guns[i].dismounted = true;
  if (record.m && magazine) {
    magazine.powderKg = record.m[0];
    magazine.exploded = Boolean(record.m[1]);
    magazine.deflagrated = Boolean(record.m[2]);
    if (magazine.initialPowderKg > 0) magazine.powderFraction = magazine.powderKg / magazine.initialPowderKg;
    if (!magazine.powderKg) magazine.barrelsRemaining = 0;
  }
}

/**
 * Every port's saved damage. `saved` is what `snapshot` or `forLink` gave before; `dateMs` is the game's date
 * until `setClock` can read it live. A port with no record costs one lookup when it comes into being.
 */
export function createPortDamageStore(saved = null, { dateMs = null } = {}) {
  let ports = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
  let clock = () => dateMs;
  let groundInView = null;
  const today = () => { const value = clock(); return Number.isFinite(value) ? value : null; };
  const overdue = (lastHit, damageLike) => {
    const date = today();
    return date !== null && Number.isFinite(lastHit) && date - lastHit >= buildingRebuildDays(damageLike) * PORT_DAY_MS;
  };
  const capture = (port) => {
    const instances = port?.instances;
    if (!Array.isArray(instances)) return;
    const key = portKeyOf(port);
    instances.forEach((building, index) => {
      if (!building?.damageState) return;
      const record = buildingDamageRecord(building);
      if (record) (ports[key] ??= {})[buildingKeyOf(building, index)] = record;
    });
  };
  return {
    setClock(read) { clock = read; },
    clear() { ports = {}; },
    capture,
    // When a port comes into being. Records are for this port and these buildings, or they wait.
    restore(port) {
      const key = portKeyOf(port), records = ports[key], instances = port?.instances;
      if (!records || !Array.isArray(instances)) return 0;
      let restored = 0;
      instances.forEach((building, index) => {
        const name = buildingKeyOf(building, index), record = records[name];
        // A building that has moved or changed its plan since the save stands whole. Its old record just waits.
        if (!record || record.p !== (building.prefabId ?? null) || Math.abs(record.x - (building.x ?? 0)) > 1 || Math.abs(record.z - (building.z ?? 0)) > 1) return;
        if ((record.k ?? null) !== planKeyOf(building)) return;
        // Rebuilt while we were away.
        if (overdue(record.a, { integrity: record.i, materialClass: classifyBuildingMaterial(building) })) {
          delete records[name];
          return;
        }
        applyBuildingDamageRecord(building, record);
        restored++;
      });
      if (!Object.keys(records).length) delete ports[key];
      return restored;
    },
    // The craters a coast has when it comes into being. Nothing fills them in: no one in the game mends a field.
    openGround(coast) { groundInView = coast; return ports[GROUND_KEY]?.[coast] ?? null; },
    setGround(coast, craters) { if (craters?.length) (ports[GROUND_KEY] ??= {})[coast] = craters; },
    noteHit(damage) { damage.lastHitDateMs = today(); },
    // What js/forest-trunks.js saved of this coast's trees, or null.
    forestStrikes(coast) { return ports[FOREST_RECORD_PREFIX + coast]?.trees ?? null; },
    setForestStrikes(coast, trees) {
      if (trees?.length) ports[FOREST_RECORD_PREFIX + coast] = { trees };
      else delete ports[FOREST_RECORD_PREFIX + coast];
    },
    rebuildDue(building) {
      const d = building?.damageState;
      if (!d) return false;
      if (!Number.isFinite(d.lastHitDateMs)) { d.lastHitDateMs = today(); return false; }
      return overdue(d.lastHitDateMs, d);
    },
    // A building stands again: nothing is saved of what it went through.
    rebuilt(port, building) {
      const key = portKeyOf(port), records = ports[key], index = port?.instances?.indexOf(building) ?? -1;
      if (records) {
        delete records[buildingKeyOf(building, index)];
        if (!Object.keys(records).length) delete ports[key];
      }
      building.damageState = null;
      building.magazine = null;
      createBuildingDamageState(building);
      for (const gun of building.gunnery?.guns ?? []) gun.dismounted = false;
      reviveGarrisonSoldiers(building);
    },
    // Everything, for the career save. Undefined when nothing has been hit, so a save carries no empty record.
    snapshot(activePorts = []) {
      for (const port of activePorts ?? []) capture(port);
      return Object.keys(ports).length ? ports : undefined;
    },
    // The port in view, for a share link, which is short of room: the most damaged buildings it can fit.
    forLink(port, coast = null) {
      const link = {};
      let room = LINK_LIMIT;
      if (port) {
        capture(port);
        const fitted = {};
        for (const [name, record] of Object.entries(ports[portKeyOf(port)] ?? {}).sort((a, b) => a[1].i - b[1].i)) {
          const size = JSON.stringify(record).length + name.length;
          if (size > room) continue;
          fitted[name] = record;
          room -= size;
        }
        if (Object.keys(fitted).length) link[portKeyOf(port)] = fitted;
      }
      // Then as many of this coast's fallen and wounded trees as still fit, the worst first.
      const trees = coast === null ? null : ports[FOREST_RECORD_PREFIX + coast]?.trees;
      if (trees?.length) {
        const kept = [];
        for (const tree of [...trees].sort((a, b) => b[3] - a[3])) {
          const size = JSON.stringify(tree).length + 1;
          if (size > room) break;
          kept.push(tree);
          room -= size;
        }
        if (kept.length) link[FOREST_RECORD_PREFIX + coast] = { trees: kept };
      }
      // And its largest craters.
      const craters = ports[GROUND_KEY]?.[groundInView];
      if (craters?.length) link[GROUND_KEY] = { [groundInView]: craters.slice(0, LINK_GROUND_NUMBERS) };
      return Object.keys(link).length ? link : undefined;
    },
  };
}
