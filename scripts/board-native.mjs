// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The peoples of the Americas in Castle and Commons' own terms, written to go back into that game: tongues of another
// world, each with its own names, places, titles and ways (how its people lay out a place, house their families, farm,
// rule and keep their dead), and the passages of the program where the Old World's custom was assumed, each made to
// ask the place's people first. Nothing here knows this game: no port, no coast, no global of its own. What fits the
// model to this game's ground stays in scripts/board-tuning.mjs and the game's modules.
//
// Each entry is a passage of the source as it stands and what it becomes, applied after the fitting
// (scripts/board-tuning.mjs) and the other extensions (scripts/board-upstream.mjs) and checked the same way; no passage
// here is one those tables wrote, so each table can be copied back on its own. Wherever no people of the Americas is in
// play the program does exactly as before, draw for draw: these tongues are drawn:false, never drawn by lot for a
// made-up realm (CULT_DRAWN), their kinds are appended to the table of kinds, and every rule below asks `ways` first,
// which only these peoples have.
//
// Sources of the names, towns and titles: Cartier 1535-36 and the DCB for the St Lawrence Iroquoians and Wendat;
// Winslow 1624, Bragdon 1996 and Mayhew 1727 for the Massachusett and Wampanoag; Lindeström, Nelson 1904, Goddard 1978
// and Soderlund 2022 for the Lenape; Smith 1612, Strachey c.1612 and Rountree 1989 for the Powhatan; Las Casas, Oviedo,
// Pané c.1498 and the repartimiento of 1514 for the Taíno; Staden 1557, Léry and Fernandes 1949 for the Tupinambá.
// Peoples whose record names too few of their women or men to people a place are left out rather than made up: the
// Cusabo, Kalinago, Cueva and Caquetío (no woman's name), the Timucua (one) and the Wabanaki (two).
//
// What Castle and Commons needs beyond its program to show them: roof kinds 3 (a barrel vault of bark or mats over bent
// poles) and 4 (a cone of thatch) are drawn as its gable and spire meshes until it has their own; a real map (REALMAPS)
// whose regions speak these tongues, since no made-up realm is drawn in them; and its page's language and culture
// pickers, if it offers them, list these tongues only for a realm of their world.

