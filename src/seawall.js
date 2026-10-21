import * as THREE from 'three';

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

    const activeList = this.getActiveSeawallList();
    if (activeList.length === 0) return;

    for (const sw of activeList) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : sw.designHeight;
      const mesh = this.createSeawallMesh(sw, targetH);
      if (mesh) {
        this.meshGroup.add(mesh);
        this.seawallMeshes.set(sw.id, { mesh, seawall: sw, height: targetH });
      }
    }

    // Add perimeter seawall mesh encircling zero-meter zones
    if (this.activePreset !== 'no_seawall' && this.waterMask && this.ground) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : 6.8;
      const periMesh = this.createPerimeterMesh(targetH);
      if (periMesh) {
        this.meshGroup.add(periMesh);
        this.perimeterMesh = periMesh;
      }
    }
  }

  createPerimeterMesh(targetH) {
    if (!this.waterMask || !this.ground) return null;
    const { res, nx, ny } = this.meta;
    const wm = this.waterMask;
    const gd = this.ground;

    const positions = [];
    const normals = [];
    const colors = [];

    const colTop = new THREE.Color('#38bdf8');
    const colSide = new THREE.Color('#0284c7');

    const addBox = (cx, cz, topY, botY, halfW) => {
      const x0 = cx - halfW, x1 = cx + halfW;
      const z0 = cz - halfW, z1 = cz + halfW;
      // Top face
      positions.push(x0, topY, z0,  x1, topY, z0,  x1, topY, z1,  x0, topY, z0,  x1, topY, z1,  x0, topY, z1);
      for (let k = 0; k < 6; k++) { normals.push(0, 1, 0); colors.push(colTop.r, colTop.g, colTop.b); }
      // Front
      positions.push(x0, botY, z1,  x1, botY, z1,  x1, topY, z1,  x0, botY, z1,  x1, topY, z1,  x0, topY, z1);
      for (let k = 0; k < 6; k++) { normals.push(0, 0, 1); colors.push(colSide.r, colSide.g, colSide.b); }
      // Back
      positions.push(x1, botY, z0,  x0, botY, z0,  x0, topY, z0,  x1, botY, z0,  x0, topY, z0,  x1, topY, z0);
      for (let k = 0; k < 6; k++) { normals.push(0, 0, -1); colors.push(colSide.r, colSide.g, colSide.b); }
    };

    const halfW = res * 0.45;
    for (let y = 1; y < ny - 1; y += 2) {
      for (let x = 1; x < nx - 1; x += 2) {
        const idx = y * nx + x;
        if (wm[idx] === 0 && gd[idx] < 1.0) {
          const isCoast = (wm[idx - 1] === 1 || wm[idx + 1] === 1 || wm[idx - nx] === 1 || wm[idx + nx] === 1);
          if (isCoast) {
            const cx = (x + 0.5) * res;
            const cz = (y + 0.5) * res;
            const botY = Math.max(-0.5, gd[idx]);
            addBox(cx, cz, targetH, botY, halfW);
          }
        }
      }
    }

    if (positions.length === 0) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  createSeawallMesh(sw, targetHeight) {
    const pts = sw.points;
    if (!pts || pts.length < 2) return null;

    const { res, nx, ny } = this.meta;
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

    const yBottom = 0.5;
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

  updateBarrierGrid() {
    this.barrierGrid.fill(-999);
    this.barrierActive.fill(0);

    const activeList = this.getActiveSeawallList();
    if (activeList.length === 0) return;

    const { res, nx, ny } = this.meta;

    for (const sw of activeList) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : sw.designHeight;
      const pts = sw.points;
      const halfW = (sw.widthM || 15.0) / 2 + res * 0.7;

      for (let s = 0; s < pts.length - 1; s++) {
        const p0 = pts[s];
        const p1 = pts[s + 1];

        const x0 = p0[0] / res;
        const y0 = p0[1] / res;
        const x1 = p1[0] / res;
        const y1 = p1[1] / res;

        const minGx = Math.max(0, Math.floor(Math.min(x0, x1) - halfW / res));
        const maxGx = Math.min(nx - 1, Math.ceil(Math.max(x0, x1) + halfW / res));
        const minGy = Math.max(0, Math.floor(Math.min(y0, y1) - halfW / res));
        const maxGy = Math.min(ny - 1, Math.ceil(Math.max(y0, y1) + halfW / res));

        const segDx = x1 - x0;
        const segDy = y1 - y0;
        const segLenSq = segDx * segDx + segDy * segDy;

        for (let gy = minGy; gy <= maxGy; gy++) {
          for (let gx = minGx; gx <= maxGx; gx++) {
            const cx = gx + 0.5;
            const cy = gy + 0.5;

            let t = ((cx - x0) * segDx + (cy - y0) * segDy) / (segLenSq || 1);
            t = Math.max(0, Math.min(1, t));
            const projX = x0 + t * segDx;
            const projY = y0 + t * segDy;
            const dist = Math.hypot(cx - projX, cy - projY) * res;

            if (dist <= halfW) {
              const idx = gy * nx + gx;
              if (targetH > this.barrierGrid[idx]) {
                this.barrierGrid[idx] = targetH;
                this.barrierActive[idx] = 1;
              }
            }
          }
        }
      }
    }

    // Auto-encircle low-lying and below-sea-level land bordering open water
    // Ensures complete perimeter artificial levee at realistic crest height (T.P. +6.8m)
    if (this.waterMask && this.ground && this.activePreset !== 'no_seawall') {
      const defaultLeveeH = this.activePreset === 'custom' ? this.customHeight : 6.8;
      const wm = this.waterMask;
      const gd = this.ground;

      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const idx = y * nx + x;
          // Dry land cell bordering water
          if (wm[idx] === 0) {
            const zb = gd[idx];
            // If land is below sea level (< 0m) or low-lying coastal (< 1.5m)
            if (zb < 1.5) {
              const isCoast = (wm[idx - 1] === 1 || wm[idx + 1] === 1 ||
                               wm[idx - nx] === 1 || wm[idx + nx] === 1);
              if (isCoast) {
                if (defaultLeveeH > this.barrierGrid[idx]) {
                  this.barrierGrid[idx] = defaultLeveeH;
                  this.barrierActive[idx] = 1;
                }
              }
            }
          }
        }
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
