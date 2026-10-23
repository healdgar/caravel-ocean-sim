// Copyright (c) 2026 Six Cailloux, LLC. MIT.
/** Pilot metadata and a TEST/OFFLINE reference selector; never a frame-loop path.
 * Production selection/compaction remains GPU work. This module performs no I/O,
 * rendering, residency changes or synchronous readback. Receipt SHAs are schema
 * checked here, not verified against bytes, and never establish image likeness.
 *
 * v1: sourceReceipts{name:receipt}, placementReceipt, pages[{id,file,bytes,sha256,
 * role,dependencies:[],mipBytes:[texture-level bytes]}], tiers[{id:0..4}], roots[nodeID], nodes[{id,parent,
 * children,tier,kind:'representation'|'spatial-group',ownership[stable string ID],
 * pages,representation:'derived',interior,bounds:{low,high,windPaddingMetres},
 * costs:{main,shadow,reflection:{vertices,triangles}},geometryErrorMetres,
 * appearance:{status:'unqualified'|'qualified',qualifiedSizePixels:[min,max],
 * receipt,viewCone:{axis,halfAngleRadians,receipt}}}]. Only qualified appearance
 * needs an envelope/receipts; a new pilot asset can say status:'unqualified'.
 * Page bytes are decoded bytes (at most128MiB); texture mipBytes sum to them.
 * Size is a conservative projected bound diameter in drawing-buffer pixels.
 * View-cone axis points from the node's world-space centre toward the camera.
 * Bounds include scalar wind padding on ALL sides. Children exactly partition
 * parent ownership. A spatial-group may split within its own tier; other edges
 * strictly decrease tier. Reference pages may be recorded but never reachable
 * from any production node, even via dependencies. No raw-reference fallback.
 */
