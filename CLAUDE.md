# ghost-inspector-mcp

MCP server for the [Ghost Inspector](https://ghostinspector.com) REST API. Lets any MCP-capable agent (Claude, OpenAI, OpenCode, automations) **analyze, validate and safely update** end-to-end browser tests without using the Ghost Inspector web UI.

> **This is a standalone, vendor-neutral tool.** It is not part of, and must not depend on, any consumer's project.

## What this is / is NOT

| Is | Is NOT |
|---|---|
| A thin, safe wrapper over the GI REST API | A 1:1 mirror of every endpoint |
| A place where hard-won GI gotchas live as executable guardrails | A dumping ground for one company's workflow |
| Read-first, write-with-guards | A destructive admin console |

A 1:1 wrapper does not beat `curl`. The value of this server is in three things: **aggregations the API does not provide**, **guardrails on the write path**, and **tool descriptions that teach the calling model how not to break things**.

## 🔴 Non-negotiable: no consumer data in this repo

This repo is **private only until the first release, and is written as though it were already public.** Hold that line from the first commit: flipping private → public is one click, and it publishes the entire history at once. Nothing organization-specific ever gets committed — not in code, not in tests, not in docs, not in examples. A leak scrubbed in a later commit is still in the history.

**Never commit:**

- Organization / folder / suite / test IDs
- Folder or suite naming conventions of any specific account
- Test-data identities (names, emails, phone numbers used to fill forms)
- Target hostnames, staging URLs, or environment names
- Any credential, in any form — including truncated values or hashes

All of the above belongs to the **consumer's configuration**, passed via environment variables or tool arguments at call time. If you find yourself typing a hex ID into a source file, stop.

Use obviously fake placeholders in examples: `https://example.com`, `Jane Tester`, `jane@example.com`.

## 🔴 Non-negotiable: credentials

Ghost Inspector authenticates with **`?apiKey=` in the query string**, not a header. The credential lands in URLs, so it leaks into shell history, proxy logs, and AI conversation transcripts unless handled deliberately.

Rules for this server:

1. **The key is read from `GHOST_INSPECTOR_API_KEY` at call time**, never cached at startup. Changing the env var must take effect without restarting the server.
2. **There is no `set_api_key` tool, and there never will be.** Such a tool would require a user to type their secret into an agent conversation. That is the exact leak this project exists to avoid.
3. **The key is never logged, echoed, or included in an error message or tool response.** Not even partially.
4. **The server never writes the key to disk.**
5. When the key is missing or rejected, fail with an *actionable* message: where to obtain a key and how to export it — never with the value.

Ghost Inspector issues **per-user** API keys (Account Settings → API Access), and they can be regenerated at any time, which revokes the previous one immediately. Each operator uses their own key. Never design around a shared key.

Note: a per-user key still carries that user's permissions. If the user is an org admin, their key can delete anything. Per-user keys buy attribution and revocability, not least privilege — which is why the safety model below still matters.

## Safety model

**Read-only by default, but never invisible.** Every tool is registered and listed. Mutating tools refuse unless `GHOST_INSPECTOR_ALLOW_WRITES=true`, executing refuses unless `GHOST_INSPECTOR_ALLOW_RUNS=true`, and both checks happen **at call time, inside the handler**. An operator who did not opt in cannot mutate or execute anything, no matter what the calling model is convinced to do — that guarantee is unchanged, it simply lives in the handler now.

🔴 **Never gate by hiding.** A withheld tool and a nonexistent one look identical over the protocol. Observed in real use twice over: a model reported "this is not a permission that gets enabled, it is a capability the server does not expose", the user believed it, and the work stopped. `writesEnabled` was in `gi_whoami`'s response the whole time, but its description promised only credential checking, so nobody thought to call it.

**Registration controls visibility. The handler controls permission. Do not confuse the two.** An earlier version of this file said registering gated tools and refusing at call time "trades the guarantee for a message" — that was wrong. The guarantee is the `writesAllowed()` check; whether the tool appears in `tools/list` has nothing to do with it. Hiding bought no safety and cost the caller any way of learning the gate exists.

So: register everything, refuse in the handler, and make the refusal an instruction — name the variable, say nothing happened, give the exact command. Non-registration remains correct for one thing only: a capability that must not exist **at any setting**, like suite deletion, which is simply not implemented.

**Executing a stored test needs its own gate.** `GHOST_INSPECTOR_ALLOW_RUNS`, never folded into `ALLOW_WRITES`. The two consent to different things: a write is recoverable from the backup guard 2 returns, a submitted form is a record in someone else's system and nothing here withdraws it. On top of the gate, a per-call `confirmSubmit` is required **only when the test actually submits**, reusing the validation guard's detector so modules are inlined first. Friction only where there is consequence — a flag every call needs is one every caller sets by reflex, which is exactly why the write path refused a boolean confirmation. Measured on a real lead-gen account: 31 of 40 tests would require it, 9 would not, and none were flagged merely because a chain truncated.

**Never expose suite deletion.** `DELETE /suites/{id}/` exists (undocumented) and **cascades to every test in the suite**, with no version history and no recycle bin. The time it saves does not justify the blast radius from an agent. Leave it as a deliberate `curl` by someone who knows what they are doing.

**Write path guards** — every mutating tool performs these, and they are not skippable:

| Order | Guard | Why |
|---|---|---|
| 1 | Walk the full `execute` chain and compare each `dateUpdated` against the last run | A red test whose module was edited *after* its last run is **stale, not broken**. Overwriting it silently destroys a colleague's fix. One level deep is not enough — modules nest. |
| 2 | Fetch and return the complete prior definition | There is no version history. The returned backup **is** the rollback. |
| 3 | Apply the change | — |
| 4 | Re-`GET` and diff against what was sent | `HTTP 200` alone does not prove the write landed as intended. |

**Validate before persisting.** `POST /organizations/{orgId}/on-demand/execute` runs a test definition and discards it. Strip the submit `click` and end with an assertion on the submit button: this validates the entire selector chain **without saving anything and without submitting a real form**. Many Ghost Inspector tests submit live forms against production — treat `execute` as an action with real-world side effects.

## GI API contract the implementation must respect

Verified empirically. The official docs omit all of these.

**Envelope and errors**
- Every response is wrapped: `{"code": "SUCCESS", "data": ...}`, or `{"code": "ERROR", "errorType": "...", "message": "..."}`.
- 🔴 **A failed call still returns `HTTP 200`.** Status alone tells you nothing; `code` is the authority. Confirmed live: a `GET` for a well-formed but nonexistent result id answers `200` with `{"code":"ERROR","errorType":"VALIDATION_ERROR","message":"Result not found"}`.
- `errorType` is a machine-readable discriminator worth surfacing alongside `message` — "Result not found" alone does not distinguish a malformed id from an absent one from a purged one.
- A genuinely missing endpoint answers `404` with an **HTML** body, not the envelope. That is the discriminator for "this route does not exist" versus "this id does not exist", and it is how the resource list below was checked.

**Result endpoints** — verified live, because the wrong path here silently breaks every future execution feature.
- `GET /results/{id}/` ✅ exists — this is what `pollResult` uses.
- `GET /test-results/{id}/` 🔴 **does not exist** (404, HTML). Treat any note or doc that names a `test-results` resource as wrong.
- `GET /suite-results/{id}/` ✅ exists.
- `GET /tests/{id}/results/` ✅ **exists** — verified live 2026-08-06 against a control (`/tests/{id}/bogus/` → 404 HTML). Returns a list, newest first, **10 by default**; `count` is respected.
- 🔴 **Nothing on the test record points at a result, in any of its three shapes.** Checked field-by-field: the flat listing (31 fields), the suite-scoped listing (33), and `GET /tests/{id}/` (35). None carries a `lastResult` or any other result reference — the record has `passing` and the execution dates and nothing else. Treat any note claiming a `lastResult` field, expanded or not, as wrong. This route is the only way from a test to its history, and a feature that needs "why is this red" has no fallback if it is unavailable.
- Paginate with `count` and `offset` to walk backwards through runs. How far back that reaches is bounded by purging, so a regression can only be dated within the retained window — say "cannot see past X" rather than returning nothing.
- 🔴 **A result step's `target` collapses the authored fallback array to the single selector that was used** — and its *type is not stable*. Measured over 26 fallback-array steps paired via `extra.source`: **21 collapsed to a string, 5 stayed an array.** Of the 21, 18 were one of the authored candidates verbatim and **3 were a candidate stripped of its `xpath=` prefix**, so they match nothing in the definition by string comparison.
  - Consequences, all of which have bitten: code that assumes `string` breaks on 19% of steps; a reader concludes "the test looks for X" when it was authored to try X *or* Y; and searching the definition for the reported target can fail to find a step that plainly exists.
  - Any tool surfacing a result step's target must say it is the resolved selector, not the authored one, and show the authored chain beside it — from `gi_get_test` or `gi_validate_test`'s `dryRun`.
- **The listing includes `steps`,** so diagnosing a failure is **one request, not two** — no follow-up `GET /results/{id}/` is needed. Each step carries `command`, `target`, `value`, `passing`, `error`, `sequence`, `url`, `dateExecuted`. The failing step is the one with `passing: false`; its `error` holds the message.

**Mapping a failed step back to the test that owns it**
- Result steps are **expanded**: measured live, a 6-step definition produced a 15-step result. So a step's index in the result means nothing against the definition, and "fix step 9" is a wrong instruction on any test that imports a module.
- Each result step carries `extra.source = {test, sequence}` — **the test that contributed the step and its position inside that test** — plus `extra.rootSequence`, the position in the root test. Verified: all 15 steps carried a distinct `source`, and `rootSequence` spanned 0–5, matching the 6 definition steps. **This is the reverse map that makes an automated repair proposal possible**; without it the module that owns a failing step can only be guessed.
- 🔴 **A result step's `_id` is not a stable anchor into the definition.** Observed live: 16 of 17 result step ids matched the definition and the failing one did not, on a test whose `dateUpdated` *predates* the run by 35 seconds — so "the step was edited after the run" does not explain it and the cause is unknown. Anchor by `extra.source.test` + `extra.source.sequence`, never by step `_id`.

**Asynchrony** — 🔴 **the two execution endpoints do NOT behave the same way.** An earlier version of this file said they did; it was wrong, and the mistake aborts healthy runs.
- `POST /organizations/{orgId}/on-demand/execute` is **async**: `HTTP 200` in ~0.2s with a **pending** record (`passing: null`, `executionTime: null`). Poll `GET /results/{id}/`.
- 🔴 `POST /tests/{id}/execute/` **BLOCKS until the run finishes** and returns the completed result — `passing` already a boolean, `executionTime` already filled. Measured twice: **50s of wall time for runs of 29s and 32s**, the difference being queue wait. There is nothing to poll, and nothing comes back early.
- **Consequence for any caller: the wait must be spent on the request itself.** The client's default 60s timeout sits barely above the observed wall time, so a slightly slower run or a busier queue aborts a request for a run that is proceeding normally — and because the response never arrived, **no result id exists to look it up with**. `gi_run_test` passes an explicit 240s and, on expiry, reports the run as *started and still going* rather than as an error, pointing at `gi_test_result` to collect the outcome.
- 🔴 `passing: null` means *not finished*, not *failed*. Conflating them invents failures that do not exist.

**JavaScript steps**
- 🔴 `eval` and `assertEval` require an **explicit `return`**. Without it the expression evaluates to `undefined` → falsy → the assertion always fails, and it looks like a product bug.
- `eval` runs in the page's JS context; globals persist across steps.
- `assign` **does** dispatch `input` and `change`, so it reaches reactive stores and exercises input masks and validation. Do not "work around" it.

**Text assertions**
- 🔴 **`assertTextPresent` requires a `target`.** With an empty target it fails as `Text not contained` even when the text is plainly on the page — so the error blames the page rather than the step. Verified live: no target fails, `body` and a specific element both pass. Scope to `body` at minimum.

**Tests that assert nothing** — three distinct classes, only the first of which is detected today.
- 🔴 A test whose steps are only `execute` calls into modules with no steps **runs zero steps and passes** — nothing can fail. The dashboard shows it green while it verifies nothing, which is worse than red because nobody investigates green. Emptying one shared module does this to every test that imports it: measured on a real account, one emptied module left **85 of 454 tests (19%) passing vacuously** for a week. `gi_module_usage` reports these as `vacuousTests`.
- 🔴 **A test with no assertion at all.** It runs every step and can only fail if one errors, so it proves nothing about the page. Purely static to detect — no assertion command anywhere in the expanded chain — and by far the most common: **182 of 439 evaluated tests** on a real account. `gi_vacuous_tests` reports it as `assertsNothing`.
- 🔴 **A test whose final assertion was already true before the action.** Every step runs, the assertion passes, and it would pass with the feature completely broken — the target exists on the starting page too. Reported from real use: 4 of 5 green tests in one suite. **Not statically detectable**: a scan for "the final assert's target appears in an earlier step" finds zero, because the selector is never mentioned before — it is simply present on the page. `gi_vacuous_tests` therefore ships a *shortlist* (`worthChecking`, 90 on a real account): tests whose only assertion is the final step, where intermediate assertions cannot have narrowed what it means. 🔴 **Report it as a shortlist and never as a verdict** — a false positive here sends someone to delete working coverage. Settling one needs a run of the definition with the decisive action removed, checking whether the assertion still passes.
- **Cross-check that gives confidence in the detector:** `executesNothing` independently returned exactly 85, the same number the emptied-module incident produced. Two unrelated routes to one figure.

**Listing the account** — measured on a ~450-test account, 2026-08-05.
- 🔴 **There is no organization-scoped listing.** `/organizations/{id}/folders/`, `/suites/` and `/tests/` all 404 with an HTML body. For a whole-account view the flat collections are the only way in.
- **But folder- and suite-scoped listings do exist**, verified live 2026-08-06: `GET /folders/{id}/suites/` (11 suites, ~10 KB) and `GET /suites/{id}/tests/` (2 tests, ~2 KB). Per-test size matches the flat listing, so `steps` is absent from these too. They do not change the fetch-wide-summarise-locally rule for account-wide aggregations — one `GET /tests/` still beats 39 suite requests — but a tool answering about **one** folder or suite should not be downloading 438 KB to do it.
- `GET /folders/` ~1 KB · `GET /suites/` ~39 KB · `GET /tests/` ~438 KB (~112k tokens). Three requests describe an entire account, and **one `GET /tests/` beats one request per suite** against an undisclosed rate limit.
- A test's `suite` arrives **expanded** as `{_id, name}`; a suite's `folder` is a **bare id**. So test→suite is free, and only suite→folder needs the suite list.
- `suite.testCount` agrees with the actual test count. `suite.details` was empty on every suite — do not rely on it.
- Fetching ~440 KB to return ~10 KB is the expected shape of an aggregation here. Fetch wide, summarise, never forward the API's answer.

**Data model**
- `GET /tests/` does **not** include `steps`. Per-test `GET` is required for step data — so a module→importers reverse index costs one request per test.
- `target` may be an **array of fallback selectors**: `[{"selector": "..."}, ...]`, tried in order.
- `execute` steps nest modules, recursively. Results contain the **expanded** steps, so result step counts will not match definition step counts.
- A date of `1970-01-01` is the "never executed" sentinel, not corrupt data.
- Old results are purged. An old failure may be undiagnosable from the API.
- **`dateUpdated` is not bumped by executing a test.** The whole stale-versus-broken comparison rests on this: if a run touched `dateUpdated`, every test would read as edited-after-its-run and the triage would return noise. Confirmed on a real account, where 14 failures sit at `dateUpdated` ≤ last run.
- `dateUpdated` means *the record changed*, not *someone fixed it* — a rename or a suite move bumps it too. So the honest claim is "this result is out of date", never "this has been fixed".

**Modules** — a module is a test whose steps other tests import. It is Ghost Inspector's only unit of reuse: the equivalent of a function.

- The UI calls the step **"Import steps from test"**; the API calls the command **`execute`**. Same thing under two names — a model that has read the vendor docs will look for the wrong one.
- A module is a test with **`importOnly: true`** (UI: *Settings → Modularization → "Import Only"*). That flag prevents the test from running **directly or as part of a suite**, replaces its passing/failing status with the literal label `Import Only`, and **deletes its stored results**.
- 🔴 **Therefore every module is permanently "never executed": no results, `passing` not a boolean, last-run date at the `1970-01-01` sentinel.** Any aggregation that ranks by last-run date, or that reads "not passing" as "failing", will report every module in the account as the deadest, most broken thing in it — and recommend deleting precisely the code the live tests share. **Staleness and health tools must exclude `importOnly` tests before ranking, always.** This is the single most destructive wrong answer this server can give.
- Imports **nest up to 10 levels**. A `dateUpdated` chain walk therefore needs a hard depth cap of 10 *and* cycle detection — and 10 levels of fan-out collides with the request-count ceiling above, so bound the breadth too.
- **No scope isolation.** Imported steps are spliced in before execution, not run in a separate scope or browser, and the imported test's `startUrl` is **not** visited. A module cannot assume where it starts; its caller decides. This is also why `eval` globals cross the module boundary.
- A `condition` on an import step is **AND-ed with the conditions of the steps it imports**, accumulating at every level. Adding one condition to a module call silently gates everything beneath it, recursively.
- `importOnly` arrives in the cheap `GET /tests/` listing, so modules can be identified without paying the per-test `steps` fetch. Only the importer side of a reverse index costs N requests.
- **An `execute` step names its module in `value`** — a 24-char hex test id. `target` is empty on these steps. That single field is the whole edge list of the dependency graph.
- 🔴 **`importOnly` prevents a test being *run* directly; it does not stop others *importing* it.** So a normal, schedulable test can also be someone's module, running standalone and inside its importers at once — an edit changes both paths. Index whatever is imported, never whatever is flagged. Measured on a real account: 19 imported tests, only 14 flagged.
- `test.links` is always `[]`. It looks like a shortcut to related resources and is not one.
- Measured cost of the reverse index: ~80 ms per test request, so ~450 tests take **~7 s at concurrency 5**. Affordable, but keep the concurrency low — the rate limit has no published numbers.
- 🔴 **A direct importer count understates risk.** Real chains observed: a module with 31 direct importers reaches 55 transitively, and one with a *single* direct importer reaches 22. Always report the transitive closure; anyone reading "1 importer" would treat that module as safe to edit.

**Writes**
- `POST /tests/{id}/` accepts `steps` (undocumented) and a partial update **preserves every other field**.
- `POST /suites/{id}/` accepts `folder` (undocumented) and moves the suite with its tests. Reversible.
- `POST /folders/` creates. **`DELETE /folders/{id}/` does not exist** (404, HTML body) — an empty folder can only be removed from the UI, so folder names must be right the first time.
- ✅ **`POST /suites/` creates a suite.** Verified live 2026-08-06, first by probing with an incomplete body (with a valid `organization` and no name it answers *"Could not create suite: Suite should have required property 'name'"* — a schema validator refusing a create, not a missing route), then by creating one. `{organization, name}` is the minimum, and **`folder` is honoured at create time**, so no follow-up move is needed. It will happily create a second suite with an existing name; nothing distinguishes them afterwards.
- ✅ **`POST /tests/{id}/` accepts `suite` and moves the test** — undocumented, verified live. It travels in the same partial update as `name`, and `steps` are preserved. This is what makes a duplicate usable: a copy is born in the source's suite, and this is the only way to put it anywhere else.
- **`POST /tests/{id}/duplicate/` returns the whole new record** — steps included, `suite` expanded, `dateUpdated` present, name suffixed `" (Copy)"`, `passing: null`, `importOnly` copied. So a duplicate-then-place flow needs no extra read.
- ⚠️ **Whether a duplicate inherits a scheduled `testFrequency` is NOT verified,** and deliberately so: confirming it means letting a scheduled clone exist, and in an account whose tests submit live forms against production one unintended run is a real record in someone's CRM. `gi_duplicate_test` clears the schedule unless the caller opts out. Pin this to the safe direction rather than measuring it.
- `DELETE /tests/{id}/` and `DELETE /suites/{id}/` both answer with a `SUCCESS` envelope. Neither is exposed as a tool; suite deletion cascades.
- 🔴 **There is no endpoint for creating a test — now confirmed empirically, not just from the docs.** `POST /tests/` answers `200` with the **flat test listing**: it is a read route that tolerates POST, not a create. Two other guesses 404 with HTML (`POST /organizations/{id}/tests/`) or are likewise listings (`POST /suites/{id}/tests/`, `POST /folders/{id}/suites/`). 🔴 **A `SUCCESS` envelope from a POST does not mean something was created — check whether `data` is the object or a list.** Verified against the vendor's own API reference too, which documents update, duplicate and delete but no create. Do not guess a route: the documented way to get a new test is `POST /tests/{id}/duplicate/` (returns a copy in the same suite, name suffixed `(Copy)`) followed by an update. That needs a source test, so it is not the same operation as "create" and must not be presented as one.
- `POST /tests/{id}/duplicate/` accepts GET or POST. It is also the safe way to learn a write contract: experiment on the clone, verify, apply to the real test, delete the clone.
- **Writes take a concurrency token, not a confirmation flag.** The caller states the `dateUpdated` it believes is current and the write is refused if the record moved. A boolean "yes I'm sure" is exactly what a persuaded model will set; a timestamp it must have actually read is not guessable.
- 🔴 **A token is only unguessable while a read tool returns it.** Shipped in 0.1.1, no read tool exposed `dateUpdated` and the refusal handed back the current value, so the only route to a write was to send a wrong token on purpose and harvest the right one from the rejection. Observed in real use: a model planned exactly that, unprompted, because it was the sole available path. The guard proved nothing and the normal flow began with a deliberate failure. `gi_get_test` exists to be that read. **Any future guard that demands proof of a read must ship with the read that supplies it, in the same release.**
- Keep the current value in the refusal — it is part of diagnosing a real conflict — but the message must send the caller back to `gi_get_test` to *recompose* the change, never invite a resend. Replaying an edit built against a definition that is no longer stored overwrites whatever replaced it, and there is no version history.
- **Guard 4 has two halves.** Diff what was sent against what is stored, *and* diff every field that was not sent against the backup. The partial-update-preserves-everything behaviour above is undocumented, so verify it on every write rather than trusting it.
- 🔴 **Ghost Inspector normalises steps on write.** It fills `condition: null`, `optional: false`, `private: false` and a `sequence` on everything it stores. A naive round-trip comparison therefore reports a difference on every step that omitted a field, and verification screams about a write that landed perfectly. Normalise **both sides** to the stored shape before diffing. Verified live: three sent steps produced three phantom `optional` diffs until the sent side was defaulted.
- `dateUpdated` **is** bumped by a write, unlike by an execution. That is what makes it usable as a concurrency token.
- ⚠️ **The token narrows the race window, it does not close it.** There is no compare-and-swap, so the check is read-then-write client side: two writers who both read before either wrote will both pass. It catches acting on a copy read minutes or days ago — the realistic case — not a genuine concurrent race. Say that rather than implying stronger guarantees.

## Design principle: tool descriptions are the product

The calling model reads every tool description and every error message. That is where the knowledge lives — not in a README nobody opens.

Write descriptions that **steer authoring**, for example:

- Anchor selectors to semantic, stable attributes (`data-*`, `name`, `id`) and scope them to a container id. Never `:nth-of-type`, never XPath matching visible copy, never long chains of presentational classes.
- A selector that matches more than one element is a latent failure: it works until the DOM reorders, then fails in a way that does not point at the cause.
- Conditional fields: forms may reveal additional **required** fields based on an earlier answer. Unfilled, they block submission silently — the visible symptom is a failed assertion on the destination page, not on the missing field.
- Send unformatted input values and assert the formatted result, so the test exercises the mask instead of bypassing it.

Error messages follow the same rule: say what to do next, not just what went wrong.

## Stack & conventions

- **TypeScript, ESM, Node >= 18.** Distribution target is `npx`, so a teammate needs zero setup beyond Node.
- **`@modelcontextprotocol/sdk` pinned to `^1.x`.** Pin the major deliberately: the Python SDK's 1.x → 2.0 removed `mcp.server.fastmcp` and broke every server that had not pinned. Do not widen this range without testing.
- Dependencies stay minimal. Every added dependency is a supply-chain liability for an artifact that runs with other people's API keys.
- One function style per file. `const` by default, `let` only when reassigned, never `var`.
- JSDoc on exported functions: the why, `@param`, `@return`, `@throws` where it applies.
- Tool input schemas are declared with `zod` so the model gets validation errors it can act on. It is a direct dependency even while no tool takes arguments yet — authoring schemas means importing it, and importing a transitive dependency of the SDK instead would be relying on someone else's dependency graph. 🔴 **Keep it on `^4`.** The SDK accepts `^3.25 || ^4.0`, and zod changed its API across that major. Two zod copies in one tree make schema identity checks fail in ways that read as "the model sent bad arguments". One copy, pinned.

## Commands

```bash
npm ci
npm run typecheck
npm test               # builds first, then runs the suite
npm run build          # tsc -> dist/
npm run dev            # watch mode
npm start              # run the built server over stdio

# smoke test against a real account (needs your own key)
export GHOST_INSPECTOR_API_KEY="$(cat ~/.gi-key)"
npm run build && node dist/index.js
```

## Testing conventions

- **No test dependencies.** Node's own `node:test` and `node:assert/strict`. `npm test` is `node --test`, which scans the tree and skips `node_modules`. Do not pass `node --test test/` — that resolves the directory as a module and fails.
- **Tests import from `dist/`**, so `pretest` builds. There is no test transpiler and there does not need to be one.
- **Name a test after what breaks if it fails**, not after the function it calls. A failure name should tell you what you broke.
- **Pin the direction of every uncertain case**, and say why in a comment. Most of this codebase's safety comes from erring consistently: an unknown date reads as *never executed*, an unparseable `dateUpdated` reads as *changed*, a truthy-but-not-`true` flag reads as *not a module*. Those are the assertions worth having.
- **Pure logic stays separable from the fetch**, so it can be exercised with hand-built fixtures and no network. Every real defect found late in this project was found that way: the `neverExecuted` counter treating passing tests as unrun, the phantom step diff, the cap applied inside a pure function.
- `server.test.js` starts the real server over stdio. It is the only thing that catches a registration or schema mistake, and where the write gate is proven end to end. **No test configures an API key**, so the suite never reaches Ghost Inspector.
- **Run a CI step locally before trusting it.** Two bugs in the workflow were caught that way: `node -e script VAR=x` passes argv rather than environment, and a credential grep loose enough to match the suite's own placeholder.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `GHOST_INSPECTOR_API_KEY` | yes | Per-user key from Account Settings → API Access |
| `GHOST_INSPECTOR_ORG_ID` | for on-demand execution | Consumer's organization id — config, never hardcoded |
| `GHOST_INSPECTOR_ALLOW_WRITES` | no (default `false`) | Registers the mutating tools when `true` |
| `GHOST_INSPECTOR_ALLOW_RUNS` | no (default `false`) | Registers `gi_run_test` when `true`. Deliberately **not** implied by `ALLOW_WRITES` |

**Environment variables only — do not add `dotenv` or an `.env` file.** This ships as a global command with no project directory of its own, so a `.env` beside the source would not be read in the installed case anyway. More to the point, a second sanctioned place to keep the key is a second place to leak it, which is the opposite of this project's purpose. The documented path is `~/.gi-key` at `600` plus an export in the shell profile. An `.env.example` existed briefly and was removed for promising a mechanism nothing implemented; `.env*` stays in `.gitignore` so a file created out of habit can never be committed.

## Scope discipline

Ideas that do not belong here:

- CI / deploy-gate integration → that is a CI job calling the API, not an MCP server.
- Scheduled triage digests → that is a scheduled script with a webhook, and it serves people who do not use agents.
- Anything that only makes sense for one organization's folder layout or workflow.

When in doubt: if it would not make sense to a Ghost Inspector customer who has never heard of the consumer's projects, it does not go in this repo.
