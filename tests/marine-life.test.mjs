import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMarineLifeState,marinePoseAt,marineSurfaceBounds,MARINE_ANIMAL_LIMIT,MARINE_EFFECT_LIMIT,MARINE_EFFECT_SECONDS,MARINE_ENCOUNTER_SECONDS} from '../js/marine-life-state.js';
import {createMarineMesh} from '../js/marine-life.js';
const vessel=()=>({x:0,z:0,heading:0,length:20,beam:6,surgeVelocity:2});
function marineSeeded(){let seed=62471;return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}

test('shark and whale sightings are bounded, rare and gated by deep water and weather',()=>{
  const state=createMarineLifeState(marineSeeded()),boat=vessel();assert.ok(state.nextAt>=900);
  let visits=0,was=false;
  for(let i=0;i<72000;i++){
    state.step(.1,boat);if(state.active&&!was)visits++;was=state.active;
    assert.ok(state.count<=MARINE_ANIMAL_LIMIT);assert.equal(state.effects.length,MARINE_EFFECT_LIMIT);
  }
  assert.ok(visits>=1&&visits<=5,`${visits} sightings in two simulated hours`);
  const storm=createMarineLifeState(()=>.5);for(let i=0;i<36000;i++)storm.step(.1,boat,{windSpeed:25,rain:1});assert.equal(storm.active,false);
  const shallow=createMarineLifeState(()=>.5);
  assert.equal(shallow.trigger('whale',boat,{terrain:{height:()=>-12}}),false);
  assert.equal(shallow.trigger('shark',boat,{terrain:{height:()=>-3}}),false);
  assert.equal(shallow.trigger('shark',boat,{terrain:{height:()=>-12}}),true);
  assert.equal(shallow.trigger('whale',boat),false,'an active animal is not replaced by a debug action');
  assert.throws(()=>shallow.trigger('kraken',boat),/Unknown marine/);
});

test('encounters reject a blocked forward footprint, clear on teleport/lifetime and obey the natural-sighting toggle',()=>{
  const state=createMarineLifeState(()=>.4),boat=vessel();
  assert.equal(state.trigger('whale',boat,{terrain:{height:(x,z)=>z< -50?0:-40}}),false,'prospective path cannot enter land');
  assert.equal(state.trigger('whale',boat),true);
  const a=state.animals[0];assert.equal(a.kind,'whale');assert.ok(Math.hypot(a.x,a.z)>60);
  for(let i=0;i<30*MARINE_ENCOUNTER_SECONDS+1;i++)state.step(1/30,boat);
  assert.equal(state.active,false);assert.ok(state.nextAt>state.time+899);
  assert.equal(state.trigger('shark',boat),true);boat.x+=1000;state.step(.1,boat);assert.equal(state.active,false);
  assert.ok(state.effects.every(e=>e.strength===0));
  const disabled=createMarineLifeState(()=>.1);disabled.enabled=false;for(let i=0;i<36000;i++)disabled.step(.1,boat);assert.equal(disabled.active,false);
});

test('whale actions include full breach, elevated flukes, separate blows and contact-driven reentry',()=>{
  const boat=vessel(),seen=new Set();let maxDepth=-Infinity,maxTail=-Infinity,entry=0,blows=0;
  for(const behavior of ['breach','fluke','blow']){
    const state=createMarineLifeState(()=>.4);state.trigger('whale',boat,{behavior});let lastId=0;
    for(let frame=0;frame<60*18;frame++){
      state.step(1/60,boat,{windDir:0,windSpeed:8});const a=state.animals[0];
      assert.ok([a.x,a.z,a.heading,a.depth,a.pitch,a.roll].every(Number.isFinite));
      const bounds=marineSurfaceBounds('whale',a.depth,a.pitch,a.scale,a.roll);
      if(behavior==='breach')maxDepth=Math.max(maxDepth,bounds.min);
      if(behavior==='fluke')maxTail=Math.max(maxTail,a.depth-Math.sin(a.pitch)*6.5*a.scale);
      const fresh=state.effects.filter(e=>e.id>lastId&&e.strength>0);lastId=Math.max(lastId,...fresh.map(e=>e.id));
      for(const e of fresh){seen.add(e.kind);assert.ok(e.age>=-1e-7&&e.age<.101);
        if(e.kind==='entry'){entry++;assert.ok(e.strength>.5);}
        if(e.kind==='blow'){blows++;assert.ok(e.height>0);assert.equal(e.windX,8);assert.equal(e.windZ,0);}
      }
    }
  }
  assert.ok(maxDepth>1,'a breach raises the whole trunk out of the water');
  assert.ok(maxTail>3,'a fluke dive lifts the tail clearly above the water');
  assert.ok(entry>=4&&blows>=3);assert.deepEqual([...seen].sort(),['blow','emerge','entry','trail']);
});

