// ---- DNG decoding: raw samples -> normalized linear camera RGB (Uint16, 0..65535) ----

const XYZ_FROM_SRGB = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];

function mat3mul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
function mat3vec(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
function mat3inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}
function diag3(v) { return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]; }

function findRawIFD(r) {
  let best = null;
  for (const ifd of r.allIFDs()) {
    const nsf = r.value(ifd, TAG.NewSubFileType, 0);
    const ph = r.value(ifd, TAG.Photometric, 0);
    if (nsf !== 0 || (ph !== 32803 && ph !== 34892)) continue;
    const w = r.value(ifd, TAG.ImageWidth, 0), h = r.value(ifd, TAG.ImageLength, 0);
    if (!best || w * h > best.w * best.h) best = { ifd, w, h, ph };
  }
  return best;
}

// Lightweight metadata read (no pixel decode).
function readDNGInfo(buffer) {
  const r = new TiffReader(buffer);
  const ifd0 = r.ifds[0];
  const raw = findRawIFD(r);
  if (!raw) throw new Error('RAW画像データが見つかりません');
  return {
    isDNG: r.has(ifd0, TAG.DNGVersion),
    make: r.value(ifd0, TAG.Make, ''), model: r.value(ifd0, TAG.Model, ''),
    width: raw.w, height: raw.h, cfa: raw.ph === 32803,
    compression: r.value(raw.ifd, TAG.Compression, 1),
  };
}

