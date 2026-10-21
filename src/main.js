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
const KEYFRAME_SEC = 30;
const RENDER_STEP = 2;
let timeline = null;
let computing = false;
let playT = 0; // simulated time being shown
let lastShownT = -1;
let lastTick = performance.now();
let playSpeed = 60; // simulated seconds per real second
let pin = null; // { vertex, elevation }
let pulseMode = false;
let recordAbortController = null;

async function init() {
  console.log('Initializing Osaka Tsunami 3D Simulator...');

  // 1. Fetch Region Metadata & Ground
  const metaRes = await fetch('data/regions/osaka_port/meta.json');
  meta = await metaRes.json();

  const groundBuf = await (await fetch('data/regions/osaka_port/ground.f32')).arrayBuffer();
  const ground = new Float32Array(groundBuf);

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

  // 5. Initialize Labels
  const labelsContainer = document.getElementById('labels-container');
  labelMgr = new LabelManager(labelsContainer, meta);
  await labelMgr.loadLabels();

  // 6. Initialize Depth Chart
  const chartCanvas = document.getElementById('depth-canvas');
  chart = new DepthChart(chartCanvas);

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

  // Apply default scenario
  await loadScenario(TSUNAMI_SCENARIOS.nankai_osaka_trimmed);

  // 8. Event Listeners
  setupEventListeners(canvas);

  // 9. Start Render Loop
  requestAnimationFrame(renderLoop);

  updateLanguageUI();
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
  if (m.stats) updateHud(m.stats, m.simTimeSec || 0);
  if (pin && timeline.frames.length) {
    const series = timeline.seriesAt(pin.vertex, m.simTimeSec);
    const cur = series.length ? series[series.length - 1].depth : 0;
    chart.setPoint({ gx: pin.vertex, gz: 0, elevation: pin.elevation, waterDepth: cur, maxDepth: Math.max(0, ...series.map((p) => p.depth)) });
    chart.history = series.map((p) => ({ timeSec: p.timeSec - timeline.start, depth: p.depth }));
    chart.draw();
  }
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

  const overtopEl = document.getElementById('hud-overtop');
  const overtopTag = document.getElementById('hud-overtop-tag');
  if (stats.isOvertopping) {
    overtopEl.textContent = 'OVERTOP';
    overtopEl.style.color = '#ff5252';
    overtopTag.textContent = `${stats.overtoppingCount}箇所越流`;
  } else {
    overtopEl.textContent = 'SAFE';
    overtopEl.style.color = '#10b981';
    overtopTag.textContent = seawallMgr.activePreset === 'sluice_open' ? '水門全開' : '防護中';
  }
}

/** Simulated span of a run: the whole CSV after its lead-in, or the scenario's duration. */
function runSpanSec() {
  if (activeProfile) return Math.max(600, activeProfile.tMax - profileStartSec);
  return (activeScenario.durationMin || 60) * 60;
}

function startCompute() {
  if (computing || timeline.frames.length) return;
  computing = true;
  simClient.compute(runSpanSec(), KEYFRAME_SEC);
  updateTimelineUi();
}

/** Settings changed: drop computed results; the worker is reset to the start state. */
function invalidateTimeline() {
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
  el.textContent = `✓ ${profile.name} (最大波高 ${profile.peakHeight.toFixed(2)}m, 継続 ${(profile.durationSec / 60).toFixed(0)}分) — ${startInfo}`;
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

  // Pulse mode checkbox
  const chkPulse = document.getElementById('chk-pulse-mode');
  chkPulse.addEventListener('change', (e) => {
    pulseMode = e.target.checked;
  });

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

  // Export CSV
  document.getElementById('btn-export-csv').addEventListener('click', async () => {
    const csvContent = await simClient.csv();
    if (!csvContent) return;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `osaka_tsunami_simulation_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Export MP4
  document.getElementById('btn-record-mp4').addEventListener('click', () => startMp4Recording());
  document.getElementById('btn-cancel-record').addEventListener('click', () => {
    if (recordAbortController) recordAbortController.abort();
  });

  // Point observation click & pulse click. A drag (orbit / pan) is not a click; a double-click
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
      if (pulseMode) {
        // a pulse changes the initial state: recompute from the start with it
        invalidateTimeline();
        simClient.reset();
        simClient.injectWave({ worldX, worldZ, height: 4.5, radius: 250 });
      } else {
        scene.setPin(worldX, worldZ);
        const { res } = meta;
        const vi = Math.min(timeline.wnx - 1, Math.floor(worldX / res / RENDER_STEP));
        const vj = Math.min(timeline.wny - 1, Math.floor(worldZ / res / RENDER_STEP));
        pin = { vertex: vj * timeline.wnx + vi, elevation: scene.getGroundAt(worldX, worldZ) };
        if (timeline.frames.length) showAt(playT);
      }
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

  // Clear pin
  document.getElementById('btn-clear-pin').addEventListener('click', () => {
    scene.clearPin();
    pin = null;
    chart.setPoint(null);
    chart.draw();
  });

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
      alert(`CSV読込エラー: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function updateLanguageUI() {
  const dict = I18N[currentLang];
  document.getElementById('btn-lang').textContent = currentLang === 'ja' ? 'English' : '日本語';
  document.getElementById('txt-app-title').textContent = dict.appTitle;
  document.getElementById('txt-app-subtitle').textContent = dict.appSubtitle;
  document.getElementById('txt-sec-scenario').textContent = dict.scenario;
  document.getElementById('txt-sec-seawall').textContent = dict.seawalls;
  document.getElementById('txt-sec-controls').textContent = dict.controls;
  setPlayButton();
  document.getElementById('btn-reset').textContent = currentLang === 'en' ? '⏮ Start' : '⏮ 先頭へ';
  document.getElementById('txt-label-speed').textContent = currentLang === 'en' ? 'Playback speed' : '再生速度';
  updateTimelineUi();
  document.getElementById('txt-sec-export').textContent = currentLang === 'en' ? 'Export' : 'データ・動画出力';

  document.getElementById('txt-chk-backdrop').textContent = dict.backdrop;
  document.getElementById('txt-sec-camera').textContent = dict.camera;
  document.getElementById('txt-controls-hint').textContent = dict.controlsHint;
  for (const [view, label] of Object.entries(dict.views)) {
    document.getElementById(`btn-view-${view}`).textContent = label;
  }

  labelMgr.setLanguage(currentLang);
}

const fmtClock = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const fmtHms = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

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
    [en ? 'Seawalls' : '水門・堤防', s.isOvertopping ? (en ? 'OVERTOPPING' : '越流発生') : (en ? 'holding' : '防護中')],
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
    ctx.fillStyle = n === lines.length - 1 && s.isOvertopping ? '#ff5252' : '#ffffff';
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
