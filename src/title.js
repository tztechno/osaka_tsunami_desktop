// Title / loading screen (same structure as N65 nagoya_flood's title screen): contour lines of the city grid as a
// tilted floor, Osaka Castle alone at night with a tsunami bore rolling in from the bay — it breaks against the stone
// base, surges up the keep and drains away — the key numbers, a map of the simulation area, the scenarios, and
// the loading stages as a checklist. START floods the castle and fades into the app.
import * as THREE from 'three';
import { buildCastle } from './castle.js';

const STAGES = [
  { at: 0, ja: '計算範囲のデータ', en: 'Area data' },
  { at: 0.25, ja: '地形・建物', en: 'Terrain & buildings' },
  { at: 0.5, ja: '周辺地形', en: 'Surrounding terrain' },
  { at: 0.7, ja: '地名ラベル', en: 'Place labels' },
  { at: 0.85, ja: '津波計算エンジン', en: 'Tsunami solver' },
];

// water surface: a bore travelling along +x with an overshooting crest, swell behind it
const WATER_VERT = /* glsl */ `
uniform float uFront, uH, uW, uTime;
varying vec3 vW;
varying float vFoam;
float level(vec2 p) {
  float front = uFront + 0.9 * sin(p.y * 0.23 + 1.3) + 0.4 * sin(p.y * 0.61);
  float d = p.x - front;                                       // > 0: still ahead of the wave
  float body = uH * (1.0 - smoothstep(-uW, 0.0, d));
  float crest = uH * 0.65 * exp(-pow((d + uW * 0.28) / (uW * 0.2), 2.0));          // breaking crest
  float second = uH * 0.3 * exp(-pow((d + uW * 4.5) / (uW * 0.5), 2.0)) * step(0.05, uH); // the next wave behind
  float swell = 0.035 * sin(p.x * 1.3 - uTime * 2.0 + p.y * 0.7) + 0.025 * sin(p.y * 2.1 + uTime * 1.6);
  vFoam = exp(-pow((d + uW * 0.3) / (uW * 0.4), 2.0)) * step(0.05, uH) + 0.35 * (1.0 - smoothstep(0.0, 7.0, -d)) * step(d, 0.0) * step(0.05, uH);
  return body + crest + second + swell * (0.6 + body);
}
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  w.y = level(w.xz);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const WATER_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vW;
varying float vFoam;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (n.y < 0.0) n = -n;
  vec3 deep = vec3(0.015, 0.07, 0.15), lit = vec3(0.07, 0.28, 0.42);
  vec3 c = mix(deep, lit, clamp(vW.y * 0.5 + 0.35, 0.0, 1.0));
  // moonlight glint and the warm castle floodlights on the water
  vec3 v = normalize(cameraPosition - vW), m = normalize(vec3(-0.5, 0.8, -0.4));
  c += vec3(0.55, 0.68, 1.0) * pow(max(dot(reflect(-m, n), v), 0.0), 60.0) * 0.8;
  c += vec3(1.0, 0.75, 0.45) * 0.22 * exp(-length(vW.xz) / 3.0);
  // foam on the breaking crest and the churned water behind it
  float fn = 0.6 * vnoise(vW.xz * vec2(3.0, 1.4) + vec2(uTime * 1.5, 0.0)) + 0.4 * vnoise(vW.xz * 7.0 - uTime);
  float foam = clamp(vFoam * (0.3 + 0.95 * fn), 0.0, 1.0);
  c = mix(c, vec3(0.86, 0.93, 0.98), foam * 0.85);
  gl_FragColor = vec4(c, 0.96);
}`;

export class TitleScreen {
  /**
   * opts: { lang: () => 'ja' | 'en', setLang: (lang) => void, scenarios: [{ id, name, name_en, text, text_en }],
   *         current: () => scenario id, onScenario: (id) => void }
   */
  constructor(opts) {
    this.opts = opts;
    this.frac = 0;
    this.label = '';
    this.onGo = null;
    this.flood = 0; // START: extra rise
    this.root = document.createElement('div');
    this.root.id = 'title';
    document.body.appendChild(this.root);
    this.render();
    this.initScene();
    addEventListener('keydown', this.onKey, true);
  }

  L(ja, en) { return this.opts.lang() === 'en' ? en : ja; }

