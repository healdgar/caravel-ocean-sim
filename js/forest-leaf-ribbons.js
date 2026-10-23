// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Construction/offline helper only. No I/O, GPU work or automatic game path.
const forestRibbonCheck=(ok,message)=>{if(!ok)throw Error('Forest leaf ribbon: '+message);};
const forestRibbonUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestRibbonResults=new WeakSet();
const forestRibbonCross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const forestRibbonArea=p=>{let n=0;for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];n+=a[0]*b[1]-a[1]*b[0];}return Math.abs(n)*.5;};
const forestRibbonCornerUV=Object.freeze([[0,0],[1,0],[1,1],[0,1]].map(Object.freeze));

// Convex source/candidate triangle overlay: clipping retains original vertices
// and creates every crossing of their UV edges. Shared boundary cells may have
// zero area; retaining their endpoints is conservative for the maximum norm.
function forestRibbonOverlay(source,candidate){
 let polygon=source.map(p=>p.slice());const orientation=Math.sign(forestRibbonCross(...candidate));
 for(let edge=0;edge<3&&polygon.length;edge++){
  const a=candidate[edge],b=candidate[(edge+1)%3],next=[];
  let previous=polygon.at(-1),d0=orientation*forestRibbonCross(a,b,previous);
  for(const point of polygon){
   const d1=orientation*forestRibbonCross(a,b,point),inside0=d0>=0,inside1=d1>=0;
   if(inside0!==inside1){
    const t=d0/(d0-d1);forestRibbonCheck(Number.isFinite(t)&&t>=0&&t<=1,'ill-conditioned UV edge intersection');
    next.push([previous[0]+t*(point[0]-previous[0]),previous[1]+t*(point[1]-previous[1])]);
   }
   if(inside1)next.push(point);previous=point;d0=d1;
  }
  polygon=next;
 }
 return polygon;
}
function forestRibbonWeights(point,uv){
 const denominator=forestRibbonCross(...uv),a=forestRibbonCross(uv[1],uv[2],point)/denominator,b=forestRibbonCross(uv[2],uv[0],point)/denominator;
 return[a,b,1-a-b];
}
function forestRibbonInterpolate(vertices,stride,ids,weights,offset,count){
 const out=[];for(let k=0;k<count;k++)out.push(weights[0]*vertices[ids[0]*stride+offset+k]+weights[1]*vertices[ids[1]*stride+offset+k]+weights[2]*vertices[ids[2]*stride+offset+k]);return out;
}
function forestRibbonOutward(value){
 forestRibbonCheck(Number.isFinite(value)&&value>=0,'nonfinite geometric error');
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,true);view.setBigUint64(0,view.getBigUint64(0,true)+1n,true);return view.getFloat64(0,true);
}
function forestRibbonTriangle3D(vertices,stride,ids){
 const a=ids[0]*stride,b=ids[1]*stride,c=ids[2]*stride,u=[0,1,2].map(k=>vertices[b+k]-vertices[a+k]),v=[0,1,2].map(k=>vertices[c+k]-vertices[a+k]);
 return Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])>0;
}

