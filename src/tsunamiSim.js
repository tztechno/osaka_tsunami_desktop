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

const SPONGE_M = 400; // width of the wave-generating / absorbing zone at the bay edges
// The boundary CSV (nankai_trough, sampled offshore on the region's edge) / scenario height is
// generated as the incident wave; reflection from the port walls is computed here.
const INCIDENT_FACTOR = 1.0;
const OPEN_WATER_R_M = 300; // half window for the open-water test of the relaxation zone

/**
 * Green's law amplitude factor for a wave recorded at sourceDepth (the CSV point) and fed in at edgeDepth:
 * (h_source / h_edge)^(1/4). 1 when either depth is unknown.
 */
export function shoalingFactor(sourceDepth, edgeDepth) {
  return sourceDepth > 0 && edgeDepth > 0 ? (sourceDepth / edgeDepth) ** 0.25 : 1;
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
    this.waveDirectionDeg = 235; // needed by setupBoundary() inside initWater()
    this.startTimeSec = 0; // simulation clock at reset (CSV sources skip their quiet lead-in)
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
    // cells whose centre lies on the footprint (at least the cell under the building's centre), so
    // neighbouring buildings do not merge into walls across the streets between them
    const span = (c, size, n) => {
      let a = Math.ceil((c - size * 0.5) / res - 0.5), z = Math.floor((c + size * 0.5) / res - 0.5);
      if (a > z) a = z = Math.floor(c / res);
      return [Math.max(0, a), Math.min(n - 1, z)];
    };
    const spans = buildings.map((b) => [...span(b.x, b.w, nx), ...span(b.z, b.d, ny)]);
    for (const [gx0, gx1, gy0, gy1] of spans) {
      for (let y = gy0; y <= gy1; y++) {
        for (let x = gx0; x <= gx1; x++) {
          // footprints reaching over rivers / quays (bridges, piers) must not dam the channel
          if (this.isLand(y * nx + x)) this.bldgMask[y * nx + x] = 1;
        }
      }
    }
    // street cells around each footprint (land, not under a building), as CSR lists: a building counts as
    // flooded from the water beside it — its own cells are obstacles and stay dry inside
    const start = new Uint32Array(buildings.length + 1);
    const cells = [];
    spans.forEach(([gx0, gx1, gy0, gy1], b) => {
      for (let y = gy0 - 1; y <= gy1 + 1; y++) {
        for (let x = gx0 - 1; x <= gx1 + 1; x++) {
          if (x >= gx0 && x <= gx1 && y >= gy0 && y <= gy1) continue;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          const k = y * nx + x;
          if (!this.bldgMask[k] && this.isLand(k)) cells.push(k);
        }
      }
      start[b + 1] = cells.length;
    });
    this.bldgRingStart = start;
    this.bldgRing = Uint32Array.from(cells);
  }

  /**
   * Building b is flooded when at least a tenth of the street cells around it have 0.5 m of water or more
   * (the 90th percentile >= 0.5 m, the same rule as the 2 m detail tile).
   */
  buildingFlooded(b) {
    const s = this.bldgRingStart[b], e = this.bldgRingStart[b + 1];
    if (e === s) return false;
    let wet = 0;
    for (let p = s; p < e; p++) if (this.depth[this.bldgRing[p]] >= 0.5) wet++;
    return wet >= Math.max(1, Math.ceil((e - s) * 0.1));
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

  /** Is cell i land (incl. zero-metre districts below T.P. 0) rather than open sea / river? */
  isLand(i) {
    return this.waterMask ? this.waterMask[i] === 0 : this.ground[i] >= 0;
  }

  /**
   * Wave-generating / absorbing relaxation zone along the Osaka Bay edges (west and south; rivers
   * leaving the north / east edges stay closed). Within SPONGE_M of those edges the water level
   * and discharge are relaxed towards the incident long wave, so the wave enters while waves
   * reflected by the port leave the domain instead of building up between the coast and the edge.
   * sourceWidthM limits the wave input to zone cells within ±width/2 of sourceCenter (the source marker,
   * region-local metres), measured along the wave crest. The source is where a wave from a distant
   * earthquake enters the region, not the epicentre, so the wave has the same height across the width;
   * zone cells outside still absorb (their target level is still water).
   * bcDepth is the inflow-weighted mean depth Σh²/Σh of the cells that take the wave, for the CSV
   * shoaling correction.
   */
  setupBoundary() {
    const { nx, ny, ground, res } = this;
    const L = Math.round(SPONGE_M / res);
    // Only open bay water: >= 95 % water within +-OPEN_WATER_R_M, which keeps the zone out of
    // river mouths (e.g. the Yamato River on the south edge) and away from the quay walls.
    const R = Math.round(OPEN_WATER_R_M / res);
    const sat = new Int32Array((nx + 1) * (ny + 1));
    for (let y = 0; y < ny; y++) {
      let row = 0;
      for (let x = 0; x < nx; x++) {
        row += this.isLand(y * nx + x) ? 0 : 1;
        sat[(y + 1) * (nx + 1) + x + 1] = sat[y * (nx + 1) + x + 1] + row;
      }
    }
    const waterFrac = (x, y) => {
      const x0 = Math.max(0, x - R), x1 = Math.min(nx, x + R + 1);
      const y0 = Math.max(0, y - R), y1 = Math.min(ny, y + R + 1);
      const n = sat[y1 * (nx + 1) + x1] - sat[y0 * (nx + 1) + x1] - sat[y1 * (nx + 1) + x0] + sat[y0 * (nx + 1) + x0];
      return n / ((x1 - x0) * (y1 - y0));
    };
    const cells = [];
    const weights = [];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const d = Math.min(x, ny - 1 - y);
        if (d >= L) continue;
        const i = y * nx + x;
        if (this.isLand(i) || ground[i] > -1 || waterFrac(x, y) < 0.95) continue;
        cells.push(i);
        weights.push((1 - d / L) ** 2);
      }
    }
    const th = (this.waveDirectionDeg * Math.PI) / 180;
    this.kE = -Math.sin(th); // propagation direction (east, north)
    this.kN = -Math.cos(th);
    const s = cells.map((i) => (i % nx) * res * this.kE - Math.floor(i / nx) * res * this.kN);
    let sMin = Infinity;
    for (const v of s) if (v < sMin) sMin = v;
    const c = Math.sqrt(9.80665 * Math.max(5, this.maxSeaDepth || 15));
    this.bcCells = Int32Array.from(cells);
    this.bcWeight = Float32Array.from(weights);
    this.bcDelay = Float32Array.from(s, (v) => (v - sMin) / c);
    this.bcEta = new Float32Array(cells.length);

    // 1 = the cell takes the incident wave, 0 = outside the source width (relaxed towards still water)
    const width = this.sourceWidthM;
    const ctr = this.sourceCenter;
    this.bcInput = Float32Array.from(cells, (i) => {
      if (!(width > 0) || !ctr) return 1;
      const dE = ((i % nx) + 0.5) * res - ctr.x;
      const dN = -((Math.floor(i / nx) + 0.5) * res - ctr.z);
      return Math.abs(dE * Math.cos(th) - dN * Math.sin(th)) <= width / 2 ? 1 : 0;
    });
    let h1 = 0, h2 = 0;
    cells.forEach((i, k) => {
      const h = -ground[i];
      if (this.bcInput[k] > 0 && h > 0) {
        h1 += h;
        h2 += h * h;
      }
    });
    this.bcDepth = h1 > 0 ? h2 / h1 : 0;
    this.shoalFactor = this.waveProfile ? shoalingFactor(this.waveProfile.sourceDepth, this.bcDepth) : 1;
  }

  /**
   * CSV multiplier (on top of the automatic shoaling correction) and source width / centre; kept across
   * scenarios. Rebuilds the wave input and restarts the run.
   */
  setWaveAdjust({ profileScale, sourceWidthM, sourceCenter }) {
    if (profileScale !== undefined) this.profileScale = profileScale;
    if (sourceWidthM !== undefined) this.sourceWidthM = sourceWidthM;
    if (sourceCenter !== undefined) this.sourceCenter = sourceCenter;
    this.setupBoundary();
    this.reset();
  }

  setScenario(scenario) {
    this.waveProfile = scenario.waveProfile || null;
    this.startTimeSec = this.waveProfile ? this.waveProfile.leadInSec() : 0;
    this.waveHeight = scenario.waveHeight;
    this.wavePeriod = scenario.periodSec || scenario.wavePeriod || 1800;
    this.waveDirectionDeg = scenario.directionDeg !== undefined ? scenario.directionDeg : 235;
    this.hasPreDrawdown = !!scenario.hasPreDrawdown;
    this.setupBoundary();
    this.reset();
  }

  setWaveProfile(profile) {
    this.waveProfile = profile;
    this.startTimeSec = profile ? profile.leadInSec() : 0; // skip the quiet lead-in of CSV sources
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
    this.startTimeSec = 0;
    if (height !== undefined) this.waveHeight = height;
    if (period !== undefined) this.wavePeriod = period;
    if (direction !== undefined) {
      this.waveDirectionDeg = direction;
      this.setupBoundary();
    }
  }

  reset() {
    this.simTimeSec = this.startTimeSec;
    this.history = [];
    this.lastLogSec = this.startTimeSec - 100;
    this.initWater();
    this.updateStats();
  }

  getOffshoreWaveEta(t) {
    if (this.waveProfile) {
      // CSV level × Green's law correction from the CSV point to the input zone × the user's multiplier
      return this.waveProfile.getEta(t) * (this.shoalFactor ?? 1) * (this.profileScale ?? 1);
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

    // 1. Boundary: relax the water level in the bay-edge zone towards the incident wave
    if (!this.bcCells) this.setupBoundary();
    const { bcCells, bcDelay, bcWeight, bcEta } = this;
    for (let k = 0; k < bcCells.length; k++) {
      const idx = bcCells[k];
      const e = this.bcInput[k] * this.getOffshoreWaveEta(this.simTimeSec - bcDelay[k]) * INCIDENT_FACTOR;
      bcEta[k] = e;
      const target = this.eta[idx] + (e - this.eta[idx]) * bcWeight[k];
      this.eta[idx] = Math.max(this.ground[idx], target);
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
        // θ-weighted flux (de Almeida et al. 2012): blend with the neighbouring fluxes to damp the
        // checkerboard instability of the local inertial scheme in deep water
        const qL = x > 0 ? qxPrev[i0 - 1] : qOld;
        const qR = x < nx - 2 ? qxPrev[i0 + 1] : qOld;
        const qTheta = THETA * qOld + (1 - THETA) * 0.5 * (qL + qR);
        const S_h = (eta0 - eta1) / res;
        const denom = 1 + g * dt * n2 * Math.abs(qOld) / Math.pow(hFlow, 7 / 3);
        const qNew = (qTheta + g * hFlow * dt * S_h) / denom;
        const maxQ = hFlow * Math.sqrt(g * hFlow) * 1.5; // Froude limiter
        this.qx[i0] = Math.max(-maxQ, Math.min(maxQ, qNew));
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
        const qU = y > 0 ? qyPrev[i0 - nx] : qOld;
        const qD = y < ny - 2 ? qyPrev[i0 + nx] : qOld;
        const qTheta = THETA * qOld + (1 - THETA) * 0.5 * (qU + qD);
        const S_h = (eta0 - eta1) / res;
        const denom = 1 + g * dt * n2 * Math.abs(qOld) / Math.pow(hFlow, 7 / 3);
        const qNew = (qTheta + g * hFlow * dt * S_h) / denom;
        const maxQ = hFlow * Math.sqrt(g * hFlow) * 1.5;
        this.qy[i0] = Math.max(-maxQ, Math.min(maxQ, qNew));
      }
    }

    // Relax the discharge in the bay-edge zone towards the incident long-wave flux q = eta * sqrt(g h)
    // (only on faces between two water cells, never across a quay wall)
    for (let k = 0; k < bcCells.length; k++) {
      const idx = bcCells[k];
      const h = Math.max(0.5, bcEta[k] - this.ground[idx]);
      const q = bcEta[k] * Math.sqrt(g * h);
      const w = bcWeight[k];
      if (idx % nx < nx - 1 && !this.isLand(idx + 1)) this.qx[idx] += (q * this.kE - this.qx[idx]) * w;
      if (idx < (ny - 1) * nx && !this.isLand(idx + nx)) this.qy[idx] += (-q * this.kN - this.qy[idx]) * w; // +y (row) = south
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

        if (newH >= 0.3 && this.arrival[idx] < 0 && this.isLand(idx)) {
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
    const { N, ground, depth } = this;
    let inundatedLandCells = 0;
    let maxRunup = 0;

    for (let i = 0; i < N; i++) {
      if (depth[i] >= 0.05 && this.isLand(i)) {
        inundatedLandCells++;
        const waterElev = ground[i] + depth[i];
        if (waterElev > maxRunup) maxRunup = waterElev;
      }
    }

    const cellAreaM2 = this.res * this.res;
    const areaHa = (inundatedLandCells * cellAreaM2) / 10000;

    this.stats.simTimeSec = this.simTimeSec;
    this.stats.simTimeMin = this.simTimeSec / 60;
    this.stats.maxRunup = maxRunup;
    this.stats.inundatedAreaHa = areaHa;
  }

  logHistory() {
    this.history.push({
      timeSec: Math.round(this.simTimeSec),
      waveHeight: +this.stats.offshoreWaveHeight.toFixed(2),
      maxRunup: +this.stats.maxRunup.toFixed(2),
      areaHa: +this.stats.inundatedAreaHa.toFixed(1),
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
}
