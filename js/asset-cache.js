// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Persistent client asset cache keyed by the content hash in each asset's name (OPFS primary, CacheStorage fallback).
//
// Every published Waterworld asset carries a 16-hex SHA-256 hash in its filename
// (`assets/.../<name>.<16hex>.<ext>`). Standard browser HTTP disk caches drop very large
// entries (such as the 186 MiB meadow and 331 MiB forest atlases) or evict aggressively on
// iPhone Safari. This module transparently keeps immutable assets locally under that hash,
// streams straight from disk with zero duplicate RAM copies, shares unchanged assets across
// /waterworld/ and /waterworld-test/, busts on any content change (a new name), and
// garbage-collects obsolete hashes from older builds.
//
// What it checks, and what it does not: a stored entry is taken on its LENGTH alone (the bytes the
// build's asset index gives for its hash; any non-empty length where the index has none). It never
// reads an entry's bytes or hashes them, on the way in or on the way out, so a stored file of the
// right length and the wrong content is served as a hit. Content is verified by whoever reads the
// asset (loadContinuumAtlas, js/continuum-format.js: SHA-256 against the manifest's receipt), and a
// reader that finds a file wrong calls `evict` so the bad copy is not served again.

const CACHE_DIR = 'waterworld-assets-v1';
const META_KEY = 'waterworld.assetCacheMeta.v1';
const HASHED_ASSET_RE = /\/assets\/.+\.([0-9a-f]{16})(\.[a-z0-9]+)$/i;
const STALE_GRACE_MS = 24 * 60 * 60 * 1000;
const DESKTOP_BUDGET_BYTES = 1600 * 1024 * 1024;
const MOBILE_BUDGET_BYTES = 360 * 1024 * 1024;
const MOBILE_CACHE_API_MAX_ENTRY = 68 * 1024 * 1024;

const EXT_CONTENT_TYPES = Object.freeze({
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.world': 'application/octet-stream',
});

export function parseHashedAssetUrl(rawUrl, baseHref = null) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try {
    const base = baseHref ?? (typeof globalThis.location?.href === 'string' ? globalThis.location.href : 'https://example.invalid/');
    parsed = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (baseHref || typeof globalThis.location?.origin === 'string') {
    const origin = baseHref ? new URL(baseHref).origin : globalThis.location.origin;
    if (origin && origin !== 'null' && parsed.origin !== origin) return null;
  }
  const m = HASHED_ASSET_RE.exec(parsed.pathname);
  if (!m) return null;
  const hash = m[1].toLowerCase();
  const ext = m[2].toLowerCase();
  return {
    hash,
    ext,
    key: `${hash}${ext}`,
    contentType: EXT_CONTENT_TYPES[ext] || 'application/octet-stream',
    pathname: parsed.pathname,
  };
}

function isMobileRuntime() {
  const ua = typeof globalThis.navigator?.userAgent === 'string' ? globalThis.navigator.userAgent : '';
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
}