const PASSES=['main','shadow','reflection'];
const MAX_PAGE_BYTES=128*1024*1024;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isID=id=>typeof id==='string'&&ID.test(id);
const finite=Number.isFinite;
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(finite);
const receipt=r=>r&&uint(r.bytes)&&r.bytes>0&&r.bytes<=2**31&&/^[a-f0-9]{64}$/.test(r.sha256??'');
const require=(ok,message)=>{if(!ok)throw Error('Forest LOD: '+message);};
const unique=list=>Array.isArray(list)&&new Set(list).size===list.length;
const same=(a,b)=>{const members=new Set(b);return a.length===b.length&&new Set(a).size===a.length&&members.size===b.length&&a.every(x=>members.has(x));};
const path=file=>typeof file==='string'&&file.length>0&&file.length<=512&&!file.startsWith('/')&&!/[\\:#?%\u0000-\u001f]/.test(file)&&file.split('/').every(p=>p&&p!=='.'&&p!=='..');
const bounds=n=>({low:n.bounds.low.map(v=>v-n.bounds.windPaddingMetres),high:n.bounds.high.map(v=>v+n.bounds.windPaddingMetres)});

/** Validate topology, costs, source lineage declarations and complete ownership. */
export function validateForestLODManifest(m){
 require(m?.format==='waterworld.forest-lod'&&m.version===1&&m.units==='metres'&&m.upAxis==='Y','invalid manifest/version/coordinates');
 require(m.sourceReceipts&&typeof m.sourceReceipts==='object'&&!Array.isArray(m.sourceReceipts)&&Object.keys(m.sourceReceipts).length>0&&Object.keys(m.sourceReceipts).length<=256&&Object.values(m.sourceReceipts).every(receipt)&&receipt(m.placementReceipt),'missing source or placement receipts');
 require(Array.isArray(m.tiers)&&m.tiers.length===5&&same(m.tiers.map(t=>t.id),[0,1,2,3,4]),'tiers must identify 0..4 exactly');
 require(Array.isArray(m.pages)&&m.pages.length>0&&m.pages.length<=65536,'invalid page registry');
 const pages=new Map();
 for(const p of m.pages){
  require(isID(p?.id)&&!pages.has(p.id)&&path(p.file)&&receipt(p)&&p.bytes<=MAX_PAGE_BYTES&&['geometry','texture','metadata','reference'].includes(p.role)&&unique(p.dependencies)&&p.dependencies.every(isID),'invalid/duplicate page, size, role or dependency');
  if(p.role==='texture')require(Array.isArray(p.mipBytes)&&p.mipBytes.length>0&&p.mipBytes.length<=32&&p.mipBytes.every(n=>uint(n)&&n>0)&&p.mipBytes.reduce((sum,n)=>sum+n,0)===p.bytes,'invalid texture/mip byte accounting');
  require(p.referenceOnly===undefined||typeof p.referenceOnly==='boolean','invalid page referenceOnly');pages.set(p.id,p);
 }
 const referenceHashes=new Set(m.pages.filter(p=>p.role==='reference'||p.referenceOnly===true).map(p=>p.sha256)),referenceFiles=new Set(m.pages.filter(p=>p.role==='reference'||p.referenceOnly===true).map(p=>p.file));
 const pageClosures=new Map(),pageActive=new Set();
 function closure(id,depth=0){
  require(depth<=64,'page dependency depth exceeds GPU metadata bound');
  require(pages.has(id),'missing page dependency '+id);require(!pageActive.has(id),'page dependency cycle');
  if(pageClosures.has(id))return pageClosures.get(id);
  pageActive.add(id);const result=new Set([id]);for(const child of pages.get(id).dependencies)for(const item of closure(child,depth+1))result.add(item);
  pageActive.delete(id);pageClosures.set(id,result);return result;
 }
 for(const id of pages.keys())closure(id);
 require(Array.isArray(m.nodes)&&m.nodes.length>0&&m.nodes.length<=1000000&&unique(m.roots)&&m.roots.length>0,'invalid node/root registry');
 const nodes=new Map();let ownershipEntries=0;
 for(const n of m.nodes){
  require(isID(n?.id)&&!nodes.has(n.id)&&(n.parent===null||isID(n.parent))&&unique(n.children)&&n.children.every(isID)&&uint(n.tier)&&n.tier<=4&&['representation','spatial-group'].includes(n.kind),'invalid/duplicate node or links');
  require(n.representation==='derived'&&typeof n.interior==='boolean','production node must be derived, with explicit interior support');
  require(unique(n.ownership)&&n.ownership.length>0&&n.ownership.every(isID),'invalid/duplicate ownership');
  ownershipEntries+=n.ownership.length;require(ownershipEntries<=8000000,'ownership metadata budget exceeded');
  require(unique(n.pages)&&n.pages.length>0&&n.pages.every(id=>pages.has(id)),'broken node page reference');
  const dependencies=new Set(n.pages.flatMap(id=>[...pageClosures.get(id)]));
  require([...dependencies].every(id=>{const p=pages.get(id);return p.role!=='reference'&&p.referenceOnly!==true&&!referenceHashes.has(p.sha256)&&!referenceFiles.has(p.file);}),'production tier reaches raw reference page or alias');
  require([...dependencies].some(id=>pages.get(id).role==='geometry'),'node has no geometry page');
  require(vector(n.bounds?.low)&&vector(n.bounds.high)&&n.bounds.low.every((v,k)=>v<=n.bounds.high[k])&&finite(n.bounds.windPaddingMetres)&&n.bounds.windPaddingMetres>=0&&n.bounds.low.some((v,k)=>v<n.bounds.high[k]),'invalid world/wind bounds');
  require(n.costs&&same(Object.keys(n.costs),PASSES),'missing/unaccounted pass costs');
  for(const pass of PASSES){const c=n.costs[pass];require(c&&uint(c.vertices)&&c.vertices<=0xffffffff&&uint(c.triangles)&&c.triangles<=0xffffffff&&(c.triangles===0?c.vertices===0:c.vertices>=3),'invalid '+pass+' geometry cost');}
  require(n.costs.main.triangles>0,'nonempty ownership needs drawable geometry');
  require(finite(n.geometryErrorMetres)&&n.geometryErrorMetres>=0,'invalid geometric deviation estimate');
  const a=n.appearance;require(a&&['unqualified','qualified'].includes(a.status),'explicit appearance status required');
  if(a.status==='qualified'||a.qualifiedSizePixels!==undefined)require(Array.isArray(a.qualifiedSizePixels)&&a.qualifiedSizePixels.length===2&&a.qualifiedSizePixels.every(finite)&&a.qualifiedSizePixels[0]>=0&&a.qualifiedSizePixels[1]>a.qualifiedSizePixels[0],'invalid qualified pixel envelope');
  if(a.status==='qualified'||a.receipt!==undefined)require(receipt(a.receipt),'missing rendered appearance receipt');
  if(a.status==='qualified'||a.viewCone!==undefined){const cone=a.viewCone;require(vector(cone?.axis)&&Math.abs(Math.hypot(...cone.axis)-1)<1e-5&&finite(cone.halfAngleRadians)&&cone.halfAngleRadians>=0&&cone.halfAngleRadians<=Math.PI&&receipt(cone.receipt),'invalid qualified view cone/receipt');}
  nodes.set(n.id,n);
 }
 const rootSet=new Set(m.roots);require(m.roots.every(id=>nodes.has(id)&&nodes.get(id).parent===null),'missing/parented root');
 const visited=new Set(),active=new Set();
 function visit(id,depth=0){
  require(depth<=64,'hierarchy depth exceeds GPU metadata bound');require(!active.has(id),'hierarchy cycle');require(!visited.has(id),'duplicate hierarchy coverage');
  const n=nodes.get(id);require(n,'missing child '+id);active.add(id);
  if(n.children.length){const ownership=new Set(),parentBounds=bounds(n);
   for(const childID of n.children){const child=nodes.get(childID);require(child&&child.parent===id,'broken child/parent link');
    require(child.tier<n.tier||(child.tier===n.tier&&n.kind==='spatial-group'),'child must refine tier or explicit spatial grouping');
    const childBounds=bounds(child);require(childBounds.low.every((v,k)=>v>=parentBounds.low[k]-1e-6&&childBounds.high[k]<=parentBounds.high[k]+1e-6),'child wind bounds escape parent');
    for(const owner of child.ownership){require(!ownership.has(owner),'overlapping child ownership');ownership.add(owner);}visit(childID,depth+1);
   }
   require(same([...ownership],n.ownership),'children must exactly partition parent ownership');
  }
  active.delete(id);visited.add(id);
 }
 const rootOwners=new Set();for(const id of m.roots){for(const owner of nodes.get(id).ownership){require(!rootOwners.has(owner),'overlapping root ownership');rootOwners.add(owner);}visit(id);}
 require(visited.size===nodes.size&&m.nodes.every(n=>(n.parent===null)===rootSet.has(n.id)),'unreachable node/cycle or undeclared root');
 return m;
}

function checkedCamera(camera){
 require(vector(camera?.position)&&vector(camera.forward)&&Math.abs(Math.hypot(...camera.forward)-1)<1e-5&&finite(camera.framebufferHeight)&&camera.framebufferHeight>0&&finite(camera.verticalFovRadians)&&camera.verticalFovRadians>0&&camera.verticalFovRadians<Math.PI&&finite(camera.near)&&camera.near>0,'invalid drawing-buffer camera');return camera;
}
/** Conservative bound projection, not an appearance/coverage certificate. */
export function projectForestLODBounds(box,camera,errorMetres=0){
 checkedCamera(camera);require(vector(box?.low)&&vector(box.high)&&box.low.every((v,k)=>v<=box.high[k])&&finite(box.windPaddingMetres)&&box.windPaddingMetres>=0&&finite(errorMetres)&&errorMetres>=0,'invalid projection bound/error');
 const low=box.low.map(v=>v-box.windPaddingMetres),high=box.high.map(v=>v+box.windPaddingMetres),centre=low.map((v,k)=>(v+high[k])*.5),relative=centre.map((v,k)=>v-camera.position[k]);
 const radius=Math.hypot(...high.map((v,k)=>(v-low[k])*.5)),distance=Math.hypot(...relative),depth=relative.reduce((sum,v,k)=>sum+v*camera.forward[k],0),nearestDepth=depth-radius;
 const lateral=Math.hypot(...relative.map((v,k)=>v-depth*camera.forward[k]))+radius,focal=camera.framebufferHeight/(2*Math.tan(camera.verticalFovRadians*.5));
 const inside=low.every((v,k)=>camera.position[k]>=v&&camera.position[k]<=high[k]),nearCrossing=nearestDepth<=camera.near;
 const errorPixels=errorMetres===0?0:nearCrossing||nearestDepth<=errorMetres?1e30:focal*errorMetres*Math.hypot(1,lateral/nearestDepth)/(nearestDepth-errorMetres);
 return{sizePixels:2*focal*radius/Math.max(nearestDepth,camera.near),errorPixels,nearestDepth,inside,nearCrossing,viewDirection:distance>0?relative.map(v=>-v/distance):[0,0,0]};
}

const addCosts=(a,b,sign=1)=>Object.fromEntries(PASSES.map(pass=>[pass,{vertices:a[pass].vertices+sign*b[pass].vertices,triangles:a[pass].triangles+sign*b[pass].triangles}]));
const zeroCosts=()=>Object.fromEntries(PASSES.map(pass=>[pass,{vertices:0,triangles:0}]));
const sumCosts=nodes=>nodes.reduce((sum,n)=>addCosts(sum,n.costs),zeroCosts());
const overflow=(costs,budget)=>({main:Math.max(0,costs.main.triangles-budget.main),shadow:Math.max(0,costs.shadow.triangles-budget.shadow),reflection:Math.max(0,costs.reflection.triangles-budget.reflection),additional:Math.max(0,costs.shadow.triangles+costs.reflection.triangles-budget.additional)});

/** Reference only: complete coarsest cover, then atomic budgeted refinements.
 * residentPages is a Set/array of fully decoded/verified GPU-resident page IDs.
 * Missing finer pages retain an applicable parent; no last-frame/CPU renderer is
 * hidden here. allowUnqualified explicitly enables review ONLY, retains reports,
 * and cannot bypass interior/near-plane, geometric or hard-budget restrictions.
 * On missing mandatory cover or budget failure selected=[]; complete=false is a
 * release gate, never an instruction to draw holes or substitute raw originals.
 */
export function chooseForestLODFrontier(manifest,{camera,residentPages=[],triangleBudgets={},allowUnqualified=false,maxErrorPixels=3}={}){
 validateForestLODManifest(manifest);checkedCamera(camera);
 require(typeof allowUnqualified==='boolean'&&finite(maxErrorPixels)&&maxErrorPixels>0&&maxErrorPixels<=3,'invalid review/error policy');
 const budget={main:6000000,shadow:2000000,reflection:2000000,additional:2000000,...triangleBudgets};
 require(same(Object.keys(budget),['main','shadow','reflection','additional'])&&Object.values(budget).every(uint),'invalid hard triangle budgets');
 const resident=new Set(residentPages),pages=new Map(manifest.pages.map(p=>[p.id,p])),nodes=new Map(manifest.nodes.map(n=>[n.id,n])),requests=new Set(),diagnostics=new Map(),evaluations=new Map();
 require([...resident].every(id=>pages.has(id)),'unknown resident page');
 const pageRequirements=new Map();
 const dependencies=id=>{if(!pageRequirements.has(id)){const set=new Set([id]);for(const child of pages.get(id).dependencies)for(const item of dependencies(child))set.add(item);pageRequirements.set(id,[...set]);}return pageRequirements.get(id);};
 function evaluate(n){
  if(evaluations.has(n.id))return evaluations.get(n.id);
  const projection=projectForestLODBounds(n.bounds,camera,n.geometryErrorMetres),a=n.appearance,reasons=[];
  if((projection.inside||projection.nearCrossing)&&!n.interior)reasons.push('exterior-near-or-inside');
  if(projection.errorPixels>maxErrorPixels)reasons.push('geometric-deviation');
  let appearanceQualified=a.status==='qualified';
  if(!appearanceQualified)reasons.push('appearance-unqualified');
  else{
   if(projection.sizePixels<a.qualifiedSizePixels[0]||projection.sizePixels>a.qualifiedSizePixels[1]){appearanceQualified=false;reasons.push('outside-qualified-size');}
   const direction=projection.viewDirection,cone=a.viewCone;
   if((Math.hypot(...direction)===0&&cone.halfAngleRadians<Math.PI)||direction.reduce((sum,v,k)=>sum+v*cone.axis[k],0)<Math.cos(cone.halfAngleRadians)-1e-7){appearanceQualified=false;reasons.push('outside-qualified-view');}
  }
  const structural=reasons.some(reason=>reason==='exterior-near-or-inside'||reason==='geometric-deviation'),eligible=!structural&&(appearanceQualified||allowUnqualified),required=new Set(n.pages.flatMap(dependencies)),missing=[...required].filter(id=>!resident.has(id));
  const result={projection,appearanceQualified,eligible,missing,reasons};evaluations.set(n.id,result);return result;
 }
 function coarsest(n){
  const e=evaluate(n);
  if(e.eligible){for(const id of e.missing)requests.add(id);if(!e.missing.length)return[n];}
  const childCover=n.children.map(id=>coarsest(nodes.get(id)));
  if(childCover.length&&childCover.every(Boolean))return childCover.flat();
  diagnostics.set(n.id,e.reasons.length?e.reasons:['not-resident']);return null;
 }
 // Independent per-budget minima prove impossibility only when at least one
 // limit cannot be met by ANY valid resident cover. They do not prove that
 // simultaneously attaining four separate minima is possible (no optimizer).
 const minimums=new Map(),keys=['main','shadow','reflection','additional'];
 function lowerBound(n){
  if(minimums.has(n.id))return minimums.get(n.id);const e=evaluate(n),children=n.children.map(id=>lowerBound(nodes.get(id)));
  const own=e.eligible&&!e.missing.length?{main:n.costs.main.triangles,shadow:n.costs.shadow.triangles,reflection:n.costs.reflection.triangles,additional:n.costs.shadow.triangles+n.costs.reflection.triangles}:null;
  const values=Object.fromEntries(keys.map(key=>[key,Math.min(own?.[key]??Infinity,children.length?children.reduce((sum,value)=>sum+value[key],0):Infinity)]));minimums.set(n.id,values);return values;
 }
 const roots=manifest.roots.map(id=>coarsest(nodes.get(id))),missingCoverage=manifest.roots.filter((_,index)=>!roots[index]),budgetLimited=[];
 let selected=missingCoverage.length?[]:roots.flat(),attemptedCosts=sumCosts(selected),failure=missingCoverage.length?'missing-valid-cover':null;
 let exceeded=overflow(attemptedCosts,budget);
 if(!failure&&Object.values(exceeded).some(v=>v>0)){failure='mandatory-cover-over-budget';selected=[];}
 if(!failure){
  for(;;){const candidates=[];
   for(const parent of selected){if(!parent.children.length)continue;const covers=parent.children.map(id=>coarsest(nodes.get(id)));if(covers.some(cover=>!cover))continue;const children=covers.flat(),costs=addCosts(addCosts(attemptedCosts,parent.costs,-1),sumCosts(children));
    if(Object.values(overflow(costs,budget)).some(v=>v>0)){budgetLimited.push(parent.id);continue;}
    const increase=Math.max(1,costs.main.triangles-attemptedCosts.main.triangles);candidates.push({parent,children,costs,priority:evaluate(parent).projection.sizePixels/increase});
   }
   if(!candidates.length)break;candidates.sort((a,b)=>b.priority-a.priority||(a.parent.id<b.parent.id?-1:a.parent.id>b.parent.id?1:0));const best=candidates[0];selected=selected.flatMap(n=>n===best.parent?best.children:[n]);attemptedCosts=best.costs;
  }
 }
 const unqualified=[...evaluations].filter(([,e])=>!e.appearanceQualified).map(([id,e])=>({id,selected:selected.some(n=>n.id===id),reasons:e.reasons}));
 const minimumCosts=Object.fromEntries(keys.map(key=>[key,manifest.roots.reduce((sum,id)=>sum+lowerBound(nodes.get(id))[key],0)]));
 const impossible=failure==='mandatory-cover-over-budget'&&keys.some(key=>minimumCosts[key]>budget[key]);
 return{selected:selected.map(n=>n.id),complete:!failure,failure,missingCoverage,requestedPages:[...requests].sort(),costs:sumCosts(selected),attemptedCosts,
  budget:{limits:budget,overflow:exceeded,maxOverflow:Math.max(...Object.values(exceeded)),satisfied:failure!=='mandatory-cover-over-budget',impossible,minimumCosts,scope:'Independent valid-resident-cover minima; not a global cost optimizer'},
  unqualified,blocked:[...diagnostics].map(([id,reasons])=>({id,reasons})),budgetLimited:[...new Set(budgetLimited)],appearanceQualified:!failure&&selected.every(n=>evaluate(n).appearanceQualified),qualificationScope:'Declared rendered size/view applicability only; receipts not verified here; no likeness certificate'};
}

/** Shared projection/eligibility arithmetic for the eventual compute selector.
 * No bindings, dispatches, draw loops or receipt-derived qualification flags.
 * Inputs are validated manifest/camera values; zero view direction means the
 * camera is at centre and requires an all-direction appearance qualification.
 */
export const FOREST_LOD_POLICY_WGSL=/* wgsl */`
struct ForestLODProjection {sizePixels:f32,errorPixels:f32,nearestDepth:f32,inside:u32,nearCrossing:u32,viewDirection:vec3f};
fn forestLODProjectBounds(low:vec3f,high:vec3f,wind:f32,camera:vec3f,forward:vec3f,height:f32,fovY:f32,near:f32,error:f32)->ForestLODProjection{
 let lo=low-vec3f(wind);let hi=high+vec3f(wind);let centre=(lo+hi)*.5;let relative=centre-camera;let radius=length((hi-lo)*.5);
 let depth=dot(relative,forward);let nearest=depth-radius;let lateral=length(relative-depth*forward)+radius;let focal=height/(2.*tan(fovY*.5));
 var projectedError=0.;if(error>0.){projectedError=1e30;if(nearest>near&&nearest>error){projectedError=focal*error*sqrt(1.+(lateral/nearest)*(lateral/nearest))/(nearest-error);}}
 var direction=vec3f(0);if(length(relative)>0.){direction=-normalize(relative);}
 var result:ForestLODProjection;result.sizePixels=2.*focal*radius/max(nearest,near);result.errorPixels=projectedError;result.nearestDepth=nearest;
 result.inside=select(0u,1u,all(camera>=lo)&&all(camera<=hi));result.nearCrossing=select(0u,1u,nearest<=near);result.viewDirection=direction;return result;
}
fn forestLODAppearanceEligible(projected:ForestLODProjection,statusQualified:u32,sizeRange:vec2f,viewAxis:vec3f,viewHalfAngle:f32)->bool{
 if(statusQualified!=1u||projected.sizePixels<sizeRange.x||projected.sizePixels>sizeRange.y){return false;}
 if(length(projected.viewDirection)==0.&&viewHalfAngle<3.141592653589793){return false;}
 return dot(projected.viewDirection,viewAxis)>=cos(viewHalfAngle)-1e-7;
}
fn forestLODTierEligible(projected:ForestLODProjection,interior:u32,appearanceEligible:bool,allowUnqualified:u32,maxErrorPixels:f32)->bool{
 if((projected.inside!=0u||projected.nearCrossing!=0u)&&interior!=1u){return false;}
 if(projected.errorPixels>min(maxErrorPixels,3.)){return false;}
 return appearanceEligible||allowUnqualified==1u;
}
`;
