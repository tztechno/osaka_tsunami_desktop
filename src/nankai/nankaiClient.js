/**
 * Runs nankaiWorker to compute boundary multi-station wave sources from a fault CSV.
 */

const FAULT_HEADER_TOKENS = new Set([
  'strike', 'strike_deg', '走向',
  'dip', 'dip_deg', '傾斜', '傾斜角',
  'rake', 'rake_deg', 'すべり角',
  'slip', 'slip_m', 'slip_cm', 'すべり量',
  'top_depth_km', 'center_depth_km', 'length_km', 'width_km',
]);

/**
 * Distinguish a fault-model CSV from a time-series wave-source CSV by inspecting the header line.
 */
export function isFaultCsv(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line
      .split(/[,\t;]/)
      .map((c) => c.trim().replace(/^"|"$/g, '').replace(/[（(][^)）]*[)）]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
    let hits = 0;
    for (const c of cols) {
      if (FAULT_HEADER_TOKENS.has(c)) hits++;
    }
    return hits >= 2;
  }
  return false;
}

/**
 * Start computing edge waves in a dedicated Web Worker.
 * Returns { promise, cancel }.
 */
export function runNankaiFaultWorker({ faults, rupture, durationSec = 10800, onProgress }) {
  const worker = new Worker(new URL('./nankaiWorker.js', import.meta.url), { type: 'module' });
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        onProgress?.(m);
      } else if (m.type === 'done') {
        settled = true;
        worker.terminate();
        resolve(m);
      } else if (m.type === 'error') {
        settled = true;
        worker.terminate();
        reject(new Error(m.message || 'Nankai solver error'));
      }
    };
    worker.onerror = (err) => {
      if (!settled) {
        settled = true;
        worker.terminate();
        reject(new Error(err?.message || 'Nankai worker error'));
      }
    };
    const baseUrl = new URL('.', window.location.href).href;
    worker.postMessage({ type: 'run', faults, rupture, durationSec, baseUrl });
  });

  const cancel = () => {
    if (!settled) {
      settled = true;
      worker.terminate();
    }
  };

  return { promise, cancel };
}