function loadMeta() {
  try {
    const raw = globalThis.localStorage?.getItem?.(META_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  try {
    globalThis.localStorage?.setItem?.(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore quota/private-mode errors */
  }
}

async function openOpfsBackend() {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return null;
  try {
    const root = await storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    // Probe createWritable support (Chrome, Edge, Safari 18+ macOS/iOS). Older WebKit falls back to CacheStorage.
    const probe = await dir.getFileHandle('.probe', { create: true });
    const canWrite = typeof probe.createWritable === 'function';
    try { await dir.removeEntry('.probe'); } catch { /* ignore */ }
    if (!canWrite) return null;

    return {
      name: 'opfs',
      async read(key, expectedBytes, contentType) {
        try {
          const handle = await dir.getFileHandle(key);
          const file = await handle.getFile();
          if (!(file.size > 0) || (expectedBytes > 0 && file.size !== expectedBytes)) {
            try { await dir.removeEntry(key); } catch { /* ignore */ }
            return null;
          }
          return new Response(file, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(file.size),
              'X-Waterworld-Cache': 'opfs-hit',
            },
          });
        } catch {
          return null;
        }
      },
      async writeStream(key, stream, expectedBytes) {
        const tmpName = `${key}.tmp`;
        let written = 0;
        let writable = null;
        try {
          const tmpHandle = await dir.getFileHandle(tmpName, { create: true });
          writable = await tmpHandle.createWritable();
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) {
              written += value.byteLength;
              await writable.write(value);
            }
          }
          await writable.close();
          writable = null;
          if (!(written > 0) || (expectedBytes > 0 && written !== expectedBytes)) {
            try { await dir.removeEntry(tmpName); } catch { /* ignore */ }
            return 0;
          }
          if (typeof tmpHandle.move === 'function') {
            await tmpHandle.move(dir, key);
          } else {
            const file = await tmpHandle.getFile();
            const finalHandle = await dir.getFileHandle(key, { create: true });
            const finalWritable = await finalHandle.createWritable();
            await file.stream().pipeTo(finalWritable);
            try { await dir.removeEntry(tmpName); } catch { /* ignore */ }
          }
          return written;
        } catch (err) {
          if (writable) {
            try { await writable.abort(); } catch { /* ignore */ }
          }
          try { await dir.removeEntry(tmpName); } catch { /* ignore */ }
          throw err;
        }
      },
      async list() {
        const entries = [];
        if (typeof dir.entries !== 'function') return entries;
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind !== 'file') continue;
          if (name.endsWith('.tmp') || name === '.probe') {
            try { await dir.removeEntry(name); } catch { /* ignore */ }
            continue;
          }
          try {
            const file = await handle.getFile();
            entries.push({ key: name, size: file.size });
          } catch { /* ignore */ }
        }
        return entries;
      },
      async remove(key) {
        try { await dir.removeEntry(key); } catch { /* ignore */ }
      },
      async clear() {
        if (typeof dir.entries !== 'function') return;
        const names = [];
        for await (const [name] of dir.entries()) names.push(name);
        for (const name of names) {
          try { await dir.removeEntry(name); } catch { /* ignore */ }
        }
      },
    };
  } catch {
    return null;
  }
}

async function openCacheApiBackend() {
  if (typeof globalThis.caches?.open !== 'function') return null;
  try {
    const cache = await globalThis.caches.open(CACHE_DIR);
    const cacheUrl = (key) => `https://waterworld-cache.local/${key}`;
    return {
      name: 'cache-api',
      async read(key, expectedBytes, contentType) {
        try {
          const hit = await cache.match(cacheUrl(key));
          if (!hit || !hit.ok) return null;
          const storedBytes = Number(hit.headers.get('X-Waterworld-Bytes') || hit.headers.get('Content-Length') || 0);
          if (expectedBytes > 0 && storedBytes !== expectedBytes) {
            try { await cache.delete(cacheUrl(key)); } catch { /* ignore */ }
            return null;
          }
          const headers = new Headers(hit.headers);
          if (!headers.get('Content-Type')) headers.set('Content-Type', contentType);
          headers.set('X-Waterworld-Cache', 'cache-api-hit');
          return new Response(hit.body, { status: 200, headers });
        } catch {
          return null;
        }
      },
      async writeStream(key, stream, expectedBytes, contentType, mobile) {
        if (mobile && expectedBytes > MOBILE_CACHE_API_MAX_ENTRY) {
          try { await stream.cancel(); } catch { /* ignore */ }
          return 0;
        }
        const chunks = [];
        let written = 0;
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            written += value.byteLength;
            if (mobile && written > MOBILE_CACHE_API_MAX_ENTRY) {
              try { await reader.cancel(); } catch { /* ignore */ }
              return 0;
            }
            chunks.push(value);
          }
        }
        if (!(written > 0) || (expectedBytes > 0 && written !== expectedBytes)) return 0;
        const blob = new Blob(chunks, { type: contentType });
        await cache.put(cacheUrl(key), new Response(blob, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(written),
            'X-Waterworld-Bytes': String(written),
          },
        }));
        return written;
      },
      async list() {
        const keys = await cache.keys();
        const entries = [];
        for (const req of keys) {
          const key = new URL(req.url).pathname.replace(/^\/+/, '');
          const hit = await cache.match(req);
          const size = Number(hit?.headers.get('X-Waterworld-Bytes') || hit?.headers.get('Content-Length') || 0);
          entries.push({ key, size });
        }
        return entries;
      },
      async remove(key) {
        try { await cache.delete(cacheUrl(key)); } catch { /* ignore */ }
      },
      async clear() {
        const keys = await cache.keys();
        for (const req of keys) {
          try { await cache.delete(req); } catch { /* ignore */ }
        }
      },
    };
  } catch {
    return null;
  }
}

