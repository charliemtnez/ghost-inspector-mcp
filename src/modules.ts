/**
 * Module usage — the reverse index the API does not offer.
 *
 * A module is a test whose steps other tests import via an `execute` step, and
 * nothing in the API says who imports it. Editing one therefore has an unknown
 * blast radius until this index exists.
 *
 * It is the expensive read: `steps` is absent from `GET /tests/`, so every test
 * costs its own request. Measured at ~80 ms each, a ~450-test account takes
 * single-digit seconds at low concurrency, which is affordable — but the
 * concurrency stays low deliberately, because the rate limit has no published
 * numbers.
 *
 * `importOnly` only prevents a test from being *run* directly; it does not stop
 * others importing it. So this indexes whatever is imported, not whatever is
 * marked as a module, and reports the difference.
 */

import { request, type TestRecord } from "./client.js";

/** Ghost Inspector's documented nesting limit. Exceeding it is a finding. */
const DOCUMENTED_MAX_DEPTH = 10;

/** Importer names listed per module before switching to a count. */
const NAME_CAP = 25;

/** Requests in flight. Low on purpose: the rate limit is undisclosed. */
const CONCURRENCY = 5;

export interface ModuleUsage {
  name: string;
  /** Whether it is flagged import-only. A false value here is a finding. */
  importOnly: boolean;
  /** Tests whose own steps execute it. */
  directImporters: number;
  /** Every test that reaches it through any chain of executes. */
  allImporters: number;
  /** Names of the transitive importers, capped. */
  importerNames: string[];
  omittedImporters: number;
  /** Deepest chain by which it is reached. 1 means only direct. */
  maxDepth: number;
  /** Names of the modules it executes itself. */
  imports: string[];
  /**
   * True when the module transitively imports itself. A defect, not a metric:
   * the importer counts exclude the module itself so the blast radius stays
   * readable, and this flag is what tells you the chain loops.
   */
  inCycle: boolean;
}

export interface BrokenReference {
  test: string;
  missingId: string;
}

export interface UsageReport {
  scanned: {
    tests: number;
    stepRequests: number;
    unreadable: number;
  };
  totals: {
    imported: number;
    declaredModules: number;
    unusedModules: number;
    importedNonModules: number;
    brokenReferences: number;
    cycles: number;
    deepestChain: number;
  };
  notes: string[];
  modules: ModuleUsage[];
  /** Import-only tests nobody imports. Dead weight, or a broken wiring. */
  unusedModules: string[];
  brokenReferences: BrokenReference[];
}

type Steps = Array<Record<string, unknown>>;

/** Module ids an `execute` step chain references, in order, deduped. */
function executedIds(steps: Steps): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (step["command"] !== "execute") continue;
    const value = step["value"];
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

/**
 * Builds the report from already-fetched data. No network access, so it can be
 * exercised against hand-built fixtures.
 *
 * @param tests Every test record, from `GET /tests/`.
 * @param steps Per-test steps, keyed by test id. A missing key means the
 *   definition could not be read; it is reported rather than treated as empty.
 * @returns The reverse index, plus what could not be resolved.
 */
