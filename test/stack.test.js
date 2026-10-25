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
  assert(maxDiff <= 1, 'DNG round trip differs by ' + maxDiff);
  console.log('ok', res.width + 'x' + res.height, res.seconds.toFixed(1) + 's');
})().catch((e) => { console.error(e); process.exit(1); });
