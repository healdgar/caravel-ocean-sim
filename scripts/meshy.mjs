#!/usr/bin/env node
// Local authoring tool. Never imported by the game or included in Pages builds.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {readGLB, loadCrewGLB, createSkinAnimator} from '../js/gltf.js';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const ENDPOINT='https://api.meshy.ai/openapi/v2/text-to-3d';
export const IMAGE_ENDPOINT='https://api.meshy.ai/openapi/v1/image-to-3d';
export const REMESH_ENDPOINT='https://api.meshy.ai/openapi/v1/remesh';
export const RIG_ENDPOINT='https://api.meshy.ai/openapi/v1/rigging';
const ENDPOINTS={text:ENDPOINT,image:IMAGE_ENDPOINT,remesh:REMESH_ENDPOINT,rig:RIG_ENDPOINT};
export const MODEL='meshy-7.1';
const PRESETS=JSON.parse(await fs.readFile(new URL('./meshy/crew-presets.json',import.meta.url),'utf8'));
const HELP=`Local Meshy 7.1 crew authoring (Node 20+)

npm run meshy -- configure --key-ref 'op://VAULT/Meshy/api_key'
npm run meshy -- doctor                         Validate credentials, no generation
npm run meshy -- plan male                      Print request, no credentials/network
npm run meshy -- preview male                   Start/resume one paid geometry task
npm run meshy -- preview female
npm run meshy -- image-plan FILE.png --preset female  Inspect image request offline
npm run meshy -- image FILE.png --preset female       Generate textured GLB (paid)
npm run meshy -- status TASK_ID
npm run meshy -- wait TASK_ID --seconds 45       Bounded polling; task keeps running
npm run meshy -- download TASK_ID               Save GLB/maps/thumbnail + checksums
npm run meshy -- refine TASK_ID --preset male    Texture an inspected preview (paid)
npm run meshy -- remesh TASK_ID --polygons 20000 --topology quad  Reduce original (paid)
npm run meshy -- rig TASK_ID --height 1.75       Fit Meshy's skeleton (paid)
npm run meshy -- list --page 1                   Recover remote task IDs
npm run meshy -- inspect FILE.glb               Offline crew compatibility report

Options: --attempt NAME (default 1; change only to deliberately buy another task)
         --prompt-file FILE (preview/plan only), --key-ref op://... (overrides env)
         --kind image|remesh|rig (for tasks without local records)
Credentials: --key-ref, MESHY_API_KEY_REF, MESHY_API_KEY, then local key reference.
Local data: .meshy/ (gitignored). Keys are never saved. No automatic model fallback.
Raw generated models require Blender preparation and crew texture support.
`;

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const idCheck=id=>{if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw Error('Invalid task ID');return id;};
const redact=text=>String(text).replace(/\b(?:msy_|sk-)[A-Za-z0-9_-]+/g,'[redacted]');
export function secretReference(value) {
  if(typeof value!=='string'||!/^op:\/\/[^/\s]+\/[^/]+\/(?:[^/]+\/)?[^/]+$/.test(value)||/[\r\n?]/.test(value))
    throw Error('Use a 1Password secret reference: op://VAULT/ITEM/FIELD (not the key).');
  return value;
}
async function readJSON(file,fallback) {
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
}
async function saveJSON(file,data) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file);
}
export async function resolveKey({env=process.env,keyRef,config={},run=promisify(execFile)}={}) {
  const ref=keyRef??env.MESHY_API_KEY_REF??(!env.MESHY_API_KEY?config.keyRef:undefined);
  let key=env.MESHY_API_KEY;
  if(ref){
    secretReference(ref);
    try {key=(await run('op',['read',ref,'--no-newline'],{timeout:25000,maxBuffer:16384})).stdout;}
    catch {throw Error('Cannot read the Meshy key from 1Password. Unlock 1Password and enable its CLI integration, then retry.');}
  }
  key=key?.trim();
  if(!key)throw Error('No Meshy key configured. Run configure --key-ref op://VAULT/Meshy/api_key.');
  if(/\s/.test(key)||key.startsWith('op://'))throw Error('Invalid API key value; use MESHY_API_KEY_REF for a secret reference.');
  return key;
}
export function previewRequest(preset,prompt) {
  if(!['male','female'].includes(preset))throw Error('Choose preset male or female.');
  prompt=(prompt??PRESETS.shared.prompt+PRESETS[preset].body).trim();
  if(!prompt||[...prompt].length>800)throw Error('Meshy prompts must contain 1–800 characters.');
  return {mode:'preview',model_type:'standard',ai_model:MODEL,prompt,pose_mode:'t-pose',
    should_remesh:false,target_formats:['glb']};
}
export function refineRequest(id,preset) {
  idCheck(id);if(!['male','female'].includes(preset))throw Error('Specify --preset male or female.');
  return {mode:'refine',preview_task_id:id,ai_model:MODEL,enable_pbr:true,texture_resolution:'2k',
    texture_prompt:PRESETS.shared.texture_prompt+PRESETS[preset].texture_appearance,target_formats:['glb']};
}
export function remeshRequest(id,{polygons=20000,topology='quad'}={}) {
  idCheck(id);
  if(!Number.isSafeInteger(polygons)||polygons<100||polygons>300000)throw Error('Polygons must be an integer from 100 to 300000.');
  if(!['quad','triangle'].includes(topology))throw Error('Topology must be quad or triangle.');
  return {input_task_id:id,topology,target_polycount:polygons,target_formats:['glb']};
}
export function rigRequest(id,height=1.7) {
  idCheck(id);if(!Number.isFinite(height)||height<=0)throw Error('Height must be positive meters.');
  return {input_task_id:id,height_meters:height};
}
export async function imageRequest(file,preset) {
  const texture=refineRequest('unused',preset).texture_prompt;
  const ext=path.extname(file).toLowerCase(),mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[ext];
  if(!mime)throw Error('Reference must be PNG, JPEG or WebP.');
  if((await fs.stat(file)).size>20*1024*1024)throw Error('Reference exceeds 20 MiB.');
  const bytes=await fs.readFile(file);
  const valid=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
      bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!valid)throw Error('Reference image header does not match its extension.');
  return {model_type:'standard',ai_model:MODEL,image_url:`data:${mime};base64,${bytes.toString('base64')}`,
    image_enhancement:false,pose_mode:'t-pose',should_remesh:false,should_texture:true,enable_pbr:true,
    texture_resolution:'2k',texture_prompt:texture,target_formats:['glb']};
}
function savedRequest(body) {
  if(!body.image_url?.startsWith('data:'))return body;
  return {...body,image_url:'embedded reference SHA-256: '+hash(Buffer.from(body.image_url.split(',')[1],'base64'))};
}
export function taskSummary(task) {
  const result={};
  for(const key of ['id','type','status','progress','created_at','started_at','finished_at','expires_at','consumed_credits','preceding_tasks'])
    if(task[key]!==undefined)result[key]=task[key];
  // No signed download URLs, credentials, or untrusted error bodies in logs.
  if(task.task_error?.message)result.error=redact(task.task_error.message).slice(0,500);
  return result;
}