  /** (Re)build the text parts in the current language. */
  render() {
    const keep = ['canvas.city', 'canvas.floor'].map((q) => this.root.querySelector(q)).filter(Boolean);
    const cur = this.opts.current();
    const stats = [
      ['24×21.6', 'km', this.L('大阪市全域を計算', 'all of Osaka City')],
      ['15', 'm', this.L('全域の格子', 'city-wide grid')],
      ['2', 'm', this.L('詳細タイル・全建物', 'detail tile, all bldgs')],
      ['3', this.L('門', ''), this.L('三大水門', 'major floodgates')],
    ];
    this.root.innerHTML = `
      <div class="vignette"></div><div class="bar-top"></div>
      <div class="code"><span>PLATEAU · OSAKA CITY 2025</span><span>${this.L('浅水長波 · GPU · three.js', 'shallow water · GPU · three.js')}</span><span>34.69N 135.50E</span></div>
      <div class="head">
        <div class="round">${this.L('シナリオ · 大阪 · 南海トラフ', 'SCENARIO · OSAKA · NANKAI TROUGH')}</div>
        <h1>Osaka<span class="outline">Tsunami</span></h1>
        <div class="tag">${this.L('その波は、どこまで来るのか。', 'How far will the wave come?')}</div>
        <div class="stats">${stats.map(([v, u, s]) => `<div class="stat"><b>${v}<small>${u}</small></b><span>${s}</span></div>`).join('')}</div>
      </div>
      <div class="side">
        <div class="mapbox"><div class="cap">${this.L('計算エリア · 大阪市全域 24 × 21.6 km', 'AREA · ALL OF OSAKA CITY 24 × 21.6 KM')}</div><canvas class="map"></canvas></div>
        <div class="regions"><div class="cap">${this.L('シナリオ · クリックで開始', 'SCENARIOS · CLICK TO START')}</div><ol>${this.opts.scenarios.map((s, k) => `
          <li data-id="${s.id}" class="${s.id === cur ? 'cur' : ''}"><span class="no">${k + 1}</span><span class="nm">${this.L(s.name, s.name_en)}</span><span class="tx">${this.L(s.text, s.text_en)}</span></li>`).join('')}</ol></div>
      </div>
      <div class="bottom">
        <div class="check">
          <div class="cap">${this.L('準備', 'LOADING')}</div>
          <ol>${STAGES.map((s) => `<li><i></i>${this.L(s.ja, s.en)}</li>`).join('')}</ol>
          <div class="meter"><div></div></div><div class="status"></div>
        </div>
        <button class="go" hidden><span>${this.L('開 始', 'START')}</span><small>${this.L('START · Enter', 'Enter')}</small></button>
        <div class="keys"><button class="lang">${this.opts.lang() === 'en' ? '日本語' : 'English'}</button><br>Enter ${this.L('開始', 'start')} · ${this.L('ダブルクリック 注目点', 'double-click focus')} · WASD ${this.L('移動', 'move')}</div>
      </div>`;
    for (const c of keep.reverse()) this.root.prepend(c);
    this.root.querySelector('button.lang').onclick = (e) => {
      this.opts.setLang(this.opts.lang() === 'en' ? 'ja' : 'en');
      e.currentTarget.blur();
      this.render();
      this.drawMap();
    };
    this.root.querySelector('button.go').onclick = () => this.start();
    this.root.querySelectorAll('.regions li').forEach((li) => {
      li.onclick = () => {
        if (li.dataset.id !== this.opts.current()) this.opts.onScenario(li.dataset.id);
        this.root.querySelectorAll('.regions li').forEach((x) => x.classList.toggle('cur', x === li));
        if (this.onGo) this.start();
      };
    });
    this.progress(this.frac, this.label);
    if (this.onGo) this.showGo();
  }

