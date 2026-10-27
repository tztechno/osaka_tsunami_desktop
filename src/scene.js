import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildCastle } from './castle.js';
import { buildTsutenkaku } from './tsutenkaku.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';

// Water palette
const C_SEA_DEEP = new THREE.Color('#0a3150');
const C_SEA_RISE = new THREE.Color('#2f8fa6');
const C_SEA_LOW = new THREE.Color('#061c2e');
const C_FOAM = new THREE.Color('#f2f6f5');

export const DEPTH_LEGEND = [
  { max: 0.3, color: '#ffffb3', label: '〜0.3m' },
  { max: 0.5, color: '#f7f5a9', label: '0.3〜0.5m' },
  { max: 1.0, color: '#f8e1a6', label: '0.5〜1m' },
  { max: 3.0, color: '#ffd8c0', label: '1〜3m' },
  { max: 5.0, color: '#ffb7b7', label: '3〜5m' },
  { max: 10.0, color: '#ff9191', label: '5〜10m' },
  { max: 20.0, color: '#f285c9', label: '10〜20m' },
  { max: Infinity, color: '#dc7adc', label: '20m〜' },
];
// Overland water is drawn in the legend colours (same as the bottom-left legend)
const DEPTH_COLORS = DEPTH_LEGEND.map((l) => ({ max: l.max, color: new THREE.Color(l.color) }));
const C_DRY = DEPTH_COLORS[0].color;

/**
 * Indexed grid mesh in the XZ plane: vertex (i, j) at (xAt(i), heightAt(k), zAt(j)), k = j * nx + i,
 * with UV (uAt(i), vAt(j)). Row j = 0 is the north edge (smallest z).
 */
function gridGeometry(nx, ny, xAt, zAt, heightAt, uAt, vAt) {
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = xAt(i);
      pos[k * 3 + 1] = heightAt(k);
      pos[k * 3 + 2] = zAt(j);
      uv[k * 2] = uAt(i);
      uv[k * 2 + 1] = vAt(j);
    }
  }
  const index = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index[n++] = a; index[n++] = c; index[n++] = b;
      index[n++] = b; index[n++] = c; index[n++] = d;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  geom.computeVertexNormals();
  return geom;
}

