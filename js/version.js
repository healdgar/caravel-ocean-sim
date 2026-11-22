// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Build version & deployment channel metadata. build.mjs stamps window.__WATERWORLD_BUILD__
// into ocean.html, ocean.min.html, docs/index.html, and docs/build-info.json.

export function waterworldChannel(loc = globalThis.location) {
  const pathname = typeof loc?.pathname === 'string' ? loc.pathname : '';
  if (pathname === '/waterworld-test' || pathname.startsWith('/waterworld-test/')) return 'test';
  if (pathname === '/waterworld' || pathname.startsWith('/waterworld/')) return 'prod';
  return 'local';
}

export function waterworldApiBase(loc = globalThis.location) {
  return waterworldChannel(loc) === 'test' ? '/waterworld-test/api' : '/waterworld/api';
}

export function getWaterworldBuild(loc = globalThis.location) {
  const raw = globalThis.__WATERWORLD_BUILD__;
  const channel = waterworldChannel(loc);
  if (raw && typeof raw === 'object') {
    return Object.freeze({
      version: String(raw.version || '1.0.0'),
      build: Number.isFinite(Number(raw.build)) ? Number(raw.build) : 0,
      commit: String(raw.commit || 'dev'),
      branch: String(raw.branch || ''),
      dirty: Boolean(raw.dirty),
      builtAt: String(raw.builtAt || ''),
      channel,
    });
  }
  return Object.freeze({
    version: '1.0.0-dev',
    build: 0,
    commit: 'dev',
    branch: '',
    dirty: false,
    builtAt: '',
    channel,
  });
}

export function formatBuildLabel(info = getWaterworldBuild()) {
  const num = info.build > 0 ? `#${info.build}` : 'dev';
  const sha = info.commit ? ` (${info.commit}${info.dirty ? '*' : ''})` : '';
  return `Build ${num} · v${info.version}${sha}`;
}
