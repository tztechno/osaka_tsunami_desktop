// Tsutenkaku (通天閣, 1956): the tower of Shinsekai, in metres. PLATEAU has no model of it (it is not a
// building there), so it is shaped from its published figures: 103 m to the roof, 108 m with the lightning rod,
// four legs arching over the streets at its foot, a tapering square steel shaft, a large round clock, the
// two-level observation head near the top, and the neon ring on the roof (光の天気予報). The advertising sign
// on the shaft is drawn as a plain lit band, without lettering.
// Local frame: x = east, z = south, y = up, origin = tower centre at street level.
import * as THREE from 'three';

function canvasTex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Steel shaft face: white members with X bracing over a darker infill (one repeat = one 6 m panel). */
const latticeTex = () => canvasTex(128, 128, (g, W, H) => {
  g.fillStyle = '#9aa3ad'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#f2f4f6'; g.lineWidth = 7;
  g.strokeRect(3, 3, W - 6, H - 6);
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
});

/** Observation windows: a band of glazing lit warm from inside. */
const windowTex = () => canvasTex(256, 64, (g, W, H) => {
  g.fillStyle = '#e9edf1'; g.fillRect(0, 0, W, H);
  for (let x = 6; x < W; x += 32) {
    const grd = g.createLinearGradient(0, 10, 0, H - 10);
    grd.addColorStop(0, '#2b4258'); grd.addColorStop(1, '#f1c76a');
    g.fillStyle = grd; g.fillRect(x, 12, 24, H - 24);
  }
});

/** The big round clock: white dial, hour marks and hands (fixed at 10:10). */
const clockTex = () => canvasTex(256, 256, (g, W) => {
  const c = W / 2;
  g.fillStyle = '#1b2a3a'; g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fbfcfd'; g.beginPath(); g.arc(c, c, c - 14, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#1b2a3a';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.lineWidth = k % 3 ? 5 : 10;
    g.beginPath(); g.moveTo(c + Math.sin(a) * (c - 24), c - Math.cos(a) * (c - 24)); g.lineTo(c + Math.sin(a) * (c - 50), c - Math.cos(a) * (c - 50)); g.stroke();
  }
  const hand = (a, len, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.sin(a) * len, c - Math.cos(a) * len); g.stroke(); };
  hand((10 / 12) * Math.PI * 2 + (10 / 60) * (Math.PI / 6), c * 0.45, 12);
  hand((10 / 60) * Math.PI * 2, c * 0.7, 7);
});

