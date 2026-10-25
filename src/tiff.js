// ---- TIFF / DNG container: reader and writer ----

const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

const TAG = {
  NewSubFileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  Photometric: 262, Make: 271, Model: 272, StripOffsets: 273, Orientation: 274, SamplesPerPixel: 277,
  RowsPerStrip: 278, StripByteCounts: 279, PlanarConfig: 284, Software: 305, DateTime: 306,
  Predictor: 317, TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325,
  SubIFDs: 330, SampleFormat: 339, JPEGTables: 347,
  CFARepeatPatternDim: 33421, CFAPattern: 33422, ExifIFD: 34665,
  DNGVersion: 50706, DNGBackwardVersion: 50707, UniqueCameraModel: 50708, CFAPlaneColor: 50710,
  CFALayout: 50711, LinearizationTable: 50712, BlackLevelRepeatDim: 50713, BlackLevel: 50714,
  BlackLevelDeltaH: 50715, BlackLevelDeltaV: 50716, WhiteLevel: 50717, DefaultScale: 50718,
  DefaultCropOrigin: 50719, DefaultCropSize: 50720, ColorMatrix1: 50721, ColorMatrix2: 50722,
  CameraCalibration1: 50723, CameraCalibration2: 50724, AnalogBalance: 50727, AsShotNeutral: 50728,
  AsShotWhiteXY: 50729, BaselineExposure: 50730, BaselineNoise: 50731, BaselineSharpness: 50732,
  LinearResponseLimit: 50734, CalibrationIlluminant1: 50778, CalibrationIlluminant2: 50779,
  ActiveArea: 50829, ForwardMatrix1: 50964, ForwardMatrix2: 50965,
  OpcodeList1: 51008, OpcodeList2: 51009, OpcodeList3: 51022,
};

class TiffReader {
  constructor(buffer) {
    this.buf = buffer;
    this.dv = new DataView(buffer);
    const bo = this.dv.getUint16(0, false);
    if (bo === 0x4949) this.le = true;
    else if (bo === 0x4d4d) this.le = false;
    else throw new Error('TIFF/DNG形式のファイルではありません');
    const magic = this.dv.getUint16(2, this.le);
    if (magic !== 42) throw new Error('TIFF/DNG形式のファイルではありません (magic ' + magic + ')');
    this.ifds = [];
    const seen = new Set();
    let off = this.dv.getUint32(4, this.le);
    let guard = 0;
    while (off && off < buffer.byteLength && !seen.has(off) && guard++ < 64) {
      seen.add(off);
      const ifd = this.readIFD(off, 0, seen);
      this.ifds.push(ifd);
      off = ifd.next;
    }
  }

  readIFD(off, depth, seen) {
    const dv = this.dv, le = this.le;
    const n = dv.getUint16(off, le);
    const entries = new Map();
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      if (p + 12 > this.buf.byteLength) break;
      const tag = dv.getUint16(p, le);
      const type = dv.getUint16(p + 2, le);
      const count = dv.getUint32(p + 4, le);
      const size = (TIFF_TYPE_SIZE[type] || 1) * count;
      const valOff = size <= 4 ? p + 8 : dv.getUint32(p + 8, le);
      entries.set(tag, { tag, type, count, off: valOff });
    }
    const ifd = { off, entries, sub: [], next: 0 };
    const nextPos = off + 2 + n * 12;
    ifd.next = nextPos + 4 <= this.buf.byteLength ? dv.getUint32(nextPos, le) : 0;
    if (depth < 3 && entries.has(TAG.SubIFDs)) {
      for (const so of this.values(ifd, TAG.SubIFDs)) {
        if (so && so < this.buf.byteLength && !seen.has(so)) {
          seen.add(so);
          ifd.sub.push(this.readIFD(so, depth + 1, seen));
        }
      }
    }
    return ifd;
  }

  has(ifd, tag) { return ifd.entries.has(tag); }

  // Returns an array of numbers (rationals as floats), or a string for ASCII.
  values(ifd, tag) {
    const e = ifd.entries.get(tag);
    if (!e) return null;
    const dv = this.dv, le = this.le;
    const out = [];
    let p = e.off;
    if (p + (TIFF_TYPE_SIZE[e.type] || 1) * e.count > this.buf.byteLength) return null;
    switch (e.type) {
      case 1: case 7: for (let i = 0; i < e.count; i++) out.push(dv.getUint8(p + i)); break;
      case 6: for (let i = 0; i < e.count; i++) out.push(dv.getInt8(p + i)); break;
      case 2: {
        let s = '';
        for (let i = 0; i < e.count; i++) { const c = dv.getUint8(p + i); if (!c) break; s += String.fromCharCode(c); }
        return s.trim();
      }
      case 3: for (let i = 0; i < e.count; i++) out.push(dv.getUint16(p + i * 2, le)); break;
      case 8: for (let i = 0; i < e.count; i++) out.push(dv.getInt16(p + i * 2, le)); break;
      case 4: case 13: for (let i = 0; i < e.count; i++) out.push(dv.getUint32(p + i * 4, le)); break;
      case 9: for (let i = 0; i < e.count; i++) out.push(dv.getInt32(p + i * 4, le)); break;
      case 5: for (let i = 0; i < e.count; i++) { const d = dv.getUint32(p + i * 8 + 4, le); out.push(d ? dv.getUint32(p + i * 8, le) / d : 0); } break;
      case 10: for (let i = 0; i < e.count; i++) { const d = dv.getInt32(p + i * 8 + 4, le); out.push(d ? dv.getInt32(p + i * 8, le) / d : 0); } break;
      case 11: for (let i = 0; i < e.count; i++) out.push(dv.getFloat32(p + i * 4, le)); break;
      case 12: for (let i = 0; i < e.count; i++) out.push(dv.getFloat64(p + i * 8, le)); break;
      case 16: for (let i = 0; i < e.count; i++) out.push(Number(dv.getBigUint64(p + i * 8, le))); break;
      default: return null;
    }
    return out;
  }

  value(ifd, tag, def) {
    const v = this.values(ifd, tag);
    if (v == null) return def;
    return typeof v === 'string' ? v : v[0];
  }

  bytes(ifd, tag) {
    const e = ifd.entries.get(tag);
    if (!e) return null;
    const size = (TIFF_TYPE_SIZE[e.type] || 1) * e.count;
    return new Uint8Array(this.buf, e.off, size);
  }

  allIFDs() {
    const out = [];
    const walk = (ifd) => { out.push(ifd); ifd.sub.forEach(walk); };
    this.ifds.forEach(walk);
    return out;
  }
}

