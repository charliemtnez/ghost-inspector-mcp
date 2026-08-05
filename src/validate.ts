/**
 * Validate a test definition without saving it and without submitting anything.
 *
 * `POST /organizations/{id}/on-demand/execute` runs a definition and discards
 * it, so nothing in the account changes. But it drives a real browser against a
 * real URL, and plenty of Ghost Inspector suites submit live forms against
 * production — so "nothing is saved" is not the same as "nothing happens".
 *
 * Two guards make that safe, and neither is optional:
 *
 * 1. **Modules are expanded before anything is inspected.** A test whose steps
 *    are just `execute` calls hides its submit click inside a module. Guarding
 *    the definition as written would see no submit and let the run post a real
 *    lead. Expanding first means the guard sees every step that would actually
 *    run, and it makes the definition self-contained.
 * 2. **The run is truncated at the first step that could submit**, which is
 *    replaced by an assertion on that same target. That is the documented
 *    pattern: the whole selector chain gets verified, including that the submit
 *    control is reachable, without ever activating it.
 *
 * There is deliberately no way to ask this tool to submit. Anyone who genuinely
 * wants to post a real lead can do it with a deliberate `curl`.
 */

import {
  pollResult,
  request,
  type RunResult,
  type SuiteRecord,
  type TestRecord,
} from "./client.js";
import { requireOrgId } from "./config.js";
import { DOCUMENTED_MAX_DEPTH, executedIds, type Steps } from "./graph.js";

/**
 * Targets that look like a form submission. Heuristic on purpose, and biased
 * toward false positives: wrongly stopping early costs a truncated validation
 * that says so, while missing one posts a real lead to production.
 */
