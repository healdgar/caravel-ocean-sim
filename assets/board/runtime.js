// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// This game's hand on Castle and Commons' model. It is not a module: it is appended to the model's program
// (assets/board/game.js) and runs in that program's own scope, in a realm of its own, since the program replaces Math's
// functions with its own. It founds the world on the ground the host gave, and reports the board in plain numbers:
// metres east (x) and south (z) of the middle of the ground, turns in radians, heights in metres.
globalThis.BOARD_MODEL = (() => {
  const VERSION = 1;
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
  const line = (points) => { const out = []; for (const p of points) out.push(r1(p.x), r1(p.z)); return out; };
  const list = (values, round = r1) => Array.from(values, round);
  const ARCHES = Object.keys(ARCH);

  // The model's storage journal, kept in memory: there is nothing here to save.
  const journal = () => new OutcomeJournal(async (entry) => ({ chunk: entry.chunk, first: entry.first, last: entry.last }), { maxPendingBytes: 64 * 1024 * 1024 });

  async function found({ seed, fate = 1, era }, progress = null) {
    STORAGE_OUTCOMES.journal = journal();
    FATE = fate >>> 0; COAST_PREF = 'sea'; START_AD = era;
    await generateWorld(seed >>> 0, (text, fraction) => { progress?.(text, fraction); return Promise.resolve(); });
    initializeSimulation();
    beginChronicle();
    // The model first gives each household its roof at the turn of a year. Here they are wanted from the first day.
    for (const s of W.settlements) if (!(s.folk || []).some((p) => p.bh)) houseFolk(s);
    return board();
  }

  // So many days of the model's own life: its politics, trade, building and war.
  async function live(days) {
    for (let i = 0; i < days; i++) {
      await STORAGE_OUTCOMES.wait();
      if (simTick() === false) throw new Error('The model would not take a day');
      if ((i + 1) % 8 === 0) await STORAGE_OUTCOMES.journal.flush();
    }
    await STORAGE_OUTCOMES.journal.flush(); await STORAGE_OUTCOMES.wait();
    return board();
  }

  const castle = (s) => {
    const out = {};
    if (s.hillCastle) { const c = s.hillCastle; out.hill = { x: r1(c.x), z: r1(c.z), r: r1(c.r), walls: c.walls, height: r1(c.wallHeight ?? 0), rad: list(c.wallRad), kind: list(c.wallKind, Number), gate: r3(c.gateA ?? 0), timber: Boolean(c.timber) }; }
    if (s.motte) { const m = s.motte; out.motte = { x: r1(m.x), z: r1(m.z), r: r1(m.r), summit: r1(m.summitR), height: r1(m.height ?? 0), gate: r3(m.gateA ?? 0) }; }
    if (s.bailey) { const b = s.bailey; out.bailey = { x: r1(b.x), z: r1(b.z), r: r1(b.r), rad: b.wallRad ? list(b.wallRad) : null }; }
    if (s.citadel && !s.citadel.razed) { const c = s.citadel; out.citadel = { x: r1(c.x), z: r1(c.z), size: r1(c.S), turn: r3(c.rot ?? 0), rad: c.wallRad ? list(c.wallRad) : null, gate: r3(c.gateA ?? 0) }; }
    if (s.keepPos) out.keep = { x: r1(s.keepPos.x), z: r1(s.keepPos.z) };
    return Object.keys(out).length ? out : null;
  };

  function board() {
    const places = W.settlements.map((s) => ({
      name: s.name, kind: s.kind, role: s.role, culture: s.cult, people: Math.round(s.pop), x: r1(s.pos.x), z: r1(s.pos.z),
      radius: r1(s.radius || 0), reach: r1(s.extentR || 0), paved: r1(s.paveR || 0), harbour: Boolean(s.harbor), river: Boolean(s.river),
      founded: s.origin ? { kind: s.origin.kind, year: s.origin.foundedAD, layout: s.origin.layout } : null, layout: s.mode || null,
      walls: s.walls || 0,
      wall: s.wallRad ? { rad: list(s.wallRad), kind: list(s.wallKind, Number), gates: list(fortGateAngles(s, s), r3), bastions: Boolean(s.bastions), roman: Boolean(s.romanWall) } : null,
      castle: castle(s),
      streets: s.streets.filter((t) => !t.hidden && !t.gone && t.kind !== 'edge' && t.pts.length > 1).map((t) => ({ kind: t.kind, half: r1(t.hw), points: line(t.pts) })),
      squares: (s.places || []).map((p) => ({ kind: p.kind || 'market', x: r1(p.x), z: r1(p.z), rad: list(p.r) })),
      past: (s.history || []).filter((h) => h.ad !== undefined).map((h) => [h.ad, h.t]),
    }));
    const stand = [], form = [], kinds = [], standing = new Map();
    W.settlements.forEach((s, at) => {
      for (const b of s.buildings) {
        if (b.removed || b.state === 'gone') continue;
        standing.set(b, kinds.length / 6);
        stand.push(r1(b.x), r1(b.z), r3(b.rot), r1(b.w), r1(b.d), r1(b.h));
        // To its street, as a unit vector; and whether a church has a tower or a spire.
        form.push(r3(b.fx ?? 0), r3(b.fz ?? 0), r3(b.hue ?? 0));
        kinds.push(at, ARCHES.indexOf(b.arch), b.tier | 0, b.roof | 0, b.ch ? (b.cathedral ? 3 : b.ch.spire ? 2 : b.ch.tower ? 1 : 0) + (b.ch.stone ? 4 : 0) : 0, b.shed ? 1 : 0);
      }
    });
    // Every furlong of the ground, held or not: whose it is (-1 no one's), what it is held as, what stands on it.
    const fields = [];
    for (const f of W.land.F) {
      const poly = f.poly || computeFurlongPoly(f);
      if (!poly || poly.length < 3) continue;
      fields.push({ place: f.dom, kind: f.kind, state: f.state, heading: r3(f.th ?? 0), strip: r1(f.w ?? 0), x: r1(f.x), z: r1(f.z), points: line(poly) });
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
      // face (the way to its street and its hue) and six for what it is (place, arch, tier, roof, church, shed).
      buildings: { count: kinds.length / 6, stand, form, kinds },
      roads: W.roads.map((q) => ({ from: q.a, to: q.b, points: line(q.drawn || q.path) })),
      rivers: (W.rivStrips || []).map((q) => ({ canal: Boolean(q.canal), points: q.pts.flatMap((p, i) => [r1(p.x), r1(p.z), r1(q.hw[i])]) })),
      lanes: workerTrackSegments().flatMap((t) => [r1(t.a.x), r1(t.a.z), r1(t.b.x), r1(t.b.z)]),
      // What a furlong is held as and what stands on it, in the model's own codes.
      fieldKinds: LK, fieldStates: LS,
      fields,
      people: souls.length / 6,
      souls: { given, families, trades, each: souls },
    };
  }

  return { VERSION, found, live, board };
})();
