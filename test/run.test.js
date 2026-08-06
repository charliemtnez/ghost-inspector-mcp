/**
 * Running a stored test for real.
 *
 * This is the only tool that submits. Every assertion here is a real record in
 * somebody's CRM if it stops holding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { assessSubmit, DEFAULT_WAIT_MS } from "../dist/run.js";
import { runsAllowed, writesAllowed } from "../dist/config.js";

const step = (over = {}) => ({ command: "click", target: "", value: "", fromModule: null, ...over });

test("allowing writes does not allow running", async () => {
  // An edit is recoverable from the backup the write path returns. A submitted
  // form is not recoverable at all, so accepting the first is not accepting the
  // second. If these two ever share a variable, opting into edits silently
  // opts into posting live data.
  const before = { ...process.env };
  try {
    process.env.GHOST_INSPECTOR_ALLOW_WRITES = "true";
    delete process.env.GHOST_INSPECTOR_ALLOW_RUNS;
    assert.equal(writesAllowed(), true);
    assert.equal(runsAllowed(), false, "the write gate must not open the run gate");
  } finally {
    process.env = before;
  }
});

test("the run gate opens for an exact true and nothing else", async () => {
  const before = { ...process.env };
  try {
    for (const value of ["", "1", "yes", "y", "on", "false", "0", "TRUE ", "truthy"]) {
      process.env.GHOST_INSPECTOR_ALLOW_RUNS = value;
      const expected = value.trim().toLowerCase() === "true";
      assert.equal(runsAllowed(), expected, `ALLOW_RUNS=${JSON.stringify(value)}`);
    }
  } finally {
    process.env = before;
  }
});

test("the wait outlasts a real run, including the queue in front of it", async () => {
  // POST /tests/{id}/execute/ blocks for the whole run — measured at 50s of
  // wall time for a 29s test, the rest being queue. The API client defaults to
  // 60s, which would abort healthy runs and report a test that is still going
  // as an error. This margin is the only thing preventing that.
  assert.ok(DEFAULT_WAIT_MS > 60_000, "must exceed the client's own default timeout");
  assert.ok(DEFAULT_WAIT_MS >= 240_000, "a slow run plus queue needs real headroom");
});

test("a submit hidden in a module still demands confirmation", async () => {
  // The whole reason the check runs on expanded steps: a test whose own steps
  // are only `execute` calls looks harmless as written.
  const a = assessSubmit([step({ target: "#email" }), step({ target: 'button[type="submit"]', fromModule: "Shared form" })], 1, false);
  assert.equal(a.submits, true);
  assert.equal(a.fromModule, "Shared form", "must name the module so the caller knows where it came from");
});

test("a test that submits nothing runs without ceremony", async () => {
  // Friction everywhere is friction nobody reads. It has to land only where
  // there is a consequence.
  const a = assessSubmit([step({ target: "#nav" }), step({ command: "assertElementPresent", target: "h1" })], 0, false);
  assert.equal(a.submits, false);
  assert.equal(a.reason, null);
});

test("a chain that could not be fully expanded counts as submitting", async () => {
  // The unread part of the chain may contain the submit. An unnecessary
  // confirmation costs a moment; the other direction costs a real record.
  const a = assessSubmit([step({ target: "#nav" })], 3, true);
  assert.equal(a.submits, true);
  assert.equal(a.chainTruncated, true);
  assert.match(a.reason, /could not be fully expanded/);
});

test("an Enter keypress is treated as a submit", async () => {
  // It submits a focused form without any button being clicked, which is
  // exactly the case a click-only heuristic would wave through.
  assert.equal(assessSubmit([step({ command: "keypress", value: "Enter" })], 0, false).submits, true);
});
