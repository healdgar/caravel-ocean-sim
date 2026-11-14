// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WEBGPU_ADAPTER_OPTIONS,
  describeMissingWebGPUAdapter,
  requestWebGPUAdapter,
  requestWebGPUDevice,
} from '../js/webgpu-adapter.js';

test('requestWebGPUAdapter returns the high-performance adapter immediately when available', async () => {
  const calls = [];
  const fakeAdapter = { features: new Set() };
  const gpu = {
    async requestAdapter(options) {
      calls.push(options ?? null);
      return fakeAdapter;
    },
  };
  const result = await requestWebGPUAdapter(gpu);
  assert.equal(result.adapter, fakeAdapter);
  assert.deepEqual(result.option, { powerPreference: 'high-performance' });
  assert.equal(result.attempt, 0);
  assert.equal(calls.length, 1);
});

test('requestWebGPUAdapter cascades through fallback options and tolerates TypeErrors', async () => {
  const seen = [];
  const fallbackAdapter = { features: new Set(['texture-compression-bc']) };
  const gpu = {
    async requestAdapter(options) {
      seen.push(options);
      if (options?.featureLevel === 'compatibility') {
        throw new TypeError('Unsupported featureLevel');
      }
      if (options?.forceFallbackAdapter === true) {
        return fallbackAdapter;
      }
      return null;
    },
  };
  const result = await requestWebGPUAdapter(gpu, { retries: 0 });
  assert.equal(result.adapter, fallbackAdapter);
  assert.deepEqual(result.option, { forceFallbackAdapter: true });
  assert.equal(seen.length, WEBGPU_ADAPTER_OPTIONS.length);
  assert.equal(seen[1], undefined);
  assert.deepEqual(seen[2], { powerPreference: 'low-power' });
});

test('requestWebGPUAdapter retries once after a brief delay for transient GPU restarts', async () => {
  let pass = 0;
  const delays = [];
  const recoveredAdapter = { features: new Set() };
  const gpu = {
    async requestAdapter(options) {
      if (options?.powerPreference === 'high-performance') {
        pass++;
      }
      if (pass < 2) return null;
      return options === undefined ? recoveredAdapter : null;
    },
  };
  const result = await requestWebGPUAdapter(gpu, {
    retries: 1,
    retryDelayMs: 220,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(result.adapter, recoveredAdapter);
  assert.equal(result.attempt, 1);
  assert.deepEqual(delays, [220]);
});

test('requestWebGPUDevice drops timestamp-query cleanly when requesting it throws', async () => {
  const requests = [];
  const fakeDevice = { features: new Set(['texture-compression-bc']) };
  const adapter = {
    features: new Set(['timestamp-query', 'texture-compression-bc']),
    async requestDevice(desc) {
      requests.push(desc?.requiredFeatures ?? []);
      if (desc?.requiredFeatures?.includes('timestamp-query')) {
        throw new Error('timestamp-query disabled by privacy setting');
      }
      return fakeDevice;
    },
  };
  const device = await requestWebGPUDevice(adapter, ['timestamp-query', 'texture-compression-bc', 'texture-compression-astc']);
  assert.equal(device, fakeDevice);
  assert.deepEqual(requests, [
    ['timestamp-query', 'texture-compression-bc'],
    ['texture-compression-bc'],
  ]);
});

test('describeMissingWebGPUAdapter starts with No WebGPU adapter found and gives actionable guidance', () => {
  const secureMsg = describeMissingWebGPUAdapter({ secureContext: true });
  assert.match(secureMsg, /^No WebGPU adapter found\./);
  assert.match(secureMsg, /hardware graphics acceleration/i);
  assert.match(secureMsg, /chrome:\/\/settings\/system/);

  const winMsg = describeMissingWebGPUAdapter({
    secureContext: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36',
  });
  assert.match(winMsg, /^No WebGPU adapter found\./);
  assert.match(winMsg, /hardware graphics acceleration/i);
  assert.match(winMsg, /High Performance \(NVIDIA\)/);
  assert.match(winMsg, /#use-angle/);

  const linuxMsg = describeMissingWebGPUAdapter({
    secureContext: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36',
  });
  assert.match(linuxMsg, /^No WebGPU adapter found\./);
  assert.match(linuxMsg, /hardware graphics acceleration/i);
  assert.match(linuxMsg, /#enable-unsafe-webgpu/);
  assert.match(linuxMsg, /#enable-vulkan/);

  const insecureMsg = describeMissingWebGPUAdapter({ secureContext: false });
  assert.match(insecureMsg, /^No WebGPU adapter found\./);
  assert.match(insecureMsg, /localhost or HTTPS/i);
});
