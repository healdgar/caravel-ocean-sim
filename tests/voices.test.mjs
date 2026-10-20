import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CAST,ANCHOR_SOUNDS,speechRequest,paidRequest} from '../scripts/voices.mjs';
import {CREW_ROSTER,CAPTAIN_ORDERS} from '../js/crew.js';
import {createVoiceDirector,SPOKEN_ORDERS} from '../js/voice-lines.js';
import {createSceneAudio} from '../js/audio.js';
import {VOICE_ASSETS} from '../js/voice-assets.js';

test('voice cast matches all twelve named sailors with twelve distinct identities and balanced voices',()=>{
  assert.deepEqual(CAST.crew.map(p=>[p.id,p.name,p.sex]),CREW_ROSTER.map(p=>[p.id,p.name,p.sex]));
  assert.equal(new Set(CAST.crew.map(p=>p.voiceId)).size,12);
  assert.equal(CAST.crew.filter(p=>p.sex==='female').length,6);
  assert.equal(CAST.crew.filter(p=>p.sex==='male').length,6);
  assert.deepEqual(CAST.captain.orders.map(o=>o.id),[...CAPTAIN_ORDERS.map(o=>o.id),'drop-anchor','weigh-anchor']);
  assert.deepEqual(SPOKEN_ORDERS,CAST.captain.orders.map(o=>o.id));
  assert.match(CAST.captain.description,/Cornwall/);
  assert.equal(speechRequest('[shouts] Aye captain!').model_id,'eleven_v3');
  assert.equal(ANCHOR_SOUNDS.filter(s=>s.loop).map(s=>s.id).join(),'anchor-reel');
});

test('promoted voice and anchor files match their recorded provenance and contain complete MP3 payloads',async()=>{
  const records=JSON.parse(await fs.readFile(new URL('../assets/audio/voices/provenance.json',import.meta.url),'utf8'));
  assert.equal(records.length,23);
  for(const record of records){
    const asset=VOICE_ASSETS[record.id];assert.ok(asset);
    assert.ok(asset.seconds>.4&&asset.seconds<12);
    const bytes=await fs.readFile(new URL('../'+asset.url,import.meta.url));
    assert.equal(bytes.length,record.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256);
    assert.ok(bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224));
  }
  assert.equal(new Set(records.filter(r=>r.id.startsWith('crew-')).map(r=>r.voiceId)).size,12);
});

test('voice authoring reuses verified audio and journals uncertain paid requests without leaking keys',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'caravel-voices-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const request=speechRequest('Aye captain!');let calls=0;
  const fetchImpl=async()=>{calls++;return new Response(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(200)]),{headers:{'character-cost':'8'}});};
  const options={dir,key:'private-test-key',fetchImpl,audio:true};
  const first=await paidRequest('ack','/v1/text-to-speech/fake',request,options);
  assert.equal(first.credits,8);
  assert.equal((await paidRequest('ack','/v1/text-to-speech/fake',request,options)).reused,true);
  assert.equal(calls,1);
  await assert.rejects(paidRequest('ack','/v1/text-to-speech/fake',speechRequest('Different text'),options),/differs/);
  await assert.rejects(paidRequest('uncertain','/v1/text-to-speech/fake',request,{...options,fetchImpl:async()=>{throw Error('private-test-key');}}),/billing uncertain/);
  await assert.rejects(paidRequest('uncertain','/v1/text-to-speech/fake',request,options),/pending or failed/);
  assert.ok(!(await fs.readFile(path.join(dir,'ack.json'),'utf8')).includes('private-test-key'));
  assert.ok(!(await fs.readFile(path.join(dir,'uncertain.json'),'utf8')).includes('private-test-key'));
});

