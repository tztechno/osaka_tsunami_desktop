import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlane } from './lib/proj.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const metaFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'meta.json');
const outFile = path.join(appRoot, 'public', 'data', 'regions', 'osaka_port', 'seawalls.json');

async function main() {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const { originE, originN, widthM, heightM } = meta;

  function toLocal(lon, lat) {
    const [e, n] = toPlane(lon, lat);
    return [+(e - originE).toFixed(1), +(originN - n).toFixed(1)];
  }

  // Osaka Coastal Defense System:
  // 1. Three Major Arch Sluice Gates (三大水門): Ajigawa, Shirinashigawa, Kizugawa
  // 2. Coastal Seawalls (海岸防潮堤): Tempozan, Konohana, Minato, Taisho, Sakishima, Yumeshima
  // 3. River Floodwalls (河川堤防): Yodo River Left Bank, Yamato River Right Bank

  const seawalls = [
    {
      id: 'ajigawa_gate',
      name: '安治川水門 (三大水門)',
      name_en: 'Ajigawa Sluice Gate',
      type: 'sluice_gate',
      designHeight: 7.4,
      widthM: 70,
      points: [
        toLocal(135.4730, 34.6808),
        toLocal(135.4750, 34.6792),
      ],
      description: '安治川の津波遡上を防ぐアーチ型水門（T.P. +7.4m）。市街地（梅田・野田・中之島）を守る要。',
      description_en: 'Arch-shaped floodgate (T.P. +7.4m) protecting downtown Osaka (Umeda, Nakanoshima) from tsunami surges up Ajigawa.',
    },
    {
      id: 'shirinashi_gate',
      name: '尻無川水門 (三大水門)',
      name_en: 'Shirinashigawa Sluice Gate',
      type: 'sluice_gate',
      designHeight: 6.7,
      widthM: 65,
      points: [
        toLocal(135.4760, 34.6658),
        toLocal(135.4780, 34.6642),
      ],
      description: '尻無川河口の防潮水門（T.P. +6.7m）。大正区・港区のゼロメートル市街地を防護。',
      description_en: 'Floodgate (T.P. +6.7m) protecting low-lying coastal urban areas in Taisho and Minato wards.',
    },
    {
      id: 'kizugawa_gate',
      name: '木津川水門 (三大水門)',
      name_en: 'Kizugawa Sluice Gate',
      type: 'sluice_gate',
      designHeight: 7.2,
      widthM: 75,
      points: [
        toLocal(135.4890, 34.6558),
        toLocal(135.4910, 34.6542),
      ],
      description: '木津川河口の水門（T.P. +7.2m）。難波・道頓堀・ミナミ繁華街への津波流入を阻止。',
      description_en: 'Floodgate (T.P. +7.2m) preventing tsunami surge from penetrating into Namba and Dotonbori.',
    },
    {
      id: 'tempozan_wall',
      name: '大阪港・築港防潮堤',
      name_en: 'Osaka Port & Tempozan Coastal Seawall',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 18,
      points: [
        toLocal(135.4260, 34.6630),
        toLocal(135.4300, 34.6570),
        toLocal(135.4340, 34.6530),
        toLocal(135.4410, 34.6510),
      ],
      description: '大阪港（天保山・海遊館周辺）の海岸防潮堤。天端高 T.P. +6.8m。',
      description_en: 'Coastal protection dyke at Osaka Port (Tempozan) with crest elevation T.P. +6.8m.',
    },
    {
      id: 'konohana_coastal',
      name: '此花区・桜島海岸防潮堤',
      name_en: 'Konohana & Sakurajima Coastal Seawall',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 18,
      points: [
        toLocal(135.4120, 34.6680),
        toLocal(135.4240, 34.6650),
        toLocal(135.4360, 34.6680),
        toLocal(135.4520, 34.6750),
        toLocal(135.4730, 34.6808),
      ],
      description: 'USJ・桜島から安治川左岸へと続く海岸防潮堤（T.P. +6.8m）。',
      description_en: 'Seawall guarding Konohana, USJ, and lower Ajigawa basin (T.P. +6.8m).',
    },
    {
      id: 'minato_taisho_coastal',
      name: '港区・大正区外周防潮堤',
      name_en: 'Minato & Taisho Coastal Defense Wall',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 18,
      points: [
        toLocal(135.4410, 34.6510),
        toLocal(135.4500, 34.6460),
        toLocal(135.4620, 34.6380),
        toLocal(135.4750, 34.6320),
        toLocal(135.4850, 34.6380),
        toLocal(135.4890, 34.6542),
      ],
      description: '港区・大正区のゼロメートル地帯を海から囲む連続防潮堤（T.P. +6.8m）。',
      description_en: 'Continuous coastal dyke encircling below-sea-level urban zones in Minato and Taisho wards.',
    },
    {
      id: 'yumeshima_wall',
      name: '夢洲外周護岸・防潮堤',
      name_en: 'Yumeshima Perimeter Seawall',
      type: 'seawall',
      designHeight: 6.5,
      widthM: 20,
      points: [
        toLocal(135.3850, 34.6580),
        toLocal(135.3820, 34.6500),
        toLocal(135.3880, 34.6430),
        toLocal(135.4050, 34.6430),
      ],
      description: '万博会場・IR予定地である夢洲の南西外周護岸（T.P. +6.5m）。',
      description_en: 'Perimeter coastal defense seawall on Yumeshima Island (T.P. +6.5m).',
    },
    {
      id: 'sakishima_wall',
      name: '咲洲（南港）海岸防潮堤',
      name_en: 'Sakishima (Nanko) Coastal Seawall',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 18,
      points: [
        toLocal(135.4050, 34.6480),
        toLocal(135.4120, 34.6390),
        toLocal(135.4250, 34.6300),
        toLocal(135.4400, 34.6250),
      ],
      description: '咲洲コスモスクエア〜南港コンテナ埠頭を取り囲む防潮堤（T.P. +6.8m）。',
      description_en: 'Seawall protecting Sakishima Island & Nanko Container Terminal (T.P. +6.8m).',
    },
    {
      id: 'yodo_bank',
      name: '淀川左岸スーパー堤防',
      name_en: 'Yodo River Left Bank High-Standard Levee',
      type: 'seawall',
      designHeight: 7.2,
      widthM: 25,
      points: [
        toLocal(135.4180, 34.6850),
        toLocal(135.4450, 34.6950),
        toLocal(135.4850, 34.7100),
      ],
      description: '此花区・福島区を守る淀川左岸堤防（T.P. +7.2m）。',
      description_en: 'High-standard flood protection levee along the left bank of the Yodo River.',
    },
    {
      id: 'yamato_bank',
      name: '大和川右岸防潮堤',
      name_en: 'Yamato River Right Bank Levee',
      type: 'seawall',
      designHeight: 7.0,
      widthM: 20,
      points: [
        toLocal(135.4450, 34.6050),
        toLocal(135.4700, 34.6020),
        toLocal(135.4950, 34.6000),
      ],
      description: '住之江区・南港南側を守る大和川右岸防潮堤（T.P. +7.0m）。',
      description_en: 'Right bank levee of Yamato River guarding Suminoe ward (T.P. +7.0m).',
    },
    {
      id: 'maishima_wall',
      name: '舞洲外周護岸・防潮堤',
      name_en: 'Maishima Perimeter Seawall',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 20,
      points: [
        toLocal(135.3900, 34.6720),
        toLocal(135.3850, 34.6650),
        toLocal(135.4050, 34.6580),
        toLocal(135.4180, 34.6650),
        toLocal(135.4150, 34.6750),
      ],
      description: 'スポーツアイランド舞洲の外周を囲む護岸・防潮堤（T.P. +6.8m）。',
      description_en: 'Coastal protection perimeter surrounding Maishima Sports Island (T.P. +6.8m).',
    },
    {
      id: 'nishiyodogawa_wall',
      name: '西淀川区・神崎川/左門殿川防潮堤',
      name_en: 'Nishiyodogawa & Kanzakigawa Levee',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 18,
      points: [
        toLocal(135.4100, 34.7050),
        toLocal(135.4300, 34.7150),
        toLocal(135.4550, 34.7180),
        toLocal(135.4750, 34.7200),
      ],
      description: '西淀川区の海抜ゼロメートル地帯を囲む神崎川水系防潮堤（T.P. +6.8m）。',
      description_en: 'Flood protection levees guarding Nishiyodogawa zero-meter districts (T.P. +6.8m).',
    },
    {
      id: 'suminoe_coastal',
      name: '住之江区・南港内港防潮堤',
      name_en: 'Suminoe & Inner Nanko Seawall',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 18,
      points: [
        toLocal(135.4400, 34.6250),
        toLocal(135.4550, 34.6200),
        toLocal(135.4750, 34.6150),
        toLocal(135.4850, 34.6100),
      ],
      description: '住之江区臨海部と大和川河口北岸を守る防潮堤（T.P. +6.8m）。',
      description_en: 'Coastal seawall protecting Suminoe coastal industrial and residential zones (T.P. +6.8m).',
    },
    {
      id: 'ajigawa_riverwalls',
      name: '安治川両岸防潮堤・胸壁',
      name_en: 'Ajigawa River Defense Walls',
      type: 'seawall',
      designHeight: 6.8,
      widthM: 16,
      points: [
        toLocal(135.4400, 34.6700),
        toLocal(135.4550, 34.6750),
        toLocal(135.4730, 34.6808),
      ],
      description: '此花区と港区を挟む安治川両岸の防潮胸壁（T.P. +6.8m）。',
      description_en: 'River defense parapet walls along both banks of lower Ajigawa (T.P. +6.8m).',
    },
    {
      id: 'shirinashi_riverwalls',
      name: '尻無川両岸防潮堤・胸壁',
      name_en: 'Shirinashigawa River Defense Walls',
      type: 'seawall',
      designHeight: 6.7,
      widthM: 16,
      points: [
        toLocal(135.4550, 34.6530),
        toLocal(135.4680, 34.6600),
        toLocal(135.4760, 34.6658),
      ],
      description: '港区と大正区の境界を流れる尻無川両岸の防潮胸壁（T.P. +6.7m）。',
      description_en: 'Parapet walls along Shirinashigawa riverbanks protecting Minato and Taisho wards (T.P. +6.7m).',
    },
    {
      id: 'kizugawa_riverwalls',
      name: '木津川両岸防潮堤・胸壁',
      name_en: 'Kizugawa River Defense Walls',
      type: 'seawall',
      designHeight: 7.0,
      widthM: 16,
      points: [
        toLocal(135.4750, 34.6320),
        toLocal(135.4850, 34.6450),
        toLocal(135.4890, 34.6558),
      ],
      description: '大正区東側の木津川両岸防潮胸壁（T.P. +7.0m）。',
      description_en: 'Parapet defense walls along Kizugawa riverbanks protecting eastern Taisho and Naniwa (T.P. +7.0m).',
    },
  ];

  fs.writeFileSync(outFile, JSON.stringify(seawalls, null, 2));
  console.log(`Saved ${seawalls.length} seawalls/gates to ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
