/** Screenshot comparison: reading its state, and accepting a new baseline only for the result that was looked at. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptRefusal, acceptedManually, currentBaselineId, describeScreenshots, effectiveSettings } from "../dist/screenshots.js";

const latest = {
  _id: "r2", passing: true, dateExecutionFinished: "2026-09-24T10:00:00Z",
  screenshotCompareEnabled: true, screenshotComparePassing: false, screenshotCompareDifference: 0.234,
  screenshotCompareThreshold: 0.1, screenshotCompareBaselineResult: "r1",
  screenshot: { original: { defaultUrl: "https://example.com/now.png" } },
  screenshotCompare: { compareOriginal: { defaultUrl: "https://example.com/diff.png" } },
};

test("accepting a screenshot you have not looked at is refused", () => {
  assert.match(acceptRefusal(latest, "r0"), /latest result is r2/);
  assert.match(acceptRefusal({ ...latest, passing: null }, "r2"), /still running/);
  assert.match(acceptRefusal(null, "r2"), /no results/);
  assert.equal(acceptRefusal(latest, "r2"), null, "the result that was looked at is the latest, finished");
});

test("there is nothing to accept when the comparison passed or did not run", () => {
  // Ghost Inspector answers VALIDATION_ERROR "Unable to accept screenshot" then.
  assert.match(acceptRefusal({ ...latest, screenshotComparePassing: true, screenshotCompareDifference: 0.02 }, "r2"), /nothing to accept/);
  // Passing above the threshold is what an accept leaves behind: the result is already the baseline.
  assert.match(acceptRefusal({ ...latest, screenshotComparePassing: true }, "r2"), /already accepted/);
  assert.match(acceptRefusal({ ...latest, screenshotCompareEnabled: false }, "r2"), /did not run/);
});

test("the status shows the current image, the diff and the baseline side by side", () => {
  const r1 = { _id: "r1", passing: true, dateExecutionFinished: "2026-09-01T10:00:00Z", screenshotCompareEnabled: true, screenshotComparePassing: true, screenshot: { original: { defaultUrl: "https://example.com/base.png" } } };
  const status = describeScreenshots(
    { _id: "t", name: "T", screenshotCompareEnabled: null, screenshotComparePassing: false, screenshotCompareThreshold: 0.1 },
    { screenshotCompareEnabled: true, screenshotCompareThreshold: 0.1 },
    [latest, r1],
    r1,
    r1,
  );
  assert.equal(status.latestResult.id, "r2");
  assert.equal(status.latestResult.difference, 0.234);
  assert.equal(status.latestResult.screenshotUrl, "https://example.com/now.png");
  assert.equal(status.latestResult.diffUrl, "https://example.com/diff.png");
  assert.equal(status.comparedAgainst.screenshotUrl, "https://example.com/base.png");
  assert.equal(status.currentBaseline.resultId, "r1", "a failing comparison leaves the old baseline in place");
  assert.ok(status.notes.some((n) => /expectedResultId/.test(n)));
});

/**
 * A finished run whose screenshot comparison ran.
 *
 * @param {string} id The result id.
 * @param {boolean} comparePassing Whether the comparison passed.
 * @param {object} extra Fields to override.
 * @return {object} The result.
 */
function run(id, comparePassing, extra = {}) {
  return {
    _id: id, passing: true, screenshotCompareEnabled: true, screenshotComparePassing: comparePassing,
    screenshotCompareDifference: comparePassing ? 0.01 : 0.3, screenshotCompareThreshold: 0.1, ...extra,
  };
}

test("the baseline is the newest compared result that passed, not the image the latest was measured against", () => {
  const results = [run("r3", false, { screenshotCompareBaselineResult: "r1" }), run("r2", false), run("r1", true)];
  assert.deepEqual(currentBaselineId(results), { id: "r1", inWindow: true, functionallyFailed: false });
});

test("right after an accept the latest result is itself the baseline", () => {
  const accepted = run("r2", true, { screenshotCompareDifference: 0.271, screenshotCompareBaselineResult: "r1" });
  assert.equal(currentBaselineId([accepted, run("r1", true)]).id, "r2");
});

test("runs still in flight or without a comparison never become the baseline", () => {
  const results = [run("r4", true, { passing: null }), run("r3", true, { screenshotCompareEnabled: false }), run("r2", true)];
  assert.equal(currentBaselineId(results).id, "r2");
});

