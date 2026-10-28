/**
 * Runs the tsunami simulation off the main thread so the UI and 3D view stay responsive.
 * Posts downsampled render frames (eta / depth / foam) plus stats; frame buffers are
 * recycled between threads to avoid per-frame allocations.
 */
import { TsunamiSimulator } from './tsunamiSim.js';
import { WaveProfile } from './waveProfile.js';

const FRAME_BUDGET_MS = 30; // wall time spent stepping between posted frames at speed 1x
const MAX_POOL = 3;

let sim = null;
let barriers = null;
let step = 2;
let wnx = 0;
let wny = 0;
let playing = false;
let speed = 1; // UI speed slider: longer stepping between frames = more simulated time per second
let point = null;
const pool = [];
let allocated = 0;

function allocFrame() {
  const n = wnx * wny;
  return {
    eta: new Float32Array(n),
    depth: new Float32Array(n),
    maxDepth: new Float32Array(n),
    foam: new Uint8Array(n),
    bldgWet: new Uint8Array(sim.buildings.length),
  };
}

function takeFrame(force) {
  if (pool.length) return pool.pop();
  if (allocated < MAX_POOL || force) {
    allocated++;
    return allocFrame();
  }
  return null;
}

let prevEta = null;
let prevTime = 0;

function fillFrame(f) {
  const { nx, ny, res, eta, depth, qx, qy, ground } = sim;
  if (!prevEta || prevEta.length !== wnx * wny || sim.simTimeSec < prevTime) {
    prevEta = new Float32Array(wnx * wny);
    for (let j = 0; j < wny; j++) {
      for (let i = 0; i < wnx; i++) {
        prevEta[j * wnx + i] = eta[Math.min(ny - 1, j * step) * nx + Math.min(nx - 1, i * step)];
      }
    }
    prevTime = sim.simTimeSec;
  }
  const dtPost = sim.simTimeSec - prevTime;
  for (let j = 0; j < wny; j++) {
    const sy = Math.min(ny - 1, j * step);
    for (let i = 0; i < wnx; i++) {
      const sx = Math.min(nx - 1, i * step);
      const s = sy * nx + sx;
      const v = j * wnx + i;
      const d = depth[s];
      f.eta[v] = eta[s];
      f.depth[v] = d;
      f.maxDepth[v] = sim.maxDepth[s];

      // Foam calculation for breaking / rapid water
      let foam = 0;
      if (d > 0.05) {
        const u = 0.5 * (qx[s] + (sx > 0 ? qx[s - 1] : qx[s])) / d;
        const w = 0.5 * (qy[s] + (sy > 0 ? qy[s - nx] : qy[s])) / d;
        const fr = Math.hypot(u, w) / Math.sqrt(9.80665 * d);
        foam = Math.max(0, Math.min(1, (fr - 0.6) / 0.9));
        if (d > 5) foam *= Math.max(0, 1 - (d - 5) / 5);
        if (ground[s] < 0) foam *= 0.7;
        if (dtPost > 0.5) {
          const rise = (eta[s] - prevEta[v]) / dtPost;
          foam = Math.max(foam, Math.min(0.85, Math.max(0, (rise - 0.04) / 0.12)));
        }
      }
      if (dtPost > 0.5) prevEta[v] = eta[s];
      f.foam[v] = Math.round(foam * 255);
    }
  }
  if (dtPost > 0.5) prevTime = sim.simTimeSec;

  for (let k = 0; k < sim.buildings.length; k++) f.bldgWet[k] = sim.buildingFlooded(k) ? 1 : 0;
}

function post(reqId, force = false) {
  const f = takeFrame(force);
  if (!f) return false;
  fillFrame(f);
  sim.updateStats();
  const pt = point ? sim.getPointDepth(point.worldX, point.worldZ) : null;
  self.postMessage(
    { type: 'frame', reqId, frame: f, stats: { ...sim.stats }, simTimeSec: sim.simTimeSec, point: pt },
    [f.eta.buffer, f.depth.buffer, f.maxDepth.buffer, f.foam.buffer, f.bldgWet.buffer]
  );
  return true;
}