function forestRibbonBlade(vertices,indices,first,stride){
 const byUV=new Map(),edges=new Map(),triangles=[],sourceIDs=new Set();let material,kind,orientation,minArea=Infinity,positionMagnitude=1;
 for(let t=0;t<4;t++){
  const ids=Array.from(indices.subarray(first+t*3,first+t*3+3)),uv=[];
  for(const id of ids){
   forestRibbonCheck(id<vertices.length/stride,'source index outside vertex records');sourceIDs.add(id);const at=id*stride,row=vertices.subarray(at,at+stride);
   forestRibbonCheck(row.every(Number.isFinite),'nonfinite source record');
   forestRibbonCheck(forestRibbonUint(row[13])&&row[13]<128&&forestRibbonUint(row[6])&&row[6]>=4&&row[6]<132,'unsupported source material/kind');
   if(material===undefined){material=row[13];kind=row[6];}else forestRibbonCheck(row[13]===material&&row[6]===kind,'blade crosses source material/kind');
   const point=[row[8],row[9]];forestRibbonCheck(point.every(n=>n===0||n===.5||n===1),'unsupported UV chart: only exact original half-step unit-square coordinates');uv.push(point);
   const key=point.join(','),existing=byUV.get(key);
   if(existing){
    forestRibbonCheck([0,1,2].every(k=>vertices[existing.id*stride+k]===row[k]),'UV seam has discontinuous source positions');existing.id=Math.min(existing.id,id);
   }else byUV.set(key,{id,uv:point});
   for(let k=0;k<3;k++)positionMagnitude=Math.max(positionMagnitude,Math.abs(row[k]));
  }
  const area=forestRibbonCross(...uv);forestRibbonCheck(Math.abs(area)>1e-8,'degenerate or ill-conditioned source UV triangle');
  if(orientation===undefined)orientation=Math.sign(area);else forestRibbonCheck(Math.sign(area)===orientation,'inconsistent source UV winding');
  forestRibbonCheck(forestRibbonTriangle3D(vertices,stride,ids),'degenerate source spatial triangle');minArea=Math.min(minArea,Math.abs(area));
  triangles.push({ids,uv,twiceArea:area});
  for(let k=0;k<3;k++){
   const a=uv[k].join(','),b=uv[(k+1)%3].join(','),key=a<b?a+'|'+b:b+'|'+a;
   if(!edges.has(key))edges.set(key,[]);edges.get(key).push({a,b,triangle:t});
  }
 }
 // Strict shared-edge topology and exact unit-square boundaries reject holes,
 // overlap, T junctions and disconnected pieces. Unsupported UV charts fail;
 // no snapping, welding, UV regeneration or presumed ribbon ordering occurs.
 forestRibbonCheck(byUV.size===5||byUV.size===6,'unsupported four-triangle UV topology');
 const corners=forestRibbonCornerUV.map(uv=>byUV.get(uv.join(','))?.id);forestRibbonCheck(corners.every(forestRibbonUint),'missing original outer UV corner');
 const outgoing=new Map(),incoming=new Map(),neighbours=Array.from({length:4},()=>[]);let boundaryEdges=0;
 for(const list of edges.values()){
  forestRibbonCheck(list.length===1||list.length===2,'nonmanifold source UV edge');
  if(list.length===2){
   forestRibbonCheck(list[0].a===list[1].b&&list[0].b===list[1].a,'overlapping or inconsistently joined source UV edge');
   neighbours[list[0].triangle].push(list[1].triangle);neighbours[list[1].triangle].push(list[0].triangle);
  }else{
   const {a,b}=list[0],p=byUV.get(a).uv,q=byUV.get(b).uv;
   forestRibbonCheck((p[0]===q[0]&&(p[0]===0||p[0]===1))||(p[1]===q[1]&&(p[1]===0||p[1]===1)),'source UV hole or unsupported T junction');
   forestRibbonCheck(!outgoing.has(a)&&!incoming.has(b),'source boundary is not a simple cycle');outgoing.set(a,b);incoming.set(b,a);boundaryEdges++;
  }
 }
 forestRibbonCheck(byUV.size-edges.size+4===1&&boundaryEdges>=4,'source UV topology is not a disk');
 const visited=new Set(),stack=[0];while(stack.length){const at=stack.pop();if(!visited.has(at)){visited.add(at);stack.push(...neighbours[at]);}}
 forestRibbonCheck(visited.size===4,'disconnected source UV triangles');
 const start=outgoing.keys().next().value,seenBoundary=new Set();let cursor=start;
 do{forestRibbonCheck(cursor!==undefined&&!seenBoundary.has(cursor),'source UV boundary has multiple cycles');seenBoundary.add(cursor);cursor=outgoing.get(cursor);}while(cursor!==start);
 forestRibbonCheck(seenBoundary.size===boundaryEdges&&incoming.size===outgoing.size,'incomplete unit-square boundary');
 forestRibbonCheck(Math.abs(triangles.reduce((n,t)=>n+Math.abs(t.twiceArea)*.5,0)-1)<=1e-12,'source UV chart leaves holes or overlaps');
 for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)forestRibbonCheck(forestRibbonArea(forestRibbonOverlay(triangles[a].uv,triangles[b].uv))<=1e-12,'overlapping source UV triangle interiors');
 return{triangles,corners,material,kind,orientation,minArea,positionMagnitude,sourceIDs:[...sourceIDs].sort((a,b)=>a-b)};
}

