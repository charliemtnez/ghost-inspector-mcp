/**
 * Environment-backed configuration.
 *
 * The API key is read on every call, never cached and never stored, so an
 * operator can rotate it without restarting the server. It must never appear
 * in a log line, an error message or a tool response — not even truncated.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const KEY_VAR = "GHOST_INSPECTOR_API_KEY";
const ORG_VAR = "GHOST_INSPECTOR_ORG_ID";
const WRITES_VAR = "GHOST_INSPECTOR_ALLOW_WRITES";
const RUNS_VAR = "GHOST_INSPECTOR_ALLOW_RUNS";
const BACKUP_VAR = "GHOST_INSPECTOR_BACKUP_DIR";

/** Thrown when configuration is missing. Its message is safe to surface. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Returns the caller's personal Ghost Inspector API key.
 *
 * @throws {ConfigError} when unset, with instructions on how to provide one.
 */
export function requireApiKey(): string {
  const key = process.env[KEY_VAR]?.trim();
  if (!key) {
    const store = onWindows()
      ? `store it as a user environment variable from PowerShell, then restart your MCP client:\n` +
        `  $k = Read-Host 'Ghost Inspector API key' -AsSecureString; ` +
        `[Environment]::SetEnvironmentVariable('${KEY_VAR}', [Net.NetworkCredential]::new('', $k).Password, 'User')\n`
      : `export it in the shell that launches this server:\n  export ${KEY_VAR}="$(cat ~/.gi-key)"\n`;
    throw new ConfigError(
      `${KEY_VAR} is not set. Get your personal key from Ghost Inspector ` +
        `(hover your name, top right → Account Settings → API Access), then ${store}` +
        `Keys are per user and can be regenerated at any time, which revokes ` +
        `the previous one immediately. Do not share a key across a team.`,
    );
  }
  return key;
}

/**
 * Whether the server runs on native Windows, where there is no login shell and variables are set per user.
 *
 * @return True on win32.
 */
export function onWindows(): boolean {
  return process.platform === "win32";
}

/**
 * The line that sets a variable for processes started afterwards, in this platform's shell.
 *
 * @param name The variable.
 * @param value The value, or a placeholder.
 * @return A POSIX export, or a PowerShell user-variable assignment.
 */
export function setVariableLine(name: string, value: string): string {
  return onWindows()
    ? `[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')   # PowerShell; restart your MCP client after`
    : `export ${name}=${value}`;
}

/**
 * How an MCP client should launch this server: native Windows needs cmd to resolve npx.
 *
 * @param env Variables to pass with `-e`, as NAME=value.
 * @return The `claude mcp add` arguments after the server name.
 */
export function claudeAddCommand(env: string[] = []): string {
  const flags = env.map((pair) => `-e ${pair} `).join("");
  const launcher = onWindows() ? "cmd /c npx -y ghost-inspector-mcp" : "npx -y ghost-inspector-mcp";
  return `claude mcp add ghost-inspector -s user ${flags}-- ${launcher}`;
}

/**
 * Returns the configured organization id, required only by on-demand execution.
 *
 * @throws {ConfigError} when unset, pointing at the endpoint that reveals it.
 */
export function requireOrgId(): string {
  const org = process.env[ORG_VAR]?.trim();
  if (!org) {
    throw new ConfigError(
      `${ORG_VAR} is not set. List your organizations with gi_whoami, then set the id ` +
        `you want to use:\n  ${setVariableLine(ORG_VAR, "<id from gi_whoami>")}`,
    );
  }
  return org;
}

/**
 * Whether mutating tools should be registered.
 *
 * Defaults to false: an operator who has not opted in cannot mutate anything,
 * regardless of what the calling model is persuaded to attempt.
 */
export function writesAllowed(): boolean {
  return process.env[WRITES_VAR]?.trim().toLowerCase() === "true";
}

/**
 * Whether the stored-test execution tool should be registered.
 *
 * 🔴 Its own variable, and `GHOST_INSPECTOR_ALLOW_WRITES` does not imply it.
 * Editing a definition and running a test are different acts with different
 * consequences: an edit is recoverable from the backup the write path returns,
 * while a run of a test that submits a form puts a real record in whatever
 * system that form feeds, and nothing here can take it back. An operator who
 * accepted the first has not thereby accepted the second.
 */
export function runsAllowed(): boolean {
  return process.env[RUNS_VAR]?.trim().toLowerCase() === "true";
}

/**
 * Where the write path saves the prior definition of every test it touches, read on every call.
 *
 * @return GHOST_INSPECTOR_BACKUP_DIR, or ~/.ghost-inspector-mcp/backups.
 */
export function backupDir(): string {
  return process.env[BACKUP_VAR]?.trim() || join(homedir(), ".ghost-inspector-mcp", "backups");
}

/**
 * Removes the API key from any string before it reaches a log or a response.
 * Defence in depth: the key travels in query strings, so a raw URL or a
 * fetch error can carry it.
 */
export function redact(text: string): string {
  const key = process.env[KEY_VAR]?.trim();
  const withoutParam = text.replace(/([?&]apiKey=)[^&\s]+/gi, "$1[REDACTED]");
  return key ? withoutParam.split(key).join("[REDACTED]") : withoutParam;
}
