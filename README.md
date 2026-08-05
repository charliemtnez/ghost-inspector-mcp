# ghost-inspector-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Ghost Inspector](https://ghostinspector.com) API, so you can work with end-to-end browser tests from whatever agent you already use — Claude, OpenAI, OpenCode, your own automation — instead of clicking through the web UI.

## Status: early, read-only

Two tools are implemented:

| Tool | Writes? | What it does |
|---|---|---|
| `gi_whoami` | no | Verifies your API key and lists the organizations it can reach, with their ids. Start here when something is misconfigured. |
| `gi_inventory` | no | The whole account as a folder → suite tree, with per-suite counts of passing / failing / module / not-yet-run tests and the names of the failing ones. Filter by folder, or ask for failing suites only. |
| `gi_module_usage` | no | The reverse index of `execute` steps: for every imported test, who imports it directly and the full transitive blast radius. Also finds unused modules, imported tests missing the import-only flag, broken references, and cycles. Costs one request per test. |

Enough to survey an account and to know what an edit would touch. **You cannot yet** tell a genuinely broken test from a stale one, validate selectors, or change anything.

Planned, in rough order: `gi_stale_tests`, `gi_date_regression`, `gi_validate_test`, then the guarded create/update path.

Not published to npm yet, so install from source.

## Why this exists

Ghost Inspector's API is small and stable, so a 1:1 wrapper would add nothing over `curl`. This server is for the three things `curl` cannot give you:

- **Aggregations the API does not provide** — suite health, stale-test detection, dating a regression back to its last green run.
- **Guardrails on the write path** — there is no version history for test steps and no recycle bin. Overwrites are forever.
- **Tool descriptions that teach the calling model how not to break things** — the accumulated gotchas ship with the tool, so every agent gets them for free instead of learning them the expensive way.

A worked example of that third point, because it is the whole thesis. Marking a test **Import Only** — Ghost Inspector's way of saying "this is a module, other tests import its steps" — *deletes its stored results*. Every module is therefore permanently "never executed": no results, `passing` not a boolean, last-run date pinned to the `1970-01-01` epoch sentinel. The obvious implementation of stale-test detection sorts by last-run date, so it reports every module in your account as the deadest, most broken thing in it, and advises deleting exactly the steps all your live tests share. This server knows that, and ships the predicate that prevents it.

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
| `GHOST_INSPECTOR_ORG_ID` | for validation runs | Organization id — read it from `gi_whoami` |
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

**Suite deletion is not exposed, by design.** `DELETE /suites/{id}` cascades to every test in the suite, with no version history and no recycle bin. That stays a deliberate `curl` by someone who knows what they are doing.

The remaining points describe how the write path is specified to behave. **None of it is implemented yet** — the guards are the reason the write tools are not simply shipped.

Every mutating tool will, without exception:

1. compare `dateUpdated` across the whole `execute` chain against the last run — a red test whose module was edited *after* its last run is **stale, not broken**, and overwriting it destroys a colleague's fix. Imports nest up to ten levels, so the walk is bounded and detects cycles;
2. return the complete prior definition, which is your rollback;
3. apply the change;
4. re-read and diff against what was sent, because `HTTP 200` does not prove the write landed as intended.

**Validation will not touch production.** Test definitions can be validated with on-demand execution, which runs and discards without saving. Strip the submit step and the whole selector chain gets verified **without submitting a real form** — worth caring about, since plenty of Ghost Inspector suites submit live forms against production sites on a schedule.

## Contributing

Issues and PRs welcome, but this is maintained on a best-effort basis — a tool built to solve a real problem, not a supported product.

No organization-specific data in code, tests, docs or examples: no ids, hostnames, folder or suite naming conventions, or test-data identities. All of that belongs in the caller's configuration. Use obvious placeholders like `https://example.com` and `jane@example.com`.

## License

MIT. See [LICENSE](LICENSE).

Ghost Inspector is a trademark of its respective owner. This project is unaffiliated.