function forestRibbonCandidate(vertices,stride,blade,diagonal){
 const c=blade.corners,ids=diagonal===0?[[c[0],c[1],c[2]],[c[0],c[2],c[3]]]:[[c[0],c[1],c[3]],[c[1],c[2],c[3]]];
 if(blade.orientation<0)for(const t of ids)[t[1],t[2]]=[t[2],t[1]];
 if(!ids.every(t=>forestRibbonTriangle3D(vertices,stride,t)))return null;
 const triangles=ids.map(t=>({ids:t,uv:t.map(id=>[vertices[id*stride+8],vertices[id*stride+9]])})),sourceTriangleTargets=new Array(4).fill(0);
 let maxPosition=0,maxNormal=0,maxExposure=0,maxRGB=0,maxAO=0,witness=null;
 for(let sourceID=0;sourceID<4;sourceID++)for(let reducedID=0;reducedID<2;reducedID++){
  const source=blade.triangles[sourceID],reduced=triangles[reducedID],overlay=forestRibbonOverlay(source.uv,reduced.uv);
  if(forestRibbonArea(overlay)>0)sourceTriangleTargets[sourceID]|=1<<reducedID;
  for(const uv of overlay){
   const a=forestRibbonWeights(uv,source.uv),b=forestRibbonWeights(uv,reduced.uv),positionA=forestRibbonInterpolate(vertices,stride,source.ids,a,0,3),positionB=forestRibbonInterpolate(vertices,stride,reduced.ids,b,0,3),error=Math.hypot(...positionA.map((v,k)=>v-positionB[k]));
   if(witness===null||error>maxPosition){maxPosition=error;witness={uv:uv.slice(),sourcePosition:positionA,reducedPosition:positionB,sourceTriangle:sourceID,reducedTriangle:reducedID};}
   for(const [offset,count,key]of [[3,3,'normal'],[7,1,'exposure'],[10,3,'rgb'],...(stride===15?[[14,1,'ao']]:[])]){
    const original=forestRibbonInterpolate(vertices,stride,source.ids,a,offset,count),candidate=forestRibbonInterpolate(vertices,stride,reduced.ids,b,offset,count),delta=Math.hypot(...original.map((v,k)=>v-candidate[k]));
    if(key==='normal')maxNormal=Math.max(maxNormal,delta);else if(key==='exposure')maxExposure=Math.max(maxExposure,delta);else if(key==='rgb')maxRGB=Math.max(maxRGB,delta);else maxAO=Math.max(maxAO,delta);
   }
  }
 }
 forestRibbonCheck(witness!==null&&sourceTriangleTargets.every(n=>n>0),'incomplete source/candidate UV overlay');
 // Exact half-step UV inputs and nondegenerate charts bound conditioning. This
 // deliberately generous double-arithmetic guard also grows with translation;
 // neither an exact-arithmetic proof nor a rendered appearance certificate is
 // claimed. Ideal piecewise-affine maxima occur at the overlay vertices above.
 const guard=1024*Number.EPSILON*blade.positionMagnitude/blade.minArea;
 return{diagonal,ids:ids.flat(),sourceTriangleTargets,positionErrorMetres:maxPosition,positionErrorUpperMetres:forestRibbonOutward(maxPosition+guard),arithmeticGuardMetres:guard,witness,
  interpolationDeviations:{normalVector:maxNormal,exposure:maxExposure,linearRGB:maxRGB,canopyAO:stride===15?maxAO:null,qualified:false}};
}

/**
 * Four complete source triangles -> two triangles per blade, reusing ONLY the
 * original outer-corner global vertex records, UVs, kind and material. Supports
 * conforming five/six-UV-vertex half-step partitions of the unit square; other
 * charts fail. UV values must be exactly0,.5,1; coordinates are never snapped.
 * vertexStride counts Float32 components (14 native /15 with source canopy AO).
 * Inputs and range remain untouched. New indices preserve each source UV winding.
 * Per-blade sourceTriangleTargets use bit0/bit1 for overlapping reduced triangles.
 * The static positional bound uses UV-corresponded piecewise-affine triangle
 * overlays. Normals/AO/normal maps, wind, clipping, visibility and appearance
 * require independent qualification; no thinning, leaf deletion or pixel claim.
 */