test('captain and acknowledgment serialize; rapid changes collapse to the newest order',()=>{
  const calls=[],assets=Object.fromEntries([...SPOKEN_ORDERS.map(id=>'captain-'+id),...CAST.crew.map(p=>'crew-'+p.id)].map(id=>[id,{seconds:1}]));
  const director=createVoiceDirector({play:(id,...rest)=>{calls.push([id,...rest]);return 1;},assets,crew:CAST.crew});
  const boat={x:10,z:20};
  assert.equal(director.order('full',{boat}),true);
  assert.equal(director.order('full',{boat}),false);
  director.order('reduced',{boat});director.order('furl',{boat});
  assert.deepEqual(calls.map(c=>c[0]),['captain-full']);
  director.update(1.2);
  assert.deepEqual(calls.map(c=>c[0]),['captain-full','crew-tomas']);
  assert.equal(calls[1][2],boat);
  director.update(1.3);
  assert.deepEqual(calls.map(c=>c[0]),['captain-full','crew-tomas','captain-furl']);
  director.update(1.2);
  assert.equal(calls.at(-1)[0],'crew-beatriz');
  assert.equal(director.order('nonsense'),false);
  director.clear();assert.equal(director.busy,false);
});

test('muting discards pending speech and never plays a late acknowledgment',()=>{
  let enabled=true;const calls=[];
  const director=createVoiceDirector({assets:{'captain-full':{seconds:1},'crew-tomas':{seconds:1}},crew:CAST.crew,
    available:()=>enabled,play:id=>{calls.push(id);return 1;}});
  director.order('full');enabled=false;director.update(2);enabled=true;director.update(1);
  assert.deepEqual(calls,['captain-full']);
});

test('scene audio shares mute/context for voices and starts anchor machinery only when needed',async t=>{
  const originalAudio=globalThis.AudioContext,originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.AudioContext=originalAudio;globalThis.fetch=originalFetch;});
  const starts=[],params=[];
  const parameter=()=>({value:0,setTargetAtTime(value){this.value=value;params.push(value);}});
  const node=()=>({connect(target){return target;},disconnect(){}});
  class Audio {
    state='suspended';currentTime=0;destination=node();
    createGain(){return {...node(),gain:parameter()};}
    createStereoPanner(){return {...node(),pan:parameter()};}
    createDynamicsCompressor(){return {...node(),...Object.fromEntries(['threshold','knee','ratio','attack','release'].map(k=>[k,parameter()]))};}
    createBufferSource(){return {...node(),loop:false,playbackRate:parameter(),connect(target){this.level=target.gain;return target;},start(){starts.push({loop:this.loop,url:this.buffer.url,level:this.level});},stop(){this.onended?.();}};}
    async decodeAudioData(bytes){return {duration:1,url:new TextDecoder().decode(bytes)};}
    async resume(){this.state='running';}async suspend(){this.state='suspended';}async close(){this.state='closed';}
  }
  globalThis.AudioContext=Audio;
  globalThis.fetch=async url=>new Response(String(url));
  const engine=createSceneAudio();assert.equal(starts.length,0);
  await engine.toggle();assert.equal(engine.enabled,true);assert.equal(engine.ready,true);
  assert.equal(starts.filter(s=>s.loop).length,7);
  const boat={x:0,z:0,length:24,showProw:true,enabled:true,surgeVelocity:0,revision:0};
  const frame=new Float32Array(32);frame[20]=1;
  const p={soundVolume:.5,windSpeed:0,seabirds:0},weather={intensity:0,type:'off'};
  assert.equal(engine.order('full',{boat}),true);
  assert.ok(starts.at(-1).url.endsWith('/captain-full.mp3'));
  engine.update(1.2,p,boat,frame,weather);
  assert.ok(starts.at(-1).url.endsWith('/crew-tomas.mp3'));
  engine.anchor({type:'reel-start',x:0,z:0},boat);engine.update(.1,p,boat,frame,weather);
  assert.equal(starts.filter(s=>s.loop).length,8);
  engine.anchor({type:'splash',x:0,z:0},boat);
  assert.ok(starts.at(-1).url.endsWith('/anchor-splash.mp3'));
  const reel=starts.find(s=>s.url.endsWith('/anchor-reel.mp3'));
  engine.anchor({type:'set'},boat);engine.update(.1,p,boat,frame,weather);
  assert.ok(reel.level.value>0,'bottom contact keeps machinery audible while rode pays out');
  engine.anchor({type:'reel-stop'},boat);engine.update(.1,p,boat,frame,weather);
  assert.equal(reel.level.value,0,'machinery fades once payout stops');
  await engine.toggle();assert.equal(engine.enabled,false);
  const before=starts.length;engine.order('furl',{boat});engine.update(4,p,boat,frame,weather);assert.equal(starts.length,before);
  assert.equal(Object.keys(VOICE_ASSETS).length,23);
  engine.destroy();
});
