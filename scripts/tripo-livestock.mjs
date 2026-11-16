#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Local Tripo 3D V3 CLI interface for 16th-century Iberian & Colonial livestock
// (Merino/Churra sheep, Barrosã/Mertolenga cattle, Porco Preto swine, Lusitano horse).
// Never imported by the runtime game bundle.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';

const execFileAsync = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TRIPO_BIN = process.env.TRIPO_BIN || (existsSync('/opt/homebrew/bin/tripo') ? '/opt/homebrew/bin/tripo' : 'tripo');
export const OUT_DIR = path.join(ROOT, '.tripo', 'livestock');
export const BLENDER_BIN = process.env.BLENDER_BIN || '/Applications/Blender.app/Contents/MacOS/Blender';

export const LIVESTOCK_PRESETS = Object.freeze({
  sheep: Object.freeze({
    speciesIndex: 0,
    heightM: 0.82,
    faceLimit: 8000,
    prompt: 'a single realistic 16th century Iberian Merino sheep standing symmetrically on all four legs facing straight forward, thick natural cream wool fleece, bare dark face and slender lower shanks with cloven hooves, neutral symmetric quadruped rest pose, isolated full body animal, no ground plane, no grass, no pedestal',
  }),
  cattle: Object.freeze({
    speciesIndex: 1,
    heightM: 1.52,
    faceLimit: 10000,
    prompt: 'a single realistic 16th century Portuguese Barrosa ox standing symmetrically on all four legs facing straight forward, rich reddish brown hide, muscular shoulders and deep brisket dewlap, sweeping lyre-shaped horns, tufted switch tail and cloven hooves, neutral symmetric quadruped rest pose, isolated full body animal, no ground plane, no yoke, no pedestal',
  }),
  swine: Object.freeze({
    speciesIndex: 2,
    heightM: 0.66,
    faceLimit: 7000,
    prompt: 'a single realistic 16th century black Iberian pig Porco Preto standing symmetrically on all four legs facing straight forward, dark slate bristle coat, long conical rooting snout, forward-drooping ears, stout barrel body and short trotters, neutral symmetric quadruped rest pose, isolated full body animal, no ground plane, no mud base',
  }),
  horse: Object.freeze({
    speciesIndex: 3,
    heightM: 1.84,
    faceLimit: 12000,
    prompt: 'a single realistic 16th century Iberian Lusitano horse standing symmetrically on all four legs facing straight forward, athletic bay coat, proud arched crest neck with dark mane, rounded croup, flowing tail and clean hooves, neutral symmetric quadruped rest pose, bareback without saddle or base, isolated full body animal, no ground plane',
  }),
});

export const MODEL_COSTS = Object.freeze({
  'P1-20260311': 40,
  'P2-20260801': 110,
  'v3.1-20260211': 110,
});
export const QUADRUPED_RIG_COST = 25;

const redact = (text) => String(text).replace(/\b(?:tsk_|sk-|msy_)[A-Za-z0-9_…-]+/g, '[redacted]');

const HELP = `Local Tripo 3D V3 livestock authoring & continuum baker

Usage:
  npm run tripo:livestock -- doctor                         Check Tripo CLI, active profile & credit balance
  npm run tripo:livestock -- plan [--species all|horse]     Print exact Tripo V3 CLI pipeline & credit budget (0 credits)
  npm run tripo:livestock -- generate [--species all|horse] [--model P2-20260801|P1-20260311] [--no-rig]
                                                            Generate & quadruped-rig via Tripo 3D CLI, then bake continuum
  npm run tripo:livestock -- bake                           Bake .tripo/livestock GLBs (or Blender voxel-sculpts) -> assets/wildlife/livestock-1550.bin
  npm run tripo:livestock -- topup                          Open Tripo billing page and watch for credit arrival
`;

export function selectSpeciesList(specArg = 'all') {
  if (!specArg || specArg === 'all') return Object.keys(LIVESTOCK_PRESETS);
  const items = specArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const name of items) {
    if (!LIVESTOCK_PRESETS[name]) {
      throw new Error(`Unknown livestock species "${name}". Expected one of: ${Object.keys(LIVESTOCK_PRESETS).join(', ')}`);
    }
  }
  return items;
}

export function buildTripoArgs(species, { model = 'P2-20260801', rig = true, outDir = OUT_DIR, profile = '' } = {}) {
  const preset = LIVESTOCK_PRESETS[species];
  if (!preset) throw new Error(`Unknown species: ${species}`);
  if (!MODEL_COSTS[model]) throw new Error(`Unsupported Tripo model "${model}". Supported: ${Object.keys(MODEL_COSTS).join(', ')}`);
  const targetDir = path.join(outDir, species);
  const args = ['make', preset.prompt, '--model', model, '--face-limit', String(preset.faceLimit), '--no-pbr'];
  if (rig) {
    // Quadruped rig uses Tripo v2.5-20260210 automatically via rig:quadruped (never pass humanoid spec=unreal).
    args.push('--then', 'rig-check,rig:quadruped,retarget:preset:quadruped:walk');
  }
  args.push('-o', targetDir, '--yes', '--no-open', '--json');
  if (profile) args.push('--profile', profile);
  const unitCost = MODEL_COSTS[model] + (rig ? QUADRUPED_RIG_COST : 0);
  return { species, model, rig, targetDir, args, estimatedCredits: unitCost, promptSha256: createHash('sha256').update(preset.prompt).digest('hex') };
}

