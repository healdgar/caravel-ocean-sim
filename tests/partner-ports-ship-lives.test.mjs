// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// End-to-end verification of:
// 1. Headlessly simulated pre-seeded 1550 partner ports (`assets/boards/partner-ports-1550.json`)
// 2. Living Captains, Merchants & Crew on ships, sea caravans, harbor roadstead vessels & river boats
// 3. `advisor-inspect` biographies, family kin links, and persistence across `live()` + `freeze()`/`thaw()`
// 4. Physical 3D officer/merchant/mariner geometry, stowed deck cargo, and `deckStations` across all 7 ship archetypes

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { BAKED_BOARDS, BAKED_WORLDS } from '../js/board-model.js';
import { folkCardFacts } from '../js/folk-card.js';
import { buildTradeVesselRoutes, inspectTradeVesselArchetypes } from '../js/trade-vessels.js';
import { openBoard } from '../scripts/board-host.mjs';

test('pre-seeded partner ports file carries headlessly simulated 1550 port societies and biographies', () => {
  const seed = JSON.parse(fs.readFileSync('assets/boards/partner-ports-1550.json', 'utf8'));
  assert.equal(seed.version, 1);
  const expectedPorts = ['Sevilla', 'Porto', 'Antwerp', 'Venice', 'Bordeaux'];
  assert.deepEqual(seed.ports.map((p) => p.name), expectedPorts);

  let totalCaptains = 0, totalMerchants = 0, totalMariners = 0, kinLinksChecked = 0;
  for (const port of seed.ports) {
    assert.ok(port.day >= 200, `${port.name} expected >= 200 simulated days, got ${port.day}`);
    assert.ok(port.people >= 1000, `${port.name} expected >= 1000 simulated citizens, got ${port.people}`);
    assert.ok(port.captains.length >= 8, `${port.name} expected >= 8 captains`);
    assert.ok(port.merchants.length >= 8, `${port.name} expected >= 8 merchants`);
    assert.ok(port.mariners.length >= 16, `${port.name} expected >= 16 mariners`);
    totalCaptains += port.captains.length;
    totalMerchants += port.merchants.length;
    totalMariners += port.mariners.length;

    for (const soul of [...port.captains, ...port.merchants, ...port.mariners.slice(0, 6)]) {
      assert.ok(soul.id >= 2_000_000, `${port.name} soul ${soul.name} id=${soul.id} must be in partner-port namespace`);
      const cardRec = port.cards[String(soul.id)];
      assert.ok(cardRec?.card, `${port.name} soul ${soul.id} missing card record`);
      const parsed = folkCardFacts(cardRec.card);
      assert.ok(parsed.title.length > 0, `${port.name} soul ${soul.id} missing parsed card title`);
      assert.ok(parsed.life.length >= 1, `${port.name} soul ${soul.id} missing simulated life annals`);
      for (const lnk of cardRec.links || []) {
        if (typeof lnk?.code === 'string' && lnk.code.startsWith('p')) {
          const kinId = Number(lnk.code.slice(1));
          assert.ok(kinId >= 2_000_000, `unremapped kin link ${lnk.code} on ${soul.name}`);
          kinLinksChecked++;
        }
      }
    }
  }
  assert.ok(totalCaptains >= 45 && totalMerchants >= 45 && totalMariners >= 100);
  assert.ok(kinLinksChecked >= 20, `expected >= 20 remapped family kin links, got ${kinLinksChecked}`);
});

test('all 7 trade-vessel archetypes include physical 3D officers, merchants with cargo, crew, and deckStations', () => {
  const archetypes = inspectTradeVesselArchetypes();
  assert.equal(archetypes.length, 7);

  for (const arch of archetypes) {
    assert.ok(Array.isArray(arch.deckStations) && arch.deckStations.length >= 3, `${arch.label} missing deckStations`);
    const stationNames = arch.deckStations.map((s) => s.station);
    assert.ok(
      stationNames.includes('captain') || stationNames.includes('pilot'),
      `${arch.label} missing captain/pilot deckStation (${stationNames.join(',')})`
    );
    assert.ok(
      stationNames.includes('merchant'),
      `${arch.label} missing merchant deckStation (${stationNames.join(',')})`
    );

    const groupIds = arch.groups.map((g) => g.id);
    if (arch.index === 4) {
      assert.ok(groupIds.includes('crew.pilot') && groupIds.includes('crew.oarsmen'), 'lusoria missing pilot/oarsmen groups');
    } else {
      assert.ok(groupIds.includes('crew.officers'), `${arch.label} missing crew.officers group`);
      assert.ok(groupIds.includes('crew.pilot'), `${arch.label} missing crew.pilot group`);
      assert.ok(groupIds.includes('cargo.deck'), `${arch.label} missing stowed cargo.deck group`);
    }

    // Verify officer (27.15) and/or merchant (27.45) material encodings exist in vertex buffer
    let hasCaptainMat = false, hasMerchantMat = false;
    for (let i = 6; i < arch.vertices.length; i += 9) {
      const m = arch.vertices[i];
      if (Math.floor(m) === 27) {
        const frac = m - 27;
        if (frac > 0.08 && frac < 0.30) hasCaptainMat = true;
        if (frac >= 0.30 && frac < 0.65) hasMerchantMat = true;
      }
    }
    assert.equal(hasMerchantMat, true, `${arch.label} missing merchant garment/ledger material encoding`);
    if (arch.index !== 4) {
      assert.equal(hasCaptainMat, true, `${arch.label} missing captain coat/hat material encoding`);
    }
  }
});

