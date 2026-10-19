import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MeshyClient,ENDPOINT,IMAGE_ENDPOINT,REMESH_ENDPOINT,RIG_ENDPOINT,previewRequest,refineRequest,imageRequest,remeshRequest,rigRequest,resolveKey,secretReference,inspectCrew,ROOT} from '../scripts/meshy.mjs';
import {readGLB} from '../js/gltf.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'waterworld-meshy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const complete=id=>({id,type:'text-to-3d-preview',status:'SUCCEEDED',progress:100,
  model_urls:{glb:'https://assets.meshy.ai/test/model.glb?Expires=123'},consumed_credits:20});

test('native remesh and rig requests stay distinct, resume safely and retain animation outputs',async t=>{
  const dir=await temp(t),glb=await fs.readFile(path.join(ROOT,'assets/crew/sailor.glb'));
  assert.deepEqual(remeshRequest('source'),{input_task_id:'source',topology:'quad',target_polycount:20000,target_formats:['glb']});
  assert.deepEqual(rigRequest('remeshed',1.75),{input_task_id:'remeshed',height_meters:1.75});
  assert.throws(()=>remeshRequest('source',{polygons:300001}),/Polygons/);
  assert.throws(()=>remeshRequest('source',{topology:'unknown'}),/Topology/);
  assert.throws(()=>rigRequest('source',NaN),/Height/);
  assert.throws(()=>rigRequest('../source',1.7),/task ID/);
  let posts=0;
  for(const [kind,endpoint] of [['remesh',REMESH_ENDPOINT],['rig',RIG_ENDPOINT]]){
    const client=new MeshyClient({key:'secret',dir,kind,fetchImpl:async(url,options)=>{
      assert.equal(url,endpoint);assert.equal(options.method,'POST');posts++;return json({result:kind+'-task'});
    }});
    // Even identical input bodies on different endpoints must not reuse the wrong task.
    assert.equal((await client.submit({input_task_id:'same'})).id,kind+'-task');
    assert.equal((await client.submit({input_task_id:'same'})).reused,true);
  }
  assert.equal(posts,2);
  let downloads=0;
  const client=new MeshyClient({key:'secret',dir,kind:'rig',fetchImpl:async(url,options)=>{
    if(url===RIG_ENDPOINT+'/rig-task')return json({id:'rig-task',type:'rig',status:'SUCCEEDED',result:{
      rigged_character_glb_url:'https://assets.meshy.ai/model.glb',
      basic_animations:{walking_glb_url:'https://assets.meshy.ai/walking.glb',running_glb_url:'https://assets.meshy.ai/running.glb'}
    }});
    assert.equal(options.headers,undefined);downloads++;return new Response(glb);
  }});
  assert.deepEqual((await client.download('rig-task')).files.map(f=>f.name),['model.glb','walking.glb','running.glb']);
  await client.download('rig-task');assert.equal(downloads,3);
});

test('crew presets use 7.1 without geometry decimation, and refine preserves that model',()=>{
  for(const sex of ['male','female']){
    const body=previewRequest(sex);
    assert.equal(body.ai_model,'meshy-7.1');assert.equal(body.should_remesh,false);
    assert.equal(body.pose_mode,'t-pose');assert.ok(body.prompt.length<=800);
    assert.equal(body.target_polycount,undefined);assert.equal(body.model_type,'standard');
    const refine=refineRequest('preview-123',sex);
    assert.equal(refine.ai_model,body.ai_model);assert.equal(refine.texture_resolution,'2k');
    assert.equal(refine.enable_pbr,true);assert.ok(refine.texture_prompt.length<=800);
  }
  assert.throws(()=>previewRequest('anything'),/preset/);
  assert.throws(()=>previewRequest('male','x'.repeat(801)),/800/);
  assert.throws(()=>refineRequest('../bad','male'),/task ID/);
  const male=previewRequest('male').prompt,female=previewRequest('female').prompt;
  const shared=male.slice(0,male.indexOf('Male body type'));
  assert.ok(female.startsWith(shared));assert.ok(shared.includes('Body type affects anatomy only'));
  assert.ok(shared.includes('Same practical outfit and pose'));
});

