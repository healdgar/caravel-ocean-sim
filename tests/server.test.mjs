import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {createDevServer} from '../server.mjs';

test('dev server serves game files but never local credentials, hidden paths or secret aliases',async t=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'ocean-server-'));
  t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const directory=path.join(temporary,'site');
  await fs.mkdir(path.join(directory,'js'),{recursive:true});
  await fs.mkdir(path.join(directory,'.git'));
  await fs.writeFile(path.join(directory,'index.html'),'<h1>Ocean</h1>');
  await fs.writeFile(path.join(directory,'js/main.js'),'export const game=true;');
  const secret='TEST_ONLY_LOCAL_SECRET';
  await fs.writeFile(path.join(directory,'.env.local'),`ELEVENLABS_API_KEY=${secret}`);
  await fs.writeFile(path.join(directory,'.git/config'),secret);
  const outside=path.join(temporary,'site-private');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'key.txt'),secret);
  await fs.symlink(path.join(directory,'.env.local'),path.join(directory,'alias.txt'));
  await fs.symlink(outside,path.join(directory,'outside'));
  const server=createDevServer({directory});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const port=server.address().port;
  const request=(pathname,options={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:pathname,...options},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,body}));
    });
    req.on('error',reject);req.end(options.body);
  });
  assert.deepEqual(await request('/'),{status:200,body:'<h1>Ocean</h1>'});
  assert.equal((await request('/js/main.js')).status,200);
  for(const name of ['/.env.local','/%2eenv.local','/.git/config','/%2egit/config',
    '/js/%2e%2e/.env.local','/js%2f..%2f.env.local','/alias.txt','/outside/key.txt',
    '/%2e%2e%2fsite-private/key.txt']){
    const result=await request(name);
    assert.equal(result.status,403,name);
    assert.ok(!result.body.includes(secret),name);
  }
  assert.equal((await request('/%broken')).status,400);
  assert.equal((await request('/%00')).status,400);
  assert.equal((await request('/missing')).status,404);
  assert.equal((await request('/__shot?name=fixture.png',{method:'POST',body:'fixture'})).status,200);
  assert.equal(await fs.readFile(path.join(directory,'shots/fixture.png'),'utf8'),'fixture');
});
