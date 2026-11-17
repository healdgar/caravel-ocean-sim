#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The pinned meshoptimizer tools the offline woody LOD bake (scripts/prepare-forest-wood-lods.mjs) loads. That
// script's bytes are pinned in the Saba LOD manifest, so it keeps importing them from here; the middle-mesh
// reduction this file once held went with the retired middle tier.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const DEFAULT_TOOLS='/tmp/waterworld-meshopt-tools/node_modules/meshoptimizer';
const PIN=Object.freeze({version:'1.3.0',packageSHA256:'7c0b926331466962d22ab250359fcdea20c225ab243d78474b955fb6af23f74c',
 simplifierSHA256:'c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed',
 decoderSHA256:'10b313edaa0e322b0c1b46443f6c8b186b42139fe1eca189d50c09511d0ebedc'});
const require=(ok,message)=>{if(!ok)throw Error(message);};
const middleReceipt=raw=>({bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex')});

export async function loadMiddleTools(folder=DEFAULT_TOOLS){
 folder=resolve(folder);
 const [pkg,source,decoder]=await Promise.all(['package.json','meshopt_simplifier.js','meshopt_decoder.mjs'].map(name=>readFile(join(folder,name))));
 require(JSON.parse(pkg).name==='meshoptimizer'&&JSON.parse(pkg).version===PIN.version&&middleReceipt(pkg).sha256===PIN.packageSHA256&&
  middleReceipt(source).sha256===PIN.simplifierSHA256&&middleReceipt(decoder).sha256===PIN.decoderSHA256,'Pinned meshoptimizer1.3.0 bytes differ');
 const [{MeshoptSimplifier:simplifier},{MeshoptDecoder:decode}]=await Promise.all([
  import(pathToFileURL(join(folder,'meshopt_simplifier.js')).href),import(pathToFileURL(join(folder,'meshopt_decoder.mjs')).href)]);
 require(simplifier.supported&&decode.supported,'Pinned meshoptimizer unavailable');await Promise.all([simplifier.ready,decode.ready]);
 return{simplifier,decoder:decode,folder,receipt:{version:PIN.version,package:middleReceipt(pkg),
  simplifier:{file:'meshopt_simplifier.js',...middleReceipt(source)},decoder:{file:'meshopt_decoder.mjs',...middleReceipt(decoder)}}};
}
