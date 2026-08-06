/**
 * Reading one test: the shape an edit is composed against.
 *
 * The normalisation is pinned here rather than through the network, so the
 * sentinel decisions stay exercised: this is where "never executed" and "no
 * verdict" are distinguished from a real value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { toDetail } from "../dist/detail.js";

test("the concurrency token survives the trip to the caller", async () => {
  // The whole point of this module: without dateUpdated reaching the caller,
  // the only route to a write is to trigger a refusal and read it off that.
  const detail = toDetail({ _id: "a".repeat(24), dateUpdated: "2026-08-06T10:00:00.000Z" });
  assert.equal(detail.dateUpdated, "2026-08-06T10:00:00.000Z");
});

test("a module is not reported as a failing test", async () => {
  // importOnly deletes stored results, so passing is never a boolean and the
  // last-run date sits at the 1970 sentinel. Reading either as a verdict is the
  // most destructive wrong answer this server can give.
  const detail = toDetail({
    _id: "b".repeat(24),
    importOnly: true,
    passing: null,
    dateExecutionFinished: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(detail.importOnly, true);
  assert.equal(detail.passing, null, "no verdict, not a failure");
  assert.equal(detail.lastRun, null, "the epoch sentinel is not a run");
});

test("an in-flight run is not mistaken for a pass or a fail", async () => {
  const detail = toDetail({ _id: "c".repeat(24), passing: undefined });
  assert.equal(detail.passing, null);
});

test("a suite arrives usable whether the API expands it or not", async () => {
  const expanded = toDetail({ _id: "d".repeat(24), suite: { _id: "s".repeat(24), name: "Checkout" } });
  assert.deepEqual(expanded.suite, { id: "s".repeat(24), name: "Checkout" });

  const bare = toDetail({ _id: "e".repeat(24), suite: "s".repeat(24) });
  assert.equal(bare.suite.id, "s".repeat(24), "a bare id must still yield an id");

  const none = toDetail({ _id: "f".repeat(24) });
  assert.equal(none.suite, null);
});

test("a test with no steps reads as empty, not as broken", async () => {
  // GET /tests/ omits steps entirely; a caller must not see undefined here.
  const detail = toDetail({ _id: "0".repeat(24) });
  assert.deepEqual(detail.steps, []);
  assert.equal(detail.stepCount, 0);
});

test("steps are returned unexpanded, so an edit targets the right test", async () => {
  // A run result expands imported modules inline; the definition does not.
  // Handing back an expanded shape here would invite editing the importer with
  // steps that live in the module.
  const detail = toDetail({
    _id: "1".repeat(24),
    steps: [{ command: "execute", value: "2".repeat(24) }, { command: "click", target: "#go" }],
  });
  assert.equal(detail.stepCount, 2);
  assert.equal(detail.steps[0].command, "execute");
  assert.equal(detail.steps[0].value, "2".repeat(24), "the module id is the edge of the graph");
});
