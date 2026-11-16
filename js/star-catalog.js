// HYG v4.1 derivative, CC BY-SA 4.0, David Nash / Astronexus.
// Pinned c7f7f883fe678cc7680169a50ccd7dcc49b060ce. See vendor/hyg.LICENSE.
// HIP, proper name, J2000 xyz parsecs, velocity xyz parsecs/year, V magnitude, B-V.
// Authored illustrative asterisms, not IAU constellation boundaries.
export const HYG_STARS_ASSET = "assets/world/hyg-stars.bin";
export const POLARIS_TUPLE = Object.freeze([11767,"Polaris",0.010127477916076178,0.007890734327249536,0.9999175818550426,-9e-8,2e-7,-1.3e-7,1.9642857142857144,0.64]);

const STAR_NAMES = new Map("7:Alpheratz|8:Caph|17:Algenib|32:Ankaa|50:Fulu|56:Schedar|63:Diphda|76:Achird|88:Castula|89:Cih|105:Wurren|109:Mirach|115:Revati|125:Adhil|129:Ruchbah|139:Alpherg|143:Titawin|144:Achernar|145:Nembus|157:Torcular|163:Baten Kaitos|164:Mothallah|166:Mesarthim|170:Segin|171:Sheratan|187:Alrescha|192:Almach|197:Hamal|231:Polaris|250:Kaffaljidhma|259:Lilii Borea|264:Bharani|268:Miram|269:Angetenar|273:Azha|277:Acamar|286:Menkar|297:Algol|299:Misam|301:Botein|303:Dalim|306:Zibal|316:82 G. Eri|326:Mirfak|342:Ran|353:Rana|355:Atik|357:Celaeno|358:Electra|360:Taygeta|362:Maia|365:Merope|368:Alcyone|373:Atlas|374:Pleione|392:Zaurak|394:Menkib|417:Beid|427:Keid|439:Prima Hyadum|449:Secunda Hyadum|452:Beemim|464:Ain|465:Chamukuy|478:Theemin|480:Aldebaran|486:Sceptrum|507:Tabit|526:Hassaleh|535:Almaaz|537:Saclateni|548:Haedus|554:Cursa|569:Rigel|573:Capella|601:Bellatrix|602:Elnath|608:Nihal|618:Mintaka|623:Arneb|631:Meissa|636:Hatysa|639:Alnilam|641:Tianguan|647:Phact|650:Alnitak|664:Saiph|674:Wazn|687:Betelgeuse|696:Menkalinan|697:Mahasim|713:Elkurud|729:Propus|745:Furud|749:Mirzam|750:Tejat|752:Canopus|777:Alhena|789:Mebsuta|793:Sirius|794:Alzirr|836:Adhara|840:Nganurganity|847:Muliphein|850:Mekbuda|854:Wezen|890:Wasat|900:Aludra|909:Gomeisa|930:Castor|939:Jishui|940:Procyon|958:Pollux|973:Azmidi|1005:Naos|1011:Tureis|1025:Tegmine|1033:Tarf|1043:Avior|1045:Alsciaukat|1055:Muscida|1067:Minchir|1089:Asellus Borealis|1094:Asellus Australis|1095:Alsephina|1101:Ashlesha|1124:Acubens|1126:Talitha|1135:Alkaphrah|1143:Suhail|1148:Nahn|1155:Miaplacidus|1171:Aspidiske|1181:Markeb|1188:Alphard|1191:Intercrus|1201:Alterf|1224:Ukdah|1227:Subra|1234:Ras Elased Australis|1241:Zhang|1246:Rasalas|1248:Felis|1263:Regulus|1274:Adhafera|1276:Tania Borealis|1280:Algieba|1283:Tania Australis|1346:Praecipua|1355:Chalawan|1356:Alkes|1363:Merak|1365:Dubhe|1380:Zosma|1381:Chertan|1386:Alula Borealis|1406:Giausar|1439:Taiyangshou|1448:Denebola|1451:Zavijava|1455:Phecda|1475:Alchiba|1481:Imai|1482:Megrez|1483:Gienah|1493:Zaniah|1498:Ginan|1508:Acrux|1516:Algorab|1520:Gacrux|1526:Chara|1528:Kraz|1541:Porrima|1547:La Superba|1553:Tianyi|1554:Mimosa|1561:Alioth|1568:Taiyi|1569:Minelauva|1571:Cor Caroli|1577:Vindemiatrix|1588:Diadem|1612:Mizar|1615:Spica|1616:Alcor|1629:Heze|1646:Alkaid|1659:Muphrid|1670:Hadar|1671:Thuban|1674:Menkent|1685:Kang|1689:Arcturus|1690:Syrma|1692:Xuange|1695:Khambalia|1718:Elgafar|1722:Seginus|1729:Toliman|1730:Rigil Kentaurus|1741:Izar|1753:Kochab|1754:Zubenelgenubi|1772:Nekkar|1777:Brachium|1798:Zubeneschamali|1807:Pherkad|1818:Alkalurops|1820:Edasich|1825:Nusakan|1838:Alphecca|1842:Zubenelhakrabi|1866:Unukalhai|1871:Gudja|1893:Iklil|1899:Fang|1903:Dschubba|1914:Acrab|1915:Acrab B|1921:Marsic|1929:Jabbah|1936:Yed Prior|1946:Yed Posterior|1954:Alniyat|1962:Athebyne|1967:Cujam|1978:Antares|1981:Kornephoros|1984:Marfik|1995:Paikauhale|2013:Atria|2017:Larawag|2021:Xamidimura|2022:Pipirima|2046:Aldhibah|2049:Sabik|2053:Rasalgethi|2054:Sarin|2056:Guniibuu|2086:Rastaban|2087:Maasym|2088:Lesath|2094:Yildun|2096:Shaula|2097:Rasalhague|2103:Sargas|2110:Dziban|2113:Cebalrai|2114:Cervantes|2124:Fuyue|2127:Grumium|2131:Eltanin|2151:Alnasl|2171:Polis|2186:Kaus Media|2200:Kaus Australis|2204:Fafnir|2208:Kaus Borealis|2230:Vega|2257:Sheliak|2263:Ainalrami|2271:Nunki|2273:Alya|2274:Alya B|2286:Sulafat|2294:Ascella|2301:Okab|2312:Meridiana|2313:Albaldah|2317:Altais|2320:Aladfar|2337:Arkab Prior|2340:Arkab Posterior|2341:Rukbat|2350:Anser|2354:Albireo|2355:Albireo B|2357:Alsafi|2374:Sham|2383:Fawaris|2384:Tarazed|2395:Altair|2403:Libertas|2405:Alshain|2407:Terebellum|2458:Algedi|2461:Alshat|2462:Dabih|2464:Sadr|2467:Peacock|2477:Aldulfin|2484:Rotanev|2494:Sualocin|2498:Deneb|2509:Aljanah|2516:Albali|2554:Polaris Australis|2565:Kitalpha|2571:Alderamin|2588:Alfirk|2593:Sadalsuud|2599:Bunda|2603:Nashira|2609:Azelfafage|2615:Enif|2623:Deneb Algedi|2630:Aldhanab|2639:Kurhah|2645:Sadalmelik|2650:Alnair|2657:Biham|2674:Ancha|2685:Sadachbia|2710:Situla|2716:Homam|2719:Tiaki|2720:Matar|2734:Sadalbari|2742:Skat|2747:Helvetios|2748:Fomalhaut|2756:Scheat|2757:Fumalsamakah|2760:Markab|2790:Salm|2796:Alkarab|2803:Veritate|2814:Errai|2849:Castor B|2852:Alula Australis|2853:Alula Australis B|2857:Graffias|2861:Guniibuu B".split("|").filter(Boolean).map(e => {
  const k = e.indexOf(":");
  return [+e.slice(0, k), e.slice(k + 1)];
}));

