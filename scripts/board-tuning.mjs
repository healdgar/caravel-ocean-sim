// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons lays out a kingdom: its ground, rivers, towns, roads, fields and people. This game takes that
// generator whole (assets/board/game.js is its program, as written) and tunes it to a coast found from the sea. The tuning
// is this table and nothing else: each entry is a passage of the source as it stands and what it becomes. A passage
// that is not found exactly as many times as stated stops the vendoring, so a change upstream is seen, not lost.
//
// What the host sets, read from FURLONG_OPTIONS.board before the program runs:
//   spanMetres  the side of the ground, in metres (the source offers whole kilometres from 4 to 15)
//   seat        how many times the source's capital the seat of this coast is, in people and houses
//   walls       the walls a place of each kind starts with: {capital, town, village} of 0 none, 1 palisade, 2 stone
//   lived       true to found the realm in its early age (850) and let it live every day to the year asked, as the
//               source's own prehistory does, or a number of years to found with the era's technologies and live that span
//   rivers      water fitted to true ground: {catchment, width, least, carve}. The source counts a river's water in
//               cells, each standing for a square kilometre or so of a kingdom; here a cell is some 27 metres of a
//               surveyed coast, and counted so, every gully ran a river. `catchment` is the ground (square metres)
//               that must drain to a point before a watercourse runs there; `width` the metres across it for each
//               root square kilometre drained; `least` its least half-width; `carve` how much of the source's bed
//               is cut into ground whose valleys are already real.
const BOARD = 'globalThis.FURLONG_OPTIONS?.board';

