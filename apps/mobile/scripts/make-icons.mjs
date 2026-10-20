#!/usr/bin/env node
/**
 * Generate the PWA icons from docs/assets/logo.png without native image
 * dependencies (Android has no sharp/libvips): a tiny PNG decoder + box-filter
 * resampler + PNG encoder on top of node:zlib.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const appRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');
const repoRoot = path.resolve(appRoot, '../..');
const srcPng = path.join(repoRoot, 'docs/assets/logo.png');
const outDir = path.join(appRoot, 'renderer/public/icons');
mkdirSync(outDir, { recursive: true });

/* ── decode ── */
const buf = readFileSync(srcPng);
let offset = 8;
let width = 0;
let height = 0;
let colorType = 0;
let bitDepth = 8;
const idat = [];
while (offset < buf.length) {
  const length = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  const data = buf.subarray(offset + 8, offset + 8 + length);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
  } else if (type === 'IDAT') {
    idat.push(data);
  } else if (type === 'IEND') break;
  offset += 12 + length;
}
if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
  throw new Error(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}`);
}
const channels = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * channels;
const pixels = Buffer.alloc(width * height * 4);
const prev = Buffer.alloc(stride);
let pos = 0;
for (let y = 0; y < height; y += 1) {
  const filter = raw[pos];
  pos += 1;
  const line = Buffer.from(raw.subarray(pos, pos + stride));
  pos += stride;
  for (let x = 0; x < stride; x += 1) {
    const a = x >= channels ? line[x - channels] : 0;
    const b = prev[x];
    const c = x >= channels ? prev[x - channels] : 0;
    let value = line[x];
    if (filter === 1) value += a;
    else if (filter === 2) value += b;
    else if (filter === 3) value += Math.floor((a + b) / 2);
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    line[x] = value & 0xff;
  }
  line.copy(prev);
  for (let x = 0; x < width; x += 1) {
    const src = x * channels;
    const dst = (y * width + x) * 4;
    pixels[dst] = line[src];
    pixels[dst + 1] = line[src + 1];
    pixels[dst + 2] = line[src + 2];
    pixels[dst + 3] = channels === 4 ? line[src + 3] : 255;
  }
}

/* ── resize (box filter) ── */
function resize(src, sw, sh, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = sw / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * sw + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          count += 1;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

/* ── encode ── */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const scaled = resize(pixels, width, height, size);
  const png = encodePng(scaled, size);
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(path.join(outDir, name), png);
  console.log(`[icons] ${name} (${png.length} bytes)`);
}
