/**
 * Tests that pass while proving nothing.
 *
 * Green is the dangerous colour. A red test gets investigated; a green one that
 * verifies nothing sits there indefinitely, and every dashboard, report and
 * standup says the coverage is fine.
 *
 * Three distinct classes, and conflating them hides two of them:
 *
 *   1. **Executes no steps.** Its definition is only `execute` calls and the
 *      chain bottoms out in empty modules. Already reported by
 *      `gi_module_usage`; repeated here so one tool answers the whole question.
 *   2. **Executes steps but asserts nothing.** It can only fail if a step
 *      errors, so it verifies that the page did not explode, and nothing else.
 *      Purely static, and on a real account this was the most common of the
 *      three by a wide margin — 23 of 60 sampled tests.
 *   3. **Asserts something that was already true before the action.** Every
 *      step runs, the assertion passes, and it would pass with the feature
 *      completely broken. 🔴 **Not detectable from the definition**: the target
 *      is simply present on the starting page and no earlier step mentions it.
 *      A static scan for "the final assertion's target appears earlier" finds
 *      zero of them — measured. Catching it needs a run, so this tool reports
 *      the candidates most worth checking rather than pretending to decide.
 */

import { isModule, request, type TestRecord } from "./client.js";
import { buildEdges, fetchDefinitions, fetchDefinitionsClosure, walk, type Steps } from "./graph.js";
import { scopeFor, scopeNote, type ScopeFilter } from "./scope.js";

/** Commands that can make a test fail on purpose rather than by accident. */
const ASSERTION = /^assert/i;

/** Listed per bucket before switching to a count. */
const CAP = 25;

export interface VacuousFinding {
  id: string;
  name: string;
  suite: string;
  /** Steps that actually execute, after modules are inlined. */
  executedSteps: number;
  /** True while the test is green, which is what makes it worth reporting. */
  currentlyPassing: boolean;
}

export interface SuspectFinding extends VacuousFinding {
  /** The last assertion's target — what a run would have to disprove. */
  finalAssertionTarget: string;
  finalAssertionCommand: string;
}

export interface VacuityReport {
  scanned: { tests: number; modulesExcluded: number; unreadable: number };
  totals: { executesNothing: number; assertsNothing: number; worthChecking: number };
  notes: string[];
  /** Class 1: nothing runs, so nothing can fail. */
  executesNothing: VacuousFinding[];
  executesNothingOmitted: number;
  /** Class 2: steps run, but no assertion exists anywhere in the chain. */
  assertsNothing: VacuousFinding[];
  assertsNothingOmitted: number;
  /** Class 3 candidates. Static analysis cannot confirm these — a run can. */
  worthChecking: SuspectFinding[];
  worthCheckingOmitted: number;
}

function targetText(step: Record<string, unknown> | undefined): string {
  const target = step?.["target"];
  if (typeof target === "string") return target;
  if (Array.isArray(target) && target.length > 0) {
    const first = target[0];
    return typeof first === "string" ? first : String((first as Record<string, unknown>)?.["selector"] ?? "");
  }
  return "";
}

/**
 * Flattens a test's chain into the steps that really execute.
 *
 * Uses the already-fetched definitions rather than re-expanding over the
 * network: the graph walk gives the reachable test ids, and their steps are in
 * hand. Conditions are irrelevant here — a step that might be skipped is still
 * a step that could assert.
 */
function executedSteps(testId: string, steps: Map<string, Steps>, forward: Map<string, string[]>): Steps {
  const chain = walk(testId, forward);
  const out: Steps = [];
  for (const id of [testId, ...chain.ids]) {
    for (const step of steps.get(id) ?? []) {
      if (String(step["command"] ?? "") !== "execute") out.push(step);
    }
  }
  return out;
}

/**
 * Splits the account into the three ways a green test can mean nothing.
 *
 * Pure: takes fetched data, so it runs against fixtures with no network.
 *
 * 🔴 Modules are excluded before anything is counted. Import-only deletes a
 * test's results, so every module looks unrun and unasserted — including them
 * would report the entire shared layer as worthless and aim a cleanup at the
 * steps every live test depends on.
 *
 * @param tests Every test record, from `GET /tests/`.
 * @param steps Per-test steps, keyed by test id.
 * @param unreadable Definitions that could not be fetched.
 */
