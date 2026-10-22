import * as THREE from 'three';
import { TsunamiScene } from './scene.js';
import { SeawallManager } from './seawall.js';
import { SimClient } from './simClient.js';
import { DepthChart } from './chart.js';
import { LabelManager } from './labels.js';
import { TSUNAMI_SCENARIOS } from './scenarios.js';
import { WaveProfile } from './waveProfile.js';
import { I18N } from './i18n.js';
import { recordVideo } from './recorder.js';
import { Timeline } from './timeline.js';
import { searchPlaces } from './geocode.js';
import { toLonLat } from './proj.js';
import { TileController } from './tile/tileController.js';
import { TitleScreen } from './title.js';

// Title screen: once per browser tab / app launch, or with ?title=1 (the 表紙 button)
const TITLE_KEY = 'osaka-tsunami-title-seen';
function wantTitle() {
  if (new URLSearchParams(location.search).get('title') === '1') return true;
  try { return !sessionStorage.getItem(TITLE_KEY); } catch { return true; }
}
// one line per scenario for the title screen
const TITLE_SCENARIO_TEXT = {
  nankai_osaka_trimmed: ['内閣府ケース③ · 大阪湾 最大2.04m（地震後2:10）', 'CAO case 3 · Osaka Bay max 2.04 m (EQ +2:10)'],
  nankai_osaka_full: ['同じ計算を地震発生から3時間まで', 'The same run, 0-3 h after the quake'],
  extreme_megathrust: ['沖合4.5m · 防潮堤を越える想定超過の津波', '4.5 m offshore · overtops the seawalls'],
  ansei_nankai_1854: ['1854年型 · 川を遡る津波（水門全開）', '1854 type · run-up into the rivers (gates open)'],
  custom: ['波高1〜100m・周期・来襲方向を自由に設定', 'Height 1-100 m, period and direction of your choice'],
};

let currentLang = 'ja';
let scene = null;
let seawallMgr = null;
let simClient = null;
let chart = null;
let labelMgr = null;
let meta = null;
let activeScenario = TSUNAMI_SCENARIOS.nankai_osaka_trimmed;
// CSV wave source in use (null for parametric waves): the run starts at its lead-in time and the
// clock shows time since that start, plus time since the earthquake from the CSV's offset
let activeProfile = null;
let profileStartSec = 0;
let isPlaying = false;
// Computed-ahead playback: the run is computed once, then played / scrubbed from keyframes
// (every 30 s; every 60 s for runs over 90 min, which keeps a 4 h run's keyframes near 400 MB)
const keyframeSec = (span) => (span > 5400 ? 60 : 30);
const RENDER_STEP = 2;
let timeline = null;
let computing = false;
let playT = 0; // simulated time being shown
let lastShownT = -1;
let lastTick = performance.now();
let playSpeed = 60; // simulated seconds per real second
let pin = null; // { vertex, elevation, title, x, z } or, for a town area, { vertices, ha, title, x, z, rings }
let tileCtl = null; // 2 m detail tile panel
let recordAbortController = null;

