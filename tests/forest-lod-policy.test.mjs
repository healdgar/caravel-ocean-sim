// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Pure reference/schema tests, not GPU/runtime or appearance qualification.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateForestLODManifest,chooseForestLODFrontier,projectForestLODBounds,FOREST_LOD_POLICY_WGSL} from '../js/forest-lod-policy.js';

const receipt=n=>({bytes:100,sha256:n.toString(16).padStart(64,'0')});
const camera=()=>({position:[0,0,-100],forward:[0,0,1],framebufferHeight:1080,verticalFovRadians:Math.PI/3,near:.1});
const costs=(main,shadow=0,reflection=0)=>Object.fromEntries(Object.entries({main,shadow,reflection}).map(([key,triangles])=>[key,{triangles,vertices:triangles?triangles*3:0}]));
const qualified=()=>({status:'qualified',qualifiedSizePixels:[0,1e9],receipt:receipt(100),viewCone:{axis:[0,0,-1],halfAngleRadians:Math.PI,receipt:receipt(101)}});
function fixture(){
 const page=(id,n,role='geometry',dependencies=['material'])=>({id,file:id+'.bin',...receipt(n),role,dependencies,...(role==='texture'?{mipBytes:[100]}:{})});
 const node=(id,parent,tier,ownership,pages,low,high)=>({id,parent,children:[],tier,kind:'representation',ownership,pages,representation:'derived',interior:true,bounds:{low,high,windPaddingMetres:0},costs:costs(80,20,10),geometryErrorMetres:0,appearance:qualified()});
 const a=node('a','stand',3,['oak'],['near-a'],[-4,-2,-2],[-.25,2,2]),b=node('b','stand',3,['birch'],['near-b'],[.25,-2,-2],[4,2,2]);
 const stand=node('stand',null,4,['oak','birch'],['coarse'],[-5,-3,-3],[5,3,3]);stand.children=['a','b'];stand.interior=false;stand.costs=costs(100,20,10);stand.geometryErrorMetres=.01;
 return{format:'waterworld.forest-lod',version:1,units:'metres',upAxis:'Y',sourceReceipts:{originalMesh:receipt(1),originalMaps:receipt(2)},placementReceipt:receipt(3),
  pages:[page('coarse',4),page('material',5,'texture',[]),page('reference',6,'reference',[]),page('near-a',7),page('near-b',8)],tiers:[0,1,2,3,4].map(id=>({id})),roots:['stand'],nodes:[stand,a,b]};
}
const allPages=m=>m.pages.filter(p=>p.role!=='reference').map(p=>p.id);
const choose=(m,options={})=>chooseForestLODFrontier(m,{camera:camera(),residentPages:allPages(m),...options});
function assertExactCover(m,result){
 assert.equal(result.complete,true);const nodes=new Map(m.nodes.map(n=>[n.id,n])),actual=[];
 for(const id of result.selected)actual.push(...nodes.get(id).ownership);
 assert.equal(new Set(actual).size,actual.length,'no overlapping ancestor/child or sibling coverage');
 assert.deepEqual(actual.sort(),m.roots.flatMap(id=>nodes.get(id).ownership).sort());
 for(const id of result.selected)for(let parent=nodes.get(id).parent;parent;parent=nodes.get(parent).parent)assert.ok(!result.selected.includes(parent),'parent XOR complete descendants');
}

test('version1 metadata separates declared sources, tiers, page costs and rendered applicability',()=>{
 const m=fixture(),before=structuredClone(m);assert.equal(validateForestLODManifest(m),m);assert.deepEqual(m,before);
 const result=choose(m);assertExactCover(m,result);assert.deepEqual(result.selected,['a','b']);assert.equal(result.costs.main.triangles,160);assert.equal(result.costs.shadow.triangles,40);assert.equal(result.costs.reflection.triangles,20);assert.equal(result.costs.main.vertices,480);
 assert.equal(result.appearanceQualified,true);assert.match(result.qualificationScope,/receipts not verified/);assert.match(result.qualificationScope,/no likeness certificate/);
 assert.deepEqual(m,before,'reference selection does not rewrite source, ownership, residency or geometry');
});