export function buildVacuityReport(
  tests: TestRecord[],
  steps: Map<string, Steps>,
  unreadable = 0,
  only?: ReadonlySet<string>,
): VacuityReport {
  const { forward } = buildEdges(tests, steps);
  const executesNothing: VacuousFinding[] = [];
  const assertsNothing: VacuousFinding[] = [];
  const worthChecking: SuspectFinding[] = [];
  let modulesExcluded = 0;

  for (const test of tests) {
    if (only && !only.has(test._id)) continue;
    if (isModule(test)) {
      modulesExcluded += 1;
      continue;
    }
    // A definition that could not be read is not evidence of emptiness. It is
    // counted in `unreadable`; guessing "no steps" would invent a finding.
    if (!steps.has(test._id)) continue;

    const flat = executedSteps(test._id, steps, forward);
    const common: VacuousFinding = {
      id: test._id,
      name: test.name ?? "(unnamed)",
      suite:
        test.suite && typeof test.suite === "object"
          ? ((test.suite as { name?: string }).name ?? "(unnamed suite)")
          : "(no suite)",
      executedSteps: flat.length,
      currentlyPassing: test.passing === true,
    };

    if (flat.length === 0) {
      executesNothing.push(common);
      continue;
    }

    const assertions = flat.filter((s) => ASSERTION.test(String(s["command"] ?? "")));
    if (assertions.length === 0) {
      assertsNothing.push(common);
      continue;
    }

    // Class 3 candidate: the only assertion is the last step. Nothing between
    // an action and that assertion narrows what it proves, so if its target
    // also exists on the starting page the test passes regardless. Static
    // analysis genuinely cannot tell — this is a shortlist, not a verdict.
    const last = flat[flat.length - 1];
    const lastIsOnlyAssertion = assertions.length === 1 && last === assertions[0];
    if (lastIsOnlyAssertion) {
      worthChecking.push({
        ...common,
        finalAssertionCommand: String(last?.["command"] ?? ""),
        finalAssertionTarget: targetText(last),
      });
    }
  }

  const byName = (a: VacuousFinding, b: VacuousFinding) => a.name.localeCompare(b.name);
  executesNothing.sort(byName);
  assertsNothing.sort(byName);
  worthChecking.sort(byName);

  const notes: string[] = [
    "Green is the dangerous colour here. Nothing in this report is red, and none of it will ever be investigated on its own.",
    "🔴 assertsNothing is the finding to act on first. Those tests run their steps and contain no assertion at all, so the only way they can fail is if a step errors — they verify that the page did not explode, and nothing more.",
    "worthChecking is a SHORTLIST, not a verdict. Their single assertion is the final step, so if its target also exists on the page the test starts from, the test passes with the feature completely broken. That cannot be decided from the definition: run the test with the decisive action removed and see whether the assertion still passes. If it does, the test proves nothing.",
    "Modules are excluded before counting. Import-only deletes a test's results, so every module reads as unrun and unasserted; including them would condemn the shared layer every live test depends on.",
  ];
  if (unreadable > 0) {
    notes.push(
      `${unreadable} definition(s) could not be read and were skipped rather than assumed empty — an unreadable test is not evidence of an empty one.`,
    );
  }

  return {
    scanned: { tests: only ? tests.filter((test) => only.has(test._id)).length : tests.length, modulesExcluded, unreadable },
    totals: {
      executesNothing: executesNothing.length,
      assertsNothing: assertsNothing.length,
      worthChecking: worthChecking.length,
    },
    notes,
    executesNothing: executesNothing.slice(0, CAP),
    executesNothingOmitted: Math.max(0, executesNothing.length - CAP),
    assertsNothing: assertsNothing.slice(0, CAP),
    assertsNothingOmitted: Math.max(0, assertsNothing.length - CAP),
    worthChecking: worthChecking.slice(0, CAP),
    worthCheckingOmitted: Math.max(0, worthChecking.length - CAP),
  };
}

/**
 * Fetches the account and reports every way a green test can mean nothing.
 *
 * Costs one request per test, like the other graph tools, because `steps` is
 * absent from the flat listing.
 *
 * @returns The three classes, with modules excluded before counting.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function getVacuousTests(filter: ScopeFilter = {}): Promise<VacuityReport> {
  const tests = await request<TestRecord[]>("GET", "tests");
  const scope = await scopeFor(filter, tests);
  const { steps, unreadable } = scope ? await fetchDefinitionsClosure([...scope.ids]) : await fetchDefinitions(tests);
  const report = buildVacuityReport(tests, steps, unreadable, scope?.ids);
  if (scope) report.notes.unshift(scopeNote(scope));
  return report;
}
