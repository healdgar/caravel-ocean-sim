# Forts and the harbours they guard

A port's forts stand where the harbour needs them. `js/harbour-geography.js` reads the coast from the terrain: the
water a ship must cross from the sea to the anchorage, the narrow places on the way, and the ground that commands it.
`js/harbour-defences.js` puts forts there, by the record below where there is one and by the rule where there is not.
`js/fort-plan.js` draws each one to its ground. `scripts/fort-survey.mjs` reports on all of it, and
`scripts/fort-views.mjs` takes pictures from the real game. `scripts/harbour-coasts.mjs` keeps real coasts for the tests.

## The rule, for a port with no record

The stage of the colony decides how many forts (an outpost has none, only a watchtower). A port with records but none
standing yet goes by the rule too. Geography decides where:

1. A narrow mouth on the way out: forts on its headlands, on both sides once the port can pay for two.
2. Water that opens out from the anchorage: on the point where it opens.
3. Inner narrows.
4. The water off the town: the nearest point of land that sees the anchorage.

A town's first work is a low battery along its shore. A second is drawn to its ground.

## Which way they look

A fort's sea face bears on the water it guards, within gun range (1000 m, for the survey and for return fire). Its gate
is in the wall that looks most nearly inland and towards the town. A gun has an arc, 65° either side of the way its
wall faces. It fires only at a mark inside that arc, and `lineFouled` still holds it when its own works or the town
stand in line. The town keeps out of the ground in front of a fort's guns (130 m). Flanks carry no guns in the game's
reckoning: they look along their own curtain.

James Fort is the one place this differs from the record. Strachey says its principal gate opened to the river, with a
gate at each bulwark too. Here the gate is in a landward curtain.

## What shape they take

A plan is parameters and the ground, not a stamp: a `star` (four or five bastions), a `headland` (a line drawn round
the point, stretched along it, bastions on its landward corners, stepping down to a lower terrace towards the water where
the record says), `fitted` (the same, not stretched), `islet` (round whatever land there is), `battery` (low, its
front following the shore, a straight wall behind) and `drum` (round, with a tower). The trace goes on the building as
`inst.trace`, and geometry, guns, garrison and fracture all read it. It is worked out once, when the port is laid out.

## The chart is smaller than the history

The terrain covers about 4 km either side of a port's position. Forts recorded beyond that (Belém at 7 km, São Julião
at 16 km, Boca Chica at 12 km) cannot stand in their true place. They stand on the same bank, as near as the chart goes,
at ground that sees the way out. Their labels keep their names and the survey marks them `moved`. Records further off
than 20 km are left out (Fort Algernon, Bertioga).

Havana's elevation data reads the harbour channel as low ground, which left the bay a lake. The record carries the
channel's line and the coast is opened along it.

## What a record does on a coast that is not real

If real elevation cannot be had, the coast is made up and a recorded position means nothing. The fort then keeps its
name, kind and job, and goes where the same job is on the made-up coast. The survey marks these `role`.

## Saved damage

A saved building's damage is matched by prefab and position within a metre. A fort that has moved no longer matches, so
its old record is ignored and the fort stands whole; nothing crashes. A fort at the same place with a different plan is
told apart by a plan key on the record. A town building keeps its damage only if it did not move, and many did, because
the town now builds round the forts.

## The survey

Each fort's fire is reckoned with the game's own gun definitions and its own line test, at marks along the way in and
off the town. A fort "with no fire on the approach" is usually a record's fort far along the shore from where the game's
town and ships are, or a citadel: those are the true position, not a fault of aim. `node scripts/fort-survey.mjs --table`
lists every fort; pass `--coasts` a folder from `scripts/harbour-coasts.mjs` for real coasts.

| Across 53 ports in 1550, 1600, 1650 and 1689 | Real coasts, before | after | Made-up coasts, before | after |
|---|---|---|---|---|
| Port years | 164 | 164 | 166 | 166 |
| Forts | 470 | 325 | 474 | 331 |
| Port years with none | 10 | 7 | 10 | 3 |
| Median distance to the mouth, where there is one (m) | 1289 | 824 | - | - |
| Median distance to the way in (m) | 464 | 481 | 485 | 565 |
| Median sea face off the water it guards | 99° | 9° | 97° | 7° |
| Sea faces more than 45° off | 360 | 42 | 352 | 19 |
| Gates opening on the water, away from the town | 64 | 2 | 79 | 0 |
| Median share of its guns with clear water before them | 40% | 90% | 40% | 100% |
| Median share of its fire reaching the approach | 34% | 46% | 37% | 68% |
| Forts with no fire on the approach at all | 11 | 32 | 2 | 0 |
| Median share of the approach a port holds | 51% | 55% | 48% | 52% |
| Forts reaching into a neighbour | 79 | 0 | 52 | 0 |
| Worst reach into a neighbour (m) | 5.5 | 0 | 5.85 | 0 |
| Port years with two piers overlapping | 14 | 0 | 13 | 0 |


## Records and sources

Positions marked *rough* were estimated from a description, so the fort goes to the best ground near there.

### havana

A narrow channel between the Morro promontory on the east and the La Punta point on the west, closed in 1630 by a heavy chain between the two castles; La Real Fuerza stood back inside the bay on the western waterfront.

- **Castillo de los Tres Reyes del Morro** (1589), 23.15046, -82.35666. Guards harbour entrance channel; chain boom to La Punta. Role mouth. Antonelli design perched on the promontory opposite old Havana; dominates the channel mouth (outline not described in sources I saw) Wikipedia gives 1589 as built/completed; the 1630 completion in the brief was not confirmed by any page I saw; Timeline of Havana lists 1640. Sources: https://en.wikipedia.org/wiki/Castillo_de_los_Tres_Reyes_Del_Morro https://en.wikipedia.org/wiki/Timeline_of_Havana
- **Castillo de San Salvador de la Punta** (1590), 23.14625, -82.35772. Guards harbour entrance, west side; chain to El Morro (copper chain 1630, branched boom 1762). Role mouth. Quadrilateral with four bastions per Digital Aponte; Wikipedia says it was cut down to a keep with 3 bastions by 1602 Works began c.1589-1590 under Antonelli, slow; hurricane damage 1595; Wikipedia floor area 3,247 m2 inside grounds of 23,102 m2. Sources: https://en.wikipedia.org/wiki/Castillo_San_Salvador_de_la_Punta http://aponte.hosting.nyu.edu/gallery-template-test
- **Castillo de la Real Fuerza** (1558), 23.14111, -82.34972. Guards inner harbour waterfront beside Plaza de Armas. Role waterfront. Roughly square, central body about 30 m a side with walls about 6 m thick and four triangular corner bastions Built after Sores sacked Havana in 1555; en.wikipedia says it sat too far inside the bay to be an effective bulwark, which is why Morro and La Punta followed. Sources: https://es.wikipedia.org/wiki/Castillo_de_la_Real_Fuerza_de_La_Habana https://en.wikipedia.org/wiki/Castillo_de_la_Real_Fuerza

### san-juan

The bay mouth lies between El Morro on the western tip of San Juan islet and the Cañuelo islet (Isla de Cabras) across the channel to the west; ships entering had to pass crossfire from both, and a chain was drawn across in 1595.

- **Castillo San Felipe del Morro** (1539), 18.4708, -66.1242. Guards entrance to San Juan Bay. Role mouth. Six-level stone fortress rising 43 m on the rocky headland, hornwork bastion fort by 1595 with a water battery at the foot Started 1539 as a tower with 4 embrasures plus a water battery; Tejeda and Antonelli drew the final plan in 1587; present form 1765-1787. Sources: http://en.wikipedia.org/wiki/El_Morro_Castle https://nps.gov/saju/learn/historyculture/timeline.htm
- **Fortin San Juan de la Cruz (El Canuelo)** (1608), 18.466389, -66.136389. Guards west side of the bay entrance, crossfire with El Morro. Role island. Square, about 24 m a side; wood fort 1608-1610, burned in 1625, rebuilt in stone 1660 (Wikipedia says stone work 1630-1660) NPS timeline says wood fort 1608-10, masonry 1660; Wikipedia says original wood fort late 1500s. Sources: https://en.wikipedia.org/wiki/Fort%C3%ADn_San_Juan_de_la_Cruz https://nps.gov/saju/learn/historyculture/timeline.htm
- **La Fortaleza** (1533), 18.46417, -66.11917. Guards inner harbour from the south side of the islet (NPS: gave no protection to the mouth). Role waterfront. Four stone walls round a patio with a circular Homage Tower NPS calls the placement poor: it covered the town from the bay but not the mouth, which is why El Morro was begun in 1539. Sources: https://en.wikipedia.org/wiki/La_Fortaleza https://nps.gov/saju/learn/historyculture/history.htm
- **Castillo San Cristobal** (1634), 18.46722, -66.11111. Guards land approach to the town from the east, with some sea fronts on the Atlantic coast. Role citadel. Bastion fort with outer ravelins, batteries, hornwork and dry moat plus tunnels; NPS says it was a small land fort in the 1650s and mainly the 1765-1790 work NPS: El Morro is for sea attack, San Cristobal for land attack; about 11 ha (27 acres). Sources: https://en.wikipedia.org/wiki/Castillo_San_Crist%C3%B3bal_(San_Juan) https://home.nps.gov/saju/learn/historyculture?mobile-app=true&theme=wiki

### cartagena

The bay had two mouths: Bocagrande to the north, shallow and the main way in during the 16th century, and Bocachica at the southern end of Tierrabomba, narrow and deep; a wrecked Portuguese ship silted Bocagrande shut in 1640, making Bocachica the only deep entrance until the channel reopened about a century later and a submerged wall (La Escollera, 1769-1786) closed it again.

