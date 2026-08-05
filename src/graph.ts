/**
 * The `execute` dependency graph, and the scan that pays for it.
 *
 * Two tools need the same thing: who imports what, and what a test pulls in.
 * The graph is one field wide — an `execute` step names its module in `value` —
 * but building it costs one request per test, because `steps` is absent from
 * `GET /tests/`. That scan lives here so a single place owns its cost and its
 * failure accounting.
 */

import { request, type TestRecord } from "./client.js";

export type Steps = Array<Record<string, unknown>>;

/** Ghost Inspector's documented nesting limit. Exceeding it is a finding. */
export const DOCUMENTED_MAX_DEPTH = 10;

/** Requests in flight. Low on purpose: the rate limit is undisclosed. */
export const REQUEST_CONCURRENCY = 5;

export interface BrokenReference {
  test: string;
  missingId: string;
}

export interface Graph {
  /** Importer id → the ids it executes, in step order, deduped. */
  forward: Map<string, string[]>;
  /** Imported id → the ids that execute it. */
  reverse: Map<string, Set<string>>;
  /** Test id → display name. */
  name: Map<string, string>;
  /** Execute steps pointing at an id no test has. Those steps cannot run. */
  broken: BrokenReference[];
}

/** The module ids a step list executes, in order, deduped. */
export function executedIds(steps: Steps): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (step["command"] !== "execute") continue;
    const value = step["value"];
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

/**
 * Builds both directions of the graph from already-fetched definitions.
 *
 * @param tests Every test record, from `GET /tests/`.
 * @param steps Per-test steps keyed by test id. A missing key means the
 *   definition could not be read, and is the caller's to report.
 * @returns Edges in both directions, names, and unresolvable references.
 */
export function buildEdges(tests: TestRecord[], steps: Map<string, Steps>): Graph {
  const name = new Map(tests.map((t) => [t._id, t.name ?? "(unnamed)"]));
  const forward = new Map<string, string[]>();
  const broken: BrokenReference[] = [];

  for (const [testId, list] of steps) {
    const targets: string[] = [];
    for (const id of executedIds(list)) {
      if (name.has(id)) targets.push(id);
      else broken.push({ test: name.get(testId) ?? testId, missingId: id });
    }
    if (targets.length) forward.set(testId, targets);
  }

  const reverse = new Map<string, Set<string>>();
  for (const [importer, targets] of forward) {
    for (const target of targets) {
      const set = reverse.get(target) ?? new Set<string>();
      set.add(importer);
      reverse.set(target, set);
    }
  }
  return { forward, reverse, name, broken };
}

export interface Walk {
  /** Ids reached, excluding the starting id unless a cycle returns to it. */
  ids: Set<string>;
  /** Levels traversed. 1 means direct neighbours only. */
  depth: number;
  /** True when the walk hit the documented depth limit with more to explore. */
  truncated: boolean;
}

/**
 * Breadth-first walk over one direction of the graph.
 *
 * The visited set makes a cycle terminate instead of hanging. Depth only
 * advances for a level that absorbs a new node, so a level adding nobody cannot
 * pad the number. The walk stops at the documented limit and says so, rather
 * than reporting a depth Ghost Inspector would not execute as fact.
 *
 * @param start Id to walk from.
 * @param edges Either direction of the graph.
 * @returns What was reached, how deep, and whether the limit cut it short.
 */
export function walk(start: string, edges: ReadonlyMap<string, Iterable<string>>): Walk {
  const ids = new Set<string>();
  let frontier = [...(edges.get(start) ?? [])];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (depth >= DOCUMENTED_MAX_DEPTH) {
      truncated = true;
      break;
    }
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      if (ids.has(id)) continue;
      ids.add(id);
      for (const step of edges.get(id) ?? []) next.push(step);
    }
    frontier = next.filter((id) => !ids.has(id));
  }
  return { ids, depth, truncated };
}

/**
 * Collects every module id reachable from one test, following `execute` steps.
 *
 * Loads only what the chain touches, so a single test costs a handful of
 * requests rather than the whole-account scan. Cycle-safe and capped at the
 * documented nesting limit, reporting when the cap cut the walk short — a
 * truncated chain means an incomplete answer, never a clean one.
 *
 * @param rootId Test to walk from.
 * @param loadSteps Reads one test's steps by id.
 * @returns Reachable module ids and whether the walk was cut short.
 */
export async function collectChainIds(
  rootId: string,
  loadSteps: (id: string) => Promise<Steps>,
): Promise<{ ids: string[]; truncated: boolean }> {
  const seen = new Set<string>();
  let truncated = false;

  const visit = async (id: string, depth: number, path: Set<string>): Promise<void> => {
    if (depth >= DOCUMENTED_MAX_DEPTH) {
      truncated = true;
      return;
    }
    for (const next of executedIds(await loadSteps(id))) {
      if (path.has(next)) {
        truncated = true;
        continue;
      }
      if (!seen.has(next)) seen.add(next);
      await visit(next, depth + 1, new Set([...path, next]));
    }
  };

  await visit(rootId, 0, new Set([rootId]));
  return { ids: [...seen], truncated };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving order.
 * Every fan-out against the API comes through here, so one knob owns how hard
 * this server leans on an undisclosed rate limit.
 *
 * @param items Inputs, in order.
 * @param limit Maximum calls in flight.
 * @param fn Async worker. Its rejection propagates to the caller.
 * @returns Results in the same order as `items`.
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index] as T);
      }
    }),
  );
  return out;
}

export interface Definitions {
  steps: Map<string, Steps>;
  /** Tests whose definition could not be read. Counted, never assumed empty. */
  unreadable: number;
}

/**
 * Fetches every test's steps: one request each, at low concurrency.
 *
 * A definition that fails to load is counted rather than treated as having no
 * steps. Silently substituting "no steps" would drop edges from the graph, and
 * every question asked of this graph — blast radius, staleness — gets *safer*
 * looking when edges go missing. That is the one failure mode worth paying
 * attention to here.
 *
 * @param tests Every test record, from `GET /tests/`.
 * @returns Steps by test id, plus how many could not be read.
 */
export async function fetchDefinitions(tests: TestRecord[]): Promise<Definitions> {
  const fetched = await pool(tests, REQUEST_CONCURRENCY, async (test) => {
    try {
      const full = await request<TestRecord>("GET", `tests/${test._id}`);
      return { id: test._id, steps: (full.steps ?? []) as Steps };
    } catch {
      return null;
    }
  });

  const steps = new Map<string, Steps>();
  for (const entry of fetched) if (entry) steps.set(entry.id, entry.steps);
  return { steps, unreadable: tests.length - steps.size };
}
