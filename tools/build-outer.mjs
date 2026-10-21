/**
 * Builds the surrounding-terrain backdrop (public/data/regions/outer): Osaka plain, Rokko, Ikoma,
 * Kongo and the Osaka Bay coast around the simulation region, as a static textured mesh.
 *
 * Land elevation: osaka.tif (1 arc-second DEM, N60_osaka_viewer/docs/osaka.tif).
 * Sea mask: GSI dem_png NoData (osaka.tif cannot tell the sea from zero-metre land); seabed from japan.tif.
 * Aerial: GSI seamlessphoto, sea painted a uniform tone.
 *
 *   node tools/build-outer.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import jpeg from 'jpeg-js';
import { toPlane, toLonLat } from './lib/proj.mjs';
import { buildDem } from './lib/dem.mjs';
import { loadBathymetry } from './lib/bathy.mjs';
import { buildAerial } from './lib/aerial.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(appRoot, '..');
const osakaTifPath = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'docs', 'osaka.tif');
const japanTifPath = path.join(workspaceRoot, 'DOCS', 'japan.tif');
const outDir = path.join(appRoot, 'public', 'data', 'regions', 'outer');

const RES = 100; // multiple of the inner grid, so the inner region's edges fall on outer grid lines
const BOUNDS = { lonMin: 135.1, lonMax: 135.78, latMin: 34.4, latMax: 34.9 };

async function osakaSampler() {
  const image = await (await fromFile(osakaTifPath)).getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const tw = image.getWidth(), th = image.getHeight();
  const nodata = Number(image.getGDALNoData());
  const [raster] = await image.readRasters();
  const v = (x, y) => {
    const h = raster[y * tw + x];
    return h === nodata ? NaN : h;
  };
  return (lon, lat) => {
    const fx = (lon - ox) / rx - 0.5, fy = (lat - oy) / ry - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= tw - 1 || y0 >= th - 1) return NaN;
    const wx = fx - x0, wy = fy - y0;
    return (v(x0, y0) * (1 - wx) + v(x0 + 1, y0) * wx) * (1 - wy) + (v(x0, y0 + 1) * (1 - wx) + v(x0 + 1, y0 + 1) * wx) * wy;
  };
}

/**
 * The z13 backdrop photo is brighter than the region's z15 photo (different GSI sources).
 * Fit a per-channel gain / offset (mean & std) of the backdrop to the region photo over the
 * region's land, so the seam between the two meshes does not show.
 */
function matchTone(img, aerial, outer) {
  const regionDir = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port');
  const rMeta = JSON.parse(fs.readFileSync(path.join(regionDir, 'meta.json'), 'utf8'));
  const rImg = jpeg.decode(fs.readFileSync(path.join(regionDir, 'aerial.jpg')), { useTArray: true, formatAsRGBA: true });
  const rWater = new Uint8Array(fs.readFileSync(path.join(regionDir, 'water.u8')));
  const stats = () => ({ s: [0, 0, 0], q: [0, 0, 0], n: 0 });
  const a = stats(), b = stats();
  for (let y = 0; y < rImg.height; y += 2) {
    for (let x = 0; x < rImg.width; x += 2) {
      const i = Math.floor((x / rImg.width) * rMeta.nx), j = Math.floor((y / rImg.height) * rMeta.ny);
      if (rWater[j * rMeta.nx + i]) continue;
      const e = rMeta.originE + (x / rImg.width) * rMeta.widthM;
      const n = rMeta.originN - (y / rImg.height) * rMeta.heightM;
      const ox = Math.floor(((e - outer.originE) / outer.widthM) * aerial.width);
      const oy = Math.floor(((outer.originN - n) / outer.heightM) * aerial.height);
      const ro = (y * rImg.width + x) * 4, oo = (oy * aerial.width + ox) * 4;
      for (let c = 0; c < 3; c++) {
        a.s[c] += img.data[oo + c]; a.q[c] += img.data[oo + c] ** 2;
        b.s[c] += rImg.data[ro + c]; b.q[c] += rImg.data[ro + c] ** 2;
      }
      a.n++; b.n++;
    }
  }
  const gain = [], off = [];
  for (let c = 0; c < 3; c++) {
    const ma = a.s[c] / a.n, mb = b.s[c] / b.n;
    const sa = Math.sqrt(a.q[c] / a.n - ma * ma), sb = Math.sqrt(b.q[c] / b.n - mb * mb);
    gain[c] = sb / sa;
    off[c] = mb - ma * gain[c];
  }
  console.log(`Tone match: gain ${gain.map((v) => v.toFixed(2))} offset ${off.map((v) => v.toFixed(1))}`);
  for (let o = 0; o < img.data.length; o += 4) {
    for (let c = 0; c < 3; c++) img.data[o + c] = Math.max(0, Math.min(255, img.data[o + c] * gain[c] + off[c]));
  }
}

