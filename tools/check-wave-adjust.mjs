/**
 * Check the CSV shoaling correction, multiplier and source width of the wave input (no browser).
 *   node tools/check-wave-adjust.mjs [minutes]
 * Prints the depth at the CSV point, the input zone's depth and factor, and (minutes > 0) the
 * flooded area for a few source widths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsunamiSimulator } from '../src/tsunamiSim.js';
import { WaveProfile } from '../src/waveProfile.js';
import { SeawallManager } from '../src/seawall.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port');
const minutes = Number(process.argv[2] || 0);
// serve the bathymetry grid to bathyLookup's fetch from disk
globalThis.fetch = async (u) => {
  const p = path.join(appRoot, 'public', u);
  return { json: async () => JSON.parse(fs.readFileSync(p, 'utf8')), arrayBuffer: async () => fs.readFileSync(p).buffer.slice(0) };
};
const { seaDepthAt } = await import('../src/bathyLookup.js');

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const ground = new Float32Array(fs.readFileSync(path.join(dir, 'ground.f32')).buffer.slice(0));
const waterMask = new Uint8Array(fs.readFileSync(path.join(dir, 'water.u8')));
const walls = new SeawallManager(meta);
walls.ground = ground;
walls.waterMask = waterMask;
walls.seawallData = JSON.parse(fs.readFileSync(path.join(dir, 'seawalls.json'), 'utf8'));
walls.classifyShore();
walls.setPreset('sluice_closed');

const csv = fs.readFileSync(path.join(appRoot, 'public', 'data', 'wave_sources', 'nankai_trough_osaka_trimmed.csv'), 'utf8');
const prof = WaveProfile.parse(csv, 'nankai_trough_osaka_trimmed.csv');
prof.sourceDepth = await seaDepthAt(prof.lon, prof.lat);
console.log(`CSV point ${prof.lon}, ${prof.lat}: depth ${prof.sourceDepth?.toFixed(1)} m`);
// the marker sits at the CSV point (region-local metres), as in the app
const [e, n] = (await import('../src/proj.js')).toPlane(prof.lon, prof.lat);
const center = { x: e - meta.originE, z: meta.originN - n };

for (const [w, k] of [[100000, 1], [100000, 1.5], [5000, 1], [2000, 1]]) {
  const sim = new TsunamiSimulator({ meta, ground, waterMask, seawallManager: walls, buildings: [] });
  sim.setWaveProfile(WaveProfile.deserialize(prof.serialize()));
  sim.setWaveAdjust({ profileScale: k, sourceWidthM: w, sourceCenter: center });
  const t = prof.peakTimeSec;
  const used = Array.from(sim.bcInput).filter((x) => x > 0).length;
  let line = `width ${w / 1000} km ×${k}: input cells ${used}/${sim.bcCells.length}, zone depth ${sim.bcDepth.toFixed(1)} m, shoaling ×${sim.shoalFactor.toFixed(3)}, ` +
    `boundary peak ${sim.getOffshoreWaveEta(t).toFixed(3)} (CSV ${prof.getEta(t).toFixed(3)})`;
  if (minutes > 0) {
    sim.advance(minutes * 60);
    sim.updateStats();
    let nan = 0;
    for (let i = 0; i < sim.N; i++) if (!Number.isFinite(sim.eta[i])) nan++;
    line += ` | ${minutes} min: flooded ${sim.stats.inundatedAreaHa.toFixed(1)} ha, nan=${nan}`;
  }
  console.log(line);
}
