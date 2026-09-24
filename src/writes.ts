/**
 * The write path. Registered only when GHOST_INSPECTOR_ALLOW_WRITES=true.
 *
 * Ghost Inspector keeps **no version history of test steps and no recycle bin**.
 * An overwrite is permanent, so every mutating call here performs four guards in
 * order, and none of them can be turned off:
 *
 * 1. **Staleness.** Walk the whole `execute` chain and compare each
 *    `dateUpdated` against the test's last run. A red test whose module was
 *    edited *after* that run is stale, not broken: the failure describes a
 *    version that no longer exists, so a fix derived from it is derived from
 *    nothing. One level deep is not enough, because modules nest.
 * 2. **Backup.** Return the complete prior definition. There is nowhere else to
 *    get it — the returned object *is* the rollback.
 * 3. **Apply.**
 * 4. **Verify.** Re-read and diff, both that what was sent landed exactly and
 *    that everything not sent is untouched. `HTTP 200` proves neither.
 *
 * Writing also requires an optimistic-concurrency token: the caller states the
 * `dateUpdated` it believes is current, and the write is refused if the record
 * has moved since. A confirmation flag can be talked past by a persuaded model;
 * a timestamp it has to have actually read cannot be guessed.
 *
 * That last sentence only holds because gi_get_test returns the token. While no
 * read tool exposed it, the sole way to obtain one was to send a wrong value and
 * harvest the right one from the refusal below — so the intended "prove you read
 * the record" degraded into a two-step handshake that proved nothing. Any future
 * token must stay readable through a read tool, or it becomes theatre again.
 *
 * ⚠️ The token narrows the window; it cannot close it. Ghost Inspector has no
 * compare-and-swap, so the check is read-then-write on this side: two writers
 * who both read before either wrote will both pass. It catches the realistic
 * case — acting on a copy read minutes or days ago — not a genuine race.
 *
 * Suite deletion is never exposed. `DELETE /suites/{id}/` cascades to every test
 * in the suite with no undo, and that blast radius does not belong behind an
 * agent. It stays a deliberate `curl` by someone who knows what they are doing.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasNeverExecuted,
  isModule,
  request,
  type SuiteRecord,
  type TestRecord,
} from "./client.js";
import { collectChainIds, pool, REQUEST_CONCURRENCY, type Steps } from "./graph.js";
import { backupDir } from "./config.js";
import { isCredentialKey, stripCredentials } from "./redact-record.js";

/** Step fields that define behaviour, `sequence` included: results copy it as their only map back. */
const STEP_FIELDS = ["command", "target", "value", "variableName", "condition", "optional", "sequence"] as const;

/**
 * Ghost Inspector normalises steps on write: it fills `condition: null`,
 * `optional: false`, `private: false` and a `sequence` on everything it stores.
 * So a naive round-trip comparison reports a difference on every step that
 * omitted a field, and verification screams about a write that landed perfectly.
 * Both sides get normalised to the stored shape before being compared.
 */
function normalizeStep(step: Record<string, unknown>): Record<string, unknown> {
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const target = step["target"];
  return {
    command: text(step["command"]),
    // A target may be an array of fallback selectors, tried in order.
    target: Array.isArray(target) ? JSON.stringify(target) : text(target),
    value: text(step["value"]),
    variableName: text(step["variableName"]),
    condition: text(step["condition"]) === "" ? null : text(step["condition"]),
    optional: step["optional"] === true,
    sequence: typeof step["sequence"] === "number" ? step["sequence"] : null,
  };
}

/**
 * The body of a test update, every step's `sequence` overwritten with its index.
 *
 * @param options The fields being changed.
 * @returns The JSON body for `POST /tests/{id}/`.
 */
export function buildUpdateBody(
  options: Pick<UpdateOptions, "steps" | "name">,
): { steps?: Steps; name?: string } {
  const body: { steps?: Steps; name?: string } = {};
  if (options.steps !== undefined) body.steps = options.steps.map((step, i) => ({ ...step, sequence: i }));
  if (options.name !== undefined) body.name = options.name;
  return body;
}

export interface ChainChange {
  name: string;
  dateUpdated: string;
  /** True for the test itself rather than a module in its chain. */
  isSelf: boolean;
}

