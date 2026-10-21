#!/usr/bin/env node
// Town (町丁・字) boundaries for the osaka_port simulation area, used to show the extent of an address that
// is only given down to the town / chome (no block number).
//
//   node tools/build-towns.mjs
//
// Source: e-Stat 国勢調査 2020 小地域(町丁・字等)境界データ, JGD2011 lat/lon shapefiles for
// Osaka (27) and Hyogo (28) — 総務省統計局. Downloads are cached in .cache/estat.
// Output public/data/towns.json: [{ pref, city, name, area, rings: [[E, N, E, N, ...], ...] }] (EPSG:6674, 0.1 m)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const cache = path.join(appRoot, '.cache', 'estat');
fs.mkdirSync(cache, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'meta.json'), 'utf8'));
// simulation area in EPSG:6674 (originN is the north edge)
const BOX = { eMin: meta.originE, eMax: meta.originE + meta.widthM, nMin: meta.originN - meta.heightM, nMax: meta.originN };
const PREFS = ['27', '28'];
const t0 = Date.now();
const lap = (m) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function download(pref) {
  const zip = path.join(cache, `r2ka${pref}.zip`);
  if (!fs.existsSync(zip)) {
    const url = `https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=${pref}&coordSys=1&format=shape&downloadType=5&datum=2011`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`e-Stat ${pref}: HTTP ${r.status}`);
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  execFileSync('unzip', ['-o', '-q', zip, '-d', cache]);
  return path.join(cache, `r2ka${pref}`);
}

function readDbf(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10);
  const fields = [];
  for (let o = 32; b[o] !== 0x0d; o += 32) fields.push({ name: b.toString('latin1', o, o + 11).replace(/\0.*$/, ''), len: b[o + 16] });
  const td = new TextDecoder('shift_jis');
  const rows = [];
  for (let r = 0; r < n; r++) {
    let o = hl + r * rl + 1;
    const rec = {};
    for (const f of fields) { rec[f.name] = td.decode(b.subarray(o, o + f.len)).trim(); o += f.len; }
    rows.push(rec);
  }
  return rows;
}

/** Polygon shapefile -> per record: array of rings, each [lon, lat, lon, lat, ...] */
function readShp(file) {
  const b = fs.readFileSync(file);
  const out = [];
  let o = 100;
  while (o < b.length) {
    const len = b.readInt32BE(o + 4) * 2;
    const c = o + 8;
    const type = b.readInt32LE(c);
    const rings = [];
    if (type === 5) {
      const np = b.readInt32LE(c + 36), npt = b.readInt32LE(c + 40);
      const parts = [];
      for (let i = 0; i < np; i++) parts.push(b.readInt32LE(c + 44 + i * 4));
      const p0 = c + 44 + np * 4;
      for (let i = 0; i < np; i++) {
        const s = parts[i], e = i + 1 < np ? parts[i + 1] : npt;
        const ring = new Float64Array((e - s) * 2);
        for (let k = s; k < e; k++) { ring[(k - s) * 2] = b.readDoubleLE(p0 + k * 16); ring[(k - s) * 2 + 1] = b.readDoubleLE(p0 + k * 16 + 8); }
        rings.push(ring);
      }
    }
    out.push(rings);
    o = c + len;
  }
  return out;
}

// Douglas–Peucker on a flat [x, y, ...] ring (tolerance in m). Rings are closed (first == last point), so the
// ring is split at the vertex farthest from the start and both halves are simplified.
function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n < 5) return pts;
  const keep = new Uint8Array(n);
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(pts[i * 2] - pts[0], pts[i * 2 + 1] - pts[1]); if (d > fd) { fd = d; far = i; } }
  keep[0] = keep[n - 1] = keep[far] = 1;
  const stack = [[0, far], [far, n - 1]];
  while (stack.length) {
    const [a, z] = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1], zx = pts[z * 2], zy = pts[z * 2 + 1];
    const dx = zx - ax, dy = zy - ay, L = Math.hypot(dx, dy) || 1;
    let md = -1, mi = -1;
    for (let i = a + 1; i < z; i++) {
      const d = Math.abs((pts[i * 2] - ax) * dy - (pts[i * 2 + 1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, z]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

const towns = [];
for (const pref of PREFS) {
  const base = await download(pref);
  const rows = readDbf(base + '.dbf'), shapes = readShp(base + '.shp');
  let kept = 0;
  rows.forEach((rec, i) => {
    const rings = shapes[i];
    if (!rings?.length || !rec.S_NAME) return;
    let inside = false;
    const planar = rings.map((r) => {
      const p = [];
      for (let k = 0; k < r.length; k += 2) {
        const [E, N] = toPlane(r[k], r[k + 1]);
        if (E >= BOX.eMin && E <= BOX.eMax && N >= BOX.nMin && N <= BOX.nMax) inside = true;
        p.push(E, N);
      }
      return simplify(p, 0.5).map((v) => Math.round(v * 10) / 10);
    });
    if (!inside) return;
    towns.push({ pref: rec.PREF_NAME, city: rec.CITY_NAME, name: rec.S_NAME, area: Math.round(+rec.AREA), rings: planar });
    kept++;
  });
  lap(`pref ${pref}: ${rows.length} areas, ${kept} in the simulation area`);
}
fs.writeFileSync(path.join(appRoot, 'public', 'data', 'towns.json'), JSON.stringify(towns));
lap(`towns.json: ${towns.length} areas (${(fs.statSync(path.join(appRoot, 'public', 'data', 'towns.json')).size / 1e6).toFixed(1)} MB)`);