export class TsunamiScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d1b2a');
    this.scene.fog = new THREE.FogExp2('#0d1b2a', 0.000018);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 1, 200000);
    // Initial camera overlooking Osaka Port & City from South-West (looking towards downtown)
    this.camera.position.set(-3000, 2800, 6000);

    this.setupLights();
    this.setupControls();

    this.groundMesh = null;
    this.outerMesh = null;
    this.outer = null;
    this.waterMask = null;
    this.waterMesh = null;
    this.buildingsMesh = null;
    this.pinMesh = null;
    this.areaLines = null;
    this.sourceZoneGroup = null;

    this.showMaxDepth = false;
    // Display-only vertical exaggeration of the open-water level (sea / rivers), so metre-scale
    // tsunami waves are visible across the bay; land inundation is drawn at true depth
    this.waterExaggeration = 5;
    this.buildingFocus = { enabled: false, radius: 3000, x: 0, z: 0 };
    this.viewLocked = false;
    this.fly = null;

    // Rotation-centre marker shown after a double-click
    this.focusMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.85, depthTest: false })
    );
    this.focusMarker.renderOrder = 10;
    this.focusMarker.visible = false;
    this.scene.add(this.focusMarker);
  }

  setupLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfffaed, 1.3);
    sun.position.set(-6000, 12000, 8000);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1000;
    sun.shadow.camera.far = 40000;
    const d = 12000;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    this.scene.add(sun);
    this.sun = sun;
  }

  /**
   * Free camera: left-drag = rotate, right-drag = pan along the ground, wheel = zoom toward cursor,
   * W/A/S/D = move, Q/E = down/up, Shift = faster; double-click (main.js) re-centres via flyTo().
   */
  setupControls() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.maxPolarAngle = Math.PI * 0.497; // keep the view above the horizon
    controls.minDistance = 5;
    controls.maxDistance = 90000;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.target.set(0, 0, 0);
    this.controls = controls;
    this.target = controls.target;

    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      if (/INPUT|SELECT|TEXTAREA/.test(e.target?.tagName)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.lastFrameTime = performance.now();
  }

  applyKeyboard(dt) {
    if (this.keys.size === 0 || this.viewLocked) return;
    const dist = this.camera.position.distanceTo(this.target);
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = Math.max(30, dist * 0.6) * (fast ? 3 : 1) * dt;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwd);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwd);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);
    this.camera.position.add(move);
    this.target.add(move);
  }

  /** Double-click: fly so that `p` becomes the centre of rotation / zoom. */
  flyTo(p, maxDist = 1500, seconds = 0.9) {
    const off = this.camera.position.clone().sub(this.target);
    off.setLength(Math.min(off.length(), maxDist));
    this.animateCameraTo(p.clone().add(off), p, seconds);
    this.focusMarker.visible = true;
  }

  animateCameraTo(pos, target, seconds = 1.2) {
    this.fly = { t: 0, dur: seconds, fromT: this.target.clone(), toT: target.clone(), fromC: this.camera.position.clone(), toC: pos.clone() };
  }

  /** Camera presets (scene coordinates: x = east, z = south, region centred on the origin). */
  setCameraView(type) {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const views = {
      overview: [V(-14000, 14000, 17000), V(0, 0, 0)],
      port: [V(-8200, 1300, 5800), V(-5500, 0, 2800)],
      gates: [V(-2500, 900, 4800), V(-700, 0, 1500)],
      city: [V(-500, 1100, 5700), V(1500, 0, 700)],
      region: [V(-29000, 30000, 36000), V(-2000, 0, 0)],
      top: [V(0, 30000, 1), V(0, 0, 0)],
    };
    const v = views[type];
    if (v) this.animateCameraTo(v[0], v[1]);
  }

  setViewLocked(locked) {
    this.viewLocked = locked;
    this.controls.enabled = !locked;
  }

  /** Terrain height at scene (x, z): simulation grid inside, surrounding backdrop outside. */
  surfaceAt(x, z) {
    if (this.meta && this.ground) {
      const { nx, ny, res } = this.meta;
      const i = Math.floor((x + this.W / 2) / res);
      const j = Math.floor((z + this.H / 2) / res);
      if (i >= 0 && j >= 0 && i < nx && j < ny) {
        const k = j * nx + i;
        return this.waterMask?.[k] ? 0 : this.ground[k];
      }
    }
    const o = this.outer;
    if (o) {
      const i = Math.floor((x - o.offX) / o.res);
      const j = Math.floor((z - o.offZ) / o.res);
      if (i >= 0 && j >= 0 && i < o.nx && j < o.ny) return Math.max(0, o.ground[j * o.nx + i]);
    }
    return 0;
  }

  /** Ray-march from the camera to the terrain / water surface (no triangle raycast over 4M faces). */
  pickSurface(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    let prev = 0;
    for (let s = 0; s < this.camera.far; s += 5 * (1 + s / 1500)) {
      if (o.y + d.y * s <= this.surfaceAt(o.x + d.x * s, o.z + d.z * s)) {
        let a = prev, b = s;
        for (let k = 0; k < 24; k++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m <= this.surfaceAt(o.x + d.x * m, o.z + d.z * m)) b = m;
          else a = m;
        }
        return new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
      }
      if (o.y + d.y * s < -100) break;
      prev = s;
    }
    return null;
  }

  /** Keep the camera at least `clearance` m above the ground. */
  clampCamera(clearance = 3) {
    const c = this.camera.position;
    const g = this.surfaceAt(c.x, c.z) + clearance;
    if (c.y < g) c.y = g;
  }

  async loadRegion(meta, ground, aerialUrl, seawallMgr, buildings = [], waterMask = null) {
    this.meta = meta;
    this.ground = ground;
    this.waterMask = waterMask;
    this.buildings = buildings;

    const { nx, ny, res, widthM, heightM } = meta;
    this.W = widthM;
    this.H = heightM;

    // 1. Build Ground Terrain Mesh
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      this.groundMesh.material.dispose();
    }

    // One vertex per cell centre so the terrain lines up exactly with the simulation grid
    const geom = gridGeometry(nx, ny, (i) => (i + 0.5) * res - widthM / 2, (j) => (j + 0.5) * res - heightM / 2,
      (k) => ground[k], (i) => (i + 0.5) / nx, (j) => 1 - (j + 0.5) / ny);

    const texLoader = new THREE.TextureLoader();
    const aerialTex = await new Promise((resolve) => {
      texLoader.load(aerialUrl, resolve, undefined, () => resolve(null));
    });

    if (aerialTex) {
      aerialTex.colorSpace = THREE.SRGBColorSpace;
      aerialTex.anisotropy = 8;
    }

    const groundMat = new THREE.MeshStandardMaterial({
      map: aerialTex || null,
      color: aerialTex ? 0xffffff : 0x224433,
      roughness: 0.85,
      metalness: 0.05,
    });

    this.groundMesh = new THREE.Mesh(geom, groundMat);
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    // 2. Add Seawalls / Gates
    if (seawallMgr && seawallMgr.meshGroup) {
      this.scene.add(seawallMgr.meshGroup);
      this.seawallMgr = seawallMgr;
    }

    // 3. Build Buildings InstancedMesh
    this.buildBuildingsMesh(buildings, ground);

    // 4. Create Water Surface Mesh
    this.createWaterMesh(nx, ny, res, widthM, heightM);

    // 5. Setup Source Zone 3D Visualizer
    this.setupSourceZone();

    this.setCameraView('overview');
  }

  /**
   * Surrounding terrain (osaka.tif + aerial) around the simulation region. Vertices sit on the
   * outer grid's cell corners; the region's edges fall on outer grid lines, and the vertices
   * strictly inside the region are sunk below the sea bed so the detailed region shows through.
   */
  async buildOuterBackdrop(outerMeta, outerGround, outerSea, aerialUrl) {
    if (this.outerMesh) {
      this.scene.remove(this.outerMesh);
      this.outerMesh.geometry.dispose();
      this.outerMesh.material.map?.dispose();
      this.outerMesh.material.dispose();
    }
    const { nx, ny, res } = outerMeta;
    const offX = outerMeta.originE - this.meta.originE - this.W / 2;
    const offZ = this.meta.originN - outerMeta.originN - this.H / 2;
    this.outer = { nx, ny, res, offX, offZ, ground: outerGround };

    const cell = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i);
    const geom = gridGeometry(nx + 1, ny + 1, (i) => offX + i * res, (j) => offZ + j * res, (k) => {
      const i = k % (nx + 1), j = Math.floor(k / (nx + 1));
      const x = offX + i * res, z = offZ + j * res;
      if (x > -this.W / 2 + 1 && x < this.W / 2 - 1 && z > -this.H / 2 + 1 && z < this.H / 2 - 1) return -60;
      let sum = 0, n = 0;
      for (const c of [cell(i - 1, j - 1), cell(i, j - 1), cell(i - 1, j), cell(i, j)]) {
        if (c < 0 || outerSea[c]) continue;
        sum += outerGround[c];
        n++;
      }
      return n ? sum / n : -0.3; // sea: flat, just under the simulated water surface
    }, (i) => i / nx, (j) => 1 - j / ny);

    const tex = await new Promise((resolve) => new THREE.TextureLoader().load(aerialUrl, resolve, undefined, () => resolve(null)));
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
    }
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x3a4a3a, roughness: 0.95, metalness: 0 });
    this.outerMesh = new THREE.Mesh(geom, mat);
    this.outerMesh.receiveShadow = false;
    this.scene.add(this.outerMesh);
  }

  buildBuildingsMesh(buildings, ground) {
    if (this.buildingsMesh) {
      this.scene.remove(this.buildingsMesh);
      this.buildingsMesh.geometry.dispose();
      this.buildingsMesh.material.dispose();
      this.buildingsMesh = null;
    }

    if (!buildings || buildings.length === 0) return;

    const count = buildings.length;
    const geom = new THREE.BoxGeometry(1, 1, 1);
    // Anchor box bottom at y = 0
    geom.translate(0, 0.5, 0);

    // matte, lit by the sun: walls facing different ways get different shades and roofs are the brightest
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });

    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const { originE, originN, res, nx, ny, widthM, heightM } = this.meta;

    this.bldgPositions = [];
    // per-building grey (±6 %, as in nagoya_flood) so that overlapping buildings keep visible outlines
    this.bldgBase = [];

    for (let k = 0; k < count; k++) {
      const b = buildings[k];
      // World coordinates centered in region (-W/2 to +W/2, -H/2 to +H/2)
      const wx = b.x - widthM / 2;
      const wz = b.z - heightM / 2;

      // Sample ground elevation
      const gx = Math.min(nx - 1, Math.max(0, Math.floor(b.x / res)));
      const gy = Math.min(ny - 1, Math.max(0, Math.floor(b.z / res)));
      const groundH = ground[gy * nx + gx] || 0;

      dummy.position.set(wx, groundH, wz);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();

      mesh.setMatrixAt(k, dummy.matrix);
      this.bldgPositions.push({ x: wx, z: wz, h: b.h, groundH });

      const v = 0.80 + (Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1) * 0.12;
      const base = new THREE.Color(v, v * 0.995, v * 0.98);
      this.bldgBase.push(base);
      mesh.setColorAt(k, base);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.buildingsMesh = mesh;
    this.scene.add(mesh);
  }

  createWaterMesh(nx, ny, res, widthM, heightM) {
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      this.waterMesh.material.dispose();
    }

    const step = 2;
    const wnx = Math.floor(nx / step);
    const wny = Math.floor(ny / step);
    this.wnx = wnx;
    this.wny = wny;
    this.renderStep = step;

    // vertex (i, j) sits on the centre of the sampled simulation cell (i * step, j * step)
    const geom = gridGeometry(wnx, wny, (i) => (i * step + 0.5) * res - widthM / 2, (j) => (j * step + 0.5) * res - heightM / 2,
      () => 0, (i) => i / (wnx - 1), (j) => 1 - j / (wny - 1));

    const vertCount = wnx * wny;
    const colors = new Float32Array(vertCount * 3);
    for (let k = 0; k < vertCount; k++) {
      colors[k * 3] = C_SEA_DEEP.r;
      colors[k * 3 + 1] = C_SEA_DEEP.g;
      colors[k * 3 + 2] = C_SEA_DEEP.b;
    }
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geom.attributes.color.setUsage(THREE.DynamicDrawUsage);

    const waterMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.25,
      metalness: 0.15,
      transparent: true,
      opacity: 0.90,
      side: THREE.DoubleSide,
    });

    this.waterMesh = new THREE.Mesh(geom, waterMat);
    this.waterMesh.position.y = 0.05;
    this.scene.add(this.waterMesh);
  }

  /**
   * Wave-source marker: a buoy at the source's sampling point (region-local worldX / worldZ, clamped
   * into the region; default the south-west corner of the bay) and an arrow along the direction the
   * wave travels (directionDeg = bearing it comes from). Drawn at a constant on-screen size.
   */
  setupSourceZone({ worldX = 1500, worldZ = this.H - 1500, directionDeg = 235 } = {}) {
    if (this.sourceZoneGroup) {
      this.scene.remove(this.sourceZoneGroup);
    }

    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.6, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff1744, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false })
    );
    ring.renderOrder = 9;
    group.add(ring);

    const th = (directionDeg * Math.PI) / 180;
    const arrowDir = new THREE.Vector3(-Math.sin(th), 0, Math.cos(th)); // +x east, +z south
    const arrow = new THREE.ArrowHelper(arrowDir, new THREE.Vector3(0, 0.5, 0), 4, 0x00e5ff, 1.2, 0.6);
    group.add(arrow);

    const buoyMat = new THREE.MeshStandardMaterial({ color: 0xff9100, roughness: 0.3, emissive: 0x552200 });
    const buoy = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 0.6, 16).translate(0, 0.3, 0), buoyMat);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 8).translate(0, 1.4, 0), buoyMat);
    group.add(buoy, mast);

    const m = Math.min(500, this.W / 4);
    const x = Math.max(m, Math.min(this.W - m, worldX)) - this.W / 2;
    const z = Math.max(m, Math.min(this.H - m, worldZ)) - this.H / 2;
    group.position.set(x, 2, z);
    this.sourceZoneGroup = group;
    this.scene.add(group);
  }

  updateFrame(m) {
    if (!this.waterMesh || !m.frame || !this.ground) return;

    const { eta, depth, maxDepth, foam, bldgWet } = m.frame;
    const { wnx, wny, renderStep: step } = this;
    const { nx, ny } = this.meta;

    if (!this.hideY) {
      // lowest ground within one render step of each vertex, minus 2 m
      this.hideY = new Float32Array(wnx * wny);
      for (let j = 0; j < wny; j++) for (let i = 0; i < wnx; i++) {
        let m = Infinity;
        for (let y = Math.max(0, j * step - step); y <= Math.min(ny - 1, j * step + step); y++) {
          for (let x = Math.max(0, i * step - step); x <= Math.min(nx - 1, i * step + step); x++) m = Math.min(m, this.ground[y * nx + x]);
        }
        this.hideY[j * wnx + i] = m - 2;
      }
    }
    if (!this.nearOpenWater && this.waterMask) {
      // render vertices on land next to an open-water vertex
      this.nearOpenWater = new Uint8Array(wnx * wny);
      const isW = (i, j) => i >= 0 && j >= 0 && i < wnx && j < wny && this.waterMask[Math.min(ny - 1, j * step) * nx + Math.min(nx - 1, i * step)] === 1;
      for (let j = 0; j < wny; j++) for (let i = 0; i < wnx; i++) {
        if (isW(i, j)) continue;
        if (isW(i - 1, j) || isW(i + 1, j) || isW(i, j - 1) || isW(i, j + 1) || isW(i - 1, j - 1) || isW(i + 1, j + 1) || isW(i - 1, j + 1) || isW(i + 1, j - 1)) this.nearOpenWater[j * wnx + i] = 1;
      }
    }
    const pos = this.waterMesh.geometry.attributes.position.array;
    const col = this.waterMesh.geometry.attributes.color.array;
    const c = new THREE.Color();

    for (let j = 0; j < wny; j++) {
      const sy = Math.min(ny - 1, j * step);
      for (let i = 0; i < wnx; i++) {
        const sx = Math.min(nx - 1, i * step);
        const idx = j * wnx + i;
        const groundIdx = sy * nx + sx;
        const zb = this.ground[groundIdx];
        const d = depth[idx];
        const vertY = idx * 3 + 1;
        const colIdx = idx * 3;

        // If water depth is negligible (dry ground or not yet flooded), or a detail tile draws it
        if (d < 0.05 || this.detailHide?.[idx]) {
          // Hide the vertex 2 m below the lowest ground around it (moats and slopes between the 30 m vertices
          // must not show the hidden surface). Its colour bleeds into the triangles at the water's edge: sea
          // colour next to the open water, the shallowest legend colour elsewhere
          pos[vertY] = this.hideY[idx];
          const dry = this.nearOpenWater?.[idx] ? C_SEA_DEEP : C_DRY;
          col[colIdx] = dry.r;
          col[colIdx + 1] = dry.g;
          col[colIdx + 2] = dry.b;
          continue;
        }

        // Active water surface: elevate to eta
        const openWater = this.waterMask ? this.waterMask[groundIdx] === 1 : zb < 0;
        pos[vertY] = openWater ? eta[idx] * this.waterExaggeration : eta[idx];

        const onLand = this.waterMask ? this.waterMask[groundIdx] === 0 : zb >= 0;
        if (onLand) {
          c.copy(DEPTH_COLORS.find((l) => d < l.max).color);
        } else {
          // Ocean water: deep blue to bright cyan-blue on surge
          const anomaly = eta[idx];
          // saturate at +2 m / -1.5 m so that metre-scale waves in the bay are clearly visible
          if (anomaly >= 0) {
            c.lerpColors(C_SEA_DEEP, C_SEA_RISE, Math.min(1.0, anomaly / 2.0));
          } else {
            c.lerpColors(C_SEA_DEEP, C_SEA_LOW, Math.min(1.0, -anomaly / 1.5));
          }
        }

        // Foam / turbulent bore highlight, on open water only so land keeps the legend colours
        const f = onLand ? 0 : (foam[idx] || 0) / 255;
        if (f > 0.15) {
          c.lerp(C_FOAM, Math.min(1.0, f * 1.2));
        }

        col[colIdx] = c.r;
        col[colIdx + 1] = c.g;
        col[colIdx + 2] = c.b;
      }
    }

    // Finite-difference normals over the downsampled grid for realistic water reflection
    const nrm = this.waterMesh.geometry.attributes.normal.array;
    const inv2 = 1.0 / (2.0 * step * this.meta.res);
    for (let j = 0; j < wny; j++) {
      const j0 = Math.max(0, j - 1) * wnx;
      const j1 = Math.min(wny - 1, j + 1) * wnx;
      for (let i = 0; i < wnx; i++) {
        const idx = j * wnx + i;
        if (depth[idx] < 0.05) {
          nrm[idx * 3] = 0;
          nrm[idx * 3 + 1] = 1;
          nrm[idx * 3 + 2] = 0;
          continue;
        }
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(wnx - 1, i + 1);
        const dyX = (pos[(j * wnx + i1) * 3 + 1] - pos[(j * wnx + i0) * 3 + 1]) * inv2;
        const dyZ = (pos[(j1 + i) * 3 + 1] - pos[(j0 + i) * 3 + 1]) * inv2;
        const len = Math.hypot(-dyX, 1, -dyZ);
        nrm[idx * 3] = -dyX / len;
        nrm[idx * 3 + 1] = 1 / len;
        nrm[idx * 3 + 2] = -dyZ / len;
      }
    }

    this.waterMesh.geometry.attributes.position.needsUpdate = true;
    this.waterMesh.geometry.attributes.color.needsUpdate = true;
    this.waterMesh.geometry.attributes.normal.needsUpdate = true;

    // Update building warning colors on inundation
    if (this.buildingsMesh && bldgWet && this.buildingsMesh.instanceColor) {
      const wetCol = new THREE.Color(0xff4444); // Flooded building red

      for (let k = 0; k < bldgWet.length; k++) {
        const isWet = bldgWet[k] === 1;
        this.buildingsMesh.setColorAt(k, isWet ? wetCol : this.bldgBase[k]);
      }
      this.buildingsMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Detailed Osaka Castle keep at its PLATEAU position (spec = public/data/castle.json); the plain building
   * blocks within its stone base are no longer drawn (they stay in the flow solver as obstacles).
   */
  addCastle(spec) {
    const k = spec.keep;
    this.addLandmarkModel(buildCastle(), k.E - this.meta.originE, this.meta.originN - k.N, k.base, k.rot);
  }

  /** Tsutenkaku at region-local (x, z), standing on the ground there. */
  addTsutenkaku(x, z, rotDeg = 0) {
    this.addLandmarkModel(buildTsutenkaku(), x, z, this.getGroundAt(x, z), rotDeg);
  }

  /**
   * A detailed landmark model at region-local (x, z), its foot at height y, turned rotDeg counter-clockwise from
   * east in plan; the plain building blocks within its radius are no longer drawn.
   */
  addLandmarkModel(object, x, z, y, rotDeg) {
    object.position.set(x - this.W / 2, y, z - this.H / 2);
    object.rotation.y = (rotDeg * Math.PI) / 180;
    this.scene.add(object);
    const model = { object, x, z, radius: object.userData.radius };
    (this.landmarkModels ||= []).push(model);
    const mesh = this.buildingsMesh;
    if (mesh) {
      mesh.userData.orig ||= mesh.instanceMatrix.array.slice();
      for (let i = 0; i < mesh.count; i++) {
        const o = mesh.userData.orig;
        const bx = o[i * 16 + 12] + this.W / 2, bz = o[i * 16 + 14] + this.H / 2;
        if (Math.hypot(bx - x, bz - z) > model.radius) continue;
        o.fill(0, i * 16, i * 16 + 16);
        mesh.instanceMatrix.array.fill(0, i * 16, i * 16 + 16);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Is region-local (x, z) under a detailed landmark model (where it replaces the building blocks)? */
  onLandmarkModel(x, z) {
    return (this.landmarkModels || []).some((m) => Math.hypot(x - m.x, z - m.z) <= m.radius);
  }

  /**
   * Rectangle covered by a 2 m detail tile (region-local metres { x0, z0, x1, z1 }, or null): the 15 m
   * buildings, shore walls, water and ground inside it are hidden so the tile's own drawing shows.
   */
  setDetailRect(rect) {
    this.detailRect = rect;
    const inside = (x, z) => rect && x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
    const hideInstances = (mesh, posOf) => {
      if (!mesh) return;
      mesh.userData.orig ||= mesh.instanceMatrix.array.slice();
      const arr = mesh.instanceMatrix.array, orig = mesh.userData.orig;
      for (let k = 0; k < mesh.count; k++) {
        const [x, z] = posOf(k, orig);
        if (inside(x, z)) arr.fill(0, k * 16, k * 16 + 16);
        else arr.set(orig.subarray(k * 16, k * 16 + 16), k * 16);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    // instance translation is at matrix elements 12 / 14 (scene coordinates)
    const fromMatrix = (k, orig) => [orig[k * 16 + 12] + this.W / 2, orig[k * 16 + 14] + this.H / 2];
    hideInstances(this.buildingsMesh, fromMatrix);
    hideInstances(this.seawallMgr?.perimeterMesh, fromMatrix);
    if (this.groundMesh) {
      const pos = this.groundMesh.geometry.attributes.position;
      this.groundMesh.userData.origY ||= Float32Array.from({ length: pos.count }, (_, k) => pos.getY(k));
      const origY = this.groundMesh.userData.origY;
      for (let k = 0; k < pos.count; k++) {
        pos.setY(k, inside(pos.getX(k) + this.W / 2, pos.getZ(k) + this.H / 2) ? origY[k] - 40 : origY[k]);
      }
      pos.needsUpdate = true;
    }
    // water vertices inside the tile (render grid) stay hidden in updateFrame
    const { wnx, wny, renderStep: step } = this;
    const res = this.meta.res;
    this.detailHide = rect ? new Uint8Array(wnx * wny) : null;
    if (rect) for (let j = 0; j < wny; j++) for (let i = 0; i < wnx; i++) {
      if (inside((i * step + 0.5) * res, (j * step + 0.5) * res)) this.detailHide[j * wnx + i] = 1;
    }
  }

  setMaxDepthView(enabled) {
    this.showMaxDepth = enabled;
  }

  /** Observation pin at region-local (worldX, worldZ); drawn at a constant on-screen size. */
  setPin(worldX, worldZ) {
    if (!this.pinMesh) {
      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xff1744, roughness: 0.3, metalness: 0.2, emissive: 0x550010 });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 16).rotateX(Math.PI).translate(0, 0.6, 0), mat);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12).translate(0, 1.45, 0), mat);
      group.add(cone, head);
      this.pinMesh = group;
      this.scene.add(group);
    }
    const x = worldX - this.W / 2;
    const z = worldZ - this.H / 2;
    this.pinMesh.position.set(x, this.surfaceAt(x, z), z);
    this.pinMesh.visible = true;
  }

  clearPin() {
    if (this.pinMesh) this.pinMesh.visible = false;
  }

  /**
   * Extent of a town-level address, drawn like nagoya_flood: a red outline over everything and a faint
   * red tint on the ground inside. rings: [[worldX, worldZ, ...], ...] in region-local metres; null clears it.
   */
  setArea(rings) {
    if (this.areaLines) {
      for (const l of this.areaLines) { this.scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
      this.areaLines = null;
    }
    this.tintGround(rings);
    if (!rings) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    this.areaLines = rings.map((r) => {
      const pos = [];
      const n = r.length / 2;
      for (let i = 0; i <= n; i++) {
        const x0 = r[(i % n) * 2] - this.W / 2, z0 = r[(i % n) * 2 + 1] - this.H / 2;
        const x1 = r[((i + 1) % n) * 2] - this.W / 2, z1 = r[((i + 1) % n) * 2 + 1] - this.H / 2;
        const steps = i === n ? 1 : Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 10)); // draped every ~10 m
        for (let s = 0; s < steps; s++) {
          const t = s / steps, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
          pos.push(x, this.surfaceAt(x, z) + 1, z);
        }
      }
      const g = new LineGeometry();
      g.setPositions(pos);
      const m = new LineMaterial({ color: 0xd7263d, linewidth: 1.5, transparent: true, opacity: 0.9, depthTest: false });
      m.resolution.copy(size);
      const l = new Line2(g, m);
      l.computeLineDistances();
      l.renderOrder = 11;
      l.frustumCulled = false;
      this.scene.add(l);
      return l;
    });
  }

  /** Faint red tint on the ground cells inside the rings (even-odd, so holes stay clear); null clears it. */
  tintGround(rings) {
    if (!this.groundMesh) return;
    const { nx, ny, res } = this.meta;
    const geom = this.groundMesh.geometry;
    let col = geom.attributes.color;
    if (!col) {
      if (!rings) return;
      col = new THREE.Float32BufferAttribute(new Float32Array(nx * ny * 3).fill(1), 3);
      geom.setAttribute('color', col);
      this.groundMesh.material.vertexColors = true;
      this.groundMesh.material.needsUpdate = true;
    }
    const c = col.array;
    c.fill(1);
    if (rings) {
      for (let j = 0; j < ny; j++) {
        const zc = (j + 0.5) * res;
        const xs = [];
        for (const r of rings) {
          const n = r.length / 2;
          for (let i = 0, k = n - 1; i < n; k = i++) {
            const z1 = r[k * 2 + 1], z2 = r[i * 2 + 1];
            if ((z1 <= zc && z2 > zc) || (z2 <= zc && z1 > zc)) xs.push(r[k * 2] + ((zc - z1) / (z2 - z1)) * (r[i * 2] - r[k * 2]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil(xs[q] / res - 0.5)), i1 = Math.min(nx - 1, Math.floor(xs[q + 1] / res - 0.5));
          for (let i = i0; i <= i1; i++) { const k = (j * nx + i) * 3; c[k + 1] = 0.8; c[k + 2] = 0.82; }
        }
      }
    }
    col.needsUpdate = true;
  }

  getGroundAt(worldX, worldZ) {
    if (!this.meta || !this.ground) return 0;
    const { nx, ny, res } = this.meta;
    const gx = Math.min(nx - 1, Math.max(0, Math.floor(worldX / res)));
    const gy = Math.min(ny - 1, Math.max(0, Math.floor(worldZ / res)));
    return this.ground[gy * nx + gx] || 0;
  }

  /** Interactive frame: keyboard, fly animation, controls, ground clearance, marker sizes. */
  render() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.applyKeyboard(dt);
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t * f.t * (3 - 2 * f.t);
      this.target.lerpVectors(f.fromT, f.toT, e);
      this.camera.position.lerpVectors(f.fromC, f.toC, e);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.clampCamera();
    if (this.sourceZoneGroup) {
      this.sourceZoneGroup.scale.setScalar(Math.max(20, this.camera.position.distanceTo(this.sourceZoneGroup.position) * 0.02));
    }
    if (this.pinMesh?.visible) {
      this.pinMesh.scale.setScalar(Math.max(4, this.camera.position.distanceTo(this.pinMesh.position) * 0.03));
    }
    if (this.focusMarker.visible) {
      this.focusMarker.position.copy(this.target);
      this.focusMarker.scale.setScalar(Math.max(1, this.camera.position.distanceTo(this.target) * 0.005));
    }
    this.renderer.render(this.scene, this.camera);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    for (const l of this.areaLines || []) l.material.resolution.set(w, h);
  }
}
