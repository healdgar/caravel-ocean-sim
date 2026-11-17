#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The 1550 people at the highest quality Tripo makes: H3.1, 2M triangles with Ultra geometry, 8K texture, and an
// Unreal-spec biped rig, which is the crew skeleton's body (scripts/crew_skeleton.py); scripts/fit-crew-body.py
// keeps its weights and adds the face joints. Raw files stay in .tripo/1550-hd (git-ignored); the game ships them
// baked into the one continuum (AGENTS.md rule 3), not decimated.
// Never imported by the runtime game bundle.
//   node scripts/tripo-people.mjs plan [--only=captain,soldier]      prompts and credits; spends nothing
//   node scripts/tripo-people.mjs generate [--only=...] [--jobs=3]   spends credits: about 85 a figure
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIPO = process.env.TRIPO_BIN || (fs.existsSync('/opt/homebrew/bin/tripo') ? '/opt/homebrew/bin/tripo' : 'tripo');
export const OUT_DIR = path.join(ROOT, '.tripo', '1550-hd');
export const CREDITS_PER_FIGURE = 85; // 60 generation (H3.1, Ultra geometry, extreme texture) + 25 rig, Tripo list price

// Hair and beards are separate groom pieces, so every body is bald and clean-shaven.
const POSE = 'standing upright in a neutral T-pose with arms straight out to the sides and fingers apart, detailed realistic face with eyes, eyelids, lips and ears, single figure, no ground plane, no base, no pedestal';
export const PEOPLE = Object.freeze({
  'sailor-male': 'a realistic 16th century Iberian sailor man, bald and clean-shaven, lean weathered adult, plain loose linen shirt with rolled sleeves, knee-length wool breeches, bare feet',
  'villager-female': 'a realistic 16th century Portuguese village woman, bald head with no hair, adult, long linen chemise, laced brown wool bodice, full ankle-length russet wool skirt with a linen apron, bare feet',
  captain: 'a realistic 16th century Iberian ship and presidio captain, bald and clean-shaven man, dark velvet-trimmed doublet with a row of buttons, padded trunk hose, knitted hose and low leather shoes',
  soldier: 'a realistic 16th century Spanish tercio garrison soldier, bald and clean-shaven man, buff leather jerkin over a linen shirt, slashed trunk hose, wool hose and leather shoes, no helmet, no armour, no weapons',
  'algonquian-male': 'a realistic 16th century Algonquian Eastern Woodlands man, bald and clean-shaven, deerskin breechcloth and fringed buckskin leggings, soft moccasins, bare chest',
  'algonquian-female': 'a realistic 16th century Algonquian Eastern Woodlands woman, bald head with no hair, fringed deerskin wrap dress, buckskin leggings, soft moccasins',
  'caribbean-male': 'a realistic late 15th century Taino Caribbean man, bald and clean-shaven, white cotton loincloth, red and black body paint patterns, bare feet',
  'caribbean-female': 'a realistic late 15th century Taino Caribbean woman, bald head with no hair, short white woven cotton nagua skirt and a cotton wrap over the chest, body paint patterns, bare feet',
  'maya-male': 'a realistic 16th century coastal Maya man, bald and clean-shaven, woven cotton loincloth with a short cotton shoulder cape, leather sandals',
  'maya-female': 'a realistic 16th century coastal Maya woman, bald head with no hair, embroidered white cotton huipil blouse over a wrapped cotton skirt, bare feet',
  'andean-male': 'a realistic 16th century Andean Inca man, bald and clean-shaven, knee-length woven wool unku tunic with a geometric tocapu band, sandals',
  'andean-female': 'a realistic 16th century Andean Inca woman, bald head with no hair, ankle-length wrapped wool anaku dress with a lliklla shawl pinned at the chest, sandals',
});

export function tripoArgs(id) {
  if (!PEOPLE[id]) throw Error(`Unknown figure "${id}". Expected one of: ${Object.keys(PEOPLE).join(', ')}`);
  return ['make', `${PEOPLE[id]}, ${POSE}`, '--model', 'tripo-v3.1',
    '-p', 'face_limit=2000000', '-p', 'geometry_quality=detailed', '-p', 'texture_quality=extreme', '-p', 'pbr=false',
    '--then', 'rig-check,rig:spec=unreal', '-o', path.join(OUT_DIR, id), '--name', `hd-${id}`, '--json', '--yes', '--no-open'];
}

async function generate(id) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  try {
    const { stdout } = await run(TRIPO, tripoArgs(id), { timeout: 3_600_000, maxBuffer: 16 << 20 });
    fs.writeFileSync(path.join(OUT_DIR, `${id}.json`), stdout);
    const result = JSON.parse(stdout.trim().split('\n').pop());
    console.log(`${id}: ${result.status}, ${result.credits_consumed} credits, ${((Date.now() - started) / 60000).toFixed(1)} min, ${result.model_file}`);
  } catch (error) {
    fs.writeFileSync(path.join(OUT_DIR, `${id}.error.txt`), String(error.stderr || error.message));
    console.log(`${id}: FAILED (${String(error.message).split('\n')[0].slice(0, 160)})`);
  }
}

const [command = 'plan', ...rest] = process.argv.slice(2);
const only = rest.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
const jobs = Number(rest.find((a) => a.startsWith('--jobs='))?.slice(7) ?? 3);
const ids = only ?? Object.keys(PEOPLE);
if (command === 'plan') {
  for (const id of ids) console.log(`${id.padEnd(18)} ${PEOPLE[id]}`);
  console.log(`${ids.length} figures, about ${ids.length * CREDITS_PER_FIGURE} credits`);
} else if (command === 'generate') {
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) await generate(queue.shift()); }));
} else {
  console.log('usage: node scripts/tripo-people.mjs plan|generate [--only=a,b] [--jobs=3]');
}
