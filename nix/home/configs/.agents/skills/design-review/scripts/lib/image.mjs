import { readFile } from 'node:fs/promises';
import { pngSignature } from './png.mjs';

const jpegSof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export async function readImageSize(file) {
  const data = await readFile(file);
  if (data.subarray(0, 8).equals(pngSignature)) {
    if (data.length < 24 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`Invalid PNG IHDR: ${file}`);
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), format: 'png' };
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error(`Unsupported image format (PNG or JPEG required): ${file}`);
  let offset = 2;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) continue;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (jpegSof.has(marker)) {
      return {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
        format: 'jpeg',
      };
    }
    offset += length;
  }
  throw new Error(`Could not read JPEG dimensions: ${file}`);
}