test('marine contact events retain fixed cadence across 10–120 FPS without idle or zero-delta emission',()=>{
  const snapshots=[];
  for(const hz of [10,30,60,120]){
    const state=createMarineLifeState(()=>.4),boat=vessel();state.trigger('whale',boat,{behavior:'encounter'});
    for(let i=0;i<20;i++)state.step(0,boat);assert.ok(state.effects.every(e=>e.strength===0));
    const events=[];let lastId=0;
    for(let frame=0;frame<hz*60;frame++){
      state.step(1/hz,boat,{windDir:45,windSpeed:7});
      const fresh=state.effects.filter(e=>e.id>lastId&&e.strength>0);lastId=Math.max(lastId,...fresh.map(e=>e.id));
      for(const e of fresh)events.push({kind:e.kind,at:Math.round((state.age-e.age)*1e6)});
      assert.ok(state.effects.filter(e=>e.age<MARINE_EFFECT_SECONDS&&e.strength>0).length<=MARINE_EFFECT_LIMIT);
    }
    snapshots.push(events.sort((a,b)=>a.at-b.at||a.kind.localeCompare(b.kind)));
    state.clear();assert.ok(state.effects.every(e=>e.strength===0));
  }
  for(const snapshot of snapshots.slice(1))assert.deepEqual(snapshot,snapshots[0]);
  const idle=createMarineLifeState(()=>.4);idle.step(100,vessel());assert.ok(idle.time<=.1);assert.ok(idle.effects.every(e=>e.strength===0));
});

test('shark fin cuts the surface without a constant airborne splash emitter',()=>{
  const state=createMarineLifeState(()=>.4),boat=vessel();state.trigger('shark',boat);let lastId=0,trails=0;
  for(let frame=0;frame<60*25;frame++){
    state.step(1/60,boat);const a=state.animals[0],bounds=marineSurfaceBounds('shark',a.depth,a.pitch,a.scale,a.roll);
    assert.equal(bounds.touching,true);assert.ok(a.depth<-.45);
    for(const e of state.effects.filter(e=>e.id>lastId&&e.strength>0)){lastId=Math.max(lastId,e.id);assert.equal(e.kind,'trail');trails++;}
  }
  assert.ok(trails>20&&trails<45);
});

test('physical meshes distinguish horizontal whale flukes and long pectorals from a shark vertical tail and dorsal fin',()=>{
  for(const type of ['shark','whale']){
    const mesh=createMarineMesh(type);assert.ok(mesh.vertices.every(Number.isFinite));assert.ok(mesh.indices.every(i=>i<mesh.vertices.length/9));
    assert.ok(mesh.indices.length/3>2000&&mesh.indices.length/3<6000);
    let minZ=Infinity,maxZ=-Infinity,maxX=0,maxY=-Infinity,tailX=0,tailY=0;
    for(let i=0;i<mesh.vertices.length;i+=9){
      const [x,y,z]=mesh.vertices.subarray(i,i+3);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);maxX=Math.max(maxX,Math.abs(x));maxY=Math.max(maxY,y);
      assert.ok(Math.abs(Math.hypot(...mesh.vertices.subarray(i+3,i+6))-1)<1e-5);
      if(z>(type==='whale'?5.5:2.2)){tailX=Math.max(tailX,Math.abs(x));tailY=Math.max(tailY,Math.abs(y));}
    }
    if(type==='whale'){
      assert.ok(maxZ-minZ>13&&maxZ-minZ<15);assert.ok(maxX>5&&maxY>1.8);assert.ok(tailX>3&&tailY<.7);
      let headWidth=0;for(let i=0;i<mesh.vertices.length;i+=9)if(mesh.vertices[i+2]<-6)headWidth=Math.max(headWidth,Math.abs(mesh.vertices[i]));
      assert.ok(headWidth>1.05,'baleen-whale rostrum remains broad rather than a pointed rocket nose');
    }
    else{assert.ok(maxZ-minZ>5&&maxZ-minZ<6);assert.ok(maxX>1.7&&maxY>1.4);assert.ok(tailY>1.2&&tailX<.12);}
  }
  assert.throws(()=>createMarineMesh('kraken'),/Unknown marine mesh/);
});

