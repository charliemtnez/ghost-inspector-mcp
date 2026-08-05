# ghost-inspector-mcp

[![CI](https://github.com/charliemtnez/ghost-inspector-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/charliemtnez/ghost-inspector-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server for the [Ghost Inspector](https://ghostinspector.com) API, so you can work with end-to-end browser tests from whatever agent you already use — Claude, OpenAI, OpenCode, your own automation — instead of clicking through the web UI.

## Status

Seven tools: five that only read, and two that write and are registered only if you opt in.

| Tool | Writes? | What it does |
|---|---|---|
| `gi_whoami` | no | Verifies your API key and lists the organizations it can reach, with their ids. Start here when something is misconfigured. |
| `gi_inventory` | no | The whole account as a folder → suite tree, with per-suite counts of passing / failing / module / not-yet-run tests and the names of the failing ones. Filter by folder, or ask for failing suites only. |
| `gi_module_usage` | no | The reverse index of `execute` steps: for every imported test, who imports it directly and the full transitive blast radius. Also finds tests that **pass while executing no steps at all**, modules that contribute nothing, modules nobody imports, imported tests missing the import-only flag, broken references, and cycles. Costs one request per test. |
| `gi_stale_tests` | no | Splits red tests into stale and genuinely broken by comparing the whole `execute` chain's `dateUpdated` against each test's last run. Also finds passing tests whose result predates a change. Costs one request per test. |
| `gi_validate_test` | no | Runs a definition through on-demand execution, which executes and discards it, and reports every step. Inlines modules first, then truncates at the first step that could submit a form. `dryRun` shows exactly what would run without starting a browser. |
| `gi_update_test` | **yes** | Replaces a test's steps and/or renames it, behind four guards and a concurrency token. |
| `gi_move_suite` | **yes** | Moves a suite with its tests to another folder. Reversible; returns the prior folder so the undo is one call. |

The two write tools are registered **only** when `GHOST_INSPECTOR_ALLOW_WRITES` is exactly `true`.

**Not included, on purpose.** Suite deletion: `DELETE /suites/{id}/` cascades to every test in the suite with no undo, and that blast radius does not belong behind an agent. Test creation: Ghost Inspector documents no create endpoint, and this server does not guess at one — the documented path is `POST /tests/{id}/duplicate/` followed by an update, which needs a source test and so is a different operation than "create".

**Not built.** Dating a regression back to its last green run: old results are purged, so there is a horizon past which the API simply cannot answer it, and a tool that silently stops working at an unknown depth is worse than no tool. Not published to npm yet either, so install from source.

## Why this exists

Ghost Inspector's API is small and stable, so a 1:1 wrapper would add nothing over `curl`. This server is for the three things `curl` cannot give you:

- **Aggregations the API does not provide** — the account as a folder → suite tree with honest counts, the reverse index of which tests import each module, and red tests split into genuinely broken versus merely out of date.
- **Guardrails on the write path** — there is no version history for test steps and no recycle bin. Overwrites are forever.
- **Tool descriptions that teach the calling model how not to break things** — the accumulated gotchas ship with the tool, so every agent gets them for free instead of learning them the expensive way.

Two worked examples of that third point, because it is the whole thesis.

Marking a test **Import Only** — Ghost Inspector's way of saying "this is a module, other tests import its steps" — *deletes its stored results*. Every module is therefore permanently "never executed": no results, `passing` not a boolean, last-run date pinned to the `1970-01-01` epoch sentinel. The obvious implementation of stale-test detection sorts by last-run date, so it reports every module in your account as the deadest, most broken thing in it, and advises deleting exactly the steps all your live tests share. This server knows that, and ships the predicate that prevents it.

And a test whose steps are only `execute` calls into modules with no steps **runs zero steps and passes**, because nothing can fail. The dashboard shows it green while it asserts nothing, which is worse than red because nobody investigates green. Emptying one shared module does that to every test importing it, silently and all at once. Measured on a real account: one emptied module left 19% of the tests passing vacuously for a week. `gi_module_usage` reports them.

## Install

Requires Node 18+.

```bash
git clone https://github.com/charliemtnez/ghost-inspector-mcp.git
cd ghost-inspector-mcp
npm install && npm run build
```

Once it is published, `npx -y ghost-inspector-mcp` will work instead. It does not yet.

## Configure

Get your **personal** API key: Ghost Inspector → hover your name (top right) → **Account Settings → API Access**. Keys are per user, and regenerating one disables the previous key immediately.

| Variable | Required | Purpose |
|---|---|---|
| `GHOST_INSPECTOR_API_KEY` | yes | Your personal key |
| `GHOST_INSPECTOR_ORG_ID` | to execute a validation | Organization id — read it from `gi_whoami`. Not needed for `gi_validate_test`'s `dryRun` |
| `GHOST_INSPECTOR_ALLOW_WRITES` | no (default `false`) | Set to `true` to register mutating tools |

Configuration is environment variables only. There is deliberately no `.env` support: this ships as a global command with no project directory of its own, and a second place to put a secret is a second place to leak it. The key is read fresh on every call, so rotating it takes effect without a restart.

### Claude Code

```bash
claude mcp add ghost-inspector --scope user -- node /absolute/path/to/ghost-inspector-mcp/dist/index.js
```

### Any other MCP client

Point it at `node <path>/dist/index.js` over stdio and pass the key through the environment.

Either way the server inherits the environment of the process that launches your client, so exporting the key in your shell profile is enough — you never have to put it in a config file.

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

**Read-only unless you opt in.** Mutating tools are only registered when `GHOST_INSPECTOR_ALLOW_WRITES=true`. If you have not opted in, nothing can be changed no matter what your agent is asked to do.

**Suite deletion is not exposed, by design.** `DELETE /suites/{id}/` cascades to every test in the suite, with no version history and no recycle bin. That stays a deliberate `curl` by someone who knows what they are doing.

**Writes are guarded.** Every mutating tool performs these four in order, and none can be turned off:

1. compare `dateUpdated` across the whole `execute` chain against the last run — a red test whose module was edited *after* its last run is **stale, not broken**, and a fix diagnosed from that failure is diagnosed from a version that no longer exists. Imports nest up to ten levels, so the walk is bounded and detects cycles. On a real account this refused a test whose last run was July 2024 and whose definition was edited eighteen days later: still red on the dashboard two years on;
2. return the complete prior definition — on refusals too. Ghost Inspector keeps no version history of steps, so that object **is** your rollback;
3. apply the change;
4. re-read and diff twice over: that what was sent landed exactly, and that every field you did not send is untouched. `HTTP 200` proves neither.

**Writing also requires a concurrency token.** You state the `dateUpdated` you believe is current, and the write is refused if the record has moved since — a refusal tells you the current value so the retry is one step. A confirmation flag can be talked past by a persuaded model; a timestamp it has to have actually read cannot be guessed.

That token narrows the window rather than closing it. Ghost Inspector has no compare-and-swap, so the check is read-then-write on the client side: two writers who both read before either wrote will both pass. It catches acting on a copy you read minutes or days ago, which is the realistic case, not a genuine race.

All four guards are verified against a live account, on a disposable clone that was created, written to, and deleted — the account was byte-identical afterward. That exercise found two defects the offline tests could not: Ghost Inspector normalises steps on write, so a naive round-trip diff cried "the write did not land" about a write that had landed perfectly; and the concurrency token was described as stronger than it is. A verifier that cries wolf is worse than none, because the next real warning gets ignored.

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

108 tests, no test dependencies — Node's own runner and `assert`. They are organised by what breaks if the assertion fails, not by coverage, so a failure name tells you what you broke:

| File | What it pins |
|---|---|
| `config.test.js` | The write gate opens for an exact `true` and not for `1` or `yes`; the key is re-read every call so rotation works; `redact` strips both the query parameter and a bare occurrence |
| `client.test.js` | Truthy is not `true`; an unknown date reads as never-executed, because erring the other way slips a live module into a prune list |
| `graph.test.js` | A cycle terminates; depth does not inflate on a level that adds nobody; hitting the documented nesting limit is reported rather than passed off as a total |
| `inventory.test.js` | Every test lands in exactly one bucket; a module is never counted as failing; an empty suite still appears |
| `modules.test.js` | The transitive radius exceeds the direct count; a cycle is a flag rather than an inflated number; a test that executes nothing is found |
| `stale.test.js` | The red pile splits with nothing lost; an unparseable date counts as changed; modules are excluded rather than evaluated |
| `validate.test.js` | A submit inherited from a module is caught — guarding the definition as written was measured letting five of eight real tests post a live form |
| `writes.test.js` | The direction of every uncertain case in the staleness guard; Ghost Inspector's own step defaults are not reported as differences |
| `server.test.js` | The server starts, speaks the protocol, and the write gate holds end to end |

`server.test.js` starts the real server over stdio, which is the only way to catch a registration or schema mistake. No API key is configured anywhere in the suite, so nothing reaches Ghost Inspector and the tests are safe to run against any machine.

CI runs the lot on Node 18, 20, 22 and 24 — the floor in `engines` plus both LTS lines and current, since `npx` runs on whatever Node the user already has. A second job re-runs the leak audit over the **entire history** rather than the working tree, because a leak scrubbed in a later commit is still in the history.

**One limit worth stating.** The API behaviours documented here were verified empirically against a single account on a single plan. They held every time they were checked, but a different plan could differ — if something contradicts this on your account, that is worth an issue.

## Contributing

Issues and PRs welcome, but this is maintained on a best-effort basis — a tool built to solve a real problem, not a supported product.

No organization-specific data in code, tests, docs or examples: no ids, hostnames, folder or suite naming conventions, or test-data identities. All of that belongs in the caller's configuration. Use obvious placeholders like `https://example.com` and `jane@example.com`.

## License

MIT. See [LICENSE](LICENSE).

Ghost Inspector is a trademark of its respective owner. This project is unaffiliated.