test('broken ownership, hierarchy references, cycles and unaccounted passes fail closed',()=>{
 const edits=[
  m=>m.nodes[0].ownership.push('oak'),m=>m.nodes[2].ownership=['oak'],m=>m.nodes[2].ownership=['unknown-root'],
  m=>m.nodes[0].children=['a'],m=>m.nodes[0].children.push('absent'),m=>m.nodes[1].parent='b',
  m=>m.nodes.push(structuredClone(m.nodes[1])),m=>m.roots.push('stand'),m=>m.nodes[1].id=undefined,
  m=>{const extra=structuredClone(m.nodes[2]);extra.id='other-root';extra.parent=null;m.nodes.push(extra);m.roots.push(extra.id);},
  m=>{m.nodes[1].children=['stand'];m.nodes[0].parent='a';},
  m=>{const a=structuredClone(m.nodes[1]);a.id='orphan';a.parent='orphan';a.children=['orphan'];m.nodes.push(a);},
  m=>m.nodes[1].bounds.high[0]=100,m=>m.nodes[1].bounds.windPaddingMetres=10,
  m=>delete m.nodes[0].costs.shadow,m=>m.nodes[0].costs.hidden=costs(1).main,
  m=>m.nodes[1].costs.main.triangles=-1,m=>m.nodes[1].costs.main.vertices=NaN,m=>m.nodes[1].costs.main.vertices=0,
  m=>m.nodes[1].geometryErrorMetres=NaN,m=>m.nodes[1].tier=4,m=>m.tiers[4].id=3,
  m=>m.sourceReceipts.originalMesh.sha256='invalid',m=>delete m.placementReceipt,
 ];
 for(const edit of edits){const m=fixture();edit(m);assert.throws(()=>validateForestLODManifest(m),/Forest LOD/);}
 const grouping=fixture();grouping.nodes[0].kind='spatial-group';grouping.nodes[1].tier=4;assert.equal(validateForestLODManifest(grouping),grouping);
});

test('page graph validates bounds, paths, cycles and every transitive production dependency',()=>{
 const edits=[m=>m.pages[0].bytes=0,m=>m.pages[0].bytes=128*1024*1024+1,m=>m.pages[0].sha256='not-a-hash',
  m=>m.pages[0].file='../outside.bin',m=>m.pages[0].file='/absolute.bin',m=>m.pages[0].file='https://host/page',m=>m.pages[0].file='%2e%2e/outside',m=>m.pages[1].mipBytes=[10],m=>delete m.pages[1].mipBytes,
  m=>m.pages[0].dependencies=['missing'],m=>m.pages[1].dependencies=['coarse'],m=>m.nodes[1].pages=['absent'],
  m=>m.pages.push(structuredClone(m.pages[0])),m=>m.pages[0].id=undefined,
  m=>m.pages[0].dependencies.push('reference'),m=>m.nodes[1].pages=['reference'],
  m=>m.pages[0].referenceOnly=true,m=>m.nodes[1].representation='raw-reference',
  m=>m.pages[0].sha256=m.pages[2].sha256,m=>m.pages[0].file=m.pages[2].file];
 for(const edit of edits){const m=fixture();edit(m);assert.throws(()=>validateForestLODManifest(m),/Forest LOD/);}
 const m=fixture();assert.equal(validateForestLODManifest(m),m,'offline reference may be recorded, but never selected');
});

test('delayed child residency retains whole parent until every child and dependency is resident',()=>{
 const m=fixture(),one=choose(m,{residentPages:['coarse','material','near-a']});
 assertExactCover(m,one);assert.deepEqual(one.selected,['stand']);assert.deepEqual(one.requestedPages,['near-b']);assert.ok(!one.selected.includes('a'));
 const complete=choose(m,{residentPages:new Set(['coarse','material','near-a','near-b'])});assertExactCover(m,complete);assert.deepEqual(complete.selected,['a','b']);
 const dependencyMissing=choose(m,{residentPages:['coarse','near-a','near-b']});assert.deepEqual(dependencyMissing.selected,[]);assert.equal(dependencyMissing.complete,false);assert.deepEqual(dependencyMissing.requestedPages,['material']);assert.deepEqual(dependencyMissing.missingCoverage,['stand']);
 const noBase=choose(m,{residentPages:['material','near-a']});assert.deepEqual(noBase.selected,[]);assert.equal(noBase.failure,'missing-valid-cover');assert.equal(noBase.budget.impossible,false);assert.ok(noBase.requestedPages.includes('coarse')&&noBase.requestedPages.includes('near-b'));
 const rawOnly=choose(m,{residentPages:['reference']});assert.deepEqual(rawOnly.selected,[]);assert.ok(!rawOnly.requestedPages.includes('reference'),'no raw fallback request, even during missing cover');
});