- **Castillo de San Luis de Bocachica (rebuilt as San Fernando de Bocachica)** (1646), 10.319313, -75.581205. Guards Bocachica deep channel, southern entrance. Role mouth. Bastioned stone fort at the tip of Tierrabomba; San Luis (1646, Somovilla) was wrecked by Vernon in 1741 and San Fernando (Arévalo, 1753-1759) built on the same site Cartagena Explorer says San José was built on the opposite key with a floating chain between (1719-25 era); I did not give San José its own entry because of the 5-fort cap. Sources: https://en.wikipedia.org/wiki/Castle_of_San_Luis_de_Bocachica https://qualla.com/castle-of-san-luis-de-bocachica https://cartagenaexplorer.com/forts-bocachica-cartagena
- **Fuerte de San Matias (Punta Icacos)** (1567–1640), 10.3985, -75.56 *rough*. Guards Bocagrande entrance, south side of Bocagrande peninsula. Role mouth. Bastioned fort with 82 m sides according to multibeam survey of its foundations Sources conflict: Springer says built 1567 and dismantled 1626; UNESCO lists it in the initial 1586 system; a 1626 royal decree ordered San Matias and Santangel, so a rebuilt San Matias existed after 1626 until Bocagrande closed in 1640. Sources: https://link.springer.com/article/10.1007/s11457-023-09374-3 https://whc.unesco.org/en/list/285 https://fortificacionescartagena.com.co/en/destination/san-juan-del-manzanillo-2
- **Fuerte de San Sebastian del Pastelillo (on the site of El Boqueron)** (1586), 10.414088, -75.543736. Guards inner Bahia de las Animas, access to Manga island and the road to San Lazaro hill. Role narrows. Irregular base fitted to the land, walled with embrasures, three gun alignments, cistern and a dock Present fort built 1741-1744 by Mac Evan on the spot of the first Cartagena fort El Boqueron (tower of San Felipe del Boqueron, in the initial system of 1586 per UNESCO). Sources: https://en.wikipedia.org/wiki/San_Sebasti%C3%A1n_del_Pastelillo_Fort https://fortificacionescartagena.com/en/destination/san-sebastian-del-pastelillo-2 https://whc.unesco.org/en/list/285
- **Fuerte de Santa Cruz (Castillogrande)** (1626), 10.395, -75.5495 *rough*. Guards inner bay narrows, crossfire with San Juan de Manzanillo. Role narrows. Square base, bulwark at each of four corners, central parade and moat (Spanoqui plan) Ordered 1608, built 1626-36 by Roda and Murga; ordered dismantled 1647, ruined 1697 and partly 1741, vaults blown up 1938. Sources: https://fortificacionescartagena.com.co/en/destination/the-fortress-of-santa-cruz-or-castillogrande https://cartagena-indias.com/en/History/Colonization/fortification-process.html
- **Fuerte de San Juan de Manzanillo** (1631), 10.399, -75.5455 *rough*. Guards inner bay narrows, crossfire with Santa Cruz. Role narrows. Platform on Manzanillo island, later a store for artillery and ammunition; its ammunition store survives inside the Casa de Huespedes Ilustres Decree 1626, platform erected about 1631; rebuilt after 1697 and 1724 and again after 1741. Sources: https://fortificacionescartagena.com.co/en/destination/san-juan-del-manzanillo-2 https://cartagena-indias.com/en/History/Colonization/fortification-process.html

### santo-domingo

The town stood on the west bank of the Ozama at its mouth on the south coast; ships came up the river past the Fortaleza Ozama on the riverside and the Caribbean-facing Fuerte San Gil on the sea coast.

- **Fortaleza Ozama (Torre del Homenaje)** (1502), 18.47333, -69.88167. Guards mouth of the Ozama river and the south-east entry of the colonial city. Role river. Medieval-style coral-stone castle with an 18 m keep (walls 2 m thick) and 3 m outer walls, entrance gate added 1608 Wikipedia gives both 1502-1508 and 1505 for completion; oldest surviving European military structure in the Americas. Sources: https://en.wikipedia.org/wiki/Fortaleza_Ozama https://italianlegacyrden.academiadominicanahistoria.org.do/files/assets/basic-html/page-244.html
- **Fuerte San Gil** (1503), 18.4705, -69.8915 *rough*. Guards the beach below the Caribbean-facing city front. Role waterfront. Five-sided polygon with two fronts, said to be the first fort built in that shape, with one side facing the sea; now rebuilt from rubble Source dates it 1503-1510; a source that I could not corroborate, and it is a tourism page. Sources: https://visitdominicanrepublic.org/fuerte-san-gil-fortress-santo-domingo https://en.wikipedia.org/wiki/List_of_forts_in_colonial_Santo_Domingo

### veracruz

An open roadstead lee of coral reefs; ships anchored in the shelter of San Juan de Ulúa islet, which had the only authorised dock, so the islet fort was in effect the harbour mouth and the town lay on the mainland shore opposite.

- **Castillo de San Juan de Ulua** (1535), 19.20917, -96.13139. Guards the anchorage and only authorised dock of Veracruz. Role island. Irregular bastion on a coral reef islet; 1535 start was a mooring wall with a man-high tower, redesigned by Antonelli in the 1580s-90s, built to 1769 INAH: Philip II ordered work from 1590 on the Indies system; Hawkins and Drake were trapped in its lee in 1568. Sources: https://lugares.inah.gob.mx/en/node/4290 https://en.wikipedia.org/wiki/San_Juan_de_Ul%C3%BAa
- **Baluarte de Santiago (city wall)** (1635), 19.1905, -96.1325 *rough*. Guards south-east corner of the walled town beside the shore. Role waterfront. One of nine bastions of the wall; only survivor Wall mainly landward but the bastions stood at the waterfront; the wall was demolished in 1880. Sources: http://en.wikipedia.org/wiki/Baluarte_de_Santiago https://lugares.inah.gob.mx/en/node/4836

### campeche

An open roadstead in the Bay of Campeche with shallows far out; the town stood on the shore behind a hexagonal wall begun after the sacks of 1633 and 1663 and the 1685 de Graaf attack.

- **Baluarte de San Carlos (earlier fort San Benito)** (1610), 19.8425, -90.5385 *rough*. Guards the shore road and roadstead. Role waterfront. Pentagonal bastion of the hexagon; first formal defence was San Benito, ordered 1610 by governor Carlos de Luna y Arellano INAH says the 1610 defence was demolished in 1703 and replaced; the present bastion is from 1686-1704 wall. Sources: https://lugares.inah.gob.mx/en/node/4832 https://casonasmx.com/en/blog/campeche-city-walls
- **Baluarte de la Soledad (beside the Sea Gate)** (1686), 19.8475, -90.5365 *rough*. Guards the Sea Gate and waterfront. Role waterfront. Pentagonal bastion supporting the Sea Gate in the wall begun 3 Jan 1686 Wall started 1686, hexagon closed by Jaime Franck with the Santiago bastion in 1704; sea side was opened up by demolitions from 1893. Sources: https://casonasmx.com/en/blog/campeche-city-walls
- **Baluarte de Santiago** (1686), 19.8495, -90.5385 *rough*. Guards north-west corner of the walled town. Role waterfront. Pentagonal bastion; the last piece of the wall, closing the hexagon in October 1704 Whether it faced the water is not stated in the sources. Sources: https://casonasmx.com/en/blog/campeche-city-walls

### santa-marta

A small bay whose mouth lies between El Morro island and a lesser islet (El Morrito); Betin point and the Morro island fort covered the bay mouth, while earlier forts stood on the beach in front of the town.

- **Fuerte de San Juan de las Matas** (1602), 11.2415, -74.2125 *rough*. Guards town beach. Role waterfront. Fort on the beach; sheltered the city for over thirty years Academia de Historia del Magdalena: location only stated as on the beach. Sources: https://www.academiadehistoriadelmagdalena.org/wp-content/uploads/2021/01/LAS-FORTIFICACIONES-DE-LA-CIUDAD-DE-SANTA-MARTA.pdf
- **Fuerte de San Vicente** (1644), 11.2445, -74.2125 *rough*. Guards town beach. Role waterfront. Beach fort a little north of San Juan de las Matas No later date for its end in the source. Sources: https://www.academiadehistoriadelmagdalena.org/wp-content/uploads/2021/01/LAS-FORTIFICACIONES-DE-LA-CIUDAD-DE-SANTA-MARTA.pdf https://visitsantamarta.com/en/blog/san-fernando-fort-santa-marta/74
- **Fuerte de Nuestra Senora de la Caridad (Betin)** (1663), 11.2535, -74.2215 *rough*. Guards bay mouth between El Morro and El Morrito. Role headland. Fort on the point where the Abras de Santa Ana ends Academia text: it defended access to the bay between El Morro and El Morrito. Sources: https://www.academiadehistoriadelmagdalena.org/wp-content/uploads/2021/01/LAS-FORTIFICACIONES-DE-LA-CIUDAD-DE-SANTA-MARTA.pdf
- **Fuerte de la isla del Morro** (1739), 11.247, -74.2195 *rough*. Guards mouth of the port. Role island. Fort on the Morro islet; works dated 1739, 1762, 1778 The Academia text calls it the fort at the mouth of the port between El Morro and El Morrito. Sources: https://www.academiadehistoriadelmagdalena.org/wp-content/uploads/2021/01/LAS-FORTIFICACIONES-DE-LA-CIUDAD-DE-SANTA-MARTA.pdf https://visitsantamarta.com/en/blog/san-fernando-fort-santa-marta/74
- **Fuerte de San Fernando** (1725), 11.2315, -74.2065 *rough*. Guards south side of the bay against landings. Role headland. Battery on Pedrera hill on the Boca del Cerro, closing the south of the bay Now inside army facilities; the Malokal page calls it a battery to block corsairs from the north. Sources: https://visitsantamarta.com/en/blog/san-fernando-fort-santa-marta/74 https://malokal.com/en/colombia/santa-marta/a/el-fuerte-de-san-fernando-y-la-boca-del-cerro-the-fortress-nobody-visits-and-that-defended-santa-marta-from-pirates-and

