// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The single saved game: voyage, vessel, world and career in one versioned record.
// The URL stays a shareable scene. A tab may write the save only once it owns
// it, so a shared link or scenario opened alongside a voyage can never erase it.
export const CAREER_SAVE_KEY = 'waterworld.career.v1';
export const CAREER_SESSION_KEY = 'waterworld.career.session';
export const CAREER_SAVE_VERSION = 1;
const CAREER_EARTH_RADIUS_KM = 6371;
const CAREER_RAD = Math.PI / 180;
export const SHIPWRECK_PROVISION_DAYS = 14;
export const SHIPWRECK_SURVIVAL = 0.6;
export const SHIPWRECK_REPLACEMENT_HULL = 0.7;
export const SHIPWRECK_PURSE_SAVED = 0.5;

export function createCareerSave({ era = 'new-world' } = {}) {
  return { version: CAREER_SAVE_VERSION, era, savedAtMs: 0, voyage: null, vessel: null, sovereignty: null, url: null, career: { shipsLost: 0 } };
}

export function parseCareerSave(raw) {
  if (!raw) return null;
  try {
    const save = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (save?.version !== CAREER_SAVE_VERSION) return null;
    return { ...createCareerSave(), ...save, career: { shipsLost: 0, ...save.career } };
  } catch {
    return null;
  }
}

// Reads survive private windows and blocked storage: no store simply means no save.
export function createCareerStore({ storage = null, session = null, getSnapshot = null, now = () => Date.now() } = {}) {
  let snapshotProvider = getSnapshot, sealed = false;
  const read = () => {
    try { return parseCareerSave(storage?.getItem?.(CAREER_SAVE_KEY)); } catch { return null; }
  };
  const owned = () => {
    try { return session?.getItem?.(CAREER_SESSION_KEY) === '1'; } catch { return false; }
  };
  const store = {
    read,
    has: () => Boolean(read()?.voyage),
    owned,
    claim() {
      try { session?.setItem?.(CAREER_SESSION_KEY, '1'); } catch { /* private window */ }
    },
    setSnapshotProvider(provider) { snapshotProvider = provider; },
    // What was just written is final for this page: the periodic save of a ship already lost must not replace it
    // while the next page loads.
    seal() { sealed = true; },
    // A tab that begins a scene of its own beside the save gives the save up, and can no longer write it.
    release() {
      try { session?.removeItem?.(CAREER_SESSION_KEY); } catch { /* private window */ }
    },
    write(partial) {
      if (sealed || !owned()) return false;
      const merged = { ...(read() ?? createCareerSave()), ...partial, savedAtMs: now() };
      try {
        storage?.setItem?.(CAREER_SAVE_KEY, JSON.stringify(merged));
        return true;
      } catch {
        return false; // quota
      }
    },
    clear() {
      try { storage?.removeItem?.(CAREER_SAVE_KEY); } catch { /* ignore */ }
    },
    // Shape the voyage controller already persists through.
    voyageStorage: {
      getItem() {
        const voyage = read()?.voyage;
        return voyage ? JSON.stringify(voyage) : null;
      },
      setItem(_key, json) {
        let voyage = null;
        try { voyage = JSON.parse(json); } catch { return; }
        store.write({ voyage, ...(snapshotProvider?.() ?? {}) });
      },
      removeItem() {
        if (owned()) store.clear();
      },
    },
  };
  return store;
}

export function careerGreatCircleKm(latA, lonA, latB, lonB) {
  const dLat = (latB - latA) * CAREER_RAD, dLon = (lonB - lonA) * CAREER_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA * CAREER_RAD) * Math.cos(latB * CAREER_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * CAREER_EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Nearest settlement that exists yet: survivors cannot row to a port not yet founded.
export function nearestFoundedPort(ports, lat, lon, year) {
  let best = null, bestKm = Infinity;
  for (const port of ports ?? []) {
    if (Number.isFinite(port.foundedYear) && port.foundedYear > year) continue;
    const km = careerGreatCircleKm(lat, lon, port.latitude, port.longitude);
    if (km < bestKm) {
      best = port;
      bestKm = km;
    }
  }
  return best;
}

// The ship and everything aboard her are gone. The survivors reach `port` and
// sign aboard a worn vessel of her class; the voyage and its log carry on.
export function applyShipwreckRecovery(save, { voyage, damage, shipName = 'the ship', port }) {
  const casualties = damage?.crewCasualties;
  const total = casualties?.total ?? voyage?.crew ?? 24;
  const lostBefore = (casualties?.killed ?? 0);
  const able = Math.max(0, (casualties?.able ?? total) + (casualties?.wounded ?? 0));
  const survivors = Math.max(Math.min(4, total), Math.round(able * SHIPWRECK_SURVIVAL));
  if (voyage) {
    voyage.true = { ...voyage.true, lat: port.latitude, lon: port.longitude };
    voyage.dr = { ...voyage.dr, lat: port.latitude, lon: port.longitude };
    if (voyage.provisions) {
      voyage.provisions.food = Math.min(voyage.provisions.food ?? SHIPWRECK_PROVISION_DAYS, SHIPWRECK_PROVISION_DAYS);
      voyage.provisions.water = Math.min(voyage.provisions.water ?? SHIPWRECK_PROVISION_DAYS, SHIPWRECK_PROVISION_DAYS);
    }
    voyage.morale = Math.max(0.2, (voyage.morale ?? 0.85) - 0.25);
    voyage.destination = null;
    voyage.arrived = false;
    voyage.passive = true;
    voyage.keepSaved = true;
    voyage.interrupt = null;
    const entry = `${shipName} was lost. ${survivors} survivors reached ${port.name} and signed aboard a worn vessel of her class.`;
    voyage.log = [...(voyage.log ?? []), { dateMs: voyage.dateMs, text: entry, kind: 'combat' }];
  }
  return {
    ...save,
    voyage,
    vessel: {
      ...save?.vessel,
      cargoTonnes: 0,
      damage: {
        hullIntegrity: SHIPWRECK_REPLACEMENT_HULL,
        battleMorale: 0.7,
        crewCasualties: {
          total,
          able: survivors,
          wounded: 0,
          killed: lostBefore + Math.max(0, able - survivors),
        },
      },
    },
    // The cargo went down with her, and only the coin in the boats came ashore.
    career: {
      ...save?.career,
      shipsLost: (save?.career?.shipsLost ?? 0) + 1,
      cargo: {},
      ...(Number.isFinite(save?.career?.purse) ? { purse: Math.floor(save.career.purse * SHIPWRECK_PURSE_SAVED) } : {}),
    },
  };
}
