const POISSON = 0.25;
const MU_LAMBDA = 1 - 2 * POISSON;
function chinnery(f, x, p, L, W) {
  return f(x, p) - f(x, p - W) - f(x - L, p) + f(x - L, p - W);
}
function verticalTerms(xi, eta, q, sinD, cosD) {
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  if (R < 1e-6) return [0, 0];
  const dTilde = eta * sinD - q * cosD;
  const X = Math.sqrt(xi * xi + q * q);
  const rEta = Math.max(R + eta, 1e-9);
  const rXi = Math.max(R + xi, 1e-9);
  const rD = Math.max(R + dTilde, 1e-9);
  let I4;
  let I5;
  if (Math.abs(cosD) > 1e-6) {
    I5 = Math.abs(xi) < 1e-9 ? 0 : MU_LAMBDA * (2 / cosD) * Math.atan((eta * (X + q * cosD) + X * (R + X) * sinD) / (xi * (R + X) * cosD));
    I4 = MU_LAMBDA * (1 / cosD) * (Math.log(rD) - sinD * Math.log(rEta));
  } else {
    I5 = -MU_LAMBDA * (xi * sinD) / rD;
    I4 = -MU_LAMBDA * q / rD;
  }
  const atanTerm = Math.abs(q) < 1e-9 ? 0 : Math.atan(xi * eta / (q * R));
  const strike = dTilde * q / (R * rEta) + q * sinD / rEta + I4 * sinD;
  const dip = dTilde * q / (R * rXi) + sinD * atanTerm - I5 * sinD * cosD;
  return [strike, dip];
}
function calculateOkadaVerticalDisplacement(xMeters, yMeters, depthMeters, lengthMeters, widthMeters, dipDeg, rakeDeg, slipMeters) {
  const dipRad = dipDeg * Math.PI / 180;
  const rakeRad = rakeDeg * Math.PI / 180;
  const U1 = slipMeters * Math.cos(rakeRad);
  const U2 = slipMeters * Math.sin(rakeRad);
  const sinD = Math.sin(dipRad);
  const cosD = Math.cos(dipRad);
  const d = depthMeters;
  const p = yMeters * cosD + d * sinD;
  const q = yMeters * sinD - d * cosD;
  const fnStrike = (xi, eta) => verticalTerms(xi, eta, q, sinD, cosD)[0];
  const fnDip = (xi, eta) => verticalTerms(xi, eta, q, sinD, cosD)[1];
  let uz = 0;
  if (Math.abs(U1) > 1e-4) {
    uz += U1 * chinnery(fnStrike, xMeters, p, lengthMeters, widthMeters);
  }
  if (Math.abs(U2) > 1e-4) {
    uz += U2 * chinnery(fnDip, xMeters, p, lengthMeters, widthMeters);
  }
  uz *= -1 / (2 * Math.PI);
  if (isNaN(uz) || !isFinite(uz)) return 0;
  const maxDisplacement = slipMeters * 1.5;
  return Math.max(-maxDisplacement, Math.min(maxDisplacement, uz));
}
function computeInitialDisplacementGrid(faults, gridWidth, gridHeight, lonMin, lonMax, latMin, latMax) {
  const eta0 = new Float32Array(gridWidth * gridHeight);
  const dLon = (lonMax - lonMin) / gridWidth;
  const dLat = (latMax - latMin) / gridHeight;
  const latMetersPerDeg = 111132;
  for (const fault of faults) {
    const strikeRad = fault.strikeDeg * Math.PI / 180;
    const cosStrike = Math.cos(strikeRad);
    const sinStrike = Math.sin(strikeRad);
    const L = fault.lengthKm * 1e3;
    const W = fault.widthKm * 1e3;
    const depth = fault.depthKm * 1e3 + W * Math.sin(fault.dipDeg * Math.PI / 180);
    const slip = fault.slipM;
    const epicLat = fault.epicenterLat;
    const epicLon = fault.epicenterLon;
    const lonMetersPerDeg = latMetersPerDeg * Math.cos(epicLat * Math.PI / 180);
    const searchRadiusKm = (fault.lengthKm + fault.widthKm) * 1.2;
    const taperStartKm = searchRadiusKm * 0.7;
    const minGridLon = epicLon - searchRadiusKm / (lonMetersPerDeg / 1e3);
    const maxGridLon = epicLon + searchRadiusKm / (lonMetersPerDeg / 1e3);
    const minGridLat = epicLat - searchRadiusKm / 111;
    const maxGridLat = epicLat + searchRadiusKm / 111;
    const colStart = Math.max(0, Math.floor((minGridLon - lonMin) / dLon));
    const colEnd = Math.min(gridWidth, Math.ceil((maxGridLon - lonMin) / dLon));
    const rowStart = Math.max(0, Math.floor((latMax - maxGridLat) / dLat));
    const rowEnd = Math.min(gridHeight, Math.ceil((latMax - minGridLat) / dLat));
    for (let r = rowStart; r < rowEnd; r++) {
      const lat = latMax - r * dLat;
      const dY = (lat - epicLat) * latMetersPerDeg;
      for (let c = colStart; c < colEnd; c++) {
        const lon = lonMin + c * dLon;
        const dX = (lon - epicLon) * lonMetersPerDeg;
        const faultX = dX * sinStrike + dY * cosStrike;
        const faultY = -dX * cosStrike + dY * sinStrike;
        const shiftedX = faultX + L * 0.5;
        const shiftedY = faultY + W * 0.5 * Math.cos(fault.dipDeg * Math.PI / 180);
        const distKm = Math.hypot(dX, dY) / 1e3;
        if (distKm >= searchRadiusKm) continue;
        const taper = distKm <= taperStartKm ? 1 : 0.5 * (1 + Math.cos(Math.PI * (distKm - taperStartKm) / (searchRadiusKm - taperStartKm)));
        const dz = calculateOkadaVerticalDisplacement(
          shiftedX,
          shiftedY,
          depth,
          L,
          W,
          fault.dipDeg,
          fault.rakeDeg,
          slip
        );
        eta0[r * gridWidth + c] += dz * taper;
      }
    }
  }
  return eta0;
}
export {
  calculateOkadaVerticalDisplacement,
  computeInitialDisplacementGrid
};
