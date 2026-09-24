# Changelog

This project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Tool names, input schemas and MCP annotations are part of the interface here: a
calling model's behaviour depends on them, and a client may gate permissions on
them. Changes to any of those are listed even when no code path moved.

## [0.3.0] — 2026-09-24

Fixes from a real-use audit. A failure inside a module pointed at the wrong
step. A validation ran against the wrong host with the wrong user agent. The
submit guard missed what it could not read. A stored basic-auth password
reached the transcript. Six tools are added to date regressions, find tests,
group failures and handle screenshots.

### Fixed

- 🔴 **Stored credentials never reach a response.** Test and suite records carry
  `httpAuthUsername` / `httpAuthPassword` in plain text, and `gi_update_test`
  returned them inside `backup`. Credential-shaped keys are stripped from every
  tool result, at the source and again on the way out. Private variable values
  are masked as `(private)` in validation reports.
- 🔴 **A failure inside a module maps to the step that failed.**
  `extra.source.sequence` copies the stored `sequence` field, which a client
  that omits it leaves at 0 on every step, so every failure mapped to the
  module's first step. `gi_test_result` now aligns the result with a local
  expansion of the current definition, by position. It falls back to the stored
  sequence only when that is exactly `0..n-1`, and otherwise reports the step as
  `unmapped`. `gi_propose_repair` refuses an unmapped step.
- **The write path stores each step's position** as its `sequence`, and guard 4
  verifies it, along with `name` and `startUrl`.
- 🔴 **Validations resolve `{{variables}}`.** On-demand execution ignores custom
  variables and runs an unknown one as an empty string, so a suite-variable host
  became `https://.example.com/` and could still pass. Variables resolve from the
  caller, then the suite, then the organization. An unresolved one refuses the
  run before anything is sent.
- **Validations run with the suite's configuration.** User agent, region,
  language, the delays and the rest are sent in the body, not only viewport and
  browser. `settingsCheck` reports any setting the result says it did not
  honour. HTTP basic auth is never sent.
- 🔴 **Step conditions are read and written as `{statement}`**, the shape Ghost
  Inspector stores them in. Read as strings they were dropped, so validations
  ran conditional steps unconditionally and guard 4 missed a changed condition.
  On-demand refuses a string condition outright.
- 🔴 **The submit guard has three layers.**
  - (A) The static cut now also reads `extractEval` bodies and every step
    condition for `.submit(`, `requestSubmit(`, `.click(`, `dispatchEvent(`,
    `fetch(`, `XMLHttpRequest`, `sendBeacon(`, `$.ajax`, `$.post` and `axios`.
  - (B) A probe in the browser stops the run before any click on a form's
    submit control, on a non-field control inside a form, or on a target that
    cannot be resolved.
  - (C) A tripwire, armed before every step, blocks submit events,
    `form.submit()`, non-GET fetch and XHR, and `sendBeacon`, and reports what
    it blocked.

  `gi_run_test` also asks for `confirmSubmit` when a button or form control is
  clicked after a field was filled.
- **`gi_run_test` reports where a submitting run went** instead of asserting that
  it submitted, and says when the run ended on the page it started on.
- **Run reports tell the truth about what ran.** `stepsExecuted` counts only steps
  that ran. `executionTimeMs` is rebuilt from the timestamps when absent, and a
  result is re-read until its timing is filled. Console output is read from the
  fields the API actually sends.

### Added

- **`gi_plan_test`** (read-only): exactly what a validation would send, with every
  guard decision and variable, and whether it would be refused. No key, org or
  browser is involved.
- **`gi_find_tests`** (read-only): tests by name, folder, suite or step, with ids.
- **`gi_test_history`** (read-only): up to 500 runs, the last pass, and the first
  failure of the current red streak, with an honest horizon.
- **`gi_failure_groups`** (read-only): red tests grouped by when they started
  failing, across suites, with common errors and targets.
- **`gi_screenshot_status`** (read-only) and **`gi_accept_screenshot`** (write
  gate). Accepting is refused unless `expectedResultId` is still the latest
  finished result with a failing comparison, and the response returns the
  baseline it replaced. Accepting does not move `dateUpdated`.
- `folder` / `suite` filters on `gi_stale_tests`, `gi_vacuous_tests` and
  `gi_module_usage`. The module listing keeps its account-wide blast radius.
- `testIds` (1–20) on `gi_get_test` and `gi_test_result`; `expandModules` on
  `gi_get_test`.
- `startUrl` on `gi_update_test` and `gi_duplicate_test`.
- `gi_validate_test`: `suiteId`, `variables`, `stopBefore`, `verbose`, plus
  `resultId`, `evidence`, per-step `value`, and statuses `skipped by condition`
  and `stopped by guard`.
- Backups on disk: `GHOST_INSPECTOR_BACKUP_DIR` (default
  `~/.ghost-inspector-mcp/backups`, directory 700, file 600, no credentials), on
  every write path, refusals included.

### Changed

