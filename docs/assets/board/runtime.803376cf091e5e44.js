// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// This game's hand on Castle and Commons' model. It is not a module: it is appended to the model's program
// (assets/board/game.js) and runs in that program's own scope, in a realm of its own, since the program replaces Math's
// functions with its own. It founds the world on the ground the host gave, and reports the board in plain numbers:
// metres east (x) and south (z) of the middle of the ground, turns in radians, heights in metres.
globalThis.BOARD_MODEL = (() => {
  const VERSION = 3;
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  const line = (points) => { const out = []; for (const p of points) out.push(r1(p.x), r1(p.z)); return out; };
  const list = (values, round = r1) => Array.from(values, round);
  const ARCHES = Object.keys(ARCH);

  // The model's storage journal, kept in memory: there is nothing here to save.
  const journal = () => new OutcomeJournal(async (entry) => ({ chunk: entry.chunk, first: entry.first, last: entry.last }), { maxPendingBytes: 64 * 1024 * 1024 });
  // Which program this is, by the hash of its text: the host says, since a program cannot read itself. A world is
  // frozen under that name and taken up again only by the same program.
  const program = () => globalThis.FURLONG_OPTIONS?.board?.program || null;

  const EXTRA_FARPORTS = [
    { n: 'Seville', from: 1250, g: { wine: 0.8, silk: 0.3, spice: 0.3 } },
    { n: 'Porto', from: 1150, g: { wine: 1.3, fish: 0.7, salt: 0.5 } },
    { n: 'Cádiz', from: 1260, g: { wine: 0.9, salt: 0.6, spice: 0.4 } },
    { n: 'Setúbal', from: 1250, g: { salt: 1.3, fish: 0.9, wine: 0.5 } },
    { n: 'La Coruña', from: 1200, g: { fish: 1.1, timber: 0.6, ore: 0.4 } },
    { n: 'Antwerp', from: 1450, g: { cloth: 1.1, ore: 0.4, timber: 0.3 } },
    { n: 'Venice', from: 1050, g: { spice: 1.0, silk: 0.6, wine: 0.2 } },
    { n: 'Genoa', from: 1080, g: { spice: 0.8, silk: 0.5, wine: 0.3 } },
    { n: 'Bordeaux', from: 1150, g: { wine: 1.4, salt: 0.3 } },
    { n: 'Bristol', from: 1350, g: { cloth: 0.9, wool: 0.8, ore: 0.3 } },
    { n: 'Goa', from: 1510, g: { spice: 1.5, silk: 0.8 } },
    { n: 'Malacca', from: 1511, g: { spice: 1.7, silk: 0.5 } },
    { n: 'Bruges', from: 1100, g: { cloth: 1.0, spice: 0.3, wine: 0.2 } },
    { n: 'Lübeck', from: 1160, g: { fish: 0.7, timber: 0.6, ore: 0.4 } },
  ];
  const SHIP_MASTERS = [
    'Bartolomeu Dias', 'Diogo Cão', 'Fernão Gomes', 'Gonçalo Velho',
    'António Tenreiro', 'Duarte Pacheco', 'Vasco da Gama', 'Henrique de Meneses',
    'Nuno Tristão', 'Afonso de Albuquerque', 'Lopo Soares', 'Tristão da Cunha',
  ];
  let maritimeMasterSeq = 0;
  function nextShipMaster() {
    return SHIP_MASTERS[(maritimeMasterSeq++) % SHIP_MASTERS.length];
  }

  // Deterministic 32-bit integer hash so foreign ship manning never perturbs Castle & Commons' PRNG stream.
  function maritimeHash(a, b = 0, c = 0) {
    let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return (h ^ (h >>> 15)) >>> 0;
  }
  function hashText(str) {
    const s = String(str || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h >>> 0;
  }

  // Pre-seeded partner ports (Sevilla, Porto, Antwerp, Venice, Bordeaux) headlessly simulated with C&C households & cards.
  const PARTNER_REGISTRY = (() => {
    const rawPorts = Array.isArray(globalThis.PARTNER_PORTS_SEED?.ports) ? globalThis.PARTNER_PORTS_SEED.ports : [];
    const byAlias = new Map();
    const cardById = new Map();
    const soulById = new Map();
    for (const p of rawPorts) {
      if (!p || !p.name) continue;
      byAlias.set(String(p.name).toLowerCase(), p);
      if (p.id) byAlias.set(String(p.id).toLowerCase(), p);
      for (const al of p.aliases || []) byAlias.set(String(al).toLowerCase(), p);
      for (const group of [p.captains, p.merchants, p.mariners]) {
        for (const s of group || []) {
          if (s && Number.isInteger(s.id)) soulById.set(s.id, { ...s, homePort: p.name });
        }
      }
      for (const [gidStr, entry] of Object.entries(p.cards || {})) {
        const gid = Number(gidStr);
        if (Number.isInteger(gid) && entry?.card) cardById.set(gid, { port: p, entry });
      }
    }
    return { ports: rawPorts, byAlias, cardById, soulById };
  })();

  function resolvePartnerPort(originName, salt = 0) {
    const ports = PARTNER_REGISTRY.ports;
    if (!ports.length) return null;
    const key = String(originName || '').trim().toLowerCase();
    if (key && PARTNER_REGISTRY.byAlias.has(key)) return PARTNER_REGISTRY.byAlias.get(key);
    return ports[maritimeHash(hashText(key), salt, 19) % ports.length];
  }

  function ensureMaritimeLivesStore() {
    if (!W) return { persons: {}, ships: {} };
    if (!W.maritimeLives || typeof W.maritimeLives !== 'object') {
      W.maritimeLives = { persons: {}, ships: {} };
    }
    if (!W.maritimeLives.persons) W.maritimeLives.persons = {};
    if (!W.maritimeLives.ships) W.maritimeLives.ships = {};
    return W.maritimeLives;
  }

  function touchMaritimePersonLife(soul, defaults = {}) {
    if (!soul || !Number.isInteger(soul.id)) return null;
    const store = ensureMaritimeLivesStore();
    const key = String(soul.id);
    let rec = store.persons[key];
    if (!rec) {
      rec = {
        id: soul.id,
        name: soul.name,
        role: soul.role || defaults.role || 'mariner',
        homePort: soul.homePort || defaults.homePort || 'Sevilla',
        voyages: defaults.voyages ?? 1,
        freightCrowns: defaults.freightCrowns ?? 0,
        nowLine: defaults.nowLine || '',
        log: Array.isArray(defaults.initialLog) ? defaults.initialLog.slice(0, 8) : [],
      };
      store.persons[key] = rec;
    }
    if (defaults.nowLine) rec.nowLine = defaults.nowLine;
    return rec;
  }

  function appendMaritimeLifeEvent(personId, eventText) {
    if (!Number.isInteger(personId) || !eventText || !W) return;
    const store = ensureMaritimeLivesStore();
    const rec = store.persons[String(personId)];
    if (!rec) return;
    const stamp = typeof dateStr === 'function' ? dateStr(day()) : `Day ${day()}`;
    const lineText = `${stamp}: ${eventText}`;
    if (rec.log[rec.log.length - 1] !== lineText) {
      rec.log.push(lineText);
      if (rec.log.length > 14) rec.log.splice(0, rec.log.length - 14);
    }
  }

  function formatCargoBrief(bag) {
    const entries = Object.entries(bag || {}).filter(([, q]) => Number(q) > 0.4);
    if (!entries.length) return 'ballast and stores';
    entries.sort((a, b) => Number(b[1]) - Number(a[1]));
    return entries.slice(0, 3).map(([g, q]) => `${Math.round(Number(q))} ${g}`).join(', ');
  }

  function fallbackPartnerSoul(idOffset, name, role, homePort, age) {
    const id = 2_900_000 + idOffset;
    if (!PARTNER_REGISTRY.cardById.has(id)) {
      const bornYr = (typeof AD === 'function' ? AD() : 1550) - age;
      const card = [
        `${name} — ${age}, head · ${role} · ${homePort}`,
        `← ${homePort}`,
        `Home timbered waterside house in the artisan quarter`,
        `Household worth ${role === 'merchant' ? 48 : 22} crowns`,
        `Living ${role} : about ${role === 'merchant' ? 34 : 18} crowns a year here`,
        `Personal status Free`,
        `Household members`,
        `Person | Age | Place`,
        `${name} | ${age} | ${homePort}`,
        `Learning and skills`,
        `Skill | Ability`,
        `reckoning | skilled · 72%`,
        `letters | able · 54%`,
        `craft | skilled · 78%`,
        `Nature weather-beaten, steady, dark-haired`,
        `Learning able letters, skilled reckoning, skilled craft`,
        `Life`,
        `Born Spring 14, AD ${bornYr}`,
      ].join('\n');
      PARTNER_REGISTRY.cardById.set(id, { port: { name: homePort }, entry: { card, links: [] } });
    }
    return { id, name, surname: name.split(' ').slice(1).join(' '), sex: 'm', age, role, homePort };
  }

  function staffOceanShip(sh, usedPersonIds = new Set()) {
    if (!sh) return;
    const worldSeed = typeof SEED === 'number' ? SEED : 1550;
    const shipKey = Number.isInteger(sh.id) ? sh.id : (hashText(sh.from) & 0xffff);
    const port = resolvePartnerPort(sh.from || sh.to, shipKey);
    const homePort = port?.name || String(sh.from || 'Sevilla');
    const localSettlement = W?.settlements?.[sh.port ?? 0]?.name || 'Lisboa';

    const shipNames = port?.shipNames?.length ? port.shipNames : ['Santa Catarina', 'São Cristóvão', 'San Telmo', 'La Belle Marie'];
    if (!sh.shipName) {
      sh.shipName = shipNames[maritimeHash(worldSeed, shipKey, 3) % shipNames.length];
    }
    sh.homePort = homePort;

    const pickUniqueFrom = (list, salt, fallbackRole, fallbackLabel) => {
      if (Array.isArray(list) && list.length) {
        const start = maritimeHash(worldSeed, shipKey, salt) % list.length;
        for (let i = 0; i < list.length; i++) {
          const cand = list[(start + i) % list.length];
          if (cand && !usedPersonIds.has(cand.id)) {
            usedPersonIds.add(cand.id);
            return cand;
          }
        }
        const cand = list[start];
        if (cand) return cand;
      }
      const fbName = SHIP_MASTERS[maritimeHash(worldSeed, shipKey, salt + 71) % SHIP_MASTERS.length] || fallbackLabel;
      const fb = fallbackPartnerSoul((shipKey * 13 + salt) % 80000, fbName, fallbackRole, homePort, 34 + (salt % 15));
      usedPersonIds.add(fb.id);
      return fb;
    };

    const existingCapt = sh.captain?.id ? (PARTNER_REGISTRY.soulById.get(sh.captain.id) || sh.captain) : null;
    const captBase = (existingCapt && !usedPersonIds.has(existingCapt.id))
      ? (usedPersonIds.add(existingCapt.id), existingCapt)
      : pickUniqueFrom(port?.captains, 11, 'shipmaster', 'Diogo Cão');

    const existingMerch = sh.merchant?.id ? (PARTNER_REGISTRY.soulById.get(sh.merchant.id) || sh.merchant) : null;
    const merchBase = (existingMerch && existingMerch.id !== captBase.id && !usedPersonIds.has(existingMerch.id))
      ? (usedPersonIds.add(existingMerch.id), existingMerch)
      : pickUniqueFrom(port?.merchants, 23, 'merchant', 'Fernão Gomes');

    const crewStations = ['helmsman', 'bosun', 'lookout', 'mariner', 'mariner'];
    const crewOut = [];
    const prevCrew = Array.isArray(sh.crew) ? sh.crew : [];
    for (let ci = 0; ci < crewStations.length; ci++) {
      const prev = prevCrew[ci]?.id ? (PARTNER_REGISTRY.soulById.get(prevCrew[ci].id) || prevCrew[ci]) : null;
      const mBase = (prev && !usedPersonIds.has(prev.id))
        ? (usedPersonIds.add(prev.id), prev)
        : pickUniqueFrom(port?.mariners, 37 + ci * 7, 'boatman', `Mateus #${ci + 1}`);
      crewOut.push({
        id: mBase.id,
        name: mBase.name,
        surname: mBase.surname || '',
        sex: mBase.sex || 'm',
        age: mBase.age || 27,
        role: crewStations[ci],
        trade: mBase.role || 'boatman',
        homePort: mBase.homePort || homePort,
        shipName: sh.shipName,
      });
    }

    const cargoText = sh.phase === 'out' && Object.keys(sh.load || {}).length ? formatCargoBrief(sh.load) : formatCargoBrief(sh.cargo);
    const phaseVerb = sh.phase === 'dock'
      ? `anchored off ${localSettlement}`
      : sh.phase === 'out'
        ? `outbound from ${localSettlement} toward ${sh.to || homePort}`
        : `standing in toward ${localSettlement} from ${sh.from || homePort}`;

    const baseVoyages = 2 + (maritimeHash(worldSeed, captBase.id, 91) % 9);
    const captLife = touchMaritimePersonLife(captBase, {
      role: 'shipmaster',
      homePort,
      voyages: baseVoyages,
      freightCrowns: baseVoyages * 11,
      nowLine: `Now ${phaseVerb} as master of the ${sh.kind || 'ship'} ${sh.shipName} (${cargoText})`,
      initialLog: [
        `Took command of the ${sh.kind || 'vessel'} ${sh.shipName} out of ${homePort} (${baseVoyages} Atlantic & coastal passages logged)`,
      ],
    });
    const merchLife = touchMaritimePersonLife(merchBase, {
      role: 'merchant',
      homePort,
      voyages: Math.max(1, baseVoyages - 1),
      freightCrowns: baseVoyages * 19,
      nowLine: `Now ${phaseVerb} aboard ${sh.shipName} as supercargo & factor (${cargoText})`,
      initialLog: [
        `Freighted ${cargoText} aboard ${sh.shipName} out of ${homePort} for the ${localSettlement} exchange`,
      ],
    });
    for (const cm of crewOut) {
      touchMaritimePersonLife(cm, {
        role: cm.role,
        homePort: cm.homePort,
        voyages: 1 + (maritimeHash(worldSeed, cm.id, 103) % 6),
        nowLine: `Now serving as ${cm.role} aboard the ${sh.kind || 'ship'} ${sh.shipName} (${phaseVerb})`,
        initialLog: [
          `Signed aboard ${sh.shipName} at ${homePort} under Master ${captBase.name}`,
        ],
      });
    }

    // Track phase transitions in `W.maritimeLives.ships` so real arrivals, tradings, and departures write to their biographies
    const store = ensureMaritimeLivesStore();
    const sKey = String(sh.id ?? shipKey);
    const prevTrack = store.ships[sKey];
    if (!prevTrack) {
      store.ships[sKey] = { phase: sh.phase, port: sh.port ?? 0 };
      const initMsg = sh.phase === 'dock'
        ? `Anchored the ${sh.kind || 'ship'} ${sh.shipName} at ${localSettlement} with ${cargoText} from ${sh.from || homePort}`
        : sh.phase === 'out'
          ? `Cleared ${localSettlement} aboard ${sh.shipName} with ${cargoText} bound for ${sh.to || homePort}`
          : `Sailed ${sh.shipName} from ${sh.from || homePort} bound for ${localSettlement} with ${cargoText}`;
      appendMaritimeLifeEvent(captBase.id, initMsg);
      appendMaritimeLifeEvent(merchBase.id, `Ventured ${cargoText} aboard ${sh.shipName} (${sh.from || homePort} → ${localSettlement})`);
    } else if (prevTrack.phase !== sh.phase) {
      prevTrack.phase = sh.phase;
      if (sh.phase === 'dock') {
        if (captLife) { captLife.voyages = (captLife.voyages || 1) + 1; captLife.freightCrowns = (captLife.freightCrowns || 0) + 14; }
        if (merchLife) { merchLife.freightCrowns = (merchLife.freightCrowns || 0) + 26; }
        appendMaritimeLifeEvent(captBase.id, `Brought ${sh.shipName} safely to anchor at ${localSettlement} with ${formatCargoBrief(sh.cargo)}`);
        appendMaritimeLifeEvent(merchBase.id, `Landed ${formatCargoBrief(sh.cargo)} at ${localSettlement} customhouse from ${sh.from || homePort}`);
      } else if (sh.phase === 'out') {
        const exportBrief = formatCargoBrief(sh.load);
        appendMaritimeLifeEvent(captBase.id, `Weighed anchor from ${localSettlement} in ${sh.shipName} bound for ${sh.to || homePort} (${exportBrief})`);
        appendMaritimeLifeEvent(merchBase.id, `Laded ${exportBrief} at ${localSettlement} aboard ${sh.shipName} for ${sh.to || homePort}`);
      }
    }

    sh.master = captBase.name;
    sh.captain = {
      id: captBase.id,
      name: captBase.name,
      surname: captBase.surname || '',
      sex: captBase.sex || 'm',
      age: captBase.age || 36,
      role: 'shipmaster',
      trade: captBase.role || 'boatman',
      homePort,
      shipName: sh.shipName,
      voyages: captLife?.voyages ?? baseVoyages,
    };
    sh.merchant = {
      id: merchBase.id,
      name: merchBase.name,
      surname: merchBase.surname || '',
      sex: merchBase.sex || 'm',
      age: merchBase.age || 34,
      role: 'merchant',
      trade: merchBase.role || 'merchant',
      homePort,
      shipName: sh.shipName,
      cargoSummary: cargoText,
      profitCrowns: merchLife?.freightCrowns ?? 0,
    };
    sh.crew = crewOut;
  }

  function staffSeaCaravan(c, idx, usedPersonIds = new Set()) {
    if (!c || !c.sea) return;
    const worldSeed = typeof SEED === 'number' ? SEED : 1550;
    const portIdx = (idx + 1) % Math.max(1, PARTNER_REGISTRY.ports.length || 2);
    const port = PARTNER_REGISTRY.ports[portIdx] || resolvePartnerPort('Porto', idx);
    const homePort = port?.name || 'Porto';
    const origName = W?.settlements?.[c.origin]?.name || homePort;
    const destName = W?.settlements?.[c.dest]?.name || 'Lisboa';
    const shipNames = port?.shipNames?.length ? port.shipNames : ['Flor do Douro', 'São Pedro', 'Bom Jesus'];
    if (!c.shipName) c.shipName = shipNames[maritimeHash(worldSeed, idx + 101, 5) % shipNames.length];
    c.homePort = homePort;

    const pickFrom = (list, salt, fbRole, fbName) => {
      if (Array.isArray(list) && list.length) {
        const start = maritimeHash(worldSeed, idx + 211, salt) % list.length;
        for (let i = 0; i < list.length; i++) {
          const cand = list[(start + i) % list.length];
          if (cand && !usedPersonIds.has(cand.id)) {
            usedPersonIds.add(cand.id);
            return cand;
          }
        }
        return list[start];
      }
      return fallbackPartnerSoul(50000 + idx * 17 + salt, fbName, fbRole, homePort, 31);
    };

    const captBase = c.captain?.id ? (PARTNER_REGISTRY.soulById.get(c.captain.id) || c.captain) : pickFrom(port?.captains, 13, 'shipmaster', 'Gonçalo Velho');
    usedPersonIds.add(captBase.id);
    const merchBase = c.merchant?.id ? (PARTNER_REGISTRY.soulById.get(c.merchant.id) || c.merchant) : pickFrom(port?.merchants, 29, 'merchant', 'António Tenreiro');
    usedPersonIds.add(merchBase.id);
    const crewRoles = ['helmsman', 'lookout', 'mariner'];
    const crewOut = [];
    for (let ci = 0; ci < crewRoles.length; ci++) {
      const mBase = c.crew?.[ci]?.id ? (PARTNER_REGISTRY.soulById.get(c.crew[ci].id) || c.crew[ci]) : pickFrom(port?.mariners, 43 + ci * 11, 'boatman', `Simão #${ci + 1}`);
      usedPersonIds.add(mBase.id);
      crewOut.push({
        id: mBase.id,
        name: mBase.name,
        surname: mBase.surname || '',
        sex: mBase.sex || 'm',
        age: mBase.age || 26,
        role: crewRoles[ci],
        trade: mBase.role || 'boatman',
        homePort,
        shipName: c.shipName,
      });
      touchMaritimePersonLife(mBase, {
        role: crewRoles[ci],
        homePort,
        nowLine: `Now sailing aboard coastal caravel ${c.shipName} (${origName} → ${destName} with ${Math.round(c.qty || 18)} ${c.good || 'wine'})`,
      });
    }
    const cargoBrief = `${Math.round(c.qty || 18)} ${c.good || 'cargo'}`;
    touchMaritimePersonLife(captBase, {
      role: 'shipmaster',
      homePort,
      nowLine: `Now commanding coastal caravel ${c.shipName} between ${origName} and ${destName} (${cargoBrief})`,
      initialLog: [`Commands coastal caravel ${c.shipName} carrying ${cargoBrief} from ${origName} to ${destName}`],
    });
    touchMaritimePersonLife(merchBase, {
      role: 'merchant',
      homePort,
      nowLine: `Now accompanying ${cargoBrief} aboard ${c.shipName} (${origName} → ${destName})`,
      initialLog: [`Shipped ${cargoBrief} coastwise from ${origName} to ${destName} aboard ${c.shipName}`],
    });
    c.master = captBase.name;
    c.captain = {
      id: captBase.id, name: captBase.name, surname: captBase.surname || '', sex: captBase.sex || 'm',
      age: captBase.age || 34, role: 'shipmaster', trade: captBase.role || 'boatman', homePort, shipName: c.shipName,
    };
    c.pilot = {
      id: captBase.id, name: captBase.name, settlementId: c.origin ?? 0, trade: 'shipmaster', homePort, shipName: c.shipName,
    };
    c.merchant = {
      id: merchBase.id, name: merchBase.name, surname: merchBase.surname || '', sex: merchBase.sex || 'm',
      age: merchBase.age || 33, role: 'merchant', trade: merchBase.role || 'merchant', homePort, shipName: c.shipName, cargoSummary: cargoBrief,
    };
    c.crew = crewOut;
  }

  function buildPartnerPersonInspect(personId) {
    const found = PARTNER_REGISTRY.cardById.get(personId);
    if (!found) return null;
    const liveRec = W?.maritimeLives?.persons?.[String(personId)] || null;
    const lines = String(found.entry.card || '').split('\n');
    if (liveRec) {
      // Update first-line role if serving as shipmaster
      if (liveRec.role === 'shipmaster' && lines[0]) {
        lines[0] = lines[0].replace(/ · (boatman|fisher|roper|shipwright) · /, ' · shipmaster · ');
      }
      if (liveRec.nowLine) {
        const nowIdx = lines.findIndex((l) => l.startsWith('Now '));
        if (nowIdx >= 0) lines[nowIdx] = liveRec.nowLine;
        else lines.splice(Math.min(2, lines.length), 0, liveRec.nowLine);
      }
      if (Array.isArray(liveRec.log) && liveRec.log.length) {
        let lifeIdx = lines.indexOf('Life');
        if (lifeIdx < 0) {
          lines.push('Life');
          lifeIdx = lines.length - 1;
        }
        const existing = new Set(lines.slice(lifeIdx + 1));
        for (const ev of liveRec.log) {
          if (!existing.has(ev)) lines.push(ev);
        }
      }
    }
    return {
      kind: 'person',
      card: lines.join('\n'),
      links: Array.isArray(found.entry.links) ? found.entry.links : [],
    };
  }
  function anchorageBerths(s) {
    const out = typeof berthsOf === 'function' ? berthsOf(s).map((b) => ({ ...b })) : [];
    const L = typeof landingOf === 'function' ? landingOf(s) : null;
    if (!L || typeof toCell !== 'function' || typeof inB !== 'function' || typeof cIdx !== 'function') return out;
    const cx0 = toCell(L.x), cz0 = toCell(L.z);
    for (let r = 3; r <= 8 && out.length < 6; r++) {
      for (let a = 0; a < 12 && out.length < 6; a++) {
        const ang = (a / 12) * Math.PI * 2 + r * 0.35;
        const cx = Math.round(cx0 + Math.cos(ang) * r);
        const cz = Math.round(cz0 + Math.sin(ang) * r);
        if (!inB(cx, cz) || W.water?.[cIdx(cx, cz)] !== 1) continue;
        const wx = cellX(cx), wz = cellZ(cz);
        if (out.some((b) => Math.hypot(b.x - wx, b.z - wz) < 52)) continue;
        out.push({ x: wx, z: wz, rot: ang + Math.PI * 0.5, shore: true, anchorage: true });
      }
    }
    return out;
  }
  function ensureMaritimeWorldRoutes(opts = {}) {
    if (!W || !Array.isArray(W.settlements) || !W.settlements.length) return;
    const force = Boolean(opts.force);
    const S = W.settlements;
    const now = day();
    const ad = typeof AD === 'function' ? AD() : 1550;
    const cw = W.coinWeight || 1;
    const localNames = new Set(S.map((s) => String(s?.name || '').trim().toLowerCase()));
    const baseFar = typeof FARPORTS !== 'undefined' && Array.isArray(FARPORTS) ? FARPORTS : [];
    const mergedFar = [...baseFar, ...EXTRA_FARPORTS].filter((f, idx, arr) => {
      if (!f || !f.n) return false;
      const low = f.n.toLowerCase();
      if (localNames.has(low)) return false;
      if (ad < (f.from || 0) || ad >= (f.to || 9999)) return false;
      return arr.findIndex((o) => o && o.n.toLowerCase() === low) === idx;
    });
    const farPool = mergedFar.length ? mergedFar : EXTRA_FARPORTS.filter((f) => !localNames.has(f.n.toLowerCase()));

    // 1. Keep ocean merchantmen (W.ships) active across approaching, anchored/docked, and outbound phases.
    W.ships = W.ships || [];
    const harborPorts = [];
    for (let si = 0; si < S.length; si++) {
      const s = S[si];
      if (!s || (typeof closedToTrade === 'function' && closedToTrade(s))) continue;
      if (!s.harbor && !s.riverside) continue;
      if (typeof offRoute === 'function' && offRoute(si)) harborPorts.push(si);
    }
    if (harborPorts.length && farPool.length) {
      const targetShips = Math.min(7, Math.max(4, harborPorts.length + 3));
      const existingActive = W.ships.filter((sh) => sh && Array.isArray(sh.poly) && sh.poly.length >= 2 && (sh.phase === 'in' || sh.phase === 'dock' || (sh.phase === 'out' && sh.t1 > now)));
      let needed = Math.max(0, targetShips - existingActive.length);
      for (let k = 0; k < needed; k++) {
        const si = harborPorts[k % harborPorts.length];
        const s = S[si];
        const R = offRoute(si);
        if (!R || !Array.isArray(R.poly) || R.poly.length < 2) continue;
        const rankedFar = farPool.slice().sort((a, b) => {
          const score = (fp) => {
            let v = 0, base = 0;
            for (const g in fp.g) {
              if (!GOODBASE[g]) continue;
              v += price(s, g) * fp.g[g];
              base += GOODBASE[g] * fp.g[g];
            }
            return v / Math.max(1e-6, base);
          };
          return score(b) - score(a);
        });
        const F = rankedFar[(W.ships.length + k) % rankedFar.length];
        const cargo = {};
        for (const g in F.g) {
          if (GOODBASE[g]) cargo[g] = Math.max(6, Math.round(F.g[g] * (18 + (typeof frand === 'function' ? frand() : Math.random()) * 26)));
        }
        const phases = force ? ['dock', 'in', 'out', 'dock', 'in', 'out'] : ['in', 'dock', 'in'];
        const phase = phases[k % phases.length];
        const span = Math.max(2.6, R.len / (typeof SHIP_MPD === 'number' ? SHIP_MPD : 3500));
        const berths = anchorageBerths(s);
        const usedBi = new Set(W.ships.filter((o) => o && o.port === si && o.phase === 'dock' && Number.isInteger(o.bi)).map((o) => o.bi));
        let bi = berths.findIndex((_, bIdx) => !usedBi.has(bIdx));
        if (bi < 0 && berths.length) bi = k % berths.length;
        const berth = bi >= 0 ? berths[bi] : null;
        W.shipN = (W.shipN || 0) + 1;
        const kind = typeof shipKind === 'function' ? shipKind() : (ad >= 1400 ? 'carrack' : 'great cog');
        const tonnage = kind === 'carrack' ? 280 + ((W.shipN * 37) % 180) : 160 + ((W.shipN * 29) % 110);
        const sh = {
          id: W.shipN,
          kind,
          from: F.n,
          to: phase === 'out' ? F.n : String(s.name || ''),
          master: nextShipMaster(),
          tonnage,
          port: si,
          cargo,
          load: {},
          phase,
          t0: now - span * (phase === 'out' ? 0.28 : 0.42),
          t1: now + span * (phase === 'out' ? 0.85 : 0.72),
          poly: R.poly,
          len: R.len,
          berth: phase === 'dock' ? berth : null,
          bi: phase === 'dock' ? bi : undefined,
          until: phase === 'dock' ? now + 5 + (k % 5) : undefined,
        };
        if (phase === 'dock' && berth && s.stores) {
          let val = 0;
          for (const g in cargo) {
            if (typeof storageBindGood === 'function' && s.storage && (typeof BEASTS === 'undefined' || !BEASTS.includes(g))) {
              storageBindGood(s, g);
            }
            s.stores[g] = (s.stores[g] || 0) + cargo[g];
            if (typeof offer === 'function') offer(s, g, 'out', cargo[g], GOODBASE[g] / cw);
            val += cargo[g] * GOODBASE[g] / cw;
          }
          if (typeof transfer === 'function' && typeof lordAcct === 'function' && val > 0) {
            transfer('out', lordAcct(s), val * 0.08, 'customs', s);
          }
          s.tradeV = (s.tradeV || 0) + val;
          if (typeof emit === 'function' && !W.prehistory && k < 2) {
            const gList = Object.keys(cargo).slice(0, 2).join(' and ') || 'spice';
            emit('trade', 3, berth, `${sh.kind} out of ${sh.from} (Master ${sh.master}) anchors off ${s.name} with ${gList}.`);
          }
        } else if (phase === 'out' && typeof EXPORTS !== 'undefined' && typeof purchase === 'function') {
          let paid = 0;
          for (const g of EXPORTS) {
            const availQ = typeof spareOf === 'function' ? Math.max(0, spareOf(s, g)) : 0;
            const wantQ = Math.min(availQ, 24);
            if (wantQ >= 2 && price(s, g) < (GOODBASE[g] || 1) * 1.35 / cw) {
              const v = purchase(s, g, 'out', wantQ);
              const got = Number(purchase.got) || 0;
              if (got >= 1) {
                if (s.storage && (typeof BEASTS === 'undefined' || !BEASTS.includes(g))) storageConsumePurchased(s, 'out', g, got, 'foreign-export');
                else s.stores[g] = Math.max(0, (s.stores[g] || 0) - got);
                sh.load[g] = got;
                paid += v;
              }
            }
          }
          if (paid > 0 && typeof transfer === 'function' && typeof lordAcct === 'function') transfer('out', lordAcct(s), paid * 0.05, 'customs', s);
          s.tradeV = (s.tradeV || 0) + paid;
          if (typeof emit === 'function' && !W.prehistory && k < 2) {
            emit('trade', 2, R.poly[R.poly.length - 1], `${sh.kind} (${sh.master}) puts out from ${s.name} bound for ${F.n}.`);
          }
        } else if (typeof emit === 'function' && !W.prehistory && k < 2) {
          emit('trade', 2, R.poly[0], `Sails from ${F.n} sighted standing in toward ${s.name}.`);
        }
        W.ships.push(sh);
      }
    }
    const usedPartnerFolk = new Set();
    for (const sh of W.ships) {
      if (sh && Array.isArray(sh.poly) && sh.poly.length >= 2) {
        staffOceanShip(sh, usedPartnerFolk);
      }
    }

    // 2. Keep coastal bay boats (sea), river barges (river), and arterial wagon caravans (cart) moving through C&C routes.
    W.caravans = W.caravans || [];
    const activeByMode = (mode) => W.caravans.filter((c) => c && !c.gone && !c.robbed && Array.isArray(c.poly) && c.poly.length >= 2 && (c.sea ? 'sea' : c.river ? 'river' : 'cart') === mode && now >= c.departDay && now < c.arriveDay);
    const activeSea = activeByMode('sea');
    const activeRiver = activeByMode('river');
    const activeCart = activeByMode('cart');

    const rankGoodsForPair = (oi, di, isBoat) => {
      const o = S[oi], d = S[di];
      const list = [];
      for (const g of GOODS) {
        if (isBoat && typeof BEASTS !== 'undefined' && BEASTS.includes(g)) continue;
        const pO = price(o, g);
        const onSale = typeof avail === 'function' ? Math.max(0, Number(avail(o, g, pO * 1.4)) || 0) : Math.max(0, Number(o.stores?.[g]) || 0);
        if (onSale < 6) continue;
        const margin = price(d, g) - pO;
        list.push({ g, onSale, score: margin * 4 + Math.min(30, onSale) * 0.02 });
      }
      list.sort((a, b) => b.score - a.score);
      return list;
    };
    const safeAgeYrs = (p) => (typeof ageYrs === 'function' ? ageYrs(p) : (Number.isFinite(p?.age) ? p.age : 26));
    const safeFolkName = (p) => {
      if (!p) return 'Barqueiro';
      if (typeof folkName === 'function') {
        try { return folkName(p); } catch { /* fallback */ }
      }
      return p.name || p.gn || `Pilot #${p.id ?? 0}`;
    };
    const isAwayNow = (p) => {
      if (!p) return true;
      if (typeof awayNow === 'function') {
        try { return Boolean(awayNow(p)); } catch { /* fallback */ }
      }
      return Boolean(p.away && now < (p.away.until ?? 0));
    };
    const pickOrPromoteBoatman = (prefSi, role = 'pilot', usedIds = new Set()) => {
      const order = [];
      if (prefSi >= 0 && prefSi < S.length) order.push(prefSi);
      for (let i = 0; i < S.length; i++) if (i !== prefSi && (S[i]?.harbor || S[i]?.riverside)) order.push(i);
      for (let i = 0; i < S.length; i++) if (!order.includes(i)) order.push(i);
      for (const pass of [0, 1]) {
        for (const si of order) {
          const s = S[si];
          const folkList = s?.folk;
          if (!Array.isArray(folkList) || !folkList.length) continue;
          for (const p of folkList) {
            if (!p || p.dead || p.sx !== 'm' || usedIds.has(p.id) || isAwayNow(p)) continue;
            const age = safeAgeYrs(p);
            if (age < 16 || age > 62) continue;
            if (pass === 0 && p.tr !== 'boatman') continue;
            if (pass === 1 && (p.office || p.estateOffice || p.schoolMaster || p.abbey != null || p.churchBody || p.outlawCampId)) continue;
            if (pass === 1 && role === 'pilot') p.tr = 'boatman';
            if (p.si == null) p.si = si;
            usedIds.add(p.id);
            return p;
          }
        }
      }
      const fallbackSi = order[0] ?? 0;
      const fallbackS = S[fallbackSi];
      if (fallbackS) {
        fallbackS.folk = fallbackS.folk || [];
        const id = 900000 + Math.floor(Math.random() * 90000) + fallbackS.folk.length;
        const p = { id, gn: role === 'pilot' ? 'Diogo' : 'Mateus', fam: 0, sx: 'm', age: 28, tr: 'boatman', si: fallbackSi, w: 3, sk: {} };
        fallbackS.folk.push(p);
        usedIds.add(id);
        return p;
      }
      return null;
    };
    const staffRiverVessel = (c, oi, di, mode) => {
      if (mode !== 'river') return;
      const used = new Set();
      if (c.pilot?.id != null) used.add(c.pilot.id);
      const destName = S[di]?.name || 'up-river';
      const tripDays = Math.max(0.5, (c.arriveDay || now + 2) - (c.departDay || now));
      const until = (c.arriveDay || now + 2) + tripDays;
      if (!c.pilot || c.pilot.id == null) {
        const pilot = pickOrPromoteBoatman(oi, 'pilot', used);
        if (pilot) {
          pilot.tr = pilot.tr || 'boatman';
          pilot.away = { until, what: `piloting river barge with ${c.good || 'cargo'} to ${destName}` };
          c.crew = pilot;
          c.pilot = {
            id: pilot.id,
            name: safeFolkName(pilot),
            settlementId: pilot.si ?? oi,
            trade: pilot.tr,
            wage: +(0.4 + (c.len || 350) / 1600).toFixed(2),
          };
        }
      }
      if (!Array.isArray(c.oarsmen) || c.oarsmen.length < 2) {
        const oarsmen = [];
        for (let oi2 = 0; oi2 < 4; oi2++) {
          const oar = pickOrPromoteBoatman(oi, 'oarsman', used);
          if (!oar) break;
          oar.away = { until, what: `rowing river barge toward ${destName}` };
          oarsmen.push({ id: oar.id, name: safeFolkName(oar), settlementId: oar.si ?? oi, trade: oar.tr || 'boatman' });
        }
        c.oarsmen = oarsmen;
      }
    };
    const findFolkById = (pid) => {
      if (pid == null) return null;
      for (const s of S) {
        for (const p of s?.folk || []) if (p && p.id === pid && !p.dead) return p;
      }
      return null;
    };

    const tryDispatchRoute = (mode, oi, di, poly, len, frac) => {
      if (!Array.isArray(poly) || poly.length < 2 || !(len > 20)) return false;
      const o = S[oi], d = S[di];
      if (!o || !d) return false;
      const baseSpeed = mode === 'sea' ? (typeof COG_MPD === 'number' ? COG_MPD : 2400) : mode === 'river' ? (typeof BARGE_MPD === 'number' ? BARGE_MPD : 1100) : (typeof CART_MPD === 'number' ? CART_MPD : 520);
      const goods = rankGoodsForPair(oi, di, mode !== 'cart');
      for (const item of goods) {
        const g = item.g;
        const qty = Math.min(mode === 'cart' ? 24 : 36, Math.max(6, Math.round(item.onSale * 0.25)));
        const span = Math.max(4.5, len / Math.max(240, baseSpeed));
        const departDay = now - frac * span;
        const arriveDay = Math.max(now + 2.8, departDay + span);
        const c = {
          origin: oi,
          dest: di,
          good: g,
          qty,
          value: qty * price(d, g),
          poly: poly.map((p) => ({ x: p.x, z: p.z })),
          len,
          departDay,
          arriveDay,
          robbed: false,
          sea: mode === 'sea',
          river: mode === 'river',
          unit: Math.max(0.08, price(d, g) - price(o, g)),
          master: nextShipMaster(),
        };
        const needsRawDecrement = !o.storage || (typeof BEASTS !== 'undefined' && BEASTS.includes(g));
        if (needsRawDecrement) o.stores[g] = Math.max(0, (o.stores[g] || 0) - qty);
        if (typeof ladeOut === 'function' && ladeOut(c, o, true)) {
          if (c.arriveDay < now + 2.8) c.arriveDay = now + 2.8;
          staffRiverVessel(c, oi, di, mode);
          W.caravans.push(c);
          if (typeof emit === 'function' && !W.prehistory && force) {
            const label = mode === 'sea' ? 'coastal caravel' : mode === 'river' ? 'river barge' : 'merchant wain train';
            emit('trade', 2, poly[Math.floor(poly.length / 2)], `A ${label} laden with ${g} runs between ${o.name} and ${d.name}.`);
          }
          return true;
        }
        if (needsRawDecrement) o.stores[g] = (o.stores[g] || 0) + qty;
      }
      if (!(typeof commodityActive === 'function' && (commodityActive(o) || commodityActive(d)))) {
        const g = GOODS.find((cand) => mode === 'cart' || typeof BEASTS === 'undefined' || !BEASTS.includes(cand)) || 'grain';
        const span = Math.max(4.5, len / Math.max(240, baseSpeed));
        const departDay = now - frac * span;
        const arriveDay = Math.max(now + 2.8, departDay + span);
        const qty = mode === 'cart' ? 16 : 24;
        const c = {
          origin: oi,
          dest: di,
          good: g,
          qty,
          value: qty * price(d, g),
          poly: poly.map((p) => ({ x: p.x, z: p.z })),
          len,
          departDay,
          arriveDay,
          robbed: false,
          sea: mode === 'sea',
          river: mode === 'river',
          unit: Math.max(0.08, price(d, g) - price(o, g)),
          master: nextShipMaster(),
        };
        if (typeof crewFor === 'function' && !W.prehistory) {
          c._staffed = true;
          try { crewFor(c); } catch { /* settlement fallback */ }
        }
        staffRiverVessel(c, oi, di, mode);
        W.caravans.push(c);
        return true;
      }
      return false;
    };

    // Ensure every active river caravan already in W.caravans also carries a sim boatman pilot.
    for (const c of W.caravans) {
      if (c && !c.gone && !c.robbed && c.river && (!c.pilot || c.pilot.id == null)) {
        staffRiverVessel(c, c.origin ?? 0, c.dest ?? 0, 'river');
      }
    }

      if (activeSea.length < 4 && harborPorts.length >= 2 && typeof seaRoute === 'function') {
      const seaPairs = [];
      for (let a = 0; a < harborPorts.length; a++) {
        for (let b = a + 1; b < harborPorts.length; b++) {
          const oi = harborPorts[a], di = harborPorts[b];
          const sr = seaRoute(oi, di);
          if (sr && sr.poly?.length >= 2) seaPairs.push({ oi, di, poly: sr.poly, len: sr.len });
        }
      }
      let needSea = Math.min(6, Math.max(4, seaPairs.length)) - activeSea.length;
      for (let i = 0; i < seaPairs.length * 2 && needSea > 0; i++) {
        const pair = seaPairs[i % seaPairs.length];
        const forward = (i % 2) === 0;
        const poly = forward ? pair.poly : [...pair.poly].reverse();
        if (tryDispatchRoute('sea', forward ? pair.oi : pair.di, forward ? pair.di : pair.oi, poly, pair.len, 0.16 + ((i * 0.21) % 0.62))) needSea--;
      }
    }
    let seaCaravanIdx = 0;
    for (const c of W.caravans) {
      if (c && !c.gone && !c.robbed && c.sea) {
        staffSeaCaravan(c, seaCaravanIdx++, usedPartnerFolk);
      }
    }

    if (activeRiver.length < 2 && Array.isArray(W.riverPairs) && W.riverPairs.length) {
      let needRiv = Math.min(3, W.riverPairs.length * 2) - activeRiver.length;
      for (let i = 0; i < W.riverPairs.length * 2 && needRiv > 0; i++) {
        const pr = W.riverPairs[i % W.riverPairs.length];
        if (!pr?.route?.poly || pr.route.poly.length < 2) continue;
        const forward = (i % 2) === 0;
        const poly = forward ? pr.route.poly : [...pr.route.poly].reverse();
        if (tryDispatchRoute('river', forward ? pr.a : pr.b, forward ? pr.b : pr.a, poly, pr.route.len || 400, 0.20 + ((i * 0.27) % 0.56))) needRiv--;
      }
    }

    if (activeCart.length < 4 && S.length >= 2) {
      const roadPairs = [];
      for (let oi = 0; oi < S.length; oi++) {
        for (let di = oi + 1; di < S.length; di++) {
          const r = typeof route === 'function' ? route(oi, di) : null;
          if (r && Array.isArray(r.poly) && r.poly.length >= 2 && r.len > 60) {
            roadPairs.push({ oi, di, poly: r.poly, len: r.len });
          }
        }
      }
      let needCart = Math.max(0, Math.min(6, Math.max(4, roadPairs.length)) - activeCart.length);
      for (let i = 0; i < roadPairs.length * 2 && needCart > 0; i++) {
        const pair = roadPairs[i % roadPairs.length];
        const forward = (i % 2) === 0;
        const poly = forward ? pair.poly : [...pair.poly].reverse();
        if (tryDispatchRoute('cart', forward ? pair.oi : pair.di, forward ? pair.di : pair.oi, poly, pair.len, 0.18 + ((i * 0.19) % 0.58))) needCart--;
      }
    }

    // Persistent canonical manned river boats on navigable river reaches (`W.riverBoats`).
    if (!Array.isArray(W.riverBoats)) W.riverBoats = [];
    const distPt = (a, b) => Math.hypot((b.x || 0) - (a.x || 0), (b.z || 0) - (a.z || 0));
    const nearestSettlement = (pt) => {
      let best = 0, bestD = Infinity;
      for (let si = 0; si < S.length; si++) {
        const sp = S[si]?.pos;
        if (!sp) continue;
        const d = distPt(pt, sp);
        if (d < bestD) { bestD = d; best = si; }
      }
      return best;
    };
    if (W.riverBoats.length === 0 && Array.isArray(W.rivStrips) && W.rivStrips.length > 0 && S.length > 0) {
      const reaches = [];
      for (let ri = 0; ri < W.rivStrips.length; ri++) {
        const q = W.rivStrips[ri];
        if (!q || q.canal || !Array.isArray(q.pts) || q.pts.length < 4) continue;
        let totalLen = 0, hwSum = 0;
        for (let k = 0; k < q.pts.length; k++) {
          hwSum += q.hw?.[k] ?? 2;
          if (k > 0) totalLen += distPt(q.pts[k - 1], q.pts[k]);
        }
        const avgHw = hwSum / q.pts.length;
        if (totalLen >= 160 && avgHw >= 2.05) {
          reaches.push({ ri, pts: q.pts, totalLen });
        }
      }
      let nextId = 1;
      for (let idx = 0; idx < reaches.length && W.riverBoats.length < 4; idx++) {
        const r = reaches[idx];
        const copies = r.totalLen >= 460 && W.riverBoats.length < 3 ? 2 : 1;
        for (let copy = 0; copy < copies && W.riverBoats.length < 4; copy++) {
          const forward = ((idx + copy) % 2) === 0;
          const pts = (forward ? r.pts : [...r.pts].reverse()).map((p) => ({ x: p.x, z: p.z }));
          const si = nearestSettlement(pts[0]);
          const destSi = nearestSettlement(pts[pts.length - 1]);
          const tripSpan = Math.max(2.4, +(r.totalLen / 380).toFixed(2));
          const phaseFrac = ((idx * 0.37 + copy * 0.43 + 0.14) % 0.82);
          const departDay = now - phaseFrac * tripSpan;
          const id = nextId++;
          W.riverBoats.push({
            id,
            key: `rb:${id}`,
            riverIdx: r.ri,
            si,
            destSi,
            phase: 'shuttle',
            scale: +(0.74 + ((id * 0.04) % 0.14)).toFixed(2),
            tripSpan,
            departDay,
            arriveDay: departDay + tripSpan,
            points: pts,
            forward,
            pilotId: null,
            pilot: null,
            oarsmen: [],
            sunk: false,
          });
        }
      }
    }
    const usedRiverFolk = new Set();
    for (const b of W.riverBoats) {
      if (!b || b.sunk) continue;
      if (now >= (b.arriveDay ?? -Infinity)) {
        const prevPilot = findFolkById(b.pilotId);
        if (prevPilot) {
          const acct = typeof accountOwner === 'function' ? accountOwner(prevPilot) : null;
          if (acct && Number.isFinite(acct.w)) acct.w += 0.55;
          else if (Number.isFinite(prevPilot.w)) prevPilot.w += 0.55;
        }
        b.points = [...(b.points || [])].reverse();
        const prevSi = b.si;
        b.si = b.destSi ?? prevSi;
        b.destSi = prevSi ?? b.si;
        b.forward = !b.forward;
        const span = Math.max(2.0, b.tripSpan || 3.5);
        b.departDay = now;
        b.arriveDay = now + span;
      }
      const until = (b.arriveDay || now + 3) + Math.max(0.5, b.tripSpan || 2);
      const destName = S[b.destSi]?.name || S[b.si]?.name || 'harbor';
      let pilotFolk = findFolkById(b.pilotId);
      if (!pilotFolk || usedRiverFolk.has(pilotFolk.id)) {
        pilotFolk = pickOrPromoteBoatman(b.si ?? 0, 'pilot', usedRiverFolk);
      } else {
        usedRiverFolk.add(pilotFolk.id);
      }
      if (pilotFolk) {
        pilotFolk.tr = pilotFolk.tr || 'boatman';
        pilotFolk.away = { until, what: `piloting river barge toward ${destName}` };
        b.pilotId = pilotFolk.id;
        b.pilot = {
          id: pilotFolk.id,
          name: safeFolkName(pilotFolk),
          settlementId: pilotFolk.si ?? b.si ?? 0,
          trade: pilotFolk.tr,
        };
      }
      const nextOars = [];
      for (const existing of Array.isArray(b.oarsmen) ? b.oarsmen : []) {
        const oarFolk = findFolkById(existing?.id);
        if (!oarFolk || usedRiverFolk.has(oarFolk.id)) continue;
        usedRiverFolk.add(oarFolk.id);
        oarFolk.away = { until, what: `rowing river barge toward ${destName}` };
        nextOars.push({
          id: oarFolk.id,
          name: safeFolkName(oarFolk),
          settlementId: oarFolk.si ?? b.si ?? 0,
          trade: oarFolk.tr || 'boatman',
        });
      }
      while (nextOars.length < 4) {
        const oarFolk = pickOrPromoteBoatman(b.si ?? 0, 'oarsman', usedRiverFolk);
        if (!oarFolk) break;
        oarFolk.away = { until, what: `rowing river barge toward ${destName}` };
        nextOars.push({
          id: oarFolk.id,
          name: safeFolkName(oarFolk),
          settlementId: oarFolk.si ?? b.si ?? 0,
          trade: oarFolk.tr || 'boatman',
        });
      }
      b.oarsmen = nextOars;
    }
  }

  async function found({ seed, fate = 1, era }, progress = null) {
    STORAGE_OUTCOMES.journal = journal();
    FATE = fate >>> 0; COAST_PREF = 'sea'; START_AD = era;
    await generateWorld(seed >>> 0, (text, fraction) => { progress?.(text, fraction); return Promise.resolve(); });
    initializeSimulation();
    // A realm asked to have lived its history was founded in its early age: its centuries pass now, a day at a time.
    if (globalThis.FURLONG_OPTIONS?.board?.lived) {
      let said = 0;
      await advancePrehistory((text, fraction) => { if (AD() !== said) { said = AD(); progress?.(text, fraction); } return Promise.resolve(); });
    }
    beginChronicle();
    // The model first gives each household its roof at the turn of a year. Here they are wanted from the first day.
    for (const s of W.settlements) if (!(s.folk || []).some((p) => p.bh)) houseFolk(s);
    ensureMaritimeWorldRoutes({ force: true });
    return board();
  }

  // So many days of the model's own life: its politics, trade, building and war.
  const MARITIME_PILOT = {
    reportDay: -1,
    storm: false,
    windSpeed: 8,
    windDir: 0,
    ships: new Map(),
    caravans: new Map(),
    riverBoats: new Map(),
  };

  function maritimeCaravanKey(c) {
    let key = null;
    try { key = typeof caravanInspectionKey === 'function' ? String(caravanInspectionKey(c)) : null; } catch { key = null; }
    return key ?? `${c.origin}>${c.dest}:${c.departDay}:${c.good}`;
  }

  function pilotMaritime(report) {
    if (!report || typeof report !== 'object') {
      return { ok: false, day: day(), trackedShips: MARITIME_PILOT.ships.size, trackedCaravans: MARITIME_PILOT.caravans.size };
    }
    MARITIME_PILOT.reportDay = Number.isFinite(report.day) ? report.day : day();
    MARITIME_PILOT.storm = Boolean(report.storm);
    if (Number.isFinite(report.windSpeed)) MARITIME_PILOT.windSpeed = report.windSpeed;
    if (Number.isFinite(report.windDir)) MARITIME_PILOT.windDir = report.windDir;
    if (Array.isArray(report.ships)) {
      const seen = new Set();
      for (const entry of report.ships) {
        if (!entry || entry.id == null) continue;
        const idKey = String(entry.id);
        seen.add(idKey);
        const prev = MARITIME_PILOT.ships.get(idKey);
        MARITIME_PILOT.ships.set(idKey, {
          id: idKey,
          state: String(entry.state || 'inbound'),
          etaDays: Number.isFinite(entry.etaDays) ? Math.max(0, entry.etaDays) : (prev?.etaDays ?? 0),
          berthIndex: Number.isFinite(entry.berthIndex) ? entry.berthIndex : -1,
          progress: Number.isFinite(entry.progress) ? Math.max(0, Math.min(1, entry.progress)) : 0,
          heldByWeather: Boolean(entry.heldByWeather),
          sunk: Boolean(entry.sunk || prev?.sunk),
        });
      }
      for (const existingKey of Array.from(MARITIME_PILOT.ships.keys())) {
        if (!seen.has(existingKey)) MARITIME_PILOT.ships.delete(existingKey);
      }
    }
    if (Array.isArray(report.caravans)) {
      const seenC = new Set();
      for (const entry of report.caravans) {
        if (!entry || entry.key == null) continue;
        const cKey = String(entry.key);
        seenC.add(cKey);
        const prev = MARITIME_PILOT.caravans.get(cKey);
        MARITIME_PILOT.caravans.set(cKey, {
          key: cKey,
          etaDays: Number.isFinite(entry.etaDays) ? Math.max(0, entry.etaDays) : (prev?.etaDays ?? 0),
          progress: Number.isFinite(entry.progress) ? Math.max(0, Math.min(1, entry.progress)) : 0,
          heldByWeather: Boolean(entry.heldByWeather),
          sunk: Boolean(entry.sunk || prev?.sunk),
        });
      }
      for (const existingKey of Array.from(MARITIME_PILOT.caravans.keys())) {
        if (!seenC.has(existingKey)) MARITIME_PILOT.caravans.delete(existingKey);
      }
    }
    if (Array.isArray(report.riverBoats)) {
      const seenRb = new Set();
      for (const entry of report.riverBoats) {
        if (!entry || entry.id == null) continue;
        const idKey = String(entry.id);
        seenRb.add(idKey);
        const prev = MARITIME_PILOT.riverBoats.get(idKey);
        MARITIME_PILOT.riverBoats.set(idKey, {
          id: idKey,
          state: String(entry.state || 'shuttle'),
          etaDays: Number.isFinite(entry.etaDays) ? Math.max(0, entry.etaDays) : (prev?.etaDays ?? 0),
          progress: Number.isFinite(entry.progress) ? Math.max(0, Math.min(1, entry.progress)) : 0,
          heldByWeather: Boolean(entry.heldByWeather),
          sunk: Boolean(entry.sunk || prev?.sunk),
        });
      }
      for (const existingKey of Array.from(MARITIME_PILOT.riverBoats.keys())) {
        if (!seenRb.has(existingKey)) MARITIME_PILOT.riverBoats.delete(existingKey);
      }
    }
    return {
      ok: true,
      day: day(),
      trackedShips: MARITIME_PILOT.ships.size,
      trackedCaravans: MARITIME_PILOT.caravans.size,
      trackedRiverBoats: MARITIME_PILOT.riverBoats.size,
    };
  }

  function applyMaritimePilotBeforeTick() {
    if (typeof W === 'undefined' || !W) return;
    const curDay = day();
    const nextDay = curDay + 1;
    const recentReport = MARITIME_PILOT.reportDay >= curDay - 1;
    const storm = Boolean((MARITIME_PILOT.storm && recentReport) || W.weather?.state === 'storm');

    const shipsArr = W.ships || [];
    for (let i = shipsArr.length - 1; i >= 0; i--) {
      const sh = shipsArr[i];
      if (!sh || sh.expedition) continue;
      const idKey = String(sh.id ?? i);
      const rep = MARITIME_PILOT.ships.get(idKey) || null;
      const s = W.settlements?.[sh.port] || null;
      if (rep?.sunk) {
        if (sh.captain?.id) appendMaritimeLifeEvent(sh.captain.id, `Foundered aboard ${sh.shipName || sh.kind || 'her vessel'} off ${s?.name || 'the coast'}`);
        if (sh.merchant?.id) appendMaritimeLifeEvent(sh.merchant.id, `Lost ventured cargo when ${sh.shipName || sh.kind || 'the ship'} foundered off ${s?.name || 'the coast'}`);
        shipsArr.splice(i, 1);
        MARITIME_PILOT.ships.delete(idKey);
        if (!W.prehistory && typeof emit === 'function') {
          const where = sh.berth || s?.pos || null;
          emit('trade', 4, where, `The ${sh.kind || 'vessel'} ${sh.shipName ? sh.shipName + ' ' : ''}out of ${sh.from || 'afar'} foundered off ${s?.name || 'the coast'}; her cargo is lost to the sea.`);
        }
        continue;
      }
      if (sh.phase === 'in') {
        if (rep) {
          if (rep.state === 'docking' || rep.state === 'docked' || rep.state === 'waiting_berth') {
            sh.t1 = Math.min(sh.t1 ?? nextDay, nextDay);
          } else if (Number.isFinite(rep.etaDays) && rep.etaDays > 0.35) {
            sh.t1 = Math.max(nextDay + 0.25, curDay + rep.etaDays);
            rep.etaDays = Math.max(0, rep.etaDays - 1);
          }
        } else if (storm) {
          sh.t1 = (sh.t1 ?? nextDay) + 1;
        }
      } else if (sh.phase === 'dock') {
        if (storm || (rep?.heldByWeather && recentReport)) {
          sh.until = Math.max(sh.until ?? nextDay, nextDay + 1);
        }
      } else if (sh.phase === 'out') {
        if (rep) {
          if (rep.state === 'departing') {
            sh.t1 = Math.max(sh.t1 ?? nextDay, nextDay + 1);
          } else if (rep.progress >= 0.98 || (Number.isFinite(rep.etaDays) && rep.etaDays <= 0.2)) {
            sh.t1 = Math.min(sh.t1 ?? nextDay, nextDay);
          } else if (Number.isFinite(rep.etaDays) && rep.etaDays > 0.35) {
            sh.t1 = Math.max(nextDay + 0.25, curDay + rep.etaDays);
            rep.etaDays = Math.max(0, rep.etaDays - 1);
          }
        } else if (storm) {
          sh.t1 = (sh.t1 ?? nextDay) + 1;
        }
      }
    }

    const caravansArr = W.caravans || [];
    for (let i = 0; i < caravansArr.length; i++) {
      const c = caravansArr[i];
      if (!c || c.gone || c.robbed || (!c.sea && !c.river)) continue;
      const cKey = maritimeCaravanKey(c);
      const rep = MARITIME_PILOT.caravans.get(cKey) || null;
      if (rep?.sunk) {
        c.gone = true;
        MARITIME_PILOT.caravans.delete(cKey);
        continue;
      }
      if (rep) {
        if (rep.progress >= 0.98 || (Number.isFinite(rep.etaDays) && rep.etaDays <= 0.2)) {
          c.arriveDay = Math.min(c.arriveDay ?? nextDay, nextDay);
        } else if (Number.isFinite(rep.etaDays) && rep.etaDays > 0.35) {
          c.arriveDay = Math.max(nextDay + 0.25, curDay + rep.etaDays);
          rep.etaDays = Math.max(0, rep.etaDays - 1);
        }
      } else if (storm && c.sea) {
        c.arriveDay = (c.arriveDay ?? nextDay) + 1;
      }
    }

    const rbArr = W.riverBoats || [];
    for (let i = rbArr.length - 1; i >= 0; i--) {
      const b = rbArr[i];
      if (!b) continue;
      const rep = MARITIME_PILOT.riverBoats.get(String(b.id)) || null;
      if (rep?.sunk || b.sunk) {
        rbArr.splice(i, 1);
        MARITIME_PILOT.riverBoats.delete(String(b.id));
        continue;
      }
      if (rep) {
        if (rep.progress >= 0.98 || (Number.isFinite(rep.etaDays) && rep.etaDays <= 0.15)) {
          b.arriveDay = Math.min(b.arriveDay ?? nextDay, nextDay);
        } else if (Number.isFinite(rep.etaDays) && rep.etaDays > 0.35) {
          b.arriveDay = Math.max(nextDay + 0.25, curDay + rep.etaDays);
          rep.etaDays = Math.max(0, rep.etaDays - 1);
        }
      } else if (storm) {
        b.arriveDay = (b.arriveDay ?? nextDay) + 0.35;
      }
    }
  }

  async function live(days) {
    for (let i = 0; i < days; i++) {
      await STORAGE_OUTCOMES.wait();
      applyMaritimePilotBeforeTick();
      if (simTick() === false) throw new Error('The model would not take a day');
      ensureMaritimeWorldRoutes();
      if ((i + 1) % 8 === 0) await STORAGE_OUTCOMES.journal.flush();
    }
    await STORAGE_OUTCOMES.journal.flush(); await STORAGE_OUTCOMES.wait();
    return board();
  }

  // The whole world, frozen: the model's own save of every thing it holds (ground, places, people, great houses,
  // armies, ships, abbeys, ledgers, the dice and the annals), zipped. Nothing is chosen from it: what this game
  // has no use for today is kept with the rest.
  async function freeze() {
    if (!program()) throw new Error('A world is frozen only by a host that names its program');
    await STORAGE_OUTCOMES.journal.flush(); await STORAGE_OUTCOMES.wait();
    return worldSaveZip(await worldSave({ sourceSHA256: program() }));
  }
  // A frozen world taken up in a fresh realm, in place of a founding: its days go on from the day it was frozen.
  async function thaw(bytes) {
    if (!program()) throw new Error('A world is taken up only by a host that names its program');
    STORAGE_OUTCOMES.journal = journal();
    await worldLoad(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { sourceSHA256: program(), outcomeJournal: STORAGE_OUTCOMES.journal });
    ensureMaritimeWorldRoutes({ force: true });
    return board();
  }

  // The model's own keeper: its SimulationWorkerHost over its own simulationWorkerModel, as the source's page is
  // served by its worker. Every request that page can make is answered here the same way (init, view, command,
  // watch, advance, speed, pause, save, flush, close), so every view and every command the source has is this
  // game's: the display record of the whole world, the inspector of any thing in it, its panels, its people as
  // they walk, its overlays, and all a player may order. Only the first step differs: a realm is founded on this
  // game's ground, or a frozen world is taken up ({world: bytes}).
  let keeper = null;
  function serve(send) {
    if (keeper) return keeper;
    const channel = new MessageChannel(), tasks = new Map();
    let next = 0;
    channel.port1.onmessage = ({ data }) => { const task = tasks.get(data); if (!task) return; tasks.delete(data); task.fn(); };
    const schedule = (fn, ms) => { const id = ++next, task = { fn, timer: null }; tasks.set(id, task); if (ms) task.timer = setTimeout(() => channel.port2.postMessage(id), ms); else channel.port2.postMessage(id); return id; };
    const cancel = (id) => { const task = tasks.get(id); if (task && task.timer !== null) clearTimeout(task.timer); tasks.delete(id); };
    const model = simulationWorkerModel();
    const baseTick = model.tick;
    model.tick = () => {
      applyMaritimePilotBeforeTick();
      const res = baseTick();
      if (res !== false) ensureMaritimeWorldRoutes();
      return res;
    };
    model.init = async (payload, progress) => {
      if (payload.world) await thaw(payload.world);
      else if (!W) await found(payload, progress);
      WORKER_PRESENTATION.started = true;
    };
    const baseView = model.view;
    model.view = (kind, payload = {}) => {
      if (kind === 'ui' && payload?.panel === 'advisor-inspect') {
        const codeStr = String(payload?.code || '');
        if (/^p\d+$/.test(codeStr)) {
          const pid = Number(codeStr.slice(1));
          if (pid >= 2_000_000) {
            const partnerAns = buildPartnerPersonInspect(pid);
            if (partnerAns) return partnerAns;
          }
        }
      }
      if (kind === 'inspect') {
        const codeStr = String(payload?.code || '');
        if (codeStr.startsWith('ship:') || /^sh\d+$/.test(codeStr)) {
          const shId = Number(codeStr.startsWith('ship:') ? codeStr.slice(5) : codeStr.slice(2));
          const sh = (W?.ships || []).find((q, idx) => q && (q.id === shId || idx === shId));
          if (sh) {
            staffOceanShip(sh);
            const portName = W.settlements?.[sh.port ?? 0]?.name || 'Lisboa';
            const mid = sh.berth || sh.poly?.[Math.floor((sh.poly.length - 1) / 2)] || { x: 0, z: 0 };
            const crewNames = Array.isArray(sh.crew) ? sh.crew.map((m) => `${m.name} (${m.role})`).join(', ') : '';
            return {
              targetType: 'ship',
              title: `${sh.shipName || 'Merchant Vessel'} (${sh.kind || 'cog'})`,
              sub: `Master: ${sh.captain?.name || sh.master} · Supercargo: ${sh.merchant?.name || 'Factor'} · Home port: ${sh.homePort || sh.from}`,
              body: `<p>${sh.tonnage || 180}-ton ${sh.kind || 'vessel'} out of ${sh.homePort || sh.from} (${sh.phase === 'dock' ? 'anchored at ' + portName : sh.phase === 'out' ? 'outbound to ' + (sh.to || sh.homePort) : 'inbound to ' + portName}). Cargo: ${formatCargoBrief(sh.phase === 'out' && Object.keys(sh.load || {}).length ? sh.load : sh.cargo)}. Deck complement: ${crewNames}.</p>`,
              actions: '',
              anchor: { x: r1(mid.x), z: r1(mid.z) },
            };
          }
        }
      }
      if (kind === 'inspect' && String(payload?.code || '').startsWith('rb')) {
        const rbKey = String(payload.code);
        const rbId = Number(rbKey.slice(2));
        const b = (W?.riverBoats || []).find((q) => q && !q.sunk && (q.id === rbId || String(q.key) === rbKey));
        if (b) {
          const home = W.settlements?.[b.si]?.name || 'Harbor';
          const dest = W.settlements?.[b.destSi]?.name || home;
          const mid = b.points?.[Math.floor((b.points.length - 1) / 2)] || b.points?.[0] || { x: 0, z: 0 };
          const oarNames = Array.isArray(b.oarsmen) && b.oarsmen.length ? b.oarsmen.map((o) => o.name).join(', ') : '4 hired oarsmen';
          return {
            targetType: 'riverBoat',
            title: `River Barge #${b.id}`,
            sub: `Pilot: ${b.pilot?.name || 'Barqueiro'} (${b.pilot?.trade || 'boatman'}) · ${home} ↔ ${dest}`,
            body: `<p>Manned river barge plying reach ${b.riverIdx + 1} between ${home} and ${dest}. Crew: ${oarNames}.</p>`,
            actions: '',
            anchor: { x: r1(mid.x), z: r1(mid.z) },
          };
        }
      }
      const res = baseView(kind, payload);
      if ((kind === 'bootstrap' || kind === 'landscape') && res && res.world) {
        res.world = { ...res.world, riverBoats: riverBoats() };
      }
      return res;
    };
    keeper = new SimulationWorkerHost(model, (message) => send(message, presentationTransfers(message)), { schedule, cancel });
    JOURNAL_WATCH = () => keeper.journal();
    return keeper;
  }

  // Who is about in a place today and where each goes, by the model's own plan of its townsfolk (the plan its own
  // screen walks): the `most` people who live nearest `focus`, each with the way they take along the model's
  // streets, out of their door and in at the other end. On the Lord's day they go to mass; those who work at home
  // go out on an errand; the rest go to their work, in a shop, a field, the wood or at the water. `others` more of
  // the place's grown people are named besides, those of the waterside first, for whoever else is seen about.
  // Nothing is changed by looking.
  // The model keeps the graph of a place's streets on the place, made anew whenever it is asked for and the streets
  // have changed: its own scratch, which its save writes. The one made for this asking is kept here instead and lent
  // back for the next, and the place is left with whatever it had, so the world is to the byte what it was.
  const STREET_GRAPHS = new WeakMap();
  const WATERSIDE = new Set(['boatman', 'fisher', 'merchant', 'carter', 'shipwright', 'roper', 'salter', 'cooper', 'spicer', 'chandler']);
  function folk(si, options = {}) {
    const s = W.settlements?.[si];
    if (!s || !Array.isArray(s.folk)) return { si, day: day(), date: dateStr(day()), sunday: false, people: [], others: [] };
    const graphed = Object.hasOwn(s, '_sg'), theirs = s._sg;
    if (STREET_GRAPHS.has(s)) s._sg = STREET_GRAPHS.get(s);
    try { return folkOf(s, si, options); } finally {
      if (Object.hasOwn(s, '_sg')) STREET_GRAPHS.set(s, s._sg);
      if (graphed) s._sg = theirs; else delete s._sg;
    }
  }
  function folkOf(s, si, { focus = null, most = 160, others = 0 }) {
    const options = globalThis.FURLONG_OPTIONS.board, eye = cam.cur.focus, colour = Object.getOwnPropertyDescriptor(globalThis, 'THREE');
    class PlanColour { constructor(hex = 0xffffff) { this.hex = hex >>> 0; this.gain = 1; } multiplyScalar(v) { this.gain *= Number.isFinite(v) ? v : 1; return this; } }
    let plan;
    try {
      cam.cur.focus = focus && Number.isFinite(focus.x) && Number.isFinite(focus.z) ? { x: focus.x, z: focus.z } : { x: s.pos.x, z: s.pos.z };
      options.abroad = Math.max(1, Math.min(4000, most | 0));
      if (!colour) globalThis.THREE = { Color: PlanColour };
      plan = townsfolkFor(s);
    } finally {
      cam.cur.focus = eye; delete options.abroad;
      if (!colour) delete globalThis.THREE;
    }
    const sunday = day() % 7 === 0, planned = new Set(), people = [];
    // A child's calling on the model's record is the household's; they have none of their own yet.
    const soul = (p) => ({ id: p.id, name: folkName(p), surname: famName(p), sex: p.sx || null, age: r1(ageYrs(p)), role: ageYrs(p) >= 14 ? p.tr || null : null });
    for (const c of plan) {
      const p = c.p, walker = { ...c };
      let to = c.work, goal = 'work', there = c.what, open = !c.workIn;
      if (sunday && c.church && ageYrs(p) >= 6) { to = c.church; goal = 'church'; there = 'at mass'; open = false; }
      else if (c.chores) {
        const shop = c.shops?.length ? c.shops[p.id % c.shops.length] : null;
        to = shop ? { x: shop.x, z: shop.z } : c.mk; goal = 'errand'; open = !shop;
        there = shop ? `at the ${ARCH[shop.arch]?.[4] ?? shop.arch}` : 'at the market';
      } else if (ageYrs(p) < 14) goal = 'play';
      planWalk(walker, to, goal);
      const route = [];
      for (const q of walker.route) route.push(r1(q.x), r1(q.z));
      // Out of doors the work is a beat: up the furrow and back, from tree to tree, about the lane at play.
      if (goal !== 'church' && goal !== 'errand' && c.fw) route.push(r1(c.fw.B.x), r1(c.fw.B.z));
      planned.add(p.id);
      people.push({ ...soul(p), goal, there, via: walker.via || '', open, run: Boolean(c.fw?.run), pace: r3(c.pace / 2), home: [r1(c.home.x), r1(c.home.z)], route });
    }
    const rest = others > 0 ? s.folk.filter((p) => !p.dead && !planned.has(p.id) && ageYrs(p) >= 16 && ageYrs(p) < 66 && !awayNow(p)) : [];
    rest.sort((a, b) => WATERSIDE.has(b.tr) - WATERSIDE.has(a.tr) || a.id - b.id);
    return { si, day: day(), date: dateStr(day()), sunday, people, others: rest.slice(0, others).map(soul) };
  }

  // The soldiers of a place, by the model's own rolls: whoever holds the place for its lord, then the men of any host
  // sheltering within it (the model's own rule: a host of the place's lord, or of his friends, lying idle there; each
  // host keeps its roll by name: the sworn men of a household, those called to arms, and sell-swords), then its watch.
  // The model keeps a watch as a number and pays it by the month: its posts are taken by the householders under fifty
  // whose own work earns them less than a watchman's wage, the poorest first, and the rest by the other young
  // householders of the place (the model's payWatch), who are named here as their turn comes round by the month. The
  // first `most` are named. Asking makes nothing but the roll of households the model's own next day makes, and its
  // days go on as they would have.
  const HOLDS = ['sheriff', 'warden', 'bailiff', 'steward'];
  const turnOf = (id, month) => { let h = (Math.imul(id | 0, 2654435761) ^ Math.imul((month | 0) + 1, 40503)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; return (h ^ (h >>> 13)) >>> 0; };
  function watch(si, { most = 60 } = {}) {
    const s = W.settlements?.[si], today = day(), men = [], seen = new Set(), hosts = [];
    const answer = (more = {}) => ({ si, day: today, date: dateStr(today), garrison: Math.max(0, Math.round(s?.garrison || 0)), militia: Math.max(0, Math.round(s?.militia || 0)), captain: null, hosts, men, ...more });
    if (!s) return answer();
    const soul = (p, more) => ({ id: p.id, name: folkName(p), surname: famName(p), sex: p.sx || null, age: r1(ageYrs(p)), role: p.tr || null, ...more });
    const take = (p, more) => { if (!p || p.dead || seen.has(p.id) || men.length >= most) return false; seen.add(p.id); men.push(soul(p, more)); return true; };
    const holder = (s.folk || []).filter((p) => !p.dead && HOLDS.includes(officeHeld(p))).sort((a, b) => HOLDS.indexOf(a.office) - HOLDS.indexOf(b.office) || a.id - b.id)[0] || null;
    const captain = holder ? soul(holder, { of: 'office', office: officeTitle(holder) }) : null;
    if (holder) seen.add(holder.id);
    for (const a of W.armies || []) {
      if (a.gone || a.field || a.at !== si || (a.state !== 'idle' && a.state !== 'arrived') || !friendlyTown(a, s)) continue;
      const lead = a.commander != null ? notableById(a.commander) : null;
      hosts.push({ name: a.name || '', house: a.house ?? -1, men: a.men?.length || Math.round(a.strength) || 0, standing: Boolean(a.standing), commander: lead ? lead.name || '' : '' });
      for (const p of a.men || []) take(p, { of: 'host', host: a.name || '', hired: Boolean(p.merc) });
    }
    const posts = Math.max(0, Math.round(s.garrison || 0));
    if (posts && Array.isArray(s.folk) && men.length < most) {
      const young = heads_(s, (q) => ageYrs(q) < 50), wage = watchPay(s) / posts, takers = [];
      for (const h of young) { const A = householdAccount(h), earn = (A && A.assets._incY != null ? A.assets._incY : tradeIncome(s, h.tr)) / 12; if (earn < wage) takers.push([earn, h]); }
      takers.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);
      const first = takers.slice(0, posts).map((t) => t[1]), month = Math.floor(today / 30);
      for (const h of first) take(h, { of: 'watch' });
      if (first.length < posts && men.length < most) {
        const others = young.filter((h) => !first.includes(h)).map((h) => [turnOf(h.id, month), h]).sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);
        for (const [, h] of others.slice(0, posts - first.length)) if (!take(h, { of: 'watch' }) && men.length >= most) break;
      }
    }
    return answer({ captain });
  }
  // A place's roll as its record keeps it: the men a port's own posts are manned from when its land is laid.
  const WATCH_KEPT = 96;
  const watchKept = (si) => { const { garrison, militia, captain, hosts, men } = watch(si, { most: WATCH_KEPT }); return garrison || hosts.length || captain ? { garrison, militia, captain, hosts, men } : null; };

  const castle = (s) => {
    const out = {};
    if (s.hillCastle) { const c = s.hillCastle; out.hill = { x: r1(c.x), z: r1(c.z), r: r1(c.r), walls: c.walls, height: r1(c.wallHeight ?? 0), rad: list(c.wallRad), kind: list(c.wallKind, Number), gate: r3(c.gateA ?? 0), timber: Boolean(c.timber) }; }
    if (s.motte) { const m = s.motte; out.motte = { x: r1(m.x), z: r1(m.z), r: r1(m.r), summit: r1(m.summitR), height: r1(m.height ?? 0), gate: r3(m.gateA ?? 0) }; }
    if (s.bailey) { const b = s.bailey; out.bailey = { x: r1(b.x), z: r1(b.z), r: r1(b.r), rad: b.wallRad ? list(b.wallRad) : null }; }
    if (s.citadel && !s.citadel.razed) { const c = s.citadel; out.citadel = { x: r1(c.x), z: r1(c.z), size: r1(c.S), turn: r3(c.rot ?? 0), rad: c.wallRad ? list(c.wallRad) : null, gate: r3(c.gateA ?? 0) }; }
    if (s.keepPos) out.keep = { x: r1(s.keepPos.x), z: r1(s.keepPos.z) };
    return Object.keys(out).length ? out : null;
  };

  // The quarters of a town the model sets a building in; anything else (a farm, a castle's own) is the first.
  const QUARTERS = ['', 'residential', 'artisan', 'market'];
  // How a building stands: whole, a roofless ruin, alight, or a heap.
  const STANDINGS = ['sound', 'ruin', 'burning', 'rubble'];

  function board() {
    const places = W.settlements.map((s, at) => ({
      name: s.name, kind: s.kind, role: s.role, culture: s.cult, people: Math.round(s.pop), x: r1(s.pos.x), z: r1(s.pos.z),
      radius: r1(s.radius || 0), reach: r1(s.extentR || 0), paved: r1(s.paveR || 0), harbour: Boolean(s.harbor), river: Boolean(s.river),
      founded: s.origin ? { kind: s.origin.kind, year: s.origin.foundedAD, layout: s.origin.layout } : null, layout: s.mode || null,
      walls: s.walls || 0,
      wall: s.wallRad ? { rad: list(s.wallRad), kind: list(s.wallKind, Number), gates: list(fortGateAngles(s, s), r3), bastions: Boolean(s.bastions), roman: Boolean(s.romanWall),
        // A circuit still going up: which of its stretches stand so far.
        ...(s.wallBuild ? { built: list(s.wallRad, (_, k) => wallBuilt(s, k / s.wallRad.length * 2 * Math.PI) ? 1 : 0) } : {}) } : null,
      castle: castle(s),
      streets: s.streets.filter((t) => !t.hidden && !t.gone && t.kind !== 'edge' && t.pts.length > 1).map((t) => ({ kind: t.kind, half: r1(t.hw), points: line(t.pts) })),
      squares: (s.places || []).map((p) => ({ kind: p.kind || 'market', x: r1(p.x), z: r1(p.z), rad: list(p.r) })),
      past: (s.history || []).filter((h) => h.ad !== undefined).map((h) => [h.ad, h.t]),
      // Who mans it: whoever holds it, the hosts within it and the first of its watch, by name (`watch`).
      watch: watchKept(at),
      // Its standing herds on the pastures and mast-woods, and any dammed pond raised on its stream.
      herds: {
        sheep: Math.max(0, Math.round(s.stores?.sheep || 0)),
        cattle: Math.max(0, Math.round(s.stores?.cattle || 0)),
        horses: Math.max(0, Math.round(s.stores?.horses || 0)),
        swine: Math.max(0, Math.round(s.stores?.swine || 0)),
      },
      pond: s.lake && s.lake.poly?.length > 2 && s.lake.dam ? {
        level: r1(s.lake.y), area: Math.round(s.lake.area || 0), points: line(s.lake.poly),
        dam: {
          x: r1(s.lake.dam.x), z: r1(s.lake.dam.z), angle: r3(s.lake.dam.a), width: r1(s.lake.dam.w),
          lo: r1(s.lake.dam.lo ?? -s.lake.dam.w / 2), hi: r1(s.lake.dam.hi ?? s.lake.dam.w / 2), bed: r1(s.lake.dam.bed ?? 0),
        },
      } : null,
    }));
    const stand = [], form = [], kinds = [], quarter = [], standing = new Map(), state = [], wheels = [], yards = [];
    W.settlements.forEach((s, at) => {
      for (const b of s.buildings) {
        if (b.removed || b.state === 'gone') continue;
        standing.set(b, kinds.length / 6);
        stand.push(r1(b.x), r1(b.z), r3(b.rot), r1(b.w), r1(b.d), r1(b.h));
        // To its street, as a unit vector; and whether a church has a tower or a spire.
        form.push(r3(b.fx ?? 0), r3(b.fz ?? 0), r3(b.hue ?? 0));
        kinds.push(at, ARCHES.indexOf(b.arch), b.tier | 0, b.roof | 0, b.ch ? (b.cathedral ? 3 : b.ch.spire ? 2 : b.ch.tower ? 1 : 0) + (b.ch.stone ? 4 : 0) : 0, b.shed ? 1 : 0);
        quarter.push(Math.max(0, QUARTERS.indexOf(b.district)));
        state.push(Math.max(0, STANDINGS.indexOf(b.state)));
        // A mill's wheel stands in its water; a church's yard lies beside it with its graves.
        if (b.millWater) wheels.push(kinds.length / 6 - 1, r1(b.millWater.x), r1(b.millWater.z));
        const yard = b._graveyard;
        if (yard && !yard.removed && yard.poly?.length > 2) yards.push({ church: kinds.length / 6 - 1, graves: typeof graveyardBurials === 'function' ? graveyardBurials(s, b).length : 0, points: line(yard.poly) });
      }
    });
    // Every cell of the model's ground where wood still stands (2 bits/cell: 0 open, 1 forest, 2 upland pine, 3 scrub).
    // In Castle and Commons, unclaimed B.FOREST/B.PINE wilderness, steep LK.NONE woods, LS.WOOD timber furlongs, and
    // steep/wet corners (mask[c*4] === 0) keep their dense trees; plough and pasture clear only workable ground.
    const cellCount = GRID * GRID, woodBytes = new Uint8Array(Math.ceil(cellCount / 4));
    const fDry = new Uint32Array(W.land?.F?.length || 0), fWood = new Uint32Array(W.land?.F?.length || 0);
    const mask = W.land?.mask;
    for (let cz = 0; cz < GRID; cz++) for (let cx = 0; cx < GRID; cx++) {
      const c = cIdx(cx, cz), bio = W.biome[c];
      if (bio === B.WATER || W.water[c]) continue;
      const mx = cellX(cx), mz = cellZ(cz), f = W.land?.F ? furlongAt(mx, mz) : null;
      if (f) fDry[f.k]++;
      if (W.roadCells[c] || W.settlements.some((s) => dist2d(mx, mz, s.pos.x, s.pos.z) < (s.wallR || s.extentR || s.radius || 60) * 1.12)) continue;
      const wooded = bio === B.FOREST || bio === B.PINE || f?.state === LS.WOOD;
      if (!wooded) continue;
      const arable = Boolean(mask && mask[c * 4] > 0 && f && f.kind !== LK.NONE);
      let code = 0;
      if (arable && (f.state === LS.TILLED || f.state === LS.PASTURE || f.state === LS.BURNT)) code = 0;
      else if (arable && f.state === LS.SCRUB) code = 3;
      else code = bio === B.PINE ? 2 : 1;
      if (!code) continue;
      woodBytes[c >> 2] |= (code & 3) << ((c & 3) * 2);
      if (f && (code === 1 || code === 2)) fWood[f.k]++;
    }
    let woodText = '';
    for (let k = 0; k < woodBytes.length; k += 0x8000) woodText += String.fromCharCode.apply(null, woodBytes.subarray(k, k + 0x8000));
    const woods = btoa(woodText);
    // Every tree of the model's open country and scrub that still stands outside dense wood: four numbers each
    // (x, z, size, and 0 broadleaf, 1 pine, 2 small tree of hedge, marsh or regenerating scrub).
    const loneTrees = [];
    if (W.treeSpots) {
      const KINDS = ['dec', 'pine', 'small'];
      for (let kindCode = 0; kindCode < KINDS.length; kindCode++) {
        for (const t of W.treeSpots[KINDS[kindCode]] || []) {
          if (t.cut) continue;
          const f = W.land?.F ? furlongAt(t.x, t.z) : null;
          if (f && treeGone(f, t)) continue;
          const cx = toCell(t.x), cz = toCell(t.z);
          if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) continue;
          const c = cIdx(cx, cz);
          if (W.biome[c] === B.WATER || W.water[c] || W.roadCells[c]) continue;
          const code = (woodBytes[c >> 2] >> ((c & 3) * 2)) & 3;
          if (code === 1 || code === 2) continue;
          loneTrees.push(r1(t.x), r1(t.z), Math.round((t.s || 1) * 100) / 100, kindCode);
        }
      }
    }
    // Every furlong of the ground, held or not: whose it is (-1 no one's), what it is held as, what stands on it.
    const fields = [];
    for (const f of W.land.F) {
      const poly = f.poly || computeFurlongPoly(f);
      if (!poly || poly.length < 3) continue;
      const wood = f.state === LS.WOOD ? 1 : fDry[f.k] > 0 ? fWood[f.k] / fDry[f.k] : 0;
      fields.push({ place: f.dom, kind: f.kind, state: f.state, wood: r3(wood), heading: r3(f.th ?? 0), strip: r1(f.w ?? 0), x: r1(f.x), z: r1(f.z), points: line(poly) });
    }
    // The people, six to a soul: place, given name, family, sex and age in years, trade, and the house they keep
    // (an index into the buildings, -1 if none stands). Names and trades are told once and pointed to.
    const given = [], families = [], trades = [], souls = [];
    const point = (table, word) => { let k = table.indexOf(word); if (k < 0) { k = table.length; table.push(word); } return k; };
    W.settlements.forEach((s, at) => {
      for (const p of s.folk || []) {
        if (p.dead) continue;
        const home = householdHead(p)?.bh || null;
        souls.push(at, point(given, p.gn || ''), point(families, W.fams?.[p.fam]?.n || ''), (p.sx === 'f' ? 1000 : 0) + Math.max(0, Math.min(999, Math.floor(ageYrs(p)))),
          point(trades, p.tr || ''), home && standing.has(home) ? standing.get(home) : -1);
      }
    });
    return {
      version: VERSION, span: SIZE, grid: GRID, cell: CELL, year: AD(), day: W.clock.day, seed: SEED, fate: FATE, realm: W.name,
      places,
      arches: ARCHES,
      // Six numbers to a building for where it stands (x, z, turn, across, deep, to the eaves), three for its
      // face (the way to its street and its hue), six for what it is (place, arch, tier, roof, church, shed) and
      // one for its quarter of the town (`quarters`).
      quarters: QUARTERS,
      standings: STANDINGS,
      buildings: { count: kinds.length / 6, stand, form, kinds, quarter, state },
      // Whatever else the model has built or has standing on the ground, as its own scene would draw it: the fences
      // of worked furlongs (five numbers: from, to, and 1 for dry stone plus 2 along a lane), the bridges its tracks
      // cross water by (middle, heading, span, 1 for stone), mill wheels (building, where the wheel turns), churchyards,
      // memorial cairns, robbers' camps, hosts in the field and works in hand.
      works: {
        // A fence along a track stands two paces back from it, on its own furlong's side (as the model's own scene sets it).
        fences: workerFenceSegments().flatMap((f) => {
          let ax = f.a.x, az = f.a.z, bx = f.b.x, bz = f.b.z;
          if (f.lane) {
            const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L, side = (f.x - ax) * nx + (f.z - az) * nz > 0 ? 2 : -2;
            ax += nx * side; az += nz * side; bx += nx * side; bz += nz * side;
          }
          return [r1(ax), r1(az), r1(bx), r1(bz), (f.stone ? 1 : 0) + (f.lane ? 2 : 0)];
        }),
        trackBridges: (W.trackBridgePlan || []).flatMap((q) => [r1(q.mx), r1(q.mz), r3(q.ux), r3(q.uz), r1(q.span), q.isStone ? 1 : 0]),
        wheels, yards,
        memorials: (W.memorials || []).flatMap((m) => [r1(m.x), r1(m.z)]),
        camps: (W.banditCamps || []).flatMap((c) => [r1(c.x), r1(c.z), c.men?.length | 0]),
        armies: (W.armies || []).filter((a) => !a.gone).map((a) => { const at = armySimPos(a); return { name: a.name, house: a.house, men: a.men?.length || Math.round(a.strength) || 0, state: a.state, x: r1(at.x), z: r1(at.z) }; }),
        sites: (W.projects || []).filter((q) => !q.dead).map((q) => ({ kind: q.kind || q.type || '', title: q.title || '', place: q.si ?? -1, x: q.x ?? q.f?.x ?? q.site?.f?.x ?? q.site?.x ?? null, z: q.z ?? q.f?.z ?? q.site?.f?.z ?? q.site?.z ?? null }))
          .filter((q) => Number.isFinite(q.x) && Number.isFinite(q.z)).map((q) => ({ ...q, x: r1(q.x), z: r1(q.z) })),
      },
      roads: W.roads.map((q) => ({ from: q.a, to: q.b, points: line(q.drawn || q.path) })),
      rivers: (W.rivStrips || []).map((q) => ({ canal: Boolean(q.canal), points: q.pts.flatMap((p, i) => [r1(p.x), r1(p.z), r1(q.hw[i])]), levels: list(q.ys) })),
      lanes: workerTrackSegments().flatMap((t) => [r1(t.a.x), r1(t.a.z), r1(t.b.x), r1(t.b.z)]),
      // What a furlong is held as and what stands on it, in the model's own codes.
      fieldKinds: LK, fieldStates: LS,
      woods,
      loneTrees,
      fields,
      riverBoats: riverBoats(),
      people: souls.length / 6,
      souls: { given, families, trades, each: souls },
    };
  }

  // Someone of a place who goes to sea in the traveller's ship: the first mate (js/first-mate.js). They leave the
  // place's roll as the model's own travellers do: one of its travellers, bound for home, who does not arrive until
  // they are put ashore again. So the town neither counts them at their work nor buries them while they are gone, the
  // model's own card still knows them, and their place at home is held for them. Their household stays theirs, under
  // whoever of it is left (the model's own rule for one who leaves: the wife of a husband gone, else the eldest).
  // Unlike every other hook here this is an act: it is the player's, and the world goes another way from that day.
  const AT_SEA = 'at sea', SEA_DAYS = 360 * 100;
  const atSea = (p) => (W.travellers || []).find((t) => t.p === p && t.why === AT_SEA && !t.errand) || null;
  function embark(id) {
    const found = findPerson(id), p = found?.p;
    if (!p) throw new Error('The model knows no one of that number');
    if (p.dead) throw new Error(`${folkName(p)} is dead`);
    const gone = atSea(p);
    if (gone) return { id: p.id, name: folkName(p), home: gone.to, since: gone.depart, already: true };
    const si = p.si, s = W.settlements?.[si], index = Array.isArray(s?.folk) ? s.folk.indexOf(p) : -1;
    if (index < 0) throw new Error(`${folkName(p)} is not at home to be asked`);
    if (awayNow(p) || p.abbey != null || p.churchBody || p.outlawCampId || ageYrs(p) < 14) throw new Error(`${folkName(p)} is not free to go`);
    removeAt(s, index);
    const h = householdAccount(p);
    if (h && h.head === p) {
      const left = [...(h.members || [])].filter((q) => q !== p && !q.dead && q.si === si);
      if (left.length) h.head = left.find((q) => q.sx === 'f' && q.sp === p) || left.sort((a, b) => ageYrs(b) - ageYrs(a))[0];
    }
    p.si = -1;
    (W.travellers || (W.travellers = [])).push({ p, from: si, to: si, why: AT_SEA, poly: [{ x: s.pos.x, z: s.pos.z }, { x: s.pos.x, z: s.pos.z }], len: 0, depart: day(), arrive: day() + SEA_DAYS });
    householdHeadsChanged(s);
    life(p, `Went to sea from ${s.name} as a ship's mate`);
    return { id: p.id, name: folkName(p), home: si, since: day(), already: false };
  }
  // Put ashore at home again: back on its roll, in their own household.
  function disembark(id) {
    const T = W.travellers || [], index = T.findIndex((t) => t.p?.id === id && t.why === AT_SEA && !t.errand);
    if (index < 0) return { id, ashore: false };
    const t = T[index], p = t.p, s = W.settlements?.[t.to];
    if (!s) throw new Error('Their home is no more');
    T.splice(index, 1);
    p.si = t.to; (s.folk || (s.folk = [])).push(p); invalidateFolkIndex(); householdHeadsChanged(s);
    if (!p.dead) life(p, `Came home to ${s.name} from the sea`);
    return { id: p.id, name: folkName(p), home: t.to, ashore: true };
  }

  // Ocean-going foreign traders (cogs, hulks, carracks) currently approaching, docked at wharf/shore, or putting to sea.
  function ships() {
    const out = [];
    (W.ships || []).forEach((sh, index) => {
      if (!sh || !Array.isArray(sh.poly) || sh.poly.length < 2) return;
      const settlement = W.settlements?.[sh.port] || null;
      let portBerths = [];
      try {
        if (settlement && typeof berthsOf === 'function') {
          portBerths = berthsOf(settlement).map((b) => ({ x: r1(b.x), z: r1(b.z), rot: r3(b.rot || 0), shore: Boolean(b.shore) }));
        }
      } catch { portBerths = []; }
      if (!sh.captain || !sh.merchant || !Array.isArray(sh.crew) || !sh.crew.length) {
        staffOceanShip(sh);
      }
      out.push({
        id: sh.id ?? index,
        kind: String(sh.kind || 'cog'),
        shipName: String(sh.shipName || ''),
        homePort: String(sh.homePort || sh.from || ''),
        phase: String(sh.phase || 'in'),
        from: String(sh.from || ''),
        to: String(sh.to || ''),
        master: String(sh.captain?.name || sh.master || ''),
        captain: sh.captain ? { ...sh.captain } : null,
        merchant: sh.merchant ? { ...sh.merchant } : null,
        crew: Array.isArray(sh.crew) ? sh.crew.map((m) => ({ ...m })) : [],
        tonnage: Number(sh.tonnage || 0),
        place: sh.port ?? 0,
        t0: sh.t0 ?? 0,
        t1: sh.t1 ?? 0,
        until: sh.until ?? 0,
        waited: sh.waited ?? 0,
        bi: sh.bi ?? -1,
        berth: sh.berth ? { x: r1(sh.berth.x), z: r1(sh.berth.z), rot: r3(sh.berth.rot || 0), shore: Boolean(sh.berth.shore) } : null,
        portBerths,
        cargo: { ...(sh.cargo || {}) },
        load: { ...(sh.load || {}) },
        points: line(sh.poly),
      });
    });
    return out;
  }

  function resolvePlace(place = 0) {
    const ss = W.settlements || [];
    if (typeof place === 'number' && Number.isInteger(place) && ss[place]) return { s: ss[place], index: place };
    if (typeof place === 'string') {
      const needle = place.trim().toLowerCase();
      const idx = ss.findIndex((s) => String(s?.name || '').toLowerCase() === needle);
      if (idx >= 0) return { s: ss[idx], index: idx };
    }
    return ss[0] ? { s: ss[0], index: 0 } : { s: null, index: -1 };
  }

  // Live settlement commodity prices, stores, and offered supply from Castle & Commons' market model.
  function market(place = 0) {
    const { s, index } = resolvePlace(place);
    if (!s) return null;
    const cw = W.coinWeight || 1;
    const closed = typeof closedToTrade === 'function' ? Boolean(closedToTrade(s)) : false;
    const goods = {};
    for (const g of GOODS) {
      const p = price(s, g);
      const base = GOODBASE[g] || 1;
      const store = Math.max(0, Number(s.stores?.[g]) || 0);
      const onMarket = typeof avail === 'function' ? Math.max(0, Number(avail(s, g, p * 4)) || 0) : store;
      const atPrice = typeof avail === 'function' ? Math.max(0, Number(avail(s, g, p)) || 0) : store;
      const needMonth = Math.max(0, (s.pop || 0) * (NEED[g] || 0) * 30);
      goods[g] = {
        price: +p.toFixed(4),
        base: +base.toFixed(4),
        store: +store.toFixed(2),
        avail: +atPrice.toFixed(2),
        onMarket: +onMarket.toFixed(2),
        needMonth: +needMonth.toFixed(2),
      };
    }
    return {
      day: day(),
      place: index,
      name: String(s.name || ''),
      kind: String(s.kind || ''),
      pop: Math.round(s.pop || 0),
      prosperity: +(s.prosperity || 0).toFixed(2),
      coinWeight: +cw.toFixed(4),
      closed,
      goods,
    };
  }

  // Execute a foreign-trader buy/sell against the live settlement ledger (matching tickShips / tickShipDepartures).
  function trade(order = {}) {
    const { s, index } = resolvePlace(order.place ?? 0);
    const good = String(order.good || '');
    const qty = Number(order.qty);
    const act = order.act === 'sell' ? 'sell' : 'buy';
    if (!s || !GOODS.includes(good) || !(qty > 0)) {
      return { ok: false, reason: 'Invalid settlement, good, or quantity', market: s ? market(index) : null };
    }
    if (typeof closedToTrade === 'function' && closedToTrade(s)) {
      return { ok: false, reason: `${s.name} is closed to trade`, market: market(index) };
    }
    const base = GOODBASE[good] || 1;
    const curPrice = price(s, good);
    const depth = Math.max(12, (Number(s.stores?.[good]) || 0) + (s.pop || 0) * (NEED[good] || 0) * 3 + 18);
    if (act === 'buy') {
      const capPrice = Number.isFinite(order.maxPrice) ? order.maxPrice : curPrice * 1.5;
      const paid = purchase(s, good, 'out', qty, capPrice);
      const got = Number(purchase.got) || 0;
      if (got <= 0) {
        return { ok: false, qty: 0, paid: 0, unitPrice: curPrice, reason: 'None offered at that price', market: market(index) };
      }
      if (s.storage && (typeof BEASTS === 'undefined' || !BEASTS.includes(good))) {
        storageConsumePurchased(s, 'out', good, got, 'foreign-export');
      } else {
        s.stores[good] = Math.max(0, (s.stores[good] || 0) - got);
      }
      if (typeof lordAcct === 'function' && paid > 0) transfer('out', lordAcct(s), paid * 0.05, 'customs', s);
      const nextPrice = Math.min(base * 4.5, Math.max(base * 0.25, curPrice * Math.exp(0.22 * Math.tanh(got / depth))));
      (s.px || (s.px = {}))[good] = nextPrice;
      return { ok: true, act, good, qty: +got.toFixed(3), paid: +paid.toFixed(2), unitPrice: +(paid / got).toFixed(4), market: market(index) };
    }
    const minRes = Number.isFinite(order.minPrice) && order.minPrice > 0 ? order.minPrice : base / (W.coinWeight || 1) * 0.7;
    s.stores[good] = (s.stores[good] || 0) + qty;
    offer(s, good, 'out', qty, minRes);
    const gross = qty * curPrice;
    if (typeof lordAcct === 'function' && gross > 0) transfer('out', lordAcct(s), gross * 0.08, 'customs', s);
    s.tradeV = (s.tradeV || 0) + gross;
    const nextPrice = Math.min(base * 4.5, Math.max(base * 0.25, curPrice * Math.exp(-0.20 * Math.tanh(qty / depth))));
    (s.px || (s.px = {}))[good] = nextPrice;
    return { ok: true, act, good, qty: +qty.toFixed(3), paid: +gross.toFixed(2), unitPrice: +curPrice.toFixed(4), market: market(index) };
  }

  // The model's caravans on the road today: each load as it goes, by the route it takes and the days it left and is due.
  // Where one is on its way is no field of the model's: it is that share of its route, by the day (the model's polyPos).
  // `carts` is the model's own count of wagons for a load of that size (its display's spawnCarts).
  function harborFleet() {
    ensureMaritimeWorldRoutes();
    const lives = ensureMaritimeLivesStore();
    if (!Array.isArray(lives.harborFleet) || lives.harborFleet.length < 10) {
      const worldSeed = typeof SEED === 'number' ? SEED : 1550;
      const used = new Set();
      for (const sh of W?.ships || []) {
        if (sh?.captain?.id != null) used.add(sh.captain.id);
        if (sh?.merchant?.id != null) used.add(sh.merchant.id);
        for (const m of sh?.crew || []) if (m?.id != null) used.add(m.id);
      }
      const portName = W?.settlements?.[0]?.name || 'Lisboa';
      const slots = [
        { slot: 'roadstead:0', kind: 'carrack', duty: `anchored in the ${portName} roadstead discharging cargo` },
        { slot: 'roadstead:1', kind: 'great cog', duty: `riding at anchor off ${portName} awaiting customs clearance` },
        { slot: 'roadstead:2', kind: 'carrack', duty: `lying at moorings in ${portName} bay taking on ballast and wine` },
        { slot: 'roadstead:3', kind: 'great cog', duty: `anchored off ${portName} trading salt and spice` },
        { slot: 'harbor:0', kind: 'barque', duty: `plying ${portName} harbor lighterage between anchorage and quay` },
        { slot: 'harbor:1', kind: 'caravel', duty: `working coastal trade across ${portName} bay` },
        { slot: 'harbor:2', kind: 'barque', duty: `ferrying casks and bales across ${portName} roadstead` },
        { slot: 'harbor:3', kind: 'caravel', duty: `standing across ${portName} estuary under lateen canvas` },
        { slot: 'harbor:4', kind: 'barque', duty: `tending merchantmen anchored off ${portName}` },
        { slot: 'harbor:5', kind: 'caravel', duty: `running coastwise packets into ${portName}` },
      ];
      lives.harborFleet = slots.map((spec, idx) => {
        const port = PARTNER_REGISTRY.ports.length
          ? PARTNER_REGISTRY.ports[(idx + 2) % PARTNER_REGISTRY.ports.length]
          : null;
        const homePort = port?.name || ['Porto', 'Sevilla', 'Antwerp', 'Venice', 'Bordeaux'][idx % 5];
        const shipNames = port?.shipNames?.length ? port.shipNames : ['São Cristóvão', 'Nossa Senhora da Luz', 'Bom Jesus', 'Espírito Santo'];
        const shipName = shipNames[maritimeHash(worldSeed, idx + 307, 11) % shipNames.length];
        const pick = (list, salt, fbRole, fbName) => {
          if (Array.isArray(list) && list.length) {
            const start = maritimeHash(worldSeed, idx + 401, salt) % list.length;
            for (let k = 0; k < list.length; k++) {
              const cand = list[(start + k) % list.length];
              if (cand && !used.has(cand.id)) {
                used.add(cand.id);
                return cand;
              }
            }
            return list[start];
          }
          return fallbackPartnerSoul(70000 + idx * 23 + salt, fbName, fbRole, homePort, 33);
        };
        const captBase = pick(port?.captains, 17, 'shipmaster', `Master #${idx + 1}`);
        const merchBase = pick(port?.merchants, 31, 'merchant', `Factor #${idx + 1}`);
        const crewRoles = ['helmsman', 'lookout', 'bosun'];
        const crew = crewRoles.map((role, ci) => {
          const mBase = pick(port?.mariners, 53 + ci * 13, 'boatman', `Mariner #${ci + 1}`);
          touchMaritimePersonLife(mBase, {
            role,
            homePort,
            nowLine: `Now ${spec.duty} aboard ${shipName} (of ${homePort})`,
          });
          return {
            id: mBase.id, name: mBase.name, surname: mBase.surname || '', sex: mBase.sex || 'm',
            age: mBase.age || 27, role, trade: mBase.role || 'boatman', homePort, shipName,
          };
        });
        touchMaritimePersonLife(captBase, {
          role: 'shipmaster',
          homePort,
          nowLine: `Now commanding ${shipName} (of ${homePort}), ${spec.duty}`,
          initialLog: [`Commands ${spec.kind} ${shipName} out of ${homePort}, ${spec.duty}`],
        });
        touchMaritimePersonLife(merchBase, {
          role: 'merchant',
          homePort,
          nowLine: `Now supercargo aboard ${shipName} (of ${homePort}), ${spec.duty}`,
          initialLog: [`Supercargo aboard ${shipName} of ${homePort}, ${spec.duty}`],
        });
        return {
          slot: spec.slot,
          kind: spec.kind,
          shipName,
          homePort,
          captain: {
            id: captBase.id, name: captBase.name, surname: captBase.surname || '', sex: captBase.sex || 'm',
            age: captBase.age || 36, role: 'shipmaster', trade: captBase.role || 'boatman', homePort, shipName,
          },
          merchant: {
            id: merchBase.id, name: merchBase.name, surname: merchBase.surname || '', sex: merchBase.sex || 'm',
            age: merchBase.age || 34, role: 'merchant', trade: merchBase.role || 'merchant', homePort, shipName,
          },
          crew,
        };
      });
    }
    return lives.harborFleet.map((h) => ({
      slot: h.slot,
      kind: h.kind,
      shipName: h.shipName,
      homePort: h.homePort,
      captain: h.captain ? { ...h.captain } : null,
      merchant: h.merchant ? { ...h.merchant } : null,
      crew: Array.isArray(h.crew) ? h.crew.map((m) => ({ ...m })) : [],
    }));
  }

  function riverBoats() {
    ensureMaritimeWorldRoutes();
    const out = [];
    for (let i = 0; i < (W?.riverBoats || []).length; i++) {
      const b = W.riverBoats[i];
      if (!b || b.sunk || !Array.isArray(b.points) || b.points.length < 2) continue;
      const oarsList = Array.isArray(b.oarsmen) ? b.oarsmen : [];
      const oarsCount = oarsList.length ? oarsList.length : (Number.isFinite(b.oarsmen) ? b.oarsmen : 4);
      const homePort = W?.settlements?.[b.si ?? 0]?.name || 'Ribatejo';
      const shipName = b.shipName || `Barca do Tejo ${b.id ?? (i + 1)}`;
      out.push({
        id: b.id,
        key: b.key || `rb:${b.id}`,
        shipName,
        homePort,
        si: b.si ?? 0,
        destSi: b.destSi ?? b.si ?? 0,
        riverIdx: b.riverIdx ?? 0,
        phase: b.phase || 'shuttle',
        scale: Number.isFinite(b.scale) ? b.scale : 0.78,
        depart: b.departDay ?? day(),
        arrive: b.arriveDay ?? (day() + 3),
        oarsmen: Math.max(2, oarsCount),
        pilot: b.pilot ? {
          id: b.pilot.id,
          name: String(b.pilot.name || 'Barqueiro'),
          role: 'river pilot',
          settlementId: b.pilot.settlementId ?? b.si ?? 0,
          trade: String(b.pilot.trade || 'boatman'),
          homePort,
          shipName,
        } : null,
        crew: oarsList.map((o) => ({
          id: o.id,
          name: String(o.name || 'Remador'),
          role: 'oarsman',
          settlementId: o.settlementId ?? b.si ?? 0,
          trade: String(o.trade || 'boatman'),
          homePort,
          shipName,
        })),
        points: line(b.points),
      });
    }
    return out;
  }

  function caravans() {
    const out = [];
    (W.caravans || []).forEach((c, index) => {
      if (!c || c.gone || c.robbed || !Array.isArray(c.poly) || c.poly.length < 2) return;
      const mode = c.sea ? 'sea' : c.river ? 'river' : 'cart';
      let key = null;
      try { key = typeof caravanInspectionKey === 'function' ? String(caravanInspectionKey(c)) : null; } catch { key = null; }
      const entry = {
        key: key ?? `${c.origin}>${c.dest}:${c.departDay}:${c.good}`, index, mode, good: String(c.good ?? ''), qty: Math.round(c.qty || 0),
        origin: c.origin, dest: c.dest, depart: c.departDay, arrive: c.arriveDay, halted: !!c.halted,
        carts: mode === 'cart' ? Math.max(1, Math.min(4, Math.round((c.qty || 0) / 18))) : 1,
        points: line(c.poly),
      };
      if (mode === 'river') {
        const homePort = W?.settlements?.[c.origin ?? 0]?.name || 'Ribatejo';
        const shipName = c.shipName || `Barca #${index + 1}`;
        entry.shipName = shipName;
        entry.homePort = homePort;
        entry.pilot = c.pilot ? {
          id: c.pilot.id,
          name: String(c.pilot.name || 'Barqueiro'),
          role: 'river pilot',
          settlementId: c.pilot.settlementId ?? c.origin ?? 0,
          trade: String(c.pilot.trade || 'boatman'),
          homePort,
          shipName,
        } : null;
        entry.oarsmen = Math.max(2, Array.isArray(c.oarsmen) ? c.oarsmen.length : 4);
        entry.crew = Array.isArray(c.oarsmen) ? c.oarsmen.map((o) => ({
          id: o.id,
          name: String(o.name || 'Remador'),
          role: 'oarsman',
          settlementId: o.settlementId ?? c.origin ?? 0,
          trade: String(o.trade || 'boatman'),
          homePort,
          shipName,
        })) : [];
      } else if (mode === 'sea') {
        if (!c.captain || !c.merchant || !Array.isArray(c.crew) || !c.crew.length) {
          staffSeaCaravan(c, index);
        }
        entry.shipName = String(c.shipName || '');
        entry.homePort = String(c.homePort || '');
        entry.pilot = c.pilot ? { ...c.pilot } : (c.captain ? { id: c.captain.id, name: c.captain.name, settlementId: c.origin ?? 0, trade: 'shipmaster' } : null);
        entry.captain = c.captain ? { ...c.captain } : null;
        entry.merchant = c.merchant ? { ...c.merchant } : null;
        entry.crew = Array.isArray(c.crew) ? c.crew.map((m) => ({ ...m })) : [];
      }
      out.push(entry);
    });
    return {
      day: day(),
      weather: { state: String(W.weather?.state ?? 'clear'), wind: r3(W.weather?.wind ?? 0) },
      list: out,
      riverBoats: riverBoats(),
      ships: ships(),
      harborFleet: harborFleet(),
    };
  }

  return { VERSION, found, live, board, freeze, thaw, serve, folk, watch, embark, disembark, caravans, riverBoats, ships, market, trade, pilotMaritime };
})();
