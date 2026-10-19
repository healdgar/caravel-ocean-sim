import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readGLB,gltfAccessor,gltfSlerp,loadCrewGLB} from '../js/gltf.js';
import {createDeckhand,stepDeckhand} from '../js/crew.js';
import {hullDeck,hullHalfWidth} from '../js/hull.js';
import {createShareLink} from '../js/sharing.js';
const bytes=fs.readFileSync(new URL('../assets/crew/sailor.glb',import.meta.url));
const model=loadCrewGLB(bytes);
const boat={length:12,beam:3.6,roll:0,rollVelocity:0};
function positions(palette){
  const f=new Float32Array(model.vertices.buffer),u=new Uint16Array(model.vertices.buffer),out=new Float32Array(model.vertexCount*3);
  for(let i=0;i<model.vertexCount;i++)for(let k=0;k<4;k++){
    const b=u[i*30+18+k]*16,w=f[i*15+11+k];
    for(let axis=0;axis<3;axis++)out[i*3+axis]+=w*(palette[b+axis]*f[i*15]+palette[b+4+axis]*f[i*15+1]+palette[b+8+axis]*f[i*15+2]+palette[b+12+axis]);
  }
  return out;
}
test('sailor GLB is self-contained, bounded and has the required clips',()=>{
  assert.ok(bytes.length<1_100_000);assert.equal(model.animator.joints.length,65);
  assert.ok(model.indices.length/3<16000);assert.deepEqual([...model.animator.clips.keys()],['Idle','Walk','Brace']);
  const rest=positions(model.animator.sample(null,0)),f=new Float32Array(model.vertices.buffer);
  for(let i=0;i<model.vertexCount;i++)for(let k=0;k<3;k++)assert.ok(Math.abs(rest[i*3+k]-f[i*15+k])<1e-5,'inverse binds preserve the authored rest geometry');
});
test('retargeted clips remain human-sized, grounded and loop without a jump',()=>{
  for(const [name,clip] of model.animator.clips){
    let minY=Infinity,maxY=-Infinity,motion=0;const first=positions(model.animator.sample(name,0));
    for(let t=0;t<clip.duration;t+=.1){
      const pos=positions(model.animator.sample(name,t));
      for(let i=0;i<pos.length;i++){assert.ok(Number.isFinite(pos[i])&&Math.abs(pos[i])<2.1);motion=Math.max(motion,Math.abs(pos[i]-first[i]));if(i%3===1){minY=Math.min(minY,pos[i]);maxY=Math.max(maxY,pos[i]);}}
    }
    assert.ok(minY>-.03&&minY<.05,`${name}: feet stay near the deck`);
    assert.ok(maxY>(name==='Brace'?.9:1.6)&&maxY<1.9);assert.ok(motion>.003);
    const end=positions(model.animator.sample(name,clip.duration-1e-5));
    for(let i=0;i<first.length;i++)assert.ok(Math.abs(first[i]-end[i])<.001);
  }
  assert.ok(model.animator.sample('Idle',1,'Walk',1,.5).every(Number.isFinite));
  const before=model.animator.palette.slice();model.animator.blend('Brace',1,0);assert.deepEqual(model.animator.palette,before);
  const braced=model.animator.blend('Brace',1,1).slice();assert.deepEqual(braced,model.animator.sample('Brace',1));
});
test('GLB rejects truncation, out-of-bounds accessors and unsupported data',()=>{
  assert.throws(()=>readGLB(bytes.subarray(0,bytes.length-4)),/header/);
  const a=readGLB(bytes);a.json.accessors[0].count=2_000_000;assert.throws(()=>gltfAccessor(a,0),/exceeds/);
  a.json.accessors[0].sparse={count:1};assert.throws(()=>gltfAccessor(a,0),/Unsupported/);
  const q=new Float32Array(4);gltfSlerp(q,[0,0,0,1],[0,0,0,-1],.5);assert.deepEqual(Array.from(q),[0,0,0,1]);
});
test('deck route respects hull clearance, dimensions and render-rate independence',()=>{
  const final=[];
  for(const fps of [30,60,120]){
    const s=createDeckhand();let low=Infinity,high=-Infinity;
    for(let i=0;i<fps*60;i++){
      stepDeckhand(s,boat,1/fps);low=Math.min(low,s.z);high=Math.max(high,s.z);
      assert.ok(s.z>=-2.20001&&s.z<=.10001);assert.ok(Math.abs(s.x)+.32<hullHalfWidth(s.z,hullDeck(s.z)));
      assert.ok(Math.abs(s.position[1]-hullDeck(s.z)-.028)<1e-6);assert.ok(s.transform.every(Number.isFinite));
    }
    assert.ok(low<-2.19&&high>.09);final.push(s.z);
  }
  assert.ok(Math.max(...final)-Math.min(...final)<.18);
  const resized=createDeckhand();stepDeckhand(resized,{...boat,length:24,beam:7.2},.1);assert.equal(resized.transform[0],Math.fround(.95));
  assert.ok(Math.abs(resized.position[0]+1.9)<1e-6);stepDeckhand(resized,{...boat,beam:1},.1);assert.equal(resized.visible,false);
});
test('orders and rough-weather interruption stop movement; invalid policies fall back locally',()=>{
  const s=createDeckhand();for(let i=0;i<30;i++)stepDeckhand(s,boat,.1);
  assert.ok(s.walk>.9);s.order='standby';s.decisionIn=0;const z=s.z;
  for(let i=0;i<20;i++)stepDeckhand(s,boat,.1);assert.equal(s.z,z);assert.ok(s.walk<.001);
  s.order='patrol';s.policy=()=> 'teleport';stepDeckhand(s,{...boat,roll:.5},.1);assert.equal(s.intent,'brace');assert.equal(s.z,z);
  for(let i=0;i<20;i++)stepDeckhand(s,{...boat,roll:.5},.1);assert.ok(s.brace>.99);
  for(let i=0;i<30;i++)stepDeckhand(s,boat,.1);assert.equal(s.intent,'patrol');assert.ok(s.brace<.001);
  const url=new URL(createShareLink('https://example.com/',{}, {...boat,crew:false},'boat'));assert.equal(url.searchParams.get('crew'),'0');
});