- **Contract:** `gi_module_usage` `importerNames` → `importers: [{id, name}]`, and
  modules carry `id`. `gi_inventory` `failingTests` → `[{id, name}]`.
  `gi_validate_test` `consoleErrors` → `evidence.console`. `guard` is always an
  object, and its static fields are null when nothing was cut.
- `gi_update_test` returns `backupFile` + `backupSummary`, plus the new
  `dateUpdated` for the next edit. The full backup is inline only with
  `verbose: true`, or when the file cannot be written.
- `gi_validate_test`'s `dryRun` still works and is deprecated in favour of
  `gi_plan_test`. After a run, `plan` is omitted unless `verbose`.

## [0.2.0] — 2026-08-06

The diagnose → repair → verify cycle. 0.1.x could say which tests were worth
looking at; it could not say what happened inside one, run one to check a fix,
or create anything.

### Added

- **`gi_test_result`** — why one test is red: the failing step, its error, and
  which test or module owns it. Leads with the staleness verdict, because a
  result that predates a change is not evidence. Reports the selectors a step
  was *authored* with alongside the one that resolved.
- **`gi_run_test`** — executes a test exactly as saved, behind its own
  `GHOST_INSPECTOR_ALLOW_RUNS` gate. A test that submits a form is refused
  unless confirmed on that call; a test that submits nothing runs without
  ceremony.
- **`gi_propose_repair`** — turns a diagnosis into a concrete proposal and
  applies nothing. Separates rewrites that follow from the contract from
  advisories that would need the DOM, rather than inventing a selector.
- **`gi_vacuous_tests`** — green tests that prove nothing, in three classes:
  runs zero steps, runs steps with no assertion anywhere, or a shortlist whose
  lone final assertion may have been true before the test acted.
- **`gi_get_test`** — one test's definition plus the `dateUpdated` the write
  path requires as its concurrency token.
- **`gi_create_suite`** and **`gi_duplicate_test`** — Ghost Inspector has no
  endpoint that creates a test, so a copy of an existing one is the only route
  and the tool is named for what it does. Suites can be created outright.

### Changed

- 🔴 **Gated tools are now listed and refuse when called, instead of being
  hidden.** Withholding a tool by not registering it is indistinguishable over
  the protocol from the tool not existing, and the observed result was an agent
  reporting that this server could not write at all. The guarantee is unchanged
  — the check moved into the handler — but a caller without the opt-in now gets
  an instruction naming the variable to set instead of a silence.
- `gi_stale_tests` findings carry the test id and its `dateUpdated`, so a repair
  follows from the report that found it without a second read.
- The concurrency-token refusal sends the caller back to re-read and recompose
  rather than resend.

### Fixed

- **The write token was harvestable, and that was the only way to get one.** No
  read tool returned `dateUpdated`, so the sole path to a write was to send a
  wrong token and take the correct one from the refusal — which proves nothing
  about having read the record. `gi_get_test` supplies it properly.
- **`POST /tests/{id}/execute/` blocks until the run finishes**, unlike
  `on-demand/execute`. The wait now goes on the request itself; the API client's
  60s default would have aborted healthy runs and left no result id to recover
  them with.

## [0.1.1] — 2026-08-05

### Fixed

- **Guard 4 now verifies both directions.** `diffUntouched` compared only the
  keys present in the prior definition, so a field that existed *only after* the
  write was invisible to it — the one kind of unexpected change where "nothing
  else moved" could be reported without having been checked. It now compares the
  union of both key sets.
- **The pre-write chain walk no longer re-expands a shared module.**
  `collectChainIds` followed every path independently, so two importers
  converging on one module re-loaded that module's entire subtree once per path,
  and this walk runs before every write. Each module is now expanded once, at the
  shallowest depth it is reached from. Cycle detection moved from the walked path
  to the recorded edges: going around a loop only increases depth, so the return
  edge always lands on an already-expanded node, and a missed cycle would read as
  a complete answer.

### Added

- `server.json` and the `mcpName` manifest field, for the official MCP registry.
- `glama.json`, claiming the auto-crawled Glama listing.
- One-click install links for VS Code and per-client configuration examples,
  including why a client launched from a desktop icon may not see your key.
- A `types` entry pointing at the declarations already emitted by the build.
- `SECURITY.md`.
- This changelog.

### Changed

- Nothing in the tool surface: same seven tools, same schemas, same annotations.
  An 0.1.0 client sees an identical interface.

## [0.1.0] — 2026-08-05

First release. Seven tools over the Ghost Inspector API — five read-only, and two
mutating ones registered only when `GHOST_INSPECTOR_ALLOW_WRITES=true`:

- `gi_whoami`, `gi_inventory`, `gi_module_usage`, `gi_stale_tests`,
  `gi_validate_test` (read), `gi_update_test`, `gi_move_suite` (write).
- Read-only by default; suite deletion deliberately not exposed.
- Four non-skippable write guards plus an optimistic-concurrency token.
- Validation through on-demand execution, with modules inlined and the run
  truncated before any step that could submit a form.
