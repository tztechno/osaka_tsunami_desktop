import { ShallowWaterSolver } from "./shallowWater.js";
class NestedGrid {
  solver;
  meta;
  name;
  coarse;
  substeps;
  // 外周セルの番号と、粗い格子の周囲4セルの番号・重み
  ringIdx;
  ringCoarseIdx;
  ringWeight;
  ringPrev;
  ringNext;
  constructor(name, meta, rawBathymetry, coarse, coarseMeta) {
    this.name = name;
    this.meta = meta;
    this.coarse = coarse;
    const probe = new ShallowWaterSolver(meta, rawBathymetry, coarse.dt, { nested: true });
    this.substeps = Math.max(1, Math.ceil(coarse.dt / probe.dt - 1e-9));
    this.solver = this.substeps === 1 ? probe : new ShallowWaterSolver(meta, rawBathymetry, coarse.dt / this.substeps, { nested: true });
    this.solver.filterMode = coarse.filterMode;
    this.solver.filterStrength = coarse.filterStrength;
    const W = meta.width;
    const H = meta.height;
    const ring = [];
    for (let c = 0; c < W; c++) ring.push(c, (H - 1) * W + c);
    for (let r = 1; r < H - 1; r++) ring.push(r * W, r * W + W - 1);
    this.ringIdx = Int32Array.from(ring);
    this.ringCoarseIdx = new Int32Array(ring.length * 4);
    this.ringWeight = new Float32Array(ring.length * 4);
    this.ringPrev = new Float32Array(ring.length);
    this.ringNext = new Float32Array(ring.length);
    const fb = meta.bounds;
    const cb = coarseMeta.bounds;
    const CW = coarseMeta.width;
    const CH = coarseMeta.height;
    ring.forEach((idx, k) => {
      const r = Math.floor(idx / W);
      const c = idx - r * W;
      const lon = fb.lonMin + (c + 0.5) / W * (fb.lonMax - fb.lonMin);
      const lat = fb.latMax - (r + 0.5) / H * (fb.latMax - fb.latMin);
      const cx = (lon - cb.lonMin) / (cb.lonMax - cb.lonMin) * CW - 0.5;
      const cy = (cb.latMax - lat) / (cb.latMax - cb.latMin) * CH - 0.5;
      const c0 = Math.floor(cx);
      const r0 = Math.floor(cy);
      const fx = cx - c0;
      const fy = cy - r0;
      let sum = 0;
      for (let j = 0; j < 4; j++) {
        const cc = Math.min(CW - 1, Math.max(0, c0 + (j & 1)));
        const rr = Math.min(CH - 1, Math.max(0, r0 + (j >> 1)));
        const ci = rr * CW + cc;
        const w = coarse.depth[ci] > 1 ? (j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy) : 0;
        this.ringCoarseIdx[k * 4 + j] = ci;
        this.ringWeight[k * 4 + j] = w;
        sum += w;
      }
      for (let j = 0; j < 4; j++) this.ringWeight[k * 4 + j] = sum > 1e-6 ? this.ringWeight[k * 4 + j] / sum : 0;
    });
  }
  contains(lon, lat) {
    const b = this.meta.bounds;
    return lon >= b.lonMin && lon <= b.lonMax && lat >= b.latMin && lat <= b.latMax;
  }
  set observationPoints(points) {
    this.solver.observationPoints = points;
  }
  get observationPoints() {
    return this.solver.observationPoints;
  }
  /**
   * 粗い格子の現在の水位を外周セルの位置に補間
   */
  sampleRing(out) {
    const eta = this.coarse.eta;
    for (let k = 0; k < out.length; k++) {
      const o = k * 4;
      out[k] = this.ringWeight[o] * eta[this.ringCoarseIdx[o]] + this.ringWeight[o + 1] * eta[this.ringCoarseIdx[o + 1]] + this.ringWeight[o + 2] * eta[this.ringCoarseIdx[o + 2]] + this.ringWeight[o + 3] * eta[this.ringCoarseIdx[o + 3]];
    }
  }
  applyRing(a, b, t) {
    const eta = this.solver.eta;
    const depth = this.solver.depth;
    for (let k = 0; k < this.ringIdx.length; k++) {
      const idx = this.ringIdx[k];
      eta[idx] = depth[idx] > 1 ? a[k] + (b[k] - a[k]) * t : 0;
    }
  }
  /**
   * 初期化 (粗い格子を初期化した後に呼ぶ)
   */
  reset(eta0, rupture) {
    this.solver.filterMode = this.coarse.filterMode;
    this.solver.filterStrength = this.coarse.filterStrength;
    this.solver.resetWithDisplacement(eta0, rupture);
    this.sampleRing(this.ringPrev);
    this.applyRing(this.ringPrev, this.ringPrev, 0);
  }
  /**
   * 粗い格子を1ステップ進めた後に呼び、入れ子格子を同じ時刻まで進める
   */
  step() {
    this.sampleRing(this.ringNext);
    for (let k = 0; k < this.substeps; k++) {
      this.applyRing(this.ringPrev, this.ringNext, k / this.substeps);
      this.solver.step();
    }
    this.applyRing(this.ringPrev, this.ringNext, 1);
    this.ringPrev.set(this.ringNext);
    this.solver.currentTimeSec = this.coarse.currentTimeSec;
    if (this.coarse.currentStep % this.coarse.samplingInterval === 0) {
      this.solver.sampleObservationPoints();
    }
  }
}
export {
  NestedGrid
};