async function decodeDNG(buffer, opts = {}) {
  const r = new TiffReader(buffer);
  const ifd0 = r.ifds[0];
  if (!r.has(ifd0, TAG.DNGVersion)) throw new Error('DNGファイルではありません。カメラ固有のRAW(CR3/NEF/ARWなど)はAdobe DNG Converter等でDNGに変換してください');
  const found = findRawIFD(r);
  if (!found) throw new Error('RAW画像データが見つかりません');
  const ifd = found.ifd;
  const W = found.w, H = found.h;
  const isCFA = found.ph === 32803;
  const spp = r.value(ifd, TAG.SamplesPerPixel, 1);
  const bps = r.value(ifd, TAG.BitsPerSample, 16);
  const comp = r.value(ifd, TAG.Compression, 1);
  if (r.value(ifd, TAG.PlanarConfig, 1) !== 1) throw new Error('プレーナ形式のDNGには未対応です');
  if (!isCFA && spp !== 3) throw new Error('この形式のLinearRaw DNG(' + spp + 'チャンネル)には未対応です');
  if (r.value(ifd, TAG.SampleFormat, 1) === 3) throw new Error('浮動小数点DNG(HDR合成DNGなど)には未対応です');

  const raw = new Uint16Array(W * H * spp);
  await readSamples(r, ifd, raw, W, H, spp, bps, comp);

  // Linearization
  const lin = r.values(ifd, TAG.LinearizationTable);
  if (lin && lin.length) {
    const n = lin.length - 1;
    const lut = new Uint16Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = lin[Math.min(i, n)];
    for (let i = 0; i < raw.length; i++) raw[i] = lut[raw[i]];
  }

  // Active area
  const aa = r.values(ifd, TAG.ActiveArea) || [0, 0, H, W];
  const top = aa[0], left = aa[1], aw = aa[3] - aa[1], ah = aa[2] - aa[0];

  // Black / white levels
  const brd = r.values(ifd, TAG.BlackLevelRepeatDim) || [1, 1];
  const brr = Math.max(1, brd[0]), brc = Math.max(1, brd[1]);
  const blRaw = r.values(ifd, TAG.BlackLevel) || [0];
  const bl = new Float64Array(brr * brc * spp);
  for (let i = 0; i < bl.length; i++) bl[i] = blRaw[Math.min(i, blRaw.length - 1)];
  const dH = r.values(ifd, TAG.BlackLevelDeltaH);
  const dV = r.values(ifd, TAG.BlackLevelDeltaV);
  const wlRaw = r.values(ifd, TAG.WhiteLevel) || [(1 << (lin ? 16 : bps)) - 1];
  const wl = []; for (let s = 0; s < spp; s++) wl.push(wlRaw[Math.min(s, wlRaw.length - 1)]);

  const norm = normalizeRaw(raw, W, top, left, aw, ah, spp, bl, brr, brc, dH, dV, wl);

  // OpcodeList2 (gain maps for lens shading), applied to the normalized image
  const op2 = r.bytes(ifd, TAG.OpcodeList2);
  const warnings = [];
  if (op2) applyOpcodeList(op2, norm, aw, ah, spp, warnings);

  // Colour metadata
  const meta = readColorMeta(r, ifd0, ifd, spp);
  meta.make = r.value(ifd0, TAG.Make, '');
  meta.model = r.value(ifd0, TAG.Model, '');
  meta.uniqueModel = r.value(ifd0, TAG.UniqueCameraModel, '') || (meta.make + ' ' + meta.model).trim();
  meta.orientation = r.value(ifd0, TAG.Orientation, 1);
  meta.dateTime = r.value(ifd0, TAG.DateTime, '');
  meta.warnings = warnings;

  // Default crop, relative to active area
  const dco = r.values(ifd, TAG.DefaultCropOrigin) || [0, 0];
  const dcs = r.values(ifd, TAG.DefaultCropSize) || [aw, ah];
  let crop = { x: Math.round(dco[0]), y: Math.round(dco[1]), w: Math.round(dcs[0]), h: Math.round(dcs[1]) };

  let out, ow, oh;
  if (isCFA) {
    const pat = cfaPattern(r, ifd);
    if (!opts.half) meta.cfaPattern = pat;
    if (opts.half) { ({ out, ow, oh } = superpixel(norm, aw, ah, pat)); }
    else { out = demosaicEdge(norm, aw, ah, pat); ow = aw; oh = ah; }
  } else if (opts.half) {
    ({ out, ow, oh } = halve3(norm, aw, ah));
  } else { out = norm; ow = aw; oh = ah; }
  if (opts.half) crop = { x: crop.x >> 1, y: crop.y >> 1, w: crop.w >> 1, h: crop.h >> 1 };
  crop.x = Math.max(0, Math.min(crop.x, ow - 1)); crop.y = Math.max(0, Math.min(crop.y, oh - 1));
  crop.w = Math.max(1, Math.min(crop.w, ow - crop.x)); crop.h = Math.max(1, Math.min(crop.h, oh - crop.y));
  meta.crop = crop;
  meta.cfa = isCFA;
  meta.sourceWidth = aw; meta.sourceHeight = ah;
  return { width: ow, height: oh, data: out, meta };
}

function normalizeRaw(raw, W, top, left, aw, ah, spp, bl, brr, brc, dH, dV, wl) {
  const norm = new Uint16Array(aw * ah * spp);
  for (let y = 0; y < ah; y++) {
    const dv = dV ? dV[y] || 0 : 0;
    const srow = ((y + top) * W + left) * spp;
    const drow = y * aw * spp;
    const by = (y % brr) * brc;
    for (let x = 0; x < aw; x++) {
      const dh = dH ? dH[x] || 0 : 0;
      const bx = (by + (x % brc)) * spp;
      for (let s = 0; s < spp; s++) {
        const b = bl[bx + s] + dv + dh;
        const sc = 65535 / Math.max(1, wl[s] - b);
        const v = (raw[srow + x * spp + s] - b) * sc;
        norm[drow + x * spp + s] = v <= 0 ? 0 : v >= 65535 ? 65535 : v + 0.5;
      }
    }
  }
  return norm;
}

