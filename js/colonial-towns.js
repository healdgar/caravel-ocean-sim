// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The towns Spain and Portugal planted overseas, each founded by Castle and Commons' model in the manner its crown laid
// its towns out by (scripts/board-colonial.mjs: the Spanish traza, the Portuguese hill town) and baked as an Old World
// city is (scripts/bake-board.mjs; js/old-world.js stands it). From the colony's founding a port of these is its town.
//   `port` is the coast (js/coastal-world.js) whose ground holds the town and under whose name its board is baked;
//   `latitude` and `longitude` its plaza, or for a hill town its landing (the upper town is found on the ground);
//   `culture` its tongue in the model; `manner` how its crown laid it out; `founded` its year; `people` by year, as
//   for an Old World city; `seat` how many times the model's capital the town is (a house of these towns, of one
//   storey about its patio, holds some seven, against the Old World city's twenty: people / 4500); `walls` what each
//   kind of its places is ringed by; `settled` the share of an Old World country's towns and villages its country
//   holds; `places` real neighbours, as OLD_WORLD_PLACES.
// A town whose seat lay off its port's ground stands as the landing that was there: La Antigua's Veracruz stood 25 km
// from San Juan de Ulúa, whose ground held the ventas of Buitrón; Coro stood inland of La Vela; Lima of Callao; La
// Laguna of Santa Cruz; Old Goa up the Mandovi from Pangim. Nagasaki (a port from 1571) and Saba (settled from 1640)
// held no planted town in 1550 and are left out.
// Sources: López de Velasco, Geografía y descripción universal de las Indias (1574) for the Spanish towns' vecinos;
// Gabriel Soares de Sousa (1587) and Gândavo (1576) for Brazil; Frutuoso, Saudades da Terra (c. 1590), for the
// islands; Boxer 1969 for Goa and Malacca. Counts are judgements of the period's estimates, slaves and servants with
// the vecinos' households.
const COLONIAL_SPAIN = { culture: 'iberian', manner: 'traza' }, COLONIAL_PORTUGAL = { culture: 'portuguese', manner: 'ladeira' };
const COLONIAL_OPEN = { capital: 0, town: 0, village: 0 };
export const COLONIAL_TOWNS = Object.freeze([
  { id: 'santo-domingo', name: 'Santo Domingo', port: 'santo-domingo', latitude: 18.4733, longitude: -69.8844, ...COLONIAL_SPAIN, founded: 1502, people: [[1550, 4000]], seat: 0.89, settled: 0.35 },
  { id: 'la-habana', name: 'San Cristóbal de La Habana', port: 'havana', latitude: 23.1404, longitude: -82.3503, ...COLONIAL_SPAIN, founded: 1519, people: [[1550, 800]], seat: 0.18, settled: 0.25 },
  { id: 'san-juan', name: 'San Juan', port: 'san-juan', latitude: 18.4655, longitude: -66.1161, ...COLONIAL_SPAIN, founded: 1521, people: [[1550, 1500]], seat: 0.33, settled: 0.3 },
  { id: 'cartagena', name: 'Cartagena de Indias', port: 'cartagena', latitude: 10.4236, longitude: -75.5513, ...COLONIAL_SPAIN, founded: 1533, people: [[1550, 2000]], seat: 0.44, settled: 0.25 },
  { id: 'nombre-de-dios', name: 'Nombre de Dios', port: 'nombre-de-dios', latitude: 9.5840, longitude: -79.4730, ...COLONIAL_SPAIN, founded: 1510, people: [[1550, 500]], seat: 0.11, settled: 0.15 },
  { id: 'buitron', name: 'Ventas de Buitrón', port: 'veracruz', latitude: 19.2000, longitude: -96.1370, ...COLONIAL_SPAIN, founded: 1525, people: [[1550, 300]], seat: 0.07, settled: 0.2 },
  { id: 'campeche', name: 'San Francisco de Campeche', port: 'campeche', latitude: 19.8455, longitude: -90.5365, ...COLONIAL_SPAIN, founded: 1540, people: [[1550, 600]], seat: 0.13, settled: 0.25 },
  { id: 'santa-marta', name: 'Santa Marta', port: 'santa-marta', latitude: 11.2421, longitude: -74.2119, ...COLONIAL_SPAIN, founded: 1525, people: [[1550, 400]], seat: 0.09, settled: 0.15 },
  { id: 'cumana', name: 'Cumaná', port: 'cumana', latitude: 10.4630, longitude: -64.1757, ...COLONIAL_SPAIN, founded: 1521, people: [[1550, 200]], seat: 0.05, settled: 0.15 },
  { id: 'la-vela', name: 'La Vela de Coro', port: 'coro', latitude: 11.4570, longitude: -69.5680, ...COLONIAL_SPAIN, founded: 1528, people: [[1550, 150]], seat: 0.04, settled: 0.2 },
  { id: 'panama', name: 'Nuestra Señora de la Asunción de Panamá', port: 'panama-viejo', latitude: 9.0059, longitude: -79.4853, ...COLONIAL_SPAIN, founded: 1519, people: [[1550, 4000]], seat: 0.89, settled: 0.3 },
  { id: 'acapulco', name: 'Acapulco', port: 'acapulco', latitude: 16.8500, longitude: -99.9050, ...COLONIAL_SPAIN, founded: 1550, people: [[1550, 100]], seat: 0.03, settled: 0.1 },
  { id: 'santiago-de-cuba', name: 'Santiago de Cuba', port: 'santiago-de-cuba', latitude: 20.0217, longitude: -75.8294, ...COLONIAL_SPAIN, founded: 1515, people: [[1550, 600]], seat: 0.13, settled: 0.25 },
  { id: 'trujillo', name: 'Trujillo', port: 'trujillo', latitude: 15.9167, longitude: -85.9533, ...COLONIAL_SPAIN, founded: 1525, people: [[1550, 400]], seat: 0.09, settled: 0.2 },
  { id: 'callao', name: 'El Callao', port: 'callao', latitude: -12.0566, longitude: -77.1491, ...COLONIAL_SPAIN, founded: 1537, people: [[1550, 400]], seat: 0.09, settled: 0.3 },
  { id: 'las-palmas', name: 'Real de Las Palmas', port: 'las-palmas', latitude: 28.1004, longitude: -15.4152, ...COLONIAL_SPAIN, founded: 1478, people: [[1550, 4000]], seat: 0.89, settled: 0.6 },
  { id: 'santa-cruz', name: 'Santa Cruz de Tenerife', port: 'tenerife', latitude: 28.4660, longitude: -16.2480, ...COLONIAL_SPAIN, founded: 1494, people: [[1550, 600]], seat: 0.13, settled: 0.6 },
  { id: 'funchal', name: 'Funchal', port: 'funchal', latitude: 32.6470, longitude: -16.9085, ...COLONIAL_PORTUGAL, founded: 1424, people: [[1550, 5000]], seat: 1.11, settled: 0.7 },
  { id: 'angra', name: 'Angra', port: 'angra', latitude: 38.6545, longitude: -27.2194, ...COLONIAL_PORTUGAL, founded: 1450, people: [[1550, 4000]], seat: 0.89, settled: 0.7 },
  { id: 'ribeira-grande', name: 'Ribeira Grande', port: 'ribeira-grande', latitude: 14.9140, longitude: -23.6050, ...COLONIAL_PORTUGAL, founded: 1462, people: [[1550, 2000]], seat: 0.44, settled: 0.4 },
  { id: 'salvador', name: 'São Salvador', port: 'salvador-da-bahia', latitude: -12.9725, longitude: -38.5145, ...COLONIAL_PORTUGAL, founded: 1549, people: [[1550, 1000]], seat: 0.22, settled: 0.15 },
  { id: 'sao-vicente', name: 'São Vicente', port: 'sao-vicente', latitude: -23.9636, longitude: -46.3919, ...COLONIAL_PORTUGAL, founded: 1532, people: [[1550, 600]], seat: 0.13, settled: 0.25 },
  { id: 'olinda', name: 'Olinda', port: 'olinda', latitude: -8.0170, longitude: -34.8530, ...COLONIAL_PORTUGAL, founded: 1535, people: [[1550, 2500]], seat: 0.56, settled: 0.3 },
  { id: 'pangim', name: 'Pangim', port: 'goa', latitude: 15.4990, longitude: 73.8270, ...COLONIAL_PORTUGAL, founded: 1510, people: [[1550, 600]], seat: 0.13, settled: 0.6 },
  { id: 'malaca', name: 'Malaca', port: 'malacca', latitude: 2.1948, longitude: 102.2480, ...COLONIAL_PORTUGAL, founded: 1511, people: [[1550, 6000], [1600, 8000]], seat: 1.33, settled: 0.5, walls: { capital: 1, town: 0, village: 0 } },
  { id: 'jamestown', name: 'Jamestown', port: 'jamestown', latitude: 37.2088, longitude: -76.7778, culture: 'anglo', founded: 1607, people: [[1607, 104], [1620, 400], [1690, 800]], seat: 0.05, settled: 0.08 },
].map((town) => Object.freeze({ walls: COLONIAL_OPEN, places: [], ...town, colonial: true, people: Object.freeze(town.people.map(Object.freeze)) })));
const COLONIAL_METRES_PER_DEGREE = 111195;

// The planted town whose recorded site lies on a region's own ground from its founding on, or none: the town its
// board founds there.
export function colonialTownHeld(region) {
  if (!region || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude)) return null;
  const year = region.year ?? 1550, geoSpan = region.demGeoSpan || (region.span < 4000 ? 6800 : region.span), scale = region.span / geoSpan, half = region.span / 2;
  const cos = Math.max(0.1, Math.cos(region.latitude * Math.PI / 180));
  let best = null, least = Infinity;
  for (const town of COLONIAL_TOWNS) {
    if (region.id && region.id !== town.port || year < town.founded) continue;
    const x = (town.longitude - region.longitude) * COLONIAL_METRES_PER_DEGREE * cos * scale, z = (region.latitude - town.latitude) * COLONIAL_METRES_PER_DEGREE * scale;
    if (Math.abs(x) >= half || Math.abs(z) >= half) continue;
    if (Math.hypot(x, z) < least) { least = Math.hypot(x, z); best = town; }
  }
  return best;
}
