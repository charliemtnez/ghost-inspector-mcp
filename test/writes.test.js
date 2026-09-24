/**
 * The write guards. An overwrite is permanent — no version history, no recycle
 * bin — so guard 1's direction on every uncertain case, and guard 4's freedom
 * from false alarms, are both pinned.
 *
 * The normalisation cases come from a live write: Ghost Inspector fills
 * `condition: null`, `optional: false`, `private: false` and a `sequence` on
 * everything it stores, so a naive diff cried "the write did not land" about a
 * write that had landed perfectly. A verifier that cries wolf is worse than
 * none, because the next real warning gets ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appliedResult,
  assessStaleness,
  buildUpdateBody,
  diffSteps,
  diffUntouched,
  refusedResult,
} from "../dist/writes.js";
import { stripCredentials } from "../dist/redact-record.js";

const iso = (s) => new Date(Date.parse(s)).toISOString();
const RUN = iso("2026-08-01T12:00:00Z");
const BEFORE = iso("2026-07-01T00:00:00Z");
const AFTER = iso("2026-08-03T00:00:00Z");
const EPOCH = iso("1970-01-01T00:00:00Z");

const subject = (over = {}) => ({
  _id: "t", name: "the test", passing: false,
  dateUpdated: BEFORE, dateExecutionFinished: RUN, ...over,
});
const mod = (name, dateUpdated) => ({ _id: name, name, importOnly: true, dateUpdated });

// --- guard 1: staleness ----------------------------------------------------

test("nothing changed since the run means current", () => {
  const v = assessStaleness(subject(), [mod("old mod", BEFORE)], false);
  assert.equal(v.verdict, "current");
  assert.equal(v.changedAfterLastRun.length, 0);
});

test("a module edited after the run makes it stale, and names the culprit", () => {
  const v = assessStaleness(subject(), [mod("edited mod", AFTER)], false);
  assert.equal(v.verdict, "stale");
  assert.equal(v.changedAfterLastRun[0].name, "edited mod");
  assert.equal(v.changedAfterLastRun[0].isSelf, false);
});

test("the test editing itself after its run also makes it stale", () => {
  const v = assessStaleness(subject({ dateUpdated: AFTER }), [mod("m", BEFORE)], false);
  assert.equal(v.verdict, "stale");
  assert.equal(v.changedAfterLastRun[0].isSelf, true);
});

test("a nested module alone is enough", () => {
  // One level deep is not enough: the direct module can be untouched while a
  // module it imports has just been fixed.
  const v = assessStaleness(subject(), [mod("direct", BEFORE), mod("nested", AFTER)], false);
  assert.equal(v.verdict, "stale");
  assert.equal(v.changedAfterLastRun[0].name, "nested");
});

test("an absent or unreadable dateUpdated counts as changed", () => {
  assert.equal(assessStaleness(subject({ dateUpdated: undefined }), [], false).verdict, "stale");
  assert.equal(assessStaleness(subject({ dateUpdated: "nonsense" }), [], false).verdict, "stale");
});

test("a test that never ran is 'never run', never 'stale'", () => {
  const v = assessStaleness(subject({ dateExecutionFinished: EPOCH }), [mod("m", AFTER)], false);
  assert.equal(v.verdict, "never run");
  assert.equal(v.comparable, false);
});

test("every culprit is listed, and the chain size reported", () => {
  const v = assessStaleness(subject(), [mod("a", AFTER), mod("b", AFTER), mod("c", BEFORE)], true);
  assert.equal(v.changedAfterLastRun.length, 2);
  assert.equal(v.chainSize, 3);
  assert.equal(v.chainTruncated, true, "a truncated chain means an incomplete verdict");
});

test("currentlyFailing tracks the test's own state", () => {
  assert.equal(assessStaleness(subject({ passing: false }), [], false).currentlyFailing, true);
  assert.equal(assessStaleness(subject({ passing: true }), [], false).currentlyFailing, false);
});

// --- guard 4a: what was sent must have landed ------------------------------

const stored = (command, target = "", value = "", over = {}) => ({
  command, target, value, variableName: "", condition: null,
  optional: false, private: false, sequence: 0, _id: "x", ...over,
});
/** The steps exactly as the write path sends them, positions included. */
const sentOf = (steps) => buildUpdateBody({ steps }).steps;

