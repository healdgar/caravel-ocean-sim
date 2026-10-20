import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PILOT,WEATHER,SAMPLES,MODEL,ENDPOINT,resolveAudioKey,soundRequest,generateSound,buildReview,reviewWave,editAudio,audioFilters} from '../scripts/audio.mjs';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ocean-audio-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const mp3=()=>new Response(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(200)]),{headers:{'character-cost':'120'}});
const pcm=()=>{const bytes=Buffer.alloc(16);[1.6,-1.4,.2,-.2].forEach((n,i)=>bytes.writeFloatLE(n,i*4));return bytes;};

test('authoring reads the project key locally and never needs 1Password',async t=>{
  const root=await temp(t);
  await fs.writeFile(path.join(root,'.env.local'),'ELEVENLABS_API_KEY="test-project-key"\n');
  assert.equal(await resolveAudioKey({root,env:{ELEVENLABS_API_KEY:'another-project'}}),'test-project-key');
  await fs.writeFile(path.join(root,'.env.local'),'ELEVENLABS_API_KEY=\n');
  await assert.rejects(resolveAudioKey({root,env:{}}),/Set ELEVENLABS_API_KEY/);
});

test('pilot uses bounded isolated samples and the documented looping model',()=>{
  assert.equal(PILOT.reduce((sum,s)=>sum+s.seconds,0),59);
  for(const sample of PILOT){const request=soundRequest(sample);assert.equal(request.model_id,MODEL);assert.equal(request.loop,sample.loop);}
  assert.throws(()=>soundRequest({...PILOT[0],seconds:31}),/duration/);
});

test('weather batch stays separate from the paid ship pilot and validates every generation request',()=>{
  assert.equal(WEATHER.reduce((sum,s)=>sum+s.seconds,0),84);
  assert.equal(new Set(SAMPLES.map(s=>s.id)).size,SAMPLES.length);
  for(const sample of WEATHER){
    const request=soundRequest(sample);
    assert.equal(request.loop,!sample.id.startsWith('thunder-'));
    assert.ok(!PILOT.some(s=>s.id===sample.id));
  }
});

test('completed takes are reused; changed prompts and concurrent submissions cannot buy duplicates',async t=>{
  const dir=await temp(t);let posts=0,release;
  const fetchImpl=async(url,options)=>{
    posts++;assert.ok(url.startsWith(ENDPOINT+'?'));assert.equal(options.redirect,'error');
    assert.equal(options.headers['xi-api-key'],'test-key');
    await new Promise(resolve=>release=resolve);return mp3();
  };
  const first=generateSound(PILOT[3],{dir,key:'test-key',fetchImpl});
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(generateSound(PILOT[3],{dir,key:'test-key',fetchImpl}),/pending or failed/);
  release();const result=await first;
  const reused=await generateSound(PILOT[3],{dir,key:'test-key',fetchImpl});
  assert.equal(reused.reused,true);assert.equal(result.credits,120);assert.equal(posts,1);
  await assert.rejects(generateSound({...PILOT[3],prompt:'changed'},{dir,key:'test-key',fetchImpl}),/another prompt/);
  const record=await fs.readFile(path.join(dir,'hull-slap-01.json'),'utf8');
  assert.ok(!record.includes('test-key'));
});

test('API and transport failures never echo credentials or automatically retry paid requests',async t=>{
  for(const mode of ['http','transport']){
    const dir=path.join(await temp(t),mode);let posts=0;
    const fetchImpl=async()=>{posts++;if(mode==='transport')throw Error('test-secret');
      return Response.json({detail:{status:'missing_permissions',message:'test-secret'}},{status:401});};
    await assert.rejects(generateSound(PILOT[3],{dir,key:'test-secret',fetchImpl}),e=>!e.message.includes('test-secret'));
    await assert.rejects(generateSound(PILOT[3],{dir,key:'test-secret',fetchImpl}),/pending or failed/);
    assert.equal(posts,1);
    assert.ok(!(await fs.readFile(path.join(dir,'hull-slap-01.json'),'utf8')).includes('test-secret'));
  }
});

