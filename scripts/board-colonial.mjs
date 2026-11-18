// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The towns the Old World's crowns planted overseas, in Castle and Commons' own terms, written to go back into that
// game: a manner a tongue's towns were laid out by where its crown founded a colony (the Spanish traza, the Portuguese
// hill town), the year the colony was founded, and how settled the country about it was. Nothing here knows this game:
// no port, no coast, no global of its own; a real map (REALMAPS) says which of its tongues planted by which manner, as
// it says which tongue each of its towns speaks. What fits the model to this game's ground stays in
// scripts/board-tuning.mjs and the game's modules.
//
// Each entry is a passage of the source as it stands and what it becomes, applied after the fitting
// (scripts/board-tuning.mjs), the other extensions (scripts/board-upstream.mjs) and the peoples of the Americas
// (scripts/board-native.mjs), and checked the same way; no passage here is one those tables wrote, so each table can
// be copied back on its own. scripts/board-upstream.mjs lists these changes among the simulation's for that copy.
// Wherever no real map names a manner the program does exactly as before, draw for draw: a planted town's founding is
// drawn from a stream of its own, and every rule below asks the town's manner first, which only a planted town has.
//
// Sources of the manners: the crown's instructions to Ovando (1501) and Pedrarias (1513), and the Ordinances of
// 1573 that wrote down what they had made (Crouch, Garr and Mundigo 1982; Kagan 2000); Smith 1955 and Reis Filho 1968
// on the Portuguese towns of Brazil and the islands (Salvador, Olinda, Funchal); Teixeira and Valla 1999.

