/**
 * Why is this test red.
 *
 * The one question 0.1.x could not answer: it could say *which* tests were
 * failing and whether the failure was worth trusting, but the actual step and
 * error still meant opening the dashboard.
 *
 * Three things make this harder than "read the last result", all verified
 * against a live account and all of which produce a confidently wrong diagnosis
 * if ignored:
 *
 *   1. **A stale result describes a version that no longer exists.** The
 *      staleness verdict therefore comes before the error, not after it — a
 *      reader who sees the error first has already started diagnosing.
 *   2. **Result steps are expanded**, so a step's index says nothing about the
 *      definition. `extra.source` names the test that actually contributed it,
 *      which is the one that needs editing.
 *   3. **A result step's `target` is the selector that resolved**, collapsed
 *      from whatever fallback array was authored — and sometimes normalised so
 *      it matches nothing in the definition textually. Reporting it alone reads
 *      as "the test looks for X" when it was authored to try X or Y.
 */

import {
  isModule,
  request,
  type RunResult,
  type TestRecord,
} from "./client.js";
import { collectChainIds, pool, REQUEST_CONCURRENCY, type Steps } from "./graph.js";
import { EVAL_VALUE_NOTE, evidenceOf, executionTimeMs, stepsExecuted, type Evidence } from "./results.js";
import { expandSteps, type ExpandedStep } from "./validate.js";
import { assessStaleness, type StalenessVerdict } from "./writes.js";

/** What the run's own record says, independent of any step. */
export interface RunSummary {
  id: string;
  passing: boolean | null;
  finishedAt: string | null;
  executionTimeMs: number | null;
  endUrl: string | null;
  /** Steps that ran; a skipped condition or a step never reached does not count. */
  stepsExecuted: number;
  stepsInResult: number;
  evidence: Evidence;
}

export interface FailingStep {
  /** Position in the root test's step list — what a human counts. */
  rootSequence: number | null;
  command: string;
  error: string;
  /**
   * The selector that actually resolved, as the result records it. Collapsed
   * from the authored array, and occasionally normalised (an `xpath=` prefix is
   * dropped), so it may match nothing in the definition by string comparison.
   */
  resolvedTarget: string | null;
  /** Every selector the definition authored for this step, in order. */
  authoredTargets: string[];
  /** True when the definition offered fallbacks and the result showed one. */
  targetCollapsed: boolean;
  value: string | null;
  url: string | null;
  /** The test that contributed this step — the one to edit. */
  ownedBy: { testId: string; name: string; isModule: boolean; sequenceInOwner: number | null } | null;
  /** How the step was matched to the definition. `unmapped` means sequenceInOwner and authoredTargets are unknown. */
  mapping: "position" | "stored sequence" | "unmapped";
}

/** Where a result step sits in the definition, however that was worked out. */
export interface StepLocation {
  ownerId: string;
  sequenceInOwner: number | null;
  rootSequence: number | null;
  mapping: FailingStep["mapping"];
}

/** A test that contributes steps to a run, as the mapping needs it. */
export interface Owner {
  name: string;
  steps: Steps;
  isModule: boolean;
}

export interface Diagnosis {
  test: { id: string; name: string; suite: string | null; importOnly: boolean };
  /** Read this before the failure. A stale result is not evidence. */
  /**
   * `past horizon` is deliberately distinct from `never run`: the test has run,
   * the run asked for is simply purged. Collapsing the two states tells someone
   * a test has never executed when it has failed a hundred times.
   */
  verdict:
    | "diagnosable"
    | "stale"
    | "not failing"
    | "in flight"
    | "never run"
    | "past horizon"
    | "module";
  staleness: StalenessVerdict | null;
  run: RunSummary | null;
  failingStep: FailingStep | null;
  horizon: { resultsVisible: number; oldestVisible: string | null; note: string };
  notes: string[];
}

