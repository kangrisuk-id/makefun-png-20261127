// PNG squeeze entry: a lossless PNG encoder that rewrites 1280x720 RGBA screenshots as small as it can.
//
// Pipeline per image: decode the stored PNG -> analyse (opaque? grey? distinct colours? one transparent
// key?) -> build candidate encodings (palette / grey / grey+alpha / RGB / RGBA, each with a filter choice)
// -> deflate each candidate with zlib level 9 and keep the smallest bytes. Deterministic: a fixed set of
// candidates, the smallest wins, the first on a tie. No clock, no environment, no network, no files outside
// /input, /output and the program itself. Node builtins only (fs, path, zlib).
//
// Format rules (the checker's decoder): bit depth 8, non-interlaced, colour type 0/2/3/4/6, chunks IHDR,
// PLTE (type 3 only), tRNS, IDAT, IEND only, correct CRCs, IDAT one zlib stream.

import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG to RGBA (the contest's format only). Returns {width, height, rgba} or throws. */
function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`bad CRC in ${type}`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType) || header.interlace !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error(`unexpected chunk ${type}`);
  }
  if (!ended || idat.length === 0 || header === null) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error(`bad filter ${ft}`);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i] * 3;
      rgba[d] = palette[e]; rgba[d + 1] = palette[e + 1]; rgba[d + 2] = palette[e + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { width, height, rgba };
}

/** What an RGBA image holds: opaque? grey? distinct colours (<=256, with counts)? one transparent key? */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  // One fully transparent value (grey or RGB) that no opaque pixel uses, every other pixel opaque.
  let tkey = null;
  if (!opaque) {
    let key = -1;
    let ok = true;
    for (let d = 0; d < rgba.length; d += 4) {
      const a = rgba[d + 3];
      if (a === 255) continue;
      if (a !== 0) { ok = false; break; }
      const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
      if (key === -1) key = v;
      else if (key !== v) { ok = false; break; }
    }
    if (ok && key !== -1) {
      for (let d = 0; d < rgba.length; d += 4) {
        if (rgba[d + 3] !== 255) continue;
        const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
        if (v === key) { ok = false; break; }
      }
      if (ok) tkey = key;
    }
  }
  const colours = many ? null : [...counts.entries()].map(([word, count]) => {
    const b = new Uint8Array(Uint32Array.of(word).buffer);
    return { r: b[0], g: b[1], b: b[2], a: b[3], word, count };
  });
  return { opaque, grey, colours, tkey };
}

/** Filter one row of `cur` (bpp bytes a pixel) by `type` into `out`. `prev` is the row above or null. */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128..127), absolute. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/**
 * Filter `samples` (height rows of width*bpp) with `choose`: a fixed type 0-4, or 'minsum' (each row the type
 * with the least signedSum, lower type on a tie). Returns the raw scanline data (filter byte + row, per row).
 */
function filterImage(samples, width, height, bpp, choose) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const dst = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (choose === 'minsum') {
      let best = Infinity;
      let type = 0;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        const s = signedSum(trial[t]);
        if (s < best) { best = s; type = t; }
      }
      dst.set(trial[type]);
      raw[y * (stride + 1)] = type;
    } else {
      filterRow(choose, cur, prev, bpp, dst);
      raw[y * (stride + 1)] = choose;
    }
  }
  return raw;
}

/** Deflate `raw` at level 9, keeping the smaller of the two settings that win on this data
 * (default strategy and Z_FILTERED, both memLevel 8). A third setting (memLevel 9) was measured:
 * it only ever won by 45 bytes on one image while costing ~8s across the set, so it is left out.
 * Deterministic: same input, same output. */
function deflate9(raw) {
  const a = deflateSync(raw, { level: 9, memLevel: 8, strategy: 0 });
  const b = deflateSync(raw, { level: 9, memLevel: 8, strategy: 1 });
  return a.length <= b.length ? a : b;
}

