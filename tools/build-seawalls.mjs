/**
 * Builds seawalls.json: the three major arch sluice gates (三大水門) of Osaka.
 *
 * Each gate is given by an approximate centre (grid cell) on its river; the gate line is fitted
 * across the channel of water.u8 (shortest crossing through the centre) and extended into both banks.
 * Coastal seawalls and river parapets are not listed here: SeawallManager derives them at runtime
 * from water.u8 along the real coastline / river banks (outside vs inside of the gates).
 *
 *   node tools/build-seawalls.mjs [--check out.jpg]   # --check renders gates + inner river network
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { toLonLat } from './lib/proj.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const regionDir = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port');

const GATES = [
  {
    id: 'ajigawa_gate',
    name: '安治川水門 (三大水門)',
    name_en: 'Ajigawa Sluice Gate',
    designHeight: 7.4,
    cell: [975, 385],
    description: '安治川の津波遡上を防ぐアーチ型水門（T.P. +7.4m）。市街地（梅田・野田・中之島）を守る要。',
    description_en: 'Arch-shaped floodgate (T.P. +7.4m) protecting downtown Osaka (Umeda, Nakanoshima) from tsunami surges up Ajigawa.',
  },
  {
    id: 'shirinashi_gate',
    name: '尻無川水門 (三大水門)',
    name_en: 'Shirinashigawa Sluice Gate',
    designHeight: 6.7,
    cell: [1100, 555],
    description: '尻無川河口の防潮水門（T.P. +6.7m）。大正区・港区のゼロメートル市街地を防護。',
    description_en: 'Floodgate (T.P. +6.7m) protecting low-lying coastal urban areas in Taisho and Minato wards.',
  },
  {
    id: 'kizugawa_gate',
    name: '木津川水門 (三大水門)',
    name_en: 'Kizugawa Sluice Gate',
    designHeight: 7.2,
    cell: [1220, 715],
    description: '木津川の防潮水門（T.P. +7.2m）。難波・道頓堀・ミナミ繁華街への津波流入を阻止。',
    description_en: 'Floodgate (T.P. +7.2m) preventing tsunami surge from penetrating into Namba and Dotonbori.',
  },
];

const BANK_CELLS = 3; // gate line reaches this far into each bank

function fitGate(water, nx, ny, [ci, cj]) {
  const isWater = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y);
    return i >= 0 && j >= 0 && i < nx && j < ny && water[j * nx + i] === 1;
  };
  // snap to the nearest water cell
  let c = null;
  for (let r = 0; r <= 15 && !c; r++) {
    for (let dj = -r; dj <= r && !c; dj++) {
      for (let di = -r; di <= r && !c; di++) {
        if (isWater(ci + di + 0.5, cj + dj + 0.5)) c = [ci + di + 0.5, cj + dj + 0.5];
      }
    }
  }
  if (!c) throw new Error(`no water near cell ${ci},${cj}`);
  const reach = (dx, dy) => {
    let s = 0;
    while (s < 200 && isWater(c[0] + dx * s, c[1] + dy * s)) s += 0.25;
    return s;
  };
  let best = null;
  for (let deg = 0; deg < 180; deg += 2) {
    const a = (deg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
    const s0 = reach(-dx, -dy), s1 = reach(dx, dy);
    if (!best || s0 + s1 < best.len) best = { len: s0 + s1, dx, dy, s0, s1 };
  }
  const { dx, dy, s0, s1 } = best;
  return {
    p0: [c[0] - dx * (s0 + BANK_CELLS), c[1] - dy * (s0 + BANK_CELLS)],
    p1: [c[0] + dx * (s1 + BANK_CELLS), c[1] + dy * (s1 + BANK_CELLS)],
    widthM: best.len * 10,
  };
}

/** Same rasterisation as SeawallManager: cells within halfW of the segment. */
function rasterise(mask, nx, ny, res, p0, p1, halfW) {
  const x0 = p0[0] / res, y0 = p0[1] / res, x1 = p1[0] / res, y1 = p1[1] / res;
  const sdx = x1 - x0, sdy = y1 - y0, l2 = sdx * sdx + sdy * sdy || 1;
  const pad = halfW / res;
  for (let gy = Math.max(0, Math.floor(Math.min(y0, y1) - pad)); gy <= Math.min(ny - 1, Math.ceil(Math.max(y0, y1) + pad)); gy++) {
    for (let gx = Math.max(0, Math.floor(Math.min(x0, x1) - pad)); gx <= Math.min(nx - 1, Math.ceil(Math.max(x0, x1) + pad)); gx++) {
      const t = Math.max(0, Math.min(1, ((gx + 0.5 - x0) * sdx + (gy + 0.5 - y0) * sdy) / l2));
      if (Math.hypot(gx + 0.5 - (x0 + t * sdx), gy + 0.5 - (y0 + t * sdy)) * res <= halfW) mask[gy * nx + gx] = 1;
    }
  }
}

