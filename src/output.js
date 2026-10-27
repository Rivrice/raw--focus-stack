// ---- Rendering and file writers ----

function srgbEncode(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }

// Tone LUT over linear values 0..8 (after exposure): soft highlight shoulder, then sRGB.
function makeToneLUT(bits) {
  const N = 8192, maxV = (1 << bits) - 1, t = 0.8;
  const lut = bits > 8 ? new Uint16Array(N + 1) : new Uint8Array(N + 1);
  for (let i = 0; i <= N; i++) {
    let x = (i / N) * 8;
    if (x > t) x = t + (1 - t) * (1 - Math.exp(-(x - t) / (1 - t)));
    lut[i] = Math.round(srgbEncode(Math.min(1, x)) * maxV);
  }
  return lut;
}

// Camera RGB (Uint16) -> display-referred sRGB; optional downscale (box) to fit maxSide.
// Returns {data, w, h} with 3 (bits 16) or 4 (bits 8, RGBA) channels.
function renderImage(src, w, h, rt, opts = {}) {
  const bits = opts.bits || 8;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / (opts.maxSide || Infinity)));
  const ow = Math.floor(w / step), oh = Math.floor(h / step);
  const ch = bits === 8 ? 4 : 3;
  const out = bits === 8 ? new Uint8ClampedArray(ow * oh * 4) : new Uint16Array(ow * oh * 3);
  const lut = makeToneLUT(bits);
  const gain = Math.pow(2, (rt.baselineExposure || 0) + (opts.exposure || 0));
  const M = rt.matrix.map((v) => v * gain);
  const wb = rt.wb;
  const N = 8192 / 8, inv = 1 / (65535 * step * step);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, gg = 0, b = 0;
      for (let sy = 0; sy < step; sy++) {
        let o = ((y * step + sy) * w + x * step) * 3;
        for (let sx = 0; sx < step; sx++, o += 3) { r += src[o]; gg += src[o + 1]; b += src[o + 2]; }
      }
      r = Math.min(1, r * inv * wb[0]); gg = Math.min(1, gg * inv * wb[1]); b = Math.min(1, b * inv * wb[2]);
      const R = M[0] * r + M[1] * gg + M[2] * b, G = M[3] * r + M[4] * gg + M[5] * b, B = M[6] * r + M[7] * gg + M[8] * b;
      const o = (y * ow + x) * ch;
      out[o] = lut[Math.min(8192, Math.max(0, (R * N) | 0))];
      out[o + 1] = lut[Math.min(8192, Math.max(0, (G * N) | 0))];
      out[o + 2] = lut[Math.min(8192, Math.max(0, (B * N) | 0))];
      if (ch === 4) out[o + 3] = 255;
    }
  }
  return orient(out, ow, oh, ch, opts.orientation || 1);
}

// Apply EXIF orientation physically.
function orient(src, w, h, ch, o) {
  if (!o || o === 1) return { data: src, w, h };
  const swap = o >= 5;
  const ow = swap ? h : w, oh = swap ? w : h;
  const out = new src.constructor(src.length);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let sx, sy;
    switch (o) {
      case 2: sx = w - 1 - x; sy = y; break;
      case 3: sx = w - 1 - x; sy = h - 1 - y; break;
      case 4: sx = x; sy = h - 1 - y; break;
      case 5: sx = y; sy = x; break;
      case 6: sx = y; sy = h - 1 - x; break;
      case 7: sx = w - 1 - y; sy = h - 1 - x; break;
      case 8: sx = w - 1 - y; sy = x; break;
      default: sx = x; sy = y;
    }
    const si = (sy * w + sx) * ch, di = (y * ow + x) * ch;
    for (let c = 0; c < ch; c++) out[di + c] = src[si + c];
  }
  return { data: out, w: ow, h: oh };
}

function u16Strips(data, w, h, spp, rowsPerStrip) {
  const strips = [];
  for (let y = 0; y < h; y += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, h - y);
    const part = data.subarray(y * w * spp, (y + rows) * w * spp);
    // Little-endian hosts: the typed array bytes are already LE.
    strips.push(new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)));
  }
  return strips;
}

// Linear (demosaiced) DNG in the camera's colour space, so raw editors keep full WB / colour control.
// Stored as 14-bit samples in 256x256 lossless-JPEG tiles (as Apple ProRAW does); source RAWs
// carry at most 14 bits, so nothing is lost while the file shrinks to a fraction of the
// uncompressed 16-bit size.
const DNG_TILE = 256, DNG_BITS = 14;
function writeLinearDNG(data, w, h, meta, extra = {}) {
  return writeStackDNG(data, w, h, meta, Object.assign({}, extra, { cfa: false }));
}

