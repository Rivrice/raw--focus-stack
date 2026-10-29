// node test/grass.test.js — moss with grass blades in front: background between the blades must come from
// its own sharp frame. A broad detection window alone drags it to the blades' frame (blurred moss).
const A = require('./load');
function makeMoss(n, W, H, seed, blurK, nBlades) {
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const noise = (cell) => { const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2, g = new Float32Array(gw * gh).map(() => rnd());
    return (x, y) => { const fx = x / cell, fy = y / cell, xi = fx | 0, yi = fy | 0, ax = fx - xi, ay = fy - yi, i = yi * gw + xi;
      return (g[i] * (1 - ax) + g[i + 1] * ax) * (1 - ay) + (g[i + gw] * (1 - ax) + g[i + gw + 1] * ax) * ay; }; };
  const sc = W / 2000;
  const nf = noise(1.5 * sc), nm = noise(5 * sc), nb = noise(80 * sc);
  // Thin bright blades in front (sharp in frames 0-2) over dark low-contrast moss that fills the frame
  // and steps nearer towards the bottom (sharp in frames 5..3).
  const blades = [];
  for (let k = 0; k < nBlades; k++) {
    const x0 = rnd() * W, y0 = H * (0.4 + 0.7 * rnd()), len = H * (0.2 + 0.4 * rnd()), ang = -Math.PI / 2 + (rnd() - 0.5) * 0.8, w = (1.2 + 2.5 * rnd()) * sc;
    blades.push({ x0, y0, x1: x0 + Math.cos(ang) * len, y1: y0 + Math.sin(ang) * len, w, depth: rnd() * 1.5, b: 0.6 + 0.4 * rnd() });
  }
  // Render: bg depth band per row; frames
  const files = [], gt = new Float32Array(W * H * 3);
  const bgDepth = (y) => Math.round((n - 1) - (n - 1) * 0.5 * (Math.floor(y / H * 8) + 0.5) / 8); // n-1 at top, (n-1)/2 at bottom
  const bgCol = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bgCol[y * W + x] = 0.12 * (0.55 + 0.6 * nb(x, y)) * (0.6 + 0.5 * nf(x, y) + 0.3 * nm(x, y));
  // blade layers grouped into 3 depth bins for blur
  const bins = [0, 1, 2].map((d) => ({ depth: d, a: new Float32Array(W * H), c: new Float32Array(W * H) }));
  for (const bl of blades) {
    const bin = bins[Math.min(2, Math.floor(bl.depth * 2))];
    const minx = Math.max(0, Math.floor(Math.min(bl.x0, bl.x1) - 5)), maxx = Math.min(W - 1, Math.ceil(Math.max(bl.x0, bl.x1) + 5));
    const miny = Math.max(0, Math.floor(Math.min(bl.y0, bl.y1) - 5)), maxy = Math.min(H - 1, Math.ceil(Math.max(bl.y0, bl.y1) + 5));
    const dx = bl.x1 - bl.x0, dy = bl.y1 - bl.y0, L2 = dx * dx + dy * dy;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      let t = ((x - bl.x0) * dx + (y - bl.y0) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - bl.x0 - t * dx, y - bl.y0 - t * dy), ww = bl.w * (1 - 0.8 * t);
      const al = Math.max(0, Math.min(1, ww / 2 + 0.5 - d)); if (!al) continue;
      const i = y * W + x, col = bl.b * (0.85 + 0.3 * nf(x + 50, y)) * (0.7 + 0.3 * Math.abs(x - bl.x0 - t * dx) / ww);
      bin.c[i] = bin.c[i] * (1 - al) + col * al; bin.a[i] = Math.max(bin.a[i], al);
    }
  }
  for (const b of bins) for (let i = 0; i < W * H; i++) b.c[i] *= b.a[i];
  // ground truth: everything sharp
  const G = new Float32Array(W * H), gtDepth = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { G[i] = bgCol[i]; gtDepth[i] = bgDepth((i / W) | 0); }
  for (const b of [...bins].reverse()) for (let i = 0; i < W * H; i++) { G[i] = G[i] * (1 - b.a[i]) + b.c[i]; if (b.a[i] > 0.5) gtDepth[i] = b.depth; }
  const black = 256, white = 16383;
  for (let f = 0; f < n; f++) {
    // bg: blur by row band
    const acc = new Float32Array(W * H);
    const bands = 8;
    for (let bi = 0; bi < bands; bi++) {
      const yc = (bi + 0.5) / bands * H, rad = Math.round(Math.abs(bgDepth(yc) - f) * blurK * sc);
      const bb = rad ? A.boxBlur(bgCol, W, H, rad, 3) : bgCol;
      const ya = Math.floor(bi / bands * H), yb = Math.floor((bi + 1) / bands * H);
      for (let i = ya * W; i < yb * W; i++) acc[i] = bb[i];
    }
    for (const b of [...bins].reverse()) {
      const rad = Math.round(Math.abs(b.depth - f) * blurK * sc);
      const ab = rad ? A.boxBlur(b.a, W, H, rad, 3) : b.a, cb = rad ? A.boxBlur(b.c, W, H, rad, 3) : b.c;
      for (let i = 0; i < W * H; i++) acc[i] = acc[i] * (1 - ab[i]) + cb[i];
    }
    const mosaic = new Uint16Array(W * H);
    for (let i = 0; i < W * H; i++) { const val = black + acc[i] * 0.8 * (white - black); mosaic[i] = Math.max(0, Math.min(white, Math.round(val + (rnd() + rnd() + rnd() - 1.5) * Math.sqrt(val * 0.6 + 40)))); }
    const T = A.TAG;
    const e = [
      { tag: T.NewSubFileType, type: 4, values: [0] }, { tag: T.ImageWidth, type: 4, values: [W] }, { tag: T.ImageLength, type: 4, values: [H] },
      { tag: T.BitsPerSample, type: 3, values: [16] }, { tag: T.Compression, type: 3, values: [1] }, { tag: T.Photometric, type: 3, values: [32803] },
      { tag: T.Orientation, type: 3, values: [1] }, { tag: T.SamplesPerPixel, type: 3, values: [1] }, { tag: T.RowsPerStrip, type: 4, values: [H] },
      { tag: T.PlanarConfig, type: 3, values: [1] }, { tag: T.CFARepeatPatternDim, type: 3, values: [2, 2] }, { tag: T.CFAPattern, type: 1, values: [0, 1, 1, 2] },
      { tag: T.DNGVersion, type: 1, values: [1, 4, 0, 0] }, { tag: T.UniqueCameraModel, type: 2, values: 'moss' }, { tag: T.CFAPlaneColor, type: 1, values: [0, 1, 2] },
      { tag: T.CFALayout, type: 3, values: [1] }, { tag: T.BlackLevel, type: 3, values: [black] }, { tag: T.WhiteLevel, type: 3, values: [white] },
      { tag: T.ColorMatrix1, type: 10, values: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, { tag: T.CalibrationIlluminant1, type: 3, values: [21] }, { tag: T.AsShotNeutral, type: 5, values: [1, 1, 1] },
    ];
    files.push({ name: 'f' + f, data: A.writeTiff(e, [new Uint8Array(mosaic.buffer)]) });
  }
  const U = new Float32Array(W * H); for (const b of bins) for (let i = 0; i < W * H; i++) U[i] = Math.max(U[i], b.a[i]);
  const far = A.boxBlur(U, W, H, Math.ceil((n - 1) * blurK * sc / 2), 3); const clear = new Uint8Array(W * H).map((_, i) => far[i] < 1e-3 ? 1 : 0);
  return { files, G, gtDepth, clear };
}

