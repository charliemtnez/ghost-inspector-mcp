/**
 * Bringing new suites and tests into existence.
 *
 * Asymmetric on purpose, because the API is:
 *   - `POST /suites/` is a real create. Verified live 2026-08-06: with a valid
 *     `organization` and no name it answers "Suite should have required
 *     property 'name'", a schema validator refusing a create.
 *   - There is **no create for a test**. `POST /tests/` is the flat listing
 *     wearing a POST, and the vendor documents update, duplicate and delete
 *     with no create. A new test can only be a copy of an existing one, so
 *     that is what this module offers — under its real name.
 *
 * Both are additive: they bring something into being and overwrite nothing, so
 * neither takes the concurrency token the update path requires. What they do
 * need is protection against the two ways an agent makes a mess here — a
 * near-duplicate nobody notices, and a clone that inherits a schedule.
 */

import { requireOrgId } from "./config.js";
import { request, type SuiteRecord, type TestRecord } from "./client.js";
import { toDetail, type TestDetail } from "./detail.js";

export interface CreateSuiteOptions {
  name: string;
  /** Defaults to GHOST_INSPECTOR_ORG_ID. */
  organization?: string | undefined;
  /** Honoured at create time — verified; no follow-up move is needed. */
  folder?: string | undefined;
  /** Proceed even though a suite of this name already exists here. */
  allowDuplicateName?: boolean | undefined;
}

export interface CreateSuiteResult {
  created: boolean;
  refusedBecause?: string;
  suite: { id: string; name: string; folder: string | null } | null;
  notes: string[];
}

/**
 * Suites that would collide with a new one of this name.
 *
 * Comparison is case-insensitive and trimmed: "Checkout" beside "checkout " is
 * the confusion this refusal exists to prevent, not a distinction worth
 * preserving. With no folder given the whole account is the scope, because an
 * unfiled suite can end up anywhere.
 *
 * @param existing Every suite in the account.
 * @param name The proposed name, already trimmed.
 * @param folder Restrict the check to one folder, or undefined for all.
 */
export function nameClashes(
  existing: SuiteRecord[],
  name: string,
  folder?: string | undefined,
): SuiteRecord[] {
  const wanted = name.trim().toLowerCase();
  return existing.filter(
    (suite) =>
      (suite.name ?? "").trim().toLowerCase() === wanted &&
      (folder === undefined || String(suite.folder ?? "") === folder),
  );
}

/**
 * The fields a fresh copy gets patched with.
 *
 * Separated from the calls so the schedule default stays provable: the copy is
 * silenced unless the caller opts out, and that must not regress quietly.
 *
 * @param options The caller's request.
 * @returns The update body; empty when nothing needs changing.
 */
export function plannedChanges(options: DuplicateTestOptions): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (options.name !== undefined && options.name.trim()) changes["name"] = options.name.trim();
  if (options.suiteId !== undefined) changes["suite"] = options.suiteId;
  if (options.keepSchedule !== true) {
    changes["testFrequency"] = 0;
    changes["testFrequencyAdvanced"] = [];
  }
  return changes;
}

/**
 * Creates a suite, refusing a same-named sibling unless told otherwise.
 *
 * The duplicate check is the whole value here: `POST /suites/` will happily
 * make a second "Checkout Tests" beside the first, and nothing in the UI
 * distinguishes them afterwards. Folders cannot be deleted through the API at
 * all, and a stray suite is a permanent piece of clutter someone else has to
 * reason about.
 *
 * @param options Name, and where to put it.
 * @returns The new suite, or a refusal naming the conflict.
 * @throws {GhostInspectorError} when the API rejects the create.
 * @throws {ConfigError} when no organization is configured or passed.
 */
