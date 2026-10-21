#!/usr/bin/env node
// Local asset authoring only; never imported by the game or Pages build.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {parseArgs, parseEnv, promisify} from 'node:util';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const ENDPOINT='https://api.elevenlabs.io/v1/sound-generation';
export const MODEL='eleven_text_to_sound_v2';
export const FORMAT='mp3_44100_128';
export const PILOT=JSON.parse(await fs.readFile(new URL('./audio/pilot.json',import.meta.url),'utf8'));
export const WEATHER=JSON.parse(await fs.readFile(new URL('./audio/weather.json',import.meta.url),'utf8'));
export const NATURE=JSON.parse(await fs.readFile(new URL('./audio/nature.json',import.meta.url),'utf8'));
export const HULL_CONTACT=JSON.parse(await fs.readFile(new URL('./audio/hull-contact.json',import.meta.url),'utf8'));
export const SAMPLES=[...PILOT,...WEATHER,...NATURE,...HULL_CONTACT];
const HELP=`Local ElevenLabs sound authoring (Node 22+)

npm run audio -- plan                  Inspect the six-sample pilot; no API call
npm run audio -- plan --set weather    Inspect weather prompts; no API call
npm run audio -- plan --set nature     Inspect seabird prompts; no API call
npm run audio -- plan --set hull       Inspect revised hull-contact prompts
npm run audio -- generate hull-slap    Generate/reuse one sample (paid)
npm run audio -- pilot                 Generate/reuse the six-sample pilot (paid)
npm run audio -- weather               Generate/reuse the weather set (paid)
npm run audio -- nature                Generate/reuse the seabird set (paid)
npm run audio -- hull                  Generate/reuse two hull-contact samples (paid)
npm run audio -- review --take 02      Build a local listening page; no API call
npm run audio -- review --selected     Review the currently selected takes/edits

--take NAME (default 01) deliberately buys a different take.
The key is read from this project's .env.local; no 1Password access.
MP3 44.1 kHz / 128 kbps previews use the standard API output format.
Outputs, prompts, checksums and billing headers stay in ignored .audio/.
Review uses ffmpeg to decode stereo WAV copies with -6 dBFS peak headroom.
No automatic retries. An interrupted paid request remains marked pending.
`;

export async function resolveAudioKey({root=ROOT,env=process.env}={}) {
  let local={};
  try {local=parseEnv(await fs.readFile(path.join(root,'.env.local'),'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw Error('Cannot read the project .env.local file.');}
  const key=(local.ELEVENLABS_API_KEY??env.ELEVENLABS_API_KEY)?.trim();
  if(!key||/\s/.test(key)||key.startsWith('op://'))throw Error('Set ELEVENLABS_API_KEY in .env.local.');
  return key;
}

export function soundRequest(sample) {
  if(!sample || typeof sample.prompt!=='string' || !sample.prompt.trim() || sample.prompt.length>450)
    throw Error('Sound prompts must contain 1–450 characters.');
  if(!Number.isFinite(sample.seconds)||sample.seconds<.5||sample.seconds>30)
    throw Error('Sound duration must be 0.5–30 seconds.');
  return {text:sample.prompt,model_id:MODEL,duration_seconds:sample.seconds,
    loop:!!sample.loop,prompt_influence:.45};
}

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeName=value=>{if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))throw Error('Invalid sample or take name.');return value;};
const saveJSON=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function editAudio(pcm,{startSeconds=0,endSeconds,fadeOutSeconds=0,loopCrossfadeSeconds=0}={}) {
  if(endSeconds===undefined&&startSeconds===0&&fadeOutSeconds===0&&loopCrossfadeSeconds===0)return pcm;
  const available=pcm.length/8;
  const start=Math.floor(startSeconds*44100);
  const end=endSeconds===undefined?available:Math.min(available,Math.floor(endSeconds*44100));
  const frames=end-start;
  if(!Number.isFinite(start)||start<0||!Number.isFinite(frames)||frames<2||!Number.isFinite(fadeOutSeconds)||fadeOutSeconds<0||fadeOutSeconds>=frames/44100)
    throw Error('Invalid audio trim or fade.');
  const overlap=Math.round(loopCrossfadeSeconds*44100);
  if(!Number.isFinite(loopCrossfadeSeconds)||loopCrossfadeSeconds<0||(loopCrossfadeSeconds>0&&overlap<2)||overlap*2>=frames||(overlap&&fadeOutSeconds))
    throw Error('Invalid audio loop crossfade.');
  const result=Buffer.from(pcm.subarray(start*8,end*8));
  if(overlap){
    // The center runs into a tail/head blend; its end then meets the next
    // center's first sample in original source order, without a silent seam.
    const center=frames-2*overlap,loop=Buffer.alloc((frames-overlap)*8);
    result.copy(loop,0,overlap*8,(frames-overlap)*8);
    for(let i=0;i<overlap;i++){
      const angle=i/(overlap-1)*Math.PI/2;
      for(let channel=0;channel<2;channel++){
        const tail=result.readFloatLE(((frames-overlap+i)*2+channel)*4);
        const head=result.readFloatLE((i*2+channel)*4);
        loop.writeFloatLE(tail*Math.cos(angle)+head*Math.sin(angle),((center+i)*2+channel)*4);
      }
    }
    return loop;
  }
  const fade=Math.min(frames,Math.round(fadeOutSeconds*44100));
  for(let i=0;i<fade;i++){
    const gain=fade<=1?0:.5+.5*Math.cos(Math.PI*i/(fade-1));
    for(let channel=0;channel<2;channel++){
      const offset=((frames-fade+i)*2+channel)*4;
      result.writeFloatLE(result.readFloatLE(offset)*gain,offset);
    }
  }
  return result;
}

export function reviewWave(pcm) {
  if(!pcm.length||pcm.length%8)throw Error('Invalid stereo float audio.');
  let peak=0;
  for(let i=0;i<pcm.length;i+=4){
    const value=pcm.readFloatLE(i);
    if(!Number.isFinite(value))throw Error('Invalid audio sample.');
    peak=Math.max(peak,Math.abs(value));
  }
  if(peak<.0001)throw Error('Generated audio is effectively silent.');
  // MP3 decoding can overshoot full scale. Scale in floating point before
  // converting to integer PCM, retaining headroom in the listening copy.
  const gain=Math.pow(10,-6/20)/peak,size=pcm.length/2;
  const wav=Buffer.alloc(44+size);
  wav.write('RIFF');wav.writeUInt32LE(36+size,4);wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);
  wav.writeUInt32LE(44100,24);wav.writeUInt32LE(44100*4,28);
  wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(size,40);
  for(let i=0;i<pcm.length;i+=4)wav.writeInt16LE(Math.round(pcm.readFloatLE(i)*gain*32767),44+i/2);
  return {wav,sourcePeakDb:20*Math.log10(peak),gainDb:20*Math.log10(gain),seconds:pcm.length/(44100*8)};
}