// Writes the stack as a DNG. When the source was a Bayer RAW processed at full size, the result is
// re-mosaiced onto the original colour filter pattern: one sample per pixel, so the file is about
// the size of one source RAW and the raw editor demosaics it itself. Otherwise a LinearRaw DNG
// (three samples per pixel) is written.
function writeStackDNG(data, w, h, meta, extra = {}) {
  const pat = extra.cfa !== false && meta.cfaPattern && !(w & 1) && !(h & 1) ? meta.cfaPattern : null;
  const e = [];
  const add = (tag, type, values) => { if (values != null && (typeof values === 'string' || values.length)) e.push({ tag, type, values }); };
  const maxV = (1 << DNG_BITS) - 1, shift = 16 - DNG_BITS;
  add(TAG.NewSubFileType, 4, [0]);
  add(TAG.ImageWidth, 4, [w]);
  add(TAG.ImageLength, 4, [h]);
  add(TAG.BitsPerSample, 3, pat ? [DNG_BITS] : [DNG_BITS, DNG_BITS, DNG_BITS]);
  add(TAG.Compression, 3, [7]);
  add(TAG.Photometric, 3, [pat ? 32803 : 34892]);
  if (meta.make) add(TAG.Make, 2, meta.make);
  if (meta.model) add(TAG.Model, 2, meta.model);
  add(TAG.Orientation, 3, [meta.orientation || 1]);
  add(TAG.SamplesPerPixel, 3, [pat ? 1 : 3]);
  add(TAG.PlanarConfig, 3, [1]);
  if (pat) {
    add(TAG.CFARepeatPatternDim, 3, [2, 2]);
    add(TAG.CFAPattern, 1, pat);
    add(TAG.CFAPlaneColor, 1, [0, 1, 2]);
    add(TAG.CFALayout, 3, [1]);
  }
  add(TAG.TileWidth, 4, [DNG_TILE]);
  add(TAG.TileLength, 4, [DNG_TILE]);
  add(TAG.Software, 2, extra.software || 'RAW Focus Stacker');
  if (meta.dateTime) add(TAG.DateTime, 2, meta.dateTime);
  add(TAG.DNGVersion, 1, [1, 4, 0, 0]);
  add(TAG.DNGBackwardVersion, 1, [1, 1, 0, 0]);
  add(TAG.UniqueCameraModel, 2, meta.uniqueModel || 'Focus stack');
  add(TAG.WhiteLevel, 4, pat ? [maxV] : [maxV, maxV, maxV]);
  add(TAG.BlackLevel, 3, pat ? [0] : [0, 0, 0]);
  const cm1 = meta.colorMatrix1 || mat3inv(XYZ_FROM_SRGB);
  add(TAG.ColorMatrix1, 10, cm1);
  add(TAG.CalibrationIlluminant1, 3, [meta.colorMatrix1 ? meta.illuminant1 || 21 : 21]);
  if (meta.colorMatrix2) { add(TAG.ColorMatrix2, 10, meta.colorMatrix2); add(TAG.CalibrationIlluminant2, 3, [meta.illuminant2 || 21]); }
  if (meta.forwardMatrix1) add(TAG.ForwardMatrix1, 10, meta.forwardMatrix1);
  if (meta.forwardMatrix2 && meta.colorMatrix2) add(TAG.ForwardMatrix2, 10, meta.forwardMatrix2);
  if (meta.cameraCalibration1) add(TAG.CameraCalibration1, 10, meta.cameraCalibration1);
  if (meta.cameraCalibration2 && meta.colorMatrix2) add(TAG.CameraCalibration2, 10, meta.cameraCalibration2);
  if (meta.analogBalance) add(TAG.AnalogBalance, 5, meta.analogBalance);
  if (meta.asShotNeutral) add(TAG.AsShotNeutral, 5, meta.asShotNeutral);
  else if (meta.asShotWhiteXY) add(TAG.AsShotWhiteXY, 5, meta.asShotWhiteXY);
  add(TAG.BaselineExposure, 10, [meta.baselineExposure || 0]);

  const T = DNG_TILE, tiles = [];
  if (pat) {
    // Bayer tiles are coded as T/2 x T two-component frames so each sample is predicted from the
    // same colour two pixels to its left.
    const tile = new Uint16Array(T * T);
    for (let ty = 0; ty < h; ty += T) {
      for (let tx = 0; tx < w; tx += T) {
        for (let y = 0; y < T; y++) {
          let sy = ty + y; if (sy >= h) sy -= 2 * Math.ceil((sy - h + 1) / 2); // stay on the same CFA row phase
          const rowPat = (sy & 1) << 1;
          for (let x = 0; x < T; x++) {
            let sx = tx + x; if (sx >= w) sx -= 2 * Math.ceil((sx - w + 1) / 2);
            tile[y * T + x] = data[(sy * w + sx) * 3 + pat[rowPat | (sx & 1)]] >> shift;
          }
        }
        tiles.push(encodeLJ92(tile, T / 2, T, 2, DNG_BITS).slice());
      }
    }
    return writeTiff(e, tiles, { tiled: true });
  }
  const tile = new Uint16Array(T * T * 3);
  for (let ty = 0; ty < h; ty += T) {
    for (let tx = 0; tx < w; tx += T) {
      // Copy the tile, repeating the last row/column past the image edge.
      for (let y = 0; y < T; y++) {
        const sy = Math.min(h - 1, ty + y);
        for (let x = 0; x < T; x++) {
          const si = (sy * w + Math.min(w - 1, tx + x)) * 3, di = (y * T + x) * 3;
          tile[di] = data[si] >> shift; tile[di + 1] = data[si + 1] >> shift; tile[di + 2] = data[si + 2] >> shift;
        }
      }
      tiles.push(encodeLJ92(tile, T, T, 3, DNG_BITS).slice());
    }
  }
  return writeTiff(e, tiles, { tiled: true });
}

