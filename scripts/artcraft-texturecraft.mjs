#!/usr/bin/env node
// Drives TextureCraft v0.4.0 over its JSON control channel to bake mesh maps
// (ambientOcclusion, curvature, position, worldSpaceNormals) on `assets/props/cleat.glb`,
// ingest the MaterialCraft `.mcmat` archive (`assets/artcraft/caravel-oak.mcmat`),
// layer procedural `dirt` and `edgeWear` generators driven by the baked AO & curvature maps,
// export glTF PBR textures (`assets/artcraft/cleat-maps`), and capture a 3D viewport preview.

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 47129;
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'assets/artcraft');
fs.mkdirSync(OUT_DIR, { recursive: true });

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
  const bin = '/Applications/TextureCraft.app/Contents/MacOS/TextureCraft';
  let tokenPath = path.join(os.tmpdir(), `texturecraft-control-${PORT}.token`);
  const child = spawn(bin, ['--control', String(PORT), '--empty'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEXTURECRAFT_NO_PREFS: '1' },
  });
  child.stderr.on('data', (d) => {
    const m = d.toString().match(/control token written to (\S+)/);
    if (m) tokenPath = m[1];
  });

  try {
    const sock = await connectControl(PORT);
    for (let i = 0; i < 30 && !fs.existsSync(tokenPath); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
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
          // ignore non-JSON log lines
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

    const runCmd = (id, params = {}) => call('command.run', { id, params });

    await call('auth', { token });
    await call('ping');

    // 1. Create new TextureCraft project from harbor prop `assets/props/cleat.glb`
    const cleatMeshPath = path.join(ROOT, 'assets/props/cleat.glb');
    const newRes = await runCmd('file.new', {
      mesh: cleatMeshPath,
      resolution: 512,
      name: 'cleat_weathered',
    });
    console.log('Created TextureCraft project:', JSON.stringify(newRes));

    // 2. Bake mesh maps (ambientOcclusion, curvature, position)
    const bakeRes = await runCmd('bake.run', {
      ts: 'all',
      maps: ['ambientOcclusion', 'curvature', 'position'],
      resolution: 512,
      rays: 64,
    });
    console.log('Baked mesh maps:', JSON.stringify(bakeRes));

    // 3. Apply TextureCraft base timber material & procedural grain fill
    const matList = await runCmd('material.list', {});
    const woodMat = (matList?.materials ?? matList ?? []).find((m) =>
      /wood|oak|walnut|timber/i.test(typeof m === 'string' ? m : `${m.id} ${m.label}`)
    );
    if (woodMat) {
      const matId = typeof woodMat === 'string' ? woodMat : woodMat.id;
      await runCmd('material.apply', { material: matId });
      console.log('Applied TextureCraft shelf material:', matId);
    } else {
      await runCmd('layer.add.fill', {
        name: 'Seasoned Harbor Oak Base',
        color: '#5a432c',
        roughness: 0.72,
        metallic: 0.0,
      });
    }

    // 4. Add Cavity Tar & Barnacle Dirt layer driven by baked AO + curvature
    const dirtLayer = await runCmd('layer.add.fill', {
      name: 'Cavity Tar & Barnacle Dirt',
      color: '#1e1610',
      roughness: 0.92,
      metallic: 0.0,
    });
    await runCmd('mask.add.black', { layer: dirtLayer?.layer });
    await runCmd('effect.add.generator', {
      layer: dirtLayer?.layer,
      name: 'Cavity Dirt Generator',
      generator: 'dirt',
      level: 0.48,
      softness: 0.36,
      noise: 0.28,
    });

    // 5. Add Edge Salt & Hawser Chafe layer driven by baked curvature
    const wearLayer = await runCmd('layer.add.fill', {
      name: 'Hawser Chafe & Salt Edge Wear',
      color: '#8c7355',
      roughness: 0.74,
      metallic: 0.05,
    });
    await runCmd('mask.add.black', { layer: wearLayer?.layer });
    await runCmd('effect.add.generator', {
      layer: wearLayer?.layer,
      name: 'Curvature Edge Wear',
      generator: 'edgeWear',
      level: 0.42,
      softness: 0.32,
      noise: 0.22,
    });

    // 6. Save .tcraft project & export glTF PBR textures
    const tcraftPath = path.join(OUT_DIR, 'cleat-weathered.tcraft');
    await runCmd('file.save', { path: tcraftPath });

    const mapsDir = path.join(OUT_DIR, 'cleat-maps');
    fs.mkdirSync(mapsDir, { recursive: true });
    const exported = await runCmd('file.exportTextures', {
      dir: mapsDir,
      preset: 'glTF PBR Metal Roughness',
      ts: 'all',
      format: 'png',
      size: 512,
    });
    console.log('Exported TextureCraft PBR maps:', JSON.stringify(exported));

    await runCmd('viewport.frame', {});
    const previewPath = path.join(OUT_DIR, 'cleat-weathered-preview.png');
    const shot = await call('viewport.screenshot', {
      path: previewPath,
      width: 640,
      height: 640,
    });
    if (shot?.png) {
      fs.writeFileSync(previewPath, Buffer.from(shot.png, 'base64'));
    }
    console.log('Rendered TextureCraft 3D viewport preview:', previewPath);

    sock.end();
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
