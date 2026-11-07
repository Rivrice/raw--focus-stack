// ---- Non-RAW inputs: JPEG / HEIC / PNG / WebP / AVIF (browser decoder) and RGB TIFF ----
// These are already rendered (display-referred sRGB). They are turned into linear 16-bit RGB so
// focus detection, exposure matching and blending work the same as for RAW; meta.display tells the
// renderer to apply only the sRGB curve, without the RAW tone curve or colour matrix.

const SRGB_TO_LINEAR16 = (() => {
  const make = (n) => {
    const lut = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const v = i / (n - 1);
      lut[i] = Math.round((v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * 65535);
    }
    return lut;
  };
  let l8 = null, l16 = null;
  return (bits) => bits > 8 ? (l16 || (l16 = make(65536))) : (l8 || (l8 = make(256)));
})();

function isTiffBuffer(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b.length === 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42));
}

function imageKind(buf) {
  const b = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
  const s = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG';
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'PNG';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'WebP';
  if (s(4, 4) === 'ftyp') { const brand = s(8, 4); return /avi[fs]/.test(brand) ? 'AVIF' : 'HEIC'; }
  return '';
}

function displayMeta(w, h, format) {
  return {
    display: true, format, make: '', model: '', uniqueModel: format, orientation: 1, dateTime: '', warnings: [],
    crop: { x: 0, y: 0, w, h }, cfa: false, sourceWidth: w, sourceHeight: h, baselineExposure: 0,
  };
}

// 8- or 16-bit RGB(A) samples (spp channels, gamma-encoded) -> linear Uint16 RGB, optionally 2×2-binned.
function linearizeRGB(src, w, h, spp, bits, half) {
  const lut = SRGB_TO_LINEAR16(bits);
  if (!half) {
    const out = new Uint16Array(w * h * 3);
    for (let i = 0, o = 0; i < w * h; i++, o += 3) {
      const p = i * spp;
      out[o] = lut[src[p]]; out[o + 1] = lut[src[p + (spp > 2 ? 1 : 0)]]; out[o + 2] = lut[src[p + (spp > 2 ? 2 : 0)]];
    }
    return { data: out, w, h };
  }
  const ow = w >> 1, oh = h >> 1, out = new Uint16Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) for (let c = 0; c < 3; c++) {
    const cc = spp > 2 ? c : 0;
    const p = ((2 * y) * w + 2 * x) * spp + cc, q = p + w * spp;
    out[(y * ow + x) * 3 + c] = (lut[src[p]] + lut[src[p + spp]] + lut[src[q]] + lut[src[q + spp]] + 2) >> 2;
  }
  return { data: out, w: ow, h: oh };
}

async function decodeTiffImage(buffer, opts = {}) {
  const r = new TiffReader(buffer);
  const ifd = r.ifds[0];
  const W = r.value(ifd, TAG.ImageWidth, 0), H = r.value(ifd, TAG.ImageLength, 0);
  const spp = r.value(ifd, TAG.SamplesPerPixel, 1), bps = r.value(ifd, TAG.BitsPerSample, 8);
  const ph = r.value(ifd, TAG.Photometric, 2), comp = r.value(ifd, TAG.Compression, 1);
  if (!W || !H) throw new Error('TIFFの画像サイズが読み取れません');
  if (r.value(ifd, TAG.SampleFormat, 1) === 3) throw new Error('浮動小数点のTIFFには未対応です');
  if (bps !== 8 && bps !== 16) throw new Error(`${bps}bitのTIFFには未対応です（8bit・16bitに対応）`);
  if (ph !== 1 && ph !== 2) throw new Error('RGBかグレースケールのTIFFにだけ対応しています');
  if (r.value(ifd, TAG.PlanarConfig, 1) !== 1) throw new Error('プレーナ形式のTIFFには未対応です');
  const raw = new Uint16Array(W * H * spp);
  await readSamples(r, ifd, raw, W, H, spp, bps, comp);
  const lin = linearizeRGB(raw, W, H, spp, bps, !!opts.half);
  const meta = displayMeta(lin.w, lin.h, `TIFF ${bps}bit`);
  meta.orientation = r.value(ifd, TAG.Orientation, 1);
  meta.make = r.value(ifd, TAG.Make, ''); meta.model = r.value(ifd, TAG.Model, '');
  return { width: lin.w, height: lin.h, data: lin.data, meta };
}

async function decodeBrowserImage(buffer, opts = {}) {
  const kind = imageKind(buffer) || '画像';
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error(`このブラウザでは${kind}を読み込めません。新しいSafariかChromeで開いてください`);
  }
  let bmp;
  try { bmp = await createImageBitmap(new Blob([buffer])); } catch (e) {
    throw new Error(kind === 'HEIC' ? 'このブラウザではHEICを読み込めません。Safariで開くか、JPEGかDNGで撮影してください' : `${kind}を読み込めませんでした`);
  }
  const W = bmp.width, H = bmp.height; // EXIF orientation is already applied by the decoder
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  const px = g.getImageData(0, 0, W, H).data;
  const lin = linearizeRGB(px, W, H, 4, 8, !!opts.half);
  return { width: lin.w, height: lin.h, data: lin.data, meta: displayMeta(lin.w, lin.h, kind) };
}

// Any supported input: DNG, RGB TIFF, or a browser-decodable image.
async function decodeInput(buffer, opts = {}) {
  if (isTiffBuffer(buffer)) {
    const r = new TiffReader(buffer);
    if (r.has(r.ifds[0], TAG.DNGVersion)) return decodeDNG(buffer, opts);
    if (findRawIFD(r)) throw new Error('カメラ固有のRAW（CR2/NEF/ARWなど）には未対応です。Adobe DNG Converter等でDNGに変換してください');
    return decodeTiffImage(buffer, opts);
  }
  return decodeBrowserImage(buffer, opts);
}

async function readInputInfo(buffer) {
  if (isTiffBuffer(buffer)) {
    const r = new TiffReader(buffer);
    if (r.has(r.ifds[0], TAG.DNGVersion) || findRawIFD(r)) return readDNGInfo(buffer);
    const ifd = r.ifds[0];
    return { display: true, format: `TIFF ${r.value(ifd, TAG.BitsPerSample, 8)}bit`, make: r.value(ifd, TAG.Make, ''), model: r.value(ifd, TAG.Model, ''), width: r.value(ifd, TAG.ImageWidth, 0), height: r.value(ifd, TAG.ImageLength, 0) };
  }
  const d = await decodeBrowserImage(buffer, {});
  return { display: true, format: d.meta.format, make: '', model: '', width: d.width, height: d.height };
}
