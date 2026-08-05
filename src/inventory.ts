/**
 * Account overview — the folder → suite → test tree, aggregated.
 *
 * Read-only. Costs four requests and returns roughly two hundredth of what it
 * fetched, which is the point: `GET /tests/` alone is ~440 KB (~112k tokens) on
 * a mid-sized account, so a tool that forwarded the API's answer would spend
 * most of a context window on one call. Everything is summarised here instead.
 *
 * There is no organization-scoped listing endpoint — `/organizations/{id}/tests/`
 * and friends return 404 with an HTML body. The flat collections are the only
 * way in, and one `GET /tests/` beats one request per suite against an
 * undisclosed rate limit.
 */

import {
  hasNeverExecuted,
  isModule,
  request,
  type FolderRecord,
  type SuiteRecord,
  type TestRecord,
} from "./client.js";

/** How a test is counted. Module wins over everything else. */
type TestState = "passing" | "failing" | "module" | "notRun";

/** Counter field each state increments. Keeps the state names readable. */
const COUNTER = {
  passing: "passing",
  failing: "failing",
  module: "modules",
  notRun: "notRun",
} as const satisfies Record<TestState, "passing" | "failing" | "modules" | "notRun">;

export interface SuiteSummary {
  name: string;
  tests: number;
  passing: number;
  failing: number;
  /** Import-only tests. Never counted as failing or stale. */
  modules: number;
  /** Not a module, and `passing` is not a boolean: queued, running, or never run. */
  notRun: number;
  /** Present only when non-empty. */
  failingTests?: string[];
}

export interface FolderSummary {
  name: string;
  suites: SuiteSummary[];
}

export interface Overview {
  organizations: string[];
  totals: {
    folders: number;
    suites: number;
    tests: number;
    passing: number;
    failing: number;
    modules: number;
    notRun: number;
    /** Non-modules that have never completed a run. The real stale signal. */
    neverExecuted: number;
  };
  notes: string[];
  folders: FolderSummary[];
}

const UNFILED = "(no folder)";

/**
 * Classifies a test for counting.
 *
 * 🔴 The module check comes first and is not reorderable. Marking a test
 * import-only deletes its results, so a module's `passing` is never a boolean
 * and its last-run date sits at the 1970 epoch sentinel. Testing `passing`
 * first would file every module under "failing" or "not run" and turn shared
 * steps into apparent breakage.
 */
function classify(test: TestRecord): TestState {
  if (isModule(test)) return "module";
  if (test.passing === true) return "passing";
  if (test.passing === false) return "failing";
  return "notRun";
}

/**
 * Folds the three collections into the tree, without any network access.
 *
 * @param folders From `GET /folders/`.
 * @param suites From `GET /suites/`; `folder` is a bare id.
 * @param tests From `GET /tests/`; `suite` arrives expanded as `{_id, name}`.
 * @param organizations Display names, for labelling only.
 * @returns The aggregate, with folders and suites sorted by name.
 */
