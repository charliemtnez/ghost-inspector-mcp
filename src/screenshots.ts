/** Screenshot comparison: its state per test, and accepting a new baseline behind a token. */

import { request, type RunResult, type TestRecord } from "./client.js";

export interface ScreenshotStatus {
  test: { id: string; name: string; enabled: boolean | null; passing: boolean | null; threshold: number | null };
  latestResult: {
    id: string;
    finishedAt: string | null;
    inFlight: boolean;
    enabled: boolean | null;
    passing: boolean | null;
    difference: number | null;
    threshold: number | null;
    baselineResultId: string | null;
    screenshotUrl: string | null;
    diffUrl: string | null;
  } | null;
  baseline: { resultId: string; finishedAt: string | null; screenshotUrl: string | null } | null;
  notes: string[];
}

export interface AcceptResult {
  applied: boolean;
  refusedBecause?: string;
  /** The baseline this replaced. The API has no route to restore it. */
  previousBaselineResult: string | null;
  verification: { screenshotComparePassing: unknown; dateUpdatedBefore: string; dateUpdatedAfter: string } | null;
  notes: string[];
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
  if (latest["screenshotComparePassing"] === true) {
    return "nothing to accept: the latest comparison passed, so its screenshot already matches the baseline";
  }
  return null;
}

/**
 * The comparison state of a test and its latest result, with the three images to look at.
 *
 * @param test The test record.
 * @param latest Its latest result, or null.
 * @param baseline The baseline result, or null.
 * @return The status and what to do next.
 */
export function describeScreenshots(
  test: TestRecord,
  latest: RunResult | null,
  baseline: RunResult | null,
): ScreenshotStatus {
  const baselineId = latest ? text(latest["screenshotCompareBaselineResult"]) : null;
  const notes = [
    "Look at screenshotUrl, diffUrl and baseline.screenshotUrl before accepting. gi_accept_screenshot takes this latestResult.id as expectedResultId and refuses if a newer run has landed since.",
  ];
  if (latest && latest["screenshotCompareEnabled"] !== true) {
    notes.push("Screenshot comparison did not run on the latest result, so there is nothing to accept.");
  } else if (latest && latest["screenshotComparePassing"] === true) {
    notes.push("The latest comparison passed, so there is nothing to accept.");
  }
  return {
    test: {
      id: String(test._id ?? ""),
      name: String(test.name ?? ""),
      enabled: bool(test["screenshotCompareEnabled"]),
      passing: bool(test["screenshotComparePassing"]),
      threshold: num(test["screenshotCompareThreshold"]),
    },
    latestResult: latest
      ? {
          id: String(latest._id ?? ""),
          finishedAt: text(latest["dateExecutionFinished"]),
          inFlight: latest.passing !== true && latest.passing !== false,
          enabled: bool(latest["screenshotCompareEnabled"]),
          passing: bool(latest["screenshotComparePassing"]),
          difference: num(latest["screenshotCompareDifference"]),
          threshold: num(latest["screenshotCompareThreshold"]),
          baselineResultId: baselineId,
          screenshotUrl: imageUrl(latest["screenshot"], "original"),
          diffUrl: imageUrl(latest["screenshotCompare"], "compareOriginal"),
        }
      : null,
    baseline: baseline
      ? {
          resultId: String(baseline._id ?? ""),
          finishedAt: text(baseline["dateExecutionFinished"]),
          screenshotUrl: imageUrl(baseline["screenshot"], "original"),
        }
      : null,
    notes,
  };
}

/**
 * Reads a test's screenshot comparison: the test's settings, its latest result and that result's baseline.
 *
 * @param testId The test.
 * @return The status, with the URLs of the current, diff and baseline images.
 * @throws {GhostInspectorError} on an API failure.
 */
export async function screenshotStatus(testId: string): Promise<ScreenshotStatus> {
  const test = await request<TestRecord>("GET", `tests/${testId}`);
  const latest = await latestResult(testId);
  const baselineId = latest ? text(latest["screenshotCompareBaselineResult"]) : null;
  const baseline = baselineId ? await request<RunResult>("GET", `results/${baselineId}`) : null;
  return describeScreenshots(test, latest, baseline);
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
  const latest = await latestResult(options.testId);
  const previousBaselineResult = latest ? text(latest["screenshotCompareBaselineResult"]) : null;
  const refusal = acceptRefusal(latest, options.expectedResultId);
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
  const after = await request<TestRecord>("GET", `tests/${options.testId}`);
  const passing = after["screenshotComparePassing"];
  const notes = [
    `🔴 The previous baseline was result ${previousBaselineResult ?? "(none recorded)"}. The API offers no way to restore an earlier baseline, so keep that id if this was a mistake.`,
    passing === true
      ? "Verified: the test now reads screenshotComparePassing true."
      : `🔴 The accept returned but the test reads screenshotComparePassing ${JSON.stringify(passing)}. Check it in the web UI.`,
  ];
  return {
    applied: true,
    previousBaselineResult,
    verification: {
      screenshotComparePassing: passing,
      dateUpdatedBefore: String(before.dateUpdated ?? ""),
      dateUpdatedAfter: String(after.dateUpdated ?? ""),
    },
    notes,
  };
}

/**
 * A test's newest result.
 *
 * @param testId The test.
 * @return The result, or null when the test has none.
 */
async function latestResult(testId: string): Promise<RunResult | null> {
  const results = await request<RunResult[]>("GET", `tests/${testId}/results`, { params: { count: 1 } });
  return Array.isArray(results) && results[0] ? results[0] : null;
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
