/**
 * Ghost Inspector REST client.
 *
 * Encodes the parts of the contract the official docs omit, so callers never
 * have to rediscover them:
 *   - responses are wrapped in {code, data} and errors arrive with HTTP 200
 *   - execution endpoints return immediately with a PENDING record whose
 *     `passing` is null; null means "not finished", never "failed"
 *   - the API key travels in the query string, so every error is redacted
 */

import { ConfigError, redact, requireApiKey } from "./config.js";

const BASE_URL = "https://api.ghostinspector.com/v1";

/** A Ghost Inspector API error (code === "ERROR", or a non-2xx response). */
export class GhostInspectorError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(redact(message));
    this.name = "GhostInspectorError";
    this.status = status;
  }
}

/** Raised when a run does not finish inside the allotted polling window. */
export class RunTimeoutError extends Error {
  constructor(resultId: string, waitedMs: number) {
    super(
      `Run ${resultId} was still pending after ${Math.round(waitedMs / 1000)}s. ` +
        `It may still finish — poll GET /results/${resultId}/ again. ` +
        `Browser runs typically take 20-70s.`,
    );
    this.name = "RunTimeoutError";
  }
}

type Envelope<T> = { code?: string; message?: string; data?: T };

export interface RequestOptions {
  /** Extra query-string parameters. `apiKey` is added automatically. */
  params?: Record<string, string | number | boolean | undefined>;
  /** JSON request body, for POST. */
  body?: unknown;
  /** Per-request timeout. Defaults to 60s, matching a slow browser run. */
  timeoutMs?: number;
}

/**
 * Performs a single API request and unwraps the envelope.
 *
 * @param method HTTP verb.
 * @param endpoint Path relative to /v1, without leading slash (e.g. "tests").
 * @returns The `data` field of the envelope.
 * @throws {GhostInspectorError} on a non-2xx response or code === "ERROR".
 * @throws {ConfigError} when the API key is not configured.
 */
export async function request<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${BASE_URL}/${endpoint.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  url.searchParams.set("apiKey", requireApiKey());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  let response: Response;
  try {
    // Built conditionally: exactOptionalPropertyTypes rejects an explicit
    // `undefined` for headers/body.
    const init: RequestInit = { method, signal: controller.signal };
    if (options.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    response = await fetch(url, init);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new GhostInspectorError(`Request to ${endpoint} failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: Envelope<T>;
  try {
    payload = JSON.parse(text) as Envelope<T>;
  } catch {
    // A 404 on a non-existent endpoint returns an HTML error page.
    throw new GhostInspectorError(
      `${endpoint} returned a non-JSON response (HTTP ${response.status}). ` +
        `This usually means the endpoint does not exist.`,
      response.status,
    );
  }

  if (!response.ok || payload.code === "ERROR") {
    throw new GhostInspectorError(
      payload.message ?? `${endpoint} failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return payload.data as T;
}

/** Minimal shape of a result record; `passing: null` means still running. */
export interface RunResult {
  _id: string;
  passing: boolean | null;
  executionTime?: number | null;
  endUrl?: string | null;
  steps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface PollOptions {
  /** Total time to wait before giving up. Default 240s. */
  timeoutMs?: number;
  /** Delay between polls. Default 6s. */
  intervalMs?: number;
}

/**
 * Polls a result until it finishes.
 *
 * Execution endpoints answer in ~0.2s with `passing: null`, so a caller that
 * reads the immediate response sees every step as "not passing" and concludes
 * the test failed. Always come through here.
 *
 * @throws {RunTimeoutError} if still pending when the window closes.
 */
export async function pollResult(
  resultId: string,
  options: PollOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 6_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await request<RunResult>("GET", `results/${resultId}`);
    if (result.passing !== null && result.passing !== undefined) return result;
    if (Date.now() >= deadline) throw new RunTimeoutError(resultId, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Minimal shape of a test record, as returned by `GET /tests/`.
 *
 * `steps` is absent from the listing — a per-test `GET` is required for it.
 */
export interface TestRecord {
  _id: string;
  name?: string;
  /** True when the test is a module: imported by others, never run on its own. */
  importOnly?: boolean;
  /** `null` while a run is in flight, and never a boolean for a module. */
  passing?: boolean | null;
  dateUpdated?: string;
  dateExecutionTriggered?: string;
  dateExecutionFinished?: string;
  steps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Whether a test is a module — Ghost Inspector's only unit of reuse, the
 * equivalent of a function. Other tests splice its steps in via an `execute`
 * step (labelled "Import steps from test" in the web UI).
 *
 * `importOnly` arrives in the cheap listing, so modules can be told apart
 * without paying the per-test fetch that `steps` would cost.
 *
 * @param test A test record from `GET /tests/` or `GET /tests/{id}/`.
 * @returns True when the test only ever runs as part of another test.
 */
export function isModule(test: TestRecord): boolean {
  return test.importOnly === true;
}

/**
 * Whether a test has never completed a run of its own.
 *
 * 🔴 Read this before ranking anything by recency. Setting `importOnly`
 * *deletes* a test's stored results, so **every module is permanently "never
 * executed"**: no results, `passing` not a boolean, and a last-run date pinned
 * to the `1970-01-01` epoch sentinel. A staleness or health aggregation that
 * ranks on these fields will therefore surface every module as the deadest,
 * most broken thing in the account, and advise pruning exactly the code every
 * live test shares. Filter modules out with {@link isModule} *before* ranking.
 *
 * Unparseable and absent dates count as never executed, so an unknown value
 * can never masquerade as a recent run.
 *
 * @param test A test record carrying either execution date field.
 * @returns True when no completed run is recorded.
 */
export function hasNeverExecuted(test: TestRecord): boolean {
  const stamp = test.dateExecutionFinished ?? test.dateExecutionTriggered;
  if (stamp === undefined || stamp === null) return true;
  const parsed = Date.parse(String(stamp));
  return Number.isNaN(parsed) || parsed <= 0;
}

/** Re-exported so tool handlers can produce safe messages uniformly. */
export { ConfigError, redact };
