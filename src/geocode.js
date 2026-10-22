// Address / place search for the observation pin: landmark names from labels.json first, then the
// GSI address search (needs a network connection). Hits just outside the simulation area (within the
// backdrop) are returned separately, so the UI can say why they get no pin.
// An address with a block number is a point; one given only down to the town / chome is shown as the
// extent of that town from towns.json (e-Stat 町丁・字 boundaries, tools/build-towns.mjs). Town names are also
// matched in towns.json directly, so towns are found offline or when the GSI search returns nothing.
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

/** Towns in towns.json whose ward + name contain the query, grouped by town (chome merged): full titles. */
async function localTownTitles(q) {
  const key = q.replace(/\s/g, '').replace(/^大阪府/, '').replace(/^大阪市/, '');
  if (key.length < 2 || /[0-9０-９]/.test(key)) return [];
  const titles = new Set();
  for (const t of await towns()) {
    const city = t.city.replace(/^大阪市/, '');
    if (!(city + t.name).includes(key) && !t.name.startsWith(key)) continue;
    titles.add(t.pref + t.city + t.name.replace(/[一二三四五六七八九十]+丁目$/, ''));
    if (titles.size >= 8) break;
  }
  return [...titles];
}

const NEARBY_M = 25000; // out-of-area hits farther than this from the area are dropped (other cities)

/**
 * Candidates for a query: { inside: [{ title, title_en, worldX, worldZ, source: 'label' | 'gsi' | 'town', kind: 'point' | 'area', area? }],
 * outside: [{ title, worldX, worldZ }] } (region-local metres; area.rings are region-local too).
 */
export async function searchPlaces(q, meta, landmarks = []) {
  const toWorld = (lon, lat) => {
    const [e, n] = toPlane(lon, lat);
    const worldX = e - meta.originE;
    const worldZ = meta.originN - n;
    const inside = worldX >= 0 && worldZ >= 0 && worldX < meta.widthM && worldZ < meta.heightM;
    return { worldX, worldZ, inside };
  };
  const nearby = ({ worldX, worldZ }) =>
    Math.hypot(Math.max(0, -worldX, worldX - meta.widthM), Math.max(0, -worldZ, worldZ - meta.heightM)) < NEARBY_M;

  const out = [];
  const outside = [];
  for (const l of landmarks) {
    if (!l.name.includes(q) && !(l.name_en || '').toLowerCase().includes(q.toLowerCase())) continue;
    const { worldX, worldZ, inside } = toWorld(l.lon, l.lat);
    if (inside) out.push({ title: l.name, title_en: l.name_en || l.name, worldX, worldZ, source: 'label', kind: 'point' });
  }

  let list = [], gsiError = null;
  try {
    const r = await fetch(GSI_URL + encodeURIComponent(q));
    list = await r.json();
  } catch (e) {
    gsiError = e.message;
  }
  for (const f of list) {
    const [lon, lat] = f.geometry.coordinates;
    const { worldX, worldZ, inside } = toWorld(lon, lat);
    const title = f.properties.title;
    if (!inside) {
      if (outside.length < 5 && nearby({ worldX, worldZ })) outside.push({ title, worldX, worldZ });
      continue;
    }
    const area = isPointAddress(title) ? null : await townArea(title, meta);
    // a place of the same name as a landmark (e.g. 大阪城) is listed once, at the landmark
    if (!area && out.some((h) => h.source === 'label' && h.title === title)) continue;
    out.push({ title, title_en: title, worldX, worldZ, source: 'gsi', kind: area ? 'area' : 'point', area });
    if (out.length >= 15) break;
  }
  // towns from the local boundaries that the GSI search did not list
  for (const title of await localTownTitles(q)) {
    if (out.some((h) => h.title === title)) continue;
    const area = await townArea(title, meta);
    if (!area) continue;
    const worldX = (area.bbox[0] + area.bbox[2]) / 2, worldZ = (area.bbox[1] + area.bbox[3]) / 2;
    out.push({ title, title_en: title, worldX, worldZ, source: 'town', kind: 'area', area });
  }
  if (!out.length && gsiError) throw new Error(gsiError);
  return { inside: out, outside };
}
