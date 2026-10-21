import * as THREE from 'three';

// Osaka port coastal seawall crest (seaward of the three gates) and the river parapets behind them
const COASTAL_WALL_H = 6.8;
const RIVER_WALL_H = 3.5;
const SHORE_COAST = 1;
const SHORE_RIVER = 2;

export class SeawallManager {
  constructor(regionMeta) {
    this.meta = regionMeta;
    this.seawallData = null;
    this.activePreset = 'sluice_closed'; // 'sluice_closed' | 'sluice_open' | 'no_seawall' | 'custom'
    this.customHeight = 7.0;
    this.meshGroup = new THREE.Group();
    this.seawallMeshes = new Map();

    // Simulation grid barrier elevation
    this.barrierGrid = new Float32Array(this.meta.nx * this.meta.ny);
    this.barrierActive = new Uint8Array(this.meta.nx * this.meta.ny);
    this.overtoppingPoints = [];
    this.ground = null;
    this.waterMask = null;
    this.perimeterMesh = null;
    this.shore = null; // per land cell: 0, SHORE_COAST or SHORE_RIVER
  }

  async loadSeawalls(regionName, ground = null, waterMask = null) {
    this.ground = ground;
    this.waterMask = waterMask;
    try {
      const res = await fetch(`data/regions/${regionName}/seawalls.json`);
      if (!res.ok) {
        console.warn('seawalls.json not found for', regionName);
        return;
      }
      this.seawallData = await res.json();
      this.classifyShore();
      this.rebuildMeshes();
      this.updateBarrierGrid();
    } catch (e) {
      console.error('Failed to load seawalls:', e);
    }
  }

  setPreset(preset, customHeight = 7.0) {
    this.activePreset = preset;
    this.customHeight = customHeight;
    this.rebuildMeshes();
    this.updateBarrierGrid();
  }

  setCustomHeight(height) {
    this.customHeight = height;
    if (this.activePreset !== 'custom') {
      this.activePreset = 'custom';
    }
    this.rebuildMeshes();
    this.updateBarrierGrid();
  }

  getActiveSeawallList() {
    if (!this.seawallData) return [];
    if (this.activePreset === 'no_seawall') return [];

    const list = Array.isArray(this.seawallData) ? this.seawallData : (this.seawallData.seawalls || []);

    return list.filter(sw => {
      if (this.activePreset === 'sluice_open') {
        // Gates are open, so exclude sluice_gate types from barrier
        return sw.type !== 'sluice_gate';
      }
      return true;
    });
  }

  rebuildMeshes() {
    while (this.meshGroup.children.length > 0) {
      const child = this.meshGroup.children[0];
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      this.meshGroup.remove(child);
    }
    this.seawallMeshes.clear();
    this.perimeterMesh = null;
    if (this.activePreset === 'no_seawall') return;

    for (const sw of this.getActiveSeawallList()) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : sw.designHeight;
      const mesh = this.createSeawallMesh(sw, targetH);
      if (mesh) {
        this.meshGroup.add(mesh);
        this.seawallMeshes.set(sw.id, { mesh, seawall: sw, height: targetH });
      }
    }