export function decodeOceanStars(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const n = 2865, res = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 15;
    let ox = dv.getInt16(o, true) / 32767, oy = dv.getInt16(o + 2, true) / 32767;
    const oz = 1 - Math.abs(ox) - Math.abs(oy);
    if (oz < 0) {
      const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
      oy = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
      ox = tx;
    }
    const rl = 1 / Math.hypot(ox, oy, oz);
    res[i] = [
      u[o + 10] | (u[o + 11] << 8) | (u[o + 12] << 16),
      STAR_NAMES.get(i) || "",
      ox * rl, oy * rl, oz * rl,
      dv.getInt16(o + 4, true) * 1e-8,
      dv.getInt16(o + 6, true) * 1e-8,
      dv.getInt16(o + 8, true) * 1e-8,
      u[o + 13] / 28 - 2,
      dv.getInt8(o + 14) * 0.02,
    ];
  }
  return res;
}

let cachedStars = null, pendingStars = null;

export async function loadOceanStars() {
  if (cachedStars) return cachedStars;
  if (pendingStars) return pendingStars;
  pendingStars = (async () => {
    if (typeof process !== "undefined" && process.versions?.node && !HYG_STARS_ASSET.startsWith("data:") && typeof process.getBuiltinModule === "function") {
      return getOceanStars();
    }
    const res = await fetch(HYG_STARS_ASSET);
    if (!res.ok) throw new Error("Failed to fetch star catalog (" + res.status + ")");
    cachedStars = decodeOceanStars(new Uint8Array(await res.arrayBuffer()));
    return cachedStars;
  })();
  return pendingStars;
}

export function getOceanStars() {
  if (cachedStars) return cachedStars;
  if (typeof process !== "undefined" && process.versions?.node && typeof process.getBuiltinModule === "function") {
    const fsSync = process.getBuiltinModule("node:fs");
    const pathMod = process.getBuiltinModule("node:path");
    const urlMod = process.getBuiltinModule("node:url");
    const dir = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
    cachedStars = decodeOceanStars(fsSync.readFileSync(pathMod.resolve(dir, "../assets/world/hyg-stars.bin")));
    return cachedStars;
  }
  return [POLARIS_TUPLE];
}

export const OCEAN_STARS = (typeof process !== "undefined" && process.versions?.node && typeof process.getBuiltinModule === "function")
  ? getOceanStars()
  : [POLARIS_TUPLE];

export const OCEAN_CONSTELLATIONS=[
[11767,85822],
[53910,54061,59774,58001,53910],[59774,62956,65378,67301],
[24436,25336,25930,26311,26727,27366,24436],[25336,27989,26727],
[8886,6686,4427,3179,746],
[61084,60718,62434],[59747,60718],
[91262,91971,92420,93194,92791,91971],
[113368,107315,109268,112122,113368]
];
