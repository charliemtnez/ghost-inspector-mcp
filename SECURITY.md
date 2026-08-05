# Security

## Reporting

Report anything security-relevant through
[GitHub's private vulnerability reporting](https://github.com/charliemtnez/ghost-inspector-mcp/security/advisories/new)
rather than a public issue, and please do not include a real API key in the
report — a redacted transcript or a reproduction against a throwaway key is
enough.

This is maintained on a best-effort basis by one person, so expect an
acknowledgement in days rather than hours. There is no bounty.

## Especially worth reporting

This server exists to handle a credential carefully, so anything that undermines
that is the most valuable thing you can find:

- A path where the API key reaches a log line, an error message, a tool response,
  the filesystem, or any process other than the Ghost Inspector API.
- A way to make a mutating tool run without `GHOST_INSPECTOR_ALLOW_WRITES=true`.
- A way to skip one of the four write guards, or to satisfy the concurrency token
  without having read the record.
- A way to make `gi_validate_test` submit a form. It truncates the run before any
  step that could, and there is no option to turn that off.

## How the credential is handled

- Read from `GHOST_INSPECTOR_API_KEY` at call time, never cached at startup, so
  rotating it takes effect without a restart.
- Never written to disk, never logged, never returned in a response. Error text
  is passed through a redaction step that strips both the `apiKey` query
  parameter and a bare occurrence of the value.
- There is no tool that accepts a key as an argument, and there will not be one:
  that would put the secret into a conversation transcript.

Ghost Inspector authenticates with `?apiKey=` in the query string and issues
**per-user** keys, so a key carries its owner's permissions — an org admin's key
can delete anything. Per-user keys buy attribution and instant revocation, not
least privilege, which is why the write gate and the guards matter. Use your own
key, never a shared one, and regenerate it from Account Settings → API Access if
you suspect exposure; that disables the previous key immediately.

## Scope

Ghost Inspector's own API and web application are out of scope here — report
those to the vendor. This project is unaffiliated.
