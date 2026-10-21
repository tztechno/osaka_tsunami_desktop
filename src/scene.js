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

export class TsunamiScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d1b2a');
    this.scene.fog = new THREE.FogExp2('#0d1b2a', 0.00008);

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

    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 1, 100000);
    // Initial camera overlooking Osaka Port & City from South-West (looking towards downtown)
    this.camera.position.set(-3000, 2800, 6000);

    this.setupLights();
    this.setupControls();

    this.groundMesh = null;
    this.waterMesh = null;
    this.buildingsMesh = null;
    this.pinMesh = null;
    this.sourceZoneGroup = null;

    this.showHazardColors = false;
    this.showMaxDepth = false;
    this.buildingFocus = { enabled: false, radius: 3000, x: 0, z: 0 };
    this.viewLocked = false;

    // Center marker shown on double-click
    this.focusMarker = new THREE.Mesh(
      new THREE.SphereGeometry(20, 16, 12),
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

  setupControls() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // Keep above ground
    controls.minDistance = 50;
    controls.maxDistance = 45000;
    controls.target.set(0, 0, 0);
    this.controls = controls;
  }

  async loadRegion(meta, ground, aerialUrl, seawallMgr, buildings = []) {
    this.meta = meta;
    this.ground = ground;
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

    const geom = new THREE.PlaneGeometry(widthM, heightM, nx - 1, ny - 1);
    geom.rotateX(-Math.PI / 2);

    const pos = geom.attributes.position.array;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const vertIdx = (j * nx + i) * 3;
        pos[vertIdx + 1] = ground[idx];
      }
    }
    geom.computeVertexNormals();

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

    // Adjust camera target to Tempozan / Osaka Port
    this.controls.target.set(0, 0, 0);
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
      const groundH = Math.max(0.5, ground[gy * nx + gx] || 0.5);

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

    const geom = new THREE.PlaneGeometry(widthM, heightM, wnx - 1, wny - 1);
    geom.rotateX(-Math.PI / 2);

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
        pos[vertY] = eta[idx];

        const onLand = zb >= 0;
        if (this.showHazardColors && onLand) {
          const matched = DEPTH_LEGEND.find(l => d < l.max);
          c.set(matched ? matched.color : '#dc7adc');
        } else if (onLand) {
          // Muddy overland flood water
          c.lerpColors(C_FLOOD, C_FLOOD_DEEP, Math.min(1.0, d / 5.0));
        } else {
          // Ocean water: deep blue to bright cyan-blue on surge
          const anomaly = eta[idx];
          if (anomaly >= 0) {
            c.lerpColors(C_SEA_DEEP, C_SEA_RISE, Math.min(1.0, anomaly / 5.0));
          } else {
            c.lerpColors(C_SEA_DEEP, C_SEA_LOW, Math.min(1.0, -anomaly / 3.0));
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

  setPin(worldX, worldZ) {
    if (!this.pinMesh) {
      const geom = new THREE.ConeGeometry(25, 80, 16);
      geom.rotateX(Math.PI);
      geom.translate(0, 40, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0xff1744, roughness: 0.2, metalness: 0.3 });
      this.pinMesh = new THREE.Mesh(geom, mat);
      this.scene.add(this.pinMesh);
    }

    const groundH = this.getGroundAt(worldX, worldZ);
    this.pinMesh.position.set(worldX - this.W / 2, groundH + 10, worldZ - this.H / 2);
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

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