// The words that go into the program before its settlements' origins are drawn: the manners, as data, and the few
// functions a planted town is laid out by. In the program's own style, so it reads as its own.
const PLANTED = String.raw`
/* ---- PLANTED TOWNS: the towns a crown laid out in one stroke where it planted a colony (c. 1500-1600) ----
   A real map may say a tongue's towns on it were planted by a manner (REALMAP.manners: {tongue: manner}), the year its
   colony was founded (REALMAP.founded: its seat's year; every other place of the colony's is founded some years on)
   and how settled the country about was (REALMAP.settled, 0 to 1: the share of the towns and villages an Old World
   country of its size holds, and of their people). A town or capital of that tongue is laid out by its manner; a
   village stays a village, the farms, ranches and mills of the country being nobody's plan.
     traza    the Spanish grid, as the crown's instructions had it from Santo Domingo (1502) on, before the Ordinances
              of 1573 wrote it down: a square plaza a block across, its sides square to the shore; straight streets on
              a lattice of square blocks running out from it, the four from its corners the widest; the church and the
              cabildo on the plaza, the vecinos' houses broadside to the streets
     ladeira  the Portuguese hill town (Olinda, Salvador): the upper town about a largo on the high flat ground near the
              landing, with the Sé and the câmara, and a short grid of streets along the brow; the lower town about a
              praça at the landing, its rua direita along the shore; ladeiras climbing between them. Where the ground
              gives no height near the landing, the one town about its praça.
   block: metres between the streets' lines; street: their half-width; per: the houses a block holds; burgher: false
   where the houses stand broadside to the street, not gable-on in burgage rows; rise: metres the upper town stands
   above the landing, at least, and reach: how far from it, at most (the town's reach widens to take it in).
   A colony's place has grown through as many ages as it has had eight years since its founding, up to an Old World
   place's: its fires, sieges and rebuildings are of its own years, not of centuries it never had. */
const MANNERS={
  traza:{block:88,street:4.2,per:28,burgher:false,
    line:'Planted by the crown’s order: a square plaza a block across, the church and the cabildo on it, and straight streets running out from it on a lattice of square blocks, the house lots drawn among the first settlers.'},
  ladeira:{block:60,street:3.4,per:20,burgher:true,rise:12,reach:480,
    line:'Planted on the height above the landing: the upper town about its largo, with the Sé and the câmara, and a short grid of streets along the brow; below, the landing’s warehouses and its rua direita along the shore, and steep ladeiras between them.',
    flat:'Planted by the landing about a largo, with the Sé and the câmara on it, and a short grid of streets along the shore.'},
};
function plantedManner(s){if(!REALMAP?.manners||s.kind==='village'||waysOf(s))return null;const m=REALMAP.manners[s.cult];return MANNERS[m]?m:null;}
function plantedColony(s){return REALMAP?.founded>0&&!waysOf(s);} // a place of the colony, not of a people who were there before it
function plantedSettled(){const k=REALMAP?.settled;return k>=0&&k<1?k:1;} // so many of the Old World's towns and villages, and so big
function plantedOrigin(s,m,idx,era,live){ // its founding, as recorded: the seat in the colony's year, the rest some years on, by a stream of its own
  const F=Math.min(era,REALMAP.founded),r=seedStreams((SEED^Math.imul(idx+1,0x85EBCA6B)^0x504C4E54)>>>0).gen;
  return{kind:m?'planted':'colony',foundedAD:live?era:s.kind==='capital'?F:Math.round(F+(era-F)*(0.25+0.6*r())),layout:m||s.forceMode||(s.kind==='village'?'village':'grown'),live};
}
function plantedEpochs(o,era,E){ // a colony's places have grown only so many ages: one for each eight years since their founding
  return o.kind==='planted'||o.kind==='colony'?clamp(Math.round((era-o.foundedAD)/8),1,E):E;}
function plantedShore(C,reach){ // the bearing of the nearest sea within reach metres of C, or null
  let best=null,bd=1e9;
  for(let k=0;k<48;k++){const a=k/48*Math.PI*2;for(let r=16;r<reach;r+=8){if(W.water[cIdx(toCell(C.x+Math.cos(a)*r),toCell(C.z+Math.sin(a)*r))]===1){if(r<bd){bd=r;best=a;}break;}}}
  return best;}
function plantedSquare(x,z,h,g){ // a square open place h metres to each side of its middle, its sides along the bearing g
  return{x,z,r:Array.from({length:PLN},(_,k)=>{const a=k/PLN*Math.PI*2-g;return h/Math.max(Math.abs(Math.cos(a)),Math.abs(Math.sin(a)));})};}
function plantedClimb(A,B,ok){ // a ladeira: from A up to B the easiest way, eight metres a step, its grade spared where the ground allows
  const pts=[{x:A.x,z:A.z}];let x=A.x,z=A.z;
  for(let n=0;n<160&&dist2d(x,z,B.x,B.z)>10;n++){const b=Math.atan2(B.z-z,B.x-x);let best=null,bc=1e9;
    for(const d of[-1.1,-0.7,-0.35,0,0.35,0.7,1.1]){const h=b+d,nx=x+Math.cos(h)*8,nz=z+Math.sin(h)*8;if(!ok(nx,nz))continue;
      const c=Math.max(0,Math.abs(hAt(nx,nz)-hAt(x,z))/8-0.14)*40+Math.abs(d)*1.2-(dist2d(x,z,B.x,B.z)-dist2d(nx,nz,B.x,B.z))*0.15;if(c<bc){bc=c;best={x:nx,z:nz};}}
    if(!best)break;x=best.x;z=best.z;pts.push(best);}
  if(dist2d(x,z,B.x,B.z)>10)return resample([{x:A.x,z:A.z},{x:B.x,z:B.z}],8).filter(q=>ok(q.x,q.z)); // no easier way: straight up the face, as stairs climb it
  pts.push({x:B.x,z:B.z});return smoothPath(pts,2);}
function plantTown(M,k){ // a planted town laid out in one stroke by its manner (MANNERS); k is the founding's kit (layoutSettlement)
  const{C,rAng,Rmax,count,isCap,addStreet,addPlace,placeOK,buildable,inPlace,lineRuns,aroundPlace}=k,B=M.block,hw=M.street;
  const sea=plantedShore(C,Rmax),open=(x,z)=>buildable(x,z)&&!inPlace(x,z,2);
  const blocks=(O,g,n,ok)=>{let c=0;const ux=Math.cos(g),uz=Math.sin(g);for(let i=-n;i<=n;i++)for(let j=-n;j<=n;j++)if((i||j)&&ok(O.x+(ux*i-uz*j)*B,O.z+(uz*i+ux*j)*B))c++;return c;};
  const lattice=(O,g,houses,ok,extra)=>{ // streets on the lines between blocks, out from the middle one as far as the houses need
    const need=Math.ceil(houses*1.2/M.per);let n=1;while(n<8&&(n+0.5)*B<Rmax*1.25&&blocks(O,g,n,ok)<need)n++;
    const ux=Math.cos(g),uz=Math.sin(g),vx=-uz,vz=ux,L=(n+0.5)*B;
    for(let j=-n-1;j<=n;j++){const o=(j+0.5)*B,w=j===-1||j===0?hw*1.25:hw; // the lines along the plaza's sides run on as the widest streets
      for(const r of lineRuns(O.x-ux*L+vx*o,O.z-uz*L+vz*o,O.x+ux*L+vx*o,O.z+uz*L+vz*o,ok))addStreet(r,w,'grid',{straight:true,planted:true,...extra});
      for(const r of lineRuns(O.x-vx*L+ux*o,O.z-vz*L+uz*o,O.x+vx*L+ux*o,O.z+vz*L+uz*o,ok))addStreet(r,w,'grid',{straight:true,planted:true,...extra});}};
  const square=(O,h,g)=>{const p=plantedSquare(O.x,O.z,h,g);if(!placeOK(p))return null;addPlace(p,'market');return p;};
  const g0=sea==null?rAng:sea; // square to the shore, where there is one; else along the road in
  let up=null;
  if(M.rise){ // the height above the landing: the highest flat ground near it, the nearer the better
    const h0=hAt(C.x,C.z);let best=-1e9;
    for(let r=60;r<=M.reach;r+=20)for(let a=0;a<32;a++){const x=C.x+Math.cos(a/32*Math.PI*2)*r,z=C.z+Math.sin(a/32*Math.PI*2)*r,h=hAt(x,z);
      if(h<h0+M.rise||!buildable(x,z))continue;let flat=0;
      for(const[dx,dz]of[[0,0],[1,0],[-1,0],[0,1],[0,-1]])if(buildable(x+dx*20,z+dz*20)&&slopeAt(toCell(x+dx*20),toCell(z+dz*20))<0.15)flat++;
      if(flat===5&&h-r*0.03>best){best=h-r*0.03;up={x,z};}}
  }
  if(!up){ // one town about its plaza or largo
    const plaza=square(C,B/2+hw+1,g0);lattice(C,g0,count,open,{});
    const church=aroundPlace('temple',2,1.15,isCap?1.15:1,'temple',{},plaza||undefined);
    return{plaza,church,line:M.flat||M.line};}
  const h0=hAt(C.x,C.z),g=Math.atan2(up.z-C.z,up.x-C.x)+Math.PI/2,along=sea==null?g:sea+Math.PI/2; // the upper grid along the brow; the rua direita along the shore
  const largo=square(up,B/2+hw+1,g);lattice(up,g,count*0.55,(x,z)=>open(x,z)&&hAt(x,z)>h0+M.rise*0.5,{neu:true});
  const church=aroundPlace('temple',2,1.15,isCap?1.15:1,'temple',{},largo||undefined);
  square(C,B*0.3,along);
  const ax=Math.cos(along),az=Math.sin(along),R=Rmax*0.6;
  for(const r of lineRuns(C.x-ax*R,C.z-az*R,C.x+ax*R,C.z+az*R,open))addStreet(r,hw*1.25,'grid',{straight:true,planted:true});
  const ground=(x,z)=>{const i=cIdx(toCell(x),toCell(z));return !W.water[i]&&W.h[i]>1&&!riverAt(x,z,1);};
  for(const t of[0,0.35,-0.35]){const A={x:C.x+ax*R*t,z:C.z+az*R*t},P=plantedClimb(A,up,ground);if(P.length>=3)addStreet(P,hw*0.8,'alley',{straight:true,planted:true,ladeira:true});} // a way up, not a frontage
  return{plaza:largo,church,line:M.line,reach:dist2d(C.x,C.z,up.x,up.z)+B*1.5}; // the town reaches up to its upper town
}
`;

