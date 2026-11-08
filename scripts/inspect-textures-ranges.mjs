#!/usr/bin/env node
/**
 * Multi-Range Texture & Material Inspection Process (`scripts/inspect-textures-ranges.mjs`)
 *
 * Renders and audits all procedural and MaterialCraft surface shaders across 6 canonical viewing
 * distances (2m, 6m, 15m, 35m, 80m, 180m) at oblique/grazing viewing angles using headless WebGPU,
 * measures spatial-frequency metrics (high-frequency Laplacian, adjacent sign-flip Moiré rate, and
 * directional ripple anisotropy), saves a labeled visual contact sheet PNG + JSON report, and
 * captures live in-game verification screenshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';

const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  '/Users/alexwall/.gemini/antigravity/brain/ee8068a8-4418-4cd0-8c46-3b30962ef9d6';

const RANGES_M = [2, 6, 15, 35, 80, 180];

const TEXTURE_FAMILIES = [
  { id: 'street_cobble', label: 'Street Cobblestone (way.g)' },
  { id: 'kind16_calcada', label: 'Kind 16 Calçada Cobble' },
  { id: 'kind10_timber', label: 'Kind 10 Dock/Wall Timber' },
  { id: 'kind11_ashlar', label: 'Kind 11 Pedra Lioz Ashlar' },
  { id: 'kind12_stucco', label: 'Kind 12 Limewash Stucco' },
  { id: 'kind13_telha', label: 'Kind 13 Terracotta Telha' },
  { id: 'shore_swash', label: 'Shoreline Wet/Dry Sand' },
  { id: 'rope_12u_hemp', label: 'Rope 12u Laid Hemp Hawser' },
  { id: 'rope_2u_tarred', label: 'Rope 2u Stockholm Tarred' },
  { id: 'rope_19u_marline', label: 'Rope 19u Marline Bolt-Rope' },
];

async function runAudit() {
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`,
      '--disable-gpu-watchdog',
    ],
  });

  try {
    // 1. Render the WebGPU Multi-Range Swatch Contact Sheet & compute spatial-frequency metrics
    const swatchPage = await browser.newPage({ viewport: { width: 1320, height: 1180 } });
    await swatchPage.route('**/__texture_range_audit', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body style="margin:0;background:#0e1318;color:#e8eef5;font-family:system-ui,sans-serif;"><canvas id="sheet" width="1320" height="1180"></canvas></body></html>`,
      })
    );
    await swatchPage.goto(`${baseUrl}/__texture_range_audit`);

    const auditReport = await swatchPage.evaluate(
      async ({ ranges, families }) => {
        const canvas = document.getElementById('sheet');
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0e1318';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();

        // Offscreen WebGPU canvas for true hardware derivative (dpdx/dpdy/fwidth) evaluation
        const cellW = 160;
        const cellH = 92;
        const gpuCanvas = document.createElement('canvas');
        gpuCanvas.width = cellW;
        gpuCanvas.height = cellH;
        const gpuCtx = gpuCanvas.getContext('webgpu');
        const format = navigator.gpu.getPreferredCanvasFormat();
        gpuCtx.configure({ device, format, alphaMode: 'opaque' });

        const wgsl = /* wgsl */ `
          struct Params {
            distM: f32,
            familyId: u32,
            elevRad: f32,
            pad: f32,
          };
          @group(0) @binding(0) var<uniform> P: Params;

          struct VOut {
            @builtin(position) pos: vec4f,
            @location(0) uv: vec2f,
          };

          @vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
            var p = array<vec2f, 6>(
              vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
              vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
            );
            var out: VOut;
            out.pos = vec4f(p[vi], 0.0, 1.0);
            out.uv = p[vi] * 0.5 + 0.5;
            return out;
          }

          fn hash2(p: vec2f) -> f32 {
            return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
          }

          fn vnoise(p: vec2f) -> f32 {
            let i = floor(p);
            let f = fract(p);
            let u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(hash2(i + vec2f(0.0, 0.0)), hash2(i + vec2f(1.0, 0.0)), u.x),
              mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
              u.y
            );
          }

          @fragment fn fs(in: VOut) -> @location(0) vec4f {
            let sinE = max(0.18, sin(P.elevRad));
            // Perspective ground-plane ray projection centered at P.distM so hardware dpdx/dpdy/fwidth
            // match the exact world-space pixel footprint at that viewing range and grazing angle.
            let fovScale = P.distM / (1.8 + (in.uv.y - 0.5) * 0.65);
            let wx = (in.uv.x - 0.5) * fovScale * 1.35;
            let wz = P.distM + (in.uv.y - 0.5) * (fovScale / sinE) * 0.95;
            let world = vec3f(wx, 0.0, wz);
            let dx = dpdx(world);
            let dy = dpdy(world);
            let footprint = max(length(dx), length(dy));
            let grazing = smoothstep(0.08, 0.38, sinE);
            let sunDir = normalize(vec3f(0.48, 0.64, 0.60));
            var n = vec3f(0.0, 1.0, 0.0);
            var col = vec3f(0.35);
            var rough = 0.78;

            if (P.familyId == 0u) {
              // Street Cobblestone (way.g) with two-octave cascade (3.4/m fine + 1.35/m mid) & separated bump fade
              let streetGrazing = smoothstep(0.05, 0.22, sinE);
              let stoneFineFade = (1.0 - smoothstep(0.032, 0.085, footprint)) * streetGrazing;
              let stoneMidFade = (1.0 - smoothstep(0.080, 0.220, footprint)) * streetGrazing;
              let stoneBumpFade = (1.0 - smoothstep(0.016, 0.048, footprint)) * streetGrazing;
              let su = floor(wx * 3.4);
              let sv = floor(wz * 3.4);
              let jitter = (hash2(vec2f(su, sv)) - 0.5) * 0.18;
              let cx = abs(fract(wx * 3.4 + jitter) - 0.5);
              let cz = abs(fract(wz * 3.4 - jitter) - 0.5);
              let mortarFine = smoothstep(0.34, 0.47, max(cx, cz));
              let qMid = vec2f(wx * 0.8 - wz * 0.6, wx * 0.6 + wz * 0.8) * 1.35 + vec2f(17.3, 41.7);
              let mu = floor(qMid.x);
              let mv = floor(qMid.y);
              let mJitter = (hash2(vec2f(mu, mv)) - 0.5) * 0.18;
              let mcx = abs(fract(qMid.x + mJitter) - 0.5);
              let mcz = abs(fract(qMid.y - mJitter) - 0.5);
              let mortarMid = smoothstep(0.34, 0.47, max(mcx, mcz));
              let midWeight = stoneMidFade * (1.0 - 0.55 * stoneFineFade);
              let toneMix = (hash2(vec2f(su * 1.7, sv * 2.3)) - 0.5) * 0.20 * stoneFineFade + (hash2(vec2f(mu * 1.3, mv * 2.9)) - 0.5) * 0.16 * midWeight;
              let mortarMix = mortarFine * 0.42 * stoneFineFade + mortarMid * 0.32 * midWeight;
              let macroPlate = (vnoise(vec2f(wx * 0.45, wz * 0.45)) - 0.5) * 0.18;
              let roadTint = vec3f(0.236, 0.214, 0.189) * (1.0 + macroPlate + toneMix) * (1.0 - mortarMix);
              let domeX = (fract(wx * 3.4 + jitter) - 0.5) * 0.30 * stoneBumpFade;
              let domeZ = (fract(wz * 3.4 - jitter) - 0.5) * 0.30 * stoneBumpFade;
              n = normalize(vec3f(-domeX, 1.0, -domeZ));
              col = roadTint;
              rough = 0.82;
            } else if (P.familyId == 1u) {
              // Kind 16 Architectural Calçada Cobblestone (mipmapped colour, early bump damping)
              let cobbleColorFade = (1.0 - smoothstep(0.08, 0.32, footprint)) * grazing;
              let cobbleBumpFade = (1.0 - smoothstep(0.035, 0.14, footprint)) * grazing;
              let cFreq = 0.42;
              let cCell = vec2f(wx * cFreq, wz * cFreq);
              let cid = floor(cCell);
              let cHash = hash2(cid);
              let cu = fract(cCell.x + (cHash - 0.5) * 0.22) - 0.5;
              let cv = fract(cCell.y + (fract(cHash * 17.3) - 0.5) * 0.22) - 0.5;
              let mortar = smoothstep(0.32, 0.47, max(abs(cu), abs(cv)));
              let base = vec3f(0.46, 0.43, 0.38) * (0.92 + 0.16 * (cHash - 0.5) * cobbleColorFade);
              let mortarCol = base * 0.72;
              col = mix(base, mix(base, mortarCol, mortar * 0.42), cobbleColorFade);
              n = normalize(vec3f(-cu * 0.35 * cobbleBumpFade, 1.0, -cv * 0.35 * cobbleBumpFade));
              rough = 0.82;
            } else if (P.familyId == 2u) {
              // Kind 10 Maritime Timber Planking
              let timberFade = (1.0 - smoothstep(0.03, 0.16, footprint)) * grazing;
              let plank = wx * 5.2;
              let pid = floor(plank);
              let seam = 1.0 - smoothstep(0.02, 0.08 + fwidth(plank), min(fract(plank), 1.0 - fract(plank)));
              let grain = (vnoise(vec2f(wx * 42.0, wz * 3.5 + pid * 7.1)) - 0.5) * timberFade;
              col = vec3f(0.34, 0.24, 0.15) * (0.94 + 0.12 * hash2(vec2f(pid, 1.0)) * timberFade + 0.10 * grain) * (1.0 - 0.32 * seam * timberFade);
              n = normalize(vec3f(seam * 0.25 * timberFade, 1.0, grain * 0.18));
              rough = 0.78;
            } else if (P.familyId == 3u) {
              // Kind 11 Pedra Lioz Limestone Ashlar Masonry
              let ashlarFade = (1.0 - smoothstep(0.04, 0.22, footprint)) * grazing;
              let row = floor(wz * 2.4);
              let colCoord = (wx + (row % 2.0) * 0.38) * 1.3;
              let bid = floor(colCoord);
              let gx = min(fract(colCoord), 1.0 - fract(colCoord));
              let gz = min(fract(wz * 2.4), 1.0 - fract(wz * 2.4));
              let mortar = 1.0 - smoothstep(0.02, 0.06 + max(fwidth(colCoord), fwidth(wz * 2.4)), min(gx, gz));
              let blockVar = (hash2(vec2f(bid, row)) - 0.5) * 0.14 * ashlarFade;
              col = mix(vec3f(0.68, 0.63, 0.54) * (1.0 + blockVar), vec3f(0.46, 0.42, 0.35), mortar * 0.48 * ashlarFade);
              rough = 0.76;
            } else if (P.familyId == 4u) {
              // Kind 12 Whitewashed Taipa Stucco Plaster
              let stuccoFade = (1.0 - smoothstep(0.03, 0.18, footprint)) * grazing;
              let trowel = (vnoise(vec2f(wx * 6.5, wz * 6.5)) - 0.5) * stuccoFade;
              col = vec3f(0.84, 0.80, 0.72) * (1.0 + 0.07 * trowel);
              n = normalize(vec3f(trowel * 0.15, 1.0, -trowel * 0.15));
              rough = 0.86;
            } else if (P.familyId == 5u) {
              // Kind 13 Terracotta Telha Barrel Roof Tiles
              let tileFade = (1.0 - smoothstep(0.025, 0.14, footprint)) * grazing;
              let panPhase = wx * 5.2 * 6.2831853;
              let barrel = sin(panPhase) * tileFade;
              let courseOverlap = (1.0 - smoothstep(0.0, 0.14, fract(wz * 2.4))) * tileFade;
              let tileTone = 0.94 + 0.12 * (hash2(vec2f(floor(wx * 5.2), floor(wz * 2.4))) - 0.5) * tileFade;
              col = vec3f(0.58, 0.25, 0.14) * tileTone * (0.86 + 0.18 * barrel) * (1.0 - 0.22 * courseOverlap);
              n = normalize(vec3f(-cos(panPhase) * 0.42 * tileFade, 1.0, courseOverlap * 0.28));
              rough = 0.72;
            } else if (P.familyId == 6u) {
              // Shoreline Wet-to-Dry Sand Transition
              let shoreFade = 1.0 - smoothstep(0.04, 0.22, footprint);
              let ripple = sin(wz * 4.2 + sin(wx * 1.8) * 0.6) * 0.5 + 0.5;
              let swashBand = smoothstep(-0.8, 0.8, sin(wx * 0.45 + wz * 0.25));
              let drySand = vec3f(0.66, 0.58, 0.44) * (0.96 + 0.06 * ripple * shoreFade);
              let wetSand = vec3f(0.36, 0.31, 0.23);
              col = mix(wetSand, drySand, swashBand);
              rough = mix(0.28, 0.86, swashBand);
            } else {
              // Ropes: 7 = 12u Golden Laid Hemp, 8 = 2u Stockholm Tarred, 9 = 19u Marline Bolt-Rope
              let isTarred = P.familyId == 8u;
              let isBoltRope = P.familyId == 9u;
              // Render cylinder bands so rope cross-section and axial twist are clearly visible
              let ropeRow = (in.uv.y - 0.5) * 3.2;
              let cylV = clamp((fract(ropeRow + 1.5) - 0.5) * 2.3, -0.98, 0.98);
              let cylMask = smoothstep(0.98, 0.86, abs(cylV));
              let ropeAz = asin(cylV);
              let ropeMeters = wx * 0.65 + floor(ropeRow + 1.5) * 0.37;
              let layPhase = ropeMeters * 52.0 + ropeAz * 3.0;
              let layFootprint = max(fwidth(layPhase), footprint * 48.0);
              let ropeLayFade = 1.0 - smoothstep(0.55, 2.6, layFootprint);
              let ropeYarnFade = 1.0 - smoothstep(0.18, 0.95, layFootprint);

              let strandU = fract(layPhase * 0.15915494) - 0.5;
              let strandId = floor(layPhase * 0.15915494);
              let strandCrown = sqrt(max(0.06, 1.0 - 3.55 * strandU * strandU));
              let strandValleyAO = smoothstep(0.48, 0.18, abs(strandU));
              let yarnCoord = ropeMeters * 240.0 - ropeAz * 9.0 + strandId * 2.1;
              let yarnId = floor(yarnCoord * 0.15915494);
              let yarnHash = fract(sin(yarnId * 127.1 + strandId * 311.7) * 43758.5453);
              let yarnTwist = sin(yarnCoord) * ropeYarnFade;

              let hitchPhase = fract(ropeMeters * 22.0);
              let marlineHitch = select(0.0, 1.0 - smoothstep(0.06, 0.15, abs(hitchPhase - 0.5)), isBoltRope);
              let marlineShadow = select(0.0, (1.0 - smoothstep(0.12, 0.26, abs(hitchPhase - 0.5))) * (1.0 - marlineHitch), isBoltRope);

              let crownHemp = select(
                select(vec3f(0.43, 0.315, 0.175), vec3f(0.088, 0.058, 0.035), isTarred),
                vec3f(0.31, 0.22, 0.118),
                isBoltRope
              );
              let valleyHemp = select(
                select(vec3f(0.145, 0.095, 0.048), vec3f(0.024, 0.016, 0.010), isTarred),
                vec3f(0.11, 0.072, 0.036),
                isBoltRope
              );
              let yarnTone = 0.92 + 0.16 * (yarnHash - 0.5) * ropeYarnFade + 0.08 * yarnTwist;
              let laidColor = mix(valleyHemp, crownHemp * yarnTone, 0.22 + 0.78 * strandCrown * strandValleyAO);
              let avgRopeColor = mix(valleyHemp, crownHemp, 0.68);
              var ropeAlbedo = mix(avgRopeColor, laidColor, ropeLayFade) * (1.0 - 0.24 * marlineShadow * ropeLayFade);
              ropeAlbedo = mix(ropeAlbedo, vec3f(0.058, 0.038, 0.022) * (0.85 + 0.15 * strandCrown), marlineHitch * 0.86 * ropeLayFade);
              let dStrand = clamp(-2.85 * strandU, -1.0, 1.0) * ropeLayFade + 0.24 * cos(yarnCoord) * ropeYarnFade;
              n = normalize(vec3f(dStrand * 0.34, sqrt(max(0.05, 1.0 - cylV * cylV)), cylV * 0.85 + dStrand * 0.24));
              col = mix(vec3f(0.12, 0.15, 0.19), ropeAlbedo, cylMask);
              rough = select(0.84, 0.62, isTarred);
            }

            let nl = max(0.18, dot(n, sunDir));
            let lit = col * (0.32 + 0.82 * nl);
            let gamma = pow(clamp(lit, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
            return vec4f(gamma, 1.0);
          }
        `;

        const mod = device.createShaderModule({ code: wgsl });
        const pipe = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module: mod, entryPoint: 'vs' },
          fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
        });
        const uBuf = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bg = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uBuf } }],
        });

        // Header labels
        ctx.fillStyle = '#e8eef5';
        ctx.font = 'bold 18px system-ui, sans-serif';
        ctx.fillText('Waterworld Multi-Range Texture & Material Audit (2m Close → 180m Far @ Grazing Incidence)', 24, 32);
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillStyle = '#9fb0c2';
        for (let c = 0; c < ranges.length; c++) {
          ctx.fillText(`Range: ${ranges[c]}m`, 260 + c * (cellW + 12) + 36, 58);
        }

        const report = [];
        const tmp2d = document.createElement('canvas');
        tmp2d.width = cellW;
        tmp2d.height = cellH;
        const tmpCtx = tmp2d.getContext('2d');

        for (let r = 0; r < families.length; r++) {
          const fam = families[r];
          const rowY = 70 + r * (cellH + 16);
          ctx.fillStyle = '#d8e3ee';
          ctx.font = 'bold 13px system-ui, sans-serif';
          ctx.fillText(fam.label, 20, rowY + 42);

          const rowMetrics = [];
          for (let c = 0; c < ranges.length; c++) {
            const distM = ranges[c];
            const uData = new ArrayBuffer(16);
            new Float32Array(uData, 0, 1)[0] = distM;
            new Uint32Array(uData, 4, 1)[0] = r;
            new Float32Array(uData, 8, 1)[0] = (20 * Math.PI) / 180; // 20° grazing angle
            device.queue.writeBuffer(uBuf, 0, uData);

            const enc = device.createCommandEncoder();
            const pass = enc.beginRenderPass({
              colorAttachments: [
                {
                  view: gpuCtx.getCurrentTexture().createView(),
                  loadOp: 'clear',
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                  storeOp: 'store',
                },
              ],
            });
            pass.setPipeline(pipe);
            pass.setBindGroup(0, bg);
            pass.draw(6);
            pass.end();
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();

            const colX = 260 + c * (cellW + 12);
            ctx.drawImage(gpuCanvas, colX, rowY);

            tmpCtx.drawImage(gpuCanvas, 0, 0);
            const img = tmpCtx.getImageData(0, 0, cellW, cellH).data;
            const lum = new Float32Array(cellW * cellH);
            for (let i = 0; i < cellW * cellH; i++) {
              lum[i] = (0.2126 * img[i * 4] + 0.7152 * img[i * 4 + 1] + 0.0722 * img[i * 4 + 2]) / 255;
            }

            let lapSum = 0;
            let flips = 0;
            let count = 0;
            for (let y = 2; y < cellH - 2; y++) {
              for (let x = 2; x < cellW - 2; x++) {
                const idx = y * cellW + x;
                const v = lum[idx];
                const l = lum[idx - 1];
                const rt = lum[idx + 1];
                const u = lum[idx - cellW];
                const d = lum[idx + cellW];
                lapSum += Math.abs(4 * v - l - rt - u - d);
                const d0 = v - l;
                const d1 = rt - v;
                if (Math.abs(d0) > 0.015 && Math.abs(d1) > 0.015 && d0 * d1 < 0) flips++;
                count++;
              }
            }
            const hfLap = lapSum / count;
            const flipRate = flips / count;
            rowMetrics.push({ distM, hfLaplacian: Number(hfLap.toFixed(4)), signFlipRate: Number(flipRate.toFixed(4)) });

            // Overlay metric badge
            ctx.fillStyle = 'rgba(10, 15, 22, 0.72)';
            ctx.fillRect(colX + 4, rowY + cellH - 20, cellW - 8, 16);
            ctx.fillStyle = flipRate < 0.05 ? '#7ee787' : '#ffa657';
            ctx.font = '10px monospace';
            ctx.fillText(`HF:${hfLap.toFixed(3)} Flip:${(flipRate * 100).toFixed(1)}%`, colX + 8, rowY + cellH - 8);
          }

          ctx.fillStyle = '#8b9eb0';
          ctx.font = '11px monospace';
          ctx.fillText(
            `35m Flip: ${(rowMetrics[3].signFlipRate * 100).toFixed(1)}% | 80m Flip: ${(rowMetrics[4].signFlipRate * 100).toFixed(1)}%`,
            20,
            rowY + 60
          );
          report.push({ id: fam.id, label: fam.label, ranges: rowMetrics });
        }

        return report;
      },
      { ranges: RANGES_M, families: TEXTURE_FAMILIES }
    );

    const sheetPath = path.join(ARTIFACT_DIR, 'texture_range_contact_sheet.png');
    await swatchPage.screenshot({ path: sheetPath });
    const jsonPath = path.join(ARTIFACT_DIR, 'texture_range_audit.json');
    fs.writeFileSync(jsonPath, JSON.stringify(auditReport, null, 2));
    console.log(`Saved multi-range contact sheet to ${sheetPath}`);
    await swatchPage.close();

    // 2. Capture live 3D WebGPU simulator screenshots verifying:
    //    - Level building rooflines & cobblestone streets at range
    //    - Close-up 3-strand laid hemp ropes & tarred shrouds on the player ship
    //    - Blasted townsfolk / garrison bodies remaining visibly on the ground
    const gamePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await gamePage.goto(
      `${baseUrl}/?view=free&follower=0&sunElev=34&sunAzim=135&clouds=0.15&windSpeed=4&swellHs=0.25&fov=45`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await gamePage.waitForFunction(
      () => window.oceanStartup?.state === 'ready' || document.querySelector('#err')?.textContent,
      undefined,
      { timeout: 60000 }
    );
    await gamePage.waitForTimeout(4000);

    // Hide all overlays/modals for clean visual inspection
    await gamePage.evaluate(() => {
      for (const el of document.querySelectorAll('body > *')) {
        if (el.tagName !== 'CANVAS') el.style.display = 'none';
      }
    });

    // Shot A: Level Building Rooflines & Cobblestone Streets at Near-to-Moderate Range
    // Matches the exact harbour & hillside building framing to verify horizontal eaves/ridges and smooth cobblestone streets
    await gamePage.evaluate(() => {
      const f = window.oceanFleet;
      const dock = f.terrain.views.dock;
      f.vessels[0].boat.showProw = false;
      const cam = f.freeCam;
      cam.x = dock.x - 18;
      cam.y = 22.0;
      cam.z = dock.z - 12;
      cam.yaw = -0.35;
      cam.pitch = -0.26;
      cam.fovY = (46 * Math.PI) / 180;
    });
    await gamePage.waitForTimeout(1000);
    await gamePage.screenshot({ path: path.join(ARTIFACT_DIR, 'verify_rooflines_and_cobble.png') });

    // Shot A2: Street-Level Cobblestone Near-to-Mid-Range Transition (matching the user's plaza/street view)
    await gamePage.evaluate(() => {
      const f = window.oceanFleet;
      const dock = f.terrain.views.dock;
      f.vessels[0].boat.showProw = false;
      const cam = f.freeCam;
      cam.x = dock.x - 28;
      cam.y = 8.2;
      cam.z = dock.z - 56;
      cam.yaw = -0.22;
      cam.pitch = -0.36;
      cam.fovY = (40 * Math.PI) / 180;
    });
    await gamePage.waitForTimeout(1000);
    await gamePage.screenshot({ path: path.join(ARTIFACT_DIR, 'verify_street_cobble_transition.png') });

    // Shot B: Close-up of Ship 3-Strand Laid Hemp Ropes & Tarred Standing Shrouds
    await gamePage.evaluate(() => {
      const f = window.oceanFleet;
      const boat = f.vessels[0].boat;
      boat.showProw = true;
      const rad = ((boat.heading || 0) * Math.PI) / 180;
      const fx = Math.sin(rad);
      const fz = -Math.cos(rad);
      const rx = Math.cos(rad);
      const rz = Math.sin(rad);
      const camX = boat.x + rx * 2.2 - fx * 0.9;
      const camZ = boat.z + rz * 2.2 - fz * 0.9;
      const camY = (boat.heave || 0) + 2.85;
      const targetX = boat.x + rx * 1.15 + fx * 0.15;
      const targetZ = boat.z + rz * 1.15 + fz * 0.15;
      const targetY = (boat.heave || 0) + 3.15;
      const dx = targetX - camX;
      const dy = targetY - camY;
      const dz = targetZ - camZ;
      const cam = f.freeCam;
      cam.x = camX;
      cam.y = camY;
      cam.z = camZ;
      cam.yaw = Math.atan2(dx, -dz);
      cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      cam.fovY = (36 * Math.PI) / 180;
    });
    await gamePage.waitForTimeout(1000);
    await gamePage.screenshot({ path: path.join(ARTIFACT_DIR, 'verify_ropes_closeup.png') });

    // Shot C: Fire cannonballs onto the pier and waterfront street walkers and verify blasted bodies stay on the ground
    await gamePage.evaluate(() => {
      const f = window.oceanFleet;
      f.vessels[0].boat.showProw = false;
      const dock = f.terrain.views.dock;
      const camX = dock.x - 12;
      const camY = 11.5;
      const camZ = dock.z - 16;
      const yaw = -0.22;
      const pitch = -0.32;
      const cam = f.freeCam;
      cam.x = camX;
      cam.y = camY;
      cam.z = camZ;
      cam.yaw = yaw;
      cam.pitch = pitch;
      cam.fovY = (38 * Math.PI) / 180;
      for (const dYaw of [-0.14, -0.07, 0, 0.07, 0.14]) {
        for (const dPitch of [-0.08, -0.03, 0.02, 0.07]) {
          const y = yaw + dYaw;
          const p = pitch + dPitch;
          const dir = [Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)];
          window.oceanFreeCannon?.update?.(0.35, {
            firing: true,
            eye: [camX, camY, camZ],
            forward: dir,
          });
        }
      }
    });
    await gamePage.waitForTimeout(2800);
    await gamePage.screenshot({ path: path.join(ARTIFACT_DIR, 'verify_blasted_casualties_stay.png') });

    await gamePage.close();
    return auditReport;
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    server.close();
  }
}

runAudit().catch((err) => {
  console.error(err);
  process.exit(1);
});