test("a saved step list carries its position, or every result maps to step 0", () => {
  // Omitted, GI stores 0 on every step and each failure then maps to step 0;
  // the caller's own value is overwritten too.
  const body = buildUpdateBody({ steps: [{ command: "click", sequence: 7 }, { command: "assign" }, { command: "click" }] });
  assert.deepEqual(body.steps.map((step) => step.sequence), [0, 1, 2]);
});

test("a stored sequence that is not the index is reported as a failed write", () => {
  const sent = sentOf([{ command: "click", target: "#a" }, { command: "click", target: "#b" }]);
  const d = diffSteps(sent, [stored("click", "#a"), stored("click", "#b")]);
  assert.deepEqual(d.map((x) => x.field), ["steps[1].sequence"]);
});

test("identical steps produce no difference", () => {
  const sent = sentOf([{ command: "click", target: "#a" }]);
  assert.equal(diffSteps(sent, [stored("click", "#a")]).length, 0);
});

test("Ghost Inspector's own defaults are not reported as differences", () => {
  const sent = sentOf([
    { command: "assertElementPresent", target: "body" },
    { command: "assertEval", value: "return true;" },
    { command: "pause", value: "100" },
  ]);
  const back = [
    stored("assertElementPresent", "body"),
    stored("assertEval", "", "return true;", { sequence: 1 }),
    stored("pause", "", "100", { sequence: 2 }),
  ];
  assert.equal(diffSteps(sent, back).length, 0, "these three produced phantom diffs before");
});

test("presentation fields are ignored", () => {
  const sent = sentOf([{ command: "click", target: "#a", _id: "MINE" }]);
  assert.equal(diffSteps(sent, [stored("click", "#a", "", { _id: "THEIRS" })]).length, 0);
});

test("a real difference still surfaces", () => {
  const cases = [
    [[{ command: "click", target: "#a" }], [stored("click", "#OTHER")], "steps[0].target"],
    [[{ command: "assign", target: "#a", value: "Jane" }], [stored("assign", "#a", "Other")], "steps[0].value"],
    [[{ command: "click", target: "#a", optional: true }], [stored("click", "#a")], "steps[0].optional"],
    [[{ command: "click", target: "#a", condition: "return true;" }], [stored("click", "#a")], "steps[0].condition"],
    [[{ command: "click", target: "#a" }], [stored("assign", "#a")], "steps[0].command"],
  ];
  for (const [sent, back, field] of cases) {
    assert.ok(diffSteps(sent, back).some((d) => d.field === field), `should report ${field}`);
  }
});

test("a length mismatch is reported", () => {
  const d = diffSteps([{ command: "click", target: "#a" }], [stored("click", "#a"), stored("click", "#b")]);
  assert.ok(d.some((x) => x.field === "steps.length"));
});

test("an array of fallback selectors compares stably", () => {
  const target = [{ selector: "#a" }, { selector: "#b" }];
  const sent = sentOf([{ command: "click", target }]);
  const back = [stored("click", "", "", { target: JSON.stringify(target) })];
  assert.equal(diffSteps(sent, back).length, 0);
});

// --- guard 4b: what was NOT sent must be untouched -------------------------

test("untouched fields produce no findings", () => {
  const before = { _id: "t", name: "n", steps: [], viewportSize: null, autoRetry: true, suite: "s" };
  const after = { ...before, steps: [1], dateUpdated: "moved" };
  assert.equal(diffUntouched(before, after, ["steps"]).length, 0);
});

