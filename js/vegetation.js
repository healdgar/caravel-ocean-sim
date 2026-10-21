// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Authored botanical approximation. Stable trees; distance changes only mesh detail.
export const TREE_VARIANTS = 8;
export const TREE_VERTEX_FLOATS = 10;
export const TREE_LOD = Object.freeze({near:380,middle:1800,hysteresis:.12,maxNear:96,maxMiddle:512});
export const TREE_PIXEL_ERROR=3;
// Offline symmetric surface-distance bounds from measureTreeLodErrors, in
// canonical mesh units. Regenerate after editing tree geometry. These are
// conservative geometry bounds, not a guarantee about alpha or colour error.
export const TREE_GEOMETRY_ERRORS=Object.freeze([[0.2204514674554226,0.03251848598128034,0],[0.21758449369916483,0.035432014857525035,0],[0.2456964873924588,0.031938874892850945,0],[0.2218023075838458,0.031149415596848265,0],[0.2391238426232965,0.03598358824134491,0],[0.26850395181679126,0.03576560307977978,0],[0.2457086449752897,0.03331245898262045,0],[0.21711395032039205,0.03151272352187278,0]].map(Object.freeze));
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

// A distant crown is the coarse spatial envelope of each actual primary bough,
// not a billboard, camera-facing shell or independently grown ellipsoid. Wood
// joins every envelope to its original trunk. Near/middle geometry is unchanged.
const treeCanopyCache=new Map();
export function treeCanopyGeometry(variant=0){
  const key=((variant%TREE_VARIANTS+TREE_VARIANTS)%TREE_VARIANTS)|0;
  if(treeCanopyCache.has(key))return treeCanopyCache.get(key);
  const {branches,sprays}=treeSkeleton(key),out=[];
  const push=(p,n,kind,shade)=>out.push(...p,...n,kind,shade,0,0);
  const triangle=(a,b,c,kind,shade,centre)=>{
    let n=treeNormal(treeCross(b.map((v,k)=>v-a[k]),c.map((v,k)=>v-a[k])));
    const outward=a.map((v,k)=>(v+b[k]+c[k])/3-centre[k]);
    if(n.reduce((sum,v,k)=>sum+v*outward[k],0)<0){[b,c]=[c,b];n=n.map(v=>-v);}
    for(const p of[a,b,c]){
      const smooth=kind===4?treeNormal(p.map((v,k)=>(v-centre[k])/(k===1?.65:1))):n;
      push(p,smooth,kind,shade);
    }
  };
  // Keep only the original coarse trunk. Its silhouette and base stay rooted.
  const trunk=treeGeometry(key,0);
  for(let i=0;i<trunk.length;i+=TREE_VERTEX_FLOATS*3)if(trunk[i+6]===3)out.push(...trunk.subarray(i,i+TREE_VERTEX_FLOATS*3));
  for(const bough of branches.filter(b=>b.level===1)){
    const leaves=sprays.filter(s=>{
      let b=branches[s.branch];while(b.level>1)b=branches[b.parent];return b.id===bough.id;
    });
    const points=leaves.flatMap(s=>s.corners),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(const p of points)for(let k=0;k<3;k++){low[k]=Math.min(low[k],p[k]);high[k]=Math.max(high[k],p[k]);}
    const centre=low.map((v,k)=>(v+high[k])*.5),height=high[1]-low[1];
    const shade=leaves.reduce((sum,s)=>sum+s.exposure,0)/leaves.length;
    const rings=[.26,.74].map((vertical,ring)=>Array.from({length:8},(_,i)=>{
      const angle=i*Math.PI/4,direction=[Math.cos(angle),Math.sin(angle)];
      let radius=0;
      for(const p of points)radius=Math.max(radius,(p[0]-centre[0])*direction[0]+(p[2]-centre[2])*direction[1]);
      const boundary=Math.min(
        (direction[0]>=0?high[0]-centre[0]:centre[0]-low[0])/Math.max(Math.abs(direction[0]),1e-8),
        (direction[1]>=0?high[2]-centre[2]:centre[2]-low[2])/Math.max(Math.abs(direction[1]),1e-8));
      radius=Math.min(boundary,radius*(ring===0?.91:.97));
      return[centre[0]+direction[0]*radius,low[1]+height*vertical,centre[2]+direction[1]*radius];
    }));
    const bottom=[centre[0],low[1],centre[2]],top=[centre[0],high[1],centre[2]];
    for(let i=0;i<8;i++){
      const j=(i+1)%8;
      triangle(bottom,rings[0][j],rings[0][i],4,shade*.78,centre);
      triangle(rings[0][i],rings[0][j],rings[1][i],4,shade,centre);
      triangle(rings[0][j],rings[1][j],rings[1][i],4,shade,centre);
      triangle(top,rings[1][i],rings[1][j],4,Math.min(1,shade+.12),centre);
    }
    // A triangular-section coarse branch reaches the envelope's interior from
    // the exact primary-bough attachment, without an expensive far bark mesh.
    const a=bough.from,b=[bottom[0],bottom[1]+height*.08,bottom[2]],axis=treeNormal(b.map((v,k)=>v-a[k])),[right,front]=treeFrame(axis);
    const ring=(p,r)=>Array.from({length:3},(_,i)=>p.map((v,k)=>v+r*(right[k]*Math.cos(i*2*Math.PI/3)+front[k]*Math.sin(i*2*Math.PI/3))));
    const A=ring(a,bough.radius),B=ring(b,bough.tipRadius),middle=a.map((v,k)=>(v+b[k])*.5);
    for(let i=0;i<3;i++){const j=(i+1)%3;triangle(A[i],A[j],B[i],3,.44,middle);triangle(A[j],B[j],B[i],3,.44,middle);}
  }
  const geometry=new Float32Array(out);treeCanopyCache.set(key,geometry);return geometry;
}
export function treeRenderGeometry(variant=0,lod=0){return lod===0?treeCanopyGeometry(variant):treeGeometry(variant,lod);}