function cfaPattern(r, ifd) {
  const dim = r.values(ifd, TAG.CFARepeatPatternDim) || [2, 2];
  const pat = r.values(ifd, TAG.CFAPattern);
  const plane = r.values(ifd, TAG.CFAPlaneColor) || [0, 1, 2];
  if (dim[0] !== 2 || dim[1] !== 2 || !pat || pat.length < 4) throw new Error('ベイヤー配列以外のセンサー(X-Transなど)には未対応です');
  const p = pat.slice(0, 4).map((v) => plane[v]);
  const counts = [0, 0, 0];
  for (const c of p) { if (c > 2) throw new Error('RGB以外のカラーフィルタ配列には未対応です'); counts[c]++; }
  if (counts[0] !== 1 || counts[1] !== 2 || counts[2] !== 1) throw new Error('対応していないカラーフィルタ配列です');
  return p;
}

function readColorMeta(r, ifd0, rawIfd, spp) {
  const get = (tag) => r.values(rawIfd, tag) || r.values(ifd0, tag);
  const m = {
    colorMatrix1: get(TAG.ColorMatrix1), colorMatrix2: get(TAG.ColorMatrix2),
    illuminant1: (get(TAG.CalibrationIlluminant1) || [0])[0], illuminant2: (get(TAG.CalibrationIlluminant2) || [0])[0],
    forwardMatrix1: get(TAG.ForwardMatrix1), forwardMatrix2: get(TAG.ForwardMatrix2),
    cameraCalibration1: get(TAG.CameraCalibration1), cameraCalibration2: get(TAG.CameraCalibration2),
    analogBalance: get(TAG.AnalogBalance), asShotNeutral: get(TAG.AsShotNeutral), asShotWhiteXY: get(TAG.AsShotWhiteXY),
    baselineExposure: (get(TAG.BaselineExposure) || [0])[0],
  };
  for (const k of ['colorMatrix1', 'colorMatrix2', 'forwardMatrix1', 'forwardMatrix2', 'cameraCalibration1', 'cameraCalibration2']) {
    if (m[k] && m[k].length !== 9) m[k] = null;
  }
  return m;
}

// Matrix taking white-balanced camera RGB to linear sRGB, plus WB multipliers.
function renderTransform(meta) {
  let cm = meta.colorMatrix1, cc = meta.cameraCalibration1;
  if (meta.colorMatrix2 && (meta.illuminant2 === 21 || meta.illuminant2 === 23 || !meta.colorMatrix1)) { cm = meta.colorMatrix2; cc = meta.cameraCalibration2; }
  if (!cm) cm = mat3inv(XYZ_FROM_SRGB); // no colour info: treat as sRGB
  if (cc) cm = mat3mul(cc, cm);
  if (meta.analogBalance && meta.analogBalance.length === 3) cm = mat3mul(diag3(meta.analogBalance), cm);
  let n = meta.asShotNeutral && meta.asShotNeutral.length === 3 ? meta.asShotNeutral.slice() : null;
  if (!n && meta.asShotWhiteXY) {
    const [x, y] = meta.asShotWhiteXY;
    n = mat3vec(cm, [x / y, 1, (1 - x - y) / y]);
  }
  if (!n || n.some((v) => !(v > 0))) n = mat3vec(cm, [0.95047, 1, 1.08883]);
  const camFromRgb = mat3mul(cm, XYZ_FROM_SRGB);
  for (let i = 0; i < 3; i++) {
    const s = camFromRgb[i * 3] + camFromRgb[i * 3 + 1] + camFromRgb[i * 3 + 2];
    for (let j = 0; j < 3; j++) camFromRgb[i * 3 + j] /= s || 1;
  }
  const rgbFromCam = mat3inv(camFromRgb) || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const mx = Math.max(n[0], n[1], n[2]);
  const wb = n.map((v) => mx / v);
  return { wb, matrix: rgbFromCam, baselineExposure: meta.baselineExposure || 0 };
}

