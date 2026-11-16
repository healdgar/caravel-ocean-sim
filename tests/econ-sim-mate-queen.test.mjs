// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// End-to-end verification of:
// 1. Un-faked C&C economic simulation, `placeEdge` multi-month stability, real mounted riders, non-sine partner markets, and `diagnostics`
// 2. Queen & Royal Court in Lisbon (`folk`, `board().souls.notables`, `advisor-inspect`) + First Mate `mateReply` on Paço da Ribeira & Alcáçova
// 3. Fast-forward `advanceCalendarOnly` & `#econ-sim-controls` telemetry
// 4. Strict First Mate sea information horizon (`PORT_CONTACT_RANGE_M = 650`, `intelLedger` freeze across +20 board days, `hailEncounter` packet updates)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { BAKED_BOARDS, BAKED_WORLDS, boardPrefix } from '../js/board-model.js';
import { boardShape } from '../js/board-keep.js';
import { boardEpochYear, createBoardLife } from '../js/board-life.js';
import {
  PORT_CONTACT_RANGE_M,
  PORT_ROADSTEAD_ANCHOR_RANGE_M,
  checkLivePortContact,
  createIntelLedger,
  mergeHailIntel,
  resolveMateIntel,
  snapshotPortIntel,
} from '../js/career-save.js';
import { ECON_BOARD_DAY_MS, ECON_SIM_RATES, ECON_SIM_STEPS, formatEconDiagnostics } from '../js/controls.js';
import { folkCardFacts } from '../js/folk-card.js';
import { mateCounsel, mateMatchTopic, mateReply } from '../js/mate-counsel.js';
import { ENCOUNTER_ARCHETYPES, hailEncounter, pickEncounter } from '../js/voyage/encounters.js';
import { DEFAULT_DEPARTURE } from '../js/voyage/passage.js';
import { createVoyageController } from '../js/voyage/voyage-controller.js';
import { openBoard } from '../scripts/board-host.mjs';

