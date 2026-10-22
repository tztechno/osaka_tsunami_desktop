// Osaka Castle keep (大阪城天守閣, 1931 reconstruction: 5 roofs outside) on its stone base (天守台), in metres,
// sized from the PLATEAU LOD2 model of the keep (tools/build-castle.mjs places it; the tiers below come from
// slicing its walls and roofs by height). The building parts are shared with N65 nagoya_flood's castle.js.
// Local frame: x = east, z = south, y = up, origin = keep centre at the foot of the stone base (30.9 m a.s.l.).
//
// Features: curved stone base (扇の勾配), white plaster walls with lattice windows, copper-tiled roofs (verdigris)
// with curved eaves and upturned corners, chidori-hafu and kara-hafu gables on several roofs, gold fittings at
// the roof corners, the black-lacquered top storey with gold tiger and crane reliefs (an Osaka Castle trait),
// a hip-and-gable top roof whose ridge runs north–south with the two golden shachihoko at its ends.
import * as THREE from 'three';

// ---------------------------------------------------------------- materials
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

/** Stone base: irregular blocks; one texture repeat = 6 m x 6 m. */
const stoneTex = () => canvasTex(512, 512, (g, W, H) => {
  g.fillStyle = '#5f646b'; g.fillRect(0, 0, W, H);
  let y = 0, row = 0;
  while (y < H) {
    const h = 34 + ((row * 37) % 26);
    let x = -((row * 53) % 70);
    while (x < W) {
      const w = 48 + ((x * 7 + row * 29) % 50);
      const v = 128 + ((x * 13 + row * 41) % 46);
      g.fillStyle = `rgb(${v - 6},${v},${v + 8})`;
      g.beginPath();
      g.moveTo(x + 3, y + 3); g.lineTo(x + w - 3, y + 2 + (row % 3)); g.lineTo(x + w - 2, y + h - 3); g.lineTo(x + 2, y + h - 2 - (x % 3));
      g.fill();
      x += w;
    }
    y += h; row++;
  }
});

/** Top storey of Osaka Castle: black lacquer with a gold relief (tiger / crane) and a gold-framed window per bay. */
const blackGoldTex = () => canvasTex(128, 128, (g, W, H) => {
  g.fillStyle = '#16181c'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#c9a03a'; g.fillRect(0, H - 8, W, 8); g.fillRect(0, 0, W, 5);
  // window with gold frame
  g.fillStyle = '#0b0d10'; g.fillRect(40, 30, 48, 44);
  g.strokeStyle = '#e1b84a'; g.lineWidth = 4; g.strokeRect(40, 30, 48, 44);
  // gold relief below the window: a stylised crouching tiger / crane
  g.fillStyle = '#e1b84a';
  g.beginPath(); g.ellipse(64, 98, 22, 9, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(44, 92, 7, 0, Math.PI * 2); g.fill();
  g.fillRect(80, 92, 16, 4);
});

/** One window bay of a plaster wall (2.6 m wide, one storey high): lattice window in the upper middle. */
const wallTex = (copper) => canvasTex(128, 128, (g, W, H) => {
  g.fillStyle = copper ? '#4f8c7b' : '#eef1f4'; g.fillRect(0, 0, W, H);
  if (copper) { g.strokeStyle = 'rgba(20,50,45,.35)'; for (let x = 0; x < W; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); } }
  // timber band at the floor line
  g.fillStyle = copper ? '#2f5d52' : '#d8dde3'; g.fillRect(0, H - 8, W, 8);
  // window: dark opening with vertical lattice bars
  const x0 = 34, y0 = 26, ww = 60, wh = 54;
  g.fillStyle = '#1d2830'; g.fillRect(x0, y0, ww, wh);
  g.fillStyle = copper ? '#6aa898' : '#f4f6f8';
  for (let k = 1; k < 7; k++) g.fillRect(x0 + (ww * k) / 7 - 2, y0, 4, wh);
  g.strokeStyle = copper ? '#2f5d52' : '#b9c0c8'; g.lineWidth = 3; g.strokeRect(x0, y0, ww, wh);
});

/** Copper tiles: ribs every 0.6 m along the slope (u in metres / 4.8 per repeat). */
const roofTex = () => canvasTex(256, 64, (g, W, H) => {
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#5f9d8b'); grd.addColorStop(1, '#4b8676');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 32) {
    g.fillStyle = '#2f5f53'; g.fillRect(x, 0, 5, H);
    g.fillStyle = '#7bb7a5'; g.fillRect(x + 5, 0, 3, H);
  }
});

