import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {MeshoptSimplifier} from 'meshoptimizer';
import {ASSET_TYPES,bakeSize,bestStep,createDecimator,dropHidden,readGLB,sourceIndices,writeGLB} from '../scripts/safe-decimate.mjs';

before(()=>MeshoptSimplifier.ready);

// ---- models to reduce -------------------------------------------------------------------------
function cylinder(radius,height,{x=0,y=0,z=0,sides=96,rings=24}={}){
  const positions=[],indices=[];
  for(let r=0;r<=rings;r++)for(let s=0;s<sides;s++){const a=s/sides*Math.PI*2;positions.push(x+Math.cos(a)*radius,y+r/rings*height,z+Math.sin(a)*radius);}
  const bottom=positions.length/3;positions.push(x,y,z);const top=positions.length/3;positions.push(x,y+height,z);
  for(let r=0;r<rings;r++)for(let s=0;s<sides;s++){const n=(s+1)%sides,a=r*sides+s,b=r*sides+n,c=(r+1)*sides+s,d=(r+1)*sides+n;indices.push(a,c,b,b,c,d);}
  for(let s=0;s<sides;s++){const n=(s+1)%sides;indices.push(bottom,s,n,top,rings*sides+n,rings*sides+s);}
  return {name:'cylinder',positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
function box(hx,hy,hz,{x=0,y=0,z=0,name='box'}={}){
  const positions=[],indices=[];
  for(const sx of[-1,1])for(const sy of[-1,1])for(const sz of[-1,1])positions.push(x+sx*hx,y+sy*hy,z+sz*hz);
  indices.push(0,1,3,0,3,2,4,6,7,4,7,5,0,4,5,0,5,1,2,3,7,2,7,6,0,2,6,0,6,4,1,5,7,1,7,3);
  return {name,positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
// A GLB of these parts, in the plain layout unless told otherwise.
function glb(parts,{interleaved=false,unindexed=false,extras=null,skin=false,draco=false,uvs=false,image=false}={}){
  const chunks=[],views=[],accessors=[],meshes=[],nodes=[];let offset=0;
  const push=(bytes,target,extra={})=>{const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),pad=(4-b.length%4)%4;views.push({buffer:0,byteOffset:offset,byteLength:b.length,target,...extra});chunks.push(b,Buffer.alloc(pad));offset+=b.length+pad;return views.length-1;};
  for(const part of parts){
    let positions=part.positions,indices=part.indices;
    if(unindexed){const flat=new Float32Array(indices.length*3);indices.forEach((v,i)=>flat.set(positions.subarray(v*3,v*3+3),i*3));positions=flat;indices=null;}
    const count=positions.length/3,attributes={};
    if(interleaved){
      const mixed=new Float32Array(count*6);for(let i=0;i<count;i++)mixed.set(positions.subarray(i*3,i*3+3),i*6);
      const view=push(mixed,34962,{byteStride:24});accessors.push({bufferView:view,componentType:5126,count,type:'VEC3'});attributes.POSITION=accessors.length-1;
    }else{accessors.push({bufferView:push(positions,34962),componentType:5126,count,type:'VEC3'});attributes.POSITION=accessors.length-1;}
    if(uvs){const uv=new Float32Array(count*2);for(let i=0;i<count;i++){uv[i*2]=Math.atan2(positions[i*3+2],positions[i*3])/Math.PI/2+.5;uv[i*2+1]=positions[i*3+1];}accessors.push({bufferView:push(uv,34962),componentType:5126,count,type:'VEC2'});attributes.TEXCOORD_0=accessors.length-1;}
    const primitive={attributes,material:0};
    if(indices){accessors.push({bufferView:push(indices,34963),componentType:5125,count:indices.length,type:'SCALAR'});primitive.indices=accessors.length-1;}
    if(draco)primitive.extensions={KHR_draco_mesh_compression:{}};
    meshes.push({primitives:[primitive]});nodes.push({mesh:meshes.length-1,name:part.name,...(extras?{extras}:{})});
  }
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,accessors,bufferViews:views,buffers:[{}],materials:[{name:'iron'}]};
  if(skin)doc.skins=[{joints:[0]}];
  if(image){const data=Uint8Array.from([137,80,78,71,1,2,3,4]);doc.images=[{bufferView:push(data),mimeType:'image/png'}];doc.textures=[{source:0}];}
  const body=Buffer.concat(chunks);doc.buffers[0].byteLength=body.length;
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);
  const head=Buffer.alloc(12),a=Buffer.alloc(8),b=Buffer.alloc(8);head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+body.length,8);
  a.writeUInt32LE(json.length,0);a.writeUInt32LE(0x4e4f534a,4);b.writeUInt32LE(body.length,0);b.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([head,a,json,b,body]);
}
const model=(options)=>glb([cylinder(.5,2),box(.02,.02,.02,{x:.9,y:1,name:'pin'})],options);