    const periMesh = this.createPerimeterMesh();
    if (periMesh) {
      this.meshGroup.add(periMesh);
      this.perimeterMesh = periMesh;
    }
  }

  /** Crest height of the shore wall on a coast (1) or inner-river (2) cell for the active preset. */
  shoreWallHeight(kind) {
    if (this.activePreset === 'no_seawall') return -999;
    if (this.activePreset === 'custom') return this.customHeight;
    return kind === SHORE_COAST ? COASTAL_WALL_H : RIVER_WALL_H;
  }

  /** Cells within halfW of every sluice-gate line (independent of the preset). */
  gateFootprint() {
    const { nx, ny } = this.meta;
    const mask = new Uint8Array(nx * ny);
    const list = Array.isArray(this.seawallData) ? this.seawallData : (this.seawallData?.seawalls || []);
    for (const sw of list) {
      if (sw.type !== 'sluice_gate') continue;
      this.rasterise(sw, (idx) => { mask[idx] = 1; });
    }
    return mask;
  }

  /**
   * Classify land cells along open water: SHORE_COAST borders water connected to the bay with all
   * gates closed (seaward of the gates), SHORE_RIVER borders the rivers behind the gates.
   */
  classifyShore() {
    const { nx, ny } = this.meta;
    const wm = this.waterMask;
    this.shore = new Uint8Array(nx * ny);
    if (!wm) return;
    const gate = this.gateFootprint();
    const outer = new Uint8Array(nx * ny);
    const stack = [];
    const seed = (k) => {
      if (wm[k] && !gate[k] && !outer[k]) { outer[k] = 1; stack.push(k); }
    };
    for (let j = 0; j < ny; j++) seed(j * nx);
    for (let i = 0; i < nx; i++) seed((ny - 1) * nx + i);
    while (stack.length) {
      const k = stack.pop();
      const i = k % nx;
      if (i > 0) seed(k - 1);
      if (i < nx - 1) seed(k + 1);
      if (k >= nx) seed(k - nx);
      if (k < (ny - 1) * nx) seed(k + nx);
    }
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const k = y * nx + x;
        if (wm[k]) continue;
        const nb = [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1];
        let kind = 0;
        for (const n of nb) {
          if (n < 0 || !wm[n] || gate[n]) continue;
          kind = outer[n] ? SHORE_COAST : Math.max(kind, SHORE_RIVER);
          if (kind === SHORE_COAST) break;
        }
        this.shore[k] = kind;
      }
    }
  }

  /** Shore walls as one instanced box per wall cell (top at the crest, bottom on the ground). */
  createPerimeterMesh() {
    if (!this.shore || !this.ground) return null;
    const { res, nx, ny, widthM, heightM } = this.meta;
    const cells = [];
    for (let k = 0; k < this.shore.length; k++) {
      const kind = this.shore[k];
      if (!kind) continue;
      const top = this.shoreWallHeight(kind);
      if (top > this.ground[k] + 0.2) cells.push(k, top);
    }
    const count = cells.length / 2;
    if (count === 0) return null;

    const geom = new THREE.BoxGeometry(1, 1, 1);
    geom.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    const mesh = new THREE.InstancedMesh(geom, mat, count);
    const dummy = new THREE.Object3D();
    const colCoast = new THREE.Color('#7dd3fc');
    const colRiver = new THREE.Color('#c4b5fd');
    for (let n = 0; n < count; n++) {
      const k = cells[n * 2];
      const top = cells[n * 2 + 1];
      const bottom = Math.min(this.ground[k], top - 0.2);
      dummy.position.set(((k % nx) + 0.5) * res - widthM / 2, bottom, (Math.floor(k / nx) + 0.5) * res - heightM / 2);
      dummy.scale.set(res, top - bottom, res);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      mesh.setColorAt(n, this.shore[k] === SHORE_COAST ? colCoast : colRiver);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  createSeawallMesh(sw, targetHeight) {
    if (!sw.points || sw.points.length < 2) return null;
    // region-local metres -> scene coordinates (region centred on the origin)
    const pts = sw.points.map(([x, z]) => [x - this.meta.widthM / 2, z - this.meta.heightM / 2]);

    const geom = new THREE.BufferGeometry();
    const positions = [];
    const normals = [];
    const colors = [];

    const isGate = sw.type === 'sluice_gate';
    const baseHalfW = isGate ? 15.0 : 10.0;
    const topHalfW = isGate ? 12.0 : 4.0;

    const colorTop = isGate ? new THREE.Color('#f59e0b') : new THREE.Color('#38bdf8');
    const colorSide = isGate ? new THREE.Color('#b45309') : new THREE.Color('#0284c7');

    const addQuad = (p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, p3x, p3y, p3z, norm, col) => {
      positions.push(p0x, p0y, p0z,  p1x, p1y, p1z,  p2x, p2y, p2z);
      normals.push(norm.x, norm.y, norm.z, norm.x, norm.y, norm.z, norm.x, norm.y, norm.z);
      colors.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);

      positions.push(p0x, p0y, p0z,  p2x, p2y, p2z,  p3x, p3y, p3z);
      normals.push(norm.x, norm.y, norm.z, norm.x, norm.y, norm.z, norm.x, norm.y, norm.z);
      colors.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    };

    const yBottom = -4.0; // down to the river bed
    const yTop = Math.max(1.5, targetHeight);

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];

      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;

      const nx_dir = -dz / len;
      const nz_dir = dx / len;

      const v0x = p0[0] + nx_dir * topHalfW;
      const v0z = p0[1] + nz_dir * topHalfW;
      const v1x = p0[0] - nx_dir * topHalfW;
      const v1z = p0[1] - nz_dir * topHalfW;
      const v2x = p1[0] + nx_dir * topHalfW;
      const v2z = p1[1] + nz_dir * topHalfW;
      const v3x = p1[0] - nx_dir * topHalfW;
      const v3z = p1[1] - nz_dir * topHalfW;

      const b0x = p0[0] + nx_dir * baseHalfW;
      const b0z = p0[1] + nz_dir * baseHalfW;
      const b1x = p0[0] - nx_dir * baseHalfW;
      const b1z = p0[1] - nz_dir * baseHalfW;
      const b2x = p1[0] + nx_dir * baseHalfW;
      const b2z = p1[1] + nz_dir * baseHalfW;
      const b3x = p1[0] - nx_dir * baseHalfW;
      const b3z = p1[1] - nz_dir * baseHalfW;

      // Crest (Top)
      addQuad(v0x, yTop, v0z,  v2x, yTop, v2z,  v3x, yTop, v3z,  v1x, yTop, v1z, new THREE.Vector3(0, 1, 0), colorTop);

      // Left seaward slope
      const normL = new THREE.Vector3(nx_dir, 0.4, nz_dir).normalize();
      addQuad(b0x, yBottom, b0z,  b2x, yBottom, b2z,  v2x, yTop, v2z,  v0x, yTop, v0z, normL, colorSide);

      // Right landward slope
      const normR = new THREE.Vector3(-nx_dir, 0.4, -nz_dir).normalize();
      addQuad(v1x, yTop, v1z,  v3x, yTop, v3z,  b3x, yBottom, b3z,  b1x, yBottom, b1z, normR, colorSide);
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.2,
      side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Call `fn(idx)` for every grid cell within the gate / wall footprint of `sw`. */
  rasterise(sw, fn) {
    const { res, nx, ny } = this.meta;
    const pts = sw.points;
    const halfW = (sw.widthM || 15.0) / 2 + res * 0.7;
    for (let s = 0; s < pts.length - 1; s++) {
      const x0 = pts[s][0] / res, y0 = pts[s][1] / res;
      const x1 = pts[s + 1][0] / res, y1 = pts[s + 1][1] / res;
      const minGx = Math.max(0, Math.floor(Math.min(x0, x1) - halfW / res));
      const maxGx = Math.min(nx - 1, Math.ceil(Math.max(x0, x1) + halfW / res));
      const minGy = Math.max(0, Math.floor(Math.min(y0, y1) - halfW / res));
      const maxGy = Math.min(ny - 1, Math.ceil(Math.max(y0, y1) + halfW / res));
      const segDx = x1 - x0, segDy = y1 - y0;
      const segLenSq = segDx * segDx + segDy * segDy || 1;
      for (let gy = minGy; gy <= maxGy; gy++) {
        for (let gx = minGx; gx <= maxGx; gx++) {
          const cx = gx + 0.5, cy = gy + 0.5;
          const t = Math.max(0, Math.min(1, ((cx - x0) * segDx + (cy - y0) * segDy) / segLenSq));
          if (Math.hypot(cx - (x0 + t * segDx), cy - (y0 + t * segDy)) * res <= halfW) fn(gy * nx + gx);
        }
      }
    }
  }

  updateBarrierGrid() {
    this.barrierGrid.fill(-999);
    this.barrierActive.fill(0);
    if (this.activePreset === 'no_seawall') return;

    const raise = (idx, h) => {
      if (h > this.barrierGrid[idx]) {
        this.barrierGrid[idx] = h;
        this.barrierActive[idx] = 1;
      }
    };
    for (const sw of this.getActiveSeawallList()) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : sw.designHeight;
      this.rasterise(sw, (idx) => raise(idx, targetH));
    }

    // Coastal seawalls / river parapets on every land cell along open water
    if (this.shore && this.ground) {
      for (let k = 0; k < this.shore.length; k++) {
        if (!this.shore[k]) continue;
        const h = this.shoreWallHeight(this.shore[k]);
        if (h > this.ground[k]) raise(k, h);
      }
    }
  }

  dispose() {
    while (this.meshGroup.children.length > 0) {
      const c = this.meshGroup.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      this.meshGroup.remove(c);
    }
  }
}