function main() {
  const meta = JSON.parse(fs.readFileSync(path.join(regionDir, 'meta.json'), 'utf8'));
  const { nx, ny, res, originE, originN } = meta;
  const water = new Uint8Array(fs.readFileSync(path.join(regionDir, 'water.u8')));

  const seawalls = GATES.map((g) => {
    const { p0, p1, widthM } = fitGate(water, nx, ny, g.cell);
    const mid = [((p0[0] + p1[0]) / 2) * res, ((p0[1] + p1[1]) / 2) * res];
    const [lon, lat] = toLonLat(originE + mid[0], originN - mid[1]);
    console.log(`${g.id}: river width ${widthM.toFixed(0)} m at ${lon.toFixed(5)}, ${lat.toFixed(5)}`);
    return {
      id: g.id,
      name: g.name,
      name_en: g.name_en,
      type: 'sluice_gate',
      designHeight: g.designHeight,
      widthM: 20,
      lon: +lon.toFixed(5),
      lat: +lat.toFixed(5),
      points: [p0, p1].map(([x, y]) => [+(x * res).toFixed(1), +(y * res).toFixed(1)]),
      description: g.description,
      description_en: g.description_en,
    };
  });

  // Connectivity check: water reachable from the bay with all gates closed
  const gate = new Uint8Array(nx * ny);
  for (const sw of seawalls) rasterise(gate, nx, ny, res, sw.points[0], sw.points[1], sw.widthM / 2 + res * 0.7);
  const outer = new Uint8Array(nx * ny);
  const stack = [];
  const seed = (k) => {
    if (water[k] && !gate[k] && !outer[k]) { outer[k] = 1; stack.push(k); }
  };
  for (let j = 0; j < ny; j++) seed(j * nx);
  for (let i = 0; i < nx; i++) seed((ny - 1) * nx + i);
  while (stack.length) {
    const k = stack.pop(), i = k % nx;
    if (i > 0) seed(k - 1);
    if (i < nx - 1) seed(k + 1);
    if (k >= nx) seed(k - nx);
    if (k < (ny - 1) * nx) seed(k + nx);
  }
  let inner = 0;
  for (let k = 0; k < nx * ny; k++) if (water[k] && !gate[k] && !outer[k]) inner++;
  console.log(`inner river cells (behind closed gates): ${inner}`);

  const out = path.join(regionDir, 'seawalls.json');
  fs.writeFileSync(out, JSON.stringify(seawalls, null, 2));
  console.log(`Saved ${seawalls.length} gates to ${out}`);

  const ci = process.argv.indexOf('--check');
  if (ci > 0) {
    const a = jpeg.decode(fs.readFileSync(path.join(regionDir, 'aerial.jpg')), { useTArray: true });
    for (let k = 0; k < nx * ny; k++) {
      const o = k * 4;
      if (gate[k]) { a.data[o] = 255; a.data[o + 1] = 160; a.data[o + 2] = 0; }
      else if (water[k] && !outer[k]) { a.data[o] = 0; a.data[o + 1] = 220; a.data[o + 2] = 90; }
      else if (water[k]) { a.data[o] = 20; a.data[o + 1] = 60; a.data[o + 2] = 200; }
    }
    fs.writeFileSync(process.argv[ci + 1], jpeg.encode({ data: a.data, width: nx, height: ny }, 85).data);
  }
}

main();
