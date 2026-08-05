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

import { assessStaleness, diffSteps, diffUntouched } from "../dist/writes.js";

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

test("identical steps produce no difference", () => {
  const sent = [{ command: "click", target: "#a" }];
  assert.equal(diffSteps(sent, [stored("click", "#a")]).length, 0);
});

test("Ghost Inspector's own defaults are not reported as differences", () => {
  const sent = [
    { command: "assertElementPresent", target: "body" },
    { command: "assertEval", value: "return true;" },
    { command: "pause", value: "100" },
  ];
  const back = [
    stored("assertElementPresent", "body"),
    stored("assertEval", "", "return true;"),
    stored("pause", "", "100"),
  ];
  assert.equal(diffSteps(sent, back).length, 0, "these three produced phantom diffs before");
});

test("presentation fields are ignored", () => {
  const sent = [{ command: "click", target: "#a", _id: "MINE", sequence: 9 }];
  assert.equal(diffSteps(sent, [stored("click", "#a", "", { _id: "THEIRS", sequence: 0 })]).length, 0);
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
  const sent = [{ command: "click", target }];
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
