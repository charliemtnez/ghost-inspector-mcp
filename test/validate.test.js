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

import {
  andConditions,
  applyGuard,
  expandSteps,
  findSubmit,
  prepareRun,
  settingsCheck,
  settingsFor,
} from "../dist/validate.js";

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

test("a send-shaped target is caught, but not send inside a longer word", () => {
  assert.equal(findSubmit([S("click", "#contact .send-message")]).index, 0);
  assert.equal(findSubmit([S("click", ".btn-send")]).index, 0);
  assert.equal(findSubmit([S("click", "#sendgrid-banner")]), null, "a word boundary is the whole point");
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

// Ghost Inspector ANDs an import step's condition with the conditions of the
// steps it imports, accumulating at every level. An expansion that drops it
// validates steps the real test skips, and reports failures that do not exist.

test("a condition on an import step gates every step it imports", async () => {
  const load = async (id) => ({
    name: id,
    steps:
      id === "mod"
        ? [{ command: "assign", target: "#n", value: "J", condition: "return inner();" }]
        : [],
  });
  const { steps } = await expandSteps(
    [{ command: "execute", value: "mod", condition: "return outer();" }],
    load,
  );
  assert.equal(steps.length, 1);
  assert.match(steps[0].condition, /outer\(\)/, "the import's own condition must survive inlining");
  assert.match(steps[0].condition, /inner\(\)/, "without losing the step's own");
});

test("conditions accumulate through nested imports", async () => {
  const load = async (id) => ({
    name: id,
    steps:
      id === "outerMod"
        ? [{ command: "execute", value: "innerMod", condition: "return b();" }]
        : [{ command: "assign", target: "#x", value: "1" }],
  });
  const { steps } = await expandSteps(
    [{ command: "execute", value: "outerMod", condition: "return a();" }],
    load,
  );
  assert.equal(steps.length, 1);
  assert.match(steps[0].condition, /a\(\)/);
  assert.match(steps[0].condition, /b\(\)/);
});

test("an unconditional chain stays unconditional", async () => {
  const load = async () => ({
    name: "m",
    steps: [{ command: "assign", target: "#x", value: "1" }],
  });
  const { steps } = await expandSteps([{ command: "execute", value: "m" }], load);
  assert.equal(steps[0].condition, null, "no invented condition on a plain chain");
});

test("the combined condition evaluates as the AND of its sides", () => {
  // Conditions are scripts with an explicit return, like eval. Executing the
  // combination the way a page would is the only proof the wrapping is right.
  assert.equal(new Function(andConditions("return 1 === 1;", "return 2 === 3;"))(), false);
  assert.equal(new Function(andConditions("return 1 === 1;", "return 3 === 3;"))(), true);
});

test("an execute step naming no module is counted, never silently dropped", async () => {
  // Dropping it makes the plan look complete when the definition is broken.
  const load = async () => ({ name: "m", steps: [] });
  const { steps, emptyExecutes } = await expandSteps(
    [
      { command: "execute", value: "" },
      { command: "open", target: "", value: "https://example.com" },
    ],
    load,
  );
  assert.equal(emptyExecutes, 1);
  assert.equal(steps.length, 1, "the runnable step still expands");
});

test("andConditions keeps a lone side verbatim", () => {
  // Wrapping a single script would change nothing but readability — the
  // stored condition should stay recognisable to whoever wrote it.
  assert.equal(andConditions(null, "return x;"), "return x;");
  assert.equal(andConditions("return y;", null), "return y;");
  assert.equal(andConditions(null, null), null);
});

test("every inlined step knows which test owns it and where", async () => {
  // Result steps map back by position in the owner's own array, so that
  // position must count the execute steps the expansion replaces.
  const modules = {
    outer: { name: "Outer", steps: [{ command: "assign", target: "#a" }, { command: "execute", value: "inner" }, { command: "click", target: "#c" }] },
    inner: { name: "Inner", steps: [{ command: "assign", target: "#b" }] },
  };
  const { steps } = await expandSteps(
    [{ command: "open", value: "https://example.com" }, { command: "execute", value: "outer" }, { command: "click", target: "#d" }],
    async (id) => modules[id],
    { id: "root", name: "Root" },
  );
  assert.deepEqual(
    steps.map((s) => [s.ownerId, s.ownerName, s.indexInOwner, s.rootIndex]),
    [
      ["root", "Root", 0, 0],
      ["outer", "Outer", 0, 1],
      ["inner", "Inner", 0, 1],
      ["outer", "Outer", 2, 1],
      ["root", "Root", 2, 2],
    ],
  );
});

// --- suite configuration and variables --------------------------------------

/**
 * prepareRun over a definition expanded with no modules.
 * @param {object} over
 */
const prepared = async (over = {}) => {
  const steps = over.steps ?? [{ command: "assertElementVisible", target: "body" }];
  const expansion = await expandSteps(steps, async () => ({ name: "", steps: [] }), { id: "root", name: "Root" });
  return prepareRun({ name: "Root", startUrl: "https://example.com/", test: null, suite: null, org: null, expansion, ...over });
};

test("an unresolved variable refuses before anything is sent", async () => {
  const run = await prepared({ startUrl: "https://{{nope}}.example.com/" });
  assert.equal(run.body, null, "no body means nothing can be POSTed");
  assert.deepEqual(run.unresolved.map((u) => u.name), ["nope"]);
  assert.match(run.refusal, /variables/);
  const fine = await prepared({ startUrl: "https://{{sub}}.example.com/", variables: { sub: "www" } });
  assert.equal(fine.body.startUrl, "https://www.example.com/");
  assert.equal(fine.refusal, null);
});

test("a test's own setting beats its suite's", () => {
  const { values, sources } = settingsFor(
    { viewportSize: { width: 375, height: 667 }, browser: null },
    { viewportSize: { width: 1280, height: 800 }, browser: "chrome", maxWaitDelay: 15000 },
    {},
  );
  assert.deepEqual(values.viewportSize, { width: 375, height: 667 });
  assert.equal(sources.viewportSize, "test");
  assert.equal(values.browser, "chrome");
  assert.equal(sources.browser, "suite");
  assert.equal(values.maxWaitDelay, 15000);
});

test("a caller override beats the test and the suite", () => {
  const { values, sources } = settingsFor(
    { viewportSize: { width: 375, height: 667 } },
    { browser: "chrome" },
    { viewport: "1024x768", browser: "firefox" },
  );
  assert.deepEqual(values.viewportSize, { width: 1024, height: 768 });
  assert.equal(values.browser, "firefox");
  assert.equal(sources.browser, "caller override");
});

test("the suite's user agent reaches the body", async () => {
  const run = await prepared({ suite: { userAgent: "example-bot", httpAuthUsername: "jane", httpAuthPassword: "x" } });
  assert.equal(run.body.userAgent, "example-bot");
  assert.ok(!Object.keys(run.body).some((key) => key.startsWith("httpAuth")), "basic auth is never sent");
  assert.ok(run.notes.some((note) => /basic auth/i.test(note)));
});

test("a setting the run did not honour is reported", () => {
  const drift = settingsCheck(
    { userAgent: "example-bot", browser: "chrome", viewportSize: { width: 1280, height: 800 } },
    { userAgent: "Mozilla/5.0 Ghost Inspector", browser: "chrome-114", viewportSize: { width: 1280, height: 800 } },
  );
  assert.deepEqual(drift.map((d) => d.setting), ["userAgent"], "chrome-114 is chrome");
});
