# Changelog

This project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Tool names, input schemas and MCP annotations are part of the interface here: a
calling model's behaviour depends on them, and a client may gate permissions on
them. Changes to any of those are listed even when no code path moved.

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