export function reduceForestLeafRibbons(vertices,indices,range={firstIndex:0,indexCount:indices?.length},{vertexStride=14}={}){
 forestRibbonCheck(vertices instanceof Float32Array&&[14,15].includes(vertexStride)&&vertices.length>0&&vertices.length%vertexStride===0&&vertices.byteLength<=512*1024*1024&&indices instanceof Uint32Array&&indices.length>0&&indices.byteLength<=512*1024*1024,'invalid source layout or stride14/15');
 forestRibbonCheck(forestRibbonUint(range?.firstIndex)&&range.firstIndex%3===0&&forestRibbonUint(range.indexCount)&&range.indexCount>0&&range.indexCount%12===0&&range.firstIndex+range.indexCount<=indices.length,'invalid complete four-triangle blade range');
 const leafCount=range.indexCount/12;forestRibbonCheck(leafCount<=500_000,'source blade budget exceeded');
 const reduced=new Uint32Array(leafCount*6),blades=[];let maximumPositionErrorUpperMetres=0;
 for(let leaf=0;leaf<leafCount;leaf++){
  const sourceFirstIndex=range.firstIndex+leaf*12,blade=forestRibbonBlade(vertices,indices,sourceFirstIndex,vertexStride),candidates=[0,1].map(d=>forestRibbonCandidate(vertices,vertexStride,blade,d));
  forestRibbonCheck(candidates.some(Boolean),'both outer-corner diagonals are spatially degenerate');
  const chosen=!candidates[0]?candidates[1]:!candidates[1]?candidates[0]:candidates[1].positionErrorUpperMetres<candidates[0].positionErrorUpperMetres?candidates[1]:candidates[0];
  const firstIndex=leaf*6;reduced.set(chosen.ids,firstIndex);maximumPositionErrorUpperMetres=Math.max(maximumPositionErrorUpperMetres,chosen.positionErrorUpperMetres);
  blades.push(Object.freeze({id:leaf,sourceFirstIndex,sourceIndexCount:12,firstIndex,indexCount:6,material:blade.material,kind:blade.kind,diagonal:chosen.diagonal,
   cornerVertexIDs:Object.freeze(blade.corners),sourceVertexIDs:Object.freeze(blade.sourceIDs),sourceTriangleTargets:Object.freeze(chosen.sourceTriangleTargets),positionErrorMetres:chosen.positionErrorMetres,positionErrorUpperMetres:chosen.positionErrorUpperMetres,arithmeticGuardMetres:chosen.arithmeticGuardMetres,
   diagonalPositionErrorsMetres:Object.freeze(candidates.map(c=>c?.positionErrorMetres??null)),diagonalPositionErrorBoundsMetres:Object.freeze(candidates.map(c=>c?.positionErrorUpperMetres??null)),witness:Object.freeze({...chosen.witness,uv:Object.freeze(chosen.witness.uv),sourcePosition:Object.freeze(chosen.witness.sourcePosition),reducedPosition:Object.freeze(chosen.witness.reducedPosition)}),interpolationDeviations:Object.freeze(chosen.interpolationDeviations)}));
 }
 const result=Object.freeze({format:'waterworld.forest-leaf-ribbons',version:1,vertexStride:vertexStride*4,leafCount,sourceTriangles:leafCount*4,triangles:leafCount*2,vertices,indices:reduced,blades:Object.freeze(blades),maximumPositionErrorUpperMetres,appearanceQualified:false,
  source:Object.freeze({vertices,indices,range:Object.freeze({firstIndex:range.firstIndex,indexCount:range.indexCount}),vertexStride:vertexStride*4}),
  limitations:Object.freeze(['Static UV-corresponded positional error with explicit double-arithmetic guard; not a formal exact-arithmetic certificate.','Original records are retained, but changed interpolation/normal maps/AO, wind, soil clipping, occlusion and rendered appearance remain unqualified.','Explicit offline/construction helper; no automatic startup authoring or runtime tier selection.'])}); forestRibbonResults.add(result);return result;
}


/** Explicit REVIEW construction only; never called automatically at startup.
 * The source inspection and reducer inputs must remain immutable. Its original
 * 60B byte view/materials/textures/source IDs are shared, not reauthored. The two
 * candidate frontiers each cover every source blade once; selection must choose
 * one representation per owner. ranges is keyed by selectionKey because source
 * node IDs deliberately occur twice. sourceRanges retains the original lookup.
 * Destroy is shared with the source inspection; both own the same texture set.
 */