test("with no passing comparison in the window, the baseline is what the newest was measured against", () => {
  const results = [run("r3", false, { screenshotCompareBaselineResult: "r0" }), run("r2", false, { screenshotCompareBaselineResult: "r0" })];
  assert.deepEqual(currentBaselineId(results), { id: "r0", inWindow: false, functionallyFailed: false });
  assert.equal(currentBaselineId([]), null);
});

test("a functionally failed run chosen as the baseline is flagged, because that case is unverified", () => {
  const status = describeScreenshots({ _id: "t", name: "T" }, null, [run("r1", true, { passing: false })], null, run("r1", true, { passing: false }));
  assert.equal(currentBaselineId([run("r1", true, { passing: false })]).functionallyFailed, true);
  assert.ok(status.notes.some((n) => /failed functionally/.test(n)));
});

test("an accepted screenshot is recognised only when it passes above its threshold", () => {
  assert.equal(acceptedManually(run("r", true, { screenshotCompareDifference: 0.271 })), true);
  assert.equal(acceptedManually(run("r", true, { screenshotCompareDifference: 0.1 })), false, "at the threshold it simply passed");
  assert.equal(acceptedManually(run("r", false)), false);
  // Missing numbers read as not accepted: claiming an accept that did not happen hides a real failure.
  assert.equal(acceptedManually(run("r", true, { screenshotCompareDifference: null })), false);
});

test("a test storing null inherits enabled and threshold from its suite, and its own threshold is ignored", () => {
  const test = { screenshotCompareEnabled: null, screenshotCompareThreshold: 0.1 };
  assert.deepEqual(effectiveSettings(test, { screenshotCompareEnabled: true, screenshotCompareThreshold: 0.3 }, null), {
    enabled: true, threshold: 0.3, settingsFrom: "suite",
  });
  assert.deepEqual(effectiveSettings(test, { screenshotCompareEnabled: false, screenshotCompareThreshold: 0.3 }, null).enabled, false);
});

test("the threshold a result recorded wins over any configured one", () => {
  const settings = effectiveSettings({ screenshotCompareEnabled: null }, { screenshotCompareEnabled: true, screenshotCompareThreshold: 0.3 }, run("r", false, { screenshotCompareThreshold: 0.2 }));
  assert.equal(settings.threshold, 0.2);
});

test("a test that sets its own comparison uses its own threshold; an unreadable suite leaves it unknown", () => {
  assert.deepEqual(effectiveSettings({ screenshotCompareEnabled: true, screenshotCompareThreshold: 0.05 }, { screenshotCompareEnabled: false, screenshotCompareThreshold: 0.3 }, null), {
    enabled: true, threshold: 0.05, settingsFrom: "test",
  });
  assert.deepEqual(effectiveSettings({ screenshotCompareEnabled: null, screenshotCompareThreshold: 0.1 }, null, null), {
    enabled: null, threshold: null, settingsFrom: "unknown",
  });
});

test("after an accept the status names the new baseline and keeps the old image as comparedAgainst", () => {
  const old = run("r1", true, { screenshot: { original: { defaultUrl: "https://example.com/old.png" } } });
  const accepted = run("r2", true, { screenshotCompareDifference: 0.271, screenshotCompareBaselineResult: "r1" });
  const status = describeScreenshots({ _id: "t", name: "T", screenshotCompareEnabled: null, screenshotCompareThreshold: 0.1 }, { screenshotCompareEnabled: true, screenshotCompareThreshold: 0.1 }, [accepted, old], old, accepted);
  assert.equal(status.latestResult.acceptedManually, true);
  assert.equal(status.comparedAgainst.resultId, "r1");
  assert.equal(status.currentBaseline.resultId, "r2");
  assert.equal(status.currentBaseline.isLatestResult, true);
  assert.ok(status.notes.some((n) => /accepted by hand/.test(n)));
  assert.match(acceptRefusal(accepted, "r2"), /already accepted/);
});

/**
 * The status notes for a test in a suite comparing at 0.3.
 *
 * @param {object} test The test record.
 * @return {string} Every note, joined.
 */
function notes(test) {
  return describeScreenshots(test, { screenshotCompareEnabled: true, screenshotCompareThreshold: 0.3 }, [], null, null).notes.join(" ");
}

test("the stale-threshold note appears only when the test stores a threshold that is not applied", () => {
  assert.match(notes({ screenshotCompareEnabled: null, screenshotCompareThreshold: 0.1 }), /0\.1 stored on the test is not applied/);
  assert.doesNotMatch(notes({ screenshotCompareEnabled: null, screenshotCompareThreshold: null }), /stored on the test/);
  assert.doesNotMatch(notes({ screenshotCompareEnabled: null, screenshotCompareThreshold: 0.3 }), /stored on the test/);
});