export function audioFilters({highpassHz,highShelfHz,highShelfGainDb}={}) {
  const filters=[];
  if(highpassHz!==undefined){
    if(!Number.isFinite(highpassHz)||highpassHz<10||highpassHz>1000)throw Error('Invalid audio high-pass filter.');
    filters.push(`highpass=f=${highpassHz}:r=f32`);
  }
  if(highShelfHz!==undefined||highShelfGainDb!==undefined){
    if(!Number.isFinite(highShelfHz)||highShelfHz<1000||highShelfHz>20000||!Number.isFinite(highShelfGainDb)||Math.abs(highShelfGainDb)>12)
      throw Error('Invalid audio high-shelf filter.');
    filters.push(`highshelf=f=${highShelfHz}:g=${highShelfGainDb}:r=f32`);
  }
  return filters;
}

async function decodeAudio(file,edit) {
  const filters=audioFilters(edit);
  try {return (await promisify(execFile)('ffmpeg',['-v','error','-i',file,...(filters.length?['-af',filters.join(',')]:[]),'-f','f32le','-ac','2','-ar','44100','pipe:1'],
    {encoding:'buffer',maxBuffer:32*1024*1024,timeout:30000})).stdout;}
  catch {throw Error('Cannot decode the sample; install ffmpeg and check the saved audio.');}
}

