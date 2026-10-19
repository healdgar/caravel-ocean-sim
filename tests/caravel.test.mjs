import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaravelMesh, indexCaravelMesh } from '../js/caravel.js';
import { shadowMeshData } from '../js/shadows.js';
import { hullHalfWidth, hullSurfacePoint, deckHalfWidth, HULL_DRAFT, vesselDeck, hullDeck, TILLER_PIVOT, TILLER_HANDLE, tillerPoint, HELM_EYE_X, HELM_EYE_Z, HELM_EYE_HEIGHT, HULL_VERTICAL_SCALE, hullScale } from '../js/hull.js';
import { boatEyePosition } from '../js/boat.js';
import { createCompany, stepCompany } from '../js/crew.js';
import { SAIL_PLAN, SAIL_AREAS } from '../js/sailing.js';
import { RIG_MASTS, mastPoint } from '../js/rigging.js';

test('indexed caravel preserves every vertex bit, triangle, and shadow partition',()=>{
  const raw=createCaravelMesh(),indexed=indexCaravelMesh(raw);
  const bits=new Uint32Array(raw.buffer),compact=new Uint32Array(indexed.vertices.buffer);
  function expand(mesh,indices){
    const out=new Uint32Array(indices.length*9);
    for(let i=0;i<indices.length;i++)out.set(mesh.subarray(indices[i]*9,indices[i]*9+9),i*9);
    return out;
  }
  assert.deepEqual(expand(compact,indexed.indices),bits);
  assert.ok(indexed.vertices.byteLength+indexed.indices.byteLength<raw.byteLength*.57);
  assert.ok(indexed.vertices.byteLength+indexed.indices.byteLength<4_000_000);
  const oldShadows=shadowMeshData(raw),newShadows=shadowMeshData(indexed.vertices,indexed.indices);
  assert.deepEqual(newShadows.bounds,oldShadows.bounds);
  for(const part of ['solid','canvas'])assert.deepEqual(expand(compact,newShadows[part]),expand(bits,oldShadows[part]));
  // Position-only welding would destroy normal/material/UV seams and signed zero.
  const seams=new Float32Array(11*9);
  for(let i=2;i<11;i++)seams[i*9+i-2]=1;
  seams[0]=-0;
  assert.equal(indexCaravelMesh(seams).vertices.length,seams.length);
});
test('caravel mesh has finite triangles, unit normals, and a forward bowsprit', () => {
  const mesh = createCaravelMesh();
  assert.equal(mesh.length % 27, 0);
  assert.ok(mesh.every(Number.isFinite));
  let forward = 0;
  for (let i = 0; i < mesh.length; i += 9) {
    assert.ok(Math.abs(Math.hypot(mesh[i+3],mesh[i+4],mesh[i+5])-1)<1e-6);
    forward = Math.min(forward, mesh[i+2]);
  }
  assert.ok(forward < -8.3 && forward > -8.6);
});

test('complete vessel includes three lateen courses, single masts and a working rudder', () => {
  const mesh=createCaravelMesh();
  const bounds=new Map();
  for(let i=0;i<mesh.length;i+=9){
    const material=Math.floor(mesh[i+6]);
    if(!bounds.has(material))bounds.set(material,{minY:Infinity,maxY:-Infinity,minZ:Infinity,maxZ:-Infinity,count:0});
    const b=bounds.get(material);b.minY=Math.min(b.minY,mesh[i+1]);b.maxY=Math.max(b.maxY,mesh[i+1]);
    b.minZ=Math.min(b.minZ,mesh[i+2]);b.maxZ=Math.max(b.maxZ,mesh[i+2]);b.count++;
  }
  assert.ok(bounds.get(15).minY<=-HULL_DRAFT+.001);
  assert.ok(bounds.get(15).minZ<=-6.39 && bounds.get(15).maxZ>=5.59);
  assert.equal(bounds.has(9),false,'square courses are reserved for the future model');
  assert.ok(bounds.get(13).count>6000 && bounds.get(13).maxZ>6 && bounds.get(13).minZ<-5.9);
  assert.ok(bounds.get(13).minY>=1.95 && bounds.get(13).maxY>=12.45);
  assert.ok(bounds.get(16).count>100 && bounds.get(17).maxY>2.7);
  assert.ok(bounds.get(10).maxY>=12.59 && bounds.get(10).maxY<12.7);
  const panels=new Set();
  for(let i=6;i<mesh.length;i+=9)if([9,13].includes(Math.floor(mesh[i])))panels.add(Math.round(mesh[i]%1*16));
  assert.deepEqual([...panels].sort(),[1,2,3]);
  assert.ok(bounds.get(14).maxZ>6 && bounds.get(14).minY<-1.05);
  assert.ok(bounds.get(11).minZ>3);
});

