// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Changes to Castle and Commons' simulation itself, to be copied back into that game so both games run one simulation.
// Each entry is a passage of its program (assets/board/game.js, as taken) and what it becomes, applied after the fitting
// in scripts/board-tuning.mjs and checked the same way. Every replacement is written as that game's own code: generic,
// driven by its own tables, and reading nothing of this game (no FURLONG_OPTIONS, no ground or bake of ours), so the
// passage can be pasted into its index.html as it stands.
//
// A change here must leave that game's random streams as they were wherever it is not in play: a seed makes the realm
// it made before, and a board founded in a tongue that was already there is founded as it was.
//
// Two kinds so far:
//   fixes   faults in the simulation, found while living its realms out here
//   tongues Portuguese and Dutch, each entered wherever the program lists its tongues. They are spoken only where a
//           real map's region speaks them (REALMAPS, built by that game's tools/realmap.py, or a host's own map); a
//           realm made up from a seed is never drawn in them, nor are its sell-swords (CULT_DRAWN).
//
// Three more go back with these, each kept in a table of its own since each is a whole people's custom or map layer, not a fix:
//   native   the peoples of the Americas and their ways (scripts/board-native.mjs)
//   colonial the towns the crowns planted overseas (scripts/board-colonial.mjs), changing the simulation so:
//            - a real map may name the manner a tongue's towns on it were planted by (REALMAP.manners), its colony's
//              year (REALMAP.founded) and how settled its country was (REALMAP.settled); none named, nothing changes
//            - settlementOrigin: a planted town's founding is its colony's year (its seat) or some years on, drawn
//              from a stream of its own, with its manner for its layout (MANNERS: traza, ladeira)
//            - the founding of the realm founds only REALMAP.settled of the towns and villages it would
//            - layoutSettlement: a planted town is laid out in one stroke by plantTown (its plaza or largo, its
//              lattice of streets, its church; a ladeira town's upper and lower towns and the ladeiras between); it
//              has no castle on the hill, no burgage rows where its manner has none, no new town planted beside it,
//              no market charter's history, and its quay does not tell its founding; its lots are
//              taken nearest its plaza or largo first
//   forts    the works a real map records (scripts/board-forts.mjs), changing the simulation so:
//            - ARCH has two kinds more, fort and battery (a watchtower is its own tower), never pulled down for a
//              street, a wall or a plan
//            - a real map may list its coast's works (REALMAP.works: kind, name, u, v, w, d, from, until, role, side);
//              none listed, nothing changes
//            - generateWorld: before the towns are laid, each work standing in the realm's year is set on the nearest
//              dry ground to its record, turned to the nearest water (open water before a creek no farther off; a
//              battery, and a work the record set back, brought down to the water's edge) and given to the nearest
//              place (worksSite)
//            - layoutSettlement: no street or house on a work's ground (buildable); a citadel is where the place's
//              castle on the hill stands; a place's works are stood as its buildings once its streets are laid
//              (worksStand); its wall goes round them
//
// Staged upstream copy-back queue (BOARD_UPSTREAM_PENDING):
//   `BOARD_UPSTREAM` holds the 28 passages currently applied to `assets/board/game.js` (as recorded in
//   `assets/board/SOURCE.json`), whose SHA-256 is pinned inside all pre-baked `assets/boards/*.world` saves.
//   `BOARD_UPSTREAM_PENDING` holds subsequent generic simulation improvements written in Castle and Commons' own
//   code and verified offline against both the untuned source and `assets/board/game.js` by
//   `scripts/vendor-castle-and-commons.mjs --check` and `tests/board-model.test.mjs`. Until the next `--retune`
//   and full board rebake promotes them into `BOARD_UPSTREAM`, guarded fallback shims in `assets/board/runtime.js`
//   mirror them and yield automatically the moment each upstream hook exists in `assets/board/game.js`.
export const BOARD_UPSTREAM = Object.freeze([
  // Fixes.
  {
    why: 'The search for who holds what ground kept its costs in single precision and compared them in double, so two ways of the same cost queued a cell twice, and on even ground that compounds without end. Kept in double.',
    find: 'const N=GRID*GRID,cost=new Float32Array(N).fill(Infinity),dom=new Int16Array(N).fill(-1),heap=[];',
    replace: 'const N=GRID*GRID,cost=new Float64Array(N).fill(Infinity),dom=new Int16Array(N).fill(-1),heap=[];',
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
  // Tongues. The program speaks Castilian for all Iberia and has no tongue for the Low Countries. Portuguese and Dutch
  // are each a tongue as it keeps one: names of people and places, signs, institutions, houses, customs and a colour.
  {
    why: 'The tongues themselves: their people\'s names, the patterns of their places, their houses, saints, inns and trades. drawn:false keeps them out of the lots a made-up realm is drawn by.',
    find: "warehouse:['Almacén {N} e Hijos','La Alhóndiga']}}\n};",
    replace: String.raw`warehouse:['Almacén {N} e Hijos','La Alhóndiga']}},
  // drawn:false: spoken where a real map's region speaks it, never drawn by lot for a made-up realm (CULT_DRAWN), so a seed makes the realm it made before
  portuguese:{name:'Portuguese',adj:'Portuguese',drawn:false,
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
  dutch:{name:'Dutch',adj:'Netherlandish',drawn:false,
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
    why: 'Which tongues a realm\'s great houses may speak beside the crown\'s, for a crown of each new tongue; and the tongues a made-up realm is drawn in. The old tongues\' neighbours stay as they were: adding to them would change every realm drawn in one.',
    find: "celtic:['celtic','anglo','norse','french'],iberian:['iberian','french','italian']};",
    replace: "celtic:['celtic','anglo','norse','french'],iberian:['iberian','french','italian'],\n  portuguese:['portuguese','iberian','french','italian'],dutch:['dutch','german','french','anglo','norse']};\n" +
      "const CULT_DRAWN=Object.keys(CULT).filter(k=>CULT[k].drawn!==false); // the tongues a made-up realm, and the sell-swords it hires, are drawn from",
  },
  {
    why: 'A made-up realm\'s crown is drawn from those tongues alone.',
    find: 'const r=nameRng(1),ids=Object.keys(CULT);',
    replace: 'const r=nameRng(1),ids=CULT_DRAWN;',
  },
  {
    why: 'And so are its sell-swords.',
    find: 'if(!a.men)a.men=[];const cs=Object.keys(CULT);',
    replace: 'if(!a.men)a.men=[];const cs=CULT_DRAWN;',
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
  {
    why: 'Their inheritance: the Dutch share a holding among the heirs, as the Germans do; the Portuguese leave it to the eldest, as the Castilians do.',
    find: "partible (Welsh, German, Slav, Norse). */\nconst PARTIBLE=new Set(['celtic','german','slavic','norse']);",
    replace: "partible (Welsh, German, Slav, Norse, Dutch). */\nconst PARTIBLE=new Set(['celtic','german','slavic','norse','dutch']);",
  },
  {
    why: 'Their houses\' particles: a Dutch house is known apart from the rest by its name without van, as a German one is without von.',
    find: "const houseKey=n=>n.replace(/^House /,'').replace(/^(de |von |di |da |della |del )/,'')",
    replace: "const houseKey=n=>n.replace(/^House /,'').replace(/^(de |von |van der |van den |van |di |da |della |del )/,'')",
  },
]);

// Staged upstream simulation changes ready to copy back into Castle and Commons' index.html and to promote into
// BOARD_UPSTREAM on the next `vendor-castle-and-commons.mjs --retune` + full board rebake. Every passage is pure
// Castle and Commons code (zero host-specific globals, zero PRNG perturbation when not called), applies cleanly to
// both the untuned upstream source and the tuned assets/board/game.js, and maps 1:1 to a guarded runtime fallback
// shim in assets/board/runtime.js so zero simulation logic is duplicated once promoted.
export const BOARD_UPSTREAM_PENDING = Object.freeze([
  {
    id: 'find-person-armies',
    runtimeHook: 'findPerson',
    runtimeShim: 'buildArmySoldierInspect',
    why: 'findPerson missed levied householders and hired sell-swords serving in W.armies (referenceTarget had a one-off fallback, while property, tenure, tree, and inspector lookups calling findPerson returned null). Search living hosts before returning null.',
    find: "const t=(W.travellers||[]).find(x=>x.p.id===id);if(t)return {p:t.p,s:W.settlements[t.to],t};return null;}",
    replace:
      "const t=(W.travellers||[]).find(x=>x.p.id===id);if(t)return {p:t.p,s:W.settlements[t.to],t};\n" +
      "  for(const a of W.armies||[])if(!a.gone){const p=(a.men||[]).find(x=>x.id===id);if(p){const s=W.settlements[p.home]||W.settlements[p.si]||W.settlements[a.at];if(s)return {p,s,a};}}\n" +
      "  return null;}",
  },
  {
    id: 'opening-market-listing',
    runtimeHook: 'openingMarketListing',
    runtimeShim: 'ensureOpeningMarketListing',
    why: 'On opening day before the first daily market tick runs (while !s.storage), settlements hold genuine s.stores surplus (spareOf > 0) with zero seller lots listed on mkt(s, g), starving opening-day caravans, barges, and coasters. List real spare surplus under living local folk without minting goods.',
    find: 'function avail(s,g,p){const L=mkt(s,g),R=s.rsv&&s.rsv[g];let a=0;for(const[w,v]of L.ownedEntries())if(!(R&&R.get(w)>p))a+=forSale(w,v,g);return a;}',
    replace:
      'function avail(s,g,p){const L=mkt(s,g),R=s.rsv&&s.rsv[g];let a=0;for(const[w,v]of L.ownedEntries())if(!(R&&R.get(w)>p))a+=forSale(w,v,g);return a;}\n' +
      'function openingMarketListing(s){ // list genuine opening-day s.stores surplus under living folk before the first daily market tick (zero goods minted)\n' +
      '  if(!s||s.storage||!s.stores)return;const now=day(),folk=Array.isArray(s.folk)?s.folk:[];\n' +
      '  const open=p=>p&&!p.dead&&!(p.away&&now<(p.away.until??0));\n' +
      "  const sellers=folk.filter(p=>open(p)&&(p.tr==='merchant'||p.tr==='trader'||p.tr==='chandler'||p.tr==='spicer'||p.tr==='farmer'||p.tr==='peasant'||p.tr==='weaver'||p.tr==='smith'));\n" +
      '  const pool=sellers.length?sellers:folk.filter(open);if(!pool.length)return;\n' +
      '  let idx=0;\n' +
      '  for(const g of GOODS){\n' +
      '    if(avail(s,g,price(s,g)*1.5)>=3)continue;\n' +
      '    const raw=Math.max(0,Number(s.stores[g])||0),sp=typeof spareOf===\'function\'?Math.max(0,Number(spareOf(s,g))||0):raw,qty=Math.min(raw*0.65,sp);\n' +
      '    if(qty<3)continue;\n' +
      '    offer(s,g,pool[(idx++)%pool.length],qty,price(s,g)*0.9);\n' +
      '  }\n' +
      '}',
  },
  {
    id: 'opening-trade-backdate',
    runtimeHook: 'openingTradeBackdate',
    runtimeShim: 'openingTradeSpreadFrac',
    why: 'Opening-day trade dispatches (Day 0 or forced opening pass) start all caravans, barges, and coasters stacked at departDay === now on their origin gates. Provide deterministic openingTradeBackdate(mode, i, now, force) and optional openingSpread handling in tickTrade without altering normal daily ticks.',
    find: 'function tickTrade(){\n  const S=W.settlements,',
    replace:
      'function openingTradeBackdate(mode,i=0,now=day(),force=false){ // deterministic en-route spread on opening day so traffic is not stacked at the gates\n' +
      '  if(!(force||now<=0.01))return 0;\n' +
      "  if(mode==='sea')return 0.16+((i*0.21)%0.62);\n" +
      "  if(mode==='river')return 0.20+((i*0.27)%0.56);\n" +
      "  if(mode==='cart-coach')return 0.15+((i*0.17)%0.55);\n" +
      '  return 0.18+((i*0.19)%0.58);\n' +
      '}\n' +
      'function tickTrade(opts){\n' +
      '  const openingSpread=!!(opts&&opts.openingSpread);let openingIdx=0;\n' +
      '  const S=W.settlements,',
  },
  {
    id: 'opening-trade-spread-dispatch',
    runtimeHook: 'openingTradeBackdate',
    runtimeShim: 'openingTradeSpreadFrac',
    why: 'Apply openingTradeBackdate when tickTrade({ openingSpread: true }) runs on opening day; ordinary simTick() calls pass no opts so departDay stays day() bit-for-bit.',
    find: "const c={origin:oi,dest:di,good:g,qty:bq,value:bq*price(d,g),poly:b.mode==='cart'?b.leg.poly:null,len:b.len,departDay:day(),arriveDay:day()+b.days,robbed:false,sea,unit:b.unit};",
    replace:
      "const spread=openingSpread?openingTradeBackdate(b.mode,openingIdx++,day(),true):0,d0=day()-spread*b.days,c={origin:oi,dest:di,good:g,qty:bq,value:bq*price(d,g),poly:b.mode==='cart'?b.leg.poly:null,len:b.len,departDay:d0,arriveDay:d0+b.days,robbed:false,sea,unit:b.unit};",
  },
  {
    id: 'river-economic-corridors',
    runtimeHook: 'riverEconomicCorridors',
    runtimeShim: 'buildRiverEconomicCorridors',
    why: 'Local river fishing and ferry boats need navigable multi-endpoint economic corridors (settlement-to-settlement or settlement-to-estuary via sea-connected confluences), never isolated upland creeks or headwaters past the last settlement. Derive navigable corridors from W.rivStrips, W.water, and W.settlements.',
    find: 'if(r&&r.len>400)W.riverPairs.push({a:i,b:j,route:r});\n  }\n  if(seed)seedFolk(); // every soul in every place, with a name, a family, a nature and a schooling\n}',
    replace:
      'if(r&&r.len>400)W.riverPairs.push({a:i,b:j,route:r});\n  }\n  if(seed)seedFolk(); // every soul in every place, with a name, a family, a nature and a schooling\n}\n' +
      'function riverEconomicCorridors(estuaryLabel){ // navigable multi-endpoint river legs (settlement <-> settlement or settlement <-> sea-connected estuary)\n' +
      '  const S=W.settlements||[],rivStrips=Array.isArray(W.rivStrips)?W.rivStrips:[];\n' +
      '  const distPt=(a,b)=>Math.hypot((b.x||0)-(a.x||0),(b.z||0)-(a.z||0));\n' +
      '  const hubSettlement=S.find(s=>s?.harbor)||S[0]||null,hubSi=hubSettlement?Math.max(0,S.indexOf(hubSettlement)):0;\n' +
      "  const hubName=String(hubSettlement?.name||W?.capital?.name||'Harbor'),estuaryName=estuaryLabel||`${hubName} Estuary`;\n" +
      '  const isNearSea=pt=>{\n' +
      "    if(!pt||!W.water||typeof toCell!=='function'||typeof inB!=='function'||typeof cIdx!=='function')return false;\n" +
      "    const cx0=toCell(pt.x),cz0=toCell(pt.z),rad=Math.max(1,Math.ceil(120/(typeof CELL==='number'&&CELL>0?CELL:40)));\n" +
      '    for(let dz=-rad;dz<=rad;dz++)for(let dx=-rad;dx<=rad;dx++){\n' +
      '      const cx=cx0+dx,cz=cz0+dz;if(!inB(cx,cz)||W.water[cIdx(cx,cz)]!==1)continue;\n' +
      '      if(Math.hypot(cellX(cx)-pt.x,cellZ(cz)-pt.z)<=120)return true;\n' +
      '    }\n' +
      '    return false;\n' +
      '  };\n' +
      '  const stripEndSea=rivStrips.map(q=>!q||q.canal||!Array.isArray(q.pts)||q.pts.length<4?[false,false]:[isNearSea(q.pts[0]),isNearSea(q.pts[q.pts.length-1])]);\n' +
      '  let seaChanged=true;\n' +
      '  for(let pass=0;pass<4&&seaChanged;pass++){\n' +
      '    seaChanged=false;\n' +
      '    for(let ri=0;ri<rivStrips.length;ri++){\n' +
      '      const q=rivStrips[ri];if(!q||q.canal||!Array.isArray(q.pts)||q.pts.length<4)continue;\n' +
      '      for(const endIdx of [0,1]){\n' +
      '        if(stripEndSea[ri][endIdx])continue;\n' +
      '        const endPt=endIdx===0?q.pts[0]:q.pts[q.pts.length-1];\n' +
      '        for(let rj=0;rj<rivStrips.length;rj++){\n' +
      '          if(rj===ri||(!stripEndSea[rj][0]&&!stripEndSea[rj][1]))continue;\n' +
      '          const o=rivStrips[rj];if(!o||o.canal||!Array.isArray(o.pts)||o.pts.length<4)continue;\n' +
      '          for(let k=0;k<o.pts.length;k++)if(distPt(endPt,o.pts[k])<=32){stripEndSea[ri][endIdx]=true;seaChanged=true;break;}\n' +
      '          if(stripEndSea[ri][endIdx])break;\n' +
      '        }\n' +
      '      }\n' +
      '    }\n' +
      '  }\n' +
      '  const corridors=[],validRiverIndices=new Set();\n' +
      '  for(let ri=0;ri<rivStrips.length;ri++){\n' +
      '    const q=rivStrips[ri];if(!q||q.canal||!Array.isArray(q.pts)||q.pts.length<4)continue;\n' +
      '    const pts=q.pts,cumLen=new Float64Array(pts.length);\n' +
      '    for(let k=1;k<pts.length;k++)cumLen[k]=cumLen[k-1]+distPt(pts[k-1],pts[k]);\n' +
      '    const rawWaypoints=[];\n' +
      '    for(let si=0;si<S.length;si++){\n' +
      '      const s=S[si];if(!s?.pos)continue;\n' +
      '      const reachRadius=Math.max(Math.min(Number(s.extentR)||120,380),260);\n' +
      '      let bestK=-1,bestD=Infinity;\n' +
      '      for(let k=0;k<pts.length;k++){const d=distPt(pts[k],s.pos);if(d<bestD){bestD=d;bestK=k;}}\n' +
      "      if(bestK>=0&&bestD<=reachRadius)rawWaypoints.push({kind:'settlement',si,name:String(s.name||`Place ${si+1}`),k:bestK,dist:bestD});\n" +
      '    }\n' +
      '    if(!rawWaypoints.length)continue;\n' +
      "    if(stripEndSea[ri][0]&&!rawWaypoints.some(w=>distPt(pts[w.k],pts[0])<=140))rawWaypoints.push({kind:'estuary',si:-1,name:estuaryName,k:0,dist:0});\n" +
      "    if(stripEndSea[ri][1]&&!rawWaypoints.some(w=>distPt(pts[w.k],pts[pts.length-1])<=140))rawWaypoints.push({kind:'estuary',si:-1,name:estuaryName,k:pts.length-1,dist:0});\n" +
      '    rawWaypoints.sort((a,b)=>a.k-b.k||a.dist-b.dist);\n' +
      '    const waypoints=[];\n' +
      '    for(const wp of rawWaypoints){const prev=waypoints[waypoints.length-1];if(prev&&prev.si===wp.si&&prev.kind===wp.kind){if(wp.dist<prev.dist)waypoints[waypoints.length-1]=wp;continue;}waypoints.push(wp);}\n' +
      "    if(!waypoints.some(w=>w.kind==='settlement')||waypoints.length<2)continue;\n" +
      '    const addLeg=(wpA,wpB,legIdx)=>{\n' +
      "      if(!wpA||!wpB||wpA.k===wpB.k||(wpA.si>=0&&wpA.si===wpB.si)||(wpA.kind!=='settlement'&&wpB.kind!=='settlement'))return;\n" +
      '      const kLo=Math.min(wpA.k,wpB.k),kHi=Math.max(wpA.k,wpB.k);if(kHi-kLo<3)return;\n' +
      '      const segLen=cumLen[kHi]-cumLen[kLo];if(segLen<140)return;\n' +
      '      let hwSum=0;for(let k=kLo;k<=kHi;k++)hwSum+=q.hw?.[k]??2;\n' +
      '      const avgHw=hwSum/(kHi-kLo+1);if(avgHw<1.35)return;\n' +
      '      const slice=pts.slice(kLo,kHi+1).map(p=>({x:p.x,z:p.z})),fromWp=wpA.k<=wpB.k?wpA:wpB,toWp=wpA.k<=wpB.k?wpB:wpA;\n' +
      '      validRiverIndices.add(ri);\n' +
      '      corridors.push({ri,legIdx,key:`${ri}:${fromWp.si}>${toWp.si}:${kLo}-${kHi}`,pts:slice,totalLen:segLen,avgHw,fromWp,toWp});\n' +
      '    };\n' +
      '    let addedAny=false;\n' +
      '    for(let wi=0;wi+1<waypoints.length;wi++){const before=corridors.length;addLeg(waypoints[wi],waypoints[wi+1],wi);if(corridors.length>before)addedAny=true;}\n' +
      '    if(!addedAny)addLeg(waypoints[0],waypoints[waypoints.length-1],0);\n' +
      '  }\n' +
      '  corridors.sort((a,b)=>b.totalLen-a.totalLen||a.ri-b.ri||a.legIdx-b.legIdx);\n' +
      '  return {corridors,validRiverIndices,hubSi,estuaryName};\n' +
      '}',
  },
  {
    id: 'river-boat-cargo-transfer',
    runtimeHook: 'stepRiverBoatArrival',
    runtimeShim: 'advanceRiverBoatArrival',
    why: 'Local river shuttles (W.riverBoats) must prune sunk, ghost-piloted, or non-corridor craft, cap boat counts strictly by living riverside fishers/boatmen and corridors, and transfer real available cargo between endpoint settlements on leg arrival without minting goods or perturbing PRNG streams.',
    find: '  for(const r of W.roads)r.vol=(r.vol||0)*0.995;\n}',
    replace:
      '  for(const r of W.roads)r.vol=(r.vol||0)*0.995;\n}\n' +
      'function riverBoatHash(a,b=0,c=0){let h=(Math.imul(a|0,0x27d4eb2d)^Math.imul(b|0,0x165667b1)^Math.imul(c|0,0x9e3779b9))|0;h=Math.imul(h^(h>>>15),0x2c1b3c6d);h=Math.imul(h^(h>>>12),0x297a2d39);return (h^(h>>>15))>>>0;}\n' +
      'function riverBoatTargetCount(corridors){\n' +
      '  const S=W.settlements||[];let riverFolkCount=0,totalFishStore=0;\n' +
      '  for(const s of S){if(!s||!(s.riverside||s.river||s.harbor))continue;totalFishStore+=Math.max(0,Number(s.stores?.fish)||0);for(const p of s.folk||[])if(p&&!p.dead&&(p.tr===\'fisher\'||p.tr===\'boatman\'))riverFolkCount++;}\n' +
      '  return (riverFolkCount>=3&&Array.isArray(corridors)&&corridors.length>0)?Math.min(8,Math.max(1,Math.min(Math.floor(riverFolkCount/3),1+Math.floor(totalFishStore/45)))):0;\n' +
      '}\n' +
      'function pruneRiverBoats(validRiverIndices,targetCount){\n' +
      '  if(!Array.isArray(W.riverBoats))W.riverBoats=[];\n' +
      '  W.riverBoats=W.riverBoats.filter(b=>Boolean(b&&!b.sunk&&!(b.pilotId>=900000)&&validRiverIndices.has(b.riverIdx)&&b.from&&b.to&&!(b.si>=0&&b.destSi>=0&&b.si===b.destSi)));\n' +
      '  if(Number.isFinite(targetCount)&&W.riverBoats.length>Math.max(0,targetCount))W.riverBoats.length=Math.max(0,targetCount);\n' +
      '  return W.riverBoats;\n' +
      '}\n' +
      "const RIVER_PARCEL_GOODS=['fish','grain','wine','timber','salt','char','ore'];\n" +
      'function riverBoatParcel(si,idSalt,hubSi=0){\n' +
      "  const S=W.settlements||[],worldSeed=typeof SEED==='number'?SEED:1550,safeSi=si>=0&&si<S.length?si:hubSi,stores=S[safeSi]?.stores||{};\n" +
      "  if((Number(stores.fish)||0)>=2&&(idSalt%2===0))return {good:'fish',qty:Math.min(5,Math.max(2,Math.round(Math.min(5,Number(stores.fish)*0.08))))};\n" +
      '  const availGoods=RIVER_PARCEL_GOODS.filter(g=>(Number(stores[g])||0)>=2);\n' +
      "  if(!availGoods.length)return {good:'fish',qty:Math.min(2,Math.max(1,Math.floor(Number(stores.fish)||1)))};\n" +
      '  const good=availGoods[riverBoatHash(worldSeed,idSalt,17)%availGoods.length];\n' +
      '  const qty=Math.min(5,Math.max(2,Math.min(Math.floor(Number(stores[good])||2),2+(riverBoatHash(worldSeed,idSalt,23)%4))));\n' +
      '  return {good,qty};\n' +
      '}\n' +
      'function stepRiverBoatArrival(b,now=day(),hubSi=0){ // transfer available parcel stock without minting goods and reverse the shuttle leg\n' +
      '  if(!b||now<(b.arriveDay??-Infinity))return false;\n' +
      '  const S=W.settlements||[],srcIdx=b.si>=0?b.si:hubSi,dstIdx=b.destSi>=0?b.destSi:hubSi,srcS=S[srcIdx],dstS=S[dstIdx];\n' +
      '  if(srcS?.stores&&dstS?.stores&&srcIdx!==dstIdx&&b.good&&b.qty>0){\n' +
      '    const availStock=Math.max(0,Number(srcS.stores[b.good])||0),moved=Math.min(availStock,Math.max(0,Number(b.qty)||0));\n' +
      '    if(moved>0){srcS.stores[b.good]=Math.max(0,availStock-moved);dstS.stores[b.good]=(Number(dstS.stores[b.good])||0)+moved;}\n' +
      '  }\n' +
      '  const prevSi=b.si,prevFrom=b.from;b.si=b.destSi;b.destSi=prevSi;b.from=b.to;b.to=prevFrom;b.forward=!b.forward;\n' +
      '  if(Array.isArray(b.points)&&b.points.length>=2)b.points=[...b.points].reverse();\n' +
      '  const span=Math.max(2.0,b.tripSpan||3.2);b.departDay=now;b.arriveDay=now+span;\n' +
      '  const nextHomeSi=b.si>=0?b.si:(b.destSi>=0?b.destSi:hubSi),nextParcel=riverBoatParcel(nextHomeSi,(b.id||1)+Math.floor(now),hubSi);\n' +
      '  b.good=nextParcel.good;b.qty=nextParcel.qty;\n' +
      '  return true;\n' +
      '}',
  },
  {
    id: 'settle-founding-month',
    runtimeHook: 'settleFoundingMonth',
    runtimeShim: 'ensureFoundingMonthSettled',
    why: 'Direct-era worlds frozen or opened at Day 0 stand before the first monthly livestock (day % 30 === 18) and domain/standing-host (day % 30 === 20) ticks fire, leaving all herds at zero and W.armies empty. Provide settleFoundingMonth() to run those genuine monthly handlers cleanly through Day 21 on opening or thaw without altering prehistory or Day-21+ saves.',
    find: "if(typeof freedomPrepare==='function')freedomPrepare();estateEcologyPrepare();initForeignWorld();\n}",
    replace:
      "if(typeof freedomPrepare==='function')freedomPrepare();estateEcologyPrepare();initForeignWorld();\n}\n" +
      'async function settleFoundingMonth(){ // execute the founding month livestock (day 18) and standing-host (day 20) ticks cleanly through day 21\n' +
      '  if(!W||!W.clock||!Array.isArray(W.settlements)||!W.settlements.length)return;\n' +
      '  if(day()>=21)return;\n' +
      '  const hasHerds=W.settlements.some(s=>Boolean(s?.hm));\n' +
      '  const hasArmies=Array.isArray(W.armies)&&W.armies.some(a=>a&&!a.gone&&(a.strength>0||a.men?.length>0));\n' +
      '  if(hasHerds&&hasArmies)return;\n' +
      '  await STORAGE_OUTCOMES.wait();\n' +
      "  if(typeof peoplePrepare==='function')peoplePrepare();\n" +
      "  if(day()<18||!hasHerds){W.clock.day=18;if(typeof dailyLabourBegin==='function')dailyLabourBegin(W.clock.day);if(typeof tickLivestock==='function')tickLivestock();if(typeof dailyLabourEnd==='function')dailyLabourEnd();}\n" +
      "  if(day()<20||!hasArmies){W.clock.day=20;if(typeof dailyLabourBegin==='function')dailyLabourBegin(W.clock.day);if(typeof tickDomains==='function')tickDomains();if(typeof tickMilitary==='function')tickMilitary();if(typeof dailyLabourEnd==='function')dailyLabourEnd();}\n" +
      '  if(day()<21)W.clock.day=21;\n' +
      '  if(STORAGE_OUTCOMES.journal?.flush)await STORAGE_OUTCOMES.journal.flush();\n' +
      '  await STORAGE_OUTCOMES.wait();\n' +
      '}',
  },
  {
    id: 'settlement-herd-totals',
    runtimeHook: 'herdTotals',
    runtimeShim: 'settlementHerds',
    why: 'Reading a settlement\'s standing livestock strictly from s.stores misses beasts recorded in per-owner s._owners ledgers before herdSync runs. Provide herdTotals(s) falling back to summing s._owners animals when s.stores is empty.',
    find: '  if(!W.prehistory&&G.herdMesh)G.herdsDirty=true;} // the flocks are laid out again when someone is near enough to see them',
    replace:
      '  if(!W.prehistory&&G.herdMesh)G.herdsDirty=true;} // the flocks are laid out again when someone is near enough to see them\n' +
      'function herdTotals(s){ // standing beasts in a place: s.stores with per-owner s._owners fallback\n' +
      '  const out={sheep:0,cattle:0,horses:0,swine:0};if(!s)return out;const st=s.stores||{};\n' +
      '  for(const k of BEASTS)out[k]=Math.max(0,Number(st[k])||0);\n' +
      "  if(out.sheep+out.cattle+out.horses+out.swine<0.5&&s._owners&&typeof s._owners.values==='function'){\n" +
      '    for(const rec of s._owners.values()){const a=rec?.animals;if(!a)continue;for(const k of BEASTS)out[k]+=Math.max(0,Number(a[k])||0);}\n' +
      '  }\n' +
      '  return {sheep:Math.round(out.sheep),cattle:Math.round(out.cattle),horses:Math.round(out.horses),swine:Math.round(out.swine)};\n' +
      '}',
  },
]);

// Complete upstream copy-back set (applied + staged) for upstreaming into Castle and Commons.
export const BOARD_UPSTREAM_ALL = Object.freeze([...BOARD_UPSTREAM, ...BOARD_UPSTREAM_PENDING]);

// Apply staged upstream passages in order, failing loudly if any anchor drifts.
export function applyPendingUpstream(source) {
  let patched = source;
  for (const { id, find, replace, count = 1 } of BOARD_UPSTREAM_PENDING) {
    const found = patched.split(find).length - 1;
    if (found !== count) throw new Error(`Staged upstream passage "${id}" drifted: found ${found} of ${count} of "${find.slice(0, 70)}"`);
    patched = patched.split(find).join(replace);
  }
  return patched;
}

// Reverse staged upstream passages in reverse order for exact round-trip verification.
export function undoPendingUpstream(patched) {
  let source = patched;
  for (const { id, find, replace, count = 1 } of [...BOARD_UPSTREAM_PENDING].reverse()) {
    const found = source.split(replace).length - 1;
    if (found !== count) throw new Error(`Staged upstream passage "${id}" cannot be undone: found ${found} of ${count} of "${replace.slice(0, 70)}"`);
    source = source.split(replace).join(find);
  }
  return source;
}