function materials() {
  const stone = stoneTex();
  return {
    stone,
    stoneMat: new THREE.MeshStandardMaterial({ map: stone, roughness: 0.75, metalness: 0.02 }),
    wallTex: wallTex(false),
    copperWallTex: wallTex(true),
    blackWallTex: blackGoldTex(),
    roofMat: new THREE.MeshStandardMaterial({ map: roofTex(), roughness: 0.38, metalness: 0.25, side: THREE.DoubleSide }),
    eaveMat: new THREE.MeshStandardMaterial({ color: 0xe9edf1, roughness: 0.8, side: THREE.DoubleSide }), // plastered eave soffit
    white: new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.85, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ color: 0x2f5d52, roughness: 0.5, metalness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1d2830, roughness: 0.7 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xffc94a, roughness: 0.22, metalness: 1, emissive: 0x6b4300, emissiveIntensity: 0.9 }),
  };
}

// ---------------------------------------------------------------- geometry helpers
/** Stone base with a fan-shaped batter: steep at the top, spreading at the foot. Half sizes at bottom / top. */
function stoneBase(bx, bz, tx, tz, h, mat, segs = 14) {
  const pos = [], uv = [], idx = [];
  const half = (b, t, s) => b + (t - b) * (1 - Math.pow(1 - s, 2.2));
  const sides = [[[-1, 1], [1, 1]], [[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]]];
  for (const [A, B] of sides) {
    const base = pos.length / 3;
    let dist = 0, prev = null;
    for (let i = 0; i <= segs; i++) {
      const s = i / segs, hx = half(bx, tx, s), hz = half(bz, tz, s), y = s * h;
      const a = [A[0] * hx, y, A[1] * hz], b = [B[0] * hx, y, B[1] * hz];
      if (prev) dist += Math.hypot(a[0] - prev[0], a[1] - prev[1], a[2] - prev[2]);
      prev = a;
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      pos.push(...a, ...b);
      uv.push(0, dist / 6, len / 6, dist / 6);
    }
    for (let i = 0; i < segs; i++) { const p = base + i * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  const capT = new THREE.Mesh(new THREE.BoxGeometry(tx * 2 + 0.4, 0.5, tz * 2 + 0.4), mat);
  capT.position.y = h - 0.25;
  const grp = new THREE.Group();
  grp.add(m, capT);
  return grp;
}

/** Four plaster walls of one storey (half sizes hx, hz, height h) with window bays every ~2.6 m. */
function storey(hx, hz, h, M, copper = false, black = false) {
  const g = new THREE.Group();
  for (const [rot, w, off] of [[0, hx * 2, hz], [Math.PI, hx * 2, hz], [Math.PI / 2, hz * 2, hx], [-Math.PI / 2, hz * 2, hx]]) {
    const tex = (black ? M.blackWallTex : copper ? M.copperWallTex : M.wallTex).clone();
    tex.repeat.set(Math.max(2, Math.round(w / 2.6)), 1);
    tex.needsUpdate = true;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: copper || black ? 0.45 : 0.85, metalness: copper || black ? 0.2 : 0 }));
    const holder = new THREE.Group();
    holder.rotation.y = rot;
    face.position.set(0, h / 2, off);
    holder.add(face);
    g.add(holder);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.05, hz * 2), M.white);
  top.position.y = h;
  g.add(top);
  return g;
}

/**
 * Skirt / hip roof from the eave rectangle (half W, D) at y = 0 up to the inner rectangle (half w, d) at y = h.
 * The slope sags (gentle at the eave, steep at the top) and the corners turn up by `lift`.
 */
