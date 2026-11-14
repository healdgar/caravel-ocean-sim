// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Resilient WebGPU adapter and device acquisition across browser power modes,
// compatibility fallbacks, and transient GPU-process restarts.

export const WEBGPU_ADAPTER_OPTIONS = Object.freeze([
  Object.freeze({ powerPreference: 'high-performance' }),
  undefined,
  Object.freeze({ powerPreference: 'low-power' }),
  Object.freeze({ featureLevel: 'compatibility' }),
  Object.freeze({ forceFallbackAdapter: true }),
]);

/**
 * Request a WebGPU adapter, cascading through power preferences, compatibility
 * mode, and software fallback options with a short retry for transient GPU restarts.
 */
export async function requestWebGPUAdapter(
  gpu,
  { retries = 1, retryDelayMs = 220, sleep } = {},
) {
  if (!gpu || typeof gpu.requestAdapter !== 'function') return null;
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const option of WEBGPU_ADAPTER_OPTIONS) {
      try {
        const adapter = option === undefined
          ? await gpu.requestAdapter()
          : await gpu.requestAdapter(option);
        if (adapter) {
          return { adapter, option: option ?? null, attempt };
        }
      } catch {
        // Ignore TypeError / unsupported dictionary members and try the next candidate.
      }
    }
    if (attempt < retries && retryDelayMs > 0) {
      await wait(retryDelayMs);
    }
  }
  return null;
}

/**
 * Request a WebGPU device with supported optional features, falling back cleanly
 * if a browser rejects privacy-gated features such as timestamp-query.
 */
export async function requestWebGPUDevice(adapter, optionalFeatures = []) {
  const supported = [];
  const seen = new Set();
  for (const feature of optionalFeatures) {
    if (!feature || seen.has(feature)) continue;
    seen.add(feature);
    if (adapter?.features?.has?.(feature)) {
      supported.push(feature);
    }
  }
  try {
    return await adapter.requestDevice(
      supported.length ? { requiredFeatures: supported } : undefined,
    );
  } catch (err) {
    const withoutTimestamp = supported.filter((feature) => feature !== 'timestamp-query');
    if (withoutTimestamp.length < supported.length) {
      try {
        return await adapter.requestDevice(
          withoutTimestamp.length ? { requiredFeatures: withoutTimestamp } : undefined,
        );
      } catch {
        // Fall through to bare requestDevice below.
      }
    }
    if (supported.length > 0) {
      return await adapter.requestDevice();
    }
    throw err;
  }
}

/**
 * Return an actionable error message when navigator.gpu exists but no adapter is available.
 */
export function describeMissingWebGPUAdapter({ secureContext = true, userAgent = '' } = {}) {
  if (!secureContext) {
    return 'No WebGPU adapter found. Open this page from localhost or HTTPS so the browser grants graphics access.';
  }
  if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) {
    return 'No WebGPU adapter found. Enable hardware graphics acceleration (chrome://settings/system), and on Linux with NVIDIA drivers enable chrome://flags/#enable-unsafe-webgpu and chrome://flags/#enable-vulkan (check chrome://gpu).';
  }
  if (/Windows/i.test(userAgent)) {
    return 'No WebGPU adapter found. Enable hardware graphics acceleration (chrome://settings/system), assign your browser to High Performance (NVIDIA) in Windows Settings > System > Display > Graphics, and ensure chrome://flags/#use-angle is Default or D3D11/D3D12 (check chrome://gpu).';
  }
  return 'No WebGPU adapter found. Enable hardware graphics acceleration in your browser settings (in Chrome, check chrome://settings/system and chrome://gpu, or restart Chrome if its GPU process stopped), or open the page in Chrome, Edge, or Safari instead of an embedded preview.';
}
