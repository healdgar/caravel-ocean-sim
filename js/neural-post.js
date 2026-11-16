// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Runtime WebGPU manager for the 1-Step Conditional Flow & Detail Pass:
//   - 'fast' mode (default): zero MSAA depth-store overhead on TBDR GPUs; drives the trained
//     quarter-res Multi-Scale ConvNeXt flow net from HDR radiance + Frame ray/sun geometry +
//     rotational motion reprojection, plus full-res bilateral upsample & 3x3 micro-detail CNN.
//   - 'depth' mode: reconstructs metric reverse-Z 3D positions & normals from MSAA depth and
//     performs full 6-DoF 3D motion-vector reprojection.

import { requestOnce } from './gpu-program-cache.js';
import { COMPOSITE, createUnderwaterPost } from './wgsl/post.js';
import { createNeuralEncodeWGSL, createNeuralTrunkWGSL, createNeuralComposite } from './wgsl/neural-post.js';
import { NEURAL_LIGHT_WEIGHT_BYTES, NEURAL_LIGHT_WEIGHTS_FAST, NEURAL_LIGHT_WEIGHTS_DEPTH } from './models/neural-light-weights.js';

export function normalizeNeuralLightMode(mode) {
  return mode === 'depth' ? 'depth' : 'fast';
}

function requestNeuralModeComputePipelines({ device, shader, samples = 4, mode = 'fast' }) {
  const normalized = normalizeNeuralLightMode(mode);
  const depthGuided = normalized === 'depth';
  return requestOnce(device, `neural-light-compute ${normalized} s=${samples}`, async () => {
    const [encMod, trunkMod] = await Promise.all([
      shader(createNeuralEncodeWGSL({ depthGuided, samples }), `neural light encode (${normalized})`),
      shader(createNeuralTrunkWGSL({ depthGuided }), `neural light trunk (${normalized})`),
    ]);
    const [encodePipe, trunkPipe] = await Promise.all([
      device.createComputePipelineAsync({
        label: `neural light encode (${normalized})`,
        layout: 'auto',
        compute: { module: encMod, entryPoint: 'neuralEncode' },
      }),
      device.createComputePipelineAsync({
        label: `neural light trunk (${normalized})`,
        layout: 'auto',
        compute: { module: trunkMod, entryPoint: 'neuralTrunk' },
      }),
    ]);
    return { mode: normalized, depthGuided, encodePipe, trunkPipe };
  });
}

function requestNeuralCompositePipelines({ device, shader, swapFormat }) {
  return requestOnce(device, `neural-light-composite ${swapFormat}`, async () => {
    const compWGSL = createNeuralComposite(COMPOSITE);
    const medCompWGSL = createNeuralComposite(createUnderwaterPost(COMPOSITE, 'composite'));
    const [compMod, medMod] = await Promise.all([
      shader(compWGSL, 'neural composite'),
      shader(medCompWGSL, 'neural medium composite'),
    ]);
    const [compositePipe, mediumCompositePipe] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'neural composite',
        layout: 'auto',
        vertex: { module: compMod, entryPoint: 'vs' },
        fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
      }),
      device.createRenderPipelineAsync({
        label: 'neural medium composite',
        layout: 'auto',
        vertex: { module: medMod, entryPoint: 'vs' },
        fragment: { module: medMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
      }),
    ]);
    return { compositePipe, mediumCompositePipe };
  });
}

export function requestNeuralLightPipelines({ device, shader, swapFormat, samples = 4, mode = 'fast' }) {
  return Promise.all([
    requestNeuralModeComputePipelines({ device, shader, samples, mode }),
    requestNeuralCompositePipelines({ device, shader, swapFormat }),
  ]);
}

