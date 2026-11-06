// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Forest bark and leaf arrays as prebuilt block-compressed textures, from scripts/prepare-forest-surfaces.py.
// Pigment is linear colour times coverage held in sRGB encoding, so the sampler returns the same values
// as the fallback path in forest-scenery.js. Any missing or stale set leaves that path to do the work.

// Literal paths: build.mjs finds what to publish by reading them from the source.
export const FOREST_SURFACE_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/saba/surfaces/manifest.json',
  'family-0-albedo.bc7.bin.gz':'assets/forest-scenery/saba/surfaces/family-0-albedo.bc7.bin.gz',
  'family-0-detail.bc7.bin.gz':'assets/forest-scenery/saba/surfaces/family-0-detail.bc7.bin.gz',
  'family-1-albedo.bc7.bin.gz':'assets/forest-scenery/saba/surfaces/family-1-albedo.bc7.bin.gz',
  'family-1-detail.bc7.bin.gz':'assets/forest-scenery/saba/surfaces/family-1-detail.bc7.bin.gz',
  'family-0-albedo.astc.bin.gz':'assets/forest-scenery/saba/surfaces/family-0-albedo.astc.bin.gz',
  'family-0-detail.astc.bin.gz':'assets/forest-scenery/saba/surfaces/family-0-detail.astc.bin.gz',
  'family-1-albedo.astc.bin.gz':'assets/forest-scenery/saba/surfaces/family-1-albedo.astc.bin.gz',
  'family-1-detail.astc.bin.gz':'assets/forest-scenery/saba/surfaces/family-1-detail.astc.bin.gz',
});
export const SUBTROPICAL_FOREST_SURFACE_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/subtropical/surfaces/manifest.json',
  'family-0-albedo.bc7.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-0-albedo.bc7.bin.gz',
  'family-0-detail.bc7.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-0-detail.bc7.bin.gz',
  'family-1-albedo.bc7.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-1-albedo.bc7.bin.gz',
  'family-1-detail.bc7.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-1-detail.bc7.bin.gz',
  'family-0-albedo.astc.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-0-albedo.astc.bin.gz',
  'family-0-detail.astc.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-0-detail.astc.bin.gz',
  'family-1-albedo.astc.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-1-albedo.astc.bin.gz',
  'family-1-detail.astc.bin.gz':'assets/forest-scenery/subtropical/surfaces/family-1-detail.astc.bin.gz',
});
export const FOREST_SURFACE_CODECS=Object.freeze({
  bc7:Object.freeze({feature:'texture-compression-bc',albedo:'bc7-rgba-unorm-srgb',detail:'bc7-rgba-unorm'}),
  astc:Object.freeze({feature:'texture-compression-astc',albedo:'astc-4x4-unorm-srgb',detail:'astc-4x4-unorm'}),
});
const FOREST_SURFACE_BLOCK_BYTES=16;

export const forestSurfaceFeatures=adapter=>Object.values(FOREST_SURFACE_CODECS).map(codec=>codec.feature).filter(feature=>adapter.features.has(feature));

// BC7 first: phones have only ASTC, and machines with both have it at the same size.
// 'png' forces the fallback, and 'bc7' or 'astc' force a set where the device has it.
export function chooseForestSurfaceCodec(device,choice='auto'){
  if(choice==='png')return null;
  const available=name=>device.features?.has(FOREST_SURFACE_CODECS[name].feature)?name:null;
  if(choice==='bc7'||choice==='astc')return available(choice);
  return available('bc7')??available('astc');
}

// One row of the material table every native forest shader reads.
export function forestMaterialOptics(optics,index,material,familyId,layer){
  optics.set([material.roughness,material.underside,material.transmission,material.opacityThreshold,...material.undersideReference,0,
    familyId,layer,material.wrap==='repeat'?1:0,material.clearcoat??0],index*12);
}

