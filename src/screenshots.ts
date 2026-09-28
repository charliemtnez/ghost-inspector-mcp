/** Screenshot comparison: its state per test, where two screenshots differ, and accepting a new baseline behind a token. */

import { request, suiteIdOf, type RunResult, type SuiteRecord, type TestRecord } from "./client.js";
import { changedRegions, cropPair, type RegionReport } from "./image-diff.js";
import { decodePng, encodePng } from "./png.js";

export interface ResultImage {
  resultId: string;
  finishedAt: string | null;
  screenshotUrl: string | null;
}

export interface ScreenshotStatus {
  test: {
    id: string;
    name: string;
    /** Whether comparison runs, after inheritance: the test's own `null` means "whatever the suite says". */
    enabled: boolean | null;
    /** The threshold comparisons are held to, after inheritance. */
    threshold: number | null;
    /** Where `enabled` and `threshold` came from. */
    settingsFrom: "test" | "suite" | "unknown";
    passing: boolean | null;
  };
  latestResult: {
    id: string;
    finishedAt: string | null;
    inFlight: boolean;
    enabled: boolean | null;
    passing: boolean | null;
    difference: number | null;
    threshold: number | null;
    /** Passing although the difference is above the threshold: someone accepted this screenshot. */
    acceptedManually: boolean;
    screenshotUrl: string | null;
    diffUrl: string | null;
  } | null;
  /** The image the latest result was compared with, which is not necessarily the baseline. */
  comparedAgainst: ResultImage | null;
  /** The baseline: the image a new run is compared with. */
  currentBaseline: (ResultImage & { isLatestResult: boolean }) | null;
  notes: string[];
}

export interface AcceptResult {
  applied: boolean;
  refusedBecause?: string;
  /** The baseline this replaced. The API has no route to restore it. */
  previousBaselineResult: string | null;
  verification: {
    screenshotComparePassing: unknown;
    acceptedResultComparePassing: unknown;
    currentBaselineResult: string | null;
    dateUpdatedBefore: string;
    dateUpdatedAfter: string;
  } | null;
  notes: string[];
}

export interface ScreenshotDiff {
  resultId: string;
  against: { resultId: string; which: "comparedAgainst" | "currentBaseline" };
  report: RegionReport;
  /** PNG crops of the largest regions, baseline above current; the handler turns them into images. */
  crops: Array<{ top: number; bottom: number; png: Buffer }>;
}

const RESULTS_SCANNED = 20;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/**
 * Whether a result's screenshot was accepted by hand: its comparison reads passing with a difference above its threshold.
 *
 * @param result A run result.
 * @return True only when both numbers are present and say so.
 */
export function acceptedManually(result: RunResult): boolean {
  const difference = result["screenshotCompareDifference"];
  const threshold = result["screenshotCompareThreshold"];
  return (
    result["screenshotComparePassing"] === true &&
    typeof difference === "number" &&
    typeof threshold === "number" &&
    difference > threshold
  );
}

/**
 * The baseline: the newest compared result that passed (accepting flips one to passing), else what the newest was compared with.
 *
 * @param results Newest first.
 * @return The baseline's result id, whether it came from the window, and whether it passed functionally.
 */
export function currentBaselineId(
  results: RunResult[],
): { id: string; inWindow: boolean; functionallyFailed: boolean } | null {
  const compared = results.filter((result) => result["screenshotCompareEnabled"] === true);
  const passed = compared.find((result) => result["screenshotComparePassing"] === true && isSettled(result));
  if (passed) return { id: String(passed._id), inWindow: true, functionallyFailed: passed.passing === false };
  const newest = compared.find(isSettled);
  const reference = newest ? text(newest["screenshotCompareBaselineResult"]) : null;
  return reference ? { id: reference, inWindow: false, functionallyFailed: false } : null;
}

/**
 * The comparison settings in force: a test's `null` inherits the suite's, threshold included, and the latest result's threshold wins.
 *
 * @param test The test record.
 * @param suite Its suite, or null when it could not be read.
 * @param latest The latest result, whose threshold is what was actually applied.
 * @return Enabled, threshold and where they came from.
 */
export function effectiveSettings(
  test: TestRecord,
  suite: Record<string, unknown> | null,
  latest: RunResult | null,
): { enabled: boolean | null; threshold: number | null; settingsFrom: "test" | "suite" | "unknown" } {
  const own = bool(test["screenshotCompareEnabled"]);
  const settingsFrom = own !== null ? "test" : suite ? "suite" : "unknown";
  const enabled = own ?? (suite ? bool(suite["screenshotCompareEnabled"]) : null);
  const configured = settingsFrom === "test" ? num(test["screenshotCompareThreshold"]) : suite ? num(suite["screenshotCompareThreshold"]) : null;
  const applied = latest && latest["screenshotCompareEnabled"] === true ? num(latest["screenshotCompareThreshold"]) : null;
  return { enabled, threshold: applied ?? configured, settingsFrom };
}

