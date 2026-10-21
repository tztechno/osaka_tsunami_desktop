import proj4 from 'proj4';

// JGD2011 Plane Rectangular VI (EPSG:6674) for Osaka
proj4.defs('EPSG:6674', '+proj=tmerc +lat_0=36 +lon_0=136 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs');

function toPlane(lon, lat) {
  return proj4('EPSG:4326', 'EPSG:6674', [lon, lat]);
}

function toLonLat(e, n) {
  return proj4('EPSG:6674', 'EPSG:4326', [e, n]);
}

// Key Osaka points:
// Tempozan: lon 135.432, lat 34.656
// Yumeshima (Expo): lon 135.395, lat 34.650
// Sakishima (Cosmo Tower): lon 135.415, lat 34.638
// Osaka Station (Umeda): lon 135.498, lat 34.702
// Namba: lon 135.501, lat 34.666
// Yodo river mouth: lon 135.415, lat 34.685
// Yamato river mouth: lon 135.450, lat 34.605

const pTempozan = toPlane(135.432, 34.656);
console.log('Tempozan Plane (E, N):', pTempozan);

// Let's test a 16km x 12km box covering from Yumeshima to Umeda/Namba and Yamato river
// Center around E = -52000, N = -149000
const widthM = 16000;
const heightM = 12000;
const originE = -60000; // West edge
const originN = -143000; // North edge (N decreases southward)

const nw = toLonLat(originE, originN);
const se = toLonLat(originE + widthM, originN - heightM);
const sw = toLonLat(originE, originN - heightM);
const ne = toLonLat(originE + widthM, originN);

console.log('Region NW (Lon, Lat):', nw);
console.log('Region SE (Lon, Lat):', se);
console.log('Region SW (Lon, Lat):', sw);
console.log('Region NE (Lon, Lat):', ne);

// Check if key locations are inside:
const locs = [
  { name: 'Yumeshima (Expo)', lon: 135.395, lat: 34.650 },
  { name: 'Maishima', lon: 135.395, lat: 34.665 },
  { name: 'Sakishima (Cosmo Tower)', lon: 135.415, lat: 34.638 },
  { name: 'Tempozan (Osaka Port)', lon: 135.432, lat: 34.656 },
  { name: 'Yodo River Estuary', lon: 135.415, lat: 34.685 },
  { name: 'Ajigawa Sluice Gate', lon: 135.474, lat: 34.680 },
  { name: 'Shiranshiga Sluice Gate', lon: 135.477, lat: 34.665 },
  { name: 'Kizugawa Sluice Gate', lon: 135.490, lat: 34.655 },
  { name: 'Umeda (Osaka Stn)', lon: 135.498, lat: 34.702 },
  { name: 'Namba (Dotonbori)', lon: 135.501, lat: 34.666 },
  { name: 'Tsutenkaku', lon: 135.506, lat: 34.652 },
  { name: 'Yamato River Estuary', lon: 135.450, lat: 34.605 },
];

for (const loc of locs) {
  const [e, n] = toPlane(loc.lon, loc.lat);
  const x = e - originE;
  const z = originN - n;
  const inside = (x >= 0 && x <= widthM && z >= 0 && z <= heightM);
  console.log(`${loc.name}: x=${x.toFixed(0)}m, z=${z.toFixed(0)}m inside=${inside}`);
}