export function summarize(
  folders: FolderRecord[],
  suites: SuiteRecord[],
  tests: TestRecord[],
  organizations: string[],
): Overview {
  const folderName = new Map(folders.map((f) => [f._id, f.name ?? "(unnamed)"]));
  const suiteToFolder = new Map(
    suites.map((s) => [s._id, s.folder ? (folderName.get(s.folder) ?? UNFILED) : UNFILED]),
  );

  const blank = (name: string): SuiteSummary => ({
    name,
    tests: 0,
    passing: 0,
    failing: 0,
    modules: 0,
    notRun: 0,
  });

  // Seed from the suite list so an empty suite still appears — a suite with no
  // tests is a real finding, and counting only from tests would hide it.
  const summaries = new Map<string, SuiteSummary>(
    suites.map((s) => [s._id, blank(s.name ?? "(unnamed)")]),
  );
  const failing = new Map<string, string[]>();
  const totals = { passing: 0, failing: 0, modules: 0, notRun: 0, neverExecuted: 0 };

  for (const test of tests) {
    const suiteId = test.suite && typeof test.suite === "object"
      ? (test.suite as { _id?: string })._id
      : undefined;
    const summary = suiteId ? summaries.get(suiteId) : undefined;
    const state = classify(test);

    totals[COUNTER[state]] += 1;
    // Only meaningful for a test that is not reporting a pass or a fail: a
    // boolean `passing` proves it ran, whatever the date field says. Gating on
    // "notRun" separates a test that has genuinely never executed from one that
    // is merely queued or mid-flight.
    if (state === "notRun" && hasNeverExecuted(test)) totals.neverExecuted += 1;

    if (!summary) continue;
    summary.tests += 1;
    summary[COUNTER[state]] += 1;
    if (state === "failing" && suiteId) {
      const names = failing.get(suiteId) ?? [];
      names.push(test.name ?? "(unnamed)");
      failing.set(suiteId, names);
    }
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const grouped = new Map<string, SuiteSummary[]>();

  for (const [suiteId, summary] of summaries) {
    const names = failing.get(suiteId);
    if (names?.length) summary.failingTests = names.sort();
    const folder = suiteToFolder.get(suiteId) ?? UNFILED;
    grouped.set(folder, [...(grouped.get(folder) ?? []), summary]);
  }

  const notes = [
    `${totals.modules} import-only module(s) are listed separately and are never counted as failing or stale: marking a test import-only deletes its results, so a module always looks unrun.`,
  ];
  if (totals.neverExecuted > 0) {
    notes.push(
      `${totals.neverExecuted} non-module test(s) have never completed a run. Those are genuinely stale, unlike the modules.`,
    );
  }
  if (organizations.length > 1) {
    notes.push(
      `This key reaches ${organizations.length} organizations and the folders below span all of them.`,
    );
  }

  return {
    organizations,
    totals: {
      folders: folders.length,
      suites: suites.length,
      tests: tests.length,
      ...totals,
    },
    notes,
    folders: [...grouped.entries()]
      .map(([name, list]) => ({ name, suites: list.sort(byName) }))
      .sort(byName),
  };
}

interface OrganizationRecord {
  _id: string;
  name?: string;
}

export interface InventoryOptions {
  /** Case-insensitive substring match on folder name. */
  folder?: string | undefined;
  /** Drop suites with no failing tests. Totals still cover the whole account. */
  failingOnly?: boolean | undefined;
}

/**
 * Fetches and summarises the account.
 *
 * @param options Optional narrowing of what is returned; the fetch is unchanged.
 * @returns The aggregate. Totals always describe the whole account, so a
 *   filtered view cannot be mistaken for the full picture.
 * @throws {GhostInspectorError} on an API failure.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function getInventory(options: InventoryOptions = {}): Promise<Overview> {
  const [organizations, folders, suites, tests] = await Promise.all([
    request<OrganizationRecord[]>("GET", "organizations"),
    request<FolderRecord[]>("GET", "folders"),
    request<SuiteRecord[]>("GET", "suites"),
    // The big one. A slow link needs more than the default window.
    request<TestRecord[]>("GET", "tests", { timeoutMs: 120_000 }),
  ]);

  const overview = summarize(
    folders,
    suites,
    tests,
    organizations.map((o) => o.name ?? o._id),
  );

  let view = overview.folders;
  if (options.folder) {
    const needle = options.folder.toLowerCase();
    view = view.filter((f) => f.name.toLowerCase().includes(needle));
  }
  if (options.failingOnly) {
    view = view
      .map((f) => ({ ...f, suites: f.suites.filter((s) => s.failing > 0) }))
      .filter((f) => f.suites.length > 0);
  }
  if (view !== overview.folders) {
    overview.notes.push(
      `Filtered view: ${view.length} of ${overview.folders.length} folder(s) shown. Totals above cover the whole account.`,
    );
    overview.folders = view;
  }
  return overview;
}
