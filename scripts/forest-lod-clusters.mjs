// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline source-blade hierarchy. No reduction, new foliage or runtime policy.
const forestLodClusterLimit=500_000;
const forestLodClusterUint=n=>Number.isSafeInteger(n)&&n>=0;
const forestLodClusterRequire=(ok,message)=>{if(!ok)throw Error(message);};
const forestLodClusterVec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);

function forestLodClusterBlade(vertices,indices,first,leafTriangles){
 const parent=Array.from({length:leafTriangles},(_,i)=>i),byID=new Map(),byPosition=new Map(),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],centroid=[0,0,0];let material=-1;
 const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
 const join=(a,b)=>{parent[find(b)]=find(a);};
 for(let triangle=0;triangle<leafTriangles;triangle++){
  const corners=[];
  for(let corner=0;corner<3;corner++){
   const id=indices[first+triangle*3+corner],at=id*14,current=vertices[at+13],kind=vertices[at+6],position=[vertices[at],vertices[at+1],vertices[at+2]],key=position.join(',');
   forestLodClusterRequire(forestLodClusterUint(current)&&current<128&&forestLodClusterUint(kind)&&kind>=4&&kind<132,'Invalid native blade material/kind');
   if(material<0)material=current;else forestLodClusterRequire(current===material,'Native blade crosses materials');
   if(byID.has(id))join(triangle,byID.get(id));else byID.set(id,triangle);
   // Some exports duplicate a seam vertex with another ID/normal/UV. Exact
   // positional contact establishes connectivity only; source IDs stay intact.
   if(byPosition.has(key))join(triangle,byPosition.get(key));else byPosition.set(key,triangle);
   for(let k=0;k<3;k++){low[k]=Math.min(low[k],position[k]);high[k]=Math.max(high[k],position[k]);centroid[k]+=position[k];}
   corners.push(position);
  }
  const a=corners[0],b=corners[1],c=corners[2],u=b.map((v,k)=>v-a[k]),v=c.map((n,k)=>n-a[k]);
  forestLodClusterRequire(u[1]*v[2]-u[2]*v[1]!==0||u[2]*v[0]-u[0]*v[2]!==0||u[0]*v[1]-u[1]*v[0]!==0,'Degenerate native blade triangle');
 }
 for(let triangle=1;triangle<leafTriangles;triangle++)forestLodClusterRequire(find(triangle)===find(0),'Disconnected triangles in native blade');
 return{low,high,centroid:centroid.map(v=>v/(leafTriangles*3)),material};
}

/**
 * Inputs are immutable source references: Float32x14 native records and global
 * Uint32 vertex IDs. Every leaf is leafTriangles consecutive ordered triangles.
 * Returns one shared reordered index stream; nodes own ranges, never copies:
 *   leafOrder[firstLeaf..+leafCount] -> original source leaf ordinals
 *   orderedIndices[firstIndex..+indexCount] -> original global vertex IDs
 * Node bounds describe static source geometry, with no wind/appearance claim.
 */
