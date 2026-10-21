import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..');

const n60LabelsFile = path.resolve(workspaceRoot, '..', 'N60_osaka_viewer', 'osaka_viewer', 'public', 'data', 'labels', 'labels.json');
const metaFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'meta.json');
const outFile = path.join(appRoot, 'public', 'data', 'labels.json');

async function main() {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const { originE, originN, widthM, heightM } = meta;

  // Key primary landmarks in Osaka Bay & City
  const primaryLabels = [
    { name: '夢洲 (万博会場)', name_en: 'Yumeshima (Expo 2025)', lon: 135.395, lat: 34.650, height: 10 },
    { name: '舞洲', name_en: 'Maishima', lon: 135.395, lat: 34.665, height: 10 },
    { name: '咲洲コスモタワー', name_en: 'Sakishima Cosmo Tower', lon: 135.415, lat: 34.638, height: 256 },
    { name: '天保山・海遊館 (大阪港)', name_en: 'Tempozan & Kaiyukan', lon: 135.432, lat: 34.656, height: 35 },
    { name: '安治川水門', name_en: 'Ajigawa Sluice Gate', lon: 135.45235, lat: 34.67399, height: 25 },
    { name: '尻無川水門', name_en: 'Shirinashigawa Sluice Gate', lon: 135.46507, lat: 34.65998, height: 25 },
    { name: '木津川水門', name_en: 'Kizugawa Sluice Gate', lon: 135.47912, lat: 34.64521, height: 25 },
    { name: '京セラドーム大阪', name_en: 'Kyocera Dome Osaka', lon: 135.476, lat: 34.669, height: 50 },
    { name: 'JR大阪駅・梅田', name_en: 'Osaka Station / Umeda', lon: 135.498, lat: 34.702, height: 150 },
    { name: '難波・道頓堀', name_en: 'Namba / Dotonbori', lon: 135.501, lat: 34.666, height: 50 },
    { name: '通天閣', name_en: 'Tsutenkaku Tower', lon: 135.506, lat: 34.652, height: 108 },
    { name: '中之島', name_en: 'Nakanoshima', lon: 135.495, lat: 34.693, height: 80 },
    { name: 'USJ (ユニバーサル・スタジオ)', name_en: 'Universal Studios Japan', lon: 135.432, lat: 34.665, height: 30 },
  ];

  const labels = [];
  for (const item of primaryLabels) {
    const [e, n] = toPlane(item.lon, item.lat);
    const x = +(e - originE).toFixed(1);
    const z = +(originN - n).toFixed(1);
    if (x >= 0 && x <= widthM && z >= 0 && z <= heightM) {
      labels.push({
        ...item,
        x,
        z,
      });
    }
  }

  // Also read from N60 labels if available for famous spots
  if (fs.existsSync(n60LabelsFile)) {
    try {
      const n60 = JSON.parse(fs.readFileSync(n60LabelsFile, 'utf8'));
      const items = Array.isArray(n60) ? n60 : (n60.items || n60.features || []);
      for (const item of items) {
        const lon = item.lon || item.lng || item.coords?.[0];
        const lat = item.lat || item.coords?.[1];
        const name = item.name || item.properties?.name;
        if (!lon || !lat || !name) continue;
        const [e, n] = toPlane(lon, lat);
        const x = +(e - originE).toFixed(1);
        const z = +(originN - n).toFixed(1);
        if (x >= 0 && x <= widthM && z >= 0 && z <= heightM) {
          if (!labels.some(l => l.name === name)) {
            labels.push({
              name,
              name_en: item.name_en || name,
              lon,
              lat,
              height: item.height || item.h || 20,
              x,
              z,
            });
          }
        }
      }
    } catch (e) {
      console.warn('Could not parse N60 labels:', e.message);
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(labels, null, 2));
  console.log(`Saved ${labels.length} labels to ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
