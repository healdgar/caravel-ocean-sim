// Interactive Debug Charts, International World of Trade Ledger & 2D/3D World Logistics Overlay.
// Pure DOM + 2D Canvas HUD overlay: zero extra WebGPU passes and zero CPU/GC work when hidden.

const DEBUG_EARTH_RADIUS_M = 6371000;
const SPARK_SAMPLES = 60;
const BOARD_DAY_REAL_HOURS_1X = 24.35;

const COMMODITY_KEYS = ['grain', 'wine', 'fish', 'salt', 'timber', 'ore', 'wool', 'cloth', 'tools'];
const COMMODITY_SHORT = {
  grain: 'Grn',
  wine: 'Win',
  fish: 'Fsh',
  salt: 'Slt',
  timber: 'Tmb',
  ore: 'Ore',
  wool: 'Wol',
  cloth: 'Clt',
  tools: 'Tls',
};

const FALLBACK_HUB_PRICES = {
  grain: 1.00,
  wine: 2.35,
  fish: 1.10,
  salt: 1.45,
  timber: 1.30,
  ore: 2.20,
  wool: 2.05,
  cloth: 3.80,
  tools: 4.20,
};

const FALLBACK_PARTNER_PORTS = [
  {
    name: 'Sevilla',
    country: 'Castile',
    distanceNm: 215,
    mult: { grain: 1.12, wine: 0.88, fish: 1.26, salt: 1.18, timber: 1.24, ore: 0.90, wool: 0.84, cloth: 1.14, tools: 1.10 },
  },
  {
    name: 'Porto',
    country: 'Portugal',
    distanceNm: 170,
    mult: { grain: 1.08, wine: 0.78, fish: 0.86, salt: 0.94, timber: 0.85, ore: 1.04, wool: 0.92, cloth: 1.06, tools: 1.05 },
  },
  {
    name: 'Antwerp',
    country: 'Flanders',
    distanceNm: 980,
    mult: { grain: 0.92, wine: 1.44, fish: 0.95, salt: 1.48, timber: 0.96, ore: 1.02, wool: 1.16, cloth: 0.72, tools: 0.78 },
  },
  {
    name: 'Venice',
    country: 'Venetian Republic',
    distanceNm: 1690,
    mult: { grain: 1.18, wine: 1.14, fish: 1.22, salt: 1.06, timber: 1.32, ore: 1.15, wool: 1.20, cloth: 0.82, tools: 0.86 },
  },
  {
    name: 'Bordeaux',
    country: 'France',
    distanceNm: 630,
    mult: { grain: 0.84, wine: 0.74, fish: 1.12, salt: 1.22, timber: 0.88, ore: 1.16, wool: 1.08, cloth: 1.04, tools: 1.02 },
  },
];

const STYLE_CSS = `
.ww-debug-world-root {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(148, 163, 184, 0.24);
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #e2e8f0;
  user-select: none;
}
.ww-dw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 6px;
}
.ww-dw-title {
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.03em;
  color: #f8fafc;
}
.ww-dw-btn {
  appearance: none;
  border: 1px solid rgba(56, 189, 248, 0.45);
  background: rgba(15, 23, 42, 0.86);
  color: #7dd3fc;
  border-radius: 4px;
  padding: 3px 7px;
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.ww-dw-btn:hover {
  background: rgba(14, 116, 144, 0.35);
  border-color: #38bdf8;
  color: #f0f9ff;
}
.ww-dw-btn.is-active {
  background: rgba(14, 165, 233, 0.28);
  border-color: #38bdf8;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.32);
}
.ww-dw-spark-wrap {
  background: rgba(2, 6, 23, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 4px;
  padding: 4px;
  margin-bottom: 6px;
}
.ww-dw-spark-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 10px;
  margin-bottom: 3px;
}
.ww-dw-spark-canvas {
  display: block;
  width: 100%;
  height: 54px;
}
.ww-dw-clock {
  background: rgba(15, 23, 42, 0.66);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 4px;
  padding: 4px 6px;
  margin-bottom: 6px;
  font-size: 10px;
  color: #cbd5e1;
}
.ww-dw-clock strong {
  color: #f8fafc;
}
.ww-dw-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.ww-dw-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(30, 41, 59, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.2);
  font-size: 9.5px;
  color: #e2e8f0;
}
.ww-dw-pill.warn {
  background: rgba(127, 29, 29, 0.65);
  border-color: rgba(248, 113, 113, 0.6);
  color: #fecaca;
}
.ww-dw-pill.ok {
  background: rgba(6, 78, 59, 0.55);
  border-color: rgba(52, 211, 153, 0.45);
  color: #a7f3d0;
}
.ww-dw-section-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
  margin: 6px 0 3px;
}
.ww-dw-table-wrap {
  overflow-x: auto;
  background: rgba(2, 6, 23, 0.58);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 4px;
  padding: 3px;
  margin-bottom: 5px;
}
.ww-dw-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5px;
}
.ww-dw-table th,
.ww-dw-table td {
  padding: 2px 3px;
  text-align: right;
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  white-space: nowrap;
}
.ww-dw-table th:first-child,
.ww-dw-table td:first-child {
  text-align: left;
}
.ww-dw-table th {
  color: #94a3b8;
  font-weight: 600;
}
.ww-dw-bar {
  display: inline-block;
  vertical-align: middle;
  height: 6px;
  border-radius: 2px;
}
.ww-dw-sublist {
  background: rgba(2, 6, 23, 0.52);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 9.5px;
  color: #cbd5e1;
  max-height: 124px;
  overflow-y: auto;
}
.ww-dw-subrow {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 1.5px 0;
  border-bottom: 1px dashed rgba(148, 163, 184, 0.08);
}
.ww-dw-subrow:last-child {
  border-bottom: none;
}
#debug-world-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 45;
}
`;

function escHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePercent(raw, fallback = 100) {
  if (raw == null) return fallback;
  let v = raw;
  if (typeof raw === 'object') {
    v = raw.percent ?? raw.pct ?? raw.scale ?? raw.ratio ?? raw.value ?? raw.current ?? fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n <= 2.05 ? n * 100 : n;
}

function extractSceneGpuMs(prof) {
  if (prof == null) return 0;
  if (typeof prof === 'number') return Number.isFinite(prof) ? Math.max(0, prof) : 0;
  if (typeof prof.sceneMs === 'function') {
    const v = prof.sceneMs();
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  if (typeof prof.summary === 'function') {
    const sum = prof.summary();
    const v = Number(sum?.smoothed?.Scene ?? sum?.totalMs ?? 0);
    if (Number.isFinite(v) && v > 0) return v;
  }
  if (prof.smoothed && typeof prof.smoothed === 'object') {
    const sScene = Number(prof.smoothed.Scene ?? prof.latest?.Scene ?? prof.totalMs ?? 0);
    return Number.isFinite(sScene) && sScene > 0 ? sScene : 0;
  }
  if (typeof prof.snapshot === 'function') {
    const snap = prof.snapshot();
    if (snap) {
      const sScene = Number(snap.smoothed?.Scene ?? snap.latest?.Scene ?? snap.totalMs ?? 0);
      if (Number.isFinite(sScene) && sScene > 0) return sScene;
    }
  }
  if (typeof prof.getPassMs === 'function') {
    const v = Number(prof.getPassMs('Scene') ?? prof.getPassMs('scene') ?? 0);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const direct = prof.sceneGpuMs ?? prof.sceneMs ?? prof.gpuSceneMs ?? prof.gpuMs ?? prof.totalGpuMs ?? prof.totalMs;
  if (Number.isFinite(direct)) return Math.max(0, Number(direct));
  const map = prof.passes ?? prof.timings ?? prof.gpuPasses ?? prof.lastTimings ?? null;
  if (Array.isArray(map)) {
    let sum = 0;
    for (const item of map) {
      if (!item) continue;
      const name = String(item.name ?? item.label ?? item.pass ?? '').toLowerCase();
      const ms = Number(item.gpuMs ?? item.ms ?? item.durationMs ?? 0) || 0;
      if (name.includes('scene') || name.includes('main')) return Math.max(0, ms);
      sum += Math.max(0, ms);
    }
    return sum;
  }
  if (map && typeof map === 'object') {
    const sceneVal = map.Scene ?? map.scene ?? map['Main Scene'] ?? map.main;
    if (Number.isFinite(sceneVal)) return Math.max(0, Number(sceneVal));
    if (sceneVal && Number.isFinite(sceneVal.gpuMs ?? sceneVal.ms)) {
      return Math.max(0, Number(sceneVal.gpuMs ?? sceneVal.ms));
    }
  }
  return 0;
}

function formatCargoShort(cargoObj) {
  if (!cargoObj || typeof cargoObj !== 'object') return 'ballast';
  const pairs = Object.entries(cargoObj)
    .map(([k, q]) => [k, Math.round(Number(q) || 0)])
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!pairs.length) return 'ballast';
  return pairs.slice(0, 2).map(([k, q]) => `${q} ${k}`).join(', ');
}

function sampleFlatPolyline(points, tNorm) {
  if (!Array.isArray(points) || points.length < 4) return null;
  const n = Math.floor(points.length / 2);
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i * 2] - points[(i - 1) * 2], points[i * 2 + 1] - points[(i - 1) * 2 + 1]);
  }
  if (total <= 1e-3) return { x: points[0], z: points[1], yaw: 0, totalLen: 0 };
  const target = Math.max(0, Math.min(1, tNorm)) * total;
  let acc = 0;
  for (let i = 1; i < n; i++) {
    const ax = points[(i - 1) * 2];
    const az = points[(i - 1) * 2 + 1];
    const bx = points[i * 2];
    const bz = points[i * 2 + 1];
    const seg = Math.hypot(bx - ax, bz - az);
    if (acc + seg >= target || i === n - 1) {
      const u = seg > 1e-5 ? Math.max(0, Math.min(1, (target - acc) / seg)) : 0;
      return {
        x: ax + (bx - ax) * u,
        z: az + (bz - az) * u,
        yaw: Math.atan2(bx - ax, -(bz - az)),
        totalLen: total,
      };
    }
    acc += seg;
  }
  return { x: points[0], z: points[1], yaw: 0, totalLen: total };
}

