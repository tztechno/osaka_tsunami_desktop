/**
 * 2D Shallow Water / Local Inertial Tsunami Inundation Simulator
 * Physics: Bates et al. (2010) semi-implicit local inertial formulation
 * + Seawall overtopping barrier mechanics + Plateau 3D buildings obstacle mask.
 */

import { WaveProfile } from './waveProfile.js';
export { WaveProfile };

/**
 * Offshore boundary water level (m) at time t (s): for hasPreDrawdown a drawdown, the main
 * crest, then follow-on waves at 55 % height repeating every period; otherwise one solitary wave.
 */
export function offshoreWaveEta(t, { waveHeight, wavePeriod, hasPreDrawdown }) {
  if (t < 0) return 0.0;
  const omega = (2 * Math.PI) / (wavePeriod || 1800);
  if (hasPreDrawdown) {
    const phase = omega * t;
    if (phase < Math.PI * 0.5) return -Math.sin(phase * 2) * (waveHeight * 0.15); // initial drawdown
    if (phase < Math.PI * 2.5) {
      const eta = Math.sin(phase - Math.PI * 0.5) * waveHeight; // main crest
      return eta < 0 ? eta * 0.4 : eta;
    }
    return Math.sin(phase - Math.PI * 2.5) * (waveHeight * 0.55); // follow-on waves
  }
  const u = (t - (wavePeriod || 1800) * 0.4) / ((wavePeriod || 1800) * 0.2);
  const sech = 1 / Math.cosh(Math.max(-10, Math.min(10, u)));
  return waveHeight * sech * sech;
}

export class TsunamiSimulator {
  constructor({ meta, ground, waterMask = null, seawallManager, buildings = [] }) {
    this.meta = meta;
    this.nx = meta.nx;
    this.ny = meta.ny;
    this.res = meta.res;
    this.ground = ground; // Float32Array (elevation z_b)
    this.waterMask = waterMask; // Uint8Array: 1 = open water (sea/river), 0 = dry land (including 0m-below land)
    this.seawalls = seawallManager;
    this.buildings = buildings;

    const N = this.nx * this.ny;
    this.N = N;

    // Simulation fields
    this.eta = new Float32Array(N); // Water surface elevation (m)
    this.depth = new Float32Array(N); // Water depth h (m)
    this.maxDepth = new Float32Array(N); // Cumulative peak depth (m)
    this.arrival = new Float32Array(N); // First time (s) a land cell reaches 0.3 m depth; -1 = never
    this.qx = new Float32Array(N); // Unit discharge x (m2/s)
    this.qy = new Float32Array(N); // Unit discharge y (m2/s)
    this.outScale = new Float32Array(N); // Positivity limiter scratch
    this.qxPrev = new Float32Array(N); // Previous-step fluxes for θ-weighting
    this.qyPrev = new Float32Array(N);

    // Mask for building obstacles
    this.bldgMask = new Uint8Array(N);
    this.initBuildingMask();

    // Initial state: sea cells have eta = 0.0 (sea level), land cells depth = 0
    this.initWater();

    // Time & Controls
    this.simTimeSec = 0;
    this.isRunning = false;
    this.speedMultiplier = 1.0;
    this.manningN = 0.025; // coastal/urban friction

    // Wave parameters (default: Nankai Trough Osaka Port model)
    this.waveProfile = null;
    this.waveHeight = 5.40;
    this.wavePeriod = 1800;
    this.waveDirectionDeg = 235; // 235 = from South-West (Kitan Strait -> Osaka Bay)
    this.hasPreDrawdown = true;

    // Stats
    this.stats = {
      simTimeSec: 0,
      simTimeMin: 0,
      offshoreWaveHeight: 0,
      coastalWaveHeight: 0,
      waveFrontDistM: 0,
      waveStatus: 'approaching',
      maxRunup: 0,
      inundatedAreaHa: 0,
      inundatedBuildings: 0,
      isOvertopping: false,
      overtoppingCount: 0,
    };

    // Time series logs for CSV export
    this.history = [];
    this.lastLogSec = -100;
  }