/**
 * Why accepting the latest screenshot must be refused, or null when it may go ahead.
 *
 * @param latest The test's latest result, or null when it has none.
 * @param expectedResultId The result whose screenshot the caller looked at.
 * @return The refusal reason, or null.
 */
export function acceptRefusal(latest: RunResult | null, expectedResultId: string): string | null {
  if (!latest) return "the test has no results, so there is no screenshot to accept";
  if (String(latest._id) !== expectedResultId) {
    return `the latest result is ${String(latest._id)}, not ${expectedResultId}: accepting now would bless a screenshot you have not looked at`;
  }
  if (latest.passing !== true && latest.passing !== false) return "the latest run is still running, so its screenshot is not final";
  if (latest["screenshotCompareEnabled"] !== true) return "screenshot comparison did not run on the latest result";
  if (acceptedManually(latest)) {
    return "already accepted: this result reads passing above its threshold, which is what accepting does, so it is already the baseline";
  }
  if (latest["screenshotComparePassing"] === true) {
    return "nothing to accept: the latest comparison passed, so its screenshot already matches the baseline";
  }
  return null;
}

/**
 * The comparison state of a test: its settings, its latest result, what that was compared against, and the baseline now.
 *
 * @param test The test record.
 * @param suite Its suite, or null.
 * @param results Its recent results, newest first.
 * @param comparedAgainst The result the latest was compared against, or null.
 * @param baseline The current baseline result, or null.
 * @return The status and what to do next.
 */
export function describeScreenshots(
  test: TestRecord,
  suite: Record<string, unknown> | null,
  results: RunResult[],
  comparedAgainst: RunResult | null,
  baseline: RunResult | null,
): ScreenshotStatus {
  const latest = results[0] ?? null;
  const settings = effectiveSettings(test, suite, latest);
  const reference = currentBaselineId(results);
  const notes = [
    "Before accepting, look at the images: gi_screenshot_diff returns where they differ and crops of each change. gi_accept_screenshot takes latestResult.id as expectedResultId and refuses if a newer run has landed since.",
  ];
  const storedThreshold = num(test["screenshotCompareThreshold"]);
  if (settings.settingsFrom === "suite" && storedThreshold !== null && storedThreshold !== settings.threshold) {
    notes.push(
      `The test inherits comparison from its suite, so the threshold in force is ${settings.threshold}; the ${storedThreshold} stored on the test is not applied.`,
    );
  }
  if (latest && latest["screenshotCompareEnabled"] !== true) {
    notes.push("Screenshot comparison did not run on the latest result, so there is nothing to accept.");
  } else if (latest && acceptedManually(latest)) {
    notes.push(
      `The latest result was accepted by hand: it differs by ${num(latest["screenshotCompareDifference"])} against a threshold of ${num(latest["screenshotCompareThreshold"])} and reads passing because accepting flips it. It is the baseline now; comparedAgainst is the older image it was measured against, kept for the record.`,
    );
  } else if (latest && latest["screenshotComparePassing"] === true) {
    notes.push("The latest comparison passed, so there is nothing to accept, and the latest screenshot is the baseline now.");
  }
  if (reference && !reference.inWindow) {
    notes.push(`No comparison passed in the last ${results.length} results, so the baseline is still the image the newest one was compared against.`);
  }
  if (reference?.functionallyFailed) {
    notes.push("⚠️ The baseline shown is a run that failed functionally. Whether Ghost Inspector uses such a run as the baseline is not verified.");
  }
  return {
    test: {
      id: String(test._id ?? ""),
      name: String(test.name ?? ""),
      enabled: settings.enabled,
      threshold: settings.threshold,
      settingsFrom: settings.settingsFrom,
      passing: bool(test["screenshotComparePassing"]),
    },
    latestResult: latest
      ? {
          id: String(latest._id ?? ""),
          finishedAt: text(latest["dateExecutionFinished"]),
          inFlight: !isSettled(latest),
          enabled: bool(latest["screenshotCompareEnabled"]),
          passing: bool(latest["screenshotComparePassing"]),
          difference: num(latest["screenshotCompareDifference"]),
          threshold: num(latest["screenshotCompareThreshold"]),
          acceptedManually: acceptedManually(latest),
          screenshotUrl: imageUrl(latest["screenshot"], "original"),
          diffUrl: imageUrl(latest["screenshotCompare"], "compareOriginal"),
        }
      : null,
    comparedAgainst: comparedAgainst ? toImage(comparedAgainst) : null,
    currentBaseline: baseline ? { ...toImage(baseline), isLatestResult: String(baseline._id) === String(latest?._id) } : null,
    notes,
  };
}

