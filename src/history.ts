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

export interface Onset {
  id: string;
  name: string;
  suite: string;
  /** When the current red streak began: its oldest failure. */
  onset: string;
  error: string;
  target: string | null;
}

export interface FailureGroup {
  start: string;
  end: string;
  tests: Onset[];
  /** Errors with numbers and quoted text normalised, most common first. */
  commonErrors: Array<{ text: string; count: number }>;
  commonTargets: Array<{ text: string; count: number }>;
}

/**
 * Groups failure onsets that follow each other within a window, whatever suite or folder they sit in.
 *
 * @param onsets When each red test's current streak began.
 * @param windowHours The largest gap between consecutive onsets in one group.
 * @return Groups, largest first, each with its most common errors and targets.
 */
export function groupFailures(onsets: Onset[], windowHours: number): FailureGroup[] {
  const sorted = [...onsets].sort((a, b) => Date.parse(a.onset) - Date.parse(b.onset));
  const groups: Onset[][] = [];
  for (const entry of sorted) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (current && previous && Date.parse(entry.onset) - Date.parse(previous.onset) <= windowHours * 3_600_000) {
      current.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups
    .map((tests) => ({
      start: tests[0]?.onset ?? "",
      end: tests[tests.length - 1]?.onset ?? "",
      tests,
      commonErrors: tally(tests.map((t) => normalizeError(t.error))),
      commonTargets: tally(tests.map((t) => t.target ?? "").filter(Boolean)),
    }))
    .sort((a, b) => b.tests.length - a.tests.length || a.start.localeCompare(b.start));
}

/**
 * An error message with the parts that differ run to run replaced: quoted text by "…", numbers by N.
 *
 * @param error The error as recorded.
 * @return The normalised message.
 */
function normalizeError(error: string): string {
  return error.replace(/"[^"]*"|'[^']*'/g, "…").replace(/\d+/g, "N").trim();
}

/**
 * Counts values, most common first.
 *
 * @param values The values.
 * @return Each distinct value with its count.
 */
function tally(values: string[]): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

export interface FailureGroupsReport {
  scanned: { redTests: number; runsRead: number };
  groups: FailureGroup[];
  /** Red tests whose streak start could not be seen: no green run within the limit, or no readable history. */
  onsetUnknown: Array<{ id: string; name: string; suite: string; reason: string }>;
  notes: string[];
}

/**
 * Pages back until a passing run appears, retention ends or the limit is reached.
 *
 * @param testId The test.
 * @param max The most runs to read.
 * @return The results read and whether retention ran out.
 */
async function walkUntilGreen(testId: string, max: number): Promise<{ results: RunResult[]; exhausted: boolean }> {
  const results: RunResult[] = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const count = Math.min(PAGE, max - offset);
    const page = await request<RunResult[]>("GET", `tests/${testId}/results`, { params: { count, offset } });
    const list = Array.isArray(page) ? page : [];
    results.push(...list);
    if (list.length < count) return { results, exhausted: true };
    if (list.some((result) => result.passing === true)) break;
  }
  return { results, exhausted: false };
}

/**
 * Every red test's streak start, grouped by when they began, to find failures with one cause.
 *
 * @param options Scope, the grouping window and how far back to look per test.
 * @return Groups, largest first, and the red tests whose onset could not be seen.
 * @throws {GhostInspectorError} when the test listing cannot be read.
 */
export async function failureGroups(
  options: ScopeFilter & { windowHours?: number | undefined; maxRunsPerTest?: number | undefined },
): Promise<FailureGroupsReport> {
  const tests = await request<TestRecord[]>("GET", "tests", { timeoutMs: 120_000 });
  const scope = await scopeFor(options, tests);
  const windowHours = options.windowHours ?? 12;
  const max = Math.min(MAX_RUNS, Math.max(1, options.maxRunsPerTest ?? 200));
  const reds = tests.filter((test) => test.passing === false && !isModule(test) && (!scope || scope.ids.has(test._id)));

  let runsRead = 0;
  const onsets: Onset[] = [];
  const onsetUnknown: FailureGroupsReport["onsetUnknown"] = [];
  await pool(reds, REQUEST_CONCURRENCY, async (test) => {
    const suiteRef = test["suite"];
    const base = {
      id: test._id,
      name: test.name ?? "(unnamed)",
      suite: suiteRef && typeof suiteRef === "object" ? String((suiteRef as { name?: unknown }).name ?? "") : "",
    };
    try {
      const { results, exhausted } = await walkUntilGreen(test._id, max);
      runsRead += results.length;
      const history = summarizeHistory(results, exhausted);
      const first = history.firstFail;
      if (first && history.lastPass && first.finishedAt) {
        onsets.push({ ...base, onset: first.finishedAt, error: first.failingStep?.error ?? "", target: first.failingStep?.resolvedTarget ?? null });
      } else {
        onsetUnknown.push({
          ...base,
          reason: first ? `no passing run in the ${results.length} read${exhausted ? ", which is all that is retained" : ""}` : "no finished failing run found",
        });
      }
    } catch (error) {
      onsetUnknown.push({ ...base, reason: `history unreadable: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  const notes = [
    `An onset is the first failure after a test's last green run. Onsets less than ${windowHours}h apart are grouped, whatever suite or folder they sit in: one cause usually breaks many tests at once.`,
    "Staleness is not considered here. gi_stale_tests says which of these reds describe a definition that has changed since.",
  ];
  if (scope) notes.unshift(scopeNote(scope, "Only red tests in it were walked."));
  return { scanned: { redTests: reds.length, runsRead }, groups: groupFailures(onsets, windowHours), onsetUnknown, notes };
}