/**
 * Whether a requested run exists, is purged, or never happened.
 *
 * 🔴 The two absent cases must stay distinct. "No results at all" may mean a
 * test that never ran *or* one whose history was purged, and the API cannot
 * tell them apart — so this does not pretend to either. "Fewer results than
 * asked for" is different and knowable: the test has run, that particular run
 * is simply gone. Reporting the second as "never run" tells someone a test has
 * never executed when it may have failed a hundred times.
 *
 * @param retained How many results came back.
 * @param runsBack Which run was asked for; 0 is the latest.
 */
export function horizonVerdict(retained: number, runsBack: number): "available" | "past horizon" | "never run" {
  if (retained === 0) return "never run";
  return retained <= runsBack ? "past horizon" : "available";
}

/** Selectors a step authored, flattened from either shape the API uses. */
export function authoredSelectors(target: unknown): string[] {
  if (typeof target === "string") return target ? [target] : [];
  if (Array.isArray(target)) {
    return target
      .map((entry) =>
        typeof entry === "string" ? entry : String((entry as Record<string, unknown>)?.["selector"] ?? ""),
      )
      .filter((s) => s !== "");
  }
  return [];
}

/**
 * The step that failed, or null when none did.
 *
 * 🔴 `passing: false` is the only marker. A step with `passing: null` never
 * ran — reading that as a failure invents one at the first step after the real
 * break, which is the most misleading place to point.
 */
export function pickFailingStep(steps: Array<Record<string, unknown>>): Record<string, unknown> | null {
  return steps.find((s) => s["passing"] === false) ?? null;
}

/**
 * Turns a raw result step plus its owning definition into a report.
 *
 * Kept pure so the target-collapse and ownership rules can be exercised with
 * fixtures — they are the two things that silently mislead.
 *
 * @param step The failing step, from a result.
 * @param ownerSteps Steps of the test named by `extra.source.test`, if fetched.
 * @param ownerName Name of that test.
 * @param ownerIsModule Whether that test is import-only.
 */
export function describeFailingStep(
  step: Record<string, unknown>,
  ownerSteps: Steps | null,
  ownerName: string,
  ownerIsModule: boolean,
  location: StepLocation = storedLocation(step),
): FailingStep {
  const { ownerId, sequenceInOwner: seqInOwner } = location;
  const authored =
    ownerSteps && seqInOwner !== null ? authoredSelectors(ownerSteps[seqInOwner]?.["target"]) : [];
  const resolved = typeof step["target"] === "string" ? (step["target"] as string) : null;

  return {
    rootSequence: location.rootSequence,
    command: String(step["command"] ?? ""),
    error: String(step["error"] ?? ""),
    resolvedTarget: resolved,
    authoredTargets: authored,
    // Only a real collapse when more than one selector was offered. One
    // authored selector reported as itself is not a discrepancy worth flagging.
    targetCollapsed: authored.length > 1 && resolved !== null,
    value: step["value"] === undefined ? null : String(step["value"]),
    url: step["url"] === undefined ? null : String(step["url"]),
    ownedBy: ownerId
      ? { testId: ownerId, name: ownerName, isModule: ownerIsModule, sequenceInOwner: seqInOwner }
      : null,
    mapping: location.mapping,
  };
}

/**
 * The location a result step claims for itself through `extra.source` and `extra.rootSequence`.
 *
 * @param step A result step.
 * @return Its owner and stored positions, taken at face value.
 */
function storedLocation(step: Record<string, unknown>): StepLocation {
  const extra = (step["extra"] ?? {}) as Record<string, unknown>;
  const source = (extra["source"] ?? {}) as Record<string, unknown>;
  return {
    ownerId: source["test"] === undefined ? "" : String(source["test"]),
    sequenceInOwner: typeof source["sequence"] === "number" ? source["sequence"] : null,
    rootSequence: typeof extra["rootSequence"] === "number" ? extra["rootSequence"] : null,
    mapping: "stored sequence",
  };
}

/**
 * The test record with the dates and verdict of the given run.
 *
 * @param test The test record.
 * @param result The run being diagnosed.
 * @return A copy to compare the chain against.
 */
