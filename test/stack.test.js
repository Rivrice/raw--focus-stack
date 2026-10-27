// node test/stack.test.js — synthetic focus bracket: checks alignment accuracy, output size and DNG round trip.
const A = require('./load');
const assert = require('assert');
(async () => {
  const n = 6, files = A.makeDemoStack(n, 960, 640, 7);
  const res = await A.runStack(files.map((f) => ({ name: f.name, load: async () => f.data.buffer.slice(0) })), { align: true, detail: 3, smooth: 2 });
  // makeDemoStack magnifies each frame by 0.6% and shifts it by (0.8, -0.5) px per frame.
  res.frames.forEach((f, i) => {
    const sc = 1 + 0.006 * i;
    assert(Math.abs(f.scale - sc) < 0.003, `frame ${i} scale ${f.scale} vs ${sc}`);
    assert(Math.abs(f.dx + 0.8 * i * sc) < 0.6, `frame ${i} dx ${f.dx}`);
    assert(Math.abs(f.dy - 0.5 * i * sc) < 0.6, `frame ${i} dy ${f.dy}`);
  });
  assert(res.width > 880 && res.height > 580, 'crop too small');
  const dng = A.writeLinearDNG(res.data, res.width, res.height, res.meta);
  const back = await A.decodeDNG(dng.buffer.slice(0), {});
  assert.strictEqual(back.width, res.width);
  let maxDiff = 0;
  for (let i = 0; i < res.data.length; i += 97) maxDiff = Math.max(maxDiff, Math.abs(back.data[i] - res.data[i]));
  assert(maxDiff <= 5, 'DNG round trip differs by ' + maxDiff); // 14-bit storage
  const raw16 = res.width * res.height * 6;
  assert(dng.length < raw16 * 0.8, `DNG not compressed: ${dng.length} vs ${raw16}`);
  // Bayer DNG (default for full-size Bayer input): one sample per pixel, re-demosaiced on read.
  const cfa = A.writeStackDNG(res.data, res.width, res.height, res.meta);
  const cb = await A.decodeDNG(cfa.buffer.slice(cfa.byteOffset, cfa.byteOffset + cfa.byteLength), {});
  assert(cb.meta.cfa && cb.width === res.width && cb.height === res.height, 'Bayer DNG shape');
  let sad = 0, cntPx = 0;
  for (let i = 0; i < res.data.length; i += 13) { sad += Math.abs(cb.data[i] - res.data[i]); cntPx++; }
  assert(sad / cntPx < 700, 'Bayer DNG differs too much: ' + sad / cntPx);
  assert(cfa.length < files[0].data.length, `Bayer DNG ${cfa.length} larger than one source ${files[0].data.length}`);
  console.log('Bayer DNG', (cfa.length / 1024).toFixed(0) + 'KB vs source', (files[0].data.length / 1024).toFixed(0) + 'KB (uncompressed source)');
  // 16-bit TIFF: Deflate + horizontal predictor must round-trip exactly.
  const rt = A.renderTransform(res.meta);
  const r16 = A.renderImage(res.data, res.width, res.height, rt, { bits: 16 });
  const tif = await A.writeTiff16(r16.data, r16.w, r16.h);
  const tr = new A.TiffReader(tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength));
  const t0 = tr.ifds[0];
  assert.strictEqual(tr.value(t0, A.TAG.Compression), 8);
  const offs = tr.values(t0, A.TAG.StripOffsets), cnts = tr.values(t0, A.TAG.StripByteCounts), rps = tr.value(t0, A.TAG.RowsPerStrip);
  const u8 = new Uint8Array(tr.buf);
  for (let k = 0; k < offs.length; k++) {
    const inf = new Uint8Array(await new Response(new Blob([u8.subarray(offs[k], offs[k] + cnts[k])]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const v = new Uint16Array(inf.buffer, 0, inf.byteLength >> 1), rowLen = r16.w * 3;
    for (let o = 0; o < v.length; o += rowLen) for (let x = 3; x < rowLen; x++) v[o + x] = (v[o + x] + v[o + x - 3]) & 0xffff;
    const base = k * rps * rowLen;
    for (let i = 0; i < v.length; i += 31) assert.strictEqual(v[i], r16.data[base + i], 'TIFF mismatch');
  }
  console.log('sizes: DNG', (dng.length / raw16 * 100).toFixed(0) + '% of uncompressed, TIFF', (tif.length / raw16 * 100).toFixed(0) + '%');
  console.log('ok', res.width + 'x' + res.height, res.seconds.toFixed(1) + 's');
})().catch((e) => { console.error(e); process.exit(1); });