async function readSamples(r, ifd, raw, W, H, spp, bps, comp) {
  const tiled = r.has(ifd, TAG.TileOffsets);
  let offs, counts, tw, th;
  if (tiled) {
    offs = r.values(ifd, TAG.TileOffsets); counts = r.values(ifd, TAG.TileByteCounts);
    tw = r.value(ifd, TAG.TileWidth); th = r.value(ifd, TAG.TileLength);
  } else {
    offs = r.values(ifd, TAG.StripOffsets); counts = r.values(ifd, TAG.StripByteCounts);
    tw = W; th = r.value(ifd, TAG.RowsPerStrip, H);
    if (th > H) th = H;
  }
  if (!offs || !offs.length) throw new Error('画像データの位置情報がありません');
  if (!counts) counts = offs.map((o, i) => (i + 1 < offs.length ? offs[i + 1] - o : r.buf.byteLength - o));
  const across = Math.ceil(W / tw);
  const u8 = new Uint8Array(r.buf);
  const predictor = r.value(ifd, TAG.Predictor, 1);
  for (let t = 0; t < offs.length; t++) {
    const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
    if (ty >= H) break;
    const bytes = u8.subarray(offs[t], Math.min(offs[t] + counts[t], u8.length));
    const rows = tiled ? th : Math.min(th, H - ty);
    let tile; // Uint16Array tw*rows*spp
    if (comp === 1) {
      tile = unpackBits(bytes, tw, rows, spp, bps, r.le);
    } else if (comp === 7) {
      const j = decodeLJ92(bytes);
      tile = j.data;
    } else if (comp === 8) {
      const inflated = await inflate(bytes);
      tile = unpackBits(inflated, tw, rows, spp, bps, r.le);
      if (predictor === 2) {
        for (let y = 0; y < rows; y++) for (let x = 1; x < tw; x++) for (let s = 0; s < spp; s++) {
          const i = (y * tw + x) * spp + s; tile[i] = (tile[i] + tile[i - spp]) & 0xffff;
        }
      } else if (predictor !== 1) throw new Error('未対応の予測方式(Predictor ' + predictor + ')です');
    } else if (comp === 34892 || comp === 52546) {
      tile = await decodeLossyTile(bytes, tw, rows, spp);
    } else {
      throw new Error('未対応の圧縮形式です (Compression ' + comp + ')');
    }
    // Flat copy (LJ92 frames may have a different shape but the same sample order).
    const rowSamples = tw * spp;
    const maxRows = Math.min(rows, H - ty);
    const copyW = Math.min(tw, W - tx) * spp;
    for (let y = 0; y < maxRows; y++) {
      const src = y * rowSamples;
      if (src >= tile.length) break;
      raw.set(tile.subarray(src, Math.min(src + copyW, tile.length)), ((ty + y) * W + tx) * spp);
    }
  }
}

function unpackBits(bytes, w, rows, spp, bps, le) {
  const n = w * rows * spp;
  const out = new Uint16Array(n);
  if (bps === 16) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const m = Math.min(n, bytes.byteLength >> 1);
    for (let i = 0; i < m; i++) out[i] = dv.getUint16(i * 2, le);
  } else if (bps === 8) {
    out.set(bytes.subarray(0, Math.min(n, bytes.length)));
  } else if (bps < 16) {
    const rowBits = w * spp * bps;
    const rowBytes = (rowBits + 7) >> 3;
    for (let y = 0; y < rows; y++) {
      let p = y * rowBytes, acc = 0, cnt = 0;
      const o = y * w * spp;
      for (let x = 0; x < w * spp; x++) {
        while (cnt < bps) { acc = ((acc << 8) | (bytes[p++] || 0)) & 0xffffff; cnt += 8; }
        cnt -= bps;
        out[o + x] = (acc >> cnt) & ((1 << bps) - 1);
      }
    }
  } else throw new Error(bps + 'bitのデータには未対応です');
  return out;
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('このブラウザはDeflate圧縮DNGを展開できません');
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