test('image generation uses its own endpoint, retains pose and source hashes, and resumes the same task',async t=>{
  const dir=await temp(t),file=path.join(dir,'reference.png');
  await fs.writeFile(file,Buffer.from([137,80,78,71,13,10,26,10]));
  const body=await imageRequest(file,'female');
  assert.equal(body.ai_model,'meshy-7.1');assert.equal(body.image_enhancement,false);
  assert.equal(body.pose_mode,'t-pose');assert.equal(body.should_texture,true);assert.equal(body.enable_pbr,true);
  assert.ok(body.image_url.startsWith('data:image/png;base64,'));let posts=0;
  const client=new MeshyClient({key:'msy_test',dir,kind:'image',fetchImpl:async(url,options)=>{
    assert.equal(url,IMAGE_ENDPOINT);posts++;assert.equal(JSON.parse(options.body).image_url,body.image_url);
    return json({result:'image-task'});
  }});
  await client.submit(body,{preset:'female',reference:file});await client.submit(body,{preset:'female',reference:file});assert.equal(posts,1);
  const saved=JSON.parse(await fs.readFile(path.join(dir,'tasks/image-task/request.json'),'utf8'));
  assert.equal(saved.kind,'image');assert.match(saved.request.image_url,/SHA-256/);
  assert.ok(!JSON.stringify(saved).includes('base64,'));assert.equal(saved.reference,file);
  client.fetch=async(url)=>{assert.equal(url,IMAGE_ENDPOINT+'/image-task');return json({...complete('image-task'),type:'image-to-3d'});};
  assert.equal((await client.status('image-task')).type,'image-to-3d');
  await fs.writeFile(file,'not an image');await assert.rejects(imageRequest(file,'female'),/header/);
});

test('1Password key stays in memory and uses argument arrays; no shell or secret-bearing errors',async()=>{
  const ref='op://Private/Meshy API/credential';let captured;
  const key=await resolveKey({env:{},config:{keyRef:ref},run:async(...args)=>{captured=args;return {stdout:'msy_test-secret\n'};}});
  assert.equal(key,'msy_test-secret');assert.deepEqual(captured[1],['read',ref,'--no-newline']);
  assert.equal(captured[0],'op');assert.equal(captured[2].shell,undefined);
  assert.equal(await resolveKey({env:{MESHY_API_KEY:'msy_env'}}),'msy_env');
  await assert.rejects(resolveKey({env:{}}),/No Meshy key/);
  await assert.rejects(resolveKey({env:{},keyRef:ref,run:async()=>{throw Error('msy_actual-secret');}}),e=>!e.message.includes('actual-secret'));
  assert.throws(()=>secretReference('msy_accidentally-pasted-key'),/secret reference/);
});

test('identical paid submissions are reused, including concurrent commands',async t=>{
  const dir=await temp(t);let posts=0;
  const client=new MeshyClient({key:'msy_test',dir,fetchImpl:async(url,options)=>{
    assert.equal(url,ENDPOINT);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer msy_test');posts++;
    return json({result:'task-one'});
  }});
  const body=previewRequest('male'),results=await Promise.allSettled([client.submit(body),client.submit(body)]);
  assert.equal(posts,1);assert.ok(results.some(r=>r.status==='fulfilled'));
  assert.deepEqual(await client.submit(body),{id:'task-one',reused:true});assert.equal(posts,1);
  assert.equal((await client.submit(body,{attempt:'2'})).reused,false);assert.equal(posts,2);
  const saved=await fs.readFile(path.join(dir,'tasks/task-one/request.json'),'utf8');assert.ok(!saved.includes('msy_test'));
});

test('lost POST response blocks repeat spending, whereas a definite rejection permits retry',async t=>{
  const dir=await temp(t);let calls=0;
  const client=new MeshyClient({key:'secret',dir,fetchImpl:async()=>{calls++;throw Error('network lost');}});
  const body=previewRequest('male');
  await assert.rejects(client.submit(body),/never automatically retried/);
  await assert.rejects(client.submit(body),/may already be running/);assert.equal(calls,1);
  client.fetch=async()=>{calls++;return json({},402);};
  await assert.rejects(client.submit(body,{attempt:'rejected'}),/credits/);
  client.fetch=async()=>{calls++;return json({result:'funded-task'});};
  assert.equal((await client.submit(body,{attempt:'rejected'})).id,'funded-task');assert.equal(calls,3);
});

test('bounded wait resumes existing tasks and exposes terminal failure without another POST',async t=>{
  const dir=await temp(t),states=['PENDING','IN_PROGRESS','SUCCEEDED'],seen=[];
  const client=new MeshyClient({key:'secret',dir,sleep:async()=>{},fetchImpl:async(url,options)=>{
    assert.equal(options.method,'GET');return json({id:'task',status:states.shift(),progress:50});
  }});
  assert.equal((await client.wait('task',{onUpdate:s=>seen.push(s.status)})).status,'SUCCEEDED');
  assert.deepEqual(seen,['PENDING','IN_PROGRESS','SUCCEEDED']);
  client.fetch=async()=>json({id:'task',status:'IN_PROGRESS'});
  assert.equal((await client.wait('task',{seconds:0})).status,'IN_PROGRESS');
  client.fetch=async()=>json({id:'task',status:'FAILED',task_error:{message:'secret msy_other-secret'}});
  const failed=await client.wait('task');assert.equal(failed.status,'FAILED');
  assert.equal(failed.task_error.message,'[redacted] [redacted]');
  const saved=await fs.readFile(path.join(dir,'tasks/task/task.json'),'utf8');assert.ok(!saved.includes('secret'));
});