async function init() {
  console.log('Initializing Osaka Tsunami 3D Simulator...');
  const title = wantTitle() ? new TitleScreen({
    lang: () => currentLang,
    setLang: (lang) => { currentLang = lang; if (scene) updateLanguageUI(); },
    scenarios: Object.values(TSUNAMI_SCENARIOS).map((sc) => ({
      id: sc.id, name: sc.name, name_en: sc.name_en || sc.name,
      text: TITLE_SCENARIO_TEXT[sc.id]?.[0] || '', text_en: TITLE_SCENARIO_TEXT[sc.id]?.[1] || '',
    })),
    current: () => activeScenario.id,
    onScenario: (id) => {
      document.getElementById('select-scenario').value = id;
      loadScenario(TSUNAMI_SCENARIOS[id]);
    },
    labels: () => labelMgr?.labels || [],
  }) : null;
  const step = (f, ja, en) => title?.progress(f, currentLang === 'en' ? en : ja);
  step(0.02, '計算範囲のデータを読み込み中…', 'Loading the area data…');

  // 1. Fetch Region Metadata & Ground
  const metaRes = await fetch('data/regions/osaka_port/meta.json');
  meta = await metaRes.json();

  const groundBuf = await (await fetch('data/regions/osaka_port/ground.f32')).arrayBuffer();
  const ground = new Float32Array(groundBuf);
  title?.setRegion(meta, ground, 'data/regions/osaka_port/aerial.jpg');
  step(0.25, '地形・建物を読み込み中…', 'Loading terrain and buildings…');

  // 1b. Fetch Water Mask (Distinguishes open water from dry land / zero-meter districts)
  let waterMask = null;
  try {
    const waterBuf = await (await fetch('data/regions/osaka_port/water.u8')).arrayBuffer();
    waterMask = new Uint8Array(waterBuf);
  } catch (e) {
    console.warn('water.u8 not loaded, falling back to elevation-based mask:', e);
  }

  // 2. Fetch Buildings (footprints whose centre lies on a river / the sea are bridges or piers)
  let buildings = [];
  try {
    const bldRes = await fetch('data/regions/osaka_port/buildings.json');
    if (bldRes.ok) buildings = await bldRes.json();
  } catch (e) {
    console.warn('Buildings not loaded:', e);
  }
  if (waterMask) {
    const { nx, ny, res } = meta;
    buildings = buildings.filter((b) => {
      const i = Math.min(nx - 1, Math.max(0, Math.floor(b.x / res)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor(b.z / res)));
      return waterMask[j * nx + i] === 0;
    });
  }

  // 3. Initialize Seawall Manager
  seawallMgr = new SeawallManager(meta);
  await seawallMgr.loadSeawalls('osaka_port', ground, waterMask);

  // 4. Initialize 3D Scene
  const canvas = document.getElementById('gl-canvas');
  scene = new TsunamiScene(canvas);
  await scene.loadRegion(meta, ground, 'data/regions/osaka_port/aerial.jpg', seawallMgr, buildings, waterMask);

  // 4a. Detailed Osaka Castle keep in place of the PLATEAU block
  try {
    const castleSpec = await fetch('data/castle.json').then((r) => (r.ok ? r.json() : null));
    if (castleSpec) scene.addCastle(castleSpec);
  } catch (e) {
    console.warn('Castle not loaded:', e);
  }

  step(0.5, '周辺地形を読み込み中…', 'Loading the surrounding terrain…');
  // 4b. Surrounding terrain backdrop (osaka.tif + aerial): Osaka plain, Rokko, Ikoma
  try {
    const outerMetaRes = await fetch('data/regions/outer/meta.json');
    if (outerMetaRes.ok) {
      const outerMeta = await outerMetaRes.json();
      const [g, sea] = await Promise.all([
        fetch('data/regions/outer/ground.f32').then((r) => r.arrayBuffer()),
        fetch('data/regions/outer/sea.u8').then((r) => r.arrayBuffer()),
      ]);
      await scene.buildOuterBackdrop(outerMeta, new Float32Array(g), new Uint8Array(sea), 'data/regions/outer/aerial.jpg');
    }
  } catch (e) {
    console.warn('Backdrop terrain not loaded:', e);
  }

  step(0.7, '地名ラベルを読み込み中…', 'Loading place labels…');
  // 5. Initialize Labels
  const labelsContainer = document.getElementById('labels-container');
  labelMgr = new LabelManager(labelsContainer, meta);
  await labelMgr.loadLabels();

  // 6. Initialize Depth Chart
  const chartCanvas = document.getElementById('depth-canvas');
  chart = new DepthChart(chartCanvas);

  title?.drawMap(); // the castle and gate markers come from the labels
  step(0.85, '津波計算エンジンを準備中…', 'Starting the tsunami solver…');
  // 7. Initialize Simulation Client (Web Worker)
  simClient = new SimClient({
    meta,
    ground,
    waterMask,
    buildings,
    seawallMgr,
    renderStep: RENDER_STEP,
    onFrame: (m) => handleSimFrame(m),
    onKeyframe: (k) => handleKeyframe(k),
    onComputeDone: () => {
      timeline.done = true;
      computing = false;
      updateTimelineUi();
    },
  });
  timeline = new Timeline({ meta, ground, renderStep: RENDER_STEP });
  tileCtl = new TileController({
    scene, meta, ground, waterMask, seawallMgr,
    timeline: () => timeline,
    lang: () => currentLang,
    pin: () => pin,
    startCompute: () => startCompute(),
    onUpdate: () => { lastShownT = -1; if (timeline.frames.length) showAt(playT); },
  });

  // Apply default scenario
  await loadScenario(TSUNAMI_SCENARIOS.nankai_osaka_trimmed);

  // 8. Event Listeners
  setupEventListeners(canvas);

  // 9. Start Render Loop
  requestAnimationFrame(renderLoop);

  updateLanguageUI();
  title?.ready(() => {
    try { sessionStorage.setItem(TITLE_KEY, '1'); } catch { /* storage blocked */ }
    const q = new URLSearchParams(location.search);
    if (q.has('title')) { q.delete('title'); history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`); }
  });
  console.log('Osaka Tsunami 3D Simulator ready.');
}

let lastFrame = null; // latest { simTimeSec, stats } shown, for the video overlay

/** Live frames from the worker (initial state after a reset / scenario change). */
function handleSimFrame(m) {
  if (timeline.frames.length) return; // computed results take over the display
  applyDisplay(m);
}

function handleKeyframe(k) {
  const first = timeline.frames.length === 0;
  timeline.add(k);
  if (first) {
    playT = k.t;
    lastShownT = -1;
  }
  updateTimelineUi();
}

function applyDisplay(m) {
  lastFrame = m;
  scene.updateFrame(m);
  tileCtl?.showAt(m.simTimeSec);
  if (m.stats) updateHud(m.stats, m.simTimeSec || 0);
  if (pin && timeline.frames.length) {
    // the 2 m detail run where the pin / area lies on its tile, else the 15 m run
    const fine = tileCtl?.seriesFor(pin, m.simTimeSec);
    const series = fine || (pin.vertices ? timeline.seriesMaxAt(pin.vertices, m.simTimeSec) : timeline.seriesAt(pin.vertex, m.simTimeSec));
    const cur = series.length ? series[series.length - 1].depth : 0;
    const max = Math.max(0, ...series.map((p) => p.depth));
    const tag = fine ? '[2m] ' : '';
    const label = pin.vertices
      ? `${tag}範囲 ${pin.ha} ha | 範囲内(陸地)の最大水深: ${cur.toFixed(2)}m (最大: ${max.toFixed(2)}m)`
      : fine ? `${tag}標高: ${pin.elevation.toFixed(1)}m | 水深: ${cur.toFixed(2)}m (最大: ${max.toFixed(2)}m)` : null;
    chart.setPoint({ gx: pin.vertex ?? pin.vertices[0], gz: 0, elevation: pin.elevation ?? 0, waterDepth: cur, maxDepth: max, label });
    chart.history = series.map((p) => ({ timeSec: p.timeSec - timeline.start, depth: p.depth }));
    chart.draw();
  }
}

/** Observation pin at region-local (worldX, worldZ): marker plus the hydrograph of that cell. */
function placePin(worldX, worldZ, title = null) {
  scene.setArea(null);
  scene.setPin(worldX, worldZ);
  const { res } = meta;
  const vi = Math.min(timeline.wnx - 1, Math.floor(worldX / res / RENDER_STEP));
  const vj = Math.min(timeline.wny - 1, Math.floor(worldZ / res / RENDER_STEP));
  const [lon, lat] = toLonLat(meta.originE + worldX, meta.originN - worldZ);
  title ||= `N${lat.toFixed(5)} E${lon.toFixed(5)}`;
  pin = { vertex: vj * timeline.wnx + vi, elevation: scene.getGroundAt(worldX, worldZ), title, x: worldX, z: worldZ };
  if (timeline.frames.length) showAt(playT);
}

/** Town-level address: outline the town and chart the deepest water on land inside it. */
function placeArea(area, title) {
  scene.clearPin();
  scene.setArea(area.rings);
  const { res } = meta;
  const { wnx, wny } = timeline;
  const cell = RENDER_STEP * res;
  const vertices = [];
  // even-odd scanline over all rings (separate parts and holes) at the render-grid vertex centres
  for (let j = 0; j < wny; j++) {
    const zc = (j * RENDER_STEP + 0.5) * res;
    if (zc < area.bbox[1] || zc > area.bbox[3]) continue;
    const xs = [];
    for (const r of area.rings) {
      const n = r.length / 2;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const z1 = r[k * 2 + 1], z2 = r[i * 2 + 1];
        if ((z1 <= zc && z2 > zc) || (z2 <= zc && z1 > zc)) xs.push(r[k * 2] + ((zc - z1) / (z2 - z1)) * (r[i * 2] - r[k * 2]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - 0.5 * res) / cell)), i1 = Math.min(wnx - 1, Math.floor((xs[q + 1] - 0.5 * res) / cell));
      for (let i = i0; i <= i1; i++) {
        // land only: rivers and canals inside the town would otherwise read as "flooded" from the start
        if (scene.waterMask?.[j * RENDER_STEP * meta.nx + i * RENDER_STEP] === 1) continue;
        vertices.push(j * wnx + i);
      }
    }
  }
  if (!vertices.length) return;
  pin = { vertices, ha: (area.m2 / 1e4).toFixed(1), title, x: (area.bbox[0] + area.bbox[2]) / 2, z: (area.bbox[1] + area.bbox[3]) / 2, rings: area.rings };
  if (timeline.frames.length) showAt(playT);
}

function updateHud(stats, simTimeSec) {
  // Time since the run started, and time since the earthquake for CSV sources
  document.getElementById('hud-sim-time').textContent = fmtClock(simTimeSec - profileStartSec);
  const eqEl = document.getElementById('hud-eq-time');
  if (activeProfile) {
    const hms = fmtHms(simTimeSec + activeProfile.timeOffset);
    eqEl.textContent = currentLang === 'en' ? `EQ +${hms}` : `地震後 ${hms}`;
  } else {
    eqEl.textContent = '';
  }

  document.getElementById('hud-offshore-wave').textContent = stats.offshoreWaveHeight.toFixed(1);
  document.getElementById('hud-runup').textContent = stats.maxRunup.toFixed(1);
  document.getElementById('hud-area').textContent = stats.inundatedAreaHa.toFixed(1);
  document.getElementById('hud-bldgs').textContent = stats.inundatedBuildings.toLocaleString();
}

/**
 * Simulated span of a run: the chosen length (1-4 h from the start of the run), or by default the whole CSV
 * after its lead-in / the scenario's duration. Past the end of a CSV its last water level is held.
 */
function runSpanSec() {
  const chosen = +document.getElementById('select-duration').value;
  if (chosen) return chosen * 60;
  if (activeProfile) return Math.max(600, activeProfile.tMax - profileStartSec);
  return (activeScenario.durationMin || 60) * 60;
}

function startCompute() {
  if (computing || timeline.frames.length) return;
  computing = true;
  simClient.compute(runSpanSec(), keyframeSec(runSpanSec()));
  updateTimelineUi();
}

/** Settings changed: drop computed results; the worker is reset to the start state. */
function invalidateTimeline() {
  tileCtl?.clearRun();
  simClient.cancelCompute();
  timeline.clear();
  computing = false;
  isPlaying = false;
  playT = 0;
  lastShownT = -1;
  setPlayButton();
  updateTimelineUi();
}

function showAt(t) {
  if (!timeline.frames.length) return;
  playT = Math.max(timeline.start, Math.min(timeline.computedTo, t));
  applyDisplay(timeline.frameAt(playT));
  lastShownT = playT;
  updateTimelineUi();
}

function setPlayButton() {
  const btn = document.getElementById('btn-play');
  const en = currentLang === 'en';
  btn.textContent = isPlaying ? (en ? '⏸ Pause' : '⏸ 停止') : timeline?.frames.length ? (en ? '▶ Play' : '▶ 再生') : (en ? '▶ Compute & Play' : '▶ 計算・再生');
  btn.classList.toggle('btn-primary', !isPlaying);
}

function updateTimelineUi() {
  const en = currentLang === 'en';
  const has = timeline.frames.length > 0;
  const total = has ? Math.max(1, timeline.end - timeline.start) : runSpanSec();
  const slider = document.getElementById('slider-timeline');
  slider.max = String(Math.round(total));
  slider.value = String(Math.round(has ? playT - timeline.start : 0));
  slider.disabled = !has;
  document.getElementById('timeline-computed').style.width = `${(has ? timeline.progress : 0) * 100}%`;
  document.getElementById('txt-timeline').textContent = `${fmtClock(has ? playT - timeline.start : 0)} / ${fmtClock(total)}`;
  const status = document.getElementById('txt-compute-status');
  if (timeline.done) status.textContent = en ? 'computed' : '計算済み';
  else if (computing) status.textContent = `${en ? 'computing' : '計算中'} ${Math.round(timeline.progress * 100)}%`;
  else status.textContent = en ? 'not computed' : '未計算';
}

function setActiveProfile(profile) {
  activeProfile = profile;
  profileStartSec = profile ? profile.leadInSec() : 0;
}

async function loadScenario(sc) {
  invalidateTimeline();
  activeScenario = sc;
  document.getElementById('scenario-desc').textContent = currentLang === 'en' ? sc.description_en : sc.description;

  if (sc.isCsvWave && sc.csvUrl) {
    try {
      const csvText = await (await fetch(sc.csvUrl)).text();
      const profile = WaveProfile.parse(csvText, sc.name);
      setActiveProfile(profile);
      simClient.setWaveProfile(profile);
      showCsvInfo(profile);
    } catch (e) {
      console.warn('Failed to load preset CSV:', e);
      setActiveProfile(null);
      simClient.setScenario(sc);
    }
  } else {
    setActiveProfile(null);
    simClient.setScenario(sc);
    hideCsvInfo();
  }

  // Toggle custom controls
  const isCustom = sc.id === 'custom';
  document.getElementById('sec-custom-wave').style.display = isCustom ? 'flex' : 'none';
}

function showCsvInfo(profile) {
  const el = document.getElementById('csv-info');
  el.style.display = 'block';
  const fmt = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
  const lead = profile.leadInSec();
  const startInfo = currentLang === 'en'
    ? `starts at ${(lead / 60).toFixed(0)} min of the CSV (EQ +${fmt(lead + profile.timeOffset)}), skipping the quiet lead-in`
    : `CSVの ${(lead / 60).toFixed(0)}分目（地震後 ${fmt(lead + profile.timeOffset)}）から計算・静穏な導入部を省略`;
  // the run goes to the end of the CSV: say where that is, and warn when the highest water is right at the end
  // (the CSV probably stops before the main wave has passed Osaka Bay)
  const endEq = fmt(profile.tMax + profile.timeOffset);
  const late = profile.tMax - profile.peakTimeSec < 600;
  const endInfo = currentLang === 'en'
    ? ` / CSV ends at EQ +${endEq}${late ? ' — the highest water is at its very end; the CSV may stop before the wave has passed (use a longer nankai_trough output)' : ''}`
    : ` / CSVの終わり: 地震後 ${endEq}${late ? '（最大水位がCSVの終わり際です。波が通り過ぎる前にCSVが終わっている可能性があります。nankai_trough で長めに出力してください）' : ''}`;
  el.textContent = `✓ ${profile.name} (最大波高 ${profile.peakHeight.toFixed(2)}m, 継続 ${(profile.durationSec / 60).toFixed(0)}分) — ${startInfo}${endInfo}`;
}

function hideCsvInfo() {
  document.getElementById('csv-info').style.display = 'none';
}

function setupEventListeners(canvas) {
  // Play / Pause: the first press computes the whole run; playback follows the computed part
  document.getElementById('btn-play').addEventListener('click', () => {
    if (!timeline.frames.length && !computing) startCompute();
    if (!isPlaying && timeline.done && playT >= timeline.computedTo - 1e-3) showAt(timeline.start);
    isPlaying = !isPlaying;
    setPlayButton();
  });

  // Back to the start of the computed run
  document.getElementById('btn-reset').addEventListener('click', () => {
    isPlaying = false;
    setPlayButton();
    showAt(timeline.start);
  });

  // Timeline scrubbing / playback speed
  document.getElementById('slider-timeline').addEventListener('input', (e) => {
    showAt(timeline.start + parseFloat(e.target.value));
  });
  document.getElementById('select-duration').addEventListener('change', () => {
    invalidateTimeline();
    simClient.reset();
  });
  document.getElementById('select-play-speed').addEventListener('change', (e) => {
    playSpeed = parseFloat(e.target.value);
  });

  // Scenario select
  document.getElementById('select-scenario').addEventListener('change', (e) => {
    const sc = TSUNAMI_SCENARIOS[e.target.value];
    if (sc) loadScenario(sc);
  });

  // Seawall / Sluice Gate select
  const selectSeawall = document.getElementById('select-seawall');
  const customSeawallGroup = document.getElementById('custom-seawall-group');
  selectSeawall.addEventListener('change', (e) => {
    const val = e.target.value;
    customSeawallGroup.style.display = val === 'custom' ? 'flex' : 'none';
    seawallMgr.setPreset(val);
    invalidateTimeline();
    tileCtl.refreshSurface();
    scene.setDetailRect(scene.detailRect); // the wall boxes were rebuilt
    simClient.setBarriers(seawallMgr);
    simClient.reset();
  });

  // Custom seawall slider
  const sliderSeawallH = document.getElementById('slider-seawall-h');
  sliderSeawallH.addEventListener('input', (e) => {
    const h = parseFloat(e.target.value);
    document.getElementById('val-seawall-h').textContent = `${h.toFixed(1)}m`;
    seawallMgr.setCustomHeight(h);
    invalidateTimeline();
    tileCtl.refreshSurface();
    scene.setDetailRect(scene.detailRect);
    simClient.setBarriers(seawallMgr);
    simClient.reset();
  });

  // Custom wave sliders
  const sliderCustomH = document.getElementById('slider-custom-h');
  const sliderCustomPeriod = document.getElementById('slider-custom-period');
  const sliderCustomDir = document.getElementById('slider-custom-dir');

  const updateCustomWave = () => {
    const height = parseFloat(sliderCustomH.value);
    const period = parseFloat(sliderCustomPeriod.value) * 60;
    const direction = parseFloat(sliderCustomDir.value);

    document.getElementById('val-custom-h').textContent = `${height.toFixed(1)}m`;
    document.getElementById('val-custom-period').textContent = `${sliderCustomPeriod.value}分`;
    document.getElementById('val-custom-dir').textContent = `${direction}°`;

    setActiveProfile(null);
    invalidateTimeline();
    simClient.setCustomWave({ height, period, direction });
    simClient.reset();
  };

  sliderCustomH.addEventListener('input', updateCustomWave);
  sliderCustomPeriod.addEventListener('input', updateCustomWave);
  sliderCustomDir.addEventListener('input', updateCustomWave);

  // Label display toggle
  document.getElementById('chk-exaggerate').addEventListener('change', (e) => {
    scene.waterExaggeration = e.target.checked ? 5 : 1;
  });

  document.getElementById('chk-labels').addEventListener('change', (e) => {
    labelMgr.setVisible(e.target.checked);
  });

  // CSV Drag & Drop (memo.md requirement 6)
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('csv-file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleCsvFile(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleCsvFile(e.target.files[0]);
    }
  });

  // Export CSV: area-wide figures every 10 s of the computed run, on the HUD clocks
  document.getElementById('btn-export-csv').addEventListener('click', async () => {
    const rows = await simClient.history();
    if (!rows?.length) return;
    const en = currentLang === 'en';
    const header = [...clockHeader(), en ? 'Offshore wave (m)' : '沖合津波高 (m)', en ? 'Max run-up (m)' : '最大遡上高 (m)',
      en ? 'Inundated area (ha)' : '浸水面積 (ha)', en ? 'Flooded buildings' : '浸水建物 (棟)'];
    const body = rows.filter((r) => r.timeSec >= profileStartSec)
      .map((r) => [...clockCols(r.timeSec), r.waveHeight, r.maxRunup, r.areaHa, r.bldgs]);
    downloadCsv(`osaka_tsunami_result_${fileStamp()}.csv`, header, body);
  });

  // Hydrograph CSV of the pin / town area, from the computed keyframes
  document.getElementById('btn-pin-csv').addEventListener('click', () => {
    if (!pin || !timeline.frames.length) return;
    const en = currentLang === 'en';
    const series = pin.vertices ? timeline.seriesMaxAt(pin.vertices, Infinity) : timeline.seriesAt(pin.vertex, Infinity);
    const depthHead = pin.vertices ? (en ? 'Max depth on land in area (m)' : '範囲内(陸地)の最大水深 (m)') : (en ? 'Water depth (m)' : '水深 (m)');
    const header = [en ? 'Place' : '地点', ...clockHeader(), depthHead];
    const place = pin.vertices ? `${pin.title} (${pin.ha} ha)` : `${pin.title} (${en ? 'ground' : '標高'} ${pin.elevation.toFixed(1)} m)`;
    const body = series.filter((p) => p.timeSec >= profileStartSec).map((p) => [place, ...clockCols(p.timeSec), p.depth.toFixed(2)]);
    const safe = pin.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    downloadCsv(`osaka_tsunami_hydrograph_${safe}_${fileStamp()}.csv`, header, body);
  });

  // Export MP4
  document.getElementById('btn-record-mp4').addEventListener('click', () => startMp4Recording());
  document.getElementById('btn-cancel-record').addEventListener('click', () => {
    if (recordAbortController) recordAbortController.abort();
  });

  // Point observation click. A drag (orbit / pan) is not a click; a double-click
  // re-centres the view, so the single-click action waits until a second click is ruled out.
  const pick = (e) => {
    const rect = canvas.getBoundingClientRect();
    return scene.pickSurface(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  };
  let downAt = null;
  let clickTimer = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('click', (e) => {
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      const p = pick(e);
      if (!p) return;
      const worldX = p.x + meta.widthM / 2;
      const worldZ = p.z + meta.heightM / 2;
      if (worldX < 0 || worldZ < 0 || worldX >= meta.widthM || worldZ >= meta.heightM) return; // backdrop
      placePin(worldX, worldZ);
    }, 250);
  });
  canvas.addEventListener('dblclick', (e) => {
    clearTimeout(clickTimer);
    const p = pick(e);
    if (p) scene.flyTo(p);
  });

  // Camera presets / backdrop toggle
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => scene.setCameraView(btn.dataset.view));
  });
  document.getElementById('chk-backdrop').addEventListener('change', (e) => {
    if (scene.outerMesh) scene.outerMesh.visible = e.target.checked;
  });

  // Address / place search: pick a candidate to drop the pin there and fly to it
  const addrResults = document.getElementById('address-results');
  const addrMsg = (text) => { addrResults.innerHTML = ''; const p = document.createElement('div'); p.className = 'address-msg'; p.textContent = text; addrResults.appendChild(p); };
  document.getElementById('form-address').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('input-address').value.trim();
    if (!q) return;
    const dict = I18N[currentLang];
    addrMsg(dict.addressSearching);
    let hits, outside;
    try {
      ({ inside: hits, outside } = await searchPlaces(q, meta, labelMgr?.labels));
    } catch (err) {
      addrMsg(dict.addressFailed);
      return;
    }
    if (!hits.length && !outside.length) { addrMsg(dict.addressNone); return; }
    addrResults.innerHTML = '';
    for (const h of hits) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const kind = h.kind === 'area' ? (currentLang === 'en' ? ' (area)' : '（範囲）') : '';
      btn.textContent = `${currentLang === 'en' ? h.title_en : h.title}${kind}`;
      btn.addEventListener('click', () => {
        let x = h.worldX, z = h.worldZ, dist = 1500;
        if (h.kind === 'area') {
          const [x0, z0, x1, z1] = h.area.bbox;
          x = (x0 + x1) / 2; z = (z0 + z1) / 2;
          dist = Math.max(1500, Math.max(x1 - x0, z1 - z0) * 1.6);
          placeArea(h.area, h.title);
        } else {
          placePin(x, z, currentLang === 'en' ? h.title_en : h.title);
        }
        scene.flyTo(new THREE.Vector3(x - meta.widthM / 2, scene.getGroundAt(x, z), z - meta.heightM / 2), dist);
      });
      addrResults.appendChild(btn);
    }
    // Places outside the simulation area: no water is computed there, so no pin; the camera can still go
    for (const h of outside) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'outside';
      btn.textContent = `${h.title}${outsideNote(h.worldX, h.worldZ)}`;
      btn.addEventListener('click', () => scene.flyTo(new THREE.Vector3(h.worldX - meta.widthM / 2, 0, h.worldZ - meta.heightM / 2), 3000));
      addrResults.appendChild(btn);
    }
  });

  // Clear pin
  document.getElementById('btn-clear-pin').addEventListener('click', () => {
    scene.clearPin();
    scene.setArea(null);
    pin = null;
    chart.setPoint(null);
    chart.draw();
  });

  // Back to the title screen (reloads the app: computed results are dropped)
  document.getElementById('btn-title').addEventListener('click', () => { location.search = '?title=1'; });

  // Language switch
  document.getElementById('btn-lang').addEventListener('click', () => {
    currentLang = currentLang === 'ja' ? 'en' : 'ja';
    updateLanguageUI();
  });

  // Window resize
  window.addEventListener('resize', () => {
    scene.resize(window.innerWidth, window.innerHeight);
  });
  scene.resize(window.innerWidth, window.innerHeight);
}

function handleCsvFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const profile = WaveProfile.parse(text, file.name);
      invalidateTimeline();
      setActiveProfile(profile);
      simClient.setWaveProfile(profile);
      showCsvInfo(profile);
      document.getElementById('select-scenario').value = 'custom';
    } catch (err) {
      // shown in the panel: the desktop app's WebView does not show alert() dialogs
      const el = document.getElementById('csv-info');
      el.style.display = 'block';
      el.textContent = currentLang === 'en' ? `CSV read error: ${err.message}` : `CSV読込エラー: ${err.message}`;
    }
  };
  reader.readAsText(file);
}

function updateLanguageUI() {
  const dict = I18N[currentLang];
  document.getElementById('btn-lang').textContent = currentLang === 'ja' ? 'English' : '日本語';
  document.getElementById('btn-title').textContent = currentLang === 'ja' ? '表紙' : 'Title';
  document.getElementById('btn-title').title = currentLang === 'ja' ? '表紙を表示（計算結果は消えます）' : 'Show the title screen (results are cleared)';
  document.getElementById('txt-app-title').textContent = dict.appTitle;
  document.getElementById('txt-app-subtitle').textContent = dict.appSubtitle;
  document.getElementById('txt-sec-scenario').textContent = dict.scenario;
  document.getElementById('txt-sec-seawall').textContent = dict.seawalls;
  document.getElementById('txt-sec-controls').textContent = dict.controls;
  setPlayButton();
  document.getElementById('btn-reset').textContent = currentLang === 'en' ? '⏮ Start' : '⏮ 先頭へ';
  document.getElementById('txt-label-speed').textContent = currentLang === 'en' ? 'Playback speed' : '再生速度';
  document.getElementById('txt-label-duration').textContent = currentLang === 'en' ? 'Run length' : '計算時間';
  const durNames = currentLang === 'en'
    ? ['Scenario length (CSV to its end)', '1 hour', '2 hours', '3 hours', '4 hours']
    : ['シナリオの長さ（CSVは最後まで）', '1時間', '2時間', '3時間', '4時間'];
  [...document.getElementById('select-duration').options].forEach((o, i) => (o.textContent = durNames[i]));
  updateTimelineUi();
  document.getElementById('txt-sec-export').textContent = currentLang === 'en' ? 'Export' : 'データ・動画出力';

  document.getElementById('txt-chk-backdrop').textContent = dict.backdrop;
  document.getElementById('txt-sec-camera').textContent = dict.camera;
  document.getElementById('txt-controls-hint').textContent = dict.controlsHint;
  document.getElementById('txt-sec-address').textContent = dict.address;
  document.getElementById('input-address').placeholder = dict.addressPlaceholder;
  document.getElementById('btn-address-search').textContent = dict.addressSearch;
  document.getElementById('txt-address-hint').textContent = dict.addressHint;
  for (const [view, label] of Object.entries(dict.views)) {
    document.getElementById(`btn-view-${view}`).textContent = label;
  }

  labelMgr.setLanguage(currentLang);
  tileCtl?.updateTexts();
}

const fmtClock = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const fmtHms = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** "(計算範囲外・東へ約0.5km)": which way and how far a place lies outside the simulation area. */
function outsideNote(worldX, worldZ) {
  const en = currentLang === 'en';
  const dx = worldX < 0 ? worldX : Math.max(0, worldX - meta.widthM);
  const dz = worldZ < 0 ? worldZ : Math.max(0, worldZ - meta.heightM);
  const dir = [dz < 0 ? (en ? 'N' : '北') : dz > 0 ? (en ? 'S' : '南') : '', dx < 0 ? (en ? 'W' : '西') : dx > 0 ? (en ? 'E' : '東') : ''].join('');
  const km = (Math.hypot(dx, dz) / 1000).toFixed(1);
  return en ? ` (outside the simulation area, ${km} km ${dir})` : `（計算範囲外・${dir}へ約${km}km）`;
}

/** Clock columns matching the HUD: elapsed since the run start, and time since the quake for CSV sources. */
function clockHeader() {
  const en = currentLang === 'en';
  return [en ? 'Elapsed (s)' : '経過時間 (秒)', en ? 'Elapsed (mm:ss)' : '経過時間 (分:秒)', ...(activeProfile ? [en ? 'Since EQ (h:mm:ss)' : '地震後 (時:分:秒)'] : [])];
}
function clockCols(simTimeSec) {
  const el = simTimeSec - profileStartSec;
  return [Math.round(el), fmtClock(el), ...(activeProfile ? [fmtHms(simTimeSec + activeProfile.timeOffset)] : [])];
}

/** Save rows as UTF-8 (BOM, CRLF) CSV so Excel opens Japanese text correctly. */
function downloadCsv(name, header, rows) {
  const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const text = '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const fileStamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, '-');

/** Burned-in caption: scenario, clocks and the main meters at the moment of the frame. */
function drawVideoOverlay(ctx, w, h) {
  if (!lastFrame?.stats) return;
  const s = lastFrame.stats;
  const t = lastFrame.simTimeSec || 0;
  const en = currentLang === 'en';
  const sel = document.getElementById('select-scenario');
  const scenario = sel.options[sel.selectedIndex]?.text || '';
  const gates = document.getElementById('select-seawall');
  const gateText = gates.options[gates.selectedIndex]?.text || '';
  const lines = [
    [en ? 'Elapsed' : '経過時間', fmtClock(t - profileStartSec)],
    ...(activeProfile ? [[en ? 'Since EQ' : '地震後', fmtHms(t + activeProfile.timeOffset)]] : []),
    [en ? 'Offshore wave' : '沖合津波高', `${s.offshoreWaveHeight.toFixed(1)} m`],
    [en ? 'Max run-up' : '最大遡上高', `${s.maxRunup.toFixed(1)} m`],
    [en ? 'Inundated area' : '浸水面積', `${s.inundatedAreaHa.toFixed(1)} ha`],
    [en ? 'Flooded buildings' : '浸水建物', `${s.inundatedBuildings.toLocaleString()}`],
  ];
  const pad = 14, lh = 24, bw = 330, bh = pad * 2 + 22 + 18 + lines.length * lh + (scene.waterExaggeration > 1 ? 18 : 0);
  ctx.save();
  ctx.fillStyle = 'rgba(8, 18, 32, 0.78)';
  ctx.fillRect(16, 16, bw, bh);
  ctx.fillStyle = '#00e5ff';
  ctx.font = 'bold 15px Inter, "Hiragino Sans", sans-serif';
  ctx.fillText(en ? 'Osaka Tsunami 3D' : '大阪市津波 3Dシミュレーター', 16 + pad, 16 + pad + 14);
  ctx.fillStyle = '#90a4ae';
  ctx.font = '11px Inter, "Hiragino Sans", sans-serif';
  ctx.fillText(`${scenario.slice(0, 40)} / ${gateText.slice(0, 18)}`, 16 + pad, 16 + pad + 34);
  lines.forEach(([k, v], n) => {
    const y = 16 + pad + 62 + n * lh;
    ctx.fillStyle = '#b0bec5';
    ctx.font = '13px Inter, "Hiragino Sans", sans-serif';
    ctx.fillText(k, 16 + pad, y);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Inter, "Hiragino Sans", sans-serif';
    ctx.fillText(v, 16 + pad + 150, y);
  });
  if (scene.waterExaggeration > 1) {
    ctx.fillStyle = '#f59e0b';
    ctx.font = '11px Inter, "Hiragino Sans", sans-serif';
    ctx.fillText(en ? `Sea level drawn ×${scene.waterExaggeration} (display only)` : `海面の上下を${scene.waterExaggeration}倍に強調表示`, 16 + pad, 16 + bh - pad + 2);
  }
  ctx.restore();
}

/** Record the whole run: compute it first if needed, then render it from the keyframes. */
async function startMp4Recording() {
  const modal = document.getElementById('record-modal');
  const progressFill = document.getElementById('record-progress-fill');
  const statusTxt = document.getElementById('record-status');
  const en = currentLang === 'en';
  modal.style.display = 'flex';
  progressFill.style.width = '0%';
  isPlaying = false;
  setPlayButton();
  recordAbortController = new AbortController();
  const signal = recordAbortController.signal;

  try {
    if (!timeline.done) {
      startCompute();
      while (!timeline.done && !signal.aborted) {
        const pct = Math.round(timeline.progress * 100);
        progressFill.style.width = `${pct}%`;
        statusTxt.textContent = en ? `Computing the run: ${pct}%` : `全期間を計算中: ${pct}%（計算が終わると録画を始めます）`;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (signal.aborted) return;
    }

    const start = timeline.start;
    const span = timeline.computedTo - start;
    const result = await recordVideo({
      glCanvas: scene.canvas,
      width: 1280,
      height: 720,
      fps: 30,
      frames: 450, // 15 s for the whole run
      signal,
      renderFrame: async (i, u) => {
        showAt(start + span * u);
        scene.render();
      },
      drawOverlay: (ctx, i, u, w, h) => drawVideoOverlay(ctx, w, h),
      onProgress: (current, total) => {
        const pct = Math.round((current / total) * 100);
        progressFill.style.width = `${pct}%`;
        statusTxt.textContent = en
          ? `Recording ${current} / ${total} (${pct}%) — ${fmtClock(playT - start)} of ${fmtClock(span)}`
          : `録画中 ${current} / ${total} (${pct}%) — ${fmtClock(playT - start)} / ${fmtClock(span)}`;
      },
    });

    if (result && result.blob) {
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `osaka_tsunami_animation.${result.ext}`;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    console.error('Recording failed:', err);
  } finally {
    modal.style.display = 'none';
    recordAbortController = null;
  }
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  tileCtl?.tick();
  if (timeline?.frames.length) {
    if (isPlaying) {
      playT += dt * playSpeed;
      if (playT >= timeline.computedTo) {
        playT = timeline.computedTo; // wait at the computed edge, stop at the end of the run
        if (timeline.done) {
          isPlaying = false;
          setPlayButton();
        }
      }
    }
    if (playT !== lastShownT) showAt(playT);
  }
  if (scene) {
    scene.render();
    if (labelMgr) {
      labelMgr.update(scene.camera, window.innerWidth, window.innerHeight);
    }
  }
}

window.addEventListener('DOMContentLoaded', init);
