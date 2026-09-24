/** A test's run history: when it last passed, when the current red began, and how far back the API let us look. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeHistory } from "../dist/history.js";

/**
 * A result, newest first like the API returns them.
 * @param {number} i minutes before now
 * @param {boolean | null} passing
 */
const run = (i, passing) => ({
  _id: `r${i}`,
  passing,
  dateExecutionFinished: new Date(Date.parse("2026-09-24T12:00:00Z") - i * 60_000).toISOString(),
  steps: passing === false ? [{ command: "click", target: "#go", passing: false, error: `Element #go not found after ${i}ms` }] : [],
});

test("a red streak's first failure is found across pages", () => {
  // Two pages of 50 concatenated: the streak crosses the page boundary.
  const results = [run(0, null), ...Array.from({ length: 54 }, (_, i) => run(i + 1, false)), run(55, true), run(56, false)];
  const history = summarizeHistory(results, true);
  assert.equal(history.firstFail.resultId, "r54", "the oldest failure of the current streak");
  assert.equal(history.lastPass.resultId, "r55");
  assert.equal(history.runs[1].failingStep.command, "click");
  assert.ok(history.runs[1].failingStep.error.length <= 160);
  assert.equal(history.runs[0].passing, null, "an in-flight run is neither pass nor fail");
});

test("an unfinished walk never claims to be the whole history", () => {
  const results = Array.from({ length: 50 }, (_, i) => run(i, false));
  const history = summarizeHistory(results, false);
  assert.equal(history.horizon.exhausted, false);
  assert.equal(history.lastPass, null);
  assert.equal(history.streakMayContinue, true, "the streak may start before what was read");
  assert.ok(history.notes.some((n) => /more history; raise runs/.test(n)));
  const all = summarizeHistory(results.slice(0, 10), true);
  assert.ok(all.notes.some((n) => /retention ends here/.test(n)));
});

test("a green latest run has no current streak", () => {
  const history = summarizeHistory([run(0, true), run(1, false)], true);
  assert.equal(history.firstFail, null);
  assert.equal(history.lastPass.resultId, "r0");
});
