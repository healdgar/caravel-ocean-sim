#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editAudio, generateSound, resolveAudioKey, reviewWave } from './audio.mjs';
import { paidRequest, speechRequest } from './voices.mjs';

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_AUDIO_ROOT = existsSync('/Users/alexwall/dev/waterworld/.env.local')
  ? '/Users/alexwall/dev/waterworld'
  : WORKTREE_ROOT;
const WORLD_TAKE_DIR = path.join(MAIN_AUDIO_ROOT, '.audio/world');
const PILOT_TAKE_DIR = path.join(MAIN_AUDIO_ROOT, '.audio/pilot');

const WORLD_RECIPES = JSON.parse(
  readFileSync(new URL('./audio/world.json', import.meta.url), 'utf8')
);

const worldHash = (buf) => createHash('sha256').update(buf).digest('hex');

export async function generateWorldAudio({
  take = '01',
  ids = null,
  root = MAIN_AUDIO_ROOT,
  dir = WORLD_TAKE_DIR,
  fetchImpl = fetch,
} = {}) {
  const filterSet = ids
    ? new Set(String(ids).split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const list = WORLD_RECIPES.sfx.filter((s) => !filterSet || filterSet.has(s.id));
  if (!list.length) throw Error('No world audio recipes matched.');
  const key = await resolveAudioKey({ root });
  await fs.mkdir(dir, { recursive: true });
  const results = [];
  for (const item of list) {
    if (item.kind === 'pilot-reuse') {
      const srcMp3 = path.join(PILOT_TAKE_DIR, item.sourceTake);
      const srcJson = srcMp3.replace(/\.mp3$/, '.json');
      const dstMp3 = path.join(dir, `${item.id}-${take}.mp3`);
      const dstJson = path.join(dir, `${item.id}-${take}.json`);
      await fs.copyFile(srcMp3, dstMp3);
      if (existsSync(srcJson)) {
        const rec = JSON.parse(await fs.readFile(srcJson, 'utf8'));
        rec.id = item.id;
        rec.take = take;
        rec.status = 'complete';
        await fs.writeFile(dstJson, JSON.stringify(rec, null, 2) + '\n');
      } else {
        const bytes = await fs.readFile(dstMp3);
        await fs.writeFile(
          dstJson,
          JSON.stringify(
            {
              id: item.id,
              take,
              status: 'complete',
              bytes: bytes.length,
              sha256: worldHash(bytes),
              request: { model_id: 'eleven_text_to_sound_v2', text: item.sourceTake },
            },
            null,
            2
          ) + '\n'
        );
      }
      results.push({ id: item.id, reusedPilot: true });
      continue;
    }
    if (item.kind === 'voice') {
      const request = speechRequest(item.text, { seed: 1550 });
      const route = `/v1/text-to-speech/${item.voiceId}?output_format=${WORLD_RECIPES.outputFormat}`;
      results.push(
        await paidRequest(item.id + '-' + take, route, request, {
          key,
          dir,
          audio: true,
          fetchImpl,
          meta: { id: item.id, take, actor: item.actor, sex: item.sex, category: item.category },
        })
      );
    } else {
      results.push(
        await generateSound(item, { take, dir, key, fetchImpl })
      );
    }
  }
  return results;
}

export async function promoteWorldAudio({
  take = '01',
  dir = WORLD_TAKE_DIR,
  out = path.join(WORKTREE_ROOT, 'assets/audio/world'),
  jsOut = path.join(WORKTREE_ROOT, 'js/world-audio-assets.js'),
} = {}) {
  await fs.mkdir(out, { recursive: true });
  const assets = {};
  const provenance = [];
  for (const recipe of WORLD_RECIPES.sfx) {
    const id = recipe.id;
    const base = path.join(dir, `${id}-${take}`);
    const record = JSON.parse(await fs.readFile(`${base}.json`, 'utf8'));
    const input = `${base}.mp3`;
    const output = path.join(out, `${id}.mp3`);
    const rawDuration = Number(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
        { encoding: 'utf8' }
      ).trim()
    );
    const startSec = recipe.startSeconds ?? 0;
    const availDur = Math.max(0.1, rawDuration - startSec);
    const maxDur = recipe.maxDuration ?? availDur;
    const targetDur = Math.min(availDur, maxDur);
    if (recipe.loop) {
      const pcm = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          input,
          ...(recipe.filter ? ['-af', recipe.filter] : []),
          '-f',
          'f32le',
          '-ac',
          '2',
          '-ar',
          '44100',
          'pipe:1',
        ],
        { maxBuffer: 32 * 1024 * 1024 }
      );
      const endSec = Math.min(rawDuration, startSec + targetDur);
      const crossfade = Math.min(recipe.loopCrossfade ?? 0.9, Math.max(0.15, (endSec - startSec) * 0.25));
      const prepared = reviewWave(
        editAudio(pcm, {
          startSeconds: startSec,
          endSeconds: endSec,
          loopCrossfadeSeconds: crossfade,
        })
      );
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-f',
          'wav',
          '-i',
          'pipe:0',
          '-map_metadata',
          '-1',
          '-ac',
          '1',
          '-ar',
          '44100',
          '-c:a',
          'libmp3lame',
          '-q:a',
          '5',
          output,
        ],
        { input: prepared.wav }
      );
    } else {
      const fadeOut = Math.min(recipe.fadeOut ?? 0.15, Math.max(0.04, targetDur * 0.25));
      const fadeStart = Math.max(0, targetDur - fadeOut);
      const afChain = [
        recipe.filter,
        `afade=t=in:st=0:d=0.015`,
        `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`,
      ]
        .filter(Boolean)
        .join(',');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
        '-i',
        input,
        '-t',
        targetDur.toFixed(3),
        '-map_metadata',
        '-1',
        '-af',
        afChain,
        '-ac',
        '1',
        '-ar',
        '44100',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '5',
        output,
      ]);
    }
    const seconds = Number(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output],
        { encoding: 'utf8' }
      ).trim()
    );
    const bytes = await fs.readFile(output);
    assets[id] = {
      url: `assets/audio/world/${id}.mp3`,
      loop: Boolean(recipe.loop),
      lazyLoop: Boolean(recipe.loop),
      gain: recipe.gain ?? 0.25,
      category: recipe.category ?? 'world',
      sex: recipe.sex ?? null,
      seconds: +seconds.toFixed(3),
    };
    provenance.push({
      id,
      take,
      category: recipe.category,
      provider: 'ElevenLabs',
      model: record.request?.model_id ?? 'eleven_text_to_sound_v2',
      voiceId: recipe.voiceId ?? null,
      text: recipe.text ?? null,
      prompt: recipe.prompt ?? null,
      seconds: +seconds.toFixed(3),
      sourceSha256: record.sha256,
      sha256: worldHash(bytes),
      bytes: bytes.length,
    });
  }
  await fs.writeFile(path.join(out, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  await fs.writeFile(
    jsOut,
    '// Offline authored; generated by scripts/world-audio.mjs promote.\nexport const WORLD_AUDIO_ASSETS = ' +
      JSON.stringify(assets, null, 2) +
      ';\n'
  );
  console.log(
    JSON.stringify({
      promoted: provenance.length,
      bytes: provenance.reduce((s, a) => s + a.bytes, 0),
    })
  );
}

async function main(args) {
  const [cmd = 'plan', take = '01', ids = null] = args;
  if (cmd === 'plan') console.log(JSON.stringify(WORLD_RECIPES, null, 2));
  else if (cmd === 'generate') console.log(JSON.stringify(await generateWorldAudio({ take, ids })));
  else if (cmd === 'promote') await promoteWorldAudio({ take });
  else throw Error('Usage: world-audio.mjs [plan|generate|promote] [take] [ids]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
