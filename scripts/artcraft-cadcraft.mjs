#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 17983;
const BIN = '/Applications/CADCraft.app/Contents/MacOS/CADCraft';
const OUT_DIR = path.resolve('assets/artcraft');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[CADCraft] Launching control server on port', PORT);
const proc = spawn(BIN, ['--control', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let tokenPathFromLog = null;
proc.stdout.on('data', (d) => {
  const s = d.toString();
  const m = s.match(/([^\s]+cadcraft-control-\d+\.token)/);
  if (m) tokenPathFromLog = m[1];
});
proc.stderr.on('data', (d) => {
  const s = d.toString();
  const m = s.match(/([^\s]+cadcraft-control-\d+\.token)/);
  if (m) tokenPathFromLog = m[1];
});

function findToken() {
  const candidates = [
    tokenPathFromLog,
    path.join(os.homedir(), '.cache', `cadcraft-control-${PORT}.token`),
    path.join(os.tmpdir(), `cadcraft-control-${PORT}.token`),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  return null;
}

async function connectControl() {
  for (let i = 0; i < 60; i++) {
    const token = findToken();
    if (token) {
      try {
        const sock = await new Promise((resolve, reject) => {
          const s = net.createConnection({ host: '127.0.0.1', port: PORT }, () => resolve(s));
          s.once('error', reject);
        });
        return { sock, token };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Could not connect to CADCraft control server');
}

const { sock, token } = await connectControl();
let reqId = 1;
let buf = '';
const pending = new Map();

sock.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else if (pending.size === 1) {
        const [firstId, { resolve }] = pending.entries().next().value;
        pending.delete(firstId);
        resolve(msg);
      }
    } catch (e) {
      console.error('Parse error:', e, line);
    }
  }
});

function call(method, params = {}) {
  const id = reqId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    sock.write(JSON.stringify({ id, token, method, params }) + '\n');
  });
}

try {
  const methodsRes = await call('control.methods', {});
  console.log('[CADCraft] Control methods:', JSON.stringify(methodsRes).slice(0, 240));

  // Draft a 16th-century trace italienne square bastion fort (50m x 50m outer frame)
  // matching Waterworld's squareFortPlan(50, 50) in js/fort-plan.js:
  // hw = 25, hl = 25, corner centers at (±21.5, ±21.5), bastionRadius = 6.0m,
  // gateHalfWidth = 2.2m on the +Y (landward) curtain, plus angled trace italienne
  // salient ears and firing-step clearance (3.5m).
  const scriptLines = [
    '-LAYER N CURTAIN C 30 CURTAIN N BASTION C 10 BASTION N EMBRASURE C 2 BASTION N GATE C 3 GATE N PARADE C 8 PARADE S BASTION ',
    // 4 Corner circular bastions (radius 6.0m at ±21.5, ±21.5)
    'CIRCLE -21.5,-21.5 6.0',
    'CIRCLE 21.5,-21.5 6.0',
    'CIRCLE 21.5,21.5 6.0',
    'CIRCLE -21.5,21.5 6.0',
    // Angled trace-italienne salient diamonds around each corner bastion
    'LINE -21.5,-29.5 -29.5,-21.5 -21.5,-13.5 -13.5,-21.5 C',
    'LINE 21.5,-29.5 29.5,-21.5 21.5,-13.5 13.5,-21.5 C',
    'LINE 21.5,29.5 29.5,21.5 21.5,13.5 13.5,21.5 C',
    'LINE -21.5,29.5 -29.5,21.5 -21.5,13.5 -13.5,21.5 C',
    // Switch to CURTAIN layer for the 4 curtains (stopping at bastionRadius + 0.1 = 6.1m)
    '-LAYER S CURTAIN ',
    // Seaward curtain (-Y)
    'LINE -15.4,-21.5 15.4,-21.5 ',
    // Inner parapet wall (1.5m solid half-width * 2 = 3.0m)
    'LINE -15.4,-18.5 15.4,-18.5 ',
    // West curtain (-X)
    'LINE -21.5,-15.4 -21.5,15.4 ',
    'LINE -18.5,-15.4 -18.5,15.4 ',
    // East curtain (+X)
    'LINE 21.5,-15.4 21.5,15.4 ',
    'LINE 18.5,-15.4 18.5,15.4 ',
    // Landward curtain (+Y) split by 4.4m gate (gateHalfWidth = 2.2m)
    'LINE -15.4,21.5 -2.2,21.5 ',
    'LINE 2.2,21.5 15.4,21.5 ',
    // Gate jambs & approach apron on GATE layer
    '-LAYER S GATE ',
    'LINE -2.2,18.5 -2.2,25.5 ',
    'LINE 2.2,18.5 2.2,25.5 ',
    'RECTANG -5.0,7.5 5.0,35.5',
    // Parade & firing-step clearance boundary (3.5m inside wall centerline -> ±18.0m)
    '-LAYER S PARADE ',
    'RECTANG -18.0,-18.0 18.0,18.0',
    // Guardhouse & central hall footprint
    'RECTANG -11.9,-19.7 -5.1,-11.3',
    'RECTANG -6.0,-4.5 6.0,4.5',
    // Embrasure rays on EMBRASURE layer
    '-LAYER S EMBRASURE ',
    'LINE -21.5,-21.5 -21.5,-28.5 ',
    'LINE -21.5,-21.5 -28.5,-21.5 ',
    'LINE 21.5,-21.5 21.5,-28.5 ',
    'LINE 21.5,-21.5 28.5,-21.5 ',
    'LINE 21.5,21.5 21.5,28.5 ',
    'LINE -21.5,21.5 -21.5,28.5 ',
    'ZOOM E',
  ].join('\n') + '\n';

  const scriptRes = await call('cmdline.script', { text: scriptLines });
  console.log('[CADCraft] Script result:', JSON.stringify(scriptRes).slice(0, 240));

  const dxfPath = path.join(OUT_DIR, 'fort-trace-italienne.dxf');
  const svgPath = path.join(OUT_DIR, 'fort-trace-italienne.svg');
  const pngPath = path.join(OUT_DIR, 'fort-trace-italienne.png');

  const saveRes = await call('app.save', { path: dxfPath });
  console.log('[CADCraft] Save DXF:', JSON.stringify(saveRes).slice(0, 240));

  const exportSvgRes = await call('engine.execute', {
    command: 'export',
    params: { path: svgPath },
  });
  console.log('[CADCraft] Export SVG:', JSON.stringify(exportSvgRes).slice(0, 240));

  const renderPngRes = await call('ui.render', {
    path: pngPath,
    background: 'paper',
  });
  console.log('[CADCraft] Render PNG:', JSON.stringify(renderPngRes).slice(0, 240));
  if (renderPngRes?.result?.data && !fs.existsSync(pngPath)) {
    fs.writeFileSync(pngPath, Buffer.from(renderPngRes.result.data, 'base64'));
  }

  const inspectRes = await call('drawing.inspect', {});
  console.log('[CADCraft] Inspect:', JSON.stringify(inspectRes).slice(0, 400));
  fs.writeFileSync(
    path.join(OUT_DIR, 'fort-trace-italienne-inspect.json'),
    JSON.stringify(inspectRes?.result ?? inspectRes, null, 2) + '\n'
  );

  await call('app.quit', {});
} finally {
  sock.destroy();
  proc.kill();
}
