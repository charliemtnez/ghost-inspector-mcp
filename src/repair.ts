/**
 * Proposing a repair, without applying one.
 *
 * The last gap in the cycle: diagnose → propose → validate → apply. Diagnosis
 * and application already exist, and validation runs a definition without
 * saving it. What was missing is the step in between, and the reason it is
 * worth a tool rather than left to the model is that **this server cannot see
 * the page**. It has the definition, the error and the contract. Anything
 * beyond that would be a guess dressed as a recommendation.
 *
 * So proposals come in two kinds and are never mixed:
 *
 *   - **applicable** — a concrete rewritten step, derived from a rule that is
 *     true of Ghost Inspector regardless of the page. `assertTextPresent` with
 *     no target always fails; `eval` without an explicit `return` is always
 *     undefined. These can be handed straight to gi_update_test.
 *   - **advisory** — something is wrong with the step that cannot be fixed
 *     without looking at the DOM. Named, explained, and left alone.
 *
 * Nothing here writes. The output is an argument, and the caller still has to
 * validate it and apply it through the guarded write path.
 */

import { diagnoseTest, type Diagnosis } from "./diagnose.js";
import { getTest, type TestDetail } from "./detail.js";
import { type Steps } from "./graph.js";

/** Selector shapes that work until the DOM moves, then fail opaquely. */
const FRAGILE = [
  { pattern: /:nth-(of-type|child)\b/i, why: "positional selector: it breaks the moment the DOM reorders, and the failure does not point at the cause" },
  { pattern: /^xpath=.*(text\(\)|contains\()/i, why: "XPath matching visible copy: a wording change breaks the test and the error blames the element, not the copy" },
  { pattern: /(\.[\w-]+\s*){4,}/, why: "long chain of presentational classes: styling changes silently break it" },
];

export interface Proposal {
  kind: "applicable" | "advisory";
  rule: string;
  rationale: string;
  /** Index in the owning test's own step list. */
  sequence: number | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface RepairPlan {
  proposable: boolean;
  refusedBecause?: string;
  /** The test that owns the failing step — the one an edit must target. */
  editTarget: { testId: string; name: string; isModule: boolean } | null;
  /** Pass to gi_update_test as expectedDateUpdated. Null when nothing to edit. */
  expectedDateUpdated: string | null;
  diagnosis: Diagnosis;
  proposals: Proposal[];
  /** Full step list with every applicable proposal applied. Null when none are. */
  proposedSteps: Steps | null;
  nextSteps: string[];
}

/** Whether a JavaScript step body can ever produce a value. */
export function missingReturn(command: string, value: string): boolean {
  if (!/^(eval|assertEval)$/i.test(command)) return false;
  return !/\breturn\b/.test(value);
}

/**
 * Rules that hold whatever the page contains.
 *
 * Each one encodes a Ghost Inspector behaviour that makes a step fail in a way
 * that blames the wrong thing — the page rather than the step. They are
 * deliberately few: a rule that needs the DOM to be correct does not belong
 * here, it belongs in the advisory list.
 *
 * @param step The failing step, as stored in its owning test.
 * @param sequence Its index in that test.
 * @returns Proposals, applicable ones carrying a rewritten step.
 */
export function proposeForStep(step: Record<string, unknown>, sequence: number | null): Proposal[] {
  const out: Proposal[] = [];
  const command = String(step["command"] ?? "");
  const value = String(step["value"] ?? "");
  const target = step["target"];
  const targetText = typeof target === "string" ? target : "";

  // Verified live: with an empty target this fails as "Text not contained"
  // even when the text is plainly on the page, so the error blames the page.
  if (/^assertText(Present|NotPresent)$/i.test(command) && targetText.trim() === "") {
    out.push({
      kind: "applicable",
      rule: "assertTextPresent requires a target",
      rationale:
        "With an empty target this always fails as \"Text not contained\", even when the text is on the page — so the error points at the content rather than at the step. Scoping to `body` at minimum makes it evaluate for real.",
      sequence,
      before: { ...step },
      after: { ...step, target: "body" },
    });
  }

  // eval and assertEval need an explicit return; without one the expression is
  // undefined, which is falsy, so the assertion always fails and reads as a bug.
  if (missingReturn(command, value)) {
    out.push({
      kind: "applicable",
      rule: "eval and assertEval need an explicit return",
      rationale:
        "Without `return` the body evaluates to undefined, which is falsy, so the assertion can never pass and the failure looks like a product bug. Returning the last expression is almost always what was meant — check that it is here.",
      sequence,
      before: { ...step },
      after: { ...step, value: `return (${value.trim().replace(/;$/, "")});` },
    });
  }

  for (const { pattern, why } of FRAGILE) {
    if (pattern.test(targetText)) {
      out.push({
        kind: "advisory",
        rule: "fragile selector",
        rationale: `${why}. Re-anchor it to a stable attribute (data-*, name, id) scoped to a container id. This server cannot see the page, so it will not invent the replacement.`,
        sequence,
      });
    }
  }

  if (Array.isArray(target) && target.length === 1) {
    out.push({
      kind: "advisory",
      rule: "single-entry fallback array",
      rationale:
        "The target is an array with one selector, so it reads as if it has fallbacks and has none. Either add a genuine fallback or make it a plain string, so the next reader is not misled.",
      sequence,
    });
  }

  return out;
}

/**
 * Builds a repair argument for a failing test, applying nothing.
 *
 * Refuses on a stale diagnosis rather than proposing from it: a failure that
 * predates a change describes a definition no longer stored, so any repair
 * derived from it is derived from nothing and would overwrite whatever
 * replaced it.
 *
 * @param testId The failing test.
 * @returns The proposals, the steps with applicable ones applied, and the token.
 * @throws {GhostInspectorError} when the test does not exist or a call fails.
 */
export async function proposeRepair(testId: string): Promise<RepairPlan> {
  const diagnosis = await diagnoseTest({ testId });

  const bail = (why: string, notes: string[]): RepairPlan => ({
    proposable: false,
    refusedBecause: why,
    editTarget: null,
    expectedDateUpdated: null,
    diagnosis,
    proposals: [],
    proposedSteps: null,
    nextSteps: notes,
  });

  if (diagnosis.verdict === "stale") {
    return bail("the diagnosis is stale", [
      "🔴 Nothing is proposed from a stale result. The failure describes a definition that is no longer stored, so a repair built on it would overwrite whatever replaced it — and there is no version history.",
      "Run the test with gi_run_test to get a fresh result, then ask again.",
    ]);
  }
  if (diagnosis.verdict !== "diagnosable") {
    return bail(`nothing to repair: the verdict is "${diagnosis.verdict}"`, [
      "A repair needs a failing step from a finished, current run. See the diagnosis for what state this test is actually in.",
    ]);
  }
  if (!diagnosis.failingStep) {
    return bail("the run is red but no step failed", [
      "The failure happened outside the steps — a start URL that would not load, or a browser-level error. There is no step to rewrite; read endUrl and the run record.",
    ]);
  }

  const owner = diagnosis.failingStep.ownedBy;
  if (!owner) {
    return bail("the failing step names no owning test", [
      "Without extra.source there is no way to know which test's steps to edit, and editing the wrong one is worse than editing nothing.",
    ]);
  }

  if (diagnosis.failingStep.mapping === "unmapped") {
    return bail("the failing step could not be located in its test", [
      "Proposing an edit to a step that cannot be identified would rewrite whichever step the guess lands on. See the diagnosis notes for why the mapping failed.",
    ]);
  }

  // Always the owner, never the test that was asked about: results expand
  // imported modules inline, so the step frequently belongs to a module.
  const definition: TestDetail = await getTest(owner.testId);
  const sequence = owner.sequenceInOwner;
  const step = sequence !== null ? definition.steps[sequence] : undefined;
  if (!step) {
    return bail("the failing step is no longer at that position in its test", [
      "The definition changed since the run, or the step was removed. Re-run the test and diagnose again.",
    ]);
  }

  const proposals = proposeForStep(step, sequence);
  const applicable = proposals.filter((p) => p.kind === "applicable");
  const proposedSteps =
    applicable.length > 0
      ? definition.steps.map((s, i) =>
          i === sequence ? (applicable[applicable.length - 1]?.after ?? s) : s,
        )
      : null;

  const nextSteps: string[] = [];
  if (applicable.length > 0) {
    nextSteps.push(
      "1. Validate `proposedSteps` with gi_validate_test BEFORE writing. It runs them without saving and stops before any submit.",
      `2. If it passes, apply with gi_update_test on test ${owner.testId}, passing expectedDateUpdated exactly as returned here.`,
      "3. Confirm with gi_run_test, which needs its own opt-in.",
    );
  } else {
    nextSteps.push(
      "No rewrite is proposed. Every rule this server can apply without seeing the page came back clean, so the cause is in the page or in a selector that needs a human to look at the DOM.",
      "gi_validate_test with dryRun shows the fully inlined run, which is usually the fastest way to see what the step is actually pointed at.",
    );
  }
  if (owner.isModule) {
    nextSteps.push(
      `⚠️ ${owner.name} is a module. Editing it changes every test that imports it — run gi_module_usage first to see the blast radius.`,
    );
  }
  if (applicable.length > 1) {
    nextSteps.push(
      `⚠️ ${applicable.length} applicable rules matched this step and proposedSteps carries only the last. Apply them one at a time, validating between.`,
    );
  }

  return {
    proposable: true,
    editTarget: { testId: owner.testId, name: owner.name, isModule: owner.isModule },
    expectedDateUpdated: definition.dateUpdated,
    diagnosis,
    proposals,
    proposedSteps,
    nextSteps,
  };
}
