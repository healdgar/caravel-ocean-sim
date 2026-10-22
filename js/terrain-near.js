// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {ISLAND,terrainSurfaceSample} from './terrain-model.js';

export const WELLS_BAY_NEAR_ASSETS=Object.freeze({
  manifest:'assets/world/saba/wells-bay/manifest.json',
  height:'assets/world/saba/wells-bay/height.bin',
  measured:'assets/world/saba/wells-bay/measured.bin',
  albedo:'assets/world/saba/wells-bay/albedo.png',
});

export function validateTerrainNear(manifest,baseManifest,region=ISLAND){
  const m=manifest,d=m?.domain,b=baseManifest;
  if(m?.format!=='waterworld.terrain-near'||m.version!==1||m.id!=='wells-bay'||m.region!=='saba'
    ||m.baseHeightSHA256!==b?.heightSHA256||!d||![d.x,d.z,d.span,d.spacing].every(Number.isFinite)
    ||![1,2].includes(d.spacing)||!Number.isSafeInteger(d.size)||d.size<3||d.size>1025
    ||d.span!==1024||(d.size-1)*d.spacing!==d.span||!Number.isFinite(m.edgeBlendMetres)||m.edgeBlendMetres!==32)
    throw Error('Unsupported or unregistered Wells Bay near terrain');
  const step=region.span/(region.size-1),bounds=[d.x-d.span/2,d.x+d.span/2,d.z-d.span/2,d.z+d.span/2];
  if(bounds[0]<region.x-region.span/2||bounds[1]>region.x+region.span/2||bounds[2]<region.z-region.span/2||bounds[3]>region.z+region.span/2
    ||bounds.some((v,i)=>!Number.isInteger((v-(i<2?region.x:region.z)+region.span/2)/step)))
    throw Error('Near terrain edges must align with the resident height grid');
  for(const [name,bytes]of [['height.bin',d.size*d.size*4],['measured.bin',d.size*d.size]]){
    const record=m.files?.[name];if(record?.bytes!==bytes||!/^[a-f0-9]{64}$/.test(record?.sha256??''))throw Error('Invalid near terrain receipt: '+name);
  }
  if(!Number.isSafeInteger(m.files?.['albedo.png']?.bytes)||m.files['albedo.png'].bytes<1||!/^[a-f0-9]{64}$/.test(m.files['albedo.png'].sha256??''))throw Error('Invalid near imagery receipt');
  if(m.source?.sha256!==b?.terrainSources?.[0]?.sha256||m.source?.spacingMetres!==.5||m.source?.licence!=='CC BY 4.0'
    ||!m.authoredWetCells?.provenance||!m.imagery?.url||m.imagery.size!==1024)throw Error('Near terrain must retain source and authored-water provenance');
  return bounds;
}

export function terrainNearContains(tile,x,z){
  return !!tile&&x>=tile.bounds[0]&&x<=tile.bounds[1]&&z>=tile.bounds[2]&&z<=tile.bounds[3];
}

// Exactly the two triangles emitted by terrainNearGeometry, including the
// final row/column. Never bilinearly interpolate a different surface for roots.
export function terrainNearSample(tile,x,z){
  if(!terrainNearContains(tile,x,z))return null;
  const {size,spacing}=tile.manifest.domain,h=tile.heights;
  const u=(x-tile.bounds[0])/spacing,v=(z-tile.bounds[2])/spacing;
  const i=Math.min(size-2,Math.floor(u)),j=Math.min(size-2,Math.floor(v)),a=u-i,b=v-j,k=j*size+i;
  return a+b<=1?h[k]+a*(h[k+1]-h[k])+b*(h[k+size]-h[k]):
    h[k+size+1]+(1-a)*(h[k+size]-h[k+size+1])+(1-b)*(h[k+1]-h[k+size+1]);
}

export function sampleTerrainNear(tile,heights,x,z,region=ISLAND){
  return terrainNearSample(tile,x,z)??terrainSurfaceSample(heights,x,z,region);
}

export function decodeTerrainNear(manifest,baseManifest,heightBytes,measuredBytes,baseHeights,region=ISLAND){
  const bounds=validateTerrainNear(manifest,baseManifest,region),n=manifest.domain.size;
  if(heightBytes.byteLength!==n*n*4||measuredBytes.byteLength!==n*n)throw Error('Incomplete near terrain streams');
  const view=new DataView(heightBytes),heights=new Float32Array(n*n),measured=new Uint8Array(measuredBytes);
  for(let i=0;i<heights.length;i++){
    heights[i]=view.getFloat32(i*4,true);
    if(!Number.isFinite(heights[i])||heights[i]<-120||heights[i]>1000||measured[i]>1)throw Error('Nonfinite or unsupported near terrain height/mask');
  }
  const tile={manifest,bounds,heights,measured};
  for(let i=0;i<n;i++)for(const [x,z]of [[bounds[0]+i*manifest.domain.spacing,bounds[2]],[bounds[0]+i*manifest.domain.spacing,bounds[3]],[bounds[0],bounds[2]+i*manifest.domain.spacing],[bounds[1],bounds[2]+i*manifest.domain.spacing]]){
    if(Math.abs(terrainNearSample(tile,x,z)-terrainSurfaceSample(baseHeights,x,z,region))>1e-5)throw Error('Near terrain seam does not meet the resident triangle mesh');
  }
  return tile;
}

