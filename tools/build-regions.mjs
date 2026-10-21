import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { toPlane, toLonLat } from './lib/proj.mjs';
import { buildAerial } from './lib/aerial.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const japanTifPath = path.join(workspaceRoot, 'japan.tif');
const osakaTifPath = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'docs', 'osaka.tif');
const cacheDir = path.join(appRoot, '.cache', 'gsi');

const REGIONS = [
  {
    name: 'osaka_port',
    label: '大阪港・市街地ベイエリア（詳細シミュレーション）',
    label_en: 'Osaka Port & Bay Area (City Detail)',
    nx: 1600,
    ny: 1200,
    res: 10,
    widthM: 16000,
    heightM: 12000,
    originE: -60000,
    originN: -143000,
    center: { lat: 34.656, lon: 135.432 },
    aerialZoom: 15,
  },
];

async function createSampler(tifPath) {
  const tiff = await fromFile(tifPath);
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const tw = image.getWidth();
  const th = image.getHeight();
  const rasters = await image.readRasters({ interleave: true });
  const data = rasters;

  return (lon, lat) => {
    const fx = (lon - ox) / rx;
    const fy = (lat - oy) / ry;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= tw - 1 || y0 >= th - 1) return null;
    const wx = fx - x0;
    const wy = fy - y0;
    const v00 = data[y0 * tw + x0];
    const v10 = data[y0 * tw + (x0 + 1)];
    const v01 = data[(y0 + 1) * tw + x0];
    const v11 = data[(y0 + 1) * tw + (x0 + 1)];
    return (v00 * (1 - wx) + v10 * wx) * (1 - wy) + (v01 * (1 - wx) + v11 * wx) * wy;
  };
}

async function buildRegion(reg, sampleJapan, sampleOsaka) {
  console.log(`\n=== Building Region: ${reg.name} (${reg.label}) ===`);
  const outDir = path.join(appRoot, 'public', 'data', 'regions', reg.name);
  fs.mkdirSync(outDir, { recursive: true });

  const { nx, ny, res, originE, originN, widthM, heightM } = reg;
  const ground = new Float32Array(nx * ny);
  const waterMask = new Uint8Array(nx * ny);
  let minH = Infinity;
  let maxH = -Infinity;
  let seaCount = 0;
  let landCount = 0;

  for (let j = 0; j < ny; j++) {
    const n = originN - (j + 0.5) * res;
    for (let i = 0; i < nx; i++) {
      const e = originE + (i + 0.5) * res;
      const [lon, lat] = toLonLat(e, n);

      const hOsaka = sampleOsaka(lon, lat);
      const hJapan = sampleJapan(lon, lat);

      // Determine true elevation and land/water classification
      // Note: Osaka zero-meter zones (Konohana, Minato, Taisho, Nishiyodogawa) have true elevations of -1m to -4m
      let isWater = false;
      let h = 0.5;

      const isOuterSea = (lon < 135.435 && hJapan !== null && hJapan < -1.0) ||
                          (lon < 135.39 && hJapan !== null && hJapan < -0.1) ||
                          (hJapan !== null && hJapan < -3.5);

      if (isOuterSea) {
        // True sea in Osaka Bay or deep port navigation channel
        h = Math.min(-1.5, hJapan || -5.0);
        isWater = true;
        seaCount++;
      } else if (hOsaka !== null) {
        // We have local high-resolution DEM data
        if (hOsaka > 0.05) {
          // Positive dry land
          h = hOsaka;
          isWater = false;
          landCount++;
        } else {
          // hOsaka is <= 0: Could be river waterway or zero-meter urban land!
          // If japan.tif shows deep water (< -2.0) or estuary (< -1.5) without nearby land, it's river water
          const isRiverWater = (hJapan !== null && hJapan < -2.0) && (lon < 135.47);
          if (isRiverWater) {
            h = Math.min(-1.5, hJapan);
            isWater = true;
            seaCount++;
          } else {
            // True zero-meter urban zone protected by levees!
            // Preserve actual ground elevation from osaka.tif (e.g. -0.5m to -4.0m)
            h = Math.min(0.5, Math.max(-5.0, hOsaka));
            isWater = false;
            landCount++;
          }
        }
      } else {
        // Fallback
        if (hJapan !== null && hJapan < -0.5) {
          h = hJapan;
          isWater = true;
          seaCount++;
        } else {
          h = 0.5;
          isWater = false;
          landCount++;
        }
      }

      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      ground[j * nx + i] = h;
      waterMask[j * nx + i] = isWater ? 1 : 0;
    }
  }

  console.log(`  Grid: ${nx} x ${ny} @ ${res}m (${(widthM/1000).toFixed(1)}km x ${(heightM/1000).toFixed(1)}km)`);
  console.log(`  Elevation Range: ${minH.toFixed(2)}m to ${maxH.toFixed(2)}m (Land cells: ${landCount}, Sea cells: ${seaCount})`);

  // Save ground.f32
  const groundFile = path.join(outDir, 'ground.f32');
  fs.writeFileSync(groundFile, Buffer.from(ground.buffer));
  console.log(`  Saved ${groundFile} (${(ground.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  // Save water.u8 mask
  const waterFile = path.join(outDir, 'water.u8');
  fs.writeFileSync(waterFile, Buffer.from(waterMask.buffer));
  console.log(`  Saved ${waterFile} (${(waterMask.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  // Build aerial photo
  const aerialFile = path.join(outDir, 'aerial.jpg');
  console.log(`  Downloading and building aerial photo: ${aerialFile}...`);
  const aerialInfo = await buildAerial({
    outFile: aerialFile,
    cacheDir,
    originE,
    originN,
    widthM,
    heightM,
    zoom: reg.aerialZoom || 15,
    maxPx: 2048,
    metersPerPx: 10,
  });

  // Save meta.json
  const meta = {
    name: reg.name,
    label: reg.label,
    label_en: reg.label_en,
    nx,
    ny,
    res,
    crs: 'EPSG:6674',
    originE,
    originN,
    center: reg.center,
    widthM,
    heightM,
    groundMin: minH,
    groundMax: maxH,
    aerial: aerialInfo,
    built: new Date().toISOString(),
  };

  const metaFile = path.join(outDir, 'meta.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log(`  Saved ${metaFile}`);

  return meta;
}

async function main() {
  console.log('Loading TIFF samplers...');
  const sampleJapan = await createSampler(japanTifPath);
  const sampleOsaka = await createSampler(osakaTifPath);

  const regionMetas = [];
  for (const reg of REGIONS) {
    const meta = await buildRegion(reg, sampleJapan, sampleOsaka);
    regionMetas.push(meta);
  }

  const indexFile = path.join(appRoot, 'public', 'data', 'regions', 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(regionMetas, null, 2));
  console.log(`Saved ${indexFile}`);
}

main().catch(err => {
  console.error('Build error:', err);
  process.exit(1);
});