  initBuildingMask() {
    const { nx, ny, res, buildings } = this;
    this.bldgMask.fill(0);
    for (const b of buildings) {
      const gx0 = Math.max(0, Math.floor((b.x - b.w * 0.5) / res));
      const gx1 = Math.min(nx - 1, Math.ceil((b.x + b.w * 0.5) / res));
      const gy0 = Math.max(0, Math.floor((b.z - b.d * 0.5) / res));
      const gy1 = Math.min(ny - 1, Math.ceil((b.z + b.d * 0.5) / res));
      for (let y = gy0; y <= gy1; y++) {
        for (let x = gx0; x <= gx1; x++) {
          this.bldgMask[y * nx + x] = 1;
        }
      }
    }
  }

  initWater() {
    const { ground, waterMask, N } = this;
    let maxSeaDepth = 0;
    for (let i = 0; i < N; i++) {
      const zb = ground[i];
      // A cell is initial open sea/river water ONLY if waterMask is true (or if no mask, zb < -1.0)
      const isWater = waterMask ? (waterMask[i] === 1) : (zb < -1.0);
      if (isWater) {
        this.eta[i] = 0.0;
        this.depth[i] = Math.max(0.1, -zb);
        if (-zb > maxSeaDepth) maxSeaDepth = -zb;
      } else {
        // Dry land (including below-sea-level zero-meter districts protected by seawalls)
        this.eta[i] = zb;
        this.depth[i] = 0.0;
      }
      this.maxDepth[i] = 0.0;
      this.arrival[i] = -1.0;
      this.qx[i] = 0;
      this.qy[i] = 0;
      this.qxPrev[i] = 0;
      this.qyPrev[i] = 0;
    }
    this.maxSeaDepth = maxSeaDepth || 15;
    this.setupBoundary();
  }

  setupBoundary() {
    const { nx, ny, ground, res } = this;
    const cells = [];
    for (let y = 0; y < ny; y++) {
      if (ground[y * nx] < -3) cells.push(y * nx);
      if (ground[y * nx + nx - 2] < -3) cells.push(y * nx + nx - 2);
    }
    for (let x = 0; x < nx - 2; x++) {
      if (ground[x] < -3) cells.push(x);
      if (ground[(ny - 1) * nx + x] < -3) cells.push((ny - 1) * nx + x);
    }
    const th = (this.waveDirectionDeg * Math.PI) / 180;
    const kE = -Math.sin(th);
    const kN = -Math.cos(th);
    const s = cells.map((i) => (i % nx) * res * kE - Math.floor(i / nx) * res * kN);
    const sMin = Math.min(...s);
    const c = Math.sqrt(9.80665 * Math.max(5, this.maxSeaDepth || 15));
    this.bcCells = Int32Array.from(cells);
    this.bcDelay = Float32Array.from(s, (v) => (v - sMin) / c);
  }

  setScenario(scenario) {
    this.waveProfile = scenario.waveProfile || null;
    this.waveHeight = scenario.waveHeight;
    this.wavePeriod = scenario.periodSec || scenario.wavePeriod || 1800;
    this.waveDirectionDeg = scenario.directionDeg !== undefined ? scenario.directionDeg : 235;
    this.hasPreDrawdown = !!scenario.hasPreDrawdown;
    this.setupBoundary();
    this.reset();
  }

  setWaveProfile(profile) {
    this.waveProfile = profile;
    if (profile) {
      this.waveHeight = profile.peakHeight;
      this.waveDirectionDeg = profile.dominantDirectionDeg != null ? profile.dominantDirectionDeg : 235;
    }
    this.setupBoundary();
    this.reset();
  }

  clearWaveProfile() {
    this.waveProfile = null;
  }