export async function createSuite(options: CreateSuiteOptions): Promise<CreateSuiteResult> {
  const name = options.name.trim();
  if (!name) {
    return {
      created: false,
      refusedBecause: "a suite needs a name",
      suite: null,
      notes: ["Ghost Inspector rejects a nameless suite, and an empty name cannot be found again."],
    };
  }

  const organization = options.organization?.trim() || requireOrgId();
  const existing = await request<SuiteRecord[]>("GET", "suites");
  const clashes = nameClashes(existing, name, options.folder);

  if (clashes.length > 0 && options.allowDuplicateName !== true) {
    return {
      created: false,
      refusedBecause: "a suite with this name already exists",
      suite: null,
      notes: [
        `${clashes.length} existing suite(s) already use the name "${name}"${
          options.folder ? " in this folder" : " somewhere in the account"
        }: ${clashes.map((s) => s._id).join(", ")}.`,
        "Two suites with one name are indistinguishable in the UI afterwards, and a suite cannot be tidied away as easily as it is made. Reuse the existing one, pick a different name, or pass allowDuplicateName if the repetition is deliberate.",
      ],
    };
  }

  const body: Record<string, unknown> = { organization, name };
  if (options.folder !== undefined) body["folder"] = options.folder;
  const created = await request<SuiteRecord>("POST", "suites", { body });

  const notes: string[] = [];
  if (options.folder !== undefined && String(created.folder ?? "") !== options.folder) {
    notes.push(
      "⚠️ The folder came back different from the one requested. Move it with gi_move_suite before adding tests.",
    );
  }
  notes.push(
    "There is no API route to delete a suite through this server, and none at all for folders. Check the name is right before filling it.",
  );

  return {
    created: true,
    suite: {
      id: String(created._id),
      name: String(created.name ?? name),
      folder: created.folder === undefined ? null : String(created.folder),
    },
    notes,
  };
}

export interface DuplicateTestOptions {
  sourceTestId: string;
  /** Defaults to Ghost Inspector's own "<source> (Copy)". */
  name?: string | undefined;
  /** Where the copy should land. Defaults to the source's suite. */
  suiteId?: string | undefined;
  /**
   * Keep whatever schedule the copy inherited. Off by default, and the default
   * is the safe one — see {@link duplicateTest}.
   */
  keepSchedule?: boolean | undefined;
}

export interface DuplicateTestResult {
  created: boolean;
  test: TestDetail | null;
  /** Set when the copy exists but a follow-up step failed; it needs cleanup. */
  orphaned?: string;
  notes: string[];
}

/**
 * Creates a new test as a copy of an existing one, then places and renames it.
 *
 * 🔴 This is not a create, and must not be described as one. Ghost Inspector
 * has no endpoint that builds a test from nothing, so every new test descends
 * from an existing one and a source is mandatory.
 *
 * 🔴 The copy's schedule is cleared unless `keepSchedule` is set. Whether
 * `duplicate` inherits `testFrequency` from a scheduled source is **not
 * verified** — confirming it would mean letting a scheduled clone exist, and in
 * an account whose tests submit live forms against production, a single
 * unintended run is a real lead in someone's CRM. The uncertain case is pinned
 * to the safe direction: clear it, always, and let an operator opt back in.
 *
 * @param options The source, and where the copy should end up.
 * @returns The new test, including the `dateUpdated` a later edit will need.
 * @throws {GhostInspectorError} when the source does not exist or a call fails.
 */
export async function duplicateTest(options: DuplicateTestOptions): Promise<DuplicateTestResult> {
  const copy = await request<TestRecord>("POST", `tests/${options.sourceTestId}/duplicate`);
  const copyId = String(copy._id ?? "");
  if (!copyId) {
    return {
      created: false,
      test: null,
      notes: ["Ghost Inspector accepted the duplicate but returned no id, so the copy cannot be placed or named."],
    };
  }

  const notes: string[] = [];
  const changes = plannedChanges(options);
  if (options.keepSchedule !== true) {
    notes.push(
      "Schedule cleared on the copy. If the source runs on a schedule, an inherited one would have started submitting whatever this test submits, unattended. Pass keepSchedule to keep it.",
    );
  }

  if (Object.keys(changes).length === 0) {
    return { created: true, test: toDetail(copy, copyId), notes };
  }

  let placed: TestRecord;
  try {
    placed = await request<TestRecord>("POST", `tests/${copyId}/`, { body: changes });
  } catch (error) {
    // The copy is already real. Saying so is the difference between a stray
    // "(Copy)" someone finds in six months and one the caller deletes now.
    return {
      created: true,
      test: toDetail(copy, copyId),
      orphaned: copyId,
      notes: [
        `🔴 The copy was created as ${copyId} but could not be placed or renamed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "It exists in the source's suite under the default \"(Copy)\" name, with whatever schedule it inherited. Fix it or delete it now.",
        ...notes,
      ],
    };
  }

  const detail = toDetail(placed, copyId);
  if (options.suiteId !== undefined && detail.suite?.id !== options.suiteId) {
    notes.push("⚠️ The copy did not land in the requested suite. Verify before relying on it.");
  }
  notes.push(
    "The copy carries the source's steps verbatim. Edit them with gi_update_test, passing the dateUpdated returned here as expectedDateUpdated.",
  );
  return { created: true, test: detail, notes };
}