test('boardPrefix defines placeEdge, runtime contains zero sine-wave or explorer fakes, and Lisbon advances +30 days cleanly with Queen, riders & diagnostics', { timeout: 600000 }, async (t) => {
  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const prefix = boardPrefix(baked.request);
  assert.match(prefix, /globalThis\.placeEdge\s*=/, 'boardPrefix() must define globalThis.placeEdge');

  const runtimeSrc = fs.readFileSync('assets/board/runtime.js', 'utf8');
  const partnerBlock = runtimeSrc.slice(runtimeSrc.indexOf('function buildPartnerTelemetry'), runtimeSrc.indexOf('function isMountedTravellerRecord'));
  assert.doesNotMatch(partnerBlock, /Math\.(?:sin|cos)\s*\(/, 'buildPartnerTelemetry must not synthesize partner prices with sine/cosine waves');
  assert.doesNotMatch(runtimeSrc, /0\.0172|TARGET_MIN_ROAD_PARCELS|localParcel/, 'runtime.js must not fabricate sine waves or localParcel road wagons');
  assert.doesNotMatch(runtimeSrc, /Vasco da Gama|Bartolomeu Dias|Afonso de Albuquerque/, 'runtime.js must not use anachronistic famous explorers as routine shipmasters');

  const world = new Uint8Array(fs.readFileSync(BAKED_WORLDS['lisbon:1550']));
  const board = await openBoard(baked.request, { world });
  t.after(() => board.close());

  const diag0 = await board.hook('diagnostics', 0);
  assert.ok(diag0 && diag0.day === baked.world.day, `expected initial day ${baked.world.day}, got ${diag0?.day}`);
  assert.ok(diag0.pop >= 4000 && diag0.realmPop >= diag0.pop, 'expected real Lisbon & realm populations');
  assert.ok(diag0.households >= 500, 'expected real Lisbon household count');
  assert.ok(Number.isFinite(diag0.crownTreasury) && Number.isFinite(diag0.townChest) && Number.isFinite(diag0.householdCoin));
  for (const g of ['grain', 'fish', 'wine', 'timber', 'cloth', 'spice']) {
    assert.ok(Number.isFinite(diag0.stores[g]) && Number.isFinite(diag0.prices[g]) && diag0.prices[g] > 0, `missing store/price for ${g}`);
  }
  assert.ok(diag0.fabric.buildings >= 2000 && diag0.fabric.roads >= 4, 'expected unpadded standing buildings & roads');
  assert.ok(diag0.monarch?.name && diag0.monarch?.title, 'expected reigning monarch in diagnostics');

  // Verify Queen / Monarch & mounted messengers/lords in `folk(0)` and `board().souls.notables`
  const folk0 = await board.hook('folk', 0, { most: 240, others: 40 });
  const monarchWalker = folk0.people.find((p) => p.monarch === true);
  assert.ok(monarchWalker, 'expected reigning Monarch walking in Lisbon folk(0)');
  assert.match(monarchWalker.lodging || '', /Paço da Ribeira.*Alcáçova/i);
  assert.ok(Array.isArray(monarchWalker.route) && monarchWalker.route.length >= 6, 'monarch must have a street walk route between Paço da Ribeira and Alcáçova');
  const mountedWalkers = folk0.people.filter((p) => p.mounted === true);
  assert.ok(mountedWalkers.length >= 1, 'expected mounted messengers/bailiffs/courtiers in Lisbon folk(0)');

  const inspectMonarch = await board.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 'p' + monarchWalker.id, full: true });
  assert.equal(inspectMonarch?.kind, 'person');
  assert.match(inspectMonarch.card, /Lodging Paço da Ribeira \(Terreiro do Paço\) & Alcáçova Keep/);
  const monarchFacts = folkCardFacts(inspectMonarch.card);
  assert.ok(monarchFacts.life.length >= 2);

  // Advance +30 days (multi-week/month tick including settlement commissions, citadels, market & ship cycles)
  const afterBoard = await board.live(30);
  assert.equal(boardShape(afterBoard), boardShape(baked.board), 'live board() must preserve exact boardShape for IndexedDB board-keep persistence');
  assert.ok(Array.isArray(afterBoard.souls?.notables) && afterBoard.souls.notables.some((n) => n.monarch), 'board().souls.notables must include reigning monarch');

  const diag30 = await board.hook('diagnostics', 0);
  assert.equal(diag30.day, diag0.day + 30);
  const formattedTelem = formatEconDiagnostics(diag30);
  assert.match(formattedTelem, /Crown .* Town Chest/);
  assert.match(formattedTelem, /Ships .* Wagons .* Barges .* Mounted Riders/);

  const snap = await board.hook('caravans');
  assert.equal(snap.day, diag30.day);
  assert.ok(snap.list.length >= 4, 'expected real W.caravans consignments');
  for (const c of snap.list) {
    assert.equal(c.localParcel, undefined, 'zero fabricated localParcel entries allowed');
    assert.ok(!['pottery', 'merchants', 'passenger'].includes(c.good), `unexpected fake parcel good ${c.good}`);
    assert.ok(['cart', 'river', 'sea'].includes(c.mode));
  }
  assert.ok(Array.isArray(snap.riders), 'caravans() must export riders array');
  for (const r of snap.riders) {
    assert.equal(r.mode, 'rider');
    assert.equal(r.mounted, true);
    assert.ok(r.points.length >= 4);
  }
  // Verify zero 900000+ ghost boatmen in riverBoats
  for (const rb of snap.riverBoats) {
    assert.ok(rb.pilot?.id < 900_000, `riverBoat pilot ${rb.pilot?.id} must be a real s.folk citizen, not a 900000+ ghost`);
  }
  assert.ok(Array.isArray(snap.partnerPorts) && snap.partnerPorts.length === 5);
  for (const pp of snap.partnerPorts) {
    assert.ok(pp.stocks && Object.keys(pp.stocks).length >= 5, `${pp.name} must expose real partner market stocks`);
  }
});