  setCustomWave({ height, period, direction }) {
    this.waveProfile = null;
    if (height !== undefined) this.waveHeight = height;
    if (period !== undefined) this.wavePeriod = period;
    if (direction !== undefined) {
      this.waveDirectionDeg = direction;
      this.setupBoundary();
    }
  }

  injectPulseWave({ worldX, worldZ, height = 4.0, radius = 250, directionDeg = null }) {
    const { nx, ny, res, ground } = this;
    const cx = Math.floor(worldX / res);
    const cz = Math.floor(worldZ / res);
    const rCells = Math.ceil(radius / res);

    const x0 = Math.max(1, cx - rCells);
    const x1 = Math.min(nx - 2, cx + rCells);
    const z0 = Math.max(1, cz - rCells);
    const z1 = Math.min(ny - 2, cz + rCells);

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const idx = z * nx + x;
        if (ground[idx] >= 0) continue;
        const dist = Math.hypot((x - cx) * res, (z - cz) * res);
        if (dist > radius) continue;

        const pulse = height * Math.cos((dist / radius) * (Math.PI * 0.5));
        if (pulse <= 0) continue;

        this.eta[idx] += pulse;
        this.depth[idx] = Math.max(0, this.eta[idx] - ground[idx]);
        if (this.depth[idx] > this.maxDepth[idx]) {
          this.maxDepth[idx] = this.depth[idx];
        }
      }
    }
  }

  reset() {
    this.simTimeSec = 0;
    this.history = [];
    this.lastLogSec = -100;
    this.initWater();
    this.updateStats();
  }

  getOffshoreWaveEta(t) {
    if (this.waveProfile) {
      return this.waveProfile.getEta(t);
    }
    return offshoreWaveEta(t, this);
  }

  stableDt() {
    const hMax = Math.max(1, this.hMax || 0, this.maxSeaDepth + Math.abs(this.waveHeight));
    return Math.min(1.0, (0.6 * this.res) / Math.sqrt(9.80665 * hMax));
  }

  advance(simSeconds) {
    let remaining = simSeconds;
    while (remaining > 1e-6) {
      const dt = Math.min(remaining, this.stableDt());
      this.step(dt);
      remaining -= dt;
    }
  }

  step(dt) {
    const { nx, ny, res } = this;
    const g = 9.80665;
    const n2 = this.manningN * this.manningN;
    const etaOffshore = this.getOffshoreWaveEta(this.simTimeSec);
    this.stats.offshoreWaveHeight = etaOffshore;

    const barrierGrid = this.seawalls.barrierGrid;
    const barrierActive = this.seawalls.barrierActive;

    let overtoppingCount = 0;

    // 1. Boundary Condition: incoming wave from offshore sea cells
    if (!this.bcCells) this.setupBoundary();
    const { bcCells, bcDelay } = this;
    for (let k = 0; k < bcCells.length; k++) {
      const idx = bcCells[k];
      const e = this.getOffshoreWaveEta(this.simTimeSec - bcDelay[k]);
      this.eta[idx] = Math.max(this.ground[idx], e);
      this.depth[idx] = Math.max(0, this.eta[idx] - this.ground[idx]);
    }

    const THETA = 0.7;
    const qxPrev = this.qxPrev;
    const qyPrev = this.qyPrev;
    qxPrev.set(this.qx);
    qyPrev.set(this.qy);

    // 2. Flux Updates: qx (East-West)
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const i0 = y * nx + x;
        const i1 = y * nx + (x + 1);

        if (this.bldgMask[i0] && this.bldgMask[i1]) {
          this.qx[i0] = 0;
          continue;
        }

        const eta0 = this.eta[i0];
        const eta1 = this.eta[i1];
        const zb0 = this.ground[i0];
        const zb1 = this.ground[i1];

        let zSill = Math.max(zb0, zb1);

        const hasBarrier = barrierActive[i0] || barrierActive[i1];
        if (hasBarrier) {
          const zBarrier = Math.max(barrierGrid[i0], barrierGrid[i1]);
          if (zBarrier > zSill) {
            zSill = zBarrier;
            if (Math.max(eta0, eta1) > zBarrier) {
              overtoppingCount++;
            }
          }
        }

        const hFlow = Math.max(0, Math.max(eta0, eta1) - zSill);
        if (hFlow < 1e-4) {
          this.qx[i0] = 0;
          continue;
        }

        const qOld = qxPrev[i0];
        const S_h = (eta0 - eta1) / res;
        const denom = 1 + g * dt * n2 * Math.abs(qOld) / Math.pow(hFlow, 7 / 3);
        const qNew = (qOld + g * hFlow * dt * S_h) / denom;
        this.qx[i0] = (1 - THETA) * qOld + THETA * qNew;
      }
    }

    // 3. Flux Updates: qy (North-South)
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx; x++) {
        const i0 = y * nx + x;
        const i1 = (y + 1) * nx + x;

        if (this.bldgMask[i0] && this.bldgMask[i1]) {
          this.qy[i0] = 0;
          continue;
        }

        const eta0 = this.eta[i0];
        const eta1 = this.eta[i1];
        const zb0 = this.ground[i0];
        const zb1 = this.ground[i1];

        let zSill = Math.max(zb0, zb1);

        const hasBarrier = barrierActive[i0] || barrierActive[i1];
        if (hasBarrier) {
          const zBarrier = Math.max(barrierGrid[i0], barrierGrid[i1]);
          if (zBarrier > zSill) {
            zSill = zBarrier;
            if (Math.max(eta0, eta1) > zBarrier) {
              overtoppingCount++;
            }
          }
        }

        const hFlow = Math.max(0, Math.max(eta0, eta1) - zSill);
        if (hFlow < 1e-4) {
          this.qy[i0] = 0;
          continue;
        }

        const qOld = qyPrev[i0];
        const S_h = (eta0 - eta1) / res;
        const denom = 1 + g * dt * n2 * Math.abs(qOld) / Math.pow(hFlow, 7 / 3);
        const qNew = (qOld + g * hFlow * dt * S_h) / denom;
        this.qy[i0] = (1 - THETA) * qOld + THETA * qNew;
      }
    }

    // 4. Positivity limiter (de Almeida et al. 2012)
    const outScale = this.outScale;
    outScale.fill(1.0);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = y * nx + x;
        const h0 = this.depth[idx];
        let qOut = 0;
        if (x > 0 && this.qx[idx - 1] < 0) qOut -= this.qx[idx - 1];
        if (x < nx - 1 && this.qx[idx] > 0) qOut += this.qx[idx];
        if (y > 0 && this.qy[idx - nx] < 0) qOut -= this.qy[idx - nx];
        if (y < ny - 1 && this.qy[idx] > 0) qOut += this.qy[idx];

        const volOut = (qOut * dt) / res;
        if (volOut > h0 && volOut > 1e-6) {
          outScale[idx] = Math.max(0, h0 / volOut);
        }
      }
    }

    // Apply scaling to outflow fluxes
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const idx = y * nx + x;
        const q = this.qx[idx];
        if (q > 0) this.qx[idx] = q * outScale[idx];
        else if (q < 0) this.qx[idx] = q * outScale[idx + 1];
      }
    }
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = y * nx + x;
        const q = this.qy[idx];
        if (q > 0) this.qy[idx] = q * outScale[idx];
        else if (q < 0) this.qy[idx] = q * outScale[idx + nx];
      }
    }

    // 5. Mass Conservation: Continuity equation
    let hMax = 0;
    const invRes = dt / res;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = y * nx + x;
        const qx_w = x > 0 ? this.qx[idx - 1] : 0;
        const qx_e = x < nx - 1 ? this.qx[idx] : 0;
        const qy_s = y > 0 ? this.qy[idx - nx] : 0;
        const qy_n = y < ny - 1 ? this.qy[idx] : 0;

        const divQ = (qx_w - qx_e + qy_s - qy_n) * invRes;
        const newH = Math.max(0, this.depth[idx] + divQ);
        this.depth[idx] = newH;
        this.eta[idx] = this.ground[idx] + newH;

        if (newH > hMax) hMax = newH;
        if (newH > this.maxDepth[idx]) this.maxDepth[idx] = newH;

        if (this.ground[idx] >= 0 && newH >= 0.3 && this.arrival[idx] < 0) {
          this.arrival[idx] = this.simTimeSec;
        }
      }
    }

    this.hMax = hMax;
    this.simTimeSec += dt;
    this.stats.isOvertopping = overtoppingCount > 0;
    this.stats.overtoppingCount = overtoppingCount;

    // Log history every 10 seconds
    if (this.simTimeSec - this.lastLogSec >= 10.0) {
      this.lastLogSec = this.simTimeSec;
      this.updateStats();
      this.logHistory();
    }
  }

  updateStats() {
    const { N, ground, depth, maxDepth, buildings } = this;
    let inundatedLandCells = 0;
    let maxRunup = 0;

    for (let i = 0; i < N; i++) {
      const zb = ground[i];
      if (zb >= 0 && depth[i] >= 0.05) {
        inundatedLandCells++;
        const waterElev = zb + depth[i];
        if (waterElev > maxRunup) maxRunup = waterElev;
      }
    }

    // Inundated building count
    let inundatedBldgs = 0;
    const res = this.res;
    const nx = this.nx;
    for (const b of buildings) {
      const gx = Math.min(nx - 1, Math.max(0, Math.floor(b.x / res)));
      const gy = Math.min(this.ny - 1, Math.max(0, Math.floor(b.z / res)));
      if (depth[gy * nx + gx] >= 0.5) {
        inundatedBldgs++;
      }
    }

    const cellAreaM2 = res * res;
    const areaHa = (inundatedLandCells * cellAreaM2) / 10000;

    this.stats.simTimeSec = this.simTimeSec;
    this.stats.simTimeMin = this.simTimeSec / 60;
    this.stats.maxRunup = maxRunup;
    this.stats.inundatedAreaHa = areaHa;
    this.stats.inundatedBuildings = inundatedBldgs;
  }

  logHistory() {
    this.history.push({
      timeSec: Math.round(this.simTimeSec),
      timeMin: +(this.simTimeSec / 60).toFixed(2),
      waveHeight: +this.stats.offshoreWaveHeight.toFixed(2),
      maxRunup: +this.stats.maxRunup.toFixed(2),
      areaHa: +this.stats.inundatedAreaHa.toFixed(1),
      bldgs: this.stats.inundatedBuildings,
      overtopping: this.stats.isOvertopping,
    });
  }

  getPointDepth(worldX, worldZ) {
    const { res } = this.meta;
    const gx = Math.floor(worldX / res);
    const gz = Math.floor(worldZ / res);
    if (gx < 0 || gx >= this.nx || gz < 0 || gz >= this.ny) return null;
    const idx = gz * this.nx + gx;
    return {
      gx,
      gz,
      elevation: this.ground[idx],
      waterDepth: this.depth[idx],
      maxDepth: this.maxDepth[idx],
      waterEta: this.eta[idx],
    };
  }

  generateCsv() {
    const header = [
      'Time (s)',
      'Time (min)',
      'Offshore Tsunami Wave (m)',
      'Max Runup Elevation (m)',
      'Inundated Area (ha)',
      'Inundated Buildings',
      'Overtopping Active',
    ];
    const rows = [header.join(',')];
    for (const h of this.history) {
      rows.push([h.timeSec, h.timeMin, h.waveHeight, h.maxRunup, h.areaHa, h.bldgs, h.overtopping ? 'YES' : 'NO'].join(','));
    }
    return '\uFEFF' + rows.join('\r\n');
  }
}