// A passage and what it becomes, the passage itself kept where the new words only go before or after it.
const before = (why, find, words) => ({ why, find, replace: words + find });
const after = (why, find, words) => ({ why, find, replace: find + words });
const instead = (why, find, replace, count = 1) => ({ why, find, replace, count });

const ORIGIN = 'function settlementOrigin(s,idx,era,newFoundation=false){';

export const BOARD_COLONIAL = Object.freeze([
  instead('The manners, as data, and the functions a planted town is laid out by; and a colony\'s places are founded in its years, as recorded.',
    ORIGIN, PLANTED.trimStart() + ORIGIN + '\n  {const PM=plantedManner(s);if(PM||plantedColony(s))return plantedOrigin(s,PM,idx,era,newFoundation);}'),
  instead('A colony\'s country holds only so many of the towns and villages an Old World country of its size does,',
    "const nTowns=Math.round((2+randi('gen',2))*MAPK*MAPK*0.8), nVill=Math.round((3+randi('gen',3))*MAPK*MAPK*0.8);",
    "const nTowns=Math.round((2+randi('gen',2))*MAPK*MAPK*0.8*plantedSettled()), nVill=Math.round((3+randi('gen',3))*MAPK*MAPK*0.8*plantedSettled());"),
  instead('and its towns are so much smaller,', "pop:Math.round((420+randi('gen',760))*PS),minD:850}", "pop:Math.round((420+randi('gen',760))*PS*plantedSettled()),minD:850}"),
  instead('and its villages.', "pop:Math.max(40,Math.round((70+randi('gen',220))*(PS*1.3))),minD:520}", "pop:Math.max(40,Math.round((70+randi('gen',220))*(PS*1.3)*plantedSettled())),minD:520}"),
  before('A planted town is laid out in one stroke by its manner: its plaza, its streets, its church.',
    "  if(mode==='planned'){ // a dated planted market",
    "  if(MANNERS[mode]){const T=plantTown(MANNERS[mode],{C,rAng,Rmax,count,isCap,addStreet,addPlace,placeOK,buildable,inPlace,lineRuns,aroundPlace});if(T.plaza)plazaC=T.plaza;if(T.church)church=T.church;if(T.reach>Rmax)Rmax=T.reach;foundLine=T.line;}\n"),
  instead('A colony\'s place has grown through only the ages its years allow,', 'const E=saved?saved.E:early?(isVil?2:3):isCap?6:isTown?5:3;',
    'const E=saved?saved.E:early?(isVil?2:3):plantedEpochs(origin,era,isCap?6:isTown?5:3);'),
  instead('the last of an Old World place\'s shares of its growth.',
    'const FRAC=saved?saved.FRAC:early?(E===2?[0.5,1]:[0.3,0.65,1]):isCap?[0.06,0.16,0.32,0.52,0.76,1]:isTown?[0.1,0.26,0.5,0.76,1]:[0.4,0.75,1];',
    'const FRAC=saved?saved.FRAC:(early?(E===2?[0.5,1]:[0.3,0.65,1]):isCap?[0.06,0.16,0.32,0.52,0.76,1]:isTown?[0.1,0.26,0.5,0.76,1]:[0.4,0.75,1]).slice(-E);'),
  instead('No castle on the hill above it: its fortress is its own works.',
    "if(!isVil&&!motteAge&&(role==='seat'||role==='fort')&&rr()<0.65){",
    "if(!MANNERS[mode]&&!isVil&&!motteAge&&(role==='seat'||role==='fort')&&rr()<0.65){"),
  instead('Its quay is its landing, not its beginning.', "foundLine=role==='port'?'Began as a landing",
    "if(!MANNERS[mode])foundLine=role==='port'?'Began as a landing"),
  instead('No burgage rows where its houses stand broadside to the street (its layout, as the place keeps it: a lot is built by the mode of its work).', 'const burg=!isVil&&!focus&&AD()>=1100&&',
    'const burg=!isVil&&!focus&&MANNERS[s.mode]?.burgher!==false&&AD()>=1100&&'),
  instead('Nor a new town planted beside it: it was planted whole.', 'if(!isVil&&!neuDone&&era>=1150&&e===Math.max(2,E-3)&&',
    'if(!MANNERS[mode]&&!isVil&&!neuDone&&era>=1150&&e===Math.max(2,E-3)&&'),
  instead('Nor a green paved as its market: its plaza was laid as one.', "if(e===1&&!isVil&&role==='market')hist(",
    "if(e===1&&!isVil&&role==='market'&&!MANNERS[mode])hist("),
  instead('Its lots are taken nearest its plaza or largo first, not its landing: a hill town fills its upper town before the shore.',
    'const keyOf=c=>(focus?dist2d(c.mx,c.mz,focus.x,focus.z):c.d)',
    'const keyOf=c=>(focus?dist2d(c.mx,c.mz,focus.x,focus.z):MANNERS[s.mode]?dist2d(c.mx,c.mz,plazaC.x,plazaC.z):c.d)'),
]);