// AUTHORING ONLY; never called by rendering. Point-to-triangle BVH queries and
// adaptive source subdivision bound the symmetric surface Hausdorff distance.
// For each source triangle, distance to ONE destination triangle is convex, so
// its maximum vertex distance bounds its entire interior. The independent
// Lipschitz bound (sample maximum + 2/3 longest edge) remains valid where those
// nearest triangles differ. Refine the largest bound until its gap above the
// sampled lower bound is <= tolerance. Limits return the unresolved UPPER
// bound, never an optimistic sample. Alpha, colour and visibility are excluded.
export function measureTreeLodErrors(variant=0,options={}){
  const tolerance=Math.max(0,options.tolerance??.002),maxDepth=Math.max(0,Math.floor(options.maxDepth??16)),maxSplits=Math.max(0,Math.floor(options.maxSplits??200000));
  const pointKey=p=>p.join(','),distance2=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2;
  const segmentDistance2=(p,a,b)=>{
    const x=b[0]-a[0],y=b[1]-a[1],z=b[2]-a[2],length=x*x+y*y+z*z;
    const t=length?Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y+(p[2]-a[2])*z)/length)):0;
    return(p[0]-a[0]-t*x)**2+(p[1]-a[1]-t*y)**2+(p[2]-a[2]-t*z)**2;
  };
  const triangleDistance2=(p,triangle)=>{
    const[a,b,c]=triangle.points,abx=b[0]-a[0],aby=b[1]-a[1],abz=b[2]-a[2],acx=c[0]-a[0],acy=c[1]-a[1],acz=c[2]-a[2];
    const nx=aby*acz-abz*acy,ny=abz*acx-abx*acz,nz=abx*acy-aby*acx;
    if(nx*nx+ny*ny+nz*nz<1e-30)return Math.min(segmentDistance2(p,a,b),segmentDistance2(p,b,c),segmentDistance2(p,c,a));
    const apx=p[0]-a[0],apy=p[1]-a[1],apz=p[2]-a[2],d1=abx*apx+aby*apy+abz*apz,d2=acx*apx+acy*apy+acz*apz;
    if(d1<=0&&d2<=0)return distance2(p,a);
    const bpx=p[0]-b[0],bpy=p[1]-b[1],bpz=p[2]-b[2],d3=abx*bpx+aby*bpy+abz*bpz,d4=acx*bpx+acy*bpy+acz*bpz;
    if(d3>=0&&d4<=d3)return distance2(p,b);
    const vc=d1*d4-d3*d2;
    if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);return(apx-v*abx)**2+(apy-v*aby)**2+(apz-v*abz)**2;}
    const cpx=p[0]-c[0],cpy=p[1]-c[1],cpz=p[2]-c[2],d5=abx*cpx+aby*cpy+abz*cpz,d6=acx*cpx+acy*cpy+acz*cpz;
    if(d6>=0&&d5<=d6)return distance2(p,c);
    const vb=d5*d2-d1*d6;
    if(vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);return(apx-w*acx)**2+(apy-w*acy)**2+(apz-w*acz)**2;}
    const va=d3*d6-d5*d4;
    if(va<=0&&d4-d3>=0&&d5-d6>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));return(bpx-w*(c[0]-b[0]))**2+(bpy-w*(c[1]-b[1]))**2+(bpz-w*(c[2]-b[2]))**2;}
    const denominator=1/(va+vb+vc),v=vb*denominator,w=vc*denominator;
    return(apx-v*abx-w*acx)**2+(apy-v*aby-w*acy)**2+(apz-v*abz-w*acz)**2;
  };
  const boxDistance2=(p,node)=>{
    let sum=0;for(let k=0;k<3;k++){const d=Math.max(node.low[k]-p[k],0,p[k]-node.high[k]);sum+=d*d;}return sum;
  };
  const build=triangles=>{
    const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(const t of triangles)for(let k=0;k<3;k++){low[k]=Math.min(low[k],t.low[k]);high[k]=Math.max(high[k],t.high[k]);}
    if(triangles.length<=8)return{low,high,triangles};
    let axis=0;for(let k=1;k<3;k++)if(high[k]-low[k]>high[axis]-low[axis])axis=k;
    triangles.sort((a,b)=>a.center[axis]-b.center[axis]);const middle=triangles.length>>1;
    return{low,high,left:build(triangles.slice(0,middle)),right:build(triangles.slice(middle))};
  };
  const surface=data=>{
    const triangles=[];
    for(let i=0;i<data.length;i+=TREE_VERTEX_FLOATS*3){
      const points=[0,1,2].map(j=>Array.from(data.subarray(i+j*TREE_VERTEX_FLOATS,i+j*TREE_VERTEX_FLOATS+3)));
      const low=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),high=[0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
      triangles.push({points,key:points.map(pointKey).sort().join('|'),low,high,center:low.map((v,k)=>(v+high[k])*.5)});
    }
    return{triangles,keys:new Set(triangles.map(t=>t.key)),bvh:build(triangles.slice())};
  };
  const nearest=(node,p,best={distance2:Infinity,triangle:null})=>{
    if(boxDistance2(p,node)>best.distance2)return best;
    if(node.triangles){
      for(const t of node.triangles){const d=triangleDistance2(p,t);if(d<best.distance2){best.distance2=d;best.triangle=t;}}
    }else{
      let a=node.left,b=node.right;if(boxDistance2(p,a)>boxDistance2(p,b))[a,b]=[b,a];
      nearest(a,p,best);nearest(b,p,best);
    }
    return best;
  };
  const directed=(from,to)=>{
    const cache=new Map(),heap=[];let lower=0,splits=0,limited=false;
    const sample=p=>{
      const key=pointKey(p);if(!cache.has(key)){const hit=nearest(to.bvh,p);cache.set(key,{distance:Math.sqrt(hit.distance2),triangle:hit.triangle});}
      const hit=cache.get(key);lower=Math.max(lower,hit.distance);return hit;
    };
    const cell=(points,depth=0,parentUpper=Infinity)=>{
      const hits=points.map(sample);let edge=0,length2=0;
      for(let i=0;i<3;i++){const d=distance2(points[i],points[(i+1)%3]);if(d>length2){edge=i;length2=d;}}
      let upper=Math.max(...hits.map(h=>h.distance))+Math.sqrt(length2)*2/3;
      // Each candidate is an entire convex destination triangle, not three
      // unrelated nearest points. This removes the old long-edge penalty for
      // source faces that closely follow one target face.
      for(const t of new Set(hits.map(h=>h.triangle))){
        upper=Math.min(upper,Math.sqrt(Math.max(...points.map(p=>triangleDistance2(p,t)))));
      }
      return{points,depth,edge,upper:Math.min(parentUpper,upper+1e-7)};
    };
    const push=value=>{
      let i=heap.length;heap.push(value);while(i>0){const parent=(i-1)>>1;if(heap[parent].upper>=value.upper)break;heap[i]=heap[parent];i=parent;}heap[i]=value;
    };
    const pop=()=>{
      const result=heap[0],tail=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].upper>heap[child].upper)child++;if(heap[child].upper<=tail.upper)break;heap[i]=heap[child];i=child;}heap[i]=tail;}return result;
    };
    for(const t of from.triangles)if(!to.keys.has(t.key))push(cell(t.points));
    while(heap.length&&heap[0].upper>lower+tolerance){
      if(splits>=maxSplits||heap[0].depth>=maxDepth){limited=true;break;}
      const t=pop(),a=t.points[t.edge],b=t.points[(t.edge+1)%3],c=t.points[(t.edge+2)%3],middle=a.map((v,k)=>(v+b[k])*.5);
      push(cell([a,middle,c],t.depth+1,t.upper));push(cell([middle,b,c],t.depth+1,t.upper));splits++;
    }
    return{lower,upper:Math.max(lower,heap[0]?.upper??0),splits,limited};
  };
  const full=surface(treeGeometry(variant,2)),details=[];
  const errors=[0,1].map(lod=>{
    const proxy=surface(treeRenderGeometry(variant,lod)),forward=directed(full,proxy),reverse=directed(proxy,full);
    details.push({lod,lower:Math.max(forward.lower,reverse.lower),upper:Math.max(forward.upper,reverse.upper),forward,reverse});
    return Math.max(forward.upper,reverse.upper);
  });
  errors.push(0);return options.details?{variant,errors,details,tolerance,maxDepth,maxSplits}:errors;
}

