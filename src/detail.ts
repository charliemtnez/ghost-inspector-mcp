/**
 * Single-test reads.
 *
 * This exists because the write path asks for a concurrency token — the
 * `dateUpdated` the caller believes is current — and no read tool used to
 * return it. The only way to obtain one was to send a wrong value on purpose
 * and harvest the correct one from the refusal, which turns a guard meant to
 * prove "I read the record" into a two-step handshake any agent completes
 * without reading anything. Reading is now the cheap path.
 */

import { request, type TestRecord } from "./client.js";
import { pool, REQUEST_CONCURRENCY, type Steps } from "./graph.js";
import { expandSteps } from "./validate.js";

/** A test as the caller needs it before editing: identity, token, definition. */
export interface TestDetail {
  id: string;
  name: string;
  suite: { id: string; name: string } | null;
  /**
   * 🔴 The concurrency token. Pass this verbatim as `expectedDateUpdated` when
   * calling gi_update_test. A write is refused if the record moved since.
   */
  dateUpdated: string;
  /** True when this is a module: imported by other tests, never run alone. */
  importOnly: boolean;
  /**
   * `true`/`false` for a test that has run. `null` means no verdict: queued,
   * mid-run, never executed, or a module — modules have their results deleted,
   * so this is never a boolean for one.
   */
  passing: boolean | null;
  startUrl: string | null;
  /** ISO timestamp of the last completed run, or null when never executed. */
  lastRun: string | null;
  stepCount: number;
  /**
   * The stored definition. These are the test's own steps: an `execute` step
   * names an imported module in `value` and is NOT expanded here, unlike the
   * steps inside a run result.
   */
  steps: Array<Record<string, unknown>>;
}

/** The 1970 sentinel Ghost Inspector uses for "never executed". */
function lastRunOf(test: TestRecord): string | null {
  const stamp = test.dateExecutionFinished ?? test.dateExecutionTriggered;
  if (stamp === undefined || stamp === null) return null;
  const parsed = Date.parse(String(stamp));
  return Number.isNaN(parsed) || parsed <= 0 ? null : String(stamp);
}

function suiteOf(test: TestRecord): { id: string; name: string } | null {
  const suite = test["suite"];
  if (typeof suite === "string") return { id: suite, name: "" };
  if (suite && typeof suite === "object") {
    const record = suite as Record<string, unknown>;
    return { id: String(record["_id"] ?? ""), name: String(record["name"] ?? "") };
  }
  return null;
}

/**
 * Normalises a raw test record into the shape a caller can edit against.
 *
 * Kept separate from the fetch so the sentinel and shape decisions can be
 * exercised with fixtures: a `passing` that is not a boolean reads as no
 * verdict, and a 1970 date reads as never executed.
 *
 * @param test A record from `GET /tests/{id}/`.
 * @param fallbackId Used when the record carries no `_id`.
 */
export function toDetail(test: TestRecord, fallbackId = ""): TestDetail {
  const steps = Array.isArray(test.steps) ? test.steps : [];
  return {
    id: String(test._id ?? fallbackId),
    name: String(test.name ?? ""),
    suite: suiteOf(test),
    dateUpdated: String(test.dateUpdated ?? ""),
    importOnly: test.importOnly === true,
    passing: typeof test.passing === "boolean" ? test.passing : null,
    startUrl: test["startUrl"] === undefined ? null : String(test["startUrl"]),
    lastRun: lastRunOf(test),
    stepCount: steps.length,
    steps,
  };
}

export interface ExpandedDetail extends TestDetail {
  /** Every step that would run, modules inlined, each with its owner and inherited condition. */
  expanded: Array<{
    command: string;
    target: string;
    value: string;
    condition: string | null;
    ownerId: string;
    ownerName: string;
    indexInOwner: number;
    rootIndex: number;
  }>;
  expansion: { modules: string[]; depth: number; truncated: boolean; emptyExecutes: number };
}

/**
 * Reads one test, the shape an edit is composed against, optionally with its modules inlined.
 *
 * @param testId The test.
 * @param options `expandModules` adds `expanded`: what a run executes, step by step.
 * @return The test's own definition and its concurrency token.
 * @throws {GhostInspectorError} when the test does not exist or a call fails.
 */
export async function getTest(
  testId: string,
  options: { expandModules?: boolean | undefined } = {},
): Promise<TestDetail | ExpandedDetail> {
  const record = await request<TestRecord>("GET", `tests/${testId}`);
  const detail = toDetail(record, testId);
  if (options.expandModules !== true) return detail;
  const expansion = await expandSteps(
    detail.steps as Steps,
    async (id) => {
      const module = await request<TestRecord>("GET", `tests/${id}`);
      return { name: String(module.name ?? id), steps: (module.steps ?? []) as Steps };
    },
    { id: detail.id, name: detail.name },
  );
  return {
    ...detail,
    expanded: expansion.steps.map((step) => ({
      command: step.command,
      target: step.target,
      value: step.value,
      condition: step.condition,
      ownerId: step.ownerId,
      ownerName: step.ownerName,
      indexInOwner: step.indexInOwner,
      rootIndex: step.rootIndex,
    })),
    expansion: {
      modules: expansion.modules,
      depth: expansion.depth,
      truncated: expansion.truncated,
      emptyExecutes: expansion.emptyExecutes,
    },
  };
}

/**
 * Reads several ids at bounded concurrency; a failure is recorded on its own id and never sinks the rest.
 *
 * @param ids The ids to read, in the order results are wanted.
 * @param read Reads one id.
 * @return One entry per id: its result, or its error message.
 */
export async function readBatch<T>(
  ids: string[],
  read: (id: string) => Promise<T>,
): Promise<Array<{ id: string; result?: T; error?: string }>> {
  return pool(ids, REQUEST_CONCURRENCY, async (id) => {
    try {
      return { id, result: await read(id) };
    } catch (error) {
      return { id, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
