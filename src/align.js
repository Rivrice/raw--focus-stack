// ---- Image alignment: similarity transform (scale, rotation, shift) by pyramidal Gauss-Newton ----
// Transform params p = [a, b, tx, ty] in centred pixel coordinates of the small image:
//   u = (1+a)X - bY + tx,  v = bX + (1+a)Y + ty   (maps reference coords -> moving coords)

function downscaleLuma(img, w, h, k) {
  const sw = Math.max(1, Math.floor(w / k)), sh = Math.max(1, Math.floor(h / k));
  const out = new Float32Array(sw * sh);
  const inv = 1 / (k * k * 4 * 65535);
  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      let s = 0;
      for (let y = sy * k; y < sy * k + k; y++) {
        let o = (y * w + sx * k) * 3;
        for (let x = 0; x < k; x++, o += 3) s += img[o] + 2 * img[o + 1] + img[o + 2];
      }
      // Linear (not gamma) luma: defocus blur is linear in scene light, so edges keep their position
      // as focus changes and blur does not bias the scale (breathing) estimate.
      out[sy * sw + sx] = s * inv;
    }
  }
  return { data: out, w: sw, h: sh };
}

function half2(im) {
  const w = im.w >> 1, h = im.h >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = 2 * y * im.w + 2 * x;
    out[y * w + x] = 0.25 * (im.data[a] + im.data[a + 1] + im.data[a + im.w] + im.data[a + im.w + 1]);
  }
  return { data: out, w, h };
}

function blur3(im) {
  const { w, h, data } = im;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = data[y * w + Math.max(0, x - 1)], c = data[y * w + x], r = data[y * w + Math.min(w - 1, x + 1)];
    tmp[y * w + x] = 0.25 * l + 0.5 * c + 0.25 * r;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = tmp[Math.max(0, y - 1) * w + x], c = tmp[y * w + x], d = tmp[Math.min(h - 1, y + 1) * w + x];
    out[y * w + x] = 0.25 * u + 0.5 * c + 0.25 * d;
  }
  return { data: out, w, h };
}

function standardize(im) {
  let s = 0, s2 = 0;
  const d = im.data, n = d.length;
  for (let i = 0; i < n; i++) { s += d[i]; s2 += d[i] * d[i]; }
  const m = s / n, sd = Math.sqrt(Math.max(1e-12, s2 / n - m * m));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (d[i] - m) / sd;
  return { data: out, w: im.w, h: im.h };
}

function gradients(im) {
  const { w, h, data } = im;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    gx[i] = 0.5 * (data[y * w + Math.min(w - 1, x + 1)] - data[y * w + Math.max(0, x - 1)]);
    gy[i] = 0.5 * (data[Math.min(h - 1, y + 1) * w + x] - data[Math.max(0, y - 1) * w + x]);
  }
  return { gx, gy };
}

function solve4(H, b) {
  const A = [0, 1, 2, 3].map((i) => [H[i * 4], H[i * 4 + 1], H[i * 4 + 2], H[i * 4 + 3], b[i]]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 4; r++) if (r !== c) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[4] / row[i]);
}

