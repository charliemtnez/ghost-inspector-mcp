/**
 * Environment-backed configuration.
 *
 * The API key is read on every call, never cached and never stored, so an
 * operator can rotate it without restarting the server. It must never appear
 * in a log line, an error message or a tool response — not even truncated.
 */

const KEY_VAR = "GHOST_INSPECTOR_API_KEY";
const ORG_VAR = "GHOST_INSPECTOR_ORG_ID";
const WRITES_VAR = "GHOST_INSPECTOR_ALLOW_WRITES";

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
    throw new ConfigError(
      `${KEY_VAR} is not set. Get your personal key from Ghost Inspector ` +
        `(hover your name, top right → Account Settings → API Access), then ` +
        `export it in the shell that launches this server:\n` +
        `  export ${KEY_VAR}="$(cat ~/.gi-key)"\n` +
        `Keys are per user and can be regenerated at any time, which revokes ` +
        `the previous one immediately. Do not share a key across a team.`,
    );
  }
  return key;
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
      `${ORG_VAR} is not set. List your organizations first and export the id ` +
        `you want to use:\n  export ${ORG_VAR}=<id from gi_whoami>`,
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
 * Removes the API key from any string before it reaches a log or a response.
 * Defence in depth: the key travels in query strings, so a raw URL or a
 * fetch error can carry it.
 */
export function redact(text: string): string {
  const key = process.env[KEY_VAR]?.trim();
  const withoutParam = text.replace(/([?&]apiKey=)[^&\s]+/gi, "$1[REDACTED]");
  return key ? withoutParam.split(key).join("[REDACTED]") : withoutParam;
}
