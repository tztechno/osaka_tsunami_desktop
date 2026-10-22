/**
 * Builds the simulation region (ground.f32 / water.u8 / aerial.jpg / meta.json).
 *
 * Land / water classification comes from GSI DEM5A / DEM10B tiles: the sea AND the river channels
 * (Yodo, Aji, Kizu, Shirinashi, Dotonbori ...) are NoData there, so the 10 m grid gets an exact
 * coastline and river network. Land keeps its true elevation, including the zero-metre districts
 * (Nishiyodogawa, Konohana, Minato, Taisho ...) that lie below T.P. 0 m.
 * The seabed comes from japan.tif (15 arc-second bathymetry), tapered to `coastDepth` at the quay.
 *
 *   node tools/build-regions.mjs            # DEM + aerial (aerial tiles are cached)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { toLonLat } from './lib/proj.mjs';
import { buildDem } from './lib/dem.mjs';
import { loadBathymetry } from './lib/bathy.mjs';
import { buildAerial } from './lib/aerial.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const japanTifPath = path.join(workspaceRoot, 'DOCS', 'japan.tif');
const photoCacheDir = path.join(appRoot, '.cache', 'gsi');
const demCacheDir = path.join(appRoot, '.cache', 'gsi-dem');

const REGIONS = [
  {
    name: 'osaka_port',
    // all of Osaka City (e-Stat ward extents E -59986..-36770, N -156771..-136397) with a few hundred metres to
    // spare; the west edge stays on Osaka Bay, where the nankai_trough boundary CSVs are sampled
    label: '大阪市全域（詳細シミュレーション）',
    label_en: 'All of Osaka City (City Detail)',
    nx: 1600,
    ny: 1440,
    res: 15,
    widthM: 24000,
    heightM: 21600,
    originE: -60000,
    originN: -136000,
    center: { lat: 34.676, lon: 135.476 },
    aerialZoom: 15,
    coastDepth: -3, // quay walls / dredged river channels
  },
];

/** Water cells 4-connected to the open bay (west / south edges). Unconnected NoData pools are ponds. */
function oceanConnected(isSea, nx, ny) {
  const conn = new Uint8Array(nx * ny);
  const stack = [];
  const seed = (k) => {
    if (isSea[k] && !conn[k]) {
      conn[k] = 1;
      stack.push(k);
    }
  };
  for (let j = 0; j < ny; j++) seed(j * nx);
  for (let i = 0; i < nx; i++) seed((ny - 1) * nx + i);
  while (stack.length) {
    const k = stack.pop();
    const i = k % nx;
    if (i > 0) seed(k - 1);
    if (i < nx - 1) seed(k + 1);
    if (k >= nx) seed(k - nx);
    if (k < (ny - 1) * nx) seed(k + nx);
  }
  return conn;
}

/** Ponds (isolated NoData) become land at the mean height of the surrounding land. */
function fillPonds(dem, isKnown, nx, ny) {
  let todo = 0;
  for (let k = 0; k < isKnown.length; k++) if (!isKnown[k]) todo++;
  const known = isKnown.slice();
  while (todo > 0) {
    const next = known.slice();
    let changed = 0;
    for (let k = 0; k < known.length; k++) {
      if (known[k]) continue;
      const i = k % nx;
      let s = 0, n = 0;
      if (i > 0 && known[k - 1]) { s += dem[k - 1]; n++; }
      if (i < nx - 1 && known[k + 1]) { s += dem[k + 1]; n++; }
      if (k >= nx && known[k - nx]) { s += dem[k - nx]; n++; }
      if (k < (ny - 1) * nx && known[k + nx]) { s += dem[k + nx]; n++; }
      if (n) { dem[k] = s / n; next[k] = 1; changed++; }
    }
    known.set(next);
    todo -= changed;
    if (!changed) break;
  }
}

