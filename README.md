# ghost-inspector-mcp

[![CI](https://github.com/charliemtnez/ghost-inspector-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/charliemtnez/ghost-inspector-mcp/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/ghost-inspector-mcp)](https://www.npmjs.com/package/ghost-inspector-mcp)

An [MCP](https://modelcontextprotocol.io) server for the [Ghost Inspector](https://ghostinspector.com) API, so you can work with end-to-end browser tests from whatever agent you already use — Claude, OpenAI, OpenCode, your own automation — instead of clicking through the web UI.

## Status

Twenty tools. Fourteen only read, five write, and one runs a test for real. **All of them are always listed** — the gated ones refuse when called without their opt-in rather than hiding, so nothing has to be inferred from an absent tool.

The table is a map of the surface. Each tool's own description, which is what your agent actually reads, is where the detail and the gotchas live.

**Understand an account**

| Tool | Access | What it does |
|---|---|---|
| `gi_whoami` | read | Verifies your API key, lists the organizations it can reach with their ids, and reports which gates are open. Start here when something is misconfigured, or when an agent tells you this server cannot modify anything. |
| `gi_inventory` | read | The whole account as a folder → suite tree, with per-suite counts of passing / failing / module / not-yet-run tests and the ids and names of the failing ones. Filter by folder, or ask for failing suites only. |
| `gi_find_tests` | read | Tests by name, folder, suite or what their own steps do (command, any fallback selector, value), with the ids every other tool takes. |
| `gi_module_usage` | read | The reverse index of `execute` steps: for every imported test, who imports it directly and its full transitive blast radius, with ids. Also finds modules nobody imports, imported tests missing the import-only flag, broken references, and cycles. Filter the listing by folder or suite; the radius stays account-wide. One request per test. |
| `gi_get_test` | read | One test's stored definition, identity and state — including the `dateUpdated` that `gi_update_test` requires as its concurrency token. Call it before composing any edit. Up to 20 at once; `expandModules` inlines what a run executes, step by step, with its owner. |

**Find what is wrong**

| Tool | Access | What it does |
|---|---|---|
| `gi_stale_tests` | read | Splits red tests into stale and genuinely broken by comparing the whole `execute` chain's `dateUpdated` against each test's last run. Also finds passing tests whose result predates a change. Filter by folder or suite. One request per test. |
| `gi_vacuous_tests` | read | Green tests that prove nothing, in three separate classes: runs zero steps; runs its steps but contains no assertion at all; or a shortlist whose lone final assertion may have been true before the test did anything. Filter by folder or suite. |
| `gi_test_result` | read | Why one test is red: the failing step, its error, the selectors it was *authored* with rather than only the one that resolved, and which test or module actually owns the step — mapped by position against the current definition, never guessed. Leads with a staleness verdict, because a result that predates a change is not evidence. Returns the run's screenshot, video, URLs and console. Up to 20 at once. |
| `gi_test_history` | read | A test's runs, newest first, up to 500: each verdict and failing step, the last pass, and the first failure of the current red streak. States how far back it could see. |
| `gi_failure_groups` | read | Red tests grouped by when they began failing, across suites and folders, with their common errors and targets — many reds within hours usually share one cause. |

**Fix it**

| Tool | Access | What it does |
|---|---|---|
| `gi_propose_repair` | read | Turns a diagnosis into a concrete proposal: the rewritten step, which test owns it, and the token to write it. Applies nothing, and refuses on a stale diagnosis or a step it cannot locate. |
| `gi_plan_test` | read | Exactly what `gi_validate_test` would send — modules inlined, `{{variables}}` resolved, all three submit-guard layers applied — and whether it would be refused. Starts no browser and needs no organization id. |
| `gi_validate_test` | read¹ | Runs a definition through on-demand execution, which executes and discards it, and reports every step. Replicates the suite's configuration and variables, and guards against submitting in three layers (see the safety model). |
| `gi_screenshot_status` | read | A test's screenshot comparison: the measured difference against its threshold, and the current, difference and baseline images. |
| `gi_update_test` | **write** | Replaces a test's steps, renames it or changes its start URL, behind four guards and a concurrency token. The prior definition is saved to an owner-only file. |
| `gi_move_suite` | **write** | Moves a suite with its tests to another folder. Reversible; returns the prior folder so the undo is one call. |
| `gi_create_suite` | **write** | Creates an empty suite, in a folder if you name one. Refuses a same-named sibling unless you insist. |
| `gi_duplicate_test` | **write** | Copies a test, places it in a suite, renames it and optionally re-points its start URL in one call. **The only way to get a new test** — Ghost Inspector has no create endpoint — so a source test is required. Clears the copy's schedule by default. |
| `gi_accept_screenshot` | **write** | Makes the latest screenshot the new baseline — only if it is the result you looked at, still the latest and finished, with a failing comparison. Returns the baseline it replaced, since the API cannot restore one. |
| `gi_run_test` | **run** | Executes a test exactly as saved and waits for the verdict. Its own gate, separate from writes. A test that submits a form is refused unless you confirm on that call. |

¹ `gi_validate_test` saves nothing, but it drives a real browser against a real URL, so it is not marked read-only.

The five write tools refuse unless `GHOST_INSPECTOR_ALLOW_WRITES` is exactly `true`, and `gi_run_test` refuses unless `GHOST_INSPECTOR_ALLOW_RUNS` is. A refusal changes nothing and names the variable to set. `gi_whoami` reports both gates.

**Not included, on purpose.** Deletion of any kind. `DELETE /suites/{id}/` cascades to every test in the suite with no undo, and that blast radius does not belong behind an agent; deleting a test is left out for the same reason, since there is no version history to restore from.

**Creating a test from nothing is not possible.** Ghost Inspector exposes no create endpoint — `POST /tests/` returns the test listing, the organization- and folder-scoped variants return 404, and the vendor documents update, duplicate and delete with no create. `gi_duplicate_test` is the supported route: copy an existing test, place it, rename it. It is named for what it does, because calling it "create" would set the wrong expectation about needing a source.

**Dating a regression** back to its last green run is `gi_test_history`. Old results are purged, so every answer carries its horizon: how far back it walked, and whether that was the end of what Ghost Inspector retains or only the end of what was asked for.

## What you can ask for

You talk to your agent, not to the tools. These are the questions the server is built to answer:

- *"Which of my failing tests are actually broken, and which just haven't run since someone edited them?"* — the distinction the dashboard cannot make, and the reason a triage session usually starts here.
- *"Why is the checkout test red?"* — the failing step, its error, and which test or module owns it.
- *"If I change this shared module, what breaks?"* — direct importers and the full transitive reach, which is normally much larger.
- *"Which of my green tests aren't really testing anything?"* — three separate ways a test can pass while proving nothing.
- *"Fix that selector."* — propose a change, run it without saving to check it resolves, apply it behind the guards, then run the test to confirm. Each step is a separate tool, and the ones that change or execute anything need you to opt in first.

**A note on scale.** This server earns its place on accounts that have accumulated mess: hundreds of tests, shared modules with unclear ownership, a failing list nobody has triaged in months. On a small, well-tended account — a couple of dozen tests, no modules, everything green — `gi_stale_tests`, `gi_module_usage` and `gi_vacuous_tests` will correctly return nothing, and the server will look like it does very little. That is the honest answer for that account, not a malfunction.

## Why this exists

Ghost Inspector's API is small and stable, so a 1:1 wrapper would add nothing over `curl`. This server is for the three things `curl` cannot give you:

- **Aggregations the API does not provide** — the account as a folder → suite tree with honest counts, the reverse index of which tests import each module, and red tests split into genuinely broken versus merely out of date.
- **Guardrails on the write path** — there is no version history for test steps and no recycle bin. Overwrites are forever.
- **Tool descriptions that teach the calling model how not to break things** — the accumulated gotchas ship with the tool, so every agent gets them for free instead of learning them the expensive way.

Other community wrappers of this API exist. The difference here is the posture: nothing is written or executed until you opt in, no deletion at any opt-in level, and every write behind guards that cannot be turned off.

Two worked examples of that third point, because it is the whole thesis.

Marking a test **Import Only** — Ghost Inspector's way of saying "this is a module, other tests import its steps" — *deletes its stored results*. Every module is therefore permanently "never executed": no results, `passing` not a boolean, last-run date pinned to the `1970-01-01` epoch sentinel. The obvious implementation of stale-test detection sorts by last-run date, so it reports every module in your account as the deadest, most broken thing in it, and advises deleting exactly the steps all your live tests share. This server knows that, and ships the predicate that prevents it.

And a test whose steps are only `execute` calls into modules with no steps **runs zero steps and passes**, because nothing can fail. The dashboard shows it green while it asserts nothing, which is worse than red because nobody investigates green. Emptying one shared module does that to every test importing it, silently and all at once.

That is the smallest of three ways a test can be hollow. On a real account of a few hundred tests, `gi_vacuous_tests` found that the largest group by far was not this one but **tests that run every step and contain no assertion at all** — they can only fail if a step errors. A third group asserts only on its final step, which may well have been true before the test did anything. All of them green.

## Install

Requires Node 18+. There is nothing to install ahead of time — your MCP client launches the server with:

```bash
npx -y ghost-inspector-mcp
```

That always runs the latest release. To pin one, which is what a team sharing a setup should do, name it: `npx -y ghost-inspector-mcp@0.3.0`.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=ghost-inspector&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Ghost%20Inspector%20API%20key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22ghost-inspector-mcp%22%5D%2C%22env%22%3A%7B%22GHOST_INSPECTOR_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=ghost-inspector&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22apiKey%22%2C%22description%22%3A%22Ghost%20Inspector%20API%20key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22ghost-inspector-mcp%22%5D%2C%22env%22%3A%7B%22GHOST_INSPECTOR_API_KEY%22%3A%22%24%7Binput%3AapiKey%7D%22%7D%7D&quality=insiders)

Those two prompt for your key and store it in VS Code's own secret input rather than in a settings file.

To work on the server itself, clone and build instead:

```bash
git clone https://github.com/charliemtnez/ghost-inspector-mcp.git
cd ghost-inspector-mcp
npm install && npm run build
```

## Configure

Get your **personal** API key: Ghost Inspector → hover your name (top right) → **Account Settings → API Access**. Keys are per user, and regenerating one disables the previous key immediately.

| Variable | Required | Purpose |
|---|---|---|
| `GHOST_INSPECTOR_API_KEY` | yes | Your personal key |
| `GHOST_INSPECTOR_ORG_ID` | to execute a validation | Organization id — read it from `gi_whoami`. Not needed for `gi_plan_test` |
| `GHOST_INSPECTOR_ALLOW_WRITES` | no (default `false`) | Set to `true` to let the five write tools act. They are listed either way |
| `GHOST_INSPECTOR_ALLOW_RUNS` | no (default `false`) | Set to `true` to let `gi_run_test` execute. **Not implied by `ALLOW_WRITES`** — an edit can be rolled back from the backup this server returns, a submitted form cannot |
| `GHOST_INSPECTOR_BACKUP_DIR` | no (default `~/.ghost-inspector-mcp/backups`) | Where the write path saves the prior definition of every test it touches. Created owner-only |

Configuration is environment variables only. There is deliberately no `.env` support: this ships as a global command with no project directory of its own, and a second place to put a secret is a second place to leak it. The key is read fresh on every call, so rotating it takes effect without a restart.

### Claude Code

```bash
claude mcp add ghost-inspector --scope user -- npx -y ghost-inspector-mcp
```

### Claude Desktop, Cursor, Windsurf and anything else that takes a JSON config

```json
{
  "mcpServers": {
    "ghost-inspector": {
      "command": "npx",
      "args": ["-y", "ghost-inspector-mcp"]
    }
  }
}
```

No `env` block: the server inherits the environment of whatever launched your client, so exporting the key in your shell profile is enough and it never has to sit in a config file. Add one only if your client cannot inherit it.

### Any other MCP client

Point it at `npx -y ghost-inspector-mcp` over stdio, or at `node <path>/dist/index.js` from a clone, and pass the key through the environment.

### If the tools appear but every call says the key is missing

Your client was almost certainly launched from a desktop icon, Spotlight or a launcher rather than a terminal. Those do not run a login shell, so `~/.zprofile` and `~/.bash_profile` are never read and your `export` never happened — the server starts fine and registers its tools, then finds nothing in the environment.

Either launch the client from a terminal, or have the server read the key itself at launch:

```bash
claude mcp add ghost-inspector --scope user -- \
  sh -c 'GHOST_INSPECTOR_API_KEY="$(cat ~/.gi-key)" exec npx -y ghost-inspector-mcp'
```

The same wrapper works as `"command": "sh"` with `"args": ["-c", "..."]` in a JSON config. The key stays in a `600` file that only your user can read, and never enters the client's configuration.

## Handling your API key

Ghost Inspector authenticates with `?apiKey=` **in the query string**, so the credential ends up in shell history, proxy logs and AI conversation transcripts unless you are deliberate about it.

```bash
# In a terminal you will close afterwards — the value never enters the
# command, so it never enters your history.
umask 077
read -rs 'GI?Ghost Inspector API key: '; printf '%s' "$GI" > ~/.gi-key; unset GI

# Then, in your shell profile:
export GHOST_INSPECTOR_API_KEY="$(cat ~/.gi-key)"
```

`printf` rather than `echo` matters: a trailing newline corrupts the key inside a query parameter.

This server will **never**:

- ask for your key through a tool call (that would put your secret in a conversation transcript)
- write your key to disk
- include your key in a log line, an error message or a tool response

## Safety model

**Nothing is written or executed unless you opt in.** The mutating tools act only when `GHOST_INSPECTOR_ALLOW_WRITES=true`, and `gi_run_test` only when `GHOST_INSPECTOR_ALLOW_RUNS=true`. Without those, nothing can be changed or run no matter what your agent is asked to do — the check is in the handler, so it holds regardless of what the caller sends. Every tool also declares MCP annotations (`readOnlyHint`, `destructiveHint`), so a client that gates permissions on them sees the same posture the server enforces — including that `gi_validate_test` is *not* marked read-only, because driving a real browser against a real URL is a side effect even when nothing is saved.

**Gated, never hidden.** Every tool is listed whether or not its gate is open, and the permission check runs when the tool is called. A tool that is withheld from the listing is indistinguishable from one that does not exist, so an agent reading a short list concludes the capability is missing and tells you so — with nothing available to correct it. Here a gated call refuses, touches nothing, and names the variable to set.

Visibility is not permission. The two are separate on purpose: the listing tells the agent what this server can do, the gate decides what it may do right now.

**Suite deletion is not exposed, by design.** `DELETE /suites/{id}/` cascades to every test in the suite, with no version history and no recycle bin. That stays a deliberate `curl` by someone who knows what they are doing.

**Failed requests are not retried.** A timeout or a dropped connection surfaces as an error instead of being attempted again. That is a decision, not an omission: `execute` and the write endpoints are not idempotent, and a retry that silently ran a browser test twice — or re-applied a write whose first attempt actually landed — buys convenience with exactly the kind of surprise this server exists to prevent. Read-only calls are safe to retry, so your agent can simply ask again.

**Writes are guarded.** The test update performs these four in order, and none can be turned off:

1. compare `dateUpdated` across the whole `execute` chain against the last run — a red test whose module was edited *after* its last run is **stale, not broken**, and a fix diagnosed from that failure is diagnosed from a version that no longer exists. Imports nest up to ten levels, so the walk is bounded and detects cycles. On a real account this refused a test that had been red on the dashboard for well over a year, whose definition had been edited weeks after that last run;
2. save the complete prior definition — on refusals too — to an owner-only file under `GHOST_INSPECTOR_BACKUP_DIR` (directory 700, file 600, credentials removed), and return its path with a summary. Ghost Inspector keeps no version history of steps, so that file **is** your rollback. `verbose: true` returns it inline as well, and it comes back inline anyway if the file cannot be written;
3. apply the change;
4. re-read and diff twice over: that what was sent landed exactly — steps with each one's position as `sequence`, name and start URL — and that every field you did not send is untouched. `HTTP 200` proves neither.

Every write response carries the record's new `dateUpdated`, so a series of edits needs no re-read in between.

**Stored credentials never reach your agent.** Test and suite records carry HTTP basic-auth usernames and passwords in plain text. Every tool result has credential-shaped keys removed before it is returned, and private variable values are masked in validation reports.

**Writing also requires a concurrency token.** You state the `dateUpdated` you believe is current, and the write is refused if the record has moved since. A confirmation flag can be talked past by a persuaded model; a timestamp it has to have actually read cannot be guessed. `gi_get_test` returns that token alongside the definition, so reading the record is the ordinary first step of an edit rather than an obstacle.

A refusal reports the current value, because that is part of diagnosing a genuine conflict, and directs you to re-read and rebuild the change rather than resend it. Replaying an edit composed against a definition that is no longer stored would overwrite whatever replaced it.

That token narrows the window rather than closing it. Ghost Inspector has no compare-and-swap, so the check is read-then-write on the client side: two writers who both read before either wrote will both pass. It catches acting on a copy you read minutes or days ago, which is the realistic case, not a genuine race.

All four guards are verified against a live account, on a disposable clone that was created, written to and deleted, leaving the account byte-identical afterwards. The 0.3.0 additions — a changed start URL, the stored step positions, the backup file and accepting a screenshot — were verified the same way. One behaviour that only surfaces there: Ghost Inspector normalises steps on write, filling in fields the caller omitted, so both sides are normalised before being compared. Without that, verification reports a difference on every write that landed perfectly.

**Running a stored test is gated separately.** `gi_run_test` is the one tool that executes a test exactly as saved, with nothing truncated — so in most accounts it posts to production. It needs `GHOST_INSPECTOR_ALLOW_RUNS=true`, which `ALLOW_WRITES` does not imply: an edit is recoverable from the backup the write path returns, a submitted form is not recoverable at all. On top of that, a test that submits is refused unless you confirm on that call. The check inlines modules first, since a test whose steps are only `execute` calls hides its submit inside one, and a chain that cannot be fully expanded counts as submitting.

Confirmation is asked for only where there is a consequence, which is the point — a flag every call needs is a flag every caller sets by reflex. Measured across a sample of real tests, roughly three quarters asked for confirmation and the rest ran without it — the ones that asked genuinely click a submit control.

**Validation does not submit anything.** `gi_validate_test` uses on-demand execution, which runs a definition and discards it, so nothing in your account changes. But it drives a real browser against a real URL, so it runs as the real test would and is guarded in three layers, none of which can be turned off:

- **As the real test.** Modules are inlined first — a test whose steps are only `execute` calls hides its submit inside a module. `{{variables}}` are resolved from yours, the suite's and the organization's, because on-demand execution ignores custom variables and would run an unknown one as an empty string; one left without a value refuses the run before anything is sent. The suite's user agent, region, language and delays go with it.
- **(A) Static.** The run is truncated at the first click on a submit-shaped target, Enter keypress, or script or step condition that could submit or send data, and that step becomes an assertion on the same target — so the chain is verified, including that the control is reachable, without activating it.
- **(B) In the browser.** Before every remaining click, a probe inspects the element it resolves to and stops the run if it is a form's submit control, a non-field control inside a form, or cannot be resolved at all. An aria-labelled submit button in a form, which no selector pattern can recognise, is caught here.
- **(C) Tripwire.** Before every step, on every page, submit events, `form.submit()`, non-GET `fetch` and XHR, and `sendBeacon` are blocked and reported. It does not stop the run.

What remains is documented rather than hidden: a script that saved `window.fetch` or `form.submit` before the page's first step ran, a WebSocket, anything inside a child frame, and data sent by a GET (a pixel or a navigation). The guard errs towards stopping: a "Continue" button typed `submit` inside a form stops the run. There is no option to make it submit; that stays a deliberate `curl`. Use `gi_plan_test` first on anything touching production: it reports exactly what would run, inlined, resolved and guarded, without starting a browser.

## Development

```bash
npm ci
npm run typecheck
npm test          # builds first, then runs the suite
```

263 tests, no test dependencies — Node's own runner and `assert`. They are organised by what breaks if the assertion fails, not by coverage, so a failure name tells you what you broke:

| File | What it pins |
|---|---|
| `config.test.js` | The write gate opens for an exact `true` and not for `1` or `yes`; the key is re-read every call so rotation works; `redact` strips both the query parameter and a bare occurrence |
| `detail.test.js` | The concurrency token reaches the caller; a module's missing verdict is not read as a failure; steps come back unexpanded so an edit targets the test that owns them |
| `create.test.js` | A copy is silenced unless the caller insists — anything short of an explicit `true` still clears the schedule; a near-duplicate suite name is refused before it exists |
| `client.test.js` | Truthy is not `true`; an unknown date reads as never-executed, because erring the other way slips a live module into a prune list; a stalled body download cannot outlive the request timeout |
| `graph.test.js` | A cycle terminates and is still reported once shared subtrees stop being re-expanded; depth does not inflate on a level that adds nobody; hitting the documented nesting limit is reported rather than passed off as a total |
| `inventory.test.js` | Every test lands in exactly one bucket; a module is never counted as failing; an empty suite still appears |
| `modules.test.js` | The transitive radius exceeds the direct count; a cycle is a flag rather than an inflated number; a test that executes nothing is found |
| `diagnose.test.js` | A module saved with every `sequence` at 0 still maps a failure to the step that failed; a step that never ran is not named as the failure; a resolved selector is not passed off as what the test looks for; a failing step from a module points at the module; a purged run is not reported as a test that never ran |
| `vacuous.test.js` | A module is never called hollow however empty it looks; an assertion inherited from a module counts; a lone final assertion is shortlisted rather than condemned; an unreadable definition is skipped, not counted as empty |
| `repair.test.js` | Rules that hold whatever the page contains are applied; a fragile selector is named but never rewritten, because inventing one would be a guess |
| `stale.test.js` | The red pile splits with nothing lost; an unparseable date counts as changed; modules are excluded rather than evaluated |
| `validate.test.js` | A submit inherited from a module is caught — guarding the definition as written was measured letting five of eight real tests post a live form; an import's condition gates every step it imports instead of being dropped; conditions travel as `{statement}`; every step is gated on the in-browser guard and injected steps never shift what the report calls step N; a private variable never reaches the report |
| `run.test.js` | Allowing writes does not allow running; a submit hidden inside a module still demands confirmation; a chain that could not be fully expanded counts as submitting |
| `writes.test.js` | The direction of every uncertain case in the staleness guard; Ghost Inspector's own step defaults are not reported as differences; a field that only appears after the write is still an unexpected change; every step is saved with its position; a stored basic-auth password never reaches a response; the backup file is owner-only |
| `guard-script.test.js` | The in-browser probe, stop condition and tripwire, executed against a simulated page: a stop is recorded and respected by later steps, what sends data is blocked while a GET passes, and a denied `sessionStorage` never skips a run that was not stopped |
| `variables.test.js` | A suite variable reaches the start URL; a variable set by an earlier step is left for the browser; one used before it is set, or private with no value, refuses the run |
| `results.test.js` | A skipped or unreached step is not counted as executed; a missing duration is rebuilt, never reported as zero; console output is capped, never dropped silently |
| `find.test.js` | A step search matches fallback selectors; results carry ids |
| `history.test.js` | A red streak's first failure is found across pages; an unfinished walk never claims to be the whole history; failures that began together are grouped across suites |
| `screenshots.test.js` | A screenshot nobody looked at, or one with nothing to accept, is never accepted |
| `server.test.js` | The server starts, speaks the protocol, the write gate holds end to end, and every tool's annotations state the posture the code enforces |

`server.test.js` starts the real server over stdio, which is the only way to catch a registration or schema mistake. No API key is configured anywhere in the suite, so nothing reaches Ghost Inspector and the tests are safe to run against any machine.

CI runs the lot on Node 18, 20, 22 and 24 — the floor in `engines` plus both LTS lines and current, since `npx` runs on whatever Node the user already has. A second job re-runs the leak audit over the **entire history** rather than the working tree, because a leak scrubbed in a later commit is still in the history.

**One limit worth stating.** The API behaviours documented here were verified empirically against a single account on a single plan. They held every time they were checked, but a different plan could differ — if something contradicts this on your account, that is worth an issue.

## Contributing

Issues and PRs welcome, but this is maintained on a best-effort basis — a tool built to solve a real problem, not a supported product. Changes are listed in [CHANGELOG.md](CHANGELOG.md); anything security-relevant goes through [SECURITY.md](SECURITY.md) rather than a public issue.

No organization-specific data in code, tests, docs or examples: no ids, hostnames, folder or suite naming conventions, or test-data identities. All of that belongs in the caller's configuration. Use obvious placeholders like `https://example.com` and `jane@example.com`.

## License

MIT. See [LICENSE](LICENSE).

Ghost Inspector is a trademark of its respective owner. This project is unaffiliated.