### cumana

An open roadstead on the Gulf of Cariaco at the mouth of the Manzanares river; the castles stood on hills and the shore above the town.

- **Castillo de San Antonio de la Eminencia** (1659), 10.46214, -64.17161. Guards the town and gulf from the hill (1668 memo called it too far from the coast). Role citadel. Four-pointed star on coral stone (project changed from a quadrilateral in 1682) Fandom and museuexea differ: built 1659-1686 or c.1687. Sources: https://museuexea.org/en/fortificacoes/castillo-de-san-antonio-de-la-eminencia https://military-history.fandom.com/wiki/San_Antonio_de_la_Eminencia_castle
- **Castillo de Santa Maria de la Cabeza** (1668), 10.4611, -64.1742. Guards the town and shore, built to replace San Antonio as unfit. Role waterfront. Square trace italienne with corner bastions; walls vertical below and inclined above Started without authorisation by governor Angulo y Sandoval; 1684 quake damaged it. Sources: https://en.wikipedia.org/wiki/Santa_Mar%C3%ADa_de_la_Cabeza_castle

### coro

No record of a coastal fort was found. La Vela is an open roadstead on a low sandy coast; I found no source naming a coastal fort at Coro or La Vela in 1492-1750 (UNESCO and Wikipedia pages on Coro and La Vela were silent). Goes by the rule.

### panama-viejo

Panama Viejo stood on a tidal beach with large tide range, ships lying off among the islands; sources describe no fort at Panama Viejo and say the city trusted the isthmus crossing and San Lorenzo; after 1671 the city moved to the Casco Viejo peninsula, about 8 km west of the port point.


### nombre-de-dios

An open roadstead; Nombre de Dios was burned by Drake in 1596, and Ward found the ruins of one small late-16th-century fortification on the ground.

- **Fortificacion de Nombre de Dios (small late-16th-century fort)** (1570–1597), 9.579, -79.476 *rough*. Guards the roadstead and town shore. Role waterfront. Not described; Ward located its remains while exploring Nombre de Dios Year is only 'late sixteenth century' in the author's own preface; material is a guess. Sources: https://dn790004.ca.archive.org/0/items/imperialpanamaco00ward_0/imperialpanamaco00ward_0.pdf

### portobelo

A deep bay opening to the north, with the town on the north shore of its inner side; the entrance was held by San Felipe de Todofierro on the northern point and Santiago de la Gloria on the western part, with San Jeronimo guarding the town waterfront on the east.

- **Fortaleza de San Felipe de Todofierro** (1597–1739), 9.5645, -79.6525 *rough*. Guards bay entrance, north point. Role mouth. Medieval in appearance, one of the oldest; 35 cannons per Wikipedia (as San Felipe) Captured and dismantled by Vernon in 1739; its stone went into the San Fernando batteries. Sources: https://revistapanorama.com/en/defending-portobelo https://en.wikipedia.org/wiki/Fortifications_on_the_Caribbean_Side_of_Panama:_Portobelo-San_Lorenzo
- **Castillo de Santiago de la Gloria** (1600), 9.5585, -79.6595 *rough*. Guards bay entrance, west side. Role mouth. Original Antonelli fort called El Penon; rebuilt in 1753 with two rows of guns, powder store and barracks Revista Panorama gives 'early 17th century'; Wikipedia says Antonelli's 1597 plan; from=1600 is a placeholder midpoint. Sources: https://revistapanorama.com/en/defending-portobelo https://en.wikipedia.org/wiki/Fortifications_on_the_Caribbean_Side_of_Panama:_Portobelo-San_Lorenzo
- **Fuerte de San Jeronimo** (1601), 9.5545, -79.6535 *rough*. Guards town waterfront inside the bay. Role waterfront. First on an islet in 1601, bastion on landfill 1620, fort 1658-1663; 1753 embankment joined it to the mainland Prompted by Parker's 1601 capture of widely separated San Felipe and Santiago. Sources: https://revistapanorama.com/en/defending-portobelo
- **Fuerte Farnesio (Farnese)** (1726), 9.5565, -79.6605 *rough*. Guards bay entrance approach, west. Role headland. Temporary fort of 1726; ruins survive Revista Panorama describes it as temporary. Sources: https://revistapanorama.com/en/defending-portobelo

### acapulco

A deep, nearly landlocked bay entered past the Roqueta island; the fort stood on a hill above the town's waterfront.

- **Fuerte de San Diego** (1616), 16.85, -99.902389. Guards town waterfront and Manila galleon anchorage. Role waterfront. Irregular pentagon (first fort), five named bastions; rebuilt in 1778-1783 as a regular pentagon with moat after an earthquake Named for the saint of viceroy Guadalcazar; the 1783 fort replaced it, so it still existed as the same site in 1750. Sources: https://en.wikipedia.org/wiki/Fort_of_San_Diego https://lugares.inah.gob.mx/en/node/4271

### santiago-de-cuba

A long, narrow winding channel with rocky walls, in places under 200 yards wide, runs about 6 miles from the sea portal to the landlocked bay; the Morro stands on the east of the sea portal and the Socapa on the west. The Morro is about 10 km southwest of the city, outside the +/-4 km terrain.

- **Castillo de San Pedro de la Roca (El Morro)** (1590), 19.96871, -75.8703. Guards channel mouth to Santiago bay. Role mouth. Terraced on the steep promontory: four main levels and three large bulwarks (Antonelli design adapted to the site) Ravelin and battery 1590-1610; citadel begun 1638; sacked by pirates 1662, rebuilt 1663-69 and after the quakes 1693-95. Sources: https://en.wikipedia.org/wiki/Castillo_de_San_Pedro_de_la_Roca https://britannica11.org/article/24-0206-s2/santiago_de_cuba https://whc.unesco.org/document/154418

### trujillo

An open bay on the north coast of Honduras; the fort stood on a bluff above the town overlooking the bay.

- **Fortaleza de Santa Barbara** (1575), 15.9185, -85.9535 *rough*. Guards the bay and the town landing. Role headland. Small hilltop fort; 4 guns shipped and a bulwark ordered 1575, designed 1586, finished 1629 with 6 guns (14 guns later) Wikipedia on the town dates the fort to c.1550; ruta504 says 1575-1629; it was judged inadequate against pirates. Sources: https://en.wikipedia.org/wiki/Santa_B%C3%A1rbara_fortress https://web.archive.org/web/20100929061339/http:/www.ruta504.com/es/trujillo/la-fortaleza-de-santa-barbara https://en.wikipedia.org/wiki/Trujillo%2C_Honduras

### callao

A wide open bay sheltered by the island of San Lorenzo and the La Punta spit; no fortress stood at Callao until a wall (1640-1647) for the landward side and after 1746 the Real Felipe.

- **Fortaleza del Real Felipe** (1747), -12.06278, -77.14917. Guards the port after the 1746 earthquake and tsunami. Role waterfront. Large bastioned fortress of about 70,000 m2; phases 1747-1774 and 1776-1811 The 1640-47 Callao wall (ten bastions, San Miguel to San Lorenzo) faced the land and was mostly destroyed in 1746. Sources: https://en.wikipedia.org/wiki/Real_Felipe_Fortress https://built-heritage.springeropen.com/articles/10.1186/s43238-023-00101-4

### salvador-da-bahia

A wide bay (Todos os Santos) entered between Santo Antonio da Barra on the southern headland and Itaparica island; the town on the eastern shore was fronted by the sandbank Forte do Mar.

- **Forte de Santo Antonio da Barra** (1583), -13.010278, -38.532778. Guards bay entrance at Ponta do Padrao. Role mouth. Octagon at first, later a star-shaped polygon (Esteves) 1501 first earthwork possible; substantive fort 1583-87, stone 1591-1602, star plan around 1702. Sources: https://en.wikipedia.org/wiki/Forte_de_Santo_Ant%C3%B4nio_da_Barra https://bahia.ws/en/fortes-farois-salvador-bahia
- **Forte de Santa Maria** (1614), -13.0085, -38.5295 *rough*. Guards Porto da Barra cove. Role headland. Small Italian-style fort rebuilt in masonry in 1696 (Esteve) Colonial Voyage says built during governor Diogo Luis de Oliveira (1627-35); bahia.ws says begun c.1614. Sources: https://bahia.ws/en/fortes-farois-salvador-bahia https://colonialvoyage.com/forts-salvador-bahia
- **Forte de Sao Marcelo (Forte do Mar)** (1600), -12.9737, -38.5164 *rough*. Guards the harbour anchorage opposite the historic centre. Role island. Circular Renaissance-style fort on a sandbank about 300 m off the shore bahia.ws says only early 17th century and rebuilt in masonry after the Dutch invasion; 1600 is a placeholder. Sources: https://bahia.ws/en/fortes-farois-salvador-bahia https://bahia.ws/en/history-of-the-forts-and-lighthouses-of-salvador
- **Forte de Sao Diogo** (1609), -12.9885, -38.5265 *rough*. Guards south shore of the bay approach to the town. Role waterfront. Begun 1609-1613, rebuilt 1626-1635 after the invasions Plan not described in the page I saw. Sources: https://bahia.ws/en/fortes-farois-salvador-bahia
- **Forte de Nossa Senhora de Monte Serrat** (1580), -12.9245, -38.5035 *rough*. Guards north approach, Itapagipe point. Role headland. Bastioned fort extended through the 18th century bahia.ws says only 'late 16th century'; 1580 is a placeholder. It lies several km north of the port point. Sources: https://bahia.ws/en/fortes-farois-salvador-bahia

