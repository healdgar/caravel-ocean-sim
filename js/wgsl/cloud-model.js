// Adapted from Joshua Brewster, MIT. See THIRD_PARTY_NOTICES.md for pinned provenance.
// Retains the upstream rounded cumulus/anvil anatomy; units here are kilometres.
export const CLOUD_MODEL = /* wgsl */ `
fn mix_f(a:f32,b:f32,t:f32)->f32 { return mix(a,b,t); }
fn contrast01(x:f32,k:f32)->f32 { return saturate((x-0.5)*k+0.5); }
fn ridge01(x:f32)->f32 { return 1.0-abs(x*2.0-1.0); }
fn hash11Fast(x:f32)->f32 {
  var p=fract(x*0.1031); p=p*(p+33.33); p=p*(p+p); return fract(p);
}
fn cloudCellRandom(cell:vec2f,offset:f32)->f32 {
  let id=cell-floor(cell/8.0)*8.0;
  return hash11Fast(dot(id,vec2f(127.1,311.7))+offset);
}
// Periodic value noise is baked, never evaluated along every screen ray.
fn cloudHash(p:vec3f,period:f32)->f32 {
  let q=vec3u(p-floor(p/period)*period);
  var h=(q.x*1597334677u) ^ (q.y*3812015801u) ^ (q.z*2798796415u);
  h=(h^(h>>16u))*2246822519u; h=(h^(h>>13u))*3266489917u;
  return f32((h^(h>>16u))>>8u)/16777216.0;
}
fn cloudNoise(p:vec3f,period:f32)->f32 {
  let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(mix(cloudHash(i,period),cloudHash(i+vec3f(1,0,0),period),u.x),
    mix(cloudHash(i+vec3f(0,1,0),period),cloudHash(i+vec3f(1,1,0),period),u.x),u.y),
    mix(mix(cloudHash(i+vec3f(0,0,1),period),cloudHash(i+vec3f(1,0,1),period),u.x),
    mix(cloudHash(i+vec3f(0,1,1),period),cloudHash(i+vec3f(1,1,1),period),u.x),u.y),u.z);
}
fn cloudEllipsoid(p: vec3<f32>, center: vec3<f32>, radius: vec3<f32>) -> f32 {
  return 1.0 - length((p - center) / max(radius, vec3<f32>(0.01)));
}

fn cloudSoftUnion(a: f32, b: f32) -> f32 {
  let h = max(0.26 - abs(a - b), 0.0) / 0.26;
  return max(a, b) + h * h * 0.065;
}

// Return fine density, macro density and signed form independently. Coverage
// activates growing billows from the base upward, never rescales tower height.
// Cell identity, weather and shape noise travel together with horizontal wind.
// Only the rounded presets use this field; the original layer is untouched.
fn roundedCloudBody(p: vec3<f32>, shape: vec4<f32>, detail: vec3<f32>) -> vec3<f32> {
  let cellSize = max(2.0, 0.75);
  let windOffset = vec2<f32>(0.0);
  let cell = floor((p.xz + windOffset) / cellSize);
  let stormSystem = select(0.0, 3.0, BAKE.shape.z > 0.55) >= 2.5;
  let layerHeight = BAKE.shape.y;
  var body = -1.0;
  var fine = 0.0;
  var macroAmount = 0.0;
  // Rain Shelf's useful structure comes from remapping the base against its
  // other three shape bands, not from adding noise to a filled primitive's skin.
  // Keep that small density closure in this entrypoint, outside the cell loop;
  // do not pull the legacy ray/light call graph into the field compiler.
  let definition = 0.75;
  let fbm = dot(shape.gba, vec3<f32>(0.625, 0.25, 0.125));
  let baseShape = contrast01(shape.r, 1.24 + definition * 0.38);
  let shelfShape = saturate((baseShape - fbm * 0.72) / max(1.0 - fbm * 0.72, 0.08));
  let detailMid = dot(detail, vec3<f32>(0.42, 0.34, 0.24));
  let scallopSignal = mix_f(max(max(detail.r, detail.g), detail.b),
    1.0 - min(min(detail.r, detail.g), detail.b), 0.42);
  let valley = pow(1.0 - ridge01(contrast01(scallopSignal, 2.4)), 1.35);
  // Noise shapes the entire volume, but fine erosion must not turn a mature
  // thunderhead into disconnected translucent vapor. A noisy interior support
  // below preserves bulk while the same breakup still defines its outer folds.
  let structure = (shelfShape - 0.22) * 0.55 + (fbm - 0.5) * 0.20;
  let erosion = (detailMid * 0.10 + valley * mix_f(0.08, 0.18, definition));
  for (var z = -1; z <= 1; z++) {
    for (var x = -1; x <= 1; x++) {
      let id = cell + vec2<f32>(f32(x), f32(z));
      let r0 = cloudCellRandom(id, 3.1);
      let r1 = cloudCellRandom(id, 17.3);
      let r2 = cloudCellRandom(id, 41.7);
      let materialCenterXZ = (id + 0.5 + (vec2<f32>(r0, r1) - 0.5) * 0.42) * cellSize;
      let centerXZ = materialCenterXZ - windOffset;
      let weatherScale = select(1.0, 1.0, 1.0 == 0.0);
      // Sample weather in the co-moving domain, not underneath a stationary
      // lattice. Its separate slow offset can evolve cells without wind itself
      // pumping their height. Anatomy is selected independently below.
      let weather = vec4<f32>(cloudNoise(vec3<f32>(materialCenterXZ.x, 0.0, materialCenterXZ.y) * 0.25, 4.0), 0.5, 0.0, 1.0);
      // A storm scene is a population, not a wall of identical thunderheads.
      // Stable material-cell identity selects scattered convective storms;
      // the remaining cells form lower fair-weather cumulus in the same box.
      // Selection travels with wind and does not toggle as weather evolves.
      // Never compare the identity seed with moving weather: that replaced
      // small cumulus with a full thunderhead in one frame at the threshold.
      // Weather controls continuous development, not this cell's anatomy.
      let stormCell = cloudCellRandom(id, 237.9) < 0.27;
      let anvil = select(BAKE.shape.z > 0.65, stormCell, stormSystem);
      let convective = anvil || (select(0.0, 3.0, BAKE.shape.z > 0.55) >= 1.5 && select(0.0, 3.0, BAKE.shape.z > 0.55) < 2.5);
      // Material-cell variation survives wind and weather transitions. Rotate
      // the anatomy, not the noise, so adjacent storms have different outflow
      // directions without seams or another texture lookup per lobe.
      let variant = cloudCellRandom(id, 312.7);
      // Independent width seed: broad storms need not share noise/lean variants.
      // 30% have a full broad base; another 28% span intermediate widths.
      let widthVariant = cloudCellRandom(id, 383.1);
      let broadBase = select(0.0, 1.0 - smoothstep(0.30,0.58,widthVariant), convective);
      let aspect = select(1.0, mix_f(0.85, 1.15, variant), convective);
      let turn = cloudCellRandom(id, 329.1) * 6.283185;
      let cs = cos(turn); let sn = sin(turn);
      let relative = p.xz - centerXZ;
      let anatomyP = select(p, vec3<f32>(centerXZ.x + (relative.x * cs + relative.y * sn) / aspect,
        p.y, centerXZ.y + (-relative.x * sn + relative.y * cs) * aspect), convective);
      let shear = select(vec2<f32>(0.0), (vec2<f32>(r1, variant) - 0.5) * cellSize * mix_f(0.29, 0.40, r0) * 0.30, convective);
      let cellBands = mix(shape.gba, shape.abg, select(0.0, variant, convective));
      let cellFbm = dot(cellBands, vec3<f32>(0.625, 0.25, 0.125));
      let cellBase = contrast01(mix_f(shape.r, shape.g, select(0.0, variant * 0.22, convective)), 1.24 + definition * 0.38);
      let cellShelf = saturate((cellBase - cellFbm * 0.72) / max(1.0 - cellFbm * 0.72, 0.08));
      let cellStructure = select(structure, (cellShelf - 0.22) * mix_f(0.49, 0.67, variant) + (cellFbm - 0.5) * 0.20, convective);
      let coverage = clamp(BAKE.shape.x * mix_f(0.78, 1.0, saturate(weather.r)) * mix_f(1.0, 0.72, saturate(0.12)), 0.0, 1.0);
      let weatherMaturity = smoothstep(r2 - 0.38, r2 + 0.38, coverage);
      // Cycle storms develop upper billows, never stretch the whole column.
      let stormDevelopment = smoothstep(0.08, 1.0, BAKE.shape.z);
      let maturity = select(weatherMaturity, mix_f(min(weatherMaturity, 0.28), weatherMaturity, stormDevelopment), select(0.0, 3.0, BAKE.shape.z > 0.55) > 3.5 && stormCell);
      // Include noisy/scalloped lobes in the neighborhood bound, not just the
      // hidden ellipsoids. With center jitter <= .21 cells, this 1.28-cell
      // support ends before a center can drop out of the 3x3 search (.21+1.28<1.5).
      let footprintFade = select(1.0, 1.0 - smoothstep(cellSize * 1.12, cellSize * 1.28,
        max(abs(relative.x),abs(relative.y))), convective);
      let presence = maturity * footprintFade * smoothstep(0.0, 0.12, BAKE.shape.x) * (1.0 - smoothstep(0.85, 1.0, weather.b));
      if (presence <= 0.00001) { continue; }
      let heightVariation = clamp(0.32, 0.0, 0.9);
      let heightFraction = mix_f(0.93, 0.93 - heightVariation, r1);
      // Weather-organized storm families share feeder banks, not a regiment of
      // equally tall stalks. Cell-local height/width remain stable under wind.
      let stormHeight = mix_f(0.52, 1.0, cloudCellRandom(id, 347.3));
      let columnHeight = layerHeight * heightFraction * select(1.0, stormHeight, anvil) * mix_f(1.0, 0.85, broadBase)
        * select(1.0, mix_f(0.22, 0.54, r0), stormSystem && !stormCell);
      let base = 0.0 + layerHeight * 0.07;
      let radiusXZ = cellSize * mix_f(0.29, select(0.43, 0.40, anvil), r0)
        * select(1.0, mix_f(0.68, 1.35, cloudCellRandom(id, 361.7)), convective);
      // The existing per-voxel edge fade lets drifting cells enter/leave the
      // volume smoothly. Rejecting whole centers here would make them pop.
      let coreGrowth = max(0.03, sqrt(smoothstep(0.0, 0.65, maturity)));
      let coreRadiusY = min(columnHeight * 0.22, radiusXZ * mix_f(0.80,0.66,broadBase));
      let coreY = base + coreRadiusY * coreGrowth;
      let coreCenter = vec3<f32>(centerXZ.x, coreY, centerXZ.y);
      // No clamped-Y extrusion: that made a dense straight stalk beneath a cap.
      // Base breadth is independent of the crown: broad storm decks feed a
      // rising neck alongside slimmer columns, rather than scaling an entire
      // cloud up/down. Broad footprints remain inside the 3x3 cell search.
      var localBody = cloudEllipsoid(anatomyP, coreCenter, vec3<f32>(radiusXZ * mix_f(1.14,1.95,broadBase), coreRadiusY, radiusXZ * mix_f(0.98,1.75,broadBase)) * coreGrowth);
      var localForm = localBody;
      // Three staggered tiers of billows wrap the whole body, including its
      // underside. The wide lower shoulders connect to the upper cauliflower.
      for (var lobe = 0; lobe < 9; lobe++) {
        let seed = f32(lobe) * 19.71 + 63.2;
        let a = cloudCellRandom(id, seed);
        let b = cloudCellRandom(id, seed + 7.9);
        let tier = f32(lobe / 3);
        let lobeAge = smoothstep(tier * 0.14, tier * 0.14 + 0.70, maturity);
        if (lobeAge <= 0.00001) { continue; }
        let puffGrowth = sqrt(lobeAge);
        let angle = f32(lobe % 3) * 2.0944 + tier * 1.12 + r0 * 6.28318;
        // Roll out of the connected parent mass, rather than materializing a
        // little sphere at its final detached position and expanding there.
        let lean = (vec2<f32>(r1, r2) - 0.5) * radiusXZ * tier * 0.65 + shear * tier;
        let offset = (vec2<f32>(cos(angle), sin(angle)) * radiusXZ * mix_f(0.52, 0.78, a) + lean) * puffGrowth;
        let lowerShoulder = 1.0 + broadBase * (1.0 - saturate(tier)) * 0.32;
        let fullHeadRadius = radiusXZ * mix_f(0.58, 0.82, b) * clamp(4.0 / 4.0, 0.85, 1.15) * select(1.0, 0.86, anvil) * lowerShoulder;
        let headRadius = fullHeadRadius * puffGrowth;
        // Storm billows feed the canopy from below instead of growing rounded
        // turrets through it and hiding its flattened, spreading silhouette.
        let headY = base + columnHeight * (0.20 + tier * select(0.24, 0.215, anvil) + (a - 0.5) * 0.12);
        let fullRadiusY = min(fullHeadRadius * mix_f(0.94, 1.18, a), columnHeight * select(0.24, 0.16, anvil));
        let parentLift = fullRadiusY + columnHeight * 0.10 * tier;
        let head = vec3<f32>(centerXZ.x + offset.x, headY - parentLift * (1.0 - puffGrowth), centerXZ.y + offset.y);
        let radiusY = fullRadiusY * puffGrowth;
        // Newly born billows must gain density as well as radius; otherwise a
        // sub-voxel puff immediately has a fully opaque core and appears to pop.
        let lobeDensityLimit = mix_f(-0.12, 0.40, lobeAge);
        let lobeAspect = select(1.0, mix_f(0.74, 1.25, a), convective);
        let headForm = cloudEllipsoid(anatomyP, head, vec3<f32>(headRadius * lobeAspect, radiusY * select(1.0, mix_f(0.85, 1.18, b), convective), headRadius / lobeAspect));
        localForm = cloudSoftUnion(localForm, headForm);
        localBody = cloudSoftUnion(localBody, min(headForm, lobeDensityLimit));
        // Smaller attached buds give the large shoulders a cauliflower outline.
        // Their minimum radius stays above the field's horizontal texel size.
        let budRadius = max(fullHeadRadius * 0.55, min(16.0 / f32(128u) * 1.35, fullHeadRadius * 0.68)) * puffGrowth;
        let bud = head + vec3<f32>(offset.x * 0.24, radiusY * select(0.58, 0.35, anvil), offset.y * 0.24);
        let budForm = cloudEllipsoid(anatomyP, bud, vec3<f32>(budRadius, min(budRadius, columnHeight * select(0.17, 0.10, anvil) * puffGrowth), budRadius));
        localForm = cloudSoftUnion(localForm, budForm);
        localBody = cloudSoftUnion(localBody, min(budForm, lobeDensityLimit));
      }
      if (anvil && maturity > 0.40) {
        // The old late onset left most weather cells with only tiny caps. They
        // could never outspread the lower billows, even at the Anvil preset.
        let capGrowth = sqrt(smoothstep(0.40, 0.84, maturity));
        let capDensityLimit = mix_f(-0.12, 0.40, capGrowth * capGrowth);
        let spread = clamp(BAKE.shape.z * max(0.60, 0.0) / 0.60, 0.0, 1.5);
        let shoulder = vec3<f32>(centerXZ.x + radiusXZ * 0.15 + shear.x * 1.7, base + columnHeight * 0.72, centerXZ.y + shear.y * 1.7);
        let shoulderForm = cloudEllipsoid(anatomyP, shoulder, vec3<f32>(radiusXZ * 1.12, columnHeight * 0.16, radiusXZ * 1.08) * capGrowth);
        localForm = cloudSoftUnion(localForm, shoulderForm);
        localBody = cloudSoftUnion(localBody, min(shoulderForm, capDensityLimit));
        // A connected wind-spread fan, not one smooth UFO-shaped disk. Slightly
        // staggered lobes retain a broken edge as the cap spreads downwind.
        for (var fan = 0; fan < 5; fan++) {
          let f = f32(fan) / 4.0;
          let jitter = cloudCellRandom(id, 181.0 + f32(fan) * 7.3);
          // Broad and shallow at a common outflow level, with an asymmetric
          // downwind reach. Same noise closure/erosion as the body preserves
          // breakup throughout the canopy rather than adding a smooth disk.
          // Bound the footprint to the existing 3x3 neighborhood: no extra
          // field probes, loop iterations or raymarch work are introduced.
          let lateralSpread = saturate(spread / 1.15);
          let capCenter = vec3<f32>(centerXZ.x + shear.x * 1.7 + radiusXZ * mix_f(-0.55, mix_f(0.55, 0.85, variant), f) * lateralSpread,
            base + columnHeight * (mix_f(0.83, 0.87, variant) + (jitter - 0.5) * 0.045),
            centerXZ.y + shear.y * 1.7 + radiusXZ * (jitter - 0.5) * 0.42 * lateralSpread);
          let capRadius = vec3<f32>(radiusXZ * mix_f(0.55, mix_f(1.20, 1.60, f), lateralSpread),
            columnHeight * mix_f(0.095, 0.065, f) * mix_f(0.72, 1.34, r2), radiusXZ * mix_f(0.55, mix_f(1.30, 1.60, f), lateralSpread));
          let capForm = cloudEllipsoid(anatomyP, capCenter, capRadius * capGrowth);
          localForm = cloudSoftUnion(localForm, capForm);
          localBody = cloudSoftUnion(localBody, min(capForm, capDensityLimit));
        }
      }
      let macroSigned = localBody * 0.85 + cellStructure;
      let fineSigned = macroSigned - erosion;
      // Only developed, embedded material gets support. It follows the noisy
      // body and young-billow density limit, not a filled hidden ellipsoid;
      // growing lobes/edges remain tenuous and coverage zero stays empty.
      let interior = smoothstep(0.04, 0.42, localBody + cellStructure * 0.40 - erosion * 0.20)
        * smoothstep(0.20, 1.00, maturity);
      // Optical thickness belongs in the interior, not an image-space alpha
      // boost that would also turn faint edges and newborn puffs into cards.
      let coreDensity = interior * 2.0;
      let fineDensity = max(smoothstep(-0.025, 0.24, fineSigned), coreDensity);
      let macroDensity = max(smoothstep(-0.025, 0.24, macroSigned), coreDensity);
      let volumeVariation = mix_f(0.65, 1.0, shelfShape);
      fine = max(fine, presence * fineDensity * volumeVariation);
      macroAmount = max(macroAmount, presence * macroDensity * volumeVariation);
      // Opacity limits for young puffs must not flatten their shading normals.
      // Lighting follows the same noise-defined folds as density, not the
      // hidden ellipsoids. Preserve the unsaturated signed field for gradients.
      // Retain noisy folds without letting the smallest erosion valleys dominate
      // every lighting normal. Density/breakup is unchanged; broad shoulders
      // should carry coherent light and shade underneath the finer texture.
      body = max(body, localForm * 0.85 + cellStructure * 0.65 - erosion * 0.35 - (1.0 - presence) * 0.45);
    }
  }
  if (stormSystem) {
    // Broken, low feeder banks link some towers into larger storm complexes.
    // Already sampled shape bands supply the organization; no extra reads or
    // larger neighborhood are needed. Sparse coverage still opens real gaps.
    let center = 0.0 + layerHeight * (0.13 + fbm * 0.065);
    let band = 1.0 - abs(p.y-center) / max(layerHeight * 0.12, 0.30);
    let connected = min(band, shelfShape * 0.72 + fbm * 0.28 - mix_f(0.85, 0.34, saturate(BAKE.shape.x)));
    let bank = smoothstep(-0.035, 0.22, connected - erosion * 0.45) * smoothstep(0.0, 0.12, BAKE.shape.x);
    fine = max(fine, bank * 0.72);
    macroAmount = max(macroAmount, bank * 0.82);
    body = max(body, connected - erosion * 0.35);
  }
  return vec3<f32>(fine, macroAmount, body);
}

`;
