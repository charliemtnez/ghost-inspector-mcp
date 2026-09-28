/** The smallest PNG codec that reads Ghost Inspector's screenshots and writes crops of them. */

// Written here, not imported: an image library would be the largest dependency for a job that is
// zlib plus five scanline filters. Anything but 8-bit non-interlaced is refused, not decoded wrongly.

import { deflateSync, inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row after row. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel for each supported colour type at 8 bits: greyscale, RGB, grey+alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes a PNG into RGBA.
 *
 * @param png The file's bytes.
 * @return The image.
 * @throws {Error} when the file is not a PNG, or uses a bit depth, palette or interlacing this codec does not read.
 */
export function decodePng(png: Uint8Array): Image {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");

  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colourType = body[9] ?? -1;
      if (depth !== 8 || !(colourType in CHANNELS) || body[12] !== 0) {
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colourType}, interlace ${body[12]}`);
      }
      channels = CHANNELS[colourType] ?? 0;
    } else if (type === "IDAT") {
      compressed.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || !channels) throw new Error("PNG has no image header");

  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[line + x] ?? 0;
      const left = x >= channels ? (pixels[out + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[out - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[out - stride + x - channels] ?? 0) : 0;
      pixels[out + x] = (value + predict(filter, left, up, upLeft)) & 0xff;
    }
  }
  return { width, height, data: toRgba(pixels, width * height, channels) };
}

/**
 * Encodes RGBA as a PNG.
 *
 * @param image The image.
 * @return The file's bytes.
 */
export function encodePng(image: Image): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The value a scanline filter predicts for one byte.
 *
 * @param filter The filter type, 0 to 4.
 * @param left The byte one pixel to the left.
 * @param up The byte one row up.
 * @param upLeft The byte up and to the left.
 * @return The prediction to add back.
 * @throws {Error} on an unknown filter type, which means the file is corrupt.
 */
function predict(filter: number | undefined, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) return left;
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      throw new Error(`corrupt PNG: unknown filter type ${filter}`);
  }
}

/**
 * Widens decoded pixels to RGBA.
 *
 * @param pixels The unfiltered pixels.
 * @param count How many pixels.
 * @param channels Bytes per pixel in `pixels`.
 * @return RGBA pixels.
 */
function toRgba(pixels: Uint8Array, count: number, channels: number): Uint8Array {
  if (channels === 4) return pixels;
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const grey = channels <= 2;
    const r = pixels[i * channels] ?? 0;
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = grey ? r : (pixels[i * channels + 1] ?? 0);
    rgba[i * 4 + 2] = grey ? r : (pixels[i * channels + 2] ?? 0);
    rgba[i * 4 + 3] = channels === 2 ? (pixels[i * channels + 1] ?? 255) : 255;
  }
  return rgba;
}

/**
 * One PNG chunk: length, type, body and CRC.
 *
 * @param type The four-letter chunk type.
 * @param body The chunk data.
 * @return The encoded chunk.
 */
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

let crcTable: Uint32Array | null = null;

/**
 * The CRC-32 PNG chunks carry. `zlib.crc32` only exists from Node 22, and this server supports 18.
 *
 * @param bytes The chunk type and body.
 * @return The checksum.
 */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