### sao-vicente

Santos bay is reached by the Barra de Santos channel between Santo Amaro (Guaruja) island and the mainland; a second, northern way in is the Bertioga channel, which both Bertioga forts closed.

- **Fortaleza de Santo Amaro da Barra Grande** (1580), -24.0125, -46.372 *rough*. Guards the Barra de Santos entrance and the Casqueiro channel up to the town. Role mouth. Ruined stone fort with walls and watchtowers, started around 1580 and ruined HPIP: begun around 1580 to protect the Casqueiro channel; later date for completion not seen. Sources: https://hpip.org/en/heritage/details/1258

### olinda

Recife harbour lies behind a natural reef with a gap; the entrance was covered by a fort at the reef mouth (Picao), with Brum on the isthmus and Cinco Pontas on Antonio Vaz island, while Olinda stood on its hill north.

- **Forte do Picao (reef entrance)** (1630), -8.0543, -34.872 *rough*. Guards the gap through the reef into Recife harbour. Role mouth. Fort at the harbour reef mouth; in the first Dutch defensive system The abant paper lists Forte do Picao 'na entrada da barra' in the first Dutch system; no year stated, 1630 marks Dutch arrival. Sources: https://anais.abant.org.br/26rba/mesas_redondas/trabalhos/MR%2023/gabriela%20martin%20avila.pdf https://hpip.org/en/heritage/details/1097
- **Forte do Brum (Fort de Bruyne)** (1629), -8.0625, -34.8727 *rough*. Guards the Recife isthmus and harbour entrance. Role headland. Land fort at the northern end of the island, begun by the Portuguese 1629, rebuilt by the Dutch, clad in stone by the Portuguese in 1680 Colonial Voyage and HPIP agree on 1629 start and 1680 stone. Sources: https://colonialvoyage.com/recife-forts https://hpip.org/en/heritage/details/1097
- **Forte das Cinco Pontas** (1630), -8.0645, -34.8767 *rough*. Guards inner harbour on Antonio Vaz island. Role waterfront. Dutch earth and fascine fort, rebuilt by the Portuguese in 1680 with four stone bastions Schans Frederik Hendrik; laid out by Comersteinj. Sources: https://hpip.org/en/heritage/details/1097 https://colonialvoyage.com/recife-forts

### st-augustine

The harbour lay behind a barrier island; the Castillo faced Matanzas Bay (the lagoon) from the west bank, guarding the harbour entrance and the north land approach, with a rear way via the Matanzas inlet watched by Fort Matanzas from 1740.

- **Castillo de San Marcos** (1672), 29.89778, -81.31139. Guards Matanzas Bay, the harbour entrance and the north land approach. Role waterfront. Star-shaped coquina fort, 300 ft per side with walls 16-18 ft thick at the base, moat and ravelin Replaced nine successive wooden forts; Ruiz de Olano rebuilt the interior from 1738. Sources: https://en.wikipedia.org/wiki/Castillo_de_San_Marcos https://museumoffloridahistory.com/explore/exhibits/permanent-exhibits/la-florida/forever-changed-phase-2/the-first-spanish-period/fortifications-in-st-augustine https://npshistory.com/publications/casa
- **Wooden forts of St. Augustine (nine successive)** (1565–1672), 29.8975, -81.313 *rough*. Guards harbour and Matanzas Bay shore. Role waterfront. Timber and earth forts, rebuilt repeatedly Museum of Florida History says a succession of nine wooden forts followed the 1586 attack. Sources: https://npshistory.com/publications/casa https://en.wikipedia.org/wiki/Castillo_de_San_Marcos
- **Fort Matanzas** (1740), 29.71528, -81.23917. Guards Matanzas Inlet, the southern rear entrance to St. Augustine. Role river. Coquina tower fort 15 m (50 ft) on a side with a 9 m tower on pine pilings, on Rattlesnake Island About 20 km south of the port point, outside the terrain. Sources: https://en.wikipedia.org/wiki/Fort_Matanzas_National_Monument

### rio-de-janeiro

Guanabara Bay's entrance is about a mile wide, flanked on the east by Santa Cruz fortress and on the west by Sao Joao fortress under Sugar Loaf, with the islet fort of Laje in the middle.

- **Fortaleza de Santa Cruz da Barra** (1555), -22.951111, -43.113611. Guards east side of the bay entrance. Role mouth. Fort on the rocky outcrop at the entrance (outline not described in sources I saw) Library of Congress: built by the French 1555, taken by the Portuguese 1567; the Portuguese rebuilt it later. Sources: https://loc.gov/item/2021668333 https://en.wikipedia.org/wiki/Fortaleza_de_Santa_Cruz_da_Barra
- **Fortaleza de Sao Joao da Barra** (1565), -22.943372, -43.156458. Guards west side of the bay entrance, foot of Sugar Loaf. Role mouth. Star fort; enlarged in 1618 to four batteries (Sao Jose, Sao Martinho, Sao Teodosio, Sao Diogo) Founded 1565 by Estacio de Sa. Sources: https://en.wikipedia.org/wiki/Fortress_of_S%C3%A3o_Jo%C3%A3o_(Rio_de_Janeiro) https://wikiwand.com/en/Fortaleza_de_S%C3%A3o_Jo%C3%A3o_(Rio_de_Janeiro)
- **Forte da Laje** (1644), -22.9475, -43.1335 *rough*. Guards the middle of the bay entrance. Role island. Fort on a rock in the middle of the entrance An Instagram caption says the Portuguese began it in 1644 and works ended around 1711; weak source. Britannica confirms the island-fort of Laje exists. Sources: https://instagram.com/reel/DcHQYgSvhhf https://britannica.com/print/article/247734
- **Fort Coligny (Villegagnon island)** (1555–1560), -22.9125, -43.1658 *rough*. Guards inner bay approach to the French settlement. Role island. French colonist fort on the small rocky island Serigipe Fell and was destroyed on 17 March 1560. Sources: https://kiwix.enszfarms.org/content/wikipedia_en_all_maxi_2025-08/Fort_Coligny

### st-kitts

Basseterre stood on an open roadstead on the south coast with a chain of waterfront forts from Bluff Point in the west to Bird Rock in the east.

- **Fort Thomas (Bluff Point)** (1666), 17.2935, -62.7345 *rough*. Guards whole bay front of the town, 53 ft above sea level, facing the sea. Role headland. Elevated fort at Fortlands Page gives no date. Sources: https://historicstkitts.kn/items-of-interest/forts-in-basseterre
- **Fort Londonderry** (1666), 17.2955, -62.7235 *rough*. Guards central bay front. Role waterfront. Low waterfront fort, some walls and magazine remain; on the site of the first French fort on the island Page gives no date. Sources: https://historicstkitts.kn/items-of-interest/forts-in-basseterre
- **Fort Smith (Bird Rock)** (1666), 17.2965, -62.7125 *rough*. Guards east end of the bay front. Role headland. Upper and lower fort with a wall with gun ports facing the sea and a powder magazine The landmark inventory says allegedly built by the French; 18th-century pottery found. Sources: http://irf.org/wp-content/uploads/2015/10/InventoryHistoricalLandmarks_SKN.pdf https://historicstkitts.kn/items-of-interest/forts-in-basseterre

### tortuga

The buccaneer town of Cayona lay on the south coast of Tortuga facing the Haiti channel, guarded by one fort on a rock above the harbour.

- **Fort de Rocher (Fort de la Roche, Dovecote)** (1640–1654), 20.0125, -72.792 *rough*. Guards harbour of Basse Terre / Cayona on the south-east side. Role headland. Two redans facing the coast with terraces and breastworks round a 30 ft rock bearing the reduit called Dovecote; 24 guns Built about 1640 by Le Vasseur; the Spanish took and razed it in 1654. Sources: https://en.wikipedia.org/wiki/Fort_de_Rocher https://goldenageofpiracy.org/locations/tortuga/fort-de-rocher

### bridgetown

Carlisle Bay is a wide open roadstead on the south-west of Barbados, with Needham's Point guarding the south-west horn and a mole running out from James Fort in the town front.

- **Needham's Fort (Charles Fort)** (1650), 13.0789, -59.6127. Guards south-west side of Carlisle Bay. Role headland. Coastal fort at Needham's Point; renamed Charles Fort in 1660 with 36 cannon; stone rebuild in the early 18th century with fascine batteries in the 1740s Another source says rebuilt 1811 in the current form. The town front fort James Fort and its mole are mentioned by FamilySearch with no date. Sources: https://en.wikipedia.org/wiki/Charles_Fort_(Barbados) https://web.archive.org/web/20110707205009/http:/www.bajanworldheritage.com/history https://familysearch.org/en/wiki/Bridgetown,_Barbados

### curacao

St. Anna Bay is a narrow channel on the south coast with the Punda side on the east, where Fort Amsterdam stood at the mouth; Waterfort and Riffort are 19th-century.

