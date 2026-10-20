#!/usr/bin/env node
// Local ElevenLabs voice authoring. API keys never enter manifests or the game.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolveAudioKey,generateSound} from './audio.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const LOCAL=path.join(ROOT,'.audio/voices');
export const CAST=JSON.parse(await fs.readFile(new URL('./audio/voices.json',import.meta.url),'utf8'));
export const ANCHOR_SOUNDS=JSON.parse(await fs.readFile(new URL('./audio/anchor.json',import.meta.url),'utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const safe=x=>{if(!/^[a-z0-9][a-z0-9-]{0,70}$/.test(x))throw Error('Invalid local voice asset name.');return x;};
const mp3=bytes=>bytes.length>100&&(bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224));

export function speechRequest(text,{seed=1492}={}){
  if(typeof text!=='string'||!text.trim()||text.length>1000)throw Error('Speech must contain 1–1000 characters.');
  return {text,model_id:CAST.model,language_code:'en',seed,voice_settings:{stability:.5,similarity_boost:.8,style:0,use_speaker_boost:true,speed:1}};
}

// An exclusive request journal makes every paid operation resumable. Uncertain
// operations are never automatically repeated. A new take requires a new name.
export async function paidRequest(id,route,request,{key,dir=LOCAL,fetchImpl=fetch,audio=false}={}){
  safe(id);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,id+'.json'),signature=hash(JSON.stringify({route,request}));let handle;
  try{handle=await fs.open(file,'wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    const old=JSON.parse(await fs.readFile(file,'utf8'));
    if(old.signature!==signature)throw Error('Saved request differs; use a new explicit take.');
    if(old.status!=='complete')throw Error('Request pending or failed; inspect its journal before a new take.');
    if(audio&&hash(await fs.readFile(path.join(dir,id+'.mp3')))!==old.sha256)throw Error('Saved audio checksum differs.');
    return {...old,reused:true};
  }
  const record={id,route,request,signature,createdAt:new Date().toISOString(),status:'pending'};
  try{await handle.writeFile(JSON.stringify(record,null,2)+'\n');}finally{await handle.close();}
  let response;
  try{response=await fetchImpl('https://api.elevenlabs.io'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),headers:{'xi-api-key':key,'Content-Type':'application/json'},body:JSON.stringify(request)});}
  catch{throw Error('Voice request interrupted; billing uncertain. Journal retained; no retry.');}
  if(!response.ok){
    const detail=(await response.json().catch(()=>null))?.detail;
    const reason=typeof detail?.status==='string'?detail.status.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80):undefined;
    const message=typeof detail?.message==='string'?detail.message.replaceAll(key,'[redacted]').slice(0,800):undefined;
    await save(file,{...record,status:'failed',httpStatus:response.status,reason,message});
    throw Error(`ElevenLabs HTTP ${response.status}${reason?' ('+reason+')':''}${message?': '+message:''}; no retry.`);
  }
  record.requestId=response.headers.get('request-id');
  record.historyId=response.headers.get('history-item-id');
  record.credits=response.headers.has('character-cost')?Number(response.headers.get('character-cost')):null;
  if(audio){
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!mp3(bytes))throw Error('Invalid MP3; request journal remains pending.');
    await fs.writeFile(path.join(dir,id+'.mp3.part'),bytes,{mode:0o600});
    await fs.rename(path.join(dir,id+'.mp3.part'),path.join(dir,id+'.mp3'));
    record.sha256=hash(bytes);record.bytes=bytes.length;
  }else record.result=await response.json();
  record.status='complete';await save(file,record);return {...record,reused:false};
}

