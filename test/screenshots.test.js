/** Screenshot comparison: reading its state, and accepting a new baseline only for the result that was looked at. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptRefusal, describeScreenshots } from "../dist/screenshots.js";

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

test("the status shows the current image, the diff and the baseline side by side", () => {
  const status = describeScreenshots(
    { _id: "t", name: "T", screenshotCompareEnabled: null, screenshotComparePassing: false, screenshotCompareThreshold: 0.1 },
    latest,
    { _id: "r1", dateExecutionFinished: "2026-09-01T10:00:00Z", screenshot: { original: { defaultUrl: "https://example.com/base.png" } } },
  );
  assert.equal(status.latestResult.id, "r2");
  assert.equal(status.latestResult.difference, 0.234);
  assert.equal(status.latestResult.screenshotUrl, "https://example.com/now.png");
  assert.equal(status.latestResult.diffUrl, "https://example.com/diff.png");
  assert.equal(status.baseline.screenshotUrl, "https://example.com/base.png");
  assert.ok(status.notes.some((n) => /expectedResultId/.test(n)));
});
