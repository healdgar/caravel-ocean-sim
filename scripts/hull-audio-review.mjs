#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Offline listening fixtures only. No provider calls, credentials or promotion.
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {SOUND_ASSETS} from '../js/audio-assets.js';

const HULL_REVIEW_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hullReviewHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hullReviewEscape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// These are authored acoustic fixtures, not recordings of a voyage or proof of
// bottom-hull collision. Every A/B pair receives exactly the same input events.
export const HULL_AUDIO_REVIEW_SCENARIOS=[
  {id:'calm-passage',label:'Calm hull passage',seconds:16,speed:2.8,
    detail:'Steady 2.8 m/s passage, restrained wave contact and duplicate reports as one wave reaches neighbouring bow stations.',
    waves:[{at:4,strength:.24,closing:.6},{at:9.2,strength:.32,closing:.8}],
    events:[{at:4,strength:.24},{at:4.55,strength:.24},{at:9.2,strength:.32},{at:9.8,strength:.32}]},
  {id:'stationary-waves',label:'Stationary hull in waves',seconds:16,speed:0,
    detail:'No forward speed. Contact pressure and closing still rise and recede against the stationary planking.',
    waves:[{at:3,strength:.75,closing:1.1},{at:9,strength:.9,closing:1.2}],
    events:[{at:3,strength:.5},{at:3.55,strength:.5},{at:9,strength:.7},{at:9.55,strength:.7}]},
  {id:'rough-reentry',label:'Rough contact and re-entry',seconds:20,speed:3.2,
    detail:'Two ordinary wave episodes and two observed fore-contact exposure/return episodes. The contact bed continues; unaccepted re-entry accents are suppressed. This is not a bottom-crash recording.',
    waves:[{at:2,strength:.7,closing:1.4},{at:6,strength:2.6,closing:2.8},{at:11,strength:.8,closing:1.6},{at:14,strength:2.2,closing:2.5}],
    dry:[{from:5.1,to:5.6},{from:13.1,to:13.6}],
    events:[{at:2,strength:.65},{at:2.55,strength:1},{at:6,strength:2.6,kind:'reentry',closing:2.8},
      {at:6.55,strength:2},{at:7.1,strength:1},{at:11,strength:.8},{at:11.55,strength:.7},
      {at:14,strength:2.2,kind:'reentry',closing:2.5},{at:14.55,strength:1.6}]},
];