test('downloads retain GLB/maps and hashes, omit signed URLs and auth, and resume without redownloading',async t=>{
  const dir=await temp(t),glb=await fs.readFile(path.join(ROOT,'assets/crew/sailor.glb'));let downloads=0;
  const task={...complete('task'),thumbnail_url:'https://assets.meshy.ai/test/thumb.png?secret=abc',
    texture_urls:[{base_color:'https://assets.meshy.ai/test/color.png?secret=abc'}]};
  const client=new MeshyClient({key:'msy_test',dir,fetchImpl:async(url,options)=>{
    if(url.startsWith(ENDPOINT))return json(task);
    assert.equal(options.headers,undefined);downloads++;
    return new Response(url.includes('model.glb')?glb:Buffer.from('test-image'));
  }});
  const result=await client.download('task');assert.equal(result.files.length,3);assert.equal(downloads,3);
  for(const file of result.files)assert.match(file.sha256,/^[0-9a-f]{64}$/);
  await client.download('task');assert.equal(downloads,3);
  const record=await fs.readFile(path.join(result.folder,'downloads.json'),'utf8');
  assert.ok(!record.includes('secret=abc'));assert.ok(!record.includes('msy_test'));
  await fs.writeFile(path.join(result.folder,'model.glb'),'corrupt');await client.download('task');assert.equal(downloads,4);
});

test('asset allowlist and redirect checks prevent credential leakage and unexpected hosts',async t=>{
  let fetched=0;const client=new MeshyClient({key:'msy_secret',dir:await temp(t),fetchImpl:async()=>{fetched++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}});
  for(const url of ['http://assets.meshy.ai/x','https://meshy.ai.evil.example/x','https://user:pass@assets.meshy.ai/x','https://127.0.0.1/x'])
    await assert.rejects(client.asset(url),/Unexpected asset host/);
  assert.equal(fetched,0);
  await assert.rejects(client.asset('https://assets.meshy.ai/test'),/Unexpected asset host/);assert.equal(fetched,1);
});

test('offline inspector recognizes existing rigs and rejects raw unrigged sources for runtime use',async t=>{
  const dir=await temp(t);
  for(const sex of ['male','female']){
    const result=await inspectCrew(path.join(ROOT,'assets/crew',sex==='male'?'sailor.glb':'sailor-female.glb'));
    assert.equal(result.structuralMatch,true);assert.deepEqual(result.matchingRigTemplates,[sex]);
    assert.equal(result.visualReviewRequired,true);
  }
  // Minimal valid GLB: authoring source, not a crew-ready animated asset.
  const g={asset:{version:'2.0'},buffers:[{byteLength:4}],nodes:[{}],scenes:[{nodes:[0]}],scene:0};
  const raw=Buffer.from(JSON.stringify(g)),jsonChunk=Buffer.alloc((raw.length+3)&~3,32);raw.copy(jsonChunk);
  const bytes=Buffer.alloc(12+8+jsonChunk.length+8+4);
  bytes.writeUInt32LE(0x46546c67,0);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);
  bytes.writeUInt32LE(jsonChunk.length,12);bytes.writeUInt32LE(0x4e4f534a,16);jsonChunk.copy(bytes,20);
  bytes.writeUInt32LE(4,20+jsonChunk.length);bytes.writeUInt32LE(0x004e4942,24+jsonChunk.length);
  const file=path.join(dir,'source.glb');await fs.writeFile(file,bytes);
  const report=await inspectCrew(file);assert.equal(report.structuralMatch,false);assert.match(report.loaderError,/one skin/);
});

test('textured prepared assets report rig compatibility separately from renderer compatibility',async t=>{
  const dir=await temp(t),asset=readGLB(await fs.readFile(path.join(ROOT,'assets/crew/sailor.glb')));
  // A texture declaration changes loader support, not the preserved rig/animation.
  asset.json.textures=[{}];
  const raw=Buffer.from(JSON.stringify(asset.json)),json=Buffer.alloc((raw.length+3)&~3,32);raw.copy(json);
  const head=Buffer.alloc(20);head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);
  head.writeUInt32LE(28+json.length+asset.bin.length,8);head.writeUInt32LE(json.length,12);head.writeUInt32LE(0x4e4f534a,16);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(asset.bin.length);bh.writeUInt32LE(0x004e4942,4);
  const file=path.join(dir,'textured.glb');await fs.writeFile(file,Buffer.concat([head,json,bh,asset.bin]));
  const result=await inspectCrew(file);
  assert.deepEqual(result.matchingRigTemplates,['male']);assert.equal(result.loaderCompatible,false);
  assert.equal(result.structuralMatch,false);assert.match(result.loaderError,/vertex colours/);
});
