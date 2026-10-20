import {seedVegetation} from './vegetation.js';
// A selected resident region, not a world texture. Every layer has one metric
// domain; additional river/coastal packs can use this same sampling contract.
export const LAND_REGIONS = Object.freeze({saba:Object.freeze({id:'saba',name:'Saba',latitude:17.635,longitude:-63.238,
  span:8192,size:513,biomeSize:512,albedoSize:1024,x:0,z:-6000,vegetationSeed:47231,
  assets:Object.freeze({height:'assets/world/saba/height.bin',albedo:'assets/world/saba/albedo.png',biome:'assets/world/saba/biome.bin'})})});
export const ISLAND = LAND_REGIONS.saba;
export const LANDFALL_VIEWS = Object.freeze({
  horizon:{x:-1800,z:10500,y:6,yaw:6.2,pitch:1},
  approach:{x:-1100,z:-1400,y:6,yaw:10.4,pitch:6},
  coast:{x:-2150,z:-5600,y:6,yaw:78,pitch:14},
});
export function decodeIsland(buffer,region=ISLAND){
  if(buffer.byteLength!==region.size**2*2)throw new Error(`Incomplete ${region.name} elevation pack`);
  const view=new DataView(buffer),heights=new Float32Array(region.size**2);
  for(let i=0;i<heights.length;i++)heights[i]=view.getInt16(i*2,true)/4;
  return heights;
}
export function decodeBiome(buffer,region=ISLAND){
  if(buffer.byteLength!==region.biomeSize**2)throw new Error(`Incomplete ${region.name} vegetation mask`);
  return new Uint8Array(buffer);
}
export function terrainSample(heights,x,z,region=ISLAND){
  const n=region.size,s=(n-1)/region.span;
  const u=(x-region.x+region.span/2)*s,v=(z-region.z+region.span/2)*s;
  if(u<0||v<0||u>=n-1||v>=n-1)return -120;
  const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j,k=j*n+i;
  return (heights[k]*(1-a)+heights[k+1]*a)*(1-b)+(heights[k+n]*(1-a)+heights[k+n+1]*a)*b;
}
export function islandGeometry(heights){
  const n=ISLAND.size,step=ISLAND.span/(n-1),vertices=new Float32Array(n*n*8),indices=[],submergedIndices=[];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i,h=heights[k],x=ISLAND.x+(i/(n-1)-.5)*ISLAND.span,z=ISLAND.z+(j/(n-1)-.5)*ISLAND.span;
    const dx=(heights[j*n+Math.max(0,i-1)]-heights[j*n+Math.min(n-1,i+1)])/(2*step);
    const dz=(heights[Math.max(0,j-1)*n+i]-heights[Math.min(n-1,j+1)*n+i])/(2*step);
    const length=Math.hypot(dx,1,dz);
    vertices.set([x,h,z,dx/length,1/length,dz/length,0,0],k*8);
    if(i<n-1&&j<n-1&&Math.max(h,heights[k+1],heights[k+n],heights[k+n+1])>-.5){
      indices.push(k,k+n,k+1,k+1,k+n,k+n+1);
    }
    if(i<n-1&&j<n-1&&Math.min(h,heights[k+1],heights[k+n],heights[k+n+1])<0&&Math.max(h,heights[k+1],heights[k+n],heights[k+n+1])>-45){
      submergedIndices.push(k,k+n,k+1,k+1,k+n,k+n+1);
    }
  }
  return {vertices,indices:new Uint32Array(indices),submergedIndices:new Uint32Array(submergedIndices)};
}
export function islandVegetation(heights,mask,region=ISLAND){
  return seedVegetation(region,(x,z)=>terrainSample(heights,x,z,region),mask);
}
export function islandCoordinates(x,z){
  return {latitude:ISLAND.latitude-(z-ISLAND.z)/111195,
    longitude:ISLAND.longitude+(x-ISLAND.x)/(111195*Math.cos(ISLAND.latitude*Math.PI/180))};
}
// Conservative hull envelope against an elevation-derived coastal skirt, not
// a hydrographic grounding solver. Includes swept substeps to prevent tunneling.
function islandHullClearance(heights,boat,x,z,region=ISLAND){
  const radius=Math.hypot(boat.length,boat.beam)*.5+8;
  const threshold=-Math.max(3,(boat.hydrodynamics?.draft??2)+1);
  for(let k=0;k<9;k++){
    const a=k*Math.PI/4,r=k===8?0:radius;
    if(terrainSample(heights,x+Math.cos(a)*r,z+Math.sin(a)*r,region)>threshold)return false;
  }
  return true;
}
// Camera presets were authored for the shallow-draft caravel. Keep valid starts
// exact, but move a deeper/larger hull offshore before its first simulation step.
// The broad elevation-derived shelf can exceed 500m; search the entire resident
// region, using the same footprint/depth margin as the movement constraint.
export function safeLandfallStart(heights,view,boat,region=ISLAND){
  const result=(x,z)=>({...view,x,z,moved:x!==view.x||z!==view.z,depth:-terrainSample(heights,x,z,region)});
  if(islandHullClearance(heights,boat,view.x,view.z,region))return result(view.x,view.z);
  const dx=view.x-region.x,dz=view.z-region.z,distance=Math.hypot(dx,dz);
  const ux=distance?dx/distance:1,uz=distance?dz/distance:0;
  const limit=region.span*2+Math.hypot(boat.length,boat.beam);
  for(let d=50;d<=limit;d+=50){
    const x=view.x+ux*d,z=view.z+uz*d;
    if(islandHullClearance(heights,boat,x,z,region))return result(x,z);
  }
  throw new RangeError('No landfall start clears this vessel draft and hull envelope');
}
export function constrainIslandMotion(heights,boat,previousX,previousZ){
  const dx=boat.x-previousX,dz=boat.z-previousZ,distance=Math.hypot(dx,dz);
  const steps=Math.max(1,Math.ceil(distance/8));
  for(let step=1;step<=steps;step++){
    const t=step/steps,x=previousX+dx*t,z=previousZ+dz*t;
    if(!islandHullClearance(heights,boat,x,z)){
      const safe=(step-1)/steps;boat.x=previousX+dx*safe;boat.z=previousZ+dz*safe;
      boat.surgeVelocity=0;boat.leewayVelocity=0;boat.leewayDistance=0;return true;
    }
  }
  return false;
}
