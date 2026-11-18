// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the record says about the forts that guarded each port: where each stood, what it was in each of its years and
// what water it held. A position marked rough was estimated from a description or a modern landmark, so it only says
// which stretch of shore to look along. Ports not named here have only the walls and citadels their boards raise.
// Fields: name, phases, until, lat, lon, role (mouth, narrows, headland, river, waterfront, island, citadel), side
// (compass side of the water), shape (the ground it took: star, headland, battery, drum, islet, fitted), earth (earth
// and timber, not stone), bastions, sizeM, rough, encloses (holds the settlement, as James Fort did), gate ("river"
// where the main gate opened to the water, as Strachey says James Fort's did), landmark, terraces.
// waterWithinM, groundBelowM and command hold one fort nearer the water, lower and in sight of it than its kind is
// held in general. Only Lisbon's castle carries them, with a place beside the game's town: see FORTS.md.
//
// A work was not one thing through its years. `phases` are its forms, each from its year to the next (the last to
// `until`), as [from, form, extra]: and `from` is the first of them. The forms:
//   tower            a watch or defence tower standing alone (an atalaya, an almenara)
//   artillery-tower  a gun tower: `round` a cubo or torreón, else square; `battery` where a battery lay at its foot
//   battery          a gun platform at the water, of stone or (earth) of earth and timber
//   enclosed         a castle of the coast: its curtain round towers at the corners, a keep within
//   bastioned        a fort of the trace italienne: its curtain between angled bastions at its corners
//   citadel          a great bastioned work over a town
// The angled bastion came out of Italy in the 1520s–30s, reached Spain and Portugal in the 1530s–50s (São Julião da
// Barra, begun 1553 to Miguel de Arruda's design, is among the first in Portugal) and the Indies after: the Real Fuerza
// of Havana (1558) is the first in the Americas, and the great bastioned works of the Caribbean are of Juan de Tejeda
// and Bautista Antonelli's programme of 1586–1600. Before then a coast was held by towers, batteries and castles of the
// medieval kind. Sources, port by port, are given above each; FORTS.md has the rest.
const FORMS = Object.freeze(['tower', 'artillery-tower', 'battery', 'enclosed', 'bastioned', 'citadel']);
export const FORT_FORMS = FORMS;
const phased = (record) => {
  const phases = Object.freeze(record.phases.map(([from, form, extra = {}]) => {
    if (!FORMS.includes(form)) throw new Error(`${record.name}: no form ${form}`);
    return Object.freeze({ from, form, ...extra });
  }));
  return Object.freeze({ ...record, from: phases[0].from, phases });
};
const P = (port) => Object.freeze({ ...port, forts: Object.freeze(port.forts.map(phased)) });

