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
    'Pero Álvares', 'Rui Gonçalves', 'Simão Lopes', 'Fernão Mendes',
    'Lopo Vaz', 'Martim Afonso', 'Álvaro Rodrigues', 'Gaspar Correia',
    'Tomé Pires', 'Diogo Ribeiro', 'Bastião Fernandes', 'Jorge Nunes',
  ];
  let maritimeMasterSeq = 0;
  function nextShipMaster() {
    const idx = maritimeMasterSeq++;
    const ports = Array.isArray(globalThis.PARTNER_PORTS_SEED?.ports) ? globalThis.PARTNER_PORTS_SEED.ports : [];
    if (ports.length) {
      const p = ports[idx % ports.length];
      const capts = p?.captains;
      if (Array.isArray(capts) && capts.length) {
        const c = capts[Math.floor(idx / ports.length) % capts.length];
        if (c?.name) return c.name;
      }
    }
    return SHIP_MASTERS[idx % SHIP_MASTERS.length];
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

  const NOTABLE_PERSON_BASE = 1_900_000;

  // Where a boat comes alongside a town. The model keeps the answer on the town (`s.landing`) the first time it is
  // asked for, which would change the world for a question that only looks at it, and the saved world with it: so
  // it is asked, and the town left as it was.
  function landingSeen(s) {
    if (typeof landingOf !== 'function') return null;
    const had = Object.prototype.hasOwnProperty.call(s, 'landing'), was = s.landing;
    const at = landingOf(s);
    if (!had) delete s.landing; else if (was === undefined) s.landing = undefined;
    return at;
  }

  function ensureMaritimeLivesStore() {
    if (!W) return { persons: {}, ships: {}, partnerMarkets: {} };
    if (!W.maritimeLives || typeof W.maritimeLives !== 'object') {
      W.maritimeLives = { persons: {}, ships: {}, partnerMarkets: {} };
    }
    if (!W.maritimeLives.persons) W.maritimeLives.persons = {};
    if (!W.maritimeLives.ships) W.maritimeLives.ships = {};
    if (!W.maritimeLives.partnerMarkets) W.maritimeLives.partnerMarkets = {};
    return W.maritimeLives;
  }

  function residentNotablesOf(si) {
    if (!W || !Array.isArray(W.notables)) return [];
    const s = W.settlements?.[si];
    if (!s) return [];
    const isCapital = si === 0 || s === W.capital;
    const out = [];
    for (const n of W.notables) {
      if (!n || !n.alive || n.role === 'Bandit King') continue;
      if ((W.armies || []).some((a) => a && !a.gone && a.commander === n.id)) continue;
      if (n.role === 'justice' && n.fp) {
        if (n.fp.si === si) out.push(n);
        continue;
      }
      if (n.house === 0) {
        if (isCapital) out.push(n);
        continue;
      }
      const H = W.houses?.[n.house];
      if (H && !H.exiled && H.seat === si && s.owner === n.house) {
        out.push(n);
      }
    }
    out.sort((a, b) => {
      const aMon = W.monarch?.id === a.id ? 0 : W.monarch?.spouse === a.id ? 1 : (W.houses?.[a.house]?.head === a.id ? 2 : 3);
      const bMon = W.monarch?.id === b.id ? 0 : W.monarch?.spouse === b.id ? 1 : (W.houses?.[b.house]?.head === b.id ? 2 : 3);
      return aMon - bMon || a.id - b.id;
    });
    return out;
  }

  // The court in its own people's words, where they have their own (the model's realmWays: a people of the Americas),
  // its chief at home in the house the model gives him (chiefSeat), named as the model names it. Else this game's
  // Lisbon, whose crown keeps court between the Paço da Ribeira and the Alcáçova.
  const courtWays = () => (typeof realmWays === 'function' ? realmWays() : null);
  const ruler = () => { const T = courtWays()?.titles; return T && W?.monarch ? T.monarch[W.monarch.sex === 'f' ? 1 : 0] : null; };
  const chiefLodging = (s, b) => (b ? buildingName(b) || `the ${ARCH[b.arch]?.[4] || b.arch} at ${s.name}` : s?.name || '');
  function notableRoleLabel(n) {
    if (!n) return 'courtier';
    const T = courtWays()?.titles, f = n.sex === 'f' ? 1 : 0;
    if (W?.monarch?.id === n.id) return T ? T.monarch[f] : f ? 'queen' : 'king';
    if (W?.monarch && W.monarch.spouse === n.id) return T ? `${f ? 'wife' : 'husband'} of the ${ruler()}` : f ? 'queen consort' : 'king consort';
    if (n.house === 0) {
      if (n.role && n.role !== 'heir' && n.role !== 'member') return T ? courtWord(String(n.role)) : String(n.role);
      if (W?.monarch && (n.father === W.monarch.id || n.mother === W.monarch.id)) {
        return T ? `${f ? 'daughter' : 'son'} of the ${ruler()}` : f ? 'infanta' : 'infante';
      }
      return T ? `of the ${ruler()}’s kin` : f ? 'court lady' : 'royal courtier';
    }
    if (W?.houses?.[n.house]?.head === n.id) return T ? T.head[f] : f ? 'lady' : 'lord';
    return T ? courtWord(String(n.role || (f ? 'kinswoman' : 'kinsman'))) : String(n.role || (f ? 'noblewoman' : 'nobleman'));
  }

  function buildNotablePersonInspect(notableId) {
    const n = typeof notableById === 'function' ? notableById(notableId) : (W?.notables || []).find((x) => x && x.id === notableId);
    if (!n) return null;
    const isMonarch = W?.monarch?.id === n.id;
    const isRoyal = n.house === 0;
    const houseName = isRoyal
      ? (W?.houses?.[0]?.name || `Royal House of ${W?.name || 'Portugal'}`)
      : (W?.houses?.[n.house]?.name || 'Noble House');
    const res = typeof notableResidence === 'function' ? notableResidence(n) : null;
    const s = res?.s || (isRoyal ? (W?.capital || W?.settlements?.[0]) : W?.settlements?.[W?.houses?.[n.house]?.seat ?? 0]) || W?.settlements?.[0];
    const si = s ? Math.max(0, W.settlements.indexOf(s)) : 0;
    const townName = s?.name || 'Lisboa';
    const role = notableRoleLabel(n);
    const titleStr = isMonarch && typeof fullTitle === 'function'
      ? fullTitle(n)
      : `${isMonarch ? (n.sex === 'f' ? 'Queen ' : 'King ') : ''}${n.name}${houseName && !String(n.name || '').includes(houseName) ? ' of ' + houseName : ''}`;
    const age = Math.max(1, Math.round(Number(n.age) || 32));
    const ways = courtWays(), chief = ruler(), f = n.sex === 'f' ? 1 : 0;
    const lodging = ways ? chiefLodging(s, res?.b) : (isRoyal && si === 0)
      ? 'Paço da Ribeira (Terreiro do Paço) & Alcáçova Keep'
      : (res?.b?.arch === 'keep' ? `${townName} Castle Keep` : `${townName} Manor Hall`);
    const treasuryCrowns = isRoyal
      ? Math.round(Number(W?.treasury) || 0)
      : Math.round(Number(W?.houses?.[n.house]?.gold) || 0);
    const links = [];
    const members = residentNotablesOf(si).slice(0, 8);
    const memberLines = [];
    for (const m of members) {
      const mPid = NOTABLE_PERSON_BASE + m.id;
      const mRole = notableRoleLabel(m);
      const mAge = Math.max(1, Math.round(Number(m.age) || 25));
      const mFull = m.id === W?.monarch?.id && typeof fullTitle === 'function' ? fullTitle(m) : m.name;
      memberLines.push(`${mFull} | ${mAge} | ${mRole} (${townName})`);
      if (m.id !== n.id) {
        links.push({ label: mFull, code: `p${mPid}` });
      }
    }
    const bornYr = (typeof AD === 'function' ? AD() : 1550) - age;
    const lifeLines = [`Born AD ${bornYr} into ${houseName}`];
    if (ways) {
      lifeLines.push(isMonarch ? `Raised ${ways.titles.monarch[f]} of ${W?.name || townName}, keeping council at ${lodging}`
        : isRoyal ? `Of the kin of ${W?.monarch ? fullTitle(W.monarch) : townName}, at ${lodging}` : `Of ${houseName}, at ${townName}`);
    } else if (isMonarch) {
      const num = W?.reignNum?.[n.name] || 1;
      lifeLines.push(`Crowned ${n.sex === 'f' ? 'Queen' : 'King'} ${n.name}${num > 1 ? ' (' + num + ')' : ''} of ${W?.name || townName}, holding court at the waterfront Paço da Ribeira on Terreiro do Paço and the hilltop Alcáçova Keep`);
    } else if (isRoyal) {
      lifeLines.push(`Attends the royal court of ${W?.monarch ? (typeof fullTitle === 'function' ? fullTitle(W.monarch) : W.monarch.name) : townName} between Paço da Ribeira and the Alcáçova Keep`);
    } else {
      lifeLines.push(`Holds noble seat at ${townName} (${houseName})`);
    }
    if (Array.isArray(n.life)) {
      for (const ev of n.life.slice(-5)) {
        const txt = typeof ev === 'string' ? ev : ev?.text;
        if (txt) lifeLines.push(String(txt));
      }
    }
    const nowLine = ways ? (isMonarch ? `Now keeping council at ${lodging}` : `Now at ${lodging}`) : isMonarch && si === 0
      ? `Now holding royal court at the waterfront Paço da Ribeira on Terreiro do Paço and ascending to the Alcáçova Keep above ${townName}`
      : isRoyal && si === 0
        ? `Now in royal attendance between the Paço da Ribeira (Terreiro do Paço) and the Alcáçova Keep`
        : `Now keeping noble residence at ${lodging}`;
    const card = [
      `${titleStr} — ${age}, ${isMonarch ? 'sovereign' : 'court'} · ${role} · ${townName}`,
      nowLine,
      `Lodging ${lodging}`,
      `Home ${lodging}`,
      `House ${houseName}`,
      `Treasury ${treasuryCrowns} crowns`,
      `Personal status ${ways ? (isMonarch ? `${ways.titles.monarch[f]} of ${W?.name || townName}` : isRoyal ? `Of the ${chief}’s kin` : 'Of a great house')
        : isMonarch ? 'Sovereign of the Realm' : isRoyal ? 'Royal Blood & Court' : 'Peer of the Realm'}`,
      `Household members`,
      `Person | Age | Place`,
      ...(memberLines.length ? memberLines : [`${n.name} | ${age} | ${townName}`]),
      `Life`,
      ...lifeLines,
    ].join('\n');
    return { kind: 'person', card, links };
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
      : pickUniqueFrom(port?.captains, 11, 'shipmaster', 'Pero Álvares');

    const existingMerch = sh.merchant?.id ? (PARTNER_REGISTRY.soulById.get(sh.merchant.id) || sh.merchant) : null;
    const merchBase = (existingMerch && existingMerch.id !== captBase.id && !usedPersonIds.has(existingMerch.id))
      ? (usedPersonIds.add(existingMerch.id), existingMerch)
      : pickUniqueFrom(port?.merchants, 23, 'merchant', 'Rui Gonçalves');

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

    const captBase = c.captain?.id ? (PARTNER_REGISTRY.soulById.get(c.captain.id) || c.captain) : pickFrom(port?.captains, 13, 'shipmaster', 'Simão Lopes');
    usedPersonIds.add(captBase.id);
    const merchBase = c.merchant?.id ? (PARTNER_REGISTRY.soulById.get(c.merchant.id) || c.merchant) : pickFrom(port?.merchants, 29, 'merchant', 'Fernão Mendes');
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
    const L = landingSeen(s);
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
  const PARTNER_BENCHMARKS = [
    { name: 'Sevilla', country: 'Castile', distanceNm: 265, g: { wine: 0.82, grain: 1.16, fish: 1.12, salt: 0.94, timber: 1.24, ore: 0.92, wool: 0.88, cloth: 1.18, tools: 1.15 } },
    { name: 'Porto', country: 'Portugal', distanceNm: 175, g: { wine: 0.74, grain: 1.08, fish: 0.82, salt: 0.86, timber: 0.84, ore: 0.98, wool: 0.96, cloth: 1.06, tools: 1.04 } },
    { name: 'Antwerp', country: 'Flanders', distanceNm: 980, g: { wine: 1.48, grain: 1.04, fish: 0.92, salt: 1.38, timber: 1.12, ore: 0.88, wool: 0.94, cloth: 0.72, tools: 0.78 } },
    { name: 'Venice', country: 'Venetia', distanceNm: 1860, g: { wine: 1.22, grain: 1.28, fish: 1.18, salt: 1.14, timber: 1.32, ore: 1.08, wool: 1.12, cloth: 0.86, tools: 0.84 } },
    { name: 'Bordeaux', country: 'Gascony', distanceNm: 690, g: { wine: 0.68, grain: 0.94, fish: 1.06, salt: 0.88, timber: 0.92, ore: 1.14, wool: 1.08, cloth: 1.12, tools: 1.10 } },
  ];
  const TELEMETRY_GOODS = ['grain', 'wine', 'fish', 'salt', 'timber', 'ore', 'wool', 'cloth', 'tools'];
  const PARTNER_MARKET_GOODS = [...TELEMETRY_GOODS, 'spice', 'silk'];

  function matchPartnerBenchmarkName(str, pbName) {
    const low = String(str || '').toLowerCase();
    if (!low) return false;
    if (low.includes(pbName.toLowerCase())) return true;
    if (pbName === 'Sevilla' && (low.includes('sevil') || low.includes('cádiz') || low.includes('cadiz'))) return true;
    if (pbName === 'Porto' && (low.includes('setúbal') || low.includes('setubal') || low.includes('coruña') || low.includes('coruna'))) return true;
    if (pbName === 'Antwerp' && (low.includes('bruges') || low.includes('lübeck') || low.includes('lubeck') || low.includes('bristol'))) return true;
    if (pbName === 'Venice' && (low.includes('genoa') || low.includes('goa') || low.includes('malacca'))) return true;
    return false;
  }

  function ensurePartnerMarkets(nowDay = day()) {
    const store = ensureMaritimeLivesStore();
    const cw = W?.coinWeight || 1;
    const farList = [...(Array.isArray(W?.farports) ? W.farports : []), ...(typeof FARPORTS !== 'undefined' && Array.isArray(FARPORTS) ? FARPORTS : []), ...EXTRA_FARPORTS];
    for (let pIdx = 0; pIdx < PARTNER_BENCHMARKS.length; pIdx++) {
      const pb = PARTNER_BENCHMARKS[pIdx];
      const reg = PARTNER_REGISTRY.byAlias.get(pb.name.toLowerCase()) || PARTNER_REGISTRY.ports[pIdx] || null;
      let pm = store.partnerMarkets[pb.name];
      if (!pm) {
        const pop = reg?.market?.pop || reg?.people || 2400;
        const fp = farList.find((f) => f?.n && matchPartnerBenchmarkName(f.n, pb.name)) || null;
        const eqStocks = {}, eqPrices = {}, stocks = {}, prices = {}, cumImports = {}, cumExports = {};
        for (const g of PARTNER_MARKET_GOODS) {
          const base = ((typeof GOODBASE !== 'undefined' && GOODBASE[g]) ? GOODBASE[g] : 1) / cw;
          const regG = reg?.market?.goods?.[g] || null;
          const fpWeight = Number(fp?.g?.[g]) || 0;
          const specialtyFactor = fpWeight > 0 ? (1 / (0.86 + 0.28 * fpWeight)) : 1.0;
          const benchPrice = base * (pb.g[g] ?? 1.0) * specialtyFactor;
          const rawRegPrice = Number(regG?.price);
          const eqP = (Number.isFinite(rawRegPrice) && rawRegPrice > 0)
            ? Math.max(base * 0.35, Math.min(base * 3.4, 0.65 * (rawRegPrice / cw) + 0.35 * benchPrice))
            : Math.max(base * 0.35, Math.min(base * 3.4, benchPrice));
          const rawStore = Number(regG?.store);
          const eqS = Math.max(24, (Number.isFinite(rawStore) && rawStore > 4 ? rawStore : Math.round(pop * 0.045)) * (1 + 0.45 * fpWeight));
          eqPrices[g] = +eqP.toFixed(4);
          eqStocks[g] = +eqS.toFixed(2);
          stocks[g] = +eqS.toFixed(2);
          prices[g] = +eqP.toFixed(3);
          cumImports[g] = 0;
          cumExports[g] = 0;
        }
        pm = {
          name: pb.name,
          pop,
          prosperity: Number(reg?.market?.prosperity ?? 60),
          lastDay: nowDay,
          eqStocks,
          eqPrices,
          stocks,
          prices,
          cumImports,
          cumExports,
          seenFlows: {},
        };
        store.partnerMarkets[pb.name] = pm;
      }
      if (!pm.seenFlows || typeof pm.seenFlows !== 'object') pm.seenFlows = {};
      const dt = Math.max(0, nowDay - (Number.isFinite(pm.lastDay) ? pm.lastDay : nowDay));
      if (dt > 0) {
        pm.lastDay = nowDay;
        const relax = 1 - Math.exp(-0.045 * Math.min(45, dt));
        for (const g of PARTNER_MARKET_GOODS) {
          const eqS = pm.eqStocks?.[g] ?? 80;
          const curS = Number.isFinite(pm.stocks?.[g]) ? pm.stocks[g] : eqS;
          pm.stocks[g] = +(curS + (eqS - curS) * relax).toFixed(2);
        }
      }
    }

    // Tally genuine ship cargo flows into/out of partner market stocks once per ship phase.
    for (const sh of W?.ships || []) {
      if (!sh || sh.id == null) continue;
      for (const pb of PARTNER_BENCHMARKS) {
        const pm = store.partnerMarkets[pb.name];
        if (!pm) continue;
        if ((sh.phase === 'in' || sh.phase === 'dock') && matchPartnerBenchmarkName(sh.from || sh.homePort, pb.name)) {
          const fKey = `${sh.id}:exp`;
          if (!pm.seenFlows[fKey]) {
            pm.seenFlows[fKey] = 1;
            for (const [g, qRaw] of Object.entries(sh.cargo || {})) {
              const q = Number(qRaw) || 0;
              if (q <= 0 || pm.stocks[g] === undefined) continue;
              pm.stocks[g] = +Math.max(4, pm.stocks[g] - q).toFixed(2);
              pm.cumExports[g] = +((pm.cumExports[g] || 0) + q).toFixed(2);
            }
          }
        } else if (sh.phase === 'out' && matchPartnerBenchmarkName(sh.to || sh.from || sh.homePort, pb.name)) {
          const fKey = `${sh.id}:imp`;
          if (!pm.seenFlows[fKey]) {
            pm.seenFlows[fKey] = 1;
            for (const [g, qRaw] of Object.entries(sh.load || {})) {
              const q = Number(qRaw) || 0;
              if (q <= 0 || pm.stocks[g] === undefined) continue;
              pm.stocks[g] = +(pm.stocks[g] + q).toFixed(2);
              pm.cumImports[g] = +((pm.cumImports[g] || 0) + q).toFixed(2);
            }
          }
        }
      }
    }

    // Recompute partner market prices strictly from physical stock scarcity + cumulative trade balance.
    for (const pb of PARTNER_BENCHMARKS) {
      const pm = store.partnerMarkets[pb.name];
      if (!pm) continue;
      for (const g of PARTNER_MARKET_GOODS) {
        const base = ((typeof GOODBASE !== 'undefined' && GOODBASE[g]) ? GOODBASE[g] : 1) / cw;
        const eqS = Math.max(12, pm.eqStocks?.[g] ?? 80);
        const curS = Math.max(4, pm.stocks?.[g] ?? eqS);
        const eqP = pm.eqPrices?.[g] ?? base * (pb.g[g] ?? 1.0);
        const scarcity = Math.max(0.45, Math.min(2.6, eqS / curS));
        const netFlow = ((pm.cumExports?.[g] || 0) - (pm.cumImports?.[g] || 0)) / Math.max(60, eqS * 3);
        const drift = Math.pow(scarcity, 0.44) * Math.exp(0.18 * Math.tanh(netFlow));
        pm.prices[g] = +(Math.max(base * 0.30, Math.min(base * 3.80, eqP * drift))).toFixed(3);
      }
    }
    return store.partnerMarkets;
  }

  let lastMaritimeWorld = null;
  let lastMaritimeDay = -1;
  function ensureMaritimeWorldRoutes(opts = {}) {
    if (!W || !Array.isArray(W.settlements) || !W.settlements.length) return;
    const force = Boolean(opts.force);
    const now = day();
    if (!force && lastMaritimeWorld === W && lastMaritimeDay === now) return;
    lastMaritimeWorld = W;
    lastMaritimeDay = now;
    const S = W.settlements;
    const ad = typeof AD === 'function' ? AD() : 1550;
    const cw = W.coinWeight || 1;
    const partnerMarkets = ensurePartnerMarkets(now);
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

    // 1. Ocean merchantmen (`W.ships`) serve true deep-water `s.harbor` ports and ONLY sail when backed
    // by genuine partner-port surplus stock AND real settlement import margin/demand (zero free-cargo injection).
    W.ships = W.ships || [];
    const harborPorts = [];
    for (let si = 0; si < S.length; si++) {
      const s = S[si];
      if (!s || (typeof closedToTrade === 'function' && closedToTrade(s))) continue;
      if (!s.harbor) continue;
      if (typeof offRoute === 'function' && offRoute(si)) harborPorts.push(si);
    }
    // Far ports' merchantmen call only where the people's ways admit them; a people without (`farPorts: false`) trades
    // along its coast by its own boats, the sea caravans below.
    const farHarbors = harborPorts.filter((si) => !(typeof waysOf === 'function' && waysOf(S[si])?.farPorts === false));
    if (W.ships.length) {
      if (farHarbors.length) {
        const primaryHarbor = farHarbors[0];
        const primaryS = S[primaryHarbor];
        const primaryRoute = typeof offRoute === 'function' ? offRoute(primaryHarbor) : null;
        for (const sh of W.ships) {
          if (!sh || S[sh.port]?.harbor) continue;
          sh.port = primaryHarbor;
          if (sh.phase !== 'out' && primaryS?.name) sh.to = String(primaryS.name);
          if (primaryRoute?.poly?.length >= 2) {
            sh.poly = primaryRoute.poly;
            sh.len = primaryRoute.len;
          }
          if (sh.phase === 'dock') {
            const berths = anchorageBerths(primaryS);
            sh.bi = berths.length ? 0 : undefined;
            sh.berth = berths[0] || null;
          } else {
            sh.berth = null;
          }
        }
      } else {
        W.ships = W.ships.filter((sh) => sh && S[sh.port]?.harbor);
      }
    }
    if (farHarbors.length && farPool.length) {
      const targetShips = Math.min(6, Math.max(3, farHarbors.length + 2));
      const existingActive = W.ships.filter((sh) => sh && Array.isArray(sh.poly) && sh.poly.length >= 2 && (sh.phase === 'in' || sh.phase === 'dock' || (sh.phase === 'out' && sh.t1 > now)));
      let needed = Math.max(0, targetShips - existingActive.length);
      for (let k = 0; k < needed; k++) {
        const si = farHarbors[k % farHarbors.length];
        const s = S[si];
        const R = offRoute(si);
        if (!R || !Array.isArray(R.poly) || R.poly.length < 2) continue;
        const rankedFar = farPool.map((fp) => {
          const pbMatch = PARTNER_BENCHMARKS.find((pb) => matchPartnerBenchmarkName(fp.n, pb.name));
          const pm = pbMatch ? partnerMarkets[pbMatch.name] : null;
          let marginSum = 0, weightSum = 0, backedCount = 0;
          for (const g in fp.g) {
            if (!GOODBASE[g]) continue;
            const localP = price(s, g);
            const partnerP = pm?.prices?.[g] ?? ((GOODBASE[g] / cw) * 0.9);
            const partnerStock = pm?.stocks?.[g] ?? 40;
            const needM = (s.pop || 0) * ((typeof NEED !== 'undefined' && NEED[g]) ? NEED[g] : 0.002) * 30;
            const scarce = (Number(s.stores?.[g]) || 0) < Math.max(18, needM * 1.35);
            if (partnerStock >= 8 && (localP > partnerP * 0.88 || scarce)) {
              backedCount++;
              marginSum += Math.max(0.05, localP - partnerP * 0.85) * fp.g[g];
              weightSum += fp.g[g];
            }
          }
          return { fp, pm, score: backedCount > 0 ? marginSum / Math.max(1e-6, weightSum) : -1 };
        }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
        if (!rankedFar.length) continue;
        const chosen = rankedFar[(W.ships.length + k) % rankedFar.length];
        const F = chosen.fp;
        const pm = chosen.pm;
        const cargo = {};
        for (const g in F.g) {
          if (!GOODBASE[g]) continue;
          const availPartner = pm ? Math.max(0, (pm.stocks[g] || 0) - 6) : 36;
          if (availPartner < 4) continue;
          const desired = Math.max(6, Math.round(F.g[g] * (16 + ((maritimeHash(W.shipN || 1, k + 7, hashText(g)) % 18)))));
          const qty = Math.min(Math.floor(availPartner * 0.35) + 4, desired);
          if (qty >= 4) cargo[g] = qty;
        }
        if (!Object.keys(cargo).length) continue;
        const span = Math.max(2.6, R.len / (typeof SHIP_MPD === 'number' ? SHIP_MPD : 3500));
        const backdate = force ? Math.min(0.75, 0.22 + (k * 0.21)) : 0;
        W.shipN = (W.shipN || 0) + 1;
        const kind = typeof shipKind === 'function' ? shipKind() : (ad >= 1400 ? 'carrack' : 'great cog');
        const tonnage = kind === 'carrack' ? 280 + ((W.shipN * 37) % 180) : 160 + ((W.shipN * 29) % 110);
        const sh = {
          id: W.shipN,
          kind,
          from: F.n,
          to: String(s.name || ''),
          master: nextShipMaster(),
          tonnage,
          port: si,
          cargo,
          load: {},
          phase: 'in',
          t0: now - span * backdate,
          t1: now + span * (1 - backdate),
          poly: R.poly,
          len: R.len,
          berth: null,
        };
        W.ships.push(sh);
        if (typeof emit === 'function' && !W.prehistory && !force && k === 0) {
          emit('trade', 2, R.poly[0], `Sails from ${F.n} sighted standing in toward ${s.name}.`);
        }
      }
      ensurePartnerMarkets(now);
    }
    const usedPartnerFolk = new Set();
    for (const sh of W.ships) {
      if (sh && Array.isArray(sh.poly) && sh.poly.length >= 2) {
        staffOceanShip(sh, usedPartnerFolk);
      }
    }

    // 2. Coastal bay boats (`sea`), river barges (`river`), and arterial wagon caravans (`cart`) only dispatch
    // when genuine settlement surplus, positive price margin, and `ladeOut` merchant capital back the consignment.
    W.caravans = W.caravans || [];
    for (const c of W.caravans) {
      if (!c || !c.sea) continue;
      if (!S[c.origin]?.harbor || !S[c.dest]?.harbor) {
        c.sea = false;
        c.river = Boolean(S[c.origin]?.riverside || S[c.dest]?.riverside || S[c.origin]?.river || S[c.dest]?.river);
      }
    }
    const activeByMode = (mode) => W.caravans.filter((c) => c && !c.gone && !c.robbed && Array.isArray(c.poly) && c.poly.length >= 2 && (c.sea ? 'sea' : c.river ? 'river' : 'cart') === mode && now >= c.departDay && now < c.arriveDay);
    const activeSea = activeByMode('sea');
    const activeRiver = activeByMode('river');
    const activeCart = activeByMode('cart');

    const COACH_ROAD_GOODS = new Set(['cloth', 'silk', 'spice', 'tools']);
    const rankGoodsForPair = (oi, di, isBoat, preferCoachGood = false) => {
      const o = S[oi], d = S[di];
      const list = [];
      for (const g of GOODS) {
        if (isBoat && typeof BEASTS !== 'undefined' && BEASTS.includes(g)) continue;
        if (preferCoachGood && !COACH_ROAD_GOODS.has(g)) continue;
        const pO = price(o, g);
        const pD = price(d, g);
        const margin = pD - pO;
        if (margin <= 0.005) continue;
        const onSale = typeof avail === 'function' ? Math.max(0, Number(avail(o, g, pO * 1.35)) || 0) : Math.max(0, Number(o.stores?.[g]) || 0);
        const spare = typeof spareOf === 'function' ? Math.max(0, Number(spareOf(o, g)) || 0) : onSale;
        const backing = Math.min(onSale, Math.max(spare, onSale * 0.5));
        const minQ = preferCoachGood ? 3 : 5;
        if (backing < minQ) continue;
        list.push({ g, onSale: backing, margin, score: margin * 4 + Math.min(30, backing) * 0.02 });
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
    // Strictly select real living `s.folk` mariners/fishers/boatmen/merchants — NEVER fabricate 900000+ ghost IDs.
    const pickOrPromoteBoatman = (prefSi, role = 'pilot', usedIds = new Set()) => {
      const order = [];
      if (prefSi >= 0 && prefSi < S.length) order.push(prefSi);
      for (let i = 0; i < S.length; i++) if (i !== prefSi && (S[i]?.harbor || S[i]?.riverside || S[i]?.river)) order.push(i);
      for (let i = 0; i < S.length; i++) if (!order.includes(i)) order.push(i);
      const wantMerch = role === 'merchant';
      for (const pass of [0, 1]) {
        for (const si of order) {
          const s = S[si];
          const folkList = s?.folk;
          if (!Array.isArray(folkList) || !folkList.length) continue;
          for (const p of folkList) {
            if (!p || p.dead || usedIds.has(p.id) || isAwayNow(p)) continue;
            if (!wantMerch && p.sx !== 'm') continue;
            const age = safeAgeYrs(p);
            if (age < 16 || age > 64) continue;
            if (pass === 0) {
              if (wantMerch) {
                if (p.tr !== 'merchant' && p.tr !== 'trader' && p.tr !== 'chandler' && p.tr !== 'spicer' && p.tr !== 'salter') continue;
              } else if (p.tr !== 'boatman' && p.tr !== 'fisher' && p.tr !== 'shipwright' && p.tr !== 'roper') {
                continue;
              }
            }
            if (pass === 1 && (p.office || p.estateOffice || p.schoolMaster || p.abbey != null || p.churchBody || p.outlawCampId)) continue;
            if (p.si == null) p.si = si;
            usedIds.add(p.id);
            return p;
          }
        }
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
          pilot.away = { until, what: `piloting river barge with ${c.good || 'cargo'} to ${destName}` };
          c.crew = pilot;
          c.pilot = {
            id: pilot.id,
            name: safeFolkName(pilot),
            settlementId: pilot.si ?? oi,
            trade: 'boatman',
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
          oarsmen.push({ id: oar.id, name: safeFolkName(oar), settlementId: oar.si ?? oi, trade: 'boatman' });
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

    const tryDispatchRoute = (mode, oi, di, poly, len, frac, preferCoachGood = false) => {
      if (!Array.isArray(poly) || poly.length < 2 || !(len > 20)) return false;
      const o = S[oi], d = S[di];
      if (!o || !d) return false;
      const baseSpeed = mode === 'sea' ? (typeof COG_MPD === 'number' ? COG_MPD : 2400) : mode === 'river' ? (typeof BARGE_MPD === 'number' ? BARGE_MPD : 1100) : (typeof CART_MPD === 'number' ? CART_MPD : 520);
      const goods = rankGoodsForPair(oi, di, mode !== 'cart', preferCoachGood);
      for (const item of goods) {
        const g = item.g;
        const minQty = preferCoachGood ? 3 : 5;
        const qty = Math.min(mode === 'cart' ? 24 : 36, Math.max(minQty, Math.round(item.onSale * 0.28)));
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
          unit: Math.max(0.02, item.margin),
          master: nextShipMaster(),
        };
        const needsRawDecrement = !o.storage || (typeof BEASTS !== 'undefined' && BEASTS.includes(g));
        if (needsRawDecrement) o.stores[g] = Math.max(0, (o.stores[g] || 0) - qty);
        if (typeof ladeOut === 'function' && ladeOut(c, o, true)) {
          if (c.arriveDay < now + 2.8) c.arriveDay = now + 2.8;
          staffRiverVessel(c, oi, di, mode);
          W.caravans.push(c);
          return true;
        }
        if (needsRawDecrement) o.stores[g] = (o.stores[g] || 0) + qty;
      }
      return false;
    };

    for (const c of W.caravans) {
      if (c && !c.gone && !c.robbed && c.river && (!c.pilot || c.pilot.id == null)) {
        staffRiverVessel(c, c.origin ?? 0, c.dest ?? 0, 'river');
      }
    }

    if (activeSea.length < 3 && harborPorts.length >= 2 && typeof seaRoute === 'function') {
      const seaPairs = [];
      for (let a = 0; a < harborPorts.length; a++) {
        for (let b = a + 1; b < harborPorts.length; b++) {
          const oi = harborPorts[a], di = harborPorts[b];
          const sr = seaRoute(oi, di);
          if (sr && sr.poly?.length >= 2) seaPairs.push({ oi, di, poly: sr.poly, len: sr.len });
        }
      }
      let needSea = Math.min(4, Math.max(2, seaPairs.length)) - activeSea.length;
      for (let i = 0; i < seaPairs.length * 2 && needSea > 0; i++) {
        const pair = seaPairs[i % seaPairs.length];
        const forward = (i % 2) === 0;
        const poly = forward ? pair.poly : [...pair.poly].reverse();
        const backdate = force ? (0.16 + ((i * 0.21) % 0.62)) : 0;
        if (tryDispatchRoute('sea', forward ? pair.oi : pair.di, forward ? pair.di : pair.oi, poly, pair.len, backdate)) needSea--;
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
        const backdate = force ? (0.20 + ((i * 0.27) % 0.56)) : 0;
        if (tryDispatchRoute('river', forward ? pr.a : pr.b, forward ? pr.b : pr.a, poly, pr.route.len || 400, backdate)) needRiv--;
      }
    }

    if (S.length >= 2) {
      let hasCoachGood = activeCart.some((c) => COACH_ROAD_GOODS.has(String(c?.good || '')));
      if (activeCart.length < 6 || !hasCoachGood) {
        const roadPairs = [];
        for (let oi = 0; oi < S.length; oi++) {
          for (let di = oi + 1; di < S.length; di++) {
            const r = typeof route === 'function' ? route(oi, di) : null;
            if (r && Array.isArray(r.poly) && r.poly.length >= 2 && r.len > 60) {
              roadPairs.push({ oi, di, poly: r.poly, len: r.len });
            }
          }
        }
        let needCart = Math.max(0, Math.min(7, Math.max(5, roadPairs.length)) - activeCart.length);
        if (!hasCoachGood) {
          for (let i = 0; i < roadPairs.length * 2 && !hasCoachGood; i++) {
            const pair = roadPairs[i % roadPairs.length];
            const forward = (i % 2) === 0;
            const poly = forward ? pair.poly : [...pair.poly].reverse();
            const backdate = force ? (0.15 + ((i * 0.17) % 0.55)) : 0;
            if (tryDispatchRoute('cart', forward ? pair.oi : pair.di, forward ? pair.di : pair.oi, poly, pair.len, backdate, true)) {
              hasCoachGood = true;
              if (needCart > 0) needCart--;
            }
          }
        }
        for (let i = 0; i < roadPairs.length * 2 && needCart > 0; i++) {
          const pair = roadPairs[i % roadPairs.length];
          const forward = (i % 2) === 0;
          const poly = forward ? pair.poly : [...pair.poly].reverse();
          const backdate = force ? (0.18 + ((i * 0.19) % 0.58)) : 0;
          if (tryDispatchRoute('cart', forward ? pair.oi : pair.di, forward ? pair.di : pair.oi, poly, pair.len, backdate, false)) needCart--;
        }
      }
    }

    // 3. Ground local river fishing & ferry boats (`W.riverBoats`) strictly in real `s.folk` fishers/boatmen
    // and real `s.stores.fish` / riverside settlement stocks (never inventing 24 unstaffed 900000+ ghost boats).
    if (!Array.isArray(W.riverBoats)) W.riverBoats = [];
    W.riverBoats = W.riverBoats.filter((b) => b && !b.sunk && !(b.pilotId >= 900000));
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
    let riverFolkCount = 0, totalFishStore = 0;
    for (const s of S) {
      if (!s || !(s.riverside || s.river || s.harbor)) continue;
      totalFishStore += Math.max(0, Number(s.stores?.fish) || 0);
      for (const p of s.folk || []) {
        if (p && !p.dead && (p.tr === 'fisher' || p.tr === 'boatman')) riverFolkCount++;
      }
    }
    const targetLocalRiverBoats = riverFolkCount >= 3
      ? Math.min(8, Math.max(1, Math.min(Math.floor(riverFolkCount / 3), 1 + Math.floor(totalFishStore / 45))))
      : 0;
    if (W.riverBoats.length > targetLocalRiverBoats && targetLocalRiverBoats > 0) {
      W.riverBoats.length = targetLocalRiverBoats;
    }
    const RIVER_PARCEL_GOODS = ['fish', 'grain', 'wine', 'timber', 'salt', 'char', 'ore'];
    const pickRiverParcel = (si, idSalt) => {
      const worldSeed = typeof SEED === 'number' ? SEED : 1550;
      const stores = S[si]?.stores || {};
      if ((Number(stores.fish) || 0) >= 2 && (idSalt % 2 === 0)) {
        return { good: 'fish', qty: Math.min(5, Math.max(2, Math.round(Math.min(5, Number(stores.fish) * 0.08)))) };
      }
      const availGoods = RIVER_PARCEL_GOODS.filter((g) => (Number(stores[g]) || 0) >= 2);
      if (!availGoods.length) return { good: 'fish', qty: 2 };
      const good = availGoods[maritimeHash(worldSeed, idSalt, 17) % availGoods.length];
      const qty = Math.min(5, Math.max(2, Math.min(Math.floor(Number(stores[good]) || 2), 2 + (maritimeHash(worldSeed, idSalt, 23) % 4))));
      return { good, qty };
    };
    if (W.riverBoats.length < targetLocalRiverBoats && Array.isArray(W.rivStrips) && W.rivStrips.length > 0 && S.length > 0) {
      const existingByKey = new Set(W.riverBoats.map((b) => `${b.riverIdx}:${b.slotCopy ?? b.id}`));
      let nextId = W.riverBoats.reduce((m, b) => Math.max(m, Number(b?.id) || 0), 0) + 1;
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
        if (totalLen >= 140 && avgHw >= 1.35) {
          reaches.push({ ri, pts: q.pts, totalLen, avgHw });
        }
      }
      reaches.sort((a, b) => b.totalLen - a.totalLen || a.ri - b.ri);
      for (let idx = 0; idx < reaches.length && W.riverBoats.length < targetLocalRiverBoats; idx++) {
        const r = reaches[idx];
        const copies = Math.max(1, Math.min(3, Math.round(r.totalLen / 480)));
        for (let copy = 0; copy < copies && W.riverBoats.length < targetLocalRiverBoats; copy++) {
          const slotKey = `${r.ri}:${copy}`;
          if (existingByKey.has(slotKey)) continue;
          existingByKey.add(slotKey);
          const forward = ((idx + copy) % 2) === 0;
          const pts = (forward ? r.pts : [...r.pts].reverse()).map((p) => ({ x: p.x, z: p.z }));
          const si = nearestSettlement(pts[0]);
          const destSi = nearestSettlement(pts[pts.length - 1]);
          const tripSpan = Math.max(2.1, +(r.totalLen / 360).toFixed(2));
          const phaseOffset = +((((copy + 0.5) / copies) + ((idx * 0.173) % 0.19)) % 1).toFixed(4);
          const departDay = now - phaseOffset * tripSpan;
          const id = nextId++;
          const parcel = pickRiverParcel(si, id);
          W.riverBoats.push({
            id,
            slotCopy: copy,
            key: `rb:${id}`,
            shipName: parcel.good === 'fish' ? `Barca de Pesca ${id}` : `Barca do Rio ${id}`,
            riverIdx: r.ri,
            si,
            destSi,
            phase: 'shuttle',
            scale: +(0.76 + ((id * 0.037) % 0.14)).toFixed(2),
            tripSpan,
            phaseOffset,
            departDay,
            arriveDay: departDay + tripSpan,
            good: parcel.good,
            qty: parcel.qty,
            points: pts,
            forward,
            pilotId: null,
            pilot: null,
            merchant: null,
            oarsmen: [],
            sunk: false,
          });
        }
      }
    }
    const usedRiverFolk = new Set();
    const staffedRiverBoats = [];
    for (const b of W.riverBoats) {
      if (!b || b.sunk) continue;
      if (!b.good || !(b.qty >= 2)) {
        const parcel = pickRiverParcel(b.si ?? 0, b.id || 1);
        b.good = parcel.good;
        b.qty = parcel.qty;
      }
      if (!Number.isFinite(b.phaseOffset)) {
        b.phaseOffset = +((((b.id || 1) * 0.29) % 0.92) + 0.04).toFixed(4);
      }
      if (now >= (b.arriveDay ?? -Infinity)) {
        const prevSi = b.si;
        b.si = b.destSi ?? prevSi;
        b.destSi = prevSi ?? b.si;
        b.forward = !b.forward;
        const span = Math.max(2.0, b.tripSpan || 3.2);
        b.departDay = now;
        b.arriveDay = now + span;
        const nextParcel = pickRiverParcel(b.si ?? 0, (b.id || 1) + Math.floor(now));
        b.good = nextParcel.good;
        b.qty = nextParcel.qty;
      }
      let pilotFolk = findFolkById(b.pilotId);
      if (!pilotFolk || usedRiverFolk.has(pilotFolk.id)) {
        pilotFolk = pickOrPromoteBoatman(b.si ?? 0, 'pilot', usedRiverFolk);
      } else {
        usedRiverFolk.add(pilotFolk.id);
      }
      if (!pilotFolk) continue;
      b.pilotId = pilotFolk.id;
      b.pilot = {
        id: pilotFolk.id,
        name: safeFolkName(pilotFolk),
        settlementId: pilotFolk.si ?? b.si ?? 0,
        trade: 'boatman',
      };
      if (!b.merchant || usedRiverFolk.has(b.merchant.id) || b.merchant.id >= 900000) {
        const merchFolk = pickOrPromoteBoatman(b.si ?? 0, 'merchant', usedRiverFolk);
        b.merchant = merchFolk ? {
          id: merchFolk.id,
          name: safeFolkName(merchFolk),
          settlementId: merchFolk.si ?? b.si ?? 0,
          trade: merchFolk.tr || 'merchant',
        } : null;
      } else if (b.merchant?.id != null) {
        usedRiverFolk.add(b.merchant.id);
      }
      const targetOars = 2 + ((b.id || 1) % 3 === 0 ? 2 : 0);
      const nextOars = [];
      for (const existing of Array.isArray(b.oarsmen) ? b.oarsmen : []) {
        const oarFolk = findFolkById(existing?.id);
        if (!oarFolk || usedRiverFolk.has(oarFolk.id)) continue;
        usedRiverFolk.add(oarFolk.id);
        nextOars.push({
          id: oarFolk.id,
          name: safeFolkName(oarFolk),
          settlementId: oarFolk.si ?? b.si ?? 0,
          trade: 'boatman',
        });
      }
      while (nextOars.length < targetOars) {
        const oarFolk = pickOrPromoteBoatman(b.si ?? 0, 'oarsman', usedRiverFolk);
        if (!oarFolk) break;
        nextOars.push({
          id: oarFolk.id,
          name: safeFolkName(oarFolk),
          settlementId: oarFolk.si ?? b.si ?? 0,
          trade: 'boatman',
        });
      }
      if (nextOars.length < 2) continue;
      b.oarsmen = nextOars;
      staffedRiverBoats.push(b);
    }
    W.riverBoats = staffedRiverBoats;
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
          if (pid >= NOTABLE_PERSON_BASE && pid < 2_000_000) {
            const notableAns = buildNotablePersonInspect(pid - NOTABLE_PERSON_BASE);
            if (notableAns) return notableAns;
          }
        } else if (/^n\d+$/.test(codeStr)) {
          const notableAns = buildNotablePersonInspect(Number(codeStr.slice(1)));
          if (notableAns) return notableAns;
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
    const g = s._sg || (typeof streetGraph === 'function' ? streetGraph(s) : null);
    const snapStreet = (pt) => {
      if (!pt || !g?.N?.length || typeof nearestNode !== 'function') return pt;
      const idx = nearestNode(g, pt.x, pt.z);
      return idx >= 0 && g.N[idx] ? { x: g.N[idx].x, z: g.N[idx].z } : pt;
    };
    const churchBld = (s.buildings || []).find((b) => b && b.arch === 'temple' && b.state === 'sound') || null;

    // Prepend resident Monarch, Royal Consort, Royal Court & Noble Lords so the Queen in Lisbon (and lords in their seats)
    // walk visibly in 3D between the waterfront Paço da Ribeira (Terreiro do Paço) and the hilltop Alcáçova Keep.
    const residentNotables = residentNotablesOf(si);
    if (residentNotables.length && g?.N?.length && typeof planWalk === 'function') {
      const landPt = landingSeen(s);
      const rawRibeira = landPt
        ? { x: s.pos.x * 0.55 + landPt.x * 0.45, z: s.pos.z * 0.55 + landPt.z * 0.45 }
        : { x: s.pos.x + 14, z: s.pos.z + 24 };
      const ribeiraNode = snapStreet(rawRibeira);
      // A people of the Americas: its chief walks from his house to the open place, on foot, as do his kin.
      const ways = courtWays();
      const keepRaw = ways ? (chiefSeat(s) || s.pos) : s.keepPos || (typeof casKeep === 'function' && casKeep(s)) || { x: 230.6, z: -370.4 };
      const keepNode = snapStreet(keepRaw);
      const marketNode = snapStreet((s.places || [])[0] || { x: s.pos.x, z: s.pos.z });
      const houseSurname = (n) => (n.house === 0 ? (W?.houses?.[0]?.name || 'de Avis') : (W?.houses?.[n.house]?.name || ''));

      residentNotables.slice(0, 8).forEach((n, idx) => {
        const pid = NOTABLE_PERSON_BASE + n.id;
        const isMonarch = W?.monarch?.id === n.id;
        const isRoyal = n.house === 0;
        const isLord = W?.houses?.[n.house]?.head === n.id;
        const role = notableRoleLabel(n);
        const court = !ways && isRoyal && si === 0;
        const mounted = !ways && Boolean(
          (!isMonarch && isLord)
          || n.role === 'marshal'
          || n.role === 'envoy'
          || n.role === 'justice'
          || (isRoyal && !isMonarch && idx >= 2 && (idx % 2 === 1))
        );
        const startPt = court
          ? ((idx % 2 === 0) ? ribeiraNode : keepNode)
          : snapStreet((typeof notableResidence === 'function' ? notableResidence(n)?.b : null) || keepRaw);
        const destPt = (sunday && churchBld)
          ? snapStreet(churchBld)
          : court
            ? ((idx % 2 === 0) ? keepNode : ribeiraNode)
            : marketNode;
        const goal = (sunday && churchBld) ? 'church' : 'work';
        const walker = { g, p: { id: pid }, x: startPt.x, z: startPt.z };
        planWalk(walker, destPt, goal);
        const route = [];
        for (const q of walker.route || []) route.push(r1(q.x), r1(q.z));
        if (route.length >= 4) {
          planned.add(pid);
          people.push({
            id: pid,
            notableId: n.id,
            notable: true,
            royal: isRoyal,
            monarch: isMonarch,
            mounted,
            name: isMonarch && typeof fullTitle === 'function' ? fullTitle(n) : String(n.name || 'Noble'),
            surname: houseSurname(n),
            sex: n.sex || null,
            age: r1(Math.max(1, Number(n.age) || 32)),
            role,
            lodging: court ? 'Paço da Ribeira (Terreiro do Paço) & Alcáçova Keep' : ways ? chiefLodging(s, notableResidence(n)?.b) : `${s.name} Keep`,
            goal,
            there: court
              ? (isMonarch ? 'holding royal court between Paço da Ribeira and Alcáçova Keep' : 'in attendance upon the Crown at Paço da Ribeira')
              : ways ? (isMonarch ? `in council at ${s.name}` : `at ${s.name}`) : `holding court at ${s.name}`,
            via: walker.via || '',
            open: true,
            run: mounted,
            pace: mounted ? 1.85 : 1.05,
            home: [r1(startPt.x), r1(startPt.z)],
            route,
          });
        }
      });
    }

    const isMountedTownsman = (p) => {
      if (!p || ageYrs(p) < 16) return false;
      const tr = String(p.tr || '');
      if (tr === 'messenger' || tr === 'courier') return true;
      const off = typeof officeHeld === 'function' ? officeHeld(p) : (p.office || p.estateOffice || '');
      if (off === 'sheriff' || off === 'bailiff' || off === 'marshal' || off === 'steward' || off === 'warden') return true;
      const hh = typeof householdAccount === 'function' ? householdAccount(p) : null;
      if ((hh?.assets?.horses || 0) >= 1 && (tr === 'merchant' || tr === 'reeve' || tr === 'carter' || tr === 'forester')) return true;
      if (tr === 'reeve' || (si === 0 && tr === 'carter' && (p.id % 5 === 0))) return true;
      return false;
    };

    // A child's calling on the model's record is the household's; they have none of their own yet.
    const soul = (p) => {
      const mounted = isMountedTownsman(p);
      return {
        id: p.id,
        name: folkName(p),
        surname: famName(p),
        sex: p.sx || null,
        age: r1(ageYrs(p)),
        role: ageYrs(p) >= 14 ? (mounted && p.tr === 'carter' ? 'messenger' : (p.tr || null)) : null,
        ...(mounted ? { mounted: true } : {}),
      };
    };
    for (const c of plan) {
      const p = c.p, walker = { ...c };
      let to = c.work, goal = 'work', there = c.what, open = !c.workIn;
      if (sunday && c.church && ageYrs(p) >= 6) { to = c.church; goal = 'church'; there = 'at mass'; open = false; }
      else if (c.chores) {
        const shop = c.shops?.length ? c.shops[p.id % c.shops.length] : null;
        to = shop ? { x: shop.x, z: shop.z } : c.mk; goal = 'errand'; open = !shop;
        there = shop ? `at the ${ARCH[shop.arch]?.[4] ?? shop.arch}` : 'at the market';
      } else if (ageYrs(p) < 14) goal = 'play';
      const sInfo = soul(p);
      if (sInfo.mounted && si === 0 && g?.N?.length) {
        const landPt = landingSeen(s);
        const palacePt = snapStreet(landPt ? { x: s.pos.x * 0.55 + landPt.x * 0.45, z: s.pos.z * 0.55 + landPt.z * 0.45 } : s.pos);
        to = palacePt;
        open = true;
        there = 'riding royal dispatches from Paço da Ribeira';
      }
      planWalk(walker, to, goal);
      const route = [];
      for (const q of walker.route) route.push(r1(q.x), r1(q.z));
      // Out of doors the work is a beat: up the furrow and back, from tree to tree, about the lane at play.
      if (goal !== 'church' && goal !== 'errand' && c.fw && !sInfo.mounted) route.push(r1(c.fw.B.x), r1(c.fw.B.z));
      planned.add(p.id);
      people.push({
        ...sInfo,
        goal,
        there,
        via: walker.via || '',
        open,
        run: Boolean(c.fw?.run || sInfo.mounted),
        pace: sInfo.mounted ? 1.85 : r3(c.pace / 2),
        home: [r1(c.home.x), r1(c.home.z)],
        route,
      });
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
      // A place of a people with ways of its own (scripts/board-native.mjs) builds in earth and timber: its ways are
      // trodden, its open places bare ground, its wall a palisade of stakes.
      ...(typeof waysOf === 'function' && waysOf(s) ? { earthen: true } : {}),
      wall: s.wallRad ? { rad: list(s.wallRad), kind: list(s.wallKind, Number), gates: list(fortGateAngles(s, s), r3), bastions: Boolean(s.bastions), roman: Boolean(s.romanWall),
        // A circuit still going up: which of its stretches stand so far.
        ...(s.wallBuild ? { built: list(s.wallRad, (_, k) => wallBuilt(s, k / s.wallRad.length * 2 * Math.PI) ? 1 : 0) } : {}) } : null,
      castle: castle(s),
      // The works a real map records that stand with it (scripts/board-forts.mjs): each where the model set it, its
      // front turned to the water it holds (`face`, the bearing of that water); a citadel the place's castle is says so.
      works: (s.works || []).map((k) => ({ kind: k.kind, name: k.name, x: r1(k.x), z: r1(k.z), w: r1(k.w), d: r1(k.d), turn: r3(k.rot), face: k.face == null ? null : r3(k.face),
        role: k.role || '', side: k.side || '', from: k.from ?? null, until: k.until ?? null, ...(k.castle ? { castle: true } : {}) })),
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
    const given = [], families = [], trades = [], souls = [], notables = [];
    const point = (table, word) => { let k = table.indexOf(word); if (k < 0) { k = table.length; table.push(word); } return k; };
    W.settlements.forEach((s, at) => {
      for (const p of s.folk || []) {
        if (p.dead) continue;
        const home = householdHead(p)?.bh || null;
        souls.push(at, point(given, p.gn || ''), point(families, W.fams?.[p.fam]?.n || ''), (p.sx === 'f' ? 1000 : 0) + Math.max(0, Math.min(999, Math.floor(ageYrs(p)))),
          point(trades, p.tr || ''), home && standing.has(home) ? standing.get(home) : -1);
      }
      for (const n of residentNotablesOf(at)) {
        const res = typeof notableResidence === 'function' ? notableResidence(n) : null;
        const resBld = (res?.s === s && res?.b && standing.has(res.b)) ? standing.get(res.b) : -1;
        const role = notableRoleLabel(n);
        const hName = n.house === 0 ? (W?.houses?.[0]?.name || 'Royal House') : (W?.houses?.[n.house]?.name || 'Noble House');
        const gName = String(n.name || 'Noble');
        const nAge = Math.max(0, Math.min(999, Math.floor(Number(n.age) || 32)));
        souls.push(at, point(given, gName), point(families, hName), (n.sex === 'f' ? 1000 : 0) + nAge, point(trades, role), resBld);
        notables.push({
          id: NOTABLE_PERSON_BASE + n.id,
          notableId: n.id,
          place: at,
          name: W?.monarch?.id === n.id && typeof fullTitle === 'function' ? fullTitle(n) : gName,
          given: gName,
          house: hName,
          sex: n.sex || null,
          age: nAge,
          role,
          monarch: Boolean(W?.monarch?.id === n.id),
          royal: n.house === 0,
          lodging: courtWays() ? chiefLodging(s, res?.s === s ? res.b : null) : (n.house === 0 && at === 0) ? 'Paço da Ribeira (Terreiro do Paço) & Alcáçova Keep' : `${s.name} Keep`,
        });
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
        // Chain furlong/croft boundary edges into contiguous mitered polylines along lane & road verges.
        fences: (() => {
          const rawSegs = workerFenceSegments();
          if (!rawSegs.length) return [];
          const roadSegs = [];
          for (const rd of W.roads || []) {
            const pts = rd?.drawn || rd?.path;
            if (!Array.isArray(pts)) continue;
            for (let i = 1; i < pts.length; i++) {
              const ax = pts[i - 1].x, az = pts[i - 1].z, bx = pts[i].x, bz = pts[i].z;
              const rl = Math.hypot(bx - ax, bz - az);
              if (rl < 0.5) continue;
              roadSegs.push([
                ax, az, bx, bz, (bx - ax) / rl, (bz - az) / rl, rl,
                Math.min(ax, bx) - 4.5, Math.max(ax, bx) + 4.5,
                Math.min(az, bz) - 4.5, Math.max(az, bz) + 4.5,
              ]);
            }
          }
          const nearPrimaryRoad = (mx, mz, ux, uz) => {
            for (let i = 0; i < roadSegs.length; i++) {
              const s = roadSegs[i];
              if (mx < s[7] || mx > s[8] || mz < s[9] || mz > s[10]) continue;
              if (Math.abs(ux * s[4] + uz * s[5]) < 0.7) continue;
              const t = Math.max(0, Math.min(s[6], (mx - s[0]) * s[4] + (mz - s[1]) * s[5]));
              const dx = mx - (s[0] + s[4] * t), dz = mz - (s[1] + s[5] * t);
              if (dx * dx + dz * dz <= 14.5) return true;
            }
            return false;
          };
          const vKey = (x, z) => `${Math.round(x * 5)},${Math.round(z * 5)}`;
          const edges = [];
          const vertMap = new Map();
          const addInc = (k, x, z, ref) => {
            let bucket = vertMap.get(k);
            if (!bucket) { bucket = { x, z, inc: [] }; vertMap.set(k, bucket); }
            bucket.inc.push(ref);
          };
          for (const f of rawSegs) {
            const ax = f.a.x, az = f.a.z, bx = f.b.x, bz = f.b.z;
            const L = Math.hypot(bx - ax, bz - az);
            if (L < 0.5) continue;
            const ux = (bx - ax) / L, uz = (bz - az) / L;
            let nx = -uz, nz = ux;
            const mx = 0.5 * (ax + bx), mz = 0.5 * (az + bz);
            if ((f.x - mx) * nx + (f.z - mz) * nz < 0) { nx = -nx; nz = -nz; }
            const onRoad = nearPrimaryRoad(mx, mz, ux, uz);
            const d = onRoad ? 3.35 : f.lane ? 2.35 : 0;
            const e = {
              ax, az, bx, bz, outAx: ax, outAz: az, outBx: bx, outBz: bz,
              nx, nz, d, stone: !!f.stone, onWay: !!(f.lane || onRoad),
              fKey: `${Math.round(f.x * 2)}:${Math.round(f.z * 2)}`,
            };
            edges.push(e);
            addInc(vKey(ax, az), ax, az, { e, end: 0 });
            addInc(vKey(bx, bz), bx, bz, { e, end: 1 });
          }
          const solveMiter = (vx, vz, n0x, n0z, d0, n1x, n1z, d1) => {
            const maxD = Math.max(d0, d1);
            if (maxD <= 0) return [vx, vz];
            const det = n0x * n1z - n0z * n1x;
            if (Math.abs(det) > 0.18) {
              let dx = (d0 * n1z - d1 * n0z) / det;
              let dz = (n0x * d1 - n1x * d0) / det;
              const ml = Math.hypot(dx, dz), cap = 1.8 * maxD;
              if (ml > cap) { dx *= cap / ml; dz *= cap / ml; }
              return [vx + dx, vz + dz];
            }
            const sx = n0x + n1x, sz = n0z + n1z, sl = Math.hypot(sx, sz) || 1;
            const dAvg = 0.5 * (d0 + d1);
            return [vx + (sx / sl) * dAvg, vz + (sz / sl) * dAvg];
          };
          for (const { x: vx, z: vz, inc } of vertMap.values()) {
            const wayInc = inc.filter((r) => r.e.d > 0);
            const inlandInc = inc.filter((r) => r.e.d === 0);
            if (!wayInc.length) continue;
            // Cluster offset edges on the same side of the lane/road (`dot(nA, nB) > 0.2` or same furlong).
            const clusters = [];
            for (const r of wayInc) {
              let placed = null;
              for (const c of clusters) {
                const sameFurlong = c.some((q) => q.e.fKey === r.e.fKey);
                const sameSide = c.some((q) => q.e.nx * r.e.nx + q.e.nz * r.e.nz > 0.2);
                if (sameFurlong || sameSide) { placed = c; break; }
              }
              if (placed) placed.push(r);
              else clusters.push([r]);
            }
            const clusterJoints = clusters.map((c) => {
              let pt, nAvgX = 0, nAvgZ = 0, dMax = 0;
              for (const r of c) { nAvgX += r.e.nx; nAvgZ += r.e.nz; dMax = Math.max(dMax, r.e.d); }
              const nl = Math.hypot(nAvgX, nAvgZ) || 1;
              nAvgX /= nl; nAvgZ /= nl;
              if (c.length >= 2) {
                pt = solveMiter(vx, vz, c[0].e.nx, c[0].e.nz, c[0].e.d, c[1].e.nx, c[1].e.nz, c[1].e.d);
              } else {
                const r0 = c[0];
                // Check if this furlong turns inland here along an un-offset edge (`d === 0`).
                const mate = inlandInc.find((q) => q.e.fKey === r0.e.fKey);
                if (mate) {
                  pt = solveMiter(vx, vz, r0.e.nx, r0.e.nz, r0.e.d, mate.e.nx, mate.e.nz, 0);
                } else {
                  pt = [vx + r0.e.nx * r0.e.d, vz + r0.e.nz * r0.e.d];
                }
              }
              for (const r of c) {
                if (r.end === 0) { r.e.outAx = pt[0]; r.e.outAz = pt[1]; }
                else { r.e.outBx = pt[0]; r.e.outBz = pt[1]; }
              }
              return { c, pt, nx: nAvgX, nz: nAvgZ, d: dMax };
            });
            // Snap/trim any un-offset interior fence meeting this roadside vertex onto the matching verge line/corner.
            for (const q of inlandInc) {
              const ox = q.end === 0 ? q.e.bx : q.e.ax, oz = q.end === 0 ? q.e.bz : q.e.az;
              const dl = Math.hypot(ox - vx, oz - vz) || 1;
              const ix = (ox - vx) / dl, iz = (oz - vz) / dl;
              let best = null, bestDot = 0.18;
              for (const cj of clusterJoints) {
                const sameF = cj.c.some((r) => r.e.fKey === q.e.fKey);
                const align = ix * cj.nx + iz * cj.nz;
                if (sameF || align > bestDot) { best = cj; bestDot = Math.max(bestDot, align); if (sameF) break; }
              }
              if (!best) continue;
              let tx = best.pt[0], tz = best.pt[1];
              if (best.c.length >= 2) {
                // T-junction into a continuous roadside fence: land right on the mitered corner/verge point.
                tx = best.pt[0]; tz = best.pt[1];
              } else if (!best.c.some((r) => r.e.fKey === q.e.fKey)) {
                const r0 = best.c[0].e;
                const s = solveMiter(vx, vz, r0.nx, r0.nz, r0.d, q.e.nx, q.e.nz, 0);
                tx = s[0]; tz = s[1];
                if (best.c[0].end === 0) { r0.outAx = tx; r0.outAz = tz; }
                else { r0.outBx = tx; r0.outBz = tz; }
              }
              if (q.end === 0) { q.e.outAx = tx; q.e.outAz = tz; }
              else { q.e.outBx = tx; q.e.outBz = tz; }
            }
          }
          const outFences = [];
          for (const e of edges) {
            if (Math.hypot(e.outBx - e.outAx, e.outBz - e.outAz) < 1.2) continue;
            outFences.push(
              r1(e.outAx), r1(e.outAz), r1(e.outBx), r1(e.outBz),
              (e.stone ? 1 : 0) + (e.onWay ? 2 : 0) + 4,
            );
          }
          return outFences;
        })(),
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
      people: souls.length / 6,
      souls: { given, families, trades, each: souls, notables },
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
    ensureMaritimeWorldRoutes();
    const out = [];
    (W.ships || []).forEach((sh, index) => {
      if (!sh || !Array.isArray(sh.poly) || sh.poly.length < 2) return;
      const settlement = W.settlements?.[sh.port] || null;
      if (!settlement || !settlement.harbor) return;
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
    const worldSeed = typeof SEED === 'number' ? SEED : 1550;
    const S = W?.settlements || [];
    const hub = S.find((s) => s?.harbor) || S[0] || null;
    const hubIdx = hub ? Math.max(0, S.indexOf(hub)) : 0;
    const portName = hub?.name || 'Lisboa';
    const pop = Math.max(0, Number(hub?.pop) || 0);
    const fishStore = Math.max(0, Number(hub?.stores?.fish) || 0);
    const used = new Set();
    const fleet = [];

    // 1. Real anchored/waiting `W.ships` currently lying off the harbour.
    let roadsteadIdx = 0;
    for (const sh of W?.ships || []) {
      if (!sh || !Array.isArray(sh.poly) || sh.poly.length < 2) continue;
      if (sh.captain?.id != null) used.add(sh.captain.id);
      if (sh.merchant?.id != null) used.add(sh.merchant.id);
      for (const m of sh.crew || []) if (m?.id != null) used.add(m.id);
      if (sh.phase === 'dock' || (sh.phase === 'in' && (sh.waited || 0) > 0)) {
        if (!sh.captain || !sh.merchant) staffOceanShip(sh, used);
        fleet.push({
          slot: `roadstead:${roadsteadIdx++}`,
          kind: String(sh.kind || 'carrack'),
          shipName: String(sh.shipName || 'Merchantman'),
          homePort: String(sh.homePort || sh.from || 'Sevilla'),
          captain: sh.captain ? { ...sh.captain } : null,
          merchant: sh.merchant ? { ...sh.merchant } : null,
          crew: Array.isArray(sh.crew) ? sh.crew.slice(0, 3).map((m) => ({ ...m })) : [],
        });
      }
    }

    // 2. Partner-port merchantmen anchored in the roadstead scaled to genuine harbour population & trade capacity.
    const roadsteadTarget = Math.min(5, Math.max(pop >= 1200 ? 4 : 1, Math.floor(pop / 1400)));
    const roadsteadDuties = [
      `anchored in the ${portName} roadstead discharging cargo`,
      `riding at anchor off ${portName} awaiting customs clearance`,
      `lying at moorings in ${portName} bay taking on ballast and wine`,
      `anchored off ${portName} trading salt and spice`,
      `waiting on the tide in ${portName} roadstead`,
    ];
    while (roadsteadIdx < roadsteadTarget && PARTNER_REGISTRY.ports.length > 0) {
      const idx = roadsteadIdx++;
      const port = PARTNER_REGISTRY.ports[(idx + 1) % PARTNER_REGISTRY.ports.length];
      const homePort = port?.name || 'Sevilla';
      const shipNames = port?.shipNames?.length ? port.shipNames : ['São Cristóvão', 'Nossa Senhora da Luz', 'Bom Jesus', 'Espírito Santo'];
      const shipName = shipNames[maritimeHash(worldSeed, idx + 307, 11) % shipNames.length];
      const kind = (idx % 2 === 0) ? 'carrack' : 'great cog';
      const duty = roadsteadDuties[idx % roadsteadDuties.length];
      const pickPartner = (list, salt, fbRole, fbName) => {
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
      const captBase = pickPartner(port?.captains, 17, 'shipmaster', 'Pero Álvares');
      const merchBase = pickPartner(port?.merchants, 31, 'merchant', 'Rui Gonçalves');
      const crew = ['helmsman', 'lookout', 'bosun'].map((role, ci) => {
        const mBase = pickPartner(port?.mariners, 53 + ci * 13, 'boatman', `Mateus #${ci + 1}`);
        touchMaritimePersonLife(mBase, { role, homePort, nowLine: `Now ${duty} aboard ${shipName} (of ${homePort})` });
        return {
          id: mBase.id, name: mBase.name, surname: mBase.surname || '', sex: mBase.sex || 'm',
          age: mBase.age || 27, role, trade: mBase.role || 'boatman', homePort, shipName,
        };
      });
      touchMaritimePersonLife(captBase, {
        role: 'shipmaster',
        homePort,
        nowLine: `Now commanding ${shipName} (of ${homePort}), ${duty}`,
        initialLog: [`Commands ${kind} ${shipName} out of ${homePort}, ${duty}`],
      });
      touchMaritimePersonLife(merchBase, {
        role: 'merchant',
        homePort,
        nowLine: `Now supercargo aboard ${shipName} (of ${homePort}), ${duty}`,
        initialLog: [`Supercargo aboard ${shipName} of ${homePort}, ${duty}`],
      });
      fleet.push({
        slot: `roadstead:${idx}`,
        kind,
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
      });
    }

    // 3. Local fishing barques & harbour lighterage caravels scaled to real `hub.folk` fishers/boatmen & `hub.stores.fish`.
    const localMariners = (hub?.folk || []).filter((p) => p && !p.dead && !used.has(p.id) && (p.tr === 'fisher' || p.tr === 'boatman' || p.tr === 'shipwright' || p.tr === 'roper'));
    const localMerchants = (hub?.folk || []).filter((p) => p && !p.dead && !used.has(p.id) && (p.tr === 'salter' || p.tr === 'merchant' || p.tr === 'chandler' || p.tr === 'cooper'));
    const barqueCap = Math.min(
      6,
      Math.max(
        localMariners.length >= 4 ? 4 : Math.floor(localMariners.length / 2),
        Math.min(6, Math.floor(pop / 1100) + Math.min(3, Math.floor(fishStore / 55)))
      )
    );
    const localBarqueNames = ['Nossa Senhora da Guia', 'São Pedro de Alfama', 'Bom Jesus do Tejo', 'Flor da Ribeira', 'Santa Maria de Belém', 'São Rafael'];
    const harborDuties = [
      `working the ${portName} fishing banks & landing catch`,
      `plying ${portName} harbor lighterage between anchorage and quay`,
      `ferrying casks and salt fish across ${portName} roadstead`,
      `standing across ${portName} estuary under lateen canvas`,
      `tending merchantmen anchored off ${portName}`,
      `hauling nets and stockfish into ${portName}`,
    ];
    let marCursor = 0, merCursor = 0;
    const coastalPort = PARTNER_REGISTRY.byAlias.get('porto') || PARTNER_REGISTRY.ports[0] || null;
    for (let bi = 0; bi < barqueCap; bi++) {
      const kind = (bi % 2 === 0) ? 'barque' : 'caravel';
      const shipName = localBarqueNames[bi % localBarqueNames.length];
      const duty = harborDuties[bi % harborDuties.length];
      let captainObj = null, merchantObj = null;
      const crew = [];
      if (marCursor < localMariners.length) {
        const p = localMariners[marCursor++];
        used.add(p.id);
        captainObj = {
          id: p.id,
          name: typeof folkName === 'function' ? folkName(p) : (p.gn || 'Mestre'),
          surname: typeof famName === 'function' ? famName(p) : '',
          sex: p.sx || 'm',
          age: typeof ageYrs === 'function' ? Math.round(ageYrs(p)) : 34,
          role: 'shipmaster',
          trade: p.tr || 'fisher',
          settlementId: hubIdx,
          homePort: portName,
          shipName,
        };
      } else if (coastalPort?.captains?.length) {
        const c = coastalPort.captains[(bi + 3) % coastalPort.captains.length];
        touchMaritimePersonLife(c, { role: 'shipmaster', homePort: coastalPort.name, nowLine: `Now ${duty} aboard ${shipName}` });
        captainObj = {
          id: c.id, name: c.name, surname: c.surname || '', sex: c.sex || 'm',
          age: c.age || 35, role: 'shipmaster', trade: c.role || 'boatman', homePort: coastalPort.name, shipName,
        };
      }
      if (merCursor < localMerchants.length) {
        const m = localMerchants[merCursor++];
        used.add(m.id);
        merchantObj = {
          id: m.id,
          name: typeof folkName === 'function' ? folkName(m) : (m.gn || 'Mercador'),
          surname: typeof famName === 'function' ? famName(m) : '',
          sex: m.sx || 'm',
          age: typeof ageYrs === 'function' ? Math.round(ageYrs(m)) : 33,
          role: 'merchant',
          trade: m.tr || 'salter',
          settlementId: hubIdx,
          homePort: portName,
          shipName,
        };
      } else if (coastalPort?.merchants?.length) {
        const m = coastalPort.merchants[(bi + 2) % coastalPort.merchants.length];
        touchMaritimePersonLife(m, { role: 'merchant', homePort: coastalPort.name, nowLine: `Now ${duty} aboard ${shipName}` });
        merchantObj = {
          id: m.id, name: m.name, surname: m.surname || '', sex: m.sex || 'm',
          age: m.age || 32, role: 'merchant', trade: m.role || 'merchant', homePort: coastalPort.name, shipName,
        };
      }
      for (const role of ['helmsman', 'lookout', 'mariner']) {
        if (marCursor < localMariners.length) {
          const cm = localMariners[marCursor++];
          used.add(cm.id);
          crew.push({
            id: cm.id,
            name: typeof folkName === 'function' ? folkName(cm) : (cm.gn || 'Pescador'),
            surname: typeof famName === 'function' ? famName(cm) : '',
            sex: cm.sx || 'm',
            age: typeof ageYrs === 'function' ? Math.round(ageYrs(cm)) : 26,
            role,
            trade: cm.tr || 'fisher',
            settlementId: hubIdx,
            homePort: portName,
            shipName,
          });
        } else if (coastalPort?.mariners?.length) {
          const cm = coastalPort.mariners[(bi * 3 + crew.length) % coastalPort.mariners.length];
          crew.push({
            id: cm.id, name: cm.name, surname: cm.surname || '', sex: cm.sex || 'm',
            age: cm.age || 26, role, trade: cm.role || 'boatman', homePort: coastalPort.name, shipName,
          });
        }
      }
      if (captainObj) {
        fleet.push({
          slot: `harbor:${bi}`,
          kind,
          shipName,
          homePort: captainObj.homePort || portName,
          captain: captainObj,
          merchant: merchantObj,
          crew,
        });
      }
    }
    const lives = ensureMaritimeLivesStore();
    lives.harborFleet = fleet;
    return fleet;
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
      const good = String(b.good || 'fish');
      const qty = Math.max(2, Math.min(5, Math.round(b.qty || 3)));
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
        phaseOffset: Number.isFinite(b.phaseOffset) ? b.phaseOffset : +(((i * 0.23) % 0.92) + 0.04).toFixed(4),
        depart: b.departDay ?? day(),
        arrive: b.arriveDay ?? (day() + 3),
        good,
        qty,
        cargo: { [good]: qty },
        oarsmen: Math.max(2, oarsCount),
        pilot: b.pilot ? {
          id: b.pilot.id,
          name: String(b.pilot.name || 'Barqueiro'),
          role: 'river pilot',
          settlementId: b.pilot.settlementId ?? b.si ?? 0,
          trade: 'boatman',
          homePort,
          shipName,
        } : null,
        merchant: b.merchant ? {
          id: b.merchant.id,
          name: String(b.merchant.name || 'Mercador'),
          role: 'merchant',
          settlementId: b.merchant.settlementId ?? b.si ?? 0,
          trade: String(b.merchant.trade || 'merchant'),
          homePort,
          shipName,
          cargoSummary: `${qty} ${good}`,
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

  function buildPartnerTelemetry(shipList, seaCaravans) {
    const today = day();
    const cw = W?.coinWeight || 1;
    const partnerMarkets = ensurePartnerMarkets(today);
    const hub = W?.settlements?.find((s) => s?.harbor) || W?.settlements?.[0] || null;
    const hubPrices = {};
    for (const g of TELEMETRY_GOODS) {
      const base = (typeof GOODBASE !== 'undefined' && GOODBASE[g]) ? GOODBASE[g] : 1;
      hubPrices[g] = hub && typeof price === 'function' && GOODBASE?.[g] ? +price(hub, g).toFixed(3) : +(base / cw).toFixed(3);
    }
    return PARTNER_BENCHMARKS.map((pb, pIdx) => {
      const reg = PARTNER_REGISTRY.byAlias.get(pb.name.toLowerCase()) || PARTNER_REGISTRY.ports[pIdx] || null;
      const pm = partnerMarkets[pb.name] || null;
      const prices = {};
      const stocks = {};
      for (const g of TELEMETRY_GOODS) {
        const base = ((typeof GOODBASE !== 'undefined' && GOODBASE[g]) ? GOODBASE[g] : 1) / cw;
        prices[g] = pm?.prices?.[g] ?? +(base * (pb.g[g] ?? 1.0)).toFixed(3);
        stocks[g] = Math.round(pm?.stocks?.[g] ?? 60);
      }
      const matchPort = (str) => matchPartnerBenchmarkName(str, pb.name);
      const portShips = (shipList || []).filter((sh) => matchPort(sh.homePort) || matchPort(sh.from) || matchPort(sh.to));
      const portSea = (seaCaravans || []).filter((c) => matchPort(c.homePort));
      let importsToHub = 0, exportsFromHub = 0;
      for (const [g, q] of Object.entries(pm?.cumExports || {})) {
        importsToHub += (Number(q) || 0) * (hubPrices[g] || prices[g] || 1);
      }
      for (const [g, q] of Object.entries(pm?.cumImports || {})) {
        exportsFromHub += (Number(q) || 0) * (hubPrices[g] || prices[g] || 1);
      }
      const manifests = [];
      for (const sh of portShips) {
        manifests.push({
          shipName: sh.shipName || sh.kind,
          kind: sh.kind,
          phase: sh.phase,
          merchant: sh.merchant?.name || sh.master || '',
          summary: formatCargoBrief(sh.phase === 'out' ? sh.load : sh.cargo),
        });
      }
      for (const c of portSea) {
        const val = (Number(c.qty) || 0) * (hubPrices[c.good] || 1);
        importsToHub += val * 0.5;
        exportsFromHub += val * 0.5;
      }
      const foreignMerchants = (reg?.merchants?.length || 0) + portShips.filter((s) => s.merchant).length;
      return {
        name: pb.name,
        country: pb.country,
        distanceNm: pb.distanceNm,
        prices,
        stocks,
        hubPrices,
        activeShips: portShips.length + portSea.length,
        foreignMerchants: Math.max(2, foreignMerchants),
        importsCrowns: +importsToHub.toFixed(1),
        exportsCrowns: +exportsFromHub.toFixed(1),
        balanceCrowns: +(exportsFromHub - importsToHub).toFixed(1),
        manifests: manifests.slice(0, 4),
      };
    });
  }

  function isMountedTravellerRecord(t) {
    if (!t || t.errand || t.why === AT_SEA) return false;
    if (t.lord) return true;
    const why = String(t.why || '').toLowerCase();
    if (why.includes('eyre') || why.includes('envoy') || why.includes('court') || why.includes('parliament') || why.includes('bailiff')) {
      return true;
    }
    const p = t.p;
    if (!p || p.dead) return false;
    const off = typeof officeHeld === 'function' ? officeHeld(p) : (p.office || p.estateOffice || '');
    if (off === 'sheriff' || off === 'bailiff' || off === 'steward' || off === 'warden' || off === 'mayor' || off === 'burgess' || off === 'marshal') {
      return true;
    }
    const tr = String(p.tr || '');
    if (tr === 'reeve' || tr === 'merchant' || tr === 'forester' || tr === 'messenger' || tr === 'courier') {
      const hh = typeof householdAccount === 'function' ? householdAccount(p) : null;
      if ((hh?.assets?.horses || 0) >= 1 || (t.len || 0) >= 380) return true;
    }
    return false;
  }

  function collectMountedRoadRiders(now) {
    const riders = [];
    const S = W?.settlements || [];
    // 1. Royal envoys (`W.envoys`) riding dispatches between the Crown and noble seats.
    (W?.envoys || []).forEach((e, idx) => {
      if (!e || !Array.isArray(e.poly) || e.poly.length < 2) return;
      const dep0 = Number.isFinite(e.depart) ? e.depart : now;
      const arr0 = Number.isFinite(e.arrive) ? e.arrive : dep0 + 1.5;
      const dec0 = Number.isFinite(e.decide) ? e.decide : arr0 + 1;
      const back0 = Number.isFinite(e.back) ? e.back : dec0 + 1.5;
      if (now > back0 + 0.05) return;
      const returning = now >= dec0;
      const poly = returning ? [...e.poly].reverse() : e.poly;
      const depart = returning ? dec0 : dep0;
      const arrive = returning ? Math.max(depart + 0.35, back0) : Math.max(depart + 0.35, now < arr0 ? arr0 : dec0);
      const pts = line(poly);
      if (pts.length < 4) return;
      riders.push({
        key: `envoy:${e.id ?? idx}:${returning ? 'back' : 'out'}`,
        mode: 'rider',
        mounted: true,
        role: 'royal envoy',
        person: {
          id: 1_850_000 + (e.id ?? idx),
          name: `Correio Real #${(e.id ?? idx) + 1}`,
          role: 'royal envoy',
        },
        about: String(e.about || 'royal dispatch'),
        origin: returning ? (e.to ?? 0) : 0,
        dest: returning ? 0 : (e.to ?? 0),
        depart: +depart.toFixed(3),
        arrive: +arrive.toFixed(3),
        carts: 1,
        phaseOffset: 0,
        points: pts,
      });
    });

    // 2. Noble lords & retinues on house journeys (`W.houses[hi].journey`).
    (W?.houses || []).forEach((h, hi) => {
      const j = h?.journey;
      if (!j || !Array.isArray(j.poly) || j.poly.length < 2 || !(j.arrive > j.depart) || now > j.arrive) return;
      const head = h.head != null && typeof notableById === 'function' ? notableById(h.head) : null;
      const pts = line(j.poly);
      if (pts.length < 4) return;
      riders.push({
        key: `house-rider:${hi}:${j.depart}`,
        mode: 'rider',
        mounted: true,
        role: 'lord',
        person: {
          id: head ? NOTABLE_PERSON_BASE + head.id : (1_860_000 + hi),
          name: head?.name || h.name || `Lord #${hi}`,
          role: 'lord',
        },
        origin: j.from ?? h.seat ?? 0,
        dest: j.to ?? 0,
        depart: +j.depart.toFixed(3),
        arrive: +j.arrive.toFixed(3),
        carts: 1,
        phaseOffset: 0,
        points: pts,
      });
    });

    // 3. Mounted `W.travellers` (lords, royal eyre justices, bailiffs, mayors, burgesses, horse-owning travellers).
    const travs = W?.travellers || [];
    for (let ti = 0; ti < travs.length && riders.length < 28; ti++) {
      const t = travs[ti];
      if (!isMountedTravellerRecord(t)) continue;
      if (!Array.isArray(t.poly) || t.poly.length < 2) continue;
      const dep = Number(t.depart);
      const arr = Number(t.arrive);
      if (!Number.isFinite(dep) || !Number.isFinite(arr) || !(arr > dep) || now < dep - 0.1 || now > arr + 0.1) continue;
      const pts = line(t.poly);
      if (pts.length < 4) continue;
      const p = t.p;
      const off = p && typeof officeHeld === 'function' ? officeHeld(p) : (p?.office || p?.estateOffice || '');
      const role = t.lord ? 'lord' : (String(t.why || '').includes('eyre') ? 'eyre justice' : (off || p?.tr || 'rider'));
      const pName = p && typeof folkName === 'function' ? folkName(p) : (p?.name || p?.gn || `Cavaleiro #${ti + 1}`);
      riders.push({
        key: `trav:${p?.id ?? ti}:${dep.toFixed(1)}`,
        mode: 'rider',
        mounted: true,
        role: String(role),
        why: String(t.why || ''),
        person: {
          id: p?.id ?? (1_870_000 + ti),
          name: pName,
          role: String(role),
          home: S[t.from ?? 0]?.name || '',
        },
        origin: t.from ?? 0,
        dest: t.to ?? 0,
        depart: +dep.toFixed(3),
        arrive: +arr.toFixed(3),
        carts: 1,
        phaseOffset: +(((ti * 0.19) % 0.85) + 0.05).toFixed(4),
        points: pts,
      });
    }
    return riders;
  }

  function caravans() {
    ensureMaritimeWorldRoutes();
    const out = [];
    const seaOut = [];
    const S = W.settlements || [];
    const now = day();

    // 100% genuine `W.caravans` consignments (`cart` | `river` | `sea`) — zero synthetic road-parcel filler.
    (W.caravans || []).forEach((c, index) => {
      if (!c || c.gone || c.robbed || !Array.isArray(c.poly) || c.poly.length < 2) return;
      let mode = c.sea ? 'sea' : c.river ? 'river' : 'cart';
      if (mode === 'sea' && (!S[c.origin]?.harbor || !S[c.dest]?.harbor)) {
        mode = (S[c.origin]?.riverside || S[c.dest]?.riverside || S[c.origin]?.river || S[c.dest]?.river) ? 'river' : 'cart';
      }
      let baseKey = null;
      try { baseKey = typeof caravanInspectionKey === 'function' ? String(caravanInspectionKey(c)) : null; } catch { baseKey = null; }
      baseKey = baseKey ?? `${c.origin}>${c.dest}:${c.departDay}:${c.good}`;
      const pts = line(c.poly);

      if (mode === 'cart') {
        const goodStr = String(c.good ?? 'grain');
        const isLivestockGood = goodStr === 'sheep' || goodStr === 'cattle' || goodStr === 'swine' || goodStr === 'horses';
        const rawQty = Math.round(c.qty || 0);
        if (isLivestockGood && rawQty >= 6) {
          const droveCount = Math.max(1, Math.min(4, Math.floor(rawQty / 9)));
          let remaining = rawQty;
          for (let p = 0; p < droveCount; p++) {
            const left = droveCount - p;
            const droveQty = left === 1 ? Math.max(6, remaining) : Math.max(6, Math.min(12, Math.round(remaining / left)));
            remaining = Math.max(6, remaining - droveQty);
            const phaseOffset = +(0.04 + ((((p + 0.5) / droveCount) + index * 0.173) % 1) * 0.92).toFixed(4);
            out.push({
              key: droveCount > 1 ? `${baseKey}#d${p}` : baseKey,
              consignmentKey: baseKey,
              index,
              mode: 'cart',
              drove: true,
              good: goodStr,
              qty: droveQty,
              origin: c.origin,
              dest: c.dest,
              depart: c.departDay,
              arrive: Math.max((c.departDay || now) + 0.5, c.arriveDay || (now + 4)),
              halted: !!c.halted,
              carts: 1,
              phaseOffset,
              points: pts,
            });
          }
          return;
        }
        const totalQty = Math.max(2, rawQty || 4);
        const parcelCount = Math.max(1, Math.min(12, Math.ceil(totalQty / 4)));
        let remaining = totalQty;
        for (let p = 0; p < parcelCount; p++) {
          const leftParcels = parcelCount - p;
          const parcelQty = leftParcels === 1
            ? Math.max(1, remaining)
            : Math.max(1, Math.min(5, Math.round(remaining / leftParcels)));
          remaining = Math.max(0, remaining - parcelQty);
          const phaseOffset = +(0.04 + ((((p + 0.5) / parcelCount) + index * 0.173) % 1) * 0.92).toFixed(4);
          out.push({
            key: parcelCount > 1 ? `${baseKey}#p${p}` : baseKey,
            consignmentKey: baseKey,
            index,
            mode: 'cart',
            drove: false,
            good: goodStr,
            qty: parcelQty,
            origin: c.origin,
            dest: c.dest,
            depart: c.departDay,
            arrive: Math.max((c.departDay || now) + 0.5, c.arriveDay || (now + 4)),
            halted: !!c.halted,
            carts: 1,
            phaseOffset,
            points: pts,
          });
        }
        return;
      }

      const entry = {
        key: baseKey,
        index,
        mode,
        good: String(c.good ?? ''),
        qty: Math.round(c.qty || 0),
        origin: c.origin,
        dest: c.dest,
        depart: c.departDay,
        arrive: c.arriveDay,
        halted: !!c.halted,
        carts: 1,
        phaseOffset: +(((index * 0.23) % 0.88) + 0.06).toFixed(4),
        points: pts,
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
          trade: 'boatman',
          homePort,
          shipName,
        } : null;
        entry.oarsmen = Math.max(2, Array.isArray(c.oarsmen) ? c.oarsmen.length : 4);
        entry.crew = Array.isArray(c.oarsmen) ? c.oarsmen.map((o) => ({
          id: o.id,
          name: String(o.name || 'Remador'),
          role: 'oarsman',
          settlementId: o.settlementId ?? c.origin ?? 0,
          trade: 'boatman',
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
        seaOut.push(entry);
      }
      out.push(entry);
    });

    const riders = collectMountedRoadRiders(now);
    const shipList = ships();
    const riverBoatList = riverBoats();
    const hub = S.find((s) => s?.harbor) || S[0] || null;
    const settlements = S.map((s, idx) => {
      const prices = {}, stores = {};
      for (const g of TELEMETRY_GOODS) {
        const base = (typeof GOODBASE !== 'undefined' && GOODBASE[g]) ? GOODBASE[g] : 1;
        prices[g] = s && typeof price === 'function' && GOODBASE?.[g] ? +price(s, g).toFixed(3) : +base.toFixed(3);
        stores[g] = Math.round(Number(s?.stores?.[g]) || 0);
      }
      return {
        index: idx,
        name: String(s?.name || `Place ${idx + 1}`),
        kind: String(s?.kind || 'village'),
        pop: Math.round(s?.pop || 0),
        harbor: Boolean(s?.harbor),
        riverside: Boolean(s?.riverside || s?.river),
        x: r1(s?.pos?.x || 0),
        z: r1(s?.pos?.z || 0),
        tradeV: Math.round(s?.tradeV || 0),
        prices,
        stores,
      };
    });

    return {
      day: now,
      year: typeof AD === 'function' ? AD() : 1550,
      date: typeof dateStr === 'function' ? dateStr(now) : `Day ${Math.floor(now)}`,
      realm: String(W?.name || hub?.name || 'Lisboa'),
      coinWeight: +(W?.coinWeight || 1).toFixed(4),
      weather: { state: String(W.weather?.state ?? 'clear'), wind: r3(W.weather?.wind ?? 0) },
      list: out,
      riders,
      riverBoats: riverBoatList,
      ships: shipList,
      harborFleet: harborFleet(),
      partnerPorts: buildPartnerTelemetry(shipList, seaOut),
      settlements,
    };
  }

  // Purely read-only unpadded economic & civic diagnostics directly from `W`.
  function diagnostics(place = 0) {
    if (!W) return null;
    const { s } = resolvePlace(place);
    const now = day();
    const S = W.settlements || [];
    const seasons = ['Spring', 'Summer', 'Autumn', 'Winter'];
    const sIdx = typeof seasonIdx === 'function' ? (seasonIdx() & 3) : (Math.floor(((now % 360) + 360) % 360 / 90) & 3);
    const bal = (typeof accountBalances === 'function' && s) ? accountBalances(s) : null;
    const households = (typeof householdsOf === 'function' && s)
      ? householdsOf(s).length
      : (s?.folk || []).filter((p) => p && !p.dead && (typeof householdHead !== 'function' || householdHead(p) === p)).length;
    const diagGoods = ['grain', 'fish', 'wine', 'timber', 'cloth', 'spice'];
    const stores = {}, prices = {};
    for (const g of diagGoods) {
      stores[g] = +(Number(s?.stores?.[g]) || 0).toFixed(1);
      const base = (typeof GOODBASE !== 'undefined' && GOODBASE[g]) ? GOODBASE[g] : 1;
      prices[g] = +(s && typeof price === 'function' ? price(s, g) : base).toFixed(3);
    }
    let cartCaravans = 0, riverCaravans = 0, seaCaravans = 0;
    for (const c of W.caravans || []) {
      if (!c || c.gone || c.robbed || !Array.isArray(c.poly) || c.poly.length < 2) continue;
      if (c.sea) seaCaravans++;
      else if (c.river) riverCaravans++;
      else cartCaravans++;
    }
    const envoys = (W.envoys || []).filter((e) => e && now <= (e.back ?? Infinity)).length;
    let mountedTravellers = 0;
    for (const t of W.travellers || []) {
      if (isMountedTravellerRecord(t) && now >= (t.depart ?? -Infinity) - 0.1 && now <= (t.arrive ?? -Infinity) + 0.1) {
        mountedTravellers++;
      }
    }
    for (const h of W.houses || []) {
      if (h?.journey && now <= (h.journey.arrive ?? -Infinity)) mountedTravellers++;
    }
    let buildings = 0, ruins = 0, streets = 0;
    for (const st of S) {
      for (const b of st?.buildings || []) {
        if (!b || b.removed || b.state === 'gone') continue;
        if (b.state === 'sound') buildings++;
        else ruins++;
      }
      for (const t of st?.streets || []) {
        if (t && !t.hidden && !t.gone && t.kind !== 'edge' && (t.pts?.length || 0) > 1) streets++;
      }
    }
    const projects = (W.projects || []).filter((q) => q && !q.dead).length;
    const roads = (W.roads || []).filter((r) => r && Array.isArray(r.drawn || r.path)).length;
    const mon = W.monarch && W.monarch.alive ? {
      id: NOTABLE_PERSON_BASE + W.monarch.id,
      notableId: W.monarch.id,
      name: String(W.monarch.name || ''),
      title: typeof fullTitle === 'function'
        ? fullTitle(W.monarch)
        : `${W.monarch.sex === 'f' ? 'Queen' : 'King'} ${W.monarch.name || ''}`,
      sex: W.monarch.sex || null,
      age: Math.round(Number(W.monarch.age) || 0),
      house: String(W.houses?.[0]?.name || 'Royal House'),
    } : null;

    return {
      day: now,
      year: typeof AD === 'function' ? AD() : 1550,
      season: seasons[sIdx],
      dateLabel: typeof dateStr === 'function' ? dateStr(now) : `Day ${Math.floor(now)}`,
      pop: Math.round(Number(s?.pop) || 0),
      realmPop: Math.round(S.reduce((sum, o) => sum + (Number(o?.pop) || 0), 0)),
      households,
      crownTreasury: +(Number(W.treasury) || 0).toFixed(1),
      townChest: +((bal ? (bal.by.townFunds || 0) + (bal.by.guilds || 0) + (bal.by.craftFunds || 0) : (Number(s?.murage) || 0))).toFixed(1),
      householdCoin: +(bal ? (bal.by.households || 0) : 0).toFixed(1),
      unrest: +(Number(s?.unrest) || 0).toFixed(1),
      prosperity: +(Number(s?.prosperity) || 0).toFixed(1),
      stores,
      prices,
      traffic: {
        ships: (W.ships || []).filter((sh) => sh && Array.isArray(sh.poly) && sh.poly.length >= 2).length,
        cartCaravans,
        riverCaravans,
        seaCaravans,
        envoys,
        mountedTravellers,
      },
      fabric: {
        buildings,
        projects,
        ruins,
        streets,
        roads,
      },
      monarch: mon,
    };
  }

  return { VERSION, found, live, board, freeze, thaw, serve, folk, watch, embark, disembark, caravans, riverBoats, ships, market, trade, pilotMaritime, diagnostics };
})();