test('a smooth cylinder loses most of its triangles and stays within the error allowed',()=>{
  const d=createDecimator(model()),{best}=bestStep(d,{maxError:.01,maxDrift:.015});
  assert.ok(best,'a step must pass');
  assert.ok(best.triangles<d.source/10,`${best.triangles} of ${d.source}`);
  assert.ok(best.distance<=.01*d.diagonal);assert.ok(best.drift<=.015*d.diagonal);assert.equal(best.lost,0);
});

test('a part smaller than the error survives, unless it is allowed to go',()=>{
  const kept=createDecimator(model()),{rows}=bestStep(kept,{});
  assert.ok(rows.every(row=>row.lost===0),'no step may lose the pin');
  const dropped=createDecimator(model(),{dropSmall:true}).step(.048);
  assert.equal(dropped.lost,1,'with leave given, a coarse step lets it vanish');
});

test('the same file gives the same bytes',()=>{
  const once=()=>{const d=createDecimator(model()),{best}=bestStep(d,{});return writeGLB(d,d.finish(best).parts).bytes;};
  assert.deepEqual(once(),once());
});

test('interleaved and unindexed files read as the same shape',()=>{
  const plain=readGLB(model()).parts[0],mixed=readGLB(model({interleaved:true})).parts[0],flat=readGLB(model({unindexed:true})).parts[0];
  assert.deepEqual(mixed.positions,plain.positions);
  assert.equal(flat.indices.length,plain.indices.length);
  const steps=[model(),model({interleaved:true}),model({unindexed:true})].map(file=>createDecimator(file).step(.004).triangles);
  assert.equal(steps[1],steps[0]);
  assert.ok(Math.abs(steps[2]-steps[0])<=steps[0]*.1,`${steps}`);
});

test('what it cannot handle it refuses plainly',()=>{
  assert.throws(()=>readGLB(model({skin:true})),/skinned/);
  assert.throws(()=>readGLB(model({draco:true})),/Draco/);
  assert.throws(()=>readGLB(Buffer.alloc(40)),/Not a GLB/);
});

test('a part buried inside another goes, and the outline does not move',()=>{
  const file=glb([box(1,1,1,{name:'outer'}),box(.3,.3,.3,{name:'buried'}),box(.2,.2,.2,{x:1.4,name:'beside'})]);
  const d=createDecimator(file),row=d.finish(d.step(.001));
  assert.ok(row.hiddenRemoved>=12,`${row.hiddenRemoved} removed`);
  const left=Object.fromEntries(row.parts.map(p=>[p.name,p.indices.length/3]));
  assert.equal(left.buried,0);assert.equal(left.outer,12);assert.equal(left.beside,12);
  assert.ok(row.drift<.001*d.diagonal,`outline moved ${row.drift}`);
});

test('a hollow someone can look into keeps its inside',()=>{
  const outer=cylinder(.5,2,{sides:24,rings:2}),{positions:p,indices:i}=cylinder(.4,1.9,{y:.1,sides:24,rings:2});
  // An inner wall whose top cap is left out, so the mouth is open from above.
  const inner={name:'wall',positions:p,indices:i.slice(0,24*2*6)};
  const lid=glb([{...outer,indices:outer.indices.slice(0,24*2*6+24*3)},inner]);
  const parts=readGLB(lid).parts,box3={lo:[-.5,0,-.5],hi:[.5,2,.5]};
  const shown=dropHidden(parts,box3);
  assert.ok(shown[1].indices.length>0,'the wall is visible down the mouth');
});

