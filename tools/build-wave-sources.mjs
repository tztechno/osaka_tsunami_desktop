import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const outDir = path.join(appRoot, 'public', 'data', 'wave_sources');
fs.mkdirSync(outDir, { recursive: true });

function formatHms(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// 1. Trimmmed wave source: shifted so arrival happens at t = 60s, peak at ~12 min
function buildTrimmedWave() {
  const rows = [];
  rows.push('# Tsunami Boundary Wave Condition for City Simulation (Phase 2)');
  rows.push('# Location: 大阪港沖 (大阪湾) (Lon: 135.35, Lat: 34.60)');
  rows.push('# Mode: Trimmed Effective Wave (Shifted to t=0 at 2-min before arrival)');
  rows.push('# Original Absolute First Arrival: 6480.0 s (1:48:00 after earthquake)');
  rows.push('# Original Absolute Max Surge: 5.40 m (at 7560.0 s = 2:06:00 after earthquake)');
  rows.push('# Time Offset: 6360.0 s (Time_since_EQ_sec = Time_sec + 6360.0)');
  rows.push('Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg,Time_since_EQ_sec,Time_since_EQ_hms');

  const dt = 3.0; // 3-second intervals
  const totalSec = 3600; // 60 minutes simulation window
  const eqOffset = 6360.0;

  for (let t = 0; t <= totalSec; t += dt) {
    const eqTime = t + eqOffset;
    let eta = 0;
    let speed = 0;

    if (t < 60) {
      // Quiet before arrival
      eta = 0.0;
      speed = 0.0;
    } else if (t < 420) {
      // 1st surge: rises to +2.4m at t = 240s, then drawdown to -1.8m at t = 420s
      const tau = (t - 60) / 360;
      eta = 2.4 * Math.sin(tau * Math.PI * 1.5);
      speed = Math.abs(eta) * 0.45;
    } else if (t < 1140) {
      // 2nd MASSIVE PEAK: rises from -1.8m to +5.40m at t = 720s (12 min), then recedes
      const tau = (t - 420) / 720;
      const wave = Math.sin(tau * Math.PI);
      eta = -1.8 * (1 - wave) + 5.40 * wave;
      speed = Math.max(0.2, (eta + 2.0) * 0.55);
    } else if (t < 2100) {
      // 3rd sustained surge: +3.2m
      const tau = (t - 1140) / 960;
      eta = 1.0 + 2.2 * Math.sin(tau * Math.PI * 2);
      speed = Math.max(0.1, Math.abs(eta) * 0.35);
    } else {
      // Tail oscillations: decaying long swell (+1.5m to -0.8m)
      const tau = (t - 2100) / 1500;
      const decay = Math.exp(-tau * 1.2);
      eta = 1.6 * decay * Math.sin(tau * Math.PI * 4);
      speed = Math.max(0.05, Math.abs(eta) * 0.25);
    }

    // Direction: incoming from South-West (235° azimuth, propagating towards 55° NE)
    // U > 0 (Eastward), V > 0 (Northward)
    const angleRad = (55 * Math.PI) / 180;
    const u = +(speed * Math.sin(angleRad)).toFixed(3);
    const v = +(speed * Math.cos(angleRad)).toFixed(3);

    rows.push(`${t.toFixed(1)},${eta.toFixed(3)},${u},${v},${speed.toFixed(3)},235.0,${eqTime.toFixed(1)},${formatHms(eqTime)}`);
  }

  const file = path.join(outDir, 'nankai_trough_osaka_trimmed.csv');
  fs.writeFileSync(file, rows.join('\n'));
  console.log(`Saved ${file} (${rows.length} rows)`);
}

// 2. Full timeline wave source: 2.5 hours (9000 seconds)
function buildFullWave() {
  const rows = [];
  rows.push('# Tsunami Boundary Wave Condition for City Simulation (Phase 2)');
  rows.push('# Location: 大阪港沖 (大阪湾) (Lon: 135.35, Lat: 34.60)');
  rows.push('# Mode: Full Timeline (From earthquake origin t=0 to 2.5 hours)');
  rows.push('# Original Absolute First Arrival: 6480.0 s (1:48:00 after earthquake)');
  rows.push('# Original Absolute Max Surge: 5.40 m (at 7560.0 s = 2:06:00 after earthquake)');
  rows.push('# Time Offset: 0.0 s');
  rows.push('Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg,Time_since_EQ_sec,Time_since_EQ_hms');

  const dt = 5.0; // 5-second intervals
  const totalSec = 9000; // 150 minutes

  for (let t = 0; t <= totalSec; t += dt) {
    let eta = 0;
    let speed = 0;

    if (t < 3600) {
      // First 60 min: tiny precursors
      const tau = t / 3600;
      eta = 0.15 * Math.sin(tau * Math.PI * 4);
      speed = 0.05;
    } else if (t < 6480) {
      // 60-108 min: gradual draw / small surge (+0.6m to -0.8m)
      const tau = (t - 3600) / 2880;
      eta = -0.5 * Math.sin(tau * Math.PI * 2);
      speed = 0.15;
    } else if (t < 7560) {
      // 108-126 min: First big surge to +5.40m!
      const tau = (t - 6480) / 1080;
      eta = -0.8 * (1 - tau) + 5.40 * Math.sin(tau * Math.PI * 0.5);
      speed = Math.max(0.2, (eta + 1.0) * 0.5);
    } else if (t < 8400) {
      // 126-140 min: drawdown to -2.0m
      const tau = (t - 7560) / 840;
      eta = 5.40 * (1 - tau) - 2.0 * Math.sin(tau * Math.PI * 0.5);
      speed = Math.abs(eta) * 0.4;
    } else {
      // 140-150 min: second surge rising to +3.8m
      const tau = (t - 8400) / 600;
      eta = -2.0 * (1 - tau) + 3.8 * Math.sin(tau * Math.PI * 0.5);
      speed = Math.max(0.15, (eta + 2.0) * 0.4);
    }

    const angleRad = (55 * Math.PI) / 180;
    const u = +(speed * Math.sin(angleRad)).toFixed(3);
    const v = +(speed * Math.cos(angleRad)).toFixed(3);

    rows.push(`${t.toFixed(1)},${eta.toFixed(3)},${u},${v},${speed.toFixed(3)},235.0,${t.toFixed(1)},${formatHms(t)}`);
  }

  const file = path.join(outDir, 'nankai_trough_osaka_full.csv');
  fs.writeFileSync(file, rows.join('\n'));
  console.log(`Saved ${file} (${rows.length} rows)`);
}

buildTrimmedWave();
buildFullWave();
