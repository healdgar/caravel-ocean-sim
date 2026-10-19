// Saba elevation pilot. Coordinates remain physical metres; no voyage multiplier.
export const ISLAND = Object.freeze({name:'Saba',latitude:17.635,longitude:-63.238,span:8192,size:257,x:0,z:-6000});
export const LANDFALL_VIEWS = Object.freeze({
  horizon:{x:-1800,z:10500,y:6,yaw:6.2,pitch:1},
  approach:{x:-1100,z:0,y:6,yaw:10.4,pitch:4},
  coast:{x:-2300,z:-3700,y:6,yaw:38,pitch:12},
});
export function decodeIsland(buffer){
  if(buffer.byteLength!==ISLAND.size**2*2)throw new Error('Incomplete Saba elevation pack');
  const view=new DataView(buffer),heights=new Float32Array(ISLAND.size**2);
  for(let i=0;i<heights.length;i++)heights[i]=view.getInt16(i*2,true)/4;
  return heights;
}
export function terrainSample(heights,x,z){
  const n=ISLAND.size,s=(n-1)/ISLAND.span;
  const u=(x-ISLAND.x+ISLAND.span/2)*s,v=(z-ISLAND.z+ISLAND.span/2)*s;
  if(u<0||v<0||u>=n-1||v>=n-1)return -120;
  const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j,k=j*n+i;
  return (heights[k]*(1-a)+heights[k+1]*a)*(1-b)+(heights[k+n]*(1-a)+heights[k+n+1]*a)*b;
}
export function islandGeometry(heights){
  const n=ISLAND.size,step=ISLAND.span/(n-1),vertices=new Float32Array(n*n*8),indices=[];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i,h=heights[k],x=ISLAND.x+(i/(n-1)-.5)*ISLAND.span,z=ISLAND.z+(j/(n-1)-.5)*ISLAND.span;
    const dx=(heights[j*n+Math.max(0,i-1)]-heights[j*n+Math.min(n-1,i+1)])/(2*step);
    const dz=(heights[Math.max(0,j-1)*n+i]-heights[Math.min(n-1,j+1)*n+i])/(2*step);
    const length=Math.hypot(dx,1,dz);
    vertices.set([x,h,z,dx/length,1/length,dz/length,0,0],k*8);
    if(i<n-1&&j<n-1&&Math.max(h,heights[k+1],heights[k+n],heights[k+n+1])>-.5){
      indices.push(k,k+n,k+1,k+1,k+n,k+n+1);
    }
  }
  return {vertices,indices:new Uint32Array(indices)};
}
// Stable sparse broadleaf canopies; the ground shader supplies the continuous
// understory. Placement is slope/altitude constrained and never camera-seeded.
export function islandVegetation(heights){
  let seed=47231;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const out=[];
  for(let i=0;i<32000;i++){
    const x=ISLAND.x+(rand()-.5)*ISLAND.span,z=ISLAND.z+(rand()-.5)*ISLAND.span,h=terrainSample(heights,x,z);
    const sx=(terrainSample(heights,x+12,z)-terrainSample(heights,x-12,z))/24;
    const sz=(terrainSample(heights,x,z+12)-terrainSample(heights,x,z-12))/24;
    if(h<20||h>850||Math.hypot(sx,sz)>1.1)continue;
    const r=3.5+rand()*4.5,high=8+rand()*7;
    out.push(x,h,z,r,high,rand(),sx,sz);
  }
  return new Float32Array(out);
}
export function islandCoordinates(x,z){
  return {latitude:ISLAND.latitude-(z-ISLAND.z)/111195,
    longitude:ISLAND.longitude+(x-ISLAND.x)/(111195*Math.cos(ISLAND.latitude*Math.PI/180))};
}
// Conservative hull envelope against an elevation-derived coastal skirt, not
// a hydrographic grounding solver. Includes swept substeps to prevent tunneling.
export function constrainIslandMotion(heights,boat,previousX,previousZ){
  const dx=boat.x-previousX,dz=boat.z-previousZ,distance=Math.hypot(dx,dz);
  const radius=Math.hypot(boat.length,boat.beam)*.5+8;
  const steps=Math.max(1,Math.ceil(distance/8)),threshold=-Math.max(3,(boat.hydrodynamics?.draft??2)+1);
  for(let step=1;step<=steps;step++){
    const t=step/steps,x=previousX+dx*t,z=previousZ+dz*t;
    for(let k=0;k<9;k++){
      const a=k*Math.PI/4,r=k===8?0:radius;
      if(terrainSample(heights,x+Math.cos(a)*r,z+Math.sin(a)*r)>threshold){
        const safe=(step-1)/steps;boat.x=previousX+dx*safe;boat.z=previousZ+dz*safe;
        boat.surgeVelocity=0;boat.leewayVelocity=0;boat.leewayDistance=0;return true;
      }
    }
  }
  return false;
}