  // ---------------------------------------------------------------- Osaka Castle and the tsunami
  initScene() {
    const canvas = document.createElement('canvas');
    canvas.className = 'city';
    this.root.prepend(canvas);
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    // the app's castle model (metres) scaled down, seen from the south-east; the wave comes from the bay (left)
    const SC = 0.08;
    const castle = buildCastle();
    castle.scale.setScalar(SC);
    castle.rotation.y = -Math.PI / 2;
    scene.add(castle);
    const top = castle.userData.height * SC;
    // night: cool sky light, a moon from behind, warm floodlights from below (ライトアップ)
    const hemi = new THREE.HemisphereLight(0x7d9ad6, 0x141a26, 0.65);
    const moon = new THREE.DirectionalLight(0xa9c2ff, 0.9);
    moon.position.set(-4, 7, -3);
    scene.add(hemi, moon);
    for (const [x, z, i] of [[2.5, 4.5, 60], [-3.2, 3.5, 38]]) {
      const spot = new THREE.SpotLight(0xfff0d2, i, 22, 0.55, 0.6, 1.4);
      spot.position.set(x, 0.3, z);
      spot.target.position.set(0, 2.4, 0);
      scene.add(spot, spot.target);
    }
    const goldGlow = new THREE.PointLight(0xffc04a, 4, 3);
    goldGlow.position.set(0, top - 0.3, 0.6);
    scene.add(goldGlow);
    // the sea / flood water
    this.waterU = { uFront: { value: -30 }, uH: { value: 0 }, uW: { value: 2.2 }, uTime: { value: 0 } };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(70, 44, 420, 220).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: this.waterU, transparent: true, side: THREE.DoubleSide,
    }));
    water.position.z = -4;
    water.frustumCulled = false;
    scene.add(water);
    // spray thrown up by the breaking crest
    const S = 2600, sp = new Float32Array(S * 3), vel = new Float32Array(S * 3), life = new Float32Array(S);
    const spray = new THREE.BufferGeometry();
    spray.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(spray, new THREE.PointsMaterial({ color: 0xdff2ff, size: 0.09, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })));

    const clock = new THREE.Clock();
    const ease = (x) => x * x * (3 - 2 * x);
    r.setAnimationLoop(() => {
      const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w && canvas.width !== Math.floor(w * r.getPixelRatio())) {
        r.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      // 30 s cycle: calm, the bore rolls in from the bay (left) and breaks over the stone base, the surge holds,
      // then drains away
      const c = t % 30;
      const surge = Math.min(top * 0.42, 1.8);
      let front = -34, H = 0;
      if (c >= 2 && c < 16) { front = -34 + 68 * ((c - 2) / 14); H = surge * Math.min(1, (c - 2) / 1.5); }
      else if (c >= 16 && c < 21) { front = 34; H = surge; }
      else if (c >= 21 && c < 28) { front = 34; H = surge * (1 - ease((c - 21) / 7)); }
      H = Math.min(top + 0.6, H + this.flood);
      if (this.flood > 0) front = Math.max(front, 30);
      const U = this.waterU;
      U.uFront.value = front; U.uH.value = H; U.uTime.value = t;
      // spray: respawn along the crest while the bore is on screen
      const crestOn = H > 0.05 && front > -24 && front < 24;
      for (let k = 0; k < S; k++) {
        life[k] -= dt;
        if (life[k] <= 0) {
          if (!crestOn) { sp[k * 3 + 1] = -5; continue; }
          const z = (Math.random() - 0.5) * 30 - 4;
          sp.set([front - 0.6 + Math.random() * 0.8, H * 1.55, z], k * 3);
          vel.set([2 + Math.random() * 3, 1.5 + Math.random() * 3.2, (Math.random() - 0.5) * 0.8], k * 3);
          life[k] = 0.5 + Math.random() * 0.9;
        }
        vel[k * 3 + 1] -= 6 * dt;
        for (let a = 0; a < 3; a++) sp[k * 3 + a] += vel[k * 3 + a] * dt;
      }
      spray.attributes.position.needsUpdate = true;
      // the camera stays above the water (it rises with the START flood), slow drift
      const camY = Math.max(2.4, H + 0.8);
      cam.position.set(3.4 + Math.sin(t * 0.17) * 0.3, camY + Math.sin(t * 0.11) * 0.08, 17.5);
      cam.lookAt(-0.6, Math.max(2.3, H - 0.2), 0);
      r.render(scene, cam);
    });
  }

  /** City grid contours as the tilted floor and the area map; called once the 15 m grid is loaded. */
  setRegion(meta, ground, aerialUrl) {
    this.meta = meta;
    const st = 8, nx = Math.floor(meta.nx / st), ny = Math.floor(meta.ny / st);
    this.small = { nx, ny, a: new Float32Array(nx * ny) };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) this.small.a[j * nx + i] = ground[j * st * meta.nx + i * st];
    let c = this.root.querySelector('canvas.floor');
    if (!c) { c = document.createElement('canvas'); c.className = 'floor'; this.root.prepend(c); }
    const W = 1400;
    c.width = W; c.height = Math.round((W * ny) / nx);
    contours(c.getContext('2d'), this.small.a, nx, ny, W / (nx - 1));
    this.preview = new Image();
    this.preview.onload = () => this.drawMap();
    this.preview.src = aerialUrl;
  }

  /** Aerial photo of the area with the castle and the three floodgates marked. */
  drawMap() {
    const m = this.meta, map = this.root.querySelector('canvas.map');
    if (!m || !map || !this.preview?.complete) return;
    const W = 360, H = Math.round((W * m.heightM) / m.widthM);
    map.width = W * 2; map.height = H * 2;
    const ctx = map.getContext('2d');
    ctx.scale(2, 2);
    ctx.filter = 'brightness(0.6) saturate(0.6) hue-rotate(185deg)';
    ctx.drawImage(this.preview, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.strokeStyle = 'rgba(57,198,255,.6)'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    const s = W / m.widthM;
    const mark = (x, z, color, label) => {
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x * s, z * s, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
      ctx.fillText(label, x * s + 6, z * s + 3);
    };
    for (const l of this.opts.labels?.() || []) {
      const gate = /水門/.test(l.name);
      if (l.name !== '大阪城' && !gate) continue;
      mark(l.x, l.z, gate ? '#39c6ff' : '#ffb000', this.L(l.name.replace('水門', ''), (l.name_en || '').replace(' Sluice Gate', '').replace('Osaka Castle', 'Castle')));
    }
  }

  /** The title owns the keyboard while it is up; Enter starts. */
  onKey = (e) => {
    if (!this.root.isConnected) return;
    e.stopImmediatePropagation();
    if (e.code === 'Enter' && this.onGo) { e.preventDefault(); this.start(); }
  };

  /** Loading progress (0..1) with the current step: ticks off the checklist. */
  progress(frac, label) {
    this.frac = frac; this.label = label;
    const cur = STAGES.reduce((k, s, i) => (frac >= s.at ? i : k), 0);
    this.root.querySelectorAll('.check li').forEach((li, i) => { li.className = frac >= 1 || i < cur ? 'done' : i === cur ? 'now' : ''; });
    const m = this.root.querySelector('.meter div');
    if (m) m.style.width = `${Math.round(frac * 100)}%`;
    const st = this.root.querySelector('.status');
    if (st) st.textContent = label;
  }

  ready(onGo) {
    this.onGo = onGo;
    this.progress(1, this.L('準備完了 — 開始できます', 'Ready — press START'));
    this.showGo();
  }

  showGo() {
    const b = this.root.querySelector('button.go');
    if (b) { b.hidden = false; b.focus(); }
  }

  failed(msg) {
    const st = this.root.querySelector('.status');
    st.textContent = msg; st.classList.add('err');
  }

  /** Flood the castle, then fade into the app. */
  start() {
    const onGo = this.onGo;
    if (!onGo) return;
    this.onGo = null;
    this.root.querySelector('button.go').hidden = true;
    this.progress(1, this.L('津波到達 — 街が沈みます', 'The wave arrives — the city goes under'));
    this.root.classList.add('launch');
    const t0 = performance.now();
    const rise = () => {
      const s = (performance.now() - t0) / 1000;
      this.flood = 2.6 * s * s;
      if (s < 1.3) requestAnimationFrame(rise);
    };
    requestAnimationFrame(rise);
    setTimeout(() => { this.root.classList.add('out'); onGo(); }, 1100);
    setTimeout(() => this.destroy(), 1900);
  }

  destroy() {
    removeEventListener('keydown', this.onKey, true);
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.root.remove();
  }
}

