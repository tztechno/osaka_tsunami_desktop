/**
 * Web Worker running the Nankai Trough wide-area + Osaka Bay 15" nested shallow-water solver
 * from a parsed fault model, sampling waveforms along the Osaka simulation region's west and south edges.
 */
import { ShallowWaterSolver } from './shallowWater.js';
import { NestedGrid } from './nestedGrid.js';
import { computeInitialDisplacementGrid } from './okada.js';
import { toLonLat } from '../proj.js';

const STATION_STEP_M = 400; // about one cell of the Osaka Bay 15" nest (382 x 463 m)
const INSET_M = 200;
const EDGE_DT_SEC = 6;
const DEFAULT_DURATION_SEC = 10800; // 3 hours

let cachedData = null;

async function loadData(baseUrl) {
  if (cachedData) return cachedData;
  const url = (rel) => new URL(rel, baseUrl).href;
  const [meta, bathyBuf, nestMeta, fineBuf, reg] = await Promise.all([
    fetch(url('data/nankai/bathymetry_meta.json')).then((r) => r.json()),
    fetch(url('data/nankai/bathymetry.bin')).then((r) => r.arrayBuffer()),
    fetch(url('data/nankai/bathymetry_osaka_bay_meta.json')).then((r) => r.json()),
    fetch(url('data/nankai/bathymetry_osaka_bay.bin')).then((r) => r.arrayBuffer()),
    fetch(url('data/regions/osaka_port/meta.json')).then((r) => r.json()),
  ]);
  cachedData = {
    meta,
    bathy: new Int16Array(bathyBuf),
    nestMeta,
    fine: new Int16Array(fineBuf),
    reg,
  };
  return cachedData;
}

function buildEdgeStations(reg, nestMeta, fine) {
  const nb = nestMeta.bounds;
  const seaAt = (lon, lat) => {
    const c = Math.floor(((lon - nb.lonMin) / (nb.lonMax - nb.lonMin)) * nestMeta.width);
    const r = Math.floor(((nb.latMax - lat) / (nb.latMax - nb.latMin)) * nestMeta.height);
    return c >= 0 && c < nestMeta.width && r >= 0 && r < nestMeta.height && fine[r * nestMeta.width + c] < -5;
  };
  const out = [];
  const add = (p, x, z) => {
    const [lon, lat] = toLonLat(reg.originE + x, reg.originN - z);
    if (seaAt(lon, lat)) {
      out.push({
        id: `edge_${out.length}`,
        name: '大阪湾 計算領域の端',
        lon: +lon.toFixed(5),
        lat: +lat.toFixed(5),
        p,
        color: '#fff',
      });
    }
  };
  for (let z = STATION_STEP_M / 2; z < reg.heightM; z += STATION_STEP_M) add(z, INSET_M, z);
  // the south edge starts past the south-west corner, which the west edge already samples
  for (let x = STATION_STEP_M / 2; x < reg.widthM; x += STATION_STEP_M) if (x > INSET_M) add(reg.heightM + x, x, reg.heightM - INSET_M);
  return out;
}

