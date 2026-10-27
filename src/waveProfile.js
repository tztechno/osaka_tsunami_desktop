/**
 * WaveProfile: Handles time-series boundary wave conditions from CSV files
 * produced by the nankai_trough application or custom ocean simulations.
 *
 * Supports metadata header comments (# ...) and CSV rows with:
 *   Time_sec, Elevation_m, U_velocity_m_s, V_velocity_m_s, Speed_m_s, Direction_deg, ...
 */

const LEAD_IN_FRACTION = 0.5;
const LEAD_IN_MARGIN_SEC = 300;

export class WaveProfile {
  constructor({
    name = 'Custom Wave Source',
    filename = '',
    location = '',
    lon = null,
    lat = null,
    mode = '',
    maxSurge = 0,
    firstArrival = 0,
    times,
    elevations,
    uVelocities = null,
    vVelocities = null,
    speeds = null,
    directions = null,
    dominantDirectionDeg = 235,
    timeOffset = 0,
    rawText = '',
  }) {
    this.name = name;
    this.filename = filename;
    this.location = location;
    this.lon = lon; // sampling point from the "# Location: ... (Lon: x, Lat: y)" header, null if absent
    this.lat = lat;
    this.mode = mode;
    this.maxSurge = maxSurge;
    this.firstArrival = firstArrival;
    this.timeOffset = timeOffset; // Seconds from earthquake origin to t=0
    this.times = times; // Float32Array (seconds)
    this.elevations = elevations; // Float32Array (meters)
    this.uVelocities = uVelocities;
    this.vVelocities = vVelocities;
    this.speeds = speeds;
    this.directions = directions; // Flow direction (degrees, 0=N, 90=E, 180=S, 270=W)
    this.dominantDirectionDeg = dominantDirectionDeg; // Propagation "comes from" bearing
    this.rawText = rawText;

    this.count = times.length;
    this.tMin = times.length > 0 ? times[0] : 0;
    this.tMax = times.length > 0 ? times[times.length - 1] : 0;
    this.durationSec = Math.max(0, this.tMax - this.tMin);

    // Compute min / max elevation
    let minE = 0;
    let maxE = 0;
    let minT = 0;
    let maxT = 0;
    for (let i = 0; i < this.count; i++) {
      const e = this.elevations[i];
      if (e > maxE) {
        maxE = e;
        maxT = this.times[i];
      }
      if (e < minE) {
        minE = e;
        minT = this.times[i];
      }
    }
    this.peakHeight = maxE;
    this.peakTimeSec = maxT;
    this.troughHeight = minE;
    this.troughTimeSec = minT;
  }

  /**
   * Evaluates the offshore water level eta (m) at time t (seconds) using linear interpolation.
   */
  /**
   * Where to start the simulation in this profile: LEAD_IN_MARGIN_SEC before the water level first
   * reaches LEAD_IN_FRACTION of the peak. nankai_trough's trimmed CSVs start at the first 0.1 m
   * arrival, which in Osaka Bay is followed by more than an hour of slow sub-metre oscillation.
   */
  leadInSec() {
    const threshold = Math.abs(this.peakHeight) * LEAD_IN_FRACTION;
    for (let i = 0; i < this.count; i++) {
      if (Math.abs(this.elevations[i]) >= threshold) return Math.max(this.tMin, this.times[i] - LEAD_IN_MARGIN_SEC);
    }
    return this.tMin;
  }