- **Fort Amsterdam** (1634), 12.1047, -68.9345. Guards mouth of St. Anna Bay, Punda side. Role mouth. Planned with five bastions, four built; 3 m thick walls Waterfort was built 1826-30 and made Fort Amsterdam obsolete as a defence. Sources: https://en.wikipedia.org/wiki/Fort_Amsterdam_(Cura%C3%A7ao) https://news.curacao.com/en-us/forts

### fort-royal-martinique

Fort Saint-Louis stands on a rocky peninsula at the edge of the Cul-de-Sac Royal bay (Baie des Flamands), covering the Carenage anchorage where ships were hauled up.

- **Fort Saint-Louis (Fort-Royal)** (1638), 14.5999, -61.0664. Guards the Carenage anchorage and Cul-de-Sac Royal. Role headland. Began about 1640 as a wooden palisade; rebuilt from 1669 on a Vauban design with a 487 m wall round the peninsula, 4 m high and 2 m thick (built under Blenac from 1677) Wikipedia and HAL differ on the first date (1638 vs about 1640). Sources: https://en.wikipedia.org/wiki/Fort_Saint_Louis_(Martinique) https://shs.hal.science/halshs-01148391/document

### port-royal

Port Royal stood at the tip of the Palisadoes sand spit closing Kingston Harbour; the town front was ringed by forts and Morgan's Line, with Fort Charles at the south-west tip.

- **Fort Charles (Cagway)** (1655), 17.935048, -76.842475. Guards entrance to Kingston Harbour at the tip of the spit. Role mouth. Began as a rectangle round a central round stone tower; by 1664-67 had demi-bastions and a redan; 1687 described as an octagon with flanked sides; up to 104 guns Christened Fort Charles in 1662; ship-like asymmetric outline per Wikipedia; badly damaged by the 1692 earthquake and repaired. Sources: https://en.wikipedia.org/wiki/Fort_Charles_(Jamaica) https://portroyaljamaicahistory.com/forts/
- **Fort James** (1673), 17.9345, -76.8375 *rough*. Guards eastern sea front of Port Royal. Role waterfront. Gun platforms completed by August 1673 INA newsletter places it at Bonham's Point; portroyaljamaicahistory gives no location. Sources: https://portroyaljamaicahistory.com/forts/ https://nauticalarch.org/wp-content/uploads/2015/12/INAQ1987-14-12.pdf
- **Fort Rupert (the sea fort)** (1678–1692), 17.9345, -76.8285 *rough*. Guards the sea front east of Port Royal. Role waterfront. Joined to Fort Charles by Morgan's Line JNHT: destroyed in the 1692 earthquake; replaced by Fort William in 1701. Sources: http://jnht.com/site_port_royal_forts.php https://portroyaljamaicahistory.com/forts/
- **Fort Walker** (1680), 17.9365, -76.8425 *rough*. Guards north sea front of Port Royal. Role waterfront. 18 guns; the last of the forts before 1692 Late 1680s per the history site, 1680 per its heading; named after the commander of Fort Charles. Sources: https://portroyaljamaicahistory.com/forts/ http://jnht.com/site_port_royal_forts.php
- **Fort Carlisle** (1678), 17.9385, -76.8315 *rough*. Guards the Palisadoes spit. Role waterfront. Battery on the Palisadoes The INA newsletter places it at the north end of the Palisadoes. Sources: https://nauticalarch.org/wp-content/uploads/2015/12/INAQ1987-14-12.pdf https://portroyaljamaicahistory.com/forts/

### nassau

Nassau harbour lies between New Providence and Hog (Paradise) island with the east entrance watched by Fort Montagu and the town front by Fort Nassau.

- **Fort Nassau** (1697–1703), 25.0775, -77.352 *rough*. Guards Nassau waterfront. Role waterfront. 22 cannon, with a well in the south-west bastion; partly levelled 1700, destroyed 1703-04 and rebuilt in the 1740s Act of 1695 ordered a fort, built two years later; the 1740s rebuild gave 54 cannon and 26 mortars. Sources: https://bahamas.gov.bs/fort-nassau https://bahamas.gov.bs/forts
- **Fort Montagu** (1741), 25.0817, -77.3176 *rough*. Guards eastern entrance to the harbour. Role mouth. Stone fort by Peter Henry Bruce, who arrived in Nassau in April 1741; a fort at the site was begun as early as 1728 Name is for the Duke of Montagu. Sources: https://westindiacommittee.org/historyheritageculture/wp-content/uploads/2021/12/Historical-Memorandum-relating-to-Fort-in-New-Providence.pdf https://en.wikipedia.org/wiki/Fort_Montagu

### cap-francois

Large vessels entered the bay of Le Cap only between Picolet Point and the Grand Mouton reefs; Fort Picolet stood on the rocky promontory on the western side of the entrance.

- **Fort Picolet** (1736), 19.7767, -72.2155 *rough*. Guards the passage into the bay of Le Cap. Role mouth. Two superimposed batteries, a covered walk and a wall along the coast on a rocky cliff French wiki says 1739, Haiti Observer says begun 1736 and finished 1741 under Larnage. Sources: https://fr.wikipedia.org/wiki/Cap-Ha%C3%AFtien http://haitiobserver.com/blog/the-ruins-of-fort-picolet-near-cap-haitian.html https://petitfute.co.uk/v46892-cap-haitien/c1173-visites-points-d-interet/c937-monuments/c945-militaire/171815-fortifications-du-cap.html

### saba

No record of a coastal fort was found. Saba has no harbour, only open anchorages such as Fort Bay and Wells Bay; the only fort mentioned is a map-attested one near Fort Bay that was confirmed absent in 1773. Goes by the rule.

### lisbon

The Tagus narrows between the Bugio sandbank/São Julião (north) and Caparica (south) at the bar, then runs about 14 km east past Belém to Lisbon; ships crossed the bar and were covered by crossfire from São Julião and Bugio, with Belém and Caparica as the last line.

- **Torre de São Vicente de Belém** (1514), 38.69167, -9.21611. Guards Tagus below Lisbon. Role river. about 30 m high quadrangular tower on an irregular hexagonal bulwark base about 40 m long, with a casemated gun battery facing south onto the Tagus; built on a rock outcrop in the river off the old Belém beach Stands about 7 km west of the port point, outside a +/-4 km terrain window; en.wikipedia gives completion 1519, pt.wikipedia 1520; replaced an anchored armed nau. Sources: https://pt.wikipedia.org/wiki/Torre_de_Bel%C3%A9m https://en.wikipedia.org/wiki/Tower_of_Saint_Vincent
- **Forte de São Julião da Barra** (1553), 38.6795, -9.325 *rough*. Guards north side of the Tagus bar. Role mouth. original design with five bastions, three towards the sea and two landward (modelled on the Fortezza da Basso); low sea-side bastions and terrace added under Spain, land bastions and moat enlarged after 1640; bastions added on east side 1582, more work from 1597 About 19 km west of the port point; the strongest fort of the Tagus, commanding the bar in crossfire with Bugio. Sources: https://en.wikipedia.org/wiki/Fort%20of%20S%C3%A3o%20Juli%C3%A3o%20da%20Barra https://hap.pt/en/content/fortaleza-de-sao-juliao-da-barra
- **Forte de São Lourenço do Bugio (Torre da Cabeça Seca)** (1590), 38.66028, -9.29861. Guards Tagus bar, middle of the estuary mouth. Role island. perfectly circular: outer sloping wall 62 m diameter and 6 m high, inner wall 33 m diameter and 7 m high, central tower 3 m diameter and 16 m high; on the Cabeça Seca sandbank An earlier timber structure of 1570 failed on the shifting sand; Casale's circular design chosen over a star; foundations only done 1601, finished 1657. Sources: https://en.wikipedia.org/wiki/Fort_of_S%C3%A3o_Louren%C3%A7o_do_Bugio
- **Torre Velha de São Sebastião da Caparica** (1481), 38.67618, -9.20969. Guards south shore of the Tagus narrows opposite Belém. Role narrows. U-shaped plan of three bodies, two oriented south, with a rounded block between serving as the battery esplanade; on a hill between the Porto Brandão and Paulina creeks Part of João II's three-tower plan (Caparica, Cascais, later Belém); a battery here dates back to João I; also called Torre Velha. Sources: https://pt.wikipedia.org/wiki/Forte_de_S%C3%A3o_Sebasti%C3%A3o_da_Caparica https://en.wikipedia.org/wiki/Forte_de_S%C3%A3o_Sebasti%C3%A3o_da_Caparica
- **Castelo de São Jorge** (1492), 38.71389, -9.13361. Guards hilltop over the city; no direct water defence. Role citadel. medieval hill castle with eleven towers; royal palace (Alcáçova) abandoned for the Ribeira Palace in the early 16th century and damaged by earthquakes 1531, 1551, 1597, 1699 Pre-existing medieval castle, listed as asked; mainly a landward strongpoint and view post, not a harbour fort. 'from' is a placeholder for already standing in 1492. Sources: https://pt.wikipedia.org/wiki/Castelo_de_S%C3%A3o_Jorge https://en.wikipedia.org/wiki/Castelo_S%C3%A3o_Jorge

### jamestown

Jamestown sits on the north bank of the tidal James River; ships came up from Hampton Roads and Point Comfort and anchored in the deep channel just off the island's river shore, the fort's south side.

