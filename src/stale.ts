/**
 * Stale versus broken — the triage the dashboard cannot do.
 *
 * A red test whose definition, or any module in its `execute` chain, was edited
 * *after* its last run is **stale, not broken**: the failure describes a version
 * that no longer exists. Someone may already have fixed it and the test simply
 * has not run again. Editing on top of that destroys their work, and Ghost
 * Inspector keeps no version history of steps.
 *
 * One level deep is not enough, because modules nest. The whole forward chain
 * has to be compared, which is why this shares the graph scan with the module
 * index.
 *
 * The inverse case matters too and nobody looks for it: a *green* test whose
 * chain changed after its last run is unverified, not healthy. Its pass
 * describes the old definition.
 */

import { hasNeverExecuted, isModule, request, type TestRecord } from "./client.js";
import { buildEdges, fetchDefinitions, fetchDefinitionsClosure, walk, type Steps } from "./graph.js";
import { scopeFor, scopeNote, type ScopeFilter } from "./scope.js";

/** Findings listed per bucket before switching to a count. */
const FINDING_CAP = 25;

const DAY_MS = 86_400_000;

export interface StaleFinding {
  id: string;
  /**
   * The test's `dateUpdated` at scan time — the token gi_update_test wants as
   * `expectedDateUpdated`. Reported so a repair flows straight from a finding.
   */
  dateUpdated: string;
  name: string;
  suite: string;
  /** ISO timestamp of the last completed run. */
  lastRun: string;
  daysSinceLastRun: number;
  /** The test's own definition changed after its last run. */
  selfChanged: boolean;
  /** Modules in its chain that changed after its last run. */
  changedModules: string[];
  /** Most recent change across the test and its chain. */
  newestChange: string;
  chainDepth: number;
  /** True when the chain hit the documented nesting limit; more may be unseen. */
  chainTruncated: boolean;
}

export interface PlainFinding {
  id: string;
  /** See {@link StaleFinding.dateUpdated}. */
  dateUpdated: string;
  name: string;
  suite: string;
  lastRun: string;
  daysSinceLastRun: number;
}

export interface StaleReport {
  scanned: { tests: number; stepRequests: number; unreadable: number };
  totals: {
    /** Non-module tests that have completed a run and were classified. */
    evaluated: number;
    failing: number;
    failingStale: number;
    failingGenuine: number;
    passingUnverified: number;
    /** Not reporting a pass or fail: queued or mid-run. Not classifiable. */
    inFlight: number;
    /** Non-modules that have never completed a run. */
    neverRun: number;
    /** Excluded by design: modules have no results at all. */
    modulesExcluded: number;
  };
  notes: string[];
  /** 🔴 Red, but the result predates a change. Do not edit these yet. */
  staleFailures: StaleFinding[];
  /** Red, and nothing has changed since the run. Genuinely broken. */
  genuineFailures: PlainFinding[];
  genuineFailuresOmitted: number;
  /** Green, but the result predates a change. The pass proves nothing now. */
  unverifiedPasses: StaleFinding[];
  unverifiedPassesOmitted: number;
  /** Non-modules that have never run. Neither stale nor broken. */
  neverRun: string[];
}