test('with joints in the file nothing is removed as hidden, because parts will move',()=>{
  const file=glb([box(1,1,1,{name:'outer'}),box(.3,.3,.3,{name:'buried'})],{extras:{s3d_joint:{name:'hinge'}}});
  const d=createDecimator(file);
  assert.equal(d.joints,2);assert.equal(d.keepHidden,true);
  assert.equal(d.finish(d.step(.001)).hiddenRemoved,0);
});

test('texture coordinates and embedded images travel with the part',()=>{
  const file=model({uvs:true,image:true}),d=createDecimator(file),row=d.finish(d.step(.008)),{bytes}=writeGLB(d,row.parts);
  const back=readGLB(bytes);
  assert.ok(back.parts[0].uvs,'coordinates kept');
  assert.equal(back.parts[0].uvs.length/2,back.parts[0].positions.length/3);
  assert.ok(back.parts[0].uvs.every(v=>Number.isFinite(v)));
  assert.deepEqual(back.doc.images.map(i=>i.mimeType),['image/png']);
  const view=back.doc.bufferViews[back.doc.images[0].bufferView];
  assert.deepEqual([...back.bin.subarray(view.byteOffset,view.byteOffset+view.byteLength)],[137,80,78,71,1,2,3,4]);
});

test('a budget returns the closest step that fits, and nothing when none does',()=>{
  const d=createDecimator(model());
  const {best}=bestStep(d,{budget:400});
  assert.ok(best&&best.triangles<=400,`${best?.triangles}`);
  assert.equal(bestStep(d,{budget:3}).best,null);
});

test('its own output reads back as a closed, renderable model',()=>{
  const d=createDecimator(model()),{best}=bestStep(d,{}),{bytes,vertices}=writeGLB(d,d.finish(best).parts),back=readGLB(bytes);
  assert.equal(back.parts.length,2);
  assert.equal(back.parts.reduce((s,p)=>s+p.positions.length/3,0),vertices);
  for(const p of back.parts)assert.ok(p.indices.every(i=>i*3<p.positions.length));
  assert.ok(back.doc.accessors.every(a=>Number.isInteger(a.count)&&a.count>0));
});

test('the command line writes only what passes, and says why not',()=>{
  const dir=mkdtempSync(join(tmpdir(),'decimate-')),input=join(dir,'in.glb'),out=join(dir,'out.glb'),report=join(dir,'r.json');
  writeFileSync(input,model());
  const script=new URL('../scripts/safe-decimate.mjs',import.meta.url).pathname;
  const good=spawnSync(process.execPath,[script,input,'--out',out,'--report',report],{encoding:'utf8'});
  assert.equal(good.status,0,good.stderr);assert.ok(existsSync(out));assert.match(good.stdout,/chosen/);
  assert.equal(JSON.parse(readFileSync(report,'utf8')).steps.length>5,true);
  const strict=join(dir,'strict.glb'),bad=spawnSync(process.execPath,[script,input,'--out',strict,'--budget','3'],{encoding:'utf8'});
  assert.equal(bad.status,1);assert.ok(!existsSync(strict),'nothing written when nothing passes');assert.match(bad.stderr,/nothing was written/);
  const lods=spawnSync(process.execPath,[script,input,'--out',join(dir,'a.glb'),'--lods','0.5%,2%'],{encoding:'utf8'});
  assert.equal(lods.status,0,lods.stderr);assert.ok(existsSync(join(dir,'a-lod0.glb')));assert.ok(existsSync(join(dir,'a-lod1.glb')));assert.match(lods.stdout,/safe from/);
});