async function main() {
  const pts = [
    toPlane(BOUNDS.lonMin, BOUNDS.latMin), toPlane(BOUNDS.lonMax, BOUNDS.latMin),
    toPlane(BOUNDS.lonMin, BOUNDS.latMax), toPlane(BOUNDS.lonMax, BOUNDS.latMax),
  ];
  const originE = Math.floor(Math.min(...pts.map((p) => p[0])) / RES) * RES;
  const originN = Math.ceil(Math.max(...pts.map((p) => p[1])) / RES) * RES;
  const widthM = Math.ceil((Math.max(...pts.map((p) => p[0])) - originE) / RES) * RES;
  const heightM = Math.ceil((originN - Math.min(...pts.map((p) => p[1]))) / RES) * RES;
  const nx = widthM / RES, ny = heightM / RES;
  console.log(`Outer grid ${nx} x ${ny} @ ${RES}m (${widthM / 1000} x ${heightM / 1000} km), origin E${originE} N${originN}`);

  const bathy = await loadBathymetry(japanTifPath, BOUNDS);
  // GSI dem_png at z13 (DEM10B) for the sea mask; dem5a is z15 only and falls through
  const { dem, isSea } = await buildDem({
    cacheDir: path.join(appRoot, '.cache', 'gsi-dem13'), originE, originN, nx, ny, res: RES, zoom: 13, bathy, coastDepth: -3, coastTaperM: 800,
  });

  const sampleOsaka = await osakaSampler();
  const ground = new Float32Array(nx * ny);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let h = dem[k];
      if (!isSea[k]) {
        const [lon, lat] = toLonLat(originE + (i + 0.5) * RES, originN - (j + 0.5) * RES);
        const ho = sampleOsaka(lon, lat);
        if (!Number.isNaN(ho)) h = ho;
      }
      ground[k] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  console.log(`Elevation ${minH.toFixed(1)} .. ${maxH.toFixed(1)} m`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ground.f32'), Buffer.from(ground.buffer));
  fs.writeFileSync(path.join(outDir, 'sea.u8'), Buffer.from(isSea.buffer));

  const aerialFile = path.join(outDir, 'aerial.jpg');
  const aerial = await buildAerial({
    outFile: aerialFile, cacheDir: path.join(appRoot, '.cache', 'gsi'), originE, originN, widthM, heightM, zoom: 13, maxPx: 3072, metersPerPx: 20,
  });
  const img = jpeg.decode(fs.readFileSync(aerialFile), { useTArray: true, formatAsRGBA: true });
  matchTone(img, aerial, { originE, originN, widthM, heightM });
  for (let y = 0; y < aerial.height; y++) {
    const j = Math.min(ny - 1, Math.floor((y / aerial.height) * ny));
    for (let x = 0; x < aerial.width; x++) {
      const i = Math.min(nx - 1, Math.floor((x / aerial.width) * nx));
      if (!isSea[j * nx + i]) continue;
      const o = (y * aerial.width + x) * 4;
      img.data[o] = 18; img.data[o + 1] = 44; img.data[o + 2] = 62;
    }
  }
  fs.writeFileSync(aerialFile, jpeg.encode({ data: img.data, width: aerial.width, height: aerial.height }, 85).data);

  const meta = {
    name: 'outer',
    label: '大阪平野・六甲・生駒 広域背景 (osaka.tif)',
    label_en: 'Osaka Plain, Rokko & Ikoma Backdrop (osaka.tif)',
    nx, ny, res: RES, widthM, heightM, crs: 'EPSG:6674', originE, originN,
    groundMin: minH, groundMax: maxH, aerial,
    demSource: 'osaka.tif (1 arc-second DEM, land) + GSI dem_png sea mask + japan.tif bathymetry',
    built: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`Done: aerial ${aerial.width}x${aerial.height}px`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
