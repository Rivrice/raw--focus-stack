// node test/formats.test.js — non-RAW inputs: the same bracket saved as 16-bit Deflate TIFF, 8-bit LZW TIFF
// and 8-bit uncompressed TIFF must stack like the DNG originals; mixing RAW and non-RAW is refused.
const A = require('./load');
const assert = require('assert');

// TIFF LZW encoder (MSB-first, early change), only for building test files. The decoder itself is
// was checked against libtiff-written files during development; this encoder only has to agree with it.
function lzwEncode(src) {
  const out = []; let acc = 0, nbits = 0, width = 9, next = 258;
  const put = (code) => { acc = (acc << width) | code; nbits += width; while (nbits >= 8) { out.push((acc >>> (nbits - 8)) & 255); nbits -= 8; } acc &= (1 << nbits) - 1; };
  let dict = new Map(); put(256);
  let w = -1;
  for (const c of src) {
    if (w < 0) { w = c; continue; }
    const k = w * 256 + c;
    if (dict.has(k)) { w = dict.get(k); continue; }
    put(w);
    dict.set(k, next++);
    if (next >= (1 << width) && width < 12) width++; // the decoder adds each entry one code later
    if (next >= 4094) { put(256); dict = new Map(); next = 258; width = 9; }
    w = c;
  }
  if (w >= 0) put(w);
  put(257);
  if (nbits) out.push((acc << (8 - nbits)) & 255);
  return new Uint8Array(out);
}

function tiff8(rgb, w, h, lzw) {
  const T = A.TAG, px = new Uint8Array(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = rgb[i] >> 8;
  let strip = px;
  const e = [
    { tag: T.ImageWidth, type: 4, values: [w] }, { tag: T.ImageLength, type: 4, values: [h] },
    { tag: T.BitsPerSample, type: 3, values: [8, 8, 8] }, { tag: T.Compression, type: 3, values: [lzw ? 5 : 1] },
    { tag: T.Photometric, type: 3, values: [2] }, { tag: T.SamplesPerPixel, type: 3, values: [3] },
    { tag: T.RowsPerStrip, type: 4, values: [h] }, { tag: T.PlanarConfig, type: 3, values: [1] },
  ];
  if (lzw) {
    const d = px.slice();
    for (let y = 0; y < h; y++) for (let x = w * 3 - 1; x >= 3; x--) d[y * w * 3 + x] = (d[y * w * 3 + x] - d[y * w * 3 + x - 3]) & 255;
    e.push({ tag: T.Predictor, type: 3, values: [2] });
    strip = lzwEncode(d);
    assert(Buffer.from(A.lzwDecode(strip)).equals(Buffer.from(d)), 'LZW round trip');
  }
  return A.writeTiff(e, [strip]);
}

(async () => {
  const n = 5, files = A.makeDemoStack(n, 720, 480, 11);
  const asFrames = (list) => list.map((f) => ({ name: f.name, load: async () => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) }));
  const opts = { align: true, detail: 3, smooth: 2 };
  const ref = await A.runStack(asFrames(files), opts);
  const rt = A.renderTransform(ref.meta);
  const refImg = A.renderImage(ref.data, ref.width, ref.height, rt, { bits: 16 }).data;

  // Each DNG rendered to 16-bit sRGB, as an editor would export it.
  const rendered = [];
  for (const f of files) {
    const d = await A.decodeDNG(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength), {});
    rendered.push({ name: f.name.replace('.dng', '.tif'), rgb: A.renderImage(d.data, d.width, d.height, A.renderTransform(d.meta), { bits: 16 }).data, w: d.width, h: d.height });
  }
  const variants = {
    'TIFF 16bit Deflate': await Promise.all(rendered.map(async (r) => ({ name: r.name, data: await A.writeTiff16(r.rgb, r.w, r.h) }))),
    'TIFF 8bit LZW': rendered.map((r) => ({ name: r.name, data: tiff8(r.rgb, r.w, r.h, true) })),
    'TIFF 8bit': rendered.map((r) => ({ name: r.name, data: tiff8(r.rgb, r.w, r.h, false) })),
  };
  for (const [label, list] of Object.entries(variants)) {
    const info = await A.readInputInfo(list[0].data.buffer.slice(list[0].data.byteOffset, list[0].data.byteOffset + list[0].data.byteLength));
    assert(info.display && info.width === 720, label + ' info');
    const res = await A.runStack(asFrames(list), opts);
    assert(res.meta.display, label + ' should be flagged as display-referred');
    const img = A.renderImage(res.data, res.width, res.height, A.renderTransform(res.meta), { bits: 16 }).data;
    let d = 0, c = 0;
    for (let i = 0; i < Math.min(img.length, refImg.length); i += 11) { d += Math.abs(img[i] - refImg[i]); c++; }
    const mean = d / c / 65535 * 255; // in 8-bit levels
    console.log(label.padEnd(20), 'mean difference from the DNG stack:', mean.toFixed(2), '/ 255');
    assert(res.width === ref.width && res.height === ref.height, label + ' crop');
    assert(mean < 3, label + ' differs too much from the DNG stack');
  }
  await assert.rejects(A.runStack(asFrames([files[0], variants['TIFF 8bit'][1]]), opts), /混ぜて/);
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