/** Box whose four sides lean in: half sizes at the bottom / top, height h, bottom at y = 0. */
function taper(bx, bz, tx, tz, h, mat) {
  const g = new THREE.BoxGeometry(1, h, 1, 1, 1, 1).translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > h / 2;
    p.setX(i, Math.sign(p.getX(i)) * (top ? tx : bx));
    p.setZ(i, Math.sign(p.getZ(i)) * (top ? tz : bz));
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

export function buildTsutenkaku() {
  const white = new THREE.MeshStandardMaterial({ color: 0xe8ebee, roughness: 0.6, metalness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ map: latticeTex(), roughness: 0.55, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a3440, roughness: 0.6 });
  const neonBlue = new THREE.MeshStandardMaterial({ color: 0x7fd8ff, emissive: 0x2fb6ff, emissiveIntensity: 1.2 });
  const neonWarm = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffa53a, emissiveIntensity: 1.0 });
  const tower = new THREE.Group();

  // ---- foot: four legs at the corners of a 21 m square, arched over the streets, carrying a deck at 12 m
  const LEG = 10.5, ARCH = 12;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = taper(2.0, 2.0, 1.4, 1.4, ARCH, white);
    leg.position.set(sx * (LEG - 1.5), 0, sz * (LEG - 1.5));
    tower.add(leg);
  }
  for (const [rot, off] of [[0, LEG - 1.5], [Math.PI, LEG - 1.5], [Math.PI / 2, LEG - 1.5], [-Math.PI / 2, LEG - 1.5]]) {
    // the arch between two legs: a half ring spanning the street
    const arch = new THREE.Mesh(new THREE.TorusGeometry(LEG - 2.6, 0.9, 8, 28, Math.PI), white);
    const holder = new THREE.Group();
    holder.rotation.y = rot;
    arch.position.set(0, ARCH - (LEG - 2.6) * 0.55, off);
    arch.scale.y = 0.55;
    holder.add(arch);
    tower.add(holder);
  }
  const deck = taper(LEG, LEG, LEG - 0.6, LEG - 0.6, 3, white);
  deck.position.y = ARCH;
  tower.add(deck);

  // ---- lower body (2F-3F) and the tapering steel shaft
  const body = taper(8.2, 8.2, 7.4, 7.4, 8, steel);
  body.position.y = ARCH + 3;
  tower.add(body);
  const SHAFT0 = ARCH + 11, SHAFT1 = 82;
  const shaft = taper(7.0, 7.0, 4.6, 4.6, SHAFT1 - SHAFT0, steel);
  shaft.position.y = SHAFT0;
  tower.add(shaft);
  // corner lights running up the shaft (the night illumination)
  const lean = (7.0 - 4.6) / (SHAFT1 - SHAFT0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const len = Math.hypot(SHAFT1 - SHAFT0, Math.SQRT2 * (7.0 - 4.6));
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.35, len, 0.35), neonBlue);
    edge.position.set(sx * (7.0 + 4.6) / 2, (SHAFT0 + SHAFT1) / 2, sz * (7.0 + 4.6) / 2);
    edge.rotation.z = sx * Math.atan(lean);
    edge.rotation.x = -sz * Math.atan(lean);
    tower.add(edge);
  }
  // lit advertising band on the east and west faces (no lettering)
  for (const sx of [-1, 1]) {
    const w = 5.2 * 2 - 0.6;
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.3, 9, w), neonWarm);
    band.position.set(sx * 5.25, 66, 0);
    tower.add(band);
  }
  // the round clock on the south face (towards Shinsekai's main street) and the north face
  for (const sz of [-1, 1]) {
    const clock = new THREE.Mesh(new THREE.CircleGeometry(4.0, 48), new THREE.MeshStandardMaterial({ map: clockTex(), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.15, emissiveMap: clockTex() }));
    clock.position.set(0, 52, sz * 5.95);
    if (sz < 0) clock.rotation.y = Math.PI;
    tower.add(clock);
  }

  // ---- observation head: a wider two-level block with window bands, and the roof
  const head1 = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 14), new THREE.MeshStandardMaterial({ map: windowTex(), roughness: 0.4 }));
  head1.material.map.repeat.set(2, 1);
  head1.position.y = SHAFT1 + 3;
  tower.add(head1);
  const ring = new THREE.Mesh(new THREE.BoxGeometry(15.2, 0.6, 15.2), white);
  ring.position.y = SHAFT1 + 6.3;
  tower.add(ring);
  const head2 = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 12), new THREE.MeshStandardMaterial({ map: windowTex(), roughness: 0.4 }));
  head2.position.y = SHAFT1 + 9.1;
  tower.add(head2);
  const roof = taper(6.6, 6.6, 3.2, 3.2, 3, white);
  roof.position.y = SHAFT1 + 11.6;
  tower.add(roof);
  // neon ring on the roof (光の天気予報) and the mast with the lightning rod up to 108 m
  const neon = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.35, 8, 40), neonBlue);
  neon.rotation.x = Math.PI / 2;
  neon.position.y = SHAFT1 + 15.2;
  tower.add(neon);
  const crown = taper(3.0, 3.0, 2.2, 2.2, 5.2, white);
  crown.position.y = SHAFT1 + 14.6;
  tower.add(crown);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, 108 - (SHAFT1 + 19.8), 8), dark);
  mast.position.y = (108 + SHAFT1 + 19.8) / 2;
  tower.add(mast);

  tower.userData = { height: 108, radius: LEG + 2 };
  return tower;
}