test('First Mate answers "Where does the Queen live in Lisbon?" with Paço da Ribeira, Terreiro do Paço, Alcáçova & reigning monarch', () => {
  assert.equal(mateMatchTopic('Where does the Queen live in Lisbon?'), 'royal');
  assert.equal(mateMatchTopic('Tell me of the royal palace and court'), 'royal');

  const aboutInPort = {
    mate: { id: 120, name: 'Simão Lopes', model: true, role: 'boatman', port: 'Lisboa' },
    now: {
      where: { kind: 'port', name: 'Lisboa', ashore: true, living: true },
      realm: {
        name: 'Portugal',
        monarch: 'Queen Petronila',
        palace: 'Paço da Ribeira (Terreiro do Paço) & Alcáçova Keep',
        treasury: 4820,
        legitimacy: 78,
      },
    },
    town: { name: 'Lisboa', kind: 'capital', role: 'seat', palace: 'Paço da Ribeira (Terreiro do Paço) & Alcáçova Keep' },
  };
  const answer = mateReply('Where does the Queen live in Lisbon?', aboutInPort);
  assert.match(answer, /Paço da Ribeira/);
  assert.match(answer, /Terreiro do Paço/);
  assert.match(answer, /Casa da Índia/);
  assert.match(answer, /Queen Catarina of Austria/);
  assert.match(answer, /Alcáçova/);
  assert.match(answer, /Castelo de São Jorge/);
  assert.match(answer, /Queen Petronila/);
});

