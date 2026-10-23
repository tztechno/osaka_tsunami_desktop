/**
 * Main-thread handle for the simulation worker. Holds the latest frame/stats
 * and offers promise-based requests (advance for recording, CSV export).
 */
export class SimClient {
  constructor({ meta, ground, waterMask = null, buildings, seawallMgr, renderStep = 2, onFrame, onKeyframe, onComputeDone }) {
    this.onKeyframe = onKeyframe;
    this.onComputeDone = onComputeDone;
    this.meta = meta;
    this.waterMask = waterMask;
    this.onFrame = onFrame;
    this.stats = null;
    this.simTimeSec = 0;
    this.point = null;
    this.frame = null;
    this.pending = new Map();
    this.nextReq = 1;

    this.worker = new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => console.error('Simulation worker error:', e.message || e);
    this.worker.postMessage({
      type: 'init',
      meta,
      ground: ground.slice(),
      waterMask: waterMask ? waterMask.slice() : null,
      buildings,
      renderStep,
      barrierGrid: seawallMgr.barrierGrid.slice(),
      barrierActive: seawallMgr.barrierActive.slice(),
    });
  }

  handle(m) {
    if (m.type === 'frame') {
      if (this.frame) this.recycle(this.frame);
      this.frame = m.frame;
      this.stats = m.stats;
      this.simTimeSec = m.simTimeSec;
      this.point = m.point;
      this.onFrame?.(m);
      if (m.reqId != null) {
        this.pending.get(m.reqId)?.(m);
        this.pending.delete(m.reqId);
      }
    } else if (m.type === 'keyframe') {
      this.onKeyframe?.(m);
    } else if (m.type === 'computeDone') {
      this.onComputeDone?.(m);
    } else if (m.type === 'history') {
      this.pending.get(m.reqId)?.(m.history);
      this.pending.delete(m.reqId);
    }
  }

  recycle(frame) {
    this.worker.postMessage(
      { type: 'recycle', frame },
      [frame.eta.buffer, frame.depth.buffer, frame.maxDepth.buffer, frame.foam.buffer, frame.bldgWet.buffer]
    );
  }

  request(msg) {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage({ ...msg, reqId });
    });
  }

  setBarriers(seawallMgr) {
    this.worker.postMessage({
      type: 'barriers',
      barrierGrid: seawallMgr.barrierGrid.slice(),
      barrierActive: seawallMgr.barrierActive.slice(),
    });
  }

  setScenario(scenario) {
    const sc = { ...scenario };
    if (sc.waveProfile && typeof sc.waveProfile.serialize === 'function') {
      sc.waveProfile = sc.waveProfile.serialize();
    }
    this.worker.postMessage({ type: 'scenario', scenario: sc });
  }

  setWaveProfile(profile) {
    const serialized = profile && typeof profile.serialize === 'function' ? profile.serialize() : profile;
    this.worker.postMessage({ type: 'waveProfile', profile: serialized });
  }

  setCustomWave(params) {
    this.worker.postMessage({ type: 'customWave', params });
  }

  reset() {
    this.worker.postMessage({ type: 'reset' });
  }

  play() {
    this.worker.postMessage({ type: 'play' });
  }

  /** Compute `durationSec` ahead from the current state, posting keyframes every `intervalSec`. */
  compute(durationSec, intervalSec) {
    this.worker.postMessage({ type: 'compute', durationSec, intervalSec });
  }

  cancelCompute() {
    this.worker.postMessage({ type: 'cancelCompute' });
  }

  setSpeed(speed) {
    this.worker.postMessage({ type: 'speed', speed });
  }

  pause() {
    this.worker.postMessage({ type: 'pause' });
  }

  setPoint(point) {
    this.worker.postMessage({ type: 'point', point });
  }

  advance(seconds) {
    return this.request({ type: 'advance', seconds });
  }

  /** Area-wide stats logged every 10 s of the computed run: [{ timeSec, waveHeight, maxRunup, areaHa }] */
  history() {
    return this.request({ type: 'history' });
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