// The words that go into the program before its map of tongues is made, every table they extend being known by then:
// everything these peoples are, as data, and the few functions their ways are read through. In the program's own
// style, so it reads as its own.
const AMERICAS = String.raw`
/* ---- THE PEOPLES OF THE AMERICAS (c. 1550): tongues of another world, with ways of their own ----
   A culture's 'world' (the Old World's when unsaid) is the world it is spoken in: a realm of that world hires its
   sell-swords among its own world's tongues. A culture with 'ways' lays out, houses, farms, rules and keeps its year
   by them wherever the program would otherwise assume the Old World's custom:
     layout   'rows' (long houses side by side), 'ring' (round houses about the open place), 'square' (long houses on the
              four sides of it) or 'dispersed' (houses spread along paths among the fields)
     plaza    the open place its houses face: {kind, r} in metres for a chief's seat (less for a town, a village)
     homes    the kinds of house its families live in; lots: what is built on a lot, by weight; found: [kind, [kinds of
              place]] built about the open place when a place is founded
     per      people to a house, on the mean; gap: metres between houses; path: a lane's half-width; yards: each house
              stands back in a yard of its own, as a farmstead does (else in close order on its lane); clans: the clans
              a household is known by, where the record names them (else it is known by its town, as its people were)
     knows    the technologies it holds at the founding (TECH_RULES); scale: how many of its people to a place, of the
              Old World's; hair: weights of dark, brown, fair and red
     womenTill  women work the fields in spring and summer; beasts, fences, mills, castle, church, strips: false where
              its people keep no herds, hedge no fields, raise no mill, castle or church, and plough no strips;
              farPorts: false where no far port's ships call at its harbours (its trade goes by its own boats);
              emblems: the charges (CHARGES) its great houses bear
     titles   {monarch:[his, hers], head:[his, hers]} the words for a paramount and for the head of a great house
     court    the words for the court's priest and for its other councillors; trades: the work of its people, by weight
              ('planter' tends the fields, as the Old World's ploughman does)
   The names are as recorded (see the sources in the vendoring's board-native.mjs); a place's name is one of its
   people's towns, a realm's its land's own name where one is recorded, and a daughter village takes its founder's
   name, as a chief and his town went by one name. */
const AMERICAS_PEOPLES={
  iroquoian:{name:'St Lawrence Iroquoian',adj:'Iroquoian',world:'americas',
    m:['Donnacona','Domagaya','Taignoagny','Agona','Atironta','Anenkhiondic','Aenons','Endahiaconc','Ochasteguin','Chihwatenha','Teondechoren','Ahatsistari','Taratouan','Totiri','Soranhes','Amantacha','Ondakion'],
    f:['Aonetta','Oionhaton','Gannendâris','Skanudharoua','Asenregéhaon'],
    roots:['Stadacona','Hochelaga','Achelacy','Ajoaste','Starnatan','Tailla','Sitadin','Tequenonday','Thoagahen','Deganonda','Thegnignonde','Thegadechoalle','Tella','Stagoattem','Agouchonda','Tutonaguy','Honguedo'],
    site:{farm:['*'],realm:['Canada']},
    ways:{layout:'rows',plaza:{kind:'plaza',r:24},homes:['barkLonghouse'],lots:[['barkLonghouse',1]],found:[],per:48,gap:4,path:1.4,clans:['Turtle','Wolf','Bear','Deer','Beaver','Hawk','Porcupine','Snake'],
      knows:['timberPalisade'],scale:0.6,titles:{monarch:['Agouhanna','Agouhanna'],head:['Agouhanna','Clan mother']},court:{priest:'Arendiwane',council:'Councillor'},
      trades:['planter','planter','planter','planter','hunter','hunter','fisher','fisher','potter','weaver','bowyer','fletcher','woodcutter','carpenter'],
      foundLine:'Bark longhouses, each of several families, laid in rows about an open square; the women’s fields of maize, beans and squash all about.'}},
  massachusett:{name:'Massachusett',adj:'Massachusett',world:'americas',
    m:['Ousamequin','Wamsutta','Metacom','Quadequina','Tisquantum','Hobbamock','Corbitant','Iyanough','Aspinet','Epenow','Chickatawbut','Obtakiest','Obbatinewat','Nanepashemet','Wonohaquaham','Montowampate','Winnepurkit','Cutshamekin','Wampatuck','Hiacoomes'],
    f:['Weetamoo','Namumpum','Wootonekanuske','Awashonks','Wuttununohkomkooh','Assannooshque'],
    roots:['Patuxet','Pokanoket','Sowams','Montaup','Nemasket','Mattapoisett','Pocasset','Sakonnet','Nauset','Cummaquid','Manomet','Monomoy','Mashpee','Noepe','Aquinnah','Shawmut','Neponset','Wessagusset','Mishawum','Naumkeag'],
    site:{farm:['*'],realm:['*']},
    ways:{layout:'dispersed',plaza:{kind:'dance',r:12},homes:['wetu','chiefHouse'],lots:[['wetu',10],['sweatLodge',0.3]],found:[['chiefHouse',['capital','town']]],per:7,gap:10,path:1.2,yards:true,
      knows:['timberPalisade'],scale:0.3,titles:{monarch:['Sachem','Saunkskwa'],head:['Sachem','Saunkskwa']},court:{priest:'Powwaw',council:'Pniese'},
      trades:['planter','planter','planter','planter','hunter','hunter','fisher','fisher','boatman','potter','weaver','bowyer','fletcher','woodcutter'],
      foundLine:'Wetus of bark and mats scattered among the cornfields about a dancing ground, the sachem’s long house among them.'}},
  lenape:{name:'Lenape',adj:'Lenape',world:'americas',
    m:['Mattahorn','Singnos','Pemenetta','Pinna','Tamanend','Ockanickon','Swanpisse','Idquayhon','Janottowe','Merkekowen','Nannacussey','Tomackhickon','Kekerappamand','Oratam','Penhawitz','Tackapousha','Pacham','Sesseys','Seweckenamo','Pemmyrawech'],
    f:['Mamanuchqua','Machequa','Sawshoota','Ojroqua','Necosshehesco','Menumheck','Matollionequay'],
    roots:['Shackamaxon','Passyunk','Poaetquessingh','Pemickpacka','Wickquaquenscke','Wickquakonick','Nittabakonck','Manahatta','Sapohanikan','Marechkawick','Nechtanc','Canarsee','Rechqua Akie','Hackensack','Tappan','Navesink','Raritan','Minisink','Esopus','Tankiteke'],
    site:{farm:['*'],realm:['*']},
    ways:{layout:'dispersed',plaza:{kind:'dance',r:10},homes:['arbourHouse','wetu','chiefHouse'],lots:[['arbourHouse',3],['wetu',2],['sweatLodge',0.3]],found:[['chiefHouse',['capital']]],per:10,gap:9,path:1.2,yards:true,clans:['Turtle','Turkey','Wolf'],
      knows:['timberPalisade'],scale:0.3,titles:{monarch:['Sakima','Sakima'],head:['Sakima','Sakima']},court:{priest:'Healer',council:'Councillor'},
      trades:['planter','planter','planter','planter','hunter','hunter','fisher','fisher','boatman','potter','weaver','bowyer','fletcher','woodcutter'],
      foundLine:'The bark houses of a clan’s families, scattered along the water among their fields of maize.'}},
  powhatan:{name:'Powhatan',adj:'Powhatan',world:'americas',
    m:['Wahunsenacawh','Opechancanough','Opitchapam','Kekataugh','Wowinchopunck','Paquiquineo','Parahunt','Pochins','Coquonasum','Nemattanew','Uttamatomakkin','Namontack','Machumps','Kocoum','Nantaquaus','Japazaws','Chanco','Necotowance','Totopotomoi','Kemps'],
    f:['Matoaka','Amonute','Winganuske','Ashetoiske','Amopotoiske','Ottopomtacke','Attossomiske','Ponnoiske','Appomosiscut','Appimmoiske','Ortoughnoiske','Oweroughwough','Ottermiske','Memeoughquiske','Opussoquionuske','Oholasc','Cockacoeske'],
    roots:['Paspahegh','Werowocomoco','Powhatan','Arrohateck','Appamattuck','Weanock','Kecoughtan','Chiskiack','Quiyoughcohannock','Warraskoyack','Nansemond','Chesepiooc','Pamunkey','Menapacunt','Youghtanund','Mattaponi','Chickahominy','Orapax','Uttamussak','Piankatank'],
    site:{farm:['*'],realm:['Tsenacomoco']},
    ways:{layout:'dispersed',plaza:{kind:'dance',r:12},homes:['arbourHouse','chiefHouse'],lots:[['arbourHouse',10],['sweatLodge',0.3]],found:[['chiefHouse',['capital','town']],['charnelHouse',['capital','town']]],per:10,gap:12,path:1.2,yards:true,
      knows:['timberPalisade'],scale:0.3,titles:{monarch:['Mamanatowick','Mamanatowick'],head:['Weroance','Weroansqua']},court:{priest:'Quiyoughcosuck',council:'Cockarouse'},
      trades:['planter','planter','planter','planter','hunter','hunter','fisher','fisher','boatman','potter','weaver','bowyer','fletcher','woodcutter'],
      foundLine:'Arbour houses of bent saplings and bark mats, scattered among the cornfields and the trees; the weroance’s long house and the quioccasan, where the chiefs’ dead are kept, stand apart.'}},
  taino:{name:'Taíno',adj:'Taíno',world:'americas',
    m:['Guacanagarí','Caonabo','Manicaotex','Guarionex','Behechío','Mayobanex','Cayacoa','Cotubanamá','Guarocuya','Guatiguaná','Agüeybaná','Guaybana','Urayoán','Mabodamaca','Aymamón','Caguax','Hatuey','Guamá','Habaguanex','Ameyro'],
    f:['Anacaona','Higüemota','Higuanamá','Yuisa','Casiguaya','Iguanamá','Catabano'],
    roots:['Xaraguá','Yaguana','Maguana','Maguá','Marién','Higüey','Cibao','Bainoa','Bahoruco','Guaynía','Otoao','Yagüeca','Baracoa','Bayamo','Camagüey','Cueybá'],
    site:{farm:['*'],realm:['Haití','Quisqueya','Borikén','Xaymaca']},
    ways:{layout:'ring',plaza:{kind:'batey',r:26},homes:['bohio','caney'],lots:[['bohio',1]],found:[['caney',['capital','town','village']]],per:25,gap:4,path:1.4,
      knows:[],scale:0.8,titles:{monarch:['Cacique','Cacica'],head:['Nitaíno','Nitaína']},court:{priest:'Behique',council:'Nitaíno'},
      trades:['planter','planter','planter','planter','fisher','fisher','fisher','boatman','hunter','potter','weaver','carpenter','woodcutter'],
      foundLine:'Round bohíos about the batey, the ball court and dancing ground, the cacique’s caney facing it.'}},
  tupi:{name:'Tupinambá',adj:'Tupi',world:'americas',
    m:['Cunhambebe','Aimberê','Pindobuçu','Koakira','Araraí','Guaixará','Cairuçu','Nhaêpepô-oaçu','Alkindar-miri','Ipiru-guaçu','Taparicá','Tibiriçá','Arariboia'],
    f:['Guaibimpará','Bartira','Terebê'],
    roots:['Uwattibi','Ariró','Iperoig','Uruçumirim','Kariók','Eiraîá','Akara’y','Sapopema','Ocarentin','Kouroumouré','Ûyraûasuunaé','Ke-ri-u','Sarapo-u','Ita-auc','Arasa-tuue','Usu-potuue'],
    site:{farm:['*'],realm:['*']},
    ways:{layout:'square',plaza:{kind:'ocara',r:30},homes:['maloca'],lots:[['maloca',1]],found:[],per:80,gap:8,path:1.4,
      knows:['timberPalisade'],scale:0.5,titles:{monarch:['Morubixaba','Morubixaba'],head:['Morubixaba','Morubixaba']},court:{priest:'Pajé',council:'Elder'},
      trades:['planter','planter','planter','planter','hunter','hunter','fisher','fisher','boatman','potter','weaver','bowyer','fletcher','woodcutter'],
      foundLine:'Long malocas, each of many families, on the four sides of the ocara, the square of councils and feasts.'}},
};
for(const[k,c]of Object.entries(AMERICAS_PEOPLES)){ // what every tongue has: those the record does not give are their people's own customs
  // drawn:false: spoken where a real map's region speaks it, never drawn by lot for a made-up realm (CULT_DRAWN)
  Object.assign(c,{drawn:false,neu:['*'],house:p=>p,castle:p=>p,saints:[],church:(S,p)=>p,inns:[],trade:{}});
  Object.assign(c.ways,{hair:[1,0,0,0],womenTill:true,beasts:false,fences:false,mills:false,castle:false,church:false,strips:false,farPorts:false,
    emblems:['stag','wave','oak','wolf','comet','sun','crescent','fish','raven','flame']}); // no tower, key, crown, sword, rose or anchor
  CULT[k]=c;KIN[k]={pre:/^(?!)/,suf:null,man:g=>g};
  // no surnames: a household is known by its clan where the record names the clans, else by its town; a man by his kin
  NAMEX[k]={m:[],f:[],roots:[],occ:{},loc:{},nick:{},patr:g=>'kin of '+g,origin:t=>'of '+t};}
Object.assign(CULT_NEAR,{iroquoian:['iroquoian','massachusett','lenape'],massachusett:['massachusett','lenape','iroquoian'],lenape:['lenape','massachusett','powhatan'],
  powhatan:['powhatan','lenape'],taino:['taino','tupi'],tupi:['tupi','taino']});
const AMERICAS_PAL={iroquoian:0x8d5524,massachusett:0x4a7c59,lenape:0x6b8e23,powhatan:0xb5651d,taino:0x1f8a8a,tupi:0xc0a000}; // their colours on the map of tongues
// Their houses and works: [w, d, h, roof, name, hearths]: hearths, where given, are the households a house holds.
// Roof 3 is a barrel vault of bark or mats over bent poles, 4 a cone of thatch.
Object.assign(ARCH,{
  barkLonghouse:[30,7,7.5,3,'bark longhouse',8], wetu:[5.5,5,3.4,3,'wetu',1], arbourHouse:[14,6,5.6,3,'arbour house',2],
  bohio:[8,8,7.5,4,'bohío',5], caney:[13,8,8,0,'caney',3], maloca:[46,5,4.6,3,'maloca',16],
  chiefHouse:[12,7,6.2,3,'long house',2], charnelHouse:[12,5,5.6,3,'charnel house',0], sweatLodge:[2.5,2.5,1.9,3,'sweat lodge',0],
});
TILLERS.add('planter'); // the women who hill and tend the maize, beans and squash, or the manioc
Object.assign(INST_NAMES,{
  chiefHouse:{massachusett:p=>'the sachem’s house at '+p,lenape:p=>'the sakima’s house at '+p,powhatan:p=>'the weroance’s house at '+p,anglo:'the chief’s house'},
  charnelHouse:{powhatan:p=>'the quioccasan of '+p,anglo:'the charnel house'},
  caney:{taino:p=>'the caney of '+p,anglo:'the caney'},
});
function waysOf(s){return s&&CULT[s.cult]?.ways||null;} // how a place's people build, farm, rule and keep their year; null for the Old World's custom
function realmCult(){return (W&&W.crownCult)||(typeof REALMAP!=='undefined'&&REALMAP?REALMAP.crown:null);}
function realmWays(){return CULT[realmCult()]?.ways||null;}
function realmWorld(){return CULT[realmCult()]?.world||'old';}
function cultsOfWorld(w=realmWorld()){return Object.keys(CULT).filter(k=>(CULT[k].world||'old')===w);} // the tongues of a world, in the table's order
function realmKnows(){const N=realmWays();return N?new Set(N.knows):null;}
function realmScale(){return realmWays()?.scale||1;}
function courtWord(role){const T=realmWays()?.court;return !T?role:role==='High Priest'||role==='Prophet'?T.priest:role==='Master of Coin'||role==='Master Smith'?T.council:role;} // a councillor of the court, in the realm's words
function monarchWord(n){const T=realmWays()?.titles;return T?T.monarch[n.sex==='f'?1:0]:n.sex==='f'?'Queen':'King';}
function nativeTitle(T,n){const f=n.sex==='f'?1:0,ep=n.epithet?' '+n.epithet:'';
  if(n.role==='monarch')return T.monarch[f]+' '+n.name+ep;if(n.role==='head')return T.head[f]+' '+n.name+' of '+houseOf(n).name.replace('House ','');return n.name+ep;}
function chargeFor(c,ch){const E=CULT[c]?.ways?.emblems;return !E||E.includes(ch)?ch:E[CHARGES.indexOf(ch)%E.length];} // a house's emblem, of its people's world
function chiefSeat(s){ // where a people's chief lives: his own house about the open place, or, where he lives as his people do, the house nearest it
  const N=waysOf(s);if(!N||!s.buildings)return null;let best=null,bd=Infinity;
  for(const b of s.buildings){if(b.removed||b.state!=='sound')continue;if(b.chief)return b;if(!N.homes.includes(b.arch))continue;const d=dist2d(b.x,b.z,s.pos.x,s.pos.z);if(d<bd){bd=d;best=b;}}
  return best;}
function nativeKin(c,s){const K=CULT[c].ways.clans;return K?'of the '+K[Math.floor(frand()*K.length)]:NX(c).origin(s.name);} // a new household's name
/* The map of tongues has eleven colours (uHouse): a realm's tongues take them in the table's order, only those it speaks,
   so however many tongues the program knows, a realm of eleven or fewer is coloured whole. */
let TONGUE_SLOTS=null,TONGUE_SLOTS_W=null;
function tongueSlots(){if(TONGUE_SLOTS_W!==W||!TONGUE_SLOTS){const spoken=new Set((W.settlements||[]).map(s=>s.cult));TONGUE_SLOTS=TONGUE_IDS.filter(k=>spoken.has(k)).slice(0,11);TONGUE_SLOTS_W=W;}return TONGUE_SLOTS;}
function nativeLot(N,rr){let t=0;for(const[,w]of N.lots)t+=w;let x=rr()*t;for(const[k,w]of N.lots){x-=w;if(x<=0)return k;}return N.lots[0][0];}
function nativeLanes(N,k){ // the lanes a people's houses stand along, by its layout; k is the founding's kit (layoutSettlement)
  // Every lane is reached from the open place's middle, where the road comes in: across the open ground, as a path is.
  const{C,P,rAng,Rmax,HW,count,addStreet,buildable,rr}=k,a=ARCH[N.homes[0]],w=a[0],d=a[1];
  const lay=pts=>{let run=[];const end=()=>{if(run.length>=3)addStreet(run,HW,'lane',{straight:true,neu:true});run=[];};for(const q of pts){if(buildable(q.x,q.z))run.push(q);else end();}end();};
  const pr=P.r?Math.max(...P.r):8,ux=Math.cos(rAng),uz=Math.sin(rAng),vx=-uz,vz=ux,step=2*(HW+0.9+d)+N.gap+2;let have=0;
  const at=(t,o)=>({x:C.x+ux*t+vx*o,z:C.z+uz*t+vz*o}),line=(p,q)=>{const n=Math.max(2,Math.ceil(dist2d(p.x,p.z,q.x,q.z)/8)),pts=[];for(let i=0;i<=n;i++)pts.push({x:lerp(p.x,q.x,i/n),z:lerp(p.z,q.z,i/n)});return pts;};
  if(N.layout==='ring'){ // round houses in rings about the open place, their doors to it (the batey); a path out to them opposite the road
    let R=pr+HW+1.5,last=R;for(let q=0;q<4&&have<count*1.15;q++){const n=Math.max(12,Math.round(2*Math.PI*R/6)),pts=[];
      for(let i=0;i<=n;i++){const t=rAng+Math.PI+i/n*Math.PI*2;pts.push({x:C.x+Math.cos(t)*R,z:C.z+Math.sin(t)*R});}
      lay(pts);have+=(q?2:1)*2*Math.PI*R/(w+N.gap);last=R;R+=step;}
    lay(line(C,at(-last,0)));
  }else if(N.layout==='square'){ // long houses on the four sides of the open place (the ocara), a wider square beyond as it grows
    let h=Math.max(pr+HW+1.5,(w+N.gap)/2),last=h;for(let q=0;q<3&&have<count*1.15;q++){
      lay(resample([[-1,0],[-1,1],[1,1],[1,-1],[-1,-1],[-1,0]].map(([t,o])=>at(t*h,o*h)),8));have+=(q?2:1)*4*Math.floor(2*h/(w+N.gap));last=h;h+=step;}
    lay(line(C,at(-last,0)));
  }else if(N.layout==='rows'){ // long houses side by side along parallel lanes running back from the open place, away from the road (Hochelaga)
    const L=Math.max(w*3.2,Math.sqrt(count)*w*0.9),per=2*Math.max(1,Math.floor(L/(w+N.gap))),m=Math.min(11,Math.ceil(count*1.1/per)),t0=pr+HW+2,o0=(m-1)/2*step;
    lay(line(C,at(-t0,0)));if(m>1)lay(line(at(-t0,-o0),at(-t0,o0))); // to the head of the rows, and along it
    for(let i=0;i<m;i++){const o=i*step-o0;lay(line(at(-t0,o),at(-t0-L,o)));}
  }else{ // dispersed: paths out from the open place among the fields, the houses spread along them
    const n=3+Math.floor(rr()*3);for(let i=0;i<n;i++){let h=rAng+(i+0.5)/n*Math.PI*2+(rr()-0.5)*0.6,x=C.x,z=C.z;const pts=[];
      for(let L=0;L<Rmax*0.75+pr;L+=8){pts.push({x,z});h+=(rr()-0.5)*0.35;x+=Math.cos(h)*8;z+=Math.sin(h)*8;}lay(pts);}
  }
}
function nativeFound(N,k){ // the houses of its chief and of its dead about the open place, as the place's standing has them
  const at=k.isCap?'capital':k.isTown?'town':'village';
  for(const[arch,where]of N.found)if(where.includes(at))k.aroundPlace(arch,0,1,1,'residential',{chief:arch==='chiefHouse'||arch==='caney'});}
`;

