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

import { stopCondition } from "../dist/guard-script.js";

import {
  andConditions,
  applyGuard,
  expandSteps,
  findSubmit,
  injectGuards,
  maskPrivate,
  readGuardedResult,
  outcomesOf,
  planOf,
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

test("an extractEval that posts data is a submit", () => {
  for (const body of [
    "return fetch('/api/lead', { method: 'POST', body: '{}' }).then(() => 'ok');",
    "var x = new XMLHttpRequest(); x.open('POST', '/lead'); x.send(); return 'sent';",
    "navigator.sendBeacon('/lead', 'x'); return 1;",
    "return $.ajax({ url: '/lead', type: 'POST' });",
    "$.post('/lead', {}); return 1;",
    "return axios.post('/lead', {});",
    "document.querySelector('#f').dispatchEvent(new Event('submit')); return 1;",
  ]) {
    assert.ok(findSubmit([S("extractEval", "", body)]), `should catch: ${body}`);
  }
});

test("a condition can submit too", () => {
  // A condition is a script the page evaluates before the step: it can do
  // anything an eval can, and it rides on steps that look harmless.
  const step = { ...S("click", "#next"), condition: "document.forms[0].requestSubmit(); return true;" };
  const hit = findSubmit([S("assign", "#n", "Jane"), step]);
  assert.equal(hit.index, 1);
  assert.match(hit.reason, /condition/);
});

test("stopBefore can only stop earlier", () => {
  const steps = [S("assign", "#a", "x"), S("assign", "#b", "y"), S("click", SUBMIT), S("assertTextPresent", "body", "Thanks")];
  const earlier = applyGuard(steps, { stopBefore: 1 });
  assert.equal(earlier.guard.stoppedAt, 1);
  assert.equal(earlier.steps.filter((s) => s.command === "assign").length, 1);
  const later = applyGuard(steps, { stopBefore: 3 });
  assert.equal(later.guard.stoppedAt, 2, "the static cut still wins");
  assert.ok(later.notes.some((note) => /stopBefore 3 was ignored/.test(note)));
  assert.equal(applyGuard(steps, { stopBefore: 99 }).guard.stoppedAt, 2);
});

test("a Continue button typed submit stops the run — accepted false positive", () => {
  // Pinned on purpose: a multi-step form's "Continue" is often type=submit, and
  // stopping there costs a shorter validation, while guessing wrong posts a lead.
  const hit = findSubmit([S("assign", "#zip", "10001"), S("click", 'form#step-1 button[type="submit"].continue')]);
  assert.equal(hit.index, 1);
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

test("a setting echoed with its keys in another order is not drift", () => {
  const drift = settingsCheck({ viewportSize: { width: 1280, height: 800 } }, { viewportSize: { height: 800, width: 1280 } });
  assert.deepEqual(drift, []);
});

test("an open step shows where it goes and a long script is cut, with its length", async () => {
  const script = `return ${"1 + ".repeat(100)}1;`;
  const { steps } = await expandSteps(
    [{ command: "open", value: "https://example.com/next" }, { command: "extractEval", value: script, variableName: "sum" }],
    async () => ({ name: "", steps: [] }),
  );
  const plan = planOf(steps);
  assert.equal(plan[0].value, "https://example.com/next");
  assert.equal(plan[0].valueLength, undefined, "a short value is shown whole");
  assert.equal(plan[1].value.length, 200);
  assert.equal(plan[1].valueLength, script.length);
  const [, extracted] = outcomesOf(
    [{ command: "open", passing: true, value: "https://example.com/next" }, { command: "extractEval", passing: true, value: script, extracted: "101" }],
    steps,
  );
  assert.equal(extracted.extracted, "101");
  assert.equal(extracted.valueLength, script.length);
});

test("a private variable's value never reaches a validation report", async () => {
  const hidden = "fixture-private-value";
  const run = await prepared({
    startUrl: "https://example.com/{{pin}}",
    steps: [{ command: "assign", target: "#pin-{{pin}}", value: "{{pin}}" }, { command: "click", target: "#{{pin}} .submit" }],
    suite: { variables: [{ name: "pin", value: hidden, private: true }] },
  });
  assert.equal(run.body.steps[0].value, hidden, "the browser still receives it");
  const report = maskPrivate(
    { plan: planOf(run.toRun), startUrl: run.resolution.startUrl, guard: run.guard, steps: outcomesOf([{ command: "assign", target: `#pin-${hidden}`, passing: true }], run.toRun) },
    run.vars,
  );
  assert.ok(!JSON.stringify(report).includes(hidden), "not in the plan, the start URL, the guard or the outcomes");
  assert.equal(report.plan[0].value, "(private)");
});

// --- the in-browser guard, as injected and as read back ---------------------

/** A three-step plan with one click in the middle, expanded as validation would. */
const clickPlan = async () =>
  (await expandSteps(
    [
      { command: "assign", target: "#email", value: "jane@example.com" },
      { command: "click", target: [{ selector: "#go" }, { selector: "[name=go]" }], condition: "return window.ready;" },
      { command: "assertElementPresent", target: "#done" },
    ],
    async () => ({ name: "", steps: [] }),
  )).steps;

/**
 * A result step for a sent step.
 * @param {object} sentStep
 * @param {boolean | null} passing
 */
const ran = (sentStep, passing, error = "") => ({ command: sentStep.command, target: "", passing, error });

test("every original step is gated on the guard", async () => {
  const { sent, map } = injectGuards(await clickPlan());
  assert.deepEqual(sent.map((s) => s.command), ["assign", "assertElementVisible", "extractEval", "click", "assertElementPresent", "extractEval"]);
  assert.deepEqual(map.map((m) => m.kind), ["step", "wait", "probe", "step", "step", "log"]);
  for (const [i, step] of sent.entries()) {
    if (map[i].kind === "log") {
      assert.equal(step.condition, null, "the log always runs");
      continue;
    }
    assert.ok(step.condition.includes(stopCondition()), `sent step ${i} is gated`);
  }
  assert.match(sent[3].condition, /window\.ready/, "the click keeps its own condition");
  assert.match(sent[1].condition, /window\.ready/, "and so does its wait, or it waits for something that will not come");
  assert.deepEqual(sent[1].authoredTarget, [{ selector: "#go" }, { selector: "[name=go]" }]);
  assert.match(sent[2].value, /"#go","\[name=go\]"/, "the probe tries the same fallbacks");
  assert.equal(sent[2].variableName, "giGuardProbe1");
});

test("injected steps never shift what the report calls step N", async () => {
  const { sent, map } = injectGuards(await clickPlan());
  const read = readGuardedResult(sent.map((s) => ran(s, true)), { giGuardProbe1: "clear", giGuardLog: '{"stopped":null,"blocked":[]}' }, sent, map);
  assert.deepEqual(read.outcomes.map((o) => [o.sequence, o.command, o.status]), [
    [0, "assign", "passed"], [1, "click", "passed"], [2, "assertElementPresent", "passed"],
  ]);
  assert.equal(read.runtimeStop, null);
  assert.deepEqual(read.blockedRequests, []);
});

test("a runtime stop is reported with its reason", async () => {
  const { sent, map } = injectGuards(await clickPlan());
  const passing = [true, true, true, null, null, true];
  const read = readGuardedResult(
    sent.map((s, i) => ran(s, passing[i])),
    { giGuardProbe1: "plan step 1: a form's submit button", giGuardLog: '{"stopped":"plan step 1: a form\'s submit button","blocked":["fetch POST https://example.com/lead"]}' },
    sent,
    map,
  );
  assert.equal(read.runtimeStop, "plan step 1: a form's submit button");
  assert.deepEqual(read.outcomes.map((o) => o.status), ["passed", "stopped by guard", "stopped by guard"]);
  assert.deepEqual(read.blockedRequests, ["fetch POST https://example.com/lead"]);
});

test("a click whose target never appeared fails there, not as a missing probe", async () => {
  const { sent, map } = injectGuards(await clickPlan());
  const passing = [true, false, null, null, null, null];
  const read = readGuardedResult(sent.map((s, i) => ran(s, passing[i], i === 1 ? "Element not visible" : "")), {}, sent, map);
  assert.equal(read.outcomes[1].status, "failed");
  assert.match(read.outcomes[1].error, /target never became visible/);
  assert.equal(read.outcomes[2].status, "not reached");
  assert.equal(read.blockedRequests, null, "the log never ran, so nothing is known");
});

test("a step skipped by its own condition is not called unreached", async () => {
  const { sent, map } = injectGuards(await clickPlan());
  const passing = [true, null, null, null, true, true];
  const read = readGuardedResult(sent.map((s, i) => ran(s, passing[i])), { giGuardLog: '{"stopped":null,"blocked":[]}' }, sent, map);
  assert.deepEqual(read.outcomes.map((o) => o.status), ["passed", "skipped by condition", "passed"]);
});

// --- conditions in their stored shape ----------------------------------------

test("a stored condition, an object with a statement, is carried into the expansion", async () => {
  // Every condition in a real account is stored as {statement}. Read as a
  // string it vanished, and validations ran conditional steps unconditionally.
  const { steps } = await expandSteps(
    [
      { command: "click", target: "#a", condition: { statement: "return window.a;" } },
      { command: "execute", value: "mod", condition: { statement: "return outer();" } },
    ],
    async () => ({ name: "Mod", steps: [{ command: "assign", target: "#b", condition: { statement: "return inner();" } }] }),
  );
  assert.equal(steps[0].condition, "return window.a;");
  assert.match(steps[1].condition, /outer\(\)/);
  assert.match(steps[1].condition, /inner\(\)/);
});

test("conditions are sent in the shape Ghost Inspector stores", async () => {
  // Observed live: on-demand refuses a string condition with
  // "Test.steps[0].condition should be object,null".
  const run = await prepared({ steps: [{ command: "assign", target: "#a", value: "x" }, { command: "click", target: "#b", condition: { statement: "return 1;" } }] });
  for (const step of run.body.steps) {
    assert.ok(step.condition === undefined || (typeof step.condition === "object" && typeof step.condition.statement === "string"), JSON.stringify(step.condition));
  }
  assert.ok(run.body.steps.slice(0, -1).every((step) => step.condition), "every sent step but the closing log is gated");
});

test("a stored condition that submits is caught", async () => {
  const { steps } = await expandSteps(
    [{ command: "click", target: "#next", condition: { statement: "document.forms[0].requestSubmit(); return true;" } }],
    async () => ({ name: "", steps: [] }),
  );
  assert.equal(findSubmit(steps).index, 0);
});

test("blocked requests come back without query strings, deduplicated and capped", async () => {
  // Observed live: a real page's analytics produced 17 blocked POSTs whose
  // query strings ran to kilobytes and carried page data into the report.
  const { sent, map } = injectGuards(await clickPlan());
  const blocked = [
    "fetch POST https://example.com/collect?cid=1&email=jane%40example.com",
    "fetch POST https://example.com/collect?cid=2",
    "xhr POST /lead#frag",
    ...Array.from({ length: 30 }, (_, i) => `sendBeacon POST https://example.com/b${i}?x=1`),
  ];
  const read = readGuardedResult(sent.map((s) => ran(s, true)), { giGuardLog: JSON.stringify({ stopped: null, blocked }) }, sent, map);
  assert.equal(read.blockedRequestCount, 33);
  assert.equal(read.blockedRequests.length, 20);
  assert.deepEqual(read.blockedRequests.slice(0, 2), ["fetch POST https://example.com/collect (2 attempts)", "xhr POST /lead"]);
  assert.ok(!JSON.stringify(read.blockedRequests).includes("jane"), "no query string survives");
});

test("a plan with no click still arms the tripwire before its first step", async () => {
  const { steps } = await expandSteps(
    [{ command: "assign", target: "#email", value: "jane@example.com" }, { command: "assign", target: "#agree", value: "true" }],
    async () => ({ name: "", steps: [] }),
  );
  const { sent, map } = injectGuards(steps);
  assert.equal(map.filter((m) => m.kind === "probe").length, 0);
  assert.match(sent[0].condition, /HTMLFormElement\.prototype\.submit/, "the first step's own condition arms it");
});