async function design(key,take='01'){
  safe(take);
  const request={model_id:'eleven_ttv_v3',voice_description:CAST.captain.description,text:CAST.captain.preview,seed:1492,guidance_scale:5,loudness:.3};
  const r=await paidRequest('captain-design-'+take,'/v1/text-to-voice/design?output_format=mp3_44100_128',request,{key});
  await save(path.join(LOCAL,'captain-selected-design.json'),{id:r.id});
  for(let i=0;i<r.result.previews.length;i++){
    const bytes=Buffer.from(r.result.previews[i].audio_base_64,'base64');
    if(!mp3(bytes))throw Error('Invalid voice preview.');
    await fs.writeFile(path.join(LOCAL,`captain-preview-${i+1}.mp3`),bytes,{mode:0o600});
  }
  console.log(JSON.stringify({id:r.id,reused:r.reused,previews:r.result.previews.map((p,i)=>({preview:i+1,id:p.generated_voice_id,seconds:p.duration_secs})),credits:r.credits}));
}
async function createCaptain(key,index){
  if(!Number.isInteger(index)||index<1||index>3)throw Error('Choose preview 1, 2 or 3.');
  const selected=JSON.parse(await fs.readFile(path.join(LOCAL,'captain-selected-design.json'),'utf8'));
  const design=JSON.parse(await fs.readFile(path.join(LOCAL,selected.id+'.json'),'utf8'));
  const preview=design.result?.previews?.[index-1];if(!preview)throw Error('No saved preview.');
  const r=await paidRequest('captain-created-01','/v1/text-to-voice',{voice_name:'Caravel - Captain Trevenen - Cornish',voice_description:CAST.captain.description,generated_voice_id:preview.generated_voice_id,labels:{project:'caravel-ocean-sim',accent:'cornish',gender:'male'}},{key});
  console.log(JSON.stringify({id:r.id,reused:r.reused,voiceId:r.result.voice_id,name:r.result.name}));
}
async function generateCrew(key,take='01',ids){
  safe(take);
  for(const person of CAST.crew.filter(p=>!ids||ids.split(',').includes(p.id))){
    const r=await paidRequest('crew-'+person.id+'-'+take,`/v1/text-to-speech/${person.voiceId}?output_format=mp3_44100_128`,speechRequest(take==='01'?'[shouts] Aye captain!':'Aye, captain!',{seed:1492+CAST.crew.indexOf(person)+(take==='01'?0:100)}),{key,audio:true});
    console.log(JSON.stringify({id:r.id,reused:r.reused,credits:r.credits}));
  }
}
async function generateOrders(key){
  const voice=JSON.parse(await fs.readFile(path.join(LOCAL,'captain-created-01.json'),'utf8')).result.voice_id;
  for(const order of CAST.captain.orders){
    const r=await paidRequest('captain-'+order.id+'-01',`/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,speechRequest(order.text),{key,audio:true});
    console.log(JSON.stringify({id:r.id,reused:r.reused,credits:r.credits}));
  }
}
async function promote(){
  const dir=path.join(ROOT,'assets/audio/voices');await fs.mkdir(dir,{recursive:true});
  const assets={},provenance=[];
  const selection=JSON.parse(await fs.readFile(path.join(ROOT,'scripts/audio/voice-selection.json'),'utf8'));
  const captainId=JSON.parse(await fs.readFile(path.join(LOCAL,'captain-created-01.json'),'utf8')).result.voice_id;
  const items=[...CAST.crew.map(p=>({id:'crew-'+p.id,person:p,voiceId:p.voiceId})),...CAST.captain.orders.map(o=>({id:'captain-'+o.id,text:o.text,voiceId:captainId}))];
  for(const item of items){
    const take=item.person?selection.crew[item.person.id]??'01':'01';
    const source=path.join(LOCAL,item.id+'-'+take+'.mp3'),record=JSON.parse(await fs.readFile(path.join(LOCAL,item.id+'-'+take+'.json'),'utf8'));
    if(record.status!=='complete'||record.sha256!==hash(await fs.readFile(source)))throw Error('Incomplete or modified source: '+item.id);
    const output=path.join(dir,item.id+'.mp3');
    const cleanup=item.person?.id==='maria'?'highpass=f=80,afftdn=nr=5:nf=-48,':'highpass=f=80,';
    execFileSync('ffmpeg',['-v','error','-y','-i',source,'-map_metadata','-1','-af',cleanup+'loudnorm=I=-19:TP=-3:LRA=7','-ac','1','-ar','44100','-c:a','libmp3lame','-q:a','4',output]);
    const seconds=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',output],{encoding:'utf8'}).trim());
    const bytes=await fs.readFile(output);assets[item.id]={url:'assets/audio/voices/'+item.id+'.mp3',seconds,loop:false};
    provenance.push({id:item.id,take,name:item.person?.name??CAST.captain.name,sex:item.person?.sex??'male',provider:'ElevenLabs',model:CAST.model,voiceId:item.voiceId,sourceVoice:item.person?.sourceVoice??'Original voice design',text:item.text??'Aye captain!',cleanup,sha256:hash(bytes),bytes:bytes.length,seconds});
  }
  for(const sound of ANCHOR_SOUNDS){
    const take=selection.anchor[sound.id]??'01';
    const source=path.join(ROOT,'.audio/anchor',sound.id+'-'+take+'.mp3'),record=JSON.parse(await fs.readFile(path.join(ROOT,'.audio/anchor',sound.id+'-'+take+'.json'),'utf8'));
    if(record.status!=='complete'||record.sha256!==hash(await fs.readFile(source)))throw Error('Incomplete sound: '+sound.id);
    const output=path.join(dir,sound.id+'.mp3');
    execFileSync('ffmpeg',['-v','error','-y','-i',source,'-map_metadata','-1','-af','loudnorm=I=-22:TP=-4:LRA=7','-ac','1','-c:a','libmp3lame','-q:a','4',output]);
    const seconds=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',output],{encoding:'utf8'}).trim()),bytes=await fs.readFile(output);
    assets[sound.id]={url:'assets/audio/voices/'+sound.id+'.mp3',seconds,loop:sound.loop};
    provenance.push({id:sound.id,provider:'ElevenLabs',model:'eleven_text_to_sound_v2',prompt:sound.prompt,sha256:hash(bytes),bytes:bytes.length,seconds});
  }
  await fs.writeFile(path.join(ROOT,'js/voice-assets.js'),'// Offline authored audio; no ElevenLabs requests run in the game.\nexport const VOICE_ASSETS = '+JSON.stringify(assets,null,2)+';\nexport const CREW_VOICES = '+JSON.stringify(CAST.crew.map(({id,name,sex})=>({id,name,sex})),null,2)+';\n');
  await fs.writeFile(path.join(dir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
  console.log(JSON.stringify({promoted:provenance.length,bytes:provenance.reduce((n,p)=>n+p.bytes,0)}));
}
export async function main(args=process.argv.slice(2)){
  const [command,index,ids]=args;
  if(!command||command==='help'){
    console.log('Local ElevenLabs voice authoring\n\nnode scripts/voices.mjs plan\nnode scripts/voices.mjs design <take>\nnode scripts/voices.mjs create <preview 1..3>\nnode scripts/voices.mjs crew [take] [comma-separated crew IDs]\nnode scripts/voices.mjs orders\nnode scripts/voices.mjs anchor [take] [comma-separated sound IDs]\nnode scripts/voices.mjs promote\n\nDesign/crew/orders/anchor are paid, journaled operations; no automatic retries.\nKeys come from ignored .env.local. The game uses only promoted local MP3s.\nChoose audition previews using direct listening review, then create once.\nSelected takes live in scripts/audio/voice-selection.json.');return;
  }
  if(command==='plan'){console.log(JSON.stringify(CAST,null,2));return;}
  if(command==='promote'){await promote();return;}
  const key=await resolveAudioKey();
  if(command==='design')await design(key,index);
  else if(command==='create')await createCaptain(key,Number(index));
  else if(command==='crew')await generateCrew(key,index,ids);
  else if(command==='orders')await generateOrders(key);
  else if(command==='anchor')for(const sound of ANCHOR_SOUNDS.filter(s=>!ids||ids.split(',').includes(s.id))){const r=await generateSound(sound,{key,take:index??'01',dir:path.join(ROOT,'.audio/anchor')});console.log(JSON.stringify({id:r.id,reused:r.reused,credits:r.credits}));}
  else throw Error('Use plan, design, create <preview>, crew, orders, anchor or promote.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