  getEta(t) {
    const { times, elevations, count, tMin, tMax } = this;
    if (count === 0) return 0.0;
    if (t <= tMin) return elevations[0];
    if (t >= tMax) return elevations[count - 1];

    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (times[mid] <= t) {
        if (mid === count - 1 || times[mid + 1] > t) {
          const t0 = times[mid];
          const t1 = times[mid + 1];
          const alpha = (t - t0) / (t1 - t0);
          return elevations[mid] * (1.0 - alpha) + elevations[mid + 1] * alpha;
        }
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return elevations[0];
  }

  /**
   * Evaluates flow velocity vector (u, v) in m/s at time t (seconds).
   */
  getVelocity(t) {
    const { times, uVelocities, vVelocities, count, tMin, tMax } = this;
    if (!uVelocities || !vVelocities || count === 0) return { u: 0, v: 0, speed: 0 };
    if (t <= tMin) return { u: uVelocities[0], v: vVelocities[0], speed: this.speeds ? this.speeds[0] : 0 };
    if (t >= tMax) return { u: uVelocities[count - 1], v: vVelocities[count - 1], speed: this.speeds ? this.speeds[count - 1] : 0 };

    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (times[mid] <= t) {
        if (mid === count - 1 || times[mid + 1] > t) {
          const t0 = times[mid];
          const t1 = times[mid + 1];
          const alpha = (t - t0) / (t1 - t0);
          const u = uVelocities[mid] * (1 - alpha) + uVelocities[mid + 1] * alpha;
          const v = vVelocities[mid] * (1 - alpha) + vVelocities[mid + 1] * alpha;
          return { u, v, speed: Math.hypot(u, v) };
        }
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return { u: 0, v: 0, speed: 0 };
  }

  serialize() {
    return {
      name: this.name,
      filename: this.filename,
      location: this.location,
      lon: this.lon,
      lat: this.lat,
      mode: this.mode,
      maxSurge: this.maxSurge,
      firstArrival: this.firstArrival,
      timeOffset: this.timeOffset,
      times: this.times,
      elevations: this.elevations,
      uVelocities: this.uVelocities,
      vVelocities: this.vVelocities,
      speeds: this.speeds,
      directions: this.directions,
      dominantDirectionDeg: this.dominantDirectionDeg,
      rawText: this.rawText,
    };
  }

  static deserialize(obj) {
    if (!obj) return null;
    return new WaveProfile(obj);
  }

  getEqTimeSec(t) {
    return t + this.timeOffset;
  }

  static parse(csvText, filename = 'nankai_trough.csv') {
    if (!csvText || typeof csvText !== 'string') {
      throw new Error('Invalid CSV text provided');
    }

    const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let location = '';
    let lon = null;
    let lat = null;
    let mode = '';
    let maxSurgeMeta = null;
    let firstArrivalMeta = null;
    let timeOffsetMeta = null;

    let headerLineIdx = -1;
    let headerCols = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#')) {
        const comment = line.slice(1).trim();
        const mLoc = comment.match(/Location:\s*(.+)$/i);
        if (mLoc) {
          location = mLoc[1].trim();
          const mLon = location.match(/Lon:\s*([+-]?[0-9.]+)/i);
          const mLat = location.match(/Lat:\s*([+-]?[0-9.]+)/i);
          if (mLon && mLat) {
            lon = parseFloat(mLon[1]);
            lat = parseFloat(mLat[1]);
          }
        }

        const mMode = comment.match(/Mode:\s*(.+)$/i);
        if (mMode) mode = mMode[1].trim();

        const mSurge = comment.match(/Max\s*(?:Surge|Wave\s*Height):\s*([0-9.]+)\s*m/i);
        if (mSurge) maxSurgeMeta = parseFloat(mSurge[1]);

        const mArrival = comment.match(/First\s*Arrival:\s*([0-9.]+)\s*s/i);
        if (mArrival) firstArrivalMeta = parseFloat(mArrival[1]);

        const mOffset = comment.match(/Time\s*Offset:\s*([+-]?[0-9.]+)\s*s/i) || comment.match(/Absolute_Time_sec\s*=\s*Time_sec\s*([+-]\s*[0-9.]+)/i);
        if (mOffset) {
          const val = parseFloat(mOffset[1].replace(/\s+/g, ''));
          if (!Number.isNaN(val)) timeOffsetMeta = Math.abs(val);
        }
        continue;
      }

      headerLineIdx = i;
      headerCols = line.split(',').map((c) => c.trim().toLowerCase());
      break;
    }

    if (headerLineIdx === -1 || headerCols.length === 0) {
      throw new Error('CSV header line not found');
    }

    const findCol = (...names) => {
      for (const n of names) {
        const idx = headerCols.findIndex((c) => c === n.toLowerCase() || c.includes(n.toLowerCase()));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const colTime = findCol('time_sec', 'time(sec)', 'time', 't');
    const colElev = findCol('elevation_m', 'elevation', 'eta', 'water_level', 'height_m', 'wave_height');
    const colU = findCol('u_velocity_m_s', 'u_velocity', 'u');
    const colV = findCol('v_velocity_m_s', 'v_velocity', 'v');
    const colSpeed = findCol('speed_m_s', 'speed', 'velocity');
    const colDir = findCol('direction_deg', 'direction', 'dir');
    const colEqTime = findCol('time_since_eq_sec', 'time_since_eq', 'time_since_earthquake');

    if (colTime === -1 || colElev === -1) {
      throw new Error(`CSV is missing required columns. Required: Time and Elevation. Found columns: ${headerCols.join(', ')}`);
    }

    const parsedTimes = [];
    const parsedElevs = [];
    const parsedU = colU !== -1 ? [] : null;
    const parsedV = colV !== -1 ? [] : null;
    const parsedSpeed = colSpeed !== -1 ? [] : null;
    const parsedDir = colDir !== -1 ? [] : null;
    const parsedEqTime = colEqTime !== -1 ? [] : null;

    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(',');
      if (parts.length <= Math.max(colTime, colElev)) continue;

      const t = parseFloat(parts[colTime]);
      const e = parseFloat(parts[colElev]);
      if (Number.isNaN(t) || Number.isNaN(e)) continue;

      parsedTimes.push(t);
      parsedElevs.push(e);

      if (parsedU && parts[colU] !== undefined) parsedU.push(parseFloat(parts[colU]) || 0);
      if (parsedV && parts[colV] !== undefined) parsedV.push(parseFloat(parts[colV]) || 0);
      if (parsedSpeed && parts[colSpeed] !== undefined) parsedSpeed.push(parseFloat(parts[colSpeed]) || 0);
      if (parsedDir && parts[colDir] !== undefined) parsedDir.push(parseFloat(parts[colDir]) || 0);
      if (parsedEqTime && parts[colEqTime] !== undefined) parsedEqTime.push(parseFloat(parts[colEqTime]) || 0);
    }

    if (parsedTimes.length < 2) {
      throw new Error('CSV has insufficient data rows (at least 2 required)');
    }

    const times = Float32Array.from(parsedTimes);
    const elevations = Float32Array.from(parsedElevs);
    const uVelocities = parsedU ? Float32Array.from(parsedU) : null;
    const vVelocities = parsedV ? Float32Array.from(parsedV) : null;
    const speeds = parsedSpeed ? Float32Array.from(parsedSpeed) : null;
    const directions = parsedDir ? Float32Array.from(parsedDir) : null;

    let timeOffset = 0;
    if (parsedEqTime && parsedEqTime.length > 0) {
      timeOffset = Math.max(0, parsedEqTime[0] - parsedTimes[0]);
    } else if (timeOffsetMeta != null) {
      timeOffset = timeOffsetMeta;
    }

    let dominantDir = 235; // Default coming from SW into Osaka Bay
    if (directions && directions.length > 0) {
      let maxIdx = 0;
      let maxVal = -1e9;
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] > maxVal) {
          maxVal = elevations[i];
          maxIdx = i;
        }
      }
      const peakDir = directions[maxIdx];
      // Direction_deg is the flow direction (nankai_trough); it means nothing while the current is zero
      const peakSpeed = speeds ? speeds[maxIdx] : 1;
      if (!Number.isNaN(peakDir) && peakDir > 0 && peakSpeed > 0.01) {
        dominantDir = Math.round((peakDir + 180) % 360);
      }
    }

    const name = location ? `${location} (波源連携)` : (filename ? filename.replace(/\.csv$/i, '') : '南海トラフ波源データ');

    return new WaveProfile({
      name,
      filename,
      location,
      lon,
      lat,
      mode,
      maxSurge: maxSurgeMeta != null ? maxSurgeMeta : Math.max(...elevations),
      firstArrival: firstArrivalMeta != null ? firstArrivalMeta : 0,
      times,
      elevations,
      uVelocities,
      vVelocities,
      speeds,
      directions,
      dominantDirectionDeg: dominantDir,
      timeOffset,
      rawText: csvText,
    });
  }
}