export function prepareForestRibbonInspection(inspection,ribbons){
 forestRibbonCheck(inspection?.vertexStride===60&&inspection.vertices instanceof Uint8Array&&inspection.vertices.byteLength>0&&inspection.vertices.byteLength%60===0&&inspection.vertices.byteOffset%4===0&&inspection.indices instanceof Uint32Array&&inspection.indices.length>0&&inspection.indices.length%12===0,'inspection requires original60B complete blades');
 forestRibbonCheck(forestRibbonResults.has(ribbons)&&ribbons.vertexStride===60&&ribbons.appearanceQualified===false,'ribbons must be an original stride15 reducer result');
 const vertices=ribbons.vertices,original=inspection.indices,leafCount=original.length/12,vertexCount=inspection.vertices.byteLength/60;
 forestRibbonCheck(vertices===ribbons.source.vertices&&vertices.buffer===inspection.vertices.buffer&&vertices.byteOffset===inspection.vertices.byteOffset&&vertices.byteLength===inspection.vertices.byteLength&&ribbons.source.indices===original&&ribbons.source.range.firstIndex===0&&ribbons.source.range.indexCount===original.length,'ribbon source buffers or full membership differ from inspection');
 forestRibbonCheck(ribbons.indices instanceof Uint32Array&&ribbons.indices.length===original.length/2&&ribbons.leafCount===leafCount&&ribbons.blades.length===leafCount&&ribbons.sourceTriangles===original.length/3&&ribbons.triangles===ribbons.indices.length/3,'incomplete ribbon blade population');
 forestRibbonCheck(inspection.prototype?.leafCount===leafCount&&inspection.sourceIDs instanceof Uint32Array&&inspection.sourceIDs.length===vertexCount&&inspection.leafOrder instanceof Uint32Array&&inspection.leafOrder.length===leafCount&&Array.isArray(inspection.materials)&&inspection.materials.length>0&&inspection.textures instanceof Map&&inspection.ranges instanceof Map&&Array.isArray(inspection.clusters)&&inspection.clusters.length>0&&!inspection.reduction,'invalid original inspection membership/pointers');
 const materialIDs=new Set();for(const m of inspection.materials){forestRibbonCheck(forestRibbonUint(m?.index)&&!materialIDs.has(m.index),'invalid inspection source material IDs');materialIDs.add(m.index);}
 const sourceLeaves=new Uint8Array(leafCount);for(const id of inspection.leafOrder){forestRibbonCheck(id<leafCount&&!sourceLeaves[id],'inspection leaf order duplicates or omits source blades');sourceLeaves[id]=1;}
 const reducedNodes=[],originalNodes=[],ranges=new Map(),seen=new Set(),leafIntervals=[],deviationKeys=['normalVector','exposure','linearRGB','canopyAO'],interpolationDeviations={normalVector:0,exposure:0,linearRGB:0,canopyAO:0,qualified:false};let next=0,maximumError=0;
 for(const c of inspection.clusters){
  forestRibbonCheck(forestRibbonUint(c?.sourceNodeID)&&!seen.has(c.sourceNodeID)&&c.representation===undefined&&c.selectionKey===undefined&&c.firstIndex===next&&forestRibbonUint(c.indexCount)&&c.indexCount>0&&c.indexCount%12===0&&next+c.indexCount<=original.length&&forestRibbonUint(c.firstLeaf)&&forestRibbonUint(c.leafCount)&&c.leafCount>0&&c.indexCount===c.leafCount*12&&c.firstLeaf+c.leafCount<=leafCount,'inspection cluster ownership/ranges differ');seen.add(c.sourceNodeID);
  forestRibbonCheck(forestRibbonUint(c.firstVertex)&&forestRibbonUint(c.vertexCount)&&c.vertexCount>0&&c.firstVertex+c.vertexCount<=vertexCount&&Array.isArray(c.low)&&Array.isArray(c.high)&&c.low.length===3&&c.high.length===3&&c.low.every((n,k)=>Number.isFinite(n)&&Number.isFinite(c.high[k])&&n<=c.high[k])&&Number.isFinite(c.radius)&&c.radius>0,'invalid original cluster vertex/bound pointers');
  const sourceRange=inspection.ranges.get(c.sourceNodeID);forestRibbonCheck(sourceRange&&['firstVertex','vertexCount','firstIndex','indexCount'].every(k=>sourceRange[k]===c[k]),'inspection range map differs from source cluster');
  let error=0;const clusterDeviations={normalVector:0,exposure:0,linearRGB:0,canopyAO:0,qualified:false};
  for(let first=next;first<next+c.indexCount;first+=12){
   const id=first/12,b=ribbons.blades[id],members=new Set(original.subarray(first,first+12));
   forestRibbonCheck(b?.id===id&&b.sourceFirstIndex===first&&b.sourceIndexCount===12&&b.firstIndex===first/2&&b.indexCount===6&&[0,1].includes(b.diagonal)&&materialIDs.has(b.material)&&Number.isFinite(b.positionErrorUpperMetres)&&b.positionErrorUpperMetres>=0&&b.positionErrorUpperMetres>=b.positionErrorMetres&&members.size===b.sourceVertexIDs.length&&b.sourceVertexIDs.every(v=>members.has(v)),'ribbon blade source membership or error differs');
   for(const sourceID of members)forestRibbonCheck(sourceID>=c.firstVertex&&sourceID<c.firstVertex+c.vertexCount&&vertices[sourceID*15+13]===b.material&&vertices[sourceID*15+6]===b.kind&&c.low.every((v,k)=>vertices[sourceID*15+k]>=v-.001&&vertices[sourceID*15+k]<=c.high[k]+.001),'original blade escapes cluster/material/bound membership');
   const corners=b.cornerVertexIDs;forestRibbonCheck(corners.length===4&&corners.every((v,k)=>members.has(v)&&vertices[v*15+8]===forestRibbonCornerUV[k][0]&&vertices[v*15+9]===forestRibbonCornerUV[k][1]),'ribbon outer-corner membership changed');
   const expected=b.diagonal===0?[corners[0],corners[1],corners[2],corners[0],corners[2],corners[3]]:[corners[0],corners[1],corners[3],corners[1],corners[2],corners[3]],uv=Array.from(original.subarray(first,first+3),v=>[vertices[v*15+8],vertices[v*15+9]]);
   if(forestRibbonCross(...uv)<0)for(let at=0;at<6;at+=3)[expected[at+1],expected[at+2]]=[expected[at+2],expected[at+1]];
   for(let at=0;at<6;at++)forestRibbonCheck(ribbons.indices[first/2+at]===expected[at],'reduced indices changed original corner order/winding');
   forestRibbonCheck(b.interpolationDeviations?.qualified===false,'missing unqualified source interpolation deviations');for(const key of deviationKeys){const value=b.interpolationDeviations[key];forestRibbonCheck(Number.isFinite(value)&&value>=0,'invalid source interpolation deviation');clusterDeviations[key]=Math.max(clusterDeviations[key],value);}
   error=Math.max(error,b.positionErrorUpperMetres);
  }
  const reduced=Object.freeze({...c,representation:'ribbon',selectionKey:'ribbon:'+c.sourceNodeID,firstIndex:c.firstIndex/2,indexCount:c.indexCount/2,reductionErrorMetres:error,interpolationDeviations:Object.freeze(clusterDeviations),appearanceQualified:false}),full=Object.freeze({...c,representation:'original',selectionKey:'original:'+c.sourceNodeID,firstIndex:ribbons.indices.length+c.firstIndex,reductionErrorMetres:0});
  for(const key of deviationKeys)interpolationDeviations[key]=Math.max(interpolationDeviations[key],clusterDeviations[key]);
  reducedNodes.push(reduced);originalNodes.push(full);maximumError=Math.max(maximumError,error);leafIntervals.push([c.firstLeaf,c.firstLeaf+c.leafCount]);next+=c.indexCount;
  for(const n of [reduced,full])ranges.set(n.selectionKey,Object.freeze({firstVertex:n.firstVertex,vertexCount:n.vertexCount,firstIndex:n.firstIndex,indexCount:n.indexCount}));
 }
 forestRibbonCheck(next===original.length&&maximumError===ribbons.maximumPositionErrorUpperMetres,'incomplete original/ribbon index cover or maximum error');
 leafIntervals.sort((a,b)=>a[0]-b[0]);let end=0;for(const [low,high]of leafIntervals){forestRibbonCheck(low===end,'inspection source leaf intervals overlap or omit blades');end=high;}forestRibbonCheck(end===leafCount,'incomplete inspection source leaf frontier');
 const indices=new Uint32Array(ribbons.indices.length+original.length);indices.set(ribbons.indices);indices.set(original,ribbons.indices.length);
 const reduction=Object.freeze({format:'waterworld.forest-ribbon-inspection',version:1,appearanceQualified:false,maximumPositionErrorUpperMetres:maximumError,sourceTriangles:original.length/3,reducedTriangles:ribbons.indices.length/3,fullTriangles:indices.length/3,interpolationDeviations:Object.freeze(interpolationDeviations)});
 return Object.freeze({...inspection,indices,clusters:Object.freeze([...reducedNodes,...originalNodes]),ranges,sourceRanges:inspection.ranges,reduction});
}