test("a field that moved without being sent is reported", () => {
  // The documented behaviour is that a partial update preserves everything
  // else. It is undocumented, so it gets verified rather than trusted.
  const before = { _id: "t", name: "n", autoRetry: true, suite: "s1" };
  const after = { _id: "t", name: "n", autoRetry: false, suite: "s2" };
  const d = diffUntouched(before, after, ["name"]);
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.field).sort(), ["autoRetry", "suite"]);
  assert.ok(d.every((x) => x.sent === "(not sent)"));
});

test("the field that was sent is not reported as unexpected", () => {
  const before = { _id: "t", name: "old", autoRetry: true };
  const after = { _id: "t", name: "new", autoRetry: true };
  assert.equal(diffUntouched(before, after, ["name"]).length, 0);
});

test("dateUpdated is ignored, since a write always moves it", () => {
  const before = { _id: "t", dateUpdated: "a", name: "n" };
  const after = { _id: "t", dateUpdated: "b", name: "n" };
  assert.equal(diffUntouched(before, after, []).length, 0);
});

test("a field that exists only after the write is reported", () => {
  // Guard 4 walked the prior definition alone until 0.1.1, so a field the API
  // added during the write was the one unexpected change it could not see —
  // and "nothing else moved" would have been reported without being checked.
  const before = { _id: "t", name: "n" };
  const after = { _id: "t", name: "n", autoRetry: true };
  const d = diffUntouched(before, after, ["name"]);
  assert.deepEqual(d.map((x) => x.field), ["autoRetry"]);
  assert.equal(d[0].stored, true);
});

test("a field that disappeared during the write is reported", () => {
  const before = { _id: "t", name: "n", suite: "s1" };
  const after = { _id: "t", name: "n" };
  assert.deepEqual(diffUntouched(before, after, ["name"]).map((x) => x.field), ["suite"]);
});

// --- what a write hands back ------------------------------------------------

/** A write context over a fresh, current test, as updateTest builds it. */
const context = (before) => ({
  before, staleness: assessStaleness(before, [], false), sentFields: ["steps"], chainLength: 0,
});

test("an applied write hands back the token for the next edit", () => {
  const before = subject({ steps: [] });
  const body = buildUpdateBody({ steps: [{ command: "click", target: "#a" }] });
  const after = { ...before, dateUpdated: AFTER, steps: [stored("click", "#a")] };
  const result = appliedResult(context(before), body, after);
  assert.equal(result.dateUpdated, AFTER);
  assert.ok(result.notes.some((note) => note.includes("expectedDateUpdated")));
});

test("a refused write hands back the token it was refused against", () => {
  const result = refusedResult(context(subject()), "concurrency token mismatch", []);
  assert.equal(result.applied, false);
  assert.equal(result.dateUpdated, BEFORE);
});

test("a stored basic-auth password never reaches a response", () => {
  const planted = "fixture-basic-auth-value";
  const before = subject({
    httpAuthUsername: "jane", httpAuthPassword: planted, steps: [],
    suite: { _id: "s", name: "suite", httpAuthPassword: planted },
  });
  const after = { ...before, dateUpdated: AFTER, httpAuthPassword: `${planted}-rotated` };
  const applied = appliedResult(context(before), buildUpdateBody({ steps: [] }), after);
  const refused = refusedResult(context(before), "concurrency token mismatch", []);
  for (const result of [applied, refused]) {
    const text = JSON.stringify(result);
    assert.ok(!text.includes(planted), "no password, current or rotated, in any response");
    assert.ok(!text.includes("httpAuthUsername"), "the username goes with it");
  }
  const change = applied.verification.unexpectedChanges.find((d) => d.field === "httpAuthPassword");
  assert.ok(change, "a credential that moved is still reported as moved");
});

test("credential-shaped keys are stripped at any depth, everything else kept", () => {
  const clean = stripCredentials({
    name: "n", apiKey: "k", nested: [{ clientSecret: "s", accessToken: "t", target: "#a" }],
  });
  assert.deepEqual(clean, { name: "n", nested: [{ target: "#a" }] });
});
