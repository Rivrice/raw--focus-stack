// ---- Worker message handling ----
const DEPTH_COLORS = [[38, 70, 83], [42, 157, 143], [138, 177, 125], [233, 196, 106], [244, 162, 97], [231, 111, 81], [190, 60, 90]];
function depthColor(t) {
  const p = t * (DEPTH_COLORS.length - 1), i = Math.min(DEPTH_COLORS.length - 2, Math.floor(p)), f = p - i;
  const a = DEPTH_COLORS[i], b = DEPTH_COLORS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const state = { result: null, rt: null, names: [] };

function renderDepth(res, maxSide) {
  const { depth, width, height } = res;
  const n = res.frames.length;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const ow = Math.floor(width / step), oh = Math.floor(height / step);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const gx = Math.min(depth.w - 1, Math.floor((x * step + depth.x0) / depth.g));
    const gy = Math.min(depth.h - 1, Math.floor((y * step + depth.y0) / depth.g));
    const c = depthColor(n > 1 ? depth.data[gy * depth.w + gx] / (n - 1) : 0);
    const o = (y * ow + x) * 4;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }
  return orient(out, ow, oh, 4, res.meta.orientation || 1);
}

function cropRegion(res, cx, cy, size) {
  // cx, cy: 0..1 in the oriented preview. Convert to stored (unoriented) coords.
  const o = res.meta.orientation || 1;
  let u = cx, v = cy;
  switch (o) {
    case 2: u = 1 - cx; break;
    case 3: u = 1 - cx; v = 1 - cy; break;
    case 4: v = 1 - cy; break;
    case 5: u = cy; v = cx; break;
    case 6: u = cy; v = 1 - cx; break;
    case 7: u = 1 - cy; v = 1 - cx; break;
    case 8: u = 1 - cy; v = cx; break;
  }
  const W = res.width, H = res.height;
  const s = Math.min(size, W, H);
  const x0 = Math.max(0, Math.min(W - s, Math.round(u * W - s / 2)));
  const y0 = Math.max(0, Math.min(H - s, Math.round(v * H - s / 2)));
  const sub = new Uint16Array(s * s * 3);
  for (let y = 0; y < s; y++) sub.set(res.data.subarray(((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + s) * 3), y * s * 3);
  return { data: sub, w: s, h: s };
}

// First frame, cropped to the same area as the result, for before/after comparison.
function renderFirst(res, exposure) {
  const f = state.first;
  if (!f) return null;
  const x0 = Math.floor(res.depth.x0 / f.step), y0 = Math.floor(res.depth.y0 / f.step);
  const cw = Math.min(f.w - x0, Math.floor(res.width / f.step)), chh = Math.min(f.h - y0, Math.floor(res.height / f.step));
  if (cw < 2 || chh < 2) return null;
  const sub = new Uint16Array(cw * chh * 3);
  for (let y = 0; y < chh; y++) sub.set(f.data.subarray(((y0 + y) * f.w + x0) * 3, ((y0 + y) * f.w + x0 + cw) * 3), y * cw * 3);
  const r = renderImage(sub, cw, chh, state.rt, { exposure, orientation: res.meta.orientation });
  return { data: r.data, w: r.w, h: r.h };
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function encodeJPEG(img) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(img.w, img.h);
  const g = c.getContext('2d');
  g.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.93 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function handleMessage(msg, post) {
  try {
    if (msg.type === 'ping') {
      post({ type: 'pong' });
    } else if (msg.type === 'info') {
      const buf = await msg.file.arrayBuffer();
      const info = readDNGInfo(buf);
      post({ type: 'info', id: msg.id, info });
    } else if (msg.type === 'run') {
      state.result = null;
      let frames;
      if (msg.demo) {
        post({ type: 'progress', phase: 0, frame: 0, total: 1, text: 'サンプルのRAWデータを作成中' });
        const files = makeDemoStack(5, 720, 480, msg.seed || 11);
        frames = files.map((f) => ({ name: f.name, load: async () => f.data.buffer.slice(0) }));
      } else {
        frames = msg.files.map((f) => ({ name: f.name, load: () => f.arrayBuffer() }));
      }
      const pvSize = msg.previewSize || 1600;
      let first = null;
      const opts = Object.assign({}, msg.opts, {
        onFirstFrame: (dec) => {
          const step = Math.max(1, Math.floor(Math.max(dec.width, dec.height) / pvSize));
          const sw = Math.floor(dec.width / step), sh = Math.floor(dec.height / step);
          const d = new Uint16Array(sw * sh * 3);
          for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let yy = 0; yy < step; yy++) for (let xx = 0; xx < step; xx++) s += dec.data[((y * step + yy) * dec.width + x * step + xx) * 3 + c];
            d[(y * sw + x) * 3 + c] = s / (step * step);
          }
          first = { data: d, w: sw, h: sh, step };
        },
      });
      const res = await runStack(frames, opts, (p) => post({ type: 'progress', ...p }));
      state.first = first;
      state.result = res;
      state.rt = renderTransform(res.meta);
      const pv = renderImage(res.data, res.width, res.height, state.rt, { maxSide: msg.previewSize || 1600, exposure: msg.exposure || 0, orientation: res.meta.orientation });
      const dp = renderDepth(res, msg.previewSize || 1600);
      const fp = renderFirst(res, msg.exposure || 0);
      post({
        type: 'done', demo: !!msg.demo, first: fp,
        preview: { data: pv.data, w: pv.w, h: pv.h }, depth: { data: dp.data, w: dp.w, h: dp.h },
        width: res.width, height: res.height, frames: res.frames, warnings: res.warnings, seconds: res.seconds,
        stats: { fine: res.stats.fine || 0 },
        camera: res.meta.uniqueModel, orientation: res.meta.orientation,
      }, [pv.data.buffer, dp.data.buffer].concat(fp ? [fp.data.buffer] : []));
    } else if (msg.type === 'preview') {
      const res = state.result; if (!res) return;
      const pv = renderImage(res.data, res.width, res.height, state.rt, { maxSide: msg.previewSize || 1600, exposure: msg.exposure || 0, orientation: res.meta.orientation });
      const fp = renderFirst(res, msg.exposure || 0);
      post({ type: 'preview', preview: { data: pv.data, w: pv.w, h: pv.h }, first: fp }, [pv.data.buffer].concat(fp ? [fp.data.buffer] : []));
    } else if (msg.type === 'zoom') {
      const res = state.result; if (!res) return;
      const c = cropRegion(res, msg.x, msg.y, msg.size || 600);
      const pv = renderImage(c.data, c.w, c.h, state.rt, { exposure: msg.exposure || 0, orientation: res.meta.orientation });
      post({ type: 'zoom', preview: { data: pv.data, w: pv.w, h: pv.h } }, [pv.data.buffer]);
    } else if (msg.type === 'export') {
      const res = state.result; if (!res) throw new Error('先に合成を実行してください');
      const base = (msg.demo ? 'sample-stack-' : 'focus-stack-') + stamp();
      let bytes, name, rgba = null;
      if (msg.format === 'compare') {
        // Before (first frame, same crop) and after at the same preview size; the page lays them out and labels them.
        const fp = renderFirst(res, msg.exposure || 0);
        if (!fp) throw new Error('比較用の合成前画像がありません');
        const r8 = renderImage(res.data, res.width, res.height, state.rt, { bits: 8, maxSide: Math.max(fp.w, fp.h), exposure: msg.exposure || 0, orientation: res.meta.orientation });
        post({ type: 'export', id: msg.id, name: base + '-before-after.jpg', pair: { before: fp, after: { data: r8.data, w: r8.w, h: r8.h } } }, [fp.data.buffer, r8.data.buffer]);
        return;
      }
      if (msg.format === 'dng') {
        bytes = writeStackDNG(res.data, res.width, res.height, res.meta);
        name = base + '.dng';
      } else if (msg.format === 'tiff') {
        const r16 = renderImage(res.data, res.width, res.height, state.rt, { bits: 16, exposure: msg.exposure || 0, orientation: res.meta.orientation });
        bytes = await writeTiff16(r16.data, r16.w, r16.h);
        name = base + '.tif';
      } else {
        const r8 = renderImage(res.data, res.width, res.height, state.rt, { bits: 8, exposure: msg.exposure || 0, orientation: res.meta.orientation });
        bytes = await encodeJPEG(r8);
        name = base + '.jpg';
        if (!bytes) rgba = r8;
      }
      if (rgba) {
        post({ type: 'export', id: msg.id, name, rgba: { data: rgba.data, w: rgba.w, h: rgba.h } }, [rgba.data.buffer]);
      } else {
        let zip = null;
        if (msg.zip && msg.format !== 'jpeg') {
          zip = makeZip([{ name, data: bytes }]);
        }
        post({ type: 'export', id: msg.id, name, bytes: zip ? null : bytes, zip }, zip ? [] : [bytes.buffer]);
      }
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
  }
}
