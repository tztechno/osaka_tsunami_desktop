import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { toPlane, toLonLat } from './lib/proj.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const japanTifPath = path.join(workspaceRoot, 'japan.tif');
const osakaTifPath = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'docs', 'osaka.tif');
const bldgIndexFile = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'osaka_viewer', 'build', 'bldg-index.bin');

async function testLandSea() {
  const oTiff = await fromFile(osakaTifPath);
  const oImg = await oTiff.getImage();
  const [oOx, oOy] = oImg.getOrigin();
  const [oRx, oRy] = oImg.getResolution();
  const ow = oImg.getWidth(), oh = oImg.getHeight();
  const oRasters = await oImg.readRasters({ interleave: true });

  const jTiff = await fromFile(japanTifPath);
  const jImg = await jTiff.getImage();
  const [jOx, jOy] = jImg.getOrigin();
  const [jRx, jRy] = jImg.getResolution();
  const jw = jImg.getWidth(), jh = jImg.getHeight();
  const jRasters = await jImg.readRasters({ interleave: true });

  // Test locations in Osaka:
  // 1: Osaka Bay deep sea (135.35, 34.65)
  // 2: Yumeshima west shore (135.385, 34.650)
  // 3: Tempozan Port (135.432, 34.656)
  // 4: Bentencho (Minato Ward zero-meter area: 135.460, 34.670)
  // 5: Taisho Ward low area (135.480, 34.650)
  // 6: Umeda (135.498, 34.702)
  // 7: Namba (135.501, 34.666)
  const pts = [
    { name: 'Osaka Bay Sea', lon: 135.35, lat: 34.65 },
    { name: 'Yumeshima Island', lon: 135.395, lat: 34.650 },
    { name: 'Tempozan Port', lon: 135.432, lat: 34.656 },
    { name: 'Minato Ward (Bentencho)', lon: 135.460, lat: 34.670 },
    { name: 'Taisho Ward (Low-lying)', lon: 135.480, lat: 34.650 },
    { name: 'Umeda', lon: 135.498, lat: 34.702 },
    { name: 'Namba', lon: 135.501, lat: 34.666 },
  ];

  for (const pt of pts) {
    const ox = Math.floor((pt.lon - oOx) / oRx);
    const oy = Math.floor((pt.lat - oOy) / oRy);
    const oVal = oRasters[oy * ow + ox];

    const jx = Math.floor((pt.lon - jOx) / jRx);
    const jy = Math.floor((pt.lat - jOy) / jRy);
    const jVal = jRasters[jy * jw + jx];

    console.log(`${pt.name}: osaka.tif=${oVal}m, japan.tif=${jVal}m`);
  }
}

testLandSea();
