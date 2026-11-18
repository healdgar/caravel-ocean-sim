// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Headlessly founds and simulates real 1550 partner ports (Sevilla, Porto, Antwerp, Venice, Bordeaux)
// using Castle and Commons' full simulation model (`openBoard` + `live`), extracting genuine simulated
// Shipmasters/Captains, Guild Merchants/Supercargoes, Mariners, their households/kin, and port markets
// so every ship calling at Lisbon carries living people with real biographies, families, and wealth.
//   node scripts/bake-partner-ports.mjs [--out assets/boards/partner-ports-1550.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardRequest } from '../js/board-model.js';
import { openBoard } from './board-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const k = args.indexOf('--' + name); return k >= 0 ? args[k + 1] : fallback; };
const outPath = resolve(root, option('out', 'assets/boards/partner-ports-1550.json'));
const say = (text) => process.stderr.write(text + '\n');

export const PARTNER_PORT_SPECS = Object.freeze([
  {
    index: 0,
    id: 'seville',
    name: 'Sevilla',
    culture: 'iberian',
    seed: 1519,
    seat: 1.25,
    bayYaw: 0.18,
    aliases: ['Seville', 'Sevilla', 'Cádiz', 'Cadiz', 'Sanlúcar', 'Sanlúcar de Barrameda', 'Palos', 'Huelva', 'Goa', 'Malacca'],
    shipNames: [
      'Nuestra Señora de Regla',
      'San Cristóbal',
      'Santa María del Guadalquivir',
      'San Telmo',
      'La Concepción',
      'Espíritu Santo',
    ],
  },
  {
    index: 1,
    id: 'porto',
    name: 'Porto',
    culture: 'portuguese',
    seed: 1494,
    seat: 1.05,
    bayYaw: -0.42,
    aliases: ['Porto', 'Setúbal', 'Setubal', 'La Coruña', 'Corunna', 'Viana'],
    shipNames: [
      'São João Baptista',
      'Nossa Senhora da Graça',
      'Flor do Douro',
      'São Pedro de Miragaia',
      'Bom Jesus',
      'Santa Catarina',
    ],
  },
  {
    index: 2,
    id: 'antwerp',
    name: 'Antwerp',
    culture: 'german',
    seed: 1531,
    seat: 1.20,
    bayYaw: 0.55,
    aliases: ['Antwerp', 'Bruges', 'Lübeck', 'Lubeck', 'Bergen', 'Hamburg', 'Danzig'],
    shipNames: [
      'De Gulden Leeuw',
      'Sint Joris',
      'De Vliegende Zwaan',
      'Vrouwe van Antwerpen',
      'De Witte Valk',
      'Sint Nicolaas',
    ],
  },
  {
    index: 3,
    id: 'venice',
    name: 'Venice',
    culture: 'italian',
    seed: 1508,
    seat: 1.15,
    bayYaw: -0.15,
    aliases: ['Venice', 'Venezia', 'Genoa', 'Genova', 'Alexandria', 'Ragusa', 'Naples'],
    shipNames: [
      'San Marco',
      'Santa Maria della Salute',
      'Leone d’Oro',
      'San Giorgio Maggiore',
      'La Serenissima',
      'Stella Maris',
    ],
  },
  {
    index: 4,
    id: 'bordeaux',
    name: 'Bordeaux',
    culture: 'french',
    seed: 1525,
    seat: 1.05,
    bayYaw: 0.34,
    aliases: ['Bordeaux', 'Bristol', 'La Rochelle', 'Nantes', 'Rouen', 'London'],
    shipNames: [
      'La Belle Marie',
      'Saint-Michel de Gironde',
      'Le Faucon Blanc',
      'Notre-Dame de Bordeaux',
      'L’Étoile d’Aquitaine',
      'Saint-Jacques',
    ],
  },
]);