export function buildUsage(tests: TestRecord[], steps: Map<string, Steps>): UsageReport {
  const name = new Map(tests.map((t) => [t._id, t.name ?? "(unnamed)"]));
  const declaredModules = tests.filter((t) => t.importOnly === true);

  // importer -> imported
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

  // imported -> importers
  const reverse = new Map<string, Set<string>>();
  for (const [importer, targets] of forward) {
    for (const target of targets) {
      const set = reverse.get(target) ?? new Set<string>();
      set.add(importer);
      reverse.set(target, set);
    }
  }

  /**
   * Every test reaching `target`, by reverse breadth-first walk. The visited
   * set makes a cycle terminate instead of hanging; depth is reported so a
   * chain deeper than Ghost Inspector documents shows up as data.
   */
  const reach = (target: string): { importers: Set<string>; depth: number } => {
    const importers = new Set<string>();
    let frontier = [...(reverse.get(target) ?? [])];
    let depth = 0;
    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      for (const id of frontier) {
        if (importers.has(id)) continue;
        importers.add(id);
        for (const up of reverse.get(id) ?? []) next.push(up);
      }
      // Filtered after the wave is absorbed, so a level that would add nobody
      // never runs and never inflates the depth.
      frontier = next.filter((id) => !importers.has(id));
    }
    return { importers, depth };
  };

  const targets = [...reverse.keys()];
  const modules: ModuleUsage[] = targets
    .map((id) => {
      const { importers, depth } = reach(id);
      // Reaching itself means the chain loops. Keep that as a flag and drop it
      // from the importer set, so a cycle cannot quietly inflate a count.
      const inCycle = importers.delete(id);
      const names = [...importers].map((i) => name.get(i) ?? i).sort();
      const test = tests.find((t) => t._id === id);
      return {
        name: name.get(id) ?? id,
        importOnly: test?.importOnly === true,
        directImporters: reverse.get(id)?.size ?? 0,
        allImporters: importers.size,
        // Uncapped here. Trimming is presentation, applied at the boundary so
        // this function never reports an omission count it did not cause.
        importerNames: names,
        omittedImporters: 0,
        maxDepth: depth,
        imports: (forward.get(id) ?? []).map((t) => name.get(t) ?? t).sort(),
        inCycle,
      };
    })
    .sort((a, b) => b.allImporters - a.allImporters || a.name.localeCompare(b.name));

  const importedIds = new Set(targets);
  const unused = declaredModules
    .filter((m) => !importedIds.has(m._id))
    .map((m) => m.name ?? "(unnamed)")
    .sort();
  const importedNonModules = modules.filter((m) => !m.importOnly);
  const cyclic = modules.filter((m) => m.inCycle);
  const deepest = modules.reduce((max, m) => Math.max(max, m.maxDepth), 0);

  const notes: string[] = [
    "allImporters is the blast radius: every test that reaches this module through any chain of executes. directImporters counts only those whose own steps name it.",
  ];
  if (unused.length > 0) {
    notes.push(
      `${unused.length} import-only test(s) are imported by nothing. Either dead weight, or a test that lost its caller and is now silently not running.`,
    );
  }
  if (importedNonModules.length > 0) {
    notes.push(
      `${importedNonModules.length} imported test(s) are NOT flagged import-only, so they run standalone AND as part of their importers. Editing one changes both paths; that is usually unintended.`,
    );
  }
  if (broken.length > 0) {
    notes.push(
      `${broken.length} execute step(s) point at a test id that does not exist. Those steps cannot run.`,
    );
  }
  if (cyclic.length > 0) {
    notes.push(
      `${cyclic.length} module(s) transitively import themselves. A loop cannot resolve, so those chains do not run as intended — fix the cycle before trusting any test that reaches them.`,
    );
  }
  if (deepest > DOCUMENTED_MAX_DEPTH) {
    notes.push(
      `A chain runs ${deepest} levels deep, past the ${DOCUMENTED_MAX_DEPTH} Ghost Inspector documents. Verify it executes at all.`,
    );
  }

  return {
    scanned: { tests: tests.length, stepRequests: steps.size, unreadable: tests.length - steps.size },
    totals: {
      imported: modules.length,
      declaredModules: declaredModules.length,
      unusedModules: unused.length,
      importedNonModules: importedNonModules.length,
      brokenReferences: broken.length,
      cycles: cyclic.length,
      deepestChain: deepest,
    },
    notes,
    modules,
    unusedModules: unused,
    brokenReferences: broken,
  };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export interface UsageOptions {
  /** Case-insensitive substring of a module name. Lifts the importer-name cap. */
  module?: string | undefined;
}

/**
 * Fetches every test definition and builds the reverse index.
 *
 * One request per test, because `steps` is absent from the listing. A test that
 * cannot be read is counted, never silently skipped: a missing definition would
 * understate a blast radius, which is the one error that matters here.
 *
 * @param options Optional narrowing of what is returned; the scan is unchanged.
 * @returns The reverse index.
 * @throws {GhostInspectorError} if the test listing itself fails.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function getModuleUsage(options: UsageOptions = {}): Promise<UsageReport> {
  const tests = await request<TestRecord[]>("GET", "tests", { timeoutMs: 120_000 });

  const fetched = await pool(tests, CONCURRENCY, async (test) => {
    try {
      const full = await request<TestRecord>("GET", `tests/${test._id}`);
      return { id: test._id, steps: (full.steps ?? []) as Steps };
    } catch {
      return null;
    }
  });

  const steps = new Map<string, Steps>();
  for (const entry of fetched) if (entry) steps.set(entry.id, entry.steps);

  const report = buildUsage(tests, steps);

  if (options.module) {
    const needle = options.module.toLowerCase();
    const matched = report.modules.filter((m) => m.name.toLowerCase().includes(needle));
    report.notes.push(
      `Filtered view: ${matched.length} of ${report.modules.length} imported test(s) shown, with every importer named. Totals above cover the whole account.`,
    );
    report.modules = matched;
    return report;
  }

  // Unfiltered, cap the name lists so a widely-shared module cannot dominate
  // the response — and say how many were dropped, never trimming in silence.
  report.modules = report.modules.map((m) =>
    m.importerNames.length <= NAME_CAP
      ? m
      : {
          ...m,
          importerNames: m.importerNames.slice(0, NAME_CAP),
          omittedImporters: m.importerNames.length - NAME_CAP,
        },
  );
  const trimmed = report.modules.filter((m) => m.omittedImporters > 0).length;
  if (trimmed > 0) {
    report.notes.push(
      `${trimmed} module(s) had their importer list trimmed to ${NAME_CAP} names. Pass \`module\` with a name to see all of them.`,
    );
  }
  return report;
}
