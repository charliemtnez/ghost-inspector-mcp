/** The built-in PNG codec: every scanline filter and colour type a screenshot can use, and refusal of what it cannot read. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { decodePng, encodePng } from "../dist/png.js";

/**
 * The CRC-32 a PNG chunk carries, computed independently of the codec under test.
 *
 * @param {Buffer} bytes The chunk type and body.
 * @return {number} The checksum.
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One encoded PNG chunk.
 *
 * @param {string} type The four-letter chunk type.
 * @param {Buffer} body The chunk data.
 * @return {Buffer} Length, type, body and CRC.
 */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * The forward form of one scanline filter, so a test can store rows the way a real encoder would.
 *
 * @param {number} filter Filter type 0-4.
 * @param {Uint8Array} row The row's raw bytes.
 * @param {Uint8Array|null} prior The previous row's raw bytes.
 * @param {number} bpp Bytes per pixel.
 * @return {Uint8Array} The filtered bytes.
 */
function filterRow(filter, row, prior, bpp) {
  const out = new Uint8Array(row.length);
  for (let x = 0; x < row.length; x++) {
    const left = x >= bpp ? row[x - bpp] : 0;
    const up = prior ? prior[x] : 0;
    const upLeft = prior && x >= bpp ? prior[x - bpp] : 0;
    const estimate = left + up - upLeft;
    const paeth =
      Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
        ? left
        : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
          ? up
          : upLeft;
    const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
    out[x] = (row[x] - predicted) & 0xff;
  }
  return out;
}

/**
 * A PNG built by hand, one filter per row cycling through all five.
 *
 * @param {{width: number, height: number, colourType: number, bpp: number, pixels: Uint8Array, depth?: number, interlace?: number}} spec
 * @return {Buffer} The file.
 */
function buildPng({ width, height, colourType, bpp, pixels, depth = 8, interlace = 0 }) {
  const stride = width * bpp;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    rows.push(Buffer.from([filter]), Buffer.from(filterRow(filter, row, prior, bpp)));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, colourType, 0, 0, interlace], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Deterministic, varied pixel bytes, so every filter's predictor sees non-trivial neighbours.
 *
 * @param {number} length How many bytes.
 * @return {Uint8Array} The bytes.
 */
function noise(length) {
  const bytes = new Uint8Array(length);
  let seed = 7;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed >> 16;
  }
  return bytes;
}

test("an RGBA screenshot decodes to its exact pixels under every scanline filter", () => {
  const pixels = noise(7 * 10 * 4);
  const image = decodePng(buildPng({ width: 7, height: 10, colourType: 6, bpp: 4, pixels }));
  assert.equal(image.width, 7);
  assert.equal(image.height, 10);
  assert.deepEqual(image.data, pixels);
});

test("RGB, greyscale and grey-with-alpha widen to RGBA with the right channels", () => {
  const rgb = noise(5 * 5 * 3);
  const fromRgb = decodePng(buildPng({ width: 5, height: 5, colourType: 2, bpp: 3, pixels: rgb }));
  assert.deepEqual([...fromRgb.data.subarray(0, 8)], [rgb[0], rgb[1], rgb[2], 255, rgb[3], rgb[4], rgb[5], 255]);

  const grey = noise(5 * 5);
  const fromGrey = decodePng(buildPng({ width: 5, height: 5, colourType: 0, bpp: 1, pixels: grey }));
  assert.deepEqual([...fromGrey.data.subarray(0, 4)], [grey[0], grey[0], grey[0], 255]);

  const greyAlpha = noise(5 * 5 * 2);
  const fromGreyAlpha = decodePng(buildPng({ width: 5, height: 5, colourType: 4, bpp: 2, pixels: greyAlpha }));
  assert.deepEqual([...fromGreyAlpha.data.subarray(0, 4)], [greyAlpha[0], greyAlpha[0], greyAlpha[0], greyAlpha[1]]);
});

test("a crop written by the encoder reads back byte for byte", () => {
  const image = { width: 9, height: 4, data: noise(9 * 4 * 4) };
  const back = decodePng(encodePng(image));
  assert.equal(back.width, 9);
  assert.equal(back.height, 4);
  assert.deepEqual(back.data, image.data);
});

test("a PNG the codec cannot read is refused by name, never decoded into wrong pixels", () => {
  const pixels = noise(4 * 4 * 4);
  assert.throws(() => decodePng(buildPng({ width: 4, height: 4, colourType: 6, bpp: 4, pixels, interlace: 1 })), /unsupported PNG/);
  assert.throws(() => decodePng(buildPng({ width: 2, height: 4, colourType: 6, bpp: 8, pixels, depth: 16 })), /unsupported PNG/);
  assert.throws(() => decodePng(buildPng({ width: 4, height: 4, colourType: 3, bpp: 1, pixels: noise(16) })), /unsupported PNG/);
  assert.throws(() => decodePng(Buffer.from("GIF89a not a png at all")), /not a PNG/);
});

test("a truncated download is reported as truncated rather than padded with black", () => {
  const png = buildPng({ width: 4, height: 4, colourType: 6, bpp: 4, pixels: noise(64) });
  const header = png.subarray(0, 33);
  const shortRows = Buffer.concat([header, chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(shortRows), /truncated/);
});
