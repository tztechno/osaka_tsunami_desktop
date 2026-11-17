/**
 * 15" (about 400 m) nested grid on the tsunami's route into Osaka, computed only where it matters: the route box
 * (tools/build-nankai-route.mjs) is cut into ROUTE_TILE x ROUTE_TILE tiles (0.125°), and a tile is computed at 400 m
 * when it holds sea shallower than ROUTE_SHALLOW_M (Osaka Bay, Kii Channel, Harima-nada, the shelf off Kii and
 * Shikoku). Elsewhere the wide 1.5' grid alone carries the wave:
 *   - cells of inactive tiles next to active sea become extra ring cells of the NestedGrid, whose level comes from
 *     the coarse grid every substep (as on the box's outer ring); their depth is capped at the deepest active cell
 *     so the fine time step is set by the active tiles
 *   - the other inactive cells are made land, so the solver skips them
 */
export const ROUTE_TILE = 30;
export const ROUTE_SHALLOW_M = 200;

/** meta / raw: the route box's bathymetry. Returns { bathy, ring, active, tiles: { total, active }, cells }. */
export function buildRouteGrid(meta, raw) {
  const W = meta.width, H = meta.height, T = ROUTE_TILE;
  const TW = Math.ceil(W / T), TH = Math.ceil(H / T);
  const tileOn = new Uint8Array(TW * TH);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const z = raw[r * W + c];
      if (z < -1 && z > -ROUTE_SHALLOW_M) tileOn[Math.floor(r / T) * TW + Math.floor(c / T)] = 1;
    }
  }
  const active = new Uint8Array(W * H);
  let maxActiveDepth = 0, cells = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const k = r * W + c;
      if (!tileOn[Math.floor(r / T) * TW + Math.floor(c / T)]) continue;
      active[k] = 1;
      cells++;
      if (-raw[k] > maxActiveDepth) maxActiveDepth = -raw[k];
    }
  }
  const bathy = new Int16Array(W * H); // 0 = land
  const ring = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const k = r * W + c;
      if (active[k]) { bathy[k] = raw[k]; continue; }
      if (raw[k] >= -1) continue;
      // sea of an inactive tile touching (8 neighbours: the solver's flux averages reach diagonally) active sea
      let edge = false;
      for (let dr = -1; dr <= 1 && !edge; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          const q = rr * W + cc;
          if (active[q] && raw[q] < -1) { edge = true; break; }
        }
      }
      if (!edge) continue;
      bathy[k] = Math.max(raw[k], -maxActiveDepth);
      ring.push(k);
    }
  }
  let nTiles = 0;
  for (const v of tileOn) nTiles += v;
  return { bathy, ring: Int32Array.from(ring), active, tiles: { total: TW * TH, active: nTiles }, cells, maxActiveDepth };
}