// A passage and what it becomes, the passage itself kept where the new words only go before or after it.
const before = (why, find, words) => ({ why, find, replace: words + find });
const after = (why, find, words) => ({ why, find, replace: find + words });
const instead = (why, find, replace, count = 1) => ({ why, find, replace, count });

const TONGUES = 'const TONGUE_IDS=Object.keys(CULT),TONGUE_PAL={';

export const BOARD_NATIVE = Object.freeze([
  instead('The peoples of the Americas, as data, and the functions their ways are read through; and their colours.',
    TONGUES, AMERICAS.trimStart() + TONGUES + '...AMERICAS_PAL,'),
  after('Their houses are homes.',
    "const RESID=new Set(['court','cot','house','longhouse','burgher','shop','tavern','smithy','bakery','inn','tannery','dyer','hospital','toll']);",
    '\nfor(const c of Object.values(AMERICAS_PEOPLES))for(const k of c.ways.homes)RESID.add(k);'),
  // ---- tongues ----
  instead('A realm of another world hires its sell-swords among that world\'s tongues.',
    'for(let i=0;i<k;i++){const c=cs[Math.floor(frand()*cs.length)],X=NX(c),G=genome();',
    "const hs=realmWorld()==='old'?cs:cultsOfWorld();for(let i=0;i<k;i++){const c=hs[Math.floor(frand()*hs.length)],X=NX(c),G=genome();"),
  instead('Its households are known by their clans or their towns.', "const n=k==='occ'?surnameFor('occ',c,tr||'ploughman'):",
    "const n=CULT[c]?.ways?nativeKin(c,s):k==='occ'?surnameFor('occ',c,tr||'ploughman'):"),
  instead('The map of tongues gives its eleven colours to the tongues the realm speaks.', 'TONGUE_IDS.indexOf(s.cult)+1', 'tongueSlots().indexOf(s.cult)+1'),
  instead('And its key.', 'TONGUE_IDS.forEach((k,i)=>{if(i<11)', 'tongueSlots().forEach((k,i)=>{if(i<11)'),
  after('Which are counted again when a place changes its tongue.', 'function refreshTongues(){', 'TONGUE_SLOTS=null;'),
  instead('A people\'s hair as its own.', 'function hairDraw(c){const w={', 'function hairDraw(c){const w=CULT[c]?.ways?.hair||{'),
  instead('A realm of a people that lives in smaller places founds them smaller.', 'const PS=directEra?1:0.35;', 'const PS=(directEra?1:0.35)*realmScale();'),
  // ---- titles ----
  instead('A paramount is styled in the realm\'s own words.', "${n.sex==='f'?'Queen':'King'}", '${monarchWord(n)}', 2),
  after('And a head of a great house.', 'function fullTitle(n){', "const NT=realmWays()?.titles;if(NT&&n.role!=='justice')return nativeTitle(NT,n);"),
  instead('Its chief lives in his own house, or in his people\'s, and keeps his household there.',
    "const b=casKeep(s)||s.buildings.find(b=>b.arch==='hall'&&b.inst&&!b.removed&&b.state==='sound');if(!b)return{s,b:null,secure:false,lines:0};",
    "const b=casKeep(s)||s.buildings.find(b=>b.arch==='hall'&&b.inst&&!b.removed&&b.state==='sound')||chiefSeat(s);if(!b)return{s,b:null,secure:false,lines:0};"),
  instead('And it is known to be his.', "function notableResidents(b){if(b.arch!=='keep'&&b.arch!=='hall')return[];",
    "function notableResidents(b){if(b.arch!=='keep'&&b.arch!=='hall'&&b!==chiefSeat(b.s))return[];"),
  // ---- heraldry ----
  after('A great house bears an emblem of its people\'s world.', "h.name='';h.name=uniqueHouseName(C,seat.name.replace(/^(the |Burg |Château |Castello )/,''),r,h);",
    'h.charge=chargeFor(h.cult,h.charge);'),
  instead('And so does one raised again.', "h.charge=pick('sim',CHARGES);", "h.charge=chargeFor(h.cult,pick('sim',CHARGES));"),
  instead('And a cadet branch.', "cult:kc,sigilHue:hue,charge:pick('sim',CHARGES),", "cult:kc,sigilHue:hue,charge:chargeFor(kc,pick('sim',CHARGES)),"),
  // ---- technology ----
  instead('A realm opens knowing only what its people knew; the rest it may yet learn.',
    'for(const key of TECH_KEYS){const r=TECH_RULES[key];',
    'const NK=realmKnows();for(const key of TECH_KEYS){const r=TECH_RULES[key];if(NK&&!NK.has(key)){T.pending.push(key);continue;}'),
  // ---- the founding of a place: layoutSettlement ----
  instead('A place of a people with ways of its own is laid out by them, in its layout, and as a village is: no burgher rows, guilds or suburbs.',
    "let isCap=saved?saved.isCap:s.kind==='capital',isTown=saved?saved.isTown:s.kind==='town',isVil=saved?saved.isVil:s.kind==='village';",
    "const WAYS=waysOf(s);if(WAYS&&!saved&&!s.forceMode)s.forceMode=WAYS.layout;let isCap=saved?saved.isCap:s.kind==='capital',isTown=saved?saved.isTown:s.kind==='town',isVil=saved?saved.isVil:s.kind==='village'||!!WAYS;"),
  after('Its houses are as many as its people need, at its own number to a house.', 'const count=saved?saved.count:', 'WAYS?Math.max(2,Math.round(s.pop/WAYS.per)):'),
  after('Its lanes are paths.', 'const HW=saved?saved.HW:', 'WAYS?WAYS.path:'),
  instead('Its open place, and the lanes its houses stand along.',
    'if(isVil){ // a green beside the road, where the first farms gathered',
    'if(WAYS){ // a people of the Americas: the open place its houses face, and the lanes they stand along (nativeLanes)\n' +
    '    const pr=WAYS.plaza.r*(isCap?1:isTown?0.8:0.6);let P=null;\n' +
    '    for(const sc of[1,0.8,0.6]){const p=blob(C.x,C.z,pr*sc,pr*sc*0.9,rAng,0.15);if(placeOK(p)){addPlace(p,WAYS.plaza.kind);P=p;break;}}\n' +
    '    nativeLanes(WAYS,{C,P:P||{x:C.x,z:C.z},rAng,Rmax,HW,count,addStreet,buildable,rr});\n' +
    '  }else if(isVil){ // a green beside the road, where the first farms gathered'),
  instead('No lord\'s keep.', "if(!keep&&(role==='seat'||role==='fort')){ // a tower keep", "if(!WAYS&&!keep&&(role==='seat'||role==='fort')){ // a tower keep"),
  instead('No quay: boats are drawn up on the shore.',
    "if(role==='port'||role==='fishing'){ // a quay along the shore nearest the nucleus",
    "if(!WAYS&&(role==='port'||role==='fishing')){ // a quay along the shore nearest the nucleus"),
  instead('Nor along a river.',
    'if(s.river||s.canals){ // quays along the bank where a river or a canal runs close to the nucleus',
    'if(!WAYS&&(s.river||s.canals)){ // quays along the bank where a river or a canal runs close to the nucleus'),
  before('Its founding as its people tell it.', 'if(!foundLine)foundLine=isVil?({farm:', 'if(WAYS)foundLine=WAYS.foundLine;'),
  instead('No church, alehouse or hall about its open place: its chief\'s house and its people\'s own.',
    'if(!saved&&!oldVil)foundTown();', 'if(!saved&&!oldVil){if(WAYS)nativeFound(WAYS,{aroundPlace,isCap,isTown});else foundTown();}'),
  instead('Its houses are homes.', "const HOME=saved?saved.HOME:new Set(['house','longhouse','burgher']);",
    "const HOME=saved?saved.HOME:new Set(['house','longhouse','burgher',...(WAYS?WAYS.homes:[])]);"),
  after('Built as its people build.', 'const home=c=>{', 'if(WAYS)return nativeLot(WAYS,rr);'),
  before('No shop, inn, smithy, granary, windmill or toll opens on its lanes.', 'yr<T.from||(T.town&&isVil))continue;', 'WAYS||'),
  after('One kind of building, of bark, mats and thatch.', 'const tierFor=(c,e)=>{', 'if(WAYS)return 0;'),
  after('Its houses stand as far apart as its people set them.', 'const gapFor=c=>', 'WAYS?WAYS.gap:'),
  instead('And in yards of their own only where its people keep them.', 'if(isVil){const k=1.5+rr()*3;', 'if(isVil&&(!WAYS||WAYS.yards)){const k=1.5+rr()*3;'),
  after('A palisade, where it has one, goes round the place as it stands.', 'const wallAges=saved?saved.wallAges:', 'WAYS?(s.walls>0?[E-1]:[]):'),
  instead('And never on the Italian trace.', "const bastioned=saved?saved.bastioned:isCap||role==='border'||role==='fort';",
    "const bastioned=saved?saved.bastioned:!WAYS&&(isCap||role==='border'||role==='fort');"),
  instead('No mill on its river.', 'if(!saved&&s.river)siteMill();', 'if(!saved&&s.river&&(!WAYS||WAYS.mills))siteMill();'),
  after('A house holds its own number of households.', 'function capOf(b){', 'const H=ARCH[b.arch]?.[5];if(H)return H;'),
  // ---- the land and the living ----
  after('Its fields are its women\'s maize, beans and squash: no meadow, vine, Hufe or garden close.', 'function furlongKind(f,s,colonists){',
    'if(waysOf(s))return f.ar<Math.max(1,f.n)*0.25||f.fl>Math.max(1,f.n)*0.35?LK.NONE:LK.FIELD;'),
  instead('Hilled, not ploughed in strips.', 'else{f.th=down;f.w=11+Math.round(f.hash*8);}', 'else{f.th=down;f.w=waysOf(s)?.strips===false?0:11+Math.round(f.hash*8);}'),
  after('One kind of field, whatever the Old World would have made of it.', 'function shapeFurlong(f,s,kind){', 'if(kind&&waysOf(s))kind=LK.FIELD;'),
  before('Its people work at its own trades.', "t.push(...(s.kind==='village'?['ploughman','ploughman','ploughman','ploughman','ploughman','herdsman','shepherd','thatcher','carpenter']",
    'if(waysOf(s))t.push(...waysOf(s).trades);else '),
  instead('And not as carters, miners or foresters by the reason of its site.', "crossing:['carter','boatman']}[s.role];if(role)t.push(",
    "crossing:['carter','boatman']}[s.role];if(role&&!waysOf(s))t.push("),
  after('No hedge or fence round its fields.', 'const fenceWorked=f=>f&&f.dom>=0&&', 'waysOf(W.settlements[f.dom])?.fences!==false&&'),
  before('No herds.', "herdSync(s); // the month's calves, losses, sales and slaughter shared among the owners", 'if(waysOf(s)?.beasts===false)return;'),
  instead('No far port\'s ships call where its people\'s ways have none.', 'for(let si=0;si<W.settlements.length;si++){const s=W.settlements[si];if(!s.harbor||closedToTrade(s))continue;',
    'for(let si=0;si<W.settlements.length;si++){const s=W.settlements[si];if(!s.harbor||closedToTrade(s)||waysOf(s)?.farPorts===false)continue;'),
  after('No castle is founded among them.', 'function castleFoundationAuthority(s,hi=s.owner){', 'if(waysOf(s)?.castle===false)return false;'),
  after('No parish church or friary.', "function institutionParishProposal(s,kind='parish'){", 'if(waysOf(s)?.church===false)return null;'),
  instead('The women work the fields in spring and summer, as among these peoples.', "(p.sx==='f'&&s.kind==='village'&&(season===1||season===2))",
    "(p.sx==='f'&&(s.kind==='village'||waysOf(s)?.womenTill)&&(season===1||season===2))"),
  // ---- the board's drawing ----
  instead('A cone rises as a spire does.', 'return b.d*(b.roof===2?0.65:', 'return b.d*(b.roof===2||b.roof===4?0.65:'),
  instead('A vault is drawn with the gable\'s mesh until it has its own.', 'else if(b.roof===0&&!ruined){', 'else if((b.roof===0||b.roof===3)&&!ruined){'),
  instead('A cone with the spire\'s.', '}else if(b.roof===2&&!ruined){', '}else if((b.roof===2||b.roof===4)&&!ruined){'),
]);