function hullReviewHTML(records){
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hull water audio comparison</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:1050px;margin:24px auto;padding:0 18px;color:#e7edf1;background:#101b23}
h1{font-size:26px}p{color:#bed0da}.pair{padding:18px;margin:20px 0;border:1px solid #44555f;border-radius:10px}h2{margin:0;font-size:20px}
.takes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}audio{width:100%;margin:8px 0}.metrics{font:12px ui-monospace,monospace;color:#b4c7d1}
a{color:#9ed8f9}button{padding:8px 15px;border:1px solid #77909d;background:#253a46;color:white;border-radius:6px}@media(max-width:650px){.takes{grid-template-columns:1fr}}
</style><h1>Hull water audio: existing mix / contact-driven mix</h1>
<p>Offline Web Audio renders of the same accepted MP3s and deterministic contact timeline. No new generation, level normalization, wind, music or voice. Near-hull perspective; master volume 70%. The final 150 ms fade is for the review file only.</p>
<p><strong>A:</strong> clearly labelled legacy reference: speed-only wash and the older, louder slap with a 0.5-second cooldown. <strong>B:</strong> production <code>createHullAudioState</code> envelopes, quiet/rearm rules and current filter/segment options. This does not establish perceptual improvement or simulate a true bottom slam.</p>
<button id="stop">Stop all</button><p><a href="checks.json">Render settings and provenance</a> · <a href="request.txt">Listening request</a></p>
${HULL_AUDIO_REVIEW_SCENARIOS.map(s=>`<section class="pair"><h2>${hullReviewEscape(s.label)}</h2><p>${hullReviewEscape(s.detail)}</p><div class="takes">${records.filter(r=>r.scenario===s.id).map(r=>`<div><strong>${r.variant==='legacy'?'A — legacy reference':'B — production contact-driven'}</strong><audio controls preload="metadata" src="${r.file}"></audio><div class="metrics">${r.seconds}s · peak ${r.peak.toFixed(4)} · RMS ${r.rms.toFixed(4)} · ${r.actions.length} accents</div><a href="${r.file}" download>Download WAV</a></div>`).join('')}</div></section>`).join('')}
<script>const players=[...document.querySelectorAll('audio')];for(const p of players)p.addEventListener('play',()=>{for(const other of players)if(other!==p)other.pause()});document.querySelector('#stop').onclick=()=>{for(const p of players){p.pause();p.currentTime=0}};</script></html>`;
}

export async function renderHullAudioReview({out=path.join(HULL_REVIEW_ROOT,'shots/hull-audio-review'),executablePath=process.env.CHROMIUM_PATH??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)}={}){
  out=path.resolve(out);const relative=path.relative(path.join(HULL_REVIEW_ROOT,'shots'),out);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Listening output must remain inside ignored shots/.');
  const sources={};for(const id of['hull-wash','hull-slap']){
    const asset=SOUND_ASSETS[id],bytes=await fs.readFile(path.join(HULL_REVIEW_ROOT,asset.url));
    sources[id]={...asset,sha256:hullReviewHash(bytes)};
  }
  const sourceHashes={};for(const file of['js/weather-state.js','js/audio.js'])sourceHashes[file]=hullReviewHash(await fs.readFile(path.join(HULL_REVIEW_ROOT,file)));
  const server=createDevServer({directory:HULL_REVIEW_ROOT});let browser;
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({executablePath});const page=await browser.newPage();
    await page.route('**/__hull-offline-review',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline hull audio render</title>'}));
    await page.goto(origin+'/__hull-offline-review');
    await page.evaluate(async assets=>{
      const production=await import('/js/weather-state.js'),decoder=new OfflineAudioContext(2,1,44100),buffers={};
      for(const[id,asset]of Object.entries(assets)){
        const response=await fetch('/'+asset.url);if(!response.ok)throw Error('Missing accepted audio: '+id);
        buffers[id]=await decoder.decodeAudioData(await response.arrayBuffer());
      }
      window.hullOfflineReview={production,buffers,assets};
    },sources);
    await fs.mkdir(out,{recursive:true});const records=[];
    for(const scenario of HULL_AUDIO_REVIEW_SCENARIOS)for(const variant of['legacy','current']){
      const result=await page.evaluate(async({scenario,variant})=>{
        const {production,buffers,assets}=hullOfflineReview,rate=44100,dt=1/60,frames=Math.round(scenario.seconds/dt);
        const context=new OfflineAudioContext(2,Math.round(scenario.seconds*rate),rate),master=context.createGain(),limiter=context.createDynamicsCompressor();
        limiter.threshold.value=-10;limiter.knee.value=12;limiter.ratio.value=5;limiter.attack.value=.003;limiter.release.value=.2;
        master.gain.value=0;master.gain.setTargetAtTime(.7,0,.06);master.gain.setValueAtTime(.7,scenario.seconds-.15);master.gain.linearRampToValueAtTime(0,scenario.seconds-.01);
        master.connect(limiter).connect(context.destination);
        const source=context.createBufferSource(),waterGain=context.createGain();source.buffer=buffers['hull-wash'];source.loop=true;
        source.loopEnd=Math.min(assets['hull-wash'].seconds,source.buffer.duration);waterGain.gain.value=0;source.connect(waterGain).connect(master);source.start(0,1.2);
        const state=production.createHullAudioState(),actions=[];let eventIndex=0,lastLegacy=-10;
        const events=scenario.events.map((e,i)=>({...e,at:Math.ceil(e.at*60/8)*8/60,index:i}));
        function contactAt(t){
          let pressure=scenario.speed ? .035 : .005,closing=.03,impact=0;
          for(const wave of scenario.waves){const pulse=Math.exp(-(((t-wave.at)/.7)**2));pressure+=wave.strength*.22*pulse;closing=Math.max(closing,wave.closing*pulse);impact=Math.max(impact,wave.strength*pulse);}
          const dry=(scenario.dry??[]).some(d=>t>=d.from&&t<d.to),wet=dry?0:.94;
          return {revision:1,reset:false,wet,pressure:dry?0:pressure,closing:dry?0:closing,impact:dry?0:impact,position:{x:1.8,y:0,z:-4}};
        }
        function accent(sound,at){
          const audio=context.createBufferSource(),level=context.createGain(),pan=context.createStereoPanner(),options=sound.options??{};
          audio.buffer=buffers[sound.id];audio.playbackRate.value=sound.rate;const point=sound.position??{x:0,y:0,z:0};
          const d=Math.hypot(point.x,point.z),range=Math.hypot(point.x,point.y-1.8,point.z);
          pan.pan.value=Math.max(-1,Math.min(1,point.x/Math.max(d,1)))*.85;
          const gain=sound.gain*(variant==='current'?1/(1+Math.max(0,range-8)/24):1);level.gain.value=gain;
          let tail=audio;
          for(const[type,hz]of[['highpass',options.highpassHz],['lowpass',options.lowpassHz]])if(Number.isFinite(hz)){
            const filter=context.createBiquadFilter();filter.type=type;filter.frequency.value=hz;filter.Q.value=.6;tail.connect(filter);tail=filter;
          }
          tail.connect(level).connect(pan).connect(master);
          const offset=Math.max(0,Math.min(audio.buffer.duration-.01,options.offset??0)),duration=Math.min(audio.buffer.duration-offset,options.duration??audio.buffer.duration),seconds=duration/sound.rate;
          if(options.attack||options.release){const attack=Math.min(seconds*.3,options.attack??0),release=Math.min(seconds*.8,options.release??0);level.gain.setValueAtTime(0,at);level.gain.linearRampToValueAtTime(gain,at+attack);level.gain.setValueAtTime(gain,at+Math.max(attack,seconds-release));level.gain.linearRampToValueAtTime(0,at+seconds);}
          audio.start(at,offset,duration);actions.push({at,kind:sound.kind??'legacy-slap',id:sound.id,gain,rate:sound.rate,offset,duration,options});
        }
        for(let i=0;i<=frames;i++){
          const t=i*dt,contact=contactAt(t);
          if(i%8===0)state.contact({...contact,reset:i===0});
          const mix=state.update(i===0?0:dt,{speed:scenario.speed});
          const gain=variant==='current'?mix.wash:production.weatherAudioLevels({speed:scenario.speed,ship:1})['hull-wash'];
          waterGain.gain.setTargetAtTime(gain,t,.45);
          while(eventIndex<events.length&&events[eventIndex].at<=t+1e-8){
            const e=events[eventIndex++],event={x:e.index%2?1.8:-1.8,y:0,z:-4,strength:e.strength,kind:e.kind??'light',closing:e.closing??1,wet:1};
            if(variant==='current'){
              if(e.kind==='reentry')state.underside({...event,kind:'underside-reentry',epoch:1,probe:0,serial:e.index+1,age:0});
              else{const sound=state.impact(event);if(sound)accent(sound,t);}
            }
            else if(t-lastLegacy>.5){lastLegacy=t;accent({id:'hull-slap',gain:.12+.2*Math.sqrt(event.strength),rate:.92+(e.index*.61803398875%1)*.14,position:event},t);}
          }
        }
        const rendered=await context.startRendering(),left=rendered.getChannelData(0),right=rendered.getChannelData(1),bytes=new Uint8Array(44+left.length*4),view=new DataView(bytes.buffer);
        const tag=(at,s)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));};
        tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,left.length*4,true);
        let peak=0,square=0,clipped=0;for(let i=0;i<left.length;i++)for(let c=0;c<2;c++){
          const sample=(c?right:left)[i];if(!Number.isFinite(sample))throw Error('Non-finite offline audio.');peak=Math.max(peak,Math.abs(sample));square+=sample*sample;if(Math.abs(sample)>1)clipped++;
          view.setInt16(44+i*4+c*2,Math.round(Math.max(-1,Math.min(1,sample))*(sample<0?32768:32767)),true);
        }
        let encoded='';for(let i=0;i<bytes.length;i+=32768)encoded+=String.fromCharCode(...bytes.subarray(i,i+32768));
        return {wav:btoa(encoded),seconds:rendered.duration,sampleRate:rate,channels:2,peak,rms:Math.sqrt(square/(left.length*2)),clipped,actions};
      },{scenario,variant});
      const file=scenario.id+'-'+variant+'.wav',bytes=Buffer.from(result.wav,'base64');delete result.wav;
      await fs.writeFile(path.join(out,file+'.part'),bytes);await fs.rename(path.join(out,file+'.part'),path.join(out,file));
      records.push({scenario:scenario.id,variant,file,sha256:hullReviewHash(bytes),bytes:bytes.length,...result});
    }
    const checks={method:'OfflineAudioContext, decoded accepted MP3s, production createHullAudioState; no per-file normalization',sampleRate:44100,masterVolume:.7,listener:{x:0,y:1.8,z:0,shipDistance:1},loopOffsetSeconds:1.2,contactReadbackEveryFrames:8,simulationHz:60,reviewOnlyTailFadeSeconds:.15,limitations:['Authored contact/event fixtures do not prove underside collision.','Other ambience, hull creaking, voices and gunnery are intentionally excluded.','Legacy playback-rate variation is deterministic inside its original range.','A/B comparison is not blind and cannot substitute for user listening.'],sources,sourceHashes,scenarios:HULL_AUDIO_REVIEW_SCENARIOS,records};
    const request=`Listen directly to these six stereo WAV files using native read_file audio perception. State honestly whether you heard them. If audio ingestion is unsupported, stop. Read only the six named WAV files; do not inspect HTML, metadata, source code, prompts, other directories or credentials. Do not browse, edit, generate, delegate or spawn subagents.\n\nThe scene is a large wooden sailing ship. Each A/B pair shares accepted source audio and an identical authored timeline. Files are not loudness-normalized. A is the louder existing reference; B is a proposed contact-driven mix. Do not assume B is better.\n\n${records.map(r=>`${r.file} — ${r.seconds} seconds; ${r.variant==='legacy'?'A legacy reference':'B proposed mix'}.`).join('\n')}\n\nCompare calm-passage A/B: does B reduce deliberate splash-like slaps without losing believable water passing the planks? Compare stationary-waves A/B: B should supply wash against the stationary hull rather than silence. Compare rough-reentry A/B: judge connected water pressure/rushing and meaningful quiet intervals, rather than repeated deliberate splashes. Re-entry deliberately has no dedicated crash accent because none has passed review. Judge the continuous water bed as ambience; do not present it as a completed heavy bottom-impact effect. Say if removing the replayed-wash accent reduces pumping.\n\nFor each B give KEEP / EDIT / REJECT, actual audible contents and defects, whether the accents remain harsh or repetitive, whether quiet intervals exist, and whether gain/filter transitions pump, click or cut off. Distinguish lower loudness from improved source quality. No claim of exact bottom-impact physics, historical calibration, human approval or in-game verification.\n`;
    await fs.writeFile(path.join(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');await fs.writeFile(path.join(out,'request.txt'),request);await fs.writeFile(path.join(out,'index.html'),hullReviewHTML(records));
    return {out,reviewHTML:path.join(out,'index.html'),request:path.join(out,'request.txt'),records:records.map(({file,seconds,peak,rms,clipped,actions})=>({file,seconds,peak,rms,clipped,accents:actions.length}))};
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.includes('--help'))console.log('node scripts/hull-audio-review.mjs\nRenders six offline A/B WAVs, checks.json, request.txt and index.html under ignored shots/hull-audio-review/. Uses CHROMIUM_PATH when supplied. No API or paid generation.');
  else renderHullAudioReview().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