export async function buildReview({take='01',selection,samples=SAMPLES,dir=path.join(ROOT,'.audio/pilot'),out=path.join(ROOT,'shots/audio-review'),decode=decodeAudio}={}) {
  safeName(take);
  await fs.mkdir(out,{recursive:true});
  const cards=[],checks=[];let totalCredits=0;
  for(const sample of samples){
    if(selection&&!selection[sample.id])continue;
    const choice=selection?.[sample.id]??{};
    const selectedTake=safeName(choice.take??take);
    const name=sample.id+'-'+selectedTake;
    const filename=name+(choice.edit?'-edit-'+sha256(JSON.stringify(choice.edit)).slice(0,8):'')+'.wav';
    let record;
    try {record=JSON.parse(await fs.readFile(path.join(dir,name+'.json'),'utf8'));}
    catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(record.status!=='complete')continue;
    const original=path.join(dir,name+'.mp3');
    const bytes=await fs.readFile(original);
    if(sha256(bytes)!==record.sha256)throw Error('Saved audio checksum differs; review was not updated.');
    const prepared=reviewWave(editAudio(await decode(original,choice.edit),choice.edit));
    await fs.writeFile(path.join(out,filename),prepared.wav);
    checks.push({id:sample.id,take:selectedTake,edit:choice.edit,seconds:prepared.seconds,sourcePeakDb:prepared.sourcePeakDb,gainDb:prepared.gainDb,reviewPeakDb:-6});
    totalCredits+=record.credits??0;
    cards.push(`<article><div class="kind">${sample.loop?'AMBIENCE LOOP':'SINGLE EVENT'} · ${Number(prepared.seconds.toFixed(2))} SECONDS · TAKE ${html(selectedTake)}</div>
      <h2>${html(sample.label)}</h2><p>${html(sample.driver)}</p>
      ${choice.note?`<p class="note">${html(choice.note)}</p>`:''}
      <audio controls preload="metadata" ${sample.loop?'loop':''} src="${filename}"></audio>
      <details><summary>Generation prompt</summary><p>${html(record.request.text)}</p></details></article>`);
  }
  if(!cards.length)throw Error('No completed samples for this take.');
  const pending=selection?samples.filter(sample=>!checks.some(check=>check.id===sample.id)).map(sample=>sample.label):[];
  const reviewNotes=selection?samples.filter(sample=>sample.reviewNote&&!checks.some(check=>check.id===sample.id)).map(sample=>sample.reviewNote):[];
  const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Caravel · Sound samples</title><style>
    :root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#101a20;color:#e7eeef}
    body{max-width:1060px;margin:0 auto;padding:32px 20px 60px}header{max-width:760px;margin-bottom:28px}
    .eyebrow,.kind{letter-spacing:.12em;font-size:11px;font-weight:700;color:#b4a17e}h1{font-size:clamp(30px,5vw,44px);line-height:1.15;margin:12px 0}
    p{color:#a9bdc5}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}
    article{background:#192831;border:1px solid #31434d;border-radius:12px;padding:22px}h2{font-size:20px;margin:10px 0}
    article p{font-size:14px;min-height:42px}audio{width:100%;margin:10px 0}details{font-size:13px}summary{cursor:pointer;color:#b4cbd4}
    button{font:inherit;padding:10px 18px;border:1px solid #6f858e;border-radius:7px;background:#253d49;color:white;cursor:pointer}
    .note{font-size:13px}footer{margin-top:28px;color:#8ca5af;font-size:13px}
    </style><body><header><div class="eyebrow">CARAVEL / AUDIO WORKSHOP</div><h1>Sound sample review</h1>
    <p>Separate layers for wind, water, timber, weather and seabirds. These are source samples for review; they are not yet connected to the sailing simulation.</p>
    ${pending.length?`<p class="note">Not selected: ${pending.map(html).join(', ')}.</p>`:''}
    ${reviewNotes.map(note=>`<p class="note">${html(note)}</p>`).join('')}
    <p class="note">Play one at a time. Ambiences repeat so you can hear the seam. Listening copies share a −6 dBFS peak ceiling; final in-game loudness will follow the simulation.</p>
    <button id="stop">Stop playback</button></header><main>${cards.join('\n')}</main>
    <footer>${cards.length} samples · ${selection?'Selected takes':'Take '+html(take)} · ElevenLabs Sound Effects v2 · Stereo WAV listening copies from 44.1 kHz / 128 kbps MP3 originals · ${totalCredits} source-generation credits<br>Local review only; this page is not deployed.</footer>
    <script>const players=[...document.querySelectorAll('audio')];for(const player of players)player.addEventListener('play',()=>{for(const other of players)if(other!==player)other.pause();});document.getElementById('stop').onclick=()=>{for(const player of players){player.pause();player.currentTime=0;}};</script></body></html>`;
  const file=path.join(out,'index.html');
  await fs.writeFile(file,page);
  await saveJSON(path.join(out,'checks.json'),checks);
  return {file,samples:cards.length,credits:totalCredits};
}

function apiError(status,body) {
  const reason=body?.detail?.status;
  if(reason==='missing_permissions')return 'The API key needs Sound Effects permission.';
  if(reason==='invalid_api_key')return 'ElevenLabs rejected the API key.';
  if(reason==='quota_exceeded')return 'ElevenLabs reports insufficient generation credits.';
  return `ElevenLabs HTTP ${status}. No automatic retry was made.`;
}

export async function generateSound(sample,{key,dir=path.join(ROOT,'.audio/pilot'),take='01',fetchImpl=fetch}={}) {
  const id=safeName(sample.id),name=id+'-'+safeName(take);
  const request=soundRequest(sample);
  const signature=sha256(JSON.stringify({request,format:FORMAT}));
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const recordFile=path.join(dir,name+'.json'),audioFile=path.join(dir,name+'.mp3');
  // Exclusive creation prevents concurrent or repeated runs from buying duplicates.
  let handle;
  try {handle=await fs.open(recordFile,'wx',0o600);}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const old=JSON.parse(await fs.readFile(recordFile,'utf8'));
    if(old.signature!==signature)throw Error('This take uses another prompt; choose a new --take name.');
    if(old.status!=='complete')throw Error('This take is pending or failed. Inspect its local record before requesting another take.');
    const bytes=await fs.readFile(audioFile);
    if(sha256(bytes)!==old.sha256)throw Error('Saved audio checksum differs; no new paid request was sent.');
    return {...old,reused:true,file:audioFile};
  }
  const record={id,take,label:sample.label,driver:sample.driver,provider:'ElevenLabs',
    createdAt:new Date().toISOString(),signature,format:FORMAT,request,status:'pending'};
  try {await handle.writeFile(JSON.stringify(record,null,2)+'\n');}
  finally {await handle.close();}
  let response;
  try {
    response=await fetchImpl(ENDPOINT+'?output_format='+FORMAT,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(120000),headers:{'xi-api-key':key,'Content-Type':'application/json'},body:JSON.stringify(request)});
  } catch {throw Error('Sound request interrupted; billing is uncertain. Pending record retained; no automatic retry.');}
  if(!response.ok){
    const body=await response.json().catch(()=>null);
    const error=apiError(response.status,body);
    await saveJSON(recordFile,{...record,status:'failed',httpStatus:response.status,error});
    throw Error(error);
  }
  // Persist only whitelisted response metadata, never request headers or raw errors.
  const credits=response.headers.get('character-cost');
  record.credits=credits!==null&&Number.isFinite(Number(credits))?Number(credits):null;
  try {
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length<100 || !(bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224)))
      throw Error('Invalid MP3 response.');
    await fs.writeFile(audioFile+'.part',bytes,{mode:0o600});
    await fs.rename(audioFile+'.part',audioFile);
    const complete={...record,status:'complete',bytes:bytes.length,sha256:sha256(bytes)};
    await saveJSON(recordFile,complete);
    return {...complete,reused:false,file:audioFile};
  } catch {throw Error('Audio could not be saved completely. Pending record retained; no automatic retry.');}
}

export async function main(args=process.argv.slice(2)) {
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{take:{type:'string',default:'01'},selected:{type:'boolean'},set:{type:'string'}}});
  const [command='help',id]=positionals;
  if(command==='help'){console.log(HELP);return;}
  if(values.set&&!['pilot','weather','nature','hull','all'].includes(values.set))throw Error('Use --set pilot, weather, nature, hull or all.');
  if(values.set&&!['plan','review'].includes(command))throw Error('--set applies only to plan or review; generate accepts a sample ID.');
  const catalog=values.set==='weather'?WEATHER:values.set==='nature'?NATURE:values.set==='hull'?HULL_CONTACT:values.set==='pilot'?PILOT:values.set==='all'?SAMPLES:undefined;
  if(command==='plan'){
    const planned=catalog??PILOT;
    console.log(JSON.stringify({model:MODEL,format:FORMAT,totalSeconds:planned.reduce((s,x)=>s+x.seconds,0),
      samples:planned.map(x=>({id:x.id,label:x.label,driver:x.driver,...soundRequest(x)}))},null,2));return;
  }
  if(command==='review'){
    const selection=values.selected?JSON.parse(await fs.readFile(new URL('./audio/review-selection.json',import.meta.url),'utf8')):undefined;
    console.log(JSON.stringify(await buildReview({take:values.take,selection,samples:catalog??SAMPLES})));return;
  }
  if(!['generate','pilot','weather','nature','hull'].includes(command))throw Error('Use help, plan, generate, pilot, weather, nature, hull or review.');
  const samples=command==='pilot'?PILOT:command==='weather'?WEATHER:command==='nature'?NATURE:command==='hull'?HULL_CONTACT:SAMPLES.filter(x=>x.id===id);
  if(!samples.length)throw Error('Unknown sample; run plan for available IDs.');
  const key=await resolveAudioKey();
  for(const sample of samples){
    const result=await generateSound(sample,{key,take:values.take});
    console.log(JSON.stringify({id:result.id,reused:result.reused,credits:result.credits,file:result.file}));
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
