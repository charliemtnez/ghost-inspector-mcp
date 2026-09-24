/** A test's run history, and failures across the account grouped by when they began. */

import { isModule, request, type RunResult, type TestRecord } from "./client.js";
import { pool, REQUEST_CONCURRENCY } from "./graph.js";
import { scopeFor, scopeNote, type ScopeFilter } from "./scope.js";

/** The API's own ceiling on `count` per page. */
const PAGE = 50;
const MAX_RUNS = 500;
const ERROR_CAP = 160;

export interface HistoryRun {
  resultId: string;
  finishedAt: string | null;
  /** Null while the run is in flight. */
  passing: boolean | null;
  failingStep: { index: number; command: string; error: string; resolvedTarget: string | null } | null;
}

export interface History {
  runs: HistoryRun[];
  lastPass: HistoryRun | null;
  /** The oldest failure of the current red streak, or null when the latest finished run passed. */
  firstFail: HistoryRun | null;
  /** True when the streak reaches the oldest run read and more history exists. */
  streakMayContinue: boolean;
  horizon: { walked: number; oldestSeen: string | null; exhausted: boolean };
  notes: string[];
}

/**
 * Summarizes results, newest first, into the last pass, the start of the current red streak and the horizon.
 *
 * @param results Results as the API lists them, newest first.
 * @param exhausted Whether the walk reached the end of what Ghost Inspector retains.
 * @return The summary, and what it cannot see.
 */
export function summarizeHistory(results: RunResult[], exhausted: boolean): History {
  const runs = results.map(toRun);
  const lastPass = runs.find((entry) => entry.passing === true) ?? null;
  const latest = runs.findIndex((entry) => entry.passing !== null);
  let firstFail: HistoryRun | null = null;
  let streakEnd = -1;
  if (latest >= 0 && runs[latest]?.passing === false) {
    streakEnd = latest;
    while (streakEnd + 1 < runs.length && runs[streakEnd + 1]?.passing !== true) streakEnd += 1;
    for (let i = streakEnd; i >= latest; i -= 1) {
      if (runs[i]?.passing === false) {
        firstFail = runs[i] ?? null;
        break;
      }
    }
  }
  const streakMayContinue = firstFail !== null && streakEnd === runs.length - 1 && !exhausted;
  const oldestSeen = runs[runs.length - 1]?.finishedAt ?? null;

  const notes = [
    exhausted
      ? `Walked ${runs.length} run(s) back to ${oldestSeen ?? "nothing"}: retention ends here, so nothing older can be seen.`
      : `Walked ${runs.length} run(s) back to ${oldestSeen}: there is more history; raise runs to see it.`,
  ];
  if (streakMayContinue) {
    notes.push("🔴 The test was red in every run read, so the streak may have begun earlier than firstFail. Raise runs.");
  }
  return { runs, lastPass, firstFail, streakMayContinue, horizon: { walked: runs.length, oldestSeen, exhausted }, notes };
}

/**
 * One result as a history entry.
 *
 * @param result A result record.
 * @return Its id, time, verdict and failing step.
 */
function toRun(result: RunResult): HistoryRun {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const index = steps.findIndex((step) => step["passing"] === false);
  const failing = steps[index];
  return {
    resultId: String(result._id ?? ""),
    finishedAt: result["dateExecutionFinished"] === undefined ? null : String(result["dateExecutionFinished"]),
    passing: result.passing === true || result.passing === false ? result.passing : null,
    failingStep: failing
      ? {
          index,
          command: String(failing["command"] ?? ""),
          error: String(failing["error"] ?? "").slice(0, ERROR_CAP),
          resolvedTarget: typeof failing["target"] === "string" ? failing["target"] : null,
        }
      : null,
  };
}

/**
 * Pages back through a test's results, 50 at a time, newest first.
 *
 * @param testId The test.
 * @param runs How many results to collect at most.
 * @return The results and whether retention ran out before `runs`.
 */
async function walkResults(testId: string, runs: number): Promise<{ results: RunResult[]; exhausted: boolean }> {
  const results: RunResult[] = [];
  for (let offset = 0; offset < runs; offset += PAGE) {
    const count = Math.min(PAGE, runs - offset);
    const page = await request<RunResult[]>("GET", `tests/${testId}/results`, { params: { count, offset } });
    const list = Array.isArray(page) ? page : [];
    results.push(...list);
    if (list.length < count) return { results, exhausted: true };
  }
  return { results, exhausted: false };
}

/**
 * A test's history: every run's verdict and failing step, when it last passed and when the current red began.
 *
 * @param options The test, and how many runs to walk (default 50, at most 500).
 * @return The summary; a module is refused, having no results at all.
 * @throws {GhostInspectorError} on an API failure.
 */
export async function testHistory(options: { testId: string; runs?: number | undefined }): Promise<History> {
  const test = await request<TestRecord>("GET", `tests/${options.testId}`);
  if (isModule(test)) {
    return {
      runs: [],
      lastPass: null,
      firstFail: null,
      streakMayContinue: false,
      horizon: { walked: 0, oldestSeen: null, exhausted: true },
      notes: [
        "This test is import-only, so it has no results: marking a test import-only deletes them. Ask about one of the tests that imports it; gi_module_usage lists them.",
      ],
    };
  }
  const runs = Math.min(MAX_RUNS, Math.max(1, options.runs ?? PAGE));
  const { results, exhausted } = await walkResults(options.testId, runs);
  return summarizeHistory(results, exhausted);
}
