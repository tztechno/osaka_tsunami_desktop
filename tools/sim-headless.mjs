/**
 * Headless regression run of the tsunami simulation (no browser): prints inundation / overtopping
 * every 5 simulated minutes and optionally writes a max-inundation map.
 *
 *   node tools/sim-headless.mjs [preset] [minutes] [map.jpg]
 *     preset   sluice_closed | sluice_open | no_seawall   (default sluice_closed)
 *   SCENARIO=extreme_megathrust node tools/sim-headless.mjs ...   # parametric scenario instead of the CSV
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { TsunamiSimulator } from '../src/tsunamiSim.js';
import { WaveProfile } from '../src/waveProfile.js';
import { SeawallManager } from '../src/seawall.js';
import { TSUNAMI_SCENARIOS } from '../src/scenarios.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port');
const [preset = 'sluice_closed', minutes = '60', mapFile] = process.argv.slice(2);

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const ground = new Float32Array(fs.readFileSync(path.join(dir, 'ground.f32')).buffer.slice(0));
const waterMask = new Uint8Array(fs.readFileSync(path.join(dir, 'water.u8')));
const { nx, ny, res } = meta;
const buildings = JSON.parse(fs.readFileSync(path.join(dir, 'buildings.json'), 'utf8')).filter((b) => {
  const i = Math.min(nx - 1, Math.max(0, Math.floor(b.x / res)));
  const j = Math.min(ny - 1, Math.max(0, Math.floor(b.z / res)));
  return waterMask[j * nx + i] === 0;
});

const walls = new SeawallManager(meta);
walls.ground = ground;
walls.waterMask = waterMask;
walls.seawallData = JSON.parse(fs.readFileSync(path.join(dir, 'seawalls.json'), 'utf8'));
walls.classifyShore();
walls.setPreset(preset);

const sim = new TsunamiSimulator({ meta, ground, waterMask, seawallManager: walls, buildings });
if (process.env.SCENARIO) {
  sim.setScenario(TSUNAMI_SCENARIOS[process.env.SCENARIO]);
} else {
  const csv = fs.readFileSync(path.join(appRoot, 'public', 'data', 'wave_sources', 'nankai_trough_osaka_trimmed.csv'), 'utf8');
  sim.setWaveProfile(WaveProfile.parse(csv, 'nankai_trough_osaka_trimmed.csv'));
}
console.log(`preset ${preset}, wave ${sim.waveHeight.toFixed(2)} m from ${sim.waveDirectionDeg}°, ${sim.bcCells.length} boundary cells`);

const t0 = Date.now();
for (let m = 5; m <= +minutes; m += 5) {
  sim.advance(300);
  sim.updateStats();
  let zeroM = 0;
  for (let i = 0; i < sim.N; i++) if (!waterMask[i] && ground[i] < 0 && sim.depth[i] >= 0.05) zeroM++;
  const s = sim.stats;
  console.log(
    `t=${m}min offshore=${s.offshoreWaveHeight.toFixed(2)}m area=${s.inundatedAreaHa.toFixed(1)}ha ` +
      `(below T.P.0: ${((zeroM * res * res) / 1e4).toFixed(1)}ha) bldgs=${s.inundatedBuildings} overtop=${s.overtoppingCount} ` +
      `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
  );
}

if (mapFile) {
  // aerial with maximum land inundation (yellow -> red, 0 -> 3 m) and wall cells (light blue)
  const img = jpeg.decode(fs.readFileSync(path.join(dir, 'aerial.jpg')), { useTArray: true });
  for (let i = 0; i < sim.N; i++) {
    const o = i * 4;
    const md = sim.maxDepth[i];
    if (!waterMask[i] && md >= 0.05) {
      const t = Math.min(1, md / 3);
      img.data[o] = 255; img.data[o + 1] = 230 * (1 - t); img.data[o + 2] = 0;
    } else if (walls.barrierActive[i] && !waterMask[i]) {
      img.data[o] = 120; img.data[o + 1] = 220; img.data[o + 2] = 255;
    }
  }
  fs.writeFileSync(mapFile, jpeg.encode({ data: img.data, width: nx, height: ny }, 85).data);
  console.log(`map: ${mapFile}`);
}