const assert = require('assert');
(async () => {
  const W = 640, H = 480, n = 6, sc = makeMoss(n, W, H, 5, 6, 60);
  const frames = sc.files.map((f) => ({ name: f.name, load: async () => f.data.buffer.slice(0) }));
  const d5 = (await A.decodeDNG(sc.files[5].data.buffer.slice(0), {})).data;
  let sxy = 0, sxx = 0; // scale from scene units to decoded values, fitted on unoccluded background
  for (let i = 0; i < W * H / 4; i += 7) if (sc.clear[i]) { sxy += d5[i * 3 + 1] * sc.G[i]; sxx += sc.G[i] * sc.G[i]; }
  const k = sxy / sxx;
  const err = async (opts) => {
    const r = await A.runStack(frames, Object.assign({ align: false, detail: 6, smooth: 4 }, opts));
    let e = 0, c = 0;
    for (let y = 3; y < r.height - 3; y++) for (let x = 3; x < r.width - 3; x++) {
      const gi = (y + r.depth.y0) * W + x + r.depth.x0;
      e += Math.abs(r.data[(y * r.width + x) * 3 + 1] - k * sc.G[gi]); c++;
    }
    return { e: e / c, fine: r.stats.fine || 0 };
  };
  const broad = await err({ fine: 0 }), both = await err({});
  console.log('mean error vs all-sharp scene: broad only', broad.e.toFixed(0), '/ with fine window', both.e.toFixed(0), '(' + (both.fine * 100).toFixed(0) + '% fine)');
  assert(both.e < broad.e * 0.85, 'fine window did not recover the grass scene');
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