export class MeshyClient {
  constructor({key,dir=path.join(ROOT,'.meshy'),fetchImpl=fetch,sleep=delay,kind='text'}={}) {
    if(!Object.hasOwn(ENDPOINTS,kind))throw Error('Task kind must be text, image, remesh or rig.');
    this.key=key;this.dir=dir;this.fetch=fetchImpl;this.sleep=sleep;
    this.kind=kind;this.endpoint=ENDPOINTS[kind];
  }
  async request(method,suffix='',body) {
    let response;
    try {response=await this.fetch(this.endpoint+suffix,{method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+this.key,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});}
    catch {throw Error('Meshy connection failed or timed out. POST requests are never automatically retried.');}
    if(!response.ok){
      const advice={401:'Check the API key.',402:'Meshy API credits are required.',429:'Rate limited; retry later.',404:'Task unavailable or expired.'}[response.status]??'Check Meshy service status and request settings.';
      throw Object.assign(Error(`Meshy HTTP ${response.status}. ${advice}`),{status:response.status});
    }
    try{return await response.json();}catch{throw Error('Meshy returned invalid JSON; recover the task through list before retrying a submission.');}
  }
  async submit(body,{attempt='1',preset,reference}={}) {
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(attempt))throw Error('Attempt must be a short name using letters, digits, - or _.');
    const requestHash=hash(JSON.stringify({body,attempt,...(this.kind!=='text'?{kind:this.kind}:{})})),file=path.join(this.dir,'submissions',requestHash+'.json');
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const record={request:savedRequest(body),kind:this.kind,reference,attempt,preset,submittedAt:new Date().toISOString(),state:'SUBMITTING'};
    try {await fs.writeFile(file,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      // A competing/crashed process can leave a partial reservation; still never replay it.
      let existing;try{existing=await readJSON(file);}catch{}
      if(existing?.id)return {id:idCheck(existing.id),reused:true};
      throw Error(`A matching submission may already be running. Use list to recover its ID before any new attempt. Local record: ${file}`);
    }
    // Keep the reservation on any ambiguous failure; replaying a paid POST can duplicate charges.
    let result;
    try{result=await this.request('POST','',body);}catch(error){
      // A definite input/auth/quota rejection created no task; permit an explicit retry.
      if([400,401,402,404,422,429].includes(error.status))await fs.unlink(file);
      throw error;
    }
    const id=idCheck(result.result);await saveJSON(file,{...record,state:'CREATED',id});
    await saveJSON(path.join(this.dir,'tasks',id,'request.json'),{...record,state:'CREATED',id});
    return {id,reused:false};
  }
  async status(id) {
    idCheck(id);const task=await this.request('GET','/'+id);
    if(task.id!==id)throw Error('Meshy returned a different task ID.');
    if(task.task_error?.message)task.task_error.message=redact(task.task_error.message).split(this.key).join('[redacted]');
    const summary=taskSummary(task);
    await saveJSON(path.join(this.dir,'tasks',id,'task.json'),summary);return task;
  }
  async list(page=1) {
    if(!Number.isSafeInteger(page)||page<1)throw Error('Page must be a positive integer.');
    const tasks=await this.request('GET',`?page_num=${page}&page_size=20&sort_by=-created_at`);
    if(!Array.isArray(tasks))throw Error('Unexpected task list response.');
    return tasks.map(task=>{
      if(task.task_error?.message)task.task_error.message=redact(task.task_error.message).split(this.key).join('[redacted]');
      return {...taskSummary(task),prompt:redact(task.prompt??'').split(this.key).join('[redacted]')};
    });
  }
  async wait(id,{seconds=45,onUpdate=()=>{}}={}) {
    if(!Number.isFinite(seconds)||seconds<0||seconds>3600)throw Error('Wait seconds must be between 0 and 3600.');
    const deadline=Date.now()+seconds*1000;
    for(;;){
      const task=await this.status(id);onUpdate(taskSummary(task));
      if(['SUCCEEDED','FAILED','CANCELED'].includes(task.status))return task;
      if(!['PENDING','IN_PROGRESS'].includes(task.status))throw Error('Unrecognized task status; inspect status before proceeding.');
      if(Date.now()>=deadline)return task;
      await this.sleep(Math.min(5000,deadline-Date.now()));
    }
  }
  async download(id) {
    const task=await this.status(id);
    if(task.status!=='SUCCEEDED')throw Error('Download requires a SUCCEEDED task.');
    const modelURL=task.model_urls?.glb??task.result?.rigged_character_glb_url;
    if(!modelURL)throw Error('Task has no GLB output.');
    const folder=path.join(this.dir,'tasks',id),files=[['model.glb',modelURL]];
    for(const action of ['walking','running']){
      const url=task.result?.basic_animations?.[action+'_glb_url'];
      if(url)files.push([action+'.glb',url]);
    }
    if(task.thumbnail_url)files.push(['thumbnail'+imageExtension(task.thumbnail_url),task.thumbnail_url]);
    for(const [i,maps] of (task.texture_urls??[]).entries())for(const kind of ['base_color','normal','roughness','metallic','emission'])
      if(maps[kind])files.push([`texture-${i}-${kind}${imageExtension(maps[kind])}`,maps[kind]]);
    const manifest=await readJSON(path.join(folder,'downloads.json'),{files:[]});
    for(const [name,url] of files){
      const dest=path.join(folder,name),prior=manifest.files.find(f=>f.name===name);
      if(prior){try{const b=await fs.readFile(dest);if(hash(b)===prior.sha256)continue;}catch(e){if(e.code!=='ENOENT')throw e;}}
      const bytes=await this.asset(url);
      if(name.endsWith('.glb'))readGLB(bytes);
      const tmp=dest+'.part';await fs.writeFile(tmp,bytes,{mode:0o600});await fs.rename(tmp,dest);
      manifest.files=manifest.files.filter(f=>f.name!==name);
      manifest.files.push({name,bytes:bytes.length,sha256:hash(bytes)});
      await saveJSON(path.join(folder,'downloads.json'),manifest);
    }
    return {id,folder,...manifest};
  }
  async asset(value) {
    // Asset requests never carry the API token, including redirects.
    let url=assetURL(value);
    const signal=AbortSignal.timeout(120000);
    for(let redirects=0;redirects<5;redirects++){
      let response;
      try{response=await this.fetch(url,{redirect:'manual',signal});}catch{throw Error('Asset download failed; rerun download to refresh URLs and resume.');}
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');if(!location)throw Error('Missing asset redirect location.');
        url=assetURL(new URL(location,url).href);await response.body?.cancel();continue;
      }
      if(!response.ok)throw Error(`Asset HTTP ${response.status}; rerun download to refresh URLs.`);
      const limit=400*1024*1024;
      if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Asset exceeds 400 MiB.');}
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Asset exceeds 400 MiB.');chunks.push(Buffer.from(chunk));}
      return Buffer.concat(chunks);
    }
    throw Error('Too many asset redirects.');
  }
}
function assetURL(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!(u.hostname==='meshy.ai'||u.hostname.endsWith('.meshy.ai')))
    throw Error('Unexpected asset host; review the Meshy response before downloading.');
  return u.href;
}
function imageExtension(url) {
  const ext=path.extname(new URL(url).pathname).toLowerCase();
  if(!['.png','.jpg','.jpeg','.webp'].includes(ext))throw Error('Unsupported texture/thumbnail extension.');
  return ext;
}
export async function inspectCrew(file) {
  const bytes=await fs.readFile(file),asset=readGLB(bytes),g=asset.json;
  let vertices=0,triangles=0;
  for(const mesh of g.meshes??[])for(const p of mesh.primitives){
    vertices+=g.accessors[p.attributes.POSITION].count;
    if((p.mode??4)===4)triangles+=(p.indices===undefined?g.accessors[p.attributes.POSITION].count:g.accessors[p.indices].count)/3;
  }
  const result={file:path.resolve(file),bytes:bytes.length,vertices,triangles,textures:g.textures?.length??0,
    joints:g.skins?.[0]?.joints?.length??0,clips:(g.animations??[]).map(a=>a.name),
    withinRecommendedBudget:triangles<=20000&&vertices<=25000,loaderCompatible:false,matchingRigTemplates:[],visualReviewRequired:true};
  try{loadCrewGLB(bytes);result.loaderCompatible=true;}catch(e){result.loaderError=e.message;}
  let a;
  try{a=createSkinAnimator(asset);}catch(e){result.rigError=e.message;}
  if(a){
    a.sample(null,0);
    for(const sex of ['male','female']){
      const template=loadCrewGLB(await fs.readFile(path.join(ROOT,'assets/crew',sex==='male'?'sailor.glb':'sailor-female.glb'))).animator;
      template.sample(null,0);
      const match=a.joints.length===65&&a.joints.every((node,i)=>{
        const other=template.joints[i];
        return a.names[node]===template.names[other]&&a.names[a.parent[node]]===template.names[template.parent[other]]&&
          a.world[node].every((v,j)=>Math.abs(v-template.world[other][j])<.0002)&&
          a.palette.subarray(i*16,i*16+16).every((v,j)=>Math.abs(v-template.palette[i*16+j])<.0002);
      });
      if(match)result.matchingRigTemplates.push(sex);
    }
  }
  result.structuralMatch=result.loaderCompatible&&result.matchingRigTemplates.length>0&&['Idle','Walk','Brace'].every(n=>result.clips.includes(n));
  return result;
}