test('Lisbon 1550 board runtime staffs ships, sea caravans, harbor fleet & river boats with inspectable lives across freeze/thaw', async () => {
  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const world = new Uint8Array(fs.readFileSync(BAKED_WORLDS['lisbon:1550']));
  const inspectPerson = (model, id) => model.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 'p' + id, full: true });
  const board = await openBoard(baked.request, { world });
  try {
    const snap = await board.hook('caravans');
    assert.ok(Array.isArray(snap.ships) && snap.ships.length >= 2, `expected >= 2 ocean ships, got ${snap.ships?.length}`);
    assert.ok(Array.isArray(snap.harborFleet) && snap.harborFleet.length >= 8, 'expected pre-staffed harborFleet roster');
    assert.ok(Array.isArray(snap.riverBoats) && snap.riverBoats.length >= 1, 'expected manned riverBoats');

    const firstShip = snap.ships[0];
    assert.ok(firstShip.shipName && firstShip.homePort, 'ship missing shipName or homePort');
    assert.ok(firstShip.captain?.id >= 2_000_000, 'ship captain must come from simulated partner port');
    assert.ok(firstShip.merchant?.id >= 2_000_000, 'ship merchant must come from simulated partner port');
    assert.ok(Array.isArray(firstShip.crew) && firstShip.crew.length >= 3, 'ship missing mariner crew');

    // Inspect the foreign ship's Captain and Merchant via advisor-inspect
    const captInspect = await inspectPerson(board, firstShip.captain.id);
    assert.equal(captInspect?.kind, 'person');
    assert.match(captInspect.card, /^Now /m);
    assert.ok(captInspect.card.includes(firstShip.shipName), 'captain card must name their current vessel');
    const captFacts = folkCardFacts(captInspect.card);
    assert.ok(
      captInspect.card.includes(firstShip.homePort) || captFacts.facts.Home?.includes(firstShip.homePort),
      `captain card missing ${firstShip.homePort}`
    );
    assert.ok(captFacts.life.length >= 2, 'captain card must carry simulated life + voyage log');

    const merchInspect = await inspectPerson(board, firstShip.merchant.id);
    assert.equal(merchInspect?.kind, 'person');
    assert.ok(merchInspect.card.includes(firstShip.shipName), 'merchant card must name their current vessel');

    // Verify remapped family kin link resolves cleanly if present on any staffed soul
    let verifiedKin = false;
    for (const sh of snap.ships) {
      for (const soul of [sh.captain, sh.merchant, ...(sh.crew || [])]) {
        const info = await inspectPerson(board, soul.id);
        const kinLink = (info?.links || []).find((l) => typeof l?.code === 'string' && /^p\d+$/.test(l.code) && Number(l.code.slice(1)) !== soul.id);
        if (kinLink) {
          const kinInfo = await inspectPerson(board, Number(kinLink.code.slice(1)));
          if (kinInfo?.kind === 'person') {
            assert.ok(kinInfo.card.length > 20);
            verifiedKin = true;
            break;
          }
        }
      }
      if (verifiedKin) break;
    }
    assert.equal(verifiedKin, true, 'expected at least one staffed mariner/merchant/captain to resolve a simulated family kin card');

    // Verify buildTradeVesselRoutes carries captains, merchants, and crew onto routes
    const routes = buildTradeVesselRoutes(snap, { x: baked.region.x, z: baked.region.z }, {
      places: [{ x: baked.region.x, z: baked.region.z, kind: 'capital', harbor: true }],
    });
    assert.ok(routes.length >= 4, 'expected populated trade-vessel routes');
    const seaRoutesWithLives = routes.filter((r) => r.mode === 'sea' && r.captain?.id && r.merchant?.id);
    assert.ok(seaRoutesWithLives.length >= 4, `expected >= 4 sea routes with captain & merchant, got ${seaRoutesWithLives.length}`);

    // Advance simulation and verify persistence across freeze() -> thaw()
    await board.live(2);
    const frozen = await board.freeze();
    const reopened = await openBoard(baked.request, { world: frozen });
    try {
      const after = await inspectPerson(reopened, firstShip.captain.id);
      assert.equal(after?.kind, 'person');
      assert.ok(after.card.includes(firstShip.captain.name.split(' ')[0]));
    } finally {
      await reopened.close();
    }
  } finally {
    await board.close();
  }
});