export interface StalenessVerdict {
  /** False when the test has never run, so there is nothing to compare against. */
  comparable: boolean;
  lastRun: string | null;
  /** Anything in the chain edited after the last run. Non-empty means stale. */
  changedAfterLastRun: ChainChange[];
  chainSize: number;
  /** True when the chain hit the nesting limit, so the verdict is incomplete. */
  chainTruncated: boolean;
  /** Only meaningful when the test is currently failing. */
  currentlyFailing: boolean;
  verdict: "stale" | "current" | "never run" | "not comparable";
}

/**
 * Guard 1. Compares the whole `execute` chain against the test's last run.
 *
 * @param test The test being changed, freshly read.
 * @param chain Module records reachable from it.
 * @param truncated Whether the chain walk was cut short.
 * @returns What changed after the last run, and the resulting verdict.
 */
export function assessStaleness(
  test: TestRecord,
  chain: TestRecord[],
  truncated: boolean,
): StalenessVerdict {
  const stamp = test.dateExecutionFinished ?? test.dateExecutionTriggered;
  const lastRunMs = Date.parse(String(stamp));

  if (hasNeverExecuted(test) || Number.isNaN(lastRunMs)) {
    return {
      comparable: false,
      lastRun: null,
      changedAfterLastRun: [],
      chainSize: chain.length,
      chainTruncated: truncated,
      currentlyFailing: test.passing === false,
      verdict: "never run",
    };
  }

  const changed: ChainChange[] = [];
  const consider = (record: TestRecord, isSelf: boolean): void => {
    const raw = record.dateUpdated;
    const ms = raw ? Date.parse(String(raw)) : NaN;
    // An unreadable timestamp counts as changed. Calling a stale test current
    // is what invites the overwrite; the opposite error costs a second look.
    if (Number.isNaN(ms) || ms > lastRunMs) {
      changed.push({
        name: record.name ?? "(unnamed)",
        dateUpdated: raw ? String(raw) : "(unreadable)",
        isSelf,
      });
    }
  };
  consider(test, true);
  for (const module of chain) consider(module, false);

  return {
    comparable: true,
    lastRun: new Date(lastRunMs).toISOString(),
    changedAfterLastRun: changed,
    chainSize: chain.length,
    chainTruncated: truncated,
    currentlyFailing: test.passing === false,
    verdict: changed.length > 0 ? "stale" : "current",
  };
}

export interface FieldDiff {
  field: string;
  sent: unknown;
  stored: unknown;
}

/**
 * Guard 4, for steps. Compares behaviour-defining fields, in order.
 *
 * @returns Mismatches, empty when the stored steps match what was sent.
 */
export function diffSteps(sent: Steps, stored: Steps): FieldDiff[] {
  const out: FieldDiff[] = [];
  if (sent.length !== stored.length) {
    out.push({ field: "steps.length", sent: sent.length, stored: stored.length });
  }
  for (let i = 0; i < Math.min(sent.length, stored.length); i += 1) {
    const a = normalizeStep(sent[i] ?? {});
    const b = normalizeStep(stored[i] ?? {});
    for (const field of STEP_FIELDS) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        out.push({ field: `steps[${i}].${field}`, sent: a[field], stored: b[field] });
      }
    }
  }
  return out;
}

/** Guard 4, for everything not sent: it must be exactly as it was. */
export function diffUntouched(
  before: TestRecord,
  after: TestRecord,
  sentFields: string[],
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const ignore = new Set([...sentFields, "dateUpdated", "steps"]);
  // Both sides, not just `before`: a field that exists only *after* the write
  // is as much an unexpected change as one whose value moved, and iterating the
  // prior definition alone can never see it appear.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignore.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      const stored = isCredentialKey(key) ? "(redacted)" : stripCredentials(after[key]);
      out.push({ field: key, sent: "(not sent)", stored });
    }
  }
  return out;
}

export interface UpdateResult {
  applied: boolean;
  refusedBecause?: string;
  /** The record's current `dateUpdated`: the `expectedDateUpdated` of the next edit. */
  dateUpdated: string;
  staleness: StalenessVerdict;
  /** 🔴 The complete prior definition, credentials removed. Inline only with `verbose` or when the file failed. */
  backup?: TestRecord;
  /** 🔴 Where the prior definition was saved. There is no version history — this file is the rollback. */
  backupFile?: string;
  backupSummary?: BackupSummary;
  sentFields: string[];
  verification: {
    stepsMatch: boolean;
    stepDiffs: FieldDiff[];
    untouchedFieldsIntact: boolean;
    unexpectedChanges: FieldDiff[];
  } | null;
  notes: string[];
}

