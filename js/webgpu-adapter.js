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

function adapterMeetsStorageLimits(adapter, option) {
  const limits = adapter?.limits;
  if (!limits) {
    // Allow bare mock adapters in unit tests unless compatibility mode was explicitly requested.
    return option?.featureLevel !== 'compatibility';
  }
  if ((limits.maxStorageBuffersPerShaderStage ?? 0) < 8) return false;
  if ('maxStorageBuffersInVertexStage' in limits && (limits.maxStorageBuffersInVertexStage ?? 0) < 8) {
    return false;
  }
  return true;
}

function buildRequiredLimits(adapterLimits, requestedLimits = {}) {
  if (!adapterLimits || typeof adapterLimits !== 'object') return null;
  const requiredLimits = {};
  const stageMax = adapterLimits.maxStorageBuffersPerShaderStage;
  if (Number.isFinite(stageMax) && stageMax >= 8) {
    const reqStage = Number.isFinite(requestedLimits?.maxStorageBuffersPerShaderStage)
      ? requestedLimits.maxStorageBuffersPerShaderStage
      : 8;
    requiredLimits.maxStorageBuffersPerShaderStage = Math.min(stageMax, Math.max(8, reqStage));
  }
  if ('maxStorageBuffersInVertexStage' in adapterLimits) {
    const vertMax = adapterLimits.maxStorageBuffersInVertexStage;
    if (Number.isFinite(vertMax) && vertMax >= 8) {
      const reqVert = Number.isFinite(requestedLimits?.maxStorageBuffersInVertexStage)
        ? requestedLimits.maxStorageBuffersInVertexStage
        : 8;
      requiredLimits.maxStorageBuffersInVertexStage = Math.min(vertMax, Math.max(8, reqVert));
    }
  }
  const bufMax = adapterLimits.maxBufferSize;
  if (Number.isFinite(bufMax) && bufMax > 256 * 1024 * 1024) {
    requiredLimits.maxBufferSize = Math.min(bufMax, 512 * 1024 * 1024);
  }
  const storageBindMax = adapterLimits.maxStorageBufferBindingSize;
  if (Number.isFinite(storageBindMax) && storageBindMax > 128 * 1024 * 1024) {
    requiredLimits.maxStorageBufferBindingSize = Math.min(storageBindMax, 256 * 1024 * 1024);
  }
  return Object.keys(requiredLimits).length > 0 ? requiredLimits : null;
}

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
        if (adapter && adapterMeetsStorageLimits(adapter, option)) {
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
 * Request a WebGPU device with supported optional features and adapter-clamped
 * limits, falling back cleanly if a browser rejects timestamp-query or requiredLimits.
 */
export async function requestWebGPUDevice(adapter, optionalFeatures = [], requestedLimits = {}) {
  const supported = [];
  const seen = new Set();
  for (const feature of optionalFeatures) {
    if (!feature || seen.has(feature)) continue;
    seen.add(feature);
    if (adapter?.features?.has?.(feature)) {
      supported.push(feature);
    }
  }
  const requiredLimits = buildRequiredLimits(adapter?.limits, requestedLimits);
  const makeDescriptor = (features, limits) => {
    if (!features.length && !limits) return undefined;
    const desc = {};
    if (features.length) desc.requiredFeatures = features;
    if (limits) desc.requiredLimits = limits;
    return desc;
  };
  try {
    return await adapter.requestDevice(makeDescriptor(supported, requiredLimits));
  } catch (err) {
    const withoutTimestamp = supported.filter((feature) => feature !== 'timestamp-query');
    if (withoutTimestamp.length < supported.length) {
      try {
        return await adapter.requestDevice(makeDescriptor(withoutTimestamp, requiredLimits));
      } catch {
        // Fall through to retry without requiredLimits below.
      }
    }
    if (requiredLimits) {
      try {
        return await adapter.requestDevice(makeDescriptor(withoutTimestamp, null));
      } catch {
        // Fall through to bare requestDevice below.
      }
    }
    if (supported.length > 0 || requiredLimits) {
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