// 16-bit sRGB TIFF from rendered data (3 channels), Deflate-compressed with horizontal
// differencing where the browser can compress (CompressionStream), otherwise uncompressed.
async function writeTiff16(data, w, h, software) {
  const rps = Math.max(1, Math.floor(262144 / (w * 6)));
  const canDeflate = typeof CompressionStream !== 'undefined';
  const e = [
    { tag: TAG.ImageWidth, type: 4, values: [w] }, { tag: TAG.ImageLength, type: 4, values: [h] },
    { tag: TAG.BitsPerSample, type: 3, values: [16, 16, 16] }, { tag: TAG.Compression, type: 3, values: [canDeflate ? 8 : 1] },
    { tag: TAG.Photometric, type: 3, values: [2] }, { tag: TAG.SamplesPerPixel, type: 3, values: [3] },
    { tag: TAG.RowsPerStrip, type: 4, values: [rps] }, { tag: TAG.PlanarConfig, type: 3, values: [1] },
    { tag: TAG.Software, type: 2, values: software || 'RAW Focus Stacker' },
    { tag: 282, type: 5, values: [300] }, { tag: 283, type: 5, values: [300] }, { tag: 296, type: 3, values: [2] },
  ];
  if (canDeflate) e.push({ tag: TAG.Predictor, type: 3, values: [2] });
  const strips = u16Strips(data, w, h, 3, rps);
  if (!canDeflate) return writeTiff(e, strips);
  const out = [];
  for (const s of strips) {
    const v = new Uint16Array(s.buffer);
    const rowLen = w * 3;
    for (let r = v.length / rowLen - 1; r >= 0; r--) {
      const o = r * rowLen;
      for (let x = rowLen - 1; x >= 3; x--) v[o + x] = (v[o + x] - v[o + x - 3]) & 0xffff;
    }
    const cs = new CompressionStream('deflate');
    out.push(new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(cs)).arrayBuffer()));
  }
  return writeTiff(e, out);
}