- **James Fort** (1607), 37.2092, -76.7787 *rough*. Guards James River reach at Jamestown. Role river. triangle with a half-moon bulwark at each corner; river (south) side 140 yards, east and west sides 100 yards each (Strachey, matched by excavation, measured to the projected intersections); palisade of upright oak/poplar about 14 ft high; about 1 acre; extended east to five sides by 1609; the principal gate opened to the river and each bulwark had a gate with a demiculverin River side faced south; Strachey says the principal gate from the town opens to the river; 24 guns by 1609; 1625 is a loose end date from a fort listing marked with a question mark. Sources: https://historicjamestowne.org/visit/plan-your-visit/fort-site https://historicjamestowne.org/archaeology/map-of-discoveries/palisades https://dailypress.com/2003/08/27/forts-footprint-found https://northamericanforts.com/East/vajames.html
- **Jamestown Turf Fort (1665-67 earthwork)** (1665–1680), 37.2088, -76.7749 *rough*. Guards James River at Jamestown, against Dutch raids. Role river. earthen fort with four bastions on the waterfront, with a ditch; built by Berkeley's order from September 1665, filled with earth by labour of James City and Surry counties Abandoned about 1680; a second small fort (abandoned by 1716) is also mentioned; no brick fort at Jamestown was found in the sources. Sources: https://orb.binghamton.edu/cgi/viewcontent.cgi?article=1160&context=neha https://northamericanforts.com/East/vajames.html

### new-amsterdam

Ships came north through the Narrows into the Upper Bay and rounded the southern tip of Manhattan, where Fort Amsterdam stood at the junction of the Hudson (North) and East rivers; seaward lay roughly south through the Narrows (bearing computed from the Narrows at about 40.60 N).

- **Fort Amsterdam** (1625), 40.704, -74.014 *rough*. Guards Upper Bay, mouth of the Hudson and East rivers. Role headland. four-sided fort with a bastion at each corner, hard-packed earth and rubble; stone facing planned but never done at first; designed by Cryn Fredericksz; the grander 1625 Company plan was a five-sided fort inside a ditch, dropped; stone strengthened in places under Twiller and completed 1635 Built at the south tip of Manhattan to command ships going up the Hudson; the shore then lay where Bowling Green/State Street run, so the harbor lapped close to the fort; it lasted as Fort James/George to 1790. Sources: https://en.wikipedia.org/wiki/Fort_Amsterdam_(New_Amsterdam) https://gothamcenter.org/blog/notes-on-the-planned-town-of-fort-amsterdam https://nycgovparks.org/parks/battery-park/monuments/1092
- **The Battery (1693 gun platform)** (1693), 40.7035, -74.0172 *rough*. Guards Upper Bay at Manhattan's tip. Role waterfront. ninety-two cannon installed at the southern tip of Manhattan in 1693; no plan seen No source seen for a 'Half Moon battery' at New Amsterdam; the record found is the 1693 Battery that gave the park its name. Sources: https://hmdb.org/m.asp?m=134183 https://thebattery.org/history

### boston

Boston lay at the head of an island-filled bay; ships came in from the east past Nantasket Roads and the harbour islands, with the Castle on Castle Island guarding the channel into the inner harbour.

- **The Castle (Castle William) on Castle Island** (1634), 42.3375, -71.0106. Guards main ship channel into Boston inner harbour. Role island. 1634 mud-walled castle with oyster-shell lime masonry; 1644 rebuild of pine logs, stone and earth in a compound of 10 ft walls about 50 ft square with six sakers; burned 1673; rebuilt 1674 in stone as a four-bastion fort with a water battery (about 60 guns); Romer's expansion 1701-03 as Castle William, 20 cannon positions with brick walls by 1705; fifth bastion 1740 The 1644 compound dimension (50 ft square) is the only size given; later works were much larger. Island lies about 4 km south-east of the port point. Sources: https://en.wikipedia.org/wiki/Castle_Island_(Massachusetts) https://en.wikipedia.org/wiki/Castle_William
- **North Battery** (1646), 42.3665, -71.0505 *rough*. Guards mouth of the Charles River / north side of the town. Role waterfront. battery on Merry's Point at the foot of Copp's Hill; shape not given Marked today by Battery Wharf on Commercial Street. Sources: https://kellscraft.com/RamblesBoston/ramblesboston06.html https://archive.org/download/memorialhistoryo0001wins/memorialhistoryo0001wins.pdf
- **South Battery (the Sconce)** (1666), 42.3578, -71.051 *rough*. Guards sea entrance to the town at the foot of Fort Hill. Role waterfront. battery on a point jutting from the foot of Fort Hill, erected 1666 by Maj. Gen. John Leverett; shape not given The Barricado, a straight line across the flats before the town linking the batteries, was built in 1673. Sources: http://loc.gov/pictures/item/2005677919 https://kellscraft.com/RamblesBoston/ramblesboston06.html
- **Fort Hill fort** (1632), 42.3555, -71.0535 *rough*. Guards town and inner harbour from a hill about 100 ft high. Role citadel. first fort on the summit in the town's second year, replaced by a larger fort in which Andros took refuge in 1689; also called Fort Mary 'from' is the town's second year; the year is inferred, not stated. Sources: https://kellscraft.com/RamblesBoston/ramblesboston06.html https://pocketsights.com/tours/place/South-Battery-Rowe%27s-Wharf-and-Fort-Hill-90297:8625

### quebec

Quebec stands where the St Lawrence narrows below the Cap Diamant cliff; ships anchored in the river off the Lower Town beneath the cliff, so batteries on the water and the cliff-top forts commanded the passage.

- **Habitation de Québec** (1608), 46.8127, -71.2017 *rough*. Guards Lower Town landing under the cliff. Role waterfront. timber dwelling compound with a dry ditch 1.7-2.0 m deep Defence dated 1608-24 by the archaeology paper; replaced as the refuge by Fort Saint-Louis above. Sources: https://tandfonline.com/doi/full/10.1179/007942309X12457508844125 https://tandfonline.com/doi/full/10.1179/007942309X12457508844044
- **Fort Saint-Louis (cliff-top forts, 1620-1694)** (1620), 46.812, -71.2051 *rough*. Guards river below Cap Diamant. Role citadel. first fort a wooden palisade around a dwelling (1620); fourth fort Vauban-style work built by Frontenac 1691-94 Sequence of several forts of the same name on the cliff top; eight cannon of the 1691 battery were incorporated into the 1692 enceinte. Sources: https://tandfonline.com/doi/full/10.1179/007942309X12457508844044 https://doi.org/10.1179/007942309x12457508844125
- **Batterie Royale** (1691–1763), 46.81276, -71.202. Guards river and Lower Town anchorage. Role waterfront. platform for a cannon battery on Pointe-aux-Roches; a battery may have stood before 1685 Became a landing stage in 1763 (marker). Sources: https://hmdb.org/m.asp?m=81531 https://mapcarta.com/W392335696

### bermuda

St George's Harbour was entered through shallow eastern channels, later the man-made Town Cut; the larger Castle Harbour was entered from the Atlantic through Castle Roads, guarded by the Castle Islands forts.

- **Fort St Catherine** (1612), 32.39, -64.676. Guards northeast approach to St George's Harbour. Role headland. wooden fort 1612, replaced by stone fort 1614; rebuilt and enlarged in the 1820s Coordinates from the UNESCO table are rounded to 3 decimals. Sources: https://en.wikipedia.org/wiki/Fort_St_Catherine https://whc.unesco.org/document/164461
- **Gates Fort (Danvers Fort) at Town Cut** (1612), 32.3835, -64.661 *rough*. Guards Town Cut channel into St George's Harbour. Role narrows. small fort with keep overlooking the Town Cut; rebuilt 1790s with four guns Sources disagree: built about 1612 (bermuda-attractions) or shown on a 1626 map and so likely built shortly before; first called Danvers Fort; the Cut itself was dug later. Sources: https://bermuda-attractions.com/bermuda_00027b.htm https://royalgazette.com/other/lifestyle/article/20110203/gates-fort-a-link-with-bermudas-past
- **Paget Fort** (1612), 32.373, -64.658. Guards Castle Roads / eastern approach to St George's. Role island. fort on Paget Island; 1612 archaeological remains within the property Forts on Paget, Governor's, Charles and Castle islands began early in the 17th century and were repeatedly reconstructed. Sources: https://whc.unesco.org/document/164461 https://whc.unesco.org/document/217549
- **Smith's Fort** (1612), 32.371, -64.658. Guards Castle Roads / eastern approach to St George's. Role island. fort on Governor's Island Exact first year not seen; 1612 is the start of the early forts generally. Sources: https://whc.unesco.org/document/164461 https://whc.unesco.org/document/217549
- **King's Castle** (1612), 32.357, -64.69 *rough*. Guards Castle Roads, entrance to Castle Harbour. Role island. stone fort on Castle Island begun on Governor Moore's order; Charles Fort 1615 on Goat Island and Southampton Fort 1620 form the group Castle Harbour lies roughly 2-3 km south of St George's; the 17th-century Landward Fort on Castle Island survives. Sources: https://en.wikipedia.org/wiki/Castle_Islands_Fortifications,_Bermuda

### plymouth-colony

Plymouth Bay was shallow behind the Gurnet and Saquish; ships anchored off the town, which sat below Fort Hill (Burial Hill) overlooking the harbour.

- **Plymouth fort-meetinghouse on Fort (Burial) Hill** (1621), 41.9575, -70.662 *rough*. Guards the town and harbour from the hill. Role citadel. gun platform built soon after landing, replaced in 1622 by a large square timber-framed house with a flat plank roof carrying six cannon, with a church below, plus a palisade (De Rasieres 1627) Used as the meetinghouse until 1677; excavation (GPR) failed to find clear traces. Sources: https://historyofmassachusetts.org/burial-hill-plymouth https://plymoutharch.com/2015/05/new-thoughts-on-plymouth-colonys-fort-and-palisade

