// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the record says about the forts that guarded each port: where each stood, what it was and what water it held.
// Sources are in FORTS.md, port by port. A position marked rough was estimated from a description or a modern
// landmark, so it only says which stretch of shore to look along. Ports not named here go by the geography alone.
// Fields: name, from, until, lat, lon, role (mouth, narrows, headland, river, waterfront, island, citadel), side
// (compass side of the water), shape (star, headland, battery, drum, islet, fitted), earth (earth and timber, not
// stone), bastions, sizeM, rough, encloses (holds the settlement, as James Fort did), gate ("river" where the main gate opened to the water, as Strachey says James Fort's did), landmark, terraces.
export const FORT_RECORDS = Object.freeze({
  "havana": Object.freeze({
    seaward: 340,
    anchorage: Object.freeze([23.1355,-82.345]),
    // The elevation data shows the channel as low ground, so the bay would be a lake without this.
    channel: Object.freeze({ width: 220, line: Object.freeze([[23.1553, -82.3640], [23.1486, -82.3562], [23.1450, -82.3535], [23.1405, -82.3505], [23.1360, -82.3470], [23.1320, -82.3430]]) }),
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de los Tres Reyes del Morro", from: 1589, lat: 23.15046, lon: -82.35666, role: "mouth", side: "east", shape: "headland", terraces: true }),
      Object.freeze({ name: "Castillo de San Salvador de la Punta", from: 1590, lat: 23.14625, lon: -82.35772, role: "mouth", side: "west", shape: "star" }),
      Object.freeze({ name: "Castillo de la Real Fuerza", from: 1558, lat: 23.14111, lon: -82.34972, role: "waterfront", side: "west", shape: "star", sizeM: [64,64] }),
    ]),
  }),
  "san-juan": Object.freeze({
    seaward: 340,
    anchorage: Object.freeze([18.459,-66.119]),
    forts: Object.freeze([
      Object.freeze({ name: "Castillo San Felipe del Morro", from: 1539, lat: 18.4708, lon: -66.1242, role: "mouth", side: "east", shape: "headland", terraces: true }),
      Object.freeze({ name: "Fortin San Juan de la Cruz (El Canuelo)", from: 1608, lat: 18.466389, lon: -66.136389, role: "island", side: "west", shape: "islet", earth: true, sizeM: [24,24] }),
      Object.freeze({ name: "La Fortaleza", from: 1533, lat: 18.46417, lon: -66.11917, role: "waterfront", side: "south", shape: "drum", sizeM: [34,34] }),
      Object.freeze({ name: "Castillo San Cristobal", from: 1634, lat: 18.46722, lon: -66.11111, role: "citadel", side: "east", shape: "star" }),
    ]),
  }),
  "cartagena": Object.freeze({
    seaward: 200,
    anchorage: Object.freeze([10.405,-75.54]),
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Luis de Bocachica (rebuilt as San Fernando de Bocachica)", from: 1646, lat: 10.319313, lon: -75.581205, role: "mouth", side: "northeast", shape: "star" }),
      Object.freeze({ name: "Fuerte de San Matias (Punta Icacos)", from: 1567, until: 1640, lat: 10.3985, lon: -75.56, role: "mouth", side: "north", shape: "star", sizeM: [82,82], rough: true }),
      Object.freeze({ name: "Fuerte de San Sebastian del Pastelillo (on the site of El Boqueron)", from: 1586, lat: 10.414088, lon: -75.543736, role: "narrows", side: "east", shape: "fitted" }),
      Object.freeze({ name: "Fuerte de Santa Cruz (Castillogrande)", from: 1626, lat: 10.395, lon: -75.5495, role: "narrows", side: "south", shape: "star", rough: true }),
      Object.freeze({ name: "Fuerte de San Juan de Manzanillo", from: 1631, lat: 10.399, lon: -75.5455, role: "narrows", side: "north", shape: "battery", rough: true }),
    ]),
  }),
  "santo-domingo": Object.freeze({
    seaward: 180,
    anchorage: Object.freeze([18.47,-69.878]),
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza Ozama (Torre del Homenaje)", from: 1502, lat: 18.47333, lon: -69.88167, role: "river", side: "west", shape: "headland" }),
      Object.freeze({ name: "Fuerte San Gil", from: 1503, lat: 18.4705, lon: -69.8915, role: "waterfront", side: "south", shape: "star", rough: true }),
    ]),
  }),
  "veracruz": Object.freeze({
    seaward: 60,
    anchorage: Object.freeze([19.205,-96.127]),
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Juan de Ulua", from: 1535, lat: 19.20917, lon: -96.13139, role: "island", side: "north", shape: "islet" }),
      Object.freeze({ name: "Baluarte de Santiago (city wall)", from: 1635, lat: 19.1905, lon: -96.1325, role: "waterfront", side: "east", shape: "star", rough: true }),
    ]),
  }),
  "campeche": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Baluarte de San Carlos (earlier fort San Benito)", from: 1610, lat: 19.8425, lon: -90.5385, role: "waterfront", side: "southwest", shape: "star", rough: true }),
      Object.freeze({ name: "Baluarte de la Soledad (beside the Sea Gate)", from: 1686, lat: 19.8475, lon: -90.5365, role: "waterfront", side: "north", shape: "star", rough: true }),
      Object.freeze({ name: "Baluarte de Santiago", from: 1686, lat: 19.8495, lon: -90.5385, role: "waterfront", side: "northwest", shape: "star", rough: true }),
    ]),
  }),
  "santa-marta": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fuerte de San Juan de las Matas", from: 1602, lat: 11.2415, lon: -74.2125, role: "waterfront", side: "west", shape: "battery", rough: true }),
      Object.freeze({ name: "Fuerte de San Vicente", from: 1644, lat: 11.2445, lon: -74.2125, role: "waterfront", side: "north", shape: "battery", rough: true }),
      Object.freeze({ name: "Fuerte de Nuestra Senora de la Caridad (Betin)", from: 1663, lat: 11.2535, lon: -74.2215, role: "headland", side: "north", shape: "headland", rough: true }),
      Object.freeze({ name: "Fuerte de la isla del Morro", from: 1739, lat: 11.247, lon: -74.2195, role: "island", side: "south", shape: "islet", rough: true }),
      Object.freeze({ name: "Fuerte de San Fernando", from: 1725, lat: 11.2315, lon: -74.2065, role: "headland", side: "south", shape: "star", rough: true }),
    ]),
  }),
  "cumana": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Antonio de la Eminencia", from: 1659, lat: 10.46214, lon: -64.17161, role: "citadel", side: "west", shape: "fitted" }),
      Object.freeze({ name: "Castillo de Santa Maria de la Cabeza", from: 1668, lat: 10.4611, lon: -64.1742, role: "waterfront", side: "east", shape: "star" }),
    ]),
  }),
  "panama-viejo": Object.freeze({
    forts: Object.freeze([
    ]),
  }),
  "nombre-de-dios": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fortificacion de Nombre de Dios (small late-16th-century fort)", from: 1570, until: 1597, lat: 9.579, lon: -79.476, role: "waterfront", shape: "star", rough: true }),
    ]),
  }),
  "portobelo": Object.freeze({
    seaward: 280,
    anchorage: Object.freeze([9.557,-79.661]),
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza de San Felipe de Todofierro", from: 1597, until: 1739, lat: 9.5645, lon: -79.6525, role: "mouth", side: "northeast", shape: "star", rough: true }),
      Object.freeze({ name: "Castillo de Santiago de la Gloria", from: 1600, lat: 9.5585, lon: -79.6595, role: "mouth", side: "west", shape: "star", rough: true }),
      Object.freeze({ name: "Fuerte de San Jeronimo", from: 1601, lat: 9.5545, lon: -79.6535, role: "waterfront", side: "east", shape: "star", rough: true }),
      Object.freeze({ name: "Fuerte Farnesio (Farnese)", from: 1726, lat: 9.5565, lon: -79.6605, role: "headland", side: "west", shape: "battery", earth: true, rough: true }),
    ]),
  }),
  "acapulco": Object.freeze({
    seaward: 200,
    anchorage: Object.freeze([16.848,-99.905]),
    forts: Object.freeze([
      Object.freeze({ name: "Fuerte de San Diego", from: 1616, lat: 16.85, lon: -99.902389, role: "waterfront", shape: "star" }),
    ]),
  }),
  "santiago-de-cuba": Object.freeze({
    seaward: 200,
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Pedro de la Roca (El Morro)", from: 1590, lat: 19.96871, lon: -75.8703, role: "mouth", side: "east", shape: "headland" }),
    ]),
  }),
  "trujillo": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza de Santa Barbara", from: 1575, lat: 15.9185, lon: -85.9535, role: "headland", side: "south", shape: "star", rough: true }),
    ]),
  }),
  "callao": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza del Real Felipe", from: 1747, lat: -12.06278, lon: -77.14917, role: "waterfront", shape: "star", bastions: 5, sizeM: [120,120] }),
    ]),
  }),
  "salvador-da-bahia": Object.freeze({
    seaward: 190,
    forts: Object.freeze([
      Object.freeze({ name: "Forte de Santo Antonio da Barra", from: 1583, lat: -13.010278, lon: -38.532778, role: "mouth", side: "west", shape: "headland" }),
      Object.freeze({ name: "Forte de Santa Maria", from: 1614, lat: -13.0085, lon: -38.5295, role: "headland", side: "west", shape: "drum", rough: true }),
      Object.freeze({ name: "Forte de Sao Marcelo (Forte do Mar)", from: 1600, lat: -12.9737, lon: -38.5164, role: "island", side: "east", shape: "drum", rough: true }),
      Object.freeze({ name: "Forte de Sao Diogo", from: 1609, lat: -12.9885, lon: -38.5265, role: "waterfront", side: "south", shape: "star", rough: true }),
      Object.freeze({ name: "Forte de Nossa Senhora de Monte Serrat", from: 1580, lat: -12.9245, lon: -38.5035, role: "headland", side: "north", shape: "star", rough: true }),
    ]),
  }),
  "sao-vicente": Object.freeze({
    seaward: 170,
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza de Santo Amaro da Barra Grande", from: 1580, lat: -24.0125, lon: -46.372, role: "mouth", side: "east", shape: "headland", rough: true }),
    ]),
  }),
  "olinda": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Forte do Picao (reef entrance)", from: 1630, lat: -8.0543, lon: -34.872, role: "mouth", side: "east", shape: "islet", rough: true }),
      Object.freeze({ name: "Forte do Brum (Fort de Bruyne)", from: 1629, lat: -8.0625, lon: -34.8727, role: "headland", side: "north", shape: "star", rough: true }),
      Object.freeze({ name: "Forte das Cinco Pontas", from: 1630, lat: -8.0645, lon: -34.8767, role: "waterfront", side: "south", shape: "star", rough: true }),
    ]),
  }),
  "st-augustine": Object.freeze({
    seaward: 70,
    anchorage: Object.freeze([29.894,-81.305]),
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Marcos", from: 1672, lat: 29.89778, lon: -81.31139, role: "waterfront", side: "east", shape: "star", sizeM: [91,91] }),
      Object.freeze({ name: "Wooden forts of St. Augustine (nine successive)", from: 1565, until: 1672, lat: 29.8975, lon: -81.313, role: "waterfront", side: "east", shape: "star", earth: true, rough: true }),
      Object.freeze({ name: "Fort Matanzas", from: 1740, lat: 29.71528, lon: -81.23917, role: "river", side: "south", shape: "drum", sizeM: [24,24] }),
    ]),
  }),
  "rio-de-janeiro": Object.freeze({
    seaward: 170,
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza de Santa Cruz da Barra", from: 1555, lat: -22.951111, lon: -43.113611, role: "mouth", side: "east", shape: "headland" }),
      Object.freeze({ name: "Fortaleza de Sao Joao da Barra", from: 1565, lat: -22.943372, lon: -43.156458, role: "mouth", side: "west", shape: "star" }),
      Object.freeze({ name: "Forte da Laje", from: 1644, lat: -22.9475, lon: -43.1335, role: "island", shape: "islet", rough: true }),
      Object.freeze({ name: "Fort Coligny (Villegagnon island)", from: 1555, until: 1560, lat: -22.9125, lon: -43.1658, role: "island", shape: "islet", earth: true, rough: true }),
    ]),
  }),
  "st-kitts": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fort Thomas (Bluff Point)", from: 1666, lat: 17.2935, lon: -62.7345, role: "headland", side: "west", shape: "battery", rough: true }),
      Object.freeze({ name: "Fort Londonderry", from: 1666, lat: 17.2955, lon: -62.7235, role: "waterfront", side: "south", shape: "battery", rough: true }),
      Object.freeze({ name: "Fort Smith (Bird Rock)", from: 1666, lat: 17.2965, lon: -62.7125, role: "headland", side: "east", shape: "battery", rough: true }),
    ]),
  }),
  "tortuga": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fort de Rocher (Fort de la Roche, Dovecote)", from: 1640, until: 1654, lat: 20.0125, lon: -72.792, role: "headland", side: "north", shape: "star", rough: true }),
    ]),
  }),
  "bridgetown": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Needham's Fort (Charles Fort)", from: 1650, lat: 13.0789, lon: -59.6127, role: "headland", side: "southwest", shape: "battery", earth: true }),
    ]),
  }),
  "curacao": Object.freeze({
    seaward: 200,
    forts: Object.freeze([
      Object.freeze({ name: "Fort Amsterdam", from: 1634, lat: 12.1047, lon: -68.9345, role: "mouth", side: "east", shape: "star" }),
    ]),
  }),
  "fort-royal-martinique": Object.freeze({
    seaward: 220,
    forts: Object.freeze([
      Object.freeze({ name: "Fort Saint-Louis (Fort-Royal)", from: 1638, lat: 14.5999, lon: -61.0664, role: "headland", side: "west", shape: "star" }),
    ]),
  }),
  "port-royal": Object.freeze({
    seaward: 190,
    forts: Object.freeze([
      Object.freeze({ name: "Fort Charles (Cagway)", from: 1655, lat: 17.935048, lon: -76.842475, role: "mouth", side: "south", shape: "star" }),
      Object.freeze({ name: "Fort James", from: 1673, lat: 17.9345, lon: -76.8375, role: "waterfront", side: "east", shape: "battery", rough: true }),
      Object.freeze({ name: "Fort Rupert (the sea fort)", from: 1678, until: 1692, lat: 17.9345, lon: -76.8285, role: "waterfront", side: "east", shape: "battery", rough: true }),
      Object.freeze({ name: "Fort Walker", from: 1680, lat: 17.9365, lon: -76.8425, role: "waterfront", side: "north", shape: "battery", rough: true }),
      Object.freeze({ name: "Fort Carlisle", from: 1678, lat: 17.9385, lon: -76.8315, role: "waterfront", side: "north", shape: "battery", rough: true }),
    ]),
  }),
  "nassau": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fort Nassau", from: 1697, until: 1703, lat: 25.0775, lon: -77.352, role: "waterfront", side: "south", shape: "star", rough: true }),
      Object.freeze({ name: "Fort Montagu", from: 1741, lat: 25.0817, lon: -77.3176, role: "mouth", side: "east", shape: "star", rough: true }),
    ]),
  }),
  "cap-francois": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fort Picolet", from: 1736, lat: 19.7767, lon: -72.2155, role: "mouth", side: "west", shape: "headland", rough: true }),
    ]),
  }),
  "lisbon": Object.freeze({
    seaward: 250,
    anchorage: Object.freeze([38.7,-9.14]),
    forts: Object.freeze([
      Object.freeze({ name: "Baluarte da Ribeira (Forte do Terreiro do Paço)", from: 1511, lat: 38.7058, lon: -9.1412, role: "waterfront", side: "north", shape: "battery", sizeM: [44,32] }),
      Object.freeze({ name: "Torre de São Vicente de Belém", from: 1514, lat: 38.69167, lon: -9.21611, role: "river", side: "north", shape: "battery", sizeM: [40,40], landmark: "torre_de_belem_manuelina" }),
      Object.freeze({ name: "Forte de São Julião da Barra", from: 1553, lat: 38.6795, lon: -9.325, role: "mouth", side: "north", shape: "star", bastions: 5, rough: true }),
      Object.freeze({ name: "Forte de São Lourenço do Bugio (Torre da Cabeça Seca)", from: 1590, lat: 38.66028, lon: -9.29861, role: "island", shape: "drum", sizeM: [62,62] }),
      Object.freeze({ name: "Torre Velha de São Sebastião da Caparica", from: 1481, lat: 38.67618, lon: -9.20969, role: "narrows", side: "south", shape: "battery" }),
      Object.freeze({ name: "Castelo de São Jorge", from: 1492, lat: 38.7082, lon: -9.1342, role: "citadel", shape: "fitted" }),
    ]),
  }),
  "jamestown": Object.freeze({
    seaward: 150,
    forts: Object.freeze([
      Object.freeze({ name: "James Fort", from: 1607, lat: 37.2092, lon: -76.7787, role: "river", side: "north", shape: "star", earth: true, rough: true, encloses: "triangle", gate: "river" }),
      Object.freeze({ name: "Jamestown Turf Fort (1665-67 earthwork)", from: 1665, until: 1680, lat: 37.2088, lon: -76.7749, role: "river", side: "north", shape: "star", earth: true, rough: true }),
    ]),
  }),
  "new-amsterdam": Object.freeze({
    seaward: 185,
    anchorage: Object.freeze([40.7,-74.005]),
    forts: Object.freeze([
      Object.freeze({ name: "Fort Amsterdam", from: 1625, lat: 40.704, lon: -74.014, role: "headland", side: "south", shape: "star", earth: true, rough: true, encloses: "square" }),
      Object.freeze({ name: "The Battery (1693 gun platform)", from: 1693, lat: 40.7035, lon: -74.0172, role: "waterfront", side: "south", shape: "battery", earth: true, rough: true }),
    ]),
  }),
  "boston": Object.freeze({
    seaward: 95,
    anchorage: Object.freeze([42.359,-71.04]),
    forts: Object.freeze([
      Object.freeze({ name: "The Castle (Castle William) on Castle Island", from: 1634, lat: 42.3375, lon: -71.0106, role: "island", side: "south", shape: "star", sizeM: [80,80] }),
      Object.freeze({ name: "North Battery", from: 1646, lat: 42.3665, lon: -71.0505, role: "waterfront", side: "north", shape: "battery", earth: true, rough: true }),
      Object.freeze({ name: "South Battery (the Sconce)", from: 1666, lat: 42.3578, lon: -71.051, role: "waterfront", side: "south", shape: "battery", earth: true, rough: true }),
      Object.freeze({ name: "Fort Hill fort", from: 1632, lat: 42.3555, lon: -71.0535, role: "citadel", side: "south", shape: "star", earth: true, rough: true, encloses: "square" }),
    ]),
  }),
  "quebec": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Habitation de Québec", from: 1608, lat: 46.8127, lon: -71.2017, role: "waterfront", side: "north", shape: "star", earth: true, rough: true, encloses: "square" }),
      Object.freeze({ name: "Fort Saint-Louis (cliff-top forts, 1620-1694)", from: 1620, lat: 46.812, lon: -71.2051, role: "citadel", side: "north", shape: "fitted", rough: true }),
      Object.freeze({ name: "Batterie Royale", from: 1691, until: 1763, lat: 46.81276, lon: -71.202, role: "waterfront", side: "north", shape: "battery", earth: true }),
    ]),
  }),
  "bermuda": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fort St Catherine", from: 1612, lat: 32.39, lon: -64.676, role: "headland", side: "north", shape: "battery" }),
      Object.freeze({ name: "Gates Fort (Danvers Fort) at Town Cut", from: 1612, lat: 32.3835, lon: -64.661, role: "narrows", side: "south", shape: "battery", rough: true }),
      Object.freeze({ name: "Paget Fort", from: 1612, lat: 32.373, lon: -64.658, role: "island", side: "east", shape: "islet" }),
      Object.freeze({ name: "Smith's Fort", from: 1612, lat: 32.371, lon: -64.658, role: "island", side: "east", shape: "islet" }),
      Object.freeze({ name: "King's Castle", from: 1612, lat: 32.357, lon: -64.69, role: "island", side: "south", shape: "islet", rough: true }),
    ]),
  }),
  "plymouth-colony": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Plymouth fort-meetinghouse on Fort (Burial) Hill", from: 1621, lat: 41.9575, lon: -70.662, role: "citadel", shape: "fitted", earth: true, rough: true, encloses: "square" }),
    ]),
  }),
  "charleston": Object.freeze({
    seaward: 140,
    forts: Object.freeze([
      Object.freeze({ name: "Granville Bastion", from: 1697, lat: 32.77325, lon: -79.92758, role: "waterfront", side: "east", shape: "star" }),
      Object.freeze({ name: "Half Moon Battery", from: 1704, until: 1768, lat: 32.7742, lon: -79.927, role: "waterfront", side: "east", shape: "battery", rough: true }),
      Object.freeze({ name: "Fort Johnson", from: 1708, lat: 32.7523, lon: -79.9005, role: "headland", side: "south", shape: "battery", earth: true, rough: true }),
    ]),
  }),
  "philadelphia": Object.freeze({
    seaward: 180,
    forts: Object.freeze([
      Object.freeze({ name: "Association (Grand) Battery", from: 1747, lat: 39.9385, lon: -75.1425, role: "waterfront", side: "west", shape: "battery", rough: true }),
      Object.freeze({ name: "Society Hill Battery", from: 1747, lat: 39.945, lon: -75.1408, role: "waterfront", side: "west", shape: "battery", rough: true }),
    ]),
  }),
  "cadiz-sanlucar": Object.freeze({
    seaward: 290,
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de Santiago, Sanlúcar de Barrameda", from: 1477, lat: 36.7818, lon: -6.3538, role: "citadel", side: "south", shape: "fitted", rough: true }),
    ]),
  }),
  "palos-huelva": Object.freeze({
    seaward: 200,
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de Palos de la Frontera", from: 1322, lat: 37.2297, lon: -6.8935, role: "river", side: "north", shape: "fitted", rough: true }),
      Object.freeze({ name: "Torre de la Arenilla", from: 1550, lat: 37.213, lon: -6.94, role: "mouth", side: "north", shape: "drum", rough: true }),
    ]),
  }),
  "la-coruna": Object.freeze({
    seaward: 330,
    anchorage: Object.freeze([43.365,-8.395]),
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Antón", from: 1587, lat: 43.3659, lon: -8.3903, role: "island", shape: "islet", rough: true }),
    ]),
  }),
  "las-palmas": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de la Luz", from: 1494, lat: 28.1573, lon: -15.4162, role: "headland", side: "north", shape: "headland", rough: true }),
      Object.freeze({ name: "Torreón de San Pedro Mártir (Castillo de San Cristóbal)", from: 1578, lat: 28.116, lon: -15.429, role: "waterfront", side: "south", shape: "drum", rough: true }),
      Object.freeze({ name: "Castillo de Mata", from: 1577, lat: 28.139, lon: -15.431, role: "waterfront", side: "north", shape: "battery", rough: true }),
    ]),
  }),
  "tenerife": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Castillo de San Cristóbal", from: 1575, lat: 28.4678, lon: -16.2478, role: "waterfront", shape: "battery", rough: true }),
      Object.freeze({ name: "Castillo de San Juan Bautista", from: 1641, lat: 28.472, lon: -16.2415, role: "waterfront", side: "north", shape: "battery", rough: true }),
      Object.freeze({ name: "Fortaleza de Paso Alto", from: 1600, lat: 28.459, lon: -16.2345, role: "waterfront", side: "south", shape: "battery", rough: true }),
    ]),
  }),
  "funchal": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza de São Lourenço", from: 1529, lat: 32.6445, lon: -16.9145, role: "waterfront", side: "west", shape: "star", rough: true }),
      Object.freeze({ name: "Forte de São Tiago", from: 1614, lat: 32.6446, lon: -16.9027, role: "waterfront", side: "east", shape: "battery", rough: true }),
      Object.freeze({ name: "Fortaleza de São João Baptista do Pico", from: 1600, lat: 32.6528, lon: -16.911, role: "citadel", side: "north", shape: "fitted", rough: true }),
    ]),
  }),
  "angra": Object.freeze({
    anchorage: Object.freeze([38.65,-27.22]),
    forts: Object.freeze([
      Object.freeze({ name: "Fortaleza de São João Baptista (São Filipe) on Monte Brasil", from: 1594, lat: 38.648, lon: -27.229, role: "headland", side: "west", shape: "star", rough: true }),
      Object.freeze({ name: "Forte (Castelo) de São Sebastião", from: 1580, lat: 38.6523, lon: -27.2133, role: "headland", side: "east", shape: "battery", rough: true }),
    ]),
  }),
  "ribeira-grande": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "Forte Real de São Filipe", from: 1587, lat: 14.9205, lon: -23.604, role: "citadel", side: "north", shape: "star", rough: true }),
    ]),
  }),
  "goa": Object.freeze({
    seaward: 265,
    anchorage: Object.freeze([15.502,73.82]),
    forts: Object.freeze([
      Object.freeze({ name: "Fort Aguada", from: 1612, lat: 15.4927, lon: 73.7732, role: "mouth", side: "north", shape: "headland", rough: true }),
      Object.freeze({ name: "Reis Magos Fort", from: 1551, lat: 15.5006, lon: 73.8062, role: "narrows", side: "north", shape: "battery", rough: true }),
      Object.freeze({ name: "Cabo fort (Cabo Raj Niwas)", from: 1540, lat: 15.457, lon: 73.804, role: "headland", side: "south", shape: "headland", rough: true }),
      Object.freeze({ name: "Fort of Gaspar Dias", from: 1589, lat: 15.48, lon: 73.81, role: "narrows", side: "south", shape: "battery", rough: true }),
    ]),
  }),
  "malacca": Object.freeze({
    forts: Object.freeze([
      Object.freeze({ name: "A Famosa", from: 1511, lat: 2.193, lon: 102.2505, role: "waterfront", side: "east", shape: "star", rough: true }),
    ]),
  }),
  "nagasaki": Object.freeze({
    seaward: 220,
    forts: Object.freeze([
      Object.freeze({ name: "Megami Battery", from: 1634, lat: 32.725, lon: 129.856, role: "mouth", shape: "battery", earth: true, rough: true }),
    ]),
  }),
  "manila": Object.freeze({
    seaward: 250,
    forts: Object.freeze([
      Object.freeze({ name: "Fort Santiago", from: 1590, lat: 14.5958, lon: 120.966, role: "mouth", side: "north", shape: "star", rough: true }),
    ]),
  }),
  "batavia": Object.freeze({
    seaward: 0,
    forts: Object.freeze([
      Object.freeze({ name: "Batavia Castle", from: 1619, lat: -6.131, lon: 106.812, role: "waterfront", side: "west", shape: "star", sizeM: [120,120], rough: true }),
    ]),
  }),
  "cape-town": Object.freeze({
    seaward: 340,
    forts: Object.freeze([
      Object.freeze({ name: "Fort de Goede Hoop", from: 1652, lat: -33.9255, lon: 18.4235, role: "waterfront", side: "south", shape: "star", earth: true, rough: true, encloses: "square" }),
      Object.freeze({ name: "Castle of Good Hope", from: 1666, lat: -33.9258, lon: 18.424, role: "waterfront", side: "south", shape: "star", bastions: 5, sizeM: [120,120], rough: true }),
      Object.freeze({ name: "Duynhoop redoubt", from: 1654, until: 1672, lat: -33.904, lon: 18.454, role: "headland", side: "east", shape: "star", earth: true, rough: true }),
      Object.freeze({ name: "Chavonnes Battery", from: 1726, lat: -33.919, lon: 18.42, role: "waterfront", side: "north", shape: "battery", rough: true }),
    ]),
  }),
});

// What stood at a port in a given year, in the order of the record.
export function fortRecordsFor(portId, year) {
  const record = FORT_RECORDS[portId];
  if (!record) return { seaward: null, channel: null, anchorage: null, forts: [] };
  return { seaward: record.seaward ?? null, channel: record.channel ?? null, anchorage: record.anchorage ?? null, forts: record.forts.filter((fort) => fort.from <= year && !(fort.until && fort.until <= year)) };
}
