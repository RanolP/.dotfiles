import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';

export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.allocUnsafe(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function predictor(filter, left, up, upLeft, file) {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return Math.floor((left + up) / 2);
    case 4: return paeth(left, up, upLeft);
    default: throw new Error(`Unsupported PNG scanline filter ${filter} in ${file}; re-export the image with a valid PNG filter (0–4)`);
  }
}

export async function decodePng(file) {
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`Not a PNG file: ${file}`);
  let offset = 8, width, height, bitDepth, colorType, interlace;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8, end = start + length;
    if (end + 4 > bytes.length) throw new Error(`Truncated PNG chunk ${type}: ${file}`);
    const data = bytes.subarray(start, end);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
    offset = end + 4;
  }
  if (![2, 6].includes(colorType) || bitDepth !== 8) {
    throw new Error(`Unsupported PNG color type ${colorType}, bit depth ${bitDepth}; only 8-bit RGB (type 2) and RGBA (type 6) are supported`);
  }
  if (interlace !== 0) throw new Error(`Unsupported interlaced PNG (${file}); only non-interlaced PNG is supported`);
  if (!width || !height || compressed.length === 0) throw new Error(`PNG is missing dimensions or image data: ${file}`);
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const packed = zlib.inflateSync(Buffer.concat(compressed));
  if (packed.length < height * (rowBytes + 1)) throw new Error(`PNG image data is truncated: ${file}`);
  const pixels = new Uint8Array(width * height * channels);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[input++];
    const row = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = packed[input++];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[row - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[row - rowBytes + x - channels] : 0;
      pixels[row + x] = (raw + predictor(filter, left, up, upLeft, file)) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

export function encodePng(width, height, channels, pixels) {
  if (![3, 4].includes(channels) || pixels.length !== width * height * channels) throw new TypeError('PNG encoder expects RGB or RGBA pixels');
  const rowBytes = width * channels;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * rowBytes, rowBytes).copy(raw, y * (rowBytes + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([pngSignature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
