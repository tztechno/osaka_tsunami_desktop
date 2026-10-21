/**
 * Preset boundary wave CSVs from nankai_trough results (.cache/nankai_results.json, written by
 * tools/nankai/run-nankai.ts). The files use nankai_trough's own export formats:
 *   - *_trimmed.csv: "city trimmed" (方式B) — from 2 min before the first arrival, Time_since_EQ columns
 *   - *_full.csv:    full timeline (方式A) from the earthquake origin
 * The sampled point is on the simulation region's west edge (Osaka Bay), where the wave enters.
 *
 *   node tools/build-wave-sources.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsFile = path.join(appRoot, '.cache', 'nankai_results.json');
const outDir = path.join(appRoot, 'public', 'data', 'wave_sources');

const SCENARIO = 'cao2012_case3'; // largest wave in Osaka Bay among the Cabinet Office cases
const POINT = 'osaka_edge_mid';
const FULL_DURATION_SEC = 10800;

// Same as ChartRenderer.formatHMS in nankai_trough
function formatHMS(totalSec) {
  const sec = Math.round(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const row = (r) => `${r.elevation.toFixed(3)},${r.u.toFixed(3)},${r.v.toFixed(3)},${r.speed.toFixed(3)},${r.directionDeg.toFixed(1)}`;
const write = (name, lines) => {
  fs.writeFileSync(path.join(outDir, name), '﻿' + lines.join('\r\n'));
  console.log(`Saved ${name} (${lines.length} lines)`);
};

function trimmed(pt) {
  const arrival = pt.firstArrivalSec ?? pt.maxArrivalSec;
  const tStart = Math.max(0, arrival - 120);
  const tEnd = Math.max((pt.maxArrivalSec ?? arrival) + 2100, arrival + 2700);
  const rows = pt.timeHistory.filter((h) => h.timeSec >= tStart && h.timeSec <= tEnd);
  const t0 = rows[0].timeSec;
  const t1 = rows[rows.length - 1].timeSec;
  const lines = [
    '# Tsunami Boundary Wave Condition for City Simulation (Phase 2)',
    `# Location: ${pt.name} (Lon: ${pt.lon}, Lat: ${pt.lat})`,
    '# Mode: Trimmed Effective Wave (Shifted to t=0 at 2-min before arrival)',
    `# Original Absolute First Arrival: ${pt.firstArrivalSec?.toFixed(1) ?? 'N/A'} s (${pt.firstArrivalSec !== undefined ? formatHMS(pt.firstArrivalSec) : 'N/A'} after earthquake)`,
    `# Original Absolute Max Surge: ${pt.maxWaveHeight ?? 0} m (at ${pt.maxArrivalSec?.toFixed(1) ?? 'N/A'} s = ${pt.maxArrivalSec !== undefined ? formatHMS(pt.maxArrivalSec) : 'N/A'} after earthquake)`,
    `# Time Offset: -${t0.toFixed(1)} s (Absolute_Time_sec = Time_sec + ${t0.toFixed(1)})`,
    `# Trimmed Window (time since earthquake): ${formatHMS(t0)} - ${formatHMS(t1)}`,
    '# Time_since_EQ_sec / Time_since_EQ_hms: elapsed time since the earthquake origin (rupture at 0 s)',
    'Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg,Time_since_EQ_sec,Time_since_EQ_hms',
  ];
  for (const r of rows) lines.push(`${(r.timeSec - t0).toFixed(1)},${row(r)},${r.timeSec.toFixed(1)},${formatHMS(r.timeSec)}`);
  return lines;
}

function full(pt) {
  const lines = [
    '# Tsunami Wave Boundary Condition for Phase 2 Simulation (Full Timeline)',
    `# Location: ${pt.name} (Lon: ${pt.lon}, Lat: ${pt.lat})`,
    `# Max Wave Height: ${pt.maxWaveHeight ?? 0} m, First Arrival: ${pt.firstArrivalSec ?? 'N/A'} s`,
    'Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg',
  ];
  for (const r of pt.timeHistory) if (r.timeSec <= FULL_DURATION_SEC) lines.push(`${r.timeSec.toFixed(1)},${row(r)}`);
  return lines;
}

function main() {
  if (!fs.existsSync(resultsFile)) {
    console.error(`${resultsFile} not found: run tools/nankai/run-nankai.ts first (see its header)`);
    process.exit(1);
  }
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const pt = results[SCENARIO].points.find((p) => p.id === POINT);
  console.log(`${results[SCENARIO].name} @ ${pt.name}: max ${pt.maxWaveHeight} m at ${formatHMS(pt.maxArrivalSec)}, first arrival ${formatHMS(pt.firstArrivalSec)}`);
  fs.mkdirSync(outDir, { recursive: true });
  write('nankai_trough_osaka_trimmed.csv', trimmed(pt));
  write('nankai_trough_osaka_full.csv', full(pt));
}

main();
