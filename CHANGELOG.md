# Changelog

This project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Tool names, input schemas and MCP annotations are part of the interface here: a
calling model's behaviour depends on them, and a client may gate permissions on
them. Changes to any of those are listed even when no code path moved.

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