### charleston

Charles Town lies on the Cooper-Ashley peninsula; ships crossed the bar and came in past Sullivan's Island and James Island to anchor off the Cooper River front.

- **Granville Bastion** (1697), 32.77325, -79.92758. Guards Cooper River front at the southeast corner of the walled town. Role waterfront. brick bastion begun 1697 as the southeast corner of a planned two-acre four-bastion fort, later the corner of the walled town (62 acres) with Craven, Colleton, Carteret bastions and three redans along the river wall The walls were completed by 1711; the bastions and seawall are of handmade brick. Sources: https://hmdb.org/m.asp?m=19230 https://ccpl.org/charleston-time-machine/granville-bastion-and-unfinished-fort-1697 https://hmdb.org/m.asp?m=62552
- **Half Moon Battery** (1704–1768), 32.7742, -79.927 *rough*. Guards water entrance of the town at the foot of Broad Street. Role waterfront. semicircular brick work projecting into the river at the foot of Broad Street; upper walls demolished 1768, below-ground brick seawall survives in the Exchange basement 'from' follows the c. 1704 Crisp plan, which already shows it; build year not stated. Sources: https://walledcitytaskforce.org/educational-resources/time-line https://hmdb.org/m.asp?m=62552
- **Fort Johnson** (1708), 32.7523, -79.9005 *rough*. Guards harbour entrance, ships approaching Charles Town from the bar. Role headland. fort at Windmill Point on James Island ordered by the legislature in 1708; much enlarged 1759 The 'Johnson's Covered Half Moon' on the Crisp plan is a work in the town wall, not the James Island fort. Fort Johnson is about 4 km south-east of the port point. Sources: https://walledcitytaskforce.org/educational-resources/time-line https://battlefields.org/learn/articles/history-fort-johnson?ms=opp/ https://hmdb.org/m.asp?m=19230

### philadelphia

Philadelphia lies on the west bank of the Delaware well above the bay; ships came up the river and moored along the front, with forts below the city.

- **Association (Grand) Battery** (1747), 39.9385, -75.1425 *rough*. Guards Delaware River front south of the city. Role waterfront. twenty-seven-gun stone wall along the Southwark riverfront; paid by Franklin's lottery in King George's War Pennsylvania's largest early fortification. Sources: https://philadelphiaencyclopedia.org/essays/forts-and-fortifications https://en.wikipedia.org/wiki/Harbor_Defenses_of_the_Delaware
- **Society Hill Battery** (1747), 39.945, -75.1408 *rough*. Guards Delaware River front just upriver of Southwark. Role waterfront. smaller battery just upriver of the Association Battery Fort Mifflin (Fort Island, Mud Island) was begun in 1771, after the 1750 limit, so it is excluded. Sources: https://philadelphiaencyclopedia.org/essays/forts-and-fortifications http://en.wikipedia.org/wiki/Fort_Mifflin,_Pennsylvania

### cadiz-sanlucar

Sanlúcar stands on the left bank of the Guadalquivir estuary near its mouth; the river bar is crossed and ships go upriver to Seville.

- **Castillo de Santiago, Sanlúcar de Barrameda** (1477), 36.7818, -6.3538 *rough*. Guards town and mouth of the Guadalquivir. Role citadel. large fortress on the northeast corner of the ancient citadel at the escarpment edge, built by Duke Enrique of Medina Sidonia The port lat/lon (36.65, -6.32) is at the estuary mouth about 15 km south of the castle; no coastal fort at Bonanza found (only a chapel, shipping base); Cádiz forts are about 15 km south, outside the window. Sources: https://monumentalnet.org/monumento.php?r=CA-CAS-151 https://inspain.org/en/cadiz/sanlucar-de-barrameda/castle-of-santiago

### palos-huelva

The Tinto and Odiel rivers meet in a shared estuary at Huelva; ships crossed the bar at the estuary mouth between Punta Umbría and the Arenilla, then went up to Palos on the Tinto.

- **Castillo de Palos de la Frontera** (1322), 37.2297, -6.8935 *rough*. Guards Tinto river inlet and the port of Palos. Role river. late medieval fortress on a hilltop above the Palos port; little survives Stood when Columbus sailed in 1492. Sources: https://turismocondado.com/en/category/palos-en
- **Torre de la Arenilla** (1550), 37.213, -6.94 *rough*. Guards entrance of the Tinto-Odiel estuary. Role mouth. truncated-cone almenara tower, lower than its base diameter, of rubble, brick and ashlar, with a raised door and a cistern; spiral stair to the terrace 'from' is a guess (16th century): the page gave no year. The system was completed in the 17th century with the Estrella bastion, Puntal tower and the castles of Huelva and Palos. Sources: https://cromacultura.com/torre-de-la-arenilla-palos-de-la-frontera-huelva

### la-coruna

A Coruña's harbour is a bay behind a promontory, entered from the north-west; the town stands on a peninsula and ships anchored in the bay.

- **Castillo de San Antón** (1587), 43.3659, -8.3903 *rough*. Guards inner bay and anchorage. Role island. fortress on what was then a small islet with a hermitage of San Antón (and a lazaretto) Unfinished but effective in the English attack of 1589; became a prison in the 18th century. Sources: https://es.wikipedia.org/wiki/Castillo_de_San_Ant%C3%B3n_(La_Coru%C3%B1a) https://coruna.gal/descarga/1453733213562/desplegable-museo-INGLES.pdf

### las-palmas

The harbour lies on the sheltered side of La Isleta; Castillo de la Luz guarded the port, with towers along the shore to the south.

- **Castillo de la Luz** (1494), 28.1573, -15.4162 *rough*. Guards the natural harbour of Las Palmas. Role headland. square-shaped two-storey fortress with an 11-gun platform, on foundations of an earlier conquest fort Burned by the Dutch in 1599 and rebuilt. Sources: https://spain-grancanaria.com/en/places/north/las-palmas/la-isleta/castillo-la-luz.html https://lpavisit.com/en/las-palmas-de-gran-canaria/history
- **Torreón de San Pedro Mártir (Castillo de San Cristóbal)** (1578), 28.116, -15.429 *rough*. Guards southern shore approach to the city. Role waterfront. tower ordered by Governor Melgarejo, 1578 (1577 in another source) Saw action in the raids of Drake and Van der Does. Sources: https://lpacultura.com/news/las-palmas-de-gran-canaria-and-its-history-as-a-fortified-city?lang=en
- **Castillo de Mata** (1577), 28.139, -15.431 *rough*. Guards shore between the town and La Isleta. Role waterfront. castle of the 1577 group with the San Pedro Mártir tower and city walls Castillo de Santa Catalina (in the naval base) and Castillo del Rey also existed; dates not seen. Sources: https://lpavisit.com/en/las-palmas-de-gran-canaria/history https://miplayadelascanteras.com/2019/12/17/las-palmas-de-gran-canaria-ciudad-antigua-y-ciudad-del-puerto

### tenerife

Santa Cruz is an open roadstead on the east coast; the castles stood on the shore of the bay and on the ravine mouths.

- **Castillo de San Cristóbal** (1575), 28.4678, -16.2478 *rough*. Guards Santa Cruz Bay at the town centre. Role waterfront. first major fort on the island, the main work of Santa Cruz Bay; entered service 20 January 1577 Together with San Juan and Paso Alto formed the main defence; Torriani designed the island fortifications from 1587. Sources: https://en.wikipedia.org/wiki/Castle_of_San_Crist%C3%B3bal_(Santa_Cruz_de_Tenerife) https://museosdetenerife.org/mha-museo-de-historia-y-antropologia/exposiciones-permanentes-castillo-san-cristobal/informacion-en-idiomas/interpretation-centre
- **Castillo de San Juan Bautista** (1641), 28.472, -16.2415 *rough*. Guards north end of Santa Cruz bay shoreline. Role waterfront. castle begun in 1641 Twelve fortresses with about 92 cannon once defended the town. Sources: http://dayli-tours.com/en/our-offer/cultural-visits/castles-of-santa-cruz-de-tenerife
- **Fortaleza de Paso Alto** (1600), 28.459, -16.2345 *rough*. Guards shore between the Almeida and Tahodio ravines. Role waterfront. fortress about a kilometre from town and 50 m from the shore, linked to San Miguel by a curtain battery Build year not seen; 'from' is a guess. Sources: http://dayli-tours.com/en/our-offer/cultural-visits/castles-of-santa-cruz-de-tenerife

### funchal

Funchal is an open roadstead below steep slopes on Madeira's south coast; the forts stood along the waterfront.

- **Fortaleza de São Lourenço** (1529), 32.6445, -16.9145 *rough*. Guards Funchal roadstead, west side. Role waterfront. governor's palace-fortress on the waterfront; improved after 1566 and a bastion existed from the second quarter of the 16th century Failed against Montluc's French corsairs in 1566, which led to the rest of the defences. Sources: https://tourdecastles.com/pt/castles/palacio-de-sao-lourenco https://cultura.madeira.gov.pt/en/s%C3%A3o-jo%C3%A3o-baptista-do-pico-fortress
- **Forte de São Tiago** (1614), 32.6446, -16.9027 *rough*. Guards Funchal roadstead, east side. Role waterfront. yellow shore fort closing the eastern end of the defensive belt Construction began 1614; finished by the second half of the 1600s. Sources: https://tourdecastles.com/pt/castles/palacio-de-sao-lourenco https://escapehunter.com/escapes/portugal/funchal-fortresses-010908.php
- **Fortaleza de São João Baptista do Pico** (1600), 32.6528, -16.911 *rough*. Guards city and roadstead from the hill. Role citadel. hill fortress above Funchal Exact construction year not known; thought completed in the later 1600s. 'from' is a guess. Sources: https://cultura.madeira.gov.pt/en/s%C3%A3o-jo%C3%A3o-baptista-do-pico-fortress https://escapehunter.com/escapes/portugal/funchal-fortresses-010908.php