// Ahead-of-playback computation: run to `end`, posting a compact keyframe every `interval`
// simulated seconds (water level in cm, foam, wet buildings, stats) for timeline playback.
let compute = null;

function postKeyframe() {
  const f = allocFrame();
  fillFrame(f);
  sim.updateStats();
  const eta = new Int16Array(f.eta.length);
  for (let k = 0; k < eta.length; k++) eta[k] = Math.round(Math.max(-327, Math.min(327, f.eta[k])) * 100);
  self.postMessage(
    { type: 'keyframe', t: sim.simTimeSec, eta, foam: f.foam, bldgWet: f.bldgWet, stats: { ...sim.stats }, end: compute.end },
    [eta.buffer, f.foam.buffer, f.bldgWet.buffer]
  );
}

function computeTick() {
  if (!compute) return;
  const t0 = performance.now();
  while (compute && performance.now() - t0 < 100) {
    const remaining = compute.next - sim.simTimeSec;
    if (remaining > 1e-6) {
      sim.step(Math.min(sim.stableDt(), remaining));
      continue;
    }
    postKeyframe();
    compute.next += compute.interval;
    if (compute.next > compute.end + 1e-6) {
      self.postMessage({ type: 'computeDone', t: sim.simTimeSec });
      compute = null;
    }
  }
  if (compute) setTimeout(computeTick, 0);
}

function tick() {
  if (!playing || !sim) return;
  const t0 = performance.now();
  do {
    sim.step(sim.stableDt());
  } while (performance.now() - t0 < FRAME_BUDGET_MS * speed);
  post(null);
  setTimeout(tick, 0);
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      step = m.renderStep || 2;
      wnx = Math.floor(m.meta.nx / step);
      wny = Math.floor(m.meta.ny / step);
      barriers = { barrierGrid: m.barrierGrid, barrierActive: m.barrierActive };
      sim = new TsunamiSimulator({
        meta: m.meta,
        ground: m.ground,
        waterMask: m.waterMask,
        seawallManager: barriers,
        buildings: m.buildings,
      });
      pool.length = 0;
      allocated = 0;
      playing = false;
      post(null, true);
      break;
    }
    case 'barriers':
      if (barriers) {
        barriers.barrierGrid = m.barrierGrid;
        barriers.barrierActive = m.barrierActive;
      }
      break;
    case 'scenario': {
      compute = null;
      const sc = { ...m.scenario };
      if (sc.waveProfile) {
        sc.waveProfile = WaveProfile.deserialize(sc.waveProfile);
      }
      sim.setScenario(sc);
      post(null, true);
      break;
    }
    case 'waveProfile':
      compute = null;
      sim.setWaveProfile(WaveProfile.deserialize(m.profile));
      post(null, true);
      break;
    case 'customWave':
      sim.setCustomWave(m.params);
      break;
    case 'waveAdjust':
      compute = null;
      sim.setWaveAdjust(m.params);
      self.postMessage({ type: 'waveAdjust', reqId: m.reqId, bcDepth: sim.bcDepth, shoalFactor: sim.shoalFactor });
      post(null, true);
      break;
    case 'reset':
      compute = null;
      sim.reset();
      post(null, true);
      break;
    case 'play':
      if (!playing) {
        playing = true;
        tick();
      }
      break;
    case 'pause':
      playing = false;
      break;
    case 'speed':
      speed = m.speed;
      break;
    case 'compute':
      playing = false;
      compute = { end: sim.simTimeSec + m.durationSec, interval: m.intervalSec, next: sim.simTimeSec };
      computeTick();
      break;
    case 'cancelCompute':
      compute = null;
      break;
    case 'point':
      point = m.point;
      if (!playing) post(null, true); // show the point's depth right away while paused
      break;
    case 'advance':
      sim.advance(m.seconds);
      post(m.reqId, true);
      break;
    case 'recycle':
      if (m.frame && m.frame.eta.length === wnx * wny && pool.length < MAX_POOL) {
        pool.push(m.frame);
      }
      break;
    case 'history':
      self.postMessage({ type: 'history', reqId: m.reqId, history: sim.history });
      break;
  }
};