test('whale flukes form one sealed foil with aft-swept tips, an aft notch and a buried peduncle attachment',()=>{
  const mesh=createMarineMesh('whale'),count=mesh.vertices.length/9,parents=Array.from({length:count},(_,i)=>i);
  const find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));
  for(let i=0;i<mesh.indices.length;i+=3)for(let j=1;j<3;j++)parents[find(mesh.indices[i+j])]=find(mesh.indices[i]);
  const groups=new Map();for(let id=0;id<count;id++){const root=find(id);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(id);}
  const point=id=>Array.from(mesh.vertices.subarray(id*9,id*9+3));
  const candidates=[...groups.values()].filter(ids=>ids.some(id=>point(id)[2]>6.5)&&ids.some(id=>Math.abs(point(id)[0])>3));
  assert.equal(candidates.length,1,'the two lobes share vertices across the tail centre instead of independent overlapping patches');
  const ids=candidates[0],points=ids.map(point),centre=points.filter(([x])=>Math.abs(x)<1e-6);
  const tips=points.filter(([x])=>Math.abs(x)>3.4),notch=Math.max(...centre.map(p=>p[2])),leading=Math.min(...centre.map(p=>p[2]));
  assert.ok(tips.some(([x])=>x<0)&&tips.some(([x])=>x>0));
  assert.ok(tips.every(p=>p[2]>notch+.6),'pointed tips sweep aft of the V-notch, rather than forward toward the head');
  assert.ok(leading<6&&notch>6.4,'the leading edge overlaps the peduncle while its trailing notch remains aft of the trunk');
  assert.ok(points.every(([,y])=>y>-.4&&y<-.05),'a horizontal foil retains finite, animal-scale thickness');
  // Both lobes must be closed, with outward winding. This catches open centre
  // seams and mirrored undersides that a bounding-box test would miss.
  const members=new Set(ids),edges=new Map();let signedVolume=0;
  for(let i=0;i<mesh.indices.length;i+=3){
    const triangle=Array.from(mesh.indices.subarray(i,i+3));if(!members.has(triangle[0]))continue;
    const [a,b,c]=triangle.map(point),u=b.map((v,j)=>v-a[j]),v=c.map((q,j)=>q-a[j]);
    const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    assert.ok(Math.hypot(...cross)>1e-6,'foil triangles have nonzero area');
    const normal=triangle.map(id=>Array.from(mesh.vertices.subarray(id*9+3,id*9+6))).reduce((sum,n)=>sum.map((v,j)=>v+n[j]),[0,0,0]);
    assert.ok(cross.reduce((sum,n,j)=>sum+n*normal[j],0)>0,'both foil surfaces face outwards');
    signedVolume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    for(let j=0;j<3;j++){const a=triangle[j],b=triangle[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;edges.set(key,(edges.get(key)??0)+1);}
  }
  assert.ok(signedVolume>.1,'the sealed foil encloses positive water-displacing volume');
  assert.ok([...edges.values()].every(n=>n===2),'every foil edge is welded to exactly two triangles');
  const root=centre.reduce((a,p)=>p[2]<a[2]?p:a),bodyRings=Array.from({length:77},(_,ring)=>{
    const start=ring*33*9,z=mesh.vertices[start+2],xs=[],ys=[];
    for(let sector=0;sector<32;sector++){xs.push(mesh.vertices[start+sector*9]);ys.push(mesh.vertices[start+sector*9+1]);}
    return {z,w:Math.max(...xs),h:(Math.max(...ys)-Math.min(...ys))*.5,y:(Math.max(...ys)+Math.min(...ys))*.5};
  }).sort((a,b)=>Math.abs(a.z-root[2])-Math.abs(b.z-root[2]));
  const neck=bodyRings[0];assert.ok(Math.abs(neck.z-root[2])<.15);
  assert.ok((root[0]/neck.w)**2+((root[1]-neck.y)/neck.h)**2<.25,'the leading centre is buried inside the tail stock, without a visible gap');
});

test('smooth marine profiles keep shading normals perpendicular to body tangents and closed fins share rounded rim normals',()=>{
  for(const type of ['whale','shark']){
    const mesh=createMarineMesh(type),sectors=type==='whale'?32:24,rings=type==='whale'?76:56,stride=sectors+1;
    const dot=(a,b)=>a.reduce((v,n,i)=>v+n*b[i],0);
    for(let ring=5;ring<rings-5;ring++)for(let sector=0;sector<sectors;sector++){
      const at=(ring*stride+sector)*9,before=((ring-1)*stride+sector)*9,after=((ring+1)*stride+sector)*9;
      const tangent=[0,1,2].map(a=>mesh.vertices[after+a]-mesh.vertices[before+a]),length=Math.hypot(...tangent);
      const normal=mesh.vertices.subarray(at+3,at+6);
      assert.ok(Math.abs(dot(normal,tangent))/length<.09,`${type} body normal follows its curved profile at ring ${ring}`);
    }
    // The body comes first. Rounded fin geometry shares indices across its
    // outer rim and both domed faces instead of independent flat triangles.
    const bodyVertices=(rings+1)*stride,finVertices=mesh.vertices.length/9-bodyVertices;
    const finIndices=mesh.indices.subarray(rings*sectors*6),uses=new Map();
    for(const id of finIndices)uses.set(id,(uses.get(id)??0)+1);
    assert.ok(finVertices>100);assert.ok([...uses].some(([id,count])=>id>=bodyVertices&&count>=8),'rounded foil rims share adjacent-face normals');
  }
});