/** Assemble a PNG from a filtered scanline buffer. `extra` chunks go before IDAT (PLTE/tRNS). */
function assemble(width, height, colourType, raw, extra) {
  const chunks = [['IHDR', ihdrOf(width, height, colourType)]];
  for (const c of extra) chunks.push(c);
  chunks.push(['IDAT', new Uint8Array(deflate9(raw))]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/** Order palette colours: transparent entries first, then the rest by `key` (count desc, or luminance). */
function orderPalette(colours, byLuminance) {
  const trans = [];
  const opaq = [];
  for (const c of colours) (c.a < 255 ? trans : opaq).push(c);
  const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const cmp = byLuminance
    ? (a, b) => lum(a) - lum(b) || b.count - a.count
    : (a, b) => b.count - a.count || lum(a) - lum(b);
  trans.sort(cmp);
  opaq.sort(cmp);
  return trans.concat(opaq);
}

/** Build the samples (palette indices) for an ordered palette. Returns {samples, plte, trns}. */
function paletteSamples(rgba, ordered) {
  const n = rgba.length >>> 2;
  const index = new Map();
  const plte = new Uint8Array(ordered.length * 3);
  for (let e = 0; e < ordered.length; e++) {
    const c = ordered[e];
    index.set(c.word, e);
    plte[e * 3] = c.r; plte[e * 3 + 1] = c.g; plte[e * 3 + 2] = c.b;
  }
  // tRNS covers entries up to the last transparent one; transparent entries are first, so it is short.
  let lastTrans = -1;
  for (let e = 0; e < ordered.length; e++) if (ordered[e].a < 255) lastTrans = e;
  const trns = lastTrans < 0 ? null : Uint8Array.from(ordered.slice(0, lastTrans + 1), (c) => c.a);
  const samples = new Uint8Array(n);
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  for (let i = 0; i < n; i++) samples[i] = index.get(u32[i]);
  return { samples, plte, trns };
}

/** Encode one RGBA image; returns the smallest PNG bytes over the candidate encodings. */
function encodeImage(rgba, width, height) {
  const info = analyse(rgba);
  const n = width * height;
  const candidates = [];
  const add = (colourType, samples, bpp, extra, filterChoices) => {
    for (const fc of filterChoices) {
      const raw = filterImage(samples, width, height, bpp, fc);
      candidates.push({ colourType, raw, extra });
    }
  };

  if (info.colours !== null && !info.grey) {
    // Palette: at most 256 colours, not grey (grey is cheaper as type 0: no PLTE).
    for (const byLum of [false, true]) {
      const ordered = orderPalette(info.colours, byLum);
      const { samples, plte, trns } = paletteSamples(rgba, ordered);
      const extra = [['PLTE', plte]];
      if (trns !== null) extra.push(['tRNS', trns]);
      // Every filter choice: the best varies by image (unfiltered wins on flat/rich captures,
      // Paeth on alpha, Up on grey), and minsum is often not the smallest once deflated.
      add(3, samples, 1, extra, [0, 1, 2, 3, 4, 'minsum']);
    }
  } else if (info.grey) {
    const grey = new Uint8Array(n);
    const alpha = new Uint8Array(n);
    for (let i = 0, d = 0; i < n; i++, d += 4) { grey[i] = rgba[d]; alpha[i] = rgba[d + 3]; }
    if (info.opaque || info.tkey !== null) {
      const extra = [];
      if (info.tkey !== null) {
        const t = new Uint8Array(2);
        t[1] = info.tkey & 0xff;
        extra.push(['tRNS', t]);
      }
      add(0, grey, 1, extra, [0, 1, 2, 3, 4, 'minsum']);
    } else {
      const ga = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) { ga[i * 2] = grey[i]; ga[i * 2 + 1] = alpha[i]; }
      add(4, ga, 2, [], [0, 1, 2, 3, 4, 'minsum']);
    }
  } else if (info.opaque || info.tkey !== null) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgb[s] = rgba[d]; rgb[s + 1] = rgba[d + 1]; rgb[s + 2] = rgba[d + 2];
    }
    const extra = [];
    if (info.tkey !== null) {
      const t = new Uint8Array(6);
      t[1] = (info.tkey >> 16) & 0xff; t[3] = (info.tkey >> 8) & 0xff; t[5] = info.tkey & 0xff;
      extra.push(['tRNS', t]);
    }
    add(2, rgb, 3, extra, [0, 1, 2, 3, 4, 'minsum']);
  } else {
    add(6, rgba, 4, [], [0, 1, 2, 3, 4, 'minsum']);
  }

  let best = null;
  for (const c of candidates) {
    const png = assemble(width, height, c.colourType, c.raw, c.extra);
    if (best === null || png.length < best.length) best = png;
  }
  return best;
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const png = encodeImage(rgba, width, height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
}