const forestSurfaceDigest=async raw=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
const forestSurfaceSameSources=(layer,material)=>['albedo','normal','roughnessMap'].every(kind=>(material[kind]?.sha256??null)===(layer.sources?.[kind]??null));

// Null when this pack's set does not describe these exact materials, so edited maps are never shown stale.
export async function loadForestSurfaceSet({assets,materials,codec,fetchAsset=fetch,signal}){
  const load=async name=>{
    if(typeof assets[name]!=='string')throw Error('Unregistered forest surface: '+name);
    const response=await fetchAsset(assets[name],signal?{signal}:undefined);
    if(!response.ok)throw Error('Forest surface unavailable ('+response.status+'): '+name);
    return response;
  };
  const manifest=await(await load('manifest.json')).json();
  if(manifest?.format!=='waterworld.forest-surfaces'||manifest.version!==1||!Array.isArray(manifest.families)||manifest.families.length>4)throw Error('Invalid forest surface set');
  const placed=manifest.families.flatMap(family=>family.layers);
  if(placed.length!==materials.length||new Set(placed.map(layer=>layer.material)).size!==materials.length)return null;
  for(const layer of placed)if(!materials[layer.material]||!forestSurfaceSameSources(layer,materials[layer.material]))return null;
  const families=await Promise.all(manifest.families.map(async family=>{
    const read=async kind=>{
      const file=family.files[codec][kind],packed=await(await load(file.gzip.file)).arrayBuffer();
      if(packed.byteLength!==file.gzip.bytes||await forestSurfaceDigest(packed)!==file.gzip.sha256)throw Error('Forest surface download failed verification: '+file.gzip.file);
      const raw=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      if(raw.byteLength!==file.bytes||await forestSurfaceDigest(raw)!==file.sha256)throw Error('Forest surface failed verification: '+file.gzip.file);
      return{data:new Uint8Array(raw),downloadBytes:file.gzip.bytes};
    };
    const [albedo,detail]=await Promise.all([read('albedo'),read('detail')]);
    return{width:family.width,height:family.height,levels:family.levels,layers:family.layers,albedo,detail};
  }));
  return{codec,families,materialCount:materials.length,sharpen:manifest.sharpen};
}

// Synchronous, so an error scope around it catches only these textures. It copies about 10 MiB once.
export function createForestSurfaceTextures({device,set,materials}){
  const formats=FOREST_SURFACE_CODECS[set.codec],textures=[],families=[],optics=new Float32Array(set.materialCount*12);
  const upload=(label,format,family,data)=>{
    const texture=device.createTexture({label,format,size:[family.width,family.height,family.layers.length],mipLevelCount:family.levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    textures.push(texture);
    let offset=0;
    for(let level=0;level<family.levels;level++){
      const across=Math.ceil(Math.max(1,family.width>>level)/4),down=Math.ceil(Math.max(1,family.height>>level)/4),bytesPerRow=across*FOREST_SURFACE_BLOCK_BYTES;
      device.queue.writeTexture({texture,mipLevel:level},data,{offset,bytesPerRow,rowsPerImage:down},[across*4,down*4,family.layers.length]);
      offset+=bytesPerRow*down*family.layers.length;
    }
    if(offset!==data.byteLength)throw Error('Forest surface has the wrong size: '+label);
    return texture;
  };
  try{
    for(const [id,family]of set.families.entries()){
      const rows=family.layers.map((layer,row)=>{forestMaterialOptics(optics,layer.material,materials[layer.material],id,row);return{material:materials[layer.material]};});
      families.push({id,width:family.width,height:family.height,levels:family.levels,rows,
        albedo:upload('forest immutable native pigment and coverage blocks',formats.albedo,family,family.albedo.data),
        normal:upload('forest immutable native normal and roughness blocks',formats.detail,family,family.detail.data)});
    }
  }catch(error){for(const texture of textures)texture.destroy();throw error;}
  return{families,optics,layers:set.materialCount,codec:set.codec,destroy(){for(const texture of textures)texture.destroy();}};
}
