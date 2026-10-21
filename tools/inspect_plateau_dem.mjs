import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');
const n60Root = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'osaka_viewer');

const pdMetaFile = path.join(n60Root, 'build', 'plateau-dem.json');
const pdBinFile = path.join(n60Root, 'build', 'plateau-dem.bin');

if (fs.existsSync(pdMetaFile) && fs.existsSync(pdBinFile)) {
  const pm = JSON.parse(fs.readFileSync(pdMetaFile, 'utf8'));
  const b = fs.readFileSync(pdBinFile);
  const pd = new Float32Array(b.buffer, b.byteOffset, b.length / 4);

  let negCount = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let validCount = 0;

  for (let i = 0; i < pd.length; i++) {
    const z = pd[i];
    if (!Number.isNaN(z)) {
      validCount++;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (z < 0) negCount++;
    }
  }

  console.log(`PLATEAU bare-earth DEM valid cells: ${validCount}`);
  console.log(`Elevation range: ${minZ.toFixed(2)}m to ${maxZ.toFixed(2)}m`);
  console.log(`Cells below 0m: ${negCount} (${(negCount / validCount * 100).toFixed(2)}%)`);
} else {
  console.log('plateau-dem files not found');
}