// Align moving image J to reference I (both {data,w,h} small luma). Returns params and a quality score.
function alignPair(I0, J0, opts = {}) {
  const levels = [];
  let I = blur3(I0), J = blur3(J0);
  for (let k = 1; k < (opts.preBlur || 1); k++) { I = blur3(I); J = blur3(J); }
  levels.push([I, J]);
  while (Math.min(I.w, I.h) >= 96 && levels.length < 6) { I = half2(I); J = half2(J); levels.push([I, J]); }
  let p = [0, 0, 0, 0];
  const scaleOnly = !!opts.noRotation;
  for (let L = levels.length - 1; L >= 0; L--) {
    if (L < levels.length - 1) { p[2] *= 2; p[3] *= 2; }
    const Is = standardize(levels[L][0]), Js = standardize(levels[L][1]);
    const { gx, gy } = gradients(Js);
    const w = Is.w, h = Is.h, cx = (w - 1) / 2, cy = (h - 1) / 2;
    const mx = Math.max(2, Math.round(w * 0.04)), my = Math.max(2, Math.round(h * 0.04));
    const iters = L === 0 ? 12 : 25;
    for (let it = 0; it < iters; it++) {
      const Hm = new Float64Array(16), bv = new Float64Array(4);
      const a1 = 1 + p[0], b = p[1];
      let used = 0;
      for (let y = my; y < h - my; y++) {
        const Y = y - cy;
        for (let x = mx; x < w - mx; x++) {
          const X = x - cx;
          const u = a1 * X - b * Y + p[2] + cx, v = b * X + a1 * Y + p[3] + cy;
          if (u < 0 || v < 0 || u >= w - 1 || v >= h - 1) continue;
          const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
          const i00 = y0 * w + x0, i01 = i00 + 1, i10 = i00 + w, i11 = i10 + 1;
          const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
          const jv = Js.data[i00] * w00 + Js.data[i01] * w01 + Js.data[i10] * w10 + Js.data[i11] * w11;
          const ix = gx[i00] * w00 + gx[i01] * w01 + gx[i10] * w10 + gx[i11] * w11;
          const iy = gy[i00] * w00 + gy[i01] * w01 + gy[i10] * w10 + gy[i11] * w11;
          const e = jv - Is.data[y * w + x];
          const ae = Math.abs(e);
          const rw = ae < 0.6 ? 1 : 0.6 / ae; // Huber
          const g0 = ix * X + iy * Y, g1 = scaleOnly ? 0 : -ix * Y + iy * X;
          const g = [g0, g1, ix, iy];
          for (let r = 0; r < 4; r++) {
            bv[r] += rw * g[r] * e;
            for (let c = r; c < 4; c++) Hm[r * 4 + c] += rw * g[r] * g[c];
          }
          used++;
        }
      }
      if (used < 50) break;
      for (let r = 0; r < 4; r++) for (let c = 0; c < r; c++) Hm[r * 4 + c] = Hm[c * 4 + r];
      if (scaleOnly) { Hm[5] = 1; Hm[1] = Hm[4] = Hm[6] = Hm[9] = Hm[7] = Hm[13] = 0; bv[1] = 0; }
      const dp = solve4(Hm, bv);
      if (!dp) break;
      for (let k = 0; k < 4; k++) p[k] -= dp[k];
      const r = Math.max(w, h) / 2;
      if (Math.abs(dp[2]) < 0.005 && Math.abs(dp[3]) < 0.005 && Math.abs(dp[0]) * r < 0.005 && Math.abs(dp[1]) * r < 0.005) break;
    }
  }
  return p;
}

// Convert small-image params into a full-resolution 2x3 affine (ref pixel -> moving pixel).
function paramsToAffine(p, k, fullW, fullH, smallW, smallH) {
  const a1 = 1 + p[0], b = p[1];
  const cxs = (smallW - 1) / 2, cys = (smallH - 1) / 2;
  const cxf = (cxs + 0.5) * k - 0.5, cyf = (cys + 0.5) * k - 0.5;
  const tx = p[2] * k, ty = p[3] * k;
  // u = a1(x-cxf) - b(y-cyf) + tx + cxf
  return [a1, -b, cxf - a1 * cxf + b * cyf + tx, b, a1, cyf - b * cxf - a1 * cyf + ty];
}

function affineCompose(m2, m1) { // m2 ∘ m1
  return [
    m2[0] * m1[0] + m2[1] * m1[3], m2[0] * m1[1] + m2[1] * m1[4], m2[0] * m1[2] + m2[1] * m1[5] + m2[2],
    m2[3] * m1[0] + m2[4] * m1[3], m2[3] * m1[1] + m2[4] * m1[4], m2[3] * m1[2] + m2[4] * m1[5] + m2[5],
  ];
}

function affineInvert(m) {
  const det = m[0] * m[4] - m[1] * m[3];
  const a = m[4] / det, b = -m[1] / det, d = -m[3] / det, e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

function affineInfo(m, w, h) {
  const scale = Math.sqrt(m[0] * m[4] - m[1] * m[3]);
  const rot = Math.atan2(m[3], m[0]) * 180 / Math.PI;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const dx = m[0] * cx + m[1] * cy + m[2] - cx, dy = m[3] * cx + m[4] * cy + m[5] - cy;
  return { scale, rot, dx, dy };
}