/** Paint water cells of the aerial a uniform dark sea tone (GSI sea tiles mix sources and dates). */
function paintWater(aerialFile, aerialInfo, water, nx, ny) {
  const img = jpeg.decode(fs.readFileSync(aerialFile), { useTArray: true, formatAsRGBA: true });
  const { width: W, height: H } = aerialInfo;
  for (let y = 0; y < H; y++) {
    const j = Math.min(ny - 1, Math.floor((y / H) * ny));
    for (let x = 0; x < W; x++) {
      const i = Math.min(nx - 1, Math.floor((x / W) * nx));
      if (!water[j * nx + i]) continue;
      const o = (y * W + x) * 4;
      img.data[o] = 18; img.data[o + 1] = 44; img.data[o + 2] = 62;
    }
  }
  fs.writeFileSync(aerialFile, jpeg.encode({ data: img.data, width: W, height: H }, 85).data);
}

async function buildRegion(reg) {
  console.log(`\n=== Building Region: ${reg.name} (${reg.label}) ===`);
  const outDir = path.join(appRoot, 'public', 'data', 'regions', reg.name);
  fs.mkdirSync(outDir, { recursive: true });

  const { nx, ny, res, originE, originN, widthM, heightM } = reg;
  const corners = [
    toLonLat(originE, originN),
    toLonLat(originE + widthM, originN),
    toLonLat(originE, originN - heightM),
    toLonLat(originE + widthM, originN - heightM),
  ];
  const bathy = await loadBathymetry(japanTifPath, {
    lonMin: Math.min(...corners.map((c) => c[0])),
    lonMax: Math.max(...corners.map((c) => c[0])),
    latMin: Math.min(...corners.map((c) => c[1])),
    latMax: Math.max(...corners.map((c) => c[1])),
  });
  console.log(`  Bathymetry: japan.tif window ${bathy.window.join(',')} (${bathy.seaPixels} sea pixels)`);

  const { dem, isSea } = await buildDem({
    cacheDir: demCacheDir, originE, originN, nx, ny, res, zoom: 15, bathy, coastDepth: reg.coastDepth,
  });

  const water = oceanConnected(isSea, nx, ny);
  // pond cells still hold bathymetry; rebuild them from the land around
  const known = isSea.map((s, k) => (s && !water[k] ? 0 : 1));
  const ponds = known.length - known.reduce((n, v) => n + v, 0);
  fillPonds(dem, known, nx, ny);

  let minH = Infinity, maxH = -Infinity, nWater = 0, nBelow = 0;
  for (let k = 0; k < dem.length; k++) {
    if (dem[k] < minH) minH = dem[k];
    if (dem[k] > maxH) maxH = dem[k];
    if (water[k]) nWater++;
    else if (dem[k] < 0) nBelow++;
  }
  console.log(`  Grid: ${nx} x ${ny} @ ${res}m, elevation ${minH.toFixed(2)}m .. ${maxH.toFixed(2)}m`);
  console.log(`  water ${nWater} cells, land below T.P.0 ${nBelow} cells, ponds filled ${ponds} cells`);

  fs.writeFileSync(path.join(outDir, 'ground.f32'), Buffer.from(dem.buffer));
  fs.writeFileSync(path.join(outDir, 'water.u8'), Buffer.from(water.buffer));

  const aerialFile = path.join(outDir, 'aerial.jpg');
  const aerialInfo = await buildAerial({
    outFile: aerialFile,
    cacheDir: photoCacheDir,
    originE,
    originN,
    widthM,
    heightM,
    zoom: reg.aerialZoom || 15,
    maxPx: 2560,
    metersPerPx: 10,
  });
  paintWater(aerialFile, aerialInfo, water, nx, ny);

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
    demSource: 'GSI DEM5A/DEM10B (land, NoData = sea & rivers) + japan.tif 15 arc-second bathymetry',
    built: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

async function main() {
  const metas = [];
  for (const reg of REGIONS) metas.push(await buildRegion(reg));
  const indexFile = path.join(appRoot, 'public', 'data', 'regions', 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify(metas, null, 2));
  console.log(`Saved ${indexFile}`);
}

main().catch((err) => {
  console.error('Build error:', err);
  process.exit(1);
});