export function asOfRun(test: TestRecord, result: RunResult): TestRecord {
  const copy: TestRecord = { ...test, passing: result.passing ?? null };
  if (result["dateExecutionFinished"] !== undefined) copy.dateExecutionFinished = String(result["dateExecutionFinished"]);
  if (result["dateExecutionTriggered"] !== undefined) copy.dateExecutionTriggered = String(result["dateExecutionTriggered"]);
  return copy;
}

/**
 * Pairs each result step with the expanded definition step at the same position.
 *
 * @param resultSteps Steps of a result, in run order.
 * @param expanded The current definition, expanded locally.
 * @param flags Whether the chain is stale or its expansion truncated.
 * @return The expanded steps, parallel to the result, or null when position cannot be trusted.
 */
export function alignByPosition(
  resultSteps: Array<Record<string, unknown>>,
  expanded: ExpandedStep[],
  flags: { stale: boolean; truncated: boolean },
): ExpandedStep[] | null {
  if (flags.stale || flags.truncated || resultSteps.length !== expanded.length) return null;
  const sameCommands = resultSteps.every((step, i) => String(step["command"] ?? "") === expanded[i]?.command);
  return sameCommands ? expanded : null;
}

/**
 * Whether stored `sequence` values can locate a step: exactly 0..n-1, in order.
 *
 * @param steps One test's own steps.
 * @return False when any value repeats, is missing or is out of place.
 */
export function sequencesUsable(steps: Steps): boolean {
  return steps.every((step, i) => step["sequence"] === i);
}

/**
 * Finds the failing step of a result and maps it to the definition step that produced it.
 *
 * @param resultSteps Steps of the result.
 * @param expanded The current definition, expanded locally with owners.
 * @param owners Every test in the chain, by id.
 * @param flags Whether the chain is stale or its expansion truncated.
 * @param rootId The test the result belongs to.
 * @return The failing step with its mapping, or null when no step failed.
 */
export function locateFailingStep(
  resultSteps: Array<Record<string, unknown>>,
  expanded: ExpandedStep[],
  owners: ReadonlyMap<string, Owner>,
  flags: { stale: boolean; truncated: boolean },
  rootId = "",
): FailingStep | null {
  const index = resultSteps.findIndex((step) => step["passing"] === false);
  const step = resultSteps[index];
  if (!step) return null;

  const entry = alignByPosition(resultSteps, expanded, flags)?.[index];
  if (entry) {
    const owner = owners.get(entry.ownerId);
    return describeFailingStep(step, owner?.steps ?? null, owner?.name ?? entry.ownerName, owner?.isModule ?? false, {
      ownerId: entry.ownerId,
      sequenceInOwner: entry.indexInOwner,
      rootSequence: entry.rootIndex,
      mapping: "position",
    });
  }

  const stored = storedLocation(step);
  const owner = owners.get(stored.ownerId);
  const root = owners.get(rootId);
  if (owner && stored.sequenceInOwner !== null && sequencesUsable(owner.steps)) {
    const rootSequence = root && sequencesUsable(root.steps) ? stored.rootSequence : null;
    return describeFailingStep(step, owner.steps, owner.name, owner.isModule, { ...stored, rootSequence });
  }
  return describeFailingStep(step, null, owner?.name ?? "", owner?.isModule ?? false, {
    ownerId: stored.ownerId,
    sequenceInOwner: null,
    rootSequence: null,
    mapping: "unmapped",
  });
}

