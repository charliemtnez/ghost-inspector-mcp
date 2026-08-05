# ghost-inspector-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Ghost Inspector](https://ghostinspector.com) API. Create, update and analyze end-to-end browser tests from whatever agent you already use — Claude, OpenAI, OpenCode, or your own automation — instead of clicking through the web UI.

**Status: early. Read-only by default.** Write tools land in the next release.

## Why

Ghost Inspector's API is small and stable, so a 1:1 wrapper would add nothing over `curl`. This server exists for three things `curl` can't give you:

- **Aggregations the API doesn't provide** — suite health, stale-test detection, dating a regression back to its last green run.
- **Guardrails on the write path** — there is no version history for test steps and no recycle bin. Overwrites are forever.
- **Tool descriptions that teach the calling model how not to break things** — the accumulated gotchas ship with the tool, so every agent gets them for free.

## Install

Requires Node 18+.

```bash
npx -y ghost-inspector-mcp
```

Or from source:

```bash
git clone https://github.com/charliemtnez/ghost-inspector-mcp.git
cd ghost-inspector-mcp
npm install && npm run build
```

## Configure

Get your **personal** API key: Ghost Inspector → hover your name (top right) → **Account Settings → API Access**. Keys are per user and can be regenerated at any time, which revokes the previous one immediately.

```bash
export GHOST_INSPECTOR_API_KEY="your-key"
```

| Variable | Required | Purpose |
|---|---|---|
| `GHOST_INSPECTOR_API_KEY` | yes | Your personal key |
| `GHOST_INSPECTOR_ORG_ID` | for validation runs | Organization id — get it from `gi_whoami` |
| `GHOST_INSPECTOR_ALLOW_WRITES` | no (default `false`) | Set to `true` to register mutating tools |

### Claude Code

```bash
claude mcp add ghost-inspector --scope user -- npx -y ghost-inspector-mcp
```

The server inherits the environment of the process that launches your client, so exporting the key in your shell profile is enough — you never have to put it in a config file.

### Any other MCP client

Point it at the `ghost-inspector-mcp` command over stdio and pass the key through the environment.

## Handling your API key

Ghost Inspector authenticates with `?apiKey=` **in the query string**, so the credential ends up in shell history, proxy logs and AI conversation transcripts unless you're deliberate about it.

```bash
# In a terminal you'll close afterwards — the value never enters the command,
# so it never enters your history.
umask 077
read -rs 'GI?Ghost Inspector API key: '; printf '%s' "$GI" > ~/.gi-key; unset GI

# Then, in your shell profile:
export GHOST_INSPECTOR_API_KEY="$(cat ~/.gi-key)"
```

This server will **never**:

- ask for your key through a tool call (that would put your secret in a conversation transcript)
- write your key to disk
- include your key in a log line, an error message or a tool response

## Safety model

**Read-only unless you opt in.** Mutating tools are only registered when `GHOST_INSPECTOR_ALLOW_WRITES=true`. If you haven't opted in, nothing can be changed no matter what your agent is asked to do.

**Suite deletion is not exposed, by design.** `DELETE /suites/{id}` cascades to every test in the suite, with no version history and no recycle bin. That stays a deliberate `curl` by someone who knows what they're doing.

**Writes are guarded.** Every mutating tool will, without exception:

1. compare `dateUpdated` across the whole `execute` chain against the last run — a red test whose module was edited *after* its last run is **stale, not broken**, and overwriting it destroys a colleague's fix;
2. return the complete prior definition, which is your rollback;
3. apply the change;
4. re-read and diff against what was sent, because `HTTP 200` doesn't prove the write landed as intended.

**Validation doesn't touch production.** Test definitions can be validated with on-demand execution, which runs and discards without saving. Strip the submit step and the whole selector chain gets verified **without submitting a real form** — worth caring about, since many Ghost Inspector suites submit live forms against production sites.

## Tools

| Tool | Writes? | What it does |
|---|---|---|
| `gi_whoami` | no | Verifies your key and lists reachable organizations. Start here when something's misconfigured. |

More coming: `gi_validate_test`, `gi_inventory`, `gi_suite_health`, `gi_stale_tests`, `gi_date_regression`, `gi_module_usage`, and the guarded create/update path.

## Contributing

Issues and PRs welcome, but this is maintained on a best-effort basis — it's a tool built to solve a real problem, not a supported product. No organization-specific data (IDs, hostnames, naming conventions, test-data identities) in code, tests, docs or examples; that all belongs in the caller's configuration.

## License

MIT. See [LICENSE](LICENSE).

Ghost Inspector is a trademark of its respective owner. This project is unaffiliated.
