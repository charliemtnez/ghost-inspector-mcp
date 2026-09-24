/** A test's run history: when it last passed, when the current red began, and how far back the API let us look. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { groupFailures, summarizeHistory } from "../dist/history.js";

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

test("failures that began together are grouped, however far apart their suites are", () => {
  /** One red test's onset. */
  const onset = (id, suite, at, error, target) => ({ id, name: id, suite, onset: at, error, target });
  const groups = groupFailures([
    onset("c", "Z", "2026-09-14T21:15:00Z", 'Element "#go" not found after 3000ms', "#go"),
    onset("a", "X", "2026-09-14T12:35:00Z", 'Element "#submit" not found after 1500ms', "#go"),
    onset("d", "X", "2026-09-17T09:00:00Z", "Timeout", "#other"),
    onset("b", "Y", "2026-09-14T14:00:00Z", "JavaScript evaluated to false", "#go"),
  ], 12);
  assert.deepEqual(groups.map((g) => g.tests.map((t) => t.id)), [["a", "b", "c"], ["d"]]);
  assert.equal(groups[0].start, "2026-09-14T12:35:00Z");
  assert.equal(groups[0].end, "2026-09-14T21:15:00Z");
  assert.deepEqual(groups[0].commonErrors[0], { text: "Element … not found after Nms", count: 2 }, "numbers and quoted text normalised");
  assert.deepEqual(groups[0].commonTargets[0], { text: "#go", count: 3 });
});
