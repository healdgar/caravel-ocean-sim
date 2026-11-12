// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people of a founded board, about their town. Castle and Commons' model says who lives nearest the eye, what
// each does today and the way they take along its streets (assets/board/runtime.js, `folk`). Here that plan is made
// the walkers the GPU already walks (js/wgsl/townsfolk.js): a way of samples and twelve words to each person, laid
// once when a plan arrives. Nothing here runs by the frame. Every walker is a soul of the model: its number, name,
// age, calling, what it is about and where it lives, so that whoever is seen can be asked after by name.
import { ROUTE_STEP_M, WALKER_WORDS } from './town-streets.js';

// How long they stay where they went and at home between goings, in seconds, by what they went for.
const FOLK_STAYS = Object.freeze({ work: [150, 420], errand: [35, 120], church: [240, 420], play: [4, 18] });
// A way is walked no farther than this from the door: the fields of a great town lie half an hour off.
export const FOLK_WAY_MOST_M = 1400;
// To either hand of the line the model gives (which already keeps each to one side of the street).
const FOLK_LANE_M = 0.45;
const FOLK_PAUSE_SHARE = 0.3, FOLK_PAUSE_SECONDS = 9;

// A number in [0, 1) that is a soul's own, the same wherever and whenever it is asked.
export function folkRoll(id, salt) {
  let h = (Math.imul(id | 0, 2654435761) ^ Math.imul((salt | 0) + 1, 40503)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0; h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

// A way of the model's (x, z pairs on the board) as the walkers' samples: a point every ROUTE_STEP_M with its ground
// and the room to either hand. The model's streets were laid before the port's own buildings were known to it, and
// some run through them: where `blocked(x, z)` says a point stands in one, the way is walked only along its
// longest stretch in the open, and whoever takes it goes in at that building's wall. Returns the samples (none for
// a way too short to walk), whether they begin at the door, and whether they reach the far end.
function folkWay(route, origin, heightAt, blocked) {
  const samples = [];
  let length = 0;
  for (let k = 2; k < route.length; k += 2) length += Math.hypot(route[k] - route[k - 2], route[k + 1] - route[k - 1]);
  const walked = Math.min(length, FOLK_WAY_MOST_M), count = Math.floor(walked / ROUTE_STEP_M) + 1;
  if (count < 3) return { route, samples, fromDoor: true, whole: length <= FOLK_WAY_MOST_M, cut: false };
  const points = new Float64Array(count * 2);
  let leg = 2, before = 0, span = Math.hypot(route[2] - route[0], route[3] - route[1]), from = 0, to = -1, run = 0;
  for (let i = 0; i < count; i++) {
    const at = i * ROUTE_STEP_M;
    while (leg + 2 < route.length && at > before + span) { before += span; leg += 2; span = Math.hypot(route[leg] - route[leg - 2], route[leg + 1] - route[leg - 1]); }
    const t = span > 0 ? Math.min(1, (at - before) / span) : 0;
    const x = points[i * 2] = origin.x + route[leg - 2] + (route[leg] - route[leg - 2]) * t, z = points[i * 2 + 1] = origin.z + route[leg - 1] + (route[leg + 1] - route[leg - 1]) * t;
    if (blocked?.(x, z)) run = i + 1; else if (i - run > to - from) { from = run; to = i; }
  }
  if (to - from < 2) return { route, samples, fromDoor: false, whole: false, cut: true };
  for (let i = from; i <= to; i++) { const x = points[i * 2], z = points[i * 2 + 1]; samples.push(x, heightAt(x, z), z, FOLK_LANE_M); }
  return { route, samples, fromDoor: from === 0, whole: to === count - 1 && length <= FOLK_WAY_MOST_M, cut: from > 0 || to < count - 1 };
}
const sameWay = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);

/**
 * The streets of a port with the model's people on them. `plan` is what the model's `folk` answered; `origin` the
 * middle of the board's ground in the streets' own coordinates; `heightAt(x, z)` the ground there; `base` the port's
 * streets as they were laid (its ways, doors and those who walk between its own buildings), or null.
 * Those of the plan walk the ways the model gave them. Those who walk the port's own ways are each given the soul of
 * one of the place's other grown people, so no one about is nameless; where the model names fewer than walk there,
 * only so many walk. Returns streets as js/townsfolk.js and js/audio.js read them, with `souls[i]` the soul of
 * walker i. `kept`, a Map the caller holds from one plan to the next, spares the ground being asked again for a way
 * someone took in the last plan too: when the eye moves on, most of those about are who they were. `blocked(x, z)`
 * says where a point stands inside a building of the port's own (js/town-streets.js townSolids).
 */
export function boardFolkStreets({ plan, origin, heightAt, base = null, kept = null, blocked = null }) {
  const own = base?.people > 0 && base.walkers && base.samples ? Math.min(base.people, Math.floor(base.walkers.length / WALKER_WORDS), plan.others.length) : 0;
  const ownSamples = own ? base.samples.length / 4 : 0;
  const samples = [], ways = [], taken = kept ? new Map() : null;
  let cut = 0;
  for (const person of plan.people) {
    const before = kept?.get(person.id), way = before && sameWay(before.route, person.route) ? before : folkWay(person.route, origin, heightAt, blocked);
    taken?.set(person.id, way);
    const first = ownSamples + samples.length / 4, count = way.samples.length / 4;
    if (way.cut) cut++;
    if (!count) continue;
    for (let k = 0; k < way.samples.length; k++) samples.push(way.samples[k]);
    ways.push({ person, first, count, whole: way.whole, fromDoor: way.fromDoor });
  }
  if (kept) { kept.clear(); for (const [id, way] of taken) kept.set(id, way); }
  const people = ways.length + own;
  const buffer = new ArrayBuffer(people * WALKER_WORDS * 4), words = new Uint32Array(buffer), floats = new Float32Array(buffer), souls = new Array(people);
  const here = (point) => [origin.x + point[0], origin.z + point[1]];
  ways.forEach(({ person, first, count, whole, fromDoor }, w) => {
    const at = w * WALKER_WORDS, id = person.id, roll = (salt) => folkRoll(id, salt);
    const stays = FOLK_STAYS[person.goal] ?? FOLK_STAYS.work, pauses = person.goal !== 'play' && roll(5) < FOLK_PAUSE_SHARE;
    words[at] = first; words[at + 1] = count;
    floats[at + 2] = roll(1);
    floats[at + 3] = Math.max(0.7, Math.min(2.4, person.pace * (person.run ? 1.5 : 1)));
    floats[at + 4] = 0.25 + 0.75 * roll(2);
    floats[at + 5] = pauses ? 0.2 + 0.6 * roll(3) : 0;
    floats[at + 6] = pauses ? FOLK_PAUSE_SECONDS * (0.5 + roll(4)) : 0;
    floats[at + 7] = stays[0] + (stays[1] - stays[0]) * roll(6);
    floats[at + 8] = (count - 1) * ROUTE_STEP_M;
    // Children are in before dark; the rest keep their own hours.
    floats[at + 9] = person.age < 14 ? 0.55 + 0.45 * roll(7) : roll(7);
    words[at + 10] = Math.floor(roll(8) * 0xffff);
    // The far end is in the open where the work is, if the way reaches it; play is in the open at both. An end
    // cut short at a building's wall is gone in at.
    words[at + 11] = (person.sex === 'f' ? 1 : 0) | (person.goal === 'play' && fromDoor ? 2 : 0) | (whole && (person.open || person.goal === 'play') ? 4 : 0);
    const last = person.route.length - 2;
    souls[w] = { id, name: person.name, surname: person.surname, sex: person.sex, age: person.age, role: person.role, goal: person.goal, there: person.there, via: person.via,
      home: here(person.home), to: here([person.route[last], person.route[last + 1]]), planned: true };
  });
  if (own) {
    const from = new Uint32Array(base.walkers.buffer, base.walkers.byteOffset, own * WALKER_WORDS);
    words.set(from, ways.length * WALKER_WORDS);
    for (let k = 0; k < own; k++) {
      const at = (ways.length + k) * WALKER_WORDS, soul = plan.others[k];
      words[at + 10] = Math.floor(folkRoll(soul.id, 8) * 0xffff);
      words[at + 11] = (words[at + 11] & ~1) | (soul.sex === 'f' ? 1 : 0);
      souls[ways.length + k] = { ...soul, goal: 'about', there: 'about the waterside', via: '', home: null, to: null, planned: false };
    }
  }
  const all = new Float32Array(ownSamples * 4 + samples.length);
  if (own) all.set(base.samples, 0);
  all.set(samples, ownSamples * 4);
  return { ...(base ?? {}), samples: all, walkers: floats, people, souls, folk: { day: plan.day, date: plan.date, sunday: plan.sunday, planned: ways.length, own, cut } };
}

// What a soul is doing, in words, from where its walker is on its way (js/audio.js townWalkerStride gives `stride`,
// null while they are indoors or home after dark).
export function folkDoing(soul, stride, length) {
  if (!soul.planned) return soul.there;
  if (!stride) return soul.goal === 'play' ? 'at home' : 'indoors';
  if (stride.stopped && stride.walked >= length - 0.5 && !stride.back) return soul.there;
  if (soul.goal === 'play') return soul.there;
  const by = soul.via ? ` by ${/^(the|a) /i.test(soul.via) ? '' : 'the '}${soul.via.toLowerCase()}` : '';
  return (stride.back ? 'walking home' : soul.goal === 'church' ? 'walking to mass' : soul.goal === 'errand' ? 'out on an errand' : 'walking to work') + by;
}
