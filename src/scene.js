import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Water palette
const C_SEA_DEEP = new THREE.Color('#0a3150');
const C_SEA_RISE = new THREE.Color('#2f8fa6');
const C_SEA_LOW = new THREE.Color('#061c2e');
const C_FLOOD = new THREE.Color('#8c7a5a'); // Muddy overland flood water
const C_FLOOD_DEEP = new THREE.Color('#4f4636');
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
    this.sourceZoneGroup = null;

    this.showHazardColors = false;
    this.showMaxDepth = false;
    // Display-only vertical exaggeration of the open-water level (sea / rivers), so metre-scale
    // tsunami waves are visible across the 16 km bay; land inundation is drawn at true depth
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
      overview: [V(-9000, 9000, 11000), V(500, 0, 0)],
      port: [V(-4200, 1300, 3600), V(-1500, 0, 600)],
      gates: [V(1500, 900, 2600), V(3300, 0, -700)],
      city: [V(3500, 1100, 3500), V(5500, 0, -1500)],
      region: [V(-25000, 26000, 32000), V(2000, 0, -2000)],
      top: [V(0, 19000, 1), V(0, 0, 0)],
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

    const mat = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.6,
      metalness: 0.2,
    });

    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const { originE, originN, res, nx, ny, widthM, heightM } = this.meta;

    this.bldgPositions = [];
    this.bldgColors = new Float32Array(count * 3);

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

      // Default light urban concrete color
      mesh.setColorAt(k, new THREE.Color(0xd0d5dd));
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

  setupSourceZone() {
    if (this.sourceZoneGroup) {
      this.scene.remove(this.sourceZoneGroup);
    }

    const group = new THREE.Group();
    const posX = -this.W / 2 + 1500;
    const posZ = this.H / 2 - 1500;

    const boxGeom = new THREE.BoxGeometry(2500, 30, 2500);
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0xff1744,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
    });
    const box = new THREE.Mesh(boxGeom, boxMat);
    box.position.set(posX, 15, posZ);
    group.add(box);

    const arrowDir = new THREE.Vector3(1, 0, -1).normalize();
    const arrow = new THREE.ArrowHelper(arrowDir, new THREE.Vector3(posX - 800, 50, posZ + 800), 1600, 0x00e5ff, 400, 150);
    group.add(arrow);

    const buoyGeom = new THREE.CylinderGeometry(25, 35, 30, 16);
    const buoyMat = new THREE.MeshStandardMaterial({ color: 0xff9100, roughness: 0.3 });
    const buoy = new THREE.Mesh(buoyGeom, buoyMat);
    buoy.position.set(posX, 15, posZ);
    group.add(buoy);

    this.sourceZoneGroup = group;
    this.scene.add(group);
  }

  updateFrame(m) {
    if (!this.waterMesh || !m.frame || !this.ground) return;

    const { eta, depth, maxDepth, foam, bldgWet } = m.frame;
    const { wnx, wny, renderStep: step } = this;
    const { nx, ny } = this.meta;

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

        // If water depth is negligible (dry ground or not yet flooded)
        if (d < 0.05) {
          // Hide vertex safely 2m beneath local ground elevation!
          pos[vertY] = zb - 2.0;
          col[colIdx] = C_FLOOD.r;
          col[colIdx + 1] = C_FLOOD.g;
          col[colIdx + 2] = C_FLOOD.b;
          continue;
        }

        // Active water surface: elevate to eta
        const openWater = this.waterMask ? this.waterMask[groundIdx] === 1 : zb < 0;
        pos[vertY] = openWater ? eta[idx] * this.waterExaggeration : eta[idx];

        const onLand = this.waterMask ? this.waterMask[groundIdx] === 0 : zb >= 0;
        if (this.showHazardColors && onLand) {
          const matched = DEPTH_LEGEND.find(l => d < l.max);
          c.set(matched ? matched.color : '#dc7adc');
        } else if (onLand) {
          // Muddy overland flood water
          c.lerpColors(C_FLOOD, C_FLOOD_DEEP, Math.min(1.0, d / 5.0));
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

        // Foam / turbulent bore highlight
        const f = (foam[idx] || 0) / 255;
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
      const dryCol = new THREE.Color(0xd0d5dd); // Dry building concrete

      for (let k = 0; k < bldgWet.length; k++) {
        const isWet = bldgWet[k] === 1;
        this.buildingsMesh.setColorAt(k, isWet ? wetCol : dryCol);
      }
      this.buildingsMesh.instanceColor.needsUpdate = true;
    }
  }

  setHazardColors(enabled) {
    this.showHazardColors = enabled;
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
  }
}