function hipRoof(W, D, w, d, h, lift, M, segs = 10, along = 18) {
  const pos = [], uv = [], idx = [];
  const P = (t, s, side) => {
    const hw = W + (w - W) * t, hd = D + (d - D) * t;
    let x, z, L;
    if (side === 0) { x = s * hw; z = hd; L = hw; } else if (side === 1) { x = hw; z = -s * hd; L = hd; } else if (side === 2) { x = -s * hw; z = -hd; L = hw; } else { x = -hw; z = s * hd; L = hd; }
    const y = h * Math.pow(t, 1.6) + lift * Math.pow(Math.abs(s), 8) * Math.pow(1 - t, 2);
    return [x, y, z, s * L];
  };
  for (let side = 0; side < 4; side++) {
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) for (let j = 0; j <= along; j++) {
      const [x, y, z, u] = P(i / segs, -1 + (2 * j) / along, side);
      pos.push(x, y, z);
      uv.push(u / 4.8, i / segs);
    }
    for (let i = 0; i < segs; i++) for (let j = 0; j < along; j++) {
      const a = base + i * (along + 1) + j, b = a + 1, c = a + along + 1, e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(g, M.roofMat));
  // plastered eave soffit and a thin copper fascia along the eave
  const soffit = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, D * 2), M.eaveMat);
  soffit.rotation.x = Math.PI / 2;
  soffit.position.y = -0.05;
  grp.add(soffit);
  for (const [sx, sz, len, rot] of [[0, D, W * 2, 0], [0, -D, W * 2, 0], [W, 0, D * 2, Math.PI / 2], [-W, 0, D * 2, Math.PI / 2]]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(len, 0.35, 0.18), M.trim);
    f.position.set(sx, 0.05, sz);
    f.rotation.y = rot;
    grp.add(f);
  }
  return grp;
}

/** Chidori-hafu: triangular gable (width, height) facing +z with its own small roof running back by `depth`. */
function chidori(width, height, depth, M) {
  const g = new THREE.Group();
  const tri = new THREE.Shape([new THREE.Vector2(-width / 2, 0), new THREE.Vector2(width / 2, 0), new THREE.Vector2(0, height)]);
  const face = new THREE.Mesh(new THREE.ShapeGeometry(tri), M.white);
  face.position.z = 0.4;
  g.add(face);
  // timber-like dark grid on the gable face
  const beam = new THREE.Mesh(new THREE.BoxGeometry(width * 0.7, 0.16, 0.05), M.trim);
  beam.position.set(0, height * 0.32, 0.45);
  g.add(beam);
  const slope = Math.hypot(width / 2, height) + 0.9;
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(slope, 0.25, depth), M.roofMat);
    p.position.set((s * width) / 4, height / 2 + 0.2, 0.4 - depth / 2 + 0.6);
    p.rotation.z = -s * Math.atan2(height, width / 2);
    g.add(p);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(slope, 0.4, 0.22), M.trim);
    edge.position.set((s * width) / 4, height / 2 + 0.05, 0.55);
    edge.rotation.z = -s * Math.atan2(height, width / 2);
    g.add(edge);
  }
  // gold gegyo (pendant ornament) under the apex
  const gegyo = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 6), M.gold);
  gegyo.rotation.x = Math.PI;
  gegyo.position.set(0, height - 0.75, 0.55);
  g.add(gegyo);
  return g;
}

/** Kara-hafu: curved (bell-arched) gable facing +z. */
function karahafu(width, height, depth, M) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  const n = 24;
  const yOf = (u) => height * (Math.cos(u * Math.PI / 2) ** 2) * (1 - 0.35 * u * u) + 0.15 * height * Math.max(0, Math.abs(u) - 0.75) * 4;
  shape.moveTo(-width / 2, 0);
  for (let k = 0; k <= n; k++) { const u = -1 + (2 * k) / n; shape.lineTo((u * width) / 2, yOf(u)); }
  shape.lineTo(width / 2, 0);
  const face = new THREE.Mesh(new THREE.ShapeGeometry(shape), M.white);
  face.position.z = 0.35;
  g.add(face);
  // the curved roof: a strip following the arch, running back by depth
  const pts = [];
  for (let k = 0; k <= n; k++) { const u = -1 + (2 * k) / n; pts.push(new THREE.Vector2((u * width) / 2 * 1.06, yOf(u) + 0.18)); }
  const pos = [], idx = [];
  pts.forEach((p) => pos.push(p.x, p.y, 0.6, p.x, p.y + 0.1, 0.6 - depth));
  for (let k = 0; k < n; k++) { const a = k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rg.setIndex(idx);
  rg.computeVertexNormals();
  g.add(new THREE.Mesh(rg, M.roofMat));
  const lip = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, p.y, 0.62))), 40, 0.14, 6), M.trim);
  g.add(lip);
  return g;
}

