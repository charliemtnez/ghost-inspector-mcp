/** Where two screenshots differ, as horizontal bands, and crops of those bands to look at. */

import type { Image } from "./png.js";

export interface ChangedRegion {
  /** First and last changed row, in the full-size screenshot's pixels. */
  top: number;
  bottom: number;
  /** Leftmost and rightmost changed column. */
  left: number;
  right: number;
  /** Changed pixels inside the band, and their share of the whole page. */
  changedPixels: number;
  shareOfPage: number;
}

export interface RegionReport {
  baseline: { width: number; height: number };
  current: { width: number; height: number };
  /** Changed pixels over the overlapping area. Not Ghost Inspector's own metric, which it does not publish. */
  changedShare: number;
  /** Largest first. */
  regions: ChangedRegion[];
  /** Regions left out past `maxRegions`. */
  omitted: number;
  notes: string[];
}

export interface RegionOptions {
  /** Summed RGB difference below which a pixel counts as unchanged, absorbing anti-aliasing. */
  tolerance?: number;
  /** Unchanged rows allowed inside one band before it is split in two. */
  mergeGap?: number;
  maxRegions?: number;
}

const DEFAULT_TOLERANCE = 48;
const DEFAULT_MERGE_GAP = 24;
const DEFAULT_MAX_REGIONS = 8;

/**
 * The bands where two screenshots differ, compared pixel by pixel over the area they share.
 *
 * @param baseline The image the run was compared against.
 * @param current The run's own image.
 * @param options Tolerance, band merging and how many to return.
 * @return The bands, largest first, with notes on anything the comparison cannot see.
 */
export function changedRegions(baseline: Image, current: Image, options: RegionOptions = {}): RegionReport {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const mergeGap = options.mergeGap ?? DEFAULT_MERGE_GAP;
  const maxRegions = options.maxRegions ?? DEFAULT_MAX_REGIONS;
  const width = Math.min(baseline.width, current.width);
  const height = Math.min(baseline.height, current.height);

  const bands: ChangedRegion[] = [];
  let open: ChangedRegion | null = null;
  let lastChangedRow = -Infinity;
  let total = 0;
  for (let y = 0; y < height; y++) {
    let rowCount = 0;
    let rowLeft = width;
    let rowRight = -1;
    for (let x = 0; x < width; x++) {
      const a = (y * baseline.width + x) * 4;
      const b = (y * current.width + x) * 4;
      const delta =
        Math.abs((baseline.data[a] ?? 0) - (current.data[b] ?? 0)) +
        Math.abs((baseline.data[a + 1] ?? 0) - (current.data[b + 1] ?? 0)) +
        Math.abs((baseline.data[a + 2] ?? 0) - (current.data[b + 2] ?? 0));
      if (delta > tolerance) {
        rowCount++;
        if (x < rowLeft) rowLeft = x;
        rowRight = x;
      }
    }
    if (rowCount === 0) continue;
    total += rowCount;
    if (!open || y - lastChangedRow > mergeGap) {
      open = { top: y, bottom: y, left: rowLeft, right: rowRight, changedPixels: 0, shareOfPage: 0 };
      bands.push(open);
    }
    open.bottom = y;
    open.left = Math.min(open.left, rowLeft);
    open.right = Math.max(open.right, rowRight);
    open.changedPixels += rowCount;
    lastChangedRow = y;
  }

  const area = width * height || 1;
  for (const band of bands) band.shareOfPage = round(band.changedPixels / area);
  const ranked = [...bands].sort((p, q) => q.changedPixels - p.changedPixels);
  const notes: string[] = [];
  if (baseline.height !== current.height || baseline.width !== current.width) {
    notes.push(
      `The page changed size: ${baseline.width}×${baseline.height} then, ${current.width}×${current.height} now. Only the shared ${width}×${height} was compared, and content that moved down reads as changed everywhere below the move.`,
    );
  }
  const tall = ranked.find((band) => band.bottom - band.top > height / 2);
  if (tall && tall.changedPixels / ((tall.bottom - tall.top + 1) * width) < 0.9) {
    notes.push(
      `One band spans rows ${tall.top}–${tall.bottom}, over half the page. That usually means content shifted vertically rather than changed: look at where it starts.`,
    );
  }
  if (bands.length === 0) notes.push("No pixel differs beyond the tolerance over the shared area.");
  return {
    baseline: { width: baseline.width, height: baseline.height },
    current: { width: current.width, height: current.height },
    changedShare: round(total / area),
    regions: ranked.slice(0, maxRegions),
    omitted: Math.max(0, ranked.length - maxRegions),
    notes,
  };
}

/**
 * One region cut from both images and stacked, baseline above current, with a red rule between them.
 *
 * @param baseline The image the run was compared against.
 * @param current The run's own image.
 * @param region The band to show.
 * @param maxHeight Tallest slice taken from each image; a taller band is cut from its top.
 * @param padding Unchanged rows kept above and below the band for context.
 * @return The stacked crop, and the rows it covers.
 */
export function cropPair(
  baseline: Image,
  current: Image,
  region: ChangedRegion,
  maxHeight = 400,
  padding = 16,
): { image: Image; top: number; bottom: number } {
  const width = Math.max(baseline.width, current.width);
  const top = Math.max(0, region.top - padding);
  const bottom = Math.min(Math.max(baseline.height, current.height) - 1, top + maxHeight - 1, region.bottom + padding);
  const slice = bottom - top + 1;
  const rule = 4;
  const data = new Uint8Array(width * (slice * 2 + rule) * 4).fill(255);
  copyRows(baseline, top, slice, data, width, 0);
  for (let y = slice; y < slice + rule; y++) {
    for (let x = 0; x < width; x++) data.set([220, 38, 38, 255], (y * width + x) * 4);
  }
  copyRows(current, top, slice, data, width, slice + rule);
  return { image: { width, height: slice * 2 + rule, data }, top, bottom };
}

/**
 * Copies rows of an image into a wider canvas, leaving white where the source is shorter or narrower.
 *
 * @param source The image to copy from.
 * @param from Its first row.
 * @param count How many rows.
 * @param target The canvas.
 * @param targetWidth The canvas width.
 * @param at The canvas row to start at.
 */
function copyRows(source: Image, from: number, count: number, target: Uint8Array, targetWidth: number, at: number): void {
  for (let row = 0; row < count && from + row < source.height; row++) {
    const start = (from + row) * source.width * 4;
    target.set(source.data.subarray(start, start + source.width * 4), (at + row) * targetWidth * 4);
  }
}

/**
 * A share rounded for display.
 *
 * @param value A fraction.
 * @return It, to four decimals.
 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