export function partitionForestLeaves(vertices,indices,range,{leafTriangles=4,maxDepth=24,maxLeaves=32}={}){
 forestLodClusterRequire(vertices instanceof Float32Array&&vertices.length>0&&vertices.length%14===0&&vertices.byteLength<=512*1024*1024&&indices instanceof Uint32Array&&indices.length>0&&indices.length<=0xffffffff&&indices.byteLength<=512*1024*1024,'Invalid native leaf source layout/budget');
 forestLodClusterRequire(forestLodClusterUint(leafTriangles)&&leafTriangles>=1&&leafTriangles<=64&&forestLodClusterUint(maxDepth)&&maxDepth<=32&&forestLodClusterUint(maxLeaves)&&maxLeaves>=1&&maxLeaves<=forestLodClusterLimit,'Invalid native leaf hierarchy options');
 const indicesPerLeaf=leafTriangles*3;
 forestLodClusterRequire(forestLodClusterUint(range?.firstIndex)&&range.firstIndex%3===0&&forestLodClusterUint(range.indexCount)&&range.indexCount>0&&range.indexCount%indicesPerLeaf===0&&range.firstIndex+range.indexCount<=indices.length,'Invalid complete native blade range');
 const leafCount=range.indexCount/indicesPerLeaf,vertexCount=vertices.length/14;
 forestLodClusterRequire(leafCount<=forestLodClusterLimit,'Native leaf count exceeds hierarchy budget');
 for(const value of vertices)forestLodClusterRequire(Number.isFinite(value),'Nonfinite native leaf source vertex');
 for(const id of indices)forestLodClusterRequire(id<vertexCount,'Native leaf source index outside vertices');
 const leafOrder=new Uint32Array(leafCount),leafMaterials=new Uint32Array(leafCount),bounds=new Float64Array(leafCount*6),centroids=new Float64Array(leafCount*3);
 for(let leaf=0;leaf<leafCount;leaf++){
  const blade=forestLodClusterBlade(vertices,indices,range.firstIndex+leaf*indicesPerLeaf,leafTriangles);leafOrder[leaf]=leaf;leafMaterials[leaf]=blade.material;
  bounds.set(blade.low,leaf*6);bounds.set(blade.high,leaf*6+3);centroids.set(blade.centroid,leaf*3);
 }
 const nodes=[];
 const build=(firstLeaf,count,parent,depth)=>{
  const id=nodes.length,low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],centroidLow=[Infinity,Infinity,Infinity],centroidHigh=[-Infinity,-Infinity,-Infinity];
  for(let at=firstLeaf;at<firstLeaf+count;at++)for(let k=0;k<3;k++){
   const leaf=leafOrder[at];low[k]=Math.min(low[k],bounds[leaf*6+k]);high[k]=Math.max(high[k],bounds[leaf*6+3+k]);centroidLow[k]=Math.min(centroidLow[k],centroids[leaf*3+k]);centroidHigh[k]=Math.max(centroidHigh[k],centroids[leaf*3+k]);
  }
  const node={id,parent,children:[],depth,firstLeaf,leafCount:count,firstIndex:firstLeaf*indicesPerLeaf,indexCount:count*indicesPerLeaf,low,high,centre:low.map((v,k)=>(v+high[k])*.5)};nodes.push(node);
  if(count>maxLeaves&&depth<maxDepth){
   let axis=0;for(let k=1;k<3;k++)if(centroidHigh[k]-centroidLow[k]>centroidHigh[axis]-centroidLow[axis])axis=k;
   leafOrder.subarray(firstLeaf,firstLeaf+count).sort((a,b)=>centroids[a*3+axis]-centroids[b*3+axis]||a-b);
   const leftCount=Math.floor(count/2);node.children=[build(firstLeaf,leftCount,id,depth+1),build(firstLeaf+leftCount,count-leftCount,id,depth+1)];
  }
  Object.freeze(node.children);Object.freeze(node.low);Object.freeze(node.high);Object.freeze(node.centre);Object.freeze(node);return id;
 };
 const root=build(0,leafCount,-1,0),orderedIndices=new Uint32Array(range.indexCount);
 for(let at=0;at<leafCount;at++){
  const first=range.firstIndex+leafOrder[at]*indicesPerLeaf;orderedIndices.set(indices.subarray(first,first+indicesPerLeaf),at*indicesPerLeaf);
 }
 return Object.freeze({format:'waterworld.forest-leaf-hierarchy',version:1,root,leafTriangles,indicesPerLeaf,leafCount,leafOrder,leafMaterials,nodes:Object.freeze(nodes),orderedIndices,
  options:Object.freeze({maxDepth,maxLeaves}),source:Object.freeze({vertices,indices,range:Object.freeze({firstIndex:range.firstIndex,indexCount:range.indexCount}),vertexStride:56})});
}

function forestLodClusterHierarchy(h){
 forestLodClusterRequire(h?.format==='waterworld.forest-leaf-hierarchy'&&h.version===1&&forestLodClusterUint(h.leafCount)&&h.leafCount>0&&h.leafCount<=forestLodClusterLimit&&forestLodClusterUint(h.leafTriangles)&&h.leafTriangles>=1&&h.leafTriangles<=64&&h.indicesPerLeaf===h.leafTriangles*3&&
  h.leafOrder instanceof Uint32Array&&h.leafOrder.length===h.leafCount&&h.leafMaterials instanceof Uint32Array&&h.leafMaterials.length===h.leafCount&&h.orderedIndices instanceof Uint32Array&&h.orderedIndices.length===h.leafCount*h.indicesPerLeaf&&
  Array.isArray(h.nodes)&&h.nodes.length>0&&h.nodes.length<=h.leafCount*2-1&&h.root===0&&h.source?.vertices instanceof Float32Array&&h.source.vertices.length%14===0&&h.source.indices instanceof Uint32Array&&forestLodClusterUint(h.source.range?.firstIndex)&&h.source.range.indexCount===h.orderedIndices.length&&h.source.range.firstIndex+h.source.range.indexCount<=h.source.indices.length,'Invalid native leaf hierarchy');
 const root=forestLodClusterNode(h,h.root);forestLodClusterRequire(root.parent===-1&&root.depth===0&&root.firstLeaf===0&&root.leafCount===h.leafCount,'Invalid native leaf hierarchy root');return h;
}
function forestLodClusterNode(h,id){
 const n=h.nodes[id];
 forestLodClusterRequire(forestLodClusterUint(id)&&id<h.nodes.length&&n?.id===id&&Number.isSafeInteger(n.parent)&&forestLodClusterUint(n.depth)&&n.depth<=32&&forestLodClusterUint(n.firstLeaf)&&forestLodClusterUint(n.leafCount)&&n.leafCount>0&&n.firstLeaf+n.leafCount<=h.leafCount&&n.firstIndex===n.firstLeaf*h.indicesPerLeaf&&n.indexCount===n.leafCount*h.indicesPerLeaf&&Array.isArray(n.children)&&(n.children.length===0||n.children.length===2)&&forestLodClusterVec(n.low)&&forestLodClusterVec(n.high)&&forestLodClusterVec(n.centre)&&n.low.every((v,k)=>v<=n.high[k]&&n.centre[k]===(v+n.high[k])*.5),'Invalid native leaf hierarchy node/range');return n;
}