/**
 * Reads a test's screenshot comparison: its settings, its latest result, what that was compared against and the baseline now.
 *
 * @param testId The test.
 * @return The status, with the image URLs of each.
 * @throws {GhostInspectorError} on an API failure.
 */
export async function screenshotStatus(testId: string): Promise<ScreenshotStatus> {
  const test = await request<TestRecord>("GET", `tests/${testId}`);
  const [suite, results] = await Promise.all([suiteOf(test), recentResults(testId, RESULTS_SCANNED)]);
  const latest = results[0] ?? null;
  const comparedId = latest ? text(latest["screenshotCompareBaselineResult"]) : null;
  const baselineId = currentBaselineId(results)?.id ?? null;
  const [comparedAgainst, baseline] = await Promise.all([
    resultById(comparedId, results),
    resultById(baselineId, results),
  ]);
  return describeScreenshots(test, suite, results, comparedAgainst, baseline);
}

/**
 * Where a result's screenshot differs from a baseline, compared from the two originals, with crops of the largest changes.
 *
 * @param options The test, optionally a result (default the latest), which baseline, and how many crops.
 * @return The changed regions and PNG crops.
 * @throws {GhostInspectorError} on an API failure.
 * @throws {Error} when an image is missing, too large or not a readable PNG.
 */
export async function screenshotDiff(options: {
  testId: string;
  resultId?: string | undefined;
  against?: "comparedAgainst" | "currentBaseline" | undefined;
  crops?: number | undefined;
}): Promise<ScreenshotDiff> {
  const which = options.against ?? "comparedAgainst";
  const results = await recentResults(options.testId, RESULTS_SCANNED);
  const result = options.resultId
    ? (results.find((entry) => String(entry._id) === options.resultId) ?? (await request<RunResult>("GET", `results/${options.resultId}`)))
    : results[0];
  if (!result) throw new Error("The test has no results, so there is no screenshot to compare.");

  const baselineId = which === "currentBaseline" ? currentBaselineId(results)?.id : text(result["screenshotCompareBaselineResult"]);
  if (!baselineId) {
    throw new Error(
      which === "currentBaseline"
        ? "No baseline could be established from the recent results."
        : "That result was not compared against anything: screenshot comparison did not run on it.",
    );
  }
  if (baselineId === String(result._id)) {
    throw new Error(
      "That result is itself the current baseline, so it would be compared with itself. Use against: comparedAgainst to see what it changed.",
    );
  }
  const baseline = await resultById(baselineId, results);
  if (!baseline) throw new Error(`The baseline result ${baselineId} could not be read; it may have been purged.`);

  // Ghost Inspector's own diff image paints changes over the page, indistinguishable from red content.
  const [before, after] = await Promise.all([
    fetchImage(imageUrl(baseline["screenshot"], "original"), "baseline"),
    fetchImage(imageUrl(result["screenshot"], "original"), "result"),
  ]);
  const report = changedRegions(before, after);
  const crops = report.regions.slice(0, Math.max(0, options.crops ?? 3)).map((region) => {
    const pair = cropPair(before, after, region);
    return { top: pair.top, bottom: pair.bottom, png: encodePng(pair.image) };
  });
  if (crops.length > 0) {
    report.notes.push("Each crop shows the baseline above a red rule and this result below it, at full size.");
  }
  return { resultId: String(result._id), against: { resultId: baselineId, which }, report, crops };
}

/**
 * Accepts the latest result's screenshot as the new baseline, only if it is the one the caller looked at; does not move dateUpdated.
 *
 * @param options The test, and the result id whose screenshot was reviewed.
 * @return What changed, the baseline it replaced, and the re-read.
 * @throws {GhostInspectorError} on an API failure.
 */
