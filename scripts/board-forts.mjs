// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The works a real map records, in Castle and Commons' own terms, written to go back into that game: the forts,
// batteries and watchtowers that stood on a coast in the realm's year. Nothing here knows this game: a real map
// (REALMAP.works) lists them as it lists its towns (REALMAP.sites), each where the record puts it; the program sets
// each on dry ground before the towns are laid, turns it to the open water it holds, and stands it as a building of
// the nearest place, so its ground is kept from the town's streets and houses and it is kept with the place.
//
// Each entry is a passage of the source as it stands and what it becomes, applied after the fitting
// (scripts/board-tuning.mjs), the extensions (scripts/board-upstream.mjs), the peoples of the Americas
// (scripts/board-native.mjs) and the planted towns (scripts/board-colonial.mjs), and checked the same way; no passage
// here is one those tables wrote. scripts/board-upstream.mjs lists these changes among the simulation's for the copy
// back. Wherever no real map names a work the program does exactly as before, draw for draw: nothing below draws
// from a stream, and every rule asks first for a work, which only a real map's works give.

// The words that go into the program before its places are laid out: the works' kinds and how each is set.
const WORKS = String.raw`
/* ---- WORKS: the forts, batteries and watchtowers a real map records (c. 1450-1750) ----
   A real map may list the works that stood on its coast (REALMAP.works), each
     {kind:'fort'|'battery'|'tower', form (what it was in the realm's year: 'tower', 'artillery-tower', 'battery',
      'enclosed', 'bastioned' or 'citadel'), name, u, v (where the record puts it, as a site is put), w, d (metres
      across its front and back from it), from, until (the years it stood), role, side (the water it held and the side
      of it), rough (the record puts it only on its stretch of shore), round, battery, earth (how it was built)}.
   A work standing in the realm's year is set before the towns are laid (worksSite). It stands where the record puts
   it if that ground is dry, and where the record puts it in the water on the nearest dry ground, clear of the works
   set before it. Only a work the record puts roughly is brought down to the water's edge, and only from as near it as
   a rough record is out (WORKS_ROUGH): the ground's coast is today's, built out into the water at many ports, and a
   castle on its hill above the town stood there. It is turned to the open water nearest it (worksShore), its front
   square to it. It is a building of the nearest place, of that place's institutions: never pulled down for a street,
   never a home, kept with the place. A work whose role is citadel holds its place from the height above it: where the
   place raises a castle on its hill, the castle stands there and is the work. No street is laid and no house built on
   a work's ground. A place keeps its works as its forts (s.forts), apart from its works of peace (s.works: its mill,
   granary and market). */
const WORKS_REACH=800,WORKS_SHORE=1200,WORKS_OPEN=480,WORKS_ROUGH=240;
function worksStanding(){const L=REALMAP?.works,ad=AD();if(!Array.isArray(L)||!L.length)return [];return L.filter(k=>ARCH[k.kind]&&!(k.from>ad)&&!(k.until&&k.until<=ad));}
function worksWet(x,z){if(Math.abs(x)>SIZE/2-CELL||Math.abs(z)>SIZE/2-CELL)return false;return W.water[cIdx(toCell(x),toCell(z))]===1||hAt(x,z)<SEA||!!riverAt(x,z,0);}
// Water a ship lies on: the sea, a bay, an estuary; not a river's strip.
function worksSea(x,z){if(Math.abs(x)>SIZE/2-CELL||Math.abs(z)>SIZE/2-CELL)return false;return W.water[cIdx(toCell(x),toCell(z))]===1||hAt(x,z)<SEA;}
function worksDryAt(x,z){return Math.abs(x)<SIZE/2-2*CELL&&Math.abs(z)<SIZE/2-2*CELL&&!worksWet(x,z)&&hAt(x,z)>SEA_SURFACE+0.5;}
function worksFootprintDry(k,x,z,rot){ // how much of a work's ground is dry: its middle and a lattice of five by five over it
  const c=Math.cos(rot),s=Math.sin(rot);let dry=0;
  for(let i=-2;i<=2;i++)for(let j=-2;j<=2;j++){const lx=i/2*k.w/2,lz=j/2*k.d/2;if(worksDryAt(x+lx*c+lz*s,z-lx*s+lz*c))dry++;}
  return worksDryAt(x,z)?dry/25:0;}
// The bearing of the open water before (x,z), how far off it is and how open; or null. Along each of 48 bearings the
// first water within reach, and how much of the WORKS_OPEN beyond it is water a ship lies on (not a river's strip).
// The water before a work is the middle of the open water it sees, no more than WORKS_OPEN/2 beyond the nearest: the
// mean of those bearings, each by how open it is, so that a work on a shore faces square out from it and not along it
// to a creek or a dock's mouth a few metres nearer. Where open water lies all about (a point, an islet), the mean says
// little, and the work faces the most open of those bearings (with its neighbours to 15 degrees either side), and of
// those as open the nearest.
function worksShore(x,z){
  const N=48,first=new Float32Array(N).fill(Infinity),open=new Float32Array(N);
  for(let k=0;k<N;k++){const a=k/N*Math.PI*2,ca=Math.cos(a),sa=Math.sin(a);
    for(let r=8;r<WORKS_SHORE;r+=8){if(!worksWet(x+ca*r,z+sa*r))continue;
      let wet=0,n=0;for(let t=16;t<=WORKS_OPEN;t+=16){n++;if(worksSea(x+ca*(r+t),z+sa*(r+t)))wet++;}
      first[k]=r;open[k]=wet/n;break;}}
  let near=Infinity;for(let k=0;k<N;k++)near=Math.min(near,first[k]);if(!isFinite(near))return null;
  const seen=k=>first[k]<=near+WORKS_OPEN/2;
  let ex=0,ez=0,all=0;for(let k=0;k<N;k++)if(seen(k)){const a=k/N*Math.PI*2;ex+=Math.cos(a)*open[k];ez+=Math.sin(a)*open[k];all+=open[k];}
  if(all>0&&Math.hypot(ex,ez)>=0.35*all){
    const a=Math.atan2(ez,ex),k0=((Math.round(a/(Math.PI*2)*N)%N)+N)%N;let k=k0;
    for(let j=1;j<=N/4&&!isFinite(first[k]);j++)k=isFinite(first[(k0+j)%N])?(k0+j)%N:(k0-j+N)%N; // the water along it, or nearest it
    return {a,r:isFinite(first[k])?first[k]:near,o:open[k],open:open[k]>=0.5};}
  let best=null;
  for(let k=0;k<N;k++){if(!seen(k))continue;
    let o=0;for(let j=-2;j<=2;j++)o+=open[(k+j+N)%N];o/=5;
    if(!best||o>best.o+0.02||Math.abs(o-best.o)<=0.02&&first[k]<best.r)best={a:k/N*Math.PI*2,r:first[k],o,open:o>=0.5};}
  return best;}
// The work's turn: its front (-z of its footprint) toward the water at bearing a.
const worksRot=a=>Math.atan2(-Math.cos(a),-Math.sin(a));
function worksSite(){
  const L=worksStanding();if(!L.length)return;
  riverStrips();W._works=[];for(const s of W.settlements)s.forts=[];
  const set=[],clear=(x,z,k)=>set.every(o=>dist2d(x,z,o.x,o.z)>(Math.hypot(o.w,o.d)+Math.hypot(k.w,k.d))/2+6);
  for(const rec of L){
    const k={kind:rec.kind,form:String(rec.form||rec.kind),name:String(rec.name||ARCH[rec.kind][4]),w:Math.max(6,+rec.w||ARCH[rec.kind][0]),d:Math.max(6,+rec.d||ARCH[rec.kind][1]),from:rec.from??null,until:rec.until??null,role:rec.role||'',side:rec.side||'',rough:!!rec.rough,round:!!rec.round,battery:!!rec.battery,earth:!!rec.earth};
    const x0=(+rec.u||0)*SIZE,z0=(+rec.v||0)*SIZE,need=k.kind==='fort'?0.7:0.5,sh0=worksShore(x0,z0),rot0=sh0?worksRot(sh0.a):0;
    // Where the record puts it, if that ground is dry; else the nearest dry ground to it, by rings of a few metres,
    // turned as the record's own spot is.
    let at=null;
    for(let r=0;r<=WORKS_REACH&&!at;r+=8){const n=Math.max(1,Math.round(2*Math.PI*r/8));
      for(let q=0;q<n&&!at;q++){const x=x0+Math.cos(q/n*Math.PI*2)*r,z=z0+Math.sin(q/n*Math.PI*2)*r;
        if(clear(x,z,k)&&worksFootprintDry(k,x,z,rot0)>=need)at={x,z};}}
    if(!at)continue;
    let sh=worksShore(at.x,at.z)||sh0,rot=sh?worksRot(sh.a):rot0;
    // A work the record puts only on its stretch of shore stands at the water's edge, when the water is near.
    if(sh&&k.rough&&k.role!=='citadel'&&sh.r>k.d/2+8&&sh.r<=k.d/2+WORKS_ROUGH){
      const ca=Math.cos(sh.a),sa=Math.sin(sh.a);
      for(let t=sh.r-k.d/2-4;t>0;t-=4){const x=at.x+ca*t,z=at.z+sa*t;
        if(clear(x,z,k)&&worksFootprintDry(k,x,z,rot)>=need){at={x,z};sh=worksShore(x,z)||sh;rot=worksRot(sh.a);break;}}}
    k.x=at.x;k.z=at.z;k.rot=rot;k.face=sh?sh.a:null;
    set.push(k);W._works.push(k);W.settlements[nearestSettlementIdx(k.x,k.z)].forts.push(k);
  }
}
// Whether (x,z) is within pad metres of a work's ground (a citadel's is its castle's).
function worksAt(x,z,pad){const L=W._works;if(!L||!L.length)return false;
  for(const k of L){if(k.role==='citadel')continue;const dx=x-k.x,dz=z-k.z,c=Math.cos(k.rot),s=Math.sin(k.rot),lx=dx*c-dz*s,lz=dx*s+dz*c;
    if(Math.abs(lx)<k.w/2+pad&&Math.abs(lz)<k.d/2+pad)return true;}
  return false;}
// The citadel that holds a place, where its castle on the hill is to stand.
function worksCitadel(s){const k=(s.forts||[]).find(o=>o.role==='citadel');return k?{x:k.x,z:k.z}:null;}
// A place's works stood as its buildings (place: the place's own way of standing one), but the citadel its castle is.
function worksStand(s,place){
  for(const k of s.forts||[]){
    if(k.role==='citadel'&&s.hillCastle&&dist2d(k.x,k.z,s.hillCastle.x,s.hillCastle.z)<1){k.castle=true;continue;}
    place(k.kind,2,{x:k.x,z:k.z,w:k.w,d:k.d,rot:k.rot},'works',1,{inst:true,work:k.name});
  }
}
`;