export async function main(args=process.argv.slice(2)) {
  const {positionals,values}=parseArgs({args,allowPositionals:true,options:{help:{type:'boolean',short:'h'},
    'key-ref':{type:'string'},preset:{type:'string'},attempt:{type:'string'},'prompt-file':{type:'string'},
    seconds:{type:'string'},page:{type:'string'},kind:{type:'string'},polygons:{type:'string'},topology:{type:'string'},height:{type:'string'}}});
  const [command,arg]=positionals;
  if(!command||command==='help'||values.help){console.log(HELP);return;}
  const commands={configure:[],doctor:[],plan:['preset'],preview:['preset'],'image-plan':['file'],image:['file'],refine:['id'],remesh:['id'],rig:['id'],status:['id'],wait:['id'],download:['id'],list:[],inspect:['file']};
  if(!Object.hasOwn(commands,command)||positionals.length!==commands[command].length+1)throw Error('Invalid command or arguments. Use --help.');
  const allowed={configure:['key-ref'],doctor:['key-ref'],plan:['prompt-file'],preview:['key-ref','attempt','prompt-file'],
    'image-plan':['preset'],image:['key-ref','attempt','preset'],refine:['key-ref','attempt','preset'],remesh:['key-ref','attempt','polygons','topology'],rig:['key-ref','attempt','height'],status:['key-ref','kind'],wait:['key-ref','seconds','kind'],download:['key-ref','kind'],list:['key-ref','page','kind'],inspect:[]};
  for(const name of Object.keys(values))if(!allowed[command].includes(name))throw Error(`--${name} is not valid for ${command}.`);
  const dir=path.join(ROOT,'.meshy'),configPath=path.join(dir,'config.json');
  const print=value=>console.log(JSON.stringify(value,null,2));
  if(command==='configure'){await saveJSON(configPath,{keyRef:secretReference(values['key-ref'])});print({configured:true,credentialsSaved:false});return;}
  if(command==='inspect'){print(await inspectCrew(arg));return;}
  let body;
  if(command==='plan'||command==='preview')body=previewRequest(arg,values['prompt-file']?await fs.readFile(values['prompt-file'],'utf8'):undefined);
  if(command==='plan'){print(body);return;}
  if(command==='image'||command==='image-plan')body=await imageRequest(arg,values.preset);
  if(command==='image-plan'){print(savedRequest(body));return;}
  if(command==='refine')body=refineRequest(arg,values.preset);
  if(command==='remesh')body=remeshRequest(arg,{polygons:values.polygons===undefined?20000:Number(values.polygons),topology:values.topology??'quad'});
  if(command==='rig')body=rigRequest(arg,values.height===undefined?1.7:Number(values.height));
  if(['status','wait','download','refine'].includes(command))idCheck(arg);
  const key=await resolveKey({keyRef:values['key-ref'],config:await readJSON(configPath,{})});
  const stored=['status','wait','download'].includes(command)?await readJSON(path.join(dir,'tasks',arg,'request.json'),{}):{};
  const kind=['image','remesh','rig'].includes(command)?command:values.kind??stored.kind??'text';
  const client=new MeshyClient({key,dir,kind});
  if(command==='doctor'){await client.request('GET','?page_size=1');print({authenticated:true,model:MODEL});}
  if(command==='preview')print(await client.submit(body,{attempt:values.attempt,preset:arg}));
  if(command==='image')print(await client.submit(body,{attempt:values.attempt,preset:values.preset,reference:path.resolve(arg)}));
  if(['remesh','rig'].includes(command))print(await client.submit(body,{attempt:values.attempt}));
  if(command==='refine'){
    const preview=await client.status(arg);
    if(preview.status!=='SUCCEEDED'||preview.type!=='text-to-3d-preview')throw Error('Refine requires a successful text-to-3D preview.');
    print(await client.submit(body,{attempt:values.attempt,preset:values.preset}));
  }
  if(command==='status')print(taskSummary(await client.status(arg)));
  if(command==='list')print(await client.list(values.page===undefined?1:Number(values.page)));
  if(command==='download')print(await client.download(arg));
  if(command==='wait'){
    let last='';const task=await client.wait(arg,{seconds:values.seconds===undefined?45:Number(values.seconds),onUpdate:s=>{
      const line=JSON.stringify(s);if(line!==last){console.log(line);last=line;}
    }});
    if(['FAILED','CANCELED'].includes(task.status))process.exitCode=1;
    else if(task.status!=='SUCCEEDED')print({waitingStopped:true,remoteTaskContinues:true,id:arg});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error(redact(error.message));process.exitCode=1;});
}
