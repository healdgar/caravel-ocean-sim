#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Lossless packaging only: no growth, meshing, rendering or image conversion.
import {createHash} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {gzipSync,gunzipSync} from 'node:zlib';

const MAX_FILE_BYTES=512*1024*1024;
const GEOMETRY=['vertices.bin','indices.bin','roots.bin'];
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const receipt=raw=>({bytes:raw.byteLength,sha256:sha(raw)});
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

function relativeName(name){
  requireValue(typeof name==='string'&&name.length>0&&name.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)&&part!=='.'&&part!=='..'),'Unsafe asset filename: '+name);
  return name;
}
function verify(raw,expected,label){
  requireValue(Number.isSafeInteger(expected?.bytes)&&expected.bytes>=0&&expected.bytes<=MAX_FILE_BYTES&&/^[a-f0-9]{64}$/.test(expected.sha256),'Invalid receipt: '+label);
  requireValue(raw.byteLength===expected.bytes&&sha(raw)===expected.sha256,'Receipt mismatch: '+label);
}
async function input(argument){
  const path=resolve(argument),manifestPath=(await stat(path)).isDirectory()?join(path,'manifest.json'):path;
  const raw=await readFile(manifestPath);requireValue(raw.byteLength<=MAX_FILE_BYTES,'Oversized source manifest');
  return {folder:dirname(manifestPath),manifestPath,raw,manifest:JSON.parse(raw.toString('utf8'))};
}
async function decodedFile(folder,item,label){
  const filename=relativeName(item.file??label);
  if(item.gzip){
    const compressed=await readFile(join(folder,relativeName(item.gzip.file)));verify(compressed,item.gzip,label+' gzip');
    const decoded=gunzipSync(compressed,{maxOutputLength:item.bytes});verify(decoded,item,label+' decoded');
    if(await exists(join(folder,filename))){const original=await readFile(join(folder,filename));verify(original,item,label+' original');requireValue(original.equals(decoded),'Compressed/original disagreement: '+label);}
    return decoded;
  }
  const raw=await readFile(join(folder,filename));verify(raw,item,label);return raw;
}
export function deterministicGzip(raw){
  const zipped=gzipSync(raw,{level:9,mtime:0});
  // No filename/time/platform metadata: canonical transport across hosts.
  requireValue(zipped[3]===0,'Unexpected gzip metadata');zipped.fill(0,4,8);zipped[9]=255;
  requireValue(gunzipSync(zipped,{maxOutputLength:raw.byteLength}).equals(raw),'Gzip changed source bytes');
  return zipped;
}

