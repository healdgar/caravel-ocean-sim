import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createVictoryMesh} from '../js/victory.js';
import {indexCaravelMesh} from '../js/caravel.js';
import {getShipModel} from '../js/ship-models.js';
import {VICTORY_DESIGN as D,VICTORY_MASTS,VICTORY_SAILS,VICTORY_RUNNING_LINES,victoryHullHalfWidth,
  victoryHullDeck,victoryVesselDeck,victoryDeckHalfWidth,victorySheer,
  victorySailPoint,victorySailArea,victoryAnchorCathead} from '../js/models/victory.js';

const groups=[],mesh=createVictoryMesh({groups});
test('Victory uses reported gundeck dimensions, its own three-decker hull and an explicit construction boundary',()=>{
  assert.ok(Math.abs(D.runtime.length-186*.3048)<1e-10);
  assert.ok(Math.abs(D.runtime.beam-52*.3048)<1e-10);
  assert.equal(D.frame.verticalScale,D.runtime.length/12);
  assert.match(D.provenance.interpretation,/not surveyed/);
  assert.ok(Object.isFrozen(D)&&Object.isFrozen(D.hull));
  assert.equal(D.gunDecks.reduce((n,d)=>n+d.count,0),104);
  assert.equal(VICTORY_MASTS.length,3);
  assert.ok(victoryHullHalfWidth(0,0)>victoryHullHalfWidth(0,victoryHullDeck(0)),'first-rate has tumblehome above its broad waterline');
  assert.ok(victoryHullHalfWidth(-4,0)<victoryHullHalfWidth(0,0),'bow tapers from the midbody');
  assert.equal(victoryHullHalfWidth(-6,-1),0,'raked underwater stem leaves the forward water clear');
  assert.equal(victoryHullHalfWidth(0,-D.hull.draft-.1),0);
  assert.ok(victoryVesselDeck(5)>victoryVesselDeck(3)&&victoryVesselDeck(3)>victoryVesselDeck(0));
  for(const side of [-1,1]){
    const cat=victoryAnchorCathead(side);
    assert.ok(Math.abs(cat.root[0])<Math.abs(cat.tip[0]));
    assert.ok(Math.abs(cat.tip[0])>victoryDeckHalfWidth(cat.tip[2]));
    assert.ok(cat.fairlead[1]>victoryVesselDeck(cat.fairlead[2]));
  }
});
test('Victory has finite unit-normal geometry, gun batteries and distinctive ship-of-the-line fittings within budget',()=>{
  assert.equal(mesh.length%27,0);
  assert.ok(mesh.every(Number.isFinite));
  // Curved deck edges, closed wales and segmented stern galleries require real
  // joining faces; retain a bounded budget rather than omit those surfaces.
  assert.ok(mesh.length/27<84_000,'joined reconstruction stays inside the 84k triangle budget');
  const materials=new Set();let maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(let i=0;i<mesh.length;i+=9){
    assert.ok(Math.abs(Math.hypot(mesh[i+3],mesh[i+4],mesh[i+5])-1)<1e-6);
    materials.add(Math.floor(mesh[i+6]));maxY=Math.max(maxY,mesh[i+1]);minZ=Math.min(minZ,mesh[i+2]);maxZ=Math.max(maxZ,mesh[i+2]);
  }
  for(const m of [0,2,3,4,7,9,11,13,14,19,20,21,22,23,24,25])assert.ok(materials.has(m));
  assert.ok(maxY>13.15&&minZ< -10.5&&maxZ>6.5);
  const names=new Set(groups.map(g=>g.id));
  for(const name of ['deck.main.planks','deck.quarter.planks','deck.forecastle.planks','deck.poop.planks',
    'hull.wales.port','hull.wales.starboard','stern.galleries','helm.wheel','helm.rudder','boat.waist.0',
    'mast.fore','mast.main','mast.mizzen','yard.mizzen-crossjack'])assert.ok(names.has(name),name);
  assert.equal(groups.filter(g=>g.id.startsWith('gun.')).length,104);
  for(const g of D.gunDecks)assert.equal(groups.filter(n=>n.id.startsWith('gun.'+g.id+'.')).length,g.count);
  for(const g of groups){assert.equal(g.firstVertex%3,0);assert.equal(g.vertexCount%3,0);assert.ok(g.vertexCount>0&&g.firstVertex+g.vertexCount<=mesh.length/9);}
  const model=getShipModel('victory');
  for(const g of groups)assert.ok(model.nodes[g.nodeId],`rendered part ${g.id} needs semantic structure node ${g.nodeId}`);
});
test('Victory has square tiers, fore-and-aft headsails and driver, with the surviving fore-topsail dimensions',()=>{
  assert.equal(VICTORY_SAILS.length,12);
  assert.equal(VICTORY_SAILS.filter(s=>s.kind==='square').length,8);
  assert.equal(VICTORY_SAILS.filter(s=>s.kind==='headsail').length,3);
  assert.equal(VICTORY_SAILS.filter(s=>s.kind==='spanker').length,1);
  assert.equal(VICTORY_SAILS.some(s=>s.name==='mizzen-crossjack'),false,'crossjack is a bare yard, not another square course');
  const mizzen=VICTORY_SAILS.find(s=>s.name==='mizzen-topsail'),crossjackGroup=groups.find(g=>g.id==='yard.mizzen-crossjack');
  assert.equal(crossjackGroup.motion.sail,mizzen.id);
  assert.ok(VICTORY_RUNNING_LINES.filter(l=>l.sail===mizzen.id&&l.kind==='sheet').every(l=>l.bSail===mizzen.id&&Math.abs(l.b[0])===1.98),'mizzen topsail sheets lead to the braced bare crossjack');
  const sail=VICTORY_SAILS.find(s=>s.name==='fore-topsail'),[a,b,c,d]=sail.corners,xScale=D.runtime.beam/3.6;
  assert.ok(Math.abs((b[0]-a[0])*xScale-54*.3048)<1e-8);
  assert.ok(Math.abs((c[0]-d[0])*xScale-80*.3048)<1e-8);
  assert.ok(Math.abs((a[1]-d[1])*D.frame.verticalScale-54*.3048)<1e-8);
  assert.ok(Math.abs(victorySailArea(sail.id)-3618*.3048**2)<1e-6);
  for(const s of VICTORY_SAILS){
    const uv=s.kind==='headsail'?[[0,0],[1,0],[0,1]]:[[0,0],[1,0],[1,1],[0,1]];
    uv.forEach((p,i)=>assert.deepEqual(victorySailPoint(s.id,...p),s.corners[i]));
    const group=groups.find(g=>g.id==='sail.'+s.name);assert.ok(group);
    const material=(s.kind==='headsail'?13:9)+s.id/64;
    for(let i=group.firstVertex*9;i<(group.firstVertex+group.vertexCount)*9;i+=9)assert.equal(mesh[i+6],material);
  }
  for(const mast of [0,1,2]){
    const tiers=VICTORY_SAILS.filter(s=>s.mast===mast&&s.kind==='square').sort((a,b)=>a.top-b.top);
    for(let i=1;i<tiers.length;i++){
      assert.ok(tiers[i].top-tiers[i].height>tiers[i-1].top,'separate tiers leave a gap above the lower yard');
      for(const line of VICTORY_RUNNING_LINES.filter(l=>l.sail===tiers[i].id&&l.kind==='sheet'))assert.equal(line.bSail,tiers[i-1].id,'sheet reaches the immediately lower yard');
    }
    for(const s of tiers)assert.ok(s.belly/s.height<=.18,'authored camber stays below 18 percent of panel depth');
  }
});
function firstHit(origin,direction){
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sub=(a,b)=>a.map((x,i)=>x-b[i]),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  let nearest=Infinity,material=-1;
  for(let i=0;i<mesh.length;i+=27){
    const a=Array.from(mesh.subarray(i,i+3)),b=Array.from(mesh.subarray(i+9,i+12)),c=Array.from(mesh.subarray(i+18,i+21));
    const e=sub(b,a),f=sub(c,a),p=cross(direction,f),det=dot(e,p);if(Math.abs(det)<1e-10)continue;
    const t=sub(origin,a),u=dot(t,p)/det;if(u<0||u>1)continue;
    const q=cross(t,e),v=dot(direction,q)/det;if(v<0||u+v>1)continue;
    const d=dot(f,q)/det;if(d>=0&&d<nearest){nearest=d;material=Math.floor(mesh[i+6]);}
  }
  return {material,distance:nearest};
}
test('each main gun deck has real skin openings rather than black paint over solid hull',()=>{
  for(const g of D.gunDecks.slice(0,3))for(const side of [-1,1]){
    const i=4,z=g.start+(g.end-g.start)*i/(g.count/2-1),y=g.centre+victorySheer(z)+.07;
    const hit=firstHit([side*3,y,z+.035],[-side,0,0]);
    assert.equal(hit.material,4,`${g.id} ${side}: ray above muzzle must reach the dark inner gunport recess`);
    assert.ok(hit.distance>3-victoryHullHalfWidth(z,y)+.08);
  }
});
test('Victory compact indexing preserves all material tags, normals, UV seams and triangle order exactly',()=>{
  const indexed=indexCaravelMesh(mesh),rawBits=new Uint32Array(mesh.buffer),bits=new Uint32Array(indexed.vertices.buffer);
  for(let i=0;i<indexed.indices.length;i++)for(let j=0;j<9;j++)assert.equal(bits[indexed.indices[i]*9+j],rawBits[i*9+j]);
  assert.ok(indexed.vertices.byteLength+indexed.indices.byteLength<5_400_000);
});