test('lateen canvas matches the measured 20 m reconstruction and yards pivot beside their masts',()=>{
  // Independently recorded from the side-elevation audit, rounded to scan precision.
  const expected=[{area:114,luff:21.7},{area:50,luff:15.0},{area:16,luff:8.5}];
  const mesh=createCaravelMesh();
  for(const [i,s] of SAIL_PLAN.entries()){
    assert.ok(Math.abs(SAIL_AREAS[i]*HULL_VERTICAL_SCALE**2-expected[i].area)<.2);
    const [a,b]=s.corners,luff=Math.hypot(...a.map((v,j)=>v-b[j]))*HULL_VERTICAL_SCALE;
    assert.ok(Math.abs(luff-expected[i].luff)<.05);
    const axis=mastPoint(i,s.pivot[1]);
    assert.ok(Math.hypot(...axis.map((v,j)=>v-s.pivot[j]))<1e-8);
    assert.ok(s.pivot[1]<RIG_MASTS[i].height && s.pivot[1]>vesselDeck(axis[2]));
    for(const p of s.corners){
      let nearest=Infinity;
      for(let j=0;j<mesh.length;j+=9)if(Math.abs(mesh[j+6]-(13+s.id/16))<1e-6)
        nearest=Math.min(nearest,Math.hypot(...p.map((v,k)=>v-mesh[j+k])));
      assert.ok(nearest<1e-5,'rendered sail boundary retains the measured corners');
    }
  }
});

test('raked hull surface agrees with water-contact sections and stays within the mesh budget', () => {
  for(let z=-6.4;z<=5.6;z+=.2)for(let a=0;a<=Math.PI;a+=.08){
    const [x,y,station]=hullSurfacePoint(z,a);
    assert.ok(Math.abs(Math.abs(x)-hullHalfWidth(station,y))<1e-7);
  }
  assert.equal(hullHalfWidth(-6.4,-.5),0, 'raked stem clears the water ahead of the submerged bow');
  assert.equal(hullHalfWidth(0,-HULL_DRAFT-.1),0);
  assert.ok(createCaravelMesh().length/27<95000,'single ship stays below 95k triangles');
});

