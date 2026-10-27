// ---- Lossless JPEG (ITU T.81 process 14, "LJ92") decoder used by DNG compression 7 ----
// Returns { width, height, comps, bits, data: Uint16Array (row-major, interleaved) }.

function decodeLJ92(bytes) {
  const len = bytes.length;
  let pos = 0;
  const u16 = (p) => (bytes[p] << 8) | bytes[p + 1];
  if (u16(0) !== 0xffd8) throw new Error('ロスレスJPEGの開始マーカーがありません');
  pos = 2;
  const huff = [];
  let frame = null, restart = 0;
  while (pos < len) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    const marker = bytes[pos + 1];
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { if (marker === 0xff) pos--; continue; }
    if (marker === 0xd9) break;
    const segLen = u16(pos);
    const seg = pos + 2;
    if (marker === 0xc3) {
      frame = { bits: bytes[seg], height: u16(seg + 1), width: u16(seg + 3), comps: bytes[seg + 5], comp: [] };
      for (let i = 0; i < frame.comps; i++) frame.comp.push({ id: bytes[seg + 6 + i * 3], hs: bytes[seg + 7 + i * 3] >> 4, vs: bytes[seg + 7 + i * 3] & 15 });
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      throw new Error('ロスレスではないJPEGタイルです (SOF' + (marker - 0xc0) + ')');
    } else if (marker === 0xc4) {
      let p = seg;
      const end = pos + segLen;
      while (p < end) {
        const tc = bytes[p++];
        const counts = bytes.subarray(p, p + 16); p += 16;
        let total = 0; for (let i = 0; i < 16; i++) total += counts[i];
        const symbols = bytes.subarray(p, p + total); p += total;
        huff[tc & 15] = buildHuff(counts, symbols);
      }
    } else if (marker === 0xdd) {
      restart = u16(seg);
    } else if (marker === 0xda) {
      if (!frame) throw new Error('SOF3がありません');
      const ns = bytes[seg];
      const tables = [];
      for (let i = 0; i < ns; i++) tables.push(huff[bytes[seg + 2 + i * 2] >> 4]);
      const pred = bytes[seg + 1 + ns * 2];
      const pt = bytes[seg + 3 + ns * 2] & 15;
      pos += segLen;
      return decodeScan(bytes, pos, frame, tables, pred, pt, restart);
    }
    pos += segLen;
  }
  throw new Error('ロスレスJPEGのスキャンが見つかりません');
}

function buildHuff(counts, symbols) {
  // Lookup table on 16-bit code prefixes: lut[code16] = (len << 8) | symbol
  const lut = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < counts[l - 1]; i++) {
      const sym = symbols[k++];
      const shift = 16 - l;
      const start = code << shift, end = (code + 1) << shift;
      const v = (l << 8) | sym;
      for (let c = start; c < end; c++) lut[c] = v;
      code++;
    }
    code <<= 1;
  }
  return lut;
}

function decodeScan(bytes, start, frame, tables, pred, pt, restart) {
  const W = frame.width, H = frame.height, C = frame.comps;
  const out = new Uint16Array(W * H * C);
  const len = bytes.length;
  let pos = start;
  let bitbuf = 0, bitcnt = 0;
  const fill = () => {
    while (bitcnt <= 24) {
      let b = 0;
      if (pos < len) {
        b = bytes[pos];
        if (b === 0xff) {
          const nb = bytes[pos + 1];
          if (nb === 0x00) { pos += 2; }
          else { b = 0; } // marker: feed zeros, do not advance
        } else pos++;
      }
      bitbuf = ((bitbuf << 8) | b) >>> 0;
      bitcnt += 8;
    }
  };
  const resetBits = () => {
    bitbuf = 0; bitcnt = 0;
    // skip to RSTn marker
    while (pos < len - 1 && !(bytes[pos] === 0xff && bytes[pos + 1] >= 0xd0 && bytes[pos + 1] <= 0xd7)) pos++;
    pos += 2;
  };
  const initPred = 1 << (frame.bits - pt - 1);
  const rowLen = W * C;
  const mask = 0xffff;
  let mcuCount = 0;
  let firstLine = true;
  let lineStart = 0; // set when restart interval begins: next line is treated as first line
  for (let y = 0; y < H; y++) {
    const ro = y * rowLen;
    for (let x = 0; x < W; x++) {
      if (restart && mcuCount && mcuCount % restart === 0 && x === 0) {
        resetBits();
        firstLine = true;
      }
      for (let c = 0; c < C; c++) {
        // Decode one difference.
        if (bitcnt < 16) fill();
        const lut = tables[c];
        const v = lut[(bitbuf >>> (bitcnt - 16)) & 0xffff];
        const l = v >> 8;
        if (!l) throw new Error('ハフマン符号が不正です');
        bitcnt -= l;
        const ssss = v & 0xff;
        let diff = 0;
        if (ssss === 16) diff = -32768;
        else if (ssss) {
          if (bitcnt < ssss) fill();
          let bits = (bitbuf >>> (bitcnt - ssss)) & ((1 << ssss) - 1);
          bitcnt -= ssss;
          diff = bits < (1 << (ssss - 1)) ? bits - (1 << ssss) + 1 : bits;
        }
        // Predict.
        const i = ro + x * C + c;
        let p;
        if (firstLine) {
          p = x === 0 ? initPred : out[i - C];
        } else if (x === 0) {
          p = out[i - rowLen];
        } else {
          const ra = out[i - C], rb = out[i - rowLen], rc = out[i - rowLen - C];
          switch (pred) {
            case 1: p = ra; break;
            case 2: p = rb; break;
            case 3: p = rc; break;
            case 4: p = ra + rb - rc; break;
            case 5: p = ra + ((rb - rc) >> 1); break;
            case 6: p = rb + ((ra - rc) >> 1); break;
            case 7: p = (ra + rb) >> 1; break;
            default: p = ra;
          }
        }
        out[i] = (p + diff) & mask;
      }
      mcuCount++;
    }
    firstLine = false;
  }
  if (pt) for (let i = 0; i < out.length; i++) out[i] <<= pt;
  return { width: W, height: H, comps: C, bits: frame.bits, data: out };
}

