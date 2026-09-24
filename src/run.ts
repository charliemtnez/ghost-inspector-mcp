/**
 * Running a stored test, for real.
 *
 * This is the only tool that executes a test **as saved**, with nothing
 * truncated. Everywhere else in this server an execution is guarded:
 * `gi_validate_test` runs a throwaway copy and stops before anything can
 * submit. Here the test does exactly what it was written to do, which in a real
 * account routinely means posting a form to production.
 *
 * Two independent barriers, because they answer different questions:
 *
 *   1. **`GHOST_INSPECTOR_ALLOW_RUNS`** — the operator's standing decision that
 *      this server may execute anything at all. Separate from the write gate:
 *      an edit can be rolled back from the backup the write path returns, a
 *      submitted form cannot be unsubmitted.
 *   2. **`confirmSubmit`, per call, and only when the test actually submits.**
 *      The submit detector already exists for the validation guard, and it
 *      inlines modules first — a test whose steps are all `execute` calls hides
 *      its submit inside one. Tests that submit nothing run without ceremony,
 *      so the friction lands only where there is a consequence. A flag that
 *      every call needs is a flag every caller sets by reflex, which is the
 *      failure mode the write path's confirmation flag was rejected for.
 */

import { pollResult, request, type RunResult, type TestRecord } from "./client.js";
import { type Steps } from "./graph.js";
import { evidenceOf, executionTimeMs, type Evidence } from "./results.js";
import { expandSteps, findSubmit, type Loaded } from "./validate.js";

/**
 * How long to wait on the execute call.
 *
 * The endpoint blocks for the duration of the run, and the observed wall time
 * exceeds the test's own execution time by the queue wait — 50s of wall for a
 * 29s test. The client's 60s default would therefore abort healthy runs, so
 * this is deliberately well above any browser run.
 */
export const DEFAULT_WAIT_MS = 240_000;

export interface RunOptions {
  testId: string;
  /** Required only when the test contains a step that could submit a form. */
  confirmSubmit?: boolean | undefined;
  /** How long to wait for the run before handing back the id. Default 240s. */
  timeoutMs?: number | undefined;
}

export interface SubmitAssessment {
  /** True when a step in the expanded definition could submit a form. */
  submits: boolean;
  reason: string | null;
  /** Module that contributed the submitting step, when it came from one. */
  fromModule: string | null;
  modulesInlined: number;
  /** True when the expansion hit the nesting limit, so this may be incomplete. */
  chainTruncated: boolean;
}

export interface RunReport {
  started: boolean;
  refusedBecause?: string;
  submitAssessment: SubmitAssessment;
  resultId: string | null;
  /** Null when the run was still pending when the wait expired. */
  outcome: {
    passing: boolean | null;
    executionTimeMs: number | null;
    endUrl: string | null;
    /** Every URL the run visited, in order. */
    urls: string[];
    evidence: Evidence;
  } | null;
  notes: string[];
}

/**
 * Whether running this definition could submit something.
 *
 * Pure, so the direction of the uncertain case stays provable: a truncated
 * chain counts as *may submit*, never as safe. A chain that could not be fully
 * expanded might hide a submit in the part that was not read, and the cost of
 * being wrong is asymmetric — an unnecessary confirmation versus a real record
 * in somebody's CRM.
 *
 * @param expanded Steps after modules are inlined.
 * @param modulesInlined How many modules contributed.
 * @param truncated Whether the expansion hit the nesting limit or looped.
 */
export function assessSubmit(
  expanded: Array<{ command: string; target: string; value: string; fromModule: string | null }>,
  modulesInlined: number,
  truncated: boolean,
): SubmitAssessment {
  const hit = findSubmit(expanded as Parameters<typeof findSubmit>[0]);
  if (hit) {
    return {
      submits: true,
      reason: hit.reason,
      fromModule: expanded[hit.index]?.fromModule ?? null,
      modulesInlined,
      chainTruncated: truncated,
    };
  }
  if (truncated) {
    return {
      submits: true,
      reason:
        "the import chain could not be fully expanded, so a submit may exist in the part that was not read",
      fromModule: null,
      modulesInlined,
      chainTruncated: true,
    };
  }
  return { submits: false, reason: null, fromModule: null, modulesInlined, chainTruncated: false };
}

/**
 * What to say about a finished run of a test that contains a submit-shaped step.
 *
 * @param reason Why the step reads as a submit.
 * @param endUrl Where the run ended.
 * @param urls Every URL it visited, in order.
 * @return Notes that report where the run went, never whether a record was created.
 */
export function submissionNotes(reason: string, endUrl: string | null, urls: string[]): string[] {
  const notes = [
    `This test contains a submit-shaped step (${reason}). The run ended at ${endUrl ?? "an unrecorded URL"} after visiting ${
      urls.length > 0 ? urls.join(" → ") : "no recorded URL"
    }. Whether a record was created is decided by the page — check the receiving system rather than assuming either way.`,
  ];
  if (endUrl !== null && endUrl === urls[0]) {
    notes.push(
      "The run ended on the page it started on, which is consistent with the browser blocking the submission (e.g. native validation).",
    );
  }
  return notes;
}

/**
 * The outcome block of a finished run.
 *
 * @param result The finished result record.
 * @return Verdict, duration, where it went and its evidence.
 */
function outcomeOf(result: RunResult): NonNullable<RunReport["outcome"]> {
  const evidence = evidenceOf(result, false);
  return {
    passing: result.passing ?? null,
    executionTimeMs: executionTimeMs(result),
    endUrl: result.endUrl === undefined || result.endUrl === null ? null : String(result.endUrl),
    urls: evidence.urls,
    evidence,
  };
}

