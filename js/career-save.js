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
export const PORT_CONTACT_RANGE_M = 650;
export const PORT_ROADSTEAD_ANCHOR_RANGE_M = 950;
const INTEL_DAY_MS = 86_400_000;

const clonePlain = (val) => (val === undefined ? undefined : JSON.parse(JSON.stringify(val)));

export function createIntelLedger() {
  return { lastDepartedPortId: null, ports: {}, seaRumors: [] };
}

export function normalizeIntelLedger(raw) {
  const base = createIntelLedger();
  if (!raw || typeof raw !== 'object') return base;
  return {
    lastDepartedPortId: typeof raw.lastDepartedPortId === 'string' ? raw.lastDepartedPortId : null,
    ports: (raw.ports && typeof raw.ports === 'object' && !Array.isArray(raw.ports)) ? { ...raw.ports } : {},
    seaRumors: Array.isArray(raw.seaRumors) ? raw.seaRumors.slice(-16) : [],
  };
}

export function checkLivePortContact({
  moored = false,
  ashore = false,
  portCallOpen = false,
  anchored = false,
  distToPortM = Infinity,
} = {}) {
  if (moored || ashore || portCallOpen) return true;
  if (Number.isFinite(distToPortM) && distToPortM <= PORT_CONTACT_RANGE_M) return true;
  if (anchored && Number.isFinite(distToPortM) && distToPortM <= PORT_ROADSTEAD_ANCHOR_RANGE_M) return true;
  return false;
}

export function snapshotPortIntel(ledger, {
  portId,
  portName = '',
  dateMs = Date.now(),
  boardDay = null,
  town = null,
  market = null,
  realm = null,
  news = [],
} = {}) {
  if (!ledger || typeof ledger !== 'object' || !portId) return null;
  if (!ledger.ports || typeof ledger.ports !== 'object') ledger.ports = {};
  if (!Array.isArray(ledger.seaRumors)) ledger.seaRumors = [];
  const prev = ledger.ports[portId] || null;
  const rec = {
    portId: String(portId),
    portName: String(portName || town?.name || prev?.portName || portId),
    asOfDateMs: Number.isFinite(dateMs) ? dateMs : (prev?.asOfDateMs ?? 0),
    asOfBoardDay: Number.isFinite(boardDay) ? boardDay : (prev?.asOfBoardDay ?? null),
    source: { kind: 'port', shipName: null, masterName: null, hailedAtDateMs: null },
    town: town ? clonePlain(town) : (prev?.town ?? null),
    market: Array.isArray(market) ? clonePlain(market) : (prev?.market ?? null),
    realm: realm ? clonePlain(realm) : (prev?.realm ?? null),
    news: Array.isArray(news) ? clonePlain(news.slice(-8)) : (prev?.news ?? []),
  };
  ledger.ports[portId] = rec;
  ledger.lastDepartedPortId = String(portId);
  return rec;
}

export function mergeHailIntel(ledger, intelPacket, hailedAtDateMs = Date.now()) {
  if (!ledger || typeof ledger !== 'object' || !intelPacket || typeof intelPacket !== 'object') {
    return { updated: false, record: null };
  }
  if (!ledger.ports || typeof ledger.ports !== 'object') ledger.ports = {};
  if (!Array.isArray(ledger.seaRumors)) ledger.seaRumors = [];

  if (intelPacket.rumor) {
    ledger.seaRumors.push({
      dateMs: hailedAtDateMs,
      shipName: intelPacket.shipName || null,
      masterName: intelPacket.masterName || null,
      originPort: intelPacket.originPort?.name || null,
      text: String(intelPacket.rumor),
    });
    if (ledger.seaRumors.length > 16) ledger.seaRumors.splice(0, ledger.seaRumors.length - 16);
  }

  const portId = intelPacket.originPort?.id || null;
  const departedDateMs = Number(intelPacket.departedDateMs);
  if (!portId || !Number.isFinite(departedDateMs)) {
    return { updated: false, record: null };
  }
  const existing = ledger.ports[portId] || null;
  const existingMs = Number.isFinite(existing?.asOfDateMs) ? existing.asOfDateMs : -Infinity;
  if (!(departedDateMs > existingMs)) {
    return { updated: false, record: existing };
  }

  const nextMarket = Array.isArray(intelPacket.marketSnapshot) && intelPacket.marketSnapshot.length
    ? clonePlain(intelPacket.marketSnapshot)
    : (existing?.market ?? null);
  const nextRealm = intelPacket.realmSnapshot
    ? { ...(existing?.realm ?? {}), ...clonePlain(intelPacket.realmSnapshot) }
    : (existing?.realm ?? null);
  const nextTown = intelPacket.townSnapshot
    ? { ...(existing?.town ?? {}), ...clonePlain(intelPacket.townSnapshot) }
    : (existing?.town ?? (intelPacket.originPort?.name ? { name: intelPacket.originPort.name } : null));
  const nextNews = Array.isArray(intelPacket.newsItems) && intelPacket.newsItems.length
    ? clonePlain(intelPacket.newsItems.slice(-8))
    : (existing?.news ?? []);

  const rec = {
    portId: String(portId),
    portName: String(intelPacket.originPort?.name || existing?.portName || portId),
    asOfDateMs: departedDateMs,
    asOfBoardDay: Number.isFinite(intelPacket.asOfBoardDay) ? intelPacket.asOfBoardDay : (existing?.asOfBoardDay ?? null),
    source: {
      kind: 'hail',
      shipName: intelPacket.shipName ? String(intelPacket.shipName) : 'a passing sail',
      shipKind: intelPacket.shipKind ? String(intelPacket.shipKind) : 'vessel',
      masterName: intelPacket.masterName ? String(intelPacket.masterName) : null,
      hailedAtDateMs: Number.isFinite(hailedAtDateMs) ? hailedAtDateMs : departedDateMs,
    },
    town: nextTown,
    market: nextMarket,
    realm: nextRealm,
    news: nextNews,
  };
  ledger.ports[portId] = rec;
  if (!ledger.lastDepartedPortId) ledger.lastDepartedPortId = String(portId);
  return { updated: true, record: rec };
}