export function treeProjectedError(error,tree,camera){
  if(error===0)return 0;if(!Number.isFinite(error)||error<0)return Infinity;
  const h=camera.screenHeight,tan=camera.tanHalfFovY,f=camera.forward;
  if(!(h>0&&tan>0)||!f||f.length<3)return Infinity;
  const centre=[tree[0],tree[1]+tree[4]*.5,tree[2]],delta=centre.map((v,k)=>v-[camera.x,camera.y,camera.z][k]);
  const length=Math.hypot(...f);if(!(length>0))return Infinity;
  const depth=delta.reduce((sum,v,k)=>sum+v*f[k]/length,0),distance=Math.hypot(...delta);
  const radius=Math.hypot(tree[3]*Math.SQRT2,tree[4]*.5)+1;
  // The shared wind deformation's bounded shear is covered by 20% inflation.
  const worldError=error*Math.max(tree[3],tree[4])*1.2,near=depth-radius;
  if(near<=worldError)return Infinity;
  const lateral=Math.sqrt(Math.max(0,distance*distance-depth*depth))+radius;
  return h/(2*tan)*worldError*Math.sqrt(1+(lateral/near)**2)/(near-worldError);
}

// Conservative patch bounds include complete crowns and strong-wind sway. The
// renderer supplies its actual world view-projection; local captain yaw is not
// enough to cull a hull-relative camera safely.
export function createForestPatches(trees,span=128){
  const patches=new Map();
  for(let id=0;id<trees.length/8;id++){
    const k=id*8,x=trees[k],y=trees[k+1],z=trees[k+2],radius=trees[k+3]+8,height=trees[k+4];
    const key=Math.floor(x/span)+':'+Math.floor(z/span);
    if(!patches.has(key))patches.set(key,{ids:[],low:[Infinity,Infinity,Infinity],high:[-Infinity,-Infinity,-Infinity]});
    const patch=patches.get(key);patch.ids.push(id);
    for(let axis=0;axis<3;axis++){
      const low=axis===0?x-radius:axis===1?y-1:z-radius,high=axis===0?x+radius:axis===1?y+height+1:z+radius;
      patch.low[axis]=Math.min(patch.low[axis],low);patch.high[axis]=Math.max(patch.high[axis],high);
    }
  }
  return[...patches.values()].map(p=>({...p,centre:p.low.map((v,k)=>(v+p.high[k])*.5),radius:Math.hypot(...p.high.map((v,k)=>(v-p.low[k])*.5))}));
}
export function visibleForestIds(patches,camera,viewProjection=null){
  const visible=[],matrix=viewProjection?.length>=16?viewProjection:null;
  for(const patch of patches){
    if(matrix){
      const p=patch.centre.map((v,k)=>v-[camera.x,camera.y,camera.z][k]);
      let outside=false;
      // WebGPU clip X/Y lie in [-W,+W]. Ignore the infinite reverse-Z far
      // plane; a conservative W test also rejects completely rearward patches.
      for(const[axis,sign]of[[0,-1],[0,1],[1,-1],[1,1],[3,0]]){
        const a=[0,1,2].map(k=>matrix[k*4+3]+(axis===3?0:sign*matrix[k*4+axis]));
        const d=matrix[15]+(axis===3?0:sign*matrix[12+axis]);
        if(a.reduce((sum,v,k)=>sum+v*p[k],d)<-patch.radius*Math.hypot(...a)){outside=true;break;}
      }
      if(outside)continue;
    }
    visible.push(...patch.ids);
  }
  return visible;
}
// Original instance index is persistent identity. Production uses actual render
// pixels; budgets flag excess work rather than silently violating its error
// target. Legacy offline callers without a projection retain distance budgets.
export function selectTreeLods(trees,camera,previous=new Map(),policy=TREE_LOD,candidates=null){
  const selected=[],near=policy.near,middle=policy.middle,h=policy.hysteresis;
  const pixels=camera.screenHeight>0&&camera.tanHalfFovY>0&&camera.forward?.length>=3;
  for(const id of candidates??Array.from({length:trees.length/8},(_,i)=>i)){
    const k=id*8,distance=Math.hypot(trees[k]-camera.x,trees[k+1]-camera.y,trees[k+2]-camera.z);
    const old=previous.get(id)??(pixels?2:0),variant=Math.min(TREE_VARIANTS-1,Math.floor(trees[k+5]*TREE_VARIANTS));
    let lod=distance<near*(old===2?1+h:1-h)?2:distance<middle*(old>=1?1+h:1-h)?1:0;
    if(pixels){
      lod=2;
      for(let tier=0;tier<2;tier++){
        const error=treeProjectedError(TREE_GEOMETRY_ERRORS[variant][tier],trees.subarray(k,k+8),camera);
        if(error<=TREE_PIXEL_ERROR*(old===tier?1+h:1-h)){lod=tier;break;}
      }
    }
    selected.push({id,lod,distance,variant,...(pixels?{projectedError:treeProjectedError(TREE_GEOMETRY_ERRORS[variant][lod],trees.subarray(k,k+8),camera)}:{})});
  }
  // Pixel selection has no nearest-count downgrade: retain source/patch order
  // instead of sorting the entire visible stand every moving-camera frame.
  if(!pixels)selected.sort((a,b)=>a.distance-b.distance||a.id-b.id);
  let nearCount=0,middleCount=0;
  for(const tree of selected){
    if(tree.lod===2&&++nearCount>policy.maxNear){if(pixels)tree.qualityBudgetOverflow=true;else tree.lod=1;}
    if(tree.lod===1&&++middleCount>policy.maxMiddle){if(pixels)tree.qualityBudgetOverflow=true;else tree.lod=0;}
    previous.set(tree.id,tree.lod);
  }
  return selected;
}
