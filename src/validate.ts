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
import { logScript, probeScript, selectorsOf, stopCondition } from "./guard-script.js";
import { conditionStatement, DOCUMENTED_MAX_DEPTH, executedIds, type Steps } from "./graph.js";
import { EVAL_VALUE_NOTE, evidenceOf, executionTimeMs, type Evidence } from "./results.js";
import {
  collectVariables,
  resolveDefinition,
  type Resolution,
  type StoredVariable,
  type VariableValue,
} from "./variables.js";

/**
 * Targets that look like a form submission. Heuristic on purpose, and biased
 * toward false positives: wrongly stopping early costs a truncated validation
 * that says so, while missing one posts a real lead to production.
 */
const SUBMIT_TARGET = /type\s*=\s*["']?submit|\bsubmit\b|\bsend\b/i;

/** Script bodies that can activate a control or send data without a click step. */
const SUBMIT_SCRIPT =
  /\.submit\s*\(|requestSubmit\s*\(|\.click\s*\(|dispatchEvent\s*\(|\bfetch\s*\(|XMLHttpRequest|sendBeacon\s*\(|\$\.ajax\b|\$\.post\b|\baxios\b/i;

/** Commands whose `value` is a script the page runs. */
const SCRIPT_COMMANDS = new Set(["eval", "assertEval", "extractEval"]);

/** In run mode, a click target that names a control: after a field is filled, it may send the form. */
const CONTROL_TARGET = /button|input|\[type|form|role\s*=\s*["']?button/i;

/** Key values that submit a focused form. */
const SUBMIT_KEY = /^(enter|return|\\n|\\r|13)$/i;

export interface ExpandedStep {
  command: string;
  /** For reading and matching: a fallback array appears as its JSON. */
  target: string;
  /** The target exactly as authored, a string or a fallback array. This is what gets sent. */
  authoredTarget: string | Array<Record<string, unknown>>;
  value: string;
  variableName: string;
  condition: string | null;
  optional: boolean;
  /** Name of the module this step was inlined from, when it was. */
  fromModule: string | null;
  /** The test whose own step list holds this step: the root, or a module. */
  ownerId: string;
  ownerName: string;
  /** Position in the owner's array, execute steps counted; not its stored `sequence`. */
  indexInOwner: number;
  /** Index of the root-level step that contributed this one. */
  rootIndex: number;
}

export interface Loaded {
  name: string;
  steps: Steps;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Combines an inherited condition with a step's own, the way Ghost Inspector
 * does when it executes an import: AND-ed, accumulating at every level. Each
 * side is a script with an explicit `return` — the same contract as `eval` —
 * so each is wrapped in an IIFE to keep its `return` from ending the combined
 * script early.
 *
 * @param outer Condition accumulated from the enclosing `execute` steps.
 * @param inner The step's own condition.
 * @returns A script equivalent to `outer && inner`, or whichever side exists.
 */
export function andConditions(outer: string | null, inner: string | null): string | null {
  if (!outer) return inner;
  if (!inner) return outer;
  return `return (function () { ${outer} })() && (function () { ${inner} })();`;
}

export interface Expansion {
  steps: ExpandedStep[];
  /** Module names inlined, in first-encounter order. */
  modules: string[];
  depth: number;
  /** True when a chain hit the nesting limit or looped, so part is missing. */
  truncated: boolean;
  /** Execute steps naming no module id. They run nothing, and are counted rather than dropped in silence. */
  emptyExecutes: number;
}

/**
 * Flattens a step list, inlining every `execute` chain it references.
 *
 * A condition on an `execute` step is carried into every step it imports,
 * AND-ed with their own, because that is what Ghost Inspector does when the
 * real test runs. Dropping it would validate steps the real test skips.
 *
 * @param steps The definition as written.
 * @param load Reads one test's name and steps by id.
 * @returns The flattened steps and what the flattening had to do.
 */
export async function expandSteps(
  steps: Steps,
  load: (id: string) => Promise<Loaded>,
  root: { id: string; name: string } = { id: "", name: "" },
): Promise<Expansion> {
  const report = { modules: [] as string[], depth: 0, truncated: false, emptyExecutes: 0 };
  const expanded = await expand(steps, load, 0, new Set(), root, null, null, report);
  return { steps: expanded, ...report };
}

/**
 * One level of expandSteps: inlines this list's execute steps, recursively.
 *
 * @param steps The list being flattened.
 * @param load Reads one test's name and steps by id.
 * @param depth Nesting level of this list; 0 is the root.
 * @param path Module ids on the way here, for cycle detection.
 * @param owner The test this list belongs to.
 * @param rootIndex The root-level step being expanded, or null at the root itself.
 * @param inherited Condition accumulated from the enclosing execute steps.
 * @param report Counters shared across the whole expansion.
 * @return The flattened steps.
 */
async function expand(
  steps: Steps,
  load: (id: string) => Promise<Loaded>,
  depth: number,
  path: Set<string>,
  owner: { id: string; name: string },
  rootIndex: number | null,
  inherited: string | null,
  report: { modules: string[]; depth: number; truncated: boolean; emptyExecutes: number },
): Promise<ExpandedStep[]> {
  const out: ExpandedStep[] = [];
  report.depth = Math.max(report.depth, depth);

  for (const [index, step] of steps.entries()) {
    const command = str(step["command"]);
    const own = conditionStatement(step["condition"]);
    if (command !== "execute") {
      const target = step["target"];
      out.push({
        command,
        // A target may be an array of fallback selectors, tried in order.
        target: Array.isArray(target) ? JSON.stringify(target) : str(target),
        authoredTarget: Array.isArray(target) ? (target as Array<Record<string, unknown>>) : str(target),
        value: str(step["value"]),
        variableName: str(step["variableName"]),
        condition: andConditions(inherited, own),
        optional: step["optional"] === true,
        fromModule: depth > 0 ? owner.name : null,
        ownerId: owner.id,
        ownerName: owner.name,
        indexInOwner: index,
        rootIndex: rootIndex ?? index,
      });
      continue;
    }

    const id = str(step["value"]);
    if (!id) {
      // A broken step, not an ignorable one: it looks like an import and
      // imports nothing. Counted so the report can say so.
      report.emptyExecutes += 1;
      continue;
    }
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
      ...(await expand(
        module.steps,
        load,
        depth + 1,
        new Set([...path, id]),
        { id, name: module.name },
        rootIndex ?? index,
        andConditions(inherited, own),
        report,
      )),
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
 * @param mode `run` adds one rule for stored runs, which have no in-browser probe: a control clicked after an assign.
 * @returns Index and reason, or `null` when nothing looks like a submission.
 */
export function findSubmit(
  steps: ExpandedStep[],
  mode: "validate" | "run" = "validate",
): { index: number; reason: string } | null {
  let filled = false;
  for (const [index, step] of steps.entries()) {
    if (step.condition && SUBMIT_SCRIPT.test(step.condition)) {
      return { index, reason: `a condition whose script can activate a control or send data, on ${step.command}` };
    }
    if (step.command === "click" && SUBMIT_TARGET.test(step.target)) {
      return { index, reason: `click on a submit-shaped target: ${step.target}` };
    }
    if (step.command === "keypress" && SUBMIT_KEY.test(step.value.trim())) {
      return { index, reason: `keypress of ${step.value.trim()}, which submits a focused form` };
    }
    if (SCRIPT_COMMANDS.has(step.command) && SUBMIT_SCRIPT.test(step.value)) {
      return { index, reason: `${step.command} whose script can activate a control or send data` };
    }
    if (mode === "run" && filled && step.command === "click" && CONTROL_TARGET.test(step.target)) {
      return { index, reason: `click on a control after a field was filled: ${step.target}` };
    }
    if (step.command === "assign") filled = true;
  }
  return null;
}

/**
 * Truncates at the first submitting step, or earlier at `stopBefore`, and asserts that step's target instead.
 *
 * @param steps Fully expanded steps.
 * @param options `stopBefore`: a plan index to stop at. It can only move the cut earlier.
 * @returns The steps that will run, what was held back, and a note when stopBefore was ignored.
 */
export function applyGuard(
  steps: ExpandedStep[],
  options: { stopBefore?: number | undefined } = {},
): { steps: ExpandedStep[]; guard: Guard | null; notes: string[] } {
  const found = findSubmit(steps);
  const notes: string[] = [];
  const requested = options.stopBefore;
  let hit = found;
  if (requested !== undefined && requested >= 0 && requested < steps.length) {
    if (!found || requested < found.index) {
      hit = { index: requested, reason: `stopBefore ${requested}, requested by the caller` };
    } else if (requested > found.index) {
      notes.push(
        `stopBefore ${requested} was ignored: the guard already stops at step ${found.index}, and stopBefore can only stop earlier.`,
      );
    }
  }
  if (!hit) return { steps, guard: null, notes };

  const kept = steps.slice(0, hit.index);
  const submitting = steps[hit.index];
  const target = submitting?.target ?? "";

  // Proving the submit control is reachable is the point of the whole run, so
  // the dropped step becomes an assertion rather than simply disappearing.
  if (submitting && target) {
    kept.push({
      ...submitting,
      command: "assertElementVisible",
      value: "",
      variableName: "",
      condition: null,
      optional: false,
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
    notes,
  };
}

/** What a sent step is: a plan step, or one the guard injected around a click. */
export interface SentStep {
  planIndex: number;
  kind: "step" | "wait" | "probe" | "log";
}

/**
 * Layers B and C: before every click, a wait on its target and a probe that can stop the run; every step gated on that stop.
 *
 * @param plan The steps to run, static guard already applied.
 * @return The steps to send, and what each sent step is in plan terms.
 */
export function injectGuards(plan: ExpandedStep[]): { sent: ExpandedStep[]; map: SentStep[] } {
  const sent: ExpandedStep[] = [];
  const map: SentStep[] = [];
  const gate = stopCondition();
  const push = (step: ExpandedStep, planIndex: number, kind: SentStep["kind"]): void => {
    sent.push(step);
    map.push({ planIndex, kind });
  };
  for (const [planIndex, step] of plan.entries()) {
    const condition = andConditions(gate, step.condition);
    if (step.command === "click") {
      push({ ...step, command: "assertElementVisible", value: "", variableName: "", condition }, planIndex, "wait");
      push(
        {
          ...step,
          command: "extractEval",
          target: "",
          authoredTarget: "",
          value: probeScript(selectorsOf(step.authoredTarget), planIndex),
          variableName: `giGuardProbe${planIndex}`,
          condition,
          optional: false,
        },
        planIndex,
        "probe",
      );
    }
    push({ ...step, condition }, planIndex, "step");
  }
  const last = plan[plan.length - 1];
  push(
    {
      command: "extractEval",
      target: "",
      authoredTarget: "",
      value: logScript(),
      variableName: "giGuardLog",
      condition: null,
      optional: true,
      fromModule: null,
      ownerId: last?.ownerId ?? "",
      ownerName: last?.ownerName ?? "",
      indexInOwner: -1,
      rootIndex: last?.rootIndex ?? -1,
    },
    plan.length,
    "log",
  );
  return { sent, map };
}

/**
 * Folds a guarded run's result back onto the plan, so step N means the same thing as in `plan`.
 *
 * @param resultSteps Steps of the result, parallel to `sent`.
 * @param extractions The result's extractions.
 * @param sent The steps that were sent.
 * @param map What each sent step is.
 * @return One outcome per plan step, the runtime stop, and the requests the tripwire blocked.
 */
export function readGuardedResult(
  resultSteps: Array<Record<string, unknown>>,
  extractions: Record<string, unknown>,
  sent: ExpandedStep[],
  map: SentStep[],
): {
  outcomes: StepOutcome[];
  runtimeStop: string | null;
  blockedRequests: string[] | null;
  blockedRequestCount: number | null;
} {
  const raw = outcomesOf(resultSteps, sent);
  const stopEntry = map.findIndex(
    (entry) => entry.kind === "probe" && typeof extractions[`giGuardProbe${entry.planIndex}`] === "string" &&
      extractions[`giGuardProbe${entry.planIndex}`] !== "clear",
  );
  const runtimeStop = stopEntry >= 0 ? String(extractions[`giGuardProbe${map[stopEntry]?.planIndex}`]) : null;
  const failedAt = raw.findIndex((outcome) => outcome.status === "failed");
  const lastRan = raw.map((outcome) => outcome.status !== "not reached").lastIndexOf(true);

  const outcomes: StepOutcome[] = [];
  for (const [i, outcome] of raw.entries()) {
    const entry = map[i];
    if (!entry || entry.kind === "log") continue;
    if (entry.kind === "wait" && outcome.status === "failed") {
      outcomes[entry.planIndex] = {
        ...outcome,
        command: sent[i + 2]?.command ?? "click",
        error: `target never became visible: ${outcome.error ?? ""}`.trim(),
      };
      continue;
    }
    if (entry.kind === "probe" && outcome.status === "failed") {
      outcomes[entry.planIndex] = { ...outcome, command: "click", error: `the guard's probe could not run: ${outcome.error ?? ""}`.trim() };
      continue;
    }
    if (entry.kind !== "step" || outcomes[entry.planIndex]) continue;
    let status = outcome.status;
    if (status === "not reached") {
      if (stopEntry >= 0 && i > stopEntry) status = "stopped by guard";
      else if (failedAt >= 0 && i > failedAt) status = "not reached";
      else if (i < lastRan) status = "skipped by condition";
    }
    outcomes[entry.planIndex] = { ...outcome, sequence: entry.planIndex, status };
  }

  let blocked: string[] | null = null;
  const log = extractions["giGuardLog"];
  if (typeof log === "string") {
    try {
      const parsed = JSON.parse(log) as { blocked?: unknown };
      blocked = Array.isArray(parsed.blocked) ? parsed.blocked.map(String) : [];
    } catch {
      blocked = null;
    }
  }
  const summary = blocked === null ? null : summarizeBlocked(blocked);
  for (const [i, entry] of map.entries()) {
    const step = sent[i];
    if (entry.kind !== "step" || outcomes[entry.planIndex] || !step) continue;
    outcomes[entry.planIndex] = { sequence: entry.planIndex, command: step.command, target: step.target, status: "not reached" };
  }
  return {
    outcomes,
    runtimeStop,
    blockedRequests: summary?.entries ?? null,
    blockedRequestCount: summary?.count ?? null,
  };
}

const BLOCKED_CAP = 20;

/**
 * The tripwire's log for a report: query strings and fragments dropped, repeats folded, at most 20 lines.
 *
 * @param blocked Entries as the log recorded them: "<kind> <METHOD> <url>".
 * @return The lines to show, and how many attempts there were in all.
 */
function summarizeBlocked(blocked: string[]): { entries: string[]; count: number } {
  const counts = new Map<string, number>();
  for (const entry of blocked) {
    const key = entry.replace(/[?#]\S*/, "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts]
    .slice(0, BLOCKED_CAP)
    .map(([key, times]) => (times > 1 ? `${key} (${times} attempts)` : key));
  return { entries, count: blocked.length };
}

export interface StepOutcome {
  sequence: number;
  command: string;
  target: string;
  status: "passed" | "failed" | "not reached" | "skipped by condition" | "stopped by guard";
  /** Cut to 200 characters; `valueLength` is set when it was. */
  value?: string;
  valueLength?: number;
  /** What an extract or extractEval step captured. */
  extracted?: unknown;
  error?: string;
  fromModule?: string;
}

export interface PlannedStep {
  sequence: number;
  command: string;
  target: string;
  /** Cut to 200 characters; `valueLength` is set when it was. */
  value?: string;
  valueLength?: number;
  fromModule?: string;
  /** Present when the step runs conditionally, inherited conditions included. */
  condition?: string;
}

export interface ValidationReport {
  ranAs: {
    name: string;
    /** After variable substitution: exactly what the browser opens. */
    startUrl: string;
    viewport: string | null;
    browser: string | null;
    /** Where viewport and browser came from. Getting this wrong hides bugs. */
    configSource: string;
    userAgent: string | null;
    /** Every setting sent in the body, with where it came from. */
    settings: Record<string, { value: unknown; source: SettingSource }>;
    /** Variables substituted here. Private values are never shown. */
    variables: Record<string, { value: string; source: string }>;
  };
  expansion: {
    definedSteps: number;
    expandedSteps: number;
    modulesInlined: string[];
    depth: number;
    depthTruncated: boolean;
    /** Execute steps naming no module id. They cannot run. */
    emptyExecuteSteps: number;
  };
  /** Set when the run was refused before anything was sent. */
  refusedBecause?: string;
  variables: { resolved: string[]; runtime: string[]; unresolved: Array<{ name: string; where: string }> };
  guard: ReportGuard;
  /** Exactly what would run, or did. Readable without executing anything. */
  plan: PlannedStep[];
  /** False for a dry run or a refusal: nothing was sent to Ghost Inspector. */
  executed: boolean;
  outcome: {
    /** The on-demand result, readable with GET /results/{id}/. */
    resultId: string;
    passing: boolean | null;
    executionTimeMs: number | null;
    endUrl: string | null;
    stepsPassed: number;
    stepsFailed: number;
    stepsNotReached: number;
    stepsSkippedByCondition: number;
    stepsStoppedByGuard: number;
    /** Plan steps that ran; the guard's own steps are not counted. */
    stepsExecuted: number;
  } | null;
  /** Settings the result says it ran with that differ from what was asked. */
  settingsCheck: SettingDrift[] | null;
  firstFailure: StepOutcome | null;
  steps: StepOutcome[];
  /** Screenshots, video, URLs visited, extractions and console output. Null when nothing ran. */
  evidence: Evidence | null;
  notes: string[];
}

/** All three guard layers as one report. */
export interface ReportGuard {
  /** Layer A, the static cut: the plan step it replaced, or null when nothing looked like a submit. */
  stoppedAt: number | null;
  reason: string | null;
  droppedSteps: number;
  assertedTarget: string | null;
  /** Layer B: clicks probed in the browser before they run. */
  probedClicks: number;
  /** Layer B: why the probe stopped the run, or null when it did not (or nothing ran). */
  runtimeStop: string | null;
  /** Layer C: requests the tripwire blocked, without query strings, repeats folded, at most 20; null when its log step never ran. */
  blockedRequests: string[] | null;
  /** Every blocked attempt, including those past the cap. */
  blockedRequestCount: number | null;
}

export interface ValidateOptions {
  /** Existing test to validate. Its suite's configuration and variables are replicated. */
  testId?: string | undefined;
  /** Ad-hoc definition instead of an existing test. */
  definition?:
    | { name?: string | undefined; startUrl: string; steps: Steps }
    | undefined;
  /** Suite whose configuration and variables an ad-hoc definition runs with. */
  suiteId?: string | undefined;
  /** Variable values that win over the suite's and the organization's. */
  variables?: Record<string, string> | undefined;
  /** Override, e.g. "1280x800". Defaults to the test's, then the suite's. */
  viewport?: string | undefined;
  /** Override, e.g. "chrome". Defaults to the test's, then the suite's. */
  browser?: string | undefined;
  /** Stop before this plan step. Only ever earlier than the guard's own cut. */
  stopBefore?: number | undefined;
  /** Keep `plan` after a run and every console entry, not only the first 20 errors. */
  verbose?: boolean | undefined;
  /**
   * Report what would run and stop. Nothing is sent to Ghost Inspector, so no
   * browser starts and no page is loaded — the only way to inspect the guard's
   * decision at zero risk. Needs no organization id.
   */
  dryRun?: boolean | undefined;
}

/** Run settings a suite carries and on-demand accepts in its body. `httpAuth*` is deliberately absent. */
const SETTINGS = [
  "viewportSize",
  "browser",
  "userAgent",
  "region",
  "language",
  "globalStepDelay",
  "maxWaitDelay",
  "maxAjaxDelay",
  "finalDelay",
  "failOnJavaScriptError",
  "disableVisuals",
  "disallowInsecureCertificates",
] as const;

export type SettingSource = "caller override" | "test" | "suite";

export interface SettingDrift {
  setting: string;
  requested: unknown;
  reported: unknown;
}

/**
 * The settings a run should use: a caller override, else the test's own non-null value, else the suite's.
 *
 * @param test The test record, or null for an ad-hoc definition.
 * @param suite The suite record, or null.
 * @param overrides The caller's viewport ("WxH") and browser.
 * @return The values to send and where each came from.
 */
export function settingsFor(
  test: Record<string, unknown> | null,
  suite: Record<string, unknown> | null,
  overrides: { viewport?: string | undefined; browser?: string | undefined },
): { values: Record<string, unknown>; sources: Record<string, SettingSource> } {
  const values: Record<string, unknown> = {};
  const sources: Record<string, SettingSource> = {};
  const size = /^(\d+)\s*x\s*(\d+)$/i.exec(overrides.viewport?.trim() ?? "");
  const override: Record<string, unknown> = {};
  if (size) override["viewportSize"] = { width: Number(size[1]), height: Number(size[2]) };
  if (overrides.browser?.trim()) override["browser"] = overrides.browser.trim();
  const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

  for (const key of SETTINGS) {
    if (isSet(override[key])) {
      values[key] = override[key];
      sources[key] = "caller override";
    } else if (isSet(test?.[key])) {
      values[key] = test?.[key];
      sources[key] = "test";
    } else if (isSet(suite?.[key])) {
      values[key] = suite?.[key];
      sources[key] = "suite";
    }
  }
  return { values, sources };
}

/**
 * Settings the finished result reports differently from what was requested.
 *
 * @param requested The settings sent.
 * @param result The finished result record.
 * @return One entry per setting the result echoes with another value.
 */
export function settingsCheck(requested: Record<string, unknown>, result: Record<string, unknown>): SettingDrift[] {
  const sorted = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value;
  const normal = (key: string, value: unknown): string =>
    key === "browser" ? String(value).toLowerCase().replace(/-\d+(\.\d+)*$/, "") : JSON.stringify(sorted(value));
  return Object.entries(requested)
    .filter(([key]) => result[key] !== undefined && result[key] !== null)
    .filter(([key, value]) => normal(key, value) !== normal(key, result[key]))
    .map(([setting, value]) => ({ setting, requested: value, reported: result[setting] }));
}

export interface RunInputs {
  name: string;
  startUrl: string;
  expansion: Expansion;
  test: Record<string, unknown> | null;
  suite: Record<string, unknown> | null;
  org: Record<string, unknown> | null;
  viewport?: string | undefined;
  browser?: string | undefined;
  variables?: Record<string, string> | undefined;
  stopBefore?: number | undefined;
}

export interface PreparedRun {
  resolution: Resolution;
  vars: Map<string, VariableValue>;
  toRun: ExpandedStep[];
  /** What is actually sent: `toRun` with the in-browser guard injected around every click. */
  sent: ExpandedStep[];
  map: SentStep[];
  guard: Guard | null;
  settings: { values: Record<string, unknown>; sources: Record<string, SettingSource> };
  /** The on-demand body, or null when the run must be refused. */
  body: Record<string, unknown> | null;
  params: Record<string, string>;
  unresolved: Resolution["unresolved"];
  refusal: string | null;
  notes: string[];
}

/**
 * Everything a validation sends, built without the network: variables substituted, guard applied, settings merged.
 *
 * @param inputs The definition as expanded, and the records it inherits from.
 * @return The body to POST, or a refusal when a variable has no value.
 */
export function prepareRun(inputs: RunInputs): PreparedRun {
  const vars = collectVariables({
    org: asVariables(inputs.org?.["variables"]),
    suite: asVariables(inputs.suite?.["variables"]),
    caller: inputs.variables,
  });
  const resolution = resolveDefinition(inputs.startUrl, inputs.expansion.steps, vars);
  const { steps: toRun, guard, notes: guardNotes } = applyGuard(resolution.steps, { stopBefore: inputs.stopBefore });
  const { sent, map } = injectGuards(toRun);
  const settings = settingsFor(inputs.test, inputs.suite, { viewport: inputs.viewport, browser: inputs.browser });

  const notes: string[] = [...guardNotes];
  const auth = str(inputs.test?.["httpAuthUsername"]) || str(inputs.suite?.["httpAuthUsername"]);
  if (auth) {
    notes.push(
      "⚠️ This test's suite sets HTTP basic auth credentials, which a validation never sends. If the start URL sits behind basic auth, the run fails there for that reason alone.",
    );
  }

  const unresolved = resolution.unresolved;
  const refusal =
    unresolved.length === 0
      ? null
      : `Refused before anything was sent: ${unresolved.map((u) => `{{${u.name}}} in ${u.where}`).join("; ")} has no value. ` +
        "On-demand execution ignores custom variables and would run each as an empty string, which can still come back green. " +
        `The suite defines: ${names(inputs.suite)}. The organization defines: ${names(inputs.org)}. ` +
        "Pass the missing ones as `variables` ({\"name\": \"value\"}), or give an ad-hoc definition a `suiteId`.";

  const params: Record<string, string> = {};
  const size = settings.values["viewportSize"] as { width?: number; height?: number } | undefined;
  if (size?.width && size.height) params["viewport"] = `${size.width}x${size.height}`;
  if (typeof settings.values["browser"] === "string") params["browser"] = settings.values["browser"];

  const body =
    refusal !== null
      ? null
      : {
          name: `[validation] ${inputs.name}`,
          startUrl: resolution.startUrl,
          steps: sent.map((step) => ({
            command: step.command,
            target: step.authoredTarget,
            value: step.value,
            ...(step.variableName ? { variableName: step.variableName } : {}),
            ...(step.condition ? { condition: { statement: step.condition } } : {}),
            ...(step.optional ? { optional: true } : {}),
          })),
          ...settings.values,
        };

  return { resolution, vars, toRun, sent, map, guard, settings, body, params, unresolved, refusal, notes };
}

/**
 * Replaces every private variable's value with "(private)" in every string of a report.
 *
 * @param value The report, or any part of it.
 * @param vars The variables the run was resolved with.
 * @return The same shape, private values masked.
 */
export function maskPrivate<T>(value: T, vars: ReadonlyMap<string, VariableValue>): T {
  const hidden = [...vars.values()]
    .filter((entry) => entry.private && entry.value !== "")
    .map((entry) => entry.value)
    .sort((a, b) => b.length - a.length);
  if (hidden.length === 0) return value;
  const mask = (item: unknown): unknown => {
    if (typeof item === "string") return hidden.reduce((text, secret) => text.split(secret).join("(private)"), item);
    if (Array.isArray(item)) return item.map(mask);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, mask(entry)]));
    }
    return item;
  };
  return mask(value) as T;
}

/**
 * A stored `variables` array, or undefined when the record has none.
 *
 * @param value A record's `variables` field.
 * @return The entries, unvalidated.
 */
function asVariables(value: unknown): StoredVariable[] | undefined {
  return Array.isArray(value) ? (value as StoredVariable[]) : undefined;
}

/**
 * The variable names a record defines, for a refusal message.
 *
 * @param record A suite or organization record.
 * @return A comma-separated list, or "nothing".
 */
function names(record: Record<string, unknown> | null): string {
  const list = (asVariables(record?.["variables"]) ?? []).map((entry) => String(entry.name ?? "")).filter(Boolean);
  return list.length > 0 ? list.join(", ") : "nothing";
}

const VALUE_CAP = 200;

/**
 * A step value cut for display, with its full length when it was cut.
 *
 * @param value The step's value.
 * @return Nothing for an empty value; otherwise the value, and valueLength when cut.
 */
function clipped(value: string): { value?: string; valueLength?: number } {
  if (!value) return {};
  return value.length > VALUE_CAP ? { value: value.slice(0, VALUE_CAP), valueLength: value.length } : { value };
}

/**
 * What will run, step by step, readable without executing anything.
 *
 * @param steps The steps to be sent, guard applied.
 * @return One entry per step.
 */
export function planOf(steps: ExpandedStep[]): PlannedStep[] {
  return steps.map((step, sequence) => {
    const entry: PlannedStep = { sequence, command: step.command, target: step.target, ...clipped(step.value) };
    if (step.fromModule) entry.fromModule = step.fromModule;
    if (step.condition) entry.condition = step.condition;
    return entry;
  });
}

/**
 * Each result step's outcome, paired by position with the step that was sent.
 *
 * @param resultSteps Steps of the finished result.
 * @param sent The steps that were sent.
 * @return One outcome per result step.
 */
export function outcomesOf(resultSteps: Array<Record<string, unknown>>, sent: ExpandedStep[]): StepOutcome[] {
  return resultSteps.map((step, index) => {
    const passing = step["passing"];
    const error = str(step["error"]);
    const from = sent[index]?.fromModule;
    const outcome: StepOutcome = {
      sequence: index,
      command: str(step["command"]),
      target: str(step["target"]),
      status: passing === true ? "passed" : passing === false ? "failed" : "not reached",
      ...clipped(sent[index]?.value ?? str(step["value"])),
    };
    if (step["extracted"] !== undefined) outcome.extracted = step["extracted"];
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
  const { report, vars } = await runValidation(options);
  return maskPrivate(report, vars);
}

export interface PlanReport {
  ranAs: ValidationReport["ranAs"];
  expansion: ValidationReport["expansion"];
  variables: ValidationReport["variables"];
  guard: ReportGuard;
  plan: PlannedStep[];
  /** Why gi_validate_test would refuse this run before sending anything, or null. */
  wouldRefuse: string | null;
  notes: string[];
}

/**
 * What a validation would run, after modules, variables and all three guard layers, without sending anything.
 *
 * @param options As for validateTest; `dryRun` and `verbose` do not apply.
 * @return The plan, the guard's decisions and whether the run would be refused.
 * @throws {GhostInspectorError} when reading a definition fails.
 */
export async function planTest(options: Omit<ValidateOptions, "dryRun" | "verbose">): Promise<PlanReport> {
  const { report, vars, refusal } = await runValidation({ ...options, dryRun: true });
  const { ranAs, expansion, variables, guard, plan, notes } = maskPrivate(report, vars);
  return {
    ranAs,
    expansion,
    variables,
    guard,
    plan,
    wouldRefuse: refusal === null ? null : maskPrivate(refusal, vars),
    notes: notes.filter((note) => !note.startsWith("DRY RUN") && note !== refusal),
  };
}

/**
 * validateTest's body, returning the variables alongside so every path can be masked in one place.
 *
 * @param options Exactly one of `testId` or `definition`.
 * @return The unmasked report and the variables it was resolved with.
 */
async function runValidation(
  options: ValidateOptions,
): Promise<{ report: ValidationReport; vars: ReadonlyMap<string, VariableValue>; refusal: string | null }> {
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
  let test: TestRecord | null = null;
  let suiteId = options.suiteId ?? "";

  if (options.testId) {
    test = await request<TestRecord>("GET", `tests/${options.testId}`);
    name = test.name ?? "(unnamed)";
    startUrl = str(test["startUrl"]);
    defined = (test.steps ?? []) as Steps;
    // No test in a real account carries its own viewport, browser, user agent
    // or variables: they come from the suite.
    suiteId = test.suite && typeof test.suite === "object" ? str((test.suite as { _id?: string })._id) : "";
  } else {
    const def = options.definition as { name?: string; startUrl: string; steps: Steps };
    name = def.name ?? "ad-hoc definition";
    startUrl = def.startUrl;
    defined = def.steps;
  }

  const suite = suiteId ? await request<SuiteRecord & Record<string, unknown>>("GET", `suites/${suiteId}`) : null;
  const orgRef = suite?.["organization"];
  const orgId = orgRef && typeof orgRef === "object" ? str((orgRef as { _id?: string })._id) : str(orgRef);
  const configNotes: string[] = [];
  let org: Record<string, unknown> | null = null;
  if (orgId) {
    try {
      org = await request<Record<string, unknown>>("GET", `organizations/${orgId}`);
    } catch (error) {
      configNotes.push(
        `⚠️ The organization's variables could not be read (${error instanceof Error ? error.message : String(error)}), so only the suite's and yours were applied.`,
      );
    }
  }

  const expansion = await expandSteps(defined, load, { id: options.testId ?? "", name });
  const prepared = prepareRun({
    name,
    startUrl,
    expansion,
    test,
    suite,
    org,
    viewport: options.viewport,
    browser: options.browser,
    variables: options.variables,
    stopBefore: options.stopBefore,
  });
  const { toRun, guard, settings, resolution } = prepared;

  const plan = planOf(toRun);

  const size = settings.values["viewportSize"] as { width?: number; height?: number } | undefined;
  const viewport = size?.width && size.height ? `${size.width}x${size.height}` : null;
  const browser = typeof settings.values["browser"] === "string" ? settings.values["browser"] : null;
  const shownSources = [settings.sources["viewportSize"], settings.sources["browser"]].filter(Boolean);
  const configSource = shownSources.length > 0 ? [...new Set(shownSources)].join(" + ") : "Ghost Inspector defaults";

  const variables: ValidationReport["ranAs"]["variables"] = {};
  for (const { name: key, source } of resolution.resolved) {
    const known = prepared.vars.get(key);
    variables[key] = { value: known?.private ? "(private)" : (known?.value ?? ""), source };
  }

  const shared = {
    ranAs: {
      name,
      startUrl: resolution.startUrl,
      viewport,
      browser,
      configSource,
      userAgent: typeof settings.values["userAgent"] === "string" ? settings.values["userAgent"] : null,
      settings: Object.fromEntries(
        Object.entries(settings.values).map(([key, value]) => [key, { value, source: settings.sources[key] as SettingSource }]),
      ),
      variables,
    },
    expansion: {
      definedSteps: defined.length,
      expandedSteps: expansion.steps.length,
      modulesInlined: expansion.modules,
      depth: expansion.depth,
      depthTruncated: expansion.truncated,
      emptyExecuteSteps: expansion.emptyExecutes,
    },
    variables: {
      resolved: resolution.resolved.map((entry) => entry.name),
      runtime: resolution.runtime,
      unresolved: resolution.unresolved,
    },
    guard: {
      stoppedAt: guard?.stoppedAt ?? null,
      reason: guard?.reason ?? null,
      droppedSteps: guard?.droppedSteps ?? 0,
      assertedTarget: guard?.assertedTarget ?? null,
      probedClicks: prepared.map.filter((entry) => entry.kind === "probe").length,
      runtimeStop: null,
      blockedRequests: null,
      blockedRequestCount: null,
    } as ReportGuard,
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
        "No step looks like a form submission to the static check, which reads click targets, Enter keypresses, and scripts and conditions.",
      );
    }
    if (shared.guard.probedClicks > 0) {
      notes.push(
        `Each of the ${shared.guard.probedClicks} click(s) is probed in the browser first: the run stops if the element is a form's submit control, a non-field control inside a form, or cannot be resolved from the top document. A tripwire also blocks submit events, form.submit(), non-GET fetch and XHR, and sendBeacon, and reports them. It cannot see a script that saved window.fetch before the probe ran, or data sent by a GET (a pixel or a navigation).`,
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
    if (expansion.emptyExecutes > 0) {
      notes.push(
        `${expansion.emptyExecutes} execute step(s) name no module id, so they run nothing. Fix or remove them — a step that looks like an import and imports nothing misleads the next reader.`,
      );
    }
    if (expansion.steps.length === 0) {
      notes.push(
        "🔴 This definition executes NO steps: its chain bottoms out in empty modules. A run would pass because nothing can fail, while asserting nothing at all.",
      );
    }
    if (configSource === "Ghost Inspector defaults") {
      notes.push(
        "⚠️ Would run at Ghost Inspector's default viewport and browser, not the suite's. A selector can resolve on desktop and fail on mobile.",
      );
    }
    if (resolution.runtime.length > 0) {
      notes.push(
        `Left for the browser, because an earlier step sets them at run time: ${resolution.runtime.map((n) => `{{${n}}}`).join(", ")}.`,
      );
    }
    return [...notes, ...configNotes, ...prepared.notes];
  };

  const idle = { outcome: null, settingsCheck: null, firstFailure: null, steps: [], evidence: null };
  const vars = prepared.vars;
  if (prepared.refusal !== null) {
    const report: ValidationReport = {
      ...shared,
      ...idle,
      refusedBecause: "a variable has no value",
      executed: false,
      notes: [prepared.refusal, ...guardNotes()],
    };
    return { report, vars, refusal: prepared.refusal };
  }

  if (options.dryRun) {
    const report: ValidationReport = {
      ...shared,
      ...idle,
      executed: false,
      notes: [
        "DRY RUN: nothing was sent to Ghost Inspector. No browser started, no page loaded, no request left this machine beyond reading the definitions.",
        ...guardNotes(),
        "`plan` is exactly what a real run would execute, in order. dryRun is deprecated: gi_plan_test does the same and is read-only.",
      ],
    };
    return { report, vars, refusal: null };
  }

  const runOrg = requireOrgId();
  const pending = await request<RunResult>("POST", `organizations/${runOrg}/on-demand/execute`, {
    body: prepared.body,
    params: prepared.params,
    timeoutMs: 60_000,
  });
  // The POST answers in ~0.2s with passing: null. Reading that as a failure
  // would invent one; a browser run has been observed taking 99s.
  const result = await pollResult(pending._id, { timeoutMs: 300_000, intervalMs: 5_000 });

  const guarded = readGuardedResult(
    result.steps ?? [],
    (result["extractions"] ?? {}) as Record<string, unknown>,
    prepared.sent,
    prepared.map,
  );
  const stepOutcomes = guarded.outcomes;
  shared.guard.runtimeStop = guarded.runtimeStop;
  shared.guard.blockedRequests = guarded.blockedRequests;
  shared.guard.blockedRequestCount = guarded.blockedRequestCount;
  const guardRun: string[] = [];
  if (guarded.runtimeStop) {
    guardRun.push(
      `🔴 The in-browser guard stopped the run (${guarded.runtimeStop}). Every step after it was skipped, so a green result proves only the steps before it.`,
    );
  }
  if (guarded.blockedRequests && guarded.blockedRequests.length > 0) {
    guardRun.push(
      `🔴 The tripwire blocked ${guarded.blockedRequestCount} attempt(s) to send data; see guard.blockedRequests. The page's own analytics and form scripts are blocked too, so a step that depends on one of those calls can fail here and pass in a real run.`,
    );
  }
  if (guarded.blockedRequests === null) {
    guardRun.push("The guard's closing log did not run, because the run ended early, so what it blocked is unknown.");
  }
  const drift = settingsCheck(settings.values, result);
  const notes: string[] = [
    "Nothing was saved: on-demand execution runs a definition and discards it. The test in the account is untouched.",
    ...guardNotes(),
    ...guardRun,
    ...(toRun.some((step) => step.command === "eval") ? [EVAL_VALUE_NOTE] : []),
    ...drift.map(
      (d) => `⚠️ Asked to run with ${d.setting} ${JSON.stringify(d.requested)}, but the result reports ${JSON.stringify(d.reported)}.`,
    ),
  ];

  const report: ValidationReport = {
    ...shared,
    executed: true,
    outcome: {
      resultId: String(result._id ?? pending._id ?? ""),
      passing: result.passing,
      executionTimeMs: executionTimeMs(result),
      endUrl: result.endUrl ?? null,
      stepsPassed: stepOutcomes.filter((s) => s.status === "passed").length,
      stepsFailed: stepOutcomes.filter((s) => s.status === "failed").length,
      stepsNotReached: stepOutcomes.filter((s) => s.status === "not reached").length,
      stepsSkippedByCondition: stepOutcomes.filter((s) => s.status === "skipped by condition").length,
      stepsStoppedByGuard: stepOutcomes.filter((s) => s.status === "stopped by guard").length,
      stepsExecuted: stepOutcomes.filter((s) => s.status === "passed" || s.status === "failed").length,
    },
    settingsCheck: drift,
    firstFailure: stepOutcomes.find((s) => s.status === "failed") ?? null,
    steps: stepOutcomes,
    evidence: evidenceOf(result, options.verbose === true),
    notes,
  };
  if (options.verbose !== true) {
    report.plan = [];
    notes.push("`plan` is omitted after a run, since `steps` covers the same ground; pass verbose:true for it and every console entry.");
  }
  return { report, vars, refusal: null };
}