export async function loadTerrainNear({baseManifest,baseHeights,fetchAsset=fetch,region=ISLAND}={}){
  if(!baseManifest?.nearTile)return null;
  if(baseManifest.nearTile!=='wells-bay/manifest.json')throw Error('Unknown regional near tile');
  const load=async path=>{const r=await fetchAsset(path);if(!r.ok)throw Error('Near terrain unavailable: '+path);return r;};
  const manifest=await(await load(WELLS_BAY_NEAR_ASSETS.manifest)).json();validateTerrainNear(manifest,baseManifest,region);
  const [height,measured,albedo]=await Promise.all([load(WELLS_BAY_NEAR_ASSETS.height),load(WELLS_BAY_NEAR_ASSETS.measured),load(WELLS_BAY_NEAR_ASSETS.albedo)].map(async p=>(await p).arrayBuffer()));
  for(const [name,data]of [['height.bin',height],['measured.bin',measured],['albedo.png',albedo]]){
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');
    if(data.byteLength!==manifest.files[name].bytes||sha!==manifest.files[name].sha256)throw Error('Near terrain digest mismatch: '+name);
  }
  return {...decodeTerrainNear(manifest,baseManifest,height,measured,baseHeights,region),albedo};
}

export function terrainNearPatchBounds(tile,x,z,span){
  if(!tile||x+span<tile.bounds[0]||x>tile.bounds[1]||z+span<tile.bounds[2]||z>tile.bounds[3])return null;
  const {size,spacing}=tile.manifest.domain;
  const loX=Math.max(0,Math.floor((x-tile.bounds[0])/spacing)),hiX=Math.min(size-1,Math.ceil((x+span-tile.bounds[0])/spacing));
  const loZ=Math.max(0,Math.floor((z-tile.bounds[2])/spacing)),hiZ=Math.min(size-1,Math.ceil((z+span-tile.bounds[2])/spacing));
  let low=Infinity,high=-Infinity;
  for(let j=loZ;j<=hiZ;j++)for(let i=loX;i<=hiX;i++){const h=tile.heights[j*size+i];low=Math.min(low,h);high=Math.max(high,h);}
  return {low,high};
}

export function terrainNearGeometry(tile,coarseGeometry=null,region=ISLAND){
  const {size:n,spacing}=tile.manifest.domain,h=tile.heights,vertices=new Float32Array(n*n*8),indices=[],submergedIndices=[];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i,dx=(h[j*n+Math.max(0,i-1)]-h[j*n+Math.min(n-1,i+1)])/(spacing*(i===0||i===n-1?1:2));
    const dz=(h[Math.max(0,j-1)*n+i]-h[Math.min(n-1,j+1)*n+i])/(spacing*(j===0||j===n-1?1:2)),length=Math.hypot(dx,1,dz);
    const x=tile.bounds[0]+i*spacing,z=tile.bounds[2]+j*spacing,normal=[dx/length,1/length,dz/length];
    const edge=Math.min(i,j,n-1-i,n-1-j)*spacing;
    if(coarseGeometry&&edge<32){
      const u=(x-region.x+region.span/2)*(region.size-1)/region.span,v=(z-region.z+region.span/2)*(region.size-1)/region.span;
      const ci=Math.floor(u),cj=Math.floor(v),a=u-ci,b=v-cj,base=cj*region.size+ci,cv=coarseGeometry.vertices,t=edge/32,weight=t*t*(3-2*t);
      for(let component=0;component<3;component++){
        const at=base*8+3+component,A=cv[at],B=cv[at+8],C=cv[at+region.size*8],D=cv[at+(region.size+1)*8];
        const value=a+b<=1?A+a*(B-A)+b*(C-A):D+(1-a)*(C-D)+(1-b)*(B-D);
        normal[component]=value+(normal[component]-value)*weight;
      }
      const magnitude=Math.hypot(...normal);for(let component=0;component<3;component++)normal[component]/=magnitude;
    }
    vertices.set([x,h[k],z,...normal,1,1-tile.measured[k]],k*8);
    if(i<n-1&&j<n-1){
      const lo=Math.min(h[k],h[k+1],h[k+n],h[k+n+1]),hi=Math.max(h[k],h[k+1],h[k+n],h[k+n+1]);
      if(hi>-.5)indices.push(k,k+n,k+1,k+1,k+n,k+n+1);
      if(lo<0&&hi>-45)submergedIndices.push(k,k+n,k+1,k+1,k+n,k+n+1);
    }
  }
  return {vertices,indices:new Uint32Array(indices),submergedIndices:new Uint32Array(submergedIndices)};
}
