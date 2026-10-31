// ---- Focus stacking engine ----
// Two passes over the frames so only one decoded frame is in memory at a time:
//  1. decode, align to the previous frame, measure local sharpness -> depth index per cell
//  2. decode again, blend each frame where it is the sharpest (soft weights per frame)

function boxBlur(src, w, h, r, passes = 2) {
  if (r <= 0) return src;
  let a = src;
  const tmp = new Float32Array(w * h);
  const col = new Float64Array(w);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    // horizontal: a -> tmp
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[o + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s * norm;
        const xa = x + r + 1, xr = x - r;
        s += a[o + (xa >= w ? w - 1 : xa)] - a[o + (xr < 0 ? 0 : xr)];
      }
    }
    // vertical with running column sums: tmp -> dst (row-major, cache friendly)
    const dst = a === src ? new Float32Array(w * h) : a;
    col.fill(0);
    for (let k = -r; k <= r; k++) {
      const o = (k < 0 ? 0 : k >= h ? h - 1 : k) * w;
      for (let x = 0; x < w; x++) col[x] += tmp[o + x];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) dst[o + x] = col[x] * norm;
      const ya = y + r + 1, yr = y - r;
      const oa = (ya >= h ? h - 1 : ya) * w, or = (yr < 0 ? 0 : yr) * w;
      for (let x = 0; x < w; x++) col[x] += tmp[oa + x] - tmp[or + x];
    }
    a = dst;
  }
  return a;
}

// Sharpness energy per grid cell (cell = g x g pixels), in the frame's own coordinates.
function focusEnergy(img, w, h, g) {
  // sqrt-luma (roughly equalises shot noise), lightly smoothed, then squared Laplacian.
  const L = new Float32Array(w * h);
  const inv = 1 / (4 * 65535);
  for (let i = 0, o = 0; i < w * h; i++, o += 3) L[i] = Math.sqrt((img[o] + 2 * img[o + 1] + img[o + 2]) * inv);
  const gw = Math.floor(w / g), gh = Math.floor(h / g);
  const E = new Float32Array(gw * gh), M = new Float32Array(gw * gh);
  const row = (y) => Math.min(h - 1, Math.max(0, y)) * w;
  // Binomial-smoothed Laplacian computed row by row with a small ring of smoothed rows.
  const S = [new Float32Array(w), new Float32Array(w), new Float32Array(w)];
  const smoothRow = (y, out) => {
    const r0 = row(y - 1), r1 = row(y), r2 = row(y + 1);
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const c = L[r1 + x] * 4 + (L[r1 + xl] + L[r1 + xr] + L[r0 + x] + L[r2 + x]) * 2 + L[r0 + xl] + L[r0 + xr] + L[r2 + xl] + L[r2 + xr];
      out[x] = c / 16;
    }
  };
  smoothRow(-1, S[0]); smoothRow(0, S[1]);
  const gi = 1 / (g * g);
  for (let y = 0; y < gh * g; y++) {
    smoothRow(y + 1, S[2]);
    const up = S[0], mid = S[1], dn = S[2];
    const ey = Math.floor(y / g) * gw;
    for (let x = 0; x < gw * g; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const lap = up[x] + dn[x] + mid[xl] + mid[xr] - 4 * mid[x];
      const c = ey + ((x / g) | 0);
      E[c] += lap * lap * gi; M[c] += mid[x] * gi;
    }
    const t = S[0]; S[0] = S[1]; S[1] = S[2]; S[2] = t;
  }
  return { E, M, gw, gh };
}

// Sample a grid map defined in frame coordinates at reference grid positions via affine m (ref px -> frame px).
function warpGrid(E, gw, gh, g, m, outW, outH) {
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const fy = (y + 0.5) * g - 0.5;
    for (let x = 0; x < outW; x++) {
      const fx = (x + 0.5) * g - 0.5;
      const u = (m[0] * fx + m[1] * fy + m[2] + 0.5) / g - 0.5;
      const v = (m[3] * fx + m[4] * fy + m[5] + 0.5) / g - 0.5;
      const uc = Math.min(gw - 1.001, Math.max(0, u)), vc = Math.min(gh - 1.001, Math.max(0, v));
      const x0 = uc | 0, y0 = vc | 0, ax = uc - x0, ay = vc - y0;
      const i = y0 * gw + x0;
      out[y * outW + x] = (E[i] * (1 - ax) + E[i + 1] * ax) * (1 - ay) + (E[i + gw] * (1 - ax) + E[i + gw + 1] * ax) * ay;
    }
  }
  return out;
}

