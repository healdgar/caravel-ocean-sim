#!/usr/bin/env node
// Drives MaterialCraft v0.2.0 over its JSON control channel to author and cook a
// procedural tileable Iberian oak planking PBR material (`assets/artcraft/caravel-oak.sbs`),
// export its cooked PBR maps + portable `.mcmat` archive (`assets/artcraft/caravel-oak.mcmat`),
// and render a 3D displaced preview (`assets/artcraft/caravel-oak-preview.png`).

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 47127;
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'assets/artcraft');
fs.mkdirSync(OUT_DIR, { recursive: true });

function connectControl(port, timeoutMs = 12000) {
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
  const bin = '/Applications/MaterialCraft.app/Contents/MacOS/MaterialCraft';
  let tokenPath = path.join(os.tmpdir(), `materialcraft-control-${PORT}.token`);
  const child = spawn(bin, ['--control', String(PORT), '--empty'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MATERIALCRAFT_NO_PREFS: '1' },
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

    // Start from a clean empty package & 512x512 material graph
    await runCmd('file.newPackage', { name: 'waterworld_materials' });
    await runCmd('file.new', { name: 'caravel_oak', kind: 'material', template: 'empty', size: 512 });

    const sourcePng = path.join(OUT_DIR, 'caravel-oak-source.png');
    const bmpRes = await runCmd('file.importBitmap', {
      path: sourcePng,
      name: 'caravel_oak_source',
    });
    const resourceName = bmpRes?.name ?? 'caravel_oak_source';

    // Bitmap node feeding the real PhotoCraft Iberian oak planks into the graph
    const oakBmp = await runCmd('graph.node.add', {
      def: 'bitmap',
      at: [120, -180],
      label: 'PhotoCraftOakBitmap',
      params: { resource: resourceName, colour_space: 0, color_mode: true },
    });

    // Grayscale conversion from the oak bitmap for true wood-grain height
    const oakGray = await runCmd('graph.node.add', {
      def: 'grayscale_conversion',
      at: [340, -80],
      label: 'OakLuminanceHeight',
      params: { red: 0.42, green: 0.43, blue: 0.15 },
      connectFrom: { node: oakBmp.id },
    });

    // Emboss wood grain micro-relief
    const emboss = await runCmd('graph.node.add', {
      def: 'emboss',
      at: [560, 40],
      label: 'PlankGrainRelief',
      params: { intensity: 1.4, light_angle: 1.5708 },
      connectFrom: { node: oakGray.id },
    });

    // Blend real oak luminance height with embossed micro-relief
    const heightCombine = await runCmd('graph.node.add', {
      def: 'blend',
      at: [780, -40],
      label: 'CombinedOakHeight',
      params: { opacity: 0.78, mode: 0 },
      connectFrom: { node: oakGray.id },
    });
    await runCmd('graph.connect', { from: emboss.id, to: heightCombine.id, toPort: 'background' });

    // Height output
    await runCmd('graph.node.add', {
      def: 'output',
      at: [1460, 300],
      label: 'height',
      params: { identifier: 'height', usage: 4 },
      connectFrom: { node: heightCombine.id },
    });

    // Sharpen on the PhotoCraft oak bitmap -> Base Color output
    const sharpAlbedo = await runCmd('graph.node.add', {
      def: 'sharpen',
      at: [1240, -320],
      label: 'CrispOakAlbedo',
      params: { intensity: 0.85 },
      connectFrom: { node: oakBmp.id },
    });
    const outBase = await runCmd('graph.node.add', {
      def: 'output',
      at: [1460, -320],
      label: 'baseColor',
      params: { identifier: 'baseColor', usage: 0 },
      connectFrom: { node: sharpAlbedo.id },
    });

    // Normal node -> Normal output
    const norm = await runCmd('graph.node.add', {
      def: 'normal',
      at: [1240, -120],
      label: 'OakNormalOpenGL',
      params: { intensity: 3.5, opengl: true },
      connectFrom: { node: heightCombine.id },
    });
    const outNorm = await runCmd('graph.node.add', {
      def: 'output',
      at: [1460, -120],
      label: 'normal',
      params: { identifier: 'normal', usage: 1 },
      connectFrom: { node: norm.id },
    });

    // Levels -> Roughness output
    const rough = await runCmd('graph.node.add', {
      def: 'levels',
      at: [1240, 20],
      label: 'OakRoughness',
      params: { in_low: 0.0, in_mid: 0.5, in_high: 1.0, out_low: 0.48, out_high: 0.86 },
      connectFrom: { node: heightCombine.id },
    });
    const outRough = await runCmd('graph.node.add', {
      def: 'output',
      at: [1460, 20],
      label: 'roughness',
      params: { identifier: 'roughness', usage: 2 },
      connectFrom: { node: rough.id },
    });

    // Levels -> Ambient Occlusion output
    const ao = await runCmd('graph.node.add', {
      def: 'levels',
      at: [1240, 160],
      label: 'OakCavityAO',
      params: { in_low: 0.0, in_mid: 0.45, in_high: 1.0, out_low: 0.35, out_high: 1.0 },
      connectFrom: { node: heightCombine.id },
    });
    const outAo = await runCmd('graph.node.add', {
      def: 'output',
      at: [1460, 160],
      label: 'ambientOcclusion',
      params: { identifier: 'ambientOcclusion', usage: 5 },
      connectFrom: { node: ao.id },
    });

    const cookRes = await runCmd('graph.cook', { full: true });
    console.log('Cooked MaterialCraft graph:', JSON.stringify(cookRes));

    const sbsPath = path.join(OUT_DIR, 'caravel-oak.sbs');
    await runCmd('file.save', { path: sbsPath });

    const mapsDir = path.join(OUT_DIR, 'caravel-oak-maps');
    fs.mkdirSync(mapsDir, { recursive: true });
    // Remove previous files in mapsDir to avoid filename collision errors
    for (const f of fs.readdirSync(mapsDir)) fs.unlinkSync(path.join(mapsDir, f));
    const exportRes = await runCmd('file.export', {
      dir: mapsDir,
      format: 'png',
      depth: 8,
      size: 512,
    });
    console.log('Exported PBR maps:', JSON.stringify(exportRes));

    const mcmatPath = path.join(OUT_DIR, 'caravel-oak.mcmat');
    const mcmatRes = await runCmd('file.exportMaterial', {
      path: mcmatPath,
      size: 512,
    });
    console.log('Exported .mcmat:', JSON.stringify(mcmatRes));

    await runCmd('view.3d.outputs', { reset: true });
    await runCmd('view.3d', {
      scene: 'rounded_cube',
      environment: 'sunset',
      tiling: 2.0,
      heightScale: 0.04,
      yaw: 0.65,
      pitch: 0.38,
      distance: 2.6,
    });

    const previewPath = path.join(OUT_DIR, 'caravel-oak-preview.png');
    const renderRes = await call('view.screenshot', {
      path: previewPath,
      view: '3d',
      width: 640,
      height: 640,
      hq: true,
    });
    if (renderRes?.png) {
      fs.writeFileSync(previewPath, Buffer.from(renderRes.png, 'base64'));
    }
    console.log('Rendered 3D material preview:', previewPath, renderRes?.width, renderRes?.height);

    sock.end();
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
