/** Finding tests by name, folder, suite or what their own steps do. */

import { request, type FolderRecord, type SuiteRecord, type TestRecord } from "./client.js";
import { fetchDefinitionsClosure, type Steps } from "./graph.js";
import { resolveScope } from "./scope.js";

export interface StepFilter {
  /** Exact command, case-insensitively. */
  command?: string | undefined;
  /** Part of any selector the step authored, fallbacks included. */
  target?: string | undefined;
  /** Part of the step's value. */
  value?: string | undefined;
}

export interface FindFilter {
  /** Part of the test's name, case-insensitively. */
  name?: string | undefined;
  folder?: string | undefined;
  suite?: string | undefined;
  step?: StepFilter | undefined;
  limit?: number | undefined;
}

export interface StepMatch {
  index: number;
  command: string;
  target: string;
  value: string;
}

export interface Found {
  id: string;
  name: string;
  suite: { id: string; name: string } | null;
  folder: { id: string; name: string } | null;
  importOnly: boolean;
  passing: boolean | null;
  stepMatches?: StepMatch[];
}

export interface FindReport {
  total: number;
  matches: Found[];
  notes: string[];
}

const DEFAULT_LIMIT = 50;

/**
 * The tests whose listing fields match: name, folder and suite, all that are given.
 *
 * @param tests Every test.
 * @param suites Every suite.
 * @param folders Every folder.
 * @param filter What to match.
 * @return The matching tests, in listing order.
 */
export function matchListing(
  tests: TestRecord[],
  suites: SuiteRecord[],
  folders: FolderRecord[],
  filter: Pick<FindFilter, "name" | "folder" | "suite">,
): TestRecord[] {
  const scope = resolveScope(filter, folders, suites, tests);
  const needle = filter.name?.trim().toLowerCase() ?? "";
  return tests.filter(
    (test) => (!scope || scope.ids.has(test._id)) && (!needle || (test.name ?? "").toLowerCase().includes(needle)),
  );
}

/**
 * The steps of one test's own list that match every given field.
 *
 * @param steps The test's own steps, modules not inlined.
 * @param filter What to match.
 * @return The matching steps with their positions.
 */
export function matchSteps(steps: Steps, filter: StepFilter): StepMatch[] {
  const command = filter.command?.trim().toLowerCase() ?? "";
  const target = filter.target?.toLowerCase() ?? "";
  const value = filter.value?.toLowerCase() ?? "";
  const matches: StepMatch[] = [];
  for (const [index, step] of steps.entries()) {
    const selectors = selectorsIn(step["target"]);
    const stepValue = typeof step["value"] === "string" ? step["value"] : "";
    if (command && String(step["command"] ?? "").toLowerCase() !== command) continue;
    if (target && !selectors.some((selector) => selector.toLowerCase().includes(target))) continue;
    if (value && !stepValue.toLowerCase().includes(value)) continue;
    matches.push({ index, command: String(step["command"] ?? ""), target: selectors.join(" | "), value: stepValue.slice(0, 200) });
  }
  return matches;
}

/**
 * A test as a search result: its id, where it lives and its state.
 *
 * @param test The test record from the listing.
 * @param suites Every suite, for the folder.
 * @param folders Every folder, for its name.
 * @return The result entry.
 */
export function describeFound(test: TestRecord, suites: SuiteRecord[], folders: FolderRecord[]): Found {
  const suiteRef = test["suite"];
  const suiteId = suiteRef && typeof suiteRef === "object" ? String((suiteRef as { _id?: unknown })._id ?? "") : "";
  const suite = suites.find((entry) => entry._id === suiteId);
  const folder = folders.find((entry) => entry._id === String(suite?.folder ?? ""));
  return {
    id: test._id,
    name: test.name ?? "(unnamed)",
    suite: suiteId ? { id: suiteId, name: String(suite?.name ?? (suiteRef as { name?: unknown }).name ?? "") } : null,
    folder: folder ? { id: folder._id, name: folder.name ?? "" } : null,
    importOnly: test.importOnly === true,
    passing: test.passing === true || test.passing === false ? test.passing : null,
  };
}

/**
 * Searches the account: the listing for name, folder and suite, then each remaining test's own steps.
 *
 * @param filter What to look for.
 * @return Matches with ids, capped at `limit`, and the full count.
 * @throws {GhostInspectorError} on an API failure.
 */
export async function findTests(filter: FindFilter): Promise<FindReport> {
  const [tests, suites, folders] = await Promise.all([
    request<TestRecord[]>("GET", "tests", { timeoutMs: 120_000 }),
    request<SuiteRecord[]>("GET", "suites"),
    request<FolderRecord[]>("GET", "folders"),
  ]);
  const limit = Math.max(1, filter.limit ?? DEFAULT_LIMIT);
  const listed = matchListing(tests, suites, folders, filter);
  const notes: string[] = [];
  const step = filter.step;
  const searchSteps = Boolean(step && (step.command || step.target || step.value));

  let found: Found[] = listed.map((test) => describeFound(test, suites, folders));
  if (searchSteps && step) {
    const ids = listed.map((test) => test._id);
    const definitions = await fetchDefinitionsClosure(ids, undefined, 0);
    found = found
      .map((entry) => ({ ...entry, stepMatches: matchSteps(definitions.steps.get(entry.id) ?? [], step) }))
      .filter((entry) => entry.stepMatches.length > 0);
    notes.push(
      "Steps are matched in each test's own list, modules not inlined, so a match inside a module is reported on the module, not on the tests that import it — gi_module_usage lists those.",
    );
    if (definitions.unreadable > 0) {
      notes.push(`⚠️ ${definitions.unreadable} definition(s) could not be read, so a match there would be missing.`);
    }
  }
  if (found.length > limit) notes.push(`Showing ${limit} of ${found.length}. Narrow the search or raise limit.`);
  return { total: found.length, matches: found.slice(0, limit), notes };
}

/**
 * Every selector a target offers.
 *
 * @param target A step's target: a string or a fallback array.
 * @return The selectors.
 */
function selectorsIn(target: unknown): string[] {
  if (typeof target === "string") return target ? [target] : [];
  if (!Array.isArray(target)) return [];
  return target.map((entry) => String((entry as { selector?: unknown })?.selector ?? "")).filter(Boolean);
}