test('local review copies completed checked audio, not credentials or failed requests',async t=>{
  const dir=await temp(t),out=path.join(dir,'review');
  const sample={...PILOT[3],prompt:'A quiet water slap <script>test</script>'};
  await generateSound(sample,{dir,key:'test-secret',fetchImpl:async()=>mp3()});
  const result=await buildReview({dir,out,decode:async()=>pcm()});
  assert.equal(result.samples,1);assert.equal(result.credits,120);
  const page=await fs.readFile(result.file,'utf8');
  assert.ok(page.includes('&lt;script&gt;test&lt;/script&gt;'));
  assert.ok(!page.includes('test-secret'));
  assert.ok(page.includes('hull-slap-01.wav'));
  await fs.writeFile(path.join(dir,'hull-slap-01.mp3'),'corrupt');
  await assert.rejects(buildReview({dir,out}),/checksum/);
});

test('listening copies retain stereo and tame decoded MP3 overshoots before integer conversion',()=>{
  const result=reviewWave(pcm());
  assert.equal(result.wav.toString('ascii',0,4),'RIFF');
  assert.equal(result.wav.readUInt16LE(22),2);
  const peak=Math.max(...Array.from({length:4},(_,i)=>Math.abs(result.wav.readInt16LE(44+i*2))/32767));
  assert.ok(Math.abs(20*Math.log10(peak)+6)<.01);
  assert.ok(result.sourcePeakDb>0);assert.ok(result.gainDb<-6);
  assert.throws(()=>reviewWave(Buffer.alloc(16)),/silent/);
});

test('tail edit preserves the initial impact, removes later events and fades to zero without changing the source',()=>{
  const source=Buffer.alloc(44100*3*8);
  for(let i=0;i<source.length;i+=8){source.writeFloatLE(.5,i);source.writeFloatLE(-.25,i+4);}
  const edited=editAudio(source,{endSeconds:1.2,fadeOutSeconds:.2});
  assert.equal(edited.length,Math.floor(1.2*44100)*8);
  assert.deepEqual(edited.subarray(0,44100*8),source.subarray(0,44100*8));
  assert.equal(Math.abs(edited.readFloatLE(edited.length-8)),0);
  assert.equal(Math.abs(edited.readFloatLE(edited.length-4)),0);
  assert.equal(source.readFloatLE(source.length-8),.5);
  assert.strictEqual(editAudio(source),source);
});

test('wind edits remove the early defect and join the loop without silence or a sample discontinuity',()=>{
  const source=Buffer.alloc(44100*3*8);
  for(let frame=0;frame<44100*3;frame++){
    source.writeFloatLE(frame/(44100*3),frame*8);
    source.writeFloatLE(-frame/(44100*3),frame*8+4);
  }
  const original=Buffer.from(source);
  const loop=editAudio(source,{startSeconds:.5,endSeconds:2.5,loopCrossfadeSeconds:.2});
  assert.equal(loop.length,44100*1.8*8);
  for(const channel of [0,1]){
    const offset=channel*4;
    const next=source.readFloatLE(Math.round(.7*44100)*8+offset);
    const previous=source.readFloatLE((Math.round(.7*44100)-1)*8+offset);
    assert.equal(loop.readFloatLE(offset),next);
    assert.equal(loop.readFloatLE(loop.length-8+offset),previous);
    assert.ok(Math.abs(next-previous)<.00002);
  }
  assert.deepEqual(source,original);
  for(const edit of [{startSeconds:-1},{startSeconds:NaN},{startSeconds:2,endSeconds:1},{loopCrossfadeSeconds:2},{loopCrossfadeSeconds:.2,fadeOutSeconds:.1}])
    assert.throws(()=>editAudio(source,edit),/Invalid audio/);
});

test('review EQ accepts bounded numeric controls and rejects invalid filter expressions',()=>{
  assert.equal(audioFilters().length,0);
  assert.equal(audioFilters({highpassHz:90,highShelfHz:4500,highShelfGainDb:-3.5}).length,2);
  for(const edit of [{highpassHz:'90,anull'},{highpassHz:NaN},{highShelfHz:4500},{highShelfHz:4500,highShelfGainDb:90}])
    assert.throws(()=>audioFilters(edit),/Invalid audio/);
});
