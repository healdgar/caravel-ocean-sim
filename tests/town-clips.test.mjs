import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {loadCrewGLB} from '../js/gltf.js';
import {bakeTownClips} from '../js/town-clips.js';
import {TOWN_COWER_FRAMES,TOWN_FALL_FRAMES} from '../js/wgsl/townsfolk.js';

const JOINTS=65,MATRIX=16;
const load=name=>{const bytes=readFileSync(new URL(`../assets/crew/${name}.glb`,import.meta.url));return loadCrewGLB(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));};
// The classic bodies are what Indigenous people are built on.
const models=['sailor','sailor-female','sailor-classic','sailor-female-classic'].map(name=>({name,model:load(name)}));

// The body as it would be drawn at one frame: every vertex through its bones.
function extent({vertices,vertexCount},palettes,frame){
  const bytes=new DataView(vertices.buffer,vertices.byteOffset,vertices.byteLength),at=frame*JOINTS*MATRIX,low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  for(let v=0;v<vertexCount;v+=7){
    const o=v*60,p=[bytes.getFloat32(o,true),bytes.getFloat32(o+4,true),bytes.getFloat32(o+8,true)],out=[0,0,0];
    let share=0;
    for(let k=0;k<4;k++){
      const bone=bytes.getUint16(o+36+k*2,true),weight=bytes.getFloat32(o+44+k*4,true),m=at+bone*MATRIX;
      share+=weight;
      for(let c=0;c<3;c++)out[c]+=weight*(palettes[m+c]*p[0]+palettes[m+4+c]*p[1]+palettes[m+8+c]*p[2]+palettes[m+12+c]);
    }
    if(share<.5)continue;
    for(let c=0;c<3;c++){low[c]=Math.min(low[c],out[c]);high[c]=Math.max(high[c],out[c]);}
  }
  return {low,high};
}

for(const {name,model} of models)test(`${name}: what people do under fire is baked into poses that keep them on the ground`,()=>{
  const started=performance.now();
  const {palettes,layout}=bakeTownClips(model.animator);
  const milliseconds=performance.now()-started;
  const clip=index=>({first:layout[index*2],frames:layout[index*2+1]}),[idle,walk,run,cower,face,back]=[0,1,2,3,4,5].map(clip);
  assert.equal(palettes.length,(back.first+back.frames)*JOINTS*MATRIX);
  assert.equal(cower.frames,TOWN_COWER_FRAMES);
  assert.equal(face.frames,TOWN_FALL_FRAMES);
  assert.ok(milliseconds<400,`${milliseconds.toFixed(0)} ms to bake`);
  assert.equal(run.frames,walk.frames);

  const standing=extent(model,palettes,idle.first);
  assert.ok(standing.high[1]>1.4&&standing.low[1]<.1,JSON.stringify(standing));

  // Both feet stay on the ground through a run, and it covers more ground than the walk it comes from.
  const reach=first=>{let forward=-Infinity,behind=Infinity,lowest=Infinity;for(let f=0;f<walk.frames;f++){const e=extent(model,palettes,first+f);forward=Math.max(forward,e.high[2]);behind=Math.min(behind,e.low[2]);lowest=Math.min(lowest,e.low[1]);}return {span:forward-behind,lowest};};
  const walking=reach(walk.first),running=reach(run.first);
  assert.ok(running.span>walking.span*1.1,`run spans ${running.span.toFixed(2)} m against ${walking.span.toFixed(2)} m walking`);
  assert.ok(running.lowest>walking.lowest-.06&&running.lowest<.1,`a running foot reaches ${running.lowest.toFixed(3)} m`);

  // Crouched right down, over their own feet.
  const down=extent(model,palettes,cower.first+cower.frames-1);
  assert.ok(down.high[1]<standing.high[1]*.72,`cowering is ${down.high[1].toFixed(2)} m high`);
  assert.ok(down.low[1]>-.05&&down.low[1]<.1,`cowering feet at ${down.low[1].toFixed(3)} m`);

  // Lying flat on the ground, on the side of them each clip says.
  for(const [fall,sign] of [[face,1],[back,-1]]){
    const lying=extent(model,palettes,fall.first+fall.frames-1),before=extent(model,palettes,fall.first+fall.frames-2);
    assert.ok(lying.high[1]<.6,`lying ${lying.high[1].toFixed(2)} m high`);
    assert.ok(lying.low[1]>-.2,`lying ${lying.low[1].toFixed(2)} m into the ground`);
    assert.ok(sign*(lying.high[2]+lying.low[2])>.2,`fell towards ${((lying.high[2]+lying.low[2])/2).toFixed(2)} m`);
    assert.ok(Math.abs(lying.high[1]-before.high[1])<.04,'settled by the end of the clip');
  }
});
