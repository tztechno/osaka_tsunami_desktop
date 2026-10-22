#!/usr/bin/env node
// Osaka Castle: position, orientation and measured heights of the main keep (大阪城天守閣, PLATEAU 2025 LOD2)
// for the detailed castle model (src/castle.js), so the model stands exactly where PLATEAU puts the keep and the
// plain building blocks there can be replaced by it. Same approach as N65 nagoya_flood's build-castle.
//
//   node tools/build-castle.mjs        -> public/data/castle.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const MESH = '52350422'; // 3rd-level mesh with the keep
const cat = await (await fetch(`https://api.plateauview.mlit.go.jp/datacatalog/citygml/m:${MESH}`)).json();
const url = cat.cities.find((c) => c.cityCode === '27100').files.bldg[0].url;
const s = await (await fetch(url)).text();
const keep = [...s.matchAll(/<bldg:Building gml:id="([^"]+)"([\s\S]*?)<\/bldg:Building>/g)].find((m) => m[2].includes('大阪城天守閣'));
if (!keep) throw new Error('大阪城天守閣 not found');
const pts = (txt) => {
  const out = [];
  for (const pl of txt.matchAll(/<gml:posList[^>]*>([^<]+)</g)) {
    const v = pl[1].trim().split(/\s+/).map(Number);
    for (let k = 0; k < v.length; k += 3) { const [E, N] = toPlane(v[k + 1], v[k]); out.push([E, N, v[k + 2]]); }
  }
  return out;
};
/** Rotation (deg, counter-clockwise from east) of the smallest enclosing rectangle, its centre and half sizes. */
function box(p) {
  let best = null;
  const cE = p.reduce((a, q) => a + q[0], 0) / p.length, cN = p.reduce((a, q) => a + q[1], 0) / p.length;
  for (let deg = -45; deg < 45; deg += 0.25) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const q of p) { const x = (q[0] - cE) * c + (q[1] - cN) * sn, y = -(q[0] - cE) * sn + (q[1] - cN) * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { deg, area, x0, x1, y0, y1 };
  }
  const r = (best.deg * Math.PI) / 180, mx = (best.x0 + best.x1) / 2, my = (best.y0 + best.y1) / 2;
  return { E: cE + mx * Math.cos(r) - my * Math.sin(r), N: cN + mx * Math.sin(r) + my * Math.cos(r), rot: best.deg, hx: (best.x1 - best.x0) / 2, hy: (best.y1 - best.y0) / 2 };
}
const body = keep[2];
const wall = pts([...body.matchAll(/<bldg:WallSurface[\s\S]*?<\/bldg:WallSurface>/g)].map((m) => m[0]).join(''));
const all = pts(body.replace(/<bldg:lod0[\s\S]*?<\/bldg:lod0\w+>/g, ''));
const b = box(wall);
const z = all.map((q) => q[2]);
const out = {
  source: `PLATEAU Osaka 2025, udx/bldg/${MESH} (keep: LOD2 walls)`,
  keep: { id: keep[1], E: +b.E.toFixed(2), N: +b.N.toFixed(2), rot: b.rot, base: +Math.min(...z).toFixed(2), top: +Math.max(...z).toFixed(2), hx: +b.hx.toFixed(2), hy: +b.hy.toFixed(2) },
};
fs.writeFileSync(path.join(appRoot, 'public', 'data', 'castle.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
