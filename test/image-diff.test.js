/** Locating where two screenshots differ, and cutting a crop of each change to look at. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { changedRegions, cropPair } from "../dist/image-diff.js";

/**
 * A solid-colour RGBA image.
 *
 * @param {number} width Pixels across.
 * @param {number} height Pixels down.
 * @param {number[]} colour RGB.
 * @return {{width: number, height: number, data: Uint8Array}} The image.
 */
function solid(width, height, colour = [255, 255, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...colour, 255], i * 4);
  return { width, height, data };
}

/**
 * A copy of an image with a rectangle painted over it.
 *
 * @param {{width: number, height: number, data: Uint8Array}} image The source.
 * @param {{top: number, bottom: number, left: number, right: number}} box Inclusive bounds.
 * @param {number[]} colour RGB.
 * @return {{width: number, height: number, data: Uint8Array}} The painted copy.
 */
function paint(image, box, colour = [0, 0, 0]) {
  const data = new Uint8Array(image.data);
  for (let y = box.top; y <= box.bottom; y++) {
    for (let x = box.left; x <= box.right; x++) data.set([...colour, 255], (y * image.width + x) * 4);
  }
  return { ...image, data };
}

/**
 * The RGBA of the first pixel in one row.
 *
 * @param {{width: number, data: Uint8Array}} image The image.
 * @param {number} row The row.
 * @return {number[]} Four bytes.
 */
function firstPixelOfRow(image, row) {
  return [...image.data.subarray(row * image.width * 4, row * image.width * 4 + 4)];
}

test("identical screenshots report no change at all", () => {
  const report = changedRegions(solid(40, 60), solid(40, 60));
  assert.deepEqual(report.regions, []);
  assert.equal(report.changedShare, 0);
  assert.ok(report.notes.some((n) => /No pixel differs/.test(n)));
});

test("a changed block is located to the exact rows and columns it covers", () => {
  const base = solid(50, 100);
  const report = changedRegions(base, paint(base, { top: 10, bottom: 19, left: 5, right: 14 }));
  assert.equal(report.regions.length, 1);
  assert.deepEqual(
    { ...report.regions[0], shareOfPage: undefined },
    { top: 10, bottom: 19, left: 5, right: 14, changedPixels: 100, shareOfPage: undefined },
  );
  assert.equal(report.changedShare, 0.02);
});

test("anti-aliasing noise under the tolerance is not reported as a change", () => {
  const base = solid(20, 20, [100, 100, 100]);
  assert.deepEqual(changedRegions(base, paint(base, { top: 0, bottom: 19, left: 0, right: 19 }, [115, 115, 115])).regions, []);
  assert.equal(changedRegions(base, paint(base, { top: 0, bottom: 19, left: 0, right: 19 }, [117, 117, 117])).regions.length, 1);
});

test("changes far apart stay separate and come back largest first; close ones merge", () => {
  const base = solid(40, 400);
  const small = { top: 10, bottom: 11, left: 0, right: 3 };
  const large = { top: 300, bottom: 319, left: 0, right: 39 };
  const apart = changedRegions(base, paint(paint(base, small), large));
  assert.deepEqual(apart.regions.map((r) => r.top), [300, 10], "the larger change leads, whatever its position");

  const near = changedRegions(base, paint(paint(base, small), { top: 30, bottom: 31, left: 0, right: 3 }));
  assert.equal(near.regions.length, 1, "a gap under mergeGap rows is one change, not two");
  assert.deepEqual([near.regions[0].top, near.regions[0].bottom], [10, 31]);
});

test("regions past maxRegions are counted, not silently dropped", () => {
  const base = solid(10, 1000);
  let changed = base;
  for (let i = 0; i < 5; i++) changed = paint(changed, { top: i * 100, bottom: i * 100 + 1, left: 0, right: 0 });
  const report = changedRegions(base, changed, { maxRegions: 2 });
  assert.equal(report.regions.length, 2);
  assert.equal(report.omitted, 3);
});

test("a page that changed height is compared over the shared area and says so", () => {
  const report = changedRegions(solid(30, 100), solid(30, 80));
  assert.deepEqual(report.current, { width: 30, height: 80 });
  assert.deepEqual(report.regions, [], "the rows both images share are identical");
  assert.ok(report.notes.some((n) => /changed size: 30×100 then, 30×80 now/.test(n)));
});

test("a sparse band over half the page is flagged as a likely shift; a page repainted wholesale is not", () => {
  const base = solid(20, 200);
  let sparse = base;
  for (let y = 0; y < 180; y += 10) sparse = paint(sparse, { top: y, bottom: y, left: 0, right: 19 });
  assert.ok(changedRegions(base, sparse).notes.some((n) => /shifted vertically/.test(n)));

  const repainted = changedRegions(base, solid(20, 200, [200, 0, 0]));
  assert.equal(repainted.changedShare, 1);
  assert.ok(!repainted.notes.some((n) => /shifted vertically/.test(n)), "a full repaint is a change, not a shift");
});

test("a crop stacks the baseline above a red rule and the current image below it", () => {
  const base = solid(10, 100, [255, 255, 255]);
  const current = solid(10, 100, [0, 0, 255]);
  const { image, top, bottom } = cropPair(base, current, { top: 40, bottom: 49, left: 0, right: 9, changedPixels: 100, shareOfPage: 0.1 }, 400, 5);
  assert.deepEqual([top, bottom], [35, 54], "the band plus its padding");
  const slice = bottom - top + 1;
  assert.equal(image.height, slice * 2 + 4);
  assert.deepEqual(firstPixelOfRow(image, 0), [255, 255, 255, 255], "baseline on top");
  assert.deepEqual(firstPixelOfRow(image, slice), [220, 38, 38, 255], "the rule between them");
  assert.deepEqual(firstPixelOfRow(image, slice + 4), [0, 0, 255, 255], "current below");
});

test("a crop of a very tall change is capped at maxHeight from its top", () => {
  const base = solid(4, 2000);
  const { top, bottom } = cropPair(base, base, { top: 100, bottom: 1900, left: 0, right: 3, changedPixels: 1, shareOfPage: 0 }, 300, 16);
  assert.equal(top, 84);
  assert.equal(bottom - top + 1, 300);
});