export async function acceptScreenshot(options: { testId: string; expectedResultId: string }): Promise<AcceptResult> {
  const before = await request<TestRecord>("GET", `tests/${options.testId}`);
  const [latest] = await recentResults(options.testId, 1);
  const previousBaselineResult = latest ? text(latest["screenshotCompareBaselineResult"]) : null;
  const refusal = acceptRefusal(latest ?? null, options.expectedResultId);
  if (refusal) {
    return {
      applied: false,
      refusedBecause: refusal,
      previousBaselineResult,
      verification: null,
      notes: ["Nothing was changed. Read gi_screenshot_status again, look at the current images, and pass the result id it returns."],
    };
  }

  await request("POST", `tests/${options.testId}/accept-screenshot`);
  const [after, accepted, results] = await Promise.all([
    request<TestRecord>("GET", `tests/${options.testId}`),
    request<RunResult>("GET", `results/${options.expectedResultId}`),
    recentResults(options.testId, RESULTS_SCANNED),
  ]);
  const baseline = currentBaselineId(results)?.id ?? null;
  const landed = accepted["screenshotComparePassing"] === true && baseline === options.expectedResultId;
  const notes = [
    `🔴 The previous baseline was result ${previousBaselineResult ?? "(none recorded)"}. The API offers no way to restore an earlier baseline, so keep that id if this was a mistake.`,
    landed
      ? `Verified: result ${options.expectedResultId} now reads comparison passing and is the baseline the next run will be compared against. Its screenshotCompareBaselineResult still names the old image: that is what it was measured against, not the baseline.`
      : `🔴 The accept returned, but result ${options.expectedResultId} reads comparison passing ${JSON.stringify(accepted["screenshotComparePassing"])} and the baseline reads ${baseline ?? "(none)"}. Check it in the web UI.`,
  ];
  if (after["screenshotComparePassing"] !== true) {
    notes.push(`⚠️ The test record reads screenshotComparePassing ${JSON.stringify(after["screenshotComparePassing"])}.`);
  }
  return {
    applied: true,
    previousBaselineResult,
    verification: {
      screenshotComparePassing: after["screenshotComparePassing"],
      acceptedResultComparePassing: accepted["screenshotComparePassing"],
      currentBaselineResult: baseline,
      dateUpdatedBefore: String(before.dateUpdated ?? ""),
      dateUpdatedAfter: String(after.dateUpdated ?? ""),
    },
    notes,
  };
}

/**
 * A test's newest results.
 *
 * @param testId The test.
 * @param count How many, newest first.
 * @return The results, possibly none.
 */
async function recentResults(testId: string, count: number): Promise<RunResult[]> {
  const results = await request<RunResult[]>("GET", `tests/${testId}/results`, { params: { count } });
  return Array.isArray(results) ? results : [];
}

/**
 * A result, from the ones already fetched when it is among them.
 *
 * @param id The result id, or null.
 * @param known Results already in hand.
 * @return The result, or null when there is no id.
 */
async function resultById(id: string | null, known: RunResult[]): Promise<RunResult | null> {
  if (!id) return null;
  return known.find((result) => String(result._id) === id) ?? (await request<RunResult>("GET", `results/${id}`));
}

/**
 * The suite a test belongs to, or null when it cannot be read; the test's settings then stay unresolved rather than failing the read.
 *
 * @param test The test record, whose suite arrives expanded.
 * @return The suite record, or null.
 */
async function suiteOf(test: TestRecord): Promise<(SuiteRecord & Record<string, unknown>) | null> {
  const id = suiteIdOf(test);
  if (!id) return null;
  try {
    return await request<SuiteRecord & Record<string, unknown>>("GET", `suites/${id}`);
  } catch {
    return null;
  }
}

/**
 * Downloads and decodes one screenshot. Screenshot URLs are public storage links and carry no credential.
 *
 * @param url The image URL, or null.
 * @param label Which image, for the error.
 * @return The decoded image.
 * @throws {Error} when the URL is missing, the download fails or the file is too large.
 */
async function fetchImage(url: string | null, label: string): Promise<ReturnType<typeof decodePng>> {
  if (!url) throw new Error(`The ${label} has no screenshot; it may have been purged.`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The ${label} screenshot could not be downloaded (HTTP ${response.status}); it may have been purged.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`The ${label} screenshot is ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES} this server decodes.`);
  return decodePng(bytes);
}

/**
 * A result as an image reference.
 *
 * @param result The result.
 * @return Its id, finish time and screenshot URL.
 */
function toImage(result: RunResult): ResultImage {
  return {
    resultId: String(result._id ?? ""),
    finishedAt: text(result["dateExecutionFinished"]),
    screenshotUrl: imageUrl(result["screenshot"], "original"),
  };
}

/**
 * Whether a run has finished.
 *
 * @param result A run result.
 * @return True when `passing` is a boolean; null means still running.
 */
function isSettled(result: RunResult): boolean {
  return result.passing === true || result.passing === false;
}

/**
 * The default URL of one image size inside a screenshot field.
 *
 * @param field The result's screenshot or screenshotCompare field.
 * @param size The size key, such as original.
 * @return The URL, or null.
 */
function imageUrl(field: unknown, size: string): string | null {
  const entry = field && typeof field === "object" ? (field as Record<string, unknown>)[size] : null;
  const url = entry && typeof entry === "object" ? (entry as { defaultUrl?: unknown }).defaultUrl : null;
  return typeof url === "string" && url ? url : null;
}

/**
 * A value as a string, or null.
 *
 * @param value Anything.
 * @return The string, or null when empty or not a string.
 */
function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * A value as a boolean, or null.
 *
 * @param value Anything.
 * @return The boolean, or null.
 */
function bool(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

/**
 * A value as a number, or null.
 *
 * @param value Anything.
 * @return The number, or null.
 */
function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
