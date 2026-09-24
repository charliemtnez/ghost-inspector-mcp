/** Reading a finished result: how much of it ran, how long it took, and the evidence it left behind. */

const CONSOLE_CAP = 20;
const OUTPUT_CAP = 300;

/** Why a plain `eval` never shows its value: said wherever a result is reported. */
export const EVAL_VALUE_NOTE =
  "Plain eval return values are not recorded by Ghost Inspector; use extractEval with a variableName to see one.";

export interface ConsoleEntry {
  url: string;
  output: string;
  error: boolean;
  dateExecuted: string | null;
}

export interface Evidence {
  screenshotUrl: string | null;
  screenshotSmallUrl: string | null;
  videoUrl: string | null;
  /** Every URL the run visited, in order. */
  urls: string[];
  /** Values captured by extract and extractEval steps, by variable name. */
  extractions: Record<string, unknown>;
  /** `entries` holds errors only, at most 20, unless verbose. The counts are always complete. */
  console: { total: number; errors: number; shown: number; entries: ConsoleEntry[] };
}

/**
 * Steps that actually executed. `passing: null` is a skipped condition or a step never reached.
 *
 * @param steps Steps of a result.
 * @return How many ran.
 */
export function stepsExecuted(steps: Array<Record<string, unknown>>): number {
  return steps.filter((step) => step["passing"] === true || step["passing"] === false).length;
}

/**
 * The run's duration, rebuilt from its timestamps when `executionTime` is absent.
 *
 * @param result A result record.
 * @return Milliseconds, or null when it cannot be known.
 */
export function executionTimeMs(result: Record<string, unknown>): number | null {
  if (typeof result["executionTime"] === "number") return result["executionTime"];
  const started = Date.parse(String(result["dateExecutionStarted"] ?? ""));
  const finished = Date.parse(String(result["dateExecutionFinished"] ?? ""));
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) return null;
  return finished - started;
}

/**
 * The screenshots, video, URLs, extractions and console output a result carries.
 *
 * @param result A result record.
 * @param verbose Return every console entry instead of the first 20 errors.
 * @return The evidence, with empty values where the result has none.
 */
export function evidenceOf(result: Record<string, unknown>, verbose: boolean): Evidence {
  const screenshot = record(result["screenshot"]);
  const raw = Array.isArray(result["console"]) ? (result["console"] as unknown[]).map(record) : [];
  const all = raw.map((entry) => ({
    url: text(entry["url"]),
    output: text(entry["output"]).slice(0, OUTPUT_CAP),
    error: entry["error"] === true,
    dateExecuted: entry["dateExecuted"] === undefined ? null : String(entry["dateExecuted"]),
  }));
  const errors = all.filter((entry) => entry.error);
  const entries = verbose ? all : errors.slice(0, CONSOLE_CAP);
  return {
    screenshotUrl: text(record(screenshot["original"])["defaultUrl"]) || null,
    screenshotSmallUrl: text(record(screenshot["small"])["defaultUrl"]) || null,
    videoUrl: text(record(result["video"])["url"]) || null,
    urls: Array.isArray(result["urls"]) ? (result["urls"] as unknown[]).map(String) : [],
    extractions: record(result["extractions"]),
    console: { total: all.length, errors: errors.length, shown: entries.length, entries },
  };
}

/**
 * A value as a plain object, or an empty one.
 *
 * @param value Anything.
 * @return The object, or {} when it is not one.
 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A value as a string, or an empty one.
 *
 * @param value Anything.
 * @return The string, or "".
 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
