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

let currentLang = 'ja';
let scene = null;
let seawallMgr = null;
let simClient = null;
let chart = null;
let labelMgr = null;
let meta = null;
let activeScenario = TSUNAMI_SCENARIOS.nankai_osaka_trimmed;
let isPlaying = false;
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
    renderStep: 2,
    onFrame: (m) => handleSimFrame(m),
  });

  // Apply default scenario
  await loadScenario(TSUNAMI_SCENARIOS.nankai_osaka_trimmed);

  // 8. Event Listeners
  setupEventListeners(canvas);

  // 9. Start Render Loop
  requestAnimationFrame(renderLoop);

  updateLanguageUI();
  console.log('Osaka Tsunami 3D Simulator ready.');
}

function handleSimFrame(m) {
  scene.updateFrame(m);

  const stats = m.stats;
  if (!stats) return;

  // Format time
  const totalSec = Math.floor(m.simTimeSec || 0);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  document.getElementById('hud-sim-time').textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

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

  // Update chart
  if (m.point) {
    chart.setPoint(m.point);
    chart.addSample(m.simTimeSec, m.point.waterDepth);
    chart.draw();
  }
}

async function loadScenario(sc) {
  activeScenario = sc;
  document.getElementById('scenario-desc').textContent = currentLang === 'en' ? sc.description_en : sc.description;

  if (sc.isCsvWave && sc.csvUrl) {
    try {
      const csvText = await (await fetch(sc.csvUrl)).text();
      const profile = WaveProfile.parse(csvText, sc.name);
      simClient.setWaveProfile(profile);
      showCsvInfo(profile);
    } catch (e) {
      console.warn('Failed to load preset CSV:', e);
      simClient.setScenario(sc);
    }
  } else {
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
  el.textContent = `✓ ${profile.name} (最大波高 ${profile.peakHeight.toFixed(2)}m, 継続 ${(profile.durationSec / 60).toFixed(0)}分)`;
}

function hideCsvInfo() {
  document.getElementById('csv-info').style.display = 'none';
}

function setupEventListeners(canvas) {
  // Play / Pause
  const btnPlay = document.getElementById('btn-play');
  btnPlay.addEventListener('click', () => {
    if (isPlaying) {
      simClient.pause();
      btnPlay.textContent = currentLang === 'en' ? '▶ Play' : '▶ 再生';
      btnPlay.classList.add('btn-primary');
      isPlaying = false;
    } else {
      simClient.play();
      btnPlay.textContent = currentLang === 'en' ? '⏸ Pause' : '⏸ 停止';
      btnPlay.classList.remove('btn-primary');
      isPlaying = true;
    }
  });

  // Reset
  document.getElementById('btn-reset').addEventListener('click', () => {
    simClient.reset();
    isPlaying = false;
    btnPlay.textContent = currentLang === 'en' ? '▶ Play' : '▶ 再生';
    btnPlay.classList.add('btn-primary');
    scene.clearPin();
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
    simClient.setBarriers(seawallMgr);
  });

  // Custom seawall slider
  const sliderSeawallH = document.getElementById('slider-seawall-h');
  sliderSeawallH.addEventListener('input', (e) => {
    const h = parseFloat(e.target.value);
    document.getElementById('val-seawall-h').textContent = `${h.toFixed(1)}m`;
    seawallMgr.setCustomHeight(h);
    simClient.setBarriers(seawallMgr);
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

    simClient.setCustomWave({ height, period, direction });
  };

  sliderCustomH.addEventListener('input', updateCustomWave);
  sliderCustomPeriod.addEventListener('input', updateCustomWave);
  sliderCustomDir.addEventListener('input', updateCustomWave);

  // Pulse mode checkbox
  const chkPulse = document.getElementById('chk-pulse-mode');
  chkPulse.addEventListener('change', (e) => {
    pulseMode = e.target.checked;
  });

  // Simulation speed
  const sliderSpeed = document.getElementById('slider-sim-speed');
  sliderSpeed.addEventListener('input', (e) => {
    const spd = parseFloat(e.target.value);
    document.getElementById('val-sim-speed').textContent = `${spd.toFixed(1)}x`;
  });

  // Label display toggle
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
        simClient.injectWave({ worldX, worldZ, height: 4.5, radius: 250 });
      } else {
        scene.setPin(worldX, worldZ);
        simClient.setPoint({ worldX, worldZ });
        chart.reset?.();
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
    simClient.setPoint(null);
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
  document.getElementById('btn-play').textContent = isPlaying ? (currentLang === 'en' ? '⏸ Pause' : '⏸ 停止') : (currentLang === 'en' ? '▶ Play' : '▶ 再生');
  document.getElementById('btn-reset').textContent = currentLang === 'en' ? '↺ Reset' : '↺ リセット';
  document.getElementById('txt-sec-export').textContent = currentLang === 'en' ? 'Export' : 'データ・動画出力';

  document.getElementById('txt-chk-backdrop').textContent = dict.backdrop;
  document.getElementById('txt-sec-camera').textContent = dict.camera;
  document.getElementById('txt-controls-hint').textContent = dict.controlsHint;
  for (const [view, label] of Object.entries(dict.views)) {
    document.getElementById(`btn-view-${view}`).textContent = label;
  }

  labelMgr.setLanguage(currentLang);
}

async function startMp4Recording() {
  const modal = document.getElementById('record-modal');
  const progressFill = document.getElementById('record-progress-fill');
  const statusTxt = document.getElementById('record-status');
  modal.style.display = 'flex';
  progressFill.style.width = '0%';

  recordAbortController = new AbortController();

  try {
    const result = await recordVideo({
      glCanvas: scene.canvas,
      width: 1280,
      height: 720,
      fps: 30,
      frames: 180, // 6 seconds video
      signal: recordAbortController.signal,
      renderFrame: async (i, u) => {
        // Step forward 10 seconds of simulation time per frame
        await simClient.advance(10.0);
        scene.render();
      },
      onProgress: (current, total) => {
        const pct = Math.round((current / total) * 100);
        progressFill.style.width = `${pct}%`;
        statusTxt.textContent = `フレーム処理中: ${current} / ${total} (${pct}%)`;
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
  if (scene) {
    scene.render();
    if (labelMgr) {
      labelMgr.update(scene.camera, window.innerWidth, window.innerHeight);
    }
  }
}

window.addEventListener('DOMContentLoaded', init);