export function projectWorldPoint3D(wx, wy, wz, viewProj, camPos, screenW, screenH) {
  if (!viewProj || viewProj.length < 16 || !(screenW > 0) || !(screenH > 0)) return null;
  const cx = camPos?.[0] ?? camPos?.x ?? 0;
  const cy = camPos?.[1] ?? camPos?.y ?? 0;
  const cz = camPos?.[2] ?? camPos?.z ?? 0;
  const dx = wx - cx;
  const dz = wz - cz;
  const distSq = dx * dx + dz * dz;
  const yDrop = distSq / (2 * DEBUG_EARTH_RADIUS_M);
  const isCamRelative = Math.abs(viewProj[12]) < 1e-6 && Math.abs(viewProj[13]) < 1e-6 && Math.abs(viewProj[15]) < 1e-6;
  const px = isCamRelative ? dx : wx;
  const py = (wy - yDrop) - (isCamRelative ? cy : 0);
  const pz = isCamRelative ? dz : wz;

  const clipX = viewProj[0] * px + viewProj[4] * py + viewProj[8] * pz + viewProj[12];
  const clipY = viewProj[1] * px + viewProj[5] * py + viewProj[9] * pz + viewProj[13];
  const clipZ = viewProj[2] * px + viewProj[6] * py + viewProj[10] * pz + viewProj[14];
  const clipW = viewProj[3] * px + viewProj[7] * py + viewProj[11] * pz + viewProj[15];
  if (!(clipW > 0.12)) return null;

  const invW = 1 / clipW;
  const ndcX = clipX * invW;
  const ndcY = clipY * invW;
  const ndcZ = clipZ * invW;
  if (ndcZ < -0.25 || ndcZ > 1.25) return null;

  return {
    x: (ndcX * 0.5 + 0.5) * screenW,
    y: (0.5 - ndcY * 0.5) * screenH,
    depth: clipW,
    dist: Math.sqrt(distSq),
    yDrop,
    onScreen: ndcX >= -1.08 && ndcX <= 1.08 && ndcY >= -1.08 && ndcY <= 1.08,
  };
}

function classifySectionKind(sec, sx, sz) {
  const raw = String(sec?.kind ?? sec?.type ?? sec?.source ?? sec?.mode ?? '').toLowerCase();
  const isCenter = Boolean(sec?.isCenter) || (sx === 0 && sz === 0 && !raw.includes('mock'));
  if (isCenter || raw.includes('center') || raw.includes('origin') || raw.includes('primary')) return 'center';
  if (raw.includes('mock') || raw.includes('synth') || raw.includes('fallback') || sec?.mock === true) return 'mock';
  if (raw.includes('dem') || raw.includes('grown') || raw.includes('real') || sec?.dem === true) return 'dem';
  return (sx === 0 && sz === 0) ? 'center' : 'dem';
}

function collectTerrainSections(terrain, board) {
  const out = [];
  const defaultSpan = Number(
    terrain?.sectionSize ?? terrain?.tileSize ?? terrain?.chunkSize ?? board?.span ?? terrain?.span ?? 4000,
  ) || 4000;
  const offX = Number(terrain?.worldOffset?.[0] ?? terrain?.worldOffset?.x ?? 0) || 0;
  const offZ = Number(terrain?.worldOffset?.[1] ?? terrain?.worldOffset?.z ?? 0) || 0;

  let rawList = null;
  if (typeof terrain?.getLoadedSections === 'function') rawList = terrain.getLoadedSections();
  else if (typeof terrain?.getSections === 'function') rawList = terrain.getSections();
  else if (typeof terrain?.getDebugSections === 'function') rawList = terrain.getDebugSections();
  else if (terrain?.loadedSections) rawList = terrain.loadedSections;
  else if (terrain?.sections) rawList = terrain.sections;
  else if (terrain?.seamSections) rawList = terrain.seamSections;
  else if (terrain?.tiles && (Array.isArray(terrain.tiles) || terrain.tiles instanceof Map)) rawList = terrain.tiles;

  const iter = rawList instanceof Map
    ? [...rawList.entries()].map(([k, v]) => (v && typeof v === 'object' ? { _key: k, ...v } : { _key: k }))
    : Array.isArray(rawList)
      ? rawList
      : (rawList && typeof rawList === 'object' ? Object.entries(rawList).map(([k, v]) => ({ _key: k, ...(v || {}) })) : []);

  for (const item of iter) {
    if (!item) continue;
    let sx = Number.isFinite(item.sx) ? item.sx : (Number.isFinite(item.ix) ? item.ix : (Number.isFinite(item.gx) ? item.gx : NaN));
    let sz = Number.isFinite(item.sz) ? item.sz : (Number.isFinite(item.iz) ? item.iz : (Number.isFinite(item.gz) ? item.gz : NaN));
    if ((!Number.isFinite(sx) || !Number.isFinite(sz)) && typeof item._key === 'string') {
      const m = item._key.match(/^(-?\d+)\s*[,_:]\s*(-?\d+)$/);
      if (m) {
        sx = Number(m[1]);
        sz = Number(m[2]);
      }
    }
    const sizeX = Number(item.sizeX ?? item.width ?? item.span ?? item.size ?? defaultSpan) || defaultSpan;
    const sizeZ = Number(item.sizeZ ?? item.depth ?? item.span ?? item.size ?? defaultSpan) || defaultSpan;
    let minX = Number(item.minX);
    let maxX = Number(item.maxX);
    let minZ = Number(item.minZ);
    let maxZ = Number(item.maxZ);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      const cx = Number.isFinite(item.cx ?? item.worldX ?? item.x)
        ? Number(item.cx ?? item.worldX ?? item.x)
        : (Number.isFinite(sx) ? sx * sizeX : 0);
      minX = cx - sizeX * 0.5;
      maxX = cx + sizeX * 0.5;
      if (!Number.isFinite(sx)) sx = Math.round(cx / sizeX);
    }
    if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
      const cz = Number.isFinite(item.cz ?? item.worldZ ?? item.z)
        ? Number(item.cz ?? item.worldZ ?? item.z)
        : (Number.isFinite(sz) ? sz * sizeZ : 0);
      minZ = cz - sizeZ * 0.5;
      maxZ = cz + sizeZ * 0.5;
      if (!Number.isFinite(sz)) sz = Math.round(cz / sizeZ);
    }
    const kind = classifySectionKind(item, sx, sz);
    out.push({
      sx: Number.isFinite(sx) ? sx : 0,
      sz: Number.isFinite(sz) ? sz : 0,
      minX,
      maxX,
      minZ,
      maxZ,
      kind,
      label: item.label || `(${Number.isFinite(sx) ? sx : 0},${Number.isFinite(sz) ? sz : 0}) ${kind.toUpperCase()}`,
      seamOk: item.seamOk !== false,
    });
  }

  if (!out.length) {
    const half = defaultSpan * 0.5;
    out.push({
      sx: 0,
      sz: 0,
      minX: -half - offX,
      maxX: half - offX,
      minZ: -half - offZ,
      maxZ: half - offZ,
      kind: 'center',
      label: '(0,0) CENTER',
      seamOk: true,
    });
  }
  return out;
}