/**
 * Golden shachihoko (~2.6 m): a tapered, elliptical body swept along a curve — head down on the ridge,
 * body arching up, tail fin raised. `dir` = +1 bends the tail towards +z.
 */
function shachihoko(dir, M) {
  const g = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.15, -0.35 * dir), new THREE.Vector3(0, 0.8, -0.25 * dir), new THREE.Vector3(0, 1.45, 0.05 * dir),
    new THREE.Vector3(0, 1.95, 0.45 * dir), new THREE.Vector3(0, 2.2, 0.85 * dir),
  ]);
  const n = 40, ring = 14, pos = [], idx = [];
  const frames = curve.computeFrenetFrames(n, false);
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = curve.getPoint(t);
    const r = 0.42 * (t < 0.15 ? 0.75 + t * 1.6 : 1 - 0.75 * (t - 0.15) / 0.85) + 0.04;
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2;
      const nv = frames.normals[i].clone().multiplyScalar(Math.cos(a) * r).add(frames.binormals[i].clone().multiplyScalar(Math.sin(a) * r * 0.75));
      pos.push(p.x + nv.x, p.y + nv.y, p.z + nv.z);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < ring; j++) {
    const a = i * ring + j, b = i * ring + ((j + 1) % ring), c = a + ring, d = b + ring;
    idx.push(a, c, b, b, c, d);
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bg.setIndex(idx);
  bg.computeVertexNormals();
  g.add(new THREE.Mesh(bg, M.gold));
  // head: a larger rounded block with a jaw
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.46, 18, 14), M.gold);
  head.scale.set(0.85, 0.75, 1.15);
  head.position.set(0, 0.25, -0.5 * dir);
  g.add(head);
  // tail fin: a fan of two lobes
  const tip = curve.getPoint(1);
  for (const a of [0.7, -0.5]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 16), M.gold);
    fin.scale.x = 0.25;
    fin.position.set(0, tip.y + 0.25, tip.z + 0.1 * dir);
    fin.rotation.x = dir * a;
    g.add(fin);
  }
  // pectoral fins
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 10), M.gold);
    fin.scale.z = 0.3;
    fin.position.set(s * 0.38, 0.75, -0.15 * dir);
    fin.rotation.z = s * 1.2;
    g.add(fin);
  }
  return g;
}

// ---------------------------------------------------------------- the keep
// Tiers measured on the PLATEAU LOD2 keep, heights above the foot of the stone base (half sizes x = E–W, z = N–S)
const STONE = { bx: 20.1, bz: 22.0, tx: 17.1, tz: 18.9, h: 13.0 };
const TIERS = [
  // storey half sizes, storey height, eave half sizes, roof rise
  { hx: 16.6, hz: 18.4, h: 5.4, ex: 19.1, ez: 20.9, rise: 2.2 },
  { hx: 14.6, hz: 16.6, h: 3.4, ex: 16.8, ez: 18.6, rise: 2.0 },
  { hx: 13.2, hz: 14.8, h: 3.2, ex: 15.2, ez: 17.0, rise: 2.0 },
  { hx: 11.1, hz: 12.4, h: 3.4, ex: 13.6, ez: 14.0, rise: 1.8 },
  { hx: 7.6, hz: 7.4, h: 7.5, ex: 9.6, ez: 9.4, rise: 0 }, // top storey (black lacquer and gold), hip-and-gable roof
];
const RIDGE_TOP = 53.2; // 84.1 m a.s.l. - 30.9 m

/** Small gold fittings at the four upturned corners of a roof eave (the gilded corner ornaments). */
function cornerGold(ex, ez, y, M) {
  const g = new THREE.Group();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), M.gold);
    o.position.set(sx * (ex + 0.2), y + 0.9, sz * (ez + 0.2));
    o.rotation.y = Math.PI / 4;
    g.add(o);
  }
  return g;
}