function median3u8(src, w, h) {
  const out = new Uint8Array(src.length);
  const v = new Int32Array(9);
  const sw = (i, j) => { if (v[i] > v[j]) { const t = v[i]; v[i] = v[j]; v[j] = t; } };
  for (let y = 0; y < h; y++) {
    const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : x;
      v[0] = src[r0 + xl]; v[1] = src[r0 + x]; v[2] = src[r0 + xr];
      v[3] = src[r1 + xl]; v[4] = src[r1 + x]; v[5] = src[r1 + xr];
      v[6] = src[r2 + xl]; v[7] = src[r2 + x]; v[8] = src[r2 + xr];
      // median-of-9 sorting network
      sw(1, 2); sw(4, 5); sw(7, 8); sw(0, 1); sw(3, 4); sw(6, 7); sw(1, 2); sw(4, 5); sw(7, 8);
      sw(0, 3); sw(5, 8); sw(4, 7); sw(3, 6); sw(1, 4); sw(2, 5); sw(4, 7); sw(4, 2); sw(6, 4); sw(4, 2);
      out[r1 + x] = v[4];
    }
  }
  return out;
}

const yieldTick = () => new Promise((r) => setTimeout(r, 0));

// gain scales the frame to the reference exposure; clipped highlights stay at white instead of turning grey.
function compositeFrame(out, CW, CH, x0, y0, img, W, H, m, wgt, gw, gh, g, gain = 1) {
  for (let y = 0; y < CH; y++) {
    const ry = y + y0;
    const gyf = (ry + 0.5) / g - 0.5;
    const gy0 = Math.min(gh - 1, Math.max(0, Math.floor(gyf))), gy1 = Math.min(gh - 1, gy0 + 1), ay = Math.min(1, Math.max(0, gyf - gy0));
    const rowW0 = gy0 * gw, rowW1 = gy1 * gw;
    for (let x = 0; x < CW; x++) {
      const rx = x + x0;
      const gxf = (rx + 0.5) / g - 0.5;
      const gx0 = Math.min(gw - 1, Math.max(0, Math.floor(gxf))), gx1 = Math.min(gw - 1, gx0 + 1), ax = Math.min(1, Math.max(0, gxf - gx0));
      const a = wgt[rowW0 + gx0], b = wgt[rowW0 + gx1], c = wgt[rowW1 + gx0], d = wgt[rowW1 + gx1];
      if (a + b + c + d === 0) continue;
      const wv = (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
      if (wv < 1e-4) continue;
      let u = m[0] * rx + m[1] * ry + m[2], v = m[3] * rx + m[4] * ry + m[5];
      u = Math.min(W - 1.001, Math.max(0, u)); v = Math.min(H - 1.001, Math.max(0, v));
      const ux = u | 0, vy = v | 0, fx = u - ux, fy = v - vy;
      const p00 = (vy * W + ux) * 3, p10 = p00 + W * 3;
      const w00 = (1 - fx) * (1 - fy) * wv, w01 = fx * (1 - fy) * wv, w10 = (1 - fx) * fy * wv, w11 = fx * fy * wv;
      const o = (y * CW + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        let s = img[p00 + ch] * w00 + img[p00 + 3 + ch] * w01 + img[p10 + ch] * w10 + img[p10 + 3 + ch] * w11;
        if (gain !== 1) s = gain < 1 && s >= 65000 * wv ? 65535 * wv : s * gain;
        const nv = out[o + ch] + s + 0.5;
        out[o + ch] = nv > 65535 ? 65535 : nv;
      }
    }
  }
}

// Brightness of frame b relative to frame a (b ≈ ratio · a), from heavily smoothed linear luma so the
// focus change itself does not count. rel maps a's pixels to b's (full-size px); k is the downscale.
// Near-black and near-clipped areas are left out; the median of per-pixel log ratios ignores
// whatever moved or changed between the two shots.
function exposureRatio(a, b, rel, k) {
  const A = boxBlur(a.data, a.w, a.h, 3, 2), B = boxBlur(b.data, b.w, b.h, 3, 2);
  const logs = [];
  for (let y = 4; y < a.h - 4; y += 2) for (let x = 4; x < a.w - 4; x += 2) {
    const va = A[y * a.w + x];
    if (va < 0.01 || va > 0.8) continue;
    const fx = (x + 0.5) * k - 0.5, fy = (y + 0.5) * k - 0.5;
    const u = (rel[0] * fx + rel[1] * fy + rel[2] + 0.5) / k - 0.5, v = (rel[3] * fx + rel[4] * fy + rel[5] + 0.5) / k - 0.5;
    if (u < 0 || v < 0 || u >= b.w - 1 || v >= b.h - 1) continue;
    const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0, i = y0 * b.w + x0;
    const vb = (B[i] * (1 - ax) + B[i + 1] * ax) * (1 - ay) + (B[i + b.w] * (1 - ax) + B[i + b.w + 1] * ax) * ay;
    if (vb < 0.01 || vb > 0.8) continue;
    logs.push(Math.log(vb / va));
  }
  if (logs.length < 200) return 1;
  logs.sort((p, q) => p - q);
  return Math.exp(logs[logs.length >> 1]);
}

// Optionally records, for the winning frame, its local brightness (mean) and fine-scale energy (Ef).
function updateBest(Ew, best, idx, i, mean, meanAt, Ef, EfAt) {
  for (let j = 0; j < Ew.length; j++) {
    if (i === 0 || Ew[j] > best[j]) {
      best[j] = Ew[j]; idx[j] = i;
      if (meanAt) meanAt[j] = mean[j] * 65535; // Uint16, sqrt-luma 0..1
      if (EfAt) EfAt[j] = Ef[j];
    }
  }
}

// frames: [{name, load: async () => ArrayBuffer}]
// opts: {half, align, noRotation, detail (1..10), smooth (0..10)}
async function runStack(frames, opts, progress = () => {}) {
  const N = frames.length;
  if (N < 2) throw new Error('2枚以上の画像を選んでください');
  if (N > 255) throw new Error('一度に合成できるのは255枚までです');
  const decodeOpts = { half: !!opts.half };
  const t0 = Date.now();
  let W = 0, H = 0, g = 1, gw = 0, gh = 0, refMeta = null;
  let best = null, idx = null, bestF = null, idxF = null, meanF = null, meanC = null, efC = null;
  const coarseR = Math.max(1, Math.round(opts.detail || 3));
  // A second, 1-cell detection window runs alongside the user's one (opts.fine: 0 turns it off).
  const fineR = opts.fine === 0 || coarseR <= 1 ? 0 : 1;
  const affines = [];
  const gains = []; // per-frame multiplier that brings each frame to the first frame's exposure
  const info = [];
  let prevSmall = null, k = 1;
  let prevAff = [1, 0, 0, 0, 1, 0];
  const warnings = new Set();
  const stats = {};

  for (let i = 0; i < N; i++) {
    progress({ phase: 1, frame: i, total: N, text: `${i + 1}/${N} 枚目を読み込み中` });
    await yieldTick();
    const dec = await decodeDNG(await frames[i].load(), decodeOpts);
    (dec.meta.warnings || []).forEach((w) => warnings.add(w));
    if (i === 0) {
      if (opts.onFirstFrame) opts.onFirstFrame(dec);
      W = dec.width; H = dec.height; refMeta = dec.meta;
      g = W * H > 6e6 ? 2 : 1;
      gw = Math.floor(W / g); gh = Math.floor(H / g);
      best = new Float32Array(gw * gh); idx = new Uint8Array(gw * gh);
      if (fineR) {
        bestF = new Float32Array(gw * gh); idxF = new Uint8Array(gw * gh);
        meanF = new Uint16Array(gw * gh); meanC = new Uint16Array(gw * gh); efC = new Float32Array(gw * gh);
      }
      k = Math.max(1, Math.ceil(Math.max(W, H) / 720));
    } else if (dec.width !== W || dec.height !== H) {
      throw new Error(`${frames[i].name} の画像サイズ(${dec.width}×${dec.height})が1枚目(${W}×${H})と異なります`);
    }
    progress({ phase: 1, frame: i, total: N, text: `${i + 1}/${N} 枚目を位置合わせ中` });
    await yieldTick();
    const small = downscaleLuma(dec.data, W, H, k);
    let aff = [1, 0, 0, 0, 1, 0], rel = [1, 0, 0, 0, 1, 0];
    if (i > 0 && opts.align !== false) {
      const p = alignPair(prevSmall, small, { noRotation: opts.noRotation });
      const r = paramsToAffine(p, k, W, H, small.w, small.h);
      const ri = affineInfo(r, W, H);
      if (Math.abs(ri.scale - 1) > 0.12 || Math.abs(ri.dx) > W * 0.2 || Math.abs(ri.dy) > H * 0.2 || Math.abs(ri.rot) > 8) {
        warnings.add(`${frames[i].name} の位置合わせに失敗したため、補正せずに合成しました`);
        aff = prevAff;
      } else {
        aff = affineCompose(r, prevAff); rel = r;
      }
    }
    let gain = 1;
    if (i > 0 && opts.matchExposure !== false) {
      const ratio = Math.min(4, Math.max(0.25, exposureRatio(prevSmall, small, rel, k)));
      gain = gains[i - 1] / ratio;
      if (Math.abs(Math.log2(gain)) < 0.01) gain = 1; // under ~1% is noise, not an exposure change
    }
    gains.push(gain);
    prevSmall = small; prevAff = aff;
    affines.push(aff);
    info.push({ name: frames[i].name, ...affineInfo(aff, W, H), ev: Math.log2(gain) });

    progress({ phase: 1, frame: i, total: N, text: `${i + 1}/${N} 枚目のピントを解析中` });
    await yieldTick();
    const fe = focusEnergy(dec.data, W, H, g);
    if (gain !== 1) { // as if measured on the exposure-matched frame (energy ∝ gain, sqrt-luma mean ∝ √gain)
      const sg = Math.sqrt(gain);
      for (let j = 0; j < fe.E.length; j++) { fe.E[j] *= gain; fe.M[j] *= sg; }
    }
    const isIdentity = aff[0] === 1 && aff[1] === 0 && aff[2] === 0 && aff[3] === 0 && aff[4] === 1 && aff[5] === 0;
    const toRef = (Eb) => isIdentity ? Eb : warpGrid(Eb, fe.gw, fe.gh, g, aff, gw, gh);
    const Ec = toRef(boxBlur(fe.E, fe.gw, fe.gh, coarseR, 2));
    if (fineR) {
      const Mf = toRef(boxBlur(fe.M, fe.gw, fe.gh, fineR, 2)), Ef = toRef(boxBlur(fe.E, fe.gw, fe.gh, fineR, 2));
      updateBest(Ec, best, idx, i, Mf, meanC, Ef, efC);
      updateBest(Ef, bestF, idxF, i, Mf, meanF);
    } else updateBest(Ec, best, idx, i);
  }

  // Depth map clean-up: low-confidence cells take the (energy-weighted) depth of their neighbourhood.
  progress({ phase: 2, frame: 0, total: N, text: '深度マップを整えています' });
  await yieldTick();
  const sorted = Float32Array.from(best).sort();
  const tau = Math.max(1e-12, sorted[Math.floor(sorted.length * 0.1)] * 4);
  const num = new Float32Array(gw * gh), den = new Float32Array(gw * gh);
  for (let j = 0; j < gw * gh; j++) { num[j] = idx[j] * best[j]; den[j] = best[j]; }
  const fillR = Math.max(4, Math.round(Math.max(gw, gh) / 40));
  const nb = boxBlur(num, gw, gh, fillR, 2), db = boxBlur(den, gw, gh, fillR, 2);
  for (let j = 0; j < gw * gh; j++) {
    if (best[j] < tau && db[j] > 0) idx[j] = Math.min(N - 1, Math.max(0, Math.round(nb[j] / db[j])));
  }
  // In fine textures (moss, grass, twigs) the broad window is ruled by the strongest edge nearby, so the
  // background between blades gets the blade's frame and comes out blurred. The 1-cell window sees the
  // background's own detail; it overrides the broad pick where it found real texture, unless the two
  // frames differ in local brightness there. That difference is the glow of an out-of-focus edge
  // (a halo), not detail, so those cells and a few around them keep the broad pick.
  const coarseIdx = median3u8(idx, gw, gh);
  if (fineR) {
    const sortedF = Float32Array.from(bestF).sort();
    const tauF = Math.max(1e-12, sortedF[Math.floor(sortedF.length * 0.1)] * 1.2);
    const ok = new Uint8Array(gw * gh), halo = new Float32Array(gw * gh);
    for (let j = 0; j < gw * gh; j++) {
      if (bestF[j] <= tauF || idxF[j] === idx[j]) continue;
      if (Math.abs(meanF[j] - meanC[j]) < 0.05 * (meanC[j] + 3277) || bestF[j] > 30 * efC[j]) ok[j] = 1; else halo[j] = 1;
    }
    const near = boxBlur(halo, gw, gh, 4, 1);
    let nf = 0;
    for (let j = 0; j < gw * gh; j++) if (ok[j] && !(near[j] > 1e-6)) { idx[j] = idxF[j]; nf++; }
    stats.fine = nf / (gw * gh);
  }
  idx = median3u8(idx, gw, gh);

  // Common area covered by every frame (in reference coords), intersected with the default crop.
  let x0 = refMeta.crop.x, y0 = refMeta.crop.y, x1 = refMeta.crop.x + refMeta.crop.w, y1 = refMeta.crop.y + refMeta.crop.h;
  for (const m of affines) {
    const inv = affineInvert(m);
    const P = (x, y) => [inv[0] * x + inv[1] * y + inv[2], inv[3] * x + inv[4] * y + inv[5]];
    const tl = P(0, 0), tr = P(W - 1, 0), bl = P(0, H - 1), br = P(W - 1, H - 1);
    x0 = Math.max(x0, Math.ceil(Math.max(tl[0], bl[0])));
    x1 = Math.min(x1, Math.floor(Math.min(tr[0], br[0])) + 1);
    y0 = Math.max(y0, Math.ceil(Math.max(tl[1], tr[1])));
    y1 = Math.min(y1, Math.floor(Math.min(bl[1], br[1])) + 1);
  }
  x0 += x0 & 1; y0 += y0 & 1;
  const CW = Math.max(2, (x1 - x0) & ~1), CH = Math.max(2, (y1 - y0) & ~1);

  // Pass 2: blend.
  const share = new Float64Array(N);
  for (let j = 0; j < gw * gh; j++) share[idx[j]]++;
  const out = new Uint16Array(CW * CH * 3);
  const smoothR = Math.max(0, Math.round(opts.smooth ?? 2));
  // Where the fine window took over densely (grass, moss), seams blend over 1 cell so a sharp blade is
  // not averaged with the blurred frames around it; elsewhere the full blend radius hides the seams.
  const tightR = Math.min(smoothR, 1);
  let calm = null;
  if (fineR && smoothR > tightR) {
    const took = new Float32Array(gw * gh);
    for (let j = 0; j < gw * gh; j++) took[j] = idx[j] !== coarseIdx[j] ? 1 : 0;
    const dens = boxBlur(took, gw, gh, smoothR * 2, 2);
    calm = new Float32Array(gw * gh);
    let sumCalm = 0;
    for (let j = 0; j < gw * gh; j++) { calm[j] = Math.min(1, Math.max(0, 1.5 - dens[j] / 0.15)); sumCalm += calm[j]; }
    stats.busy = 1 - sumCalm / (gw * gh);
  }
  const used = [];
  for (let i = 0; i < N; i++) if (share[i] > 0) used.push(i);
  for (let ui = 0; ui < used.length; ui++) {
    const i = used[ui];
    progress({ phase: 2, frame: ui, total: used.length, text: `合成中 ${ui + 1}/${used.length}（${frames[i].name}）` });
    await yieldTick();
    const ind = new Float32Array(gw * gh);
    for (let j = 0; j < gw * gh; j++) ind[j] = idx[j] === i ? 1 : 0;
    const wgt = smoothR ? boxBlur(ind, gw, gh, smoothR, 2) : ind;
    if (calm) {
      const tight = tightR ? boxBlur(ind, gw, gh, tightR, 2) : ind;
      for (let j = 0; j < gw * gh; j++) wgt[j] = tight[j] + (wgt[j] - tight[j]) * calm[j];
    }
    // Dilate a 1-cell mask of where this frame contributes, to skip pixels quickly.
    const dec = await decodeDNG(await frames[i].load(), decodeOpts);
    compositeFrame(out, CW, CH, x0, y0, dec.data, W, H, affines[i], wgt, gw, gh, g, gains[i]);
  }
  const total = gw * gh;
  info.forEach((f, i) => { f.share = share[i] / total; });
  return {
    width: CW, height: CH, data: out, meta: refMeta,
    depth: { data: idx, w: gw, h: gh, g, x0, y0 },
    frames: info, warnings: [...warnings], stats, seconds: (Date.now() - t0) / 1000,
  };
}