/** Notes that must accompany a failing step so it is not read too literally. */
export function targetNotes(step: FailingStep): string[] {
  const notes: string[] = [];
  if (step.targetCollapsed) {
    notes.push(
      `🔴 The definition offers ${step.authoredTargets.length} fallback selectors for this step; the result records only the one that resolved. Do not read this as "the test looks for" a single selector — read authoredTargets.`,
    );
  }
  if (step.resolvedTarget && step.authoredTargets.length > 0 && !step.authoredTargets.includes(step.resolvedTarget)) {
    notes.push(
      "⚠️ The resolved target does not appear verbatim in the definition — Ghost Inspector normalises some selectors, dropping an `xpath=` prefix. Searching the definition for this string will not find the step. Match by sequence instead.",
    );
  }
  if (step.mapping === "unmapped") {
    notes.push(
      "⚠️ This step could not be located in its test's definition, so authoredTargets and sequenceInOwner are unknown. Usually the owner's steps carry duplicate `sequence` values (saved by a client that omitted it); re-saving them with gi_update_test repairs the mapping. Otherwise the result no longer lines up with the current definition — re-run the test and ask again.",
    );
  }
  if (step.ownedBy?.isModule) {
    notes.push(
      `🔴 This step comes from the module "${step.ownedBy.name}", not from the test you asked about. Editing the test will not fix it, and editing the module affects every test that imports it — run gi_module_usage first.`,
    );
  }
  return notes;
}

export interface DiagnoseOptions {
  testId: string;
  /** 0 is the latest run. Higher walks backwards, within the retained window. */
  runsBack?: number | undefined;
}

