// Address / place search for the observation pin: landmark names from labels.json first, then the
// GSI address search (needs a network connection). Only hits inside the simulation area are kept.
// An address with a block number is a point; one given only down to the town / chome is shown as the
// extent of that town from towns.json (e-Stat 町丁・字 boundaries, tools/build-towns.mjs).
import { toPlane } from './proj.js';

const GSI_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
// a block / house number (番地・号, digits) is a point; a town or chome is an area
const isPointAddress = (title) => /[0-9０-９]/.test(title) || /(番地|番|号)$/.test(title);

let townsP = null;
const towns = () => (townsP ||= fetch('data/towns.json').then((r) => r.json()).catch(() => []));

/** Town polygons for a town-level address, e.g. 大阪府大阪市此花区西九条 -> 西九条一丁目 … 七丁目 */
async function townArea(title, meta) {
  const hits = (await towns()).filter((t) => {
    const full = t.pref + t.city + t.name;
    if (!full.startsWith(title)) return false;
    const rest = full.slice(title.length);
    return rest === '' || /^字/.test(rest) || /^[一二三四五六七八九十]+丁目/.test(rest);
  });
  if (!hits.length) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, m2 = 0;
  const rings = [];
  for (const h of hits) {
    m2 += h.area;
    for (const r of h.rings) {
      const w = new Float64Array(r.length);
      for (let i = 0; i < r.length; i += 2) {
        w[i] = r[i] - meta.originE;
        w[i + 1] = meta.originN - r[i + 1];
        minX = Math.min(minX, w[i]); maxX = Math.max(maxX, w[i]);
        minZ = Math.min(minZ, w[i + 1]); maxZ = Math.max(maxZ, w[i + 1]);
      }
      rings.push(w);
    }
  }
  return { parts: hits.map((h) => h.name), m2, bbox: [minX, minZ, maxX, maxZ], rings };
}

/**
 * Candidates for a query: [{ title, title_en, worldX, worldZ, source: 'label' | 'gsi', kind: 'point' | 'area', area? }]
 * (region-local metres; area.rings are region-local too).
 */
export async function searchPlaces(q, meta, landmarks = []) {
  const toWorld = (lon, lat) => {
    const [e, n] = toPlane(lon, lat);
    const worldX = e - meta.originE;
    const worldZ = meta.originN - n;
    const inside = worldX >= 0 && worldZ >= 0 && worldX < meta.widthM && worldZ < meta.heightM;
    return inside ? { worldX, worldZ } : null;
  };

  const out = [];
  for (const l of landmarks) {
    if (!l.name.includes(q) && !(l.name_en || '').toLowerCase().includes(q.toLowerCase())) continue;
    const w = toWorld(l.lon, l.lat);
    if (w) out.push({ title: l.name, title_en: l.name_en || l.name, ...w, source: 'label', kind: 'point' });
  }

  let list = [];
  try {
    const r = await fetch(GSI_URL + encodeURIComponent(q));
    list = await r.json();
  } catch (e) {
    if (!out.length) throw new Error(e.message);
  }
  for (const f of list) {
    const [lon, lat] = f.geometry.coordinates;
    const w = toWorld(lon, lat);
    if (!w) continue;
    const title = f.properties.title;
    const area = isPointAddress(title) ? null : await townArea(title, meta);
    out.push({ title, title_en: title, ...w, source: 'gsi', kind: area ? 'area' : 'point', area });
    if (out.length >= 15) break;
  }
  return out;
}