function mainKeep(M) {
  const keep = new THREE.Group();
  keep.add(stoneBase(STONE.bx, STONE.bz, STONE.tx, STONE.tz, STONE.h, M.stoneMat));
  let y = STONE.h;
  TIERS.forEach((t, k) => {
    const top = k === TIERS.length - 1;
    const s = storey(t.hx, t.hz, t.h, M, false, top);
    s.position.y = y;
    keep.add(s);
    y += t.h;
    if (!top) {
      const next = TIERS[k + 1];
      const roof = hipRoof(t.ex, t.ez, next.hx, next.hz, t.rise, 0.9, M);
      roof.position.y = y - 0.15;
      keep.add(roof);
      const yr = y - 0.15;
      keep.add(cornerGold(t.ex, t.ez, yr, M));
      // gables: chidori-hafu and kara-hafu alternating up the keep
      const add = (obj, rotY, x, z) => { obj.rotation.y = rotY; obj.position.set(x, yr, z); keep.add(obj); };
      if (k === 0) {
        for (const s2 of [1, -1]) add(chidori(20, 6.0, 9, M), s2 > 0 ? 0 : Math.PI, 0, s2 * (t.ez - 1.0));
        for (const s2 of [1, -1]) add(chidori(18, 5.6, 8, M), s2 * Math.PI / 2, s2 * (t.ex - 1.0), 0);
      }
      if (k === 1) {
        for (const s2 of [1, -1]) add(karahafu(10, 2.8, 4, M), s2 > 0 ? 0 : Math.PI, 0, s2 * (t.ez - 0.6));
        for (const s2 of [1, -1]) add(chidori(14, 4.6, 6, M), s2 * Math.PI / 2, s2 * (t.ex - 1.0), 0);
      }
      if (k === 2) for (const s2 of [1, -1]) add(chidori(14, 4.6, 6, M), s2 > 0 ? 0 : Math.PI, 0, s2 * (t.ez - 1.0));
      if (k === 3) for (const s2 of [1, -1]) add(karahafu(8, 2.4, 4, M), s2 * Math.PI / 2, s2 * (t.ex - 0.6), 0);
      y = yr + t.rise;
    } else {
      // balcony rail (高欄) round the top storey, then the hip-and-gable top roof with its ridge north–south
      const rail = new THREE.Mesh(new THREE.BoxGeometry(t.hx * 2 + 2.4, 1.0, t.hz * 2 + 2.4), M.dark);
      rail.position.y = y - t.h + 0.9;
      keep.add(rail);
      const yr = y - 0.15;
      const skirt = hipRoof(t.ex, t.ez, 6.0, 6.2, 2.2, 1.1, M);
      skirt.position.y = yr;
      keep.add(skirt);
      keep.add(cornerGold(t.ex, t.ez, yr, M));
      const y1 = yr + 2.2, rh = RIDGE_TOP - y1, L = 5.8, half = 6.0;
      for (const sx of [-1, 1]) {
        const slope = Math.hypot(half + 0.4, rh);
        const p = new THREE.Mesh(new THREE.BoxGeometry(slope, 0.3, L * 2 + 1.2), M.roofMat);
        p.position.set((sx * (half + 0.4)) / 2, y1 + rh / 2, 0);
        p.rotation.z = -sx * Math.atan2(rh, half + 0.4); // each slope rises towards the ridge (x = 0)
        keep.add(p);
      }
      // gable ends (north and south): white triangles with a gold ornament
      for (const sz of [-1, 1]) {
        const tri = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rh - 0.2)]);
        const f = new THREE.Mesh(new THREE.ShapeGeometry(tri), M.white);
        f.position.set(0, y1, sz * (L - 0.2));
        if (sz < 0) f.rotation.y = Math.PI;
        keep.add(f);
        const orn = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 6), M.gold);
        orn.rotation.x = Math.PI;
        orn.position.set(0, RIDGE_TOP - 1.5, sz * (L - 0.1));
        keep.add(orn);
      }
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, L * 2 + 0.6), M.trim);
      ridge.position.y = RIDGE_TOP - 0.1;
      keep.add(ridge);
      // golden shachihoko on the north and south ends, tails turned outward
      for (const sz of [-1, 1]) {
        const sh = shachihoko(sz, M);
        sh.position.set(0, RIDGE_TOP + 0.2, sz * (L - 0.1));
        keep.add(sh);
      }
    }
  });
  keep.userData.height = RIDGE_TOP + 2.6;
  return keep;
}

/** The keep on its stone base; radius (m) of the area whose plain building blocks it replaces. */
export function buildCastle() {
  const castle = mainKeep(materials());
  castle.userData = { height: RIDGE_TOP + 2.6, stone: STONE, radius: Math.hypot(STONE.bx, STONE.bz) + 2 };
  return castle;
}
