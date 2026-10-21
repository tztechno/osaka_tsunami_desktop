/**
 * Headless run of the nankai_trough solver (../N73_nankai_trough) for its preset scenarios,
 * sampling Osaka Bay points; writes the time histories as JSON for tools/build-wave-sources.mjs.
 *
 *   npx esbuild tools/nankai/run-nankai.ts --bundle --platform=node --format=esm --outfile=.cache/run-nankai.mjs
 *   node .cache/run-nankai.mjs cao2012_case1,cao2012_case2,cao2012_case3,cao2012_case4,cao2012_case5,nankai_full_m9 10800 .cache/nankai_results.json
 *   (~100 s per scenario for 3 h of simulated time)
 */
import fs from 'node:fs';
import { ShallowWaterSolver } from '../../../../N73_nankai_trough/nankai_trough/src/physics/shallowWater';
import { computeInitialDisplacementGrid } from '../../../../N73_nankai_trough/nankai_trough/src/physics/okada';
import { FAULT_PRESETS } from '../../../../N73_nankai_trough/nankai_trough/src/data/presets';
// run from osaka_tsunami/ (N73_nankai_trough sits next to N74_osaka_tsunami)
const root = '../../N73_nankai_trough/nankai_trough/public/';
const meta = JSON.parse(fs.readFileSync(root + 'bathymetry_meta.json', 'utf8'));
const buf = fs.readFileSync(root + 'bathymetry.bin');
const bathy = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
const ids = (process.argv[2] || '').split(',').filter(Boolean);
const durationSec = +(process.argv[3] || 10800);
const out = process.argv[4];
const results: any = {};
for (const sc of FAULT_PRESETS.filter((s) => !ids.length || ids.includes(s.id))) {
  const solver = new ShallowWaterSolver(meta, bathy, 3.0);
  const pts = [
    { id: 'osaka_port_off', name: '大阪港沖 (大阪湾)', lon: 135.35, lat: 34.6, color: '#fff' },
    { id: 'osaka_bay_w', name: '大阪湾 西', lon: 135.3, lat: 34.62, color: '#fff' },
    { id: 'osaka_edge_mid', name: '大阪湾 計算領域西端', lon: 135.345, lat: 34.655, color: '#fff' },
  ];
  solver.observationPoints = pts as any;
  const faults = JSON.parse(JSON.stringify(sc.faults));
  const eta0 = computeInitialDisplacementGrid(faults, meta.width, meta.height, meta.bounds.lonMin, meta.bounds.lonMax, meta.bounds.latMin, meta.bounds.latMax);
  const rupture = sc.rupture && sc.hypocenter ? { lon: sc.hypocenter.lon, lat: sc.hypocenter.lat, ...sc.rupture } : undefined;
  solver.resetWithDisplacement(eta0, rupture);
  for (const p of pts) solver.sampleSinglePoint(p as any);
  const t0 = Date.now();
  while (solver.currentTimeSec < durationSec) solver.step();
  results[sc.id] = { name: sc.name, points: pts };
  console.log(sc.id, sc.name, ((Date.now() - t0) / 1000).toFixed(0) + 's', pts.map((p: any) => `${p.id}: max ${p.maxWaveHeight} @${p.maxArrivalSec}s first ${p.firstArrivalSec}`).join(' | '));
}
if (out) fs.writeFileSync(out, JSON.stringify(results));
