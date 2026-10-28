import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {GUNNERY_AUDIO_ASSETS} from '../js/gunnery-audio-assets.js';
import {GUNNERY_ORDER_SECONDS,gunneryElevationBand,gunneryLayOrderClip,gunnerySoundSpeed,gunnerySoundDelay,createGunneryAudio} from '../js/gunnery-audio.js';
import {GUNNERY_RECIPES} from '../scripts/gunnery-audio.mjs';
import {soundRequest} from '../scripts/audio.mjs';

const audioPoint={x:0,y:2,z:0};
function audioFixture(){
  const played=[];let enabled=true;
  const sound=createGunneryAudio({play:(...args)=>{played.push(args);return GUNNERY_AUDIO_ASSETS[args[0]]?.seconds??0;},available:()=>enabled,listener:()=>audioPoint});
  return {played,sound,mute:()=>enabled=false};
}

test('gun reports arrive after acoustic propagation, not with the muzzle flash',()=>{
  assert.ok(Math.abs(gunnerySoundSpeed()-340.39)<.001);
  assert.equal(gunnerySoundSpeed(NaN),gunnerySoundSpeed(15));
  const distance=340.39*2,position={x:distance,y:2,z:0};
  assert.ok(Math.abs(gunnerySoundDelay(position,audioPoint)-2)<1e-10);
  const {played,sound}=audioFixture();
  sound.event({type:'shot',shotId:1,position});
  sound.update(1.99);assert.equal(played.length,0);
  sound.update(.011);assert.equal(played.length,1);assert.equal(played[0][0],'cannon-report');
  assert.deepEqual(played[0][2],position);
});

test('broadside reports are bounded acoustic groups while independent reload discharges remain audible',()=>{
  const {played,sound}=audioFixture();
  for(let i=0;i<52;i++)sound.event({type:'shot',shotId:i,position:{x:10,y:2,z:i*.6}});
  assert.ok(sound.pending<=3,'52 near simultaneous cannon cannot allocate 52 sources');
  sound.update(.2);
  assert.ok(played.some(p=>p[0]==='cannon-report'));
  assert.ok(played.filter(p=>p[0]==='cannon-report').every(p=>p[1]<=.66));
  assert.equal(sound.event({type:'shot',shotId:0,position:audioPoint}),false,'same discharge cannot double trigger');
  assert.equal(sound.event({type:'shot',shotId:52,gunId:0,position:audioPoint}),true,'reloaded same gun emits a new discharge');
  for(let i=0;i<150;i++)sound.event({type:'shot',shotId:100+i,position:{x:1000+i*130,y:2,z:0}});
  assert.ok(sound.pending<=32,'even distant future acoustic arrivals stay bounded');
});

test('crew readiness is driven by a real ready event and command spam retains one pending exchange',()=>{
  const {played,sound}=audioFixture();
  sound.order('prepare',audioPoint);
  for(let i=0;i<100;i++)sound.order(i%2?'fire-port':'fire-starboard',audioPoint);
  sound.update(GUNNERY_ORDER_SECONDS.prepare+.2);
  assert.deepEqual(played.map(p=>p[0]),['captain-guns-prepare','captain-guns-fire-port']);
  sound.update(20);
  assert.ok(!played.some(p=>p[0]==='crew-guns-ready'),'timer alone never announces a loaded battery');
  sound.event({type:'ready',position:audioPoint});sound.update(.01);
  assert.equal(played.at(-1)[0],'crew-guns-ready');
  for(let i=0;i<52;i++)sound.event({type:'ready',position:audioPoint});
  sound.event({type:'ready',position:audioPoint});sound.order('fire-starboard',audioPoint);
  sound.update(3);sound.update(3);
  assert.equal(played.filter(p=>p[0]==='crew-guns-ready').length,1,'no stale ready shout after the order to fire');
});

test('mute clears pending gunfire and speech without replaying obsolete arrivals',()=>{
  const {played,sound,mute}=audioFixture();
  for(const position of [{x:NaN,y:0,z:0},{x:0,y:Infinity,z:0}])assert.equal(sound.event({type:'shot',position}),false);
  sound.event({type:'shot',shotId:1,position:{x:3000,y:2,z:0}});
  sound.order('prepare',audioPoint);sound.order('fire-port',audioPoint);
  mute();sound.update(30);assert.equal(sound.pending,0);assert.equal(sound.busy,false);
  assert.equal(played.length,1);
});

test('captain shouts quoin elevation and steady-on-the-roll orders followed by give-fire on the roll',()=>{
  const {played,sound}=audioFixture();
  assert.equal(gunneryElevationBand(-2),'depress');
  assert.equal(gunneryElevationBand(0),'point-blank');
  assert.equal(gunneryElevationBand(2),'elev-2');
  assert.equal(gunneryElevationBand(5),'elev-5');
  assert.equal(gunneryElevationBand(9),'elev-8');
  assert.equal(gunneryLayOrderClip('port',2),'captain-guns-lay-port-elev-2');
  assert.equal(gunneryLayOrderClip('starboard',0),'captain-guns-lay-starboard-point-blank');
  sound.order('fire-port',{x:0,y:2,z:0,gunneryElevation:2});
  assert.equal(played.at(-1)[0],'captain-guns-lay-port-elev-2');
  sound.event({type:'give-fire',position:audioPoint});
  sound.update(6.5);
  assert.equal(played.at(-1)[0],'captain-guns-give-fire');
});

test('authored cannon assets are complete, offline, checksum pinned and retain decoded headroom',async()=>{
  const provenance=JSON.parse(await fs.readFile(new URL('../assets/audio/gunnery/provenance.json',import.meta.url),'utf8'));
  assert.equal(provenance.length,20);
  for(const source of provenance){
    const asset=GUNNERY_AUDIO_ASSETS[source.id];assert.ok(asset&&!asset.loop);
    const bytes=await fs.readFile(new URL('../'+asset.url,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256);
    assert.ok(asset.seconds>.5&&asset.seconds<7);
    const pcm=execFileSync('ffmpeg',['-v','error','-i',new URL('../'+asset.url,import.meta.url).pathname,'-f','f32le','-ac','1','-ar','44100','pipe:1'],{maxBuffer:4*1024*1024});
    let peak=0;for(let i=0;i<pcm.length;i+=4){const n=pcm.readFloatLE(i);assert.ok(Number.isFinite(n));peak=Math.max(peak,Math.abs(n));}
    assert.ok(peak>1e-3&&peak<.78,source.id+' must be audible and below clipping');
  }
  for(const recipe of GUNNERY_RECIPES.sounds)assert.doesNotThrow(()=>soundRequest(recipe));
});