const SUBMIT_TARGET = /type\s*=\s*["']?submit|\bsubmit\b|\bbtn-send\b/i;

/** Script bodies that can activate a control without a click step. */
const SUBMIT_SCRIPT = /\.submit\s*\(|requestSubmit\s*\(|\.click\s*\(/i;

/** Key values that submit a focused form. */
const SUBMIT_KEY = /^(enter|return|\\n|\\r|13)$/i;

export interface ExpandedStep {
  command: string;
  target: string;
  value: string;
  variableName: string;
  condition: string | null;
  optional: boolean;
  /** Name of the module this step was inlined from, when it was. */
  fromModule: string | null;
}

interface Loaded {
  name: string;
  steps: Steps;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Flattens a step list, inlining every `execute` chain it references. */
async function expand(
  steps: Steps,
  load: (id: string) => Promise<Loaded>,
  depth: number,
  path: Set<string>,
  from: string | null,
  report: { modules: string[]; depth: number; truncated: boolean },
): Promise<ExpandedStep[]> {
  const out: ExpandedStep[] = [];
  report.depth = Math.max(report.depth, depth);

  for (const step of steps) {
    const command = str(step["command"]);
    if (command !== "execute") {
      const target = step["target"];
      out.push({
        command,
        // A target may be an array of fallback selectors, tried in order.
        target: Array.isArray(target) ? JSON.stringify(target) : str(target),
        value: str(step["value"]),
        variableName: str(step["variableName"]),
        condition: typeof step["condition"] === "string" ? step["condition"] : null,
        optional: step["optional"] === true,
        fromModule: from,
      });
      continue;
    }

    const id = str(step["value"]);
    if (!id) continue;
    if (path.has(id)) {
      // A cycle cannot resolve. Recording it beats expanding forever.
      report.truncated = true;
      continue;
    }
    if (depth >= DOCUMENTED_MAX_DEPTH) {
      report.truncated = true;
      continue;
    }

    const module = await load(id);
    if (!report.modules.includes(module.name)) report.modules.push(module.name);
    out.push(
      ...(await expand(module.steps, load, depth + 1, new Set([...path, id]), module.name, report)),
    );
  }
  return out;
}

export interface Guard {
  /** Zero-based index of the step the run stopped at. */
  stoppedAt: number;
  /** Why that step was treated as a submission. */
  reason: string;
  /** Steps dropped, including the submitting one. */
  droppedSteps: number;
  /** Target the appended assertion checks, when the step had one. */
  assertedTarget: string | null;
}

/**
 * Finds the first step that could submit a form.
 *
 * @param steps Fully expanded steps.
 * @returns Index and reason, or `null` when nothing looks like a submission.
 */
export function findSubmit(steps: ExpandedStep[]): { index: number; reason: string } | null {
  for (const [index, step] of steps.entries()) {
    if (step.command === "click" && SUBMIT_TARGET.test(step.target)) {
      return { index, reason: `click on a submit-shaped target: ${step.target}` };
    }
    if (step.command === "keypress" && SUBMIT_KEY.test(step.value.trim())) {
      return { index, reason: `keypress of ${step.value.trim()}, which submits a focused form` };
    }
    if (
      (step.command === "eval" || step.command === "assertEval") &&
      SUBMIT_SCRIPT.test(step.value)
    ) {
      return { index, reason: `${step.command} whose script can activate a control` };
    }
  }
  return null;
}

/**
 * Truncates at the first submitting step and asserts that step's target instead.
 *
 * @param steps Fully expanded steps.
 * @returns The steps that will run, and what was held back.
 */
export function applyGuard(steps: ExpandedStep[]): { steps: ExpandedStep[]; guard: Guard | null } {
  const hit = findSubmit(steps);
  if (!hit) return { steps, guard: null };

  const kept = steps.slice(0, hit.index);
  const submitting = steps[hit.index];
  const target = submitting?.target ?? "";

  // Proving the submit control is reachable is the point of the whole run, so
  // the dropped step becomes an assertion rather than simply disappearing.
  if (target) {
    kept.push({
      command: "assertElementVisible",
      target,
      value: "",
      variableName: "",
      condition: null,
      optional: false,
      fromModule: submitting?.fromModule ?? null,
    });
  }

  return {
    steps: kept,
    guard: {
      stoppedAt: hit.index,
      reason: hit.reason,
      droppedSteps: steps.length - hit.index,
      assertedTarget: target || null,
    },
  };
}

export interface StepOutcome {
  sequence: number;
  command: string;
  target: string;
  status: "passed" | "failed" | "not reached";
  error?: string;
  fromModule?: string;
}

export interface PlannedStep {
  sequence: number;
  command: string;
  target: string;
  fromModule?: string;
}

export interface ValidationReport {
  ranAs: {
    name: string;
    startUrl: string;
    viewport: string | null;
    browser: string | null;
    /** Where viewport and browser came from. Getting this wrong hides bugs. */
    configSource: string;
  };
  expansion: {
    definedSteps: number;
    expandedSteps: number;
    modulesInlined: string[];
    depth: number;
    depthTruncated: boolean;
  };
  guard: Guard | null;
  /** Exactly what would run, or did. Readable without executing anything. */
  plan: PlannedStep[];
  /** False for a dry run: nothing was sent to Ghost Inspector. */
  executed: boolean;
  outcome: {
    passing: boolean | null;
    executionTimeMs: number | null;
    endUrl: string | null;
    stepsPassed: number;
    stepsFailed: number;
    stepsNotReached: number;
  } | null;
  firstFailure: StepOutcome | null;
  steps: StepOutcome[];
  consoleErrors: string[];
  notes: string[];
}

export interface ValidateOptions {
  /** Existing test to validate. Its suite's viewport and browser are replicated. */
  testId?: string | undefined;
  /** Ad-hoc definition instead of an existing test. */
  definition?:
    | { name?: string | undefined; startUrl: string; steps: Steps }
    | undefined;
  /** Override, e.g. "1280x800". Defaults to the suite's for an existing test. */
  viewport?: string | undefined;
  /** Override, e.g. "chrome". Defaults to the suite's for an existing test. */
  browser?: string | undefined;
  /**
   * Report what would run and stop. Nothing is sent to Ghost Inspector, so no
   * browser starts and no page is loaded — the only way to inspect the guard's
   * decision at zero risk. Needs no organization id.
   */
  dryRun?: boolean | undefined;
}

function outcomes(resultSteps: Array<Record<string, unknown>>, sent: ExpandedStep[]): StepOutcome[] {
  return resultSteps.map((step, index) => {
    const passing = step["passing"];
    const error = str(step["error"]);
    const from = sent[index]?.fromModule;
    const outcome: StepOutcome = {
      sequence: index,
      command: str(step["command"]),
      target: str(step["target"]),
      status: passing === true ? "passed" : passing === false ? "failed" : "not reached",
    };
    if (error) outcome.error = error;
    if (from) outcome.fromModule = from;
    return outcome;
  });
}

/**
 * Runs a definition through on-demand execution and reports each step.
 *
 * @param options Exactly one of `testId` or `definition`.
 * @returns Per-step outcomes, what the guard held back, and the config used.
 * @throws {ConfigError} when the API key or organization id is not configured.
 * @throws {GhostInspectorError} on an API failure.
 * @throws {RunTimeoutError} when the run does not finish inside the window.
 */
export async function validateTest(options: ValidateOptions): Promise<ValidationReport> {
  if ((options.testId && options.definition) || (!options.testId && !options.definition)) {
    throw new Error(
      "Pass exactly one of testId (validate an existing test) or definition (validate an ad-hoc definition).",
    );
  }
  const cache = new Map<string, Loaded>();
  const load = async (id: string): Promise<Loaded> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const test = await request<TestRecord>("GET", `tests/${id}`);
    const entry: Loaded = { name: test.name ?? id, steps: (test.steps ?? []) as Steps };
    cache.set(id, entry);
    return entry;
  };

  let name: string;
  let startUrl: string;
  let defined: Steps;
  let viewport = options.viewport ?? null;
  let browser = options.browser ?? null;
  let configSource: string;

  if (options.testId) {
    const test = await request<TestRecord>("GET", `tests/${options.testId}`);
    name = test.name ?? "(unnamed)";
    startUrl = str(test["startUrl"]);
    defined = (test.steps ?? []) as Steps;

    // No test in a real account was found carrying its own viewport or browser
    // — they inherit from the suite. Reading only the test would validate at
    // whatever the default is, and a selector can resolve on desktop and not on
    // mobile, which is the failure this replication exists to avoid.
    const explicit = options.viewport !== undefined || options.browser !== undefined;
    const suiteId =
      test.suite && typeof test.suite === "object" ? str((test.suite as { _id?: string })._id) : "";
    if (!explicit && suiteId) {
      const suite = await request<SuiteRecord & Record<string, unknown>>("GET", `suites/${suiteId}`);
      const size = suite["viewportSize"];
      if (!viewport && size && typeof size === "object") {
        const { width, height } = size as { width?: number; height?: number };
        if (width && height) viewport = `${width}x${height}`;
      }
      if (!browser) browser = str(suite["browser"]) || null;
      configSource = viewport || browser ? "suite" : "Ghost Inspector defaults";
    } else {
      configSource = explicit ? "caller override" : "Ghost Inspector defaults";
    }
  } else {
    const def = options.definition as { name?: string; startUrl: string; steps: Steps };
    name = def.name ?? "ad-hoc definition";
    startUrl = def.startUrl;
    defined = def.steps;
    configSource = viewport || browser ? "caller override" : "Ghost Inspector defaults";
  }

  const expansion = { modules: [] as string[], depth: 0, truncated: false };
  const expanded = await expand(defined, load, 0, new Set(), null, expansion);
  const { steps: toRun, guard } = applyGuard(expanded);

  const plan: PlannedStep[] = toRun.map((s, sequence) => {
    const entry: PlannedStep = { sequence, command: s.command, target: s.target };
    if (s.fromModule) entry.fromModule = s.fromModule;
    return entry;
  });

  const shared = {
    ranAs: { name, startUrl, viewport, browser, configSource },
    expansion: {
      definedSteps: defined.length,
      expandedSteps: expanded.length,
      modulesInlined: expansion.modules,
      depth: expansion.depth,
      depthTruncated: expansion.truncated,
    },
    guard,
    plan,
  };

  const guardNotes = (): string[] => {
    const notes: string[] = [];
    if (guard) {
      notes.push(
        `🔴 The run stops before step ${guard.stoppedAt} (${guard.reason}) and ${guard.droppedSteps} step(s) are dropped, so no form is submitted.` +
          (guard.assertedTarget
            ? ` An assertElementVisible on \`${guard.assertedTarget}\` is appended instead, which proves the control is reachable without activating it.`
            : "") +
          " A green result does not prove the steps after the submission work.",
      );
    } else {
      notes.push(
        "No step looks like a form submission, so the definition runs to the end. The detection is a heuristic over click targets, Enter keypresses and script bodies — if this test submits by some other means, a real submission can happen.",
      );
    }
    if (expansion.modules.length > 0) {
      notes.push(
        `${expansion.modules.length} module(s) were inlined before guarding, ${expansion.depth} level(s) deep. Guarding the definition as written would have missed a submit hidden inside a module.`,
      );
    }
    if (expansion.truncated) {
      notes.push(
        "A module chain hit the documented 10-level limit or looped, so part of it was not inlined and could not be guarded. Treat this as incomplete.",
      );
    }
    if (expanded.length === 0) {
      notes.push(
        "🔴 This definition executes NO steps: its chain bottoms out in empty modules. A run would pass because nothing can fail, while asserting nothing at all.",
      );
    }
    if (configSource === "Ghost Inspector defaults") {
      notes.push(
        "⚠️ Would run at Ghost Inspector's default viewport and browser, not the suite's. A selector can resolve on desktop and fail on mobile.",
      );
    }
    return notes;
  };

  if (options.dryRun) {
    return {
      ...shared,
      executed: false,
      outcome: null,
      firstFailure: null,
      steps: [],
      consoleErrors: [],
      notes: [
        "DRY RUN: nothing was sent to Ghost Inspector. No browser started, no page loaded, no request left this machine beyond reading the definitions.",
        ...guardNotes(),
        "`plan` is exactly what a real run would execute, in order.",
      ],
    };
  }

  const orgId = requireOrgId();
  const body = {
    name: `[validation] ${name}`,
    startUrl,
    steps: toRun.map((s) => ({
      command: s.command,
      target: s.target,
      value: s.value,
      ...(s.variableName ? { variableName: s.variableName } : {}),
      ...(s.condition ? { condition: s.condition } : {}),
      ...(s.optional ? { optional: true } : {}),
    })),
  };

  const params: Record<string, string> = {};
  if (viewport) params["viewport"] = viewport;
  if (browser) params["browser"] = browser;

  const pending = await request<RunResult>("POST", `organizations/${orgId}/on-demand/execute`, {
    body,
    params,
    timeoutMs: 60_000,
  });
  // The POST answers in ~0.2s with passing: null. Reading that as a failure
  // would invent one; a browser run has been observed taking 99s.
  const result = await pollResult(pending._id, { timeoutMs: 300_000, intervalMs: 5_000 });

  const stepOutcomes = outcomes(result.steps ?? [], toRun);
  const consoleErrors = Array.isArray(result["console"])
    ? (result["console"] as Array<Record<string, unknown>>)
        .filter((c) => /error|severe/i.test(str(c["level"]) || str(c["type"])))
        .map((c) => str(c["message"]).slice(0, 300))
        .filter(Boolean)
    : [];

  const notes: string[] = [
    "Nothing was saved: on-demand execution runs a definition and discards it. The test in the account is untouched.",
    ...guardNotes(),
  ];

  return {
    ...shared,
    executed: true,
    outcome: {
      passing: result.passing,
      executionTimeMs: result.executionTime ?? null,
      endUrl: result.endUrl ?? null,
      stepsPassed: stepOutcomes.filter((s) => s.status === "passed").length,
      stepsFailed: stepOutcomes.filter((s) => s.status === "failed").length,
      stepsNotReached: stepOutcomes.filter((s) => s.status === "not reached").length,
    },
    firstFailure: stepOutcomes.find((s) => s.status === "failed") ?? null,
    steps: stepOutcomes,
    consoleErrors,
    notes,
  };
}
