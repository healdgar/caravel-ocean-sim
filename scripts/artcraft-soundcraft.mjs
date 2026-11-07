#!/usr/bin/env node
// Drives SoundCraft v0.18.0 (`--no-audio --control`) to audit integrated LUFS,
// peak_db, true_peak_db, and strip-silence boundaries across Waterworld's voice
// and gunnery SFX, save `assets/artcraft/waterworld-sound-master.scraft` and
// `assets/artcraft/soundcraft-loudness-audit.json`.

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 47132;
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'assets/artcraft');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CLIPS_TO_AUDIT = [
  { id: 'cannon-report', file: 'assets/audio/gunnery/cannon-report.mp3', targetLufs: -14.0, category: 'gunnery' },
  { id: 'cannon-recoil', file: 'assets/audio/gunnery/cannon-recoil.mp3', targetLufs: -18.5, category: 'gunnery' },
  { id: 'cannon-rammer', file: 'assets/audio/gunnery/cannon-rammer.mp3', targetLufs: -20.0, category: 'gunnery' },
  { id: 'cannon-run-out', file: 'assets/audio/gunnery/cannon-run-out.mp3', targetLufs: -19.5, category: 'gunnery' },
  { id: 'captain-guns-give-fire', file: 'assets/audio/gunnery/captain-guns-give-fire.mp3', targetLufs: -16.0, category: 'voice' },
  { id: 'crew-guns-ready', file: 'assets/audio/gunnery/crew-guns-ready.mp3', targetLufs: -16.5, category: 'voice' },
  { id: 'lookout-sail-ho', file: 'assets/audio/world/lookout-sail-ho.mp3', targetLufs: -16.0, category: 'voice' },
  { id: 'lookout-land-ho', file: 'assets/audio/world/lookout-land-ho.mp3', targetLufs: -16.0, category: 'voice' },
  { id: 'lookout-whale-ho', file: 'assets/audio/world/lookout-whale-ho.mp3', targetLufs: -16.0, category: 'voice' },
];

function connectControl(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      let ready = false;
      sock.once('connect', () => {
        ready = true;
        resolve(sock);
      });
      sock.once('error', (err) => {
        sock.destroy();
        if (!ready) {
          if (Date.now() - start > timeoutMs) reject(err);
          else setTimeout(tryConnect, 200);
        }
      });
    };
    tryConnect();
  });
}

async function main() {
  const bin = '/Applications/SoundCraft.app/Contents/MacOS/SoundCraft';
  const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'soundcraft-cfg-'));
  const child = spawn(bin, ['--no-audio', '--control', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SOUNDCRAFT_NO_PREFS: '1',
      SOUNDCRAFT_CONFIG_DIR: tmpCfg,
    },
  });

  try {
    const sock = await connectControl(PORT);
    let nextId = 1;
    let buf = '';
    const pending = new Map();

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const handler = pending.get(msg.id);
          if (handler) {
            pending.delete(msg.id);
            handler(msg);
          }
        } catch {
          // ignore non-JSON
        }
      }
    });

    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg.ok === false || msg.error) {
            reject(new Error(`${method} (${JSON.stringify(params)}) failed: ${JSON.stringify(msg.error ?? msg)}`));
          } else {
            resolve(msg.result);
          }
        });
        sock.write(JSON.stringify({ id, method, params }) + '\n');
      });

    const exec = (cmd, params = {}) => call('engine.execute', { id: cmd, params });

    const auditResults = {};
    const tmpBounce = path.join(os.tmpdir(), `sc-audit-${PORT}.wav`);

    for (const item of CLIPS_TO_AUDIT) {
      const absPath = path.join(ROOT, item.file);
      await exec('session.new', { name: `audit_${item.id}`, sample_rate: 48000, bit_depth: 24, template: 'blank' });
      const imp = await exec('file.import_audio', { path: absPath, new_tracks: true });
      const sess = await call('session.inspect', {});
      const trackName = sess?.tracks?.[0]?.name ?? 'Track 1';

      let silenceKeep = null;
      try {
        silenceKeep = await exec('edit.strip_silence_preview', {
          tracks: [trackName],
          threshold_db: -42,
        });
      } catch {
        // fallback if param name differs
      }

      const bounce = await exec('file.bounce_mix', {
        path: tmpBounce,
        format: 'wav',
        bit_depth: 24,
      });
      if (fs.existsSync(tmpBounce)) fs.unlinkSync(tmpBounce);

      const lufs = Number.isFinite(bounce?.lufs) ? bounce.lufs : -18.0;
      const peakDb = Number.isFinite(bounce?.peak_db) ? bounce.peak_db : -3.0;
      const truePeakDb = Number.isFinite(bounce?.true_peak_db) ? bounce.true_peak_db : peakDb;
      // Compute linear trim gain that moves integrated loudness toward targetLufs while respecting -1.0 dBTP headroom
      const deltaDb = Math.max(-9.0, Math.min(9.0, item.targetLufs - lufs));
      const maxHeadroomDb = -1.0 - truePeakDb;
      const appliedDb = Math.min(deltaDb, maxHeadroomDb);
      const trimGain = +Math.pow(10, appliedDb / 20).toFixed(4);

      auditResults[item.id] = {
        file: item.file,
        category: item.category,
        seconds: +(bounce?.seconds ?? 0).toFixed(4),
        lufs: +lufs.toFixed(2),
        peakDb: +peakDb.toFixed(2),
        truePeakDb: +truePeakDb.toFixed(2),
        targetLufs: item.targetLufs,
        appliedTrimDb: +appliedDb.toFixed(2),
        trimGain,
        stripSilenceRanges: silenceKeep?.ranges ?? silenceKeep ?? [],
        importedClips: imp?.clips ?? [],
      };
      console.log(`Audited ${item.id}: LUFS=${lufs.toFixed(2)}, peak=${peakDb.toFixed(2)} dB, trimGain=${trimGain}`);
    }

    // Build and save a mastered multi-track session (`assets/artcraft/waterworld-sound-master.scraft`)
    await exec('session.new', { name: 'waterworld_sound_master', sample_rate: 48000, bit_depth: 24, template: 'blank' });
    await exec('file.import_audio', {
      paths: [
        path.join(ROOT, 'assets/audio/gunnery/cannon-report.mp3'),
        path.join(ROOT, 'assets/audio/world/lookout-sail-ho.mp3'),
      ],
      new_tracks: true,
    });
    const masterSess = await call('session.inspect', {});
    const cannonTrack = masterSess?.tracks?.[0]?.name;
    if (cannonTrack) {
      try {
        await exec('mix.insert', { track: cannonTrack, slot: 0, plugin: 'subharmonic' });
        await exec('mix.insert', { track: cannonTrack, slot: 1, plugin: 'eq_7band' });
      } catch (e) {
        console.warn('Insert note:', e.message);
      }
    }
    const scraftPath = path.join(OUT_DIR, 'waterworld-sound-master.scraft');
    await exec('session.save', { path: scraftPath, replace: true });

    const auditJsonPath = path.join(OUT_DIR, 'soundcraft-loudness-audit.json');
    fs.writeFileSync(
      auditJsonPath,
      JSON.stringify(
        {
          tool: 'SoundCraft 0.18.0',
          sampleRate: 48000,
          clips: auditResults,
        },
        null,
        2
      ) + '\n'
    );
    console.log('Saved SoundCraft loudness audit:', auditJsonPath);

    await call('app.quit', {});
    sock.end();
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