export async function queryTripoBalance({ profile = '', run = execFileAsync } = {}) {
  const args = ['balance', '--json'];
  if (profile) args.push('--profile', profile);
  const { stdout } = await run(TRIPO_BIN, args, { timeout: 20000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim());
  return {
    balance: Number(parsed.balance ?? 0),
    frozen: Number(parsed.frozen ?? 0),
  };
}

async function findCachedGlb(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await findCachedGlb(full);
        if (sub) return sub;
      } else if (e.name.endsWith('.glb')) {
        return full;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function runBake({ fromTripoDir = OUT_DIR, run = execFileAsync } = {}) {
  const script = path.join(ROOT, 'scripts', 'bake-livestock-meshes.py');
  const args = ['-b', '-P', script, '--', '--from-tripo', fromTripoDir];
  const { stdout, stderr } = await run(BLENDER_BIN, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (stderr && /Error:|Traceback/i.test(stderr)) {
    throw new Error(redact(stderr));
  }
  return stdout;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      species: { type: 'string', default: 'all' },
      model: { type: 'string', default: 'P2-20260801' },
      'no-rig': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      profile: { type: 'string', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const cmd = positionals[0] || 'help';
  if (values.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const speciesList = selectSpeciesList(values.species);
  const rig = !values['no-rig'];
  const plans = speciesList.map((sp) => buildTripoArgs(sp, { model: values.model, rig, profile: values.profile }));
  const totalCredits = plans.reduce((s, p) => s + p.estimatedCredits, 0);

  if (cmd === 'plan' || values['dry-run']) {
    console.log(JSON.stringify({
      cli: TRIPO_BIN,
      species: plans.map((p) => ({
        species: p.species,
        model: p.model,
        rig: p.rig,
        estimatedCredits: p.estimatedCredits,
        promptSha256: p.promptSha256.slice(0, 16),
        command: `${TRIPO_BIN} ${p.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
      })),
      totalEstimatedCredits: totalCredits,
    }, null, 2));
    return;
  }

  if (cmd === 'doctor') {
    const bal = await queryTripoBalance({ profile: values.profile });
    const cached = {};
    for (const sp of Object.keys(LIVESTOCK_PRESETS)) {
      cached[sp] = Boolean(await findCachedGlb(path.join(OUT_DIR, sp)));
    }
    const minP1 = speciesList.length * MODEL_COSTS['P1-20260311'];
    console.log(JSON.stringify({
      ok: true,
      tripoBin: TRIPO_BIN,
      blenderBin: BLENDER_BIN,
      balance: bal.balance,
      frozen: bal.frozen,
      requiredForSelectedPlan: totalCredits,
      minimumUnriggedP1ForSelected: minP1,
      readyToGenerateSelected: bal.balance >= totalCredits,
      cachedTripoGlbs: cached,
      hint: bal.balance < totalCredits
        ? `Current balance is ${bal.balance} credits (plan needs ${totalCredits} credits; unrigged P1 needs ${minP1}). Run 'tripo topup' to add credits, then re-run 'npm run tripo:livestock -- generate'.`
        : 'Sufficient Tripo credits available.',
    }, null, 2));
    return;
  }

  if (cmd === 'topup') {
    const args = ['topup'];
    if (values.profile) args.push('--profile', values.profile);
    await execFileAsync(TRIPO_BIN, args, { timeout: 300000 });
    return;
  }

  if (cmd === 'bake') {
    const out = await runBake();
    process.stdout.write(out);
    return;
  }

  if (cmd === 'generate') {
    const pending = [];
    for (const p of plans) {
      const existing = !values.force ? await findCachedGlb(p.targetDir) : null;
      if (existing) {
        console.log(`[cached] ${p.species}: ${path.relative(ROOT, existing)}`);
      } else {
        pending.push(p);
      }
    }
    const needed = pending.reduce((s, p) => s + p.estimatedCredits, 0);
    if (pending.length > 0) {
      const bal = await queryTripoBalance({ profile: values.profile });
      if (bal.balance < needed) {
        throw new Error(
          `Insufficient Tripo 3D credits: available=${bal.balance}, needed=${needed} for [${pending.map((p) => p.species).join(', ')}] (${values.model}${rig ? ' + rig:quadruped' : ''}). ` +
          `Run '${TRIPO_BIN} topup' (or 'npm run tripo:livestock -- doctor'), then retry.`
        );
      }
      await fs.mkdir(OUT_DIR, { recursive: true });
      for (const p of pending) {
        console.log(`[tripo] Generating ${p.species} (${p.model}${p.rig ? ' + quadruped rig' : ''}, ~${p.estimatedCredits} cr)...`);
        const { stdout } = await execFileAsync(TRIPO_BIN, p.args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
        const manifestFile = path.join(p.targetDir, 'tripo-manifest.json');
        await fs.mkdir(p.targetDir, { recursive: true });
        await fs.writeFile(manifestFile, redact(stdout).trim() + '\n');
      }
    }
    const out = await runBake();
    process.stdout.write(out);
    return;
  }

  throw new Error(`Unknown subcommand "${cmd}". Run with --help for usage.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(redact(err.message || err));
    process.exit(1);
  });
}