function makeHarborHeights(spec, n = 257) {
  const heights = new Float32Array(n * n);
  const cy = Math.cos(spec.bayYaw), sy = Math.sin(spec.bayYaw);
  const s1 = (spec.seed % 97) * 0.13;
  for (let j = 0; j < n; j++) {
    const rawV = (j / (n - 1)) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const rawU = (i / (n - 1)) * 2 - 1;
      const u = rawU * cy - rawV * sy;
      const v = rawU * sy + rawV * cy;
      // Sheltered deep-water estuary mouth opening seaward (v > 0.08) + river valley + agricultural hills inland
      const channel = Math.exp(-(u * u) / 0.055);
      let h;
      if (v > 0.08) {
        h = -(v - 0.08) * 30 - channel * 16;
      } else {
        const inlandRise = (0.08 - v) * 36;
        const rolling = Math.sin(u * 4.3 + s1) * Math.cos(v * 3.4 - s1) * 13 + Math.sin(u * 9.1 - v * 7.2) * 3.5;
        const valleyCut = channel * Math.min(22, inlandRise * 0.72 + 2.5);
        h = Math.max(1.8, inlandRise + rolling - valleyCut);
      }
      heights[j * n + i] = h;
    }
  }
  return heights;
}

const CAPTAIN_ROLES = new Set(['boatman', 'shipwright', 'fisher', 'roper', 'merchant']);
const MERCHANT_ROLES = new Set(['merchant', 'spicer', 'salter', 'chandler', 'weaver', 'goldsmith', 'cooper', 'tailor']);
const MARINER_ROLES = new Set(['boatman', 'fisher', 'roper', 'cooper', 'carpenter', 'salter', 'carter']);

function globalPersonId(portIndex, localId) {
  return 2_000_000 + portIndex * 100_000 + (localId | 0);
}

