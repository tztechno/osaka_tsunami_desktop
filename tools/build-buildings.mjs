import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const bldgIndexFile = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'osaka_viewer', 'build', 'bldg-index.bin');
const metaFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'meta.json');
const outFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'buildings.json');

async function main() {
  if (!fs.existsSync(bldgIndexFile)) {
    console.error('bldg-index.bin not found at', bldgIndexFile);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const { originE, originN, widthM, heightM } = meta;

  console.log(`Reading bldg-index.bin from ${bldgIndexFile}...`);
  const buf = fs.readFileSync(bldgIndexFile);
  const f64 = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const totalBldgs = f64.length / 4;
  console.log(`Total buildings in index: ${totalBldgs}`);

  const buildings = [];
  let inRegionCount = 0;

  for (let i = 0; i < totalBldgs; i++) {
    const lat = f64[i * 4];
    const lon = f64[i * 4 + 1];
    const zb = f64[i * 4 + 2];
    const zt = f64[i * 4 + 3];
    const h = Math.max(3.0, zt - zb);

    const [e, n] = toPlane(lon, lat);
    const x = e - originE;
    const z = originN - n;

    if (x >= 0 && x <= widthM && z >= 0 && z <= heightM) {
      inRegionCount++;
      // Approximate footprint size based on height / typical urban size
      // Larger buildings (taller) usually have wider footprints
      let w = 12.0;
      let d = 12.0;
      if (h > 50) {
        w = 40.0;
        d = 40.0;
      } else if (h > 20) {
        w = 25.0;
        d = 25.0;
      } else if (h > 10) {
        w = 16.0;
        d = 16.0;
      } else {
        w = 9.0;
        d = 9.0;
      }

      buildings.push({
        x: +x.toFixed(1),
        z: +z.toFixed(1),
        w: +w.toFixed(1),
        d: +d.toFixed(1),
        h: +h.toFixed(1),
        zb: +zb.toFixed(1),
      });
    }
  }

  console.log(`Buildings within osaka_port region: ${inRegionCount}`);

  // To keep Three.js InstancedMesh rendering performant and silky smooth (60fps),
  // if there are too many (e.g. > 40,000), prioritize taller buildings or sample appropriately
  let finalBuildings = buildings;
  const MAX_BUILDINGS = 35000;
  if (buildings.length > MAX_BUILDINGS) {
    // Sort so tallest buildings are always kept, then sample remaining
    buildings.sort((a, b) => b.h - a.h);
    const tall = buildings.slice(0, 15000);
    const rest = buildings.slice(15000);
    const step = Math.ceil(rest.length / (MAX_BUILDINGS - 15000));
    const sampledRest = rest.filter((_, idx) => idx % step === 0);
    finalBuildings = tall.concat(sampledRest);
    console.log(`Sampled to ${finalBuildings.length} buildings for 60fps rendering performance.`);
  }

  fs.writeFileSync(outFile, JSON.stringify(finalBuildings));
  console.log(`Saved ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
