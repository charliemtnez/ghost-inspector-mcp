/** Keeps the plain-text `httpAuth*` credentials stored on tests and suites out of every response. */

const CREDENTIAL_KEY = /^httpAuth|password|secret|token|apikey/i;

/**
 * Whether a field name looks like it holds a credential.
 *
 * @param key A record field name.
 * @return True for `httpAuth*` and anything naming a password, secret, token or API key.
 */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key);
}

/**
 * A deep copy with every credential-shaped key removed.
 *
 * @param value Any JSON-shaped value.
 * @return The same shape without those keys.
 */
export function stripCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripCredentials(item)) as T;
  if (!value || typeof value !== "object") return value;
  const kept = Object.entries(value).filter(([key]) => !isCredentialKey(key));
  return Object.fromEntries(kept.map(([key, item]) => [key, stripCredentials(item)])) as T;
}
