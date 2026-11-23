// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHashedAssetUrl, createPersistentAssetCache, formatAssetCacheStatus } from '../js/asset-cache.js';

function createMemoryBackend() {
  const store = new Map();
  return {
    name: 'opfs',
    store,
    writeCalls: 0,
    async read(key, expectedBytes, contentType) {
      const bytes = store.get(key);
      if (!bytes) return null;
      if (!(bytes.byteLength > 0) || (expectedBytes > 0 && bytes.byteLength !== expectedBytes)) {
        store.delete(key);
        return null;
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(bytes.byteLength),
          'X-Waterworld-Cache': 'opfs-hit',
        },
      });
    },
    async writeStream(key, stream, expectedBytes) {
      this.writeCalls++;
      const chunks = [];
      let written = 0;
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          chunks.push(value);
          written += value.byteLength;
        }
      }
      if (!(written > 0) || (expectedBytes > 0 && written !== expectedBytes)) return 0;
      const out = new Uint8Array(written);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      store.set(key, out);
      return written;
    },
    async list() {
      return [...store.entries()].map(([key, bytes]) => ({ key, size: bytes.byteLength }));
    },
    async remove(key) { store.delete(key); },
    async clear() { store.clear(); },
  };
}

test('parseHashedAssetUrl shares keys across /waterworld/ and /waterworld-test/ and skips unhashed/API URLs', () => {
  const base = 'https://www.sixcailloux.com/waterworld-test/';
  const a = parseHashedAssetUrl('/waterworld-test/assets/city-continuum/atlas.bin.3153e6d8b3b6cd98.gz', base);
  const b = parseHashedAssetUrl('/waterworld/assets/city-continuum/atlas.bin.3153e6d8b3b6cd98.gz', base);
  assert.ok(a && b);
  assert.equal(a.hash, '3153e6d8b3b6cd98');
  assert.equal(a.key, '3153e6d8b3b6cd98.gz');
  assert.equal(a.key, b.key, 'same content hash shares key between test and prod mounts');

  assert.equal(parseHashedAssetUrl('/waterworld-test/', base), null);
  assert.equal(parseHashedAssetUrl('/waterworld-test/index.html', base), null);
  assert.equal(parseHashedAssetUrl('/waterworld-test/build-info.json', base), null);
  assert.equal(parseHashedAssetUrl('/waterworld-test/api/landfall-pack?cell=abc', base), null);
  assert.equal(parseHashedAssetUrl('/waterworld-test/assets/unhashed/file.bin', base), null);
  assert.equal(parseHashedAssetUrl('https://other-origin.example/assets/a.3153e6d8b3b6cd98.gz', base), null);
});

test('createPersistentAssetCache caches verified assets, hits with zero network calls, and busts on new hash', async () => {
  const prevLoc = globalThis.location;
  globalThis.location = { href: 'https://www.sixcailloux.com/waterworld-test/', origin: 'https://www.sixcailloux.com', protocol: 'https:' };
  try {
    const backend = createMemoryBackend();
    const v1Bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const v2Bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    let networkCalls = 0;

    const origFetch = async (url) => {
      networkCalls++;
      const body = String(url).includes('aaaaaaaaaaaaaaaa') ? v1Bytes : v2Bytes;
      return new Response(body, { status: 200, headers: { 'Content-Length': String(body.byteLength) } });
    };

    const cacheV1 = createPersistentAssetCache({
      origFetch,
      assetIndex: { aaaaaaaaaaaaaaaa: v1Bytes.byteLength },
      backendPromise: Promise.resolve(backend),
    });

    const urlV1 = 'https://www.sixcailloux.com/waterworld-test/assets/forest/atlas.bin.aaaaaaaaaaaaaaaa.gz';
    const r1 = await cacheV1.fetch(urlV1);
    assert.deepEqual(new Uint8Array(await r1.arrayBuffer()), v1Bytes);
    await cacheV1.ready();
    assert.equal(networkCalls, 1);
    assert.equal(backend.store.has('aaaaaaaaaaaaaaaa.gz'), true);

    // Repeat fetch hits persistent cache with zero network traffic.
    const r2 = await cacheV1.fetch(urlV1);
    assert.equal(r2.headers.get('X-Waterworld-Cache'), 'opfs-hit');
    assert.deepEqual(new Uint8Array(await r2.arrayBuffer()), v1Bytes);
    assert.equal(networkCalls, 1);
    assert.equal(cacheV1.stats.hits, 1);
    assert.equal(cacheV1.stats.hitBytes, v1Bytes.byteLength);

    // New build introduces a new hash -> automatic cache miss + GC evicts old hash.
    const cacheV2 = createPersistentAssetCache({
      origFetch,
      assetIndex: { bbbbbbbbbbbbbbbb: v2Bytes.byteLength },
      backendPromise: Promise.resolve(backend),
    });
    const urlV2 = 'https://www.sixcailloux.com/waterworld/assets/forest/atlas.bin.bbbbbbbbbbbbbbbb.gz';
    const r3 = await cacheV2.fetch(urlV2);
    assert.deepEqual(new Uint8Array(await r3.arrayBuffer()), v2Bytes);
    await cacheV2.ready();
    assert.equal(networkCalls, 2);

    await cacheV2.gc({ aggressive: true });
    assert.equal(backend.store.has('aaaaaaaaaaaaaaaa.gz'), false, 'obsolete v1 hash evicted');
    assert.equal(backend.store.has('bbbbbbbbbbbbbbbb.gz'), true, 'active v2 hash retained');

    // Corrupt/truncated stored file is rejected and re-fetched cleanly.
    backend.store.set('bbbbbbbbbbbbbbbb.gz', new Uint8Array([1, 2]));
    const r4 = await cacheV2.fetch(urlV2);
    assert.deepEqual(new Uint8Array(await r4.arrayBuffer()), v2Bytes);
    await cacheV2.ready();
    assert.equal(networkCalls, 3);
    assert.equal(backend.store.get('bbbbbbbbbbbbbbbb.gz').byteLength, v2Bytes.byteLength);

    // Non-GET / Range / no-store requests bypass cache completely.
    await cacheV2.fetch(urlV2, { method: 'HEAD' });
    await cacheV2.fetch(urlV2, { headers: { Range: 'bytes=0-3' } });
    await cacheV2.fetch(urlV2, { cache: 'no-store' });
    assert.equal(networkCalls, 6);

    assert.match(formatAssetCacheStatus({ backend: 'opfs', hits: 12, hitBytes: 524288000, misses: 0, missBytes: 0 }), /OPFS.*12 hits.*500\.0 MiB saved/);
  } finally {
    if (prevLoc === undefined) delete globalThis.location;
    else globalThis.location = prevLoc;
  }
});
