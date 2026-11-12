// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
const root=new URL('../',import.meta.url);

test('Pages uses versioned, byte-identical runtime assets and excludes inline media',async()=>{
  const html=await readFile(new URL('docs/index.html',root),'utf8');
  const manifest=JSON.parse(await readFile(new URL('docs/assets-manifest.json',root),'utf8'));
  assert.ok(Object.keys(manifest).length>40,'all runtime sound/model/terrain assets are represented');
  // Code and shaders alone reached about 3.5 MiB. This trips before the
  // smallest crew or wildlife model (over 1.3 MiB as base64) could fit inline.
  assert.ok(Buffer.byteLength(html)<4*1024*1024,'optional media must not return to the initial HTML');
  assert.ok(!/data:(audio\/mpeg|model\/gltf-binary|image\/png|image\/webp);base64,/.test(html));
  for(const [source,record]of Object.entries(manifest)){
    assert.match(source,/^assets\/[a-z0-9/.-]+$/);
    assert.match(record.url,/^assets\/[a-z0-9/.-]+\.[a-f0-9]{16}\.[a-z0-9]+$/);
    assert.ok(html.includes(record.url),'the copied asset is actually referenced: '+source);
    const original=await readFile(new URL(source,root)),copied=await readFile(new URL('docs/'+record.url,root));
    assert.deepEqual(copied,original,'asset fidelity: '+source);
    assert.equal(record.bytes,original.length);
    assert.equal(record.sha256,createHash('sha256').update(original).digest('hex'));
    assert.ok(record.url.includes(record.sha256.slice(0,16)),'cache version follows actual bytes');
  }
  for(const source of ['assets/crew/sailor.glb','assets/crew/sailor-female.glb','assets/crew/sailor-classic.glb','assets/crew/sailor-female-classic.glb','assets/caravel-oak-albedo.webp'])
    assert.ok(html.includes(`as="fetch" href="${manifest[source].url}" crossorigin="anonymous"`),'startup model discovery: '+source);
  assert.ok(!html.includes(`as="fetch" href="${manifest['assets/wildlife/whale.glb'].url}"`),'inactive wildlife must not preload');
});

test('downloads embed sailing and native forest atlases; optional mature buffers use byte-versioned URLs',async()=>{
  const manifest=JSON.parse(await readFile(new URL('docs/assets-manifest.json',root),'utf8'));
  for(const file of ['ocean.html','ocean.min.html']){
    const html=await readFile(new URL(file,root),'utf8');
    for(const mime of ['audio/mpeg','model/gltf-binary','image/webp','image/png'])
      assert.ok(html.includes('data:'+mime+';base64,'),file+' includes '+mime);
    assert.ok(!/href="assets\/[^"\s]+\.[a-f0-9]{16}\./.test(html),'web-only preloads do not leak into offline downloads');
    for(const source of Object.keys(manifest)){
      // Close-up forest geometry, and the living board (a port's frozen world and the model that lives it), are
      // fetched when wanted: megabytes a downloaded page starts and sails without.
      if(/^assets\/forest-scenery\/((saba|subtropical|portugal)\/(mass\/)?|(saba|portugal)\/clusters\/)(vertices|indices)\.bin\.gz$|\/surfaces\/.*\.gz$|^assets\/boards\/[^/]+\.world$|^assets\/board\/(game|runtime)\.js$/.test(source)){
        assert.ok(html.includes('https://sixcailloux.com/waterworld/'+manifest[source].url),file+' uses exact optional close-up geometry');continue;
      }
      const bytes=await readFile(new URL(source,root));
      assert.ok(html.includes(';base64,'+bytes.toString('base64')),file+' embeds exact bytes: '+source);
    }
  }
});

// The published page opens on deck by writing boat=1 into a bare address. The game must still know the address was
// bare, or a captain returning to a saved voyage is told the visit is a scene of its own and never asked to continue.
test('the published page keeps word of a bare address before it writes into it, and the game asks by that word',async()=>{
  const html=await readFile(new URL('docs/index.html',root),'utf8');
  const kept=html.indexOf('window.oceanOpenedBare=!siteURL.search'),written=html.indexOf('siteURL.searchParams.set("boat","1")'),game=html.indexOf('<script type="module">');
  assert.ok(kept>0&&kept<written,'what the address was is kept before it is written to');
  assert.ok(written<game,'and both come before the game reads the address');
  assert.match(html.slice(game),/window\.oceanOpenedBare\?\?/,'the game asks by it, and by the address itself where the page was not published');
});
