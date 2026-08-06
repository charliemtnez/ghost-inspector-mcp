# ghost-inspector-mcp

[![CI](https://github.com/charliemtnez/ghost-inspector-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/charliemtnez/ghost-inspector-mcp/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/ghost-inspector-mcp)](https://www.npmjs.com/package/ghost-inspector-mcp)

An [MCP](https://modelcontextprotocol.io) server for the [Ghost Inspector](https://ghostinspector.com) API, so you can work with end-to-end browser tests from whatever agent you already use — Claude, OpenAI, OpenCode, your own automation — instead of clicking through the web UI.

## Status

Fourteen tools, all of them always visible: nine that only read, four that write, and one that runs a test for real and are registered only if you opt in. The table below is a map of the surface — each tool's own description, which is what your agent actually reads, is where the detail and the gotchas live.

| Tool | Writes? | What it does |
|---|---|---|
| `gi_whoami` | no | Verifies your API key, lists the organizations it can reach with their ids, and reports whether writing is enabled. Start here when something is misconfigured, or when an agent tells you this server cannot modify anything. |
| `gi_get_test` | no | One test's stored definition, identity and state — including the `dateUpdated` that `gi_update_test` requires as its concurrency token. Call it before composing any edit. |
| `gi_test_result` | no | Why one test is red: the failing step, its error, the selectors it was *authored* with rather than just the one that resolved, and which test or module actually owns the step. Leads with a staleness verdict, because a result that predates a change is not evidence. |
| `gi_vacuous_tests` | no | Green tests that prove nothing, in three separate classes: runs zero steps, runs steps but contains no assertion at all, and a shortlist whose lone final assertion may have been true before the test did anything. |
| `gi_propose_repair` | no | Turns a diagnosis into a concrete proposal — the rewritten step, which test owns it, and the token to write it. Applies nothing, and refuses on a stale diagnosis. |
| `gi_inventory` | no | The whole account as a folder → suite tree, with per-suite counts of passing / failing / module / not-yet-run tests and the names of the failing ones. Filter by folder, or ask for failing suites only. |
| `gi_module_usage` | no | The reverse index of `execute` steps: for every imported test, who imports it directly and the full transitive blast radius. Also finds tests that **pass while executing no steps at all**, modules that contribute nothing, modules nobody imports, imported tests missing the import-only flag, broken references, and cycles. Costs one request per test. |
| `gi_stale_tests` | no | Splits red tests into stale and genuinely broken by comparing the whole `execute` chain's `dateUpdated` against each test's last run. Also finds passing tests whose result predates a change. Costs one request per test. |
| `gi_validate_test` | no | Runs a definition through on-demand execution, which executes and discards it, and reports every step. Inlines modules first, then truncates at the first step that could submit a form. `dryRun` shows exactly what would run without starting a browser. |
| `gi_update_test` | **yes** | Replaces a test's steps and/or renames it, behind four guards and a concurrency token. |
| `gi_move_suite` | **yes** | Moves a suite with its tests to another folder. Reversible; returns the prior folder so the undo is one call. |
| `gi_create_suite` | **yes** | Creates an empty suite, in a folder if you name one. Refuses a same-named sibling unless you insist. |
| `gi_run_test` | **runs** | Executes a test exactly as saved and waits for the verdict. Its own gate, separate from writes. A test that submits a form is refused unless you confirm per call. |
| `gi_duplicate_test` | **yes** | Copies a test, places it in a suite and renames it in one call. **This is the only way to get a new test** — Ghost Inspector has no create endpoint — so a source test is required. Clears the copy's schedule by default. |

Every tool is listed whether or not its gate is open. The four write tools refuse unless `GHOST_INSPECTOR_ALLOW_WRITES` is exactly `true`, and `gi_run_test` refuses unless `GHOST_INSPECTOR_ALLOW_RUNS` is — a refusal changes nothing and tells you which variable to set. `gi_whoami` reports both.

**Not included, on purpose.** Any deletion: `DELETE /suites/{id}/` cascades to every test in the suite with no undo, and that blast radius does not belong behind an agent. Deleting a test is left out for the same reason — there is no version history to restore from.

**Creating a test from nothing is not possible, and not for want of trying.** Ghost Inspector has no create endpoint: `POST /tests/` returns the test listing, `PUT /tests/` and the organization- and folder-scoped variants 404, and the vendor documents update, duplicate and delete with no create. `gi_duplicate_test` is the real path — copy an existing test, place it, rename it — and it is named after what it does rather than what you wish it did.

**Not built.** Dating a regression back to its last green run: old results are purged, so there is a horizon past which the API simply cannot answer it, and a tool that silently stops working at an unknown depth is worse than no tool.

## Why this exists

Ghost Inspector's API is small and stable, so a 1:1 wrapper would add nothing over `curl`. This server is for the three things `curl` cannot give you:

- **Aggregations the API does not provide** — the account as a folder → suite tree with honest counts, the reverse index of which tests import each module, and red tests split into genuinely broken versus merely out of date.
- **Guardrails on the write path** — there is no version history for test steps and no recycle bin. Overwrites are forever.
- **Tool descriptions that teach the calling model how not to break things** — the accumulated gotchas ship with the tool, so every agent gets them for free instead of learning them the expensive way.

Other community wrappers of this API exist. The difference here is the posture: read-only until you opt in, no suite deletion at any opt-in level, and every write behind guards that cannot be turned off.

Two worked examples of that third point, because it is the whole thesis.

Marking a test **Import Only** — Ghost Inspector's way of saying "this is a module, other tests import its steps" — *deletes its stored results*. Every module is therefore permanently "never executed": no results, `passing` not a boolean, last-run date pinned to the `1970-01-01` epoch sentinel. The obvious implementation of stale-test detection sorts by last-run date, so it reports every module in your account as the deadest, most broken thing in it, and advises deleting exactly the steps all your live tests share. This server knows that, and ships the predicate that prevents it.

And a test whose steps are only `execute` calls into modules with no steps **runs zero steps and passes**, because nothing can fail. The dashboard shows it green while it asserts nothing, which is worse than red because nobody investigates green. Emptying one shared module does that to every test importing it, silently and all at once.

That turned out to be the smallest of three ways a test can be hollow. On a real 454-test account `gi_vacuous_tests` found 85 running no steps, **182 running their steps with no assertion anywhere**, and 90 more whose only assertion is the final step and may well have been true before the test did anything. Every one of them green.

## Install

Requires Node 18+. There is nothing to install ahead of time — your MCP client launches the server with:

```bash
npx -y ghost-inspector-mcp
```

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
| `GHOST_INSPECTOR_ORG_ID` | to execute a validation | Organization id — read it from `gi_whoami`. Not needed for `gi_validate_test`'s `dryRun` |
| `GHOST_INSPECTOR_ALLOW_WRITES` | no (default `false`) | Set to `true` to register mutating tools |
| `GHOST_INSPECTOR_ALLOW_RUNS` | no (default `false`) | Set to `true` to register `gi_run_test`. **Not implied by `ALLOW_WRITES`** — an edit can be rolled back from the backup, a submitted form cannot |

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

**Read-only unless you opt in.** Mutating tools are only registered when `GHOST_INSPECTOR_ALLOW_WRITES=true`. If you have not opted in, nothing can be changed no matter what your agent is asked to do. Every tool also declares MCP annotations (`readOnlyHint`, `destructiveHint`), so a client that gates permissions on them sees the same posture the server enforces — including that `gi_validate_test` is *not* marked read-only, because driving a real browser against a real URL is a side effect even when nothing is saved.

**Gated, never hidden.** Withholding a tool by not registering it makes it indistinguishable from one that does not exist, and an agent will then tell you this server *cannot* write — convincingly, with nothing to contradict it. That happened, and it wasted a session.

So every tool is registered and the check happens when it is called. The guarantee is unchanged, because it was never the registration doing the work: without the opt-in the handler refuses and nothing is touched. What changes is that the refusal is an instruction naming the variable to set, instead of a silence the caller has to interpret. Suite deletion stays unimplemented — that is the one case where absence is the right answer, since no setting should reach it.

**Suite deletion is not exposed, by design.** `DELETE /suites/{id}/` cascades to every test in the suite, with no version history and no recycle bin. That stays a deliberate `curl` by someone who knows what they are doing.

**Failed requests are not retried.** A timeout or a dropped connection surfaces as an error instead of being attempted again. That is a decision, not an omission: `execute` and the write endpoints are not idempotent, and a retry that silently ran a browser test twice — or re-applied a write whose first attempt actually landed — buys convenience with exactly the kind of surprise this server exists to prevent. Read-only calls are safe to retry, so your agent can simply ask again.

**Writes are guarded.** Every mutating tool performs these four in order, and none can be turned off:

1. compare `dateUpdated` across the whole `execute` chain against the last run — a red test whose module was edited *after* its last run is **stale, not broken**, and a fix diagnosed from that failure is diagnosed from a version that no longer exists. Imports nest up to ten levels, so the walk is bounded and detects cycles. On a real account this refused a test whose last run was July 2024 and whose definition was edited eighteen days later: still red on the dashboard two years on;
2. return the complete prior definition — on refusals too. Ghost Inspector keeps no version history of steps, so that object **is** your rollback;
3. apply the change;
4. re-read and diff twice over: that what was sent landed exactly, and that every field you did not send is untouched. `HTTP 200` proves neither.

**Writing also requires a concurrency token.** You state the `dateUpdated` you believe is current, and the write is refused if the record has moved since. A confirmation flag can be talked past by a persuaded model; a timestamp it has to have actually read cannot be guessed.

That last claim is only true because `gi_get_test` returns the token. In 0.1.1 no read tool did, and the refusal handed back the current value — so the only route to a write was to send a wrong token deliberately and harvest the right one from the rejection. A model asked to repair a test worked that out on its own and planned it, because nothing else was available. The guard proved nothing, and the normal flow started with a deliberate failure. **A guard that demands proof of a read has to ship with the read that supplies it.** A refusal still shows the current value, since that is part of diagnosing a real conflict, but it now sends you back to re-read and recompose rather than resend: replaying an edit built against a definition that is no longer stored overwrites whoever replaced it.

That token narrows the window rather than closing it. Ghost Inspector has no compare-and-swap, so the check is read-then-write on the client side: two writers who both read before either wrote will both pass. It catches acting on a copy you read minutes or days ago, which is the realistic case, not a genuine race.

All four guards are verified against a live account, on a disposable clone that was created, written to, and deleted — the account was byte-identical afterward. That exercise found two defects the offline tests could not: Ghost Inspector normalises steps on write, so a naive round-trip diff cried "the write did not land" about a write that had landed perfectly; and the concurrency token was described as stronger than it is. A verifier that cries wolf is worse than none, because the next real warning gets ignored.

**Running a stored test is gated separately.** `gi_run_test` is the one tool that executes a test exactly as saved, with nothing truncated — so in most accounts it posts to production. It needs `GHOST_INSPECTOR_ALLOW_RUNS=true`, which `ALLOW_WRITES` does not imply: an edit is recoverable from the backup the write path returns, a submitted form is not recoverable at all. On top of that, a test that submits is refused unless you confirm on that call. The check inlines modules first, since a test whose steps are only `execute` calls hides its submit inside one, and a chain that cannot be fully expanded counts as submitting.

Confirmation is asked for only where there is a consequence, which is the point — a flag every call needs is a flag every caller sets by reflex. Measured on a real lead-generation account, 31 of 40 tests would ask for it and 9 ran without; those 31 genuinely click a submit control.

**Validation does not submit anything.** `gi_validate_test` uses on-demand execution, which runs a definition and discards it, so nothing in your account changes. But it drives a real browser against a real URL, so two guards apply and neither can be turned off:

1. **Modules are inlined before anything is inspected.** A test whose steps are only `execute` calls hides its submit click inside a module, and guarding the definition as written would see nothing. Measured on a real account: of eight such tests, five would have posted a live form.
2. **The run is truncated at the first step that could submit**, and that step becomes an assertion on the same target — so the chain is verified, including that the submit control is reachable, without activating it. On a 30-test sample the guard fired on 25.

There is no option to make it submit; that stays a deliberate `curl`. Use `dryRun` first on anything touching production: it reports exactly what would run, inlined and guarded, without starting a browser or needing an organization id.

## Development

```bash
npm ci
npm run typecheck
npm test          # builds first, then runs the suite
```

157 tests, no test dependencies — Node's own runner and `assert`. They are organised by what breaks if the assertion fails, not by coverage, so a failure name tells you what you broke:

| File | What it pins |
|---|---|
| `config.test.js` | The write gate opens for an exact `true` and not for `1` or `yes`; the key is re-read every call so rotation works; `redact` strips both the query parameter and a bare occurrence |
| `detail.test.js` | The concurrency token reaches the caller; a module's missing verdict is not read as a failure; steps come back unexpanded so an edit targets the test that owns them |
| `create.test.js` | A copy is silenced unless the caller insists — anything short of an explicit `true` still clears the schedule; a near-duplicate suite name is refused before it exists |
| `client.test.js` | Truthy is not `true`; an unknown date reads as never-executed, because erring the other way slips a live module into a prune list; a stalled body download cannot outlive the request timeout |
| `graph.test.js` | A cycle terminates and is still reported once shared subtrees stop being re-expanded; depth does not inflate on a level that adds nobody; hitting the documented nesting limit is reported rather than passed off as a total |
| `inventory.test.js` | Every test lands in exactly one bucket; a module is never counted as failing; an empty suite still appears |
| `modules.test.js` | The transitive radius exceeds the direct count; a cycle is a flag rather than an inflated number; a test that executes nothing is found |
| `diagnose.test.js` | A step that never ran is not named as the failure; a resolved selector is not passed off as what the test looks for; a failing step from a module points at the module; a purged run is not reported as a test that never ran |
| `vacuous.test.js` | A module is never called hollow however empty it looks; an assertion inherited from a module counts; a lone final assertion is shortlisted rather than condemned; an unreadable definition is skipped, not counted as empty |
| `repair.test.js` | Rules that hold whatever the page contains are applied; a fragile selector is named but never rewritten, because inventing one would be a guess |
| `stale.test.js` | The red pile splits with nothing lost; an unparseable date counts as changed; modules are excluded rather than evaluated |
| `validate.test.js` | A submit inherited from a module is caught — guarding the definition as written was measured letting five of eight real tests post a live form; an import's condition gates every step it imports instead of being dropped |
| `run.test.js` | Allowing writes does not allow running; a submit hidden inside a module still demands confirmation; a chain that could not be fully expanded counts as submitting |
| `writes.test.js` | The direction of every uncertain case in the staleness guard; Ghost Inspector's own step defaults are not reported as differences; a field that only appears after the write is still an unexpected change |
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