export const FORT_RECORDS = Object.freeze({
  // Morro and La Punta: Antonelli and Tejeda's works of 1589–1600 (I. A. Wright, The Early History of Cuba; Wikipedia,
  // "Morro Castle (Havana)", "Castillo de San Salvador de la Punta"). La Fuerza: begun 1558 by Bartolomé Sánchez and
  // finished 1577, the first bastioned fort of the Americas (UNESCO 204; Wikipedia, "Castillo de la Real Fuerza").
  "havana": P({
    seaward: 340,
    anchorage: Object.freeze([23.1355,-82.345]),
    // The elevation data shows the channel as low ground, so the bay would be a lake without this.
    channel: Object.freeze({ width: 220, line: Object.freeze([[23.1553, -82.3640], [23.1486, -82.3562], [23.1450, -82.3535], [23.1405, -82.3505], [23.1360, -82.3470], [23.1320, -82.3430]]) }),
    forts: [
      { name: "Castillo de los Tres Reyes del Morro", phases: [[1589, 'bastioned']], lat: 23.15046, lon: -82.35666, role: "mouth", side: "east", shape: "headland", terraces: true },
      { name: "Castillo de San Salvador de la Punta", phases: [[1590, 'bastioned']], lat: 23.14625, lon: -82.35772, role: "mouth", side: "west", shape: "star" },
      { name: "Castillo de la Real Fuerza", phases: [[1558, 'bastioned']], lat: 23.14111, lon: -82.34972, role: "waterfront", side: "west", shape: "star", sizeM: [64,64] },
    ],
  }),
  // El Morro: begun 1539 as a round tower of four guns at the foot of the headland, with a battery at the water below
  // it; made a bastioned work by Tejeda and Antonelli from 1589, the old tower walled into the Santa Bárbara battery
  // (NPS, San Juan National Historic Site, "El Morro" and "Original Tower"; Naval History, June 1996). La Fortaleza:
  // a fortified house round a court with its round tower, 1533–1540 (UNESCO 266). El Cañuelo: a timber fortlet of
  // 1608, in stone from the 1670s. San Cristóbal: begun 1634, the great citadel of 1765–1783 (NPS).
  "san-juan": P({
    seaward: 340,
    anchorage: Object.freeze([18.459,-66.119]),
    forts: [
      { name: "Castillo San Felipe del Morro", phases: [[1539, 'artillery-tower', { round: true, battery: true }], [1589, 'bastioned']], lat: 18.4708, lon: -66.1242, role: "mouth", side: "east", shape: "headland", terraces: true },
      { name: "Fortin San Juan de la Cruz (El Canuelo)", phases: [[1608, 'battery', { earth: true }], [1670, 'battery']], lat: 18.466389, lon: -66.136389, role: "island", side: "west", shape: "islet", sizeM: [24,24] },
      { name: "La Fortaleza", phases: [[1533, 'enclosed', { round: true }]], lat: 18.46417, lon: -66.11917, role: "waterfront", side: "south", shape: "drum", sizeM: [34,34] },
      { name: "Castillo San Cristobal", phases: [[1634, 'bastioned'], [1765, 'citadel']], lat: 18.46722, lon: -66.11111, role: "citadel", side: "east", shape: "star" },
    ],
  }),
  // Bocachica: San Luis, 1646 to its fall in 1741; San Fernando from 1753. San Matías, the first work at Bocagrande,
  // 1567. El Boquerón at the inner narrows, 1586, rebuilt as San Sebastián del Pastelillo in 1743. Santa Cruz of
  // Castillogrande, a square of four bastions, 1628–1631. Manzanillo, a battery opposite it, 1631 (E. Marco Dorta,
  // Cartagena de Indias: puerto y plaza fuerte, 1960; J. M. Zapatero, Historia de las fortificaciones de Cartagena).
  "cartagena": P({
    seaward: 200,
    anchorage: Object.freeze([10.405,-75.54]),
    forts: [
      { name: "Castillo de San Luis de Bocachica (rebuilt as San Fernando de Bocachica)", phases: [[1646, 'bastioned']], lat: 10.319313, lon: -75.581205, role: "mouth", side: "northeast", shape: "star" },
      { name: "Fuerte de San Matias (Punta Icacos)", phases: [[1567, 'battery']], until: 1640, lat: 10.3985, lon: -75.56, role: "mouth", side: "north", shape: "star", sizeM: [82,82], rough: true },
      { name: "Fuerte de San Sebastian del Pastelillo (on the site of El Boqueron)", phases: [[1586, 'battery'], [1743, 'enclosed']], lat: 10.414088, lon: -75.543736, role: "narrows", side: "east", shape: "fitted" },
      { name: "Fuerte de Santa Cruz (Castillogrande)", phases: [[1626, 'bastioned']], lat: 10.395, lon: -75.5495, role: "narrows", side: "south", shape: "star", rough: true },
      { name: "Fuerte de San Juan de Manzanillo", phases: [[1631, 'battery']], lat: 10.399, lon: -75.5455, role: "narrows", side: "north", shape: "battery", rough: true },
    ],
  }),
  // The Fortaleza Ozama: its Torre del Homenaje and walls, 1502–1508 (Wikipedia, "Fortaleza Ozama"). San Gil: a
  // polygonal fort of five sides on the shore, 1503–1510, the first work of the town's sea wall (Visita República
  // Dominicana, "Fuerte San Gil"; Colonial Zone DR). Its ruin stands on the Paseo Presidente Billini, N 18° 28.031′
  // W 69° 53.391′ (Waymarking WM15VYR; OpenStreetMap way 318764340).
  "santo-domingo": P({
    seaward: 180,
    anchorage: Object.freeze([18.47,-69.878]),
    forts: [
      { name: "Fortaleza Ozama (Torre del Homenaje)", phases: [[1502, 'enclosed']], lat: 18.47333, lon: -69.88167, role: "river", side: "west", shape: "headland" },
      { name: "Fuerte San Gil", phases: [[1503, 'battery']], lat: 18.4672, lon: -69.8898, role: "waterfront", side: "south", shape: "star" },
    ],
  }),
  // Ulúa: from 1535 the Muro de las Argollas, a coral-stone wall the ships moored to, with its guns; flanked by the
  // towers of San Pedro and San Crispín in 1584; redesigned by Antonelli in the 1580s–90s as a bastioned work (INAH,
  // "Muro de las argollas" marker; Wikipedia, "San Juan de Ulúa"). The Baluarte de Santiago, a bastion of the city
  // wall, 1635.
  "veracruz": P({
    seaward: 60,
    anchorage: Object.freeze([19.205,-96.127]),
    forts: [
      { name: "Castillo de San Juan de Ulua", phases: [[1535, 'battery'], [1584, 'enclosed'], [1590, 'bastioned']], lat: 19.20917, lon: -96.13139, role: "island", side: "north", shape: "islet" },
      { name: "Baluarte de Santiago (city wall)", phases: [[1635, 'battery']], lat: 19.1905, lon: -96.1325, role: "waterfront", side: "east", shape: "star", rough: true },
    ],
  }),
  // The bastions of Campeche's wall, 1686–1704, and the fort of San Benito before them (INAH, "Fuerte de San Carlos").
  "campeche": P({
    forts: [
      { name: "Baluarte de San Carlos (earlier fort San Benito)", phases: [[1610, 'battery']], lat: 19.8425, lon: -90.5385, role: "waterfront", side: "southwest", shape: "star", rough: true },
      { name: "Baluarte de la Soledad (beside the Sea Gate)", phases: [[1686, 'battery']], lat: 19.8475, lon: -90.5365, role: "waterfront", side: "north", shape: "star", rough: true },
      { name: "Baluarte de Santiago", phases: [[1686, 'battery']], lat: 19.8495, lon: -90.5385, role: "waterfront", side: "northwest", shape: "star", rough: true },
    ],
  }),
  // Santa Marta's bay was held by batteries and small forts of the 17th and 18th centuries (Zapatero).
  "santa-marta": P({
    forts: [
      { name: "Fuerte de San Juan de las Matas", phases: [[1602, 'battery']], lat: 11.2415, lon: -74.2125, role: "waterfront", side: "west", shape: "battery", rough: true },
      { name: "Fuerte de San Vicente", phases: [[1644, 'battery']], lat: 11.2445, lon: -74.2125, role: "waterfront", side: "north", shape: "battery", rough: true },
      { name: "Fuerte de Nuestra Senora de la Caridad (Betin)", phases: [[1663, 'battery']], lat: 11.2535, lon: -74.2215, role: "headland", side: "north", shape: "headland", rough: true },
      { name: "Fuerte de la isla del Morro", phases: [[1739, 'battery']], lat: 11.247, lon: -74.2195, role: "island", side: "south", shape: "islet", rough: true },
      { name: "Fuerte de San Fernando", phases: [[1725, 'bastioned']], lat: 11.2315, lon: -74.2065, role: "headland", side: "south", shape: "star", rough: true },
    ],
  }),
  // San Antonio de la Eminencia, a star of four points, 1659–1686; Santa María de la Cabeza, 1668 (Wikipedia).
  "cumana": P({
    forts: [
      { name: "Castillo de San Antonio de la Eminencia", phases: [[1659, 'bastioned']], lat: 10.46214, lon: -64.17161, role: "citadel", side: "west", shape: "fitted" },
      { name: "Castillo de Santa Maria de la Cabeza", phases: [[1668, 'bastioned']], lat: 10.4611, lon: -64.1742, role: "waterfront", side: "east", shape: "star" },
    ],
  }),
  "panama-viejo": P({
    forts: [
    ],
  }),
  // A battery at the landing, left with the town for Portobelo in 1597.
  "nombre-de-dios": P({
    forts: [
      { name: "Fortificacion de Nombre de Dios (small late-16th-century fort)", phases: [[1570, 'battery']], until: 1597, lat: 9.579, lon: -79.476, role: "waterfront", shape: "star", rough: true },
    ],
  }),
  // Portobelo's works of Antonelli, 1597–1601, and the 18th century's (UNESCO 135).
  "portobelo": P({
    seaward: 280,
    anchorage: Object.freeze([9.557,-79.661]),
    forts: [
      { name: "Fortaleza de San Felipe de Todofierro", phases: [[1597, 'enclosed']], until: 1739, lat: 9.5645, lon: -79.6525, role: "mouth", side: "northeast", shape: "star", rough: true },
      { name: "Castillo de Santiago de la Gloria", phases: [[1600, 'bastioned']], lat: 9.5585, lon: -79.6595, role: "mouth", side: "west", shape: "star", rough: true },
      { name: "Fuerte de San Jeronimo", phases: [[1601, 'battery']], lat: 9.5545, lon: -79.6535, role: "waterfront", side: "east", shape: "star", rough: true },
      { name: "Fuerte Farnesio (Farnese)", phases: [[1726, 'battery', { earth: true }]], lat: 9.5565, lon: -79.6605, role: "headland", side: "west", shape: "battery", earth: true, rough: true },
    ],
  }),
  // San Diego: a pentagon of five bastions, 1615–1617, rebuilt after the earthquake of 1776 (Wikipedia, "Fort of San Diego").
  "acapulco": P({
    seaward: 200,
    anchorage: Object.freeze([16.848,-99.905]),
    forts: [
      { name: "Fuerte de San Diego", phases: [[1616, 'bastioned']], lat: 16.85, lon: -99.902389, role: "waterfront", shape: "star" },
    ],
  }),
  // A battery at the mouth to Antonelli's design from the 1590s; the castle of San Pedro de la Roca begun by Juan
  // Bautista Antonelli in 1638 (UNESCO 841).
  "santiago-de-cuba": P({
    seaward: 200,
    forts: [
      { name: "Castillo de San Pedro de la Roca (El Morro)", phases: [[1590, 'battery'], [1638, 'bastioned']], lat: 19.96871, lon: -75.8703, role: "mouth", side: "east", shape: "headland" },
    ],
  }),
  "trujillo": P({
    forts: [
      { name: "Fortaleza de Santa Barbara", phases: [[1575, 'battery']], lat: 15.9185, lon: -85.9535, role: "headland", side: "south", shape: "star", rough: true },
    ],
  }),
  // The Real Felipe, a pentagon of five bastions, 1747–1774.
  "callao": P({
    forts: [
      { name: "Fortaleza del Real Felipe", phases: [[1747, 'bastioned']], lat: -12.06278, lon: -77.14917, role: "waterfront", shape: "star", bastions: 5, sizeM: [120,120] },
    ],
  }),
  // Bahia's forts (IPHAN): Santo Antônio da Barra a battery of the 1580s, its polygon of 1696–1702; São Marcelo, the
  // round Forte do Mar, 1623–1650 on the reef where a battery stood; Monte Serrat a small fort of round turrets.
  "salvador-da-bahia": P({
    seaward: 190,
    forts: [
      { name: "Forte de Santo Antonio da Barra", phases: [[1583, 'battery'], [1696, 'enclosed']], lat: -13.010278, lon: -38.532778, role: "mouth", side: "west", shape: "headland" },
      { name: "Forte de Santa Maria", phases: [[1614, 'battery']], lat: -13.0085, lon: -38.5295, role: "headland", side: "west", shape: "drum", rough: true },
      { name: "Forte de Sao Marcelo (Forte do Mar)", phases: [[1600, 'battery'], [1623, 'artillery-tower', { round: true }]], lat: -12.9737, lon: -38.5164, role: "island", side: "east", shape: "drum", rough: true },
      { name: "Forte de Sao Diogo", phases: [[1609, 'battery']], lat: -12.9885, lon: -38.5265, role: "waterfront", side: "south", shape: "star", rough: true },
      { name: "Forte de Nossa Senhora de Monte Serrat", phases: [[1580, 'enclosed', { round: true }]], lat: -12.9245, lon: -38.5035, role: "headland", side: "north", shape: "star", rough: true },
    ],
  }),
  "sao-vicente": P({
    seaward: 170,
    forts: [
      { name: "Fortaleza de Santo Amaro da Barra Grande", phases: [[1580, 'battery']], lat: -24.0125, lon: -46.372, role: "mouth", side: "east", shape: "headland", rough: true },
    ],
  }),
  // The Dutch works of Recife, 1629–1630: the forts of Brum and Cinco Pontas bastioned, the Picão a battery on the reef.
  "olinda": P({
    forts: [
      { name: "Forte do Picao (reef entrance)", phases: [[1630, 'battery']], lat: -8.0543, lon: -34.872, role: "mouth", side: "east", shape: "islet", rough: true },
      { name: "Forte do Brum (Fort de Bruyne)", phases: [[1629, 'bastioned', { earth: true }]], lat: -8.0625, lon: -34.8727, role: "headland", side: "north", shape: "star", rough: true },
      { name: "Forte das Cinco Pontas", phases: [[1630, 'bastioned', { earth: true }], [1677, 'bastioned']], lat: -8.0645, lon: -34.8767, role: "waterfront", side: "south", shape: "star", rough: true },
    ],
  }),
  // San Marcos: four bastions of coquina, 1672–1695; nine timber forts before it; Matanzas a coquina gun tower, 1740–1742 (NPS).
  "st-augustine": P({
    seaward: 70,
    anchorage: Object.freeze([29.894,-81.305]),
    forts: [
      { name: "Castillo de San Marcos", phases: [[1672, 'bastioned']], lat: 29.89778, lon: -81.31139, role: "waterfront", side: "east", shape: "star", sizeM: [91,91] },
      { name: "Wooden forts of St. Augustine (nine successive)", phases: [[1565, 'enclosed', { earth: true }]], until: 1672, lat: 29.8975, lon: -81.313, role: "waterfront", side: "east", shape: "star", earth: true, rough: true },
      { name: "Fort Matanzas", phases: [[1740, 'artillery-tower']], lat: 29.71528, lon: -81.23917, role: "river", side: "south", shape: "drum", sizeM: [24,24] },
    ],
  }),
  // Guanabara: the French battery of 1555 at the bar and Fort Coligny on Villegagnon's island (1555–1560); the
  // Portuguese forts of the bar from 1565, made bastioned works in the 17th century (Wikipedia).
  "rio-de-janeiro": P({
    seaward: 170,
    forts: [
      { name: "Fortaleza de Santa Cruz da Barra", phases: [[1555, 'battery'], [1612, 'enclosed']], lat: -22.951111, lon: -43.113611, role: "mouth", side: "east", shape: "headland" },
      { name: "Fortaleza de Sao Joao da Barra", phases: [[1565, 'battery'], [1618, 'bastioned']], lat: -22.943372, lon: -43.156458, role: "mouth", side: "west", shape: "star" },
      { name: "Forte da Laje", phases: [[1644, 'battery']], lat: -22.9475, lon: -43.1335, role: "island", shape: "islet", rough: true },
      { name: "Fort Coligny (Villegagnon island)", phases: [[1555, 'enclosed', { earth: true }]], until: 1560, lat: -22.9125, lon: -43.1658, role: "island", shape: "islet", earth: true, rough: true },
    ],
  }),
  // The English batteries of Basseterre, 1666.
  "st-kitts": P({
    forts: [
      { name: "Fort Thomas (Bluff Point)", phases: [[1666, 'battery']], lat: 17.2935, lon: -62.7345, role: "headland", side: "west", shape: "battery", rough: true },
      { name: "Fort Londonderry", phases: [[1666, 'battery']], lat: 17.2955, lon: -62.7235, role: "waterfront", side: "south", shape: "battery", rough: true },
      { name: "Fort Smith (Bird Rock)", phases: [[1666, 'battery']], lat: 17.2965, lon: -62.7125, role: "headland", side: "east", shape: "battery", rough: true },
    ],
  }),
  // Levasseur's fort on its rock, 1640–1654.
  "tortuga": P({
    forts: [
      { name: "Fort de Rocher (Fort de la Roche, Dovecote)", phases: [[1640, 'enclosed']], until: 1654, lat: 20.0125, lon: -72.792, role: "headland", side: "north", shape: "star", rough: true },
    ],
  }),
  "bridgetown": P({
    forts: [
      { name: "Needham's Fort (Charles Fort)", phases: [[1650, 'battery', { earth: true }]], lat: 13.0789, lon: -59.6127, role: "headland", side: "southwest", shape: "battery", earth: true },
    ],
  }),
  // Fort Amsterdam, four bastions, 1634–1635.
  "curacao": P({
    seaward: 200,
    forts: [
      { name: "Fort Amsterdam", phases: [[1634, 'bastioned']], lat: 12.1047, lon: -68.9345, role: "mouth", side: "east", shape: "star" },
    ],
  }),
  // A timber fort of 1638 on the point, bastioned in stone from 1669 (Wikipedia, "Fort Saint-Louis (Martinique)").
  "fort-royal-martinique": P({
    seaward: 220,
    forts: [
      { name: "Fort Saint-Louis (Fort-Royal)", phases: [[1638, 'enclosed', { earth: true }], [1669, 'bastioned']], lat: 14.5999, lon: -61.0664, role: "headland", side: "west", shape: "star" },
    ],
  }),
  // Fort Charles (Fort Cromwell to 1660) and the batteries along the Port Royal spit (M. Pawson and D. Buisseret, Port Royal, Jamaica).
  "port-royal": P({
    seaward: 190,
    forts: [
      { name: "Fort Charles (Cagway)", phases: [[1655, 'bastioned']], lat: 17.935048, lon: -76.842475, role: "mouth", side: "south", shape: "star" },
      { name: "Fort James", phases: [[1673, 'battery']], lat: 17.9345, lon: -76.8375, role: "waterfront", side: "east", shape: "battery", rough: true },
      { name: "Fort Rupert (the sea fort)", phases: [[1678, 'battery']], until: 1692, lat: 17.9345, lon: -76.8285, role: "waterfront", side: "east", shape: "battery", rough: true },
      { name: "Fort Walker", phases: [[1680, 'battery']], lat: 17.9365, lon: -76.8425, role: "waterfront", side: "north", shape: "battery", rough: true },
      { name: "Fort Carlisle", phases: [[1678, 'battery']], lat: 17.9385, lon: -76.8315, role: "waterfront", side: "north", shape: "battery", rough: true },
    ],
  }),
  "nassau": P({
    forts: [
      { name: "Fort Nassau", phases: [[1697, 'bastioned']], until: 1703, lat: 25.0775, lon: -77.352, role: "waterfront", side: "south", shape: "star", rough: true },
      { name: "Fort Montagu", phases: [[1741, 'enclosed']], lat: 25.0817, lon: -77.3176, role: "mouth", side: "east", shape: "star", rough: true },
    ],
  }),
  "cap-francois": P({
    forts: [
      { name: "Fort Picolet", phases: [[1736, 'battery']], lat: 19.7767, lon: -72.2155, role: "mouth", side: "west", shape: "headland", rough: true },
    ],
  }),
  // The Tagus (R. Moreira, "Do rigor teórico à urgência prática: a arquitectura militar", História da Arte em
  // Portugal; SIPA/DGPC records): João II's Torre Velha of Caparica, a square tower with its battery (1481); the
  // Baluarte of the Ribeira, a bulwark at the palace's waterfront (1511); Belém, a square tower behind its bastion of
  // guns at the water (1514–1519); São Julião, a bastioned work to Miguel de Arruda's design, begun 1553; the Bugio,
  // a round fort on its bank from 1590; the castle of São Jorge, the city's medieval castle.
  "lisbon": P({
    seaward: 250,
    anchorage: Object.freeze([38.7,-9.14]),
    forts: [
      { name: "Baluarte da Ribeira (Forte do Terreiro do Paço)", phases: [[1511, 'battery']], lat: 38.7058, lon: -9.1412, role: "waterfront", side: "north", shape: "battery", sizeM: [44,32] },
      { name: "Torre de São Vicente de Belém", phases: [[1514, 'artillery-tower', { battery: true }]], lat: 38.69167, lon: -9.21611, role: "river", side: "north", shape: "battery", sizeM: [40,40], landmark: "torre_de_belem_manuelina" },
      { name: "Forte de São Julião da Barra", phases: [[1553, 'bastioned']], lat: 38.6795, lon: -9.325, role: "mouth", side: "north", shape: "star", bastions: 5, rough: true },
      { name: "Forte de São Lourenço do Bugio (Torre da Cabeça Seca)", phases: [[1590, 'artillery-tower', { round: true }]], lat: 38.66028, lon: -9.29861, role: "island", shape: "drum", sizeM: [62,62] },
      { name: "Torre Velha de São Sebastião da Caparica", phases: [[1481, 'artillery-tower', { battery: true }]], lat: 38.67618, lon: -9.20969, role: "narrows", side: "south", shape: "battery" },
      { name: "Castelo de São Jorge", phases: [[1492, 'enclosed']], lat: 38.7082, lon: -9.1342, role: "citadel", shape: "fitted", waterWithinM: 480, groundBelowM: 42, command: 0.45 },
    ],
  }),
  // James Fort, Strachey's triangle of palisades (1607), and the earthwork of 1665–67 (APVA Jamestown Rediscovery).
  "jamestown": P({
    seaward: 150,
    forts: [
      { name: "James Fort", phases: [[1607, 'enclosed', { earth: true }]], lat: 37.2092, lon: -76.7787, role: "river", side: "north", shape: "star", earth: true, rough: true, encloses: "triangle", gate: "river" },
      { name: "Jamestown Turf Fort (1665-67 earthwork)", phases: [[1665, 'enclosed', { earth: true }]], until: 1680, lat: 37.2088, lon: -76.7749, role: "river", side: "north", shape: "star", earth: true, rough: true },
    ],
  }),
  // Fort Amsterdam, a square of four earthen bastions, 1625; the Battery's gun platform of 1693.
  "new-amsterdam": P({
    seaward: 185,
    anchorage: Object.freeze([40.7,-74.005]),
    forts: [
      { name: "Fort Amsterdam", phases: [[1625, 'bastioned', { earth: true }]], lat: 40.704, lon: -74.014, role: "headland", side: "south", shape: "star", earth: true, rough: true, encloses: "square" },
      { name: "The Battery (1693 gun platform)", phases: [[1693, 'battery', { earth: true }]], lat: 40.7035, lon: -74.0172, role: "waterfront", side: "south", shape: "battery", earth: true, rough: true },
    ],
  }),
  // The Castle on Castle Island, earth and timber from 1634; the town's batteries and the Fort Hill fort.
  "boston": P({
    seaward: 95,
    anchorage: Object.freeze([42.359,-71.04]),
    forts: [
      { name: "The Castle (Castle William) on Castle Island", phases: [[1634, 'enclosed', { earth: true }]], lat: 42.3375, lon: -71.0106, role: "island", side: "south", shape: "star", sizeM: [80,80] },
      { name: "North Battery", phases: [[1646, 'battery', { earth: true }]], lat: 42.3665, lon: -71.0505, role: "waterfront", side: "north", shape: "battery", earth: true, rough: true },
      { name: "South Battery (the Sconce)", phases: [[1666, 'battery', { earth: true }]], lat: 42.3578, lon: -71.051, role: "waterfront", side: "south", shape: "battery", earth: true, rough: true },
      { name: "Fort Hill fort", phases: [[1632, 'enclosed', { earth: true }]], lat: 42.3555, lon: -71.0535, role: "citadel", side: "south", shape: "star", earth: true, rough: true, encloses: "square" },
    ],
  }),
  // Champlain's Habitation (1608), the forts Saint-Louis on the cliff (1620–1694) and the Batterie Royale (1691).
  "quebec": P({
    forts: [
      { name: "Habitation de Québec", phases: [[1608, 'enclosed', { earth: true }]], lat: 46.8127, lon: -71.2017, role: "waterfront", side: "north", shape: "star", earth: true, rough: true, encloses: "square" },
      { name: "Fort Saint-Louis (cliff-top forts, 1620-1694)", phases: [[1620, 'enclosed', { earth: true }]], lat: 46.812, lon: -71.2051, role: "citadel", side: "north", shape: "fitted", rough: true },
      { name: "Batterie Royale", phases: [[1691, 'battery', { earth: true }]], until: 1763, lat: 46.81276, lon: -71.202, role: "waterfront", side: "north", shape: "battery", earth: true },
    ],
  }),
  // Governor Moore's forts and batteries of 1612 (E. C. Harris, Bermuda Forts 1612–1957).
  "bermuda": P({
    forts: [
      { name: "Fort St Catherine", phases: [[1612, 'battery']], lat: 32.39, lon: -64.676, role: "headland", side: "north", shape: "battery" },
      { name: "Gates Fort (Danvers Fort) at Town Cut", phases: [[1612, 'battery']], lat: 32.3835, lon: -64.661, role: "narrows", side: "south", shape: "battery", rough: true },
      { name: "Paget Fort", phases: [[1612, 'battery']], lat: 32.373, lon: -64.658, role: "island", side: "east", shape: "islet" },
      { name: "Smith's Fort", phases: [[1612, 'battery']], lat: 32.371, lon: -64.658, role: "island", side: "east", shape: "islet" },
      { name: "King's Castle", phases: [[1612, 'battery']], lat: 32.357, lon: -64.69, role: "island", side: "south", shape: "islet", rough: true },
    ],
  }),
  "plymouth-colony": P({
    forts: [
      { name: "Plymouth fort-meetinghouse on Fort (Burial) Hill", phases: [[1621, 'enclosed', { earth: true }]], lat: 41.9575, lon: -70.662, role: "citadel", shape: "fitted", earth: true, rough: true, encloses: "square" },
    ],
  }),
  // The bastions and batteries of Charles Town's sea wall, 1697–1708.
  "charleston": P({
    seaward: 140,
    forts: [
      { name: "Granville Bastion", phases: [[1697, 'battery']], lat: 32.77325, lon: -79.92758, role: "waterfront", side: "east", shape: "star" },
      { name: "Half Moon Battery", phases: [[1704, 'battery']], until: 1768, lat: 32.7742, lon: -79.927, role: "waterfront", side: "east", shape: "battery", rough: true },
      { name: "Fort Johnson", phases: [[1708, 'battery', { earth: true }]], lat: 32.7523, lon: -79.9005, role: "headland", side: "south", shape: "battery", earth: true, rough: true },
    ],
  }),
  "philadelphia": P({
    seaward: 180,
    forts: [
      { name: "Association (Grand) Battery", phases: [[1747, 'battery']], lat: 39.9385, lon: -75.1425, role: "waterfront", side: "west", shape: "battery", rough: true },
      { name: "Society Hill Battery", phases: [[1747, 'battery']], lat: 39.945, lon: -75.1408, role: "waterfront", side: "west", shape: "battery", rough: true },
    ],
  }),
  // The castle of the dukes of Medina Sidonia, its keep and round towers of 1477 (Wikipedia, "Castillo de Santiago (Sanlúcar de Barrameda)").
  "cadiz-sanlucar": P({
    seaward: 290,
    forts: [
      { name: "Castillo de Santiago, Sanlúcar de Barrameda", phases: [[1477, 'enclosed', { round: true }]], lat: 36.7818, lon: -6.3538, role: "citadel", side: "south", shape: "fitted", rough: true },
    ],
  }),
  // Palos's castle of 1322. The Torre de la Arenilla is one of the almenara towers Philip II ordered from Gibraltar to
  // Ayamonte, raised in the late 16th and early 17th centuries (Croma Cultura, "Torre de la Arenilla"; BIC 1985).
  "palos-huelva": P({
    seaward: 200,
    forts: [
      { name: "Castillo de Palos de la Frontera", phases: [[1322, 'enclosed']], lat: 37.2301, lon: -6.8925, role: "river", side: "north", shape: "fitted" },
      { name: "Torre de la Arenilla", phases: [[1588, 'tower']], lat: 37.213, lon: -6.94, role: "mouth", side: "north", shape: "drum", rough: true },
    ],
  }),
  // San Antón on its islet, 1587–1590.
  "la-coruna": P({
    seaward: 330,
    anchorage: Object.freeze([43.365,-8.395]),
    forts: [
      { name: "Castillo de San Antón", phases: [[1587, 'enclosed']], lat: 43.3659, lon: -8.3903, role: "island", shape: "islet", rough: true },
    ],
  }),
  // La Luz: the square tower of Alonso Fajardo (1494) on Rejón's timber fort, a bulwark round it from about 1515,
  // added to in 1553, burnt by van der Does in 1599 and rebuilt from 1601 (Audioguía, "Castillo de la Luz";
  // Castlopedia). It stood on a reef cut off at high water, now built round, at 28° 08′ 55″ N 15° 25′ 29.5″ W
  // (Wikimedia Commons, "Castillo de La Luz"). San Pedro Mártir, a gun tower of 1578; Mata, the round tower of the
  // north wall, 1577.
  "las-palmas": P({
    forts: [
      { name: "Castillo de la Luz", phases: [[1494, 'tower'], [1515, 'enclosed']], lat: 28.1486, lon: -15.4249, role: "headland", side: "north", shape: "headland" },
      { name: "Torreón de San Pedro Mártir (Castillo de San Cristóbal)", phases: [[1578, 'artillery-tower', { round: true }]], lat: 28.116, lon: -15.429, role: "waterfront", side: "south", shape: "drum", rough: true },
      { name: "Castillo de Mata", phases: [[1577, 'artillery-tower', { round: true }]], lat: 28.139, lon: -15.431, role: "waterfront", side: "north", shape: "battery", rough: true },
    ],
  }),
  // Santa Cruz: San Cristóbal, a square of four bastions (1575–1577); San Juan, the half-round Castillo Negro (1641);
  // Paso Alto, a battery (J. Tous Meliá, Guía histórica del Museo Militar de Canarias).
  "tenerife": P({
    forts: [
      { name: "Castillo de San Cristóbal", phases: [[1575, 'bastioned']], lat: 28.4678, lon: -16.2478, role: "waterfront", shape: "battery", rough: true },
      { name: "Castillo de San Juan Bautista", phases: [[1641, 'artillery-tower', { round: true }]], lat: 28.472, lon: -16.2415, role: "waterfront", side: "north", shape: "battery", rough: true },
      { name: "Fortaleza de Paso Alto", phases: [[1600, 'battery']], lat: 28.459, lon: -16.2345, role: "waterfront", side: "south", shape: "battery", rough: true },
    ],
  }),
  // São Lourenço: a rectangular wall with its Manueline round towers, 1529–1540; enlarged and bastioned after the sack
  // of 1566 by Mateus Fernandes III (Elucidário Madeirense, "São Lourenço"; SIPA); the palace that is its keep stands
  // on the Avenida Zarco, N 32° 38.830′ W 16° 54.609′ (Waymarking WM16XC6). São Tiago, 1614; the Pico, 1600s.
  "funchal": P({
    forts: [
      { name: "Fortaleza de São Lourenço", phases: [[1529, 'enclosed', { round: true }], [1572, 'bastioned']], lat: 32.6472, lon: -16.9102, role: "waterfront", side: "west", shape: "star" },
      { name: "Forte de São Tiago", phases: [[1614, 'enclosed']], lat: 32.6446, lon: -16.9027, role: "waterfront", side: "east", shape: "battery", rough: true },
      { name: "Fortaleza de São João Baptista do Pico", phases: [[1600, 'enclosed']], lat: 32.6528, lon: -16.911, role: "citadel", side: "north", shape: "fitted", rough: true },
    ],
  }),
  // Monte Brasil's citadel of São João Baptista, begun 1594; São Sebastião, a small fort of the 1570s (SIPA).
  "angra": P({
    anchorage: Object.freeze([38.65,-27.22]),
    forts: [
      { name: "Fortaleza de São João Baptista (São Filipe) on Monte Brasil", phases: [[1594, 'citadel']], lat: 38.648, lon: -27.229, role: "headland", side: "west", shape: "star", rough: true },
      { name: "Forte (Castelo) de São Sebastião", phases: [[1580, 'enclosed']], lat: 38.6523, lon: -27.2133, role: "headland", side: "east", shape: "battery", rough: true },
    ],
  }),
  // São Filipe over Cidade Velha, bastioned, 1587–1593 (UNESCO 1310).
  "ribeira-grande": P({
    forts: [
      { name: "Forte Real de São Filipe", phases: [[1587, 'bastioned']], lat: 14.9205, lon: -23.604, role: "citadel", side: "north", shape: "star", rough: true },
    ],
  }),
  // Goa's bar: the Cabo's guns of 1540 under Estêvão da Gama (Lok Bhavan Goa, "History"); Reis Magos, 1551; Aguada,
  // 1612; Gaspar Dias, 1589.
  "goa": P({
    seaward: 265,
    anchorage: Object.freeze([15.502,73.82]),
    forts: [
      { name: "Fort Aguada", phases: [[1612, 'enclosed']], lat: 15.4927, lon: 73.7732, role: "mouth", side: "north", shape: "headland", rough: true },
      { name: "Reis Magos Fort", phases: [[1551, 'enclosed']], lat: 15.5006, lon: 73.8062, role: "narrows", side: "north", shape: "battery", rough: true },
      { name: "Cabo fort (Cabo Raj Niwas)", phases: [[1540, 'battery']], lat: 15.457, lon: 73.804, role: "headland", side: "south", shape: "headland", rough: true },
      { name: "Fort of Gaspar Dias", phases: [[1589, 'battery']], lat: 15.48, lon: 73.81, role: "narrows", side: "south", shape: "battery", rough: true },
    ],
  }),
  // A Famosa: Albuquerque's keep of 1511–1512 within ramparts of four towers; the town walled with bastions about 1586
  // (Wikipedia, "A Famosa").
  "malacca": P({
    forts: [
      { name: "A Famosa", phases: [[1511, 'enclosed'], [1586, 'bastioned']], lat: 2.193, lon: 102.2505, role: "waterfront", side: "east", shape: "star", rough: true },
    ],
  }),
  "nagasaki": P({
    seaward: 220,
    forts: [
      { name: "Megami Battery", phases: [[1634, 'battery', { earth: true }]], lat: 32.725, lon: 129.856, role: "mouth", shape: "battery", earth: true, rough: true },
    ],
  }),
  // Fort Santiago, the stone fort of 1590–1593.
  "manila": P({
    seaward: 250,
    forts: [
      { name: "Fort Santiago", phases: [[1590, 'enclosed']], lat: 14.5958, lon: 120.966, role: "mouth", side: "north", shape: "star", rough: true },
    ],
  }),
  // Batavia's castle, a square of four bastions, 1619.
  "batavia": P({
    seaward: 0,
    forts: [
      { name: "Batavia Castle", phases: [[1619, 'bastioned']], lat: -6.131, lon: 106.812, role: "waterfront", side: "west", shape: "star", sizeM: [120,120], rough: true },
    ],
  }),
  // Van Riebeeck's earthen fort of four bastions (1652) and the Castle's pentagon (1666–1679).
  "cape-town": P({
    seaward: 340,
    forts: [
      { name: "Fort de Goede Hoop", phases: [[1652, 'bastioned', { earth: true }]], lat: -33.9255, lon: 18.4235, role: "waterfront", side: "south", shape: "star", earth: true, rough: true, encloses: "square" },
      { name: "Castle of Good Hope", phases: [[1666, 'bastioned']], lat: -33.9258, lon: 18.424, role: "waterfront", side: "south", shape: "star", bastions: 5, sizeM: [120,120], rough: true },
      { name: "Duynhoop redoubt", phases: [[1654, 'battery', { earth: true }]], until: 1672, lat: -33.904, lon: 18.454, role: "headland", side: "east", shape: "star", earth: true, rough: true },
      { name: "Chavonnes Battery", phases: [[1726, 'battery']], lat: -33.919, lon: 18.42, role: "waterfront", side: "north", shape: "battery", rough: true },
    ],
  }),
});

// What stood at a port in a given year, in the order of the record.
export function fortRecordsFor(portId, year) {
  const record = FORT_RECORDS[portId];
  if (!record) return { seaward: null, channel: null, anchorage: null, forts: [] };
  return { seaward: record.seaward ?? null, channel: record.channel ?? null, anchorage: record.anchorage ?? null, forts: record.forts.filter((fort) => fort.from <= year && !(fort.until && fort.until <= year)) };
}

// The form a work stood in in a year: the last of its phases begun by then, or null before its first and from its end.
export function fortPhaseFor(fort, year) {
  if (!(fort.from <= year) || (fort.until && fort.until <= year)) return null;
  let phase = null;
  for (const p of fort.phases) if (p.from <= year) phase = p;
  return phase;
}