function formatFullCsv(pt, durationSec) {
  const lines = [
    '# Tsunami Wave Boundary Condition for Phase 2 Simulation (Full Timeline)',
    `# Location: ${pt.name} (Lon: ${pt.lon}, Lat: ${pt.lat})`,
    `# Max Wave Height: ${pt.maxWaveHeight ?? 0} m, First Arrival: ${pt.firstArrivalSec ?? 'N/A'} s`,
    'Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg',
  ];
  for (const r of pt.timeHistory) {
    if (r.timeSec <= durationSec) {
      lines.push(
        `${r.timeSec.toFixed(1)},${r.elevation.toFixed(3)},${r.u.toFixed(3)},${r.v.toFixed(3)},${r.speed.toFixed(3)},${r.directionDeg.toFixed(1)}`
      );
    }
  }
  return '\uFEFF' + lines.join('\r\n');
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'run') return;

  try {
    const { faults, rupture, baseUrl, durationSec = DEFAULT_DURATION_SEC } = msg;
    self.postMessage({ type: 'progress', phase: 'load', pct: 0, currentTimeSec: 0, durationSec });

    const { meta, bathy, nestMeta, fine, reg } = await loadData(baseUrl);
    const stations = buildEdgeStations(reg, nestMeta, fine);
    if (stations.length === 0) {
      throw new Error('No offshore boundary stations found along region edges');
    }

    const midPt = { id: 'osaka_edge_mid', name: '大阪湾 計算領域西端', lon: 135.345, lat: 34.655, color: '#fff' };
    const pts = [midPt, ...stations];

    self.postMessage({ type: 'progress', phase: 'okada', pct: 2, currentTimeSec: 0, durationSec });

    const solver = new ShallowWaterSolver(meta, bathy, 3.0);
    const nest = new NestedGrid('osaka_bay', nestMeta, fine, solver, meta);
    solver.observationPoints = [];
    nest.observationPoints = pts;

    const b = meta.bounds;
    const nb = nestMeta.bounds;
    const coarseEta0 = computeInitialDisplacementGrid(faults, meta.width, meta.height, b.lonMin, b.lonMax, b.latMin, b.latMax);
    const fineEta0 = computeInitialDisplacementGrid(faults, nestMeta.width, nestMeta.height, nb.lonMin, nb.lonMax, nb.latMin, nb.latMax);
    solver.resetWithDisplacement(coarseEta0, rupture);
    nest.reset(fineEta0, rupture);

    let lastPost = performance.now();
    while (solver.currentTimeSec < durationSec) {
      solver.step();
      nest.step();
      const now = performance.now();
      if (now - lastPost >= 200) {
        lastPost = now;
        const pct = Math.min(99, Math.round(2 + (solver.currentTimeSec / durationSec) * 97));
        self.postMessage({ type: 'progress', phase: 'sim', pct, currentTimeSec: solver.currentTimeSec, durationSec });
      }
    }

    // nest cells that count as sea but never get wet (e.g. behind a breakwater) would pull the boundary wave to 0
    const wet = stations.filter((s) => (s.maxWaveHeight ?? 0) > 0);
    if (wet.length === 0) throw new Error('No boundary station got wet');
    stations.length = 0;
    stations.push(...wet);
    const hist = stations[0].timeHistory;
    if (!hist || hist.length < 2) {
      throw new Error('Insufficient time history recorded at boundary stations');
    }
    const dt0 = hist[1].timeSec - hist[0].timeSec;
    const every = Math.max(1, Math.round(EDGE_DT_SEC / dt0));
    const count = Math.floor(hist.length / every);
    const p = stations.map((s) => s.p);
    const eta = new Float32Array(stations.length * count);
    let peak = 0;
    for (let s = 0; s < stations.length; s++) {
      const th = stations[s].timeHistory;
      for (let k = 0; k < count; k++) {
        const v = +th[k * every].elevation.toFixed(2);
        eta[s * count + k] = v;
        if (v > peak) peak = v;
      }
    }

    // Representative point for WaveProfile clock / chart / fallback
    const repPt = (midPt.timeHistory && midPt.timeHistory.length >= 2 && (midPt.maxWaveHeight ?? 0) > 0)
      ? midPt
      : stations.reduce((best, s) => ((s.maxWaveHeight ?? 0) > (best.maxWaveHeight ?? 0) ? s : best), stations[0]);
    const representativeCsv = formatFullCsv(repPt, durationSec);

    const edgeWaves = { p, dtSec: every * dt0, count, eta };
    const stationSummary = stations.map((s) => ({
      p: s.p,
      lon: s.lon,
      lat: s.lat,
      maxWaveHeight: s.maxWaveHeight ?? 0,
      maxArrivalSec: s.maxArrivalSec ?? null,
      firstArrivalSec: s.firstArrivalSec ?? null,
    }));

    self.postMessage(
      {
        type: 'done',
        edgeWaves,
        representativeCsv,
        peak,
        stationSummary,
      },
      [eta.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