function buildFallbackPartnerPorts(shipsList = [], settlements = []) {
  const hub = settlements.find((s) => s?.harbor) || settlements[0] || null;
  const hubPrices = { ...FALLBACK_HUB_PRICES, ...(hub?.prices || {}) };
  return FALLBACK_PARTNER_PORTS.map((fp) => {
    const prices = {};
    for (const g of COMMODITY_KEYS) {
      prices[g] = +((hubPrices[g] || 1) * (fp.mult[g] || 1)).toFixed(2);
    }
    const portShips = shipsList.filter((sh) => {
      const hp = String(sh?.homePort || sh?.from || '').toLowerCase();
      return hp.includes(fp.name.toLowerCase());
    });
    let importsCrowns = 0;
    let exportsCrowns = 0;
    const manifests = portShips.slice(0, 3).map((sh) => {
      const cargo = sh.phase === 'out' && sh.load && Object.keys(sh.load).length ? sh.load : sh.cargo;
      for (const [g, q] of Object.entries(cargo || {})) {
        const val = (Number(q) || 0) * (prices[g] || 1);
        if (sh.phase === 'out') exportsCrowns += val;
        else importsCrowns += val;
      }
      return {
        shipName: sh.shipName || sh.kind || 'Merchantman',
        kind: sh.kind || 'cog',
        phase: sh.phase || 'in',
        captain: sh.captain?.name || sh.master || 'Master',
        merchant: sh.merchant?.name || 'Factor',
        summary: formatCargoShort(cargo),
      };
    });
    return {
      name: fp.name,
      country: fp.country,
      distanceNm: fp.distanceNm,
      prices,
      hubPrices,
      activeShips: portShips.length,
      foreignMerchants: Math.max(2, portShips.length + 2),
      importsCrowns: +importsCrowns.toFixed(1),
      exportsCrowns: +exportsCrowns.toFixed(1),
      balanceCrowns: +(exportsCrowns - importsCrowns).toFixed(1),
      manifests,
    };
  });
}

