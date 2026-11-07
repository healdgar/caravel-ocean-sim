#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 17985;
const BIN = '/Applications/FigCraft.app/Contents/MacOS/FigCraft';
const OUT_DIR = path.resolve('assets/artcraft');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[FigCraft] Launching control server on port', PORT);
const proc = spawn(BIN, ['--control', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function connectControl() {
  for (let i = 0; i < 60; i++) {
    try {
      const sock = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port: PORT }, () => resolve(s));
        s.once('error', reject);
      });
      return sock;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('Could not connect to FigCraft control server');
}

const sock = await connectControl();
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
    sock.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

async function execCmd(command, params = {}) {
  const res = await call('engine.execute', { command, params });
  if (!res?.ok) {
    console.warn(`[FigCraft] Command ${command} warning:`, JSON.stringify(res));
  }
  return res;
}

try {
  // Root showcase frame on page 1
  const rootRes = await execCmd('node.create', {
    type: 'frame',
    x: 0,
    y: 0,
    width: 780,
    height: 460,
    name: 'Waterworld 1550 UI Kit',
    props: {
      fill: '#0D1722',
      cornerRadius: 16,
    },
  });
  const rootId = rootRes?.result?.id;

  // Create design variables for Waterworld HUD & Port Modal tokens
  await execCmd('variable.createCollection', { name: 'Waterworld 1550 Theme' });
  await execCmd('variable.create', { collection: 'Waterworld 1550 Theme', name: 'ww-hud-bg', type: 'color', value: '#15100B' });
  await execCmd('variable.create', { collection: 'Waterworld 1550 Theme', name: 'ww-hud-brass', type: 'color', value: '#C89B3C' });
  await execCmd('variable.create', { collection: 'Waterworld 1550 Theme', name: 'ww-hud-parchment', type: 'color', value: '#F2E2BE' });
  await execCmd('variable.create', { collection: 'Waterworld 1550 Theme', name: 'ww-hud-body', type: 'color', value: '#DFD2B5' });
  await execCmd('variable.create', { collection: 'Waterworld 1550 Theme', name: 'ww-hud-radius', type: 'number', value: 12 });

  // Left card: Port Arrival & Narrative Modal
  const modalRes = await execCmd('node.create', {
    type: 'frame',
    parent: rootId,
    x: 28,
    y: 28,
    width: 440,
    height: 404,
    name: 'Port Arrival Modal',
    props: {
      fill: '#16110C',
      stroke: '#C89B3C',
      strokeWeight: 2,
      cornerRadius: 12,
    },
  });
  const modalId = modalRes?.result?.id;

  // Inner ornamental brass hairline frame
  await execCmd('node.create', {
    type: 'rectangle',
    parent: modalId,
    x: 10,
    y: 10,
    width: 420,
    height: 384,
    name: 'Inner Brass Filigree',
    props: {
      fill: '#1B140E',
      stroke: '#6E5220',
      strokeWeight: 1,
      cornerRadius: 8,
    },
  });

  // Modal Title (with text.wrapStyle = balance)
  const titleRes = await execCmd('node.create', {
    type: 'text',
    parent: modalId,
    x: 28,
    y: 28,
    width: 384,
    height: 56,
    name: 'Port Modal Title',
    text: 'Porto de Lisboa · 11 de Outubro de 1550',
    props: {
      fontSize: 21,
      fontStyle: 'Bold',
      fill: '#F2E2BE',
    },
  });
  const titleId = titleRes?.result?.id;
  await execCmd('text.wrapStyle', { ids: [titleId], style: 'balance' });

  // Subtitle
  await execCmd('node.create', {
    type: 'text',
    parent: modalId,
    x: 28,
    y: 88,
    width: 384,
    height: 24,
    name: 'Port Subtitle',
    text: 'RIBEIRA DAS NAUS · ROYAL DOCKYARD & CASA DA INDIA',
    props: {
      fontSize: 11,
      fontStyle: 'Bold',
      fill: '#C89B3C',
      letterSpacing: 1.2,
    },
  });

  // Divider line
  await execCmd('node.create', {
    type: 'rectangle',
    parent: modalId,
    x: 28,
    y: 118,
    width: 384,
    height: 2,
    name: 'Brass Divider',
    props: {
      fill: '#8C6B2B',
    },
  });

  // Narrative Body Copy (with text.wrapStyle = pretty)
  const bodyRes = await execCmd('node.create', {
    type: 'text',
    parent: modalId,
    x: 28,
    y: 136,
    width: 384,
    height: 150,
    name: 'Port Narrative Body',
    text: 'Your caravel rounds the limestone tower of Belem as the Tagus tide runs slack. Merchantmen ride at anchor off the Ribeira slipways while bronze bells toll the afternoon watch from the Se Cathedral.',
    props: {
      fontSize: 14,
      fill: '#DFD2B5',
      lineHeight: 22,
    },
  });
  const bodyId = bodyRes?.result?.id;
  await execCmd('text.wrapStyle', { ids: [bodyId], style: 'pretty' });

  // Primary CTA Button: Row Ashore & Trade
  const btn1Res = await execCmd('node.create', {
    type: 'frame',
    parent: modalId,
    x: 28,
    y: 326,
    width: 184,
    height: 44,
    name: 'Primary Button',
    props: {
      fill: '#3A2814',
      stroke: '#D8AC4C',
      strokeWeight: 1.5,
      cornerRadius: 8,
    },
  });
  await execCmd('node.create', {
    type: 'text',
    parent: btn1Res?.result?.id,
    x: 22,
    y: 13,
    width: 140,
    height: 20,
    name: 'Button Label',
    text: 'Row Ashore & Trade',
    props: {
      fontSize: 13,
      fontStyle: 'Bold',
      fill: '#F6E7C4',
    },
  });

  // Secondary CTA Button: Careen & Provision
  const btn2Res = await execCmd('node.create', {
    type: 'frame',
    parent: modalId,
    x: 228,
    y: 326,
    width: 184,
    height: 44,
    name: 'Secondary Button',
    props: {
      fill: '#1E160E',
      stroke: '#8C6B2B',
      strokeWeight: 1,
      cornerRadius: 8,
    },
  });
  await execCmd('node.create', {
    type: 'text',
    parent: btn2Res?.result?.id,
    x: 24,
    y: 13,
    width: 140,
    height: 20,
    name: 'Button Label 2',
    text: 'Careen & Provision',
    props: {
      fontSize: 13,
      fill: '#DFD2B5',
    },
  });

  // Right card: Gunnery & Helm Telemetry HUD Pill
  const hudRes = await execCmd('node.create', {
    type: 'frame',
    parent: rootId,
    x: 492,
    y: 28,
    width: 260,
    height: 240,
    name: 'Gunnery HUD Panel',
    props: {
      fill: '#15100B',
      stroke: '#B88A32',
      strokeWeight: 2,
      cornerRadius: 10,
    },
  });
  const hudId = hudRes?.result?.id;

  const hudTitleRes = await execCmd('node.create', {
    type: 'text',
    parent: hudId,
    x: 20,
    y: 20,
    width: 220,
    height: 28,
    name: 'HUD Title',
    text: 'Demi-Culverin Battery',
    props: {
      fontSize: 17,
      fontStyle: 'Bold',
      fill: '#F2E2BE',
    },
  });
  await execCmd('text.wrapStyle', { ids: [hudTitleRes?.result?.id], style: 'balance' });

  const hudRows = [
    ['Broadside Status', '4 Guns Ready'],
    ['Barrel Mass (CAD)', '1,346.4 kg'],
    ['Trunnion Balance', '43.5% CoM'],
    ['Audio Loudness', '-14.0 LUFS'],
  ];
  for (let i = 0; i < hudRows.length; i++) {
    const [k, v] = hudRows[i];
    const ry = 62 + i * 40;
    await execCmd('node.create', {
      type: 'rectangle',
      parent: hudId,
      x: 18,
      y: ry,
      width: 224,
      height: 32,
      name: `Row BG ${i + 1}`,
      props: {
        fill: '#231A10',
        stroke: '#6E5220',
        strokeWeight: 1,
        cornerRadius: 6,
      },
    });
    await execCmd('node.create', {
      type: 'text',
      parent: hudId,
      x: 28,
      y: ry + 8,
      width: 115,
      height: 18,
      name: `Key ${i + 1}`,
      text: k,
      props: { fontSize: 12, fill: '#C2B293' },
    });
    await execCmd('node.create', {
      type: 'text',
      parent: hudId,
      x: 145,
      y: ry + 8,
      width: 90,
      height: 18,
      name: `Val ${i + 1}`,
      text: v,
      props: { fontSize: 12, fontStyle: 'Bold', fill: '#E8C36B' },
    });
  }

  // Generate Dev Mode CSS code from FigCraft
  const codeRes = await execCmd('inspect.code', { id: modalId, language: 'css' });
  console.log('[FigCraft] Dev Mode CSS:', JSON.stringify(codeRes).slice(0, 320));

  // Save native .figcraft file
  const figcraftPath = path.join(OUT_DIR, 'waterworld-ui.figcraft');
  if (fs.existsSync(figcraftPath)) fs.unlinkSync(figcraftPath);
  const saveRes = await execCmd('file.save', { path: figcraftPath });
  console.log('[FigCraft] Saved .figcraft:', JSON.stringify(saveRes));

  // Render PNG mockup
  const pngPath = path.join(OUT_DIR, 'waterworld-ui-mockup.png');
  const renderRes = await call('ui.render', {
    path: pngPath,
    scale: 2,
    ids: [rootId],
  });
  console.log('[FigCraft] Rendered PNG:', JSON.stringify(renderRes).slice(0, 240));

  // Inspect nodes & extract CSS / Dev Mode properties
  const titleNode = await call('node.get', { id: titleId, depth: 2 });
  const bodyNode = await call('node.get', { id: bodyId, depth: 2 });
  const modalNode = await call('node.get', { id: modalId, depth: 2 });

  const spec = {
    generator: 'FigCraft v0.16.0',
    file: 'assets/artcraft/waterworld-ui.figcraft',
    mockup: 'assets/artcraft/waterworld-ui-mockup.png',
    devModeCss: codeRes?.result?.code ?? null,
    tokens: {
      '--ww-hud-bg': 'rgba(22, 17, 12, 0.92)',
      '--ww-hud-glass-blur': '12px',
      '--ww-hud-brass': '#c89b3c',
      '--ww-hud-brass-subtle': 'rgba(200, 155, 60, 0.32)',
      '--ww-hud-parchment': '#f2e2be',
      '--ww-hud-body': '#dfd2b5',
      '--ww-hud-radius': '12px',
      '--ww-title-wrap': titleNode?.result?.wrapStyle || 'balance',
      '--ww-body-wrap': bodyNode?.result?.wrapStyle || 'pretty',
    },
    nodes: {
      modal: {
        id: modalId,
        name: modalNode?.result?.name,
        width: modalNode?.result?.width,
        height: modalNode?.result?.height,
        cornerRadius: modalNode?.result?.cornerRadius,
      },
      title: {
        id: titleId,
        name: titleNode?.result?.name,
        wrapStyle: titleNode?.result?.wrapStyle,
        fontSize: titleNode?.result?.fontSize,
      },
      body: {
        id: bodyId,
        name: bodyNode?.result?.name,
        wrapStyle: bodyNode?.result?.wrapStyle,
        fontSize: bodyNode?.result?.fontSize,
        lineHeight: bodyNode?.result?.lineHeight,
      },
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'waterworld-ui-spec.json'), JSON.stringify(spec, null, 2) + '\n');
  console.log('[FigCraft] Wrote waterworld-ui-spec.json');

  await call('app.quit', {});
} finally {
  sock.destroy();
  proc.kill();
}
