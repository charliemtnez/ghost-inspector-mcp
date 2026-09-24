/**
 * Green tests that prove nothing.
 *
 * The failure mode this guards against is not a missed finding — it is a
 * confident one. Condemning a module, or calling a real test hollow, sends
 * someone to delete working coverage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVacuityReport } from "../dist/vacuous.js";

const T = (over) => ({ _id: "t", name: "t", passing: true, suite: { name: "S" }, ...over });

test("a module is never called hollow, however empty it looks", async () => {
  // Import-only deletes a module's results, so it reads as unrun and often has
  // no assertion of its own — its callers assert. Reporting modules here would
  // aim a cleanup at the steps every live test shares. The single most
  // destructive wrong answer this server can give.
  const tests = [T({ _id: "m", name: "Shared login", importOnly: true, passing: null })];
  const steps = new Map([["m", [{ command: "click", target: "#go" }]]]);
  const r = buildVacuityReport(tests, steps);
  assert.equal(r.totals.assertsNothing, 0);
  assert.equal(r.scanned.modulesExcluded, 1);
});

test("a test with no assertion anywhere is reported", async () => {
  // It runs its steps and can only fail if one errors. Most common of the
  // three classes on a real account.
  const tests = [T({ _id: "a", name: "Nav only" })];
  const steps = new Map([["a", [{ command: "click", target: "#go" }, { command: "assign", target: "#q" }]]]);
  const r = buildVacuityReport(tests, steps);
  assert.equal(r.totals.assertsNothing, 1);
  assert.equal(r.assertsNothing[0].executedSteps, 2);
  assert.equal(r.assertsNothing[0].currentlyPassing, true, "green is what makes it worth reporting");
});

test("an assertion inherited from a module counts as asserting", async () => {
  // The test's own steps have none, but the chain does. Missing this would
  // report well-covered tests as hollow.
  const tests = [T({ _id: "a" }), T({ _id: "m", importOnly: true, passing: null })];
  const steps = new Map([
    ["a", [{ command: "click", target: "#go" }, { command: "execute", value: "m" }]],
    ["m", [{ command: "assertElementPresent", target: "#done" }]],
  ]);
  const r = buildVacuityReport(tests, steps);
  assert.equal(r.totals.assertsNothing, 0, "the chain asserts, so the test asserts");
});

test("a test whose chain runs nothing is separated from one that asserts nothing", async () => {
  // Different causes, different fixes. Collapsing them hides the emptied
  // module behind a pile of missing-assertion findings.
  const tests = [T({ _id: "a" }), T({ _id: "m", importOnly: true, passing: null })];
  const steps = new Map([["a", [{ command: "execute", value: "m" }]], ["m", []]]);
  const r = buildVacuityReport(tests, steps);
  assert.equal(r.totals.executesNothing, 1);
  assert.equal(r.totals.assertsNothing, 0);
});

test("a lone final assertion is shortlisted, not condemned", async () => {
  // This is the class that cannot be settled without running. Reporting it as
  // a verdict would have people deleting tests that do work.
  const tests = [T({ _id: "a" })];
  const steps = new Map([
    ["a", [{ command: "click", target: "#submit" }, { command: "assertElementPresent", target: ".hero .container" }]],
  ]);
  const r = buildVacuityReport(tests, steps);
  assert.equal(r.totals.worthChecking, 1);
  assert.equal(r.worthChecking[0].finalAssertionTarget, ".hero .container");
  assert.match(r.notes.join(" "), /SHORTLIST, not a verdict/);
});

test("a test that asserts more than once is not shortlisted", async () => {
  // Intermediate assertions narrow what the final one can mean, so the
  // already-true failure mode does not apply.
  const tests = [T({ _id: "a" })];
  const steps = new Map([
    ["a", [
      { command: "assertElementPresent", target: "#form" },
      { command: "click", target: "#submit" },
      { command: "assertElementPresent", target: "#done" },
    ]],
  ]);
  assert.equal(buildVacuityReport(tests, steps).totals.worthChecking, 0);
});

test("an unreadable definition is skipped, not counted as empty", async () => {
  // Guessing "no steps" would invent a finding out of a network error.
  const tests = [T({ _id: "a" })];
  const r = buildVacuityReport(tests, new Map(), 1);
  assert.equal(r.totals.executesNothing, 0);
  assert.equal(r.scanned.unreadable, 1);
  assert.match(r.notes.join(" "), /not evidence of an empty one/);
});

test("a scoped vacuity report evaluates only the scope", () => {
  const tests = [T({ _id: "a", name: "in" }), T({ _id: "b", name: "out" })];
  const steps = new Map([["a", [{ command: "click", target: "#x" }]], ["b", [{ command: "click", target: "#y" }]]]);
  const scoped = buildVacuityReport(tests, steps, 0, new Set(["a"]));
  assert.deepEqual(scoped.assertsNothing.map((f) => f.id), ["a"]);
  assert.equal(scoped.scanned.tests, 1);
});
