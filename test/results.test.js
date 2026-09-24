/** What a finished result says about itself: how much ran, how long it took, and the evidence it left. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evidenceOf, executionTimeMs, isSettled, stepsExecuted } from "../dist/results.js";

test("a skipped or unreached step is not counted as executed", () => {
  // A step whose condition was false, and every step after a failure, sits at
  // passing:null. Counting them reports a run that did more than it did.
  const steps = [{ passing: true }, { passing: null }, { passing: false }, { passing: null }, {}];
  assert.equal(stepsExecuted(steps), 2);
});

test("a missing executionTime is rebuilt from the timestamps, never reported as zero", () => {
  assert.equal(executionTimeMs({ executionTime: 25880 }), 25880);
  assert.equal(
    executionTimeMs({ dateExecutionStarted: "2026-09-24T10:00:00.000Z", dateExecutionFinished: "2026-09-24T10:00:31.500Z" }),
    31500,
  );
  assert.equal(executionTimeMs({ dateExecutionStarted: "2026-09-24T10:00:00.000Z" }), null, "unfinished is unknown");
  assert.equal(
    executionTimeMs({ dateExecutionStarted: "2026-09-24T10:01:00.000Z", dateExecutionFinished: "2026-09-24T10:00:00.000Z" }),
    null,
    "a negative span is unknown, not a duration",
  );
  assert.equal(executionTimeMs({}), null);
});

test("console output is capped, not dropped silently", () => {
  const console = Array.from({ length: 30 }, (_, i) => ({
    url: "https://example.com/", output: `boom ${i} ${"x".repeat(400)}`, error: true, dateExecuted: "2026-09-24T10:00:00.000Z",
  }));
  console.push({ url: "https://example.com/", output: "info line", error: false });
  const compact = evidenceOf({ console }, false);
  assert.equal(compact.console.total, 31);
  assert.equal(compact.console.errors, 30);
  assert.equal(compact.console.entries.length, 20, "errors only, at most 20");
  assert.ok(compact.console.entries.every((entry) => entry.error));
  assert.ok(compact.console.entries[0].output.length <= 300);
  assert.equal(evidenceOf({ console }, true).console.entries.length, 31, "verbose shows everything");
});

test("the evidence a result carries comes back by name", () => {
  const evidence = evidenceOf({
    screenshot: { original: { defaultUrl: "https://example.com/full.png" }, small: { defaultUrl: "https://example.com/small.png" } },
    video: { url: "https://example.com/run.mp4" },
    urls: ["https://example.com/", "https://example.com/thanks"],
    extractions: { formSelector: "#lead" },
  }, false);
  assert.equal(evidence.screenshotUrl, "https://example.com/full.png");
  assert.equal(evidence.screenshotSmallUrl, "https://example.com/small.png");
  assert.equal(evidence.videoUrl, "https://example.com/run.mp4");
  assert.deepEqual(evidence.urls, ["https://example.com/", "https://example.com/thanks"]);
  assert.deepEqual(evidence.extractions, { formSelector: "#lead" });
  assert.deepEqual(evidenceOf({}, false).urls, [], "absent evidence is empty, never a crash");
});

test("a verdict without its timing is not yet the finished record", () => {
  // Observed live: a polled on-demand result had passing set while executionTime
  // and dateExecutionFinished were still empty; a moment later both were filled.
  assert.equal(isSettled({ passing: true }), false);
  assert.equal(isSettled({ passing: true, executionTime: 59165 }), true);
  assert.equal(isSettled({ passing: false, dateExecutionStarted: "2026-09-24T10:00:00Z", dateExecutionFinished: "2026-09-24T10:01:00Z" }), true);
  assert.equal(isSettled({ passing: null, executionTime: 1 }), false, "no verdict is never settled");
});
