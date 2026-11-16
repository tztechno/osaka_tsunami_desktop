const RIGIDITY = 4e10;
const MSG = {
  ja: {
    line: (n) => `${n}\u884C\u76EE`,
    headerLine: (n) => `${n}\u884C\u76EE (\u898B\u51FA\u3057\u884C)`,
    missingCols: (c) => `\u5FC5\u8981\u306A\u5217\u304C\u3042\u308A\u307E\u305B\u3093: ${c}`,
    or: "\u307E\u305F\u306F",
    ambiguousDepth: '\u5217 "depth" \u306F\u4E0A\u7AEF\u304B\u4E2D\u5FC3\u304B\u304C\u66D6\u6627\u3067\u3059\u3002top_depth_km \u307E\u305F\u306F center_depth_km \u3092\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002',
    notNumber: (c) => `${c} \u304C\u6570\u5024\u3067\u306F\u3042\u308A\u307E\u305B\u3093`,
    noSlip: "slip_m (\u307E\u305F\u306F slip_cm) \u304C\u3042\u308A\u307E\u305B\u3093",
    noDepth: "top_depth_km (\u307E\u305F\u306F center_depth_km) \u304C\u3042\u308A\u307E\u305B\u3093",
    lonLatRange: "\u7D4C\u5EA6\u30FB\u7DEF\u5EA6\u304C\u7BC4\u56F2\u5916\u3067\u3059",
    outsideDomain: (lon, lat, d) => `\u65AD\u5C64\u306E\u4E2D\u5FC3 (${lon}, ${lat}) \u304C\u8A08\u7B97\u7BC4\u56F2 (${d.lonMin.toFixed(2)}\u301C${d.lonMax.toFixed(2)}\xB0E, ${d.latMin.toFixed(2)}\u301C${d.latMax.toFixed(2)}\xB0N) \u306E\u5916\u3067\u3059`,
    length: "length_km \u306F 0 \u3088\u308A\u5927\u304D\u304F 2000 \u4EE5\u4E0B\u306B\u3057\u3066\u304F\u3060\u3055\u3044",
    width: "width_km \u306F 0 \u3088\u308A\u5927\u304D\u304F 500 \u4EE5\u4E0B\u306B\u3057\u3066\u304F\u3060\u3055\u3044",
    dip: "dip_deg \u306F 0 \u3088\u308A\u5927\u304D\u304F 90 \u4EE5\u4E0B\u306B\u3057\u3066\u304F\u3060\u3055\u3044",
    rake: "rake_deg \u306F \u2212360\u301C360 \u306B\u3057\u3066\u304F\u3060\u3055\u3044",
    slip: "\u3059\u3079\u308A\u91CF\u306F 0\u301C200 m \u306B\u3057\u3066\u304F\u3060\u3055\u3044 (\u5411\u304D\u306F rake_deg \u3067\u6307\u5B9A)",
    topNeg: "top_depth_km \u304C\u8CA0\u3067\u3059",
    centerNeg: (t) => `center_depth_km \u304B\u3089\u6C42\u3081\u305F\u4E0A\u7AEF\u6DF1\u3055\u304C\u8CA0\u306B\u306A\u308A\u307E\u3059 (${t} km)\u3002\u4E2D\u5FC3\u6DF1\u3055\u30FB\u5E45\u30FB\u50BE\u659C\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`,
    tooMany: (n) => `\u65AD\u5C64\u306F\u6700\u5927 ${n} \u884C\u307E\u3067\u3067\u3059`,
    noHeader: "\u898B\u51FA\u3057\u884C\u3068\u30C7\u30FC\u30BF\u884C\u304C\u3042\u308A\u307E\u305B\u3093",
    noRows: "\u65AD\u5C64\u306E\u30C7\u30FC\u30BF\u884C\u304C\u3042\u308A\u307E\u305B\u3093",
    ruptureNeedsHypo: "rupture_velocity_km_s \u3092\u4F7F\u3046\u306B\u306F hypocenter_lon \u3068 hypocenter_lat \u3082\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044"
  },
  en: {
    line: (n) => `Line ${n}`,
    headerLine: (n) => `Line ${n} (header)`,
    missingCols: (c) => `required columns are missing: ${c}`,
    or: "or",
    ambiguousDepth: 'column "depth" is ambiguous (top or center?). Use top_depth_km or center_depth_km.',
    notNumber: (c) => `${c} is not a number`,
    noSlip: "slip_m (or slip_cm) is missing",
    noDepth: "top_depth_km (or center_depth_km) is missing",
    lonLatRange: "longitude/latitude out of range",
    outsideDomain: (lon, lat, d) => `fault center (${lon}, ${lat}) is outside the computational domain (${d.lonMin.toFixed(2)}\u2013${d.lonMax.toFixed(2)}\xB0E, ${d.latMin.toFixed(2)}\u2013${d.latMax.toFixed(2)}\xB0N)`,
    length: "length_km must be > 0 and \u2264 2000",
    width: "width_km must be > 0 and \u2264 500",
    dip: "dip_deg must be > 0 and \u2264 90",
    rake: "rake_deg must be between \u2212360 and 360",
    slip: "slip must be 0\u2013200 m (give the direction with rake_deg)",
    topNeg: "top_depth_km is negative",
    centerNeg: (t) => `the top depth derived from center_depth_km is negative (${t} km). Check center depth, width and dip`,
    tooMany: (n) => `at most ${n} fault rows are allowed`,
    noHeader: "no header line or data rows",
    noRows: "no fault data rows",
    ruptureNeedsHypo: "rupture_velocity_km_s requires hypocenter_lon and hypocenter_lat"
  }
};
const MAX_FAULT_ROWS = 5e3;
const ALIASES = {
  name: "name",
  fault: "name",
  id: "name",
  "\u540D\u524D": "name",
  "\u65AD\u5C64\u540D": "name",
  lon: "lon",
  longitude: "lon",
  center_lon: "lon",
  "\u7D4C\u5EA6": "lon",
  lat: "lat",
  latitude: "lat",
  center_lat: "lat",
  "\u7DEF\u5EA6": "lat",
  top_depth_km: "top",
  top_depth: "top",
  depth_top_km: "top",
  "\u4E0A\u7AEF\u6DF1\u3055": "top",
  center_depth_km: "center",
  center_depth: "center",
  depth_center_km: "center",
  "\u4E2D\u5FC3\u6DF1\u3055": "center",
  length_km: "length",
  length: "length",
  "\u9577\u3055": "length",
  width_km: "width",
  width: "width",
  "\u5E45": "width",
  strike_deg: "strike",
  strike: "strike",
  "\u8D70\u5411": "strike",
  dip_deg: "dip",
  dip: "dip",
  "\u50BE\u659C": "dip",
  "\u50BE\u659C\u89D2": "dip",
  rake_deg: "rake",
  rake: "rake",
  "\u3059\u3079\u308A\u89D2": "rake",
  slip_m: "slipM",
  slip: "slipM",
  "\u3059\u3079\u308A\u91CF": "slipM",
  slip_cm: "slipCm"
};
function normalizeHeader(h) {
  return h.trim().replace(/^"|"$/g, "").replace(/[（(][^)）]*[)）]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function detectDelimiter(line) {
  if (line.includes("	")) return "	";
  if (!line.includes(",") && line.includes(";")) return ";";
  return ",";
}
function splitLine(line, delim) {
  return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, "").trim());
}
function momentMagnitude(faults) {
  let m0 = 0;
  for (const f of faults) m0 += RIGIDITY * Math.abs(f.slipM) * f.lengthKm * 1e3 * f.widthKm * 1e3;
  return m0 > 0 ? (Math.log10(m0) - 9.1) / 1.5 : 0;
}
function parseFaultCsv(text, domain, lang = "ja") {
  const t = MSG[lang];
  const errors = [];
  const meta = {};
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let header = null;
  let delim = ",";
  const faults = [];
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li].trim();
    const lineNo = li + 1;
    if (!raw) continue;
    if (raw.startsWith("#")) {
      for (const m of raw.matchAll(/([a-z_]+)\s*[=:]\s*(-?[\d.]+(?:e-?\d+)?)/gi)) {
        meta[m[1].toLowerCase()] = parseFloat(m[2]);
      }
      continue;
    }
    if (!header) {
      delim = detectDelimiter(raw);
      const cols = splitLine(raw, delim).map(normalizeHeader);
      header = cols.map((c) => ALIASES[c] ?? null);
      const has = (f) => header.includes(f);
      const missing = [];
      if (!has("lon")) missing.push("lon");
      if (!has("lat")) missing.push("lat");
      if (!has("top") && !has("center")) missing.push(`top_depth_km (${t.or} center_depth_km)`);
      if (!has("length")) missing.push("length_km");
      if (!has("width")) missing.push("width_km");
      if (!has("strike")) missing.push("strike_deg");
      if (!has("dip")) missing.push("dip_deg");
      if (!has("rake")) missing.push("rake_deg");
      if (!has("slipM") && !has("slipCm")) missing.push(`slip_m (${t.or} slip_cm)`);
      if (cols.includes("depth") || cols.includes("depth_km")) {
        errors.push(`${t.line(lineNo)}: ${t.ambiguousDepth}`);
      }
      if (missing.length > 0) {
        errors.push(`${t.headerLine(lineNo)}: ${t.missingCols(missing.join(", "))}`);
        return { faults: [], momentMagnitude: 0, errors };
      }
      continue;
    }
    const cells = splitLine(raw, delim);
    const rec = {};
    header.forEach((f, i) => {
      if (f && cells[i] !== void 0 && cells[i] !== "") rec[f] = cells[i];
    });
    const num = (f) => rec[f] === void 0 ? NaN : Number(rec[f]);
    const rowErr = [];
    const need = (f, label) => {
      const v = num(f);
      if (!Number.isFinite(v)) rowErr.push(t.notNumber(label));
      return v;
    };
    const lon = need("lon", "lon");
    const lat = need("lat", "lat");
    const length = need("length", "length_km");
    const width = need("width", "width_km");
    const strike = need("strike", "strike_deg");
    const dip = need("dip", "dip_deg");
    const rake = need("rake", "rake_deg");
    let slip = NaN;
    if (rec.slipM !== void 0) slip = need("slipM", "slip_m");
    else if (rec.slipCm !== void 0) slip = need("slipCm", "slip_cm") / 100;
    else rowErr.push(t.noSlip);
    let top = NaN;
    if (rec.top !== void 0) {
      top = need("top", "top_depth_km");
    } else if (rec.center !== void 0) {
      const center = need("center", "center_depth_km");
      top = center - width / 2 * Math.sin(dip * Math.PI / 180);
    } else {
      rowErr.push(t.noDepth);
    }
    const ok = Number.isFinite;
    if (ok(lon) && ok(lat)) {
      if (lon < -180 || lon > 360 || lat < -90 || lat > 90) rowErr.push(t.lonLatRange);
      else if (domain && (lon < domain.lonMin || lon > domain.lonMax || lat < domain.latMin || lat > domain.latMax)) {
        rowErr.push(t.outsideDomain(lon, lat, domain));
      }
    }
    if (ok(length) && (!(length > 0) || length > 2e3)) rowErr.push(t.length);
    if (ok(width) && (!(width > 0) || width > 500)) rowErr.push(t.width);
    if (ok(dip) && (!(dip > 0) || dip > 90)) rowErr.push(t.dip);
    if (ok(rake) && (rake < -360 || rake > 360)) rowErr.push(t.rake);
    if (ok(slip) && (slip < 0 || slip > 200)) rowErr.push(t.slip);
    if (ok(top) && top < 0) rowErr.push(rec.top !== void 0 ? t.topNeg : t.centerNeg(top.toFixed(2)));
    if (rowErr.length > 0) {
      errors.push(`${t.line(lineNo)}: ${rowErr.join(" / ")}`);
      continue;
    }
    if (faults.length >= MAX_FAULT_ROWS) {
      errors.push(t.tooMany(MAX_FAULT_ROWS));
      break;
    }
    faults.push({
      name: rec.name ?? `F${faults.length + 1}`,
      epicenterLon: lon,
      epicenterLat: lat,
      depthKm: Math.max(0.1, top),
      // 上端が地表ちょうどだと地表で特異になるため 0.1 km を下限にする
      lengthKm: length,
      widthKm: width,
      strikeDeg: (strike % 360 + 360) % 360,
      dipDeg: dip,
      rakeDeg: rake,
      slipM: slip
    });
  }
  if (!header) errors.push(t.noHeader);
  else if (faults.length === 0 && errors.length === 0) errors.push(t.noRows);
  let hypocenter;
  let rupture;
  const hLon = meta["hypocenter_lon"];
  const hLat = meta["hypocenter_lat"];
  if (Number.isFinite(hLon) && Number.isFinite(hLat)) {
    const v = meta["rupture_velocity_km_s"];
    const hasRupture = Number.isFinite(v) && v > 0;
    hypocenter = {
      lon: hLon,
      lat: hLat,
      depthKm: Number.isFinite(meta["hypocenter_depth_km"]) ? meta["hypocenter_depth_km"] : void 0
    };
    if (hasRupture) {
      const rise = meta["rise_time_s"];
      rupture = { lon: hLon, lat: hLat, velocityKmS: v, riseTimeSec: Number.isFinite(rise) && rise > 0 ? rise : 60 };
    }
  } else if (Number.isFinite(meta["rupture_velocity_km_s"])) {
    errors.push(t.ruptureNeedsHypo);
  }
  return { faults, hypocenter, rupture, momentMagnitude: momentMagnitude(faults), errors };
}
function faultsToCsv(faults, title, hypocenter, rupture) {
  const r = (v, d) => Number(v.toFixed(d)).toString();
  const lines = [];
  lines.push(`# Fault model: ${title}`);
  lines.push(`# Mw (rigidity 40 GPa) = ${momentMagnitude(faults).toFixed(2)}, faults = ${faults.length}`);
  lines.push("# lon/lat = center of the surface projection of each fault plane; top_depth_km = depth of the upper edge");
  if (hypocenter) {
    const depth = hypocenter.depthKm !== void 0 ? `, hypocenter_depth_km=${hypocenter.depthKm}` : "";
    lines.push(`# hypocenter_lon=${hypocenter.lon}, hypocenter_lat=${hypocenter.lat}${depth}`);
  }
  if (rupture) {
    lines.push(`# rupture_velocity_km_s=${rupture.velocityKmS}, rise_time_s=${rupture.riseTimeSec}`);
  }
  lines.push("name,lon,lat,top_depth_km,length_km,width_km,strike_deg,dip_deg,rake_deg,slip_m");
  for (const f of faults) {
    const name = f.name.replace(/[",;\t]/g, " ").trim() || "F";
    lines.push([
      name,
      r(f.epicenterLon, 4),
      r(f.epicenterLat, 4),
      r(f.depthKm, 2),
      r(f.lengthKm, 2),
      r(f.widthKm, 2),
      r(f.strikeDeg, 1),
      r(f.dipDeg, 1),
      r(f.rakeDeg, 1),
      r(f.slipM, 2)
    ].join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
export {
  MAX_FAULT_ROWS,
  faultsToCsv,
  momentMagnitude,
  parseFaultCsv
};
