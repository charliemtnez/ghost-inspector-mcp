/**
 * Diagnosing a red test.
 *
 * Every assertion here is a wrong diagnosis this code is meant to prevent. The
 * failures are cheap to produce and expensive to notice: a plausible answer
 * about the wrong step, the wrong selector, or the wrong test entirely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authoredSelectors,
  describeFailingStep,
  horizonVerdict,
  pickFailingStep,
  targetNotes,
} from "../dist/diagnose.js";

test("a purged run is not reported as a test that never ran", async () => {
  // Caught by exercising the real account: asking for run 99999 of a test with
  // 21 retained results answered "never run" about a test that had run 21
  // times. Someone reading that concludes the test is unused.
  assert.equal(horizonVerdict(21, 99999), "past horizon");
  assert.equal(horizonVerdict(1, 1), "past horizon", "off by one is still past the horizon");
  assert.equal(horizonVerdict(0, 0), "never run", "nothing retained is the genuinely unknown case");
  assert.equal(horizonVerdict(1, 0), "available");
  assert.equal(horizonVerdict(10, 9), "available", "the last retained run is reachable");
});

test("a step that never ran is not reported as the failure", async () => {
  // Once a step fails, the rest sit at passing:null. Treating null as false
  // points at the step *after* the break — the most misleading place possible.
  const steps = [
    { sequence: 0, passing: true },
    { sequence: 1, passing: false, error: "boom" },
    { sequence: 2, passing: null },
  ];
  assert.equal(pickFailingStep(steps).sequence, 1);
});

test("a run with nothing failing yields no step rather than a guess", async () => {
  assert.equal(pickFailingStep([{ passing: true }, { passing: null }]), null);
  assert.equal(pickFailingStep([]), null);
});

test("both target shapes flatten, because the API uses each of them", async () => {
  assert.deepEqual(authoredSelectors("#go"), ["#go"]);
  assert.deepEqual(
    authoredSelectors([{ selector: "#go" }, { selector: "[name=go]" }]),
    ["#go", "[name=go]"],
  );
  assert.deepEqual(authoredSelectors(undefined), []);
  assert.deepEqual(authoredSelectors([]), []);
});

test("the resolved selector is not passed off as what the test looks for", async () => {
  // Measured live: 21 of 26 fallback-array steps collapse to a single string in
  // the result. A reader shown only that concludes the test looks for one
  // thing when it was authored to try two.
  const step = describeFailingStep(
    { command: "click", error: "not found", target: "#go", extra: { rootSequence: 3, source: { test: "t1", sequence: 3 } } },
    [{}, {}, {}, { target: [{ selector: "#go" }, { selector: "[name=go]" }] }],
    "Checkout",
    false,
  );
  assert.equal(step.resolvedTarget, "#go");
  assert.deepEqual(step.authoredTargets, ["#go", "[name=go]"]);
  assert.equal(step.targetCollapsed, true);
  assert.match(targetNotes(step).join(" "), /fallback selectors/);
});

test("a single authored selector is not flagged as a collapse", async () => {
  // Otherwise every ordinary step carries a warning, and warnings that fire
  // always are warnings nobody reads.
  const step = describeFailingStep(
    { command: "click", target: "#go", extra: { source: { test: "t1", sequence: 0 } } },
    [{ target: "#go" }],
    "Checkout",
    false,
  );
  assert.equal(step.targetCollapsed, false);
  assert.deepEqual(targetNotes(step), []);
});

test("a normalised selector is called out instead of looking like a missing step", async () => {
  // Verified live: 3 of 21 collapsed targets were a candidate stripped of its
  // "xpath=" prefix, so searching the definition for the reported string finds
  // nothing and the step looks like it does not exist.
  const step = describeFailingStep(
    { command: "click", target: '//button[text()="Go"]', extra: { source: { test: "t1", sequence: 0 } } },
    [{ target: [{ selector: 'xpath=//button[text()="Go"]' }, { selector: "#go" }] }],
    "Checkout",
    false,
  );
  assert.match(targetNotes(step).join(" "), /does not appear verbatim/);
});

test("a failing step from a module points at the module, not the test asked about", async () => {
  // Results expand imports inline. Editing the importer would change nothing,
  // and editing the module changes every test that imports it.
  const step = describeFailingStep(
    { command: "click", error: "x", target: "#go", extra: { rootSequence: 2, source: { test: "mod1", sequence: 4 } } },
    [{}, {}, {}, {}, { target: "#go" }],
    "Shared login",
    true,
  );
  assert.equal(step.ownedBy.testId, "mod1");
  assert.equal(step.ownedBy.sequenceInOwner, 4, "the position inside the module, not the result");
  assert.equal(step.rootSequence, 2, "and the position a human counts in the root test");
  assert.match(targetNotes(step).join(" "), /comes from the module/);
  assert.match(targetNotes(step).join(" "), /gi_module_usage/);
});

test("a step with no source is described rather than dropped", async () => {
  // Absent extra.source must not throw or silently lose the error.
  const step = describeFailingStep({ command: "click", error: "boom" }, null, "", false);
  assert.equal(step.error, "boom");
  assert.equal(step.ownedBy, null);
  assert.deepEqual(step.authoredTargets, []);
});
