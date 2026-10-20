// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Authored botanical approximation. Stable trees; distance changes only mesh detail.
export const TREE_VARIANTS = 4;
export const TREE_LOD = Object.freeze({near:380,middle:1800,hysteresis:.12,maxNear:192,maxMiddle:1024});
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
  for(let id=0;id<36000;id++){
    const u=rand(),v=rand(),density=rand(),shape=rand(),radius=3.2+rand()*4.4,height=8+rand()*10;
    const x=region.x+(u-.5)*region.span,z=region.z+(v-.5)*region.span,h=sampleHeight(x,z);
    const sx=(sampleHeight(x+12,z)-sampleHeight(x-12,z))/24,sz=(sampleHeight(x,z+12)-sampleHeight(x,z-12))/24;
    const probability=vegetationProbability(mask,region.biomeSize??512,u,v);
    if(h<15||h>855||Math.hypot(sx,sz)>1.15||density>probability*.92)continue;
    out.push(x,h,z,radius,height,shape,sx,sz);
  }
  return new Float32Array(out);
}
export function treeSkeleton(variant=0){
  const rand=random(98117+(variant%TREE_VARIANTS)*7919),branches=[],crowns=[];
  const trunk=[[0,0,0],[.025*(rand()-.5),.38,.025*(rand()-.5)]];
  branches.push({from:trunk[0],to:trunk[1],radius:.075});
  for(let limb=0;limb<4;limb++){
    const angle=(limb/4+rand()*.10)*Math.PI*2;
    const end=[Math.cos(angle)*(.43+rand()*.12),.64+rand()*.12,Math.sin(angle)*(.43+rand()*.12)];
    const from=[trunk[1][0],.27+limb*.035,trunk[1][2]];
    branches.push({from,to:end,radius:.043});
    for(let fork=0;fork<3;fork++){
      const a=angle+(fork-1)*.42,reach=.15+rand()*.13;
      const to=[end[0]+Math.cos(a)*reach,end[1]+.13+rand()*.10,end[2]+Math.sin(a)*reach];
      branches.push({from:end,to,radius:.018});
    }
    crowns.push({center:[end[0],end[1]+.035,end[2]],radii:[.48,.25+rand()*.045,.48],variation:rand()});
  }
  // The top cluster keeps overall height consistent across all representations.
  crowns.push({center:[0,.785,0],radii:[.50,.215,.50],variation:rand()});
  const top=Math.max(...crowns.map(c=>c.center[1]+c.radii[1]));
  const width=Math.max(...crowns.flatMap(c=>[Math.abs(c.center[0])+c.radii[0],Math.abs(c.center[2])+c.radii[2]]));
  const scaled=new Set();
  for(const branch of branches)for(const p of [branch.from,branch.to]){
    // Shared endpoint arrays intentionally remain shared in the skeleton. Avoid
    // scaling the same junction twice when several forks use it.
    if(!scaled.has(p)){p[0]/=width;p[1]/=top;p[2]/=width;scaled.add(p);}
  }
  for(const crown of crowns){crown.center[0]/=width;crown.center[1]/=top;crown.center[2]/=width;
    crown.radii[0]/=width;crown.radii[1]/=top;crown.radii[2]/=width;}
  return {branches,crowns};
}
export function treeGeometry(variant=0,lod=0){
  const {branches,crowns}=treeSkeleton(variant),vertices=[];
  const push=(p,n,kind,shade)=>vertices.push(p[0],Math.max(0,p[1]),p[2],...n,kind,shade);
  const normal=(p)=>{const l=Math.hypot(...p)||1;return p.map(x=>x/l);};
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  for(const branch of branches.slice(0,lod===0?1:lod===1?5:branches.length)){
    const axis=normal(branch.to.map((n,i)=>n-branch.from[i])),right=normal(cross(axis,[0,0,1])),front=cross(axis,right);
    const sides=lod===1?4:6;
    for(let side=0;side<sides;side++){
      const ring=[];
      for(const [t,a] of [[0,side],[1,side],[0,side+1],[0,side+1],[1,side],[1,side+1]]){
        const angle=a/sides*Math.PI*2,n=right.map((r,i)=>r*Math.cos(angle)+front[i]*Math.sin(angle));
        ring.push([branch.from.map((p,i)=>p+(branch.to[i]-p)*t+n[i]*branch.radius*(1-t*.68)),n]);
      }
      for(const [p,n] of ring)push(p,n,3,.5);
    }
  }
  // Every tier uses the same crown centres and extents. Tessellation changes;
  // roots, branch skeleton, physical height, radius and colour remain invariant.
  const segments=lod===0?4:8,rings=lod===0?2:lod===1?4:6;
  for(const crown of crowns)for(let ring=0;ring<rings;ring++)for(let s=0;s<segments;s++){
    const point=(r,a)=>{
      const lat=r/rings*Math.PI,angle=a/segments*Math.PI*2;
      const n=[Math.sin(lat)*Math.cos(angle),Math.cos(lat),Math.sin(lat)*Math.sin(angle)];
      return [crown.center.map((p,i)=>p+n[i]*crown.radii[i]),normal(n.map((v,i)=>v/crown.radii[i]))];
    };
    const corners=[];
    if(ring>0)corners.push([ring,s],[ring+1,s],[ring,s+1]);
    if(ring<rings-1)corners.push([ring,s+1],[ring+1,s],[ring+1,s+1]);
    for(const [r,a] of corners){
      const [p,n]=point(r,a);push(p,n,2,crown.variation);
    }
  }
  return new Float32Array(vertices);
}
// Original instance index is its persistent identity. Budget overflow retains
// the tree in a cheaper tier rather than deleting or moving it.
export function selectTreeLods(trees,camera,previous=new Map(),policy=TREE_LOD){
  const selected=[],near=policy.near,middle=policy.middle,h=policy.hysteresis;
  for(let id=0;id<trees.length/8;id++){
    const k=id*8,distance=Math.hypot(trees[k]-camera.x,trees[k+1]-camera.y,trees[k+2]-camera.z);
    const old=previous.get(id)??0;
    let lod=distance<near*(old===2?1+h:1-h)?2:distance<middle*(old>=1?1+h:1-h)?1:0;
    selected.push({id,lod,distance,variant:Math.min(TREE_VARIANTS-1,Math.floor(trees[k+5]*TREE_VARIANTS))});
  }
  selected.sort((a,b)=>a.distance-b.distance||a.id-b.id);
  let nearCount=0,middleCount=0;
  for(const tree of selected){
    if(tree.lod===2&&++nearCount>policy.maxNear)tree.lod=1;
    if(tree.lod===1&&++middleCount>policy.maxMiddle)tree.lod=0;
    previous.set(tree.id,tree.lod);
  }
  return selected;
}
