import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const japanTifPath = path.join(workspaceRoot, 'japan.tif');
const osakaTifPath = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'docs', 'osaka.tif');

async function testPoints() {
  const jTiff = await fromFile(japanTifPath);
  const jImg = await jTiff.getImage();
  const jBbox = jImg.getBoundingBox();
  const [jOx, jOy] = jImg.getOrigin();
  const [jRx, jRy] = jImg.getResolution();
  const jw = jImg.getWidth(), jh = jImg.getHeight();

  const oTiff = await fromFile(osakaTifPath);
  const oImg = await oTiff.getImage();
  const oBbox = oImg.getBoundingBox();
  const [oOx, oOy] = oImg.getOrigin();
  const [oRx, oRy] = oImg.getResolution();
  const ow = oImg.getWidth(), oh = oImg.getHeight();

  // Test points:
  // 1: Osaka Bay Center (lon 135.30, lat 34.60)
  // 2: Osaka Port / Tempozan (lon 135.43, lat 34.65)
  // 3: Osaka Station / Umeda (lon 135.498, lat 34.702)
  // 4: Yodo River Mouth (lon 135.41, lat 34.68)
  // 5: Kitan Strait / Tomogashima (lon 135.00, lat 34.28)
  const pts = [
    { name: 'Osaka Bay Center', lon: 135.30, lat: 34.60 },
    { name: 'Osaka Port Tempozan', lon: 135.43, lat: 34.65 },
    { name: 'Osaka Station Umeda', lon: 135.498, lat: 34.702 },
    { name: 'Yodo River Mouth', lon: 135.41, lat: 34.68 },
    { name: 'Kitan Strait Tomogashima', lon: 135.00, lat: 34.28 },
  ];

  for (const pt of pts) {
    // Read from japan.tif
    const jx = Math.floor((pt.lon - jOx) / jRx);
    const jy = Math.floor((pt.lat - jOy) / jRy);
    let jVal = null;
    if (jx >= 0 && jx < jw && jy >= 0 && jy < jh) {
      const r = await jImg.readRasters({ window: [jx, jy, jx + 1, jy + 1] });
      jVal = r[0][0];
    }

    // Read from osaka.tif
    const ox = Math.floor((pt.lon - oOx) / oRx);
    const oy = Math.floor((pt.lat - oOy) / oRy);
    let oVal = null;
    if (ox >= 0 && ox < ow && oy >= 0 && oy < oh) {
      const r = await oImg.readRasters({ window: [ox, oy, ox + 1, oy + 1] });
      oVal = r[0][0];
    }

    console.log(`${pt.name} (${pt.lon}, ${pt.lat}): japan.tif=${jVal}m, osaka.tif=${oVal}m`);
  }
}

testPoints();
