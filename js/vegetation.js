// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Authored botanical approximation. Stable trees; distance changes only mesh detail.
export const TREE_VARIANTS = 8;
export const TREE_VERTEX_FLOATS = 10;
export const TREE_LOD = Object.freeze({near:380,middle:1800,hysteresis:.12,maxNear:96,maxMiddle:512});
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
const treeNormal=p=>{const l=Math.hypot(...p)||1;return p.map(x=>x/l);};
const treeCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const treeAdd=(a,b,t=1)=>a.map((v,i)=>v+b[i]*t);
const treeFrame=axis=>{
  const right=treeNormal(treeCross(axis,Math.abs(axis[1])>.92?[1,0,0]:[0,1,0]));
  return [right,treeCross(right,axis)];
};
const treeSkeletonCache=new Map();
export function treeSkeleton(variant=0){
  // The same recursive growth rules as EZ-Tree: tapered section rings, seeded
  // angular drift, light-seeking tips and children attached to parent sections.
  // Species parameters describe broadleaf coastal trees, not layered cones.
  const treeVariant=((variant%TREE_VARIANTS+TREE_VARIANTS)%TREE_VARIANTS)|0;
  // Canonical skeletons are read-only; every detail tier uses these same roots,
  // branches, leaf placements and canopy exposure instead of regrowing them.
  if(treeSkeletonCache.has(treeVariant))return treeSkeletonCache.get(treeVariant);
  const rand=random(98117+treeVariant*7919);
  const branches=[],sprays=[],spread=.78+rand()*.24,lean=(rand()-.5)*.17,twist=rand()*Math.PI*2;
  const sectionCounts=[8,5,4,3,2],lengths=[.76,.49,.29,.17,.095];
  const children=[5+(treeVariant%3===0?1:0),3,3,2];
  function foliate(branch,leaves){
    const {id,path,level}=branch,count=path.length-1;
    for(let leaf=0;leaf<leaves;leaf++){
      const attach=.32+leaf/(leaves-1)*.63,section=Math.min(count-1,Math.floor(attach*count)),t=attach*count-section;
      const anchor=treeAdd(path[section],path[section+1].map((v,i)=>v-path[section][i]),t);
      const axis=treeNormal(path[section+1].map((v,i)=>v-path[section][i]));
      const [right,front]=treeFrame(axis),angle=twist+leaf*2.399963+rand()*.55;
      const radial=right.map((v,i)=>v*Math.cos(angle)+front[i]*Math.sin(angle));
      const up=treeNormal(treeAdd(treeAdd(axis,radial,.7),[0,.1,0]));
      const side=treeNormal(treeCross(up,treeAdd(radial,front,.17)));
      const height=(.11+rand()*.055)*1.2*(level===3?.94:1),width=height*(.57+rand()*.19)*1.3;
      const center=treeAdd(anchor,up,height*.45);
      const corners=[[-.5,-.45],[.5,-.45],[-.5,.55],[.5,.55]].map(([x,y])=>treeAdd(treeAdd(center,side,x*width),up,y*height));
      sprays.push({branch:id,anchor,attach,attachIndex:section,center,axis:up,right:side,width,height,shade:rand(),corners});
    }
  }
  function grow(from,direction,length,radius,level,parent=-1,attachIndex=0){
    const id=branches.length,path=[from],radii=[radius],count=sectionCounts[level];
    const branch={id,parent,level,attachIndex,from,to:from,radius,tipRadius:0,growthLength:length,path,radii};
    branches.push(branch);
    let dir=treeNormal(direction);
    for(let section=1;section<=count;section++){
      const t=section/count,drift=level===0?.095:.045+level*.012;
      // Limbs sag under their own weight; terminal shoots turn towards light.
      const light=level===0?.05:level<3?-.026:.07;
      dir=treeNormal(treeAdd(treeAdd(dir,[(rand()-.5)*drift,light+(rand()-.5)*drift,(rand()-.5)*drift]),[lean,0,0],level===0?.03:.005));
      path.push(treeAdd(path.at(-1),dir,length/count));
      radii.push(radius*(1-t*.84));
    }
    branch.to=path.at(-1);branch.tipRadius=radii.at(-1);
    if(level>=3)foliate(branch,level===4?8:3);
    if(level===4)return;
    const offset=twist+rand()*Math.PI*2;
    for(let child=0;child<children[level];child++){
      // Exact shared parent vertices prevent detached limbs. The root ring is
      // buried inside that parent's radius, giving a closed visual junction.
      const attach=level===0?Math.min(count-1,3+child):Math.min(count-1,1+Math.round(child*(count-2)/Math.max(1,children[level]-1)));
      const parentAxis=treeNormal(path[Math.min(count,attach+1)].map((v,i)=>v-path[attach-1][i]));
      const [right,front]=treeFrame(parentAxis),angle=offset+child*2.399963+(rand()-.5)*.75;
      const radial=right.map((v,i)=>v*Math.cos(angle)+front[i]*Math.sin(angle));
      const dir=treeNormal(treeAdd(parentAxis,radial,level===0?1.9*spread:1.05+rand()*.5));
      const childDirection=level===0?treeNormal([dir[0],.3+rand()*.26,dir[2]]):treeNormal(treeAdd(dir,[0,.13,0]));
      const childLength=Math.min(length*.76,lengths[level+1]*(.8+rand()*.38)*(level===0?spread:1));
      grow(path[attach],childDirection,childLength,radii[attach]*(.48+rand()*.09),level+1,id,attach);
    }
  }
  grow([0,0,0],[lean,1,(rand()-.5)*.12],lengths[0],.037+rand()*.008,0);
  // All LODs use these same leaf sprays. Keep the extremal sprays in even the
  // cheapest tier so a tree neither shrinks nor jumps when its detail changes.
  const allPoints=sprays.flatMap(s=>s.corners),top=Math.max(...allPoints.map(p=>p[1]));
  const width=Math.max(...allPoints.map(p=>Math.max(Math.abs(p[0]),Math.abs(p[2]))));
  const scaled=new Set(),scale=p=>{
    if(!scaled.has(p)){p[0]/=width;p[1]/=top;p[2]/=width;scaled.add(p);}
  };
  for(const branch of branches){
    for(const p of branch.path)scale(p);
    branch.radius/=width;branch.tipRadius/=width;branch.radii=branch.radii.map(r=>r/width);
  }
  for(const spray of sprays){
    scale(spray.anchor);scale(spray.center);for(const p of spray.corners)scale(p);
    spray.axis=treeNormal([spray.axis[0]/width,spray.axis[1]/top,spray.axis[2]/width]);
    spray.right=treeNormal([spray.right[0]/width,spray.right[1]/top,spray.right[2]/width]);
    spray.width/=width;spray.height/=top;
  }
  // A local canopy approximation: neighbouring leaves above a spray occlude
  // skylight. This produces darker interiors without baking a fixed sun angle.
  for(const spray of sprays){
    let density=0;
    for(const other of sprays){
      const dy=other.center[1]-spray.center[1];if(dy<=.005||dy>=.28)continue;
      const dx=other.center[0]-spray.center[0],dz=other.center[2]-spray.center[2],r2=dx*dx+dz*dz;
      if(r2<.0324)density+=(1-Math.sqrt(r2)/.18)*(1-dy/.28);
    }
    spray.variation=spray.shade;
    spray.exposure=Math.max(.3,Math.min(1,.28+.72*Math.exp(-density*.2)+(spray.variation-.5)*.05));
    spray.shade=spray.exposure;
  }
  const silhouette=new Set();
  for(const [axis,sign] of [[0,-1],[0,1],[1,1],[2,-1],[2,1]]){
    let best=-Infinity,index=0;
    for(let i=0;i<sprays.length;i++)for(const p of sprays[i].corners)if(p[axis]*sign>best){best=p[axis]*sign;index=i;}
    silhouette.add(index);
  }
  // Far leaves are larger versions of the same twig spray, clustered by their
  // actual second-order bough. Merely deleting small cards loses most of a
  // forest's coverage. Crossed cards retain foliage from every viewing azimuth.
  const farSprays=[],canopyLow=[Infinity,Infinity,Infinity],canopyHigh=[-Infinity,-Infinity,-Infinity];
  for(const spray of sprays)for(const p of spray.corners)for(let k=0;k<3;k++){
    canopyLow[k]=Math.min(canopyLow[k],p[k]);canopyHigh[k]=Math.max(canopyHigh[k],p[k]);
  }
  for(const bough of branches.filter(b=>b.level===2)){
    const descendants=sprays.filter(s=>{
      let branch=branches[s.branch];while(branch.level>2)branch=branches[branch.parent];
      return branch.id===bough.id;
    });
    const points=descendants.flatMap(s=>s.corners),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(const p of points)for(let k=0;k<3;k++){low[k]=Math.min(low[k],p[k]);high[k]=Math.max(high[k],p[k]);}
    const center=low.map((v,k)=>(v+high[k])*.5),height=(high[1]-low[1])*.97,shade=descendants.reduce((sum,s)=>sum+s.shade,0)/descendants.length;
    for(let card=0;card<4;card++){
      const angle=card*Math.PI/4,right=[Math.cos(angle),0,Math.sin(angle)],axis=[0,1,0];
      const projection=points.map(p=>(p[0]-center[0])*right[0]+(p[2]-center[2])*right[2]);
      // Clamp the aggregate inside the canonical horizontal bounds, while the
      // retained true extremal cards establish the exact tier-independent size.
      const halfWidth=Math.min((Math.max(...projection)-Math.min(...projection))*.485,
        Math.min(canopyHigh[0]-center[0],center[0]-canopyLow[0])/Math.max(.00001,Math.abs(right[0])),
        Math.min(canopyHigh[2]-center[2],center[2]-canopyLow[2])/Math.max(.00001,Math.abs(right[2])));
      const corners=[[-1,-.5],[1,-.5],[-1,.5],[1,.5]].map(([x,y])=>treeAdd(treeAdd(center,right,x*halfWidth),axis,y*height));
      farSprays.push({branch:bough.id,center,right,axis,width:halfWidth*2,height,shade,corners});
    }
  }
  const skeleton={branches,sprays,farSprays,silhouette:[...silhouette],crowns:[]};
  treeSkeletonCache.set(treeVariant,skeleton);return skeleton;
}
export function treeGeometry(variant=0,lod=0){
  const {branches,sprays,farSprays,silhouette}=treeSkeleton(variant),vertices=[];
  const push=(p,n,kind,shade,uv=[0,0])=>vertices.push(p[0],Math.max(0,p[1]),p[2],...n,kind,shade,...uv);
  for(const branch of branches){
    if(branch.level>(lod===0?0:lod===1?2:4))continue;
    const sides=lod===0?3:lod===1?(branch.level===0?5:3):[8,6,5,4,3][branch.level];
    const step=lod===0?3:lod===1?(branch.level===1?3:2):1,indices=[];
    for(let i=0;i<branch.path.length;i+=step)indices.push(i);
    if(indices.at(-1)!==branch.path.length-1)indices.push(branch.path.length-1);
    let previousRight;
    const rings=indices.map(i=>{
      const a=branch.path[Math.max(0,i-1)],b=branch.path[Math.min(branch.path.length-1,i+1)];
      const axis=treeNormal(b.map((v,k)=>v-a[k]));
      // Transport the previous ring rather than choosing a new arbitrary frame
      // at each bend, which would twist thin twigs into pinched triangles.
      const right=previousRight?treeNormal(treeAdd(previousRight,axis,-previousRight.reduce((sum,v,k)=>sum+v*axis[k],0))):treeFrame(axis)[0];
      const front=treeCross(right,axis);previousRight=right;
      const before=Math.max(0,i-1),after=Math.min(branch.path.length-1,i+1);
      const taper=(branch.radii[before]-branch.radii[after])/Math.max(.00001,Math.hypot(...branch.path[after].map((v,k)=>v-branch.path[before][k])));
      return Array.from({length:sides},(_,side)=>{
        const angle=side/sides*Math.PI*2,n=right.map((v,k)=>v*Math.cos(angle)+front[k]*Math.sin(angle));
        return [treeAdd(branch.path[i],n,branch.radii[i]),treeNormal(treeAdd(n,axis,taper))];
      });
    });
    for(let ring=0;ring<rings.length-1;ring++)for(let side=0;side<sides;side++){
      const next=(side+1)%sides;
      for(const [r,s] of [[ring,side],[ring+1,side],[ring,next],[ring,next],[ring+1,side],[ring+1,next]]){
        const [p,n]=rings[r][s],u=side===sides-1&&s===0?1:s/sides;
        push(p,n,3,.32+branch.level*.12,[u,indices[r]/(branch.path.length-1)*branch.growthLength]);
      }
    }
  }
  const foliage=lod===0?[...farSprays,...silhouette.map(i=>sprays[i])]:sprays;
  for(const spray of foliage){
    const n=treeNormal(treeCross(spray.right,spray.axis));
    for(const [corner,uv] of [[0,[0,0]],[1,[1,0]],[2,[0,1]],[2,[0,1]],[1,[1,0]],[3,[1,1]]]){
      push(spray.corners[corner],n,2,spray.shade,uv);
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