/**
 * Executes a stored test and waits for the verdict.
 *
 * @param options The test, and confirmation if it submits.
 * @returns What ran, or why it was refused. Nothing runs on a refusal.
 * @throws {GhostInspectorError} when the test does not exist or a call fails.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function runTest(options: RunOptions): Promise<RunReport> {
  const test = await request<TestRecord>("GET", `tests/${options.testId}`);

  // A module cannot be executed at all: import-only blocks a direct run and a
  // suite run alike. Saying so beats letting the API answer with something the
  // caller has to interpret.
  if (test.importOnly === true) {
    return {
      started: false,
      refusedBecause: "this test is import-only",
      submitAssessment: { submits: false, reason: null, fromModule: null, modulesInlined: 0, chainTruncated: false },
      resultId: null,
      outcome: null,
      notes: [
        "Import-only tests cannot run on their own — that is what the flag means. Run one of the tests that imports it; gi_module_usage lists them.",
      ],
    };
  }

  const load = async (id: string): Promise<Loaded> => {
    const record = await request<TestRecord>("GET", `tests/${id}`);
    return { name: String(record.name ?? ""), steps: (Array.isArray(record.steps) ? record.steps : []) as Steps };
  };
  const expansion = await expandSteps((Array.isArray(test.steps) ? test.steps : []) as Steps, load);
  const assessment = assessSubmit(expansion.steps, expansion.modules.length, expansion.truncated);

  if (assessment.submits && options.confirmSubmit !== true) {
    return {
      started: false,
      refusedBecause: "this test submits, and confirmSubmit was not set",
      submitAssessment: assessment,
      resultId: null,
      outcome: null,
      notes: [
        `🔴 Nothing ran. This test contains a step that submits: ${assessment.reason}.${
          assessment.fromModule ? ` It comes from the module "${assessment.fromModule}", not from the test's own steps.` : ""
        }`,
        "Running it will post whatever that form posts, to whatever environment startUrl points at — in most accounts, production. That record cannot be withdrawn from here.",
        "If you only need to know whether the selectors still resolve, use gi_validate_test instead: it runs a throwaway copy and stops before the submit. Set confirmSubmit only when a real submission is genuinely what you want.",
        ...(assessment.chainTruncated
          ? ["⚠️ The import chain was truncated, so this assessment may be incomplete — treated as submitting."]
          : []),
      ],
    };
  }

  const notes: string[] = [];
  if (assessment.submits) {
    notes.push(
      `This test contains a submit-shaped step (${assessment.reason}) and ran as confirmed. Until its outcome is read, whether a record was created is unknown.`,
    );
  }
  /**
   * The notes for a finished run: the submit wording is replaced by one that knows where the run went.
   * @param outcome The finished run's outcome.
   */
  const finishedNotes = (outcome: NonNullable<RunReport["outcome"]>): string[] => [
    ...(assessment.submits ? submissionNotes(assessment.reason ?? "", outcome.endUrl, outcome.urls) : []),
    "For the failing step, its error and which test owns it, call gi_test_result on this test.",
  ];

  // 🔴 This endpoint BLOCKS until the run finishes — measured at 50s for a
  // 29s test, the difference being queue time. It does NOT behave like
  // on-demand/execute, which answers in ~0.2s with a pending record. So the
  // wait has to be spent on the request itself, not on polling afterwards, and
  // the client's 60s default would abort a perfectly healthy run.
  const waitMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  let pending: RunResult;
  try {
    pending = await request<RunResult>("POST", `tests/${options.testId}/execute`, { timeoutMs: waitMs });
  } catch (error) {
    // The request timed out, but Ghost Inspector already started the run and
    // no id ever came back. Calling this a failure would invent a red test and
    // strand a run nobody knows how to look up.
    return {
      started: true,
      submitAssessment: assessment,
      resultId: null,
      outcome: null,
      notes: [
        ...notes,
        `🔴 The run was STARTED and is still going — the wait expired before Ghost Inspector answered: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "This is not a failure and the test was not skipped. Because this endpoint only answers when the run completes, no result id exists yet. Call gi_test_result on this test shortly to read the outcome, or raise timeoutMs.",
      ],
    };
  }

  const resultId = String(pending._id ?? "");

  // Usually already finished, since the POST waited for it. Poll only if not.
  if (pending.passing !== null && pending.passing !== undefined) {
    const outcome = outcomeOf(pending);
    return {
      started: true,
      submitAssessment: assessment,
      resultId: resultId || null,
      outcome,
      notes: finishedNotes(outcome),
    };
  }

  if (!resultId) {
    return {
      started: true,
      submitAssessment: assessment,
      resultId: null,
      outcome: null,
      notes: [
        ...notes,
        "🔴 The run was accepted but no result id came back, so its outcome cannot be polled from here. Check the Ghost Inspector dashboard.",
      ],
    };
  }

  // Defensive fallback. Today the POST above always comes back finished, but
  // that is measured behaviour on one account and not a documented guarantee,
  // so a pending record still gets polled rather than reported as no verdict.
  try {
    const finished = await pollResult(resultId, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const outcome = outcomeOf(finished);
    return {
      started: true,
      submitAssessment: assessment,
      resultId,
      outcome,
      notes: finishedNotes(outcome),
    };
  } catch (error) {
    // A timeout is not a failure. The run is still going, and reporting it as
    // a failed test would invent a red that does not exist.
    return {
      started: true,
      submitAssessment: assessment,
      resultId,
      outcome: null,
      notes: [
        ...notes,
        `The run did not finish inside the wait: ${error instanceof Error ? error.message : String(error)}`,
        "🔴 This is not a failure. The run is still going — a browser run takes 20-70 seconds and a slow one takes longer. Call gi_test_result on this test in a moment to read the outcome.",
      ],
    };
  }
}
