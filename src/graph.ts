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

/**
 * A step condition's script. Ghost Inspector stores it as {statement}; a bare string is accepted too.
 *
 * @param raw A step's `condition` field.
 * @return The script, or null when there is none.
 */
export function conditionStatement(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as { statement?: unknown }).statement : null;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

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
 * Whether `edges` contain a loop reachable from `start`.
 *
 * Structural rather than path-based on purpose. `collectChainIds` skips a
 * subtree it has already expanded, so a loop may never be re-walked from the
 * path that would reveal it — and going around a loop only ever increases
 * depth, so the return edge lands on exactly the kind of node that gets
 * skipped. Deciding it from the recorded edges instead is independent of the
 * order they were discovered in, and costs no requests.
 *
 * @param start Id to search from.
 * @param edges Executed ids by test id, as recorded while walking.
 * @returns True when some node reachable from `start` reaches itself.
 */
export function hasCycle(start: string, edges: ReadonlyMap<string, string[]>): boolean {
  const settled = new Set<string>();
  const onPath = new Set<string>([start]);
  const stack: Array<{ id: string; cursor: number }> = [{ id: start, cursor: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as { id: string; cursor: number };
    const children = edges.get(frame.id) ?? [];
    if (frame.cursor >= children.length) {
      stack.pop();
      onPath.delete(frame.id);
      settled.add(frame.id);
      continue;
    }
    const next = children[frame.cursor] as string;
    frame.cursor += 1;
    if (onPath.has(next)) return true;
    if (settled.has(next)) continue;
    onPath.add(next);
    stack.push({ id: next, cursor: 0 });
  }
  return false;
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
  const edges = new Map<string, string[]>();
  // Shallowest depth at which a node's subtree was expanded. Reached again with
  // no more depth budget than last time, it can reach nothing new and is
  // skipped; reached *shallower*, it has budget for more and is walked again.
  // Without this a diamond-shaped chain is re-expanded once per path, and this
  // whole walk runs before every write.
  const expandedAt = new Map<string, number>();
  let hitDepthLimit = false;

  const visit = async (id: string, depth: number): Promise<void> => {
    if (depth >= DOCUMENTED_MAX_DEPTH) {
      hitDepthLimit = true;
      return;
    }
    const previous = expandedAt.get(id);
    if (previous !== undefined && previous <= depth) return;
    expandedAt.set(id, depth);

    const executed = executedIds(await loadSteps(id));
    edges.set(id, executed);
    for (const next of executed) {
      seen.add(next);
      await visit(next, depth + 1);
    }
  };

  await visit(rootId, 0);
  return { ids: [...seen], truncated: hitDepthLimit || hasCycle(rootId, edges) };
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

/**
 * Steps for a set of tests and every module they import, transitively, up to the documented depth.
 *
 * @param ids The tests in scope.
 * @param load Reads one test's steps, or null when it cannot be read.
 * @return Steps by test id, plus how many could not be read.
 */
export async function fetchDefinitionsClosure(
  ids: string[],
  load: (id: string) => Promise<Steps | null> = loadSteps,
): Promise<Definitions> {
  const steps = new Map<string, Steps>();
  const seen = new Set<string>();
  let unreadable = 0;
  let frontier = [...new Set(ids)];
  for (let depth = 0; depth <= DOCUMENTED_MAX_DEPTH && frontier.length > 0; depth += 1) {
    for (const id of frontier) seen.add(id);
    const loaded = await pool(frontier, REQUEST_CONCURRENCY, async (id) => ({ id, steps: await load(id) }));
    const next = new Set<string>();
    for (const entry of loaded) {
      if (entry.steps === null) {
        unreadable += 1;
        continue;
      }
      steps.set(entry.id, entry.steps);
      for (const child of executedIds(entry.steps)) if (!seen.has(child)) next.add(child);
    }
    frontier = [...next];
  }
  return { steps, unreadable };
}

/**
 * One test's steps from the API.
 *
 * @param id The test.
 * @return Its steps, or null when it cannot be read.
 */
async function loadSteps(id: string): Promise<Steps | null> {
  try {
    const full = await request<TestRecord>("GET", `tests/${id}`);
    return (full.steps ?? []) as Steps;
  } catch {
    return null;
  }
}
