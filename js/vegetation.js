// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Seeded vegetation and authored ground cover. Trees are the forest's (js/forest-scenery.js).
const random = initial => {
  let seed=initial>>>0;
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
};
export function vegetationProbability(mask,size,u,v){
  if(!mask)return 1;
  const x=Math.max(0,Math.min(size-1,Math.floor(u*size))),y=Math.max(0,Math.min(size-1,Math.floor(v*size)));
  return mask[y*size+x]/255;
}
export function seedVegetation(region,sampleHeight,mask){
  const rand=random(region.vegetationSeed??47231),out=[];
  // Candidate identities and dimensions never depend on a camera or detail tier.
  for(let id=0;id<(region.vegetationCandidates??36000);id++){
    const u=rand(),v=rand(),density=rand(),shape=rand(),radius=3.2+rand()*4.4,height=8+rand()*10;
    const x=region.x+(u-.5)*region.span,z=region.z+(v-.5)*region.span,h=sampleHeight(x,z);
    const sx=(sampleHeight(x+12,z)-sampleHeight(x-12,z))/24,sz=(sampleHeight(x,z+12)-sampleHeight(x,z-12))/24;
    const probability=vegetationProbability(mask,region.biomeSize??512,u,v);
    if(h<15||h>855||Math.hypot(sx,sz)>1.15||density>probability*.92)continue;
    out.push(x,h,z,radius,height,shape,sx,sz);
  }
  return new Float32Array(out);
}
// Authored local ground cover: the rocks lying about the land, drawn by the boulder continuum
// (js/boulder-continuum.js); its grass is the meadow's (js/meadow-grass.js). Region-resident patch bounds are
// cheap; a patch's rocks are worked out when it comes into range.
export const GROUND_COVER=Object.freeze({patchSpan:64,rocksPerPatch:3,maxExtent:5.1});
export const ROCK_ARCHETYPES=6;
export function createGroundCoverPatches(region,sampleHeight,extraHeightBounds=null){
  const span=GROUND_COVER.patchSpan,count=Math.ceil(region.span/span),patches=[];
  for(let j=0;j<count;j++)for(let i=0;i<count;i++){
    const x=region.x-region.span*.5+i*span,z=region.z-region.span*.5+j*span;let low=Infinity,high=-Infinity;
    // Patches align with the elevation lattice. Include every height vertex;
    // triangle interiors cannot leave their vertex height range.
    const divisions=Math.max(1,Math.ceil(span/(region.span/(region.size-1))));
    for(let v=0;v<=divisions;v++)for(let u=0;u<=divisions;u++){
      const h=sampleHeight(x+span*u/divisions,z+span*v/divisions);low=Math.min(low,h);high=Math.max(high,h);
    }
    const extra=extraHeightBounds?.(x,z,span);if(extra){low=Math.min(low,extra.low);high=Math.max(high,extra.high);}
    if(high<1||low>855)continue;
    const id=patches.length,r=GROUND_COVER.maxExtent;
    patches.push({id,seed:(region.vegetationSeed??47231)^Math.imul(i+1,73856093)^Math.imul(j+1,19349663),x,z,ids:[id],
      centre:[x+span*.5,(low+high)*.5,z+span*.5],radius:Math.hypot(span*.5+r,(high-low)*.5+r,span*.5+r),instances:null});
  }
  return patches;
}
export function rockArchetypeFromSeed(seed,group=seed>.5?1:0){
  const f=seed*17.31+(group&1)*.5;
  return Math.max(0,Math.min(ROCK_ARCHETYPES-1,Math.floor((f-Math.floor(f))*ROCK_ARCHETYPES)));
}
// A patch's rocks, in two groups by their seed: root x, y, z, radius, height, seed and the ground's slope x, z.
export function groundCoverInstances(patch,sampleHeight,mayLieAt=null){
  if(patch.instances)return patch.instances;
  const rand=random(patch.seed),groups=[[],[]],span=GROUND_COVER.patchSpan;
  for(let i=0;i<GROUND_COVER.rocksPerPatch;i++){
    const u=rand(),v=rand(),density=rand(),seed=rand(),size=rand(),tall=rand();
    const x=patch.x+u*span,z=patch.z+v*span,h=sampleHeight(x,z);
    if(h<5||h>855||(mayLieAt&&!mayLieAt(x,z)))continue;
    const sx=(sampleHeight(x+.5,z)-sampleHeight(x-.5,z)),sz=(sampleHeight(x,z+.5)-sampleHeight(x,z-.5)),slope=Math.hypot(sx,sz);
    if(slope>1.8||density>.35+slope*.3)continue;
    const radius=.62+size*1.78,height=Math.min(2.05,Math.max(.36,radius*(.38+tall*.28)));
    groups[seed>.5?1:0].push(x,h,z,radius,height,seed,sx,sz);
  }
  patch.instances=groups.map(data=>new Float32Array(data));return patch.instances;
}