export function createWorldDebugUI({
  performancePanel = null,
  getBoardLife = null,
  getCaravans = null,
  getTradeVessels = null,
  getTerrain = null,
  getVessels = null,
  getProfiler = null,
  getResolution = null,
  getPolygons = null,
  overlayCanvas = null,
  documentRef = globalThis.document ?? null,
  windowRef = globalThis.window ?? globalThis,
} = {}) {
  const frameHist = new Float32Array(SPARK_SAMPLES);
  const gpuHist = new Float32Array(SPARK_SAMPLES);
  const resHist = new Float32Array(SPARK_SAMPLES);
  const polyHist = new Float32Array(SPARK_SAMPLES);
  let histHead = 0;
  let histCount = 0;

  let overlayVisible = false;
  let destroyed = false;
  let lastPanelHtmlMs = -Infinity;
  let lastSparkMs = -Infinity;
  let lastLocateMs = -Infinity;
  let cachedRawLocatedVessels = [];
  let cachedLocateSource = null;
  let lastFrameMs = 16.67;
  let lastGpuMs = 0;
  let lastResPct = 100;
  let lastPolyPct = 100;
  let radarZoom = 2.35;

  const pointer = { x: -1, y: -1, active: false };
  const hoverTargets = [];

  // Inject singleton stylesheet when DOM is available
  if (documentRef?.head && typeof documentRef.getElementById === 'function' && !documentRef.getElementById('ww-debug-world-style')) {
    const styleEl = documentRef.createElement('style');
    styleEl.id = 'ww-debug-world-style';
    styleEl.textContent = STYLE_CSS;
    documentRef.head.appendChild(styleEl);
  }

  // Build #performance-panel extension DOM
  let rootEl = null;
  let toggleBtn = null;
  let sparkCanvas = null;
  let sparkLegendEl = null;
  let sparkLegendSpans = null;
  const sparkLegendLast = ['', '', '', ''];
  let telemetryBodyEl = null;

  if (performancePanel && documentRef?.createElement) {
    rootEl = documentRef.createElement('section');
    rootEl.className = 'ww-debug-world-root';

    const headerEl = documentRef.createElement('div');
    headerEl.className = 'ww-dw-header';
    const titleEl = documentRef.createElement('span');
    titleEl.className = 'ww-dw-title';
    titleEl.textContent = 'World Trade & Logistics';

    toggleBtn = documentRef.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.id = 'debug-world-toggle-btn';
    toggleBtn.className = 'ww-dw-btn';
    toggleBtn.textContent = '🗺️ World & Trade Overlay [F9]';
    toggleBtn.addEventListener?.('click', () => {
      toggleOverlay();
    });

    headerEl.appendChild(titleEl);
    headerEl.appendChild(toggleBtn);
    rootEl.appendChild(headerEl);

    const sparkWrap = documentRef.createElement('div');
    sparkWrap.className = 'ww-dw-spark-wrap';
    sparkLegendEl = documentRef.createElement('div');
    sparkLegendEl.className = 'ww-dw-spark-legend';
    sparkLegendSpans = ['#fbbf24', '#38bdf8', '#34d399', '#c084fc'].map((color) => {
      const span = documentRef.createElement('span');
      if (span.style) span.style.color = color;
      sparkLegendEl.appendChild?.(span);
      return span;
    });
    sparkCanvas = documentRef.createElement('canvas');
    sparkCanvas.className = 'ww-dw-spark-canvas';
    sparkCanvas.width = 280;
    sparkCanvas.height = 54;
    sparkWrap.appendChild(sparkLegendEl);
    sparkWrap.appendChild(sparkCanvas);
    rootEl.appendChild(sparkWrap);

    telemetryBodyEl = documentRef.createElement('div');
    telemetryBodyEl.className = 'ww-dw-telemetry-body';
    rootEl.appendChild(telemetryBodyEl);

    (performancePanel.querySelector?.('.panel-body') ?? performancePanel).appendChild?.(rootEl);
  }

  // Resolve or create <canvas id="debug-world-overlay">
  let hudCanvas = overlayCanvas || documentRef?.getElementById?.('debug-world-overlay') || null;
  let createdHudCanvas = false;
  if (!hudCanvas && documentRef?.createElement) {
    hudCanvas = documentRef.createElement('canvas');
    hudCanvas.id = 'debug-world-overlay';
    hudCanvas.hidden = true;
    documentRef.body?.appendChild?.(hudCanvas);
    createdHudCanvas = true;
  }
  if (hudCanvas) {
    hudCanvas.hidden = !overlayVisible;
  }

  function syncToggleUI() {
    if (hudCanvas) {
      hudCanvas.hidden = !overlayVisible;
      if (hudCanvas.style) hudCanvas.style.display = overlayVisible ? 'block' : 'none';
    }
    if (toggleBtn) {
      if (toggleBtn.classList) toggleBtn.classList.toggle('is-active', overlayVisible);
      toggleBtn.setAttribute?.('aria-pressed', overlayVisible ? 'true' : 'false');
    }
  }

  function toggleOverlay(force) {
    overlayVisible = typeof force === 'boolean' ? force : !overlayVisible;
    syncToggleUI();
    return overlayVisible;
  }

  const onKeyDown = (e) => {
    if (destroyed || e?.repeat) return;
    if (e?.code === 'F9' || e?.key === 'F9') {
      e.preventDefault?.();
      toggleOverlay();
    } else if (overlayVisible && (e?.key === '[' || e?.key === ']')) {
      radarZoom = Math.max(0.45, Math.min(4.8, radarZoom * (e.key === ']' ? 1.22 : 1 / 1.22)));
    }
  };

  const onPointerMove = (e) => {
    if (!overlayVisible) return;
    pointer.x = Number(e?.clientX ?? -1);
    pointer.y = Number(e?.clientY ?? -1);
    pointer.active = pointer.x >= 0 && pointer.y >= 0;
  };

  windowRef?.addEventListener?.('keydown', onKeyDown);
  windowRef?.addEventListener?.('mousemove', onPointerMove, { passive: true });

  function pushSample(frameMs, gpuMs, resPct, polyPct) {
    frameHist[histHead] = Math.max(0, frameMs);
    gpuHist[histHead] = Math.max(0, gpuMs);
    resHist[histHead] = Math.max(0, Math.min(200, resPct));
    polyHist[histHead] = Math.max(0, Math.min(200, polyPct));
    histHead = (histHead + 1) % SPARK_SAMPLES;
    if (histCount < SPARK_SAMPLES) histCount++;
  }

  function gatherWorldState(frame = {}) {
    const terrain = getTerrain?.() ?? null;
    const rawBoardLife = getBoardLife?.() ?? null;
    const board = rawBoardLife?.board ?? rawBoardLife?.world ?? rawBoardLife?.getBoard?.() ?? terrain?.port?.country?.board ?? rawBoardLife ?? null;
    const rawCaravans = getCaravans?.() ?? null;
    const caravanSnap = (rawCaravans && Array.isArray(rawCaravans.list))
      ? rawCaravans
      : (rawBoardLife?.caravansSnapshot ?? rawBoardLife?.latestCaravans ?? (typeof rawBoardLife?.getCaravans === 'function' ? rawBoardLife.getCaravans() : null));

    const caravanList = Array.isArray(caravanSnap?.list)
      ? caravanSnap.list
      : (Array.isArray(rawCaravans) ? rawCaravans : []);
    const roadCaravans = caravanList.filter((c) => !c?.mode || c.mode === 'cart');
    const seaCaravans = caravanList.filter((c) => c?.mode === 'sea');
    const riverCaravans = caravanList.filter((c) => c?.mode === 'river');

    const tv = getTradeVessels?.() ?? null;
    const nowLocate = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const needCrew = Boolean(frame.includeCrew);
    const locateIntervalMs = overlayVisible ? 180 : 600;
    let rawLocatedVessels;
    if (Array.isArray(tv)) {
      rawLocatedVessels = tv;
    } else if (typeof tv?.locate === 'function') {
      if (needCrew || tv !== cachedLocateSource || nowLocate - lastLocateMs >= locateIntervalMs) {
        lastLocateMs = nowLocate;
        cachedLocateSource = tv;
        cachedRawLocatedVessels = tv.locate(needCrew ? undefined : { skipCrew: true });
      }
      rawLocatedVessels = cachedRawLocatedVessels;
    } else {
      rawLocatedVessels = [];
    }
    const extraVesselsRaw = getVessels?.() ?? null;
    const extraVessels = Array.isArray(extraVesselsRaw)
      ? extraVesselsRaw
      : (Array.isArray(extraVesselsRaw?.vessels) ? extraVesselsRaw.vessels : []);

    const wo = terrain?.getWorldOffset?.() ?? terrain?.worldOffset;
    const woX = Number(wo?.[0] ?? wo?.x ?? 0) || 0;
    const woZ = Number(wo?.[1] ?? wo?.z ?? 0) || 0;
    const locatedVessels = (woX || woZ)
      ? rawLocatedVessels.map((v) => ({ ...v, x: (Number(v.x) || 0) + woX, z: (Number(v.z) || 0) + woZ }))
      : rawLocatedVessels;
    // Board-local entities (rivers, roads, settlements, roadCaravans) are relative to terrain.region.{x,z};
    // keeping offX = -boardOriginX preserves `boardCoord - offX === boardCoord + boardOriginX`.
    const boardOriginX = Number.isFinite(terrain?.region?.x) ? Number(terrain.region.x) : -woX;
    const boardOriginZ = Number.isFinite(terrain?.region?.z) ? Number(terrain.region.z) : -woZ;
    const offX = -boardOriginX;
    const offZ = -boardOriginZ;

    const boardDay = Number(
      frame.boardDay ?? caravanSnap?.day ?? rawBoardLife?.day ?? board?.day ?? tv?.getMaritimeReport?.()?.day ?? 0,
    ) || 0;
    const dateLabel = caravanSnap?.date ?? board?.date ?? `Year ${Math.floor(boardDay / 360) + 1}, Day ${(Math.floor(boardDay) % 360) + 1}`;
    const daysPerSec = Number(frame.daysPerSecond ?? rawBoardLife?.daysPerSecond ?? (1 / (BOARD_DAY_REAL_HOURS_1X * 3600)));

    const settlements = Array.isArray(caravanSnap?.settlements) && caravanSnap.settlements.length
      ? caravanSnap.settlements
      : (Array.isArray(board?.places) ? board.places.map((p, idx) => ({
          index: idx,
          name: p.name || `Place ${idx + 1}`,
          kind: p.kind || 'town',
          pop: p.people ?? p.pop ?? 0,
          harbor: Boolean(p.harbor),
          riverside: Boolean(p.riverside || p.river),
          x: p.x ?? 0,
          z: p.z ?? 0,
          prices: { ...FALLBACK_HUB_PRICES },
          stores: p.stores || {},
        })) : []);

    const shipsList = Array.isArray(caravanSnap?.ships) ? caravanSnap.ships : [];
    const partnerPorts = Array.isArray(caravanSnap?.partnerPorts) && caravanSnap.partnerPorts.length
      ? caravanSnap.partnerPorts
      : buildFallbackPartnerPorts(shipsList.length ? shipsList : locatedVessels, settlements);

    // Collect bridges with live water clearance (terrain.bridges are in activeRegion space -> + woX/woZ)
    const bridges = [];
    const rawBridges = Array.isArray(terrain?.bridges) ? terrain.bridges : [];
    for (let i = 0; i < rawBridges.length; i++) {
      const br = rawBridges[i];
      if (!br) continue;
      const rawCenterX = Number.isFinite(br.x) ? br.x : (Number.isFinite(br.mx) ? br.mx : (Number(br.ax || 0) + Number(br.bx || 0)) * 0.5);
      const rawCenterZ = Number.isFinite(br.z) ? br.z : (Number.isFinite(br.mz) ? br.mz : (Number(br.az || 0) + Number(br.bz || 0)) * 0.5);
      const mx = rawCenterX + woX;
      const mz = rawCenterZ + woZ;
      const span = Number(br.length ?? br.span ?? 28);
      const ux = Number.isFinite(br.ux) ? br.ux : Math.cos(br.yaw || 0);
      const uz = Number.isFinite(br.uz) ? br.uz : Math.sin(br.yaw || 0);
      const deckY = Number(br.deckY ?? br.y ?? 7.5);
      const iw = terrain?.inlandWaterAt?.(mx, mz);
      const bedY = terrain?.height ? terrain.height(mx, mz) : 0;
      const waterY = (iw && Number.isFinite(iw.wy) && iw.wy > bedY + 0.05) ? iw.wy : Math.max(0, Number(br.waterY ?? 0));
      bridges.push({
        id: i,
        x: mx,
        z: mz,
        ax: Number.isFinite(br.ax) ? br.ax + woX : mx - ux * span * 0.5,
        az: Number.isFinite(br.az) ? br.az + woZ : mz - uz * span * 0.5,
        bx: Number.isFinite(br.bx) ? br.bx + woX : mx + ux * span * 0.5,
        bz: Number.isFinite(br.bz) ? br.bz + woZ : mz + uz * span * 0.5,
        span,
        deckY,
        waterY,
        clearanceM: deckY - waterY,
        isStone: br.isStone !== false,
      });
    }
    if (!bridges.length && Array.isArray(board?.works?.trackBridges)) {
      const tb = board.works.trackBridges;
      for (let i = 0; i + 5 < tb.length; i += 6) {
        const mx = tb[i] - offX, mz = tb[i + 1] - offZ;
        const ux = tb[i + 2], uz = tb[i + 3], span = tb[i + 4], isStone = tb[i + 5] > 0;
        const iw = terrain?.inlandWaterAt?.(tb[i], tb[i + 1]);
        const waterY = (iw && Number.isFinite(iw.wy)) ? iw.wy : 0.8;
        const deckY = waterY + (isStone ? 4.6 : 2.9);
        bridges.push({
          id: i / 6,
          x: mx,
          z: mz,
          ax: mx - ux * span * 0.5,
          az: mz - uz * span * 0.5,
          bx: mx + ux * span * 0.5,
          bz: mz + uz * span * 0.5,
          span,
          deckY,
          waterY,
          clearanceM: deckY - waterY,
          isStone,
        });
      }
    }

    const sections = collectTerrainSections(terrain, board);

    return {
      board,
      terrain,
      offX,
      offZ,
      boardDay,
      dateLabel,
      daysPerSec,
      caravanSnap,
      roadCaravans,
      seaCaravans,
      riverCaravans,
      locatedVessels,
      extraVessels,
      deckCrewCount: Number(tv?.deckCrewCount ?? 0),
      settlements,
      partnerPorts,
      bridges,
      sections,
    };
  }

  function drawSparklineCanvas() {
    if (!sparkCanvas) return;
    const ctx = sparkCanvas.getContext?.('2d');
    if (!ctx) return;
    const w = sparkCanvas.width;
    const h = sparkCanvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(2, 6, 23, 0.9)';
    ctx.fillRect(0, 0, w, h);

    // 16.67 ms and 33.33 ms horizontal guides (mapped to 0..40 ms scale)
    const maxMs = 40;
    const y16 = h - (16.67 / maxMs) * (h - 6) - 3;
    const y33 = h - (33.33 / maxMs) * (h - 6) - 3;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y16);
    ctx.lineTo(w, y16);
    ctx.moveTo(0, y33);
    ctx.lineTo(w, y33);
    ctx.stroke();

    if (histCount < 2) return;

    const plotSeries = (arr, maxVal, stroke) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      for (let i = 0; i < histCount; i++) {
        const idx = (histHead - histCount + i + SPARK_SAMPLES) % SPARK_SAMPLES;
        const x = (i / (SPARK_SAMPLES - 1)) * (w - 4) + 2;
        const norm = Math.max(0, Math.min(1, arr[idx] / maxVal));
        const y = h - 3 - norm * (h - 6);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    plotSeries(resHist, 110, '#34d399');
    plotSeries(polyHist, 110, '#c084fc');
    plotSeries(gpuHist, maxMs, '#38bdf8');
    plotSeries(frameHist, maxMs, '#fbbf24');

    if (sparkLegendSpans) {
      const nextLegend = [
        `● Frame ${lastFrameMs.toFixed(1)}ms`,
        `● Scene GPU ${lastGpuMs.toFixed(2)}ms`,
        `● Res ${lastResPct.toFixed(0)}%`,
        `● Poly ${lastPolyPct.toFixed(0)}%`,
      ];
      for (let i = 0; i < 4; i++) {
        if (sparkLegendLast[i] !== nextLegend[i]) {
          sparkLegendLast[i] = nextLegend[i];
          sparkLegendSpans[i].textContent = nextLegend[i];
        }
      }
    }
  }

  function renderPanelTelemetry(state) {
    if (!telemetryBodyEl) return;
    const oceanShips = state.locatedVessels.filter((v) => v.mode === 'ship');
    const coastalCogs = state.locatedVessels.filter((v) => v.mode === 'sea');
    const riverBoats = state.locatedVessels.filter((v) => v.mode === 'river');
    const distressed = state.locatedVessels.filter(
      (v) => v.aground || v.sunk || v.dismastedByBridge || v.floodingTonnes > 0.01 || v.holesCount > 0 || v.waterDepth < v.draft * 1.18,
    );

    const hub = state.settlements.find((s) => s.harbor) || state.settlements[0] || { name: 'Lisboa', prices: FALLBACK_HUB_PRICES };
    const hubName = hub.name || 'Lisbon';
    const hubPrices = { ...FALLBACK_HUB_PRICES, ...(hub.prices || {}) };

    const maxTurnover = Math.max(
      25,
      ...state.partnerPorts.map((p) => Math.max(Math.abs(p.exportsCrowns || 0), Math.abs(p.importsCrowns || 0), 1)),
    );

    let portRowsHtml = `<tr><td><strong>${escHtml(hubName)} (Hub)</strong></td>` +
      COMMODITY_KEYS.map((g) => `<td>${Number(hubPrices[g] || 1).toFixed(2)}</td>`).join('') +
      `<td>—</td></tr>`;

    let manifestHtml = '';
    for (const p of state.partnerPorts) {
      const cells = COMMODITY_KEYS.map((g) => {
        const pv = Number(p.prices?.[g] ?? hubPrices[g] ?? 1);
        const hv = Number(hubPrices[g] || 1);
        const color = pv > hv * 1.07 ? '#86efac' : (pv < hv * 0.93 ? '#93c5fd' : '#cbd5e1');
        return `<td style="color:${color}">${pv.toFixed(2)}</td>`;
      }).join('');
      const expW = Math.round(Math.min(34, ((p.exportsCrowns || 0) / maxTurnover) * 34));
      const impW = Math.round(Math.min(34, ((p.importsCrowns || 0) / maxTurnover) * 34));
      const bal = Number(p.balanceCrowns || 0);
      const balSign = bal >= 0 ? `+${bal.toFixed(0)}` : bal.toFixed(0);
      portRowsHtml += `<tr>` +
        `<td title="${escHtml(p.country)} · ${p.distanceNm} nm · ${p.foreignMerchants} factors">${escHtml(p.name)} <span style="color:#64748b">(${p.activeShips}⛵/${p.foreignMerchants}👤)</span></td>` +
        cells +
        `<td><span class="ww-dw-bar" style="width:${expW}px;background:#34d399" title="Exports ${p.exportsCrowns}c"></span>` +
        `<span class="ww-dw-bar" style="width:${impW}px;background:#f59e0b;margin-left:2px" title="Imports ${p.importsCrowns}c"></span> ` +
        `<span style="color:${bal >= 0 ? '#6ee7b7' : '#fcd34d'}">${balSign}c</span></td>` +
        `</tr>`;

      for (const m of p.manifests || []) {
        manifestHtml += `<div class="ww-dw-subrow">` +
          `<span><strong>${escHtml(m.shipName)}</strong> (${escHtml(p.name)}, ${escHtml(m.phase)})</span>` +
          `<span>${escHtml(m.merchant || m.captain)} · ${escHtml(m.summary)}</span>` +
          `</div>`;
      }
    }

    let groundingHtml = '';
    if (distressed.length) {
      for (const v of distressed.slice(0, 6)) {
        const flags = [];
        if (v.sunk) flags.push('SUNK');
        if (v.aground) flags.push('AGROUND');
        if (v.dismastedByBridge) flags.push('DISMASTED');
        if (v.floodingTonnes > 0) flags.push(`FLOOD ${v.floodingTonnes.toFixed(1)}t (${v.holesCount} holes)`);
        if (!flags.length) flags.push('SHOAL');
        groundingHtml += `<div class="ww-dw-subrow" style="color:#fecaca">` +
          `<span>⚠️ <strong>${escHtml(v.shipName || v.archLabel)}</strong> [${flags.join(' · ')}]</span>` +
          `<span>d:${Number(v.waterDepth).toFixed(2)}m / dr:${Number(v.draft).toFixed(2)}m</span>` +
          `</div>`;
      }
    } else if (state.locatedVessels.length) {
      let minUkc = Infinity;
      let tightest = null;
      for (const v of state.locatedVessels) {
        const ukc = Number(v.waterDepth) - Number(v.draft);
        if (ukc < minUkc) {
          minUkc = ukc;
          tightest = v;
        }
      }
      groundingHtml = `<div class="ww-dw-subrow" style="color:#a7f3d0">` +
        `<span>✓ All ${state.locatedVessels.length} vessels afloat</span>` +
        `<span>Min UKC ${Number.isFinite(minUkc) ? minUkc.toFixed(2) : '—'}m (${escHtml(tightest?.shipName || tightest?.archLabel || '—')})</span>` +
        `</div>`;
    }

    const settlementRows = state.settlements.slice(0, 6).map((s) => {
      const tag = s.harbor ? '⚓Harbor' : (s.riverside ? '🛶River' : '🏘️Inland');
      const st = s.stores || {};
      return `<div class="ww-dw-subrow">` +
        `<span><strong>${escHtml(s.name)}</strong> <span style="color:#94a3b8">${tag} (${s.pop})</span></span>` +
        `<span>Grn:${st.grain ?? 0} Win:${st.wine ?? 0} Tmb:${st.timber ?? 0} Fsh:${st.fish ?? 0}</span>` +
        `</div>`;
    }).join('');

    const minBridgeClear = state.bridges.length
      ? Math.min(...state.bridges.map((b) => b.clearanceM))
      : null;

    telemetryBodyEl.innerHTML =
      `<div class="ww-dw-clock">` +
        `<div><strong>${escHtml(state.dateLabel)}</strong> · 1 board day = <strong>${BOARD_DAY_REAL_HOURS_1X} real hrs</strong> at 1x</div>` +
        `<div class="ww-dw-badges">` +
          `<span class="ww-dw-pill">⛵ Ocean: ${oceanShips.length}</span>` +
          `<span class="ww-dw-pill">🧭 Cogs: ${coastalCogs.length}</span>` +
          `<span class="ww-dw-pill">🛶 Riverboats: ${riverBoats.length}</span>` +
          `<span class="ww-dw-pill">📦 Road Parcels: ${state.roadCaravans.length}</span>` +
          `<span class="ww-dw-pill">👥 Deck Crew: ${state.deckCrewCount}</span>` +
          (minBridgeClear != null
            ? `<span class="ww-dw-pill ${minBridgeClear < 2.2 ? 'warn' : 'ok'}">🌉 Bridges: ${state.bridges.length} (min ${minBridgeClear.toFixed(1)}m)</span>`
            : '') +
        `</div>` +
      `</div>` +
      `<div class="ww-dw-section-label">5 Partner-Port Prices vs ${escHtml(hubName)} & Trade Balance</div>` +
      `<div class="ww-dw-table-wrap"><table class="ww-dw-table"><thead><tr>` +
        `<th>Port</th>` +
        COMMODITY_KEYS.map((g) => `<th>${COMMODITY_SHORT[g]}</th>`).join('') +
        `<th>Exp/Imp</th>` +
      `</tr></thead><tbody>${portRowsHtml}</tbody></table></div>` +
      (manifestHtml
        ? `<div class="ww-dw-section-label">Active Foreign Ship Manifests</div><div class="ww-dw-sublist">${manifestHtml}</div>`
        : '') +
      `<div class="ww-dw-section-label">Hull Draft, Grounding & Local Settlement Stocks</div>` +
      `<div class="ww-dw-sublist">${groundingHtml}${settlementRows}</div>`;
  }

  function renderFullscreenOverlay(frame, state) {
    if (!hudCanvas) return;
    const ctx = hudCanvas.getContext?.('2d');
    if (!ctx) return;

    const dpr = Math.min(2, Math.max(1, Number(windowRef?.devicePixelRatio) || 1));
    const cssW = Math.max(320, Math.round(Number(frame.screenWidth ?? windowRef?.innerWidth ?? hudCanvas.clientWidth ?? 1280)));
    const cssH = Math.max(240, Math.round(Number(frame.screenHeight ?? windowRef?.innerHeight ?? hudCanvas.clientHeight ?? 720)));
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (hudCanvas.width !== targetW || hudCanvas.height !== targetH) {
      hudCanvas.width = targetW;
      hudCanvas.height = targetH;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    hoverTargets.length = 0;

    const viewProj = frame.viewProj ?? state.terrain?.viewProj ?? null;
    const camPos = frame.camPos ?? state.terrain?.camPos ?? [0, 60, 0];
    const terrain = state.terrain;
    const offX = state.offX;
    const offZ = state.offZ;
    const sampleGroundY = (wx, wz) => (
      terrain?.height ? terrain.height(wx, wz) : (terrain?.groundSample ? terrain.groundSample(wx, wz) : 0)
    );

    // Precompute live moving overland caravan parcel positions (closed-form matching herds.js WGSL)
    const liveCaravans = [];
    for (let i = 0; i < state.roadCaravans.length; i++) {
      const c = state.roadCaravans[i];
      if (!Array.isArray(c?.points) || c.points.length < 4) continue;
      const span = Math.max(0.25, (Number(c.arrive) || 1) - (Number(c.depart) || 0));
      const baseProg = c.halted ? 0.5 : (((state.boardDay - (Number(c.depart) || 0)) / span) % 1 + 1) % 1;
      const phase = ((baseProg + (Number(c.phaseOffset) || 0)) % 1 + 1) % 1;
      const pos = sampleFlatPolyline(c.points, phase);
      if (!pos) continue;
      const wx = pos.x - offX;
      const wz = pos.z - offZ;
      const wy = Math.max(0, sampleGroundY(wx, wz)) + 1.35;
      liveCaravans.push({
        key: c.key || `c${i}`,
        good: c.good || 'grain',
        qty: c.qty ?? 1,
        wx,
        wy,
        wz,
        yaw: pos.yaw,
        phase,
      });
    }

    // -------------------------------------------------------------------------
    // PART A: 3D World-Space Projected Routes, Bridges, Settlements, Caravans & Vessels
    // -------------------------------------------------------------------------
    if (viewProj && viewProj.length >= 16) {
      ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';

      // 1. Project trade roads in 3D
      const roads = state.board?.roads || [];
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.36)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 4]);
      for (const rd of roads) {
        const pts = rd?.points;
        if (!Array.isArray(pts) || pts.length < 4) continue;
        ctx.beginPath();
        let penDown = false;
        const step = Math.max(1, Math.floor((pts.length / 2) / 28));
        for (let k = 0; k < pts.length; k += step * 2) {
          const wx = pts[k] - offX;
          const wz = pts[k + 1] - offZ;
          const wy = Math.max(0.2, sampleGroundY(wx, wz) + 0.45);
          const p = projectWorldPoint3D(wx, wy, wz, viewProj, camPos, cssW, cssH);
          if (!p || p.dist > 9500) {
            penDown = false;
            continue;
          }
          if (!penDown) {
            ctx.moveTo(p.x, p.y);
            penDown = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 2. Project bridges with air-draft height labels
      for (const br of state.bridges) {
        const pa = projectWorldPoint3D(br.ax, br.deckY, br.az, viewProj, camPos, cssW, cssH);
        const pb = projectWorldPoint3D(br.bx, br.deckY, br.bz, viewProj, camPos, cssW, cssH);
        const pm = projectWorldPoint3D(br.x, br.deckY + 2.2, br.z, viewProj, camPos, cssW, cssH);
        if (pa && pb && (pa.onScreen || pb.onScreen)) {
          ctx.strokeStyle = '#f472b6';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
        if (pm && pm.onScreen && pm.dist < 6500) {
          const txt = `🌉 ${br.clearanceM.toFixed(1)}m air`;
          const tw = ctx.measureText(txt).width + 8;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
          ctx.fillRect(pm.x - tw * 0.5, pm.y - 8, tw, 16);
          ctx.strokeStyle = 'rgba(244, 114, 182, 0.7)';
          ctx.lineWidth = 1;
          ctx.strokeRect(pm.x - tw * 0.5, pm.y - 8, tw, 16);
          ctx.fillStyle = '#fbcfe8';
          ctx.fillText(txt, pm.x - tw * 0.5 + 4, pm.y);
          hoverTargets.push({
            x: pm.x,
            y: pm.y,
            r: 14,
            title: `${br.isStone ? 'Stone' : 'Timber'} Bridge #${br.id + 1}`,
            detail: `Air-draft clearance: ${br.clearanceM.toFixed(2)}m (deck ${br.deckY.toFixed(2)}m, water ${br.waterY.toFixed(2)}m, span ${br.span.toFixed(0)}m)`,
          });
        }
      }

      // 3. Project settlements
      for (const s of state.settlements) {
        const wx = s.x - offX;
        const wz = s.z - offZ;
        const wy = Math.max(2, sampleGroundY(wx, wz) + 14);
        const p = projectWorldPoint3D(wx, wy, wz, viewProj, camPos, cssW, cssH);
        if (!p || !p.onScreen || p.dist > 14000) continue;
        const icon = s.harbor ? '⚓' : (s.riverside ? '🛶' : '🏘️');
        const txt = `${icon} ${s.name} (${s.pop})`;
        const tw = ctx.measureText(txt).width + 10;
        ctx.fillStyle = 'rgba(2, 6, 23, 0.84)';
        ctx.fillRect(p.x - tw * 0.5, p.y - 9, tw, 18);
        ctx.strokeStyle = s.harbor ? '#38bdf8' : (s.riverside ? '#2dd4bf' : '#cbd5e1');
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x - tw * 0.5, p.y - 9, tw, 18);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(txt, p.x - tw * 0.5 + 5, p.y);
      }

      // 4. Project live overland caravan parcels
      for (const c of liveCaravans) {
        const p = projectWorldPoint3D(c.wx, c.wy + 2.2, c.wz, viewProj, camPos, cssW, cssH);
        if (!p || !p.onScreen || p.dist > 7000) continue;
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x + 4, p.y);
        ctx.lineTo(p.x, p.y + 4);
        ctx.lineTo(p.x - 4, p.y);
        ctx.closePath();
        ctx.fill();
        if (p.dist < 3800) {
          const txt = `${c.good} ×${c.qty}`;
          const tw = ctx.measureText(txt).width + 6;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
          ctx.fillRect(p.x + 6, p.y - 7, tw, 14);
          ctx.fillStyle = '#fde68a';
          ctx.fillText(txt, p.x + 9, p.y);
        }
        hoverTargets.push({
          x: p.x,
          y: p.y,
          r: 10,
          title: `Caravan Parcel (${c.key})`,
          detail: `Cargo: ${c.qty} ${c.good} · Route phase ${(c.phase * 100).toFixed(0)}%`,
        });
      }

      // 5. Project ocean ships, coastal cogs & riverboats (nearest-first with screen-space box decluttering)
      const placedVesselBoxes = [];
      const sortedVessels = state.locatedVessels
        .map((v) => {
          const labelH = Math.min(20, Math.max(3.2, (Number(v.maxAirDraft) || 3) * 0.65));
          const p = projectWorldPoint3D(v.x, (v.y || 0) + labelH, v.z, viewProj, camPos, cssW, cssH);
          return { v, p };
        })
        .filter((it) => it.p && it.p.onScreen && it.p.dist <= 15000)
        .sort((a, b) => a.p.dist - b.p.dist);

      for (const { v, p } of sortedVessels) {
        const alert = v.aground || v.sunk || v.dismastedByBridge || v.floodingTonnes > 0.01;
        const accent = alert
          ? '#f87171'
          : (v.mode === 'ship' ? '#38bdf8' : (v.mode === 'sea' ? '#818cf8' : '#34d399'));
        const cargoTxt = formatCargoShort(v.phase === 'out' && Object.keys(v.load || {}).length ? v.load : v.cargo);
        const topLine = `${v.shipName || v.archLabel} · ${(Number(v.speed) || 0).toFixed(1)}m/s` +
          (v.homePort ? ` · ${v.homePort}` : '');
        const botLine = `d:${Number(v.waterDepth).toFixed(1)}m/dr:${Number(v.draft).toFixed(2)}m · ${cargoTxt}` +
          (v.aground ? ' · AGROUND' : '') +
          (v.floodingTonnes > 0 ? ` · FLOOD ${v.floodingTonnes}t` : '') +
          (v.dismastedByBridge ? ' · DISMASTED' : '');

        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.stroke();

        if (p.dist < 6500 || alert) {
          const w1 = ctx.measureText(topLine).width;
          const w2 = ctx.measureText(botLine).width;
          const boxW = Math.max(w1, w2) + 10;
          const boxH = 28;
          const bx = p.x - boxW * 0.5;
          const by = p.y - boxH - 7;
          let overlaps = false;
          for (const ob of placedVesselBoxes) {
            if (bx < ob.x + ob.w + 4 && bx + boxW + 4 > ob.x && by < ob.y + ob.h + 3 && by + boxH + 3 > ob.y) {
              overlaps = true;
              break;
            }
          }
          if (!overlaps) {
            placedVesselBoxes.push({ x: bx, y: by, w: boxW, h: boxH });
            ctx.fillStyle = alert ? 'rgba(69, 10, 10, 0.88)' : 'rgba(2, 6, 23, 0.84)';
            ctx.fillRect(bx, by, boxW, boxH);
            ctx.strokeStyle = accent;
            ctx.strokeRect(bx, by, boxW, boxH);
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(topLine, bx + 5, by + 8);
            ctx.fillStyle = alert ? '#fecaca' : '#94a3b8';
            ctx.fillText(botLine, bx + 5, by + 20);
          }
        }

        hoverTargets.push({
          x: p.x,
          y: p.y,
          r: 14,
          title: `${v.shipName || v.archLabel} (${v.archLabel})`,
          detail: `Mode: ${v.mode} · Port: ${v.homePort || 'Local'} · Speed: ${(Number(v.speed) || 0).toFixed(2)} m/s · Depth ${Number(v.waterDepth).toFixed(2)}m vs Draft ${Number(v.draft).toFixed(2)}m · Cargo: ${cargoTxt}`,
        });
      }
    }

    // -------------------------------------------------------------------------
    // PART B: Corner Regional Logistics & Seam Map (2D Radar / Minimap)
    // -------------------------------------------------------------------------
    const mapSize = Math.min(348, Math.max(240, Math.round(Math.min(cssW, cssH) * 0.38)));
    const mapX = cssW - mapSize - 16;
    const mapY = cssH - mapSize - 16;

    // Compute world bounds centered around loaded terrain mosaic or camera, scaled by radarZoom
    let secMinX = Infinity, secMaxX = -Infinity, secMinZ = Infinity, secMaxZ = -Infinity;
    for (const sec of state.sections) {
      if (Number.isFinite(sec.minX)) secMinX = Math.min(secMinX, sec.minX);
      if (Number.isFinite(sec.maxX)) secMaxX = Math.max(secMaxX, sec.maxX);
      if (Number.isFinite(sec.minZ)) secMinZ = Math.min(secMinZ, sec.minZ);
      if (Number.isFinite(sec.maxZ)) secMaxZ = Math.max(secMaxZ, sec.maxZ);
    }
    const mosaicCX = Number.isFinite(secMinX) && Number.isFinite(secMaxX) ? 0.5 * (secMinX + secMaxX) : 0;
    const mosaicCZ = Number.isFinite(secMinZ) && Number.isFinite(secMaxZ) ? 0.5 * (secMinZ + secMaxZ) : 0;
    const worldExtent = Number.isFinite(secMinX) && Number.isFinite(secMaxX)
      ? Math.max(2600, 0.5 * Math.max(secMaxX - secMinX, secMaxZ - secMinZ))
      : 2600;
    const viewHalf = (worldExtent * 1.06) / radarZoom;
    const camFollow = radarZoom > 1.15 ? Math.min(1, (radarZoom - 1) / 1.2) : 0.15;
    const centerWX = mosaicCX * (1 - camFollow) + (camPos?.[0] ?? mosaicCX) * camFollow;
    const centerWZ = mosaicCZ * (1 - camFollow) + (camPos?.[2] ?? mosaicCZ) * camFollow;
    const toMapX = (wx) => mapX + ((wx - centerWX) / (viewHalf * 2) + 0.5) * mapSize;
    const toMapY = (wz) => mapY + ((wz - centerWZ) / (viewHalf * 2) + 0.5) * mapSize;

    ctx.save();
    ctx.fillStyle = 'rgba(2, 6, 23, 0.90)';
    ctx.fillRect(mapX, mapY, mapSize, mapSize);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mapX, mapY, mapSize, mapSize);

    ctx.beginPath();
    ctx.rect(mapX + 1, mapY + 22, mapSize - 2, mapSize - 40);
    ctx.clip();

    // 1. Loaded Terrain Sections ((0,0) Center vs DEM Grown vs Mock Tiles)
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const sec of state.sections) {
      const x0 = toMapX(sec.minX);
      const y0 = toMapY(sec.minZ);
      const x1 = toMapX(sec.maxX);
      const y1 = toMapY(sec.maxZ);
      const sw = x1 - x0;
      const sh = y1 - y0;
      if (sec.kind === 'center') {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.72)';
      } else if (sec.kind === 'mock') {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.68)';
      } else {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      }
      ctx.lineWidth = 1;
      ctx.fillRect(x0, y0, sw, sh);
      ctx.strokeRect(x0, y0, sw, sh);
      if (sw > 44 && sh > 20) {
        ctx.fillStyle = sec.kind === 'center' ? '#6ee7b7' : (sec.kind === 'mock' ? '#fde68a' : '#7dd3fc');
        ctx.fillText(sec.label, x0 + 4, y0 + 10);
      }
    }

    // 2. River network + bridges (with air-draft height labels)
    const rivers = state.board?.rivers || [];
    for (const rv of rivers) {
      const pts = rv?.points;
      if (!Array.isArray(pts) || pts.length < 6) continue;
      ctx.strokeStyle = rv.canal ? 'rgba(45, 212, 191, 0.78)' : 'rgba(56, 189, 248, 0.72)';
      ctx.lineWidth = Math.max(1.6, Math.min(5, ((pts[2] || 6) / viewHalf) * mapSize * 1.8));
      ctx.beginPath();
      for (let k = 0; k + 2 < pts.length; k += 3) {
        const mx = toMapX(pts[k] - offX);
        const my = toMapY(pts[k + 1] - offZ);
        if (k === 0) ctx.moveTo(mx, my);
        else ctx.lineTo(mx, my);
      }
      ctx.stroke();
    }

    // 3. Trade roads + moving overland caravan parcels
    ctx.strokeStyle = 'rgba(217, 119, 6, 0.62)';
    ctx.lineWidth = 1.15;
    for (const rd of state.board?.roads || []) {
      const pts = rd?.points;
      if (!Array.isArray(pts) || pts.length < 4) continue;
      ctx.beginPath();
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const mx = toMapX(pts[k] - offX);
        const my = toMapY(pts[k + 1] - offZ);
        if (k === 0) ctx.moveTo(mx, my);
        else ctx.lineTo(mx, my);
      }
      ctx.stroke();
    }

    for (const br of state.bridges) {
      const mx = toMapX(br.x);
      const my = toMapY(br.z);
      ctx.strokeStyle = '#f472b6';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(mx - 4, my - 4);
      ctx.lineTo(mx + 4, my + 4);
      ctx.stroke();
      ctx.fillStyle = '#fbcfe8';
      ctx.fillText(`${br.clearanceM.toFixed(1)}m`, mx + 5, my - 2);
      hoverTargets.push({
        x: mx,
        y: my,
        r: 7,
        title: `Bridge #${br.id + 1}`,
        detail: `Air-draft clearance ${br.clearanceM.toFixed(2)}m (deck ${br.deckY.toFixed(2)}m)`,
      });
    }

    for (const s of state.settlements) {
      const mx = toMapX(s.x - offX);
      const my = toMapY(s.z - offZ);
      ctx.fillStyle = s.harbor ? '#38bdf8' : (s.riverside ? '#2dd4bf' : '#e2e8f0');
      ctx.beginPath();
      ctx.arc(mx, my, s.harbor ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(s.name, mx + 5, my + 1);
    }

    for (const c of liveCaravans) {
      const mx = toMapX(c.wx);
      const my = toMapY(c.wz);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(mx - 2, my - 2, 4, 4);
      hoverTargets.push({
        x: mx,
        y: my,
        r: 6,
        title: `Caravan (${c.good} ×${c.qty})`,
        detail: `Overland parcel ${c.key}`,
      });
    }

    // 4. Ocean ships, coastal cogs, and riverboats on radar
    for (const v of state.locatedVessels) {
      const mx = toMapX(v.x);
      const my = toMapY(v.z);
      const alert = v.aground || v.sunk || v.dismastedByBridge || v.floodingTonnes > 0.01;
      const color = alert
        ? '#f87171'
        : (v.mode === 'ship' ? '#38bdf8' : (v.mode === 'sea' ? '#a5b4fc' : '#34d399'));
      const yaw = Number(v.yaw) || 0;
      const dx = Math.sin(yaw);
      const dz = -Math.cos(yaw);
      const r = v.mode === 'river' ? 4.2 : 5.6;

      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.atan2(dz, dx));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.75, r * 0.62);
      ctx.lineTo(-r * 0.4, 0);
      ctx.lineTo(-r * 0.75, -r * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      if (alert) {
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(mx, my, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      const cargoTxt = formatCargoShort(v.phase === 'out' && Object.keys(v.load || {}).length ? v.load : v.cargo);
      hoverTargets.push({
        x: mx,
        y: my,
        r: 8,
        title: `${v.shipName || v.archLabel} (${v.archLabel})`,
        detail: `${v.homePort || 'Local'} · ${(Number(v.speed) || 0).toFixed(1)}m/s · depth ${Number(v.waterDepth).toFixed(1)}m / draft ${Number(v.draft).toFixed(2)}m · ${cargoTxt}`,
      });
    }

    // Camera marker on radar
    const camMX = toMapX(camPos?.[0] ?? 0);
    const camMY = toMapY(camPos?.[2] ?? 0);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(camMX, camMY, 4.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore(); // unclip radar body

    // Radar header & legend footer
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fillRect(mapX + 1, mapY + 1, mapSize - 2, 20);
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`REGIONAL LOGISTICS & SEAM MAP (${(viewHalf * 2 / 1000).toFixed(1)}km · [ / ] zoom)`, mapX + 7, mapY + 11);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fillRect(mapX + 1, mapY + mapSize - 18, mapSize - 2, 17);
    ctx.font = '600 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#6ee7b7';
    ctx.fillText('■(0,0)', mapX + 6, mapY + mapSize - 9);
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText('■DEM', mapX + 46, mapY + mapSize - 9);
    ctx.fillStyle = '#fde68a';
    ctx.fillText('■Mock', mapX + 78, mapY + mapSize - 9);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('▲Ship', mapX + 116, mapY + mapSize - 9);
    ctx.fillStyle = '#34d399';
    ctx.fillText('▲River', mapX + 154, mapY + mapSize - 9);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('◆Parcel', mapX + 198, mapY + mapSize - 9);
    ctx.fillStyle = '#f472b6';
    ctx.fillText('🌉Bridge', mapX + 248, mapY + mapSize - 9);

    // Interactive hover tooltip
    if (pointer.active) {
      let best = null;
      let bestD = Infinity;
      for (const ht of hoverTargets) {
        const d = Math.hypot(pointer.x - ht.x, pointer.y - ht.y);
        if (d <= ht.r && d < bestD) {
          best = ht;
          bestD = d;
        }
      }
      if (best) {
        ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        const wTitle = ctx.measureText(best.title).width;
        const wDet = ctx.measureText(best.detail).width;
        const tw = Math.max(wTitle, wDet) + 14;
        const th = 34;
        const tx = Math.max(8, Math.min(cssW - tw - 8, pointer.x + 14));
        const ty = Math.max(8, Math.min(cssH - th - 8, pointer.y + 14));
        ctx.fillStyle = 'rgba(2, 6, 23, 0.94)';
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(tx, ty, tw, th);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(best.title, tx + 7, ty + 11);
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(best.detail, tx + 7, ty + 24);
      }
    }

    ctx.restore();
  }

  function update(frame = {}) {
    if (destroyed) return;
    const panelVisible = Boolean(
      performancePanel && !performancePanel.hidden && performancePanel.style?.display !== 'none',
    );
    // Strict zero-cost fast exit when both #performance-panel and fullscreen overlay are hidden!
    if (!panelVisible && !overlayVisible) return;

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const frameMs = Number.isFinite(frame.frameMs)
      ? Number(frame.frameMs)
      : (Number.isFinite(frame.dt) && frame.dt > 0 ? Number(frame.dt) * 1000 : lastFrameMs);
    const gpuMs = Number.isFinite(frame.sceneGpuMs)
      ? Number(frame.sceneGpuMs)
      : extractSceneGpuMs(getProfiler?.());
    const resPct = normalizePercent(frame.resolution ?? getResolution?.(), lastResPct);
    const polyPct = normalizePercent(frame.polygons ?? getPolygons?.(), lastPolyPct);

    lastFrameMs = frameMs;
    lastGpuMs = gpuMs;
    lastResPct = resPct;
    lastPolyPct = polyPct;
    pushSample(frameMs, gpuMs, resPct, polyPct);

    let worldState = null;
    if (panelVisible) {
      if (nowMs - lastSparkMs >= 80) {
        lastSparkMs = nowMs;
        drawSparklineCanvas();
      }
      if (nowMs - lastPanelHtmlMs >= 240) {
        lastPanelHtmlMs = nowMs;
        worldState = gatherWorldState(frame);
        renderPanelTelemetry(worldState);
      }
    }

    if (overlayVisible) {
      if (!worldState) worldState = gatherWorldState(frame);
      renderFullscreenOverlay(frame, worldState);
    }
  }

  return {
    update,
    toggleOverlay,
    isOverlayOpen() {
      return overlayVisible;
    },
    refreshTelemetry(frame = {}) {
      lastPanelHtmlMs = -Infinity;
      lastLocateMs = -Infinity;
      const worldState = gatherWorldState(frame);
      renderPanelTelemetry(worldState);
      return worldState;
    },
    get overlayCanvas() {
      return hudCanvas;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      windowRef?.removeEventListener?.('keydown', onKeyDown);
      windowRef?.removeEventListener?.('mousemove', onPointerMove);
      rootEl?.remove?.();
      if (createdHudCanvas) hudCanvas?.remove?.();
    },
  };
}