async function decodeLossyTile(bytes, tw, rows, spp) {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('このブラウザは非可逆圧縮DNGを展開できません');
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes])); }
  catch (e) { throw new Error('非可逆圧縮DNGのタイルを展開できませんでした(JPEG XL形式はiPhone/Safariのみ対応)'); }
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Uint16Array(tw * rows * spp);
  for (let y = 0; y < Math.min(rows, bmp.height); y++) for (let x = 0; x < Math.min(tw, bmp.width); x++) for (let s = 0; s < spp; s++) {
    out[(y * tw + x) * spp + s] = px[(y * bmp.width + x) * 4 + Math.min(s, 2)];
  }
  return out;
}

function applyOpcodeList(bytes, img, w, h, spp, warnings) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const count = dv.getUint32(p); p += 4;
  for (let k = 0; k < count && p + 16 <= bytes.length; k++) {
    const id = dv.getUint32(p), flags = dv.getUint32(p + 8), size = dv.getUint32(p + 12);
    const q = p + 16;
    if (id === 9) {
      const top = dv.getUint32(q), left = dv.getUint32(q + 4), bottom = dv.getUint32(q + 8), right = dv.getUint32(q + 12);
      const plane = dv.getUint32(q + 16), planes = dv.getUint32(q + 20), rowPitch = dv.getUint32(q + 24), colPitch = dv.getUint32(q + 28);
      const mpv = dv.getUint32(q + 32), mph = dv.getUint32(q + 36);
      const msv = dv.getFloat64(q + 40), msh = dv.getFloat64(q + 48), mov = dv.getFloat64(q + 56), moh = dv.getFloat64(q + 64);
      const mplanes = dv.getUint32(q + 72);
      const gains = new Float32Array(mpv * mph * mplanes);
      for (let i = 0; i < gains.length; i++) gains[i] = dv.getFloat32(q + 76 + i * 4);
      for (let y = top; y < Math.min(bottom, h); y += Math.max(1, rowPitch)) {
        let fy = ((y + 0.5) / h - mov) / (msv || 1);
        fy = Math.max(0, Math.min(mpv - 1, fy));
        const y0 = Math.min(mpv - 1, Math.floor(fy)), y1 = Math.min(mpv - 1, y0 + 1), wy = fy - y0;
        for (let x = left; x < Math.min(right, w); x += Math.max(1, colPitch)) {
          let fx = ((x + 0.5) / w - moh) / (msh || 1);
          fx = Math.max(0, Math.min(mph - 1, fx));
          const x0 = Math.min(mph - 1, Math.floor(fx)), x1 = Math.min(mph - 1, x0 + 1), wx = fx - x0;
          for (let pl = plane; pl < Math.min(plane + planes, spp); pl++) {
            const mp = Math.min(pl - plane, mplanes - 1);
            const g00 = gains[(y0 * mph + x0) * mplanes + mp], g01 = gains[(y0 * mph + x1) * mplanes + mp];
            const g10 = gains[(y1 * mph + x0) * mplanes + mp], g11 = gains[(y1 * mph + x1) * mplanes + mp];
            const g = (g00 * (1 - wx) + g01 * wx) * (1 - wy) + (g10 * (1 - wx) + g11 * wx) * wy;
            const i = (y * w + x) * spp + pl;
            const v = img[i] * g;
            img[i] = v >= 65535 ? 65535 : v + 0.5;
          }
        }
      }
    } else if (!(flags & 1) && id !== 1 /* WarpRectilinear: lens distortion, safe to skip for stacking */) {
      warnings.push('DNG処理命令(Opcode ' + id + ')は適用していません');
    }
    p = q + size;
  }
}

// Half-size, no interpolation: each 2x2 Bayer cell -> one RGB pixel.
function superpixel(m, w, h, pat) {
  const ow = w >> 1, oh = h >> 1;
  const out = new Uint16Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const a = (2 * y * w + 2 * x);
      const v = [m[a], m[a + 1], m[a + w], m[a + w + 1]];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) { const c = pat[k]; if (c === 0) r = v[k]; else if (c === 2) b = v[k]; else g += v[k]; }
      const o = (y * ow + x) * 3;
      out[o] = r; out[o + 1] = (g + 1) >> 1; out[o + 2] = b;
    }
  }
  return { out, ow, oh };
}

