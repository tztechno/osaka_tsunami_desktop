/**
 * Computed-ahead results for playback: keyframes posted by the worker every few simulated seconds
 * (water level in cm on the render grid, foam, wet buildings, stats). Any time within the computed
 * range can be shown by interpolating the water level between the two neighbouring keyframes,
 * which makes fast-forward, rewind and jumps free once the run has been computed.
 */
export class Timeline {
  constructor({ meta, ground, renderStep }) {
    const step = renderStep;
    this.wnx = Math.floor(meta.nx / step);
    this.wny = Math.floor(meta.ny / step);
    const n = this.wnx * this.wny;
    // ground under each render vertex (same sampling as the worker's frames)
    this.ground = new Float32Array(n);
    for (let j = 0; j < this.wny; j++) {
      const sy = Math.min(meta.ny - 1, j * step);
      for (let i = 0; i < this.wnx; i++) {
        this.ground[j * this.wnx + i] = ground[sy * meta.nx + Math.min(meta.nx - 1, i * step)];
      }
    }
    this.step = step;
    this.eta = new Float32Array(n);
    this.depth = new Float32Array(n);
    this.clear();
  }

  clear() {
    this.frames = [];
    this.end = 0; // simulated time the computation runs to
    this.done = false;
  }

  get start() {
    return this.frames.length ? this.frames[0].t : 0;
  }

  /** Last simulated time available for playback. */
  get computedTo() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  get progress() {
    if (this.done) return 1;
    if (!this.frames.length || this.end <= this.start) return 0;
    return (this.computedTo - this.start) / (this.end - this.start);
  }

  add(k) {
    this.frames.push(k);
    this.end = k.end;
  }

  /** Index of the last keyframe at or before t. */
  indexAt(t) {
    const f = this.frames;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Frame data for scene.updateFrame at time t (water level interpolated between keyframes). */
  frameAt(t) {
    const f = this.frames;
    const i = this.indexAt(t);
    const a = f[i];
    const b = f[Math.min(f.length - 1, i + 1)];
    const w = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
    const { eta, depth, ground } = this;
    for (let k = 0; k < eta.length; k++) {
      const e = (a.eta[k] + (b.eta[k] - a.eta[k]) * w) * 0.01;
      eta[k] = e;
      const d = e - ground[k];
      depth[k] = d > 0.02 ? d : 0;
    }
    const near = w < 0.5 ? a : b;
    return { frame: { eta, depth, foam: near.foam, bldgWet: near.bldgWet }, stats: near.stats, simTimeSec: t };
  }

  /** Water depth over time at a render vertex, up to time t. */
  seriesAt(vertex, t) {
    const out = [];
    for (const k of this.frames) {
      if (k.t > t) break;
      out.push({ timeSec: k.t, depth: Math.max(0, k.eta[vertex] * 0.01 - this.ground[vertex]) });
    }
    return out;
  }
}
