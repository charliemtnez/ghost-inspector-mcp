/**
 * The credential surface. These assertions are the security posture, not
 * cosmetics: a regression here leaks a key or silently opens the write path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { redact, requireApiKey, requireOrgId, writesAllowed } from "../dist/config.js";

const KEY = "GHOST_INSPECTOR_API_KEY";
const ORG = "GHOST_INSPECTOR_ORG_ID";
const WRITES = "GHOST_INSPECTOR_ALLOW_WRITES";

test("writesAllowed only accepts an exact true", () => {
  for (const value of ["true", "TRUE", "True", " true ", "\ttrue\n"]) {
    process.env[WRITES] = value;
    assert.equal(writesAllowed(), true, `${JSON.stringify(value)} should open the gate`);
  }
  // Anything a well-meaning operator might type instead must NOT open it.
  for (const value of ["1", "yes", "y", "on", "false", "", "TRUE!", "truthy", "0"]) {
    process.env[WRITES] = value;
    assert.equal(writesAllowed(), false, `${JSON.stringify(value)} must not open the gate`);
  }
  delete process.env[WRITES];
  assert.equal(writesAllowed(), false, "unset must not open the gate");
});

test("the key is read on every call, never cached", () => {
  process.env[KEY] = "first";
  assert.equal(requireApiKey(), "first");
  process.env[KEY] = "second";
  assert.equal(requireApiKey(), "second", "rotating the key must take effect without a restart");
});

test("a missing key fails with instructions, never with a value", () => {
  delete process.env[KEY];
  assert.throws(requireApiKey, (error) => {
    assert.equal(error.name, "ConfigError");
    assert.match(error.message, /Account Settings/, "must say where to get a key");
    assert.match(error.message, new RegExp(KEY), "must name the variable to export");
    return true;
  });
});

test("a missing organization id points at how to find it", () => {
  delete process.env[ORG];
  assert.throws(requireOrgId, (error) => {
    assert.equal(error.name, "ConfigError");
    assert.match(error.message, /gi_whoami/);
    return true;
  });
});

test("redact removes the key from a query string", () => {
  process.env[KEY] = "SECRETVALUE123";
  const url = "https://api.ghostinspector.com/v1/tests/?apiKey=SECRETVALUE123&count=1";
  const clean = redact(`Request failed: ${url}`);
  assert.ok(!clean.includes("SECRETVALUE123"), "the key must not survive");
  assert.match(clean, /\[REDACTED\]/);
  assert.ok(clean.includes("count=1"), "surrounding context should stay readable");
});

test("redact removes a bare occurrence of the key, not just the query param", () => {
  process.env[KEY] = "SECRETVALUE123";
  const clean = redact("the configured key SECRETVALUE123 was rejected");
  assert.ok(!clean.includes("SECRETVALUE123"));
});

test("redact strips an apiKey param even when the key is unset", () => {
  delete process.env[KEY];
  const clean = redact("GET /v1/tests/?apiKey=someoneelseskey");
  assert.ok(!clean.includes("someoneelseskey"), "defence in depth: redact by shape too");
});

test("redact handles every occurrence, not only the first", () => {
  process.env[KEY] = "AAA";
  const clean = redact("AAA then AAA then ?apiKey=AAA");
  assert.ok(!clean.includes("AAA"));
});

test("redact leaves text without a key untouched", () => {
  process.env[KEY] = "SECRETVALUE123";
  const message = "Element not found: #submit";
  assert.equal(redact(message), message);
});