test('new unqualified pilots need an explicit review option and cannot inherit qualification from error',()=>{
 const m=fixture();m.nodes=[m.nodes[0]];m.nodes[0].children=[];m.nodes[0].appearance={status:'unqualified'};m.nodes[0].geometryErrorMetres=0;
 assert.equal(validateForestLODManifest(m),m,'no invented appearance envelope required for new assets');
 const normal=choose(m);assert.equal(normal.complete,false);assert.deepEqual(normal.selected,[]);assert.equal(normal.appearanceQualified,false);assert.ok(normal.unqualified.some(n=>n.id==='stand'&&n.reasons.includes('appearance-unqualified')));
 const review=choose(m,{allowUnqualified:true});assertExactCover(m,review);assert.deepEqual(review.selected,['stand']);assert.equal(review.appearanceQualified,false);assert.ok(review.unqualified.some(n=>n.id==='stand'&&n.selected));
 const fakeReceipt=structuredClone(m);fakeReceipt.nodes[0].appearance={...qualified(),status:'unqualified'};assert.equal(choose(fakeReceipt).complete,false,'render receipt/envelope presence alone never upgrades status');
 for(const edit of [n=>delete n.appearance.status,n=>n.appearance={status:'qualified'},n=>n.appearance={...qualified(),qualifiedSizePixels:[0,Infinity]},n=>n.appearance={...qualified(),viewCone:{...qualified().viewCone,axis:[0,0,-2]}}]){const bad=fixture();edit(bad.nodes[0]);assert.throws(()=>validateForestLODManifest(bad),/Forest LOD/);}
});

test('hard triangle ceilings reject optional refinement across main, shadow and reflection passes',()=>{
 for(const triangleBudgets of [{main:100},{shadow:30},{reflection:15},{additional:50}]){
  const m=fixture(),result=choose(m,{triangleBudgets});assertExactCover(m,result);assert.deepEqual(result.selected,['stand']);assert.ok(result.budgetLimited.includes('stand'));assert.equal(result.budget.satisfied,true);assert.equal(result.budget.maxOverflow,0);
  assert.ok(result.costs.main.triangles<=result.budget.limits.main);assert.ok(result.costs.shadow.triangles<=result.budget.limits.shadow);assert.ok(result.costs.reflection.triangles<=result.budget.limits.reflection);assert.ok(result.costs.shadow.triangles+result.costs.reflection.triangles<=result.budget.limits.additional);
 }
 const m=fixture(),failed=choose(m,{triangleBudgets:{main:60,shadow:5,reflection:1,additional:4}});
 assert.equal(failed.complete,false);assert.equal(failed.failure,'mandatory-cover-over-budget');assert.deepEqual(failed.selected,[]);assert.equal(failed.costs.main.triangles,0,'an impossible cover is never submitted over budget');
 assert.equal(failed.attemptedCosts.main.triangles,100);assert.deepEqual(failed.budget.overflow,{main:40,shadow:15,reflection:9,additional:26});assert.equal(failed.budget.maxOverflow,40);assert.equal(failed.budget.impossible,true);assert.equal(failed.budget.satisfied,false);
 assert.match(failed.budget.scope,/not a global cost optimizer/);
});

test('camera inside or crossing exterior proxy requires complete valid base cover, even in review',()=>{
 const m=fixture(),insideCamera={...camera(),position:[0,0,0]},inside=choose(m,{camera:insideCamera});assertExactCover(m,inside);assert.deepEqual(inside.selected,['a','b']);assert.ok(!inside.selected.includes('stand'));
 const missingBase=choose(m,{camera:insideCamera,residentPages:['coarse','material','near-a'],allowUnqualified:true});assert.deepEqual(missingBase.selected,[]);assert.equal(missingBase.complete,false);assert.ok(missingBase.blocked.some(n=>n.id==='stand'&&n.reasons.includes('exterior-near-or-inside')));
 const nearCamera={...camera(),position:[0,0,-6]},near=choose(m,{camera:nearCamera});assertExactCover(m,near);assert.deepEqual(near.selected,['a','b']);
 const invalidBase=fixture();invalidBase.nodes[1].interior=false;assert.equal(choose(invalidBase,{camera:insideCamera,allowUnqualified:true}).complete,false,'review mode cannot draw an exterior wall around the camera');
});

