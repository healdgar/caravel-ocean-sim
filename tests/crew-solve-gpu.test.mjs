// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Sailors at work are posed by a compute pass. Here the real pass runs on the real rigs in a headless page, for
// companies at their work and for every kind of work set up by hand, over several frames so that the ease from
// one action into the next is in it. Its joints are read back and held against the skeleton JavaScript solves
// from the same sailor at the same moment: the pose code in js/crew-pose.js and js/crew-physics.js.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

// An empty page on the project's own server, with a GPU, to run one of these in.
async function inPage(run) {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const args = process.env.WEBGPU_BACKEND === 'metal' ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args });
    const page = await browser.newPage();
    await page.route('**/__crew-solve', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__crew-solve`);
    return await page.evaluate(run);
  } finally {
    await browser?.close();
    server.close();
  }
}

test('the pose pass puts every joint where the JavaScript skeleton has it, for companies at work', { timeout: 300000 }, async () => {
  {
    const result = await inPage(async () => {
      const { loadCrewGLB } = await import('/js/gltf.js');
      const { createCrewSolver, createCrewSolveBatch } = await import('/js/crew-solve.js');
      const { createCompany, stepCompany } = await import('/js/crew.js');
      const { stepCrewWork, crewGunStation } = await import('/js/crew-work.js');
      const { poseCrewWork } = await import('/js/crew-pose.js');
      const { applyCrewRealism } = await import('/js/crew-physics.js');
      const { applyCrewWounds } = await import('/js/crew-wounds.js');
      const { getShipModel, resolveShipNode } = await import('/js/ship-models.js');
      const { createGunDefinitions } = await import('/js/gunnery-models.js');
      const { sailingState } = await import('/js/sailing.js');
      const { ROWING_DESIGNS } = await import('/js/models/rowing.js');
      const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
      device.onuncapturederror = (e) => errors.push(e.error.message);
      const models = [];
      for (const file of ['sailor.glb', 'sailor-female.glb', 'captain.glb']) models.push(loadCrewGLB(await (await fetch('/assets/crew/' + file)).arrayBuffer()));

      const ship = (id) => ({ modelId: id, ...getShipModel(id).runtime, heading: 24, x: 0, z: 0, heave: 0, roll: 0, rollVelocity: 0, rudder: 0, sailFore: 1, sailMain: 1, sailMizzen: 1 });
      const clone = (actor) => ({ ...actor, position: actor.position.slice(), scale: actor.scale.slice(), rotation: actor.rotation.slice(), transform: actor.transform.slice(), observation: { ...actor.observation }, job: actor.job ? { ...actor.job } : null, phys: actor.phys ? { ...actor.phys } : undefined, grips: null, _mixer: undefined });
      // The cast: each is a sailor, the vessel he is aboard, whether he has work to be posed at, and what changes
      // about him from one frame to the next.
      const cast = [], add = (label, s, boat, { work = true, each = null } = {}) => cast.push({ label, s, boat, work, each });
      const rowed = Object.keys(ROWING_DESIGNS)[0];
      for (const id of ['victory', 'nina', rowed]) {
        const boat = ship(id), company = createCompany(undefined, id);
        sailingState(boat); stepCompany(company, boat, 0, 8);
        // A company some seconds into its day: walking, hauling, steering, rowing, standing its stations.
        for (let i = 0; i < 180; i++) stepCompany(company, boat, 1 / 30, 8);
        for (const s of company.crew) add(id + ' company ' + s.id, s, boat, { each: null });
        cast.push({ company, boat });
        if (id === rowed) continue;
        const someone = (n) => company.crew[n % company.crew.length];
        for (const [n, side] of [-1, 1].entries()) for (const rung of [0.5, 4.25, 9.7]) {
          const s = clone(someone(3 + n));
          s.job = { kind: 'rig', mast: 0, side, stage: 'ascending', rung, elapsed: 0 }; s.intent = 'work';
          stepCrewWork(s, company, boat, 0);
          add(id + ' climb ' + side + '/' + rung, s, boat, { each: (f) => { s.job.rung = rung + f * 0.07; } });
        }
        for (const kind of ['haul', 'hatch']) {
          const s = clone(someone(kind === 'haul' ? 5 : 6)), position = resolveShipNode(boat, kind === 'haul' ? 'station.haul.main' : 'station.hatch', { space: 'design' });
          s.job = { kind, mast: 1, stage: 'working', rung: 0, elapsed: 0, position, path: [position], cursor: 0 }; s.intent = 'work';
          boat.sailMain = 0.5; stepCrewWork(s, company, boat, 0); boat.sailMain = 1;
          add(id + ' ' + kind, s, boat);
        }
        const stages = ['swab', 'ram', 'runout', 'prime', 'ready'];
        for (const role of ['loader', 'tackle']) for (const [n, stage] of stages.entries()) {
          const gun = { ...createGunDefinitions(boat).find((g) => g.weatherDeck), stage, progress: 0.37, offset: 0.3 };
          const s = clone(someone(7 + n)), position = crewGunStation(gun, role, boat);
          s.job = { kind: 'gunnery', gun, gunRole: role, stage: 'working', rung: 0, elapsed: 0, position, path: [position], cursor: 0 }; s.intent = 'work';
          stepCrewWork(s, company, boat, 0);
          // The gun goes through its drill, so each frame he eases out of one stance into the next.
          add(id + ' gun ' + role + '/' + stage, s, boat, { each: (f) => { gun.stage = stages[(n + f) % stages.length]; gun.progress = 0.37 + f * 0.1; } });
        }
        const helm = clone(company.crew.find((s) => s.role === 'Helmsman'));
        add(id + ' helm', helm, boat, { each: (f) => { boat.rudder = [-30, 0, 30, 12][f % 4]; } });
        const set = (label, n, change, options) => { const s = clone(someone(n)); s.job = null; s.seatedPose = null; change(s); add(id + ' ' + label, s, boat, options); return s; };
        set('wounded', 11, (s) => { s.casualtyState = 'wounded'; });
        set('afire', 12, (s) => { s.firePanic = 0.8; });
        set('braced', 13, (s) => { s.brace = 0.8; });
        set('walking', 14, (s) => { s.walk = 0.5; s.walkTime = 0.4; });
        set('lookout', 15, (s) => { s.job = { kind: 'lookout', lookoutAtStation: true, stage: 'working', mast: 0, side: 1, rung: 0 }; });
        set('watch aloft', 16, (s) => { s.job = { kind: 'lookout', stage: 'working', mast: 0, side: 1, rung: 6.3 }; });
        set('mooring', 17, (s) => { s.job = { kind: 'mooring', stage: 'working' }; });
        set('boarding', 18, (s) => { s.job = { kind: 'boarding', stage: 'working' }; });
        set('gangplank', 19, (s) => { s.job = { kind: 'boarding', stage: 'working', crossingGangplank: true }; });
        set('fallen', 20, (s) => { s.casualtyState = 'fallen'; s.health = 0; });
        set('knocked down', 21, (s) => { s.knockdownTimer = 0.6; });
        set('swimming hurt', 22, (s) => { s.casualtyState = 'fallen'; s.overboard = { inWater: true, alive: true, wounded: true }; });
        set('maimed', 23, (s) => { s.casualtyState = 'wounded'; s.crewInjuries = [{ kind: 'broken', bone: 'lowerarm_l' }, { kind: 'severed', bone: 'calf_r' }, { kind: 'crushed', bone: 'spine_03' }]; });
        // Struck down between one frame and the next, to ease from standing into a fall.
        const struck = set('struck', 24, () => {}, { each: (f) => { if (f === 2) { struck.casualtyState = 'fallen'; struck.health = 0; } } });
        // A soldier ashore has no vessel and no work, and stands on sloping ground.
        set('ashore', 25, (s) => { s.building = { yaw: 0.4, slopeX: 0.08, slopeZ: -0.05 }; }, { work: false });
      }
      const companies = cast.filter((c) => c.company), people = cast.filter((c) => c.s);
      people.forEach((c, i) => { c.index = i; c.rig = i % models.length; });

      // Two poses a sailor, as he is drawn: each frame the older is replaced, or both when a change must show at once.
      const J = 65, pose = J * 16, bytes = people.length * 2 * pose * 4;
      const poses = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      const shader = async (code, label) => { const module = device.createShaderModule({ code, label }), bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(bad.map((m) => m.lineNum + ': ' + m.message).join('\n')); return module; };
      const pipeline = await createCrewSolver(device, shader), batches = models.map((model) => createCrewSolveBatch(device, pipeline, model, poses, people.length));
      // Where a palette puts points fixed to each joint: the joint itself and three a hand's breadth from it, so
      // a joint turned wrongly shows as well as one misplaced.
      const marks = models.map((model) => {
        const a = model.animator; a.sample(null, 0);
        return a.joints.map((node) => { const [x, y, z] = a.world[node].subarray(12, 15); return [[x, y, z], [x + 0.1, y, z], [x, y + 0.1, z], [x, y, z + 0.1]]; });
      });
      const apart = (rig, joint, a, b, at) => {
        let worst = 0;
        for (const [x, y, z] of marks[rig][joint]) {
          let d = 0;
          for (let k = 0; k < 3; k++) { const o = joint * 16 + k; d += ((a[o] - b[at + o]) * x + (a[o + 4] - b[at + o + 4]) * y + (a[o + 8] - b[at + o + 8]) * z + a[o + 12] - b[at + o + 12]) ** 2; }
          worst = Math.max(worst, Math.sqrt(d));
        }
        return worst;
      };
      const rows = [], kinds = new Set(), dt = 0.05, frames = 5, snapped = (c, frame) => (c.index + frame) % 7 === 0;
      let lists = 0, longest = 0, beside = 0, latecomer = null, before = [];
      for (let frame = 0; frame < frames; frame++) {
        if (frame) for (const { company, boat } of companies) stepCompany(company, boat, dt, 8);
        const expected = [];
        // Another company joins part way through, and room is made for it: nothing remembered of the others is lost.
        if (frame === 3) latecomer = createCrewSolveBatch(device, pipeline, models[0], poses, 900);
        for (const batch of batches) batch.begin();
        for (const c of people) {
          const { s, boat, work, index, rig } = c, a = models[rig].animator;
          if (frame && !companies.some((k) => k.company.crew.includes(s))) { s.time += dt; s.walkTime = (s.walkTime ?? 0) + dt * (s.walk ?? 0); }
          c.each?.(frame);
          const before = batches[rig].recorder.used;
          if (!batches[rig].add(index, s, boat, dt, index * 2 + frame % 2, { work, snap: snapped(c, frame) })) throw Error('No room to write down ' + c.label);
          lists++; longest = Math.max(longest, batches[rig].recorder.used - before);
          kinds.add(s._mixer.actionKey.split(':').slice(0, 2).join(':'));
          // The same sailor on the JavaScript skeleton, which keeps its own memory of his last pose.
          const kept = s._mixer; s._mixer = c.mixer;
          a.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
          if (s.brace > 0.001 && !(s.job?.rung > 0)) a.blend('Brace', s.time, s.brace);
          if (work) poseCrewWork(a, s, boat);
          applyCrewRealism(a, s, boat, dt);
          applyCrewWounds(a, s);
          c.mixer = s._mixer; s._mixer = kept;
          expected.push(a.palette.slice());
        }
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        // Three rigs' sailors, solved together as a fleet's companies are. On the odd frames each is sent for
        // solving before the next has finished writing, which the solver must also get right.
        if (frame % 2) for (const batch of batches) { batch.upload(); batch.encode(pass); }
        else { for (const batch of batches) batch.upload(); for (const batch of batches) batch.encode(pass); }
        pass.end();
        const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyBufferToBuffer(poses, 0, read, 0, bytes);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(read.getMappedRange().slice(0));
        read.unmap(); read.destroy();
        for (const c of people) {
          const names = models[c.rig].animator.names, joints = models[c.rig].animator.joints;
          let worst = 0, where = '', finite = true;
          for (let joint = 0; joint < J; joint++) {
            const d = apart(c.rig, joint, expected[c.index], out, (c.index * 2 + frame % 2) * pose);
            // The pose beside it is this one too if it was to show at once, and otherwise still the frame before's.
            const other = snapped(c, frame) ? expected[c.index] : before[c.index];
            if (other) beside = Math.max(beside, apart(c.rig, joint, other, out, (c.index * 2 + 1 - frame % 2) * pose));
            if (!Number.isFinite(d)) finite = false;
            if (d > worst) { worst = d; where = names[joints[joint]]; }
          }
          rows.push({ label: c.label, frame, worst, where, finite, key: c.s._mixer.actionKey });
        }
        before = expected;
      }
      latecomer.destroy();
      for (const batch of batches) batch.destroy();
      poses.destroy();
      rows.sort((a, b) => b.worst - a.worst);
      return { errors, people: people.length, lists, longest, beside, kinds: [...kinds].sort(), worst: rows.slice(0, 12), broken: rows.filter((r) => !r.finite).slice(0, 8), over: rows.filter((r) => r.worst > 0.004).length, rows: rows.length };
    });
    if (process.env.CREW_SOLVE_REPORT) console.log(JSON.stringify({ ...result, worst: result.worst.slice(0, 3) }));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.broken, [], 'every joint the pass writes is a number');
    assert.ok(result.people > 100 && result.rows === result.people * 5, 'three companies and every kind of work, over five frames: ' + result.people);
    assert.ok(result.longest <= 24, 'a sailor\'s list of steps stays short: ' + result.longest);
    for (const kind of ['stance:idle', 'locomotion:walk', 'stance:brace', 'station:helm', 'seated:rowing', 'gunnery:loader', 'gunnery:tackle', 'climb:rig', 'climb:lookout', 'lookout:crows-nest', 'job:haul', 'job:hatch', 'job:mooring', 'job:boarding', 'panic:fire', 'wounded:limp', 'ragdoll:fallen', 'ragdoll:knockdown', 'overboard:swim']) {
      assert.ok(result.kinds.includes(kind), 'the cast includes ' + kind + ': ' + result.kinds);
    }
    // Single precision on the GPU against double in JavaScript, through a chain of reaches: a millimetre or two.
    assert.equal(result.over, 0, 'no joint is more than four millimetres from where the JavaScript skeleton has it: ' + JSON.stringify(result.worst.slice(0, 4)));
    assert.ok(result.beside < 0.004, 'the pose beside the one written is the same pose when it must show at once, and otherwise the last one: ' + result.beside);
  }
});

test('an arrow stays in the bone it struck, placed from the joints the pose pass wrote', { timeout: 300000 }, async () => {
  const result = await inPage(async () => {
    const { loadCrewGLB } = await import('/js/gltf.js');
    const { createCrewSolver, createCrewSolveBatch, createCrewArrowPipeline, createCrewArrowBatch, resolveCrewWoundsOnSkeleton } = await import('/js/crew-solve.js');
    const { createCompany, stepCompany, CREW_ACTOR_FLOATS } = await import('/js/crew.js');
    const { poseCrewWork } = await import('/js/crew-pose.js');
    const { applyCrewRealism } = await import('/js/crew-physics.js');
    const { applyCrewWounds, recordCrewWound } = await import('/js/crew-wounds.js');
    const { writeGunneryToolInstances } = await import('/js/gunnery-tools.js');
    const { getShipModel } = await import('/js/ship-models.js');
    const { sailingState } = await import('/js/sailing.js');
    const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice(), errors = [];
    device.onuncapturederror = (e) => errors.push(e.error.message);
    const model = loadCrewGLB(await (await fetch('/assets/crew/sailor.glb')).arrayBuffer()), a = model.animator;
    const boat = { modelId: 'victory', ...getShipModel('victory').runtime, heading: 24, x: 0, z: 0, heave: 0, roll: 0, rollVelocity: 0, rudder: 0, sailFore: 1, sailMain: 1, sailMizzen: 1 };
    const company = createCompany(undefined, 'victory'), people = company.crew, dt = 0.05;
    sailingState(boat);
    for (let i = 0; i < 120; i++) stepCompany(company, boat, 1 / 30, 8);
    // Arrows from all round into a dozen of them, high and low. Each is matched to a bone on the skeleton, once.
    const struck = people.slice(0, 12);
    struck.forEach((s, n) => {
      const [x, y, z] = s.position, h = n * 2.4;
      recordCrewWound(s, 'arrow', [x + Math.sin(h) * 0.12, y + 0.45 + (n % 5) * 0.27, z + Math.cos(h) * 0.12], [-Math.sin(h), -0.3, -Math.cos(h)]);
      if (n % 3 === 0) recordCrewWound(s, 'arrow', [x, y + 1.5, z], [0.2, -1, 0.1]);
      resolveCrewWoundsOnSkeleton(a, s, boat);
    });
    // One then loses the arm an arrow is in, and one is struck down with his arrows in him.
    struck[1].stuckArrows.push({ bone: 'hand_l', offset: [0, 0.03, 0], direction: [0, 1, 0] });
    struck[1].crewInjuries = [{ kind: 'severed', bone: 'lowerarm_l' }];
    struck[2].casualtyState = 'fallen'; struck[2].health = 0;

    const J = 65, B = GPUBufferUsage, shader = async (code, label) => { const module = device.createShaderModule({ code, label }), bad = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error'); if (bad.length) throw Error(bad.map((m) => m.lineNum + ': ' + m.message).join('\n')); return module; };
    const joints = device.createBuffer({ size: people.length * J * 64, usage: B.STORAGE }), actors = new Float32Array(people.length * CREW_ACTOR_FLOATS), instances = new Float32Array(68 * 8);
    const actorBuffer = device.createBuffer({ size: actors.byteLength, usage: B.STORAGE | B.COPY_DST }), tubes = device.createBuffer({ size: instances.byteLength, usage: B.STORAGE | B.COPY_DST | B.COPY_SRC });
    const batch = createCrewSolveBatch(device, await createCrewSolver(device, shader), model, joints, people.length);
    const arrows = createCrewArrowBatch(device, await createCrewArrowPipeline(device, shader), joints, actorBuffer, tubes, 34);
    const mixers = new Map(), bones = new Set(), far = (p, q, at) => Math.hypot(p[0] - q[at], p[1] - q[at + 1], p[2] - q[at + 2]);
    let compared = 0, lost = 0, tip = 0, tail = 0, fletch = 0, sized = true, down = 0;
    for (let frame = 0; frame < 4; frame++) {
      stepCompany(company, boat, dt, 8);
      batch.begin();
      people.forEach((s, i) => { if (!batch.add(i, s, boat, dt, i)) throw Error('No room to write down ' + s.id); actors.set(s.transform, i * CREW_ACTOR_FLOATS); });
      // Their arrows are given records among the tools' tubes, for the pass to fill.
      const placed = [], made = writeGunneryToolInstances(company, boat, instances, placed);
      arrows.begin();
      for (const { sailor, arrow, record } of placed) { arrows.add(record, people.indexOf(sailor), a, arrow); bones.add(arrow.bone); }
      device.queue.writeBuffer(actorBuffer, 0, actors); device.queue.writeBuffer(tubes, 0, instances, 0, made.count * 8);
      batch.upload(); arrows.upload();
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      batch.encode(pass); arrows.encode(pass); pass.end();
      const read = device.createBuffer({ size: instances.byteLength, usage: B.COPY_DST | B.MAP_READ });
      encoder.copyBufferToBuffer(tubes, 0, read, 0, instances.byteLength);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(read.getMappedRange().slice(0));
      read.unmap(); read.destroy();
      for (const s of struck) {
        // Where the JavaScript skeleton has his arrows, in the vessel's own frame.
        const kept = s._mixer; s._mixer = mixers.get(s);
        a.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
        if (s.brace > 0.001 && !(s.job?.rung > 0)) a.blend('Brace', s.time, s.brace);
        poseCrewWork(a, s, boat); applyCrewRealism(a, s, boat, dt); applyCrewWounds(a, s);
        mixers.set(s, s._mixer); s._mixer = kept;
        const expected = s.stuckArrowPoses, records = placed.filter((p) => p.sailor === s).map((p) => p.record * 8);
        s.stuckArrowPoses = null;
        const kept2 = records.filter((at) => out[at + 3] > 0);
        lost += records.length - kept2.length;
        if (kept2.length !== expected.length || records.length !== s.stuckArrows.length) throw Error('The pass kept ' + kept2.length + ' of ' + records.length + ' arrows in ' + s.id + ', the skeleton ' + expected.length + ' of ' + s.stuckArrows.length);
        if (Math.abs(s.climbPitch ?? 0) > 1) down++;
        kept2.forEach((at, n) => {
          const want = expected[n], along = want.tail.map((v, i) => v - want.tip[i]), length = Math.hypot(...along);
          tip = Math.max(tip, far(want.tip, out, at)); tail = Math.max(tail, far(want.tail, out, at + 4));
          fletch = Math.max(fletch, far(want.tail.map((v, i) => v - along[i] / length * 0.1), out, at + 8), far(want.tail, out, at + 12));
          sized &&= Math.abs(out[at + 3] - 0.011) < 1e-6 && out[at + 7] === 1 && Math.abs(out[at + 11] - 0.02) < 1e-6 && out[at + 15] === 2;
          compared++;
        });
      }
    }
    batch.destroy(); arrows.destroy(); joints.destroy(); actorBuffer.destroy(); tubes.destroy();
    return { errors, compared, lost, tip, tail, fletch, sized, down, bones: [...bones].sort() };
  });
  if (process.env.CREW_SOLVE_REPORT) console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.ok(result.compared >= 60 && result.bones.length >= 4, 'arrows in several bones, over four frames: ' + result.compared + ' in ' + result.bones);
  assert.equal(result.lost, 4, 'the arrow in the lost arm goes with it, every frame');
  assert.ok(result.down >= 1, 'one of the bodies lies on the deck with its arrows in it');
  assert.ok(result.sized, 'each is a shaft and its fletching');
  // The head is as far off as the joint it is in; the tail has the length of the shaft to swing through.
  assert.ok(result.tip < 0.002 && result.tail < 0.004 && result.fletch < 0.004, 'head, tail and fletching are where the skeleton has them: ' + [result.tip, result.tail, result.fletch].map((v) => v.toFixed(4)));
});
