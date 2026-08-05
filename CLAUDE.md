# ghost-inspector-mcp

MCP server for the [Ghost Inspector](https://ghostinspector.com) REST API. Lets any MCP-capable agent (Claude, OpenAI, OpenCode, automations) **create, update and analyze** end-to-end browser tests without using the Ghost Inspector web UI.

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

**Read-only by default.** Write tools are only registered when `GHOST_INSPECTOR_ALLOW_WRITES=true`. An operator who did not opt in cannot mutate anything, no matter what the calling model is convinced to do.

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

**Asynchrony**
- `execute` and `on-demand/execute` return `HTTP 200` in ~0.2s with a **pending** record: `passing: null`, `executionTime: null`. Poll `GET /results/{id}/`. A browser run takes 20-70s.
- 🔴 `passing: null` means *not finished*, not *failed*. Conflating them invents failures that do not exist.

**JavaScript steps**
- 🔴 `eval` and `assertEval` require an **explicit `return`**. Without it the expression evaluates to `undefined` → falsy → the assertion always fails, and it looks like a product bug.
- `eval` runs in the page's JS context; globals persist across steps.
- `assign` **does** dispatch `input` and `change`, so it reaches reactive stores and exercises input masks and validation. Do not "work around" it.

**Listing the account** — measured on a ~450-test account, 2026-08-05.
- 🔴 **There is no organization-scoped listing.** `/organizations/{id}/folders/`, `/suites/` and `/tests/` all 404 with an HTML body. The flat collections are the only way in.
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
npm install
npm run build          # tsc -> dist/
npm run dev            # watch mode
npm start              # run the built server over stdio

# smoke test against a real account (needs your own key)
export GHOST_INSPECTOR_API_KEY="$(cat ~/.gi-key)"
npm run build && node dist/index.js
```

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `GHOST_INSPECTOR_API_KEY` | yes | Per-user key from Account Settings → API Access |
| `GHOST_INSPECTOR_ORG_ID` | for on-demand execution | Consumer's organization id — config, never hardcoded |
| `GHOST_INSPECTOR_ALLOW_WRITES` | no (default `false`) | Registers the mutating tools when `true` |

**Environment variables only — do not add `dotenv` or an `.env` file.** This ships as a global command with no project directory of its own, so a `.env` beside the source would not be read in the installed case anyway. More to the point, a second sanctioned place to keep the key is a second place to leak it, which is the opposite of this project's purpose. The documented path is `~/.gi-key` at `600` plus an export in the shell profile. An `.env.example` existed briefly and was removed for promising a mechanism nothing implemented; `.env*` stays in `.gitignore` so a file created out of habit can never be committed.

## Scope discipline

Ideas that do not belong here:

- CI / deploy-gate integration → that is a CI job calling the API, not an MCP server.
- Scheduled triage digests → that is a scheduled script with a webhook, and it serves people who do not use agents.
- Anything that only makes sense for one organization's folder layout or workflow.

When in doubt: if it would not make sense to a Ghost Inspector customer who has never heard of the consumer's projects, it does not go in this repo.