/** Milliseconds of a record's last change, or `null` when unusable. */
function changedAt(test: TestRecord | undefined): number | null {
  if (!test?.dateUpdated) return null;
  const parsed = Date.parse(String(test.dateUpdated));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Splits every test into stale, genuinely broken, unverified or unrun.
 *
 * Pure: takes `now` rather than reading the clock, so a fixture produces the
 * same answer every time.
 *
 * A `dateUpdated` that cannot be parsed counts as *changed*. That direction is
 * deliberate. Reporting a stale test as genuinely broken invites someone to
 * overwrite a colleague's fix, against a system with no version history; the
 * opposite error only costs a second look.
 *
 * @param tests Every test record, from `GET /tests/`.
 * @param steps Per-test steps keyed by test id, for the `execute` chain.
 * @param now Milliseconds to measure ages against.
 * @returns The triage.
 */
export function buildStaleReport(
  tests: TestRecord[],
  steps: Map<string, Steps>,
  now: number,
  only?: ReadonlySet<string>,
  unreadableCount?: number,
): StaleReport {
  const { forward, name } = buildEdges(tests, steps);
  const byId = new Map(tests.map((t) => [t._id, t]));
  const inScope = only ? tests.filter((test) => only.has(test._id)) : tests;

  const staleFailures: StaleFinding[] = [];
  const genuineFailures: PlainFinding[] = [];
  const unverifiedPasses: StaleFinding[] = [];
  const neverRun: string[] = [];
  let modulesExcluded = 0;
  let inFlight = 0;
  let evaluated = 0;
  let failing = 0;
  let anyTruncated = false;

  for (const test of tests) {
    if (only && !only.has(test._id)) continue;
    // Modules first, always. Import-only deletes a test's results, so every
    // module reads as never-run; measuring one against its chain would report
    // the entire shared layer as stale.
    if (isModule(test)) {
      modulesExcluded += 1;
      continue;
    }
    if (hasNeverExecuted(test)) {
      neverRun.push(test.name ?? "(unnamed)");
      continue;
    }

    const lastRunMs = Date.parse(String(test.dateExecutionFinished ?? test.dateExecutionTriggered));
    if (Number.isNaN(lastRunMs)) {
      neverRun.push(test.name ?? "(unnamed)");
      continue;
    }
    if (test.passing !== true && test.passing !== false) {
      inFlight += 1;
      continue;
    }

    evaluated += 1;
    if (test.passing === false) failing += 1;

    const chain = walk(test._id, forward);
    if (chain.truncated) anyTruncated = true;

    const selfMs = changedAt(test);
    const selfChanged = selfMs === null || selfMs > lastRunMs;
    const changedModules: string[] = [];
    let newest = selfChanged && selfMs !== null ? selfMs : 0;

    for (const id of chain.ids) {
      const ms = changedAt(byId.get(id));
      if (ms === null || ms > lastRunMs) {
        changedModules.push(name.get(id) ?? id);
        if (ms !== null && ms > newest) newest = ms;
      }
    }

    const outdated = selfChanged || changedModules.length > 0;
    const common = {
      id: test._id,
      // The write path's concurrency token, carried here so repairing a finding
      // does not need a second read. A stale token is the correct outcome: it
      // means the record moved between this report and the write.
      dateUpdated: String(test.dateUpdated ?? ""),
      name: test.name ?? "(unnamed)",
      suite:
        test.suite && typeof test.suite === "object"
          ? ((test.suite as { name?: string }).name ?? "(unnamed suite)")
          : "(no suite)",
      lastRun: new Date(lastRunMs).toISOString(),
      daysSinceLastRun: Math.floor((now - lastRunMs) / DAY_MS),
    };

    if (!outdated) {
      if (test.passing === false) genuineFailures.push(common);
      continue;
    }

    const finding: StaleFinding = {
      ...common,
      selfChanged,
      changedModules: changedModules.sort(),
      newestChange: new Date(Math.max(newest, lastRunMs)).toISOString(),
      chainDepth: chain.depth,
      chainTruncated: chain.truncated,
    };
    if (test.passing === false) staleFailures.push(finding);
    else unverifiedPasses.push(finding);
  }

  // Most recently changed first: those are the likeliest to be already fixed.
  const byNewest = (a: StaleFinding, b: StaleFinding) => b.newestChange.localeCompare(a.newestChange);
  // Longest untouched first: that is where a real failure has been sitting.
  const byAge = (a: PlainFinding, b: PlainFinding) => b.daysSinceLastRun - a.daysSinceLastRun;

  staleFailures.sort(byNewest);
  genuineFailures.sort(byAge);
  unverifiedPasses.sort(byNewest);

  const notes: string[] = [
    "staleFailures are red tests whose definition or module chain changed AFTER the failing run. The failure describes a version that no longer exists, so someone may already have fixed it. Diagnose those from a fresh run, never from this result, and never by editing on top of it — Ghost Inspector keeps no version history of steps.",
    "🔴 Re-running is not free. Many Ghost Inspector suites submit real forms against production, so confirm what a test does before triggering it. Validating a definition without saving or submitting is what on-demand execution is for.",
    "genuineFailures have had no change since the failing run, so the failure still describes the current definition. Start there.",
  ];
  if (unverifiedPasses.length > 0) {
    notes.push(
      `${unverifiedPasses.length} passing test(s) also changed after their last run. Their green result describes the old definition and proves nothing about the current one. Nobody looks for these because the dashboard shows them as healthy.`,
    );
  }
  if (modulesExcluded > 0) {
    notes.push(
      `${modulesExcluded} import-only module(s) were excluded, not evaluated: setting import-only deletes a test's results, so a module has no run to compare against and would always read as stale.`,
    );
  }
  if (anyTruncated) {
    notes.push(
      "At least one chain reached the documented 10-level nesting limit, so its change set is a floor rather than a total.",
    );
  }
  const unreadable = unreadableCount ?? inScope.filter((test) => !steps.has(test._id)).length;
  if (unreadable > 0) {
    notes.push(
      `⚠️ ${unreadable} definition(s) could not be read. An edit inside one is invisible here, so a failure listed as genuine may be stale. Ask again in a moment: the API rate-limits bursts.`,
    );
  }

  return {
    scanned: {
      tests: inScope.length,
      stepRequests: steps.size,
      unreadable,
    },
    totals: {
      evaluated,
      failing,
      failingStale: staleFailures.length,
      failingGenuine: genuineFailures.length,
      passingUnverified: unverifiedPasses.length,
      inFlight,
      neverRun: neverRun.length,
      modulesExcluded,
    },
    notes,
    // Never capped: this is the bucket the tool exists for, and a red test
    // hidden behind a "and 12 more" is the one that gets overwritten.
    staleFailures,
    // Uncapped. Trimming is presentation, applied at the boundary, so this
    // function never reports an omission count it did not cause.
    genuineFailures,
    genuineFailuresOmitted: 0,
    unverifiedPasses,
    unverifiedPassesOmitted: 0,
    neverRun: neverRun.sort(),
  };
}

export interface StaleOptions extends ScopeFilter {
  /** Include the unverified-passes bucket. Off by default: it is the long one. */
  includePasses?: boolean | undefined;
}

/**
 * Fetches every test definition and triages red tests into stale versus broken.
 *
 * @param options Optional narrowing of what is returned; the scan is unchanged.
 * @returns The triage.
 * @throws {GhostInspectorError} if the test listing itself fails.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function getStaleTests(options: StaleOptions = {}): Promise<StaleReport> {
  const tests = await request<TestRecord[]>("GET", "tests", { timeoutMs: 120_000 });
  const scope = await scopeFor(options, tests);
  const { steps, unreadable } = scope ? await fetchDefinitionsClosure([...scope.ids]) : await fetchDefinitions(tests);
  const report = buildStaleReport(tests, steps, Date.now(), scope?.ids, scope ? unreadable : undefined);
  if (scope) {
    report.notes.unshift(scopeNote(scope));
  }

  if (!options.includePasses) {
    report.unverifiedPasses = [];
    if (report.totals.passingUnverified > 0) {
      report.notes.push(
        `The ${report.totals.passingUnverified} unverified pass(es) are counted above but not listed. Pass includePasses to see them.`,
      );
    }
  } else if (report.unverifiedPasses.length > FINDING_CAP) {
    report.unverifiedPassesOmitted = report.unverifiedPasses.length - FINDING_CAP;
    report.unverifiedPasses = report.unverifiedPasses.slice(0, FINDING_CAP);
    report.notes.push(
      `Listing the first ${FINDING_CAP} of ${report.totals.passingUnverified} unverified passes. The count above is the total.`,
    );
  }

  // staleFailures is deliberately never trimmed: a red test hidden behind an
  // "and N more" is the one that gets overwritten.
  if (report.genuineFailures.length > FINDING_CAP) {
    report.genuineFailuresOmitted = report.genuineFailures.length - FINDING_CAP;
    report.genuineFailures = report.genuineFailures.slice(0, FINDING_CAP);
    report.notes.push(
      `Listing the ${FINDING_CAP} oldest of ${report.totals.failingGenuine} genuine failures.`,
    );
  }
  return report;
}