/**
 * Explains a test's most recent run: the step that failed and whether the
 * result can be trusted at all.
 *
 * @param options The test, and how far back to look.
 * @returns The staleness verdict first, then the failure.
 * @throws {GhostInspectorError} when the test does not exist or a call fails.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function diagnoseTest(options: DiagnoseOptions): Promise<Diagnosis> {
  const runsBack = Math.max(0, options.runsBack ?? 0);
  const test = await request<TestRecord>("GET", `tests/${options.testId}`);
  const suiteRecord = test["suite"];
  const identity = {
    id: String(test._id ?? options.testId),
    name: String(test.name ?? ""),
    suite:
      suiteRecord && typeof suiteRecord === "object"
        ? String((suiteRecord as Record<string, unknown>)["name"] ?? "")
        : null,
    importOnly: isModule(test),
  };

  const empty = (verdict: Diagnosis["verdict"], note: string): Diagnosis => ({
    test: identity,
    verdict,
    staleness: null,
    run: null,
    failingStep: null,
    horizon: { resultsVisible: 0, oldestVisible: null, note },
    notes: [note],
  });

  // A module has no results at all: marking a test import-only deletes them.
  // Returning "no runs found" here would read as a purge or a broken test.
  if (identity.importOnly) {
    return empty(
      "module",
      "This test is import-only, so Ghost Inspector deletes its results and it never runs on its own. There is nothing to diagnose here — diagnose one of the tests that imports it, found via gi_module_usage.",
    );
  }

  const wanted = runsBack + 1;
  const results = await request<RunResult[]>("GET", `tests/${options.testId}/results`, {
    params: { count: wanted },
  });
  const retained = Array.isArray(results) ? results.length : 0;
  if (horizonVerdict(retained, runsBack) === "never run") {
    return empty(
      "never run",
      "No results are retained for this test. Either it has never run, or its results have been purged — the API cannot tell those apart, so neither can this.",
    );
  }
  if (horizonVerdict(retained, runsBack) === "past horizon") {
    const answer = empty(
      "past horizon",
      `This test HAS run — only ${results.length} result(s) are still retained, so run ${runsBack} back is past the horizon rather than nonexistent. Ghost Inspector purges old results and they cannot be recovered. The furthest back you can look is runsBack=${results.length - 1}.`,
    );
    answer.horizon.resultsVisible = results.length;
    const furthest = results[results.length - 1] as RunResult | undefined;
    answer.horizon.oldestVisible =
      furthest?.["dateExecutionFinished"] === undefined ? null : String(furthest["dateExecutionFinished"]);
    return answer;
  }

  const result = results[runsBack] as RunResult;
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const run: RunSummary = {
    id: String(result._id ?? ""),
    passing: result.passing ?? null,
    finishedAt: result["dateExecutionFinished"] === undefined ? null : String(result["dateExecutionFinished"]),
    executionTimeMs: executionTimeMs(result),
    endUrl: result.endUrl === undefined || result.endUrl === null ? null : String(result.endUrl),
    stepsExecuted: stepsExecuted(steps),
    stepsInResult: steps.length,
    evidence: evidenceOf(result, false),
  };
  const oldest = results[results.length - 1] as RunResult | undefined;
  const horizon = {
    resultsVisible: results.length,
    oldestVisible: oldest?.["dateExecutionFinished"] === undefined ? null : String(oldest["dateExecutionFinished"]),
    note:
      `Fetched ${results.length} result(s). Ghost Inspector purges old results, so anything earlier than the oldest shown is gone — ` +
      "say \"cannot see past that\" rather than treating it as \"never failed before\". Raise runsBack to look further within the retained window.",
  };

  // Staleness before the error, always: a stale result describes a definition
  // that no longer exists, and a reader who sees the error first has already
  // begun diagnosing from it.
  const records = new Map<string, Promise<TestRecord>>([[identity.id, Promise.resolve(test)]]);
  const loadRecord = (id: string): Promise<TestRecord> => {
    const hit = records.get(id) ?? request<TestRecord>("GET", `tests/${id}`);
    records.set(id, hit);
    return hit;
  };
  const stepsOf = (record: TestRecord): Steps => (Array.isArray(record.steps) ? record.steps : []);
  const { ids, truncated } = await collectChainIds(identity.id, async (id) => stepsOf(await loadRecord(id)));
  const chain = await pool(ids, REQUEST_CONCURRENCY, loadRecord);
  const staleness = assessStaleness(asOfRun(test, result), chain, truncated);

  if (run.passing === null) {
    return {
      test: identity,
      verdict: "in flight",
      staleness,
      run,
      failingStep: null,
      horizon,
      notes: [
        "This run has not finished: `passing` is null, which means pending, never failed. Ask again once it completes.",
      ],
    };
  }

  const notes: string[] = steps.some((step) => step["command"] === "eval") ? [EVAL_VALUE_NOTE] : [];
  let verdict: Diagnosis["verdict"] = run.passing ? "not failing" : "diagnosable";
  if (staleness.verdict === "stale") {
    verdict = "stale";
    const who = staleness.changedAfterLastRun
      .map((c) => `${c.isSelf ? "the test itself" : `module "${c.name}"`} at ${c.dateUpdated}`)
      .join("; ");
    notes.push(
      `🔴 STOP — this result is out of date. Changed after the run: ${who}. The failure below describes a definition that is no longer stored, so anything diagnosed from it is diagnosed from nothing, and someone may already have fixed it. Re-run the test and diagnose the fresh result. Note that dateUpdated only says the record changed — a rename or a suite move bumps it too — so this means "out of date", never "already fixed".`,
    );
  }
  if (run.passing === true) {
    notes.push("This run passed, so there is no failing step. Shown for reference.");
  }

  const failing = pickFailingStep(steps);
  if (!failing) {
    if (run.passing === false) {
      notes.push(
        "🔴 The run is red but no step reports `passing: false`. The failure happened outside the steps — a start URL that would not load, a browser-level error, or a timeout. Read endUrl and the run's own record; the step list will not explain this one.",
      );
    }
    return { test: identity, verdict, staleness, run, failingStep: null, horizon, notes };
  }

  const expansion = await expandSteps(
    stepsOf(test),
    async (id) => {
      const record = await loadRecord(id);
      return { name: String(record.name ?? id), steps: stepsOf(record) };
    },
    { id: identity.id, name: identity.name },
  );
  const sourceId = storedLocation(failing).ownerId;
  if (sourceId) await loadRecord(sourceId);
  const owners = new Map<string, Owner>();
  for (const [id, pending] of records) {
    const record = await pending;
    owners.set(id, { name: String(record.name ?? ""), steps: stepsOf(record), isModule: isModule(record) });
  }
  const failingStep = locateFailingStep(
    steps,
    expansion.steps,
    owners,
    { stale: staleness.verdict === "stale", truncated: truncated || expansion.truncated },
    identity.id,
  ) as FailingStep;
  notes.push(...targetNotes(failingStep));
  return { test: identity, verdict, staleness, run, failingStep, horizon, notes };
}