// ---- Lossless JPEG encoder (predictor 1, one optimised Huffman table shared by all components) ----
// samples: Uint16Array, row-major interleaved, w x h x comps. Returns Uint8Array (SOI..EOI).
function encodeLJ92(samples, w, h, comps, bits) {
  const rowLen = w * comps;
  const n = w * h * comps;
  const ssss = new Uint8Array(n);
  const diffs = new Int32Array(n);
  const freq = new Uint32Array(17);
  const init = 1 << (bits - 1);
  for (let y = 0; y < h; y++) {
    const ro = y * rowLen;
    for (let x = 0; x < rowLen; x++) {
      const i = ro + x;
      const p = y === 0 ? (x < comps ? init : samples[i - comps]) : (x < comps ? samples[i - rowLen] : samples[i - comps]);
      let d = (samples[i] - p) & 0xffff;
      if (d >= 32768) d -= 65536;
      let s;
      if (d === -32768) s = 16;
      else { let a = d < 0 ? -d : d; s = 0; while (a) { s++; a >>= 1; } }
      ssss[i] = s; diffs[i] = d; freq[s]++;
    }
  }
  const { counts, symbols, codes, lens } = buildHuffmanTable(freq);
  // Header
  const head = [];
  const put16 = (v) => head.push((v >> 8) & 255, v & 255);
  put16(0xffd8);
  put16(0xffc3); put16(8 + 3 * comps); head.push(bits); put16(h); put16(w); head.push(comps);
  for (let c = 0; c < comps; c++) head.push(c + 1, 0x11, 0);
  put16(0xffc4); put16(2 + 1 + 16 + symbols.length); head.push(0); for (let i = 0; i < 16; i++) head.push(counts[i]); head.push(...symbols);
  put16(0xffda); put16(6 + 2 * comps); head.push(comps); for (let c = 0; c < comps; c++) head.push(c + 1, 0); head.push(1, 0, 0);
  // Entropy-coded data (worst case ~ 32 bits per sample + stuffing)
  let out = new Uint8Array(head.length + Math.ceil(n * 2.2) + 1024);
  out.set(head);
  let pos = head.length;
  let acc = 0, cnt = 0;
  const ensure = () => { if (pos + 16 > out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } };
  const emit = (v, l) => {
    // l <= 16; keep acc below 32 bits
    acc = (acc << l) | (v & ((1 << l) - 1));
    cnt += l;
    while (cnt >= 8) {
      cnt -= 8;
      const b = (acc >>> cnt) & 255;
      out[pos++] = b;
      if (b === 0xff) out[pos++] = 0;
    }
    acc &= (1 << cnt) - 1;
  };
  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0) ensure();
    if (pos + 16 > out.length) ensure();
    const s = ssss[i];
    emit(codes[s], lens[s]);
    if (s && s < 16) { const d = diffs[i]; emit(d < 0 ? d + (1 << s) - 1 : d, s); }
  }
  if (cnt) emit(0x7f, 8 - cnt);
  ensure();
  out[pos++] = 0xff; out[pos++] = 0xd9;
  return out.subarray(0, pos);
}

// JPEG Annex K.2: code lengths from frequencies, limited to 16 bits; returns canonical codes.
function buildHuffmanTable(freqIn) {
  const freq = new Float64Array(257);
  for (let i = 0; i < 17; i++) freq[i] = freqIn[i];
  freq[256] = 1; // reserved so no code is all ones
  const codesize = new Int32Array(257), others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1, c2 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
    v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;
    freq[c1] += freq[c2]; freq[c2] = 0;
    codesize[c1]++; while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++; while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }
  const bitsArr = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bitsArr[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bitsArr[i] > 0) {
      let j = i - 2; while (bitsArr[j] === 0) j--;
      bitsArr[i] -= 2; bitsArr[i - 1]++; bitsArr[j + 1] += 2; bitsArr[j]--;
    }
  }
  let i = 16; while (bitsArr[i] === 0) i--;
  bitsArr[i]--; // remove reserved symbol
  const counts = new Uint8Array(16);
  for (let k = 1; k <= 16; k++) counts[k - 1] = bitsArr[k];
  // Symbols sorted by code size (then value), excluding the reserved 256.
  const symbols = [];
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 17; s++) if (codesize[s] === len) symbols.push(s);
  // Assign canonical codes following `counts` order.
  const codes = new Uint16Array(17), lens = new Uint8Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let c = 0; c < counts[len - 1]; c++) { const s = symbols[k++]; codes[s] = code++; lens[s] = len; }
    code <<= 1;
  }
  return { counts, symbols: symbols.slice(0, k), codes, lens };
}