### angra

Angra's bay on Terceira's south coast is closed on the west by the Monte Brasil peninsula and on the east by the small hill of São Sebastião.

- **Fortaleza de São João Baptista (São Filipe) on Monte Brasil** (1594), 38.648, -27.229 *rough*. Guards Angra bay, west side. Role headland. large bastioned fortress on the Monte Brasil peninsula, by Girolamo Francès and Cairati Work 'ostensibly began in 1594'; 1618 is a date from the page snippet. Sources: http://en.wikipedia.org/wiki/Fortress_of_S%C3%A3o_Jo%C3%A3o_Baptista_(Angra_do_Hero%C3%ADsmo) https://a.osmarks.net/content/wikipedia_en_all_maxi_2020-08/A/Fortress_of_S%C3%A3o_Jo%C3%A3o_Baptista_(Angra_do_Hero%C3%ADsmo)
- **Forte (Castelo) de São Sebastião** (1580), 38.6523, -27.2133 *rough*. Guards Angra bay, east side. Role headland. Italian-style fort by Tomaz Benedito de Pesaro, with crossfire onto São Benedicto on Monte Brasil Built 1580 at Isidoro de Almeida's suggestion. Sources: https://en.wikipedia.org/wiki/Forte_de_S%C3%A3o_Sebasti%C3%A3o_(Angra_do_Hero%C3%ADsmo)

### ribeira-grande

Ribeira Grande sits in a river valley opening to the sea on Santiago's south coast; the anchorage was open to the bay.

- **Forte Real de São Filipe** (1587), 14.9205, -23.604 *rough*. Guards town and anchorage from the plateau. Role citadel. trapezoidal plan with two complete pentagonal bastions at the east and west vertices; 120 m above sea level Built after Drake's 1578 and 1585 attacks; the system also had six smaller coastal forts and a wall along the port, which this search did not name. Sources: https://visitcidadevelha.cv/en/tms/places/fortaleza-real-de-sao-filipe-4 https://en.wikipedia.org/wiki/Forte_Real_de_S%C3%A3o_Filipe

### goa

The Mandovi mouth opens to the west between Aguada (north) and Cabo (south); Reis Magos and Gaspar Dias faced each other across the river inside the mouth, while the Zuari mouth with Mormugão lies about 9 km further south; Velha Goa is about 10 km upriver on the south bank.

- **Fort Aguada** (1612), 15.4927, 73.7732 *rough*. Guards north headland of the Mandovi mouth. Role mouth. two parts: an upper fort and watering station and a lower fort with a safe berth for ships; 79 guns recorded Outside the +/-4 km window to the west of the port point. Sources: https://en.wikipedia.org/wiki/Fort_Aguada https://a.osmarks.net/content/wikipedia_en_all_maxi_2020-08/A/Fort_Aguada
- **Reis Magos Fort** (1551), 15.5006, 73.8062 *rough*. Guards inner Mandovi mouth, second line. Role narrows. turreted walls high above the water, reached by steep steps; rebuilt 1707; 33 guns Sources differ: started 1551 (Outlook) or 1561-89 (Navhind); built on a Bijapur stronghold; it stands about 2.5 km east of Aguada. Sources: https://outlookindia.com/traveller/destinations/fort_hunting_in_goa https://indovacations.net/goa-holidays-info/Forts_Goa.htm https://epaper.navhindtimes.in/PageImages/pdf/2017/09/30/30092017-md-ga-23.pdf
- **Cabo fort (Cabo Raj Niwas)** (1540), 15.457, 73.804 *rough*. Guards south headland of the Mandovi mouth, also the Zuari. Role headland. fortress with a Franciscan monastery alongside; later the governor's residence (1594) Proposed 1540 by Governor Estevao da Gama to guard the entrance to both the Mandovi and Zuari rivers. Sources: https://mapsofindia.com/maps/goa/forts-in-goa.html https://indovacations.net/goa-holidays-info/Forts_Goa.htm
- **Fort of Gaspar Dias** (1589), 15.48, 73.81 *rough*. Guards south bank of the Mandovi mouth, facing Reis Magos. Role narrows. small fort on Gaspar Dias's land at Miramar, facing Reis Magos; now vanished Build year not seen; 'from' follows the Reis Magos completion date and is a guess. Sources: https://outlookindia.com/traveller/destinations/fort_hunting_in_goa https://epaper.navhindtimes.in/PageImages/pdf/2017/09/30/30092017-md-ga-23.pdf

### malacca

Malacca stands at the mouth of the Malacca River facing the strait; ships anchored in the roads off the town.

- **A Famosa** (1511), 2.193, 102.2505 *rough*. Guards river mouth and roadstead. Role waterfront. four bastion towers, walls about 2.4 m thick and a keep 36 m high on St Paul's Hill; one side along the Malacca River Dutch took it in 1641, destroyed the keep and expanded the walls (gate 1670); the British razed it in 1811. Sources: https://en.wikipedia.org/wiki/A_Famosa https://ebsco.com/research-starters/history/capture-malacca

### nagasaki

Nagasaki Bay is a long narrow inlet from the sea in the west; batteries stood at the mouth to control ships.

- **Megami Battery** (1634), 32.725, 129.856 *rough*. Guards entrance of Nagasaki harbour. Role mouth. one of the original port batteries, extensively rebuilt in 1808; under today's Route 499 'from' 1634 is a guess; only the 1654 completion is documented. The Portuguese were also said to have fortified the port; not detailed. Sources: https://en.wikipedia.org/wiki/Nagasaki_Battery_sites https://worldhistory.org/Portuguese_Nagasaki?in_app=1

### manila

Manila lies on the east shore of its bay at the Pasig mouth; Cavite on its peninsula across the bay was the naval port.

- **Fort Santiago** (1590), 14.5958, 120.966 *rough*. Guards Pasig river mouth and Manila Bay shore. Role mouth. trapezoidal castellated work without towers projecting into the river mouth, arched casemates under an open gun platform (battery of Santa Barbara), curtain walls to a fourth front facing the city; earlier timber fort burned 1574-79 The Baluartillo de San Francisco Javier was added in 1662; enlarged up to the early 18th century. Sources: https://en.wikipedia.org/wiki/Fort_Santiago https://intramuros.gov.ph/fs/ https://intramuros.gov.ph/2020/07/12/virtual-tour-fort-santiago/

### batavia

Batavia's harbour canal ran north to the bay, with ships anchored in the shoaly roads and the islands behind them; the castle stood at the river mouth on the west bank.

- **Batavia Castle** (1619), -6.131, 106.812 *rough*. Guards Ciliwung river mouth and the harbour. Role waterfront. square with four projecting bastions: Parel (NW, facing the Kali Besar), Diamant (SW), Saphier (NE) and Robijn (SE); earthen walls faced with coral stone and a wooden palisade; Waterpoort on the north (sea) and Landpoort on the south; N-S axis about 290 treden by E-W 274 Coen decided on the larger castle on 2 July 1619; sizeM converts the treden at about 0.75 m, my own assumption; completion year 1628 is not stated in the sources seen. Sources: http://popflock.com/learn?s=Batavia_Castle https://en.wikipedia.org/wiki/Batavia,_Dutch_East_Indies https://indonesia-dutchcolonialheritage.nl/JakartaBataviaCastle,%20foundation/CoenDesignBatavia.pdf

### cape-town

Table Bay is an open roadstead facing north-west; ships anchored off the beach with the fort or castle at the shore.

- **Fort de Goede Hoop** (1652), -33.9255, 18.4235 *rough*. Guards Table Bay beach and landing. Role waterfront. clay and timber fort built by Jan van Riebeeck Replaced by the Castle of Good Hope (built 1666-79). Sources: https://en.wikipedia.org/wiki/Fort_of_Good_Hope https://en.wikipedia.org/wiki/Castle_de_Goede_Hoop
- **Castle of Good Hope** (1666), -33.9258, 18.424 *rough*. Guards Table Bay anchorage and landing beaches. Role waterfront. bastioned stone castle; plan not given in the snippets seen Oldest surviving building in South Africa; with the Amsterdam Battery and Chavonnes Battery covered the anchorage. Sources: https://en.wikipedia.org/wiki/Castle_de_Goede_Hoop https://sahistory.org.za/nr/place/dutch-and-british-coastal-fortifications-cape-good-hope-1665-1829
- **Duynhoop redoubt** (1654–1672), -33.904, 18.454 *rough*. Guards Salt River mouth on Table Bay. Role headland. small redoubt (with Kyckuyt) at the mouth of the Salt River Outside the window to the east. Sources: https://en.wikipedia.org/wiki/Fortifications%20of%20the%20Cape%20Peninsula https://en.wikipedia.org/wiki/Castle_de_Goede_Hoop
- **Chavonnes Battery** (1726), -33.919, 18.42 *rough*. Guards Table Bay landing beaches. Role waterfront. shore gun battery; the Amsterdam Battery, the only fully casemated fort, lay between it and the Castle Stood from 1726 to 1860. Sources: https://en.wikipedia.org/wiki/Fortifications%20of%20the%20Cape%20Peninsula https://sahistory.org.za/nr/place/dutch-and-british-coastal-fortifications-cape-good-hope-1665-1829