// Minimal little-endian TIFF writer. `entries` is an array of
// {tag, type, values} where values is an array of numbers, a string (ASCII),
// or for rationals an array of numbers (converted with a fixed denominator).
// Image data is supplied as one or more strips (Uint8Array).
function writeTiff(entries, strips) {
  const RAT_DEN = 1000000;
  const list = entries.slice().sort((a, b) => a.tag - b.tag);
  const n = list.length + 2; // + StripOffsets / StripByteCounts handled below
  // Encode values.
  const enc = list.map((e) => {
    let bytes;
    if (e.type === 2) {
      const s = e.values + '\0';
      bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); bytes[i] = c < 128 ? c : 63; }
      return { tag: e.tag, type: 2, count: s.length, bytes };
    }
    const vals = e.values;
    const sz = TIFF_TYPE_SIZE[e.type];
    bytes = new Uint8Array(sz * vals.length);
    const dv = new DataView(bytes.buffer);
    vals.forEach((v, i) => {
      switch (e.type) {
        case 1: case 7: dv.setUint8(i, v); break;
        case 3: dv.setUint16(i * 2, v, true); break;
        case 8: dv.setInt16(i * 2, v, true); break;
        case 4: dv.setUint32(i * 4, v, true); break;
        case 9: dv.setInt32(i * 4, v, true); break;
        case 5: {
          let num = v, den = RAT_DEN;
          if (num * den > 4294967295) { den = Math.max(1, Math.floor(4294967295 / Math.max(num, 1))); }
          dv.setUint32(i * 8, Math.round(num * den), true); dv.setUint32(i * 8 + 4, den, true); break;
        }
        case 10: {
          let den = RAT_DEN;
          if (Math.abs(v) * den > 2147483647) den = Math.max(1, Math.floor(2147483647 / Math.max(Math.abs(v), 1)));
          dv.setInt32(i * 8, Math.round(v * den), true); dv.setInt32(i * 8 + 4, den, true); break;
        }
        case 11: dv.setFloat32(i * 4, v, true); break;
        case 12: dv.setFloat64(i * 8, v, true); break;
      }
    });
    return { tag: e.tag, type: e.type, count: vals.length, bytes };
  });
  const stripCount = strips.length;
  enc.push({ tag: TAG.StripOffsets, type: 4, count: stripCount, bytes: null, isOffsets: true });
  enc.push({ tag: TAG.StripByteCounts, type: 4, count: stripCount, bytes: new Uint8Array(new Uint32Array(strips.map((s) => s.length)).buffer) });
  enc.sort((a, b) => a.tag - b.tag);

  const ifdOff = 8;
  const ifdSize = 2 + n * 12 + 4;
  let extra = ifdOff + ifdSize;
  const extraBlocks = [];
  for (const e of enc) {
    const size = e.isOffsets ? 4 * stripCount : e.bytes.length;
    e.size = size;
    if (size > 4) {
      if (extra & 1) extra++;
      e.valOff = extra;
      extra += size;
      extraBlocks.push(e);
    }
  }
  let dataOff = (extra + 15) & ~15;
  const stripOffs = [];
  let total = dataOff;
  for (const s of strips) { stripOffs.push(total); total += s.length; total = (total + 1) & ~1; }
  const offBytes = new Uint8Array(new Uint32Array(stripOffs).buffer);
  enc.find((e) => e.isOffsets).bytes = offBytes;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0x4949, false);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, n, true);
  enc.forEach((e, i) => {
    const p = ifdOff + 2 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    if (e.size > 4) { dv.setUint32(p + 8, e.valOff, true); out.set(e.bytes, e.valOff); }
    else out.set(e.bytes, p + 8);
  });
  dv.setUint32(ifdOff + 2 + n * 12, 0, true);
  strips.forEach((s, i) => out.set(s, stripOffs[i]));
  return out;
}
