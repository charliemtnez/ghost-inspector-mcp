/**
 * Module usage — the reverse index the API does not offer.
 *
 * A module is a test whose steps other tests import via an `execute` step, and
 * nothing in the API points that way. Editing one therefore has an unknown
 * blast radius until this index exists.
 *
 * `importOnly` only prevents a test from being *run* directly; it does not stop
 * others importing it. So this indexes whatever is imported, not whatever is
 * marked as a module, and reports the difference.
 */

import { request, type TestRecord } from "./client.js";
import {
  buildEdges,
  fetchDefinitions,
  walk,
  type BrokenReference,
  type Steps,
} from "./graph.js";

/** Importer names listed per module before switching to a count. */
const NAME_CAP = 25;

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
  /** True when the chain hit the documented depth limit with more to explore. */
  depthTruncated: boolean;
  /** Names of the modules it executes itself. */
  imports: string[];
  /**
   * True when the module transitively imports itself. A defect, not a metric:
   * the importer counts exclude the module itself so the blast radius stays
   * readable, and this flag is what tells you the chain loops.
   */
  inCycle: boolean;
}

export interface UsageReport {
  scanned: { tests: number; stepRequests: number; unreadable: number };
  totals: {
    imported: number;
    declaredModules: number;
    unusedModules: number;
    importedNonModules: number;
    brokenReferences: number;
    cycles: number;
    noOpModules: number;
    vacuousTests: number;
    deepestChain: number;
  };
  notes: string[];
  modules: ModuleUsage[];
  /** Import-only tests nobody imports. Dead weight, or a broken wiring. */
  unusedModules: string[];
  /**
   * Imported tests that contribute no real step, directly or through their own
   * chain. A module holding nothing but `execute` calls into empty modules is
   * just as inert as a literally empty one, so both land here.
   */
  noOpModules: string[];
  /**
   * 🔴 Tests that execute no steps at all, directly or through their chain.
   * They pass because nothing can fail, so the dashboard shows them green while
   * they assert nothing. Worse than a red test, and invisible without this.
   */
  vacuousTests: string[];
  brokenReferences: BrokenReference[];
}

/**
 * Builds the report from already-fetched data. No network access, so it can be
 * exercised against hand-built fixtures.
 *
 * @param tests Every test record, from `GET /tests/`.
 * @param steps Per-test steps, keyed by test id.
 * @returns The reverse index, plus what could not be resolved.
 */
export function buildUsage(tests: TestRecord[], steps: Map<string, Steps>): UsageReport {
  const { forward, reverse, name, broken } = buildEdges(tests, steps);
  const declaredModules = tests.filter((t) => t.importOnly === true);
  const byId = new Map(tests.map((t) => [t._id, t]));

  const targets = [...reverse.keys()];
  const modules: ModuleUsage[] = targets
    .map((id) => {
      const { ids, depth, truncated } = walk(id, reverse);
      // Reaching itself means the chain loops. Keep that as a flag and drop it
      // from the importer set, so a cycle cannot quietly inflate a count.
      const inCycle = ids.delete(id);
      const names = [...ids].map((i) => name.get(i) ?? i).sort();
      return {
        name: name.get(id) ?? id,
        importOnly: byId.get(id)?.importOnly === true,
        directImporters: reverse.get(id)?.size ?? 0,
        allImporters: ids.size,
        // Uncapped here. Trimming is presentation, applied at the boundary so
        // this function never reports an omission count it did not cause.
        importerNames: names,
        omittedImporters: 0,
        maxDepth: depth,
        depthTruncated: truncated,
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
  // A step list with nothing but `execute` in it contributes no action of its
  // own; what matters is whether the whole chain bottoms out in real steps.
  const realSteps = (id: string): number =>
    (steps.get(id) ?? []).filter((step) => step["command"] !== "execute").length;

  /** Real steps reachable from `id`, including its own. */
  const chainRealSteps = (id: string): number => {
    let total = realSteps(id);
    for (const reached of walk(id, forward).ids) total += realSteps(reached);
    return total;
  };

  const noOpModules = targets
    .filter((id) => chainRealSteps(id) === 0)
    .map((id) => name.get(id) ?? id)
    .sort();

  const vacuousTests = tests
    .filter((t) => t.importOnly !== true && steps.has(t._id))
    .filter((t) => chainRealSteps(t._id) === 0)
    .map((t) => t.name ?? "(unnamed)")
    .sort();

  const importedNonModules = modules.filter((m) => !m.importOnly);
  const cyclic = modules.filter((m) => m.inCycle);
  const truncated = modules.filter((m) => m.depthTruncated);
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
  if (vacuousTests.length > 0) {
    notes.push(
      `🔴 ${vacuousTests.length} test(s) execute NO steps at all — their own definition is only \`execute\` calls and the chain bottoms out in empty modules. They pass because nothing can fail, so the dashboard shows them green while they assert nothing. Emptying one shared module is enough to do this to every test that imports it.`,
    );
  }
  if (noOpModules.length > 0) {
    notes.push(
      `${noOpModules.length} imported test(s) contribute no real step at all, so importing one adds nothing and its importers run less than they appear to.`,
    );
  }
  if (cyclic.length > 0) {
    notes.push(
      `${cyclic.length} module(s) transitively import themselves. A loop cannot resolve, so those chains do not run as intended — fix the cycle before trusting any test that reaches them.`,
    );
  }
  if (truncated.length > 0) {
    notes.push(
      `${truncated.length} chain(s) reach the documented 10-level nesting limit and were not walked further, so their blast radius is a floor, not a total.`,
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
      noOpModules: noOpModules.length,
      vacuousTests: vacuousTests.length,
      deepestChain: deepest,
    },
    notes,
    modules,
    unusedModules: unused,
    noOpModules,
    vacuousTests,
    brokenReferences: broken,
  };
}

export interface UsageOptions {
  /** Case-insensitive substring of a module name. Lifts the importer-name cap. */
  module?: string | undefined;
}

/**
 * Fetches every test definition and builds the reverse index.
 *
 * @param options Optional narrowing of what is returned; the scan is unchanged.
 * @returns The reverse index.
 * @throws {GhostInspectorError} if the test listing itself fails.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function getModuleUsage(options: UsageOptions = {}): Promise<UsageReport> {
  const tests = await request<TestRecord[]>("GET", "tests", { timeoutMs: 120_000 });
  const { steps } = await fetchDefinitions(tests);
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
