/**
 * 15 arc-second bathymetry of the tsunami's route into Osaka (Kii Channel, Osaka Bay, Harima-nada and the shelf
 * off southern Kii and Shikoku) for the nested grid of the in-app nankai_trough run (src/nankai/routeGrid.js).
 * Same processing as N73's scripts/process_bathymetry.mjs at factor 1: japan.tif pixels as they are, nodata = land (0).
 *
 *   node tools/build-nankai-route.mjs   -> public/data/nankai/bathymetry_osaka_route.bin / _meta.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIF = path.resolve(appRoot, '..', 'DOCS', 'japan.tif');
const BOX = { lonMin: 134.0, lonMax: 136.0, latMin: 33.0, latMax: 34.75 };
const OUT = path.join(appRoot, 'public', 'data', 'nankai', 'bathymetry_osaka_route');

const image = await (await fromFile(TIF)).getImage();
const [tMinX, tMinY, tMaxX, tMaxY] = image.getBoundingBox();
const dx = (tMaxX - tMinX) / image.getWidth();
const dy = (tMaxY - tMinY) / image.getHeight();
const noData = image.getGDALNoData();
const win = [
  Math.max(0, Math.round((BOX.lonMin - tMinX) / dx)),
  Math.max(0, Math.round((tMaxY - BOX.latMax) / dy)),
  Math.min(image.getWidth(), Math.round((BOX.lonMax - tMinX) / dx)),
  Math.min(image.getHeight(), Math.round((tMaxY - BOX.latMin) / dy)),
];
const [raw] = await image.readRasters({ window: win });
const W = win[2] - win[0], H = win[3] - win[1];
const out = Int16Array.from(raw, (v) => (noData !== null && v === Number(noData) ? 0 : v));

const bounds = { lonMin: tMinX + win[0] * dx, lonMax: tMinX + win[2] * dx, latMin: tMaxY - win[3] * dy, latMax: tMaxY - win[1] * dy };
const midLat = (bounds.latMin + bounds.latMax) / 2;
const meta = {
  width: W, height: H, factor: 1, bounds, dxDeg: dx, dyDeg: dy,
  dxMeters: dx * 111000 * Math.cos((midLat * Math.PI) / 180),
  dyMeters: dy * 111000,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(`${OUT}_meta.json`, JSON.stringify(meta, null, 2));
fs.writeFileSync(`${OUT}.bin`, Buffer.from(out.buffer));
console.log(`${W} x ${H} cells, ${JSON.stringify(bounds)} -> ${path.relative(appRoot, OUT)}.bin`);