export async function packageForestRuntime({pack,atlases,output}){
  requireValue(pack&&atlases&&output,'Required: --pack --atlases --output');
  const target=resolve(output);requireValue(!await exists(target),'Output already exists; choose a fresh directory');
  const forest=await input(pack),atlas=await input(atlases),m=forest.manifest,a=atlas.manifest;
  requireValue(m.format==='waterworld.forest-instances'&&m.version===2&&m.vertexStride===56&&m.rootStride===48&&m.materialContract==='gene-surfaces-v3','Expected native v2/56B forest pack');
  requireValue(Array.isArray(m.prototypes)&&m.prototypes.length>0&&m.prototypes.length<=32&&m.files,'Missing forest prototypes/files');
  requireValue(a.format==='waterworld.native-impostors'&&a.version===1&&a.complete===true&&a.units==='metres'&&a.upAxis==='Y','Expected complete native impostor atlas bundle');
  verify(forest.raw,a.source?.manifest,'Atlas source forest manifest');
  const sourceFiles=new Map();
  for(const [name,item]of Object.entries(m.files))sourceFiles.set(relativeName(name),await decodedFile(forest.folder,{...item,file:name},name));
  for(const name of GEOMETRY)requireValue(sourceFiles.has(name),'Missing source geometry: '+name);
  requireValue(sourceFiles.get('vertices.bin').byteLength%56===0&&sourceFiles.get('indices.bin').byteLength%4===0&&sourceFiles.get('roots.bin').byteLength===m.rootCount*48,'Incomplete source geometry');
  for(const [name,item]of Object.entries(a.source.files??{})){
    requireValue(sourceFiles.has(name),'Atlas source file absent from native forest: '+name);verify(sourceFiles.get(name),item,'Atlas source '+name);
  }
  requireValue(Array.isArray(a.prototypes)&&a.prototypes.length===m.prototypes.length,'Partial atlas prototype set');
  const seen=new Set();
  for(const p of m.prototypes){
    requireValue(Array.isArray(p.nativeMaterials)&&p.nativeMaterials.length>0,'Native material table missing');
    for(const material of p.nativeMaterials)for(const key of ['albedo','normal','roughnessMap']){
      const image=material[key];if(!image){requireValue(key==='roughnessMap','Native source map missing');continue;}
      requireValue(sourceFiles.has(image.file),'Native map absent from pack: '+image.file);verify(sourceFiles.get(image.file),image,'Native '+image.file);
      requireValue(a.source.files?.[image.file]?.sha256===image.sha256&&a.source.files[image.file].bytes===image.bytes,'Atlas did not use this exact native map: '+image.file);
    }
    const baked=a.prototypes.find(item=>item.id===p.id);
    requireValue(baked&&!seen.has(p.id)&&baked.species===p.species,'Atlas prototype identity mismatch');seen.add(p.id);
    requireValue(isDeepStrictEqual(baked.source,p.source)&&isDeepStrictEqual(baked.nativeMaterials,p.nativeMaterials),'Atlas native source/materials differ: '+p.species);
    requireValue(isDeepStrictEqual(baked.detailedGeometry?.wood,p.wood)&&isDeepStrictEqual(baked.detailedGeometry?.leaf,p.leaf),'Atlas detailed geometry ranges differ: '+p.species);
  }
  const pixels=a.layout?.atlasPixels;
  requireValue(Array.isArray(pixels)&&pixels.length===2&&pixels.every(value=>Number.isSafeInteger(value)&&value>0&&value<=4096),'Invalid atlas dimensions');
  const atlasBytes=pixels[0]*pixels[1]*8,atlasFiles=[];
  for(const p of a.prototypes){
    requireValue(p.outputs&&p.outputs.albedo&&p.outputs.normalDepth,'Missing normative atlas outputs');
    for(const [kind,item]of Object.entries(p.outputs)){
      requireValue(['albedo','normalDepth','albedoPNG','preview'].includes(kind),'Unknown atlas output: '+kind);
      const raw=await decodedFile(atlas.folder,item,'Atlas '+item.file);
      if(kind==='albedo'||kind==='normalDepth')requireValue(raw.byteLength===atlasBytes,'Incomplete RGBA16F atlas');
      else requireValue(raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Inspection asset is not PNG');
      atlasFiles.push({item,raw,compressed:kind==='albedo'||kind==='normalDepth'});
    }
  }
  await mkdir(dirname(target),{recursive:true});
  const staging=await mkdtemp(join(dirname(target),'.'+basename(target)+'-staging-')),written=new Map(),compressed=[];
  async function emit(name,raw){
    relativeName(name);requireValue(!written.has(name),'Duplicate output filename: '+name);
    await mkdir(dirname(join(staging,name)),{recursive:true});await writeFile(join(staging,name),raw,{flag:'wx'});
    written.set(name,receipt(raw));
  }
  async function emitGzip(name,raw,original){
    const file=name+'.gz',zipped=deterministicGzip(raw);await emit(file,zipped);
    const item={file,...receipt(zipped)};compressed.push({file,original});return item;
  }
  try{
    const runtime=structuredClone(m),runtimeAtlas=structuredClone(a);
    for(const [name,raw]of sourceFiles){
      if(GEOMETRY.includes(name))runtime.files[name].gzip=await emitGzip(name,raw,m.files[name]);
      else{delete runtime.files[name].gzip;await emit(name,raw);}
    }
    let next=0;
    for(const p of runtimeAtlas.prototypes)for(const item of Object.values(p.outputs)){
      const source=atlasFiles[next++];
      if(source.compressed){
        const transport=await emitGzip('impostors/'+item.file,source.raw,item);
        item.gzip={...transport,file:transport.file.slice('impostors/'.length),uncompressedSHA256:item.sha256};
      }else{delete item.gzip;await emit('impostors/'+item.file,source.raw);}
    }
    runtimeAtlas.runtimePackaging={format:'waterworld.lossless-runtime',version:1,sourceManifest:receipt(atlas.raw),
      rawRGBA16FFilesOmitted:true,gzipMetadata:'level9;mtime0;no filename;OS255',imageConversion:false};
    const atlasRaw=Buffer.from(JSON.stringify(runtimeAtlas,null,2)+'\n');await emit('impostors/manifest.json',atlasRaw);
    // Preserve the original authoring contract separately, without claiming its
    // omitted raw atlas paths are runtime fetches.
    await emit('source-impostor-manifest.json',atlas.raw);
    runtime.impostors={file:'impostors/manifest.json',...receipt(atlasRaw)};
    runtime.runtimePackaging={format:'waterworld.lossless-runtime',version:1,sourceManifest:receipt(forest.raw),
      sourceAtlasManifest:receipt(atlas.raw),geometry:'Original decoded bytes and hashes unchanged; no geometry conversion',
      rawGeometryFilesOmitted:true,gzipMetadata:'level9;mtime0;no filename;OS255',nativeImages:'Original PNG bytes unchanged'};
    runtime.files['source-impostor-manifest.json']=receipt(atlas.raw);
    await emit('source-forest-manifest.json',forest.raw);runtime.files['source-forest-manifest.json']=receipt(forest.raw);
    const manifestRaw=Buffer.from(JSON.stringify(runtime,null,2)+'\n');await emit('manifest.json',manifestRaw);
    for(const [name,item]of written)verify(await readFile(join(staging,name)),item,'Emitted '+name);
    for(const item of compressed){
      const decoded=gunzipSync(await readFile(join(staging,item.file)),{maxOutputLength:item.original.bytes});verify(decoded,item.original,'Emitted decoded '+item.file);
    }
    verify(await readFile(forest.manifestPath),receipt(forest.raw),'Unchanged source forest manifest');
    verify(await readFile(atlas.manifestPath),receipt(atlas.raw),'Unchanged source atlas manifest');
    requireValue(!await exists(target),'Output appeared during packaging; refusing replacement');
    await rename(staging,target);
    return {output:target,files:written.size,storedBytes:[...written.values()].reduce((total,item)=>total+item.bytes,0),
      rawGeometryBytes:GEOMETRY.reduce((total,name)=>total+m.files[name].bytes,0),manifest:receipt(manifestRaw),impostors:runtime.impostors};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}

export function parseArguments(argv){
  const result={},keys={'--pack':'pack','--atlases':'atlases','--output':'output'};
  for(let i=0;i<argv.length;i++){
    const key=keys[argv[i]];requireValue(key&&i+1<argv.length&&!argv[i+1].startsWith('--')&&!result[key],'Unknown/repeated/incomplete argument: '+argv[i]);result[key]=argv[++i];
  }
  requireValue(result.pack&&result.atlases&&result.output,'Required: --pack --atlases --output');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  packageForestRuntime(parseArguments(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