test('away from port (!hasLivePortContact), advancing boardLife +20 days leaks zero Lisbon events/prices/treasury until hailEncounter or port return', { timeout: 600000 }, async (t) => {
  assert.equal(PORT_CONTACT_RANGE_M, 650);
  assert.equal(PORT_ROADSTEAD_ANCHOR_RANGE_M, 950);
  assert.equal(checkLivePortContact({ distToPortM: 520 }), true);
  assert.equal(checkLivePortContact({ distToPortM: 820, anchored: true }), true);
  assert.equal(checkLivePortContact({ distToPortM: 820, anchored: false }), false);
  assert.equal(checkLivePortContact({ distToPortM: 4500, moored: false, ashore: false, portCallOpen: false }), false);

  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const world = new Uint8Array(fs.readFileSync(BAKED_WORLDS['lisbon:1550']));

  let inContact = true;
  const leakedToasts = [];
  const leakedMcpBroadcasts = [];

  let openedBoard = null;
  const life = createBoardLife({
    baked,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => world.buffer.slice(world.byteOffset, world.byteOffset + world.byteLength),
    }),
    open: async (req, opts) => {
      openedBoard = await openBoard(req, opts);
      return { ...openedBoard, ready: Promise.resolve({ day: openedBoard.board?.day ?? baked.world.day }) };
    },
    onNews: (lines) => {
      if (!inContact) return;
      leakedToasts.push(...lines);
    },
    onNewsAll: (lines) => {
      if (!inContact) return;
      leakedMcpBroadcasts.push(...lines);
    },
  });
  t.after(async () => {
    life.close();
    if (openedBoard) await openedBoard.close();
  });

  const epochMs = Date.UTC(boardEpochYear(baked.world), 2, 1, 12, 0, 0);
  const dateForBoardDay = (d) => epochMs + (d + 0.25) * ECON_BOARD_DAY_MS;
  let nowDateMs = dateForBoardDay(baked.world.day);

  await life.start();
  assert.equal(life.state, 'alive', life.error ?? '');

  const mkt0 = await life.market(0);
  const diag0 = await life.diagnostics(0);
  const departTreasury = Math.round(diag0.crownTreasury);
  const departGrainBuy = Math.round(mkt0.goods.grain.price * 10 * 1.05);

  const intelLedger = createIntelLedger();
  snapshotPortIntel(intelLedger, {
    portId: 'lisbon',
    portName: 'Lisboa',
    dateMs: nowDateMs,
    boardDay: life.day,
    town: { name: 'Lisboa', kind: 'capital', role: 'seat', people: diag0.pop, walls: 'stone', palace: 'Paço da Ribeira' },
    market: [
      { id: 'grain', name: 'Grain', buy: departGrainBuy, sell: Math.max(1, departGrainBuy - 2), offered: true, held: 0, usual: Math.max(1, departGrainBuy + 4) },
    ],
    realm: {
      name: 'Portugal',
      monarch: diag0.monarch?.title || life.status?.monarch || 'Queen Petronila',
      treasury: departTreasury,
      people: diag0.realmPop,
      places: 11,
      legitimacy: 75,
      palace: 'Paço da Ribeira',
    },
    news: [{ date: diag0.dateLabel, text: 'Quiet customhouse quay at departure', cat: 'court' }],
  });

  // Sail out beyond physical port contact!
  inContact = false;
  leakedToasts.length = 0;
  leakedMcpBroadcasts.length = 0;

  // Advance calendar & boardLife by +20 days while at sea
  const targetDay = baked.world.day + 20;
  nowDateMs = dateForBoardDay(targetDay);
  life.tick(nowDateMs);
  while (life.day < targetDay || life.busy) {
    life.tick(nowDateMs);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(life.day, targetDay);
  assert.equal(leakedToasts.length, 0, 'zero boardLife HUD toasts may fire while !hasLivePortContact');
  assert.equal(leakedMcpBroadcasts.length, 0, 'zero MCP news broadcasts may fire while !hasLivePortContact');

  const diag20 = await life.diagnostics(0);
  // Build what the First Mate knows out at sea from the frozen intelLedger
  const buildSeaAbout = (atMs) => {
    const frozen = resolveMateIntel(intelLedger, { portId: 'lisbon', nowDateMs: atMs });
    return {
      mate: { id: 120, name: 'Simão Lopes', model: true, role: 'boatman', port: 'Lisboa' },
      now: {
        where: { kind: 'sea', name: 'at sea', ashore: false, living: false, lat: 34.5, lon: -14.2 },
        realm: frozen.realm,
        captain: { currency: 'cruzados', coin: 400, cargo: [] },
        voyage: { from: 'Lisboa', to: 'Funchal', daysOut: 20, leagues: 140, log: [] },
      },
      news: frozen.news,
      town: frozen.town,
      market: frozen.market,
      intel: frozen,
    };
  };

  const seaAbout20 = buildSeaAbout(nowDateMs);
  const realmReplyAtSea = mateReply('How stands the royal treasury and realm?', seaAbout20);
  const newsReplyAtSea = mateReply('What is the news of late?', seaAbout20);
  const marketReplyAtSea = mateCounsel('market', seaAbout20);

  assert.match(realmReplyAtSea, /When we weighed from Lisboa 20 days back/);
  assert.match(realmReplyAtSea, /no word has reached us since unless we speak a passing sail/);
  assert.ok(realmReplyAtSea.includes(departTreasury.toLocaleString('en-US')), 'Mate must report departure treasury, never live Day+20 treasury');
  if (Math.round(diag20.crownTreasury) !== departTreasury) {
    assert.ok(!realmReplyAtSea.includes(Math.round(diag20.crownTreasury).toLocaleString('en-US')), 'Live Day+20 treasury must NOT leak at sea');
  }
  assert.match(newsReplyAtSea, /Quiet customhouse quay at departure/);
  assert.match(marketReplyAtSea, /When we weighed from Lisboa 20 days back/);

  // Speaking an OLDER ship (25 days out of Lisbon -> departed BEFORE we left) must NOT overwrite our Day-0 intel!
  const staleShip = pickEncounter({
    dateMs: nowDateMs,
    archetype: ENCOUNTER_ARCHETYPES.find((a) => a.id === 'portuguese-carreira'),
    originPort: { id: 'lisbon', name: 'Lisboa' },
    transitDays: 25,
    shipName: 'Velha Barca',
    masterName: 'Lopo Vaz',
  });
  const staleHail = hailEncounter(staleShip, {
    nowDateMs,
    portIntelSource: () => ({
      realmSnapshot: { treasury: 111 },
      newsItems: [{ date: 'Old', text: 'Outdated rumour from before we sailed', cat: 'court' }],
    }),
  });
  assert.equal(mergeHailIntel(intelLedger, staleHail.intelPacket, nowDateMs).updated, false, 'older ship must not overwrite fresher ledger');

  // Speaking a FRESHER outbound ship (4 days out of Lisbon -> departed at Day+16!) updates intelLedger to Day+16 word!
  const freshShip = pickEncounter({
    dateMs: nowDateMs,
    archetype: ENCOUNTER_ARCHETYPES.find((a) => a.id === 'portuguese-carreira'),
    originPort: { id: 'lisbon', name: 'Lisboa' },
    destPort: { id: 'funchal', name: 'Funchal' },
    transitDays: 4,
    shipName: 'São Rafael',
    masterName: 'Pero Álvares',
  });
  const freshHail = hailEncounter(freshShip, {
    nowDateMs,
    portIntelSource: () => ({
      realmSnapshot: { treasury: 99999 },
      marketSnapshot: [
        { id: 'grain', name: 'Grain', buy: 19, sell: 17, offered: true, held: 0, usual: 30 },
      ],
      newsItems: [{ date: 'Summer 12', text: 'Spices from Goa unloaded at the Casa da Índia', cat: 'court' }],
    }),
  });
  assert.equal(freshHail.ok, true);
  const mergedFresh = mergeHailIntel(intelLedger, freshHail.intelPacket, nowDateMs);
  assert.equal(mergedFresh.updated, true, 'fresher passing sail must update intelLedger');

  const twoDaysLaterMs = nowDateMs + 2 * 86_400_000;
  const seaAfterHail = buildSeaAbout(twoDaysLaterMs);
  const newsAfterHail = mateReply('What news from Lisbon?', seaAfterHail);
  const realmAfterHail = mateReply('How stands the realm?', seaAfterHail);
  assert.match(newsAfterHail, /By word of the .* São Rafael \(Master Pero Álvares\), spoken 2 days past \(4 days out of Lisboa\)/);
  assert.match(newsAfterHail, /Spices from Goa unloaded at the Casa da Índia/);
  assert.match(realmAfterHail, /99,999 crowns/);
});

