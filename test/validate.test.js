/**
 * The submit guard. Missing one posts a real lead to production, so detection
 * is biased toward false positives and every branch is pinned.
 *
 * Verified against a real account: of eight tests whose steps are only
 * `execute` calls, five hid a submit inside a module — which is why the guard
 * runs on the expanded step list and never on the definition as written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyGuard, findSubmit } from "../dist/validate.js";

const S = (command, target = "", value = "", fromModule = null) => ({
  command, target, value, variableName: "", condition: null, optional: false, fromModule,
});
const SUBMIT = 'button[type="submit"]';

test("a click on a submit-shaped target is caught", () => {
  const hit = findSubmit([S("assign", "#name", "Jane"), S("click", SUBMIT)]);
  assert.equal(hit.index, 1);
  assert.match(hit.reason, /submit-shaped target/);
});

test("a submit-ish class name is caught too", () => {
  assert.equal(findSubmit([S("click", "#form .submit-btn")]).index, 0);
});

test("an Enter keypress is caught", () => {
  const hit = findSubmit([S("assign", "#q", "x"), S("keypress", "#q", "Enter")]);
  assert.equal(hit.index, 1);
  assert.match(hit.reason, /submits a focused form/);
});

test("a script that can activate a control is caught", () => {
  for (const body of [
    "return document.forms[0].submit();",
    "document.querySelector('#go').click(); return true;",
    "return form.requestSubmit();",
  ]) {
    assert.ok(findSubmit([S("eval", "", body)]), `should catch: ${body}`);
  }
});

test("an ordinary click is not treated as a submit", () => {
  assert.equal(findSubmit([S("click", "#open-modal"), S("assign", "#n", "x")]), null);
});

test("an innocent assertion is not treated as a submit", () => {
  assert.equal(findSubmit([S("assertEval", "", "return document.title.length > 0;")]), null);
});

test("assign is never a submit, even into a submit-named field", () => {
  assert.equal(findSubmit([S("assign", "#submit-name", "Jane")]), null);
});

test("the first submitting step wins", () => {
  const hit = findSubmit([S("click", SUBMIT), S("keypress", "#q", "Enter")]);
  assert.equal(hit.index, 0);
});

test("a submit inherited from a module is caught like any other", () => {
  // The hole this guard exists to close: guarding the definition as written
  // sees only `execute` steps and lets the run post a real form.
  const hit = findSubmit([
    S("assign", "#n", "Jane", "Packet Mod"),
    S("click", "input[type=submit]", "", "Packet Mod"),
  ]);
  assert.equal(hit.index, 1);
});

test("the run is truncated and the submit target asserted instead", () => {
  const steps = [
    S("open", "https://example.com"),
    S("assign", "#name", "Jane Tester"),
    S("assign", "#email", "jane@example.com"),
    S("click", SUBMIT),
    S("assertTextPresent", "body", "Thank you"),
  ];
  const { steps: run, guard } = applyGuard(steps);

  assert.equal(guard.stoppedAt, 3);
  assert.equal(guard.droppedSteps, 2, "the submit and the destination assertion");
  assert.equal(run.length, 4, "three kept, plus the replacement assertion");
  assert.equal(run[3].command, "assertElementVisible");
  assert.equal(run[3].target, SUBMIT, "still proves the control is reachable");
  assert.equal(guard.assertedTarget, SUBMIT);
  assert.ok(!run.some((s) => s.command === "click"), "no click survives the guard");
});

test("a definition with no submit is left exactly as it was", () => {
  const steps = [S("assign", "#a", "b"), S("assertElementPresent", "body")];
  const { steps: run, guard } = applyGuard(steps);
  assert.equal(guard, null);
  assert.deepEqual(run, steps);
});

test("the replacement assertion keeps the module it came from", () => {
  const { steps: run } = applyGuard([
    S("assign", "#n", "J", "Mod"),
    S("click", "input[type=submit]", "", "Mod"),
  ]);
  assert.equal(run[1].fromModule, "Mod");
});

test("a targetless submit does not invent an assertion", () => {
  const { steps: run, guard } = applyGuard([S("eval", "", "return document.forms[0].submit();")]);
  assert.equal(run.length, 0);
  assert.equal(guard.assertedTarget, null);
  assert.equal(guard.stoppedAt, 0);
});

test("everything after the submit is dropped, not just the submit", () => {
  const steps = [S("click", SUBMIT), S("assertTextPresent", "body", "Thanks"), S("click", "#next")];
  const { guard } = applyGuard(steps);
  assert.equal(guard.droppedSteps, 3);
});
