import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';

// A visible browser takes the keyboard focus from whoever is using the machine, every time it opens a page.
test('nothing opens a visible browser unless someone asks for it with HEADED',()=>{
  const files=['tests','tests/helpers','scripts'].flatMap(dir=>readdirSync(new URL('../'+dir,import.meta.url),{withFileTypes:true}).filter(e=>e.isFile()&&/\.m?js$/.test(e.name)).map(e=>dir+'/'+e.name));
  assert.ok(files.length>100);
  for(const file of files){
    if(file==='tests/no-visible-browser.test.mjs')continue;
    for(const [setting] of readFileSync(new URL('../'+file,import.meta.url),'utf8').matchAll(/\bheadless\s*:\s*[^,}\s]+/g))
      assert.match(setting,/headless\s*:\s*(true|!process\.env\.HEADED|o\.headless|options\.headless)$/,file+': '+setting);
  }
});
