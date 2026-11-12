// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The first mate ashore. The mate is one of the people of the port the captain started from: a person of the
// model, chosen there, who from then on goes where the captain goes. Aboard they are the ship's mate; when the
// captain walks a town they walk a step behind. This is that figure: one body of the same kind as stands the forts'
// posts (js/crew.js draws it, posed and skinned on the GPU), with the chosen person's name, sex and face, and the
// few numbers that say where it stands and how it walks. Each frame only those numbers change.
import { createDeckhand, garrisonEnlist } from './crew.js';
import { crewAdvanceWalk } from './crew-motion.js';
import { gltfTRS } from './gltf.js';

// A seaman's coat and breeches, in linear colour.
const MATE_COAT = Object.freeze([0.035, 0.07, 0.16]), MATE_BREECHES = Object.freeze([0.3, 0.25, 0.17]);
// The mate keeps within a few steps: sets off when the captain is this far, and stops this near.
export const MATE_SETS_OFF_M = 2.4, MATE_STOPS_M = 1.5, MATE_WALK_MS = 1.5, MATE_RUN_MS = 4.6;
// Farther than this they are not walked to but found beside the captain (who came ashore, or was carried off).
const MATE_LOST_M = 36, MATE_STUCK_S = 2.5, MATE_RECENTRE_M = 300;

// The figure of `person` ({id, name, sex: 'm' | 'f', age, role}) and the garrison of one it is drawn as. It stands
// nowhere until it is first stepped.
export function createMateFigure(person) {
  const figure = createDeckhand();
  Object.assign(figure, { id: 'first-mate', role: 'First mate', stationKind: 'mate', garrison: true, indigenous: false, modelVariant: 'colonial', crewIndex: 0,
    time: 0, walkTime: 0, walk: 0, brace: 0, work: 0, yaw: 0, visible: false, shirt: [...MATE_COAT], trousers: [...MATE_BREECHES], dress: 0, stuck: 0, placed: false });
  garrisonEnlist(figure, { ...person, of: 'mate' });
  const port = { instances: [{ prefabId: 'first-mate' }], center: { x: 0, z: 0 } };
  const garrison = { port, origin: [0, 0, 0], soldiers: [figure], byBuilding: new Map(), units: [], time: 0, dateMs: null, watch: null };
  port.garrison = garrison;
  return { person, figure, garrison, port };
}

const mateTurn = (yaw, desired, most) => { const angle = Math.atan2(Math.sin(desired - yaw), Math.cos(desired - yaw)); return yaw + Math.max(-most, Math.min(most, angle)); };

/**
 * Walk the mate after the captain for `dt` seconds. `captain` is where the captain stands and looks ({x, z, yaw},
 * world metres); `ground(x, z)` the height there; `open(x, z)` whether a body may stand there (dry, and through no
 * wall). `ashore` false puts the figure away. Answers true when the figure's garrison was moved to a new origin and
 * the renderer must be told (setPort).
 */
export function stepMateFigure(mate, dt, { ashore, captain, ground, open }) {
  const s = mate.figure, garrison = mate.garrison;
  dt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
  if (!ashore || !captain) { s.visible = false; s.placed = false; return false; }
  let moved = false;
  if (!s.placed || Math.hypot(captain.x - garrison.origin[0], captain.z - garrison.origin[2]) > MATE_RECENTRE_M) {
    garrison.origin[0] = Math.round(captain.x); garrison.origin[2] = Math.round(captain.z); mate.port.center.x = garrison.origin[0]; mate.port.center.z = garrison.origin[2];
    moved = true;
  }
  const place = () => {
    // Beside the captain: behind first, then to either hand, then anywhere about them that is open.
    const back = captain.yaw + Math.PI;
    for (const turn of [0, 0.7, -0.7, 1.5, -1.5, 2.4, -2.4, Math.PI]) {
      const x = captain.x + Math.sin(back + turn) * MATE_STOPS_M, z = captain.z - Math.cos(back + turn) * MATE_STOPS_M;
      if (open(x, z)) { s.x = x; s.z = z; s.placed = true; s.stuck = 0; s.walk = 0; return; }
    }
    s.x = captain.x; s.z = captain.z; s.placed = true; s.stuck = 0; s.walk = 0;
  };
  if (!s.placed) place();
  let dx = captain.x - s.x, dz = captain.z - s.z, away = Math.hypot(dx, dz);
  if (away > MATE_LOST_M || s.stuck > MATE_STUCK_S) { place(); dx = captain.x - s.x; dz = captain.z - s.z; away = Math.hypot(dx, dz); }
  s.time += dt;
  s.going = s.going ? away > MATE_STOPS_M : away > MATE_SETS_OFF_M;
  let stepped = 0;
  if (s.going && dt > 0) {
    // A walk beside a walking captain, a run to catch one up.
    const pace = Math.min(away - MATE_STOPS_M * 0.9, (away > 5 ? MATE_RUN_MS : MATE_WALK_MS) * dt), ux = dx / away, uz = dz / away;
    const nx = s.x + ux * pace, nz = s.z + uz * pace;
    if (open(nx, nz)) { s.x = nx; s.z = nz; stepped = pace; }
    else if (Math.abs(ux) > 0.05 && open(s.x + Math.sign(ux) * pace, s.z)) { s.x += Math.sign(ux) * pace; stepped = pace; }
    else if (Math.abs(uz) > 0.05 && open(s.x, s.z + Math.sign(uz) * pace)) { s.z += Math.sign(uz) * pace; stepped = pace; }
    s.stuck = stepped ? 0 : s.stuck + dt;
    if (stepped) crewAdvanceWalk(s, stepped);
  } else s.stuck = 0;
  // They face the way they go, and the captain when they stand.
  s.yaw = mateTurn(s.yaw, Math.atan2(dx, dz), dt * (stepped ? 7 : 3.5));
  s.walk += (Number(stepped > 0) - s.walk) * (1 - Math.exp(-dt * 8));
  const y = ground(s.x, s.z) + 0.028;
  s.y = Number.isFinite(s.y) && s.placed && !moved ? s.y + (y - s.y) * Math.min(1, dt * 12) : y;
  s.position.set([s.x, s.y, s.z]);
  const half = s.yaw * 0.5;
  s.rotation.set([0, Math.sin(half), 0, Math.cos(half)]);
  gltfTRS(s.transform, [s.x - garrison.origin[0], s.y - garrison.origin[1], s.z - garrison.origin[2]], s.rotation, s.scale);
  s.visible = true;
  s._poseReady = stepped === 0 && s.walk < 1e-3;
  return moved;
}

// What the mate is at, for whoever asks after them.
export const mateDoing = (mate) => (mate?.figure?.going ? 'following the captain' : 'with the captain, as first mate');