// Intersect actual triangles, so tests catch planking/trim occluding an opening.
function firstHit(mesh,origin,direction,ignore=[]){
  const sub=(a,b)=>a.map((x,i)=>x-b[i]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  let distance=Infinity,material=-1;
  for(let i=0;i<mesh.length;i+=27){
    if(ignore.includes(Math.floor(mesh[i+6])))continue;
    const a=Array.from(mesh.slice(i,i+3)),b=Array.from(mesh.slice(i+9,i+12)),c=Array.from(mesh.slice(i+18,i+21));
    const e1=sub(b,a),e2=sub(c,a),p=cross(direction,e2),det=dot(e1,p);
    if(Math.abs(det)<1e-9)continue;
    const t=sub(origin,a),u=dot(t,p)/det;if(u<0 || u>1)continue;
    const q=cross(t,e1),v=dot(direction,q)/det;if(v<0 || u+v>1)continue;
    const d=dot(e2,q)/det;
    if(d>=0 && d<distance){distance=d;material=mesh[i+6];}
  }
  return {material,point:origin.map((x,i)=>x+direction[i]*distance)};
}

test('captain stands on the quarterdeck with clear forward sightlines at supported vessel scales',()=>{
  const raw=createCaravelMesh();
  for(const [length,beam] of [[12,3.6],[20,6],[24,7.2]])for(const side of [-1,1]){
    const scale=hullScale(length,beam),mesh=raw.slice();
    for(let i=0;i<mesh.length;i+=9)for(let axis=0;axis<3;axis++)mesh[i+axis]*=scale[axis];
    const eye=boatEyePosition(new Float64Array(3),{x:0,z:0,heave:0,eye:HELM_EYE_HEIGHT,eyeSide:side,length,beam,heading:0,pitch:0,roll:0});
    const floor=firstHit(mesh,[eye[0],vesselDeck(HELM_EYE_Z)*scale[1]+.15,eye[2]],[0,-1,0]);
    assert.equal(floor.material,0,'a real deck supports the captain, not an overboard camera');
    assert.ok(Math.abs(eye[1]-floor.point[1]-1.6)<.01,'normal standing eye height');
    for(const pitch of [-5.5,0])for(const yaw of [-6,0,6]){
      const p=pitch*Math.PI/180,h=yaw*Math.PI/180;
      // Thin ropes naturally cross the view; test the solid mast/spar/canvas
      // obstruction that can actually swallow the captain's field of view.
      const hit=firstHit(mesh,Array.from(eye),[Math.sin(h)*Math.cos(p),Math.sin(p),-Math.cos(h)*Math.cos(p)],[12,19]);
      if(yaw===0)assert.equal(hit.material,-1,`clear centre view: ${length} m hull, pitch ${pitch}`);
      // Off-axis sails/ropes remain visible, but cannot fill the eye's immediate
      // neighbourhood. Small hulls retain full-height sails and narrow the view.
      else assert.ok(hit.material===-1||Math.hypot(...hit.point.map((v,i)=>v-eye[i]))>3,
        `near obstruction: ${length} m hull, side ${side}, yaw ${yaw}, pitch ${pitch}: ${JSON.stringify(hit)}`);
    }
    for(let i=0;i<RIG_MASTS.length;i++){
      const centre=mastPoint(i,eye[1]/scale[1]);
      assert.ok(Math.hypot((side*HELM_EYE_X-centre[0])*scale[0],(HELM_EYE_Z-centre[2])*scale[2])>RIG_MASTS[i].r*scale[0]+.5);
    }
  }
});

test('two modest stern lights are recessed; cabin sides are planked',()=>{
  const mesh=createCaravelMesh();
  for(const x of [-.48,.48]){
    const hit=firstHit(mesh,[x+.065,1.62,6.5],[0,0,-1]);
    assert.equal(hit.material,11,'stern planking must not cross a pane');
    assert.ok(hit.point[2]<5.55 && hit.point[2]>5.50);
  }
  for(const side of [-1,1])for(const z of [3.4,4.35,5.18]){
    assert.equal(firstHit(mesh,[side*3,1.60,z+.1],[-side,0,0]).material,1);
  }
});

test('continuous main deck and quarterdeck support a direct tiller below the after deck',()=>{
  const mesh=createCaravelMesh();
  for(const z of [-5,-1.9,3.1]){
    const hit=firstHit(mesh,[.3,vesselDeck(z)+.15,z],[0,-1,0]);
    assert.equal(hit.material,0);
    assert.ok(Math.abs(hit.point[1]-vesselDeck(z))<.003);
  }
  assert.ok(TILLER_HANDLE[2]<TILLER_PIVOT[2]);
  const helmTriangles=[];
  for(let i=0;i<mesh.length;i+=9)if(mesh[i+6]===7||mesh[i+6]===8)helmTriangles.push(Array.from(mesh.subarray(i,i+3)));
  assert.ok(helmTriangles.length>0);
  for(const [x,y,z] of helmTriangles){
    assert.ok(y>hullDeck(z) && y<vesselDeck(z),'tiller occupies the main-deck steering space');
    assert.ok(Math.abs(x)<.2,'no wheel rim or spokes remain');
  }
  for(const rudder of [-35,0,35]){
    const b={length:20,beam:6,rudder},p=tillerPoint(b),z=p[2]/(20/12);
    assert.ok(Math.abs(p[0])+.2<hullHalfWidth(z,1.34)*(6/3.6),'full helm remains inside the hull');
  }
});

test('20 m hull grounds adult crew on real decks, keeps the helm reachable and limits stair risers',()=>{
  const mesh=createCaravelMesh(),scale=hullScale(),company=createCompany();
  // All ship geometry, including the tiller, shares the hull transform.
  for(let i=0;i<mesh.length;i+=9)for(let axis=0;axis<3;axis++){
    mesh[i+axis]*=scale[axis];
  }
  stepCompany(company,{length:20,beam:6},0,0);
  for(const sailor of company.crew){
    // Probe each boot beside any caulk gap, from below arms/torso height.
    const p=Array.from(sailor.position),hits=[-.07,.07].map(dx=>firstHit(mesh,[p[0]+dx,p[1]+.15,p[2]],[0,-1,0]));
    const hit=hits.sort((a,b)=>b.point[1]-a.point[1])[0];
    assert.equal(hit.material,0,`${sailor.id} stands on deck boards`);
    assert.ok(Math.abs(hit.point[1]-(p[1]-.028))<.015,`${sailor.id} feet match the enlarged deck`);
  }
  const helm=company.crew.find(s=>s.role==='Helmsman');
  const grip=tillerPoint({length:20,beam:6});
  assert.ok(Math.abs(helm.position[2]-grip[2]+.32)<1e-6);
  assert.ok(grip[1]-helm.position[1]>.9 && grip[1]-helm.position[1]<1.1);
  assert.ok(helm.position[1]+1.8<vesselDeck(helm.z)*scale[1],'standing head clears the quarterdeck');
  // Detect actual upper tread faces, rather than trusting the requested step count.
  for(const [xmin,xmax,zmin,zmax,minSteps,startZ] of [[.69,1.23,1.4,2.75,12,1.5]]){
    const levels=new Set();
    for(let i=0;i<mesh.length;i+=9)if(mesh[i+6]===6&&mesh[i+4]>.999&&
      mesh[i]/scale[0]>xmin&&mesh[i]/scale[0]<xmax&&mesh[i+2]/scale[2]>zmin&&mesh[i+2]/scale[2]<zmax){
      levels.add(Math.round(mesh[i+1]*10000)/10000);
    }
    const heights=[...levels].sort((a,b)=>a-b);assert.ok(heights.length>=minSteps);
    assert.ok(heights[0]-vesselDeck(startZ)*scale[1]<=.231,'first tread is reachable from the deck');
    for(let i=1;i<heights.length;i++)assert.ok(heights[i]-heights[i-1]<=.231);
  }
});

test('fine bow and stern sections retain a full midbody and four unobstructed gun muzzles',()=>{
  assert.ok(hullHalfWidth(-5.8,1.5)<.55,'foremost metre tapers into the stem');
  assert.ok(hullHalfWidth(5.0,-.7)<hullHalfWidth(5.0,0)*.7,'underwater stern has a fine run');
  assert.ok(hullHalfWidth(0,0)>1.7,'midbody buoyancy stays full');
  const mesh=createCaravelMesh();
  for(const side of [-1,1])for(const z of [3.25,4.9]){
    const hit=firstHit(mesh,[side*4,2.935,z],[-side,0,0]);
    assert.ok([3,4].includes(hit.material),'four elevated iron falconets exist');
  }
  for(const z of [-5.5,-4.2,-3.8])assert.ok(vesselDeck(z)<1.2,'continuous sheer replaces the forecastle tier');
});

test('quarterdeck seams are caulked, its underside is closed and rail feet bear on timber',()=>{
  const mesh=createCaravelMesh();
  for(const x of [-1.7+8*.145+.1425,-1.7+14*.145+.1425]){
    const hit=firstHit(mesh,[x,2.32,3.7],[0,-1,0],[12,19]);
    assert.equal(hit.material,4,'a seam exposes caulk, never the cabin below');
    assert.ok(Math.abs(hit.point[1]-2.282)<.001);
    const ceiling=firstHit(mesh,[x,2.1,3.7],[0,1,0],[12,19]);
    assert.equal(ceiling.material,1);
    assert.ok(Math.abs(ceiling.point[1]-2.225)<.001);
  }
  for(const side of [-1,1])for(const z of [2.7,3.18,3.66,4.14,4.62,5.1,5.6]){
    const x=side*(deckHalfWidth(z)+.105-.04);
    const support=firstHit(mesh,[x,2.301,z],[0,-1,0],[17,12,19]);
    assert.ok([0,1].includes(support.material));
    assert.ok(2.3-support.point[1]<.003,'rail foot touches deck or rim');
  }
});

test('stair treads intersect both stringers and gun forks connect to their swivel shafts',()=>{
  const parts=new Map(),raw=createCaravelMesh({parts});
  const triangles=material=>new Float32Array(Array.from({length:raw.length/27},(_,i)=>i*27)
    .filter(i=>raw[i+6]===material).flatMap(i=>Array.from(raw.subarray(i,i+27))));
  const stair=triangles(6),iron=triangles(3),floor=hullDeck(1.5),steps=Math.ceil((2.3-floor)*HULL_VERTICAL_SCALE/.23);
  for(const x of [.72,1.20])for(let i=0;i<steps;i++){
    const y=floor+(2.3-floor)*(i+1)/steps-.02,z=1.5+i*1.14/(steps-1);
    const tread=parts.get(`stair:tread:${i}`),bottom=Math.min(...Array.from(tread).filter((_,j)=>j%9===1));
    const support=firstHit(parts.get(`stair:stringer:${x}`),[x,y+.2,z],[0,-1,0]);
    assert.ok(support.point[1]>=bottom-1e-6,'actual stringer intersects the tread underside; no floating step');
    // Midway between treads, a stringer must still exist (floating steps fail).
    if(i<steps-1){
      const middle=z+.5*1.14/(steps-1),hit=firstHit(stair,[x,2.4,middle],[0,-1,0]);
      assert.ok(hit.point[1]>floor && hit.point[1]<2.3,'continuous side support between steps');
    }
  }
  for(const side of [-1,1])for(const z of [3.25,4.9]){
    const x=side*(deckHalfWidth(z)+.105-.04);
    for(const dz of [-.07,.07]){
      const hit=firstHit(iron,[x+.15,2.77,z+dz],[-1,0,0]);
      assert.ok(Math.abs(hit.point[0]-x)<.025,'fork base joins both arms to the central shaft');
    }
  }
});

test('bulwark seams block sightlines while scuppers remain open',()=>{
  const mesh=createCaravelMesh();
  for(const side of [-1,1]){
    const z=-.85,y=hullDeck(z),x=side*(deckHalfWidth(z)+.2);
    const seam=firstHit(mesh,[x,y+.123*3-.002,z],[-side,0,0],[12,19]);
    assert.equal(seam.material,4,'thin board joints expose recessed caulking');
    assert.ok(Math.abs(seam.point[0])>deckHalfWidth(z));
    const drain=firstHit(mesh,[x,y+.065,z],[-side,0,0],[12,19]);
    assert.ok(side*drain.point[0]<deckHalfWidth(z)-.1,'near-side scupper is open');
  }
});

test('vertical planking and individual deck boards have noncollapsed, continuous grain coordinates',()=>{
  const mesh=createCaravelMesh();let checked=0;
  for(let i=0;i<mesh.length;i+=27){
    const material=mesh[i+6];
    // Stern fan previously projected onto XZ, producing radial streaks. Deck
    // corners previously selected different texture tiles within one board.
    if(material===1 && [2,11,20].every(j=>mesh[i+j]>5.1) && [4,13,22].every(j=>Math.abs(mesh[i+j])<.7)){
      const u1=mesh[i+16]-mesh[i+7],v1=mesh[i+17]-mesh[i+8],u2=mesh[i+25]-mesh[i+7],v2=mesh[i+26]-mesh[i+8];
      assert.ok(Math.abs(u1*v2-u2*v1)>1e-9,'vertical timber UV triangles retain area');checked++;
    }
    if(material===0){
      const offsets=[0,9,18].map(j=>mesh[i+j+7]-mesh[i+j]*1.6);
      assert.ok(Math.max(...offsets)-Math.min(...offsets)<1e-6,'one grain offset per board');
    }
  }
  assert.ok(checked>20);
});

test('hull bands follow the sheer through the raked ends and weld to hull vertices',()=>{
  const parts=new Map();createCaravelMesh({parts});
  const positions=mesh=>{
    const unique=new Map();
    for(let i=0;i<mesh.length;i+=9){const p=Array.from(mesh.subarray(i,i+3));unique.set(p.join(','),p);}
    return [...unique.values()];
  };
  const hull=positions(parts.get('hull')),transom=positions(parts.get('transom'));
  const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
  const edges=mesh=>{
    const result=new Map(),key=p=>p.map(x=>Math.round(x*1e6)).join(',');
    for(let i=0;i<mesh.length;i+=27)for(const [a,b]of [[0,9],[9,18],[18,0]]){
      const pair=[key(Array.from(mesh.subarray(i+a,i+a+3))),key(Array.from(mesh.subarray(i+b,i+b+3)))].sort().join('|');
      result.set(pair,(result.get(pair)||0)+1);
    }
    return result;
  };
  const hullEdges=edges(parts.get('hull'));
  for(const side of [-1,1]){
    const band=positions(parts.get(`wale:${side}:-0.35`));
    const boundary=[...edges(parts.get(`wale:${side}:-0.35`))].filter(([,count])=>count===1);
    assert.ok(boundary.length>=228);
    for(const [edge]of boundary)assert.ok(hullEdges.has(edge),'every open band edge is welded to an actual hull triangle edge');
    const endpoints=[];
    for(const offset of [-.275,-.425]){
      const edge=hull.filter(p=>side*p[0]>0 && Math.abs(p[1]-hullDeck(p[2])-offset)<2e-6);
      assert.ok(edge.length>=113,'both attachment edges span the whole hull');
      for(const p of edge){
        assert.ok(band.some(q=>distance(p,q)<1e-6),'attachment vertex is shared with hull within 2 micrometres at vessel scale');
        const outer=[p[0]+side*.035,p[1],p[2]];
        assert.ok(band.some(q=>distance(outer,q)<1e-6),'outer edge has constant proud thickness; no centreline snap');
      }
      endpoints.push(edge.reduce((a,b)=>a[2]>b[2]?a:b));
    }
    for(const p of endpoints)assert.ok(transom.some(q=>distance(p,q)<1e-6),'band/hull seam meets the actual transom boundary');
    // Every visible band vertex belongs to an attachment or its proud surface.
    for(const p of band){
      assert.ok([-0.275,-0.425].some(offset=>Math.abs(p[1]-hullDeck(p[2])-offset)<2e-6));
      const nearest=hull.filter(q=>side*q[0]>0 && Math.abs(q[1]-p[1])<1e-6 && Math.abs(q[2]-p[2])<1e-6);
      assert.ok(nearest.some(q=>Math.abs(p[0]-q[0])<1e-6 || Math.abs(side*(p[0]-q[0])-.035)<1e-6));
    }
  }
});