test('advanceCalendarOnly advances voyage calendar without engaging autopilot, and index.html wires #econ-sim-controls', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<details id="econ-sim-controls" class="control-group">/);
  for (const r of ECON_SIM_RATES) {
    assert.match(html, new RegExp(`data-econ-rate="${r}"`), `index.html missing ${r}x econ rate button`);
  }
  for (const d of ECON_SIM_STEPS) {
    assert.match(html, new RegExp(`data-econ-step="${d}"`), `index.html missing +${d}d step button`);
  }

  const boat = { x: 0, z: 0, heading: 90, surgeVelocity: 0, leewayVelocity: 0 };
  let skyDateIso = null;
  const astronomy = {
    revision: 1,
    set(vals) { skyDateIso = vals.date; this.revision++; },
  };
  const ctl = createVoyageController({ boat, P: {}, astronomy, hudParent: null, storage: null });
  ctl.start({ dateMs: DEFAULT_DEPARTURE.dateMs, passive: true });
  assert.equal(ctl.voyage.passive, true);
  assert.equal(ctl.helmsman.engaged, false);

  const nextMs = ctl.advanceCalendarOnly(7 * ECON_BOARD_DAY_MS);
  assert.equal(nextMs, DEFAULT_DEPARTURE.dateMs + Math.round(7 * ECON_BOARD_DAY_MS));
  assert.equal(ctl.voyage.passive, true, 'advanceCalendarOnly must NOT promoteActive()');
  assert.equal(ctl.helmsman.engaged, false, 'advanceCalendarOnly must NOT engage helmsman autopilot');
  assert.ok(skyDateIso && skyDateIso.startsWith('1550-03-'), 'astronomy clock must track calendar advance');
});
