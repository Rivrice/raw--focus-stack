// node test/exposure.test.js — a bracket whose frames differ in exposure (phone auto exposure drifting
// between shots) must come out like the evenly exposed one when exposure matching is on.
const A = require('./load');
const assert = require('assert');
(async () => {
  const n = 5, files = A.makeDemoStack(n, 720, 480, 11);
  const evs = [0, 0.4, -0.3, 0.25, -0.5];
  const shifted = files.map((f, i) => { // scale the uncompressed mosaic above black level
    const buf = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
    const tr = new A.TiffReader(buf), ifd = tr.ifds[0];
    const off = tr.value(ifd, A.TAG.StripOffsets), cnt = tr.value(ifd, A.TAG.StripByteCounts);
    const px = new Uint16Array(buf, off, cnt >> 1), m = 2 ** evs[i];
    for (let j = 0; j < px.length; j++) px[j] = Math.min(16383, Math.round(256 + (px[j] - 256) * m));
    return { name: f.name, data: new Uint8Array(buf) };
  });
  const run = (fs, opts) => A.runStack(fs.map((f) => ({ name: f.name, load: async () => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) })), Object.assign({ align: true, detail: 3, smooth: 2 }, opts));
  const ref = await run(files, {});
  const on = await run(shifted, {}), off = await run(shifted, { matchExposure: false });
  on.frames.forEach((f, i) => assert(Math.abs(f.ev + evs[i]) < 0.05, `frame ${i} correction ${f.ev.toFixed(3)} EV vs ${-evs[i]}`));
  const diff = (r) => { let d = 0, c = 0; for (let i = 0; i < Math.min(r.data.length, ref.data.length); i += 7) { d += Math.abs(r.data[i] - ref.data[i]); c++; } return d / c; };
  console.log('corrections (EV):', on.frames.map((f) => f.ev.toFixed(2)).join(' '), '| mean diff vs even bracket: matched', diff(on).toFixed(0), 'unmatched', diff(off).toFixed(0));
  assert(diff(on) < diff(off) * 0.5, 'exposure matching did not help');
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