// ---- ZIP (store only) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) { // [{name, data: Uint8Array}] -> Blob
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const csize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---- Synthetic focus bracket (for the built-in sample and tests) ----
// Renders layered textured objects at different depths, blurs each layer according to the
// focus position of each frame, adds slight focus breathing and noise, and stores Bayer DNGs.
function makeDemoStack(n = 6, W = 960, H = 640, seed = 7, blurK = 1.8) {
  let s = Math.imul(seed >>> 0, 2654435761) >>> 0; // spread nearby seeds apart
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 4; i++) rnd();
  const noiseTex = (cell) => {
    // Margin so per-shape offsets (< 600 px) never reach the wrap-around seam.
    const gw = Math.ceil((W + 600) / cell) + 2, gh = Math.ceil((H + 600) / cell) + 2;
    const g = new Float32Array(gw * gh).map(() => rnd());
    return (x, y) => {
      const fx = x / cell, fy = y / cell, xi = Math.floor(fx), yi = Math.floor(fy), ax = fx - xi, ay = fy - yi;
      const x0 = ((xi % (gw - 1)) + gw - 1) % (gw - 1), y0 = ((yi % (gh - 1)) + gh - 1) % (gh - 1);
      const i = y0 * gw + x0;
      return (g[i] * (1 - ax) + g[i + 1] * ax) * (1 - ay) + (g[i + gw] * (1 - ax) + g[i + gw + 1] * ax) * ay;
    };
  };
  const n1 = noiseTex(2), n2 = noiseTex(9), n3 = noiseTex(60), n4 = noiseTex(140);
  // Scene: three grainy gradient shapes on a plain backdrop. Lightness steps with depth (far = dark, near = light)
  // so the layers stay distinct in greyscale; hues stay within one family for a coherent palette.
  const oklch = (L, C, h) => { // OKLCH → linear sRGB, reducing chroma until it fits the gamut
    for (let c = C; ; c *= 0.9) {
      const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
      const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
      if (c < 0.005 || rgb.every((v) => v >= 0 && v <= 1)) return rgb.map((v) => Math.min(1, Math.max(0, v)));
    }
  };
  const hue = [20, 60, 150, 205, 255, 300, 345][Math.floor(rnd() * 7)];
  const tones = [ // far → near: lightness, chroma, hue offset within the family
    { L: 0.46, C: 0.13, dh: -28 }, { L: 0.66, C: 0.13, dh: 0 }, { L: 0.86, C: 0.10, dh: 28 },
  ];
  const palettes = tones.map(({ L, C, dh }) => [-22, 0, 22].map((sp, k) => oklch(L + 0.035 * (1 - k), C, hue + dh + sp)));
  const backdrop = oklch(0.25, 0.045, hue - 10);
  const ramp = (stops, t, out) => {
    t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, ss = f * f * (3 - 2 * f), a = stops[i], b = stops[i + 1];
    for (let k = 0; k < 3; k++) out[k] = a[k] + (b[k] - a[k]) * ss;
  };
  const S = Math.min(W, H);
  // Signed distances (px, negative inside).
  const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
  const sdBox = (cx, cy, hw, hh, rad, rot = 0) => { const c = Math.cos(rot), sn = Math.sin(rot); return (x, y) => {
    const u = Math.abs((x - cx) * c + (y - cy) * sn) - hw + rad, v = Math.abs(-(x - cx) * sn + (y - cy) * c) - hh + rad;
    return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0) - rad; }; };
  const sdTri = (cx, cy, r) => (x, y) => { // equilateral, point up, circumradius r
    const k = Math.sqrt(3), px0 = (x - cx) / r, py0 = -(y - cy) / r - 0.0;
    let px = Math.abs(px0) - 1 * k / 2, py = py0 + 0.5;
    if (px + k * py > 0) { const t = px; px = (px - k * py) / 2; py = (-k * t - py) / 2; }
    px -= Math.min(Math.max(px, -k), 0);
    return -Math.hypot(px, py) * Math.sign(py) * r; };
  const sdBars = (cx, cy, hw, hh, count, gap) => { const pitch = (2 * hh + gap), top = cy - (count - 1) * pitch / 2; return (x, y) => {
    const k = Math.max(0, Math.min(count - 1, Math.round((y - top) / pitch)));
    return sdBox(cx, top + k * pitch, hw, hh, hh)(x, y); }; };
  const shape = (sd, cx, cy, r, angle) => ({ sd, cx, cy, r, angle });
  // Keep every shape clear of the frame edge, where focus breathing leaves no data in the outer frames.
  const keep = (v, r, len) => Math.min(len - r - 0.06 * S, Math.max(r + 0.06 * S, v));
  // Three shapes (far, middle, near); which kinds appear changes with the seed.
  // Each kind spans [-0.9r, 0.9r] vertically (so bottoms line up at cy + 0.9r); hw is its half-width in r.
  const kinds = [
    { hw: 0.90, make: (cx, cy, r) => shape(sdBox(cx, cy, r * 0.9, r * 0.9, S * 0.01), cx, cy, r, 0.6) },
    { hw: 0.92, make: (cx, cy, r) => shape(sdCircle(cx, cy, r * 0.92), cx, cy, r, 0.8) },
    { hw: 0.92, make: (cx, cy, r) => shape(sdBox(cx, cy, r * 0.65, r * 0.65, S * 0.008, Math.PI / 4), cx, cy, r, 0.7) },
    { hw: 1.04, make: (cx, cy, r) => shape(sdTri(cx, cy + r * 0.3, r * 1.2), cx, cy, r, -0.5) },
    { hw: 0.90, make: (cx, cy, r) => shape(sdBars(cx, cy + r * 0.1, r * 0.9, r * 0.14, 4, r * 0.16), cx, cy, r, 0) },
  ];
  const bars = kinds[4];
  for (let i = kinds.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [kinds[i], kinds[k]] = [kinds[k], kinds[i]]; }
  if (kinds[2] === bars) [kinds[2], kinds[3]] = [kinds[3], kinds[2]]; // bars read better behind a solid shape
  // Composed layouts. Every layout follows exactly one rule: the shapes overlap, or they stand side by side on
  // one baseline. Either way the near shape is the largest, so size reads as depth. Mirrored at random.
  const sizes = [0.20, 0.26, 0.32];
  const overlapping = [ // centres (x in W, y in S) for far, middle, near
    [[0.37, 0.33], [0.50, 0.50], [0.65, 0.64]], // diagonal cascade toward the viewer
    [[0.50, 0.30], [0.34, 0.55], [0.64, 0.62]], // cluster: near shape in front of both
    [[0.68, 0.30], [0.55, 0.47], [0.38, 0.63]], // receding diagonal into the top corner
  ];
  const pick = Math.floor(rnd() * (overlapping.length + 1)), flip = rnd() < 0.5;
  let shapes;
  if (pick < overlapping.length) {
    shapes = overlapping[pick].map(([sx, sy], i) => {
      const r = S * sizes[i], cx = keep(W * (flip ? 1 - sx : sx), r, W), cy = keep(H * 0.5 + (sy - 0.5) * S, r, H);
      return kinds[i].make(cx, cy, r);
    });
  } else {
    // Side by side on one baseline, equal gaps, the whole row centred; no shape touches another.
    let rs = [0.18, 0.24, 0.31].map((f) => f * S);
    const gap = 0.07 * W, avail = W - 2 * 0.08 * W - 2 * gap;
    const need = rs.reduce((t, r, i) => t + 2 * kinds[i].hw * r, 0);
    if (need > avail) rs = rs.map((r) => r * avail / need);
    const order = flip ? [2, 1, 0] : [0, 1, 2], baseY = H * 0.5 + 0.9 * rs[2]; // the largest shape is centred vertically
    let x = (W - (rs.reduce((t, r, i) => t + 2 * kinds[i].hw * r, 0) + 2 * gap)) / 2;
    shapes = [];
    for (const i of order) {
      const w = kinds[i].hw * rs[i];
      shapes[i] = kinds[i].make(x + w, baseY - 0.9 * rs[i], rs[i]);
      x += 2 * w + gap;
    }
  }



  // Grain: fine speckle plus a soft "paper" mottling; this is also what the focus detector locks onto.
  const speck = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };
  const grain = (x, y) => 0.8 + 0.12 * n1(x, y) + 0.06 * n2(x, y) + 0.14 * speck(x, y);
  const layers = [
    { depth: n - 0.6, alpha: () => 1, col: (x, y, out) => {
      const m = 0.9 + 0.1 * n2(x, y) + 0.05 * speck(x, y); // paper-like mottling; also gives alignment something to hold at the edges
      out[0] = backdrop[0] * m; out[1] = backdrop[1] * m; out[2] = backdrop[2] * m; } },
  ].concat(shapes.map((sh, i) => {
    const pal = palettes[i], ca = Math.cos(sh.angle), sa = Math.sin(sh.angle);
    return {
      depth: [n - 1.2, (n - 1) * 0.5, 0.1][i],
      alpha: (x, y) => Math.min(1, Math.max(0, 0.5 - sh.sd(x, y))),
      col: (x, y, out) => {
        ramp(pal, 0.5 + ((x - sh.cx) * ca + (y - sh.cy) * sa) / (2 * sh.r) + 0.25 * (n3(x + i * 97, y) - 0.5), out);
        const m = grain(x + i * 13, y);
        out[0] *= m; out[1] *= m; out[2] *= m;
      },
    };
  }));
  // Pre-render each layer's colour (premultiplied) and alpha.
  const L = layers.map((ly) => {
    const a = new Float32Array(W * H), c = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)], col = [0, 0, 0];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, al = ly.alpha(x, y);
      if (!al) continue;
      a[i] = al;
      ly.col(x, y, col);
      for (let k = 0; k < 3; k++) c[k][i] = col[k] * al;
    }
    return { ly, a, c };
  });
  const neutral = [0.52, 1, 0.68];
  const cm = mat3mul(diag3(neutral), mat3inv(XYZ_FROM_SRGB));
  const black = 256, white = 16383;
  const files = [];
  for (let f = 0; f < n; f++) {
    // composite back to front with per-layer defocus blur
    const R = new Float32Array(W * H), G = new Float32Array(W * H), B = new Float32Array(W * H);
    const acc = [R, G, B];
    for (const { ly, a, c } of L) {
      const rad = Math.round(Math.abs(ly.depth - f) * blurK);
      const ab = rad ? boxBlur(a, W, H, rad, 3) : a;
      for (let k = 0; k < 3; k++) {
        const cb = rad ? boxBlur(c[k], W, H, rad, 3) : c[k];
        const dst = acc[k];
        for (let i = 0; i < W * H; i++) dst[i] = dst[i] * (1 - ab[i]) + cb[i];
      }
    }
    // focus breathing: magnify around centre
    const sc = 1 + 0.006 * f, dx = 0.8 * f, dy = -0.5 * f;
    const mosaic = new Uint16Array(W * H);
    const cx = W / 2, cy = H / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = Math.min(W - 1.001, Math.max(0, (x - cx) / sc + cx + dx)), v = Math.min(H - 1.001, Math.max(0, (y - cy) / sc + cy + dy));
      const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0, i = y0 * W + x0;
      const ch = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2);
      const src = acc[ch];
      const lin = (src[i] * (1 - ax) + src[i + 1] * ax) * (1 - ay) + (src[i + W] * (1 - ax) + src[i + W + 1] * ax) * ay;
      const cam = Math.max(0, lin * neutral[ch] * 0.8);
      const val = black + cam * (white - black);
      const noisy = val + (rnd() + rnd() + rnd() - 1.5) * Math.sqrt(val * 0.6 + 40);
      mosaic[y * W + x] = Math.max(0, Math.min(white, Math.round(noisy)));
    }
    const e = [
      { tag: TAG.NewSubFileType, type: 4, values: [0] }, { tag: TAG.ImageWidth, type: 4, values: [W] },
      { tag: TAG.ImageLength, type: 4, values: [H] }, { tag: TAG.BitsPerSample, type: 3, values: [16] },
      { tag: TAG.Compression, type: 3, values: [1] }, { tag: TAG.Photometric, type: 3, values: [32803] },
      { tag: TAG.Make, type: 2, values: 'Sample' }, { tag: TAG.Model, type: 2, values: 'Synthetic bracket' },
      { tag: TAG.Orientation, type: 3, values: [1] }, { tag: TAG.SamplesPerPixel, type: 3, values: [1] },
      { tag: TAG.RowsPerStrip, type: 4, values: [H] }, { tag: TAG.PlanarConfig, type: 3, values: [1] },
      { tag: TAG.CFARepeatPatternDim, type: 3, values: [2, 2] }, { tag: TAG.CFAPattern, type: 1, values: [0, 1, 1, 2] },
      { tag: TAG.DNGVersion, type: 1, values: [1, 4, 0, 0] }, { tag: TAG.UniqueCameraModel, type: 2, values: 'Synthetic bracket' },
      { tag: TAG.CFAPlaneColor, type: 1, values: [0, 1, 2] }, { tag: TAG.CFALayout, type: 3, values: [1] },
      { tag: TAG.BlackLevel, type: 3, values: [black] }, { tag: TAG.WhiteLevel, type: 3, values: [white] },
      { tag: TAG.ColorMatrix1, type: 10, values: cm }, { tag: TAG.CalibrationIlluminant1, type: 3, values: [21] },
      { tag: TAG.AsShotNeutral, type: 5, values: neutral }, { tag: TAG.BaselineExposure, type: 10, values: [0.3] },
    ];
    files.push({ name: `sample_${String(f + 1).padStart(2, '0')}.dng`, data: writeTiff(e, [new Uint8Array(mosaic.buffer)]) });
  }
  return files;
}