export const BOARD_TUNING = Object.freeze([
  {
    why: 'The ground is as wide as the coast it stands for, to the metre.',
    find: 'const MAPKM=(()=>{const m=/[#&]km=(\\d+)/.exec(WORLD_PARAMS);return m?Math.max(4,Math.min(15,+m[1])):9;})();',
    replace: `const MAPKM=${BOARD}?.spanMetres>0?${BOARD}.spanMetres/1000:(()=>{const m=/[#&]km=(\\d+)/.exec(WORLD_PARAMS);return m?Math.max(4,Math.min(15,+m[1])):9;})();`,
  },
  {
    why: 'The seat is a port city of the sixteenth century, not the capital of a small kingdom: more people.',
    find: "pop:Math.round((2200+randi('gen',700))*PS),minD:0}",
    replace: `pop:Math.round((2200+randi('gen',700))*PS*(${BOARD}?.seat??1)),minD:0}`,
  },
  {
    why: 'And ground enough to house them: its reach grows with the square root of its people.',
    find: 'let R0=saved?saved.R0:isCap?440:isTown?310:170',
    replace: `let R0=saved?saved.R0:isCap?440*Math.sqrt(${BOARD}?.seat??1):isTown?310:170`,
  },
  {
    why: 'And houses in proportion, where the source stops a capital at 620.',
    find: 'isCap?620:isTown?280:48);',
    replace: `isCap?Math.round(620*(${BOARD}?.seat??1)):isTown?280:48);`,
  },
  {
    why: 'The search for who holds what ground kept its costs in single precision and compared them in double, so two ways of the same cost queued a cell twice, and on even ground that compounds without end. Kept in double.',
    find: 'const N=GRID*GRID,cost=new Float32Array(N).fill(Infinity),dom=new Int16Array(N).fill(-1),heap=[];',
    replace: 'const N=GRID*GRID,cost=new Float64Array(N).fill(Infinity),dom=new Int16Array(N).fill(-1),heap=[];',
  },
  {
    why: 'A place may start walled, so the circuits its past would have raised are laid out with it.',
    find: 'prosperity:50,unrest:8,walls:0,',
    replace: `prosperity:50,unrest:8,walls:(${BOARD}?.walls?.[w.kind]??0),`,
  },
  {
    why: 'A watercourse runs where enough true ground drains to it, not where 140 cells of any size do.',
    find: 'const RIVT=140;',
    replace: `const RIVT=Math.max(140,(${BOARD}?.rivers?.catchment??0)/(CELL*CELL));`,
  },
  {
    why: 'Its bed is cut only as deep as ground that already has its valleys needs.',
    find: 'const dep=Math.min(7,2+W.flow[i]*0.004),cx=i%GRID,cz=(i/GRID)|0;',
    replace: `const dep=Math.min(7,2+W.flow[i]*0.004)*(${BOARD}?.rivers?.carve??1),cx=i%GRID,cz=(i/GRID)|0;`,
  },
  {
    why: 'It is as wide as the ground it drains makes it: metres for each root square kilometre.',
    find: 'w:Math.min(40,0.6*Math.sqrt(W.flow[c])),h:W.h[c],c});',
    replace: `w:Math.min(40,(${BOARD}?.rivers?.width>0?${BOARD}.rivers.width*CELL/1000:0.6)*Math.sqrt(W.flow[c])),h:W.h[c],c});`,
  },
  {
    why: 'And a brook may be narrower than the eight metres the source gives its least river.',
    find: 'const hw0=pts.map((p,k)=>Math.max(4,(p.w||10)/2)*Math.min(1,0.35+k/14)),',
    replace: `const hw0=pts.map((p,k)=>Math.max(${BOARD}?.rivers?.least??4,(p.w||10)/2)*Math.min(1,0.35+k/14)),`,
  },
  {
    why: 'A realm may be founded early and lived forward to the year asked, or founded near the year asked and lived a shorter span with that age\'s technologies.',
    find: 'directEra=START_AD>FOUNDING_AD;',
    replace: `directEra=START_AD>FOUNDING_AD&&${BOARD}?.lived!==true;`,
  },
  {
    why: 'When lived is a span of years rather than the whole age from 850, the clock opens that many years before START_AD so advancePrehistory lives just that span.',
    find: 'W={startAD:directEra?START_AD:FOUNDING_AD,',
    replace: `W={startAD:directEra?Math.max(FOUNDING_AD,START_AD-(typeof ${BOARD}?.lived==='number'&&${BOARD}.lived>0?Math.round(${BOARD}.lived):0)):FOUNDING_AD,`,
  },
  {
    why: 'A short lived span at a later era opens with all technologies of START_AD already known and adopted, rather than holding back the last thirty years.',
    find: 'if((r.year<=850||r.year<=ad-30)&&r.needs.every(k=>T.known[k]))',
    replace: `if((r.year<=850||r.year<=(typeof ${BOARD}?.lived==='number'&&${BOARD}.lived>0?Math.max(ad-30,START_AD):ad-30))&&r.needs.every(k=>T.known[k]))`,
  },
  {
    why: 'Each day every household that might buy a plough, a shoe or a rudder is quoted for it, and each quote counted the heads of every household in the place afresh: nothing in a capital of two thousand, most of the day in a port of twenty. The heads are counted once for a place in a round of quotes, and again after any commission, so every quote is the figure it was.',
    find: 'function technologyEquipmentIncome(s,tr){if(s._job)return tradeIncome(s,tr,{});const counts={};for(const p of craftIndex(s,true).heads)if(p.tr)counts[p.tr]=(counts[p.tr]||0)+1;return tradeIncome(s,tr,counts);}',
    replace: 'var EQUIPMENT_ROUND=null;function technologyEquipmentIncome(s,tr){if(s._job)return tradeIncome(s,tr,{});let counts=EQUIPMENT_ROUND?.get(s);if(!counts){counts={};for(const p of craftIndex(s,true).heads)if(p.tr)counts[p.tr]=(counts[p.tr]||0)+1;EQUIPMENT_ROUND?.set(s,counts);}return tradeIncome(s,tr,counts);}',
  },
  {
    why: 'The round of quotes that count is kept for: one place, one day.',
    find: 'for(const x of [...technologyEquipmentCandidates(s),...technologyArmyEquipmentCandidates(s)]){const Q=technologyEquipmentQuote(s,x.key,x.target,x.payer);if(Q?.profitable)technologyEquipmentCommission(Q);}}}',
    replace: 'EQUIPMENT_ROUND=new Map();try{for(const x of [...technologyEquipmentCandidates(s),...technologyArmyEquipmentCandidates(s)]){const Q=technologyEquipmentQuote(s,x.key,x.target,x.payer);if(Q?.profitable){technologyEquipmentCommission(Q);EQUIPMENT_ROUND.clear();}}}finally{EQUIPMENT_ROUND=null;}}}',
  },
  {
    why: 'A place with a lord\'s estate could not be read: its card asked for a helper only its caller has. It is given its own, as the caller makes it.',
    find: "function estateDetailsHTML(s){let out='';",
    replace: "function estateDetailsHTML(s){const row=(k,v)=>`<div class=\"row${String(v).replace(/<[^>]*>/g,'').length>26?' long':''}\"><span>${k}</span><b>${v}</b></div>`;let out='';",
  },
  {
    why: 'The source plans the day of the 160 people who live nearest the eye. A host may ask for more: a port city seen from the water shows more than a street of them.',
    find: 'for(const p of cand.slice(0,160)){const h=detailHead(p).bh,',
    replace: `for(const p of cand.slice(0,${BOARD}?.abroad??160)){const h=detailHead(p).bh,`,
  },
  {
    why: 'A household that leaves to break new ground took with it a man who was away with a host: he was sent on the road to the new village and stood on its roll while still on the host\'s. When he fell he was laid to rest but stayed on that roll, a dead man without skills, and the month\'s count of the herdsmen failed on him (AD 852 of a lived Lisbon). A man who is away stays with his host; his home is now where his household went.',
    find: "for(const p of mem){const i=s.folk.indexOf(p);if(i>=0)removeAt(s,i);journey(p,si,di,'migrant');",
    replace: "for(const p of mem){const i=s.folk.indexOf(p);if(i<0){if(p.home===si)p.home=di;continue;}removeAt(s,i);journey(p,si,di,'migrant');",
  },
  {
    why: 'And whoever of a host falls is struck off any roll of the living he stands on, by whatever road he came to be on two.',
    find: "a.men.splice(a.men.indexOf(p),1);dropPerson(p,`Fell fighting with ${a.name}`);",
    replace: "a.men.splice(a.men.indexOf(p),1);{const hs=W.settlements[p.si],fi=hs&&hs.folk?hs.folk.indexOf(p):-1;if(fi>=0)removeAt(hs,fi);}dropPerson(p,`Fell fighting with ${a.name}`);",
  },
  {
    why: 'A daughter village founded in tickLand (such as Torre de Pedro on day 9045) enters tickEconomy the same day before its household pantries are opened; opening ownership after made() swept that day\'s fresh harvest into held pantries and left shareOutput unbacked.',
    find: 'storageInit(s);const phaseK=commodityActive(s)?s.storage:undefined;',
    replace: 'storageInit(s);initOwnership(s);const phaseK=commodityActive(s)?s.storage:undefined;',
  },
  {
    why: 'And opening a settlement\'s pantry never claims grain or fish already booked in _made as pending daily output.',
    find: "for(const g of ['grain','fish'])giveFood(s,g,old?old[g]||0:Math.min(s.stores[g]||0,s.pop*NEED[g]*30));",
    replace: "for(const g of ['grain','fish'])giveFood(s,g,old?old[g]||0:Math.min(Math.max(0,(s.stores[g]||0)-(s._made?.[g]||0)),s.pop*NEED[g]*30));",
  },
  {
    why: 'Lordly estates looked for river dam sites in W.rivers, which does not exist; the river reaches live in W.rivStrips as abbeyPondPlan reads them.',
    find: 'for(const r of W.rivers||[])',
    replace: 'for(const r of (W.rivStrips||[]).filter(q=>!q.canal))',
  },
  {
    why: 'An extinct household estate (A.household with A.head === null) still reaches creditKeep and royalBudget before creditLive screens it out; an estate with no living head has zero monthly subsistence keep.',
    find: 'function courtKeep(s,p){const A=householdAccount(p),h=A?.head||p,home=W.settlements[h.si]||s;let n=0;for(const q of A?.members||[p])if(!q.dead)n++;return Math.max(1,n)*foodYr()/12+rentDue(home,h)/12;}',
    replace: 'function courtKeep(s,p){const A=householdAccount(p),h=A?.head||p;if(!h||h.gn===undefined)return 0;const home=W.settlements[h.si]||s;let n=0;for(const q of A?.members||[h])if(q&&!q.dead)n++;return Math.max(1,n)*foodYr()/12+rentDue(home,h)/12;}',
  },
  // The tongues of the coasts this game sails. The source speaks Castilian for all Iberia; Lisbon, Setúbal and Porto
  // speak Portuguese, and the Low Countries Dutch. Each is a tongue as the source keeps one: its names of people and
  // places, its signs, its institutions and its houses, entered wherever the source lists its tongues.
  {
    why: 'The tongues themselves: their people\'s names, the patterns of their places, their houses, saints, inns and trades.',
    find: "warehouse:['Almacén {N} e Hijos','La Alhóndiga']}}\n};",
    replace: String.raw`warehouse:['Almacén {N} e Hijos','La Alhóndiga']}},
  portuguese:{name:'Portuguese',adj:'Portuguese',
    m:['Afonso','Sancho','Dinis','Pedro','Fernão','João','Duarte','Henrique','Nuno','Gonçalo','Egas','Vasco','Álvaro','Martim','Lourenço','Rodrigo','Estêvão','Soeiro'],
    f:['Urraca','Mafalda','Teresa','Beatriz','Isabel','Leonor','Constança','Inês','Filipa','Brites','Guiomar','Branca','Sancha','Violante','Mécia'],
    roots:['Rosa','Alva','Branca','Ouro','Sol','Lua','Real','Touro','Águia','Lobo','Azinha','Olmo','Penha','Ruiva','Verde','Cruz','Moura','Ferro','Pinho','Sobro'],
    site:{ford:['Vau de *','Vau*'],bridge:['Ponte *','Ponte de *'],hill:['Monte*','Outeiro *'],castle:['Castelo de *','Torre de *','Alcáçova de *'],harbor:['Porto *'],mouth:['Foz de *'],
      wood:['Mata *','Souto *'],clearing:['Rossio *'],field:['Campo*','Chã de *'],farm:['Vila*','Quinta de *','Casal de *'],marsh:['Paul de *'],mine:['Minas de *'],fish:['Praia de *','Póvoa de *'],dam:['Açude de *'],
      valley:['Val*','Vale de *'],river:['Rio *'],realm:['*ia','*al']},
    neu:['Vila Nova de *','*nova','* de Cima'],
    house:(p,r)=>r()<0.5?'House de '+p:'House '+r1(r,['de Meneses','da Cunha','de Sousa','de Castro','Pereira','Coutinho','de Melo','de Almeida','da Silva','de Noronha']),
    castle:(p,r)=>r1(r,['Castelo de ','Paço de '])+p,
    saints:['Pedro','Paulo','Miguel','Estêvão','Nicolau','João','Jorge','Martinho','Lourenço','Tiago','Vicente','Bartolomeu','Antão'],
    church:(S,p,cath)=>{const T=(/^[AEIOUÁÉÍÓÚ]/.test(S)?'Santo ':'São ')+S;return cath?(S.length%2?'Sé de Santa Maria':'Sé de '+T):'Igreja de '+T;},
    inns:['Estalagem do Galo','Taberna do Sol','Venda da Lua','Estalagem da Cruz','Albergaria do Leão','Venda do Touro','Taberna dos Almocreves','Estalagem da Estrela'],
    trade:{shop:['Loja de {N}','A Balança de Ouro'],bakery:['Forno de {N}','O Pão de Ouro'],smithy:['Ferraria de {N}','A Bigorna'],tannery:['Pelames de {N}'],warehouse:['Armazém de {N} e Filhos','O Celeiro']}},
  dutch:{name:'Dutch',adj:'Netherlandish',
    m:['Willem','Floris','Dirk','Jan','Pieter','Gerrit','Arnoud','Hendrik','Jacob','Claes','Adriaen','Cornelis','Gijsbrecht','Reinoud','Wouter','Frans','Joost','Lodewijk'],
    f:['Aleid','Ada','Machteld','Geertruid','Margriet','Beatrijs','Katharina','Jacoba','Maria','Aleydis','Hadewych','Neeltje','Grietje','Agniet','Sophia'],
    roots:['Eik','Linde','Wilg','Berk','Els','Hazel','Ram','Haas','Vos','Zand','Riet','Mol','Ooster','Wester','Noord','Zuid','Lange','Hoog','Diep','Swart'],
    site:{ford:['*drecht','*voorde'],bridge:['*brugge','*brug'],hill:['*berg','*heuvel'],castle:['*burg','Slot *','Huis te *'],harbor:['*haven'],mouth:['*muiden','*mude'],
      wood:['*wold','*hout','*bos'],clearing:['*rode','*lo'],field:['*veld','*akker'],farm:['*hoeve','*heim','*wijk'],marsh:['*veen','*broek'],mine:['*steen','*groeve'],fish:['*wijk','*zijl'],dam:['*dam'],
      valley:['*dal'],river:['*a','*beek'],realm:['*land','*mark']},
    neu:['Nieuw-*','Nieuw*','* Buiten'],
    house:(p,r)=>r()<0.5?'House van '+p:'House '+r1(r,['van Egmond','van Brederode','van Wassenaer','van Arkel','van Borselen','van Heemskerk','van der Does','van Duivenvoorde','van Polanen']),
    castle:(p,r)=>r1(r,['Slot ','Huis te ','Kasteel '])+p,
    saints:['Pieter','Jan','Nicolaas','Maarten','Joris','Laurens','Bavo','Servaas','Willibrord','Jacob','Stephanus','Lebuinus'],
    church:(S,p,cath)=>{const T='Sint-'+S+(/[aeiosu]$/.test(S)?'':'s');return cath?(S.length%2?'Onze-Lieve-Vrouwekerk':T+'kathedraal'):T+'kerk';},
    inns:['Het Wapen van Holland','De Gouden Leeuw','Het Witte Paard','De Drie Haringen','Het Hert','De Zwaan','De Roskam','Het Schip'],
    trade:{shop:['Winkel van {N}','De Gulden Schaal'],bakery:['Bakkerij van {N}','De Gouden Krakeling'],smithy:['Smidse van {N}','Het Aambeeld'],tannery:['Looierij van {N}'],warehouse:['Pakhuis {N} en Zonen','De Waag']}}
};`,
  },
  {
    why: 'Which tongues a realm\'s great houses may speak beside the crown\'s: Portuguese beside Castilian, Dutch beside German and French.',
    find: "const CULT_NEAR={anglo:['anglo','celtic','norse','french'],german:['german','slavic','french','norse','italian'],french:['french','italian','iberian','german','celtic'],\n  italian:['italian','french','german','iberian'],norse:['norse','german','anglo','slavic'],slavic:['slavic','german','norse'],celtic:['celtic','anglo','norse','french'],iberian:['iberian','french','italian']};",
    replace: "const CULT_NEAR={anglo:['anglo','celtic','norse','french'],german:['german','slavic','french','norse','italian','dutch'],french:['french','italian','iberian','german','celtic','dutch'],\n  italian:['italian','french','german','iberian'],norse:['norse','german','anglo','slavic'],slavic:['slavic','german','norse'],celtic:['celtic','anglo','norse','french'],iberian:['iberian','portuguese','french','italian'],\n  portuguese:['portuguese','iberian','french','italian'],dutch:['dutch','german','french','anglo','norse']};",
  },
  {
    why: 'Their common folk\'s names: given names, more roots, surnames from trades, places and nicknames, a father\'s name and a home town\'s.',
    find: "origin:t=>/^El /.test(t)?'del '+t.slice(3):/^La /.test(t)?'de la '+t.slice(3):/^Los /.test(t)?'de los '+t.slice(4):'de '+t\n}\n};",
    replace: String.raw`origin:t=>/^El /.test(t)?'del '+t.slice(3):/^La /.test(t)?'de la '+t.slice(3):/^Los /.test(t)?'de los '+t.slice(4):'de '+t
},
portuguese:{
 m:['Afonso','Aires','Álvaro','Antão','Baltasar','Bartolomeu','Belchior','Bento','Brás','Cristóvão','Diogo','Domingos','Duarte','Egas','Estêvão','Fernão','Fradique','Francisco','Garcia','Gaspar','Gil','Gomes','Gonçalo','Guterre','Heitor','Henrique','Jorge','Lançarote','Lopo','Lourenço','Luís','Manuel','Martim','Mem','Mendo','Nuno','Paio','Pêro','Ramiro','Rui','Sancho','Sebastião','Simão','Soeiro','Telo','Tomé','Tristão','Vasco','Vicente'],
 f:['Aldonça','Ana','Antónia','Beatriz','Branca','Briolanja','Brites','Catarina','Clara','Constança','Estefânia','Filipa','Francisca','Genebra','Grácia','Guiomar','Helena','Inês','Isabel','Joana','Leonor','Lianor','Luísa','Madalena','Mafalda','Maior','Margarida','Maria','Marinha','Mécia','Mor','Sancha','Senhorinha','Teresa','Úrsula','Urraca','Violante'],
 roots:['Alto','Bravo','Cabra','Corvo','Fonte','Galo','Covas','Lara','Novo','Urso','Pinho','Prata','Rei','Carvalho','Serra','Trigo','Veiga','Vide','Raposo','Sal','Pereira','Nogueira','Cedro','Mel','Pardo','Faia','Freixo','Sobral'],
 occ:{smith:'Ferreiro',miller:'Moleiro',baker:'Padeiro',tanner:'Surrador',weaver:'Tecelão',dyer:'Tintureiro',carpenter:'Carpinteiro',mason:'Pedreiro',fisher:'Pescador',shepherd:'Pastor',cooper:'Tanoeiro',thatcher:'Colmeiro',potter:'Oleiro',brewer:'Cervejeiro',butcher:'Carniceiro',carter:'Carreteiro',reeve:'Mordomo',tailor:'Alfaiate',cook:'Cozinheiro',hunter:'Caçador',forester:'Monteiro',wheelwright:'Carreiro',fletcher:'Frecheiro',salter:'Salineiro',merchant:'Mercador',miner:'Mineiro',boatman:'Barqueiro',ploughman:'Lavrador',herdsman:'Vaqueiro',bowyer:'Besteiro',glover:'Luveiro',chandler:'Cerieiro',shoemaker:'Sapateiro',roper:'Cordoeiro',spicer:'Especieiro'},
 loc:{wood:['do Mato','Matos','da Mata'],brook:['Ribeiro','do Ribeiro','Ribeiros'],river:['do Rio','Rios','Ribas'],hill:['Outeiro','do Monte','Montes','Cabeço'],ford:['Vau','do Vau','Vaus'],bridge:['Ponte','da Ponte','Pontes'],marsh:['Paul','do Paul','Lagoa'],field:['Campos','do Campo','Chão'],green:['Prado','do Prado','Lameiras'],well:['Poço','do Poço','Fontes'],stone:['Pedra','Penha','Pedrosa'],heath:['Charneca','da Charneca','Gândara'],lane:['Quelha','da Rua','Canada'],church:['Igreja','da Igreja','Ermida'],mill:['Moinhos','do Moinho','Azenha'],moor:['Brejo','do Ermo','Ermo'],shore:['Ribeira','Costa','da Praia'],orchard:['Pomar','do Pomar','Hortas'],grove:['Souto','do Souto','Soutelo']},
 nick:{tall:'Comprido',short:'Baixo',strong:'Forte',bold:'Ousado',kind:'Bom',wise:'Sábio',dark:'Moreno',fair:'Louro',red:'Ruivo',brown:'Pardo',young:'Moço',old:'Velho',quick:'Ligeiro',stout:'Gordo'},
 patr:f=>{const T={Rodrigo:'Rodrigues',Rui:'Rodrigues',Fernão:'Fernandes',Fernando:'Fernandes',Martim:'Martins',Gonçalo:'Gonçalves',Álvaro:'Álvares',Pedro:'Pires',Pêro:'Pires',Diogo:'Dias',Henrique:'Henriques',Lopo:'Lopes',Nuno:'Nunes',Mendo:'Mendes',Mem:'Mendes',Soeiro:'Soares',Vasco:'Vaz',Estêvão:'Esteves',João:'Eanes',Paio:'Pais',Egas:'Viegas',Sancho:'Sanches',Ramiro:'Ramires',Telo:'Teles',Domingos:'Domingues',Simão:'Simões',Antão:'Antunes',Guterre:'Guterres'};return T[f]||f;},
 origin:t=>/^O /.test(t)?'do '+t.slice(2):/^A /.test(t)?'da '+t.slice(2):/^Os /.test(t)?'dos '+t.slice(3):/^As /.test(t)?'das '+t.slice(3):'de '+t
},
dutch:{
 m:['Aert','Adriaen','Albrecht','Arent','Barend','Bartholomeus','Boudewijn','Claes','Coenraad','Cornelis','Diederik','Dirck','Egbert','Evert','Floris','Frans','Frederik','Gerrit','Gijsbert','Govert','Harmen','Hendrick','Herman','Hugo','Huibert','Jacob','Jan','Jeroen','Joost','Joris','Lambert','Laurens','Lucas','Maarten','Meindert','Melchior','Michiel','Otto','Paulus','Pieter','Reinier','Roelof','Rutger','Sander','Simon','Steven','Symen','Teunis','Thijs','Volkert','Willem','Wouter','Ysbrand'],
 f:['Aechte','Aefje','Agniet','Aleid','Alijt','Anna','Baertje','Beatrijs','Brechtje','Catharina','Christina','Cornelia','Dieuwertje','Duifje','Elisabeth','Fijtje','Geertruyd','Grietje','Hadewych','Haesje','Hillegond','Ida','Jacoba','Jannetje','Josina','Kunera','Liedewij','Lijsbeth','Machteld','Margriet','Maritje','Neeltje','Petronella','Sara','Sophia','Trijntje','Weyntje','Wendelmoet'],
 roots:['Alk','Ams','Bre','Del','Dor','Gou','Haar','Hoorn','Kam','Lei','Mep','Naar','Rot','Scho','Vlaar','Zaan','Zwol','Mid','Purm','Wor','Beem','Mon','Ouder','Bun'],
 occ:{smith:'Smit',miller:'Molenaar',baker:'Bakker',tanner:'Looijer',weaver:'Wever',dyer:'Verver',carpenter:'Timmerman',mason:'Metselaar',fisher:'Visser',shepherd:'Schaper',cooper:'Kuiper',thatcher:'Dekker',potter:'Pottebakker',brewer:'Brouwer',butcher:'Vleeshouwer',carter:'Voerman',reeve:'Schout',tailor:'Snijder',cook:'Kok',hunter:'Jager',forester:'Houtvester',wheelwright:'Wagenaar',fletcher:'Pijlmaker',salter:'Zouter',merchant:'Koopman',miner:'Delver',boatman:'Schipper',ploughman:'Bouwman',herdsman:'Herder',bowyer:'Boogmaker',glover:'Handschoenmaker',chandler:'Keersmaker',shoemaker:'Schoenmaker',roper:'Touwslager',spicer:'Kruidenier'},
 loc:{wood:['van den Bosch','Verbosch','Bosman'],brook:['van der Beek','Verbeek','Beekman'],river:['van der Aa','Waterman','van de Stroom'],hill:['van den Berg','Verberg','Heuvelman'],ford:['van der Voort','Vervoort','Voorman'],bridge:['van der Brugge','Verbrugge','Bruggeman'],marsh:['van den Broek','Verbroek','Broekman'],field:['van der Velde','Verveld','Veldman'],green:['van de Weide','Verweij','Weideman'],well:['van der Putte','Verput','Putman'],stone:['van den Steen','Versteeg','Steenman'],heath:['van der Heide','Verheijde','Heideman'],lane:['van der Laan','Verlaan','Laanman'],church:['van der Kerk','Verkerk','Kerkhof'],mill:['van der Molen','Vermolen','Molenkamp'],moor:['van het Veen','Verveen','Veenman'],shore:['van het Strand','Zeeman','Strandman'],orchard:['van den Boomgaard','Bogaert','Boomgaard'],grove:['van den Hout','Verhout','Houtman']},
 nick:{tall:'de Lange',short:'de Korte',strong:'Sterk',bold:'de Stoute',kind:'Goedhart',wise:'de Wijs',dark:'de Zwart',fair:'de Wit',red:'de Roo',brown:'de Bruijn',young:'de Jong',old:'de Oude',quick:'Snel',stout:'de Groot'},
 patr:f=>f+'sen',
 origin:t=>'van '+(/^(?:De|Den|Het) /.test(t)?t[0].toLowerCase()+t.slice(1):t)
}
};`,
  },
  {
    why: 'How each names a daughter village: the new and upper words it strips from its mother\'s name, and how it names a place for the man who led its people out.',
    find: "man:(g,r)=>r1(r,['Villa'+g.toLowerCase().replace(/^a/,''),'Torre de '+g,'Casas de '+g])}\n};",
    replace: String.raw`man:(g,r)=>r1(r,['Villa'+g.toLowerCase().replace(/^a/,''),'Torre de '+g,'Casas de '+g])},
  portuguese:{pre:/^(?:Vila Nova de |(?:Novo|Nova|Alto|Alta|Baixo|Baixa|Velho|Velha|Grande|Pequeno|Pequena) )/,suf:/(?:(?<=\p{L}{4})nova| de (?:Cima|Baixo))$/u,
    man:(g,r)=>r1(r,['Vilar de '+g,'Casal de '+g,'Quinta de '+g,'Torre de '+g])},
  dutch:{pre:/^(?:Nieuw(?=\p{L}{4})|(?:Nieuw|Oud|Groot|Klein|Hoog|Neder|Over|Oost|West|Noord|Zuid)-|(?:Nieuwe|Oude) )/u,suf:/(?:(?<=\p{L}{4})nieuw| (?:Binnen|Buiten))$/u,
    man:(g,r)=>{const s=/s$/.test(g)?g:g+'s';return r1(r,[s+'dorp',s+'woude',s+'kerke',s+'hoeve']);}}
};`,
  },
  {
    why: 'Their shop and inn signs: a colour and an emblem in each grammar, the article agreeing with the emblem.',
    find: "dyer:'Barvírna'}},\n};",
    replace: "dyer:'Barvírna'}},\n" +
      "  portuguese:{col:['de Ouro','de Prata','de Bronze'],emb:[['Leão','m'],['Touro','m'],['Cervo','m'],['Sol','m'],['Galo','m'],['Cisne','m'],['Navio','m'],['Estrela','f'],['Coroa','f'],['Rosa','f'],['Sereia','f'],['Chave','f'],['Lua','f'],['Cruz','f'],['Âncora','f']],\n" +
      "    make:(c,e,g)=>(g==='f'?'da ':'do ')+e+' '+c,tw:{shop:'Loja',bakery:'Forno',smithy:'Ferraria',tannery:'Pelames',warehouse:'Armazém',tavern:'Taberna',inn:'Estalagem',dyer:'Tinturaria'},prefixOnly:true},\n" +
      "  dutch:{col:['Gouden','Rode','Witte','Zwarte','Groene','Blauwe','Zilveren','Vergulde'],emb:[['Leeuw','c'],['Hert','n'],['Zwaan','c'],['Haan','c'],['Ster','c'],['Kroon','c'],['Arend','c'],['Beer','c'],['Schip','n'],['Anker','n'],['Paard','n'],['Lam','n'],['Hoorn','c'],['Klok','c'],['Sleutel','c'],['Haring','c'],['Molen','c'],['Hand','c']],\n" +
      "    make:(c,e,g)=>'In '+(g==='n'?\"'t\":'de')+' '+c+' '+e,tw:{shop:'Winkel',bakery:'Bakkerij',smithy:'Smidse',tannery:'Looierij',warehouse:'Pakhuis',tavern:'Herberg',inn:'Logement',dyer:'Ververij'}},\n};",
  },
  {
    why: 'Their towns\' institutions: the windmill, the hospital, the bath, the toll house and the merchants\' hall.',
    find: "celtic:'the Guildhall'}};",
    replace: "celtic:'the Guildhall'}};\n" +
      "for(const[k,o]of Object.entries({windmill:{portuguese:p=>'Moinho de '+p,dutch:p=>'Molen van '+p},hospital:{portuguese:()=>'Hospital do Espírito Santo',dutch:()=>'Heilige Geestgasthuis'},\n" +
      "  bath:{portuguese:'Banhos',dutch:'Badstoof'},toll:{portuguese:'Portagem',dutch:'Tolhuis'},guildhall:{portuguese:'Casa dos Vinte e Quatro',dutch:'Gildehuis'}}))Object.assign(INST_NAMES[k],o);",
  },
  {
    why: 'Their town halls.',
    find: "C===CULT.norse?'Rådhus':'the Guildhall');",
    replace: "C===CULT.norse?'Rådhus':C===CULT.portuguese?'Paços do Concelho':C===CULT.dutch?'Stadhuis':'the Guildhall');",
  },
  {
    why: 'Their quarries.',
    find: "C===CULT.norse?s.name+' Steinbrudd':s.name+' Quarry';",
    replace: "C===CULT.norse?s.name+' Steinbrudd':C===CULT.portuguese?'Pedreira de '+s.name:C===CULT.dutch?'Steengroeve van '+s.name:s.name+' Quarry';",
  },
  {
    why: 'Their wharves.',
    find: "C===CULT.norse?s.name+' '+r1(r,['Brygge','Kai']):",
    replace: "C===CULT.norse?s.name+' '+r1(r,['Brygge','Kai']):C===CULT.portuguese?r1(r,['Cais','Ribeira'])+' de '+s.name:C===CULT.dutch?r1(r,['Kade','Steiger','Hoofd'])+' van '+s.name:",
  },
  {
    why: 'Their water mills.',
    find: "C===CULT.italian?'Mulino di '+s.name:s.name+' Mill';",
    replace: "C===CULT.italian?'Mulino di '+s.name:C===CULT.portuguese?'Azenha de '+s.name:C===CULT.dutch?'Watermolen van '+s.name:s.name+' Mill';",
  },
  {
    why: 'Their great houses\' town courts.',
    find: 'C===CULT.slavic?`Dům ${fam}`:`${fam} House`;}',
    replace: 'C===CULT.slavic?`Dům ${fam}`:C===CULT.portuguese?`Solar ${fam}`:C===CULT.dutch?`Huis ${fam}`:`${fam} House`;}',
  },
  {
    why: 'How often a town of theirs stands on a Roman one: Lusitania as Hispania, the Low Countries as Germany.',
    find: 'const legacy={italian:0.65,french:0.45,iberian:0.55,anglo:0.25,celtic:0.15,german:0.15}',
    replace: 'const legacy={italian:0.65,french:0.45,iberian:0.55,anglo:0.25,celtic:0.15,german:0.15,portuguese:0.55,dutch:0.15}',
  },
  {
    why: 'Their people\'s hair: the Portuguese as the Castilians, the Dutch fairer than the Germans.',
    find: 'italian:[6,3,1,0.4],iberian:[6,3,1,0.4]}[c]',
    replace: 'italian:[6,3,1,0.4],iberian:[6,3,1,0.4],portuguese:[6,3,1,0.4],dutch:[2,4,4,1]}[c]',
  },
  {
    why: 'Their colour on the map of tongues.',
    find: 'celtic:0x2f7d32,iberian:0xd35400};',
    replace: 'celtic:0x2f7d32,iberian:0xd35400,portuguese:0x922b5e,dutch:0x5dade2};',
  },
]);

// The source's program with the table applied.
export function tuneBoardSource(source) {
  let tuned = source;
  for (const { find, replace, count = 1 } of BOARD_TUNING) {
    const found = tuned.split(find).length - 1;
    if (found !== count) throw new Error(`Castle and Commons has changed: found ${found} of ${count} of "${find.slice(0, 70)}"`);
    tuned = tuned.split(find).join(replace);
  }
  return tuned;
}

// The source's program again, from one tuned by the first `taken` entries of the table: each undone, the last first.
export function untuneBoardSource(tuned, taken = BOARD_TUNING.length) {
  let source = tuned;
  for (const { find, replace, count = 1 } of BOARD_TUNING.slice(0, taken).reverse()) {
    const found = source.split(replace).length - 1;
    if (found !== count) throw new Error(`The tuned program has changed: found ${found} of ${count} of "${replace.slice(0, 70)}"`);
    source = source.split(replace).join(find);
  }
  return source;
}