export interface UpdateOptions {
  testId: string;
  steps?: Steps | undefined;
  name?: string | undefined;
  /** The `dateUpdated` the caller believes is current. Proof it read the record. */
  expectedDateUpdated: string;
  /** Required to proceed when guard 1 reports the test as stale. */
  confirmStaleDiagnosis?: boolean | undefined;
  /** Also return the backup inline, for clients that cannot read the file. */
  verbose?: boolean | undefined;
}

export interface BackupSummary {
  name: string;
  startUrl: string;
  stepCount: number;
  dateUpdated: string;
}

export interface BackupOutcome {
  file: string | null;
  error: string | null;
}

/**
 * Guard 2 on disk: saves the prior definition, credentials removed, readable only by its owner.
 *
 * @param record The test as read before the write.
 * @return The file written, or why it could not be.
 */
export function saveBackup(record: TestRecord): BackupOutcome {
  const dir = backupDir();
  const stamp = String(record.dateUpdated ?? "undated").replace(/[:.]/g, "-");
  const file = join(dir, `${String(record._id ?? "unknown")}-${stamp}.json`);
  try {
    const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (created !== undefined) chmodSync(dir, 0o700);
    writeFileSync(file, JSON.stringify(stripCredentials(record), null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
    return { file, error: null };
  } catch (error) {
    return { file: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Points a result at its backup file, keeping the backup inline when asked or when the file failed.
 *
 * @param result A result carrying the backup inline.
 * @param saved What saveBackup reported.
 * @param verbose Keep the inline backup even though the file exists.
 * @return The result the caller receives.
 */
export function withBackup(result: UpdateResult, saved: BackupOutcome, verbose: boolean): UpdateResult {
  const record: Partial<TestRecord> = result.backup ?? {};
  const summary: BackupSummary = {
    name: String(record.name ?? ""),
    startUrl: String(record.startUrl ?? ""),
    stepCount: Array.isArray(record.steps) ? record.steps.length : 0,
    dateUpdated: String(record.dateUpdated ?? ""),
  };
  if (saved.file === null) {
    return {
      ...result,
      backupSummary: summary,
      notes: [
        ...result.notes,
        `⚠️ The backup file could not be written (${saved.error}), so the prior definition is inline as \`backup\`. Keep it: it is the only rollback.`,
      ],
    };
  }
  const { backup, ...rest } = result;
  return { ...rest, ...(verbose ? { backup } : {}), backupFile: saved.file, backupSummary: summary };
}

/** What updateTest knows before it writes, shared by every response it builds. */
export interface WriteContext {
  before: TestRecord;
  staleness: StalenessVerdict;
  sentFields: string[];
  chainLength: number;
}

/**
 * The response to a write that was refused. Guard 2: the backup still comes back.
 *
 * @param context The record as read, and the staleness verdict.
 * @param why The refusal reason.
 * @param notes What to do next.
 * @returns A result with nothing applied.
 */
export function refusedResult(context: WriteContext, why: string, notes: string[]): UpdateResult {
  return {
    applied: false,
    refusedBecause: why,
    dateUpdated: String(context.before.dateUpdated ?? ""),
    staleness: context.staleness,
    backup: stripCredentials(context.before),
    sentFields: context.sentFields,
    verification: null,
    notes,
  };
}

/**
 * The response to an applied write: guard 4's diff of the re-read against what was sent.
 *
 * @param context The record as read before the write, and the staleness verdict.
 * @param body What was sent.
 * @param after The record as re-read after the write.
 * @returns The verification, the backup and the token for the next edit.
 */
export function appliedResult(
  context: WriteContext,
  body: ReturnType<typeof buildUpdateBody>,
  after: TestRecord,
): UpdateResult {
  const { before, staleness, sentFields } = context;
  const stepDiffs = body.steps !== undefined ? diffSteps(body.steps, (after.steps ?? []) as Steps) : [];
  const unexpected = diffUntouched(before, after, sentFields);
  const dateUpdated = String(after.dateUpdated ?? "");

  const notes: string[] = [
    "🔴 The backup is the complete prior definition and the only rollback that exists. Keep it until you are sure of this change.",
    `dateUpdated is now "${dateUpdated}": pass this as expectedDateUpdated for the next edit.`,
  ];
  if (stepDiffs.length > 0) {
    notes.push(
      `🔴 THE WRITE DID NOT LAND AS SENT: ${stepDiffs.length} step difference(s) after re-reading. Compare and consider restoring from backup.`,
    );
  }
  if (unexpected.length > 0) {
    notes.push(
      `🔴 ${unexpected.length} field(s) changed that were never sent: ${unexpected.map((d) => d.field).join(", ")}. A partial update is documented to preserve everything else, so this contradicts the contract — verify before trusting it.`,
    );
  }
  if (stepDiffs.length === 0 && unexpected.length === 0) {
    notes.push("Verified: what was sent landed exactly, and nothing else moved.");
  }
  if (staleness.verdict === "stale") {
    notes.push(
      "Applied over a stale diagnosis because confirmStaleDiagnosis was passed. If that was wrong, restore from backup now.",
    );
  }
  if (body.name !== undefined) {
    notes.push(
      `Renaming does not move the test between suites or folders, and importers reference it by id, so its ${context.chainLength ? "chain and " : ""}importers are unaffected.`,
    );
  }

  return {
    applied: true,
    dateUpdated,
    staleness,
    backup: stripCredentials(before),
    sentFields,
    verification: {
      stepsMatch: stepDiffs.length === 0,
      stepDiffs,
      untouchedFieldsIntact: unexpected.length === 0,
      unexpectedChanges: unexpected,
    },
    notes,
  };
}

/**
 * Updates a test's steps or name, behind the four guards.
 *
 * @param options The change, plus the concurrency token.
 * @returns What was refused or applied, the prior definition, and the diff.
 * @throws {GhostInspectorError} on an API failure.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function updateTest(options: UpdateOptions): Promise<UpdateResult> {
  if (options.steps === undefined && options.name === undefined) {
    throw new Error("Nothing to change: pass steps, name, or both.");
  }

  const before = await request<TestRecord>("GET", `tests/${options.testId}`);

  const cache = new Map<string, Steps>();
  const loadSteps = async (id: string): Promise<Steps> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const record = id === options.testId ? before : await request<TestRecord>("GET", `tests/${id}`);
    const steps = (record.steps ?? []) as Steps;
    cache.set(id, steps);
    return steps;
  };

  // Guard 1, before anything else: the chain, not just the test. Fetched at
  // the same bounded concurrency as the account scans — the fan-out multiplies
  // against an undisclosed rate limit.
  const { ids, truncated } = await collectChainIds(options.testId, loadSteps);
  const chain = await pool(ids, REQUEST_CONCURRENCY, (id) => request<TestRecord>("GET", `tests/${id}`));
  const staleness = assessStaleness(before, chain, truncated);

  const sentFields = [
    ...(options.steps !== undefined ? ["steps"] : []),
    ...(options.name !== undefined ? ["name"] : []),
  ];

  const context: WriteContext = { before, staleness, sentFields, chainLength: chain.length };
  const saved = saveBackup(before);
  const verbose = options.verbose === true;
  const refuse = (why: string, notes: string[]): UpdateResult =>
    withBackup(refusedResult(context, why, notes), saved, verbose);

  if (String(before.dateUpdated ?? "") !== options.expectedDateUpdated) {
    return refuse("concurrency token mismatch", [
      `expectedDateUpdated was "${options.expectedDateUpdated}" but the record now reads "${String(before.dateUpdated ?? "")}".`,
      "Someone changed this test since you read it, or you never read it. Nothing was written.",
      "🔴 Do not simply resend with the value above. Your change was composed against a definition that is no longer stored, so replaying it would overwrite whatever that other edit did — and there is no version history to recover it from. Call gi_get_test, read what is there now, redo the change against it, and pass the dateUpdated it returns. The current definition is in the backup (`backupFile`, or `backup` with verbose) if you want to diff first.",
    ]);
  }

  if (staleness.verdict === "stale" && options.confirmStaleDiagnosis !== true) {
    const who = staleness.changedAfterLastRun
      .map((c) => `${c.isSelf ? "the test itself" : `module "${c.name}"`} at ${c.dateUpdated}`)
      .join("; ");
    return refuse("stale: the last run predates a change in the chain", [
      `Last run ${staleness.lastRun}. Changed after it: ${who}.`,
      staleness.currentlyFailing
        ? "🔴 This test is currently FAILING, and that failure describes a definition that no longer exists. Someone may already have fixed it. A fix diagnosed from this result is diagnosed from nothing, and overwriting destroys their work — there is no version history."
        : "The last result predates a change, so it says nothing about the current definition.",
      "Validate the current definition first (gi_validate_test runs it without saving or submitting), or wait for a fresh run. If you have done that and still mean to overwrite, pass confirmStaleDiagnosis. Nothing was written.",
      staleness.chainTruncated
        ? "⚠️ The chain hit the nesting limit, so more of it may have changed than is listed."
        : "",
    ].filter(Boolean));
  }

  // Guard 3.
  const body = buildUpdateBody(options);
  await request<TestRecord>("POST", `tests/${options.testId}`, { body });

  // Guard 4. HTTP 200 does not prove the write landed as intended.
  const after = await request<TestRecord>("GET", `tests/${options.testId}`);
  return withBackup(appliedResult(context, body, after), saved, verbose);
}

export interface MoveResult {
  applied: boolean;
  refusedBecause?: string;
  /** Prior folder id. Pass it back to undo the move. */
  previousFolder: string | null;
  suite: { name: string; testCount: number | null };
  verification: { folderChanged: boolean; testCountIntact: boolean; storedFolder: string | null } | null;
  notes: string[];
}

export interface MoveOptions {
  suiteId: string;
  /** Destination folder id. */
  folderId: string;
  /** The folder id the caller believes the suite is in now. */
  expectedCurrentFolder: string;
}

/**
 * Moves a suite between folders, with its tests.
 *
 * Reversible, unlike everything else on the write path: the prior folder id
 * comes back in `previousFolder`. Still verified by re-reading, and still
 * guarded by a concurrency token, because a move applied to the wrong suite is
 * only cheap to undo if you notice.
 *
 * @param options Destination, plus the folder the caller expects it to be in.
 * @returns What moved, how to undo it, and the verification.
 * @throws {GhostInspectorError} on an API failure.
 * @throws {ConfigError} when the API key is not configured.
 */
export async function moveSuite(options: MoveOptions): Promise<MoveResult> {
  const before = await request<SuiteRecord & Record<string, unknown>>(
    "GET",
    `suites/${options.suiteId}`,
  );
  const currentFolder = before.folder ? String(before.folder) : "";
  const summary = { name: before.name ?? "(unnamed)", testCount: before.testCount ?? null };

  if (currentFolder !== options.expectedCurrentFolder) {
    return {
      applied: false,
      refusedBecause: "the suite is not in the folder you expected",
      previousFolder: currentFolder || null,
      suite: summary,
      verification: null,
      notes: [
        `expectedCurrentFolder was "${options.expectedCurrentFolder}" but the suite is in "${currentFolder}".`,
        "Either you are targeting the wrong suite or it has already been moved. Nothing was written.",
      ],
    };
  }

  if (currentFolder === options.folderId) {
    return {
      applied: false,
      refusedBecause: "already in the destination folder",
      previousFolder: currentFolder || null,
      suite: summary,
      verification: null,
      notes: ["Nothing to do, and nothing was written."],
    };
  }

  await request("POST", `suites/${options.suiteId}`, { body: { folder: options.folderId } });

  const after = await request<SuiteRecord & Record<string, unknown>>(
    "GET",
    `suites/${options.suiteId}`,
  );
  const storedFolder = after.folder ? String(after.folder) : null;
  const folderChanged = storedFolder === options.folderId;
  const testCountIntact = (after.testCount ?? null) === summary.testCount;

  const notes: string[] = [
    `To undo: move it back to "${currentFolder}".`,
    "The suite moves with its tests; nothing is detached.",
  ];
  if (!folderChanged) {
    notes.push(
      `🔴 THE MOVE DID NOT LAND: the suite reads folder "${storedFolder}" rather than "${options.folderId}".`,
    );
  }
  if (!testCountIntact) {
    notes.push(
      `🔴 testCount changed from ${summary.testCount} to ${after.testCount ?? null}. A move should not touch it — investigate before doing anything else.`,
    );
  }
  if (folderChanged && testCountIntact) {
    notes.push("Verified: the suite is in the destination folder with its test count intact.");
  }
  notes.push(
    "Folders cannot be deleted through the API (DELETE /folders/{id}/ does not exist), so an empty folder left behind can only be removed from the web UI.",
  );

  return {
    applied: true,
    previousFolder: currentFolder || null,
    suite: summary,
    verification: { folderChanged, testCountIntact, storedFolder },
    notes,
  };
}

/** Re-exported so callers can filter a chain without another import. */
export { isModule };