/** Marching-squares contours every 5 m (index lines every 20 m); T.P. 0 m (the zero-metre districts) in cyan. */
function contours(ctx, a, nx, ny, s) {
  let hmax = 0;
  for (const v of a) hmax = Math.max(hmax, v);
  const X = (i) => i * s, Y = (j) => j * s;
  const levels = [0];
  for (let lv = 5; lv < hmax; lv += 5) levels.push(lv);
  for (const lv of levels) {
    const major = lv % 20 === 0 && lv > 0, sea = lv === 0;
    ctx.strokeStyle = sea ? 'rgba(57,198,255,.6)' : major ? 'rgba(255,176,0,.45)' : 'rgba(110,140,220,.24)';
    ctx.lineWidth = sea || major ? 1.3 : 0.8;
    ctx.beginPath();
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const v0 = a[k], v1 = a[k + 1], v2 = a[k + nx + 1], v3 = a[k + nx];
      const c = (v0 > lv ? 1 : 0) | (v1 > lv ? 2 : 0) | (v2 > lv ? 4 : 0) | (v3 > lv ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const e = (p, q) => (lv - p) / (q - p);
      const pts = [];
      if ((c & 1) !== ((c >> 1) & 1)) pts.push([X(i + e(v0, v1)), Y(j)]);
      if (((c >> 1) & 1) !== ((c >> 2) & 1)) pts.push([X(i + 1), Y(j + e(v1, v2))]);
      if (((c >> 2) & 1) !== ((c >> 3) & 1)) pts.push([X(i + 1 - e(v2, v3)), Y(j + 1)]);
      if (((c >> 3) & 1) !== (c & 1)) pts.push([X(i), Y(j + 1 - e(v3, v0))]);
      for (let p = 0; p + 1 < pts.length; p += 2) { ctx.moveTo(pts[p][0], pts[p][1]); ctx.lineTo(pts[p + 1][0], pts[p + 1][1]); }
    }
    ctx.stroke();
  }
}