async function simulatePartnerPort(spec) {
  const t0 = performance.now();
  const heights = makeHarborHeights(spec, 257);
  const cy = Math.cos(spec.bayYaw), sy = Math.sin(spec.bayYaw);
  // Seat right above the estuary head on dry harbor ground
  const siteX = Math.round(sy * 260);
  const siteZ = Math.round(cy * 260);
  const req = boardRequest({
    heights,
    span: 7200,
    site: { name: spec.name, culture: spec.culture, x: siteX, z: siteZ },
    seed: spec.seed,
    era: 1550,
    seat: spec.seat,
    lived: 1,
  });
  const open = await openBoard(req);
  try {
    await open.live(24);
    const board = await open.hook('board');
    const market = await open.hook('market', 0);
    const folk = await open.hook('folk', 0, { most: 1, others: 2200 });
    const pool = [...(folk.people || []), ...(folk.others || [])];
    const byId = new Map();
    for (const p of pool) {
      if (p && Number.isInteger(p.id) && !byId.has(p.id)) byId.set(p.id, p);
    }
    const adults = [...byId.values()].filter((p) => (p.age ?? 0) >= 18 && (p.age ?? 0) <= 64);
    const taken = new Set();

    const pickRoster = (preferRoles, preferMale, minAge, maxAge, count, fallbackRole) => {
      const scored = adults
        .filter((p) => !taken.has(p.id) && p.age >= minAge && p.age <= maxAge)
        .map((p) => {
          let s = 0;
          if (preferRoles.has(p.role)) s += 20;
          if (preferMale && p.sex === 'm') s += 6;
          if (p.age >= 25 && p.age <= 50) s += 4;
          return { p, s };
        })
        .sort((a, b) => b.s - a.s || a.p.id - b.p.id);
      const out = [];
      for (const { p } of scored) {
        if (out.length >= count) break;
        taken.add(p.id);
        out.push({
          id: globalPersonId(spec.index, p.id),
          localId: p.id,
          name: p.name,
          surname: p.surname || '',
          sex: p.sex || 'm',
          age: Math.round((p.age || 30) * 10) / 10,
          role: p.role || fallbackRole,
          homePort: spec.name,
        });
      }
      return out;
    };

    const captains = pickRoster(CAPTAIN_ROLES, true, 24, 58, 10, 'shipmaster');
    const merchants = pickRoster(MERCHANT_ROLES, false, 22, 62, 10, 'merchant');
    const mariners = pickRoster(MARINER_ROLES, true, 17, 54, 24, 'boatman');

    // Fetch genuine C&C person cards for every Captain, Merchant, Mariner, plus immediate kin of Captains & Merchants
    const rawCards = new Map();
    const fetchLocalCard = async (localId) => {
      if (rawCards.has(localId)) return rawCards.get(localId);
      const ans = await open.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 'p' + localId, full: true }).catch(() => null);
      if (ans?.kind === 'person' && typeof ans.card === 'string' && ans.card.length > 0) {
        rawCards.set(localId, ans);
        return ans;
      }
      return null;
    };

    const primaryLocalIds = [
      ...captains.map((p) => p.localId),
      ...merchants.map((p) => p.localId),
      ...mariners.map((p) => p.localId),
    ];
    for (const lid of primaryLocalIds) {
      await fetchLocalCard(lid);
    }

    // Also pull up to 3 direct kin cards per captain & merchant so family buttons in `#folk-card` resolve cleanly
    for (const officer of [...captains, ...merchants]) {
      const cardAns = rawCards.get(officer.localId);
      if (!cardAns?.links) continue;
      let kinFetched = 0;
      for (const link of cardAns.links) {
        if (kinFetched >= 3) break;
        if (typeof link?.code === 'string' && /^p\d+$/.test(link.code)) {
          const kinLocalId = Number(link.code.slice(1));
          if (kinLocalId !== officer.localId && !rawCards.has(kinLocalId)) {
            const kAns = await fetchLocalCard(kinLocalId);
            if (kAns) kinFetched++;
          }
        }
      }
    }

    // Remap local `p<id>` links to global IDs, filtering out un-exported links so every button works cleanly
    const cards = {};
    for (const [localId, ans] of rawCards.entries()) {
      const gid = globalPersonId(spec.index, localId);
      const links = [];
      for (const link of ans.links || []) {
        if (typeof link?.code === 'string' && /^p\d+$/.test(link.code)) {
          const targetLocal = Number(link.code.slice(1));
          if (rawCards.has(targetLocal)) {
            links.push({ name: link.name, code: 'p' + globalPersonId(spec.index, targetLocal) });
          }
        }
      }
      cards[String(gid)] = {
        card: ans.card,
        links,
      };
    }

    const compactGoods = {};
    for (const [g, info] of Object.entries(market?.goods || {})) {
      if ((info.store || 0) > 1 || (info.price || 0) > 0) {
        compactGoods[g] = {
          price: info.price,
          store: Math.round((info.store || 0) * 10) / 10,
        };
      }
    }

    const elapsedS = ((performance.now() - t0) / 1000).toFixed(1);
    say(`  ${spec.name} (${spec.culture}): ${board.people} people, ${board.buildings.count} buildings, ${captains.length} captains, ${merchants.length} merchants, ${mariners.length} mariners, ${Object.keys(cards).length} live cards (${elapsedS}s)`);

    return {
      index: spec.index,
      id: spec.id,
      name: spec.name,
      culture: spec.culture,
      seed: spec.seed,
      year: board.year,
      day: board.day,
      people: board.people,
      buildings: board.buildings.count,
      aliases: spec.aliases,
      shipNames: spec.shipNames,
      market: {
        pop: market?.pop ?? board.people,
        prosperity: market?.prosperity ?? 50,
        goods: compactGoods,
      },
      captains,
      merchants,
      mariners,
      cards,
    };
  } finally {
    await open.close();
  }
}

const started = performance.now();
say(`Simulating ${PARTNER_PORT_SPECS.length} pre-seeded 1550 partner ports in parallel...`);
const ports = await Promise.all(PARTNER_PORT_SPECS.map((spec) => simulatePartnerPort(spec)));
ports.sort((a, b) => a.index - b.index);

const payload = {
  format: 'waterworld.partner-ports',
  version: 1,
  year: 1550,
  ports,
};

mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(payload);
writeFileSync(outPath, json + '\n');
say(`Wrote ${outPath} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB across ${ports.reduce((s, p) => s + Object.keys(p.cards).length, 0)} simulated biographies in ${((performance.now() - started) / 1000).toFixed(1)}s)`);