export function createPersistentAssetCache({
  origFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
  assetIndex = globalThis.__WATERWORLD_ASSET_INDEX__ ?? null,
  isMobile = isMobileRuntime(),
  backendPromise = null,
} = {}) {
  const stats = {
    backend: 'init',
    hits: 0,
    misses: 0,
    hitBytes: 0,
    missBytes: 0,
    storedCount: 0,
    storedBytes: 0,
    evictedCount: 0,
  };
  const meta = loadMeta();
  const activeWrites = new Map();
  let persistAsked = false;
  let gcScheduled = false;

  const resolvedBackend = backendPromise ?? (async () => {
    const opfs = await openOpfsBackend();
    if (opfs) { stats.backend = 'opfs'; return opfs; }
    const cacheApi = await openCacheApiBackend();
    if (cacheApi) { stats.backend = 'cache-api'; return cacheApi; }
    stats.backend = 'off';
    return null;
  })();

  function touchMeta(key, size) {
    meta[key] = { t: Date.now(), b: size };
    saveMeta(meta);
  }

  // One stored entry removed, with its record of use and its share of the stored totals.
  async function dropStored(backend, key) {
    await backend.remove(key);
    const known = meta[key];
    if (!known) return;
    delete meta[key];
    saveMeta(meta);
    stats.storedCount = Math.max(0, stats.storedCount - 1);
    stats.storedBytes = Math.max(0, stats.storedBytes - (Number(known.b) || 0));
  }

  function activeHashSet() {
    if (!assetIndex || typeof assetIndex !== 'object') return null;
    return new Set(Object.keys(assetIndex));
  }

  async function runGarbageCollect({ aggressive = false } = {}) {
    const backend = await resolvedBackend;
    if (!backend) return;
    const entries = await backend.list();
    const keepHashes = activeHashSet();
    const now = Date.now();
    const budget = isMobile ? MOBILE_BUDGET_BYTES : DESKTOP_BUDGET_BYTES;

    let remaining = [];
    for (const entry of entries) {
      const hash = entry.key.slice(0, 16).toLowerCase();
      const inCurrent = !keepHashes || keepHashes.has(hash);
      const lastUsed = meta[entry.key]?.t ?? 0;
      const stale = !inCurrent && (aggressive || (now - lastUsed > STALE_GRACE_MS));
      if (stale) {
        await backend.remove(entry.key);
        delete meta[entry.key];
        stats.evictedCount++;
      } else {
        remaining.push({ ...entry, inCurrent, lastUsed });
      }
    }

    let totalBytes = remaining.reduce((sum, e) => sum + e.size, 0);
    if (totalBytes > budget) {
      // Evict non-current entries first, then oldest entries (LRU).
      remaining.sort((a, b) => Number(a.inCurrent) - Number(b.inCurrent) || a.lastUsed - b.lastUsed);
      const kept = [];
      for (const entry of remaining) {
        if (totalBytes > budget) {
          await backend.remove(entry.key);
          delete meta[entry.key];
          totalBytes -= entry.size;
          stats.evictedCount++;
        } else {
          kept.push(entry);
        }
      }
      remaining = kept;
    }

    stats.storedCount = remaining.length;
    stats.storedBytes = remaining.reduce((sum, e) => sum + e.size, 0);
    saveMeta(meta);
  }

  function scheduleGc() {
    if (gcScheduled || typeof globalThis.setTimeout !== 'function') return;
    gcScheduled = true;
    globalThis.setTimeout(() => { runGarbageCollect().catch(() => {}); }, 8000);
  }

  async function cachedFetch(input, init) {
    if (!origFetch) throw new Error('fetch unavailable');
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    if (method !== 'GET') return origFetch(input, init);
    if (init?.cache === 'no-store') return origFetch(input, init);
    // `cache: 'reload'` is a refresh, as it is of the browser's own cache: the stored copy is dropped unread, the
    // asset is fetched from the network, and what comes is stored in its place.
    const refresh = init?.cache === 'reload';
    const reqHeaders = init?.headers || (typeof input === 'object' ? input?.headers : null);
    if (reqHeaders) {
      try {
        const h = new Headers(reqHeaders);
        if (h.has('Range')) return origFetch(input, init);
      } catch { /* ignore */ }
    }
    const rawUrl = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url);
    const parsed = parseHashedAssetUrl(rawUrl);
    if (!parsed) return origFetch(input, init);

    const expectedBytes = Number(assetIndex?.[parsed.hash]) || 0;
    const backend = await resolvedBackend;
    if (!backend) return origFetch(input, init);

    scheduleGc();

    // Wait briefly if the exact same key is already being written by an in-flight request? No: don't stall on miss;
    // simply check for an already-completed file first. A hit is a stored file of the expected length: its content
    // is not read here (see the head of this file).
    if (refresh) {
      if (!activeWrites.has(parsed.key)) await dropStored(backend, parsed.key);
    } else if (!activeWrites.has(parsed.key)) {
      const hit = await backend.read(parsed.key, expectedBytes, parsed.contentType);
      if (hit) {
        const bytes = Number(hit.headers.get('Content-Length') || expectedBytes || 0);
        stats.hits++;
        stats.hitBytes += bytes;
        touchMeta(parsed.key, bytes);
        return hit;
      }
    }

    const networkRes = await origFetch(input, init);
    if (!networkRes.ok || !networkRes.body || networkRes.status !== 200) {
      return networkRes;
    }
    const headerLen = networkRes.headers.get('Content-Encoding') ? 0 : Number(networkRes.headers.get('Content-Length') || 0);
    const netLen = expectedBytes || headerLen;
    stats.misses++;
    stats.missBytes += netLen;

    if (activeWrites.has(parsed.key)) {
      return networkRes;
    }

    if (!persistAsked) {
      persistAsked = true;
      try { globalThis.navigator?.storage?.persist?.().catch?.(() => {}); } catch { /* ignore */ }
    }

    const [returnBranch, cacheBranch] = networkRes.body.tee();
    const writePromise = backend.writeStream(parsed.key, cacheBranch, expectedBytes || headerLen, parsed.contentType, isMobile)
      .then((written) => {
        if (written > 0) {
          touchMeta(parsed.key, written);
          stats.storedCount++;
          stats.storedBytes += written;
        }
      })
      .catch(async (err) => {
        if (err?.name === 'QuotaExceededError') {
          await runGarbageCollect({ aggressive: true }).catch(() => {});
        }
      })
      .finally(() => {
        activeWrites.delete(parsed.key);
      });
    activeWrites.set(parsed.key, writePromise);

    const outHeaders = new Headers(networkRes.headers);
    outHeaders.set('X-Waterworld-Cache', `${backend.name}-miss`);
    return new Response(returnBranch, {
      status: networkRes.status,
      statusText: networkRes.statusText,
      headers: outHeaders,
    });
  }

  // Drop one asset's stored copy, named by its URL: for a reader that has checked the bytes it was given and found
  // them wrong, which this cache never does itself. A write of the same asset still in flight is waited out first, so
  // that the bad copy cannot land after it was dropped. Resolves false where the URL names no hashed asset or there
  // is no store, and true once no copy of it is stored.
  async function evict(rawUrl) {
    const parsed = parseHashedAssetUrl(rawUrl);
    if (!parsed) return false;
    const backend = await resolvedBackend;
    if (!backend) return false;
    await Promise.allSettled([activeWrites.get(parsed.key)]);
    await dropStored(backend, parsed.key);
    stats.evictedCount++;
    return true;
  }

  async function clear() {
    await Promise.allSettled([...activeWrites.values()]);
    const backend = await resolvedBackend;
    if (backend) await backend.clear();
    for (const k of Object.keys(meta)) delete meta[k];
    saveMeta(meta);
    stats.storedCount = 0;
    stats.storedBytes = 0;
  }

  async function ready() {
    await resolvedBackend;
    await Promise.allSettled([...activeWrites.values()]);
  }

  return {
    fetch: cachedFetch,
    stats,
    evict,
    clear,
    ready,
    gc: runGarbageCollect,
  };
}

export function formatAssetCacheStatus(stats) {
  if (!stats) return 'Cache: off';
  const label = stats.backend === 'opfs' ? 'OPFS' : stats.backend === 'cache-api' ? 'CacheAPI' : stats.backend === 'init' ? 'initializing' : 'off';
  const fmtMiB = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MiB` : `${Math.round(b / 1024)} KiB`;
  if (stats.backend === 'off') return 'Cache: unavailable (private / HTTP)';
  return `Cache (${label}): ${stats.hits} hit${stats.hits === 1 ? '' : 's'} (${fmtMiB(stats.hitBytes)} saved) · ${stats.misses} net (${fmtMiB(stats.missBytes)})`;
}

export function installPersistentAssetCache() {
  if (typeof globalThis.fetch !== 'function') return null;
  if (globalThis.__WATERWORLD_ASSET_CACHE__) return globalThis.__WATERWORLD_ASSET_CACHE__;
  const proto = globalThis.location?.protocol;
  if (proto !== 'https:' && proto !== 'http:') return null;
  const cache = createPersistentAssetCache();
  globalThis.fetch = cache.fetch;
  globalThis.__WATERWORLD_ASSET_CACHE__ = cache;
  return cache;
}
