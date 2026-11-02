/**
 * Headless run of the nankai_trough solver (../N73_nankai_trough) for its preset scenarios, with Osaka Bay on its
 * nested 15 arc-second grid (bathymetry_osaka_bay, one-way NestedGrid), sampling Osaka Bay points and stations every
 * 3 km along the west and south edges of the simulation region; writes the time histories as JSON for
 * tools/build-wave-sources.mjs.
 *
 *   npx esbuild tools/nankai/run-nankai.ts --bundle --platform=node --format=esm --external:proj4 --outfile=.cache/run-nankai.mjs
 *   node .cache/run-nankai.mjs cao2012_case3 10800 .cache/nankai_results.json
 *   (a few minutes per scenario for 3 h of simulated time)
 */
import fs from 'node:fs';
import { ShallowWaterSolver } from '../../../../N73_nankai_trough/nankai_trough/src/physics/shallowWater';
import { NestedGrid } from '../../../../N73_nankai_trough/nankai_trough/src/physics/nestedGrid';
import { computeInitialDisplacementGrid } from '../../../../N73_nankai_trough/nankai_trough/src/physics/okada';
import { FAULT_PRESETS } from '../../../../N73_nankai_trough/nankai_trough/src/data/presets';
import { toLonLat } from '../lib/proj.mjs';

const STATION_STEP_M = 3000;
const INSET_M = 200; // inside the wave-input zone
// run from osaka_tsunami_desktop/ (N73_nankai_trough sits next to N74_osaka_tsunami)
const root = '../../N73_nankai_trough/nankai_trough/public/';
const load = (name: string) => {
  const buf = fs.readFileSync(root + name);
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
};
const meta = JSON.parse(fs.readFileSync(root + 'bathymetry_meta.json', 'utf8'));
const bathy = load('bathymetry.bin');
const nestMeta = JSON.parse(fs.readFileSync(root + 'bathymetry_osaka_bay_meta.json', 'utf8'));
const fine = load('bathymetry_osaka_bay.bin');
const reg = JSON.parse(fs.readFileSync('public/data/regions/osaka_port/meta.json', 'utf8'));

const nb = nestMeta.bounds;
const seaAt = (lon: number, lat: number) => {
  const c = Math.floor(((lon - nb.lonMin) / (nb.lonMax - nb.lonMin)) * nestMeta.width);
  const r = Math.floor(((nb.latMax - lat) / (nb.latMax - nb.latMin)) * nestMeta.height);
  return c >= 0 && c < nestMeta.width && r >= 0 && r < nestMeta.height && fine[r * nestMeta.width + c] < -5;
};

/** Stations in order along the input zone: the west edge north to south, then the south edge west to east (p = metres along it). */
function edgeStations() {
  const out: any[] = [];
  const add = (p: number, x: number, z: number) => {
    const [lon, lat] = toLonLat(reg.originE + x, reg.originN - z);
    if (seaAt(lon, lat)) out.push({ id: `edge_${out.length}`, name: '大阪湾 計算領域の端', lon: +lon.toFixed(5), lat: +lat.toFixed(5), p, x, z, color: '#fff' });
  };
  for (let z = STATION_STEP_M / 2; z < reg.heightM; z += STATION_STEP_M) add(z, INSET_M, z);
  for (let x = STATION_STEP_M / 2; x < reg.widthM; x += STATION_STEP_M) add(reg.heightM + x, x, reg.heightM - INSET_M);
  return out;
}

const ids = (process.argv[2] || '').split(',').filter(Boolean);
const durationSec = +(process.argv[3] || 10800);
const out = process.argv[4];
const results: any = {};
for (const sc of FAULT_PRESETS.filter((s) => !ids.length || ids.includes(s.id))) {
  const solver = new ShallowWaterSolver(meta, bathy, 3.0);
  const nest = new NestedGrid('osaka_bay', nestMeta, fine, solver, meta);
  const stations = edgeStations();
  const pts: any[] = [
    { id: 'osaka_port_off', name: '大阪港沖 (大阪湾)', lon: 135.35, lat: 34.6, color: '#fff' },
    { id: 'osaka_bay_w', name: '大阪湾 西', lon: 135.3, lat: 34.62, color: '#fff' },
    { id: 'osaka_edge_mid', name: '大阪湾 計算領域西端', lon: 135.345, lat: 34.655, color: '#fff' },
    ...stations,
  ];
  solver.observationPoints = [];
  nest.observationPoints = pts;
  const faults = JSON.parse(JSON.stringify(sc.faults));
  const rupture = sc.rupture && sc.hypocenter ? { lon: sc.hypocenter.lon, lat: sc.hypocenter.lat, ...sc.rupture } : undefined;
  const b = meta.bounds;
  solver.resetWithDisplacement(computeInitialDisplacementGrid(faults, meta.width, meta.height, b.lonMin, b.lonMax, b.latMin, b.latMax), rupture);
  nest.reset(computeInitialDisplacementGrid(faults, nestMeta.width, nestMeta.height, nb.lonMin, nb.lonMax, nb.latMin, nb.latMax), rupture);
  const t0 = Date.now();
  while (solver.currentTimeSec < durationSec) { solver.step(); nest.step(); }
  results[sc.id] = { name: sc.name, points: pts };
  console.log(sc.id, sc.name, ((Date.now() - t0) / 1000).toFixed(0) + 's', `${stations.length} stations`);
  for (const p of pts) console.log(`  ${p.id.padEnd(15)} ${String(p.lon).padEnd(9)} ${String(p.lat).padEnd(9)} p=${String(p.p ?? '').padEnd(6)} max ${p.maxWaveHeight} @${(p.maxArrivalSec / 60).toFixed(1)}min first ${p.firstArrivalSec != null ? (p.firstArrivalSec / 60).toFixed(1) + 'min' : '-'}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(results));
