#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Exact byte-preserving offline transport. No mesh reordering or lossy filters.
import {readFile,writeFile,mkdir,rename,access,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

const massTransportReceipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
const massTransportCheck=(ok,message)=>{if(!ok)throw Error(message);};
export async function compressForestMass({pack,output,meshoptimizer}){
 pack=resolve(pack);output=resolve(output);meshoptimizer=resolve(meshoptimizer);
 try{await access(output);throw Error('Fresh transport output required');}catch(e){if(e.code!=='ENOENT')throw e;}
 const version=JSON.parse(await readFile(join(meshoptimizer,'package.json'),'utf8'));
 massTransportCheck(version.name==='meshoptimizer'&&version.version==='1.3.0','Pinned meshoptimizer1.3.0 authoring tool required');
 const {MeshoptEncoder}=await import(pathToFileURL(join(meshoptimizer,'meshopt_encoder.js')).href);
 const {MeshoptDecoder}=await import(pathToFileURL(join(meshoptimizer,'meshopt_decoder.mjs')).href);
 await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
 const source=await readFile(join(pack,'manifest.json')),manifest=JSON.parse(source),temporary=output+'.packing-'+randomUUID();
 massTransportCheck(manifest.format==='waterworld.native-forest-mass'&&manifest.version===2,'Expected compact native mass');
 await mkdir(temporary,{recursive:true});
 for(const [name,item]of Object.entries(manifest.files)){
  massTransportCheck(item.gzip.file===name+'.gz'&&!name.includes('/'),'Unsafe transport source');
  const compressed=await readFile(join(pack,item.gzip.file));
  massTransportCheck(JSON.stringify(massTransportReceipt(compressed))===JSON.stringify({bytes:item.gzip.bytes,sha256:item.gzip.sha256}),'Source compressed hash differs');
  const raw=gunzipSync(compressed);
  massTransportCheck(JSON.stringify(massTransportReceipt(raw))===JSON.stringify({bytes:item.bytes,sha256:item.sha256}),'Source decoded hash differs');
  let encoded=raw;
  if(name.endsWith('vertices.bin')||name.endsWith('indices.bin')){
   const vertex=name.endsWith('vertices.bin'),stride=vertex?(name==='vertices.bin'?24:52):4,count=raw.byteLength/stride;
   massTransportCheck(Number.isSafeInteger(count)&&count>0,'Invalid authoring stream shape');
   encoded=vertex?MeshoptEncoder.encodeVertexBuffer(raw,count,stride):MeshoptEncoder.encodeIndexSequence(raw,count,stride);
   const decoded=new Uint8Array(raw.byteLength),mode=vertex?'ATTRIBUTES':'INDICES';
   MeshoptDecoder.decodeGltfBuffer(decoded,count,stride,encoded,mode);
   massTransportCheck(Buffer.from(decoded).equals(raw),'LOSSLESS codec roundtrip differs: '+name);
   item.meshopt={mode,count,stride,...massTransportReceipt(encoded)};
  }
  const transport=gzipSync(encoded,{level:9});
  massTransportCheck(transport.byteLength<100*1024*1024,'Runtime file exceeds GitHub asset limit');
  await writeFile(join(temporary,item.gzip.file),transport);item.gzip={file:item.gzip.file,...massTransportReceipt(transport)};
  console.log(JSON.stringify({stream:name,raw:raw.byteLength,oldGzip:compressed.byteLength,meshopt:encoded.byteLength,gzip:transport.byteLength}));
 }
 manifest.source.transport={file:'scripts/compress-forest-mass.mjs',...massTransportReceipt(await readFile(fileURLToPath(import.meta.url))),
  originalManifest:massTransportReceipt(source),codec:{name:'meshoptimizer',version:version.version,encoder:massTransportReceipt(await readFile(join(meshoptimizer,'meshopt_encoder.js'))),
   decoder:massTransportReceipt(await readFile(join(meshoptimizer,'meshopt_decoder.mjs')))},
  scope:'Byte-exact attributes and index sequences, then deterministic gzip. No filters, index/vertex reordering or geometric change.'};
 await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 massTransportCheck((await readFile(join(pack,'manifest.json'))).equals(source),'Mass source changed during packing');
 await rename(temporary,output);return manifest;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const options={};for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i];massTransportCheck(['--pack','--output','--meshoptimizer'].includes(name)&&process.argv[i+1],'Expected --pack --output --meshoptimizer');options[name.slice(2)]=process.argv[i+1];}
 compressForestMass(options).catch(e=>{console.error(e.stack);process.exitCode=1;});
}
