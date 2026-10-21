import proj4 from 'proj4';

// JGD2011 Plane Rectangular VI (EPSG:6674) for Osaka / Kansai
proj4.defs('EPSG:6674', '+proj=tmerc +lat_0=36 +lon_0=136 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs');

export function toPlane(lon, lat) {
  return proj4('EPSG:4326', 'EPSG:6674', [lon, lat]);
}

export function toLonLat(e, n) {
  return proj4('EPSG:6674', 'EPSG:4326', [e, n]);
}
