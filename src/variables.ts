/** Client-side {{variable}} substitution: on-demand runs ignore custom variables and turn a missing one into "". */

import { type ExpandedStep } from "./validate.js";

const REFERENCE = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const BUILT_IN = new Set(["timestamp", "alphanumeric"]);

export interface VariableValue {
  value: string;
  source: "caller" | "suite" | "organization";
  private: boolean;
}

export interface StoredVariable {
  name?: unknown;
  value?: unknown;
  private?: unknown;
}

export interface Resolution {
  startUrl: string;
  steps: ExpandedStep[];
  /** Names substituted here, with where their value came from. */
  resolved: Array<{ name: string; source: VariableValue["source"] }>;
  /** Names a step defines at run time, left for the browser. */
  runtime: string[];
  /** Names with no value anywhere: sending them would run with "". */
  unresolved: Array<{ name: string; where: string }>;
}

/**
 * Merges the variables a run can see, the caller's winning over the suite's and the suite's over the organization's.
 *
 * @param sources Organization and suite variables as stored, plus the caller's overrides.
 * @return Every variable by name.
 */
export function collectVariables(sources: {
  org?: StoredVariable[] | undefined;
  suite?: StoredVariable[] | undefined;
  caller?: Record<string, string> | undefined;
}): Map<string, VariableValue> {
  const merged = new Map<string, VariableValue>();
  const add = (entries: StoredVariable[] | undefined, source: VariableValue["source"]): void => {
    for (const entry of entries ?? []) {
      if (typeof entry.name !== "string" || !entry.name) continue;
      merged.set(entry.name, {
        value: typeof entry.value === "string" ? entry.value : "",
        source,
        private: entry.private === true,
      });
    }
  };
  add(sources.org, "organization");
  add(sources.suite, "suite");
  for (const [name, value] of Object.entries(sources.caller ?? {})) {
    merged.set(name, { value, source: "caller", private: false });
  }
  return merged;
}

/**
 * Substitutes known variables into the start URL and every step's target, value and condition.
 *
 * @param startUrl The definition's start URL.
 * @param steps The expanded steps, in run order.
 * @param vars Variables from collectVariables.
 * @return The substituted definition, and every name it could not resolve.
 */
export function resolveDefinition(
  startUrl: string,
  steps: ExpandedStep[],
  vars: ReadonlyMap<string, VariableValue>,
): Resolution {
  const defined = new Set<string>();
  const resolved = new Map<string, VariableValue["source"]>();
  const runtime = new Set<string>();
  const unresolved: Resolution["unresolved"] = [];

  const substitute = (text: string, where: string): string =>
    text.replace(REFERENCE, (match: string, name: string) => {
      if (defined.has(name)) {
        runtime.add(name);
        return match;
      }
      if (BUILT_IN.has(name) || name.includes(".")) return match;
      const known = vars.get(name);
      if (known && !(known.private && known.value === "")) {
        resolved.set(name, known.source);
        return known.value;
      }
      unresolved.push({ name, where });
      return match;
    });

  const url = substitute(startUrl, "startUrl");
  const out = steps.map((step, index) => {
    const where = (field: string): string => `step ${index} (${step.command}) ${field}`;
    const authoredTarget = Array.isArray(step.authoredTarget)
      ? step.authoredTarget.map((entry) =>
          typeof entry["selector"] === "string"
            ? { ...entry, selector: substitute(entry["selector"], where("target")) }
            : entry,
        )
      : substitute(step.authoredTarget, where("target"));
    const next: ExpandedStep = {
      ...step,
      authoredTarget,
      target: Array.isArray(authoredTarget) ? JSON.stringify(authoredTarget) : authoredTarget,
      value: substitute(step.value, where("value")),
      condition: step.condition === null ? null : substitute(step.condition, where("condition")),
    };
    if (step.variableName) defined.add(step.variableName);
    return next;
  });

  return {
    startUrl: url,
    steps: out,
    resolved: [...resolved].map(([name, source]) => ({ name, source })),
    runtime: [...runtime],
    unresolved,
  };
}