function halve3(m, w, h) {
  const ow = w >> 1, oh = h >> 1;
  const out = new Uint16Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) for (let c = 0; c < 3; c++) {
    const a = (2 * y * w + 2 * x) * 3 + c;
    out[(y * ow + x) * 3 + c] = (m[a] + m[a + 3] + m[a + w * 3] + m[a + w * 3 + 3] + 2) >> 2;
  }
  return { out, ow, oh };
}

// Edge-directed demosaic: Hamilton-Adams style green interpolation (choose the direction with the
// smaller gradient, with a Laplacian correction from the centre colour), then red/blue by
// bilinear interpolation of colour differences (R-G, B-G).
function demosaicEdge(m, w, h, pat) {
  const P = 2, pw = w + 2 * P, ph = h + 2 * P;
  const pad = new Float32Array(pw * ph);
  const refl = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let y = 0; y < ph; y++) {
    const sy = refl(y - P, h);
    for (let x = 0; x < pw; x++) pad[y * pw + x] = m[sy * w + refl(x - P, w)];
  }
  const colorAt = (y, x) => pat[((y & 1) << 1) | (x & 1)]; // y, x in image coords (pattern phase preserved by reflection)
  // 1. Green plane
  const G = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x;
      if (colorAt(y - P, x - P) === 1 || x < 2 || y < 2 || x >= pw - 2 || y >= ph - 2) { G[i] = pad[i]; continue; }
      const c = pad[i];
      const lapH = 2 * c - pad[i - 2] - pad[i + 2], lapV = 2 * c - pad[i - 2 * pw] - pad[i + 2 * pw];
      const dH = Math.abs(pad[i - 1] - pad[i + 1]) + Math.abs(lapH);
      const dV = Math.abs(pad[i - pw] - pad[i + pw]) + Math.abs(lapV);
      const gH = (pad[i - 1] + pad[i + 1]) / 2 + lapH / 4;
      const gV = (pad[i - pw] + pad[i + pw]) / 2 + lapV / 4;
      G[i] = dH < dV ? gH : dV < dH ? gV : (gH + gV) / 2;
    }
  }
  // Border pixels of the padded plane at non-green sites: simple average of neighbours.
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    if (x >= 2 && y >= 2 && x < pw - 2 && y < ph - 2) continue;
    if (colorAt(y - P, x - P) === 1) continue;
    let s = 0, n = 0;
    for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < ph && xx < pw) { s += pad[yy * pw + xx]; n++; }
    }
    G[y * pw + x] = s / n;
  }
  // 2. Colour differences at their own sites, then bilinear fill.
  const out = new Uint16Array(w * h * 3);
  const clamp = (v) => (v <= 0 ? 0 : v >= 65535 ? 65535 : v + 0.5);
  const diff = (i, c, y, x) => (colorAt(y, x) === c ? pad[i] - G[i] : NaN);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const yy = y + P, xx = x + P, i = yy * pw + xx;
      const c = colorAt(y, x);
      const g = G[i];
      const o = (y * w + x) * 3;
      out[o + 1] = clamp(g);
      for (const t of [0, 2]) {
        let v;
        if (c === t) v = pad[i];
        else if (c === 1) {
          // Green site: the target colour is either left/right or above/below.
          const hd = diff(i - 1, t, y, x - 1);
          v = !Number.isNaN(hd) ? g + (hd + (pad[i + 1] - G[i + 1])) / 2
            : g + ((pad[i - pw] - G[i - pw]) + (pad[i + pw] - G[i + pw])) / 2;
        } else {
          // Opposite chroma site: the target colour is on the four diagonals.
          v = g + ((pad[i - pw - 1] - G[i - pw - 1]) + (pad[i - pw + 1] - G[i - pw + 1]) + (pad[i + pw - 1] - G[i + pw - 1]) + (pad[i + pw + 1] - G[i + pw + 1])) / 4;
        }
        out[o + t] = clamp(v);
      }
    }
  }
  return out;
}
