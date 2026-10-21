import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const metaFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'meta.json');
const groundFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'ground.f32');

const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const { nx, ny, res } = meta;
const buf = fs.readFileSync(groundFile);
const ground = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

// Test key points:
// Tempozan: x=7937, z=5951
// Umeda: x=14012, z=880
// Namba: x=14267, z=4875
// Yumeshima: x=4542, z=6596
// Sea: x=1000, z=6000
const pts = [
  { name: 'Sea (Osaka Bay)', x: 1000, z: 6000 },
  { name: 'Yumeshima (Expo)', x: 4542, z: 6596 },
  { name: 'Tempozan', x: 7937, z: 5951 },
  { name: 'Umeda', x: 14012, z: 880 },
  { name: 'Namba', x: 14267, z: 4875 },
];

for (const p of pts) {
  const gx = Math.floor(p.x / res);
  const gy = Math.floor(p.z / res);
  const idx = gy * nx + gx;
  console.log(`${p.name}: ground=${ground[idx]}m`);
}

// Count cells with negative elevation in eastern half (x > 8000m, which should be pure land!)
let negEastLand = 0;
let totalEast = 0;
for (let j = 0; j < ny; j++) {
  for (let i = Math.floor(nx / 2); i < nx; i++) {
    totalEast++;
    if (ground[j * nx + i] < 0) {
      negEastLand++;
    }
  }
}
console.log(`Eastern half (land area): ${negEastLand} / ${totalEast} cells (${(negEastLand / totalEast * 100).toFixed(1)}%) have negative elevation!`);
