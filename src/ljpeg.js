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
