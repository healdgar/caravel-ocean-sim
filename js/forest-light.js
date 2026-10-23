// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Immutable own-canopy exposure from original native leaf-area fields. This is
// static local occlusion, not inter-tree, moving-sun or terrain shadowing.
export const FOREST_LIGHT_ASSETS=Object.freeze({
 'canopy-shade.json':'assets/forest-scenery/saba/canopy-shade.json',
 'canopy-shade.bin.gz':'assets/forest-scenery/saba/canopy-shade.bin.gz',
});
const forestLightMaxBytes=256*1024*1024;
const forestLightUint=value=>Number.isSafeInteger(value)&&value>=0;
const forestLightReceipt=value=>forestLightUint(value?.bytes)&&value.bytes>0&&value.bytes<=forestLightMaxBytes&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);
const forestLightSameReceipt=(a,b)=>forestLightReceipt(a)&&forestLightReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;
const forestLightPadded=count=>Math.ceil(count/4)*4;

function forestLightValidate(document,forest){
 const source=document?.source,item=document?.files?.['canopy-shade.bin'],count=document?.vertexCount;
 if(document?.format!=='waterworld.native-canopy-light'||document.version!==1||!forestLightUint(count)||count===0||count>0xffffffff||
  ![52,56].includes(forest?.vertexStride)||!forestLightReceipt(forest?.files?.['vertices.bin'])||count!==forest.files['vertices.bin'].bytes/forest.vertexStride||
  !forestLightReceipt(item)||item.bytes!==forestLightPadded(count)||!forestLightReceipt(item.gzip)||item.gzip.file!=='canopy-shade.bin.gz'||
  Object.keys(document.files).length!==1||!forestLightReceipt(source?.nativeFieldManifest)||!forestLightReceipt(source?.method)||
  source.method.file!=='scripts/prepare-forest-light.py'||document.recipe?.version!==1)throw Error('Invalid native forest canopy light manifest');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!forestLightSameReceipt(source?.files?.[name],forest.files?.[name]))throw Error('Native forest canopy light source mismatch: '+name);
 if(Object.keys(source.files).length!==3)throw Error('Unexpected native forest canopy light source streams');
 if(!Array.isArray(document.prototypes)||!Array.isArray(forest.prototypes)||document.prototypes.length!==forest.prototypes.length)throw Error('Invalid native forest canopy light prototype table');
 for(const [index,p]of document.prototypes.entries()){
  const original=forest.prototypes[index];
  if(p?.id!==original.id||p.species!==original.species||!forestLightReceipt(p.sourceField)||typeof p.sourceField.file!=='string'||!p.sourceField.file||
   !forestLightUint(p.sampledVertexCount)||p.sampledVertexCount>count)throw Error('Invalid native forest canopy light specimen');
  for(const kind of ['wood','leaf']){
   const range=p.membership?.[kind],expected=original[kind];
   if(!expected||range?.firstIndex!==expected.firstIndex||range.indexCount!==expected.indexCount||!forestLightReceipt(range.indices)||range.indices.bytes!==range.indexCount*4)throw Error('Native forest canopy light membership mismatch: '+kind);
  }
 }
 return document;
}

export async function loadForestLight({forest,receipt=forest?.canopyShade,fetchAsset=fetch,assets=FOREST_LIGHT_ASSETS}){
 if(receipt==null)return null;
 if(!forestLightReceipt(receipt)||receipt.file!=='canopy-shade.json'||receipt.bytes>4*1024*1024)throw Error('Invalid native forest canopy light pointer');
 if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Native forest canopy light requires verified gzip transport');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 const load=async name=>{if(typeof assets[name]!=='string')throw Error('Unregistered native forest canopy light asset: '+name);const response=await fetchAsset(assets[name]);if(!response.ok)throw Error('Native forest canopy light asset unavailable: '+name);return response.arrayBuffer();};
 const json=await load(receipt.file);
 if(json.byteLength!==receipt.bytes||await digest(json)!==receipt.sha256)throw Error('Native forest canopy light manifest digest mismatch');
 const manifest=forestLightValidate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json)),forest),item=manifest.files['canopy-shade.bin'];
 const encoded=await load(item.gzip.file);
 if(encoded.byteLength!==item.gzip.bytes||await digest(encoded)!==item.gzip.sha256)throw Error('Native forest canopy light encoded digest mismatch');
 const raw=await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 if(raw.byteLength!==item.bytes||await digest(raw)!==item.sha256)throw Error('Native forest canopy light decoded digest mismatch');
 const bytes=new Uint8Array(raw);
 for(let i=manifest.vertexCount;i<bytes.length;i++)if(bytes[i]!==255)throw Error('Native forest canopy light padding must be neutral 255');
 return{manifest,bytes,sourceValidated:true};
}

export function forestLightGPUBytes(light=null){
 if(light==null){const neutral=new Uint8Array(20);neutral.fill(255,16);return neutral;}
 const count=light.manifest?.vertexCount,bytes=light.bytes;
 if(light.sourceValidated!==true||!forestLightUint(count)||count===0||count>0xffffffff||!(bytes instanceof Uint8Array)||
  bytes.byteLength!==forestLightPadded(count)||bytes.byteLength>forestLightMaxBytes)throw Error('Unverified native forest canopy light GPU data');
 for(let i=count;i<bytes.length;i++)if(bytes[i]!==255)throw Error('Native forest canopy light GPU padding must be neutral 255');
 const result=new Uint8Array(16+bytes.byteLength);new DataView(result.buffer).setUint32(0,count,true);result.set(bytes,16);return result;
}

export const FOREST_LIGHT_WGSL=/* wgsl */`
struct ForestNativeCanopyLightBlock {counts:vec4u,packed:array<u32>};
@group(2)@binding(14)var<storage,read>forestNativeCanopyLight:ForestNativeCanopyLightBlock;
fn forestNativeCanopyAO(vertex:u32)->f32{
 if(vertex>=forestNativeCanopyLight.counts.x){return 1.;}
 let word=forestNativeCanopyLight.packed[vertex>>2u];
 return f32((word>>((vertex&3u)*8u))&255u)/255.;
}
`;