// A passage and what it becomes, the passage itself kept where the new words only go before or after it.
const before = (why, find, words) => ({ why, find, replace: words + find });
const after = (why, find, words) => ({ why, find, replace: find + words });
const instead = (why, find, replace, count = 1) => ({ why, find, replace, count });

export const BOARD_FORTS = Object.freeze([
  after('A fort and a battery are kinds of building: a fort a bastioned work of some sixty metres, a battery a gun platform along the shore.',
    "dovecote:[6,6,7,0,'dovecote']", ",\n  fort:[60,60,8.5,1,'fort'],battery:[40,14,5.5,1,'battery']"),
  before('How the works a real map records are set and stood.', 'function layoutSettlement(s,saved,openingMethods=false){', WORKS.trimStart()),
  before('They are set on their ground before the towns are laid, so that each town lays its streets round them.',
    "  await progress('Raising timber and stone…',0.75);", '  worksSite(); // the works a real map records, before the towns that build round them\n'),
  instead('No street is laid and no house built on a work\'s ground.', 'const buildable=(x,z)=>cellOK(x,z)&&!riverAt(x,z,1)&&!lakeAt(s,x,z,2);',
    'const buildable=(x,z)=>cellOK(x,z)&&!riverAt(x,z,1)&&!lakeAt(s,x,z,2)&&!worksAt(x,z,3);'),
  instead('A citadel the record names is where the castle on the hill stands, when the place raises one.', 'let best=null,bh=hAt(C.x,C.z)+16;',
    'let best=worksCitadel(s),bh=best?Infinity:hAt(C.x,C.z)+16;'),
  before('A place\'s works are stood once its streets are laid and its castle raised, before its houses.',
    'let keep=saved?saved.keep:s._hillKeep||null;if(!saved)delete s._hillKeep;', 'if(!saved)worksStand(s,place);'),
  instead('A work is never pulled down for a street,',
    "const STANDS=new Set(['temple','keep','hall','guildhall','wall','tower','mill','windmill','granary','warehouse','court'])",
    "const STANDS=new Set(['temple','keep','hall','guildhall','wall','tower','mill','windmill','granary','warehouse','court','fort','battery'])"),
  instead('nor for a wall,', "bad=hit.find(b=>b.inst||['temple','keep','hall','guildhall','tower','mill','windmill','court'].includes(b.arch))",
    "bad=hit.find(b=>b.inst||['temple','keep','hall','guildhall','tower','mill','windmill','court','fort','battery'].includes(b.arch))"),
  instead('nor for a plan.', "blocks=b=>b.inst||['temple','keep','hall','guildhall','wall','tower','mill','windmill','court'].includes(b.arch);",
    "blocks=b=>b.inst||['temple','keep','hall','guildhall','wall','tower','mill','windmill','court','fort','battery'].includes(b.arch);"),
  after('A town\'s wall goes round a work, as round a castle.', 'if(s.burgRing)solid.push({x:s.burgRing.x,z:s.burgRing.z,r:s.burgRing.r+3});',
    'for(const k of s.forts||[])if(!k.castle)solid.push({x:k.x,z:k.z,r:Math.hypot(k.w,k.d)/2+4});'),
]);