export function resolveMateIntel(ledger, { portId = null, nowDateMs = Date.now() } = {}) {
  if (!ledger || typeof ledger !== 'object' || !ledger.ports) return null;
  const key = (portId && ledger.ports[portId])
    ? portId
    : (ledger.lastDepartedPortId && ledger.ports[ledger.lastDepartedPortId])
      ? ledger.lastDepartedPortId
      : Object.keys(ledger.ports)[0] || null;
  if (!key || !ledger.ports[key]) return null;
  const rec = ledger.ports[key];
  const asOfDateMs = Number.isFinite(rec.asOfDateMs) ? rec.asOfDateMs : nowDateMs;
  const ageDays = Math.max(0, Math.floor((nowDateMs - asOfDateMs) / INTEL_DAY_MS));
  const src = rec.source || { kind: 'port' };
  const spokenDaysAgo = src.kind === 'hail' && Number.isFinite(src.hailedAtDateMs)
    ? Math.max(0, Math.floor((nowDateMs - src.hailedAtDateMs) / INTEL_DAY_MS))
    : null;
  const transitDaysAtHail = src.kind === 'hail' && Number.isFinite(src.hailedAtDateMs)
    ? Math.max(0, Math.round((src.hailedAtDateMs - asOfDateMs) / INTEL_DAY_MS))
    : null;
  const tagMeta = { stale: true, ageDays, source: { ...src }, portId: rec.portId, portName: rec.portName, asOfDateMs };
  return {
    stale: true,
    portId: rec.portId,
    portName: rec.portName,
    asOfDateMs,
    asOfBoardDay: rec.asOfBoardDay ?? null,
    ageDays,
    spokenDaysAgo,
    transitDaysAtHail,
    source: { ...src },
    town: rec.town ? { ...clonePlain(rec.town), ...tagMeta } : null,
    market: Array.isArray(rec.market) ? rec.market.map((m) => ({ ...clonePlain(m), stale: true, ageDays })) : null,
    realm: rec.realm ? { ...clonePlain(rec.realm), ...tagMeta } : null,
    news: Array.isArray(rec.news) ? rec.news.map((n) => ({ ...clonePlain(n), stale: true, ageDays })) : [],
    seaRumors: Array.isArray(ledger.seaRumors) ? clonePlain(ledger.seaRumors.slice(-6)) : [],
  };
}

export function createCareerSave({ era = 'new-world' } = {}) {
  return { version: CAREER_SAVE_VERSION, era, savedAtMs: 0, voyage: null, vessel: null, sovereignty: null, url: null, career: { shipsLost: 0, intelLedger: createIntelLedger() } };
}

export function parseCareerSave(raw) {
  if (!raw) return null;
  try {
    const save = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (save?.version !== CAREER_SAVE_VERSION) return null;
    const career = { shipsLost: 0, ...save.career };
    career.intelLedger = normalizeIntelLedger(career.intelLedger);
    return { ...createCareerSave(), ...save, career };
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