// ---- asset types ------------------------------------------------------------------------------
// A trunk and many small flat leaves, the way a generated tree arrives: separate sheets close together.
function tree({leaves=320,seed=7}={}){
  const positions=[],indices=[];let s=seed;const random=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
  const trunk=cylinder(.12,2,{sides:12,rings:8}),base=0;
  positions.push(...trunk.positions);indices.push(...trunk.indices);
  for(let n=0;n<leaves;n++){
    const a=random()*Math.PI*2,r=Math.sqrt(random())*1.1,y=2+random()*.5,x=Math.cos(a)*r,z=Math.sin(a)*r,at=positions.length/3;
    // Four triangles a side, so there is something in each leaf to reduce.
    for(const[dx,dz,dy]of[[-.07,-.07,0],[.07,-.07,.02],[.07,.07,0],[-.07,.07,.02],[0,0,.03]])positions.push(x+dx,y+dy,z+dz);
    for(const[u,v]of[[0,1],[1,2],[2,3],[3,0]])indices.push(at+u,at+v,at+4,at+v,at+u,at+4);
  }
  return {name:'tree',positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
const skinnedBody=()=>glb([cylinder(.3,1.8,{sides:48,rings:40})],{skin:true});

test('every asset type names only options the tool understands, and an unknown type is refused',()=>{
  assert.deepEqual(Object.keys(ASSET_TYPES).sort(),['character','foliage','prop','structure']);
  for(const kind of Object.values(ASSET_TYPES))assert.ok(kind.minOverlap!==undefined||(kind.maxError>0&&kind.maxDrift>0));
  const run=spawnSync(process.execPath,['scripts/safe-decimate.mjs','nothing.glb','--type','boat'],{encoding:'utf8'});
  assert.equal(run.status,2);assert.match(run.stderr,/One of: prop, structure, character, foliage/);
});

test('dropping texture seams frees a reduction they would have stopped',()=>{
  const file=model({uvs:true,image:true}),seamed=createDecimator(file).step(.012).triangles,free=createDecimator(file,{ignoreUvs:true}).step(.012).triangles;
  assert.ok(free<seamed,`${free} without seams, ${seamed} with`);
  const d=createDecimator(file,ASSET_TYPES.prop),{bytes}=writeGLB(d,d.step(.012).parts);
  assert.equal(readGLB(bytes).parts[0].uvs,null,'nothing left to carry an old unwrap');
  assert.equal(d.textured,true,'it still knows there is a texture to bake back');
});

test('a budget is never exceeded, spends what it can, and costs every part the same error',()=>{
  const d=createDecimator(model());
  let last=Infinity;
  for(const budget of [4000,1000,250,60]){
    const row=d.atBudget(budget);
    assert.ok(row.triangles<=budget,`${row.triangles} for ${budget}`);
    assert.ok(row.triangles<=last);last=row.triangles;
    assert.equal(row.lost,0,'no part vanishes to make the count');
  }
  assert.ok(d.atBudget(1000).triangles>600,'a generous budget is not left unspent');
});

test('a budget no shape can reach returns the floor, plainly over',()=>{
  const row=createDecimator(glb([box(1,1,1)])).atBudget(3);
  assert.equal(row.triangles,12,'a box stays a box');
});

test('a crown keeps its mass at a budget that thins it to twigs when led by error',()=>{
  const file=glb([tree()]),budget=200;
  const led=createDecimator(file,{ignoreUvs:true,locks:false,keepHidden:true}).atBudget(budget);
  const crown=createDecimator(file,ASSET_TYPES.foliage).atBudget(budget);
  assert.ok(crown.triangles<=budget,`${crown.triangles}`);
  assert.ok(crown.mass>led.mass+.15,`merged mass ${crown.mass}, error-led ${led.mass}`);
  assert.ok(crown.overlap>led.overlap,`merged overlap ${crown.overlap}, error-led ${led.overlap}`);
  assert.equal(crown.allowed,null,'marked as merged');
  assert.equal(crown.parted,false,'trunk and crown stay joined');
});

test('a budget too small for the shape is called out, not handed back as if fine',()=>{
  const row=createDecimator(glb([tree()]),ASSET_TYPES.foliage).atBudget(6);
  assert.equal(row.parted,true,`mass ${row.mass}`);
});

test('foliage keeps the gentler reduction while that holds the outline better',()=>{
  const d=createDecimator(glb([tree()]),ASSET_TYPES.foliage),row=d.atBudget(Math.round(d.source*.8));
  assert.notEqual(row.allowed,null,`overlap ${row.overlap}`);
});

test('foliage chooses by outline, and refuses nothing it was not asked to judge',()=>{
  const d=createDecimator(glb([tree()]),ASSET_TYPES.foliage),{rows,best}=bestStep(d,ASSET_TYPES.foliage);
  assert.ok(best,'some share passes');
  assert.ok(best.overlap>=ASSET_TYPES.foliage.minOverlap);
  assert.ok(rows.every(row=>row===best||row.overlap<ASSET_TYPES.foliage.minOverlap||row.triangles>=best.triangles));
});

test('a skinned body needs its type, and gets index lists into its own vertices',()=>{
  assert.throws(()=>createDecimator(skinnedBody()),/skinned/);
  const d=createDecimator(skinnedBody(),ASSET_TYPES.character),row=d.finish(d.atBudget(300));
  assert.equal(d.keepHidden,true);
  const [part]=sourceIndices(row),{parts}=readGLB(skinnedBody(),{allowSkinned:true});
  assert.equal(part.indices.length/3,row.triangles);
  // Each index is a vertex of the file, at the place the reduced mesh says.
  const {positions}=parts[0],reduced=row.parts[0];
  for(let i=0;i<part.indices.length;i+=61)for(let k=0;k<3;k++)assert.equal(positions[part.indices[i]*3+k],reduced.positions[reduced.indices[i]*3+k]);
});

test('a real height makes safe distances true, without changing the shape',()=>{
  const plain=createDecimator(model()).step(.004),tall=createDecimator(model(),{height:20}).step(.004);
  assert.equal(tall.triangles,plain.triangles);
  assert.ok(Math.abs(tall.safeMetres/plain.safeMetres-10)<1e-6,`${tall.safeMetres} and ${plain.safeMetres}`);
});

test('a baked texture follows the triangle count, within what a card can hold',()=>{
  assert.equal(bakeSize(358,32),512);
  assert.equal(bakeSize(80,16),128);
  assert.equal(bakeSize(1e7,32),2048);
  assert.equal(bakeSize(1,16),64);
});

test('the command line writes one file per level, and index lists for a body',()=>{
  const dir=mkdtempSync(join(tmpdir(),'decimate-')),input=join(dir,'tree.glb'),output=join(dir,'out.glb');
  writeFileSync(input,glb([tree()]));
  const run=spawnSync(process.execPath,['scripts/safe-decimate.mjs',input,'--type','foliage','--levels','800,120','--out',output],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  for(const[budget,most]of[[800,800],[120,120]]){
    const back=readGLB(readFileSync(join(dir,`out-${budget}.glb`)));
    assert.ok(back.parts[0].indices.length/3<=most);
  }
  const body=join(dir,'body.glb'),lists=join(dir,'levels.json');
  writeFileSync(body,skinnedBody());
  const second=spawnSync(process.execPath,['scripts/safe-decimate.mjs',body,'--type','character','--levels','500,200','--indices',lists],{encoding:'utf8'});
  assert.equal(second.status,0,second.stderr);
  const {levels}=JSON.parse(readFileSync(lists,'utf8'));
  assert.deepEqual(levels.map(l=>l.budget),[500,200]);
  assert.ok(levels.every(l=>l.parts[0].indices.length/3===l.triangles&&l.triangles<=l.budget));
  assert.equal(existsSync(join(dir,'body-500.glb')),false,'a preview without its weights would mislead');
});

test('a textured type says how to bake when it has no Python, and fails aloud when the Python cannot',()=>{
  const dir=mkdtempSync(join(tmpdir(),'decimate-')),input=join(dir,'in.glb'),output=join(dir,'out.glb');
  writeFileSync(input,model({uvs:true,image:true}));
  const hint=spawnSync(process.execPath,['scripts/safe-decimate.mjs',input,'--type','prop','--out',output],{encoding:'utf8'});
  assert.equal(hint.status,0,hint.stderr);assert.match(hint.stdout,/no texture yet\. Bake it with/);
  const bad=spawnSync(process.execPath,['scripts/safe-decimate.mjs',input,'--type','prop','--out',output,'--python','/usr/bin/false'],{encoding:'utf8'});
  assert.equal(bad.status,1);assert.match(bad.stderr,/The bake failed/);
});

// Needs Blender's Python: BPY_PYTHON=venv/bin/python npm test
test('a bake gives the reduced model its own unwrap and texture',{skip:process.env.BPY_PYTHON?false:'set BPY_PYTHON to a Python with bpy'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'decimate-')),input=join(dir,'in.glb'),output=join(dir,'out.glb');
  writeFileSync(input,readFileSync(process.env.BAKE_SOURCE));
  const run=spawnSync(process.execPath,['scripts/safe-decimate.mjs',input,'--type','prop','--out',output,'--python',process.env.BPY_PYTHON],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const back=readGLB(readFileSync(output));
  assert.ok(back.parts[0].uvs,'a fresh unwrap');
  assert.equal(back.doc.images.length,1);
});