export async function createNeuralLightPass({
  device,
  shader,
  frameUBO,
  linSamp,
  swapFormat,
  samples = 4,
  initialMode = 'fast',
}) {
  let activeMode = normalizeNeuralLightMode(initialMode);
  let desiredMode = activeMode;
  let modeEpoch = 0;

  const [initialCompute, { compositePipe, mediumCompositePipe }] = await requestNeuralLightPipelines({
    device,
    shader,
    swapFormat,
    samples,
    mode: activeMode,
  });

  let activeCompute = initialCompute;

  const weightsUBO = device.createBuffer({
    label: 'neural light weights',
    size: NEURAL_LIGHT_WEIGHT_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    weightsUBO,
    0,
    activeMode === 'depth' ? NEURAL_LIGHT_WEIGHTS_DEPTH : NEURAL_LIGHT_WEIGHTS_FAST,
  );

  const paramsData = new Float32Array(24);
  const paramsUBO = device.createBuffer({
    label: 'neural light params',
    size: paramsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const prevViewProj = new Float32Array(16);
  const prevCamPos = new Float64Array(3);

  let width = 0, height = 0, qw = 0, qh = 0, wgX = 0, wgY = 0;
  let featBuf = null;
  const guideTex = [null, null], guideStorageViews = [null, null], guideSampleViews = [null, null];
  const lightTex = [null, null], lightStorageViews = [null, null], lightSampleViews = [null, null];
  let encodeGroups = null, trunkGroups = null;
  let compGroup0 = null, mediumCompGroup0 = null;
  let compGroup1 = null, mediumCompGroup1 = null;
  let lastResizeArgs = null;

  let ping = 0;
  let historyValid = 0;
  let currentStrength = 0;

  // Preallocated pass descriptors & timestamp views (zero per-frame heap allocations)
  const encodePassDesc = { label: 'Neural light encode', timestampWrites: undefined };
  const trunkPassDesc = { label: 'Neural light trunk', timestampWrites: undefined };
  const beginTS = { querySet: null, beginningOfPassWriteIndex: 0 };
  const endTS = { querySet: null, endOfPassWriteIndex: 1 };

  function makeBindGroup(layout, resources, label) {
    return device.createBindGroup({
      label,
      layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
  }

  function rebuildComputeGroups() {
    if (!lastResizeArgs || !featBuf || !guideStorageViews[0] || !lightStorageViews[0]) return;
    const { hdrView, depthView } = lastResizeArgs;
    if (activeCompute.depthGuided && !depthView) {
      encodeGroups = null;
      trunkGroups = null;
      return;
    }
    const encLayout = activeCompute.encodePipe.getBindGroupLayout(0);
    const trunkLayout = activeCompute.trunkPipe.getBindGroupLayout(0);
    encodeGroups = [0, 1].map(curr => {
      const entries = [
        { buffer: frameUBO },
        { buffer: weightsUBO },
        hdrView,
        { buffer: featBuf },
        guideStorageViews[curr],
      ];
      if (activeCompute.depthGuided) entries.push(depthView);
      return makeBindGroup(encLayout, entries, `neural encode ${curr}`);
    });
    trunkGroups = [0, 1].map(curr => {
      const prev = 1 - curr;
      return makeBindGroup(trunkLayout, [
        { buffer: frameUBO },
        { buffer: weightsUBO },
        { buffer: paramsUBO },
        { buffer: featBuf },
        guideSampleViews[curr],
        guideSampleViews[prev],
        lightSampleViews[prev],
        linSamp,
        lightStorageViews[curr],
      ], `neural trunk ${curr}`);
    });
  }

  function rebuildCompositeGroups() {
    if (!lastResizeArgs || !lightSampleViews[0]) return;
    const { hdrView, mediumView, bloomView, compUBO, cameraProbe } = lastResizeArgs;
    if (hdrView && bloomView && compUBO) {
      compGroup0 = makeBindGroup(
        compositePipe.getBindGroupLayout(0),
        [hdrView, bloomView, linSamp, { buffer: compUBO }],
        'neural composite src',
      );
      compGroup1 = [0, 1].map(curr => makeBindGroup(
        compositePipe.getBindGroupLayout(1),
        [lightSampleViews[curr], guideSampleViews[curr], { buffer: weightsUBO }, { buffer: paramsUBO }],
        `neural composite latent ${curr}`,
      ));
    }
    if (mediumView && bloomView && compUBO && hdrView && cameraProbe) {
      mediumCompGroup0 = makeBindGroup(
        mediumCompositePipe.getBindGroupLayout(0),
        [mediumView, bloomView, linSamp, { buffer: compUBO }, hdrView, { buffer: frameUBO }, { buffer: cameraProbe }],
        'neural medium composite src',
      );
      mediumCompGroup1 = [0, 1].map(curr => makeBindGroup(
        mediumCompositePipe.getBindGroupLayout(1),
        [lightSampleViews[curr], guideSampleViews[curr], { buffer: weightsUBO }, { buffer: paramsUBO }],
        `neural medium composite latent ${curr}`,
      ));
    } else {
      mediumCompGroup0 = null;
      mediumCompGroup1 = null;
    }
  }

  function resize(args) {
    const { width: w, height: h } = args;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      throw new RangeError('Neural light target dimensions must be positive integers');
    }
    lastResizeArgs = args;
    const nextQw = Math.max(1, w >> 2);
    const nextQh = Math.max(1, h >> 2);
    if (w !== width || h !== height || nextQw !== qw || nextQh !== qh || !featBuf) {
      width = w;
      height = h;
      qw = nextQw;
      qh = nextQh;
      wgX = Math.ceil(qw / 8);
      wgY = Math.ceil(qh / 8);

      featBuf?.destroy();
      featBuf = device.createBuffer({
        label: 'neural stem features',
        size: Math.max(24, qw * qh * 24),
        usage: GPUBufferUsage.STORAGE,
      });

      const texUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      for (let i = 0; i < 2; i++) {
        guideTex[i]?.destroy();
        lightTex[i]?.destroy();
        guideTex[i] = device.createTexture({
          label: `neural guide ${i}`,
          size: [qw, qh],
          format: 'rgba16float',
          usage: texUsage,
        });
        lightTex[i] = device.createTexture({
          label: `neural light ${i}`,
          size: [qw, qh],
          format: 'rgba16float',
          usage: texUsage,
        });
        guideStorageViews[i] = guideTex[i].createView();
        guideSampleViews[i] = guideTex[i].createView();
        lightStorageViews[i] = lightTex[i].createView();
        lightSampleViews[i] = lightTex[i].createView();
      }
      historyValid = 0;
    }
    rebuildComputeGroups();
    rebuildCompositeGroups();
  }

  function update({
    viewProj,
    camX,
    camY,
    camZ,
    strength,
    giGain = 1.0,
    detailGain = 1.0,
    temporalAlpha = 0.78,
    resetHistory = false,
  }) {
    currentStrength = Number.isFinite(strength) ? Math.max(0, strength) : 0;
    if (currentStrength <= 0.001) {
      historyValid = 0;
      paramsData.fill(0);
      device.queue.writeBuffer(paramsUBO, 0, paramsData);
      return;
    }
    let valid = historyValid && !resetHistory ? 1 : 0;
    let dx = 0, dy = 0, dz = 0;
    if (valid) {
      dx = camX - prevCamPos[0];
      dy = camY - prevCamPos[1];
      dz = camZ - prevCamPos[2];
      if (!Number.isFinite(dx + dy + dz) || Math.hypot(dx, dy, dz) > 25) {
        valid = 0;
        dx = dy = dz = 0;
      }
    }
    paramsData.set(prevViewProj, 0);
    paramsData[16] = dx;
    paramsData[17] = dy;
    paramsData[18] = dz;
    paramsData[19] = valid;
    paramsData[20] = currentStrength;
    paramsData[21] = giGain;
    paramsData[22] = detailGain;
    paramsData[23] = temporalAlpha;
    device.queue.writeBuffer(paramsUBO, 0, paramsData);

    prevViewProj.set(viewProj);
    prevCamPos[0] = camX;
    prevCamPos[1] = camY;
    prevCamPos[2] = camZ;
  }

  function encode(encoder, timestampWrites) {
    if (currentStrength <= 0.001 || !encodeGroups || !trunkGroups || wgX < 1 || wgY < 1) {
      return false;
    }
    const curr = 1 - ping;
    if (timestampWrites) {
      beginTS.querySet = timestampWrites.querySet;
      beginTS.beginningOfPassWriteIndex = timestampWrites.beginningOfPassWriteIndex;
      endTS.querySet = timestampWrites.querySet;
      endTS.endOfPassWriteIndex = timestampWrites.endOfPassWriteIndex;
      encodePassDesc.timestampWrites = beginTS;
      trunkPassDesc.timestampWrites = endTS;
    } else {
      encodePassDesc.timestampWrites = undefined;
      trunkPassDesc.timestampWrites = undefined;
    }

    const p0 = encoder.beginComputePass(encodePassDesc);
    p0.setPipeline(activeCompute.encodePipe);
    p0.setBindGroup(0, encodeGroups[curr]);
    p0.dispatchWorkgroups(wgX, wgY);
    p0.end();

    const p1 = encoder.beginComputePass(trunkPassDesc);
    p1.setPipeline(activeCompute.trunkPipe);
    p1.setBindGroup(0, trunkGroups[curr]);
    p1.dispatchWorkgroups(wgX, wgY);
    p1.end();

    ping = curr;
    historyValid = 1;
    return true;
  }

  // Diagnostic isolated benchmark entrypoint for measureIsolatedGPUStage (passCount = 2).
  function encodeIsolated(encoder, writes) {
    if (!encodeGroups || !trunkGroups || wgX < 1 || wgY < 1) {
      throw new Error('Neural light pass targets are not initialized');
    }
    const curr = 1 - ping;
    encodePassDesc.timestampWrites = writes?.(0);
    const p0 = encoder.beginComputePass(encodePassDesc);
    p0.setPipeline(activeCompute.encodePipe);
    p0.setBindGroup(0, encodeGroups[curr]);
    p0.dispatchWorkgroups(wgX, wgY);
    p0.end();

    trunkPassDesc.timestampWrites = writes?.(1);
    const p1 = encoder.beginComputePass(trunkPassDesc);
    p1.setPipeline(activeCompute.trunkPipe);
    p1.setBindGroup(0, trunkGroups[curr]);
    p1.dispatchWorkgroups(wgX, wgY);
    p1.end();

    ping = curr;
  }

  function drawComposite(pass, underwater = false) {
    if (underwater && mediumCompGroup0 && mediumCompGroup1) {
      pass.setPipeline(mediumCompositePipe);
      pass.setBindGroup(0, mediumCompGroup0);
      pass.setBindGroup(1, mediumCompGroup1[ping]);
      pass.draw(3);
      return true;
    }
    if (compGroup0 && compGroup1) {
      pass.setPipeline(compositePipe);
      pass.setBindGroup(0, compGroup0);
      pass.setBindGroup(1, compGroup1[ping]);
      pass.draw(3);
      return true;
    }
    return false;
  }

  async function setMode(nextMode) {
    const normalized = normalizeNeuralLightMode(nextMode);
    desiredMode = normalized;
    const epoch = ++modeEpoch;
    const compiled = await requestNeuralModeComputePipelines({
      device,
      shader,
      samples,
      mode: normalized,
    });
    if (epoch !== modeEpoch) return activeMode;
    activeCompute = compiled;
    activeMode = normalized;
    device.queue.writeBuffer(
      weightsUBO,
      0,
      normalized === 'depth' ? NEURAL_LIGHT_WEIGHTS_DEPTH : NEURAL_LIGHT_WEIGHTS_FAST,
    );
    historyValid = 0;
    rebuildComputeGroups();
    return activeMode;
  }

  function destroy() {
    featBuf?.destroy();
    featBuf = null;
    for (let i = 0; i < 2; i++) {
      guideTex[i]?.destroy();
      lightTex[i]?.destroy();
      guideTex[i] = lightTex[i] = null;
      guideStorageViews[i] = guideSampleViews[i] = null;
      lightStorageViews[i] = lightSampleViews[i] = null;
    }
    weightsUBO.destroy();
    paramsUBO.destroy();
    encodeGroups = trunkGroups = null;
    compGroup0 = mediumCompGroup0 = null;
    compGroup1 = mediumCompGroup1 = null;
    width = height = qw = qh = wgX = wgY = 0;
  }

  return {
    get mode() { return activeMode; },
    get desiredMode() { return desiredMode; },
    get wantsDepth() {
      return activeMode === 'depth' || desiredMode === 'depth';
    },
    get needsDepth() {
      return currentStrength > 0.001 && (activeMode === 'depth' || desiredMode === 'depth');
    },
    get active() {
      return currentStrength > 0.001 && Boolean(encodeGroups && trunkGroups && compGroup1);
    },
    get quarterWidth() { return qw; },
    get quarterHeight() { return qh; },
    passCount: 2,
    compositePipe,
    mediumCompositePipe,
    resize,
    update,
    encode,
    encodeIsolated,
    drawComposite,
    setMode,
    destroy,
  };
}