/** Coarsest complete cover at <=maxLeaves per node; unavailable refinement fails. */
export function selectForestClusterFrontier(hierarchy,maxLeaves){
 const h=forestLodClusterHierarchy(hierarchy);forestLodClusterRequire(forestLodClusterUint(maxLeaves)&&maxLeaves>=1,'Invalid native leaf frontier size');
 const selected=[],stack=[h.root],visited=new Set(),covered=new Uint8Array(h.leafCount);
 while(stack.length){
  const id=stack.pop(),node=forestLodClusterNode(h,id);forestLodClusterRequire(!visited.has(id),'Repeated native leaf hierarchy child');visited.add(id);
  if(node.leafCount<=maxLeaves){
   selected.push(id);
   for(let at=node.firstLeaf;at<node.firstLeaf+node.leafCount;at++){
    const leaf=h.leafOrder[at];forestLodClusterRequire(leaf<h.leafCount&&!covered[leaf],'Overlapping native leaf frontier ownership');covered[leaf]=1;
   }
   continue;
  }
  forestLodClusterRequire(node.children.length===2,'Requested native leaf refinement unavailable at hierarchy terminal');
  const left=forestLodClusterNode(h,node.children[0]),right=forestLodClusterNode(h,node.children[1]);
  forestLodClusterRequire(left.id!==right.id&&left.parent===id&&right.parent===id&&left.depth===node.depth+1&&right.depth===node.depth+1&&left.firstLeaf===node.firstLeaf&&right.firstLeaf===left.firstLeaf+left.leafCount&&left.leafCount+right.leafCount===node.leafCount,'Broken native leaf parent/child cover');
  stack.push(right.id,left.id);
 }
 forestLodClusterRequire(covered.every(v=>v===1),'Incomplete native leaf frontier');return selected;
}

/** Copies selected disjoint node ranges in caller order, including partial covers. */
export function assembleForestClusterIndices(hierarchy,nodeIDs){
 const h=forestLodClusterHierarchy(hierarchy);forestLodClusterRequire((Array.isArray(nodeIDs)||nodeIDs instanceof Uint32Array)&&nodeIDs.length<=h.nodes.length,'Invalid native leaf node selection');
 const selected=Array.from(nodeIDs,id=>forestLodClusterNode(h,id)),intervals=[...selected].sort((a,b)=>a.firstLeaf-b.firstLeaf);let end=-1,total=0;
 for(const node of intervals){forestLodClusterRequire(node.firstLeaf>=end,'Overlapping native leaf node selection');end=node.firstLeaf+node.leafCount;total+=node.indexCount;}
 const assembled=new Uint32Array(total),seen=new Set();let cursor=0;
 for(const node of selected){
  for(let at=node.firstLeaf;at<node.firstLeaf+node.leafCount;at++){
   const leaf=h.leafOrder[at];forestLodClusterRequire(leaf<h.leafCount&&!seen.has(leaf),'Overlapping native blade membership');seen.add(leaf);
   const sourceFirst=h.source.range.firstIndex+leaf*h.indicesPerLeaf,orderedFirst=at*h.indicesPerLeaf,material=h.leafMaterials[leaf];
   for(let k=0;k<h.indicesPerLeaf;k++){
    const id=h.orderedIndices[orderedFirst+k];forestLodClusterRequire(id===h.source.indices[sourceFirst+k]&&id*14+13<h.source.vertices.length&&h.source.vertices[id*14+13]===material,'Native blade indices/material changed after partition');assembled[cursor++]=id;
   }
  }
 }
 return assembled;
}