test('appearance size and view ranges remain independent of zero geometric deviation',()=>{
 const m=fixture();m.nodes[0].children=[];m.nodes=[m.nodes[0]];m.nodes[0].geometryErrorMetres=0;
 m.nodes[0].appearance.qualifiedSizePixels=[0,1];const large=choose(m);assert.equal(large.complete,false);assert.ok(large.unqualified.some(n=>n.reasons.includes('outside-qualified-size')));
 const review=choose(m,{allowUnqualified:true});assert.equal(review.complete,true);assert.equal(review.appearanceQualified,false);
 m.nodes[0].appearance=qualified();m.nodes[0].appearance.viewCone={axis:[0,0,1],halfAngleRadians:.1,receipt:receipt(102)};
 const wrongView=choose(m);assert.equal(wrongView.complete,false);assert.ok(wrongView.unqualified.some(n=>n.reasons.includes('outside-qualified-view')));
 m.nodes[0].appearance.viewCone.axis=[0,0,-1];assert.equal(choose(m).complete,true);
});

test('projection uses drawing-buffer pixels, FOV, wind and conservative nearest off-axis depth',()=>{
 const box={low:[-1,-1,-1],high:[1,1,1],windPaddingMetres:0},c=camera(),p=projectForestLODBounds(box,c,.1);
 const retina=projectForestLODBounds(box,{...c,framebufferHeight:2160,cssHeight:100},.1);assert.ok(Math.abs(retina.sizePixels/p.sizePixels-2)<1e-12);assert.ok(Math.abs(retina.errorPixels/p.errorPixels-2)<1e-12);
 const narrow=projectForestLODBounds(box,{...c,verticalFovRadians:Math.PI/6},.1),ratio=Math.tan(c.verticalFovRadians/2)/Math.tan(Math.PI/12);assert.ok(Math.abs(narrow.errorPixels/p.errorPixels-ratio)<1e-12);
 const offaxis=projectForestLODBounds(box,{...c,position:[50,0,-100]},.1);assert.equal(offaxis.nearestDepth,p.nearestDepth);assert.ok(offaxis.errorPixels>p.errorPixels);
 const wind=projectForestLODBounds({...box,windPaddingMetres:1},c,.1);assert.ok(wind.sizePixels>p.sizePixels&&wind.errorPixels>p.errorPixels&&wind.nearestDepth<p.nearestDepth);
 const near=projectForestLODBounds(box,{...c,position:[0,0,0]},.1);assert.equal(near.inside,true);assert.equal(near.nearCrossing,true);assert.equal(near.errorPixels,1e30);assert.ok(Number.isFinite(near.sizePixels));
 assert.equal(projectForestLODBounds(box,{...c,position:[0,0,0]},0).errorPixels,0,'zero geometric error still cannot qualify exterior/appearance');
 for(const bad of [{...c,framebufferHeight:0},{...c,verticalFovRadians:Math.PI},{...c,near:0},{...c,forward:[0,0,2]}])assert.throws(()=>projectForestLODBounds(box,bad,.1),/drawing-buffer camera/);
});

test('GPU helpers expose the same conservative formulas without inventing a runtime CPU renderer',()=>{
 for(const name of ['forestLODProjectBounds','forestLODAppearanceEligible','forestLODTierEligible'])assert.match(FOREST_LOD_POLICY_WGSL,new RegExp('fn '+name+'\\('));
 assert.match(FOREST_LOD_POLICY_WGSL,/height\/\(2\.\*tan\(fovY\*\.5\)\)/);assert.match(FOREST_LOD_POLICY_WGSL,/let nearest=depth-radius/);assert.match(FOREST_LOD_POLICY_WGSL,/nearest-error/);
 assert.match(FOREST_LOD_POLICY_WGSL,/statusQualified!=1u/);assert.match(FOREST_LOD_POLICY_WGSL,/projected\.inside!=0u\|\|projected\.nearCrossing!=0u/);assert.match(FOREST_LOD_POLICY_WGSL,/min\(maxErrorPixels,3\.\)/);
 assert.doesNotMatch(FOREST_LOD_POLICY_WGSL,/@compute|@group|read_write|appearanceErrorSupported/);
});
