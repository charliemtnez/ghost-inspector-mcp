/** Narrowing an account-wide question to one folder or suite. */

import { request, type FolderRecord, type SuiteRecord, type TestRecord } from "./client.js";

export interface ScopeFilter {
  /** Folder id, or part of its name. */
  folder?: string | undefined;
  /** Suite id, or part of its name. */
  suite?: string | undefined;
}

export interface Scope {
  ids: Set<string>;
  description: string;
}

/**
 * The tests a folder or suite filter selects, matching each by exact id or by name, case-insensitively.
 *
 * @param filter The folder and/or suite asked for; both narrow together.
 * @param folders Every folder.
 * @param suites Every suite.
 * @param tests Every test.
 * @return The selected test ids and a description of the match, or null when no filter was given.
 */
export function resolveScope(
  filter: ScopeFilter,
  folders: FolderRecord[],
  suites: SuiteRecord[],
  tests: TestRecord[],
): Scope | null {
  const folderQuery = filter.folder?.trim() ?? "";
  const suiteQuery = filter.suite?.trim() ?? "";
  if (!folderQuery && !suiteQuery) return null;

  const matches = (record: { _id: string; name?: string | undefined }, query: string): boolean =>
    record._id === query || (record.name ?? "").toLowerCase().includes(query.toLowerCase());
  const folderIds = new Set(folders.filter((folder) => matches(folder, folderQuery)).map((folder) => folder._id));
  const chosen = suites.filter(
    (suite) =>
      (!folderQuery || folderIds.has(String(suite.folder ?? ""))) && (!suiteQuery || matches(suite, suiteQuery)),
  );
  const suiteIds = new Set(chosen.map((suite) => suite._id));
  const ids = new Set(
    tests
      .filter((test) => {
        const suite = test["suite"];
        const id = suite && typeof suite === "object" ? String((suite as { _id?: unknown })._id ?? "") : String(suite ?? "");
        return suiteIds.has(id);
      })
      .map((test) => test._id),
  );

  const parts = [
    folderQuery ? `folder "${folderQuery}" (${folderIds.size} match)` : "",
    suiteQuery ? `suite "${suiteQuery}"` : "",
  ].filter(Boolean);
  return { ids, description: `${parts.join(", ")}: ${chosen.length} suite(s), ${ids.size} test(s)` };
}

/**
 * Resolves a filter against the account's folders and suites, fetching them only when a filter is given.
 *
 * @param filter The folder and/or suite asked for.
 * @param tests Every test, already fetched.
 * @return The scope, or null for the whole account.
 * @throws {GhostInspectorError} when the folders or suites cannot be read.
 */
export async function scopeFor(filter: ScopeFilter, tests: TestRecord[]): Promise<Scope | null> {
  if (!filter.folder?.trim() && !filter.suite?.trim()) return null;
  const [folders, suites] = await Promise.all([
    request<FolderRecord[]>("GET", "folders"),
    request<SuiteRecord[]>("GET", "suites"),
  ]);
  return resolveScope(filter, folders, suites, tests);
}

/**
 * The note that opens a scoped report.
 *
 * @param scope The resolved scope.
 * @param detail What the report did with the scope, said only when something matched.
 * @return What was scanned, and a warning when nothing matched.
 */
export function scopeNote(
  scope: Scope,
  detail = "The modules those tests import were read wherever they live.",
): string {
  return scope.ids.size === 0
    ? `⚠️ Scoped to ${scope.description}: nothing matched, so nothing was evaluated. Folder and suite match by exact id or by part of the name.`
    : `Scoped to ${scope.description}. ${detail}`;
}
